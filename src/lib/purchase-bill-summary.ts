import type DatabaseT from 'better-sqlite3';
import { getDb } from './db';
import { todayIST } from './format-date';
// The PO-receive cost-mirror predicate. Imported, not re-typed: the aggregate
// reports (/api/reports/purchases) count the same rows to decide whether a
// charge cell is "no tax" or "tax is on the GRN", and if the two definitions
// ever drifted, one screen would blank a figure the other printed as ₹0.
import {
  poReceiptMirrorSql, effectiveChargeSql, effectiveBillValueSql,
  effectiveLineTotalSql, grnLineJoinSql, grnSourcedSql, withGrnCharges,
  chargeCell, chargeNote,
} from './purchase-charges';
import type { PurchaseChargeKey, PurchaseChargeColumn } from './purchase-charges';

/**
 * PURCHASE BILL SUMMARY — one row per VENDOR BILL, money only.
 *
 * Requirement 69: "one row per purchase bill with Bill No., Vendor, Date, Total
 * Bill Value, GST, Discount, and Delivery Charges."
 *
 * 2026-09-11 — THE COLUMN THE REQUIREMENT CALLS "Total Bill Value" IS NOW
 * PRINTED AS **GRAND TOTAL**, and the goods value it is built on is printed
 * beside it as **SUBTOTAL**. The quote above is left word for word because it is
 * a historical citation, not a caption. Nothing about the arithmetic moved: the
 * owner asked for "the ingredients cost … as a subtotal" and for a grand total
 * that is "what we actually need to pay the vendor", and both figures already
 * existed on the wire (`bill_value` and `total_bill_value`). This pass is
 * naming, column composition and documentation — no expression in this file
 * changed, and any rupee that moves is a defect.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 1. ONE SOURCE, THEREFORE ONE *PERIOD* GRAND TOTAL IS LEGAL
 * ═══════════════════════════════════════════════════════════════════════════
 * (Since 2026-09-11 "Grand Total" is also the name of a PER-ROW column. This
 * section is about the PERIOD figure — the one total printed for the whole
 * filtered set. The per-row column is the same arithmetic, per bill; §1 is not a
 * prohibition on it.)
 * This file reads the `purchases` table and NOTHING ELSE. No join to the GRN
 * header table, the GRN line table, the PO-bill table or the PO line table. No
 * join to raw_materials either.
 *
 * That is the whole design. src/lib/purchase-log.ts must return THREE totals
 * that may never be added, because a single delivery is written into three
 * tables inside one transaction and a UNION over them reads ~2-3x the real
 * spend. This report sidesteps that entirely: with one source, every rupee is
 * counted exactly once BY CONSTRUCTION, and the cross-source sum that ruins the
 * log's arithmetic is not even expressible here.
 *
 *   ⚠ DO NOT "IMPROVE" THIS BY UNIONING THE GRN LINE TABLE BACK IN so that
 *     PO-received bills show their tax. The instant a GRN column is summed
 *     beside a `purchases` column, this report is one careless edit away from
 *     the doubled number that the purchase-log header exists to prevent, and
 *     the single PERIOD grand total below stops being defensible. If a tax-inclusive
 *     purchase register is ever wanted, build it as a SEPARATE report with its
 *     own per-source totals — do not graft it onto this one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 2. WHAT A "BILL" IS HERE — the key, and why grn_id outranks bill_no
 * ═══════════════════════════════════════════════════════════════════════════
 * `purchases` holds ONE ROW PER ITEM; a vendor bill spans several rows. The key
 * is derived, in this precedence (see billKeyExpr below):
 *
 *   1. invoice_id  → 'INV:<invoice_id>'
 *      PINV-yyyy-#### is OUR number, minted ONE PER VENDOR BILL by the
 *      hand-entry path. Where present it IS the bill. Measured: 0 rows carry
 *      both an invoice_id and a grn_id, so branches 1 and 2 cannot fight.
 *
 *   2. grn_id      → 'GRN:<grn_id>'
 *      DELIBERATELY AHEAD OF bill_no. A PO receive / ad-hoc GRN mints one GRN
 *      per delivery inside one transaction and stamps grn_id on every
 *      `purchases` row it writes (see the insPurchase prepare and its last bind
 *      in src/app/api/purchase-orders/[id]/receive/route.ts). One GRN = exactly
 *      one vendor bill event, and it is a HARD COLUMN, not a sentence parsed
 *      back out of `notes` the way purchase-log.ts still has to. The vendor's
 *      own number is blank on 26 of those 31 rows, so keying on bill_no would
 *      have dumped them into the DAY branch and merged real deliveries with
 *      unrelated market runs from the same vendor that day. Measured: grn_id
 *      and the notes GLOB agree 31/31, so nothing the regex would have caught
 *      is lost. purchase-log.ts's is_mirror GLOB is left untouched — this
 *      report simply uses the better column that now exists.
 *
 *   3. bill_no     → 'BILL:<vendor>|<bill_no>|<date>|<outlet>'
 *      The VENDOR'S own printed number. This is /api/purchases' own duplicate-
 *      guard tuple minus its wildcard case. Empty on today's data (0 bills) and
 *      kept anyway: a hand entry carrying a vendor bill number but no
 *      invoice_id is legal, and historical rows may acquire one.
 *
 *   4. else        → 'DAY:<vendor>|<date>|<outlet>'   (or 'ROW:<id>', see §3)
 *
 * outlet_id is IN the key on branches 3 and 4 even though there is one outlet
 * today — a second outlet must never merge into another outlet's bill.
 *
 * MEASURED on a copy of live (2,165 rows): 350 bills —
 *   INV 13 bills / 13 lines · GRN 29 / 31 · BILL 0 / 0 · DAY_RUN 308 / 2,121.
 *
 * NOT READ: purchases.invoice_number. It exists in some database files but is
 * absent from db.ts's CREATE and from every ALTER, so referencing it turns the
 * whole report into a hard 500 on a database that lacks it. Same trap
 * purchase-log.ts documents on its PURCHASE branch. Ours is invoice_id; the
 * vendor's is bill_no; there is no third.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 3. THE DAY_RUN CAVEAT — 308 of 350 "bills" are not paper bills
 * ═══════════════════════════════════════════════════════════════════════════
 * 2,151 of 2,165 rows carry no vendor bill number at all, so branch 4 IS this
 * report. Those rows are grouped by vendor + date + outlet and are NOT
 * presented as a document: bill_kind is 'DAY_RUN', bill_no_missing is true, and
 * the caller MUST label them as what they are — that vendor's purchases for
 * that day consolidated into one readable line, which may cover more than one
 * physical bill or market run. Do not print them as if they were invoices.
 *
 * Rejected alternative: one bill per row for the unnumbered case. That yields
 * 2,121 one-line "bills", i.e. a line log — which /reports/purchase-log already
 * is, and better. An escape hatch is provided instead: unnumbered = 'split'
 * swaps branch 4 to 'ROW:<id>' and gives the per-line view on demand without
 * making it the default. bill_kind stays 'DAY_RUN' under split — the defining
 * fact (no vendor bill number, so this is not a paper bill) has not changed,
 * only the grouping granularity, which `lines` = 1 makes visible.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 4. PO-RECEIVED BILLS APPEAR, AND THEIR CHARGE COLUMNS CARRY THE BILL'S REAL
 *    FIGURES — READ OFF THE GRN LINE. PRINT THE NUMBER.
 * ═══════════════════════════════════════════════════════════════════════════
 * A delivery received against a PO is a real vendor bill, so excluding it would
 * understate the period (29 bills / 31 lines / Rs 25,280 of goods on live).
 * They are in.
 *
 * But a PO-receive `purchases` row is a deliberately TAX-FREE COST MIRROR. The
 * receive route binds discount to the LITERAL 0 (the discount is already inside
 * the net rate) and binds no cgst/sgst at all (tax there would poison
 * average_price and destroy the input credit). The tax and the gross discount
 * live on the GRN line, which is the bill document. MEASURED across all 31
 * mirror rows: SUM(cgst + sgst) = 0, SUM(discount) = 0, SUM(delivery_charges)
 * = 50 (the allocated delivery share IS carried onto the mirror),
 * SUM(total_price) = 25,280.
 *
 * 2026-09-10 — THIS LAYER USED TO RETURN THOSE ZEROS AS STORED, flag the row
 * `tax_on_grn` and leave every consumer to print an em-dash. That was a
 * presentation answer to an arithmetic problem, and it made this module and the
 * GRN inward register quote DIFFERENT MONEY FOR THE SAME BILL: GRN-2026-0007
 * totalled Rs 450.00 here and Rs 484.90 there; across the 29 GRN-sourced bills,
 * Rs 25,330.00 here against the register's Rs 30,732.20, with 28 of the 29
 * individually wrong.
 *
 * It now READS THE CHARGE FROM WHERE IT IS RECORDED — the GRN line for a mirror
 * row, `purchases` for everything else — via effectiveChargeSql() and the
 * grn_line CTE in src/lib/purchase-charges.ts. Consequences:
 *   · the eight charge figures on a PO-receipt bill are the bill's REAL ones,
 *     so they print as numbers and no longer need an em-dash;
 *   · `bill_value` — printed as SUBTOTAL — is the goods value as the BILL
 *     charges for it, and `goods` — printed as BOOKED COST (Spend) — stays
 *     SUM(total_price) as stored (§5), so both are available and neither is
 *     mistaken for the other;
 *   · `total_bill_value` — printed as GRAND TOTAL, "what we actually need to
 *     pay the vendor" — is the vendor's BILL FACE VALUE and matches the GRN
 *     register's Total Inward, per bill, on every GRN-keyed bill in the
 *     database today. MEASURED, NOT STRUCTURAL: the register sums every GRN
 *     LINE, while this report can only reach a line that has a `purchases`
 *     mirror behind it, so a fully-rejected (accepted = 0) or QC-held line
 *     would sit in the register and never here. 0 lines are in that state
 *     today — 31 GRN lines, 0 rejected, 0 with accepted = 0, 0 awaiting QC,
 *     0 voided. Every statement of this to a reader says "matches", not
 *     "equals".
 * `tax_on_grn` is still shipped — it now means "the charges on this row were
 * read off the GRN line", which is a provenance note, not a missing figure.
 * Period totals carry po_receipt_bills / po_receipt_value so a footer can print
 * the split. include_po_receipts = false drops them for anyone who wants
 * hand-entered bills alone; the default is to include.
 *
 * WHAT A CHARGE CELL MAY STILL REFUSE TO PRINT. Exactly one case: a mirror row
 * whose GRN line is GONE (a repair, a half-finished void). It says "my charges
 * are recorded elsewhere" and elsewhere no longer exists, so the figure is
 * UNAVAILABLE, not zero, and both the screen and the CSV leave the cell empty —
 * `Rs 0` in a tax column is a filing-grade lie. That is unpaired_mirror_rows on
 * every row and isChargeSourceMissingRow() in purchase-charges.ts; 0 rows
 * qualify today. A charge that genuinely IS zero prints as Rs 0.00. And the
 * blank can never hide money: it is only ever allowed where the stored sum is
 * also 0, so Σ(cells, blank = 0) is always the column total.
 *
 * WHAT IS STILL TRUE, AND MUST STAY ON THE SCREEN — NOW THREE FIGURES, NOT TWO:
 *   GRAND TOTAL  (total_bill_value) is the bill's FACE VALUE: what is payable.
 *   SUBTOTAL     (bill_value)       is the goods on that same bill's terms —
 *                                   the base the Grand Total is built on.
 *   BOOKED COST  (goods)            is SPEND: the figure stock valuation uses.
 * SUBTOTAL IS NOT THE BOOKED COST, and the booked-cost column must keep its own
 * heading on every surface. They are different numbers on a PO receipt —
 * Rs 26,900 of subtotal against Rs 25,280 booked across the 29 — and the gap is
 * exactly the Rs 1,620 of discount already inside the booked rates. The report
 * prints all three, side by side, labelled. Do not delete the booked-cost column
 * and do not quietly let the Subtotal serve as it: /reports/purchases' Spend and
 * stock valuation both reconcile against booked cost, not against the Subtotal.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 5. BOOKED COST = SUM(total_price) AS STORED;
 *    SUBTOTAL = THE SAME GOODS AS THE BILL CHARGES FOR THEM
 * ═══════════════════════════════════════════════════════════════════════════
 * Never recomputed from the line's own count x rate. MEASURED: 217 of 2,165
 * rows disagree by more than a paisa (Rs 6,926,866.40 stored vs Rs 6,770,245.24
 * recomputed — Rs 156,621 apart). SUM(total_price) is exactly what
 * /api/reports/purchases sums as total_spend, so the two reports reconcile to
 * the rupee. (That sibling INNER JOINs raw_materials and this one joins
 * nothing; 0 orphan purchases today, and if a material is ever deleted THIS
 * report is the one that stays right.)
 *
 * THE GRAND TOTAL is the Total Inward definition, per bill, on the EFFECTIVE
 * rail (§4) — the same shape as before, with bill_value (the Subtotal) where
 * total_price used to be and each charge read from wherever it is recorded:
 *
 *   GRAND TOTAL = SUBTOTAL − Discount + GST + Comp. Cess + Spl Excise Cess
 *                 + TCS + Delivery + MRP Round-off
 *
 * which in SQL is
 *   SUM(bill_value) - SUM(discount) + SUM(cgst) + SUM(sgst)
 *   + SUM(compensation_cess) + SUM(special_excise_cess) + SUM(tcs)
 *   + SUM(delivery_charges) + SUM(mrp_round_off)
 * On a hand-entered bill bill_value IS total_price — so the Subtotal, the booked
 * cost and, where no charge was recorded, the Grand Total all print the SAME
 * number, which is correct and not a sign the columns are doing nothing — and
 * every charge is the `purchases` column, so those 2,134 rows total exactly what
 * they always did, asserted per row by scripts/purchase-charges-tests.js §7.
 *
 * GST is cgst + sgst ONLY — the house invariant. compensation_cess (the GST
 * (Compensation to States) levy) and special_excise_cess (TGBCL's) get their
 * OWN columns and are NEVER folded into GST: different levy, different taxable
 * base, and a return filed on the folded figure would be wrong.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 6. NO COUNTS AND NO PER-UNIT RATES ARE READ ANYWHERE — SO THERE IS NO PAIRING
 * ═══════════════════════════════════════════════════════════════════════════
 * A bill spans kg + BTL + CASE lines, so adding up its item counts produces a
 * number with no unit. This report shows a `lines` count instead and reads
 * neither the per-line count column nor the Rs-per-purchase-unit rate column on
 * `purchases`. Nothing here is a quantity and nothing here is a per-unit rate,
 * so the rate-basis lock (scripts/check-rate-basis.js) reports this file CLEAN
 * — no `rate-basis:` declaration and no ALLOW entry are needed, and none should
 * be added to "be safe".
 *
 *   ⚠ ONE PAIRING DOES EXIST, AND THE SENTENCE ABOVE USED TO DENY IT. This
 *     section said the report "writes no rate x count product at all". That is
 *     FALSE since the SUBTOTAL arrived: on a PO receipt the Subtotal IS a
 *     product — effectiveBillValueSql() in src/lib/purchase-charges.ts forms
 *     `COALESCE(gm.quantity_received, 0) * COALESCE(gm.unit_price, 0)` off the
 *     GRN line. The rate-basis lock cannot see it because it lives inside a SQL
 *     template string in another file, so "the lock says clean" is NOT evidence
 *     that no pairing exists here.
 *
 *     THE MONEY IS RIGHT: both halves are PURCHASE basis (a GRN line's
 *     quantity_received and unit_price are the vendor's own bill quantities and
 *     rate), and p.quantity = gm.quantity_received on all 31 mirror rows today,
 *     so the product agrees with the booked side line for line. What was wrong
 *     was the claim of absence — the sentence a future editor would have read
 *     before adding a quantity column and concluded there was nothing to match.
 *
 *   ⚠ ADDING AN "AVG RATE" OR "TOTAL QTY" COLUMN CREATES A PAIRING THAT DOES
 *     NOT EXIST TODAY. If you ever do, the two halves must both be purchase
 *     basis (per the canon: the count column on `purchases` is in PURCHASE
 *     units, its rate column is Rs per PURCHASE unit) and the site must declare
 *     `-- rate-basis: purchase`. Do not reach for raw_materials.average_price,
 *     which is Rs per RECIPE unit, and never read the mixed-basis LPP column at
 *     all (see src/lib/closing-valuation.ts).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 7. THE DAY-WISE ROLLUP — a THIRD wrapper over the SAME base, never a re-key
 * ═══════════════════════════════════════════════════════════════════════════
 * getPurchaseBillDaySummary() answers "what did we buy on each date" for the
 * store person reconciling a day's paperwork. It is deliberately in THIS file
 * and calls the SAME private buildBase(), so both views are literally the same
 * CASE expression and can never disagree about what a bill is. Do not export
 * buildBase or copy billKeyExpr into another module.
 *
 * AGGREGATE PER BILL FIRST, THEN PER DAY. Grouping the base rows straight by
 * p.date would count a bill once for every day it touches. Each bill is
 * attributed to MIN(row_date) — the very value PurchaseBillRow.date already
 * carries, so the two views agree by construction. MEASURED: 0 groups span more
 * than one day today, so this costs nothing now and forecloses the bug later; a
 * spanning bill lands WHOLE on its first day and the day row reports how many
 * such bills it holds (spanning_bills) rather than splitting money across dates.
 *
 * THE BILL COUNT IS TWO NUMBERS, NEVER ONE. MEASURED: 33 of 34 purchase days on
 * live hold ZERO numbered bills — April, which is 99.3% of the spend, is 100%
 * DAY_RUN. A single "Bills" column would print 0 for the month that matters, so
 * every day row carries `bills` (INV + GRN + BILL — identified documents) and
 * `day_runs` (the DAY/ROW branch — a vendor's purchases that day, NOT a paper
 * bill) separately, and `groups` only as their sum for reconciliation. The split
 * is by KIND PREFIX, exactly as totals.day_run_bills is counted — never by
 * bill_no_missing, which also catches the 28 GRN/INV bills that simply carry no
 * vendor number.
 *
 * "TOTAL ITEMS" IS A LINE COUNT. `lines` is COUNT(*) of `purchases` rows, per §6.
 * No quantity is summed anywhere here either.
 *
 * THE DAY'S CHARGE FIGURES ARE COMPLETE — AND THE DAY TABLE STILL DOES NOT SHOW
 * THEM. Those are two separate facts and both matter. Until 2026-09-10 a day
 * mixing PO/GRN receipts with hand-entered bills had PARTIAL charge columns (on
 * 2026-08-07 a naive GST cell printed Rs 1,125 while 29 taxed bills contributed
 * a structural 0), and the em-dash rule existed to stop that being printed
 * clean. §4 removed the cause: every day row's charges now come off the
 * effective rail, so 2026-08-07's GST is its real Rs 5,482.80.
 *
 * The on-screen day table carries SEVEN columns as of 2026-09-11 — date, two
 * bill counts, groups, vendors, item lines, SUBTOTAL and GRAND TOTAL. It was
 * six until the Subtotal joined it, which cost no query: bill_value is already
 * on every day row and every vendor row below (it always was), so the change was
 * two type declarations and two cells on the page.
 *
 * IT STILL SHOWS NO CHARGE COLUMNS, and that remains a layout choice rather than
 * a correctness one: the store person is matching paperwork, not filing a
 * return. The consequence has to be captioned, because Subtotal and Grand Total
 * now sit ADJACENT with the eight columns that explain the gap between them not
 * on the table — the caption must point a reader who asks "why do these differ"
 * at the By bill view and the CSV, both of which itemise it. The eight charge
 * columns, the Subtotal and a provenance note per row ARE in the day CSV. Every
 * day row still ships po_receipt_bills / po_receipt_lines / po_receipt_value and
 * charges_from_grn (renamed from charges_partial, which had become a false
 * claim) so both surfaces can disclose provenance.
 *
 * RECONCILIATION IS THE ACCEPTANCE TEST. With identical filters:
 *   SUM(day.groups) = totals.bills · SUM(day.day_runs) = totals.day_run_bills
 *   SUM(day.lines)  = totals.lines
 *   SUM(day.bill_value)       = totals.bill_value        (the SUBTOTAL column)
 *   SUM(day.total_bill_value) = totals.total_bill_value  (the GRAND TOTAL column)
 *   SUM(day.goods)            = totals.goods             (booked cost, CSV only)
 * to the rupee. Every printed money column has a leg here on purpose: a column
 * a reader can add up, with no stated identity to check it against, is the next
 * silent drift. The totals themselves come from the SAME computeTotals() the
 * bill view uses, so the strip above a day table is not a second opinion.
 *
 * READ-ONLY. This file issues SELECTs and nothing else: no write statement of
 * any kind, no migration. Keep it that way — a report that mutates is a report
 * nobody can safely re-run, and a grep for the three SQL write verbs finding
 * nothing in this file is part of its acceptance, so do not name them here
 * either.
 *
 * The caller (the route) owns the management gate. This is a pure query layer
 * and applies no authorisation of its own.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types (the route and the page import these — keep the shape stable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How firm this bill's identity is. Shown on screen so a reader is never handed
 * 350 rows that all claim to be paper bills.
 *   INV     — our PINV number: one per vendor bill. Firm.
 *   GRN     — a PO receive / ad-hoc GRN: one delivery. Firm, but see §4.
 *   BILL    — the vendor's own printed number. Firm.
 *   DAY_RUN — no bill number anywhere: a vendor-day consolidation. NOT a bill.
 */
