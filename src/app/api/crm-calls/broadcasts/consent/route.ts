/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { norm10 } from '@/lib/ct/guest-unify';
import {
  consentFor, consentHistory, listConsent, setConsent, isOptedOut,
} from '@/lib/wa-consent';

/**
 * /api/crm-calls/broadcasts/consent — marketing-consent state per guest phone.
 *
 * GET  ?phone=…          → that phone's standing state + audit history
 *      ?status=opted_out → list standing rows (default: all explicit rows)
 *      Absence of a row means DEFAULT — messageable; nobody is opted out
 *      until they (or Meta, or a manager) say so.
 *
 * POST { phone, action: 'opt_out' | 'opt_in', reason? } — the MANUAL toggle.
 *      This is the ONLY way back in after a STOP: inbound re-opt-in keywords
 *      are deliberately not honoured (the webhook is public/unsigned — a
 *      forged POST must only ever be able to opt someone OUT).
 *
 * Management-only, both verbs.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  const db = getDb();
  const url = new URL(req.url);
  const phone = String(url.searchParams.get('phone') || '').trim();

  if (phone) {
    const key = norm10(phone);
    if (!key) return Response.json({ error: 'Phone must contain a 10-digit mobile number' }, { status: 400 });
    return Response.json({
      phone_key: key,
      opted_out: isOptedOut(db, key),
      consent: consentFor(db, key),   // null = default (messageable)
      history: consentHistory(db, key),
    });
  }

  const status = String(url.searchParams.get('status') || '').trim();
  if (status && status !== 'opted_out' && status !== 'opted_in') {
    return Response.json({ error: "status must be 'opted_out' or 'opted_in'" }, { status: 400 });
  }
  return Response.json({
    consent: listConsent(db, status ? { status: status as any } : {}),
    note: 'Only explicit states are listed — a phone with no row here is messageable by default.',
  });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const key = norm10(String(body?.phone || ''));
  if (!key) return Response.json({ error: 'phone must contain a 10-digit mobile number' }, { status: 400 });

  const action = String(body?.action || '').trim();
  if (action !== 'opt_out' && action !== 'opt_in') {
    return Response.json({ error: "action must be 'opt_out' or 'opt_in'" }, { status: 400 });
  }

  const db = getDb();
  const ok = setConsent(db, {
    phoneKey: key,
    status: action === 'opt_out' ? 'opted_out' : 'opted_in',
    source: 'manual',
    detail: String(body?.reason || '').slice(0, 300),
    changedBy: me.email || me.name || me.id,
  });
  if (!ok) return Response.json({ error: 'Failed to record consent change' }, { status: 500 });

  return Response.json({
    success: true,
    phone_key: key,
    consent: consentFor(db, key),
    history: consentHistory(db, key, 5),
  });
}
