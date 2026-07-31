import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAccessPage } from '@/lib/page-catalog';
import { todayIST } from '@/lib/format-date';
import {
  PETTY_CATEGORIES, buildLedgerView, cashInHandPaise, categoryDef, guardOutflow,
  isPettyCategory, ledgerCsv, pettyCashAdjustGate, pettyCashWriteGate, toPaise, toRupees,
  type PettyDirection,
} from '@/lib/petty-cash';

/**
 * PETTY CASH — the store cash box (owner requirement 5).
 *
 *   GET  /api/petty-cash?from=&to=&category=&format=csv
 *        → cash in hand, the debit/credit log with a running balance per row,
 *          and the period summary (opened with X, in Y, out Z, closing W).
 *   POST /api/petty-cash
 *        → record ONE movement. Body:
 *          { date, direction:'in'|'out', amount>0, category, vendor?, reference?,
 *            notes?, purchase_id?, confirm_duplicate? }
 *
 * There is no PUT and no DELETE, on purpose. A cash ledger is append-only: the
 * way to correct it is an 'adjustment' row that is itself visible and attributed,
 * not a silent edit of yesterday's figure. Deleting rows is how a balance stops
 * matching the notes in the box with nothing on screen to explain it.
 *
 * BALANCE IS NEVER STORED — every figure here is Σ(in) − Σ(out) computed by
 * src/lib/petty-cash.ts. See that file's header for the money/rounding rules.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * A real calendar date in YYYY-MM-DD.
 *
 * The shape regex alone is not enough for a LEDGER date. "2026-02-31" and
 * "2026-00-00" both match \d{4}-\d{2}-\d{2}, both sort as plain text, and both
 * would be accepted as "not in the future" — leaving a cash row on a day that
 * does not exist. Every period boundary, opening balance and back-dated-outflow
 * guard in src/lib/petty-cash.ts is a string comparison on this column, so a
 * date that no calendar contains silently lands the money in the wrong period
 * (2026-00-00 sorts before every real row, i.e. into the opening balance of
 * every report ever run). Round-tripping through Date rejects those.
 */
const isDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const minusDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

/** Absurdity ceiling — a petty-cash box does not move ₹10,00,000 in one entry.
 *  This catches an extra zero, not a real movement; the message says to split it. */
const MAX_PAISE = 1_000_000_00;

/**
 * PAGE GATE — the one rule, called by BOTH the read path and the write path.
 *
 * proxy.ts only gates page navigations, so without this an API caller with any
 * valid session could reach the cash box. It lives in a function rather than as
 * two copies of the same `if` because the copies drifted once already: the read
 * path checked it, the write path did not, and a manager+HOD whose page_access
 * is ["/dine-in/floor"] — refused the page, refused GET — could still POST money
 * into a ledger they cannot see. On a cash book the write side is the side that
 * matters, so read and write now resolve access through the same call.
 *
 * canAccessPage honours the admin bypass, the legacy null-map grant and the
 * user's page_access map, so the API and the sidebar can never disagree.
 * Returns a 403 Response to hand straight back, or null when access is allowed.
 */
function pageGate(me: Parameters<typeof canAccessPage>[1]): Response | null {
  if (canAccessPage('/petty-cash', me)) return null;
  return Response.json({ error: 'You do not have access to the petty cash book.' }, { status: 403 });
}

