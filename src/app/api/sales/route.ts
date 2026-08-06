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

    const txn = db.transaction(() => {
      // Reverse the sale's stock deduction BEFORE erasing its audit trail,
      // otherwise current_stock stays deducted while the transactions that
      // explain it vanish (ledger-vs-stock reconciliation breaks forever).
      // Floor-routed portions (floor auto-deduct) live in store_stock_ledger
      // (ref = sale id) and never touched raw_materials.current_stock, so
      // restore only the central remainder and drop the ledger rows (store
      // stock = SUM of ledger, so removing them restores the floor).
      const floorRows = db.prepare(`
        SELECT material_id, COALESCE(SUM(quantity), 0) AS qty
        FROM store_stock_ledger WHERE ref = ? GROUP BY material_id
      `).all(id) as any[];
      const floorByMaterial = new Map<string, number>();
      for (const r of floorRows) floorByMaterial.set(r.material_id, r.qty);

      // THIRD RAIL, SAME SHAPE AS THE FLOOR ONE ABOVE. Recipe consumption now
      // debits the DEPARTMENT that cooked the dish, never central — the gram
      // already left the store on the requisition issue. So a department-
      // attributed portion, exactly like a floor-routed one, must be EXCLUDED
      // from the central restore below and given back to the rail it left.
      // Crediting central here would manufacture stock: the store never lost it.
      //
      // type = 'consumption' is load-bearing twice over. It excludes the party
      // rail (which writes 'consumed'/'received'/'returned' and owns its own
      // returns in party-fulfillment.ts), and it excludes the compensating
      // 'adjustment' rows this handler writes below — so a re-run can never read
      // its own credit back as a fresh debit. Do not widen it to "all rows for
      // this reference".
      const deptRows = db.prepare(`
        SELECT department_id, material_id, MAX(outlet_id) AS outlet_id,
               COALESCE(SUM(quantity), 0) AS qty
        FROM department_material_transactions
        WHERE reference_id = ? AND type = 'consumption'
        GROUP BY department_id, material_id
      `).all(id) as any[];
      // Summed ACROSS departments per material: one sale's ingredients can in
      // principle resolve to more than one department, and the central-restore
      // arithmetic needs the whole department portion, not the last one seen.
      const deptByMaterial = new Map<string, number>();
      for (const r of deptRows) {
        deptByMaterial.set(r.material_id, (deptByMaterial.get(r.material_id) || 0) + Number(r.qty || 0));
      }

      const txRows = db.prepare(`
        SELECT material_id, COALESCE(SUM(quantity), 0) AS qty
        FROM inventory_transactions WHERE reference_id = ? GROUP BY material_id
      `).all(id) as any[];
      const restoreStmt = db.prepare(
        'UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime(\'now\') WHERE id = ?'
      );
      for (const r of txRows) {
        const totalDeducted = -r.qty;                                   // deduction rows are negative
        const floorDeducted = -(floorByMaterial.get(r.material_id) || 0); // ledger deductions are negative too
        const deptDeducted  = -(deptByMaterial.get(r.material_id) || 0); // department rows are negative too
        // What central actually lost = the audit total minus the two rails that
        // were never central's. The inventory_transactions row is written on
        // EVERY path (db.ts applyDeduct keeps it unconditional so Variance and
        // Sales-vs-Purchase stay bit-identical), which is exactly why it is the
        // total and not the central figure.
        const centralDeducted = totalDeducted - floorDeducted - deptDeducted;
        // Epsilon, not `!== 0`: with three floating-point legs a fully
        // department-attributed sale lands on ~1e-16 rather than a clean zero,
        // and `!== 0` would post a meaningless sub-nanogram credit to central.
        if (Math.abs(centralDeducted) > 1e-9) restoreStmt.run(centralDeducted, r.material_id);
      }

      // Give the department its grams back as a signed, additive 'adjustment'
      // row. The consumption rows are deliberately NOT deleted — the movement
      // history for every issue, consumption and reversal has to stay auditable,
      // so a reversal is a new opposing movement, never an erasure.
      //
      // Gated on the sale still existing. The central and floor legs are
      // self-limiting (their rows are deleted below, so a second DELETE finds
      // nothing to restore), but the consumption rows survive by design — without
      // this guard a repeated DELETE would credit the department again on every
      // call and invent stock out of an audit trail.
      const saleExists = !!db.prepare('SELECT 1 FROM sales WHERE id = ?').get(id);
      if (saleExists) {
        for (const d of deptRows) {
          const back = -Number(d.qty || 0);   // consumption is negative → credit is positive
          if (!(back > 1e-9)) continue;       // never post a zero or a negative "credit"

          // department_materials.on_hand is a maintained CACHE and balance_after
          // is a display convenience — the truth is SUM(quantity) over the
          // ledger. Both are kept in step here only because party-fulfillment.ts
          // and the reconcile route still read them; do not make a decision from
          // either one.
          const cache = db.prepare(
            'SELECT id, on_hand FROM department_materials WHERE department_id = ? AND material_id = ?'
          ).get(d.department_id, d.material_id) as any;
          let balanceAfter: number;
          if (cache) {
            balanceAfter = (Number(cache.on_hand) || 0) + back;
            db.prepare("UPDATE department_materials SET on_hand = ?, updated_at = datetime('now') WHERE id = ?")
              .run(balanceAfter, cache.id);
          } else {
            balanceAfter = back;
            db.prepare(`
              INSERT INTO department_materials (id, outlet_id, department_id, material_id, on_hand)
              VALUES (?,?,?,?,?)
            `).run(generateId(), d.outlet_id || null, d.department_id, d.material_id, balanceAfter);
          }

          db.prepare(`
            INSERT INTO department_material_transactions
              (id, outlet_id, department_id, material_id, type, quantity, balance_after,
               reference_id, notes, user)
            VALUES (?,?,?,?,'adjustment',?,?,?,?,'')
          `).run(
            generateId(), d.outlet_id || null, d.department_id, d.material_id,
            back, balanceAfter, id,
            `Sale deleted (/api/sales DELETE) — recipe consumption returned to department`,
          );
        }
      }

      db.prepare('DELETE FROM store_stock_ledger WHERE ref = ?').run(id);
      db.prepare('DELETE FROM inventory_transactions WHERE reference_id = ?').run(id);
      return db.prepare('DELETE FROM sales WHERE id = ?').run(id).changes;
    });
    const changes = txn();
    return Response.json({ success: true, changes });
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

        // Deduct inventory if recipe exists.
        //
        // station: null is DELIBERATE, and it must stay explicit. Recipe
        // consumption now debits the DEPARTMENT that cooked the dish, resolved
        // from the line's station — and this route has no station to give. The
        // payload destructured above carries none, and `category` is free text
        // off the POS menu, not a kitchen. Resolving a department from
        // `category` (via departments.material_categories) would post black
        // pepper to the Bar and read as a loss in a kitchen that never saw the
        // dish. Guessing the wrong kitchen silently is worse than not deducting.
        //
        // Passing the key with a NULL value rather than omitting opts is what
        // makes applyDeduct record the skip as 'no_station_api' instead of
        // 'unmapped'. That distinction is the point: 'unmapped' is a config gap
        // the owner closes in the station→department mapping, 'no_station_api'
        // is an API-shaped gap no mapping can fix. Dropping the argument or
        // "tidying" it to undefined degrades the reason and sends the owner
        // hunting a mapping that was never the problem.
        if (recipe_id) {
          deductInventoryForSale(db, recipe_id, quantity_sold, id, bill_type || 'normal', { station: null });
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
