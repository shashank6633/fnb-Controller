/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { normalizeWaNumber } from '@/lib/whatsapp';
import { numberForUserId } from '@/lib/wa-report-recipients';

/**
 * PUT /api/crm-calls/reports/numbers  { user_id?, mobile }
 *
 * Put a WhatsApp number against a LOGIN, so a report can be addressed to "the
 * Bar HOD" and still reach a phone. Writes users.wa_mobile and nothing else.
 *
 * ── WHY THIS LIVES HERE AND NOT ON THE USERS PAGE ────────────────────────
 * Because this is where the gap is discovered. An admin ticks "Management",
 * the preview says three people are unreachable, and the fix has to be one
 * click away — not a trip to another screen and back. The Users page remains
 * untouched; this route writes one additive column that nothing else reads.
 *
 * ── WHO MAY SET WHOSE ────────────────────────────────────────────────────
 *   own number    — any management user. Needed for Send Test to have anywhere
 *                   to go, and nobody is harmed by a person choosing where
 *                   their own alerts land.
 *   someone else's — ADMIN ONLY. Writing a colleague's number decides where a
 *                   report about the restaurant's money is delivered; a manager
 *                   who could do it could redirect the P&L to a phone of their
 *                   choosing by writing it onto a dormant admin login.
 *
 * Clearing a number (empty string) is allowed and means "unreachable" — an
 * honest state the preview shows, not a silent drop.
 */
export const dynamic = 'force-dynamic';

export async function PUT(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!isManagement(me)) {
    return Response.json({ error: 'Scheduled reports are limited to admins, managers and heads of department.' }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as any;
  const targetId = String(body?.user_id || me.id).trim();
  if (targetId !== me.id && me.role !== 'admin') {
    return Response.json({ error: 'Only an admin may set another person’s WhatsApp number.' }, { status: 403 });
  }

  const raw = String(body?.mobile ?? '').trim();
  let value = '';
  if (raw) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      return Response.json({ error: 'That is not a phone number — 10 to 15 digits, with or without the country code.' }, { status: 400 });
    }
    value = normalizeWaNumber(raw);
    if (!value) return Response.json({ error: 'That number could not be read.' }, { status: 400 });
  }

  const db = getDb();
  const target = db.prepare('SELECT id, name FROM users WHERE id = ? AND is_active = 1').get(targetId) as any;
  if (!target) return Response.json({ error: 'That user no longer exists.' }, { status: 404 });

  try {
    db.prepare('UPDATE users SET wa_mobile = ? WHERE id = ?').run(value, targetId);
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Could not save that number.' }, { status: 500 });
  }

  const now = numberForUserId(db, targetId);
  return Response.json({ ok: true, user_id: targetId, name: target.name, number: now.number, source: now.source });
}

/** GET — the signed-in user's own number, for the Send Test affordance. */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!isManagement(me)) {
    return Response.json({ error: 'Scheduled reports are limited to admins, managers and heads of department.' }, { status: 403 });
  }
  const mine = numberForUserId(getDb(), me.id);
  return Response.json({ user_id: me.id, name: me.name, number: mine.number, source: mine.source });
}
