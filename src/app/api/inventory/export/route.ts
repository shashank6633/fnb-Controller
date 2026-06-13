import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

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
    lines.push(COLUMNS.join(','));
    for (const r of rows) {
      lines.push(COLUMNS.map(c => csvEscape(r[c])).join(','));
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
