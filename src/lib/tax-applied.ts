/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TAX ACTUALLY CHARGED — "Tax Value (GST)" and "Tax % Applied (GST)" on the
 * TRANSACTION reports, and on NO stock-balance surface.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE OWNER'S RULING (2026-09-19): "Ship B, and put tax columns only on
 * transaction reports."
 *
 * He first asked for Tax % Applied and Tax Value on all inventory reports, was
 * shown why a tax column beside a STOCK VALUATION asserts something false, and
 * accepted it. The reason is already written twice in this codebase and this
 * file does not invent a third wording:
 *
 *   src/app/inventory/page.tsx:1107 — the master Tax % is "a seed for purchase
 *     entry, NEVER a cost input — GST is a reclaimable credit and must never
 *     reach average_price."
 *   src/lib/issue-log.ts:199 — "charges NEVER enter any rate or value here —
 *     they are reclaimable and stay out of every value in this report."
 *
 * GST paid on a purchase is money the venue gets back. It is not part of what
 * stock is worth. So these two columns are only ever legitimate where a
 * TRANSACTION happened and real tax was charged:
 *
 *   /reports/purchases            Summary tab (per breakdown row) and
 *                                 Purchase-log tab (per document line)
 *   /reports/purchase-bill-summary  per bill, per day, per vendor-day
 *   /grn                          the Inward Register (per inward line)
 *
 * And NEVER on: stock-overview, closing-overview, closing-sheet,
 * closing-history, transfers, department-stock, central-cutover,
 * reconciliation, or the Raw Materials master's report columns.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHERE THE NUMBERS COME FROM — AND THE THREE THINGS THEY MUST NEVER COME FROM
 * ───────────────────────────────────────────────────────────────────────────
 * The figures are TAX ACTUALLY CHARGED, read off the transaction row:
 * `purchases.cgst + purchases.sgst`, or — on a PO-receipt cost mirror, which
 * deliberately carries no tax of its own — the paired `goods_receipt_note_items`
 * line's cgst + sgst. This module NEVER writes that rail itself: it composes
 * src/lib/purchase-charges.ts's effectiveChargeSql() so there is exactly one
 * definition of "which table did this bill's tax come from". Summing
 * `purchases.cgst` directly understates GST roughly FOUR-fold on this database
 * (₹562.50 on `purchases` against ₹2,178.90 on the GRN lines) and is the
 * regression purchase-charges.ts was written to end.
 *
 * FORBIDDEN OPERANDS, each for a measured reason:
 *   · raw_materials.tax_percent — a DATA-ENTRY SEED for the purchase form, not
 *     a record of what any vendor charged. 27 rows carry it and 23 of those are
 *     ZZ test rows; only four real items (Pasta (Penne), Tomatoes, Vodka, Sugar)
 *     have it set at all. A column derived from it would read 0.00% on 925 of
 *     952 items and would be a claim about configuration, not about money.
 *   · raw_materials.last_purchase_price — stored in MIXED BASES, up to 5,000×
 *     off on 105 rows. Never an operand anywhere. (See the Conversion Audit.)
 *   · purchases.total_price as the PERCENTAGE BASE — 217 of 2,165 rows carry
 *     tax INSIDE total_price with cgst = sgst = 0 (the old inward-import
 *     binding; SUM(total_price) 6,926,866.40 vs SUM(qty × unit_price)
 *     6,770,245.24, a ₹156,621.16 gap). Dividing tax by a tax-inclusive base
 *     produces a rate nobody charged. The base here is the effective SUBTOTAL
 *     from purchase-charges.ts, and those 217 rows carry no GST at all, so this
 *     module prints an em dash on them rather than a percentage.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * GST ONLY — NOT GST + COMPENSATION CESS. THE OWNER'S OPEN QUESTION, ANSWERED
 * BY MEASUREMENT RATHER THAN BY PREFERENCE.
 * ───────────────────────────────────────────────────────────────────────────
 * The question was whether "Tax Value" should be GST alone or GST + cess. It is
 * not a matter of taste: THE TWO LEVIES SIT ON DIFFERENT DENOMINATORS, so a
 * single percentage over the pair cannot exist. Measured on the live snapshot,
 * 2026-09-19, over every tax-bearing GRN line:
 *
 *   GST  → (cgst + sgst) ÷ (gross − discount) = 18.0000 / 12.0000 exactly on
 *          all 29 lines. Over GROSS it gives 16.2 / 16.8132 / 11.2 — garbage.
 *   CESS → compensation_cess ÷ GROSS = 12.0 / 7.5 / 5.0 exactly on all 16
 *          cess-bearing lines. Over the post-discount base: 13.3333 / 8.3333 /
 *          5.5556 — garbage.
 *
 * That is the owner's own ruling, confirmed in the data: 10 kg @ ₹100 less ₹100
 * → GST 18% on ₹900 = ₹162, CESS 12% on ₹1,000 = ₹120. A merged "tax" would
 * have to be divided by two different bases at once.
 *
 * So: this column is GST, the house invariant `tax_value = cgst + sgst` is
 * kept, both cesses stay in their own existing columns beside it, AND THE
 * HEADING SAYS "(GST)" so no reader has to guess which levies are inside it.
 * The cost of the choice, stated: on a row where compensation cess is non-zero
 * this understates total configured tax by 40% (12 of 30 points). Three REAL
 * items carry cess (Pasta (Penne), Vodka, Sugar — the other 16 of the 19 are ZZ
 * test rows), and every one of them already has its cess printed in the
 * Compensation Cess column on all four of these reports. Nothing is hidden;
 * it is beside this column, not inside it.
 *
 * IF THE OWNER WANTS A CESS PERCENTAGE it must be its own column on its own
 * base (cess ÷ gross, BEFORE discount) and must never be added to this one.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE BASE — AND WHY AN AGGREGATE USES A DIFFERENT ONE FROM A LINE
 * ───────────────────────────────────────────────────────────────────────────
 * PER LINE (purchase log, inward register): base = SUBTOTAL − DISCOUNT. Exact.
 * A line carrying ₹162 GST on ₹1,000 less ₹100 reads 18.00%, which is the rate
 * the vendor actually applied.
 *
 * PER AGGREGATE (a vendor, a month, a bill, a day): the base is the
 * post-discount subtotal OF THE LINES THAT CARRIED GST — `taxed_bill_value`,
 * summed in SQL beside the charges. Not the whole group's subtotal, and the
 * difference is the whole reason this field exists: 7 of 2,165 purchase rows
 * carry GST, so a blended rate over every line would print "0.01%" for an 18%
 * bill and read as a broken report. With the taxed base a vendor row reads
 * 18.00%, and `taxed_lines` lets the tooltip say "on 6 of 412 lines — the other
 * 406 recorded no GST", which is the honest sentence.
 *
 * A group mixing 18% and 12% lines reports a genuine BLEND of the two, over the
 * taxed lines only. taxAppliedNote() says how many lines that was, on every
 * surface, so a blend is never mistaken for a single vendor's rate.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NEVER 0.00%. AN EM DASH INSTEAD, AND THE DIFFERENCE IS A FILING ONE.
 * ───────────────────────────────────────────────────────────────────────────
 * A percentage cell is BLANK (CSV) / an em dash (screen) whenever no GST is
 * recorded on the row, and never "0.00%". "0%" is a positive claim that the
 * vendor charged no tax; a blank says this report has no tax to show. On the
 * 217 tax-inclusive import rows the truth is the third thing — tax was charged
 * and was never split out — and a 0.00% there would be a filing-grade lie.
 * This mirrors chargeCell()'s existing blank-is-not-zero rule in
 * purchase-charges.ts, and the Inward Register's own TAX DECISION column (28th)
 * is what separates "DECLARED EXEMPT" from "NOT RECORDED" beside it.
 *
 * The Tax Value column follows the same rule in the one case where the rupees
 * themselves are unavailable rather than zero: null on a PO line (an order has
 * no charge columns at all) and on a mirror row whose GRN line is gone.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ONE HELPER, SO FOUR SCREENS CANNOT DRIFT INTO FOUR ROUNDINGS. Every surface
 * calls gstValue() / taxAppliedPercent() / fmtTaxPercent() and its CSV calls
 * the same two functions through taxCsvNumber(), so the rendered row and the
 * downloaded line are the same arithmetic to the paisa and to the same 2
 * decimal places. Nothing here re-rounds a figure the server already rounded.
 *
 * CLIENT-SAFE. It imports only src/lib/purchase-charges.ts, which itself
 * imports nothing — no better-sqlite3, no next/* — so a page component and an
 * API route can both use it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import {
  effectiveBillValueSql,
  effectiveChargeSql,
  r2,
} from '@/lib/purchase-charges';

/* ───────────────────────────── THE WORDING ─────────────────────────────────
 * The screen labels use the owner's own phrase — "Tax % Applied" — with the
 * levy named in brackets. The CSV headings embed the dialect the transaction
 * reports ALREADY publish ("GST = CGST+SGST"), because a reader who downloads
 * /reports/purchase-bill-summary and /reports/purchases on the same afternoon
 * has to be able to line the columns up. "Tax Value (est.)" — the wording the
 * stock-rail module uses — is deliberately NOT reused: "(est.)" is true of a
 * notional figure computed from a master rate and FALSE of tax actually charged.
 * ───────────────────────────────────────────────────────────────────────────*/

