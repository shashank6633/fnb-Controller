import { getDb, generateId, updateMaterialPrice } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { centralFlowBlock, isStoreMappedMaterial } from '@/lib/store-engine';
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
 *       unit_price, notes?, gst_rate?
 *     }]
 *   }
 *
 *   gst_rate is a PERCENT (5 | 12 | 18 …), per line. When it is present the
 *   server DERIVES cgst/sgst from this route's own accepted value and IGNORES
 *   whatever cgst/sgst the client sent (they are read only to log a divergence),
 *   exactly as /api/purchases and the PO-receive path already do. When it is
 *   absent the hand-typed cgst/sgst are stored as-is — the pre-existing manual
 *   path, unchanged.
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
               rm.pack_size, rm.purchase_unit, rm.category AS material_category,
               ROUND(gi.quantity_received * gi.unit_price, 2) AS subtotal,
               ROUND(gi.quantity_received * gi.unit_price
                     - gi.discount + gi.cgst + gi.sgst + gi.special_excise_cess
                     + gi.tcs + gi.delivery_charges + gi.mrp_round_off, 2) AS total_inward_amount
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
    const register = url.searchParams.get('register');   // flat line-level inward register (export)
    const where: string[] = ['1=1']; const params: any[] = [];
    const outletId = await getCurrentOutletId();

    // Flat inward register — one row PER LINE, header fields repeated, in the
    // sheet's column order + our extras. Used by the "Download Inward Register"
    // export. Same filters as the list.
    if (register) {
      const rw: string[] = ['1=1']; const rp: any[] = [];
      if (outletId) { rw.push('(g.outlet_id = ? OR g.outlet_id IS NULL)'); rp.push(outletId); }
      if (from)     { rw.push('g.date >= ?'); rp.push(from); }
      if (to)       { rw.push('g.date <= ?'); rp.push(to); }
      if (vendorId) { rw.push('g.vendor_id = ?'); rp.push(vendorId); }
      if (status)   { rw.push('g.status = ?'); rp.push(status); }
      const rows = db.prepare(`
        SELECT g.grn_number, g.invoice_number, g.date AS inward_date, g.vendor AS supplier,
               rm.category AS category_name, rm.name AS item_name,
               gi.quantity_ordered AS po_qty, gi.quantity_received AS inward_qty,
               COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS purchase_unit,
               gi.unit_price AS rate,
               ROUND(gi.quantity_received * gi.unit_price, 2) AS subtotal,
               gi.discount, gi.cgst, gi.sgst, gi.special_excise_cess, gi.tcs,
               gi.delivery_charges, gi.mrp_round_off,
               ROUND(gi.quantity_received * gi.unit_price - gi.discount + gi.cgst + gi.sgst
                     + gi.special_excise_cess + gi.tcs + gi.delivery_charges + gi.mrp_round_off, 2) AS total_inward_amount,
               gi.quantity_accepted, gi.quantity_rejected, gi.rejection_reason,
               g.status, g.received_by, g.invoice_date
        FROM goods_receipt_note_items gi
        JOIN goods_receipt_notes g  ON g.id  = gi.grn_id
        JOIN raw_materials       rm ON rm.id = gi.material_id
        WHERE ${rw.join(' AND ')}
        ORDER BY g.date DESC, g.grn_number, rm.name
      `).all(...rp);
      return Response.json({ rows });
    }
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
             -- total_rejected sums the rejected qty of EVERY line, and GRN qtys are
             -- PURCHASE units — so a mixed GRN adds 2 kg to 3 BTL and the number is
             -- meaningless. These two say whether it can honestly be labelled: one
             -- distinct purchase unit across the rejected lines → print "N <unit>";
             -- more than one → the list prints the rejected LINE COUNT instead.
             (SELECT COUNT(DISTINCT LOWER(TRIM(COALESCE(NULLIF(TRIM(rm2.purchase_unit), ''), rm2.unit))))
                FROM goods_receipt_note_items gi2
                JOIN raw_materials rm2 ON rm2.id = gi2.material_id
               WHERE gi2.grn_id = g.id AND gi2.quantity_rejected > 0)                                     AS rejected_unit_count,
             (SELECT MIN(COALESCE(NULLIF(TRIM(rm2.purchase_unit), ''), rm2.unit))
                FROM goods_receipt_note_items gi2
                JOIN raw_materials rm2 ON rm2.id = gi2.material_id
               WHERE gi2.grn_id = g.id AND gi2.quantity_rejected > 0)                                     AS rejected_unit,
             (SELECT COUNT(*) FROM goods_receipt_note_items WHERE grn_id = g.id AND quantity_rejected > 0) AS rejected_lines,
             (SELECT SUM(quantity_accepted * unit_price) FROM goods_receipt_note_items WHERE grn_id = g.id) AS accepted_value,
             (SELECT SUM(quantity_received * unit_price
                         - discount + cgst + sgst + special_excise_cess + tcs + delivery_charges + mrp_round_off)
                FROM goods_receipt_note_items WHERE grn_id = g.id) AS inward_value
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

    // Per-line GST, as a PERCENT (5 | 12 | 18 …). Validated HERE, before the
    // transaction opens, because a Response cannot be returned from inside
    // db.transaction() — a bad rate has to be a clean 400 with no GRN number
    // burned and no row written. ABSENT means exactly what it meant before this
    // field existed: the clerk's hand-typed cgst/sgst are stored as-is, so every
    // older client (and the manual half of the /grn modal) keeps working. A
    // PRESENT but unusable value is REJECTED rather than quietly zeroed —
    // silently dropping the tax on a bill forfeits the input credit, and nothing
    // in the stored row would ever show that it went missing. Wording is
    // /api/purchases' wording verbatim; two purchase surfaces answering the same
    // mistake differently is how a clerk learns to distrust the message.
    const gstProvided = (it: any) =>
      it?.gst_rate !== undefined && it?.gst_rate !== null && String(it.gst_rate).trim() !== '';
    for (const it of receivable) {
      if (!gstProvided(it)) continue;
      const n = Number(it.gst_rate);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return Response.json({
          error: 'gst_rate must be a percentage between 0 and 100 (0 = exempt) — send no gst_rate at all to record a line with no tax',
        }, { status: 400 });
      }
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
           quantity_accepted, quantity_rejected, rejection_reason, unit_price, notes,
           discount, cgst, sgst, special_excise_cess, tcs, delivery_charges, mrp_round_off)
        VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // Per-line inward charges (₹). mrp_round_off is signed; the rest ≥ 0.
      const chg = (v: any) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; };
      const chgSigned = (v: any) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
      // grn_id is the HARD link from the cost row back to the delivery that
      // created it. Before it existed the only tie was the sentence in
      // `notes` below, which purchase-log.ts has to regex back out — a link
      // that breaks the moment anyone rewords a note. The column is additive
      // and soft (no FK: SQLite cannot ADD one, and rebuilding `purchases` on
      // a live system is not a trade worth making), so the two writers that
      // genuinely hold a GRN in scope — this route and PO-receive — bind it,
      // and the five that do not (direct purchase, opening stock, bulk,
      // inward-import, seed) correctly leave it NULL. Old rows stay NULL: no
      // backfill, and the note text below is unchanged so the regex path
      // keeps reading history exactly as it did.
      const insPurchase = db.prepare(`
        INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes,
                               is_emergency, payment_mode, emergency_reason, outlet_id, grn_id, created_at)
        VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, 0, '', '', ?, ?, datetime('now'))
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

        // ── PER-LINE GST — DERIVED HERE, server-side, from this route's own figures ──
        // This row is the input-credit record. The figure on it must follow from
        // the goods value on the SAME row, or a miscalculating modal — or a
        // replayed/hand-edited payload — writes a tax the row cannot justify to
        // an auditor. So when a rate is sent, the client's cgst/sgst are read
        // ONLY to log a divergence, never obeyed. Same contract as
        // /api/purchases and PO-receive; this was the one manual purchase
        // surface still trusting the browser's arithmetic.
        //
        // THE BASE IS THE ACCEPTED GROSS, NOT THE RECEIVED GROSS, and that is
        // deliberate: receive/route.ts taxes `effAcc` too, so the inward
        // register — which mixes rows from BOTH GRN sources — stays homogeneous.
        // A rejected quantity was never accepted, so no credit is claimable on
        // it. A back-correction (negative) floors to 0 here, which is what the
        // chg() below would have stored for it anyway — screen and row agree.
        //
        // ARITHMETIC IS api/purchases/route.ts:363-367 BYTE-FOR-BYTE. `taxable`
        // is already 2-dp rupees, so taxable × rate IS the tax in whole paise
        // (the ÷100 for percent and the ×100 for paise cancel). Halving in
        // integer paise is what keeps cgst + sgst re-adding to the tax EXACTLY —
        // the house invariant every reader re-adds; halving in floats drifts a
        // paisa. A third rounding convention across the purchase paths is how a
        // GST return stops reconciling.
        const hasGst = gstProvided(it);
        // LIQUOR IS ZERO-RATED — its duty rides on the TGBCL bill (excise / cess
        // / TCS), never on GST, so a credit here would be claimed twice.
        // centralFlowBlock already dropped these lines from `receivable`, so in
        // practice this never fires; it is the second lock, mirroring
        // receive/route.ts. If that guard is ever relaxed per-category, a client
        // sending 18% still must not write a credit the TGBCL charges carry.
        const gstRate = (!hasGst || isStoreMappedMaterial(db, String(it.material_id || '')))
          ? 0 : Number(it.gst_rate);
        const grossTax  = Math.round((accepted > 0 ? accepted : 0) * price * 100) / 100;
        const taxable   = Math.round((grossTax - chg(it.discount)) * 100) / 100;
        const taxPaise  = gstRate > 0 ? Math.max(0, Math.round(taxable * gstRate)) : 0;
        const sgstPaise = Math.floor(taxPaise / 2);
        const cgstPaise = taxPaise - sgstPaise;   // odd paisa lands in CGST, per the contract
        // Compared in INTEGER paise with a 1-paisa allowance: a client doing
        // round2(taxable × rate ÷ 100) legitimately lands a paisa off on
        // half-paisa amounts, and that is agreement, not drift. Anything wider
        // is a real UI divergence and must stay visible rather than be silently
        // corrected on every bill for months.
        if (hasGst && (it.cgst !== undefined || it.sgst !== undefined)) {
          const sentTax = (Number(it.cgst) || 0) + (Number(it.sgst) || 0);
          if (Math.abs(Math.round(sentTax * 100) - taxPaise) > 1) {
            console.warn(
              `[grn POST] client tax ₹${sentTax.toFixed(2)} ≠ server-derived ₹${(taxPaise / 100).toFixed(2)} ` +
              `(${grnNumber}, material ${it.material_id}, taxable ₹${taxable.toFixed(2)} @ ${gstRate}%) — stored the derived figure`
            );
          }
        }

        insGrnItem.run(generateId(), grnId, it.material_id, received, accepted, rejected, reason, price,
                       it.notes || (rejected > 0 ? `Rejected ${rejected} (${reason || 'no reason given'})` : ''),
                       chg(it.discount),
                       hasGst ? cgstPaise / 100 : chg(it.cgst),
                       hasGst ? sgstPaise / 100 : chg(it.sgst),
                       chg(it.special_excise_cess),
                       chg(it.tcs), chg(it.delivery_charges), chgSigned(it.mrp_round_off));

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
          // grnId is minted above and inserted in THIS same transaction, so the
          // link is never dangling — the GRN header row and its cost rows commit
          // or roll back together. A BACK-CORRECTION (negative accepted) is bound
          // to its own GRN too, deliberately: the reversal is a delivery event in
          // its own right and the log must show it against the GRN that recorded
          // it, not silently under the original receipt.
          insPurchase.run(purchaseId, it.material_id, vendor || '', accepted, price, lineTotal, date,
                          noteTag, outletId, grnId);
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
