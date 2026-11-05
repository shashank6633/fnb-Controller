import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canProcessAsStore } from '@/lib/auth';
import { createMergedPo } from '@/lib/po-helpers';

/**
 * POST /api/purchase-orders/merge — ONE DRAFT PO from many requisition lines
 * (owner rulings #63-#70, 2026-10-23).
 *
 * body: {
 *   requisition_item_ids: string[],            // the requisition lines bought for
 *   lines: [{ material_id, vendor_id, rate,    // ONE per material among them;
 *             qty_purchase? }],                //   rate ₹/purchase unit, qty purchase units
 *   notes?: string,
 *   expected_date?: 'YYYY-MM-DD',              // one expected date per PO
 *   date?: 'YYYY-MM-DD'                        // PO date, default today (IST)
 * }
 *
 * 201 → { purchase_order, items, links, merged_from }
 * 400/409 → { error, code, details? } — nothing written (see createMergedPo).
 *
 * WHO: the store manager or an admin (ruling #65) — canProcessAsStore, the
 * auth.ts helper whose doc already reads "raise vendor POs … Admin always
 * true". Deliberately not poWriteGate: that admits every manager tier and HOD,
 * and the owner named exactly two roles for this.
 *
 * The PO is born DRAFT with merged = 1 and requisition_id NULL, so it follows
 * the normal PO path (edit, submit, the whole-PO approval, per-vendor receive)
 * and no requisition is touched — the store issues from the desk as today.
 */
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canProcessAsStore(me)) {
      return Response.json({ error: 'Only the Store Manager or an Admin can merge requisitions into a PO.' }, { status: 403 });
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'Send the requisition lines and one PO line per item.', code: 'bad_body' }, { status: 400 });
    }
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const res = createMergedPo(db, body, { actor: me.email, outletId });
    if (!res.ok) {
      return Response.json({ error: res.error, code: res.code, details: res.details ?? null }, { status: res.status });
    }
    return Response.json({
      purchase_order: res.po,
      items: res.items,
      links: res.links,
      merged_from: res.merged_from,
    }, { status: 201 });
  } catch (error: unknown) {
    console.error('[/api/purchase-orders/merge POST]', error);
    return Response.json({ error: (error instanceof Error && error.message) || 'Merge failed' }, { status: 500 });
  }
}
