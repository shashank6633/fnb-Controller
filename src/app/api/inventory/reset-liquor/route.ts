import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Reset LIQUOR / consolidated store stock — the Liquor Store + every floor bar.
 *
 * Each store's on-hand is the SUM of its `store_stock_ledger` rows (all store
 * procurement/issue/transfer/adjustment movements live only there), so clearing
 * the ledger sets every location's liquor stock to 0. In one transaction it
 * deletes: store_stock_ledger, store_closing_counts (counts + variance), and the
 * transfer records (store_transfer_items → store_transfers).
 *
 * It does NOT delete the stores themselves (store_locations), their category maps,
 * or user access — only the stock movements/counts. Central grocery stock,
 * materials, recipes and sales are untouched. Use to re-baseline the bars before
 * re-entering opening stock / purchases.
 *
 * Admin only. Requires body { confirm: 'RESET' }.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

    let body: any = {};
    try { body = await request.json(); } catch { /* confirm check fails below */ }
    if (String(body?.confirm || '').trim().toUpperCase() !== 'RESET') {
      return Response.json({ error: 'Confirmation required — send { "confirm": "RESET" }.' }, { status: 400 });
    }

    const db = getDb();
    let ledger_deleted = 0, counts_deleted = 0, transfer_items_deleted = 0, transfers_deleted = 0;

    const txn = db.transaction(() => {
      ledger_deleted = db.prepare(`DELETE FROM store_stock_ledger`).run().changes;
      counts_deleted = db.prepare(`DELETE FROM store_closing_counts`).run().changes;
      // Child before parent (FK).
      transfer_items_deleted = db.prepare(`DELETE FROM store_transfer_items`).run().changes;
      transfers_deleted = db.prepare(`DELETE FROM store_transfers`).run().changes;
    });
    txn();

    return Response.json({
      success: true,
      ledger_deleted, counts_deleted, transfer_items_deleted, transfers_deleted,
      summary: `Liquor / consolidated stock reset — cleared ${ledger_deleted} ledger movement(s), `
        + `${counts_deleted} closing count(s) and ${transfers_deleted} transfer(s). Every floor bar + the `
        + `Liquor Store is now 0. Re-enter opening stock / purchases via the Liquor Store to rebuild.`,
    });
  } catch (e: any) {
    console.error('[/api/inventory/reset-liquor]', e);
    return Response.json({ error: e?.message || 'Liquor reset failed' }, { status: 500 });
  }
}
