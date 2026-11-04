import type DatabaseT from 'better-sqlite3';
import { getDb } from './db';
import { todayIST } from './format-date';
import { claimJoin } from './po-receipts';
// The "Tax % Applied (GST)" base. GST only — compensation cess sits on the
// GROSS line value and GST on the post-discount value, so the two cannot share
// a denominator and must never share a percentage. See src/lib/tax-applied.ts.
import { taxAppliedSumsSql, gstValue, taxAppliedPercent } from './tax-applied';
// THE BILL GRAND TOTAL column and the TAX VALUE / TAX % columns (owner #5,
// ruling 93). The arithmetic is IMPORTED, never re-typed: effectiveChargeSql()
// / effectiveBillValueSql() read a charge off the bill DOCUMENT (the GRN line
// on a PO-receipt mirror, the purchases row otherwise — the rail the Purchase
// Report Summary, the Purchase Bill Summary and the GRN Inward Register all
// share), effectiveLineTotalSql() is the per-line Grand Total the Bill Summary
// sums, and the bill figure PRINTED is the Bill Summary's own total_bill_value
// for the bill — see billGrandTotals() below.
import {
  withGrnCharges, grnLineJoinSql, grnSourcedSql, poReceiptMirrorSql,
  effectiveChargeSql, effectiveLineTotalSql,
} from './purchase-charges';
// The Tax % denominator on a PURCHASE row: the value GST was CHARGED on — the
// subtotal, except on a PO receipt part-rejected at the door, where it is the
// ACCEPTED value, as the GRN Inward Register strikes it and as this log's own
// GRN row already does (ROUND(accepted × rate, 2)). Without it the PURCHASE row
// and the GRN row of one delivery printed two rates (14.40% vs 18.00%).
import { gstChargedValueSql, gstBaseAcceptedSql } from './purchase-gst-base';
import { getPurchaseBillSummary, type PurchaseBillRow } from './purchase-bill-summary';

/**
 * PURCHASE LOG — one row per ITEM per BILL, across all three procurement
 * sources (direct purchases, purchase orders, goods receipt notes), in one
 * chronological list the owner can download as a single CSV.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MODEL — WHY THESE THREE SOURCES ARE **NOT** ADDITIVE
 * ═══════════════════════════════════════════════════════════════════════════
 * Receiving a PO (src/app/api/purchase-orders/[id]/receive/route.ts) writes,
 * inside ONE transaction, for a single physical delivery:
 *
 *   1 × po_vendor_bills       — the vendor's bill event on that PO
 *   1 × goods_receipt_notes   — the GRN header (grn_number = GRN-<yyyy>-####)
 *   N × goods_receipt_note_items — one per received line, at GROSS bill rates
 *   N × purchases             — one per line with accepted > 0, at NET rates
 *
 * The ad-hoc path (POST /api/grn) does the same minus the PO: a GRN header,
 * GRN items, and a mirrored `purchases` row per accepted line.
 *
 * So a received PO line exists THREE times in the database:
 *   • purchase_order_items — what we ORDERED   (a commitment, not a spend)
 *   • goods_receipt_note_items — what the vendor BILLED (gross, the document)
 *   • purchases            — what we BOOKED    (net, the cost/stock entry)
 *
 * They are the same money. A naive UNION total would read ~2–3× the real
 * spend, and that is exactly the number an owner would quote. Hence:
 *   → totals are returned PER SOURCE and never summed (see PurchaseLogTotals),
 *   → every row carries `source`,
 *   → every row that belongs to one receipt event carries the same `link_key`.
 *
 * ── THE LINK. There is NO foreign key from `purchases` back to its GRN. ──
 * The only tie that exists in the schema is the GRN NUMBER, written literally
 * into `purchases.notes` by both writers, in the same transaction that minted
 * it (so it is always present and always correct):
 *
 *   PO receive : "Received against PO-2026-0001 (GRN GRN-2026-0007)"
 *                                                    ^^^^^^^^^^^^^
 *   Ad-hoc GRN : "Ad-hoc GRN GRN-2026-0007 · invoice 4841"
 *   Correction : "BACK-CORRECTION GRN GRN-2026-0007 · invoice 4841"
 *
 * A PO line reaches its GRN line through goods_receipt_note_items.po_item_id.
 * Chaining the two gives the receipt-event key used here:
 *
 *   link_key = "<grn_number>#<material_id>"
 *
 * present on the GRN line, on the `purchases` row it created, and on the PO
 * line it was received against. Sort or filter a download by link_key and the
 * three faces of one delivery sit together — the duplication is VISIBLE, which
 * is the whole point, rather than silently resolved by dropping a source.
 * link_key is null on a direct purchase (no GRN) and on a PO line not yet
 * received (or received outside the requested date window).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNITS — the standing error in this codebase, avoided here deliberately
 * ═══════════════════════════════════════════════════════════════════════════
 * purchases.quantity, purchase_order_items.quantity and the GRN quantity
 * columns are ALL ALREADY IN PURCHASE UNITS, and all three unit_price columns
 * are ₹ PER PURCHASE UNIT. pack_size / packFactor MUST NOT be applied to any
 * of them — that conversion belongs only on the way into raw_materials
 * .current_stock (recipe units). This file therefore never imports pack-units.
 * `purchase_unit` is printed beside every quantity so no reader can mistake a
 * "3" for 3 recipe units when it is 3 cases.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RATES — two legitimate rates for the same line
 * ═══════════════════════════════════════════════════════════════════════════
 * GRN rate is GROSS (what the bill document says, discount in its own column).
 * purchases.unit_price is USUALLY NET of the allocated discount, because
 * updateMaterialPrice() averages SUM(qty × unit_price)/SUM(qty) and never
 * reads a discount column. The PO receive route always writes purchases
 * .discount as a LITERAL 0 (the ad-hoc GRN, QC sign-off and amendment do too
 * whenever they net) — so a zero in the Discount column of a PURCHASE row does
 * NOT mean "no discount was given"; usually the discount is already inside the
 * rate and lives, itemised, on the GRN row that shares this row's link_key.
 * Some PURCHASE rows are GROSS instead: the netting fallback (a net rate ≤ 0),
 * an amendment of a gross row and an amendment's new row for an ad-hoc line
 * keep the gross rate and record the discount in the column; ad-hoc GRN rows
 * written before 9b927e2 are gross with the discount on the GRN line only.
 * The report shows both rates, labelled by source, and never reconciles them
 * silently.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * OTHER DECISIONS, STATED SO THEY CAN BE ARGUED WITH
 * ═══════════════════════════════════════════════════════════════════════════
 * • invoice_id vs bill_no are different things and get their own columns:
 *   invoice_id = OUR generated PINV-<yyyy>-#### (one per vendor bill, purchases
 *   only — POs and GRNs never mint one). bill_no = the VENDOR's own number.
 *   There is NO third fallback: purchases.invoice_number is not in this schema
 *   (see the note on the PURCHASE branch below). goods_receipt_notes DOES have
 *   an invoice_number — that one is real and is used on the GRN branch.
 * • The 8 per-line charges (discount, cgst, sgst, special_excise_cess,
 *   compensation_cess, tcs, delivery_charges, mrp_round_off) are RECORDED-ONLY.
 *   `value` is the item value and does NOT include them. They are null — not 0
 *   — on PO rows, because purchase_order_items has no such columns at all.
 *   compensation_cess is GST COMPENSATION CESS (the levy under the GST
 *   (Compensation to States) Act — aerated drinks, tobacco). It is NOT
 *   special_excise_cess, which means TGBCL Special Excise Cess everywhere it is
 *   read or labelled, and it is NOT part of the cgst + sgst invariant: it is a
 *   separate levy, never halved, and adding it to that pair would misstate the
 *   GST on a return. It exists on BOTH `purchases` and goods_receipt_note_items,
 *   so it is reported on PURCHASE rows and on GRN rows alike; it stays null on
 *   PO rows, which genuinely have no charge columns.
 *   ITS TAXABLE BASE IS NOT THE GST BASE, and a reader comparing the two
 *   figures on one GRN row will assume it is. GST is charged on the line value
 *   AFTER the discount; compensation cess is charged on the GROSS line value
 *   BEFORE the discount. On 10 kg @ Rs 100 with a Rs 100 discount that is GST
 *   18% on Rs 900 = Rs 162 but cess 12% on Rs 1,000 = Rs 120. The two bases
 *   differ deliberately — do not "reconcile" them, here or at the writers.
 * • GRN qty is quantity_ACCEPTED (what became stock and became a purchases
 *   row), so qty × rate = value holds. quantity_rejected rides in its own
 *   column; received = qty + qty_rejected.
 * • PO rows exclude status draft / cancelled / rejected — a draft was never
 *   placed and a cancelled/rejected order will never be spend. Every other
 *   status is included with the status stamped into `notes`.
 * • raw_materials is LEFT JOINed, not inner JOINed (which /api/reports/purchases
 *   does): a log that silently drops a purchase because its material row was
 *   deleted is a wrong log. Such rows show "(unknown item)".
 * • No outlet scoping, matching the sibling /api/reports/purchases, so the two
 *   reports reconcile.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TOTALS — WHAT MAY BE ADDED, WHAT MAY NOT, AND WHY EACH REFUSAL IS PRINTED
 * ═══════════════════════════════════════════════════════════════════════════
 * The owner asked for a total and never said which one, so the readings are
 * produced side by side, each labelled, per source, and never merged into one
 * "Total". Owner ruling 98 (2026-11-01: "Tax Less Values should also show in
 * Total Amount Column as it Final Total amount should be in the Grand Total
 * Column") named them — Total Amount BEFORE tax, Grand Total after:
 *
 *   GOODS VALUE  = SUM(value). Goods only — before tax, before every charge.
 *   TOTAL AMOUNT = SUM(value - discount). BEFORE tax and every charge.
 *                  Carried per row as `total_amount`.
 *   GRAND TOTAL  = SUM(value - discount + cgst + sgst + special_excise_cess
 *                      + compensation_cess + tcs + delivery_charges
 *                      + mrp_round_off)
 *                  i.e. the app's OWN per-line total, the identical expression
 *                  /api/grn, /api/purchases and the Purchases page already use
 *                  (this log called it "Total Amount" until ruling 98).
 *                  Carried per row as `grand_total`, totalled as `bill_amount`.
 * Each is carried per row so the column and the total cannot drift, and so
 * the footer foots the column.
 *
 * Everything above is summed WITHIN ONE SOURCE and never across sources — the
 * double-count in the block at the top of this file is unchanged by any of it.
 *
 * COLUMNS THAT GET NO TOTAL, AND THE REASON THAT SHIPS WITH EACH:
 *   • qty  — every row is in ITS OWN purchase unit. 3 CASE + 12 kg is not 15.
 *   • rate — Rs per purchase unit, and GROSS on GRN rows vs USUALLY NET on
 *            PURCHASE rows (see RATES). Summing rates adds prices, not money.
 *   • discount, on PURCHASE rows only — the column is not on one basis.
 *            Receipts usually net the discount into the rate and write 0 here
 *            (PO receive always; ad-hoc GRN and QC sign-off whenever netting
 *            leaves a rate above 0; an amendment only when the row it rewrites
 *            was already net and netting still leaves a rate above 0); the
 *            netting fallback and the amendment cases in RATES write the share
 *            here at a gross rate; ad-hoc rows before 9b927e2 carry it nowhere
 *            on the row unless an amendment has since rewritten them. A total
 *            would read near "Rs 0 discount" on bills that plainly carried one.
 *            It IS totalled on the GRN block, where every writer records gross
 *            value + the real allocated share. What each PURCHASE row does
 *            carry is still netted off inside Total Amount, and the figure
 *            netted is published as `discount_netted` (the screen's "less
 *            discount") so the arithmetic on screen always foots.
 * These refusals are DATA, not prose in a component: PURCHASE_LOG_NO_TOTAL_NOTES
 * ships on every payload so the screen and the CSV state them identically.
 *
 * BILL GRAND TOTAL (2026-10-29, owner #5 / ruling 93) is a PER-BILL column, not
 * a fourth total and not a cross-source sum: every PURCHASE and GRN line carries
 * the Purchase Bill Summary's Grand Total for the WHOLE bill it sits on, read
 * from that report (one source, `purchases`, on the effective charge rail) and
 * proved against it on every request — see billGrandTotals() at the end of this
 * file. Repeated on every line of a bill, so it is never totalled anywhere.
 *
 * TAX VALUE (GST) / TAX % APPLIED (GST) (same date, same ruling) are read off
 * the BILL DOCUMENT — the row's own CGST + SGST, except on a PURCHASE row booked
 * by a PO receive, whose GST lives on its GRN line (only there, unless an
 * amendment of that line later wrote it onto the row too) and is read from there
 * (tax_value / tax_percent / tax_from_grn, gst_value on the totals). That is
 * the rail the Purchase Report Summary sums, so the PURCHASE tax total equals
 * its GST for the same filters. The RATE is struck on the value GST was
 * charged on (src/lib/purchase-gst-base.ts): the subtotal, except on a PO
 * receipt part-rejected at the door, where it is the ACCEPTED value — as the
 * GRN Inward Register and this log's GRN row strike it — so the PURCHASE and
 * GRN rows of one delivery print one rate. On exactly those lines the
 * Summary's rate (received base) reads lower; tax_base_accepted /
 * gst_base_accepted_lines carry the disclosure. The eight RECORDED charge columns, Total Amount,
 * Grand Total and every total built on them are unchanged; on a mirror row the tax columns
 * and the recorded CGST/SGST columns therefore can differ (they agree once an
 * amendment has written the GRN line's GST onto the row), and both renderers say why.
 *
 * KNOWN, DISCLOSED IMPRECISION (historical, a writer defect, not a reporting
 * choice): ad-hoc GRN rows written before grn/route.ts began netting the
 * discount into the rate (9b927e2, 2026-08-24) mirrored GROSS value into
 * `purchases` and copied no discount (nor any of the bill's GST or charges),
 * so Total Amount on THOSE PURCHASE rows is high by the discount their GRN
 * line records (8 such GRN lines on the 2026-11-01 DB copy, all dated
 * 2026-08-07), and Grand Total is high by that discount but low by the GST
 * and charges the row never carried — net it usually reads low (all of them
 * do on that copy, the GST being the larger), but a large discount on a
 * low-GST line can make it read high. Current
 * writers either net it into the rate or, at a gross rate, record it in the
 * column (the netting fallback and the amendment cases in RATES). The GRN
 * block states that discount in full. Nothing has corrected those old rows
 * in bulk; an amendment of one rewrites that one row.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ GOODS VALUE ON PURCHASE ROWS IS NOT RELIABLY TAX-EXCLUSIVE — READ BEFORE
 *   TRUSTING A GOODS VALUE, TOTAL AMOUNT OR GRAND TOTAL FIGURE ON A PURCHASE ROW
 * ═══════════════════════════════════════════════════════════════════════════
 * `value` on the PURCHASE branch is `COALESCE(p.total_price, p.quantity *
 * p.unit_price)`. That column is supposed to hold the GOODS figure only. It
 * does not, on some rows: the one-off bulk import of the April 2026 inward
 * sheet (scripts/import-recaho-inward.js as of 025e0ec, run once on
 * 2026-05-12 — every April-dated row carries its "Invoice: … · Inward: …"
 * note and that one created_at) bound `total_price` to the sheet's TOTAL
 * INWARD AMOUNT, which includes GST, TGBCL TCS / special excise cess, delivery
 * and MRP round-off (the importer at src/app/api/inward-import/commit/route.ts
 * ~256-305 now binds quantity × rate and documents that formula), and wrote no
 * discount, tax or charge columns for those rows. Nothing backfilled them —
 * measured on the full table: 2,165 PURCHASE rows total, 2,118 of them dated
 * April 2026 from that import, 219 of which differ from quantity × rate (on
 * the rest value matches quantity × rate, which does NOT prove them tax-free:
 * db.ts's price_basis_repair_v1 set unit_price = total_price / quantity on
 * some pack-size rows); SUM(total_price) = Rs 6,926,866.40 vs
 * SUM(quantity × unit_price) = Rs 6,770,245.24 — a Rs 156,621.16 net gap
 * (Rs 156,621.20 on the 221 rows that differ — those 219 plus two 2026-08
 * rows at −0.01 each — less a few paise of rate rounding on the rest) that
 * is almost all tax and charges sitting inside a column labelled "goods only,
 * before tax" (Rs 116,296.09 of it on GOVERNMENT OF TELANGANA liquor lines
 * that carry no GST at all — TGBCL TCS + special excise cess).
 *
 * Because those same rows carry no discount, tax or charge of their own (0 of
 * the 2,118 on the 2026-11-03 DB copy), TOTAL AMOUNT — value less discount,
 * the "before tax" figure — and GRAND TOTAL — that plus tax and charges — both
 * compute to the exact SAME number as GOODS VALUE for them. The figures this
 * report exists to keep apart are, on the owner's most likely view, identical,
 * and where the sheet's total included tax and charges they are inside all
 * three: the "before tax" Total Amount holds them.
 *
 * A SECOND, separate effect on PURCHASE rows created by a goods receipt: some
 * carry little or none of the bill's GST and charges themselves. A row booked
 * straight by a PO receive (no QC hold) records only its delivery share — no
 * GST, cess, excise, TCS or round-off — until an amendment of its GRN line
 * writes CGST/SGST/comp. cess onto it; ad-hoc rows before 9b927e2 carried no
 * GST of their own either (nor the discount — see KNOWN, DISCLOSED
 * IMPRECISION above). GRAND TOTAL on such a row does not match the GRN bill
 * and usually reads LOW against it (an old ad-hoc row can read high, by its
 * missing discount): on the 31 GRN-paired lines of the 2026-11-01 DB copy
 * (20 from a PO receive, 11 older ad-hoc), 25,330.00 vs 30,732.20, roughly
 * 17.6% low. For those deliveries read the GRN rows, not the PURCHASE
 * mirror (the Tax Value column already reads that GST off the GRN line).
 *
 * THIS IS A DATA PROBLEM, NOT A DISPLAY BUG, and re-deriving the contaminated
 * rows is a separate, unapproved job. `goods_value_tax_suspect` /
 * `goods_value_tax_suspect_lines` on PurchaseLogSourceMoney and
 * `PurchaseLogTotals.goods_value_caveat` exist so this report SURFACES the
 * problem, quantified for whatever window is on screen, rather than hiding it
 * behind a total that foots to the paisa and is still wrong. Render
 * `goods_value_caveat` verbatim, prominently, wherever GOODS VALUE, TOTAL
 * AMOUNT or GRAND TOTAL is shown — screen and download alike.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types (the route and the page import these — keep the shape stable)
// ─────────────────────────────────────────────────────────────────────────────

export type PurchaseLogSource = 'PURCHASE' | 'PO' | 'GRN';

/** ?source= filter values accepted on the wire. */
export type PurchaseLogSourceFilter = 'all' | 'purchase' | 'po' | 'grn';

