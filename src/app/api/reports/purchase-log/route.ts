import { getCurrentUser, isManagement } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';
import {
  getPurchaseLog,
  type PurchaseLogRow,
  type PurchaseLogSourceMoney,
} from '@/lib/purchase-log';

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
 * WHAT "NO GRAND TOTAL" DOES **NOT** FORBID — read before deleting the totals
 * ─────────────────────────────────────────────────────────────────────────
 * The ban above is on ONE number spanning the three sources. It never barred
 * totalling a column WITHIN a source, and for a long time this file shipped
 * none, which is why the owner reported "the Total Amount value is not
 * showing": the file had a money column and no figure at the foot of it.
 *
 * The file now carries, PER SOURCE and never merged:
 *   • a column-aligned TOTALS row — each summable column's total sitting under
 *     its own heading, so a spreadsheet reader sees the figure where they look
 *     for it, and Discount/Qty/Rate left EMPTY (never a word, which would
 *     poison a selection sum) with the reason spelled out in the notes block;
 *   • two captioned headline figures, "GOODS VALUE" and "TOTAL AMOUNT", named
 *     apart on purpose — the owner never said which one "Total" meant, and
 *     guessing gives a confidently wrong number;
 *   • the three original DO-NOT-ADD captions, unchanged in meaning;
 *   • a NOTES block listing every column deliberately left without a total and
 *     why, straight from PURCHASE_LOG_NO_TOTAL_NOTES so the screen says the
 *     same words.
 *
 * Every figure comes from `totals` (a SQL aggregate over the FULL filtered set),
 * never from summing `rows`, so the 50,000-row cap cannot understate a total.
 * Column positions are found by findIndex on the header text — a hard-coded
 * index rots the first time a column is inserted, and a totals row under the
 * wrong heading is worse than no totals row.
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
 * CHARGES: the eight per-line charges (discount, CGST, SGST, special excise
 * cess, GST compensation cess, TCS, delivery, MRP round-off) are RECORDED-ONLY
 * — they are carried in their own columns and are NOT folded into `value`.
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

/**
 * RFC-4180 escaping. Vendor and item names here routinely carry commas and quotes.
 *
 * `numeric` is not cosmetic. Text fields get the leading `=+-@` guard, because
 * Excel EXECUTES a cell that starts with one and vendor/item/notes text reaches
 * this file exactly as a user typed it. Numbers must NOT get it: MRP round-off
 * is signed, so a legitimate "-1" would become the text "'-1" and every totals
 * row below it would stop adding up in the reader's own spreadsheet.
 */