/** Screen heading for the rupees. */
export const TAX_VALUE_LABEL = 'Tax Value (GST)';
/** Screen heading for the derived rate. The owner's phrase, levy named. */
export const TAX_PERCENT_LABEL = 'Tax % Applied (GST)';

/** Hover text for the rupee column. Says what is in it and what is not. */
export const TAX_VALUE_TITLE =
  'TAX ACTUALLY CHARGED on the bill: CGST + SGST and nothing else. Read off the bill document — on a '
  + 'PO receipt that is the GRN line, not the cost-mirror purchase row. NOT computed from the item '
  + "master's Tax %, which is only a data-entry seed. Compensation cess and special excise cess are "
  + 'DIFFERENT levies on a DIFFERENT base (cess is charged on the gross line value BEFORE discount, '
  + 'GST on the value AFTER it), so they keep their own columns and are never added in here. An em '
  + 'dash means the figure is unavailable (a PO line has no charge columns at all), never ₹0.';

/** Hover text for the percentage column. Says the denominator out loud. */
export const TAX_PERCENT_TITLE =
  'DERIVED FROM THE RUPEES ACTUALLY CHARGED, never read from the item master: (CGST + SGST) ÷ '
  + '(subtotal − discount) × 100, because GST is charged on the line value AFTER discount. On a '
  + 'grouped row the base is the post-discount subtotal of the lines that CARRIED GST — not the '
  + "whole group's — so a vendor billed at 18% reads 18.00% instead of a blended 0.01%; hover the "
  + 'cell for how many lines that was. A group mixing 18% and 12% lines reports a blend of the two. '
  + 'An em dash means NO GST IS RECORDED on this row — never 0.00%, which would claim the vendor '
  + 'charged none. Cesses are excluded: they sit on a different base and have their own columns.';

