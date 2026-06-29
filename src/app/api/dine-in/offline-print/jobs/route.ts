import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

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

    return Response.json({ ok: true, id }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/dine-in/offline-print/jobs POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
