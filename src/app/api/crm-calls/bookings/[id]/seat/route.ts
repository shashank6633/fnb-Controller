/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { seatBooking } from '@/lib/ct/seating';

/**
 * CRM Call-to-Table — seat a booking onto a table
 * (POST /api/crm-calls/bookings/:id/seat).
 *
 * Body: { table_id }.
 * Links booking ↔ table ↔ order (reusing the table's open order or opening
 * one), flips the booking to 'seated', and adds the booking's guest as the
 * table party PRIMARY. Because you seat the PARTY (not a person), it doesn't
 * matter which member arrives first.
 *
 * Any signed-in user (host/captain access governed by page-access). CSRF on
 * POST is enforced by the client `api()` helper + proxy.
 *
 * ── A DELIBERATE EXEMPTION FROM THE GRE READ-ONLY RULE (owner, 2026-09-25) ───
 * The Guest Feedback module holds GREs READ-ONLY on the POS: they cannot place
 * an order, cancel an item, change a quantity, modify a KOT, modify a bill or
 * apply a discount. This route breaches that letter — seating opens an order on
 * the table (or edits the one already there) — and it is open to any signed-in
 * user, which an adversarial probe measured as an assigned GRE on 2026-09-22.
 *
 * That was put to the owner as his call rather than patched, and he ruled:
 * SEATING IS THE GRE'S JOB. A GRE greeting guests at the door and walking them
 * to a table is the front-office role; making them fetch a captain to do the
 * thing they are standing there to do would be a rule defeating its own purpose.
 *
 * So the read-only rule means exactly what it says and nothing more: no orders,
 * no quantities, no KOT edits, no bills, no discounts. Seating is not on that
 * list. Do not "fix" this route by gating it against GREs without asking him —
 * it would read as a bug in the feature rather than the decision it is.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  const { id } = await params;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }

  const tableId = String(body.table_id || '').trim();
  if (!tableId) return Response.json({ error: 'table_id is required' }, { status: 400 });

  const db = getDb();
  const outletId = await getCurrentOutletId();

  const result = seatBooking(db, {
    bookingId: id,
    tableId,
    outletId,
    serverId: me.id,
    serverName: me.name || me.email,
  });

  if (!result.ok) {
    return Response.json({ error: result.error || 'Seat failed' }, { status: result.status || 500 });
  }
  return Response.json(result);
}
