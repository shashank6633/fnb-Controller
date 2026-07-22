import { getDb, generateId, updateMaterialPrice } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { centralFlowBlock } from '@/lib/store-engine';
import { checkPurchaseDate } from '@/lib/purchase-guard';

/**
 * GRN read API. Listing + detail.
 *
 * GET /api/grn                  → list (?from=&to=&vendor_id=&status=)
 * GET /api/grn?id=X             → detail with line items + linked PO
 *
 * POST /api/grn → ad-hoc GRN for receipts WITHOUT a parent PO (cash buy, sample,
 *                  donation, return). Creates the GRN + a `purchases` row per
 *                  accepted line + bumps stock + writes inventory_transactions.
 *   body: {
 *     date, vendor_id?, vendor, invoice_number?, invoice_date?, qc_by?, notes?,
 *     items: [{
 *       material_id, quantity_received, quantity_accepted?, rejection_reason?,
 *       unit_price, notes?
 *     }]
 *   }
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (id) {
      const grn = db.prepare(`
        SELECT g.*, po.po_number AS po_number, po.status AS po_status
        FROM goods_receipt_notes g
        LEFT JOIN purchase_orders po ON po.id = g.po_id
        WHERE g.id = ?
      `).get(id);
      if (!grn) return Response.json({ error: 'Not found' }, { status: 404 });
      const items = db.prepare(`
        SELECT gi.*, rm.name AS material_name, rm.sku AS material_sku, rm.unit AS material_unit,
               rm.pack_size, rm.purchase_unit
        FROM goods_receipt_note_items gi
        JOIN raw_materials rm ON rm.id = gi.material_id
        WHERE gi.grn_id = ?
        ORDER BY rm.name
      `).all(id);
      return Response.json({ grn: { ...grn, items } });
    }
    const from = url.searchParams.get('from');
    const to   = url.searchParams.get('to');
    const vendorId = url.searchParams.get('vendor_id');
    const status   = url.searchParams.get('status');
    const where: string[] = ['1=1']; const params: any[] = [];
    const outletId = await getCurrentOutletId();
    if (outletId)  { where.push('(g.outlet_id = ? OR g.outlet_id IS NULL)'); params.push(outletId); }
    if (from)      { where.push('g.date >= ?'); params.push(from); }
    if (to)        { where.push('g.date <= ?'); params.push(to); }
    if (vendorId)  { where.push('g.vendor_id = ?'); params.push(vendorId); }
    if (status)    { where.push('g.status = ?'); params.push(status); }
    const rows = db.prepare(`
      SELECT g.*,
             po.po_number AS po_number,
             (SELECT COUNT(*)        FROM goods_receipt_note_items WHERE grn_id = g.id)                    AS line_count,
             (SELECT SUM(quantity_rejected) FROM goods_receipt_note_items WHERE grn_id = g.id)             AS total_rejected,
             (SELECT SUM(quantity_accepted * unit_price) FROM goods_receipt_note_items WHERE grn_id = g.id) AS accepted_value
      FROM goods_receipt_notes g
      LEFT JOIN purchase_orders po ON po.id = g.po_id
      WHERE ${where.join(' AND ')}
      ORDER BY g.date DESC, g.created_at DESC
    `).all(...params);
    return Response.json({ grns: rows });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await request.json();
    const { date, vendor_id, vendor, invoice_number, invoice_date, qc_by, notes, items,
            qc_quality, qc_temperature, qc_expiry, qc_damage, qc_weight, qc_invoice_match } = b;
    if (!date)  return Response.json({ error: 'date required' }, { status: 400 });
    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items array required' }, { status: 400 });
    }

    // Configurable backdate window: non-admins can't set a GRN receipt date older
    // than N days or in the future; admins are exempt.
    const dateCheck = checkPurchaseDate(db, date, me.role === 'admin');
    if (!dateCheck.ok) return Response.json({ error: dateCheck.error }, { status: 400 });
    const outletId = await getCurrentOutletId();

    // Phase B store guard (batch endpoint → skip + report per line, never fail
    // the whole GRN): store-mapped materials (liquor) can't be received into
    // Central stock — they're procured on the store ledger instead.
    const storeBlocked: { material_id: string; error: string }[] = [];
    const receivable = items.filter((it: any) => {
      const msg = centralFlowBlock(db, String(it.material_id || ''));
      if (msg) { storeBlocked.push({ material_id: it.material_id, error: msg }); return false; }
      return true;
    });
    if (receivable.length === 0) {
      return Response.json({
        error: `No receivable lines — ${storeBlocked.length} store-mapped line(s) blocked. ${storeBlocked[0]?.error || ''}`,
        store_blocked: storeBlocked,
      }, { status: 400 });
    }

    // Generate GRN number
    const yr = String(date).slice(0, 4);
    const lastGrn = db.prepare(`SELECT grn_number FROM goods_receipt_notes WHERE grn_number LIKE 'GRN-' || ? || '-%' ORDER BY grn_number DESC LIMIT 1`).get(yr) as any;
    const nextNum = lastGrn?.grn_number ? parseInt(lastGrn.grn_number.split('-').pop() || '0', 10) + 1 : 1;
    const grnNumber = `GRN-${yr}-${String(nextNum).padStart(4, '0')}`;
    const grnId = generateId();
    const touched = new Set<string>();

    const txn = db.transaction(() => {
      db.prepare(`
        INSERT INTO goods_receipt_notes
          (id, grn_number, date, po_id, vendor_id, vendor, invoice_number, invoice_date,
           received_by, qc_by, status, notes, outlet_id,
           qc_quality, qc_temperature, qc_expiry, qc_damage, qc_weight, qc_invoice_match,
           created_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(grnId, grnNumber, date, vendor_id || null, vendor || '', invoice_number || '', invoice_date || '',
              me.email, qc_by || '', notes || '', outletId,
              qc_quality ? 1 : 0, qc_temperature ? 1 : 0, qc_expiry ? 1 : 0,
              qc_damage ? 1 : 0, qc_weight ? 1 : 0, qc_invoice_match ? 1 : 0);

      const insGrnItem = db.prepare(`
        INSERT INTO goods_receipt_note_items
          (id, grn_id, po_item_id, material_id, quantity_ordered, quantity_received,
           quantity_accepted, quantity_rejected, rejection_reason, unit_price, notes)
        VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?)
      `);
      const insPurchase = db.prepare(`
        INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes,
                               is_emergency, payment_mode, emergency_reason, outlet_id, created_at)
        VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, 0, '', '', ?, datetime('now'))
      `);
      const bumpStock = db.prepare(`
        UPDATE raw_materials
        SET current_stock = current_stock + ?, last_purchase_price = ?, last_purchase_date = ?, updated_at = datetime('now')
        WHERE id = ?
      `);
      const insTx = db.prepare(`
        INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at, outlet_id)
        VALUES (?, ?, 'purchase', ?, ?, ?, datetime('now'), ?)
      `);
      const getPackInfo = db.prepare(`SELECT pack_size, unit, purchase_unit FROM raw_materials WHERE id = ?`);

      let hasReject = false;
      for (const it of receivable) {
        const received = Number(it.quantity_received) || 0;
        const accepted = it.quantity_accepted != null ? Number(it.quantity_accepted) : received;
        // Rejected qty only makes sense in the positive-receipt case
        // (received some, didn't accept some). For back-corrections we skip
        // the "rejected" math entirely — both numbers move in lockstep.
        const isNegative = received < 0 || accepted < 0;
        const rejected = isNegative ? 0 : Math.max(0, received - accepted);
        const reason   = String(it.rejection_reason || '').trim();
        const price    = Number(it.unit_price) || 0;
        // Skip ONLY truly empty lines. Allow negatives so back-corrections
        // actually save (this was silently dropping every adjustment).
        if (received === 0 && accepted === 0) continue;
        if (rejected > 0) hasReject = true;

        insGrnItem.run(generateId(), grnId, it.material_id, received, accepted, rejected, reason, price,
                       it.notes || (rejected > 0 ? `Rejected ${rejected} (${reason || 'no reason given'})` : ''));

        // Mirror into purchases + inventory_transactions for ANY non-zero
        // accepted qty (including negatives, which represent reversal of a
        // prior over-booking). updateMaterialPrice handles the weighted-avg
        // recomputation correctly on either sign.
        if (accepted !== 0) {
          const purchaseId = generateId();
          const lineTotal = Math.round(accepted * price * 100) / 100;
          const noteTag = accepted < 0
            ? `BACK-CORRECTION GRN ${grnNumber}${invoice_number ? ' · invoice ' + invoice_number : ''}`
            : `Ad-hoc GRN ${grnNumber}${invoice_number ? ' · invoice ' + invoice_number : ''}`;
          insPurchase.run(purchaseId, it.material_id, vendor || '', accepted, price, lineTotal, date,
                          noteTag, outletId);
          // ── Unit-basis boundary (CORE CONVENTION) ──────────────────────
          // GRN lines are entered in PURCHASE units at ₹/purchase-unit (same
          // basis as /api/purchases — also the only reading consistent with
          // accepted × unit_price = line value). The `purchases` row above
          // stays in purchase units (updateMaterialPrice ÷pack_size assumes
          // it), but current_stock + inventory_transactions live in RECIPE
          // units, so ×pack_size here under the SAME pack>1 + recipe≠purchase
          // unit condition updateMaterialPrice applies. Negatives (back-
          // corrections) convert identically. last_purchase_price stays
          // ₹/purchase-unit (canonical — db.ts backfill derives it from
          // purchases.unit_price).
          const mat = getPackInfo.get(it.material_id) as any;
          const packSize = Number(mat?.pack_size) || 1;
          const ru = String(mat?.unit || '').toLowerCase().trim();
          const pu = String(mat?.purchase_unit || mat?.unit || '').toLowerCase().trim();
          const stockQty = (packSize > 1 && ru !== pu) ? accepted * packSize : accepted;
          bumpStock.run(stockQty, price, date, it.material_id);
          insTx.run(generateId(), it.material_id, stockQty, purchaseId,
                    accepted < 0 ? `BACK-CORRECTION ${grnNumber}` : `Ad-hoc GRN ${grnNumber}`,
                    outletId);
          touched.add(it.material_id);
        }
      }
      if (hasReject) db.prepare(`UPDATE goods_receipt_notes SET status = 'partial' WHERE id = ?`).run(grnId);
    });
    txn();

    // Cascade weighted-avg + recipe re-cost
    for (const mid of touched) updateMaterialPrice(db, mid);

    const grn = db.prepare('SELECT * FROM goods_receipt_notes WHERE id = ?').get(grnId);
    return Response.json({ success: true, grn_id: grnId, grn_number: grnNumber, grn,
                           materials_touched: touched.size,
                           store_blocked: storeBlocked }, { status: 201 });
  } catch (e: any) {
    console.error('[grn POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
