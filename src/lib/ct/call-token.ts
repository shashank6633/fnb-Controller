/**
 * Call-to-Table — THE WALL-CLOCK RECEIPT FOR AN OUTBOUND CALL BACK.
 *
 * THE PROBLEM THIS SOLVES
 * ───────────────────────
 * The TeleCMI plan has no outbound package, so a Call Back is placed from the
 * GRE's own handset and the talk time comes back to us from the CLIENT. On
 * Android the Captain APK reads the exact duration out of the device call log
 * and deep-links home with it in a plain query string; everywhere else the
 * number is a wall-clock estimate or typed by hand.
 *
 * Every one of those numbers is a claim in a request body. The APK's return URL
 * carries no signature, so `?cb=1&cb_duration=600&cb_src=calllog` typed into an
 * address bar produces a ten-minute "exact" call, and a curl against the log
 * endpoint does the same without leaving the terminal. Locking the input box in
 * the log sheet closes neither.
 *
 * WHAT THIS MODULE DOES
 * ─────────────────────
 * It gives the server one fact of its own to reason from: WHEN the GRE started
 * dialling, measured on the server clock. The client asks for a token the
 * moment Call Back is tapped, carries the id through the round trip, and hands
 * it back with the log. The accepted talk time is then clamped to the wall time
 * that has elapsed since the token was minted — you cannot have talked for
 * longer than you have been dialling. That clamp is the whole anti-inflation
 * mechanism, and it needs no shared secret and no APK change.
 *
 * WHY NOT SIGN THE APK'S RETURN URL. That needs a key shipped inside the APK,
 * and an APK is a zip file anyone can open. A server-issued, server-timed,
 * single-use row is not extractable, because there is nothing to extract.
 *
 * SINGLE USE, AND WHAT THAT IS AND IS NOT WORTH. A token is spent on redemption,
 * so one token can vouch for exactly one call: a replayed submit comes back
 * unverified. It does NOT stop the replay from writing a call ROW. log-callback
 * logs the call whatever happens to the token — that is a deliberate choice
 * documented there, because refusing would discard a real GRE's work every time
 * a mint fails — so a replay produces a complete second ct_calls row with
 * duration_verified = 0. Anyone who reads "single use" as "rows cannot be
 * fabricated" has read it backwards.
 *
 * AND ROWS ARE WHAT MATTER. The GRE leaderboard sorts on `handled`, which counts
 * ROWS and ignores their duration entirely (measured: grep 'duration' in
 * src/lib/ct/metrics.ts returns nothing at all), so fabricated CALLS — not
 * fabricated minutes — are what move a ranking. Nothing in this module can stop
 * that. What can: the de-dupe and burst ceiling in log-callback, which bound how
 * fast rows appear, and a `handled` that declines to count what the server could
 * not verify, which lives in metrics.ts and does not exist yet.
 *
 * WHAT IT HONESTLY DOES NOT DO
 * ────────────────────────────
 * The clamp bounds a claim by elapsed wall time; it cannot tell a 25-minute
 * call from 25 minutes of doing something else with the tab open. A GRE who
 * taps Call Back, walks away, and comes back later still gets a large estimate
 * accepted, because the wall clock really did elapse. This kills instant
 * forgery — the typed URL, the curl, the scripted burst — not patience. Say
 * that plainly rather than letting anyone believe estimates are now bounded.
 *
 * FAILURE MUST NEVER BLOCK A CALL
 * ───────────────────────────────
 * If a token cannot be minted (offline, server down, bad input) the GRE still
 * dials and the call is still logged — it simply is not called verified. The
 * caller enforces that, not this file: issueCallToken THROWS on unusable input
 * so a real bug is visible, and the route is expected to catch it and answer
 * non-2xx while the client dials regardless. Losing a guest call to protect a
 * statistic would be a far worse bug than the one this closes.
 *
 * SERVER ONLY. It takes a better-sqlite3 handle and writes to the database. A
 * "use client" component must never import it — consume what the API returns.
 */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import { normalizePhone } from '@/lib/ct/phone';
import { norm10 } from '@/lib/ct/guest-unify';

/**
 * The four words the callback log path writes into ct_calls.duration_source.
 * A CLAIM about where a number came from, never proof — all four arrive in a
 * request body. Proof is ct_calls.duration_verified, which only this module's
 * redemption can set. Exported so the route and this file cannot drift.
 */
