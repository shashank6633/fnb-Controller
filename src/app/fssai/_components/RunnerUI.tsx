'use client';

/**
 * THE PIECES THE PHONE RUNNER IS BUILT FROM (P3).
 *
 * Shared by the two screens a member of staff actually touches — the picker
 * (/fssai/checklists/run) and the runner (/fssai/checklists/run/[id]) — so a
 * heading, a refusal panel or a bottom sheet cannot look like two different apps
 * on two consecutive taps.
 *
 * WHY THESE ARE NEW AND NOT REUSED. The house shapes (RECON §1.3) are built for a
 * desk: a white card with a #E8D5C4 border, a table, a centred modal. They are
 * reused here verbatim for colour, radius and border. What is NOT reused is SIZE:
 * every control a wet hand has to hit in a kitchen is at least 44px of touch
 * target and most are 56px, and a modal on a phone is a SHEET anchored to the
 * bottom of the screen — where the thumb already is — not a box centred in the
 * middle of a tall page. Those two changes are the whole difference between this
 * and "a desktop form squeezed narrow".
 *
 * ⚠️ globals.css:279-283 force-wraps any `.flex.gap-2|3|4`, so every row that must
 * keep its icon beside its text carries `flex-nowrap`. That rule is documented in
 * RECON §1.1 and it still caught P2b's screens — it is easier to add the class
 * everywhere than to remember which rows need it.
 */

import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import {
  FSSAI_FREQUENCIES, FSSAI_PHOTO_MAX_BYTES, FSSAI_PHOTO_MAX_EDGE_PX, FSSAI_PHOTO_TARGET_BYTES,
  FSSAI_SHIFTS, FSSAI_TARGET_KINDS, fssaiBytesLabel, fssaiDataUriBytes, fssaiRunStatusMeta,
} from '@/lib/fssai';

/* ------------------------------------------------------------------ *
 * Words — one place, so the picker and the runner agree
 * ------------------------------------------------------------------ */

export function shiftLabel(key: string | null | undefined): string {
  const k = String(key ?? '');
  return FSSAI_SHIFTS.find((s) => s.key === k)?.label || (k || 'Any time');
}
export function freqLabel(key: string | null | undefined): string {
  return FSSAI_FREQUENCIES.find((f) => f.key === key)?.label || String(key || '—');
}
export function targetKindLabel(key: string | null | undefined): string {
  return FSSAI_TARGET_KINDS.find((t) => t.key === (key || 'none'))?.label || String(key || '—');
}
/** "What is this check run against?" said as a question a person can answer. */
export function targetPrompt(kind: string | null | undefined): string {
  switch (String(kind || 'none')) {
    case 'equipment':  return 'Which unit are you checking?';
    case 'area':       return 'Which area are you checking?';
    case 'department':  return 'Which department is this for?';
    case 'person':     return 'Who is this check about?';
    case 'grn':        return 'Which delivery is this for?';
    case 'batch':      return 'Which batch is this for?';
    default:           return '';
  }
}

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export const RUNNER_BG = 'bg-[#FFF8F0]';
export const CARD = 'bg-white rounded-xl border border-[#E8D5C4]';
/** 48px tall, 16px text — a phone input that does not trigger iOS zoom. */
export const INPUT =
  'w-full min-h-[48px] text-base border border-[#E8D5C4] rounded-lg px-3 py-2 bg-white ' +
  'focus:outline-none focus:ring-2 focus:ring-[#af4408]/30 focus:border-[#af4408]';

