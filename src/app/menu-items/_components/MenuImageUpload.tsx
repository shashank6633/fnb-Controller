'use client';

/**
 * MenuImageUpload — pick a dish photo for the customer QR menu.
 *
 * THE WHOLE POINT IS THAT COMPRESSION HAPPENS HERE, IN THE BROWSER, BEFORE THE
 * BYTES EVER LEAVE THE PHONE. A kitchen photo is routinely 4–12 MB; the guest
 * menu needs a small square. So the file is decoded, centre-cropped to a square,
 * drawn to a canvas and re-encoded down a ladder until it fits ~80 KB, and only
 * that result is POSTed. The original is never uploaded.
 *
 * Why square: every surface that renders this on the guest menu is square or
 * centre-cropped from square — the 88×88 grid thumb, the 54×54 cart thumb, and
 * the full-bleed item hero (which object-fit: cover's a square down to ~2.15:1).
 * Cropping once, here, means the guest never downloads pixels that get thrown
 * away, and the admin sees exactly the framing the guest will see.
 *
 * The ladder drops QUALITY first and only then SIZE, because at this budget a
 * slightly softer 800px square beats a crisp 560px one on a 3× phone screen.
 * WebP is preferred (roughly 40% smaller than JPEG at matched quality, which is
 * what makes 80 KB comfortable rather than tight); Safari versions that cannot
 * encode WebP on a canvas silently fall back to JPEG — detected by feature, not
 * by user-agent, because Safari returns a PNG data URI instead of erroring.
 *
 * On success it calls onChange with the URL minted by POST /api/menu-items/image
 * ('/api/customer/menu-image/<id>'). The caller stores that in the SAME
 * form.image_url field the "paste a URL" input writes, so the two input paths
 * converge on one field with one writer and the save path is unchanged.
 */

import { useCallback, useRef, useState } from 'react';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';

/* ── tuning knobs ──────────────────────────────────────────────────────── */
const TARGET_BYTES = 80 * 1024;          // the owner's ~80KB budget
const EDGE_LADDER = [800, 720, 640, 560]; // square edge, px — tried in order
const Q_START = 0.86;
const Q_STEP = 0.06;
const Q_MIN = 0.55;

export interface Measured {
  originalBytes: number;
  originalW: number;
  originalH: number;
  outBytes: number;
  edge: number;
  mime: string;
  quality: number;
}

const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;

/** Can this browser actually ENCODE WebP on a canvas? Safari <16.4 cannot and
 *  silently hands back a PNG, so test the returned string, not the call. */
function canEncodeWebp(): boolean {
  try {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    return c.toDataURL('image/webp').startsWith('data:image/webp');
  } catch { return false; }
}

/** Decode a File, honouring EXIF orientation so phone photos aren't sideways. */
async function decode(file: File): Promise<{ src: CanvasImageSource; w: number; h: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { src: bmp, w: bmp.width, h: bmp.height };
    } catch { /* fall through to the <img> path */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const el = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not decode that image.'));
      i.src = url;
    });
    return { src: el, w: el.naturalWidth, h: el.naturalHeight };
  } finally { URL.revokeObjectURL(url); }
}

/** Encode one square at a given edge + quality, returning real bytes. */
function encodeSquare(
  src: CanvasImageSource, w: number, h: number, edge: number, mime: string, q: number,
): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  // White matte: a transparent PNG would otherwise go black under JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, edge, edge);
  // Centre square crop — take the largest centred square of the source and
  // scale it to the whole canvas (9-arg drawImage).
  const s = Math.min(w, h);
  ctx.drawImage(src, (w - s) / 2, (h - s) / 2, s, s, 0, 0, edge, edge);
  return new Promise(resolve => canvas.toBlob(b => resolve(b), mime, q));
}

/**
 * Square + shrink a File to <= TARGET_BYTES. Returns the encoded Blob and the
 * measurements, so the UI can show the admin what actually happened.
 */
