import type Database from 'better-sqlite3';
// THE MOVEMENT RECORD (owner's eight fields, 2026-09-10). postDeptLedger is the
// ONE writer of department stock, so it is where fields 3/4/5/7/8 are filled for
// the whole department rail. Semantics live in movement-record.ts.
import {
  movementCols, orient, deptParty, SYSTEM_ACTOR_PREFIX, todayISTDate,
  type MovementParty, type MovementPartyKind,
} from './movement-record';
// THE one recipe↔purchase conversion. A LEAF (no imports at all), so this adds
// no cycle back into db.ts. Used only by the department-transfer section at the
// foot of this file, which converts a PURCHASE-unit entry ONCE, at the door.
import { packFactor, toPurchaseQty, type PackMeta } from './pack-units';

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
 * postDeptLedger and the guards open no transaction, exactly like
 * applyIssueDelta(). Call inside your own db.transaction() so the ledger row,
 * the cache update and your own writes roll back together. A throw from here is
 * DESIGNED to roll your transaction back — see assertReversible().
 * THE ONE EXCEPTION is the department-transfer section at the foot of the file
 * (postDeptTransfer / sendDeptTransfer / reverseDeptTransfer /
 * flagDeptTransferDispute / resolveDeptTransferDisputes): a transfer is TWO
 * ledger rows that must never exist one without the other, so each of those
 * wraps itself in db.transaction() —
 * IMMEDIATE standalone, a SAVEPOINT when you call it inside your own. Still
 * synchronous: never await inside any of them, or around them inside yours.
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
 * The canonical department movement types and their SIGN CONTRACT.
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
  opening: { sign: '+', rail: 'cutover', doc: 'Cutover opening count', counterparty: 'opening' },
  /** Requisition issue from the central store. Positive, ALWAYS — a reversal is
   *  its own type below, never a negative 'issued'. */
  issued: { sign: '+', rail: 'requisition', doc: 'Issued from central store', counterparty: 'central' },
  /** Undo / store_reject of an issue: the goods go back to central. */
  issue_reversal: { sign: '-', rail: 'requisition', doc: 'Issue reversed back to central', counterparty: 'central' },
  /** Recipe consumption at KOT complete / complimentary / non-chargeable. */
  consumption: { sign: '-', rail: 'sales', doc: 'Recipe consumption at KOT completion', counterparty: 'consumption' },
  /** Spoilage the DEPARTMENT holds. Central spoilage keeps debiting central —
   *  wastages.department_id NULL means the store found it on its own shelf. */
  wastage: { sign: '-', rail: 'wastage', doc: 'Spoilage written off by the department', counterparty: 'wastage' },
  /** Staff meal cooked from department stock. */
  staff_meal: { sign: '-', rail: 'staff_meal', doc: 'Staff meal from department stock', counterparty: 'staff_meal' },
  /** Party fulfilment transfer in. PARTY RAIL — owned by party-fulfillment.ts. */
  received: { sign: '+', rail: 'party', doc: 'Party fulfilment transfer in', counterparty: 'central' },
  /** Party post-event usage. PARTY RAIL. */
  consumed: { sign: '-', rail: 'party', doc: 'Party post-event consumption', counterparty: 'consumption' },
  /** Party leftovers returned to the store. PARTY RAIL. */
  returned: { sign: '-', rail: 'party', doc: 'Party leftovers returned to store', counterparty: 'central' },
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
  store_return: { sign: '-', rail: 'returns', doc: 'Returned from department to central store', counterparty: 'central' },
  /** A vendor delivery routed STRAIGHT to the department under a
   *  direct_issue_rules row (Settings → Direct Issue) — central never held it.
   *  Written only by the receiving routes / QC sign-off via
   *  src/lib/direct-issue.ts, with reference_id = the `purchases` cost-row id
   *  (which carries the matching direct_issue_dept_id stamp).
   *
   *  ITS OWN TYPE FOR THE SAME REASONS store_return is:
   *    · 'issued' is the REQUISITION rail — the issue register and the
   *      reversal cap are per-requisition-line questions, and a vendor receipt
   *      typed 'issued' would appear as a store issue that no requisition made.
   *    · 'received' is the PARTY rail, and /api/admin/reset credits central
   *      for SUM over ('received','consumed','returned') — a direct receipt
   *      typed that way would be credited to central on a reset, inventing
   *      stock central never held. po-requisition-fulfil.ts also discriminates
   *      on type='received' as its replay witness.
   *  Every balance reader sums ALL types, so this row counts everywhere
   *  without further edits; only per-type report buckets file it under their
   *  catch-all. */
  direct_receipt: { sign: '+', rail: 'purchase', doc: 'Vendor delivery routed directly to the department', counterparty: 'vendor' },
  /** The undo of a direct_receipt — a GRN void or a downward bill amendment
   *  taking back goods that were booked straight into the department. NEVER a
   *  negative 'direct_receipt' (the sign contract above), and NOT
   *  'issue_reversal' (no issue happened) or 'store_return' (nothing physically
   *  moved to central — the receipt itself is being unwound). */
  direct_receipt_reversal: { sign: '-', rail: 'purchase', doc: 'Direct vendor delivery voided or amended back out', counterparty: 'vendor' },
  /** DEPARTMENT → DEPARTMENT, the sender's leg. Kitchen received a Direct
   *  Issue delivery and hands some of it to Akan Tandoori: this row is the
   *  debit on KITCHEN's ledger. It is NEVER written alone — only
   *  postDeptTransfer() may write it, in the same synchronous transaction as
   *  its `transfer_in` twin, both carrying ONE reference_id (the
   *  department_transfer_lines.id) — postDeptLedger refuses either leg from
   *  any other caller. Central is not touched: one physical kilo leaves one
   *  department ledger and enters another, and is in exactly one of them at
   *  every instant (the NO-DOUBLE-COUNT law).
   *
   *  ITS OWN TYPE, for the same reasons store_return and direct_receipt are:
   *    · 'issued' / 'issue_reversal' are the REQUISITION rail, answer to a
   *      requisition line and feed the issue register and the reversal cap.
   *    · 'received' is the PARTY rail, which /api/admin/reset credits back to
   *      central — a transfer typed that way would invent central stock.
   *    · it is not consumption, wastage or an adjustment: the goods still exist.
   *  The counterparty is ALWAYS the other department by id (postDeptLedger
   *  refuses the bare 'department' default, which would just say "Department"). */
  transfer_out: { sign: '-', rail: 'transfer', doc: 'Handed to another department', counterparty: 'department' },
  /** DEPARTMENT → DEPARTMENT, the receiver's leg. See transfer_out. */
  transfer_in: { sign: '+', rail: 'transfer', doc: 'Received from another department', counterparty: 'department' },
  /** Signed correction: an approved department variance count, or the Unit Audit
   *  pack-factor rebase. Never rewrite a historical row to correct a balance —
   *  post one of these, so the reason stays on the record. */
  adjustment: { sign: '±', rail: 'correction', doc: 'Approved correction / unit rebase', counterparty: 'adjustment' },
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

/**
 * The two legs of a department-to-department transfer. Exported so a report
 * that buckets by type can name them instead of filing them under a catch-all.
 *
 * ⚠ NEVER ADD THESE TO A COMPANY-WIDE INFLOW TOTAL. A transfer moves stock that
 * is already inside the building: vendor → Kitchen is counted once as a
 * direct_receipt, and Kitchen → Akan Tandoori must not count again as an
 * inflow. Per-department reports may show transfer_in as that department's
 * inflow only in its OWN column, never summed with receipts across departments.
 */
export const DEPT_TRANSFER_TYPES = ['transfer_out', 'transfer_in'] as const;
export type DeptTransferType = (typeof DEPT_TRANSFER_TYPES)[number];
/** `'transfer_out', 'transfer_in'` — for an SQL `IN (...)` list. */
export const DEPT_TRANSFER_TYPES_SQL = DEPT_TRANSFER_TYPES.map((t) => `'${t}'`).join(', ');

/**
 * Set ONLY while postDeptTransfer() is writing its pair. postDeptLedger refuses
 * a transfer leg when this is 0, so a lone `transfer_out` (stock that leaves
 * one department and arrives nowhere) or a lone `transfer_in` (stock invented
 * out of thin air) cannot be written by any other caller. better-sqlite3 is
 * synchronous, so a plain counter is exact: nothing can interleave between the
 * increment and the decrement.
 */
let transferPairDepth = 0;

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
  /**
   * FIELD 8 — the responsible user. The SESSION user's email, or a
   * `system:<rail>` actor for a machine-initiated movement (the KOT-completion
   * sweep runs on a timer and has no session; writing a person's name on it
   * would be a lie). REFUSED IF BLANK — see the throw in postDeptLedger.
   * Never a client-supplied name.
   */
  user?: string;
  eventName?: string;
  eventDate?: string;
  /**
   * FIELDS 4 & 5 — THE COUNTERPARTY: the other end, the one that is not this
   * department. Omit it and the type's own DEPT_TXN_TYPES.counterparty is used,
   * which is correct for every writer in the tree today — an issue comes from
   * central, a direct receipt from a vendor, a consumption goes to the guest.
   * Pass one only when the type's default is not specific enough. REQUIRED
   * (and refused if missing) for the transfer_out / transfer_in pair, whose
   * counterparty is the other department and must be named by id — only
   * postDeptTransfer() writes those, and it always passes deptParty().
   */
  counterparty?: MovementParty;
  /**
   * FIELD 7 — the BUSINESS date (YYYY-MM-DD, IST): when the movement happened,
   * as distinct from when the row was written. Defaults to today. A count-driven
   * correction should pass the COUNT's date, not the approval's.
   */
  txnDate?: string;
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

  // ── TRANSFER LEGS: only with a named department, only as a pair ──────────
  // Checked in THIS order so each refusal is reachable on its own (a guard
  // that can never fire is no guard): the counterparty check first, then the
  // pair check.
  // A type whose counterparty is a DEPARTMENT must name which one. The type's
  // bare default ({kind:'department'}, no id) would store "Department" on the
  // row — a movement record that cannot say where the goods went.
  if (spec.counterparty === 'department') {
    const cp = p.counterparty;
    if (!cp || cp.kind !== 'department' || !String(cp.id || '').trim()) {
      throw new Error(
        `postDeptLedger: '${p.type}' needs counterparty: deptParty(db, <the other department id>).`,
      );
    }
    if (String(cp.id).trim() === deptId) {
      throw new Error(`postDeptLedger: '${p.type}' cannot name its own department (${deptId}) as the counterparty.`);
    }
  }
  // A transfer leg written on its own is the double-count (a lone transfer_in
  // invents stock) or the vanishing kilo (a lone transfer_out loses it).
  // postDeptTransfer() is the only writer allowed to post either; it raises
  // transferPairDepth around its two calls.
  if (spec.rail === 'transfer' && transferPairDepth === 0) {
    throw new Error(
      `postDeptLedger: '${p.type}' is one leg of a department-to-department transfer and can only be ` +
      `written by postDeptTransfer(), which posts both legs in one transaction.`,
    );
  }

  // ── FIELD 8 — the responsible user, ENFORCED (owner's movement record) ────
  // Two writers used to leave this blank: the recipe-consumption rail (db.ts
  // passed no user at all) and the sale-DELETE give-back (a hard-coded ''). A
  // department ledger that cannot say who moved the goods is not a record.
  // Machine-initiated movements say so with a `system:` actor — the KOT sweep
  // runs on a timer with no session, and `system:kot-sweep` is a TRUE answer
  // where '' is not one and a person's name would be a lie.
  const actor = String(p.user || '').trim();
  if (!actor) {
    throw new Error(
      `postDeptLedger: a responsible user is required (movement '${p.type}', dept ${deptId}, ` +
      `material ${matId}). Pass the SESSION user's email (never a client-supplied name), ` +
      `or '${SYSTEM_ACTOR_PREFIX}<rail>' for a machine-initiated movement.`,
    );
  }

  // ── FIELDS 4 & 5 — both ends ─────────────────────────────────────────────
  // This department is one end; the other comes from the type's own
  // DEPT_TXN_TYPES.counterparty (an issue is from central, a direct receipt is
  // from a vendor, a consumption goes to the guest), overridable per call.
  // orient() picks which end is source and which is destination from the SIGN,
  // which the sign contract above has already validated against the type — so
  // an 'issued' row can only ever read "central → this department".
  const counterparty: MovementParty =
    p.counterparty || { kind: spec.counterparty as MovementPartyKind };
  const ends = orient(deptParty(db, deptId), counterparty, qty);

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
    p.notes || '', actor, createdAt,
  ];
  const addTrace = (col: string, v: string | null) => {
    if (cols.size === 0 || cols.has(col)) { names.push(col); vals.push(v); }
  };
  addTrace('req_item_id', p.reqItemId || null);
  addTrace('order_item_id', p.orderItemId || null);
  addTrace('station', p.station ? String(p.station).trim().toLowerCase() : null);
  addTrace('source', p.source || null);
  // The movement record's own columns — unit snapshot, both ends, business
  // date, immutable recorded_at. Appended, never replacing anything above;
  // movementCols() adds nothing on a database that has not run the migration.
  // NOTE `source` (just above) and `src_kind` (here) are DIFFERENT facts and
  // must not be collapsed: `source` is which ROUTE wrote the row, src_kind is
  // where the GOODS came from.
  const mv = movementCols(db, 'department_material_transactions', {
    materialId: matId, quantity: qty, src: ends.src, dst: ends.dst,
    // A count-driven correction should carry the COUNT's date, and the party
    // rail already records the event's date — both beat "today" as the business
    // date when the caller has one.
    txnDate: p.txnDate || p.eventDate || undefined,
  });
  names.push(...mv.names);
  vals.push(...mv.values);

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
 *
 * ── A TRANSFER PAIR IS NEVER SPLIT — THE ONE EXCEPTION TO THE FLOOR ─────────
 * The two legs of a department → department transfer (transfer_out on the
 * sender, transfer_in on the receiver, written together by postDeptTransfer)
 * live in two DIFFERENT (department, material) pairs, each read under its own
 * rule: a counted pair by the window above, a never-counted pair by its
 * all-time ledger sum (deptReleasable). If the cutover floor could cut one leg
 * and not the other, the same kilos would sit in two departments (the
 * sender's −q dropped, the receiver's +q kept) or in none (the reverse) — and
 * the send check would then let more leave a shelf than is on it. Measured
 * before this rule (round-1 floor.cjs, reproduced in xfer-r2-ledger): X1 26.8
 * kg on the books from 23.8 physical; X2 4 kg in no ledger at all.
 *
 *   THE RULE, decided once, here: a transfer leg is bounded ONLY by its own
 *   department's ANCHOR — the physical count or opening row for that pair —
 *   and NEVER by the cutover floor. A never-counted pair counts every leg it
 *   has (no bound), which is exactly what its all-time sum already does.
 *   Every other movement type keeps the window above, unchanged.
 *
 * Why that conserves whatever order things happen in:
 *   transfer, then floor stamped   → both legs stay visible (the floor is
 *                                    ignored for legs) — X1 and X2.
 *   floor, then transfer           → both legs are after the floor anyway.
 *   count/opening, then transfer   → the leg is after its anchor: visible.
 *   transfer, then count/opening   → that side's leg is ABSORBED by the count,
 *                                    which measured the shelf with the goods
 *                                    already on (or already off) it; the other
 *                                    side's leg stands. A count is the truth
 *                                    for its own department, never a split.
 * Only a physical count can ever absorb a leg, and only on its own side.
 *
 * Nothing in production carries a transfer leg yet, so every balance that does
 * not involve a transfer is byte-identical to before this rule. Implemented in
 * the four places that window the ledger, and nowhere else: sumMovements
 * (this function), deptOnHandBulk, dept-stock.ts computeDeptStock, and the
 * cutover route's adopt-trap count. Change one, change all four.
 */
