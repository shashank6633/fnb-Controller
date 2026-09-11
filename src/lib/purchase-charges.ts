/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BILL CHARGES — one spec, shared by the report route, the screen and the
 * CSV, so a column, its heading and its total cannot drift apart.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The owner asked for four things on the purchase reports: TAXES, CESS,
 * TRANSPORTATION CHARGES and ROUND OFF. They map onto eight stored columns,
 * and the mapping is not one-to-one — that is the whole reason this file
 * exists rather than four inline SUMs:
 *
 *   TAXES     → cgst + sgst.              The house invariant is
 *               tax_value = cgst + sgst and NOTHING else joins it.
 *   CESS      → TWO SEPARATE LEVIES that must never be added into one column:
 *               special_excise_cess = TGBCL Special Excise Cess (non-creditable,
 *               rides on a liquor store bill) and compensation_cess = the GST
 *               (Compensation to States) cess on ordinary vendor bills.
 *               Different levy, different taxable base — GST is charged on the
 *               line value AFTER discount, compensation cess on the GROSS value
 *               BEFORE it. src/lib/purchase-log.ts states this at length; a
 *               return filed on a merged figure would be wrong. So: two columns,
 *               two headings, never a "Cess" total.
 *   TRANSPORT → delivery_charges.
 *   ROUND OFF → mrp_round_off. SIGNED. A −0.40 round-off is not +0.40, and this
 *               file carries `signed: true` on that column precisely so every
 *               renderer has to decide what to do with the minus instead of
 *               formatting it away. (Live data carries −0.50 on two GRN lines.)
 *
 * `tcs` and `discount` are carried alongside because the same eight columns are
 * written and read together everywhere else in the app, and a report that shows
 * six of the eight makes its own Total Amount unfootable.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * RECORDED-ONLY. ALL EIGHT.
 * ───────────────────────────────────────────────────────────────────────────
 * None of these columns moves a cost. updateMaterialPrice() averages only
 * SUM(qty × unit_price) / SUM(qty), so a charge changes stock valuation only if
 * it is inside `unit_price` — and none of these is. The one column with a twist
 * is `discount`, which IS netted into unit_price on SOME of the PO-receive path
 * and is therefore bound to a literal 0 there; see the mirror-row section below.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THERE IS NO ALLOCATION ON THIS RAIL — AND THAT IS A FINDING, NOT AN OMISSION
 * ───────────────────────────────────────────────────────────────────────────
 * Three charge rails exist in this app:
 *
 *   A. `purchases`                  — per LINE. All eight columns.
 *   B. `goods_receipt_note_items`   — per LINE. All eight columns.
 *   C. liquor store                 — 4 per line + 4 per BILL, and those four
 *                                     ARE allocated down to lines.
 *
 * This module serves A and B, where every charge is already stored per line, so
 * there is nothing to allocate and nothing to re-derive: the report SUMs the
 * stored column. Rail C's allocation is NOT re-implemented here and must never
 * be. It already exists, twice, and the two disagree:
 *
 *   • src/lib/store-engine.ts  getStoreInwardRegister() — allocates all four by
 *     LINE VALUE. This is the one that is DEPLOYED (f732956) and is the one the
 *     Inward Register on screen has been printing to the owner for months.
 *   • src/lib/liquor-recon.ts  allocateFromRows()      — allocates mrp_rounding
 *     by BOTTLES and the other three by line value.
 *
 * Both put the remainder on the last line, so PER-BILL totals are identical
 * either way and only PER-LINE figures differ. store-engine's is authoritative
 * here for one reason: it is the version already on the owner's screen, and
 * switching would silently move every historical line's round-off share. That
 * is the owner's call, not this file's. Nothing in this module reads or
 * reproduces either allocator.
 *
 * ⚠ WHAT THAT COSTS THE GRAND TOTAL, SAID OUT LOUD (2026-09-11). Because rail C
 * is not read, a TGBCL / liquor-store bill's four BILL-LEVEL charges — MRP
 * rounding, excise turnover tax, special excise cess and TCS, stored in
 * `store_bill_charges` — are not in this report's Grand Total. On such a bill
 * the Grand Total comes out EQUAL to the Subtotal with ₹0.00 in every charge
 * column, which is indistinguishable from a bill that genuinely carried no tax.
 * The largest row in the whole report is one of these: GOVERNMENT OF TELANGANA,
 * 2026-04-23, ₹12,91,438.90 booked = subtotal = grand total, 16 lines.
 *
 * NOTHING IS BEING DROPPED TODAY — `SELECT COUNT(*) FROM store_bill_charges`
 * is 0, so there is no recorded figure this report fails to pick up. But no
 * such figure can ever appear either, so "Grand Total = what we need to pay the
 * vendor" is a claim about the GST/vendor rail (A and B) and not about the
 * liquor rail. Both report pages carry that caveat in words. Wiring rail C in
 * would mean re-implementing or importing an allocator, which the paragraph
 * above forbids without the owner's decision.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE MIRROR ROW DOES NOT HOLD ITS OWN CHARGES — READ THEM OFF THE GRN LINE
 * ───────────────────────────────────────────────────────────────────────────
 * 2026-09-10, SECOND FINDING. A PO-receive `purchases` row is a deliberately
 * TAX-FREE COST MIRROR: the receive route binds `discount` to a literal 0 and
 * binds NO cgst/sgst/cess/tcs/round-off at all (tax there would poison
 * average_price and destroy the input credit). The charges live on the GRN
 * LINE, which is the bill document.
 *
 * The first pass of this module treated that as a PRESENTATION problem — print
 * an em dash instead of "₹0" — and left the money out of the report. That was
 * wrong, and measurably so. On the live copy the day of the fix:
 *
 *   · `purchases` mirror rows carried  ₹0 CGST, ₹0 SGST, ₹0 cess, ₹50 delivery.
 *   · Their 31 GRN lines carried    ₹2,178.90 CGST, ₹2,178.90 SGST,
 *     ₹1,675.40 comp. cess, ₹72 delivery, −₹1.00 round-off, ₹8 TCS,
 *     ₹2,280 discount.
 *
 * So the report understated August's tax roughly FOUR-fold, and the em dash it
 * relied on to say so only renders when EVERY row behind a figure is a mirror —
 * true for 3 of 42 vendors and 15 of 465 items, and for 0 of 4 months, 0 of 8
 * categories, 0 of 5 super-categories and 0 of 1 payment modes. On those four
 * breakdowns the reader got a confident, silent, wrong number.
 *
 * THE RULE NOW: a charge is read from the GRN line the mirror row was created
 * from, and from the purchases row otherwise. See effectiveChargeSql() and the
 * grn_line CTE below. Nothing is re-derived and nothing is allocated: the GRN
 * line already stores all eight charges per line, so the report reads the
 * stored column — just from the right table.
 *
 * `bill_value` — THE SUBTOTAL the reports print — moves with it. A mirror's
 * `total_price` is the BOOKED COST, and it is on a mixed basis: 17 of the 31
 * rows have the discount already netted into the rate (rate 90 against a bill
 * rate of 100) and 14 do not. Subtracting the GRN's discount from a booked cost
 * that already excludes it would double-count ₹1,620. So the GRAND TOTAL for a
 * mirror row is computed on the GRN's OWN basis — quantity_received × unit_price
 * − discount + charges — which is character for character the Total Inward the
 * GRN inward register prints (src/app/api/grn/route.ts, `inward_value`). That is
 * what makes the two screens agree on a bill instead of differing by ₹5,402.20
 * across 28 of 29.
 *
 * THE THREE NAMES, ONCE, SO NOTHING BELOW HAS TO GUESS (2026-09-11):
 *   bill_value    → printed as SUBTOTAL     — the goods/ingredients, as billed.
 *   total_amount  → printed as GRAND TOTAL  — what is payable to the vendor.
 *   total_price   → printed as SPEND / BOOKED COST — what stock valuation uses.
 * Field names did not change; only the words on the screen and in the files did.
 *
 * `spend` is NOT touched by any of this. It stays SUM(purchases.total_price) —
 * booked goods cost, the figure that feeds valuation — on every rail.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * BLANK IS NOT ZERO — NOW A MUCH NARROWER RULE
 * ───────────────────────────────────────────────────────────────────────────
 * With the charges read from the GRN, "₹0" on a mirror row is an honest zero
 * and must print as ₹0. ONE case still cannot be printed as a zero: a mirror
 * row whose GRN line is GONE (deleted by a repair, an unfinished void). There
 * the row says "my charges are recorded elsewhere" and elsewhere no longer
 * exists — so the report knows the figure is unavailable, not zero, and
 * chargeCell() blanks it. 0 such rows exist today; the rule is kept because the
 * failure is silent and a ₹0 tax cell is a filing-grade lie.
 *
 * The blank can never hide money: chargeCell() blanks a cell ONLY when the
 * stored sum for that column is exactly 0 as well. So Σ(cells, blank = 0) is
 * always the column total, and the footer always foots.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE BLANK IS NOT THE WARNING — AND ON A PARTIAL ORPHAN THERE IS NO BLANK
 * ───────────────────────────────────────────────────────────────────────────
 * 2026-09-11, THIRD FINDING, and the one that matters most now that a SUBTOTAL
 * and a GRAND TOTAL are printed side by side.
 *
 * A figure whose GRN line is gone is not merely "unavailable" — it is SHORT.
 * The Subtotal falls back to the booked cost and every charge that lived on the
 * missing GRN line is simply absent, so the GRAND TOTAL a reader is told is
 * "what we need to pay the vendor" comes out UNDERSTATED. Measured by deleting
 * the GRN lines of bill QA-PO-CESS-2 on a throwaway copy: grand total 1,182 →
 * 900, short by ₹282, i.e. 23.9% of the bill.
 *
 * Worse, on a MIXED row the blank never appears at all. isChargeSourceMissingRow
 * is an ALL predicate (rightly — blanking a mixed group would hide the charges
 * of the lines that DO have a source), so a 2-line GRN that loses ONE line
 * renders eight ordinary-looking numbers, a short Grand Total, AND still foots
 * left to right: 2,000 − 100 + 162 = 2,062 against a true 2,244. The reader's
 * own cross-check then CONFIRMS a wrong number. That is the worst failure shape
 * a report can have, and no blank cell can express it.
 *
 * SO THE BLANK RULE IS KEPT AND A SECOND, WIDER RULE SITS BESIDE IT:
 *   isChargeSourceMissingRow()  ALL — decides whether a CELL goes blank.
 *   hasUnpairedMirrorRows()     ANY — decides whether the ROW IS WARNED ABOUT.
 * Every renderer of a Subtotal or a Grand Total must call the ANY one. A number
 * that may be short has to say so beside itself; it is not enough for a caption
 * at the foot of the page or a note column in the CSV to mention it.
 *
 * WHAT IS NOT CLAIMED: the shortfall cannot be quantified. The missing GRN line
 * is missing — its charges are unknowable from here, so no renderer may print a
 * "true" total or a delta. The honest statement is the direction (understated)
 * and the count (N of M lines), and that is what unpairedMirrorNote() gives.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * CLIENT-SAFE. This file imports nothing — no better-sqlite3, no next/* — so
 * the page component and the API route can both use it and the CSV a browser
 * writes is built from the identical column list the server sums.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** ₹ rounded to paise. Local copy of po-charges' r2 so this file stays import-free. */
