import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { getPrintAgentStatus } from '@/lib/print-agent';

/**
 * GET /api/dine-in/print-agent/status — dispatcher liveness for the current
 * outlet. Read by the Printers page to show "Print Agent running / not detected"
 * separate from the bridge health. (The Kitchen board gets the same object folded
 * into /api/dine-in/kot-alerts, so it needs no extra poll.)
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    return Response.json({ agent: getPrintAgentStatus(db, outletId) });
  } catch (e: any) {
    console.error('[/api/dine-in/print-agent/status GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
