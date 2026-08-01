import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { isTelecmiConfigured } from '@/lib/ct/settings';
import { fetchAnalysis } from '@/lib/ct/telecmi-api';

/**
 * GET /api/telecmi/analysis — admin-only call totals for a window, from BOTH
 * sides: what TeleCMI counted, and what we actually hold in ct_calls.
 *
 * Query: ?days=N (default 7, clamped 1–90) OR ?start=&end= (epoch ms).
 * Shape (always HTTP 200 unless auth fails, or an explicit ?start=/?end= is not
 * a window a human could have meant — see resolveWindow — which is a 400):
 *   { configured, days, start, end, total, answered, missed, answer_rate,
 *     local:{ total, answered, missed }, error? }
 *
 * ── WHY THE `local` BLOCK EXISTS ───────────────────────────────────────────
 * The provider-side numbers alone cannot tell an admin whether the CRM is
 * healthy. The single most useful signal this page can give is the GAP: if
 * TeleCMI counted 240 calls last week and ct_calls holds 30, the webhooks are
 * not arriving and every screen-pop, missed-call recovery and SLA clock in the
 * module has been silently dead. Nothing else in the app surfaces that, because
 * every other screen reads ct_calls and so agrees with itself. Both sides are
 * therefore computed over the SAME window and published side by side, and the
 * local side is computed even when TeleCMI is unreachable or unconfigured —
 * it is our own data and it always answers.
 *
 * ── WHY NULL, NEVER 0 ──────────────────────────────────────────────────────
 * Provider fields are null when we could not learn them. A 0 shown as fact
 * where we simply failed to reach TeleCMI reads as "no calls happened", which
 * is precisely the false all-clear this page exists to prevent.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0; // live operational counts; a cached window is a stale verdict

const DAY_MS = 86_400_000;
const MAX_DAYS = 90;

/**
 * Absolute bounds for an explicit ?start=&end= range.
 *
 * The 90-day SPAN clamp below is not enough on its own, because it says nothing
 * about where the span sits. A JS Date is only valid to ±8.64e15 ms, so an
 * absurd epoch (?start=0&end=1e17) makes `new Date(ms).toISOString()` throw
 * RangeError while building the ct_calls query — outside any try/catch, so the
 * route answers HTTP 500 with an HTML error page and the panel's JSON.parse
 * blows up instead of showing a message. Both ends are therefore bounded BEFORE
 * any Date is constructed.
 *
 * Rejected rather than silently clamped: a window starting before the company
 * existed, or ending years out, is a typo (or epoch SECONDS pasted where ms
 * belong) — not a question. Quietly answering a different window than the one
 * asked for is exactly the false all-clear this page exists to prevent.
 */
const EPOCH_MIN = Date.UTC(2000, 0, 1); // no CDR predates this, let alone the business
const FUTURE_SLACK_MS = 2 * DAY_MS; // a picker sending "end of today" in IST is not a typo

/**
 * Answered vs missed must be derived EXACTLY as the rest of the module does, or
 * the local column would not be comparable with any other CRM screen (and the
 * gap this page reports would be an artefact of two different definitions).
 * Mirrors src/lib/ct/metrics.ts — 'answered' is the single answered state, and
 * the missed family is missed | abandoned | voicemail.
 */
const MISSED_FAMILY = `('missed','abandoned','voicemail')`;

/**
 * started_at is the call's own UTC ISO timestamp but can be blank on rows
 * ingested from a sparse CDR, so fall back to created_at — which sqlite writes
 * as "YYYY-MM-DD HH:MM:SS". Swapping the space for 'T' makes both forms sort
 * and compare correctly against the ISO cutoffs below (both are UTC). Same
 * fragment metrics.ts uses; comparing epoch ms against these strings would
 * match nothing.
 */
const CALL_AT = `REPLACE(COALESCE(NULLIF(c.started_at, ''), c.created_at), ' ', 'T')`;

const num = (v: unknown) => Number(v) || 0;

/** TeleCMI occasionally sends numerics as strings; unparseable means unknown. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function intParam(sp: URLSearchParams, key: string): number | null {
  const raw = sp.get(key);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// Not named `Window` — that is a DOM global, and shadowing it in a file
// type-checked against lib.dom invites a confusing error later.
type ResolvedWindow = { start: number; end: number; days: number };

/**
 * Resolve the window in epoch ms.
 *
 * Rolling window ending "now", not IST calendar days — this route is a
 * reconciliation against TeleCMI, and TeleCMI's /analysis takes a plain epoch
 * range with no notion of our timezone. Matching the backfill route's
 * `to = now; from = now - days*86400000` keeps the two admin tools telling the
 * same story about "the last 7 days".
 *
 * Returns { error } for an explicit range that is out of bounds; ?days= can
 * never be, so that path always resolves.
 */
