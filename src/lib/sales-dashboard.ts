import type Database from 'better-sqlite3';

/**
 * Sales dashboard aggregations — the analytics behind /sales-dashboard.
 *
 * Everything is computed from the NATIVE POS tables (orders / order_items /
 * menu_items), never the imported `sales` recipe-cost table, so the numbers are
 * the ACTUAL charged amounts:
 *   gross          = Σ order.subtotal        (pre discount/charge/tax)
 *   discount       = Σ order.discount
 *   charges        = Σ order.service_charge
 *   tax            = Σ order.tax_total        (per-item GST, food 5% / liquor 0%)
 *   net            = Σ order.total            (what was collected)
 *   netBeforeTax   = net − tax               (= subtotal + charge − discount)
 *
 * Only status='settled' rows count as sales; 'void' rows are the cancel breakup.
 * All date filtering is by IST calendar day (settled_at/voided_at are UTC in the
 * DB → shift +330 minutes before date()). MTD = first-of-month(to) … to.
 */

const IST = "'+330 minutes'";

export interface OrderTotals {
  gross: number; discount: number; charges: number;
  netBeforeTax: number; tax: number; net: number; orders: number;
}
export interface PerfMetrics {
  orders: number; avgOrderValue: number; avgOrderTimeMin: number;
  covers: number; avgPerCover: number;
}
export interface Bucket { label: string; amount: number; count: number; pct: number }
export interface ItemTypeRow { type: string; amount: number; pct: number }

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** First day of the calendar month that `to` (YYYY-MM-DD) falls in. */
export function monthStart(to: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(to) ? to.slice(0, 8) + '01' : to;
}

