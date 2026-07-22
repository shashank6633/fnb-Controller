import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { listStores, floorReconciliation, overallReconciliation } from '@/lib/store-engine';

/**
 * GET /api/stores/reconciliation — the Sales-vs-Consumption RECONCILIATION
 * report per floor bar (multi-floor bar, Phase 2 — THE leak catcher).
 *
 * Query:
 *   from, to  — inclusive YYYY-MM-DD (IST). Required to compute; when either is
 *               missing the route still returns the floor-store list so the page
 *               can render its filters, with an empty result.
 *   storeId   — optional; scope to ONE floor store (else every active store).
 *
 * Gate: admin / manager / store-manager (is_store_manager) / HOD (is_head_chef)
 * ONLY — this report exposes cross-floor valuation, sold-through and variance
 * (unbilled leak) across every location, so it must never leak to floor-scoped
 * staff. Mirrors the consolidated-stock board gate.
 *
 * → {
 *     stores: [{ id, name, code, floor_label }]  — ACTIVE stores carrying a
 *              floor_label (the report's floor filter + the mapped bars),
 *     result: FloorReconResult | null            — floorReconciliation() output,
 *              per (floor store, material): expected (sold-through, pegs
 *              exploded) vs actual (physical opening+inflow−closing, or ledger
 *              outward when auto-deduct is ON), variance + ₹, plus the
 *              unattributed party-liquor draw. rows are ENRICHED here with
 *              purchase_unit + case_size + sku so the page can render the
 *              bottles+pegs (CBL) breakdown via pack-units fmtBreakdown.
 *     generated_at,
 *   }
 *
 * Read-only: floorReconciliation touches no stock; this route only reads and
 * decorates. No writes.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const canView =
      me.role === 'admin' || me.role === 'manager' || me.is_store_manager || me.is_head_chef;
    if (!canView) {
      return Response.json(
        { error: 'The reconciliation report is limited to admins, managers, store managers and HODs.' },
        { status: 403 },
      );
    }

    const db = getDb();

    // Floor filter + the mapped bars: active stores carrying a floor_label.
    // (An active store WITHOUT a floor_label can never be a sales target — it is
    // not offered as a floor here, though it may still surface as a scoped
    // result if requested by id.)
    const stores = listStores(db)
      .filter(s => !!s.is_active && String(s.floor_label || '').trim() !== '')
      .map(s => ({ id: s.id, name: s.name, code: s.code, floor_label: s.floor_label || '' }));

    const url = new URL(req.url);
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    const storeId = (url.searchParams.get('storeId') || '').trim();

    let result = null as ReturnType<typeof floorReconciliation> | null;
    if (from && to) {
      // storeId '__overall__' → whole-outlet pool (all sales vs all stock, no
      // floor attribution); else the per-floor report.
      result = storeId === '__overall__'
        ? overallReconciliation(db, { from, to })
        : floorReconciliation(db, { from, to, storeId: storeId || undefined });

      // Enrich each material row + the party rows with purchase_unit / case_size
      // / sku (not carried by the engine row) so the page can render the
      // Cases/Bottles/pegs breakdown (fmtBreakdown needs purchase_unit to label
      // bottles + case_size for the outer pack). One in-memory pass.
      const ids = new Set<string>();
      for (const r of result.rows) ids.add(r.material_id);
      for (const p of result.unattributed_party) ids.add(p.material_id);
      const meta = new Map<string, { purchase_unit: string; pack_size: number; case_size: number; sku: string }>();
      if (ids.size > 0) {
        const idList = [...ids];
        const ph = idList.map(() => '?').join(',');
        for (const m of db.prepare(`
          SELECT id, COALESCE(purchase_unit, '') AS purchase_unit,
                 COALESCE(pack_size, 1) AS pack_size,
                 COALESCE(case_size, 1) AS case_size, COALESCE(sku, '') AS sku
          FROM raw_materials WHERE id IN (${ph})
        `).all(...idList) as { id: string; purchase_unit: string; pack_size: number; case_size: number; sku: string }[]) {
          meta.set(m.id, {
            purchase_unit: m.purchase_unit || '',
            pack_size: Number(m.pack_size) || 1,
            case_size: Number(m.case_size) || 1,
            sku: m.sku || '',
          });
        }
      }
      const decorate = <T extends { material_id: string; unit: string; pack_size?: number }>(row: T) => {
        const m = meta.get(row.material_id);
        return {
          ...row,
          // fall back to the recipe unit when no distinct purchase unit is set,
          // matching pack-units' packFactor (unit === purchase_unit ⇒ no pack).
          purchase_unit: m?.purchase_unit || row.unit,
          // main rows carry pack_size from the engine; party rows do NOT — fill
          // it here so the page's CBL breakdown doesn't collapse to pack_size=1
          // (which turned a 2cs+9btl+450ml party draw into "2,100 cs").
          pack_size: Number(row.pack_size) || m?.pack_size || 1,
          case_size: m?.case_size || 1,
          sku: m?.sku || '',
        };
      };
      result = {
        ...result,
        rows: result.rows.map(decorate),
        unattributed_party: result.unattributed_party.map(decorate),
      } as typeof result;
    }

    return Response.json({
      stores,
      result,
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to load reconciliation' }, { status: 500 });
  }
}
