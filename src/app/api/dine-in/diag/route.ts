import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { kdsSubscriberCount } from '@/lib/kds-bus';

/**
 * Admin-only KOT-flow diagnostics — openable in a browser to debug "KOTs not
 * printing" without SSH access to the box. Tells you, server-side:
 *  - pid: open this a few times. If the pid CHANGES, pm2 is in CLUSTER mode →
 *    the in-process KDS event bus is split across workers (live SSE breaks;
 *    the print-agent's 9s poll still works). Fix: run a single instance.
 *  - kdsSubscribers: how many live KDS/print-agent streams are connected to THIS
 *    worker right now. 0 = nothing listening here.
 *  - kotsLastHour / recentKots: proves the captain's "fire" is creating KOTs.
 *  - kotPrinters / billPrinters: whether any printer is configured (0 = nothing
 *    will print, no matter what).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const db = getDb();
    const outletId = await getCurrentOutletId();

    const kotsLastHour = (db.prepare(`SELECT COUNT(*) n FROM kots WHERE created_at >= datetime('now','-1 hour')`).get() as any).n;
    const kotsToday = (db.prepare(`SELECT COUNT(*) n FROM kots WHERE date(created_at) = date('now')`).get() as any).n;
    const recentKots = db.prepare(`
      SELECT k.kot_number, k.station, k.status, k.created_at, o.order_number, o.order_type, t.table_number
      FROM kots k JOIN orders o ON k.order_id = o.id
      LEFT JOIN restaurant_tables t ON o.table_id = t.id
      ORDER BY k.created_at DESC LIMIT 5
    `).all();

    const printers = db.prepare(`SELECT role, name, station, floor, transport, target, is_active, is_master FROM print_stations WHERE outlet_id = ? OR outlet_id IS NULL`).all(outletId) as any[];
    const kotPrinters = printers.filter((p) => p.role === 'kot' && p.is_active);
    const billPrinters = printers.filter((p) => p.role === 'bill' && p.is_active);

    return Response.json({
      ok: true,
      server_time: new Date().toISOString(),
      pid: process.pid,                       // changes across calls ⇒ pm2 cluster mode
      uptime_sec: Math.round(process.uptime()),
      kds_subscribers_this_worker: kdsSubscriberCount(),
      kots_last_hour: kotsLastHour,
      kots_today: kotsToday,
      recent_kots: recentKots,
      kot_printers: kotPrinters.map((p) => ({ name: p.name, station: p.station, floor: p.floor, transport: p.transport, target: p.target, is_master: !!p.is_master })),
      bill_printers: billPrinters.map((p) => ({ name: p.name, floor: p.floor, transport: p.transport, target: p.target })),
      kot_printer_count: kotPrinters.length,
      bill_printer_count: billPrinters.length,
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
