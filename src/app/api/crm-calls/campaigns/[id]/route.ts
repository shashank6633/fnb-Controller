/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  campaignReport, attributeCampaign, winbackEnabled, previewMessage, targetVars,
  WINBACK_FLAG, type TargetRow,
} from '@/lib/ct/winback';
import { getWaConfig } from '@/lib/whatsapp';

/**
 * CRM — one win-back campaign (/api/crm-calls/campaigns/:id).
 *
 * GET → the campaign, its targets and its results.
 *
 *       Attribution is refreshed on read (?attribute=0 to skip). That is a
 *       WRITE on a GET, so to be explicit about what it does: it only ever
 *       stamps returned_at / return_value on rows that are already `sent` and
 *       not yet stamped. It sends NOTHING and it never un-stamps. Same
 *       pattern as sweep() on /api/crm-calls/recoveries.
 *
 * DELETE → discard a campaign that has never reached anybody (every target
 *       still 'pending'). A campaign with even one send is history and stays.
 *
 * Management-only.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  const { id } = await params;
  const db = getDb();
  const sp = new URL(req.url).searchParams;

  if (sp.get('attribute') !== '0') {
    try {
      const outletId = await getCurrentOutletId();
      attributeCampaign(db, id, { outletId });
    } catch (e) {
      console.warn('[ct winback] attribution refresh failed', e);
    }
  }

  const report = campaignReport(db, id);
  if (!report) return Response.json({ error: 'Campaign not found' }, { status: 404 });

  const targets = db.prepare(`
    SELECT * FROM ct_campaign_targets WHERE campaign_id = ?
    ORDER BY (returned_at IS NULL), send_status, created_at, id
    LIMIT 2000
  `).all(id) as TargetRow[];

  const first = targets[0];
  const wa = getWaConfig();
  return Response.json({
    ...report,
    targets,
    sample_preview: first
      ? previewMessage(report.meta, targetVars(first, report.meta, ''))
      : '',
    flag: { key: WINBACK_FLAG, enabled: winbackEnabled(db) },
    wa: { configured: wa.configured, provider: wa.wa_api_provider },
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  const { id } = await params;
  const db = getDb();
  const campaign = db.prepare(`SELECT id FROM ct_campaigns WHERE id = ?`).get(id) as any;
  if (!campaign) return Response.json({ error: 'Campaign not found' }, { status: 404 });

  const touched = db.prepare(`
    SELECT COUNT(*) AS n FROM ct_campaign_targets
    WHERE campaign_id = ? AND send_status <> 'pending'
  `).get(id) as any;
  if ((Number(touched?.n) || 0) > 0) {
    return Response.json({
      error: 'This campaign has already reached guests — it is kept as a record. Nothing further will be sent unless you press Send again.',
    }, { status: 409 });
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM ct_campaign_targets WHERE campaign_id = ?`).run(id);
    db.prepare(`DELETE FROM ct_campaigns WHERE id = ?`).run(id);
  });
  tx();
  return Response.json({ success: true, deleted: id });
}
