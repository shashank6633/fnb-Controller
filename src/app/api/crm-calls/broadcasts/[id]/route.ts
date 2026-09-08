/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import {
  getCampaign, campaignProgress, paramOrderOf, parseAudience, resolveAudience,
  BROADCAST_VARS, broadcastSettings,
} from '@/lib/wa-broadcast';

/**
 * /api/crm-calls/broadcasts/[id]
 *
 * GET    → campaign detail + live progress (state counts, unconfirmed claims,
 *          cost) + a fresh advisory preview of what a drain would do next.
 * PATCH  → edit a DRAFT only (name / template / language / params / preview
 *          body / throttle / audience — an audience change requeues the
 *          recipient list). A campaign that has started is immutable: the
 *          report must describe what was actually sent.
 * DELETE → delete a DRAFT only. Anything started is cancelled via the action
 *          route instead, so its recipient history survives.
 *
 * Management-only.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  const { id } = await params;
  const db = getDb();
  const c = getCampaign(db, id);
  if (!c) return Response.json({ error: 'Campaign not found' }, { status: 404 });

  const audience = (() => { try { return JSON.parse(c.audience || '{}'); } catch { return {}; } })();
  return Response.json({
    campaign: { ...c, param_order: paramOrderOf(c), audience },
    ...campaignProgress(db, c),
    settings: broadcastSettings(db),
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  const { id } = await params;
  const db = getDb();
  const c = getCampaign(db, id);
  if (!c) return Response.json({ error: 'Campaign not found' }, { status: 404 });
  if (c.state !== 'draft') {
    return Response.json({ error: `Only a draft can be edited — this campaign is '${c.state}'.` }, { status: 409 });
  }

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Body must be an object' }, { status: 400 });

  const sets: string[] = [];
  const args: any = { id };

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return Response.json({ error: 'Campaign name cannot be empty' }, { status: 400 });
    sets.push('name = @name'); args.name = name.slice(0, 200);
  }
  if (body.template_name !== undefined) {
    const t = String(body.template_name).trim();
    if (!/^[a-z0-9_]{1,512}$/.test(t)) {
      return Response.json({ error: 'Template name must be lowercase letters, digits and underscores' }, { status: 400 });
    }
    sets.push('template_name = @template'); args.template = t;
  }
  if (body.language !== undefined) {
    sets.push('language = @lang'); args.lang = String(body.language).trim() || 'en';
  }
  if (body.param_order !== undefined) {
    if (!Array.isArray(body.param_order)) return Response.json({ error: 'param_order must be an array' }, { status: 400 });
    const clean = body.param_order.map((v: unknown) => String(v).trim()).filter(Boolean);
    const bad = clean.find((v: string) => !(BROADCAST_VARS as readonly string[]).includes(v));
    if (bad) return Response.json({ error: `Unknown template variable '${bad}'. Available: ${BROADCAST_VARS.join(', ')}` }, { status: 400 });
    sets.push('param_order = @order'); args.order = JSON.stringify(clean);
  }
  if (body.preview_body !== undefined) {
    sets.push('preview_body = @preview'); args.preview = String(body.preview_body).slice(0, 2000);
  }
  if (body.throttle_per_min !== undefined) {
    sets.push('throttle_per_min = @throttle');
    args.throttle = Math.max(0, Math.min(Math.floor(Number(body.throttle_per_min) || 0), 240));
  }

  let requeued: number | null = null;
  const audience = body.audience !== undefined ? parseAudience(body.audience) : undefined;
  if (body.audience !== undefined && !audience) {
    return Response.json({ error: 'Invalid audience definition' }, { status: 400 });
  }

  const tx = db.transaction(() => {
    if (sets.length) {
      db.prepare(`UPDATE wa_campaigns SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id AND state = 'draft'`).run(args);
    }
    if (audience) {
      // Replace the queued list wholesale — a draft's recipients are just the
      // materialised audience, nothing has been sent yet by state-guard.
      db.prepare(`DELETE FROM wa_campaign_recipients WHERE campaign_id = ?`).run(id);
      const res = resolveAudience(db, audience);
      const ins = db.prepare(`
        INSERT OR IGNORE INTO wa_campaign_recipients (id, campaign_id, guest_id, phone_e164, phone_key, name, state)
        VALUES (?, ?, ?, ?, ?, ?, 'queued')
      `);
      let n = 0;
      for (const g of res.guests) {
        if (ins.run(generateId(), id, g.guest_id, g.phone_e164, g.phone_key, g.name).changes > 0) n++;
      }
      db.prepare(`UPDATE wa_campaigns SET audience = ?, updated_at = datetime('now') WHERE id = ? AND state = 'draft'`)
        .run(JSON.stringify({ ...audience, resolved: { total_candidates: res.total_candidates, no_phone: res.no_phone, deduped: res.deduped, queued: n } }), id);
      requeued = n;
    }
  });
  tx();

  const after = getCampaign(db, id)!;
  return Response.json({ success: true, campaign: after, requeued, ...campaignProgress(db, after) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  const { id } = await params;
  const db = getDb();
  const c = getCampaign(db, id);
  if (!c) return Response.json({ error: 'Campaign not found' }, { status: 404 });
  if (c.state !== 'draft') {
    return Response.json({
      error: `Only a draft can be deleted — this campaign is '${c.state}'. Cancel it instead; its send history must survive.`,
    }, { status: 409 });
  }
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM wa_campaign_recipients WHERE campaign_id = ?`).run(id);
    db.prepare(`DELETE FROM wa_campaigns WHERE id = ? AND state = 'draft'`).run(id);
  });
  tx();
  return Response.json({ success: true, deleted: id });
}
