/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { startSchedulerOnce } from '@/lib/scheduler';
import {
  getCampaign, startBroadcast, pauseBroadcast, resumeBroadcast, cancelBroadcast,
  campaignProgress, broadcastSettings, previewAudience, parseAudience,
  BROADCAST_FLAG,
} from '@/lib/wa-broadcast';
import { isWaConfigured } from '@/lib/whatsapp';

/**
 * POST /api/crm-calls/broadcasts/[id]/action — the ONLY door that moves a
 * campaign's state. Body: { action: 'start'|'pause'|'resume'|'cancel', … }
 *
 * START carries the win-back double-lock, adapted for a queue:
 *   • `confirm: true` — a bare POST does nothing.
 *   • `expect_count` must equal the queued-recipient count RIGHT NOW. If the
 *     list moved under the operator, refuse with the real number (409).
 * Starting does NOT send: it flips the state to 'sending' and captures the
 * cost rate + estimate. The scheduler-driven drain then delivers, throttled,
 * re-checking consent/cooldown/daily-cap per recipient. The response is
 * explicit about the two gates that could still hold everything (master flag
 * OFF / provider unconfigured) so an operator is never left staring at a
 * silent queue.
 *
 * PAUSE/CANCEL take effect within ONE message — the drain re-reads the state
 * before every send. Management-only.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Same driver-arming as the list route: any management touch on a campaign
// must be enough to get the queue draining after a server restart.
startSchedulerOnce();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  const { id } = await params;
  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body?.action || '').trim();

  const db = getDb();
  const c = getCampaign(db, id);
  if (!c) return Response.json({ error: 'Campaign not found' }, { status: 404 });

  if (action === 'start') {
    if (body?.confirm !== true) {
      return Response.json({
        error: 'Refusing to start without an explicit confirmation. Re-send with { confirm: true } after showing the operator the recipient count, the message preview and the cost estimate.',
      }, { status: 400 });
    }
    const queued = Number((db.prepare(
      `SELECT COUNT(*) AS n FROM wa_campaign_recipients WHERE campaign_id = ? AND state = 'queued'`,
    ).get(id) as any)?.n) || 0;
    const expect = Number(body?.expect_count);
    if (!Number.isFinite(expect) || expect !== queued) {
      return Response.json({
        error: `Recipient count has changed. Starting now would queue ${queued} guest(s) for sending, not ${Number.isFinite(expect) ? expect : 'an unstated number'}. Nothing was started — reload the campaign and confirm again.`,
        expected: queued,
      }, { status: 409 });
    }

    const res = startBroadcast(db, id);
    if (!res.ok) {
      const msg: Record<string, string> = {
        bad_state: `Only a draft can be started — this campaign is '${c.state}'.`,
        no_template: 'This campaign has no approved WhatsApp template name, so there is nothing Meta would deliver.',
        nothing_queued: 'This campaign has no queued recipients.',
        not_found: 'Campaign not found.',
      };
      return Response.json({ error: msg[res.error || ''] || 'Cannot start.', campaign: res.campaign }, { status: 409 });
    }

    // Started ≠ sending yet — say exactly what still gates delivery.
    const s = broadcastSettings(db);
    const warnings: string[] = [];
    if (!s.enabled) warnings.push(`Broadcast sending is switched OFF (ct_settings.${BROADCAST_FLAG}). The queue will not move until an admin enables it in Broadcast Settings.`);
    if (!isWaConfigured()) warnings.push('WhatsApp is not configured — no provider credentials. The queue will not move until Settings → Integrations → WhatsApp is completed.');

    return Response.json({
      success: true,
      campaign: res.campaign,
      ...campaignProgress(db, res.campaign!),
      warnings,
      note: `Campaign started. The queue drains at ~${s.msgs_per_min}/min with a ${s.cooldown_days}-day per-guest cooldown${s.daily_cap > 0 ? ` and a ${s.daily_cap}/day cap` : ''}; consent is re-checked on every message.`,
    });
  }

  if (action === 'pause' || action === 'resume' || action === 'cancel') {
    const fn = action === 'pause' ? pauseBroadcast : action === 'resume' ? resumeBroadcast : cancelBroadcast;
    const res = fn(db, id);
    if (!res.ok) {
      return Response.json({
        error: res.error === 'bad_state'
          ? `Cannot ${action} a campaign in state '${c.state}'.`
          : 'Campaign not found.',
        campaign: res.campaign,
      }, { status: res.error === 'not_found' ? 404 : 409 });
    }
    return Response.json({ success: true, campaign: res.campaign, ...campaignProgress(db, res.campaign!) });
  }

  if (action === 'preview') {
    // Convenience: re-preview THIS campaign's stored audience definition.
    const def = parseAudience(c.audience);
    if (!def) return Response.json({ error: 'Stored audience definition is unreadable' }, { status: 400 });
    return Response.json({ audience: def, preview: previewAudience(db, def) });
  }

  return Response.json({ error: "action must be 'start' | 'pause' | 'resume' | 'cancel' | 'preview'" }, { status: 400 });
}
