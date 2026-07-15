import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';
import { getSalesDashboard } from '@/lib/sales-dashboard';

/**
 * GET /api/dine-in/sales-dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Order-level sales analytics (gross/discount/charges/tax/net, item-type,
 * collection-by-business, session, payment category/status, cancel breakup,
 * performance) for the selected IST day range + month-to-date. Admin/manager.
 */
export const dynamic = 'force-dynamic';

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && me.role !== 'manager') {
      return Response.json({ error: 'Manager or admin role required' }, { status: 403 });
    }
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const sp = new URL(request.url).searchParams;
    const today = todayIST();
    let from = sp.get('from') || today;
    let to = sp.get('to') || today;
    if (!isDate(from)) from = today;
    if (!isDate(to)) to = today;
    if (from > to) { const t = from; from = to; to = t; } // normalise reversed range

    return Response.json(getSalesDashboard(db, outletId, from, to));
  } catch (e: any) {
    console.error('[/api/dine-in/sales-dashboard GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
