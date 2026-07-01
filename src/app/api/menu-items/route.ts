import { getDb, generateId } from '@/lib/db';

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
    const { name, category, station, item_type, dietary_tag, selling_price, listing_price, item_code, tax_value, prep_minutes, is_active, recipe_id, material_id, notes } = body;

    if (!name) return Response.json({ error: 'name is required' }, { status: 400 });

    const id = generateId();
    db.prepare(`
      INSERT INTO menu_items (id, name, category, station, item_type, dietary_tag, selling_price, listing_price, item_code, tax_value, prep_minutes, is_active, recipe_id, material_id, source, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, datetime('now'), datetime('now'))
    `).run(
      id, name, category || '', station || '', item_type || 'foods', dietary_tag || '',
      Number(selling_price) || 0, Number(listing_price) || 0, item_code || '', Number(tax_value) || 0,
      Number(prep_minutes) || 0, is_active === false ? 0 : 1, recipe_id || null, material_id || null, notes || ''
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

    const allowed = ['name', 'category', 'station', 'item_type', 'dietary_tag', 'selling_price', 'listing_price', 'item_code', 'tax_value', 'prep_minutes', 'is_active', 'recipe_id', 'material_id', 'notes'];
    const updates: string[] = [];
    const values: any[] = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        updates.push(`${key} = ?`);
        values.push(typeof fields[key] === 'boolean' ? (fields[key] ? 1 : 0) : fields[key]);
      }
    }
    if (updates.length === 0) return Response.json({ error: 'no fields to update' }, { status: 400 });

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
