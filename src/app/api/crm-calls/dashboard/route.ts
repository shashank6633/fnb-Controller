import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { sweep } from '@/lib/ct/ingest';
import { dashboardStats } from '@/lib/ct/metrics';
import { getAgentMap, getUserNamesByEmail, resolveAgentLabel } from '@/lib/ct/agents';

/**
 * GET /api/crm-calls/dashboard — Call-to-Table CRM dashboard stats.
 *
 * Query params:
 *   days   lookback window in days (default 30, clamped 1–365)
 *
 * Runs sweep() first (reconcile stale live-ring events + expire overdue
 * recoveries) so the funnel/recovery numbers reflect reality, then returns
 * dashboardStats() verbatim: call counts by day/hour, Calls→Answered→Booked→
 * Seated funnel, recovery funnel, per-agent leaderboard, avg time-to-first-
 * callback, lapsed guests.
 *
 * Also returned (additive, same shape as DashboardStats):
 *   byDowHour          7×24 dense IST weekday×hour grid (inbound) — the
 *                      staffing heatmap; byHour is unchanged and still served.
 *   weekdayOccurrences how many times each weekday falls in the window
 *                      (index 0 = Sunday) — the heatmap's denominators.
 *   unattributed       inbound calls in the window with no agent id, i.e. the
 *                      ring-group misses that are in nobody's answer rate.
 *   agents[]           now also carries inbound/outbound volume, answer_rate,
 *                      connect_rate and asa_sec + asa_sample.
 *
 * Read-only: this route aggregates and never writes (sweep() aside, which is
 * the pre-existing reconciliation pass).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Not signed in' }, { status: 401 });

  // Sweep is safe/cheap by contract, but a stats read should never 500
  // because reconciliation hiccupped.
  try {
    sweep();
  } catch (err) {
    console.warn('[crm-calls/dashboard] sweep failed:', err);
  }

  const sp = new URL(req.url).searchParams;
  const days = Math.min(365, Math.max(1, Math.floor(Number(sp.get('days')) || 30)));

  const db = getDb();
  const stats = dashboardStats(db, { days });

  // Attach the human agent label (mapped staff name → mapped email → raw id) to
  // each leaderboard row. Maps loaded once per request to avoid N+1; the raw
  // `agent` is kept intact for callers that key off it.
  const agentMap = getAgentMap(db);
  const userNames = getUserNamesByEmail(db);
  const agents = stats.agents.map(a => ({
    ...a,
    agent_display: resolveAgentLabel(a.agent, agentMap, userNames),
  }));

  return Response.json({ ...stats, agents });
}
