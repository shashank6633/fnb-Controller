import { getDb, recalculateRecipeCost, logAuditEvent } from '@/lib/db';
import { requireRole, getCurrentOutletId } from '@/lib/auth';

/**
 * RECIPE PRICE RECONCILIATION — /api/admin/recipe-price-reconcile
 *
 * Two prices existed for one dish and nothing reconciled them:
 * recipes.selling_price (typed into the recipe form, charged to nobody) and
 * menu_items.selling_price (what the guest is billed). Costing now divides by
 * the MENU price whenever a link exists (src/lib/recipe-price.ts), and every
 * read surface DERIVES its percentage from that price rather than trusting the
 * recipes.food_cost_percent cache — so what the owner READS is already right.
 * Two stale things remain on disk: recipes.selling_price, which shows up in the
 * costing workbook export, auto-fills manual sales entry (src/app/sales/page.tsx)
 * and becomes the live price again the moment the recipe is unlinked; and the
 * cached food_cost_percent on any recipe not re-costed since. This route fixes
 * both, per row, on the admin's explicit tick.
 *
 * It is:
 *
 *   • ADMIN ONLY.
 *   • DRY RUN FIRST — GET lists every drifted recipe with both prices and both
 *     food-cost percentages, and writes nothing.
 *   • EXPLICIT — POST applies ONLY the recipe ids the admin ticked. There is no
 *     "apply everything" shortcut on the server; the client sends the ids it
 *     showed him.
 *   • NOT A MIGRATION — nothing here runs at boot, on deploy, or on a timer.
 *     No caller other than the admin's own click exists.
 *   • AUDITED — one recipe.price_reconcile event per recipe, with before/after.
 *
 * It deliberately does NOT touch CATEGORY. 13 of 18 linked pairs disagree on
 * category only in spelling (recipes are Title Case "Small Plates Veg", menu
 * items are slugs "small-plates-veg"), and picking a winner would silently
 * re-bucket the recipe book under a taxonomy nobody chose. The differences are
 * REPORTED here so the owner can see them; changing them stays his decision.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface DriftRow {
  recipe_id: string;
  recipe_name: string;
  recipe_category: string;
  /** recipes.selling_price — the stale stored number. */
  recipe_price: number;
  menu_item_id: string;
  menu_item_name: string;
  menu_item_category: string;
  /** menu_items.selling_price — what the guest actually pays. */
  menu_price: number;
  total_cost: number;
  /** What FC% WOULD read if the recipe's own price were the denominator. */
  fc_at_recipe_price: number;
  /** What FC% reads today — cost ÷ the menu price. */
  fc_at_menu_price: number;
  /** menu_price − recipe_price. */
  price_delta: number;
  linked_count: number;
  category_differs: boolean;
  /** True when recipes.selling_price is 0 — never priced, not merely stale. */
  recipe_price_unset: boolean;
  /** recipes.food_cost_percent as it SITS on disk right now (the cache). */
  stored_fc: number;
  /** True when that cached number disagrees with fc_at_menu_price. */
  stored_fc_stale: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function fc(cost: number, price: number): number {
  return price > 0 ? r2((cost / price) * 100) : 0;
}

/**
 * Every recipe whose OWN stored price disagrees with the live menu item it is
 * linked to. Mirrors the tie-break in src/lib/recipe-price.ts: among live
 * priced listings the LOWEST wins, so the row shown is the one actually driving
 * the recipe's food cost.
 */