/**
 * CSV heading for the rupees. Carries "GST = CGST+SGST" verbatim, which is the
 * wording /reports/purchase-bill-summary already ships.
 */
export const TAX_VALUE_CSV_HEADER =
  'Tax Value INR (GST = CGST+SGST; tax actually charged on the bill; recorded only — never enters a '
  + 'rate or stock value; cesses and TCS excluded, they are separate levies with their own columns)';

/** CSV heading for the derived rate. Names the denominator and the blank rule. */
export const TAX_PERCENT_CSV_HEADER =
  'Tax % Applied (GST) (derived: (CGST+SGST) / (Subtotal - Discount) x 100; on a grouped row the '
  + 'base is only the lines that carried GST; BLANK = no GST recorded, never 0%)';

/**
 * A row this module can read. Every field optional because four different
 * surfaces pass four different row shapes at it — a breakdown aggregate, a bill
 * aggregate, a document line and an inward-register line.
 *
 * null is NOT 0 on any of these. A PO line's charge fields are null because
 * purchase_order_items has no such columns; a 0 there would assert a bill that
 * does not exist yet.
 */
export interface TaxAppliedRow {
  cgst?: number | null;
  sgst?: number | null;
  /**
   * The pair, where a surface already publishes it (purchase-bill-summary ships
   * `gst` on every row and every total). Accepted so a caller cannot hand this
   * module a row that HAS its GST under one name and get an em dash because the
   * module was only looking for the other two — which is exactly what happened
   * to the day rollup, whose client row type carries gst and not cgst/sgst.
   * It is the same figure: the lib computes it as r2(cgst + sgst) and the house
   * invariant is that nothing else joins that pair.
   */
  gst?: number | null;
  discount?: number | null;
  /** THE SUBTOTAL — goods as billed. `value` is accepted as its per-line alias. */
  bill_value?: number | null;
  value?: number | null;
  /** Per-line alias used by the Inward Register query. */
  subtotal?: number | null;
  /**
   * AGGREGATES ONLY: Σ(subtotal − discount) over the lines that carried GST.
   * Absent on a per-line row, where the line's own base is the right one.
   */
  taxed_bill_value?: number | null;
  /** AGGREGATES ONLY: how many lines carried GST. */
  taxed_lines?: number | null;
  /** Lines behind the row, for the "n of m" note. Already on both aggregates. */
  count?: number | null;
  lines?: number | null;
}