export function deptOnHand(db: Database.Database, departmentId: string, materialId: string): DeptOnHandResult {
  const deptId = String(departmentId || '');
  const matId = String(materialId || '');
  const w = anchorWindow(db, deptId, matId);
  const { anchor, windowFrom } = w;

  const movementsSince = sumMovements(db, deptId, matId, w);
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
  /** THE TRANSFER-LEG WINDOW (see "A TRANSFER PAIR IS NEVER SPLIT" on
   *  deptOnHand): the anchor alone, never the cutover floor. '' (no bound)
   *  when the pair was never counted. */
  legFrom: string;
  /** Same-second tie-break for the leg window — an OPENING anchor only (it is
   *  a ledger row with a rowid); a count is not, and strict `>` applies. */
  legTieRowid: number | null;
}

/** The transfer leg types, inline for SQL. Kept literal (not built from
 *  DEPT_TRANSFER_TYPES, declared further down) so this block reads alone. */
const TRANSFER_LEG_SQL = `'transfer_out', 'transfer_in'`;
function isTransferLegType(t: unknown): boolean {
  return t === 'transfer_out' || t === 'transfer_in';
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
  // Transfer legs: the anchor only — never the floor (deptOnHand, "A TRANSFER
  // PAIR IS NEVER SPLIT"). Never counted → '' = every leg.
  const legFrom = anchor ? anchor.at : '';
  const legTieRowid = anchor && anchor.source === 'opening' ? anchor.rowid : null;
  return { anchor, windowFrom, tieRowid, legFrom, legTieRowid };
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
 *
 * THE SECOND ARM is the transfer-leg rule (deptOnHand, "A TRANSFER PAIR IS
 * NEVER SPLIT"): a transfer_out / transfer_in row also counts when it is after
 * the ANCHOR, even if it is before the cutover floor. It adds nothing for any
 * other type, so a ledger without transfer legs sums exactly as it always did.
 */
function sumMovements(db: Database.Database, deptId: string, matId: string, w: AnchorWindow): number {
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS s FROM department_material_transactions
       WHERE department_id = @d AND material_id = @m
         AND (
              ${LEDGER_TS_SQL} > @wf
           OR (@tie IS NOT NULL AND ${LEDGER_TS_SQL} = @wf AND rowid > @tie)
           OR (type IN (${TRANSFER_LEG_SQL}) AND (
                   ${LEDGER_TS_SQL} > @lf
                OR (@ltie IS NOT NULL AND ${LEDGER_TS_SQL} = @lf AND rowid > @ltie)))
         )
    `).get({ d: deptId, m: matId, wf: w.windowFrom, tie: w.tieRowid, lf: w.legFrom, ltie: w.legTieRowid });
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
  //    Transfer legs use the leg window (anchor only, never the floor) — the
  //    rule documented on deptOnHand, "A TRANSFER PAIR IS NEVER SPLIT".
  const sums = new Map<string, number>();
  const cache = new Map<string, number>();
  try {
    const rows = db.prepare(`
      SELECT rowid AS rid, department_id, material_id, type, quantity, ${LEDGER_TS_SQL} AS at
        FROM department_material_transactions
       WHERE department_id IN (SELECT value FROM json_each(?)) ${matFilter}
    `).all(deptJson, ...matParams) as Array<{ rid: number; department_id: string; material_id: string; type: string; quantity: number; at: string }>;
    for (const r of rows) {
      const k = deptKey(r.department_id, r.material_id);
      const a = anchors.get(k) || null;
      const windowFrom = a ? (a.at > floor ? a.at : floor) : floor;
      const tieRowid = a && a.source === 'opening' && windowFrom === a.at ? a.rowid : null;
      const at = String(r.at);
      let inWindow = at > windowFrom || (tieRowid != null && at === windowFrom && Number(r.rid) > tieRowid);
      if (!inWindow && isTransferLegType(r.type)) {
        const legFrom = a ? a.at : '';
        const legTie = a && a.source === 'opening' ? a.rowid : null;
        inWindow = at > legFrom || (legTie != null && at === legFrom && Number(r.rid) > legTie);
      }
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
  // The ONE "may stock leave this department" rule, shared with transfers —
  // see deptReleasable(). Same value this line always computed.
  const capDept = deptReleasable(bal, rawLedgerSum(db, deptId, matId)).available;
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

/* ════════════════════════════════════════════════════════════════════════════
 * DEPARTMENT → DEPARTMENT TRANSFER — ONE STEP (owner's ruling, final)
 *
 * WHY THIS EXISTS. Direct Issue rules route MEAT / POULTRY / SEAFOOD deliveries
 * straight onto KITCHEN's department ledger (type direct_receipt). Every
 * requisition for those categories comes from Kitchen's CHILDREN (Akan Main
 * Kitchen, Akan Tandoori, …), and a child never sees its parent's stock —
 * resolveDeptSet() rolls DOWNWARD only. The owner's decision: Kitchen receives
 * the delivery, then HANDS stock to the sub-kitchens.
 *
 * ONE STEP. The moment a transfer is SENT the sender's ledger goes down and the
 * receiver's goes up, in ONE synchronous transaction (sendDeptTransfer →
 * postDeptTransfer per line). There is NO pending state, no "confirm receipt",
 * no waiting list. The receiver sees it under "Transfers in" and may FLAG A
 * DISPUTE — short, wrong item, not received — with a reason. A flag RECORDS
 * the dispute (and the route alerts the sender's head and managers); it moves
 * NO stock. The correction is a REVERSE transfer (receiver → sender, one tap
 * from the disputed row, prefilled with the disputed quantity), which is an
 * ordinary one-step transfer through the same writer and the same checks.
 *
 * THE LAW THIS SECTION EXISTS TO KEEP — NO DOUBLE COUNT. One physical kilo
 * lives in exactly one ledger. A transfer is a DEBIT on the sender's department
 * ledger (transfer_out, −q) and a CREDIT on the receiver's (transfer_in, +q),
 * in ONE synchronous transaction, sharing one reference_id (the transfer line
 * id). Central (raw_materials.current_stock / inventory_transactions) is never
 * read for a decision and never written. No floor, count or cutover can split
 * the pair afterwards — see "A TRANSFER PAIR IS NEVER SPLIT" on deptOnHand.
 *
 * UNITS. Every ledger quantity is RECIPE units. A person types PURCHASE units
 * (owner rule: screens lead with the purchase unit); the entry is converted
 * ONCE, at the door, by transferQtyToRecipe() → packFactor() from
 * pack-units.ts. Nothing below converts a second time, and nothing imports
 * issue-stock.ts (another branch owns that file).
 *
 * NEVER COUNTED IS NOT ZERO — AND NOT A FIGURE THE APP CAN VOUCH FOR. A
 * department balance before its first count is NULL. Kitchen is, in practice,
 * never counted, so a refuse-on-NULL guard would block every transfer. The
 * send check reads deptSendable(): the most conservative figure the ledger
 * supports — the counted balance (capped by the anchor plus every movement
 * since it, whichever is lower), or, never counted, the all-time signed ledger
 * sum. For a never-counted department whose cooking is booked to ANOTHER
 * department (the owner's station map books KOT consumption to the top-level
 * Tandoor / Indian / …), that sum cannot see what was cooked: it is an UPPER
 * BOUND, flagged `upperBound`, and the holdings screen must say so.
 *
 * IDEMPOTENCY. Every send (and every reverse) carries a CLIENT KEY the screen
 * mints once per tray. A retry after a lost response finds the document that
 * key already made and gets it back (duplicate: true) — it never writes a
 * second transfer. The same key with a DIFFERENT request is refused (409): a
 * key names one transfer, forever. A UNIQUE index backs the lookup.
 *
 * WHAT THIS SECTION DOES NOT DECIDE: who may send, flag, dismiss or reverse.
 * That is the route's job (session user, department head, HOD posted there,
 * managers, admin). This section enforces DATA invariants only.
 * ════════════════════════════════════════════════════════════════════════════ */

/** How deptReleasable() arrived at its figure. Show it on screen. */
export type DeptReleaseBasis = 'counted' | 'uncounted_ledger_sum';

export interface DeptReleasable {
  /** RECIPE units that may leave the department right now. Can be ≤ 0. */
  available: number;
  basis: DeptReleaseBasis;
  /** The anchored balance, or NULL when never counted (NEVER 0 for unknown). */
  onHand: number | null;
  /** The all-time signed ledger sum for the pair, RECIPE units. */
  ledgerSum: number;
}

/**
 * "How much may go back to CENTRAL from this department" — assertReversible's
 * capDept. Unchanged from production on purpose: the reversal guard sits on
 * the requisition undo/return paths, which this branch must not move.
 *
 *   counted        → deptOnHand().onHand — the count is the truth.
 *   never counted  → the ALL-TIME signed ledger sum: everything this rail has
 *                    put into the department minus everything it has taken
 *                    out. Never 0 (that blocks Kitchen, which is never
 *                    counted, from ever handing anything on), never unlimited.
 *
 * WHY NOT movementsSince for the never-counted case (staff-meals uses it). The
 * two agree while the cutover floor is unstamped. Once it is stamped, a
 * never-counted pair has NO opening row — the cutover count did not cover it —
 * so its pre-floor direct receipts were never absorbed into any count, and
 * movementsSince would silently drop real kilos Kitchen is still holding. The
 * all-time sum keeps them.
 *
 * A TRANSFER reads deptSendable() below, which is this figure made more
 * conservative where the ledger allows (never less conservative).
 */
export function deptReleasable(bal: DeptOnHandResult, rawSum: number): DeptReleasable {
  const ledgerSum = r6(rawSum);
  if (bal.neverCounted || bal.onHand === null) {
    return { available: ledgerSum, basis: 'uncounted_ledger_sum', onHand: null, ledgerSum };
  }
  return { available: r6(bal.onHand), basis: 'counted', onHand: r6(bal.onHand), ledgerSum };
}

/** deptReleasable() for one (department, material), read live. */
export function deptReleasableFor(db: Database.Database, departmentId: string, materialId: string): DeptReleasable {
  const deptId = String(departmentId || '');
  const matId = String(materialId || '');
  return deptReleasable(deptOnHand(db, deptId, matId), rawLedgerSum(db, deptId, matId));
}

/** deptReleasable() for every material ONE department holds, batched (two
 *  queries via deptOnHandBulk + one GROUP BY). Key = material id. Exactly ONE
 *  department — no roll-up: a parent's figure must never include what its
 *  children hold, or Kitchen could hand on Akan Tandoori's stock. */
export function deptReleasableBulk(db: Database.Database, departmentId: string): Map<string, DeptReleasable> {
  const out = new Map<string, DeptReleasable>();
  for (const [matId, s] of deptSendableBulk(db, departmentId)) {
    out.set(matId, { available: s.releasable, basis: s.basis, onHand: s.onHand, ledgerSum: s.ledgerSum });
  }
  return out;
}

/* ── THE SEND FIGURE ────────────────────────────────────────────────────── */

export interface DeptSendable extends DeptReleasable {
  /** deptReleasable().available, before the conservative cap. */
  releasable: number;
  /**
   * Counted pairs whose count is OLDER than the cutover floor: the anchor plus
   * EVERY movement after it, the floor ignored. NULL when it cannot differ
   * from the balance (never counted, or the anchor is after the floor).
   */
  sinceAnchor: number | null;
  /**
   * TRUE when the figure is one the app cannot vouch for: the pair was never
   * counted, so stock cooked here but booked to another department (or to
   * none) is invisible and the real shelf may hold less. Screens must say
   * "up to", never "holds".
   */
  upperBound: boolean;
}

/**
 * THE most conservative figure the ledger supports for "may this leave by
 * transfer". Two readings of a counted pair can disagree when its count is
 * older than the cutover floor: the balance (count + movements after the
 * floor, + transfer legs after the count) and the count plus EVERYTHING after
 * it. The floor can hide a post-count outflow (a wastage or staff meal booked
 * between the count and the cutover); the lower of the two never lets more
 * leave than either reading supports. A never-counted pair has one figure the
 * ledger supports — its all-time sum — so NULL is never a block, and the
 * figure is flagged upperBound for the screen.
 */
export function deptSendable(bal: DeptOnHandResult, rawSum: number, sinceAnchor: number | null): DeptSendable {
  const rel = deptReleasable(bal, rawSum);
  if (rel.basis !== 'counted') {
    return { ...rel, releasable: rel.available, sinceAnchor: null, upperBound: true };
  }
  const sa = sinceAnchor == null ? null : r6(sinceAnchor);
  const available = sa == null ? rel.available : r6(Math.min(rel.available, sa));
  return { ...rel, available, releasable: rel.available, sinceAnchor: sa, upperBound: false };
}

/** anchor + every movement after it, the floor ignored — only when the anchor
 *  is older than the window start (otherwise it equals the balance). */
function sinceAnchorFigure(db: Database.Database, deptId: string, matId: string, bal: DeptOnHandResult): number | null {
  if (bal.neverCounted || bal.anchorAt == null || bal.anchorQty == null) return null;
  if (!(bal.anchorAt < bal.windowFrom)) return null;
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS s FROM department_material_transactions
       WHERE department_id = ? AND material_id = ? AND type <> 'opening' AND ${LEDGER_TS_SQL} > ?
    `).get(deptId, matId, bal.anchorAt) as { s: number } | undefined;
    return r6(bal.anchorQty + (Number(row?.s) || 0));
  } catch { return null; }
}

