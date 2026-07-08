'use client';

// Shared WYSIWYG renderer for the 50×40 mm kitchen-production label.
// ------------------------------------------------------------------
// This is the SINGLE on-screen renderer used by both the print preview modal
// (kitchen-production page) and the label design page. It draws exactly what
// labelPreview() describes — item name at `title_px`, detail rows at `field_px`
// (already filtered by the field toggles), the CODE128 via jsbarcode at the
// configured bar height, and the QR via the qrcode lib when enabled — so the
// preview always matches the printed TSPL, which reads the SAME design config.

import { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import type { LabelPreview } from '@/lib/tspl-label';

export interface LabelCanvasProps {
  /** Output of labelPreview(batch, { qr, design, labelWidthMm, labelHeightMm }). */
  preview: LabelPreview;
  /** Pixels-per-mm zoom for the on-screen render (default 7 → 350×280 px at 50×40). */
  scale?: number;
  /** Extra classes for the outer label box. */
  className?: string;
}

export default function LabelCanvas({ preview: pv, scale = 7, className = '' }: LabelCanvasProps) {
  const w = pv.width_mm * scale;
  const h = pv.height_mm * scale;
  // QR occupies ~13 mm (21 modules × cell 5 = 105 dots on the print — buildTSPL
  // sizes it to fill its 108-dot reservation so cameras lock on fast); barcode
  // bar height comes from design dots (8 dots/mm).
  const qrPx = Math.round(13 * scale);
  const barcodePx = Math.max(18, Math.round((pv.barcode_height / 8) * scale));

  const barcodeRef = useRef<SVGSVGElement | null>(null);
  const qrRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (barcodeRef.current && pv.barcode) {
      try {
        JsBarcode(barcodeRef.current, pv.barcode, {
          format: 'CODE128',
          displayValue: pv.show_barcode_text,
          height: barcodePx,
          width: 1.4,
          margin: 0,
          fontSize: Math.max(9, Math.round(pv.field_px)),
          textMargin: 1,
        });
      } catch {
        /* invalid content → leave blank */
      }
    }
  }, [pv.barcode, barcodePx, pv.show_barcode_text, pv.field_px]);

  useEffect(() => {
    if (pv.qr && qrRef.current && pv.qr_value) {
      QRCode.toCanvas(qrRef.current, pv.qr_value, { width: qrPx, margin: 0 }).catch(() => {});
    }
  }, [pv.qr, pv.qr_value, qrPx]);

  // 2 mm safe margin + rounded die-cut corners, mirroring the printed TSPL: the
  // physical label is a rounded rectangle and nothing prints in the outer 2 mm.
  const marginPx = Math.round(2 * scale);
  const radiusPx = Math.round(2 * scale);

  return (
    <div
      className={`relative bg-white border border-[#2D1B0E] overflow-hidden ${className}`}
      style={{ width: w, height: h, borderRadius: radiusPx }}
    >
      <div className="absolute inset-0 flex flex-col" style={{ padding: marginPx }}>
        {/* item name */}
        <div style={pv.qr ? { paddingRight: qrPx + 8 } : undefined}>
          {pv.item_name_lines.map((ln, i) => (
            <div key={i} className="font-bold text-[#111] leading-tight" style={{ fontSize: pv.title_px }}>
              {ln}
            </div>
          ))}
        </div>

        {/* QR */}
        {pv.qr && pv.qr_value && (
          <canvas
            ref={qrRef}
            className="absolute"
            width={qrPx}
            height={qrPx}
            style={{ width: qrPx, height: qrPx, top: marginPx, right: marginPx }}
          />
        )}

        {/* detail rows */}
        <div className="mt-1 space-y-0.5">
          {pv.rows.map((r, i) => (
            <div key={i} className="text-[#111] leading-tight truncate" style={{ fontSize: pv.field_px }}>
              <span className="font-semibold">{r.label}:</span> {r.value || '—'}
            </div>
          ))}
        </div>

        {/* barcode */}
        <div className="mt-auto flex justify-center">
          {pv.barcode ? (
            <svg ref={barcodeRef} />
          ) : (
            <span className="text-gray-400" style={{ fontSize: pv.field_px }}>no barcode</span>
          )}
        </div>
      </div>
    </div>
  );
}
