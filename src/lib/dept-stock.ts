import type Database from 'better-sqlite3';
import type { SessionUser } from './auth';

/**
 * Department Stock — a COMPUTED per-department balance. No new tables:
 *
 *   on_hand_est = latest closing count (anchor) + store issues since that count
 *
 * The anchor is the newest closing_stock row for (deptSet, material) —
 * closing_stock.physical_stock is in RECIPE units and the count is an
 * end-of-day figure, so issues are "since" only when they land AFTER
 * anchor_date 23:59:59. Materials never counted get an informational
 * "received in the last 30 days" figure instead (never_counted=true) —
 * that is NOT a true balance and must be labelled as such in every UI.
 *
 * deptSet: the department itself plus, when it is a MAIN department
 * (parent_id IS NULL), all of its sub-departments — a main-dept view rolls
 * up everything counted/issued under it.
 *
 * Issue rules (must stay in lockstep with the store-issue route +
 * department-consumption analytics):
 *   - line ownership: COALESCE(ri.department_id, r.department_id)
 *   - r.status NOT IN ('cancelled','chef_rejected'), non-party purpose,
 *     quantity_issued > 0, not chef- or store-rejected
 *   - split issues live in ri.issue_history as [{qty, at, by}] with ISO `at`
 *     (see store-issue route); one-shot store-process + Recaho imports leave
 *     issue_history EMPTY, so those fall back to r.date vs anchor_date.
 *   - quantities are in ri.unit → recipe units via the house pack-factor CASE
 *     (same as department-consumption / party-events/pnl): × pack_size only
 *     when the line was requested in the material's purchase unit.
 */

export interface DeptStockRow {
  material_id: string;
  name: string;
  category: string;
  unit: string;
  purchase_unit: string;
  pack_size: number;
  average_price: number;
  /** Latest closing count in RECIPE units, or null when never counted. */
  last_count: number | null;
  last_count_date: string | null;
  /** Store issues since the anchor (or last 30d when never counted), RECIPE units. */
  issued_since: number;
  /** last_count + issued_since — or, when never counted, just the 30d receipts. */
  on_hand_est: number;
  never_counted: boolean;
  /** Most recent issue timestamp (issue_history `at`, else r.date). */
  last_issue_at: string | null;
  /** on_hand_est × average_price (₹ — average_price is per RECIPE unit). */
  est_value: number;
}

export interface DeptStockSummary {
  items: number;
  est_value: number;
  never_counted_count: number;
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

/** Recipe-units per 1 ri.unit — the house pack-factor CASE, in JS. Kept
 *  byte-equivalent to department-consumption route.ts:150-152: emptiness is
 *  guarded with TRIM, but the purchase-/recipe-unit equality is on the RAW
 *  ri.unit (NOT trimmed) — so a padded unit like 'BTL ' fails `= 'BTL'` and
 *  stays ×1, exactly as the SQL CASE does. */
function reqPackFactor(riUnit: string | null, unit: string, purchaseUnit: string | null, packSize: number | null): number {
  return (String(riUnit ?? '').trim() !== '' && riUnit === purchaseUnit && riUnit !== unit && (Number(packSize) || 1) > 1)
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

  // Latest closing count per (department, material) — the anchor is computed
  // PER dept in the set, not once across the whole set, so a main-dept rollup
  // keeps every sub-dept's own count instead of collapsing to a single latest
  // row. date is the end-of-day count date; tie-break on created_at for
  // same-day recounts. Ascending order → last write per (dept,material) wins.
  const anchorRows = db.prepare(`
    SELECT cs.material_id, cs.department_id, cs.physical_stock, cs.date
    FROM closing_stock cs
    WHERE cs.department_id IN (SELECT value FROM json_each(?))
    ORDER BY cs.date ASC, cs.created_at ASC
  `).all(setJson) as { material_id: string; department_id: string; physical_stock: number; date: string }[];
  const anchorsByMat = new Map<string, Map<string, { physical_stock: number; date: string }>>();
  for (const a of anchorRows) {
    let m = anchorsByMat.get(a.material_id);
    if (!m) { m = new Map(); anchorsByMat.set(a.material_id, m); }
    m.set(a.department_id, { physical_stock: a.physical_stock, date: a.date });
  }

  // Every qualifying issue line for the deptSet (all time — the 30d window
  // for never-counted materials is applied per-entry below). owner_dept is the
  // line's owning dept (same rule as the issue routes / analytics) so its
  // issued_since can be measured from THAT dept's own anchor.
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

  // Counted-but-never-issued materials still get a row (row set = UNION).
  const countedOnly = db.prepare(`
    SELECT rm.id AS material_id, rm.name, rm.category, rm.unit, rm.purchase_unit,
           rm.pack_size, rm.average_price
    FROM raw_materials rm
    WHERE rm.id IN (SELECT cs.material_id FROM closing_stock cs
                    WHERE cs.department_id IN (SELECT value FROM json_each(?)))
  `).all(setJson) as any[];

  const cutoff30 = (() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  })();

