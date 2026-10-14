/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * THE PEST MONITORING SHEET — station by station (#113 "Pest-control monitoring
 * sheet"; #78 "records maintained"). fssai_pest_device_checks, table 33.
 *
 * The authority's sheet is one line per station per check: date, device,
 * activity yes/no, action, initials. Until now there was no such record:
 * fssai_pest_devices.last_checked_at was written only by a sighting, and Audit
 * File record 13 counted checklist rounds that had a "Pests" section instead —
 * including the monthly Checklist-3 self-audit, which is not a monitoring sheet.
 *
 * ── WHAT A ROUND IS ─────────────────────────────────────────────────────────
 * One walk of the stations, submitted at once. The route mints round_id; every
 * station checked on the walk is one row carrying it. There is no header table:
 * the walk has no facts of its own beyond date, time and person, which each row
 * already carries (db.ts, table 33).
 *
 * ── THE RULES A ROUND IS REFUSED ON, ALL OR NOTHING ─────────────────────────
 *  · The date: not in the future, and at most FSSAI_BACKDATE_DAYS back with a
 *    reason in words (§7 Q9, the same window as every other check).
 *  · Every line names a station on the map that is in use — a retired station
 *    cannot be checked — and no station twice in one walk.
 *  · ACTIVITY IS 'yes' OR 'no' AND NOTHING ELSE. '' is "not recorded", never
 *    "no activity" (the record-tables rule). A station that was not looked at is
 *    simply left out of the walk.
 *  · Activity = yes needs WHAT was found (a pest type) and WHAT WAS DONE in
 *    words; a device not in order (bait gone, board torn, unit dead) needs what
 *    was done too. A tick with no action is the line an inspector circles.
 *  · Initials on every line — the paper sheet's column. checked_by is the
 *    session; both are kept because the person at the station may not be the
 *    person typing.
 * If any line fails, nothing is written and the refusal names the station.
 *
 * ── WHAT A ROUND WRITES, IN ONE TRANSACTION ─────────────────────────────────
 *  · one fssai_pest_device_checks row per station, is_fail FROZEN at write
 *    (activity yes, or device not in order) so a later edit to the rule can
 *    never re-judge an old sheet;
 *  · for every "activity = yes", a SIGHTING in fssai_pest_sightings, linked both
 *    ways (sighting_id on the check; device_id + the round in the sighting's
 *    words). Sightings stay the one register of pests seen, so the existing
 *    close / raise-a-corrective-action flow covers station activity unchanged;
 *  · fssai_pest_devices.last_checked_at moved forward (never back) to the
 *    check's time — so the map shows the last time anybody looked;
 *  · an fssai_audit_log row per line (fssaiAudit throws, so a line that cannot
 *    be traced is not written).
 *
 * ── WHAT THE AUDIT FILE SHOULD READ (exported for that lane) ────────────────
 *    readPestMonitoringSheet(db, { from, to, today })  → record 13
 *    pestStationCoverage(db, today)                    → which stations are due
 *    readPestChemicalsApplied(db, { from, to })        → record 5 / line #78
 * Coverage is judged from THIS table only. last_checked_at is also stamped by a
 * sighting filed against a station, so it says "somebody looked", not "the
 * sheet was filled in".
 */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import {
  daysBetweenISO, fssaiCaDueDate, fssaiToday, isFssaiCaSeverity, isFssaiCheckResult, isISODate,
  FSSAI_CHECK_RESULTS, FSSAI_PEST_DEVICE_KINDS, FSSAI_PEST_EVIDENCE_KINDS, FSSAI_PEST_SEVERITIES, FSSAI_PEST_TYPES,
} from '@/lib/fssai';
import { fssaiAudit, fssaiAppAudit, str } from '@/lib/fssai-server';
import { FSSAI_BACKDATE_DAYS, fssaiClock } from '../../_p4/lib';
import { readPestChemicals, type PestChemical, type PestChemicalsState } from './chemicals';

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/**
 * How many days a station's check lasts, from fssai_pest_devices.check_frequency
 * (the four values the pest-map form offers). An unknown value reads as weekly —
 * the column's own default — and the coverage row says which it assumed.
 */
export const PEST_CHECK_FREQUENCY_DAYS: Record<string, number> = {
  daily: 1,
  weekly: 7,
  fortnightly: 14,
  monthly: 31,
};

export const PEST_CHECK_MAX_STATIONS = 300;

export const PEST_CHECKER_KINDS: readonly { key: 'staff' | 'contractor'; label: string }[] = [
  { key: 'staff', label: 'Our staff' },
  { key: 'contractor', label: 'Pest-control technician' },
] as const;

export type PestStationState = 'ok' | 'due' | 'overdue' | 'never';

export const PEST_STATION_STATES: readonly { key: PestStationState; label: string; color: string }[] = [
  { key: 'ok', label: 'Checked', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'due', label: 'Due today', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'overdue', label: 'Overdue', color: 'bg-red-100 text-red-700 border-red-200' },
  { key: 'never', label: 'Never checked', color: 'bg-red-100 text-red-700 border-red-200' },
] as const;

const label = (list: readonly { key: string; label: string }[], k: string) => list.find((x) => x.key === k)?.label || k;

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** The IST wall-clock HH:MM now. */
function istClockNow(now: Date = new Date()): string {
  const t = new Date(now.getTime() + 5.5 * 3600_000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

/** A business date + IST clock as a UTC ISO instant (the form last_checked_at uses). */
function istStamp(date: string, clock: string): string {
  return new Date(`${date}T${clock || '00:00'}:00+05:30`).toISOString();
}

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export interface PestCheckRow {
  id: string;
  round_id: string;
  business_date: string;
  checked_at: string;
  device_id: string;
  device_code: string;
  device_kind: string;
  device_kind_label: string;
  location_label: string;
  department_id: string;
  department_name: string;
  activity: '' | 'yes' | 'no';
  activity_label: string;
  activity_kind: string;
  activity_kind_label: string;
  device_condition: string;
  device_condition_label: string;
  action_taken: string;
  initials: string;
  checked_by: string;
  checked_name: string;
  checker_kind: string;
  checker_kind_label: string;
  service_id: string;
  service_no: string;
  sighting_id: string;
  is_fail: boolean;
  ca_id: string;
  ca_number: string;
  ca_status: string;
  note: string;
  status: string;
  is_void: boolean;
  voided_at: string;
  voided_by: string;
  void_reason: string;
  created_at: string;
}

const CHECK_SELECT = `
  SELECT c.*,
         dep.name AS department_name,
         s.service_no AS service_no,
         ca.ca_number AS ca_number, ca.status AS ca_status
    FROM fssai_pest_device_checks c
    LEFT JOIN departments dep ON dep.id = c.department_id
    LEFT JOIN fssai_pest_services s ON s.id = c.service_id
    LEFT JOIN fssai_corrective_actions ca ON ca.id = c.ca_id`;

export function shapePestCheck(r: any): PestCheckRow {
  const activity = (['yes', 'no'].includes(str(r.activity)) ? str(r.activity) : '') as '' | 'yes' | 'no';
  const isVoid = str(r.status) === 'void' || !!str(r.voided_at);
  return {
    id: String(r.id),
    round_id: str(r.round_id),
    business_date: str(r.business_date),
    checked_at: str(r.checked_at),
    device_id: str(r.device_id),
    device_code: str(r.device_code),
    device_kind: str(r.device_kind),
    device_kind_label: label(FSSAI_PEST_DEVICE_KINDS, str(r.device_kind)),
    location_label: str(r.location_label),
    department_id: str(r.department_id),
    department_name: str(r.department_name),
    activity,
    activity_label: activity === 'yes' ? 'Yes' : activity === 'no' ? 'No' : 'Not recorded',
    activity_kind: str(r.activity_kind),
    activity_kind_label: str(r.activity_kind) ? label(FSSAI_PEST_TYPES, str(r.activity_kind)) : '',
    device_condition: str(r.device_condition),
    device_condition_label: FSSAI_CHECK_RESULTS.find((x) => x.key === str(r.device_condition))?.label || str(r.device_condition),
    action_taken: str(r.action_taken),
    initials: str(r.initials),
    checked_by: str(r.checked_by),
    checked_name: str(r.checked_name),
    checker_kind: str(r.checker_kind) || 'staff',
    checker_kind_label: label(PEST_CHECKER_KINDS, str(r.checker_kind) || 'staff'),
    service_id: str(r.service_id),
    service_no: str(r.service_no),
    sighting_id: str(r.sighting_id),
    is_fail: Number(r.is_fail) === 1,
    ca_id: str(r.ca_id),
    ca_number: str(r.ca_number),
    ca_status: str(r.ca_status),
    note: str(r.note),
    status: isVoid ? 'void' : str(r.status) || 'submitted',
    is_void: isVoid,
    voided_at: str(r.voided_at),
    voided_by: str(r.voided_by),
    void_reason: str(r.void_reason),
    created_at: str(r.created_at),
  };
}

export function readPestCheck(db: Database.Database, id: string): PestCheckRow | null {
  const r = db.prepare(`${CHECK_SELECT} WHERE c.id = ?`).get(str(id)) as any;
  return r ? shapePestCheck(r) : null;
}

export function readPestRound(db: Database.Database, roundId: string): PestCheckRow[] {
  return (db.prepare(`${CHECK_SELECT} WHERE c.round_id = ? ORDER BY c.device_code, c.rowid`).all(str(roundId)) as any[])
    .map(shapePestCheck);
}

/* ------------------------------------------------------------------ *
 * Submitting a round
 * ------------------------------------------------------------------ */

export interface PestRoundLineInput {
  device_id?: unknown;
  activity?: unknown;
  activity_kind?: unknown;
  evidence_kind?: unknown;
  severity?: unknown;
  device_condition?: unknown;
  action_taken?: unknown;
  initials?: unknown;
  note?: unknown;
}

export interface PestRoundInput {
  business_date?: unknown;
  checked_at?: unknown;
  checker_kind?: unknown;
  service_id?: unknown;
  backdate_reason?: unknown;
  /** default initials for every line that does not carry its own */
  initials?: unknown;
  note?: unknown;
  checks?: unknown;
}

export interface PestRoundResult {
  round_id: string;
  business_date: string;
  checked_at: string;
  backdated: boolean;
  rows: PestCheckRow[];
  sightings_raised: { id: string; device_code: string; pest_type: string }[];
  fails: number;
}

/**
 * Validate and write one walk of the stations. All or nothing.
 * better-sqlite3 is synchronous — nothing inside the transaction awaits.
 */
export function submitPestRound(
  db: Database.Database,
  p: { input: PestRoundInput; me: { email?: string | null; name?: string | null }; outletId?: string; now?: Date },
): { error: string; status: number; line?: number } | PestRoundResult {
  const now = p.now ?? new Date();
  const today = fssaiToday(now);
  const inp = p.input || {};

  /* the date and the clock */
  const businessDate = str(inp.business_date) || today;
  if (!isISODate(businessDate)) return { error: `"${str(inp.business_date)}" is not a date. Use the date picker.`, status: 400 };
  if (businessDate > today) return { error: `${businessDate} has not happened yet. A monitoring sheet records a walk that took place.`, status: 400 };
  const daysBack = daysBetweenISO(businessDate, today);
  if (daysBack > FSSAI_BACKDATE_DAYS) {
    return {
      error: `A station check can be dated today or yesterday. ${businessDate} is ${daysBack} days back — the sheet must not claim a walk on a day nobody wrote it up.`,
      status: 400,
    };
  }
  const backdated = daysBack > 0;
  const backdateReason = str(inp.backdate_reason).trim().slice(0, 1000);
  if (backdated && backdateReason.length < 4) {
    return { error: 'Say why this walk is being written up for an earlier day.', status: 400 };
  }
  let clock = fssaiClock(inp.checked_at);
  if (str(inp.checked_at) && !clock) return { error: `"${str(inp.checked_at)}" is not a time. Use HH:MM.`, status: 400 };
  if (!clock && !backdated) clock = istClockNow(now);          // filed now, for today
  if (!clock && backdated) return { error: 'What time was the walk? A backdated sheet needs the time it was done.', status: 400 };
  // Five minutes of slack: the time comes from the phone's clock, which can run
  // a little ahead of the server's. Anything later is a check not yet done.
  // (Within five minutes of midnight the slack runs into tomorrow, so the bound
  // is dropped rather than wrapped round to 00:0x.)
  const slack = new Date(now.getTime() + 5 * 60_000);
  if (!backdated && fssaiToday(slack) === today && clock > istClockNow(slack)) {
    return { error: `${clock} is later than now. A check cannot be filed before it happens.`, status: 400 };
  }

  /* who walked it */
  const checkerKind = str(inp.checker_kind) === 'contractor' ? 'contractor' : 'staff';
  const serviceId = str(inp.service_id);
  if (serviceId) {
    const svc = db.prepare(`SELECT id, voided_at, status FROM fssai_pest_services WHERE id = ?`).get(serviceId) as any;
    if (!svc) return { error: 'That pest control visit is not in the register.', status: 400 };
    if (str(svc.voided_at) || str(svc.status) === 'void') return { error: 'That visit has been voided, so a check cannot be filed against it.', status: 409 };
  }
  const defaultInitials = str(inp.initials).trim().slice(0, 12);

  /* the lines */
  if (!Array.isArray(inp.checks) || inp.checks.length === 0) {
    return { error: 'Tick at least one station. A walk with no stations on it is not a check.', status: 400 };
  }
  if (inp.checks.length > PEST_CHECK_MAX_STATIONS) {
    return { error: `That is ${inp.checks.length} stations in one walk; the most is ${PEST_CHECK_MAX_STATIONS}.`, status: 400 };
  }
  const deviceStmt = db.prepare(`SELECT * FROM fssai_pest_devices WHERE id = ?`);
  const seen = new Set<string>();
  type Line = {
    dev: any; activity: 'yes' | 'no'; activityKind: string; evidenceKind: string; severity: string;
    condition: string; action: string; initials: string; note: string; isFail: 0 | 1;
  };
  const lines: Line[] = [];
  for (let i = 0; i < inp.checks.length; i++) {
    const L = (inp.checks[i] || {}) as PestRoundLineInput;
    const n = i + 1;
    const deviceId = str(L.device_id);
    const dev = deviceId ? deviceStmt.get(deviceId) as any : null;
    if (!dev) return { error: `Line ${n}: that station is not on the pest map.`, status: 400, line: n };
    const name = `Station ${str(dev.code) || '(no number)'} — ${str(dev.location_label)}`;
    if (Number(dev.is_active) !== 1) return { error: `${name} has been retired from the map, so it cannot be checked. Leave it off the walk.`, status: 409, line: n };
    if (seen.has(deviceId)) return { error: `${name} is on this walk twice. Each station is one line.`, status: 400, line: n };
    seen.add(deviceId);

    const activity = str(L.activity).toLowerCase();
    if (activity !== 'yes' && activity !== 'no') {
      return { error: `${name}: say whether there was activity — Yes or No. A blank is not "no activity"; if it was not looked at, leave it off the walk.`, status: 400, line: n };
    }
    const condition = str(L.device_condition);
    if (!isFssaiCheckResult(condition)) return { error: `${name}: "${condition}" is not a condition this sheet knows.`, status: 400, line: n };
    const action = str(L.action_taken).trim().slice(0, 2000);
    let activityKind = '';
    let evidenceKind = '';
    if (activity === 'yes') {
      activityKind = str(L.activity_kind);
      if (!FSSAI_PEST_TYPES.some((t) => t.key === activityKind)) {
        return { error: `${name}: activity found — what was it? Pick the pest.`, status: 400, line: n };
      }
      evidenceKind = str(L.evidence_kind) || 'device_catch';
      if (!FSSAI_PEST_EVIDENCE_KINDS.some((k) => k.key === evidenceKind)) {
        return { error: `${name}: "${evidenceKind}" is not something this register records as evidence.`, status: 400, line: n };
      }
      if (action.length < 4) return { error: `${name}: activity found — say what was done about it (bait replaced, board changed, contractor called).`, status: 400, line: n };
    }
    if (condition === 'not_ok' && action.length < 4) {
      return { error: `${name}: the station is not in order — say what was done about it.`, status: 400, line: n };
    }
    const initials = (str(L.initials).trim() || defaultInitials).slice(0, 12);
    if (!initials) return { error: `${name}: initials are missing. The sheet needs the initials of whoever checked the station.`, status: 400, line: n };
    const severity = FSSAI_PEST_SEVERITIES.some((s) => s.key === str(L.severity)) ? str(L.severity) : 'low';
    lines.push({
      dev, activity, activityKind, evidenceKind, severity, condition, action, initials,
      note: str(L.note).slice(0, 2000),
      isFail: activity === 'yes' || condition === 'not_ok' ? 1 : 0,
    });
  }

  /* the write */
  const roundId = generateId();
  const stamp = istStamp(businessDate, clock);
  const nowIso = now.toISOString();
  const actor = { email: p.me.email, name: p.me.name };
  const insSighting = db.prepare(
    `INSERT INTO fssai_pest_sightings
       (id, business_date, sighted_at, pest_type, evidence_kind, count_seen, severity,
        location_label, department_id, device_id, run_id, response_id, service_id,
        description, immediate_action, status, reported_by, reported_name,
        outlet_id, created_at, updated_at)
     VALUES (?,?,?,?,?,NULL,?,?,?,?,'','',?,?,?,'submitted',?,?,?,?,?)`,
  );
  const insCheck = db.prepare(
    `INSERT INTO fssai_pest_device_checks
       (id, round_id, business_date, checked_at, device_id, device_code, device_kind, location_label,
        department_id, activity, activity_kind, device_condition, action_taken, initials,
        checked_by, checked_name, checker_kind, service_id, sighting_id, is_fail, ca_id, note,
        status, outlet_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'',?,'submitted',?,?,?)`,
  );
  const bump = db.prepare(
    `UPDATE fssai_pest_devices SET last_checked_at = ?, updated_at = ?
      WHERE id = ? AND (last_checked_at = '' OR last_checked_at < ?)`,
  );
  const ids: string[] = [];
  const raised: { id: string; device_code: string; pest_type: string }[] = [];

  db.transaction(() => {
    for (const L of lines) {
      const code = str(L.dev.code);
      let sightingId = '';
      if (L.activity === 'yes') {
        sightingId = generateId();
        const where = `${str(L.dev.location_label)}${code ? ` (station ${code})` : ''}`.slice(0, 300);
        insSighting.run(
          sightingId, businessDate, stamp, L.activityKind, L.evidenceKind, L.severity,
          where, str(L.dev.department_id), str(L.dev.id), checkerKind === 'contractor' ? serviceId : '',
          [`Found at station ${code || '(no number)'} (${label(FSSAI_PEST_DEVICE_KINDS, str(L.dev.device_kind))}) on the monitoring round of ${businessDate} ${clock}.`, L.note]
            .filter(Boolean).join('\n').slice(0, 4000),
          L.action, p.me.email || '', p.me.name || '', p.outletId || '', nowIso, nowIso,
        );
        fssaiAudit(db, {
          entity_table: 'fssai_pest_sightings', entity_id: sightingId, action: 'create',
          after: { business_date: businessDate, pest_type: L.activityKind, evidence_kind: L.evidenceKind, severity: L.severity, device_id: str(L.dev.id), from_round: roundId },
          actor, outlet_id: p.outletId,
        });
        raised.push({ id: sightingId, device_code: code, pest_type: L.activityKind });
      }
      const id = generateId();
      insCheck.run(
        id, roundId, businessDate, clock, str(L.dev.id), code, str(L.dev.device_kind), str(L.dev.location_label),
        str(L.dev.department_id), L.activity, L.activityKind, L.condition, L.action, L.initials,
        p.me.email || '', p.me.name || '', checkerKind, serviceId, sightingId, L.isFail, L.note,
        p.outletId || '', nowIso, nowIso,
      );
      fssaiAudit(db, {
        entity_table: 'fssai_pest_device_checks', entity_id: id, action: 'create',
        after: {
          round_id: roundId, business_date: businessDate, checked_at: clock, device_id: str(L.dev.id), device_code: code,
          activity: L.activity, activity_kind: L.activityKind, device_condition: L.condition, initials: L.initials,
          is_fail: L.isFail, sighting_id: sightingId, backdated,
        },
        reason: backdated ? `Backdated: ${backdateReason}` : '',
        actor, outlet_id: p.outletId,
      });
      bump.run(stamp, nowIso, str(L.dev.id), stamp);
      ids.push(id);
    }
  })();

  fssaiAppAudit(db, {
    event_type: 'fssai_pest_round', entity_type: 'fssai_pest_device_checks', entity_id: roundId,
    actor_email: p.me.email || '',
    after: { business_date: businessDate, checked_at: clock, stations: lines.length, activity: raised.length, fails: lines.filter((l) => l.isFail).length },
    note: backdated ? `Backdated: ${backdateReason}` : '',
  });

  return {
    round_id: roundId,
    business_date: businessDate,
    checked_at: clock,
    backdated,
    rows: readPestRound(db, roundId),
    sightings_raised: raised,
    fails: lines.filter((l) => l.isFail).length,
  };
}

/* ------------------------------------------------------------------ *
 * A corrective action from a failing station check
 * ------------------------------------------------------------------ */

/**
 * Raise ONE corrective action against a failing check and link it both ways.
 * Mirrors raiseP6CorrectiveAction (p6-shared.ts), which cannot be used here: it
 * is narrowed to that file's three tables. run_id is NULL (never '' — it has an
 * FK), source_kind 'manual' (one of the five values db.ts declares). The caller
 * holds the transaction and has allocated the number.
 */
export function raisePestCheckCa(
  db: Database.Database,
  p: {
    check: PestCheckRow; title: string; description?: string; severity?: string; owner_email: string;
    me: { email?: string | null; name?: string | null }; outlet_id?: string; ca_number: string;
  },
): { error: string; status: number } | { ca_id: string; ca_number: string; due_date: string } {
  const owner = str(p.owner_email).toLowerCase();
  if (!owner) return { error: 'Who is going to deal with this? A corrective action with nobody’s name on it is never closed.', status: 400 };
  const title = str(p.title).slice(0, 300);
  if (title.length < 4) return { error: 'Say in a line what has to be done.', status: 400 };
  const severity = isFssaiCaSeverity(p.severity) ? String(p.severity) : 'high';
  const dueDate = fssaiCaDueDate(severity, p.check.business_date || fssaiToday());
  const caId = generateId();
  db.prepare(
    `INSERT INTO fssai_corrective_actions
       (id, ca_number, source_kind, run_id, response_id, equipment_id, department_id,
        title, description, severity, status, owner_email, due_date, created_by, outlet_id)
     VALUES (?, ?, 'manual', NULL, '', '', ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
  ).run(caId, p.ca_number, p.check.department_id, title, str(p.description).slice(0, 4000), severity, owner, dueDate, p.me.email || '', p.outlet_id || '');
  const res = db.prepare(
    `UPDATE fssai_pest_device_checks SET ca_id = ?, updated_at = ? WHERE id = ? AND ca_id = ''`,
  ).run(caId, new Date().toISOString(), p.check.id);
  if (res.changes !== 1) throw new Error('The check already has a corrective action.');
  fssaiAudit(db, {
    entity_table: 'fssai_pest_device_checks', entity_id: p.check.id, action: 'raise_ca', field: 'ca_id',
    before: { ca_id: '' }, after: { ca_id: caId, ca_number: p.ca_number, severity, owner_email: owner, due_date: dueDate },
    actor: p.me, outlet_id: p.outlet_id,
  });
  fssaiAudit(db, {
    entity_table: 'fssai_corrective_actions', entity_id: caId, action: 'create',
    after: { ca_number: p.ca_number, source: 'fssai_pest_device_checks', source_id: p.check.id, severity, owner_email: owner, due_date: dueDate },
    actor: p.me, outlet_id: p.outlet_id,
  });
  return { ca_id: caId, ca_number: p.ca_number, due_date: dueDate };
}

/* ------------------------------------------------------------------ *
 * Coverage — which stations the sheet has, and which it is missing
 * ------------------------------------------------------------------ */

export interface PestStationCoverage {
  device_id: string;
  code: string;
  device_kind: string;
  device_kind_label: string;
  location_label: string;
  department_id: string;
  check_frequency: string;
  frequency_days: number;
  /** true when check_frequency was not one of the four known words */
  frequency_assumed: boolean;
  last_check_date: string;
  last_check_time: string;
  last_activity: '' | 'yes' | 'no';
  last_initials: string;
  /** the date the next check is due on, '' when never checked */
  due_on: string;
  state: PestStationState;
  state_label: string;
  state_color: string;
}

/**
 * Every station IN USE and where its sheet stands on `today` (default: today in
 * IST). Judged from non-void fssai_pest_device_checks rows only.
 *   never    — no check ever
 *   ok       — the last check is still inside the station's frequency
 *   due      — today is the day the next check falls due
 *   overdue  — the due day has passed
 */
export function pestStationCoverage(db: Database.Database, today: string = fssaiToday()): PestStationCoverage[] {
  const rows = db.prepare(
    `SELECT d.*,
            (SELECT c.business_date || '|' || c.checked_at || '|' || c.activity || '|' || c.initials
               FROM fssai_pest_device_checks c
              WHERE c.device_id = d.id AND c.status <> 'void' AND c.voided_at = '' AND c.business_date <= ?
              ORDER BY c.business_date DESC, c.checked_at DESC, c.rowid DESC LIMIT 1) AS last_check
       FROM fssai_pest_devices d
      WHERE d.is_active = 1
        -- a station not yet on the wall on that day cannot be overdue on it
        AND substr(d.created_at, 1, 10) <= ?
        AND (d.installed_on = '' OR d.installed_on <= ?)
      ORDER BY d.sort_order, d.code, d.rowid`,
  ).all(today, today, today) as any[];
  return rows.map((d) => {
    const freqKey = str(d.check_frequency) || 'weekly';
    const known = Object.prototype.hasOwnProperty.call(PEST_CHECK_FREQUENCY_DAYS, freqKey);
    const days = known ? PEST_CHECK_FREQUENCY_DAYS[freqKey] : PEST_CHECK_FREQUENCY_DAYS.weekly;
    const [lastDate = '', lastTime = '', lastActivity = '', lastInitials = ''] = str(d.last_check).split('|');
    const dueOn = lastDate ? addDays(lastDate, days) : '';
    const state: PestStationState = !lastDate ? 'never' : today < dueOn ? 'ok' : today === dueOn ? 'due' : 'overdue';
    const meta = PEST_STATION_STATES.find((s) => s.key === state)!;
    return {
      device_id: String(d.id),
      code: str(d.code),
      device_kind: str(d.device_kind),
      device_kind_label: label(FSSAI_PEST_DEVICE_KINDS, str(d.device_kind)),
      location_label: str(d.location_label),
      department_id: str(d.department_id),
      check_frequency: freqKey,
      frequency_days: days,
      frequency_assumed: !known,
      last_check_date: lastDate,
      last_check_time: lastTime,
      last_activity: (lastActivity === 'yes' || lastActivity === 'no' ? lastActivity : '') as '' | 'yes' | 'no',
      last_initials: lastInitials,
      due_on: dueOn,
      state,
      state_label: meta.label,
      state_color: meta.color,
    };
  });
}

/* ------------------------------------------------------------------ *
 * The sheet, for a screen, a print and the audit file
 * ------------------------------------------------------------------ */

export interface PestRoundSummary {
  round_id: string;
  business_date: string;
  checked_at: string;
  checked_by: string;
  checked_name: string;
  checker_kind: string;
  stations: number;
  activity: number;
  fails: number;
  voided: number;
}

export interface PestMonitoringSheet {
  from: string;
  to: string;
  today: string;
  /** Every line in the period, voided ones included and marked — they stay. */
  rows: PestCheckRow[];
  rounds: PestRoundSummary[];
  stations: PestStationCoverage[];
  totals: {
    lines: number; void_lines: number; rounds: number; activity: number; not_in_order: number;
    stations_in_use: number; stations_ok: number; stations_due: number; stations_overdue: number; stations_never: number;
  };
  last_check_date: string;
  /**
   * A suggestion for the audit file, with its reason — the consumer decides:
   *   missing  — no station is on the map, or no line in the period
   *   expiring — lines exist, but a station is overdue or was never checked
   *   present  — lines exist and every station in use is inside its frequency
   */
  verdict: 'present' | 'expiring' | 'missing';
  problems: string[];
  truncated: boolean;
}

export const PEST_SHEET_MAX_LINES = 2000;

export function readPestMonitoringSheet(
  db: Database.Database,
  opts: { from: string; to?: string; today?: string; deviceId?: string },
): PestMonitoringSheet {
  const today = isISODate(opts.today || '') ? String(opts.today) : fssaiToday();
  const to = isISODate(opts.to || '') ? String(opts.to) : today;
  const from = isISODate(opts.from) ? opts.from : addDays(to, -30);
  const args: any[] = [from, to];
  let extra = '';
  if (str(opts.deviceId)) { extra = ' AND c.device_id = ?'; args.push(str(opts.deviceId)); }
  const raw = db.prepare(
    `${CHECK_SELECT}
      WHERE c.business_date >= ? AND c.business_date <= ?${extra}
      ORDER BY c.business_date ASC, c.checked_at ASC, c.round_id ASC, c.device_code ASC, c.rowid ASC
      LIMIT ${PEST_SHEET_MAX_LINES + 1}`,
  ).all(...args) as any[];
  const truncated = raw.length > PEST_SHEET_MAX_LINES;
  const rows = (truncated ? raw.slice(0, PEST_SHEET_MAX_LINES) : raw).map(shapePestCheck);

  const byRound = new Map<string, PestRoundSummary>();
  for (const r of rows) {
    const k = r.round_id || r.id;
    const g = byRound.get(k) || {
      round_id: k, business_date: r.business_date, checked_at: r.checked_at, checked_by: r.checked_by,
      checked_name: r.checked_name, checker_kind: r.checker_kind, stations: 0, activity: 0, fails: 0, voided: 0,
    };
    if (r.is_void) g.voided++;
    else {
      g.stations++;
      if (r.activity === 'yes') g.activity++;
      if (r.is_fail) g.fails++;
    }
    byRound.set(k, g);
  }
  const live = rows.filter((r) => !r.is_void);
  const stations = pestStationCoverage(db, to);
  const count = (s: PestStationState) => stations.filter((x) => x.state === s).length;
  const totals = {
    lines: live.length,
    void_lines: rows.length - live.length,
    rounds: [...byRound.values()].filter((g) => g.stations > 0).length,
    activity: live.filter((r) => r.activity === 'yes').length,
    not_in_order: live.filter((r) => r.device_condition === 'not_ok').length,
    stations_in_use: stations.length,
    stations_ok: count('ok'),
    stations_due: count('due'),
    stations_overdue: count('overdue'),
    stations_never: count('never'),
  };
  const last = live.length ? live[live.length - 1].business_date : '';

  const problems: string[] = [];
  let verdict: PestMonitoringSheet['verdict'] = 'present';
  if (!stations.length) {
    verdict = 'missing';
    problems.push('No bait station, glue board or insect light trap is on the pest map, so there is nothing to check. An administrator adds them under Pest Control Logs → Monitoring points.');
  }
  if (!live.length) {
    verdict = 'missing';
    problems.push(`No station was checked between ${from} and ${to}.`);
  }
  if (totals.stations_never) problems.push(`${totals.stations_never} station${totals.stations_never === 1 ? ' has' : 's have'} never been checked.`);
  if (totals.stations_overdue) problems.push(`${totals.stations_overdue} station${totals.stations_overdue === 1 ? ' is' : 's are'} overdue for a check.`);
  if (verdict === 'present' && (totals.stations_never || totals.stations_overdue)) verdict = 'expiring';
  const openActivity = live.filter((r) => r.activity === 'yes');
  if (openActivity.length) problems.push(`Activity was found ${openActivity.length} time${openActivity.length === 1 ? '' : 's'}; each one is a sighting on the Sightings tab.`);
  if (truncated) problems.push(`Only the first ${PEST_SHEET_MAX_LINES} lines are shown; narrow the dates.`);

  return {
    from, to, today, rows,
    rounds: [...byRound.values()].sort((a, b) => (b.business_date + b.checked_at).localeCompare(a.business_date + a.checked_at)),
    stations, totals, last_check_date: last, verdict, problems, truncated,
  };
}

/* ------------------------------------------------------------------ *
 * The chemicals register — #78, for the print and the audit file
 * ------------------------------------------------------------------ */

export interface PestChemicalsVisit {
  id: string;
  service_no: string;
  business_date: string;
  vendor_name: string;
  agency_licence_no: string;
  technician_name: string;
  service_kind: string;
  report_no: string;
  areas_covered: string;
  state: PestChemicalsState;
  none_note: string;
  chemicals: PestChemical[];
}

/**
 * Completed, non-void visits in [from, to] with what each one applied. A visit
 * whose list nobody recorded is INCLUDED with state 'not_recorded' — it is the
 * gap the inspector would find, so it is never filtered out.
 */
export function readPestChemicalsApplied(
  db: Database.Database,
  opts: { from: string; to?: string },
): { from: string; to: string; visits: PestChemicalsVisit[]; totals: { visits: number; listed: number; none_applied: number; not_recorded: number; products: number }; problems: string[] } {
  const to = isISODate(opts.to || '') ? String(opts.to) : fssaiToday();
  const from = isISODate(opts.from) ? opts.from : addDays(to, -92);
  const rows = db.prepare(
    `SELECT s.*, v.name AS vendor_master_name
       FROM fssai_pest_services s
       LEFT JOIN vendors v ON v.id = s.vendor_id
      WHERE s.voided_at = '' AND s.status = 'completed' AND s.business_date >= ? AND s.business_date <= ?
      ORDER BY s.business_date ASC, s.created_at ASC, s.rowid ASC`,
  ).all(from, to) as any[];
  const visits = rows.map((r) => {
    const read = readPestChemicals(r.chemicals_json);
    return {
      id: String(r.id),
      service_no: str(r.service_no),
      business_date: str(r.business_date),
      vendor_name: str(r.vendor_master_name) || str(r.vendor_name),
      agency_licence_no: str(r.agency_licence_no),
      technician_name: str(r.technician_name),
      service_kind: str(r.service_kind),
      report_no: str(r.report_no),
      areas_covered: str(r.areas_covered),
      state: read.state,
      none_note: read.none_note,
      chemicals: read.rows,
    };
  });
  const totals = {
    visits: visits.length,
    listed: visits.filter((v) => v.state === 'listed').length,
    none_applied: visits.filter((v) => v.state === 'none_applied').length,
    not_recorded: visits.filter((v) => v.state === 'not_recorded').length,
    products: visits.reduce((n, v) => n + v.chemicals.length, 0),
  };
  const problems: string[] = [];
  if (!visits.length) problems.push(`No completed pest-control visit between ${from} and ${to}.`);
  if (totals.not_recorded) {
    problems.push(`${totals.not_recorded} completed visit${totals.not_recorded === 1 ? ' does' : 's do'} not say what was applied. Fill it in from the job sheet on Pest Control Logs.`);
  }
  const noReg = visits.flatMap((v) => v.chemicals).filter((c) => !c.licence_no).length;
  if (noReg) problems.push(`${noReg} product line${noReg === 1 ? ' has' : 's have'} no CIB&RC registration number.`);
  const expired = visits.flatMap((v) => v.chemicals.filter((c) => c.expiry && c.expiry < v.business_date)).length;
  if (expired) problems.push(`${expired} product line${expired === 1 ? ' was' : 's were'} past expiry on the day of the visit.`);
  return { from, to, visits, totals, problems };
}
