import type Database from 'better-sqlite3';

/**
 * THE department stock rail. One table, one writer, one derivation.
 *
 * ── THE ONE THING TO READ BEFORE TOUCHING THIS FILE ────────────────────────
 * department_materials.on_hand is a CACHE. The SUM of signed
 * department_material_transactions.quantity is the TRUTH. They must NEVER be
 * added together, and no guard, report or screen may make a decision from the
 * cache. The cache exists because /api/department-materials and the party
 * reconcile route already read it and must not break; it is maintained here so
 * it stays honest, and /api/department-ledger/check asserts cache == sum so
 * drift is visible instead of silent.
 *
 * If you ever find yourself writing `on_hand + something`, stop: that is the
 * two-truths bug this module exists to prevent, and it is the same shape as the
 * warning issue-stock.ts:446-450 has been carrying in prose.
 *
 * ── WHY THIS MODULE IS THE ONLY PLACE THAT KNOWS THE BALANCE ───────────────
 * Before the deduct-at-issue cutover the app had TWO department balances: a
 * derivation in dept-stock.ts (latest closing count + issues re-read out of
 * requisition_items) and an unused running total in department_materials that
 * three writers touched. Two derivations of one number is how a kitchen ends up
 * holding 4,000 g on one screen and -1,000 g on another. So:
 *
 *   - postDeptLedger()  is the ONLY writer of department stock.
 *   - deptOnHand()      is the ONLY definition of a department balance.
 *
 * computeDeptStock() in dept-stock.ts currently carries its own inline copy of
 * this arithmetic (written in parallel with this file). The two are kept
 * DELIBERATELY IDENTICAL — same anchor rule, same IST day-end, same cutover
 * floor, same strict `>` window — and the intended end state is that
 * computeDeptStock calls deptOnHandBulk() instead. Until it does, ANY change to
 * the arithmetic below must be made in both files in the same commit. See
 * "THE SHARED TIME BASIS" below for the one place they differ on purpose.
 *
 * ── UNITS ──────────────────────────────────────────────────────────────────
 * Every quantity in this file is RECIPE units (raw_materials.unit — g/ml),
 * matching party-fulfillment.ts and current_stock. Callers holding a
 * requisition LINE quantity must convert with lineFactor()/packFactor() BEFORE
 * calling in. This module never converts; it cannot see the line's unit and
 * guessing is the 750x PICKLED GINGER class of error.
 *
 * ── TRANSACTIONS ───────────────────────────────────────────────────────────
 * Nothing here opens a transaction, exactly like applyIssueDelta(). Call inside
 * your own db.transaction() so the ledger row, the cache update and your own
 * writes roll back together. A throw from here is DESIGNED to roll your
 * transaction back — see assertReversible().
 *
 * ── THREE RULES A FUTURE ENGINEER WILL WANT TO "SIMPLIFY". DO NOT ──────────
 *  1. THE UNMAPPED-STATION SKIP. resolveStationDepartment() returns null for a
 *     station nobody has mapped, and the consumption is then recorded as a SKIP
 *     rather than debited from a guessed kitchen. There is no parent-department
 *     fallback and no "kitchen" default on purpose: 'kitchen' is the sentinel
 *     kot-fire.ts writes for a station-less line AND the name of the real main
 *     kitchen department, so a fallback would quietly bill the busiest kitchen
 *     in the building for every mis-tagged item. Not deducting is visible;
 *     deducting from the wrong kitchen is not.
 *  2. THE NEGATIVE-BALANCE GUARD. assertReversible() THROWS, it does not clamp.
 *     A caller that really reverses lowers quantity_issued BEFORE asking us —
 *     store-issue's 'undo' branch zeroes it, store-process rewrites it absolutely
 *     — so a silent clamp would commit a line reading less issued than the grams
 *     that actually came back to the store. A throw rolls that caller's
 *     transaction back.
 *     WHAT IS NO LONGER TRUE: "every reversal caller writes quantity_issued = 0".
 *     The store-reject now KEEPS what was physically handed over and cancels only
 *     the outstanding balance, so a reject on a part-issued line is zero-delta and
 *     returns at issue-stock.ts's zero-delta gate without ever reaching this rail.
 *     That is not a reason to weaken the guard — 'undo' is the path it protects,
 *     and 'undo' still zeroes the column.
 *  3. THE LIQUOR CARVE-OUT. Store-mapped materials (TGBCL / store_stock_ledger)
 *     never reach this rail — the CALLER skips both the central debit and the
 *     department credit and stamps the ledger row's skip reason. Do not add a
 *     store-mapped branch here: two rails claiming one bottle is exactly the
 *     double-count this whole cutover exists to remove. This module deliberately
 *     does NOT re-check centralFlowBlock(), because a refusal thrown from here
 *     would roll back a legitimate issue instead of merely skipping the credit.
 */

const EPS = 1e-9;

/** 6dp, the house rounding — same as issue-stock.ts, so the two rails' numbers
 *  compare exactly instead of drifting apart in the 15th decimal. */
