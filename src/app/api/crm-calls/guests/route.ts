import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement } from '@/lib/auth';
import { normalizePhone } from '@/lib/ct/phone';
import { listMetricsForGuests } from '@/lib/ct/metrics';
import { norm10, buildLoyaltyMap, buildDiningMap, syntheticGuests } from '@/lib/ct/guest-unify';

/**
 * GET  /api/crm-calls/guests
 *   List guests with per-guest metrics (via listMetricsForGuests).
 *   Query params:
 *     search        — name / phone / alt phone / email LIKE
 *     badge         — status badge filter (e.g. repeat_guest, "REPEAT GUEST" — punctuation-insensitive)
 *     tag           — guests whose tags[] contain this tag (case-insensitive)
 *     converted     — 1/0 → guest has (not) ≥1 seated/completed booking (badge-derived)
 *     last_call_from / last_call_to — IST date range (YYYY-MM-DD) on last call
 *     sort          — name|last_call|total_calls|calls_30d|missed_calls|total_bookings|last_visit|conversion|created
 *     dir           — asc|desc (default: desc, except name → asc)
 *     page/pageSize — pagination (default 1 / 25, pageSize ≤ 200)
 *     format=csv    — stream the FULL filtered set as a CSV download (no pagination)
 *
 * POST /api/crm-calls/guests — create a guest.
 *   { phone (required), name?, alt_phone?, email?, tags?[], notes?, dob?, anniversary?, preferences?{}, source? }
 *   Phone is normalized to E.164; '' → 400; duplicate phone → 409 with existing guest id.
 *   After create, retro-links ct_calls.guest_id + ct_recoveries.guest_id for that phone.
 */
export const dynamic = 'force-dynamic';

// Shape per CRM_DECISIONS.md — guestMetrics/listMetricsForGuests (fleet-built lib).
interface GuestMetrics {
  total_calls: number;
  calls_30d: number;
  missed_calls: number;
  last_call_at: string | null;
  total_bookings: number;
  completed_visits: number;
  no_shows: number;
  last_visit_at: string | null;
  conversion_rate: number;
  badge: string;
}

