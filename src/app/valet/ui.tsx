'use client';

/**
 * VALET — shared client kit for the four staff screens. Same tokens and frame
 * as the Guest Feedback module (src/app/feedback/ui.tsx) so valet looks native.
 *
 * LIVE DATA (spec §8, §11): useLive() refetches on a timer ALWAYS, and also the
 * instant the SSE stream says something changed. The stream is an accelerator,
 * never the source of truth — a pm2 worker that cannot hear another worker's
 * events still converges within one poll. The screen always says how fresh
 * its data is: Live / Updating by polling / Offline + "updated hh:mm:ss".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Wifi, WifiOff, RefreshCw, Car, ParkingSquare, KeyRound, Timer, CheckCircle2, AlertTriangle, CalendarClock,
  Hand, ArrowRightLeft, Ban, type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';

export const VT = {
  bg: '#FFF8F0', ink: '#2D1B0E', accent: '#af4408', muted: '#6B5744', faint: '#8B7355',
  line: '#E8D5C4', lineSoft: '#F0E4D6', tint: '#FFF1E3',
} as const;

// ── context: who am I, which outlet ─────────────────────────────────────────

export interface ValetCtx {
  user: { id: string; name: string; is_admin: boolean; head: boolean; attendant: boolean; host: boolean };
  outlets: { id: string; name: string; enabled: boolean }[];
  default_outlet_id: string | null;
  no_outlet_reason: string;
}

const OUTLET_KEY = 'fnb:valet:outlet';

export function useValetContext() {
  const [ctx, setCtx] = useState<ValetCtx | null>(null);
  const [error, setError] = useState('');
  const [outletId, setOutletIdState] = useState<string>('');
  useEffect(() => {
    let alive = true;
    fetch('/api/valet/context', { cache: 'no-store' }).then(async r => {
      const j = await r.json().catch(() => ({}));
      if (!alive) return;
      if (!r.ok) { setError(j.error || 'Could not load valet access.'); return; }
      setCtx(j);
      let saved = '';
      try { saved = localStorage.getItem(OUTLET_KEY) || ''; } catch { /* private mode */ }
      const ids = (j.outlets as ValetCtx['outlets']).map(o => o.id);
      setOutletIdState(ids.includes(saved) ? saved : (j.default_outlet_id || ''));
    }).catch(() => alive && setError('No connection. Check the network and reload.'));
    return () => { alive = false; };
  }, []);
  const setOutletId = useCallback((id: string) => {
    setOutletIdState(id);
    try { localStorage.setItem(OUTLET_KEY, id); } catch { /* ignore */ }
  }, []);
  return { ctx, error, outletId, setOutletId };
}

// ── live data ───────────────────────────────────────────────────────────────

export type LiveStatus = 'live' | 'polling' | 'offline' | 'loading';

export function useLive<T>(url: string | null, outletId: string, pollMs = 10_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [status, setStatus] = useState<LiveStatus>('loading');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const sseOk = useRef(false);
  const inflight = useRef(false);
  const again = useRef(false);

  const load = useCallback(async () => {
    if (!url) return;
    if (inflight.current) { again.current = true; return; }
    inflight.current = true;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError({ message: j.error || `Error ${r.status}`, code: j.code }); setStatus(s => (s === 'loading' ? 'polling' : s)); }
      else { setData(j as T); setError(null); setUpdatedAt(Date.now()); setStatus(sseOk.current ? 'live' : 'polling'); }
    } catch {
      setStatus('offline');
    } finally {
      inflight.current = false;
      if (again.current) { again.current = false; void load(); }
    }
  }, [url]);

  useEffect(() => {
    if (!url) return;
    void load();
    const iv = setInterval(() => { if (!document.hidden) void load(); }, pollMs);
    const onVis = () => { if (!document.hidden) void load(); };
    const onOnline = () => void load();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onOnline);
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (!outletId) return;
      es = new EventSource(`/api/valet/stream?outlet=${encodeURIComponent(outletId)}`);
      es.onopen = () => { sseOk.current = true; setStatus(s => (s === 'offline' ? s : 'live')); void load(); };
      es.onmessage = () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void load(), 250);
      };
      es.onerror = () => {
        sseOk.current = false;
        setStatus(s => (s === 'live' ? 'polling' : s));
        es?.close();
        retry = setTimeout(connect, 5000);   // reconnect, then resync via onopen → load()
      };
    };
    connect();
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onOnline);
      if (retry) clearTimeout(retry);
      if (debounce) clearTimeout(debounce);
      es?.close();
      sseOk.current = false;
    };
  }, [url, outletId, pollMs, load]);

  return { data, error, status, updatedAt, reload: load };
}

