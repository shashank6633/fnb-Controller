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
  type: 'incoming_call' | 'answered' | 'call_ended' | 'recovery_update';
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
