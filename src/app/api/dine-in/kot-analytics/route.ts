import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

/**
 * KOT Data Points — operational analytics derived from fired KOTs.
 *
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD  (IST dates; default = today).
 *
 * All timestamps are stored UTC (datetime('now')); the restaurant runs on IST,
 * so every date/hour bucket converts with '+5 hours','30 minutes'. Sections:
 *   - byStation / byHour  → Kitchen load
 *   - byCaptain           → Captain activity (grouped by who PUNCHED the KOT)
 *   - prep                → Prep speed (fire → ready), reprinted tickets excluded
 *   - reprints / voids    → Reprints & voids (process/printer health)
 */
const IST = "'+5 hours','30 minutes'"; // SQLite datetime modifiers for IST

export async function GET(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outlet = await getCurrentOutletId();

    const url = new URL(req.url);
    const today = (db.prepare(`SELECT date('now',${IST}) d`).get() as any).d as string;
    const from = url.searchParams.get('from') || today;
    const to = url.searchParams.get('to') || from;
    const p = { outlet, from, to };

    // Common KOT filter: this outlet, fired within the IST date range.
    const W = `(k.outlet_id = :outlet OR k.outlet_id IS NULL)
               AND date(k.created_at,${IST}) BETWEEN :from AND :to`;

    const totalsKots = db.prepare(`
      SELECT COUNT(*) kots, COALESCE(SUM(reprint_count),0) reprints
      FROM kots k WHERE ${W}`).get(p) as any;

    const totalsItems = db.prepare(`
      SELECT COALESCE(SUM(oi.quantity),0) items, COALESCE(SUM(oi.line_total),0) sales
      FROM kots k JOIN order_items oi ON oi.kot_id = k.id WHERE ${W}`).get(p) as any;

    // Kitchen load — by station
    const byStation = db.prepare(`
      SELECT k.station station,
             COUNT(DISTINCT k.id) kots,
             COALESCE(SUM(oi.quantity),0) items,
             COALESCE(SUM(oi.line_total),0) sales
      FROM kots k LEFT JOIN order_items oi ON oi.kot_id = k.id
      WHERE ${W} GROUP BY k.station ORDER BY kots DESC`).all(p);

    // Kitchen load — by hour (IST)
    const byHour = db.prepare(`
      SELECT CAST(strftime('%H', k.created_at,${IST}) AS INTEGER) hour,
             COUNT(DISTINCT k.id) kots,
             COALESCE(SUM(oi.quantity),0) items
      FROM kots k LEFT JOIN order_items oi ON oi.kot_id = k.id
      WHERE ${W} GROUP BY hour ORDER BY hour`).all(p);

    // Captain activity — grouped by who fired the KOT
    const byCaptain = db.prepare(`
      SELECT CASE WHEN k.fired_by IS NULL OR k.fired_by = '' THEN '—' ELSE k.fired_by END captain,
             COUNT(DISTINCT k.id) kots,
             COALESCE(SUM(oi.quantity),0) items,
             COALESCE(SUM(oi.line_total),0) sales
      FROM kots k LEFT JOIN order_items oi ON oi.kot_id = k.id
      WHERE ${W} GROUP BY captain ORDER BY sales DESC`).all(p);

    // Prep speed — fire → ready, in minutes. Exclude reprinted KOTs (a reprint
    // bumps updated_at, which would inflate the elapsed time).
    const prep = db.prepare(`
      SELECT k.station station,
             ROUND(AVG((julianday(k.updated_at) - julianday(k.created_at)) * 24 * 60), 1) avgMin,
             COUNT(*) n
      FROM kots k
      WHERE ${W} AND k.status IN ('ready','served')
            AND COALESCE(k.reprint_count,0) = 0
            AND k.updated_at > k.created_at
      GROUP BY k.station ORDER BY avgMin DESC`).all(p);

    // Reprints — process/printer health
    const reprints = db.prepare(`
      SELECT COALESCE(SUM(reprint_count),0) totalReprints,
             SUM(CASE WHEN reprint_count > 0 THEN 1 ELSE 0 END) kotsReprinted
      FROM kots k WHERE ${W}`).get(p) as any;

    const topReprinted = db.prepare(`
      SELECT k.kot_number kotNumber, k.station station, k.reprint_count reprints,
             o.order_number orderRef
      FROM kots k LEFT JOIN orders o ON o.id = k.order_id
      WHERE ${W} AND k.reprint_count > 0
      ORDER BY k.reprint_count DESC, k.created_at DESC LIMIT 8`).all(p);

    // Voids — orders voided within the range (by void time, IST)
    const voids = db.prepare(`
      SELECT COUNT(*) count, COALESCE(SUM(total),0) value
      FROM orders o
      WHERE (o.outlet_id = :outlet OR o.outlet_id IS NULL) AND o.status = 'void'
            AND o.voided_at IS NOT NULL
            AND date(o.voided_at,${IST}) BETWEEN :from AND :to`).get(p) as any;

    return Response.json({
      range: { from, to, isToday: from === today && to === today },
      totals: {
        kots: totalsKots.kots || 0,
        items: totalsItems.items || 0,
        sales: totalsItems.sales || 0,
        reprints: totalsKots.reprints || 0,
        voids: voids.count || 0,
      },
      byStation, byHour, byCaptain, prep,
      reprints: {
        totalReprints: reprints.totalReprints || 0,
        kotsReprinted: reprints.kotsReprinted || 0,
        topReprinted,
      },
      voids: { count: voids.count || 0, value: voids.value || 0 },
    });
  } catch (e: any) {
    console.error('[/api/dine-in/kot-analytics GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
