/**
 * ITEM WISE (CUSTOMER) DETAIL — one row per order_item on SETTLED orders.
 *
 * Sales-report conventions (see src/lib/sales-reports.ts): status='settled',
 * date(settled_at, IST) in [from,to], (outlet_id=? OR NULL), bill_type='normal'.
 *
 * Tax convention (see src/lib/bill-calc.ts → sumItemTax): each line's stored
 * `line_total` is tax-EXCLUSIVE and GST (line_total × tax_value%) is added ON TOP.
 * Therefore for this app:
 *   Amount            = line_total
 *   Amount Before Tax = line_total   (already pre-tax — do NOT divide by 1+rate)
 *   Tax Amount        = line_total × tax_value/100
 *   Grand Total       = line_total + Tax Amount
 * This matches the settle route + printed bill exactly. Read-only.
 */
import type Database from 'better-sqlite3';

const IST = "'+330 minutes'";
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface Row {
  order_datetime: string;    // orders.settled_at (raw ISO)
  session: string;           // Lunch (<16:00 IST) / Dinner
  order_type: string;        // Dine-in / Takeaway / Delivery
  table_label: string;       // Table N / Takeaway / Delivery / —
  order_number: number;      // orders.order_number
  display_group: string;     // Food / Liquor
  category: string;          // menu_items.category
  item_type: string;         // Foods / Liquors / Beverages
  item_name: string;         // order_items.name
  rate: number;              // unit_price
  qty: number;               // quantity
  kot_printed: string;       // order_items.fired_at (raw ISO, may be blank)
  amount: number;            // line_total
  amount_before_tax: number; // line_total (tax-exclusive)
  tax_type: string;          // 'GST'
  tax_rate: number;          // tax_value %
  tax_amount: number;        // line_total × tax_value/100
  grand_total: number;       // line_total + tax_amount
  status: string;            // order_items.status
  customer: string;          // guest_name or 'Walk-in'
  contact: string;           // guest_mobile
  instructions: string;      // order_items.notes
  station: string;           // order_items.station
  waiter: string;            // orders.server_name
}

export const COLUMNS: { k: string; label: string; num?: boolean; money?: boolean; pct?: boolean; date?: boolean; wide?: boolean }[] = [
  { k: 'order_datetime', label: 'Order Date & Time', date: true },
  { k: 'session', label: 'Session' },
  { k: 'order_type', label: 'Order Type' },
  { k: 'table_label', label: 'Table' },
  { k: 'order_number', label: 'Order ID' },
  { k: 'display_group', label: 'Display Group' },
  { k: 'category', label: 'Category' },
  { k: 'item_type', label: 'Item Type' },
  { k: 'item_name', label: 'Item Name' },
  { k: 'rate', label: 'Rate', money: true },
  { k: 'qty', label: 'Qty', num: true },
  { k: 'kot_printed', label: 'KOT Printed', date: true },
  { k: 'amount', label: 'Amount', money: true },
  { k: 'amount_before_tax', label: 'Amount Before Tax', money: true },
  { k: 'tax_type', label: 'Tax Type' },
  { k: 'tax_rate', label: 'Tax Rate', pct: true },
  { k: 'tax_amount', label: 'Tax Amount', money: true },
  { k: 'grand_total', label: 'Grand Total', money: true },
  { k: 'status', label: 'Status' },
  { k: 'customer', label: 'Customer' },
  { k: 'contact', label: 'Contact' },
  { k: 'instructions', label: 'Instructions', wide: true },
  { k: 'station', label: 'Station' },
  { k: 'waiter', label: 'Waiter' },
];

