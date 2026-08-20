/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { getAgentMap, getUserNamesByEmail, resolveAgentLabel } from '@/lib/ct/agents';

/**
 * CRM — Missed-call attribution (GET /api/crm-calls/missed-attribution).
 * Management only (admin | manager | HOD), same gate as every other mgmtOnly
 * report route: getCurrentUser() + isManagement() → 403 'Management only'.
 *
 * ── THE QUESTION THIS ANSWERS, AND THE ONE IT REFUSES TO ────────────────────
 * Asked: "how many times has each GRE missed a call?" The telephony data
 * cannot answer that, and this route is built so no caller can make it look
 * like it did.
 *
 * A TeleCMI CDR names an agent on the call it was ANSWERED by. Nobody answered
 * a missed call, so TeleCMI names nobody. Measured on a read-only copy of the
 * local database the day this route was written (120 ct_calls rows spanning
 * 2026-06-19 → 2026-07-18). These counts are LOCAL/seeded data, quoted to show
 * the SHAPE of the problem, not production volumes — re-measure before quoting
 * them anywhere; the shape is what the code depends on:
 *
 *   answered                     84 rows,  0 with no agent
 *   missed                       28 rows, 25 with no agent
 *   abandoned                     7 rows,  7 with no agent
 *   voicemail                     1 row,   1 with no agent
 *   INBOUND missed-family        33 rows,  0 with an agent   ← the report's set
 *   the 3 missed rows that DO name an agent are all OUTBOUND
 *
 * That last line is the trap. The only missed-family rows carrying an agent id
 * on this data are calls WE placed that the guest did not pick up. Counting
 * those as "misses by agent" would print a GRE's name next to a number that
 * measures the guest's behaviour, not theirs. So:
 *
 *   - The report's population is INBOUND missed-family only
 *     (status in missed | abandoned | voicemail — the same MISSED_FAMILY set
 *     src/lib/ct/ingest.ts uses to decide what enters the recovery workflow).
 *   - Unanswered OUTBOUND attempts are counted separately, under their own
 *     name, and are never added to anything (`outbound_unanswered`).
 *   - by_team is the primary view: the ring group is what the CDR actually
 *     records for a missed call.
 *   - by_agent covers ONLY the inbound rows that name one, and ships with
 *     `partial: true` plus the counts needed to say how partial. It is not a
 *     per-GRE miss count and must never be rendered as one — a ring group
 *     rings several phones and the CDR does not say whose rang.
 *
 * ── RECOVERY USES THE EXISTING LIFECYCLE, NOT A SECOND DEFINITION ───────────
 * "Recovered" here is exactly what the Recovery Queue means by it:
 * ct_recoveries.status IN ('recovered', 'auto_resolved'). That pair is the
 * queue page's own Recovered tab (src/app/crm-calls/recovery/page.tsx, the
 * tab's statuses string), the RESOLVED set in the log-callback route, and the
 * RESOLVED_STATUSES list in the recoveries/[id] route. One definition, three
 * existing readers, now four.
 *
 * Each missed-family call gets at most one recovery row (ct_recoveries.call_id
 * is UNIQUE), so the LEFT JOIN cannot fan a call out into several rows and no
 * count here can double.
 *
 * TIME-TO-RECOVER IS ONLY MEASURABLE ON SOME OF THEM. recovered_at is written
 * by the four paths that set status='recovered': manual resolve
 * (recoveries/[id]), a logged callback that reached the guest (log-callback),
 * booking attribution (attributeBooking), and a Call Log disposition other
 * than follow_up_needed (calls/[id]). The auto-resolve path
 * in ingest.ts — guest rang back and we answered — sets status='auto_resolved'
 * and leaves recovered_at NULL. On the copy: 8 of 8 'recovered' rows carry
 * recovered_at, 0 of 11 'auto_resolved' rows do. The timing block therefore
 * reports over `timed` rows only and states `untimed_recovered` alongside it,
 * so the median is never mistaken for a median over all recoveries.
 *
 * ── WHAT THIS ROUTE DELIBERATELY DOES NOT DO ────────────────────────────────
 * It does not call sweep(). The recovery queue calls it because it is a
 * worklist; this is a report and must not mutate rows as a side effect of
 * being read. Nothing in the headline is affected: expireOverdueRecoveries()
 * only moves 'pending' → 'expired' (and sets escalated), never into a
 * recovered state, and both sides of that move sit outside `recovered`.
 * reconcileLiveEvents() can turn a 5-minute-stale 'ringing' row into a missed
 * one — a call still marked 'ringing' is in NO bucket here, which is why
 * `unsettled_ringing` is reported rather than quietly dropped.
 *
 * ── QUERY SHAPE ─────────────────────────────────────────────────────────────
 * ct_calls grows forever, so nothing here is unbounded: the window is required
 * (defaulted, validated, and capped at MAX_RANGE_DAYS), every figure comes
 * from a GROUP BY / single-row aggregate rather than row lists, the two
 * breakdown queries carry a LIMIT with a truncation flag, and the median is
 * two rows fetched at an OFFSET. Six statements, no per-row follow-up.
 *
 * Query params: from, to — YYYY-MM-DD, IST calendar days, inclusive both ends.
 * Default window is the last 7 IST days (a restaurant week, today included).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Same set ingest.ts routes into the recovery workflow. */
