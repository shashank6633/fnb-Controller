import type Database from 'better-sqlite3';
import type { SessionUser } from './auth';
// The two rails of stockOnHandBulk() at the foot of this file. Imported for
// REUSE, never re-derived: deptOnHandBulk is the one department-balance
// arithmetic and consolidatedStock is the one store roll-up. A second copy of
// either would be free to disagree with the screen it is supposed to explain.
// No cycle: store-engine -> db.ts -> dept-ledger, and none of the three imports
// this file (db.ts reaches store-engine through a deferred require).
import { deptKey, deptOnHandBulk } from './dept-ledger';
import type { DeptOnHandResult } from './dept-ledger';
import { consolidatedStock, listStores } from './store-engine';

/**
 * Department Stock — LEDGER-BACKED, anchored on a physical count.
 *
 *   on_hand = anchor_qty + SUM(department_material_transactions.quantity)
 *             for rows created_at > anchor_at
 *
 * THIS FILE NO LONGER DERIVES A BALANCE FROM requisition_items. It used to:
 * "latest closing count + issues since, unrolled from issue_history with a
 * pack factor". That derivation is gone. There is now exactly ONE derivation
 * of a department balance in the codebase — the ledger sum below — which is
 * what issue-stock.ts:446 has warned about in prose since the day the credit
 * was written ("the two representations are mutually exclusive by design").
 * If you find yourself adding requisition_items back into on_hand, stop: every
 * issue would then count twice, once as a ledger row and once as a line.
 *
 * The ONLY thing still read out of requisition_items here is
 * `pre_cutover_issued` — a labelled, greyed, NON-ADDITIVE column so the 14k
 * historic issued lines do not silently vanish from the screen. It is never
 * summed into on_hand. Do not "tidy" it into the balance.
 *
 * THE ANCHOR (per department × material, never once across a roll-up):
 *   candidates — the newest closing_stock count, and the cutover `opening`
 *   ledger row. The LATER of the two wins; a recount re-bases over the
 *   cutover, which is the owner's only tool for correcting drift, so it must
 *   keep winning.
 *
 * THE HARD FLOOR (this is decision D, and until now NOTHING enforced it):
 *   no movement dated before settings.dept_ledger_cutover_at ever enters a
 *   balance, even when a count is backdated past the cutover. Department
 *   balances start at the cutover; history is excluded and SAID to be
 *   excluded. Removing the floor would let one backdated count drag months of
 *   pre-cutover movement into today's number.
 *
 * NEVER COUNTED means no count AND no opening row. It reports on_hand null —
 * not 0, and not the old "received in the last 30 days" figure. That fallback
 * was deleted deliberately: with closing_stock empty it returned a rolling
 * receipts window that LOOKED like a balance and was not one. A blank is
 * honest; a plausible wrong number is not.
 *
 * deptSet: the department itself plus, when it is a MAIN department
 * (parent_id IS NULL), all of its sub-departments — a main-dept view rolls up
 * everything anchored/moved under it, each sub-dept measured from its OWN
 * anchor before the roll-up sums them.
 *
 * TIME BASIS. Every writer of this ledger uses datetime('now') → UTC
 * 'YYYY-MM-DD HH:MM:SS'. closing_stock.date is an IST business date. All
 * comparisons happen in the UTC basis on a normalised 19-char string (see
 * normTs / istDayEndUtc); do not compare a raw ISO 'T' timestamp against a
 * raw ledger timestamp — 'T' > ' ' and the mismatch silently shifts a whole
 * day's movements.
 *
 * LIQUOR IS NOT HERE. Store-mapped materials live on the TGBCL rail
 * (store_stock_ledger / store_locations) and are skipped by both the central
 * debit and the department credit in issue-stock.ts, so they never produce a
 * ledger row and never appear in a balance below. That carve-out is upstream
 * and deliberate — do not "fix" this file to include them.
 */

/** Ledger timestamps normalised for string comparison, in SQL. Keep this and
 *  normTs() below byte-identical in behaviour: 19 chars, 'T' → ' '. */
const LEDGER_TS_SQL = `REPLACE(SUBSTR(dmt.created_at, 1, 19), 'T', ' ')`;

/** Normalise any stored timestamp to 'YYYY-MM-DD HH:MM:SS' for comparison.
 *  A bare date means the START of that day (a floor must not swallow the day
 *  it names). Returns '' for junk, which every caller treats as "no bound". */
