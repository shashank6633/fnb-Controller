/**
 * Customer Order Report — one row per SETTLED order (settled_at DESC).
 *
 * Same SETTLED-sales basis as the rest of the Reports section (see
 * sales-reports.ts): status='settled', IST settle-day in [from,to], outlet
 * scoped the lenient way (row's outlet OR legacy NULL), and only 'normal'
 * bills (comps / non-chargeable excluded). Money follows bill-calc's round2.
 *
 * Payments: split-tender lines in order_payments take precedence per order;
 * an order with no split rows (or a DB with no order_payments table at all)
 * falls back to orders.payment_method + orders.total — mirroring the Sales
 * Dashboard's payment-category logic.
 */
import type Database from 'better-sqlite3';

const IST = "'+330 minutes'";
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export interface Row {
  order_date: string;      // settled date  (YYYY-MM-DD, IST)
  order_time: string;      // settled time  (HH:MM, IST)
  session: string;         // Lunch (<16:00 IST) / Dinner
  order_type: string;      // Dine-in / Takeaway / Delivery
  area: string;            // table zone, else channel, else —
  table_no: string;        // table_number or —
  order_id: number;        // order_number
  subtotal: number;
  discount: number;        // orders.discount
  discount_pct: number;    // orders.discount_pct
  gst: number;             // orders.tax_total
  service_charge: number;
  grand_total: number;     // orders.total
  cash: number;
  upi: number;
  card: number;
  paid: number;            // sum of payments, else total
  status: string;
  customer: string;        // guest_name or Walk-in
  contact: string;         // guest_mobile
  guests: number;          // covers
  items: string;           // "2× Chicken Soup, 1× Paneer Tikka"
  waiter: string;          // server_name
  closed_on: string;       // settled_at (raw datetime)
  order_mins: number;      // minutes between created_at and settled_at
  apc: number;             // total / covers
}

export const COLUMNS: { k: string; label: string; num?: boolean; money?: boolean; pct?: boolean; date?: boolean; wide?: boolean }[] = [
  { k: 'order_date', label: 'Order Date' },
  { k: 'order_time', label: 'Order Time' },
  { k: 'session', label: 'Session' },
  { k: 'order_type', label: 'Order Type' },
  { k: 'area', label: 'Area' },
  { k: 'table_no', label: 'Table' },
  { k: 'order_id', label: 'Order ID' },
  { k: 'subtotal', label: 'Subtotal', money: true },
  { k: 'discount', label: 'Discount', money: true },
  { k: 'discount_pct', label: 'Discount %', pct: true },
  { k: 'gst', label: 'GST', money: true },
  { k: 'service_charge', label: 'Service Charge', money: true },
  { k: 'grand_total', label: 'Grand Total', money: true },
  { k: 'cash', label: 'Cash', money: true },
  { k: 'upi', label: 'UPI', money: true },
  { k: 'card', label: 'Card', money: true },
  { k: 'paid', label: 'Paid', money: true },
  { k: 'status', label: 'Status' },
  { k: 'customer', label: 'Customer' },
  { k: 'contact', label: 'Contact' },
  { k: 'guests', label: 'Guests', num: true },
  { k: 'items', label: 'Items', wide: true },
  { k: 'waiter', label: 'Waiter' },
  { k: 'closed_on', label: 'Closed On', date: true },
  { k: 'order_mins', label: 'Order Time Mins', num: true },
  { k: 'apc', label: 'APC', money: true },
];

