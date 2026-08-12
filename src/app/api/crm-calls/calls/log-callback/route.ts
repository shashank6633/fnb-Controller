import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { normalizePhone } from '@/lib/ct/phone';
import { emitCt, pushRecentCt } from '@/lib/ct/bus';
import { redeemCallToken, DURATION_SOURCES } from '@/lib/ct/call-token';

/**
 * POST /api/crm-calls/calls/log-callback  (authed)
 *
 * Device-dialed outbound callback logging — the workaround for TeleCMI plans
 * with NO outbound package. The GRE taps "Call Back" (native dialer places the
 * call from their own SIM); the client times how long they were on the call and
 * posts it here. We synthesize an OUTBOUND ct_calls row (with the talk duration)
 * so the CALL shows up in the Call Log / Guest 360 / leaderboard exactly like a
 * real outbound CDR would — and, when a recovery is supplied, records the
 * callback attempt and advances the recovery. (The DURATION reaches the Call Log
 * and the Guest 360 timeline. It reaches no leaderboard or dashboard figure:
 * src/lib/ct/metrics.ts does not read duration_sec at all — measured, grep for
 * 'duration' in that file returns nothing.)
 *
 * EVERY NUMBER IN THIS BODY IS A CLAIM. The APK's return URL is unsigned, so a
 * typed ?cb=1&cb_duration=600&cb_src=calllog produces a fake ten-minute "exact"
 * call, and this endpoint is a POST any signed-in staff account can make. The
 * server's own fact is the CALL TOKEN (src/lib/ct/call-token.ts): minted when
 * Call Back was tapped, it fixes when dialling started on the SERVER clock, so
 * redemption can clamp the claimed talk time to the wall time elapsed since.
 *
 * WHAT SPENDING THE TOKEN DOES, AND WHAT IT DOES NOT. A token is single use, so
 * a replayed submit cannot come back VERIFIED twice. It does NOT stop a second
 * call ROW: this route logs the call whatever happens to the token (rejecting
 * would throw away a real GRE's work every time a mint fails — see the block
 * above the INSERT), so a replay outside the de-dupe window inserts a complete
 * new ct_calls row, marked duration_verified = 0. Read "single use" as "a claim
 * can only be vouched for once", never as "rows cannot be fabricated".
 *
 * WHAT BOUNDS ROW CREATION IS IN THIS FILE, AND IT IS NOT THE TOKEN: the 20s
 * de-dupe (now keyed on the SERVER's insert time, so a back-dated `at` cannot
 * step around it) and CALLBACK_BURST_MAX per CALLBACK_BURST_WINDOW_SEC per
 * agent. Both are stated below. What they cannot do is stop an unverified row
 * COUNTING as work: src/lib/ct/metrics.ts computes `handled` as
 * COUNT(*) over ct_calls WHERE status = 'answered' — no direction filter and no
 * duration_verified filter (measured: grep 'duration' in metrics.ts returns
 * nothing at all) — so every row logged here ranks a GRE on the leaderboard
 * whether or not the server could vouch for it. That filter belongs in
 * metrics.ts and is not in this file's gift.
 *
 * Body: {
 *   phone?, guest_id?, recovery_id?,   // at least one way to resolve the number
 *   duration_sec: number,              // talk time (client timer or manual)
 *   connected?: boolean,               // false = rang, no answer (default: duration>0)
 *   outcome?: string,                  // disposition: booking_made|enquiry|complaint|
 *                                      //   wrong_number|follow_up_needed|no_answer|no_action
 *   note?: string,
 *   source?: string,                   // CLAIMED provenance: call_log|approx|timer|manual
 *   call_token?: string,               // OPTIONAL id from POST .../calls/call-token.
 *                                      //   Absent is normal (iOS, desktop, pre-token
 *                                      //   APKs, offline) and logs the call unverified.
 *   at?: string                        // ISO end time; default now. Clamped into
 *                                      //   [now - MAX_BACKDATE_HOURS, now].
 * }
 * → 200 { ok, call_id, recovery_status, duration_sec, duration_verified,
 *         duration_capped_from?, duration_unverified_reason?, at_clamped_from? }
 *   401 not signed in · 400 bad body / unresolvable number · 404 unknown recovery
 *   429 burst ceiling hit — the client shows `error` and the GRE saves again
 */
