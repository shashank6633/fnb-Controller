import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { toSendView, routedSendPost } from '../routed-send';

/**
 * "TO SEND" — the routed requisition lines a department hands over itself
 * (owner rulings #45 + #74). The logic is ../routed-send.ts; this is the HTTP
 * shell.
 *
 *   GET  /api/department-transfers/to-send?department_id=<D>
 *        → { department, rules, explain, groups, totals }
 *          department.can_send = may the caller send from D (rulings #12 #40).
 *          Every quantity has its PURCHASE twin, and the screen leads with it.
 *   POST /api/department-transfers/to-send
 *        { from_department_id, requisition_id, to_department_id, client_key, note?,
 *          lines: [{ req_item_id, quantity_purchase? | send_all_owed?: true, expect_sent_line? }] }
 *        → 201 { transfer, requisition, lines, party_store_part_pending, message, duplicate: false }
 *        → 200 the same, duplicate: true — this client_key already made it (a retry)
 *        → 409 { error, code } — refused, NOTHING written: not_routed_here,
 *          not_with_store, line_closed, nothing_owed, receiver_mismatch,
 *          unit_review, line_changed, over_owed, idempotency_conflict, or the
 *          transfer writer's own (insufficient …)
 *
 * Signed-in only (401). CSRF: covered by the '/api/department-transfers'
 * prefix in src/proxy.ts. The outlet is read before any transaction — nothing
 * is awaited inside one.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const url = new URL(request.url);
    const departmentId = (url.searchParams.get('department_id') || me.department_id || '').trim();
    if (!departmentId) return Response.json({ error: 'department_id is required' }, { status: 400 });
    const outletId = await getCurrentOutletId();
    const out = toSendView(getDb(), me, departmentId, outletId);
    return Response.json(out.body, { status: out.status });
  } catch (e: any) {
    console.error('[department-transfers/to-send GET]', e);
    return Response.json({ error: e?.message || 'Failed to load the To send list' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Body must be a JSON object' }, { status: 400 });
  const outletId = await getCurrentOutletId();
  try {
    const out = routedSendPost(getDb(), me, body, outletId);
    return Response.json(out.body, { status: out.status });
  } catch (e: any) {
    console.error('[department-transfers/to-send POST]', e);
    return Response.json({ error: e?.message || 'Send failed' }, { status: 500 });
  }
}
