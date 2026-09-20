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
import { FSSAI_FREQUENCIES, FSSAI_SHIFTS, FSSAI_TARGET_KINDS, fssaiRunStatusMeta } from '@/lib/fssai';

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
          <h1 className="text-xl sm:text-2xl font-bold text-[#af4408] leading-tight">{title}</h1>
          {sub && <p className="text-xs text-[#8B7355] mt-0.5">{sub}</p>}
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
        <div className={`min-w-0 text-sm ${t.text}`}>
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
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border flex-nowrap ${className || 'bg-[#FFF1E3] text-[#6B5744] border-[#E8D5C4]'}`}>
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
            <h2 className="font-bold text-[#2D1B0E] leading-tight">{title}</h2>
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
