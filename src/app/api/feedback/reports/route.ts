/**
 * GET /api/feedback/reports?report=<key>&format=xlsx|pdf&<filters>
 *   — the eight downloads from spec section 3.  (P5 Lane B)
 *
 * THIS FILE EXPORTS `GET` AND NOTHING ELSE. Same structural read-only promise
 * as every other route in this module: the App Router answers 405 for a verb
 * that is not exported, and the only library behind it is SELECT-only.
 *
 * MANAGEMENT ONLY, GATED HERE. `requireFeedbackAnalyst()` is the first
 * statement. A download route that trusted the page's `mgmtOnly` flag would
 * hand an assigned GRE the whole GRE/Manager performance workbook over a plain
 * URL — `proxy.ts` guards PAGES, NOT APIs (hard rule 9).
 *
 * ── THE PATH IS A DELIBERATE SHAPE ──────────────────────────────────────────
 * The report key is a QUERY PARAMETER, never a path segment, and the format is
 * too. Hard rule 9: `isPublic()` in `proxy.ts` used to match a `print`
 * substring and a `.json` suffix and made such routes publicly reachable AND
 * CSRF-exempt. A path like `/api/feedback/reports/print/daily` would have been
 * exactly that hole. `src/lib/feedback.ts:REPORTS` carries the same warning
 * next to the keys themselves.
 *
 * ── NO HAND-BUILT CSV, ON PURPOSE ───────────────────────────────────────────
 * Excel goes through SheetJS `aoa_to_sheet`, which escapes and aligns cells
 * itself. This project has already shipped a RAW-joined heading row that put 32
 * header fields over 30 data fields and filed every tax figure under the wrong
 * heading. Handing an array of arrays to the writer means the header row and
 * the data rows cannot drift: they are the same array shape, and an assertion
 * below proves the widths match before a single byte is written.
 *
 * ── EVERY EXPORT STATES ITS FILTER, INSIDE THE FILE ─────────────────────────
 * The xlsx gets a "Report" sheet whose first rows are the period and every
 * filter in force; the PDF carries them under the header and in the footnotes.
 * A spreadsheet that does not say it is one floor on one night will be read as
 * the whole venue for the month.
 *
 * ── MONEY ───────────────────────────────────────────────────────────────────
 * There is none. This module reads no price, no total and no tax, so the
 * `report-pdf.ts` rupee-glyph trap ("Rs", never the missing U+20B9) cannot bite
 * here — but `buildReportPdf()` is shared with the WhatsApp report rail, so do
 * not introduce a currency column without reading its header first.
 */

import * as XLSX from 'xlsx';
import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import { requireFeedbackAnalyst } from '@/lib/feedback/session';
import { buildReportPdf, istStamp } from '@/lib/report-pdf';
import { layoutMeasure, printableLabels } from '@/lib/feedback/labels';
import {
  analytics, buildReport, filtersFromQuery, isReportKey, rangeForReport,
  type ReportDoc, type ReportTable,
} from '@/lib/feedback/reporting';

/** Filename-safe: lower case, digits, dash. Never a path separator, never a
 *  quote — the value lands inside a `Content-Disposition` header. */
function safeSlug(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
    || 'report';
}

/**
 * A sheet is the filter block, then the KPIs, then each table with its own
 * heading. `aoa_to_sheet` is given ONE array of arrays, so the header row and
 * the data rows are the same structure by construction.
 */
function sheetFor(doc: ReportDoc, t: ReportTable): XLSX.WorkSheet {
  const aoa: (string | number)[][] = [];
  aoa.push([doc.title]);
  aoa.push([t.name]);
  aoa.push([]);
  for (const line of doc.filters) aoa.push([line]);
  aoa.push([]);

  const header = t.columns.map((c) => c.label);
  aoa.push(header);

  for (const row of t.rows) {
    // The assertion the tax-report incident earned: a row that is not exactly
    // as wide as its header is padded (or truncated) HERE, visibly, instead of
    // sliding every later value one column left in the reader's spreadsheet.
    const fixed = row.slice(0, header.length);
    while (fixed.length < header.length) fixed.push('');
    aoa.push(fixed);
  }

  if (t.rows.length === 0 && t.emptyNote) aoa.push([t.emptyNote]);
  if (t.note) { aoa.push([]); aoa.push([t.note]); }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = t.columns.map((c) => ({ wch: Math.max(10, Math.round((c.width ?? 1) * 14)) }));
  return ws;
}

/** Sheet names: Excel refuses > 31 chars and the characters : \ / ? * [ ]. */
function safeSheetName(name: string, taken: Set<string>): string {
  let s = String(name ?? 'Sheet').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = 2;
  while (taken.has(s.toLowerCase())) {
    const suffix = ` ${n++}`;
    s = `${s.slice(0, 31 - suffix.length)}${suffix}`;
  }
  taken.add(s.toLowerCase());
  return s;
}

