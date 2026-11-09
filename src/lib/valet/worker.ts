/**
 * VALET background worker — a 20-second tick, armed at boot from
 * src/instrumentation.ts beside the app scheduler (whose 5-minute tick is far
 * too coarse for a 5-minute escalation or a minute-precise pickup release).
 *
 * SAME SWITCH AS THE APP SCHEDULER: production, or ENABLE_SCHEDULER=1. A dev
 * server on a copy of the production database therefore never runs it — that
 * copy carries real WhatsApp credentials (notify.ts adds its own second lock).
 *
 * NOTHING HERE IS LOAD-BEARING FOR CORRECTNESS. Every queue read releases due
 * pickups and expires stale check-ins itself (board.ts), so a dead worker means
 * late escalations and messages, never a stranded car. Each job is in its own
 * try, and each carries its own cross-process claim (unique dedupe keys, row
 * compare-and-swap, a once-per-day retention row), so N pm2 workers are safe.
 */
import type { DB } from './core';
import { loadOutletValet } from './core';
import { promoteDue } from './queue';
import { expirePending } from './ops-arrival';
import { runEscalations } from './escalations';
import { deliverDue, queueStateMessages } from './notify';
import { runClosingRush } from './closing';
import { runRetention } from './retention';
import { istMinuteOfDay } from './config';

declare global {
  var __fnbValetWorker__: { started: boolean; lastTick?: number; lastResult?: unknown; running?: boolean } | undefined;
}

const TICK_MS = 20_000;

export async function valetTick(db: DB, now: Date = new Date()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let outlets: { outlet_id: string }[] = [];
  try { outlets = db.prepare(`SELECT outlet_id FROM valet_outlet_config WHERE enabled = 1`).all() as { outlet_id: string }[]; }
  catch { return { error: 'valet tables not ready' }; }
  try { expirePending(db, now); } catch (e) { out.expire = String(e); }
  for (const { outlet_id } of outlets) {
    const ov = loadOutletValet(db, outlet_id);
    if (!ov) continue;
    const r: Record<string, unknown> = {};
    try { r.released = promoteDue(db, outlet_id, now); } catch (e) { r.release_error = String(e); }
    try { r.escalations = runEscalations(db, ov, now); } catch (e) { r.escalation_error = String(e); }
    try { r.queued_msgs = queueStateMessages(db, ov, now); } catch (e) { r.msg_error = String(e); }
    try { r.closing = runClosingRush(db, ov, now); } catch (e) { r.closing_error = String(e); }
    // Retention once a day, in the quiet hours after the business day turns.
    try { if (istMinuteOfDay(now) >= 5 * 60 && istMinuteOfDay(now) < 7 * 60) r.retention = runRetention(db, ov, now); } catch (e) { r.retention_error = String(e); }
    out[outlet_id] = r;
  }
  try { out.delivery = await deliverDue(db, now); } catch (e) { out.delivery_error = String(e); }
  return out;
}

export function startValetWorkerOnce(): void {
  if (process.env.NODE_ENV !== 'production' && process.env.ENABLE_SCHEDULER !== '1') return;
  if (globalThis.__fnbValetWorker__?.started) return;
  globalThis.__fnbValetWorker__ = { started: true };
  const tick = async () => {
    const st = globalThis.__fnbValetWorker__!;
    if (st.running) return;            // never overlap a slow tick with the next
    st.running = true;
    try {
      const { getDb } = await import('@/lib/db');
      st.lastResult = await valetTick(getDb());
      st.lastTick = Date.now();
    } catch (e) {
      console.error('[valet-worker] tick failed:', (e as Error)?.message);
    } finally { st.running = false; }
  };
  setTimeout(() => { void tick(); setInterval(() => void tick(), TICK_MS); }, 15_000);
}
