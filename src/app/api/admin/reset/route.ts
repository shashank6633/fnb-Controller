import { getDb, logAuditEvent } from '@/lib/db';
import { requireRole, getCurrentOutletId } from '@/lib/auth';

/**
 * Admin-only data reset.
 *
 * Body: {
 *   confirm: "RESET",                  // must equal exactly — primitive guardrail
 *   scopes: Array<                     // pick one or more
 *     "sales" | "purchases" | "purchase_orders" | "closing_stock" | "recipes"
 *     | "inventory_unused"             // delete only materials nothing references
 *     | "inventory_all"                // delete ALL materials + cascade dependents
 *     | "all"
 *   >,
 *   from?:  "YYYY-MM-DD",              // optional date range — only delete rows
 *   to?:    "YYYY-MM-DD",              //   whose .date falls in [from, to].
 *                                      //   Omit both to wipe the full scope.
 *   wipe_master?: boolean              // if true with scope "all", also clears
 *                                      // raw_materials, recipes, sub_recipes, menu_items
 * }
 *
 * Outlet-scoped: only deletes rows belonging to the user's currently-selected outlet.
 * Master tables (raw_materials, recipes, menu_items, vendors, users, outlets) are
 * NOT outlet-scoped, so they're only touched if `wipe_master: true` is passed.
 *
 * Date filter rules:
 *   - sales:           filtered by sales.date BETWEEN ? AND ?
 *   - purchases:       filtered by purchases.date BETWEEN ? AND ?
 *   - purchase_orders: filtered by purchase_orders.date BETWEEN ? AND ?
 *   - closing_stock:   filtered by closing_stock.date BETWEEN ? AND ?
 *   - inventory_transactions: filtered indirectly via reference_id linkage to the
 *     parent sales/purchases rows that fall in range.
 *   - When date range is set, the wholesale `current_stock = 0` reset is skipped
 *     (we only credit/debit the affected rows so partial-period reset is consistent).
 *
 * Returns: { deleted: { sales: 1234, purchases: 567, ... }, recipes_recomputed: N }
 */
