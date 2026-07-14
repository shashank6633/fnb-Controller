'use client';

/**
 * ImageUpload — reusable CLIENT-ONLY image uploader for the Task-Management
 * module (Phase 2). There is NO upload service in this app: every picked image
 * is read via FileReader, downscaled on a <canvas> to a max edge of ~1200px,
 * and exported as an `image/jpeg` data: URI at quality ~0.7 (capped at ~250KB;
 * oversized results are re-encoded at progressively lower quality/size). The
 * resulting data: URI(s) are handed back to the caller via `onChange`, which
 * stores them through an EXISTING POST field (e.g. task_attachments.url,
 * daily_checklist_records.image_url, hygiene_audits.image_url). No server
 * endpoint, no filesystem, no new API.
 *
 * Usage (multiple):
 *   const [imgs, setImgs] = useState<string[]>([]);
 *   <ImageUpload multiple value={imgs} onChange={setImgs} />
 *
 * Usage (single — capture one photo for a field):
 *   <ImageUpload value={url ? [url] : []} onAdd={(u) => setUrl(u)} />
 *
 * <ImageThumb src={url} /> renders a stored data URI / URL as a small thumbnail
 * with click-to-enlarge (a portaled full-screen lightbox — portaled so a modal
 * or scroll pane can never clip it).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImagePlus, Loader2, X, ZoomIn } from 'lucide-react';

/* ── tuning knobs ──────────────────────────────────────────────────────── */
const MAX_EDGE = 1200;          // px — longest side after downscale
const TARGET_BYTES = 250 * 1024; // ~250KB cap on the encoded data: URI
const START_QUALITY = 0.7;       // initial JPEG quality
const MIN_QUALITY = 0.4;         // don't go blurrier than this via quality
const ACCEPT = 'image/*';

/** Rough byte size of a data: URI's payload (base64 is ~4/3 of raw bytes). */
function dataUriBytes(uri: string): number {
  const comma = uri.indexOf(',');
  const b64 = comma >= 0 ? uri.slice(comma + 1) : uri;
  return Math.floor((b64.length * 3) / 4);
}

/**
 * Read one File → downscaled image/jpeg data: URI under the size cap.
 * Draws to a canvas at max ~1200px, then lowers quality (and finally scale)
 * until the encoded payload fits ~250KB. Rejects non-images.
 */
async function fileToDataUri(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`${file.name || 'File'} is not an image`);
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('Could not read file'));
    fr.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Could not decode image'));
    el.src = dataUrl;
  });

  let scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));

  const encodeAt = (s: number, q: number): string => {
    const w = Math.max(1, Math.round(img.width * s));
    const h = Math.max(1, Math.round(img.height * s));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not supported');
    // White matte so transparent PNGs don't turn black under JPEG.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', q);
  };

  // First: drop quality at the target scale.
  let q = START_QUALITY;
  let out = encodeAt(scale, q);
  while (dataUriBytes(out) > TARGET_BYTES && q > MIN_QUALITY) {
    q = Math.max(MIN_QUALITY, q - 0.1);
    out = encodeAt(scale, q);
  }
  // Still too big at min quality: shrink the canvas in steps.
  while (dataUriBytes(out) > TARGET_BYTES && scale > 0.2) {
    scale *= 0.8;
    out = encodeAt(scale, MIN_QUALITY);
  }
  return out;
}

/* ── ImageThumb: render a stored data URI / URL, click to enlarge ───────── */
export function ImageThumb({
  src,
  alt = 'attachment',
  size = 56,
  onRemove,
}: {
  src: string;
  alt?: string;
  /** thumbnail edge in px (square, object-cover) */
  size?: number;
  /** when provided, show an X overlay to remove this image */
  onRemove?: () => void;
}) {
  const [zoom, setZoom] = useState(false);

  // Close the lightbox on Escape.
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [zoom]);

  if (!src) return null;

  return (
    <div className="relative inline-block group">
      <button
        type="button"
        onClick={() => setZoom(true)}
        title="Click to enlarge"
        className="block rounded-lg overflow-hidden border border-[#E8D5C4] bg-[#FFF8F0] hover:border-[#af4408] focus:outline-none focus:border-[#af4408]"
        style={{ width: size, height: size }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="w-full h-full object-cover" />
        <span className="absolute bottom-0.5 right-0.5 bg-black/40 text-white rounded p-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <ZoomIn size={11} />
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Remove"
          aria-label="Remove image"
          className="absolute -top-1.5 -right-1.5 bg-white border border-[#E8D5C4] rounded-full p-0.5 text-[#8B7355] hover:text-red-700 hover:border-red-300 shadow-sm"
        >
          <X size={12} />
        </button>
      )}

      {/* Full-screen lightbox — PORTALED to <body> so no ancestor overflow
          (modal, scroll pane) can clip it. */}
      {zoom && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[200] bg-black/80 flex items-center justify-center p-4"
          onClick={() => setZoom(false)}
        >
          <button
            type="button"
            aria-label="Close"
            className="absolute top-3 right-3 text-white/80 hover:text-white"
            onClick={() => setZoom(false)}
          >
            <X size={24} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}

