/**
 * KOT DETAILS report — one row per ITEM per KOT (item-level).
 *
 * Ranged on kots.created_at (the fire/sent time, IST) so KOTs belonging to
 * still-OPEN orders are included (this is NOT a settled-sales report). Each
 * order_item that has been fired carries a kot_id; we join it back to its KOT
 * and parent order to lay out order context + per-item kitchen timeline.
 *
 * Outlet scope is the lenient way the rest of the app is (order's outlet OR
 * legacy NULL). Read-only.
 *
 * Data notes (columns left blank because we don't track the fact):
 *  - Item Ready Time   — we don't record a per-item "ready" moment separately
 *                        (KOT status bumps to 'ready' at the ticket level, not
 *                        stamped onto the line), so this is always ''.
 *  - Item Cancel Time  — order_items has no cancelled status/void timestamp
 *                        (status is only new|preparing|ready|served), so ''.
 */
import type Database from 'better-sqlite3';

const IST = "'+330 minutes'";

export interface Row {
  order_datetime: string;   // orders.created_at (order placed) — date
  order_type: string;       // Dine-in | Takeaway | Delivery | Other
  table_label: string;      // 'Table 5' | Takeaway | Delivery | —
  order_number: number;     // orders.order_number (Order ID)
  kot_number: number;       // kots.kot_number
  station: string;          // kots.station or order_items.station
  item_name: string;        // order_items.name
  quantity: number;         // order_items.quantity
  item_status: string;      // order_items.status (Pending | Served | …)
  kot_sent_at: string;      // kots.created_at (KOT fired) — date
  item_ready_at: string;    // no data — always '' (date)
  item_complete_at: string; // order_items.completed_at — date
  item_cancel_at: string;   // no data — always '' (date)
}

export const COLUMNS: { k: string; label: string; num?: boolean; money?: boolean; pct?: boolean; date?: boolean; wide?: boolean }[] = [
  { k: 'order_datetime',   label: 'Order Date & Time', date: true },
  { k: 'order_type',       label: 'Order Type' },
  { k: 'table_label',      label: 'Table' },
  { k: 'order_number',     label: 'Order ID' },
  { k: 'kot_number',       label: 'KOT No' },
  { k: 'station',          label: 'Station' },
  { k: 'item_name',        label: 'Item Name', wide: true },
  { k: 'quantity',         label: 'Qty', num: true },
  { k: 'item_status',      label: 'Item Status' },
  { k: 'kot_sent_at',      label: 'KOT Sent Time', date: true },
  { k: 'item_ready_at',    label: 'Item Ready Time', date: true },
  { k: 'item_complete_at', label: 'Item Complete Time', date: true },
  { k: 'item_cancel_at',   label: 'Item Cancel Time', date: true },
];

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function run(db: Database.Database, outletId: string | null, from: string, to: string): Row[] {
  const rows = db.prepare(`
    SELECT
      o.created_at AS order_datetime,
      CASE lower(COALESCE(NULLIF(TRIM(o.order_type), ''), 'dine-in'))
        WHEN 'dine-in'  THEN 'Dine-in'
        WHEN 'takeaway' THEN 'Takeaway'
        WHEN 'delivery' THEN 'Delivery'
        ELSE 'Other' END AS order_type,
      CASE WHEN o.table_id IS NOT NULL AND rt.table_number IS NOT NULL THEN 'Table ' || rt.table_number
           WHEN lower(COALESCE(o.order_type, 'dine-in')) = 'takeaway' THEN 'Takeaway'
           WHEN lower(COALESCE(o.order_type, 'dine-in')) = 'delivery' THEN 'Delivery'
           ELSE '—' END AS table_label,
      o.order_number AS order_number,
      k.kot_number AS kot_number,
      COALESCE(NULLIF(TRIM(k.station), ''), NULLIF(TRIM(oi.station), ''), 'kitchen') AS station,
      oi.name AS item_name,
      COALESCE(oi.quantity, 0) AS quantity,
      COALESCE(NULLIF(TRIM(oi.status), ''), 'pending') AS item_status,
      k.created_at AS kot_sent_at,
      oi.completed_at AS item_complete_at
    FROM order_items oi
    JOIN kots k   ON k.id = oi.kot_id
    JOIN orders o ON o.id = k.order_id
    LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
    WHERE date(k.created_at, ${IST}) BETWEEN ? AND ?
      AND (o.outlet_id = ? OR o.outlet_id IS NULL)
    ORDER BY k.created_at DESC
  `).all(from, to, outletId) as any[];

  return rows.map((r) => ({
    order_datetime: String(r.order_datetime || ''),
    order_type: String(r.order_type || 'Other'),
    table_label: String(r.table_label || '—'),
    order_number: Number(r.order_number) || 0,
    kot_number: Number(r.kot_number) || 0,
    station: cap(String(r.station || 'kitchen')),
    item_name: String(r.item_name || ''),
    quantity: Number(r.quantity) || 0,
    item_status: cap(String(r.item_status || 'pending')),
    kot_sent_at: String(r.kot_sent_at || ''),
    item_ready_at: '',                                   // no data (see file header)
    item_complete_at: String(r.item_complete_at || ''),
    item_cancel_at: '',                                  // no data (see file header)
  }));
}
