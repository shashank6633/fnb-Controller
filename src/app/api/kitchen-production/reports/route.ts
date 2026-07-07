import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { parseDateTime, expiryStatus, batchAgeHours, shelfLifeRemaining } from '@/lib/production-batch';

/**
 * GET /api/kitchen-production/reports?type=<t>&from=YYYY-MM-DD&to=YYYY-MM-DD
 *   → { type, columns: [ <header keys> ], rows: [ { …keyed by column } ] }
 *
 * `columns` is the ordered list of keys present on each row — the client uses it
 * as the header order for xlsx / print export.
 *
 * Supported types:
 *   production          batches produced in range (production_date)
 *   fifo-consumption    'consumed' tx joined to their batch (created_at)
 *   batch-history       every batch_transaction joined to its batch (created_at)
 *   scan-history        'scanned' tx (created_at)
 *   expiry              batches expired / past-expiry in range (expiry_date)
 *   waste               'wasted'+'disposed' tx, costed when material-linked (created_at)
 *   daily-production    production_date rollup
 *   monthly-production  YYYY-MM rollup of production_date
 *   cost-analysis       batches × material avg_price (production_date; skips uncosted)
 *   inventory-ageing    ACTIVE batches bucketed by age (current-state, ignores range)
 *   near-expiry         ACTIVE batches expiring ≤7d (current-state, ignores range)
 *
 * Ranges are inclusive; tx-based reports match on the IST calendar day of
 * created_at (stored UTC → shifted +5:30). getCurrentUser gate; outlet-scoped.
 */
