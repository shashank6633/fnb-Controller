/**
 * Raster sticker-KOT builder — the PRIMARY layout for bridges >= v2.6.
 * --------------------------------------------------------------------
 * WHY raster: the Rugtek 80mm ignores ESC L page mode (confirmed on real
 * hardware — the "QR beside" page-mode job printed the QR at BOTTOM-LEFT), so
 * positioned text/QR via ESC W / GS $ is a dead end. Instead we compose the
 * whole sticker on an offscreen <canvas> — text column LEFT, QR TOP-RIGHT,
 * truly beside each other like a label printer — and ship it as ONE
 * `GS v 0` raster image. GS v 0 is universal across ESC/POS printers: if the
 * printer can print a receipt logo, it can print this sticker.
 *
 * TRANSPORT: raster bytes span 0x00–0xFF, and the bridge's legacy `payload`
 * path decodes with Buffer.from(str,'utf8') which corrupts 0x80–0xFF after
 * JSON transport. So this builder returns BASE64 for the doc's `payload_b64`
 * field, which bridge >= v2.6.0 decodes with Buffer.from(b64,'base64') and
 * forwards verbatim. Callers must gate on bridgeSupportsRawB64() and fall back
 * to the legacy text builder in kot-sticker.ts (buildKotStickerESCPOS) for
 * older bridges. The base64 string is plain JSON-safe text, so docs still
 * persist fine in the IndexedDB outbox.
 *
 * PIXEL FORMAT (GS v 0, m=0): 1 bit per pixel, 8 pixels per byte, MSB-first —
 * bit 7 of each byte is the LEFTMOST pixel of that 8-px group. Row stride is
 * widthDots/8 bytes (576/8 = 72 for the Rugtek's full 72mm head @ 203dpi).
 * A pixel prints black when its canvas luminance < 160 (anti-aliased text
 * edges round to the nearest of black/white).
 *
 * Browser-only (needs <canvas>): import from client components / the print
 * dispatcher page, never from a route handler.
 */

import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import {
  DEFAULT_STICKER_DESIGN,
  normalizeStickerDesign,
  type KotStickerInput,
  type StickerDesign,
  type StickerLineSize,
} from './kot-sticker';

// ── Layout constants (203dpi dots ≡ canvas px, 1:1) ─────────────────────────
const PAD = 8;             // white padding, all four sides
const GAP = 6;             // vertical gap between text lines
const CAP_HEIGHT = 480;    // hard cap so a hostile design can't feed a meter of roll
const FONT = 'Arial, Helvetica, sans-serif';
const CODE_FONT_PX = 20;   // the small '#CODE' caption under the QR / above the barcode

/** Text px per design size (A / A+ / A++). */
const TEXT_PX: Record<StickerLineSize, number> = { normal: 24, large: 32, xlarge: 40 };
/** QR symbol box px per the code line's size. */
const QR_PX: Record<StickerLineSize, number> = { normal: 160, large: 192, xlarge: 224 };
/** CODE128 bar height px per the code line's size. */
const BAR_PX: Record<StickerLineSize, number> = { normal: 56, large: 76, xlarge: 100 };

/** Collapse whitespace + cap length. Raster draws REAL glyphs (pixels, not
 *  bytes), so unlike the text builder we don't ASCII-fold — Devanagari/emoji
 *  in an item name print fine. Caps mirror buildKotStickerESCPOS. */
function clip(v: unknown, max: number): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Greedy word-wrap into at most `maxLines` lines of `maxWidth` px; the last
 *  line gets an '…' when content had to be dropped. Breaks over-long single
 *  words mid-word rather than overflowing the column. */
/** Single line clamped to maxWidth: measured, truncated with a trailing '.' when over. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let take = text.length;
  while (take > 1 && ctx.measureText(text.slice(0, take) + '.').width > maxWidth) take--;
  return text.slice(0, take) + '.';
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest && out.length < maxLines) {
    let take = rest.length;                       // longest prefix that fits
    while (take > 1 && ctx.measureText(rest.slice(0, take)).width > maxWidth) take--;
    let line = rest.slice(0, take);
    if (take < rest.length) {                     // prefer breaking at a space
      const sp = line.lastIndexOf(' ');
      if (sp > 0) { line = line.slice(0, sp); take = sp + 1; }
    }
    out.push(line.trim());
    rest = rest.slice(take).trim();
  }
  if (rest && out.length) {                       // truncated → ellipsize last line
    let last = out[out.length - 1];
    while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    out[out.length - 1] = last + '…';
  }
  return out.filter(Boolean);
}

/**
 * Build ONE item sticker (× copies) as a base64 ESC/POS raster job for the
 * bridge's `payload_b64` field (bridge >= v2.6 required — see header).
 *
 * Job per copy: ESC @ (init) + GS v 0 raster + 3×LF feed + GS V 1 partial cut.
 * Layout honors the design's line ORDER / enabled / size exactly like the
 * legacy text builder; codeType 'qr' puts the QR at TOP-RIGHT beside the text
 * column, 'barcode' keeps text full-width with a centered CODE128 strip below.
 * Lines with empty content (no notes / no code) are skipped even when enabled.
 *
 * @param opts.widthDots print-head width in dots (default 576 = 72mm @ 203dpi,
 *                       the Rugtek 80mm head; use 384 for a 58mm printer).
 */
