import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canApproveAsChef } from '@/lib/auth';
import { parseDateTime, expiryStatus, ProductionBatch } from '@/lib/production-batch';
import { todayIST, fmtISTIsoDate } from '@/lib/format-date';

/**
 * GET /api/kitchen-production/dashboard
 *   → { widgets: { …see keys below }, expiring_soon: [ …next ~10 to expire ] }
 *
 * All figures are computed server-side against a single `now`, scoped to the
 * caller's current outlet (NULL-outlet rows are treated as shared, matching the
 * list/consume routes).
 *
 * Widget keys:
 *   expiring_today / expiring_tomorrow   — ACTIVE batches whose expiry falls on
 *                                          the IST calendar day today / tomorrow
 *                                          and is still in the future.
 *   expiring_3d / expiring_7d            — ACTIVE, not-yet-expired batches whose
 *                                          expiry is within the next 72h / 168h
 *                                          (rolling windows from `now`).
 *   expired                              — ACTIVE batches already past expiry
 *                                          (not yet flipped by the scheduler).
 *   today_production                     — batches whose production_date is today.
 *   labels_printed_today                 — printed+reprinted tx logged today.
 *   active_batches / total_batches       — status counts.
 *   today_consumption_qty                — Σ 'consumed' tx quantity today.
 *   waste_pct                            — (wasted+disposed qty) ÷ produced qty,
 *                                          over the trailing 30 days.
 *   fifo_compliance_pct                  — heuristic (see note below).
 *   low_stock_alerts                     — # of material-linked items whose total
 *                                          remaining across ACTIVE batches is at
 *                                          or below the raw_materials reorder level.
 *
 * "today" for tx rows is the IST calendar day: created_at is stored UTC
 * (datetime('now')), so we shift it +5:30 before comparing dates.
 */
