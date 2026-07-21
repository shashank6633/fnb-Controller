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

    // ── Item Journey — how long each ordered item takes across its lifecycle ──
    // Every order_items row now carries four stamps: created_at (captain punched),
    // fired_at (KOT fired to kitchen), kitchen_sent_at (kitchen scanned the item's
    // sticker out), completed_at (captain marked it received at the table). Legs:
    //   PREP           = fired_at        → kitchen_sent_at
    //   KITCHEN→TABLE  = kitchen_sent_at → completed_at
    //   TOTAL          = created_at      → completed_at
    // Each leg is averaged only over rows where BOTH its endpoints are non-null,
    // so a missing kitchen scan-out never poisons the prep/total averages.
    const secs = (a: string, b: string) => `(julianday(${a}) - julianday(${b})) * 86400`;
    const dur  = (later: string, earlier: string) =>
      `CASE WHEN ${later} IS NOT NULL AND ${earlier} IS NOT NULL THEN ${secs(later, earlier)} END`;
    const prepD = dur('oi.kitchen_sent_at', 'oi.fired_at');
    const k2tD  = dur('oi.completed_at', 'oi.kitchen_sent_at');
    const totD  = dur('oi.completed_at', 'oi.created_at');
    const round = (v: any) => (v == null ? null : Math.round(Number(v)));

    // Items punched within the IST range, this outlet, on non-void orders.
    const WJ = `(o.outlet_id = :outlet OR o.outlet_id IS NULL)
                AND o.status != 'void'
                AND date(oi.created_at,${IST}) BETWEEN :from AND :to`;

    // (a) Summary grouped by station (KOT station, falling back to item snapshot).
    // COUNT(<leg>) counts only rows where that leg's CASE resolved non-null.
    const journeyByStation = (db.prepare(`
      SELECT COALESCE(NULLIF(k.station,''), NULLIF(oi.station,''), '—') station,
             COUNT(*)       items,
             AVG(${prepD})  prep_avg, MIN(${prepD})  prep_min, MAX(${prepD})  prep_max, COUNT(${prepD})  prep_n,
             AVG(${k2tD})   k2t_avg,  MIN(${k2tD})   k2t_min,  MAX(${k2tD})   k2t_max,  COUNT(${k2tD})   k2t_n,
             AVG(${totD})   total_avg, MIN(${totD})  total_min, MAX(${totD})  total_max, COUNT(${totD})  total_n
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN kots k ON k.id = oi.kot_id
      WHERE ${WJ}
      GROUP BY station
      ORDER BY items DESC`).all(p) as any[]).map((s) => ({
        station: s.station,
        items: s.items,
        prep_avg: round(s.prep_avg), prep_min: round(s.prep_min), prep_max: round(s.prep_max), prep_n: s.prep_n,
        k2t_avg: round(s.k2t_avg),   k2t_min: round(s.k2t_min),   k2t_max: round(s.k2t_max),   k2t_n: s.k2t_n,
        total_avg: round(s.total_avg), total_min: round(s.total_min), total_max: round(s.total_max), total_n: s.total_n,
      }));

    // Overall roll-up across every item in the range.
    const journeyOverall = db.prepare(`
      SELECT COUNT(*) items,
             SUM(CASE WHEN oi.completed_at IS NOT NULL THEN 1 ELSE 0 END) completed,
             AVG(${prepD}) prep_avg, COUNT(${prepD}) prep_n,
             AVG(${k2tD})  k2t_avg,  COUNT(${k2tD})  k2t_n,
             AVG(${totD})  total_avg, COUNT(${totD}) total_n
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE ${WJ}`).get(p) as any;

    // (b) Slowest individual completed items, by total journey time.
    const journeySlowest = (db.prepare(`
      SELECT oi.name name,
             COALESCE(NULLIF(rt.table_number,''), 'Order #' || o.order_number) tableLabel,
             oi.created_at, oi.fired_at, oi.kitchen_sent_at, oi.completed_at,
             ${prepD} prep_secs, ${k2tD} k2t_secs, ${totD} total_secs
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
      WHERE ${WJ} AND oi.completed_at IS NOT NULL
      ORDER BY total_secs DESC
      LIMIT 12`).all(p) as any[]).map((r) => ({
        name: r.name,
        table: r.tableLabel,
        created_at: r.created_at, fired_at: r.fired_at,
        kitchen_sent_at: r.kitchen_sent_at, completed_at: r.completed_at,
        prep_secs: round(r.prep_secs), k2t_secs: round(r.k2t_secs), total_secs: round(r.total_secs),
      }));

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
      item_journey: {
        overall: {
          items: journeyOverall?.items || 0,
          completed: journeyOverall?.completed || 0,
          prep_avg: round(journeyOverall?.prep_avg), prep_n: journeyOverall?.prep_n || 0,
          k2t_avg: round(journeyOverall?.k2t_avg),   k2t_n: journeyOverall?.k2t_n || 0,
          total_avg: round(journeyOverall?.total_avg), total_n: journeyOverall?.total_n || 0,
        },
        by_station: journeyByStation,
        slowest: journeySlowest,
      },
    });
  } catch (e: any) {
    console.error('[/api/dine-in/kot-analytics GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
