/**
 * Sales Reports — the data layer for the Reports section (/reports/sales).
 *
 * Reuses the proven queries in sales-dashboard.ts (floor / table / item wise) and
 * adds customer-wise, category-wise, and dine-in-vs-party. All figures are
 * SETTLED sales over an IST date range [from,to] (YYYY-MM-DD), outlet-scoped the
 * lenient way the rest of the app is (row's outlet OR legacy NULL). Read-only.
 */
import type Database from 'better-sqlite3';
import { getTableWiseSales, getItemWiseSales } from './sales-dashboard';

const IST = "'+330 minutes'";
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export type SalesReportType = 'orders' | 'customer' | 'table' | 'item' | 'category' | 'channel' | 'floor' | 'kots';

export interface KotRow {
  kot_number: number; order_number: number; fired_at: string; table_label: string;
  station: string; status: string; items: string; print_status: string;
}

/**
 * KOT tracking report: one row per kitchen ticket (kots) in the range, with its
 * order #, table/channel, station, prep status (new/preparing/ready/served), the
 * items on that KOT, when it fired, and its print outcome (from print_jobs).
 * Ranged on kots.created_at (fire time) — includes KOTs for still-open orders.
 */
export function getKotReport(db: Database.Database, outletId: string | null, from: string, to: string): KotRow[] {
  const rows = db.prepare(`
    SELECT
      k.kot_number AS kot_number,
      o.order_number AS order_number,
      k.created_at AS fired_at,
      CASE WHEN o.table_id IS NOT NULL AND rt.table_number IS NOT NULL THEN 'Table ' || rt.table_number
           WHEN lower(COALESCE(o.order_type, 'dine-in')) = 'takeaway' THEN 'Takeaway'
           WHEN lower(COALESCE(o.order_type, 'dine-in')) = 'delivery' THEN 'Delivery'
           ELSE '—' END AS table_label,
      COALESCE(NULLIF(TRIM(k.station), ''), 'kitchen') AS station,
      COALESCE(NULLIF(TRIM(k.status), ''), 'new') AS status,
      (SELECT GROUP_CONCAT(printf('%g', oi.quantity) || '× ' || oi.name, ', ')
         FROM order_items oi WHERE oi.kot_id = k.id) AS items,
      (SELECT pj.status FROM print_jobs pj
         WHERE pj.ref_id = k.id AND pj.doc_type = 'kot' ORDER BY pj.created_at DESC LIMIT 1) AS print_status
    FROM kots k
    JOIN orders o ON o.id = k.order_id
    LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
    WHERE date(k.created_at, ${IST}) BETWEEN ? AND ?
      AND (o.outlet_id = ? OR o.outlet_id IS NULL)
    ORDER BY k.created_at DESC
  `).all(from, to, outletId) as any[];
  const cap = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const printLabel = (s: string | null) =>
    s === 'printed' ? 'Printed' : s === 'failed' ? 'Failed' : s === 'queued' ? 'Queued' : '—';
  return rows.map((r) => ({
    kot_number: Number(r.kot_number) || 0,
    order_number: Number(r.order_number) || 0,
    fired_at: String(r.fired_at || ''),
    table_label: String(r.table_label || '—'),
    station: cap(String(r.station)),
    status: cap(String(r.status)),
    items: String(r.items || ''),
    print_status: printLabel(r.print_status),
  }));
}

export interface OrderDetailRow {
  order_number: number; settled_at: string; customer: string; mobile: string;
  table_label: string; floor: string; covers: number; items: string; amount: number;
}

/**
 * Order-level detail (Customers Order Report): ONE row per settled bill with its
 * order #, date/time, customer, table/channel, ALL ordered items in a single cell
 * ("2× Chicken Soup, 1× Paneer Tikka"), covers and amount.
 */