export const DURATION_SOURCES = ['call_log', 'approx', 'timer', 'manual'] as const;
export type DurationSource = (typeof DURATION_SOURCES)[number];

/**
 * CLOCK-SKEW GRACE, IN SECONDS.
 *
 * The bound is honest by construction: the token is minted BEFORE the dialer
 * opens and redeemed AFTER the call ends, both timestamps taken from the server
 * clock, so the true talk time is always a strict subset of the elapsed window.
 * One clock, no drift to correct for.
 *
 * The grace exists for the ONE quantity measured elsewhere — the duration
 * itself, which the handset reports. Android's call log stores whole seconds
 * and can round a call up by up to 1s, and a handset clock running a few parts
 * per ten thousand fast adds a second or two more over a long conversation.
 * Five seconds covers both with room to spare while being far too small to
 * inflate anything a manager would read: five seconds cannot turn a short call
 * into a long one.
 *
 * It is deliberately NOT a tuning knob for the tab-away case in the header
 * note. Nothing here can bound that, and raising this number would not help.
 */
export const CLOCK_SKEW_GRACE_SEC = 5;

/**
 * How long a token stays redeemable, and the age at which the prune drops it.
 * ONE constant for both on purpose: a token the prune would have deleted must
 * not still verify a call just because no one has tapped Call Back since.
 *
 * 24h is generous — the real round trip is seconds — but a token older than a
 * day proves nothing useful anyway: the clamp it would apply (86,400s) is far
 * above the log route's own 6h sanity cap, so it would bound nothing.
 */
export const TOKEN_TTL_HOURS = 24;

/**
 * MINT CEILING: how many tokens ONE agent may ask for in a rolling window.
 *
 * The TTL prune bounds this table in TIME and says nothing about SIZE. Minting
 * is one INSERT per authenticated POST with no other cost, so a loop from a
 * signed-in session could put a day's worth of rows in here before the prune
 * ever looks — not a forgery (a token proves nothing on its own) but an
 * unbounded write from one caller, which is a denial-of-service shape.
 *
 * 30 a minute is far above the human flow — a token is minted when a thumb hits
 * Call Back — and far below anything that grows the table. Refusing is safe by
 * design: the client dials regardless and logs the call unverified, which is the
 * same outcome as being offline. The ONE thing this must never do is get tight
 * enough to meet a real GRE, because an unverified call is a small loss and a
 * missed call back is a real one.
 */
export const MINT_BURST_MAX = 30;
export const MINT_BURST_WINDOW_SEC = 60;

/** Thrown by issueCallToken when MINT_BURST_MAX is hit. Carries a code so the
 *  route can answer 429 rather than 500 — a distinction the client does not act
 *  on (it dials either way) but a log reader very much does. */
export class CallTokenRateLimited extends Error {
  readonly code = 'rate_limited' as const;
  constructor(public readonly recentCount: number) {
    super(`issueCallToken: ${recentCount} tokens already minted in the last ${MINT_BURST_WINDOW_SEC}s`);
    this.name = 'CallTokenRateLimited';
  }
}

/** Why a redemption did not verify. Never thrown — always returned, because a
 *  call must still be logged when its token is bad. */
export type CallTokenFailure =
  | 'no_token'         // the client sent none (iOS, desktop, offline, old APK)
  | 'not_found'        // unknown id, or the prune already dropped it
  | 'already_redeemed' // single use — a replay lands here
  | 'wrong_agent'      // minted for a different signed-in user
  | 'wrong_phone'      // minted for a different number
  | 'expired'          // older than TOKEN_TTL_HOURS
  | 'bad_issued_at';   // unparseable timestamp — cannot compute elapsed, so cannot verify

/**
 * The outcome of a redemption.
 *
 * durationSec is ALWAYS the number to write to ct_calls.duration_sec — clamped
 * when verified, and the caller's untouched claim when not. Read `verified`
 * for ct_calls.duration_verified; never infer it from cappedFrom.
 */
export type CallTokenRedemption =
  | { verified: true; durationSec: number; cappedFrom?: number }
  | { verified: false; durationSec: number; reason: CallTokenFailure };

export interface IssueCallTokenOpts {
  /** The SIGNED-IN app user's email. Server-side identity, never from a body. */
  agentEmail: string;
  /** The number about to be dialled, any format — normalized here. */
  phone: string;
  /** Optional recovery this call back belongs to. Recorded for tracing only:
   *  the redeem check does not use it, because the log route resolves its own
   *  recovery and re-deriving it here would give two answers to one question. */
  recoveryId?: string;
}

