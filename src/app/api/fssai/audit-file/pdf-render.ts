import PDFDocument from 'pdfkit';
import { humanDate, istStamp } from '@/lib/report-pdf';
import { pdfImageKind } from './scans';
import {
  AUDIT_FILE_STATUS_WORDS, auditFileHoldsWords,
  type AuditFile, type AuditFileItem, type AuditFileSelfAudit, type AuditFileStatus, type AuditFileTable,
} from './lib';

/**
 * THE AUDIT FILE AS ONE PDF — layout only.
 *
 * It computes nothing: every status, row and sentence comes from
 * buildAuditFile() (./lib), the same function the page shows. pdfkit, the
 * library the digital bill and every report PDF already use — no new
 * dependency. A4, one record per section, each section starting on a fresh
 * page so the printout drops straight into a binder behind its divider.
 *
 * ── TWO COPIES, AND WHY ─────────────────────────────────────────────────────
 * Inspection Mode's rule (FSSAI-BUILD-STATE.md §7 Q11): nothing handed to an
 * inspector may describe what the restaurant lacks. So:
 *   handover  — the default. The records that are on file, in the authority's
 *               order and numbering, stated as facts. A record with nothing on
 *               file is left out of it and out of its contents list; an empty
 *               table is left out rather than printed as "nothing on file".
 *               Not one sentence about a gap — but it SAYS HOW MANY of the 20
 *               it contains, on the cover, the contents page and every footer
 *               (owner, 2026-10-14: never imply a complete file). That is a
 *               fact about this document, worked out once in buildAuditFile
 *               (file.handover), so the page and Inspection Mode say the same.
 *   readiness — the MANAGEMENT COPY. All 20, each with its PRESENT / EXPIRING /
 *               MISSING band, the reasons and what closes it, and every voided
 *               file listed with its reason. Every page says it is not for
 *               handing over.
 * Both end with THE AUTHORITY'S OWN CHECKLIST PAGES, the last self-audit of
 * each laid onto the page as YES / NO / REMARK — the passing answers an
 * inspector otherwise never sees (the handover prints the pages that have a
 * round; the management copy all three, saying why one has none).
 *
 * ── FONTS ───────────────────────────────────────────────────────────────────
 * pdfkit's built-in Helvetica is WinAnsi-encoded. A character outside it (the
 * rupee sign, an arrow, a name typed in Telugu) prints as a box or as garbage,
 * so every string passes through pdfText() first. See src/lib/report-pdf.ts.
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 40;
const W = PAGE_W - M * 2;
const BOTTOM = PAGE_H - M - 22;

const INK = '#111111';
const MUTED = '#666666';
const RULE = '#cccccc';
const HEAD_BG = '#f0f0f0';
const TONE = { bad: '#b42318', warn: '#9a5b00', void: '#8a8a8a' } as const;
const BAND: Record<AuditFileStatus, { fill: string; ink: string }> = {
  missing: { fill: '#b42318', ink: '#ffffff' },
  expiring: { fill: '#c77700', ink: '#ffffff' },
  present: { fill: '#1e7a3c', ink: '#ffffff' },
};

/** Characters WinAnsi carries above Latin-1's printable range. */
const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const SWAP: Record<string, string> = { '→': '->', '←': '<-', '≥': '>=', '≤': '<=', '✓': 'OK', '✗': 'x', '₹': 'Rs ', '−': '-' };

/** Make a string safe for the built-in Helvetica (see the header). */
export function pdfText(v: unknown): string {
  const src = v === null || v === undefined ? '' : String(v);
  let out = '';
  for (const ch of src) {
    const c = ch.codePointAt(0) || 0;
    if (ch === '\n' || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.has(ch)) out += ch;
    else if (SWAP[ch] !== undefined) out += SWAP[ch];
    else if (c === 0x09) out += ' ';
    else out += '?';
  }
  return out;
}

