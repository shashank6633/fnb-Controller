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
 */

import { useCallback, useRef, useState } from 'react';
import { AlertCircle, Loader2, RotateCw } from 'lucide-react';

type Phase = 'idle' | 'checking' | 'failed';

/** Range: bytes=0-0 asks the proxy for one byte — enough to learn the verdict
 *  without pulling audio we are not going to play. Every error path answers
 *  JSON regardless of the Range header, so nothing is lost on failure. */
const PROBE_HEADERS: HeadersInit = { Range: 'bytes=0-0' };

function proxyUrl(callId: string): string {
  return `/api/telecmi/recording/${encodeURIComponent(callId)}`;
}

/**
 * Ask the proxy why playback failed. Returns one sentence, always — an
 * explainer that cannot explain is worse than none, so every branch, including
 * "the check itself failed", ends in something readable.
 */
async function readFailureReason(callId: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(proxyUrl(callId), { headers: PROBE_HEADERS, cache: 'no-store' });
  } catch {
    return 'The recording could not be reached — check your connection and try again.';
  }

  if (res.ok || res.status === 206) {
    // The proxy is serving audio, so the fault is in the browser's playback of
    // it (an unsupported codec, or a transfer that died mid-stream) rather than
    // anywhere in our chain. Say that instead of inventing a server fault.
    return 'The recording is reachable but this browser could not play it. Try again, or open it in a different browser.';
  }

  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON — fall through */ }
  const msg =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error.trim()
      : '';
  if (msg) return msg;
  return `The recording could not be played (server answered ${res.status}).`;
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
  const [reason, setReason] = useState('');
  // Bumped on retry to force a fresh <audio> element: re-using the old one
  // keeps its errored networkState and it will not attempt a reload.
  const [attempt, setAttempt] = useState(0);
  // An <audio> can fire error more than once for one failure; only the first
  // may start a fetch, or a dead recording turns into a request loop.
  const explaining = useRef(false);

  const onError = useCallback(() => {
    if (explaining.current) return;
    explaining.current = true;
    setPhase('checking');
    void readFailureReason(callId).then(text => {
      setReason(text);
      setPhase('failed');
      explaining.current = false;
    });
  }, [callId]);

  const retry = useCallback(() => {
    explaining.current = false;
    setReason('');
    setPhase('idle');
    setAttempt(a => a + 1);
  }, []);

  if (phase === 'checking') {
    return (
      <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-[#8B7355]">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        Checking why this recording will not play…
      </p>
    );
  }

  if (phase === 'failed') {
    return (
      // Quiet on purpose — this sits inside a dense table row. A tinted line
      // with an icon reads as a status, not as a crash.
      <div
        role="status"
        className="mt-1 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900"
      >
        <AlertCircle size={13} className="mt-px shrink-0 text-amber-600" aria-hidden="true" />
        <span className="min-w-0 break-words">
          {reason}{' '}
          <button
            type="button"
            onClick={retry}
            className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 hover:text-amber-950"
          >
            <RotateCw size={11} aria-hidden="true" /> Try again
          </button>
        </span>
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
    >
      Your browser does not support audio playback.
    </audio>
  );
}
