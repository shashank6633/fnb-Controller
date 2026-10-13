'use client';

/**
 * STOCK MOVEMENTS — the movement register (owner's requirement, 2026-09-10).
 *
 * One list of every stock movement in the building, filterable by STORE,
 * DEPARTMENT, TYPE and DATE, showing the owner's eight fields on every row:
 *
 *   1 item · 2 quantity · 3 unit of measure · 4 source location ·
 *   5 destination location · 6 movement type · 7 transaction date ·
 *   8 responsible user
 *
 * Source: GET /api/inventory/movements, which unions the three rails
 * (store_stock_ledger / department_material_transactions /
 * inventory_transactions). The gate is server-side (admin / manager /
 * store-manager / HOD) and a 403 renders the 🔒 notice here — this page's own
 * conditionals are UX, never the boundary. Money is management-only and arrives
 * as null for everyone else, so there is nothing here to hide client-side.
 *
 * WHY THIS PAGE EXISTS RATHER THAN AN EXTENSION: the only movement list before
 * it was the Liquor Store page's ledger tab, which reads ONE table and is
 * scoped to ONE store by its route — it cannot show a department issue or a
 * central purchase, and "filter by department" is not expressible in it at all.
 * That tab was extended where extension was possible (it now shows source,
 * destination, unit and actor in place); the cross-rail register is here, and
 * there is exactly one of it. Do not add a second.
 *
 * UNITS (owner rule, [[project_fnb_purchase_unit_display]]): each row LEADS in
 * the PURCHASE basis and declares the stored RECIPE figure beneath it — but
 * both come from the ROW'S OWN SNAPSHOT (uom / purchase_uom / pack_size,
 * recorded at movement time), never from the live material. That is the point
 * of the snapshot: a material whose unit or pack size is edited today must not
 * silently re-mean last April's movements. A row written before the snapshot
 * existed has no pack size, so it shows the recipe figure alone and is labelled
 * "not recorded" rather than being divided by a pack size that may have changed.
 *
 * NOTHING IS TOTALLED HERE. This is a register, not a balance: on-hand has one
 * definition per rail and it lives on the server. A column of sums on this page
 * would be a second one. The page says so out loud (see the footer) and names
 * the screens that DO hold each balance, so "which rail is this negative on?"
 * is answered by a sentence instead of by guessing.
 *
 * READING ORDER. Stock depletes forwards and the register lists newest-first,
 * so a depletion story reads bottom-to-top by default. The Date header toggles
 * the whole result set — not the visible page — to oldest-first, which is the
 * order the goods actually moved. It does that WITHOUT a second query shape:
 * the server's ordering is a total order with a real COUNT(*), so oldest-first
 * page N is exactly newest-first page (total-N) read backwards. See `load()`.
 *
 * Mobile-first 375px: the table scrolls inside its own container and the
 * filters stack.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight, Search, X, Loader2, AlertCircle, Download, Filter,
  Store as StoreIcon, Building2, Warehouse, User as UserIcon, Calendar,
  ChevronLeft, ChevronRight, Info, ArrowDown, ArrowUp,
} from 'lucide-react';
import { fmtQtyNum } from '@/lib/pack-units';

/* ── Types (mirror the route's `shaped` rows) ─────────────────────────────── */

type Rail = 'store' | 'department' | 'central';

interface MovementRow {
  id: string;
  rail: Rail;
  rail_id: string;
  rail_name: string;
  movement_type: string;
  material_id: string;
  material_name: string;
  quantity: number;
  uom: string;
  purchase_uom: string;
  pack_size: number;
  qty_purchase: number | null;
  src_kind: string; src_id: string; src_name: string;
  dst_kind: string; dst_id: string; dst_name: string;
  txn_date: string;
  created_at: string;
  recorded_at: string;
  actor: string;
  reference_id: string;
  notes: string;
  unit_cost: number | null;
  unrecorded: boolean;
  /** This row is the RECORD of a movement that happened on another rail, not
   *  the movement itself — recipe consumption, whose grams already appear as
   *  the department row that lost them. Without the badge the same sold prawns
   *  read as two separate movements on one screen. */
  audit_only?: boolean;
  /** WHY the server decided that, and the discriminator this page's badge
   *  needs. The classification has ONE definition and it is the route's
   *  (auditBasisOf) — read it, never re-derive it. Optional only so an older
   *  server build still renders; see auditBasisOf() below for that path. */
  audit_basis?: string;
}

interface Payload {
  movements: MovementRow[];
  total: number;
  /** How many of `total` are rows whose grams another row of the same result
   *  already counts. Over the WHOLE filtered set — counted by the server from
   *  the same predicate that sets the per-row flag. */
  audit_mirrors?: number;
  /** The server's offset ceiling. Past it the register cannot page further. */
  max_offset?: number;
  limit: number;
  offset: number;
  can_see_value: boolean;
  stores: { id: string; name: string; is_active: number }[];
  departments: { id: string; name: string }[];
  types: { store: string[]; department: string[]; central: string[] };
}

