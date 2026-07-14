import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { getStoreById, postLedger } from '@/lib/store-engine';

/**
 * POST /api/stores/[id]/migrate — ADMIN-ONLY one-time migration of CENTRAL
 * stock into a store location, for mapped materials that predate the store
 * (their liquor stock still sits in raw_materials.current_stock).
 *
 * body: { material_ids: [id, …] }  OR  { all: true }
 *   all:true targets every material mapped to this store whose central
 *   current_stock > 0.
 *
 * Per material, inside ONE transaction (whole batch all-or-nothing):
 *   1. store ledger 'opening' row — qty = central current_stock (recipe units),
 *      unit_cost = rm.average_price (already ₹/recipe-unit, F&B unit convention)
 *   2. raw_materials.current_stock → 0
 *   3. inventory_transactions 'adjustment' row (NEGATIVE qty, note
 *      'Migrated to LIQUOR STORE…') so the central audit trail stays truthful
 *   4. logAuditEvent('store.migrate') per material
 *
 * GUARD: a material that already has ANY store ledger rows is never migrated —
 * it is skipped + reported (single-material request → 409). Re-running a
 * migration is therefore always safe.
 *
 * → { ok, migrated: [{material_id, material, qty, unit, unit_cost, value,
 *      ledger_id}], skipped: [{material_id, material, reason}], total_value }
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireRole('admin');
    if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
    const user = auth.user;
    const { id: storeId } = await params;
    const db = getDb();

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });
    if (!store.is_active) {
      return Response.json({ error: `${store.name} is deactivated — reactivate it before migrating stock` }, { status: 400 });
    }

    const b = await request.json();
    const all = b.all === true;
    const ids: string[] = Array.isArray(b.material_ids)
      ? Array.from(new Set(b.material_ids.map((v: any) => String(v || '').trim()).filter(Boolean))) as string[]
      : [];
    if (!all && ids.length === 0) {
      return Response.json({ error: 'Pass material_ids: [...] or all: true' }, { status: 400 });
    }

    // Mapped materials for this store (the migration universe).
    const mapped = db.prepare(`
      SELECT rm.id, rm.name, rm.unit, rm.purchase_unit, rm.pack_size, rm.case_size,
             rm.category, rm.current_stock, rm.average_price
      FROM raw_materials rm
      JOIN store_category_map scm
        ON scm.store_id = ? AND TRIM(scm.category) = TRIM(rm.category) COLLATE NOCASE
    `).all(storeId) as any[];
    const mappedById = new Map(mapped.map(m => [m.id, m]));

    const targets: any[] = [];
    const skipped: { material_id: string; material: string; reason: string }[] = [];

    if (all) {
      for (const m of mapped) if ((Number(m.current_stock) || 0) > 0) targets.push(m);
    } else {
      for (const id of ids) {
        const m = mappedById.get(id);
        if (!m) {
          const rm = db.prepare('SELECT id, name FROM raw_materials WHERE id = ?').get(id) as any;
          if (!rm) return Response.json({ error: `Material not found: ${id}` }, { status: 404 });
          skipped.push({ material_id: id, material: rm.name, reason: `not mapped to ${store.name}` });
          continue;
        }
        targets.push(m);
      }
    }

    const hasLedger = db.prepare(`
      SELECT 1 FROM store_stock_ledger WHERE store_id = ? AND material_id = ? LIMIT 1
    `);

    const migratable: any[] = [];
    for (const m of targets) {
      if (hasLedger.get(storeId, m.id)) {
        skipped.push({ material_id: m.id, material: m.name, reason: `already has ${store.name} ledger history — not migrated` });
      } else if (!((Number(m.current_stock) || 0) > 0)) {
        skipped.push({ material_id: m.id, material: m.name, reason: 'no central stock to migrate' });
      } else {
        migratable.push(m);
      }
    }

    // Single-material request that can't proceed → 409 (spec).
    if (!all && ids.length === 1 && migratable.length === 0 && skipped.length === 1) {
      return Response.json({ error: `${skipped[0].material}: ${skipped[0].reason}`, skipped }, { status: 409 });
    }

    const migrated: {
      material_id: string; material: string; qty: number; unit: string;
      unit_cost: number; value: number; ledger_id: string;
    }[] = [];

    const zeroCentral = db.prepare(`
      UPDATE raw_materials SET current_stock = 0, updated_at = datetime('now') WHERE id = ?
    `);
    const centralTxn = db.prepare(`
      INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
      VALUES (?, ?, 'adjustment', ?, ?, ?, datetime('now'))
    `);

    const txn = db.transaction(() => {
      for (const m of migratable) {
        const qty = Number(m.current_stock) || 0;                    // recipe units
        const unitCost = Number(m.average_price) || 0;               // ₹/recipe unit
        const ledgerId = postLedger(db, {
          store_id: storeId,
          material_id: m.id,
          txn_type: 'opening',
          quantity: qty,
          unit_cost: unitCost,
          ref: 'central-migration',
          notes: `Migrated from Central Store (central stock ${qty} ${m.unit} @ ₹${unitCost}/${m.unit})`,
          created_by: user.email,
        });
        zeroCentral.run(m.id);
        centralTxn.run(
          generateId(), m.id, -qty, ledgerId,
          `Migrated to ${store.name}: ${qty} ${m.unit} moved to store ledger (opening ${ledgerId})`,
        );
        migrated.push({
          material_id: m.id, material: m.name, qty, unit: m.unit,
          unit_cost: unitCost,
          value: Math.round(qty * unitCost * 100) / 100,
          ledger_id: ledgerId,
        });
      }
    });
    txn();

    for (const m of migrated) {
      logAuditEvent(db, {
        event_type: 'store.migrate',
        entity_type: 'store_stock_ledger',
        entity_id: m.ledger_id,
        actor_email: user.email,
        after: {
          store_id: storeId, store: store.name,
          material_id: m.material_id, material: m.material,
          qty: m.qty, unit: m.unit, unit_cost: m.unit_cost, value: m.value,
          central_stock_before: m.qty, central_stock_after: 0,
        },
        note: `${store.name}: migrated ${m.qty} ${m.unit} ${m.material} from Central Store (₹${m.value})`,
      });
    }

    const totalValue = Math.round(migrated.reduce((s, m) => s + m.value, 0) * 100) / 100;
    return Response.json({
      ok: true,
      migrated, skipped,
      total_value: totalValue,
    }, { status: migrated.length > 0 ? 201 : 200 });
  } catch (e: any) {
    console.error('[/api/stores/[id]/migrate POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
