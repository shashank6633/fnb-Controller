import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { raiseKotAlert } from '@/lib/kot-alerts';

/**
 * Print-job journal. The browser prints directly to the local bridge (so it
 * works offline); when the server IS reachable it POSTs the outcome here so
 * there's an audit trail of what printed / failed. GET returns recent jobs.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const limit = Math.min(200, Number(new URL(request.url).searchParams.get('limit')) || 50);
    const jobs = db.prepare(
      `SELECT j.*, s.name AS station_name FROM print_jobs j
       LEFT JOIN print_stations s ON j.station_id = s.id
       WHERE (j.outlet_id = ? OR j.outlet_id IS NULL)
       ORDER BY j.created_at DESC LIMIT ?`
    ).all(outletId, limit);
    return Response.json({ jobs });
  } catch (e: any) {
    console.error('[/api/dine-in/offline-print/jobs GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const b = await request.json();

    const id = b.id ? String(b.id) : generateId();
    const status = ['printed', 'failed', 'queued'].includes(b.status) ? b.status : 'queued';
    const docType = b.doc_type === 'bill' ? 'bill' : 'kot';
    const source = ['test', 'fire', 'bill', 'reprint'].includes(b.source) ? b.source : 'test';

    db.prepare(
      `INSERT INTO print_jobs (id, outlet_id, station_id, doc_type, source, ref_id, status, attempts, last_error, printed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, attempts=excluded.attempts,
         last_error=excluded.last_error, printed_at=excluded.printed_at`
    ).run(
      id, outletId, b.station_id || null, docType, source, b.ref_id || null,
      status, Number(b.attempts) || 1, String(b.last_error || ''),
      status === 'printed' ? new Date().toISOString() : null,
    );

    // A KOT that gave up printing (after the outbox exhausted its retries) is a
    // real kitchen problem — raise an alert so the respective captain + floor
    // manager are told. Only for real fire/reprint KOTs (not test tickets/bills).
    if (status === 'failed' && docType === 'kot' && source !== 'test' && b.ref_id) {
      try {
        const kot = db.prepare(`
          SELECT k.id, k.order_id, k.outlet_id, k.kot_number, k.station,
                 o.server_id, rt.table_number
          FROM kots k
          JOIN orders o ON o.id = k.order_id
          LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
          WHERE k.id = ?
        `).get(String(b.ref_id)) as any;
        if (kot) {
          raiseKotAlert(db, {
            kotId: kot.id, orderId: kot.order_id, outletId: kot.outlet_id,
            kotNumber: kot.kot_number, station: kot.station, tableNumber: kot.table_number,
            serverId: kot.server_id, kind: 'print_failed', createdBy: 'printer',
            reason: `KOT #${kot.kot_number} failed to print at ${kot.station || 'the kitchen'}${b.last_error ? ' — ' + String(b.last_error).slice(0, 80) : ''}.`,
          });
        }
      } catch (ae) { console.error('[/api/dine-in/offline-print/jobs print-fail alert]', ae); }
    }

    return Response.json({ ok: true, id }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/dine-in/offline-print/jobs POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