/**
 * WHY a counted pair's send figure is lower than its count plus every movement
 * since it — for the 'insufficient' refusal, so it never says "holds none … by
 * its last count and the movements since" when the count and those movements
 * say otherwise. '' when the cutover floor hides nothing for this pair (never
 * counted, counted after the floor, or nothing booked in between).
 *
 * The case (conservation verifier, targeted.cjs A2): Akan Tandoori counted
 * 2 kg, the store issued 5 kg, Tandoori sent 4 kg on, THEN the first cutover
 * stamped the floor. The floor keeps the 5 kg issue out of the balance
 * (decision D), the transfer leg stays in it ("A TRANSFER PAIR IS NEVER
 * SPLIT"), so the books read −2 kg against a 3 kg shelf until Tandoori is
 * counted again. This only EXPLAINS that figure; the rule is unchanged.
 */
function floorHiddenNote(db: Database.Database, deptId: string, deptName: string, m: TransferMaterial, available: number): string {
  try {
    const bal = deptOnHand(db, deptId, m.id);
    if (bal.neverCounted || bal.onHand == null || bal.anchorAt == null || bal.anchorQty == null) return '';
    if (!(bal.anchorAt < bal.windowFrom)) return '';
    const sa = sinceAnchorFigure(db, deptId, m.id, bal);
    if (sa == null || Math.abs(r6(sa - bal.onHand)) <= EPS) return '';
    const rows = db.prepare(`
      SELECT type, COALESCE(SUM(quantity), 0) AS q, COUNT(*) AS n FROM department_material_transactions
       WHERE department_id = ? AND material_id = ? AND type NOT IN ('opening', ${TRANSFER_LEG_SQL})
         AND ${LEDGER_TS_SQL} > ? AND ${LEDGER_TS_SQL} <= ?
       GROUP BY type ORDER BY type
    `).all(deptId, m.id, bal.anchorAt, bal.windowFrom) as Array<{ type: string; q: number; n: number }>;
    const shownRows = rows.filter((r) => Math.abs(Number(r.q)) > EPS);
    const hidden = shownRows
      .map((r) => `${Number(r.q) > 0 ? '+' : ''}${fmtDual(Number(r.q), m)} ${String(r.type).replace(/_/g, ' ')}`).join(', ');
    const hiddenRows = shownRows.length;
    // Same minute → show the seconds, or "older than" reads as the same time.
    const secs = istStamp(bal.anchorAt) === istStamp(bal.windowFrom);
    return `${deptName}'s books for ${m.name} start from its count of ${fmtDual(bal.anchorQty, m)} ` +
      `(${istStamp(bal.anchorAt, secs)}), which is older than the department-ledger cutover (${istStamp(bal.windowFrom, secs)}). ` +
      `${hidden ? `${hidden} booked between the two ${hiddenRows === 1 ? 'is' : 'are'}` : 'What was booked between the two (other than transfers) is'} ` +
      `not in its balance, while every transfer since the count is — so its books show ${fmtDual(bal.onHand, m)}, although the count plus ` +
      `every movement since it comes to ${fmtDual(sa, m)}. ` +
      (available > EPS ? `It can send ${fmtDual(available, m)} now. ` : 'It can send none now. ') +
      `Count ${deptName} again (or cut it over with what is on the shelf now) and its books start from the shelf.`;
  } catch { return ''; }
}

/** deptSendable() for one (department, material), read live. */
export function deptSendableFor(db: Database.Database, departmentId: string, materialId: string): DeptSendable {
  const deptId = String(departmentId || '');
  const matId = String(materialId || '');
  const bal = deptOnHand(db, deptId, matId);
  return deptSendable(bal, rawLedgerSum(db, deptId, matId), sinceAnchorFigure(db, deptId, matId, bal));
}

/** deptSendable() for every material ONE department holds — the holdings
 *  screen. Same function per pair as the send check, so the screen cannot
 *  offer what the server refuses. No roll-up (see deptReleasableBulk). */
export function deptSendableBulk(db: Database.Database, departmentId: string): Map<string, DeptSendable> {
  const deptId = String(departmentId || '');
  const out = new Map<string, DeptSendable>();
  if (!deptId) return out;
  const raw = new Map<string, number>();
  try {
    const rows = db.prepare(`
      SELECT material_id, COALESCE(SUM(quantity), 0) AS s FROM department_material_transactions
       WHERE department_id = ? GROUP BY material_id
    `).all(deptId) as Array<{ material_id: string; s: number }>;
    for (const r of rows) raw.set(String(r.material_id), Number(r.s) || 0);
  } catch { /* ledger unreadable — every pair falls back to its balance, or 0 */ }
  const bal = deptOnHandBulk(db, [deptId]);
  for (const [k, b] of bal) {
    const matId = k.slice(deptId.length + 1);
    out.set(matId, deptSendable(b, raw.get(matId) ?? 0, sinceAnchorFigure(db, deptId, matId, b)));
  }
  // A pair can hold ledger rows that are all before the cutover floor, with no
  // anchor and no cache row — deptOnHandBulk then returns no key for it. It is
  // never-counted stock all the same; the all-time sum is its figure.
  for (const [matId, s] of raw) {
    if (out.has(matId)) continue;
    const v = r6(s);
    out.set(matId, {
      available: v, basis: 'uncounted_ledger_sum', onHand: null, ledgerSum: v,
      releasable: v, sinceAnchor: null, upperBound: true,
    });
  }
  return out;
}

/* ── errors ─────────────────────────────────────────────────────────────── */

export type DeptTransferBlockReason =
  | 'invalid'               // malformed input — 400
  | 'same_department'
  | 'unknown_department'
  | 'inactive_department'
  | 'unknown_material'
  | 'store_mapped'          // liquor: lives on the TGBCL store rail
  | 'insufficient'          // the sender does not hold enough
  | 'window'                // a leg would fall outside its pair's balance window
  | 'state'                 // not found / not posted / already disputed / nothing left
  | 'counted_since'         // a disputed line was COUNTED since it moved — a reverse would correct it twice
  | 'stale'                 // a one-tap reverse whose prefill changed since the screen showed it (nothing moved)
  | 'idempotency_conflict'; // a client key reused for a DIFFERENT request

/** Thrown by every transfer function below. Routes answer `httpStatus` with
 *  `.message`; the transaction it was thrown in has already rolled back. */
export class DeptTransferBlocked extends Error {
  readonly code = 'DEPT_TRANSFER_BLOCKED';
  readonly reason: DeptTransferBlockReason;
  readonly httpStatus: 400 | 404 | 409;
  readonly materialId: string;
  /** RECIPE units. */
  readonly requested: number;
  /** RECIPE units the sender could release, when the refusal is about quantity. */
  readonly available: number;

  constructor(d: {
    reason: DeptTransferBlockReason; message: string;
    materialId?: string; requested?: number; available?: number; httpStatus?: 400 | 404 | 409;
  }) {
    super(d.message);
    this.name = 'DeptTransferBlocked';
    this.reason = d.reason;
    this.httpStatus = d.httpStatus ?? (d.reason === 'invalid' ? 400 : 409);
    this.materialId = d.materialId || '';
    this.requested = r6(d.requested || 0);
    this.available = r6(d.available || 0);
  }
}

export function isDeptTransferBlocked(e: unknown): e is DeptTransferBlocked {
  return e instanceof DeptTransferBlocked
    || (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'DEPT_TRANSFER_BLOCKED');
}

function blocked(reason: DeptTransferBlockReason, message: string, extra?: {
  materialId?: string; requested?: number; available?: number; httpStatus?: 400 | 404 | 409;
}): DeptTransferBlocked {
  return new DeptTransferBlocked({ reason, message, ...extra });
}

/* ── units ──────────────────────────────────────────────────────────────── */

interface TransferMaterial extends PackMeta {
  id: string;
  name: string;
  category: string;
}

function transferMaterial(db: Database.Database, materialId: string): TransferMaterial | null {
  try {
    const r = db.prepare(
      'SELECT id, name, category, unit, purchase_unit, pack_size, case_size FROM raw_materials WHERE id = ?',
    ).get(String(materialId || '')) as TransferMaterial | undefined;
    return r || null;
  } catch { return null; }
}

/** What unit a typed transfer quantity is in. Screens send 'purchase'. */
export type TransferEntryUnit = 'purchase' | 'recipe';

/**
 * A typed quantity → RECIPE units, through packFactor() and nothing else.
 * 'purchase' (the default, and what screens send) multiplies by the pack
 * factor; 'recipe' passes through. packFactor's both-halves guard is what keeps
 * a kg/kg pack-1.5 item at ×1 — do not "simplify" this to × pack_size.
 */
export function transferQtyToRecipe(meta: PackMeta, qty: number, unit: TransferEntryUnit = 'purchase'): number {
  const q = Number(qty);
  if (!Number.isFinite(q)) return NaN;
  return r6(unit === 'recipe' ? q : q * packFactor(meta));
}

/** "3 kg" / "2.5 l (2500 ml)" — the PURCHASE unit leads (owner rule), the
 *  recipe figure follows only when there is a real pack conversion. Shows up
 *  to 6 decimals so a refusal never prints two figures that look equal. */
function fmtDual(recipeQty: number, m: PackMeta): string {
  const pu = String(m.purchase_unit || m.unit || '').trim();
  const ru = String(m.unit || '').trim();
  const pf = packFactor(m);
  const lead = `${fmtFine(r6(recipeQty / pf))} ${pu}`.trim();
  return pf > 1 ? `${lead} (${fmtFine(recipeQty)} ${ru})` : lead;
}

/** Like fmt(), but keeps up to 6 decimals when 3 would hide the difference. */
function fmtFine(n: number): string {
  const v = r6(n);
  if (Number.isInteger(v)) return String(v);
  const three = Math.round(v * 1000) / 1000;
  return Math.abs(three - v) < 1e-9 ? String(three) : String(v);
}

/* ── departments & the liquor carve-out ─────────────────────────────────── */

interface TransferDept { id: string; name: string; is_active: number }

function transferDept(db: Database.Database, id: string): TransferDept | null {
  try {
    const r = db.prepare('SELECT id, name, is_active FROM departments WHERE id = ?')
      .get(String(id || '')) as TransferDept | undefined;
    return r || null;
  } catch { return null; }
}

/**
 * Store-mapped (liquor / TGBCL) materials never ride the department rail —
 * header rule 3. Returns a refusal message, or null for a department material.
 *
 * DEFERRED require, not an import: store-engine imports db.ts, which imports
 * THIS file statically, so a top-level import here would close the cycle
 * db.ts → dept-ledger → store-engine → db.ts. By the time a transfer runs every
 * module is loaded. FAILS CLOSED: if the store map cannot be consulted the
 * transfer is refused, because moving a bottle onto the wrong rail is the
 * double-count, while a refused transfer can simply be retried.
 */
function storeRailBlock(db: Database.Database, m: TransferMaterial): string | null {
  let se: typeof import('./store-engine');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    se = require('./store-engine') as typeof import('./store-engine');
  } catch {
    return `Could not check whether "${m.name}" belongs to a store location, so the transfer was refused rather than guessed. Try again.`;
  }
  try {
    if (!se.isStoreMappedMaterial(db, m.id)) return null;
  } catch {
    return `Could not check whether "${m.name}" belongs to a store location, so the transfer was refused rather than guessed. Try again.`;
  }
  return `"${m.name}" is a store-location (liquor) material. It lives on the store rail and moves with Store Transfers, never between departments.`;
}

/* ── the pair writer ────────────────────────────────────────────────────── */

export interface DeptTransferPost {
  fromDepartmentId: string;
  toDepartmentId: string;
  materialId: string;
  /** POSITIVE, RECIPE units. Convert a typed entry with transferQtyToRecipe() first. */
  quantity: number;
  /** Stamped as reference_id on BOTH legs — the department_transfer_lines.id.
   *  Required: it is how the pair is found, audited and integrity-checked. */
  referenceId: string;
  /** The SESSION user's email. Never a client-supplied name. */
  user: string;
  /** Business date, YYYY-MM-DD IST. Defaults to today. created_at is never backdated. */
  txnDate?: string;
  outletId?: string | null;
  notes?: string;
  source?: string;
}

export interface DeptTransferPostResult {
  outId: string;
  inId: string;
  /** RECIPE units moved. */
  quantity: number;
  createdAt: string;
  from: { before: DeptSendable; after: DeptSendable };
  to: { before: DeptSendable; after: DeptSendable };
}

