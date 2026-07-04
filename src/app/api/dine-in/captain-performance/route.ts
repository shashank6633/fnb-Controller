import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

/**
 * GET /api/dine-in/captain-performance?from=&to=   (STAFF)
 *
 * How fast each captain attends the table — measured from the guest's service
 * request (Call waiter / Refill water / Extra cutlery / Request bill):
 *   response time  = accepted_at − created_at  (how quickly they got to it)
 *   attend time    = completed_at − created_at (start-to-finish)
 * Aggregated per captain over a date range, ranked fastest-first. Also returns
 * how many requests are still unattended (never accepted) so slow tables show.
 */
export async function GET(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();

    const url = new URL(req.url);
    const to   = url.searchParams.get('to')   || new Date().toISOString().slice(0, 10);
    const from = url.searchParams.get('from') || (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })();

    const outletWhere = '(outlet_id = ? OR outlet_id IS NULL)';
    const secs = (a: string, b: string) => `(julianday(${a}) - julianday(${b})) * 86400`;

    // Response stats — who ACCEPTED, and how fast after the guest called.
    const resp = db.prepare(`
      SELECT accepted_by AS name,
             COUNT(*)                                       AS attended,
             AVG(${secs('accepted_at', 'created_at')})      AS avg_response,
             MIN(${secs('accepted_at', 'created_at')})      AS best_response,
             MAX(${secs('accepted_at', 'created_at')})      AS worst_response
      FROM service_requests
      WHERE accepted_at IS NOT NULL AND TRIM(COALESCE(accepted_by,'')) != ''
        AND date(created_at) BETWEEN ? AND ? AND ${outletWhere}
      GROUP BY accepted_by
    `).all(from, to, outletId) as any[];

    // Completion stats — who marked DONE, and total attend time.
    const comp = db.prepare(`
      SELECT completed_by AS name,
             COUNT(*)                                       AS completed,
             AVG(${secs('completed_at', 'created_at')})     AS avg_attend
      FROM service_requests
      WHERE completed_at IS NOT NULL AND TRIM(COALESCE(completed_by,'')) != ''
        AND date(created_at) BETWEEN ? AND ? AND ${outletWhere}
      GROUP BY completed_by
    `).all(from, to, outletId) as any[];

    const byName = new Map<string, any>();
    const get = (n: string) => { let g = byName.get(n); if (!g) { g = { name: n, attended: 0, avg_response: null, best_response: null, worst_response: null, completed: 0, avg_attend: null }; byName.set(n, g); } return g; };
    const round = (v: any) => (v == null ? null : Math.round(Number(v)));
    for (const r of resp) { const g = get(r.name); g.attended = r.attended; g.avg_response = round(r.avg_response); g.best_response = round(r.best_response); g.worst_response = round(r.worst_response); }
    for (const c of comp) { const g = get(c.name); g.completed = c.completed; g.avg_attend = round(c.avg_attend); }

    const captains = [...byName.values()].sort((a, b) => {
      // Fastest average response first; captains with no accepts sink to the bottom.
      if (a.avg_response == null) return 1;
      if (b.avg_response == null) return -1;
      return a.avg_response - b.avg_response;
    });

    // Fleet summary + how many calls were never attended.
    const totals = db.prepare(`
      SELECT
        COUNT(*)                                                          AS total,
        SUM(CASE WHEN accepted_at IS NOT NULL THEN 1 ELSE 0 END)          AS accepted,
        SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END)         AS completed,
        SUM(CASE WHEN accepted_at IS NULL AND completed_at IS NULL THEN 1 ELSE 0 END) AS unattended,
        AVG(CASE WHEN accepted_at IS NOT NULL THEN ${secs('accepted_at', 'created_at')} END) AS avg_response
      FROM service_requests
      WHERE date(created_at) BETWEEN ? AND ? AND ${outletWhere}
    `).get(from, to, outletId) as any;

    return Response.json({
      range: { from, to },
      captains,
      summary: {
        total: totals?.total || 0,
        accepted: totals?.accepted || 0,
        completed: totals?.completed || 0,
        unattended: totals?.unattended || 0,
        avg_response: round(totals?.avg_response),
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[/api/dine-in/captain-performance]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
