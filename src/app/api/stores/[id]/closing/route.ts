import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, materialStoreId, postLedger, userStoreAccess } from '@/lib/store-engine';

/**
 * /api/stores/[id]/closing — INDEPENDENT store closing stock (Phase C, spec F6).
 *
 * Counts live in `store_closing_counts` — a pure REGISTER. Saving a count
 * never moves stock (no ledger row), so closing can't distort the store's
 * ledger-derived quantities. Completely separate from the central
 * /closing-stock module (different table, different APIs, zero overlap).
 *
 * GET  ?date=YYYY-MM-DD   (can_view)  → that day's saved counts + summary +
 *                                       system as-of qty for every material
 *                                       with ledger history (for the count UI).
 *      (no date)          (can_view)  → history: list of count dates w/ totals.
 *
 * POST                    (can_close_stock)
 *      { date, items: [{ material_id, physical_qty (RECIPE units), note? }],
 *        note?, adjust_to_physical? }
 *      Each item's optional `note` (per-row) persists to the count row; when
 *      absent/blank it falls back to the batch-level `note` (default '').
 *      For each item: system qty = ledger SUM as-of end of `date`;
 *      variance = physical − system; variance ₹ at the store's weighted-avg
 *      cost (fallback rm.average_price). Upserts on (store, material, date).
 *      `adjust_to_physical` is ADMIN-ONLY (silently ignored otherwise): posts
 *      an 'adjustment' ledger row for each non-zero variance so stock matches
 *      the physical count — the saved count row still records the pre-adjust
 *      system qty & variance as evidence.
 */
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Weighted-avg ₹/recipe-unit + system qty as-of end of `date` for one material. */
function asOfStats(db: any, storeId: string, materialId: string, date: string) {
  const r = db.prepare(`
    SELECT SUM(quantity) AS qty,
           SUM(CASE WHEN quantity > 0 AND unit_cost > 0 THEN quantity * unit_cost ELSE 0 END) AS in_value,
           SUM(CASE WHEN quantity > 0 AND unit_cost > 0 THEN quantity ELSE 0 END)             AS in_qty
    FROM store_stock_ledger
    WHERE store_id = ? AND material_id = ? AND date(created_at) <= date(?)
  `).get(storeId, materialId, date) as any;
  const mat = db.prepare('SELECT average_price FROM raw_materials WHERE id = ?').get(materialId) as any;
  const avg = (Number(r?.in_qty) || 0) > 0
    ? (Number(r.in_value) || 0) / Number(r.in_qty)
    : (Number(mat?.average_price) || 0);
  return {
    system_qty: Number(r?.qty) || 0,
    avg_cost: Math.round(avg * 10000) / 10000,
  };
}

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
    const date = (url.searchParams.get('date') || '').trim();

    // History: dates with totals, newest first.
    if (!date) {
      const dates = (db.prepare(`
        SELECT date,
               COUNT(*)                                        AS item_count,
               SUM(CASE WHEN variance < 0 THEN 1 ELSE 0 END)   AS shortage_count,
               SUM(CASE WHEN variance > 0 THEN 1 ELSE 0 END)   AS excess_count,
               SUM(variance_value)                             AS total_variance_value,
               SUM(ABS(variance_value))                        AS abs_variance_value
        FROM store_closing_counts
        WHERE store_id = ?
        GROUP BY date
        ORDER BY date DESC
        LIMIT 90
      `).all(storeId) as any[]).map(r => ({
        date: r.date,
        item_count: Number(r.item_count) || 0,
        shortage_count: Number(r.shortage_count) || 0,
        excess_count: Number(r.excess_count) || 0,
        total_variance_value: Math.round((Number(r.total_variance_value) || 0) * 100) / 100,
        abs_variance_value: Math.round((Number(r.abs_variance_value) || 0) * 100) / 100,
      }));
      return Response.json({ store: { id: store.id, name: store.name }, dates });
    }

    if (!DATE_RE.test(date)) {
      return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    }

    // Saved counts for the day.
    const counts = db.prepare(`
      SELECT c.id, c.material_id, c.date, c.system_qty, c.physical_qty, c.variance,
             c.variance_value, c.counted_by, c.note, c.created_at,
             rm.name AS material_name, rm.unit, rm.purchase_unit, rm.pack_size, rm.case_size, rm.category
      FROM store_closing_counts c
      JOIN raw_materials rm ON rm.id = c.material_id
      WHERE c.store_id = ? AND c.date = ?
      ORDER BY rm.name COLLATE NOCASE
    `).all(storeId, date) as any[];

    // System qty as-of end of the selected date for every material with ledger
    // history — the count UI's "system" column (works for backdated counts too).
    const system_asof = (db.prepare(`
      SELECT material_id, SUM(quantity) AS qty
      FROM store_stock_ledger
      WHERE store_id = ? AND date(created_at) <= date(?)
      GROUP BY material_id
    `).all(storeId, date) as any[]).map(r => ({
      material_id: r.material_id,
      qty: Number(r.qty) || 0,
    }));

    const summary = {
      items: counts.length,
      shortage_count: counts.filter(c => c.variance < 0).length,
      excess_count: counts.filter(c => c.variance > 0).length,
      match_count: counts.filter(c => c.variance === 0).length,
      total_variance_value: Math.round(counts.reduce((s, c) => s + (Number(c.variance_value) || 0), 0) * 100) / 100,
    };

    return Response.json({ store: { id: store.id, name: store.name }, date, counts, system_asof, summary });
  } catch (e: any) {
    console.error('[/api/stores/[id]/closing GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id: storeId } = await params;
    const db = getDb();

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });

    const access = userStoreAccess(db, user, storeId);
    if (!access.can_close_stock) {
      return Response.json({ error: `You are not authorized to record closing stock for ${store.name}` }, { status: 403 });
    }

    const b = await request.json();
    const date = String(b.date || '').trim();
    const note = String(b.note || '').trim();
    // Admin-only flag — silently ignored for everyone else (same pattern as the
    // central closing module): a store user must never one-click reconcile away
    // genuine shrinkage.
    const isAdmin = user.role === 'admin';
    const adjust = isAdmin ? !!b.adjust_to_physical : false;

    if (!DATE_RE.test(date)) {
      return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (date > today) {
      return Response.json({ error: 'Cannot record a closing count for a future date' }, { status: 400 });
    }
    if (!Array.isArray(b.items) || b.items.length === 0) {
      return Response.json({ error: 'items array is required' }, { status: 400 });
    }

    // Validate everything BEFORE writing anything (all-or-nothing save).
    const prepared: {
      material_id: string; name: string; unit: string;
      system_qty: number; physical_qty: number; variance: number;
      variance_value: number; avg_cost: number; note: string;
    }[] = [];
    const seen = new Set<string>();
    for (const item of b.items) {
      const materialId = String(item?.material_id || '').trim();
      const physical = Number(item?.physical_qty);
      if (!materialId) return Response.json({ error: 'Every item needs a material_id' }, { status: 400 });
      if (seen.has(materialId)) {
        return Response.json({ error: 'Duplicate material in items — count each material once' }, { status: 400 });
      }
      seen.add(materialId);
      if (!Number.isFinite(physical) || physical < 0) {
        return Response.json({ error: 'physical_qty must be a number ≥ 0 (recipe units)' }, { status: 400 });
      }
      const mat = db.prepare('SELECT id, name, category, unit FROM raw_materials WHERE id = ?').get(materialId) as any;
      if (!mat) return Response.json({ error: `Material not found: ${materialId}` }, { status: 404 });
      if (materialStoreId(db, mat) !== storeId) {
        return Response.json({ error: `"${mat.name}" is not a ${store.name} material — its category "${mat.category}" is not mapped to this store` }, { status: 400 });
      }
      // Optional per-item note (per-row Notes column). Absent/blank → fall back
      // to the batch-level note (which itself defaults to '').
      const itemNote = String(item?.note ?? '').trim() || note;
      const { system_qty, avg_cost } = asOfStats(db, storeId, materialId, date);
      const variance = Math.round((physical - system_qty) * 1000) / 1000;
      const variance_value = Math.round(variance * avg_cost * 100) / 100;
      prepared.push({
        material_id: materialId, name: mat.name, unit: mat.unit,
        system_qty, physical_qty: physical, variance, variance_value, avg_cost,
        note: itemNote,
      });
    }

    const adjusted: string[] = [];
    const upsert = db.prepare(`
      INSERT INTO store_closing_counts
        (id, store_id, material_id, date, system_qty, physical_qty, variance,
         variance_value, counted_by, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(store_id, material_id, date) DO UPDATE SET
        system_qty     = excluded.system_qty,
        physical_qty   = excluded.physical_qty,
        variance       = excluded.variance,
        variance_value = excluded.variance_value,
        counted_by     = excluded.counted_by,
        note           = excluded.note,
        created_at     = datetime('now')
    `);
    const backdateLedger = db.prepare(`
      UPDATE store_stock_ledger SET created_at = ? || ' ' || strftime('%H:%M:%S', 'now') WHERE id = ?
    `);

    const txn = db.transaction(() => {
      for (const p of prepared) {
        upsert.run(
          generateId(), storeId, p.material_id, date,
          p.system_qty, p.physical_qty, p.variance, p.variance_value,
          user.email, p.note,
        );
        if (adjust && p.variance !== 0) {
          const ledgerId = postLedger(db, {
            store_id: storeId,
            material_id: p.material_id,
            txn_type: 'adjustment',
            quantity: p.variance,
            unit_cost: 0,
            ref: `closing:${date}`,
            notes: `Closing count ${date}: system ${p.system_qty} → physical ${p.physical_qty} ${p.unit} (adjusted to physical)`,
            created_by: user.email,
          });
          // Keep the adjustment on the count date so as-of sums stay coherent.
          if (date !== today) backdateLedger.run(date, ledgerId);
          adjusted.push(p.material_id);
        }
      }
    });
    txn();

    const summary = {
      items: prepared.length,
      shortage_count: prepared.filter(p => p.variance < 0).length,
      excess_count: prepared.filter(p => p.variance > 0).length,
      match_count: prepared.filter(p => p.variance === 0).length,
      total_variance_value: Math.round(prepared.reduce((s, p) => s + p.variance_value, 0) * 100) / 100,
      adjusted_count: adjusted.length,
    };

    logAuditEvent(db, {
      event_type: 'store.closing',
      entity_type: 'store_closing_counts',
      entity_id: `${storeId}:${date}`,
      actor_email: user.email,
      after: {
        store_id: storeId, store: store.name, date, note,
        ...summary,
        items_detail: prepared.map(p => ({
          material_id: p.material_id, material: p.name,
          system_qty: p.system_qty, physical_qty: p.physical_qty,
          variance: p.variance, variance_value: p.variance_value,
        })),
        adjust_to_physical: adjust,
      },
      note: `${store.name}: closing count ${date} — ${prepared.length} item(s), variance ₹${summary.total_variance_value}${adjust ? ` (adjusted ${adjusted.length} to physical)` : ''}`,
    });

    return Response.json({
      ok: true, date, summary,
      results: prepared.map(p => ({
        material_id: p.material_id,
        system_qty: p.system_qty, physical_qty: p.physical_qty,
        variance: p.variance, variance_value: p.variance_value,
        adjusted: adjusted.includes(p.material_id),
      })),
    }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/stores/[id]/closing POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
