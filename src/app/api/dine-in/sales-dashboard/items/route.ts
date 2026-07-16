import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';
import { getItemWiseSales } from '@/lib/sales-dashboard';

/** GET /api/dine-in/sales-dashboard/items?from&to — per-item settled sales. Admin/manager/HOD. */
export const dynamic = 'force-dynamic';
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!isManagement(me)) {
      return Response.json({ error: 'Manager, HOD or admin role required' }, { status: 403 });
    }
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const sp = new URL(request.url).searchParams;
    const today = todayIST();
    let from = sp.get('from') || today;
    let to = sp.get('to') || today;
    if (!isDate(from)) from = today;
    if (!isDate(to)) to = today;
    if (from > to) { const t = from; from = to; to = t; }
    return Response.json({ items: getItemWiseSales(db, outletId, from, to) });
  } catch (e: any) {
    console.error('[/api/dine-in/sales-dashboard/items GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
