/**
 * ORDER PUNCHED SUMMARY — per STAFF (who created/punched the order) × ITEM, over
 * SETTLED sales for the IST date range [from,to]. One row per
 * (server × product × station × menu attributes), showing how much each staff
 * member has punched of each item: dine-in qty, total qty, gross amount and its
 * share of the grand total.
 *
 * Basis matches every other sales report (see sales-reports.ts / sales-dashboard.ts):
 *   status='settled', date(o.settled_at, IST) BETWEEN from AND to,
 *   (o.outlet_id=? OR o.outlet_id IS NULL), COALESCE(o.bill_type,'normal')='normal'.
 *
 * Money uses per-line `line_total` (the app's authoritative line figure); we do
 * NOT split the order-level discount down to lines, so line Discount is 0 and
 * Final Amount == Amount. Item Type is normalised the same way the dashboard does
 * (lower(trim(item_type,'. ')) → Foods/Liquors/Beverages) to tame dirty values
 * like 'beverages.'. Read-only.
 */
import type Database from 'better-sqlite3';

const IST = "'+330 minutes'";
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface Row {
  punched_by: string;
  station: string;
  item_type: string;
  display_group: string;
  category: string;
  product_name: string;
  item_code: string;
  dietary_tag: string;
  dinein_qty: number;
  party_qty: number;
  total_qty: number;
  amount: number;
  discount: number;
  final_amount: number;
  qty_contribution: number;
  amount_contribution: number;
}

export const COLUMNS: { k: string; label: string; num?: boolean; money?: boolean; pct?: boolean; date?: boolean; wide?: boolean }[] = [
  { k: 'punched_by',          label: 'Punched By' },
  { k: 'station',             label: 'Station' },
  { k: 'item_type',           label: 'Item Type' },
  { k: 'display_group',       label: 'Display Group' },
  { k: 'category',            label: 'Category' },
  { k: 'product_name',        label: 'Product Name', wide: true },
  { k: 'item_code',           label: 'Item Code' },
  { k: 'dietary_tag',         label: 'Dietary Tag' },
  { k: 'dinein_qty',          label: 'Dine-in Qty', num: true },
  { k: 'party_qty',           label: 'Party Qty', num: true },
  { k: 'total_qty',           label: 'Total Qty', num: true },
  { k: 'amount',              label: 'Amount', money: true },
  { k: 'discount',            label: 'Discount', money: true },
  { k: 'final_amount',        label: 'Final Amount', money: true },
  { k: 'qty_contribution',    label: 'Qty Contribution %', pct: true },
  { k: 'amount_contribution', label: 'Amount Contribution %', pct: true },
];

export function run(db: Database.Database, outletId: string | null, from: string, to: string): Row[] {
  const rows = db.prepare(`
    SELECT
      COALESCE(NULLIF(TRIM(o.server_name), ''), 'Unknown') AS punched_by,
      COALESCE(NULLIF(TRIM(oi.station), ''), '') AS station,
      CASE
        WHEN lower(trim(mi.item_type, '. ')) = 'liquors'   THEN 'Liquors'
        WHEN lower(trim(mi.item_type, '. ')) = 'beverages' THEN 'Beverages'
        ELSE 'Foods'
      END AS item_type,
      CASE
        WHEN lower(trim(mi.item_type, '. ')) = 'liquors' THEN 'Liquor'
        ELSE 'Food'
      END AS display_group,
      COALESCE(NULLIF(TRIM(mi.category), ''), 'Uncategorized') AS category,
      oi.name AS product_name,
      COALESCE(mi.item_code, '') AS item_code,
      COALESCE(mi.dietary_tag, '') AS dietary_tag,
      SUM(CASE WHEN lower(COALESCE(o.order_type, 'dine-in')) = 'dine-in'
               THEN COALESCE(oi.quantity, 0) ELSE 0 END) AS dinein_qty,
      SUM(COALESCE(oi.quantity, 0))   AS total_qty,
      SUM(COALESCE(oi.line_total, 0)) AS amount
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE o.status = 'settled'
      AND date(o.settled_at, ${IST}) BETWEEN ? AND ?
      AND (o.outlet_id = ? OR o.outlet_id IS NULL)
      AND COALESCE(o.bill_type, 'normal') = 'normal'
    GROUP BY punched_by, oi.name, oi.station, category, item_type, display_group,
             mi.item_code, mi.dietary_tag
    ORDER BY amount DESC
  `).all(from, to, outletId) as any[];

  const grandQty = rows.reduce((s, r) => s + (Number(r.total_qty) || 0), 0);
  const grandAmt = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  return rows.map((r) => {
    const totalQty = r2(r.total_qty);
    const amount = r2(r.amount);
    return {
      punched_by: String(r.punched_by),
      station: String(r.station || ''),
      item_type: String(r.item_type),
      display_group: String(r.display_group),
      category: String(r.category),
      product_name: String(r.product_name || ''),
      item_code: String(r.item_code || ''),
      dietary_tag: String(r.dietary_tag || ''),
      dinein_qty: r2(r.dinein_qty),
      party_qty: 0,
      total_qty: totalQty,
      amount,
      discount: 0,
      final_amount: amount,
      qty_contribution: grandQty > 0 ? r2((Number(r.total_qty) / grandQty) * 100) : 0,
      amount_contribution: grandAmt > 0 ? r2((Number(r.amount) / grandAmt) * 100) : 0,
    };
  });
}
