'use client';

/**
 * Scan a brewery batch tag into the New Brewery Batch form (owner ruling 119).
 *
 * Two ways in, both always available:
 *   · a handheld USB / Bluetooth scanner "types" the tag into the box and
 *     presses Enter (the box has focus when this opens), or someone types it;
 *   · the camera — the phone's own BarcodeDetector where it exists, else
 *     @zxing/browser — the same two readers as the Scan screen
 *     (src/app/kitchen-production/scan/page.tsx), looking for the common tag
 *     symbols (QR, Code 128 / 39, EAN, UPC, Data Matrix, ITF).
 * On a phone (coarse pointer) the camera starts at once.
 *
 * `onRead` decides (src/lib/brewery-tag.ts via the form): it returns an error to
 * show — and the scanner stays open for another try — or null, and the scanner
 * closes. Nothing is saved here; the form's Save does that.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { Camera, CameraOff, ScanLine, X } from 'lucide-react';

const NATIVE_FORMATS = ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'data_matrix', 'itf'];
const ZXING_FORMATS = [
  BarcodeFormat.QR_CODE, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.DATA_MATRIX, BarcodeFormat.ITF,
];
/** The camera re-reads the same tag many times a second; one read per tag per 2 s. */
const DUP_WINDOW_MS = 2000;

