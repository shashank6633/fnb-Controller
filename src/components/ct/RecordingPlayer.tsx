'use client';

/**
 * Call-recording player — the ONE place a recording is played, shared by the
 * Call Log and Guest 360.
 *
 * ── WHY IT IS NOT A BARE <audio> ───────────────────────────────────────────
 * /api/telecmi/recording/[callId] answers JSON on every failure path, and each
 * of those bodies says exactly what went wrong:
 *
 *   401  Sign in required
 *   404  Call not found  /  No recording for this call
 *   410  past the N-day retention window, or the call cannot be dated
 *   502  the upstream refusal, in TeleCMI's own words
 *
 * An <audio src> throws all of that away. Handed a JSON body it renders
 * 0:00 / 0:00 with a dead grey play button and no explanation — which is what
 * the owner reported, on both surfaces, for a recording that was never
 * reachable at the stored URL. The reason existed the whole time; nothing was
 * reading it.
 *
 * So: keep <audio src> (the proxy forwards Range headers, so seeking and
 * scrubbing keep working, which a fetch-into-a-blob player would lose), and on
 * the element's error event fetch the SAME url once to read the reason and
 * print it. The extra request is paid only when playback has already failed.
 *
 * preload="none" is deliberate and unchanged: Guest 360 renders one of these
 * per timeline row, and preloading would fire an upstream TeleCMI fetch per row
 * on page open. The reason therefore appears when the user presses play, which
 * is the moment they are asking the question.
 *
 * ── WHY THE REASON IS NOT ENOUGH ON ITS OWN ────────────────────────────────
 * The proxy's sentence says what happened. It does not say what the reader can
 * do about it, and those are different questions with different answers per
 * reader. "TeleCMI refused the credentials" is a five-minute fix for an admin
 * and a dead end for a GRE, and printing the same line at both wastes one and
 * strands the other. So each failure is CLASSIFIED (see classify() below) and
 * the class carries two action lines: one for an admin, one for everybody else.
 *
 * ONLY A CONFIGURATION FAULT GETS A LINK, AND ONLY FOR AN ADMIN. /crm-calls/
 * telephony is admin-gated — it renders "Admin only" for everyone else — so
 * offering it to a GRE is offering a locked door. Data faults (no recording,
 * past retention, TeleCMI has no such file) get no link at all: there is
 * nothing on any screen that would change them.
 *
 * THE CLASSIFIER PREFERS A MACHINE-READABLE VERDICT AND FALLS BACK TO PROSE.
 * If the proxy ever puts a `fault` (and/or `credentialed`) field in its error
 * body, that wins outright. Until it does, the class is read off the HTTP
 * status — which is exact — plus the vendor's own wording, which is not. The
 * one distinction prose cannot make is credentials NOT SET versus credentials
 * REJECTED: TeleCMI answers 407 to both, so an unaided classifier reports
 * 'credentials_unclear' and the copy says "not set up or not accepted" rather
 * than guessing. See CONFIG_FAULTS.
 *
 * NOTHING HERE BUILDS A TELECMI URL AND NOTHING HERE CAN SEE A SECRET. The
 * only URL this file constructs is our own proxy path; the app secret lives
 * server-side and never appears in any body this component reads.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, RotateCw, Settings } from 'lucide-react';

type Phase = 'idle' | 'checking' | 'failed';

/** Range: bytes=0-0 asks the proxy for one byte — enough to learn the verdict
 *  without pulling audio we are not going to play. Every error path answers
 *  JSON regardless of the Range header, so nothing is lost on failure. */
const PROBE_HEADERS: HeadersInit = { Range: 'bytes=0-0' };

/** Client-side ceiling on the "why did that fail?" request. The proxy's own
 *  upstream timeout is 15s, so this is the backstop that keeps the widget from
 *  sitting on "Checking…" forever if the proxy itself never answers. */
const PROBE_TIMEOUT_MS = 20_000;

/** The one screen that fixes a telephony-configuration fault. Admin-gated. */
const TELEPHONY_HREF = '/crm-calls/telephony';

function proxyUrl(callId: string): string {
  return `/api/telecmi/recording/${encodeURIComponent(callId)}`;
}

