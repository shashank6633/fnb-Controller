/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { getCampaign, recipientCounts } from '@/lib/wa-broadcast';

/**
 * GET /api/crm-calls/broadcasts/[id]/recipients — the per-recipient report.
 *
 * Every row with its state (queued / sending / sent / delivered / read /
 * replied / failed / capped / skipped_optout / skipped_cooldown / cancelled),
 * wamid, timestamps and error detail — the honest ledger of what actually
 * happened to each guest, fed by the send loop AND the status webhook.
 *
 * ?state=<state> filters; ?limit / ?offset page (default 500, max 1000).
 * Management-only.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const STATES = new Set([
  'queued', 'sending', 'sent', 'delivered', 'read', 'replied',
  'failed', 'capped', 'skipped_optout', 'skipped_cooldown', 'cancelled',
]);

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  const { id } = await params;
  const db = getDb();
  const c = getCampaign(db, id);
  if (!c) return Response.json({ error: 'Campaign not found' }, { status: 404 });

  const url = new URL(req.url);
  const state = String(url.searchParams.get('state') || '').trim();
  if (state && !STATES.has(state)) {
    return Response.json({ error: `Unknown state '${state}'` }, { status: 400 });
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 500, 1), 1000);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  const rows = db.prepare(`
    SELECT id, guest_id, phone_e164, phone_key, name, state, wamid, error_detail,
           queued_at, sent_at, delivered_at, read_at, replied_at, failed_at
    FROM wa_campaign_recipients
    WHERE campaign_id = @camp ${state ? 'AND state = @state' : ''}
    ORDER BY queued_at, id
    LIMIT @limit OFFSET @offset
  `).all({ camp: id, state, limit, offset }) as any[];

  return Response.json({
    campaign_id: id,
    counts: recipientCounts(db, id),
    recipients: rows,
    has_more: rows.length === limit,
  });
}
