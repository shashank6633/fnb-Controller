/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement, requireRole } from '@/lib/auth';
import { setCtSetting } from '@/lib/ct/settings';
import { getWaConfig } from '@/lib/whatsapp';
import {
  winbackSegment, winbackEnabled, defaultLapsedDays, coerceBucket,
  WINBACK_BUCKETS, WINBACK_FLAG, CAMPAIGN_TARGET_MAX,
  type WinbackSort,
} from '@/lib/ct/winback';

/**
 * CRM — Win-back segment (/api/crm-calls/winback).
 *
 * GET  → the lapsed-guest segment for a bucket, plus everything the page needs
 *        to decide whether a campaign is even possible (the feature flag, the
 *        WhatsApp provider state, and the venue's WhatsApp templates).
 *        READ-ONLY. Nothing is sent, nothing is written.
 *
 *        ?days=30|60|90|120   (default: ct_settings.lapsed_days, snapped)
 *        ?include_never=1     also list guests with no proven visit ever
 *        ?sort=days|spend|visits|name|last_visit  &dir=asc|desc
 *        ?limit=<=2000
 *        ?format=csv          download the current segment
 *
 * PUT  → admin-only: { winback_enabled: '0'|'1', lapsed_days: 30|60|90|120 }.
 *        The flag lives here rather than in the shared CRM-settings route so
 *        the switch sits next to the feature it governs.
 *
 * Management-only (admin / manager / HOD) — the segment exposes guest spend.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SORTS: readonly WinbackSort[] = ['days', 'spend', 'visits', 'name', 'last_visit'];

const csvCell = (v: unknown) => {
  let s = String(v ?? '');
  // Neutralize spreadsheet formula injection (CWE-1236).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  const db = getDb();
  const sp = new URL(req.url).searchParams;

  const daysRaw = sp.get('days');
  const days = daysRaw ? coerceBucket(daysRaw) : defaultLapsedDays(db);
  const includeNever = sp.get('include_never') === '1';
  const sortRaw = (sp.get('sort') || 'days') as WinbackSort;
  const sort: WinbackSort = SORTS.includes(sortRaw) ? sortRaw : 'days';
  const dir = sp.get('dir') === 'asc' ? 'asc' : 'desc';
  const limit = Math.min(Math.max(Number(sp.get('limit')) || 500, 1), CAMPAIGN_TARGET_MAX);

  let outletId: string | null = null;
  try { outletId = await getCurrentOutletId(); } catch { outletId = null; }

  const segment = winbackSegment(db, { outletId, days, includeNever, sort, dir, limit });

  if (sp.get('format') === 'csv') {
    const head = ['Name', 'Phone', 'Last visit', 'Proof', 'Days since', 'Band', 'Visits', 'Total spend', 'Last items', 'Contactable'];
    const lines = [head.join(',')];
    for (const g of segment.guests) {
      lines.push([
        g.name, g.phone_e164, g.last_visit_at || '', g.last_visit_source || 'none',
        g.days_since ?? '', g.band, g.visits, g.total_spend,
        g.last_items.join(' | '), g.contactable ? 'yes' : 'no',
      ].map(csvCell).join(','));
    }
    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="winback-${days}d-${segment.today}.csv"`,
      },
    });
  }

  // Local template copies the operator can point a campaign at. The provider
  // (Meta/Interakt) is the real authority on what is APPROVED — these rows are
  // just the venue's record of the approved name/body/param order.
  let templates: any[] = [];
  try {
    templates = db.prepare(`
      SELECT name, category, language, body, provider_template_name, provider_language, param_order, send_as_template
      FROM whatsapp_templates WHERE is_active = 1 ORDER BY category, name
    `).all() as any[];
  } catch { templates = []; }

  const wa = getWaConfig();
  return Response.json({
    ...segment,
    buckets: WINBACK_BUCKETS,
    flag: { key: WINBACK_FLAG, enabled: winbackEnabled(db) },
    default_days: defaultLapsedDays(db),
    wa: { configured: wa.configured, provider: wa.wa_api_provider, notifications_enabled: wa.wa_notifications_enabled },
    templates,
    can_configure: me.role === 'admin',
  });
}

export async function PUT(req: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const db = getDb();
  const updated: string[] = [];

  if (WINBACK_FLAG in body) {
    const v = body[WINBACK_FLAG];
    const norm = v === true || v === 1 || v === '1' ? '1'
      : v === false || v === 0 || v === '0' ? '0' : null;
    if (norm === null) return Response.json({ error: `${WINBACK_FLAG} must be '0' or '1'` }, { status: 400 });
    setCtSetting(db, WINBACK_FLAG, norm);
    updated.push(WINBACK_FLAG);
  }

  if ('lapsed_days' in body) {
    const n = Number(body.lapsed_days);
    if (!(WINBACK_BUCKETS as readonly number[]).includes(n)) {
      return Response.json({ error: `lapsed_days must be one of ${WINBACK_BUCKETS.join(', ')}` }, { status: 400 });
    }
    setCtSetting(db, 'lapsed_days', String(n));
    updated.push('lapsed_days');
  }

  if (updated.length === 0) {
    return Response.json({ error: `Nothing to update. Editable: ${WINBACK_FLAG}, lapsed_days` }, { status: 400 });
  }

  return Response.json({
    success: true,
    updated,
    flag: { key: WINBACK_FLAG, enabled: winbackEnabled(db) },
    default_days: defaultLapsedDays(db),
  });
}
