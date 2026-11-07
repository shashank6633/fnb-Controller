/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PURCHASE REPORT'S ROW SET — one FROM / WHERE, and the Summary's own
 * period aggregate, shared by the two readers of it (owner ruling 115,
 * 2026-11-05).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   /api/reports/purchases          the Summary tab — cards and breakdowns
 *   /api/reports/purchase-itemwise  the Purchase log tab's item-wise list and
 *                                   its Excel file — ONE LINE PER `purchases`
 *                                   ROW, the very rows the Summary adds up
 *
 * WHY THIS IS ONE MODULE AND NOT TWO COPIES. The owner asked for an item-wise
 * list he can reconcile: every money column has to add up to the Summary card
 * of the same name, to the paisa, for any window and any filter. That is only
 * true BY CONSTRUCTION if the list and the cards read the same rows through the
 * same WHERE clause, the same LEFT JOIN onto raw_materials and the same GRN-line
 * pairing — so both routes build their SQL from here. A second copy of the
 * WHERE in the list's route would agree with the Summary until the day one of
 * the two was edited, and nothing would say so.
 *
 * The text below is MOVED, not rewritten, from /api/reports/purchases (the
 * rulings 1, 2, 4, 5 and 6 explained in that route's header): the same filters,
 * TRIM'd on both sides; the same LEFT JOIN, so an unlinked material keeps its
 * money; the same effective charge rail. For the Summary the generated SQL is
 * character for character what that route ran before it imported this file.
 *
 * `materialId` is the one addition, and only the item-wise list passes it: the
 * Summary tab has no item filter, so with it set there is no Summary card to
 * compare against — the list says so on screen and in its file.
 */
import { grnLineJoinSql, effectiveChargeSumsSql, chargeSourceCountsSql } from '@/lib/purchase-charges';
import { effectiveTaxAppliedSumsSql } from '@/lib/tax-applied';

export interface PurchaseReportFilters {
  from: string;
  to: string;
  /** Exact match, TRIM'd and case-folded on both sides (ruling 2). '' = all. */
  vendor?: string;
  /** Exact match on the item's category, TRIM'd and case-folded. '' = all. */
  category?: string;
  /** Item-wise list only: one item. The Summary never passes it. */
  materialId?: string;
}

/**
 * FROM … WHERE … over `purchases p`, with `rm` (raw_materials, LEFT) and `gl`
 * (the paired GRN line, LEFT, cannot fan out) in scope, plus its bound
 * parameters in order. Every statement built on it must be wrapped in
 * withGrnCharges() from src/lib/purchase-charges.ts.
 */
export function purchaseReportBase(f: PurchaseReportFilters): { base: string; params: unknown[] } {
  const vendor = (f.vendor || '').trim();
  const category = (f.category || '').trim();
  const materialId = (f.materialId || '').trim();

  // RULING 2 (2026-09-10): both optional filters compare TRIM'd on BOTH sides.
  // The dropdowns feeding them are built from TRIM(vendor) / TRIM(category),
  // so an untrimmed comparison here could offer the user a value that then
  // matches zero rows and empties the whole report with no explanation.
  const where: string[] = ['p.date >= ?', 'p.date <= ?'];
  const params: unknown[] = [f.from, f.to];
  if (vendor) { where.push('LOWER(TRIM(p.vendor)) = LOWER(TRIM(?))'); params.push(vendor); }
  if (category) { where.push('LOWER(TRIM(COALESCE(rm.category, \'\'))) = LOWER(TRIM(?))'); params.push(category); }
  if (materialId) { where.push('p.material_id = ?'); params.push(materialId); }
  const W = where.join(' AND ');

  // RULING 1 (2026-09-10): LEFT JOIN. An unlinked material must cost the row
  // its NAME, never its existence.
  //
  // RULING 6 (2026-09-10): the grn_line LEFT JOIN rides in the SAME base, so
  // every aggregate on the report sees the charges on the same rows it counts.
  // It CANNOT fan out — grn_line is keyed 1:1 on purchase_id by construction
  // (see grnChargeCteSql) — which is what lets `spend` and `count` stay
  // byte-identical while the charge columns change underneath them.
  const base = `FROM purchases p
        LEFT JOIN raw_materials rm ON p.material_id = rm.id
        ${grnLineJoinSql('p', 'gl')}
       WHERE ${W}`;
  return { base, params };
}

/**
 * The charge sums every Summary aggregate carries: the eight charges, the
 * Subtotal (bill_value) and the Grand Total (total_amount) off the effective
 * rail, the three source counts, and the Tax % base. See the route's RULING 4–6.
 */
export function purchaseReportChargesSql(): string {
  return `
        ${effectiveChargeSumsSql('p', 'gl')},
        ${chargeSourceCountsSql('p', 'gl')},
        ${effectiveTaxAppliedSumsSql('p', 'gl')}`;
}

/**
 * THE SUMMARY'S PERIOD AGGREGATE — the statement behind every card on the
 * Summary tab. Wrap it in withGrnCharges() and bind the base's params.
 */
export function purchaseReportSummarySql(base: string): string {
  return `
      SELECT
        COUNT(*)                                        AS purchase_count,
        COALESCE(SUM(p.total_price), 0)                 AS total_spend,
        COUNT(DISTINCT p.vendor)                        AS vendor_count,
        COUNT(DISTINCT p.material_id)                   AS item_count,
        COUNT(DISTINCT p.date)                          AS day_count,
        COALESCE(SUM(CASE WHEN p.is_emergency = 1 THEN p.total_price ELSE 0 END), 0) AS emergency_spend,
        COALESCE(SUM(CASE WHEN p.is_emergency = 1 THEN 1 ELSE 0 END), 0)             AS emergency_count,
        ${purchaseReportChargesSql()}
      ${base}
    `;
}
