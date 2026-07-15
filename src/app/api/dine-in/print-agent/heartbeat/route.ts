import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { recordAgentHeartbeat } from '@/lib/print-agent';

/**
 * POST /api/dine-in/print-agent/heartbeat { bridgeOk?, url? }
 * The open /print/agent page pings this every few seconds so the system knows a
 * dispatcher is alive on the counter PC. Any authenticated user (the agent may
 * be signed in as a station/kitchen user) — deliberately NOT admin/manager only.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const b = await request.json().catch(() => ({}));
    recordAgentHeartbeat(db, outletId, {
      bridgeOk: !!b?.bridgeOk,
      url: typeof b?.url === 'string' ? b.url : '',
      userAgent: request.headers.get('user-agent') || '',
    });
    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('[/api/dine-in/print-agent/heartbeat POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
