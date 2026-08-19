/**
 * HRMS — attendance engine (Phase 2).
 *
 * SERVER ONLY. This module touches the database and must NEVER be imported by
 * client code ('use client' components) — the pure, client-safe contract
 * (vocabularies, status metadata, row types) lives in ./hr.ts and the pure
 * geofence math in ./hr-geo.ts. Contract: docs/HRMS_DECISIONS.md §8.2 / §8.5.
 *
 * better-sqlite3 is SYNCHRONOUS: nothing in this file awaits, so every
 * function is safe to call inside a caller's db.transaction() callback.
 *
 * THE BINDING RULES (owner rulings, §8.2 — restated here because this file is
 * where they are enforced):
 *
 *  · BUSINESS DAY, NOT CALENDAR DAY. The attendance day is the IST date AFTER
 *    shifting back by the hr_day_cutoff setting (default '04:00'). A 1:00 AM
 *    IST checkout belongs to YESTERDAY. business_date is stamped AT WRITE
 *    TIME on every event and hr_attendance.date is the same key — days are
 *    never derived by range-scanning UTC timestamps.
 *
 *  · SINGLE GATE, NO DIRECTION. The venue has one entry/exit device, so
 *    punches alternate: first non-ignored punch of a business day = IN, next
 *    = OUT, and so on. Multiple IN/OUT pairs per day are NORMAL (split shift:
 *    9:30–15:00 + 18:30–01:00 = ONE day, worked 12h00m, break 3h30m,
 *    sessions=2). A device that reports direction overrides pairing — an
 *    explicit input.event_type always wins over alternation.
 *
 *  · DEBOUNCE. Consecutive punches for one employee within
 *    hr_punch_debounce_min minutes (default 3) are duplicates. They are
 *    INSERTED anyway (append-only!) with ignored=1 + ignored_reason, and
 *    excluded from pairing and summaries.
 *
 *  · MISSING CHECKOUT. Odd non-ignored punch count at day close ⇒ summary
 *    missing_checkout=1, status MISSING_CHECKOUT. A checkout time is NEVER
 *    invented. (While the business day is still OPEN, a dangling IN simply
 *    means the person is at work — status PRESENT, no flag.)
 *
 *  · CORRECTIONS append source='manual' events and recompute; original
 *    events are never rewritten or deleted.
 */

import type Database from 'better-sqlite3';
import { generateId } from './db';
import type {
  HrAttendanceEvent,
  HrAttendanceEventType,
  HrAttendanceSummary,
  HrAttendanceCorrection,
  HrEventSource,
} from './hr';
import { HR_ATTENDANCE_EVENT_TYPES, HR_EVENT_SOURCES } from './hr';

/* ------------------------------------------------------------------ *
 * Time plumbing
 * ------------------------------------------------------------------ */

/** IST = UTC + 5:30 — the same +330-minutes convention as src/lib/format-date.ts. */
const IST_OFFSET_MIN = 330;

const DEFAULT_CUTOFF = '04:00';
const DEFAULT_DEBOUNCE_MIN = 3;

/** hr_employees.status values that cannot punch. OWNER RULING 2026-08-16
 *  (HRMS_DECISIONS §8.4b): "Suspended Staff Cannot Punch until HR Releases the
 *  suspension" — suspension is an ACCESS decision, not a descriptive state, so
 *  it blocks the gate exactly like the exit states. Release = HR sets the
 *  employee's status back (active/confirmed/probation) on the profile, which
 *  is audited; punching resumes with no engine change. The refusal message
 *  below distinguishes the two cases so a suspended cook is not told they
 *  "exited".
 *
 *  EXPORTED so every caller (import pre-filters, route error whitelists)
 *  derives from THE set — re-declaring it locally is how 'suspended' went
 *  missing from the import route once. */
export const EXITED_STATUSES = new Set(['resigned', 'terminated', 'former']);
export const BLOCKED_STATUSES = new Set([...EXITED_STATUSES, 'suspended']);

