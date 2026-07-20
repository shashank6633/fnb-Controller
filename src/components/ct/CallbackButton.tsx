'use client';

/**
 * CRM Call-to-Table — device-dialed callback button (the no-outbound-package
 * workaround). Tapping it opens the phone's native dialer via a tel: link and
 * starts a "time-away" timer; when the GRE returns to the app, a log sheet opens
 * pre-filled with the approximate talk duration for them to confirm + disposition.
 * The result is posted to /api/crm-calls/calls/log-callback, which synthesizes an
 * OUTBOUND call record (with duration) so it shows in Call Log / Guest 360 /
 * leaderboard and advances the recovery — all without TeleCMI outbound.
 *
 * A "Log manually" affordance covers desktop (where tel: does nothing) and any
 * time the auto-capture is missed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PhoneOutgoing, Loader2, X, BadgeCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import {
  markTwaIfReferred, isCaptainApp, callLoggerIntentUrl,
  parseCallbackReturn, clearCallbackReturnParams, samePhone,
} from '@/lib/ct/twa';

interface Props {
  phone: string;
  guestId?: string;
  recoveryId?: string;
  guestName?: string;
  label?: string;
  className?: string;
  onLogged?: (r: { call_id: string; recovery_status: string | null }) => void;
}

const OUTCOMES: Array<{ value: string; label: string }> = [
  { value: 'booking_made', label: 'Booking made' },
  { value: 'enquiry', label: 'Enquiry' },
  { value: 'complaint', label: 'Complaint' },
  { value: 'follow_up_needed', label: 'Follow-up needed' },
  { value: 'wrong_number', label: 'Wrong number' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'no_action', label: 'No action' },
];

const mmss = (secs: number) => `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;

export default function CallbackButton({ phone, guestId, recoveryId, guestName, label = 'Call Back', className, onLogged }: Props) {
  const [open, setOpen] = useState(false);
  const [mins, setMins] = useState(0);
  const [secs, setSecs] = useState(0);
  const [connected, setConnected] = useState(true);
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // '' = web time-away timer; 'manual' = typed via "Log manually";
  // 'call_log' = exact duration read from the device call log by the Captain
  // APK; 'approx' = the APK's own wall-time fallback.
  const [source, setSource] = useState<'' | 'manual' | 'call_log' | 'approx'>('');
  // Portal target — the sheet must escape any display:none ancestor (the
  // desktop table is CSS-hidden on phones but its instance can claim a return).
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const dialingRef = useRef<number | null>(null); // start ts while away at the dialer
  const wentHiddenRef = useRef(false);            // did we actually leave for the dialer?

  const openSheet = useCallback((elapsedSec: number, opts?: { source?: '' | 'manual' | 'call_log' | 'approx'; connected?: boolean }) => {
    setMins(Math.floor(elapsedSec / 60));
    setSecs(elapsedSec % 60);
    setConnected(opts?.connected ?? elapsedSec > 0);
    setSource(opts?.source ?? '');
    setOutcome('');
    setNote('');
    setError('');
    setOpen(true);
  }, []);

  // Native return from the Captain APK's CallLoggerActivity: the deep link
  // reopens this page with cb_* params carrying the EXACT call-log duration.
  // The matching row claims them (recovery id first, else phone) and opens the
  // sheet prefilled; params are stripped so back/refresh can't re-trigger.
  useEffect(() => {
    markTwaIfReferred();
    const ret = parseCallbackReturn();
    if (!ret) return;
    const mine = ret.recoveryId
      ? ret.recoveryId === (recoveryId || '')
      : samePhone(ret.phone, phone);
    if (!mine) return;
    // Claiming = synchronously stripping the params, so any other row's effect
    // (they run in mount order) parses null and can't double-claim.
    clearCallbackReturnParams();
    openSheet(ret.durationSec, { source: ret.source, connected: ret.connected });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the GRE returns to the app AFTER actually leaving for the dialer,
  // prefill the sheet with how long they were away (≈ talk time). We require an
  // observed hidden→visible transition so a return from an UNRELATED tab-switch
  // (where the page never went to the dialer) can't pop a bogus multi-hour sheet.
  // The prefill is also capped to a sane max; the GRE confirms/adjusts anyway.
  useEffect(() => {
    const onVis = () => {
      if (dialingRef.current == null) return;
      if (document.visibilityState === 'hidden') {
        wentHiddenRef.current = true;
        return;
      }
      // visible again
      if (!wentHiddenRef.current) return; // never actually left → ignore
      const elapsedRaw = Math.max(0, Math.round((Date.now() - dialingRef.current) / 1000));
      dialingRef.current = null;
      wentHiddenRef.current = false;
      const elapsed = elapsedRaw > 2 * 60 * 60 ? 0 : elapsedRaw; // >2h ⇒ implausible, let them enter it
      openSheet(elapsed);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [openSheet]);

  const startCall = () => {
    if (!phone) return;
    // Inside the Captain APK: hand off to CallLoggerActivity, which places the
    // call, reads the EXACT duration from the device call log, and deep-links
    // back here with cb_* params (claimed by the mount effect above). No timer
    // needed — the return navigation reloads the page.
    if (isCaptainApp()) {
      try {
        const returnPath = window.location.pathname + window.location.search;
        window.location.href = callLoggerIntentUrl({ phone, recoveryId, returnPath });
        return;
      } catch { /* fall through to tel: */ }
    }
    dialingRef.current = Date.now();
    wentHiddenRef.current = false;
    // Native dialer (mobile). On desktop this may no-op; the "Log manually"
    // link + the visibility fallback still let the GRE record the call.
    try { window.location.href = `tel:${phone.replace(/[^\d+]/g, '')}`; } catch { /* ignore */ }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true); setError('');
    try {
      const duration_sec = Math.max(0, mins * 60 + secs);
      const r = await api('/api/crm-calls/calls/log-callback', {
        method: 'POST',
        body: { phone, guest_id: guestId, recovery_id: recoveryId, duration_sec, connected, outcome, note, source: source || 'timer' },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j?.error || `Failed (HTTP ${r.status})`); setSaving(false); return; }
      setOpen(false); setSaving(false);
      onLogged?.({ call_id: j.call_id, recovery_status: j.recovery_status ?? null });
    } catch (e: any) {
      setError(e?.message || 'Network error'); setSaving(false);
    }
  };

  return (
    <>
      <span className={`inline-flex items-center gap-1.5 ${className || ''}`}>
        <button
          type="button"
          onClick={startCall}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[#af4408] text-white hover:bg-[#8a3506] transition-colors"
        >
          <PhoneOutgoing className="w-3.5 h-3.5" /> {label}
        </button>
        <button
          type="button"
          onClick={() => openSheet(0, { source: 'manual' })}
          className="text-[11px] text-[#8B7355] hover:text-[#af4408] hover:underline"
          title="Log a callback you already made"
        >
          Log manually
        </button>
      </span>

      {open && mounted && createPortal(
        <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !saving && setOpen(false)} />
          <div className="relative w-full sm:max-w-md bg-white border border-[#E8D5C4] rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
               style={{ maxHeight: 'calc(100vh - 1rem)' }}>
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#E8D5C4] shrink-0">
              <h2 className="text-base font-semibold text-[#2D1B0E] flex items-center gap-2">
                <PhoneOutgoing className="w-4 h-4 text-[#af4408]" /> Log callback
              </h2>
              <button onClick={() => !saving && setOpen(false)} aria-label="Close" className="p-1.5 rounded-lg hover:bg-[#FFF1E3]"><X className="w-4 h-4 text-[#8B7355]" /></button>
            </div>
            <div className="px-5 py-4 space-y-3 overflow-y-auto">
              <p className="text-sm text-[#6B5744]">
                {guestName ? <b className="text-[#2D1B0E]">{guestName}</b> : 'Caller'} · <span className="font-mono">{formatPhone(phone) || phone}</span>
              </p>

              <label className="flex items-center gap-2 text-sm text-[#3D2614]">
                <input type="checkbox" checked={connected} onChange={e => setConnected(e.target.checked)} />
                Call connected (they picked up)
              </label>

              <div>
                <p className="text-[11px] uppercase tracking-wide text-[#8B7355] mb-1">Talk duration {mins || secs ? <span className="text-[#af4408]">· {mmss(mins * 60 + secs)}</span> : ''}</p>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} value={mins} onChange={e => setMins(Math.max(0, parseInt(e.target.value || '0', 10) || 0))}
                         className="w-20 px-2 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" /> <span className="text-sm text-[#6B5744]">min</span>
                  <input type="number" min={0} max={59} value={secs} onChange={e => setSecs(Math.min(59, Math.max(0, parseInt(e.target.value || '0', 10) || 0)))}
                         className="w-20 px-2 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" /> <span className="text-sm text-[#6B5744]">sec</span>
                </div>
                {source === 'call_log' ? (
                  <p className="text-[11px] text-green-700 mt-1 inline-flex items-center gap-1 font-medium">
                    <BadgeCheck className="w-3.5 h-3.5" /> Exact — read from the phone's call log.
                  </p>
                ) : (
                  <p className="text-[11px] text-[#8B7355] mt-1">Auto-filled from time away at the dialer — adjust if needed.</p>
                )}
              </div>

              <div>
                <p className="text-[11px] uppercase tracking-wide text-[#8B7355] mb-1">Outcome</p>
                <select value={outcome} onChange={e => setOutcome(e.target.value)}
                        className="w-full px-2.5 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E]">
                  <option value="">— Select —</option>
                  {OUTCOMES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>

              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Note (optional)"
                        className="w-full px-2.5 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E]" />

              {error && <p className="text-xs text-red-600">{error}</p>}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#E8D5C4] shrink-0">
              <button onClick={() => !saving && setOpen(false)} className="px-3 py-1.5 rounded-lg text-sm text-[#6B5744] hover:bg-[#FFF1E3]">Cancel</button>
              <button onClick={save} disabled={saving}
                      className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold bg-[#af4408] text-white hover:bg-[#8a3506] disabled:opacity-50">
                {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</> : 'Save callback'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