export function PageHead({
  icon, eyebrow, title, sub, right,
}: {
  icon: React.ReactNode;
  eyebrow?: string;
  title: string;
  sub?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="flex items-center gap-3 w-full sm:w-auto sm:flex-1 min-w-0 flex-nowrap">
        <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">{eyebrow}</p>
          )}
          <h1 className="text-xl sm:text-2xl font-bold text-[#af4408] leading-tight break-words">{title}</h1>
          {sub && <p className="text-xs text-[#8B7355] mt-0.5 break-words">{sub}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

const TONES = {
  amber: { box: 'bg-amber-50 border-amber-200', text: 'text-amber-900', icon: 'text-amber-700' },
  red:   { box: 'bg-red-50 border-red-200',     text: 'text-red-800',   icon: 'text-red-700' },
  green: { box: 'bg-green-50 border-green-200', text: 'text-green-800', icon: 'text-green-700' },
  info:  { box: 'bg-[#FFF1E3] border-[#E8D5C4]', text: 'text-[#3D2614]', icon: 'text-[#af4408]' },
} as const;
export type NoteTone = keyof typeof TONES;

/**
 * The panel every refusal, warning and confirmation is shown in.
 *
 * It exists because of one rule from the phase brief: a submit refusal NAMES what
 * it is waiting for, and that sentence must reach the screen intact. A toast that
 * says "Error" where the server said "2 questions still need an answer" is a
 * regression, not a nicety — so the server's own words go here, verbatim.
 */
export function Note({
  tone = 'info', title, children, icon,
}: {
  tone?: NoteTone;
  title?: string;
  children?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  const t = TONES[tone];
  const Fallback = tone === 'red' ? AlertTriangle : tone === 'green' ? CheckCircle2 : tone === 'amber' ? AlertTriangle : Info;
  return (
    <div className={`${t.box} border rounded-xl p-3 sm:p-4`}>
      <div className="flex items-start gap-2.5 flex-nowrap">
        <span className={`${t.icon} shrink-0 mt-0.5`}>{icon || <Fallback size={17} />}</span>
        <div className={`min-w-0 text-sm break-words ${t.text}`}>
          {title && <p className="font-bold">{title}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}

/** A small status/label chip. */
export function Chip({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border flex-nowrap break-words ${className || 'bg-[#FFF1E3] text-[#6B5744] border-[#E8D5C4]'}`}>
      {children}
    </span>
  );
}

export function RunStatusChip({ status }: { status: string | null | undefined }) {
  const meta = fssaiRunStatusMeta(status);
  return <Chip className={meta.color}>{meta.label}</Chip>;
}

/**
 * A BOTTOM SHEET, not a centred modal.
 *
 * On a 390px phone a centred dialog puts its buttons in the middle of the screen
 * and its content under the thumb; anchored to the bottom, the primary action is
 * exactly where the hand already is. It becomes a normal centred card from `sm`
 * up so the same component serves the desk.
 *
 * The overlay keeps the app's `fixed inset-0 bg-black/40` spelling on purpose:
 * globals.css:295 locks body scroll while any element matching that selector is
 * mounted, so the page behind cannot scroll away under the sheet.
 */
export function Sheet({
  open, onClose, title, subtitle, children, footer, busy,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  busy?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center sm:justify-center">
      <div className="w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl border border-[#E8D5C4] shadow-xl max-h-[92vh] sm:max-h-[85vh] flex flex-col">
        <div className="flex items-start gap-3 p-4 border-b border-[#E8D5C4] flex-nowrap">
          <div className="min-w-0 flex-1">
            <h2 className="font-bold text-[#2D1B0E] leading-tight break-words">{title}</h2>
            {subtitle && <p className="text-xs text-[#8B7355] mt-0.5">{subtitle}</p>}
          </div>
          <button
            type="button" onClick={onClose} disabled={busy} aria-label="Close"
            className="w-11 h-11 -mr-1.5 -mt-1.5 rounded-lg flex items-center justify-center text-[#8B7355] hover:bg-[#FFF1E3] disabled:opacity-40 shrink-0"
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto space-y-3 flex-1">{children}</div>
        {footer && (
          <div className="p-4 border-t border-[#E8D5C4] bg-[#FFF8F0] rounded-b-2xl space-y-2">{footer}</div>
        )}
      </div>
    </div>
  );
}

/** The one primary action on a screen. 56px tall, full width on a phone. */
export function PrimaryButton({
  onClick, disabled, busy, children, type = 'button', className = '',
}: {
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: React.ReactNode;
  type?: 'button' | 'submit';
  className?: string;
}) {
  return (
    <button
      type={type} onClick={onClick} disabled={disabled || busy}
      className={`w-full min-h-[56px] inline-flex items-center justify-center gap-2 flex-nowrap text-base font-semibold rounded-xl px-4
                  bg-[#af4408] hover:bg-[#8a3606] text-white disabled:opacity-45 disabled:cursor-not-allowed ${className}`}
    >
      {busy && <Loader2 size={18} className="animate-spin" />}
      {children}
    </button>
  );
}

export function SecondaryButton({
  onClick, disabled, children, className = '', href,
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
  href?: string;
}) {
  const cls = `w-full min-h-[48px] inline-flex items-center justify-center gap-2 flex-nowrap text-sm font-semibold rounded-xl px-4
               border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#3D2614] disabled:opacity-45 ${className}`;
  if (href) return <a href={href} className={cls}>{children}</a>;
  return <button type="button" onClick={onClick} disabled={disabled} className={cls}>{children}</button>;
}

/** A labelled field with a hint, matching the authoring screens' Field. */
export function Field({
  label, hint, children, required,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-[#6B5744]">
        {label}{required && <span className="text-red-600"> *</span>}
      </span>
      <span className="block mt-1">{children}</span>
      {hint && <span className="block text-[11px] text-[#8B7355] mt-1">{hint}</span>}
    </label>
  );
}

/** Progress, as a bar and as a sentence. Both, because neither alone is enough. */
export function Progress({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="w-full">
      <div className="h-2 rounded-full bg-[#E8D5C4] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${done >= total && total > 0 ? 'bg-green-600' : 'bg-[#af4408]'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * THE PHOTOGRAPH, SHRUNK ON THE PHONE
 * ------------------------------------------------------------------ */

export type ShrinkResult =
  | { ok: true; data_uri: string; bytes: number; mime: string; filename: string; width: number; height: number; quality: number }
  | { ok: false; error: string };

/**
 * A phone camera photograph, made small enough to actually arrive.
 *
 * WHY THIS IS NOT AN OPTIMISATION. Production nginx accepts about 1 MB
 * (FSSAI-BUILD-STATE.md HARD RULE 14, measured — not the 25M the conf claims),
 * base64 inflates a payload by 4/3, and a modern phone camera produces 3-8 MB. An
 * uncompressed capture therefore returns a bare 413 that no error handler in this
 * app turns into a sentence: the feature would appear to work and silently never
 * save anything. The resize IS the feature.
 *
 * The three numbers come from src/lib/fssai.ts so the phone and the route cannot
 * disagree: aim for FSSAI_PHOTO_TARGET_BYTES (250 KB), never exceed
 * FSSAI_PHOTO_MAX_BYTES (400 KB, what the server accepts), longest edge
 * FSSAI_PHOTO_MAX_EDGE_PX (1200 px — enough to read a thermometer display).
 *
 * It always produces JPEG. HEIC (an iPhone's native format) cannot be rendered
 * back by most browsers, so storing it would give an inspector a file nobody can
 * open; the canvas re-encode converts it on the way through. If the browser cannot
 * decode the file at all, this says so in words rather than posting junk.
 */
export async function shrinkPhotoToDataUri(
  file: File,
  opts: { maxEdge?: number; targetBytes?: number; hardMaxBytes?: number } = {},
): Promise<ShrinkResult> {
  const maxEdge = opts.maxEdge ?? FSSAI_PHOTO_MAX_EDGE_PX;
  const targetBytes = opts.targetBytes ?? FSSAI_PHOTO_TARGET_BYTES;
  const hardMax = opts.hardMaxBytes ?? FSSAI_PHOTO_MAX_BYTES;

  let bitmap: ImageBitmap | HTMLImageElement | null = null;
  let objectUrl = '';
  try {
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(file);
    } else {
      // Safari fallback: an <img> decoded from an object URL.
      objectUrl = URL.createObjectURL(file);
      bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('decode failed'));
        img.src = objectUrl;
      });
    }
  } catch {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return {
      ok: false,
      error: 'This phone could not read that picture. Take it again with the camera button rather than picking a file.',
    };
  }

  const srcW = 'width' in bitmap ? Number(bitmap.width) : 0;
  const srcH = 'height' in bitmap ? Number(bitmap.height) : 0;
  if (!srcW || !srcH) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return { ok: false, error: 'That picture has no size the app can read. Take it again.' };
  }

  // Successive attempts: shrink the longest edge, then drop the quality. The
  // loop exists because neither alone is predictable — a photograph of a white
  // wall compresses to nothing, one of a busy kitchen shelf does not.
  const edges = [maxEdge, Math.round(maxEdge * 0.8), Math.round(maxEdge * 0.6)];
  const qualities = [0.72, 0.6, 0.5, 0.4];
  let best: { uri: string; bytes: number; w: number; h: number; q: number } | null = null;

  for (const edge of edges) {
    const scale = Math.min(1, edge / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) break;
    // A white ground: a PNG with transparency would otherwise go black in JPEG.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0, w, h);
    for (const q of qualities) {
      const uri = canvas.toDataURL('image/jpeg', q);
      const bytes = fssaiDataUriBytes(uri);
      if (!best || bytes < best.bytes) best = { uri, bytes, w, h, q };
      if (bytes <= targetBytes) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close();
        return {
          ok: true, data_uri: uri, bytes, mime: 'image/jpeg', width: w, height: h, quality: q,
          filename: photoFilename(file),
        };
      }
    }
  }

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  if (bitmap && 'close' in bitmap && typeof bitmap.close === 'function') bitmap.close();

  if (best && best.bytes <= hardMax) {
    // Over the target but inside what the server accepts — keep it rather than
    // lose the evidence.
    return {
      ok: true, data_uri: best.uri, bytes: best.bytes, mime: 'image/jpeg',
      width: best.w, height: best.h, quality: best.q, filename: photoFilename(file),
    };
  }
  return {
    ok: false,
    error: best
      ? `That photograph is still ${fssaiBytesLabel(best.bytes)} after being shrunk, and a photograph on a record must be under ${fssaiBytesLabel(hardMax)}. Take it again from a little further back.`
      : 'That photograph could not be shrunk on this phone. Take it again with the camera button.',
  };
}

/** A filename that says what it is, keeping the original where there is one. */
function photoFilename(file: File): string {
  const base = String(file.name || '').replace(/\.[A-Za-z0-9]+$/, '').slice(0, 80);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `${base || 'check'}-${stamp}.jpg`;
}