export interface PurchaseLogRow {
  /** Which table this row came from. Rows are NEVER additive across sources. */
  source: PurchaseLogSource;
  /** YYYY-MM-DD (IST calendar date as stored). */
  date: string;
  /** PINV-… / PO-… / GRN-… — the document this line sits on. */
  doc_no: string;
  /** OUR number (PINV-yyyy-####). Purchases only; '' on PO/GRN rows. */
  invoice_id: string;
  /** The VENDOR'S own bill number. Never conflate with invoice_id. */
  bill_no: string;
  vendor: string;
  material: string;
  sku: string;
  category: string;
  /** ALREADY in purchase units — never multiplied by pack_size. */
  qty: number;
  purchase_unit: string;
  /** ₹ per PURCHASE unit. GROSS on GRN rows; usually NET of discount on PURCHASE rows (gross on some — see RATES). */
  rate: number;
  /**
   * The goods figure: qty × rate, except on PURCHASE rows, where it is the
   * stored total_price — which can differ (tax inside it on old import rows, or
   * a paisa of rate rounding; see goods_value_tax_suspect). Excludes the 8
   * recorded-only charges below.
   */
  value: number;
  /**
   * TOTAL AMOUNT — this line BEFORE tax: value − discount (owner ruling 98).
   * ⚠ On some PURCHASE rows (dated April 2026, from the old bulk import) value
   * may already hold the vendor's tax and charges (never split out), and then
   * so does this figure — see goods_value_caveat.
   *
   * null on PO rows, and null rather than 0 deliberately: purchase_order_items
   * has no charge columns at all — not even a discount — so an ordered line has
   * a goods value and no bill amount. A 0 there would assert a bill nobody sent.
   */
  total_amount: number | null;
  /**
   * GRAND TOTAL — THE BILL FIGURE for this line: total_amount + cgst + sgst
   * + special_excise_cess + compensation_cess + tcs + delivery_charges
   * + mrp_round_off, i.e. value − discount + every recorded charge — the same
   * expression /api/grn, /api/purchases and the Purchases page use, so this
   * report foots against them. This log's "Total Amount" until ruling 98.
   *
   * null on PO rows, for the reason above. A 0 there would assert "this order
   * will cost nothing extra".
   */
  grand_total: number | null;
  /** GRN rows only (units turned away at QC); null on PURCHASE/PO rows. */
  qty_rejected: number | null;
  // ── Recorded-only charges. null on PO rows (no such columns exist there).
  discount: number | null;
  cgst: number | null;
  sgst: number | null;
  special_excise_cess: number | null;
  /**
   * GST compensation cess. PURCHASE and GRN rows — null on PO rows.
   * Charged on the GROSS line value, BEFORE discount — NOT on the
   * post-discount base cgst/sgst use. See the header note.
   */
  compensation_cess: number | null;
  tcs: number | null;
  delivery_charges: number | null;
  mrp_round_off: number | null;
  /** "<grn_number>#<material_id>" — the one receipt event behind up to 3 rows. */
  link_key: string | null;
  notes: string;
  /**
   * TAX VALUE (GST) — CGST + SGST as the BILL DOCUMENT states it for this line
   * (owner #5, ruling 93). On a GRN or an ordinary PURCHASE row that is the
   * row's own cgst + sgst. On a PURCHASE row booked by a PO receive it is the
   * paired GRN line's, because that route records the GST on the GRN line only
   * and leaves this row's cgst/sgst at 0 (an amendment of the GRN line may later
   * write them onto the row) — the same effective rail the Purchase
   * Report Summary and the Bill Summary read, so the figure equals theirs.
   * The recorded cgst / sgst fields above are NOT changed by this.
   *
   * null — BLANK, NEVER 0 — where no GST was typed, and on every PO row.
   */
  tax_value: number | null;
  /**
   * TAX % APPLIED (GST) on that same basis: tax_value ÷ (the value GST was
   * charged on − discount). That value is the subtotal, except on a PO receipt
   * part-rejected at the door, where it is the ACCEPTED value — the GRN Inward
   * Register's basis and this log's GRN row's, so one delivery reads one rate
   * (tax_base_accepted). null = none.
   */
  tax_percent: number | null;
  /** true when tax_value / tax_percent were read off the paired GRN line (a PO receipt's mirror row). */
  tax_from_grn: boolean;
  /** true when tax_percent was struck on the ACCEPTED value of a part-rejected PO receipt (PURCHASE rows only). */
  tax_base_accepted: boolean;
  /**
   * true on a PURCHASE row booked by a PO receive whose GRN line has since
   * been deleted: its tax is UNAVAILABLE (blank), not "no GST entered".
   */
  tax_unavailable: boolean;
  /**
   * BILL GRAND TOTAL — the grand total of the WHOLE BILL this line sits on:
   * Subtotal − Discount + CGST + SGST + both cesses + TCS + delivery + MRP
   * round-off, over every line of that bill. It is the Purchase Bill Summary's
   * own `total_bill_value` for that bill, over the same date window, so the two
   * reports print one number per bill (owner #5, ruling 93).
   *
   * NOT a per-line figure and NOT this line's Total Amount or Grand Total: the SAME number is
   * repeated on every line of the bill — the PURCHASE row and the GRN row of one
   * delivery alike — so it must NEVER be added down the column. Nothing in this
   * file or the route totals it; PURCHASE_LOG_NO_TOTAL_NOTES says why.
   *
   * null (blank / em dash) when there is no bill to quote:
   *   • every PO row — an order is not a bill;
   *   • a GRN row whose delivery has no booked purchase line in the window
   *     (every line rejected) or whose lines fall on two bills;
   *   • a bill whose figure did NOT reconcile with the Bill Summary — blanked
   *     rather than printed, see bill_grand_total_check on the totals.
   * `bill_grand_total_reason` carries the sentence for each of those.
   */
  bill_grand_total: number | null;
  /** The Bill Summary's bill_key for that bill — pivot to its CSV's Bill Key column. */
  bill_key: string | null;
  /** That bill in plain words (vendor · PINV / GRN number / vendor bill / day). */
  bill_label: string | null;
  /** How many purchase lines that bill has — the Bill Summary's `lines`. */
  bill_lines: number | null;
  /** Why bill_grand_total is null, one sentence; '' when it carries a figure. */
  bill_grand_total_reason: string;
  /**
   * How many of that bill's lines are cost rows booked from a goods receipt
   * whose GRN line has since been DELETED — the Bill Summary's own
   * unpaired_mirror_rows for the bill. > 0 means the printed Bill Grand Total
   * is SHORT: the tax and charges recorded on the deleted line are missing,
   * exactly as on the Bill Summary and the Purchases register, which flag the
   * same bill. null where no figure is printed. A FLAG — it moves no figure.
   */
  bill_unpaired_lines: number | null;
  /** The "understated" warning for bill_grand_total, one paragraph; '' when the bill is sound. */
  bill_understated_note: string;
}

/**
 * How the Bill Grand Total column was proved against the Purchase Bill Summary
 * for THIS response. `mismatched` > 0 is a defect: those bills print blank and
 * every renderer must say so in words.
 */