export function run(db: Database.Database, outletId: string | null, from: string, to: string): Row[] {
  const rows = db.prepare(`
    SELECT
      o.settled_at AS order_datetime,
      CASE WHEN CAST(strftime('%H', o.settled_at, ${IST}) AS INTEGER) < 16
           THEN 'Lunch' ELSE 'Dinner' END AS session,
      CASE lower(COALESCE(NULLIF(TRIM(o.order_type), ''), 'dine-in'))
           WHEN 'dine-in' THEN 'Dine-in' WHEN 'takeaway' THEN 'Takeaway'
           WHEN 'delivery' THEN 'Delivery' ELSE 'Other' END AS order_type,
      CASE WHEN o.table_id IS NOT NULL AND rt.table_number IS NOT NULL THEN 'Table ' || rt.table_number
           WHEN lower(COALESCE(o.order_type, 'dine-in')) = 'takeaway' THEN 'Takeaway'
           WHEN lower(COALESCE(o.order_type, 'dine-in')) = 'delivery' THEN 'Delivery'
           ELSE '—' END AS table_label,
      o.order_number AS order_number,
      CASE WHEN lower(trim(mi.item_type, '. ')) = 'liquors' THEN 'Liquor' ELSE 'Food' END AS display_group,
      COALESCE(NULLIF(TRIM(mi.category), ''), 'Uncategorized') AS category,
      CASE lower(trim(mi.item_type, '. '))
           WHEN 'liquors' THEN 'Liquors' WHEN 'beverages' THEN 'Beverages' ELSE 'Foods' END AS item_type,
      oi.name AS item_name,
      COALESCE(oi.unit_price, 0) AS rate,
      COALESCE(oi.quantity, 0) AS qty,
      oi.fired_at AS kot_printed,
      COALESCE(oi.line_total, 0) AS amount,
      COALESCE(oi.line_total, 0) AS amount_before_tax,
      'GST' AS tax_type,
      COALESCE(oi.tax_value, 0) AS tax_rate,
      COALESCE(oi.line_total, 0) * COALESCE(oi.tax_value, 0) / 100.0 AS tax_amount,
      COALESCE(oi.line_total, 0) + COALESCE(oi.line_total, 0) * COALESCE(oi.tax_value, 0) / 100.0 AS grand_total,
      COALESCE(NULLIF(TRIM(oi.status), ''), 'pending') AS status,
      COALESCE(NULLIF(TRIM(o.guest_name), ''), 'Walk-in') AS customer,
      COALESCE(o.guest_mobile, '') AS contact,
      COALESCE(oi.notes, '') AS instructions,
      COALESCE(NULLIF(TRIM(oi.station), ''), '') AS station,
      COALESCE(o.server_name, '') AS waiter
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
    WHERE o.status = 'settled'
      AND date(o.settled_at, ${IST}) BETWEEN ? AND ?
      AND (o.outlet_id = ? OR o.outlet_id IS NULL)
      AND COALESCE(o.bill_type, 'normal') = 'normal'
    ORDER BY o.settled_at DESC, oi.created_at ASC
  `).all(from, to, outletId) as any[];

  return rows.map((r) => ({
    order_datetime: String(r.order_datetime || ''),
    session: String(r.session || ''),
    order_type: String(r.order_type || ''),
    table_label: String(r.table_label || '—'),
    order_number: Number(r.order_number) || 0,
    display_group: String(r.display_group || ''),
    category: String(r.category || ''),
    item_type: String(r.item_type || ''),
    item_name: String(r.item_name || ''),
    rate: r2(r.rate),
    qty: r2(r.qty),
    kot_printed: String(r.kot_printed || ''),
    amount: r2(r.amount),
    amount_before_tax: r2(r.amount_before_tax),
    tax_type: String(r.tax_type || 'GST'),
    tax_rate: r2(r.tax_rate),
    tax_amount: r2(r.tax_amount),
    grand_total: r2(r.grand_total),
    status: String(r.status || ''),
    customer: String(r.customer || 'Walk-in'),
    contact: String(r.contact || ''),
    instructions: String(r.instructions || ''),
    station: String(r.station || ''),
    waiter: String(r.waiter || ''),
  }));
}
