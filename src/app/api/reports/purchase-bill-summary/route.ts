import { getCurrentUser, isManagement } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';
import {
  getPurchaseBillSummary,
  purchaseBillSummaryToCsv,
  purchaseBillSummaryFilename,
  PURCHASE_BILL_COLUMNS,
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

// Where a caption's number goes: under the last money column, so a reader
// scanning the right-hand edge of the sheet finds the period figure directly
// beneath the column it totals.
const TOTAL_COL = PURCHASE_BILL_COLUMNS.findIndex(c => c.key === 'total_bill_value');

/**
 * A caption row with the SAME field count as the header and every data row.
 * Built from PURCHASE_BILL_COLUMNS.length rather than a hand-typed run of
 * commas: a column added to the table and not to the captions would otherwise
 * shift the totals under the wrong heading, which on a money report is the
 * worst possible silent failure.
 */
function captionRow(label: string, value?: number): string {
  const cells = PURCHASE_BILL_COLUMNS.map(() => '');
  cells[0] = label;
  if (value !== undefined && TOTAL_COL >= 0) cells[TOTAL_COL] = String(value);
  return cells.map(csvCell).join(',');
}

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

    // Free text, LIKE-contains in the lib — a datalist on the page constrains
    // nothing, and vendor names are keyed by hand with inconsistent case and
    // spacing. Passed through unchanged; the lib parameterises it.
    const vendor = (sp.get('vendor') || '').trim();

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
      { rows, totals, truncated, from, to, vendor, unnumbered, include_po_receipts: include_po_receipts ? 1 : 0 },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('[/api/reports/purchase-bill-summary]', e);
    return Response.json({ error: e?.message || 'Failed to build purchase bill summary' }, { status: 500 });
  }
}
