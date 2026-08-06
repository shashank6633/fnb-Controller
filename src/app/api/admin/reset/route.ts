import { getDb, logAuditEvent } from '@/lib/db';
import { requireRole, getCurrentOutletId } from '@/lib/auth';
import { deptOnHandBulk, postDeptLedger } from '@/lib/dept-ledger';

/**
 * Admin-only data reset.
 *
 * THERE ARE TWO STOCK RAILS NOW, AND A RESET MUST MOVE BOTH OR NEITHER.
 * Since the department-inventory cutover (2026-08) a gram lives in exactly one
 * of two places: raw_materials.current_stock (the central store) or the
 * department rail (SUM of signed department_material_transactions.quantity,
 * anchored on a count — see src/lib/dept-ledger.ts). A requisition issue MOVES
 * it from the first to the second; recipe consumption removes it from the
 * second and never touches the first.
 *
 * So every branch below that credits or debits central has to answer "and what
 * happened on the other rail?". Getting it wrong is not a cosmetic bug: crediting
 * central for a deduction the DEPARTMENT absorbed invents stock the store never
 * lost, and wiping the department rail without crediting central destroys stock
 * nobody consumed. Each branch states its answer explicitly — including the ones
 * whose answer is "nothing" — so a later reader never has to guess whether the
 * department dimension was considered or forgotten.
 *
 * Body: {
 *   confirm: "RESET",                  // must equal exactly — primitive guardrail
 *   scopes: Array<                     // pick one or more
 *     "sales" | "purchases" | "purchase_orders" | "closing_stock" | "recipes"
 *     | "inventory_unused"             // delete only materials nothing references
 *     | "inventory_all"                // delete ALL materials + cascade dependents
 *     | "stock_only"                   // set current_stock = 0 on all (keep master)
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

    // Set by the two branches that re-baseline current_stock wholesale (the full
    // purchases/PO wipe below, and `stock_only`). Once stock has been zeroed on
    // purpose, crediting a requisition's issued quantity back on top of that zero
    // would invent stock, so the requisition credit-back in PHASE 1 skips itself.
    let stockRebaselined = false;

    // Older databases (and test fixtures) predate some of these tables. Probe
    // rather than assume — a missing table must never abort a reset.
    const hasTable = (t: string): boolean => {
      try { db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get(); return true; } catch { return false; }
    };
    const hasDeptRail = hasTable('department_material_transactions') && hasTable('department_materials');

    // department_materials.on_hand is a maintained CACHE, never the balance (the
    // balance is SUM(quantity) over the ledger — dept-ledger.ts says so at the
    // top and /api/department-ledger/check exists to catch drift). Deleting
    // ledger rows IS the credit; the cache has to be dragged back into step
    // afterwards or the drift check fires on a reset that did nothing wrong.
    const resyncDeptCache = (pairs: Array<{ department_id: string; material_id: string }>) => {
      if (!hasDeptRail || pairs.length === 0) return;
      const stmt = db.prepare(`
        UPDATE department_materials
           SET on_hand = COALESCE((
                 SELECT SUM(t.quantity) FROM department_material_transactions t
                  WHERE t.department_id = department_materials.department_id
                    AND t.material_id   = department_materials.material_id
               ), 0),
               updated_at = datetime('now')
         WHERE department_id = ? AND material_id = ?
      `);
      for (const p of pairs) stmt.run(p.department_id, p.material_id);
    };

    // Drive every department balance to exactly zero by POSTING an offsetting
    // 'adjustment', not by deleting rows.
    //
    // WHY A POST AND NOT A DELETE. The balance is anchor + movements-since, and
    // the anchor can be a closing_stock COUNT (dept-ledger.ts deptOnHand). A
    // scope like `stock_only` deliberately keeps closing_stock, so deleting every
    // ledger row would still leave the count standing and the kitchen would read
    // as full while central reads zero. An offsetting adjustment lands on zero
    // whatever the anchor is, keeps the reason on the record, and is idempotent —
    // a second run computes 0 and posts nothing.
    //
    // Global, not outlet-scoped, to match the central side it mirrors:
    // raw_materials is master data and `stock_only` zeroes it for every outlet.
    //
    // NO LIQUOR CARVE-OUT HERE, DELIBERATELY — and this is not an oversight to
    // "fix" later. Store-mapped materials are excluded from the department rail
    // at the point of ISSUE (issue-stock.ts), so they should have no balance to
    // find. If one turns up anyway, this only drives it to zero; it can never put
    // a liquor gram ONTO the department rail, which is what the carve-out exists
    // to prevent. Filtering here would instead leave that stray balance standing
    // after a reset that claims to have zeroed everything.
    const zeroDepartmentRail = (source: string, note: string): number => {
      if (!hasDeptRail) return -1;
      let deptIds: string[] = [];
      try {
        deptIds = (db.prepare(`
          SELECT DISTINCT d AS id FROM (
            SELECT id AS d FROM departments
            UNION SELECT department_id AS d FROM department_materials
            UNION SELECT department_id AS d FROM department_material_transactions
          ) WHERE d IS NOT NULL AND d <> ''
        `).all() as any[]).map(r => String(r.id));
      } catch { return -1; }
      if (deptIds.length === 0) return 0;

      let posted = 0;
      for (const [key, bal] of deptOnHandBulk(db, deptIds)) {
        const sep = key.indexOf('|');
        if (sep < 0) continue;
        const departmentId = key.slice(0, sep);
        const materialId = key.slice(sep + 1);
        if (!departmentId || !materialId) continue;
        // onHand is NULL — never 0 — for a pair that was never counted. Its
        // movements are still real and still have to be flattened, otherwise the
        // first count after this reset would inherit them.
        const target = bal.onHand == null ? bal.movementsSince : bal.onHand;
        if (!(Math.abs(target) > 1e-9)) continue;
        // Deliberately NOT wrapped in try/catch. postDeptLedger throwing means a
        // department was left holding stock while central was zeroed — the two
        // rails out of step is the one outcome worse than the reset failing, and
        // better-sqlite3 rolls the whole transaction back on the throw.
        postDeptLedger(db, {
          departmentId,
          materialId,
          type: 'adjustment',
          quantity: -target,
          source,
          referenceId: 'admin-reset',
          notes: note,
        });
        posted += 1;
      }
      return posted;
    };

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

      // 1a. NOT ALL OF THAT WAS CENTRAL'S. Since the cutover, recipe consumption
      //     comes out of the DEPARTMENT that cooked the dish — the gram already
      //     left the store earlier, on the requisition issue. The
      //     inventory_transactions row above is written on EVERY path regardless
      //     (db.ts applyDeduct keeps it unconditional so Variance and
      //     Sales-vs-Purchase stay bit-identical), so it is the AUDIT TOTAL, not
      //     central's share. Credit it whole and the store is handed back stock it
      //     never lost. Same arithmetic as the DELETE handler in /api/sales.
      //
      //     type = 'consumption' is load-bearing: it excludes the party rail
      //     ('received'/'consumed'/'returned', owned by party-fulfillment.ts) and
      //     the compensating 'adjustment' rows, so a re-run can never read its own
      //     credit as a fresh debit. Do not widen it to "all rows for this sale".
      //
      //     Pre-cutover sales have no rows here at all, so a date-ranged reset over
      //     old history behaves exactly as it did before this branch existed.
      const deptConsumptionPairs: Array<{ department_id: string; material_id: string; net_qty: number }> =
        hasDeptRail ? db.prepare(`
          SELECT dmt.department_id, dmt.material_id, COALESCE(SUM(dmt.quantity), 0) AS net_qty
          FROM department_material_transactions dmt
          JOIN sales s ON s.id = dmt.reference_id
          WHERE dmt.type = 'consumption'
            AND s.outlet_id = ?
            ${dc.sql}
          GROUP BY dmt.department_id, dmt.material_id
        `).all(outletId, ...dc.params) as any[] : [];
      // 1a-ii. THE DEPARTMENT IS NOT THE ONLY LEG CENTRAL DIDN'T PAY FOR.
      //     applyDeduct (db.ts) has FOUR outcomes and only one of them is a
      //     department post. It can also route the gram to a FLOOR store ledger,
      //     or move it NOWHERE AT ALL and log a consumption_skip — store-mapped
      //     liquor, an unmapped station (sushi, terracegrill), a blank station,
      //     the 'kitchen' sentinel. Central is untouched on every one of those
      //     branches, yet the inventory_transactions row is still written on all
      //     of them by design. So "total minus department" still hands the store
      //     back grams it never lost; it has to be total minus EVERY non-central
      //     leg. Measured on this database: 2 of the 18 recipe-attached menu
      //     items sit on deliberately-unmapped stations (sushi, terracegrill), so
      //     the skip leg is not hypothetical.
      //
      // Everything central did NOT absorb, keyed by material, accumulated as a
      // POSITIVE "quantity that left via some other rail" so the arithmetic below
      // is one subtraction rather than three sign conventions.
      const nonCentral = new Map<string, number>();
      const addNonCentral = (materialId: string, qty: number) => {
        if (!materialId || !Number.isFinite(qty) || qty === 0) return;
        nonCentral.set(materialId, (nonCentral.get(materialId) || 0) + qty);
      };
      // Summed ACROSS departments per material: one sale's ingredients can resolve
      // to more than one department, and the central arithmetic needs the whole
      // department portion, not the last one seen. Ledger rows are negative
      // (out of the department) — flipped positive here.
      for (const d of deptConsumptionPairs) addNonCentral(d.material_id, -Number(d.net_qty || 0));

      // The skip log: a deduction that moved nothing, anywhere. EVERY reason
      // qualifies (store_mapped, store_check_unavailable, blank, unmapped,
      // inactive, dept_post_failed) because every recordSkip() call site in
      // applyDeduct returns without touching a single rail — the reason string
      // says WHY nothing moved, never WHERE it moved instead.
      //
      // COUPLING, STATED OUT LOUD: consumption_skips has no sale_id column (it
      // is keyed to order_item_id, which /api/sales and sales-import do not
      // supply), so the only link back to a sale is the notes string db.ts
      // writes as `recipe:<id> sale:<id>`. If that format changes, this
      // subtraction silently stops matching and the reset starts inventing
      // stock again. source = 'recipe_consumption' keeps wastage/staff-meal
      // skips — which have their own reversal paths — out of this sum.
      if (hasTable('consumption_skips')) {
        const skipRows = db.prepare(`
          SELECT cs.material_id, COALESCE(SUM(cs.quantity), 0) AS qty
          FROM consumption_skips cs
          WHERE cs.source = 'recipe_consumption'
            AND cs.material_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM sales s
              WHERE s.outlet_id = ? ${dc.sql}
                AND cs.notes LIKE '%sale:' || s.id
            )
          GROUP BY cs.material_id
        `).all(outletId, ...dc.params) as any[];
        // quantity is stored POSITIVE here ("what WOULD have been deducted").
        for (const r of skipRows) addNonCentral(r.material_id, Number(r.qty || 0));
      }

      // The floor-store leg (multi-floor bar auto-deduct). Opt-in and currently
      // OFF — `tm_floor_autodeduct` is '0' and there are zero floor-routed sale
      // rows — but this must not be true only because a setting happens to be
      // off. postLedger stamps ref = sales.id and writes a negative quantity.
      //
      // SUBTRACTED, NOT REVERSED — and that is a deliberate refusal. Unwinding a
      // floor movement means posting a compensating inward on store_stock_ledger,
      // which is the TGBCL store rail with its own valuation and closing counts;
      // a reset that silently re-inflates a floor bar's on-hand is a bigger
      // surprise than one that leaves it alone. Central staying honest is what
      // this line buys. Provable no-op today: zero rows match.
      if (hasTable('store_stock_ledger')) {
        const floorRows = db.prepare(`
          SELECT l.material_id, COALESCE(SUM(l.quantity), 0) AS net_qty
          FROM store_stock_ledger l
          JOIN sales s ON s.id = l.ref
          WHERE l.txn_type = 'outward'
            AND s.outlet_id = ?
            ${dc.sql}
          GROUP BY l.material_id
        `).all(outletId, ...dc.params) as any[];
        for (const r of floorRows) addNonCentral(r.material_id, -Number(r.net_qty || 0));
      }

      const creditStmt = db.prepare(`
        UPDATE raw_materials
        SET current_stock = current_stock + ?, updated_at = datetime('now')
        WHERE id = ?
      `);
      let creditedMaterials = 0;
      for (const row of creditRows) {
        const totalDeducted = -Number(row.net_qty || 0);                     // deduction rows are negative
        const centralShare  = totalDeducted - (nonCentral.get(row.material_id) || 0);
        // Epsilon, not `!== 0`: a fully department-attributed sale lands on ~1e-16
        // across two floating-point legs, and `!== 0` would post a meaningless
        // sub-nanogram credit to central.
        if (!(Math.abs(centralShare) > 1e-9)) continue;
        creditStmt.run(centralShare, row.material_id);
        creditedMaterials += 1;
      }
      deleted.materials_credited_back = creditedMaterials;

      // 1b. The department's own credit. Here — unlike /api/sales DELETE, which
      //     posts a compensating 'adjustment' because the sale survives elsewhere
      //     in the audit — the sale ROW itself is being deleted, so an adjustment
      //     pointing at a sale that no longer exists is an orphan, not a trail.
      //     Removing the consumption rows IS the credit (the balance is
      //     SUM(quantity) over this table), and it makes a re-run idempotent: the
      //     second pass finds nothing and cannot credit the department twice.
      if (hasDeptRail) {
        deleted.department_consumption_sales = db.prepare(`
          DELETE FROM department_material_transactions
          WHERE type = 'consumption'
            AND reference_id IN (
              SELECT s.id FROM sales s WHERE s.outlet_id = ? ${dc.sql}
            )
        `).run(outletId, ...dc.params).changes;
        resyncDeptCache(deptConsumptionPairs);
      }

      // 1c. The skip log for those same sales. It holds no stock (that is the
      //     whole point of it), so this moves nothing — but every row points at
      //     a sale that is about to stop existing, and the department-variance
      //     banner counts these rows to name the stations that need mapping.
      //     Left behind, a reset that clears the sales still leaves the screen
      //     complaining about orders nobody can open. Phase 1 wipes this table
      //     wholesale, but a DATE-RANGED sales reset never reaches phase 1.
      //     Runs AFTER the arithmetic above, which reads these rows.
      if (hasTable('consumption_skips')) {
        deleted.consumption_skips_sales = db.prepare(`
          DELETE FROM consumption_skips
          WHERE source = 'recipe_consumption'
            AND EXISTS (
              SELECT 1 FROM sales s
              WHERE s.outlet_id = ? ${dc.sql}
                AND consumption_skips.notes LIKE '%sale:' || s.id
            )
        `).run(outletId, ...dc.params).changes;
      }

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
      //
      // NO DEPARTMENT MIRROR, AND THAT IS PROVABLE, NOT ASSUMED. Every inbound
      // path (PO-receive, GRN, purchases, bulk, opening-stock, inward-import,
      // seed, recaho import) lands in the central store by construction: the
      // `purchases` table has no department_id column, so goods cannot be received
      // straight onto a kitchen shelf. A receipt therefore only ever moved
      // raw_materials.current_stock, and unwinding it only ever moves that back.
      // Departments get their stock from a requisition ISSUE, which is credited
      // back separately in PHASE 1 below. If a department-addressed receipt is
      // ever added, this branch needs its mirror and this comment is the reason.
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
      stockRebaselined = true;
      // The department rail is zeroed too, but not here — PHASE 1 deletes both
      // department tables outright and this branch is a strict SUBSET of the
      // phase-1 trigger (both require !dateRange, and phase 1 fires on purchases
      // OR purchase_orders OR sales OR 'all'), so it always follows. Zeroing here
      // as well would only post adjustments that phase 1 immediately deletes.
      // If either condition is ever loosened, zeroDepartmentRail() belongs here:
      // central at 0 with kitchens still holding grams is the two-truths failure.
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
        // Records the RECIPE-unit stock each requisition line moved. It keys on
        // material_id (no declared FK, so the commit-time check won't catch it):
        // without this entry, `inventory_all` would delete every material and every
        // requisition_items row and leave the ledger pointing at both. No credit-back
        // here — the materials themselves are being deleted. Empty while
        // `requisition_deduct_at_issue` is '0'; tableExists() skips it on an
        // un-migrated DB.
        { table: 'requisition_issue_ledger', col: 'material_id',        nullable: false },
        // THE DEPARTMENT RAIL. Neither table declares an FK to raw_materials, so
        // the commit-time foreign-key check will NOT catch them — leaving them out
        // fails silently, which is worse than failing loudly: `inventory_all`
        // would delete every material and leave department_materials rows quoting
        // an on-hand balance for a material that no longer exists, on a screen
        // that joins by id and simply shows a blank name.
        // Deleted, not unlinked: a stock balance for a deleted material is not a
        // record worth keeping, and the balance is SUM(quantity) over the ledger,
        // so removing the rows is what actually takes the grams off the books.
        { table: 'department_material_transactions', col: 'material_id',  nullable: false },
        { table: 'department_materials',     col: 'material_id',        nullable: false },
        { table: 'butchering_batches',       col: 'source_material_id', nullable: false },
        { table: 'butchering_outputs',       col: 'material_id',        nullable: false },
        { table: 'party_consumption',        col: 'material_id',        nullable: false },
        { table: 'goods_receipt_note_items', col: 'material_id',        nullable: false },
        { table: 'wastages',                 col: 'material_id',        nullable: false },
        // nullable — NULL the link but keep the row (it carries its own name/text)
        // The unmapped-station log. It records a deduction that did NOT happen, so
        // it holds no stock and the row is worth keeping as evidence of the gap —
        // but it keys on material_id with no declared FK, same trap as the two
        // department tables above.
        { table: 'consumption_skips',        col: 'material_id',        nullable: true  },
        { table: 'party_items',              col: 'material_id',        nullable: true  },
        { table: 'menu_items',               col: 'material_id',        nullable: true  },
        { table: 'staff_meal_items',         col: 'material_id',        nullable: true  },
        { table: 'direct_item_links',        col: 'material_id',        nullable: true  },
      ];
      const tableExists = hasTable;

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

    // ---- STOCK LEVELS ONLY (zero on-hand, keep the material master) ----
    // Sets current_stock = 0 for every material WITHOUT touching name, SKU, units,
    // pack/case conversions, price, category, recipes, purchases or history. Use to
    // re-baseline on-hand for go-live, then re-establish it via Purchases / Closing
    // Stock. raw_materials is master data (not outlet-scoped) so this zeros globally.
    //
    // "On-hand" is BOTH RAILS. Zeroing only central would leave every kitchen
    // holding the grams it was issued, and the first department variance report
    // after go-live would read those grams as stock that appeared from nowhere.
    // `stock_only` is the one re-baseline scope that deliberately keeps
    // closing_stock and every transactional row, so the department side cannot be
    // wiped by deletion (the closing count would still anchor a balance) — it is
    // driven to zero by an offsetting 'adjustment'. See zeroDepartmentRail().
    if (scopes.includes('stock_only')) {
      deleted.stock_zeroed = db.prepare(
        `UPDATE raw_materials SET current_stock = 0, updated_at = datetime('now')`
      ).run().changes;
      deleted.department_balances_zeroed = zeroDepartmentRail(
        'admin-reset:stock_only',
        'Admin reset (stock_only) — department on-hand re-baselined to zero alongside central',
      );
      stockRebaselined = true;
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
      // ---- REQUISITION ISSUE CREDIT-BACK ----
      // Deleting requisitions used to be the one deletion here with no stock
      // reversal, unlike sales (credited back above) and purchases (debited back
      // above). Once `requisition_deduct_at_issue` is on, every issue debits
      // raw_materials.current_stock and records the RECIPE-unit amount in
      // requisition_issue_ledger.delta_recipe_qty (positive = goods left the
      // store); the matching inventory_transactions rows are wiped wholesale a few
      // lines below. Dropping all of that without crediting would permanently lose
      // that stock. So: sum the ledger per material and add it back BEFORE the
      // requisitions go, mirroring the sales branch exactly.
      //
      // Scope note: this cleanup deletes requisitions unscoped (DELETE FROM
      // requisitions), so the credit-back is unscoped to match the rows that
      // actually disappear.
      //
      // While the flag is '0' the ledger table is empty (and on an un-migrated DB
      // does not exist at all — hence the try/catch, which must not abort the txn),
      // so this credits nothing and behaves exactly as production does today.
      if (!stockRebaselined) {
        try {
          const reqCreditRows = db.prepare(`
            SELECT material_id, COALESCE(SUM(delta_recipe_qty), 0) AS net_qty
            FROM requisition_issue_ledger
            GROUP BY material_id
          `).all() as any[];
          const reqCreditStmt = db.prepare(`
            UPDATE raw_materials
            SET current_stock = current_stock + ?, updated_at = datetime('now')
            WHERE id = ?
          `);
          let reqCredited = 0;
          for (const row of reqCreditRows) {
            if (!row.material_id || !Number(row.net_qty)) continue;
            reqCreditStmt.run(Number(row.net_qty), row.material_id);
            reqCredited += 1;
          }
          deleted.materials_credited_back_requisitions = reqCredited;
        } catch { deleted.materials_credited_back_requisitions_skipped = 0; }
      } else {
        // current_stock was deliberately zeroed above — nothing to credit onto.
        deleted.materials_credited_back_requisitions_skipped = 0;
      }

      // ---- THE OTHER HALF OF THE SAME GRAM: THE DEPARTMENT RAIL ----
      // The credit-back above returns what central lost on a requisition ISSUE.
      // Those same grams are ALSO sitting on the department rail as 'issued' rows,
      // and the rail is deleted a few lines below. Credit central and delete the
      // rail and the books balance; do one without the other and the reset either
      // invents stock (rail kept, central credited) or destroys it (rail deleted,
      // central not credited). They must happen in this one transaction — which
      // they do, the whole reset is a single db.transaction().
      //
      // ONE RAIL THE REQUISITION CREDIT DOES NOT COVER: party fulfilment.
      // party-fulfillment.ts debits raw_materials.current_stock and credits the
      // department in the same breath, without writing to requisition_issue_ledger
      // (applyIssueDelta skips purpose='party' by design). Phase 1 deletes
      // `parties`/`party_items` with no stock reversal of its own, so unless we
      // credit here those grams leave both rails at once. What the department
      // still HOLDS from parties is the signed sum of the three party types:
      //   received (+)  central paid for it and the kitchen still has it → owed back
      //   consumed (-)  the party ate it; central is rightly still short
      //   returned (-)  party-fulfillment already credited central
      //
      // NOT credited, deliberately — do not "simplify" this into SUM(everything):
      //   consumption / wastage / staff_meal — out of the department, and they
      //     never touched central. Their source rows die in this cleanup too.
      //   opening — the cutover COUNT. A measured shelf balance, not a movement
      //     out of the store. Crediting it would manufacture central stock from a
      //     kitchen's stocktake.
      //   adjustment — a correction. By definition not a store movement.
      if (!stockRebaselined && hasDeptRail) {
        try {
          const partyHeld = db.prepare(`
            SELECT material_id, COALESCE(SUM(quantity), 0) AS net_qty
            FROM department_material_transactions
            WHERE type IN ('received', 'consumed', 'returned')
            GROUP BY material_id
          `).all() as any[];
          const partyCreditStmt = db.prepare(`
            UPDATE raw_materials
            SET current_stock = current_stock + ?, updated_at = datetime('now')
            WHERE id = ?
          `);
          let partyCredited = 0;
          for (const row of partyHeld) {
            const net = Number(row.net_qty) || 0;
            // > 0 only. A negative net means the party rail took out more than it
            // received — a bug on that rail, not a debit central should absorb by
            // silently docking the store. It stays visible instead.
            if (!row.material_id || !(net > 1e-9)) continue;
            partyCreditStmt.run(net, row.material_id);
            partyCredited += 1;
          }
          deleted.materials_credited_back_party = partyCredited;
        } catch { deleted.materials_credited_back_party_skipped = 0; }
      } else {
        deleted.materials_credited_back_party_skipped = 0;
      }

      // The department rail is derived ENTIRELY from rows this cleanup deletes —
      // requisition issues, sales consumption, wastages, staff meals, parties —
      // plus the cutover count. Keeping it would hand the app two balances that
      // flatly disagree: central credited back to full while every kitchen still
      // shows grams on the shelf. closing_stock, the other anchor deptOnHand()
      // reads, is wiped further down, so afterwards the rail derives to "never
      // counted" — the honest state for a database with no history left, and not
      // the same thing as zero.
      safeDel('department_material_transactions');
      safeDel('department_materials');
      // The unmapped-station skip log. Every row points at an order_item this
      // cleanup deletes; left behind it keeps a warning banner up about stations
      // and orders nobody can open any more.
      safeDel('consumption_skips');
      // The ledger itself goes with the requisitions it describes; leaving it would
      // orphan every row against a req_item_id that no longer exists AND let a
      // later cancel/reject guard refuse on a requisition that is gone.
      safeDel('requisition_issue_ledger');
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
