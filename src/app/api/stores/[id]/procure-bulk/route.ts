import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById } from '@/lib/store-engine';

/**
 * POST /api/stores/[id]/procure-bulk — RETIRED (owner rulings #83/#84, the
 * liquor-on-GRN switch-over). ONE door per indent.
 *
 * This was Liquor Store → "Upload CSV (Bill)": the FORGIVING TGBCL invoice /
 * inward-register CSV upload (match by SKU then name, skip and report what it
 * could not post, a balance file of the skipped rows, line-level dedupe), one
 * store_stock_ledger 'purchase' row per matched line plus upsertBillCharges —
 * never a purchases row, central stock or average_price.
 *
 * The TGBCL CSV upload moved to Goods Receipt (GRN) → TGBCL Liquor Bill: the
 * same forgiving matching runs read-only on POST /api/grn/liquor-match (plus
 * the balance download), and the matched lines are saved as ONE Goods Receipt
 * (POST /api/grn with liquor:true), which writes the same per-line store rows
 * and calls the same upsertBillCharges in one transaction. This POST answers,
 * after sign-in and the store lookup:
 *   410 { error, retired: true, use: '/grn?liquor=1' }
 * Nothing is read from the body and nothing is written. The pre-switch-over
 * body is in git history (0d32f2b).
 *
 * Bills uploaded here before the switch-over stay on every Liquor Store tab and
 * report. Transfers, closing counts, adjustments, opening stock and migration
 * are separate routes and are unchanged.
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
    console.error('[/api/stores/[id]/procure-bulk POST]', e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
