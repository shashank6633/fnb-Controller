/**
 * Call-to-Table CRM metrics — pure SQL aggregates over the ct_ tables.
 *
 * Inputs are UTC ISO timestamps (the module convention); outputs are plain
 * numbers/strings for the API layer. Day/hour bucketing and "today" windows
 * are IST (Asia/Kolkata, +05:30, no DST) because that is the operating
 * timezone of the venue — callers pass nothing timezone-related.
 *
 * Percentage fields (`answered_pct`, `missed_rate`, `recovery_rate`) are
 * 0–100 numbers rounded to 1 decimal.
 *
 * TWO guest rates live here, named apart on purpose so neither can pass for
 * the other:
 *
 *   · `visit_conversion_rate` — THE guest conversion. converted_count ÷
 *     total_bookings: bookings that reached the table (status seated OR
 *     completed) over EVERY live booking, including cancelled, no-show and
 *     still-upcoming ones. A RATIO in [0,1] to 2 decimals, never clamped.
 *     It shares its numerator with computeBadge() below, so the badge and the
 *     number next to it are one fact and cannot contradict each other. No call
 *     is involved: a guest who booked and dined without ever ringing us is
 *     converted.
 *
 *   · `call_booking_rate` — the CALL-CENTRE metric, unchanged arithmetic:
 *     total_bookings ÷ answered inbound calls, a RATIO to 2 decimals capped at
 *     1.0. This is the number that used to be exported under the bare name
 *     "conversion rate", and the rename IS the bug fix: under that name it was
 *     printed beside a visit-anchored badge, so guests who booked and visited
 *     but never called read 0%, while guests who called, booked and then
 *     no-showed read 100%.
 *
 * Both are `null`, never 0, when their denominator is 0. 0/0 is "no rate yet",
 * and a confident 0% for a guest who never booked (or never called) is exactly
 * the defect this replaced. Surfaces render null as an em dash via the one
 * shared renderer, src/lib/ct/conversion-display.ts.
 *
 * The dashboard's outlet-level equivalent is `visit_conversion` on
 * DashboardStats: the same rule aggregated as a RATIO OF TOTALS, not as the
 * mean of per-guest ratios (see the block that computes it).
 */
import type Database from 'better-sqlite3';
import { normalizePhone } from './phone';

type DB = Database.Database;

// ─── Shared SQL fragments ──────────────────────────────────────────────────
// created_at columns default to sqlite datetime('now') → "YYYY-MM-DD HH:MM:SS"
// while app-written timestamps are ISO "YYYY-MM-DDTHH:MM:SS.SSSZ". Replacing
// the space with 'T' makes both forms compare correctly against ISO cutoffs
// (both are UTC).
const CALL_AT = `REPLACE(COALESCE(NULLIF(c.started_at, ''), c.created_at), ' ', 'T')`;
const BOOKED_AT = `REPLACE(b.created_at, ' ', 'T')`;
/** Visit date (YYYY-MM-DD): the booking date when present, else the day the
 *  booking row was last touched (status flips to seated/completed bump it). */
const VISIT_AT = `COALESCE(NULLIF(b.booking_date, ''), substr(REPLACE(COALESCE(b.updated_at, b.created_at), ' ', 'T'), 1, 10))`;
const MISSED_FAMILY = `('missed','abandoned','voicemail')`;
/** Reservego re-emits a row when a guest is re-booked or moved on the same
 *  evening; markDuplicateGroups() marks the losers is_duplicate = 1 instead of
 *  deleting them (db.ts § A2). Counting them would overstate bookings and
 *  understate the arrival rate, so every count/aggregate here excludes them.
 *  Phone bookings are always 0 (NOT NULL DEFAULT 0), so this changes nothing
 *  for the 40 rows that predate the import. */
const LIVE_ONLY = `b.is_duplicate = 0`;

// ─── IST clock helpers ─────────────────────────────────────────────────────
const IST_OFFSET_MIN = 330;
const DAY_MS = 86_400_000;

/** UTC ms of IST midnight `daysBack` days before the IST day containing nowMs. */
function istDayStartMs(nowMs: number, daysBack = 0): number {
  const shifted = new Date(nowMs + IST_OFFSET_MIN * 60_000);
  const startUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return startUtc - IST_OFFSET_MIN * 60_000 - daysBack * DAY_MS;
}

