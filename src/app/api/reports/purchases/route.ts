import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';

/**
 * Purchase Report API (management only). GET /api/reports/purchases?from=&to=&vendor=&category=
 *
 * Aggregates purchase SPEND (purchases.total_price = invoice amount) over a
 * YYYY-MM-DD date range, broken down by vendor, category, super-category, month,
 * payment mode, and item. Mirrors the Purchases page data set (JOIN raw_materials,
 * no outlet scoping) so the report totals reconcile with what /purchases shows.
 *
 * Returns JSON only; the page builds CSV client-side from these aggregates.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const isYmd = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

    const url = new URL(req.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!isYmd(from) || !isYmd(to)) {
      return Response.json({ error: 'from and to (YYYY-MM-DD) are required' }, { status: 400 });
    }
    if (from > to) return Response.json({ error: 'from must be on or before to' }, { status: 400 });
    const vendor = (url.searchParams.get('vendor') || '').trim();
    const category = (url.searchParams.get('category') || '').trim();

    const db = getDb();

    // Shared WHERE + params for every aggregate (date range + optional filters).
    const where: string[] = ['p.date >= ?', 'p.date <= ?'];
    const params: any[] = [from, to];
    if (vendor) { where.push('LOWER(p.vendor) = LOWER(?)'); params.push(vendor); }
    if (category) { where.push('LOWER(COALESCE(rm.category, \'\')) = LOWER(?)'); params.push(category); }
    const W = where.join(' AND ');
    const base = `FROM purchases p JOIN raw_materials rm ON p.material_id = rm.id WHERE ${W}`;

    const summary = db.prepare(`
      SELECT
        COUNT(*)                                        AS purchase_count,
        COALESCE(SUM(p.total_price), 0)                 AS total_spend,
        COUNT(DISTINCT p.vendor)                        AS vendor_count,
        COUNT(DISTINCT p.material_id)                   AS item_count,
        COUNT(DISTINCT p.date)                          AS day_count,
        COALESCE(SUM(CASE WHEN p.is_emergency = 1 THEN p.total_price ELSE 0 END), 0) AS emergency_spend,
        COALESCE(SUM(CASE WHEN p.is_emergency = 1 THEN 1 ELSE 0 END), 0)             AS emergency_count
      ${base}
    `).get(...params) as any;

    const by_vendor = db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(p.vendor), ''), '(no vendor)') AS vendor,
             COALESCE(SUM(p.total_price), 0) AS spend, COUNT(*) AS count
      ${base} GROUP BY LOWER(TRIM(p.vendor)) ORDER BY spend DESC
    `).all(...params) as any[];

    const by_category = db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(rm.category), ''), '(uncategorised)') AS category,
             COALESCE(SUM(p.total_price), 0) AS spend, COUNT(*) AS count
      ${base} GROUP BY LOWER(TRIM(rm.category)) ORDER BY spend DESC
    `).all(...params) as any[];

    const by_super_category = db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(rm.super_category), ''), '(none)') AS super_category,
             COALESCE(SUM(p.total_price), 0) AS spend, COUNT(*) AS count
      ${base} GROUP BY LOWER(TRIM(rm.super_category)) ORDER BY spend DESC
    `).all(...params) as any[];

    const by_month = db.prepare(`
      SELECT substr(p.date, 1, 7) AS month,
             COALESCE(SUM(p.total_price), 0) AS spend, COUNT(*) AS count
      ${base} GROUP BY substr(p.date, 1, 7) ORDER BY month ASC
    `).all(...params) as any[];

    const by_payment_mode = db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(p.payment_mode), ''), '(unspecified)') AS payment_mode,
             COALESCE(SUM(p.total_price), 0) AS spend, COUNT(*) AS count
      ${base} GROUP BY LOWER(TRIM(p.payment_mode)) ORDER BY spend DESC
    `).all(...params) as any[];

    // Item-wise report — EVERY item purchased in the range (grouped by material),
    // with weighted avg purchase rate (₹/purchase-unit) and last-purchased date.
    const by_item = db.prepare(`
      SELECT rm.name AS material_name,
             COALESCE(NULLIF(TRIM(rm.category), ''), '(uncategorised)') AS category,
             rm.purchase_unit AS unit,
             COALESCE(SUM(p.quantity), 0)    AS qty,
             COALESCE(SUM(p.total_price), 0) AS spend,
             COUNT(*)                        AS count,
             CASE WHEN SUM(p.quantity) > 0 THEN SUM(p.total_price) / SUM(p.quantity) ELSE 0 END AS avg_rate,
             MAX(p.date)                     AS last_date
      ${base} GROUP BY p.material_id ORDER BY spend DESC
    `).all(...params) as any[];

    // Filter dropdown options (all-time, so the pickers are stable across ranges).
    const vendors = (db.prepare(`
      SELECT DISTINCT TRIM(vendor) AS v FROM purchases WHERE TRIM(vendor) <> '' ORDER BY v COLLATE NOCASE
    `).all() as any[]).map(r => r.v);
    const categories = (db.prepare(`
      SELECT DISTINCT TRIM(category) AS c FROM raw_materials WHERE TRIM(category) <> '' ORDER BY c COLLATE NOCASE
    `).all() as any[]).map(r => r.c);

    return Response.json({
      from, to, vendor, category,
      summary, by_vendor, by_category, by_super_category, by_month, by_payment_mode, by_item,
      vendors, categories,
    });
  } catch (e: any) {
    console.error('[/api/reports/purchases]', e);
    return Response.json({ error: e?.message || 'Failed to build purchase report' }, { status: 500 });
  }
}