function resolveWindow(sp: URLSearchParams): ResolvedWindow | { error: string } {
  const rawStart = intParam(sp, 'start');
  const rawEnd = intParam(sp, 'end');

  if (rawStart !== null && rawEnd !== null) {
    // Tolerate a reversed range rather than returning an empty window that
    // looks exactly like "no calls happened".
    let start = Math.min(rawStart, rawEnd);
    let end = Math.max(rawStart, rawEnd);

    // Bound the ABSOLUTE epoch before any Date is built (see EPOCH_MIN above).
    // Checked against the untrusted values themselves, not against `end`, so a
    // far-future `end` cannot drag a valid `start` out with it.
    const maxEnd = Date.now() + FUTURE_SLACK_MS;
    if (start < EPOCH_MIN || end > maxEnd) {
      return {
        error:
          `start and end must be epoch MILLISECONDS between ${EPOCH_MIN} and ${maxEnd} ` +
          `(received start=${start}, end=${end}). A seconds-based timestamp or a stray ` +
          `digit lands outside that range — omit both and use ?days=N instead.`,
      };
    }

    // The explicit range is clamped to the same 90 days ?days= is, so it cannot
    // be used to ask for a decade of CDRs and hang the provider call.
    if (end - start > MAX_DAYS * DAY_MS) start = end - MAX_DAYS * DAY_MS;
    return { start, end, days: Math.max(1, Math.round((end - start) / DAY_MS)) };
  }

  const days = Math.min(MAX_DAYS, Math.max(1, intParam(sp, 'days') ?? 7));
  const end = Date.now();
  return { start: end - days * DAY_MS, end, days };
}

export async function GET(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  // A bad explicit window is the caller's mistake, so say so as JSON — the panel
  // renders `error` from any non-2xx, and a 400 here is what keeps the RangeError
  // out of the Date calls below.
  const win = resolveWindow(new URL(req.url).searchParams);
  if ('error' in win) return Response.json({ error: win.error }, { status: 400 });

  const { start, end, days } = win;
  const db = getDb();

  // ── Our side ─────────────────────────────────────────────────────────────
  // No direction filter: TeleCMI's /analysis totals the whole account, so
  // restricting this to inbound would manufacture a gap on every outbound
  // callback and make the comparison useless.
  const l = db.prepare(`
    SELECT COUNT(*)                                                       AS total,
           SUM(CASE WHEN c.status = 'answered' THEN 1 ELSE 0 END)         AS answered,
           SUM(CASE WHEN c.status IN ${MISSED_FAMILY} THEN 1 ELSE 0 END)  AS missed
    FROM ct_calls c
    WHERE ${CALL_AT} >= ? AND ${CALL_AT} < ?
  `).get(new Date(start).toISOString(), new Date(end).toISOString()) as any;

  const local = { total: num(l?.total), answered: num(l?.answered), missed: num(l?.missed) };

  // ── Provider side ────────────────────────────────────────────────────────
  if (!isTelecmiConfigured(db)) {
    return Response.json({
      configured: false, days, start, end,
      total: null, answered: null, missed: null, answer_rate: null,
      local,
    });
  }

  const res = await fetchAnalysis(db, start, end);
  if (!res.ok || !res.data) {
    // res.error comes from telecmi-api and never carries the appid or secret.
    return Response.json({
      configured: true, days, start, end,
      total: null, answered: null, missed: null, answer_rate: null,
      local,
      error: res.error || 'TeleCMI did not return call analysis',
    });
  }

  const total = numOrNull(res.data.total);
  const answered = numOrNull(res.data.answered);
  const missed = numOrNull(res.data.missed);

  // null on a zero (or unknown) denominator: 0/0 rendered as "0%" reads as
  // "every call was missed", which is the opposite of "there were no calls".
  const answer_rate =
    total !== null && total > 0 && answered !== null
      ? Math.round((answered / total) * 1000) / 10
      : null;

  return Response.json({
    configured: true, days, start, end,
    total, answered, missed, answer_rate,
    local,
  });
}