const MISSED_FAMILY_SQL = `('missed', 'abandoned', 'voicemail')`;
/** The Recovery Queue's own definition of a resolved recovery. */
const RECOVERED_SQL = `r.status IN ('recovered', 'auto_resolved')`;
const OPEN_SQL = `r.status IN ('pending', 'attempting')`;
/**
 * NOT "closed". Both of these are still workable, and the Recovery Queue says
 * so out loud: isWorkable() there admits everything except recovered and
 * auto_resolved, and 'expired' is reached BY A CLOCK — expireOverdueRecoveries()
 * moves pending → expired at 2× SLA with nobody touching the row. Calling that
 * bucket "closed, not recovered" would tell a manager the work is finished on
 * calls the queue is still offering Attempt / WhatsApp / Mark recovered on.
 * These are stalled: past their SLA or marked unreachable, and still chaseable.
 */
const STALLED_SQL = `r.status IN ('unreachable', 'expired')`;

/**
 * When a call happened. CDR upserts fill started_at; a live ring row may only
 * have created_at, which sqlite defaults to 'YYYY-MM-DD HH:MM:SS' while every
 * app-written timestamp is ISO 'YYYY-MM-DDTHH:MM:SS.sssZ'. Swapping the space
 * for a T makes both forms compare correctly against an ISO bound (both are
 * UTC) — the same expression metrics.ts uses for the same reason.
 */
const CALL_AT = `REPLACE(COALESCE(NULLIF(c.started_at, ''), c.created_at), ' ', 'T')`;

/** Minutes from the miss to the recovery. julianday() parses both the ISO 'Z'
 *  form and sqlite's space form, and returns NULL on anything it cannot read
 *  (which AVG/SUM then skip rather than counting as zero). */
const MINUTES_SQL = `(julianday(r.recovered_at) - julianday(r.missed_at)) * 1440.0`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;
/** A quarter. Long enough for any seasonal question, short enough that the
 *  window can never become "the whole table" as ct_calls grows. */
const MAX_RANGE_DAYS = 92;
const DEFAULT_RANGE_DAYS = 7;
/** Breakdown-row ceiling. Team + agent ids come from the PBX, so treat their
 *  cardinality as unknown and flag truncation instead of trusting it. */
const BREAKDOWN_LIMIT = 100;