export const r2 = (v: number): number => Math.round((Number(v) || 0) * 100) / 100;

export type PurchaseChargeKey =
  | 'cgst'
  | 'sgst'
  | 'compensation_cess'
  | 'special_excise_cess'
  | 'delivery_charges'
  | 'mrp_round_off'
  | 'tcs'
  | 'discount';

export interface PurchaseChargeColumn {
  key: PurchaseChargeKey;
  /** Short heading for a screen table. */
  label: string;
  /** The owner's word for it, used in the panel caption and tooltips. */
  group: 'Taxes' | 'Cess' | 'Transport' | 'Round off' | 'Other';
  /** Hover text — says what the levy IS, because two of them read alike. */
  title: string;
  /**
   * CSV heading. IDENTICAL TEXT to the heading the same figure carries in
   * src/app/api/reports/purchase-log/route.ts, so a reader who downloads both
   * reports can line the columns up. scripts/purchase-charges-tests.js asserts
   * the two lists still match — reword one and the test names the other.
   */
  csvHeader: string;
  /** May legitimately be negative and MUST render its sign. */
  signed: boolean;
}

/**
 * THE column order, used by the screen table, every CSV and the totals row.
 * Owner's four first (taxes, cess, transport, round off), then the two that
 * ride along so Total Amount foots.
 */
