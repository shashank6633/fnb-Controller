'use client';

/**
 * Kitchen Scan-Out — the kitchen supervisor scans each plated item's printed
 * sticker (a QR of the order_item id) as it leaves the kitchen. Either:
 *   (a) a hardware HID barcode scanner "types" the id + Enter into the focused box,
 *   (b) the supervisor taps the item row (manual send / scanner-outage override), or
 *   (c) camera mode — a phone/tablet back camera reads the sticker's QR / Code128
 *       via @zxing/browser (same pattern as /kitchen-production/scan), no gun needed.
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
  Camera, CameraOff, Zap, ZapOff,
} from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

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
const CAM_DUP_MS = 2500;   // camera re-reads the same sticker every frame — wider guard
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
  // Mirrors `sending` for the camera decode callback (its closure is stale).
  const sendingRef = useRef(false);

  // ---- Camera mode (phone/tablet — no HID gun needed) -----------------------
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const startingRef = useRef(false);          // double-start guard
  const restartRef = useRef(false);           // a (re)open landed while a start was pending
  const camGenRef = useRef(0);                // bumped on every stop — stale starts self-abort
  const cameraOpenRef = useRef(false);        // read inside focus callbacks
  // Camera duplicate-guard: the reader fires on every frame the sticker is visible.
  const lastCamRead = useRef<{ code: string; at: number }>({ code: '', at: 0 });

  // ---- Focus management: the HID scanner must always land in the box -------
  const focusInput = useCallback(() => {
    // Defer so it wins after row taps / toast renders steal focus.
    // Paused while the camera panel is open — refocusing there pops the
    // mobile keyboard and fights the viewfinder.
    setTimeout(() => {
      if (cameraOpenRef.current) return;
      inputRef.current?.focus();
    }, 0);
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

  // Keep the ref in sync; when the camera closes, resume the refocus loop.
  useEffect(() => {
    cameraOpenRef.current = cameraOpen;
    if (!cameraOpen) focusInput();
  }, [cameraOpen, focusInput]);

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
  // Resolves true only when the item actually flipped (camera mode vibrates on it).
  const send = useCallback(async (payload: { code: string } | { item_id: string }): Promise<boolean> => {
    setSending(true);
    sendingRef.current = true;
    try {
      const r = await api('/api/dine-in/kds/scan-out', { method: 'POST', body: payload });
      const j: ScanResult = await r.json().catch(() => ({} as ScanResult));

      if (r.status === 404) {
        showToast('error', 'No item matches this code');
        return false;
      }
      if (!r.ok) {
        showToast('error', j?.error || 'Scan failed — try again');
        return false;
      }

      const name = j.item?.name || 'Item';
      const table = j.item?.table_number;

      if (j.flipped) {
        showToast('success', `✓ ${name}${table ? ` · Table ${table}` : ''} — sent`);
        successBuzz();
        load(); // refetch right after a successful flip
        return true;
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
      return false;
    } catch {
      showToast('error', 'No item matches this code');
      return false;
    } finally {
      setSending(false);
      sendingRef.current = false;
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

  // ---- Camera: torch helpers (mirrors /kitchen-production/scan) ------------
  const videoTrack = (): MediaStreamTrack | null => {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    return stream?.getVideoTracks?.()[0] || null;
  };

  const detectTorch = useCallback(() => {
    const track = videoTrack();
    try {
      const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
      setTorchSupported(!!caps.torch);
    } catch { setTorchSupported(false); }
  }, []);

  const toggleTorch = useCallback(async () => {
    const track = videoTrack();
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as unknown as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
      setTorchOn(false);
    }
  }, [torchOn]);

  // ---- Camera: hardware teardown (Stop button, unmount, before re-start) ---
  const stopCamera = useCallback(() => {
    camGenRef.current += 1; // any start still awaiting getUserMedia is now stale
    try { controlsRef.current?.stop(); } catch { /* ignore */ }
    controlsRef.current = null;
    // Belt-and-braces: also stop the raw MediaStream tracks so the LED goes off.
    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      stream?.getTracks?.().forEach((t) => t.stop());
    } catch { /* ignore */ }
    if (videoRef.current) videoRef.current.srcObject = null;
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  // ---- Camera: one decoded frame → same submit path as the HID box ---------
  const onCameraDecode = useCallback((raw: string) => {
    // Trim only — never uppercase: older stickers carry the raw order_item id
    // (a lowercase UUID) which the API matches case-SENSITIVELY; scan_code is
    // already compared case-insensitively server-side. Mirrors the HID box.
    const code = (raw || '').trim();
    if (!code) return;
    if (sendingRef.current) return; // never overlap an in-flight submit

    const now = Date.now();
    // The reader re-reads the sticker every frame — hold the same code for a bit.
    if (code === lastCamRead.current.code && now - lastCamRead.current.at < CAM_DUP_MS) return;
    lastCamRead.current = { code, at: now };

    void send({ code }).then((flipped) => {
      if (flipped) { try { navigator.vibrate?.(80); } catch { /* noop */ } }
      // Keep scanning either way — the panel stays open for the next plate.
      // Re-stamp the dup window at SETTLE time: on a slow POST (weak Wi-Fi) the
      // read-time stamp could expire mid-flight and the very next frame of the
      // same sticker would re-POST, overwriting the green toast with an amber
      // "already sent" one.
      lastCamRead.current = { code, at: Date.now() };
    });
  }, [send]);

  // ---- Camera: start the reader on the back camera --------------------------
  const startCamera = useCallback(async () => {
    if (startingRef.current) { restartRef.current = true; return; } // re-run once the pending start settles
    startingRef.current = true;

    const startOnce = async () => {
      setCameraError(null);
      stopCamera(); // never stack two live streams
      const gen = camGenRef.current; // this start is valid only while gen holds
      if (!videoRef.current) return;
      try {
        if (!readerRef.current) {
          const hints = new Map<DecodeHintType, unknown>();
          // Stickers only ever carry QR or Code128 — restricting is faster and
          // avoids false reads from other symbologies.
          hints.set(DecodeHintType.POSSIBLE_FORMATS, [
            BarcodeFormat.QR_CODE,
            BarcodeFormat.CODE_128,
          ]);
          readerRef.current = new BrowserMultiFormatReader(hints as Map<DecodeHintType, unknown>);
        }
        const controls = await readerRef.current.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' } } },
          videoRef.current,
          (res) => { if (res) onCameraDecode(res.getText()); },
        );
        // The permission prompt can hold that await open while the user taps
        // Stop / closes the panel / navigates away — a stale start must kill
        // its own stream here, or the LED stays on with nothing to stop it.
        if (gen !== camGenRef.current || !cameraOpenRef.current) {
          try { controls.stop(); } catch { /* ignore */ }
          try {
            const stream = videoRef.current?.srcObject as MediaStream | null;
            stream?.getTracks?.().forEach((t) => t.stop());
          } catch { /* ignore */ }
          if (videoRef.current) videoRef.current.srcObject = null;
          return;
        }
        controlsRef.current = controls;
        // torch capability is only known once the track is live
        setTimeout(detectTorch, 300);
      } catch (e) {
        const err = e as { name?: string; message?: string };
        const name = err?.name || '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setCameraError('Camera permission denied. Allow camera access in your browser settings, then retry.');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setCameraError('No camera found on this device.');
        } else if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
          setCameraError('Camera needs a secure connection — HTTPS (production URL) or localhost.');
        } else {
          setCameraError(err?.message || 'Could not start the camera.');
        }
      }
    };

    try {
      do {
        restartRef.current = false;
        await startOnce();
      } while (restartRef.current && cameraOpenRef.current); // a reopen landed mid-start
    } finally {
      startingRef.current = false;
    }
  }, [stopCamera, onCameraDecode, detectTorch]);

  // Open → start the reader (video is mounted by then); close/unmount → stop.
  useEffect(() => {
    if (!cameraOpen) return;
    void startCamera();
    return () => stopCamera();
  }, [cameraOpen, startCamera, stopCamera]);

  // Belt-and-braces (mirrors /kitchen-production/scan): unmount always stops the
  // camera, even if the panel never registered its own cleanup.
  useEffect(() => () => stopCamera(), [stopCamera]);

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

        {/* Camera scan (phone/tablet — no HID gun needed) */}
        <div className="mt-3">
          <button
            type="button"
            onClick={() => {
              // Set the ref synchronously so the deferred refocus can't race
              // the open and pop the keyboard over the viewfinder.
              const next = !cameraOpen;
              cameraOpenRef.current = next;
              setCameraOpen(next);
            }}
            aria-expanded={cameraOpen}
            className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-base font-semibold shadow-sm transition-colors ${
              cameraOpen
                ? 'border-[#af4408] bg-[#FFF8F0] text-[#af4408]'
                : 'border-[#E8D5C4] bg-white text-[#af4408] hover:border-[#af4408] hover:bg-[#FFF8F0] active:bg-[#FBEEE2]'
            }`}
          >
            {cameraOpen ? <CameraOff className="h-5 w-5" aria-hidden /> : <Camera className="h-5 w-5" aria-hidden />}
            {cameraOpen ? 'Close camera' : 'Camera scan'}
          </button>

          {cameraOpen && (
            <div className="mt-2 rounded-2xl border border-[#E8D5C4] bg-white p-2 shadow-sm">
              <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-black sm:aspect-video">
                <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
                {/* Scan reticle */}
                {!cameraError && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="h-24 w-[70%] max-w-[320px] rounded-lg border-2 border-white/80" />
                  </div>
                )}
                {/* Error overlay — permission / no camera / insecure context */}
                {cameraError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#1C0F05]/85 p-4 text-center">
                    <CameraOff className="h-8 w-8 text-red-300" aria-hidden />
                    <p className="max-w-xs text-sm text-red-200">{cameraError}</p>
                    <button
                      type="button"
                      onClick={() => void startCamera()}
                      className="mt-1 rounded-lg bg-[#af4408] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#8a3506]"
                    >
                      Retry camera
                    </button>
                  </div>
                )}
              </div>

              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => { cameraOpenRef.current = false; setCameraOpen(false); }}
                  className="flex min-h-11 items-center gap-2 rounded-xl border border-[#E8D5C4] bg-white px-4 py-2 text-sm font-semibold text-[#6B5744] transition-colors hover:bg-[#FFF8F0]"
                >
                  <CameraOff className="h-4 w-4" aria-hidden /> Stop
                </button>
                {torchSupported && (
                  <button
                    type="button"
                    onClick={() => void toggleTorch()}
                    className={`flex min-h-11 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
                      torchOn
                        ? 'border-amber-500 bg-amber-400 text-[#2D1B0E]'
                        : 'border-[#E8D5C4] bg-white text-[#6B5744] hover:bg-[#FFF8F0]'
                    }`}
                  >
                    {torchOn ? <Zap className="h-4 w-4" aria-hidden /> : <ZapOff className="h-4 w-4" aria-hidden />}
                    {torchOn ? 'Flash on' : 'Flash'}
                  </button>
                )}
                {sending && (
                  <span className="ml-auto flex items-center gap-1.5 text-xs text-[#8B7355]">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Sending…
                  </span>
                )}
              </div>
              <p className="mt-1.5 px-1 text-xs text-[#8B7355]">
                Point the camera at the sticker&rsquo;s QR or barcode — it sends automatically.
              </p>
            </div>
          )}
        </div>

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
