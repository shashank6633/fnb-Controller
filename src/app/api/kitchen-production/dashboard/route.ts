import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canManageKitchenProduction } from '@/lib/auth';
import { parseDateTime, expiryStatus, ProductionBatch } from '@/lib/production-batch';
import { todayIST, fmtISTIsoDate } from '@/lib/format-date';
import { packFactor } from '@/lib/pack-units';

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
 *   today_consumption_qty                — Σ 'consumed' tx quantity today
 *                                          (legacy cross-unit scalar, kept for
 *                                          wire compat — prefer the split below).
 *   today_consumption_by_unit            — same figure split per batch unit:
 *                                          [{ unit, qty }] (kg + pcs + L must
 *                                          never be added together).
 *   waste_pct / waste_pct_unit           — (wasted+disposed qty) ÷ produced qty
 *                                          over the trailing 30 days, computed
 *                                          PER UNIT; headline is the unit with
 *                                          the largest produced quantity.
 *   waste_pct_by_unit                    — every unit's ratio: [{ unit, pct }].
 *   fifo_compliance_pct                  — heuristic (see note below).
 *   low_stock_alerts                     — # of material-linked items whose total
 *                                          remaining across ACTIVE batches is at
 *                                          or below the raw_materials reorder level
 *                                          (unit-aware — see exclusion rule inline).
 *
 * "today" for tx rows is the IST calendar day: created_at is stored UTC
 * (datetime('now')), so we shift it +5:30 before comparing dates.
 */