const csvCell = (v: unknown, numeric = false): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
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
const COLUMNS: { header: string; cell: (r: PurchaseLogRow) => unknown; numeric?: boolean }[] = [
  { header: 'Source (PURCHASE = booked spend / PO = ordered only / GRN = vendor bill for a booked purchase)', cell: r => r.source },
  { header: 'Date',                        cell: r => r.date },
  { header: 'Document No (PO / GRN / Purchase Invoice)', cell: r => r.doc_no },
  { header: 'Our Invoice ID (PINV, generated by us)',    cell: r => r.invoice_id },
  { header: "Vendor Bill No (the vendor's own number)",  cell: r => r.bill_no },
  { header: 'Vendor',                      cell: r => r.vendor },
  { header: 'Item',                        cell: r => r.material },
  { header: 'SKU',                         cell: r => r.sku },
  { header: 'Category',                    cell: r => r.category },
  { header: 'Qty (purchase units — NOT totalled, every line is in its own unit)', cell: r => r.qty, numeric: true },
  { header: 'Purchase Unit',               cell: r => r.purchase_unit },
  { header: 'Rate (INR per purchase unit; GRN = gross, PURCHASE = net of discount — NOT totalled)', cell: r => r.rate, numeric: true },
  { header: 'Value (INR, qty x rate; charges NOT included; ⚠ PURCHASE rows may be tax-inclusive — see CAVEAT below)', cell: r => r.value, numeric: true },
  // THE column the owner went looking for. Source-aware and blank (not 0) on a
  // PO line, because purchase_order_items stores no charge columns at all — an
  // order has a goods value and no bill amount until it is received and billed.
  // Computed once, in src/lib/purchase-log.ts, as the identical expression
  // /api/grn, /api/purchases and the Purchases page use, so this file foots
  // against the GRN inward register rather than inventing a third convention.
  { header: 'Total Amount (INR, value - discount + CGST + SGST + cesses + TCS + delivery + round-off; blank on PO; ⚠ may equal Value on affected PURCHASE rows — see CAVEAT below)', cell: r => (r.total_amount == null ? '' : r.total_amount), numeric: true },
  // Blank, not 0, on PURCHASE/PO rows: only a GRN records a rejection, and a
  // zero there would read as "nothing was rejected" rather than "not applicable".
  { header: 'Qty Rejected (GRN only)',     cell: r => (r.qty_rejected == null ? '' : r.qty_rejected), numeric: true },
  { header: 'Discount INR (recorded only)',             cell: r => r.discount, numeric: true },
  { header: 'CGST INR (recorded only)',                 cell: r => r.cgst, numeric: true },
  { header: 'SGST INR (recorded only)',                 cell: r => r.sgst, numeric: true },
  { header: 'Special Excise Cess INR (recorded only)',  cell: r => r.special_excise_cess, numeric: true },
  // A DIFFERENT levy from the column above it, and the header says so because in
  // a spreadsheet two adjacent columns both reading "Cess" get summed as one.
  // Special Excise Cess is TGBCL's, non-creditable, and rides on the store bill;
  // this is the GST compensation cess on a normal vendor bill. It is also NOT
  // part of the CGST+SGST invariant — never add it into a GST figure on a return.
  // Blank (not 0) on GRN and PO rows: goods_receipt_note_items has no such
  // column, so a 0 there would assert "no cess was levied" on a bill nobody asked.
  { header: 'Compensation Cess INR (GST comp. cess, recorded only)', cell: r => r.compensation_cess, numeric: true },
  { header: 'TCS INR (recorded only)',                  cell: r => r.tcs, numeric: true },
  { header: 'Delivery Charges INR (recorded only)',     cell: r => r.delivery_charges, numeric: true },
  { header: 'MRP Round Off INR (recorded only)',        cell: r => r.mrp_round_off, numeric: true },
  { header: 'Link Key (ties a GRN line to the purchase row it created)', cell: r => r.link_key },
  { header: 'Notes',                       cell: r => r.notes },
];

/**
 * Column positions, ALWAYS looked up by header text and never written down as a
 * number. Inserting "Total Amount" after "Value" shifted every charge column one
 * to the right; a hard-coded index would have quietly filed the CGST total under
 * Qty Rejected, and a totals row under the wrong heading is worse than none.
 * A prefix that matches nothing yields -1 and is skipped, so a future rewording
 * loses a figure instead of misplacing one.
 */
const colAt = (headerPrefix: string) => COLUMNS.findIndex(c => c.header.startsWith(headerPrefix));
const VALUE_COL = colAt('Value (');
const TOTAL_COL = colAt('Total Amount (');

/**
 * A full-width CSV row: `label` in the Source column, plus any number of figures
 * placed under the headings they belong to.
 *
 * Cell 0 is escaped as TEXT (formula guard on) and every placed figure as
 * NUMERIC (guard off) — a totals row whose signed round-off arrived as text
 * would break the reader's own SUM over the column, which is the one thing this
 * whole block exists to make possible.
 */
