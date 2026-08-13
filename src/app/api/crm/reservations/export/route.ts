/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';

/**
 * Reservation CRM — CSV EXPORT (/crm-calls/database → Download).
 *
 * GET /api/crm/reservations/export?type=customers   [&q=&sort=&dir=&limit=]
 * GET /api/crm/reservations/export?type=bookings    [&q=&status=&from=&to=&guest_id=&import_id=&duplicates=&sort=&dir=&limit=]
 *   → 200 text/csv, streamed.
 *
 * ── ADMIN ONLY (owner's decision) ─────────────────────────────────────────
 * requireRole('admin') — 401 signed-out, 403 'Admin role required' to a
 * manager or an HOD. Every route in this family is admin-only, matching the
 * adminOnly catalog entry on /crm-calls/database. One unfiltered click here is 70,297 guests' names,
 * phone numbers, email addresses and lifetime spend in a single portable
 * file — the same asset the three import routes can rewrite, which is why
 * they carry the identical gate. A management-level reader can still page
 * through the data on screen; they cannot take it home.
 *
 * The filters are the SAME ones the two list endpoints accept, and they are
 * parsed the same way on purpose: a CSV that quietly contains a different set
 * of rows than the table the user was looking at when they pressed Download is
 * worse than no CSV at all. The parsing is duplicated here rather than shared
 * because a route.ts may not export helpers of its own (Next rejects the extra
 * export at build time) — if a third caller ever needs them, lift the filter
 * builders into a `_lib/` module and have all three import it. CHANGE ONE,
 * CHANGE THE OTHERS: ../customers/route.ts and ../bookings/route.ts.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * HOW THIS STREAMS, AND WHY IT IS BUILT THIS WAY
 * ══════════════════════════════════════════════════════════════════════════
 * Production is ~106,000 bookings (~30MB of CSV). Three designs were measured
 * on this machine with better-sqlite3 before settling on the third:
 *
 * 1. Read every row, join it into one string, return it.
 *    Rejected: a 30MB string plus the garbage of building it, held whole in
 *    memory while the browser downloads it.
 *
 * 2. Stream straight out of stmt.iterate().
 *    Rejected, and this is the important one: while a better-sqlite3 iterator
 *    is open the connection refuses every WRITE — measured, verbatim, "This
 *    database connection is busy executing a query". getDb() hands the whole
 *    app ONE connection, so a manager on hotel wifi taking two minutes to pull
 *    30MB would block every KOT, bill and stock write for those two minutes.
 *    An export must never be able to stop the kitchen printing.
 *
 * 3. What this does: ONE id-only pass in the requested order (measured 90ms for
 *    106,000 ids, ~5MB of strings), then hydrate the rows in CHUNK-sized
 *    primary-key lookups inside the stream's pull(). Measured: 53 chunk queries,
 *    136ms in total, slowest single query 4ms. The connection is therefore held
 *    for at most a few milliseconds at a time and is free between chunks, no
 *    matter how slowly the client reads. Memory stays bounded at one chunk of
 *    rows plus the id list.
 *
 * Chunked LIMIT/OFFSET was the obvious alternative to the id pass and is 17×
 * more expensive (2,373ms vs 136ms at 2,000-row chunks) because SQLite re-runs
 * the whole ORDER BY for every chunk and then throws away the rows it skipped.
 * It is also unstable: rows inserted by a concurrent import shift the window,
 * so the same booking can appear twice or not at all. The id pass fixes the
 * membership of the export at the moment the button was pressed.
 * ══════════════════════════════════════════════════════════════════════════
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * 2,000 rows per hydrate. Measured at 4ms per query — short enough that no
 * other request waits on it — and comfortably under SQLite's host-parameter
 * ceiling for the IN (…) list.
 */
const CHUNK = 2000;

/* ── filters: the twins of ../customers/route.ts and ../bookings/route.ts ─── */

const CUSTOMER_SORTABLE = [
  'name', 'phone10', 'total_bookings', 'arrived_visits', 'cancelled_bookings',
  'no_shows', 'arrival_rate', 'total_pax', 'total_spend', 'avg_spend',
  'first_booking', 'last_booking', 'visit_frequency_days', 'metrics_updated_at',
  'created_at', 'updated_at',
] as const;