export interface PurchaseLogBillCheck {
  /** Distinct bills the PURCHASE / GRN rows of this response point at. */
  bills: number;
  /** Matched to the Bill Summary's bill: same line count, same total to the paisa. */
  matched: number;
  /**
   * Bills past the Bill Summary's own 5,000-bill row cap, so there was no row
   * there to compare with. Printed from this file's figure, which is the same
   * SQL arithmetic (effectiveLineTotalSql, same window). 0 unless the window
   * holds more than 5,000 bills.
   */
  unverified: number;
  /** Bills whose figure disagreed with the Bill Summary — printed BLANK. */
  mismatched: number;
  /**
   * Bills printed WITH a figure that is UNDERSTATED (bill_unpaired_lines > 0):
   * a GRN line behind one of their cost rows has been deleted. A defect, said
   * in words beside the figure and in the CSV's captions. 0 today.
   */
  understated: number;
  /** Those bills in plain words (their bill_label), for the CSV caption. */
  understated_bills: string[];
}

/**
 * One source's money, totalled over the FULL filtered set (never the capped
 * rows). Every figure is in rupees and every one of them is a total of ONE
 * basis — nothing here may be added to the same field of another source.
 *
 * `null` means "deliberately not totalled", never "zero". Two cases produce it:
 *   • the whole PO block, which has no charge columns to total, and
 *   • `discount` on PURCHASE, where a 0 means three different things.
 * The reason for every null ships beside it in PURCHASE_LOG_NO_TOTAL_NOTES.
 */
export interface PurchaseLogSourceMoney {
  source: PurchaseLogSource;
  lines: number;
  /** SUM(value). Goods only — before tax, before every charge, before discount. */
  goods_value: number;
  /** SUM(discount). null on PURCHASE — see the note; totalled on GRN. */
  discount: number | null;
  /**
   * What was ACTUALLY deducted inside total_amount and bill_amount on this
   * source. Published even where `discount` is refused, so goods_value −
   * discount_netted re-adds to total_amount and + tax + other_charges to
   * bill_amount, on screen and in the file.
   * It is the deduction, NOT a statement of discount received.
   */
  discount_netted: number;
  cgst: number | null;
  sgst: number | null;
  /**
   * cgst + sgst — the house invariant tax_value = cgst + sgst. Compensation
   * cess is NOT in here: different levy, different taxable base (gross, before
   * discount), never halved, and folding it in would misstate a GST return.
   */
  tax_cgst_sgst: number | null;
  special_excise_cess: number | null;
  compensation_cess: number | null;
  tcs: number | null;
  delivery_charges: number | null;
  /** Signed — a bill can round down. */
  mrp_round_off: number | null;
  /** special_excise_cess + compensation_cess + tcs + delivery + round-off. */
  other_charges: number | null;
  /**
   * THE TOTAL AMOUNT COLUMN'S TOTAL — before tax: SUM(value − discount), i.e.
   * goods_value − discount_netted (owner ruling 98). null on PO (an order is
   * not a bill).
   */
  total_amount: number | null;
  /**
   * THE bill total, and THE GRAND TOTAL COLUMN'S TOTAL: goods_value −
   * discount_netted + tax_cgst_sgst + other_charges. null on PO (an order is
   * not a bill).
   */
  bill_amount: number | null;
  /**
   * SUM(value) − SUM(quantity × rate) for THIS source, over this window — a
   * NET figure over every line, not only the lines counted below.
   * Should be 0 — `value` is meant to be quantity × rate on every branch (the
   * PURCHASE branch reads the stored total_price, falling back to quantity ×
   * rate). Nonzero means the stored value disagrees with the line's own
   * quantity × rate. The main known cause, on PURCHASE, is `total_price`
   * written by the pre-fix inward-import path (see the file header) — the
   * tax/charges sitting inside a "goods value" that should not contain them.
   * A paisa or two either way is rate rounding instead (two 2026-08 rows on
   * the 2026-11-01 DB copy read −0.01 each), so the live caveat names tax,
   * charges and rate rounding and never calls the figure tax alone. Real for
   * GRN/PO too if it ever appears there, by the same arithmetic — nothing here
   * is source-specific except the known cause.
   */
  goods_value_tax_suspect: number;
  /** Lines behind goods_value_tax_suspect — value ≠ quantity × rate (2dp). */
  goods_value_tax_suspect_lines: number;
  /**
   * THE "Tax % Applied (GST)" BASE for this source: Σ(value − discount) over
   * the lines that CARRIED GST, with `taxed_lines` being how many that was.
   *
   * Not Σ(value) − Σ(discount). On this database 2,158 of 2,165 PURCHASE lines
   * record no GST — 217 of them because the old inward-import path wrote a
   * tax-INCLUSIVE total_price and never split the tax out — so a rate over the
   * whole source would read 0.01% where the vendor charged 18%, and on those 217
   * rows it would be dividing tax by a tax-inclusive base as well. Restricting
   * the base to the GST-bearing lines makes the figure the rate that was
   * actually applied, and `taxed_lines` lets every renderer say over how many
   * lines — so a blended multi-rate group can never read as one vendor's rate.
   *
   * 0 on PO, whose branch binds no charge columns at all: with no GST anywhere
   * there is no taxed base, and the percentage renders as an em dash (never 0%).
   */
  taxed_bill_value: number;
  /** Lines behind taxed_bill_value — how many recorded GST > 0. */
  taxed_lines: number;
  /**
   * THE TAX VALUE (GST) COLUMN'S TOTAL — Σ of the rows' tax_value, i.e. the
   * bill document's CGST + SGST (the paired GRN line's on a PO receipt's
   * mirror row). It can differ from tax_cgst_sgst above only on those mirror
   * rows, whose own columns usually record 0 (an amendment of the GRN line can
   * write GST onto the row); tax_cgst_sgst stays the RECORDED figure
   * because bill_amount (Grand Total) is built from it and must keep footing.
   * null on PO. A 0 here is "no GST anywhere in this source" and renders blank.
   */
  gst_value: number | null;
  /** The Tax % column's base on that same basis — Σ(value GST was charged on − discount) over
   *  GST-bearing lines: the subtotal, except the ACCEPTED value on a part-rejected PO receipt. */
  gst_taxed_bill_value: number;
  /** Lines behind gst_taxed_bill_value. */
  gst_taxed_lines: number;
  /** Lines whose tax_value was read off their paired GRN line (PURCHASE only; 0 elsewhere). */
  gst_from_grn_lines: number;
  /**
   * GST-bearing lines whose Tax % base is the ACCEPTED value because the
   * delivery was part-rejected at the door (PURCHASE only; 0 elsewhere). On
   * those lines — and only those — this source's Tax % differs from the
   * Purchase Report Summary's, which still divides by the received value.
   */
  gst_base_accepted_lines: number;
}

/** A column left without a total on purpose, and the reason, shipped as data. */
export interface PurchaseLogNoTotalNote {
  /** Column heading as the reader sees it. */
  column: string;
  /** One or two sentences. Render VERBATIM — a silent omission is the bug. */
  reason: string;
}

/**
 * Printed under every totals block, on screen and in the CSV alike. A column
 * with no total must SAY it has no total and why; a reader who cannot find a
 * figure assumes the report lost it, and then adds the wrong column instead.
 */
export const PURCHASE_LOG_NO_TOTAL_NOTES: PurchaseLogNoTotalNote[] = [
  {
    column: 'Qty',
    reason:
      'No total. Every line is in its own purchase unit — cases, bottles, kg, litres — so '
      + 'adding them gives a number with no unit. Total by item, or filter to one item.',
  },
  {
    column: 'Rate',
    reason:
      'No total. A rate is rupees PER purchase unit, and the same delivery can carry two of them: '
      + 'GRN rows hold the vendor’s gross rate, PURCHASE rows usually the rate net of the '
      + 'discount (gross on some rows). Adding rates adds prices, not money.',
  },
  {
    column: 'Discount (on PURCHASE rows)',
    reason:
      'No total on the PURCHASE block. Receipts usually fold the bill discount into the PURCHASE '
      + 'row’s rate and leave this column at 0; some rows can carry it in this column instead, and '
      + 'older receipt rows may carry it nowhere (only their GRN line does). The column is not on '
      + 'one basis, so a total would '
      + 'mislead. It IS totalled on the GRN block, where every row shares one basis. Whatever a '
      + 'PURCHASE row does record here is netted off inside Total Amount.',
  },
  {
    column: 'Every charge column, across sources (discount, delivery, CGST, SGST, cess, excise, TCS, round-off)',
    reason:
      'These can only be totalled inside a single source (Discount not even on the PURCHASE block — '
      + 'see its note). A goods receipt can copy some or all of a bill’s charges onto the PURCHASE row '
      + 'as well as the GRN line, so the two blocks can state ONE payment twice: never add them '
      + 'together. A row booked straight from a PO usually carries no GST or cess of its own; for '
      + 'such a bill read its GRN rows.',
  },
  {
    column: 'Compensation Cess',
    reason:
      'Totalled on its own line and never folded into CGST + SGST. It is a separate levy on a '
      + 'different base — the gross line value, before discount, where GST is charged after it — '
      + 'so the two will not agree with each other’s rate arithmetic, and they are not meant to.',
  },
  {
    column: 'Total Amount and Grand Total (on PO rows)',
    reason:
      'Blank, not zero, in both. An order stores no charge columns at all — not even a '
      + 'discount — so an ordered line has a goods value and no bill amount, before or after tax, '
      + 'until the delivery is received and billed.',
  },
  {
    column: 'All three sources together',
    reason:
      'There is no grand total ACROSS the three sources, and there never will be. Receiving a PO usually writes a GRN line AND a '
      + 'purchase entry that mirrors it, so PURCHASE + GRN + PO counts those goods more than once. '
      + 'Spend = the PURCHASE totals, though a PURCHASE Grand Total may not match the bills (see the caveat). '
      + 'Use the Link key to see the same delivery on two rows.',
  },
  {
    column: 'Bill Grand Total',
    reason:
      'No total, on purpose. It is the grand total of the WHOLE bill a line sits on (Subtotal − '
      + 'discount + every tax and charge — the Purchase Bill Summary’s Grand Total for that bill), '
      + 'repeated on every line of that bill and on both the PURCHASE and the GRN row of one '
      + 'delivery, so adding the column down counts each bill once per line. For what the period’s '
      + 'bills come to, bill by bill, use Reports → Purchase Bill Summary (this log’s Grand Total '
      + 'adds only what each row records). Blank on PO lines: an order is not a bill. '
      + 'On a line with no invoice, GRN or bill number the “bill” is that vendor’s unnumbered '
      + 'purchases for the day, which the Bill Summary groups as one bill and which can span '
      + 'several vendor invoices.',
  },
];

export interface PurchaseLogTotals {
  /** Rows matching the filters BEFORE any truncation. */
  lines: number;
  /**
   * SPEND. This is the only figure that equals money booked against cost —
   * `purchases` is the table every cost report and the weighted-average price
   * read back. Do not add the two below to it.
   */
  purchase_value: number;
  /**
   * ORDERED, not spent. A commitment on purchase_order_items; the matching
   * spend, once received, is already inside purchase_value.
   */
  po_value: number;
  /**
   * BILLED at gross bill rates. The SAME money as the mirrored part of
   * purchase_value, restated as the vendor's document states it.
   */
  grn_value: number;
  // ── Additive detail (beyond the agreed four) — this is what makes the
  //    double-count arithmetic checkable instead of a claim in a header.
  purchase_lines: number;
  po_lines: number;
  grn_lines: number;
  /** Part of purchase_value that is a mirror of a GRN line (link_key set). */
  purchase_value_mirrored_from_grn: number;
  /** Part of purchase_value entered directly, with no GRN behind it. */
  purchase_value_direct: number;
  /**
   * Plain-English statement of what may and may not be added. Render this
   * verbatim next to any total; it is the guard against the one misreading
   * that matters.
   */
  basis: string;
  /**
   * The full money breakdown, PER SOURCE. `money.PURCHASE.goods_value` is the
   * same figure as `purchase_value` above (kept, so nothing that reads the old
   * shape breaks); everything else here is new. Always all three keys, so a
   * consumer can render a block per source without existence checks — a source
   * the filter excluded reads 0 lines / 0 goods value.
   */
  money: Record<PurchaseLogSource, PurchaseLogSourceMoney>;
  /** Why the columns that have no total have none. Render verbatim. */
  no_total_notes: PurchaseLogNoTotalNote[];
  /**
   * ⚠ Render verbatim, prominently, wherever GOODS VALUE, TOTAL AMOUNT or GRAND
   * TOTAL is shown — screen and CSV alike. Explains why GOODS VALUE on PURCHASE rows
   * is not reliably tax-exclusive (see the file header), then states the
   * LIVE figure for the window actually being viewed — computed once, here,
   * so every consumer shows the identical words and the identical number
   * instead of two hand-written copies drifting apart.
   */
  goods_value_caveat: string;
  /** How the rows' Bill Grand Total figures were proved — see PurchaseLogBillCheck. */
  bill_grand_total_check: PurchaseLogBillCheck;
}

export interface PurchaseLogResult {
  rows: PurchaseLogRow[];
  totals: PurchaseLogTotals;
  /** true when `lines` exceeded PURCHASE_LOG_MAX_ROWS and rows were capped. */
  truncated: boolean;
  from: string;
  to: string;
}

