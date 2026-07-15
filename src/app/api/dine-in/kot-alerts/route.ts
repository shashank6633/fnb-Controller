import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { sweepDirectKotDeliveries, autoResolveKotAlerts } from '@/lib/kot-alerts';
import { getPrintAgentStatus } from '@/lib/print-agent';

/**
 * GET  /api/dine-in/kot-alerts?open=1 — list UNRESOLVED KOT escalations for the
 *      current outlet. Read by the Manager (in-app), the Kitchen Display banner,
 *      and the Captain app so all see "KOT not printed — action needed". Each GET
 *      first sweeps for directly-fired KOTs that never confirmed printing and
 *      raises alerts for them (see src/lib/kot-alerts.ts).
 * POST /api/dine-in/kot-alerts { id, resolve:true } — mark an alert resolved.
 */
export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const open = new URL(request.url).searchParams.get('open');

    // Auto-detect self-order KOTs that fired but never confirmed at the printer,
    // then clear any alert that has since printed / been picked up by the kitchen.
    sweepDirectKotDeliveries(db, outletId);
    autoResolveKotAlerts(db, outletId);

    let where = '(outlet_id = ? OR outlet_id IS NULL)';
    const params: any[] = [outletId];
    if (open === '1') where += ' AND resolved_at IS NULL';

    const alerts = db.prepare(`
      SELECT id, kot_id, order_id, outlet_id, kot_number, station, table_number,
             reason, kind, server_id, created_by, created_at, resolved_at
      FROM kot_alerts
      WHERE ${where}
      ORDER BY created_at DESC
    `).all(...params) as any[];

    // Dispatcher liveness rides along so the Kitchen board can raise a watchdog
    // banner (orders flowing but no /print/agent running) without a second poll.
    const agent = getPrintAgentStatus(db, outletId);

    return Response.json({ alerts, agent });
  } catch (e: any) {
    console.error('[/api/dine-in/kot-alerts GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await req.json().catch(() => ({}));
    const id = (b?.id || '').toString();
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });

    if (b?.resolve) {
      db.prepare("UPDATE kot_alerts SET resolved_at = datetime('now') WHERE id = ? AND resolved_at IS NULL").run(id);
    }
    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('[/api/dine-in/kot-alerts POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
