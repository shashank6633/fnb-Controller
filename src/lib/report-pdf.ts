import PDFDocument from 'pdfkit';

/**
 * REPORT PDF CHROME — the A4 page every WhatsApp report attachment is drawn on.
 *
 * This module owns LAYOUT ONLY. It computes no business figure, reads no table
 * and knows nothing about sales, stock or calls: a builder hands it finished
 * rows and it draws them. That separation is the whole point — a number that
 * appears on a PDF must have come from the same function the screen calls, so
 * there is nowhere in here for a second, disagreeing calculation to hide.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE RUPEE SIGN IS NOT AVAILABLE. USE "Rs".                               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * pdfkit's built-in Helvetica is WinAnsi-encoded and has no U+20B9 glyph; a '₹'
 * drawn with it comes out as a blank box or a mojibake pair on the recipient's
 * viewer. src/lib/bill-pdf.ts hit this first and prints 'Rs ' for the same
 * reason. inr() below is therefore the ONLY money formatter this file exposes,
 * and it emits 'Rs'. WhatsApp message text is plain UTF-8 and has no such
 * limit, so the message body may (and does) use '₹' — the two differ on
 * purpose, not by accident.
 *
 * PAGINATION IS FIXED-HEIGHT, NOT FLOWING. Every cell is truncated to one line
 * with an ellipsis rather than wrapped. A wrapped cell makes row height depend
 * on content, which makes the page break depend on content, which is how a
 * 200-row table silently becomes a 40-page PDF that blows the 10 MB attachment
 * cap the send rail enforces. Truncation is visible; a runaway PDF is not.
 */

/** A4 portrait, in points. */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
/** Where the body must stop so the footer line is never written over. */
const BODY_BOTTOM = PAGE_H - MARGIN - 22;

const INK = '#111111';
const MUTED = '#666666';
const RULE = '#cccccc';
const HEAD_BG = '#f0f0f0';

export type PdfAlign = 'left' | 'right' | 'center';

export interface PdfColumn {
  label: string;
  /** Share of the table width. Weights are normalised, so they need not sum to 1. */
  width: number;
  align?: PdfAlign;
}

export interface PdfTable {
  title?: string;
  columns: PdfColumn[];
  /** Pre-formatted cells. Numbers are stringified as-is — format money with inr(). */
  rows: (string | number)[][];
  /** Printed under the table in small grey type — caveats, bases, exclusions. */
  note?: string;
  /** Shown in place of the grid when `rows` is empty. */
  emptyNote?: string;
}

export interface PdfKpi {
  label: string;
  value: string;
  /** Optional second line under the value — a comparison, a count, a basis. */
  sub?: string;
}

export interface ReportPdfSpec {
  /** Big line at the top — the report's name. */
  title: string;
  /** The business/outlet the figures belong to. */
  businessName?: string;
  /** The period the figures cover, already formatted for a human. */
  period?: string;
  /** One sentence under the header saying what the reader is looking at. */
  subtitle?: string;
  kpis?: PdfKpi[];
  tables?: PdfTable[];
  /** Printed at the end — bases, known limitations, who to ask. */
  footnotes?: string[];
  /** Stamped in the footer. Defaults to now. Injectable so tests are stable. */
  generatedAtMs?: number;
}

/* ═══════════════ formatters (shared with the message builders) ═══════════════ */

const NUM = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NUM0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** Money for a PDF cell. 'Rs' — see the header note about the missing glyph. */
export function inr(n: unknown): string {
  const v = Number(n) || 0;
  return (v < 0 ? '-Rs ' : 'Rs ') + NUM.format(Math.abs(v));
}

/** Money for a WHATSAPP MESSAGE (UTF-8, so the real sign is fine). */
export function inrText(n: unknown): string {
  const v = Number(n) || 0;
  return (v < 0 ? '-₹' : '₹') + NUM.format(Math.abs(v));
}

