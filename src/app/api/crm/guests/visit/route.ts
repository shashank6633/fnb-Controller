/* eslint-disable @typescript-eslint/no-explicit-any */
import { getCurrentUser } from '@/lib/auth';
import { normalizeMobile, tierForPoints, upsertGuestVisit } from '@/lib/crm-guests';

/**
 * Record a guest visit (loyalty accrual).
 *
 * POST /api/crm/guests/visit  { mobile, name?, bill_amount, order_id?, source? }
 *        → upsertGuestVisit(): find-or-create the guest, bump visit_count /
 *          last_visit_at / total_spend, accrue points at
 *          settings.crm_loyalty_points_per_100 per ₹100, append the visit row.
 *          Returns { guest (+tier) }.
 *
 * This is the endpoint the POS settle hook will call in a later pass; today it
 * also serves the manual "Record Visit" form on /crm/guests (source 'manual').
 *
 * Gate: admin, manager tier, or HOD (is_head_chef). Signed-out → 401.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!(me.role === 'admin' || me.role === 'manager' || me.is_head_chef)) {
    return Response.json({ error: 'Not authorised' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  if (!normalizeMobile(body?.mobile)) {
    return Response.json({ error: 'Valid 10-digit mobile required' }, { status: 400 });
  }
  const bill = Number(body?.bill_amount);
  if (!Number.isFinite(bill) || bill < 0) {
    return Response.json({ error: 'bill_amount must be a number ≥ 0' }, { status: 400 });
  }

  try {
    const guest = upsertGuestVisit({
      mobile: body.mobile,
      name: body?.name,
      bill_amount: bill,
      order_id: body?.order_id,
      source: body?.source || 'manual',
    });
    return Response.json({ guest: { ...guest, tier: tierForPoints(guest.points) } });
  } catch (e: any) {
    console.error('POST /api/crm/guests/visit failed:', e);
    return Response.json({ error: e?.message || 'Failed to record visit' }, { status: 500 });
  }
}