export interface PurchaseLogFilters {
  from?: string | null;
  to?: string | null;
  vendor?: string | null;
  material_id?: string | null;
  source?: PurchaseLogSourceFilter | null;
}

/**
 * Hard cap on returned rows. A silently truncated report is a wrong report, so
 * `truncated` is reported alongside and `totals` are computed by SQL aggregate
 * over the FULL filtered set — the cap never distorts a number.
 */
export const PURCHASE_LOG_MAX_ROWS = 50_000;

const TOTALS_BASIS =
  'PURCHASE = money booked (the spend). GRN = the same money restated at gross bill rates. '
  + 'PO = ordered, not spent. These three DO NOT add up — adding them counts the same goods more than once.';

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isYmd = (s: unknown): s is string => typeof s === 'string' && YMD.test(s);
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const nullNum = (v: unknown): number | null =>
  v === null || v === undefined ? null : (Number.isFinite(Number(v)) ? r2(Number(v)) : null);

/**
 * Calendar arithmetic on a YYYY-MM-DD string via UTC, deliberately.
 * `new Date('2026-08-02')` parses as UTC midnight and then renders in the
 * server's local zone, which lands on the previous day west of Greenwich —
 * that is how a "last 30 days" default silently becomes 29 or 31.
 */
function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/**
 * Resolve the requested window, defaulting to the last 30 days INCLUSIVE of
 * today in IST (today − 29 … today). Invalid or missing values fall back to
 * the default rather than throwing, and a reversed range is swapped — a report
 * that returns nothing because from > to looks identical to "no purchases".
 */
export function resolvePurchaseLogRange(
  from?: string | null,
  to?: string | null,
): { from: string; to: string } {
  const today = todayIST();
  let f = isYmd(from) ? from : addDaysYmd(today, -29);
  let t = isYmd(to) ? to : today;
  if (f > t) [f, t] = [t, f];
  return { from: f, to: t };
}

/**
 * Pull "GRN-yyyy-####" out of the tail SQL handed us (the substring of
 * purchases.notes starting at the first 'GRN-'). Anchored, so an unrelated note
 * that merely mentions GRN cannot fabricate a link.
 */
const GRN_TOKEN = /^(GRN-\d{4}-\d+)/;
function grnFromNoteTail(tail: unknown): string | null {
  const m = GRN_TOKEN.exec(String(tail || '').trim());
  return m ? m[1] : null;
}

/** null → 0, for the one place a charge is ADDED rather than reported. */
const n0 = (v: number | null | undefined): number => (v == null ? 0 : v);

/**
 * The per-line amount BEFORE tax — the TOTAL AMOUNT column (owner ruling 98):
 * value − discount. ONE definition, used for the row column and (as the
 * identical SQL expression in the aggregate) for the totals, so the footer
 * always foots the column it sits under. PO rows get null, as in
 * lineGrandTotal() below: an order has a goods value and no bill amount.
 */
function lineTotalAmount(r: {
  source: PurchaseLogSource; value: number; discount: number | null;
}): number | null {
  if (r.source === 'PO') return null;
  return r2(r.value - n0(r.discount));
}

/**
 * The per-line bill figure — the GRAND TOTAL column (this log's "Total Amount"
 * until ruling 98). ONE definition, used for the row column and (as the
 * identical SQL expression in the aggregate) for the totals, so the footer
 * always foots the column it sits under.
 *
 * Identical in shape to /api/grn's register formula, /api/purchases' total and
 * the Purchases page's line total — this report must reconcile with all three.
 * PO rows get null: purchase_order_items carries no charge columns, so an order
 * has a goods value and no bill amount.
 */
function lineGrandTotal(r: {
  source: PurchaseLogSource; value: number;
  discount: number | null; cgst: number | null; sgst: number | null;
  special_excise_cess: number | null; compensation_cess: number | null;
  tcs: number | null; delivery_charges: number | null; mrp_round_off: number | null;
}): number | null {
  if (r.source === 'PO') return null;
  return r2(
    r.value - n0(r.discount) + n0(r.cgst) + n0(r.sgst)
    + n0(r.special_excise_cess) + n0(r.compensation_cess)
    + n0(r.tcs) + n0(r.delivery_charges) + n0(r.mrp_round_off),
  );
}

/** A source with nothing in it. Zero lines and zero goods — never a fake total. */
function emptyMoney(source: PurchaseLogSource): PurchaseLogSourceMoney {
  const noCharges = source === 'PO';
  return {
    source,
    lines: 0,
    goods_value: 0,
    // PURCHASE refuses a discount total by basis, PO by having no column at all.
    discount: source === 'PURCHASE' || noCharges ? null : 0,
    discount_netted: 0,
    cgst: noCharges ? null : 0,
    sgst: noCharges ? null : 0,
    tax_cgst_sgst: noCharges ? null : 0,
    special_excise_cess: noCharges ? null : 0,
    compensation_cess: noCharges ? null : 0,
    tcs: noCharges ? null : 0,
    delivery_charges: noCharges ? null : 0,
    mrp_round_off: noCharges ? null : 0,
    other_charges: noCharges ? null : 0,
    total_amount: noCharges ? null : 0,
    bill_amount: noCharges ? null : 0,
    goods_value_tax_suspect: 0,
    goods_value_tax_suspect_lines: 0,
    // Zero lines carried GST because there are zero lines. The percentage
    // renders as an em dash off a 0 base — never 0%.
    taxed_bill_value: 0,
    taxed_lines: 0,
    gst_value: noCharges ? null : 0,
    gst_taxed_bill_value: 0,
    gst_taxed_lines: 0,
    gst_from_grn_lines: 0,
    gst_base_accepted_lines: 0,
  };
}

/**
 * The static half of PurchaseLogTotals.goods_value_caveat — the explanation,
 * unchanging across every request. See the file header for the measurement
 * behind each sentence. Kept short enough to sit as one on-screen banner and
 * one CSV caption row without wrapping into an essay.
 */
const GOODS_VALUE_CAVEAT_HEADLINE =
  'GOODS VALUE is NOT reliably tax-exclusive on PURCHASE rows. On some rows dated April 2026, from '
  + 'an old bulk import, the column this report reads as "goods value" holds the vendor’s line total, '
  + 'which can include tax and charges, with no split recorded. On those rows GOODS VALUE, TOTAL '
  + 'AMOUNT and GRAND TOTAL print the IDENTICAL number, so do not treat GOODS VALUE or TOTAL AMOUNT '
  + 'as pre-tax spend without checking further. '
  + 'Separately, some PURCHASE rows created by a goods receipt do not record all of the bill’s '
  + 'discount, GST and charges (usually rows booked straight from a PO, whose GST sits on the GRN '
  + 'line, and older receipt rows), so their TOTAL AMOUNT and GRAND TOTAL can differ from the bill, '
  + 'the GRAND TOTAL usually reading LOW; for those deliveries read the GRN rows. Older rows have '
  + 'not been corrected in bulk. This is a data problem, disclosed here, not fixed here.';

/**
 * The live half — how much of THIS filtered window is affected, not just that
 * the problem exists somewhere in the table. `0 affected lines` is reported
 * honestly too: it means this window happens to be clean, not that the wider
 * table is.
 */
function goodsValueCaveatDetail(m: PurchaseLogSourceMoney): string {
  if (m.lines === 0) return 'No PURCHASE lines in this view (these dates and filters).';
  const plural = m.lines === 1 ? '' : 's';
  if (m.goods_value_tax_suspect_lines === 0) {
    return `In THIS view (these dates and filters), GOODS VALUE = quantity × rate, to the paisa, on every PURCHASE line (${m.lines} line${plural}), `
      + 'so this check finds no sign of the import problem here.';
  }
  const amt = m.goods_value_tax_suspect.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lp = m.goods_value_tax_suspect_lines === 1 ? '' : 's';
  // `amt` is the NET difference over every PURCHASE line in the view, not the
  // flagged lines' own figure, and it can be negative — hence "over the whole
  // view" and "minus", never "by Rs X on those lines".
  return `In THIS view (these dates and filters), GOODS VALUE differs from quantity × rate on ${m.goods_value_tax_suspect_lines} PURCHASE line${lp} `
    + `out of ${m.lines}. Over the whole view, GOODS VALUE minus quantity × rate comes to Rs ${amt} `
    + '(tax, charges or rate rounding), and that difference is inside TOTAL AMOUNT and GRAND TOTAL too.';
}

// ─────────────────────────────────────────────────────────────────────────────
// The query
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every branch of the UNION must project the SAME columns in the SAME order —
 * SQLite matches compound SELECTs positionally, so a column added to one branch
 * and not the others silently shifts every value to its right.
 *
 * SHAPE / EFFICIENCY. One compound SELECT, wrapped once for the ordered+capped
 * row fetch and once for the GROUP BY totals. Each branch is driven by its
 * table's indexed date column (idx_purchases_date, idx_po_date, idx_grn_date),
 * so the range — not the table size — bounds the scan. The only lookups that
 * are not a plain index seek are two CORRELATED SCALAR subqueries on the PO and
 * GRN branches; both start from idx_po_vendor_bills_po / idx_grn_po, i.e. the
 * handful of bills or GRNs belonging to ONE po_id, then idx_grni_grn inside it.
 * That keeps them O(receipts-of-this-PO) per row instead of the full scan a
 * LEFT JOIN on the unindexed goods_receipt_note_items.po_item_id would cost —
 * and, being scalar, they cannot fan a PO line into one row per GRN the way a
 * multi-vendor PO would with a join.
 */