export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canApproveAsChef(me)) return Response.json({ error: 'Head chef or admin only' }, { status: 403 });

    const db = getDb();
    const outletId = await getCurrentOutletId();
    const now = new Date();
    const today = todayIST();
    const tomorrow = fmtISTIsoDate(new Date(now.getTime() + 24 * 3600 * 1000));

    // Outlet scoping fragment reused across queries.
    const outletSql = outletId ? 'AND (outlet_id = ? OR outlet_id IS NULL)' : '';
    const outletParams: any[] = outletId ? [outletId] : [];

    // ---- expiry buckets over ACTIVE batches (computed in JS with `now`) ----
    const activeBatches = db.prepare(
      `SELECT id, item_name, batch_number, material_id, unit, quantity_produced,
              quantity_consumed, expiry_date, expiry_time
         FROM production_batches
        WHERE status = 'active' ${outletSql}`
    ).all(...outletParams) as ProductionBatch[];

    let expiring_today = 0, expiring_tomorrow = 0, expiring_3d = 0, expiring_7d = 0, expired = 0;
    const nowMs = now.getTime();
    for (const b of activeBatches) {
      const exp = parseDateTime(b.expiry_date, b.expiry_time);
      if (!exp) continue;
      const delta = exp.getTime() - nowMs;
      if (delta <= 0) { expired += 1; continue; }
      const expDay = fmtISTIsoDate(exp);
      if (expDay === today) expiring_today += 1;
      else if (expDay === tomorrow) expiring_tomorrow += 1;
      if (delta <= 72 * 3600 * 1000) expiring_3d += 1;
      if (delta <= 168 * 3600 * 1000) expiring_7d += 1;
    }

    // ---- low stock: material-linked items vs reorder level ----
    const remainingByMaterial: Record<string, number> = {};
    for (const b of activeBatches) {
      if (!b.material_id) continue;
      const rem = Math.max(0, (b.quantity_produced || 0) - (b.quantity_consumed || 0));
      remainingByMaterial[b.material_id] = (remainingByMaterial[b.material_id] || 0) + rem;
    }
    let low_stock_alerts = 0;
    const matIds = Object.keys(remainingByMaterial);
    if (matIds.length) {
      const placeholders = matIds.map(() => '?').join(',');
      const mats = db.prepare(
        `SELECT id, reorder_level FROM raw_materials WHERE id IN (${placeholders})`
      ).all(...matIds) as { id: string; reorder_level: number }[];
      for (const m of mats) {
        const reorder = Number(m.reorder_level) || 0;
        if (reorder > 0 && (remainingByMaterial[m.id] || 0) <= reorder) low_stock_alerts += 1;
      }
    }

    // ---- simple counts ----
    const countRow = (sql: string, ...p: any[]) =>
      Number((db.prepare(sql).get(...p) as any)?.c || 0);

    const active_batches = activeBatches.length;
    const total_batches = countRow(
      `SELECT COUNT(*) AS c FROM production_batches WHERE 1=1 ${outletSql}`, ...outletParams);

    const today_production = countRow(
      `SELECT COUNT(*) AS c FROM production_batches
        WHERE production_date = ? ${outletSql}`, today, ...outletParams);

    // tx-based "today" (created_at is UTC → shift to IST before comparing date)
    const istDay = `date(created_at, '+5 hours', '+30 minutes')`;
    const labels_printed_today = countRow(
      `SELECT COUNT(*) AS c FROM batch_transactions
        WHERE type IN ('printed','reprinted') AND ${istDay} = ? ${outletSql}`,
      today, ...outletParams);

    const today_consumption_qty = Number((db.prepare(
      `SELECT COALESCE(SUM(quantity),0) AS s FROM batch_transactions
        WHERE type = 'consumed' AND ${istDay} = ? ${outletSql}`
    ).get(today, ...outletParams) as any)?.s || 0);

    // ---- waste % over trailing 30 days ----
    const wasteRow = db.prepare(
      `SELECT COALESCE(SUM(quantity),0) AS s FROM batch_transactions
        WHERE type IN ('wasted','disposed')
          AND ${istDay} >= date(?, '-30 days') ${outletSql}`
    ).get(today, ...outletParams) as any;
    const producedRow = db.prepare(
      `SELECT COALESCE(SUM(quantity),0) AS s FROM batch_transactions
        WHERE type = 'created'
          AND ${istDay} >= date(?, '-30 days') ${outletSql}`
    ).get(today, ...outletParams) as any;
    const wasteQty = Number(wasteRow?.s || 0);
    const producedQty = Number(producedRow?.s || 0);
    const waste_pct = producedQty > 0 ? Math.round((wasteQty / producedQty) * 1000) / 10 : 0;

    // ---- FIFO compliance (heuristic) ----
    // We cannot replay historical stock levels, so we approximate at the batch
    // level: a batch that has been drawn from (quantity_consumed > 0) is a FIFO
    // "violation" if any OLDER batch of the same item is still ACTIVE with stock
    // remaining — i.e. newer stock was consumed while older stock sat unused.
    // compliance = compliant ÷ drawn-from batches (100% when none drawn).
    const drawn = db.prepare(
      `SELECT id, item_name, production_date, production_time
         FROM production_batches
        WHERE quantity_consumed > 0 ${outletSql}`
    ).all(...outletParams) as ProductionBatch[];
    let fifo_compliance_pct = 100;
    if (drawn.length) {
      // Oldest still-active-with-stock production datetime per item.
      const oldestActive: Record<string, number> = {};
      for (const b of activeBatches) {
        const rem = Math.max(0, (b.quantity_produced || 0) - (b.quantity_consumed || 0));
        if (rem <= 0) continue;
        const p = parseDateTime(b.production_date, b.production_time);
        const t = p ? p.getTime() : Number.POSITIVE_INFINITY;
        if (oldestActive[b.item_name] === undefined || t < oldestActive[b.item_name]) {
          oldestActive[b.item_name] = t;
        }
      }
      let violations = 0;
      for (const b of drawn) {
        const p = parseDateTime(b.production_date, b.production_time);
        const t = p ? p.getTime() : Number.POSITIVE_INFINITY;
        const oldest = oldestActive[b.item_name];
        // Consumed from this batch while a strictly-older batch still has stock.
        if (oldest !== undefined && oldest < t) violations += 1;
      }
      fifo_compliance_pct = Math.round(((drawn.length - violations) / drawn.length) * 1000) / 10;
    }

    // ---- next ~10 batches to expire ----
    const soonRows = db.prepare(
      `SELECT batch_number, item_name, expiry_date, expiry_time
         FROM production_batches
        WHERE status = 'active' AND expiry_date IS NOT NULL AND expiry_date != '' ${outletSql}
        ORDER BY expiry_date ASC, expiry_time ASC
        LIMIT 10`
    ).all(...outletParams) as ProductionBatch[];
    const expiring_soon = soonRows.map((b) => ({
      batch_number: b.batch_number,
      item_name: b.item_name,
      expiry: parseDateTime(b.expiry_date, b.expiry_time)?.toISOString() || b.expiry_date,
      expiry_status: expiryStatus(b.expiry_date, b.expiry_time, now),
    }));

    const widgets = {
      expiring_today,
      expiring_tomorrow,
      expiring_3d,
      expiring_7d,
      expired,
      today_production,
      labels_printed_today,
      active_batches,
      total_batches,
      today_consumption_qty,
      waste_pct,
      fifo_compliance_pct,
      low_stock_alerts,
    };

    return Response.json({ widgets, expiring_soon });
  } catch (e: any) {
    console.error('GET /api/kitchen-production/dashboard failed:', e);
    return Response.json({ error: e?.message || 'Failed to load dashboard' }, { status: 500 });
  }
}
