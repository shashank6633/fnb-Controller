/**
 * Single source of truth for bill totals. Used by BOTH the settle route (to
 * store the authoritative total) and printBill (to render the same breakdown),
 * so the printed bill can never disagree with what was charged.
 *
 *   subtotal          = sum of item line totals
 *   serviceCharge     = subtotal × serviceChargePct% (0 if design off OR a
 *                       cashier removed it)
 *   discount          = subtotal × discount_pct%  (or a flat discount amount)
 *   taxable           = subtotal + serviceCharge − discount
 *   cgst / sgst       = taxable × cgstPct% / sgstPct%
 *   total             = taxable + cgst + sgst
 */
export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Per-item GST total from the order's lines. Each line's own tax_value% applies
 *  (Food & Beverages 5%, Liquor 0% — set on the menu item, snapshotted onto the
 *  order line at add time). This is the authoritative tax; the flat cgst/sgst
 *  design percentages are only a legacy fallback. */
export function sumItemTax(items: { line_total?: number; quantity?: number; unit_price?: number; tax_value?: number | null }[]): number {
  let t = 0;
  for (const it of items) {
    const line = it.line_total != null ? Number(it.line_total) : (Number(it.unit_price) || 0) * (Number(it.quantity) || 0);
    t += line * (Number(it.tax_value) || 0) / 100;
  }
  return round2(t);
}

export interface BillCalcDesign {
  serviceChargePct?: number;
  serviceChargeOn?: boolean;  // default true; charge only applies when pct > 0
  cgstPct?: number;
  sgstPct?: number;
}

export interface BillBreakdown {
  subtotal: number;
  serviceCharge: number;
  discount: number;
  cgst: number;
  sgst: number;
  total: number;
}

export function computeBill(
  o: { subtotal: number; itemTax?: number; serviceRemoved?: boolean; discount_pct?: number; discount?: number },
  d: BillCalcDesign,
): BillBreakdown {
  const subtotal = round2(o.subtotal);
  const scPct = Number(d.serviceChargePct) || 0;
  const serviceCharge = (d.serviceChargeOn !== false && !o.serviceRemoved && scPct > 0)
    ? round2(subtotal * scPct / 100) : 0;
  const rawDiscount = o.discount_pct
    ? round2(subtotal * (Number(o.discount_pct) || 0) / 100)
    : round2(o.discount || 0);
  // Clamp: a discount can never exceed the pre-tax base, so the total can't go
  // negative (guards against a bad/oversized discount amount).
  const discount = Math.min(Math.max(0, rawDiscount), round2(subtotal + serviceCharge));

  let cgst: number, sgst: number;
  if (o.itemTax != null) {
    // PER-ITEM GST (Food & Beverages 5%, Liquor 0%) — the item-level tax is the
    // source of truth. Split equally into CGST + SGST (India). This is what makes
    // the quoted running total equal the charged/printed total.
    const tax = round2(Math.max(0, o.itemTax));
    cgst = round2(tax / 2);
    sgst = round2(tax - cgst);   // remainder → sgst so cgst + sgst == tax exactly
  } else {
    // Legacy flat CGST/SGST on the taxable base (used only if no item tax given).
    const taxable = round2(subtotal + serviceCharge - discount);
    cgst = round2(taxable * (Number(d.cgstPct) || 0) / 100);
    sgst = round2(taxable * (Number(d.sgstPct) || 0) / 100);
  }
  const total = round2(subtotal + serviceCharge - discount + cgst + sgst);
  return { subtotal, serviceCharge, discount, cgst, sgst, total };
}