/** Today's IST calendar date as YYYY-MM-DD. */
function istToday(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Shift a YYYY-MM-DD calendar date by whole days. */
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** An IST calendar day boundary as the UTC instant it actually is. Duplicated
 *  from the Call Log route rather than shared: it is four lines, and this file
 *  owns nothing outside itself. */
function istDayToUtcIso(date: string, endOfDay: boolean): string {
  return new Date(`${date}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:30`).toISOString();
}

const int = (v: unknown) => Number(v) || 0;
const round1 = (n: number) => Math.round(n * 10) / 10;
/** 0–100, one decimal, 0-safe. */
const pct = (num: number, den: number) => (den > 0 ? round1((num / den) * 100) : 0);

interface BreakdownRow {
  missed: number;
  recovered: number;
  open: number;
  stalled: number;
  untracked: number;
  recovered_pct: number;
  timed: number;
  untimed_recovered: number;
  avg_minutes: number | null;
}

/** The per-group columns, shared by the team and agent breakdowns so the two
 *  tables can never drift into meaning different things. */
const BREAKDOWN_COLUMNS = `
  COUNT(*) AS missed,
  SUM(CASE WHEN ${RECOVERED_SQL} THEN 1 ELSE 0 END) AS recovered,
  SUM(CASE WHEN ${OPEN_SQL} THEN 1 ELSE 0 END) AS open_now,
  SUM(CASE WHEN ${STALLED_SQL} THEN 1 ELSE 0 END) AS stalled,
  SUM(CASE WHEN r.id IS NULL THEN 1 ELSE 0 END) AS untracked,
  -- RECOVERED_SQL is required here, not decoration. 'unreachable' is the one
  -- action with no already-resolved guard (recoveries/[id]), so a row can be
  -- marked unreachable with recovered_at still set. Without this clause that
  -- row counts as stalled AND lands in the median, and the page then describes
  -- the median as covering recovered calls.
  SUM(CASE WHEN ${RECOVERED_SQL} AND COALESCE(r.recovered_at, '') <> '' AND ${MINUTES_SQL} >= 0 THEN 1 ELSE 0 END) AS timed,
  -- Counted directly rather than as (recovered - timed): by subtraction, a row
  -- with a negative or unparseable span falls in here too, and the page states
  -- a cause for it ("the guest rang back") that is not its cause.
  SUM(CASE WHEN ${RECOVERED_SQL} AND COALESCE(r.recovered_at, '') = '' THEN 1 ELSE 0 END) AS untimed_recovered,
  AVG(CASE WHEN ${RECOVERED_SQL} AND COALESCE(r.recovered_at, '') <> '' AND ${MINUTES_SQL} >= 0 THEN ${MINUTES_SQL} END) AS avg_minutes
`;

function breakdownRow(r: any): BreakdownRow {
  // Over an empty window every SUM() is NULL, so read every field defensively.
  const missed = int(r?.missed);
  const recovered = int(r?.recovered);
  return {
    missed,
    recovered,
    open: int(r?.open_now),
    stalled: int(r?.stalled),
    untracked: int(r?.untracked),
    recovered_pct: pct(recovered, missed),
    timed: int(r?.timed),
    untimed_recovered: int(r?.untimed_recovered),
    avg_minutes: r?.avg_minutes === null || r?.avg_minutes === undefined ? null : round1(Number(r.avg_minutes)),
  };
}

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not signed in' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const today = istToday();

  const to = (sp.get('to') || '').trim() || today;
  const from = (sp.get('from') || '').trim() || shiftDate(to, -(DEFAULT_RANGE_DAYS - 1));

  if (!DATE_RE.test(from)) return Response.json({ error: 'from must be YYYY-MM-DD' }, { status: 400 });
  if (!DATE_RE.test(to)) return Response.json({ error: 'to must be YYYY-MM-DD' }, { status: 400 });
  if (from > to) return Response.json({ error: 'from must not be after to' }, { status: 400 });

  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return Response.json({ error: 'from/to must be real calendar dates' }, { status: 400 });
  }
  const days = Math.round((toMs - fromMs) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    return Response.json(
      { error: `Range is ${days} days; the maximum is ${MAX_RANGE_DAYS}` },
      { status: 400 },
    );
  }

  const db = getDb();
  const lo = istDayToUtcIso(from, false);
  const hi = istDayToUtcIso(to, true);

  // Population: inbound missed-family calls inside the window. Every query
  // below starts from exactly this set (the outbound and ringing counters name
  // their own difference from it in their own SQL).
  const WINDOW = `${CALL_AT} >= ? AND ${CALL_AT} <= ?`;
  const BASE_WHERE = `c.direction = 'inbound' AND c.status IN ${MISSED_FAMILY_SQL} AND ${WINDOW}`;
  // A LEG THAT WAS ABSORBED IS STILL TRACKED — it just does not OWN the row.
  //
  // ct_recoveries.call_id names only the ONE ring that created the callback
  // task. Since one call that rings a hunt group files ONE task instead of one
  // per ring (see absorbIntoOpenRecovery in src/lib/ct/ingest.ts), a plain
  // `r.call_id = c.id` join leaves rings 2..N with no recovery — and this
  // report counts exactly that as `untracked`. Left alone it would cap
  // recovered_pct at 1/N for every hunt-group call, and fire the warn banner
  // that tells the manager to "check the CDR webhook" — sending him to debug a
  // healthy webhook, every day, because the queue is working as designed.
  //
  // ct_recovery_legs is the ledger of absorbed rings, so resolve each call's
  // task by ownership FIRST and through the ledger second. Written as two
  // scalar subqueries inside COALESCE rather than an OR-join precisely because
  // it must yield exactly one recovery per call: an OR could match two rows and
  // silently double every SUM in this file.
  //
  // The ledger lives in the ct block of initializeSchema(), whose errors are
  // SWALLOWED. If it is somehow absent this must degrade to the old join and
  // still render, never 500 a management report over a missing optimisation.
  let legsLedger = false;
  try {
    legsLedger = !!db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ct_recovery_legs' LIMIT 1`,
    ).get();
  } catch { legsLedger = false; }

  const RECOVERY_FOR_CALL = legsLedger
    ? `r.id = COALESCE(
         (SELECT r2.id FROM ct_recoveries r2 WHERE r2.call_id = c.id),
         (SELECT l.recovery_id FROM ct_recovery_legs l WHERE l.call_id = c.id)
       )`
    : `r.call_id = c.id`;
  const BASE_FROM = `FROM ct_calls c LEFT JOIN ct_recoveries r ON ${RECOVERY_FOR_CALL} WHERE ${BASE_WHERE}`;
  const range = [lo, hi];

  // 1 — headline counts (one row).
  const t = db.prepare(`
    SELECT
      SUM(CASE WHEN c.status = 'missed'    THEN 1 ELSE 0 END) AS st_missed,
      SUM(CASE WHEN c.status = 'abandoned' THEN 1 ELSE 0 END) AS st_abandoned,
      SUM(CASE WHEN c.status = 'voicemail' THEN 1 ELSE 0 END) AS st_voicemail,
      SUM(CASE WHEN TRIM(COALESCE(c.agent_user, '')) <> '' THEN 1 ELSE 0 END) AS with_agent,
      SUM(CASE WHEN TRIM(COALESCE(c.queue, ''))      <> '' THEN 1 ELSE 0 END) AS with_team,
      COUNT(DISTINCT CASE WHEN TRIM(COALESCE(c.queue, '')) <> '' THEN TRIM(c.queue) END) AS teams,
      ${BREAKDOWN_COLUMNS}
    ${BASE_FROM}
  `).get(...range) as any;

  const totals = breakdownRow(t);
  const missed = totals.missed;

  // 2 — recovery-time distribution (one row). Negative spans (recovered_at
  // before missed_at — clock skew or a hand-edited row) are counted on their
  // own line instead of being swept into the fastest band.
  const timing = db.prepare(`
    SELECT
      SUM(CASE WHEN mins IS NOT NULL AND mins <  0 THEN 1 ELSE 0 END) AS negative_span,
      SUM(CASE WHEN mins IS NULL                   THEN 1 ELSE 0 END) AS unparseable,
      AVG(CASE WHEN mins >= 0 THEN mins END) AS avg_minutes,
      MAX(CASE WHEN mins >= 0 THEN mins END) AS max_minutes,
      SUM(CASE WHEN mins >= 0    AND mins <   15 THEN 1 ELSE 0 END) AS b_under_15m,
      SUM(CASE WHEN mins >= 15   AND mins <   60 THEN 1 ELSE 0 END) AS b_15_60m,
      SUM(CASE WHEN mins >= 60   AND mins <  240 THEN 1 ELSE 0 END) AS b_1_4h,
      SUM(CASE WHEN mins >= 240  AND mins < 1440 THEN 1 ELSE 0 END) AS b_4_24h,
      SUM(CASE WHEN mins >= 1440                 THEN 1 ELSE 0 END) AS b_over_24h
    FROM (
      SELECT ${MINUTES_SQL} AS mins
      ${BASE_FROM} AND ${RECOVERED_SQL} AND COALESCE(r.recovered_at, '') <> ''
    )
  `).get(...range) as any;

  // 3 — median, exactly, without pulling the distribution into memory: two
  // rows at the middle offset. Even count → mean of the pair; odd → the first.
  let medianMinutes: number | null = null;
  if (totals.timed > 0) {
    const offset = Math.floor((totals.timed - 1) / 2);
    const mid = db.prepare(`
      SELECT mins FROM (
        SELECT ${MINUTES_SQL} AS mins
        ${BASE_FROM} AND ${RECOVERED_SQL} AND COALESCE(r.recovered_at, '') <> ''
      )
      WHERE mins >= 0
      ORDER BY mins
      LIMIT 2 OFFSET ${offset}
    `).all(...range) as Array<{ mins: number }>;
    if (mid.length) {
      medianMinutes = totals.timed % 2 === 0 && mid.length === 2
        ? round1((Number(mid[0].mins) + Number(mid[1].mins)) / 2)
        : round1(Number(mid[0].mins));
    }
  }

  // 4 — by TEAM (the ring group that rang). The honest primary view.
  const teamRows = db.prepare(`
    SELECT TRIM(COALESCE(c.queue, '')) AS team, ${BREAKDOWN_COLUMNS}
    ${BASE_FROM}
    GROUP BY TRIM(COALESCE(c.queue, ''))
    ORDER BY missed DESC, team ASC
    LIMIT ${BREAKDOWN_LIMIT}
  `).all(...range) as any[];

  // 5 — by AGENT, over the minority of inbound misses that name one.
  const agentRows = db.prepare(`
    SELECT TRIM(c.agent_user) AS agent, ${BREAKDOWN_COLUMNS}
    ${BASE_FROM} AND TRIM(COALESCE(c.agent_user, '')) <> ''
    GROUP BY TRIM(c.agent_user)
    ORDER BY missed DESC, agent ASC
    LIMIT ${BREAKDOWN_LIMIT}
  `).all(...range) as any[];

  // 6 — the two counters that exist so nothing is silently absent: outbound
  // attempts the guest did not answer, and calls the ingest layer has not
  // settled into answered-or-missed yet.
  const edges = db.prepare(`
    SELECT
      SUM(CASE WHEN c.direction = 'outbound' AND c.status IN ${MISSED_FAMILY_SQL} THEN 1 ELSE 0 END) AS outbound_unanswered,
      SUM(CASE WHEN c.status = 'ringing' THEN 1 ELSE 0 END) AS unsettled_ringing
    FROM ct_calls c WHERE ${WINDOW}
  `).get(...range) as any;

  // Agent labels: both maps loaded once, then applied in memory — no per-row
  // lookup. resolveAgentLabel falls back to the RAW id for an unmapped agent,
  // which is the decision on record: never hide who the PBX named.
  const agentMap = getAgentMap(db);
  const userNames = getUserNamesByEmail(db);

  const byAgent = agentRows.map(r => {
    const raw = String(r.agent || '');
    const label = resolveAgentLabel(raw, agentMap, userNames);
    return { agent: raw, agent_label: label, mapped: label !== raw, ...breakdownRow(r) };
  });
  // Coverage comes from the totals query, NOT from summing the table above:
  // that table is capped at BREAKDOWN_LIMIT rows, and a coverage figure that
  // shrinks when the list is truncated would overstate how partial it is.
  const agentAttributed = int(t?.with_agent);

  return Response.json({
    range: { from, to, days, max_days: MAX_RANGE_DAYS, timezone: 'Asia/Kolkata' },

    totals: {
      ...totals,
      by_call_status: {
        missed: int(t?.st_missed),
        abandoned: int(t?.st_abandoned),
        voicemail: int(t?.st_voicemail),
      },
      with_team: int(t?.with_team),
      without_team: missed - int(t?.with_team),
      teams: int(t?.teams),
      with_agent: int(t?.with_agent),
      without_agent: missed - int(t?.with_agent),
    },

    timing: {
      timed: totals.timed,
      // Recovered but with no recovered_at to measure — every 'auto_resolved'
      // row is one of these (the guest rang back and we answered; ingest.ts
      // closes the recovery without stamping a recovery time). Counted by the
      // SQL, NOT as (recovered - timed): by subtraction a row with a negative
      // or unparseable span lands here too, and the page then gives it a cause
      // that is not its cause — while ALSO reporting it on its own line.
      untimed_recovered: totals.untimed_recovered,
      negative_span: int(timing?.negative_span),
      unparseable: int(timing?.unparseable),
      median_minutes: medianMinutes,
      avg_minutes: timing?.avg_minutes === null || timing?.avg_minutes === undefined
        ? null : round1(Number(timing.avg_minutes)),
      max_minutes: timing?.max_minutes === null || timing?.max_minutes === undefined
        ? null : round1(Number(timing.max_minutes)),
      bands: {
        under_15m: int(timing?.b_under_15m),
        m15_60: int(timing?.b_15_60m),
        h1_4: int(timing?.b_1_4h),
        h4_24: int(timing?.b_4_24h),
        over_24h: int(timing?.b_over_24h),
      },
    },

    by_team: teamRows.map(r => ({ team: String(r.team || ''), ...breakdownRow(r) })),
    by_team_truncated: teamRows.length >= BREAKDOWN_LIMIT,

    by_agent: byAgent,
    by_agent_truncated: agentRows.length >= BREAKDOWN_LIMIT,
    // How partial the agent view is, in the numbers the UI needs to say so.
    // MEASURED, not asserted. TeleCMI's CDR carries `user` and AGENT_KEYS reads
    // it, so the day a missed CDR starts arriving with an agent this becomes
    // 100% — and a hardcoded `partial: true` would print "only some calls name
    // an agent" directly above a figure saying every one of them does. The
    // "not a per-GRE miss count" warning stays unconditional either way: even
    // at full coverage the id names whose phone the PBX rang, not who chose to
    // let it ring.
    by_agent_coverage: {
      partial: agentAttributed < missed,
      attributed: agentAttributed,
      unattributed: Math.max(0, missed - agentAttributed),
      attributed_pct: pct(agentAttributed, missed),
    },

    outbound_unanswered: int(edges?.outbound_unanswered),
    unsettled_ringing: int(edges?.unsettled_ringing),
  });
}
