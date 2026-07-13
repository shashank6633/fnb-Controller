import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, storeStock, userStoreAccess } from '@/lib/store-engine';

/**
 * GET /api/stores/[id]/reports?type=…&from=&to=&days= — store-scoped reports
 * (Phase D, spec F8). Gate: userStoreAccess(...).can_view. Everything reads
 * ONLY store_stock_ledger / store_closing_counts / audit_events(store.*) for
 * THIS store — zero interaction with central inventory or /closing-stock.
 *
 * Types:
 *   current_stock — qty + valuation by material
 *   ledger        — stock ledger with per-material running balance (ASC)
 *   purchases     — purchase register (date/material/qty/cost/supplier/vendor/invoice)
 *   movement      — in/out/adjust totals per material (+opening/closing balance)
 *   daily_closing — closing counts + variances by date
 *   valuation     — category-wise qty + value + totals
 *   low_stock     — vs raw_materials.reorder_level
 *   dead_stock    — stocked but no outward txn in N days (?days=, default 30)
 *   supplier      — supplier-wise purchase totals
 *   category      — category-wise inventory listing (per material)
 *   audit         — audit_events store.* for this store + closing history
 *
 * All aggregation in SQL (COUNT/SUM), rows capped, no NaN (Number()||0).
 */
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROW_CAP = 1000;

const REPORT_TYPES = [
  'current_stock', 'ledger', 'purchases', 'movement', 'daily_closing',
  'valuation', 'low_stock', 'dead_stock', 'supplier', 'category', 'audit',
] as const;
type ReportType = (typeof REPORT_TYPES)[number];

