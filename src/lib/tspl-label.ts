// TSPL2 label generation for the Kitchen Production module.
// ---------------------------------------------------------
// The TSC TE210 is a direct-thermal LABEL printer (NOT a receipt printer), so
// it speaks TSPL2 — its own command language — rather than ESC/POS. This module
// turns a production batch into a TSPL2 command string for a 50mm x 40mm label
// which the BROWSER forwards to the on-site print bridge (localhost:9920), the
// same bridge the POS uses for KOTs/bills. See buildTSPL() below.
//
// Geometry: at 203 dpi a printer prints 8 dots per mm, so a 50mm x 40mm label
// is ~400 x 320 dots. All coordinates here stay inside that box.

import type { ProductionBatch } from './production-batch';

// ---- settings config -------------------------------------------------------

export const LABEL_PRINTER_KEY = 'label_printer';

/** Which detail rows appear on the label (in this fixed print order). */
export interface LabelFieldToggles {
  batch: boolean;
  prepared: boolean;
  expiry: boolean;
  qty: boolean;
  by: boolean;
  loc: boolean;
}

/**
 * User-tunable label layout. Both the on-screen preview and the printed TSPL
 * read from THIS object so the two always match. Scales are multipliers on a
 * sensible base size (1.0 ≈ the old sizing); defaults are deliberately bigger.
 */
export interface LabelDesignConfig {
  /** Item-name size multiplier (base 15px preview / bitmap-font ×2 print). */
  title_scale: number;
  /** Detail-row size multiplier (base 9px preview / bitmap-font print). */
  field_scale: number;
  /** Per-row visibility toggles. */
  fields: LabelFieldToggles;
  /** CODE128 bar height in printer dots (203dpi → 8 dots/mm). */
  barcode_height: number;
  /** Print the human-readable barcode text under the bars. */
  show_barcode_text: boolean;
}

export interface LabelPrinterConfig {
  mode: 'tspl' | 'bartender';
  transport: 'usb' | 'ip';
  /** USB share/queue name (e.g. "TE210") or "host:port" for IP (e.g. "192.168.1.60:9100"). */
  target: string;
  label_width_mm: number;
  label_height_mm: number;
  copies: number;
  print_preview: boolean;
  /** Default: add a QR code to every label (a per-print `qr` still overrides this). */
  qr: boolean;
  /** BarTender .btw template path (only used when mode === 'bartender'). */
  bartender_template: string;
  /** Sizing/layout of what actually gets drawn on the label. */
  design: LabelDesignConfig;
}

export function defaultLabelDesign(): LabelDesignConfig {
  return {
    title_scale: 1.3,
    field_scale: 1.4,
    fields: { batch: true, prepared: true, expiry: true, qty: true, by: true, loc: true },
    barcode_height: 50,
    show_barcode_text: true,
  };
}