const PAGE_SIZE = 200;
/** The route's own ceiling for format=csv (the `isCsv ? 20000 : 2000` clamp in
 *  movements/route.ts). Restated here so the page can say, BEFORE the click,
 *  exactly how much of the result set the file will and will not contain — the
 *  download itself carries no truncation marker, so silence on this screen was
 *  the whole defect. If that clamp ever moves, this number moves with it; the
 *  warning is worth more than the duplication. */
const CSV_MAX = 20000;

type Order = 'desc' | 'asc';

const RAIL_LABEL: Record<Rail, string> = {
  store: 'Store', department: 'Department', central: 'Central',
};
const RAIL_ICON: Record<Rail, typeof StoreIcon> = {
  store: StoreIcon, department: Building2, central: Warehouse,
};

/**
 * recorded_at is the IMMUTABLE WRITE STAMP, produced by
 * movement-record.recordedNow() as 'YYYY-MM-DD HH:MM:SS' **in UTC with no zone
 * marker**; txn_date is already the IST business day (businessDate()).
 * Comparing the two raw strings therefore labelled every movement written
 * between 00:00 and 05:29 IST as backdated — and those are a restaurant's
 * closing hours: the last KOTs, the settle, the wastage and the closing counts
 * all land in that window. Convert the stamp onto the IST day first, and show
 * the IST day, so both halves of the comparison mean the same thing.
 *
 * Parsed with Date.UTC on the matched parts rather than `new Date(s)`, because
 * `new Date('2026-09-19 19:30:00')` is parsed as LOCAL time — on a server set to
 * IST that would silently undo the correction. A trailing 'Z' or '.mmm' is
 * ignored by the match, which is right: both spellings are already UTC.
 */