/**
 * THE department-to-department movement: transfer_out on the sender, then
 * transfer_in on the receiver, in ONE synchronous transaction. Nothing is
 * awaited; nothing touches central.
 *
 * Opens its own transaction (IMMEDIATE when standalone, a SAVEPOINT when the
 * caller is already inside one — better-sqlite3 ignores the mode when nested),
 * so the pair is atomic whoever calls it. A throw rolls back both legs, both
 * cache updates and whatever the caller wrote in its own transaction.
 *
 * REFUSES with DeptTransferBlocked:
 *   invalid             blank ids / user / reference, non-positive or non-finite qty
 *   same_department     from === to
 *   unknown_department  either end does not exist
 *   inactive_department the RECEIVER is switched off (sending OUT of a
 *                       switched-off department is allowed — it drains it)
 *   unknown_material    no such raw material
 *   store_mapped        liquor — see storeRailBlock()
 *   insufficient        q > deptSendable(sender).available
 *   window              a leg would not land inside its pair's balance window
 */
export function postDeptTransfer(db: Database.Database, t: DeptTransferPost): DeptTransferPostResult {
  const run = db.transaction((): DeptTransferPostResult => postDeptTransferInTxn(db, t));
  return run.immediate();
}

function postDeptTransferInTxn(db: Database.Database, t: DeptTransferPost): DeptTransferPostResult {
  const fromId = String(t.fromDepartmentId || '').trim();
  const toId = String(t.toDepartmentId || '').trim();
  const matId = String(t.materialId || '').trim();
  const ref = String(t.referenceId || '').trim();
  const actor = String(t.user || '').trim();
  const q = r6(Number(t.quantity));

  if (!fromId || !toId) throw blocked('invalid', 'A transfer needs a sending and a receiving department.');
  if (!matId) throw blocked('invalid', 'A transfer needs a material.');
  if (!ref) throw blocked('invalid', 'A transfer needs a reference (the transfer line id) on both legs.');
  if (!actor) throw blocked('invalid', 'A transfer needs the responsible user (the session user).');
  if (!Number.isFinite(q) || q <= EPS) {
    throw blocked('invalid', `A transfer quantity must be a positive number; got ${String(t.quantity)}.`, { materialId: matId });
  }
  if (fromId === toId) {
    throw blocked('same_department', 'A department cannot transfer stock to itself.', { materialId: matId });
  }

  const from = transferDept(db, fromId);
  const to = transferDept(db, toId);
  if (!from) throw blocked('unknown_department', `Sending department ${fromId} does not exist.`, { httpStatus: 404 });
  if (!to) throw blocked('unknown_department', `Receiving department ${toId} does not exist.`, { httpStatus: 404 });
  if (!Number(to.is_active)) {
    throw blocked('inactive_department', `${to.name} is switched off; stock sent there would be hidden from every live screen.`);
  }

  const m = transferMaterial(db, matId);
  if (!m) throw blocked('unknown_material', `Material ${matId} does not exist.`, { httpStatus: 404 });
  const storeMsg = storeRailBlock(db, m);
  if (storeMsg) throw blocked('store_mapped', storeMsg, { materialId: matId });

  // ── the sender must hold it (refuse, never clamp) ────────────────────────
  const fromBefore = deptSendableFor(db, fromId, matId);
  if (q > fromBefore.available + EPS) {
    const basisNote = fromBefore.basis === 'counted'
      ? 'by its last count and the movements since'
      : 'by its ledger (it has never been counted)';
    const avail = Math.max(0, fromBefore.available);
    // The cutover floor holding the figure below the count + every movement
    // since it is said as such — never "holds none by its last count and the
    // movements since", which that count and those movements contradict.
    const floorNote = fromBefore.basis === 'counted' && fromBefore.sinceAnchor != null
      ? floorHiddenNote(db, fromId, from.name, m, fromBefore.available) : '';
    // Holding NOTHING is its own sentence: "Send 0 kg or less" told the Kitchen
    // head to send nothing without saying why nothing was there (measured: the
    // owner's three category rules miss category 'non-veg', so the chicken went
    // to the central shelf and Kitchen's ledger got 0 — the-real-case ROUTE=none).
    throw blocked(
      'insufficient',
      floorNote
        ? `Cannot hand over ${fmtDual(q, m)} of ${m.name} from ${from.name}. ${floorNote}`
        : avail > EPS
        ? `${from.name} holds only ${fmtDual(avail, m)} of ${m.name} ${basisNote}; ` +
          `cannot hand over ${fmtDual(q, m)}. Send ${fmtDual(avail, m)} or less, ` +
          `or record a count for ${from.name} first.`
        : `${from.name} holds none of ${m.name} ${basisNote}, so it cannot hand over ${fmtDual(q, m)}. ` +
          `Goods reach ${from.name}'s books when a delivery is routed to ${from.name} (Direct Issue), ` +
          `the store issues them, or ${from.name} records a count.`,
      { materialId: matId, requested: q, available: avail },
    );
  }
  const toBefore = deptSendableFor(db, toId, matId);

  // ── the anchor hazard, refused up front ──────────────────────────────────
  // A LEG is counted when its 19-char created_at is strictly after its pair's
  // ANCHOR (the leg window — the cutover floor never applies to a leg; see
  // deptOnHand, "A TRANSFER PAIR IS NEVER SPLIT"). If an anchor sits at or
  // after this second (a count saved this very second, or stamped in the
  // future) the leg would be swallowed, so it is refused. computeDeptStock has
  // no same-second rowid tie-break, so "at" is refused too, not only "after".
  const postingSec = nowMs().slice(0, 19);
  for (const [dept, label] of [[fromId, from.name], [toId, to.name]] as const) {
    const w = anchorWindow(db, dept, matId);
    if (w.legFrom && w.legFrom >= postingSec) {
      throw blocked(
        'window',
        `${label}'s balance for ${m.name} starts at ${w.legFrom} (its count), which is not before now ` +
        `(${postingSec}). A transfer posted now would not appear in that balance, so it was refused. ` +
        `Retry in a moment; if it persists, the count's date or time is in the future.`,
        { materialId: matId, requested: q },
      );
    }
  }

  const fromMovedBefore = deptOnHand(db, fromId, matId).movementsSince;
  const toMovedBefore = deptOnHand(db, toId, matId).movementsSince;

  const txnDate = t.txnDate || todayISTDate();
  const userNotes = String(t.notes || '').trim();
  const source = t.source || 'department-transfer';

  let outRow: DeptLedgerPostResult;
  let inRow: DeptLedgerPostResult;
  transferPairDepth++;
  try {
    outRow = postDeptLedger(db, {
      departmentId: fromId, materialId: matId, type: 'transfer_out', quantity: -q,
      outletId: t.outletId ?? null, referenceId: ref, source, user: actor, txnDate,
      counterparty: deptParty(db, toId),
      notes: `Transfer to ${to.name}${userNotes ? ` — ${userNotes}` : ''}`,
    });
    inRow = postDeptLedger(db, {
      departmentId: toId, materialId: matId, type: 'transfer_in', quantity: q,
      outletId: t.outletId ?? null, referenceId: ref, source, user: actor, txnDate,
      counterparty: deptParty(db, fromId),
      notes: `Transfer from ${from.name}${userNotes ? ` — ${userNotes}` : ''}`,
    });
  } finally {
    transferPairDepth--;
  }

  // ── PROVE it: each balance moved by exactly its leg ──────────────────────
  // The pre-check above predicts; this measures. If either window swallowed a
  // leg (clock skew, a format nobody anticipated), the throw rolls BOTH legs
  // back rather than letting a kilo leave one department and reach none.
  const fromMoved = r6(deptOnHand(db, fromId, matId).movementsSince - fromMovedBefore);
  const toMoved = r6(deptOnHand(db, toId, matId).movementsSince - toMovedBefore);
  if (Math.abs(fromMoved + q) > 1e-6 || Math.abs(toMoved - q) > 1e-6) {
    throw blocked(
      'window',
      `Transfer of ${fmtDual(q, m)} ${m.name} refused: after posting, ${from.name}'s balance moved by ` +
      `${fmt(fromMoved)} and ${to.name}'s by ${fmt(toMoved)} (expected −${fmt(q)} / +${fmt(q)}). ` +
      `A leg fell outside its balance window; nothing was written.`,
      { materialId: matId, requested: q },
    );
  }

  return {
    outId: outRow.id,
    inId: inRow.id,
    quantity: q,
    createdAt: inRow.createdAt,
    from: { before: fromBefore, after: deptSendableFor(db, fromId, matId) },
    to: { before: toBefore, after: deptSendableFor(db, toId, matId) },
  };
}

/* ── the transfer DOCUMENT — one step ───────────────────────────────────────
 * Tables: department_transfers + department_transfer_lines +
 * department_transfer_disputes (db.ts, the "DEPARTMENT → DEPARTMENT
 * TRANSFERS" block). Every document is 'posted': its legs were written in the
 * same transaction that wrote it. The tables hold NO balance — never SUM a
 * line into a stock figure; the ledger is the truth.
 * ──────────────────────────────────────────────────────────────────────────*/

/** Always 'posted' — the stock moved when the document was written. */
export type DeptTransferStatus = 'posted';
export type DeptTransferDisputeStatus = '' | 'open' | 'resolved';
export type DeptTransferDisputeKind = 'short' | 'wrong_item' | 'not_received';
export const DEPT_TRANSFER_DISPUTE_KINDS: readonly DeptTransferDisputeKind[] = ['short', 'wrong_item', 'not_received'];

export interface DeptTransferLineInput {
  materialId: string;
  /** As TYPED. Converted once with transferQtyToRecipe(). */
  quantity: number;
  /** Default 'purchase' — what every screen sends (owner rule). */
  unit?: TransferEntryUnit;
  notes?: string;
}

export interface SendDeptTransferInput {
  fromDepartmentId: string;
  toDepartmentId: string;
  lines: DeptTransferLineInput[];
  /** The SESSION user's email. */
  user: string;
  /** REQUIRED. Minted ONCE per tray by the screen; a retry re-sends the same key. */
  clientKey: string;
  notes?: string;
  outletId?: string | null;
}

export interface DeptTransferLineRow {
  id: string;
  transfer_id: string;
  material_id: string;
  material_name: string;
  unit: string;
  purchase_unit: string;
  pack_factor: number;
  /** RECIPE units moved by this line — both legs. */
  qty_sent: number;
  entry_qty: number | null;
  entry_unit: string;
  /** The sender's transfer_out and the receiver's transfer_in ledger rows. */
  out_txn_id: string;
  in_txn_id: string;
  /** Set on a REVERSE transfer's line: the original line it corrects. */
  reverses_line_id: string;
  notes: string;
  created_at: string;
  /** Computed: RECIPE units already moved back by reverse transfers. */
  qty_reversed: number;
  /** Computed: qty_sent − qty_reversed — what this line still has in the receiver's books. */
  qty_net: number;
  /** Computed: RECIPE units under an OPEN dispute and not yet reversed. */
  qty_open_disputed: number;
  /**
   * Computed, and ONLY for a line with an open dispute (null otherwise): which
   * end has COUNTED this material since the line's legs posted — its count or
   * cutover opening row now sits at/after its own leg, so that leg is absorbed
   * and the department's books already say what is on its shelf. Either end
   * set means a reverse would correct the disputed amount a SECOND time; see
   * transferCountedSince().
   */
  counted_since: DeptTransferCountedSince | null;
}

/** Where a department's balance re-started after a transfer leg: its anchor. */
export interface DeptTransferAnchorAfterLeg {
  /** The anchor's normalised timestamp (UTC, 'YYYY-MM-DD HH:MM:SS'). */
  at: string;
  source: 'count' | 'opening';
}

/** Per disputed line: the anchor that absorbed each end's leg, or null. */
export interface DeptTransferCountedSince {
  /** The ORIGINAL RECEIVER (to_department) counted since its transfer_in. */
  receiver: DeptTransferAnchorAfterLeg | null;
  /** The ORIGINAL SENDER (from_department) counted since its transfer_out. */
  sender: DeptTransferAnchorAfterLeg | null;
}

export interface DeptTransferDisputeRow {
  id: string;
  transfer_id: string;
  line_id: string;
  kind: DeptTransferDisputeKind;
  /** RECIPE units the receiver says did not arrive (or arrived wrong). */
  qty_disputed: number;
  /** What the receiver typed: what DID arrive, for 'short'. */
  entry_qty: number | null;
  entry_unit: string;
  reason: string;
  raised_by: string;
  raised_at: string;
  status: 'open' | 'resolved';
  /** 'reversed' (a reverse transfer moved it back) | 'dismissed' (closed with a note, nothing moved). */
  resolution: string;
  resolution_note: string;
  resolved_by: string;
  resolved_at: string;
  /** RECIPE units moved back so far by reverse transfers against this dispute. */
  qty_reversed: number;
  reverse_transfer_id: string;
  /** Comma-joined emails the route alerted when the dispute was raised. */
  alert_recipients: string;
}

export interface DeptTransferRow {
  id: string;
  transfer_no: string;
  outlet_id: string | null;
  from_department_id: string;
  from_department_name: string;
  to_department_id: string;
  to_department_name: string;
  status: DeptTransferStatus;
  /** Business date stamped on both legs. */
  txn_date: string;
  notes: string;
  created_by: string;
  created_at: string;
  client_key: string;
  /** '' unless this transfer CORRECTS another (a reverse transfer). */
  reverses_transfer_id: string;
  dispute_status: DeptTransferDisputeStatus;
  updated_at: string;
}

export interface DeptTransferWithLines extends DeptTransferRow {
  lines: DeptTransferLineRow[];
  disputes: DeptTransferDisputeRow[];
  /** transfer_no of the transfer this one reverses ('' when not a reverse). */
  reverses_transfer_no: string;
  /** Reverse transfers made against this one. */
  reversed_by: Array<{ id: string; transfer_no: string; created_at: string; created_by: string }>;
}

export interface SendDeptTransferResult {
  transfer: DeptTransferWithLines;
  /** TRUE when the client key had already made this transfer: nothing new was written. */
  duplicate: boolean;
}

/** Next DTR-<year>-#### — the same MAX+1 shape as PINV-<year>-####. Called
 *  inside an IMMEDIATE transaction, so two senders cannot take one number. */
