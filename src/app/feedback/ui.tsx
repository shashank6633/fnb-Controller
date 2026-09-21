'use client';

/**
 * Guest Feedback — shared presentational primitives for the module's four pages.
 *
 * Why these live here and not in `src/components`: P1 Lane B owns
 * `src/app/feedback/**` and NOTHING else (db.ts, page-catalog.ts, Sidebar.tsx
 * and proxy.ts belong to Lane A). Anything shared by the four pages therefore
 * has to be module-local. If a later phase wants one of these app-wide, move it
 * to `src/components` in a lane that owns that directory — do not copy it.
 *
 * The palette is the Captain app's, matched by hand from `src/app/captain`
 * (layout.tsx, CaptainShell.tsx, order/[id]/page.tsx) because the owner asked
 * this module to look like it. Those are literal hex values in that app too,
 * not Tailwind theme colours, so they are repeated here rather than themed.
 *
 * ONE LAYOUT RULE WORTH KNOWING: unlike `/captain`, these pages render INSIDE
 * `AppShell` — `src/components/AppShell.tsx:16` gives the chrome-less `bare`
 * layout only to `/login`, real `/print` segments and `/captain*`. So on a phone
 * there is a 48px-tall sticky `MobileTopBar` above us, and on `lg:` a 260px
 * in-flow sidebar beside us. Consequences:
 *   · a bottom bar must be `sticky bottom-0`, NOT `fixed … lg:left-72` the way
 *     the captain order screen does it. Fixed + a hard left offset would sit on
 *     top of the sidebar, and would be wrong again the moment the user collapses
 *     it to `w-16` (Sidebar.tsx:736). Sticky follows the main column for free.
 *   · full-bleed rows cancel AppShell's own padding with the matching negative
 *     margin (`-mx-3 sm:-mx-5 lg:-mx-8`), then re-apply it inside.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/* ── tokens ──────────────────────────────────────────────────────────────── */

export const FB = {
  bg: '#FFF8F0',
  ink: '#2D1B0E',
  accent: '#af4408',
  muted: '#6B5744',
  faint: '#8B7355',
  line: '#E8D5C4',
  lineSoft: '#F0E4D6',
  tint: '#FFF1E3',
} as const;

/* ── the module's own nav ────────────────────────────────────────────────── */
/* Three tabs, not four: /feedback/take/[orderId] is reached by tapping a table,
 * never from a nav bar — it is meaningless without an order id. This bar exists
 * so the four shells are navigable NOW; the real sidebar entries are Lane A's
 * (page-catalog.ts AND Sidebar.tsx — hard rule 10, both files or the page is
 * gated but invisible). */

const TABS = [
  { href: '/feedback', label: 'Floor' },
  { href: '/feedback/tracker', label: 'Tracker' },
  { href: '/feedback/analytics', label: 'Analytics' },
] as const;

