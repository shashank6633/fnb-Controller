import type Database from 'better-sqlite3';

/**
 * WHAT CHANGED on a PO awaiting re-approval — computed, never stored.
 *
 * The owner's question, verbatim: "For which item is the reapproval being asked
 * for? is it a newly added item or qty of a item has been changed or the price
 * changed?" The approver scanning /purchase-orders must see that WITHOUT
 * opening anything, and the expanded row must show each change old → new.
 *
 * WHERE THE BEFORE-STATE COMES FROM. [id]/edit-approved is the ONLY writer of
 * status 'pending_reapproval', and it logs a 'po.edit' audit event whose
 * before_json carries the full line set it deleted (material_id, quantity,
 * unit_price, total_price, vendor, vendor_id) plus the pre-edit total_cost —
 * see logAuditEvent's call at edit-approved/route.ts:301. That route also
 * refuses any PO that is not currently 'approved', so a PO can carry AT MOST
 * ONE edit per approval cycle: once edited it is pending_reapproval, and no
 * other endpoint rewrites its lines until approve/reject moves it on. The
 * latest 'po.edit' event's before-state therefore IS the last-approved state.
 *
 * Defensively — should a second writer ever appear — the diff is still taken
 * CUMULATIVELY: baseline = the EARLIEST 'po.edit' since the last approval event
 * ('po.approve' / 'po.auto_approved', the two approval writers), because that
 * is the state the approver last signed and is now re-approving against; and
 * `edits` lists every individual edit event (who / when / reason) in order.
 *
 * THE AFTER-STATE IS THE LIVE LINE SET, not the event's after_json: the lines
 * on the PO right now are what the approver is being asked to sign, and the
 * event's after items don't carry vendor. Names/units come from raw_materials
 * via LEFT JOIN so a since-deleted material still shows (by id) rather than
 * silently vanishing from the change list.
 *
 * HONESTY RULE. A pending_reapproval PO whose edit predates the audit event
 * (older data), or whose before_json cannot be decoded, returns
 * { recorded: false } and the UI must say "change details were not recorded
 * for this edit" — NEVER an empty diff presented as "no changes".
 *
 * UNITS (owner's law): purchase_order_items.quantity is PURCHASE units and
 * unit_price is ₹/purchase-unit — both sides of every old → new here share
 * that basis, and `purchase_unit` on each entry is the PURCHASE-unit label
 * (COALESCE(purchase_unit, unit), same derivation as the PO detail API).
 * Nothing here converts; display-side hints are the page's job.
 *
 * This module has NO runtime imports (the Database import is type-only), so
 * 'use client' files may import its TYPES; the compute function itself is
 * server-only by virtue of taking a live db handle.
 */

/** The receive route's own quantity slack (receive/route.ts QTY_EPS). */
const QTY_EPS = 1e-6;
/** Half a paisa — the PO page's RATE_EPS; differences the server would ignore
 *  must not be reported as changes here either. */
const RATE_EPS = 0.005;
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** One line as it stands on one side of the diff. Purchase-unit basis. */
export interface PoDiffLine {
  material_id: string;
  /** Master name, falling back to the raw id when the master row is gone. */
  material_name: string;
  material_sku: string;
  /** PURCHASE unit label — the basis of qty and rate. May be '' on a deleted material. */
  purchase_unit: string;
  vendor: string;
  qty: number;
  rate: number;
  value: number;
}

export interface PoQtyChange {
  material_id: string; material_name: string;
  /** PURCHASE unit label — old/new qty basis. */
  purchase_unit: string;
  old_qty: number; new_qty: number;
  /** new − old, purchase units. */
  qty_delta: number;
  /** new line value − old line value, ₹. Stated once per line, on the qty entry,
   *  when the SAME line also changed rate — see valueDeltaOnce below. */
  value_delta: number;
}

export interface PoRateChange {
  material_id: string; material_name: string;
  /** PURCHASE unit label — the ₹/unit basis of both rates. */
  purchase_unit: string;
  old_rate: number; new_rate: number;
  /** new line value − old line value, ₹ — 0 when the qty entry for the same
   *  line already carries it (never double-stated). */
  value_delta: number;
}

export interface PoVendorChange {
  material_id: string; material_name: string;
  old_vendor: string; new_vendor: string;
}

/** One edit event: who sent the PO back, when, and the reason they typed. */
export interface PoEditEvent { by: string; at: string; reason: string }

export interface PoReapprovalChanges {
  /** false = the edit predates change tracking (or its record is undecodable);
   *  every list below is then empty and MUST be rendered as "not recorded",
   *  never as "no changes". */
  recorded: boolean;
  /** Who made the (latest) edit, when, and the required reason. Empty strings
   *  when !recorded. */
  edited_by: string;
  edited_at: string;
  reason: string;
  /** Every edit since the last approval, oldest first (today: exactly one). */
  edits: PoEditEvent[];
  added: PoDiffLine[];
  removed: PoDiffLine[];
  qty_changes: PoQtyChange[];
  rate_changes: PoRateChange[];
  vendor_changes: PoVendorChange[];
  /** total_cost as last approved / as it stands now / the difference. */
  total_before: number;
  total_after: number;
  total_delta: number;
  /** Materials whose CURRENT line differs from (or is new to) the approved set
   *  — for highlighting rows in the existing line table. Removed materials are
   *  deliberately absent: they have no row to highlight. */
  changed_material_ids: string[];
}

