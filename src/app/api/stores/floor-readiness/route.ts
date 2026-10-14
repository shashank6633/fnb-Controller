import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { listStores, resolveFloorStore, floorAutoDeductEnabled, catNorm } from '@/lib/store-engine';

/**
 * GET /api/stores/floor-readiness — read-only setup health check for the
 * Sales-vs-Consumption (floor) reconciliation. Answers "why is my floor
 * variance wrong / missing" by reporting every wiring gap:
 *
 *   - floor stores + their floor_label(s), whether they HOLD stock, and whether
 *     they have any closing counts (the physical-mode ACTUAL source),
 *   - every table ZONE and whether it maps to a floor store (unmapped zones =
 *     pours that attribute to NOTHING), + floor labels that match no zone,
 *   - auto-deduct on/off → which reconciliation MODE runs, and what that mode
 *     needs,
 *   - liquor materials that appear in NO recipe (a pour of them can't be
 *     predicted from sales → always reads as pure variance),
 *   - an overall verdict + a concrete issue list.
 *
 * Gate: admin / manager / store-manager / HOD — same as the reconciliation
 * report it complements. Read-only: no writes.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const canView = me.role === 'admin' || me.role === 'manager' || me.is_store_manager || me.is_head_chef;
    if (!canView) {
      return Response.json({ error: 'Floor readiness is limited to admins, managers, store managers and HODs.' }, { status: 403 });
    }

    const db = getDb();

    const autodeduct = floorAutoDeductEnabled(db);
    const mode: 'ledger' | 'physical' = autodeduct ? 'ledger' : 'physical';

    // ── Floor stores (active, carrying a floor_label) ────────────────────────
    const heldCount = db.prepare(
      'SELECT COUNT(DISTINCT material_id) AS n FROM store_stock_ledger WHERE store_id = ?',
    );
    const countStmt = db.prepare(
      "SELECT COUNT(*) AS n, MAX(date) AS last FROM store_closing_counts WHERE store_id = ?",
    );
    const floorStores = listStores(db)
      .filter(s => !!s.is_active && String(s.floor_label || '').trim() !== '')
      .map(s => {
        const labels = String(s.floor_label || '').split(',').map(x => x.trim()).filter(Boolean);
        const held = Number((heldCount.get(s.id) as any)?.n) || 0;
        const cc = countStmt.get(s.id) as any;
        return {
          id: s.id, name: s.name, code: s.code || '',
          labels,
          held_materials: held,
          has_stock: held > 0,
          closing_counts: Number(cc?.n) || 0,
          last_count_date: cc?.last || null,
        };
      });

    // ── Table zones → floor store mapping ────────────────────────────────────
    const zoneRows = db.prepare(
      "SELECT TRIM(zone) AS zone, COUNT(*) AS tables FROM restaurant_tables WHERE COALESCE(TRIM(zone),'') <> '' GROUP BY TRIM(zone) ORDER BY zone COLLATE NOCASE",
    ).all() as { zone: string; tables: number }[];
    const storeById = new Map(floorStores.map(s => [s.id, s]));
    const zones = zoneRows.map(z => {
      const fid = resolveFloorStore(db, z.zone);
      const store = fid ? storeById.get(fid) : null;
      return {
        zone: z.zone,
        tables: Number(z.tables) || 0,
        mapped: !!fid,
        store_id: fid || null,
        store_name: store?.name || null,
      };
    });
    const unmapped_zones = zones.filter(z => !z.mapped);

    // Floor labels that match NO table zone (a bar labelled for a zone that has
    // no tables → nothing can be sold there).
    const zoneKeys = new Set(zoneRows.map(z => z.zone.toLowerCase().trim()));
    const orphan_labels: { store: string; label: string }[] = [];
    for (const s of floorStores) {
      for (const lb of s.labels) {
        if (!zoneKeys.has(lb.toLowerCase().trim())) orphan_labels.push({ store: s.name, label: lb });
      }
    }

    // ── Recipe coverage for liquor materials ─────────────────────────────────
    // Liquor = any material whose category is mapped to an active category-owning
    // store (the same universe the floor catalog offers). A liquor material that
    // appears in NO recipe/sub-recipe can never be part of EXPECTED (sold-through),
    // so its pours always read as unexplained variance.
    const inRecipe = new Set(
      (db.prepare('SELECT DISTINCT material_id FROM recipe_ingredients UNION SELECT DISTINCT material_id FROM sub_recipe_ingredients').all() as any[])
        .map(r => String(r.material_id)),
    );
    const liquorMats = db.prepare(`
      SELECT rm.id, rm.name FROM raw_materials rm
      WHERE rm.is_active = 1 AND EXISTS (
        SELECT 1 FROM store_category_map m
        JOIN store_locations s ON s.id = m.store_id AND s.is_active = 1
        WHERE ${catNorm('m.category')} = ${catNorm('rm.category')}
      )
    `).all() as { id: string; name: string }[];
    const missing = liquorMats.filter(m => !inRecipe.has(String(m.id)));
    const recipe_coverage = {
      liquor_materials: liquorMats.length,
      in_recipe: liquorMats.length - missing.length,
      missing_recipe: missing.length,
      sample_missing: missing.slice(0, 12).map(m => m.name),
    };

    // ── Verdict ──────────────────────────────────────────────────────────────
    const issues: { severity: 'error' | 'warn' | 'info'; message: string }[] = [];
    if (floorStores.length === 0) {
      issues.push({ severity: 'error', message: 'No floor bars set up — give each floor bar a Floor label on Settings → Store Locations that matches its tables’ zone.' });
    }
    if (unmapped_zones.length > 0) {
      issues.push({ severity: 'error', message: `${unmapped_zones.length} table zone(s) map to no floor bar: ${unmapped_zones.map(z => `"${z.zone}"`).join(', ')}. Pours there attribute to nothing — set a matching Floor label on the floor store.` });
    }
    if (orphan_labels.length > 0) {
      issues.push({ severity: 'warn', message: `Floor label(s) matching no table zone: ${orphan_labels.map(o => `${o.store} → "${o.label}"`).join(', ')}. Check the label spelling matches the table zone exactly.` });
    }
    // MODE IS 'physical' FOR EVERY NEW PERIOD. The sale-driven floor auto-deduct
    // was removed by owner ruling on 2026-09-10 and tm_floor_autodeduct retired
    // to '0', so nothing writes floor sale rows any more. 'ledger' can only
    // surface on a database whose retirement migration has not run yet, and its
    // message says so rather than telling anyone to feed a dead rail.
    if (mode === 'ledger') {
      issues.push({ severity: 'error', message: 'This database still has the retired auto-deduct switch ON, so the report is summing floor sale rows that nothing writes any more (a sale has not moved floor stock since 2026-09-10). Restart the app to run the retirement migration — the report then measures each floor by counting instead.' });
    } else {
      const noCounts = floorStores.filter(s => s.closing_counts === 0);
      if (noCounts.length > 0) {
        issues.push({ severity: 'warn', message: `Floor usage is measured by counting, and ${noCounts.map(s => s.name).join(', ')} have no closing counts yet — each floor needs an opening and a closing count for the period, or its usage cannot be measured at all.` });
      }
    }
    if (recipe_coverage.missing_recipe > 0) {
      issues.push({ severity: 'warn', message: `${recipe_coverage.missing_recipe} liquor item(s) are in no recipe — a sale of them can't be predicted from menu sales, so their pours read as variance. (Fine if sold only as bottle service.)` });
    }

    const ready = floorStores.length > 0 && unmapped_zones.length === 0 &&
      issues.filter(i => i.severity === 'error').length === 0;

    return Response.json({
      ready,
      // `autodeduct` is reported for continuity of this response shape, and
      // because a stale '1' is itself a finding (see the issue above). The
      // switch is RETIRED (owner ruling 2026-09-10): it no longer moves stock
      // and /api/settings refuses to write it.
      autodeduct: {
        enabled: autodeduct,
        retired: true,
        mode,
        needs: mode === 'ledger'
          ? ['Restart to retire the auto-deduct switch', 'Zone → floor label mapping', 'Opening + closing physical counts per floor', 'Drinks have recipes']
          : ['Zone → floor label mapping', 'Opening + closing physical counts per floor', 'Drinks have recipes', 'Drinks rung up on POS per floor'],
      },
      floor_stores: floorStores,
      zones,
      unmapped_zones,
      orphan_labels,
      recipe_coverage,
      issues,
    });
  } catch (e: any) {
    console.error('[/api/stores/floor-readiness]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