function r6(n: number): number {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

/**
 * Local id, NOT generateId() from '@/lib/db'.
 *
 * db.ts's applyDeduct imports THIS module, so importing back from db.ts makes a
 * cycle. It resolves at runtime today (function declarations hoist, calls happen
 * later) but it is a live grenade for whoever next adds module-level work to
 * db.ts. generateId() is `crypto.randomUUID()` and nothing more — db.ts:4553.
 */
function newId(): string {
  return crypto.randomUUID();
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE SHARED TIME BASIS  (must stay byte-compatible with dept-stock.ts)
 *
 * Ledger writers use UTC. datetime('now') gives 'YYYY-MM-DD HH:MM:SS';
 * postDeptLedger() writes the same shape with milliseconds appended.
 * closing_stock.date is an IST BUSINESS date. Every comparison therefore
 * happens on a normalised 19-char UTC string. Comparing a raw ISO 'T' stamp
 * against a raw ledger stamp is the trap: 'T' (0x54) > ' ' (0x20), so the
 * mismatch silently shifts a whole day's movements.
 * ──────────────────────────────────────────────────────────────────────────*/

/** The normaliser, in SQL. Behaviourally identical to normTs() below. */
const LEDGER_TS_SQL = `REPLACE(SUBSTR(created_at, 1, 19), 'T', ' ')`;

/** 'YYYY-MM-DD HH:MM:SS'. A bare date means the START of that day — a floor
 *  must not swallow the day it names. '' for junk, which every caller reads as
 *  "no bound". */
function normTs(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 00:00:00`;
  return s.slice(0, 19).replace('T', ' ');
}

/** End of an IST business day in the ledger's UTC basis. 23:59:59 IST =
 *  18:29:59 UTC the SAME calendar day (IST = UTC+5:30), so no date rollover.
 *  '<date> 23:59:59' would be 5.5 hours late and would quietly swallow every
 *  late-night issue made after the count. */
function istDayEndUtc(date: string): string {
  return `${String(date || '').slice(0, 10)} 18:29:59`;
}

/**
 * Written with MILLISECONDS, unlike datetime('now').
 *
 * The balance window is a strict `>` against the anchor, so at one-second
 * resolution every movement posted in the same second as the cutover opening
 * row would be silently dropped — a kitchen's first minute of trading, gone.
 * The fractional form is a strict string extension of the second-resolution
 * rows the party rail writes, and the 19-char normaliser above truncates it
 * away for comparison, so it is compatible in both directions. Ordering INSIDE
 * a single second is carried by rowid (see sumMovements).
 */
function nowMs(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE TYPE VOCABULARY
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * The ten canonical department movement types and their SIGN CONTRACT.
 *
 * THE SIGN IS WHAT THE BALANCE SUMS. THE TYPE IS WHAT THE AUDIT READS. Those
 * are two different jobs and confusing them is the live bug this vocabulary
 * fixes: creditDepartment() used to write type='issued' with a NEGATIVE
 * quantity for a reversal (issue-stock.ts:477), so any report grouping by type
 * or summing ABS(quantity) read a reversal as an issue. Hence `issue_reversal`.
 *
 * sign '+' = into the department, '-' = out of it, '±' = either (a signed
 * correction). postDeptLedger() refuses a quantity whose sign contradicts the
 * type, so a mis-signed row cannot enter the table at all.
 *
 * The four strings that already exist in production code are kept VERBATIM —
 * 'received' / 'consumed' / 'returned' / 'issued' are written by
 * party-fulfillment.ts and department-materials/reconcile, and renaming them
 * would strand the party rail.
 */
export const DEPT_TXN_TYPES = {
  /** Cutover count. Admin action, once per (department, material). The anchor
   *  every balance is measured from. Written only by /api/department-ledger/cutover. */
  opening: { sign: '+', rail: 'cutover', doc: 'Cutover opening count' },
  /** Requisition issue from the central store. Positive, ALWAYS — a reversal is
   *  its own type below, never a negative 'issued'. */
  issued: { sign: '+', rail: 'requisition', doc: 'Issued from central store' },
  /** Undo / store_reject of an issue: the goods go back to central. */
  issue_reversal: { sign: '-', rail: 'requisition', doc: 'Issue reversed back to central' },
  /** Recipe consumption at KOT complete / complimentary / non-chargeable. */
  consumption: { sign: '-', rail: 'sales', doc: 'Recipe consumption at KOT completion' },
  /** Spoilage the DEPARTMENT holds. Central spoilage keeps debiting central —
   *  wastages.department_id NULL means the store found it on its own shelf. */
  wastage: { sign: '-', rail: 'wastage', doc: 'Spoilage written off by the department' },
  /** Staff meal cooked from department stock. */
  staff_meal: { sign: '-', rail: 'staff_meal', doc: 'Staff meal from department stock' },
  /** Party fulfilment transfer in. PARTY RAIL — owned by party-fulfillment.ts. */
  received: { sign: '+', rail: 'party', doc: 'Party fulfilment transfer in' },
  /** Party post-event usage. PARTY RAIL. */
  consumed: { sign: '-', rail: 'party', doc: 'Party post-event consumption' },
  /** Party leftovers returned to the store. PARTY RAIL. */
  returned: { sign: '-', rail: 'party', doc: 'Party leftovers returned to store' },
  /** A department sent goods back to the central store on an ACCEPTED return
   *  ticket (reqs 76/77). Written only by acceptInternalReturnLine() in
   *  src/lib/return-stock.ts, and only at Store Verify — never on raise, never
   *  on HOD approval, never on any reject.
   *
   *  IT IS ITS OWN TYPE FOR A REASON. The obvious reuses are both wrong:
   *    · 'returned' is the PARTY rail, and /api/admin/reset credits central for
   *      SUM(quantity) over ('received','consumed','returned') — a store return
   *      typed that way would be credited to central a SECOND time on a reset,
   *      inventing stock that does not exist.
   *    · 'issue_reversal' means "the issue itself was undone", which changes
   *      what the requisition says was issued. A return is a NEW event: the
   *      issue stands, and some of it came back later.
   *  Do not collapse this into either of them. */
  store_return: { sign: '-', rail: 'returns', doc: 'Returned from department to central store' },
  /** Signed correction: an approved department variance count, or the Unit Audit
   *  pack-factor rebase. Never rewrite a historical row to correct a balance —
   *  post one of these, so the reason stays on the record. */
  adjustment: { sign: '±', rail: 'correction', doc: 'Approved correction / unit rebase' },
} as const;

export type DeptTxnType = keyof typeof DEPT_TXN_TYPES;

/**
 * Legacy spelling. The db.ts:1237 schema comment lists 'adjusted' and no code
 * has ever written it (both tables were empty at the cutover), but a reader
 * must not choke if one turns up. Accepted on READ, never written.
 */
const LEGACY_TYPE_ALIASES: Record<string, DeptTxnType> = { adjusted: 'adjustment' };

/** Is this a type this module recognises (canonical or legacy)? */
export function isDeptTxnType(t: string): boolean {
  return t in DEPT_TXN_TYPES || t in LEGACY_TYPE_ALIASES;
}

/* ────────────────────────────────────────────────────────────────────────────
 * SCHEMA TOLERANCE
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * req_item_id / order_item_id / station / source are ADDITIVE columns added by
 * the guarded PRAGMA block in db.ts. They carry the audit trail, not the
 * balance. If a database has not run that block yet (a stale deploy, a restored
 * backup, a test fixture), the row must still be written WITHOUT them rather
 * than aborting a KOT completion or a store issue — the balance stays correct,
 * only the trace is thinner. Probed once per Database handle.
 */
const traceColsCache = new WeakMap<object, Set<string>>();
function traceCols(db: Database.Database): Set<string> {
  const hit = traceColsCache.get(db as unknown as object);
  if (hit) return hit;
  const found = new Set<string>();
  try {
    const cols = db.prepare('PRAGMA table_info(department_material_transactions)').all() as Array<{ name: string }>;
    for (const c of cols) found.add(String(c.name));
  } catch { /* table missing entirely — the INSERT below will surface it */ }
  traceColsCache.set(db as unknown as object, found);
  return found;
}

function tableExists(db: Database.Database, name: string): boolean {
  try {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
  } catch { return false; }
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE WRITER
 * ──────────────────────────────────────────────────────────────────────────*/

export interface DeptLedgerPost {
  departmentId: string;
  materialId: string;
  type: DeptTxnType;
  /** SIGNED, in RECIPE units. Positive = into the department. Never zero. */
  quantity: number;
  outletId?: string | null;
  /** Requisition id, order id, count-sheet id — whatever this movement answers to. */
  referenceId?: string | null;
  /** Ties an issue and its reversal to the SAME requisition line, so the
   *  reversal cap is a per-line question and not a per-material one. */
  reqItemId?: string | null;
  /** Ties a consumption row to the exact sold line — the link issue-log.ts:115-118
   *  says does not exist. */
  orderItemId?: string | null;
  /** The station that RESOLVED the department, recorded so an owner can audit
   *  the mapping decision after the fact. */
  station?: string | null;
  /** The route that wrote the row. Audit only. */
  source?: string;
  notes?: string;
  user?: string;
  eventName?: string;
  eventDate?: string;
}

export interface DeptLedgerPostResult {
  id: string;
  /** The rounded signed quantity as stored. */
  quantity: number;
  /** The cache value after this write. DISPLAY ONLY — never decide from it. */
  cacheOnHand: number;
  createdAt: string;
}

/**
 * THE ONLY WRITER of department stock. Inserts the ledger row and updates the
 * department_materials.on_hand cache as one pair.
 *
 * REFUSES (throws — you are inside the caller's transaction, so it rolls back):
 *   - a zero / non-finite quantity. A zero-quantity movement is either a bug or
 *     a no-op the caller should have gated; writing it teaches the audit that a
 *     department received nothing, which is noise the owner's log cannot use.
 *     (applyIssueDelta gates zero deltas FIRST for exactly this reason.)
 *   - an unknown type.
 *   - a sign that contradicts the type — a negative 'issued', a positive
 *     'consumption'. This is the guard that stops the old
 *     negative-issued-means-reversal habit from coming back.
 *   - a blank department or material id.
 *
 * It does NOT check store-mapping (liquor) or resolve stations. Those are the
 * caller's decisions and are documented in rules 1 and 3 of the header.
 */
export function postDeptLedger(db: Database.Database, p: DeptLedgerPost): DeptLedgerPostResult {
  const deptId = String(p.departmentId || '').trim();
  const matId = String(p.materialId || '').trim();
  if (!deptId) throw new Error('postDeptLedger: departmentId is required');
  if (!matId) throw new Error('postDeptLedger: materialId is required');

  const spec = DEPT_TXN_TYPES[p.type];
  if (!spec) throw new Error(`postDeptLedger: unknown type '${String(p.type)}'`);

  const qty = r6(Number(p.quantity));
  if (!Number.isFinite(qty)) throw new Error('postDeptLedger: quantity must be a finite number');
  if (Math.abs(qty) < EPS) {
    throw new Error(`postDeptLedger: refusing a zero-quantity '${p.type}' movement (dept ${deptId}, material ${matId})`);
  }
  if (spec.sign === '+' && qty < 0) {
    throw new Error(
      `postDeptLedger: '${p.type}' must be POSITIVE (goods into the department); got ${qty}. ` +
      `A reversal of an issue is type 'issue_reversal', not a negative 'issued'.`,
    );
  }
  if (spec.sign === '-' && qty > 0) {
    throw new Error(
      `postDeptLedger: '${p.type}' must be NEGATIVE (goods leaving the department); got ${qty}.`,
    );
  }

  const outletId = p.outletId || null;
  const createdAt = nowMs();

  // ── the cache, maintained (never read for a decision) ────────────────────
  const existing = db.prepare(
    'SELECT id, on_hand FROM department_materials WHERE department_id = ? AND material_id = ?',
  ).get(deptId, matId) as { id: string; on_hand: number } | undefined;

  let cacheOnHand: number;
  if (existing) {
    cacheOnHand = r6((Number(existing.on_hand) || 0) + qty);
    db.prepare(`UPDATE department_materials SET on_hand = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(cacheOnHand, existing.id);
  } else {
    cacheOnHand = qty;
    db.prepare(`
      INSERT INTO department_materials (id, outlet_id, department_id, material_id, on_hand, updated_at)
      VALUES (?,?,?,?,?, datetime('now'))
    `).run(newId(), outletId, deptId, matId, cacheOnHand);
  }

  // ── the ledger row: the truth ────────────────────────────────────────────
  // balance_after is written for the audit view's convenience ONLY. It is
  // unreliable the moment two writers interleave, and a running-balance column
  // read as truth is the classic way a second balance appears. Nothing in this
  // codebase may SELECT it to decide anything.
  const cols = traceCols(db);
  const names = [
    'id', 'outlet_id', 'department_id', 'material_id', 'type', 'quantity',
    'balance_after', 'reference_id', 'event_name', 'event_date', 'notes', 'user', 'created_at',
  ];
  const vals: Array<string | number | null> = [
    newId(), outletId, deptId, matId, p.type, qty,
    cacheOnHand, p.referenceId || null, p.eventName || '', p.eventDate || '',
    p.notes || '', p.user || '', createdAt,
  ];
  const addTrace = (col: string, v: string | null) => {
    if (cols.size === 0 || cols.has(col)) { names.push(col); vals.push(v); }
  };
  addTrace('req_item_id', p.reqItemId || null);
  addTrace('order_item_id', p.orderItemId || null);
  addTrace('station', p.station ? String(p.station).trim().toLowerCase() : null);
  addTrace('source', p.source || null);

  db.prepare(
    `INSERT INTO department_material_transactions (${names.join(', ')}) VALUES (${names.map(() => '?').join(',')})`,
  ).run(...vals);

  return { id: String(vals[0]), quantity: qty, cacheOnHand, createdAt };
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE BALANCE
 * ──────────────────────────────────────────────────────────────────────────*/

export type DeptAnchorSource = 'count' | 'opening' | 'none';

export interface DeptOnHandResult {
  /** RECIPE units. NULL — never 0 — when the pair was never counted. */
  onHand: number | null;
  /** The anchor quantity: the closing count, or the cutover opening row. */
  anchorQty: number | null;
  /** The anchor's own normalised timestamp. */
  anchorAt: string | null;
  anchorSource: DeptAnchorSource;
  /** MAX(anchorAt, cutover floor) — where the movement window actually starts.
   *  Differs from anchorAt only when a count is backdated past the cutover. */
  windowFrom: string;
  /** No closing count AND no opening row. onHand is NULL and the UI must say
   *  "not counted yet" — NOT "0", and NOT a rolling receipts window. */
  neverCounted: boolean;
  /** Signed sum of ledger movements inside the window. Informational even when
   *  neverCounted, so a screen can show activity without claiming a balance. */
  movementsSince: number;
  /** department_materials.on_hand as it currently stands. FOR DRIFT CHECKS
   *  ONLY — never add it to anything. */
  cacheOnHand: number;
}

interface AnchorPick {
  qty: number;
  at: string;
  source: 'count' | 'opening';
  /** Only for an 'opening' anchor: excludes the anchor row itself from the
   *  window without relying on timestamp resolution. */
  rowid: number | null;
}

/**
 * THE definition of a department balance. Per SINGLE department — a main-dept
 * roll-up must call this per (sub-dept, material) and SUM the results, never
 * re-anchor across the set (that collapses every sub-dept's own count into one,
 * which is what computeDeptStock takes care to avoid).
 *
 *   anchor      = the LATER of the newest closing count and the cutover
 *                 `opening` row. A tie goes to the COUNT: a recount is the
 *                 owner's only tool for correcting drift, so it must be able to
 *                 re-base over the cutover, never the other way round.
 *   count time  = MIN(IST day-end of the count date, when it was saved). MIN,
 *                 not MAX, and both directions of getting it wrong lose real
 *                 movement: a same-day count typed at 3pm must not swallow the
 *                 5pm issue that followed it, and a count for the 1st typed on
 *                 the 5th must not swallow four days of movement.
 *   window      = MAX(anchor, settings.dept_ledger_cutover_at), strict `>`.
 *   on_hand     = anchor_qty + SUM(quantity) inside the window.
 *
 * THE CUTOVER FLOOR IS NOT DECORATION. It is what makes decision D (no
 * backfill) real: a count backdated past the cutover moves the anchor back but
 * still cannot pull pre-cutover movement into the balance.
 */
export function deptOnHand(db: Database.Database, departmentId: string, materialId: string): DeptOnHandResult {
  const deptId = String(departmentId || '');
  const matId = String(materialId || '');
  const { anchor, windowFrom, tieRowid } = anchorWindow(db, deptId, matId);

  const movementsSince = sumMovements(db, deptId, matId, windowFrom, tieRowid);
  const cacheRow = db.prepare(
    'SELECT on_hand FROM department_materials WHERE department_id = ? AND material_id = ?',
  ).get(deptId, matId) as { on_hand: number } | undefined;
  const cacheOnHand = r6(Number(cacheRow?.on_hand) || 0);

  if (!anchor) {
    return {
      onHand: null, anchorQty: null, anchorAt: null, anchorSource: 'none',
      windowFrom, neverCounted: true, movementsSince, cacheOnHand,
    };
  }
  return {
    onHand: r6(anchor.qty + movementsSince),
    anchorQty: r6(anchor.qty),
    anchorAt: anchor.at,
    anchorSource: anchor.source,
    windowFrom,
    neverCounted: false,
    movementsSince,
    cacheOnHand,
  };
}

interface AnchorWindow {
  anchor: AnchorPick | null;
  /** MAX(anchor, cutover floor) — where the movement window starts. */
  windowFrom: string;
  /** Same-second tie-break, or null when it must not apply. */
  tieRowid: number | null;
}

/**
 * The anchor and its window, resolved ONCE. Everything that reads a window —
 * the balance and the consumption figure in the reversal message — goes through
 * here, so a change to the rule cannot land in one place and not the other.
 * (It already did once: the message under-reported consumption because it
 * lacked the tie-break the balance had.)
 */
function anchorWindow(db: Database.Database, deptId: string, matId: string): AnchorWindow {
  const floor = cutoverAt(db);
  const anchor = pickAnchor(latestCount(db, deptId, matId), latestOpening(db, deptId, matId));
  const windowFrom = anchor ? (anchor.at > floor ? anchor.at : floor) : floor;
  // The rowid tie-break belongs to the OPENING row only, and only when the
  // opening row is itself the window start. When the floor wins, the opening
  // row is already outside the window and a rowid arm at the floor's timestamp
  // would re-admit rows the floor is there to exclude.
  const tieRowid = anchor && anchor.source === 'opening' && windowFrom === anchor.at ? anchor.rowid : null;
  return { anchor, windowFrom, tieRowid };
}

function latestCount(db: Database.Database, deptId: string, matId: string): AnchorPick | null {
  try {
    const rows = db.prepare(`
      SELECT physical_stock, date, created_at FROM closing_stock
       WHERE department_id = ? AND material_id = ?
    `).all(deptId, matId) as Array<{ physical_stock: number; date: string; created_at: string }>;
    let best: AnchorPick | null = null;
    for (const c of rows) {
      const at = countAnchorAt(c.date, c.created_at);
      if (!best || at >= best.at) best = { qty: Number(c.physical_stock) || 0, at, source: 'count', rowid: null };
    }
    return best;
  } catch { return null; }
}

/** MIN(IST day-end of the count date, when the count was saved). See deptOnHand. */
function countAnchorAt(date: string, createdAt: string): string {
  const dayEnd = istDayEndUtc(date);
  const saved = normTs(createdAt);
  return saved && saved < dayEnd ? saved : dayEnd;
}

function latestOpening(db: Database.Database, deptId: string, matId: string): AnchorPick | null {
  try {
    const row = db.prepare(`
      SELECT rowid AS rid, quantity, ${LEDGER_TS_SQL} AS at
        FROM department_material_transactions
       WHERE department_id = ? AND material_id = ? AND type = 'opening'
       ORDER BY at DESC, rowid DESC LIMIT 1
    `).get(deptId, matId) as { rid: number; quantity: number; at: string } | undefined;
    if (!row) return null;
    return { qty: Number(row.quantity) || 0, at: String(row.at), source: 'opening', rowid: Number(row.rid) };
  } catch { return null; }
}

/** The LATER anchor wins; a tie goes to the count (see deptOnHand). */
function pickAnchor(count: AnchorPick | null, opening: AnchorPick | null): AnchorPick | null {
  if (!count) return opening;
  if (!opening) return count;
  return count.at >= opening.at ? count : opening;
}

/**
 * Signed movement inside the window. Strict `>`: the opening row IS the anchor
 * and must not also be counted as a movement on top of itself.
 *
 * The rowid arm is not belt-and-braces. Comparison happens on a 19-char
 * (one-second) string, so without it every movement posted in the same second
 * as the cutover opening — a kitchen's first minute of trading — would be
 * dropped from the balance while still sitting in the cache, and the drift
 * check would fire on day one with nothing actually wrong.
 */
function sumMovements(
  db: Database.Database, deptId: string, matId: string, windowFrom: string, tieRowid: number | null,
): number {
  try {
    const row = tieRowid == null
      ? db.prepare(`
          SELECT COALESCE(SUM(quantity), 0) AS s FROM department_material_transactions
           WHERE department_id = ? AND material_id = ? AND ${LEDGER_TS_SQL} > ?
        `).get(deptId, matId, windowFrom)
      : db.prepare(`
          SELECT COALESCE(SUM(quantity), 0) AS s FROM department_material_transactions
           WHERE department_id = ? AND material_id = ?
             AND (${LEDGER_TS_SQL} > ? OR (${LEDGER_TS_SQL} = ? AND rowid > ?))
        `).get(deptId, matId, windowFrom, windowFrom, tieRowid);
    return r6(Number((row as { s: number } | undefined)?.s) || 0);
  } catch { return 0; }
}

/** `${departmentId}|${materialId}` — the key deptOnHandBulk returns. */
export function deptKey(departmentId: string, materialId: string): string {
  return `${departmentId}|${materialId}`;
}

/**
 * Batched deptOnHand for the report routes. Same anchors, same window, same
 * arithmetic — four queries instead of 4N.
 *
 * materialIds empty/omitted = every material those departments have ever
 * counted or moved. deptIds empty = an empty map; an unbounded scan of the
 * whole ledger is never what a caller meant.
 */
export function deptOnHandBulk(
  db: Database.Database,
  deptIds: string[],
  materialIds?: string[],
): Map<string, DeptOnHandResult> {
  const out = new Map<string, DeptOnHandResult>();
  const depts = (deptIds || []).map((d) => String(d || '')).filter(Boolean);
  if (depts.length === 0) return out;
  const deptJson = JSON.stringify(depts);
  const mats = (materialIds || []).map((m) => String(m || '')).filter(Boolean);
  const matJson = JSON.stringify(mats);
  const matFilter = mats.length > 0 ? 'AND material_id IN (SELECT value FROM json_each(?))' : '';
  const matParams = mats.length > 0 ? [matJson] : [];
  const floor = cutoverAt(db);

  // 1) anchor candidate: closing counts, per (dept, material).
  const anchors = new Map<string, AnchorPick>();
  const put = (k: string, a: AnchorPick) => {
    const cur = anchors.get(k);
    if (!cur || a.at > cur.at || (a.at === cur.at && a.source === 'count')) anchors.set(k, a);
  };
  try {
    const rows = db.prepare(`
      SELECT department_id, material_id, physical_stock, date, created_at
        FROM closing_stock
       WHERE department_id IN (SELECT value FROM json_each(?)) ${matFilter}
    `).all(deptJson, ...matParams) as Array<{ department_id: string; material_id: string; physical_stock: number; date: string; created_at: string }>;
    for (const r of rows) {
      put(deptKey(r.department_id, r.material_id), {
        qty: Number(r.physical_stock) || 0, at: countAnchorAt(r.date, r.created_at), source: 'count', rowid: null,
      });
    }
  } catch { /* closing_stock unreadable — fall through to openings */ }

  // 2) anchor candidate: the cutover opening row. The count wins a tie.
  try {
    const rows = db.prepare(`
      SELECT rowid AS rid, department_id, material_id, quantity, ${LEDGER_TS_SQL} AS at
        FROM department_material_transactions
       WHERE type = 'opening' AND department_id IN (SELECT value FROM json_each(?)) ${matFilter}
       ORDER BY at ASC, rowid ASC
    `).all(deptJson, ...matParams) as Array<{ rid: number; department_id: string; material_id: string; quantity: number; at: string }>;
    for (const r of rows) {
      put(deptKey(r.department_id, r.material_id), {
        qty: Number(r.quantity) || 0, at: String(r.at), source: 'opening', rowid: Number(r.rid),
      });
    }
  } catch { /* ledger unreadable — every pair reads never_counted, which is honest */ }

  // 3) every movement for the pairs, summed in JS against each pair's own
  //    window. One pass; the department ledger starts empty at the cutover, so
  //    this stays small for a long time. If it ever does not, push the window
  //    into a CTE — but keep ONE implementation of the arithmetic.
  const sums = new Map<string, number>();
  const cache = new Map<string, number>();
  try {
    const rows = db.prepare(`
      SELECT rowid AS rid, department_id, material_id, quantity, ${LEDGER_TS_SQL} AS at
        FROM department_material_transactions
       WHERE department_id IN (SELECT value FROM json_each(?)) ${matFilter}
    `).all(deptJson, ...matParams) as Array<{ rid: number; department_id: string; material_id: string; quantity: number; at: string }>;
    for (const r of rows) {
      const k = deptKey(r.department_id, r.material_id);
      const a = anchors.get(k) || null;
      const windowFrom = a ? (a.at > floor ? a.at : floor) : floor;
      const tieRowid = a && a.source === 'opening' && windowFrom === a.at ? a.rowid : null;
      const at = String(r.at);
      const inWindow = at > windowFrom || (tieRowid != null && at === windowFrom && Number(r.rid) > tieRowid);
      if (!inWindow) continue;
      sums.set(k, (sums.get(k) || 0) + (Number(r.quantity) || 0));
    }
  } catch { /* no ledger rows readable */ }

  try {
    const rows = db.prepare(`
      SELECT department_id, material_id, on_hand FROM department_materials
       WHERE department_id IN (SELECT value FROM json_each(?)) ${matFilter}
    `).all(deptJson, ...matParams) as Array<{ department_id: string; material_id: string; on_hand: number }>;
    for (const r of rows) cache.set(deptKey(r.department_id, r.material_id), Number(r.on_hand) || 0);
  } catch { /* cache unreadable — the drift check simply reports 0 */ }

  for (const k of new Set<string>([...anchors.keys(), ...sums.keys(), ...cache.keys()])) {
    const a = anchors.get(k) || null;
    const movementsSince = r6(sums.get(k) || 0);
    const cacheOnHand = r6(cache.get(k) || 0);
    const windowFrom = a ? (a.at > floor ? a.at : floor) : floor;
    out.set(k, a
      ? {
        onHand: r6(a.qty + movementsSince), anchorQty: r6(a.qty), anchorAt: a.at,
        anchorSource: a.source, windowFrom, neverCounted: false, movementsSince, cacheOnHand,
      }
      : {
        onHand: null, anchorQty: null, anchorAt: null, anchorSource: 'none',
        windowFrom, neverCounted: true, movementsSince, cacheOnHand,
      });
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * STATION -> DEPARTMENT
 * ──────────────────────────────────────────────────────────────────────────*/

export type StationResolveReason = '' | 'blank' | 'unmapped' | 'inactive';

export interface StationResolution {
  /** NULL unless an ACTIVE mapping to an EXISTING department was found. */
  departmentId: string | null;
  reason: StationResolveReason;
  /** The normalised station key that was looked up. */
  station: string;
}

/**
 * The station -> department lookup, and the ONLY one. Owner-configurable in
 * Settings (table station_departments), seeded one-shot from exact department
 * UUIDs because the names do not match: 'Akan  Indian' carries TWO spaces,
 * 'Akan Tandoori' does not string-match station 'tandoor', 'Akan - Bakery' is
 * hyphenated. A name-based lookup silently maps half the kitchens to nothing.
 *
 * NEVER GUESSES. Returns null with a reason for:
 *   blank     — the line carried no station at all.
 *   unmapped  — nobody has mapped it (sushi, terracegrill), or the mapping
 *               points at a department that no longer exists, or the mapping
 *               table has not been created yet. 'kitchen' is deliberately left
 *               unmapped: it is kot-fire.ts's blank-station sentinel as well as
 *               a real department name, so mapping it would debit the main
 *               kitchen for every station-less item in the building. 'liquor'
 *               is deliberately left unmapped too — liquor lives on the TGBCL
 *               store rail (header rule 3).
 *   inactive  — mapped, but the owner switched it off.
 *
 * There is no parent-department fallback and no default. A caller that gets
 * null must SKIP the deduction and call recordConsumptionSkip() so the gap is
 * visible on screen. Deducting the wrong kitchen silently is worse than not
 * deducting: an unexplained debit reads as theft on the very report this rail
 * exists to produce.
 */
export function resolveStationDepartment(db: Database.Database, station: string | null | undefined): StationResolution {
  const key = String(station ?? '').trim().toLowerCase();
  if (!key) return { departmentId: null, reason: 'blank', station: '' };

  let row: { department_id: string | null; is_active: number; dept_exists: number } | undefined;
  try {
    row = db.prepare(`
      SELECT sd.department_id,
             COALESCE(sd.is_active, 1) AS is_active,
             (SELECT COUNT(*) FROM departments d WHERE d.id = sd.department_id) AS dept_exists
        FROM station_departments sd
       WHERE lower(trim(sd.station)) = ?
       LIMIT 1
    `).get(key) as typeof row;
  } catch {
    // Table absent (migration not yet applied) — fail CLOSED. An unmapped
    // station skips the deduction; it must never fall back to a guess.
    return { departmentId: null, reason: 'unmapped', station: key };
  }

  if (!row || !row.department_id) return { departmentId: null, reason: 'unmapped', station: key };
  if (!Number(row.dept_exists)) return { departmentId: null, reason: 'unmapped', station: key };
  if (!Number(row.is_active)) return { departmentId: null, reason: 'inactive', station: key };
  return { departmentId: String(row.department_id), reason: '', station: key };
}

/* ────────────────────────────────────────────────────────────────────────────
 * SKIPS
 * ──────────────────────────────────────────────────────────────────────────*/

export interface ConsumptionSkipInput {
  station: string | null | undefined;
  /** blank | unmapped | inactive | store_mapped | no_department */
  reason: string;
  materialId: string;
  /** RECIPE units that WOULD have been deducted had the station resolved. */
  quantity: number;
  orderId?: string | null;
  orderItemId?: string | null;
  menuItemId?: string | null;
  outletId?: string | null;
  source?: string;
  notes?: string;
}

/**
 * Records a consumption that could NOT be posted to a department, so the gap is
 * a visible number instead of a silence. The banner on the variance screens
 * counts these and names the stations.
 *
 * FAILS SOFT, ON PURPOSE. This is an audit breadcrumb on the KOT-completion
 * path; a missing table or a bad column must never throw and roll back a served
 * order in the middle of service. The inventory_transactions row that Variance
 * and Sales-vs-Purchase read is written by the CALLER regardless, so those
 * reports stay bit-identical whatever happens here.
 */
export function recordConsumptionSkip(db: Database.Database, s: ConsumptionSkipInput): boolean {
  try {
    if (!tableExists(db, 'consumption_skips')) return false;
    db.prepare(`
      INSERT INTO consumption_skips
        (id, outlet_id, order_id, order_item_id, menu_item_id, material_id,
         station, reason, quantity, source, notes, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      newId(), s.outletId || null, s.orderId || null, s.orderItemId || null,
      s.menuItemId || null, String(s.materialId || ''),
      String(s.station ?? '').trim().toLowerCase(), String(s.reason || 'unmapped'),
      r6(Number(s.quantity) || 0), s.source || '', s.notes || '', nowMs(),
    );
    return true;
  } catch (e) {
    console.error('[dept-ledger] consumption skip not recorded:', e);
    return false;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE CUTOVER BOUNDARY
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * When the department rail went live, normalised, or '' when the owner has not
 * run the cutover yet. Stamped ONCE by /api/department-ledger/cutover — never
 * by a boot migration, because opening balances are admin-owned state
 * (scripts/check-boot-migrations.js exists to keep deploys out of it).
 *
 * '' means "no floor", and that degrades correctly: before the cutover the
 * ledger is empty by construction (decision D — no backfill), so there is
 * nothing for a floor to hold back.
 *
 * Every "history excluded" label reads this, and it is a HARD FLOOR on the
 * balance window — not merely a label. Without the floor, one closing count
 * backdated a day before the cutover would drag months of pre-cutover movement
 * into a balance that must start clean.
 */
export function cutoverAt(db: Database.Database): string {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'dept_ledger_cutover_at'`)
      .get() as { value: string } | undefined;
    return normTs(row?.value);
  } catch { return ''; }
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE REVERSAL GUARD
 * ──────────────────────────────────────────────────────────────────────────*/

/** Thrown by assertReversible(). Routes should answer 409 with `.message`. */
export class DeptReversalBlocked extends Error {
  readonly code = 'DEPT_REVERSAL_BLOCKED';
  readonly materialId: string;
  readonly materialName: string;
  readonly departmentId: string;
  readonly departmentName: string;
  readonly requested: number;
  readonly available: number;
  readonly consumedSince: number;

  constructor(d: {
    materialId: string; materialName: string;
    departmentId: string; departmentName: string;
    requested: number; available: number; consumedSince: number; message: string;
  }) {
    super(d.message);
    this.name = 'DeptReversalBlocked';
    this.materialId = d.materialId;
    this.materialName = d.materialName;
    this.departmentId = d.departmentId;
    this.departmentName = d.departmentName;
    this.requested = d.requested;
    this.available = d.available;
    this.consumedSince = d.consumedSince;
  }
}

export function isDeptReversalBlocked(e: unknown): e is DeptReversalBlocked {
  return e instanceof DeptReversalBlocked
    || (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'DEPT_REVERSAL_BLOCKED');
}

export interface ReversalCheck {
  /** MIN(capLine, capDept) — what may be given back right now, RECIPE units. */
  available: number;
  /** What THIS requisition line actually took from central (delta_recipe_qty). */
  capLine: number;
  /** What the department still physically holds. */
  capDept: number;
  /** Consumption posted inside the window, for the message only. */
  consumedSince: number;
}

/**
 * THE NEGATIVE-BALANCE GUARD. Throws DeptReversalBlocked; it does NOT clamp.
 *
 * `qty` is the POSITIVE magnitude the caller wants to move back to central.
 *
 * TWO CAPS, both read from ledgers and neither from a cache:
 *   capLine  SUM(delta_recipe_qty) in requisition_issue_ledger for the line —
 *            what this rail actually took from central FOR THIS LINE. Undoing
 *            more than that manufactures central stock; that is the measured
 *            ALMOND bug, and it is why issue-stock.ts clamps the same sum.
 *   capDept  what the department still holds. POOLED per (department, material)
 *            BY DESIGN: without lot tracking the grams are genuinely fungible,
 *            so requisition A's consumption can legitimately block requisition
 *            B's reversal. That is physically correct — which is exactly why
 *            the message says "the department holds only X" and never "you
 *            consumed this line". Never soften it into a per-line subtraction:
 *            that would let a reversal drive the department negative.
 *
 * Before the cutover a pair has no anchor and deptOnHand reports NULL rather
 * than 0. capDept then falls back to the raw signed ledger sum, which is the
 * defensible number: whatever this rail has put in, minus what it has taken
 * out. It is never treated as 0 — that would block every legitimate same-day
 * undo — and never as unlimited.
 */
export function assertReversible(
  db: Database.Database,
  a: { reqItemId?: string | null; departmentId: string; materialId: string; qty: number },
): ReversalCheck {
  const deptId = String(a.departmentId || '');
  const matId = String(a.materialId || '');
  const requested = r6(Math.abs(Number(a.qty) || 0));

  let capLine = Number.POSITIVE_INFINITY;
  if (a.reqItemId) {
    try {
      const row = db.prepare(
        'SELECT COALESCE(SUM(delta_recipe_qty), 0) AS taken FROM requisition_issue_ledger WHERE req_item_id = ?',
      ).get(String(a.reqItemId)) as { taken: number } | undefined;
      capLine = r6(Number(row?.taken) || 0);
    } catch { capLine = Number.POSITIVE_INFINITY; }
  }

  const bal = deptOnHand(db, deptId, matId);
  const capDept = bal.neverCounted ? r6(rawLedgerSum(db, deptId, matId)) : r6(bal.onHand ?? 0);
  const available = r6(Math.min(capLine, capDept));
  // Same window as the balance, tie-break included — an under-reported figure
  // here turns a correct refusal into an unexplainable one.
  const w = anchorWindow(db, deptId, matId);
  const consumedSince = consumptionSince(db, deptId, matId, w.windowFrom, w.tieRowid);

  if (requested <= available + EPS) return { available, capLine, capDept, consumedSince };

  const materialName = lookupName(db, 'raw_materials', matId) || matId;
  const departmentName = lookupName(db, 'departments', deptId) || deptId;
  const blocker = capDept < capLine
    ? `${departmentName} holds only ${fmt(capDept)} of ${materialName}` +
      (consumedSince > EPS ? ` (${fmt(consumedSince)} has since been cooked)` : '')
    : `only ${fmt(capLine)} of ${materialName} was issued on this line`;

  throw new DeptReversalBlocked({
    materialId: matId, materialName, departmentId: deptId, departmentName,
    requested, available: Math.max(0, available), consumedSince,
    message:
      `Cannot reverse ${fmt(requested)} of ${materialName}: ${blocker}. ` +
      `Reverse ${fmt(Math.max(0, available))} or less, or record a department count first.`,
  });
}

function rawLedgerSum(db: Database.Database, deptId: string, matId: string): number {
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS s FROM department_material_transactions
       WHERE department_id = ? AND material_id = ?
    `).get(deptId, matId) as { s: number } | undefined;
    return Number(row?.s) || 0;
  } catch { return 0; }
}

/** ABS of consumption inside the window — for the message, never for the cap. */
function consumptionSince(
  db: Database.Database, deptId: string, matId: string, windowFrom: string, tieRowid: number | null,
): number {
  try {
    const row = tieRowid == null
      ? db.prepare(`
          SELECT COALESCE(SUM(quantity), 0) AS s FROM department_material_transactions
           WHERE department_id = ? AND material_id = ? AND type = 'consumption'
             AND ${LEDGER_TS_SQL} > ?
        `).get(deptId, matId, windowFrom)
      : db.prepare(`
          SELECT COALESCE(SUM(quantity), 0) AS s FROM department_material_transactions
           WHERE department_id = ? AND material_id = ? AND type = 'consumption'
             AND (${LEDGER_TS_SQL} > ? OR (${LEDGER_TS_SQL} = ? AND rowid > ?))
        `).get(deptId, matId, windowFrom, windowFrom, tieRowid);
    return r6(Math.abs(Number((row as { s: number } | undefined)?.s) || 0));
  } catch { return 0; }
}

function lookupName(db: Database.Database, table: 'raw_materials' | 'departments', id: string): string {
  try {
    const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id) as { name: string } | undefined;
    return String(row?.name || '');
  } catch { return ''; }
}

/** Recipe units, trimmed of float noise, for an operator-facing message. */
function fmt(n: number): string {
  const v = r6(n);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}