/** Coerce an arbitrary parsed value into a valid, fully-populated design config. */
export function normalizeLabelDesign(raw: any): LabelDesignConfig {
  const d = defaultLabelDesign();
  if (!raw || typeof raw !== 'object') return d;
  const numIn = (v: any, def: number, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const bool = (v: any, def: boolean) => (v === undefined ? def : !!v);
  const f = raw.fields && typeof raw.fields === 'object' ? raw.fields : {};
  return {
    title_scale: numIn(raw.title_scale, d.title_scale, 0.8, 3),
    field_scale: numIn(raw.field_scale, d.field_scale, 0.8, 3),
    fields: {
      batch: bool(f.batch, d.fields.batch),
      prepared: bool(f.prepared, d.fields.prepared),
      expiry: bool(f.expiry, d.fields.expiry),
      qty: bool(f.qty, d.fields.qty),
      by: bool(f.by, d.fields.by),
      loc: bool(f.loc, d.fields.loc),
    },
    barcode_height: Math.round(numIn(raw.barcode_height, d.barcode_height, 20, 90)),
    show_barcode_text: bool(raw.show_barcode_text, d.show_barcode_text),
  };
}

export function defaultLabelPrinter(): LabelPrinterConfig {
  return {
    mode: 'tspl',
    transport: 'usb',
    target: 'TE210',
    label_width_mm: 50,
    label_height_mm: 40,
    copies: 1,
    print_preview: true,
    qr: false,
    bartender_template: '',
    design: defaultLabelDesign(),
  };
}

/** Coerce an arbitrary parsed value into a valid, fully-populated config. */
export function normalizeLabelPrinter(raw: any): LabelPrinterConfig {
  const d = defaultLabelPrinter();
  if (!raw || typeof raw !== 'object') return d;
  const mode = raw.mode === 'bartender' ? 'bartender' : 'tspl';
  const transport = raw.transport === 'ip' ? 'ip' : 'usb';
  const num = (v: any, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  return {
    mode,
    transport,
    target: typeof raw.target === 'string' && raw.target.trim() ? raw.target.trim() : d.target,
    label_width_mm: num(raw.label_width_mm, d.label_width_mm),
    label_height_mm: num(raw.label_height_mm, d.label_height_mm),
    copies: Math.max(1, Math.round(num(raw.copies, d.copies))),
    print_preview: raw.print_preview === undefined ? d.print_preview : !!raw.print_preview,
    qr: raw.qr === undefined ? d.qr : !!raw.qr,
    bartender_template: typeof raw.bartender_template === 'string' ? raw.bartender_template : d.bartender_template,
    design: normalizeLabelDesign(raw.design),
  };
}

/** Read the saved label_printer config (or sensible defaults) from the settings table. */
export function readLabelPrinter(db: { prepare: (sql: string) => { get: (...a: any[]) => any } }): LabelPrinterConfig {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(LABEL_PRINTER_KEY) as { value?: string } | undefined;
  if (!row?.value) return defaultLabelPrinter();
  try {
    return normalizeLabelPrinter(JSON.parse(row.value));
  } catch {
    return defaultLabelPrinter();
  }
}

// ---- TSPL2 label -----------------------------------------------------------

/** The batch fields a label needs (a ProductionBatch satisfies this). */
export type LabelBatch = Pick<
  ProductionBatch,
  | 'item_name'
  | 'batch_number'
  | 'barcode'
  | 'production_date'
  | 'production_time'
  | 'expiry_date'
  | 'expiry_time'
  | 'quantity_produced'
  | 'unit'
  | 'prepared_by'
  | 'storage_location'
>;

export interface BuildTSPLOptions {
  copies?: number;
  /** Add a QR code (encodes scanUrl if given, else the batch barcode). */
  qr?: boolean;
  /** URL to encode in the QR instead of the raw barcode (e.g. a scan-lookup page). */
  scanUrl?: string;
  labelWidthMm?: number;
  labelHeightMm?: number;
  /** Inter-label gap in mm (default 2). */
  gapMm?: number;
  /** Sizing/layout design (defaults applied when omitted). */
  design?: LabelDesignConfig;
}

/** Detail-row keys in fixed print order. */
export const LABEL_FIELD_KEYS = ['batch', 'prepared', 'expiry', 'qty', 'by', 'loc'] as const;
export type LabelFieldKey = (typeof LABEL_FIELD_KEYS)[number];

/**
 * TSC bitmap-font cell sizes in printer dots at ×1 (203 dpi). A character drawn
 * with multiplier m is (w·m) dots wide and (h·m) dots tall, so how many fit on a
 * line is a DOT budget, not a guess. Font "3" = item name, font "2" = detail rows.
 */
const FONT = { '2': { w: 12, h: 20 }, '3': { w: 16, h: 24 } } as const;
/** Dots reserved for the QR symbol in the top-right corner, and the clear gap kept beside/below it (1 mm). */
const QR_BOX = 108;
const QR_GAP = 8;
/** 2 mm safe margin on every side (16 dots @ 203 dpi). */
const MARGIN = 16;

interface LabelLayout {
  titleMult: number;
  fieldMult: number;
  barcodeH: number;
  nameLines: string[];
  /** Each detail row, wrapped to the width actually free at its height (1–2 lines). */
  rowLines: string[][];
}

/**
 * Lay the label out in DOTS so nothing printed can overlap the QR: every text
 * line that sits beside the QR (above its bottom edge + gap) is wrapped to the
 * width LEFT of it; lines below the QR use the full width. The item name keeps
 * the configured size if it fits in 2 lines there, otherwise it steps down a size
 * (to ×1 at the smallest) before it is ever cut short. Shared by buildTSPL and
 * labelPreview so the screen preview and the printed label wrap identically.
 */
function layoutLabel(
  itemName: string, rows: string[], design: LabelDesignConfig,
  withQr: boolean, widthMm: number, heightMm: number, hasBarcode: boolean,
): LabelLayout {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  const widthDots = widthMm * 8;
  const usableH = heightMm * 8 - 2 * MARGIN;
  const fullW = widthDots - 2 * MARGIN;
  const qrX = widthDots - QR_BOX - MARGIN;
  const nearW = withQr ? qrX - QR_GAP - MARGIN : fullW;
  const qrBottom = MARGIN + QR_BOX + QR_GAP;
  const widthAt = (y: number) => (withQr && y < qrBottom ? nearW : fullW);
  const textH = design.show_barcode_text ? 22 : 0;
  const truncated = (ls: string[]) => ls.some((l) => l.endsWith('...'));

  const build = (tm: number, fm: number, bh: number) => {
    let y = MARGIN;
    const nameLines = wrap(itemName, Math.max(1, Math.floor(widthAt(y) / (FONT['3'].w * tm))), 2);
    y += nameLines.length * (FONT['3'].h * tm + 6) + 6;
    const rowLines: string[][] = [];
    for (const r of rows) {
      const ls = wrap(r, Math.max(1, Math.floor(widthAt(y) / (FONT['2'].w * fm))), 2);
      rowLines.push(ls);
      y += ls.length * (FONT['2'].h * fm + 2);
    }
    const height = (y - MARGIN) + (hasBarcode ? 8 + bh + textH : 0);
    return { nameLines, rowLines, height };
  };

  let tm = clamp(Math.round(design.title_scale * 2), 1, 5);
  let fm = clamp(Math.round(design.field_scale * 2) - 1, 1, 4);
  let bh = clamp(Math.round(design.barcode_height), 20, 90);
  // A name cut short beside the QR steps the title down a size first.
  while (tm > 1 && truncated(build(tm, fm, bh).nameLines)) tm--;
  // Then shrink to stay inside the safe area: rows first, then the barcode down to
  // 40 dots (5 mm — the least a handheld 1-D scanner reads in one easy pass), then
  // the title down to ×1, and only then the barcode below 5 mm as a last resort.
  let guard = 40;
  while (build(tm, fm, bh).height > usableH && guard-- > 0) {
    if (fm > 1) fm--;
    else if (bh > 40) bh = Math.max(40, bh - 6);
    else if (tm > 1) tm--;
    else if (bh > 24) bh -= 4;
    else break;
  }
  const out = build(tm, fm, bh);
  return { titleMult: tm, fieldMult: fm, barcodeH: bh, nameLines: out.nameLines, rowLines: out.rowLines };
}

/** Escape a string for a TSPL quoted literal ( \ and " are the reserved chars ). */
function tsplEscape(s: string): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Greedy word-wrap into at most `maxLines` lines of `maxChars`, ellipsizing overflow. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines: string[] = [];
  let cur = '';
  // Anything left off the label — a word past the last line, or the tail of a
  // word longer than a whole line — marks the last line with "...", so a cut name
  // never reads as complete (and layoutLabel can step the size down instead).
  let cut = false;
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars) { cur = next; continue; }
    if (cur) lines.push(cur);
    if (lines.length === maxLines) { cur = ''; cut = true; break; }
    if (w.length > maxChars) { cur = w.slice(0, maxChars); cut = true; } else cur = w;
  }
  if (cur) { if (lines.length < maxLines) lines.push(cur); else cut = true; }
  if (cut) {
    // Plain ASCII dots: the printer's built-in bitmap fonts have no "…" glyph.
    const ELL = '...';
    const last = lines[lines.length - 1] || '';
    const room = Math.max(0, maxChars - ELL.length);
    lines[lines.length - 1] = (last.length > room ? last.slice(0, room) : last) + ELL;
  }
  return lines.slice(0, maxLines);
}