export type PurchaseBillKind = 'INV' | 'GRN' | 'BILL' | 'DAY_RUN';

/** How rows with no vendor bill number are grouped. */
export type UnnumberedMode = 'group' | 'split';

export interface PurchaseBillRow {
  /** The derived key. Also lets a reader pivot to /reports/purchase-log. */
  bill_key: string;
  bill_kind: PurchaseBillKind;
  /** MIN(date) of the group — the bill date. YYYY-MM-DD as stored. */
  date: string;
  /** MAX(date). Equal to `date` unless an INV/GRN group spans days. */
  date_to: string;
  /** true when date_to > date — render "<date>…<date_to>", do not hide it. */
  spans_days: boolean;
  /** MIN(vendor) of the group. */
  vendor: string;
  /**
   * COUNT(DISTINCT vendor). Measured 0 multi-vendor groups today; if one ever
   * appears, render "VENDOR (+n more)" rather than letting `vendor` lie.
   */
  vendor_count: number;
  /** OUR number (PINV-yyyy-####). '' when the bill was not hand-entered. */
  invoice_id: string;
  /** The VENDOR'S own number. Often '' — never conflate with invoice_id. */
  bill_no: string;
  /** The GRN behind a PO receive. '' on hand-entered bills. */
  grn_id: string;
  /** true when the vendor's own number is absent. Drives the CSV YES/NO. */
  bill_no_missing: boolean;
  /**
   * true on GRN-keyed bills: PROVENANCE, not absence. The charge figures below
   * were read off the GRN line rather than the cost-mirror `purchases` row.
   * They are the bill's real figures, so print them as numbers — the em-dash
   * this flag used to mean was the bug, see §4.
   */
  tax_on_grn: boolean;
  /**
   * How many of this bill's `lines` took their charges from a GRN line. Ships
   * beside tax_on_grn because the badge is a provenance claim and this is the
   * evidence for it.
   */
  grn_sourced_rows: number;
  /**
   * PO-receipt mirror lines whose GRN line is GONE (a repair, an unfinished
   * void). Their charges are UNAVAILABLE, not zero. When this equals `lines`
   * the renderer must BLANK the charge cells instead of printing Rs 0 — that is
   * isChargeSourceMissingRow() in src/lib/purchase-charges.ts, which the screen
   * and the CSV both call so the two cannot disagree about which cell is empty.
   * 0 rows qualify today; the rule is kept because the failure is silent.
   */
  unpaired_mirror_rows: number;
  /** COUNT(*) of `purchases` rows in the group. No item counts — see §6. */
  lines: number;
  /**
   * Rendered as BOOKED COST (Spend). SUM(total_price) AS STORED — the booked
   * goods cost that feeds valuation. NOT the bill's face value and NOT the
   * Subtotal: on 17 of the 31 PO-receipt lines the booked rate is already net of
   * the discount the GRN itemises (rate 90 against a bill rate of 100), so spend
   * sits Rs 1,620 below the bill. Never recomputed. See §5.
   *
   * ⚠ This field must never be substituted for `bill_value`, and its column must
   * never be dropped in favour of the Subtotal — §4's closing paragraph is the
   * rule, and /reports/purchases' Spend plus stock valuation are what depend on
   * it. Keep the name `goods`: the route, the page and both CSVs bind it.
   */
  goods: number;
  /**
   * Rendered as SUBTOTAL — the ingredients/goods cost the owner asked for, and
   * the base the GRAND TOTAL is built on.
   *
   * The goods value as the BILL charges for it. Equal to `goods` on every
   * hand-entered bill; on a PO receipt it is the GRN line's gross, because the
   * booked rate there may already be net of the discount the GRN itemises and
   * subtracting that discount from it would count it twice. total_bill_value is
   * built on THIS, which is what makes the row foot — and bill_value − goods is
   * exactly the discount already inside the booked rate. Keep the wire name.
   */
  bill_value: number;
  discount: number;
  cgst: number;
  sgst: number;
  /** cgst + sgst. Neither cess is in here — different levy, different base. */
  gst: number;
  compensation_cess: number;
  special_excise_cess: number;
  tcs: number;
  delivery_charges: number;
  mrp_round_off: number;
  /**
   * Rendered as GRAND TOTAL — what is payable to the vendor.
   * Subtotal − Discount + GST + both cesses + TCS + Delivery + MRP round-off.
   */
  total_bill_value: number;
}