export interface RedeemCallTokenOpts {
  /** Token id from the client. '' / undefined is normal and returns 'no_token'. */
  id: string;
  /** The SIGNED-IN app user's email — must match who the token was minted for. */
  agentEmail: string;
  /** The number the call is being logged AGAINST. See the warning below. */
  phone: string;
  /** The duration the client claims, in seconds. */
  claimedDurationSec: number;
  /** The ct_calls row this redemption belongs to, recorded on the token. */
  callId: string;
}

/** ISO-8601 UTC with a Z, e.g. 2026-08-11T09:15:04.000Z.
 *
 *  This is the ONLY writer of ct_call_tokens.issued_at, and the column has no
 *  SQL default, so every value in it has this exact fixed-width shape. That is
 *  what makes the prune's plain string comparison correct — mixing in SQLite's
 *  datetime('now') form ("2026-08-11 09:15:04", space, no Z) would silently
 *  break the ordering, so do not add one. */
function nowIso(): string {
  return new Date().toISOString();
}

/** A non-negative whole number of seconds. Garbage (NaN, Infinity, negatives,
 *  fractions, strings) collapses to something safe rather than poisoning the
 *  arithmetic downstream. */
function sanitizeSeconds(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.round(v);
}

/**
 * Mint a wall-clock receipt for a call back the GRE is about to place.
 *
 * Call this BEFORE firing the dial intent, so issued_at genuinely predates the
 * call. Called after, it would bound nothing.
 *
 * Prunes tokens older than TOKEN_TTL_HOURS on the way past — one bounded DELETE
 * over an indexed column. This table gains a row per Call Back tap and holds
 * nothing of record (the CALL is the record), so it must not grow forever and
 * does not deserve a sweeper of its own. The prune bounds it in TIME;
 * MINT_BURST_MAX bounds it in SIZE, since a caller in a loop would otherwise
 * outrun a 24h prune easily.
 *
 * THROWS on an empty agentEmail or a phone that will not normalize. Both mean
 * there is nothing to bind the token to, and a token bound to nothing is a lie
 * that would verify anything. Also throws CallTokenRateLimited past the burst
 * ceiling. The route must catch all three, answer non-2xx, and let the client
 * dial anyway.
 */
