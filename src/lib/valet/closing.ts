/**
 * VALET closing-rush mode (spec §8): 30–45 minutes before close, ask guests
 * who still have a car parked when they would like it — in CAPACITY-AWARE
 * batches, only to guests with a verified, consenting WhatsApp identity.
 *
 * A prompt NEVER creates or changes a pickup. Only the guest's own confirmed
 * choice does (a "NOW" reply, or a tap on their pass), through the normal
 * request path. Business dates that cross midnight are handled by nextClose()
 * and businessDate() (config.ts).
 */
import type { DB, OutletValet } from './core';
import { nowIso, nextClose, businessDate } from './config';
import { availableAttendants } from './queue';
import { enqueue } from './notify';

export function runClosingRush(db: DB, ov: OutletValet, now: Date = new Date()): { prompted: number; window: boolean } {
  const c = ov.cfg.closing_rush;
  if (!c.enabled) return { prompted: 0, window: false };
  const close = nextClose(now, ov.cfg);
  const minsToClose = (close.getTime() - now.getTime()) / 60_000;
  if (minsToClose > c.lead_minutes || minsToClose <= 0) return { prompted: 0, window: false };
  // Capacity: never prompt more guests than the team can plausibly serve soon.
  const staff = availableAttendants(db, ov.outlet_id);
  const waiting = (db.prepare(`SELECT COUNT(*) AS n FROM valet_pickups WHERE outlet_id = ? AND state IN ('SCHEDULED','QUEUED','ASSIGNED')`).get(ov.outlet_id) as { n: number }).n;
  const room = Math.max(0, Math.min(c.batch_size, Math.max(1, staff) * 3 - waiting));
  if (room === 0) return { prompted: 0, window: true };
  const date = businessDate(now, ov.cfg);
  const cars = db.prepare(`
    SELECT s.id, s.tag_code FROM valet_vehicle_sessions s
    WHERE s.outlet_id = ? AND s.state IN ('PARKED','HOLDING_NEAR_GATE')
      AND NOT EXISTS (SELECT 1 FROM valet_pickups p WHERE p.session_id = s.id AND p.state IN ('SCHEDULED','QUEUED','ASSIGNED','IN_PROGRESS','READY'))
      AND NOT EXISTS (SELECT 1 FROM valet_notifications n WHERE n.session_id = s.id AND n.kind = 'closing_prompt' AND n.dedupe_key = 'closing:' || s.id || ':' || ?)
      AND EXISTS (SELECT 1 FROM valet_msg_identities i WHERE i.session_id = s.id AND i.verified_at IS NOT NULL AND i.consent_at IS NOT NULL AND i.opted_out_at IS NULL)
    ORDER BY s.checked_in_at LIMIT ?`).all(ov.outlet_id, date, room) as { id: string; tag_code: string }[];
  let prompted = 0;
  const closeLabel = new Date(close.getTime() + 330 * 60_000).toISOString().slice(11, 16);
  for (const car of cars) {
    if (enqueue(db, { outlet_id: ov.outlet_id, session_id: car.id, kind: 'closing_prompt', dedupe: `closing:${car.id}:${date}`, params: [car.tag_code, closeLabel] }, now)) prompted++;
  }
  void nowIso;
  return { prompted, window: true };
}
