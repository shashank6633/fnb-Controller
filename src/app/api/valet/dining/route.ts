import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { fail, requireStaff, ValetError } from '@/lib/valet/core';
import { hasValetCap } from '@/lib/valet/caps';
import { carsForOrder, diningRef } from '@/lib/valet/ops-dining';
import { valetJson } from '@/lib/valet/http';

/**
 * GET ?order=<order id> — valet cars linked to this dining visit, for the
 * cashier / host screens. The outlet comes from the ORDER, and the caller must
 * hold a valet desk/attendant/head capability AND be assigned to that outlet
 * where valet is switched on. Anyone else gets {show:false} (not an error), so
 * the bill screen of a cashier who does not use valet stays exactly as it was —
 * no chip, no red request in the browser console. No guest contact is returned.
 */
export const dynamic = 'force-dynamic';

const HIDDEN = { show: false };

export async function GET(req: Request) {
  return valetJson(async () => {
    const db = getDb();
    const user = await getCurrentUser();
    if (!user) fail(401, 'unauthenticated', 'Sign in.');
    const canRequest = hasValetCap(user ?? undefined, 'host');
    // Checked BEFORE the order lookup: a non-valet user learns nothing.
    if (!canRequest && !hasValetCap(user ?? undefined, 'attendant')) return HIDDEN;
    const orderId = new URL(req.url).searchParams.get('order') || '';
    const o = db.prepare('SELECT id, outlet_id FROM orders WHERE id = ?').get(orderId) as { id: string; outlet_id: string | null } | undefined;
    if (!o?.outlet_id) return HIDDEN;
    let outletId: string;
    try {
      outletId = requireStaff(db, user, o.outlet_id, canRequest ? 'host' : 'attendant').ov.outlet_id;
    } catch (e) {
      // Not assigned to this outlet, or valet is off there: nothing to show.
      if (e instanceof ValetError && e.status < 500) return HIDDEN;
      throw e;
    }
    // can_request mirrors pickup.request's own gate ('host'), so the chip never
    // offers a button the command would refuse.
    return { show: true, order: diningRef(db, o.id), cars: carsForOrder(db, outletId, o.id), outlet_id: outletId, can_request: canRequest };
  });
}
