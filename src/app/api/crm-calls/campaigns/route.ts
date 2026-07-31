/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  createCampaign, parseCampaignMeta, countByStatus, winbackSegment,
  coerceBucket, defaultLapsedDays, winbackEnabled, previewMessage, targetVars,
  DEFAULT_ATTRIBUTION_DAYS, CAMPAIGN_TARGET_MAX, WINBACK_FLAG,
} from '@/lib/ct/winback';

/**
 * CRM — Win-back campaigns (/api/crm-calls/campaigns).
 *
 * GET  → every campaign with its send + attribution roll-up.
 * POST → create a DRAFT campaign from the win-back segment. Writes
 *        ct_campaigns + one ct_campaign_targets row per reachable guest and
 *        STOPS. It sends nothing — sending is a separate, explicit POST to
 *        /api/crm-calls/campaigns/:id/send.
 *
 *        Body:
 *          name              campaign name
 *          days              bucket the list came from (30|60|90|120)
 *          include_never     whether never-visited guests were included
 *          guest_ids[]       optional explicit selection; omit for "the whole
 *                            bucket as the server recomputes it"
 *          provider_template APPROVED Meta/Interakt template name (required)
 *          language          template language code (default 'en')
 *          param_order[]     which vars fill {{1}},{{2}},… (default ['name'])
 *          preview_body      local copy of the approved body, preview only
 *          attribution_days  return window (default 30)
 *
 * Management-only. Creating a draft is deliberately allowed even when the
 * win-back flag is OFF — you can build and review a list without being able
 * to send it. The flag is enforced at the send door.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const KNOWN_VARS = ['name', 'days', 'venue', 'phone'];

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  const db = getDb();
  let rows: any[] = [];
  try {
    rows = db.prepare(`SELECT * FROM ct_campaigns ORDER BY created_at DESC LIMIT 200`).all() as any[];
  } catch { rows = []; }

  const campaigns = rows.map(c => {
    const counts = countByStatus(db, c.id);
    const agg = db.prepare(`
      SELECT COUNT(*)                                              AS returned,
             SUM(COALESCE(return_value, 0))                        AS value,
             SUM(CASE WHEN return_value IS NULL THEN 1 ELSE 0 END) AS novalue
      FROM ct_campaign_targets WHERE campaign_id = ? AND returned_at IS NOT NULL
    `).get(c.id) as any;
    const returned = Number(agg?.returned) || 0;
    return {
      ...c,
      meta: parseCampaignMeta(c.segment),
      counts,
      attribution: {
        returned,
        return_value: Math.round(Number(agg?.value) || 0),
        returned_without_value: Number(agg?.novalue) || 0,
        return_rate: counts.sent > 0 ? Math.round((returned / counts.sent) * 1000) / 10 : 0,
      },
    };
  });

  return Response.json({
    campaigns,
    flag: { key: WINBACK_FLAG, enabled: winbackEnabled(db) },
  });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const name = String(body.name ?? '').trim();
  if (!name) return Response.json({ error: 'Campaign name is required' }, { status: 400 });

  const providerTemplate = String(body.provider_template ?? '').trim();
  if (!providerTemplate) {
    return Response.json({
      error: 'An approved WhatsApp template name is required. A win-back message is MARKETING — Meta will only deliver it from a template your venue has had approved.',
    }, { status: 400 });
  }
  if (!/^[a-z0-9_]{1,512}$/.test(providerTemplate)) {
    return Response.json({ error: 'Template name must be lowercase letters, digits and underscores (Meta naming rules)' }, { status: 400 });
  }

  const language = String(body.language ?? 'en').trim() || 'en';
  const attributionDays = Number(body.attribution_days) > 0
    ? Math.min(Math.floor(Number(body.attribution_days)), 365)
    : DEFAULT_ATTRIBUTION_DAYS;

  let paramOrder: string[] = ['name'];
  if (Array.isArray(body.param_order)) {
    const clean = body.param_order.map((v: unknown) => String(v).trim()).filter(Boolean);
    const bad = clean.find((v: string) => !KNOWN_VARS.includes(v));
    if (bad) return Response.json({ error: `Unknown template variable '${bad}'. Available: ${KNOWN_VARS.join(', ')}` }, { status: 400 });
    paramOrder = clean;   // [] is legal — a template with no placeholders
  }

  const db = getDb();
  let outletId: string | null = null;
  try { outletId = await getCurrentOutletId(); } catch { outletId = null; }

  const days = coerceBucket(body.days ?? defaultLapsedDays(db));
  const includeNever = body.include_never === true || body.include_never === '1';

  // Recompute the segment server-side — the client may only NARROW it via
  // guest_ids. A phone that isn't in the current segment can never be
  // smuggled into a campaign through this route.
  const segment = winbackSegment(db, { outletId, days, includeNever, limit: CAMPAIGN_TARGET_MAX });

  let chosen = segment.guests;
  if (Array.isArray(body.guest_ids)) {
    const wanted = new Set(body.guest_ids.map((v: unknown) => String(v)));
    chosen = segment.guests.filter(g => wanted.has(g.guest_id));
    if (chosen.length === 0) {
      return Response.json({ error: 'None of the selected guests are still in this segment. Reload the list and try again.' }, { status: 400 });
    }
  }
  if (chosen.length === 0) {
    return Response.json({ error: 'This segment is empty — there is nobody to message.' }, { status: 400 });
  }

  const result = createCampaign(db, {
    name,
    createdBy: me.email || me.name || me.id,
    guests: chosen.map(g => ({ guest_id: g.guest_id, phone_e164: g.phone_e164, name: g.name })),
    meta: {
      bucket_days: days,
      include_never: includeNever,
      cutoff_date: segment.cutoff_date,
      created_from: 'winback',
      provider_template: providerTemplate,
      language,
      param_order: paramOrder,
      preview_body: String(body.preview_body ?? '').slice(0, 2000),
      attribution_days: attributionDays,
    },
  });

  const meta = parseCampaignMeta(result.campaign.segment);
  const first = chosen[0];
  return Response.json({
    success: true,
    campaign: result.campaign,
    meta,
    counts: countByStatus(db, result.campaign.id),
    targets: result.targets,
    skipped_no_phone: result.skipped_no_phone,
    deduped: result.deduped,
    // What the FIRST recipient would see — the same preview the UI showed
    // before the draft was created, recomputed from what was actually stored.
    sample_preview: previewMessage(meta, targetVars({ name: first.name, phone_e164: first.phone_e164 }, meta, '')),
    note: 'Draft created. Nothing has been sent — use the Send action on the campaign to message these guests.',
  }, { status: 201 });
}