function nextTransferNo(db: Database.Database): string {
  const yr = todayISTDate().slice(0, 4);
  const row = db.prepare(`
    SELECT MAX(CAST(substr(transfer_no, length('DTR-' || ? || '-') + 1) AS INTEGER)) AS n
      FROM department_transfers WHERE transfer_no LIKE 'DTR-' || ? || '-%'
  `).get(yr, yr) as { n: number | null } | undefined;
  return `DTR-${yr}-${String((Number(row?.n) || 0) + 1).padStart(4, '0')}`;
}

const CLIENT_KEY_RE = /^[A-Za-z0-9._:-]{8,120}$/;

/**
 * THE IDEMPOTENCY GATE. Runs FIRST inside the IMMEDIATE transaction, before any
 * validation that could read differently on a retry (a retry of a send that
 * succeeded must come back as that send — not as "insufficient", which is what
 * re-checking the now-lower balance would say). Returns the existing document
 * when this user already used this key for the SAME request; refuses the key
 * for a different one.
 */
function idempotentHit(
  db: Database.Database, actor: string, clientKey: string, fingerprint: string,
): DeptTransferWithLines | null {
  const row = db.prepare(`
    SELECT id, request_fingerprint FROM department_transfers WHERE created_by = ? AND client_key = ?
  `).get(actor, clientKey) as { id: string; request_fingerprint: string } | undefined;
  if (!row) return null;
  if (String(row.request_fingerprint || '') !== fingerprint) {
    throw blocked(
      'idempotency_conflict',
      `This send key was already used for a different transfer. Nothing was written; start a new transfer.`,
    );
  }
  return getDeptTransfer(db, row.id);
}

interface PreparedLine {
  m: TransferMaterial;
  /** RECIPE units. */
  qty: number;
  entryQty: number | null;
  entryUnit: string;
  factor: number;
  notes: string;
  reversesLineId: string;
}

/**
 * The one writer of a transfer DOCUMENT and its legs. Caller is inside an
 * IMMEDIATE transaction and has passed the idempotency gate. Writes the
 * header, then each line, then each line's pair through postDeptTransfer(), and
 * stamps the leg ids on the line. Any refusal rolls everything back.
 */
function writeTransferDoc(db: Database.Database, d: {
  from: TransferDept; to: TransferDept; actor: string; clientKey: string; fingerprint: string;
  notes: string; outletId: string | null; reversesTransferId: string; lines: PreparedLine[];
}): DeptTransferWithLines {
  const id = newId();
  const txnDate = todayISTDate();
  const transferNo = nextTransferNo(db);
  const at = nowMs();
  db.prepare(`
    INSERT INTO department_transfers
      (id, transfer_no, outlet_id, from_department_id, from_department_name,
       to_department_id, to_department_name, status, txn_date, notes, created_by, created_at,
       client_key, request_fingerprint, reverses_transfer_id, dispute_status, updated_at)
    VALUES (?,?,?,?,?,?,?, 'posted', ?,?,?,?,?,?,?, '', ?)
  `).run(
    id, transferNo, d.outletId, d.from.id, d.from.name, d.to.id, d.to.name,
    txnDate, d.notes, d.actor, at, d.clientKey, d.fingerprint, d.reversesTransferId, at,
  );
  const insLine = db.prepare(`
    INSERT INTO department_transfer_lines
      (id, transfer_id, material_id, material_name, unit, purchase_unit, pack_factor,
       qty_sent, entry_qty, entry_unit, out_txn_id, in_txn_id, reverses_line_id, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, '', '', ?,?,?)
  `);
  const stamp = db.prepare(`UPDATE department_transfer_lines SET out_txn_id = ?, in_txn_id = ? WHERE id = ?`);
  for (const p of d.lines) {
    const lineId = newId();
    insLine.run(
      lineId, id, p.m.id, p.m.name, String(p.m.unit || ''), String(p.m.purchase_unit || p.m.unit || ''),
      p.factor, p.qty, p.entryQty, p.entryUnit, p.reversesLineId, p.notes, nowMs(),
    );
    const posted = postDeptTransfer(db, {
      fromDepartmentId: d.from.id,
      toDepartmentId: d.to.id,
      materialId: p.m.id,
      quantity: p.qty,
      referenceId: lineId,
      user: d.actor,
      txnDate,
      outletId: d.outletId,
      notes: `${transferNo}${d.notes ? ` — ${d.notes}` : ''}`,
      source: d.reversesTransferId ? 'department-transfer:reverse' : 'department-transfer',
    });
    stamp.run(posted.outId, posted.inId, lineId);
  }
  return getDeptTransfer(db, id) as DeptTransferWithLines;
}

function validateClientKey(clientKey: string): void {
  if (!clientKey) {
    throw blocked('invalid', 'A transfer needs a client_key (minted once per send, re-sent unchanged on a retry) so a retry can never post twice.');
  }
  if (!CLIENT_KEY_RE.test(clientKey)) {
    throw blocked('invalid', 'client_key must be 8–120 characters of letters, digits, dot, underscore, colon or dash.');
  }
}

function resolveEnds(db: Database.Database, fromId: string, toId: string): { from: TransferDept; to: TransferDept } {
  if (!fromId || !toId) throw blocked('invalid', 'A transfer needs a sending and a receiving department.');
  if (fromId === toId) throw blocked('same_department', 'A department cannot transfer stock to itself.');
  const from = transferDept(db, fromId);
  const to = transferDept(db, toId);
  if (!from) throw blocked('unknown_department', `Sending department ${fromId} does not exist.`, { httpStatus: 404 });
  if (!to) throw blocked('unknown_department', `Receiving department ${toId} does not exist.`, { httpStatus: 404 });
  if (!Number(to.is_active)) {
    throw blocked('inactive_department', `${to.name} is switched off; stock sent there would be hidden from every live screen.`);
  }
  return { from, to };
}

/**
 * SEND — ONE STEP. In ONE IMMEDIATE transaction: the idempotency gate, then
 * the document, its lines and every line's transfer_out/transfer_in pair. When
 * this returns, the sender's ledger is down and the receiver's is up.
 *
 * Refuses (DeptTransferBlocked) on every invariant postDeptTransfer checks,
 * plus: no client key, no lines, a material listed twice, more than 50 lines.
 */
export function sendDeptTransfer(db: Database.Database, input: SendDeptTransferInput): SendDeptTransferResult {
  const run = db.transaction((): SendDeptTransferResult => {
    const fromId = String(input.fromDepartmentId || '').trim();
    const toId = String(input.toDepartmentId || '').trim();
    const actor = String(input.user || '').trim();
    const clientKey = String(input.clientKey || '').trim();
    if (!actor) throw blocked('invalid', 'A transfer needs the responsible user (the session user).');
    validateClientKey(clientKey);
    const rawLines = Array.isArray(input.lines) ? input.lines : [];

    // The request's identity: ends + goods as TYPED. Notes are not identity —
    // a retry of the same tray with the note retyped is still the same send.
    const fingerprint = JSON.stringify({
      kind: 'send', from: fromId, to: toId,
      lines: rawLines
        .map((l) => [String(l?.materialId || '').trim(), l?.unit === 'recipe' ? 'recipe' : 'purchase', Number(l?.quantity)])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    });
    const hit = idempotentHit(db, actor, clientKey, fingerprint);
    if (hit) return { transfer: hit, duplicate: true };

    const { from, to } = resolveEnds(db, fromId, toId);
    if (rawLines.length === 0) throw blocked('invalid', 'A transfer needs at least one line.');
    if (rawLines.length > 50) throw blocked('invalid', 'At most 50 lines per transfer.');

    const seen = new Set<string>();
    const prepared: PreparedLine[] = [];
    for (const ln of rawLines) {
      const matId = String(ln?.materialId || '').trim();
      if (!matId) throw blocked('invalid', 'Every transfer line needs a material.');
      if (seen.has(matId)) {
        throw blocked('invalid', 'A material appears on two lines of one transfer; put the total on one line.', { materialId: matId });
      }
      seen.add(matId);
      const m = transferMaterial(db, matId);
      if (!m) throw blocked('unknown_material', `Material ${matId} does not exist.`, { httpStatus: 404 });
      const storeMsg = storeRailBlock(db, m);
      if (storeMsg) throw blocked('store_mapped', storeMsg, { materialId: matId });
      const unit: TransferEntryUnit = ln.unit === 'recipe' ? 'recipe' : 'purchase';
      const entryQty = Number(ln.quantity);
      const qty = transferQtyToRecipe(m, entryQty, unit);
      if (!Number.isFinite(qty) || qty <= EPS) {
        throw blocked('invalid', `Quantity for ${m.name} must be a positive number.`, { materialId: matId });
      }
      prepared.push({
        m, qty, entryQty: Number.isFinite(entryQty) ? entryQty : null,
        entryUnit: unit === 'recipe' ? String(m.unit || '') : String(m.purchase_unit || m.unit || ''),
        factor: packFactor(m), notes: String(ln.notes || '').trim(), reversesLineId: '',
      });
    }

    const transfer = writeTransferDoc(db, {
      from, to, actor, clientKey, fingerprint,
      notes: String(input.notes || '').trim(), outletId: input.outletId ?? null,
      reversesTransferId: '', lines: prepared,
    });
    return { transfer, duplicate: false };
  });
  return run.immediate();
}

/* ── DISPUTE — records, alerts (route), moves NOTHING ───────────────────── */

export interface FlagDeptTransferDisputeInput {
  transferId: string;
  /** The SESSION user's email. */
  user: string;
  kind: DeptTransferDisputeKind;
  /** Required, in words. */
  reason: string;
  /**
   * Which lines. OMIT = every line still standing. For 'short' each listed line
   * needs `quantityReceived` — what DID arrive (0 ≤ it < what the line still
   * says arrived); the dispute is the difference. 'wrong_item' and
   * 'not_received' dispute the whole remaining line.
   */
  lines?: Array<{ lineId: string; quantityReceived?: number; unit?: TransferEntryUnit }>;
  /** Emails the ROUTE will alert, recorded on the dispute so the record says who was told. */
  alertRecipients?: string[];
}

/**
 * FLAG A DISPUTE. One IMMEDIATE transaction that writes dispute rows and the
 * document's dispute_status — and NOTHING on any ledger. The stock already
 * moved at send; whether it should move back is the sender's side's call, by
 * a reverse transfer. Refuses a line that already has an OPEN dispute (one
 * claim per line at a time) or that has been fully reversed.
 */
export function flagDeptTransferDispute(
  db: Database.Database, input: FlagDeptTransferDisputeInput,
): { transfer: DeptTransferWithLines; disputes: DeptTransferDisputeRow[] } {
  const run = db.transaction(() => {
    const id = String(input.transferId || '').trim();
    const actor = String(input.user || '').trim();
    const reason = String(input.reason || '').trim();
    const kind = String(input.kind || '').trim() as DeptTransferDisputeKind;
    if (!id) throw blocked('invalid', 'Which transfer?');
    if (!actor) throw blocked('invalid', 'Flagging needs the responsible user (the session user).');
    if (!DEPT_TRANSFER_DISPUTE_KINDS.includes(kind)) {
      throw blocked('invalid', `Say what is wrong: one of ${DEPT_TRANSFER_DISPUTE_KINDS.join(', ')}.`);
    }
    if (!reason) throw blocked('invalid', 'Say what happened — a dispute needs a reason the sender can act on.');
    if (reason.length > 1000) throw blocked('invalid', 'Keep the reason under 1,000 characters.');
    const doc = getDeptTransfer(db, id);
    if (!doc) throw blocked('state', `Transfer ${id} does not exist.`, { httpStatus: 404 });
    if (doc.status !== 'posted') throw blocked('state', `${doc.transfer_no} is ${doc.status}; only a posted transfer can be disputed.`);

    const byId = new Map(doc.lines.map((l) => [l.id, l]));
    const wanted = input.lines && input.lines.length > 0
      ? input.lines.map((a) => ({ a, line: byId.get(String(a?.lineId || '').trim()) }))
      : doc.lines.filter((l) => l.qty_net > EPS).map((line) => ({ a: undefined, line }));
    if (wanted.length === 0) throw blocked('state', `Nothing on ${doc.transfer_no} is left to dispute — every line has been reversed.`);
    if (kind === 'short' && !(input.lines && input.lines.length > 0)) {
      throw blocked('invalid', 'For a short delivery, say for each line how much DID arrive.');
    }

    const seenLines = new Set<string>();
    const rows: Array<{ line: DeptTransferLineRow; qty: number; entryQty: number | null; entryUnit: string }> = [];
    for (const { a, line } of wanted) {
      if (!line) throw blocked('invalid', `Line ${String(a?.lineId || '(blank)')} is not on ${doc.transfer_no}.`);
      if (seenLines.has(line.id)) throw blocked('invalid', `${line.material_name} is listed twice.`);
      seenLines.add(line.id);
      if (line.qty_net <= EPS) throw blocked('state', `${line.material_name} on ${doc.transfer_no} has already been reversed in full.`);
      if (doc.disputes.some((d) => d.line_id === line.id && d.status === 'open')) {
        throw blocked('state', `${line.material_name} on ${doc.transfer_no} already has an open dispute. It is with the sender.`);
      }
      const meta: PackMeta = { unit: line.unit, purchase_unit: line.purchase_unit, pack_size: line.pack_factor };
      if (kind === 'short') {
        const unit: TransferEntryUnit = a?.unit === 'recipe' ? 'recipe' : 'purchase';
        const got = transferQtyToRecipe(meta, Number(a?.quantityReceived), unit);
        if (a?.quantityReceived === undefined || a?.quantityReceived === null || !Number.isFinite(got) || got < -EPS) {
          throw blocked('invalid', `Say how much ${line.material_name} DID arrive (0 or more).`, { materialId: line.material_id });
        }
        if (got >= line.qty_net - EPS) {
          throw blocked(
            'invalid',
            `${line.material_name}: ${fmtDual(got, meta)} arrived and ${fmtDual(line.qty_net, meta)} was sent — nothing is short.`,
            { materialId: line.material_id },
          );
        }
        rows.push({
          line, qty: r6(line.qty_net - Math.max(0, got)),
          entryQty: Number(a?.quantityReceived),
          entryUnit: unit === 'recipe' ? line.unit : (line.purchase_unit || line.unit),
        });
      } else {
        rows.push({ line, qty: r6(line.qty_net), entryQty: null, entryUnit: '' });
      }
    }

    const recipients = (input.alertRecipients || []).map((s) => String(s || '').trim()).filter(Boolean).join(',').slice(0, 2000);
    const at = nowMs();
    const ins = db.prepare(`
      INSERT INTO department_transfer_disputes
        (id, transfer_id, line_id, kind, qty_disputed, entry_qty, entry_unit, reason, raised_by, raised_at,
         status, resolution, resolution_note, resolved_by, resolved_at, qty_reversed, reverse_transfer_id,
         alert_recipients)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'open', '', '', '', '', 0, '', ?)
    `);
    const newIds: string[] = [];
    for (const r of rows) {
      const did = newId();
      newIds.push(did);
      ins.run(did, doc.id, r.line.id, kind, r.qty, r.entryQty, r.entryUnit, reason, actor, at, recipients);
    }
    db.prepare(`UPDATE department_transfers SET dispute_status = 'open', updated_at = ? WHERE id = ?`).run(at, doc.id);
    const transfer = getDeptTransfer(db, doc.id) as DeptTransferWithLines;
    return { transfer, disputes: transfer.disputes.filter((d) => newIds.includes(d.id)) };
  });
  return run.immediate();
}