async function compress(file: File): Promise<{ blob: Blob; m: Measured }> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not an image.');
  const mime = canEncodeWebp() ? 'image/webp' : 'image/jpeg';
  const { src, w, h } = await decode(file);
  if (!w || !h) throw new Error('That image has no dimensions.');

  let best: { blob: Blob; edge: number; q: number } | null = null;

  for (const edge of EDGE_LADDER) {
    for (let q = Q_START; q >= Q_MIN - 1e-9; q -= Q_STEP) {
      const blob = await encodeSquare(src, w, h, edge, mime, Number(q.toFixed(2)));
      if (!blob) continue;
      // Remember the smallest thing we have seen, so a photo that simply cannot
      // reach the budget still yields the best available result instead of null.
      if (!best || blob.size < best.blob.size) best = { blob, edge, q };
      if (blob.size <= TARGET_BYTES) {
        if (typeof (src as ImageBitmap).close === 'function') (src as ImageBitmap).close();
        return {
          blob,
          m: { originalBytes: file.size, originalW: w, originalH: h, outBytes: blob.size, edge, mime, quality: Number(q.toFixed(2)) },
        };
      }
    }
  }

  if (typeof (src as ImageBitmap).close === 'function') (src as ImageBitmap).close();
  if (!best) throw new Error('Could not compress that image.');
  return {
    blob: best.blob,
    m: { originalBytes: file.size, originalW: w, originalH: h, outBytes: best.blob.size, edge: best.edge, mime, quality: best.q },
  };
}

/* ── component ─────────────────────────────────────────────────────────── */
export default function MenuImageUpload({
  value, itemId, onChange, disabled = false,
}: {
  /** Current image_url (our URL or a pasted external one). */
  value: string;
  /** The menu item's id — stored for provenance. Empty for a brand-new item. */
  itemId: string;
  onChange: (url: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [measured, setMeasured] = useState<Measured | null>(null);

  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    setBusy(true);
    try {
      const { blob, m } = await compress(file);
      const fd = new FormData();
      const ext = m.mime === 'image/webp' ? 'webp' : 'jpg';
      fd.append('file', blob, `dish.${ext}`);
      fd.append('item_id', itemId || '');
      fd.append('width', String(m.edge));
      fd.append('height', String(m.edge));
      // api() injects the CSRF header and leaves FormData alone so the browser
      // sets its own multipart boundary.
      const res = await api('/api/menu-items/image', { method: 'POST', body: fd });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(j.error || `Upload failed (HTTP ${res.status})`);
      setMeasured(m);
      onChange(j.url as string);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not process that image.');
    } finally {
      setBusy(false);
    }
  }, [itemId, onChange]);

  return (
    <div className="flex items-start gap-3">
      {/* Preview / picker tile — square, because the result is square. */}
      <div className="shrink-0">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="" width={72} height={72}
               className="w-[72px] h-[72px] rounded-lg object-cover border border-[#E8D5C4] bg-[#FFF8F0]" />
        ) : (
          <div className="w-[72px] h-[72px] rounded-lg border border-dashed border-[#D4B896] bg-[#FFF8F0] flex items-center justify-center text-[#C4A886]">
            <ImagePlus size={20} />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label="Upload dish photo"
          disabled={disabled || busy}
          onChange={e => { void handleFile(e.target.files?.[0]); e.currentTarget.value = ''; }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D4B896] bg-white text-sm text-[#6B5744] hover:border-[#af4408] hover:text-[#af4408] disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
            {busy ? 'Compressing…' : value ? 'Replace photo' : 'Upload photo'}
          </button>
          {value && !busy && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => { onChange(''); setMeasured(null); setErr(null); }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#8B7355] hover:border-red-300 hover:text-red-700"
            >
              <Trash2 size={14} /> Remove
            </button>
          )}
        </div>

        {err ? (
          <p className="text-[11px] text-red-700 mt-1">{err}</p>
        ) : measured ? (
          <p className="text-[10px] text-[#8B7355] mt-1">
            {measured.originalW}×{measured.originalH} · {kb(measured.originalBytes)}
            {' → '}
            <strong className="text-[#6B5744]">
              {measured.edge}×{measured.edge} · {kb(measured.outBytes)}
            </strong>
            {' '}({measured.mime.replace('image/', '')} q{measured.quality}) — compressed in your browser before upload.
          </p>
        ) : (
          <p className="text-[10px] text-[#8B7355] mt-1">
            JPG/PNG/WebP. Cropped square and shrunk to ~80&nbsp;KB in your browser — upload the original straight off the camera.
          </p>
        )}
      </div>
    </div>
  );
}