export async function buildKotStickerRasterB64(
  s: KotStickerInput,
  opts?: { widthDots?: number },
): Promise<string> {
  if (typeof document === 'undefined') throw new Error('sticker raster requires a browser context');

  const widthDots = Math.max(64, Math.floor((opts?.widthDots ?? 576) / 8) * 8); // stride must be whole bytes
  const copies = Math.max(1, Math.min(5, Math.round(Number(s.copies) || 1)));
  const design: StickerDesign = s.design && Array.isArray(s.design.lines) && s.design.lines.length
    ? normalizeStickerDesign(s.design)
    : DEFAULT_STICKER_DESIGN;

  const name = clip(s.itemName, 48) || 'Item';
  const table = clip(s.tableLabel, 24) || '-';
  const kot = s.kotNumber != null && String(s.kotNumber) !== '' ? ` | KOT #${clip(s.kotNumber, 12)}` : '';
  const time = clip(s.timeLabel, 24);
  const captain = clip(s.captain, 24);
  const notes = clip(s.notes, 80);
  // The code goes INTO the QR/CODE128 symbols → keep it printable ASCII.
  const code = String(s.code ?? '').replace(/[^\x20-\x7E]/g, '');
  const codeType = s.codeType === 'barcode' ? 'barcode' : 'qr';

  const codeLine = design.lines.find((l) => l.key === 'code');
  const qrMode = codeType === 'qr' && !!code && !!codeLine?.enabled;
  const qrPx = qrMode ? QR_PX[codeLine!.size] : 0;
  // QR mode: text keeps a LEFT column, QR owns the right; else text is full width.
  const colW = qrMode
    ? Math.max(32, widthDots - 2 * PAD - qrPx - 12)
    : widthDots - 2 * PAD;

  // Draw onto a cap-height canvas, then rasterize only the rows we used.
  const canvas = document.createElement('canvas');
  canvas.width = widthDots;
  canvas.height = CAP_HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('sticker raster: 2d canvas context unavailable');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, widthDots, CAP_HEIGHT);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';

  // ── Left/full-width text column, in design order ──────────────────────────
  let y = PAD;
  for (const line of design.lines) {
    if (!line.enabled) continue;

    if (line.key === 'code') {
      // Barcode participates in design order (QR does not — it floats top-right).
      if (codeType !== 'barcode' || !code) continue;
      ctx.font = `${CODE_FONT_PX}px ${FONT}`;
      ctx.textAlign = 'center';
      // '#CODE' above the strip (matches text mode) — clamped to the printable
      // width so a long fallback code (item UUID when scan_code is absent)
      // can't overrun the canvas edges.
      ctx.fillText(fitText(ctx, `#${code}`, widthDots - 2 * PAD), widthDots / 2, y);
      ctx.textAlign = 'left';
      y += CODE_FONT_PX + GAP;
      // CODE128 must NEVER be downscaled via drawImage — anti-aliased sub-pixel
      // bars merge under the 1bpp threshold and the strip becomes unscannable.
      // Ladder: module width 2 → retry at 1 → skip the strip (the '#code'
      // caption above remains as the human-readable fallback).
      const printable = widthDots - 2 * PAD;
      let bc: HTMLCanvasElement | null = null;
      for (const w of [2, 1]) {
        const c2 = document.createElement('canvas');
        try {
          JsBarcode(c2, code, { format: 'CODE128', displayValue: false, width: w, height: BAR_PX[line.size], margin: 0 });
        } catch { break; /* invalid content → skip the strip */ }
        if (c2.width > 0 && c2.width <= printable) { bc = c2; break; }
      }
      if (bc) {
        ctx.drawImage(bc, Math.round((widthDots - bc.width) / 2), y, bc.width, bc.height);
        y += bc.height + GAP;
      }
      continue;
    }

    let text = '';
    let maxLines = 1;
    switch (line.key) {
      case 'name': text = name; maxLines = 2; break;
      case 'tableKot': text = `Table ${table}${kot}`; break;
      case 'timeCaptain': text = `${time}${captain ? ` | Capt: ${captain}` : ''}`.trim(); break;
      case 'notes': text = notes ? `* ${notes}` : ''; maxLines = 2; break;
    }
    if (!text) continue;                            // empty content → skip even when enabled
    const px = TEXT_PX[line.size];
    ctx.font = `${line.key === 'name' ? 'bold ' : ''}${px}px ${FONT}`;
    for (const ln of wrapText(ctx, text, colW, maxLines)) {
      ctx.fillText(ln, PAD, y);
      y += px + GAP;
    }
  }
  const leftBottom = y > PAD ? y - GAP : PAD;       // drop the trailing line gap

  // ── QR at TOP-RIGHT, beside the text column ───────────────────────────────
  let rightBottom = PAD;
  if (qrMode) {
    // QRCode.create → { modules: { size, data } }: data is a row-major
    // Uint8Array, truthy = dark module. We draw modules as filled rects — the
    // 12px column gap + 8px page padding leave >= 8px of white on every side
    // of the symbol (its quiet zone; the canvas background is already white).
    const q = QRCode.create(code, { errorCorrectionLevel: 'M' });
    const size = q.modules.size;
    const data = q.modules.data;
    const modPx = Math.max(1, Math.floor(qrPx / size));
    const drawn = modPx * size;                     // <= qrPx; center inside the box
    const qx = widthDots - PAD - qrPx + Math.floor((qrPx - drawn) / 2);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (data[r * size + c]) ctx.fillRect(qx + c * modPx, PAD + r * modPx, modPx, modPx);
      }
    }
    // '#CODE' centered under the symbol (human-readable fallback for scans) —
    // clamped to the QR box width so a long fallback code (item UUID when
    // scan_code is absent) can't overprint the left text column.
    ctx.font = `${CODE_FONT_PX}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(fitText(ctx, `#${code}`, qrPx + 8), widthDots - PAD - qrPx / 2, PAD + drawn + PAD);
    ctx.textAlign = 'left';
    rightBottom = PAD + drawn + PAD + CODE_FONT_PX;
  }

  const height = Math.min(CAP_HEIGHT, Math.ceil(Math.max(leftBottom, rightBottom)) + PAD);

  // ── Rasterize: 1bpp, 8 px/byte, MSB-first (bit 7 = leftmost pixel) ────────
  const rowBytes = widthDots >> 3;
  const raster = new Uint8Array(rowBytes * height);
  const img = ctx.getImageData(0, 0, widthDots, height).data;
  for (let ry = 0; ry < height; ry++) {
    for (let rx = 0; rx < widthDots; rx++) {
      const i = (ry * widthDots + rx) * 4;
      const lum = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
      if (lum < 160) raster[ry * rowBytes + (rx >> 3)] |= 0x80 >> (rx & 7);
    }
  }

  // ── Assemble the ESC/POS job: init + GS v 0 header + data + feed + cut ────
  // GS v 0 header: 1D 76 30 m(0) xL xH yL yH — x in BYTES (stride), y in dots.
  const head = [
    0x1b, 0x40,                                     // ESC @  (init)
    0x1d, 0x76, 0x30, 0x00,                         // GS v 0, normal scale
    rowBytes & 0xff, (rowBytes >> 8) & 0xff,        // xL xH
    height & 0xff, (height >> 8) & 0xff,            // yL yH
  ];
  const tail = [0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x01]; // feed 3 lines + GS V 1 partial cut
  const one = new Uint8Array(head.length + raster.length + tail.length);
  one.set(head, 0);
  one.set(raster, head.length);
  one.set(tail, head.length + raster.length);
  const job = new Uint8Array(one.length * copies);
  for (let i = 0; i < copies; i++) job.set(one, i * one.length);

  // Base64-encode the WHOLE job in one btoa. NEVER btoa per chunk and join —
  // each btoa pads its 3-byte groups, so mid-stream '=' padding corrupts the
  // decoded bytes. Build the full binary string first, then encode once.
  let bin = '';
  for (let i = 0; i < job.length; i += 0x8000) {
    bin += String.fromCharCode(...job.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
