import { getDb, generateId } from '@/lib/db';

/**
 * Reconcile an item's GST fields so they always agree (the bill engine sums the
 * combined tax_value per line). If explicit CGST/SGST are provided, the combined
 * value is their sum; if only a combined value arrives (e.g. CSV import), it is
 * split 50/50. Liquor is typically 0 (already taxed at source).
 */
function splitGst(
  cgstIn: unknown, sgstIn: unknown, combinedIn: unknown, r2: (n: number) => number,
): { cgst: number; sgst: number; combined: number } {
  const hasSplit = cgstIn !== undefined && cgstIn !== null || sgstIn !== undefined && sgstIn !== null;
  if (hasSplit) {
    const cgst = Math.max(0, r2(Number(cgstIn) || 0));
    const sgst = Math.max(0, r2(Number(sgstIn) || 0));
    return { cgst, sgst, combined: r2(cgst + sgst) };
  }
  const combined = Math.max(0, r2(Number(combinedIn) || 0));
  const cgst = r2(combined / 2);
  return { cgst, sgst: r2(combined - cgst), combined };
}

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const category = url.searchParams.get('category');
    const station = url.searchParams.get('station');
    const itemType = url.searchParams.get('item_type');
    const search = url.searchParams.get('search');
    const activeOnly = url.searchParams.get('active_only') === 'true';

    let query = `
      SELECT mi.*,
        r.total_cost as recipe_cost,
        r.food_cost_percent as recipe_food_cost_percent,
        rm.name as material_name,
        rm.average_price as material_cost
      FROM menu_items mi
      LEFT JOIN recipes r ON mi.recipe_id = r.id
      LEFT JOIN raw_materials rm ON mi.material_id = rm.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (category) { query += ' AND mi.category = ?'; params.push(category); }
    if (station) { query += ' AND mi.station = ?'; params.push(station); }
    if (itemType) { query += ' AND mi.item_type = ?'; params.push(itemType); }
    if (activeOnly) { query += ' AND mi.is_active = 1'; }
    if (search) { query += ' AND mi.name LIKE ?'; params.push(`%${search}%`); }

    query += ' ORDER BY mi.category, mi.name';

    const items = db.prepare(query).all(...params) as any[];

    // Summary stats
    const allItems = db.prepare('SELECT * FROM menu_items').all() as any[];
    const summary = {
      total: allItems.length,
      active: allItems.filter(i => i.is_active).length,
      inactive: allItems.filter(i => !i.is_active).length,
      foods: allItems.filter(i => i.item_type === 'foods').length,
      liquors: allItems.filter(i => i.item_type === 'liquors').length,
      beverages: allItems.filter(i => i.item_type === 'beverages').length,
      withRecipe: allItems.filter(i => i.recipe_id).length,
      withMaterial: allItems.filter(i => i.material_id).length,
      noPrice: allItems.filter(i => !i.selling_price || i.selling_price === 0).length,
      noCategory: allItems.filter(i => !i.category).length,
      noStation: allItems.filter(i => !i.station).length,
      noDietaryTag: allItems.filter(i => i.item_type === 'foods' && !i.dietary_tag).length,
    };

    // Available categories & stations for filter dropdowns
    const categories = [...new Set(allItems.map(i => i.category).filter(Boolean))].sort();
    const stations = [...new Set(allItems.map(i => i.station).filter(Boolean))].sort();

    return Response.json({ items, summary, categories, stations });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { name, category, station, item_type, dietary_tag, selling_price, listing_price, item_code, tax_value, cgst_percent, sgst_percent, prep_minutes, is_active, recipe_id, material_id, notes,
            image_url, spice_level, tags, taste_sour, taste_sweet, taste_spicy, taste_tangy, serves, options } = body;

    if (!name) return Response.json({ error: 'name is required' }, { status: 400 });
    const clamp = (v: any, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
    const asJson = (v: any) => Array.isArray(v) ? JSON.stringify(v) : (typeof v === 'string' ? v : '');
    const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
    // Per-item GST. If explicit CGST/SGST come in, tax_value = their sum (kept in
    // sync for the bill engine). If only a combined tax_value arrives (import),
    // split it 50/50. Liquor typically 0 (already taxed at source).
    const tax = splitGst(cgst_percent, sgst_percent, tax_value, r2);

    const id = generateId();
    db.prepare(`
      INSERT INTO menu_items (id, name, category, station, item_type, dietary_tag, selling_price, listing_price, item_code, tax_value, cgst_percent, sgst_percent, prep_minutes, is_active, recipe_id, material_id, source, notes,
                              image_url, spice_level, tags, taste_sour, taste_sweet, taste_spicy, taste_tangy, serves, options, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      id, name, category || '', station || '', item_type || 'foods', dietary_tag || '',
      Number(selling_price) || 0, Number(listing_price) || 0, item_code || '', tax.combined, tax.cgst, tax.sgst,
      Number(prep_minutes) || 0, is_active === false ? 0 : 1, recipe_id || null, material_id || null, notes || '',
      (image_url || '').toString(), clamp(spice_level, 3), asJson(tags),
      clamp(taste_sour, 4), clamp(taste_sweet, 4), clamp(taste_spicy, 4), clamp(taste_tangy, 4), (serves || '').toString(), asJson(options)
    );

    const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
    return Response.json({ item }, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { id, ...fields } = body;

    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    const allowed = ['name', 'category', 'station', 'item_type', 'dietary_tag', 'selling_price', 'listing_price', 'item_code', 'tax_value', 'cgst_percent', 'sgst_percent', 'prep_minutes', 'is_active', 'recipe_id', 'material_id', 'notes',
      'image_url', 'spice_level', 'tags', 'taste_sour', 'taste_sweet', 'taste_spicy', 'taste_tangy', 'serves', 'options'];
    const updates: string[] = [];
    const values: any[] = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        updates.push(`${key} = ?`);
        // tags/options may arrive as arrays from the form → store as JSON text.
        let v: any = (key === 'tags' || key === 'options') && Array.isArray(fields[key]) ? JSON.stringify(fields[key]) : fields[key];
        values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
    }
    if (updates.length === 0) return Response.json({ error: 'no fields to update' }, { status: 400 });

    // Keep tax_value = cgst_percent + sgst_percent whenever either half is edited,
    // so the per-item bill engine (which sums tax_value per line) stays correct.
    if (fields.cgst_percent !== undefined || fields.sgst_percent !== undefined) {
      const cur = db.prepare('SELECT cgst_percent, sgst_percent FROM menu_items WHERE id = ?').get(id) as any;
      const cg = Math.max(0, Number(fields.cgst_percent ?? cur?.cgst_percent ?? 0) || 0);
      const sg = Math.max(0, Number(fields.sgst_percent ?? cur?.sgst_percent ?? 0) || 0);
      const txIdx = updates.findIndex(u => u.startsWith('tax_value ='));  // drop any caller-sent tax_value; we derive it
      if (txIdx >= 0) { updates.splice(txIdx, 1); values.splice(txIdx, 1); }
      updates.push('tax_value = ?');
      values.push(Math.round((cg + sg) * 100) / 100);
    }

    values.push(id);
    db.prepare(`UPDATE menu_items SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values);

    const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
    return Response.json({ item });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
    return Response.json({ success: true });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