function findDrift(db: any): DriftRow[] {
  const rows = db.prepare(`
    SELECT
      r.id            AS recipe_id,
      r.name          AS recipe_name,
      r.category      AS recipe_category,
      r.selling_price AS recipe_price,
      r.total_cost    AS total_cost,
      r.food_cost_percent AS stored_fc,
      mi.id           AS menu_item_id,
      mi.name         AS menu_item_name,
      mi.category     AS menu_item_category,
      mi.selling_price AS menu_price,
      (SELECT COUNT(*) FROM menu_items x
        WHERE x.recipe_id = r.id AND x.is_active = 1) AS linked_count
    FROM recipes r
    JOIN menu_items mi ON mi.recipe_id = r.id
    WHERE r.is_active = 1
      AND mi.is_active = 1
      AND mi.selling_price > 0
      -- the lowest-priced live listing is the one costing uses
      AND mi.selling_price = (
        SELECT MIN(y.selling_price) FROM menu_items y
        WHERE y.recipe_id = r.id AND y.is_active = 1 AND y.selling_price > 0
      )
    GROUP BY r.id
    ORDER BY ABS(COALESCE(mi.selling_price, 0) - COALESCE(r.selling_price, 0)) DESC, r.name ASC
  `).all() as any[];

  return rows
    .map((x): DriftRow => {
      const recipePrice = Number(x.recipe_price) || 0;
      const menuPrice = Number(x.menu_price) || 0;
      const cost = Number(x.total_cost) || 0;
      return {
        recipe_id: x.recipe_id,
        recipe_name: x.recipe_name,
        recipe_category: x.recipe_category || '',
        recipe_price: recipePrice,
        menu_item_id: x.menu_item_id,
        menu_item_name: x.menu_item_name,
        menu_item_category: x.menu_item_category || '',
        menu_price: menuPrice,
        total_cost: cost,
        fc_at_recipe_price: fc(cost, recipePrice),
        fc_at_menu_price: fc(cost, menuPrice),
        price_delta: r2(menuPrice - recipePrice),
        linked_count: Number(x.linked_count) || 1,
        category_differs: (x.recipe_category || '').trim() !== (x.menu_item_category || '').trim(),
        recipe_price_unset: recipePrice <= 0,
        stored_fc: Number(x.stored_fc) || 0,
        // The cache on disk vs the truth every screen now renders. A recipe
        // nobody has re-costed since the rule changed still holds the old
        // number here; screens derive theirs, so they already agree with
        // fc_at_menu_price — this flag says the DISK is behind, not the screen.
        stored_fc_stale: Math.round((Number(x.stored_fc) || 0) * 100) !== Math.round(fc(cost, menuPrice) * 100),
      };
    })
    // Compare in paise — a float tail is not a pricing disagreement.
    .filter((d) => Math.round(d.recipe_price * 100) !== Math.round(d.menu_price * 100));
}

/** DRY RUN. Reads only. */
export async function GET() {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const db = getDb();
  const rows = findDrift(db);

  // Category differences are reported, never changed — see the header note.
  const categoryOnly = db.prepare(`
    SELECT r.name AS recipe_name, r.category AS recipe_category, mi.category AS menu_item_category
    FROM recipes r JOIN menu_items mi ON mi.recipe_id = r.id
    WHERE r.is_active = 1 AND mi.is_active = 1
      AND TRIM(COALESCE(r.category, '')) <> TRIM(COALESCE(mi.category, ''))
    ORDER BY r.name
  `).all() as any[];

  const staleCache = rows.filter((r) => r.stored_fc_stale).length;

  return Response.json({
    dry_run: true,
    wrote: 'nothing',
    count: rows.length,
    stale_cached_fc: staleCache,
    rows,
    category_mismatches: categoryOnly.length,
    category_rows: categoryOnly,
    notice:
      'Every screen and export shows food cost measured against the MENU price — the price the guest pays — so the percentages you see ' +
      'are already right, whether or not you apply anything here. Two things are still worth fixing. ' +
      (staleCache
        ? `${staleCache} of these ${rows.length} recipes also still hold an out-of-date food cost in the database itself (the "on disk" column) — ` +
          'harmless to what you read on screen, but applying the row rewrites it so the stored figure matches. '
        : '') +
      'And the recipe’s own stored price stays stale until applied, which matters for the costing workbook export, manual sales entry, ' +
      'and what the recipe falls back to the moment it is unlinked. Nothing is written until you apply.',
    category_notice:
      'Category differences are listed for information only and are NEVER changed by this tool. Recipes use Title Case and menu items use slugs, ' +
      'so most of these are the same category spelled two ways — picking a winner would re-bucket the recipe book under a taxonomy nobody chose.',
  });
}

