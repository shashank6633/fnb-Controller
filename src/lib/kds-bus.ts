/**
 * In-process pub/sub for the Kitchen Display System (KDS).
 *
 * SSE stream handlers subscribe; the fire/bump routes publish. Kept on a
 * `globalThis` singleton (mirrors src/lib/scheduler.ts) so it survives dev HMR
 * and is shared across route modules in the single Node process. This is
 * single-instance only — fine on the one EC2 box; a multi-instance deploy would
 * swap this for Redis pub/sub behind the same emit/subscribe API.
 */
import { EventEmitter } from 'events';

declare global {
  // eslint-disable-next-line no-var
  var __fnbKdsBus__: EventEmitter | undefined;
}

const CHANNEL = 'kds';

export interface KdsEvent {
  type: 'kot.new' | 'kot.bumped' | 'bill.print';
  outlet_id: string | null;
  station: string;
  kot?: any;           // the KOT row (+ items/order context for kot.new / kot.bumped)
  bill?: any;          // the bill payload (BillOrder shape) for bill.print
}

function getEmitter(): EventEmitter {
  if (!globalThis.__fnbKdsBus__) {
    const e = new EventEmitter();
    e.setMaxListeners(0);   // many KDS screens may subscribe concurrently
    globalThis.__fnbKdsBus__ = e;
  }
  return globalThis.__fnbKdsBus__;
}

/** Publish a KDS event to all connected streams. */
export function emitKds(evt: KdsEvent): void {
  getEmitter().emit(CHANNEL, evt);
}

/** Subscribe; returns an unsubscribe function for stream cleanup. */
export function subscribeKds(handler: (evt: KdsEvent) => void): () => void {
  const e = getEmitter();
  e.on(CHANNEL, handler);
  return () => e.off(CHANNEL, handler);
}