export function getOrdersDetail(db: Database.Database, outletId: string | null, from: string, to: string): OrderDetailRow[] {
  const rows = db.prepare(`
    SELECT
      o.order_number AS order_number,
      o.settled_at AS settled_at,
      COALESCE(NULLIF(TRIM(o.guest_name), ''), 'Walk-in') AS customer,
      COALESCE(o.guest_mobile, '') AS mobile,
      CASE WHEN o.table_id IS NOT NULL AND rt.table_number IS NOT NULL THEN 'Table ' || rt.table_number
           WHEN lower(COALESCE(o.order_type, 'dine-in')) = 'takeaway' THEN 'Takeaway'
           WHEN lower(COALESCE(o.order_type, 'dine-in')) = 'delivery' THEN 'Delivery'
           ELSE '—' END AS table_label,
      COALESCE(NULLIF(TRIM(rt.zone), ''), '') AS floor,
      COALESCE(o.covers, 0) AS covers,
      COALESCE(o.total, 0) AS amount,
      (SELECT GROUP_CONCAT(printf('%g', oi.quantity) || '× ' || oi.name, ', ')
         FROM order_items oi WHERE oi.order_id = o.id) AS items
    FROM orders o
    LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
    WHERE o.status = 'settled'
      AND date(o.settled_at, ${IST}) BETWEEN ? AND ?
      AND (o.outlet_id = ? OR o.outlet_id IS NULL)
      AND COALESCE(o.bill_type, 'normal') = 'normal'
    ORDER BY o.settled_at DESC
  `).all(from, to, outletId) as any[];
  return rows.map((r) => ({
    order_number: Number(r.order_number) || 0,
    settled_at: String(r.settled_at || ''),
    customer: String(r.customer), mobile: String(r.mobile || ''),
    table_label: String(r.table_label || '—'), floor: String(r.floor || ''),
    covers: Number(r.covers) || 0, items: String(r.items || ''), amount: r2(r.amount),
  }));
}

export interface CustomerRow { name: string; mobile: string; orders: number; covers: number; sales: number; tax: number }
export interface CategoryRow { category: string; qty: number; sales: number; tax: number; contribution: number }
export interface ChannelRow { channel: string; orders: number; sales: number }

/** One row per guest (name+mobile). Anonymous bills collapse into "Walk-in". */
export function getCustomerWiseSales(db: Database.Database, outletId: string | null, from: string, to: string): CustomerRow[] {
  const rows = db.prepare(`
    SELECT
      COALESCE(NULLIF(TRIM(o.guest_name), ''), 'Walk-in') AS name,
      COALESCE(o.guest_mobile, '') AS mobile,
      COUNT(*) AS orders,
      SUM(COALESCE(o.covers, 0)) AS covers,
      SUM(COALESCE(o.total, 0)) AS sales,
      SUM(COALESCE(o.tax_total, 0)) AS tax
    FROM orders o
    WHERE o.status = 'settled'
      AND date(o.settled_at, ${IST}) BETWEEN ? AND ?
      AND (o.outlet_id = ? OR o.outlet_id IS NULL)
      AND COALESCE(o.bill_type, 'normal') = 'normal'
    GROUP BY name, mobile
    ORDER BY sales DESC
  `).all(from, to, outletId) as any[];
  return rows.map((r) => ({
    name: String(r.name), mobile: String(r.mobile || ''),
    orders: Number(r.orders) || 0, covers: Number(r.covers) || 0,
    sales: r2(r.sales), tax: r2(r.tax),
  }));
}

/** One row per menu category, with contribution % of total category sales. */
export function getCategoryWiseSales(db: Database.Database, outletId: string | null, from: string, to: string): CategoryRow[] {
  const rows = db.prepare(`
    SELECT
      COALESCE(NULLIF(TRIM(mi.category), ''), 'Uncategorized') AS category,
      SUM(COALESCE(oi.quantity, 0)) AS qty,
      SUM(COALESCE(oi.line_total, 0)) AS sales,
      SUM(COALESCE(oi.line_total, 0) * COALESCE(oi.tax_value, 0) / 100.0) AS tax
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE o.status = 'settled'
      AND date(o.settled_at, ${IST}) BETWEEN ? AND ?
      AND (o.outlet_id = ? OR o.outlet_id IS NULL)
      AND COALESCE(o.bill_type, 'normal') = 'normal'
    GROUP BY category
    ORDER BY sales DESC
  `).all(from, to, outletId) as any[];
  const total = rows.reduce((s, r) => s + (Number(r.sales) || 0), 0);
  return rows.map((r) => ({
    category: String(r.category),
    qty: r2(r.qty), sales: r2(r.sales), tax: r2(r.tax),
    contribution: total > 0 ? r2((Number(r.sales) / total) * 100) : 0,
  }));
}

export interface FloorRow { floor: string; orders: number; covers: number; sales: number }

