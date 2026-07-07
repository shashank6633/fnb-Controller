import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';

/**
 * Centralised PARTY fulfilment TRANSFER: store → department.
 *
 * When a party requisition (requisitions.purpose='party') reaches its final
 * 'fulfilled' state, the materials it issued must move OUT of the store and INTO
 * the owning department's on-hand balance:
 *
 *   - STORE side  (raw_materials.current_stock / inventory_transactions):
 *       current_stock -= issued, plus a 'party_consumption' ledger row
 *       (quantity = -issued). current_stock = purchases − recipe − party.
 *   - DEPT side   (department_materials / department_material_transactions):
 *       on_hand += issued, plus a 'received' ledger row (quantity = +issued,
 *       balance_after = new on_hand). This is what departments later draw down
 *       to record leftover balance / consumption post-party.
 *
 * The 'party_consumption' inventory_transactions row is the single source of
 * truth for de-duplication: if one already exists for this requisition, the
 * transfer has already happened and this is a no-op. That makes the helper safe
 * to call from BOTH fulfilment paths (store-process batch + store-issue
 * incremental) without any risk of double-deduction.
 *
 * All writes run inside a single db.transaction.
 *
 * @param db         open better-sqlite3 database
 * @param reqId      requisition id
 * @param actorEmail the store person performing the fulfilment (stamped on dept ledger)
 * @returns { transferred: Array<{material_id, issued, department_id}>, total }
 */
export function applyPartyFulfillment(
  db: Database.Database,
  reqId: string,
  actorEmail: string,
): { transferred: Array<{ material_id: string; issued: number; department_id: string | null }>; total: number } {
  const req = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(reqId) as any;
  if (!req) {
    console.warn(`[party-fulfillment] requisition ${reqId} not found — skip`);
    return { transferred: [], total: 0 };
  }

  // Idempotency guard — the presence of a 'party_consumption' ledger row for
  // this requisition means the store→dept transfer already ran. Never repeat it.
  const already = db.prepare(`
    SELECT 1 FROM inventory_transactions
    WHERE reference_id = ? AND type = 'party_consumption'
    LIMIT 1
  `).get(reqId);
  if (already) {
    console.log(`[party-fulfillment] requisition ${reqId} already transferred — skip`);
    return { transferred: [], total: 0 };
  }

  const items = db.prepare(`
    SELECT ri.id, ri.material_id, ri.quantity_issued, ri.department_id,
           rm.current_stock
    FROM requisition_items ri
    JOIN raw_materials rm ON rm.id = ri.material_id
    WHERE ri.req_id = ?
  `).all(reqId) as any[];

  const partyNote = `Party: ${req.event_name || '(unnamed)'} @ ${req.event_date || ''}`.trim();
  const eventName = req.event_name || '';
  const eventDate = req.event_date || '';
  const outletId = req.outlet_id || null;

  const decStock = db.prepare(`
    UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  const insStoreTx = db.prepare(`
    INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
    VALUES (?, ?, 'party_consumption', ?, ?, ?, datetime('now'))
  `);
  const selDeptMat = db.prepare(`
    SELECT id, on_hand FROM department_materials WHERE department_id = ? AND material_id = ?
  `);
  const insDeptMat = db.prepare(`
    INSERT INTO department_materials (id, outlet_id, department_id, material_id, on_hand, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  const updDeptMat = db.prepare(`
    UPDATE department_materials SET on_hand = ?, updated_at = datetime('now') WHERE id = ?
  `);
  const insDeptTx = db.prepare(`
    INSERT INTO department_material_transactions
      (id, outlet_id, department_id, material_id, type, quantity, balance_after,
       reference_id, event_name, event_date, notes, user, created_at)
    VALUES (?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const transferred: Array<{ material_id: string; issued: number; department_id: string | null }> = [];

  const txn = db.transaction(() => {
    for (const it of items) {
      const issued = Number(it.quantity_issued) || 0;
      if (issued <= 0) continue;
      const deptId: string | null = it.department_id || req.department_id || null;

      // STORE: decrement current_stock + ledger row.
      decStock.run(issued, it.material_id);
      insStoreTx.run(generateId(), it.material_id, -issued, reqId, partyNote);

      // DEPT: upsert on_hand + append received ledger row.
      if (deptId) {
        const existing = selDeptMat.get(deptId, it.material_id) as any;
        let newOnHand: number;
        if (existing) {
          newOnHand = (Number(existing.on_hand) || 0) + issued;
          updDeptMat.run(newOnHand, existing.id);
        } else {
          newOnHand = issued;
          insDeptMat.run(generateId(), outletId, deptId, it.material_id, newOnHand);
        }
        insDeptTx.run(generateId(), outletId, deptId, it.material_id, issued, newOnHand,
                      reqId, eventName, eventDate, partyNote, actorEmail);
      }

      transferred.push({ material_id: it.material_id, issued, department_id: deptId });
    }
  });
  txn();

  return { transferred, total: transferred.length };
}
