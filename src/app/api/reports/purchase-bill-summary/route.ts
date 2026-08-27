import { getCurrentUser, isManagement } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';
import {
  getPurchaseBillSummary,
  getPurchaseBillDaySummary,
  purchaseBillSummaryToCsv,
  purchaseBillSummaryFilename,
  purchaseBillDaySummaryToCsv,
  purchaseBillDaySummaryFilename,
  PURCHASE_BILL_COLUMNS,
  PURCHASE_BILL_DAY_COLUMNS,
} from '@/lib/purchase-bill-summary';

/* ══════════════════════════════════════════════════════════════════════════
 * PURCHASE BILL SUMMARY — GET /api/reports/purchase-bill-summary  (mgmt only)
 *
 * ONE ROW PER VENDOR BILL: Date · Bill No · Vendor · goods subtotal · the
 * charge columns · Total Bill Value. Requirement 69. The sibling
 * /api/reports/purchase-log ENUMERATES lines; /api/reports/purchases
 * AGGREGATES spend by material; this one rolls the money up to the BILL. All
 * three are kept — this route is purely additive and writes nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT A "BILL" IS HERE — it is DERIVED, not stored
 * ─────────────────────────────────────────────────────────────────────────
 * `purchases` holds ONE ROW PER ITEM. There is no bills table. The grouping
 * key is built in SQL in src/lib/purchase-bill-summary.ts, in this precedence,
 * and the `bill_kind` on every row tells the reader which branch caught it:
 *
 *   INV     invoice_id  — OUR PINV-<yyyy>-####, minted one per vendor bill by
 *                         the hand-entry path. Where present it IS the bill.
 *   GRN     grn_id      — one GRN = one delivery = one vendor bill event, all
 *                         its purchases rows stamped in one transaction.
 *   BILL    vendor|bill_no|date|outlet — the vendor's own printed number.
 *   DAY_RUN vendor|date|outlet        — NO vendor bill number at all. This is
 *                         the overwhelming majority of the data. Such a group
 *                         is that vendor's purchases for that day consolidated
 *                         FOR READING; it may cover more than one physical
 *                         bill or market run, and the row says so
 *                         (bill_no_missing = true). Do not present it as a
 *                         paper bill. ?unnumbered=split un-consolidates it to
 *                         one row per purchases row for anyone who needs that.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DOUBLE-COUNT — and why THIS report may legitimately print ONE total
 * ─────────────────────────────────────────────────────────────────────────
 * Receiving a PO writes po_vendor_bills + a GRN header + GRN items + one
 * `purchases` row per line, in ONE transaction. The same money sits in three
 * tables on purpose (read the header of src/lib/purchase-log.ts — it is the
 * definitive explanation). /api/reports/purchase-log therefore returns totals
 * PER SOURCE and never sums them.
 *
 * This report reads the `purchases` table ALONE. goods_receipt_note_items,
 * goods_receipt_notes, po_vendor_bills and purchase_order_items are never
 * touched, so the restatement of the same money cannot enter any figure and a
 * single grand total is safe BY CONSTRUCTION. If you are ever tempted to join
 * the GRN tables back in to "enrich" a PO-receive bill with its tax, stop:
 * that is the edit that turns this report into the ~2× number the purchase-log
 * header exists to prevent.
 *
 * PO-received bills DO appear (a delivery against a PO is a real vendor bill;
 * excluding it would understate the period). But a PO-receive `purchases` row
 * is a deliberately TAX-FREE COST MIRROR — the receive route binds discount to
 * a literal 0 and writes no CGST/SGST, because tax inside unit_price would
 * poison average_price; the tax lives on the GRN line, which is the bill
 * document. So those rows carry tax_on_grn = true, render em-dashes rather
 * than a lying "0" in the tax columns, and their Total Bill Value is BOOKED
 * COST (goods + allocated delivery), NOT the vendor's bill face value. The
 * CSV captions below state that split in words, because this file gets
 * forwarded and opened cold by someone who never saw the page.
 * ?include_po_receipts=0 drops them for anyone who wants hand-entered bills
 * alone. Default 1 (included).
 *
 * MONEY: Total Bill Value is the existing Total Inward definition, unchanged —
 * goods − discount + cgst + sgst + comp cess + spl excise cess + tcs +
 * delivery + mrp round-off. GST on screen and in the file is cgst + sgst ONLY
 * (the house invariant tax_value = cgst + sgst); the two cesses are DIFFERENT
 * levies on a different base and keep their own columns. Never fold them in.
 *
 * UNITS: this report reads NEITHER `quantity` NOR `unit_price` — a bill spans
 * kg, BTL and CASE lines, so a summed quantity would be a number with no unit.
 * It reports a `lines` count instead. There is consequently no rate × quantity
 * product anywhere in it and nothing for scripts/check-rate-basis.js to judge.
 * Adding an "avg rate" column would create that pairing; declare its basis if
 * you ever do.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ?view=day — THE DAY-WISE ROLLUP (same gate, same source, same bill key)
 * ─────────────────────────────────────────────────────────────────────────
 * ?view=day answers "what did we buy on each date" for the store person
 * reconciling a day's paperwork: date · numbered bills · vendor day-runs ·
 * vendors · item lines · total purchase value, plus a per-day per-vendor
 * breakdown. It is served by getPurchaseBillDaySummary(), a THIRD wrapper over
 * the SAME base SELECT in the same lib file — NOT a second query, NOT a second
 * definition of a bill, and NOT a new page (the route and the nav entry already
 * exist, so page-catalog.ts and Sidebar.tsx are untouched). Both views run this
 * one GET behind the one management gate.
 *
 * TWO COUNTS, NEVER ONE. MEASURED on live: 33 of 34 purchase days hold ZERO
 * numbered bills, and April — 99.3% of the spend — is 100% day-runs. A single
 * "Bills" column would hand the store person a month of zeros, so `bills`
 * (identified documents) and `day_runs` (vendor-day consolidations) are
 * separate on the row, in the JSON and in the CSV, with `groups` as their sum
 * for reconciliation only.
 *
 * THE EM-DASH RULE SURVIVES THE AGGREGATE. A day mixing PO/GRN receipts with
 * hand-entered bills has PARTIAL charge columns — the receipts' tax is on the
 * GRN. Such days carry po_receipt_* and charges_partial, the screen shows no
 * per-day charge columns at all, and every affected CSV row carries its own
 * Charges Note. Do not "simplify" that into a clean per-day GST cell: on
 * 2026-08-07 it would print Rs 1,125 while 29 taxed bills contribute a
 * structural zero.
 *
 * RECONCILIATION: Σ day.groups = totals.bills, Σ day.lines = totals.lines,
 * Σ day.total_bill_value = totals.total_bill_value, Σ day.day_runs =
 * totals.day_run_bills — to the rupee, because `totals` is the SAME object the
 * bill view returns, from the same function.
 * ══════════════════════════════════════════════════════════════════════════ */