function buildUnion(f: {
  from: string; to: string; vendor: string; materialId: string; source: PurchaseLogSourceFilter;
  /** po_vendor_closures exists here (merged-PO short-close). Optional: a
   *  database that has not booted that migration reads exactly as before. */
  closures?: boolean;
}): { sql: string; params: any[] } {
  const parts: string[] = [];
  const params: any[] = [];
  const want = (s: PurchaseLogSourceFilter) => f.source === 'all' || f.source === s;

  // Shared fragments. Bound per-branch (each takes its own copy of the params).
  const matFilter = (col: string) => (f.materialId ? ` AND ${col} = ?` : '');
  // CONTAINS, not equality. The filter on screen is a free-text box with a
  // datalist, and a datalist constrains nothing — typing "Metro" against a
  // stored "Metro Cash & Carry Pvt Ltd" matched zero rows and the page rendered
  // three Rs 0 totals. A silent wrong answer is worse than an error, and worse
  // than a slightly loose match.
  const venFilter = (expr: string) => (f.vendor ? ` AND LOWER(TRIM(${expr})) LIKE '%' || LOWER(TRIM(?)) || '%'` : '');

  // ── PURCHASE ──────────────────────────────────────────────────────────────
  if (want('purchase')) {
    parts.push(`
      SELECT
        'PURCHASE'                                        AS source,
        3                                                 AS source_rank,
        p.id                                              AS row_id,
        COALESCE(p.material_id, '')                       AS material_id,
        p.date                                            AS date,
        -- DO NOT add p.invoice_number back as a fallback here. That column is
        -- NOT part of this schema: CREATE TABLE purchases never declares it
        -- and no ALTER adds it, unlike the eight columns that are migrated at
        -- db.ts:2134-2155. Databases that happen to carry it got it out of band,
        -- and it is empty in every row even there — so referencing it bought
        -- nothing and made this whole report a hard 500 ("no such column:
        -- p.invoice_number") on any database without it. The vendor's own
        -- number lives in p.bill_no; ours is p.invoice_id.
        COALESCE(NULLIF(TRIM(p.invoice_id), ''),
                 NULLIF(TRIM(p.bill_no), ''), '')         AS doc_no,
        COALESCE(TRIM(p.invoice_id), '')                  AS invoice_id,
        COALESCE(TRIM(p.bill_no), '')                     AS bill_no,
        COALESCE(TRIM(p.vendor), '')                      AS vendor,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        p.quantity                                        AS qty,
        COALESCE(NULLIF(rm.purchase_unit, ''), rm.unit, '') AS purchase_unit,
        p.unit_price                                      AS rate,
        COALESCE(p.total_price, p.quantity * p.unit_price) AS value,
        NULL                                              AS qty_rejected,
        -- ALIASED EXPLICITLY, all eight. The totals aggregate below reads these
        -- names from OUTSIDE this subquery (SUM(discount), SUM(cgst), and so
        -- on), and a bare p.discount leaves the projected name to SQLite's
        -- short_column_names setting rather than to this file. Naming them here
        -- makes the charge totals independent of a compile-time pragma.
        -- NOTE: no backticks anywhere inside this SQL — the whole statement is a
        -- JS template literal, so one would end the string mid-query.
        p.discount AS discount, p.cgst AS cgst, p.sgst AS sgst,
        p.special_excise_cess AS special_excise_cess,
        -- GST compensation cess. A DIFFERENT levy from special_excise_cess
        -- (which is TGBCL's) and deliberately outside the cgst + sgst pair —
        -- it is never split into halves and must not be folded into the GST
        -- figure a return is filed on. Recorded-only, like its 7 siblings.
        p.compensation_cess AS compensation_cess,
        p.tcs AS tcs, p.delivery_charges AS delivery_charges,
        p.mrp_round_off AS mrp_round_off,
        -- THE BILL DOCUMENT'S GST, for the Tax Value / Tax % columns only
        -- (owner #5, ruling 93). A PO receive records the GST on the GRN line
        -- and leaves this purchases row's cgst/sgst at 0, so the eight columns
        -- above say "no tax" on a bill that carried 18%. These four read the
        -- GRN line for exactly those rows and the row itself for every other
        -- — the imported effective rail, the same expressions the Purchase
        -- Report Summary sums — so the tax column equals that report. The eight
        -- recorded columns above, Total Amount and every total built on them
        -- are untouched. Same position in all three branches (UNION is
        -- positional).
        ${effectiveChargeSql('cgst', 'p', 'gl')}           AS doc_cgst,
        ${effectiveChargeSql('sgst', 'p', 'gl')}           AS doc_sgst,
        ${effectiveChargeSql('discount', 'p', 'gl')}       AS doc_discount,
        -- The Tax % BASE, not the subtotal: the value GST was charged on
        -- (src/lib/purchase-gst-base.ts). Equal to effectiveBillValueSql() on
        -- every line that rejected nothing; the ACCEPTED value on a PO receipt
        -- part-rejected at the door — the base the GRN branch below uses.
        ${gstChargedValueSql('p', 'gl')}                   AS doc_bill_value,
        ${grnSourcedSql('gl')}                             AS doc_from_grn,
        ${gstBaseAcceptedSql('p', 'gl')}                   AS doc_base_accepted,
        -- A PO-receipt cost mirror whose GRN line is GONE: its own cgst/sgst
        -- are the receive route's placeholder 0, so the tax cells are blank —
        -- and the hover must say "unavailable", not "no GST was entered".
        CASE WHEN ${poReceiptMirrorSql('p')} = 1 AND gl.purchase_id IS NULL
             THEN 1 ELSE 0 END                             AS doc_unpaired,
        -- Tail of the note starting at the GRN number, if any. The regex that
        -- turns this into a link_key lives in JS; SQLite has no REGEXP here.
        CASE WHEN instr(COALESCE(p.notes, ''), 'GRN-') > 0
             THEN substr(p.notes, instr(p.notes, 'GRN-'))
             ELSE '' END                                  AS link_raw,
        -- MUST agree with grnFromNoteTail()'s anchored /^GRN-\d{4}-\d+/ regex.
        -- A bare instr(notes,'GRN-') also matched a free-text note that merely
        -- mentions a GRN, so a purchase counted as "mirrored from a GRN" while
        -- link_key stayed null — money moved between
        -- purchase_value_mirrored_from_grn and _direct with nothing tying it to
        -- a receipt. GLOB gives the same digit-shape test SQLite-side.
        CASE WHEN COALESCE(p.notes, '') GLOB '*GRN-[0-9][0-9][0-9][0-9]-[0-9]*'
             THEN 1 ELSE 0 END AS is_mirror,
        COALESCE(p.notes, '')                             AS notes
      FROM purchases p
      LEFT JOIN raw_materials rm ON rm.id = p.material_id
      -- The paired GRN line (grn_line CTE — every statement over this union is
      -- wrapped in withGrnCharges). Cannot fan out: one GRN line per row at most.
      ${grnLineJoinSql('p', 'gl')}
      WHERE p.date >= ? AND p.date <= ?${venFilter('p.vendor')}${matFilter('p.material_id')}
    `);
    params.push(f.from, f.to);
    if (f.vendor) params.push(f.vendor);
    if (f.materialId) params.push(f.materialId);
  }

  // ── GRN ───────────────────────────────────────────────────────────────────
  if (want('grn')) {
    parts.push(`
      SELECT
        'GRN'                                             AS source,
        2                                                 AS source_rank,
        gi.id                                             AS row_id,
        COALESCE(gi.material_id, '')                      AS material_id,
        g.date                                            AS date,
        g.grn_number                                      AS doc_no,
        ''                                                AS invoice_id,
        -- The GRN header carries the bill number on both writers; po_vendor_bills
        -- is the fallback for older PO receives that left invoice_number blank.
        -- THIS GRN'S OWN bill row first (po_vendor_bills.grn_id, the hard link),
        -- and only then the vendor's first bill on the PO: a vendor that
        -- delivers one PO on two bills has two rows, and "the first one" named
        -- the wrong bill for the second delivery. With one bill per vendor per
        -- PO (every PO before the merged PO) both pick the same row.
        COALESCE(NULLIF(TRIM(g.invoice_number), ''),
                 (SELECT TRIM(b.bill_no) FROM po_vendor_bills b
                   WHERE b.grn_id = g.id
                   ORDER BY b.created_at LIMIT 1),
                 (SELECT TRIM(b.bill_no) FROM po_vendor_bills b
                   WHERE b.po_id = g.po_id
                     AND LOWER(TRIM(b.vendor_name)) = LOWER(TRIM(COALESCE(g.vendor, '')))
                   ORDER BY b.created_at LIMIT 1), '')    AS bill_no,
        COALESCE(TRIM(g.vendor), '')                      AS vendor,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        -- ACCEPTED, not received: this is the qty that became stock and became
        -- the mirrored purchases row, so qty × rate = value holds.
        gi.quantity_accepted                              AS qty,
        COALESCE(NULLIF(rm.purchase_unit, ''), rm.unit, '') AS purchase_unit,
        gi.unit_price                                     AS rate,
        ROUND(gi.quantity_accepted * gi.unit_price, 2)    AS value,
        gi.quantity_rejected                              AS qty_rejected,
        -- Aliased for the same reason as the PURCHASE branch: the totals
        -- aggregate SUMs these by name from outside the subquery.
        gi.discount AS discount, gi.cgst AS cgst, gi.sgst AS sgst,
        gi.special_excise_cess AS special_excise_cess,
        -- GST compensation cess, now REAL on this branch: the GRN item carries
        -- its own compensation_cess column and PO Receive / ad-hoc GRN book the
        -- levy onto the GRN line (the bill document), not onto the tax-free
        -- purchases mirror. Reporting NULL here printed a blank for a cess
        -- that was actually levied and stored.
        -- ITS BASE IS NOT THE GST BASE, and the two sit side by side on this
        -- row: gi.cgst/gi.sgst are charged on the line value AFTER discount,
        -- gi.compensation_cess on the GROSS line value BEFORE it. They will not
        -- agree with each other's rate arithmetic and are not meant to.
        -- Aliased explicitly — with ?source=grn this branch is the FIRST of the
        -- compound SELECT and its names become the outer SELECT *'s names.
        gi.compensation_cess AS compensation_cess,
        gi.tcs AS tcs, gi.delivery_charges AS delivery_charges,
        gi.mrp_round_off AS mrp_round_off,
        -- The bill document's GST: a GRN line IS the document, so its own
        -- figures, on its own value — exactly what this row always showed.
        gi.cgst                                           AS doc_cgst,
        gi.sgst                                           AS doc_sgst,
        gi.discount                                       AS doc_discount,
        ROUND(gi.quantity_accepted * gi.unit_price, 2)    AS doc_bill_value,
        0                                                 AS doc_from_grn,
        -- Its Value IS the accepted value already, so nothing is re-based.
        0                                                 AS doc_base_accepted,
        0                                                 AS doc_unpaired,
        g.grn_number                                      AS link_raw,
        0                                                 AS is_mirror,
        COALESCE(NULLIF(TRIM(gi.notes), ''), TRIM(COALESCE(g.notes, ''))) AS notes
      FROM goods_receipt_note_items gi
      JOIN goods_receipt_notes g ON g.id = gi.grn_id
      LEFT JOIN raw_materials rm ON rm.id = gi.material_id
      WHERE g.date >= ? AND g.date <= ?
        -- A VOIDED bill is money that was NOT spent. Voiding a GRN reverses the
        -- stock it added and DELETES its purchases rows, so it already leaves
        -- the PURCHASE branch on its own — but its goods_receipt_note_items are
        -- kept (they are the document) and this branch reads them, so the same
        -- delivery counted on one rail and not the other. That gave two answers
        -- for one bill on the GOODS VALUE vs TOTAL AMOUNT split, and made the
        -- GRN↔PURCHASE reconciliation report it as billed-but-never-booked,
        -- which is indistinguishable from a genuine missing-cost-row defect.
        -- Stronger than the PO branch's own exclusion below: a cancelled order
        -- was never received, a voided GRN was received and then undone.
        --
        -- 'awaiting_qc' IS EXCLUDED FOR THE SAME REASON, AND IT IS NOT OPTIONAL.
        -- A GRN held for a kitchen quality check (src/lib/grn-qc.ts) carries
        -- quantity_accepted = 0 on every line — the ABSENCE of a decision, not a
        -- rejection — while its cgst / sgst / cess / tcs / delivery_charges are
        -- stored in full, because the store may not pre-reject a gated line. So
        -- the row valued GOODS VALUE at ₹0 and still summed the whole bill's tax
        -- into TOTAL AMOUNT: a ₹4,000 delivery at 5% with ₹200 delivery reported
        -- ₹0 of goods carrying ₹400 of charges, and NEGATIVE with a bill
        -- discount. The report's own integrity check cannot catch it either —
        -- goods_value_tax_suspect compares value against qty × rate, and 0 − 0×r
        -- is 0, so the guard stays silent on the one shape it should shout at.
        -- Excluding it also keeps the two rails AGREEING: a held GRN has no
        -- purchases row yet, so leaving it on this branch alone reported the
        -- delivery as billed-but-never-booked, which is indistinguishable from a
        -- genuine missing-cost-row defect. It appears here in full the moment the
        -- kitchen signs, dated the delivery day — see the hand-over note about a
        -- bill landing inside a period that may already have been downloaded.
        AND COALESCE(g.status, '') NOT IN ('void', 'awaiting_qc')
        ${venFilter('g.vendor')}${matFilter('gi.material_id')}
    `);
    params.push(f.from, f.to);
    if (f.vendor) params.push(f.vendor);
    if (f.materialId) params.push(f.materialId);
  }

  // ── PO ────────────────────────────────────────────────────────────────────
  if (want('po')) {
    // '' (nothing appended) unless the closures table exists AND this line's
    // vendor was closed on this PO AND the line was never received.
    const closedNote = f.closures
      ? `COALESCE((SELECT ' · not delivered (vendor closed'
                        || CASE WHEN TRIM(COALESCE(c.reason, '')) <> ''
                                THEN ': ' || TRIM(c.reason) ELSE '' END || ')'
                     FROM po_vendor_closures c
                    WHERE c.po_id = po.id
                      AND c.vendor_id = COALESCE(NULLIF(TRIM(poi.vendor_id), ''), po.vendor_id)
                      AND NOT EXISTS (SELECT 1 FROM goods_receipt_note_items gi7
                                        ${claimJoin({ grn: 'g7', item: 'gi7', poIdCol: 'po.id' })}
                                       WHERE gi7.po_item_id = poi.id)
                    ORDER BY c.closed_at DESC LIMIT 1), '')`
      : `''`;
    parts.push(`
      SELECT
        'PO'                                              AS source,
        1                                                 AS source_rank,
        poi.id                                            AS row_id,
        COALESCE(poi.material_id, '')                     AS material_id,
        po.date                                           AS date,
        po.po_number                                      AS doc_no,
        ''                                                AS invoice_id,
        -- THE BILL THIS ORDERED LINE ARRIVED ON — the bill of the SAME receipt
        -- link_raw below names (same claimJoin, same ORDER BY g.date), so the
        -- row cannot say "bill 1" while its link_key points at the receipt of
        -- bill 2. That is exactly what the vendor's FIRST bill on the PO did
        -- once one vendor delivered a (merged) PO on two bills.
        --   claimed line   → that receipt's bill row (po_vendor_bills.grn_id),
        --                    else its invoice_number, else the old answer;
        --   unclaimed line on a PO that HAS claimed lines → '' (it has not
        --                    arrived, so no bill carried it);
        --   a PO with no claimed line at all → the old answer (the vendor's
        --                    first bill row), which keeps a legacy receipt
        --                    whose GRN lines never carried po_item_id reading
        --                    as before.
        -- A single-vendor PO received on one bill reads the same row either way.
        COALESCE(
          (SELECT COALESCE((SELECT TRIM(b4.bill_no) FROM po_vendor_bills b4
                             WHERE b4.grn_id = g4.id
                             ORDER BY b4.created_at LIMIT 1),
                           NULLIF(TRIM(g4.invoice_number), ''))
             FROM goods_receipt_note_items gi4
             ${claimJoin({ grn: 'g4', item: 'gi4', poIdCol: 'po.id' })}
            WHERE gi4.po_item_id = poi.id
            ORDER BY g4.date LIMIT 1),
          CASE WHEN EXISTS (SELECT 1 FROM goods_receipt_note_items gi5
                              ${claimJoin({ grn: 'g5', item: 'gi5', poIdCol: 'po.id' })}
                             WHERE gi5.po_item_id IS NOT NULL AND TRIM(gi5.po_item_id) <> '')
               AND NOT EXISTS (SELECT 1 FROM goods_receipt_note_items gi6
                                 ${claimJoin({ grn: 'g6', item: 'gi6', poIdCol: 'po.id' })}
                                WHERE gi6.po_item_id = poi.id)
               THEN '' END,
          (SELECT TRIM(b.bill_no) FROM po_vendor_bills b
                   WHERE b.po_id = po.id
                     AND LOWER(TRIM(b.vendor_name)) =
                         LOWER(TRIM(COALESCE(NULLIF(TRIM(poi.vendor), ''), po.vendor, '')))
                   ORDER BY b.created_at LIMIT 1), '')    AS bill_no,
        COALESCE(NULLIF(TRIM(poi.vendor), ''), TRIM(COALESCE(po.vendor, '')), '') AS vendor,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        poi.quantity                                      AS qty,
        COALESCE(NULLIF(rm.purchase_unit, ''), rm.unit, '') AS purchase_unit,
        poi.unit_price                                    AS rate,
        COALESCE(poi.total_price, poi.quantity * poi.unit_price) AS value,
        NULL                                              AS qty_rejected,
        -- purchase_order_items has NO charge columns. NULL, not 0: an order
        -- carries no bill charges, it is not "a bill with zero charges".
        -- Aliased explicitly — with ?source=po this branch is the FIRST of the
        -- compound SELECT and its names become the outer SELECT *'s names.
        NULL AS discount, NULL AS cgst, NULL AS sgst,
        NULL AS special_excise_cess, NULL AS compensation_cess, NULL AS tcs,
        NULL AS delivery_charges, NULL AS mrp_round_off,
        -- No bill document behind an order: no GST, blank (never 0).
        NULL AS doc_cgst, NULL AS doc_sgst, NULL AS doc_discount,
        NULL AS doc_bill_value, 0 AS doc_from_grn, 0 AS doc_base_accepted, 0 AS doc_unpaired,
        -- The GRN this ordered line was received on, via po_item_id. NULL until
        -- it is received (or when the receipt fell outside this date window).
        --
        -- THROUGH claimJoin(), WHICH IS THE POINT. This was the eighth copy of
        -- the PO↔GRN claim derivation and the only one left unfiltered after
        -- src/lib/po-receipts.ts collected the rest. A voided GRN keeps its line
        -- rows, and the ORDER BY ... LIMIT 1 below picks the OLDEST — which after
        -- a void-and-re-receive is ALWAYS the voided one. Measured: a PO line
        -- voided on GRN-2026-0001 and re-received as GRN-2026-0030 reported
        -- GRN-2026-0001, a bill the GRN branch above already excludes, so the
        -- ordered line was grouped with a receipt event that has no other rows
        -- and separated from the delivery it actually arrived on. link_raw
        -- becomes link_key below and is the report's whole reconciliation
        -- promise. Money was never affected — the PO branch's value column is
        -- the ORDERED value — but the link was pointing at a dead row.
        COALESCE((SELECT g2.grn_number
                    FROM goods_receipt_note_items gi2
                    ${claimJoin({ grn: 'g2', item: 'gi2', poIdCol: 'po.id' })}
                   WHERE gi2.po_item_id = poi.id
                   ORDER BY g2.date LIMIT 1), '')         AS link_raw,
        0                                                 AS is_mirror,
        -- Status is stamped in because a PO row is a COMMITMENT, and whether it
        -- is still pending or already received changes what the line means.
        -- A vendor SHORT-CLOSED on a merged PO (po_vendor_closures) leaves its
        -- undelivered lines here at their ordered value, exactly as a short
        -- delivery's balance stays on the order today (owner's default, ruling
        -- 70) — but the row must not read as a live commitment, so it says so.
        TRIM('PO ' || COALESCE(po.status, '')
             || ${closedNote}
             || CASE WHEN TRIM(COALESCE(poi.notes, '')) <> ''
                     THEN ' · ' || TRIM(poi.notes) ELSE '' END) AS notes
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.po_id
      LEFT JOIN raw_materials rm ON rm.id = poi.material_id
      WHERE po.date >= ? AND po.date <= ?
        -- A draft was never placed; a cancelled/rejected order will never be
        -- spend. Including them would inflate po_value with money nobody owes.
        AND COALESCE(po.status, '') NOT IN ('draft', 'cancelled', 'rejected')
        ${venFilter("COALESCE(NULLIF(TRIM(poi.vendor), ''), po.vendor, '')")}${matFilter('poi.material_id')}
    `);
    params.push(f.from, f.to);
    if (f.vendor) params.push(f.vendor);
    if (f.materialId) params.push(f.materialId);
  }

  return { sql: parts.join('\nUNION ALL\n'), params };
}