export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const url = new URL(request.url);
    const type = (url.searchParams.get('type') || 'production').toLowerCase();
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();

    const db = getDb();
    const outletId = await getCurrentOutletId();

    // Outlet scoping — `a` = table alias carrying outlet_id (batch or tx row).
    const outletFrag = (alias: string) =>
      outletId ? `AND (${alias}.outlet_id = ? OR ${alias}.outlet_id IS NULL)` : '';
    const outletParams: any[] = outletId ? [outletId] : [];

    const istDay = (col: string) => `date(${col}, '+5 hours', '+30 minutes')`;
    const remainingExpr = 'MAX(0, b.quantity_produced - b.quantity_consumed)';

    let columns: string[] = [];
    let rows: any[] = [];

    // Helper: build a date-range WHERE fragment on a plain date column.
    const dateRange = (col: string) => {
      const parts: string[] = [];
      const p: any[] = [];
      if (from) { parts.push(`${col} >= ?`); p.push(from); }
      if (to) { parts.push(`${col} <= ?`); p.push(to); }
      return { sql: parts.length ? 'AND ' + parts.join(' AND ') : '', params: p };
    };

    switch (type) {
      case 'production': {
        columns = ['batch_number', 'item_name', 'category', 'production_date', 'production_time',
          'expiry_date', 'expiry_time', 'quantity_produced', 'quantity_consumed', 'remaining',
          'unit', 'prepared_by', 'kitchen_section', 'storage_location', 'status'];
        const dr = dateRange('b.production_date');
        rows = db.prepare(
          `SELECT b.batch_number, b.item_name, b.category, b.production_date, b.production_time,
                  b.expiry_date, b.expiry_time, b.quantity_produced, b.quantity_consumed,
                  ${remainingExpr} AS remaining, b.unit, b.prepared_by, b.kitchen_section,
                  b.storage_location, b.status
             FROM production_batches b
            WHERE 1=1 ${dr.sql} ${outletFrag('b')}
            ORDER BY b.production_date DESC, b.production_time DESC`
        ).all(...dr.params, ...outletParams);
        break;
      }

      case 'fifo-consumption': {
        columns = ['date', 'batch_number', 'item_name', 'quantity', 'balance_quantity', 'unit',
          'user', 'department', 'production_date', 'expiry_date'];
        const dr = dateRange(istDay('t.created_at'));
        rows = db.prepare(
          `SELECT t.created_at AS date, b.batch_number, b.item_name, t.quantity, t.balance_quantity,
                  b.unit, t.user, t.department, b.production_date, b.expiry_date
             FROM batch_transactions t
             JOIN production_batches b ON b.id = t.batch_id
            WHERE t.type = 'consumed' ${dr.sql} ${outletFrag('t')}
            ORDER BY t.created_at DESC`
        ).all(...dr.params, ...outletParams);
        break;
      }

      case 'batch-history': {
        columns = ['date', 'type', 'batch_number', 'item_name', 'quantity', 'balance_quantity',
          'unit', 'user', 'department', 'remarks'];
        const dr = dateRange(istDay('t.created_at'));
        rows = db.prepare(
          `SELECT t.created_at AS date, t.type, b.batch_number, b.item_name, t.quantity,
                  t.balance_quantity, b.unit, t.user, t.department, t.remarks
             FROM batch_transactions t
             JOIN production_batches b ON b.id = t.batch_id
            WHERE 1=1 ${dr.sql} ${outletFrag('t')}
            ORDER BY t.created_at DESC`
        ).all(...dr.params, ...outletParams);
        break;
      }

      case 'scan-history': {
        columns = ['date', 'batch_number', 'item_name', 'balance_quantity', 'unit', 'user',
          'department', 'remarks'];
        const dr = dateRange(istDay('t.created_at'));
        rows = db.prepare(
          `SELECT t.created_at AS date, b.batch_number, b.item_name, t.balance_quantity, b.unit,
                  t.user, t.department, t.remarks
             FROM batch_transactions t
             JOIN production_batches b ON b.id = t.batch_id
            WHERE t.type = 'scanned' ${dr.sql} ${outletFrag('t')}
            ORDER BY t.created_at DESC`
        ).all(...dr.params, ...outletParams);
        break;
      }

      case 'expiry': {
        columns = ['batch_number', 'item_name', 'category', 'expiry_date', 'expiry_time',
          'quantity_produced', 'quantity_consumed', 'remaining', 'unit', 'status'];
        const dr = dateRange('b.expiry_date');
        // Expired batches, or any batch whose expiry date has passed.
        rows = db.prepare(
          `SELECT b.batch_number, b.item_name, b.category, b.expiry_date, b.expiry_time,
                  b.quantity_produced, b.quantity_consumed, ${remainingExpr} AS remaining,
                  b.unit, b.status
             FROM production_batches b
            WHERE (b.status = 'expired' OR (b.expiry_date != '' AND b.expiry_date < date('now', '+5 hours', '+30 minutes')))
              ${dr.sql} ${outletFrag('b')}
            ORDER BY b.expiry_date DESC, b.expiry_time DESC`
        ).all(...dr.params, ...outletParams);
        break;
      }

      case 'waste': {
        columns = ['date', 'type', 'batch_number', 'item_name', 'quantity', 'unit', 'avg_price',
          'est_cost', 'user', 'department', 'remarks'];
        const dr = dateRange(istDay('t.created_at'));
        const raw = db.prepare(
          `SELECT t.created_at AS date, t.type, b.batch_number, b.item_name, t.quantity, b.unit,
                  t.user, t.department, t.remarks, rm.average_price AS avg_price
             FROM batch_transactions t
             JOIN production_batches b ON b.id = t.batch_id
             LEFT JOIN raw_materials rm ON rm.id = b.material_id
            WHERE t.type IN ('wasted','disposed') ${dr.sql} ${outletFrag('t')}
            ORDER BY t.created_at DESC`
        ).all(...dr.params, ...outletParams) as any[];
        rows = raw.map((r) => ({
          ...r,
          avg_price: r.avg_price != null ? r.avg_price : '',
          est_cost: r.avg_price != null ? Math.round(Number(r.quantity) * Number(r.avg_price) * 100) / 100 : '',
        }));
        break;
      }

      case 'daily-production': {
        columns = ['production_date', 'batches', 'total_produced', 'total_consumed', 'total_remaining'];
        const dr = dateRange('b.production_date');
        rows = db.prepare(
          `SELECT b.production_date, COUNT(*) AS batches,
                  COALESCE(SUM(b.quantity_produced),0) AS total_produced,
                  COALESCE(SUM(b.quantity_consumed),0) AS total_consumed,
                  COALESCE(SUM(${remainingExpr}),0) AS total_remaining
             FROM production_batches b
            WHERE b.production_date != '' ${dr.sql} ${outletFrag('b')}
            GROUP BY b.production_date
            ORDER BY b.production_date DESC`
        ).all(...dr.params, ...outletParams);
        break;
      }

      case 'monthly-production': {
        columns = ['month', 'batches', 'total_produced', 'total_consumed', 'total_remaining'];
        const dr = dateRange('b.production_date');
        rows = db.prepare(
          `SELECT SUBSTR(b.production_date, 1, 7) AS month, COUNT(*) AS batches,
                  COALESCE(SUM(b.quantity_produced),0) AS total_produced,
                  COALESCE(SUM(b.quantity_consumed),0) AS total_consumed,
                  COALESCE(SUM(${remainingExpr}),0) AS total_remaining
             FROM production_batches b
            WHERE b.production_date != '' ${dr.sql} ${outletFrag('b')}
            GROUP BY month
            ORDER BY month DESC`
        ).all(...dr.params, ...outletParams);
        break;
      }

      case 'cost-analysis': {
        columns = ['batch_number', 'item_name', 'production_date', 'quantity_produced',
          'quantity_consumed', 'unit', 'avg_price', 'est_cost'];
        const dr = dateRange('b.production_date');
        // Only material-linked batches carry a cost; uncosted ones are skipped.
        rows = (db.prepare(
          `SELECT b.batch_number, b.item_name, b.production_date, b.quantity_produced,
                  b.quantity_consumed, b.unit, rm.average_price AS avg_price
             FROM production_batches b
             JOIN raw_materials rm ON rm.id = b.material_id
            WHERE 1=1 ${dr.sql} ${outletFrag('b')}
            ORDER BY b.production_date DESC`
        ).all(...dr.params, ...outletParams) as any[]).map((r) => ({
          ...r,
          avg_price: r.avg_price,
          est_cost: Math.round(Number(r.quantity_produced) * Number(r.avg_price) * 100) / 100,
        }));
        break;
      }

      case 'inventory-ageing': {
        columns = ['batch_number', 'item_name', 'category', 'production_date', 'production_time',
          'age_hours', 'age_bucket', 'remaining', 'unit', 'expiry_status'];
        const raw = db.prepare(
          `SELECT b.batch_number, b.item_name, b.category, b.production_date, b.production_time,
                  b.expiry_date, b.expiry_time, ${remainingExpr} AS remaining, b.unit
             FROM production_batches b
            WHERE b.status = 'active' ${outletFrag('b')}
            ORDER BY b.production_date ASC, b.production_time ASC`
        ).all(...outletParams) as any[];
        const now = new Date();
        const bucket = (h: number) =>
          h < 24 ? '0-24h' : h < 48 ? '24-48h' : h < 72 ? '48-72h' : h < 168 ? '3-7d' : '7d+';
        rows = raw.map((r) => {
          const age = batchAgeHours(r.production_date, r.production_time, now);
          return {
            batch_number: r.batch_number,
            item_name: r.item_name,
            category: r.category,
            production_date: r.production_date,
            production_time: r.production_time,
            age_hours: age,
            age_bucket: bucket(age),
            remaining: r.remaining,
            unit: r.unit,
            expiry_status: expiryStatus(r.expiry_date, r.expiry_time, now),
          };
        });
        break;
      }

      case 'near-expiry': {
        columns = ['batch_number', 'item_name', 'category', 'expiry_date', 'expiry_time',
          'shelf_life_remaining', 'remaining', 'unit', 'expiry_status'];
        const raw = db.prepare(
          `SELECT b.batch_number, b.item_name, b.category, b.expiry_date, b.expiry_time,
                  ${remainingExpr} AS remaining, b.unit
             FROM production_batches b
            WHERE b.status = 'active' AND b.expiry_date != '' ${outletFrag('b')}
            ORDER BY b.expiry_date ASC, b.expiry_time ASC`
        ).all(...outletParams) as any[];
        const now = new Date();
        const horizon = now.getTime() + 7 * 24 * 3600 * 1000;
        rows = raw
          .filter((r) => {
            const exp = parseDateTime(r.expiry_date, r.expiry_time);
            return exp && exp.getTime() <= horizon;
          })
          .map((r) => ({
            batch_number: r.batch_number,
            item_name: r.item_name,
            category: r.category,
            expiry_date: r.expiry_date,
            expiry_time: r.expiry_time,
            shelf_life_remaining: shelfLifeRemaining(r.expiry_date, r.expiry_time, now),
            remaining: r.remaining,
            unit: r.unit,
            expiry_status: expiryStatus(r.expiry_date, r.expiry_time, now),
          }));
        break;
      }

      default:
        return Response.json({ error: `Unknown report type: ${type}` }, { status: 400 });
    }

    return Response.json({ type, columns, rows });
  } catch (e: any) {
    console.error('GET /api/kitchen-production/reports failed:', e);
    return Response.json({ error: e?.message || 'Failed to build report' }, { status: 500 });
  }
}
