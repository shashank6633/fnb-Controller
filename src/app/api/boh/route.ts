import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { ensureBohSchema } from '@/lib/boh-schema';
import { listBoh, getBohByOrder, createBohForHold, BohError } from '@/lib/boh';
import { canUseBoh, bohScopeFor, bohIsManagement, canActOnBoh } from '@/lib/boh-access';

/**
 * GET  /api/boh — the BOH register.
 * POST /api/boh — BACKFILL a BOH for a bill that is already on hold.
 *
 * ── THIS ROUTE GATES ITSELF, AND THAT IS THE ONLY REAL GATE ─────────────────
 * proxy.ts guards PAGES, not APIs, and canAccessPage fails open four ways.
 * Measured on the owner's live data: role_id is set on 0 of 9 users and
 * page_access is NULL on 8 (NULL = all pages), so page gating is inert in
 * production. Every check below is done here, from the session, and nothing
 * relies on the proxy having refused anyone.
 *
 * ── VISIBILITY IS SCOPED, NOT OPEN ─────────────────────────────────────────
 * A BOH row carries a customer's NAME, their PHONE NUMBER and an amount owed.
 * Management sees the register; everyone else sees the bills they are
 * responsible for or created. bohScopeFor() returns the filter value itself
 * rather than a boolean, so a future edit cannot forget to apply it and still
 * produce a sensible query.
 *
 * DELIBERATELY NOT the shape of GET /api/dine-in/orders?status=on_hold
 * (orders/route.ts:7-31), which has no gate beyond a session and returns o.* —
 * guest_name, guest_mobile, total — to any signed-in user. That route is
 * outside this lane and /cashier depends on it; it is not retrofitted here.
 *
 * The path contains no 'print' substring (proxy.ts:132 would make such a path
 * PUBLICLY UNAUTHENTICATED) and no file extension, so neither isPublic()
 * carve-out can reach it. Writes are CSRF-protected by the '/api/boh' prefix
 * in proxy.ts's CSRF_REQUIRED_PREFIXES; clients must use src/lib/api.ts.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canUseBoh(me)) {
      return Response.json({
        error: 'Your role does not include the Cashier page, so you cannot open the Bills on Hold register. ' +
               'Ask an admin to assign you the Cashier role in Settings → Roles.',
      }, { status: 403 });
    }
    const db = getDb();
    // Self-heal: a schema error swallowed by initializeSchema at boot is
    // repaired here rather than becoming a permanent "no such table" 500.
    if (!ensureBohSchema(db)) {
      return Response.json({ error: 'The Bills on Hold tables are unavailable on this database.' }, { status: 503 });
    }
    const outletId = await getCurrentOutletId();
    const u = new URL(req.url);

    // THE SCOPE IS NOT CLIENT-SUPPLIED. A non-management caller is pinned to
    // their own user id whatever the query string says; management may narrow
    // to one user with ?user=.
    const mine = bohScopeFor(me);
    const asked = u.searchParams.get('user');
    const responsibleUserId = mine === null ? (asked ? String(asked) : null) : mine;

    const rows = listBoh(db, {
      responsibleUserId,
      outletId,
      status: u.searchParams.get('status'),
      followupState: u.searchParams.get('followup'),
      bucket: u.searchParams.get('bucket'),
      from: u.searchParams.get('from'),
      to: u.searchParams.get('to'),
      q: u.searchParams.get('q'),
      limit: Number(u.searchParams.get('limit')) || 200,
      offset: Number(u.searchParams.get('offset')) || 0,
    });

    return Response.json({
      rows,
      scope: mine === null ? 'all' : 'own',
      is_management: bohIsManagement(me),
    });
  } catch (e: any) {
    console.error('[/api/boh GET]', e);
    return Response.json({ error: e?.message || 'Failed to load bills on hold' }, { status: 500 });
  }
}

/**
 * Backfill the BOH for an order that is ALREADY on hold.
 *
 * This is NOT a second way to hold a bill and it cannot create one: it refuses
 * anything whose order is not already status='on_hold'. It exists because
 * createBohForHold is best-effort at the moment of hold (it must never roll
 * back a committed hold), and for the bills held before this module shipped.
 *
 * Gated by settleAuthority through canActOnBoh — the SAME function the hold
 * route calls, so the two can never drift.
 */
export async function POST(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canUseBoh(me)) {
      return Response.json({ error: 'Your role does not include the Cashier page, so you cannot open a BOH record.' }, { status: 403 });
    }
    const db = getDb();
    if (!ensureBohSchema(db)) {
      return Response.json({ error: 'The Bills on Hold tables are unavailable on this database.' }, { status: 503 });
    }
    const outletId = await getCurrentOutletId();
    const b = await req.json().catch(() => ({}));
    const orderId = String(b?.order_id || '').trim();
    if (!orderId) return Response.json({ error: 'order_id is required' }, { status: 400 });

    const order = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(orderId) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    if (String(order.status) !== 'on_hold') {
      return Response.json({
        error: `That bill is '${order.status}', not on hold. A BOH record only tracks a bill the POS is holding — ` +
               `put it on hold from the Cashier screen first.`,
      }, { status: 409 });
    }

    const existing = getBohByOrder(db, orderId);
    if (existing) return Response.json({ boh: existing, created: false, note: 'A BOH record already exists for this bill.' });

    const gate = canActOnBoh(db, me, { order_id: orderId, responsible_user_id: '' }, outletId);
    if (!gate.allowed) return Response.json({ error: gate.message, ...(gate.detail || {}) }, { status: gate.status });

    // The responsible user may be named explicitly (the person who will chase
    // it), defaulting to the caller. A BOH never exists without one.
    const responsibleId = String(b?.responsible_user_id || '').trim() || me.id;
    const who = db.prepare('SELECT id, email, name, is_active FROM users WHERE id = ?').get(responsibleId) as any;
    if (!who?.id) return Response.json({ error: 'That responsible user does not exist' }, { status: 400 });
    if (who.is_active === 0) return Response.json({ error: 'That user is deactivated — pick someone who can still act on it' }, { status: 400 });

    const res = createBohForHold(db, {
      orderId, outletId,
      responsible: { id: who.id, email: who.email, name: who.name },
      customerName: b?.customer_name, customerMobile: b?.customer_mobile,
      customerCompany: b?.customer_company,
      reason: b?.reason, remarks: b?.remarks,
      expectedPaymentDate: b?.expected_payment_date,
      departmentId: b?.department_id,
    }, { id: me.id, email: me.email, name: me.name, role: me.role });

    if (!res.created && !res.boh) {
      return Response.json({ error: res.reason || 'Could not open the BOH record' }, { status: 400 });
    }
    return Response.json({ boh: res.boh, created: res.created, contact_missing: res.contactMissing });
  } catch (e: any) {
    if (e instanceof BohError) return Response.json({ error: e.message }, { status: e.status });
    console.error('[/api/boh POST]', e);
    return Response.json({ error: e?.message || 'Failed to open the BOH record' }, { status: 500 });
  }
}