const BOOKING_SORTABLE: Record<string, (dir: string) => string> = {
  booking_date: (d) => `b.booking_date ${d}, b.slot_time ${d}`,
  booking_time: (d) => `b.booking_time ${d}`,
  reserved_time: (d) => `b.reserved_time ${d}`,
  party_size: (d) => `b.party_size ${d}`,
  bill_amount: (d) => `b.bill_amount ${d}`,
  status: (d) => `b.status ${d}`,
  arrived: (d) => `b.arrived ${d}`,
  guest_name: (d) => `g.name ${d}`,
  created_at: (d) => `b.created_at ${d}`,
};
/**
 * hasOwnProperty, not a truthiness test: `?sort=constructor` and
 * `?sort=__proto__` both find something on Object.prototype and would sail past
 * the allowlist. Twin of isSortable() in ../bookings/route.ts.
 */
const isBookingSortable = (k: string): boolean => Object.prototype.hasOwnProperty.call(BOOKING_SORTABLE, k);

const STATUSES = ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (d: string): boolean => {
  const dt = new Date(`${d}T00:00:00Z`);
  return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
};
const likeContains = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** `sort=-last_booking` ≡ sort=last_booking&dir=desc, as the list routes accept. */
function readSort(sp: URLSearchParams): { sortRaw: string; dirRaw: string } {
  let sortRaw = (sp.get('sort') || '').trim();
  let dirRaw = (sp.get('dir') || '').trim().toLowerCase();
  if (sortRaw.startsWith('-')) { sortRaw = sortRaw.slice(1); if (!dirRaw) dirRaw = 'desc'; }
  return { sortRaw, dirRaw };
}

/* ── CSV shaping ──────────────────────────────────────────────────────────── */

/**
 * RFC-4180 escaping (guest names, comments and preferences all carry commas)
 * PLUS the spreadsheet formula-injection guard, CWE-1236.
 *
 * A cell beginning with = + - @ TAB or CR is EXECUTED by Excel and Sheets when
 * the file is opened, so a guest saved as `=HYPERLINK(...)` — or, far more
 * ordinarily, a phone written `+919392966858`, which Excel reads as `=91…` —
 * stops being data. Prefixing a single quote makes it text. Matched verbatim
 * from the sibling this export sits beside, ../../../crm-calls/guests/route.ts
 * (its twin is ../../../crm-calls/winback/route.ts); the `numeric` escape hatch
 * is the one from ../../../reports/menu-recipe-gap/route.ts, and it matters
 * here because bill_amount may legitimately be negative and `'-250` would land
 * in the sheet as text that will not sum.
 */
const csvCell = (v: unknown, numeric = false): string => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * ct_guests.tags and ct_guests.booking_sources are JSON arrays as TEXT. A
 * spreadsheet cell wants "Zomato; Walk-in", not ["Zomato","Walk-in"]; anything
 * that is not a JSON array is passed through as written rather than blanked.
 */
function jsonList(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  try {
    const p = JSON.parse(s);
    if (Array.isArray(p)) return p.join('; ');
  } catch { /* not JSON — fall through */ }
  return s;
}

/** One of the ten pax counts out of the pax_breakdown JSON blob. */
function paxOf(row: any, key: string): number | '' {
  if (!row.__pax) {
    try { row.__pax = JSON.parse(String(row.pax_breakdown ?? '') || '{}'); } catch { row.__pax = {}; }
  }
  const n = row.__pax?.[key];
  return typeof n === 'number' ? n : '';
}

/**
 * `numeric: true` opts a column OUT of the formula guard — see csvCell(). Set
 * it ONLY where the value is a number the reader will sum or sort; a negative
 * figure in a guarded column arrives as text. Everything free-text stays
 * guarded, phone numbers included (a leading + is a formula to Excel).
 */
interface Column { header: string; cell: (r: any) => unknown; numeric?: boolean }

const CUSTOMER_COLUMNS: Column[] = [
  { header: 'Guest Name', cell: (r) => r.name },
  { header: 'Phone', cell: (r) => r.phone_e164 },
  { header: 'Phone (10)', cell: (r) => r.phone10 },
  { header: 'Email', cell: (r) => r.email },
  { header: 'Total Bookings', cell: (r) => r.total_bookings, numeric: true },
  { header: 'Arrived Visits', cell: (r) => r.arrived_visits, numeric: true },
  { header: 'Cancelled', cell: (r) => r.cancelled_bookings, numeric: true },
  { header: 'No Shows', cell: (r) => r.no_shows, numeric: true },
  // Stored 0..1 by computeGuestMetrics(); written as a percentage because that
  // is what the header says and what a spreadsheet reader expects to see.
  { header: 'Arrival Rate %', cell: (r) => (r.arrival_rate == null ? '' : Math.round(Number(r.arrival_rate) * 1000) / 10), numeric: true },
  { header: 'Total Pax', cell: (r) => r.total_pax, numeric: true },
  { header: 'Total Spend', cell: (r) => r.total_spend, numeric: true },
  { header: 'Avg Spend per Visit', cell: (r) => r.avg_spend, numeric: true },
  { header: 'First Booking', cell: (r) => r.first_booking },
  { header: 'Last Booking', cell: (r) => r.last_booking },
  { header: 'Visit Frequency (days)', cell: (r) => r.visit_frequency_days, numeric: true },
  { header: 'Booking Sources', cell: (r) => jsonList(r.booking_sources) },
  { header: 'Tags', cell: (r) => jsonList(r.tags) },
  { header: 'Source', cell: (r) => r.source },
  { header: 'DOB', cell: (r) => r.dob },
  { header: 'Anniversary', cell: (r) => r.anniversary },
  { header: 'Notes', cell: (r) => r.notes },
  { header: 'Metrics Updated', cell: (r) => r.metrics_updated_at },
  { header: 'Guest ID', cell: (r) => r.id },
];