export const PURCHASE_CHARGE_COLUMNS: readonly PurchaseChargeColumn[] = [
  {
    key: 'cgst', label: 'CGST', group: 'Taxes',
    title: 'Central GST recorded on the bill. tax = cgst + sgst; nothing else joins that pair.',
    csvHeader: 'CGST INR (recorded only)', signed: false,
  },
  {
    key: 'sgst', label: 'SGST', group: 'Taxes',
    title: 'State GST recorded on the bill. tax = cgst + sgst; nothing else joins that pair.',
    csvHeader: 'SGST INR (recorded only)', signed: false,
  },
  {
    key: 'compensation_cess', label: 'Comp. Cess', group: 'Cess',
    title: 'GST Compensation Cess (aerated drinks, tobacco). A DIFFERENT levy from Spl. Excise Cess, '
      + 'on a different base — charged on the GROSS line value, before discount. Never add it into GST.',
    csvHeader: 'Compensation Cess INR (GST comp. cess, recorded only)', signed: false,
  },
  {
    key: 'special_excise_cess', label: 'Spl. Excise Cess', group: 'Cess',
    title: 'TGBCL Special Excise Cess — the liquor levy. Non-creditable. Never folded into GST.',
    csvHeader: 'Special Excise Cess INR (recorded only)', signed: false,
  },
  {
    key: 'delivery_charges', label: 'Delivery / Transport', group: 'Transport',
    title: 'Transportation / delivery recorded on the bill. Recorded only — it never enters a rate '
      + 'or the weighted-average cost.',
    csvHeader: 'Delivery Charges INR (recorded only)', signed: false,
  },
  {
    key: 'mrp_round_off', label: 'MRP Round-off', group: 'Round off',
    title: 'Signed. A bill rounded DOWN carries a negative figure and it is shown negative here.',
    csvHeader: 'MRP Round Off INR (recorded only)', signed: true,
  },
  {
    key: 'tcs', label: 'TCS', group: 'Other',
    title: 'Tax Collected at Source, as recorded on the bill.',
    csvHeader: 'TCS INR (recorded only)', signed: false,
  },
  {
    key: 'discount', label: 'Discount', group: 'Other',
    title: 'Recorded-only discount. 0 on a PO-receipt row does NOT mean "no discount": there the '
      + 'discount is already inside the rate and is itemised on the GRN line.',
    csvHeader: 'Discount INR (recorded only)', signed: false,
  },
] as const;

/**
 * THE GRAND TOTAL — subtotal − discount + every charge. What is payable to the
 * vendor, NOT the booked goods cost: the two differ on a PO-receipt row and the
 * heading has to say which one the column carries, because a reader reconciling
 * against a vendor statement needs the amount payable and a reader reconciling
 * against the ledger needs Spend.
 *
 * 2026-09-11: renamed from "Total Amount" to GRAND TOTAL, the owner's own word
 * for it ("what we actually need to pay the vendor"). Same arithmetic, same
 * column position, same `total_amount` field on the wire — only the heading
 * changed. The heading text is asserted BY REFERENCE in
 * scripts/purchase-charges-tests.js §6 (it checks WHERE this constant sits in
 * the header, not what it says), so the wording is free to be plain English;
 * the eight charge csvHeaders above are NOT, because §8 greps them verbatim out
 * of the held /api/reports/purchase-log route.
 */
export const TOTAL_AMOUNT_CSV_HEADER =
  'Grand Total INR (subtotal - discount + CGST + SGST + cesses + TCS + delivery + round-off)';