const n = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (v: any) => Math.round(n(v) * 100) / 100;
const r3 = (v: any) => Math.round(n(v) * 1000) / 1000;
const r4 = (v: any) => Math.round(n(v) * 10000) / 10000;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id: storeId } = await params;
    const db = getDb();

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });

    const access = userStoreAccess(db, user, storeId);
    if (!access.can_view) {
      return Response.json({ error: `You are not authorized to view ${store.name}` }, { status: 403 });
    }

    const url = new URL(request.url);
    const type = (url.searchParams.get('type') || '').trim() as ReportType;
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    const days = Math.min(Math.max(Math.round(n(url.searchParams.get('days')) || 30), 1), 365);

    if (!REPORT_TYPES.includes(type)) {
      return Response.json({ error: `type must be one of: ${REPORT_TYPES.join(', ')}` }, { status: 400 });
    }
    if (from && !DATE_RE.test(from)) return Response.json({ error: 'from must be YYYY-MM-DD' }, { status: 400 });
    if (to && !DATE_RE.test(to)) return Response.json({ error: 'to must be YYYY-MM-DD' }, { status: 400 });

    // Shared window clauses on ledger created_at.
    const winWhere: string[] = [];
    const winArgs: any[] = [];
    if (from) { winWhere.push('date(l.created_at) >= date(?)'); winArgs.push(from); }
    if (to)   { winWhere.push('date(l.created_at) <= date(?)'); winArgs.push(to); }
    const win = winWhere.length ? ` AND ${winWhere.join(' AND ')}` : '';

    /** Enriched current stock (engine rows + sku/pack/reorder meta). */
    const stockRows = () => {
      const base = storeStock(db, storeId);
      const meta = new Map<string, any>();
      for (const m of db.prepare(`
        SELECT rm.id, rm.sku, rm.purchase_unit, rm.pack_size, rm.reorder_level
        FROM raw_materials rm
        JOIN store_category_map scm
          ON scm.store_id = ? AND TRIM(scm.category) = TRIM(rm.category) COLLATE NOCASE
      `).all(storeId) as any[]) meta.set(m.id, m);
      return base.map(r => {
        const m = meta.get(r.material_id) || {};
        const pack = n(m.pack_size) || 1;
        const pu = m.purchase_unit || r.unit;
        const pc = (pack > 1 && String(pu).toLowerCase().trim() !== String(r.unit).toLowerCase().trim()) ? pack : 1;
        return {
          material_id: r.material_id,
          material: r.material_name,
          sku: m.sku || '',
          category: r.category,
          qty: r3(r.qty),
          unit: r.unit,
          qty_purchase: pc > 1 ? r3(r.qty / pc) : r3(r.qty),
          purchase_unit: pu,
          avg_cost: r4(r.avg_cost),
          value: r2(r.value),
          reorder_level: n(m.reorder_level),
        };
      });
    };

    let rows: any[] = [];
    let totals: Record<string, number | string> = {};

    switch (type) {
      case 'current_stock': {
        rows = stockRows();
        totals = { items: rows.length, total_value: r2(rows.reduce((s, r) => s + n(r.value), 0)) };
        break;
      }

      case 'ledger': {
        // Opening balance per material BEFORE the window, then running balance ASC.
        const opening = new Map<string, number>();
        if (from) {
          for (const r of db.prepare(`
            SELECT material_id, SUM(quantity) AS qty FROM store_stock_ledger l
            WHERE l.store_id = ? AND date(l.created_at) < date(?)
            GROUP BY material_id
          `).all(storeId, from) as any[]) opening.set(r.material_id, n(r.qty));
        }
        const raw = db.prepare(`
          SELECT l.created_at, l.txn_type, l.material_id, l.quantity, l.unit_cost,
                 l.supplier, l.ref, l.notes, l.created_by,
                 rm.name AS material, rm.unit
          FROM store_stock_ledger l
          JOIN raw_materials rm ON rm.id = l.material_id
          WHERE l.store_id = ?${win}
          ORDER BY l.created_at ASC, l.rowid ASC
          LIMIT ${ROW_CAP}
        `).all(storeId, ...winArgs) as any[];
        const run = new Map<string, number>(opening);
        rows = raw.map(l => {
          const bal = r3((run.get(l.material_id) || 0) + n(l.quantity));
          run.set(l.material_id, bal);
          return {
            date: String(l.created_at).slice(0, 16),
            txn_type: l.txn_type,
            material: l.material,
            qty: r3(l.quantity),
            unit: l.unit,
            unit_cost: r4(l.unit_cost),
            running_balance: bal,
            supplier: l.supplier || '',
            ref: l.ref || '',
            notes: l.notes || '',
            by: (l.created_by || '').split('@')[0],
          };
        });
        totals = {
          rows: rows.length,
          in_qty: r3(rows.reduce((s, r) => s + (r.qty > 0 ? r.qty : 0), 0)),
          out_qty: r3(rows.reduce((s, r) => s + (r.qty < 0 ? -r.qty : 0), 0)),
        };
        break;
      }

      case 'purchases': {
        const raw = db.prepare(`
          SELECT l.created_at, l.quantity, l.unit_cost, l.supplier, l.vendor_id,
                 l.ref, l.batch_no, l.created_by,
                 rm.name AS material, rm.unit, rm.purchase_unit, rm.pack_size,
                 v.name AS vendor_name
          FROM store_stock_ledger l
          JOIN raw_materials rm ON rm.id = l.material_id
          LEFT JOIN vendors v ON v.id = l.vendor_id
          WHERE l.store_id = ? AND l.txn_type = 'purchase'${win}
          ORDER BY l.created_at ASC, l.rowid ASC
          LIMIT ${ROW_CAP}
        `).all(storeId, ...winArgs) as any[];
        rows = raw.map(l => {
          const pack = n(l.pack_size) || 1;
          const pu = l.purchase_unit || l.unit;
          const pc = (pack > 1 && String(pu).toLowerCase().trim() !== String(l.unit).toLowerCase().trim()) ? pack : 1;
          return {
            date: String(l.created_at).slice(0, 10),
            material: l.material,
            qty_purchase: r3(n(l.quantity) / pc),
            purchase_unit: pu,
            qty: r3(l.quantity),
            unit: l.unit,
            rate_purchase: r2(n(l.unit_cost) * pc),
            cost: r2(n(l.quantity) * n(l.unit_cost)),
            supplier: l.supplier || '',
            vendor: l.vendor_name || '',
            invoice: l.ref || '',
            batch: l.batch_no || '',
            by: (l.created_by || '').split('@')[0],
          };
        });
        totals = {
          purchases: rows.length,
          total_value: r2(rows.reduce((s, r) => s + n(r.cost), 0)),
        };
        break;
      }

      case 'movement': {
        const opening = new Map<string, number>();
        if (from) {
          for (const r of db.prepare(`
            SELECT material_id, SUM(quantity) AS qty FROM store_stock_ledger l
            WHERE l.store_id = ? AND date(l.created_at) < date(?)
            GROUP BY material_id
          `).all(storeId, from) as any[]) opening.set(r.material_id, n(r.qty));
        }
        const raw = db.prepare(`
          SELECT l.material_id, rm.name AS material, rm.unit,
                 SUM(CASE WHEN l.quantity > 0 THEN l.quantity ELSE 0 END)  AS in_qty,
                 SUM(CASE WHEN l.quantity < 0 THEN -l.quantity ELSE 0 END) AS out_qty,
                 SUM(CASE WHEN l.txn_type = 'adjustment' THEN l.quantity ELSE 0 END) AS adjust_qty,
                 SUM(l.quantity) AS net_qty
          FROM store_stock_ledger l
          JOIN raw_materials rm ON rm.id = l.material_id
          WHERE l.store_id = ?${win}
          GROUP BY l.material_id
          ORDER BY rm.name COLLATE NOCASE
          LIMIT ${ROW_CAP}
        `).all(storeId, ...winArgs) as any[];
        rows = raw.map(m => {
          const open = opening.get(m.material_id) || 0;
          return {
            material: m.material,
            unit: m.unit,
            opening: r3(open),
            in_qty: r3(m.in_qty),
            out_qty: r3(m.out_qty),
            adjust_qty: r3(m.adjust_qty),
            closing: r3(open + n(m.net_qty)),
          };
        });
        totals = {
          materials: rows.length,
          in_qty: r3(rows.reduce((s, r) => s + n(r.in_qty), 0)),
          out_qty: r3(rows.reduce((s, r) => s + n(r.out_qty), 0)),
        };
        break;
      }

      case 'daily_closing': {
        const cw: string[] = ['store_id = ?'];
        const ca: any[] = [storeId];
        if (from) { cw.push('date >= ?'); ca.push(from); }
        if (to)   { cw.push('date <= ?'); ca.push(to); }
        rows = (db.prepare(`
          SELECT date,
                 COUNT(*)                                      AS items,
                 SUM(CASE WHEN variance < 0 THEN 1 ELSE 0 END) AS shortages,
                 SUM(CASE WHEN variance > 0 THEN 1 ELSE 0 END) AS excesses,
                 SUM(variance_value)                           AS variance_value,
                 SUM(ABS(variance_value))                      AS abs_variance_value
          FROM store_closing_counts
          WHERE ${cw.join(' AND ')}
          GROUP BY date ORDER BY date DESC
          LIMIT ${ROW_CAP}
        `).all(...ca) as any[]).map(d => ({
          date: d.date,
          items: n(d.items),
          shortages: n(d.shortages),
          excesses: n(d.excesses),
          variance_value: r2(d.variance_value),
          abs_variance_value: r2(d.abs_variance_value),
        }));
        totals = {
          dates: rows.length,
          items: rows.reduce((s, r) => s + n(r.items), 0),
          variance_value: r2(rows.reduce((s, r) => s + n(r.variance_value), 0)),
        };
        break;
      }

      case 'valuation': {
        const all = stockRows();
        const byCat = new Map<string, { items: number; qty: number; value: number }>();
        for (const r of all) {
          const c = byCat.get(r.category) || { items: 0, qty: 0, value: 0 };
          c.items += 1; c.qty += n(r.qty); c.value += n(r.value);
          byCat.set(r.category, c);
        }
        rows = Array.from(byCat.entries())
          .map(([category, c]) => ({ category, items: c.items, qty: r3(c.qty), value: r2(c.value) }))
          .sort((a, b) => b.value - a.value);
        totals = {
          categories: rows.length,
          items: all.length,
          total_value: r2(all.reduce((s, r) => s + n(r.value), 0)),
        };
        break;
      }

      case 'low_stock': {
        rows = stockRows()
          .filter(r => r.reorder_level > 0 && r.qty < r.reorder_level)
          .map(r => ({
            material: r.material, category: r.category,
            qty: r.qty, unit: r.unit,
            reorder_level: r3(r.reorder_level),
            deficit: r3(r.reorder_level - r.qty),
            value: r.value,
          }));
        totals = { items: rows.length, total_value: r2(rows.reduce((s, r) => s + n(r.value), 0)) };
        break;
      }

      case 'dead_stock': {
        // Dead = stocked, no OUTWARD movement inside the window, AND no ledger
        // activity of any kind inside the window either — freshly-purchased
        // stock isn't "dead", it just hasn't had a chance to move yet.
        const lastOut = new Map<string, string>();
        for (const r of db.prepare(`
          SELECT material_id, MAX(created_at) AS last_out
          FROM store_stock_ledger
          WHERE store_id = ? AND quantity < 0
          GROUP BY material_id
        `).all(storeId) as any[]) lastOut.set(r.material_id, r.last_out);
        const lastAny = new Map<string, string>();
        for (const r of db.prepare(`
          SELECT material_id, MAX(created_at) AS last_any
          FROM store_stock_ledger
          WHERE store_id = ?
          GROUP BY material_id
        `).all(storeId) as any[]) lastAny.set(r.material_id, r.last_any);
        const cutoff = db.prepare(`SELECT date('now', ?) AS d`).get(`-${days} days`) as any;
        const cut = String(cutoff?.d || '');
        rows = stockRows()
          .filter(r => r.qty > 0)
          .filter(r => {
            const lo = lastOut.get(r.material_id);
            const la = lastAny.get(r.material_id);
            const outStale = !lo || String(lo).slice(0, 10) < cut;
            const anyStale = !la || String(la).slice(0, 10) < cut;
            return outStale && anyStale;
          })
          .map(r => ({
            material: r.material, category: r.category,
            qty: r.qty, unit: r.unit, value: r.value,
            last_outward: (lastOut.get(r.material_id) || '').slice(0, 10) || 'never',
          }));
        totals = {
          items: rows.length,
          total_value: r2(rows.reduce((s, r) => s + n(r.value), 0)),
          window_days: days,
        };
        break;
      }

      case 'supplier': {
        rows = (db.prepare(`
          SELECT COALESCE(NULLIF(TRIM(l.supplier), ''), '(unspecified)') AS supplier,
                 COUNT(*)                        AS purchases,
                 SUM(l.quantity)                 AS qty,
                 SUM(l.quantity * l.unit_cost)   AS total_value
          FROM store_stock_ledger l
          WHERE l.store_id = ? AND l.txn_type = 'purchase'${win}
          GROUP BY COALESCE(NULLIF(TRIM(l.supplier), ''), '(unspecified)')
          ORDER BY total_value DESC
          LIMIT ${ROW_CAP}
        `).all(storeId, ...winArgs) as any[]).map(s => ({
          supplier: s.supplier,
          purchases: n(s.purchases),
          qty: r3(s.qty),
          total_value: r2(s.total_value),
        }));
        totals = {
          suppliers: rows.length,
          purchases: rows.reduce((s, r) => s + n(r.purchases), 0),
          total_value: r2(rows.reduce((s, r) => s + n(r.total_value), 0)),
        };
        break;
      }

      case 'category': {
        rows = stockRows()
          .sort((a, b) => a.category.localeCompare(b.category) || a.material.localeCompare(b.material))
          .map(r => ({
            category: r.category, material: r.material, sku: r.sku,
            qty: r.qty, unit: r.unit,
            qty_purchase: r.qty_purchase, purchase_unit: r.purchase_unit,
            avg_cost: r.avg_cost, value: r.value,
          }));
        totals = { items: rows.length, total_value: r2(rows.reduce((s, r) => s + n(r.value), 0)) };
        break;
      }

      case 'audit': {
        // audit_events for this store (store.* events carry store_id in after_json)
        // + the closing-count history as first-class evidence rows.
        const aw: string[] = [`e.event_type LIKE 'store.%'`, `e.after_json LIKE ?`];
        const aa: any[] = [`%"store_id":"${storeId}"%`];
        if (from) { aw.push('date(e.created_at) >= date(?)'); aa.push(from); }
        if (to)   { aw.push('date(e.created_at) <= date(?)'); aa.push(to); }
        rows = (db.prepare(`
          SELECT e.created_at, e.event_type, e.actor_email, e.note
          FROM audit_events e
          WHERE ${aw.join(' AND ')}
          ORDER BY e.created_at DESC
          LIMIT ${ROW_CAP}
        `).all(...aa) as any[]).map(e => ({
          date: String(e.created_at).slice(0, 16),
          event: e.event_type,
          actor: e.actor_email || '',
          note: e.note || '',
        }));
        const closings = db.prepare(`
          SELECT COUNT(*) AS c FROM store_closing_counts WHERE store_id = ?
        `).get(storeId) as any;
        totals = { events: rows.length, closing_count_rows: n(closings?.c) };
        break;
      }
    }

    return Response.json({
      store: { id: store.id, name: store.name, code: store.code },
      type, from: from || null, to: to || null,
      generated_at: new Date().toISOString(),
      rows, totals,
      truncated: rows.length >= ROW_CAP,
    });
  } catch (e: any) {
    console.error('[/api/stores/[id]/reports GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