/**
 * CLOSE open disputes WITHOUT moving stock — the claim was withdrawn or found
 * wrong ("it was in the walk-in"). A note is required and kept. The ROUTE
 * decides who may (the person who raised it, managers, admin) and passes the
 * ids it authorised. disputeIds OMITTED = every open dispute; GIVEN = exactly
 * those, and a given-but-EMPTY list is refused (it names nothing).
 */
export function resolveDeptTransferDisputes(
  db: Database.Database, input: { transferId: string; user: string; note: string; disputeIds?: string[] },
): DeptTransferWithLines {
  const run = db.transaction((): DeptTransferWithLines => {
    const id = String(input.transferId || '').trim();
    const actor = String(input.user || '').trim();
    const note = String(input.note || '').trim();
    if (!id) throw blocked('invalid', 'Which transfer?');
    if (!actor) throw blocked('invalid', 'Closing a dispute needs the responsible user (the session user).');
    if (!note) throw blocked('invalid', 'Say why the dispute is being closed without moving anything back.');
    const doc = getDeptTransfer(db, id);
    if (!doc) throw blocked('state', `Transfer ${id} does not exist.`, { httpStatus: 404 });
    const open = doc.disputes.filter((d) => d.status === 'open');
    // GIVEN means "exactly these", and an empty list names NOTHING — it must
    // never fall through to "every open dispute". Only an OMITTED list means
    // all open disputes (the route always passes the ids it authorised).
    const want = input.disputeIds !== undefined && input.disputeIds !== null
      ? new Set((Array.isArray(input.disputeIds) ? input.disputeIds : []).map(String))
      : null;
    if (want && want.size === 0) {
      throw blocked('invalid', 'No dispute named — an empty list closes nothing.');
    }
    const target = want ? open.filter((d) => want.has(d.id)) : open;
    if (want && target.length !== want.size) {
      throw blocked('state', `One or more of those disputes is not open on ${doc.transfer_no}.`);
    }
    if (target.length === 0) throw blocked('state', `${doc.transfer_no} has no open dispute to close.`);
    const at = nowMs();
    const upd = db.prepare(`
      UPDATE department_transfer_disputes
         SET status = 'resolved', resolution = 'dismissed', resolution_note = ?, resolved_by = ?, resolved_at = ?
       WHERE id = ? AND status = 'open'
    `);
    for (const d of target) upd.run(note, actor, at, d.id);
    refreshDisputeStatus(db, doc.id, at);
    return getDeptTransfer(db, doc.id) as DeptTransferWithLines;
  });
  return run.immediate();
}

function refreshDisputeStatus(db: Database.Database, transferId: string, at: string): void {
  const r = db.prepare(`
    SELECT SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_n, COUNT(*) AS n
      FROM department_transfer_disputes WHERE transfer_id = ?
  `).get(transferId) as { open_n: number | null; n: number };
  const status: DeptTransferDisputeStatus = Number(r?.open_n) > 0 ? 'open' : Number(r?.n) > 0 ? 'resolved' : '';
  db.prepare(`UPDATE department_transfers SET dispute_status = ?, updated_at = ? WHERE id = ?`).run(status, at, transferId);
}

/* ── REVERSE — the one correction ───────────────────────────────────────── */

/**
 * What a one-tap (prefill) reverse MEANS, worked out from the document:
 *   'disputed'  a claim is open on it — the tap settles that claim with the
 *               disputed amounts (the goods never reached the receiver's shelf:
 *               a correction on paper);
 *   'standing'  no claim is open — the tap returns what the lines still have
 *               standing (goods on the receiver's shelf, carried back).
 * access.ts reversePrefill() stamps it on every prefill line; the screen echoes
 * it back in `expect` (see "A STALE TAP MOVES NOTHING").
 */
export type DeptReverseBasis = 'disputed' | 'standing';

export interface ReverseDeptTransferInput {
  /** The transfer being corrected. */
  transferId: string;
  /** The SESSION user's email. */
  user: string;
  /** REQUIRED, as on a send — a retried tap returns the reverse it already made. */
  clientKey: string;
  /**
   * Per line, in the unit given (default 'purchase'). OMIT = the prefill: each
   * line's OPEN disputed quantity — or, with 'receiver' authority and no open
   * dispute, everything the line still has standing, but ONLY when `expect`
   * says that is what the screen showed (see "A STALE TAP MOVES NOTHING").
   */
  lines?: Array<{ lineId: string; quantity: number; unit?: TransferEntryUnit }>;
  /**
   * The prefill the caller's SCREEN showed when the tap was made —
   * permissions.reverse_prefill echoed back as { lineId, quantity, basis } in
   * RECIPE units (the prefill's own `quantity` field, never converted). Used
   * only when `lines` is omitted. When the prefill worked out now differs from
   * it in any line or quantity — or in what it means (`basis`, when given) —
   * the reverse is refused ('stale', 409) and nothing moves. Omitted = the
   * caller saw no screen: the prefill then settles an OPEN dispute only, and is
   * refused when none is open.
   */
  expect?: Array<{ lineId: string; quantity: number; basis?: DeptReverseBasis }>;
  /**
   * Decided by the ROUTE from who is asking:
   *   'receiver'      may send from the ORIGINAL RECEIVER (it is a send from
   *                   there): up to what each line still has standing.
   *   'disputed_only' acting for the ORIGINAL SENDER on the receiver's own
   *                   claim: only lines with an open dispute, up to its amount.
   */
  authority: 'receiver' | 'disputed_only';
  notes?: string;
  outletId?: string | null;
}

/**
 * REVERSE: receiver → sender, the same goods, one step, through the same
 * writer and the same checks (the original RECEIVER must hold what goes back).
 * Each reverse line carries reverses_line_id; a line can never be reversed by
 * more than it moved. Open disputes on the reversed lines are settled oldest
 * first; a dispute is resolved once what was reversed covers what was claimed.
 * A disputed line that either end has COUNTED since it moved is refused
 * ('counted_since', 409) and left out of the prefill — the count already
 * corrected that book (see "a correction must not correct twice"). A one-tap
 * (prefill) reverse whose prefill differs from what the caller's screen showed
 * (`expect`: the quantities, and whether they settle a claim or return goods),
 * or — with no screen — finds no open dispute, is refused
 * ('stale', 409): see "A STALE TAP MOVES NOTHING" inside.
 */