export interface AuditPdfSpec {
  file: AuditFile;
  businessName: string;
  copy: 'handover' | 'readiness';
  preparedBy: string;
  /** Stored images by attachment id (./scans loadScanImages). */
  images: Map<string, { mime: string; bytes: Buffer }>;
  generatedAtMs?: number;
}

/** Most scans drawn in one section; the rest are listed by name. */
export const MAX_SCANS_PER_SECTION = 12;

export function buildAuditFilePdf(spec: AuditPdfSpec): Promise<Buffer> {
  const { file, copy } = spec;
  const readiness = copy === 'readiness';
  const stampMs = spec.generatedAtMs ?? Date.now();
  const items = readiness ? file.items : file.items.filter((i) => i.held);
  const sheets = (file.self_audit || []).filter((sa) => readiness || !!sa.run);
  const holds = auditFileHoldsWords(file);

  const doc = new PDFDocument({
    size: [PAGE_W, PAGE_H],
    margins: { top: M, bottom: M, left: M, right: M },
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: pdfText(`Food Safety Audit File${spec.businessName ? ` — ${spec.businessName}` : ''}`),
      Author: pdfText(spec.businessName || ''),
      Subject: pdfText(file.section),
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const page = () => doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
  const newPage = () => { doc.addPage(); doc.y = M; };
  const room = (need: number) => { if (doc.y + need > BOTTOM) newPage(); };

  /** A wrapped paragraph that moves to a new page rather than over the footer. */
  const para = (text: string, opts: { font?: string; size?: number; color?: string; indent?: number; gap?: number } = {}) => {
    const t = pdfText(text);
    if (!t) return;
    const x = M + (opts.indent || 0);
    const w = W - (opts.indent || 0);
    doc.font(opts.font || 'Helvetica').fontSize(opts.size || 9).fillColor(opts.color || INK);
    const h = doc.heightOfString(t, { width: w });
    room(Math.min(h, 120) + 2);
    doc.text(t, x, doc.y, { width: w });
    doc.y += opts.gap ?? 3;
  };

  /* ══ COVER ══════════════════════════════════════════════════════════════ */
  doc.y = M + 90;
  doc.font('Helvetica-Bold').fontSize(26).fillColor(INK).text('Food Safety Audit File', M, doc.y, { width: W });
  if (spec.businessName) {
    doc.font('Helvetica').fontSize(15).fillColor(INK).text(pdfText(spec.businessName), M, doc.y + 4, { width: W });
  }
  doc.y += 18;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(pdfText(file.section), M, doc.y, { width: W });
  doc.font('Helvetica').fontSize(10).fillColor(MUTED)
    .text('As listed by the Hyderabad Food Safety Authority in its Food Safety Audit Checklist.', M, doc.y + 2, { width: W });
  doc.y += 22;
  doc.moveTo(M, doc.y).lineTo(PAGE_W - M, doc.y).strokeColor(RULE).lineWidth(1).stroke();
  doc.y += 12;
  para(`Documents and certificates: those in force on ${humanDate(file.today)}.`, { size: 10 });
  para(`Running logs (temperatures, checklists, deliveries, oil): ${humanDate(file.since)} to ${humanDate(file.today)} — ${file.days} days.`, { size: 10 });
  para(`Prepared on ${istStamp(stampMs)} IST${spec.preparedBy ? ` by ${spec.preparedBy}` : ''}, from the food-safety records kept in this application.`, { size: 10 });
  para(
    readiness
      ? 'Every one of the 20 records is in this copy, in the authority\'s order and wording.'
      // Neutral, and about this document (§7 Q11) — and it says how many of
      // the 20 it holds, so it can never pass for the complete file.
      : 'Each record is filed under the number and the wording it has on the authority\'s checklist.',
    { size: 10, gap: 6 },
  );
  if (!readiness) para(holds, { size: 10.5, font: 'Helvetica-Bold', gap: 6 });
  if (sheets.length) {
    para(`After the records: the authority's own checklist ${sheets.length === 1 ? 'page' : 'pages'} (${sheets.map((sa) => sa.sheet.trim()).join(', ')}) with the answers of the last self-audit on ${sheets.length === 1 ? 'it' : 'each'} — YES, NO and REMARK, line by line.`, { size: 10, gap: 14 });
  } else {
    doc.y += 8;
  }

  if (readiness) {
    const y = doc.y;
    doc.rect(M, y, W, 64).fillColor('#fdecea').fill();
    doc.rect(M, y, 4, 64).fillColor(BAND.missing.fill).fill();
    doc.font('Helvetica-Bold').fontSize(12).fillColor(BAND.missing.fill)
      .text('MANAGEMENT COPY — NOT FOR HANDING OVER', M + 14, y + 10, { width: W - 24 });
    doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(
      `This copy marks what is missing or about to lapse. Present: ${file.counts.present} · Expiring: ${file.counts.expiring} · Missing: ${file.counts.missing}. ` +
      `Hand the inspector the ordinary audit-file PDF instead — it contains ${file.handover.count} of the ${file.handover.total} records` +
      `${file.handover.left_out.length ? ` (not in it: ${file.handover.left_out.join(', ')})` : ''}.`,
      M + 14, y + 28, { width: W - 24 },
    );
    doc.y = y + 76;
  }

  /* ══ CONTENTS — drawn last, once the page numbers are known ════════════ */
  newPage();
  const contentsPage = page();
  const startPage = new Map<number, number>();

  /* ══ ONE SECTION PER RECORD ════════════════════════════════════════════ */
  for (const it of items) {
    newPage();
    startPage.set(it.n, page());
    drawSection(it);
  }
  const sheetPage = new Map<string, number>();
  for (const sa of sheets) {
    newPage();
    sheetPage.set(sa.template_code, page());
    drawSelfAudit(sa);
  }

  /* contents */
  doc.switchToPage(contentsPage);
  doc.y = M;
  doc.font('Helvetica-Bold').fontSize(17).fillColor(INK).text('Contents', M, M, { width: W });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    .text(pdfText(`${file.section} — numbered as on the authority's checklist.`), M, doc.y + 2, { width: W });
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
    .text(pdfText(readiness ? `All 20 records, with their status. The inspector's copy contains ${file.handover.count} of the ${file.handover.total}.` : holds), M, doc.y + 4, { width: W });
  doc.y += 10;
  {
    const cols = readiness ? [0.5, 4.2, 1.1, 0.6] : [0.5, 5.3, 0.6];
    const tot = cols.reduce((a, b) => a + b, 0);
    const ws = cols.map((c) => (c / tot) * W);
    const xs: number[] = [];
    let acc = M;
    for (const w of ws) { xs.push(acc); acc += w; }
    const head = readiness ? ['No.', 'Record', 'Status', 'Page'] : ['No.', 'Record', 'Page'];
    let y = doc.y;
    doc.rect(M, y, W, 18).fillColor(HEAD_BG).fill();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
    head.forEach((h, i) => doc.text(h, xs[i] + 4, y + 5, { width: ws[i] - 8, lineBreak: false, align: i === head.length - 1 ? 'right' : 'left' }));
    y += 18;
    for (const it of items) {
      const p = startPage.get(it.n);
      doc.font('Helvetica').fontSize(9.5).fillColor(INK);
      doc.text(String(it.n), xs[0] + 4, y + 5, { width: ws[0] - 8, lineBreak: false });
      doc.text(fit(pdfText(it.title), ws[1] - 8), xs[1] + 4, y + 5, { width: ws[1] - 8, lineBreak: false });
      if (readiness) {
        doc.font('Helvetica-Bold').fillColor(BAND[it.status].fill)
          .text(AUDIT_FILE_STATUS_WORDS[it.status], xs[2] + 4, y + 5, { width: ws[2] - 8, lineBreak: false });
      }
      doc.font('Helvetica').fillColor(INK)
        .text(p === undefined ? '' : String(p + 1), xs[head.length - 1] + 4, y + 5, { width: ws[head.length - 1] - 8, lineBreak: false, align: 'right' });
      doc.moveTo(M, y + 20).lineTo(PAGE_W - M, y + 20).strokeColor('#e6e6e6').lineWidth(0.5).stroke();
      y += 20;
    }
    // The authority's own pages, after the 20 — lettered, so the 1–20
    // numbering stays the authority's.
    sheets.forEach((sa, i) => {
      const p = sheetPage.get(sa.template_code);
      doc.font('Helvetica').fontSize(9.5).fillColor(INK);
      doc.text(`A${i + 1}`, xs[0] + 4, y + 5, { width: ws[0] - 8, lineBreak: false });
      const what = `The authority's ${sa.sheet.trim()} — ${sa.run ? `self-audit of ${sa.run.business_date}` : 'no round yet'}`;
      doc.text(fit(pdfText(what), ws[1] - 8), xs[1] + 4, y + 5, { width: ws[1] - 8, lineBreak: false });
      if (readiness) {
        const word = !sa.run ? 'NONE' : sa.counts.no ? `${sa.counts.no} NO` : 'ALL YES';
        doc.font('Helvetica-Bold').fillColor(!sa.run || sa.counts.no ? BAND.missing.fill : BAND.present.fill)
          .text(word, xs[2] + 4, y + 5, { width: ws[2] - 8, lineBreak: false });
      }
      doc.font('Helvetica').fillColor(INK)
        .text(p === undefined ? '' : String(p + 1), xs[head.length - 1] + 4, y + 5, { width: ws[head.length - 1] - 8, lineBreak: false, align: 'right' });
      doc.moveTo(M, y + 20).lineTo(PAGE_W - M, y + 20).strokeColor('#e6e6e6').lineWidth(0.5).stroke();
      y += 20;
    });
  }

  /* ══ FOOTER ON EVERY PAGE ═══════════════════════════════════════════════ */
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const y = PAGE_H - M - 10;
    doc.font('Helvetica').fontSize(7).fillColor(MUTED);
    const left = readiness
      ? 'MANAGEMENT COPY — NOT FOR HANDING OVER'
      : pdfText(`${spec.businessName ? `${spec.businessName} — ` : ''}Food Safety Audit File · ${file.handover.count} of ${file.handover.total} records`);
    doc.text(fit(left, W * 0.45), M, y, { width: W * 0.45, lineBreak: false });
    doc.text(`Prepared ${istStamp(stampMs)} IST`, M + W * 0.45, y, { width: W * 0.33, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, M + W * 0.78, y, { width: W * 0.22, align: 'right', lineBreak: false });
  }

  doc.end();
  return done;

  /* ══════════════════════════════════════════════════════════════════════ */

  function fit(text: string, w: number): string {
    const s = String(text ?? '');
    if (!s || doc.widthOfString(s) <= w) return s;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (doc.widthOfString(s.slice(0, mid) + '…') <= w) lo = mid; else hi = mid - 1;
    }
    return lo > 0 ? s.slice(0, lo) + '…' : '';
  }

  function drawSection(it: AuditFileItem) {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
      .text(pdfText(`${file.section} — record ${it.n} of 20`), M, M, { width: W });
    doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(pdfText(`${it.n}. ${it.title}`), M, doc.y + 2, { width: W });
    doc.y += 8;

    if (readiness) {
      const y = doc.y;
      const word = AUDIT_FILE_STATUS_WORDS[it.status];
      doc.rect(M, y, W, 24).fillColor(BAND[it.status].fill).fill();
      doc.font('Helvetica-Bold').fontSize(12).fillColor(BAND[it.status].ink).text(word, M + 10, y + 6.5, { width: 90, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(BAND[it.status].ink)
        .text(fit(pdfText(it.headline), W - 120), M + 104, y + 8, { width: W - 114, lineBreak: false });
      doc.y = y + 32;
      for (const pr of it.problems) para(`•  ${pr}`, { size: 9.5, color: it.status === 'missing' ? TONE.bad : it.status === 'expiring' ? TONE.warn : INK });
      if (it.todo) para(`To close it: ${it.todo}`, { size: 9.5, font: 'Helvetica-Bold' });
      para(`How this is judged: ${it.basis}`, { size: 8, color: MUTED, gap: 8 });
    }

    /* summary boxes — the handover leaves out a figure that only measures a gap */
    const sum = it.summary.filter((x) => x.label && (readiness || !x.mgmt));
    if (sum.length) {
      const per = 4;
      const gap = 8;
      const cw = (W - gap * (per - 1)) / per;
      for (let i = 0; i < sum.length; i += per) {
        room(42);
        const y = doc.y;
        sum.slice(i, i + per).forEach((k, j) => {
          const x = M + j * (cw + gap);
          doc.rect(x, y, cw, 34).fillColor(HEAD_BG).fill();
          doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(fit(pdfText(k.label.toUpperCase()), cw - 10), x + 5, y + 5, { width: cw - 10, lineBreak: false });
          doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(fit(pdfText(k.value || '—'), cw - 10), x + 5, y + 16, { width: cw - 10, lineBreak: false });
        });
        doc.y = y + 42;
      }
    }

    for (const t of it.tables) {
      // The handover copy prints only the lines it may carry (not a document row
      // with no copy attached), and never an empty table: its empty line would
      // be a sentence about something not being there (§7 Q11).
      const shown = readiness ? t : { ...t, rows: t.rows.filter((r) => r.in_handover) };
      if (!readiness && !shown.rows.length) continue;
      drawTable(shown);
    }

    drawScans(it);
    drawVoided(it);
  }

  function drawTable(t: AuditFileTable) {
    const cols = t.columns;
    const headH = 15;
    const rowH = 13;
    const PAD = 3;
    const tot = cols.reduce((a, c) => a + (Number(c.width) || 1), 0);
    let ws = cols.map((c) => ((Number(c.width) || 1) / tot) * W);
    // A short value — a date, a number, a status word — must never be cut to
    // "2026-10-…", and a single token — a registration number, a batch, a
    // receipt — must never break in the middle ("CIR-12345/201" + "9"). Give
    // each column at least the width of its longest short value and of its
    // longest word (up to 22 characters), taken from the columns with room to
    // spare. Longer text wraps between words (see the rows below).
    doc.font('Helvetica').fontSize(7.5);
    const need = cols.map((_, i) => {
      let m = 0;
      for (const r of t.rows.slice(0, 80)) {
        const v = pdfText(r.cells[i] ?? '');
        if (v.length <= 12) m = Math.max(m, doc.widthOfString(v));
        for (const w of v.split(/\s+/)) if (w.length <= 22) m = Math.max(m, doc.widthOfString(w));
      }
      return m ? m + PAD * 2 + 1 : 0;
    });
    const deficit = ws.reduce((a, w, i) => a + Math.max(0, need[i] - w), 0);
    if (deficit > 0) {
      const slack = ws.map((w, i) => Math.max(0, w - need[i]));
      const spare = slack.reduce((a, b) => a + b, 0);
      if (spare > deficit) ws = ws.map((w, i) => (need[i] > w ? need[i] : w - (slack[i] / spare) * deficit));
    }
    const xs: number[] = [];
    let acc = M;
    for (const w of ws) { xs.push(acc); acc += w; }
    const head = () => {
      const y = doc.y;
      doc.rect(M, y, W, headH).fillColor(HEAD_BG).fill();
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK);
      cols.forEach((c, i) => doc.text(fit(pdfText(c.label), ws[i] - PAD * 2), xs[i] + PAD, y + 4.5,
        { width: ws[i] - PAD * 2, lineBreak: false, align: c.align === 'right' ? 'right' : 'left' }));
      doc.y = y + headH;
    };

    room(40);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(pdfText(t.title), M, doc.y, { width: W });
    doc.y += 3;
    if (!t.rows.length) {
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text(pdfText(t.empty), M, doc.y, { width: W });
      doc.y += 12;
      return;
    }
    room(headH + rowH * 2);
    head();
    // ROWS WRAP. A cell is never cut to "CIR-12345/2…": a registration number,
    // a batch, a name the inspector reads must print whole. A row grows to its
    // tallest cell (up to MAX_ROW_H, past which the cell ends in an ellipsis —
    // the application holds the full text).
    const MAX_ROW_H = 64;
    for (const r of t.rows) {
      doc.font('Helvetica').fontSize(7.5);
      const texts = cols.map((_, i) => pdfText(r.cells[i] ?? ''));
      const tall = texts.reduce((m, tx, i) => (tx ? Math.max(m, doc.heightOfString(tx, { width: ws[i] - PAD * 2 })) : m), 0);
      const h = Math.max(rowH, Math.min(tall + 5, MAX_ROW_H));
      if (doc.y + h > BOTTOM) { newPage(); head(); }
      const y = doc.y;
      doc.font('Helvetica').fontSize(7.5).fillColor(r.tone ? TONE[r.tone] : INK);
      // A voided line is KEPT and printed — greyed and struck through, its
      // reason readable in its own cell (void, never delete).
      cols.forEach((c, i) => {
        if (!texts[i]) return;
        doc.text(texts[i], xs[i] + PAD, y + 3, {
          width: ws[i] - PAD * 2, height: h - 4, ellipsis: true,
          align: c.align === 'right' ? 'right' : 'left',
          strike: r.tone === 'void' && !/^VOID/.test(texts[i]),
        });
      });
      doc.moveTo(M, y + h).lineTo(PAGE_W - M, y + h).strokeColor('#eeeeee').lineWidth(0.5).stroke();
      doc.y = y + h;
    }
    if (t.more) {
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
        .text(readiness
          ? `…and ${t.more} more in this period. Reports & Downloads in the application carries every row.`
          : `…and ${t.more} more in this period, held in the application.`, M, doc.y + 2, { width: W });
    }
    doc.y += 10;
  }

  function drawScans(it: AuditFileItem) {
    // The handover draws only copies it may carry: an image still stored, and
    // not the scan of an EXPIRED paper (its cover says "those in force") nor a
    // file that only travels beside a record the copy does not hold
    // (sc.in_handover, worked out in buildAuditFile's lib).
    const scans = it.scans.filter((sc) => readiness || (sc.has_image && sc.in_handover));
    if (!scans.length) return;
    // The heading is drawn with the first copy, on the page that copy lands on,
    // so it is never left alone at the foot of a page above an image overleaf.
    let headed = false;
    const heading = (need: number) => {
      if (headed) return;
      headed = true;
      if (doc.y + 18 + need > BOTTOM) newPage();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Copies on file', M, doc.y + 4, { width: W });
      doc.y += 4;
    };
    let drawn = 0;
    for (const sc of scans) {
      const caption = [sc.record_label, sc.caption, sc.created_at ? `filed ${sc.created_at.slice(0, 10)}` : ''].filter(Boolean).join(' — ');
      const img = sc.has_image ? spec.images.get(sc.attachment_id) : undefined;
      const kind = img ? pdfImageKind(img.bytes) : '';
      if (!img || !kind || drawn >= MAX_SCANS_PER_SECTION) {
        // The handover says only that the copy is held; the reason it is not
        // drawn here is about the software, which is management's business.
        const why = !readiness
          ? 'copy held in the application'
          : !sc.has_image
            ? `image removed${sc.image_dropped_at ? ` on ${sc.image_dropped_at.slice(0, 10)}` : ''} — attach a new copy`
            : !img || drawn >= MAX_SCANS_PER_SECTION
              ? 'open it from Documents & Certificates'
              : `stored as ${sc.mime || 'an image'}, which this PDF cannot embed — open it from Documents & Certificates`;
        heading(14);
        para(`${caption}: ${why}.`, { size: 8.5, color: sc.has_image ? MUTED : TONE.bad });
        continue;
      }
      let iw = 0;
      let ih = 0;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const opened = (doc as any).openImage(img.bytes);
        iw = Number(opened?.width) || 0;
        ih = Number(opened?.height) || 0;
      } catch {
        iw = 0;
      }
      if (!iw || !ih) {
        heading(14);
        para(readiness ? `${caption}: the stored image could not be read — open it from Documents & Certificates.` : `${caption}: copy held in the application.`, { size: 8.5, color: MUTED });
        continue;
      }
      // Full size = the width of the page or the height of an empty page. When
      // that does not fit below what is already on this page, shrink it into
      // the space left if it stays legible (at least 55% of full size), and
      // otherwise start it on a fresh page.
      const scale = Math.min(W / iw, (BOTTOM - M - 40) / ih, 2);
      let w = iw * scale;
      let h = ih * scale;
      const avail = BOTTOM - doc.y - (headed ? 0 : 18) - 18;
      if (h > avail) {
        if (avail >= h * 0.55) { const k = avail / h; w *= k; h *= k; } else newPage();
      }
      heading(h + 18);
      const y = doc.y + 2;
      const x = M + (W - w) / 2;
      doc.image(img.bytes, x, y, { width: w, height: h });
      doc.rect(x, y, w, h).strokeColor(RULE).lineWidth(0.5).stroke();
      doc.y = y + h + 3;
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(pdfText(caption), M, doc.y, { width: W, align: 'center' });
      doc.y += 10;
      drawn++;
    }
  }

  /**
   * MANAGEMENT COPY ONLY: the files on this record that were voided — kept,
   * with who, when and why. Listed by name; never drawn, never a copy.
   */
  function drawVoided(it: AuditFileItem) {
    if (!readiness || !it.voided_scans.length) return;
    room(30);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text('Voided files (kept, not a copy)', M, doc.y + 4, { width: W });
    doc.y += 3;
    for (const sc of it.voided_scans) {
      const when = sc.voided_at ? sc.voided_at.slice(0, 10) : '';
      para(`VOID — ${sc.record_label}${sc.filename ? ` (${sc.filename})` : ''}: ${sc.void_reason || 'no reason recorded'}${sc.voided_by ? ` — voided by ${sc.voided_by}` : ''}${when ? ` on ${when}` : ''}.`,
        { size: 8.5, color: TONE.void });
    }
  }

  /**
   * ONE OF THE AUTHORITY'S CHECKLIST PAGES, ANSWERED. The rows, words and order
   * of the authority's own sheet (headings, lead-ins, the sub-heading, the
   * lines), with the last self-audit's YES / NO and REMARK beside each line —
   * the passing answers included. A line answered N/A says so in the remark
   * column. Rows wrap; nothing is cut.
   */
  function drawSelfAudit(sa: AuditFileSelfAudit) {
    const title = sa.sheet.trim();
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
      .text(pdfText(`The authority's own checklist — after the 20 records`), M, M, { width: W });
    doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(pdfText(`${title}${sa.template_name ? ` — ${sa.template_name}` : ''}`), M, doc.y + 2, { width: W });
    doc.y += 6;
    if (!sa.run) {
      // Management copy only (the handover leaves such a page out).
      para(`No self-audit on this page yet. ${sa.problem}`, { size: 10, color: TONE.bad, gap: 8 });
    } else {
      const r = sa.run;
      para(`Self-audit of ${humanDate(r.business_date)} — ${r.status === 'verified' ? 'verified' : 'submitted'}${r.recorded_by ? `, recorded by ${r.recorded_by}` : ''}${r.signed_by ? `, signed by ${r.signed_by}` : ''}.`,
        { size: 10, gap: 2 });
      para(`${sa.counts.lines} lines: ${sa.counts.yes} YES · ${sa.counts.no} NO${sa.counts.na ? ` · ${sa.counts.na} not applicable` : ''}${sa.counts.unanswered ? ` · ${sa.counts.unanswered} not answered` : ''}.` +
        (readiness && sa.rounds_in_window ? ` ${sa.rounds_in_window} round${sa.rounds_in_window === 1 ? '' : 's'} of this page in the file's dates.` : ''),
      { size: 9.5, color: MUTED, gap: 8 });
      // Management copy only: an answer whose stored question no longer reads as
      // the authority's line with its code — laid by its words, or listed apart.
      if (readiness) for (const d of sa.drift || []) para(`•  ${d}`, { size: 9, color: TONE.warn });
    }

    const cw = [W * 0.6, W * 0.07, W * 0.07, W * 0.26];
    const cx = [M, M + cw[0], M + cw[0] + cw[1], M + cw[0] + cw[1] + cw[2]];
    const PAD = 4;
    const head = () => {
      const y = doc.y;
      doc.rect(M, y, W, 16).fillColor(HEAD_BG).fill();
      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK);
      ['Line, as the authority words it', 'YES', 'NO', 'REMARK'].forEach((h, i) =>
        doc.text(h, cx[i] + PAD, y + 4.5, { width: cw[i] - PAD * 2, lineBreak: false, align: i === 1 || i === 2 ? 'center' : 'left' }));
      doc.y = y + 16;
    };
    room(40);
    head();
    for (const row of sa.rows) {
      const isLine = row.kind === 'line';
      const text = pdfText(row.text.trim());
      const remark = pdfText(row.mark === 'N/A' ? `Not applicable${row.remark ? ` — ${row.remark}` : ''}` : row.remark);
      const font = row.kind === 'heading' ? 'Helvetica-Bold' : row.kind === 'line' ? 'Helvetica' : 'Helvetica-Oblique';
      doc.font(font).fontSize(row.kind === 'heading' ? 9 : 8);
      const h1 = doc.heightOfString(text || ' ', { width: (isLine ? cw[0] : W) - PAD * 2 });
      doc.font('Helvetica').fontSize(8);
      const h2 = isLine && remark ? doc.heightOfString(remark, { width: cw[3] - PAD * 2 }) : 0;
      const h = Math.max(h1, h2) + 6;
      if (doc.y + h > BOTTOM) { newPage(); head(); }
      const y = doc.y;
      if (row.kind === 'heading') doc.rect(M, y, W, h).fillColor('#f7f3ee').fill();
      doc.font(font).fontSize(row.kind === 'heading' ? 9 : 8).fillColor(INK)
        .text(text, cx[0] + PAD, y + 3, { width: (isLine ? cw[0] : W) - PAD * 2 });
      if (isLine) {
        doc.font('Helvetica-Bold').fontSize(9);
        if (row.mark === 'YES') doc.fillColor(BAND.present.fill).text('YES', cx[1], y + 3, { width: cw[1], align: 'center', lineBreak: false });
        if (row.mark === 'NO') doc.fillColor(BAND.missing.fill).text('NO', cx[2], y + 3, { width: cw[2], align: 'center', lineBreak: false });
        if (!row.mark) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('—', cx[1], y + 3, { width: cw[1] + cw[2], align: 'center', lineBreak: false });
        if (remark) doc.font('Helvetica').fontSize(8).fillColor(INK).text(remark, cx[3] + PAD, y + 3, { width: cw[3] - PAD * 2 });
      }
      doc.moveTo(M, y + h).lineTo(PAGE_W - M, y + h).strokeColor('#eeeeee').lineWidth(0.5).stroke();
      doc.y = y + h;
    }
    if (sa.run && sa.extra.length) {
      doc.y += 8;
      para('Questions this outlet added to the page:', { size: 9, font: 'Helvetica-Bold', gap: 2 });
      for (const x of sa.extra) para(`${x.prompt || x.question_code}: ${x.mark || 'not answered'}${x.remark ? ` — ${x.remark}` : ''}`, { size: 8.5 });
    }
  }
}