export const dynamic = 'force-dynamic';

const OUTCOMES = new Set([
  'booking_made', 'enquiry', 'complaint', 'wrong_number',
  'follow_up_needed', 'no_answer', 'no_action',
]);
// Outcomes that mean the RIGHT person was reached & handled → recovery recovered.
// 'wrong_number' is NOT here — reaching a wrong number can't recover the guest;
// it resolves the recovery as 'unreachable' instead (handled below).
const REACHED = new Set(['booking_made', 'enquiry', 'complaint', 'no_action']);
const RESOLVED = new Set(['recovered', 'auto_resolved']); // terminal — never downgrade

/**
 * HOW FAR BACK `at` MAY PLACE A CALL, IN HOURS.
 *
 * `at` moves started_at/ended_at, and started_at is what every CRM metric keys
 * on (CALL_AT in src/lib/ct/metrics.ts is COALESCE(started_at, created_at)). An
 * unbounded past therefore lets one POST file a call into any closed reporting
 * period — last week's leaderboard, last month's SLA average — from a body
 * field. Logging a call you placed earlier in the shift is a real workflow;
 * back-filing one into a period that has already been read is not, and the two
 * arrive as the same request. 12h covers the longest shift with room over.
 *
 * No shipped client sends `at` at all today, so this clamps nothing in practice
 * — it closes a door before something walks through it.
 */
const MAX_BACKDATE_HOURS = 12;

/**
 * BURST CEILING: how many callbacks ONE agent may log in a rolling window.
 *
 * The 20s de-dupe below is keyed on (agent, number), so it stops a retry of the
 * same submit and nothing else — a script that walks a list of numbers is not a
 * retry, and every row it writes counts as a handled call on the leaderboard.
 * This is the ceiling on that, and it is deliberately set where no human can
 * reach it: logging a callback means picking an outcome and saving, so six in a
 * minute is already far past what the flow can produce by hand.
 *
 * IT IS A CEILING, NOT A FIX. It bounds a burst; it does not make an unverified
 * row worth less than a verified one — see the note in the header about
 * metrics.ts. And it must never be tightened to where a real GRE meets it: the
 * call has already been placed by the time this endpoint is asked to record it,
 * so a refusal here costs a guest interaction that genuinely happened.
 */
