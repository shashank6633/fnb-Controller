/**
 * Per-item "sticker KOT" for the SAME Rugtek 80mm KOT printer (just load a
 * sticker roll instead of plain paper). When the Sticker-KOT toggle is ON, each
 * fired item prints as its own small ESC/POS ticket — the fields, their ORDER,
 * their SIZE, and whether each shows are all driven by a `StickerDesign` the
 * owner edits on the Print Design page (mirrors the KOT/Bill design model).
 *
 * This builder is the LEGACY fallback for bridges < v2.6 (text in-flow, QR
 * right-aligned BELOW the text). The PRIMARY layout is sticker-raster.ts — a
 * canvas-rendered GS v 0 raster with the QR truly BESIDE the details, sent as
 * `payload_b64` to bridges that decode base64 (v2.6.0+).
 *
 * Emitted as a `type:'raw'` payload the bridge forwards VERBATIM (same path it
 * uses for TSPL). Every byte stays in 0x00–0x7F (text is ASCII-folded, the code
 * is a short base32 token), so it survives JSON transport to the bridge intact.
 *
 * NOTE: exact QR module size / barcode width / cut can vary by printer — confirm
 * once on the real Rugtek with the "Print test sticker" button and tune.
 */

const ESC = '\x1B';
const GS = '\x1D';

// ── Sticker design (reorderable / sizable / toggleable lines) ────────────────
// Kept here (not in print.ts) so print.ts + the Print Design page can import it
// without a circular dependency (print.ts imports buildKotStickerESCPOS below).
export type StickerLineKey = 'name' | 'tableKot' | 'timeCaptain' | 'notes' | 'code';
export type StickerLineSize = 'normal' | 'large' | 'xlarge';
export interface StickerLine { key: StickerLineKey; enabled: boolean; size: StickerLineSize }
export interface StickerDesign { lines: StickerLine[] }

export const STICKER_LINE_LABELS: Record<StickerLineKey, string> = {
  name: 'Item name',
  tableKot: 'Table + KOT #',
  timeCaptain: 'Time + Captain',
  notes: 'Notes (only if the item has any)',
  code: 'QR / Barcode',
};

/** Defaults reproduce the current sticker exactly (big bold name, rest normal). */
export const DEFAULT_STICKER_LINES: StickerLine[] = [
  { key: 'name',        enabled: true, size: 'large' },
  { key: 'tableKot',    enabled: true, size: 'normal' },
  { key: 'timeCaptain', enabled: true, size: 'normal' },
  { key: 'notes',       enabled: true, size: 'normal' },
  { key: 'code',        enabled: true, size: 'normal' },
];
export const DEFAULT_STICKER_DESIGN: StickerDesign = { lines: DEFAULT_STICKER_LINES };

const VALID_STICKER_KEYS = new Set<string>(DEFAULT_STICKER_LINES.map((l) => l.key));

/** Merge a saved (possibly partial/hostile) design over the defaults — every key
 *  present once, kept in saved order, unknowns dropped, missing keys appended. */
export function normalizeStickerDesign(raw: any): StickerDesign {
  const src = raw && typeof raw === 'object' ? raw : {};
  const ordered: StickerLine[] = [];
  const seen = new Set<string>();
  for (const l of Array.isArray(src.lines) ? src.lines : []) {
    const key = l && typeof l.key === 'string' ? l.key : '';
    if (!key || seen.has(key) || !VALID_STICKER_KEYS.has(key)) continue;
    const def = DEFAULT_STICKER_LINES.find((x) => x.key === key)!;
    ordered.push({
      key: key as StickerLineKey,
      enabled: typeof l.enabled === 'boolean' ? l.enabled : def.enabled,
      size: (['normal', 'large', 'xlarge'].includes(l.size) ? l.size : def.size) as StickerLineSize,
    });
    seen.add(key);
  }
  for (const def of DEFAULT_STICKER_LINES) if (!seen.has(def.key)) ordered.push({ ...def });
  return { lines: ordered };
}

// ── ESC/POS helpers ──────────────────────────────────────────────────────────

/** Fold to 7-bit ASCII so the raw payload is 1 byte/char (JSON-safe). */
function ascii(s: unknown): string {
  return String(s ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '');
}

/** GS ! magnification byte for a line size (width|height, 1x/2x/3x). */
function sizeByte(sz: StickerLineSize): string {
  return sz === 'xlarge' ? '\x22' : sz === 'large' ? '\x11' : '\x00';
}

