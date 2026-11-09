/**
 * VALET escalations (spec §8): unclaimed requests after the threshold (default
 * 5 min), prolonged fetching, a guest waiting outside, gate dwell overruns, and
 * no staff on shift. Each is a valet_alerts row with a stable dedupe key, so:
 *   - DEDUPLICATED: the partial unique index (dedupe_key WHERE resolved_at IS
 *     NULL) makes a repeat a no-op — one open card per problem, however many
 *     ticks or workers notice it;
 *   - STOPPED WHEN RESOLVED: every pass also closes the escalations whose
 *     condition no longer holds (resolved_by 'system').
 * Escalation is ATTENTION, never action: nothing here moves a car or a pickup.
 */
import type { DB, OutletValet } from './core';
import { newId } from './core';
import { nowIso, addMinutes } from './config';

export interface EscalationResult { raised: number; resolved: number }

interface Want { key: string; kind: string; message: string; session_id: string | null; pickup_id: string | null }

export function runEscalations(db: DB, ov: OutletValet, now: Date = new Date()): EscalationResult {
  const at = nowIso(now);
  const e = ov.cfg.escalation;
  const want: Want[] = [];
  const tag = (code: string) => (code ? `Tag ${code}` : 'A car');

  const queued = db.prepare(`SELECT p.id, p.session_id, s.tag_code FROM valet_pickups p JOIN valet_vehicle_sessions s ON s.id = p.session_id
                             WHERE p.outlet_id = ? AND p.state = 'QUEUED' AND p.queued_at <= ?`).all(ov.outlet_id, addMinutes(now, -e.unclaimed_min)) as
    { id: string; session_id: string; tag_code: string }[];
  for (const q of queued) want.push({ key: `esc:unclaimed:${q.id}`, kind: 'esc_unclaimed', message: `${tag(q.tag_code)}: requested ${e.unclaimed_min}+ min ago and nobody has taken it`, session_id: q.session_id, pickup_id: q.id });

  const fetching = db.prepare(`SELECT p.id, p.session_id, s.tag_code, p.assigned_name FROM valet_pickups p JOIN valet_vehicle_sessions s ON s.id = p.session_id
                               WHERE p.outlet_id = ? AND p.state = 'IN_PROGRESS' AND p.started_at <= ?`).all(ov.outlet_id, addMinutes(now, -e.fetching_min)) as
    { id: string; session_id: string; tag_code: string; assigned_name: string }[];
  for (const f of fetching) want.push({ key: `esc:fetch:${f.id}`, kind: 'esc_long_fetch', message: `${tag(f.tag_code)}: ${f.assigned_name || 'attendant'} has been fetching for ${e.fetching_min}+ min`, session_id: f.session_id, pickup_id: f.id });

  const outside = db.prepare(`SELECT p.id, p.session_id, s.tag_code FROM valet_pickups p JOIN valet_vehicle_sessions s ON s.id = p.session_id
                              WHERE p.outlet_id = ? AND p.state IN ('QUEUED','ASSIGNED','IN_PROGRESS') AND p.guest_outside_at IS NOT NULL AND p.guest_outside_at <= ?`)
    .all(ov.outlet_id, addMinutes(now, -e.outside_wait_min)) as { id: string; session_id: string; tag_code: string }[];
  for (const o of outside) want.push({ key: `esc:outside:${o.id}`, kind: 'esc_outside', message: `${tag(o.tag_code)}: guest has been waiting outside ${e.outside_wait_min}+ min`, session_id: o.session_id, pickup_id: o.id });

  const dwell = db.prepare(`SELECT id, tag_code FROM valet_vehicle_sessions WHERE outlet_id = ? AND state = 'READY_AT_GATE'
                            AND dwell_deadline_at IS NOT NULL AND dwell_deadline_at <= ?`).all(ov.outlet_id, addMinutes(now, -e.dwell_overrun_min)) as
    { id: string; tag_code: string }[];
  for (const d of dwell) want.push({ key: `esc:dwell:${d.id}`, kind: 'esc_dwell', message: `${tag(d.tag_code)}: waiting at the gate past its time — move it to holding?`, session_id: d.id, pickup_id: null });

  if (e.no_staff) {
    const waiting = (db.prepare(`SELECT COUNT(*) AS n FROM valet_pickups WHERE outlet_id = ? AND state = 'QUEUED'`).get(ov.outlet_id) as { n: number }).n;
    const staff = (db.prepare(`SELECT COUNT(*) AS n FROM valet_shifts WHERE outlet_id = ? AND ended_at IS NULL`).get(ov.outlet_id) as { n: number }).n;
    if (waiting > 0 && staff === 0) want.push({ key: `esc:nostaff:${ov.outlet_id}`, kind: 'esc_no_staff', message: `${waiting} request(s) waiting and nobody is on valet shift`, session_id: null, pickup_id: null });
  }

  let raised = 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO valet_alerts (id, outlet_id, session_id, pickup_id, kind, message, dedupe_key, created_at)
                          VALUES (?,?,?,?,?,?,?,?)`);
  const wantKeys = new Set(want.map(w => w.key));
  const tx = db.transaction(() => {
    for (const w of want) raised += ins.run(newId(), ov.outlet_id, w.session_id, w.pickup_id, w.kind, w.message, w.key, at).changes;
    // Close every open escalation of this outlet whose condition has cleared.
    const open = db.prepare(`SELECT id, dedupe_key FROM valet_alerts WHERE outlet_id = ? AND resolved_at IS NULL AND dedupe_key LIKE 'esc:%'`).all(ov.outlet_id) as
      { id: string; dedupe_key: string }[];
    let resolved = 0;
    for (const o of open) {
      if (!wantKeys.has(o.dedupe_key)) resolved += db.prepare(`UPDATE valet_alerts SET resolved_at = ?, resolved_by = 'system' WHERE id = ? AND resolved_at IS NULL`).run(at, o.id).changes;
    }
    return resolved;
  });
  const resolved = tx.immediate();
  return { raised, resolved };
}