/**
 * Floor-wise SETTLED sales — grouped by the table's zone, table-less bills
 * bucketed by channel (Takeaway/Delivery). Uses the SAME settled-orders basis as
 * the other tabs (orders.total on settled_at), so the floor totals reconcile with
 * the Orders/Table/Channel tabs. (The pre-tax `sales`-fact P&L view with cost/GP
 * lives on the Sales Dashboard.)
 */
export function getFloorWiseSales(db: Database.Database, outletId: string | null, from: string, to: string): FloorRow[] {
  const rows = db.prepare(`
    SELECT
      COALESCE(NULLIF(TRIM(rt.zone), ''),
        CASE WHEN o.table_id IS NULL THEN
          (CASE lower(COALESCE(o.order_type, 'dine-in'))
             WHEN 'takeaway' THEN 'Takeaway' WHEN 'delivery' THEN 'Delivery' ELSE 'Other' END)
          ELSE 'Unassigned' END) AS floor,
      COUNT(*) AS orders,
      SUM(COALESCE(o.covers, 0)) AS covers,
      SUM(COALESCE(o.total, 0)) AS sales
    FROM orders o
    LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
    WHERE o.status = 'settled'
      AND date(o.settled_at, ${IST}) BETWEEN ? AND ?
      AND (o.outlet_id = ? OR o.outlet_id IS NULL)
      AND COALESCE(o.bill_type, 'normal') = 'normal'
    GROUP BY floor
    ORDER BY sales DESC
  `).all(from, to, outletId) as any[];
  return rows.map((r) => ({
    floor: String(r.floor), orders: Number(r.orders) || 0,
    covers: Number(r.covers) || 0, sales: r2(r.sales),
  }));
}

/** Dine-in / Takeaway / Delivery (from orders) + Party/Events (from parties). */
export function getDineInVsParty(db: Database.Database, outletId: string | null, from: string, to: string): ChannelRow[] {
  const orderRows = db.prepare(`
    SELECT
      CASE lower(COALESCE(NULLIF(TRIM(o.order_type), ''), 'dine-in'))
        WHEN 'dine-in' THEN 'Dine-in' WHEN 'takeaway' THEN 'Takeaway'
        WHEN 'delivery' THEN 'Delivery' ELSE 'Other' END AS channel,
      COUNT(*) AS orders, SUM(COALESCE(o.total, 0)) AS sales
    FROM orders o
    WHERE o.status = 'settled'
      AND date(o.settled_at, ${IST}) BETWEEN ? AND ?
      AND (o.outlet_id = ? OR o.outlet_id IS NULL)
      AND COALESCE(o.bill_type, 'normal') = 'normal'
    GROUP BY channel
    ORDER BY sales DESC
  `).all(from, to, outletId) as any[];
  const out: ChannelRow[] = orderRows.map((r) => ({ channel: String(r.channel), orders: Number(r.orders) || 0, sales: r2(r.sales) }));

  // Party/Events — separate system (parties table). Best-effort: skip if absent.
  try {
    const p = db.prepare(`
      SELECT COUNT(*) AS events, SUM(COALESCE(akan_final_amount, 0)) AS sales
      FROM parties
      WHERE lower(COALESCE(status, '')) = 'completed' AND date BETWEEN ? AND ?
    `).get(from, to) as any;
    if (p && (Number(p.events) > 0 || Number(p.sales) > 0)) {
      out.push({ channel: 'Party / Events', orders: Number(p.events) || 0, sales: r2(p.sales) });
    }
  } catch { /* parties table absent — dine-in channels only */ }
  return out;
}

/** Single dispatch used by the API. Returns { columns, rows, totals? } shape-agnostic rows. */
export function runSalesReport(
  db: Database.Database, outletId: string | null, type: SalesReportType, from: string, to: string,
): { rows: any[] } {
  switch (type) {
    case 'orders':   return { rows: getOrdersDetail(db, outletId, from, to) };
    case 'customer': return { rows: getCustomerWiseSales(db, outletId, from, to) };
    case 'table':    return { rows: getTableWiseSales(db, outletId, from, to) };
    case 'item':     return { rows: getItemWiseSales(db, outletId, from, to) };
    case 'category': return { rows: getCategoryWiseSales(db, outletId, from, to) };
    case 'channel':  return { rows: getDineInVsParty(db, outletId, from, to) };
    case 'floor':    return { rows: getFloorWiseSales(db, outletId, from, to) };
    case 'kots':     return { rows: getKotReport(db, outletId, from, to) };
    default:         return { rows: [] };
  }
}
