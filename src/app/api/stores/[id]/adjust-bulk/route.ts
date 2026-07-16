import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, materialStoreId, postLedger, userStoreAccess, isStoreMappedMaterial, storeCategories } from '@/lib/store-engine';

/**
 * POST /api/stores/[id]/adjust-bulk — set / correct many materials' stock for
 * one store in a single all-or-nothing save (the bulk sibling of /adjust).
 * Gate: userStoreAccess(...).can_adjust.
 *
 * Each line carries a TARGET quantity (what is physically on the floor now, in
 * RECIPE units). The route computes, per line, what to post so the store's
 * ledger stock BECOMES that target — never trusting a client-sent "current":
 *
 *   • material with NO ledger history here → post 'opening' = target
 *       (target 0 → nothing to open → line reported as "unchanged").
 *   • material WITH history → post 'adjustment' = target − current system qty
 *       (delta 0 → no-op → "unchanged"; delta may be ±).
 *
 * body: {
 *   reason      — REQUIRED, batch note copied onto every posted ledger row,
 *   lines: [{
 *     material_id,
 *     quantity    — TARGET, RECIPE units, ≥ 0 (0 = write the stock down to zero),
 *     unit_price? — ₹ per PURCHASE unit, opening only (÷pack → ₹/recipe-unit),
 *     note?       — optional per-line note (appended to the reason)
 *   }]
 * }
 *
 * Ledger-only, exactly like /adjust and /procure — central inventory untouched.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id: storeId } = await params;
    const db = getDb();

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });

    const access = userStoreAccess(db, user, storeId);
    if (!access.can_adjust) {
      return Response.json({ error: `You are not authorized to adjust ${store.name} stock` }, { status: 403 });
    }

    const b = await request.json();
    const reason = String(b.reason || '').trim();
    if (!reason) return Response.json({ error: 'A reason is required' }, { status: 400 });
    if (!Array.isArray(b.lines) || b.lines.length === 0) {
      return Response.json({ error: 'lines array is required' }, { status: 400 });
    }
    if (b.lines.length > 2000) {
      return Response.json({ error: 'Too many lines (max 2000 per upload)' }, { status: 400 });
    }

    // Validate + plan EVERYTHING before writing anything (all-or-nothing save).
    type Plan = {
      material_id: string; name: string; unit: string;
      action: 'opening' | 'adjustment' | 'unchanged';
      current: number; target: number; qty: number; unit_cost: number; note: string;
    };
    const plans: Plan[] = [];
    const seen = new Set<string>();

    const currentStmt = db.prepare(
      'SELECT SUM(quantity) AS qty, COUNT(*) AS n FROM store_stock_ledger WHERE store_id = ? AND material_id = ?',
    );
    const heldStmt = db.prepare('SELECT 1 FROM store_stock_ledger WHERE store_id = ? AND material_id = ? LIMIT 1');
    // A FLOOR bar owns no categories: it may set opening/closing for ANY catalog
    // (liquor) material, not just ones already transferred in.
    const floorStore = storeCategories(db, storeId).length === 0;

    for (const raw of b.lines) {
      const materialId = String(raw?.material_id || '').trim();
      const target = Number(raw?.quantity);
      if (!materialId) return Response.json({ error: 'Every line needs a material_id' }, { status: 400 });
      if (seen.has(materialId)) {
        return Response.json({ error: 'Duplicate material in lines — list each material once' }, { status: 400 });
      }
      seen.add(materialId);
      if (!Number.isFinite(target) || target < 0) {
        return Response.json({ error: 'quantity must be a number ≥ 0 (target, recipe units)' }, { status: 400 });
      }

      const mat = db.prepare(
        'SELECT id, name, category, unit, purchase_unit, pack_size FROM raw_materials WHERE id = ?',
      ).get(materialId) as any;
      if (!mat) return Response.json({ error: `Material not found: ${materialId}` }, { status: 404 });

      // Owned (category-mapped) OR actually held via this store's ledger — a
      // receiving FLOOR owns no categories but may correct stock transferred in.
      // Mirrors the union storeItemList()/adjust use.
      if (materialStoreId(db, mat) !== storeId) {
        const held = heldStmt.get(storeId, materialId);
        // Floors accept any catalog (store-mapped) material for opening/closing.
        const catalogOk = floorStore && isStoreMappedMaterial(db, materialId);
        if (!held && !catalogOk) {
          return Response.json({ error: `"${mat.name}" is not a ${store.name} material — its category "${mat.category}" is not mapped to this store (Settings → Store Locations)` }, { status: 400 });
        }
      }

      const cur = currentStmt.get(storeId, materialId) as any;
      const hasHistory = (Number(cur?.n) || 0) > 0;
      const current = Number(cur?.qty) || 0;
      const note = String(raw?.note ?? '').trim();

      // Optional cost basis (opening only), entered per PURCHASE unit → per RECIPE unit.
      const packSize = Number(mat.pack_size) || 1;
      const ru = String(mat.unit || '').toLowerCase().trim();
      const pu = String(mat.purchase_unit || mat.unit || '').toLowerCase().trim();
      const packConv = (packSize > 1 && ru !== pu) ? packSize : 1;
      let unitCost = 0;
      if (raw?.unit_price !== undefined && raw?.unit_price !== null && raw?.unit_price !== '') {
        const p = Number(raw.unit_price);
        if (!Number.isFinite(p) || p < 0) {
          return Response.json({ error: `"${mat.name}": unit_price must be a number ≥ 0 (₹ per purchase unit)` }, { status: 400 });
        }
        unitCost = packConv > 1 ? p / packConv : p;
      }

      let action: Plan['action'];
      let qty: number;
      if (!hasHistory) {
        // First-ever entry for this material in this store → opening stock.
        action = target > 0 ? 'opening' : 'unchanged';
        qty = target;
      } else {
        const delta = Math.round((target - current) * 1000) / 1000;
        action = delta === 0 ? 'unchanged' : 'adjustment';
        qty = delta;
      }

      plans.push({
        material_id: materialId, name: mat.name, unit: mat.unit,
        action, current, target, qty, unit_cost: action === 'opening' ? unitCost : 0, note,
      });
    }

    const toPost = plans.filter(p => p.action !== 'unchanged');
    if (toPost.length === 0) {
      return Response.json({
        ok: true,
        summary: { lines: plans.length, opened: 0, adjusted: 0, unchanged: plans.length },
        results: plans.map(p => ({ material_id: p.material_id, action: p.action, current: p.current, target: p.target, change: p.qty })),
      }, { status: 200 });
    }

    const txn = db.transaction(() => {
      for (const p of toPost) {
        const detail = p.action === 'opening'
          ? `Bulk opening ${p.target} ${p.unit}`
          : `Bulk set: ${p.current} → ${p.target} ${p.unit} (${p.qty > 0 ? '+' : ''}${p.qty})`;
        postLedger(db, {
          store_id: storeId,
          material_id: p.material_id,
          txn_type: p.action as 'opening' | 'adjustment',   // toPost excludes 'unchanged'
          quantity: p.qty,
          unit_cost: p.unit_cost,
          ref: 'bulk-adjust',
          notes: `${detail} — ${p.note ? `${p.note} · ` : ''}${reason}`,
          created_by: user.email,
        });
      }
    });
    txn();

    const summary = {
      lines: plans.length,
      opened: toPost.filter(p => p.action === 'opening').length,
      adjusted: toPost.filter(p => p.action === 'adjustment').length,
      unchanged: plans.length - toPost.length,
    };

    logAuditEvent(db, {
      event_type: 'store.adjust_bulk',
      entity_type: 'store_stock_ledger',
      entity_id: `${storeId}:bulk`,
      actor_email: user.email,
      after: {
        store_id: storeId, store: store.name, reason, ...summary,
        items_detail: toPost.map(p => ({
          material_id: p.material_id, material: p.name,
          action: p.action, current: p.current, target: p.target, change: p.qty,
        })),
      },
      note: `${store.name}: bulk stock set — ${summary.opened} opened, ${summary.adjusted} adjusted, ${summary.unchanged} unchanged — ${reason}`,
    });

    return Response.json({
      ok: true, summary,
      results: plans.map(p => ({ material_id: p.material_id, action: p.action, current: p.current, target: p.target, change: p.qty })),
    }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/stores/[id]/adjust-bulk POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
