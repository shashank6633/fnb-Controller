/**
 * VALET queue — eligibility, fairness and readiness estimates.
 * docs/valet/DESIGN.md §4 is the contract; this file is its only implementation.
 *
 *   lead(zone)  median start→ready minutes for the zone over 14 days (≥5 samples),
 *               else the zone's configured minutes, else the outlet default.
 *   eligible    now ≥ target − lead. queued_at = max(requested_at, target − lead):
 *               a request's turn starts when it was DUE, not when it was booked,
 *               so a far-future booking can never hold a ready request back.
 *   order       priority DESC, queued_at ASC, seq ASC — stable, FIFO by due time.
 *   overdue     not re-sorted (FIFO already puts the oldest first); flagged and
 *               escalated instead, so "late" can never jump a fair queue silently.
 */
import type { DB, PickupRow, Actor } from './core';
import { logEvent, SYSTEM } from './core';
import type { ValetConfig } from './config';
import { addMinutes, nowIso } from './config';

const SAMPLE_DAYS = 14;
const MIN_SAMPLES = 5;

export interface DurationStats { p50: number; p90: number; n: number; basis: 'recent' | 'configured' }

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

/** Recent start→ready durations for a zone (or the whole outlet when zoneId is
 *  null). Excludes void/test cars. Falls back to configuration below MIN_SAMPLES
 *  — the estimate is then LABELLED configured, never presented as measured. */
export function durationStats(db: DB, outletId: string, zoneId: string | null, cfg: ValetConfig, now: Date): DurationStats {
  const since = addMinutes(now, -SAMPLE_DAYS * 1440);
  const rows = db.prepare(`
    SELECT (julianday(p.ready_at) - julianday(p.started_at)) * 1440 AS m
    FROM valet_pickups p JOIN valet_vehicle_sessions s ON s.id = p.session_id
    WHERE p.outlet_id = ? AND p.ready_at IS NOT NULL AND p.started_at IS NOT NULL
      AND p.ready_at >= ? AND s.is_test = 0 AND s.state <> 'VOIDED'
      ${zoneId ? 'AND s.zone_id = ?' : ''}
    ORDER BY p.ready_at DESC LIMIT 200`).all(...(zoneId ? [outletId, since, zoneId] : [outletId, since])) as { m: number }[];
  const ms = rows.map(r => r.m).filter(m => Number.isFinite(m) && m >= 0 && m < 180).sort((a, b) => a - b);
  if (ms.length >= MIN_SAMPLES) {
    return { p50: Math.max(1, percentile(ms, 0.5)), p90: Math.max(1, percentile(ms, 0.9)), n: ms.length, basis: 'recent' };
  }
  let configured = cfg.default_retrieval_minutes;
  if (zoneId) {
    const z = db.prepare('SELECT retrieval_minutes FROM valet_zones WHERE id = ? AND outlet_id = ?').get(zoneId, outletId) as
      { retrieval_minutes: number | null } | undefined;
    if (z?.retrieval_minutes && z.retrieval_minutes > 0) configured = z.retrieval_minutes;
  }
  return { p50: configured, p90: Math.round(configured * 1.6), n: ms.length, basis: 'configured' };
}

/** Lead time used by the eligibility rule: the median for the car's zone. */
export function leadMinutes(db: DB, outletId: string, zoneId: string | null, cfg: ValetConfig, now: Date): number {
  return Math.round(durationStats(db, outletId, zoneId, cfg, now).p50 * 10) / 10;
}

/**
 * Release every SCHEDULED pickup whose release time has come. Idempotent; run
 * by the valet worker AND at the top of every queue read, so a dead worker can
 * never strand a due request. The UPDATE's `state = 'SCHEDULED'` guard is the
 * compare-and-swap: two workers releasing the same row cannot both log it.
 */
export function promoteDue(db: DB, outletId: string | null, now: Date, actor: Actor = SYSTEM): number {
  const at = nowIso(now);
  const due = db.prepare(`SELECT id, outlet_id, session_id, release_at FROM valet_pickups
                          WHERE state = 'SCHEDULED' AND release_at <= ? ${outletId ? 'AND outlet_id = ?' : ''}`)
    .all(...(outletId ? [at, outletId] : [at])) as { id: string; outlet_id: string; session_id: string; release_at: string }[];
  let n = 0;
  for (const p of due) {
    const r = db.prepare(`UPDATE valet_pickups SET state = 'QUEUED', queued_at = release_at, version = version + 1, updated_at = ?
                          WHERE id = ? AND state = 'SCHEDULED'`).run(at, p.id);
    if (r.changes === 1) {
      n++;
      logEvent(db, { outlet_id: p.outlet_id, session_id: p.session_id, pickup_id: p.id, event_type: 'pickup.released',
        from_state: 'SCHEDULED', to_state: 'QUEUED', actor, data: { release_at: p.release_at }, at });
    }
  }
  return n;
}

/** Eligible, unclaimed requests in dispatch order. */
export function eligibleQueue(db: DB, outletId: string): PickupRow[] {
  return db.prepare(`SELECT * FROM valet_pickups WHERE outlet_id = ? AND state = 'QUEUED'
                     ORDER BY priority DESC, queued_at ASC, seq ASC`).all(outletId) as PickupRow[];
}

export interface Capacity { kind: string; capacity: number | null; occupied: number }

