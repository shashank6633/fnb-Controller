'use client';

/**
 * Kitchen Scan-Out — the kitchen supervisor scans each plated item's printed
 * sticker (a QR of the order_item id) as it leaves the kitchen. Either:
 *   (a) a hardware HID barcode scanner "types" the id + Enter into the focused box, or
 *   (b) the supervisor taps the item row (manual send / scanner-outage override).
 * Either flips that line to `kitchen_sent`, which pushes a live SSE update to the
 * captain tablet. Purely additive tracking — no KOT insert, no stock deduction.
 *
 * Contract (already built, do not change):
 *   GET  /api/dine-in/kds/scan-out → { items: [...] } fired-but-not-sent, oldest first.
 *   POST /api/dine-in/kds/scan-out { code } | { item_id } →
 *        { ok, flipped, already, reason, item: { id, name, status, kitchen_sent_at, table_number } }
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import {
  ScanLine, CheckCircle2, Loader2, Clock, Utensils, AlertCircle,
} from 'lucide-react';

// ---- Types ----------------------------------------------------------------
interface AwaitItem {
  id: string;
  name: string;
  quantity: number;
  fired_at: string | null;
  notes: string | null;
  kot_number: number | null;
  station: string | null;
  order_id: string;
  order_number: number | null;
  table_number: string | null;
  zone: string | null;
}

interface ScanItem {
  id: string;
  name: string;
  status: string;
  kitchen_sent_at: string | null;
  table_number: string | null;
}

interface ScanResult {
  ok?: boolean;
  flipped?: boolean;
  already?: boolean;
  reason?: 'sent' | 'already_sent' | 'already_served' | 'not_fired' | string;
  item?: ScanItem;
  error?: string;
}

type ToastKind = 'success' | 'warning' | 'error';
interface Toast { kind: ToastKind; text: string; at: number; }

const POLL_MS = 3500;
const DUP_GUARD_MS = 1200;
const TOAST_MS = 2500;

// ---- Helpers --------------------------------------------------------------
/** IST time like "07:45 PM". Guards empty / invalid; normalises SQLite
 *  `YYYY-MM-DD HH:MM:SS` (UTC, no tz) into a parseable ISO string first. */
