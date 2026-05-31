import { getDb } from '@/lib/db';

/**
 * Download the current unit-audit state as CSV. Pairs with POST /import to
 * round-trip: download → edit in Excel → re-upload. Also doubles as a
 * disaster-recovery snapshot you can hand to a fresh DB.
 *
 * Format: one row per raw_material, plus columns for the locked snapshot if
 * one exists. The lock cells are the authoritative ones — `current_*` are the
 * live raw_material values for reference.
 */
export const dynamic = 'force-dynamic';

function csvEscape(v: any): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export async function GET() {
  try {
    const db = getDb();
    // Left-join the lock so unlocked rows still export (locked cols blank → admin
    // can fill them and re-upload to create the lock).
    const rows = db.prepare(`
      SELECT
        rm.id, rm.sku, rm.name, rm.category,
        rm.unit          AS current_recipe_unit,
        rm.purchase_unit AS current_purchase_unit,
        rm.pack_size     AS current_pack_size,
        COALESCE(rm.case_size, 1) AS current_case_size,
        ual.recipe_unit   AS locked_recipe_unit,
        ual.purchase_unit AS locked_purchase_unit,
        ual.pack_size     AS locked_pack_size,
        ual.case_size     AS locked_case_size,
        ual.category      AS locked_category,
        ual.locked_by, ual.locked_at, ual.updated_at AS lock_updated_at,
        (CASE WHEN ual.id IS NULL THEN 0 ELSE 1 END) AS has_lock
      FROM raw_materials rm
      LEFT JOIN unit_audit_locks ual
        ON (ual.sku IS NOT NULL AND ual.sku = rm.sku)
        OR (ual.sku IS NULL AND ual.name_key = LOWER(TRIM(rm.name)))
      ORDER BY rm.name ASC
    `).all() as any[];

    const headers = [
      'sku', 'name', 'category',
      // editable lock columns (these are what get applied on import)
      'recipe_unit', 'purchase_unit', 'pack_size', 'case_size',
      // read-only context (ignored on import; just for reference)
      'current_recipe_unit', 'current_purchase_unit', 'current_pack_size', 'current_case_size',
      'has_lock', 'locked_by', 'locked_at', 'lock_updated_at',
    ];
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push([
        csvEscape(r.sku),
        csvEscape(r.name),
        csvEscape(r.locked_category || r.category),
        csvEscape(r.locked_recipe_unit   ?? r.current_recipe_unit),
        csvEscape(r.locked_purchase_unit ?? r.current_purchase_unit),
        csvEscape(r.locked_pack_size     ?? r.current_pack_size),
        csvEscape(r.locked_case_size     ?? r.current_case_size),
        csvEscape(r.current_recipe_unit),
        csvEscape(r.current_purchase_unit),
        csvEscape(r.current_pack_size),
        csvEscape(r.current_case_size),
        csvEscape(r.has_lock),
        csvEscape(r.locked_by),
        csvEscape(r.locked_at),
        csvEscape(r.lock_updated_at),
      ].join(','));
    }
    const csv = lines.join('\n');
    const date = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="unit-audit-${date}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    console.error('[unit-audit/export]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
