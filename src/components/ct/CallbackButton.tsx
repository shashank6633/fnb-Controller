'use client';

/**
 * CRM Call-to-Table — device-dialed callback button (the no-outbound-package
 * workaround). Tapping it opens the phone's native dialer via a tel: link and
 * starts a "time-away" timer; when the GRE returns to the app, a log sheet opens
 * pre-filled with the approximate talk duration for them to confirm + disposition.
 * The result is posted to /api/crm-calls/calls/log-callback, which synthesizes an
 * OUTBOUND call record (with duration) so the CALL shows in Call Log / Guest 360
 * and advances the recovery — all without TeleCMI outbound.
 *
 * A "Log manually" affordance covers desktop (where tel: does nothing) and any
 * time the auto-capture is missed.
 *
 * FROM THE CALL LOG VERSUS ESTIMATED — the distinction this sheet is built
 * around. Inside the Captain APK, CallLoggerActivity reads the talk time out of
 * the device call log. The sheet renders that as a stated fact with no input
 * box: a GRE editing their own captured talk time upward is precisely the leak
 * this closes. Everywhere else — iOS, mobile web, desktop, "Log manually", and
 * the APK's own fallback when the call log cannot be read — the number is an
 * ESTIMATE, stays editable because an estimate that cannot be corrected is
 * worse than useless, and is captioned so it never reads as a measurement.
 *
 * THE CHIP AND THE LOCK ARE THE SAME CONDITION, BY CONSTRUCTION. Both hang off
 * `measuredSec !== null`, which is set only when a call-log return is claimed.
 * They cannot drift into a sheet that claims exactness over a typed number,
 * which is what an earlier version did.
 *
 * THE CHIP SAYS WHERE THE NUMBER CAME FROM, NOT THAT IT IS PROVEN. It reads
 * "From call log" and not "Measured", because this component cannot know it is
 * running inside the APK: every cb_* param is a query param, so a typed
 * ?cb=1&cb_src=calllog URL reaches here looking exactly like a real capture, on
 * desktop as easily as on a phone. The lock is a UX/honesty fix, not a security
 * boundary. The boundary is the CALL TOKEN: minted server-side when Call Back is
 * tapped, carried through the round trip, and redeemed by log-callback, which
 * clamps the claimed talk time to the wall time since dialling began. Only the
 * server's duration_verified means anything, and the Call Log renders THAT —
 * so this sheet must not promise a badge the record will not show, which is why
 * the save step below says so out loud when the server would not vouch for it.
 *
 * SPENDING THE TOKEN DOES NOT STOP A DUPLICATE ROW. It stops the same token
 * vouching twice; log-callback still writes a call row for a replay (marked
 * unverified), because refusing to log a call that really happened is the worse
 * failure. Do not describe single use as duplicate-row protection.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PhoneOutgoing, Loader2, X, BadgeCheck, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import {
  markTwaIfReferred, isCaptainApp, callLoggerIntentUrl,
  parseCallbackReturn, clearCallbackReturnParams, samePhone, mintCallToken,
  TOKEN_MINT_TAP_BUDGET_MS, TOKEN_MINT_IDLE_BUDGET_MS,
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

/**
 * Where the number in the box came from, AS CLAIMED BY THIS CLIENT. Mirrors
 * DURATION_SOURCES in src/lib/ct/call-token.ts, which is the server's whitelist
 * — deliberately re-declared rather than imported, because that module reaches
 * @/lib/db and this file is "use client".
 *   call_log — the Captain APK read the device call log. The only measurement.
 *   approx   — the APK's own wall time, used when the call log was unreadable.
 *   timer    — the web time-away timer (iOS, mobile web, desktop).
 *   manual   — typed from zero.
 */
type DurationSource = 'call_log' | 'approx' | 'timer' | 'manual';