function normTs(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 00:00:00`;
  return s.slice(0, 19).replace('T', ' ');
}

/** End of an IST business day expressed in the ledger's UTC basis.
 *  23:59:59 IST = 18:29:59 UTC on the SAME calendar day (IST = UTC+5:30), so
 *  no date rollover. The old code used '<date>T23:59:59' — 5½ hours late,
 *  which quietly excluded every late-night issue from the day after a count. */
function istDayEndUtc(date: string): string {
  return `${String(date || '').slice(0, 10)} 18:29:59`;
}

export type AnchorSource = 'count' | 'opening' | 'mixed' | null;

export interface DeptStockRow {
  material_id: string;
  name: string;
  category: string;
  unit: string;
  purchase_unit: string;
  pack_size: number;
  average_price: number;
  /** Latest closing count in RECIPE units, or null when never counted.
   *  Reported even when a later `opening` row won the anchor — a stale count
   *  is still worth showing, it just is not the base. */
  last_count: number | null;
  last_count_date: string | null;
  /** The base the balance is built on: the winning anchor quantity summed
   *  across the deptSet. null when nothing anchors this material. */
  anchor_qty: number | null;
  /** Which anchor won. 'mixed' = a roll-up where sub-depts differ. */
  anchor_source: AnchorSource;
  /** NET signed ledger movement since the anchor, RECIPE units, counting ONLY
   *  anchored depts — so anchor_qty + issued_since === on_hand_est always
   *  reconciles on screen. NOT "issues": it nets consumption, wastage and
   *  reversals against issues. The name is kept only because callers already
   *  read it; label it "net movement". */
  issued_since: number;
  /** The same window split by sign, so a screen can say "in 5 kg, out 3 kg"
   *  instead of showing a net figure that hides both legs. */
  in_since: number;
  out_since: number;
  /** anchor_qty + issued_since. NULL when never_counted — never 0. */
  on_hand_est: number | null;
  /** No count AND no opening row anywhere in the deptSet. */
  never_counted: boolean;
  /** Depts in the set that hold movement for this material but have no anchor.
   *  > 0 on an anchored row means the roll-up is INCOMPLETE — say so on screen
   *  rather than presenting a partial total as the department's holding. */
  uncounted_dept_count: number;
  /** Net signed movement sitting in those UNANCHORED depts. Deliberately kept
   *  out of on_hand: a movement with no base is a quantity, not a balance, and
   *  adding it to another dept's counted base mixes two different bases into
   *  one number. Show it beside the row, never inside it. */
  unanchored_moved: number;
  /** Latest ledger movement for this material anywhere in the deptSet
   *  (all-time, not just since the anchor). */
  last_issue_at: string | null;
  /** Requisition quantity issued to this deptSet BEFORE the cutover, RECIPE
   *  units. INFORMATIONAL — history is not backfilled and this is never part
   *  of on_hand. All-time when no cutover is stamped. */
  pre_cutover_issued: number;
  /** on_hand_est × average_price (₹ — average_price is per RECIPE unit).
   *  0 when on_hand is unknown; an unknown balance has no value. */
  est_value: number;
}

export interface DeptStockSummary {
  items: number;
  est_value: number;
  never_counted_count: number;
  /** settings.dept_ledger_cutover_at, normalised. NULL = the cutover has not
   *  been run, so no balance on this screen is trustworthy yet and the page
   *  must say exactly that. */
  cutover_at: string | null;
  /** Materials carrying pre-cutover issue history, and its ₹ value. Deliberately
   *  NOT a summed quantity — g + ml + pcs is not a number. */
  pre_cutover_items: number;
  pre_cutover_value: number;
  /** anchor_source census, so a screen can report how much of the department
   *  is actually counted rather than implying the whole list is measured. */
  anchored_by_count: number;
  anchored_by_opening: number;
  anchored_mixed: number;
}

/** The dept itself plus, when it's a MAIN dept (parent_id NULL), all active
 *  sub-departments. Empty array when the dept doesn't exist. */
export function resolveDeptSet(db: Database.Database, deptId: string): string[] {
  const d = db.prepare('SELECT id, parent_id FROM departments WHERE id = ?').get(deptId) as
    { id: string; parent_id: string | null } | undefined;
  if (!d) return [];
  const set = [d.id];
  if (!d.parent_id) {
    const subs = db.prepare('SELECT id FROM departments WHERE parent_id = ?').all(d.id) as { id: string }[];
    for (const s of subs) set.push(s.id);
  }
  return set;
}

/** Privilege predicate shared by /api/department-stock and the dept-scoped
 *  closing lists — mirrors closing-stock page canSeeAllDepts. */
export function canSeeAllDeptStock(user: SessionUser): boolean {
  return user.role === 'admin' || user.role === 'manager' || user.is_head_chef || user.is_store_manager;
}

/** Departments a NON-privileged user may query: own dept + granted
 *  visible_department_ids (users column, JSON array). */
export function allowedDeptIds(user: SessionUser): Set<string> {
  const out = new Set<string>();
  if (user.department_id) out.add(user.department_id);
  if (user.visible_department_ids) {
    try {
      const arr = JSON.parse(user.visible_department_ids);
      if (Array.isArray(arr)) for (const id of arr) if (id) out.add(String(id));
    } catch { /* garbled grant → ignore */ }
  }
  return out;
}

/**
 * The department-ledger cutover stamp, or null when the cutover has not been
 * run. This ONE timestamp is the boundary every "history excluded" label and
 * every balance floor reads. It is written once, by an explicit admin action
 * (POST /api/department-ledger/cutover) — never by a boot migration, because
 * opening balances are admin-owned state and scripts/check-boot-migrations.js
 * exists to keep deploys out of it.
 */
export function getDeptLedgerCutoverAt(db: Database.Database): string | null {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'dept_ledger_cutover_at'`)
      .get() as { value?: string } | undefined;
    return normTs(row?.value) || null;
  } catch { return null; }
}

/** Recipe-units per 1 ri.unit — the house pack-factor CASE, in JS, plus the
 *  legacy-blank rule. STILL NEEDED, but now for ONE thing only: the
 *  informational pre_cutover_issued column. The live balance never touches it,
 *  because the ledger is already written in recipe units.
 *
 *  Explicit units follow department-consumption route.ts:150-152: × pack_size
 *  only when the RAW ri.unit (NOT trimmed — a padded 'BTL ' fails `= 'BTL'`
 *  and stays ×1, like the SQL CASE) equals the purchase unit and differs from
 *  the recipe unit. BLANK ri.unit is the pre-unit-column era (≤2026-05, 14k+
 *  lines): those quantities were entered in PURCHASE units (butter issued=5
 *  means 5 kg, not 5 g — DB-verified 2026-07-22: 3,769/3,883 blank g-lines
 *  have qty < 20), so a blank unit gets the same × pack_size as an explicit
 *  purchase-unit request. This is a deliberate departure from the SQL CASE's
 *  "blank stays ×1". */