/** Number or null — never NaN, never a string that looks like a number. */
const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * TAX VALUE — the rupees. r2(cgst + sgst), the house invariant, nothing else.
 *
 * null when BOTH halves are null: that is "this row has no charge columns"
 * (a PO line), which must print blank rather than ₹0. One half null and the
 * other a figure is treated as the figure — a bill that recorded only CGST is
 * odd, but reporting half of it is better than reporting none of it.
 */
export function gstValue(row: TaxAppliedRow | null | undefined): number | null {
  const c = num(row?.cgst);
  const s = num(row?.sgst);
  if (c == null && s == null) return num(row?.gst) == null ? null : r2(num(row?.gst) as number);
  return r2((c || 0) + (s || 0));
}

/**
 * THE DENOMINATOR.
 *
 * Aggregates: `taxed_bill_value`, the post-discount subtotal of the GST-bearing
 * lines only (see the header). Per-line rows: this line's own subtotal less its
 * own discount, which IS the taxed base whenever the line carried GST — and
 * when it did not, taxAppliedPercent() returns null before the base is used.
 *
 * `bill_value` first, then `value`, then `subtotal` — the three names the four
 * surfaces give the same figure. Never total_price (tax-inclusive on 217 rows)
 * and never last_purchase_price (mixed bases).
 */
export function taxAppliedBase(row: TaxAppliedRow | null | undefined): number | null {
  const taxed = num(row?.taxed_bill_value);
  if (taxed != null) return r2(taxed);
  const gross = num(row?.bill_value) ?? num(row?.value) ?? num(row?.subtotal);
  if (gross == null) return null;
  return r2(gross - (num(row?.discount) || 0));
}

/**
 * TAX % APPLIED — derived from the rupees, to two decimals, or null.
 *
 * null (→ em dash on screen, blank in a CSV) in all three cases where a figure
 * would be a claim nobody can support:
 *   · no GST recorded on the row           — never print 0.00%
 *   · the base is zero or negative         — a rate over nothing is not a rate
 *   · the base is missing from the payload  — say nothing rather than guess
 */
export function taxAppliedPercent(row: TaxAppliedRow | null | undefined): number | null {
  const gst = gstValue(row);
  if (gst == null || gst <= 0) return null;
  const base = taxAppliedBase(row);
  if (base == null || base <= 0) return null;
  return r2((gst / base) * 100);
}

/**
 * THE screen formatter for the rate. Two decimals always, so a column of rates
 * reads as one column (18.00% · 12.00% · 5.00%) instead of 18% · 12% · 5%.
 * null is an em dash — "no GST recorded here" — and never "0.00%".
 */