function captionRow(label: string, figures?: Array<[number, number | null | undefined]>): string {
  const cells: string[] = COLUMNS.map(() => '');
  const isNum: boolean[] = COLUMNS.map(() => false);
  cells[0] = label;
  for (const [i, v] of figures || []) {
    // i < 0 = header reworded and findIndex missed; v == null = deliberately no
    // total for this column (Discount on PURCHASE, every charge on PO). Both
    // leave the cell EMPTY. Never a dash or a word: text in a money column is
    // what turns a reader's selection-sum into #VALUE!.
    if (i < 0 || v == null) continue;
    cells[i] = String(v);
    isNum[i] = true;
  }
  return cells.map((c, i) => csvCell(c, isNum[i])).join(',');
}

/**
 * The charge columns and where they sit, resolved once by header text.
 * `key` indexes PurchaseLogSourceMoney, whose value is `number | null` — null
 * meaning "no total for this source", which captionRow renders as an empty cell.
 */
const CHARGE_TOTAL_COLS: { key: keyof PurchaseLogSourceMoney; col: number }[] = [
  { key: 'discount',            col: colAt('Discount INR') },
  { key: 'cgst',                col: colAt('CGST INR') },
  { key: 'sgst',                col: colAt('SGST INR') },
  { key: 'special_excise_cess', col: colAt('Special Excise Cess INR') },
  { key: 'compensation_cess',   col: colAt('Compensation Cess INR') },
  { key: 'tcs',                 col: colAt('TCS INR') },
  { key: 'delivery_charges',    col: colAt('Delivery Charges INR') },
  { key: 'mrp_round_off',       col: colAt('MRP Round Off INR') },
];