type AuditRow = {
  actor_email: string; before_json: string | null; after_json: string | null;
  note: string; created_at: string; rid: number;
};

/** Decode one audit item list defensively; null = undecodable (→ !recorded). */
function decodeItems(json: string | null): { items: any[]; total_cost: number | null } | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    if (!v || !Array.isArray(v.items)) return null;
    return { items: v.items, total_cost: Number.isFinite(Number(v.total_cost)) ? Number(v.total_cost) : null };
  } catch { return null; }
}

const norm = (s: unknown) => String(s ?? '').trim();
const vendorKey = (s: unknown) => norm(s).toLowerCase();

/**
 * Compute the change-set a pending_reapproval PO is asking to be re-approved
 * for. Callers gate on status themselves (this runs on whatever PO it is
 * given); returns null only when the PO does not exist.
 *
 * Cost: three bounded statements (audit rows for one PO, its current lines,
 * names for removed materials) — safe to run per pending_reapproval row on the
 * list, of which there are at most a handful at a time.
 */
export function poReapprovalChanges(db: Database.Database, poId: string): PoReapprovalChanges | null {
  const id = norm(poId);
  if (!id) return null;
  const po = db.prepare('SELECT id, total_cost FROM purchase_orders WHERE id = ?').get(id) as any;
  if (!po) return null;

  const notRecorded = (totalAfter: number): PoReapprovalChanges => ({
    recorded: false,
    edited_by: '', edited_at: '', reason: '', edits: [],
    added: [], removed: [], qty_changes: [], rate_changes: [], vendor_changes: [],
    total_before: 0, total_after: r2(totalAfter), total_delta: 0,
    changed_material_ids: [],
  });

  // Every po.edit, newest first; rowid breaks same-second ties the way the
  // insert order did.
  const edits = db.prepare(`
    SELECT actor_email, before_json, after_json, note, created_at, rowid AS rid
    FROM audit_events
    WHERE entity_type = 'purchase_order' AND entity_id = ? AND event_type = 'po.edit'
    ORDER BY created_at DESC, rowid DESC
  `).all(id) as AuditRow[];
  if (edits.length === 0) return notRecorded(po.total_cost);

  // Scope to the edits since the LAST approval (po.approve / po.auto_approved).
  // With no approval event on record, the latest edit alone is the cycle — its
  // before-state is an approved state by the route's own precondition.
  const lastApprove = db.prepare(`
    SELECT created_at, rowid AS rid
    FROM audit_events
    WHERE entity_type = 'purchase_order' AND entity_id = ?
      AND event_type IN ('po.approve', 'po.auto_approved')
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(id) as any;
  // Tie-break on (created_at, rowid): created_at is second-resolution, so an
  // edit and the re-approval that signed it can share a timestamp (edit then
  // approve inside one second). Only edits inserted AFTER the approval row —
  // strictly later second, or same second with a larger rowid — belong to the
  // new cycle; a plain created_at >= comparison would drag the already-approved
  // edit back in and regress the baseline past what the approver last signed.
  let cycle = lastApprove
    ? edits.filter(e =>
        e.created_at > String(lastApprove.created_at)
        || (e.created_at === String(lastApprove.created_at) && Number(e.rid) > Number(lastApprove.rid)))
    : [edits[0]];
  if (cycle.length === 0) cycle = [edits[0]];   // clock oddity — stay honest with the latest edit
  cycle = cycle.slice().reverse();               // oldest first
  const baseline = decodeItems(cycle[0].before_json);
  if (!baseline) return notRecorded(po.total_cost);
  const latest = cycle[cycle.length - 1];

  // The live line set — what the approver is actually signing. LEFT JOIN: a
  // deleted master row must not hide a line from the change list.
  const nowLines = db.prepare(`
    SELECT poi.material_id, poi.quantity, poi.unit_price, poi.total_price, poi.vendor,
           rm.name AS material_name, rm.sku AS material_sku,
           COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS purchase_unit
    FROM purchase_order_items poi
    LEFT JOIN raw_materials rm ON rm.id = poi.material_id
    WHERE poi.po_id = ?
  `).all(id) as any[];

  // Names/units for materials only the BEFORE side has (removed lines).
  const beforeIds = [...new Set(baseline.items.map(it => norm(it?.material_id)).filter(Boolean))];
  const metaById = new Map<string, { name: string; sku: string; unit: string }>();
  if (beforeIds.length > 0) {
    const rows = db.prepare(`
      SELECT id, name, sku, COALESCE(NULLIF(TRIM(purchase_unit), ''), unit) AS purchase_unit
      FROM raw_materials WHERE id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(beforeIds)) as any[];
    for (const r of rows) metaById.set(String(r.id), { name: String(r.name || ''), sku: String(r.sku || ''), unit: String(r.purchase_unit || '') });
  }

  // One material = one line is enforced on every write path (duplicateLineError),
  // so material_id is the line identity. Last-one-wins here is defensive only.
  const beforeBy = new Map<string, any>();
  for (const it of baseline.items) {
    const m = norm(it?.material_id);
    if (m) beforeBy.set(m, it);
  }
  const afterBy = new Map<string, any>();
  for (const it of nowLines) {
    const m = norm(it.material_id);
    if (m) afterBy.set(m, it);
  }

  const lineOf = (materialId: string, src: any, fromDb: boolean): PoDiffLine => {
    const meta = metaById.get(materialId);
    return {
      material_id: materialId,
      material_name: fromDb ? (norm(src.material_name) || materialId) : (meta?.name || materialId),
      material_sku: fromDb ? norm(src.material_sku) : (meta?.sku || ''),
      purchase_unit: fromDb ? norm(src.purchase_unit) : (meta?.unit || ''),
      vendor: norm(src.vendor),
      qty: Number(src.quantity) || 0,
      rate: Number(src.unit_price) || 0,
      // Both factors are PO-line canon: qty in PURCHASE units, rate Rs/purchase-unit.
      value: r2(src.total_price != null ? Number(src.total_price) : (Number(src.quantity) || 0) * (Number(src.unit_price) || 0)), // rate-basis: purchase
    };
  };

  const added: PoDiffLine[] = [];
  const removed: PoDiffLine[] = [];
  const qtyChanges: PoQtyChange[] = [];
  const rateChanges: PoRateChange[] = [];
  const vendorChanges: PoVendorChange[] = [];
  const changedIds = new Set<string>();

  for (const [mid, after] of afterBy) {
    const before = beforeBy.get(mid);
    if (!before) {
      added.push(lineOf(mid, after, true));
      changedIds.add(mid);
      continue;
    }
    const name = norm(after.material_name) || mid;
    const pu = norm(after.purchase_unit);
    const oldQty = Number(before.quantity) || 0;
    const newQty = Number(after.quantity) || 0;
    const oldRate = Number(before.unit_price) || 0;
    const newRate = Number(after.unit_price) || 0;
    const oldVal = r2(before.total_price != null ? Number(before.total_price) : oldQty * oldRate); // rate-basis: purchase
    const newVal = r2(after.total_price != null ? Number(after.total_price) : newQty * newRate); // rate-basis: purchase
    const qtyMoved = Math.abs(newQty - oldQty) > QTY_EPS;
    const rateMoved = Math.abs(newRate - oldRate) > RATE_EPS;
    // The line's money moved ONCE, whichever inputs moved it — stated on the qty
    // entry when both changed, so summing every value_delta gives the line delta
    // exactly once (and Σ over all entries + added − removed = total_delta).
    const valueDeltaOnce = r2(newVal - oldVal);
    if (qtyMoved) {
      qtyChanges.push({
        material_id: mid, material_name: name, purchase_unit: pu,
        old_qty: oldQty, new_qty: newQty, qty_delta: newQty - oldQty,
        value_delta: valueDeltaOnce,
      });
      changedIds.add(mid);
    }
    if (rateMoved) {
      rateChanges.push({
        material_id: mid, material_name: name, purchase_unit: pu,
        old_rate: oldRate, new_rate: newRate,
        value_delta: qtyMoved ? 0 : valueDeltaOnce,
      });
      changedIds.add(mid);
    }
    if (vendorKey(before.vendor) !== vendorKey(after.vendor)) {
      vendorChanges.push({
        material_id: mid, material_name: name,
        old_vendor: norm(before.vendor), new_vendor: norm(after.vendor),
      });
      changedIds.add(mid);
    }
  }
  for (const [mid, before] of beforeBy) {
    if (!afterBy.has(mid)) removed.push(lineOf(mid, before, false));
  }

  const totalBefore = baseline.total_cost != null
    ? r2(baseline.total_cost)
    : r2(baseline.items.reduce((s, it) => s + (Number(it?.total_price) || 0), 0));
  const totalAfter = r2(po.total_cost);

  return {
    recorded: true,
    edited_by: norm(latest.actor_email),
    edited_at: norm(latest.created_at),
    reason: norm(latest.note),
    edits: cycle.map(e => ({ by: norm(e.actor_email), at: norm(e.created_at), reason: norm(e.note) })),
    added, removed,
    qty_changes: qtyChanges,
    rate_changes: rateChanges,
    vendor_changes: vendorChanges,
    total_before: totalBefore,
    total_after: totalAfter,
    total_delta: r2(totalAfter - totalBefore),
    changed_material_ids: [...changedIds],
  };
}
