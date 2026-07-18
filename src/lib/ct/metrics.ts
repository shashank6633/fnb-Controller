/**
 * Call-to-Table CRM metrics — pure SQL aggregates over the ct_ tables.
 *
 * Inputs are UTC ISO timestamps (the module convention); outputs are plain
 * numbers/strings for the API layer. Day/hour bucketing and "today" windows
 * are IST (Asia/Kolkata, +05:30, no DST) because that is the operating
 * timezone of the venue — callers pass nothing timezone-related.
 *
 * Percentage fields (`answered_pct`, `missed_rate`, `recovery_rate`) are
 * 0–100 numbers rounded to 1 decimal. `conversion_rate` is a RATIO
 * (bookings ÷ answered inbound calls, 2 decimals, 0-safe, may exceed 1).
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
/** Conversion ratio, 2 decimals, 0-safe, capped at 1.0 (100%). A guest can book
 *  more than once per answered call (repeat bookings, multi-channel), but a
 *  "conversion rate" over 100% reads as broken — the repeat signal lives in the
 *  bookings count and the REPEAT badge instead. */
const ratio = (num: number, den: number) => (den > 0 ? Math.min(1, Math.round((num / den) * 100) / 100) : 0);
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
  last_call_at: string | null;
  total_bookings: number;
  completed_visits: number;
  no_shows: number;
  last_visit_at: string | null;
  /** bookings ÷ answered inbound calls (ratio, 0-safe, 2 decimals). */
  conversion_rate: number;
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
    last_call_at: null,
    total_bookings: 0,
    completed_visits: 0,
    no_shows: 0,
    last_visit_at: null,
    conversion_rate: 0,
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
    last_call_at: ca.last_call_at,
    total_bookings: ba.total_bookings,
    completed_visits: ba.completed_visits,
    no_shows: ba.no_shows,
    last_visit_at: ba.last_visit_at,
    conversion_rate: ratio(ba.total_bookings, ca.answered_inbound),
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
      WHERE b.guest_id IN (${ph})
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
  handled: number;            // answered calls handled in the window
  bookings: number;           // bookings attributed to this agent's calls
  recoveries_handled: number; // recoveries assigned to them with ≥1 attempt
  avg_callback_min: number;   // avg missed_at → first_attempt_at (minutes)
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
  /** Inbound-only conversion funnel over the window. */
  funnel: { calls: number; answered: number; booked: number; seated: number };
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

  // ── Conversion funnel (inbound) ──────────────────────────────────────────
  const f = db.prepare(`
    SELECT COUNT(*)                                                       AS calls,
           SUM(CASE WHEN c.status = 'answered' THEN 1 ELSE 0 END)         AS answered,
           SUM(CASE WHEN c.status IN ${MISSED_FAMILY} THEN 1 ELSE 0 END)  AS missed
    FROM ct_calls c
    WHERE c.direction = 'inbound' AND ${CALL_AT} >= ? AND ${CALL_AT} < ?
  `).get(winStart, winEnd) as any;

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

  // ── Recovery funnel + headline KPIs ──────────────────────────────────────
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
  const agentMap = new Map<string, AgentStat>();
  const ensureAgent = (agent: string): AgentStat => {
    let a = agentMap.get(agent);
    if (!a) {
      a = { agent, handled: 0, bookings: 0, recoveries_handled: 0, avg_callback_min: 0 };
      agentMap.set(agent, a);
    }
    return a;
  };

  const handledRows = db.prepare(`
    SELECT c.agent_user AS agent, COUNT(*) AS n
    FROM ct_calls c
    WHERE c.status = 'answered' AND c.agent_user != ''
      AND ${CALL_AT} >= ? AND ${CALL_AT} < ?
    GROUP BY c.agent_user
  `).all(winStart, winEnd) as any[];
  for (const r of handledRows) ensureAgent(r.agent).handled = num(r.n);

  const agentBookingRows = db.prepare(`
    SELECT c.agent_user AS agent, COUNT(*) AS n
    FROM ct_bookings b
    JOIN ct_calls c ON c.id = b.source_call_id
    WHERE c.agent_user != ''
      AND ${BOOKED_AT} >= ? AND ${BOOKED_AT} < ?
    GROUP BY c.agent_user
  `).all(winStart, winEnd) as any[];
  for (const r of agentBookingRows) ensureAgent(r.agent).bookings = num(r.n);

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
  const lapsedRows = db.prepare(`
    SELECT g.id AS guest_id, g.name, g.phone_e164, MAX(${VISIT_AT}) AS last_visit_at
    FROM ct_bookings b
    JOIN ct_guests g ON g.id = b.guest_id
    WHERE b.status IN ('seated','completed')
    GROUP BY g.id
    HAVING MAX(${VISIT_AT}) < ?
    ORDER BY last_visit_at DESC
    LIMIT 20
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
    funnel,
    recoveryFunnel,
    agents,
    avg_time_to_first_callback_min: round1(num(cb?.m)),
    missed_rate: pct(num(f?.missed), num(f?.calls)),
    recovery_rate: pct(recoveryFunnel.recovered, recoveryFunnel.missed),
    lapsed,
  };
}