/**
 * Build a TSPL2 command STRING for a single production-batch label (default 50x40mm).
 *
 * Layout (dots, 203dpi → 400 x 320):
 *   - item_name : large bitmap font, bold, wrapped to 2 lines
 *   - Batch / Prepared / Expiry / Qty / By / Loc : small text rows
 *   - CODE128 barcode of batch.barcode with its human-readable value
 *   - optional QR (right side) encoding scanUrl || batch.barcode
 *
 * Returns the raw TSPL2 text (CRLF-terminated commands) ready to send to the bridge.
 */
export function buildTSPL(batch: LabelBatch, opts: BuildTSPLOptions = {}): string {
  const design = normalizeLabelDesign(opts.design);
  const copies = Math.max(1, Math.round(Number(opts.copies) || 1));
  const withQr = !!opts.qr;
  const widthMm = opts.labelWidthMm && opts.labelWidthMm > 0 ? opts.labelWidthMm : 50;
  const heightMm = opts.labelHeightMm && opts.labelHeightMm > 0 ? opts.labelHeightMm : 40;
  const gapMm = opts.gapMm != null && opts.gapMm >= 0 ? opts.gapMm : 2;
  const qrValue = (opts.scanUrl && opts.scanUrl.trim()) || batch.barcode || '';

  const textH = design.show_barcode_text ? 22 : 0; // human-readable line height (dots)

  // Detail rows honoring the field toggles, in fixed order.
  const dt = (d: string, t: string) => [d, t].filter(Boolean).join(' ');
  const rowText: Record<LabelFieldKey, string> = {
    batch: `Batch: ${batch.batch_number || ''}`,
    prepared: `Prepared: ${dt(batch.production_date, batch.production_time)}`,
    expiry: `Expiry: ${dt(batch.expiry_date, batch.expiry_time)}`,
    qty: `Qty: ${batch.quantity_produced ?? ''} ${batch.unit || ''}`.trim(),
    by: `By: ${batch.prepared_by || ''}`,
    loc: `Loc: ${batch.storage_location || ''}`,
  };
  const rows = LABEL_FIELD_KEYS.filter((k) => design.fields[k]).map((k) => rowText[k]);

  const barcodeVal = batch.barcode || '';

  // 2 mm safe margin on every side: the label is a die-cut rectangle with rounded
  // corners and the print head drifts slightly, so nothing is drawn in the outer
  // 2 mm (16 dots @ 203 dpi). Content lives inside [M, size-M] on both axes.
  const M = MARGIN;
  const printableH = heightMm * 8;
  const { titleMult, fieldMult, barcodeH, nameLines, rowLines } =
    layoutLabel(batch.item_name, rows, design, withQr, widthMm, heightMm, !!barcodeVal);

  const T = (x: number, y: number, font: string, xm: number, ym: number, text: string) =>
    `TEXT ${x},${y},"${font}",0,${xm},${ym},"${tsplEscape(text)}"`;

  const lines: string[] = [];
  lines.push(`SIZE ${widthMm} mm,${heightMm} mm`);
  lines.push(`GAP ${gapMm} mm,0 mm`);
  lines.push('DIRECTION 1');
  lines.push('REFERENCE 0,0');
  lines.push('CLS');

  // Item name (font "3"; multiplier scales with title_scale). Origin at the 2 mm margin.
  let y = M;
  for (const ln of nameLines) {
    lines.push(T(M, y, '3', titleMult, titleMult, ln));
    y += FONT['3'].h * titleMult + 6;
  }
  y += 6; // gap after the name block

  // Detail rows (font "2"; multiplier scales with field_scale), each already
  // wrapped by layoutLabel to the width free at its height (left of the QR).
  for (const ls of rowLines) {
    for (const ln of ls) {
      lines.push(T(M, y, '2', fieldMult, fieldMult, ln));
      y += FONT['2'].h * fieldMult + 2;
    }
  }

  // CODE128 barcode anchored near the bottom, clamped inside the bottom 2 mm margin.
  if (barcodeVal) {
    const maxBy = Math.max(M, printableH - M - barcodeH - textH);
    const by = Math.min(y + 4, maxBy);
    const humanReadable = design.show_barcode_text ? 1 : 0;
    // BARCODE x,y,"128",height,human-readable,rotation,narrow,wide,"content"
    // Starts 1 mm further in than the text so the bars get a ≥2.5 mm quiet zone
    // (label edge + margin) — handheld scanners miss a code with no clear lead-in.
    lines.push(`BARCODE ${M + 8},${by},"128",${barcodeH},${humanReadable},0,2,2,"${tsplEscape(barcodeVal)}"`);
  }

  // Optional QR on the right side, inset by the 2 mm margin (top & right).
  if (withQr && qrValue) {
    // QRCODE x,y,ECClevel,cellWidth,mode,rotation,"content"
    // Camera phones lock onto a BIGGER QR much faster than the Code128, so use the
    // largest cell width that keeps the symbol inside the 108-dot reservation the
    // x-position (and the item-name wrap budget) already assume. Symbol modules
    // grow with content (auto version, byte-mode capacities at ECC M), so a longer
    // future scanUrl shrinks the cell instead of spilling past the right margin.
    const qrModules = qrValue.length <= 14 ? 21 : qrValue.length <= 26 ? 25 : qrValue.length <= 42 ? 29 : qrValue.length <= 62 ? 33 : qrValue.length <= 84 ? 37 : 41;
    const qrCell = Math.max(2, Math.min(6, Math.floor(QR_BOX / qrModules)));
    lines.push(`QRCODE ${widthMm * 8 - QR_BOX - M},${M},M,${qrCell},A,0,"${tsplEscape(qrValue)}"`);
  }

  lines.push(`PRINT ${copies},1`);
  return lines.join('\r\n') + '\r\n';
}

