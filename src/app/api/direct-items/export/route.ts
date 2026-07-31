import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { csvQty, toPurchaseQty } from '@/lib/pack-units';
import { csvEscape } from '../_lib/csv';
import { buildMappingRows } from '../_lib/mapping-rows';

/**
 * GET /api/direct-items/export — download EVERY direct-item mapping as CSV.
 *
 * Pairs with POST /api/direct-items/import for a full round trip:
 * download → fix the wrong rows in Excel → re-upload → preview → apply.
 *
 * WHAT IS IN IT, and why it is not "what is on screen"
 * ────────────────────────────────────────────────────
 * The screen's list is built FROM sales and then narrowed by min_sold and by POS
 * category. Exporting that would repeat the original bug: on this database 210
 * of 415 saved links have no sales rows at all and another 32 sold fewer than
 * five, so the owner would download a file missing over half of their own work
 * — and re-uploading it would look like the mappings had never been saved.
 *
 * So the export is built from the UNION of direct_item_links, menu_items that
 * already carry a material_id, and the sold items still waiting for a mapping
 * (see buildMappingRows). Dismissed rows are included — they are mappings too,
 * and the `dismissed` column round-trips.
 *
 * Query params:
 *   min_sold=N     unmapped sold items below N are left out (default 5; 0 = all)
 *   mapped_only=1  only rows that already have a saved mapping
 *
 * COLUMN CONTRACT: the first five columns are the EDITABLE ones — they are what
 * the importer reads. Everything after them is read-only context and is ignored
 * on import, so an owner can safely leave it in place (or delete the columns).
 *
 * UNITS: qty_per_unit is in the material's RECIPE unit (that is the stored
 * basis, and the number the app computes with), and the three columns right
 * after it declare that basis — recipe unit, purchase unit, pack size — plus a
 * `qty_per_unit_purchase` read-back so the purchase-unit figure is visible
 * without anyone having to do the division. Only the recipe column is editable;
 * a rounded purchase figure must never become the stored truth.
 */
export const dynamic = 'force-dynamic';

/** The editable columns, in order. Kept beside the importer's reader. */
const EDITABLE = ['item_name', 'material_sku', 'material_name', 'qty_per_unit', 'dismissed'] as const;

const CONTEXT = [
  'qty_per_unit_recipe_unit', 'material_purchase_unit', 'material_pack_size', 'qty_per_unit_purchase',
  'menu_items', 'menu_item_pos_ids', 'menu_item_count',
  'link_source', 'has_saved_mapping', 'missing',
  'no_sales', 'qty_sold', 'revenue', 'sales_rows', 'pos_category', 'pos_item_id', 'updated_at',
] as const;

export async function GET(request: Request) {
  try {
    // MANAGEMENT ONLY — same gate as the import this pairs with.
    //
    // The proxy 401s a GET with no session, but a signed-in STAFF user was
    // getting the whole file: 415 mappings with `qty_sold` and `revenue` per
    // item, ~110 KB of trading data in one click. That contradicts both the
    // sibling importer (Admin/Manager/HOD) and the rule the rest of the app
    // already follows — the table-wise Sales download on the Sales Dashboard is
    // isManagement-gated for exactly this reason. Reading a mapping on the page
    // stays open to everyone; bulk-downloading the revenue column does not.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!isManagement(me)) {
      return Response.json(
        { error: 'Downloading the full mapping sheet is restricted to Admin / Manager / HOD — it carries per-item sales and revenue.' },
        { status: 403 },
      );
    }

    const db = getDb();
    const url = new URL(request.url);
    const minSoldRaw = url.searchParams.get('min_sold');
    const rows = buildMappingRows(db, {
      minSold: minSoldRaw === null ? 5 : Number(minSoldRaw),
      mappedOnly: url.searchParams.get('mapped_only') === '1',
    });

    const lines: string[] = [[...EDITABLE, ...CONTEXT].join(',')];
    for (const r of rows) {
      const m = r.material;
      // Which half of the chain is missing — the actionable state, spelled out
      // so it can be sorted/filtered in Excel instead of eyeballed.
      const missing = [
        m ? null : 'raw material',
        r.menu_items.length ? null : 'menu item',
      ].filter(Boolean).join(' + ');
      lines.push([
        csvEscape(r.item_name),
        csvEscape(m?.sku || ''),
        csvEscape(m?.material_name || ''),
        csvEscape(csvQty(r.qty_per_unit)),
        csvEscape(r.dismissed ? 'yes' : 'no'),
        // ── read-only context ──
        csvEscape(m?.unit || ''),
        csvEscape(m ? (m.purchase_unit || m.unit) : ''),
        csvEscape(m ? csvQty(m.pack_size) : ''),
        csvEscape(m ? csvQty(toPurchaseQty(r.qty_per_unit, m)) : ''),
        csvEscape(r.menu_items.map(x => x.name).join(' | ')),
        csvEscape(r.menu_items.map(x => x.pos_id).filter(Boolean).join(' | ')),
        csvEscape(r.menu_items.length),
        csvEscape(r.link_source || ''),
        csvEscape(r.has_saved_mapping ? 'yes' : 'no'),
        csvEscape(missing),
        csvEscape(r.no_sales ? 'yes' : 'no'),
        csvEscape(csvQty(r.qty_sold)),
        csvEscape(Math.round((r.revenue || 0) * 100) / 100),
        csvEscape(r.sales_rows),
        csvEscape(r.pos_category),
        csvEscape(r.pos_item_id),
        csvEscape(r.updated_at || ''),
      ].join(','));
    }

    const date = new Date().toISOString().slice(0, 10);
    // Leading BOM so Excel opens the UTF-8 item names correctly.
    return new Response('﻿' + lines.join('\r\n') + '\r\n', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="direct-items-${date}.csv"`,
        'Cache-Control': 'no-store',
        'X-Row-Count': String(rows.length),
      },
    });
  } catch (error: any) {
    console.error('[/api/direct-items/export] error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
