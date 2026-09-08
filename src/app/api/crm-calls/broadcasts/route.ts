/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { startSchedulerOnce } from '@/lib/scheduler';
import { isWaConfigured } from '@/lib/whatsapp';
import {
  createBroadcast, parseAudience, campaignProgress, broadcastSettings,
  paramOrderOf, BROADCAST_VARS, BROADCAST_FLAG,
} from '@/lib/wa-broadcast';

/**
 * CRM — WhatsApp broadcast campaigns (/api/crm-calls/broadcasts).
 *
 * GET  → every campaign with progress + cost roll-up.
 * POST → create a DRAFT + queue its recipients. Sends NOTHING — starting is a
 *        separate explicit POST to /api/crm-calls/broadcasts/:id/action, and
 *        actual delivery happens from the scheduler-driven drain, throttled,
 *        with consent/cooldown/daily-cap enforced per recipient at send time.
 *
 * Management-only (admin / manager / HOD), the win-back gate. Creating a draft
 * is allowed while the broadcast flag is OFF — build and review a list without
 * being able to send it; the flag is enforced inside the drain.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Arm the in-process drain driver: the scheduler otherwise starts only on the
// first /api/upcoming-parties request, so a management visit to the campaign
// screen must be enough to get a queued campaign draining after a restart.
// Idempotent (globalThis guard) — same one-liner as upcoming-parties/route.ts.
startSchedulerOnce();

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  const db = getDb();
  let rows: any[] = [];
  try {
    rows = db.prepare(`SELECT * FROM wa_campaigns ORDER BY created_at DESC LIMIT 200`).all() as any[];
  } catch { rows = []; }

  // The venue's stored template bodies — the wizard's picker (win-back's
  // embedding pattern, so a manager never needs the admin-only /api/whatsapp
  // routes). MARKETING templates are what Meta actually delivers a broadcast
  // from; the rest are listed after them for reference.
  let templates: any[] = [];
  try {
    templates = db.prepare(`
      SELECT id, name, category, language, body, provider_template_name, provider_language,
             param_order, send_as_template
      FROM whatsapp_templates WHERE is_active = 1
      ORDER BY CASE WHEN category = 'marketing' THEN 0 ELSE 1 END, name
    `).all() as any[];
  } catch { templates = []; }

  let venue = '';
  try { venue = String((db.prepare(`SELECT name FROM outlets ORDER BY id LIMIT 1`).get() as any)?.name || '').trim(); }
  catch { venue = ''; }

  const s = broadcastSettings(db);
  return Response.json({
    campaigns: rows.map(c => ({
      ...c,
      param_order: paramOrderOf(c),
      audience: (() => { try { return JSON.parse(c.audience || '{}'); } catch { return {}; } })(),
      ...campaignProgress(db, c),
    })),
    flag: { key: BROADCAST_FLAG, enabled: s.enabled },
    settings: s,
    templates,
    venue,
    wa: { configured: isWaConfigured() },
    can_configure: me.role === 'admin',
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

  const templateName = String(body.template_name ?? '').trim();
  if (!templateName) {
    return Response.json({
      error: 'An approved WhatsApp template name is required. A broadcast is MARKETING — Meta only delivers it from a template your venue has had approved (MARKETING category).',
    }, { status: 400 });
  }
  if (!/^[a-z0-9_]{1,512}$/.test(templateName)) {
    return Response.json({ error: 'Template name must be lowercase letters, digits and underscores (Meta naming rules)' }, { status: 400 });
  }

  const audience = parseAudience(body.audience);
  if (!audience) {
    return Response.json({
      error: "audience must be one of: {kind:'all_guests'} | {kind:'winback', days} | {kind:'min_visits', visits} | {kind:'birthday_month', month} | {kind:'tier', tier} | {kind:'phones', phones:[…]}",
    }, { status: 400 });
  }

  let paramOrder: string[] = [];
  if (Array.isArray(body.param_order)) {
    const clean = body.param_order.map((v: unknown) => String(v).trim()).filter(Boolean);
    const bad = clean.find((v: string) => !(BROADCAST_VARS as readonly string[]).includes(v));
    if (bad) return Response.json({ error: `Unknown template variable '${bad}'. Available: ${BROADCAST_VARS.join(', ')}` }, { status: 400 });
    paramOrder = clean;   // [] is legal — a template with no placeholders
  }

  const db = getDb();
  const result = createBroadcast(db, {
    name,
    templateName,
    language: String(body.language ?? 'en').trim() || 'en',
    paramOrder,
    previewBody: String(body.preview_body ?? '').slice(0, 2000),
    audience,
    throttlePerMin: Number(body.throttle_per_min) || 0,
    createdBy: me.email || me.name || me.id,
  });

  if (result.queued === 0) {
    return Response.json({ error: 'This audience resolves to nobody with a usable WhatsApp number.', ...result }, { status: 400 });
  }

  return Response.json({
    success: true,
    campaign: result.campaign,
    queued: result.queued,
    no_phone: result.no_phone,
    deduped: result.deduped,
    note: 'Draft created. Nothing has been sent — start the campaign explicitly, and the throttled queue (with consent, cooldown and the daily cap enforced per message) does the rest.',
  }, { status: 201 });
}