/** ESC/POS GS ( k QR block for an ASCII `data` string (module size 1–16). */
function qrBlock(data: string, size = 6): string {
  const store = data;
  const len = store.length + 3;          // short code → len < 128 → pL < 128
  const pL = len & 0xff;
  const pH = (len >> 8) & 0xff;
  const sz = Math.max(1, Math.min(16, Math.round(size)));
  return (
    `${GS}(k\x04\x00\x31\x41\x32\x00` +                                   // model 2
    `${GS}(k\x03\x00\x31\x43${String.fromCharCode(sz)}` +                 // module size
    `${GS}(k\x03\x00\x31\x45\x31` +                                       // error correction M
    `${GS}(k${String.fromCharCode(pL)}${String.fromCharCode(pH)}\x31\x50\x30${store}` + // store data
    `${GS}(k\x03\x00\x31\x51\x30`                                         // print
  );
}

/** ESC/POS CODE128 (GS k, form 2) of a short ASCII `data`, code set B. */
function code128Block(data: string, heightDots = 56, moduleWidth = 2): string {
  const payload = `{B${data}`;                 // force code set B (alphanumeric)
  const n = payload.length & 0xff;             // short code → n < 128
  const h = Math.max(24, Math.min(160, Math.round(heightDots)));
  const w = Math.max(2, Math.min(4, Math.round(moduleWidth)));
  return (
    `${GS}h${String.fromCharCode(h)}` +        // barcode height
    `${GS}w${String.fromCharCode(w)}` +        // module width
    `${GS}H\x00` +                             // no HRI (we print the code as text above)
    `${GS}k\x49${String.fromCharCode(n)}${payload}` // GS k 73 n {B<data>
  );
}

export interface KotStickerInput {
  itemName: string;
  tableLabel: string;
  kotNumber?: number | string;
  timeLabel: string;    // pre-formatted, e.g. "07:45 PM"
  captain?: string;     // captain who fired this KOT
  code: string;         // short scan_code (encoded in the QR/barcode)
  notes?: string;       // modifiers / instructions — printed ONLY if present
  codeType?: 'qr' | 'barcode';
  design?: StickerDesign;   // field order/size/visibility (defaults applied)
  copies?: number;
}

/**
 * Build the ESC/POS command string for ONE item sticker (× `copies`), honoring
 * the design's line ORDER, SIZE (A/A+/A++), and show/hide. Left-aligned, minimal
 * side margins (GS L 0). Lines with no content (empty notes / empty code) are
 * skipped even when enabled.
 */
export function buildKotStickerESCPOS(s: KotStickerInput): string {
  const copies = Math.max(1, Math.min(5, Math.round(Number(s.copies) || 1)));
  const design = s.design && Array.isArray(s.design.lines) && s.design.lines.length
    ? normalizeStickerDesign(s.design)
    : DEFAULT_STICKER_DESIGN;

  const name = ascii(s.itemName).slice(0, 48) || 'Item';
  const table = ascii(s.tableLabel) || '-';
  const kot = s.kotNumber != null && String(s.kotNumber) !== '' ? ` | KOT #${ascii(s.kotNumber)}` : '';
  const time = ascii(s.timeLabel);
  const captain = ascii(s.captain).slice(0, 24);
  const notes = ascii(s.notes).slice(0, 80);
  const code = ascii(s.code);
  const codeType = s.codeType === 'barcode' ? 'barcode' : 'qr';

  // One TEXT line (name / tableKot / timeCaptain / notes) at its size.
  const textLine = (line: StickerLine): string => {
    const S = sizeByte(line.size);
    switch (line.key) {
      case 'name': return `${GS}!${S}${ESC}E\x01${name}\n${GS}!\x00${ESC}E\x00`;
      case 'tableKot': return `${GS}!${S}Table ${table}${kot}\n${GS}!\x00`;
      case 'timeCaptain': {
        const t = `${time}${captain ? ` | Capt: ${captain}` : ''}`.trim();
        return t ? `${GS}!${S}${t}\n${GS}!\x00` : '';
      }
      case 'notes': return notes ? `${GS}!${S}* ${notes}\n${GS}!\x00` : '';
      default: return '';
    }
  };

  // STANDARD in-flow: text lines top-to-bottom + the code below, at its design
  // position — a barcode full width, or a QR right-aligned under a '#code' line.
  const bodyLine = (line: StickerLine): string => {
    if (!line.enabled) return '';
    if (line.key === 'code') {
      if (!code) return '';
      if (codeType === 'barcode') {
        const bH = line.size === 'xlarge' ? 100 : line.size === 'large' ? 76 : 56;
        return `#${code}\n${code128Block(code, bH)}\n`;
      }
      const qrMod = line.size === 'xlarge' ? 6 : line.size === 'large' ? 5 : 4;
      return `#${code}\n${ESC}a\x02${qrBlock(code, qrMod)}${ESC}a\x00`;
    }
    return textLine(line);
  };
  const one =
    `${ESC}@${GS}L\x00\x00${ESC}a\x00` +   // init + left margin 0 + align left
    design.lines.map(bodyLine).join('') +
    `\n${GS}V\x01`;                        // partial cut

  return one.repeat(copies);
}
