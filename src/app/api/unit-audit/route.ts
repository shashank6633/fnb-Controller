import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { upsertUnitLock } from '@/lib/unit-audit-lock';

/**
 * Unit-of-Measure audit.
 *
 * Walks every raw_material and tags it with one or more flags so admins can
 * triage units before recipes go live (wrong units = wrong recipe cost + wrong
 * consumption deductions).
 *
 * Flag taxonomy:
 *   volume_in_name_not_pcs   — name has "(330ML)" / "750 ml" / "1 LTR" but unit is not pcs/ml/L
 *   pack_in_name_not_pcs     — name has "(500 GM)" / "PKT" / "BTL" / "TIN" but unit is g/kg/L
 *   auto_discovered          — created automatically from a Recaho import; never reviewed
 *   no_purchase_history      — never appeared in `purchases` table
 *   zero_price_with_stock    — has stock but average_price = 0 (almost always wrong)
 *   recipe_unit_mismatch     — referenced in a recipe with a different unit than the material
 *   suspicious_unit          — unit string is non-standard (not in the known whitelist)
 *
 * Severity:
 *   high   = blocks correct recipe costing (volume/pack mismatch, recipe_unit_mismatch, zero_price)
 *   medium = needs review (auto_discovered, no_purchase_history)
 *   low    = informational (suspicious_unit alone)
 *
 * Query params:
 *   only         comma-separated flag list to restrict results
 *   category     filter by raw_material category
 *   q            substring match on name or sku
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const KNOWN_UNITS = new Set(['kg', 'g', 'L', 'ml', 'pcs', 'unit', 'pc', 'each', 'l']);

// Purchase containers that hold exactly ONE sellable piece. Buying one of these
// and selling it whole (recipe unit = pcs) is a legitimate 1:1 conversion, so
// pack_size = 1 is correct — e.g. 1 BTL of Budweiser = 1 bottle sold to a guest.
// (CASE / BOX / PKT / BAG are intentionally excluded: they usually hold many.)
const SINGLE_ITEM_CONTAINERS = new Set(['btl', 'bottle', 'can', 'jar', 'tin', 'pc', 'pcs', 'each', 'unit', 'piece']);

const HIGH = new Set(['volume_in_name_not_pcs', 'pack_in_name_not_pcs', 'recipe_unit_mismatch', 'zero_price_with_stock', 'missing_pack_size', 'purchase_unit_same_as_recipe']);
const MEDIUM = new Set(['auto_discovered', 'no_purchase_history']);

function detectFlags(m: any, recipeUses: any[]): { flags: string[]; severity: 'high' | 'medium' | 'low' | 'ok' } {
  const flags: string[] = [];
  const name = String(m.name || '').toUpperCase();
  const unit = String(m.unit || '').toLowerCase().trim();
  const purchaseUnit = String(m.purchase_unit || unit).toLowerCase().trim();
  const packSize = Number(m.pack_size) || 1;

  const hasVolume   = /\(\s*\d+\s*ML\s*\)/.test(name) || /\b\d+\s*ML\b/.test(name)
                    || /\b\d+(?:\.\d+)?\s*L(?:TR)?\b/.test(name);
  const hasPackQty  = /\(\s*\d+\s*(?:G|GMS|GRMS|KG)\s*\)/.test(name)
                    || /\b\d+\s*(?:GM|GMS|GRMS|KG)\b/.test(name);
  const hasPackTag  = /\b(?:BTL|BOTTLE|PKT|PACKET|TIN|CAN|JAR|BOX|SHEET|ROLL)\b/.test(name)
                    || /\(\s*\d+\s*PC\s*\)/.test(name);

  if (hasVolume && unit !== 'pcs' && unit !== 'ml' && unit !== 'l') {
    flags.push('volume_in_name_not_pcs');
  }
  if ((hasPackQty || hasPackTag) && unit !== 'pcs') {
    flags.push('pack_in_name_not_pcs');
  }
  if (m.is_auto_discovered)              flags.push('auto_discovered');
  if (!m.purchase_count || m.purchase_count === 0) flags.push('no_purchase_history');
  if (m.current_stock > 0 && (!m.average_price || m.average_price === 0)) flags.push('zero_price_with_stock');
  if (unit && !KNOWN_UNITS.has(unit))    flags.push('suspicious_unit');
  if (recipeUses.some(r => String(r.recipe_unit || '').toLowerCase() !== unit))
                                          flags.push('recipe_unit_mismatch');
  // Different purchase / recipe units AND no pack_size set → conversion will fail or wrong.
  // EXCEPT a true 1:1 count: selling a whole single-item container (BTL/CAN/JAR…) by
  // the piece — there pack_size = 1 is correct (1 BTL = 1 pcs), so don't flag it.
  const oneToOneCount = unit === 'pcs' && SINGLE_ITEM_CONTAINERS.has(purchaseUnit);
  if (purchaseUnit && purchaseUnit !== unit && packSize === 1 && !oneToOneCount) {
    flags.push('missing_pack_size');
  }
  // Pack-size > 1 means each purchase-unit holds multiple recipe-units (e.g. 1 BTL = 750 ml).
  // If purchase_unit still equals recipe_unit, the audit didn't capture the buy/consume split.
  // Almost always means purchase_unit should be re-labelled as BTL / PKT / TIN / etc.
  if (packSize > 1 && purchaseUnit === unit) {
    flags.push('purchase_unit_same_as_recipe');
  }

  let severity: 'high' | 'medium' | 'low' | 'ok' = 'ok';
  if (flags.some(f => HIGH.has(f)))        severity = 'high';
  else if (flags.some(f => MEDIUM.has(f))) severity = 'medium';
  else if (flags.length > 0)                severity = 'low';
  return { flags, severity };
}

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const only = (url.searchParams.get('only') || '').split(',').filter(Boolean);
    const category = url.searchParams.get('category') || '';
    const q = (url.searchParams.get('q') || '').toLowerCase();

    const where: string[] = ['1=1'];
    const params: any[] = [];
    if (category) { where.push('rm.category = ?'); params.push(category); }
    if (q)        { where.push('(LOWER(rm.name) LIKE ? OR LOWER(rm.sku) LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

    const materials = db.prepare(`
      SELECT rm.id, rm.sku, rm.name, rm.category,
             rm.unit          AS recipe_unit,
             rm.purchase_unit AS purchase_unit,
             rm.pack_size     AS pack_size,
             COALESCE(rm.case_size, 1) AS case_size,
             rm.unit          AS unit,                  -- legacy alias for clients still reading 'unit'
             rm.current_stock,
             rm.average_price, rm.is_auto_discovered, rm.discovered_source,
             COALESCE((SELECT COUNT(*) FROM purchases WHERE material_id = rm.id), 0) AS purchase_count,
             COALESCE((SELECT MAX(date) FROM purchases WHERE material_id = rm.id), '') AS last_purchase_date,
             COALESCE((SELECT unit_price FROM purchases WHERE material_id = rm.id ORDER BY date DESC, created_at DESC LIMIT 1), 0) AS last_purchase_price
      FROM raw_materials rm
      WHERE ${where.join(' AND ')}
      ORDER BY rm.name ASC
    `).all(...params) as any[];

    // Fetch recipe + sub-recipe references in two batches and join in JS
    const recipeRefs = db.prepare(`
      SELECT material_id, unit AS recipe_unit, 'recipe' AS source FROM recipe_ingredients
      UNION ALL
      SELECT material_id, unit AS recipe_unit, 'sub_recipe' AS source FROM sub_recipe_ingredients
    `).all() as any[];
    const recipeByMat = new Map<string, any[]>();
    for (const r of recipeRefs) {
      if (!recipeByMat.has(r.material_id)) recipeByMat.set(r.material_id, []);
      recipeByMat.get(r.material_id)!.push(r);
    }

    // Preload all locks once (keyed sku + name) so drift detection is in-memory
    // rather than 2 queries per material across the whole catalog.
    const lockBySku = new Map<string, any>();
    const lockByName = new Map<string, any>();
    for (const l of db.prepare('SELECT sku, name_key, recipe_unit, purchase_unit, pack_size, case_size FROM unit_audit_locks').all() as any[]) {
      if (l.sku) lockBySku.set(String(l.sku).trim(), l);
      if (l.name_key) lockByName.set(String(l.name_key), l);
    }
    const lockFor = (sku: any, name: any) => {
      const s = sku ? String(sku).trim() : '';
      if (s && lockBySku.has(s)) return lockBySku.get(s);
      return lockByName.get(String(name || '').toLowerCase().trim()) || null;
    };

    const audited = materials.map(m => {
      const uses = recipeByMat.get(m.id) || [];
      const { flags, severity } = detectFlags(m, uses);
      // Drift = the material's LIVE units differ from the unit-audit lock (the
      // curated source of truth). This is exactly a "silently reverted" item —
      // surface it prominently so the owner can find and re-fix it. Now that all
      // writers respect the lock, drift only lingers for items last reverted
      // BEFORE this protection, or whose lock itself needs updating.
      const lr = lockFor(m.sku, m.name);
      const lock = lr ? {
        unit: lr.recipe_unit != null ? String(lr.recipe_unit) : null,
        purchase_unit: lr.purchase_unit != null ? String(lr.purchase_unit) : null,
        pack_size: lr.pack_size != null ? Number(lr.pack_size) : null,
        case_size: lr.case_size != null ? Number(lr.case_size) : null,
      } : null;
      const drifted = !!lock && (
        (lock.unit != null && String(lock.unit) !== String(m.recipe_unit ?? '')) ||
        (lock.purchase_unit != null && String(lock.purchase_unit) !== String(m.purchase_unit ?? '')) ||
        (lock.pack_size != null && Number(lock.pack_size) !== Number(m.pack_size)) ||
        (lock.case_size != null && Number(lock.case_size) !== Number(m.case_size))
      );
      const outFlags = drifted ? [...flags, 'unit_reverted'] : flags;
      return {
        ...m,
        flags: outFlags,
        severity: drifted ? 'high' : severity,
        recipe_use_count: uses.length,
        locked: !!lock,
        drifted,
        lock: lock || null,
      };
    });

    const filtered = only.length > 0
      ? audited.filter(m => m.flags.some((f: string) => only.includes(f)))
      : audited;

    // Counts per flag (for the chip badges)
    const counts: Record<string, number> = {};
    for (const m of audited) for (const f of m.flags) counts[f] = (counts[f] || 0) + 1;
    const sevCounts = { high: 0, medium: 0, low: 0, ok: 0 };
    for (const m of audited) sevCounts[m.severity as keyof typeof sevCounts] += 1;

    // List of distinct categories — computed independently of the current filters,
    // so the category dropdown stays populated even when one is selected.
    const allCategories = (db.prepare(`
      SELECT DISTINCT category FROM raw_materials
      WHERE category IS NOT NULL AND category != ''
      ORDER BY category ASC
    `).all() as any[]).map(r => r.category);

    return Response.json({
      materials: filtered,
      total: audited.length,
      filtered: filtered.length,
      flag_counts: counts,
      severity_counts: sevCounts,
      categories: allCategories,
    });
  } catch (e: any) {
    console.error('[unit-audit]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/**
 * Bulk update units / categories.
 * body: { updates: [{ id, recipe_unit?, purchase_unit?, category? }] }
 *   recipe_unit   → writes raw_materials.unit (the canonical stock + recipe unit)
 *   purchase_unit → writes raw_materials.purchase_unit
 *   category      → writes raw_materials.category
 * Legacy `unit` field on incoming payload is treated as recipe_unit for back-compat.
 */