// A purchase report served from cache is a wrong purchase report — a bill keyed
// in a minute ago must appear on the next load.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Shape AND calendar validity. The regex alone is not enough: "2026-13-01" and
 * "2026-02-30" both match \d{4}-\d{2}-\d{2}, and SQLite's string comparison
 * would happily accept them as range bounds — "2026-13-01" sorts ABOVE every
 * real December date, so a typo'd month would silently return a window nobody
 * asked for. Round-tripping through UTC catches both: Date.UTC rolls the
 * overflow forward (2026-13-01 → 2027-01-01) and the strings stop matching.
 */
function isRealYmd(s: string): boolean {
  if (!YMD.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10) === s;
}

/**
 * Calendar arithmetic on a YYYY-MM-DD string via UTC, deliberately — the same
 * reasoning as addDaysYmd() in purchase-log.ts. The input is already an IST
 * calendar date from todayIST(), so plain day arithmetic on it is exact;
 * building a local Date here would shift the default window by a day on a
 * server that is not in IST.
 */
function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/**
 * Escape one CSV caption field, matching the lib's rule exactly: the leading
 * `=+-@` guard so Excel cannot execute a caption as a formula, then RFC-4180
 * quoting. The captions below contain commas and rupee figures, and at least
 * one of them is a sentence long.
 */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Bind a caption writer to ONE column array, so a caption row always has the
 * SAME field count as the header and every data row of the file it is in.
 *
 * Built from the array's length rather than a hand-typed run of commas: a column
 * added to the table and not to the captions would otherwise shift the totals
 * under the wrong heading, which on a money report is the worst possible silent
 * failure. It is a factory rather than one function because the bill view and
 * the day view have DIFFERENT column arrays — feeding both from one array would
 * put a day total under a bill heading, which is the same failure by another
 * route.
 *
 * The caption's number goes under the last money column, so a reader scanning
 * the right-hand edge of the sheet finds the period figure directly beneath the
 * column it totals.
 */