/* ── ImageUpload ────────────────────────────────────────────────────────── */
export interface ImageUploadProps {
  /** Current stored data URIs / URLs (controlled). */
  value?: string[];
  /** Called with the FULL new list after add/remove (multiple mode). */
  onChange?: (dataUris: string[]) => void;
  /** Called once per newly-added image (handy for single-field callers). */
  onAdd?: (dataUri: string) => void;
  /** Allow picking / holding more than one image. Default false. */
  multiple?: boolean;
  /** Hard ceiling on the number of images kept. Default 8 (1 when !multiple). */
  max?: number;
  /** Accessible label + button text. */
  label?: string;
  /** Thumbnail edge in px. */
  thumbSize?: number;
  /** Disable the picker. */
  disabled?: boolean;
}

let uidSeq = 0;

export default function ImageUpload({
  value = [],
  onChange,
  onAdd,
  multiple = false,
  max,
  label = 'Add photo',
  thumbSize = 56,
  disabled = false,
}: ImageUploadProps) {
  const cap = max ?? (multiple ? 8 : 1);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Stable id so the <label htmlFor> ↔ hidden <input id> pairing is unique
  // even when several ImageUploads share a page.
  const idRef = useRef<string>('');
  if (!idRef.current) idRef.current = `imgup-${++uidSeq}`;

  const remaining = Math.max(0, cap - value.length);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setMsg(null);
    const picked = Array.from(files);
    const room = Math.max(0, cap - value.length);
    if (room === 0) {
      setMsg(`Limit reached (${cap} image${cap === 1 ? '' : 's'}).`);
      return;
    }
    const slice = picked.slice(0, room);
    setBusy(true);
    const added: string[] = [];
    const errors: string[] = [];
    for (const f of slice) {
      try {
        added.push(await fileToDataUri(f));
      } catch (e) {
        errors.push(e instanceof Error ? e.message : 'Could not process a file');
      }
    }
    setBusy(false);

    if (added.length) {
      for (const u of added) onAdd?.(u);
      onChange?.(multiple ? [...value, ...added] : added.slice(0, 1));
    }
    const notes: string[] = [];
    if (picked.length > slice.length) notes.push(`Only ${slice.length} added — limit is ${cap}.`);
    if (errors.length) notes.push(errors.join(' '));
    setMsg(notes.length ? notes.join(' ') : null);
  }, [cap, value, multiple, onChange, onAdd]);

  const removeAt = (i: number) => {
    setMsg(null);
    onChange?.(value.filter((_, idx) => idx !== i));
  };

  const canPick = !disabled && !busy && remaining > 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {value.map((src, i) => (
          <ImageThumb key={`${src.slice(0, 24)}-${i}`} src={src} size={thumbSize} onRemove={disabled ? undefined : () => removeAt(i)} />
        ))}

        {canPick && (
          <>
            <input
              ref={inputRef}
              id={idRef.current}
              type="file"
              accept={ACCEPT}
              multiple={multiple}
              className="sr-only"
              aria-label={label}
              onChange={(e) => { handleFiles(e.target.files); e.currentTarget.value = ''; }}
            />
            <label
              htmlFor={idRef.current}
              className="cursor-pointer inline-flex flex-col items-center justify-center gap-1 border border-dashed border-[#D4B896] rounded-lg text-[#8B7355] hover:border-[#af4408] hover:text-[#af4408] bg-[#FFF8F0]"
              style={{ width: thumbSize, height: thumbSize }}
            >
              {busy ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} />}
              <span className="text-[9px] leading-none">{busy ? 'working…' : label}</span>
            </label>
          </>
        )}
      </div>

      {/* size / type guard message */}
      {msg
        ? <p className="text-[11px] text-red-700">{msg}</p>
        : <p className="text-[10px] text-[#8B7355]">JPG / PNG, auto-shrunk to ~1200px. {multiple ? `Up to ${cap} images.` : 'One image.'}</p>}
    </div>
  );
}