/**
 * Build the purchase log for a date range.
 *
 * Caller (the route) is responsible for the management gate — this is a pure
 * query layer and applies no authorisation of its own.
 */
export function getPurchaseLog(
  filters: PurchaseLogFilters = {},
  dbArg?: DatabaseT.Database,
): PurchaseLogResult {
  const db = dbArg || getDb();
  const { from, to } = resolvePurchaseLogRange(filters.from, filters.to);
  const vendor = String(filters.vendor || '').trim();
  const materialId = String(filters.material_id || '').trim();
  const rawSource = String(filters.source || 'all').toLowerCase();
  const source: PurchaseLogSourceFilter =
    rawSource === 'purchase' || rawSource === 'po' || rawSource === 'grn'
      ? (rawSource as PurchaseLogSourceFilter)
      : 'all';

  let closures = false;
  try {
    closures = !!db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'po_vendor_closures'`,
    ).get();
  } catch { closures = false; }
  const { sql: union, params } = buildUnion({ from, to, vendor, materialId, source, closures });

  const empty: PurchaseLogTotals = {
    lines: 0, purchase_value: 0, po_value: 0, grn_value: 0,
    purchase_lines: 0, po_lines: 0, grn_lines: 0,
    purchase_value_mirrored_from_grn: 0, purchase_value_direct: 0,
    basis: TOTALS_BASIS,
    money: {
      PURCHASE: emptyMoney('PURCHASE'),
      GRN: emptyMoney('GRN'),
      PO: emptyMoney('PO'),
    },
    no_total_notes: PURCHASE_LOG_NO_TOTAL_NOTES,
    goods_value_caveat: `${GOODS_VALUE_CAVEAT_HEADLINE} ${goodsValueCaveatDetail(emptyMoney('PURCHASE'))}`,
    bill_grand_total_check: { bills: 0, matched: 0, unverified: 0, mismatched: 0, understated: 0, understated_bills: [] },
  };
  // buildUnion returns '' only if `source` matched nothing, which the
  // normalisation above makes impossible — but an empty compound SELECT is a
  // syntax error, so never hand one to SQLite.
  if (!union) return { rows: [], totals: empty, truncated: false, from, to };

  // ── TOTALS FIRST, over the FULL filtered set ──────────────────────────────
  // Computed by the database, not by summing the (possibly capped) rows, so the
  // cap can never quietly understate the spend.
  // `total_amount` and `bill_amount` are each SUM(<the per-row expression>),
  // not a combination of the column sums, so each is the same arithmetic in the
  // same order as lineTotalAmount() / lineGrandTotal() do per row (the Total
  // Amount and Grand Total columns). Anything else and the footer stops footing
  // the column above it by a paisa or two, which is exactly the kind of drift
  // that makes an owner distrust the whole report.
  // withGrnCharges: the PURCHASE branch LEFT JOINs the grn_line CTE (for the
  // doc_* tax columns), so every statement over the union carries the CTE. A
  // statement whose union has no PURCHASE branch simply never reads it.
  const agg = db.prepare(withGrnCharges(`
    SELECT source,
           COUNT(*)                                                  AS lines,
           COALESCE(SUM(value), 0)                                   AS value,
           COALESCE(SUM(CASE WHEN is_mirror = 1 THEN value ELSE 0 END), 0) AS mirrored,
           COALESCE(SUM(discount), 0)                                AS discount,
           COALESCE(SUM(cgst), 0)                                    AS cgst,
           COALESCE(SUM(sgst), 0)                                    AS sgst,
           COALESCE(SUM(special_excise_cess), 0)                     AS special_excise_cess,
           COALESCE(SUM(compensation_cess), 0)                       AS compensation_cess,
           COALESCE(SUM(tcs), 0)                                     AS tcs,
           COALESCE(SUM(delivery_charges), 0)                        AS delivery_charges,
           COALESCE(SUM(mrp_round_off), 0)                           AS mrp_round_off,
           COALESCE(SUM(
             COALESCE(value, 0) - COALESCE(discount, 0)
           ), 0)                                                     AS total_amount,
           COALESCE(SUM(
             COALESCE(value, 0) - COALESCE(discount, 0)
             + COALESCE(cgst, 0) + COALESCE(sgst, 0)
             + COALESCE(special_excise_cess, 0) + COALESCE(compensation_cess, 0)
             + COALESCE(tcs, 0) + COALESCE(delivery_charges, 0)
             + COALESCE(mrp_round_off, 0)
           ), 0)                                                     AS bill_amount,
           -- The GOODS VALUE integrity check (see the file header's
           -- GOODS VALUE section): value is SUPPOSED to equal qty x rate
           -- on every branch. qty_rate_value is that expectation, computed
           -- independently of whatever value actually holds, so the gap
           -- between the two columns is measured rather than assumed.
           COALESCE(SUM(COALESCE(qty, 0) * COALESCE(rate, 0)), 0)        AS qty_rate_value,
           COALESCE(SUM(CASE
             WHEN ROUND(COALESCE(value, 0) - COALESCE(qty, 0) * COALESCE(rate, 0), 2) <> 0
             THEN 1 ELSE 0 END), 0)                                  AS value_mismatch_lines,
           -- THE "Tax % Applied (GST)" BASE for a source's footer row: the
           -- post-discount value of the lines that CARRIED GST, and how many
           -- lines that was. Not SUM(value) − SUM(discount): 2,158 of the 2,165
           -- purchase lines record no GST at all, so a rate over the whole
           -- source would print 0.01% for an 18% bill. GST is charged on the
           -- line value AFTER discount — measured exactly 18.00 / 12.00 on all
           -- 29 tax-bearing GRN lines on that base and 16.2 / 11.2 on the gross
           -- one, which is why the discount is subtracted here.
           ${taxAppliedSumsSql(
             'COALESCE(cgst, 0) + COALESCE(sgst, 0)',
             'COALESCE(value, 0) - COALESCE(discount, 0)',
           )}
    FROM (${union})
    GROUP BY source
  `)).all(...params) as Array<Record<string, number> & { source: string }>;

  // ── THE TAX VALUE (GST) / TAX % APPLIED (GST) TOTALS, per source ──────────
  // Over the bill DOCUMENT's GST (the doc_* columns), the figure the two tax
  // columns print per row — so each footer foots its own column. A separate
  // statement because taxAppliedSumsSql() names its outputs taxed_bill_value /
  // taxed_lines, which the recorded-rail aggregate above already uses; one
  // formula, imported, never re-typed under a second alias.
  const docAgg = db.prepare(withGrnCharges(`
    SELECT source,
           COALESCE(SUM(COALESCE(doc_cgst, 0) + COALESCE(doc_sgst, 0)), 0) AS doc_gst,
           COALESCE(SUM(CASE WHEN doc_from_grn = 1 THEN 1 ELSE 0 END), 0)  AS doc_from_grn_lines,
           -- GST-bearing lines whose base is the ACCEPTED value (a PO receipt
           -- part-rejected at the door) — the only lines on which this rate
           -- and the Purchase Report Summary's part company. Drives the note.
           COALESCE(SUM(CASE WHEN doc_base_accepted = 1
                              AND COALESCE(doc_cgst, 0) + COALESCE(doc_sgst, 0) > 0
                             THEN 1 ELSE 0 END), 0)                    AS doc_base_accepted_lines,
           ${taxAppliedSumsSql(
             'COALESCE(doc_cgst, 0) + COALESCE(doc_sgst, 0)',
             'COALESCE(doc_bill_value, 0) - COALESCE(doc_discount, 0)',
           )}
    FROM (${union})
    GROUP BY source
  `)).all(...params) as Array<Record<string, number> & { source: string }>;
  const docBySource = new Map(docAgg.map(d => [String(d.source), d]));

  const totals: PurchaseLogTotals = {
    ...empty,
    money: {
      PURCHASE: emptyMoney('PURCHASE'),
      GRN: emptyMoney('GRN'),
      PO: emptyMoney('PO'),
    },
  };
  for (const a of agg) {
    if (a.source === 'PURCHASE') {
      totals.purchase_lines = num(a.lines);
      totals.purchase_value = r2(a.value);
      totals.purchase_value_mirrored_from_grn = r2(a.mirrored);
      totals.purchase_value_direct = r2(num(a.value) - num(a.mirrored));
    } else if (a.source === 'PO') {
      totals.po_lines = num(a.lines);
      totals.po_value = r2(a.value);
    } else if (a.source === 'GRN') {
      totals.grn_lines = num(a.lines);
      totals.grn_value = r2(a.value);
    }
    totals.lines += num(a.lines);

    const src = a.source as PurchaseLogSource;
    if (src !== 'PURCHASE' && src !== 'GRN' && src !== 'PO') continue;
    // PO has no charge columns anywhere in its branch (they are bound NULL),
    // so its whole charge block stays null — a 0 would read as "this order
    // carries no tax", which nobody has established yet.
    const noCharges = src === 'PO';
    const other = r2(
      num(a.special_excise_cess) + num(a.compensation_cess)
      + num(a.tcs) + num(a.delivery_charges) + num(a.mrp_round_off),
    );
    totals.money[src] = {
      source: src,
      lines: num(a.lines),
      goods_value: r2(a.value),
      // Refused on PURCHASE by basis (see PURCHASE_LOG_NO_TOTAL_NOTES), refused
      // on PO for want of a column. Real, and one basis, on GRN.
      discount: src === 'GRN' ? r2(a.discount) : null,
      discount_netted: r2(a.discount),
      cgst: noCharges ? null : r2(a.cgst),
      sgst: noCharges ? null : r2(a.sgst),
      tax_cgst_sgst: noCharges ? null : r2(num(a.cgst) + num(a.sgst)),
      special_excise_cess: noCharges ? null : r2(a.special_excise_cess),
      compensation_cess: noCharges ? null : r2(a.compensation_cess),
      tcs: noCharges ? null : r2(a.tcs),
      delivery_charges: noCharges ? null : r2(a.delivery_charges),
      mrp_round_off: noCharges ? null : r2(a.mrp_round_off),
      other_charges: noCharges ? null : other,
      total_amount: noCharges ? null : r2(a.total_amount),
      bill_amount: noCharges ? null : r2(a.bill_amount),
      // Independent of noCharges: this checks `value` against the line's own
      // qty × rate, which is meaningful on every source, not only the ones
      // with charge columns.
      goods_value_tax_suspect: r2(num(a.value) - num(a.qty_rate_value)),
      goods_value_tax_suspect_lines: num(a.value_mismatch_lines),
      // Independent of noCharges as well: on PO the SQL's CASE never fires (no
      // charge columns, so the GST expression is 0), which yields 0 here — and
      // a 0 base renders the percentage as an em dash rather than 0%, which is
      // exactly the right answer for an order nobody has billed.
      taxed_bill_value: r2(a.taxed_bill_value),
      taxed_lines: num(a.taxed_lines),
      // The bill document's GST for this source — what the Tax Value / Tax %
      // columns total. null on PO (no document), like every PO charge.
      gst_value: noCharges ? null : r2(num(docBySource.get(src)?.doc_gst)),
      gst_taxed_bill_value: r2(num(docBySource.get(src)?.taxed_bill_value)),
      gst_taxed_lines: num(docBySource.get(src)?.taxed_lines),
      gst_from_grn_lines: num(docBySource.get(src)?.doc_from_grn_lines),
      gst_base_accepted_lines: num(docBySource.get(src)?.doc_base_accepted_lines),
    };
  }

  // ── THE CAVEAT, static explanation + this window's live figure, computed
  //    ONCE so every consumer (CSV, screen) renders the identical string. ──
  totals.goods_value_caveat =
    `${GOODS_VALUE_CAVEAT_HEADLINE} ${goodsValueCaveatDetail(totals.money.PURCHASE)}`;

  // ── ROWS ──────────────────────────────────────────────────────────────────
  // Ordered so ONE receipt event reads as one event: within a day and a vendor,
  // the three faces of the same item sit on consecutive lines in the order they
  // happened — PO (ordered) → GRN (billed) → PURCHASE (booked) — with unlinked
  // direct purchases first.
  //
  // substr(link_raw, 1, 13), not link_raw: on GRN/PO rows link_raw is the bare
  // "GRN-2026-0007" (13 chars) but on a PURCHASE row it is the TAIL of the note,
  // e.g. "GRN-2026-0007)" or "GRN-2026-0007 · invoice 4841". Sorting the raw
  // value puts the booked row after the whole rest of the group instead of
  // beside its own item. The exact key is still link_key, computed below —
  // this substring only drives the grouping of the sort.
  //
  // row_id is the final tie-break so the LIMIT takes a deterministic prefix
  // rather than an arbitrary one.
  const raw = db.prepare(withGrnCharges(`
    SELECT * FROM (${union})
    ORDER BY date ASC,
             vendor COLLATE NOCASE ASC,
             substr(link_raw, 1, 13) ASC,
             material COLLATE NOCASE ASC,
             source_rank ASC,
             doc_no ASC,
             row_id ASC
    LIMIT ?
  `)).all(...params, PURCHASE_LOG_MAX_ROWS) as any[];

  const rows: PurchaseLogRow[] = raw.map((r) => {
    const src = r.source as PurchaseLogSource;
    // PURCHASE rows carry a note TAIL that must be parsed; GRN/PO rows already
    // hold the bare grn_number (or '' when the line was never received).
    const grn = src === 'PURCHASE' ? grnFromNoteTail(r.link_raw) : (String(r.link_raw || '') || null);
    const materialId2 = String(r.material_id ?? '');
    // Charges first — total_amount and grand_total are derived from these exact
    // values, so the row's own columns and the SQL totals are the same
    // arithmetic on the same numbers rather than two readings of the database.
    const charges = {
      discount: nullNum(r.discount),
      cgst: nullNum(r.cgst),
      sgst: nullNum(r.sgst),
      special_excise_cess: nullNum(r.special_excise_cess),
      compensation_cess: nullNum(r.compensation_cess),
      tcs: nullNum(r.tcs),
      delivery_charges: nullNum(r.delivery_charges),
      mrp_round_off: nullNum(r.mrp_round_off),
    };
    const value = r2(r.value);
    // The bill document's GST on this line (see doc_* in buildUnion), through
    // the SAME helpers every tax column in the app uses. BLANK, NEVER 0, where
    // no GST was typed (ruling 93): gstValue() returns 0 for a line whose CGST
    // and SGST were both left at 0, and that 0 becomes null here. A PO line is
    // already null (no columns at all).
    const docTax = {
      cgst: nullNum(r.doc_cgst), sgst: nullNum(r.doc_sgst),
      discount: nullNum(r.doc_discount), value: nullNum(r.doc_bill_value),
    };
    const docGst = gstValue(docTax);
    return {
      source: src,
      date: String(r.date || ''),
      doc_no: String(r.doc_no || ''),
      invoice_id: String(r.invoice_id || ''),
      bill_no: String(r.bill_no || ''),
      vendor: String(r.vendor || ''),
      material: String(r.material || ''),
      sku: String(r.sku || ''),
      category: String(r.category || ''),
      qty: num(r.qty),
      purchase_unit: String(r.purchase_unit || ''),
      rate: num(r.rate),
      value,
      total_amount: lineTotalAmount({ source: src, value, discount: charges.discount }),
      grand_total: lineGrandTotal({ source: src, value, ...charges }),
      qty_rejected: r.qty_rejected == null ? null : num(r.qty_rejected),
      ...charges,
      // Material is part of the key so the PO line, the GRN line and the
      // purchases row of the SAME item pair up, not just the same delivery.
      // (Falls back to the bare GRN number if the material row was purged.)
      link_key: grn ? (materialId2 ? `${grn}#${materialId2}` : grn) : null,
      notes: String(r.notes || '').trim(),
      tax_value: docGst == null || docGst === 0 ? null : docGst,
      tax_percent: taxAppliedPercent(docTax),
      tax_from_grn: num(r.doc_from_grn) === 1,
      tax_base_accepted: num(r.doc_base_accepted) === 1 && docGst != null && docGst !== 0,
      tax_unavailable: num(r.doc_unpaired) === 1,
      // Filled in by billGrandTotals() below; a PO row keeps these.
      bill_grand_total: null,
      bill_key: null,
      bill_label: null,
      bill_lines: null,
      bill_grand_total_reason: src === 'PO' ? BILL_GT_REASON_PO : '',
      bill_unpaired_lines: null,
      bill_understated_note: '',
    };
  });

  // ── THE BILL GRAND TOTAL, per row ─────────────────────────────────────────
  // Only PURCHASE and GRN rows sit on a bill. A ?source=po request has none, so
  // it never pays for the Bill Summary read.
  if (rows.some(r => r.source !== 'PO')) {
    totals.bill_grand_total_check = billGrandTotals(db, from, to, rows, raw.map(r => String(r.row_id ?? '')));
  }

  return { rows, totals, truncated: totals.lines > rows.length, from, to };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BILL GRAND TOTAL — the Purchase Bill Summary's figure, on every line of
