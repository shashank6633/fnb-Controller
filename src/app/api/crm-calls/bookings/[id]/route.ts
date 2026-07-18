/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * CRM Call-to-Table — single booking (/api/crm-calls/bookings/:id).
 *
 * GET → booking + joined guest name/phone.
 * PUT → { status } transitions (pending | confirmed | seated | completed |
 *        no_show | cancelled — enum-validated; seated/completed set nothing
 *        else, metrics derive from status) and/or field edits
 *        (booking_date, slot_time, party_size, occasion, section_pref,
 *        advance_amount, notes). updated_at is always bumped.
 *
 * Any signed-in user (GRE access governed by page-access). CSRF on PUT is
 * enforced by the client `api()` helper + proxy.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BOOKING_STATUSES = ['pending', 'confirmed', 'seated', 'completed', 'no_show', 'cancelled'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** True only if `d` (already DATE_RE-shaped) is a real calendar date. */
function isRealDate(d: string): boolean {
  const dt = new Date(`${d}T00:00:00Z`);
  return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}

const GUEST_JOIN_SELECT = `
  SELECT b.*, g.name AS guest_name, g.phone_e164 AS guest_phone, g.tags AS guest_tags
  FROM ct_bookings b
  LEFT JOIN ct_guests g ON g.id = b.guest_id
`;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  const { id } = await params;
  const db = getDb();
  const booking = db.prepare(`${GUEST_JOIN_SELECT} WHERE b.id = ?`).get(id);
  if (!booking) return Response.json({ error: 'Booking not found' }, { status: 404 });
  return Response.json({ booking });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const db = getDb();
  const existing = db.prepare('SELECT * FROM ct_bookings WHERE id = ?').get(id) as any;
  if (!existing) return Response.json({ error: 'Booking not found' }, { status: 404 });

  const sets: string[] = [];
  const sqlParams: any[] = [];

  if (body.status !== undefined) {
    const status = String(body.status || '').trim();
    if (!(BOOKING_STATUSES as readonly string[]).includes(status)) {
      return Response.json({ error: `status must be one of ${BOOKING_STATUSES.join(', ')}` }, { status: 400 });
    }
    sets.push('status = ?');
    sqlParams.push(status);
  }

  if (body.booking_date !== undefined) {
    const d = String(body.booking_date || '').trim();
    if (!DATE_RE.test(d) || !isRealDate(d)) return Response.json({ error: 'booking_date must be a real calendar date (YYYY-MM-DD)' }, { status: 400 });
    sets.push('booking_date = ?');
    sqlParams.push(d);
  }

  if (body.slot_time !== undefined) {
    sets.push('slot_time = ?');
    sqlParams.push(String(body.slot_time || '').trim().slice(0, 32));
  }

  if (body.party_size !== undefined) {
    const n = Number(body.party_size);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 500) {
      return Response.json({ error: 'party_size must be a whole number between 1 and 500' }, { status: 400 });
    }
    sets.push('party_size = ?');
    sqlParams.push(n);
  }

  if (body.occasion !== undefined) {
    sets.push('occasion = ?');
    sqlParams.push(String(body.occasion || '').trim().slice(0, 200));
  }

  if (body.section_pref !== undefined) {
    sets.push('section_pref = ?');
    sqlParams.push(String(body.section_pref || '').trim().slice(0, 200));
  }

  if (body.advance_amount !== undefined) {
    const a = Number(body.advance_amount);
    if (!Number.isFinite(a) || a < 0) {
      return Response.json({ error: 'advance_amount must be a non-negative number' }, { status: 400 });
    }
    sets.push('advance_amount = ?');
    sqlParams.push(a);
  }

  if (body.notes !== undefined) {
    sets.push('notes = ?');
    sqlParams.push(String(body.notes || '').trim().slice(0, 2000));
  }

  if (sets.length === 0) return Response.json({ error: 'nothing to update' }, { status: 400 });

  // updated_at always bumps on any edit.
  sets.push('updated_at = ?');
  sqlParams.push(new Date().toISOString());

  sqlParams.push(id);
  db.prepare(`UPDATE ct_bookings SET ${sets.join(', ')} WHERE id = ?`).run(...sqlParams);

  const booking = db.prepare(`${GUEST_JOIN_SELECT} WHERE b.id = ?`).get(id);
  return Response.json({ success: true, booking });
}