export function FeedbackTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1 overflow-x-auto no-scrollbar" aria-label="Guest Feedback">
      {TABS.map((t) => {
        const active = t.href === '/feedback' ? pathname === '/feedback' : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={`shrink-0 rounded-full px-3.5 py-2 text-[13px] font-semibold transition active:scale-95 ${
              active
                ? 'bg-[#af4408] text-white'
                : 'bg-white border border-[#E8D5C4] text-[#6B5744]'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/* ── page frame ──────────────────────────────────────────────────────────── */

/**
 * The page header. `sticky top-12 lg:top-0` sits directly under the mobile
 * top bar (h-12, z-40 — MobileTopBar.tsx:60); on lg: that bar is gone so it
 * pins to the viewport. z-20 keeps it under MobileTopBar and under any sheet.
 */
export function PageHead({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="sticky top-12 lg:top-0 z-20 -mx-3 sm:-mx-5 lg:-mx-8 px-3 sm:px-5 lg:px-8 py-2.5 bg-[#FFF8F0]/95 backdrop-blur border-b border-[#E8D5C4]">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-extrabold leading-tight text-[#2D1B0E] truncate">{title}</h1>
          {subtitle ? (
            <p className="text-[11px] text-[#8B7355] leading-tight mt-0.5">{subtitle}</p>
          ) : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
      <div className="mt-2">
        <FeedbackTabs />
      </div>
    </header>
  );
}

/** Wraps a page body. `pb-28` reserves room for the sticky bottom bar. */
export function PageBody({ children }: { children: ReactNode }) {
  return <div className="pb-28 max-w-5xl">{children}</div>;
}

/**
 * The sticky bottom bar. Sticky (not fixed) so it tracks the main column at
 * every sidebar width — see the layout note at the top of this file.
 */
export function StickyBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-20 -mx-3 sm:-mx-5 lg:-mx-8 px-3 sm:px-5 lg:px-8 py-2.5 bg-white border-t border-[#E8D5C4] shadow-[0_-4px_12px_rgba(45,27,14,0.06)]">
      <div className="max-w-5xl">{children}</div>
    </div>
  );
}

/* ── controls ────────────────────────────────────────────────────────────── */

/** A horizontally scrollable strip. Chips never wrap — they scroll, which is
 *  what keeps a six-filter row usable at 390px without a second line. */
export function Scroller({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div
      role={label ? 'group' : undefined}
      aria-label={label}
      className="flex flex-nowrap items-center gap-1.5 overflow-x-auto no-scrollbar -mx-3 px-3 sm:mx-0 sm:px-0 [&>*]:shrink-0 [&>*]:whitespace-nowrap"
    >
      {children}
    </div>
  );
}

export function Chip({
  active,
  onClick,
  children,
  className = '',
  disabled,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`rounded-full px-3 py-2 text-[12px] font-semibold border transition active:scale-95 disabled:opacity-40 disabled:active:scale-100 ${
        active
          ? 'bg-[#af4408] text-white border-[#af4408]'
          : 'bg-white text-[#6B5744] border-[#E8D5C4]'
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** The house primary button — 44px+ tall, the Captain app's `active:scale-95`. */
export function PrimaryButton({
  children,
  onClick,
  disabled,
  className = '',
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`w-full bg-[#af4408] text-white py-3.5 rounded-xl text-base font-semibold active:scale-95 transition disabled:opacity-40 disabled:active:scale-100 ${className}`}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`bg-white border border-[#E8D5C4] text-[#6B5744] rounded-xl px-3 py-2.5 text-sm font-semibold active:scale-95 transition disabled:opacity-40 disabled:active:scale-100 ${className}`}
    >
      {children}
    </button>
  );
}

/** A native select styled like the rest. Native is deliberate: on a phone it
 *  gets the OS picker, which beats any custom dropdown one-handed. */
export function Select({
  value,
  onChange,
  options,
  label,
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly { v: string; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <label className={`flex items-center gap-1.5 bg-white border border-[#E8D5C4] rounded-full pl-3 pr-1 py-1 ${className}`}>
      <span className="text-[11px] font-semibold text-[#8B7355] whitespace-nowrap">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="bg-transparent text-[12px] font-semibold text-[#2D1B0E] py-1.5 pr-1 outline-none max-w-[9rem]"
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ── display ─────────────────────────────────────────────────────────────── */

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-white border border-[#E8D5C4] rounded-2xl ${className}`}>{children}</div>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 mt-5 mb-2">
      <h2 className="text-[13px] font-extrabold uppercase tracking-wide text-[#8B7355]">
        {children}
      </h2>
      {hint ? <span className="text-[11px] text-[#8B7355]">{hint}</span> : null}
    </div>
  );
}

/** A KPI tile. Two per row at 390px, which keeps the number legible. */
export function Tile({
  label,
  value,
  hint,
  tone = 'plain',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'plain' | 'good' | 'warn' | 'bad' | 'accent';
}) {
  const toneCls: Record<string, string> = {
    plain: 'text-[#2D1B0E]',
    good: 'text-emerald-700',
    warn: 'text-amber-700',
    bad: 'text-red-700',
    accent: 'text-[#af4408]',
  };
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-2xl p-3">
      <div className="text-[11px] font-semibold text-[#8B7355] leading-tight">{label}</div>
      <div className={`text-2xl font-extrabold leading-tight mt-1 ${toneCls[tone]}`}>{value}</div>
      {hint ? <div className="text-[10px] text-[#8B7355] leading-tight mt-0.5">{hint}</div> : null}
    </div>
  );
}

/** Wide content — every table in this module goes through here. A page body
 *  that scrolls sideways at 390px is a failed shell; a table that scrolls
 *  inside its own box is not. */
export function TableScroll({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto no-scrollbar -mx-3 px-3 sm:mx-0 sm:px-0">
      <div className="min-w-[640px]">{children}</div>
    </div>
  );
}

/** The "this is a shell" marker. Every screen carries one so nobody mistakes
 *  placeholder rows for live data — and so P2..P5 can grep for it. */
export function PlaceholderNote({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 rounded-xl border border-dashed border-[#D4B896] bg-[#FFF1E3] px-3 py-2 text-[11px] leading-snug text-[#6B5744]">
      <span className="font-bold text-[#af4408]">P1 SHELL · </span>
      {children}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="bg-white border border-dashed border-[#E8D5C4] rounded-2xl px-4 py-10 text-center text-sm text-[#8B7355]">
      {children}
    </div>
  );
}

/* ── formatting ──────────────────────────────────────────────────────────── */

/** "42m" / "2h 05m" — the Table Open elapsed display from §3 Page 1. */
export function elapsed(fromIso: string, nowMs: number): string {
  const started = Date.parse(fromIso);
  if (!Number.isFinite(started)) return '—';
  const mins = Math.max(0, Math.floor((nowMs - started) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/** Percent with one decimal only when it needs one. */
export function pct(n: number, d: number): string {
  if (!d) return '—';
  const v = (n / d) * 100;
  return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}%`;
}
