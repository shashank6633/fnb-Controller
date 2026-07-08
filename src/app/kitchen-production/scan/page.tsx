'use client';

/**
 * Kitchen Production — camera barcode/QR scanner.
 *
 * A mobile-first screen the kitchen uses to point the (back) camera at a
 * production-batch label and instantly pull up that batch's freshness/FIFO
 * status. Built on @zxing/browser (BrowserMultiFormatReader) reading
 * Code128 / Code39 / EAN13 / QR straight off a live <video> stream.
 *
 * Flow per decode:
 *   1. debounce duplicate reads (~2s) so one label doesn't fire repeatedly
 *   2. scanAndFlush() → enqueue the scan (IndexedDB) then POST it to
 *      /api/kitchen-production/scan. When the POST succeeds the resolved batch
 *      is pulled from the scan-history store; when offline the scan simply
 *      waits in the queue and a "queued" card is shown.
 *   3. render the batch details with a big traffic-light (green safe / amber
 *      near-expiry / red expired) driven by expiry_status.
 *
 * Offline: the queue lib (src/lib/kitchen-scan-queue.ts) owns persistence +
 * auto-flush on the 'online' event; this page just reflects its state (online
 * dot + "N queued" badge) and drives the flush loop.
 *
 * Camera decoding can't be exercised headless — that's expected. The lookup +
 * queue + UI logic is what's verified.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ScanLine, Camera, CameraOff, Zap, ZapOff, Search, ArrowLeft, Loader2,
  Package, Clock, MapPin, User as UserIcon, AlertTriangle, CheckCircle2,
  History as HistoryIcon, Barcode as BarcodeIcon, Wifi, WifiOff, RefreshCw,
  Repeat, X, ChefHat,
} from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { fmtISTDate, fmtIST } from '@/lib/format-date';
import { api } from '@/lib/api';
import {
  scanAndFlush, listHistory, queuedCount, ensureScanFlushLoop, flushQueue,
  type ScanHistoryEntry,
} from '@/lib/kitchen-scan-queue';

// ─── Types ──────────────────────────────────────────────────────────────
interface Batch {
  id: string;
  batch_number: string;
  barcode: string;
  item_name: string;
  category: string;
  production_date: string;
  production_time: string;
  expiry_date: string;
  expiry_time: string;
  shelf_life: string;
  quantity_produced: number;
  quantity_consumed: number;
  unit: string;
  prepared_by: string;
  kitchen_section: string;
  storage_location: string;
  status: string;
  remaining_quantity: number;
  expiry_status: 'green' | 'yellow' | 'red';
  batch_age_hours: number;
  fifo_priority: number | null;
  /** Older ACTIVE batches of the same item to use BEFORE this one (oldest first). */
  fifo_use_first?: Array<{
    barcode: string; batch_number: string;
    production_date: string; production_time: string;
    expiry_date: string; storage_location: string;
    remaining_quantity: number; unit: string; shelf_life_remaining: string;
  }>;
  shelf_life_remaining: string;
}

// The resolved scan shown in the details panel.
type ScanResult =
  | { status: 'found';     barcode: string; batch: Batch }
  | { status: 'not_found'; barcode: string; batch: null }
  | { status: 'queued';    barcode: string; batch: null };

