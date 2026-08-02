import { getCurrentUser, isManagement } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';
import { getPurchaseLog, type PurchaseLogRow } from '@/lib/purchase-log';

/* ══════════════════════════════════════════════════════════════════════════
 * PURCHASE LOG — GET /api/reports/purchase-log   (management only)
 *
 * One row per ITEM per DOCUMENT, all three purchase sources interleaved in a
 * single date-ordered log: direct purchases, purchase orders, and GRNs. This is
 * the "show me every line we ever bought, with the bill it came on" report the
 * existing /api/reports/purchases cannot be: that one AGGREGATES spend, this one
 * ENUMERATES lines. Both are kept — this route is purely additive.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DOUBLE-COUNT, AND THE MODEL THIS REPORT COMMITS TO
 * ─────────────────────────────────────────────────────────────────────────
 * Receiving a PO writes BOTH a GRN **and** one `purchases` row per accepted
 * line, inside one transaction (src/app/api/purchase-orders/[id]/receive/route.ts
 * — `insGrnItem.run(...)` then `insPurchase.run(...)`). /api/grn does the same for
 * an ad-hoc GRN. So one physical delivery exists TWICE in the database, on
 * purpose: the GRN row is the vendor's bill document (gross rate, ordered vs
 * received vs rejected, QC), the `purchases` row is the books entry that feeds
 * weighted-average cost and every spend report.
 *
 * A naive UNION of the three sources therefore reports roughly DOUBLE the money
 * actually spent, and the owner would act on that number. The model here:
 *
 *   PURCHASE  = the books basis. THE spend series. Every receipt lands here,
 *               whether it came from a PO, a GRN, or was keyed in directly.
 *   GRN       = the same receipts seen as vendor bill documents. NOT extra
 *               spend — these are the PURCHASE rows again, viewed from the
 *               bill side. `link_key` names the purchases row each GRN line
 *               created (the receive route stamps "(GRN GRN-YYYY-NNNN)" into
 *               purchases.notes, which is what makes the tie-back possible).
 *   PO        = intent. What was ORDERED, at the ordered rate. Money not yet
 *               spent, and possibly never spent (a PO can be part-received,
 *               re-rated at the door, or abandoned).
 *
 * Consequently there is deliberately NO grand-total field anywhere in this
 * route's output. `totals` carries purchase_value / po_value / grn_value as
 * three SEPARATE figures, and the CSV writes them as three separately captioned
 * rows that say in words why they must not be added. If you are ever tempted to
 * add a `total_value`, re-read this block: that single number is the bug.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * UNITS: qty is in PURCHASE units and rate is ₹ per PURCHASE unit on all three
 * sources — no packFactor is applied anywhere in this report (that conversion
 * belongs only where recipe units are involved). The purchase unit ships beside
 * every quantity so a "3" is never silently read as 3 of the recipe unit.
 *
 * RATES: GRN rates are GROSS (what the bill document says); purchases.unit_price
 * is NET of the allocated discount. The same delivery can legitimately show two
 * different rates on two rows. They are labelled, never reconciled silently.
 *
 * CHARGES: the seven per-line charges (discount, CGST, SGST, special excise
 * cess, TCS, delivery, MRP round-off) are RECORDED-ONLY — they are carried in
 * their own columns and are NOT folded into `value`.
 * ══════════════════════════════════════════════════════════════════════════ */

// A purchase report served from cache is a wrong purchase report — the log
// changes every time a bill is keyed in or a PO is received.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = ['all', 'purchase', 'po', 'grn'] as const;
type SourceFilter = (typeof SOURCES)[number];