function reqPackFactor(riUnit: string | null, unit: string, purchaseUnit: string | null, packSize: number | null): number {
  // Blank = legacy purchase-unit entry; non-blank must equal the purchase unit
  // exactly (raw, untrimmed — same as the SQL CASE).
  const asPurchase = String(riUnit ?? '').trim() === '' ? true : riUnit === purchaseUnit;
  return (asPurchase && String(purchaseUnit ?? '').trim() !== '' && unit !== purchaseUnit && (Number(packSize) || 1) > 1)
    ? Number(packSize) : 1;
}

/**
 * SQL fragment (for a raw_materials alias `rm`) restricting rows to a
 * department's item set: materials ever issued to the deptSet (non-party,
 * quantity_issued > 0, not rejected) UNION materials ever counted by the
 * deptSet in closing_stock. Binds TWO params, each the SAME JSON array of
 * dept ids — pass deptItemSetParams(deptSet).
 */
export const DEPT_ITEM_SET_SQL = `rm.id IN (
  SELECT ri.material_id
  FROM requisition_items ri
  JOIN requisitions r ON r.id = ri.req_id
  WHERE COALESCE(ri.department_id, r.department_id) IN (SELECT value FROM json_each(?))
    AND r.status NOT IN ('cancelled','chef_rejected')
    AND COALESCE(r.purpose,'internal') <> 'party'
    AND ri.quantity_issued > 0
    AND COALESCE(ri.is_rejected,0) = 0
    AND COALESCE(ri.store_rejected,0) = 0
  UNION
  SELECT cs.material_id FROM closing_stock cs
  WHERE cs.department_id IN (SELECT value FROM json_each(?))
)`;

export function deptItemSetParams(deptSet: string[]): [string, string] {
  const json = JSON.stringify(deptSet);
  return [json, json];
}

/** Every dept id a NON-privileged user's counting surfaces should scope to:
 *  own dept + granted visible departments, each expanded to its deptSet
 *  (a main dept pulls in its sub-departments). */
export function allowedDeptSetExpanded(db: Database.Database, user: SessionUser): string[] {
  const out = new Set<string>();
  for (const id of allowedDeptIds(user)) {
    for (const d of resolveDeptSet(db, id)) out.add(d);
  }
  return [...out];
}