function recordedISTDate(recordedAt: string): string {
  const s = String(recordedAt || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return s.slice(0, 10);                       // unparseable — show as stored
  if (m[4] === undefined) return `${m[1]}-${m[2]}-${m[3]}`;  // date only, nothing to shift
  const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return new Date(utcMs + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * WHAT A 'sale'/'nc' ROW ON THE CENTRAL RAIL ACTUALLY IS — and it is not one
 * thing. deductInventoryForSale writes the central row on EVERY branch, but it
 * writes the department row only when a department could be resolved, so the
 * same badge used to sit on four different facts. The classification has ONE
 * definition and it is the route's (`auditBasisOf`, movements/route.ts), which
 * publishes it per row as `audit_basis` precisely so this badge can read it:
 *
 *   'department'    the source names the department that lost the goods, so
 *                   that row is in this register too → these grams are counted
 *                   twice if you add both.
 *   'unbooked'      notBooked(...) — no rail booked it, so this row is the ONLY
 *                   record there is. Telling the owner to discount it was the
 *                   defect: it is the whole answer to "where did it go?".
 *   'pre_dept_rail' written before the department ledger's first ever row, so a
 *                   twin cannot exist. Proved by the server, not assumed.
 *   'unknown'       blank source, written after the rail started — a twin may
 *                   exist and the row alone cannot say.
 *
 * The page does NOT re-derive this. Re-deriving it would put a second
 * definition of "is this a duplicate" on the screen, and the two would drift.
 * The fallback below exists only for a server build that does not publish the
 * field, and it claims strictly less than the server can.
 */
type AuditBasis = '' | 'department' | 'unbooked' | 'pre_dept_rail' | 'unknown';

function auditBasisOf(r: MovementRow): AuditBasis {
  const published = (r.audit_basis || '') as AuditBasis;
  if (published) return published;
  if (r.audit_basis !== undefined) return '';          // server said: not an audit row
  // Older server build. Decide from the row's own columns, and never claim the
  // 'pre_dept_rail' proof — that needs a fact this page does not have.
  const isSaleRow = !!r.audit_only
    || (r.rail === 'central' && (r.movement_type === 'sale' || r.movement_type === 'nc'));
  if (!isSaleRow) return '';
  if (r.src_kind === 'department') return 'department';
  if (r.src_kind) return 'unbooked';
  return 'unknown';
}

const SALE_BADGE: Record<Exclude<AuditBasis, ''>, { label: string; title: string; tone: string }> = {
  department: {
    label: 'audit mirror — do not add',
    tone: 'bg-[#F3EDE3] text-[#7A6A55] border-[#E3D8C6]',
    title:
      'Record of a sale, not a stock movement of its own. The goods came off the department shown as the source, and THAT department row — listed separately here, with the same quantity, date and reference — is the movement. Counting both double-counts every sold gram, so this row\'s quantity is shown in brackets. Kept because the variance and sales-vs-purchase reports read this table.',
  },
  unbooked: {
    label: 'sale record — the only row',
    tone: 'bg-[#FBEEDC] text-[#8A5A12] border-[#EAD6B4]',
    title:
      'A sale whose department could NOT be resolved (the reason is in the Source cell), so no department row was ever written. This row is the only record that these goods left — it is not a duplicate of anything and must NOT be discounted.',
  },
  pre_dept_rail: {
    label: 'sale record — no twin exists',
    tone: 'bg-[#E8EAF3] text-[#3B3F72] border-[#D3D7E8]',
    title:
      'A sale recorded before the department ledger had written its first row, so a matching department movement cannot exist. This row is the only record of it, and it is not a duplicate of anything.',
  },
  unknown: {
    label: 'sale record — may be counted twice',
    tone: 'bg-[#F1F1EF] text-[#5A5750] border-[#E2E2DE]',
    title:
      'A sale whose source was never captured on the row, written after the department ledger had started. A matching department row may exist — the register cannot tell from this row alone, and it will not claim one either way. The quantity is bracketed so a hand-sum errs on the safe side; open the department rail for the same date and reference to settle it.',
  },
};

/** Colour by what sort of place an end is — a sink reads differently from a
 *  store, and a blank ("not recorded") must not look like a real location. */
function kindTone(kind: string): string {
  switch (kind) {
    case 'store':      return 'bg-[#F4E9DC] text-[#7A4A16]';
    case 'department': return 'bg-[#E6EFE6] text-[#2F5D34]';
    case 'central':    return 'bg-[#E8EAF3] text-[#3B3F72]';
    case 'vendor':     return 'bg-[#FBEEDC] text-[#8A5A12]';
    case 'production': return 'bg-[#EDE7F6] text-[#4A3576]';
    case 'consumption':
    case 'staff_meal': return 'bg-[#F1F1EF] text-[#5A5750]';
    case 'wastage':    return 'bg-[#FAE6E4] text-[#8C2F26]';
    case 'adjustment':
    case 'opening':    return 'bg-[#EFEFEF] text-[#6B6B6B]';
    default:           return 'bg-transparent text-[#B8A590] italic';
  }
}

function prettyKind(kind: string): string {
  if (!kind) return 'not recorded';
  return kind.replace(/_/g, ' ');
}

function prettyType(t: string): string {
  return String(t || '').replace(/_/g, ' ');
}

/**
 * WHY A BLANK IS BLANK — and why this sentence no longer says "predates".
 * Most blank rows do predate the register. Not all of them: the grocery→store
 * transfer issue in store-engine.ts still writes a central row carrying none of
 * the movement columns, so a transfer made TODAY renders with no unit, no
 * source, no destination and no responsible user. Telling the owner a blank
 * means the row is old would send him looking in the wrong decade.
 */
const NOT_RECORDED_TITLE = (what: string) =>
  `This row does not carry ${what}. Most such rows were written before this register existed, but not all — a few paths still write a movement without these fields, so a blank is not proof the movement is old. It is shown blank rather than guessed.`;

/** One end of a movement: the snapshot NAME leads, its kind is the small tag. */
function Endpoint({ name, kind }: { name: string; kind: string }) {
  if (!kind && !name) {
    return (
      <span className="text-[11px] text-[#B8A590] italic" title={NOT_RECORDED_TITLE('the location it moved between')}>
        not recorded
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col gap-0.5 min-w-0">
      {/* title= because this cell truncates: a long store name, or a "not
          booked — <why>" source on a consumption no rail lost, must still be
          readable in full without opening the CSV. */}
      <span className="text-[12px] text-[#2D1B0E] truncate" title={name || prettyKind(kind)}>{name || prettyKind(kind)}</span>
      <span className={`text-[9px] px-1 py-px rounded self-start ${kindTone(kind)}`}>{prettyKind(kind)}</span>
    </span>
  );
}

export default function MovementsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);

  // Filters — the owner's four, plus item/actor search.
  const [rail, setRail] = useState<'all' | Rail>('all');
  const [storeId, setStoreId] = useState('');
  const [deptId, setDeptId] = useState('');
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [actor, setActor] = useState('');
  const [offset, setOffset] = useState(0);
  /** Reading direction. The register lists newest-first, which is right for
   *  "what happened today" and exactly wrong for "how did this go negative" —
   *  depletion happens forwards. Default unchanged; the Date header flips it. */
  const [order, setOrder] = useState<Order>('desc');

  /** The filters ALONE — no limit, no offset, no order. This is the identity of
   *  a result set: while it is unchanged, `total` is unchanged, which is what
   *  makes the oldest-first window below computable without a second count. */
  const filterQS = useMemo(() => {
    const p = new URLSearchParams();
    if (rail !== 'all') p.set('rail', rail);
    if (storeId) p.set('store_id', storeId);
    if (deptId) p.set('department_id', deptId);
    if (type) p.set('type', type);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (q.trim()) p.set('q', q.trim());
    if (actor.trim()) p.set('actor', actor.trim());
    return p.toString();
  }, [rail, storeId, deptId, type, from, to, q, actor]);

  /** Last known COUNT(*) and offset ceiling for a given filter set. A ref, not
   *  state: it must not re-trigger `load`, and both are caches of the server's
   *  own numbers — never numbers this page computed. */
  const totalRef = useRef<{ key: string; total: number; maxOffset: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setDenied(false);
    const url = (limit: number, off: number) =>
      `/api/inventory/movements?${filterQS}${filterQS ? '&' : ''}limit=${limit}&offset=${off}`;
    try {
      /* ── OLDEST-FIRST WITHOUT A SECOND ORDERING ────────────────────────────
       * The server returns ONE total order (business date desc, created_at
       * desc) with a real COUNT(*). Ascending index j is therefore descending
       * index total-1-j, so the ascending page [off, off+PAGE) is exactly the
       * descending window starting at total-off-PAGE, read backwards. No new
       * query shape, no client-side re-sort of a partial page (which would
       * silently reorder only the rows that happen to be loaded), and the
       * rows are provably the same rows in the opposite order.
       *
       * It needs `total` first. In practice that is already cached — the page
       * opens newest-first and the toggle keeps the same filters — so the
       * extra count below fires only when the filters changed while ascending. */
      let known = totalRef.current && totalRef.current.key === filterQS ? totalRef.current : null;
      if (order === 'asc' && !known) {
        const probe = await fetch(url(1, 0));
        const pj = await probe.json();
        if (!probe.ok) {
          setDenied(probe.status === 403);
          setError(pj?.error || `Could not load movements (${probe.status})`);
          setData(null);
          return;
        }
        known = { key: filterQS, total: Number(pj.total) || 0, maxOffset: Number(pj.max_offset) || Infinity };
        totalRef.current = known;
      }

      let reqOffset = offset;
      let reqLimit = PAGE_SIZE;
      if (order === 'asc') {
        const t = known?.total ?? 0;
        const cap = known?.maxOffset ?? Infinity;
        reqOffset = Math.max(0, t - offset - PAGE_SIZE);
        reqLimit = Math.max(1, Math.min(PAGE_SIZE, t - offset));
        /* THE CAP AND THE INVERSION MEET HERE, and getting this wrong would be
         * worse than the defect it fixes. The oldest rows live at the DEEPEST
         * descending offsets; the server refuses offsets past max_offset and
         * silently clamps them. Serving a clamped window under the heading
         * "oldest first" would present the wrong rows as the answer. So when
         * the oldest end is out of the server's reach, show nothing and say
         * so — the one honest answer. Reachable for any result set up to
         * max_offset + one page, which is every real one on this data. */
        if (reqOffset > cap) {
          setError(
            `Cannot read this result set from the oldest end: the register stops paging at `
            + `${cap.toLocaleString('en-IN')} rows and the oldest of these ${t.toLocaleString('en-IN')} lie past it. `
            + `Narrow the date range, or read it newest first.`,
          );
          setData(d => (d ? { ...d, movements: [], total: t } : d));
          return;
        }
      }

      const res = await fetch(url(reqLimit, reqOffset));
      const json = await res.json();
      if (!res.ok) {
        setDenied(res.status === 403);
        setError(json?.error || `Could not load movements (${res.status})`);
        setData(null);
        return;
      }
      totalRef.current = {
        key: filterQS,
        total: Number(json.total) || 0,
        maxOffset: Number(json.max_offset) || Infinity,
      };
      const movements: MovementRow[] = json.movements || [];
      setData({ ...json, movements: order === 'asc' ? [...movements].reverse() : movements });
    } catch (e: any) {
      setError(e?.message || 'Could not load movements');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [filterQS, offset, order]);

  useEffect(() => { load(); }, [load]);

  // A filter change starts a new result set, so the page offset must reset —
  // otherwise page 3 of the old filter silently becomes an empty page 3 of the
  // new. Flipping the reading direction is the same thing: page 3 of "newest
  // first" is not page 3 of "oldest first".
  useEffect(() => { setOffset(0); }, [rail, storeId, deptId, type, from, to, q, actor, order]);

  // The type list follows the rail: each rail has its OWN closed vocabulary and
  // offering all three at once would let a user pick a type that rail can never
  // emit and read the empty result as "no movements".
  const typeOptions = useMemo(() => {
    if (!data) return [];
    if (rail === 'all') {
      return [...new Set([...data.types.store, ...data.types.department, ...data.types.central])].sort();
    }
    return [...data.types[rail]].sort();
  }, [data, rail]);

  const clearAll = () => {
    setRail('all'); setStoreId(''); setDeptId(''); setType('');
    setFrom(''); setTo(''); setQ(''); setActor('');
  };
  const anyFilter = rail !== 'all' || storeId || deptId || type || from || to || q || actor;
  /** The search box is the only thing narrowing the register. An empty result
   *  under this condition is a FACT about the item, not a filter mistake, and
   *  the two must not share a sentence. */
  const itemOnlySearch = !!q.trim()
    && rail === 'all' && !storeId && !deptId && !type && !from && !to && !actor.trim();

  const csvHref = useMemo(() => {
    const p = new URLSearchParams(filterQS);
    p.set('format', 'csv');
    p.set('limit', String(CSV_MAX));
    return `/api/inventory/movements?${p.toString()}`;
  }, [filterQS]);

  const rows = data?.movements || [];
  const total = data?.total || 0;
  /** The export is capped server-side and the file says nothing about it, so
   *  the cap has to be said HERE, before the click — otherwise a 3%-complete
   *  spreadsheet looks exactly like a complete one. */
  const csvTruncated = total > CSV_MAX;
  /** How many of `total` are rows another row already counts. The SERVER's
   *  number, over the whole filtered set, from the same predicate that sets the
   *  per-row flag — not a count of what happens to be rendered. */
  const auditMirrors = data?.audit_mirrors ?? 0;
  /** The server stops paging here; past it the same page would be served
   *  forever, so the Next button has to stop too and say why. */
  const maxOffset = data?.max_offset ?? Infinity;
  const atOffsetCap = offset + PAGE_SIZE > maxOffset;
  /** More than one page. `total` is now a real COUNT(*) per rail (the API used to
   *  return the merged page length, which made this permanently false and hid
   *  the controls entirely), and `offset > 0` keeps the controls on screen on a
   *  later page even if a concurrent write shrinks the count under one page. */
  const paged = total > PAGE_SIZE || offset > 0 || rows.length < total;

  return (
    <div className="p-3 sm:p-6 max-w-[1600px] mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <ArrowLeftRight className="w-6 h-6 text-[#af4408]" /> Stock Movements
        </h1>
        <p className="text-sm text-[#7A6A55] mt-1">
          Every stock movement, on every rail — item, quantity, unit, where it came from,
          where it went, type, date and who did it.
        </p>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-[#E8CFCB] bg-[#FBF1F0] px-3 py-2.5 text-sm text-[#8C2F26]">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {denied ? `🔒 ${error}` : error}
        </div>
      )}

      {/* ── FILTERS: the owner's four (store, department, type, date) ───────── */}
      <div className="mb-4 rounded-xl border border-[#E8DCC8] bg-white p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold text-[#7A6A55] uppercase tracking-wide flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5" /> Filters
          </span>
          <div className="flex items-center gap-2">
            {anyFilter && (
              <button onClick={clearAll} className="text-[11px] text-[#af4408] hover:underline flex items-center gap-1">
                <X className="w-3 h-3" /> Clear
              </button>
            )}
            <a
              href={csvHref}
              title={csvTruncated
                ? `The export is capped at ${CSV_MAX.toLocaleString('en-IN')} rows and the file carries no marker saying so. These filters match ${total.toLocaleString('en-IN')}.`
                : 'Exports every row these filters match, with the same gate as the screen.'}
              className={`text-[11px] inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-[#FBF6EE] ${
                csvTruncated ? 'border-[#E8CFCB] text-[#8C2F26]' : 'border-[#E8DCC8] text-[#2D1B0E]'}`}
            >
              <Download className="w-3 h-3" />
              {csvTruncated ? `CSV (first ${CSV_MAX.toLocaleString('en-IN')} only)` : 'CSV'}
            </a>
          </div>
        </div>

        {/* THE EXPORT CAP, SAID BEFORE THE CLICK. The route stops at CSV_MAX and
            writes no truncation row, so a file that is 3% of the register opens
            looking complete — next to a screen header reading the real number. */}
        {csvTruncated && (
          <p className="mb-2 flex items-start gap-1.5 rounded-lg border border-[#E8CFCB] bg-[#FBF1F0] px-2.5 py-2 text-[11px] text-[#8C2F26]">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>
              <strong>The CSV will not be complete.</strong> It holds at most{' '}
              {CSV_MAX.toLocaleString('en-IN')} rows; these filters match{' '}
              {total.toLocaleString('en-IN')}, so{' '}
              {(total - CSV_MAX).toLocaleString('en-IN')} would be missing from the file and
              nothing inside it says so. It always takes the <strong>newest</strong>{' '}
              {CSV_MAX.toLocaleString('en-IN')}, whichever way this table is sorted. Narrow the
              date range and export in parts.
            </span>
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[#7A6A55] uppercase">Rail</span>
            <select value={rail} onChange={e => setRail(e.target.value as any)}
              className="rounded-md border border-[#E8DCC8] px-2 py-1.5 text-sm bg-white">
              <option value="all">All rails</option>
              <option value="store">Store</option>
              <option value="department">Department</option>
              <option value="central">Central</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[#7A6A55] uppercase">Store</span>
            <select value={storeId} onChange={e => { setStoreId(e.target.value); if (e.target.value) setDeptId(''); }}
              className="rounded-md border border-[#E8DCC8] px-2 py-1.5 text-sm bg-white">
              <option value="">All stores</option>
              {(data?.stores || []).map(s => (
                <option key={s.id} value={s.id}>{s.name}{s.is_active ? '' : ' (inactive)'}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[#7A6A55] uppercase">Department</span>
            <select value={deptId} onChange={e => { setDeptId(e.target.value); if (e.target.value) setStoreId(''); }}
              className="rounded-md border border-[#E8DCC8] px-2 py-1.5 text-sm bg-white">
              <option value="">All departments</option>
              {(data?.departments || []).map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[#7A6A55] uppercase">Movement type</span>
            <select value={type} onChange={e => setType(e.target.value)}
              className="rounded-md border border-[#E8DCC8] px-2 py-1.5 text-sm bg-white">
              <option value="">All types</option>
              {typeOptions.map(t => <option key={t} value={t}>{prettyType(t)}</option>)}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[#7A6A55] uppercase flex items-center gap-1">
              <Calendar className="w-3 h-3" /> From
            </span>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="rounded-md border border-[#E8DCC8] px-2 py-1.5 text-sm bg-white" />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[#7A6A55] uppercase flex items-center gap-1">
              <Calendar className="w-3 h-3" /> To
            </span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
              className="rounded-md border border-[#E8DCC8] px-2 py-1.5 text-sm bg-white" />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[#7A6A55] uppercase flex items-center gap-1">
              <Search className="w-3 h-3" /> Item / place
            </span>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Material, source or destination"
              className="rounded-md border border-[#E8DCC8] px-2 py-1.5 text-sm bg-white" />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[#7A6A55] uppercase flex items-center gap-1">
              <UserIcon className="w-3 h-3" /> Responsible user
            </span>
            <input value={actor} onChange={e => setActor(e.target.value)} placeholder="email or system:…"
              className="rounded-md border border-[#E8DCC8] px-2 py-1.5 text-sm bg-white" />
          </label>
        </div>

        {(storeId || deptId) && (
          <p className="mt-2 text-[11px] text-[#7A6A55] flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
            {storeId
              ? 'Filtered to one store, so only that store’s own ledger rows are listed. A central purchase that supplied it belongs to the central rail, not to this store.'
              : 'Filtered to one department, so only that department’s own ledger rows are listed. The central side of an issue belongs to the central rail.'}
          </p>
        )}
      </div>

      {/* ── THE REGISTER ────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-[#E8DCC8] bg-white overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[#F0E6D6]">
          <span className="text-[11px] text-[#7A6A55]">
            {loading ? 'Loading…' : `${total.toLocaleString('en-IN')} movement${total === 1 ? '' : 's'}`}
            {/* The range describes rows that are actually on screen. When the
                oldest end is past the server's paging ceiling there are none,
                and "showing 1–200" over an empty table would be the register
                contradicting itself. */}
            {!loading && paged && rows.length > 0 && (
              <> · showing {offset + 1}–{offset + rows.length}</>
            )}
            {!loading && <> · {order === 'asc' ? 'oldest first' : 'newest first'}</>}
            {/* The server's own tally over the whole filtered set, so the
                headline row count cannot be read as a count of distinct
                movements when a share of it is the same grams twice. */}
            {!loading && auditMirrors > 0 && (
              <> · <span className="text-[#8A5A12]">
                {auditMirrors.toLocaleString('en-IN')} of them {auditMirrors === 1 ? 'repeats' : 'repeat'}{' '}
                a quantity another row here already counts — bracketed, do not add{' '}
                {auditMirrors === 1 ? 'it' : 'them'} in
              </span></>
            )}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            {/* The register lists newest-first; a depletion reads forwards.
                This flips the WHOLE result set, not the loaded page. */}
            <button
              type="button"
              onClick={() => setOrder(o => (o === 'desc' ? 'asc' : 'desc'))}
              className="text-[11px] inline-flex items-center gap-1 rounded-md border border-[#E8DCC8] px-2 py-1 text-[#2D1B0E] hover:bg-[#FBF6EE]"
              title={order === 'desc'
                ? 'Read the register forwards — oldest first, the order the stock actually moved. Applies to every matching row, not just this page.'
                : 'Back to newest first.'}
            >
              {order === 'desc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
              {order === 'desc' ? 'Oldest first' : 'Newest first'}
            </button>
          {paged && (
            <div className="flex items-center gap-1">
              <button
                disabled={offset === 0}
                onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))}
                className="p-1 rounded border border-[#E8DCC8] disabled:opacity-40"
                aria-label="Previous page"
              ><ChevronLeft className="w-3.5 h-3.5" /></button>
              <button
                disabled={offset + PAGE_SIZE >= total || atOffsetCap}
                onClick={() => setOffset(o => o + PAGE_SIZE)}
                className="p-1 rounded border border-[#E8DCC8] disabled:opacity-40"
                aria-label="Next page"
                title={atOffsetCap
                  ? `The register stops paging at ${maxOffset.toLocaleString('en-IN')} rows. Narrow the date range to reach the rest — or read them from the other end with “Oldest first”.`
                  : 'Next page'}
              ><ChevronRight className="w-3.5 h-3.5" /></button>
            </div>
          )}
          </div>
        </div>

        {/* Wide table scrolls INSIDE its own container — the page body never
            scrolls sideways on a phone. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-[#FBF6EE] text-[10px] uppercase tracking-wide text-[#7A6A55]">
              <tr>
                {/* Sortable: the ONLY column with a meaningful order, and the
                    one the register is about. Clicking it re-pages the whole
                    result set, so the depletion reads forwards. */}
                <th className="text-left font-semibold px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setOrder(o => (o === 'desc' ? 'asc' : 'desc'))}
                    className="inline-flex items-center gap-1 uppercase tracking-wide font-semibold hover:text-[#af4408]"
                    title={order === 'desc'
                      ? 'Newest first. Click to read the register forwards — oldest first, the order the stock actually moved.'
                      : 'Oldest first — the order the stock actually moved. Click for newest first.'}
                    aria-label={`Date — sorted ${order === 'desc' ? 'newest first' : 'oldest first'}, click to reverse`}
                  >
                    Date {order === 'desc' ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />}
                  </button>
                </th>
                <th className="text-left font-semibold px-3 py-2">Type</th>
                <th className="text-left font-semibold px-3 py-2">Item</th>
                <th className="text-right font-semibold px-3 py-2">Quantity</th>
                <th className="text-left font-semibold px-3 py-2">Source</th>
                <th className="text-left font-semibold px-3 py-2">Destination</th>
                <th className="text-left font-semibold px-3 py-2">Responsible user</th>
                <th className="text-left font-semibold px-3 py-2">Reference</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-[#7A6A55]">
                  <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading movements…
                </td></tr>
              )}
              {/* THE EMPTY ANSWER IS NOT ONE ANSWER. "No movements match these
                  filters" reads as a filter mistake — and for a material that
                  holds stock today and has never had a movement recorded, it is
                  the opposite: the filters are right and the register is the
                  message. Say which case this is. */}
              {!loading && !rows.length && !error && (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-[#7A6A55]">
                  {itemOnlySearch ? (
                    <span className="inline-block max-w-[640px] text-left">
                      <span className="block text-[13px] text-[#2D1B0E] font-medium">
                        Nothing matching “{q.trim()}” has ever been recorded as a movement.
                      </span>
                      <span className="block mt-1 text-[11px]">
                        No rows on the store, department or central rail, on any date — and no
                        other filter is narrowing this. <strong>This is not a filter mistake.</strong>{' '}
                        If the item holds stock today, that stock arrived before this register
                        existed, or by one of the paths that still change a balance without
                        writing a movement (see the note under the table).
                      </span>
                    </span>
                  ) : anyFilter ? (
                    <span className="inline-flex flex-col items-center gap-2">
                      <span>No movements match these filters.</span>
                      <button onClick={clearAll}
                        className="text-[11px] inline-flex items-center gap-1 rounded-md border border-[#E8DCC8] px-2 py-1 text-[#af4408] hover:bg-[#FBF6EE]">
                        <X className="w-3 h-3" /> Clear filters
                      </button>
                    </span>
                  ) : (
                    <span>No movements have been recorded yet.</span>
                  )}
                </td></tr>
              )}
              {!loading && rows.map(r => {
                const RailIcon = RAIL_ICON[r.rail];
                const positive = r.quantity >= 0;
                const sale = auditBasisOf(r);
                /** Whether these grams are ALSO counted by another row here —
                 *  the server's own de-duplication flag, the same one its
                 *  `audit_mirrors` tally counts, so the header and the rows can
                 *  never disagree. A sale record with no twin is the only
                 *  evidence there is and must read as a real movement. */
                const duplicated = r.audit_only ?? (sale === 'department' || sale === 'unknown');
                // The write stamp, on the same IST day basis as txn_date.
                const recIST = recordedISTDate(r.recorded_at);
                const backdated = !!recIST && !!r.txn_date && recIST !== r.txn_date;
                return (
                  <tr
                    key={`${r.rail}:${r.id}`}
                    className={`border-t border-[#F5EEE3] align-top hover:bg-[#FDFAF5] ${
                      duplicated ? 'bg-[#FCFBF8]' : ''}`}
                  >
                    {/* 7 — transaction date, with the recording moment beneath
                        it when they are genuinely different DAYS (a backdated
                        entry says so). Both sides are IST business days. */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="text-[12px] text-[#2D1B0E]">{r.txn_date || '—'}</div>
                      {backdated && (
                        <div className="text-[9px] text-[#B8A590]" title="When this row was written, as an Indian business day — kept separately from the date the movement happened. The stored stamp is UTC and is converted here, so a movement entered at 1 a.m. is not mislabelled as yesterday's paperwork.">
                          recorded {recIST}
                        </div>
                      )}
                    </td>

                    {/* 6 — movement type, with the rail it lives on */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className={`text-[12px] ${duplicated ? 'text-[#7A6A55]' : 'text-[#2D1B0E]'}`}>{prettyType(r.movement_type)}</div>
                      <div className="text-[9px] text-[#7A6A55] flex items-center gap-1">
                        <RailIcon className="w-2.5 h-2.5" />
                        {/* The central rail is not always "Central": a recipe
                            consumption row lives on that table because every
                            variance report reads it, but central never lost the
                            goods — the department did. The server names the row
                            honestly, so show the name it gives. */}
                        {sale ? (r.rail_name || 'Recipe consumption (audit)')
                          : <>{RAIL_LABEL[r.rail]}{r.rail_name && r.rail !== 'central' ? ` · ${r.rail_name}` : ''}</>}
                      </div>
                      {/* THE DOUBLE-COUNT WARNING — but only where there IS a
                          double. The four cases are different facts, decided
                          once by the server; the badge says which one this row
                          is. See auditBasisOf / SALE_BADGE. */}
                      {sale && (
                        <div
                          className={`mt-0.5 inline-block text-[10px] font-medium px-1.5 py-px rounded border ${SALE_BADGE[sale].tone}`}
                          title={SALE_BADGE[sale].title}
                        >
                          {SALE_BADGE[sale].label}
                        </div>
                      )}
                    </td>

                    {/* 1 — item */}
                    <td className="px-3 py-2 max-w-[220px]">
                      <div className="text-[12px] text-[#2D1B0E] break-words">{r.material_name}</div>
                      {r.notes && <div className="text-[9px] text-[#B8A590] break-words">{r.notes}</div>}
                    </td>

                    {/* 2 + 3 — quantity and its unit. Purchase basis LEADS (house
                        rule); the stored recipe figure is the declared hint. Both
                        come from the row's own snapshot. */}
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {/* A MIRROR'S quantity is bracketed and drained of colour.
                          It is the same grams as the department row listed
                          elsewhere in this register, and rendered identically it
                          read as a second movement — the Quantity column summed
                          to twice the true consumption with only a 9px chip to
                          say otherwise. Brackets are the accounting convention
                          for "shown, not counted"; the sign and figure are
                          unchanged, so nothing is hidden. */}
                      <div
                        className={`text-[12px] font-medium ${
                          duplicated ? 'text-[#A2998A]' : positive ? 'text-[#2F5D34]' : 'text-[#8C2F26]'}`}
                        title={duplicated
                          ? (sale === 'unknown'
                              ? 'May already be counted by a department row for the same sale — the source was never captured, so the register cannot be sure. Bracketed so a hand-sum errs on the safe side.'
                              : 'Already counted on the department row for the same sale — shown for the audit trail, not to be added.')
                          : undefined}
                      >
                        {duplicated && '('}
                        {/* The unit is appended only when the row HAS one, so a
                            bracketed figure on a unit-less legacy row reads
                            "(-7)" and not "(-7 )". */}
                        {r.qty_purchase !== null
                          ? <>{positive ? '+' : ''}{fmtQtyNum(r.qty_purchase)}{r.purchase_uom ? ` ${r.purchase_uom}` : ''}</>
                          : <>{positive ? '+' : ''}{fmtQtyNum(r.quantity)}{r.uom ? ` ${r.uom}` : ''}</>}
                        {duplicated && ')'}
                      </div>
                      {duplicated && (
                        <div className="text-[9px] text-[#A2998A] italic">
                          {sale === 'unknown' ? 'may already be counted' : 'already counted above'}
                        </div>
                      )}
                      {/* The hint renders when the two bases actually SAY
                          different things. It used to re-derive the pack rule
                          here (`r.pack_size > 1`), which is the one thing the
                          purchase-unit lock forbids on a render line — a
                          hand-rolled pack rule is not evidence the shared pack
                          layer was used, and this page has no material object to
                          hand packFactor(). The conversion is already done, once,
                          server-side from the row's OWN snapshot
                          (movements/route.ts computes qty_purchase); this line
                          only compares its result with the stored figure. */}
                      {r.qty_purchase !== null
                        && (r.qty_purchase !== r.quantity || r.purchase_uom !== r.uom) && (
                        <div className="text-[9px] text-[#B8A590]">= {fmtQtyNum(r.quantity)} {r.uom}</div>
                      )}
                      {!r.uom && (
                        <div className="text-[9px] text-[#B8A590] italic" title={NOT_RECORDED_TITLE('its unit')}>
                          unit not recorded
                        </div>
                      )}
                    </td>

                    {/* 4 — source */}
                    <td className="px-3 py-2 max-w-[170px]"><Endpoint name={r.src_name} kind={r.src_kind} /></td>
                    {/* 5 — destination */}
                    <td className="px-3 py-2 max-w-[170px]"><Endpoint name={r.dst_name} kind={r.dst_kind} /></td>

                    {/* 8 — responsible user */}
                    <td className="px-3 py-2 max-w-[190px]">
                      {r.actor
                        ? (r.actor.startsWith('system:')
                            ? <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#EFEFEF] text-[#5A5750]" title="A machine-initiated movement — no person was signed in. Recorded honestly rather than left blank or attributed to someone.">{r.actor}</span>
                            : <span className="text-[12px] text-[#2D1B0E] break-all">{r.actor}</span>)
                        : <span className="text-[11px] text-[#B8A590] italic" title={NOT_RECORDED_TITLE('no responsible user')}>not recorded</span>}
                    </td>

                    <td className="px-3 py-2 max-w-[160px]">
                      <span className="text-[10px] text-[#7A6A55] break-all">{r.reference_id || '—'}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* THE FOOTER USED TO BE WRONG, and wrong in the one direction that
          matters: it told the owner a blank meant the row was historical.
          Rows written today by the grocery→store transfer issue path carry none
          of the movement columns, so "not recorded" appears on a movement made
          this morning. A register that misdates its own gaps sends the
          investigation to the wrong month. */}
      <div className="mt-3 space-y-2 text-[11px] text-[#7A6A55]">
        <p className="flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>
            <strong>“Not recorded” means the fact is not on the row</strong> — not that the row is
            old. Most blanks are historical: rows written before this register existed carry no
            unit, source, destination or (on the central rail) responsible user. But a few paths
            still write a movement without them today — a store transfer issued from the central
            store is the known case — so a blank is not proof the movement is old. Nothing is
            guessed and no history was rewritten.
          </span>
        </p>
        <p className="flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>
            <strong>This is a register of movements, not a balance.</strong> It deliberately adds
            nothing up: each rail’s on-hand figure has exactly one definition, and it lives on its
            own screen — <em>Department Stock</em> for a department, the <em>Liquor Store</em> page
            for a store, <em>Stock Overview</em> for the central book. When a balance looks wrong,
            read it there first, then come here for the rows behind it — and remember that a
            movement can change a balance on one rail without appearing on another.
          </span>
        </p>
      </div>
    </div>
  );
}