/* ── Failure classes ───────────────────────────────────────────────────────*/

type FaultKind =
  | 'signin'
  | 'not_recorded'
  | 'missing_row'
  | 'retention'
  | 'credentials_missing'
  | 'credentials_rejected'
  | 'credentials_unclear'
  | 'url_shape'
  | 'blocked'
  | 'file_missing'
  | 'network'
  | 'browser'
  | 'unknown';

/**
 * CONFIGURATION faults — something an admin changes on a settings screen fixes
 * these, and nothing anyone else does will. They are the only classes that get
 * the Telephony link, and only when the reader is actually an admin.
 *
 * Everything NOT in here is a DATA fault (this call was never recorded, the
 * recording aged out, TeleCMI has no such file) or a transient one. No screen
 * in this app changes those, so offering a settings page for them would send an
 * admin somewhere with nothing to do.
 */
const CONFIG_FAULTS = new Set<FaultKind>([
  'credentials_missing',
  'credentials_rejected',
  'credentials_unclear',
  'url_shape',
  'blocked',
]);

interface FaultCopy {
  /** A few words naming the class. Sits above the server's own sentence. */
  label: string;
  /** What an admin should do. '' when there is genuinely nothing to do. */
  admin: string;
  /** What everyone else should do. '' when there is nothing to do. */
  other: string;
  /** Offer a re-attempt. False where retrying cannot possibly help. */
  retry: boolean;
}

const FAULT_COPY: Record<FaultKind, FaultCopy> = {
  signin: {
    label: 'Your session has expired',
    admin: 'Sign in again, then reopen this call.',
    other: 'Sign in again, then reopen this call.',
    retry: false,
  },
  not_recorded: {
    label: 'Nothing was recorded',
    admin: 'TeleCMI recorded nothing for this call, so there is nothing to play. Nothing has been lost.',
    other: 'TeleCMI recorded nothing for this call, so there is nothing to play. Nothing has been lost.',
    retry: false,
  },
  missing_row: {
    label: 'This call is no longer in the log',
    admin: 'Refresh the page — the call it was attached to has gone.',
    other: 'Refresh the page — the call it was attached to has gone.',
    retry: false,
  },
  retention: {
    label: 'Past its retention window',
    admin: 'This is the retention rule working, not a fault. The window is set under Recording retention on the Telephony page.',
    other: 'This is the retention rule working, not a fault. Recordings are deliberately not kept reachable beyond that point.',
    retry: false,
  },
  credentials_missing: {
    label: 'Telephony credentials are not set up',
    admin: 'Add the TeleCMI App ID and secret, then play this again.',
    other: 'No recording will play until an administrator sets up the TeleCMI App ID and secret. Please pass this on.',
    retry: true,
  },
  credentials_rejected: {
    label: 'TeleCMI rejected our credentials',
    admin: 'The App ID and secret this app is using are wrong or expired. Check them, then press Try playback now.',
    other: 'TeleCMI is not accepting this app’s telephony credentials. An administrator has to correct them — no recording will play until they do.',
    retry: true,
  },
  credentials_unclear: {
    label: 'Telephony credentials were not accepted',
    admin: 'The TeleCMI App ID and secret are either not set up or not being accepted. Check them, then press Try playback now.',
    other: 'TeleCMI is not accepting this app’s telephony credentials. An administrator has to correct them — no recording will play until they do.',
    retry: true,
  },
  url_shape: {
    label: 'TeleCMI would not accept the request',
    admin: 'TeleCMI says a required parameter is missing from the playback request. Press Try playback now to see its exact answer.',
    other: 'This app is asking TeleCMI for the recording in a form it will not accept. An administrator needs to look at it.',
    retry: false,
  },
  blocked: {
    label: 'This app refused to fetch that address',
    admin: 'The stored recording address is not an HTTPS URL on an allowed host, so the fetch was stopped before it left the server. The allowed hosts are listed at the foot of the Recordings panel.',
    other: 'The stored recording address is not one this app is allowed to fetch. An administrator needs to look at it.',
    retry: false,
  },
  file_missing: {
    label: 'TeleCMI has no file for this call',
    admin: 'TeleCMI is not serving anything under that name. The call record itself is unaffected.',
    other: 'TeleCMI is not serving anything under that name. The call record itself is unaffected.',
    retry: false,
  },
  network: {
    label: 'The recording could not be reached',
    admin: 'The connection to the recording source failed. Check your connection and try again.',
    other: 'The connection to the recording source failed. Check your connection and try again.',
    retry: true,
  },
  browser: {
    label: 'This browser could not play it',
    admin: 'The recording downloaded but this browser could not decode it. Try again, or open it in a different browser.',
    other: 'The recording downloaded but this browser could not decode it. Try again, or open it in a different browser.',
    retry: true,
  },
  unknown: {
    label: 'Playback failed',
    admin: 'The server did not say why. Try again; if it keeps failing, run Try playback now on the Telephony page.',
    other: 'The server did not say why. Try again; if it keeps failing, tell an administrator.',
    retry: true,
  },
};