// the bill (owner #5, ruling 93: "Purchase Report: Add purchase date, tax
// details, GST %, and grand total" → "a per-BILL Grand Total" on this log).
// ─────────────────────────────────────────────────────────────────────────────
//
// WHAT IS PRINTED. For each PURCHASE / GRN row: the Bill Summary's own
// total_bill_value (src/lib/purchase-bill-summary.ts getPurchaseBillSummary,
// :1272-1410 — SUM(line_total) GROUP BY bill_key at :1315/:1321) for the bill
// the line belongs to, over the SAME date window, no vendor filter, PO receipts
// included and unnumbered purchases grouped per vendor-day — i.e. exactly what
// Reports → Purchase Bill Summary prints for that window by default. Not
// recomputed and not re-rounded: the number on this log IS that number.
//
// WHICH BILL A LINE IS ON. The Bill Summary keys bills with a private CASE
// (billKeyExpr, purchase-bill-summary.ts:1086-1092) that it exposes per BILL,
// never per purchases row, and this lane may not edit that file. So the key is
// restated below as BILL_KEY_SQL — the same five branches in the same order —
// and that restatement is NEVER trusted on its own word: every bill it forms is
// checked against the Bill Summary's row for the same key, on BOTH its line
// count and its total (this file's own SUM of effectiveLineTotalSql, the
// identical per-line expression the Bill Summary sums, purchase-bill-summary.ts
// :1109). A bill that disagrees on either prints BLANK, is counted in
// bill_grand_total_check.mismatched, and the screen and the CSV both say so —
// so if billKeyExpr ever changes and this copy does not, the column goes blank
// and loud rather than quietly quoting a different bill's money.
//   ⚠ When billKeyExpr changes, change BILL_KEY_SQL with it. Better still, have
//   purchase-bill-summary.ts export a per-row key and delete this copy.
//
// GRN ROWS are the same delivery seen from the bill side, so they print the
// same figure as the purchases rows that delivery booked: the GRN's id is read
// off goods_receipt_note_items by row id, and the bill is the one its purchases
// rows (purchases.grn_id, the hard link) fall on. A GRN with no booked line in
// the window (every line rejected) has no bill in the Bill Summary and prints
// blank, with that reason.
//
// IT MOVES NO OTHER FIGURE. Read-only SELECTs; nothing here touches `value`,
// `total_amount`, `grand_total`, a charge column, a totals field or the row order.

/** BILL KEY — restated from purchase-bill-summary.ts:1086-1092 (billKeyExpr,
 *  with fromPoReceiptSql :1016-1021 inlined) and checked against it per bill on
 *  every request. 'group' mode — the Bill Summary's default (:1173-1174). */
const BILL_KEY_SQL = `CASE
        WHEN (TRIM(COALESCE(p.grn_id, '')) <> '' AND EXISTS (
              SELECT 1 FROM goods_receipt_notes g_src
               WHERE g_src.id = TRIM(p.grn_id)
                 AND g_src.po_id IS NOT NULL AND TRIM(g_src.po_id) <> ''))
                                                    THEN 'GRN:' || TRIM(p.grn_id)
        WHEN TRIM(COALESCE(p.invoice_id, '')) <> '' THEN 'INV:' || TRIM(p.invoice_id)
        WHEN TRIM(COALESCE(p.grn_id, '')) <> ''     THEN 'GRN:' || TRIM(p.grn_id)
        WHEN TRIM(COALESCE(p.bill_no, '')) <> ''    THEN 'BILL:' || LOWER(TRIM(p.vendor)) || '|' || LOWER(TRIM(p.bill_no)) || '|' || p.date || '|' || COALESCE(p.outlet_id, '')
        ELSE 'DAY:' || LOWER(TRIM(p.vendor)) || '|' || p.date || '|' || COALESCE(p.outlet_id, '')
      END`;

const BILL_GT_REASON_PO =
  'An order is not a bill — there is no grand total until it is received. See the GRN and PURCHASE rows with the same Link key.';
const BILL_GT_REASON_NO_BILL =
  'No booked purchase line of this delivery falls in this period (for example every line was rejected), so the Purchase Bill Summary has no bill for it.';
const BILL_GT_REASON_SPLIT =
  'The purchase lines this delivery booked fall on more than one bill in the Purchase Bill Summary, so no single bill total can be quoted for this line.';
const BILL_GT_REASON_MISMATCH =
  'BLANKED: this bill did not reconcile with the Purchase Bill Summary (line count or total differ), so no figure is printed rather than one that disagrees. Report it.';

/** "Rs 1,234.50" for a reason sentence — en-IN grouping, always two decimals,
 *  "Rs" like the rest of this file's prose (it also reaches the CSV). */
const inr = (n: number) =>
  'Rs ' + r2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The bill in plain words, from the Bill Summary's own row for it. */