export default function BatchTagScanner({ onRead, onClose, title = 'Scan batch tag', placeholder = 'e.g. ACB-248', hint }: {
  onRead: (text: string) => string | null;
  onClose: () => void;
  /** Optional wording for other callers (Valet Parking). Kitchen callers pass
   *  none, so their screen is unchanged. */
  title?: string;
  placeholder?: string;
  hint?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const lastRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const doneRef = useRef(false);
  // The camera loop keeps the callback it started with; read the parent's
  // latest onRead / onClose through refs so a changed form is never judged stale.
  const onReadRef = useRef(onRead);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onReadRef.current = onRead; onCloseRef.current = onClose; }, [onRead, onClose]);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  // The camera starts across awaits (permission prompt, play()). aliveRef goes
  // false when the scanner closes, so a start that finishes AFTER that shuts its
  // own camera instead of reading tags into a form nobody is looking at;
  // startingRef stops a second tap from opening a second camera meanwhile.
  const aliveRef = useRef(true);
  const startingRef = useRef(false);

  const stopCamera = useCallback(() => {
    try { controlsRef.current?.stop(); } catch { /* ignore */ }
    controlsRef.current = null;
    setScanning(false);
  }, []);

  const handle = useCallback((raw: string, fromCamera: boolean) => {
    if (doneRef.current || !aliveRef.current) return;
    const code = String(raw || '');
    if (fromCamera) {
      const now = Date.now();
      if (lastRef.current.code === code && now - lastRef.current.at < DUP_WINDOW_MS) return;
      lastRef.current = { code, at: now };
    }
    const err = onReadRef.current(code);
    if (err) { setError(err); return; }
    doneRef.current = true;
    try { navigator.vibrate?.(60); } catch { /* not every device vibrates */ }
    stopCamera();
    onCloseRef.current();
  }, [stopCamera]);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    const video = videoRef.current;
    if (!video || controlsRef.current || startingRef.current || !aliveRef.current) return;
    startingRef.current = true;
    setStarting(true);
    const VIDEO: MediaTrackConstraints = {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      advanced: [{ focusMode: 'continuous' } as any],
    };
    // Whatever this start opens, until it is handed to controlsRef.
    let openStream: MediaStream | null = null;
    let openControls: { stop: () => void } | null = null;
    const release = () => {
      try { openControls?.stop(); } catch { /* ignore */ }
      openStream?.getTracks().forEach((t) => t.stop());
      if (openStream && video.srcObject === openStream) video.srcObject = null;
    };
    try {
      const BD = (window as any).BarcodeDetector;
      let formats: string[] = [];
      if (BD?.getSupportedFormats) {
        try {
          const supported: string[] = await BD.getSupportedFormats();
          formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
        } catch { formats = []; }
      }
      if (formats.length > 0) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO });
        openStream = stream;
        if (!aliveRef.current) { release(); return; }
        video.srcObject = stream;
        await video.play();
        if (!aliveRef.current) { release(); return; }
        const detector = new BD({ formats });
        let stopped = false;
        let timer = 0;
        const tick = async () => {
          if (stopped || !aliveRef.current) return;
          try {
            if (video.readyState >= 2) {
              const hit = ((await detector.detect(video)) as Array<{ rawValue?: string }>).find((c) => c.rawValue);
              if (hit?.rawValue) handle(hit.rawValue, true);
            }
          } catch { /* an unreadable frame is skipped */ }
          if (!stopped && aliveRef.current) timer = window.setTimeout(tick, 80);
        };
        openControls = {
          stop: () => {
            stopped = true;
            window.clearTimeout(timer);
            stream.getTracks().forEach((t) => t.stop());
            if (video.srcObject === stream) video.srcObject = null;
          },
        };
        tick();
      } else {
        const hints = new Map<DecodeHintType, unknown>();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMATS);
        const reader = new BrowserMultiFormatReader(hints as any, { delayBetweenScanAttempts: 100, delayBetweenScanSuccess: 300 });
        openControls = await reader.decodeFromConstraints(
          { video: VIDEO },
          video,
          (res) => { if (res) handle(res.getText(), true); },
        );
        if (!aliveRef.current) { release(); return; }
      }
      controlsRef.current = openControls;
      openStream = null; openControls = null;   // handed over — stopCamera owns them now
      setScanning(true);
    } catch (e: any) {
      release();
      if (!aliveRef.current) return;
      const name = e?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setCameraError('Camera permission denied. Allow camera access in your browser settings, or use a handheld scanner.');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setCameraError('No camera found on this device — use a handheld scanner or type the tag.');
      } else if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
        setCameraError('The camera needs a secure (HTTPS) connection.');
      } else {
        setCameraError(e?.message || 'Could not start the camera.');
      }
      stopCamera();
    } finally {
      startingRef.current = false;
      if (aliveRef.current) setStarting(false);
    }
  }, [handle, stopCamera]);

  // Phones and tablets start on the camera; a desktop with a handheld scanner
  // starts on the box (no camera permission prompt nobody asked for).
  useEffect(() => {
    aliveRef.current = true;   // again on a remount (React dev mounts twice)
    let coarse = false;
    try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch { coarse = false; }
    if (coarse) startCamera();
    return () => {
      aliveRef.current = false;
      try { controlsRef.current?.stop(); } catch { /* ignore */ }
      controlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitTyped = (e: React.FormEvent) => {
    e.preventDefault();
    if (!typed.trim()) return;
    handle(typed, false);
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto"
         onClick={() => { stopCamera(); onClose(); }}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl my-4"
           onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-center justify-between">
          <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">
            <ScanLine className="w-5 h-5 text-[#af4408]" /> {title}
          </div>
          <button type="button" onClick={() => { stopCamera(); onClose(); }}
                  className="text-[#8B7355] hover:text-[#2D1B0E]" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          {/* Shown from the moment the camera starts, so play() never runs on a
              hidden <video> (some phones refuse that). */}
          <div className={`relative rounded-lg overflow-hidden bg-black ${scanning || starting ? '' : 'hidden'}`}>
            <video ref={videoRef} playsInline muted className="w-full max-h-[45vh] object-cover" />
            <div className="absolute inset-x-8 top-1/2 h-0.5 bg-red-500/80" />
          </div>
          {scanning ? (
            <button type="button" onClick={stopCamera}
                    className="w-full px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm text-[#6B5744] flex items-center justify-center gap-1.5">
              <CameraOff className="w-4 h-4" /> Stop camera
            </button>
          ) : (
            <button type="button" onClick={startCamera} disabled={starting}
                    className="w-full px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-60">
              <Camera className="w-4 h-4" /> {starting ? 'Starting camera…' : 'Use camera'}
            </button>
          )}
          {cameraError && <div className="text-[12px] text-red-700">{cameraError}</div>}
          <form onSubmit={submitTyped} className="space-y-1">
            <label className="block text-[11px] text-[#6B5744]">Or scan with a handheld scanner (or type the tag) and press Enter</label>
            <div className="flex gap-2">
              <input value={typed} onChange={(e) => { setTyped(e.target.value); setError(null); }}
                     autoFocus autoComplete="off" placeholder={placeholder}
                     className="flex-1 min-w-0 px-3 py-2 border border-[#D4B896] rounded-lg text-sm font-mono" />
              <button type="submit" disabled={!typed.trim()}
                      className="px-3 py-2 border border-[#af4408] text-[#af4408] rounded-lg text-sm font-semibold disabled:opacity-40">
                Use
              </button>
            </div>
          </form>
          {error && (
            <div role="alert" className="text-[12px] font-medium text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">{error}</div>
          )}
          <p className="text-[10px] text-[#8B7355]">
            {hint ?? 'The tag fills the Batch Number box (and picks the item when the tag starts with its serial code). Nothing is saved until you press Save.'}
          </p>
        </div>
      </div>
    </div>
  );
}