export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageKitchenProduction(me)) return Response.json({ error: 'Head chef or admin only' }, { status: 403 });

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
      `SELECT id, item_name, production_item_id, batch_number, material_id, unit, quantity_produced,
              quantity_consumed, expiry_date, expiry_time
         FROM production_batches
        WHERE status = 'active' ${outletSql}`
    ).all(...outletParams) as ProductionBatch[];

    // FIFO chains group by production_item_id (rename/typo safe), else NOCASE name.
    const fifoKey = (b: { production_item_id?: string | null; item_name: string }) =>
      b.production_item_id || String(b.item_name || '').trim().toLowerCase();

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
    // Batch remainders are in production_batches.unit while reorder_level is
    // in the material's RECIPE unit, so track remainders per batch unit and
    // only compare the commensurable ones (exclusion rule below).
    const remainingByMaterial: Record<string, Record<string, number>> = {};
    for (const b of activeBatches) {
      if (!b.material_id) continue;
      const rem = Math.max(0, (b.quantity_produced || 0) - (b.quantity_consumed || 0));
      const bu = String(b.unit || '').toLowerCase().trim();
      const byUnit = (remainingByMaterial[b.material_id] ||= {});
      byUnit[bu] = (byUnit[bu] || 0) + rem;
    }
    let low_stock_alerts = 0;
    const matIds = Object.keys(remainingByMaterial);
    if (matIds.length) {
      const placeholders = matIds.map(() => '?').join(',');
      const mats = db.prepare(
        `SELECT id, unit, purchase_unit, pack_size, reorder_level
           FROM raw_materials WHERE id IN (${placeholders})`
      ).all(...matIds) as {
        id: string; unit: string; purchase_unit: string; pack_size: number; reorder_level: number;
      }[];
      for (const m of mats) {
        const reorder = Number(m.reorder_level) || 0;
        if (reorder <= 0) continue;
        const ru = String(m.unit || '').toLowerCase().trim();
        const pu = String(m.purchase_unit || '').toLowerCase().trim();
        const pf = packFactor(m); // pack_size when it really converts, else 1
        let remaining = 0;
        let commensurable = true;
        for (const [bu, rem] of Object.entries(remainingByMaterial[m.id])) {
          if (!(Number(rem) > 0)) continue;                    // empty bucket can't block the compare
          if (bu === ru) remaining += rem;                     // already recipe units
          else if (bu === pu && pf > 1) remaining += rem * pf; // purchase → recipe
          else { commensurable = false; break; }
        }
        // Exclusion rule: a batch unit that is neither the material's recipe
        // unit nor a pack-convertible purchase unit cannot be compared against
        // reorder_level (recipe units) — skip the material entirely, because a
        // wrong alert is worse than no alert.
        if (!commensurable) continue;
        if (remaining <= reorder) low_stock_alerts += 1;
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

    // Same figure split per batch unit — kg + pcs + L must never be added
    // together, so the UI renders this and the scalar above stays only for
    // wire compat. Qualified fragments: the join makes bare column names
    // ambiguous (both tables carry outlet_id / created_at).
    const txIstDay = `date(t.created_at, '+5 hours', '+30 minutes')`;
    const txOutletSql = outletId ? 'AND (t.outlet_id = ? OR t.outlet_id IS NULL)' : '';
    const today_consumption_by_unit = (db.prepare(
      `SELECT LOWER(TRIM(COALESCE(pb.unit, ''))) AS unit, COALESCE(SUM(t.quantity),0) AS qty
         FROM batch_transactions t
         JOIN production_batches pb ON pb.id = t.batch_id
        WHERE t.type = 'consumed' AND ${txIstDay} = ? ${txOutletSql}
        GROUP BY LOWER(TRIM(COALESCE(pb.unit, '')))
        ORDER BY qty DESC`
    ).all(today, ...outletParams) as { unit: string; qty: number }[])
      .map(r => ({ unit: String(r.unit || ''), qty: Number(r.qty) || 0 }));

    // ---- waste % over trailing 30 days ----
    // Computed PER UNIT: a ratio only means something when numerator and
    // denominator share a unit. Headline = the unit with the most production;
    // the rest ride along in waste_pct_by_unit for the page's sub-note.
    const wasteAgg = db.prepare(
      `SELECT LOWER(TRIM(COALESCE(pb.unit, ''))) AS unit,
              COALESCE(SUM(CASE WHEN t.type IN ('wasted','disposed') THEN t.quantity ELSE 0 END),0) AS wasted,
              COALESCE(SUM(CASE WHEN t.type = 'created' THEN t.quantity ELSE 0 END),0) AS created
         FROM batch_transactions t
         JOIN production_batches pb ON pb.id = t.batch_id
        WHERE t.type IN ('wasted','disposed','created')
          AND ${txIstDay} >= date(?, '-30 days') ${txOutletSql}
        GROUP BY LOWER(TRIM(COALESCE(pb.unit, '')))`
    ).all(today, ...outletParams) as { unit: string; wasted: number; created: number }[];
    const wasteRows = wasteAgg
      .filter(r => Number(r.created) > 0) // headline needs a denominator
      .map(r => ({
        unit: String(r.unit || ''),
        pct: Math.round((Number(r.wasted) / Number(r.created)) * 1000) / 10,
        created: Number(r.created),
      }))
      .sort((a, b) => b.created - a.created);
    const waste_pct = wasteRows[0]?.pct ?? 0;
    const waste_pct_unit = wasteRows[0]?.unit ?? '';
    const waste_pct_by_unit: { unit: string; pct: number | null }[] = wasteRows.map(({ unit, pct }) => ({ unit, pct }));
    // Waste in a unit with zero production this window: no ratio exists, but
    // hiding it entirely would make the KPI read cleaner than reality.
    for (const r of wasteAgg) {
      if (!(Number(r.created) > 0) && Number(r.wasted) > 0) {
        waste_pct_by_unit.push({ unit: String(r.unit || ''), pct: null });
      }
    }

    // ---- FIFO compliance (heuristic) ----
    // We cannot replay historical stock levels, so we approximate at the batch
    // level: a batch that has been drawn from (quantity_consumed > 0) is a FIFO
    // "violation" if any OLDER batch of the same item is still ACTIVE with stock
    // remaining — i.e. newer stock was consumed while older stock sat unused.
    // compliance = compliant ÷ drawn-from batches (100% when none drawn).
    const drawn = db.prepare(
      `SELECT id, item_name, production_item_id, production_date, production_time
         FROM production_batches
        WHERE quantity_consumed > 0 ${outletSql}`
    ).all(...outletParams) as ProductionBatch[];
    let fifo_compliance_pct = 100;
    if (drawn.length) {
      // Oldest still-active-with-stock production datetime per FIFO chain.
      const oldestActive: Record<string, number> = {};
      for (const b of activeBatches) {
        const rem = Math.max(0, (b.quantity_produced || 0) - (b.quantity_consumed || 0));
        if (rem <= 0) continue;
        const k = fifoKey(b);
        const p = parseDateTime(b.production_date, b.production_time);
        const t = p ? p.getTime() : Number.POSITIVE_INFINITY;
        if (oldestActive[k] === undefined || t < oldestActive[k]) {
          oldestActive[k] = t;
        }
      }
      let violations = 0;
      for (const b of drawn) {
        const p = parseDateTime(b.production_date, b.production_time);
        const t = p ? p.getTime() : Number.POSITIVE_INFINITY;
        const oldest = oldestActive[fifoKey(b)];
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
      today_consumption_by_unit,
      waste_pct,
      waste_pct_unit,
      waste_pct_by_unit,
      fifo_compliance_pct,
      low_stock_alerts,
    };

    return Response.json({ widgets, expiring_soon });
  } catch (e: any) {
    console.error('GET /api/kitchen-production/dashboard failed:', e);
    return Response.json({ error: e?.message || 'Failed to load dashboard' }, { status: 500 });
  }
}
