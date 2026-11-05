import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById } from '@/lib/store-engine';

/**
 * POST /api/stores/[id]/procure — RETIRED (owner rulings #83/#84, the
 * liquor-on-GRN switch-over). ONE door per indent.
 *
 * This was DIRECT store procurement (Phase B, spec F2): one purchase posted
 * straight into a store location as a single store_stock_ledger 'purchase'
 * row (cases / bottles / loose or a purchase-unit quantity, unit_cost =
 * ₹/bottle ÷ pack, NO purchases row, NO central stock or average_price — the
 * store rail's isolation). It had no screen left calling it (the single-line
 * "New Purchase" button was removed earlier on the owner's call).
 *
 * TGBCL liquor bills are now entered on Goods Receipt (GRN) → TGBCL Liquor Bill
 * (POST /api/grn with liquor:true): it records the GRN + PINV and posts the
 * same per-line store 'purchase' rows (ref = indent no) with the TGBCL charges
 * and Net Indent in one transaction. This POST answers, after sign-in and the
 * store lookup:
 *   410 { error, retired: true, use: '/grn?liquor=1' }
 * Nothing is read from the body and nothing is written. The pre-switch-over
 * body is in git history (0d32f2b).
 *
 * Rows this route wrote before the switch-over are ordinary ledger rows and stay
 * on every Liquor Store tab and report. Transfers, closing counts, adjustments,
 * opening stock and migration are separate routes and are unchanged.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id: storeId } = await params;
    const db = getDb();

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });

    return Response.json({
      error: `New liquor bills are no longer entered here. Enter the bill on Goods Receipt (GRN) → TGBCL Liquor Bill: it records the GRN and posts the bottles straight into ${store.name} with the TGBCL charges and Net Indent. Bills already recorded here stay on the ${store.name} reports, and transfers, closing and adjustments work as before.`,
      retired: true,
      use: '/grn?liquor=1',
    }, { status: 410 });
  } catch (e: unknown) {
    console.error('[/api/stores/[id]/procure POST]', e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