function makeCaptionRow(columns: { key: string }[], totalKey: string) {
  const totalCol = columns.findIndex(c => c.key === totalKey);
  return function captionRow(label: string, value?: number): string {
    const cells = columns.map(() => '');
    cells[0] = label;
    if (value !== undefined && totalCol >= 0) cells[totalCol] = String(value);
    return cells.map(csvCell).join(',');
  };
}

const captionRow = makeCaptionRow(PURCHASE_BILL_COLUMNS, 'total_bill_value');
const dayCaptionRow = makeCaptionRow(PURCHASE_BILL_DAY_COLUMNS, 'total_bill_value');

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export async function GET(req: Request) {
  try {
    // FIRST, before any param parsing — a malformed query from a signed-out
    // caller must answer 401, never leak a 400 that confirms the route exists
    // and describes its parameters. Same gate and same wording as
    // /api/reports/purchase-log (lines 147-149) and /api/reports/purchases:
    // this is vendor-level spend with GST on it, and the page-catalog mgmtOnly
    // flag only hides a nav link — THIS is the security boundary.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

    const sp = new URL(req.url).searchParams;
    const rawFrom = sp.get('from');
    const rawTo = sp.get('to');

    // A bad date is a 400 naming the value, never a silent fall-back to the
    // default window. Quietly answering for a different period than the one
    // asked for is how a purchase report gets read, signed off and paid on for
    // the wrong month. (resolvePurchaseLogRange() in the lib layer defaults
    // instead of throwing — which is right for a lib, wrong for an HTTP
    // boundary, so the route resolves the window itself and hands the lib two
    // already-valid dates.)
    if (rawFrom !== null && !isRealYmd(rawFrom)) {
      return Response.json(
        { error: `Invalid 'from' date "${rawFrom}" — expected a real calendar date as YYYY-MM-DD.` },
        { status: 400 },
      );
    }
    if (rawTo !== null && !isRealYmd(rawTo)) {
      return Response.json(
        { error: `Invalid 'to' date "${rawTo}" — expected a real calendar date as YYYY-MM-DD.` },
        { status: 400 },
      );
    }

    // Default window: the last 30 days on the IST calendar, inclusive of today.
    const to = rawTo ?? todayIST();
    const from = rawFrom ?? addDaysYmd(to, -29);
    // Reversed range is a 400 here rather than a silent swap: at the HTTP
    // boundary the caller stated two bounds and one of them is wrong, and a
    // download whose filename says a period it did not cover is a document
    // that outlives the mistake.
    if (from > to) {
      return Response.json(
        { error: `'from' (${from}) must be on or before 'to' (${to}).` },
        { status: 400 },
      );
    }

    const rawFormat = sp.get('format');
    if (rawFormat !== null && rawFormat !== 'json' && rawFormat !== 'csv') {
      return Response.json({ error: `Invalid 'format' "${rawFormat}" — expected json or csv.` }, { status: 400 });
    }

    // How the unnumbered rows are presented: 'group' consolidates them per
    // vendor-day, 'split' gives one row per purchases row. MEASURED: 2,121 of
    // 2,165 rows reach the DAY_RUN branch, so this switch governs the bulk of
    // the report. (2,151 rows have a blank bill_no — the 30-row gap is the
    // PO/GRN receipts, which carry no vendor number but are keyed by grn_id
    // and so never fall through to DAY_RUN.)
    const rawUnnumbered = sp.get('unnumbered');
    if (rawUnnumbered !== null && rawUnnumbered !== 'group' && rawUnnumbered !== 'split') {
      return Response.json(
        { error: `Invalid 'unnumbered' "${rawUnnumbered}" — expected group or split.` },
        { status: 400 },
      );
    }
    const unnumbered: 'group' | 'split' = (rawUnnumbered as 'group' | 'split') ?? 'group';

    // Strict 0/1 rather than a truthiness test: "false" and "no" are truthy
    // strings, so a caller trying to exclude PO receipts with ?…=false would
    // get them included and never know. Refuse instead.
    const rawIncludePo = sp.get('include_po_receipts');
    if (rawIncludePo !== null && rawIncludePo !== '0' && rawIncludePo !== '1') {
      return Response.json(
        { error: `Invalid 'include_po_receipts' "${rawIncludePo}" — expected 0 or 1.` },
        { status: 400 },
      );
    }
    const include_po_receipts = rawIncludePo !== '0';

    // Which rollup: one row per BILL (the original report) or one row per DAY
    // (the store person's reconciliation view). Validated against the two legal
    // values exactly like format/unnumbered above — a typo must 400, never fall
    // back to the other view and answer a question nobody asked. Both modes sit
    // behind the SAME management gate above; there is no second entry point.
    const rawView = sp.get('view');
    if (rawView !== null && rawView !== 'bill' && rawView !== 'day') {
      return Response.json(
        { error: `Invalid 'view' "${rawView}" — expected bill or day.` },
        { status: 400 },
      );
    }
    const view: 'bill' | 'day' = (rawView as 'bill' | 'day') ?? 'bill';

    // Free text, LIKE-contains in the lib — a datalist on the page constrains
    // nothing, and vendor names are keyed by hand with inconsistent case and
    // spacing. Passed through unchanged; the lib parameterises it.
    const vendor = (sp.get('vendor') || '').trim();

    // ── DAY-WISE ROLLUP ───────────────────────────────────────────────────
    // A THIRD wrapper over the same base SELECT in the same lib file, so the
    // two views cannot disagree about what a bill is or which day it fell on.
    // `totals` is the SAME object the bill view returns, which is what makes
    // the day column checkable: it must add up to the strip above it.
    if (view === 'day') {
      const daySummary = getPurchaseBillDaySummary({
        from,
        to,
        vendor,
        unnumbered,
        include_po_receipts,
      });
      const { days, vendor_rows, totals: dayTotals, day_count } = daySummary;

      if (rawFormat === 'csv') {
        const lines: string[] = [purchaseBillDaySummaryToCsv(days, vendor_rows)];

        lines.push(dayCaptionRow(''));
        lines.push(dayCaptionRow(
          `TOTAL PURCHASE VALUE — ${day_count} purchase day${day_count === 1 ? '' : 's'}, `
          + `${dayTotals.lines} item lines, period ${from} to ${to} (IST). `
          + 'Goods less discount plus CGST+SGST, both cesses, TCS, delivery and MRP round-off. '
          + 'Filter the Row Type column to DAY and this figure is the sum of that column.',
          r2(dayTotals.total_bill_value),
        ));
        // THE central caveat of this view. A single "bills per day" number would
        // be a lie on live data: most days hold no numbered bill at all.
        lines.push(dayCaptionRow(
          `Of the ${dayTotals.bills} groups in this period, ${dayTotals.bills - dayTotals.day_run_bills} are NUMBERED BILLS `
          + `(our invoice id, a GRN, or the vendor's own bill number) and ${dayTotals.day_run_bills} are VENDOR DAY-RUNS with no bill `
          + 'number anywhere — '
          // The DEFINITION of a day-run changes with the mode, so this clause has
          // to change with it. Under split each day-run IS one purchase line, and
          // calling it "consolidated into one line" here — six rows above the MODE
          // caption that says the opposite — put two contradictory definitions of
          // the same column inside one file.
          + (unnumbered === 'split'
            ? 'under unnumbered=split each one is a SINGLE purchase line of that vendor rather than a day consolidation, so '
            : "that vendor's purchases for that day consolidated into one line for reading. A day-run may cover more "
              + 'than one physical bill or market run, so ')
          + 'the two counts are kept in SEPARATE columns and must not be added into a '
          + '"bills per day" figure. Both period counts are computed in SQL over the whole period, not off the rows in this file.',
        ));
        lines.push(dayCaptionRow(
          '"Item Lines" is a COUNT of purchase rows, NOT a quantity. A day spans kg, BTL and CASE lines, so a summed quantity '
          + 'would be a number with no unit. There is deliberately no quantity and no rate column in this file.',
        ));
        // Only when one actually occurred. Both are 0 on today's data, so this
        // caption stays out of the file a store person normally opens — and the
        // day it appears, it is about a row in front of them. The per-row columns
        // carry the fact regardless; this only explains what they mean.
        const mvBills = days.reduce((s, d) => s + (d.multi_vendor_bills || 0), 0);
        const spBills = days.reduce((s, d) => s + (d.spanning_bills || 0), 0);
        if (mvBills > 0 || spBills > 0) {
          lines.push(dayCaptionRow(
            `${mvBills} bill${mvBills === 1 ? '' : 's'} in this period name MORE THAN ONE VENDOR and ${spBills} also carry a LATER DATE. `
            + 'Both are filed WHOLE under ONE of their vendor names and their EARLIEST date, so '
            + 'the other vendor does NOT get a VENDOR row of its own and the later date does NOT get that money. The two columns beside '
            + '"Vendors" count exactly which days are affected; open the By bill view for those bills line by line.',
          ));
        }
        lines.push(dayCaptionRow(
          `Goods subtotal ${r2(dayTotals.goods)} · Discount ${r2(dayTotals.discount)} · GST (CGST+SGST) ${r2(dayTotals.gst)} `
          + `· Compensation Cess ${r2(dayTotals.compensation_cess)} · Special Excise Cess ${r2(dayTotals.special_excise_cess)} `
          + `· TCS ${r2(dayTotals.tcs)} · Delivery ${r2(dayTotals.delivery_charges)} · MRP Round-off ${r2(dayTotals.mrp_round_off)}`,
        ));
        lines.push(dayCaptionRow(
          'GST above is CGST+SGST ONLY. The two cess columns are separate levies on a different base '
          + 'and are deliberately NOT inside the GST figure — do not add them into a GST return.',
        ));
        // The em-dash rule carried into the aggregate: on a day holding a PO/GRN
        // receipt the charge columns are PARTIAL, and every such row says so in
        // its own Charges Note rather than relying on this caption surviving a
        // filter or a sort.
        lines.push(dayCaptionRow(
          `${dayTotals.po_receipt_bills} of the ${dayTotals.bills} groups came from a PO receipt or GRN. Their tax and gross discount `
          + 'are recorded on the GRN document, NOT on these cost rows, so on any day containing one the Discount / GST / cess columns '
          + 'are PARTIAL and that share of the value is BOOKED COST (goods + allocated delivery), not vendor bill face value. The '
          + '"Of Which" columns and the per-row Charges Note mark exactly which days and vendors are affected.',
          r2(dayTotals.po_receipt_value),
        ));
        // A bill is attributed to MIN(date) of its group, so a bill spanning
        // midnight lands WHOLE on its first day. State the rule: a reader
        // comparing a day against a delivery note must know it is not split.
        lines.push(dayCaptionRow(
          'A bill is counted ONCE, on the first date it carries. A bill whose lines span two dates is NOT split across days — its '
          + 'whole value sits on its first day, which is why the day column adds up to the period total exactly.',
        ));
        // The unnumbered mode CHANGES what a per-day group count means: under
        // split, groups collapse to lines. Echo it, or a ticked checkbox turns
        // "bills per day" into "lines per day" with no visible change of caption.
        lines.push(dayCaptionRow(
          unnumbered === 'split'
            ? 'MODE: unnumbered=SPLIT — un-numbered purchases are one group per purchase line, so the Vendor Day-Runs column counts '
              + 'LINES, not vendor-days. Re-download with unnumbered=group for the consolidated view.'
            : 'MODE: unnumbered=GROUP (the default) — un-numbered purchases are consolidated per vendor per day, so the Vendor '
              + 'Day-Runs column counts vendor-days. Re-download with unnumbered=split for one group per purchase line.',
        ));
        lines.push(dayCaptionRow(dayTotals.basis));
        if (!include_po_receipts) {
          lines.push(dayCaptionRow('FILTERED: PO/GRN receipts were EXCLUDED from this file (include_po_receipts=0). Hand-entered bills only.'));
        }
        if (vendor) lines.push(dayCaptionRow(`FILTERED: vendor contains "${vendor}".`));
        if (daySummary.truncated) {
          lines.push(dayCaptionRow(
            `!! TRUNCATED — this period holds ${day_count} purchase days and only the ${days.length} most recent were written. The totals `
            + 'are computed in SQL over the full period and remain correct, so they will NOT equal the sum of the day rows above. '
            + 'Narrow the date range and download again.',
          ));
        }
        if (daySummary.vendor_rows_truncated) {
          lines.push(dayCaptionRow(
            '!! The per-vendor breakdown rows hit their limit and are incomplete. The DAY rows are still complete and correct — '
            + 'filter the Row Type column to DAY.',
          ));
        }

        const csv = '﻿' + lines.join('\r\n');
        return new Response(csv, {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${purchaseBillDaySummaryFilename(from, to)}"`,
            'Cache-Control': 'no-store',
          },
        });
      }

      return Response.json(
        {
          view: 'day',
          days,
          vendor_rows,
          totals: dayTotals,
          day_count,
          truncated: daySummary.truncated,
          vendor_rows_truncated: daySummary.vendor_rows_truncated,
          from,
          to,
          vendor,
          unnumbered,
          include_po_receipts: include_po_receipts ? 1 : 0,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const { rows, totals, truncated } = getPurchaseBillSummary({
      from,
      to,
      vendor,
      unnumbered,
      include_po_receipts,
    });

    if (rawFormat === 'csv') {
      // Header AND data from the shared serialiser, so the file and the screen
      // cannot drift and the header is escaped by the same csvCell as the data.
      // (purchase-log's route once joined its headers raw at line 197: three
      // headers contained commas, so Excel read 26 header fields against 23
      // data fields and mislabelled every column from the fifth rightward.)
      const lines: string[] = [purchaseBillSummaryToCsv(rows)];

      lines.push(captionRow(''));
      lines.push(captionRow(
        `TOTAL BILL VALUE — ${totals.bills} bills, ${totals.lines} item lines, period ${from} to ${to} (IST). `
        + 'Goods less discount plus CGST+SGST, both cesses, TCS, delivery and MRP round-off.',
        r2(totals.total_bill_value),
      ));
      lines.push(captionRow(
        `Goods subtotal ${r2(totals.goods)} · Discount ${r2(totals.discount)} · GST (CGST+SGST) ${r2(totals.gst)} `
        + `· Compensation Cess ${r2(totals.compensation_cess)} · Special Excise Cess ${r2(totals.special_excise_cess)} `
        + `· TCS ${r2(totals.tcs)} · Delivery ${r2(totals.delivery_charges)} · MRP Round-off ${r2(totals.mrp_round_off)}`,
      ));
      lines.push(captionRow(
        'GST above is CGST+SGST ONLY. The two cess columns are separate levies on a different base '
        + 'and are deliberately NOT inside the GST figure — do not add them into a GST return.',
      ));
      // The PO-receipt split, in words. Without it the grand total reads as a
      // tax-inclusive purchase register, which for these rows it is not.
      lines.push(captionRow(
        `Of that, ${totals.po_receipt_bills} of the ${totals.bills} bills came from a PO receipt or GRN. `
        + 'Their tax and gross discount are recorded on the GRN document, NOT on these cost rows, so their value below '
        + 'is BOOKED COST (goods + allocated delivery) and NOT the vendor bill face value. Open /reports/purchase-log '
        + 'for the GRN side of those bills.',
        r2(totals.po_receipt_value),
      ));
      // DAY_RUN count is counted off the ROWS in this file, not off `totals` —
      // PurchaseBillTotals has no day_run_bills member, and inventing one by
      // scaling would be a guess. Counting the rows is exact for the file the
      // reader is holding; when the cap bit, the sentence says so rather than
      // implying it covers the period.
      const dayRuns = rows.filter(r => r.bill_kind === 'DAY_RUN').length;
      lines.push(captionRow(
        `${dayRuns} of the ${rows.length} groups written to this file have NO vendor bill number`
        + (truncated ? ` (the full period holds ${totals.bills} groups — see the truncation note below)` : '')
        + ". They are that vendor's purchases for that day consolidated into one line for reading — one such group may "
        + 'cover more than one physical bill or market run. The "Bill No Present" column says which. '
        + 'Re-download with unnumbered=split for one row per purchase line.',
      ));
      // The lib's own words, verbatim, rather than a paraphrase — two
      // statements of the same rule drift, and this is the rule that stops
      // someone adding this total to the Purchase Log's per-source totals.
      lines.push(captionRow(totals.basis));
      if (!include_po_receipts) {
        lines.push(captionRow('FILTERED: PO/GRN receipts were EXCLUDED from this file (include_po_receipts=0). Hand-entered bills only.'));
      }
      if (vendor) lines.push(captionRow(`FILTERED: vendor contains "${vendor}".`));
      if (truncated) {
        lines.push(captionRow(
          '!! TRUNCATED — the bill limit was reached, so the ROWS above are incomplete. The totals are computed in SQL '
          + 'over the full period and remain correct, so they will NOT equal the sum of the rows shown. Narrow the date '
          + 'range or filter by vendor and download again.',
        ));
      }

      // UTF-8 BOM, prepended ONCE and only here (purchaseBillSummaryToCsv
      // returns a bare body for exactly this reason). Without it Excel on
      // Windows decodes the file as ANSI and Indian vendor names come out as
      // mojibake; with it twice, a stray glyph lands in the first header cell.
      const csv = '﻿' + lines.join('\r\n');
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${purchaseBillSummaryFilename(from, to)}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return Response.json(
      // include_po_receipts echoes back as the 0/1 the caller sent, not a
      // boolean, so the page can round-trip its own query string unchanged.
      // `view` echoes too, so a client holding two responses can tell which
      // rollup it is looking at without inspecting the shape.
      { view: 'bill', rows, totals, truncated, from, to, vendor, unnumbered, include_po_receipts: include_po_receipts ? 1 : 0 },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('[/api/reports/purchase-bill-summary]', e);
    return Response.json({ error: e?.message || 'Failed to build purchase bill summary' }, { status: 500 });
  }
}