const EMPTY_METRICS: GuestMetrics = {
  total_calls: 0, calls_30d: 0, missed_calls: 0, last_call_at: null,
  total_bookings: 0, completed_visits: 0, no_shows: 0, last_visit_at: null,
  conversion_rate: 0, badge: 'NEW CALLER',
};

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    const v = JSON.parse(text);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** 'ENQUIRED–NOT CONVERTED' / 'repeat guest' / 'repeat_guest' → canonical slug. */
function badgeSlug(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Badges that imply "converted" (≥1 seated/completed booking).
const CONVERTED_BADGES = new Set(['converted', 'repeat_guest', 'lapsed']);

/** UTC ISO → IST calendar date YYYY-MM-DD ('' when null/invalid). */
function istDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function istDisplay(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

const csvCell = (v: unknown) => {
  let s = String(v ?? '');
  // Neutralize spreadsheet formula injection (CWE-1236): a guest name/notes
  // value beginning with = + - @ TAB or CR would be evaluated as a formula
  // when the export is opened in Excel/Sheets. Prefix with a single quote so
  // it's treated as text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  // RFC-4180 quote (now also on CR so a stray \r can't break row structure).
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Tolerant accessor — works whether the metrics lib returns a Record or a Map. */
function metricsFor(bag: unknown, guestId: string): GuestMetrics {
  if (bag instanceof Map) return (bag.get(guestId) as GuestMetrics) || EMPTY_METRICS;
  if (bag && typeof bag === 'object') {
    return ((bag as Record<string, GuestMetrics>)[guestId]) || EMPTY_METRICS;
  }
  return EMPTY_METRICS;
}

type GuestRow = {
  id: string; outlet_id: string; phone_e164: string; name: string; alt_phone: string;
  email: string; tags: string; source: string; notes: string; dob: string;
  anniversary: string; preferences: string; created_at: string; updated_at: string;
};

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const db = getDb();
    const sp = new URL(request.url).searchParams;

    // ── SQL pre-filter: search only (metric filters are computed post-attach) ──
    const where: string[] = [];
    const params: unknown[] = [];
    const search = (sp.get('search') || '').trim();
    if (search) {
      const like = `%${search}%`;
      const digits = search.replace(/\D/g, '');
      // Phone columns match on the digit fragment so "98765 43210" finds +919876543210.
      const phoneLike = digits.length >= 4 ? `%${digits}%` : like;
      where.push('(g.name LIKE ? OR g.phone_e164 LIKE ? OR g.alt_phone LIKE ? OR g.email LIKE ?)');
      params.push(like, phoneLike, phoneLike, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT g.* FROM ct_guests g ${whereSql} ORDER BY g.created_at DESC`).all(...params) as GuestRow[];

    // ── Attach metrics (batch) ──
    let metricsBag: unknown = null;
    try {
      metricsBag = listMetricsForGuests(db, rows.map(r => r.id));
    } catch (e) {
      console.error('GET /api/crm-calls/guests: listMetricsForGuests failed, serving empty metrics:', e);
    }

    let guests: any[] = rows.map(r => ({
      ...r,
      tags: parseJson<string[]>(r.tags, []),
      preferences: parseJson<Record<string, unknown>>(r.preferences, {}),
      metrics: metricsFor(metricsBag, r.id),
    }));

    // ── Unify: one guest = one person across calls + loyalty + dining ──
    // Enrich every caller with their loyalty (crm_guests) + dining (orders)
    // rollup by last-10-digit phone, and append guests who exist ONLY in
    // loyalty/dining (never called) so the single list is exhaustive.
    const outletId = await getCurrentOutletId();
    // Loyalty (points/tier/spend + visit ledger) stays management-only, matching
    // the legacy /api/crm/guests gate — non-management users get dining only
    // (dining/customer spend is intentionally open, per /api/customers).
    const canLoyalty = isManagement(me);
    const loyaltyMap = canLoyalty ? buildLoyaltyMap(db) : new Map();
    const diningMap = buildDiningMap(db, outletId);
    const compactLoyalty = (k: string) => {
      const l = loyaltyMap.get(k);
      return l ? { points: l.points, tier: l.tier, visit_count: l.visit_count, total_spend: l.total_spend } : null;
    };
    const compactDining = (k: string) => {
      const d = diningMap.get(k);
      return {
        orders: d?.orders || 0, visits: d?.visits || 0,
        total_spent: d?.total_spent || 0, qr_orders: d?.qr_orders || 0,
        last_seen: d?.last_seen || null,
      };
    };
    const ctKeys = new Set<string>();
    for (const g of guests) {
      const k = norm10(g.phone_e164);
      if (k) ctKeys.add(k);
      g.loyalty = compactLoyalty(k);
      g.dining = compactDining(k);
      if (!String(g.name || '').trim()) {
        g.name = (loyaltyMap.get(k)?.name || diningMap.get(k)?.name || '').trim();
      }
    }
    // Synthetic (never-called) guests — apply the same text search in JS since
    // the SQL pre-filter above only saw ct_guests rows.
    const sDigits = search.replace(/\D/g, '');
    const matchesSearch = (name: string, phone: string) => {
      if (!search) return true;
      if (String(name || '').toLowerCase().includes(search.toLowerCase())) return true;
      // Match phone on ANY non-empty digit fragment — mirrors the SQL pre-filter
      // (which LIKEs the phone even for <4-digit queries) so synthetic guests
      // aren't under-included on a short numeric search.
      const ph = String(phone || '').replace(/\D/g, '');
      return sDigits.length >= 1 && ph.includes(sDigits);
    };
    const synth = syntheticGuests(ctKeys, loyaltyMap, diningMap)
      .filter(s => matchesSearch(s.name, s.phone_e164))
      .map(s => {
        const k = norm10(s.phone_e164);
        const din = diningMap.get(k);
        const loy = loyaltyMap.get(k);
        const repeat = (din?.visits || 0) >= 2 || (loy?.visit_count || 0) >= 2;
        return {
          ...s,
          preferences: {} as Record<string, unknown>,
          metrics: {
            ...EMPTY_METRICS,
            badge: repeat ? 'REPEAT GUEST' : 'DINE-IN GUEST',
            last_visit_at: din?.last_seen || loy?.last_visit_at || null,
          },
          loyalty: compactLoyalty(k),
          dining: compactDining(k),
        };
      });
    guests = guests.concat(synth);

    // ── Metric/tag filters ──
    const tag = (sp.get('tag') || '').trim().toLowerCase();
    if (tag) {
      guests = guests.filter(g => Array.isArray(g.tags) && g.tags.some((t: unknown) => String(t).toLowerCase() === tag));
    }
    const badge = badgeSlug(sp.get('badge') || '');
    if (badge) {
      guests = guests.filter(g => badgeSlug(g.metrics.badge) === badge);
    }
    const convertedRaw = sp.get('converted');
    if (convertedRaw != null && convertedRaw !== '') {
      const want = ['1', 'true', 'yes', 'y'].includes(convertedRaw.toLowerCase());
      guests = guests.filter(g => CONVERTED_BADGES.has(badgeSlug(g.metrics.badge)) === want);
    }
    const lastCallFrom = (sp.get('last_call_from') || '').slice(0, 10);
    const lastCallTo = (sp.get('last_call_to') || '').slice(0, 10);
    if (lastCallFrom) guests = guests.filter(g => { const d = istDate(g.metrics.last_call_at); return d !== '' && d >= lastCallFrom; });
    if (lastCallTo) guests = guests.filter(g => { const d = istDate(g.metrics.last_call_at); return d !== '' && d <= lastCallTo; });

    // ── Sort ──
    const sort = (sp.get('sort') || 'last_call').toLowerCase();
    const defaultDir = sort === 'name' ? 'asc' : 'desc';
    const dir = (sp.get('dir') || defaultDir).toLowerCase() === 'asc' ? 1 : -1;
    const keyOf = (g: any): string | number | null => {
      switch (sort) {
        case 'name': return (g.name || '').toLowerCase();
        case 'total_calls': return g.metrics.total_calls;
        case 'calls_30d': return g.metrics.calls_30d;
        case 'missed_calls': return g.metrics.missed_calls;
        case 'total_bookings': return g.metrics.total_bookings;
        case 'last_visit': return g.metrics.last_visit_at;
        case 'conversion': return g.metrics.conversion_rate;
        case 'created': return g.created_at;
        // Unified loyalty / dining sorts
        case 'points': return g.loyalty ? g.loyalty.points : null;
        case 'spend': return g.dining ? g.dining.total_spent : null;
        case 'dining_visits': return g.dining ? g.dining.visits : null;
        case 'last_visit_any': return g.dining?.last_seen || g.metrics.last_visit_at || null;
        case 'last_call':
        default: return g.metrics.last_call_at;
      }
    };
    guests.sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      // Nulls/empties always sink to the bottom regardless of direction.
      const emptyA = ka == null || ka === '';
      const emptyB = kb == null || kb === '';
      if (emptyA && emptyB) return 0;
      if (emptyA) return 1;
      if (emptyB) return -1;
      if (ka! < kb!) return -1 * dir;
      if (ka! > kb!) return 1 * dir;
      return 0;
    });

    // ── CSV export (full filtered set) ──
    if (sp.get('format') === 'csv') {
      const header = [
        'Name', 'Phone', 'Alt Phone', 'Email', 'Tags', 'Badge', 'Source',
        'Total Calls', 'Calls 30d', 'Missed Calls', 'Last Call (IST)',
        'Bookings', 'Completed Visits', 'No Shows', 'Last Visit (IST)',
        'Conversion %',
        'Loyalty Points', 'Loyalty Tier', 'Loyalty Visits', 'Loyalty Spend',
        'Dining Orders', 'Dining Visits', 'Dining Spend', 'QR Orders', 'Last Seen (IST)',
        'DOB', 'Anniversary', 'Notes', 'Created (IST)',
      ];
      const lines = [header.join(',')];
      for (const g of guests) {
        const m = g.metrics;
        const loy = g.loyalty;
        const din = g.dining || {};
        lines.push([
          g.name, g.phone_e164, g.alt_phone, g.email,
          Array.isArray(g.tags) ? g.tags.join('; ') : '',
          m.badge, g.source,
          m.total_calls, m.calls_30d, m.missed_calls, istDisplay(m.last_call_at),
          m.total_bookings, m.completed_visits, m.no_shows, istDisplay(m.last_visit_at),
          Math.round((Number(m.conversion_rate) || 0) * 100) / 100,
          loy ? Math.round(loy.points) : '', loy ? loy.tier : '',
          loy ? loy.visit_count : '', loy ? Math.round(loy.total_spend) : '',
          din.orders || 0, din.visits || 0, din.total_spent || 0, din.qr_orders || 0,
          istDisplay(din.last_seen || null),
          g.dob, g.anniversary, g.notes, istDisplay(g.created_at),
        ].map(csvCell).join(','));
      }
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      return new Response(lines.join('\n'), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="guests_export_${today}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // ── Pagination ──
    const total = guests.length;
    const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const start = (page - 1) * pageSize;
    const pageRows = guests.slice(start, start + pageSize);

    return Response.json(
      { guests: pageRows, total, page, pageSize },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('GET /api/crm-calls/guests failed:', e);
    return Response.json({ error: e?.message || 'Failed to load guests' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const phone = normalizePhone(body?.phone ?? body?.phone_e164);
    if (!phone) return Response.json({ error: 'A valid phone number is required' }, { status: 400 });

    if (body?.tags !== undefined && !Array.isArray(body.tags)) {
      return Response.json({ error: 'tags must be an array' }, { status: 400 });
    }
    if (body?.preferences !== undefined && (typeof body.preferences !== 'object' || body.preferences === null || Array.isArray(body.preferences))) {
      return Response.json({ error: 'preferences must be an object' }, { status: 400 });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM ct_guests WHERE phone_e164 = ?').get(phone) as { id: string } | undefined;
    if (existing) {
      return Response.json(
        { error: 'A guest with this phone number already exists', existing_guest_id: existing.id },
        { status: 409 },
      );
    }

    const id = generateId();
    const now = new Date().toISOString();
    const altPhoneRaw = String(body?.alt_phone ?? '').trim();
    const altPhone = altPhoneRaw ? (normalizePhone(altPhoneRaw) || altPhoneRaw) : '';
    try {
      db.prepare(`
        INSERT INTO ct_guests (id, outlet_id, phone_e164, name, alt_phone, email, tags, source, notes, dob, anniversary, preferences, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, String(body?.outlet_id ?? ''), phone,
        String(body?.name ?? '').trim(),
        altPhone,
        String(body?.email ?? '').trim(),
        JSON.stringify(Array.isArray(body?.tags) ? body.tags.map((t: unknown) => String(t)) : []),
        String(body?.source ?? 'call') || 'call',
        String(body?.notes ?? ''),
        String(body?.dob ?? ''),
        String(body?.anniversary ?? ''),
        JSON.stringify(body?.preferences && typeof body.preferences === 'object' ? body.preferences : {}),
        now, now,
      );
    } catch (e: any) {
      // Race on the UNIQUE(phone_e164) constraint → treat as duplicate.
      if (String(e?.message || '').includes('UNIQUE')) {
        const dup = db.prepare('SELECT id FROM ct_guests WHERE phone_e164 = ?').get(phone) as { id: string } | undefined;
        return Response.json(
          { error: 'A guest with this phone number already exists', existing_guest_id: dup?.id ?? null },
          { status: 409 },
        );
      }
      throw e;
    }

    // Retro-link earlier calls + recoveries from this number to the new guest.
    const linkedCalls = db.prepare(
      `UPDATE ct_calls SET guest_id = ? WHERE phone_e164 = ? AND (guest_id IS NULL OR guest_id = '')`,
    ).run(id, phone).changes;
    const linkedRecoveries = db.prepare(
      `UPDATE ct_recoveries SET guest_id = ?, updated_at = ? WHERE phone_e164 = ? AND (guest_id IS NULL OR guest_id = '')`,
    ).run(id, now, phone).changes;

    const row = db.prepare('SELECT * FROM ct_guests WHERE id = ?').get(id) as GuestRow;
    return Response.json(
      {
        success: true,
        guest: {
          ...row,
          tags: parseJson<string[]>(row.tags, []),
          preferences: parseJson<Record<string, unknown>>(row.preferences, {}),
        },
        linked: { calls: linkedCalls, recoveries: linkedRecoveries },
      },
      { status: 201 },
    );
  } catch (e: any) {
    console.error('POST /api/crm-calls/guests failed:', e);
    return Response.json({ error: e?.message || 'Failed to create guest' }, { status: 500 });
  }
}