/** One source's totals, every figure under the heading it belongs to. */
function sourceTotalsRow(label: string, money: PurchaseLogSourceMoney): string {
  const figures: Array<[number, number | null | undefined]> = [
    [VALUE_COL, money.goods_value],
    [TOTAL_COL, money.bill_amount],
  ];
  for (const c of CHARGE_TOTAL_COLS) {
    const v = money[c.key];
    figures.push([c.col, typeof v === 'number' ? v : null]);
  }
  return captionRow(label, figures);
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
      for (const r of rows) lines.push(COLUMNS.map(c => csvCell(c.cell(r), !!c.numeric)).join(','));

      // ── 0. THE CAVEAT — first thing after the data, before any total ─────
      // Placed ahead of every totals section below so a reader hits it before
      // the numbers it qualifies, not after. The wording (static explanation +
      // this window's live figure) comes from src/lib/purchase-log.ts, computed
      // once, so the CSV and the on-screen banner say identical words.
      lines.push(captionRow(''));
      lines.push(captionRow(`!! ${totals.goods_value_caveat}`));

      const m = totals.money;
      // A source the FILTER excluded must not print a totals row at all. With
      // ?source=po the PURCHASE block would otherwise read "0 lines = BOOKED
      // SPEND, Value 0" — which is not "we spent nothing this period", it is
      // "you did not ask about purchases", and a forwarded file cannot tell the
      // two apart. A source that IS in scope but happens to be empty keeps its
      // 0 row, because there the zero is the answer.
      const inScope = (s: 'purchase' | 'po' | 'grn') => source === 'all' || source === s;

      // ── 1. COLUMN-ALIGNED TOTALS, one row per source ─────────────────────
      // Each figure sits under its own heading so a reader who scrolls to the
      // foot of the CGST column finds the CGST total there, not a caption in
      // column A. Empty cells are the deliberate refusals — Discount on the
      // PURCHASE row, every charge on the PO row — and the reasons follow below.
      lines.push(captionRow(''));
      lines.push(captionRow(
        'TOTALS BELOW — each source totalled ON ITS OWN, over every line matching these filters '
        + `(all ${totals.lines}, not only the rows above). The three are NOT additive.`));
      if (inScope('purchase')) lines.push(sourceTotalsRow(`TOTALS — PURCHASE (${totals.purchase_lines} lines) = BOOKED SPEND`, m.PURCHASE));
      if (inScope('grn')) lines.push(sourceTotalsRow(`TOTALS — GRN (${totals.grn_lines} lines) = the vendor bills behind those purchases. DO NOT ADD to PURCHASE`, m.GRN));
      if (inScope('po')) lines.push(sourceTotalsRow(`TOTALS — PO (${totals.po_lines} lines) = ORDERED, not spent. DO NOT ADD to PURCHASE`, m.PO));
      if (source !== 'all') {
        lines.push(captionRow(`Filtered to ${source.toUpperCase()} rows only, so the other sources are not totalled here — their absence is the filter, not a zero.`));
      }

      // ── 2. THE TWO HEADLINE FIGURES, NAMED APART ─────────────────────────
      // "Total Amount" was never defined by the owner, so both readings ship
      // with their own caption and neither is ever called just "Total".
      lines.push(captionRow(''));
      if (inScope('purchase')) {
        lines.push(captionRow(
          `GOODS VALUE — PURCHASE (${totals.purchase_lines} lines): goods only, before tax and before every charge. This is the booked spend. `
          + '⚠ NOT RELIABLE AS TAX-EXCLUSIVE — see the CAVEAT near the top of this section.',
          [[VALUE_COL, m.PURCHASE.goods_value]]));
        lines.push(captionRow(
          `TOTAL AMOUNT — PURCHASE (${totals.purchase_lines} lines): goods + CGST + SGST + cesses + TCS + delivery + round-off, less any discount recorded on the row. `
          + '⚠ MAY EQUAL GOODS VALUE EXACTLY on the affected lines — see the CAVEAT near the top of this section.',
          [[TOTAL_COL, m.PURCHASE.bill_amount]]));
      }
      if (inScope('grn')) {
        lines.push(captionRow(
          `GOODS VALUE — GRN (${totals.grn_lines} lines): the same receipts at gross bill rates, ALREADY inside the PURCHASE figures${inScope('purchase') ? ' above' : ''} — DO NOT ADD.`,
          [[VALUE_COL, m.GRN.goods_value]]));
        lines.push(captionRow(
          `TOTAL AMOUNT — GRN (${totals.grn_lines} lines): what the vendors actually billed, discount deducted. DO NOT ADD to the PURCHASE figure.`,
          [[TOTAL_COL, m.GRN.bill_amount]]));
      }
      if (inScope('po')) {
        lines.push(captionRow(
          `GOODS VALUE — PO (${totals.po_lines} lines): value ORDERED, not money spent — DO NOT ADD to the PURCHASE figure.`,
          [[VALUE_COL, m.PO.goods_value]]));
        lines.push(captionRow(
          'TOTAL AMOUNT — PO: none, and blank rather than zero. An order carries no charge columns, so it has no bill amount until it is received and billed.'));
      }

      lines.push(captionRow(''));
      lines.push(captionRow(`Lines in this file: ${totals.lines}. Period ${from} to ${to} (IST).`));
      lines.push(captionRow('These figures measure different things and are intentionally not summed. Spend = the PURCHASE figures.'));

      // ── 3. WHY THE BLANK CELLS ARE BLANK ─────────────────────────────────
      // Straight from the library so the screen and this file say the same
      // words. An unexplained blank in a money column gets read as a bug and
      // then gets "fixed" by totalling the wrong column instead.
      lines.push(captionRow(''));
      lines.push(captionRow('WHY SOME COLUMNS HAVE NO TOTAL (the blank cells in the totals rows above are deliberate):'));
      for (const n of totals.no_total_notes) lines.push(captionRow(`${n.column} — ${n.reason}`));

      if (truncated) {
        lines.push(captionRow(''));
        lines.push(captionRow('!! TRUNCATED — the row limit was reached, so the ROWS in this file are incomplete. The totals above are still whole: they are computed by the database over every matching line, not by adding the rows printed here. Narrow the date range or filter by vendor/item to see the missing rows.'));
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
