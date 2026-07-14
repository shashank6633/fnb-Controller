import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Bulk priority-star tools for raw materials (3★ critical / 2★ standard / 1★ low).
 *
 * POST /api/inventory/priority   (admin / store manager; CSRF via /api/inventory prefix)
 *   { mode: 'category', categories: string[], priority: 1|2|3, dryRun?: boolean }
 *       → dryRun: { count }            (materials that WOULD be touched)
 *       → apply : { applied }          (UPDATE ... WHERE category IN — same WHERE)
 *   { mode: 'suggest' }
 *       → { rows: [{ id, sku, name, category, current, suggested, reason }] }
 *         Pure-SQL "Smart suggest" heuristic — NO LLM call:
 *           3★  (top-25% consumption frequency last 30d  OR  ingredient of ≥3
 *                active recipes/sub-recipes)  AND reorder_level > 0
 *           1★  zero consumption in 90d AND not in any recipe
 *           2★  everything else
 *         Consumption events = issued requisition lines + negative inventory
 *         transactions (same sources as the CRM daily-use math).
 *         Only rows whose suggestion differs from the current value are returned.
 *   { mode: 'apply', rows: [{ id, priority }] }
 *       → { applied }                  (per-row apply after the preview untick)
 */
export const dynamic = 'force-dynamic';

const VALID_STARS = [1, 2, 3];