const BOOKING_COLUMNS: Column[] = [
  { header: 'Booking Date', cell: (r) => r.booking_date },
  { header: 'Slot', cell: (r) => r.slot_time },
  { header: 'Guest Name', cell: (r) => r.guest_name },
  { header: 'Guest Phone', cell: (r) => r.guest_phone },
  { header: 'Guest Email', cell: (r) => r.guest_email },
  { header: 'Outlet', cell: (r) => r.outlet_name },
  { header: 'Booking Time', cell: (r) => r.booking_time },
  { header: 'Reserved Time', cell: (r) => r.reserved_time },
  { header: 'Seated At', cell: (r) => r.seated_at },
  { header: 'Arrived', cell: (r) => (r.arrived ? 'Yes' : 'No') },
  // The same-day duplicate flag ships with the row rather than the row being
  // dropped. markDuplicateGroups() decides which of a guest's several rows on
  // one evening IS the visit; the losers are excluded from every count in the
  // CRM, so a spreadsheet that carried them unmarked would total differently
  // from the Customers list. Labelled, the reader can filter on it — and the
  // rows the venue can still see in Reservego are still in the file.
  { header: 'Same-Day Duplicate', cell: (r) => (Number(r.is_duplicate ?? 0) === 1 ? 'Yes' : 'No') },
  { header: 'Status', cell: (r) => r.status },
  // Both statuses ship: ours is what every query filters on, the Reservego one
  // is the source text, and an unrecognised status is stored raw rather than
  // guessed at — so this column is the only place it can be seen.
  { header: 'Reservego Status', cell: (r) => r.reservego_status },
  { header: 'Booking Type', cell: (r) => r.booking_type },
  { header: 'Pax', cell: (r) => r.party_size, numeric: true },
  { header: 'Adult Pax', cell: (r) => paxOf(r, 'adult'), numeric: true },
  { header: 'Child Pax', cell: (r) => paxOf(r, 'child'), numeric: true },
  { header: 'Veg Pax', cell: (r) => paxOf(r, 'veg'), numeric: true },
  { header: 'Non-Veg Pax', cell: (r) => paxOf(r, 'non_veg'), numeric: true },
  { header: 'Male Pax', cell: (r) => paxOf(r, 'male'), numeric: true },
  { header: 'Female Pax', cell: (r) => paxOf(r, 'female'), numeric: true },
  { header: 'Infant Pax', cell: (r) => paxOf(r, 'infant'), numeric: true },
  { header: 'Couple Pax', cell: (r) => paxOf(r, 'couple'), numeric: true },
  { header: 'Male Stags Pax', cell: (r) => paxOf(r, 'male_stag'), numeric: true },
  { header: 'Female Stags Pax', cell: (r) => paxOf(r, 'female_stag'), numeric: true },
  { header: 'Reserved By', cell: (r) => r.reserved_by },
  { header: 'Section(s)', cell: (r) => r.sections },
  { header: 'Table(s)', cell: (r) => r.tables_csv },
  { header: 'Source', cell: (r) => r.source },
  { header: 'Channel', cell: (r) => r.channel },
  { header: 'Preferences', cell: (r) => r.preferences },
  { header: 'Tags', cell: (r) => jsonList(r.tags) },
  { header: 'Guest Comments', cell: (r) => r.guest_comments },
  { header: 'Outlet Comments', cell: (r) => r.outlet_comments },
  { header: 'Deletion Type', cell: (r) => r.deletion_type },
  { header: 'Deleted Reason', cell: (r) => r.deletion_reason },
  // numeric: a refunded/adjusted bill is legitimately negative, and `'-250`
  // would arrive in the sheet as text that will not sum.
  { header: 'Bill Amount', cell: (r) => r.bill_amount, numeric: true },
  { header: 'Bill Number', cell: (r) => r.bill_number },
  { header: 'Booking Amount', cell: (r) => r.booking_amount, numeric: true },
  { header: 'Booking Amount Tranx ID', cell: (r) => r.booking_txn_id },
  { header: 'Booking Amount Payment Status', cell: (r) => r.booking_payment_status },
  { header: 'Booking Amount Payment Date', cell: (r) => r.booking_payment_date },
  { header: 'Occasion', cell: (r) => r.occasion },
  { header: 'Notes', cell: (r) => r.notes },
  { header: 'Import ID', cell: (r) => r.import_id },
  { header: 'Guest ID', cell: (r) => r.guest_id },
  { header: 'Booking ID', cell: (r) => r.id },
];

