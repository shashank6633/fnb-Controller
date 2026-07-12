/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { normalizeMobile, tierForPoints, upsertGuestVisit, loyaltyPointsPer100 } from '@/lib/crm-guests';

/**
 * POS settle hook — capture the guest at bill settle (feeds CRM loyalty).
 *
 * POST /api/crm/guests/settle-capture  { mobile, name?, order_id, bill_amount }
 *   → upsertGuestVisit() with source 'pos' (find-or-create guest, accrue points).
 *
 * Gate: any signed-in user (captains are staff tier — unlike /crm/guests/visit
 * this endpoint is intentionally open to the whole floor team).
 *
 * DEDUPE: if a crm_guest_visits row already exists for this order_id the call
 * is a no-op ({ deduped: true }) — double-taps / retries can't double-accrue.
 *
 * Clients call this fire-and-forget AFTER the settle succeeds; a failure here
 * must never block or roll back the settle itself.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const mobile = normalizeMobile(body?.mobile);
  if (!mobile) return Response.json({ error: 'Valid 10-digit mobile required' }, { status: 400 });

  const orderId = String(body?.order_id || '').trim();
  if (!orderId) return Response.json({ error: 'order_id required' }, { status: 400 });

  const bill = Number(body?.bill_amount);
  if (!Number.isFinite(bill) || bill < 0) {
    return Response.json({ error: 'bill_amount must be a number ≥ 0' }, { status: 400 });
  }

  try {
    const db = getDb();

    // Server-side dedupe — one loyalty visit per order, ever.
    const existing = db.prepare('SELECT id FROM crm_guest_visits WHERE order_id = ?').get(orderId);
    if (existing) return Response.json({ success: true, deduped: true, points_earned: 0 });

    const pointsEarned = Math.round((bill / 100) * loyaltyPointsPer100() * 100) / 100;
    const guest = upsertGuestVisit({
      mobile,
      name: typeof body?.name === 'string' ? body.name : undefined,
      bill_amount: bill,
      order_id: orderId,
      source: 'pos',
    });
    return Response.json({
      success: true,
      guest: { ...guest, tier: tierForPoints(guest.points) },
      points_earned: pointsEarned,
    });
  } catch (e: any) {
    console.error('POST /api/crm/guests/settle-capture failed:', e);
    return Response.json({ error: e?.message || 'Failed to capture guest' }, { status: 500 });
  }
}