  interface Acc {
    name: string; category: string; unit: string; purchase_unit: string;
    pack_size: number; average_price: number;
    /** issued_since accumulated PER owning dept (each measured from that
     *  dept's own anchor / 30d window), summed across depts at roll-up. */
    issuedByDept: Map<string, number>;
    last_issue_at: string | null;
  }
  const acc = new Map<string, Acc>();
  const ensure = (id: string, m: any): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = {
        name: m.name, category: m.category || '', unit: m.unit || '',
        purchase_unit: m.purchase_unit || '', pack_size: Number(m.pack_size) || 1,
        average_price: Number(m.average_price) || 0,
        issuedByDept: new Map(), last_issue_at: null,
      };
      acc.set(id, a);
    }
    return a;
  };
  for (const m of countedOnly) ensure(m.material_id, m);

  for (const ln of issueLines) {
    const a = ensure(ln.material_id, ln);
    const factor = reqPackFactor(ln.req_unit, ln.unit, ln.purchase_unit, ln.pack_size);
    // This line's issued_since is measured from ITS OWN dept's anchor for the
    // material (not a set-wide anchor) — that keeps each sub-dept's balance
    // independent before the roll-up sums them.
    const owner = String(ln.owner_dept || '');
    const anchor = anchorsByMat.get(ln.material_id)?.get(owner);
    // Issues count as "since" only strictly after the anchor's end-of-day;
    // never-counted (dept,material) pairs use a rolling 30-day receipt window.
    const sinceDate = anchor ? anchor.date : cutoff30;
    const sinceTs = sinceDate + 'T23:59:59';

    let hist: any[] = [];
    try { hist = JSON.parse(ln.issue_history || '[]'); } catch { hist = []; }
    let add = 0;
    if (Array.isArray(hist) && hist.length > 0) {
      for (const h of hist) {
        const at = String(h && h.at || '');
        const qty = Number(h && h.qty) || 0;
        if (qty <= 0 || !at) continue;
        if (!a.last_issue_at || at > a.last_issue_at) a.last_issue_at = at;
        if (at > sinceTs) add += qty * factor;
      }
    } else {
      // One-shot store-process + Recaho imports: quantity_issued with an
      // empty history — dated by the requisition's own date.
      const rd = String(ln.req_date || '');
      if (rd && (!a.last_issue_at || rd > a.last_issue_at)) a.last_issue_at = rd;
      if (rd > sinceDate) add += (Number(ln.quantity_issued) || 0) * factor;
    }
    if (add) a.issuedByDept.set(owner, (a.issuedByDept.get(owner) || 0) + add);
  }

  const rows: DeptStockRow[] = [];
  let estValue = 0, neverCounted = 0;
  for (const [id, a] of acc) {
    // Roll up PER (dept,material): each dept in the set contributes its own
    // anchor + its own issued_since; sum on_hand_est / issued_since / last_count
    // across depts. never_counted only when NO dept has an anchor.
    const anchorMap = anchorsByMat.get(id);
    const depts = new Set<string>([...(anchorMap ? anchorMap.keys() : []), ...a.issuedByDept.keys()]);
    let onHand = 0, issued = 0, lastCount = 0;
    let lastCountDate: string | null = null, hasAnchor = false;
    for (const d of depts) {
      const anc = anchorMap ? anchorMap.get(d) : undefined;
      const iss = a.issuedByDept.get(d) || 0;
      onHand += (anc ? anc.physical_stock : 0) + iss;
      issued += iss;
      if (anc) {
        hasAnchor = true;
        lastCount += anc.physical_stock;
        if (!lastCountDate || anc.date > lastCountDate) lastCountDate = anc.date;
      }
    }
    const never = !hasAnchor;
    const est = onHand * a.average_price;
    if (never) neverCounted++;
    estValue += est;
    rows.push({
      material_id: id,
      name: a.name, category: a.category, unit: a.unit,
      purchase_unit: a.purchase_unit, pack_size: a.pack_size,
      average_price: a.average_price,
      last_count: never ? null : lastCount,
      last_count_date: never ? null : lastCountDate,
      issued_since: Math.round(issued * 10000) / 10000,
      on_hand_est: Math.round(onHand * 10000) / 10000,
      never_counted: never,
      last_issue_at: a.last_issue_at,
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
    },
  };
}