const KNOWN_FAULTS = new Set<string>(Object.keys(FAULT_COPY));

interface Fault {
  kind: FaultKind;
  /** The server's own sentence, verbatim. '' when we never reached it. */
  reason: string;
}

/**
 * HTTP status + error body → one class.
 *
 * Status first, because it is exact and ours. Prose second, because past the
 * proxy the only description of the fault is the one TeleCMI wrote. Nothing
 * here parses a URL or reads a credential — the body it is handed carries
 * neither (the proxy masks its own diagnostics and never echoes the outgoing
 * request).
 */
function classify(status: number, body: Record<string, unknown> | null, reason: string): FaultKind {
  // A machine-readable verdict wins outright, so the day the proxy starts
  // sending one this heuristic stops being consulted at all.
  const declared = typeof body?.fault === 'string' ? body.fault : '';
  if (KNOWN_FAULTS.has(declared)) return declared as FaultKind;

  if (status === 401) return 'signin';
  if (status === 410) return 'retention';
  if (status === 404) return /no recording/i.test(reason) ? 'not_recorded' : 'missing_row';

  // Everything below is a 502 — our server answered, the audio did not. The
  // patterns match the sentences built in src/lib/ct/recording-fetch.ts and the
  // proxy route; ORDER MATTERS, because the broader ones would otherwise
  // swallow the specific ones ("Parameter missing" and "host not allowed" both
  // contain words the file-missing pattern looks for).
  if (/parameter/i.test(reason)) return 'url_shape';
  if (/auth|credential|app id|\b407\b/i.test(reason)) {
    // The one thing the prose cannot settle: TeleCMI answers 407 both when the
    // request carried nothing and when it carried the wrong thing. Only the
    // proxy knows which, and only if it says so.
    if (body?.credentialed === false) return 'credentials_missing';
    if (body?.credentialed === true) return 'credentials_rejected';
    return 'credentials_unclear';
  }
  // Our own SSRF guard refusing the stored address, not a transport problem.
  if (/host not allowed|url is invalid|redirect target is invalid/i.test(reason)) return 'blocked';
  if (/did not answer|timed out|timeout|redirected too many|could not be fetched|network/i.test(reason)) {
    return 'network';
  }
  if (/cannot get|not found|no such|missing|\b404\b/i.test(reason)) return 'file_missing';
  return 'unknown';
}

/**
 * Ask the proxy why playback failed. Returns a class and a sentence, always —
 * an explainer that cannot explain is worse than none, so every branch,
 * including "the check itself failed", ends in something readable.
 */
async function readFailure(callId: string): Promise<Fault> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(proxyUrl(callId), {
      headers: PROBE_HEADERS,
      cache: 'no-store',
      credentials: 'same-origin',
      signal: ctl.signal,
    });
  } catch {
    return { kind: 'network', reason: '' };
  } finally {
    clearTimeout(timer);
  }

  if (res.ok || res.status === 206) {
    // The proxy is serving audio, so the fault is in the browser's playback of
    // it (an unsupported codec, or a transfer that died mid-stream) rather than
    // anywhere in our chain. Say that instead of inventing a server fault.
    return { kind: 'browser', reason: '' };
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch { /* not JSON — status alone still classifies it */ }
  const reason = typeof body?.error === 'string' ? body.error.trim() : '';
  const kind = classify(res.status, body, reason);
  // A refusal with no sentence at all still has to say something concrete, or
  // the box reads as "it failed, we have no idea" — which is where this whole
  // module started. The status goes in surrounded by words; a bare number is
  // exactly the non-answer this component exists to replace.
  if (!reason && kind === 'unknown') {
    return { kind, reason: `The recording server answered ${res.status} and gave no reason.` };
  }
  return { kind, reason };
}

