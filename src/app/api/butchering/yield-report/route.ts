import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Butchering yield report — aggregate yields by source material + cut over a date range.
 *
 * GET /api/butchering/yield-report?from=YYYY-MM-DD&to=YYYY-MM-DD&source_material_id=...
 *   Defaults: last 30 days, all source materials
 *
 * Returns per source material:
 *   - summary: batch count, total gross kg, total cost, avg waste %
 *   - cuts: [{ material_id, material_name, total_weight, avg_yield_pct,
 *              std_yield_min, std_yield_max, status: 'ok' | 'low' | 'high' }]
 *   - waste: { total_weight, total_pct }
 *
 * Standard yield bands come from `butchering_yield_standards` if the table
 * exists, otherwise from a hardcoded AKAN-mutton default.
 */
export const dynamic = 'force-dynamic';

// AKAN mutton standard yields (from the SOP). Maps a cut name pattern → [min%, max%].
// Match is case-insensitive substring on the cut's material name.
const MUTTON_STANDARD: { match: string; min: number; max: number }[] = [
  // NOTE: match is case-insensitive substring. Order matters — first hit wins.
  // AKAN uses Approach A (granular breakdown): each carcass is split into
  // Leg + Shoulder + Chops + Ribs + Mince + Offal + Bones (no combined
  // "boneless" bucket — that would double-count against Leg / Shoulder).
  { match: 'leg',      min: 24, max: 28 },
  { match: 'shoulder', min: 16, max: 19 },
  { match: 'chop',     min: 12, max: 14 },
  { match: 'rib',      min: 7,  max: 9  },
  { match: 'mince',    min: 14, max: 17 },
  { match: 'keema',    min: 14, max: 17 },
  { match: 'offal',    min: 4,  max: 6  },
  { match: 'liver',    min: 4,  max: 6  },
  { match: 'bone',     min: 8,  max: 10 },
];
const WASTE_TARGET_MAX_PCT = 10; // anything over this = red flag

function lookupStandard(materialName: string): { min: number; max: number } | null {
  const lower = (materialName || '').toLowerCase();
  for (const s of MUTTON_STANDARD) if (lower.includes(s.match)) return { min: s.min, max: s.max };
  return null;
}

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400_000);
    const from = url.searchParams.get('from') || thirtyDaysAgo.toISOString().slice(0, 10);
    const to   = url.searchParams.get('to')   || today.toISOString().slice(0, 10);
    const sourceId = url.searchParams.get('source_material_id') || null;

    const where: string[] = ["bb.status = 'closed'", "date(bb.closed_at) BETWEEN ? AND ?"];
    const params: any[] = [from, to];
    if (sourceId) { where.push('bb.source_material_id = ?'); params.push(sourceId); }

    // Pull the per-batch totals
    const batches = db.prepare(`
      SELECT bb.id, bb.batch_id, bb.source_material_id, bb.gross_weight, bb.total_cost,
             bb.butcher, bb.closed_at,
             rm.name AS source_material_name
      FROM butchering_batches bb
      JOIN raw_materials rm ON rm.id = bb.source_material_id
      WHERE ${where.join(' AND ')}
      ORDER BY bb.closed_at DESC
    `).all(...params) as any[];

    // For each source material, aggregate cuts and waste
    const bySource = new Map<string, {
      source_material_id: string;
      source_material_name: string;
      batch_count: number;
      total_gross_weight: number;
      total_cost: number;
      cuts: Map<string, { material_id: string; material_name: string; total_weight: number; weighted_yield_sum: number }>;
      total_waste_weight: number;
    }>();

    for (const b of batches) {
      if (!bySource.has(b.source_material_id)) {
        bySource.set(b.source_material_id, {
          source_material_id: b.source_material_id,
          source_material_name: b.source_material_name,
          batch_count: 0, total_gross_weight: 0, total_cost: 0,
          cuts: new Map(), total_waste_weight: 0,
        });
      }
      const agg = bySource.get(b.source_material_id)!;
      agg.batch_count += 1;
      agg.total_gross_weight += b.gross_weight || 0;
      agg.total_cost += b.total_cost || 0;

      const outs = db.prepare(`
        SELECT bo.*, rm.name AS material_name
        FROM butchering_outputs bo
        LEFT JOIN raw_materials rm ON rm.id = bo.material_id
        WHERE bo.batch_id = ?
      `).all(b.id) as any[];
      for (const o of outs) {
        if (o.output_type === 'cut' && o.material_id) {
          if (!agg.cuts.has(o.material_id)) {
            agg.cuts.set(o.material_id, {
              material_id: o.material_id, material_name: o.material_name,
              total_weight: 0, weighted_yield_sum: 0,
            });
          }
          const c = agg.cuts.get(o.material_id)!;
          c.total_weight += o.weight || 0;
          c.weighted_yield_sum += (o.yield_pct || 0) * (b.gross_weight || 0);
        } else if (o.output_type === 'waste') {
          agg.total_waste_weight += o.weight || 0;
        }
      }
    }

    // Shape final output
    const sources = Array.from(bySource.values()).map(agg => {
      const cuts = Array.from(agg.cuts.values()).map(c => {
        const avgYield = agg.total_gross_weight > 0 ? c.weighted_yield_sum / agg.total_gross_weight : 0;
        const std = lookupStandard(c.material_name);
        let status: 'ok' | 'low' | 'high' | 'unknown' = 'unknown';
        if (std) {
          status = avgYield < std.min ? 'low' : avgYield > std.max ? 'high' : 'ok';
        }
        return {
          material_id: c.material_id,
          material_name: c.material_name,
          total_weight: c.total_weight,
          avg_yield_pct: avgYield,
          std_yield_min: std?.min ?? null,
          std_yield_max: std?.max ?? null,
          status,
        };
      }).sort((a, b) => b.avg_yield_pct - a.avg_yield_pct);

      const wastePct = agg.total_gross_weight > 0 ? (agg.total_waste_weight / agg.total_gross_weight) * 100 : 0;
      return {
        source_material_id: agg.source_material_id,
        source_material_name: agg.source_material_name,
        batch_count: agg.batch_count,
        total_gross_weight: agg.total_gross_weight,
        total_cost: agg.total_cost,
        cuts,
        waste: {
          total_weight: agg.total_waste_weight,
          total_pct: wastePct,
          target_max_pct: WASTE_TARGET_MAX_PCT,
          status: wastePct > WASTE_TARGET_MAX_PCT ? 'high' : 'ok',
        },
      };
    });

    return Response.json({
      from, to,
      sources,
      batches: batches.map(b => ({
        id: b.id, batch_id: b.batch_id, source_material_name: b.source_material_name,
        gross_weight: b.gross_weight, total_cost: b.total_cost, butcher: b.butcher, closed_at: b.closed_at,
      })),
    });
  } catch (e: any) {
    console.error('[/api/butchering/yield-report]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