function istTime(iso?: string | null): string {
  if (!iso) return '';
  let s = String(iso);
  if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  try {
    return d.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch {
    return '';
  }
}

// ---- Page -----------------------------------------------------------------
export default function KitchenScanOutPage() {
  const [awaiting, setAwaiting] = useState<AwaitItem[]>([]);
  const [value, setValue] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Duplicate-guard: ignore the same code fired twice within DUP_GUARD_MS.
  const lastScan = useRef<{ code: string; at: number }>({ code: '', at: 0 });

  // ---- Focus management: the HID scanner must always land in the box -------
  const focusInput = useCallback(() => {
    // Defer so it wins after row taps / toast renders steal focus.
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    focusInput();
    const onWinClick = () => focusInput();
    const onVisible = () => { if (!document.hidden) focusInput(); };
    window.addEventListener('click', onWinClick);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('click', onWinClick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [focusInput]);

  // ---- Best-effort success feedback (vibrate + short WebAudio beep) --------
  const successBuzz = useCallback(() => {
    try { navigator.vibrate?.(60); } catch { /* noop */ }
    try {
      const Ctx: typeof AudioContext | undefined =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = audioRef.current ?? (audioRef.current = new Ctx());
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.16);
    } catch { /* noop */ }
  }, []);

  const showToast = useCallback((kind: ToastKind, text: string) => {
    setToast({ kind, text, at: Date.now() });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  // ---- Load the awaiting list ---------------------------------------------
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/dine-in/kds/scan-out', { cache: 'no-store' });
      if (!r.ok) return;
      const j: { items?: AwaitItem[] } = await r.json();
      setAwaiting(Array.isArray(j.items) ? j.items : []);
    } catch { /* keep last good list on transient errors */ }
    finally { setLoaded(true); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // ---- Send a scan / tap ---------------------------------------------------
  const send = useCallback(async (payload: { code: string } | { item_id: string }) => {
    setSending(true);
    try {
      const r = await api('/api/dine-in/kds/scan-out', { method: 'POST', body: payload });
      const j: ScanResult = await r.json().catch(() => ({} as ScanResult));

      if (r.status === 404) {
        showToast('error', 'No item matches this code');
        return;
      }
      if (!r.ok) {
        showToast('error', j?.error || 'Scan failed — try again');
        return;
      }

      const name = j.item?.name || 'Item';
      const table = j.item?.table_number;

      if (j.flipped) {
        showToast('success', `✓ ${name}${table ? ` · Table ${table}` : ''} — sent`);
        successBuzz();
        load(); // refetch right after a successful flip
      } else if (j.already) {
        const verb =
          j.reason === 'already_served' ? 'already served'
          : j.reason === 'not_fired' ? 'not fired yet'
          : 'already sent';
        showToast('warning', `${name} ${verb}`);
        load();
      } else {
        // Defensive: ok but neither flag set.
        showToast('warning', `${name} — no change`);
        load();
      }
    } catch {
      showToast('error', 'No item matches this code');
    } finally {
      setSending(false);
      focusInput();
    }
  }, [showToast, successBuzz, load, focusInput]);

  // ---- Scanner / manual submit --------------------------------------------
  const onSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const code = value.trim();
    setValue('');
    focusInput();
    if (!code) return;

    const now = Date.now();
    // Ignore a re-scan of the identical code within the guard window.
    if (code === lastScan.current.code && now - lastScan.current.at < DUP_GUARD_MS) return;
    lastScan.current = { code, at: now };

    void send({ code });
  }, [value, send, focusInput]);

  // ---- Tap a row (manual send / scanner-outage override) ------------------
  const onTapRow = useCallback((row: AwaitItem) => {
    void send({ item_id: row.id });
  }, [send]);

  // ---- Cleanup toast timer on unmount -------------------------------------
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const count = awaiting.length;

  const toastStyle: Record<ToastKind, string> = {
    success: 'bg-emerald-50 border-emerald-300 text-emerald-800',
    warning: 'bg-amber-50 border-amber-300 text-amber-800',
    error:   'bg-red-50 border-red-300 text-red-700',
  };
  const ToastIcon = toast?.kind === 'success' ? CheckCircle2 : AlertCircle;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="mx-auto w-full max-w-2xl px-4 py-5 sm:py-7">

        {/* Header */}
        <header className="mb-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold tracking-widest text-[#8B7355]">KITCHEN</p>
              <h1 className="text-2xl font-bold leading-tight sm:text-3xl">Scan-Out</h1>
            </div>
            <span
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#E8D5C4] bg-white px-3 py-1.5 text-sm font-semibold text-[#af4408]"
              aria-live="polite"
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#af4408] opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#af4408]" />
              </span>
              {count} awaiting
            </span>
          </div>
          <p className="mt-1.5 text-sm text-[#6B5744]">
            Scan each plate&rsquo;s sticker as it leaves the kitchen — the captain sees it instantly.
          </p>
        </header>

        {/* Toast / banner */}
        <div className="min-h-[3.25rem]" aria-live="assertive">
          {toast && (
            <div
              className={`flex items-center gap-2.5 rounded-2xl border px-4 py-3 text-base font-semibold shadow-sm ${toastStyle[toast.kind]}`}
              role="status"
            >
              <ToastIcon className="h-5 w-5 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">{toast.text}</span>
            </div>
          )}
        </div>

        {/* Scan box */}
        <form onSubmit={onSubmit} className="mt-3">
          <label htmlFor="scan-box" className="sr-only">Scan or type item sticker code</label>
          <div className="flex items-stretch gap-2 rounded-2xl border border-[#E8D5C4] bg-white p-2 shadow-sm focus-within:border-[#af4408]">
            <div className="flex items-center pl-2 text-[#af4408]" aria-hidden>
              {sending ? <Loader2 className="h-6 w-6 animate-spin" /> : <ScanLine className="h-6 w-6" />}
            </div>
            <input
              id="scan-box"
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={focusInput}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="send"
              placeholder="Scan sticker or type item id…"
              className="min-w-0 flex-1 bg-transparent px-1 py-2 text-lg font-medium text-[#2D1B0E] placeholder:text-[#8B7355] focus:outline-none"
            />
            <button
              type="submit"
              disabled={sending}
              className="shrink-0 rounded-xl bg-[#af4408] px-4 py-2 text-base font-semibold text-white transition-colors hover:bg-[#8a3506] disabled:opacity-60"
            >
              Send
            </button>
          </div>
          <p className="mt-1.5 px-1 text-xs text-[#8B7355]">
            The scanner types the code and presses Enter. Keep this box focused.
          </p>
        </form>

        {/* Awaiting list */}
        <section className="mt-5">
          <div className="mb-2 flex items-center justify-between px-1">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[#6B5744]">
              <Utensils className="h-4 w-4" aria-hidden />
              Awaiting scan-out
            </h2>
            <span className="text-sm font-semibold text-[#8B7355]">{count} awaiting</span>
          </div>

          {count === 0 ? (
            <div className="rounded-2xl border border-[#E8D5C4] bg-white px-4 py-10 text-center shadow-sm">
              <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-emerald-500" aria-hidden />
              <p className="text-base font-semibold text-[#2D1B0E]">All caught up</p>
              <p className="mt-0.5 text-sm text-[#6B5744]">
                {loaded ? 'Nothing waiting to leave the kitchen.' : 'Loading…'}
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {awaiting.map((row) => {
                const t = istTime(row.fired_at);
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => onTapRow(row)}
                      disabled={sending}
                      className="flex min-h-11 w-full items-center gap-3 rounded-2xl border border-[#E8D5C4] bg-white px-3.5 py-3 text-left shadow-sm transition-colors hover:border-[#af4408] hover:bg-[#FFF8F0] active:bg-[#FBEEE2] disabled:opacity-60"
                    >
                      {/* Table badge */}
                      <span className="flex h-10 min-w-10 shrink-0 items-center justify-center rounded-xl bg-[#af4408]/10 px-2 text-sm font-bold text-[#af4408]">
                        {row.table_number || '—'}
                      </span>
                      {/* Item + meta */}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base font-semibold text-[#2D1B0E]">
                          {row.name}
                          {row.quantity > 1 && (
                            <span className="ml-1 font-bold text-[#af4408]">×{row.quantity}</span>
                          )}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-[#8B7355]">
                          {row.kot_number != null && <span>KOT #{row.kot_number}</span>}
                          {t && (
                            <span className="inline-flex items-center gap-1">
                              <Clock className="h-3 w-3" aria-hidden />
                              {t}
                            </span>
                          )}
                          {row.station && <span className="truncate">{row.station}</span>}
                        </span>
                      </span>
                      {/* Tap affordance */}
                      <span className="shrink-0 rounded-lg border border-[#E8D5C4] px-2.5 py-1 text-xs font-semibold text-[#af4408]">
                        Send
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
