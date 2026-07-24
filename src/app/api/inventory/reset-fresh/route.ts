import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * "Start fresh" inventory reset — a clean slate for re-entering purchase history.
 *
 * In one transaction it:
 *   1. deletes every purchase row (this INCLUDES opening-stock rows, which are
 *      stored as purchases with vendor 'Opening Stock'),
 *   2. deletes the matching inventory_transactions (type 'purchase' + 'opening'),
 *   3. sets current_stock = 0 for every raw material.
 *
 * It does NOT touch materials, recipes, sales, party data, or closing-stock
 * counts — only the purchase/opening ledger and the on-hand balance.
 *
 * After this: re-upload your 3 months of purchases (accurate purchase reports),
 * then record a physical count via Closing Stock / Opening Stock for accurate
 * on-hand.
 *
 * Admin only. Requires body { confirm: 'RESET' } so it can never fire by accident.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

    let body: any = {};
    try { body = await request.json(); } catch { /* empty body → confirm check fails below */ }
    if (String(body?.confirm || '').trim().toUpperCase() !== 'RESET') {
      return Response.json({ error: 'Confirmation required — send { "confirm": "RESET" }.' }, { status: 400 });
    }

    const db = getDb();
    let purchases_deleted = 0;
    let transactions_deleted = 0;
    let items_zeroed = 0;

    const txn = db.transaction(() => {
      // Remove the purchase/opening ledger first (FK-safe: txns reference purchases).
      transactions_deleted = db.prepare(
        `DELETE FROM inventory_transactions WHERE type IN ('purchase', 'opening')`,
      ).run().changes;
      purchases_deleted = db.prepare(`DELETE FROM purchases`).run().changes;
      // Zero the on-hand for every material (only rows that actually change).
      items_zeroed = db.prepare(
        `UPDATE raw_materials SET current_stock = 0, updated_at = datetime('now') WHERE current_stock <> 0`,
      ).run().changes;
    });
    txn();

    return Response.json({
      success: true,
      purchases_deleted,
      transactions_deleted,
      items_zeroed,
      summary: `Fresh start done — deleted ${purchases_deleted} purchase row(s) (incl. opening stock), `
        + `cleared the purchase ledger, and set ${items_zeroed} item(s) to 0 stock. `
        + `Now re-upload your 3 months of purchases, then record a physical count (Closing/Opening Stock) for accurate on-hand.`,
    });
  } catch (e: any) {
    console.error('[/api/inventory/reset-fresh]', e);
    return Response.json({ error: e?.message || 'Reset failed' }, { status: 500 });
  }
}
