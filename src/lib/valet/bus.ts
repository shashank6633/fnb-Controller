/**
 * VALET live-update bus — the same globalThis EventEmitter pattern as
 * src/lib/kds-bus.ts, on its own channel. Events carry IDS ONLY (never a plate,
 * a name or a phone): a subscriber re-reads through its own authorised API.
 *
 * SINGLE-PROCESS. A pm2 cluster has one bus per worker, so an event raised on
 * worker A never reaches a stream held by worker B — which is why every valet
 * screen ALSO polls (docs/valet/DESIGN.md A6). The bus makes updates instant
 * when it can; polling makes them correct when it cannot.
 */
import { EventEmitter } from 'events';

declare global {
  var __fnbValetBus__: EventEmitter | undefined;
}

export interface ValetBusEvent {
  outlet_id: string;
  kind: string;            // e.g. 'session.changed', 'pickup.changed', 'shift.changed'
  session_id?: string | null;
  pickup_id?: string | null;
  at: string;
}

function bus(): EventEmitter {
  if (!globalThis.__fnbValetBus__) {
    const e = new EventEmitter();
    e.setMaxListeners(0);
    globalThis.__fnbValetBus__ = e;
  }
  return globalThis.__fnbValetBus__;
}

export function emitValet(evt: ValetBusEvent): void {
  try { bus().emit('valet', evt); } catch { /* a bad listener must never fail a write */ }
}

export function subscribeValet(handler: (evt: ValetBusEvent) => void): () => void {
  const e = bus();
  e.on('valet', handler);
  return () => e.off('valet', handler);
}