export function fmtTaxPercent(p: number | null | undefined): string {
  if (p == null) return '—';
  const v = r2(Number(p) || 0);
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(2)}%`;
}

/**
 * A figure on its way into a CSV cell: the number itself, or '' for a blank.
 *
 * EMPTY STRING, not 0 and not '—': a blank cell is what a spreadsheet ignores
 * in an AVERAGE and what a reader reads as "nothing to show". An em dash in a
 * numeric column turns the whole column into text.
 */
export function taxCsvNumber(v: number | null | undefined): number | '' {
  return v == null ? '' : v;
}

/**
 * How many of the row's lines the percentage was computed over, as one clause
 * for a tooltip — or '' when the row is a single line and the question does not
 * arise. It is what keeps a BLENDED rate from reading as one vendor's rate.
 */
export function taxAppliedNote(row: TaxAppliedRow | null | undefined): string {
  const taxed = num(row?.taxed_lines);
  if (taxed == null) return '';
  const total = num(row?.count) ?? num(row?.lines);
  if (total == null || total <= 0) return '';
  const untaxed = Math.max(0, total - taxed);
  return ` Computed over ${taxed} of ${total} line${total === 1 ? '' : 's'}`
    + `${untaxed > 0 ? ` — the other ${untaxed} recorded no GST and are NOT in the base` : ''}.`
    + (taxed > 1 ? ' More than one line, so a mixed-rate group reports a blend.' : '');
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SQL — the two aggregate columns, built ONCE.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * `taxed_bill_value` and `taxed_lines` for an aggregate, given the caller's own
 * per-row GST and base expressions.
 *
 * Generic on purpose: /reports/purchases aggregates straight off `purchases`
 * with the GRN CTE joined, while purchase-bill-summary aggregates over its own
 * base CTE whose columns are already aliased, and its day views aggregate again
 * over a per-bill subquery. One shape could not serve all three; one FORMULA
 * can, and this is it.
 */
export function taxAppliedSumsSql(gstSql: string, baseSql: string): string {
  return `COALESCE(SUM(CASE WHEN (${gstSql}) > 0 THEN (${baseSql}) ELSE 0 END), 0) AS taxed_bill_value,\n        `
    + `COALESCE(SUM(CASE WHEN (${gstSql}) > 0 THEN 1 ELSE 0 END), 0) AS taxed_lines`;
}

/**
 * The same two columns rolled up one more level, for a view that aggregates an
 * aggregate (bill → day, bill → vendor-day). SUM of the parts, never recomputed
 * from the parent's own cgst/sgst — the inner query already decided which lines
 * were taxed and re-deciding it at the outer level would count a whole bill's
 * subtotal as taxed because one of its lines was.
 */
export function taxAppliedRollupSql(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(SUM(${a}taxed_bill_value), 0) AS taxed_bill_value,\n        `
    + `COALESCE(SUM(${a}taxed_lines), 0)      AS taxed_lines`;
}

/**
 * The two columns for an aggregate that reads the EFFECTIVE charge rail — the
 * GRN line for a PO-receipt mirror, the `purchases` column otherwise. Composed
 * from purchase-charges.ts's own fragments so there is one definition of that
 * rail in the codebase and a report cannot quietly go back to summing p.cgst.
 */
export function effectiveTaxAppliedSumsSql(pAlias = 'p', glAlias = 'gl'): string {
  const gst = `${effectiveChargeSql('cgst', pAlias, glAlias)} + ${effectiveChargeSql('sgst', pAlias, glAlias)}`;
  const base = `${effectiveBillValueSql(pAlias, glAlias)} - (${effectiveChargeSql('discount', pAlias, glAlias)})`;
  return taxAppliedSumsSql(gst, base);
}

/** Coerce the two aggregate fields off a DB row, so a page never sees a string. */
export function taxAppliedSums(row: Record<string, unknown> | null | undefined): {
  taxed_bill_value: number;
  taxed_lines: number;
} {
  return {
    taxed_bill_value: r2(Number(row?.taxed_bill_value) || 0),
    taxed_lines: Number(row?.taxed_lines) || 0,
  };
}