/** Signed money for a message — a variance of exactly 0 reads '₹0.00', not '+₹0.00'. */
export function inrSignedText(n: unknown): string {
  const v = Number(n) || 0;
  if (v > 0) return '+₹' + NUM.format(v);
  return inrText(v);
}

/** Whole-number count with Indian grouping. */
export function count(n: unknown): string {
  return NUM0.format(Math.round(Number(n) || 0));
}

/** A quantity: up to 3 decimals, trailing zeros dropped ('2.5', not '2.500'). */
export function qty(n: unknown): string {
  const v = Number(n) || 0;
  return String(Math.round(v * 1000) / 1000);
}

/** IST 'DD/MM/YYYY hh:mm am' for the footer stamp. */
export function istStamp(ms?: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(new Date(ms ?? Date.now())).replace(',', '');
}

/** IST 'Wed 09 Sep 2026' for a period label. Pass a YYYY-MM-DD. */
export function humanDate(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return String(ymd || '');
  // Noon UTC keeps the date on the same IST calendar day whichever way the
  // timezone shift lands, so 'humanDate' can never print yesterday.
  const d = new Date(`${ymd}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  }).format(d);
}

/* ═══════════════ the renderer ═══════════════ */

/** One line, hard-truncated to `w` points with an ellipsis. Never wraps. */
function fit(doc: PDFKit.PDFDocument, text: string, w: number): string {
  const s = String(text ?? '');
  if (!s) return '';
  if (doc.widthOfString(s) <= w) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(s.slice(0, mid) + '…') <= w) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo) + '…' : '';
}

/**
 * Render a report to PDF bytes. PURE: no DB, no settings, no clock beyond the
 * injectable `generatedAtMs`. Never throws for empty input — a spec with no
 * tables produces a one-page PDF carrying its header and its footnotes, which
 * is what a caller who has already decided to send an empty-ish report wants.
 * (A report with NOTHING to say should not reach here at all: the builders
 * return `empty` and the job skips the send.)
 */
export function buildReportPdf(spec: ReportPdfSpec): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [PAGE_W, PAGE_H],
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,               // required to stamp "page n of m" at the end
    autoFirstPage: true,
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const stampMs = spec.generatedAtMs ?? Date.now();

  /** Start a new page when `need` points will not fit above the footer. */
  const room = (need: number) => {
    if (doc.y + need > BODY_BOTTOM) { doc.addPage(); doc.y = MARGIN; }
  };

  /* ── header ─────────────────────────────────────────────────────────── */
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(17)
    .text(String(spec.title || 'Report'), MARGIN, MARGIN, { width: CONTENT_W });
  if (spec.businessName) {
    doc.font('Helvetica').fontSize(10).fillColor(MUTED)
      .text(String(spec.businessName), MARGIN, doc.y + 1, { width: CONTENT_W });
  }
  if (spec.period) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
      .text(String(spec.period), MARGIN, doc.y + 2, { width: CONTENT_W });
  }
  if (spec.subtitle) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
      .text(String(spec.subtitle), MARGIN, doc.y + 3, { width: CONTENT_W });
  }
  doc.moveDown(0.5);
  doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).strokeColor(RULE).lineWidth(1).stroke();
  doc.y += 12;

  /* ── KPI grid — three per row, boxed ─────────────────────────────────── */
  const kpis = Array.isArray(spec.kpis) ? spec.kpis : [];
  if (kpis.length) {
    const perRow = 3;
    const gap = 10;
    const cellW = (CONTENT_W - gap * (perRow - 1)) / perRow;
    for (let i = 0; i < kpis.length; i += perRow) {
      const slice = kpis.slice(i, i + perRow);
      const cellH = slice.some(k => k.sub) ? 50 : 38;
      room(cellH + 8);
      const y = doc.y;
      slice.forEach((k, j) => {
        const x = MARGIN + j * (cellW + gap);
        doc.rect(x, y, cellW, cellH).fillColor(HEAD_BG).fill();
        doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
          .text(fit(doc, k.label.toUpperCase(), cellW - 12), x + 6, y + 6, { width: cellW - 12 });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(13)
          .text(fit(doc, k.value, cellW - 12), x + 6, y + 17, { width: cellW - 12 });
        if (k.sub) {
          doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
            .text(fit(doc, k.sub, cellW - 12), x + 6, y + 35, { width: cellW - 12 });
        }
      });
      doc.y = y + cellH + 8;
    }
    doc.y += 4;
  }

  /* ── tables ─────────────────────────────────────────────────────────── */
  for (const t of (spec.tables || [])) {
    const cols = (t.columns || []).filter(Boolean);
    if (!cols.length) continue;
    const totalW = cols.reduce((s, c) => s + (Number(c.width) || 1), 0);
    const widths = cols.map(c => ((Number(c.width) || 1) / totalW) * CONTENT_W);
    const xs: number[] = [];
    let acc = MARGIN;
    for (const w of widths) { xs.push(acc); acc += w; }

    const headerH = 16;
    const rowH = 14;
    const PAD = 4;

    const drawHead = () => {
      const y = doc.y;
      doc.rect(MARGIN, y, CONTENT_W, headerH).fillColor(HEAD_BG).fill();
      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK);
      cols.forEach((c, i) => {
        doc.text(fit(doc, c.label, widths[i] - PAD * 2), xs[i] + PAD, y + 4.5,
          { width: widths[i] - PAD * 2, align: c.align || 'left', lineBreak: false });
      });
      doc.y = y + headerH;
    };

    room(30);
    if (t.title) {
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
        .text(String(t.title), MARGIN, doc.y, { width: CONTENT_W });
      doc.y += 3;
    }

    const rows = Array.isArray(t.rows) ? t.rows : [];
    if (!rows.length) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED)
        .text(String(t.emptyNote || 'Nothing to show for this period.'), MARGIN, doc.y, { width: CONTENT_W });
      doc.y += 14;
    } else {
      room(headerH + rowH * 2);
      drawHead();
      for (const r of rows) {
        if (doc.y + rowH > BODY_BOTTOM) { doc.addPage(); doc.y = MARGIN; drawHead(); }
        const y = doc.y;
        doc.font('Helvetica').fontSize(8).fillColor(INK);
        cols.forEach((c, i) => {
          const cell = r[i];
          doc.text(fit(doc, cell == null ? '' : String(cell), widths[i] - PAD * 2), xs[i] + PAD, y + 3.5,
            { width: widths[i] - PAD * 2, align: c.align || 'left', lineBreak: false });
        });
        doc.moveTo(MARGIN, y + rowH).lineTo(PAGE_W - MARGIN, y + rowH)
          .strokeColor('#eeeeee').lineWidth(0.5).stroke();
        doc.y = y + rowH;
      }
    }

    if (t.note) {
      room(20);
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
        .text(String(t.note), MARGIN, doc.y + 3, { width: CONTENT_W });
    }
    doc.y += 14;
  }

  /* ── footnotes ──────────────────────────────────────────────────────── */
  const notes = (spec.footnotes || []).filter(Boolean);
  if (notes.length) {
    room(24);
    doc.moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.y += 6;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    for (const n of notes) {
      room(14);
      doc.text('• ' + String(n), MARGIN, doc.y, { width: CONTENT_W });
      doc.y += 2;
    }
  }

  /* ── footer on every page ───────────────────────────────────────────── */
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const y = PAGE_H - MARGIN - 10;
    doc.font('Helvetica').fontSize(7).fillColor(MUTED);
    doc.text(`Generated ${istStamp(stampMs)} IST`, MARGIN, y, { width: CONTENT_W * 0.6, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, MARGIN + CONTENT_W * 0.6, y,
      { width: CONTENT_W * 0.4, align: 'right', lineBreak: false });
  }

  doc.end();
  return done;
}