/** POST a valet command. Returns the JSON or throws Error(message) with .code. */
export async function valetCmd<T = Record<string, unknown>>(outletId: string, cmd: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await api('/api/valet/command', { method: 'POST', body: { cmd, outlet_id: outletId, ...body } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || `Error ${r.status}`) as Error & { code?: string; extra?: unknown };
    e.code = j.code; e.extra = j;
    throw e;
  }
  return j as T;
}

// ── frame ───────────────────────────────────────────────────────────────────

const TABS: { href: string; label: string; need: 'head' | 'attendant' | 'host' }[] = [
  { href: '/valet', label: 'Head Dashboard', need: 'head' },
  { href: '/valet/attendant', label: 'Attendant', need: 'attendant' },
  { href: '/valet/desk', label: 'Desk', need: 'host' },
  { href: '/valet/settings', label: 'Settings', need: 'head' },
];

export function ValetTabs({ ctx }: { ctx: ValetCtx | null }) {
  const pathname = usePathname();
  const tabs = TABS.filter(t => !ctx || ctx.user[t.need]);
  return (
    <nav className="flex items-center gap-1 overflow-x-auto no-scrollbar" aria-label="Valet Parking">
      {tabs.map(t => {
        const active = t.href === '/valet' ? pathname === '/valet' : pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined}
            className={`shrink-0 rounded-full px-3.5 py-2 text-[13px] font-semibold transition active:scale-95 ${active ? 'bg-[#af4408] text-white' : 'bg-white border border-[#E8D5C4] text-[#6B5744]'}`}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function PageHead({ title, subtitle, right, ctx }: { title: string; subtitle?: ReactNode; right?: ReactNode; ctx: ValetCtx | null }) {
  return (
    <header className="sticky top-12 lg:top-0 z-20 -mx-3 sm:-mx-5 lg:-mx-8 px-3 sm:px-5 lg:px-8 py-2.5 bg-[#FFF8F0]/95 backdrop-blur border-b border-[#E8D5C4]">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
          <h1 className="text-lg font-extrabold leading-tight text-[#2D1B0E] truncate">{title}</h1>
          {subtitle ? <div className="text-[11px] text-[#8B7355] leading-tight mt-0.5">{subtitle}</div> : null}
        </div>
        {right ? <div className="shrink-0 flex items-center gap-2 flex-wrap">{right}</div> : null}
      </div>
      <div className="mt-2"><ValetTabs ctx={ctx} /></div>
    </header>
  );
}

export function OutletPicker({ ctx, outletId, onChange }: { ctx: ValetCtx; outletId: string; onChange: (id: string) => void }) {
  if (ctx.outlets.length <= 1) return ctx.outlets[0] ? <span className="text-xs font-semibold text-[#6B5744]">{ctx.outlets[0].name}</span> : null;
  return (
    <label className="text-xs text-[#6B5744] flex items-center gap-1">
      <span className="sr-only">Outlet</span>
      <select value={outletId} onChange={e => onChange(e.target.value)}
        className="rounded-lg border border-[#E8D5C4] bg-white px-2 py-1.5 text-sm text-[#2D1B0E]">
        {ctx.outlets.map(o => <option key={o.id} value={o.id}>{o.name}{o.enabled ? '' : ' (valet off)'}</option>)}
      </select>
    </label>
  );
}

export function LiveBadge({ status, updatedAt, onRefresh }: { status: LiveStatus; updatedAt: number | null; onRefresh?: () => void }) {
  const now = useNow(5000);
  const age = updatedAt ? Math.round((now - updatedAt) / 1000) : null;
  const stale = age !== null && age > 45;
  const tone = status === 'offline' || stale ? 'bg-red-50 text-red-800 border-red-200'
    : status === 'live' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-amber-50 text-amber-800 border-amber-200';
  const label = status === 'offline' ? 'Offline' : stale ? 'Data is stale' : status === 'live' ? 'Live' : status === 'loading' ? 'Loading' : 'Updating (polling)';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tone}`} role="status" aria-live="polite">
      {status === 'offline' || stale ? <WifiOff size={13} aria-hidden /> : <Wifi size={13} aria-hidden />}
      {label}
      {updatedAt ? <span className="font-normal opacity-80">· {new Date(updatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span> : null}
      {onRefresh ? (
        <button type="button" onClick={onRefresh} className="ml-0.5 rounded p-0.5 hover:bg-black/5" aria-label="Refresh now"><RefreshCw size={12} aria-hidden /></button>
      ) : null}
    </span>
  );
}

// ── status vocabulary: text + icon + colour, never colour alone ─────────────

const STATE_META: Record<string, { label: string; icon: LucideIcon; cls: string }> = {
  CHECKED_IN: { label: 'Checked in', icon: KeyRound, cls: 'bg-sky-50 text-sky-800 border-sky-200' },
  PARKING: { label: 'Parking', icon: Car, cls: 'bg-sky-50 text-sky-800 border-sky-200' },
  PARKED: { label: 'Parked', icon: ParkingSquare, cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  RETRIEVING: { label: 'Fetching', icon: Car, cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  READY_AT_GATE: { label: 'At gate', icon: CheckCircle2, cls: 'bg-emerald-100 text-emerald-900 border-emerald-300' },
  RELOCATING: { label: 'Moving to holding', icon: ArrowRightLeft, cls: 'bg-orange-50 text-orange-800 border-orange-200' },
  HOLDING_NEAR_GATE: { label: 'In holding', icon: Hand, cls: 'bg-orange-50 text-orange-800 border-orange-200' },
  HANDED_OVER: { label: 'Handed over', icon: CheckCircle2, cls: 'bg-stone-100 text-stone-700 border-stone-200' },
  VOIDED: { label: 'Void', icon: Ban, cls: 'bg-stone-100 text-stone-500 border-stone-200' },
  SCHEDULED: { label: 'Booked', icon: CalendarClock, cls: 'bg-violet-50 text-violet-800 border-violet-200' },
  QUEUED: { label: 'Waiting', icon: Timer, cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  ASSIGNED: { label: 'Claimed', icon: Hand, cls: 'bg-sky-50 text-sky-800 border-sky-200' },
  IN_PROGRESS: { label: 'Fetching', icon: Car, cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  READY: { label: 'Ready', icon: CheckCircle2, cls: 'bg-emerald-100 text-emerald-900 border-emerald-300' },
};

export function StateChip({ state, small }: { state: string; small?: boolean }) {
  const m = STATE_META[state] || { label: state.toLowerCase().replace(/_/g, ' '), icon: AlertTriangle, cls: 'bg-stone-100 text-stone-700 border-stone-200' };
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border ${small ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'} font-semibold ${m.cls}`}>
      <Icon size={small ? 11 : 13} aria-hidden />{m.label}
    </span>
  );
}

// ── time helpers ────────────────────────────────────────────────────────────

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
export const hhmm = (iso?: string | null) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—';
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
export function countdown(iso: string | null | undefined, now: number): { text: string; over: boolean } {
  if (!iso) return { text: '—', over: false };
  const s = Math.round((Date.parse(iso) - now) / 1000);
  const a = Math.abs(s);
  const t = `${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
  return { text: s >= 0 ? t : `+${t}`, over: s < 0 };
}

// ── small building blocks ───────────────────────────────────────────────────

export function Panel({ title, right, children, className = '' }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-[#E8D5C4] bg-white p-3 sm:p-4 ${className}`}>
      {title ? <div className="mb-2 flex items-center justify-between gap-2"><h2 className="text-sm font-bold text-[#2D1B0E]">{title}</h2>{right}</div> : null}
      {children}
    </section>
  );
}

