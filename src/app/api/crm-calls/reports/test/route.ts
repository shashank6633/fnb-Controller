/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { runReportJob, scheduledReportKeys, istDateBack, reportConfig } from '@/lib/wa-report-jobs';
import { firePriceHikeAlert, fireDiscountAlert, fireReservationConfirmation } from '@/lib/wa-report-events';
import { numberForUserId } from '@/lib/wa-report-recipients';
import { reportDef } from '@/lib/wa-report-builders';

/**
 * POST /api/crm-calls/reports/test  { key }  — SEND TEST NOW.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ A TEST GOES TO THE PERSON WHO PRESSED THE BUTTON. NOBODY ELSE. EVER.     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * The recipient is resolved from the SESSION — users.wa_mobile for the signed-in
 * user, falling back to their HR record — and the request body cannot influence
 * it. There is deliberately no `to` parameter: a test button that accepts a
 * destination is an authenticated way to send a restaurant's P&L to any number
 * on earth, and "it's only a test" is exactly the framing that gets that
 * shipped.
 *
 * The consequence, stated plainly for the person pressing it: if the owner's
 * number is not on their own login, the test refuses with instructions rather
 * than falling back to the configured recipient list. Falling back would mean
 * the button that says "send me a test" sends the report to the management
 * group — the single most surprising thing it could do.
 *
 * WHAT IS AND IS NOT BYPASSED
 *   · the on/off toggle           NOT bypassed. A test proves the real path.
 *   · the template + credentials  NOT bypassed. That is what is being tested.
 *   · the configured recipients   BYPASSED — replaced with the tester alone.
 *   · the once-a-day slot         BYPASSED, and NOT consumed: the run is
 *                                 recorded as trigger_source 'test', which the
 *                                 partial unique index does not cover, so the
 *                                 real 08:00 send still happens.
 *   · the guest on a booking      BYPASSED. A test of the reservation
 *                                 confirmation must never reach a customer.
 *
 * Management may test (one message, to themselves). Only an admin may change
 * the configuration — see the config route.
 */
export const dynamic = 'force-dynamic';

/** A real record to build an event alert from, so a test shows real content. */
function sampleFor(db: any, key: string): { id: string; materialIds?: string[]; detail?: string } | null {
  try {
    if (key === 'discount_alert') {
      const r = db.prepare('SELECT id FROM discount_requests ORDER BY created_at DESC LIMIT 1').get() as any;
      return r ? { id: String(r.id) } : null;
    }
    if (key === 'reservation_confirmation') {
      const r = db.prepare(`
        SELECT b.id FROM ct_bookings b JOIN ct_guests g ON g.id = b.guest_id
         WHERE b.is_duplicate = 0 AND TRIM(COALESCE(g.phone_e164,'')) <> ''
           AND lower(b.status) IN ('confirmed','booked','seated','completed')
         ORDER BY b.booking_date DESC LIMIT 1
      `).get() as any;
      return r ? { id: String(r.id) } : null;
    }
    if (key === 'price_hike') {
      // Every material with more than one purchase — the alert then filters to
      // whatever is genuinely over the threshold, so a test either shows a real
      // spike or honestly reports that there is none.
      const rows = db.prepare(`
        SELECT material_id FROM purchases GROUP BY material_id HAVING COUNT(*) > 1 LIMIT 500
      `).all() as any[];
      return rows.length ? { id: 'test', materialIds: rows.map(r => String(r.material_id)) } : null;
    }
  } catch { /* fall through */ }
  return null;
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!isManagement(me)) {
    return Response.json({ error: 'Scheduled reports are limited to admins, managers and heads of department.' }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as any;
  const key = String(body?.key || '').trim();
  const def = reportDef(key);
  if (!def) return Response.json({ error: `"${key}" is not a report this app knows about.` }, { status: 400 });
  if (def.unimplemented) {
    return Response.json({ error: def.unimplementedReason || 'That report is not built.' }, { status: 400 });
  }

  const db = getDb();

  // THE ONLY RECIPIENT. From the session, never from the request.
  const mine = numberForUserId(db, me.id);
  if (!mine.number) {
    return Response.json({
      error: 'Your login has no WhatsApp number on it, so there is nowhere to send the test. '
        + 'Add your number under “My WhatsApp number” on this page, then try again.',
      needs_own_number: true,
    }, { status: 400 });
  }

  const cfg = reportConfig(db, key);
  if (!cfg.enabled) {
    return Response.json({
      error: 'This report is switched off. Turn it on (and save) before testing — a test is meant to exercise the real path, so it does not bypass the switch.',
    }, { status: 400 });
  }

  try {
    if (scheduledReportKeys().includes(key)) {
      const res = await runReportJob(db, key, {
        trigger: 'test',
        actor: `test:${me.email}`,
        recipientsOverride: [mine.number],
        // The most recent day with figures, not "yesterday" — a test that lands
        // on a closed Monday reports "nothing to send" and proves nothing about
        // the template. offset_days still governs the real schedule.
        date: istDateBack(cfg.offsetDays),
      });
      return Response.json({ ok: res.status === 'sent' || res.status === 'partial', result: res, sent_to: mine.number, sent_to_name: mine.name });
    }

    const sample = sampleFor(db, key);
    if (!sample) {
      return Response.json({
        error: key === 'reservation_confirmation'
          ? 'No confirmed reservation with a guest phone number exists to build a test from.'
          : key === 'discount_alert'
            ? 'No discount request exists to build a test from.'
            : 'No purchase history exists to build a price-hike test from.',
      }, { status: 400 });
    }

    const opts = { trigger: 'test' as const, actor: `test:${me.email}`, recipientsOverride: [mine.number] };
    const res = key === 'price_hike'
      ? await firePriceHikeAlert(db, { materialIds: sample.materialIds || [], sourceId: 'test' }, opts)
      : key === 'discount_alert'
        ? await fireDiscountAlert(db, { requestId: sample.id }, opts)
        : await fireReservationConfirmation(db, { bookingId: sample.id }, opts);

    return Response.json({
      ok: res.status === 'sent' || res.status === 'partial',
      result: res, sent_to: mine.number, sent_to_name: mine.name,
    });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'The test send failed.' }, { status: 500 });
  }
}