/** The exact refusal thrown for a suspended employee — exported so route
 *  error-whitelists (ENGINE_ERROR_STATUS maps and the like) match this string
 *  by reference instead of re-typing it and drifting. */
export const SUSPENDED_PUNCH_MESSAGE =
  'Employee is suspended — punches are blocked until HR releases the suspension';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Parse a server-side UTC timestamp into epoch ms. Accepts the SQLite
 * `datetime('now')` shape "YYYY-MM-DD HH:MM[:SS]" (treated as UTC — the same
 * normalisation format-date.ts::parseDb does), ISO strings with or without a
 * trailing Z, and a bare "YYYY-MM-DD" (start of that UTC day). Returns NaN
 * for anything unparseable.
 */
function parseUtcMs(value: string): number {
  const s = String(value ?? '').trim();
  if (!s) return NaN;
  let iso = s;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)$/.exec(s);
  if (m) iso = `${m[1]}T${m[2]}${m[3] ? '' : ':00'}Z`;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = `${s}T00:00:00Z`;
  const d = new Date(iso);
  return d.getTime();
}

/** Epoch ms → the storage shape 'YYYY-MM-DD HH:MM:SS' (UTC, no Z — exactly
 *  what SQLite's datetime('now') writes, so string comparison stays sound). */
function toUtcString(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

/** Now, in the storage shape (UTC 'YYYY-MM-DD HH:MM:SS'). */
export function nowUtcString(): string {
  return toUtcString(Date.now());
}

/** 'HH:MM' → minutes past midnight. Garbage/out-of-range → the 04:00 default. */
function cutoffToMinutes(cutoffHHMM: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(cutoffHHMM ?? '').trim());
  if (!m) return 4 * 60;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return 4 * 60;
  return h * 60 + min;
}

/**
 * THE business-day rule (§8.2.1): the IST date after shifting back by the
 * cutoff. Implementation: epoch + 330 min (UTC→IST) − cutoff minutes, then
 * take the date of the result.
 *
 * Worked example (cutoff '04:00'): a 1:00 AM IST checkout on 19 Aug is
 * '2026-08-18 19:30:00' UTC → +330 min = 01:00 on the 19th IST → −240 min =
 * 21:00 on the 18th ⇒ business date 2026-08-18 — YESTERDAY, exactly where a
 * split-shift night checkout belongs. A 5:00 AM IST punch on the 19th lands
 * at 01:00 after the shift ⇒ 2026-08-19, the same day.
 *
 * Throws on an unparseable timestamp — a punch that cannot be dated must not
 * be filed under a guessed day.
 */