/** Occupancy of gate / holding zones (sum over active zones of that kind). */
export function capacityOf(db: DB, outletId: string, kind: 'gate' | 'holding' | 'parking'): Capacity {
  const z = db.prepare(`SELECT SUM(capacity) AS cap, COUNT(*) AS n, SUM(CASE WHEN capacity IS NULL THEN 1 ELSE 0 END) AS unknown
                        FROM valet_zones WHERE outlet_id = ? AND kind = ? AND is_active = 1`).get(outletId, kind) as
    { cap: number | null; n: number; unknown: number };
  const col = kind === 'gate' ? 'gate_zone_id' : 'zone_id';
  const states = kind === 'gate' ? `'READY_AT_GATE'` : kind === 'holding' ? `'HOLDING_NEAR_GATE'` : `'PARKED','PARKING','RETRIEVING'`;
  const occ = db.prepare(`SELECT COUNT(*) AS n FROM valet_vehicle_sessions s
                          WHERE s.outlet_id = ? AND s.state IN (${states})
                          ${kind === 'parking' ? '' : `AND s.${col} IN (SELECT id FROM valet_zones WHERE outlet_id = s.outlet_id AND kind = '${kind}')`}`)
    .get(outletId) as { n: number };
  // Unknown capacity on ANY zone of the kind → capacity unknown (null), never a guessed number.
  const capacity = z.n === 0 || z.unknown > 0 ? null : (z.cap ?? null);
  return { kind, capacity, occupied: occ.n };
}

export interface Eta {
  /** Minutes from now, rounded; null when no honest number exists. */
  low_min: number | null;
  high_min: number | null;
  low_at: string | null;
  high_at: string | null;
  basis: 'recent' | 'configured' | 'override' | 'none';
  /** 1-based position among eligible requests (QUEUED only). */
  position: number | null;
  ahead: number | null;
  note: '' | 'no_staff' | 'scheduled' | 'at_gate' | 'any_moment' | 'gate_full' | 'parking_not_finished';
}

/** Attendants available for dispatch: on shift at this outlet and not on break. */
export function availableAttendants(db: DB, outletId: string): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM valet_shifts WHERE outlet_id = ? AND ended_at IS NULL AND status = 'on'`).get(outletId) as { n: number };
  return r.n;
}

/**
 * Estimated readiness RANGE for a pickup. Whole minutes, never seconds; no
 * number at all when nobody is on shift. A head override (with a recorded
 * reason) wins while it is set.
 */
export function etaFor(
  db: DB, p: PickupRow, zoneId: string | null, vehicleState: string, cfg: ValetConfig, now: Date,
  ctx?: { queue?: PickupRow[]; attendants?: number },
): Eta {
  const none: Eta = { low_min: null, high_min: null, low_at: null, high_at: null, basis: 'none', position: null, ahead: null, note: '' };
  const toEta = (lo: number, hi: number, basis: Eta['basis'], extra: Partial<Eta> = {}): Eta => {
    const L = Math.max(0, Math.floor(lo)), H = Math.max(L + 1, Math.ceil(hi));
    return { low_min: L, high_min: H, low_at: addMinutes(now, L), high_at: addMinutes(now, H), basis, position: null, ahead: null, note: '', ...extra };
  };
  if (p.state === 'READY') return { ...none, note: 'at_gate' };
  if (p.eta_override_low && p.eta_override_high) {
    const lo = (Date.parse(p.eta_override_low) - now.getTime()) / 60_000;
    const hi = (Date.parse(p.eta_override_high) - now.getTime()) / 60_000;
    if (hi > 0) return toEta(Math.max(0, lo), hi, 'override');
  }
  if (p.state === 'SCHEDULED') return { ...none, note: 'scheduled', low_at: p.target_at, high_at: p.target_at };
  const st = durationStats(db, p.outlet_id, zoneId, cfg, now);
  const basis = st.basis;
  if (p.state === 'IN_PROGRESS') {
    const elapsed = p.started_at ? (now.getTime() - Date.parse(p.started_at)) / 60_000 : 0;
    if (elapsed >= st.p90) return { ...none, basis, note: 'any_moment' };
    return toEta(Math.max(0, st.p50 - elapsed), Math.max(1, st.p90 - elapsed), basis);
  }
  if (p.state === 'ASSIGNED') return toEta(st.p50 * 0.8, st.p90, basis);
  if (p.state !== 'QUEUED') return none;

  const A = ctx?.attendants ?? availableAttendants(db, p.outlet_id);
  const queue = ctx?.queue ?? eligibleQueue(db, p.outlet_id);
  const idx = queue.findIndex(q => q.id === p.id);
  const position = idx >= 0 ? idx + 1 : null;
  if (A <= 0) return { ...none, basis, position, ahead: position ? position - 1 : null, note: 'no_staff' };
  if (vehicleState === 'CHECKED_IN' || vehicleState === 'PARKING') {
    return { ...none, basis, position, ahead: position ? position - 1 : null, note: 'parking_not_finished' };
  }
  const rounds = Math.ceil((position ?? 1) / A);
  let lo = rounds * st.p50 * 0.8, hi = rounds * st.p90;
  const gate = capacityOf(db, p.outlet_id, 'gate');
  const gateFull = gate.capacity !== null && gate.occupied >= gate.capacity;
  if (gateFull) { lo += st.p50; hi += st.p90; }
  return toEta(lo, hi, basis, { position, ahead: position ? position - 1 : null, note: gateFull ? 'gate_full' : '' });
}
