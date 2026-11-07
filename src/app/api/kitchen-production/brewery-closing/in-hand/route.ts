import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAccessPage } from '@/lib/page-catalog';
import { checkClosingDate } from '@/lib/closing-date';
import { todayIST } from '@/lib/format-date';
import {
  BREWERY_CLOSING_PAGE, beerBatchesAsOf, beerCountsOn, beerTotalsByItem, canSeeBeerQuantities,
} from '@/lib/brewery-beer';

/**
 * Beer in hand — owner rulings 118/120.
 *
 * GET ?date=YYYY-MM-DD (default today, IST; any past date, never a future one)
 *   → { date, batches: [...], totals: [...] }
 *   batches = every Brewery batch that held beer at the end of that day
 *             (produced − consumed / wasted / disposed up to that day, see
 *             src/lib/brewery-beer.ts), plus any batch counted that day, each
 *             with that day's count and the difference.
 *   totals  = per beer and unit (litres and kegs are never added together).
 *
 * Admin, manager and HOD only (ruling 120): these ARE the expected figures a
 * blind count must not show a counter. Also needs the Brewery Closing page,
 * where the report lives. Read-only.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canSeeBeerQuantities(me) || !canAccessPage(BREWERY_CLOSING_PAGE, me)) {
      return Response.json({ error: 'Beer in hand is for admins, managers and HODs.' }, { status: 403 });
    }
    const url = new URL(request.url);
    const checked = checkClosingDate(url.searchParams.get('date') || todayIST());
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    const date = checked.date;

    const db = getDb();
    const outletId = await getCurrentOutletId();
    const counts = beerCountsOn(db, date);
    const batches = beerBatchesAsOf(db, date, outletId)
      .filter((r) => r.in_hand > 1e-9 || counts.has(r.batch_id))
      .map((r) => {
        const c = counts.get(r.batch_id);
        const counted = c ? Number(c.counted_qty) : null;
        return {
          ...r,
          counted,
          counted_by: c?.counted_by || '',
          difference: counted !== null ? Math.round((counted - r.in_hand) * 1e6) / 1e6 : null,
        };
      });

    return Response.json({ date, batches, totals: beerTotalsByItem(batches) });
  } catch (e: any) {
    console.error('GET /api/kitchen-production/brewery-closing/in-hand failed:', e);
    return Response.json({ error: e?.message || 'Failed to load beer in hand' }, { status: 500 });
  }
}
