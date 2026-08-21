import type Database from 'better-sqlite3';
import { generateId, logAuditEvent } from './db';

/* ══════════════════════════════════════════════════════════════════════════
 * THE PO → REQUISITION FULFIL CASCADE, IN ONE PLACE.
 *
 * SERVER ONLY. Call INSIDE the caller's db.transaction(): it writes
 * requisitions, raw_materials.current_stock and inventory_transactions, and
 * those must commit or roll back with the decision that triggered them.
 *
 * ── WHY IT MOVED HERE ──────────────────────────────────────────────────────
 * It used to live inline at the end of POST /api/purchase-orders/[id]/receive,
 * gated on `po.requisition_id && isComplete`. The kitchen QC gate broke that
 * single trigger in two: a PO can now be COMPLETE on the receipt ledger (every
 * line has a GRN row) while its goods are still sitting in 'awaiting_qc' and no
 * stock has been credited. Firing the party branch there would DEDUCT stock
 * that was never added — taking the goods out of some other receipt's balance.
 *
 * So the cascade now fires from whichever of the two places is LAST:
 *   · POST …/receive          — when the PO completes and NO GRN of it is held
 *   · decideGrnQc (grn-qc.ts) — when a sign-off clears the LAST held GRN of a
 *                               complete PO
 * One helper, two callers, one behaviour. Copying it would have been two
 * behaviours the day one of them was edited.
 *
 * ── THE BODY IS UNCHANGED ──────────────────────────────────────────────────
 * Lifted verbatim from receive/route.ts. Only three names were rewritten —
 * po.requisition_id → requisitionId, po.outlet_id → poOutletId,
 * receivedByEmail → actorEmail. Every comment, every guard, the effective-qty
 * rule, the pack factor and the average_price basis are exactly as they were;
 * they are load-bearing and are documented in place below.
 *
 * ── IT IS ITS OWN REPLAY GUARD ─────────────────────────────────────────────
 * Two guards, both pre-existing:
 *   · the requisitions UPDATE is `WHERE … AND status = 'store_processed'`, so a
 *     second call moves nothing, and `willFulfill` is read BEFORE it — a second
 *     caller sees 'fulfilled', not 'store_processed', and skips the party
 *     branch entirely;
 *   · the party branch additionally probes inventory_transactions for an
 *     existing 'party_consumption' row on this requisition and logs a skip.
 * Do not add a third; these two already make the double-call safe, which is
 * exactly what two callers require.
 * ══════════════════════════════════════════════════════════════════════════ */

export interface RequisitionCascadeInput {
  requisitionId: string;
  /** The PO's outlet — the fallback stamp when the requisition has none. */
  poOutletId: string | null;
  /** Who is credited in the audit trail: the receiver, or the QC signer. */
  actorEmail: string;
}