export function businessDateOf(atUtc: string, cutoffHHMM: string): string {
  const ms = parseUtcMs(atUtc);
  if (!Number.isFinite(ms)) throw new Error('Invalid timestamp for business date');
  const shifted = ms + (IST_OFFSET_MIN - cutoffToMinutes(cutoffHHMM)) * 60_000;
  const d = new Date(shifted);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Epoch ms → IST wall-clock minutes past midnight (0..1439). */
function istWallMinutes(ms: number): number {
  const d = new Date(ms + IST_OFFSET_MIN * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** 'HH:MM' → minutes past midnight, or null for garbage (no default here —
 *  a shift with an unparseable time simply doesn't participate in LATE/OT). */
function hhmmToMinutes(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Duration of one shift window in minutes. end < start = overnight (+1 day),
 *  the same rule the hr_shifts schema documents; end == start counts 0. */
function windowMinutes(startMin: number, endMin: number): number {
  return endMin >= startMin ? endMin - startMin : endMin + 1440 - startMin;
}

/** Total scheduled minutes of a shift: the main start→end window plus every
 *  [start, end] pair in split_json (each overnight-aware). Bad JSON or bad
 *  pairs degrade to "that window contributes nothing" — never a throw. */
function shiftSpanMinutes(shift: {
  start_hhmm: string;
  end_hhmm: string;
  split_json: string;
}): number {
  let span = 0;
  const mainStart = hhmmToMinutes(shift.start_hhmm);
  const mainEnd = hhmmToMinutes(shift.end_hhmm);
  if (mainStart !== null && mainEnd !== null) span += windowMinutes(mainStart, mainEnd);
  try {
    const arr = JSON.parse(String(shift.split_json ?? '[]'));
    if (Array.isArray(arr)) {
      for (const w of arr) {
        if (!Array.isArray(w) || w.length !== 2) continue;
        const s0 = hhmmToMinutes(String(w[0]));
        const e0 = hhmmToMinutes(String(w[1]));
        if (s0 !== null && e0 !== null) span += windowMinutes(s0, e0);
      }
    }
  } catch {
    /* tolerated — split windows just don't count */
  }
  return span;
}

/* ------------------------------------------------------------------ *
 * Settings (shared settings KV — BENIGN keys only, per §2.7)
 * ------------------------------------------------------------------ */

/** One settings value or null. Never throws — a settings read must not take
 *  the attendance engine down; the defaults below are always safe. */
function readSetting(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** True when 'HH:MM' parses to a real clock time. */
function cutoffValid(v: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return false;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

/** hr_day_cutoff ('HH:MM'), default '04:00'. Invalid stored values fall back. */
export function getHrDayCutoff(db: Database.Database): string {
  const v = String(readSetting(db, 'hr_day_cutoff') ?? '').trim();
  return cutoffValid(v) ? v : DEFAULT_CUTOFF;
}

/** hr_punch_debounce_min (positive integer minutes), default 3. */
export function getHrPunchDebounceMin(db: Database.Database): number {
  const n = parseInt(String(readSetting(db, 'hr_punch_debounce_min') ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEBOUNCE_MIN;
}

/** The business date RIGHT NOW (reads hr_day_cutoff, default '04:00').
 *  This is the default `date` of GET /api/hr/attendance and the boundary
 *  recomputeDay uses to decide whether a day is closed. */
export function currentBusinessDate(db: Database.Database): string {
  return businessDateOf(nowUtcString(), getHrDayCutoff(db));
}

/* ------------------------------------------------------------------ *
 * recordAttendanceEvent — THE ONLY WRITE PATH for punches
 * ------------------------------------------------------------------ */

export interface RecordAttendanceInput {
  employee_id: string;
  /** gps|biometric|manual|import (vocab in ./hr.ts). */
  source: HrEventSource | string;
  /** UTC 'YYYY-MM-DD HH:MM[:SS]' (or ISO). Default: now. */
  at?: string;
  /** Explicit direction from a direction-aware device or a manual/correction
   *  entry — OVERRIDES alternation. The break and outside event types are
   *  only ever explicit; alternation infers check_in/check_out alone. */
  event_type?: HrAttendanceEventType | string;
  lat?: number | null;
  lng?: number | null;
  accuracy_m?: number | null;
  geofence_id?: string;
  /** inside|outside|unknown (from hr-geo's evalGeofence). */
  geofence_status?: string;
  reason?: string;
  device_info?: string;
  /** me.email for human-initiated writes; '' for machine sources. */
  created_by?: string;
  /** Defaults to the employee's home_outlet_id. */
  outlet_id?: string;
}

const VALID_EVENT_TYPES = new Set<string>(HR_ATTENDANCE_EVENT_TYPES);
const VALID_SOURCES = new Set<string>(HR_EVENT_SOURCES.map((s) => s.key));

/** The two direction punches the pairing engine walks. */
const DIRECTION_TYPES = "('check_in','check_out')";

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * Record ONE punch. Every provider — GPS, biometric connector, CSV import,
 * manual entry, correction approval — funnels through here (D3's "one intake
 * chokepoint"). Synchronous; call inside db.transaction() when the caller
 * needs atomicity with other writes.
 *
 * Sequence: validate employee (must exist, status not exited) → stamp
 * business_date AT WRITE TIME → debounce (a duplicate is INSERTED with
 * ignored=1 and the summary is left untouched) → resolve event_type
 * (explicit wins, else alternation) → insert → recomputeDay.
 *
 * Throws Error with a caller-safe message on invalid input (routes translate
 * to 400/404; messages contain no PII or schema detail).
 */
export function recordAttendanceEvent(
  db: Database.Database,
  input: RecordAttendanceInput,
): { event: HrAttendanceEvent; summary: HrAttendanceSummary } {
  const employeeId = str(input.employee_id);
  if (!employeeId) throw new Error('Employee is required');

  const emp = db
    .prepare('SELECT id, status, home_outlet_id FROM hr_employees WHERE id = ?')
    .get(employeeId) as { id: string; status: string; home_outlet_id: string } | undefined;
  if (!emp) throw new Error('Employee not found');
  if (BLOCKED_STATUSES.has(str(emp.status))) {
    throw new Error(
      str(emp.status) === 'suspended'
        ? SUSPENDED_PUNCH_MESSAGE
        : 'Employee has exited — attendance cannot be recorded',
    );
  }

  const source = str(input.source);
  if (!VALID_SOURCES.has(source)) throw new Error('Invalid attendance source');

  const atMs = input.at != null && str(input.at) !== '' ? parseUtcMs(str(input.at)) : Date.now();
  if (!Number.isFinite(atMs)) throw new Error('Invalid punch timestamp');
  const at = toUtcString(atMs);

  const cutoff = getHrDayCutoff(db);
  const businessDate = businessDateOf(at, cutoff);
  const outletId = str(input.outlet_id) || str(emp.home_outlet_id);

  // ── Debounce (§8.2.4). Compared against the employee's LATEST non-ignored
  // event by punch time — |Δ| so an import row landing slightly BEFORE the
  // newest live punch is also caught. The duplicate is still INSERTED
  // (append-only), marked ignored, and the summary is NOT recomputed.
  const debounceMin = getHrPunchDebounceMin(db);
  const last = db
    .prepare(
      `SELECT id, at FROM hr_attendance_events
       WHERE employee_id = ? AND ignored = 0
       ORDER BY at DESC, created_at DESC, id DESC LIMIT 1`,
    )
    .get(employeeId) as { id: string; at: string } | undefined;

  let ignored = 0;
  let ignoredReason = '';
  if (last) {
    const lastMs = parseUtcMs(last.at);
    if (Number.isFinite(lastMs) && Math.abs(atMs - lastMs) < debounceMin * 60_000) {
      ignored = 1;
      ignoredReason = `Duplicate punch within ${debounceMin} min of ${last.at} UTC`;
    }
  }

  // ── Direction (§8.2.3). Explicit event_type wins; otherwise alternate over
  // the business day's non-ignored direction punches. An ignored duplicate
  // still gets a type stamped (same alternation) purely for the audit trail —
  // it is excluded from pairing either way.
  let eventType = str(input.event_type);
  if (eventType) {
    if (!VALID_EVENT_TYPES.has(eventType)) throw new Error('Invalid event type');
  } else {
    const lastDir = db
      .prepare(
        `SELECT event_type FROM hr_attendance_events
         WHERE employee_id = ? AND business_date = ? AND ignored = 0
           AND event_type IN ${DIRECTION_TYPES}
         ORDER BY at DESC, created_at DESC, id DESC LIMIT 1`,
      )
      .get(employeeId, businessDate) as { event_type: string } | undefined;
    eventType = lastDir?.event_type === 'check_in' ? 'check_out' : 'check_in';
  }

  const id = generateId();
  db.prepare(
    `INSERT INTO hr_attendance_events
       (id, employee_id, outlet_id, event_type, source, at, business_date,
        lat, lng, accuracy_m, geofence_id, geofence_status, reason,
        device_info, ignored, ignored_reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    employeeId,
    outletId,
    eventType,
    source,
    at,
    businessDate,
    numOrNull(input.lat),
    numOrNull(input.lng),
    numOrNull(input.accuracy_m),
    str(input.geofence_id),
    str(input.geofence_status),
    str(input.reason),
    str(input.device_info),
    ignored,
    ignoredReason,
    str(input.created_by),
  );

  const event = db
    .prepare('SELECT * FROM hr_attendance_events WHERE id = ?')
    .get(id) as HrAttendanceEvent;

  if (ignored) {
    // Skip recompute — an ignored punch changes nothing. Hand back the day's
    // existing summary (recomputeDay only if the day has none yet, which is
    // idempotent and merely materialises the NOT_CHECKED_IN row).
    const existing = db
      .prepare('SELECT * FROM hr_attendance WHERE employee_id = ? AND date = ?')
      .get(employeeId, businessDate) as HrAttendanceSummary | undefined;
    return { event, summary: existing ?? recomputeDay(db, employeeId, businessDate).summary };
  }

  return { event, summary: recomputeDay(db, employeeId, businessDate).summary };
}

/* ------------------------------------------------------------------ *
 * recomputeDay — rebuild ONE hr_attendance summary row from its events
 * ------------------------------------------------------------------ */

/**
 * Rebuild the hr_attendance row for (employee, business_date) from the
 * NON-IGNORED direction events, chronologically:
 *
 *  · pair check_in → check_out; worked = Σ(in→out spans), sessions = pair
 *    count, break = gaps BETWEEN closed sessions;
 *  · odd punch count on a CLOSED day (business_date < current business date)
 *    ⇒ missing_checkout=1, status MISSING_CHECKOUT, dangling IN excluded
 *    from worked — a checkout time is never invented;
 *  · odd count on the OPEN (current) day = the person is simply at work ⇒
 *    status PRESENT, no flag (§8.2.5 flags at day CLOSE, not mid-shift —
 *    without this, every employee would read MISSING_CHECKOUT from their
 *    first punch to their last);
 *  · even count ⇒ CHECKED_OUT when the last direction event is an out (the
 *    normal case), PRESENT in the degenerate stray-order case where it is
 *    an in; zero events ⇒ NOT_CHECKED_IN.
 *
 * SHIFT-AWARE VERDICTS (Phase 3). When hr_rosters has a row for (employee,
 * date) its hr_shift refines a CHECKED_OUT day — and ONLY a CHECKED_OUT day
 * (MISSING_CHECKOUT keeps precedence; an open day stays PRESENT):
 *
 *  · LATE — first_in (converted to IST wall-clock minutes; shift start_hhmm
 *    IS IST) later than shift start + late_after_minutes ⇒ status 'LATE'.
 *    The day is still checked out — LATE is the day's verdict. Both sides
 *    are normalised through the hr_day_cutoff (a wall time before the cutoff
 *    belongs to the tail of the business day, +24h) so a post-midnight
 *    first-punch against an evening shift reads late, not early.
 *  · OVERTIME — overtime_minutes = worked_minutes − shift span (main window
 *    + split_json windows, each overnight-aware) when that excess is
 *    ≥ overtime_after_minutes, else 0. Stored on the row, not a status.
 *
 * shift_id is stamped from the roster whenever one exists ('' otherwise).
 * No roster ⇒ exactly the shift-less behaviour above, overtime 0.
 * ABSENT and HALF_DAY remain UNMODELLED here — a rostered day with no
 * punches stays NOT_CHECKED_IN and the report layer derives "absent" from
 * roster minus summaries; nothing writes those statuses yet.
 *
 * first_in / last_out are UTC strings ('' when absent). The UPSERT keys on
 * UNIQUE(employee_id, date) and deliberately does NOT touch corrected or
 * outside_minutes — those belong to the correction flow / geofence phase.
 *
 * A day that flipped from open to closed (dangling IN left overnight) stays
 * PRESENT until something recomputes it — see sweepStaleOpenDays(), which
 * recomputes through THIS function and therefore re-derives the shift-aware
 * fields for free.
 */
export function recomputeDay(
  db: Database.Database,
  employee_id: string,
  business_date: string,
): { summary: HrAttendanceSummary } {
  const events = db
    .prepare(
      `SELECT id, event_type, at, outlet_id FROM hr_attendance_events
       WHERE employee_id = ? AND business_date = ? AND ignored = 0
         AND event_type IN ${DIRECTION_TYPES}
       ORDER BY at, created_at, id`,
    )
    .all(employee_id, business_date) as {
    id: string;
    event_type: string;
    at: string;
    outlet_id: string;
  }[];

  const sessions: { inMs: number; outMs: number }[] = [];
  let openInMs: number | null = null;
  let firstIn = '';
  let lastOut = '';

  for (const ev of events) {
    const ms = parseUtcMs(ev.at);
    if (!Number.isFinite(ms)) continue; // undated punch cannot enter arithmetic
    if (ev.event_type === 'check_in') {
      if (!firstIn) firstIn = ev.at;
      // Double IN (only reachable via explicit-typed imports/corrections):
      // keep the FIRST — the earlier gate crossing is the real session start.
      if (openInMs === null) openInMs = ms;
    } else {
      // check_out
      if (openInMs !== null) {
        sessions.push({ inMs: openInMs, outMs: Math.max(openInMs, ms) });
        openInMs = null;
      }
      // A stray OUT with no open IN pairs with nothing — it still counts
      // toward the odd/even parity below, which is what surfaces it.
      lastOut = ev.at;
    }
  }

  const workedMin = sessions.reduce(
    (sum, s) => sum + Math.round((s.outMs - s.inMs) / 60_000),
    0,
  );
  let breakMin = 0;
  for (let i = 1; i < sessions.length; i++) {
    breakMin += Math.max(0, Math.round((sessions[i].inMs - sessions[i - 1].outMs) / 60_000));
  }

  const count = events.length;
  const odd = count % 2 === 1;
  const dayClosed = business_date < currentBusinessDate(db);

  let status: string;
  let missingCheckout = 0;
  if (count === 0) {
    status = 'NOT_CHECKED_IN';
  } else if (odd && dayClosed) {
    status = 'MISSING_CHECKOUT';
    missingCheckout = 1;
  } else if (odd) {
    // Open day, dangling IN — the employee is at work right now.
    status = 'PRESENT';
  } else {
    status = events[count - 1].event_type === 'check_out' ? 'CHECKED_OUT' : 'PRESENT';
  }

  // ── Shift-aware refinement (see the doc comment). Roster lookup is a
  // LEFT-style tolerance: no roster row, an inactive/dangling shift id or
  // unparseable times all degrade to the shift-less behaviour.
  const roster = db
    .prepare(
      `SELECT r.shift_id, s.start_hhmm, s.end_hhmm, s.split_json,
              s.late_after_minutes, s.overtime_after_minutes
       FROM hr_rosters r JOIN hr_shifts s ON s.id = r.shift_id
       WHERE r.employee_id = ? AND r.date = ?`,
    )
    .get(employee_id, business_date) as
    | {
        shift_id: string;
        start_hhmm: string;
        end_hhmm: string;
        split_json: string;
        late_after_minutes: number;
        overtime_after_minutes: number;
      }
    | undefined;

  const shiftId = roster ? str(roster.shift_id) : '';
  let overtimeMin = 0;
  if (roster && status === 'CHECKED_OUT') {
    // LATE: compare IST wall-clock minutes, both sides normalised through the
    // day cutoff so post-midnight times sort after the evening (MISSING_
    // CHECKOUT/PRESENT never reach here, so their precedence is preserved).
    const cutoffMin = cutoffToMinutes(getHrDayCutoff(db));
    const startMin = hhmmToMinutes(roster.start_hhmm);
    const firstInMs = parseUtcMs(firstIn);
    if (startMin !== null && Number.isFinite(firstInMs)) {
      let inWall = istWallMinutes(firstInMs);
      if (inWall < cutoffMin) inWall += 1440;
      let startCmp = startMin;
      if (startCmp < cutoffMin) startCmp += 1440;
      const lateAfter = Math.max(0, Math.round(Number(roster.late_after_minutes) || 0));
      if (inWall > startCmp + lateAfter) status = 'LATE';
    }
    // OVERTIME: excess over the full scheduled span, counted only past the
    // shift's own threshold. Independent of the LATE verdict.
    const span = shiftSpanMinutes(roster);
    if (span > 0) {
      const excess = workedMin - span;
      const otAfter = Math.max(0, Math.round(Number(roster.overtime_after_minutes) || 0));
      overtimeMin = excess >= Math.max(1, otAfter) ? excess : 0;
    }
  }

  const outletId = events.find((e) => str(e.outlet_id))?.outlet_id ?? '';

  db.prepare(
    `INSERT INTO hr_attendance
       (id, employee_id, outlet_id, date, status, first_in, last_out,
        sessions, worked_minutes, break_minutes, overtime_minutes, shift_id,
        missing_checkout, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(employee_id, date) DO UPDATE SET
       status           = excluded.status,
       first_in         = excluded.first_in,
       last_out         = excluded.last_out,
       sessions         = excluded.sessions,
       worked_minutes   = excluded.worked_minutes,
       break_minutes    = excluded.break_minutes,
       overtime_minutes = excluded.overtime_minutes,
       shift_id         = excluded.shift_id,
       missing_checkout = excluded.missing_checkout,
       outlet_id        = CASE WHEN excluded.outlet_id != '' THEN excluded.outlet_id
                               ELSE hr_attendance.outlet_id END,
       computed_at      = datetime('now')`,
  ).run(
    generateId(),
    employee_id,
    str(outletId),
    business_date,
    status,
    firstIn,
    lastOut,
    sessions.length,
    workedMin,
    breakMin,
    overtimeMin,
    shiftId,
    missingCheckout,
  );

  const summary = db
    .prepare('SELECT * FROM hr_attendance WHERE employee_id = ? AND date = ?')
    .get(employee_id, business_date) as HrAttendanceSummary;
  return { summary };
}

/**
 * Re-close days that were last computed while still OPEN: any summary row
 * dated before the current business date whose status is still PRESENT (a
 * dangling IN left overnight) is recomputed, flipping it to MISSING_CHECKOUT.
 * Cheap — the partial-scan trap is closed by idx_hr_att_status_date
 * (status, date) in db.ts, so the query seeks straight to the PRESENT rows
 * instead of range-scanning every historical date. Read surfaces such as
 * GET /api/hr/attendance can call this first so a stale "PRESENT yesterday"
 * can never render. Idempotent; safe to call any time. Because it recomputes
 * through recomputeDay, the shift-aware fields (status LATE, shift_id,
 * overtime_minutes) are re-derived — never zeroed — on the way through.
 */
export function sweepStaleOpenDays(db: Database.Database): number {
  const today = currentBusinessDate(db);
  const stale = db
    .prepare(
      `SELECT employee_id, date FROM hr_attendance
       WHERE date < ? AND status = 'PRESENT'`,
    )
    .all(today) as { employee_id: string; date: string }[];
  for (const row of stale) recomputeDay(db, row.employee_id, row.date);
  return stale.length;
}

/* ------------------------------------------------------------------ *
 * applyCorrection — the approval side of hr_attendance_corrections
 * ------------------------------------------------------------------ */

/** The shape applyCorrection expects inside requested_json: either this
 *  object or a bare array of its `events`. `at` is UTC ('YYYY-MM-DD HH:MM[:SS]'
 *  or ISO) — the SAME basis as hr_attendance_events.at, NOT IST wall time. */
export interface CorrectionRequestedJson {
  events: { event_type: HrAttendanceEventType | string; at: string; reason?: string }[];
}

/**
 * Apply an APPROVED correction (variance_approvals pattern, §8.2 + D3): the
 * requested events are APPENDED as source='manual' rows (created_by = the
 * approver, business_date FORCED to the correction's date — the whole point
 * is to fix THAT day's register row, so a requested 01:00 checkout must not
 * re-derive onto a neighbouring day), the day is recomputed, and corrected=1
 * is stamped on the summary. Original events are never rewritten or deleted.
 *
 * DELIBERATELY NO TRANSACTION OF ITS OWN and no status/decision writes: the
 * corrections PATCH route wraps this — together with its own
 * status='approved' UPDATE, approved_json stamp and logAuditEvent — in ONE
 * db.transaction(), so a throw here (bad JSON, invalid event type, undated
 * event) rolls the entire approval back. better-sqlite3 nests via savepoints,
 * so a second transaction here would only blur that boundary.
 *
 * Debounce is NOT applied to appended events: an approver adding the missing
 * 01:00 checkout two minutes after an existing stray punch is making a
 * deliberate, reviewed statement — silently ignoring it would approve a
 * correction that then never happened.
 *
 * Throws Error with a caller-safe message on malformed requested_json.
 */
export function applyCorrection(
  db: Database.Database,
  correction: Pick<
    HrAttendanceCorrection,
    'id' | 'employee_id' | 'date' | 'requested_json' | 'reason'
  >,
  approverEmail: string,
): { events: HrAttendanceEvent[]; summary: HrAttendanceSummary } {
  const employeeId = str(correction.employee_id);
  const date = str(correction.date);
  if (!employeeId || !date) throw new Error('Correction is missing its employee or date');

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(correction.requested_json ?? ''));
  } catch {
    throw new Error('Correction request is not valid JSON');
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as CorrectionRequestedJson)?.events)
      ? (parsed as CorrectionRequestedJson).events
      : null;
  if (!list || list.length === 0) throw new Error('Correction request contains no events');

  const emp = db
    .prepare('SELECT id, home_outlet_id FROM hr_employees WHERE id = ?')
    .get(employeeId) as { id: string; home_outlet_id: string } | undefined;
  if (!emp) throw new Error('Employee not found');

  const ins = db.prepare(
    `INSERT INTO hr_attendance_events
       (id, employee_id, outlet_id, event_type, source, at, business_date,
        reason, ignored, ignored_reason, created_by)
     VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, 0, '', ?)`,
  );

  const ids: string[] = [];
  for (const raw of list) {
    const ev = raw as { event_type?: unknown; at?: unknown; reason?: unknown };
    const eventType = str(ev.event_type);
    if (!VALID_EVENT_TYPES.has(eventType)) throw new Error('Correction contains an invalid event type');
    const ms = parseUtcMs(str(ev.at));
    if (!Number.isFinite(ms)) throw new Error('Correction contains an invalid event time');
    const id = generateId();
    ins.run(
      id,
      employeeId,
      str(emp.home_outlet_id),
      eventType,
      toUtcString(ms),
      date, // FORCED to the corrected day — see the doc comment
      str(ev.reason) || str(correction.reason),
      str(approverEmail),
    );
    ids.push(id);
  }

  const { summary: recomputed } = recomputeDay(db, employeeId, date);
  db.prepare('UPDATE hr_attendance SET corrected = 1 WHERE employee_id = ? AND date = ?').run(
    employeeId,
    date,
  );

  const events = ids.map(
    (id) =>
      db.prepare('SELECT * FROM hr_attendance_events WHERE id = ?').get(id) as HrAttendanceEvent,
  );
  return { events, summary: { ...recomputed, corrected: 1 } };
}