/** Compute the full department-stock row set. Returns null for an unknown dept. */
export function computeDeptStock(db: Database.Database, deptId: string): { rows: DeptStockRow[]; summary: DeptStockSummary } | null {
  const deptSet = resolveDeptSet(db, deptId);
  if (deptSet.length === 0) return null;
  const setJson = JSON.stringify(deptSet);

  const cutoverAt = getDeptLedgerCutoverAt(db);
  // '' = no cutover stamped → no floor. Every timestamp compares > '' as true,
  // so the unstamped case degrades to "all ledger rows", which is correct:
  // before the cutover the ledger is empty by construction (decision D — no
  // backfill), so there is nothing for a floor to hold back.
  const floorTs = cutoverAt || '';
  const cutoverDate = cutoverAt ? cutoverAt.slice(0, 10) : '';

  // ── ANCHOR CANDIDATE 1: closing counts ────────────────────────────────────
  // Latest closing count per (department, material) — computed PER dept in the
  // set, not once across the whole set, so a main-dept rollup keeps every
  // sub-dept's own count instead of collapsing to a single latest row. date is
  // the end-of-day count date; tie-break on created_at for same-day recounts.
  // Ascending order → last write per (dept,material) wins.
  const anchorRows = db.prepare(`
    SELECT cs.material_id, cs.department_id, cs.physical_stock, cs.date, cs.created_at
    FROM closing_stock cs
    WHERE cs.department_id IN (SELECT value FROM json_each(?))
    ORDER BY cs.date ASC, cs.created_at ASC
  `).all(setJson) as { material_id: string; department_id: string; physical_stock: number; date: string; created_at: string }[];

  interface Anchor { qty: number; at: string; source: 'count' | 'opening'; date: string | null }
  /** material → dept → winning anchor */
  const anchorsByMat = new Map<string, Map<string, Anchor>>();
  /** material → dept → latest closing count (kept even when an opening wins) */
  const countsByMat = new Map<string, Map<string, { qty: number; date: string }>>();

  const putAnchor = (matId: string, deptIdIn: string, a: Anchor) => {
    let m = anchorsByMat.get(matId);
    if (!m) { m = new Map(); anchorsByMat.set(matId, m); }
    const cur = m.get(deptIdIn);
    // LATER anchor wins. On an exact tie the COUNT wins: a physical recount is
    // the owner's re-basing tool and must override a cutover opening, never
    // the other way round.
    if (!cur || a.at > cur.at || (a.at === cur.at && a.source === 'count')) m.set(deptIdIn, a);
  };

  for (const c of anchorRows) {
    // A count covers the shelf up to the EARLIER of its business day-end and
    // the moment it was saved. MIN, not MAX:
    //   · same-day count entered at 3pm → anchor 3pm, so the 5pm issue that
    //     followed it is still added (a day-end anchor would swallow it);
    //   · count for the 1st typed in on the 5th → anchor the 1st's day-end, so
    //     four days of movement are added back (an entry-time anchor would
    //     silently drop them).
    // Both directions of getting this wrong lose real movement.
    const dayEnd = istDayEndUtc(c.date);
    const saved = normTs(c.created_at);
    const at = saved && saved < dayEnd ? saved : dayEnd;
    putAnchor(c.material_id, c.department_id, {
      qty: Number(c.physical_stock) || 0, at, source: 'count', date: String(c.date || '').slice(0, 10),
    });
    let cm = countsByMat.get(c.material_id);
    if (!cm) { cm = new Map(); countsByMat.set(c.material_id, cm); }
    cm.set(c.department_id, { qty: Number(c.physical_stock) || 0, date: String(c.date || '').slice(0, 10) });
  }

  // ── ANCHOR CANDIDATE 2: the cutover opening row ───────────────────────────
  // One row per (dept, material) that the count covered. The cutover action is
  // idempotent, but take the newest defensively rather than trusting that.
  const openingRows = db.prepare(`
    SELECT dmt.department_id, dmt.material_id, dmt.quantity,
           ${LEDGER_TS_SQL} AS at
    FROM department_material_transactions dmt
    WHERE dmt.department_id IN (SELECT value FROM json_each(?))
      AND dmt.type = 'opening'
    ORDER BY at ASC
  `).all(setJson) as { department_id: string; material_id: string; quantity: number; at: string }[];
  for (const o of openingRows) {
    putAnchor(o.material_id, o.department_id, {
      qty: Number(o.quantity) || 0, at: o.at, source: 'opening', date: null,
    });
  }

  // ── THE ITEM SET ──────────────────────────────────────────────────────────
  // Materials with any ledger row in the deptSet, with material metadata and
  // the all-time last movement. GROUP BY (dept, material) so a roll-up can
  // still tell which sub-dept is unanchored.
  const ledgerPairs = db.prepare(`
    SELECT dmt.department_id, dmt.material_id,
           MAX(${LEDGER_TS_SQL}) AS last_at,
           rm.name, rm.category, rm.unit, rm.purchase_unit, rm.pack_size, rm.average_price
    FROM department_material_transactions dmt
    JOIN raw_materials rm ON rm.id = dmt.material_id
    WHERE dmt.department_id IN (SELECT value FROM json_each(?))
    GROUP BY dmt.department_id, dmt.material_id
  `).all(setJson) as any[];

  // Counted-but-never-moved materials still get a row (row set = UNION).
  const countedOnly = db.prepare(`
    SELECT rm.id AS material_id, rm.name, rm.category, rm.unit, rm.purchase_unit,
           rm.pack_size, rm.average_price
    FROM raw_materials rm
    WHERE rm.id IN (SELECT cs.material_id FROM closing_stock cs
                    WHERE cs.department_id IN (SELECT value FROM json_each(?)))
  `).all(setJson) as any[];

  // Historic requisition issues — the pre_cutover_issued column ONLY. Same
  // qualifying rules as DEPT_ITEM_SET_SQL so this screen lists the same items
  // the dept's closing-count sheet does. These lines produce NO balance.
  const issueLines = db.prepare(`
    SELECT ri.material_id, COALESCE(ri.department_id, r.department_id) AS owner_dept,
           ri.quantity_issued, ri.issue_history, ri.unit AS req_unit,
           r.date AS req_date,
           rm.name, rm.category, rm.unit, rm.purchase_unit, rm.pack_size, rm.average_price
    FROM requisition_items ri
    JOIN requisitions r ON r.id = ri.req_id
    JOIN raw_materials rm ON rm.id = ri.material_id
    WHERE COALESCE(ri.department_id, r.department_id) IN (SELECT value FROM json_each(?))
      AND r.status NOT IN ('cancelled','chef_rejected')
      AND COALESCE(r.purpose,'internal') <> 'party'
      AND ri.quantity_issued > 0
      AND COALESCE(ri.is_rejected,0) = 0
      AND COALESCE(ri.store_rejected,0) = 0
  `).all(setJson) as any[];

  interface Acc {
    name: string; category: string; unit: string; purchase_unit: string;
    pack_size: number; average_price: number;
    /** dept → net / in / out ledger movement inside that dept's window. */
    moveByDept: Map<string, { net: number; inQty: number; outQty: number }>;
    /** every dept in the set that holds ledger movement for this material */
    movedDepts: Set<string>;
    last_move_at: string | null;
    pre_cutover_issued: number;
  }
  const acc = new Map<string, Acc>();
  const ensure = (id: string, m: any): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = {
        name: m.name, category: m.category || '', unit: m.unit || '',
        purchase_unit: m.purchase_unit || '', pack_size: Number(m.pack_size) || 1,
        average_price: Number(m.average_price) || 0,
        moveByDept: new Map(), movedDepts: new Set(), last_move_at: null,
        pre_cutover_issued: 0,
      };
      acc.set(id, a);
    }
    return a;
  };
  for (const m of countedOnly) ensure(m.material_id, m);
  for (const p of ledgerPairs) {
    const a = ensure(p.material_id, p);
    a.movedDepts.add(String(p.department_id));
    const at = String(p.last_at || '');
    if (at && (!a.last_move_at || at > a.last_move_at)) a.last_move_at = at;
  }
  for (const ln of issueLines) ensure(ln.material_id, ln);

  // ── THE WINDOWED LEDGER SUM ───────────────────────────────────────────────
  // One window per (dept, material): MAX(anchor, cutover floor). The floor is
  // what makes decision D real — a count backdated past the cutover moves the
  // anchor back but CANNOT pull pre-cutover movement into the balance.
  // Unanchored pairs still get a window (the floor alone) so the screen can
  // show what moved; their on_hand stays null regardless.
  const windowSpecs: Array<{ d: string; m: string; a: string }> = [];
  const windowStartByPair = new Map<string, string>();
  const pairKey = (d: string, m: string) => `${d}::${m}`;
  const registerWindow = (d: string, m: string) => {
    const k = pairKey(d, m);
    if (windowStartByPair.has(k)) return;
    const anc = anchorsByMat.get(m)?.get(d);
    const start = anc ? (anc.at > floorTs ? anc.at : floorTs) : floorTs;
    windowStartByPair.set(k, start);
    windowSpecs.push({ d, m, a: start });
  };
  for (const [matId, byDept] of anchorsByMat) for (const d of byDept.keys()) registerWindow(d, matId);
  for (const [matId, a] of acc) for (const d of a.movedDepts) registerWindow(d, matId);

  if (windowSpecs.length > 0) {
    // Strictly `>`: the `opening` row IS the anchor, so it must not also be
    // counted as a movement on top of itself.
    const moveRows = db.prepare(`
      WITH anchors(department_id, material_id, anchor_at) AS (
        SELECT json_extract(j.value, '$.d'), json_extract(j.value, '$.m'), json_extract(j.value, '$.a')
        FROM json_each(?) j
      )
      SELECT dmt.department_id, dmt.material_id,
             SUM(dmt.quantity)                                              AS net_qty,
             SUM(CASE WHEN dmt.quantity > 0 THEN dmt.quantity ELSE 0 END)   AS in_qty,
             SUM(CASE WHEN dmt.quantity < 0 THEN -dmt.quantity ELSE 0 END)  AS out_qty
      FROM department_material_transactions dmt
      JOIN anchors a
        ON a.department_id = dmt.department_id AND a.material_id = dmt.material_id
      WHERE ${LEDGER_TS_SQL} > a.anchor_at
      GROUP BY dmt.department_id, dmt.material_id
    `).all(JSON.stringify(windowSpecs)) as any[];
    for (const r of moveRows) {
      const a = acc.get(String(r.material_id));
      if (!a) continue;
      a.moveByDept.set(String(r.department_id), {
        net: Number(r.net_qty) || 0,
        inQty: Number(r.in_qty) || 0,
        outQty: Number(r.out_qty) || 0,
      });
    }
  }

  // ── PRE-CUTOVER HISTORY (informational, never additive) ───────────────────
  // Bounded by the cutover: split issues by their own issue_history `at`,
  // one-shot store-process / Recaho imports (issue_history empty on 14,144 of
  // 14,149 lines) by the requisition date. No cutover stamped → all-time,
  // which is exactly the figure the old balance query produced.
  for (const ln of issueLines) {
    const a = acc.get(String(ln.material_id));
    if (!a) continue;
    const factor = reqPackFactor(ln.req_unit, ln.unit, ln.purchase_unit, ln.pack_size);
    let hist: any[] = [];
    try { hist = JSON.parse(ln.issue_history || '[]'); } catch { hist = []; }
    if (Array.isArray(hist) && hist.length > 0) {
      for (const h of hist) {
        const at = normTs(h && h.at);
        const qty = Number(h && h.qty) || 0;
        if (qty <= 0 || !at) continue;
        if (!cutoverAt || at < cutoverAt) a.pre_cutover_issued += qty * factor;
      }
    } else {
      const rd = String(ln.req_date || '').slice(0, 10);
      if (!cutoverDate || (rd && rd < cutoverDate)) {
        a.pre_cutover_issued += (Number(ln.quantity_issued) || 0) * factor;
      }
    }
  }

  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  const rows: DeptStockRow[] = [];
  let estValue = 0, neverCounted = 0;
  let byCount = 0, byOpening = 0, mixed = 0;
  let preItems = 0, preValue = 0;

  for (const [id, a] of acc) {
    // Roll up PER (dept, material): each dept contributes its OWN anchor plus
    // its OWN windowed movement. never_counted only when NO dept is anchored.
    const anchorMap = anchorsByMat.get(id);
    const countMap = countsByMat.get(id);
    const depts = new Set<string>([
      ...(anchorMap ? anchorMap.keys() : []),
      ...a.movedDepts,
    ]);

    let anchorQty = 0, moved = 0, inQty = 0, outQty = 0;
    let hasAnchor = false, uncountedDepts = 0, unanchoredMoved = 0;
    const sources = new Set<'count' | 'opening'>();
    for (const d of depts) {
      const anc = anchorMap ? anchorMap.get(d) : undefined;
      const mv = a.moveByDept.get(d);
      if (anc) {
        hasAnchor = true;
        anchorQty += anc.qty;
        sources.add(anc.source);
        if (mv) { inQty += mv.inQty; outQty += mv.outQty; moved += mv.net; }
      } else {
        // Movement in a dept with NO base. It is kept OUT of on_hand on
        // purpose: adding an unbased quantity onto a sibling's counted base
        // silently mixes bases and inflates the roll-up (caught in test A6 —
        // an unanchored prep sub-dept was adding 800 g onto the main dept's
        // count). Reported separately so nothing is hidden either.
        uncountedDepts++;
        if (mv) unanchoredMoved += mv.net;
      }
    }

    let lastCount: number | null = null;
    let lastCountDate: string | null = null;
    if (countMap) {
      lastCount = 0;
      for (const c of countMap.values()) {
        lastCount += c.qty;
        if (!lastCountDate || c.date > lastCountDate) lastCountDate = c.date;
      }
    }

    const never = !hasAnchor;
    const onHand = never ? null : r4(anchorQty + moved);
    const anchorSource: AnchorSource = never
      ? null
      : (sources.size > 1 ? 'mixed' : (sources.has('count') ? 'count' : 'opening'));
    // An unknown balance has no value. Do NOT substitute 0 or the pre-cutover
    // figure here — a made-up ₹ total is how a "not counted yet" screen starts
    // being read as a stock valuation.
    const est = onHand === null ? 0 : onHand * a.average_price;

    if (never) neverCounted++;
    else if (anchorSource === 'mixed') mixed++;
    else if (anchorSource === 'count') byCount++;
    else byOpening++;
    estValue += est;
    if (a.pre_cutover_issued > 0) {
      preItems++;
      // a.pre_cutover_issued is accumulated in the PRE-CUTOVER HISTORY loop
      // above as (issued qty × factor), where factor comes from the unit-lift
      // helper at the top of this file — it lifts a requisition line recorded
      // in the material's purchase unit up to RECIPE units, and returns 1
      // whenever the two unit names are the same (so a kg/kg 1.5-pack item is
      // left alone). The interface field is documented "RECIPE units" too.
      // a.average_price is raw_materials.average_price, ₹ per recipe unit by
      // canon. Same pair as `est` above.
      // rate-basis: recipe (recipe-unit qty × ₹ per recipe unit)
      preValue += a.pre_cutover_issued * a.average_price;
    }

    rows.push({
      material_id: id,
      name: a.name, category: a.category, unit: a.unit,
      purchase_unit: a.purchase_unit, pack_size: a.pack_size,
      average_price: a.average_price,
      last_count: lastCount,
      last_count_date: lastCountDate,
      anchor_qty: never ? null : r4(anchorQty),
      anchor_source: anchorSource,
      issued_since: r4(moved),
      in_since: r4(inQty),
      out_since: r4(outQty),
      on_hand_est: onHand,
      never_counted: never,
      uncounted_dept_count: uncountedDepts,
      unanchored_moved: r4(unanchoredMoved),
      last_issue_at: a.last_move_at,
      pre_cutover_issued: r4(a.pre_cutover_issued),
      est_value: Math.round(est * 100) / 100,
    });
  }
  rows.sort((x, y) => x.category.localeCompare(y.category) || x.name.localeCompare(y.name));

  return {
    rows,
    summary: {
      items: rows.length,
      est_value: Math.round(estValue * 100) / 100,
      never_counted_count: neverCounted,
      cutover_at: cutoverAt,
      pre_cutover_items: preItems,
      pre_cutover_value: Math.round(preValue * 100) / 100,
      anchored_by_count: byCount,
      anchored_by_opening: byOpening,
      anchored_mixed: mixed,
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * PER-MATERIAL STOCK ON HAND — the Stores rail and the Departments rail,
 * for MANY materials, in ONE batched pass.
 *
 * WHY THIS EXISTS. computeDeptStock() above answers "what does ONE department
 * hold, across all of its materials". A store person raising a PO or a GRN
 * needs the transpose: "for THIS material, what is sitting in the stores and
 * what is sitting in the departments" — and needs it for every material in a
 * picker at once. There was no per-MATERIAL roll-up across departments before
 * this function.
 *
 * ONE CALL, WHOLE CATALOGUE. This box is a single-threaded better-sqlite3
 * process that has already served a 504 under load. A per-material request, or
 * a loop over /api/department-stock?department_id=X, is an N+1 that stalls
 * billing and the captain app behind it. Everything below is bounded:
 *   · one raw_materials read for pack meta,
 *   · one consolidatedStock() pass for the stores rail,
 *   · one departments read + one deptOnHandBulk() (four queries) for the
 *     departments rail.
 * That is a fixed six-ish queries whether you ask for 1 material or all 952.
 *
 * TWO SEPARATE FIGURES, NEVER MERGED. A store person needs to know 3 kg is
 * sitting in the kitchen, not merely that 4 kg exists in the building. Stores
 * and Departments are returned as distinct rails and must be rendered as two
 * numbers.
 *
 * UNITS. Every quantity here is in RECIPE units, the stored basis — the same
 * basis raw_materials.current_stock, store_stock_ledger.quantity and
 * department_material_transactions.quantity are written in. Nothing is
 * converted on this side. The pack meta (unit / purchase_unit / pack_size /
 * case_size) rides along so the renderer converts ONCE, through
 * toPurchaseQty() in src/lib/pack-units.ts, whose both-halves guard is what
 * keeps PICKLED GINGER 1.5KG (kg/kg, pack 1.5, stock 6) reading 6 kg and not
 * 4. Never divide by pack_size here or anywhere downstream.
 *
 * NO ZERO-AS-UNKNOWN, ANYWHERE ON THIS PATH.
 *   · A material absent from the returned Map is UNKNOWN — the renderer says
 *     "unavailable". It is not stock of 0.
 *   · dept_counted_qty is NULL — never 0 — when no department in scope has an
 *     anchored figure. Do not `?? 0` it.
 *   · A counted zero is real, keeps its leg (qty: 0) and renders with its unit.
 *   · There is deliberately no COALESCE(<qty>, 0) in the SQL below.
 *
 * NOT A CACHE, NOT A SNAPSHOT. This is the LIVE figure, recomputed per call.
 * The frozen PO-time record is a separate concern (po_line_stock_snapshots);
 * whoever writes that table must call THIS function for its numbers rather
 * than defining a second one, or the audit trail and the picker will disagree.
 * ════════════════════════════════════════════════════════════════════════════ */

/** One place stock is sitting: a store location, or a department. */
export interface StockLeg {
  /** store_locations.id / departments.id. Null is reserved for a synthetic leg
   *  (the renderer's "Grocery" line, built from central_qty). */
  id: string | null;
  /** The name AS IT IS NOW. A snapshot writer must copy it, not re-join it —
   *  departments get renamed and a re-join would restate a historic record. */
  name: string;
  /** RECIPE units. Present means MEASURED: a 0 here is a counted zero. */
  qty: number;
  /** Set only on a deactivated department that still holds a counted balance.
   *  Real stock is never hidden just because the department was switched off. */
  inactive?: boolean;
}

/** Stores + Departments for ONE material. Every qty is in RECIPE units. */
export interface StockOnHand {
  material_id: string;
  /** Pack meta as it stands right now — feed it straight to toPurchaseQty(). */
  unit: string;
  /** Falls back to `unit` when the material has no purchase unit, which is what
   *  packFactor() does internally, so the guard behaves identically either way. */
  purchase_unit: string;
  pack_size: number;
  case_size: number;

  // ── STORES RAIL ──
  /** raw_materials.current_stock — the central grocery backstock. */
  central_qty: number;
  /** One leg per ACTIVE store_location, zeros included, for a store-mapped
   *  material. EMPTY for a material no store owns — not "0 everywhere". */
  stores: StockLeg[];
  /** central_qty + SUM(stores[].qty). The single number a "Store" label shows. */
  store_total_qty: number;
  /** The material is in consolidatedStock()'s universe (category-mapped to an
   *  active store, or holding a store ledger row) — i.e. it lives on the TGBCL
   *  rail. Such materials never write a department ledger row, so their
   *  department rail is structurally "not counted", never zero. */
  store_mapped: boolean;

  // ── DEPARTMENTS RAIL ──
  /** ONLY departments with a real anchored balance. A department that has never
   *  been counted contributes NOTHING here — it is counted in
   *  dept_uncounted_count instead, because 19 null legs per material is payload
   *  carrying no information. */
  depts: StockLeg[];
  /** SUM(depts[].qty), or NULL when depts is empty. NEVER 0 for "unknown". */
  dept_counted_qty: number | null;
  /** depts.length — how many departments the total above actually covers. */
  dept_counted_count: number;
  /** ACTIVE departments in scope with no anchor for this material. A
   *  data-quality signal about live departments, which is why a deactivated
   *  department is not counted in it. */
  dept_uncounted_count: number;
}

export interface StockOnHandOptions {
  /** Departments to measure.
   *    omitted   → EVERY department row (active and inactive).
   *    []        → NONE. The "restricted viewer" case: every material comes
   *                back with depts: [], dept_counted_qty: null and
   *                dept_uncounted_count: 0, so the UI can say "restricted"
   *                rather than inventing "not counted" or "0".
   *    [ids...]  → exactly those, for a partially-scoped viewer. Departments
   *                outside the list are omitted entirely and are NEVER folded
   *                into dept_counted_qty — a roll-up the viewer cannot
   *                decompose is a wrong number. */
  deptIds?: string[];
}

/** 4 dp, the rounding every other quantity surface in this app uses. */
function r4Soh(n: number): number {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

/**
 * Stores + Departments on hand, per material, batched.
 *
 * @param materialIds  omitted → the whole raw_materials catalogue.
 *                     [] → an empty Map (an explicit request for nothing).
 * @param opts.deptIds see StockOnHandOptions.
 *
 * A material id that does not exist is simply absent from the Map. Callers MUST
 * treat "absent" as unknown and print "unavailable" — never 0.
 *
 * THROWS rather than degrading if the stores rail cannot be read. A liquor
 * material silently reported as grocery-only is a confidently wrong number, and
 * the whole point of this path is that no displayed figure may be wrong. The
 * DEPARTMENT rail is the half a caller may legitimately fail closed on (pass
 * deptIds: []) — see /api/stock-on-hand.
 */
export function stockOnHandBulk(
  db: Database.Database,
  materialIds?: string[],
  opts?: StockOnHandOptions,
): Map<string, StockOnHand> {
  const out = new Map<string, StockOnHand>();

  // ── 1. THE MATERIAL UNIVERSE + its pack meta ──────────────────────────────
  // No COALESCE: current_stock / pack_size / case_size are NOT NULL columns, so
  // a coalesce there would be dead code that still reads like a zero-fill on a
  // path where zero-fills are banned. The text columns are normalised in JS.
  const scopedMats = Array.isArray(materialIds);
  const wantIds = scopedMats
    ? [...new Set((materialIds as string[]).map((m) => String(m ?? '').trim()).filter(Boolean))]
    : [];
  if (scopedMats && wantIds.length === 0) return out;

  const metaSelect = `
    SELECT id, unit, purchase_unit, pack_size, case_size, current_stock
      FROM raw_materials`;
  const metaRows = (scopedMats
    ? db.prepare(`${metaSelect} WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(wantIds))
    : db.prepare(metaSelect).all()
  ) as Array<{
    id: string; unit: string | null; purchase_unit: string | null;
    pack_size: number | null; case_size: number | null; current_stock: number | null;
  }>;
  if (metaRows.length === 0) return out;

  // ── 2. STORES RAIL ────────────────────────────────────────────────────────
  // consolidatedStock() already answers this for the whole catalogue in one
  // pass: grocery_qty (= raw_materials.current_stock), by_store for every ACTIVE
  // store (0 included) and the material universe that defines store_mapped
  // (category-mapped to an active store ∪ holds a store ledger row). Its cost is
  // flat, so it is called once here regardless of how many materials were asked
  // for. Deliberately NOT wrapped in a try/catch — see the doc comment.
  const activeStores = listStores(db)
    .filter((s) => !!s.is_active)
    .map((s) => ({ id: s.id, name: s.name }));
  const byMaterial = new Map<string, Record<string, number>>();
  for (const row of consolidatedStock(db)) byMaterial.set(row.material_id, row.by_store);

  // ── 3. DEPARTMENTS RAIL ───────────────────────────────────────────────────
  // Every department row, or exactly the scoped ones. INACTIVE departments are
  // read too: a department can be switched off while still holding counted
  // stock, and hiding it would hide real stock. They are filtered at leg level
  // below, not here.
  const scopedDepts = !!opts && Array.isArray(opts.deptIds);
  const deptFilterIds = scopedDepts
    ? [...new Set((opts!.deptIds as string[]).map((d) => String(d ?? '').trim()).filter(Boolean))]
    : [];
  const deptRows = (scopedDepts
    ? (deptFilterIds.length === 0
      ? []
      : db.prepare(`SELECT id, name, is_active FROM departments WHERE id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(deptFilterIds)))
    : db.prepare(`SELECT id, name, is_active FROM departments`).all()
  ) as Array<{ id: string; name: string; is_active: number }>;

  // deptOnHandBulk is the ONE department-balance derivation (anchor = later of
  // the newest closing count and the cutover opening row, MAX'd against the
  // cutover floor, with the same-second rowid tie-break). Four queries for the
  // whole dept x material matrix. NEVER loop computeDeptStock() for this: it is
  // ~75x slower on a loaded ledger and it discards the per-(dept, material)
  // split that this whole feature exists to show.
  //
  // materialIds is forwarded ONLY when the caller scoped it. On a whole-
  // catalogue call, passing 952 ids into `material_id IN (SELECT value FROM
  // json_each(?))` buys nothing — the predicate matches every row anyway — so
  // the filter is left off.
  const balances: Map<string, DeptOnHandResult> = deptRows.length > 0
    ? deptOnHandBulk(db, deptRows.map((d) => d.id), scopedMats ? wantIds : undefined)
    : new Map();

  // ── 4. COMPOSE ────────────────────────────────────────────────────────────
  for (const m of metaRows) {
    const central = Number(m.current_stock);
    // Not finite = we do not know this material's central stock. Leaving it out
    // of the Map makes the renderer say "unavailable"; writing 0 would state a
    // fact we do not have.
    if (!Number.isFinite(central)) continue;

    const recipeUnit = String(m.unit ?? '').trim();
    const purchaseUnit = String(m.purchase_unit ?? '').trim() || recipeUnit;

    const perStore = byMaterial.get(m.id);
    const stores: StockLeg[] = [];
    let storeTotal = central;
    if (perStore) {
      for (const s of activeStores) {
        const q = r4Soh(Number(perStore[s.id]) || 0);
        stores.push({ id: s.id, name: s.name, qty: q });
        storeTotal += q;
      }
    }

    const depts: StockLeg[] = [];
    let deptQty = 0;
    let uncounted = 0;
    for (const d of deptRows) {
      const b = balances.get(deptKey(d.id, m.id));
      // ABSENT KEY and neverCounted are the SAME state: nobody ever counted this
      // pair. deptOnHandBulk returns no key at all for a pair with no anchor and
      // no movement, and {onHand: null, neverCounted: true} for one with movement
      // but no anchor. Neither may be rendered as 0.
      const counted = !!b && !b.neverCounted && b.onHand !== null && Number.isFinite(b.onHand);
      const isActive = !!d.is_active;
      if (counted) {
        const q = r4Soh(b!.onHand as number);
        // A deactivated department only earns a leg when it is actually holding
        // something. A deactivated department counted at zero is noise.
        if (isActive) {
          depts.push({ id: d.id, name: d.name, qty: q });
        } else if (q !== 0) {
          depts.push({ id: d.id, name: d.name, qty: q, inactive: true });
        } else {
          continue;
        }
        deptQty += q;
      } else if (isActive) {
        uncounted++;
      }
    }
    // Biggest holding first, so a renderer showing "top 3 + N more" shows the
    // three that matter. Name breaks the tie for a stable order.
    depts.sort((a, b2) => b2.qty - a.qty || a.name.localeCompare(b2.name));

    out.set(m.id, {
      material_id: m.id,
      unit: recipeUnit,
      purchase_unit: purchaseUnit,
      pack_size: Number(m.pack_size) || 1,
      case_size: Number(m.case_size) || 1,
      central_qty: r4Soh(central),
      stores,
      store_total_qty: r4Soh(storeTotal),
      store_mapped: !!perStore,
      depts,
      // NULL, not 0: no department in scope has an anchored figure for this
      // material, so its department holding is unknown, not empty.
      dept_counted_qty: depts.length > 0 ? r4Soh(deptQty) : null,
      dept_counted_count: depts.length,
      dept_uncounted_count: uncounted,
    });
  }

  return out;
}