const CALLBACK_BURST_MAX = 6;
const CALLBACK_BURST_WINDOW_SEC = 60;

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not signed in' }, { status: 401 });

  let body: any = {};
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const db = getDb();

  // ── Resolve the phone + guest + (optional) recovery ─────────────────────
  const recoveryId = String(body.recovery_id || '').trim();
  let recovery: any = null;
  if (recoveryId) {
    recovery = db.prepare('SELECT * FROM ct_recoveries WHERE id = ?').get(recoveryId);
    if (!recovery) return Response.json({ error: 'recovery not found' }, { status: 404 });
  }

  let guestId = String(body.guest_id || '').trim() || (recovery?.guest_id ?? '');
  // A recovery callback ALWAYS logs against the recovery's own number — a stray
  // body.phone must never advance a recovery for a call to a different number.
  let phone = recovery ? normalizePhone(recovery.phone_e164) : '';
  if (!phone) phone = normalizePhone(body.phone);
  if (!phone && guestId) {
    const g = db.prepare('SELECT phone_e164 FROM ct_guests WHERE id = ?').get(guestId) as any;
    phone = normalizePhone(g?.phone_e164);
  }
  if (!phone) return Response.json({ error: 'Could not resolve a phone number to log (pass phone, guest_id, or recovery_id)' }, { status: 400 });
  // Back-link a guest by phone if we still don't have one.
  if (!guestId) {
    const g = db.prepare('SELECT id FROM ct_guests WHERE phone_e164 = ?').get(phone) as any;
    guestId = g?.id ?? '';
  }

  // ── Normalize the call facts ────────────────────────────────────────────
  // The claim, sanitized but NOT yet capped. The 6h cap is applied after
  // redemption (below) so cappedFrom reports what the client actually claimed
  // rather than a number this route already rewrote.
  let claimedDuration = Number(body.duration_sec);
  if (!Number.isFinite(claimedDuration) || claimedDuration < 0) claimedDuration = 0;
  claimedDuration = Math.round(claimedDuration);
  const outcome = OUTCOMES.has(String(body.outcome)) ? String(body.outcome) : '';
  const note = String(body.note || '').slice(0, 2000);
  // Where the duration came from AS THE CLIENT DESCRIBES IT: 'call_log' = the
  // Captain APK says it read the device call log, 'approx' = APK wall-time
  // fallback, 'timer' = web time-away timer, 'manual' = typed. All four arrive
  // in this body, so all four are claims — proof is duration_verified, which is
  // set only by a redeemed call token WHOSE BOUND HELD (see boundHeld below).
  // One shared list with the column comment in db.ts and with call-token.ts so
  // the three cannot drift.
  const source = (DURATION_SOURCES as readonly string[]).includes(String(body.source))
    ? String(body.source) : 'manual';
  // The server's own clock, taken once and used for everything that must not be
  // steerable from the body: the row's created_at, the de-dupe window, the burst
  // window, and the recovery's first_attempt_at.
  const serverNow = new Date();
  const serverNowIso = serverNow.toISOString();

  // WHEN THE CALL ENDED, AS THE CLIENT TELLS IT — clamped at BOTH ends, and
  // reported back when the clamp bites so nothing moves silently.
  //
  // FUTURE: a call cannot end in the future, and a future value is not harmless
  // — it lands in started_at, which every metrics window keys on.
  //
  // PAST: bounded to MAX_BACKDATE_HOURS (see the constant). Previously the past
  // was left entirely alone, and that was the whole exploit: created_at was
  // written from this value, so a single back-dated post fell outside the 20s
  // de-dupe window, and rows could then be minted in a loop — each one an
  // 'answered' call counting toward the GRE leaderboard. created_at is now
  // serverNowIso, so `at` no longer touches the de-dupe at all; this clamp
  // closes the second half, which is filing the call into a stale period.
  //
  // CLAMP, NEVER REJECT: the call was really placed, and refusing to log it is
  // the one outcome worse than logging it with a corrected timestamp.
  const requestedAt = body.at ? String(body.at) : '';
  let atClampedFrom = '';
  const endedAt = (() => {
    if (!requestedAt) return serverNowIso;
    const t = new Date(requestedAt);
    if (isNaN(t.getTime())) return serverNowIso;
    if (t.getTime() > serverNow.getTime()) { atClampedFrom = t.toISOString(); return serverNowIso; }
    const floorMs = serverNow.getTime() - MAX_BACKDATE_HOURS * 3600_000;
    if (t.getTime() < floorMs) {
      atClampedFrom = t.toISOString();
      return new Date(floorMs).toISOString();
    }
    return t.toISOString();
  })();

  // Idempotency: a retried submit (network flakiness) must not duplicate the
  // call row + recovery attempt. If this GRE already logged an outbound call to
  // this number in the last 20s, return that instead of inserting again.
  // Same window, same key — it also reads back the STORED duration so the
  // deduped reply has the same shape as a fresh one and a client that renders
  // duration_sec / duration_verified does not see undefined on a retry.
  //
  // THE WINDOW IS SERVER TIME ON BOTH SIDES. created_at is written from
  // serverNowIso (see the INSERT), never from body.at, so nothing the client
  // sends can move a row out of this window's reach. That is what makes the
  // guard a guard rather than a suggestion.
  const dupe = db.prepare(
    `SELECT id, duration_sec, duration_verified FROM ct_calls WHERE direction = 'outbound' AND agent_user = ? AND phone_e164 = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
  ).get(me.email, phone, new Date(serverNow.getTime() - 20_000).toISOString()) as
    { id: string; duration_sec: number; duration_verified: number } | undefined;
  if (dupe) {
    return Response.json({
      ok: true, call_id: dupe.id, recovery_status: recovery?.status ?? null, deduped: true,
      duration_sec: dupe.duration_sec, duration_verified: dupe.duration_verified,
    });
  }

  // ── Burst ceiling, per agent ────────────────────────────────────────────
  // The de-dupe above is per (agent, NUMBER): walking a list of numbers slips
  // past it, and every row written is an 'answered' call on the leaderboard.
  // This counts what THIS route has written for this agent recently — scoped by
  // duration_source != '', which only this route ever writes, so PBX CDRs and
  // click-to-call rows cannot push a GRE over the line.
  //
  // 429 with a plain sentence, because the client shows j.error verbatim in the
  // log sheet and leaves it open: the GRE reads it, waits, and saves again. The
  // token is untouched — redemption happens below this point — so the retry can
  // still come back verified.
  const burstSince = new Date(serverNow.getTime() - CALLBACK_BURST_WINDOW_SEC * 1000).toISOString();
  const burst = (db.prepare(
    `SELECT COUNT(*) AS n FROM ct_calls WHERE agent_user = ? AND duration_source != '' AND created_at >= ?`,
  ).get(me.email, burstSince) as { n: number } | undefined)?.n || 0;
  if (burst >= CALLBACK_BURST_MAX) {
    return Response.json({
      error: `Too many callbacks logged in the last minute (${burst}). Wait a moment and save again — the call itself is not affected.`,
    }, { status: 429 });
  }

  // ── Spend the call token and bound the claimed duration ─────────────────
  // AFTER the dedupe on purpose: when the dedupe fires no call row is written,
  // so the token must stay unredeemed and available for the real submit.
  //
  // The token is validated against the RESOLVED phone, not body.phone — this
  // route deliberately overrides body.phone with the recovery's own number
  // above, so checking body.phone would let a token minted for number X verify
  // a call written against number Y by attaching a recovery for Y.
  //
  // No token (iOS, desktop, a pre-token APK, or a mint that failed while the
  // GRE dialled anyway) comes back verified:false with the claim untouched.
  const callId = generateId();
  const redemption = redeemCallToken(db, {
    id: String(body.call_token || '').trim(),
    agentEmail: me.email,
    phone,
    claimedDurationSec: claimedDuration,
    callId,
  });
  const cappedFrom = redemption.verified ? redemption.cappedFrom : undefined;
  // VERIFIED MEANS THE BOUND HELD, NOT MERELY THAT A TOKEN WAS SPENT.
  //
  // A redemption whose clamp BIT is a redemption that caught the client out: the
  // talk time claimed was longer than the wall time since Call Back was tapped,
  // so what lands in duration_sec is the server's ceiling substituted for a
  // number that cannot be true. Marking that 1 would put the honesty badge on
  // the one duration we know the client got wrong. It is stored (a ceiling is
  // the most we can say), reported back with duration_capped_from, and left
  // UNVERIFIED — which is exactly what duration-trust.ts renders as '~'.
  //
  // Honest calls do not land here: the token is minted before the dial, so real
  // talk time is a subset of elapsed by construction, with CLOCK_SKEW_GRACE_SEC
  // on top for the handset's own rounding.
  const boundHeld = redemption.verified && cappedFrom === undefined;
  const durationVerified = boundHeld ? 1 : 0;
  const unverifiedReason: string | undefined = redemption.verified
    ? (boundHeld ? undefined : 'bound_exceeded')
    : redemption.reason;

  // WHAT WE RECORD WHEN THE CLIENT CLAIMS 'call_log' WITH NO VALID TOKEN.
  // We keep the claim verbatim — duration_sec as posted, duration_source as
  // posted — and set duration_verified = 0. Three alternatives were considered
  // and rejected:
  //   REJECT THE REQUEST would throw away a real GRE's work every time a token
  //     round trip fails, which is routine: iOS and desktop mint nothing, the
  //     shipped APK (1.3.0) predates tokens entirely, and an offline mint is
  //     expected. Losing a logged guest call to protect a statistic is a worse
  //     bug than the one this closes.
  //   ZERO THE DURATION would replace a probably-true number with a certainly
  //     false one, and would make honest iOS logging useless.
  //   REWRITE source TO 'manual' would destroy the audit trail — that a client
  //     claimed the call log without a token is exactly what an investigator
  //     wants to see, and it is only visible if we store what was claimed.
  // duration_verified is the one field that must never overstate, and it is 0
  // here. Any surface that says "exact" MUST read duration_verified; reading
  // duration_source would re-open the hole this closes.
  const duration = Math.min(redemption.durationSec, 6 * 60 * 60); // 6h sanity cap, unchanged
  const connected = body.connected === undefined ? duration > 0 : !!body.connected;
  const startedAt = new Date(new Date(endedAt).getTime() - duration * 1000).toISOString();
  const status = connected ? 'answered' : 'missed';

  // ── Synthesize the outbound call row (agent = the GRE who dialed) ────────
  db.prepare(`
    INSERT INTO ct_calls
      (id, telecmi_call_id, guest_id, phone_e164, direction, status, agent_user, queue,
       started_at, answered_at, ended_at, duration_sec, recording_url, raw_payload,
       disposition, disposition_note, created_at, duration_source, duration_verified)
    VALUES (?, NULL, ?, ?, 'outbound', ?, ?, '', ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)
  `).run(
    callId, guestId || null, phone, status, me.email,
    startedAt, connected ? startedAt : null, endedAt, duration,
    // raw_payload keeps everything it carried before. The extra keys are a
    // forensic trail the queryable columns cannot hold: WHY a duration was not
    // verified, what was claimed before the clamp bit, and an `at` this route
    // had to move.
    JSON.stringify({
      source: 'device_manual', duration_source: source, by: me.email,
      duration_verified: durationVerified,
      ...(cappedFrom !== undefined ? { duration_capped_from: cappedFrom } : {}),
      ...(unverifiedReason ? { duration_unverified_reason: unverifiedReason } : {}),
      ...(atClampedFrom ? { at_clamped_from: atClampedFrom } : {}),
    }),
    // created_at is the SERVER's insert time, deliberately not endedAt. It is
    // the key the de-dupe and the burst ceiling above both read, so a client
    // that could move it could step around both of them — which is precisely
    // what a back-dated `at` used to do. started_at/ended_at still carry the
    // client's (now clamped) account of when the call happened, and every CRM
    // metric reads started_at first, so nothing downstream changes for an
    // ordinary save where the two are milliseconds apart.
    outcome, note, serverNowIso, source, durationVerified,
  );

  // ── Advance the recovery (if this was a recovery callback) ──────────────
  let recoveryStatus: string | null = null;
  if (recovery) {
    let attempts: any[] = [];
    try { const a = JSON.parse(recovery.attempts || '[]'); if (Array.isArray(a)) attempts = a; } catch { /* keep [] */ }
    // duration_verified travels with the attempt's own copy of duration_sec +
    // source. This blob is the SECOND place the number is stored; leaving it
    // unlabelled would put an unverifiable duration back in the database the
    // moment anyone renders the attempts timeline (today it renders only
    // method/outcome/at/by, so nothing displays it yet).
    attempts.push({
      at: endedAt, by: me.email, method: 'callback',
      outcome: outcome || (connected ? 'answered' : 'no_answer'),
      duration_sec: duration, connected, source, duration_verified: durationVerified,
    });
    const now = new Date().toISOString();

    if (RESOLVED.has(recovery.status)) {
      // Already closed by another flow (attributeBooking / answered-inbound
      // auto-resolve). Record the attempt for history but NEVER downgrade or
      // overwrite a resolved recovery (would resurrect closed work + inflate
      // the pending badge). Mirrors the guard in recoveries/[id] PUT.
      db.prepare(`UPDATE ct_recoveries SET attempts = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(attempts), now, recovery.id);
      recoveryStatus = recovery.status;
    } else {
      // Right person reached & dispositioned → recovered; wrong number →
      // unreachable (can't recover the guest on this number); otherwise a
      // genuine attempt was made → attempting.
      //
      // A RECOVERY NEEDS A CONVERSATION, NOT A CHECKBOX. `connected` is a body
      // field, and `outcome` is a body field, so { connected: true, outcome:
      // 'no_action' } used to close a recovery outright — terminal, stamped
      // recovered_at, off the pending badge — with duration_sec = 0, i.e. with
      // no call having demonstrably happened at all. Requiring talk time makes
      // the terminal transition need something the flow can only produce by
      // actually being on a call. A zero-second connection is not a recovered
      // guest under any reading, so nothing legitimate is lost: it lands on
      // 'attempting', stays in the queue, and the next real call closes it.
      const nextStatus = outcome === 'wrong_number' ? 'unreachable'
        : (connected && duration > 0 && REACHED.has(outcome)) ? 'recovered'
        : 'attempting';
      const terminal = nextStatus === 'recovered' || nextStatus === 'unreachable';
      // first_attempt_at IS THE SLA CLOCK, SO IT IS THE SERVER'S CLOCK.
      // metrics.ts averages (first_attempt_at - missed_at) into avg_callback_min
      // — the callback-SLA figure on the dashboard and the GRE leaderboard. It
      // used to be stamped from `at`, a body field, so a GRE could post a
      // back-dated end time and have the system record that they answered a
      // missed call faster than they did. `now` is when this attempt was
      // RECORDED, which is the latest moment it can honestly be pinned to and
      // the only one nobody can move. The call's own timeline is unaffected:
      // started_at/ended_at still carry the client's account, and the attempts
      // blob below keeps `at: endedAt`.
      db.prepare(`
        UPDATE ct_recoveries SET
          attempts = ?, first_attempt_at = COALESCE(first_attempt_at, ?),
          status = ?, recovery_call_id = COALESCE(recovery_call_id, ?),
          recovered_at = CASE WHEN ? = 'recovered' THEN ? ELSE recovered_at END,
          resolution_note = CASE WHEN ? THEN ? ELSE resolution_note END,
          updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify(attempts), now,
        nextStatus, callId,
        nextStatus, now,
        terminal ? 1 : 0, (outcome || 'Reached on callback'),
        now, recovery.id,
      );
      recoveryStatus = nextStatus;
    }

    // Refresh bell/queue badges.
    try {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ct_recoveries WHERE status IN ('pending','attempting')`).get() as any)?.n || 0;
      const evt = { type: 'recovery_update' as const, phone, recoveryCount: n, at: now };
      emitCt(evt); pushRecentCt(evt);
    } catch { /* non-fatal */ }
  }

  // duration_sec is echoed because it is not always what was posted: when a
  // token verified the call the server may have clamped it. The client must
  // show the GRE the STORED number, and say so when duration_capped_from is
  // present, rather than leaving a different figure on screen than in the log.
  return Response.json({
    ok: true, call_id: callId, recovery_status: recoveryStatus,
    duration_sec: duration,
    duration_verified: durationVerified,
    ...(cappedFrom !== undefined ? { duration_capped_from: cappedFrom } : {}),
    ...(unverifiedReason ? { duration_unverified_reason: unverifiedReason } : {}),
    // Only present when this route moved the end time the caller asked for.
    // No shipped client sends `at`, so no shipped client will ever see it —
    // it is here so a script that does send one is told, rather than having
    // its timestamp silently rewritten.
    ...(atClampedFrom ? { at_clamped_from: atClampedFrom } : {}),
  });
}