function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && !me.is_store_manager) {
      return Response.json({ error: 'Admin / store manager only' }, { status: 403 });
    }
    const db = getDb();
    const body = await request.json().catch(() => ({}));
    const mode = String(body?.mode || '');

    /* ── by category ─────────────────────────────────────────────────── */
    if (mode === 'category') {
      const categories: string[] = Array.isArray(body?.categories)
        ? body.categories.map((c: unknown) => String(c).trim()).filter(Boolean)
        : [];
      const priority = Number(body?.priority);
      if (categories.length === 0) return Response.json({ error: 'categories array required' }, { status: 400 });
      if (!VALID_STARS.includes(priority)) return Response.json({ error: 'priority must be 1, 2 or 3' }, { status: 400 });

      // Identical WHERE for preview and apply so the preview count always
      // equals the applied row count. COLLATE NOCASE mirrors /api/inventory's
      // category matching.
      const placeholders = categories.map(() => '?').join(',');
      const whereSql = `category COLLATE NOCASE IN (${placeholders})`;

      if (body?.dryRun) {
        const n = (db.prepare(`SELECT COUNT(*) AS n FROM raw_materials WHERE ${whereSql}`)
          .get(...categories) as any)?.n || 0;
        return Response.json({ count: Number(n) });
      }
      const res = db.prepare(
        `UPDATE raw_materials SET priority = ?, updated_at = datetime('now') WHERE ${whereSql}`,
      ).run(priority, ...categories);
      return Response.json({ applied: res.changes });
    }

    /* ── smart suggest (pure SQL heuristic, no LLM) ──────────────────── */
    if (mode === 'suggest') {
      const d30 = daysAgoIso(29);
      const d90 = daysAgoIso(89);

      // Consumption event frequency — issued requisition lines + negative
      // inventory transactions (sales deductions / wastage / adjustments).
      const freqSql = (since: string) => db.prepare(`
        SELECT material_id AS id, COUNT(*) AS n FROM (
          SELECT ri.material_id
          FROM requisition_items ri
          JOIN requisitions r ON r.id = ri.req_id
          WHERE ri.quantity_issued > 0
            AND r.status NOT IN ('cancelled','chef_rejected','draft')
            AND COALESCE(NULLIF(SUBSTR(ri.issued_at,1,10),''), r.date) >= ?
          UNION ALL
          SELECT it.material_id
          FROM inventory_transactions it
          WHERE it.quantity < 0 AND SUBSTR(it.created_at,1,10) >= ?
        ) GROUP BY material_id
      `).all(since, since) as { id: string; n: number }[];

      const freq30 = new Map(freqSql(d30).map(r => [r.id, r.n]));
      const consumed90 = new Set(freqSql(d90).map(r => r.id));

      // Distinct ACTIVE recipes + sub-recipes each material appears in.
      const recipeUse = new Map<string, number>();
      for (const r of db.prepare(`
        SELECT material_id AS id, COUNT(*) AS n FROM (
          SELECT DISTINCT ri.material_id, 'r' || ri.recipe_id AS ref
          FROM recipe_ingredients ri
          JOIN recipes rc ON rc.id = ri.recipe_id AND COALESCE(rc.is_active,1) = 1
          UNION
          SELECT DISTINCT sri.material_id, 's' || sri.sub_recipe_id AS ref
          FROM sub_recipe_ingredients sri
          JOIN sub_recipes sr ON sr.id = sri.sub_recipe_id AND COALESCE(sr.is_active,1) = 1
        ) GROUP BY material_id
      `).all() as { id: string; n: number }[]) recipeUse.set(r.id, r.n);

      // Top-25% consumption frequency threshold (among materials WITH events).
      const counts = [...freq30.values()].sort((a, b) => b - a);
      const topQuarterCut = counts.length > 0
        ? counts[Math.max(0, Math.ceil(counts.length * 0.25) - 1)]
        : Infinity;

      const mats = db.prepare(`
        SELECT id, sku, name, category, reorder_level,
               COALESCE(priority, 2) AS priority
        FROM raw_materials
        ORDER BY name COLLATE NOCASE
      `).all() as any[];

      const rows: any[] = [];
      for (const m of mats) {
        const n30 = freq30.get(m.id) || 0;
        const recipes = recipeUse.get(m.id) || 0;
        const hot = n30 > 0 && n30 >= topQuarterCut;
        let suggested: number;
        let reason: string;
        if ((hot || recipes >= 3) && m.reorder_level > 0) {
          suggested = 3;
          const why = [
            hot ? `top-25% consumption (${n30} issue${n30 === 1 ? '' : 's'}/30d)` : '',
            recipes >= 3 ? `in ${recipes} active recipes` : '',
          ].filter(Boolean).join(' + ');
          reason = `${why}, reorder level set`;
        } else if (!consumed90.has(m.id) && recipes === 0) {
          suggested = 1;
          reason = 'no consumption in 90d, not in any recipe';
        } else {
          suggested = 2;
          const bits = [
            n30 > 0 ? `${n30} issue${n30 === 1 ? '' : 's'}/30d` : (consumed90.has(m.id) ? 'some use in 90d' : 'no recent use'),
            recipes > 0 ? `in ${recipes} recipe${recipes === 1 ? '' : 's'}` : '',
            (hot || recipes >= 3) && !(m.reorder_level > 0) ? 'no reorder level (blocks 3★)' : '',
          ].filter(Boolean).join(', ');
          reason = `standard activity — ${bits}`;
        }
        if (suggested !== Number(m.priority)) {
          rows.push({
            id: m.id, sku: m.sku || '', name: m.name, category: m.category,
            current: Number(m.priority), suggested, reason,
          });
        }
      }
      return Response.json({ rows, threshold_30d_issues: topQuarterCut === Infinity ? null : topQuarterCut });
    }

    /* ── per-row apply (after preview untick) ────────────────────────── */
    if (mode === 'apply') {
      const rows: any[] = Array.isArray(body?.rows) ? body.rows : [];
      if (rows.length === 0) return Response.json({ error: 'rows array required' }, { status: 400 });
      for (const r of rows) {
        if (!r?.id || !VALID_STARS.includes(Number(r.priority))) {
          return Response.json({ error: 'each row needs { id, priority: 1|2|3 }' }, { status: 400 });
        }
      }
      let applied = 0;
      const upd = db.prepare(`UPDATE raw_materials SET priority = ?, updated_at = datetime('now') WHERE id = ?`);
      const txn = db.transaction(() => {
        for (const r of rows) applied += upd.run(Number(r.priority), String(r.id)).changes;
      });
      txn();
      return Response.json({ applied });
    }

    return Response.json({ error: `Unknown mode "${mode}" — use category | suggest | apply` }, { status: 400 });
  } catch (e: any) {
    console.error('[/api/inventory/priority]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
