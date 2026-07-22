import { getDb } from '@/lib/db';

/**
 * GET /api/menu-items/export — the CURRENT menu as a CSV whose columns are
 * exactly what the menu import accepts (Category / Name / Selling Price /
 * Listing Price / Master Status / Item Type / Tax Value / Item Code / Station /
 * Dietary Tag / POS ID). Download → edit prices/stations/status in a
 * spreadsheet → re-upload via Import with Overwrite: a full round-trip, and
 * the living "sample menu in our platform's format".
 *
 * ?sample=1 returns a 5-row example file instead (for a brand-new setup).
 */
export const dynamic = 'force-dynamic';

const HEADERS = [
  'Category', 'Name', 'Selling Price', 'Listing Price', 'Master Status',
  'Item Type', 'Tax Value', 'Item Code', 'Station', 'Dietary Tag', 'POS ID',
];

const SAMPLE_ROWS: (string | number)[][] = [
  ['STARTERS NON-VEG', 'ANGARA KEBAB',          545, 545, 'Active', 'foods',     5, 'AK01', 'tandoor',      'Non-Veg', ''],
  ['VEG - MAIN COURSE', 'PANEER BUTTER MASALA', 425, 425, 'Active', 'foods',     5, 'PB02', 'indian',       'Veg',     ''],
  ['PIZZAS',            'MARGHERITA NSP',        399, 399, 'Active', 'foods',    5, 'MG03', 'pizza',        'Veg',     ''],
  ['BAR',               'PEG - BLENDERS PRIDE',  280, 280, 'Active', 'liquors',  0, '',     'bar',          '',        ''],
  ['BEVERAGES',         'FRESH LIME SODA',       120, 120, 'Active', 'beverages', 5, '',    'continental',  'Veg',     ''],
];

function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const sample = url.searchParams.get('sample') === '1';

    let rows: (string | number)[][];
    if (sample) {
      rows = SAMPLE_ROWS;
    } else {
      const db = getDb();
      const items = db.prepare(`
        SELECT category, name, selling_price, listing_price, is_active,
               item_type, tax_value, item_code, station, dietary_tag, pos_id
        FROM menu_items
        ORDER BY category COLLATE NOCASE, name COLLATE NOCASE
      `).all() as any[];
      rows = items.map((i) => [
        i.category || '', i.name, i.selling_price ?? 0, i.listing_price ?? 0,
        i.is_active ? 'Active' : 'Inactive', i.item_type || 'foods',
        i.tax_value ?? 0, i.item_code || '', i.station || '', i.dietary_tag || '', i.pos_id || '',
      ]);
    }

    const csv = [HEADERS, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
    const today = new Date().toISOString().slice(0, 10);
    const fname = sample ? 'menu-sample-template.csv' : `menu-items-${today}.csv`;
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fname}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