export function Btn({ children, onClick, kind = 'primary', disabled, big, type = 'button', className = '', title }: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'ghost' | 'danger' | 'ok'; disabled?: boolean; big?: boolean;
  type?: 'button' | 'submit'; className?: string; title?: string;
}) {
  const k = kind === 'primary' ? 'bg-[#af4408] text-white border-[#af4408]'
    : kind === 'danger' ? 'bg-red-700 text-white border-red-700'
    : kind === 'ok' ? 'bg-emerald-700 text-white border-emerald-700'
    : 'bg-white text-[#2D1B0E] border-[#E8D5C4]';
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title}
      className={`${big ? 'min-h-[56px] text-base px-4' : 'min-h-[40px] text-sm px-3'} rounded-xl border font-bold transition active:scale-[.98] disabled:opacity-50 ${k} ${className}`}>
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-[#6B5744] mb-1">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] text-[#8B7355] mt-0.5">{hint}</span> : null}
    </label>
  );
}
export const inputCls = 'w-full min-h-[44px] rounded-lg border border-[#E8D5C4] bg-white px-3 py-2 text-[15px] text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#f5b48a]';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" role="dialog" aria-modal="true" aria-label={title}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'} max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white p-4 shadow-xl`}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-base font-extrabold text-[#2D1B0E]">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-[#6B5744] hover:bg-[#FFF1E3]" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  if (!message) return null;
  return <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{message}</div>;
}
export function InfoNote({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] px-3 py-2 text-sm text-[#6B5744]">{children}</div>;
}

/** Whole-screen states: loading, refused, no outlet. */
export function Gate({ ctxError, ctx, children }: { ctxError: string; ctx: ValetCtx | null; children: ReactNode }) {
  if (ctxError) return <div className="max-w-xl mt-6"><ErrorNote message={ctxError} /></div>;
  if (!ctx) return <p className="mt-6 text-sm text-[#8B7355]">Loading…</p>;
  if (!ctx.outlets.length) return <div className="max-w-xl mt-6"><InfoNote>{ctx.no_outlet_reason}</InfoNote></div>;
  return <>{children}</>;
}

// ── in-app questions (replaces window.prompt/confirm: native dialogs look
// foreign, behave badly on phones, and cannot enforce "a reason is required") ──

export interface AskOptions {
  title: string;
  /** Omit for a yes/no confirmation. */
  label?: string;
  placeholder?: string;
  initial?: string;
  /** Minimum characters for the answer (a recorded reason uses 5). */
  min?: number;
  confirmText?: string;
  danger?: boolean;
  inputMode?: 'text' | 'numeric';
}

function AskModal({ o, onDone }: { o: AskOptions; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(o.initial ?? '');
  const isText = o.label !== undefined;
  const min = o.min ?? 0;
  const ok = !isText || v.trim().length >= min;
  return (
    <Modal title={o.title} onClose={() => onDone(null)}>
      <form onSubmit={e => { e.preventDefault(); if (ok) onDone(isText ? v.trim() : ''); }} className="space-y-3">
        {isText ? (
          <Field label={o.label!} hint={min >= 3 ? `At least ${min} characters — it is recorded.` : undefined}>
            <input className={inputCls} value={v} onChange={e => setV(e.target.value)} placeholder={o.placeholder} autoFocus inputMode={o.inputMode} maxLength={300} />
          </Field>
        ) : null}
        <div className="flex gap-2 justify-end">
          <Btn kind="ghost" onClick={() => onDone(null)}>Cancel</Btn>
          <Btn type="submit" kind={o.danger ? 'danger' : 'primary'} disabled={!ok}>{o.confirmText || 'OK'}</Btn>
        </div>
      </form>
    </Modal>
  );
}

/** `const { ask, askEl } = useAsk();` — render {askEl}, then `await ask({...})`
 *  resolves to the answer ('' for a confirmed yes/no) or null when cancelled. */
export function useAsk() {
  const [req, setReq] = useState<null | { o: AskOptions; resolve: (v: string | null) => void }>(null);
  const ask = useCallback((o: AskOptions) => new Promise<string | null>(resolve => setReq({ o, resolve })), []);
  const askEl = req ? <AskModal key={req.o.title} o={req.o} onDone={v => { req.resolve(v); setReq(null); }} /> : null;
  return { ask, askEl };
}

/** QR rendered in the browser (lazy-loaded 'qrcode'); the text never leaves the device. */
export function QrImage({ text, size = 220, label }: { text: string; size?: number; label: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    import('qrcode').then(m => (m.default || m).toDataURL(text, { margin: 1, width: size, errorCorrectionLevel: 'M' }))
      .then(u => { if (alive) setSrc(u); }).catch(() => { if (alive) setSrc(''); });
    return () => { alive = false; };
  }, [text, size]);
  if (!src) return <div style={{ width: size, height: size }} className="rounded-lg bg-[#FFF1E3]" aria-label={`${label} (loading)`} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} width={size} height={size} alt={label} className="rounded-lg border border-[#E8D5C4] bg-white" />;
}

export function useCmd(outletId: string, after?: () => void) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = useCallback(async <T = Record<string, unknown>>(cmd: string, body: Record<string, unknown> = {}): Promise<T | null> => {
    setBusy(true); setErr('');
    try { const r = await valetCmd<T>(outletId, cmd, body); after?.(); return r; }
    catch (e) { setErr((e as Error).message); after?.(); return null; }
    finally { setBusy(false); }
  }, [outletId, after]);
  return useMemo(() => ({ run, busy, err, setErr }), [run, busy, err]);
}
