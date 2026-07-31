/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  sendCampaign, countByStatus, parseCampaignMeta, campaignReport,
  SEND_BATCH_MAX, WINBACK_FLAG,
} from '@/lib/ct/winback';

/**
 * CRM — SEND a win-back campaign (/api/crm-calls/campaigns/:id/send).
 *
 * THE ONLY PLACE IN THE APP THAT MESSAGES A LAPSED GUEST. It is a POST, it is
 * never called on a page load, and there is no scheduler anywhere that calls
 * it. Every message that leaves is the direct result of a human pressing Send.
 *
 * Four locks, in order:
 *   1. Management session (admin / manager / HOD).
 *   2. `confirm: true` in the body — a bare POST does nothing.
 *   3. `expect_count` must equal the number of guests the server is actually
 *      about to message. If the list moved under the operator (someone else
 *      sent, a target failed, a draft grew), the send is REFUSED with the real
 *      number so they re-read the screen and press again on purpose.
 *   4. ct_settings.winback_enabled must be '1' AND the WhatsApp provider must
 *      be configured — both checked inside sendCampaign().
 *
 * Body: { confirm: true, expect_count: number, batch?: number, retry_failed?: boolean }
 *
 * Resumability: sendCampaign claims each row 'pending' → 'sending' before it
 * calls the provider, so a crash mid-batch leaves already-sent rows at 'sent'
 * and a resume never touches them. Rows stuck at 'sending' are reported as
 * `unconfirmed` and are NEVER retried automatically.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REFUSAL_MESSAGE: Record<string, string> = {
  disabled: `Win-back sending is switched OFF (ct_settings.${WINBACK_FLAG}). An admin must enable it on the Win-back page before any guest can be messaged.`,
  wa_not_configured: 'WhatsApp is not configured — no provider credentials. Nothing was sent. Set it up in Settings → WhatsApp.',
  no_template: 'This campaign has no approved WhatsApp template name, so there is nothing Meta would deliver.',
  not_found: 'Campaign not found.',
  nothing_pending: 'Every guest in this campaign has already been messaged. Nothing was sent.',
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  const { id } = await params;

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }

  if (body?.confirm !== true) {
    return Response.json({
      error: 'Refusing to send without an explicit confirmation. Re-send this request with { confirm: true } after showing the operator the recipient count and the message.',
    }, { status: 400 });
  }

  const db = getDb();
  const campaign = db.prepare(`SELECT * FROM ct_campaigns WHERE id = ?`).get(id) as any;
  if (!campaign) return Response.json({ error: 'Campaign not found' }, { status: 404 });

  const retryFailed = body?.retry_failed === true;
  const batch = Math.min(Math.max(Number(body?.batch) || SEND_BATCH_MAX, 1), SEND_BATCH_MAX);

  // What is genuinely queued right now, before anything moves.
  const before = countByStatus(db, id);
  const queued = before.pending + (retryFailed ? before.failed : 0);
  const willAttempt = Math.min(queued, batch);

  if (queued === 0) {
    return Response.json({
      error: REFUSAL_MESSAGE.nothing_pending,
      counts: before,
    }, { status: 409 });
  }

  const expect = Number(body?.expect_count);
  if (!Number.isFinite(expect) || expect !== willAttempt) {
    return Response.json({
      error: `Recipient count has changed. This send would message ${willAttempt} guest(s), not ${Number.isFinite(expect) ? expect : 'an unstated number'}. Nothing was sent — reload the campaign and confirm again.`,
      expected: willAttempt,
      counts: before,
    }, { status: 409 });
  }

  let venue = '';
  try {
    const outletId = await getCurrentOutletId();
    const row = db.prepare(`SELECT name FROM outlets WHERE id = ?`).get(outletId) as any;
    venue = String(row?.name || '').trim();
  } catch { venue = ''; }

  const result = await sendCampaign(db, id, { batch, venue, retryFailed });

  if (!result.ok && result.refused) {
    return Response.json({
      error: REFUSAL_MESSAGE[result.refused] || 'Send refused.',
      refused: result.refused,
      counts: countByStatus(db, id),
    }, { status: result.refused === 'not_found' ? 404 : 409 });
  }

  const report = campaignReport(db, id);
  return Response.json({
    success: true,
    ...result,
    meta: parseCampaignMeta(campaign.segment),
    counts: report?.counts ?? countByStatus(db, id),
    attribution: report?.attribution,
  });
}