/** APPLY — only the recipe ids explicitly sent. */
export async function POST(request: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'A JSON body with recipe_ids is required' }, { status: 400 });
  }

  const ids: string[] = Array.isArray(body?.recipe_ids)
    ? [...new Set(body.recipe_ids.map((v: any) => String(v ?? '').trim()).filter(Boolean))] as string[]
    : [];

  // No ids ⇒ no work. There is deliberately no "all" flag: the admin applies
  // what he reviewed, and an empty request must never be read as "everything".
  if (!ids.length) {
    return Response.json(
      { error: 'recipe_ids is required and must be a non-empty array. Review the dry run and tick the recipes to align.' },
      { status: 400 },
    );
  }

  const db = getDb();
  const outletId = await getCurrentOutletId();

  // Re-derive drift server-side. The client's numbers are a display; the write
  // uses what the database says RIGHT NOW, so a price changed since the dry run
  // cannot be clobbered with a stale figure the admin never saw.
  const drift = findDrift(db);
  const byId = new Map(drift.map((d) => [d.recipe_id, d]));

  const applied: Array<{ recipe_id: string; recipe_name: string; from: number; to: number; fc_before: number; fc_after: number }> = [];
  const skipped: Array<{ recipe_id: string; reason: string }> = [];

  const run = db.transaction(() => {
    for (const id of ids) {
      const d = byId.get(id);
      if (!d) {
        skipped.push({
          recipe_id: id,
          reason: 'no longer drifted — the recipe is unlinked, delisted, or the two prices already agree. Nothing written.',
        });
        continue;
      }

      const before = db.prepare('SELECT selling_price, food_cost_percent, profit FROM recipes WHERE id = ?').get(id) as any;

      db.prepare(`UPDATE recipes SET selling_price = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(d.menu_price, id);

      // Re-cost so the stored profit / food_cost_percent cache agrees with the
      // new stored price. The percentage on screen does not move (screens
      // derive it from the menu price already); what moves is the number ON
      // DISK, which on an un-recosted recipe was still the old denominator's.
      recalculateRecipeCost(db, id);

      const after = db.prepare('SELECT selling_price, food_cost_percent FROM recipes WHERE id = ?').get(id) as any;

      logAuditEvent(db, {
        event_type: 'recipe.price_reconcile',
        entity_type: 'recipe',
        entity_id: id,
        actor_email: auth.user.email,
        outlet_id: outletId,
        before: { selling_price: before?.selling_price ?? null, food_cost_percent: before?.food_cost_percent ?? null },
        after: { selling_price: after?.selling_price ?? null, food_cost_percent: after?.food_cost_percent ?? null },
        note:
          `Recipe "${d.recipe_name}" selling price aligned to linked menu item "${d.menu_item_name}": ` +
          `₹${d.recipe_price} → ₹${d.menu_price}. Reviewed and applied by hand from the price reconciliation dry run. ` +
          `Food cost % on screen was already measured against the menu price; this aligns the recipe's own stored price and refreshes the cached food_cost_percent/profit on disk.`,
      });

      applied.push({
        recipe_id: id,
        recipe_name: d.recipe_name,
        from: d.recipe_price,
        to: d.menu_price,
        fc_before: d.fc_at_recipe_price,
        fc_after: d.fc_at_menu_price,
      });
    }
  });
  run();

  return Response.json({
    applied: applied.length,
    skipped: skipped.length,
    applied_rows: applied,
    skipped_rows: skipped,
    wrote: 'recipes.selling_price (+ recomputed total_cost/profit/food_cost_percent) and audit_events. No menu item, sale, or inventory row was changed.',
  });
}
