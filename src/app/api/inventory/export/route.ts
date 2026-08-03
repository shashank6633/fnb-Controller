import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { packFactor } from '@/lib/pack-units';

/**
 * Export every raw_material as a round-trip CSV — every editable field
 * (with the material's `id` first so the import can update existing rows
 * cleanly). Admins / store managers edit in Excel, then upload back via
 * /api/inventory/round-trip-import.
 *
 * GET /api/inventory/export
 *   → 200 text/csv with Content-Disposition attachment
 *
 * NOTE: includes inactive rows too so a user can re-activate by editing
 * `is_active` from 0 → 1 in the spreadsheet. Excluding them would silently
 * drop them on the round-trip.
 */
export const dynamic = 'force-dynamic';

const COLUMNS = [
  'id',                       // immutable — required for round-trip update
  'sku',
  'name',
  'category',
  'unit',                     // recipe unit (g/ml/kg/...)
  'purchase_unit',
  'pack_size',
  'case_size',
  'reorder_level',            // in recipe units
  'priority',                 // 3 = critical / 2 = standard / 1 = low
  'costing_method',
  'average_price',            // ₹ per recipe unit
  'current_stock',            // read-only on import (informational)
  'super_category',
  'brand',
  'yield_percent',
  'tax_percent',
  'cess_percent',
  'standard_purchase_rate',
  'closing_cadence',
  'is_recipe_item',
  'is_direct_sell',
  'is_semifinished',
  'storage_location',
  'shelf_life_days',
];

function csvEscape(v: any): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// WIPE GUARD — do not "simplify" this back to a plain csvEscape().
// round-trip-import's coerce() skips an EMPTY cell (value preserved) but writes
// an explicit 0 for a cell containing '0'. These two columns are almost always
// 0 (they are set one material at a time, by hand, on the master), so exporting
// a literal '0' on every row turns any stale sheet into a loaded gun: Export
// today → edit one unrelated cell → Re-upload next week silently zeroes every
// GST%/cess% typed in between, and nothing in the app reads those columns loudly
// enough for anyone to notice. A blank cell means exactly what the 0 meant
// ("not set") and round-trips as a no-op instead. A non-zero rate still exports
// as its number, and a user who genuinely wants 18 → 0 types 0 themselves and it
// still writes 0 — the importer is deliberately left untouched.
const BLANK_WHEN_ZERO = new Set(['tax_percent', 'cess_percent']);

function csvCell(col: string, v: any): string {
  if (BLANK_WHEN_ZERO.has(col) && (v == null || Number(v) === 0)) return '';
  return csvEscape(v);
}

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return new Response('Sign in required', { status: 401 });
    if (me.role !== 'admin' && !me.is_store_manager) {
      return new Response('Admin / store manager only', { status: 403 });
    }
    const db = getDb();
    const rows = db.prepare(`SELECT ${COLUMNS.join(', ')} FROM raw_materials ORDER BY sku, name`).all() as any[];

    const lines: string[] = [];
    // avg_price_per_purchase_unit is a READ-ONLY display column (₹/BTL etc, =
    // average_price × pack_size when the purchase unit differs) so the CSV
    // matches what the UI shows. The round-trip import ignores unknown columns,
    // so it can never be written back — average_price stays the canonical
    // ₹/recipe-unit value.
    // INPUT HAZARD, deliberately handled with INFORMATIONAL columns only: the
    // writable columns (reorder_level, average_price) stay in RECIPE basis
    // because /api/inventory/round-trip-import writes them back verbatim —
    // converting them here would multiply every buffer and rate by pack_size on
    // the next round trip. The *_purchase_unit columns below are display-only
    // twins the importer ignores (not in WRITABLE_FIELDS), so a manager reading
    // the sheet sees the same numbers the screen shows without being able to
    // corrupt the stored basis by editing the wrong cell.
    lines.push([...COLUMNS, 'avg_price_per_purchase_unit', 'current_stock_purchase_unit', 'reorder_level_purchase_unit'].join(','));
    for (const r of rows) {
      // packFactor IS the both-halves guard (pack_size > 1 AND recipe unit ≠
      // purchase unit) — imported, never re-derived, so this sheet can't drift
      // from what the screens show.
      const pack = packFactor(r);
      const packed = pack > 1;
      const perPU = packed
        ? Math.round((r.average_price || 0) * pack * 100) / 100
        : (r.average_price ?? 0);
      const stockPU = packed
        ? Math.round(((r.current_stock || 0) / pack) * 1000) / 1000
        : (r.current_stock ?? 0);
      const reorderPU = packed
        ? Math.round(((r.reorder_level || 0) / pack) * 1000) / 1000
        : (r.reorder_level ?? 0);
      lines.push([...COLUMNS.map(c => csvCell(c, r[c])), csvEscape(perPU), csvEscape(stockPU), csvEscape(reorderPU)].join(','));
    }
    const csv = lines.join('\n') + '\n';

    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="raw-materials-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    console.error('[/api/inventory/export]', e);
    return new Response(e.message, { status: 500 });
  }
}
