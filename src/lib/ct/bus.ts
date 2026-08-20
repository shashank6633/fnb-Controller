/**
 * In-process pub/sub for the Call-to-Table CRM (screen-pop + live feed).
 *
 * Mirrors src/lib/kds-bus.ts: globalThis EventEmitter singleton so it survives
 * dev HMR and is shared across route modules in the single Node process.
 * Single-instance only (fine on the one Lightsail box); a multi-instance
 * deploy would swap this for Redis pub/sub behind the same API.
 */
import { EventEmitter } from 'events';

declare global {
  // eslint-disable-next-line no-var
  var __fnbCtBus__: EventEmitter | undefined;
}

const CHANNEL = 'ct';

export interface CtEvent {
  /**
   * 'ownership' is NOT a telephony event — it says the OWNER or the LOCK on an
   * existing call changed: somebody claimed it, a manager took it over, or the
   * lock lapsed because a disposition was saved.
   *
   * It exists because a claim was previously broadcast as 'answered', and the
   * pop claims at CHIP time — i.e. after the call has already ended. The
   * supervisor wallboard prints one feed line per 'answered', so a claim four
   * minutes post-hangup printed "Call answered — Ravi K" BELOW "Call ended",
   * and re-ran the board's ringing filter for a call that was long over.
   *
   * A consumer that does not know this type must ignore it rather than fall
   * through to a default label — an unknown event is not an answered call.
   */
  type: 'incoming_call' | 'answered' | 'call_ended' | 'recovery_update' | 'ownership';
  /** ct_calls.id when known */
  callId?: string;
  /** TeleCMI call id (dedupe key for the client) */
  telecmiCallId?: string;
  phone?: string;
  /** Snapshot of the matched guest (null/undefined = unknown caller) */
  guest?: {
    id: string; name: string; tags: string[];
    total_calls?: number; total_bookings?: number; last_visit_at?: string | null;
    badge?: string;
  } | null;
  /** Raw TeleCMI agent id (as reported on the event/CDR). */
  agent?: string;
  /** Resolved staff display name for `agent` (via agent_map), for the live feed. */
  agentName?: string;
  /**
   * DID THIS `call_ended` END THE CALL, or only one leg of it?
   *
   * The venue rings a HUNT GROUP: one inbound call rings agent after agent and
   * TeleCMI files EVERY leg as its own CDR, so a missed CDR normally means the
   * call moved to the next extension — not that it is over. Ingest used to emit
   * `call_ended` for all of them and every screen flipped to "CALL ENDED — LOG
   * OUTCOME" while the call was still ringing elsewhere.
   *
   *   'missed_leg' — a leg stopped ringing and the call MAY STILL BE ALIVE
   *                  (evidence: another leg of the same conversation_id is up).
   *                  A consumer must NOT announce the end or ask for a
   *                  disposition on this; wait for a 'final'.
   *   'final'      — the call is over. Today's behaviour.
   *
   * Only set on a `call_ended` raised from a CDR (see missedLegFinality() in
   * ./ingest.ts). ABSENT MEANS 'final': every pre-existing emitter and every
   * buffered event from before this field must keep behaving exactly as it did.
   */
  leg?: 'missed_leg' | 'final';
  /**
   * WHICH AGENT LET IT PASS on a missed leg ("Missed by Agent PUSHPA B" in
   * TeleCMI's own log). Deliberately NOT agentName: that field means "answered
   * by", and a missed call was answered by nobody. Resolved through
   * resolveAgentLabel, so an UNMAPPED id renders as the raw id — never blank.
   */
  missedByName?: string;
  /**
   * WHICH AGENT AN INCOMING CALL IS RINGING FOR, on `incoming_call` — same
   * resolution, raw id when unmapped. Absent when the live payload named no
   * agent: the ringing extension is reported, never guessed.
   */
  ringingAgentName?: string;
  /**
   * OWNERSHIP of an answered call — the app user (email) who holds the write-up,
   * '' / undefined when nobody does. Distinct from `agent`: that is the TELEPHONY
   * agent id, which for an unmapped agent resolves to no app user at all, so the
   * owner is whoever CLAIMED the call first (see src/lib/ct/call-owner.ts).
   * Every browser gets this on the broadcast and decides for itself: the owner
   * keeps the pop, everyone else collapses to the read-only strip. That is
   * presentation only — the lock that actually matters is the server check in
   * callWriteBlock(). Never treat "ownerEmail is set" as "locked": the lock
   * lapses on disposition/expiry while the owner is kept as the audit trail.
   */
  ownerEmail?: string;
  /** Resolved display name for `ownerEmail`, so the strip names a person and
   *  not an address. Falls back to the email when the user is unknown. */
  ownerName?: string;
  /**
   * IS A LOCK IN FORCE RIGHT NOW — the server's own answer, so no client has to
   * infer one. This is the field the strip must render on.
   *
   * The pop used to test `ownerEmail` instead, which is a different question:
   * owner_email is the AUDIT RECORD of the claim and deliberately survives the
   * lock lapsing. Reading it as "locked" meant the strip never lifted — the
   * owner saved a disposition, or the write-up window expired, the server opened
   * the call to everyone, and every other browser still showed "X is writing up
   * this call" with no chips, indefinitely.
   *
   * Viewer-INDEPENDENT on purpose: this is a broadcast, so it cannot carry a
   * per-person "may I write". A client combines it with facts it already holds —
   * am I the owner, am I management (see canManageCalls on the live route) — to
   * decide its own chips. The authority is still the server check on the write.
   */
  locked?: boolean;
  /** When the lock lifts, already formatted in IST (e.g. "7:42 pm"). '' when
   *  there is no deadline to promise. The EARLIER of the write-up window and the
   *  hard cap — see call-owner.ts. Sent formatted so no client re-derives it. */
  freeAtLabel?: string;
  queue?: string;
  /** Pending recovery count after a recovery_update (drives badges) */
  recoveryCount?: number;
  /** UTC ISO */
  at: string;
}

function getEmitter(): EventEmitter {
  if (!globalThis.__fnbCtBus__) {
    const e = new EventEmitter();
    e.setMaxListeners(0); // every GRE browser tab holds a subscription
    globalThis.__fnbCtBus__ = e;
  }
  return globalThis.__fnbCtBus__;
}

/** Publish a CT event to all connected SSE streams. */
export function emitCt(evt: CtEvent): void {
  getEmitter().emit(CHANNEL, evt);
}

/** Subscribe; returns the unsubscribe function. */
export function subscribeCt(fn: (evt: CtEvent) => void): () => void {
  const e = getEmitter();
  e.on(CHANNEL, fn);
  return () => e.off(CHANNEL, fn);
}

/**
 * Recent-event ring buffer (poll fallback when SSE drops). ingest pushes here
 * too; /api/crm-calls/live reads `since`.
 */
declare global {
  // eslint-disable-next-line no-var
  var __fnbCtRecent__: { seq: number; events: Array<CtEvent & { seq: number }> } | undefined;
}

function recentStore() {
  if (!globalThis.__fnbCtRecent__) globalThis.__fnbCtRecent__ = { seq: 0, events: [] };
  return globalThis.__fnbCtRecent__;
}

export function pushRecentCt(evt: CtEvent): void {
  const s = recentStore();
  s.seq += 1;
  s.events.push({ ...evt, seq: s.seq });
  if (s.events.length > 200) s.events.splice(0, s.events.length - 200);
}

export function recentCtSince(seq: number): Array<CtEvent & { seq: number }> {
  return recentStore().events.filter(e => e.seq > seq);
}

export function latestCtSeq(): number {
  return recentStore().seq;
}