/**
 * THE SUBTOTAL — the goods/ingredients value as the BILL charges for it,
 * exported as its own CSV column so the Grand Total is footable by hand. Equal
 * to Spend on every ordinary purchase row; on a PO-receipt row it is the GRN
 * line's gross (quantity_received × unit_price) while Spend is the booked cost,
 * which may already be net of the discount. Subtotal − Spend is therefore
 * exactly the discount that was netted into the booked rate.
 *
 * 2026-09-11: renamed from "Bill Value". It is the figure the owner asked to
 * see — "the ingredients cost … the actual price and total value of the goods
 * we're buying" — and naming it Subtotal is what makes the sentence
 * Subtotal + charges = Grand Total readable by someone who has never heard of a
 * cost mirror. The `bill_value` field name is UNCHANGED on the wire.
 */
export const BILL_VALUE_CSV_HEADER =
  'Subtotal INR (goods/ingredients value as billed; = Spend except on PO receipts)';

/**
 * Where a group's charges were read from. Written into the CSV's own note
 * column so the file says it without the screen.
 */
export const GRN_SOURCED_NOTE =
  'includes PO receipts — their charges and bill value are read from the GRN line (the bill '
  + 'document), which is also what the GRN inward register totals as Total Inward';
/**
 * EVERY line behind this figure is a mirror row whose GRN line is gone. The
 * charges are UNAVAILABLE, not zero, so the cells are blank rather than ₹0 —
 * and the Subtotal and Grand Total, which do NOT blank, are short by whatever
 * that missing bill document held.
 *
 * The old wording stopped at "the cells are blank". That was the whole of the
 * disclosure, and it described the symptom rather than the consequence: a
 * reader was told a cell was empty and left to work out for themselves that the
 * payable figure beside it was wrong.
 */
export const CHARGE_SOURCE_MISSING_NOTE =
  'PO receipt with no GRN line left to read charges from — the charge cells are BLANK because the '
  + 'figure is unavailable, not because it is zero, and the SUBTOTAL and GRAND TOTAL fall back to '
  + 'the booked cost and are therefore UNDERSTATED by whatever the missing bill document charged';

/**
 * SOME but not all of the lines behind this figure lost their GRN line.
 *
 * A separate sentence because the ALL note's central claim — "the cells are
 * blank" — is FALSE here: chargeCell() deliberately does not blank a mixed
 * group, so every cell prints an ordinary number, the row foots, and nothing on
 * it looks wrong. This is the note that has to carry the warning on its own.
 */
export const CHARGE_SOURCE_PARTIAL_NOTE =
  'some of these lines are PO receipts with no GRN line left to read charges from — their charges '
  + 'are MISSING rather than zero, so the cells still print ordinary numbers and the row still adds '
  + 'up, but the GRAND TOTAL is UNDERSTATED by whatever those missing bill documents charged';
export const CHARGE_NOTE_CSV_HEADER = 'Charge Basis Note';

/**
 * The eight sums plus the SUBTOTAL (`bill_value`) and the GRAND TOTAL
 * (`total_amount`) derived from it, as the report returns them. bill_value is
 * here and not just on the row type because the Grand Total is unfootable
 * without it — it is the first term of Subtotal − Discount + charges.
 */
export type PurchaseChargeSums =
  Record<PurchaseChargeKey, number> & { bill_value: number; total_amount: number };

/**
 * A row of any breakdown: its own charge sums, plus the counts the disclosure
 * rules need.
 *
 *   count               rows in the group
 *   po_receipt_rows     how many are PO-receipt cost mirrors
 *   grn_sourced_rows    how many took their charges from a GRN line — the
 *                       number the "charges from GRN" badge reports. It is NOT
 *                       "all of them or nothing": a month with 44 rows of which
 *                       31 are PO receipts must still disclose, and the
 *                       all-or-nothing predicate this replaced disclosed on 0
 *                       of 4 months while quietly understating their tax.
 *   unpaired_mirror_rows  mirrors whose GRN line is missing. Non-zero is a
 *                       defect; see CHARGE_SOURCE_MISSING_NOTE.
 *   bill_value          THE SUBTOTAL — the goods/ingredients value as billed
 *                       (see BILL_VALUE_CSV_HEADER)
 */