export function reverseDeptTransfer(
  db: Database.Database, input: ReverseDeptTransferInput,
): SendDeptTransferResult & { original: DeptTransferWithLines } {
  const run = db.transaction(() => {
    const origId = String(input.transferId || '').trim();
    const actor = String(input.user || '').trim();
    const clientKey = String(input.clientKey || '').trim();
    if (!origId) throw blocked('invalid', 'Which transfer?');
    if (!actor) throw blocked('invalid', 'A reverse needs the responsible user (the session user).');
    validateClientKey(clientKey);
    const authority = input.authority === 'receiver' ? 'receiver' : 'disputed_only';

    const fingerprint = JSON.stringify({
      kind: 'reverse', of: origId,
      lines: input.lines && input.lines.length > 0
        ? input.lines
          .map((l) => [String(l?.lineId || '').trim(), l?.unit === 'recipe' ? 'recipe' : 'purchase', Number(l?.quantity)])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        : 'prefill',
    });
    const hit = idempotentHit(db, actor, clientKey, fingerprint);
    if (hit) {
      return { transfer: hit, duplicate: true, original: getDeptTransfer(db, origId) as DeptTransferWithLines };
    }

    const orig = getDeptTransfer(db, origId);
    if (!orig) throw blocked('state', `Transfer ${origId} does not exist.`, { httpStatus: 404 });
    if (orig.status !== 'posted') throw blocked('state', `${orig.transfer_no} is ${orig.status}; nothing to reverse.`);

    const byId = new Map(orig.lines.map((l) => [l.id, l]));
    const plan: Array<{ line: DeptTransferLineRow; qty: number; entryQty: number | null; entryUnit: string }> = [];
    if (input.lines && input.lines.length > 0) {
      const seen = new Set<string>();
      for (const a of input.lines) {
        const line = byId.get(String(a?.lineId || '').trim());
        if (!line) throw blocked('invalid', `Line ${String(a?.lineId || '(blank)')} is not on ${orig.transfer_no}.`);
        if (seen.has(line.id)) throw blocked('invalid', `${line.material_name} is listed twice.`);
        seen.add(line.id);
        const meta: PackMeta = { unit: line.unit, purchase_unit: line.purchase_unit, pack_size: line.pack_factor };
        const unit: TransferEntryUnit = a?.unit === 'recipe' ? 'recipe' : 'purchase';
        const q = transferQtyToRecipe(meta, Number(a?.quantity), unit);
        if (!Number.isFinite(q) || q <= EPS) {
          throw blocked('invalid', `Quantity to send back for ${line.material_name} must be a positive number.`, { materialId: line.material_id });
        }
        plan.push({ line, qty: q, entryQty: Number(a.quantity), entryUnit: unit === 'recipe' ? line.unit : (line.purchase_unit || line.unit) });
      }
    } else {
      // THE PREFILL. With an open dispute on the document: exactly the
      // disputed quantities, and nothing on an undisputed line. With none (a
      // receiver sending back of its own accord): everything still standing.
      // A disputed line COUNTED since it moved is left out — reversing it would
      // correct it twice (see "a correction must not correct twice" below);
      // access.ts reversePrefill() leaves out exactly the same lines.
      const anyOpen = orig.lines.some((l) => l.qty_open_disputed > EPS);
      for (const line of orig.lines) {
        const q = anyOpen ? (line.counted_since ? 0 : line.qty_open_disputed) : (authority === 'receiver' ? line.qty_net : 0);
        if (q > EPS) plan.push({ line, qty: r6(q), entryQty: null, entryUnit: '' });
      }
    }
    // ── a correction must not correct twice ───────────────────────────────
    // Any planned line that answers an OPEN dispute and was counted since it
    // moved is refused outright (explicit lines), and a prefill left with
    // nothing BECAUSE of that says why rather than "no open dispute".
    {
      const counted = (input.lines && input.lines.length > 0 ? plan.map((p) => p.line) : orig.lines)
        .filter((l) => l.qty_open_disputed > EPS && !!l.counted_since);
      if (counted.length > 0 && (plan.length === 0 || plan.some((p) => counted.some((c) => c.id === p.line.id)))) {
        const msg = deptTransferCountedSinceMessage({ ...orig, lines: counted });
        throw blocked('counted_since', msg || `${orig.transfer_no} was counted since it moved; reversing it would correct it twice.`, {
          materialId: counted[0].material_id, requested: counted[0].qty_open_disputed, available: 0,
        });
      }
    }
    // ── A STALE TAP MOVES NOTHING ─────────────────────────────────────────
    // The one-tap prefill is worked out HERE, at tap time, and it changes
    // meaning when the claim is settled: while a dispute is open it is the
    // disputed amount (a PAPER correction — the goods never reached the
    // receiver's shelf), and once none is open it is everything the line still
    // has standing (a PHYSICAL return). A screen loaded before someone else
    // settled the claim still says "Send back 0.5 kg"; its tap then moved the
    // whole standing line although nobody carried anything. Measured
    // (conservation verifier, targeted.cjs C / C2 / C3): Kitchen → Akan
    // Tandoori 4 kg, 3.5 arrived, 0.5 flagged; the Tandoori HOD sends the 0.5
    // back; the Kitchen HOD's stale "0.5" tap (he may send from Akan Tandoori
    // too, ruling #40) moved 3.5 kg — books Kitchen 10 / Tandoori 0 against
    // shelves 6.5 / 3.5. So the screen says what it showed (`expect`) and a
    // tap whose prefill has changed since is refused, nothing written; a
    // caller with no screen gets the disputed amounts only — a whole-line
    // return must be asked for (`expect` showing it, or `lines`).
    //
    // THE QUANTITY ALONE IS NOT ENOUGH. A claim of the WHOLE line ("not
    // received", 4 of 4 kg) offers "Send back 4 kg" while it is open; once a
    // manager closes it ("found it in the walk-in") the standing line is 4 kg
    // too, so the same figure is on offer with the opposite meaning — the old
    // screen's tap would take 4 kg off a shelf that holds them, as a paper
    // correction nobody carried. So `expect` also says what the screen meant
    // (`basis`), and a different meaning now is refused like a different
    // quantity.
    if (!(input.lines && input.lines.length > 0)) {
      const anyOpen = orig.lines.some((l) => l.qty_open_disputed > EPS);
      const basisNow: DeptReverseBasis = anyOpen ? 'disputed' : 'standing';
      const nowText = plan.map((p) => `${fmtDual(p.qty, { unit: p.line.unit, purchase_unit: p.line.purchase_unit, pack_size: p.line.pack_factor })} ${p.line.material_name}`).join(' + ');
      const settled = deptTransferSettledNote(db, orig);
      if (input.expect === undefined) {
        if (!anyOpen) {
          throw blocked('stale',
            `${orig.transfer_no} has no open dispute to settle. Nothing moved.` +
            `${settled ? ` Latest on its claims: ${settled}.` : ''} ` +
            `To send goods back of ${orig.to_department_name}'s own accord, choose them on the transfer (Send back) ` +
            `or name the lines.`);
        }
      } else {
        const want = new Map<string, number>();
        let basisShown: DeptReverseBasis | null = null;
        for (const e of input.expect) {
          const id = String(e?.lineId || '').trim();
          const q = Number(e?.quantity);
          if (!id || !Number.isFinite(q) || q < 0) {
            throw blocked('invalid', 'expect must list { line_id, quantity } as the screen showed them (quantity in the recipe unit, 0 or more).');
          }
          if (e?.basis !== undefined && e?.basis !== null) {
            if (e.basis !== 'disputed' && e.basis !== 'standing') {
              throw blocked('invalid', "expect: basis must be 'disputed' or 'standing', as the screen's prefill said.");
            }
            if (basisShown && basisShown !== e.basis) {
              throw blocked('invalid', 'expect: every line carries the same basis (the screen showed one send-back).');
            }
            basisShown = e.basis;
          }
          if (q > EPS) want.set(id, r6((want.get(id) || 0) + q));
        }
        const have = new Map(plan.map((p) => [p.line.id, r6(p.qty)]));
        const same = want.size === have.size
          && [...want].every(([id, q]) => have.has(id) && Math.abs((have.get(id) as number) - q) <= 1e-6)
          && (basisShown == null || basisShown === basisNow);
        if (!same) {
          const shown = [...want].map(([id, q]) => {
            const l = byId.get(id);
            return l ? `${fmtDual(q, { unit: l.unit, purchase_unit: l.purchase_unit, pack_size: l.pack_factor })} ${l.material_name}` : `${fmt(q)} (a line not on ${orig.transfer_no})`;
          }).join(' + ') || 'nothing';
          const offered = basisShown === 'disputed'
            ? `The screen offered to settle the claim by sending back ${shown}`
            : basisShown === 'standing'
              ? `The screen offered to return ${shown}, with no claim open`
              : `The screen offered to send back ${shown}`;
          const now = plan.length === 0
            ? 'nothing is left to send back now'
            : basisNow === 'disputed'
              ? `a send-back now would settle the open claim with ${nowText}`
              : `no claim is open now, so a send-back would return ${nowText} off ${orig.to_department_name}'s shelf`;
          throw blocked('stale',
            `${orig.transfer_no} changed after this screen was loaded. ${offered}; ${now}. Nothing moved.` +
            `${settled ? ` Latest on its claims: ${settled}.` : ''} ` +
            `Look at the transfer again${plan.length === 0 ? '' : basisNow === 'disputed'
              ? ' and tap again only if the claim is right'
              : ' and tap again only if those goods really are going back'}.`);
        }
      }
    }
    if (plan.length === 0) {
      throw blocked('state', authority === 'receiver'
        ? `Nothing on ${orig.transfer_no} is left to send back.`
        : `${orig.transfer_no} has no open dispute to reverse.`);
    }

    // ── caps — a reverse can never move more than the line moved ──────────
    for (const p of plan) {
      const meta: PackMeta = { unit: p.line.unit, purchase_unit: p.line.purchase_unit, pack_size: p.line.pack_factor };
      const cap = authority === 'receiver' ? p.line.qty_net : p.line.qty_open_disputed;
      if (p.qty > cap + EPS) {
        throw blocked(
          authority === 'receiver' ? 'invalid' : 'state',
          authority === 'receiver'
            ? `Cannot send back ${fmtDual(p.qty, meta)} of ${p.line.material_name}: ${orig.transfer_no} moved ` +
              `${fmtDual(p.line.qty_sent, meta)} and ${fmtDual(p.line.qty_reversed, meta)} has already gone back. ` +
              `Send back ${fmtDual(Math.max(0, cap), meta)} or less.`
            : `Only the disputed ${fmtDual(Math.max(0, cap), meta)} of ${p.line.material_name} can be reversed from ` +
              `${orig.from_department_name}'s side; anything more is a new transfer from ${orig.to_department_name}.`,
          { materialId: p.line.material_id, requested: p.qty, available: Math.max(0, cap) },
        );
      }
    }

    const { from, to } = resolveEnds(db, orig.to_department_id, orig.from_department_id);
    const prepared: PreparedLine[] = plan.map((p) => {
      const m = transferMaterial(db, p.line.material_id);
      if (!m) throw blocked('unknown_material', `Material ${p.line.material_id} no longer exists.`, { httpStatus: 404 });
      const pm: PackMeta = { unit: p.line.unit, purchase_unit: p.line.purchase_unit, pack_size: p.line.pack_factor };
      return {
        m, qty: r6(p.qty),
        entryQty: p.entryQty != null && Number.isFinite(p.entryQty) ? p.entryQty : toPurchaseQty(p.qty, pm),
        entryUnit: p.entryUnit || (p.line.purchase_unit || p.line.unit),
        factor: packFactor(m), notes: '', reversesLineId: p.line.id,
      };
    });

    let transfer: DeptTransferWithLines;
    try {
      transfer = writeTransferDoc(db, {
        from, to, actor, clientKey, fingerprint,
        notes: (`Reverses ${orig.transfer_no}` + (String(input.notes || '').trim() ? ` — ${String(input.notes).trim()}` : '')),
        outletId: input.outletId ?? orig.outlet_id ?? null,
        reversesTransferId: orig.id, lines: prepared,
      });
    } catch (e) {
      if (isDeptTransferBlocked(e) && e.reason === 'insufficient') {
        throw blocked('insufficient',
          `${e.message} If ${orig.to_department_name} has been COUNTED since ${orig.transfer_no} and the count ` +
          `left these goods out, they never reached its shelf and are still at ${orig.from_department_name}: ` +
          `record a count for ${orig.from_department_name} instead of reversing.`,
          { materialId: e.materialId, requested: e.requested, available: e.available });
      }
      throw e;
    }

    // ── settle the disputes the reverse answers, oldest first ─────────────
    const at = nowMs();
    const settle = db.prepare(`
      UPDATE department_transfer_disputes
         SET qty_reversed = ?, reverse_transfer_id = ?,
             status = CASE WHEN ? THEN 'resolved' ELSE status END,
             resolution = CASE WHEN ? THEN 'reversed' ELSE resolution END,
             resolved_by = CASE WHEN ? THEN ? ELSE resolved_by END,
             resolved_at = CASE WHEN ? THEN ? ELSE resolved_at END
       WHERE id = ?
    `);
    for (const p of plan) {
      let left = p.qty;
      const open = orig.disputes.filter((d) => d.line_id === p.line.id && d.status === 'open');
      for (const d of open) {
        if (left <= EPS) break;
        const need = r6(d.qty_disputed - d.qty_reversed);
        const take = r6(Math.min(left, need));
        left = r6(left - take);
        const done = take >= need - EPS ? 1 : 0;
        settle.run(r6(d.qty_reversed + take), transfer.id, done, done, done, actor, done, at, d.id);
      }
    }
    refreshDisputeStatus(db, orig.id, at);
    return { transfer, duplicate: false, original: getDeptTransfer(db, orig.id) as DeptTransferWithLines };
  });
  return run.immediate();
}

/* ── a correction must not correct twice ─────────────────────────────────────
 * A reverse that ANSWERS A DISPUTE is a paper correction: the disputed goods
 * never reached the receiver's shelf (short / not received / the wrong item
 * came), so moving them back puts the books where the shelves already are.
 * That is only true while both books still carry the original legs.
 *
 * A COUNT ENDS THAT. Under "A TRANSFER PAIR IS NEVER SPLIT" (deptOnHand) a leg
 * dated before its own department's anchor is ABSORBED: the count measured the
 * shelf with the goods already on (or already off) it. So:
 *   · the RECEIVER counted after the send → its count holds only what arrived;
 *     the shortfall is ALREADY off its books, and a reverse takes it off again.
 *     Measured (xfer-rulings-v countrev.cjs): Kitchen sends 1 kg, Tandoori
 *     counts 0.8, flags 0.2 short, Kitchen's HOD takes back 0.2 → Tandoori's
 *     books 0.6 against 0.8 on the shelf; 0.2 kg in no ledger at all.
 *   · the SENDER counted after the send → its count already holds whatever
 *     never left; a reverse adds it again.
 * Either way one physical kilo would no longer live in exactly one ledger, so
 * the reverse is refused (reason 'counted_since') and the prefill leaves the
 * line out. The fix is the count on the side that has NOT counted (when the
 * goods are still somewhere), then closing the dispute with a note — nothing
 * moves; deptTransferCountedSinceMessage() says exactly that.
 *
 * A send-back with NO open dispute is a PHYSICAL return — the goods are on the
 * receiver's shelf now and move now — so a count in between is right and is
 * not checked. Only the disputed (paper) part of a reverse is guarded.
 *
 * The window test is the ledger's own (anchorWindow: legFrom, and the rowid
 * tie-break for an opening anchor), so this cannot disagree with a balance.
 */

/** The anchor that ABSORBED this ledger row (its department's count / opening
 *  row is at or after it, by the transfer-leg window), or null when the row
 *  still stands in its balance — or does not exist. */
function legAbsorbedBy(db: Database.Database, txnId: string): DeptTransferAnchorAfterLeg | null {
  const id = String(txnId || '').trim();
  if (!id) return null;
  try {
    const row = db.prepare(`
      SELECT rowid AS rid, department_id, material_id, ${LEDGER_TS_SQL} AS at
        FROM department_material_transactions WHERE id = ?
    `).get(id) as { rid: number; department_id: string; material_id: string; at: string } | undefined;
    if (!row) return null;
    const w = anchorWindow(db, String(row.department_id), String(row.material_id));
    if (!w.anchor || !w.legFrom) return null;            // never counted: every leg stands
    const at = String(row.at);
    const stands = at > w.legFrom || (w.legTieRowid != null && at === w.legFrom && Number(row.rid) > w.legTieRowid);
    return stands ? null : { at: w.legFrom, source: w.anchor.source };
  } catch { return null; }
}

/** Both ends of one transfer line: which (if either) has counted since it moved. */
export function transferCountedSince(db: Database.Database, outTxnId: string, inTxnId: string): DeptTransferCountedSince | null {
  const sender = legAbsorbedBy(db, outTxnId);
  const receiver = legAbsorbedBy(db, inTxnId);
  return sender || receiver ? { sender, receiver } : null;
}

/**
 * The words for a refused correction — ONE sentence per disputed line that was
 * counted since it moved, saying what is already true and what to do instead.
 * The reverse refusal and the screen (permissions.reverse_blocked) both print
 * this, so they cannot disagree. null when no disputed line is affected.
 */
export function deptTransferCountedSinceMessage(doc: DeptTransferWithLines): string | null {
  const parts: string[] = [];
  const from = doc.from_department_name;
  const to = doc.to_department_name;
  const did = (a: DeptTransferAnchorAfterLeg) => (a.source === 'opening' ? 'took its cutover opening count of' : 'counted');
  for (const l of doc.lines) {
    const c = l.counted_since;
    if (!c || l.qty_open_disputed <= EPS) continue;
    const q = fmtDual(l.qty_open_disputed, { unit: l.unit, purchase_unit: l.purchase_unit, pack_size: l.pack_factor });
    if (c.receiver && c.sender) {
      parts.push(
        `${from} and ${to} have both counted ${l.material_name} since ${doc.transfer_no} was sent, so both books ` +
        `already match their shelves and the disputed ${q} is already accounted for. Taking it back would correct it ` +
        `a second time. Close the dispute with a note — nothing needs to move.`);
    } else if (c.receiver) {
      parts.push(
        `${to} ${did(c.receiver)} ${l.material_name} after ${doc.transfer_no} was sent, so its books already hold only ` +
        `what reached its shelf: the disputed ${q} is already off them. Taking it back would take it off a second time. ` +
        `If the ${q} is still at ${from}, record a count for ${from}; then close the dispute with a note — nothing moves.`);
    } else if (c.sender) {
      parts.push(
        `${from} ${did(c.sender)} ${l.material_name} after ${doc.transfer_no} was sent, so its books already hold what is ` +
        `on its shelf, including the disputed ${q} if it never left. Taking it back would add it a second time. ` +
        `Record a count for ${to} so its books come down to what arrived; then close the dispute with a note — nothing moves.`);
    }
  }
  if (parts.length === 0) return null;
  // Who closes it — access.ts canDismissDispute: the flagger, a manager or an
  // admin at any time; the RECEIVING department's head once BOTH have counted
  // (never the sender's head — the claim is against his own department).
  return `${parts.join(' ')} The person who flagged it, a manager or an admin can close it; once both ` +
    `${from} and ${to} have counted it, ${to}'s head can close it too.`;
}

/** A ledger / document UTC stamp ('YYYY-MM-DD HH:MM:SS[.mmm]') as IST
 *  'YYYY-MM-DD HH:MM IST', for an operator-facing sentence. '' for junk. */
