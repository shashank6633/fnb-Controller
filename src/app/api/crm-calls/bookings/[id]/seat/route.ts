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