/** Calendar arithmetic on an IST date string. Never touches the server's zone. */
function shiftIstDays(ymd: string, days: number): string {
  // Parsed as UTC midnight deliberately: the input is already an IST calendar
  // date from todayIST(), so plain day arithmetic on it is exact. Building a
  // local Date here would shift the window by a day on a non-IST server.
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** RFC-4180 escaping. Vendor and item names here routinely carry commas and quotes. */
const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * CSV columns, header and accessor declared together.
 *
 * Kept as one list rather than a header array plus a separate row builder
 * because those two drift: a column inserted in one and not the other silently
 * files every later value under the wrong heading, which on a purchase report
 * means rates printed as quantities.
 *
 * Numbers are emitted RAW — no toLocaleString('en-IN'). Indian grouping puts
 * commas inside the number, which Excel reads as extra columns; the ₹ display
 * formatting belongs on the page, not in a file meant to be summed.
 */
const COLUMNS: { header: string; cell: (r: PurchaseLogRow) => unknown }[] = [
  { header: 'Source (PURCHASE = booked spend / PO = ordered only / GRN = vendor bill for a booked purchase)', cell: r => r.source },
  { header: 'Date',                        cell: r => r.date },
  { header: 'Document No (PO / GRN / Purchase Invoice)', cell: r => r.doc_no },
  { header: 'Our Invoice ID (PINV, generated by us)',    cell: r => r.invoice_id },
  { header: "Vendor Bill No (the vendor's own number)",  cell: r => r.bill_no },
  { header: 'Vendor',                      cell: r => r.vendor },
  { header: 'Item',                        cell: r => r.material },
  { header: 'SKU',                         cell: r => r.sku },
  { header: 'Category',                    cell: r => r.category },
  { header: 'Qty (purchase units)',        cell: r => r.qty },
  { header: 'Purchase Unit',               cell: r => r.purchase_unit },
  { header: 'Rate (INR per purchase unit; GRN = gross, PURCHASE = net of discount)', cell: r => r.rate },
  { header: 'Value (INR, qty x rate; charges NOT included)', cell: r => r.value },
  // Blank, not 0, on PURCHASE/PO rows: only a GRN records a rejection, and a
  // zero there would read as "nothing was rejected" rather than "not applicable".
  { header: 'Qty Rejected (GRN only)',     cell: r => (r.qty_rejected == null ? '' : r.qty_rejected) },
  { header: 'Discount INR (recorded only)',             cell: r => r.discount },
  { header: 'CGST INR (recorded only)',                 cell: r => r.cgst },
  { header: 'SGST INR (recorded only)',                 cell: r => r.sgst },
  { header: 'Special Excise Cess INR (recorded only)',  cell: r => r.special_excise_cess },
  { header: 'TCS INR (recorded only)',                  cell: r => r.tcs },
  { header: 'Delivery Charges INR (recorded only)',     cell: r => r.delivery_charges },
  { header: 'MRP Round Off INR (recorded only)',        cell: r => r.mrp_round_off },
  { header: 'Link Key (ties a GRN line to the purchase row it created)', cell: r => r.link_key },
  { header: 'Notes',                       cell: r => r.notes },
];

const VALUE_COL = COLUMNS.findIndex(c => c.header.startsWith('Value ('));

/** A full-width CSV row with `label` in the Source column and `value` under Value. */
function captionRow(label: string, value?: number): string {
  const cells = COLUMNS.map(() => '');
  cells[0] = label;
  if (value !== undefined && VALUE_COL >= 0) cells[VALUE_COL] = String(value);
  return cells.map(csvCell).join(',');
}

export async function GET(req: Request) {
  try {
    // Same gate, same wording, as /api/reports/purchases — this is the same
    // commercially sensitive data at line-level detail.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

    const sp = new URL(req.url).searchParams;
    const rawFrom = sp.get('from');
    const rawTo = sp.get('to');

    // A malformed date is a 400, never a silent fall-back to the default window:
    // quietly returning a different period than the one asked for is how a
    // purchase report gets read, signed off, and acted on for the wrong month.
    if (rawFrom !== null && !YMD.test(rawFrom)) {
      return Response.json({ error: `Invalid 'from' date "${rawFrom}" — expected YYYY-MM-DD.` }, { status: 400 });
    }
    if (rawTo !== null && !YMD.test(rawTo)) {
      return Response.json({ error: `Invalid 'to' date "${rawTo}" — expected YYYY-MM-DD.` }, { status: 400 });
    }

    // Default window: the last 30 days on the IST calendar, inclusive of today.
    const to = rawTo ?? todayIST();
    const from = rawFrom ?? shiftIstDays(to, -29);
    if (from > to) {
      return Response.json({ error: `'from' (${from}) must be on or before 'to' (${to}).` }, { status: 400 });
    }

    const rawSource = sp.get('source');
    if (rawSource !== null && !SOURCES.includes(rawSource as SourceFilter)) {
      return Response.json(
        { error: `Invalid 'source' "${rawSource}" — expected one of ${SOURCES.join(', ')}.` },
        { status: 400 },
      );
    }
    const source: SourceFilter = (rawSource as SourceFilter) ?? 'all';

    const rawFormat = sp.get('format');
    if (rawFormat !== null && rawFormat !== 'json' && rawFormat !== 'csv') {
      return Response.json({ error: `Invalid 'format' "${rawFormat}" — expected json or csv.` }, { status: 400 });
    }

    const vendor = (sp.get('vendor') || '').trim();
    const material_id = (sp.get('material_id') || '').trim();

    const { rows, totals, truncated } = getPurchaseLog({ from, to, vendor, material_id, source });

    if (rawFormat === 'csv') {
      // csvCell on the HEADER too. Three of these headers contain commas
      // ("Rate (INR per purchase unit; GRN = gross, PURCHASE = net of discount)"),
      // so joining them raw emitted 26 header fields against 23 data fields —
      // Excel then labelled every column from the fifth rightward with the wrong
      // heading, and Rate values appeared under a different column entirely.
      const lines: string[] = [COLUMNS.map(c => csvCell(c.header)).join(',')];
      for (const r of rows) lines.push(COLUMNS.map(c => csvCell(c.cell(r))).join(','));

      // Totals, one caption per source and never a sum of them. The captions
      // carry the reason in words because this file gets forwarded, opened cold
      // in Excel, and totalled by someone who never saw the UI.
      lines.push(captionRow(''));
      lines.push(captionRow(`TOTAL — PURCHASE rows (${rows.filter(r => r.source === 'PURCHASE').length} lines): actual booked spend`, totals.purchase_value));
      lines.push(captionRow(`TOTAL — GRN rows (${rows.filter(r => r.source === 'GRN').length} lines): vendor-bill view of receipts ALREADY counted in the PURCHASE total above — DO NOT ADD to it`, totals.grn_value));
      lines.push(captionRow(`TOTAL — PO rows (${rows.filter(r => r.source === 'PO').length} lines): value ORDERED, not money spent — DO NOT ADD to the PURCHASE total`, totals.po_value));
      lines.push(captionRow(`Lines in this file: ${totals.lines}. Period ${from} to ${to} (IST).`));
      lines.push(captionRow('These three totals measure different things and are intentionally not summed. Spend = the PURCHASE total.'));
      if (truncated) {
        lines.push(captionRow('!! TRUNCATED — the row limit was reached, so this file is INCOMPLETE and the totals above cover only the rows shown. Narrow the date range or filter by vendor/item and download again.'));
      }

      // UTF-8 BOM: without it Excel on Windows decodes the file as ANSI and
      // Indian item and vendor names come out as mojibake.
      const csv = '﻿' + lines.join('\r\n');
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="purchase-log-${from}_${to}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return Response.json(
      { rows, totals, truncated, from, to, vendor, material_id, source },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('[/api/reports/purchase-log]', e);
    return Response.json({ error: e?.message || 'Failed to build purchase log' }, { status: 500 });
  }
}
