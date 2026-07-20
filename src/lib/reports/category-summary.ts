/**
 * Category Summary report — one row per menu category over SETTLED item sales.
 *
 * Same settled-sales basis as the rest of the Sales reports (see sales-reports.ts):
 * status='settled', date(settled_at, IST) in [from,to], outlet-lenient (row's
 * outlet OR legacy NULL), and only 'normal' bills (comp/NC excluded). Amounts are
 * pre-charge item line totals (SUM order_items.line_total), rounded to 2dp the
 * same way bill-calc.round2 does.
 *
 * Display Group is derived from menu_items.item_type the app's way — the dirty
 * 'beverages.' value is normalised via trim(item_type, '. '); 'liquors' → 'Liquor',
 * everything else (foods/beverages/unknown/NULL) → 'Food'. A category is bucketed
 * as 'Liquor' if it contains any liquor line (MAX flag), keeping it to exactly one
 * row per category.
 *
 * Party Qty is always 0 — this POS has no party/banquet order items (party P&L
 * lives in a separate `parties` system), so there is no per-category party volume
 * to report.
 */
import type Database from 'better-sqlite3';

const IST = "'+330 minutes'";
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface Row {
  category: string;
  display_group: string;
  dinein_qty: number;
  party_qty: number;
  sales_amount: number;
  total_qty: number;
  contribution_pct: number;
}

export const COLUMNS: { k: string; label: string; num?: boolean; money?: boolean; pct?: boolean; date?: boolean; wide?: boolean }[] = [
  { k: 'category', label: 'Category' },
  { k: 'display_group', label: 'Display Group' },
  { k: 'dinein_qty', label: 'Dine-in Qty', num: true },
  { k: 'party_qty', label: 'Party Qty', num: true },
  { k: 'sales_amount', label: 'Sales Amount', money: true },
  { k: 'total_qty', label: 'Total Qty', num: true },
  { k: 'contribution_pct', label: 'Contribution %', pct: true },
];

export function run(db: Database.Database, outletId: string | null, from: string, to: string): Row[] {
  const rows = db.prepare(`
    SELECT
      COALESCE(NULLIF(TRIM(mi.category), ''), 'Uncategorized') AS category,
      CASE WHEN MAX(CASE WHEN lower(trim(mi.item_type, '. ')) = 'liquors' THEN 1 ELSE 0 END) = 1
           THEN 'Liquor' ELSE 'Food' END AS display_group,
      SUM(CASE WHEN lower(COALESCE(NULLIF(TRIM(o.order_type), ''), 'dine-in')) = 'dine-in'
               THEN COALESCE(oi.quantity, 0) ELSE 0 END) AS dinein_qty,
      SUM(COALESCE(oi.line_total, 0)) AS sales_amount,
      SUM(COALESCE(oi.quantity, 0)) AS total_qty
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE o.status = 'settled'
      AND date(o.settled_at, ${IST}) BETWEEN ? AND ?
      AND (o.outlet_id = ? OR o.outlet_id IS NULL)
      AND COALESCE(o.bill_type, 'normal') = 'normal'
    GROUP BY category
    ORDER BY sales_amount DESC
  `).all(from, to, outletId) as any[];

  const total = rows.reduce((s, r) => s + (Number(r.sales_amount) || 0), 0);
  return rows.map((r) => ({
    category: String(r.category),
    display_group: String(r.display_group),
    dinein_qty: r2(r.dinein_qty),
    party_qty: 0,
    sales_amount: r2(r.sales_amount),
    total_qty: r2(r.total_qty),
    contribution_pct: total > 0 ? r2((Number(r.sales_amount) / total) * 100) : 0,
  }));
}
