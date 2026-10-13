import { getCurrentUser } from '@/lib/auth';
import {
  billHandoverDb,
  canRecordBillHandover,
  cutoffState,
  listUnrecordedReceipts,
} from '@/lib/bill-handover';

/**
 * THE LEAK DETECTOR — deliveries received with no bill record
 * ==========================================================
 *
 *   GET /api/bill-submissions/unrecorded?limit=
 *     -> { rows, cutoff }
 *
 * Goods receipts dated on/after the cutoff that carry no live handover record.
 * These are bills whose store person did not answer the quality-check prompt —
 * the exact case the owner's "confusion about whether a vendor bill was actually
 * handed over" describes. The store screen offers each one a "record this bill"
 * action, which POSTs to /api/bill-submissions with that grn_id.
 *
 * THIS IS NOT "PENDING SUBMISSION" AND MUST NEVER BE MERGED INTO IT. Pending is
 * a pure read of rows that were deliberately created; this is derived from
 * goods_receipt_notes. Keeping them apart is what guarantees the historical
 * backlog can never surface as Pending — and this query is itself bounded by the
 * cutoff, so on the owner's real data it returns nothing (all 29 goods receipts
 * are dated 2026-08-07).
 *
 * Store-side only: it is a list of work for the store, not for Accounts.
 * Self-gating; the proxy does not guard API routes.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canRecordBillHandover(me)) {
    return Response.json(
      { error: 'Only Management or the Store Manager can see unrecorded vendor bills.' },
      { status: 403 },
    );
  }

  try {
    const db = billHandoverDb();
    const limit = parseInt(new URL(request.url).searchParams.get('limit') || '100', 10) || 100;
    return Response.json({ rows: listUnrecordedReceipts(db, limit), cutoff: cutoffState(db) });
  } catch (e) {
    console.error('GET /api/bill-submissions/unrecorded failed:', e);
    return Response.json({ error: 'Could not load unrecorded bills.' }, { status: 500 });
  }
}
