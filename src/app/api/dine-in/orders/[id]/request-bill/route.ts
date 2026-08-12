import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { settleAuthority, tillCapable } from '@/lib/settle-authority';
import {
  getBillRequest, requestBill, markBillRequestSeen, cancelBillRequest,
  type BillRequest,
} from '@/lib/bill-request';

/**
 * CAPTAIN ASKS THE CASHIER FOR THE BILL.
 *
 *   GET  /api/dine-in/orders/[id]/request-bill
 *        → { request, canSettle, reason, message, floor, floorName, cashier,
 *            offerCheckIn, offerTakeOver, orderStatus }
 *        The captain screen asks this ONE question — "can I take this payment,
 *        and has anyone been asked?" — and renders either the Collect-payment
 *        sheet or a Request Bill button from the answer. Without it the tablet
 *        would keep offering a sheet that 403s on the last tap, in front of the
 *        guest. `canSettle` is settleAuthority's own verdict, so the button on
 *        screen and the gate on POST /settle can never disagree.
 *
 *   POST /api/dine-in/orders/[id]/request-bill   { action?: 'request' }
 *        Raise the request. IDEMPOTENT — four impatient taps produce one
 *        request and one alert (see requestBill()); the reply says
 *        `created: false` so the UI can say "already sent" rather than
 *        pretending a second one went out.
 *
 *   POST … { action: 'seen' }
 *        Acknowledge — "a cashier has this". GATED ON settleAuthority: only
 *        somebody who could actually settle this bill may silence its alert.
 *        Anything looser and a captain browsing the board would quietly clear
 *        the cashier's bell.
 *
 *   POST … { action: 'cancel' }
 *        Withdraw a mis-tap. GATED (D14): only the captain who raised the
 *        request, or someone till-capable (tillCapable() — every manager and
 *        admin passes it), may withdraw; any other signed-in user gets a 403
 *        naming who can. A SEEN request stays withdrawable by those same
 *        people (D15): "seen" is stamped the moment someone who could settle
 *        OPENS the bill, which is not proof anyone is walking over, so the
 *        original requester keeps the way out of a mis-tap.
 *
 * WHY 'request' IS OPEN TO ANY SIGNED-IN USER. It writes a flag, moves no money,
 * and is reversible. The tight gate belongs on settle, and that is where it is.
 * A stricter test here would have to be a role or area check — and the measured
 * facts kill both: Captain and Cashier are both base_role 'staff', and
 * canWorkTable() is inert (its captain_area_lock setting has never existed), so
 * any such gate would be either a no-op or a lockout.
 */
export const dynamic = 'force-dynamic';

/**
 * WHO MAY WITHDRAW a standing request (D14, D15): the captain who raised it,
 * or anyone till-capable — and tillCapable() already returns true for every
 * manager/admin, so "requester OR till-capable OR management" collapses to the
 * two-term test below.
 *
 * Requester identity is matched on the SAME derived display string the POST
 * stores (trim, then the 120-char cap requestBill() applies), because
 * orders.bill_requested_by is the only requester stamp the row carries — there
 * is no requester user-id column, and adding one is a schema change this fix
 * does not make. Two users with an identical display name would therefore both
 * count as the requester; that is accepted for a reversible flag (a withdrawn
 * request is re-raised in one tap). An empty derived name never matches — a
 * nameless session must not become everyone's requester.
 */
function mayCancel(me: any, request: Pick<BillRequest, 'requestedBy'>): boolean {
  const who = String(me?.name || me?.email || '').trim().slice(0, 120);
  const isRequester = who !== '' && request.requestedBy === who;
  return isRequester || tillCapable(me);
}

/** The shared reply: request state + this caller's settle verdict for this bill. */
function state(db: ReturnType<typeof getDb>, me: any, order: any, outletId: string | null, extra?: Record<string, unknown>) {
  const auth = settleAuthority(db, me, order, outletId);
  const request = getBillRequest(db, String(order?.id || ''));
  return Response.json({
    ...extra,
    orderStatus: String(order?.status || ''),
    request,
    canSettle: auth.allowed,
    // Whether THIS caller could withdraw the standing request (null request →
    // false). The sheet renders its Withdraw button from this, so the button
    // and the cancel gate below can never disagree.
    canCancel: request ? mayCancel(me, request) : false,
    reason: auth.reason,
    message: auth.message,
    floor: auth.floor,
    floorName: auth.floorName,
    // Only the holder's display name is needed on screen; the presence row's
    // ids stay server-side. This is the fact the captain sheet renders its
    // "who this goes to" line from (D2) — populated on every reply, refusals
    // included, because settle-authority looks the holder up before branching.
    cashier: auth.cashier ? { userId: auth.cashier.userId, userName: auth.cashier.userName } : null,
    offerCheckIn: auth.offerCheckIn,
    offerTakeOver: auth.offerTakeOver,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    return state(db, me, order, outletId);
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/request-bill GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const outletId = await getCurrentOutletId();

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    if (order.status !== 'open') {
      // A settled / held / voided bill has left the cashier's board, so a marker
      // on it could never be cleared by anyone.
      return Response.json({ error: 'This bill is no longer open.' }, { status: 409 });
    }

    const body = await req.json().catch(() => ({}));
    const action = String((body as any)?.action || 'request');
    const who = String(me.name || me.email || '').trim();

    if (action === 'seen') {
      // Same authority as settle — an alert may only be silenced by someone who
      // could answer it.
      const auth = settleAuthority(db, me, order, outletId);
      if (!auth.allowed) {
        return Response.json({ error: auth.message, reason: auth.reason }, { status: auth.status });
      }
      markBillRequestSeen(db, id, who);
      return state(db, me, order, outletId, { action: 'seen' });
    }

    if (action === 'cancel') {
      // D14: no longer open to any signed-in user — see mayCancel(). The old
      // seen-state 409 is gone with it (D15): "seen" means somebody OPENED the
      // bill, and the original requester may still withdraw past that.
      const existing = getBillRequest(db, id);
      if (existing && !mayCancel(me, existing)) {
        return Response.json({
          error:
            'Only ' + (existing.requestedBy || 'the captain who requested this bill') +
            ', a cashier, or a manager can withdraw this request.',
          reason: 'cancel_not_allowed',
        }, { status: 403 });
      }
      const cleared = cancelBillRequest(db, id);
      return state(db, me, order, outletId, { action: 'cancel', cleared });
    }

    if (action !== 'request') {
      return Response.json({ error: 'Unknown action' }, { status: 400 });
    }

    const res = requestBill(db, id, who);
    if (!res.ok) return Response.json({ error: 'This bill is no longer open.' }, { status: 409 });
    return state(db, me, order, outletId, { action: 'request', created: res.created });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/request-bill POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
