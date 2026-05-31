import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';

/**
 * Master data hygiene audit — surfaces gaps in raw_materials, recipes,
 * menu_items that downstream reports silently rely on. Every report
 * (variance, recipe cost, daily tracked, receiving variance) assumes
 * these fields are set correctly; if they're not, the report lies.
 *
 * Categories (each row gets a severity 1-3):
 *   blocker  — variance / cost will be wrong without this
 *   warning  — affects readability or one specific feature
 *   info     — nice-to-have, not breaking anything
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Issue {
  category: string;          // bucket label
  severity: 'blocker' | 'warning' | 'info';
  entity_type: 'material' | 'recipe' | 'menu_item' | 'vendor';
  entity_id: string;
  entity_name: string;
  message: string;
  fix_hint: string;
  fix_url: string;
}

export async function GET() {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const db = getDb();
  const issues: Issue[] = [];

  // Cache: which materials have any purchases at all (orphan detection)
  const hasPurchases = new Set<string>(
    (db.prepare(`SELECT DISTINCT material_id FROM purchases`).all() as any[]).map(r => r.material_id)
  );
  // Which materials appear in any recipe
  const usedInRecipe = new Set<string>(
    (db.prepare(`SELECT DISTINCT material_id FROM recipe_ingredients UNION SELECT DISTINCT material_id FROM sub_recipe_ingredients`).all() as any[])
      .map(r => r.material_id)
  );

  // ---------- raw_materials checks ----------
  const mats = db.prepare(`
    SELECT id, name, sku, unit, purchase_unit, pack_size, case_size,
           storage_location, reorder_level, closing_cadence, current_stock,
           average_price, category
    FROM raw_materials
    ORDER BY name
  `).all() as any[];

  for (const m of mats) {
    const u = String(m.unit || '').toLowerCase();
    const isVolWeight = ['ml', 'l', 'g', 'kg'].includes(u);
    const ps = Number(m.pack_size) || 0;

    if (!m.sku) {
      issues.push({
        category: 'Missing SKU', severity: 'warning',
        entity_type: 'material', entity_id: m.id, entity_name: m.name,
        message: 'No SKU — harder to track in audits & POs',
        fix_hint: 'Set SKU on inventory edit (auto-generates if left blank)',
        fix_url: `/inventory`,
      });
    }
    if (isVolWeight && ps <= 1) {
      issues.push({
        category: 'Missing pack_size', severity: 'blocker',
        entity_type: 'material', entity_id: m.id, entity_name: m.name,
        message: `Recipe unit ${m.unit} but pack_size=${ps}. Stock & recipe arithmetic will be wrong.`,
        fix_hint: 'Set pack_size = recipe-units per purchase-unit (e.g. 750 for a 750ML bottle)',
        fix_url: `/unit-audit`,
      });
    }
    if (!m.purchase_unit || m.purchase_unit === m.unit && isVolWeight && ps > 1) {
      // Different sanity gate: vol/weight item with pack_size but purchase_unit == unit is suspicious
      if (!m.purchase_unit) {
        issues.push({
          category: 'Missing purchase_unit', severity: 'warning',
          entity_type: 'material', entity_id: m.id, entity_name: m.name,
          message: 'No purchase_unit set — purchases page will guess',
          fix_hint: 'Set purchase_unit (e.g. BTL, CASE, KG) on inventory edit',
          fix_url: `/inventory`,
        });
      }
    }
    if (!m.storage_location) {
      issues.push({
        category: 'No storage location', severity: 'warning',
        entity_type: 'material', entity_id: m.id, entity_name: m.name,
        message: 'No storage area tagged — closing-stock-by-location skips it',
        fix_hint: 'Set storage_location (e.g. Walk-in chiller, Bar back-bar)',
        fix_url: `/inventory`,
      });
    }
    if (!Number(m.reorder_level)) {
      issues.push({
        category: 'No reorder level', severity: 'warning',
        entity_type: 'material', entity_id: m.id, entity_name: m.name,
        message: 'No reorder level — buffer-stock warnings will never fire',
        fix_hint: 'Set reorder_level on inventory edit',
        fix_url: `/inventory`,
      });
    }
    if (!hasPurchases.has(m.id) && !usedInRecipe.has(m.id)) {
      issues.push({
        category: 'Orphan material', severity: 'info',
        entity_type: 'material', entity_id: m.id, entity_name: m.name,
        message: 'No purchases ever, not in any recipe — candidate for delete',
        fix_hint: 'Delete from inventory if truly unused',
        fix_url: `/inventory`,
      });
    }
    if (Number(m.current_stock) < 0) {
      issues.push({
        category: 'Negative stock', severity: 'blocker',
        entity_type: 'material', entity_id: m.id, entity_name: m.name,
        message: `current_stock = ${m.current_stock} — sales were deducted faster than purchases inwarded`,
        fix_hint: 'Run a closing-stock count and let it adjust system stock to match physical',
        fix_url: `/closing-stock`,
      });
    }
    if (!m.average_price && hasPurchases.has(m.id)) {
      issues.push({
        category: 'No avg price', severity: 'blocker',
        entity_type: 'material', entity_id: m.id, entity_name: m.name,
        message: 'Has purchases but average_price is 0 — recipe cost & variance ₹ will be wrong',
        fix_hint: 'Add at least one purchase entry with a non-zero price (or trigger price recompute)',
        fix_url: `/purchases`,
      });
    }
  }

  // ---------- recipes checks ----------
  const recipes = db.prepare(`
    SELECT r.id, r.name, r.selling_price, r.total_cost,
           (SELECT COUNT(*) FROM recipe_ingredients WHERE recipe_id = r.id) AS ing_count,
           (SELECT COUNT(*) FROM recipe_sub_recipes WHERE recipe_id = r.id) AS sub_count
    FROM recipes r
    ORDER BY r.name
  `).all() as any[];

  for (const r of recipes) {
    if (r.ing_count === 0 && r.sub_count === 0) {
      issues.push({
        category: 'Empty recipe', severity: 'blocker',
        entity_type: 'recipe', entity_id: r.id, entity_name: r.name,
        message: 'Recipe has no ingredients — sales will record but won\'t deduct any inventory',
        fix_hint: 'Add ingredients on the recipe edit page',
        fix_url: `/recipes`,
      });
    }
    if (!Number(r.selling_price)) {
      issues.push({
        category: 'No selling price', severity: 'warning',
        entity_type: 'recipe', entity_id: r.id, entity_name: r.name,
        message: 'No selling price — food-cost % cannot be computed',
        fix_hint: 'Set selling_price on the recipe',
        fix_url: `/recipes`,
      });
    }
    if (r.total_cost && r.selling_price && r.total_cost > r.selling_price) {
      issues.push({
        category: 'Cost exceeds price', severity: 'warning',
        entity_type: 'recipe', entity_id: r.id, entity_name: r.name,
        message: `Cost ₹${Math.round(r.total_cost)} > Selling ₹${Math.round(r.selling_price)} — losing money on every sale`,
        fix_hint: 'Review ingredient quantities or raise selling_price',
        fix_url: `/recipes`,
      });
    }
  }

  // ---------- menu_items checks ----------
  const menuItems = db.prepare(`
    SELECT m.id, m.name, m.recipe_id, m.material_id, m.direct_reviewed, m.selling_price,
           (SELECT COUNT(*) FROM sales s WHERE LOWER(s.item_name) = LOWER(m.name)) AS sales_count
    FROM menu_items m
    WHERE m.is_active = 1
    ORDER BY sales_count DESC
  `).all() as any[];

  for (const mi of menuItems) {
    const hasLink = mi.recipe_id || mi.material_id;
    if (!hasLink && mi.sales_count > 0) {
      issues.push({
        category: 'Unlinked menu item with sales', severity: 'blocker',
        entity_type: 'menu_item', entity_id: mi.id, entity_name: mi.name,
        message: `${mi.sales_count} sales recorded but no recipe / direct-item link — variance is missing this revenue stream`,
        fix_hint: 'Link to a recipe on /recipes, or to a raw material on /direct-items',
        fix_url: `/direct-items`,
      });
    }
  }

  // ---------- vendors checks ----------
  const vendorIssues = db.prepare(`
    SELECT v.id, v.name,
           (SELECT COUNT(*) FROM vendor_contracts vc WHERE vc.vendor_id = v.id) AS contract_count,
           (SELECT COUNT(*) FROM purchases p WHERE p.vendor = v.name) AS purchase_count
    FROM vendors v
    WHERE v.is_active = 1
    ORDER BY purchase_count DESC
  `).all() as any[];

  for (const v of vendorIssues) {
    if (v.purchase_count > 5 && v.contract_count === 0) {
      issues.push({
        category: 'Vendor has no contract', severity: 'info',
        entity_type: 'vendor', entity_id: v.id, entity_name: v.name,
        message: `${v.purchase_count} purchases from this vendor but no contract / agreed rates`,
        fix_hint: 'Add contract terms on /contracts so off-contract purchases get flagged',
        fix_url: `/contracts`,
      });
    }
  }

  // ---------- summarise ----------
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = { blocker: 0, warning: 0, info: 0 };
  for (const i of issues) {
    byCategory[i.category] = (byCategory[i.category] || 0) + 1;
    bySeverity[i.severity] += 1;
  }
  // Coverage score: percentage of materials with no blocker issues
  const blockedMaterials = new Set(issues.filter(i => i.severity === 'blocker' && i.entity_type === 'material').map(i => i.entity_id));
  const matCount = mats.length;
  const cleanMaterials = matCount - blockedMaterials.size;
  const coverageScore = matCount > 0 ? Math.round((cleanMaterials / matCount) * 100) : 100;

  return Response.json({
    summary: {
      total_issues: issues.length,
      by_severity: bySeverity,
      by_category: byCategory,
      total_materials: matCount,
      clean_materials: cleanMaterials,
      coverage_score: coverageScore,
    },
    issues,
  });
}