function istStamp(v: unknown, seconds = false): string {
  const s = normTs(v);
  if (!s) return '';
  const ms = Date.parse(`${s.replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms)) return '';
  return `${new Date(ms + 5.5 * 3600e3).toISOString().slice(0, seconds ? 19 : 16).replace('T', ' ')} IST`;
}

/**
 * How the claims on one document were SETTLED, newest first (at most two), for
 * the refusal a stale one-tap reverse gets: "the 0.5 kg short claim on HX
 * CHICKEN was settled at 2026-10-21 10:31 IST: 0.5 kg went back against it
 * (the send-back that settled it: DTR-2026-0002, by a@b)", or "… was closed at
 * … by a@b (“found it”) with nothing sent back". Every clause is what the rows
 * say — the amount is the claim's total sent back (one send-back or several),
 * the document and person are the ones that settled it. '' when nothing on it
 * has been settled. Never throws.
 */
export function deptTransferSettledNote(db: Database.Database, doc: DeptTransferWithLines): string {
  try {
    const done = doc.disputes
      .filter((d) => d.status === 'resolved')
      .sort((a, b) => String(b.resolved_at || '').localeCompare(String(a.resolved_at || '')))
      .slice(0, 2);
    const parts = done.map((d) => {
      const l = doc.lines.find((x) => x.id === d.line_id);
      const meta: PackMeta = { unit: l?.unit || '', purchase_unit: l?.purchase_unit || '', pack_size: l?.pack_factor || 1 };
      const what = `the ${fmtDual(d.qty_disputed, meta)} ${String(d.kind || '').replace(/_/g, ' ')} claim on ${l?.material_name || 'a line'}`;
      const when = istStamp(d.resolved_at);
      const back = Number(d.qty_reversed) || 0;
      if (d.resolution === 'reversed') {
        const rev = d.reverse_transfer_id
          ? db.prepare(`SELECT transfer_no FROM department_transfers WHERE id = ?`).get(d.reverse_transfer_id) as { transfer_no: string } | undefined
          : undefined;
        const by = d.resolved_by ? `by ${d.resolved_by}` : '';
        const last = rev?.transfer_no ? `the send-back that settled it: ${rev.transfer_no}${by ? `, ${by}` : ''}` : by;
        return `${what} was settled${when ? ` at ${when}` : ''}: ${fmtDual(back, meta)} went back against it` +
          `${last ? ` (${last})` : ''}`;
      }
      return `${what} was closed${when ? ` at ${when}` : ''} by ${d.resolved_by || 'someone'}` +
        `${d.resolution_note ? ` (“${d.resolution_note}”)` : ''}` +
        (back > EPS ? ` after ${fmtDual(back, meta)} had gone back against it` : ' with nothing sent back');
    });
    return parts.join('; ');
  } catch { return ''; }
}

/* ── reading ────────────────────────────────────────────────────────────── */

/** One transfer document with its lines (reversed / net / disputed figures
 *  computed), its disputes and its reverse links, or null. */
export function getDeptTransfer(db: Database.Database, transferId: string): DeptTransferWithLines | null {
  try {
    const doc = db.prepare(`
      SELECT id, transfer_no, outlet_id, from_department_id, from_department_name,
             to_department_id, to_department_name, status, txn_date, notes, created_by, created_at,
             client_key, reverses_transfer_id, dispute_status, updated_at
        FROM department_transfers WHERE id = ?
    `).get(String(transferId || '')) as DeptTransferRow | undefined;
    if (!doc) return null;
    const rawLines = db.prepare(`
      SELECT id, transfer_id, material_id, material_name, unit, purchase_unit, pack_factor, qty_sent,
             entry_qty, entry_unit, out_txn_id, in_txn_id, reverses_line_id, notes, created_at
        FROM department_transfer_lines WHERE transfer_id = ? ORDER BY created_at ASC, rowid ASC
    `).all(doc.id) as Array<Omit<DeptTransferLineRow, 'qty_reversed' | 'qty_net' | 'qty_open_disputed' | 'counted_since'>>;
    const disputes = db.prepare(`
      SELECT id, transfer_id, line_id, kind, qty_disputed, entry_qty, entry_unit, reason, raised_by, raised_at,
             status, resolution, resolution_note, resolved_by, resolved_at, qty_reversed, reverse_transfer_id,
             alert_recipients
        FROM department_transfer_disputes WHERE transfer_id = ? ORDER BY raised_at ASC, rowid ASC
    `).all(doc.id) as DeptTransferDisputeRow[];
    const reversedByLine = new Map<string, number>();
    if (rawLines.length > 0) {
      const rows = db.prepare(`
        SELECT l.reverses_line_id AS lid, COALESCE(SUM(l.qty_sent), 0) AS q
          FROM department_transfer_lines l JOIN department_transfers t ON t.id = l.transfer_id
         WHERE t.status = 'posted' AND l.reverses_line_id IN (SELECT value FROM json_each(?))
         GROUP BY l.reverses_line_id
      `).all(JSON.stringify(rawLines.map((l) => l.id))) as Array<{ lid: string; q: number }>;
      for (const r of rows) reversedByLine.set(String(r.lid), r6(Number(r.q) || 0));
    }
    const lines: DeptTransferLineRow[] = rawLines.map((l) => {
      const rev = reversedByLine.get(l.id) || 0;
      const openDisputed = disputes
        .filter((d) => d.line_id === l.id && d.status === 'open')
        .reduce((s, d) => s + Math.max(0, (Number(d.qty_disputed) || 0) - (Number(d.qty_reversed) || 0)), 0);
      const net = r6(l.qty_sent - rev);
      const qtyOpenDisputed = r6(Math.min(openDisputed, Math.max(0, net)));
      return {
        ...l, qty_reversed: rev, qty_net: net, qty_open_disputed: qtyOpenDisputed,
        // Only a disputed line can be reversed as a CORRECTION, so only it pays
        // for the two anchor look-ups (lists stay cheap).
        counted_since: qtyOpenDisputed > EPS ? transferCountedSince(db, l.out_txn_id, l.in_txn_id) : null,
      };
    });
    const reversedBy = db.prepare(`
      SELECT id, transfer_no, created_at, created_by FROM department_transfers
       WHERE reverses_transfer_id = ? AND status = 'posted' ORDER BY created_at ASC, rowid ASC
    `).all(doc.id) as Array<{ id: string; transfer_no: string; created_at: string; created_by: string }>;
    let reversesNo = '';
    if (doc.reverses_transfer_id) {
      const r = db.prepare('SELECT transfer_no FROM department_transfers WHERE id = ?').get(doc.reverses_transfer_id) as { transfer_no: string } | undefined;
      reversesNo = String(r?.transfer_no || '');
    }
    return { ...doc, lines, disputes, reverses_transfer_no: reversesNo, reversed_by: reversedBy };
  } catch { return null; }
}

/**
 * Transfers with an OPEN dispute out of these departments (null = every
 * department) — the number the bell / list shows the sender's side.
 */
export function countOpenDeptTransferDisputes(db: Database.Database, fromDepartmentIds: string[] | null): number {
  try {
    if (fromDepartmentIds && fromDepartmentIds.length === 0) return 0;
    const row = fromDepartmentIds
      ? db.prepare(`
          SELECT COUNT(*) AS n FROM department_transfers
           WHERE dispute_status = 'open' AND from_department_id IN (SELECT value FROM json_each(?))
        `).get(JSON.stringify(fromDepartmentIds))
      : db.prepare(`SELECT COUNT(*) AS n FROM department_transfers WHERE dispute_status = 'open'`).get();
    return Number((row as { n: number } | undefined)?.n) || 0;
  } catch { return 0; }
}

/* ── the integrity check ────────────────────────────────────────────────── */

export interface DeptTransferIntegrityIssue {
  issue:
    | 'unpaired'                // a reference with ≠ 1 out leg or ≠ 1 in leg
    | 'qty_mismatch'            // out + in ≠ 0
    | 'material_mismatch'
    | 'same_department'
    | 'no_reference'
    | 'orphan_legs'             // legs whose reference is no transfer line
    | 'line_missing_legs'       // a line of a posted document with no ledger pair
    | 'line_leg_ids'            // the line's out/in ids do not name its legs
    | 'line_qty_mismatch'       // line.qty_sent ≠ the posted pair's quantity
    | 'leg_department_mismatch' // a leg on a department the document does not name
    | 'legs_on_unposted'        // legs whose document is not 'posted'
    | 'reverse_direction'       // a reverse line not going receiver → sender
    | 'over_reversed';          // reverses of one line exceed what it moved
  reference_id: string;
  detail: string;
}

/**
 * Pair integrity for the transfer rail. Every transfer_out must have exactly
 * one transfer_in under the same reference_id, same material, opposite and
 * equal quantity, different department; every line of a posted document must
 * point at its pair, on the document's own two departments; a reverse may
 * never exceed the line it corrects. An empty `issues` is the proof that no
 * kilo was left in two ledgers or none. Read-only. Called by
 * /api/department-ledger/check.
 */
export function checkDeptTransferPairs(db: Database.Database): {
  pairs: number; legs: number; lines: number; issues: DeptTransferIntegrityIssue[];
} {
  const issues: DeptTransferIntegrityIssue[] = [];
  let legs: Array<{ id: string; reference_id: string | null; type: string; department_id: string; material_id: string; quantity: number }> = [];
  try {
    legs = db.prepare(`
      SELECT id, reference_id, type, department_id, material_id, quantity
        FROM department_material_transactions WHERE type IN (${DEPT_TRANSFER_TYPES_SQL})
    `).all() as typeof legs;
  } catch { return { pairs: 0, legs: 0, lines: 0, issues }; }

  const byRef = new Map<string, typeof legs>();
  for (const l of legs) {
    const ref = String(l.reference_id || '').trim();
    if (!ref) {
      issues.push({ issue: 'no_reference', reference_id: '', detail: `Leg ${l.id} (${l.type}) has no reference_id.` });
      continue;
    }
    const arr = byRef.get(ref) || [];
    arr.push(l);
    byRef.set(ref, arr);
  }
  let pairs = 0;
  const pair = new Map<string, { out: (typeof legs)[number]; in: (typeof legs)[number] }>();
  for (const [ref, arr] of byRef) {
    const outs = arr.filter((l) => l.type === 'transfer_out');
    const ins = arr.filter((l) => l.type === 'transfer_in');
    if (outs.length !== 1 || ins.length !== 1) {
      issues.push({ issue: 'unpaired', reference_id: ref, detail: `${outs.length} out leg(s) and ${ins.length} in leg(s); expected exactly one of each.` });
      continue;
    }
    const o = outs[0], i = ins[0];
    if (Math.abs((Number(o.quantity) || 0) + (Number(i.quantity) || 0)) > 1e-6) {
      issues.push({ issue: 'qty_mismatch', reference_id: ref, detail: `out ${o.quantity} + in ${i.quantity} ≠ 0.` });
    }
    if (o.material_id !== i.material_id) {
      issues.push({ issue: 'material_mismatch', reference_id: ref, detail: `out ${o.material_id} vs in ${i.material_id}.` });
    }
    if (o.department_id === i.department_id) {
      issues.push({ issue: 'same_department', reference_id: ref, detail: `Both legs are on department ${o.department_id}.` });
    }
    pairs++;
    pair.set(ref, { out: o, in: i });
  }

  let lineCount = 0;
  try {
    const lines = db.prepare(`
      SELECT l.id, l.material_id, l.qty_sent, l.out_txn_id, l.in_txn_id, l.reverses_line_id,
             t.status, t.transfer_no, t.from_department_id, t.to_department_id
        FROM department_transfer_lines l JOIN department_transfers t ON t.id = l.transfer_id
    `).all() as Array<{
      id: string; material_id: string; qty_sent: number; out_txn_id: string | null; in_txn_id: string | null;
      reverses_line_id: string | null; status: string; transfer_no: string; from_department_id: string; to_department_id: string;
    }>;
    lineCount = lines.length;
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const reversedSum = new Map<string, number>();
    for (const l of lines) {
      const p = pair.get(l.id);
      const hasLegs = byRef.has(l.id);
      if (l.status !== 'posted') {
        if (hasLegs) issues.push({ issue: 'legs_on_unposted', reference_id: l.id, detail: `${l.transfer_no} is ${l.status} but its line has ledger legs.` });
        continue;
      }
      if (!hasLegs) {
        issues.push({ issue: 'line_missing_legs', reference_id: l.id, detail: `${l.transfer_no} line moved ${l.qty_sent} but has no ledger pair.` });
        continue;
      }
      if (!p) continue; // already reported as unpaired
      if (String(l.out_txn_id || '') !== p.out.id || String(l.in_txn_id || '') !== p.in.id) {
        issues.push({ issue: 'line_leg_ids', reference_id: l.id, detail: `${l.transfer_no} line names legs ${l.out_txn_id || '∅'} / ${l.in_txn_id || '∅'}, ledger has ${p.out.id} / ${p.in.id}.` });
      }
      if (Math.abs((Number(p.in.quantity) || 0) - (Number(l.qty_sent) || 0)) > 1e-6) {
        issues.push({ issue: 'line_qty_mismatch', reference_id: l.id, detail: `${l.transfer_no} line says ${l.qty_sent}, ledger pair moved ${p.in.quantity}.` });
      }
      if (p.out.department_id !== l.from_department_id || p.in.department_id !== l.to_department_id || p.in.material_id !== l.material_id) {
        issues.push({ issue: 'leg_department_mismatch', reference_id: l.id, detail: `${l.transfer_no}: legs are ${p.out.department_id} → ${p.in.department_id} for ${p.in.material_id}; the document says ${l.from_department_id} → ${l.to_department_id} for ${l.material_id}.` });
      }
      const rl = String(l.reverses_line_id || '');
      if (rl) {
        const orig = lineById.get(rl);
        if (!orig || orig.from_department_id !== l.to_department_id || orig.to_department_id !== l.from_department_id || orig.material_id !== l.material_id) {
          issues.push({ issue: 'reverse_direction', reference_id: l.id, detail: `${l.transfer_no} reverses line ${rl}, which is not the same goods going the other way.` });
        }
        reversedSum.set(rl, (reversedSum.get(rl) || 0) + (Number(l.qty_sent) || 0));
      }
    }
    for (const [rl, sum] of reversedSum) {
      const orig = lineById.get(rl);
      if (orig && sum > (Number(orig.qty_sent) || 0) + 1e-6) {
        issues.push({ issue: 'over_reversed', reference_id: rl, detail: `${orig.transfer_no} line moved ${orig.qty_sent} but ${r6(sum)} has been reversed.` });
      }
    }
    for (const ref of byRef.keys()) {
      if (!lineById.has(ref)) {
        issues.push({ issue: 'orphan_legs', reference_id: ref, detail: `Ledger legs reference ${ref}, which is no transfer line.` });
      }
    }
  } catch { /* document tables absent — the ledger-side checks above still stand */ }

  return { pairs, legs: legs.length, lines: lineCount, issues };
}