export interface PurchaseBillTotals {
  /** Distinct bills matching the filters BEFORE any truncation. */
  bills: number;
  /** `purchases` rows behind them. */
  lines: number;
  /** The period BOOKED COST (Spend) — SUM(total_price) as stored, the figure
   *  that feeds valuation. See PurchaseBillRow.goods. */
  goods: number;
  /** The period SUBTOTAL — see PurchaseBillRow.bill_value. */
  bill_value: number;
  discount: number;
  cgst: number;
  sgst: number;
  gst: number;
  compensation_cess: number;
  special_excise_cess: number;
  tcs: number;
  delivery_charges: number;
  mrp_round_off: number;
  /**
   * The period GRAND TOTAL — the sum of every row's Grand Total, and the one
   * period-wide total this report may legitimately print. See §1.
   */
  total_bill_value: number;
  /** How many of `bills` are PO/GRN receipts whose tax sits on the GRN. */
  po_receipt_bills: number;
  /** `purchases` rows behind those receipts. */
  po_receipt_lines: number;
  /** Their share of the GRAND TOTAL — bill face value, read off the GRN. NOT a
   *  share of the Subtotal: do not subtract it from one. */
  po_receipt_value: number;
  /** `purchases` rows in the period whose charges were read off a GRN line. */
  grn_sourced_lines: number;
  /**
   * PO-receipt mirror rows with no GRN line left to read charges from. Non-zero
   * is a defect worth naming in a caption, not a rounding detail: those rows'
   * charge cells go blank because the figure is unavailable. 0 today.
   */
  unpaired_mirror_lines: number;
  /**
   * How many of `bills` carry no vendor bill number at all (the DAY branch,
   * §3). Computed by SQL over the FULL filtered set, so a footnote can state
   * the period's real figure instead of counting the capped rows in hand.
   */
  day_run_bills: number;
  /**
   * Render verbatim beside the PERIOD grand total. It is the guard on
   * misreading, and since 2026-09-11 it has three figures to keep apart —
   * Subtotal, Grand Total and Booked Cost — not two. See TOTALS_BASIS.
   */
  basis: string;
}

export interface PurchaseBillSummaryResult {
  rows: PurchaseBillRow[];
  totals: PurchaseBillTotals;
  /** true when `bills` exceeded BILL_SUMMARY_MAX_BILLS and rows were capped. */
  truncated: boolean;
  from: string;
  to: string;
  /** Echoed back so the page can show which mode produced these rows. */
  unnumbered: UnnumberedMode;
  include_po_receipts: boolean;
}

/**
 * ONE ROW PER PURCHASE DATE — the day-wise rollup, §7. Every count below is a
 * count of BILLS (groups), not of `purchases` rows, except `lines`.
 */
export interface PurchaseBillDayRow {
  /** The date, YYYY-MM-DD. A bill is attributed to MIN(date) of its group. */
  day: string;
  /** bills + day_runs. The reconciling figure: Σ groups = totals.bills. */
  groups: number;
  /**
   * IDENTIFIED DOCUMENTS only — kinds INV, GRN and BILL. On live this is 0 on
   * 33 of 34 days, which is exactly why it may never be merged with day_runs
   * into a single "Bills" column.
   */
  bills: number;
  /**
   * The DAY/ROW branch: that vendor's purchases for that day, consolidated for
   * reading. NOT paper bills — one may cover several physical bills. Counted by
   * key prefix, the same test as totals.day_run_bills.
   */
  day_runs: number;
  /**
   * COUNT(DISTINCT LOWER(vendor)) across the day's bills, each bill counted
   * under its own MIN(vendor). On a SINGLE-OUTLET all-DAY_RUN day this equals
   * `day_runs` — the DAY key is vendor|date|outlet, so one vendor makes one
   * group. That identity is expected, not a bug. It is NOT an invariant: the
   * outlet is in the key, so one vendor buying for two outlets on one day makes
   * TWO day-runs under ONE vendor (verified on a two-outlet fixture: day_runs 2,
   * vendors 1). Never derive one of these two figures from the other.
   */
  vendors: number;
  /** Bills whose lines name more than one vendor (0 today). Makes `vendors` honest. */
  multi_vendor_bills: number;
  /** Bills on this day whose lines also fall on a later date. See §7. */
  spanning_bills: number;
  /** COUNT(*) of `purchases` rows — the owner's "total items". Never a quantity. */
  lines: number;
  /** BOOKED COST (Spend) — SUM(total_price) AS STORED. Day CSV only; the day
   *  table on screen does not print it. Never the Subtotal. */
  goods: number;
  /** The day's SUBTOTAL — see PurchaseBillRow.bill_value. Printed on the day
   *  table and in the day CSV. */
  bill_value: number;
  discount: number;
  cgst: number;
  sgst: number;
  /** cgst + sgst. Neither cess is in here. */
  gst: number;
  compensation_cess: number;
  special_excise_cess: number;
  tcs: number;
  delivery_charges: number;
  mrp_round_off: number;
  /**
   * The day's GRAND TOTAL, same arithmetic as the bill view. Both CSVs and both
   * screens call it Grand Total; it was "Total Purchase Value" in the day CSV
   * and "Total Bill Value" in the bill CSV until 2026-09-11, which was two names
   * for one figure.
   */
  total_bill_value: number;
  /** How many of `groups` are PO/GRN receipts, whose charges are read off the GRN. */
  po_receipt_bills: number;
  po_receipt_lines: number;
  /** Their share of the GRAND TOTAL — bill face value, read off the GRN. */
  po_receipt_value: number;
  /** Lines on this day whose charges were read off a GRN line. */
  grn_sourced_rows: number;
  /** Mirror lines with no GRN line left to read from — see PurchaseBillRow. */
  unpaired_mirror_rows: number;
  /**
   * true when any of this day's lines took its charges from a GRN line.
   * PROVENANCE, not partiality — the charge figures above are complete WHENEVER
   * `unpaired_mirror_rows` on the same row is 0, which is every row today. It
   * was `charges_partial` until 2026-09-10, when the report stopped reading the
   * receive route's placeholder zeros. See §4 and §7.
   *
   * ⚠ THIS FLAG IS NOT A COMPLETENESS SIGNAL and must not be read as one: it
   * says WHERE the figures came from, not whether they are all there. The
   * completeness question is answered by `unpaired_mirror_rows` — a day holding
   * a receipt whose GRN line was deleted has charges_from_grn = true AND a short
   * grand total. Renderers pair the two (see hasUnpairedMirrorRows in
   * src/lib/purchase-charges.ts).
   */
  charges_from_grn: boolean;
}

/** One row per (day, vendor) — the owner's "vendor-wise bills", drilled down. */
export interface PurchaseBillDayVendorRow {
  day: string;
  vendor: string;
  groups: number;
  bills: number;
  day_runs: number;
  lines: number;
  /** BOOKED COST (Spend) — see PurchaseBillRow.goods. Day CSV only. */
  goods: number;
  /** This vendor-day's SUBTOTAL — see PurchaseBillRow.bill_value. */
  bill_value: number;
  discount: number;
  cgst: number;
  sgst: number;
  gst: number;
  compensation_cess: number;
  special_excise_cess: number;
  tcs: number;
  delivery_charges: number;
  mrp_round_off: number;
  /** The vendor-day GRAND TOTAL — Subtotal − Discount + charges. */
  total_bill_value: number;
  po_receipt_bills: number;
  /** Their share of the GRAND TOTAL — bill face value, read off the GRN. */
  po_receipt_value: number;
  grn_sourced_rows: number;
  unpaired_mirror_rows: number;
  charges_from_grn: boolean;
}

export interface PurchaseBillDaySummaryResult {
  days: PurchaseBillDayRow[];
  /** The per-day, per-vendor breakdown behind `days`. Ordered day DESC, value DESC. */
  vendor_rows: PurchaseBillDayVendorRow[];
  /** The SAME totals the bill view prints — Σ of `days` must equal them. */
  totals: PurchaseBillTotals;
  /** Distinct purchase days in the period, counted in SQL BEFORE any cap. */
  day_count: number;
  /** true when day_count exceeded BILL_SUMMARY_MAX_DAYS and `days` was capped. */
  truncated: boolean;
  /** true when the vendor breakdown hit its own cap — days are still complete. */
  vendor_rows_truncated: boolean;
  from: string;
  to: string;
  unnumbered: UnnumberedMode;
  include_po_receipts: boolean;
}

export interface PurchaseBillFilters {
  from?: string | null;
  to?: string | null;
  vendor?: string | null;
  /** 'split' gives one bill per row for unnumbered purchases. See §3. */
  unnumbered?: string | null;
  /** Default true. Pass '0' / 'false' / false to drop PO receipts. See §4. */
  include_po_receipts?: boolean | string | number | null;
}