export default function CallbackButton({ phone, guestId, recoveryId, guestName, label = 'Call Back', className, onLogged }: Props) {
  const [open, setOpen] = useState(false);
  const [mins, setMins] = useState(0);
  const [secs, setSecs] = useState(0);
  const [connected, setConnected] = useState(true);
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false); // minting a token before the dial
  const [error, setError] = useState('');
  const [source, setSource] = useState<DurationSource>('timer');
  /**
   * The talk time we RECEIVED as a measurement, in seconds — set only when a
   * call-log return is claimed, null on every estimate path. Non-null means two
   * things at once and they must never come apart: the duration renders as
   * read-only text, and it is what gets posted (never the mins/secs state, which
   * has no input attached to it in that mode).
   */
  const [measuredSec, setMeasuredSec] = useState<number | null>(null);
  const locked = measuredSec !== null;
  /**
   * Set after a save whose stored result needs saying out loud — the server
   * clamped the duration, or we showed the "From call log" chip and the server
   * would not vouch for the number under it. A plain save closes the sheet as
   * before; this is not a confirmation step bolted onto the happy path.
   */
  const [saved, setSaved] = useState<null | {
    storedSec: number;
    postedSec: number;
    cappedFrom?: number;
    verified: boolean | null; // null = this server build did not say
  }>(null);
  // Portal target — the sheet must escape any display:none ancestor (the
  // desktop table is CSS-hidden on phones but its instance can claim a return).
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const dialingRef = useRef<number | null>(null); // start ts while away at the dialer
  const wentHiddenRef = useRef(false);            // did we actually leave for the dialer?
  // The call token, in the two states it can be in. Exactly one of these is
  // ever live: a token that has arrived (from the APK's return URL), or a mint
  // still in flight (the tel: path, which does not wait for it). Clearing both
  // is how any code path says "this sheet gets no token" — see openSheet.
  const tokenRef = useRef('');
  const tokenPromiseRef = useRef<Promise<string> | null>(null);
  const loggedRef = useRef<{ call_id: string; recovery_status: string | null } | null>(null);

  const openSheet = useCallback((elapsedSec: number, opts?: { source?: DurationSource; connected?: boolean }) => {
    const src = opts?.source ?? 'timer';
    setMins(Math.floor(elapsedSec / 60));
    setSecs(elapsedSec % 60);
    setConnected(opts?.connected ?? elapsedSec > 0);
    setSource(src);
    // A call-log capture is the one number this client did not make up, so it
    // is the one number the GRE does not get to retype.
    setMeasuredSec(src === 'call_log' ? elapsedSec : null);
    // "Log manually" DISCARDS ANY HELD TOKEN, on purpose. A manually logged
    // call was placed outside this flow — often minutes or hours ago — so there
    // is nothing for a wall-clock bound to be about. Keeping a stale token here
    // would clamp an honest ten-minute call down to the seconds since the tap
    // and then file the wreckage as verified, which is worse than not verifying
    // at all. Unverified-and-true beats verified-and-wrong every time.
    if (src === 'manual') { tokenRef.current = ''; tokenPromiseRef.current = null; }
    setOutcome('');
    setNote('');
    setError('');
    setSaved(null);
    setOpen(true);
  }, []);

  /** Close + hand the parent any call this sheet actually logged (once). */
  const closeSheet = useCallback(() => {
    setOpen(false);
    setSaved(null);
    const l = loggedRef.current;
    loggedRef.current = null;
    if (l) onLogged?.(l);
  }, [onLogged]);

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
    // The token travelled in the URL, not in this component's memory, so it
    // survives the APK round trip (which reloads the page) and lands on
    // whichever instance claims the return — not necessarily the one tapped.
    tokenRef.current = ret.token;
    tokenPromiseRef.current = null;
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
      // >2h away ⇒ implausible as a call; we throw the timing away and let them
      // type it. That makes the number a typed one, so it is logged as 'manual'
      // rather than 'timer' — the caption and the stored provenance both have to
      // say what actually happened, and nothing was auto-filled here.
      const implausible = elapsedRaw > 2 * 60 * 60;
      openSheet(implausible ? 0 : elapsedRaw, { source: implausible ? 'manual' : 'timer' });
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [openSheet]);

  /**
   * Place the call. Both paths mint a call token first — the wall-clock bound
   * is just as valid behind a tel: link as behind the APK, and tel: is the path
   * iOS takes — but they differ in whether anything can wait for it.
   *
   * THE CALL IS PLACED NO MATTER WHAT HAPPENS TO THE TOKEN. Offline, server
   * down, request too slow, response nonsense: we dial, and the call is logged
   * unverified. Do not turn either mint into a blocking await, a retry loop or
   * an error toast that stands between a GRE and a guest who is waiting for a
   * call back. Losing a real call to protect a statistic would be a far worse
   * bug than the one the token exists to fix.
   */
  const startCall = async () => {
    if (!phone || starting) return;

    // Inside the Captain APK: hand off to CallLoggerActivity, which places the
    // call, reads the EXACT duration from the device call log, and deep-links
    // back here with cb_* params (claimed by the mount effect above). No timer
    // needed — the return navigation reloads the page.
    //
    // This is the one path that has to wait for the token, because the token
    // can only get home inside the return URL the APK is about to be handed.
    // The wait is capped at TOKEN_MINT_TAP_BUDGET_MS and the button shows a
    // spinner for it; on timeout we dial with no token.
    let token = '';
    if (isCaptainApp()) {
      setStarting(true);
      try {
        token = await mintCallToken({ phone, guestId, recoveryId }, { timeoutMs: TOKEN_MINT_TAP_BUDGET_MS });
      } finally {
        setStarting(false);
      }
      tokenRef.current = '';          // it comes back in the URL, not in memory
      tokenPromiseRef.current = null;
      try {
        const returnPath = window.location.pathname + window.location.search;
        window.location.href = callLoggerIntentUrl({ phone, recoveryId, returnPath, token });
        return;
      } catch { /* activity unreachable — fall through to tel: */ }
    }

    dialingRef.current = Date.now();
    wentHiddenRef.current = false;
    // tel: keeps this page alive, so the token can be held in memory and the
    // request does NOT have to be waited on: fire it and dial in the same tick.
    // Nothing needs the answer until the GRE comes back and saves, which is
    // whole minutes away. If we fell through from the APK branch we already
    // have one — reuse it rather than minting a second.
    //
    // The in-flight request is held ONLY as tokenPromiseRef and never writes
    // itself into tokenRef when it lands. That is what makes dropping the token
    // a single assignment: opening the manual sheet (or tapping Call Back
    // again) nulls/replaces this ref, and a late reply then resolves into
    // nothing instead of quietly re-arming a sheet that must not have a token.
    tokenRef.current = token;
    tokenPromiseRef.current = token ? null : mintCallToken(
      { phone, guestId, recoveryId },
      { timeoutMs: TOKEN_MINT_IDLE_BUDGET_MS },
    ).catch(() => '');
    // Native dialer (mobile). On desktop this may no-op; the "Log manually"
    // link + the visibility fallback still let the GRE record the call.
    try { window.location.href = `tel:${phone.replace(/[^\d+]/g, '')}`; } catch { /* ignore */ }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true); setError('');
    try {
      // A call-log duration is posted from measuredSec, not from the mins/secs
      // state: with no input rendered nothing can have changed them, and taking
      // the number from the field the user cannot reach makes that structural
      // rather than a thing to remember.
      const duration_sec = locked ? measuredSec! : Math.max(0, mins * 60 + secs);
      // The tel: mint is normally long settled by now (the GRE has been at the
      // dialer). If it somehow is not, wait — it self-aborts on its own budget,
      // so this can never hang, and an unverified call is the fallback anyway.
      let call_token = tokenRef.current;
      if (!call_token && tokenPromiseRef.current) {
        call_token = await tokenPromiseRef.current.catch(() => '') || '';
      }
      const r = await api('/api/crm-calls/calls/log-callback', {
        method: 'POST',
        body: {
          phone, guest_id: guestId, recovery_id: recoveryId,
          duration_sec, connected, outcome, note, source,
          ...(call_token ? { call_token } : {}),
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j?.error || `Failed (HTTP ${r.status})`); setSaving(false); return; }
      // Single use: whether or not the server accepted it, this token has had
      // its one chance. Never let a retry or a second call reuse it.
      tokenRef.current = ''; tokenPromiseRef.current = null;
      setSaving(false);
      loggedRef.current = { call_id: j.call_id, recovery_status: j.recovery_status ?? null };

      // What the log actually holds, which is not always what we posted. Older
      // server builds (and the 20s de-dupe reply) send neither field back; then
      // there is nothing to reconcile and the sheet closes as it always did.
      const storedSec = typeof j.duration_sec === 'number' ? j.duration_sec : duration_sec;
      const verified = typeof j.duration_verified === 'undefined'
        ? null : (j.duration_verified === 1 || j.duration_verified === true);
      const cappedFrom = typeof j.duration_capped_from === 'number' ? j.duration_capped_from : undefined;
      // Speak up in exactly two situations: the stored time differs from the
      // one still on screen, or we showed the "From call log" chip over a
      // duration the server would not vouch for. Anything else closes at once —
      // a confirmation step on every save would just get tapped through.
      const needsSaying = storedSec !== duration_sec || (locked && verified === false);
      if (needsSaying) { setSaved({ storedSec, postedSec: duration_sec, cappedFrom, verified }); return; }
      closeSheet();
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
          disabled={starting}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[#af4408] text-white hover:bg-[#8a3506] transition-colors disabled:opacity-70"
        >
          {/* Same icon box either way, so the button never changes width while
              the (sub-second, hard-capped) token mint is in flight. */}
          {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PhoneOutgoing className="w-3.5 h-3.5" />} {label}
        </button>
        <button
          type="button"
          onClick={() => openSheet(0, { source: 'manual' })}
          // Closed while a dial is being set up: if the APK intent then failed
          // and fell through to tel:, a token minted a moment ago would land in
          // an already-open MANUAL sheet and clamp a typed duration to those few
          // seconds — verified, and wrong. One disabled attribute removes the race.
          disabled={starting}
          className="text-[11px] text-[#8B7355] hover:text-[#af4408] hover:underline disabled:opacity-50 disabled:no-underline"
          title="Log a callback you already made"
        >
          Log manually
        </button>
      </span>

      {open && mounted && createPortal(
        <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !saving && closeSheet()} />
          <div className="relative w-full sm:max-w-md bg-white border border-[#E8D5C4] rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
               style={{ maxHeight: 'calc(100vh - 1rem)' }}>
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#E8D5C4] shrink-0">
              <h2 className="text-base font-semibold text-[#2D1B0E] flex items-center gap-2">
                {saved
                  ? <><CheckCircle2 className="w-4 h-4 text-green-600" /> Callback logged</>
                  : <><PhoneOutgoing className="w-4 h-4 text-[#af4408]" /> Log callback</>}
              </h2>
              <button onClick={() => !saving && closeSheet()} aria-label="Close" className="p-1.5 rounded-lg hover:bg-[#FFF1E3]"><X className="w-4 h-4 text-[#8B7355]" /></button>
            </div>

            {/* The call is already in the log by the time this shows; it is here
                because the stored number is not the one still on screen, or
                because we badged a duration the server would not vouch for.
                Leaving either unsaid would let the GRE walk away believing the
                record says something it does not. */}
            {saved ? (
              <div className="px-5 py-5 space-y-3 overflow-y-auto">
                <p className="text-sm text-[#6B5744]">
                  Recorded talk time <b className="text-[#2D1B0E] tabular-nums">{mmss(saved.storedSec)}</b>
                  {guestName ? <> for <b className="text-[#2D1B0E]">{guestName}</b></> : null}.
                </p>
                {saved.storedSec !== saved.postedSec && (
                  <p className="text-[12px] leading-relaxed text-[#6B5744] bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg px-3 py-2">
                    {saved.cappedFrom === undefined
                      ? <>You logged {mmss(saved.postedSec)}; the call log stores it as {mmss(saved.storedSec)}.</>
                      : locked
                      ? <>The phone reported {mmss(saved.cappedFrom)}, which is longer than the time since you tapped Call Back — most likely an older call in its log. It was recorded as {mmss(saved.storedSec)}, and marked reported rather than verified.</>
                      : <>You logged {mmss(saved.cappedFrom)}. A call cannot have run longer than the time since you tapped Call Back, so it was recorded as {mmss(saved.storedSec)}, and marked reported rather than verified.</>}
                  </p>
                )}
                {/* Only when nothing was cut. A clamped save is ALSO unverified
                    now — the number the phone gave could not be true — but the
                    paragraph above has already explained that one, and saying
                    "saved exactly as the phone reported it" underneath it would
                    contradict it in the same breath. */}
                {locked && saved.verified === false && saved.cappedFrom === undefined && (
                  <p className="text-[12px] leading-relaxed text-[#6B5744] bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg px-3 py-2">
                    The time was saved exactly as the phone reported it, but the server could not match it to when this call started, so the record marks it as reported rather than verified.
                  </p>
                )}
              </div>
            ) : (
            <div className="px-5 py-4 space-y-3 overflow-y-auto">
              <p className="text-sm text-[#6B5744]">
                {guestName ? <b className="text-[#2D1B0E]">{guestName}</b> : 'Caller'} · <span className="font-mono">{formatPhone(phone) || phone}</span>
              </p>

              <label className="flex items-center gap-2 text-sm text-[#3D2614]">
                <input type="checkbox" checked={connected} onChange={e => setConnected(e.target.checked)} />
                Call connected (they picked up)
              </label>

              {/* A CALL-LOG TALK TIME IS A CAPTURED FACT, NOT A FILLED-IN FIELD.
                  Rendered as text rather than a disabled input on purpose: a
                  greyed-out box reads as broken and invites someone to "fix"
                  it, while a plain figure with the chip reads as the record it
                  is. Same header/value/caption rhythm and the same 34px value
                  row as the editable version, so the sheet does not jump
                  between the two. */}
              <div>
                <p className="text-[11px] uppercase tracking-wide text-[#8B7355] mb-1">
                  Talk duration {!locked && (mins || secs) ? <span className="text-[#af4408]">· {mmss(mins * 60 + secs)}</span> : ''}
                </p>
                {locked ? (
                  <>
                    <div className="flex items-center gap-2 min-h-[34px]">
                      <span className="text-xl font-semibold text-[#2D1B0E] tabular-nums leading-none">{mmss(measuredSec)}</span>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-700 text-[10px] font-bold uppercase tracking-wide">
                        <BadgeCheck className="w-3 h-3" /> From call log
                      </span>
                    </div>
                    <p className="text-[11px] text-green-700 mt-1">Read from the phone&apos;s call log when the call ended, so it is not editable here. The call log marks it verified only if the server can match it to when you tapped Call Back.</p>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <input type="number" min={0} value={mins} onChange={e => setMins(Math.max(0, parseInt(e.target.value || '0', 10) || 0))}
                             className="w-20 px-2 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" /> <span className="text-sm text-[#6B5744]">min</span>
                      <input type="number" min={0} max={59} value={secs} onChange={e => setSecs(Math.min(59, Math.max(0, parseInt(e.target.value || '0', 10) || 0)))}
                             className="w-20 px-2 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" /> <span className="text-sm text-[#6B5744]">sec</span>
                    </div>
                    {/* One caption per estimate source. The old single line said
                        "auto-filled from time away at the dialer" for all three,
                        which was simply untrue of a number typed from zero. */}
                    <p className="text-[11px] text-[#8B7355] mt-1">
                      {source === 'approx'
                        ? 'Estimated by the app — the phone could not read its call log for this call. Adjust if it is off.'
                        : source === 'manual'
                        ? 'Enter the talk time as you remember it — it is recorded as an estimate.'
                        : 'Estimated from the time you were away at the dialer. Adjust if it is off.'}
                    </p>
                  </>
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
            )}

            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#E8D5C4] shrink-0">
              {saved ? (
                <button onClick={closeSheet}
                        className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-[#af4408] text-white hover:bg-[#8a3506]">Done</button>
              ) : (
                <>
                  <button onClick={() => !saving && closeSheet()} className="px-3 py-1.5 rounded-lg text-sm text-[#6B5744] hover:bg-[#FFF1E3]">Cancel</button>
                  <button onClick={save} disabled={saving}
                          className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold bg-[#af4408] text-white hover:bg-[#8a3506] disabled:opacity-50">
                    {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</> : 'Save callback'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