/** IST calendar date (YYYY-MM-DD) of a UTC instant. */
function istDateStr(msUtc: number): string {
  return new Date(msUtc + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
/** 0–100 percentage, 1 decimal, 0-safe. */
const pct = (num: number, den: number) => (den > 0 ? round1((num / den) * 100) : 0);
/**
 * THE guest conversion: bookings that reached the table ÷ live bookings.
 * Same numerator as computeBadge(), so the badge and this number are one fact.
 * null (not 0) when there are no bookings: 0/0 is "no conversion yet", and a
 * confident 0% for someone who never booked is the defect this replaced.
 * Not clamped — converted_count ≤ total_bookings by construction, so a clamp
 * could only ever hide a data bug instead of exposing it.
 *
 * NOT the same thing as the stored ct_guests.arrival_rate, and deliberately not
 * merged with it: that one is written by the Reservego rollup under a different
 * rule (isArrived() in src/lib/reservego.ts also counts a bare seated_at on a
 * row whose status is neither seated nor completed).
 *
 * DO NOT EXPECT THE TWO TO MATCH, AND DO NOT "RECONCILE" THEM. They are computed
 * over DIFFERENT POPULATIONS: ct_guests.arrival_rate is written only by the
 * Reservego import rollup, so it is 0 for every guest who has no Reservego
 * bookings. Measured on the live data today that is EVERY guest — 27 of 27 carry
 * arrival_rate 0.0 while their visit_conversion_rate is non-zero, because none of
 * them came from a Reservego import. An earlier version of this comment claimed
 * the two were "numerically identical on today's data", which was simply wrong and
 * would lead the next reader to backfill one from the other and merge two
 * unrelated populations into one confidently incorrect number.
 */
const visitRatio = (converted: number, bookings: number): number | null =>
  (bookings > 0 ? Math.round((converted / bookings) * 100) / 100 : null);

/**
 * Call-centre metric: bookings ÷ answered inbound calls. null (not 0) when the
 * guest has no answered inbound call — no call, no call-to-booking rate, and
 * printing 0% for those guests was half of the bug this file just fixed.
 * Still capped at 1.0: a guest can book twice off one answered call, and a
 * >100% "rate" reads as broken; the repeat signal lives in total_bookings.
 */
const callBookingRatio = (bookings: number, answeredInbound: number): number | null =>
  (answeredInbound > 0 ? Math.min(1, Math.round((bookings / answeredInbound) * 100) / 100) : null);

const num = (v: unknown) => Number(v) || 0;

// ─── Guest metrics ─────────────────────────────────────────────────────────

export type CtBadge =
  | 'NEW CALLER'
  | 'ENQUIRED–NOT CONVERTED'
  | 'CONVERTED'
  | 'REPEAT GUEST'
  | 'LAPSED';

export interface GuestMetrics {
  total_calls: number;
  calls_30d: number;
  missed_calls: number;
  /** Answered INBOUND calls — the denominator of call_booking_rate. */
  answered_inbound: number;
  last_call_at: string | null;
  total_bookings: number;
  completed_visits: number;
  no_shows: number;
  /** Bookings that reached the table: status seated OR completed. The badge
   *  reads this same number — visit_conversion_rate cannot contradict it. */
  converted_count: number;
  last_visit_at: string | null;
  /** THE guest conversion: converted_count ÷ total_bookings (ratio, 2dp).
   *  null when the guest has no bookings — 0/0 is not 0%. Never clamped. */
  visit_conversion_rate: number | null;
  /** Call-centre metric: total_bookings ÷ answered_inbound (ratio, 2dp, capped
   *  at 1.0). null when the guest has no answered inbound call — they have no
   *  call-to-booking rate at all, and printing 0% for them was the bug. */
  call_booking_rate: number | null;
  badge: CtBadge;
}

const LAPSED_DAYS = 45;

interface CallAgg {
  total_calls: number;
  calls_30d: number;
  missed_calls: number;
  answered_inbound: number;
  last_call_at: string | null;
}

interface BookAgg {
  total_bookings: number;
  completed_visits: number;
  no_shows: number;
  converted_count: number; // bookings seated|completed
  last_visit_at: string | null;
}

function emptyMetrics(): GuestMetrics {
  return {
    total_calls: 0,
    calls_30d: 0,
    missed_calls: 0,
    answered_inbound: 0,
    last_call_at: null,
    total_bookings: 0,
    completed_visits: 0,
    no_shows: 0,
    converted_count: 0,
    last_visit_at: null,
    // null, NOT 0 — a guest with no bookings and no answered call has no rate.
    // Every zero here would print a confident "0%" on four surfaces.
    visit_conversion_rate: null,
    call_booking_rate: null,
    badge: 'NEW CALLER',
  };
}

/**
 * Badge precedence (doc rules):
 *   LAPSED    — converted but no seated/completed visit in 45d+
 *   REPEAT    — ≥2 completed visits
 *   CONVERTED — ≥1 seated|completed booking
 *   NEW CALLER — ≤1 call and no bookings at all
 *   ENQUIRED–NOT CONVERTED — everything else (has activity, never seated)
 */
function computeBadge(c: CallAgg, b: BookAgg, nowMs: number): CtBadge {
  if (b.converted_count >= 1) {
    const lastVisitMs = b.last_visit_at ? Date.parse(b.last_visit_at) : NaN;
    if (isNaN(lastVisitMs) || lastVisitMs < nowMs - LAPSED_DAYS * DAY_MS) return 'LAPSED';
    if (b.completed_visits >= 2) return 'REPEAT GUEST';
    return 'CONVERTED';
  }
  if (c.total_calls <= 1 && b.total_bookings === 0) return 'NEW CALLER';
  return 'ENQUIRED–NOT CONVERTED';
}

function buildMetrics(c: CallAgg | undefined, b: BookAgg | undefined, nowMs: number): GuestMetrics {
  const ca: CallAgg = c ?? { total_calls: 0, calls_30d: 0, missed_calls: 0, answered_inbound: 0, last_call_at: null };
  const ba: BookAgg = b ?? { total_bookings: 0, completed_visits: 0, no_shows: 0, converted_count: 0, last_visit_at: null };
  return {
    total_calls: ca.total_calls,
    calls_30d: ca.calls_30d,
    missed_calls: ca.missed_calls,
    answered_inbound: ca.answered_inbound,
    last_call_at: ca.last_call_at,
    total_bookings: ba.total_bookings,
    completed_visits: ba.completed_visits,
    no_shows: ba.no_shows,
    converted_count: ba.converted_count,
    last_visit_at: ba.last_visit_at,
    visit_conversion_rate: visitRatio(ba.converted_count, ba.total_bookings),
    call_booking_rate: callBookingRatio(ba.total_bookings, ca.answered_inbound),
    badge: computeBadge(ca, ba, nowMs),
  };
}

/**
 * Batched metrics for a set of guests — TWO grouped queries per ≤400-id chunk
 * (no N+1). Calls are matched by guest_id OR by the guest's phone_e164 so
 * pre-link call history still counts. Every requested id gets an entry
 * (zeroed metrics when the guest/rows don't exist).
 */
export function listMetricsForGuests(db: DB, guestIds: string[]): Record<string, GuestMetrics> {
  const out: Record<string, GuestMetrics> = {};
  const ids = [...new Set(guestIds.filter((id) => typeof id === 'string' && id))];
  const nowMs = Date.now();
  for (const id of ids) out[id] = emptyMetrics();
  if (ids.length === 0) return out;

  const cut30 = new Date(nowMs - 30 * DAY_MS).toISOString();

  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(',');

    const callRows = db.prepare(`
      SELECT g.id AS gid,
             COUNT(c.id)                                                              AS total_calls,
             SUM(CASE WHEN ${CALL_AT} >= ? THEN 1 ELSE 0 END)                         AS calls_30d,
             SUM(CASE WHEN c.status IN ${MISSED_FAMILY} THEN 1 ELSE 0 END)            AS missed_calls,
             SUM(CASE WHEN c.direction = 'inbound' AND c.status = 'answered'
                      THEN 1 ELSE 0 END)                                              AS answered_inbound,
             MAX(${CALL_AT})                                                          AS last_call_at
      FROM ct_guests g
      JOIN ct_calls c ON (c.guest_id = g.id OR c.phone_e164 = g.phone_e164)
      WHERE g.id IN (${ph})
      GROUP BY g.id
    `).all(cut30, ...chunk) as any[];

    const bookRows = db.prepare(`
      SELECT b.guest_id AS gid,
             COUNT(*)                                                                 AS total_bookings,
             SUM(CASE WHEN b.status = 'completed' THEN 1 ELSE 0 END)                  AS completed_visits,
             SUM(CASE WHEN b.status = 'no_show' THEN 1 ELSE 0 END)                    AS no_shows,
             SUM(CASE WHEN b.status IN ('seated','completed') THEN 1 ELSE 0 END)      AS converted_count,
             MAX(CASE WHEN b.status IN ('seated','completed') THEN ${VISIT_AT} END)   AS last_visit_at
      FROM ct_bookings b
      WHERE b.guest_id IN (${ph}) AND ${LIVE_ONLY}
      GROUP BY b.guest_id
    `).all(...chunk) as any[];

    const callMap = new Map<string, CallAgg>();
    for (const r of callRows) {
      callMap.set(r.gid, {
        total_calls: num(r.total_calls),
        calls_30d: num(r.calls_30d),
        missed_calls: num(r.missed_calls),
        answered_inbound: num(r.answered_inbound),
        last_call_at: r.last_call_at || null,
      });
    }
    const bookMap = new Map<string, BookAgg>();
    for (const r of bookRows) {
      bookMap.set(r.gid, {
        total_bookings: num(r.total_bookings),
        completed_visits: num(r.completed_visits),
        no_shows: num(r.no_shows),
        converted_count: num(r.converted_count),
        last_visit_at: r.last_visit_at || null,
      });
    }
    for (const id of chunk) {
      out[id] = buildMetrics(callMap.get(id), bookMap.get(id), nowMs);
    }
  }
  return out;
}

/** Metrics for one guest (zeroed metrics when the guest has no rows). */
export function guestMetrics(db: DB, guestId: string): GuestMetrics {
  return listMetricsForGuests(db, [guestId])[guestId] ?? emptyMetrics();
}

/**
 * Metrics keyed by phone — used by the screen-pop for unknown callers who
 * have call history but no ct_guests row yet. When a guest exists for the
 * normalized phone this delegates to guestMetrics().
 *
 * The no-guest path below passes no BookAgg, so total_bookings is 0 and
 * visit_conversion_rate comes back null → the screen-pop shows the em dash.
 * That is correct and intended: a caller with no ct_guests row has no bookings
 * to convert. Do not substitute 0 here.
 */
export function guestMetricsByPhone(db: DB, phone: string): GuestMetrics {
  const e164 = normalizePhone(phone);
  if (!e164) return emptyMetrics();

  const g = db.prepare(`SELECT id FROM ct_guests WHERE phone_e164 = ?`).get(e164) as any;
  if (g?.id) return guestMetrics(db, g.id);

  const nowMs = Date.now();
  const cut30 = new Date(nowMs - 30 * DAY_MS).toISOString();
  const r = db.prepare(`
    SELECT COUNT(c.id)                                                              AS total_calls,
           SUM(CASE WHEN ${CALL_AT} >= ? THEN 1 ELSE 0 END)                         AS calls_30d,
           SUM(CASE WHEN c.status IN ${MISSED_FAMILY} THEN 1 ELSE 0 END)            AS missed_calls,
           SUM(CASE WHEN c.direction = 'inbound' AND c.status = 'answered'
                    THEN 1 ELSE 0 END)                                              AS answered_inbound,
           MAX(${CALL_AT})                                                          AS last_call_at
    FROM ct_calls c
    WHERE c.phone_e164 = ?
  `).get(cut30, e164) as any;

  const callAgg: CallAgg = {
    total_calls: num(r?.total_calls),
    calls_30d: num(r?.calls_30d),
    missed_calls: num(r?.missed_calls),
    answered_inbound: num(r?.answered_inbound),
    last_call_at: r?.last_call_at || null,
  };
  return buildMetrics(callAgg, undefined, nowMs);
}

// ─── Dashboard stats ───────────────────────────────────────────────────────

export interface AgentStat {
  agent: string;
  /** Answered calls handled in the window, EXCLUDING self-logged callbacks the
   *  server never bounded — see COUNTABLE_CALL below for the exact rule. */
  handled: number;
  bookings: number;           // bookings attributed to this agent's calls
  recoveries_handled: number; // recoveries assigned to them with ≥1 attempt
  avg_callback_min: number;   // avg missed_at → first_attempt_at (minutes)

  // ── Scorecard extensions (additive) ──────────────────────────────────────
  // Every rate below ships with the count it was divided by, because on a
  // fortnight of restaurant traffic an agent may only have a handful of calls
  // and "100%" on 2 must not read like "100%" on 200. Inbound and outbound are
  // kept apart on purpose: an unanswered INBOUND call is the agent missing the
  // guest, an unanswered OUTBOUND call is the guest not picking up. Averaging
  // the two into one "answer rate" would blame agents for guests' phones.
  /** Inbound calls in the window carrying this agent id. */
  inbound_calls: number;
  inbound_answered: number;
  /** 0–100, inbound_answered ÷ inbound_calls. Read it with `unattributed`
   *  below: a ring-group call missed by everyone carries NO agent id, so it
   *  lands in nobody's denominator and every agent can sit at 100%. */
  answer_rate: number;
  /** Outbound (callback) attempts placed by this agent — countable ones only,
   *  same COUNTABLE_CALL rule as `handled`, so `handled` always equals
   *  inbound_answered + outbound_answered. */
  outbound_calls: number;
  outbound_answered: number;
  /** 0–100, outbound_answered ÷ outbound_calls — did the guest pick up. */
  connect_rate: number;
  /** Average speed of answer, SECONDS: answered_at − started_at over inbound
   *  answered calls that carry both timestamps (0 when none do). */
  asa_sec: number;
  /** Number of calls behind `asa_sec` — its denominator. */
  asa_sample: number;
}

/**
 * One cell of the IST weekday × hour grid.
 * `dow` uses the SQLite/JS convention: 0 = Sunday … 6 = Saturday.
 */
export interface DowHourCell {
  dow: number;   // 0=Sun … 6=Sat (IST)
  hour: number;  // 0–23 (IST)
  total: number;
  missed: number;
}

export interface LapsedGuest {
  guest_id: string;
  name: string;
  phone_e164: string;
  last_visit_at: string | null;
}

export interface DashboardStats {
  today: {
    calls: number;
    answered: number;
    missed: number;
    answered_pct: number;       // 0–100
    pending_recoveries: number; // current pending|attempting (not window-bound)
    bookings_from_calls: number;
  };
  byDay: { date: string; total: number; answered: number; missed: number }[];
  byHour: { hour: number; total: number; missed: number }[];
  /**
   * 7×24 IST weekday × hour grid, inbound only — the same population as
   * `byHour`, one dimension richer. `byHour` collapses every Monday 20:00 into
   * the same bucket as every Saturday 20:00, so it cannot answer "which SHIFTS
   * are we understaffed on"; this can. Dense: all 168 cells are present
   * (zeros included), ordered dow 0→6 then hour 0→23.
   */
  byDowHour: DowHourCell[];
  /**
   * How many times each weekday actually occurs in the window (index 0 =
   * Sunday) — the denominator behind every heatmap row. 12 calls spread over
   * 13 Saturdays is a different staffing story from 12 over 1.
   */
  weekdayOccurrences: number[];
  /**
   * Inbound calls in the window that carry NO agent id (nobody picked up, so
   * TeleCMI reports no agent on the CDR). These sit in no agent's answer-rate
   * denominator — publish this beside the scorecards or a table full of 100%
   * answer rates is a lie by omission.
   */
  unattributed: { calls: number; missed: number };
  /** Inbound-only CALL → BOOKING funnel over the window (call-linked bookings
   *  only). This is the call-centre view; the guest-facing conversion is
   *  `visit_conversion` below. */
  funnel: { calls: number; answered: number; booked: number; seated: number };
  /**
   * Outlet conversion, bookings → visits: the same rule as the per-guest
   * `visit_conversion_rate`, aggregated over every live booking MADE in the
   * window. `pct` is 0–100 with 1 decimal, and `null` — never 0 — when the
   * window holds no bookings, so the panel can render an em dash instead of a
   * confident zero. Always publish the two counts beside the percentage.
   */
  visit_conversion: { bookings: number; visited: number; pct: number | null };
  recoveryFunnel: { missed: number; attempted: number; recovered: number; booked: number };
  agents: AgentStat[];
  avg_time_to_first_callback_min: number;
  missed_rate: number;   // 0–100, inbound missed ÷ inbound calls
  recovery_rate: number; // 0–100, recovered ÷ missed recoveries
  lapsed: LapsedGuest[];
}

/**
 * Dashboard aggregates over the last `days` IST calendar days (default 7,
 * clamped 1–90; the window always ends at the end of IST today).
 */
export function dashboardStats(db: DB, opts: { days?: number } = {}): DashboardStats {
  const days = Math.min(90, Math.max(1, Math.floor(opts.days ?? 7)));
  const nowMs = Date.now();

  const todayStartMs = istDayStartMs(nowMs);
  const winStartMs = todayStartMs - (days - 1) * DAY_MS;
  const winEndMs = todayStartMs + DAY_MS;
  const todayStart = new Date(todayStartMs).toISOString();
  const winStart = new Date(winStartMs).toISOString();
  const winEnd = new Date(winEndMs).toISOString();

  // ── Today ────────────────────────────────────────────────────────────────
  const t = db.prepare(`
    SELECT COUNT(*)                                                       AS calls,
           SUM(CASE WHEN c.status = 'answered' THEN 1 ELSE 0 END)         AS answered,
           SUM(CASE WHEN c.status IN ${MISSED_FAMILY} THEN 1 ELSE 0 END)  AS missed
    FROM ct_calls c
    WHERE ${CALL_AT} >= ? AND ${CALL_AT} < ? AND c.direction = 'inbound'
  `).get(todayStart, winEnd) as any;

  const pendingRecoveries = db.prepare(`
    SELECT COUNT(*) AS n FROM ct_recoveries WHERE status IN ('pending','attempting')
  `).get() as any;

  // SAFE AT 82k WITHOUT A CHANGE, and worth saying why: BOOKED_AT is an
  // expression and cannot use an index, but `source_call_id IS NOT NULL` can —
  // SQLite seeks idx_ct_bookings_src and never touches the imported rows, which
  // all carry a NULL source_call_id (reservego-import.ts inserts no call link).
  // Measured on the 82,128-row copy: 0.01ms. That same fact is why no
  // is_duplicate filter is needed here — a Reservego row cannot reach this count.
  const bookingsFromCallsToday = db.prepare(`
    SELECT COUNT(*) AS n
    FROM ct_bookings b
    WHERE ${BOOKED_AT} >= ? AND ${BOOKED_AT} < ?
      AND b.source_call_id IS NOT NULL AND b.source_call_id != ''
  `).get(todayStart, winEnd) as any;

  const today = {
    calls: num(t?.calls),
    answered: num(t?.answered),
    missed: num(t?.missed),
    answered_pct: pct(num(t?.answered), num(t?.calls)),
    pending_recoveries: num(pendingRecoveries?.n),
    bookings_from_calls: num(bookingsFromCallsToday?.n),
  };

  // ── Receiving (inbound) volume by IST day / hour ─────────────────────────
  // Inbound-only: device-dialed outbound callbacks must not inflate the
  // "receiving calls" answered/missed/answer-rate volume on the wallboard.
  const dayRows = db.prepare(`
    SELECT date(${CALL_AT}, '+330 minutes')                               AS d,
           COUNT(*)                                                       AS total,
           SUM(CASE WHEN c.status = 'answered' THEN 1 ELSE 0 END)         AS answered,
           SUM(CASE WHEN c.status IN ${MISSED_FAMILY} THEN 1 ELSE 0 END)  AS missed
    FROM ct_calls c
    WHERE ${CALL_AT} >= ? AND ${CALL_AT} < ? AND c.direction = 'inbound'
    GROUP BY d
  `).all(winStart, winEnd) as any[];

  const dayMap = new Map<string, { total: number; answered: number; missed: number }>();
  for (const r of dayRows) {
    if (r.d) dayMap.set(r.d, { total: num(r.total), answered: num(r.answered), missed: num(r.missed) });
  }
  const byDay: DashboardStats['byDay'] = [];
  for (let i = 0; i < days; i++) {
    const date = istDateStr(winStartMs + i * DAY_MS);
    const row = dayMap.get(date);
    byDay.push({ date, total: row?.total ?? 0, answered: row?.answered ?? 0, missed: row?.missed ?? 0 });
  }

  const hourRows = db.prepare(`
    SELECT CAST(strftime('%H', ${CALL_AT}, '+330 minutes') AS INTEGER)    AS h,
           COUNT(*)                                                       AS total,
           SUM(CASE WHEN c.status IN ${MISSED_FAMILY} THEN 1 ELSE 0 END)  AS missed
    FROM ct_calls c
    WHERE ${CALL_AT} >= ? AND ${CALL_AT} < ? AND c.direction = 'inbound'
    GROUP BY h
  `).all(winStart, winEnd) as any[];

  const hourMap = new Map<number, { total: number; missed: number }>();
  for (const r of hourRows) {
    if (r.h !== null && r.h !== undefined) hourMap.set(Number(r.h), { total: num(r.total), missed: num(r.missed) });
  }
  const byHour: DashboardStats['byHour'] = [];
  for (let h = 0; h < 24; h++) {
    const row = hourMap.get(h);
    byHour.push({ hour: h, total: row?.total ?? 0, missed: row?.missed ?? 0 });
  }

  // ── Weekday × hour grid (staffing heatmap) ───────────────────────────────
  // Same population and filters as byHour above (inbound, same window) so the
  // two can never disagree: summing a heatmap column reproduces byHour, and
  // summing the whole grid reproduces funnel.calls.
  const dowHourRows = db.prepare(`
    SELECT CAST(strftime('%w', ${CALL_AT}, '+330 minutes') AS INTEGER)    AS w,
           CAST(strftime('%H', ${CALL_AT}, '+330 minutes') AS INTEGER)    AS h,
           COUNT(*)                                                       AS total,
           SUM(CASE WHEN c.status IN ${MISSED_FAMILY} THEN 1 ELSE 0 END)  AS missed
    FROM ct_calls c
    WHERE ${CALL_AT} >= ? AND ${CALL_AT} < ? AND c.direction = 'inbound'
    GROUP BY w, h
  `).all(winStart, winEnd) as any[];

  const dowHourMap = new Map<string, { total: number; missed: number }>();
  for (const r of dowHourRows) {
    if (r.w === null || r.w === undefined || r.h === null || r.h === undefined) continue;
    dowHourMap.set(`${Number(r.w)}:${Number(r.h)}`, { total: num(r.total), missed: num(r.missed) });
  }
  const byDowHour: DowHourCell[] = [];
  for (let w = 0; w < 7; w++) {
    for (let h = 0; h < 24; h++) {
      const cell = dowHourMap.get(`${w}:${h}`);
      byDowHour.push({ dow: w, hour: h, total: cell?.total ?? 0, missed: cell?.missed ?? 0 });
    }
  }

  // Weekday occurrences in the window — walk the same IST days byDay walks.
  const weekdayOccurrences = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < days; i++) {
    // Shifting by the IST offset makes getUTCDay() read the IST weekday.
    const dow = new Date(winStartMs + i * DAY_MS + IST_OFFSET_MIN * 60_000).getUTCDay();
    weekdayOccurrences[dow]++;
  }

  // Inbound calls nobody was attached to (ring-group misses) — the honesty
  // footnote for the per-agent answer rates below.
  const un = db.prepare(`
    SELECT COUNT(*)                                                       AS calls,
           SUM(CASE WHEN c.status IN ${MISSED_FAMILY} THEN 1 ELSE 0 END)  AS missed
    FROM ct_calls c
    WHERE ${CALL_AT} >= ? AND ${CALL_AT} < ? AND c.direction = 'inbound' AND c.agent_user = ''
  `).get(winStart, winEnd) as any;
  const unattributed = { calls: num(un?.calls), missed: num(un?.missed) };

  // ── Conversion funnel (inbound) ──────────────────────────────────────────
  const f = db.prepare(`
    SELECT COUNT(*)                                                       AS calls,
           SUM(CASE WHEN c.status = 'answered' THEN 1 ELSE 0 END)         AS answered,
           SUM(CASE WHEN c.status IN ${MISSED_FAMILY} THEN 1 ELSE 0 END)  AS missed
    FROM ct_calls c
    WHERE c.direction = 'inbound' AND ${CALL_AT} >= ? AND ${CALL_AT} < ?
  `).get(winStart, winEnd) as any;

  // Index-backed on source_call_id like bookings_from_calls above (0.01ms at
  // 82,128 rows) and, for the same reason, structurally free of Reservego rows.
  const fb = db.prepare(`
    SELECT COUNT(*)                                                            AS booked,
           SUM(CASE WHEN b.status IN ('seated','completed') THEN 1 ELSE 0 END) AS seated
    FROM ct_bookings b
    WHERE ${BOOKED_AT} >= ? AND ${BOOKED_AT} < ?
      AND b.source_call_id IS NOT NULL AND b.source_call_id != ''
  `).get(winStart, winEnd) as any;

  const funnel = {
    calls: num(f?.calls),
    answered: num(f?.answered),
    booked: num(fb?.booked),
    seated: num(fb?.seated),
  };

  // ── Outlet conversion: bookings → visits (RATIO OF TOTALS) ────────────────
  // Same population and same rule as the per-guest visit_conversion_rate
  // (status seated|completed over every live booking), aggregated by summing
  // the two integers — NOT by averaging per-guest ratios, which would weight a
  // one-booking guest like a forty-booking guest and answer a different
  // question ("the average guest's hit rate" instead of "of the bookings we
  // took, how many turned up"). The two are not the same number: measured on
  // the production copy, ratio of totals 23/40 = 57.5% against a mean of
  // per-guest ratios of 55.8%. It is computed HERE, in SQL, as two integers,
  // precisely so there is no array of per-guest ratios in this code path for a
  // later edit to average by mistake — dashboardStats must never load
  // per-guest metrics.
  //
  // Cohort anchor is BOOKED_AT (when the booking was MADE), matching
  // funnel.booked above so both panels bound the same rows the same way.
  // Unlike the funnel this counts ALL live bookings, not just call-linked ones
  // — which is the whole point: a guest who booked and dined without ever
  // ringing us belongs in the outlet's conversion.
  const vc = db.prepare(`
    SELECT COUNT(*)                                                            AS bookings,
           SUM(CASE WHEN b.status IN ('seated','completed') THEN 1 ELSE 0 END) AS visited
    FROM ct_bookings b
    WHERE ${BOOKED_AT} >= ? AND ${BOOKED_AT} < ? AND ${LIVE_ONLY}
  `).get(winStart, winEnd) as any;

  const visitConversion = {
    bookings: num(vc?.bookings),
    visited: num(vc?.visited),
    pct: num(vc?.bookings) > 0 ? pct(num(vc?.visited), num(vc?.bookings)) : null,
  };

  // ── Recovery funnel + headline KPIs ──────────────────────────────────────
  //
  // `missed` HERE COUNTS CALLBACK TASKS, NOT RINGS — and that is deliberate.
  // Since one call that rings a hunt group files ONE task rather than one per
  // ring (absorbIntoOpenRecovery in ./ingest.ts), this number is no longer the
  // same as the missed-call count on /crm-calls/missed-attribution, which
  // counts ct_calls rows. They measure different things: this is a funnel about
  // WORK — a task is attempted, recovered, booked — and a ring cannot be
  // attempted, only a task can. Every stage below is per-row, so counting rings
  // at the top would make the funnel's own percentages wrong.
  //
  // Expect a one-off step DOWN in this figure on the day the merge shipped:
  // fewer duplicate tasks, not fewer missed guests. Rows created before that
  // day are per-ring and are deliberately left alone (owner's instruction), so
  // history is not restated.
  const rf = db.prepare(`
    SELECT COUNT(*)                                                                 AS missed,
           SUM(CASE WHEN first_attempt_at IS NOT NULL THEN 1 ELSE 0 END)            AS attempted,
           SUM(CASE WHEN status = 'recovered' THEN 1 ELSE 0 END)                    AS recovered,
           SUM(CASE WHEN recovery_booking_id IS NOT NULL AND recovery_booking_id != ''
                    THEN 1 ELSE 0 END)                                              AS booked
    FROM ct_recoveries
    WHERE missed_at >= ? AND missed_at < ?
  `).get(winStart, winEnd) as any;

  const recoveryFunnel = {
    missed: num(rf?.missed),
    attempted: num(rf?.attempted),
    recovered: num(rf?.recovered),
    booked: num(rf?.booked),
  };

  const cb = db.prepare(`
    SELECT AVG((julianday(first_attempt_at) - julianday(missed_at)) * 1440.0) AS m
    FROM ct_recoveries
    WHERE missed_at >= ? AND missed_at < ? AND first_attempt_at IS NOT NULL
  `).get(winStart, winEnd) as any;

  // ── Agent leaderboard ────────────────────────────────────────────────────
  //
  // WHICH ct_calls ROWS THE LEADERBOARD IS ALLOWED TO COUNT.
  //
  // Almost every row here is a TeleCMI CDR: the PBX timed it, nobody in the
  // building can author it, and it carries duration_source = ''. The exception
  // is the Call Back flow (src/app/api/crm-calls/calls/log-callback/route.ts):
  // the plan has no outbound package, so a GRE dials from their own handset and
  // POSTs the app an account of the call. That INSERT is a whole ct_calls row —
  // direction 'outbound', status 'answered' when connected — written entirely
  // from a request body. `handled` is the leaderboard's DEFAULT SORT KEY, so
  // those rows do not merely inflate a number, they reorder a ranking a manager
  // reads. The route's de-dupe window and per-agent burst cap BOUND how many can
  // be created; this is the filter that stops the ones that get through from
  // counting.
  //
  // WHAT THIS EXCLUDES — and nothing beyond it:
  //   duration_source != ''  AND  duration_verified = 0
  //   i.e. a row the Call Back flow wrote (self-logged) that the server never
  //   bounded against its own clock (unvouched). See src/lib/ct/call-token.ts
  //   for what "bounded" means and src/lib/ct/duration-trust.ts for how the same
  //   two columns are read on screen.
  //
  // WHAT IT DELIBERATELY DOES **NOT** DO:
  //   · It does not touch a PBX CDR. Those carry duration_source = '', so all
  //     inbound work is counted exactly as before — the filter is a no-op on it.
  //   · It does not retro-delete history. A callback logged BEFORE the token
  //     mechanism shipped also carries '' (the ALTER back-filled it) and KEEPS
  //     counting. Those are real calls by real staff that cannot be verified
  //     after the fact; silently erasing months of a GRE's recorded work from
  //     the leaderboard would be a worse wrong than the fabrication risk.
  //   · It does not punish a verified callback. duration_verified = 1 counts,
  //     which is the whole point of minting the token.
  //   · It is NOT fraud detection and proves nothing about any individual row.
  //     An unvouched row is usually just an iPhone or an offline mint. This only
  //     says such a row may not MOVE A RANKING.
  //   · It does not reach outside the leaderboard's CALL COUNTS. `bookings` and
  //     `recoveries_handled`/`avg_callback_min` are left whole — each carries
  //     its own note below saying why, and the recovery note also records what
  //     that leaves open. Every CALL-based figure above this section
  //     (today.calls/answered/missed, byDay, byHour, byDowHour, unattributed,
  //     funnel.calls/answered, missed_rate) is already restricted to
  //     direction = 'inbound', and only the outbound Call Back route ever writes
  //     duration_source, so the filter would change none of them; the remaining
  //     figures up there are booking- or recovery-based and are not call counts
  //     at all. The guest-level metrics at the top of this file also stay whole
  //     on purpose: total_calls is "how many rows exist for this guest", and it
  //     has to keep agreeing with the Call Log page, which lists every row and
  //     MARKS the self-logged ones rather than hiding them.
  const COUNTABLE_CALL = `NOT (c.duration_source != '' AND c.duration_verified = 0)`;

  const agentMap = new Map<string, AgentStat>();
  const ensureAgent = (agent: string): AgentStat => {
    let a = agentMap.get(agent);
    if (!a) {
      a = {
        agent, handled: 0, bookings: 0, recoveries_handled: 0, avg_callback_min: 0,
        inbound_calls: 0, inbound_answered: 0, answer_rate: 0,
        outbound_calls: 0, outbound_answered: 0, connect_rate: 0,
        asa_sec: 0, asa_sample: 0,
      };
      agentMap.set(agent, a);
    }
    return a;
  };

  const handledRows = db.prepare(`
    SELECT c.agent_user AS agent, COUNT(*) AS n
    FROM ct_calls c
    WHERE c.status = 'answered' AND c.agent_user != ''
      AND ${COUNTABLE_CALL}
      AND ${CALL_AT} >= ? AND ${CALL_AT} < ?
    GROUP BY c.agent_user
  `).all(winStart, winEnd) as any[];
  for (const r of handledRows) ensureAgent(r.agent).handled = num(r.n);

  // Volume split by direction + average speed of answer, one pass.
  // COUNTABLE_CALL is applied HERE TOO, and that is not belt-and-braces: these
  // columns render in the same table row as `handled`, and direction is only
  // ever 'inbound' or 'outbound', so handled == inbound_answered +
  // outbound_answered is an identity a manager can see. Filtering one side only
  // would print a row that does not add up, which is worse than a row that
  // overcounts. connect_rate needs it for its own sake as well — it is a sort
  // key too, and a fabricated "connected" callback is a free 100%. On the
  // inbound columns it is provably a no-op — only the outbound Call Back route
  // ever writes duration_source, so no inbound row can fail the predicate.
  //
  // ASA is INBOUND-ONLY on purpose: on an outbound callback the gap between
  // started_at and answered_at is how long the GUEST took to pick up, which
  // says nothing about the agent. Rows missing either timestamp, and rows
  // where answered_at precedes started_at (clock skew / bad CDR), are excluded
  // from the average AND from asa_sample so the denominator stays truthful.
  const ANSWERED_AT = `REPLACE(c.answered_at, ' ', 'T')`;
  const ASA_OK = `c.direction = 'inbound' AND c.status = 'answered'
                  AND c.answered_at IS NOT NULL AND c.answered_at != ''
                  AND ${ANSWERED_AT} >= ${CALL_AT}`;
  const agentVolumeRows = db.prepare(`
    SELECT c.agent_user                                                          AS agent,
           SUM(CASE WHEN c.direction = 'inbound'  THEN 1 ELSE 0 END)             AS inbound_calls,
           SUM(CASE WHEN c.direction = 'inbound'  AND c.status = 'answered'
                    THEN 1 ELSE 0 END)                                           AS inbound_answered,
           SUM(CASE WHEN c.direction = 'outbound' THEN 1 ELSE 0 END)             AS outbound_calls,
           SUM(CASE WHEN c.direction = 'outbound' AND c.status = 'answered'
                    THEN 1 ELSE 0 END)                                           AS outbound_answered,
           SUM(CASE WHEN ${ASA_OK} THEN 1 ELSE 0 END)                            AS asa_sample,
           AVG(CASE WHEN ${ASA_OK}
                    THEN (julianday(${ANSWERED_AT}) - julianday(${CALL_AT})) * 86400.0
               END)                                                              AS asa_sec
    FROM ct_calls c
    WHERE c.agent_user != '' AND ${COUNTABLE_CALL}
      AND ${CALL_AT} >= ? AND ${CALL_AT} < ?
    GROUP BY c.agent_user
  `).all(winStart, winEnd) as any[];
  for (const r of agentVolumeRows) {
    const a = ensureAgent(r.agent);
    a.inbound_calls = num(r.inbound_calls);
    a.inbound_answered = num(r.inbound_answered);
    a.answer_rate = pct(a.inbound_answered, a.inbound_calls);
    a.outbound_calls = num(r.outbound_calls);
    a.outbound_answered = num(r.outbound_answered);
    a.connect_rate = pct(a.outbound_answered, a.outbound_calls);
    a.asa_sample = num(r.asa_sample);
    a.asa_sec = a.asa_sample > 0 ? round1(num(r.asa_sec)) : 0;
  }

  // NO COUNTABLE_CALL HERE, on purpose. This counts BOOKINGS, not calls: the
  // call row is only the attribution key. A booking is a separate artifact with
  // a guest, a date and a cover count that the floor either honours or does not,
  // and it is not conjured by a duration claim — faking one is a different and
  // far louder act than mistyping a talk time. Dropping a real reservation off
  // an agent's card because the callback it came from was logged from an iPhone
  // would delete work that actually happened. Consequence to know: an agent can
  // show bookings > 0 with handled = 0. That reads correctly (we credit the
  // booking, we do not credit an unvouched call) and it is not a contradiction
  // the way a mismatched handled/answered pair would be.
  //
  // The `source_call_id IS NOT NULL` half is redundant to the JOIN and is here
  // for the planner: without it SQLite drove the join from a full SCAN of
  // ct_bookings — 15.8ms on the 82,128-row copy, all of it spent on imported
  // rows that can never match a call — and with it the same query seeks
  // idx_ct_bookings_src and returns in 0.01ms.
  const agentBookingRows = db.prepare(`
    SELECT c.agent_user AS agent, COUNT(*) AS n
    FROM ct_bookings b
    JOIN ct_calls c ON c.id = b.source_call_id
    WHERE b.source_call_id IS NOT NULL AND b.source_call_id != ''
      AND c.agent_user != ''
      AND ${BOOKED_AT} >= ? AND ${BOOKED_AT} < ?
    GROUP BY c.agent_user
  `).all(winStart, winEnd) as any[];
  for (const r of agentBookingRows) ensureAgent(r.agent).bookings = num(r.n);

  // NO COUNTABLE_CALL HERE either — there is nothing here to apply it to. These
  // read ct_recoveries, which has no duration columns: a recovery is opened by
  // an inbound MISS the PBX reported (ingest.ts openRecovery), missed_at comes
  // off that CDR, and first_attempt_at is the SERVER's own clock at the moment
  // the attempt was recorded. So no claimed talk time enters either figure — a
  // fabricated DURATION cannot move recoveries_handled or avg_callback_min.
  //
  // BE HONEST ABOUT WHAT IS STILL OPEN. Logging a callback against an open
  // recovery sets first_attempt_at, so a fabricated callback ROW can still mark
  // a real recovery as attempted — inflating recoveries_handled and pulling
  // avg_callback_min down. That is a different hole with a different shape and
  // this filter is the wrong tool for it: a recovery can also be advanced to
  // 'attempting' straight from /api/crm-calls/recoveries/[id] with no ct_calls
  // row in existence, so keying the recovery columns off call verification would
  // punish one honest path and miss the other. Fixing it means gating the
  // ATTEMPT, not the metric. Noted here so the next reader does not mistake the
  // leaderboard filter above for cover it never gave.
  const agentRecoveryRows = db.prepare(`
    SELECT assigned_to AS agent,
           COUNT(*)                                                              AS n,
           AVG((julianday(first_attempt_at) - julianday(missed_at)) * 1440.0)    AS avg_min
    FROM ct_recoveries
    WHERE assigned_to != '' AND first_attempt_at IS NOT NULL
      AND missed_at >= ? AND missed_at < ?
    GROUP BY assigned_to
  `).all(winStart, winEnd) as any[];
  for (const r of agentRecoveryRows) {
    const a = ensureAgent(r.agent);
    a.recoveries_handled = num(r.n);
    a.avg_callback_min = round1(num(r.avg_min));
  }

  const agents = [...agentMap.values()].sort(
    (a, b) => b.handled - a.handled || b.bookings - a.bookings || a.agent.localeCompare(b.agent)
  );

  // ── Lapsed guests (win-back list) ────────────────────────────────────────
  const lapsedCutoff = istDateStr(nowMs - LAPSED_DAYS * DAY_MS);
  // AGGREGATE THE BOOKINGS FIRST, THEN NAME THE 20 GUESTS. Grouping by g.id
  // made ct_guests the driving table, so the plan was "scan all 70,324 guests,
  // probe the bookings index once each" — 52.4ms on the copy, of which 70,304
  // guests were only ever going to be thrown away by the LIMIT. Grouping
  // ct_bookings by guest_id and joining ct_guests to the surviving 20 is 30.6ms
  // and, more to the point, stops growing with the guest table.
  const lapsedRows = db.prepare(`
    SELECT g.id AS guest_id, g.name, g.phone_e164, x.last_visit_at
    FROM (
      SELECT b.guest_id AS gid, MAX(${VISIT_AT}) AS last_visit_at
      FROM ct_bookings b
      WHERE b.status IN ('seated','completed') AND ${LIVE_ONLY}
      GROUP BY b.guest_id
      HAVING MAX(${VISIT_AT}) < ?
      ORDER BY last_visit_at DESC
      LIMIT 20
    ) x
    JOIN ct_guests g ON g.id = x.gid
    ORDER BY x.last_visit_at DESC
  `).all(lapsedCutoff) as any[];

  const lapsed: LapsedGuest[] = lapsedRows.map((r) => ({
    guest_id: r.guest_id,
    name: r.name || '',
    phone_e164: r.phone_e164 || '',
    last_visit_at: r.last_visit_at || null,
  }));

  return {
    today,
    byDay,
    byHour,
    byDowHour,
    weekdayOccurrences,
    unattributed,
    funnel,
    visit_conversion: visitConversion,
    recoveryFunnel,
    agents,
    avg_time_to_first_callback_min: round1(num(cb?.m)),
    missed_rate: pct(num(f?.missed), num(f?.calls)),
    recovery_rate: pct(recoveryFunnel.recovered, recoveryFunnel.missed),
    lapsed,
  };
}