/* ── the route ────────────────────────────────────────────────────────────── */

export async function GET(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const sp = new URL(request.url).searchParams;
  const type = (sp.get('type') || '').trim();
  if (type !== 'customers' && type !== 'bookings') {
    return Response.json({ error: 'type must be customers or bookings' }, { status: 400 });
  }

  try {
    const db = getDb();
    const { sortRaw, dirRaw } = readSort(sp);
    const q = (sp.get('q') || '').trim();

    let idSql = '';
    let hydrateSql = '';
    let columns: Column[];
    const params: any[] = [];

    if (type === 'customers') {
      const where: string[] = [];
      if (q) {
        const like = likeContains(q);
        where.push(`(name LIKE ? ESCAPE '\\' OR phone_e164 LIKE ? ESCAPE '\\' OR phone10 LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')`);
        params.push(like, like, like, like);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const sort = (CUSTOMER_SORTABLE as readonly string[]).includes(sortRaw) ? sortRaw : 'last_booking';
      const dir = dirRaw === 'asc' ? 'ASC' : dirRaw === 'desc' ? 'DESC' : (sort === 'name' || sort === 'phone10' ? 'ASC' : 'DESC');
      idSql = `SELECT id FROM ct_guests ${whereSql} ORDER BY ${sort} ${dir}, id ASC`;
      hydrateSql = `SELECT * FROM ct_guests WHERE id IN (@ids)`;
      columns = CUSTOMER_COLUMNS;
    } else {
      const where: string[] = [];
      const status = (sp.get('status') || '').trim();
      if (status) {
        if (!(STATUSES as readonly string[]).includes(status)) {
          return Response.json({ error: `status must be one of ${STATUSES.join(', ')}` }, { status: 400 });
        }
        where.push('b.status = ?');
        params.push(status);
      }
      const from = (sp.get('from') || '').trim();
      if (from) {
        if (!DATE_RE.test(from) || !isRealDate(from)) {
          return Response.json({ error: 'from must be a real YYYY-MM-DD date' }, { status: 400 });
        }
        where.push('b.booking_date >= ?');
        params.push(from);
      }
      const to = (sp.get('to') || '').trim();
      if (to) {
        if (!DATE_RE.test(to) || !isRealDate(to)) {
          return Response.json({ error: 'to must be a real YYYY-MM-DD date' }, { status: 400 });
        }
        where.push('b.booking_date <= ?');
        params.push(to);
      }
      const guestId = (sp.get('guest_id') || '').trim();
      if (guestId) { where.push('b.guest_id = ?'); params.push(guestId); }
      const importId = (sp.get('import_id') || '').trim();
      if (importId) { where.push('b.import_id = ?'); params.push(importId); }
      // The twin of ../bookings/route.ts — same parameter, same three values, so
      // the file contains the rows the screen was showing. The default is
      // `include`, and the CSV carries an "Is Duplicate" column: a spreadsheet
      // that silently dropped 3,576 rows the owner can see in Reservego would
      // be read as data loss, and one that silently counted them would be the
      // 85,558-vs-81,982 disagreement all over again in Excel.
      const dupMode = (sp.get('duplicates') || 'include').trim();
      if (!['include', 'exclude', 'only'].includes(dupMode)) {
        return Response.json({ error: 'duplicates must be include, exclude or only' }, { status: 400 });
      }
      if (dupMode === 'exclude') where.push('COALESCE(b.is_duplicate, 0) = 0');
      if (dupMode === 'only') where.push('COALESCE(b.is_duplicate, 0) = 1');
      if (q) {
        const like = likeContains(q);
        where.push(`(g.name LIKE ? ESCAPE '\\' OR g.phone_e164 LIKE ? ESCAPE '\\' OR g.phone10 LIKE ? ESCAPE '\\' OR g.email LIKE ? ESCAPE '\\' OR b.bill_number LIKE ? ESCAPE '\\')`);
        params.push(like, like, like, like, like);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const sort = isBookingSortable(sortRaw) ? sortRaw : 'booking_date';
      const dir = dirRaw === 'asc' ? 'ASC' : dirRaw === 'desc' ? 'DESC' : (sort === 'guest_name' ? 'ASC' : 'DESC');
      idSql = `
        SELECT b.id FROM ct_bookings b
        LEFT JOIN ct_guests g ON g.id = b.guest_id
        ${whereSql}
        ORDER BY ${BOOKING_SORTABLE[sort](dir)}, b.id ASC
      `;
      hydrateSql = `
        SELECT b.*,
               g.name       AS guest_name,
               g.phone_e164 AS guest_phone,
               g.phone10    AS guest_phone10,
               g.email      AS guest_email
        FROM ct_bookings b
        LEFT JOIN ct_guests g ON g.id = b.guest_id
        WHERE b.id IN (@ids)
      `;
      columns = BOOKING_COLUMNS;
    }

    let ids = (db.prepare(idSql).all(...params) as any[]).map((r) => String(r.id));
    // An optional cap for a "first 500 rows" preview. Absent — the normal case —
    // the export is the whole filtered set; that is what it is for.
    const cap = parseInt(sp.get('limit') || '', 10);
    if (Number.isFinite(cap) && cap > 0 && cap < ids.length) ids = ids.slice(0, cap);

    const enc = new TextEncoder();
    // The BOM makes Excel read the file as UTF-8; without it, a guest called
    // "Priyā" opens as mojibake and the owner concludes the export is broken.
    let pending = '\uFEFF' + columns.map((c) => csvCell(c.header)).join(',') + '\r\n';

    /**
     * ── THE ID LIST IS SPENT AS IT GOES, AND DROPPED ON CANCEL ────────────
     * The id pass above is what makes this export cheap and stable (see the
     * header note), but it is also ~7MB of strings at 82,088 bookings, and a
     * ReadableStream lives for as long as the client keeps reading — minutes,
     * on hotel wifi. Two consequences, neither optional at this size:
     *
     *   · splice, not a cursor. Each chunk is REMOVED from the front of the
     *     list, so the retained ids shrink as the download proceeds instead of
     *     the whole 7MB sitting there until the last byte is flushed. (82,088
     *     ids in 41 splices is a few million element moves — noise beside a
     *     30MB download.)
     *
     *   · cancel(). A tab closed mid-download, a manager giving up, a proxy
     *     timing out: without this handler nothing tells the route to stop, so
     *     the ids stay pinned until the runtime happens to collect the stream,
     *     and pull() keeps hydrating chunks nobody will read.
     *
     * Nothing here holds a SQLite iterator open — see design note 2 in the
     * header; that is the one thing this route must never do.
     */
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        try {
          if (cancelled) return;
          if (pending) { controller.enqueue(enc.encode(pending)); pending = ''; return; }
          if (!ids.length) { controller.close(); return; }

          const slice = ids.splice(0, CHUNK);

          // Hydrated by primary key, so this is an index lookup per row rather
          // than a re-sort of the table — 4ms for 2,000 rows, measured.
          const stmt = db.prepare(hydrateSql.replace('@ids', slice.map(() => '?').join(',')));
          const rows = stmt.all(...slice) as any[];
          // IN (…) returns rows in SQLite's order, not the id list's, so the
          // chunk is put back into the requested sort order before it is written.
          const byId = new Map<string, any>(rows.map((r) => [String(r.id), r]));

          let out = '';
          for (const id of slice) {
            const r = byId.get(id);
            if (!r) continue;   // deleted between the id pass and now
            out += columns.map((c) => csvCell(c.cell(r), c.numeric)).join(',') + '\r\n';
          }
          controller.enqueue(enc.encode(out));
        } catch (e) {
          // The headers are long gone by now, so a failure mid-file can only
          // truncate the download. Logged loudly for that reason.
          console.error('[GET /api/crm/reservations/export] stream failed:', e);
          ids = [];
          controller.error(e);
        }
      },
      cancel() {
        cancelled = true;
        ids = [];
        pending = '';
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="reservations-${type}_${todayIST()}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    console.error('[GET /api/crm/reservations/export]', e);
    return Response.json({ error: e?.message || 'Failed to export' }, { status: 500 });
  }
}