export function run(db: Database.Database, outletId: string | null, from: string, to: string): Row[] {
  // Split-tender payments (order_payments) take precedence per order; fall back
  // to the single orders.payment_method + orders.total when there are none (or
  // the table is absent on this DB).
  const hasPay = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='order_payments'"
  ).get();

  const payJoin = hasPay
    ? `LEFT JOIN (
         SELECT order_id,
           SUM(CASE WHEN lower(method)='cash' THEN amount ELSE 0 END) AS pay_cash,
           SUM(CASE WHEN lower(method)='upi'  THEN amount ELSE 0 END) AS pay_upi,
           SUM(CASE WHEN lower(method)='card' THEN amount ELSE 0 END) AS pay_card,
           SUM(amount) AS pay_total,
           COUNT(*)    AS pay_rows
         FROM order_payments GROUP BY order_id
       ) p ON p.order_id = o.id`
    : '';

  const fbCash = `CASE WHEN lower(COALESCE(o.payment_method,''))='cash' THEN COALESCE(o.total,0) ELSE 0 END`;
  const fbUpi  = `CASE WHEN lower(COALESCE(o.payment_method,''))='upi'  THEN COALESCE(o.total,0) ELSE 0 END`;
  const fbCard = `CASE WHEN lower(COALESCE(o.payment_method,''))='card' THEN COALESCE(o.total,0) ELSE 0 END`;

  const cashExpr = hasPay ? `CASE WHEN COALESCE(p.pay_rows,0) > 0 THEN COALESCE(p.pay_cash,0) ELSE (${fbCash}) END` : fbCash;
  const upiExpr  = hasPay ? `CASE WHEN COALESCE(p.pay_rows,0) > 0 THEN COALESCE(p.pay_upi,0)  ELSE (${fbUpi})  END` : fbUpi;
  const cardExpr = hasPay ? `CASE WHEN COALESCE(p.pay_rows,0) > 0 THEN COALESCE(p.pay_card,0) ELSE (${fbCard}) END` : fbCard;
  const paidExpr = hasPay ? `CASE WHEN COALESCE(p.pay_rows,0) > 0 THEN COALESCE(p.pay_total,0) ELSE COALESCE(o.total,0) END` : `COALESCE(o.total,0)`;

  const rows = db.prepare(`
    SELECT
      date(o.settled_at, ${IST})            AS order_date,
      strftime('%H:%M', o.settled_at, ${IST}) AS order_time,
      CASE WHEN CAST(strftime('%H', o.settled_at, ${IST}) AS INTEGER) < 16 THEN 'Lunch' ELSE 'Dinner' END AS session,
      CASE lower(COALESCE(NULLIF(TRIM(o.order_type), ''), 'dine-in'))
        WHEN 'dine-in' THEN 'Dine-in' WHEN 'takeaway' THEN 'Takeaway'
        WHEN 'delivery' THEN 'Delivery' ELSE 'Other' END AS order_type,
      COALESCE(NULLIF(TRIM(rt.zone), ''),
        CASE lower(COALESCE(o.order_type,'dine-in'))
          WHEN 'takeaway' THEN 'Takeaway' WHEN 'delivery' THEN 'Delivery' ELSE '—' END) AS area,
      COALESCE(NULLIF(TRIM(CAST(rt.table_number AS TEXT)), ''), '—') AS table_no,
      o.order_number                        AS order_id,
      COALESCE(o.subtotal, 0)               AS subtotal,
      COALESCE(o.discount, 0)               AS discount,
      COALESCE(o.discount_pct, 0)           AS discount_pct,
      COALESCE(o.tax_total, 0)              AS gst,
      COALESCE(o.service_charge, 0)         AS service_charge,
      COALESCE(o.total, 0)                  AS grand_total,
      (${cashExpr})                         AS cash,
      (${upiExpr})                          AS upi,
      (${cardExpr})                         AS card,
      (${paidExpr})                         AS paid,
      COALESCE(o.status, '')                AS status,
      COALESCE(NULLIF(TRIM(o.guest_name), ''), 'Walk-in') AS customer,
      COALESCE(o.guest_mobile, '')          AS contact,
      COALESCE(o.covers, 0)                 AS guests,
      (SELECT GROUP_CONCAT(printf('%g', oi.quantity) || '× ' || oi.name, ', ')
         FROM order_items oi WHERE oi.order_id = o.id) AS items,
      COALESCE(NULLIF(TRIM(o.server_name), ''), '') AS waiter,
      o.settled_at                          AS closed_on,
      CAST(ROUND((julianday(o.settled_at) - julianday(o.created_at)) * 1440) AS INTEGER) AS order_mins,
      (COALESCE(o.total, 0) / NULLIF(o.covers, 0)) AS apc
    FROM orders o
    LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
    ${payJoin}
    WHERE o.status = 'settled'
      AND date(o.settled_at, ${IST}) BETWEEN ? AND ?
      AND (o.outlet_id = ? OR o.outlet_id IS NULL)
      AND COALESCE(o.bill_type, 'normal') = 'normal'
    ORDER BY o.settled_at DESC
  `).all(from, to, outletId) as any[];

  return rows.map((r) => ({
    order_date: String(r.order_date || ''),
    order_time: String(r.order_time || ''),
    session: String(r.session || ''),
    order_type: String(r.order_type || ''),
    area: String(r.area || '—'),
    table_no: String(r.table_no || '—'),
    order_id: Number(r.order_id) || 0,
    subtotal: r2(r.subtotal),
    discount: r2(r.discount),
    discount_pct: r2(r.discount_pct),
    gst: r2(r.gst),
    service_charge: r2(r.service_charge),
    grand_total: r2(r.grand_total),
    cash: r2(r.cash),
    upi: r2(r.upi),
    card: r2(r.card),
    paid: r2(r.paid),
    status: cap(String(r.status || '')),
    customer: String(r.customer || 'Walk-in'),
    contact: String(r.contact || ''),
    guests: Number(r.guests) || 0,
    items: String(r.items || ''),
    waiter: String(r.waiter || ''),
    closed_on: String(r.closed_on || ''),
    order_mins: Number(r.order_mins) || 0,
    apc: r2(r.apc),
  }));
}