export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const body = await req.json().catch(() => ({}));
  if (body?.confirm !== 'RESET') {
    return Response.json({ error: 'Send { confirm: "RESET", scopes: [...] } — confirm must equal "RESET" exactly' }, { status: 400 });
  }
  const scopes: string[] = Array.isArray(body?.scopes) ? body.scopes : [];
  if (scopes.length === 0) {
    return Response.json({ error: 'Pick at least one scope to reset' }, { status: 400 });
  }
  const wipeMaster = !!body?.wipe_master;

  // Optional date-range filter. Both must be valid YYYY-MM-DD or both omitted.
  const from = typeof body?.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.from) ? body.from : null;
  const to   = typeof body?.to   === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.to)   ? body.to   : null;
  if ((from && !to) || (!from && to)) {
    return Response.json({ error: 'Both from and to must be provided as YYYY-MM-DD, or omit both for full reset' }, { status: 400 });
  }
  if (from && to && from > to) {
    return Response.json({ error: '"from" must be ≤ "to"' }, { status: 400 });
  }
  const dateRange = from && to;

  const db = getDb();
  const outletId = await getCurrentOutletId();
  if (!outletId) return Response.json({ error: 'No current outlet' }, { status: 400 });

  const includes = (s: string) => scopes.includes(s) || scopes.includes('all');

  // Builds " AND <col> BETWEEN ? AND ?" suffix + the params, or empty.
  const dateClause = (col: string): { sql: string; params: any[] } =>
    dateRange ? { sql: ` AND ${col} BETWEEN ? AND ?`, params: [from, to] } : { sql: '', params: [] };

  const deleted: Record<string, number> = {};

  const txn = db.transaction(() => {
    // Delay FK enforcement to commit-time so child/parent delete order is forgiving.
    // Resets automatically when the txn ends. If a stale FK survives commit it
    // will still fail loudly — this only relaxes mid-transaction checks.
    db.prepare('PRAGMA defer_foreign_keys = 1').run();

    // ---- SALES ----
    if (includes('sales')) {
      // Date-range scoping: only delete sales (and their recipe-deduction txs)
      // whose date falls in [from, to]. inventory_transactions are linked via
      // reference_id = sales.id, so we filter through the parent.
      const dc = dateClause('s.date');

      // 1. Credit current_stock back for the deductions about to disappear.
      //    Sum negative qty per material across the affected sales.
      const creditRows = db.prepare(`
        SELECT it.material_id, COALESCE(SUM(it.quantity), 0) AS net_qty
        FROM inventory_transactions it
        JOIN sales s ON s.id = it.reference_id
        WHERE it.outlet_id = ?
          AND it.type IN ('sale', 'nc')
          AND s.outlet_id = ?
          ${dc.sql}
        GROUP BY it.material_id
      `).all(outletId, outletId, ...dc.params) as any[];
      const creditStmt = db.prepare(`
        UPDATE raw_materials
        SET current_stock = current_stock + ?, updated_at = datetime('now')
        WHERE id = ?
      `);
      let creditedMaterials = 0;
      for (const row of creditRows) {
        creditStmt.run(-row.net_qty, row.material_id);
        creditedMaterials += 1;
      }
      deleted.materials_credited_back = creditedMaterials;

      // 2. Delete inventory_transactions linked to the in-range sales.
      deleted.inventory_transactions_sales = db.prepare(`
        DELETE FROM inventory_transactions
        WHERE outlet_id = ?
          AND type IN ('sale', 'nc')
          AND reference_id IN (
            SELECT s.id FROM sales s WHERE s.outlet_id = ? ${dc.sql}
          )
      `).run(outletId, outletId, ...dc.params).changes;

      // 3. Delete the sales rows themselves.
      const sDc = dateClause('date');
      deleted.sales = db.prepare(`
        DELETE FROM sales WHERE outlet_id = ? ${sDc.sql}
      `).run(outletId, ...sDc.params).changes;
    }

    // ---- PURCHASES (legacy table) ----
    if (includes('purchases')) {
      const dc = dateClause('p.date');
      // Debit current_stock for the purchases about to disappear. Each purchase
      // wrote a positive inventory_transactions(type='purchase') with the qty;
      // removing it should subtract that qty from stock.
      const debitRows = db.prepare(`
        SELECT it.material_id, COALESCE(SUM(it.quantity), 0) AS net_qty
        FROM inventory_transactions it
        JOIN purchases p ON p.id = it.reference_id
        WHERE it.outlet_id = ? AND it.type = 'purchase'
          AND p.outlet_id = ?
          ${dc.sql}
        GROUP BY it.material_id
      `).all(outletId, outletId, ...dc.params) as any[];
      const debitStmt = db.prepare(`
        UPDATE raw_materials
        SET current_stock = current_stock - ?, updated_at = datetime('now')
        WHERE id = ?
      `);
      let debitedMaterials = 0;
      for (const row of debitRows) {
        debitStmt.run(row.net_qty, row.material_id);
        debitedMaterials += 1;
      }
      deleted.materials_debited_back = debitedMaterials;

      deleted.inventory_transactions_purchases = db.prepare(`
        DELETE FROM inventory_transactions
        WHERE outlet_id = ? AND type = 'purchase'
          AND reference_id IN (
            SELECT p.id FROM purchases p WHERE p.outlet_id = ? ${dc.sql}
          )
      `).run(outletId, outletId, ...dc.params).changes;

      const pDc = dateClause('date');
      deleted.purchases = db.prepare(`
        DELETE FROM purchases WHERE outlet_id = ? ${pDc.sql}
      `).run(outletId, ...pDc.params).changes;
    }

    // ---- PURCHASE ORDERS (cascades to items) ----
    if (includes('purchase_orders')) {
      const pDc = dateClause('date');
      // GRNs reference purchase_orders.id (NO CASCADE). Clear children first
      // so the parent DELETE doesn't break FK at commit time.
      const poSelect = `SELECT id FROM purchase_orders WHERE outlet_id = ? ${pDc.sql}`;
      try {
        deleted.grn_items_for_pos = db.prepare(`
          DELETE FROM goods_receipt_note_items
          WHERE grn_id IN (SELECT id FROM goods_receipt_notes WHERE po_id IN (${poSelect}))
        `).run(outletId, ...pDc.params).changes;
        deleted.grns_for_pos = db.prepare(`
          DELETE FROM goods_receipt_notes WHERE po_id IN (${poSelect})
        `).run(outletId, ...pDc.params).changes;
      } catch {}
      // Requisitions reference purchase_orders.linked_po_id — NULL it out so
      // those requisitions survive the PO reset.
      try {
        deleted.requisitions_unlinked = db.prepare(`
          UPDATE requisitions SET linked_po_id = NULL
          WHERE linked_po_id IN (${poSelect})
        `).run(outletId, ...pDc.params).changes;
      } catch {}
      // FK ON DELETE CASCADE handles purchase_order_items
      deleted.purchase_orders = db.prepare(`
        DELETE FROM purchase_orders WHERE outlet_id = ? ${pDc.sql}
      `).run(outletId, ...pDc.params).changes;
    }

    // ---- CLOSING STOCK ----
    if (includes('closing_stock')) {
      const cDc = dateClause('date');
      deleted.closing_stock = db.prepare(`
        DELETE FROM closing_stock WHERE outlet_id = ? ${cDc.sql}
      `).run(outletId, ...cDc.params).changes;
    }

    // ---- RESET DERIVED MATERIAL FIELDS ----
    // After a FULL purchases wipe (no date range), the price/stock signals don't
    // reflect anything anymore — reset to a clean baseline.
    // For a date-range partial reset we already debited the individual rows above
    // and we DON'T touch weighted-avg / last-price since other purchases still exist.
    if (!dateRange && (includes('purchases') || includes('purchase_orders'))) {
      db.prepare(`
        UPDATE raw_materials SET
          average_price = 0,
          last_purchase_price = 0,
          last_purchase_date = NULL,
          current_stock = 0,
          updated_at = datetime('now')
      `).run();
      // Recipe costs become 0 too (they're derived from material prices)
      db.prepare(`UPDATE recipes SET total_cost = 0, profit = selling_price, food_cost_percent = 0, updated_at = datetime('now')`).run();
      db.prepare(`UPDATE sub_recipes SET total_cost = 0, cost_per_unit = 0, updated_at = datetime('now')`).run();
      deleted.materials_reset = (db.prepare('SELECT COUNT(*) AS n FROM raw_materials').get() as any).n;
    } else if (includes('sales')) {
      // Sales-only reset: stock has already been credited back inside the SALES
      // block above, so current_stock now matches "purchases minus zero deductions".
      // Recipe costs and weighted-avg prices remain valid because purchases are intact.
    }

    // ---- RECIPES (full wipe, no date range only) ----
    // Deletes every recipe, sub-recipe, recipe ingredient, menu-item link,
    // direct-item link. Sales/wastages keep their rows but their recipe_id
    // is NULLed so historical revenue data stays intact.
    if (includes('recipes')) {
      if (dateRange) {
        // Date-range wipe doesn't make sense for recipes (they're masters,
        // not date-stamped). Surface a clear error rather than silently doing
        // a full wipe.
        throw new Error('Date range cannot be applied to recipe reset — clear the From/To fields');
      }
      // NULL FK references on sales / wastages (preserves history)
      try { deleted.sales_unlinked_from_recipe = db.prepare(`UPDATE sales SET recipe_id = NULL WHERE recipe_id IS NOT NULL`).run().changes; } catch {}
      try { deleted.wastages_unlinked_from_recipe = db.prepare(`UPDATE wastages SET recipe_id = NULL WHERE recipe_id IS NOT NULL`).run().changes; } catch {}
      // Clear link / ingredient tables before the parents
      try { deleted.menu_items = db.prepare(`DELETE FROM menu_items`).run().changes; } catch {}
      try { deleted.direct_item_links = db.prepare(`DELETE FROM direct_item_links`).run().changes; } catch {}
      try { deleted.recipe_ingredients = db.prepare(`DELETE FROM recipe_ingredients`).run().changes; } catch {}
      try { deleted.sub_recipe_ingredients = db.prepare(`DELETE FROM sub_recipe_ingredients`).run().changes; } catch {}
      try { deleted.recipe_sub_recipes = db.prepare(`DELETE FROM recipe_sub_recipes`).run().changes; } catch {}
      // Parents
      deleted.recipes = db.prepare(`DELETE FROM recipes`).run().changes;
      deleted.sub_recipes = db.prepare(`DELETE FROM sub_recipes`).run().changes;
    }

    // ---- INVENTORY (raw_materials master) ----
    // raw_materials is master data (NOT outlet-scoped), so these wipe globally.
    // Date range doesn't apply — materials aren't date-stamped.
    //
    //   inventory_unused → delete only materials NOTHING references (safe: clears
    //                      junk from a bad import, never corrupts live data).
    //   inventory_all    → delete EVERY material + clear/NULL all 18 dependents.
    //
    // Every table that references raw_materials(id). Keep in sync with db.ts —
    // if a new FK to raw_materials is added there, add it here too or the wipe
    // will fail the FK check at commit.
    const wantsInvUnused = scopes.includes('inventory_unused');
    const wantsInvAll = scopes.includes('inventory_all');
    if ((wantsInvUnused || wantsInvAll) && dateRange) {
      throw new Error('Date range cannot be applied to inventory reset — clear the From/To fields');
    }
    if (wantsInvUnused || wantsInvAll) {
      // { table, fk column, nullable } — nullable rows are UNLINKED (kept), the
      // rest are DELETEd since they can't exist without their material.
      const MATERIAL_REFS: Array<{ table: string; col: string; nullable: boolean }> = [
        { table: 'purchases',                col: 'material_id',        nullable: false },
        { table: 'sub_recipe_ingredients',   col: 'material_id',        nullable: false },
        { table: 'recipe_ingredients',       col: 'material_id',        nullable: false },
        { table: 'inventory_transactions',   col: 'material_id',        nullable: false },
        { table: 'closing_stock',            col: 'material_id',        nullable: false },
        { table: 'vendor_contracts',         col: 'material_id',        nullable: false },
        { table: 'vendor_materials',         col: 'material_id',        nullable: false },
        { table: 'purchase_order_items',     col: 'material_id',        nullable: false },
        { table: 'requisition_items',        col: 'material_id',        nullable: false },
        { table: 'butchering_batches',       col: 'source_material_id', nullable: false },
        { table: 'butchering_outputs',       col: 'material_id',        nullable: false },
        { table: 'party_consumption',        col: 'material_id',        nullable: false },
        { table: 'goods_receipt_note_items', col: 'material_id',        nullable: false },
        { table: 'wastages',                 col: 'material_id',        nullable: false },
        // nullable — NULL the link but keep the row (it carries its own name/text)
        { table: 'party_items',              col: 'material_id',        nullable: true  },
        { table: 'menu_items',               col: 'material_id',        nullable: true  },
        { table: 'staff_meal_items',         col: 'material_id',        nullable: true  },
        { table: 'direct_item_links',        col: 'material_id',        nullable: true  },
      ];
      const tableExists = (t: string): boolean => {
        try { db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get(); return true; } catch { return false; }
      };

      if (wantsInvAll) {
        // Nuclear: clear every dependent ref, then wipe ALL materials.
        for (const r of MATERIAL_REFS) {
          if (!tableExists(r.table)) { deleted[`${r.table}_skipped`] = -1; continue; }
          try {
            if (r.nullable) {
              deleted[`${r.table}_unlinked`] = db.prepare(
                `UPDATE ${r.table} SET ${r.col} = NULL WHERE ${r.col} IS NOT NULL`
              ).run().changes;
            } else {
              deleted[r.table] = db.prepare(`DELETE FROM ${r.table}`).run().changes;
            }
          } catch { deleted[`${r.table}_skipped`] = -1; }
        }
        // Recipe/sub-recipe costs are meaningless now (ingredients gone) — zero them.
        try { db.prepare(`UPDATE recipes SET total_cost = 0, food_cost_percent = 0, updated_at = datetime('now')`).run(); } catch {}
        try { db.prepare(`UPDATE sub_recipes SET total_cost = 0, cost_per_unit = 0, updated_at = datetime('now')`).run(); } catch {}
        deleted.raw_materials = db.prepare(`DELETE FROM raw_materials`).run().changes;
      } else {
        // Safe: delete only materials with ZERO references anywhere.
        const conds = MATERIAL_REFS
          .filter(r => tableExists(r.table))
          .map(r => `id NOT IN (SELECT ${r.col} FROM ${r.table} WHERE ${r.col} IS NOT NULL)`);
        const where = conds.length ? 'WHERE ' + conds.join('\n          AND ') : '';
        const before = (db.prepare('SELECT COUNT(*) AS n FROM raw_materials').get() as any).n;
        deleted.inventory_unused = db.prepare(`DELETE FROM raw_materials ${where}`).run().changes;
        deleted.inventory_kept_in_use = before - deleted.inventory_unused;
      }
    }

    // ---- PHASE 1 DEPENDENT CLEANUP ----
    // GRNs reference purchase_orders. Requisitions reference purchase_orders.
    // Wastages reference recipes. Inventory transactions reference materials.
    // Whenever the user fully wipes purchases/POs/sales (no date filter), we
    // also need to clear these Phase 1 transactional tables or FK fails.
    // Triggered on:
    //  - explicit scopes.includes('all')
    //  - OR full-wipe (no date range) of purchase_orders / purchases / sales
    const phase1Cleanup = !dateRange && (
      scopes.includes('all') ||
      includes('purchase_orders') ||
      includes('purchases') ||
      includes('sales')
    );
    if (phase1Cleanup) {
      const safeDel = (table: string, key?: string) => {
        try {
          deleted[key || table] = db.prepare(`DELETE FROM ${table}`).run().changes;
        } catch (e: any) {
          // Table may not exist on older DBs — note but don't abort the txn.
          deleted[`${key || table}_skipped`] = 0;
        }
      };
      // Receiving / requisition / wastage trail
      safeDel('goods_receipt_note_items');
      safeDel('goods_receipt_notes');
      safeDel('requisition_items');
      safeDel('requisitions');
      safeDel('wastages');
      safeDel('purchase_order_items');
      // Party / staff meal trail (also FK to raw_materials)
      safeDel('party_items');
      safeDel('parties');
      safeDel('staff_meal_items');
      safeDel('staff_meals');
      // closing_stock if not already removed via its own scope
      if (!includes('closing_stock')) safeDel('closing_stock');
      // Any orphan inventory_transactions left (transfers, adjustments, etc.)
      deleted.inventory_transactions_other = db.prepare(`DELETE FROM inventory_transactions`).run().changes;
    }

    // ---- WIPE MASTER (rare — only when starting brand new) ----
    // Order matters: delete child rows before parents per FK map. Order chosen
    // by walking the dependency tree leaf-first:
    //   menu_items / direct_item_links → recipes/sub_recipes
    //   recipe_ingredients, sub_recipe_ingredients, recipe_sub_recipes → recipes/sub_recipes/raw_materials
    //   vendor_contracts → vendors + raw_materials
    //   recipes → sub_recipes (via recipe_sub_recipes already cleared)
    //   then raw_materials, then sub_recipes
    if (wipeMaster && scopes.includes('all')) {
      const safe = (table: string) => {
        try { deleted[table] = db.prepare(`DELETE FROM ${table}`).run().changes; }
        catch (e: any) { deleted[`${table}_skipped`] = -1; }
      };
      // 1. Leaf join tables / link tables first
      safe('menu_items');
      safe('direct_item_links');
      safe('recipe_ingredients');
      safe('sub_recipe_ingredients');
      safe('recipe_sub_recipes');
      safe('vendor_contracts');
      // 2. Mid-level: recipes & sub_recipes (their parents like menu_items already gone)
      safe('recipes');
      safe('sub_recipes');
      // 3. Root parents last
      safe('raw_materials');
    }
  });
  try {
    txn();
  } catch (e: any) {
    console.error('[admin/reset] txn failed:', e);
    return Response.json({
      error: e.message || 'Reset failed',
      hint: e.message?.includes('FOREIGN KEY')
        ? 'A child table still references the rows being deleted. Make sure all dependent tables are listed in the reset.'
        : undefined,
      partial: deleted,
    }, { status: 500 });
  }

  logAuditEvent(db, {
    event_type: 'admin.reset',
    entity_type: 'system',
    entity_id: outletId,
    actor_email: auth.user?.email || 'admin',
    outlet_id: outletId,
    after: { scopes, wipe_master: wipeMaster, from, to, deleted },
    note: `Reset scopes: ${scopes.join(', ')}${dateRange ? ` (${from} → ${to})` : ' (full)'}`,
  });
  return Response.json({
    success: true,
    outlet_id: outletId,
    deleted,
  });
}
