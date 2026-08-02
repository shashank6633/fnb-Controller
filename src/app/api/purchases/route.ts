import { getDb, generateId, updateMaterialPrice } from '@/lib/db';
import { centralFlowBlock, isStoreMappedMaterial } from '@/lib/store-engine';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { checkPurchaseDate } from '@/lib/purchase-guard';

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const materialId = url.searchParams.get('material_id');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    // p.quantity is stored in PURCHASE units (kg, BTL) and p.unit_price per
    // purchase unit, so they ARE the natural display values. recipe_qty is the
    // recipe-unit equivalent (× pack_size when recipe_unit ≠ purchase_unit) for
    // the secondary "= 20,000 g" hint. total_price is the invoice amount.
    let query = `
      SELECT p.*, rm.name as material_name,
             rm.unit          AS material_unit,
             rm.purchase_unit AS material_purchase_unit,
             COALESCE(rm.pack_size, 1) AS material_pack_size,
             p.quantity   AS purchase_qty,
             p.unit_price AS purchase_unit_price,
             CASE WHEN COALESCE(rm.pack_size, 1) > 1
                       AND LOWER(rm.unit) <> LOWER(COALESCE(rm.purchase_unit, rm.unit))
                  THEN p.quantity * rm.pack_size
                  ELSE p.quantity
             END AS recipe_qty
      FROM purchases p
      JOIN raw_materials rm ON p.material_id = rm.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (materialId) {
      query += ' AND p.material_id = ?';
      params.push(materialId);
    }
    if (from) {
      query += ' AND p.date >= ?';
      params.push(from);
    }
    if (to) {
      query += ' AND p.date <= ?';
      params.push(to);
    }

    query += ' ORDER BY p.date DESC, p.created_at DESC';

    const purchases = db.prepare(query).all(...params);
    return Response.json({ purchases });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    // PRE-EXISTING GAP, closed here: this handler read the session ONLY to decide
    // the backdate exemption (`me?.role === 'admin'` below) and never rejected an
    // anonymous caller — while proxy.ts merely checks that a session cookie is
    // PRESENT, not that it is valid. So a forged cookie could POST a purchase:
    // stock bump, a purchases row, and updateMaterialPrice rewriting average_price
    // through every recipe. Mirrors the gate /api/grn already has.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const body = await request.json();
    const { material_id, vendor, brand, quantity, unit_price, date, notes,
            is_emergency, payment_mode, emergency_reason, bill_no,
            discount, delivery_charges, gst_rate } = body;
    // cgst/sgst ARE accepted on the wire (the bill modal computes them so it can
    // show the split before saving) and are then DISCARDED — see the derivation
    // below. Read here only to flag a client that disagrees with the server.
    const { cgst: cgstSent, sgst: sgstSent } = body;

    if (!material_id || !date) {
      return Response.json({ error: 'material_id and date are required' }, { status: 400 });
    }

    // Line sanity, NaN-safe — the same shape as /api/purchase-orders'
    // lineSanityError, minus its deliberate "a 0 rate is fine on a draft PO"
    // exception: a purchase writes STRAIGHT to stock and to updateMaterialPrice,
    // so the rate has to be real here, exactly as /api/purchase-orders/[id]/receive
    // demands on an accepted line.
    // The old `!quantity || !unit_price` test caught 0/blank/NaN but PASSED a
    // NEGATIVE number (`!(-900)` is false) and passed a non-numeric string
    // (`!'abc'` is false), which then stored total_price = NaN. A negative rate
    // reached updateMaterialPrice and gave the material a negative average_price.
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return Response.json({ error: 'quantity must be a number greater than 0 (in purchase units)' }, { status: 400 });
    }
    const px = Number(unit_price);
    if (!Number.isFinite(px) || px <= 0) {
      return Response.json({
        error: 'unit_price must be a number greater than 0 (₹ per purchase unit) — a zero or negative rate would rewrite this material\'s average price and every recipe cost built on it',
      }, { status: 400 });
    }

    // Per-line GST, as a PERCENT (5 | 12 | 18 …). ABSENT means exactly what it
    // meant before this field existed — no tax recorded, nothing else changed —
    // because the CSV importer (scripts/import-purchases.py) and any older client
    // still POST without it. A PRESENT but unusable value is rejected instead of
    // quietly zeroed: silently dropping the tax on a bill forfeits the input
    // credit, and nothing in the stored row would ever show that it went missing.
    const gstProvided = gst_rate !== undefined && gst_rate !== null && String(gst_rate).trim() !== '';
    const gstRateRaw = gstProvided ? Number(gst_rate) : 0;
    if (gstProvided && (!Number.isFinite(gstRateRaw) || gstRateRaw < 0 || gstRateRaw > 100)) {
      return Response.json({
        error: 'gst_rate must be a percentage between 0 and 100 (0 = exempt) — send no gst_rate at all to record a line with no tax',
      }, { status: 400 });
    }

    // Configurable backdate window: non-admins can't save a date older than N days
    // or in the future; admins are exempt. (`me` is resolved and null-checked at
    // the top of the handler.)
    const dateCheck = checkPurchaseDate(db, date, me.role === 'admin');
    if (!dateCheck.ok) return Response.json({ error: dateCheck.error }, { status: 400 });

    // Book the purchase against the outlet the user is currently viewing, the
    // way /api/grn does. An unstamped (NULL) row is rewritten to the DEFAULT
    // outlet by the startup migration in db.ts, so a purchase entered at a
    // non-default outlet would silently land in the default outlet's reports.
    const outletId = await getCurrentOutletId();

    const material = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(material_id) as any;
    if (!material) {
      return Response.json({ error: 'Material not found' }, { status: 404 });
    }

    // Phase B store guard: store-mapped materials (liquor) must NEVER enter
    // Central Store purchases — they live in the store ledger only
    // (/api/stores/[id]/procure). Historical rows are untouched.
    const storeBlock = centralFlowBlock(db, material_id);
    if (storeBlock) return Response.json({ error: storeBlock }, { status: 400 });

    // qty/px (the validated numbers) from here down, so a numeric STRING from the
    // wire is stored as a number and can never reach the arithmetic un-coerced.
    const total_price = Math.round(qty * px * 100) / 100;
    const id = generateId();

    // Store-mapped (liquor) lines are ZERO-RATED on this path: their duty rides
    // on the TGBCL bill charges (excise / cess / TCS), not on GST. centralFlowBlock
    // above already rejects them outright today, so this is the second lock —
    // if that guard is ever relaxed for a category, a client that sent 18% must
    // still not write an input-credit figure the TGBCL charges already carry.
    const gstRate = isStoreMappedMaterial(db, material_id) ? 0 : gstRateRaw;

    // RECORDED-ONLY discount, matching db.ts's contract: it never changes
    // unit_price/total_price, and readers compute
    //   Total Inward = total_price − discount + cgst + sgst + delivery …
    // So a caller must send `discount` ONLY when unit_price is still GROSS.
    // The bill form deliberately sends none: it nets the discount into
    // unit_price (the user's rule — a discount lowers what the goods cost),
    // so passing it here as well would subtract it twice.
    // Clamped to [0, total_price] because of that same subtraction: an
    // oversized discount (fat-fingered, or a hand-rolled API POST) would drag
    // Total Inward below zero. The bill form puts the same ceiling on its
    // bill-level discount (min(discount, subtotal)) before netting it into the
    // rate, so this is the server half of that rule. Hoisted out of the INSERT
    // because the tax below is computed on the POST-discount value and has to
    // use the SAME clamped rupees the row stores, or tax and Total Inward drift.
    const discountRecorded = Math.min(Math.max(0, Number(discount) || 0), total_price);

    // Tax is charged on the POST-DISCOUNT goods value, because that is what is
    // actually taxed. Both wire shapes land on the same base:
    //   • bill modal — discount already netted into unit_price, none sent, so
    //     total_price IS the post-discount value → taxable = total_price;
    //   • gross rate + `discount` — subtracted here.
    // Either way this is the contract's round2(line_total − discount_share).
    const taxable = Math.round((total_price - discountRecorded) * 100) / 100;
    // Whole-paise arithmetic on purpose. `taxable` is already a 2-dp rupee
    // amount, so taxable × rate IS the tax in paise (the ÷100 for percent and
    // the ×100 for paise cancel). Halving in paise keeps cgst + sgst re-adding
    // to the tax EXACTLY; halving in floats drifts a paisa and breaks the house
    // invariant tax_value = cgst + sgst that every reader re-adds. Doing the
    // percent in one step also avoids the float artifact in the naive
    // round2(taxable × rate ÷ 100): at ₹108351.75 @ 18% that writes 19503.31
    // where the true half-up value is 19503.32.
    const taxPaise  = gstRate > 0 ? Math.max(0, Math.round(taxable * gstRate)) : 0;
    const sgstPaise = Math.floor(taxPaise / 2);
    const cgstPaise = taxPaise - sgstPaise;   // odd paisa lands in CGST, per the contract
    const cgstAmt = cgstPaise / 100;
    const sgstAmt = sgstPaise / 100;

    // The client's own cgst/sgst are never stored. This row is the input-credit
    // record, so the figure on it must follow from the goods value on the SAME
    // row — a miscalculating client, or a replayed / hand-edited payload, must
    // not be able to write a tax that doesn't. Log a real divergence so a UI
    // drift stays visible instead of being silently corrected on every bill for
    // months. Compared in INTEGER paise with a 1-paisa allowance: the client's
    // round2(taxable × rate ÷ 100) legitimately lands a paisa off on half-paisa
    // amounts (see above), and that is agreement, not drift.
    if (cgstSent !== undefined || sgstSent !== undefined) {
      const sentTax = (Number(cgstSent) || 0) + (Number(sgstSent) || 0);
      if (Math.abs(Math.round(sentTax * 100) - taxPaise) > 1) {
        console.warn(
          `[purchases] client tax ₹${sentTax.toFixed(2)} ≠ server-derived ₹${(taxPaise / 100).toFixed(2)} ` +
          `(material ${material_id}, taxable ₹${taxable.toFixed(2)} @ ${gstRate}%) — stored the derived figure`
        );
      }
    }

    const insertPurchase = db.transaction(() => {
      // Create purchase record (with optional emergency / cash flags)
      // bill_no = the VENDOR's own bill number (from the "Enter Full Bill"
      // modal). invoice_id (OUR number) is minted per vendor bill: reuse the id
      // already assigned to this (vendor, bill_no, date) so every line of one
      // bill shares it; otherwise take the next free PINV-<year>-#### number.
      const billNo = String(bill_no || '').trim();
      let invoiceId = '';
      if (billNo) {
        const prior = db.prepare(`
          SELECT invoice_id FROM purchases
          WHERE COALESCE(invoice_id, '') <> ''
            AND LOWER(TRIM(COALESCE(vendor, ''))) = ?
            AND LOWER(TRIM(COALESCE(bill_no, ''))) = ?
            AND date = ?
          LIMIT 1
        `).get(String(vendor || '').toLowerCase().trim(), billNo.toLowerCase(), date) as any;
        if (prior?.invoice_id) invoiceId = prior.invoice_id;
      }
      if (!invoiceId) {
        const yr = new Date().getFullYear();
        const last = db.prepare(
          `SELECT MAX(CAST(substr(invoice_id, length('PINV-' || ? || '-') + 1) AS INTEGER)) AS n
           FROM purchases WHERE invoice_id LIKE 'PINV-' || ? || '-%'`
        ).get(String(yr), String(yr)) as any;
        invoiceId = `PINV-${yr}-${String((Number(last?.n) || 0) + 1).padStart(4, '0')}`;
      }
      // unit_price (px) and total_price stay the GOODS figures — tax is NEVER
      // folded into them, and no "simplification" may ever add it. average_price
      // is derived from these columns and feeds every recipe cost in the app, so
      // folding GST in inflates every recipe by the tax rate, silently and
      // forever; and the tax, once inside the rate, is no longer reclaimable as
      // input credit. It belongs in cgst/sgst, which are RECORDED-ONLY columns
      // readers add back: Total Inward = total_price − discount + cgst + sgst + …
      db.prepare(`
        INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes,
                               is_emergency, payment_mode, emergency_reason, invoice_id, bill_no, outlet_id,
                               discount, cgst, sgst, delivery_charges, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(id, material_id, vendor || '', brand || '', qty, px, total_price, date, notes || '',
              is_emergency ? 1 : 0, payment_mode || '', emergency_reason || '', invoiceId, billNo, outletId,
              discountRecorded,
              // Server-derived halves of the tax on the post-discount value, never
              // the client's own numbers. cgstAmt + sgstAmt === the tax exactly
              // (integer paise), holding the house invariant tax_value = cgst + sgst.
              // Both are 0 when no gst_rate was sent — an older client or the CSV
              // importer writes precisely the row it wrote before this field existed.
              cgstAmt, sgstAmt,
              Math.max(0, Number(delivery_charges) || 0));

      // Stock is kept in RECIPE units (sales deduction, closing-stock variance
      // × average_price). quantity is entered in PURCHASE units, so multiply by
      // pack_size when recipe_unit ≠ purchase_unit — mirroring updateMaterialPrice().
      const packSize = Number(material.pack_size) || 1;
      const ru = String(material.unit || '').toLowerCase().trim();
      const pu = String(material.purchase_unit || material.unit || '').toLowerCase().trim();
      const stockQty = (packSize > 1 && ru !== pu) ? qty * packSize : qty;

      // Update stock
      db.prepare(`
        UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?
      `).run(stockQty, material_id);

      // Create inventory transaction
      db.prepare(`
        INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at, outlet_id)
        VALUES (?, ?, 'purchase', ?, ?, ?, datetime('now'), ?)
      `).run(generateId(), material_id, stockQty, id, `Purchase from ${vendor || 'unknown'}`, outletId);

      // Update material price and cascade
      updateMaterialPrice(db, material_id);
    });

    insertPurchase();

    const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
    return Response.json({ purchase }, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