/* ── Who is reading this? ──────────────────────────────────────────────────*/

/**
 * One /api/auth/me per page load, at most, and only ever after a configuration
 * fault has already been shown — a Guest 360 timeline can hold dozens of these
 * players and none of them should cost a request just by existing.
 *
 * Fails CLOSED: anything other than a confirmed admin is treated as not one, so
 * a failed lookup hides the link rather than dangling a locked page in front of
 * a GRE.
 */
let adminLookup: Promise<boolean> | null = null;
function isAdminOnce(): Promise<boolean> {
  if (!adminLookup) {
    adminLookup = fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        const role = (j as { user?: { role?: unknown } } | null)?.user?.role;
        return role === 'admin';
      })
      .catch(() => false);
  }
  return adminLookup;
}

export default function RecordingPlayer({
  callId,
  className = 'w-full max-w-md h-9',
}: {
  callId: string;
  /** Sizing for the <audio> element. The error state sizes itself. */
  className?: string;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [fault, setFault] = useState<Fault | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  // Bumped on retry to force a fresh <audio> element: re-using the old one
  // keeps its errored networkState and it will not attempt a reload.
  const [attempt, setAttempt] = useState(0);
  // An <audio> can fire error more than once for one failure; only the first
  // may start a fetch, or a dead recording turns into a request loop.
  const explaining = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const onError = useCallback(() => {
    if (explaining.current) return;
    explaining.current = true;
    setPhase('checking');
    void readFailure(callId).then(f => {
      if (!alive.current) return;
      setFault(f);
      setPhase('failed');
      explaining.current = false;
      // Only a configuration fault needs to know the reader's role, so only a
      // configuration fault pays for finding out.
      if (CONFIG_FAULTS.has(f.kind)) {
        void isAdminOnce().then(ok => { if (alive.current) setIsAdmin(ok); });
      }
    });
  }, [callId]);

  const retry = useCallback(() => {
    explaining.current = false;
    setFault(null);
    setPhase('idle');
    setAttempt(a => a + 1);
  }, []);

  if (phase === 'checking') {
    return (
      <p role="status" className="mt-1 inline-flex items-center gap-1.5 text-xs text-[#8B7355]">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        Checking why this recording will not play…
      </p>
    );
  }

  if (phase === 'failed' && fault) {
    const copy = FAULT_COPY[fault.kind];
    const action = isAdmin ? copy.admin : copy.other;
    const showFix = isAdmin && CONFIG_FAULTS.has(fault.kind);
    return (
      // Quiet on purpose — this sits inside a dense table row and on a guest
      // timeline. A tinted block with an icon reads as a status, not a crash.
      <div
        role="status"
        className="mt-1 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900"
      >
        <AlertCircle size={13} className="mt-px shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0 space-y-0.5">
          <p className="font-semibold break-words">{copy.label}</p>
          {/* The server's own words. Kept verbatim: it is the only description
              of the fault that came from the thing that actually failed. */}
          {fault.reason && <p className="break-words">{fault.reason}</p>}
          {action && <p className="break-words">{action}</p>}
          {(showFix || copy.retry) && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
              {showFix && (
                <a
                  href={TELEPHONY_HREF}
                  className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 hover:text-amber-950"
                >
                  <Settings size={11} aria-hidden="true" /> Open Telephony settings
                </a>
              )}
              {copy.retry && (
                <button
                  type="button"
                  onClick={retry}
                  className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 hover:text-amber-950"
                >
                  <RotateCw size={11} aria-hidden="true" /> Try again
                </button>
              )}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <audio
      key={attempt}
      controls
      preload="none"
      className={className}
      src={proxyUrl(callId)}
      onError={onError}
      aria-label="Call recording"
    >
      Your browser does not support audio playback.
    </audio>
  );
}