/** Settled-order money totals for an IST date range [from,to] inclusive. */
function orderTotals(db: Database.Database, outletId: string | null, from: string, to: string): OrderTotals {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(subtotal), 0)       AS gross,
      COALESCE(SUM(discount), 0)       AS discount,
      COALESCE(SUM(service_charge), 0) AS charges,
      COALESCE(SUM(tax_total), 0)      AS tax,
      COALESCE(SUM(total), 0)          AS net,
      COUNT(*)                         AS orders
    FROM orders
    WHERE status = 'settled' AND (outlet_id = ? OR outlet_id IS NULL)
      AND date(settled_at, ${IST}) BETWEEN ? AND ?
  `).get(outletId, from, to) as any;
  const gross = r2(row.gross), tax = r2(row.tax), net = r2(row.net);
  return {
    gross, discount: r2(row.discount), charges: r2(row.charges),
    tax, net, netBeforeTax: r2(net - tax), orders: Number(row.orders) || 0,
  };
}

/** Avg order value/time, covers, per-cover cost for settled orders in a range. */
function perf(db: Database.Database, outletId: string | null, from: string, to: string): PerfMetrics {
  const row = db.prepare(`
    SELECT
      COUNT(*)                     AS orders,
      COALESCE(SUM(total), 0)      AS net,
      COALESCE(SUM(covers), 0)     AS covers,
      COALESCE(AVG(CASE WHEN settled_at IS NOT NULL AND created_at IS NOT NULL
        THEN (julianday(settled_at) - julianday(created_at)) * 1440.0 END), 0) AS avg_min
    FROM orders
    WHERE status = 'settled' AND (outlet_id = ? OR outlet_id IS NULL)
      AND date(settled_at, ${IST}) BETWEEN ? AND ?
  `).get(outletId, from, to) as any;
  const orders = Number(row.orders) || 0;
  const net = r2(row.net);
  const covers = Number(row.covers) || 0;
  return {
    orders,
    avgOrderValue: orders ? r2(net / orders) : 0,
    avgOrderTimeMin: Math.max(0, Math.round(Number(row.avg_min) || 0)),
    covers,
    avgPerCover: covers ? r2(net / covers) : 0,
  };
}

function withPct(rows: { label: string; amount: number; count: number }[]): Bucket[] {
  const total = rows.reduce((s, x) => s + (x.amount || 0), 0);
  return rows.map((x) => ({ ...x, amount: r2(x.amount), pct: total ? r2((x.amount / total) * 100) : 0 }));
}

/** Sales split by menu item_type (Foods/Liquors/Beverages) + a Charges row. */
function itemTypes(db: Database.Database, outletId: string | null, from: string, to: string, charges: number): ItemTypeRow[] {
  // trim '. ' normalises the dirty 'beverages.' value; unknown/NULL → Foods.
  const rows = db.prepare(`
    SELECT
      CASE
        WHEN lower(trim(mi.item_type, '. ')) = 'liquors'   THEN 'Liquors'
        WHEN lower(trim(mi.item_type, '. ')) = 'beverages' THEN 'Beverages'
        ELSE 'Foods'
      END AS type,
      COALESCE(SUM(oi.line_total), 0) AS amount
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE o.status = 'settled' AND (o.outlet_id = ? OR o.outlet_id IS NULL)
      AND date(o.settled_at, ${IST}) BETWEEN ? AND ?
    GROUP BY type
  `).all(outletId, from, to) as any[];
  const map = new Map<string, number>([['Foods', 0], ['Beverages', 0], ['Liquors', 0]]);
  for (const x of rows) map.set(x.type, r2(x.amount));
  const out = [
    { type: 'Foods', amount: map.get('Foods') || 0 },
    { type: 'Beverages', amount: map.get('Beverages') || 0 },
    { type: 'Liquors', amount: map.get('Liquors') || 0 },
    { type: 'Charges', amount: r2(charges) },
  ];
  const total = out.reduce((s, x) => s + x.amount, 0);
  return out.map((x) => ({ ...x, pct: total ? r2((x.amount / total) * 100) : 0 }));
}

export interface SalesDashboard {
  range: { from: string; to: string; monthFrom: string };
  day: OrderTotals;
  mtd: OrderTotals;
  itemTypesDay: ItemTypeRow[];
  itemTypesMtd: ItemTypeRow[];
  performanceDay: PerfMetrics;
  performanceMtd: PerfMetrics;
  collectionByBusiness: Bucket[];
  bySession: Bucket[];
  byPaymentCategory: Bucket[];
  byPaymentStatus: { sales: number; refund: number; cancelled: { amount: number; count: number } };
  cancelBreakup: { itemCancel: { amount: number; count: number }; orderCancel: { amount: number; count: number } };
  floorPnl: FloorPnl[];
}

export interface FloorPnl { floor: string; sales: number; cost: number; grossProfit: number; gpPct: number; orders: number }

/**
 * Per-floor profit & loss for the range: menu SALES vs food COST (COGS) → gross
 * profit, grouped by the table's zone. Revenue + cost come from the `sales`
 * item-fact table (total_revenue / total_cost) joined to the order's table zone;
 * only 'normal' bill types count (NC/comp excluded). Sales with no order/table
 * (imports, parcels) fall into an 'Other'/'Takeaway/Delivery' bucket so the
 * totals still reconcile. sales.date is already the IST settle day.
 */
export function getFloorPnl(
  db: Database.Database, outletId: string | null, from: string, to: string,
): FloorPnl[] {
  const rows = db.prepare(`
    SELECT
      COALESCE(NULLIF(TRIM(rt.zone), ''),
        CASE WHEN o.id IS NULL THEN 'Other'
             WHEN o.order_type = 'dine-in' THEN 'Unassigned'
             ELSE 'Takeaway/Delivery' END) AS floor,
      COALESCE(SUM(s.total_revenue), 0) AS sales,
      COALESCE(SUM(s.total_cost), 0)    AS cost,
      COUNT(DISTINCT s.order_id)        AS orders
    FROM sales s
    LEFT JOIN orders o ON o.id = s.order_id
    LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
    WHERE s.date BETWEEN ? AND ? AND (s.outlet_id = ? OR s.outlet_id IS NULL)
      AND COALESCE(s.bill_type, 'normal') = 'normal'
    GROUP BY floor
    ORDER BY sales DESC
  `).all(from, to, outletId) as any[];
  return rows.map((r) => {
    const sales = r2(r.sales), cost = r2(r.cost);
    const gp = r2(sales - cost);
    return { floor: String(r.floor), sales, cost, grossProfit: gp, gpPct: sales ? r2((gp / sales) * 100) : 0, orders: Number(r.orders) || 0 };
  });
}

export interface TableSalesRow {
  table_id: string; table_number: string; floor: string; section: string;
  orders: number; covers: number; sales: number;
}

/**
 * Table-wise SETTLED sales for the range (management-only export). One row per
 * table: paid bills, covers and revenue (bill total). Grouped by table, so a
 * manager can see which tables earn most. Only settled, normal (non-party) bills.
 */
export function getTableWiseSales(
  db: Database.Database, outletId: string | null, from: string, to: string,
): TableSalesRow[] {
  const rows = db.prepare(`
    SELECT
      rt.id AS table_id,
      rt.table_number AS table_number,
      COALESCE(NULLIF(TRIM(rt.zone), ''), '—') AS floor,
      COALESCE(rt.section, '') AS section,
      COUNT(*) AS orders,
      SUM(COALESCE(o.covers, 0)) AS covers,
      SUM(COALESCE(o.total, 0)) AS sales
    FROM orders o
    JOIN restaurant_tables rt ON rt.id = o.table_id
    WHERE o.status = 'settled'
      AND date(o.settled_at, '+330 minutes') BETWEEN ? AND ?
      AND (o.outlet_id = ? OR o.outlet_id IS NULL)
      AND COALESCE(o.bill_type, 'normal') = 'normal'
    GROUP BY rt.id
    ORDER BY sales DESC
  `).all(from, to, outletId) as any[];
  return rows.map((r) => ({
    table_id: String(r.table_id),
    table_number: String(r.table_number),
    floor: String(r.floor),
    section: String(r.section || ''),
    orders: Number(r.orders) || 0,
    covers: Number(r.covers) || 0,
    sales: r2(r.sales),
  }));
}

export interface ItemWiseRow { name: string; type: string; qty: number; amount: number }

/** Per-item settled-sales for the range (Item-wise Sales tab). */
export function getItemWiseSales(
  db: Database.Database, outletId: string | null, from: string, to: string,
): ItemWiseRow[] {
  const rows = db.prepare(`
    SELECT oi.name AS name,
      CASE
        WHEN lower(trim(mi.item_type, '. ')) = 'liquors'   THEN 'Liquors'
        WHEN lower(trim(mi.item_type, '. ')) = 'beverages' THEN 'Beverages'
        ELSE 'Foods'
      END AS type,
      COALESCE(SUM(oi.quantity), 0)   AS qty,
      COALESCE(SUM(oi.line_total), 0) AS amount
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE o.status = 'settled' AND (o.outlet_id = ? OR o.outlet_id IS NULL)
      AND date(o.settled_at, ${IST}) BETWEEN ? AND ?
      AND COALESCE(o.bill_type, 'normal') = 'normal'
    GROUP BY oi.name, type
    ORDER BY amount DESC
  `).all(outletId, from, to) as any[];
  return rows.map((x) => ({ name: x.name, type: x.type, qty: r2(x.qty), amount: r2(x.amount) }));
}

export function getSalesDashboard(
  db: Database.Database, outletId: string | null, from: string, to: string,
): SalesDashboard {
  const mFrom = monthStart(to);
  const day = orderTotals(db, outletId, from, to);
  const mtd = orderTotals(db, outletId, mFrom, to);

  // Collection by business line (dine-in / takeaway / delivery), selected range.
  const biz = db.prepare(`
    SELECT COALESCE(NULLIF(order_type, ''), 'dine-in') AS label,
           COALESCE(SUM(total), 0) AS amount, COUNT(*) AS count
    FROM orders WHERE status = 'settled' AND (outlet_id = ? OR outlet_id IS NULL)
      AND date(settled_at, ${IST}) BETWEEN ? AND ?
    GROUP BY label ORDER BY amount DESC
  `).all(outletId, from, to) as any[];

  // By session — lunch (< 17:00 IST) vs evening.
  const sess = db.prepare(`
    SELECT CASE WHEN CAST(strftime('%H', settled_at, ${IST}) AS INTEGER) < 17
                THEN 'Lunch' ELSE 'Evening' END AS label,
           COALESCE(SUM(total), 0) AS amount, COUNT(*) AS count
    FROM orders WHERE status = 'settled' AND (outlet_id = ? OR outlet_id IS NULL)
      AND date(settled_at, ${IST}) BETWEEN ? AND ?
    GROUP BY label
  `).all(outletId, from, to) as any[];

  // By payment category (method). Split payments (order_payments) take precedence
  // when present; otherwise fall back to the single orders.payment_method.
  const hasPayTable = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='order_payments'"
  ).get();
  let pay: any[];
  if (hasPayTable) {
    pay = db.prepare(`
      SELECT COALESCE(NULLIF(p.method, ''), 'other') AS label,
             COALESCE(SUM(p.amount), 0) AS amount, COUNT(DISTINCT p.order_id) AS count
      FROM order_payments p JOIN orders o ON o.id = p.order_id
      WHERE o.status = 'settled' AND (o.outlet_id = ? OR o.outlet_id IS NULL)
        AND date(o.settled_at, ${IST}) BETWEEN ? AND ?
      GROUP BY label ORDER BY amount DESC
    `).all(outletId, from, to) as any[];
  } else {
    pay = db.prepare(`
      SELECT COALESCE(NULLIF(payment_method, ''), 'other') AS label,
             COALESCE(SUM(total), 0) AS amount, COUNT(*) AS count
      FROM orders WHERE status = 'settled' AND (outlet_id = ? OR outlet_id IS NULL)
        AND date(settled_at, ${IST}) BETWEEN ? AND ?
      GROUP BY label ORDER BY amount DESC
    `).all(outletId, from, to) as any[];
  }

  // Cancel breakup — order cancel = voided orders in range (by IST void day).
  const orderCancel = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS amount
    FROM orders WHERE status = 'void' AND (outlet_id = ? OR outlet_id IS NULL)
      AND date(COALESCE(voided_at, updated_at), ${IST}) BETWEEN ? AND ?
  `).get(outletId, from, to) as any;

  return {
    range: { from, to, monthFrom: mFrom },
    day, mtd,
    itemTypesDay: itemTypes(db, outletId, from, to, day.charges),
    itemTypesMtd: itemTypes(db, outletId, mFrom, to, mtd.charges),
    performanceDay: perf(db, outletId, from, to),
    performanceMtd: perf(db, outletId, mFrom, to),
    collectionByBusiness: withPct(biz.map((x) => ({ label: x.label, amount: r2(x.amount), count: Number(x.count) || 0 }))),
    bySession: withPct(sess.map((x) => ({ label: x.label, amount: r2(x.amount), count: Number(x.count) || 0 }))),
    byPaymentCategory: withPct(pay.map((x) => ({ label: x.label, amount: r2(x.amount), count: Number(x.count) || 0 }))),
    byPaymentStatus: {
      sales: day.net,
      refund: 0,
      cancelled: { amount: r2(orderCancel.amount), count: Number(orderCancel.count) || 0 },
    },
    cancelBreakup: {
      itemCancel: { amount: 0, count: 0 }, // no per-item cancel log today; order-level below
      orderCancel: { amount: r2(orderCancel.amount), count: Number(orderCancel.count) || 0 },
    },
    floorPnl: getFloorPnl(db, outletId, from, to),
  };
}