function workbookFor(doc: ReportDoc): Buffer {
  const wb = XLSX.utils.book_new();
  const taken = new Set<string>();

  const cover: (string | number)[][] = [
    [doc.title],
    [doc.subtitle],
    [],
    ['Filters in force'],
    ...doc.filters.map((l) => [l]),
    [],
    ['Summary'],
    ['Measure', 'Value', 'Basis'],
    ...doc.kpis.map((k) => [k.label, k.value, k.sub ?? '']),
    [],
    ['Notes'],
    ...doc.footnotes.map((f) => [f]),
    [],
    [`Generated ${istStamp()} IST`],
  ];
  const wsCover = XLSX.utils.aoa_to_sheet(cover);
  wsCover['!cols'] = [{ wch: 44 }, { wch: 18 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, wsCover, safeSheetName('Report', taken));

  for (const t of doc.tables) {
    XLSX.utils.book_append_sheet(wb, sheetFor(doc, t), safeSheetName(t.name, taken));
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/* ── THE PRINTED NAME IS NOT THE STORED NAME ─────────────────────────────────
   `report-pdf.ts` truncates every cell to one line with a trailing ellipsis and
   never wraps, and that was collapsing DISTINCT menu items into IDENTICAL
   printed rows — 58 of the 628 real items into 28 strings, "… CHARDONNAY
   BOTTLE" and "… CHARDONNAY GLASS" among them. `src/lib/feedback/labels.ts`
   carries the measurement and the rule; this is where it is applied, and it is
   applied to the PDF PATH ONLY — the xlsx keeps the full string, because a
   spreadsheet cell does not truncate and people sort and VLOOKUP on it.

   The geometry below is the renderer's own: A4 portrait, margin 40, PAD 4,
   weights normalised over CONTENT_W, `Helvetica` 8. Measuring with the same
   pdfkit document class is what makes "it fits here" mean "it fits there".
   One throwaway document per PDF request, negligible beside rendering it. */

const PDF_CONTENT_W = 595.28 - 40 * 2;
const PDF_PAD = 4;

async function pdfFor(doc: ReportDoc): Promise<Buffer> {
  // Same class, font, size and geometry as the renderer — see the block above.
  const { default: PDFDocument } = await import('pdfkit');
  const probe = new PDFDocument({ size: 'A4', margin: 40 });
  probe.font('Helvetica').fontSize(8);
  // NOT `widthOfString` on its own. `doc.text(s, x, y, { width })` lays text out
  // WORD BY WORD, and word-by-word is wider than the whole string by whatever
  // kern straddles a word boundary — which cost two real menu names their last
  // word on the page while measuring as a fit. `layoutMeasure` charges that
  // back; the long comment lives in labels.ts beside the arithmetic.
  const measure = layoutMeasure((s: string) => probe.widthOfString(s));

  const fitted = doc.tables.map((t) => {
    const totalW = t.columns.reduce((sum, c) => sum + (Number(c.width) || 1), 0);
    const widths = t.columns.map((c) => ((Number(c.width) || 1) / totalW) * PDF_CONTENT_W);
    const maps = t.columns.map((c, i) =>
      (c.fitPrint
        ? printableLabels(measure, t.rows.map((r) => String(r[i] ?? '')), widths[i] - PDF_PAD * 2)
        : null));
    if (maps.every((m) => m === null)) return t;
    return {
      ...t,
      rows: t.rows.map((r) => r.map((cell, i) => maps[i]?.get(String(cell ?? '')) ?? cell)),
    };
  });

  return buildReportPdf({
    title: doc.title,
    period: doc.period,
    subtitle: doc.subtitle,
    kpis: doc.kpis,
    tables: fitted.map((t) => ({
      title: t.name,
      columns: t.columns.map((c) => ({ label: c.label, width: c.width ?? 1, align: c.align })),
      rows: t.rows,
      note: t.note,
      emptyNote: t.emptyNote,
    })),
    // The filters go in the footnotes as well as the header, because the
    // header is one line and a reader who prints page 3 must still be able to
    // tell what the numbers were filtered to.
    footnotes: [...doc.filters, ...doc.footnotes],
  });
}

export async function GET(req: Request) {
  const gate = await requireFeedbackAnalyst();
  if (!gate.ok) return Response.json(gate.body, { status: gate.status });

  const sp = new URL(req.url).searchParams;
  const key = (sp.get('report') ?? '').trim();
  const format = (sp.get('format') ?? 'xlsx').trim().toLowerCase();

  if (!isReportKey(key)) {
    return Response.json(
      { error: `Unknown report '${key}'. Expected one of: daily, weekly, monthly, menu-item, returned-remade, negative, gre-performance, guest-recovery.` },
      { status: 400 },
    );
  }
  if (format !== 'xlsx' && format !== 'pdf') {
    return Response.json({ error: `Unknown format '${format}'. Expected xlsx or pdf.` }, { status: 400 });
  }

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) ?? '';
    // Daily / Weekly / Monthly force their own period — a "Monthly" download
    // must never quietly contain one day because a chip was left on Today.
    const filters = rangeForReport(key, filtersFromQuery(sp));
    const payload = analytics(db, { outletId, filters });
    const doc = buildReport(payload, key);

    const name = `feedback-${safeSlug(doc.slug)}_${payload.range.fromDate}_to_${payload.range.toDate}`;

    if (format === 'pdf') {
      const pdf = await pdfFor(doc);
      return new Response(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${name}.pdf"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const xlsx = workbookFor(doc);
    return new Response(new Uint8Array(xlsx), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${name}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    console.error('[/api/feedback/reports GET]', e);
    // A failed export must be a visible error, not a zero-byte file the reader
    // would open, see nothing in, and conclude there were no complaints.
    return Response.json({ error: e?.message || 'Failed to build the report' }, { status: 500 });
  }
}