function billLabelFrom(b: Pick<PurchaseBillRow, 'bill_kind' | 'vendor' | 'invoice_id' | 'bill_no' | 'grn_number' | 'po_number' | 'date'>): string {
  const v = b.vendor || '(no vendor)';
  switch (b.bill_kind) {
    case 'INV': return `${v} · invoice ${b.invoice_id}${b.bill_no ? ` · vendor bill ${b.bill_no}` : ''}`;
    case 'GRN': return `${v} · ${b.grn_number || 'GRN'}${b.po_number ? ` (PO ${b.po_number})` : ''}${b.bill_no ? ` · vendor bill ${b.bill_no}` : ''}`;
    case 'BILL': return `${v} · vendor bill ${b.bill_no} · ${b.date}`;
    default: return `${v} · ${b.date} · no bill number, so the Bill Summary groups this vendor’s unnumbered purchases for the day as one bill`;
  }
}

/**
 * The warning beside a Bill Grand Total that is SHORT because a GRN line behind
 * one of the bill's cost rows has been deleted — '' when nothing is missing.
 * Written for ONE bill (the shared unpairedMirrorNote() is worded for the
 * Bill Summary's rows, where a Subtotal and charge cells sit beside it). No
 * rupee figure: what the deleted line held cannot be known from here.
 * `flaggedThere` = the figure was matched to the Bill Summary's own row, which
 * prints the same short total with its own UNDERSTATED flag.
 */
function billUnderstatedNote(unpaired: number, lines: number, flaggedThere: boolean): string {
  if (!(unpaired > 0)) return '';
  const one = unpaired === 1;
  // "the only line" / "all 3 lines" / "1 of the 2 lines" — never "1 of the 1 line".
  const which = unpaired >= lines
    ? (lines === 1 ? 'the only line on this bill was' : `all ${lines} lines on this bill were`)
    : `${unpaired} of the ${lines} lines on this bill ${one ? 'was' : 'were'}`;
  return `UNDERSTATED — ${which} booked from a goods receipt whose GRN line (the bill document) has since been deleted, `
    + `so the tax and charges recorded on ${one ? 'that GRN line are' : 'those GRN lines are'} missing from this Bill Grand Total`
    + (flaggedThere ? ' — the Purchase Bill Summary prints the same short figure for this bill and flags it UNDERSTATED' : '')
    + '. How much is missing cannot be known from here. Do not pay a vendor against this figure — report it: a cost '
    + 'row outliving its bill document means a GRN was deleted without unwinding the purchase.';
}

/**
 * Fill bill_grand_total / bill_key / bill_label / bill_lines on every PURCHASE
 * and GRN row, in place, and return the proof counts. `rowIds[i]` is the source
 * table's id for rows[i] (purchases.id / goods_receipt_note_items.id).
 */
function billGrandTotals(
  db: DatabaseT.Database,
  from: string,
  to: string,
  rows: PurchaseLogRow[],
  rowIds: string[],
): PurchaseLogBillCheck {
  // 1. Every purchases row in the window → its bill key, plus this file's own
  //    figure for that bill (window SUM of the imported per-line expression).
  //    No vendor / material / source filter: a bill's total is the WHOLE bill.
  //    `unpaired` is a FLAG beside the figure, not part of it: a cost row booked
  //    from a goods receipt whose GRN line is gone — the same expression as
  //    chargeSourceCountsSql()'s unpaired_mirror_rows (and doc_unpaired above).
  const mine = db.prepare(withGrnCharges(`
    SELECT purchase_id, grn_id, bill_key,
           COUNT(*)        OVER (PARTITION BY bill_key) AS bill_lines,
           SUM(line_total) OVER (PARTITION BY bill_key) AS bill_total,
           SUM(unpaired)   OVER (PARTITION BY bill_key) AS bill_unpaired
      FROM (
        SELECT p.id                             AS purchase_id,
               TRIM(COALESCE(p.grn_id, ''))     AS grn_id,
               ${BILL_KEY_SQL}                  AS bill_key,
               ${effectiveLineTotalSql('p', 'gl')} AS line_total,
               CASE WHEN ${poReceiptMirrorSql('p')} = 1 AND gl.purchase_id IS NULL
                    THEN 1 ELSE 0 END           AS unpaired
          FROM purchases p
          ${grnLineJoinSql('p', 'gl')}
         WHERE p.date >= ? AND p.date <= ?
      )
  `)).all(from, to) as Array<{ purchase_id: string; grn_id: string; bill_key: string | null; bill_lines: number; bill_total: number; bill_unpaired: number }>;

  const keyOfPurchase = new Map<string, string>();
  const keysOfGrn = new Map<string, Set<string>>();
  const mineByKey = new Map<string, { lines: number; total: number; unpaired: number }>();
  for (const m of mine) {
    // The Bill Summary maps a NULL key to '' (String(r.bill_key || '')), so
    // this side does too — the two maps must use one spelling of every key.
    const k = String(m.bill_key || '');
    keyOfPurchase.set(String(m.purchase_id), k);
    if (m.grn_id) {
      const set = keysOfGrn.get(m.grn_id) || new Set<string>();
      set.add(k);
      keysOfGrn.set(m.grn_id, set);
    }
    if (!mineByKey.has(k)) mineByKey.set(k, { lines: num(m.bill_lines), total: num(m.bill_total), unpaired: num(m.bill_unpaired) });
  }

  // 2. The Bill Summary itself, for the same window, on its defaults.
  const bs = getPurchaseBillSummary({ from, to }, db);
  const bsByKey = new Map<string, PurchaseBillRow>();
  for (const b of bs.rows) bsByKey.set(b.bill_key, b);

  // 3. GRN rows → their GRN's id, one read for all of them.
  const grnItemIds = rows.map((r, i) => (r.source === 'GRN' ? rowIds[i] : '')).filter(Boolean);
  const grnOfItem = new Map<string, string>();
  if (grnItemIds.length) {
    const found = db.prepare(`
      SELECT id, TRIM(COALESCE(grn_id, '')) AS grn_id
        FROM goods_receipt_note_items
       WHERE id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(grnItemIds)) as Array<{ id: string; grn_id: string }>;
    for (const f of found) grnOfItem.set(String(f.id), String(f.grn_id || ''));
  }

  // 4. Settle each referenced bill ONCE: the Bill Summary's figure when this
  //    side agrees with it on lines AND total, blank when it does not.
  type Settled = { total: number | null; lines: number; label: string; reason: string; unpaired: number | null; understated: string };
  const settled = new Map<string, Settled>();
  const check: PurchaseLogBillCheck = { bills: 0, matched: 0, unverified: 0, mismatched: 0, understated: 0, understated_bills: [] };
  const settle = (key: string) => {
    const hit = settled.get(key);
    if (hit) return hit;
    const m = mineByKey.get(key);
    const b = bsByKey.get(key);
    let out: Settled;
    if (b && m && b.lines === m.lines && Math.abs(b.total_bill_value - m.total) <= 0.0051) {
      // THE printed figure is the Bill Summary's, untouched — and so is its
      // UNDERSTATED flag: the Bill Summary's own count of lines whose GRN line
      // is gone, the count its screen flags the same bill by.
      const unpaired = num(b.unpaired_mirror_rows);
      out = {
        total: b.total_bill_value, lines: b.lines, label: billLabelFrom(b), reason: '',
        unpaired, understated: billUnderstatedNote(unpaired, b.lines, true),
      };
      check.matched++;
    } else if (!b && m && bs.truncated) {
      // Past the Bill Summary's 5,000-bill row cap: no row there to compare,
      // so the same arithmetic from this side, rounded the way it rounds.
      out = {
        total: r2(m.total), lines: m.lines, label: key, reason: '',
        unpaired: m.unpaired, understated: billUnderstatedNote(m.unpaired, m.lines, false),
      };
      check.unverified++;
    } else {
      out = {
        total: null, lines: m?.lines ?? 0, label: b ? billLabelFrom(b) : key,
        reason: `${BILL_GT_REASON_MISMATCH} This log: ${m?.lines ?? 0} line(s), ${inr(m?.total ?? 0)}; `
          + `Bill Summary: ${b ? `${b.lines} line(s), ${inr(b.total_bill_value)}` : 'no such bill'}.`,
        // No figure is printed, so there is nothing to call short.
        unpaired: null, understated: '',
      };
      check.mismatched++;
    }
    if (out.understated) {
      check.understated++;
      check.understated_bills.push(out.label);
    }
    check.bills++;
    settled.set(key, out);
    return out;
  };

  rows.forEach((r, i) => {
    if (r.source === 'PO') return;
    let key: string | undefined;
    if (r.source === 'PURCHASE') {
      key = keyOfPurchase.get(rowIds[i]);
      // Cannot happen — the row came from the same table and window — but a
      // row with no bill must say so rather than print another row's figure.
      if (key === undefined) { r.bill_grand_total_reason = BILL_GT_REASON_NO_BILL; return; }
    } else {
      const keys = keysOfGrn.get(grnOfItem.get(rowIds[i]) || '');
      if (!keys || keys.size === 0) { r.bill_grand_total_reason = BILL_GT_REASON_NO_BILL; return; }
      if (keys.size > 1) { r.bill_grand_total_reason = BILL_GT_REASON_SPLIT; return; }
      key = [...keys][0];
    }
    const s = settle(key);
    r.bill_key = key;
    r.bill_label = s.label;
    r.bill_lines = s.lines;
    r.bill_grand_total = s.total;
    r.bill_grand_total_reason = s.reason;
    r.bill_unpaired_lines = s.unpaired;
    r.bill_understated_note = s.understated;
  });

  return check;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV — shared so the download and the on-screen table cannot drift apart
// ─────────────────────────────────────────────────────────────────────────────

export interface PurchaseLogColumn {
  key: keyof PurchaseLogRow;
  label: string;
  /** Numeric columns skip the spreadsheet-formula guard (it would break "-12.5"). */
  numeric?: boolean;
}

/**
 * ⚠ THIS IS **NOT** THE LIST THE DOWNLOAD USES. The served CSV is built from the
 * COLUMNS array inside src/app/api/reports/purchase-log/route.ts — that one owns
 * the header wording, the totals rows and the caption block. Nothing in src/
 * imports PURCHASE_LOG_COLUMNS, purchaseLogToCsv or purchaseLogFilename today;
 * they are kept only so a second consumer has a plain serialiser to reach for.
 * Editing this array changes nothing the owner will ever open — if you came here
 * to change a download, you are in the wrong file.
 */
export const PURCHASE_LOG_COLUMNS: PurchaseLogColumn[] = [
  { key: 'date',                label: 'Date' },
  { key: 'source',              label: 'Source' },
  { key: 'doc_no',              label: 'Document No' },
  { key: 'invoice_id',          label: 'Invoice ID (ours)' },
  { key: 'bill_no',             label: 'Bill No (vendor)' },
  { key: 'vendor',              label: 'Vendor' },
  { key: 'material',            label: 'Item' },
  { key: 'sku',                 label: 'SKU' },
  { key: 'category',            label: 'Category' },
  { key: 'qty',                 label: 'Qty', numeric: true },
  { key: 'purchase_unit',       label: 'Purchase Unit' },
  { key: 'rate',                label: 'Rate (Rs/purchase unit)', numeric: true },
  { key: 'value',               label: 'Value (Rs)', numeric: true },
  { key: 'total_amount',        label: 'Total Amount (Rs, before tax: value - discount)', numeric: true },
  { key: 'grand_total',         label: 'Grand Total (Rs, incl. tax & charges)', numeric: true },
  { key: 'qty_rejected',        label: 'Qty Rejected', numeric: true },
  { key: 'discount',            label: 'Discount', numeric: true },
  { key: 'cgst',                label: 'CGST', numeric: true },
  { key: 'sgst',                label: 'SGST', numeric: true },
  { key: 'special_excise_cess', label: 'Spl Excise Cess', numeric: true },
  { key: 'compensation_cess',   label: 'Compensation Cess', numeric: true },
  { key: 'tcs',                 label: 'TCS', numeric: true },
  { key: 'delivery_charges',    label: 'Delivery Charges', numeric: true },
  { key: 'mrp_round_off',       label: 'MRP Round Off', numeric: true },
  { key: 'link_key',            label: 'Link Key (same receipt)' },
  { key: 'notes',               label: 'Notes' },
];

/**
 * Escape one CSV field. Free-text (vendor, item, notes) gets the leading
 * `=+-@` guard — Excel executes those as formulas, and a vendor name is
 * user-entered text that reaches this file unfiltered.
 */
function csvCell(v: unknown, numeric: boolean): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialise rows to CSV. Returns the body WITHOUT the UTF-8 BOM — the caller
 * prepends '﻿' when writing the HTTP response (prepending it twice puts a
 * stray glyph in the first header cell).
 */
export function purchaseLogToCsv(rows: PurchaseLogRow[]): string {
  const out: string[] = [PURCHASE_LOG_COLUMNS.map(c => csvCell(c.label, false)).join(',')];
  for (const r of rows) {
    out.push(PURCHASE_LOG_COLUMNS.map(c => csvCell(r[c.key], !!c.numeric)).join(','));
  }
  return out.join('\r\n');
}

/** Filename the download must use: purchase-log-<from>_<to>.csv */
export function purchaseLogFilename(from: string, to: string): string {
  return `purchase-log-${from}_${to}.csv`;
}