/**
 * Hard cap on returned BILLS (not lines). A silently truncated report is a
 * wrong report, so `truncated` rides alongside and every figure in `totals` is
 * computed by SQL over the FULL filtered set — the cap can never distort one.
 */
export const BILL_SUMMARY_MAX_BILLS = 5_000;

/**
 * Hard cap on returned DAY rows. A day view returns at most one row per date
 * that actually has purchases, so on live (34 days for the whole table) this can
 * never bite; it exists so a decade-wide range cannot page the whole history
 * into one response. `day_count` is counted in SQL before the cap, so
 * `truncated` is exact rather than inferred.
 */
export const BILL_SUMMARY_MAX_DAYS = 1_100;

/**
 * Hard cap on the (day, vendor) breakdown rows. Live: ~350 for the whole table.
 * Capped separately from the days so a wide range still returns COMPLETE day
 * rows — the reconciling figures — and only loses drill-down detail.
 */
export const BILL_SUMMARY_MAX_DAY_VENDOR_ROWS = 20_000;

/**
 * Rendered VERBATIM beside the PERIOD grand total, on screen and in BOTH CSVs.
 * It is the single highest-leverage string in this file — the only prose that
 * reaches the reader on every surface — and it is the guard against the ways
 * these figures get misread.
 *
 * 2026-09-10: it used to end "so the total is NOT a tax-inclusive purchase
 * register", which described the old behaviour — the report was summing the
 * receive route's placeholder zeros and the tax genuinely was not in it. The
 * charges are now read off the GRN line, so the total IS the bill face value
 * including tax, and that sentence had to go.
 *
 * 2026-09-11: the columns were renamed to SUBTOTAL and GRAND TOTAL at the
 * owner's request, so this caption now has THREE figures to keep apart instead
 * of two. SUBTOTAL is the bill's own goods value and NOT the booked spend, and
 * that is not a cosmetic choice: the Grand Total foots from it precisely so the
 * discount already sitting inside a PO-receipt's booked rate is subtracted once,
 * in the Discount column, and not twice. Footing from booked spend instead would
 * leave 17 real rows short. SPEND is still SUM(purchases.total_price) as booked
 * and is still the figure that feeds valuation, so the caption must keep saying
 * it is a different number.
 */
const TOTALS_BASIS =
  'One source for the money (the purchases table), so this period total counts every rupee exactly once. '
  + 'GRAND TOTAL is what is payable to the vendor: Subtotal less discount, plus tax, both cesses, TCS, '
  + 'delivery and MRP round-off. SUBTOTAL is the goods themselves at the price the bill charges for them. '
  + 'On a PO/GRN receipt both are read from the GRN line, the bill document, so a receipt totals here '
  + 'what the GRN inward register calls Total Inward — a match worth checking rather than a guarantee, '
  + 'since the register sums every GRN line and this report can only reach a line that has a purchase row '
  + 'behind it. BOOKED COST (Spend) is a THIRD figure: what '
  + 'was booked into stock and what stock valuation is built on, which on a PO receipt can already be net '
  + 'of a discount the bill itemises separately. Do not read the three as one.';

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isYmd = (s: unknown): s is string => typeof s === 'string' && YMD.test(s);
const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * Calendar arithmetic on a YYYY-MM-DD string via UTC, deliberately.
 * `new Date('2026-08-02')` parses as UTC midnight and then renders in the
 * server's local zone, which lands on the previous day west of Greenwich —
 * that is how a "last 30 days" default silently becomes 29 or 31.
 * (Same helper, same reason, as src/lib/purchase-log.ts.)
 */
function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/**
 * Resolve the requested window, defaulting to the last 30 days INCLUSIVE of
 * today in IST (today − 29 … today). Invalid or missing values fall back to the
 * default rather than throwing, and a reversed range is swapped — a report that
 * returns nothing because from > to looks identical to "no purchases".
 */
