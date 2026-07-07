import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Post-party reconciliation of a department's on-hand materials.
 *
 * After a party the department reports how much of each transferred material is
 * LEFT OVER. Whatever is missing between what they held (on_hand) and what is
 * left is treated as CONSUMED. Optionally, the leftover can be RETURNED to the
 * main store instead of being kept on the department's books.
 *
 * POST /api/department-materials/reconcile
 *   body: {
 *     department_id: string,
 *     event_name?: string,
 *     event_date?: string,
 *     items: [{ material_id, leftover_qty, return_to_store?: boolean }]
 *   }
 *
 * Per item:
 *   consumed = max(0, on_hand − leftover_qty)
 *   • department_materials.on_hand = leftover_qty
 *   • dept tx 'consumed' (quantity = −consumed, balance_after = leftover_qty)
 *   If return_to_store:
 *   • raw_materials.current_stock += leftover_qty
 *   • department_materials.on_hand -= leftover_qty  (→ 0)
 *   • dept tx 'returned' (quantity = −leftover, balance_after = 0)
 *   • store inventory_transactions row (+leftover, type 'adjustment',
 *     notes 'party leftover return')
 *
 * All writes run inside a single db.transaction.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const departmentId: string = body?.department_id;
    const eventName: string = body?.event_name || '';
    const eventDate: string = body?.event_date || '';
    const items: Array<{ material_id: string; leftover_qty: number; return_to_store?: boolean }> =
      Array.isArray(body?.items) ? body.items : [];

    if (!departmentId) return Response.json({ error: 'department_id required' }, { status: 400 });
    if (items.length === 0) return Response.json({ error: 'No items to reconcile' }, { status: 400 });

    const db = getDb();

    const selDeptMat = db.prepare(`
      SELECT dm.id, dm.on_hand, dm.outlet_id
      FROM department_materials dm
      WHERE dm.department_id = ? AND dm.material_id = ?
    `);
    const updDeptMat = db.prepare(`
      UPDATE department_materials SET on_hand = ?, updated_at = datetime('now') WHERE id = ?
    `);
    const insDeptTx = db.prepare(`
      INSERT INTO department_material_transactions
        (id, outlet_id, department_id, material_id, type, quantity, balance_after,
         reference_id, event_name, event_date, notes, user, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    const incStock = db.prepare(`
      UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    const insStoreTx = db.prepare(`
      INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
      VALUES (?, ?, 'adjustment', ?, ?, ?, datetime('now'))
    `);

    const note = `Party: ${eventName || '(unnamed)'} @ ${eventDate || ''}`.trim();
    const results: any[] = [];

    const txn = db.transaction(() => {
      for (const it of items) {
        const materialId = it.material_id;
        if (!materialId) continue;
        const existing = selDeptMat.get(departmentId, materialId) as any;
        if (!existing) continue;

        const outletId = existing.outlet_id || null;
        const onHand = Number(existing.on_hand) || 0;
        let leftover = Math.max(0, Number(it.leftover_qty) || 0);
        if (leftover > onHand) leftover = onHand; // can't leave more than held

        const consumed = Math.max(0, onHand - leftover);

        // 1) Consumption — set on_hand to leftover, log a 'consumed' row.
        updDeptMat.run(leftover, existing.id);
        insDeptTx.run(generateId(), outletId, departmentId, materialId,
          'consumed', -consumed, leftover, null, eventName, eventDate, note, me.email);

        let returned = 0;
        if (it.return_to_store && leftover > 0) {
          returned = leftover;
          // 2) Return leftover to store — dept on_hand → 0, credit store.
          updDeptMat.run(0, existing.id);
          insDeptTx.run(generateId(), outletId, departmentId, materialId,
            'returned', -returned, 0, null, eventName, eventDate, 'party leftover return', me.email);
          incStock.run(returned, materialId);
          insStoreTx.run(generateId(), materialId, returned, null, 'party leftover return');
        }

        results.push({
          material_id: materialId,
          on_hand_before: onHand,
          consumed,
          leftover: it.return_to_store ? 0 : leftover,
          returned,
        });
      }
    });
    txn();

    return Response.json({ ok: true, reconciled: results, count: results.length });
  } catch (e: any) {
    console.error('[department-materials reconcile]', e);
    return Response.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