// ---- HTML/SVG preview model ------------------------------------------------

export interface LabelPreview {
  item_name: string;
  item_name_lines: string[];
  batch_number: string;
  barcode: string;
  prepared: string;
  expiry: string;
  qty: string;
  by: string;
  loc: string;
  /** Ready-to-render label rows in order (already filtered by field toggles). */
  rows: Array<{ label: string; value: string }>;
  qr: boolean;
  qr_value: string;
  width_mm: number;
  height_mm: number;
  /** Design-derived on-screen sizes so the preview matches the print. */
  title_px: number;
  field_px: number;
  /** CODE128 bar height in printer dots (convert to px via dots/8×pxPerMm). */
  barcode_height: number;
  show_barcode_text: boolean;
}

/**
 * Plain-object description of the same fields buildTSPL renders, for an on-screen
 * HTML/SVG label preview. Mirrors the TSPL layout so the preview matches the print.
 */
export function labelPreview(batch: LabelBatch, opts: BuildTSPLOptions = {}): LabelPreview {
  const design = normalizeLabelDesign(opts.design);
  const withQr = !!opts.qr;
  const widthMm = opts.labelWidthMm && opts.labelWidthMm > 0 ? opts.labelWidthMm : 50;
  const heightMm = opts.labelHeightMm && opts.labelHeightMm > 0 ? opts.labelHeightMm : 40;
  const dt = (d: string, t: string) => [d, t].filter(Boolean).join(' ');
  const qty = `${batch.quantity_produced ?? ''} ${batch.unit || ''}`.trim();
  const prepared = dt(batch.production_date, batch.production_time);
  const expiry = dt(batch.expiry_date, batch.expiry_time);
  const allRows: Array<{ key: LabelFieldKey; label: string; value: string }> = [
    { key: 'batch', label: 'Batch', value: batch.batch_number || '' },
    { key: 'prepared', label: 'Prepared', value: prepared },
    { key: 'expiry', label: 'Expiry', value: expiry },
    { key: 'qty', label: 'Qty', value: qty },
    { key: 'by', label: 'By', value: batch.prepared_by || '' },
    { key: 'loc', label: 'Loc', value: batch.storage_location || '' },
  ];
  const rows = allRows
    .filter((r) => design.fields[r.key])
    .map(({ label, value }) => ({ label, value }));
  // The SAME dot layout the printer gets, so the preview's name lines match the print.
  const layout = layoutLabel(batch.item_name, rows.map((r) => `${r.label}: ${r.value}`), design,
    withQr, widthMm, heightMm, !!batch.barcode);
  return {
    item_name: batch.item_name || '',
    item_name_lines: layout.nameLines,
    batch_number: batch.batch_number || '',
    barcode: batch.barcode || '',
    prepared,
    expiry,
    qty,
    by: batch.prepared_by || '',
    loc: batch.storage_location || '',
    rows,
    qr: withQr,
    qr_value: (opts.scanUrl && opts.scanUrl.trim()) || batch.barcode || '',
    width_mm: widthMm,
    height_mm: heightMm,
    // Base title 15px × title_scale, base field 9px × field_scale
    // (field_scale 1.4 ⇒ ~13px, title_scale 1.3 ⇒ ~20px).
    title_px: Math.round(15 * design.title_scale),
    field_px: Math.round(9 * design.field_scale),
    barcode_height: Math.round(Math.min(90, Math.max(20, design.barcode_height))),
    show_barcode_text: design.show_barcode_text,
  };
}