export interface PurchaseChargeRow extends Partial<PurchaseChargeSums> {
  count?: number;
  po_receipt_rows?: number;
  grn_sourced_rows?: number;
  unpaired_mirror_rows?: number;
  bill_value?: number;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE GRN CHARGE RAIL — one CTE, one join, one set of expressions.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** The eight charge columns as they are named on BOTH tables. */
const CHARGE_KEYS = PURCHASE_CHARGE_COLUMNS.map(c => c.key);

/**
 * SQL: the CTE body that pairs each PO-receipt `purchases` row with the GRN
 * line it was created from, and carries that line's bill value and eight
 * charges. Prefix it with WITH via withGrnCharges().
 *
 * THE KEY IS (grn_id, material_id). That is not a choice made here — it is the
 * app's own convention, stated at src/lib/grn-reversal.ts:198 ("`purchases` has
 * NO grn_item_id, so (grn_id, material_id) is the only per-line key from a cost
 * row back to a GRN line") and already used by getLastPurchaseRate() in that
 * same file. ONE MATERIAL = ONE LINE is enforced on every writer by
 * src/lib/line-dedupe.ts, so the key is unique on both sides.
 *
 * THE ROW_NUMBER IS DELIBERATE BELT-AND-BRACES. A plain join on that key would
 * FAN OUT if the uniqueness invariant were ever broken by a repair script or a
 * restore — and a fan-out here would silently MULTIPLY SUM(p.total_price), i.e.
 * inflate the report's spend. Ranking both sides and joining on the rank makes
 * the pairing strictly 1:1: `purchase_id` is unique in this CTE, so the LEFT
 * JOIN onto it cannot add a row to any aggregate, whatever the data does.
 *
 * ⚠ AND HERE IS WHAT IS **NOT** COVERED, STATED PLAINLY BECAUSE THIS COMMENT
 * USED TO CLAIM THE OPPOSITE. Until 2026-09-11 it ended "a surplus GRN line on
 * a broken key simply goes unpaired, and unpairedGrnLines() counts it rather
 * than letting it vanish." THERE IS NO SUCH FUNCTION — it has never existed
 * anywhere in this codebase (`grep -rn "unpairedGrnLines" src/` returned only
 * that sentence), and the safety net a reader would have relied on was
 * fictional. The two directions are NOT symmetric:
 *
 *   mirror row with no GRN line  → COUNTED. unpaired_mirror_rows, on every
 *     breakdown row, surfaced by hasUnpairedMirrorRows() and blanked by
 *     isChargeSourceMissingRow(). 0 today.
 *   GRN line with no mirror row  → NOT COUNTED ANYWHERE, and it cannot be: this
 *     report is driven by `purchases`, so a GRN line with nothing to pair
 *     against is never selected and contributes no row to count. Its money is
 *     absent from the report while the GRN inward register still prints it.
 *
 * That second case is reachable — a fully-rejected line (accepted = 0) or a
 * QC-held delivery writes the GRN line but NO `purchases` row (see
 * src/app/api/purchase-orders/[id]/receive/route.ts, `if (!qc.required &&
 * accepted > 0)`) — and it is why the register-equality claim on both screens is
 * written as data-conditional rather than as a guarantee. 0 such lines today: 31
 * GRN lines, 0 with quantity_rejected > 0, 0 with quantity_accepted = 0, 0 GRNs
 * awaiting QC. Closing it would mean driving this report off the GRN side as
 * well, which is a different report and a different lane's file.
 *
 * VOIDED GRNs are not filtered out, on purpose: voiding a GRN DELETEs its
 * `purchases` rows (src/lib/grn-reversal.ts:633), so a voided bill has no
 * mirror row to pair and never reaches this CTE. Filtering on voided_at as well
 * would be dead weight that could only ever create a spend/charge asymmetry —
 * a row counted for its spend but denied its charges.
 */
export function grnChargeCteSql(): string {
  const cols = CHARGE_KEYS.join(', ');
  return `grn_line AS (
      SELECT pm.purchase_id                              AS purchase_id,
             COALESCE(gm.quantity_received, 0) * COALESCE(gm.unit_price, 0) AS bill_value,
             ${CHARGE_KEYS.map(k => `gm.${k}`).join(', ')}
        FROM (
          SELECT id AS purchase_id, grn_id, material_id,
                 ROW_NUMBER() OVER (PARTITION BY grn_id, material_id
                                    ORDER BY created_at, id) AS rn
            FROM purchases
           WHERE TRIM(COALESCE(invoice_id, '')) = ''
             AND TRIM(COALESCE(grn_id, '')) <> ''
        ) pm
        JOIN (
          SELECT grn_id, material_id, quantity_received, unit_price, ${cols},
                 ROW_NUMBER() OVER (PARTITION BY grn_id, material_id
                                    ORDER BY created_at, id) AS rn
            FROM goods_receipt_note_items
        ) gm
          ON gm.grn_id = pm.grn_id
         AND gm.material_id = pm.material_id
         AND gm.rn = pm.rn
    )`;
}

/** Prefix a statement with the grn_line CTE. */
export function withGrnCharges(sql: string): string {
  return `WITH ${grnChargeCteSql()}\n${sql}`;
}

/**
 * SQL: the LEFT JOIN that hangs the paired GRN line off a `purchases` row.
 * Cannot fan out — see grnChargeCteSql().
 */
export function grnLineJoinSql(pAlias = 'p', glAlias = 'gl'): string {
  return `LEFT JOIN grn_line ${glAlias} ON ${glAlias}.purchase_id = ${pAlias}.id`;
}

/** SQL: 1 when this row's charges come from a GRN line, else 0. */
export function grnSourcedSql(glAlias = 'gl'): string {
  return `CASE WHEN ${glAlias}.purchase_id IS NOT NULL THEN 1 ELSE 0 END`;
}

/**
 * SQL: ONE charge, read from wherever it is actually recorded.
 *
 * The GRN line when this row is a PO-receipt mirror that still has one, the
 * `purchases` column otherwise. Never both, never a sum of the two — the mirror
 * row's own columns are the receive route's placeholder zeros (plus, on two
 * bills out of 29, a partial ₹25 delivery share), and adding them to the GRN's
 * figure would double-count that ₹50.
 */
export function effectiveChargeSql(key: PurchaseChargeKey, pAlias = 'p', glAlias = 'gl'): string {
  return `CASE WHEN ${glAlias}.purchase_id IS NULL`
    + ` THEN COALESCE(${pAlias}.${key}, 0)`
    + ` ELSE COALESCE(${glAlias}.${key}, 0) END`;
}

/**
 * SQL: the goods value on the BILL's basis.
 *
 * `purchases.total_price` for an ordinary row — identical to Spend, so nothing
 * a reader already knows changes. The GRN line's quantity_received × unit_price
 * for a mirror, because that is the vendor's gross line value and it is the
 * basis the GRN's own discount was struck against. Using Spend there instead
 * would double-subtract the ₹1,620 of discount that is already inside the
 * booked rate on 17 of the 31 mirror rows.
 *
 * quantity_RECEIVED, not accepted: that is what src/app/api/grn/route.ts's
 * `inward_value` uses, and matching it exactly is the point. (They are equal on
 * every row in the database today — 0 lines have received <> accepted.)
 */
export function effectiveBillValueSql(pAlias = 'p', glAlias = 'gl'): string {
  return `CASE WHEN ${glAlias}.purchase_id IS NULL`
    + ` THEN COALESCE(${pAlias}.total_price, 0)`
    + ` ELSE COALESCE(${glAlias}.bill_value, 0) END`;
}

/**
 * SQL: one line's bill amount, from the effective rail.
 *
 * On an ordinary `purchases` row this is character for character
 * purchaseLineTotalSql() — the pre-existing figure, unchanged. On a PO-receipt
 * row it is the GRN line's Total Inward, which is what makes a bill total the
 * same number on this report and on the GRN inward register.
 */
export function effectiveLineTotalSql(pAlias = 'p', glAlias = 'gl'): string {
  const chg = (k: PurchaseChargeKey) => effectiveChargeSql(k, pAlias, glAlias);
  return `${effectiveBillValueSql(pAlias, glAlias)} - (${chg('discount')})`
    + ` + (${chg('cgst')}) + (${chg('sgst')})`
    + ` + (${chg('compensation_cess')}) + (${chg('special_excise_cess')})`
    + ` + (${chg('tcs')}) + (${chg('delivery_charges')})`
    + ` + (${chg('mrp_round_off')})`;
}

/**
 * SQL: the eight SUMs + bill value + the bill amount, from the effective rail,
 * aliased to the keys above.
 *
 * The bill-amount expression is SUM(<the per-line expression>) — NOT a
 * combination of the eight column sums — because that is what
 * src/lib/purchase-bill-summary.ts and src/lib/purchase-log.ts already do, and
 * the reports have to agree to the paisa.
 */
export function effectiveChargeSumsSql(pAlias = 'p', glAlias = 'gl'): string {
  const sums = PURCHASE_CHARGE_COLUMNS
    .map(c => `COALESCE(SUM(${effectiveChargeSql(c.key, pAlias, glAlias)}), 0) AS ${c.key}`)
    .join(',\n        ');
  return `${sums},\n        `
    + `COALESCE(SUM(${effectiveBillValueSql(pAlias, glAlias)}), 0) AS bill_value,\n        `
    + `COALESCE(SUM(${effectiveLineTotalSql(pAlias, glAlias)}), 0) AS total_amount`;
}

/**
 * SQL: the three counts every breakdown row carries so the screen and the CSV
 * can disclose where a figure came from without a second query.
 */
export function chargeSourceCountsSql(pAlias = 'p', glAlias = 'gl'): string {
  const mirror = poReceiptMirrorSql(pAlias);
  return `COALESCE(SUM(${mirror}), 0) AS po_receipt_rows,\n        `
    + `COALESCE(SUM(${grnSourcedSql(glAlias)}), 0) AS grn_sourced_rows,\n        `
    + `COALESCE(SUM(CASE WHEN ${mirror} = 1 AND ${glAlias}.purchase_id IS NULL`
    + ` THEN 1 ELSE 0 END), 0) AS unpaired_mirror_rows`;
}

/**
 * SQL: one line's bill amount FROM THE `purchases` COLUMNS ALONE.
 *
 * ⚠ THIS IS NOT THE REPORT'S EXPRESSION. It is correct only for rows whose
 * charges really are on `purchases` — i.e. NOT PO-receipt cost mirrors, where
 * every one of these columns is the receive route's placeholder zero. Summing
 * it over a mirror row is the bug fixed on 2026-09-10 (it understated August's
 * tax ~4× and put this report ₹5,402.20 below the GRN inward register).
 * Aggregate reports must use effectiveLineTotalSql() instead.
 *
 * It is kept, and exported, for the one honest use: cross-checking an
 * invoice-numbered (hand-entered) bill, where the two expressions must produce
 * the same number — which is exactly what scripts/purchase-charges-tests.js §7
 * asserts. A purchaseChargeSumsSql() built on this used to exist beside it and
 * was DELETED rather than left to be re-imported by the next report.
 *
 * COALESCE despite the NOT NULL DEFAULT 0 declarations: older rows predate
 * several of those ALTERs, and one NULL would turn a whole bill's total NULL.
 */
export function purchaseLineTotalSql(alias = 'p'): string {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(${a}total_price, 0) - COALESCE(${a}discount, 0)`
    + ` + COALESCE(${a}cgst, 0) + COALESCE(${a}sgst, 0)`
    + ` + COALESCE(${a}compensation_cess, 0) + COALESCE(${a}special_excise_cess, 0)`
    + ` + COALESCE(${a}tcs, 0) + COALESCE(${a}delivery_charges, 0)`
    + ` + COALESCE(${a}mrp_round_off, 0)`;
}

/**
 * SQL: 1 when this `purchases` row is a PO-receive cost mirror (no invoice_id
 * of ours, but a hard grn_id), else 0.
 *
 * THE definition, imported by src/lib/purchase-bill-summary.ts as well, because
 * the flag on a bill row and the count behind an aggregate cell have to
 * describe the same rows or one of the two screens is lying.
 */
export function poReceiptMirrorSql(alias = 'p'): string {
  const a = alias ? `${alias}.` : '';
  return `CASE WHEN TRIM(COALESCE(${a}invoice_id, '')) = ''`
    + ` AND TRIM(COALESCE(${a}grn_id, '')) <> ''`
    + ` THEN 1 ELSE 0 END`;
}

/** Coerce a DB row's charge fields to numbers, rounded to paise. */
export function chargeSums(row: Record<string, unknown> | null | undefined): PurchaseChargeSums {
  const out = {} as PurchaseChargeSums;
  for (const c of PURCHASE_CHARGE_COLUMNS) out[c.key] = r2(Number(row?.[c.key]) || 0);
  out.bill_value = r2(Number(row?.bill_value) || 0);
  out.total_amount = r2(Number(row?.total_amount) || 0);
  return out;
}

/**
 * Add up a breakdown's rows. Used by the proof harness and by the screen's own
 * "does the footer foot?" check — NOT to produce the figures shown, which come
 * from the server. Two independent paths to the same number is the point.
 */
export function chargeTotals(rows: readonly PurchaseChargeRow[]): PurchaseChargeSums {
  const out = {} as PurchaseChargeSums;
  for (const c of PURCHASE_CHARGE_COLUMNS) {
    out[c.key] = r2(rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0));
  }
  out.bill_value = r2(rows.reduce((s, r) => s + (Number(r.bill_value) || 0), 0));
  out.total_amount = r2(rows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0));
  return out;
}

/**
 * True when ANY row behind this figure took its charges from a GRN line.
 *
 * ANY, not ALL. The predicate this replaced fired only when every row in the
 * group was a PO receipt, which on the live data was true for 3 of 42 vendors
 * and 15 of 465 items and for NONE of the month, category, super-category or
 * payment-mode groups — the four breakdowns where the figure was most wrong.
 * A disclosure that goes quiet exactly where the mixing happens is not a
 * disclosure.
 */
export function hasGrnSourcedCharges(row: PurchaseChargeRow): boolean {
  return (Number(row.grn_sourced_rows) || 0) > 0;
}

/**
 * True when EVERY row behind this figure is a PO-receipt mirror whose GRN line
 * is missing — so the charges are unavailable rather than zero.
 *
 * ALL, not any, and deliberately so: this is the predicate that BLANKS a cell,
 * and blanking a mixed group would hide the charges of the rows that do have a
 * source. A mixed group prints its real total and the row's note names the
 * unpaired count. 0 groups qualify on today's data.
 */
export function isChargeSourceMissingRow(row: PurchaseChargeRow): boolean {
  const n = Number(row.count) || 0;
  return n > 0 && (Number(row.unpaired_mirror_rows) || 0) === n;
}

/**
 * True when ANY line behind this figure is a mirror whose GRN line is gone —
 * so this row's SUBTOTAL and GRAND TOTAL are understated.
 *
 * THIS, NOT isChargeSourceMissingRow(), IS THE PREDICATE A RENDERER WANTS.
 * The ALL rule above answers a narrow question ("may this CELL go blank?") and
 * is correct for that. It is the wrong question to ask before printing a
 * payable figure: on a mixed row it returns false, no cell blanks, every number
 * looks ordinary and the row foots — while the Grand Total is short. A 2-line
 * GRN that loses one line prints 2,000 − 100 + 162 = 2,062 against a true
 * 2,244, and the reader's own addition confirms it.
 *
 * 0 rows qualify on today's data (unpaired_mirror_rows = 0 everywhere). Kept
 * because the failure is silent, self-consistent and arithmetically convincing,
 * which is the combination nothing else on either page can catch.
 */
export function hasUnpairedMirrorRows(row: PurchaseChargeRow): boolean {
  return (Number(row.unpaired_mirror_rows) || 0) > 0;
}

/**
 * The warning to print BESIDE a Subtotal or Grand Total that may be short, or
 * null when the row is sound. One sentence, plain words, no rupee figure — the
 * shortfall is unknowable (see the header), so naming a number would be a
 * fabrication. The count is the only quantity that is actually known.
 */
export function unpairedMirrorNote(row: PurchaseChargeRow): string | null {
  const unpaired = Number(row.unpaired_mirror_rows) || 0;
  if (unpaired <= 0) return null;
  const n = Number(row.count) || 0;
  const all = isChargeSourceMissingRow(row);
  return `UNDERSTATED — ${unpaired} of ${n} line${n === 1 ? '' : 's'} here ${unpaired === 1 ? 'is a PO receipt' : 'are PO receipts'} `
    + 'whose GRN line (the bill document) has been deleted, so its charges are gone and the Subtotal '
    + `falls back to the booked cost. ${all ? 'The charge cells are blank because the figure is unavailable, not zero. ' : ''}`
    + 'How much is missing cannot be known from here. Do not pay a vendor against this figure — '
    + 'report it: a cost row outliving its bill document means a GRN was deleted without unwinding the purchase.';
}

/** Where this row's charges came from, as one line of CSV-safe prose. */
export function chargeNote(row: PurchaseChargeRow): string {
  if (isChargeSourceMissingRow(row)) return CHARGE_SOURCE_MISSING_NOTE;
  const unpaired = Number(row.unpaired_mirror_rows) || 0;
  const grn = Number(row.grn_sourced_rows) || 0;
  const n = Number(row.count) || 0;
  const parts: string[] = [];
  if (grn > 0) parts.push(`${grn} of ${n} lines — ${GRN_SOURCED_NOTE}`);
  // The PARTIAL note, not the ALL one. The ALL note says the charge cells are
  // blank; on a mixed row not one of them is, so quoting it here told the
  // reader to look for an emptiness that is not on the page.
  if (unpaired > 0) parts.push(`!! ${unpaired} of ${n} lines: ${CHARGE_SOURCE_PARTIAL_NOTE}`);
  return parts.join('; ');
}

/**
 * ONE cell of a charge column.
 *
 * Returns null for "unavailable here" — which every renderer must print as a
 * BLANK (CSV) or an em dash (screen), never as 0. A 0 in a tax column is a
 * claim that no tax was charged.
 *
 * The blank is allowed ONLY when the stored sum is also exactly 0, so a blank
 * can never swallow a rupee and Σ(cells, blank = 0) is always the column total.
 */
export function chargeCell(row: PurchaseChargeRow, col: PurchaseChargeColumn): number | null {
  const v = r2(Number(row[col.key]) || 0);
  if (v === 0 && isChargeSourceMissingRow(row)) return null;
  return v;
}

/** The eight cells of a row, in column order. */
export function chargeCells(row: PurchaseChargeRow): (number | null)[] {
  return PURCHASE_CHARGE_COLUMNS.map(c => chargeCell(row, c));
}

/**
 * The charge columns appended to an existing CSV header.
 *
 * APPENDED, NEVER INSERTED. A saved spreadsheet, a pivot table or a formula
 * that already points at column D of last month's export keeps working only if
 * every column that existed still sits where it sat. New columns go on the
 * right, in this order, ending with the note column.
 */
export function appendChargeCsvHeader(existing: readonly string[]): string[] {
  return [
    ...existing,
    ...PURCHASE_CHARGE_COLUMNS.map(c => c.csvHeader),
    // SUBTOTAL sits between the charges and the GRAND TOTAL it feeds, so the
    // file reads left to right as the arithmetic it is: charges, base, total.
    // It stays in THIS position rather than moving left of the eight charges to
    // read "subtotal then charges": columns are appended here, never inserted
    // or reordered (see the rule above), and scripts/purchase-charges-tests.js
    // §6 pins these three positions.
    BILL_VALUE_CSV_HEADER,
    TOTAL_AMOUNT_CSV_HEADER,
    CHARGE_NOTE_CSV_HEADER,
  ];
}

/* ───────────────────────────────────────────────────────────────────────────
 * THE ONE THING THE TWO PURCHASE REPORTS ORDER DIFFERENTLY — LEFT OPEN, ON
 * PURPOSE, WITH THE BLOCKER NAMED. 2026-09-11.
 *
 * /reports/purchase-bill-summary reads:  Subtotal · the eight charges · Grand total
 * /reports/purchases        reads:  Spend · the eight charges · Subtotal · Grand total
 *
 * So the base arrives AFTER everything added to it on one of the two screens,
 * and Discount is the 3rd money column on one report and the 9th on the other.
 * Each report is internally consistent — its screen and its CSV agree — but the
 * owner reconciles between them, and the mismatch is a real cost.
 *
 * IT WAS NOT FIXED, AND THE REASON IS NOT TASTE. scripts/purchase-charges-tests.js
 * pins the POSITION of BILL_VALUE_CSV_HEADER by index:
 *     expect(h[lead.length + KEYS.length], PC.BILL_VALUE_CSV_HEADER, ...)
 * so moving the Subtotal left of the eight charges fails that assertion, and
 * that file belongs to another lane. Changing the SCREEN alone would break the
 * thing that IS currently true — screen and file agreeing within one report —
 * to fix the thing that is not, which is a net loss.
 *
 * TO CLOSE IT: move BILL_VALUE_CSV_HEADER ahead of the eight in the array above
 * AND move the <th>/<td> pair in the breakdown table of
 * src/app/reports/purchases/page.tsx, AND update the index in §6 of the test.
 * The CSV rule this file states — appended, never inserted — is the other cost:
 * an existing spreadsheet pointed at a column index would shift. That is the
 * owner's call, not this lane's.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The charge cells appended to an existing CSV row.
 *
 * null cells go out as EMPTY STRING — a blank cell, which a spreadsheet ignores
 * in a SUM. Numbers go out as NUMBERS (not strings): the caller's escaper must
 * leave a real number alone, or a negative round-off arrives quoted as text and
 * the reader's own SUM over the column breaks. See downloadCsv() on the page.
 */
export function appendChargeCsvRow(
  existing: readonly (string | number)[],
  row: PurchaseChargeRow,
): (string | number)[] {
  return [
    ...existing,
    ...chargeCells(row).map(v => (v == null ? '' : v)),
    r2(Number(row.bill_value) || 0),
    r2(Number(row.total_amount) || 0),
    chargeNote(row),
  ];
}

/**
 * ₹ with the sign kept, always to the paisa. THE formatter for every charge
 * figure on screen.
 *
 * Two jobs, and both matter:
 *   · MRP Round-off is signed — −0.40 must read as −₹0.40 and never as ₹0.40.
 *     A true minus (U+2212) reads as a minus at small sizes, where an ASCII
 *     hyphen looks like a dash between two numbers.
 *   · Two decimals ALWAYS, so a row of charge columns reads as one row of money
 *     (₹562.50 · ₹750.00 · ₹0.00) instead of the ragged ₹562.5 · ₹750 · ₹0.00
 *     that a plain locale format produces. The page's own ₹ formatter is left
 *     alone for Spend and the pre-existing cards — those figures had to keep
 *     rendering exactly as they always have.
 *
 * null is an em dash: "not applicable", never ₹0.
 */
export function fmtSignedINR(n: number | null | undefined): string {
  if (n == null) return '—';
  const v = r2(Number(n) || 0);
  const body = '₹' + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? '−' + body : body;
}
