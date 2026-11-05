/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE VALUE GST WAS CHARGED ON, per `purchases` row — the Tax % Applied (GST)
 * denominator for the Purchases register and the Purchase log (owner #5,
 * ruling 93).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS IS NOT effectiveBillValueSql(). That fragment
 * (src/lib/purchase-charges.ts) is the SUBTOTAL: on a PO-receipt cost mirror it
 * is the paired GRN line's quantity_RECEIVED × rate, which is what the GRN
 * Inward Register foots TOTAL INWARD from, and Grand Total must stay on it.
 * But every GST writer strikes the tax on the ACCEPTED quantity — PO receive
 * (`effAcc`, src/app/api/purchase-orders/[id]/receive/route.ts), POST /api/grn,
 * the QC sign-off (src/lib/grn-qc.ts), the bill amendment
 * (src/lib/grn-reversal.ts). On a delivery part-rejected at the door the two
 * differ: received 10 / accepted 8 @ ₹100 at 18% carries ₹144 of GST, and
 * ₹144 ÷ the received ₹1,000 printed 14.40% for a vendor who charged 18%.
 *
 * THE RULE IS THE REGISTER'S, restated here because it lives in a private
 * const (GST_GOODS_VALUE_SQL, src/app/api/grn/route.ts — "TAX % APPLIED IS
 * STRUCK ON THE ACCEPTED VALUE (owner's ruling, 2026-10-14)") of a route file,
 * which can export nothing but its handlers and belongs to another lane:
 *   · a line that DECIDED something (accepted > 0 or rejected > 0) and
 *     accepted LESS than it received → ROUND(accepted × rate, 2), exactly the
 *     register's figure;
 *   · every other line — nothing rejected, or a QC-held line that has decided
 *     nothing yet (accepted = 0 AND rejected = 0, whose tax was recorded on
 *     what arrived) → the subtotal, effectiveBillValueSql(), UNCHANGED. So on
 *     every row that rejected nothing — every row in the database today — the
 *     base is byte-for-byte the one Reports → Purchase Report (Summary) and the
 *     Purchase Bill Summary divide by.
 * The proof harness checks the result against GET /api/grn?register=1's own
 * Tax % for every GRN-linked row, so a drift between the two copies of the rule
 * is caught by a test rather than by a reader.
 *
 * FINDING THE GRN LINE WITHOUT A SECOND PAIRING. The grn_line CTE
 * (grnChargeCteSql) pairs a mirror row with its GRN line by rank and exposes the
 * line's money but not its quantities. Re-ranking here would be a second copy of
 * that pairing. Instead the line is found by WHAT THE CTE ALREADY COPIED OFF IT:
 * same GRN, same material, the same received × rate (gl.bill_value is that very
 * expression on that very row) and the same eight charge figures (null-safe
 * IS). The paired line is always among the matches by construction. Two lines
 * can only both match when they agree on received, rate, CGST, SGST, discount
 * and every other charge — and since GST is struck on accepted × rate −
 * discount, equal GST on equal rate and discount leaves their accepted values
 * within a rounding residue of each other; MIN() picks one deterministically.
 * 0 GRNs carry the same material twice today.
 *
 * WHAT IT DOES NOT CHANGE: Reports → Purchase Report (Summary), the Purchase
 * Bill Summary and the closing-stock default rate still divide by
 * effectiveBillValueSql() (src/lib/tax-applied.ts effectiveTaxAppliedSumsSql,
 * src/lib/purchase-bill-summary.ts, src/lib/closing-tax.ts) — shared helpers
 * outside this track, moved only on the owner's word. On a part-rejected PO
 * receipt their Tax % therefore reads LOWER than the register's and than the
 * two surfaces that use this file; every rupee figure still agrees. The notes
 * below say so on screen and in the files, only when such a line is present.
 */
import { effectiveBillValueSql, PURCHASE_CHARGE_COLUMNS } from '@/lib/purchase-charges';

/** SQL: the GRN line decided something AND accepted less than it received. */
function partAcceptedSql(gi: string): string {
  return `(NOT (COALESCE(${gi}.quantity_accepted, 0) = 0 AND COALESCE(${gi}.quantity_rejected, 0) = 0)`
    + ` AND COALESCE(${gi}.quantity_accepted, 0) <> COALESCE(${gi}.quantity_received, 0))`;
}

/** SQL: the GRN lines that carry exactly the figures the grn_line CTE copied. */
function pairedLineFilterSql(gx: string, pAlias: string, glAlias: string): string {
  const same = PURCHASE_CHARGE_COLUMNS.map(c => `${gx}.${c.key} IS ${glAlias}.${c.key}`).join(' AND ');
  return `${gx}.grn_id = ${pAlias}.grn_id AND ${gx}.material_id = ${pAlias}.material_id`
    + ` AND COALESCE(${gx}.quantity_received, 0) * COALESCE(${gx}.unit_price, 0) = ${glAlias}.bill_value`
    + ` AND ${same}`;
}

/**
 * SQL: the goods value GST was charged on, BEFORE discount (the caller
 * subtracts the effective discount, as the shared tax helper does). Needs the
 * grn_line CTE in scope (withGrnCharges) and its LEFT JOIN as `glAlias`.
 */
export function gstChargedValueSql(pAlias = 'p', glAlias = 'gl'): string {
  const gx = 'gx_gst';
  return `(CASE WHEN ${glAlias}.purchase_id IS NULL THEN ${effectiveBillValueSql(pAlias, glAlias)}`
    + ` ELSE COALESCE((SELECT MIN(CASE WHEN ${partAcceptedSql(gx)}`
    + ` THEN ROUND(${gx}.quantity_accepted * ${gx}.unit_price, 2)`
    + ` ELSE ${glAlias}.bill_value END)`
    + ` FROM goods_receipt_note_items ${gx}`
    + ` WHERE ${pairedLineFilterSql(gx, pAlias, glAlias)}), ${glAlias}.bill_value) END)`;
}

/**
 * SQL: 1 when this row's GST base is the ACCEPTED value and differs from its
 * subtotal (a delivery part-rejected at the door), else 0. Drives the notes.
 */
export function gstBaseAcceptedSql(pAlias = 'p', glAlias = 'gl'): string {
  const gx = 'gx_acc';
  return `(CASE WHEN ${glAlias}.purchase_id IS NOT NULL AND EXISTS (SELECT 1 FROM goods_receipt_note_items ${gx}`
    + ` WHERE ${pairedLineFilterSql(gx, pAlias, glAlias)} AND ${partAcceptedSql(gx)}) THEN 1 ELSE 0 END)`;
}

/**
 * Per-row hover clause: why this rate is not tax ÷ (subtotal − discount).
 * Figures, when the surface has them, are pre-formatted by the caller (₹
 * glyphs), so the wording is shared and the formatting stays the page's.
 */
export function acceptedBaseRowNote(acceptedValue?: string, receivedValue?: string): string {
  const acc = acceptedValue ? `${acceptedValue} ` : '';
  const rcv = receivedValue
    ? `the ${receivedValue} received, which stays the Subtotal and the base of Grand Total (Total Inward)`
    : 'the value received';
  return `THIS ROW: part of this delivery was rejected at the door, so the rate is struck on the ${acc}`
    + `ACCEPTED value (less discount) — the value GST was charged on, exactly as the GRN Inward Register strikes it — `
    + `and not on ${rcv}. `
    + 'Reports → Purchase Report (Summary) and the Purchase Bill Summary still divide this line by the received '
    + 'value, so their rate for it reads lower; the rupees agree.';
}

/**
 * Footer / totals clause, said only when n > 0: the one way this rate can
 * differ from the Summary's and the Bill Summary's for the same purchases.
 */
export function acceptedBaseTotalNote(n: number): string {
  if (!(n > 0)) return '';
  return `${n} line${n === 1 ? ' was' : 's were'} part-rejected at the door: ${n === 1 ? 'its' : 'their'} rate is `
    + 'struck on the ACCEPTED value, as the GRN Inward Register strikes it. Reports → Purchase Report (Summary) '
    + `and the Purchase Bill Summary still divide ${n === 1 ? 'that line' : 'those lines'} by the RECEIVED value, so `
    + 'their Tax % for the same purchases reads lower. Every rupee figure (CGST, SGST, Tax Value, Grand Total) is '
    + 'the same on all of them.';
}