export function fulfilRequisitionFromPo(
  db: Database.Database,
  { requisitionId, poOutletId, actorEmail }: RequisitionCascadeInput,
): void {
  if (!requisitionId) return;
  const reqRow = db.prepare(`SELECT * FROM requisitions WHERE id = ?`).get(requisitionId) as any;
  const willFulfill = reqRow && reqRow.status === 'store_processed';
  db.prepare(`
    UPDATE requisitions
    SET status = 'fulfilled', fulfilled_at = datetime('now'), fulfilled_by = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'store_processed'
  `).run('po-received-cascade', requisitionId);

  // Party requisition fulfilled via PO-receive cascade — deduct now.
  // (Internal requisitions remain audit-only and never enter this branch.)
  if (willFulfill && reqRow.purpose === 'party') {
    const already = db.prepare(`
      SELECT 1 FROM inventory_transactions
      WHERE reference_id = ? AND type = 'party_consumption'
      LIMIT 1
    `).get(requisitionId);
    if (already) {
      logAuditEvent(db, {
        event_type: 'requisition.party_consumption.skipped',
        entity_type: 'requisition',
        entity_id: requisitionId,
        actor_email: actorEmail,
        after: { reason: 'already_deducted' },
        note: 'Party consumption skipped — inventory_transactions row already exists',
      });
    } else {
      const reqItems = db.prepare(`
        -- No last_purchase_price here on purpose. That column is stored in
        -- MIXED bases (some rows ₹/purchase-unit, some already ₹/recipe-unit),
        -- so it cannot be normalised by any formula. average_price is the
        -- sanctioned single-basis rate — see src/lib/closing-valuation.ts and
        -- src/app/api/department-variance/route.ts:620-622.
        SELECT ri.*, rm.name AS material_name, rm.average_price,
               rm.unit AS rm_unit, rm.purchase_unit AS rm_purchase_unit,
               COALESCE(rm.pack_size, 1) AS rm_pack_size
        FROM requisition_items ri
        JOIN raw_materials rm ON rm.id = ri.material_id
        WHERE ri.req_id = ?
          -- A line the chef or the store REFUSED never leaves the store, so
          -- it can never be consumed. Without this filter a rejected line
          -- still carried its quantity_requested into the fallback below.
          AND COALESCE(ri.is_rejected, 0) = 0
          AND COALESCE(ri.store_rejected, 0) = 0
      `).all(requisitionId) as any[];
      const decStock = db.prepare(`
        UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now')
        WHERE id = ?
      `);
      const insPartyTx = db.prepare(`
        INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, outlet_id, created_at)
        VALUES (?, ?, 'party_consumption', ?, ?, ?, ?, datetime('now'))
      `);
      // The consumption belongs to the requisition's outlet (PO's as a
      // fallback); an unstamped row is backfilled to the DEFAULT outlet.
      const partyOutletId = reqRow.outlet_id || poOutletId || null;
      const partyNote = `Party: ${reqRow.event_name || '(unnamed)'} @ ${reqRow.event_date || ''}`.trim();
      const auditItems: any[] = [];
      let totalCost = 0;
      for (const it of reqItems) {
        /* EFFECTIVE QTY — the house rule (store-issue/route.ts, dept-stock,
           party-approvals): what the chef APPROVED, falling back to what was
           requested only when no approval was recorded. The old fallback was
           raw quantity_requested, so a line the chef trimmed 10 → 4, or
           rejected outright, still deducted 10 — and once the pack factor
           below was applied that became 7,500 ml of a material nobody
           released. Cap at the approved figure and this cannot recur. */
        const effApproved = (it.chef_approved_qty != null
          ? Number(it.chef_approved_qty)
          : Number(it.quantity_requested)) || 0;
        const issuedReq = Math.min(Number(it.quantity_issued) || effApproved, effApproved);
        if (issuedReq <= 0) continue;
        // ri.unit → RECIPE units. Requisition quantities are stored in the
        // LINE's OWN unit (option B), so a "2 BTL" line is TWO BOTTLES —
        // deducting it verbatim took 2 ml off stock instead of 1,500 ml
        // and wrote a −2 party_consumption row. Same pack-factor CASE as
        // src/lib/party-fulfillment.ts and the department-consumption SQL;
        // keep the three byte-equivalent.
        const rPack = Number(it.rm_pack_size) || 1;
        const reqPackFactor =
          (String(it.unit ?? '').trim() !== '' &&
           it.unit === it.rm_purchase_unit &&
           it.unit !== it.rm_unit &&
           rPack > 1)
            ? rPack : 1;
        const issued = issuedReq * reqPackFactor;   // RECIPE units
        decStock.run(issued, it.material_id);
        insPartyTx.run(generateId(), it.material_id, -issued, requisitionId, partyNote, partyOutletId);
        /* BOTH SIDES OF THIS MULTIPLICATION ARE ON THE RECIPE BASIS.
           LEFT  — `issued` is RECIPE units (ml/g): issuedReq is in the LINE's
                   own unit and reqPackFactor above lifted a purchase-unit
                   line into recipe units.
           RIGHT — raw_materials.average_price is ₹ per RECIPE unit by canon,
                   so it needs NO pack conversion. Dividing it by rPack, or
                   multiplying it up, would break the trio.
           It used to read last_purchase_price / rPack here. That column is
           stored in MIXED bases: of the 190 packed materials that hold both a
           stored LPP and a purchase history, 71 are ALREADY ₹/recipe-unit, so
           the divide fired a second time — MALA STRAWBERRY CRUSH 5 LTR
           (ml/BTL, pack 5000, avg ₹0.13482/ml) logged ₹0.13 for a full bottle
           instead of ₹674.10, and `lppRecipe || average_price` short-circuited
           on that non-zero wrong value so the correct rate on the same row was
           never reached. average_price is the sanctioned rate for a
           recipe-unit quantity (src/lib/closing-valuation.ts ladder). */
        const unitCost = Number(it.average_price) || 0;   // ₹ / RECIPE unit
        const lineCost = Math.round(issued * unitCost * 100) / 100;
        totalCost += lineCost;
        auditItems.push({
          material_id: it.material_id,
          material_name: it.material_name,
          quantity: issued,
          unit_cost: unitCost,
          line_cost: lineCost,
        });
      }
      logAuditEvent(db, {
        event_type: 'requisition.party_consumption',
        entity_type: 'requisition',
        entity_id: requisitionId,
        actor_email: actorEmail,
        after: { items: auditItems, total_cost: Math.round(totalCost * 100) / 100 },
        note: partyNote,
      });
    }
  }
}