function outletName(db: ReturnType<typeof getDb>, id: string | null): string {
  if (!id) return '';
  try {
    const r = db.prepare('SELECT name FROM outlets WHERE id = ?').get(id) as { name?: string } | undefined;
    return r?.name || '';
  } catch { return ''; }
}

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    // READ GATE: the same rule that gates the page itself — see pageGate().
    const denied = pageGate(me);
    if (denied) return denied;

    const db = getDb();
    const outletId = await getCurrentOutletId();
    const sp = new URL(request.url).searchParams;
    const today = todayIST();

    let from = sp.get('from') || minusDays(today, 6);
    let to   = sp.get('to')   || today;
    if (!isDate(from)) from = minusDays(today, 6);
    if (!isDate(to))   to   = today;
    if (from > to) { const t = from; from = to; to = t; }

    const categoryRaw = (sp.get('category') || '').trim();
    // An unknown category would silently filter to zero rows and make the page
    // look like a quiet day. Ignore it and say so instead.
    const category = isPettyCategory(categoryRaw) ? categoryRaw : '';
    const warnings: string[] = [];
    if (categoryRaw && !category) warnings.push(`Unknown category "${categoryRaw}" — showing all categories.`);

    const view = buildLedgerView(db, outletId, from, to, category);
    const name = outletName(db, outletId);

    if (sp.get('format') === 'csv') {
      const csv = ledgerCsv(view, { from, to, outlet: name, category });
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="petty-cash_${from}_to_${to}${category ? '_' + category : ''}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const writeGate = await pettyCashWriteGate();
    const adjustGate = await pettyCashAdjustGate();

    return Response.json({
      outlet: outletId ? { id: outletId, name } : null,
      today,
      // Headline: EVERY row, not just the window — the box holds what it holds
      // regardless of which dates you are looking at.
      cash_in_hand: toRupees(cashInHandPaise(db, outletId)),
      can_record: writeGate === 'ok',
      can_adjust: adjustGate === 'ok',
      range: { from, to },
      category,
      categories: PETTY_CATEGORIES,
      summary: view.summary,
      filtered: view.filtered,
      rows: view.rows,
      warnings,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Could not load the petty cash book.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    // WRITE GATE, PART 1 — page access. The SAME rule the read path applies, and
    // it runs FIRST: the write path must never be looser than the read path.
    // pettyCashWriteGate() below is tier/flag membership only (management OR the
    // store-manager flag) and knows nothing about page_access, so on its own it
    // let a manager or HOD who is refused the page POST into the cash book.
    // Both gates must pass: you may record a movement only in a book you may see.
    const denied = pageGate(me);
    if (denied) return denied;

    // WRITE GATE, PART 2 — who may move the cash (see src/lib/petty-cash.ts).
    const gate = await pettyCashWriteGate();
    if (gate === 'anon') return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (gate !== 'ok') {
      return Response.json({ error: 'Only Management or the Store Manager can record a petty cash movement.' }, { status: 403 });
    }

    const b = await request.json().catch(() => null);
    if (!b || typeof b !== 'object') return Response.json({ error: 'Send a JSON body.' }, { status: 400 });

    // ── date ────────────────────────────────────────────────────────────────
    const today = todayIST();
    const date = String(b.date || '').trim();
    // Two failures, two messages: "2026-02-31" IS in YYYY-MM-DD form, so telling
    // the storekeeper it is not would send them looking for a typo that is not
    // there. Say which day does not exist.
    if (!isDate(date)) {
      return Response.json({
        error: /^\d{4}-\d{2}-\d{2}$/.test(date)
          ? `${date} is not a real date — there is no such day on the calendar.`
          : 'date must be YYYY-MM-DD.',
      }, { status: 400 });
    }
    // A petty-cash movement is a physical event that has already happened. A
    // future date would put money in the headline balance that the box does not
    // hold yet — and the headline is deliberately unbounded by date.
    if (date > today) return Response.json({ error: `Cannot record a movement dated ${date} — that is in the future. Cash is recorded when it moves.` }, { status: 400 });

    // ── direction ───────────────────────────────────────────────────────────
    const direction = String(b.direction || '').trim().toLowerCase() as PettyDirection;
    if (direction !== 'in' && direction !== 'out') {
      return Response.json({ error: "direction must be 'in' (cash received) or 'out' (cash paid)." }, { status: 400 });
    }

    // ── category (REQUIRED — an unlabelled movement is how cash goes missing) ─
    const category = String(b.category || '').trim();
    if (!category) return Response.json({ error: 'Pick a category — an unlabelled cash movement cannot be reconciled later.' }, { status: 400 });
    const def = categoryDef(category);
    if (!def) {
      return Response.json({ error: `Unknown category "${category}". Use one of: ${PETTY_CATEGORIES.map(c => c.key).join(', ')}.` }, { status: 400 });
    }
    if (!def.allows.includes(direction)) {
      return Response.json({
        error: `"${def.label}" can only be recorded as ${def.allows.map(d => d === 'in' ? 'cash IN' : 'cash OUT').join(' or ')}.`,
      }, { status: 400 });
    }
    if (def.managementOnly) {
      const adj = await pettyCashAdjustGate();
      if (adj !== 'ok') {
        return Response.json({
          error: 'Only Management can record an adjustment — it moves cash with no counterparty. Ask a manager to post it.',
        }, { status: 403 });
      }
    }

    // ── amount (POSITIVE, direction carries the sign) ───────────────────────
    if (b.amount === '' || b.amount === null || b.amount === undefined) {
      return Response.json({ error: 'Enter an amount.' }, { status: 400 });
    }
    // Only a number or a numeric string is an amount. Without this, Number()
    // coerces JSON that is not a figure at all into one — `true` becomes ₹1.00
    // and `[5]` becomes ₹5.00 — and the ledger records a payment nobody typed.
    if (typeof b.amount !== 'number' && typeof b.amount !== 'string') {
      return Response.json({ error: 'amount must be a number.' }, { status: 400 });
    }
    const amount = Number(b.amount);
    if (!Number.isFinite(amount)) return Response.json({ error: 'amount must be a number.' }, { status: 400 });
    if (amount < 0) {
      return Response.json({
        error: 'Amount must be positive — the direction carries the sign. To record cash going out, use direction "out" with a positive amount.',
      }, { status: 400 });
    }
    if (amount === 0) return Response.json({ error: 'Amount must be more than zero — a ₹0 movement records nothing.' }, { status: 400 });
    const paise = toPaise(amount);
    if (Math.abs(amount * 100 - paise) > 1e-6) {
      return Response.json({ error: 'Amount cannot be finer than a paisa (2 decimal places).' }, { status: 400 });
    }
    if (paise <= 0) return Response.json({ error: 'Amount must be more than zero.' }, { status: 400 });
    if (paise > MAX_PAISE) {
      return Response.json({ error: 'That is over ₹10,00,000 for a single petty-cash entry — check for an extra zero, or split it into real movements.' }, { status: 400 });
    }

    // ── free text ───────────────────────────────────────────────────────────
    const vendor    = String(b.vendor    ?? '').trim().slice(0, 200);
    const reference = String(b.reference ?? '').trim().slice(0, 120);
    const notes     = String(b.notes     ?? '').trim().slice(0, 500);

    const db = getDb();
    const outletId = await getCurrentOutletId();

    // ── optional tie to a recorded purchase LINE ────────────────────────────
    // Kept API-only and validated. NOTE for whoever wires a picker later:
    // `purchases` rows are per-MATERIAL lines, not bills, so one purchase_id
    // cannot honestly represent a cash payment against a multi-line vendor bill.
    // The bill number belongs in `reference`, which is what the cash box is
    // reconciled against.
    let purchaseId: string | null = null;
    if (b.purchase_id) {
      purchaseId = String(b.purchase_id).trim();
      const exists = db.prepare('SELECT id FROM purchases WHERE id = ?').get(purchaseId);
      if (!exists) return Response.json({ error: 'purchase_id does not match a recorded purchase.' }, { status: 400 });
    }

    const id = generateId();
    // Held on an object, not two `let`s: the transaction body is a closure, and a
    // narrowed `let` assigned only inside it reads as `never` afterwards.
    const outcome: { refusal?: string; duplicate?: string } = {};

    const txn = db.transaction(() => {
      // DOUBLE-SUBMIT GUARD: a second click on "Record" is a second real payment
      // out of the box. Same date + direction + amount + category + vendor +
      // reference inside 90 seconds is refused unless the user confirms it truly
      // happened twice. Correctness note: this only ever blocks a WRITE, so a
      // false positive costs one extra click, never a lost row.
      if (!b.confirm_duplicate) {
        const dup = db.prepare(`
          SELECT id, created_at FROM petty_cash_ledger
           WHERE date = ? AND direction = ? AND category = ?
             AND CAST(ROUND(amount * 100) AS INTEGER) = ?
             AND vendor = ? AND reference = ?
             AND created_at >= datetime('now', '-90 seconds')
           LIMIT 1
        `).get(date, direction, category, paise, vendor, reference) as { id: string } | undefined;
        if (dup) {
          outcome.duplicate = 'An identical movement was recorded moments ago. If the cash really moved twice, submit again to confirm.';
          return;
        }
      }

      // NEGATIVE-CASH GUARD, inside the transaction so the balance it read cannot
      // change between the check and the insert. See the .immediate() below for
      // why the transaction has to hold the WRITE lock while it reads.
      const guard = guardOutflow(db, outletId, date, direction, paise);
      if (!guard.ok) { outcome.refusal = guard.message; return; }

      db.prepare(`
        INSERT INTO petty_cash_ledger
          (id, outlet_id, date, direction, amount, category, purchase_id, vendor, reference, notes, recorded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, outletId, date, direction, toRupees(paise), category, purchaseId, vendor, reference, notes, me.email);

      logAuditEvent(db, {
        event_type: 'petty_cash.record',
        entity_type: 'petty_cash_ledger',
        entity_id: id,
        actor_email: me.email,
        outlet_id: outletId,
        after: { date, direction, amount: toRupees(paise), category, vendor, reference, notes, purchase_id: purchaseId },
        note: `${direction === 'in' ? 'Cash in' : 'Cash out'} ₹${toRupees(paise).toFixed(2)} — ${def.label}`,
      });
    });
    // IMMEDIATE, not the default deferred BEGIN. Both guards above are
    // read-then-write: they SELECT the balance (and the recent-duplicate window)
    // and then INSERT based on what they read. A deferred transaction takes only
    // a read lock at its first SELECT and tries to upgrade at the INSERT, so two
    // payments racing from different processes against the same file are decided
    // by SQLite after the fact — the loser aborts with SQLITE_BUSY_SNAPSHOT and
    // the storekeeper sees a 500 on a payment that was correctly refusable or
    // correctly recordable, with no way to tell which. BEGIN IMMEDIATE takes the
    // write lock BEFORE the first read, so the check and the insert are one
    // indivisible step: the second payment waits (better-sqlite3's default 5s
    // busy timeout), then re-reads a balance that already includes the first.
    // A cash box cannot be overdrawn by two people clicking at the same moment.
    txn.immediate();

    if (outcome.duplicate) return Response.json({ error: outcome.duplicate, duplicate: true }, { status: 409 });
    if (outcome.refusal)   return Response.json({ error: outcome.refusal, insufficient_cash: true }, { status: 400 });

    const entry = db.prepare('SELECT * FROM petty_cash_ledger WHERE id = ?').get(id);
    return Response.json({
      entry,
      cash_in_hand: toRupees(cashInHandPaise(db, outletId)),
    }, { status: 201 });
  } catch (e: any) {
    // LOCK CONTENTION IS NOT A CRASH, AND THE ANSWER MUST BE UNAMBIGUOUS.
    // If BEGIN IMMEDIATE could not get the write lock within the busy timeout the
    // transaction never opened, so NOTHING was written. Saying so plainly matters
    // more here than anywhere else in the app: a storekeeper who reads a bare
    // "database is locked" cannot tell whether the cash left the box on paper or
    // not, and the safe-looking move — pressing Record again — is exactly how a
    // payment gets entered twice. 503 + "not recorded, press Record again".
    const msg = String(e?.message || '');
    if (/SQLITE_BUSY|database is locked|database table is locked/i.test(msg)) {
      return Response.json({
        error: 'Someone else was recording a cash movement at the same moment, so this one was NOT recorded. Nothing has changed in the cash box — press Record again.',
        retry: true,
      }, { status: 503 });
    }
    return Response.json({ error: e?.message || 'Could not record the movement.' }, { status: 500 });
  }
}
