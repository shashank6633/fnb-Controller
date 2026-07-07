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
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars) {
      cur = next;
    } else {
      if (cur) lines.push(cur);
      cur = w.length > maxChars ? w.slice(0, maxChars) : w;
      if (lines.length === maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  // If we ran out of lines but text remains, mark the last line as truncated.
  const joined = lines.join(' ');
  if (joined.replace(/\s+/g, ' ') !== words.join(' ').slice(0, joined.length).replace(/\s+/g, ' ')) {
    const last = lines[lines.length - 1] || '';
    lines[lines.length - 1] = (last.length > maxChars - 1 ? last.slice(0, maxChars - 1) : last) + '…';
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
  const copies = Math.max(1, Math.round(Number(opts.copies) || 1));
  const withQr = !!opts.qr;
  const widthMm = opts.labelWidthMm && opts.labelWidthMm > 0 ? opts.labelWidthMm : 50;
  const heightMm = opts.labelHeightMm && opts.labelHeightMm > 0 ? opts.labelHeightMm : 40;
  const gapMm = opts.gapMm != null && opts.gapMm >= 0 ? opts.gapMm : 2;
  const qrValue = (opts.scanUrl && opts.scanUrl.trim()) || batch.barcode || '';

  // Text column narrows when a QR sits on the right.
  const nameChars = withQr ? 13 : 20;
  const rowChars = withQr ? 30 : 46;

  const nameLines = wrap(batch.item_name, nameChars, 2);

  const T = (x: number, y: number, font: string, xm: number, ym: number, text: string) =>
    `TEXT ${x},${y},"${font}",0,${xm},${ym},"${tsplEscape(text)}"`;

  const lines: string[] = [];
  lines.push(`SIZE ${widthMm} mm,${heightMm} mm`);
  lines.push(`GAP ${gapMm} mm,0 mm`);
  lines.push('DIRECTION 1');
  lines.push('REFERENCE 0,0');
  lines.push('CLS');

  // Item name (font "3" ≈ 12x20 base; x2/y2 → large & bold-ish).
  let y = 12;
  for (const ln of nameLines) {
    lines.push(T(12, y, '3', 2, 2, ln));
    y += 44;
  }
  y += 4; // gap after the name block

  // Detail rows (font "2" ≈ 8x12 base).
  const dt = (d: string, t: string) => [d, t].filter(Boolean).join(' ');
  const rows: string[] = [
    `Batch: ${batch.batch_number || ''}`,
    `Prepared: ${dt(batch.production_date, batch.production_time)}`,
    `Expiry: ${dt(batch.expiry_date, batch.expiry_time)}`,
    `Qty: ${batch.quantity_produced ?? ''} ${batch.unit || ''}`.trim(),
    `By: ${batch.prepared_by || ''}`,
    `Loc: ${batch.storage_location || ''}`,
  ];
  for (const r of rows) {
    lines.push(T(12, y, '2', 1, 1, wrap(r, rowChars, 1)[0]));
    y += 26;
  }

  // CODE128 barcode with its human-readable value, anchored near the bottom.
  const barcodeVal = batch.barcode || '';
  if (barcodeVal) {
    const by = Math.min(y + 6, heightMm * 8 - 70);
    // BARCODE x,y,"128",height,human-readable(1),rotation,narrow,wide,"content"
    lines.push(`BARCODE 12,${by},"128",48,1,0,2,2,"${tsplEscape(barcodeVal)}"`);
  }

  // Optional QR on the right side.
  if (withQr && qrValue) {
    // QRCODE x,y,ECClevel,cellWidth,mode,rotation,"content"
    lines.push(`QRCODE ${widthMm * 8 - 108},12,M,4,A,0,"${tsplEscape(qrValue)}"`);
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
  /** Ready-to-render label rows in order (label + value already joined). */
  rows: Array<{ label: string; value: string }>;
  qr: boolean;
  qr_value: string;
  width_mm: number;
  height_mm: number;
}

/**
 * Plain-object description of the same fields buildTSPL renders, for an on-screen
 * HTML/SVG label preview. Mirrors the TSPL layout so the preview matches the print.
 */
export function labelPreview(batch: LabelBatch, opts: BuildTSPLOptions = {}): LabelPreview {
  const withQr = !!opts.qr;
  const widthMm = opts.labelWidthMm && opts.labelWidthMm > 0 ? opts.labelWidthMm : 50;
  const heightMm = opts.labelHeightMm && opts.labelHeightMm > 0 ? opts.labelHeightMm : 40;
  const dt = (d: string, t: string) => [d, t].filter(Boolean).join(' ');
  const qty = `${batch.quantity_produced ?? ''} ${batch.unit || ''}`.trim();
  const prepared = dt(batch.production_date, batch.production_time);
  const expiry = dt(batch.expiry_date, batch.expiry_time);
  return {
    item_name: batch.item_name || '',
    item_name_lines: wrap(batch.item_name, withQr ? 13 : 20, 2),
    batch_number: batch.batch_number || '',
    barcode: batch.barcode || '',
    prepared,
    expiry,
    qty,
    by: batch.prepared_by || '',
    loc: batch.storage_location || '',
    rows: [
      { label: 'Batch', value: batch.batch_number || '' },
      { label: 'Prepared', value: prepared },
      { label: 'Expiry', value: expiry },
      { label: 'Qty', value: qty },
      { label: 'By', value: batch.prepared_by || '' },
      { label: 'Loc', value: batch.storage_location || '' },
    ],
    qr: withQr,
    qr_value: (opts.scanUrl && opts.scanUrl.trim()) || batch.barcode || '',
    width_mm: widthMm,
    height_mm: heightMm,
  };
}