export function resolveBillSummaryRange(
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
 * THE DATES THE BUSINESS ACTUALLY HAS PURCHASES ON — first and last.
 *
 * 2026-09-11. Both purchase reports opened on a calendar window (this month /
 * this financial year) rather than on the data. On 11 September the owner's
 * purchases ran 1 Apr – 7 Aug, so "this month" held 0 of 2,165 rows and the
 * report opened completely blank. He read the blank page as lost data and
 * reported it as urgent. Nothing was lost; the window was simply somewhere the
 * data is not.
 *
 * A calendar default cannot be fixed by picking a wider calendar window: the
 * financial-year default has the same cliff one day later (on 1 Apr 2027 "this
 * FY" is a one-day window and the whole previous year's book disappears from
 * the widest choice on the page). The only default that cannot go blank is one
 * READ OFF THE DATA, which is what this returns.
 *
 * ⚠ THE SQL SHAPE IS LOAD-BEARING — do not "tidy" it into one aggregate.
 * SQLite only applies its MIN/MAX index shortcut when the aggregate is alone in
 * its own subquery. Measured on the live table (2,165 rows) and on a 12× copy:
 *
 *   SELECT MIN(date), MAX(date) FROM purchases      SCAN  (linear)
 *   two scalar subqueries, as below                 SEARCH (two O(log n) seeks)
 *
 * The bounds are there to keep it a SEARCH and to stop a stray empty-string
 * date sorting to the front and being reported as the first purchase; anything
 * that still comes back malformed is rejected by isYmd and reported as null,
 * and the caller falls back to today.
 */
export interface PurchaseDateSpan {
  /** First date any purchase is recorded on, or null when there are none. */
  first: string | null;
  /** Last date any purchase is recorded on, or null when there are none. */
  last: string | null;
}

export function getPurchaseDateSpan(dbArg?: DatabaseT.Database): PurchaseDateSpan {
  const db = dbArg || getDb();
  const row = db.prepare(`
    SELECT
      (SELECT MIN(date) FROM purchases WHERE date >= '1900-01-01' AND date <= '9999-12-31') AS first_date,
      (SELECT MAX(date) FROM purchases WHERE date >= '1900-01-01' AND date <= '9999-12-31') AS last_date
  `).get() as { first_date?: unknown; last_date?: unknown } | undefined;
  const firstRaw = row?.first_date;
  const lastRaw = row?.last_date;
  return {
    first: isYmd(firstRaw) ? firstRaw : null,
    last: isYmd(lastRaw) ? lastRaw : null,
  };
}

/**
 * The window that shows EVERY purchase: first recorded purchase → today.
 *
 * The far end is today and not the last purchase, because this app allows a
 * bill to be dated ahead (a delivery keyed in before its date). If such a row
 * exists it sits past today, so the end stretches to cover it — "everything"
 * has to mean everything in both directions or the reader is sent looking for
 * rows the widest window on the page cannot reach.
 *
 * BOTH BOUNDS ARE REAL CALENDAR DATES, never a 1970/2099 sentinel: the two date
 * boxes on screen show this window, and the CSV filename carries it. The owner
 * reconciles what he reads against what he exports, so a placeholder date in
 * either would be a document that misstates its own period.
 *
 * With no purchases at all, both ends are today and the report says so in
 * words rather than printing an invented range.
 */
export function resolveAllTimePurchaseRange(
  dbArg?: DatabaseT.Database,
): { from: string; to: string; span: PurchaseDateSpan } {
  const span = getPurchaseDateSpan(dbArg);
  const today = todayIST();
  const from = span.first ?? today;
  const to = span.last && span.last > today ? span.last : today;
  return { from, to, span };
}

/**
 * The kind is read back off the key's own prefix rather than re-derived from
 * the columns, so the two can never disagree about which branch matched.
 * 'ROW:' is the unnumbered = 'split' form of the DAY branch and reports the
 * same kind — it is still a purchase with no vendor bill number (see §3).
 */
function kindFromKey(billKey: string): PurchaseBillKind {
  const i = billKey.indexOf(':');
  switch (i > 0 ? billKey.slice(0, i) : '') {
    case 'INV': return 'INV';
    case 'GRN': return 'GRN';
    case 'BILL': return 'BILL';
    default: return 'DAY_RUN';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The query
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE base SELECT over `purchases`, wrapped twice: once for the period totals
 * (an aggregate over the FULL filtered set) and once for the ordered, capped
 * per-bill rows. Both bind the same parameter list, in the same order.
 *
 * Driven by idx_purchases_date, so the requested range — not the table size —
 * bounds the scan.
 */
function buildBase(f: {
  from: string;
  to: string;
  vendor: string;
  unnumbered: UnnumberedMode;
  includePoReceipts: boolean;
}): { sql: string; params: any[] } {
  const params: any[] = [f.from, f.to];

  // CONTAINS, not equality — same reasoning as purchase-log's venFilter. The
  // filter on screen is a free-text box with a datalist, and a datalist
  // constrains nothing: typing "Metro" against a stored "Metro Cash & Carry Pvt
  // Ltd" matched zero rows and the page rendered a Rs 0 total. A silent wrong
  // answer is worse than a slightly loose match.
  const venFilter = f.vendor
    ? ` AND LOWER(TRIM(p.vendor)) LIKE '%' || LOWER(TRIM(?)) || '%'`
    : '';
  if (f.vendor) params.push(f.vendor);

  // A PO-receive cost mirror: no invoice_id of ours, but a hard grn_id. Must
  // stay identical to branch 2 of the key below, or the flag and the grouping
  // would describe different rows.
  const isPoReceiptExpr = poReceiptMirrorSql('p');

  const poFilter = f.includePoReceipts
    ? ''
    : ` AND NOT (TRIM(COALESCE(p.invoice_id, '')) = '' AND TRIM(COALESCE(p.grn_id, '')) <> '')`;

  // Branch 4. 'group' consolidates a vendor's unnumbered purchases for one day
  // into one readable line; 'split' gives one bill per row. See §3.
  const elseBranch = f.unnumbered === 'split'
    ? `'ROW:' || p.id`
    : `'DAY:' || LOWER(TRIM(p.vendor)) || '|' || p.date || '|' || COALESCE(p.outlet_id, '')`;

  // Precedence: invoice_id (ours) > grn_id (one delivery) > vendor bill number
  // > vendor-day. grn_id sits AHEAD of bill_no on purpose — see §2.
  const billKeyExpr = `CASE
        WHEN TRIM(COALESCE(p.invoice_id, '')) <> '' THEN 'INV:' || TRIM(p.invoice_id)
        WHEN TRIM(COALESCE(p.grn_id, '')) <> ''     THEN 'GRN:' || TRIM(p.grn_id)
        WHEN TRIM(COALESCE(p.bill_no, '')) <> ''    THEN 'BILL:' || LOWER(TRIM(p.vendor)) || '|' || LOWER(TRIM(p.bill_no)) || '|' || p.date || '|' || COALESCE(p.outlet_id, '')
        ELSE ${elseBranch}
      END`;

  // The settled Total Inward definition, evaluated per LINE so that both the
  // per-bill SUM and the period SUM are the same arithmetic. AFTER AGGREGATION
  // THIS IS THE GRAND TOTAL COLUMN — the figure the owner calls "what we
  // actually need to pay the vendor". No part of it changed when the columns
  // were renamed on 2026-09-11.
  //
  // 2026-09-10: it now reads the EFFECTIVE rail. A PO-receive row's charges are
  // NOT on `purchases` — the receive route leaves those columns at zero and the
  // bill's real figures sit on the GRN line. Summing p.cgst here made this
  // module report ₹450.00 for GRN-2026-0007 while the GRN inward register
  // printed ₹484.90 for the same bill, and ₹25,330.00 against the register's
  // ₹30,732.20 across the 29 GRN-sourced bills, 28 of them individually wrong.
  // effectiveLineTotalSql() is the same expression /api/reports/purchases sums
  // and the same arithmetic the register's `inward_value` uses, so the three
  // screens now quote one number per bill. See src/lib/purchase-charges.ts.
  const lineTotalExpr = effectiveLineTotalSql('p', 'gl');

  const sql = withGrnCharges(`
    SELECT
      ${billKeyExpr}                            AS bill_key,
      ${isPoReceiptExpr}                        AS is_po_receipt,
      -- 1 when THIS line's eight charge figures were read off the paired GRN
      -- line rather than off the purchases row. It is the provenance every
      -- renderer needs: a mirror row with no GRN line left (is_po_receipt = 1
      -- and grn_sourced = 0) has charges that are UNAVAILABLE, not zero, and
      -- its cells must go blank instead of printing a filing-grade "Rs 0".
      ${grnSourcedSql('gl')}                    AS grn_sourced,
      p.date                                    AS row_date,
      COALESCE(TRIM(p.vendor), '')              AS vendor,
      COALESCE(TRIM(p.invoice_id), '')          AS invoice_id,
      COALESCE(TRIM(p.bill_no), '')             AS bill_no,
      COALESCE(TRIM(p.grn_id), '')              AS grn_id,
      -- THE THREE ALIASES AND THE COLUMNS THEY BECOME:
      --   goods      → BOOKED COST (Spend)  SUM(total_price) AS STORED (§5),
      --                never recomputed, the figure valuation uses.
      --   bill_value → SUBTOTAL             the same goods as the bill charges
      --                for them; differs from goods only on a PO receipt, where
      --                the booked rate may already be net of the discount the
      --                GRN itemises.
      --   line_total → GRAND TOTAL          built on bill_value, so subtracting
      --                that discount cannot double-count it.
      COALESCE(p.total_price, 0)                AS goods,
      ${effectiveBillValueSql('p', 'gl')}       AS bill_value,
      ${effectiveChargeSql('discount', 'p', 'gl')}            AS discount,
      ${effectiveChargeSql('cgst', 'p', 'gl')}                AS cgst,
      ${effectiveChargeSql('sgst', 'p', 'gl')}                AS sgst,
      ${effectiveChargeSql('compensation_cess', 'p', 'gl')}   AS compensation_cess,
      ${effectiveChargeSql('special_excise_cess', 'p', 'gl')} AS special_excise_cess,
      ${effectiveChargeSql('tcs', 'p', 'gl')}                 AS tcs,
      ${effectiveChargeSql('delivery_charges', 'p', 'gl')}    AS delivery_charges,
      ${effectiveChargeSql('mrp_round_off', 'p', 'gl')}       AS mrp_round_off,
      ${lineTotalExpr}                          AS line_total
    FROM purchases p
    ${grnLineJoinSql('p', 'gl')}
    WHERE p.date >= ? AND p.date <= ?${venFilter}${poFilter}
  `);

  return { sql, params };
}

/**
 * Normalise the caller's filters ONCE, so the bill view and the day view run
 * the same window, the same vendor match and the same PO-receipt default. Two
 * copies of this parsing would be two chances for one view to answer for a
 * period the other did not.
 */
function normaliseFilters(filters: PurchaseBillFilters): {
  from: string;
  to: string;
  vendor: string;
  unnumbered: UnnumberedMode;
  includePoReceipts: boolean;
} {
  const { from, to } = resolveBillSummaryRange(filters.from, filters.to);
  const vendor = String(filters.vendor || '').trim();
  const unnumbered: UnnumberedMode =
    String(filters.unnumbered || '').trim().toLowerCase() === 'split' ? 'split' : 'group';

  // Default INCLUDED. Only an explicit off value drops PO receipts, so a typo
  // in the query string cannot silently understate the period.
  const rawInc = filters.include_po_receipts;
  const incStr = String(rawInc === undefined || rawInc === null ? '' : rawInc).trim().toLowerCase();
  const includePoReceipts = !(rawInc === false || incStr === '0' || incStr === 'false' || incStr === 'no');

  return { from, to, vendor, unnumbered, includePoReceipts };
}

/**
 * The period totals — a single aggregate over the FULL filtered set.
 *
 * Computed by the database, never by summing the (possibly capped) rows, so the
 * cap can never quietly understate the spend. Shared by BOTH views so the strip
 * above a day table is the same arithmetic as the strip above a bill table, and
 * the day rows can be checked against it: a second copy of this SQL would be a
 * second opinion about the same money.
 */
function computeTotals(
  db: DatabaseT.Database,
  base: string,
  params: any[],
): PurchaseBillTotals {
  const agg = db.prepare(`
    SELECT
      COUNT(DISTINCT bill_key)                                        AS bills,
      COUNT(*)                                                        AS lines,
      COALESCE(SUM(goods), 0)                                         AS goods,
      COALESCE(SUM(bill_value), 0)                                    AS bill_value,
      COALESCE(SUM(discount), 0)                                      AS discount,
      COALESCE(SUM(cgst), 0)                                          AS cgst,
      COALESCE(SUM(sgst), 0)                                          AS sgst,
      COALESCE(SUM(compensation_cess), 0)                             AS compensation_cess,
      COALESCE(SUM(special_excise_cess), 0)                           AS special_excise_cess,
      COALESCE(SUM(tcs), 0)                                           AS tcs,
      COALESCE(SUM(delivery_charges), 0)                              AS delivery_charges,
      COALESCE(SUM(mrp_round_off), 0)                                 AS mrp_round_off,
      COALESCE(SUM(line_total), 0)                                    AS total_bill_value,
      COUNT(DISTINCT CASE WHEN is_po_receipt = 1 THEN bill_key END)   AS po_receipt_bills,
      COALESCE(SUM(CASE WHEN is_po_receipt = 1 THEN 1 ELSE 0 END), 0) AS po_receipt_lines,
      COALESCE(SUM(CASE WHEN is_po_receipt = 1 THEN line_total ELSE 0 END), 0) AS po_receipt_value,
      COALESCE(SUM(grn_sourced), 0)                                   AS grn_sourced_lines,
      COALESCE(SUM(CASE WHEN is_po_receipt = 1 AND grn_sourced = 0 THEN 1 ELSE 0 END), 0)
                                                                      AS unpaired_mirror_lines,
      COUNT(DISTINCT CASE WHEN substr(bill_key, 1, 4) IN ('DAY:', 'ROW:') THEN bill_key END) AS day_run_bills
    FROM (${base})
  `).get(...params) as any;

  const cgstT = num(agg?.cgst);
  const sgstT = num(agg?.sgst);
  return {
    bills: num(agg?.bills),
    lines: num(agg?.lines),
    goods: r2(agg?.goods),
    bill_value: r2(agg?.bill_value),
    discount: r2(agg?.discount),
    cgst: r2(cgstT),
    sgst: r2(sgstT),
    gst: r2(cgstT + sgstT),
    compensation_cess: r2(agg?.compensation_cess),
    special_excise_cess: r2(agg?.special_excise_cess),
    tcs: r2(agg?.tcs),
    delivery_charges: r2(agg?.delivery_charges),
    mrp_round_off: r2(agg?.mrp_round_off),
    total_bill_value: r2(agg?.total_bill_value),
    po_receipt_bills: num(agg?.po_receipt_bills),
    po_receipt_lines: num(agg?.po_receipt_lines),
    po_receipt_value: r2(agg?.po_receipt_value),
    grn_sourced_lines: num(agg?.grn_sourced_lines),
    unpaired_mirror_lines: num(agg?.unpaired_mirror_lines),
    day_run_bills: num(agg?.day_run_bills),
    basis: TOTALS_BASIS,
  };
}

/**
 * Build the purchase bill summary for a date range.
 *
 * SELECT only. The caller owns the management gate.
 */
export function getPurchaseBillSummary(
  filters: PurchaseBillFilters = {},
  dbArg?: DatabaseT.Database,
): PurchaseBillSummaryResult {
  const db = dbArg || getDb();
  const { from, to, vendor, unnumbered, includePoReceipts } = normaliseFilters(filters);
  const { sql: base, params } = buildBase({ from, to, vendor, unnumbered, includePoReceipts });

  // TOTALS FIRST, over the FULL filtered set — see computeTotals().
  const totals = computeTotals(db, base, params);

  // ── ROWS ──────────────────────────────────────────────────────────────────
  // Newest bill first. vendor then bill_key are the tie-breaks, so the LIMIT
  // takes a deterministic prefix rather than an arbitrary one.
  const raw = db.prepare(`
    SELECT
      bill_key,
      MIN(row_date)                         AS date_from,
      MAX(row_date)                         AS date_to,
      MIN(vendor)                           AS vendor,
      COUNT(DISTINCT LOWER(vendor))         AS vendor_count,
      MAX(invoice_id)                       AS invoice_id,
      MAX(bill_no)                          AS bill_no,
      MAX(grn_id)                           AS grn_id,
      MAX(is_po_receipt)                    AS is_po_receipt,
      COALESCE(SUM(grn_sourced), 0)         AS grn_sourced_rows,
      COALESCE(SUM(CASE WHEN is_po_receipt = 1 AND grn_sourced = 0 THEN 1 ELSE 0 END), 0)
                                            AS unpaired_mirror_rows,
      COUNT(*)                              AS lines,
      COALESCE(SUM(goods), 0)               AS goods,
      COALESCE(SUM(bill_value), 0)          AS bill_value,
      COALESCE(SUM(discount), 0)            AS discount,
      COALESCE(SUM(cgst), 0)                AS cgst,
      COALESCE(SUM(sgst), 0)                AS sgst,
      COALESCE(SUM(compensation_cess), 0)   AS compensation_cess,
      COALESCE(SUM(special_excise_cess), 0) AS special_excise_cess,
      COALESCE(SUM(tcs), 0)                 AS tcs,
      COALESCE(SUM(delivery_charges), 0)    AS delivery_charges,
      COALESCE(SUM(mrp_round_off), 0)       AS mrp_round_off,
      COALESCE(SUM(line_total), 0)          AS total_bill_value
    FROM (${base})
    GROUP BY bill_key
    ORDER BY date_from DESC,
             vendor COLLATE NOCASE ASC,
             bill_key ASC
    LIMIT ?
  `).all(...params, BILL_SUMMARY_MAX_BILLS) as any[];

  const rows: PurchaseBillRow[] = raw.map((r) => {
    const billKey = String(r.bill_key || '');
    const kind = kindFromKey(billKey);
    const dateFrom = String(r.date_from || '');
    const dateTo = String(r.date_to || '');
    const cgst = num(r.cgst);
    const sgst = num(r.sgst);
    return {
      bill_key: billKey,
      bill_kind: kind,
      date: dateFrom,
      date_to: dateTo,
      spans_days: dateTo > dateFrom,
      vendor: String(r.vendor || ''),
      vendor_count: num(r.vendor_count),
      invoice_id: String(r.invoice_id || ''),
      bill_no: String(r.bill_no || ''),
      grn_id: String(r.grn_id || ''),
      bill_no_missing: String(r.bill_no || '').trim() === '',
      // PROVENANCE, from the KIND — "this bill's charges were read off its GRN
      // line". It is NOT "the charges are missing": since 2026-09-10 they are
      // the bill's real figures and print as numbers. The one row that must
      // still blank its cells is caught by unpaired_mirror_rows below, not by
      // this flag. See §4.
      tax_on_grn: kind === 'GRN',
      grn_sourced_rows: num(r.grn_sourced_rows),
      unpaired_mirror_rows: num(r.unpaired_mirror_rows),
      lines: num(r.lines),
      goods: r2(r.goods),
      bill_value: r2(r.bill_value),
      discount: r2(r.discount),
      cgst: r2(cgst),
      sgst: r2(sgst),
      gst: r2(cgst + sgst),
      compensation_cess: r2(r.compensation_cess),
      special_excise_cess: r2(r.special_excise_cess),
      tcs: r2(r.tcs),
      delivery_charges: r2(r.delivery_charges),
      mrp_round_off: r2(r.mrp_round_off),
      total_bill_value: r2(r.total_bill_value),
    };
  });

  return {
    rows,
    totals,
    truncated: totals.bills > rows.length,
    from,
    to,
    unnumbered,
    include_po_receipts: includePoReceipts,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY-WISE ROLLUP (§7) — the SAME base, aggregated per bill and then per day
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE ROW PER BILL, carrying the day it belongs to. The day rollup and the
 * vendor breakdown both wrap THIS, so they cannot disagree with each other or
 * with the bill view about which day a bill fell on.
 *
 * `bill_day` is MIN(row_date) — the same value PurchaseBillRow.date carries.
 * Grouping the base rows straight by p.date instead would count a bill that
 * straddles midnight once per day it touches, and the day column would stop
 * adding up to the period bill count. `bill_spans_days` rides along so the day
 * that owns such a bill can say so rather than silently absorbing it.
 *
 * `is_day_run` is read off the KEY PREFIX, the identical test computeTotals()
 * uses for day_run_bills — never off bill_no_missing, which would also catch the
 * GRN/INV bills that merely carry no vendor number.
 */
function buildPerBill(base: string): string {
  return `
    SELECT
      bill_key,
      MIN(row_date)                                                        AS bill_day,
      MIN(vendor)                                                          AS bill_vendor,
      COUNT(DISTINCT LOWER(vendor))                                        AS bill_vendors,
      CASE WHEN MAX(row_date) > MIN(row_date) THEN 1 ELSE 0 END            AS bill_spans_days,
      CASE WHEN substr(bill_key, 1, 4) IN ('DAY:', 'ROW:') THEN 1 ELSE 0 END AS is_day_run,
      MAX(is_po_receipt)                                                   AS is_po_receipt,
      COALESCE(SUM(grn_sourced), 0)                                        AS grn_sourced_rows,
      COALESCE(SUM(CASE WHEN is_po_receipt = 1 AND grn_sourced = 0 THEN 1 ELSE 0 END), 0)
                                                                           AS unpaired_mirror_rows,
      COUNT(*)                                                             AS lines,
      COALESCE(SUM(goods), 0)                                              AS goods,
      COALESCE(SUM(bill_value), 0)                                         AS bill_value,
      COALESCE(SUM(discount), 0)                                           AS discount,
      COALESCE(SUM(cgst), 0)                                               AS cgst,
      COALESCE(SUM(sgst), 0)                                               AS sgst,
      COALESCE(SUM(compensation_cess), 0)                                  AS compensation_cess,
      COALESCE(SUM(special_excise_cess), 0)                                AS special_excise_cess,
      COALESCE(SUM(tcs), 0)                                                AS tcs,
      COALESCE(SUM(delivery_charges), 0)                                   AS delivery_charges,
      COALESCE(SUM(mrp_round_off), 0)                                      AS mrp_round_off,
      COALESCE(SUM(line_total), 0)                                         AS total_bill_value
    FROM (${base})
    GROUP BY bill_key
  `;
}

/**
 * Build the DAY-WISE purchase rollup for a date range: one row per purchase
 * date, for the store person reconciling a day's paperwork. See §7.
 *
 * SELECT only. The caller owns the management gate.
 */
export function getPurchaseBillDaySummary(
  filters: PurchaseBillFilters = {},
  dbArg?: DatabaseT.Database,
): PurchaseBillDaySummaryResult {
  const db = dbArg || getDb();
  const { from, to, vendor, unnumbered, includePoReceipts } = normaliseFilters(filters);
  const { sql: base, params } = buildBase({ from, to, vendor, unnumbered, includePoReceipts });

  // The SAME totals object the bill view prints, from the SAME function — so a
  // reader can add the day column up and check it against the strip above.
  const totals = computeTotals(db, base, params);

  const perBill = buildPerBill(base);

  // Distinct purchase days BEFORE the cap, so `truncated` is exact rather than
  // inferred from a full page of rows.
  const dayCountRow = db.prepare(`
    SELECT COUNT(*) AS days FROM (
      SELECT bill_day FROM (${perBill}) GROUP BY bill_day
    )
  `).get(...params) as any;
  const day_count = num(dayCountRow?.days);

  // ── DAYS ──────────────────────────────────────────────────────────────────
  // Newest day first, so a capped response keeps the days a reconciler is most
  // likely to be looking for.
  const rawDays = db.prepare(`
    SELECT
      bill_day                                                              AS day,
      COUNT(*)                                                              AS groups,
      COALESCE(SUM(CASE WHEN is_day_run = 1 THEN 0 ELSE 1 END), 0)          AS bills,
      COALESCE(SUM(is_day_run), 0)                                          AS day_runs,
      COUNT(DISTINCT LOWER(bill_vendor))                                    AS vendors,
      COALESCE(SUM(CASE WHEN bill_vendors > 1 THEN 1 ELSE 0 END), 0)        AS multi_vendor_bills,
      COALESCE(SUM(bill_spans_days), 0)                                     AS spanning_bills,
      COALESCE(SUM(lines), 0)                                               AS lines,
      COALESCE(SUM(goods), 0)                                               AS goods,
      COALESCE(SUM(bill_value), 0)                                          AS bill_value,
      COALESCE(SUM(discount), 0)                                            AS discount,
      COALESCE(SUM(cgst), 0)                                                AS cgst,
      COALESCE(SUM(sgst), 0)                                                AS sgst,
      COALESCE(SUM(compensation_cess), 0)                                   AS compensation_cess,
      COALESCE(SUM(special_excise_cess), 0)                                 AS special_excise_cess,
      COALESCE(SUM(tcs), 0)                                                 AS tcs,
      COALESCE(SUM(delivery_charges), 0)                                    AS delivery_charges,
      COALESCE(SUM(mrp_round_off), 0)                                       AS mrp_round_off,
      COALESCE(SUM(total_bill_value), 0)                                    AS total_bill_value,
      COALESCE(SUM(CASE WHEN is_po_receipt = 1 THEN 1 ELSE 0 END), 0)       AS po_receipt_bills,
      COALESCE(SUM(CASE WHEN is_po_receipt = 1 THEN lines ELSE 0 END), 0)   AS po_receipt_lines,
      COALESCE(SUM(CASE WHEN is_po_receipt = 1 THEN total_bill_value ELSE 0 END), 0) AS po_receipt_value,
      COALESCE(SUM(grn_sourced_rows), 0)                                    AS grn_sourced_rows,
      COALESCE(SUM(unpaired_mirror_rows), 0)                                AS unpaired_mirror_rows
    FROM (${perBill})
    GROUP BY bill_day
    ORDER BY day DESC
    LIMIT ?
  `).all(...params, BILL_SUMMARY_MAX_DAYS) as any[];

  const days: PurchaseBillDayRow[] = rawDays.map((r) => {
    const cgst = num(r.cgst);
    const sgst = num(r.sgst);
    const poBills = num(r.po_receipt_bills);
    return {
      day: String(r.day || ''),
      groups: num(r.groups),
      bills: num(r.bills),
      day_runs: num(r.day_runs),
      vendors: num(r.vendors),
      multi_vendor_bills: num(r.multi_vendor_bills),
      spanning_bills: num(r.spanning_bills),
      lines: num(r.lines),
      goods: r2(r.goods),
      bill_value: r2(r.bill_value),
      discount: r2(r.discount),
      cgst: r2(cgst),
      sgst: r2(sgst),
      gst: r2(cgst + sgst),
      compensation_cess: r2(r.compensation_cess),
      special_excise_cess: r2(r.special_excise_cess),
      tcs: r2(r.tcs),
      delivery_charges: r2(r.delivery_charges),
      mrp_round_off: r2(r.mrp_round_off),
      total_bill_value: r2(r.total_bill_value),
      po_receipt_bills: poBills,
      po_receipt_lines: num(r.po_receipt_lines),
      po_receipt_value: r2(r.po_receipt_value),
      grn_sourced_rows: num(r.grn_sourced_rows),
      unpaired_mirror_rows: num(r.unpaired_mirror_rows),
      // PROVENANCE, not partiality. Until 2026-09-10 this said "part of this
      // day's tax is not on these rows" and it was true; the charges are now
      // read off the GRN line, so the flag only says where some of them were
      // read from. It does NOT certify the day is complete — unpaired_mirror_rows
      // beside it is what answers that, and a day can carry both. See §4 and §7.
      charges_from_grn: num(r.grn_sourced_rows) > 0,
    };
  });

  // ── VENDOR BREAKDOWN ──────────────────────────────────────────────────────
  // The owner's "vendor-wise bills". Kept as its own rows rather than a second
  // count column on the day, because on an all-DAY_RUN day the group count IS
  // the vendor count (the DAY key is vendor|date|outlet) and a column that
  // always equals its neighbour tells a reconciler nothing. Highest value first
  // inside a day: the day that looks wrong is usually one large indent.
  //
  // THE ORDER BY BELOW SORTS ON total_bill_value — i.e. on the GRAND TOTAL, the
  // amount payable, not on the Subtotal. That is deliberate (the vendor you owe
  // the most is the one to look at first) and it is not an oversight left behind
  // by the 2026-09-11 rename. Do not "fix" it to sort by the Subtotal column.
  const rawVendors = db.prepare(`
    SELECT
      bill_day                                                              AS day,
      MIN(bill_vendor)                                                      AS vendor,
      COUNT(*)                                                              AS groups,
      COALESCE(SUM(CASE WHEN is_day_run = 1 THEN 0 ELSE 1 END), 0)          AS bills,
      COALESCE(SUM(is_day_run), 0)                                          AS day_runs,
      COALESCE(SUM(lines), 0)                                               AS lines,
      COALESCE(SUM(goods), 0)                                               AS goods,
      COALESCE(SUM(bill_value), 0)                                          AS bill_value,
      COALESCE(SUM(discount), 0)                                            AS discount,
      COALESCE(SUM(cgst), 0)                                                AS cgst,
      COALESCE(SUM(sgst), 0)                                                AS sgst,
      COALESCE(SUM(compensation_cess), 0)                                   AS compensation_cess,
      COALESCE(SUM(special_excise_cess), 0)                                 AS special_excise_cess,
      COALESCE(SUM(tcs), 0)                                                 AS tcs,
      COALESCE(SUM(delivery_charges), 0)                                    AS delivery_charges,
      COALESCE(SUM(mrp_round_off), 0)                                       AS mrp_round_off,
      COALESCE(SUM(total_bill_value), 0)                                    AS total_bill_value,
      COALESCE(SUM(CASE WHEN is_po_receipt = 1 THEN 1 ELSE 0 END), 0)       AS po_receipt_bills,
      COALESCE(SUM(CASE WHEN is_po_receipt = 1 THEN total_bill_value ELSE 0 END), 0) AS po_receipt_value,
      COALESCE(SUM(grn_sourced_rows), 0)                                    AS grn_sourced_rows,
      COALESCE(SUM(unpaired_mirror_rows), 0)                                AS unpaired_mirror_rows
    FROM (${perBill})
    GROUP BY bill_day, LOWER(bill_vendor)
    ORDER BY day DESC, total_bill_value DESC, vendor COLLATE NOCASE ASC
    LIMIT ?
  `).all(...params, BILL_SUMMARY_MAX_DAY_VENDOR_ROWS + 1) as any[];

  // CAP + 1 fetched, then trimmed: asking for one row more than the cap is what
  // makes `vendor_rows_truncated` EXACT. Testing `length >= CAP` on a CAP-sized
  // fetch cannot tell "exactly full" from "there was more", so an exactly-full
  // page printed "the breakdown is incomplete" over a complete one (reproduced
  // on a 20,000-vendor-row fixture). The days have their own SQL pre-count and
  // need no such trick; a second COUNT here would be a second scan of the same
  // aggregate for one boolean.
  const vendorRowsTruncated = rawVendors.length > BILL_SUMMARY_MAX_DAY_VENDOR_ROWS;
  if (vendorRowsTruncated) rawVendors.length = BILL_SUMMARY_MAX_DAY_VENDOR_ROWS;

  const vendor_rows: PurchaseBillDayVendorRow[] = rawVendors.map((r) => {
    const cgst = num(r.cgst);
    const sgst = num(r.sgst);
    const poBills = num(r.po_receipt_bills);
    return {
      day: String(r.day || ''),
      vendor: String(r.vendor || ''),
      groups: num(r.groups),
      bills: num(r.bills),
      day_runs: num(r.day_runs),
      lines: num(r.lines),
      goods: r2(r.goods),
      bill_value: r2(r.bill_value),
      discount: r2(r.discount),
      cgst: r2(cgst),
      sgst: r2(sgst),
      gst: r2(cgst + sgst),
      compensation_cess: r2(r.compensation_cess),
      special_excise_cess: r2(r.special_excise_cess),
      tcs: r2(r.tcs),
      delivery_charges: r2(r.delivery_charges),
      mrp_round_off: r2(r.mrp_round_off),
      total_bill_value: r2(r.total_bill_value),
      po_receipt_bills: poBills,
      po_receipt_value: r2(r.po_receipt_value),
      grn_sourced_rows: num(r.grn_sourced_rows),
      unpaired_mirror_rows: num(r.unpaired_mirror_rows),
      charges_from_grn: num(r.grn_sourced_rows) > 0,
    };
  });

  return {
    days,
    vendor_rows,
    totals,
    day_count,
    truncated: day_count > days.length,
    vendor_rows_truncated: vendorRowsTruncated,
    from,
    to,
    unnumbered,
    include_po_receipts: includePoReceipts,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV — shared so the download and the on-screen table cannot drift apart
// ─────────────────────────────────────────────────────────────────────────────

export interface PurchaseBillColumn {
  /** Stable machine name. Not necessarily a field on the row. */
  key: string;
  label: string;
  /** Numeric columns skip the spreadsheet-formula guard (it breaks "-12.5"). */
  numeric?: boolean;
  value: (r: PurchaseBillRow) => unknown;
}

/**
 * The three counts the shared blank-vs-zero rule reads, lifted off a bill or a
 * day row. Written once so the CSV and the screen ask the SAME question of the
 * SAME helper (src/lib/purchase-charges.ts) — two copies of "is this cell
 * available?" is how a screen and its download start disagreeing about which
 * cell is empty.
 */
type ChargeSourced = { lines: number; grn_sourced_rows: number; unpaired_mirror_rows: number };
const chargeShape = (r: ChargeSourced) => ({
  count: num(r.lines),
  grn_sourced_rows: num(r.grn_sourced_rows),
  unpaired_mirror_rows: num(r.unpaired_mirror_rows),
});

/**
 * ONE charge cell for a CSV.
 *
 * A real zero goes out as 0 — a bill that carried no cess carried no cess, and
 * blanking it would make the column unsummable. An UNAVAILABLE figure (every
 * line behind it is a PO mirror whose GRN line is gone) goes out EMPTY, because
 * "Rs 0" in a tax column is a claim no query here ever established. The rule
 * lives in chargeCell(); it can only ever blank a cell whose stored sum is also
 * 0, so Σ(cells, blank = 0) is always the column total.
 */
function chargeCsvCell(r: ChargeSourced, key: PurchaseChargeKey, value: number): number | '' {
  const v = chargeCell({ ...chargeShape(r), [key]: value }, { key } as PurchaseChargeColumn);
  return v == null ? '' : v;
}

/**
 * The columns, in the order the screen shows them, so a row reconciles
 * left-to-right: SUBTOTAL − Discount + GST + cesses + TCS + Delivery +
 * Round-off = GRAND TOTAL.
 *
 * SUBTOTAL, NOT BOOKED COST, IS THE BASE — and that is why it is a column and
 * not a footnote. Booked cost is Spend (SUM(total_price) as booked); on 17 of
 * the 31 PO-receipt lines the booked rate is already net of the discount the GRN
 * itemises, so booked cost − discount + charges lands Rs 100 short on those
 * bills and the row does not foot. Both are printed, both are labelled, and
 * their difference IS the discount already inside the booked rate.
 *
 * THE THREE MONEY COLUMNS KEEP THEIR MACHINE KEYS — `goods`, `bill_value`,
 * `total_bill_value`. Only their labels changed on 2026-09-11. The route locates
 * the column to hang a caption's period figure under BY KEY STRING
 * (makeCaptionRow(..., 'total_bill_value')), and a key that matches nothing
 * drops that figure silently, with no error and no failing test.
 *
 * The two trailing prose columns exist because a CSV gets forwarded and opened
 * cold in Excel by someone who never saw the screen's badges or footnote. "Bill
 * No Present" keeps the DAY_RUN caveat (§3) attached to the data, and the
 * charges note keeps the provenance of the charge figures (§4) attached to the
 * numbers.
 */
export const PURCHASE_BILL_COLUMNS: PurchaseBillColumn[] = [
  { key: 'date',                label: 'Date',                    value: r => (r.spans_days ? `${r.date}…${r.date_to}` : r.date) },
  { key: 'bill_no',             label: 'Bill No (vendor)',        value: r => r.bill_no },
  { key: 'bill_no_present',     label: 'Bill No Present',         value: r => (r.bill_no_missing ? 'NO' : 'YES') },
  { key: 'invoice_id',          label: 'Invoice ID (ours)',       value: r => r.invoice_id },
  { key: 'grn_id',              label: 'GRN ID',                  value: r => r.grn_id },
  { key: 'vendor',              label: 'Vendor',                  value: r => (r.vendor_count > 1 ? `${r.vendor} (+${r.vendor_count - 1} more)` : r.vendor) },
  { key: 'bill_kind',           label: 'Bill Identity',           value: r => r.bill_kind },
  { key: 'lines',               label: 'Lines', numeric: true,    value: r => r.lines },
  { key: 'goods',               label: 'Booked Cost = Spend (Rs, what stock valuation uses; NOT the Subtotal)', numeric: true, value: r => r.goods },
  { key: 'bill_value',          label: 'Subtotal (Rs, the goods/ingredients as billed — what Grand Total is built on)', numeric: true, value: r => r.bill_value },
  { key: 'discount',            label: 'Discount (Rs)', numeric: true,          value: r => chargeCsvCell(r, 'discount', r.discount) },
  // GST is the derived pair, so it has no chargeCell of its own; it blanks
  // exactly when both of its parts do, which keeps the three columns consistent.
  { key: 'gst',                 label: 'GST = CGST+SGST (Rs)', numeric: true,   value: r => (chargeCsvCell(r, 'cgst', r.cgst) === '' && chargeCsvCell(r, 'sgst', r.sgst) === '' ? '' : r.gst) },
  { key: 'cgst',                label: 'CGST (Rs)', numeric: true,              value: r => chargeCsvCell(r, 'cgst', r.cgst) },
  { key: 'sgst',                label: 'SGST (Rs)', numeric: true,              value: r => chargeCsvCell(r, 'sgst', r.sgst) },
  { key: 'compensation_cess',   label: 'Compensation Cess (Rs)', numeric: true, value: r => chargeCsvCell(r, 'compensation_cess', r.compensation_cess) },
  { key: 'special_excise_cess', label: 'Spl Excise Cess (Rs)', numeric: true,   value: r => chargeCsvCell(r, 'special_excise_cess', r.special_excise_cess) },
  { key: 'tcs',                 label: 'TCS (Rs)', numeric: true,               value: r => chargeCsvCell(r, 'tcs', r.tcs) },
  { key: 'delivery_charges',    label: 'Delivery Charges (Rs)', numeric: true,  value: r => chargeCsvCell(r, 'delivery_charges', r.delivery_charges) },
  { key: 'mrp_round_off',       label: 'MRP Round Off (Rs)', numeric: true,     value: r => chargeCsvCell(r, 'mrp_round_off', r.mrp_round_off) },
  { key: 'total_bill_value',    label: 'Grand Total (Rs, payable to the vendor = Subtotal - Discount + GST + cesses + TCS + Delivery + Round Off)', numeric: true, value: r => r.total_bill_value },
  {
    // WHERE the charge figures on this row were read from, in the SAME words
    // /api/reports/purchases writes into its own note column — one sentence,
    // one source of truth (src/lib/purchase-charges.ts). It used to say the
    // total was booked cost and the charges were elsewhere; both halves of that
    // stopped being true on 2026-09-10.
    key: 'charges_note',
    label: 'Charges Note',
    value: r => chargeNote(chargeShape(r)),
  },
  { key: 'bill_key',            label: 'Bill Key',                value: r => r.bill_key },
];

/**
 * Escape one CSV field. Free-text (vendor, bill numbers, notes) gets the
 * leading `=+-@` guard — Excel executes those as formulas, and a vendor name is
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
export function purchaseBillSummaryToCsv(rows: PurchaseBillRow[]): string {
  const out: string[] = [PURCHASE_BILL_COLUMNS.map(c => csvCell(c.label, false)).join(',')];
  for (const r of rows) {
    out.push(PURCHASE_BILL_COLUMNS.map(c => csvCell(c.value(r), !!c.numeric)).join(','));
  }
  return out.join('\r\n');
}

/** Filename the download must use: purchase-bill-summary-<from>_<to>.csv */
export function purchaseBillSummaryFilename(from: string, to: string): string {
  return `purchase-bill-summary-${from}_${to}.csv`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DAY-WISE CSV — its OWN columns. PURCHASE_BILL_COLUMNS is not widened to serve
// both: the route pads its caption rows to a column array's length, so one
// array feeding two shapes would put a period total under the wrong heading.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The flat shape the day CSV writes. ONE width for both kinds of row so the file
 * stays a rectangle Excel can sort and filter: a DAY row is the reconciling
 * line, and the VENDOR rows immediately beneath it break that same day down.
 * `Row Type` is column one so a reader can filter to DAY and get exactly the
 * day table they saw on screen.
 */
export interface PurchaseBillDayCsvRow {
  row_type: 'DAY' | 'VENDOR';
  day: string;
  /** '' on a DAY row. */
  vendor: string;
  bills: number;
  day_runs: number;
  groups: number;
  /** '' on a VENDOR row — a vendor breakdown line is one vendor by definition. */
  vendors: number | '';
  /**
   * '' on a VENDOR row. Both of these are properties of the DAY's set of bills,
   * and both exist to stop a neighbouring column being read as more than it is:
   * `vendors` counts each bill under its MIN(vendor) and the VENDOR rows below
   * are grouped the same way, so a bill naming two vendors is filed wholly under
   * the first and the second appears NOWHERE in this file unless this count says
   * so. `spanning_bills` says the same about the Date column.
   */
  multi_vendor_bills: number | '';
  spanning_bills: number | '';
  lines: number;
  /** Printed as BOOKED COST — what stock valuation uses. Not the Subtotal. */
  goods: number;
  /** Printed as SUBTOTAL — the goods as billed, the base of the Grand Total. */
  bill_value: number;
  discount: number;
  gst: number;
  cgst: number;
  sgst: number;
  compensation_cess: number;
  special_excise_cess: number;
  tcs: number;
  delivery_charges: number;
  mrp_round_off: number;
  /** Printed as GRAND TOTAL — Subtotal − Discount + every charge above. */
  total_bill_value: number;
  po_receipt_bills: number;
  /** Those bills' share of the GRAND TOTAL. */
  po_receipt_value: number;
  grn_sourced_rows: number;
  unpaired_mirror_rows: number;
  charges_note: string;
}

export interface PurchaseBillDayColumn {
  key: string;
  label: string;
  numeric?: boolean;
  value: (r: PurchaseBillDayCsvRow) => unknown;
}

/**
 * Day columns, in the order the screen shows them, then the charge split.
 *
 * "Bills (numbered)" and "Vendor day-runs" are deliberately TWO columns with a
 * "Groups" total beside them, never one "Bills" figure — 33 of 34 purchase days
 * on live hold zero numbered bills, so a single column would hand the store
 * person a month of zeros to reconcile against (§7).
 *
 * "Item Lines" is a COUNT of purchase rows. It is NOT a quantity and must never
 * become one: a day spans kg, BTL and CASE lines (§6).
 *
 * THE TRAILING CHARGE COLUMNS ARE COMPLETE, including on a day holding a PO/GRN
 * receipt. (This block claimed they were PARTIAL until 2026-09-11 — a leftover
 * from before the charges moved onto the effective rail on 2026-09-10, and a
 * straight contradiction of §4, §7 and dayChargesNote's own doc below.) What the
 * per-row Charges Note carries is PROVENANCE: where that row's figures were
 * read from. This file gets opened cold by someone who never saw the screen's
 * badges, which is why the note is written per row and not once in a caption.
 *
 * SUBTOTAL − Discount + GST + cesses + TCS + Delivery + Round-off = GRAND TOTAL,
 * on a DAY row and on a VENDOR row alike. Booked Cost sits outside that
 * arithmetic on purpose: it is what stock valuation uses, not what was billed.
 */
export const PURCHASE_BILL_DAY_COLUMNS: PurchaseBillDayColumn[] = [
  { key: 'row_type',            label: 'Row Type',                            value: r => r.row_type },
  { key: 'day',                 label: 'Date',                                value: r => r.day },
  { key: 'vendor',              label: 'Vendor',                              value: r => r.vendor },
  { key: 'bills',               label: 'Bills (numbered)', numeric: true,     value: r => r.bills },
  { key: 'day_runs',            label: 'Vendor Day-Runs (no bill no)', numeric: true, value: r => r.day_runs },
  { key: 'groups',              label: 'Groups (bills + day-runs)', numeric: true,    value: r => r.groups },
  { key: 'vendors',             label: 'Vendors', numeric: true,              value: r => r.vendors },
  // These two qualify the columns beside them and are written PER ROW, not as a
  // footer: a reader who filters this sheet to one date keeps its caveats and
  // loses only other days'. Zero on live today, which is exactly when a silent
  // column is easiest to leave out and hardest to notice missing later.
  { key: 'multi_vendor_bills',  label: 'Multi-Vendor Bills (Vendor col names the first only)', numeric: true, value: r => r.multi_vendor_bills },
  { key: 'spanning_bills',      label: 'Bills Also Dated Later (counted whole on this date)', numeric: true,  value: r => r.spanning_bills },
  { key: 'lines',               label: 'Item Lines', numeric: true,           value: r => r.lines },
  { key: 'goods',               label: 'Booked Cost = Spend (Rs, what stock valuation uses; NOT the Subtotal)', numeric: true, value: r => r.goods },
  { key: 'bill_value',          label: 'Subtotal (Rs, the goods/ingredients as billed — what Grand Total is built on)', numeric: true, value: r => r.bill_value },
  { key: 'discount',            label: 'Discount (Rs)', numeric: true,          value: r => chargeCsvCell(r, 'discount', r.discount) },
  { key: 'gst',                 label: 'GST = CGST+SGST (Rs)', numeric: true,   value: r => (chargeCsvCell(r, 'cgst', r.cgst) === '' && chargeCsvCell(r, 'sgst', r.sgst) === '' ? '' : r.gst) },
  { key: 'cgst',                label: 'CGST (Rs)', numeric: true,              value: r => chargeCsvCell(r, 'cgst', r.cgst) },
  { key: 'sgst',                label: 'SGST (Rs)', numeric: true,              value: r => chargeCsvCell(r, 'sgst', r.sgst) },
  { key: 'compensation_cess',   label: 'Compensation Cess (Rs)', numeric: true, value: r => chargeCsvCell(r, 'compensation_cess', r.compensation_cess) },
  { key: 'special_excise_cess', label: 'Spl Excise Cess (Rs)', numeric: true,   value: r => chargeCsvCell(r, 'special_excise_cess', r.special_excise_cess) },
  { key: 'tcs',                 label: 'TCS (Rs)', numeric: true,               value: r => chargeCsvCell(r, 'tcs', r.tcs) },
  { key: 'delivery_charges',    label: 'Delivery Charges (Rs)', numeric: true,  value: r => chargeCsvCell(r, 'delivery_charges', r.delivery_charges) },
  { key: 'mrp_round_off',       label: 'MRP Round Off (Rs)', numeric: true,     value: r => chargeCsvCell(r, 'mrp_round_off', r.mrp_round_off) },
  // ONE NAME FOR ONE FIGURE. This column and the bill CSV's total both carry the
  // identical arithmetic and used to be labelled "Total Purchase Value" here and
  // "Total Bill Value" there. Both are now GRAND TOTAL; the route's captions say
  // the same word.
  { key: 'total_bill_value',    label: 'Grand Total (Rs, payable to the vendor = Subtotal - Discount + GST + cesses + TCS + Delivery + Round Off)', numeric: true, value: r => r.total_bill_value },
  { key: 'po_receipt_bills',    label: 'Of Which PO/GRN Bills', numeric: true,  value: r => r.po_receipt_bills },
  // Renamed TWICE, both times for the same class of misreading. It was "Of Which
  // Booked Cost" (wrong once the charges moved onto the effective rail), then
  // "Of Which PO/GRN Bill Value" — which turned actively wrong on 2026-09-11,
  // when "Bill Value" became the RETIRED name of the Subtotal: the heading then
  // read as a share of the Subtotal and invited subtracting it from one. It is,
  // and always was, those bills' share of the GRAND TOTAL.
  { key: 'po_receipt_value',    label: 'Of Which PO/GRN Grand Total (Rs)', numeric: true, value: r => r.po_receipt_value },
  { key: 'charges_note',        label: 'Charges Note',                        value: r => r.charges_note },
];

/**
 * WHERE this row's charge figures were read from. Written per row, not once in
 * a caption, because a reader filtering the sheet to a single day would
 * otherwise lose the note with the other rows.
 *
 * It used to warn that the columns were PARTIAL. They are not, any more: the
 * charges come off the GRN line, so a day holding a PO receipt totals its real
 * tax. What the note now carries is provenance (and, if it ever happens, the
 * count of mirror rows with no GRN line left to read) — in the SAME sentence
 * /api/reports/purchases writes, from chargeNote() in purchase-charges.ts.
 */
function dayChargesNote(r: ChargeSourced, poBills: number, poValue: number): string {
  const provenance = chargeNote(chargeShape(r));
  if (!provenance) return '';
  return poBills > 0
    ? `${provenance}. ${poBills} of these groups came from a PO receipt / GRN, carrying Rs ${poValue} of the Grand Total.`
    : provenance;
}

function dayToCsvRow(d: PurchaseBillDayRow): PurchaseBillDayCsvRow {
  return {
    row_type: 'DAY',
    day: d.day,
    vendor: '',
    bills: d.bills,
    day_runs: d.day_runs,
    groups: d.groups,
    vendors: d.vendors,
    multi_vendor_bills: d.multi_vendor_bills,
    spanning_bills: d.spanning_bills,
    lines: d.lines,
    goods: d.goods,
    bill_value: d.bill_value,
    discount: d.discount,
    gst: d.gst,
    cgst: d.cgst,
    sgst: d.sgst,
    compensation_cess: d.compensation_cess,
    special_excise_cess: d.special_excise_cess,
    tcs: d.tcs,
    delivery_charges: d.delivery_charges,
    mrp_round_off: d.mrp_round_off,
    total_bill_value: d.total_bill_value,
    po_receipt_bills: d.po_receipt_bills,
    po_receipt_value: d.po_receipt_value,
    grn_sourced_rows: d.grn_sourced_rows,
    unpaired_mirror_rows: d.unpaired_mirror_rows,
    charges_note: dayChargesNote(d, d.po_receipt_bills, d.po_receipt_value),
  };
}

function dayVendorToCsvRow(v: PurchaseBillDayVendorRow): PurchaseBillDayCsvRow {
  return {
    row_type: 'VENDOR',
    day: v.day,
    vendor: v.vendor,
    bills: v.bills,
    day_runs: v.day_runs,
    groups: v.groups,
    vendors: '',
    // Blank, NOT 0. The vendor breakdown groups bills by MIN(vendor) exactly as
    // `vendors` counts them, so a multi-vendor or spanning bill is a fact about
    // the DAY row above; printing 0 here would assert this vendor's slice is
    // free of both, which this query never established.
    multi_vendor_bills: '',
    spanning_bills: '',
    lines: v.lines,
    goods: v.goods,
    bill_value: v.bill_value,
    discount: v.discount,
    gst: v.gst,
    cgst: v.cgst,
    sgst: v.sgst,
    compensation_cess: v.compensation_cess,
    special_excise_cess: v.special_excise_cess,
    tcs: v.tcs,
    delivery_charges: v.delivery_charges,
    mrp_round_off: v.mrp_round_off,
    total_bill_value: v.total_bill_value,
    po_receipt_bills: v.po_receipt_bills,
    po_receipt_value: v.po_receipt_value,
    grn_sourced_rows: v.grn_sourced_rows,
    unpaired_mirror_rows: v.unpaired_mirror_rows,
    charges_note: dayChargesNote(v, v.po_receipt_bills, v.po_receipt_value),
  };
}

/**
 * Serialise the day rollup: each DAY row followed immediately by the VENDOR rows
 * that make it up, so the sheet reads top-down the way the screen expands.
 * Returns the body WITHOUT the UTF-8 BOM — the caller prepends it.
 *
 * Vendor rows for a day the `days` cap dropped are dropped too: a breakdown with
 * no day above it would read as an orphan total.
 */
export function purchaseBillDaySummaryToCsv(
  days: PurchaseBillDayRow[],
  vendorRows: PurchaseBillDayVendorRow[],
): string {
  const byDay = new Map<string, PurchaseBillDayVendorRow[]>();
  for (const v of vendorRows) {
    const list = byDay.get(v.day);
    if (list) list.push(v); else byDay.set(v.day, [v]);
  }

  const out: string[] = [PURCHASE_BILL_DAY_COLUMNS.map(c => csvCell(c.label, false)).join(',')];
  const write = (r: PurchaseBillDayCsvRow) =>
    out.push(PURCHASE_BILL_DAY_COLUMNS.map(c => csvCell(c.value(r), !!c.numeric)).join(','));

  for (const d of days) {
    write(dayToCsvRow(d));
    for (const v of byDay.get(d.day) || []) write(dayVendorToCsvRow(v));
  }
  return out.join('\r\n');
}

/** Filename the day download must use — distinct from the bill view's, so a
 *  forwarded file never claims to be the other report. */
export function purchaseBillDaySummaryFilename(from: string, to: string): string {
  return `purchase-bill-day-summary-${from}_${to}.csv`;
}
