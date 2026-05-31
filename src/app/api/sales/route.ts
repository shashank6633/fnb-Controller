import { getDb, generateId, deductInventoryForSale } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const billType = url.searchParams.get('bill_type');
    const itemName = url.searchParams.get('item_name') || url.searchParams.get('search');
    const category = url.searchParams.get('category');

    // Pagination + sort
    const limit  = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const sortParam = (url.searchParams.get('sort') || 'date').toLowerCase();
    const dirParam  = (url.searchParams.get('dir')  || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const sortColMap: Record<string, string> = {
      date: 's.date',
      item: 's.item_name',
      qty:  's.quantity_sold',
      revenue: 's.total_revenue',
      cost: 's.total_cost',
      bill_type: 's.bill_type',
    };
    const orderBy = sortColMap[sortParam] || 's.date';

    const whereParts: string[] = ['1=1'];
    const params: any[] = [];
    if (from)     { whereParts.push('s.date >= ?'); params.push(from); }
    if (to)       { whereParts.push('s.date <= ?'); params.push(to); }
    if (billType) { whereParts.push('s.bill_type = ?'); params.push(billType); }
    if (itemName) { whereParts.push('s.item_name LIKE ?'); params.push(`%${itemName}%`); }
    if (category) { whereParts.push("COALESCE(NULLIF(s.category, ''), 'Uncategorised') = ?"); params.push(category); }
    const WHERE = whereParts.join(' AND ');

    const totalRow = db.prepare(`
      SELECT COUNT(*) AS n
      FROM sales s
      WHERE ${WHERE}
    `).get(...params) as any;

    const sales = db.prepare(`
      SELECT s.*,
             r.total_cost AS recipe_cost,
             r.name       AS recipe_name,
             COALESCE(NULLIF(s.category, ''), 'Uncategorised') AS resolved_category
      FROM sales s
      LEFT JOIN recipes r    ON s.recipe_id = r.id
      WHERE ${WHERE}
      ORDER BY ${orderBy} ${dirParam}, s.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return Response.json({ sales, total: totalRow.n, limit, offset });
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

    // Remove related inventory transactions (audit-aware: keep or clean?)
    db.prepare('DELETE FROM inventory_transactions WHERE reference_id = ?').run(id);
    const result = db.prepare('DELETE FROM sales WHERE id = ?').run(id);
    return Response.json({ success: true, changes: result.changes });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { sales } = body;

    if (!sales || !Array.isArray(sales) || sales.length === 0) {
      return Response.json({ error: 'sales array is required' }, { status: 400 });
    }

    const createdSales: any[] = [];

    const createSales = db.transaction(() => {
      for (const sale of sales) {
        const {
          item_name, recipe_id, quantity_sold, bill_type, selling_price, date,
          sale_time, order_id, category, server, order_type,
          pos_item_id, pos_item_name, variant_name,
        } = sale;

        if (!item_name || !quantity_sold || !date) {
          throw new Error(`item_name, quantity_sold, and date are required for each sale`);
        }

        // Get recipe cost if recipe_id provided
        let recipeCost = 0;
        if (recipe_id) {
          const recipe = db.prepare('SELECT total_cost FROM recipes WHERE id = ?').get(recipe_id) as any;
          if (recipe) {
            recipeCost = recipe.total_cost;
          }
        }

        const total_cost = Math.round(recipeCost * quantity_sold * 100) / 100;
        const total_revenue = bill_type === 'normal'
          ? Math.round((selling_price || 0) * quantity_sold * 100) / 100
          : 0;

        const id = generateId();

        db.prepare(`
          INSERT INTO sales (id, item_name, recipe_id, quantity_sold, bill_type, selling_price,
                             total_revenue, total_cost, date, created_at,
                             sale_time, order_id, category, server, order_type,
                             pos_item_id, pos_item_name, variant_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
                  ?, ?, ?, ?, ?,
                  ?, ?, ?)
        `).run(
          id, item_name, recipe_id || null, quantity_sold, bill_type || 'normal',
          selling_price || 0, total_revenue, total_cost, date,
          sale_time || null, order_id || null, category || null, server || null, order_type || null,
          pos_item_id || null, pos_item_name || null, variant_name || null,
        );

        // Deduct inventory if recipe exists
        if (recipe_id) {
          deductInventoryForSale(db, recipe_id, quantity_sold, id, bill_type || 'normal');
        }

        createdSales.push(db.prepare('SELECT * FROM sales WHERE id = ?').get(id));
      }
    });

    createSales();

    return Response.json({ sales: createdSales }, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
