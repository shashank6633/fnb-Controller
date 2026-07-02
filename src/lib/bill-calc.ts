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
  o: { subtotal: number; serviceRemoved?: boolean; discount_pct?: number; discount?: number },
  d: BillCalcDesign,
): BillBreakdown {
  const subtotal = round2(o.subtotal);
  const scPct = Number(d.serviceChargePct) || 0;
  const serviceCharge = (d.serviceChargeOn !== false && !o.serviceRemoved && scPct > 0)
    ? round2(subtotal * scPct / 100) : 0;
  const rawDiscount = o.discount_pct
    ? round2(subtotal * (Number(o.discount_pct) || 0) / 100)
    : round2(o.discount || 0);
  // Clamp: a discount can never exceed the pre-tax base, so the taxable/total
  // can't go negative (guards against a bad/oversized discount amount).
  const discount = Math.min(Math.max(0, rawDiscount), round2(subtotal + serviceCharge));
  const taxable = round2(subtotal + serviceCharge - discount);
  const cgst = round2(taxable * (Number(d.cgstPct) || 0) / 100);
  const sgst = round2(taxable * (Number(d.sgstPct) || 0) / 100);
  const total = round2(taxable + cgst + sgst);
  return { subtotal, serviceCharge, discount, cgst, sgst, total };
}