export function issueCallToken(
  db: Database.Database,
  opts: IssueCallTokenOpts,
): { id: string } {
  const agentEmail = String(opts.agentEmail || '').trim();
  if (!agentEmail) throw new Error('issueCallToken: agentEmail is required');

  const phone = normalizePhone(opts.phone);
  if (!phone) throw new Error('issueCallToken: could not normalize a dialable phone number');

  const recoveryId = String(opts.recoveryId || '').trim();
  const id = generateId();
  const issuedAt = nowIso();
  const cutoff = new Date(Date.now() - TOKEN_TTL_HOURS * 3600_000).toISOString();

  // Prune → count → insert, in ONE immediate transaction. The count has to sit
  // inside it or two simultaneous mints could both read a stale total; and it
  // has to run AFTER the prune so expired rows never count toward a live
  // ceiling. The window is a plain string comparison over the same fixed-width
  // ISO shape nowIso() writes, on the issued_at index.
  const burstSince = new Date(Date.now() - MINT_BURST_WINDOW_SEC * 1000).toISOString();
  const run = db.transaction(() => {
    db.prepare('DELETE FROM ct_call_tokens WHERE issued_at < ?').run(cutoff);
    const recent = (db.prepare(
      'SELECT COUNT(*) AS n FROM ct_call_tokens WHERE agent_email = ? AND issued_at >= ?',
    ).get(agentEmail, burstSince) as { n: number } | undefined)?.n || 0;
    if (recent >= MINT_BURST_MAX) throw new CallTokenRateLimited(recent);
    db.prepare(`
      INSERT INTO ct_call_tokens (id, agent_email, phone_e164, recovery_id, issued_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, agentEmail, phone, recoveryId, issuedAt);
  });
  run.immediate();

  return { id };
}

/**
 * Spend a token and bound the duration it vouches for.
 *
 * VERIFIED REQUIRES ALL OF: the token exists; it has not been redeemed; it was
 * minted for THIS signed-in agent; it was minted for THIS number; and it is not
 * older than TOKEN_TTL_HOURS. Any miss returns verified:false with the CLAIMED
 * duration untouched and a reason — the call still gets logged, it is simply
 * not called verified anywhere.
 *
 * THE CLAMP: durationSec = min(claim, elapsed + CLOCK_SKEW_GRACE_SEC), where
 * elapsed is the server-clock seconds since the token was minted. cappedFrom
 * carries the original claim, and is set ONLY when the clamp actually bit — an
 * honest 60s call five minutes after dialling comes back untouched with no
 * cappedFrom, so a caller can tell "bounded and fine" from "bounded and cut".
 *
 * PHONE MATCHING is on the last 10 digits (norm10, the same key the rest of the
 * CRM joins guests on), so +91 / leading-0 / bare forms of one number agree.
 *
 * WARNING FOR THE CALLER — VALIDATE AGAINST THE RESOLVED PHONE. The log route
 * deliberately overrides body.phone with the recovery's own number when a
 * recovery_id is present. Pass THAT resolved number here. Passing the raw
 * body.phone would let a token minted for number X verify a call written
 * against number Y by attaching a recovery for Y.
 *
 * A FAILED CHECK DOES NOT BURN THE TOKEN. Only a redemption that passes every
 * check marks it spent, so a stray wrong-agent attempt cannot lock the real
 * owner out of verifying their own call.
 *
 * CONCURRENCY: the read and the spend run in one IMMEDIATE transaction, and the
 * spend itself is a conditional UPDATE (... WHERE id = ? AND redeemed_at = '')
 * whose changes count is checked. Either alone would do; both means two
 * simultaneous submits can never both come back verified, whichever way the
 * database interleaves them.
 */
export function redeemCallToken(
  db: Database.Database,
  opts: RedeemCallTokenOpts,
): CallTokenRedemption {
  const claimed = sanitizeSeconds(opts.claimedDurationSec);
  const id = String(opts.id || '').trim();
  if (!id) return { verified: false, durationSec: claimed, reason: 'no_token' };

  const agentEmail = String(opts.agentEmail || '').trim();
  const wantKey = norm10(normalizePhone(opts.phone));
  const callId = String(opts.callId || '').trim();

  const spend = db.transaction((): CallTokenRedemption => {
    const row = db.prepare(
      'SELECT id, agent_email, phone_e164, issued_at, redeemed_at FROM ct_call_tokens WHERE id = ?',
    ).get(id) as
      | { id: string; agent_email: string; phone_e164: string; issued_at: string; redeemed_at: string }
      | undefined;

    if (!row) return { verified: false, durationSec: claimed, reason: 'not_found' };
    if (row.redeemed_at) return { verified: false, durationSec: claimed, reason: 'already_redeemed' };
    if (!agentEmail || row.agent_email !== agentEmail) {
      return { verified: false, durationSec: claimed, reason: 'wrong_agent' };
    }
    // Both sides through norm10 so a token minted for '+919876543210' matches a
    // call logged against '9876543210'. An unusable number on either side
    // yields '' and must NOT be treated as a match.
    const haveKey = norm10(row.phone_e164);
    if (!wantKey || !haveKey || wantKey !== haveKey) {
      return { verified: false, durationSec: claimed, reason: 'wrong_phone' };
    }

    const issuedMs = Date.parse(row.issued_at);
    if (!Number.isFinite(issuedMs)) {
      return { verified: false, durationSec: claimed, reason: 'bad_issued_at' };
    }
    // Negative elapsed means the server clock moved backwards between minting
    // and redeeming. Floor at 0 rather than trusting it: the grace alone then
    // becomes the ceiling, which is the conservative reading.
    const elapsedSec = Math.max(0, Math.floor((Date.now() - issuedMs) / 1000));
    if (elapsedSec > TOKEN_TTL_HOURS * 3600) {
      return { verified: false, durationSec: claimed, reason: 'expired' };
    }

    const ceiling = elapsedSec + CLOCK_SKEW_GRACE_SEC;
    const capped = claimed > ceiling;
    const durationSec = capped ? ceiling : claimed;

    const res = db.prepare(
      `UPDATE ct_call_tokens SET redeemed_at = ?, redeemed_call_id = ? WHERE id = ? AND redeemed_at = ''`,
    ).run(nowIso(), callId, id);
    // Lost the race to a concurrent submit that spent it first. Same outcome as
    // a replay, and the same word for it.
    if (res.changes !== 1) {
      return { verified: false, durationSec: claimed, reason: 'already_redeemed' };
    }

    return capped
      ? { verified: true, durationSec, cappedFrom: claimed }
      : { verified: true, durationSec };
  });

  return spend.immediate();
}
