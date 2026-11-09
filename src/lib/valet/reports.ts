/**
 * VALET reports (spec §12). Every figure states its denominator; void and test
 * cars are excluded everywhere; immediate-request WAITING is kept apart from
 * intentional SCHEDULED delay. Business dates (config.ts) decide which night a
 * car belongs to, so a car parked at 00:40 counts for the evening before.
 *
 * Filters: business-date range, outlets the caller may see (the route decides),
 * and optional "shift hours" (an IST clock window, e.g. 18:00–02:00, matched on
 * the car's check-in time).
 */
import type { DB } from './core';

export interface Stat { n: number; avg: number | null; p90: number | null; max: number | null }

function stat(values: number[]): Stat {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, avg: null, p90: null, max: null };
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: v.length, avg: r(v.reduce((a, b) => a + b, 0) / v.length), p90: r(v[Math.min(v.length - 1, Math.ceil(0.9 * v.length) - 1)]), max: r(v[v.length - 1]) };
}
const mins = (a: string | null, b: string | null) => (a && b ? (Date.parse(b) - Date.parse(a)) / 60_000 : NaN);
const istHour = (iso: string) => (new Date(Date.parse(iso) + 330 * 60_000)).getUTCHours();
const istMin = (iso: string) => { const d = new Date(Date.parse(iso) + 330 * 60_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

export interface ReportFilter { outletIds: string[]; from: string; to: string; shiftFrom?: string; shiftTo?: string }

function inShift(iso: string, f: ReportFilter): boolean {
  if (!f.shiftFrom || !f.shiftTo) return true;
  const a = Number(f.shiftFrom.slice(0, 2)) * 60 + Number(f.shiftFrom.slice(3, 5));
  const b = Number(f.shiftTo.slice(0, 2)) * 60 + Number(f.shiftTo.slice(3, 5));
  const m = istMin(iso);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

export function valetReport(db: DB, f: ReportFilter) {
  if (!f.outletIds.length) return null;
  const ph = f.outletIds.map(() => '?').join(',');
  const sessions = (db.prepare(`
    SELECT s.id, s.outlet_id, s.business_date, s.state, s.checked_in_at, s.handed_over_at, s.ready_at, s.relocating_at, s.parked_by, s.parked_by_name
    FROM valet_vehicle_sessions s
    WHERE s.outlet_id IN (${ph}) AND s.business_date BETWEEN ? AND ? AND s.is_test = 0 AND s.state <> 'VOIDED'`)
    .all(...f.outletIds, f.from, f.to) as { id: string; outlet_id: string; business_date: string; state: string; checked_in_at: string; handed_over_at: string | null;
      ready_at: string | null; relocating_at: string | null; parked_by: string; parked_by_name: string }[]).filter(s => inShift(s.checked_in_at, f));
  const ids = new Set(sessions.map(s => s.id));
  const pickups = (db.prepare(`
    SELECT p.* FROM valet_pickups p JOIN valet_vehicle_sessions s ON s.id = p.session_id
    WHERE p.outlet_id IN (${ph}) AND s.business_date BETWEEN ? AND ? AND s.is_test = 0 AND s.state <> 'VOIDED'`).all(...f.outletIds, f.from, f.to) as
    { session_id: string; state: string; requested_at: string; release_at: string; target_at: string; queued_at: string | null; assigned_at: string | null;
      started_at: string | null; ready_at: string | null; assigned_user_id: string | null; assigned_name: string }[]).filter(p => ids.has(p.session_id));

  // Arrivals by day and by hour; peak hour.
  const byDay: Record<string, number> = {}, byHour: Record<number, number> = {};
  for (const s of sessions) { byDay[s.business_date] = (byDay[s.business_date] || 0) + 1; const h = istHour(s.checked_in_at); byHour[h] = (byHour[h] || 0) + 1; }
  const peakHour = Object.entries(byHour).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0];

  // Peak occupancy: the most cars held at the same moment (sweep over stays).
  const pts: [number, number][] = [];
  for (const s of sessions) { pts.push([Date.parse(s.checked_in_at), 1]); if (s.handed_over_at) pts.push([Date.parse(s.handed_over_at), -1]); }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peakOcc = 0;
  for (const [, d] of pts) { cur += d; peakOcc = Math.max(peakOcc, cur); }

  const immediate = pickups.filter(p => p.release_at <= p.requested_at);
  const scheduled = pickups.filter(p => p.release_at > p.requested_at);
  const handedOver = sessions.filter(s => s.state === 'HANDED_OVER');

  // Per attendant: parks, fetches, hours on shift in the period.
  const people = new Map<string, { name: string; parks: number; fetches: number; hours: number }>();
  const person = (id: string, name: string) => { if (!people.has(id)) people.set(id, { name, parks: 0, fetches: 0, hours: 0 }); return people.get(id)!; };
  for (const s of sessions) if (s.parked_by) person(s.parked_by, s.parked_by_name).parks++;
  for (const p of pickups) if (p.assigned_user_id && p.started_at) person(p.assigned_user_id, p.assigned_name).fetches++;
  const shifts = db.prepare(`SELECT user_id, user_name, started_at, ended_at, break_seconds FROM valet_shifts WHERE outlet_id IN (${ph})`).all(...f.outletIds) as
    { user_id: string; user_name: string; started_at: string; ended_at: string | null; break_seconds: number }[];
  for (const sh of shifts) {
    const d = new Date(Date.parse(sh.started_at) + 330 * 60_000).toISOString().slice(0, 10);
    if (d < f.from || d > f.to) continue;
    const end = sh.ended_at ? Date.parse(sh.ended_at) : Date.now();
    person(sh.user_id, sh.user_name).hours += Math.max(0, (end - Date.parse(sh.started_at)) / 1000 - sh.break_seconds) / 3600;
  }

  const incidents = db.prepare(`SELECT kind, COUNT(*) AS n FROM valet_incidents WHERE outlet_id IN (${ph}) AND substr(created_at, 1, 10) BETWEEN ? AND ? GROUP BY kind`)
    .all(...f.outletIds, f.from, f.to) as { kind: string; n: number }[];

  return {
    filter: f,
    definitions: {
      arrivals: 'Cars checked in whose business date is in the range (void and test cars excluded).',
      claim_time: 'Request due (queued) → an attendant took it, minutes. Denominator: requests that were claimed.',
      retrieval_time: 'Attendant started fetching → car ready at the gate, minutes. Denominator: fetches that reached the gate.',
      request_to_ready: 'Immediate requests only (Now / In 5 / In 10 when due at once): request → ready at gate, minutes.',
      scheduled_lateness: 'Booked requests only: ready at gate − booked time, minutes (negative = early). Planned delay is not waiting.',
      gate_dwell: 'Car ready at the gate → handed over (or moved to holding), minutes.',
      no_shows: 'Pickups closed because the car was moved to holding after waiting at the gate.',
      peak_occupancy: 'Most cars held at the same moment within the range.',
    },
    totals: {
      arrivals: sessions.length, handed_over: handedOver.length, still_held: sessions.filter(s => s.state !== 'HANDED_OVER').length,
      pickups: pickups.length, immediate_requests: immediate.length, scheduled_requests: scheduled.length,
      no_shows: pickups.filter(p => p.state === 'NO_SHOW').length, cancelled: pickups.filter(p => p.state === 'CANCELLED').length,
      peak_occupancy: peakOcc, peak_hour: peakHour ? { hour: Number(peakHour[0]), arrivals: peakHour[1] } : null,
    },
    times: {
      claim_time: stat(pickups.map(p => mins(p.queued_at, p.assigned_at))),
      retrieval_time: stat(pickups.map(p => mins(p.started_at, p.ready_at))),
      request_to_ready: stat(immediate.map(p => mins(p.requested_at, p.ready_at))),
      scheduled_lateness: stat(scheduled.map(p => mins(p.target_at, p.ready_at))),
      gate_dwell: stat(sessions.map(s => mins(s.ready_at, s.handed_over_at ?? s.relocating_at))),
    },
    by_day: Object.entries(byDay).sort().map(([date, n]) => ({ date, arrivals: n })),
    by_hour: Array.from({ length: 24 }, (_, h) => ({ hour: h, arrivals: byHour[h] || 0 })),
    incidents,
    attendants: [...people.entries()].map(([id, v]) => ({ user_id: id, name: v.name, parks: v.parks, fetches: v.fetches, hours: Math.round(v.hours * 10) / 10 }))
      .sort((a, b) => b.parks + b.fetches - (a.parks + a.fetches)),
  };
}

/** CSV-safe cell: quotes, and neutralises a leading = + - @ (or tab/CR) so a
 *  spreadsheet never executes a value as a formula. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function reportCsv(r: NonNullable<ReturnType<typeof valetReport>>): string {
  const rows: unknown[][] = [['section', 'item', 'value', 'n', 'avg', 'p90', 'max', 'definition']];
  for (const [k, v] of Object.entries(r.totals)) rows.push(['totals', k, typeof v === 'object' && v ? JSON.stringify(v) : v, '', '', '', '', '']);
  for (const [k, s] of Object.entries(r.times)) rows.push(['times_minutes', k, '', s.n, s.avg, s.p90, s.max, (r.definitions as Record<string, string>)[k] || '']);
  for (const d of r.by_day) rows.push(['by_day', d.date, d.arrivals, '', '', '', '', '']);
  for (const h of r.by_hour) rows.push(['by_hour_ist', String(h.hour).padStart(2, '0') + ':00', h.arrivals, '', '', '', '', '']);
  for (const i of r.incidents) rows.push(['incidents', i.kind, i.n, '', '', '', '', '']);
  for (const a of r.attendants) rows.push(['attendant', a.name, `parks ${a.parks}; fetches ${a.fetches}; hours ${a.hours}`, '', '', '', '', '']);
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