// ─── Helpers ────────────────────────────────────────────────────────────
const fmtNum = (v: number) =>
  (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

// production_time / expiry_time are bare local "HH:mm" strings — format to
// 12-hour WITHOUT any timezone conversion (matches the list page).
function fmt12h(t: string | null | undefined): string {
  const s = (t || '').trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return s || '';
  let h = Number(m[1]);
  const min = m[2];
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${ampm}`;
}
function fmtDateTimeParts(date: string, time: string): string {
  const d = date ? fmtISTDate(date) : '';
  const t = fmt12h(time);
  if (d && t) return `${d}, ${t}`;
  return d || t || '—';
}

// Traffic-light tokens per expiry status.
const TONE: Record<Batch['expiry_status'], {
  card: string; band: string; chip: string; dot: string; label: string; sub: string;
}> = {
  green:  { card: 'border-emerald-300', band: 'bg-emerald-500', chip: 'bg-emerald-100 text-emerald-800 border-emerald-300', dot: 'bg-emerald-500', label: 'Safe',        sub: 'Fresh — good to use' },
  yellow: { card: 'border-amber-300',   band: 'bg-amber-500',   chip: 'bg-amber-100 text-amber-800 border-amber-300',       dot: 'bg-amber-500',   label: 'Near expiry', sub: 'Use soon — expiring within 24h' },
  red:    { card: 'border-red-300',     band: 'bg-red-500',     chip: 'bg-red-100 text-red-700 border-red-300',             dot: 'bg-red-500',     label: 'Expired',     sub: 'Do NOT use — past expiry' },
};

const DUP_WINDOW_MS = 2000;

// ─── Page ───────────────────────────────────────────────────────────────
export default function KitchenScanPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const lastScanRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const continuousRef = useRef(true);      // read inside the decode callback

  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [continuous, setContinuous] = useState(true);

  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);

  const [history, setHistory] = useState<ScanHistoryEntry[]>([]);
  const [queued, setQueued] = useState(0);
  const [online, setOnline] = useState(true);

  useEffect(() => { continuousRef.current = continuous; }, [continuous]);

  // ── queue/history/online state ────────────────────────────────────────
  const refreshQueueState = useCallback(async () => {
    try {
      const [h, c] = await Promise.all([listHistory(20), queuedCount()]);
      setHistory(h);
      setQueued(c);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    ensureScanFlushLoop();
    setOnline(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
    refreshQueueState();

    const onOnline = () => {
      setOnline(true);
      // give the flush loop a beat, then reflect the drained queue + new history
      flushQueue().catch(() => {}).finally(() => setTimeout(refreshQueueState, 400));
    };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const poll = window.setInterval(refreshQueueState, 5000);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.clearInterval(poll);
    };
  }, [refreshQueueState]);

  // ── torch helpers ─────────────────────────────────────────────────────
  const videoTrack = (): MediaStreamTrack | null => {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    return stream?.getVideoTracks?.()[0] || null;
  };

  const detectTorch = useCallback(() => {
    const track = videoTrack();
    try {
      const caps = (track?.getCapabilities?.() as any) || {};
      setTorchSupported(!!caps.torch);
    } catch { setTorchSupported(false); }
  }, []);

  const toggleTorch = useCallback(async () => {
    const track = videoTrack();
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] } as any);
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
      setTorchOn(false);
    }
  }, [torchOn]);

  // ── camera stop (declared before processScan, which calls it) ─────────
  const stopScan = useCallback(() => {
    try { controlsRef.current?.stop(); } catch { /* ignore */ }
    controlsRef.current = null;
    setScanning(false);
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  // ── process one scanned/typed code ────────────────────────────────────
  const processScan = useCallback(async (raw: string, opts: { fromCamera?: boolean } = {}) => {
    let code = (raw || '').trim();
    if (!code) return;
    // The label's QR may carry the bare barcode (today) or a deep-link URL that
    // CONTAINS it (future scanUrl). Pull the PROD###### out of whatever was
    // decoded so both resolve; anything else (manual entry, other codes) passes
    // through unchanged.
    const prod = code.match(/PROD\d{3,}/i);
    if (prod) code = prod[0].toUpperCase();

    // Debounce duplicate camera reads of the same label.
    if (opts.fromCamera) {
      const now = Date.now();
      if (lastScanRef.current.code === code && now - lastScanRef.current.at < DUP_WINDOW_MS) return;
      lastScanRef.current = { code, at: now };
      // In single-shot mode, stop the camera on the first accepted read.
      if (!continuousRef.current) stopScan();
    }

    setBusy(true);
    setLookupError(null);
    try {
      const ts = Date.now();
      const { queued: q, flushed } = await scanAndFlush({ barcode: code, ts });
      await refreshQueueState();

      if (flushed > 0) {
        // Synced — pull the resolved batch out of the history store by id.
        const hist = await listHistory(50);
        const entry = hist.find(h => h.id === q.id);
        if (entry && entry.found && entry.batch) {
          setResult({ status: 'found', barcode: code, batch: entry.batch as Batch });
        } else {
          setResult({ status: 'not_found', barcode: code, batch: null });
        }
      } else {
        // Couldn't reach the server → the scan is safely queued offline.
        setResult({ status: 'queued', barcode: code, batch: null });
      }
    } catch (e: any) {
      setLookupError(e?.message || 'Scan failed');
    } finally {
      setBusy(false);
    }
  }, [refreshQueueState, stopScan]);

  // ── camera start/stop ─────────────────────────────────────────────────
  const startScan = useCallback(async () => {
    setCameraError(null);
    if (!videoRef.current) return;
    try {
      if (!readerRef.current) {
        const hints = new Map<DecodeHintType, unknown>();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.CODE_128,
          BarcodeFormat.CODE_39,
          BarcodeFormat.EAN_13,
          BarcodeFormat.QR_CODE,
        ]);
        readerRef.current = new BrowserMultiFormatReader(hints as any);
      }
      const controls = await readerRef.current.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } } },
        videoRef.current,
        (res) => { if (res) processScan(res.getText(), { fromCamera: true }); },
      );
      controlsRef.current = controls;
      setScanning(true);
      // torch capability is only known once the track is live
      setTimeout(detectTorch, 300);
    } catch (e: any) {
      const name = e?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setCameraError('Camera permission denied. Allow camera access in your browser settings, then retry.');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setCameraError('No camera found on this device.');
      } else if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
        setCameraError('Camera needs a secure (HTTPS) connection.');
      } else {
        setCameraError(e?.message || 'Could not start the camera.');
      }
      setScanning(false);
    }
  }, [processScan, detectTorch]);

  // Stop the camera on unmount.
  useEffect(() => () => { try { controlsRef.current?.stop(); } catch {} }, []);

  const onManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const code = manual.trim();
    if (!code) return;
    processScan(code);
    setManual('');
  };

  const reopenHistory = (h: ScanHistoryEntry) => {
    if (h.found && h.batch) setResult({ status: 'found', barcode: h.barcode, batch: h.batch as Batch });
    else setResult({ status: 'not_found', barcode: h.barcode, batch: null });
  };

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link href="/kitchen-production"
                  className="p-2 -ml-2 rounded-lg text-[#6B5744] hover:bg-[#FFF1E3]" title="Back to Kitchen Production">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
              <ScanLine className="w-6 h-6 text-[#af4408]" /> Scan Batch
            </h1>
          </div>
          <p className="text-xs text-[#6B5744] mt-1 max-w-xl">
            Point the camera at a production-batch label (barcode or QR) to pull up its
            freshness, FIFO priority and remaining quantity — or type a batch barcode below.
          </p>
        </div>
        {/* Online / queued indicator */}
        <div className="flex items-center gap-2 shrink-0">
          <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border font-medium ${
            online ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
            {online ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            {online ? 'Online' : 'Offline'}
          </span>
          {queued > 0 && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-amber-300 bg-amber-100 text-amber-800 font-semibold">
              <RefreshCw className="w-3.5 h-3.5" /> {queued} queued
            </span>
          )}
        </div>
      </div>

      {/* Camera viewport */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-3">
        <div className="relative w-full aspect-[4/3] sm:aspect-video bg-black rounded-lg overflow-hidden">
          <video ref={videoRef} playsInline muted
                 className="w-full h-full object-cover" />
          {/* Scan reticle */}
          {scanning && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="w-[70%] max-w-[320px] h-24 border-2 border-white/80 rounded-lg shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            </div>
          )}
          {/* Idle / error overlay */}
          {!scanning && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-4 gap-3 bg-[#1C0F05]/80">
              {cameraError ? (
                <>
                  <CameraOff className="w-10 h-10 text-red-300" />
                  <div className="text-sm text-red-200 max-w-xs">{cameraError}</div>
                </>
              ) : (
                <>
                  <Camera className="w-10 h-10 text-[#E8D5C4]" />
                  <div className="text-sm text-[#E8D5C4]">Camera is off</div>
                </>
              )}
              <button onClick={startScan}
                      className="mt-1 px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium flex items-center gap-2">
                <Camera className="w-4 h-4" /> {cameraError ? 'Retry camera' : 'Start scanning'}
              </button>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {scanning ? (
            <button onClick={stopScan}
                    className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm font-medium flex items-center gap-2">
              <CameraOff className="w-4 h-4" /> Stop
            </button>
          ) : (
            <button onClick={startScan}
                    className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium flex items-center gap-2">
              <Camera className="w-4 h-4" /> Start
            </button>
          )}

          <button onClick={toggleTorch} disabled={!scanning || !torchSupported}
                  title={torchSupported ? 'Toggle flashlight' : 'Flashlight not supported on this device'}
                  className={`px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 border disabled:opacity-40 ${
                    torchOn
                      ? 'bg-amber-400 border-amber-500 text-[#2D1B0E]'
                      : 'bg-white border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744]'}`}>
            {torchOn ? <Zap className="w-4 h-4" /> : <ZapOff className="w-4 h-4" />}
            <span className="hidden sm:inline">{torchOn ? 'Flash on' : 'Flash'}</span>
          </button>

          <button onClick={() => setContinuous(c => !c)}
                  title="Keep scanning after each read"
                  className={`px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 border ${
                    continuous
                      ? 'bg-[#FFF1E3] border-[#D4B896] text-[#af4408]'
                      : 'bg-white border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744]'}`}>
            <Repeat className="w-4 h-4" />
            <span className="hidden sm:inline">Continuous</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${continuous ? 'bg-[#af4408] text-white' : 'bg-[#E8D5C4] text-[#6B5744]'}`}>
              {continuous ? 'ON' : 'OFF'}
            </span>
          </button>

          {busy && (
            <span className="text-xs text-[#8B7355] flex items-center gap-1.5 ml-auto">
              <Loader2 className="w-4 h-4 animate-spin" /> Looking up…
            </span>
          )}
        </div>

        {/* Manual search */}
        <form onSubmit={onManualSubmit} className="flex items-center gap-2 pt-1">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-[#8B7355]" />
            <input value={manual} onChange={e => setManual(e.target.value)}
                   placeholder="Type a barcode e.g. PROD000145"
                   inputMode="text" autoCapitalize="characters"
                   className="w-full pl-8 pr-2 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] text-[#2D1B0E] font-mono focus:outline-none focus:ring-2 focus:ring-[#af4408]/30" />
          </div>
          <button type="submit" disabled={!manual.trim() || busy}
                  className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50">
            <Search className="w-4 h-4" /> Look up
          </button>
        </form>

        {lookupError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-sm text-red-700">{lookupError}</div>
        )}
      </div>

      {/* Result */}
      {result && (
        <ResultPanel result={result} online={online} onClose={() => setResult(null)}
          onBatchUpdate={(batch) => setResult(r => (r && r.status === 'found' ? { ...r, batch } : r))} />
      )}

      {/* History */}
      <div>
        <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5 mb-2">
          <HistoryIcon className="w-4 h-4 text-[#af4408]" /> Recent scans
        </div>
        {history.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center text-sm text-[#8B7355]">
            No scans yet. Start the camera or type a barcode above.
          </div>
        ) : (
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden divide-y divide-[#E8D5C4]/60">
            {history.map(h => {
              const b = h.batch as Batch | null;
              const tone = b ? (TONE[b.expiry_status] || TONE.green) : null;
              return (
                <button key={h.id} onClick={() => reopenHistory(h)}
                        className="w-full text-left p-3 flex items-center gap-3 hover:bg-[#FFF1E3]">
                  <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${tone ? tone.dot : 'bg-gray-300'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-[#2D1B0E] truncate">
                      {b ? b.item_name : <span className="text-[#8B7355] italic">Unknown barcode</span>}
                    </div>
                    <div className="text-[11px] text-[#8B7355] font-mono truncate">{h.barcode}</div>
                  </div>
                  <div className="text-right shrink-0">
                    {b && <div className="text-[11px] text-[#6B5744]">{b.shelf_life_remaining}</div>}
                    <div className="text-[10px] text-[#8B7355]">{fmtIST(new Date(h.syncedAt).toISOString())}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Result panel ─────────────────────────────────────────────────────────
function ResultPanel({ result, online, onClose, onBatchUpdate }: {
  result: ScanResult; online: boolean; onClose: () => void; onBatchUpdate: (batch: Batch) => void;
}) {
  // Queued (offline) — the scan is saved and will resolve once back online.
  if (result.status === 'queued') {
    return (
      <div className="bg-white border-2 border-amber-300 rounded-xl overflow-hidden">
        <div className="bg-amber-500 h-1.5 w-full" />
        <div className="p-5 flex items-start gap-3">
          <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
            <WifiOff className="w-6 h-6 text-amber-600" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-bold text-[#2D1B0E]">Scan queued {online ? '' : '(offline)'}</div>
            <div className="text-sm text-[#6B5744] mt-0.5">
              Couldn’t reach the server, so this scan is saved and will sync automatically.
            </div>
            <div className="font-mono text-xs text-[#8B7355] mt-2 flex items-center gap-1">
              <BarcodeIcon className="w-3.5 h-3.5" /> {result.barcode}
            </div>
          </div>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E] shrink-0"><X className="w-5 h-5" /></button>
        </div>
      </div>
    );
  }

  // Unknown barcode — synced, but no batch matched.
  if (result.status === 'not_found') {
    return (
      <div className="bg-white border-2 border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="bg-[#8B7355] h-1.5 w-full" />
        <div className="p-5 flex items-start gap-3">
          <div className="w-12 h-12 rounded-full bg-[#FFF1E3] flex items-center justify-center shrink-0">
            <AlertTriangle className="w-6 h-6 text-[#8B7355]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-bold text-[#2D1B0E]">Batch not found</div>
            <div className="text-sm text-[#6B5744] mt-0.5">
              No production batch matches this barcode. Check that the label was printed from Kitchen Production.
            </div>
            <div className="font-mono text-xs text-[#8B7355] mt-2 flex items-center gap-1">
              <BarcodeIcon className="w-3.5 h-3.5" /> {result.barcode}
            </div>
          </div>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E] shrink-0"><X className="w-5 h-5" /></button>
        </div>
      </div>
    );
  }

  // Found — full details with the big traffic-light indicator.
  const b = result.batch;
  const tone = TONE[b.expiry_status] || TONE.green;
  return (
    <div className={`bg-white border-2 ${tone.card} rounded-xl overflow-hidden`}>
      {/* Big colour band + status */}
      <div className={`${tone.band} px-5 py-4 text-white flex items-center justify-between gap-3`}>
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide opacity-90">Inventory status</div>
          <div className="text-2xl font-extrabold leading-tight flex items-center gap-2">
            {b.expiry_status === 'red' ? <AlertTriangle className="w-6 h-6" />
              : b.expiry_status === 'yellow' ? <Clock className="w-6 h-6" />
              : <CheckCircle2 className="w-6 h-6" />}
            {tone.label}
          </div>
          <div className="text-xs opacity-90 mt-0.5">{tone.sub} · {b.shelf_life_remaining}</div>
        </div>
        <button onClick={onClose} className="text-white/90 hover:text-white shrink-0"><X className="w-5 h-5" /></button>
      </div>

      <div className="p-5 space-y-4">
        {/* Title row */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-lg font-bold text-[#2D1B0E] flex items-center gap-1.5">
              <ChefHat className="w-4 h-4 text-[#af4408] shrink-0" /> {b.item_name}
            </div>
            {b.category && <div className="text-xs text-[#8B7355]">{b.category}</div>}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            {b.status === 'active' && b.fifo_priority != null && (
              <span className="text-[11px] px-2 py-0.5 rounded border border-[#D4B896] bg-[#FFF1E3] text-[#6B5744] font-semibold">
                FIFO #{b.fifo_priority}
              </span>
            )}
            <span className="text-[10px] px-2 py-0.5 rounded border border-gray-200 bg-gray-50 text-gray-600 font-medium capitalize">
              {b.status}
            </span>
          </div>
        </div>

        {/* FIFO verdict — the answer to "can I use this one?" */}
        {b.status === 'active' && b.fifo_priority === 1 && (
          <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 px-3 py-2.5 flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
            <div className="text-sm font-bold text-emerald-800">FIFO OK — use this batch first</div>
          </div>
        )}
        {b.status === 'active' && (b.fifo_priority ?? 1) > 1 && (b.fifo_use_first?.length ?? 0) > 0 && (
          <div className="rounded-lg border-2 border-amber-400 bg-amber-50 px-3 py-2.5 space-y-1.5">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
              <div className="text-sm font-bold text-amber-800">
                Not first — use this batch before it:
              </div>
            </div>
            {(() => { const f = b.fifo_use_first![0]; return (
              <div className="ml-7 text-xs text-amber-900 space-y-0.5">
                <div className="font-mono font-bold text-base flex items-center gap-1.5">
                  <BarcodeIcon className="w-4 h-4" /> {f.barcode}
                </div>
                <div>{f.batch_number} · prepared {f.production_date} {f.production_time}</div>
                <div>
                  {f.storage_location ? <>📍 {f.storage_location} · </> : null}
                  {fmtNum(f.remaining_quantity)}{f.unit ? ' ' + f.unit : ''} left · {f.shelf_life_remaining}
                </div>
                {b.fifo_use_first!.length > 1 && (
                  <div className="text-amber-700">+{b.fifo_use_first!.length - 1} more older batch{b.fifo_use_first!.length > 2 ? 'es' : ''} before this one</div>
                )}
              </div>
            ); })()}
          </div>
        )}
        {b.status !== 'active' && (b.fifo_use_first?.length ?? 0) > 0 && (
          <div className="rounded-lg border-2 border-sky-300 bg-sky-50 px-3 py-2.5 space-y-1">
            <div className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-sky-600 shrink-0" />
              <div className="text-sm font-bold text-sky-800 capitalize">This batch is {b.status} — current FIFO #1:</div>
            </div>
            {(() => { const f = b.fifo_use_first![0]; return (
              <div className="ml-7 text-xs text-sky-900">
                <span className="font-mono font-bold">{f.barcode}</span> · {f.batch_number}
                {f.storage_location ? <> · 📍 {f.storage_location}</> : null} · {f.shelf_life_remaining}
              </div>
            ); })()}
          </div>
        )}

        {/* Batch # / barcode */}
        <div className="flex items-center gap-2 flex-wrap text-[11px]">
          <span className="font-mono font-semibold text-[#2D1B0E] bg-[#FFF1E3] border border-[#E8D5C4] rounded px-1.5 py-0.5">
            {b.batch_number}
          </span>
          <span className="font-mono text-[#8B7355] flex items-center gap-1">
            <BarcodeIcon className="w-3.5 h-3.5" /> {b.barcode}
          </span>
        </div>

        {/* Quantities */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <QtyChip label="Produced" value={`${fmtNum(b.quantity_produced)}${b.unit ? ' ' + b.unit : ''}`} tone="text-[#6B5744]" />
          <QtyChip label="Consumed" value={`${fmtNum(b.quantity_consumed)}${b.unit ? ' ' + b.unit : ''}`} tone="text-amber-700" />
          <QtyChip label="Remaining" value={`${fmtNum(b.remaining_quantity)}${b.unit ? ' ' + b.unit : ''}`} tone="text-emerald-700" />
        </div>

        {/* Take stock — partial draw-down from THIS batch; auto-completes at 0 */}
        <TakeStock b={b} online={online} onUpdated={onBatchUpdate} />

        {/* Details grid */}
        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Detail label="Production" value={fmtDateTimeParts(b.production_date, b.production_time)} />
          <Detail label="Expiry" value={b.expiry_date ? fmtDateTimeParts(b.expiry_date, b.expiry_time) : '—'} />
          <Detail label="Shelf Life" value={b.shelf_life || '—'} />
          <Detail label="Shelf Left" value={b.shelf_life_remaining} strong />
          <Detail label="Batch Age" value={`${fmtNum(b.batch_age_hours)} hrs`} />
          <DetailIcon icon={<UserIcon className="w-3.5 h-3.5" />} label="Prepared By" value={b.prepared_by || '—'} />
          <DetailIcon icon={<MapPin className="w-3.5 h-3.5" />} label="Storage" value={b.storage_location || '—'} />
          <Detail label="Kitchen Section" value={b.kitchen_section || '—'} />
        </div>
      </div>
    </div>
  );
}

function QtyChip({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg py-1.5 px-1">
      <div className="text-[9px] uppercase tracking-wide text-[#8B7355]">{label}</div>
      <div className={`text-sm font-bold font-mono ${tone} leading-tight`}>{value}</div>
    </div>
  );
}

function Detail({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-[#8B7355]">{label}</div>
      <div className={strong ? 'font-bold text-emerald-700' : 'text-[#2D1B0E]'}>{value}</div>
    </div>
  );
}

function DetailIcon({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-[#8B7355] flex items-center gap-1">{icon}{label}</div>
      <div className="text-[#2D1B0E] truncate">{value}</div>
    </div>
  );
}

// "Take stock" — deduct a quantity from the scanned batch (POST /take). Kept as
// its own component so its hooks sit outside ResultPanel's early returns and the
// success note survives the batch flipping to 'consumed'. Online-only: the
// server must validate remaining, so offline takes are refused up front.
function TakeStock({ b, online, onUpdated }: {
  b: Batch; online: boolean; onUpdated: (batch: Batch) => void;
}) {
  const [qty, setQty] = useState('');
  const [taking, setTaking] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  if (b.status !== 'active' || b.remaining_quantity <= 0) {
    // Batch just completed (or was already inactive) — keep showing the outcome.
    return note ? (
      <div className={`rounded-lg px-3 py-2 text-sm font-medium ${note.kind === 'ok' ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-red-50 border border-red-200 text-red-700'}`}>
        {note.text}
      </div>
    ) : null;
  }

  const unitSfx = b.unit ? ` ${b.unit}` : '';
  const take = async () => {
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) { setNote({ kind: 'err', text: 'Enter a quantity greater than 0.' }); return; }
    if (q > b.remaining_quantity + 1e-9) { setNote({ kind: 'err', text: `Only ${fmtNum(b.remaining_quantity)}${unitSfx} left in this batch.` }); return; }
    if (!online) { setNote({ kind: 'err', text: 'You are offline — taking stock needs a connection.' }); return; }
    if (b.expiry_status === 'red' && !window.confirm('This batch is EXPIRED — it should be disposed, not used. Take from it anyway?')) return;
    if ((b.fifo_priority ?? 1) > 1) {
      const first = b.fifo_use_first?.[0];
      const okAnyway = window.confirm(
        `This batch is FIFO #${b.fifo_priority}${first ? ` — ${first.barcode} should be used first` : ''}. Take from this one anyway?`
      );
      if (!okAnyway) return;
    }
    setTaking(true); setNote(null);
    try {
      const r = await api('/api/kitchen-production/take', { method: 'POST', body: { barcode: b.barcode, quantity: q } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setQty('');
      setNote({
        kind: 'ok',
        text: j.completed
          ? `Took ${fmtNum(j.taken)}${unitSfx} — batch fully used, marked completed ✓`
          : `Took ${fmtNum(j.taken)}${unitSfx} — ${fmtNum(j.remaining)}${unitSfx} left`,
      });
      onUpdated(j.batch as Batch);
    } catch (e: any) {
      setNote({ kind: 'err', text: e?.message || 'Failed to take stock' });
    } finally { setTaking(false); }
  };

  return (
    <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3 space-y-2">
      <div className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide">Take stock from this batch</div>
      <div className="flex items-center gap-2">
        <input
          type="number" inputMode="decimal" min={0} step="any" value={qty}
          onChange={(e) => setQty(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') take(); }}
          placeholder={`e.g. 3 (max ${fmtNum(b.remaining_quantity)})`}
          className="flex-1 min-w-0 border border-[#D4B896] rounded-lg px-3 py-2 text-sm bg-white"
        />
        {b.unit && <span className="text-sm text-[#6B5744] shrink-0">{b.unit}</span>}
        <button onClick={take} disabled={taking}
          className="shrink-0 px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {taking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />} Take
        </button>
      </div>
      {note && (
        <div className={`text-sm font-medium ${note.kind === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>{note.text}</div>
      )}
    </div>
  );
}