export async function PUT(request: Request) {
  try {
    const db = getDb();
    const { updates } = await request.json();
    if (!Array.isArray(updates) || updates.length === 0) {
      return Response.json({ error: 'updates array required' }, { status: 400 });
    }
    // Update both `unit` (canonical, used by recipe-deduction code) and the
    // historical `recipe_unit` column if it exists, so anything reading either
    // column stays consistent.
    const hasRecipeUnitCol = (db.prepare("PRAGMA table_info(raw_materials)").all() as any[])
      .some((c: any) => c.name === 'recipe_unit');
    const updWithRecipe = db.prepare(`
      UPDATE raw_materials SET
        unit          = COALESCE(?, unit),
        recipe_unit   = COALESCE(?, recipe_unit),
        purchase_unit = COALESCE(?, purchase_unit),
        pack_size     = COALESCE(?, pack_size),
        case_size     = COALESCE(?, case_size),
        category      = COALESCE(?, category),
        updated_at    = datetime('now')
      WHERE id = ?
    `);
    const updWithoutRecipe = db.prepare(`
      UPDATE raw_materials SET
        unit          = COALESCE(?, unit),
        purchase_unit = COALESCE(?, purchase_unit),
        pack_size     = COALESCE(?, pack_size),
        case_size     = COALESCE(?, case_size),
        category      = COALESCE(?, category),
        updated_at    = datetime('now')
      WHERE id = ?
    `);
    const me = await getCurrentUser();
    let updated = 0;
    // Pack-factor for the price/stock basis: recipe-units per purchase-unit,
    // active only when pack>1 AND the units differ (the house guard).
    const factorOf = (unit: any, pu: any, pack: any) => {
      const p = Number(pack) || 1;
      const un = String(unit || '').toLowerCase().trim();
      const pn = String(pu || unit || '').toLowerCase().trim();
      return p > 1 && un !== pn ? p : 1;
    };
    const rebased: Array<{ id: string; name: string; old_avg: number; new_avg: number; old_stock: number; new_stock: number }> = [];
    const txn = db.transaction(() => {
      for (const u of updates) {
        if (!u?.id) continue;
        const recipeUnit   = (u.recipe_unit ?? u.unit) ?? null;
        const purchaseUnit = u.purchase_unit ?? null;
        const packSize     = u.pack_size != null ? Number(u.pack_size) : null;
        const caseSize     = u.case_size != null ? Number(u.case_size) : null;
        const category     = u.category ?? null;
        if (recipeUnit === null && purchaseUnit === null && packSize === null && caseSize === null && category === null) continue;
        const before = db.prepare('SELECT name, unit, purchase_unit, pack_size, average_price, current_stock FROM raw_materials WHERE id = ?').get(u.id) as any;
        if (hasRecipeUnitCol) {
          updWithRecipe.run(recipeUnit, recipeUnit, purchaseUnit, packSize, caseSize, category, u.id);
        } else {
          updWithoutRecipe.run(recipeUnit, purchaseUnit, packSize, caseSize, category, u.id);
        }
        // REBASE price & stock when the pack factor changes, so the physical
        // reality is preserved: ₹/purchase-unit and on-hand purchase-unit count
        // stay constant. Without this, changing GREEN CURRY PASTE from
        // TIN/pack 1 to g/pack 1000 left average_price meaning ₹384/GRAM —
        // a silent 1000× price inflation (owner-reported 22-07).
        if (before) {
          const fOld = factorOf(before.unit, before.purchase_unit, before.pack_size);
          const fNew = factorOf(recipeUnit ?? before.unit, purchaseUnit ?? before.purchase_unit, packSize ?? before.pack_size);
          if (fOld !== fNew && ((Number(before.average_price) || 0) !== 0 || (Number(before.current_stock) || 0) !== 0)) {
            const newAvg   = Math.round(((Number(before.average_price) || 0) * fOld / fNew) * 10000) / 10000;
            const newStock = Math.round(((Number(before.current_stock) || 0) * fNew / fOld) * 1000) / 1000;
            db.prepare('UPDATE raw_materials SET average_price = ?, current_stock = ? WHERE id = ?').run(newAvg, newStock, u.id);
            rebased.push({ id: u.id, name: before.name, old_avg: Number(before.average_price) || 0, new_avg: newAvg,
                           old_stock: Number(before.current_stock) || 0, new_stock: newStock });
          }
        }
        // Snapshot the FULL post-update row to unit_audit_locks so the curation
        // survives wipes / re-uploads and acts as the source of truth defending
        // against drift on the next purchases import.
        const m = db.prepare('SELECT sku, name, unit, purchase_unit, pack_size, case_size, category FROM raw_materials WHERE id = ?').get(u.id) as any;
        if (m) {
          upsertUnitLock(db, {
            sku: m.sku, name: m.name,
            recipe_unit: m.unit, purchase_unit: m.purchase_unit,
            pack_size: m.pack_size, case_size: m.case_size, category: m.category,
          }, me?.email);
        }
        updated += 1;
      }
    });
    txn();
    return Response.json({ success: true, updated, rebased });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
