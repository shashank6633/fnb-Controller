import * as XLSX from 'xlsx';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { parseRecipeWorkbook, matchMaterials, normName } from '@/lib/recipe-workbook';

/**
 * Step 1 of the Food-Costing workbook import — preview only, no writes. Body is
 * multipart/form-data with `file`. Returns counts, the matched/unmatched split,
 * the workbook's target food-cost %, and a small sample so the user can confirm
 * before committing.
 */
export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  try {
    const fd = await req.formData();
    const file = fd.get('file');
    if (!file || !(file instanceof Blob)) {
      return Response.json({ error: 'file field missing' }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer' });
    const parsed = parseRecipeWorkbook(XLSX, wb);

    if (parsed.recipes.length === 0 && parsed.materials.length === 0) {
      return Response.json({
        sheets: wb.SheetNames,
        error: 'No recipes or purchase rates found. Expected sheets "Purchase Rates", "Sub-Recipe Cards", "Recipe Cost Cards", "Recipe Summary".',
      }, { status: 200 });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id, name FROM raw_materials').all() as { id: string; name: string }[];
    const existingByName = new Set(existing.map((m) => normName(m.name)));

    // Match against the union of DB materials + the materials this import would create,
    // so the "unmatched" list reflects the post-import state (what the user actually cares about).
    const wouldCreate = parsed.materials.map((m, i) => ({ id: `__new_${i}`, name: m.name }));
    const universe = [...existing, ...wouldCreate.filter((m) => !existingByName.has(normName(m.name)))];
    const { matched, unmatched } = matchMaterials(parsed, universe);

    const newMaterials = parsed.materials.filter((m) => !existingByName.has(normName(m.name))).length;
    const subRefSkipped = parsed.subRecipes.reduce((s, x) => s + x.subRefLines.length, 0);

    return Response.json({
      sheets: wb.SheetNames,
      target_food_cost_pct: parsed.targetFoodCostPct,
      counts: {
        materials_in_sheet: parsed.materials.length,
        materials_new: newMaterials,
        materials_existing: parsed.materials.length - newMaterials,
        sub_recipes: parsed.subRecipes.length,
        recipes: parsed.recipes.length,
        recipe_lines: parsed.recipes.reduce((s, r) => s + r.lines.length, 0),
        sub_ref_lines: parsed.recipes.reduce((s, r) => s + r.lines.filter((l) => l.isSubRef).length, 0),
        ingredients_matched: matched.size,
        ingredients_unmatched: unmatched.length,
        sub_in_sub_skipped: subRefSkipped,
      },
      unmatched_ingredients: unmatched.slice(0, 100),
      unmatched_from_sheet: parsed.unmatchedReported,
      sample_recipes: parsed.recipes.slice(0, 5).map((r) => ({
        name: r.name,
        yield: `${r.yieldQty} ${r.yieldUnit}`,
        lines: r.lines.length,
        workbook_food_cost: Math.round(r.workbookFoodCost * 100) / 100,
      })),
    });
  } catch (e: any) {
    console.error('[recipe-workbook-import/preview]', e);
    return Response.json({ error: e.message || 'Failed to parse file' }, { status: 500 });
  }
}
