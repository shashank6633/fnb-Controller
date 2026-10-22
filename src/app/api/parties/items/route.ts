import { getCurrentUser } from '@/lib/auth';
import { getDb, generateId } from '@/lib/db';
import { packFactor, toPurchaseQty, fmtQtyNum } from '@/lib/pack-units';
import { planCentralDebit, qtyDown, printableCap, fmtGridQty } from '@/lib/central-debit-clamp';

/**
 * PARTY ITEMS — Issue → Return → Consumption, with the stock movement it drives.
 *
 * THE BASIS CONTRACT OF THIS TABLE (audited 2026-08-07, rate-basis lock)
 * ─────────────────────────────────────────────────────────────────────
 * party_items is a RECIPE-BASIS table on both halves. Nothing here is in
 * purchase units, and no packFactor may ever be introduced on either side.
 *
 *   party_items.issued_quantity / returned_quantity / quantity
 *       RECIPE units. Proved by the movement this route posts: the SAME number
 *       debits raw_materials.current_stock (POST, "Deduct from main inventory")
 *       and credits it back (PATCH / DELETE), and current_stock is recipe units
 *       by canon; the mirror rows go into inventory_transactions.quantity,
 *       which the canon also fixes as recipe-basis.
 *
 *   party_items.purchase_price
 *       ₹ per RECIPE unit — despite the column NAME, which is a trap for the
 *       next reader. The server fills it from raw_materials.average_price (₹ per
 *       recipe unit) whenever the caller does not supply one; it is NEVER read
 *       from raw_materials.last_purchase_price, the mixed-basis column.
 *
 * So a caller-supplied `purchase_price` must ALSO be ₹/recipe-unit, because it
 * multiplies the same quantity that debits current_stock. There is no in-app
 * caller today (this route is reached through src/proxy.ts by the external AKAN
 * event client); a caller that sends ₹ per bottle beside a bottle count would be
 * mis-stating BOTH halves, and the stock debit would be wrong first.
 *
 * ── THE CENTRAL FLOOR ON THE ISSUE (POST) ──────────────────────────────────
 * The debit below used to be a bare `current_stock = current_stock - ?` with no
 * balance read of any kind. MEASURED on a snapshot: GHEE forced to
 * current_stock 0, then POST { deduct_inventory: true, items: [{ material_id:
 * GHEE, issued_quantity: 500 }] } answered 201 {"success":1,"errors":[]} and
 * left current_stock at −500. The only guards in the loop were a missing
 * party_id/item_name and a non-positive quantity; nothing bounded the debit.
 *
 * This is the same hole the requisition rails closed (src/lib/issue-stock.ts,
 * "THE CENTRAL FLOOR"), reached by a different writer, and it is closed with the
 * same rule: READ THE BALANCE, FLOOR IT AT ZERO, REFUSE THE DEBIT THAT WOULD GO
 * BELOW. max(0, …) rather than the raw balance, for issue-stock.ts's own reason:
 * a balance that is already negative must read as "nothing issuable", never as a
 * negative allowance that lets the next issue dig the hole deeper.
 *
 * WHY THIS ROUTE REPORTS INSTEAD OF THROWING. There is no in-app caller; this is
 * reached through src/proxy.ts by the external AKAN event client, whose contract
 * with us is the {success, errors[]} body it already gets. A throw would hand it
 * a 500 with no per-line detail and no partial success, so a short line is
 * pushed onto errors[] — named, with the shortfall — and its NEIGHBOURS ON THE
 * SAME POST still go through, exactly as a missing item_name already behaves.
 *
 * WHY IT REFUSES THE LINE RATHER THAN CLAMPING THE DEBIT. The party_items row
 * and the stock movement are the same quantity by this file's basis contract
 * (above). Clamping the debit while inserting the full issued_quantity would
 * commit a row reading "500 issued" against the 64 that actually moved — and
 * PATCH credits returns back out of issued_quantity, so the next close would
 * hand 500 back to a store that only ever gave up 64. That is stock manufactured
 * out of nothing: the measured ALMOND bug in a new costume (issue-stock.ts
 * header). So a short line writes NOTHING — no party_items row, no debit, no
 * inventory_transactions row — and success is not incremented for it.
 *
 * THE BALANCE IS READ FRESH, PER LINE, INSIDE THE TRANSACTION. The
 * `allMaterials` snapshot taken before the loop is a stale read by the time the
 * second line runs: one POST may carry two lines on the same material, and each
 * fits while the pair does not. Re-reading per line means the second line sees
 * the first line's debit already in the balance, which is the same thing the
 * requisition floor relies on instead of an accumulator. Nothing between the
 * read and the debit touches raw_materials, and better-sqlite3 is synchronous
 * inside the one transaction, so the read cannot race the write it bounds.
 *
 * NO STORE-MAPPED (LIQUOR) CARVE-OUT HERE, deliberately. The requisition rail
 * carves those materials out because its debit skips them — their balance lives
 * on the TGBCL store ledger. THIS route's debit does not skip them: it has always
 * taken them off central, and 95 of the 127 store-mapped materials hold a central
 * balance of 0, so a party draw on one went straight below zero. A carve-out
 * would therefore excuse exactly the materials most at risk — a guard that reads
 * correctly and can never fire, which is this codebase's recorded inert-guard
 * pattern. The floor bounds whatever this route debits.
 */

/* NO LOCAL EPSILON. This floor used to carry its own `EPS = 1e-9` beside a
 * 6-dp-rounded allowance, and the two disagreed (see the floor below). "Does
 * this debit fit, and what do we subtract" is planCentralDebit's question, asked
 * once for every central floor in src/lib/central-debit-clamp.ts. */

export async function GET(request: Request) {
  try {
    // Ruling 53: the proxy only checks that a cookie is PRESENT on an API GET.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);
    const partyId = url.searchParams.get('party_id');

    if (!partyId) {
      return Response.json({ error: 'party_id is required' }, { status: 400 });
    }

    const items = db.prepare(`
      SELECT pi.*, rm.name as material_name, rm.unit as material_unit,
        rm.average_price as current_avg_price, rm.current_stock as material_current_stock
      FROM party_items pi
      LEFT JOIN raw_materials rm ON pi.material_id = rm.id
      WHERE pi.party_id = ?
      ORDER BY pi.category, pi.item_name
    `).all(partyId);

    // Summary by category (based on consumed quantity)
    const summary = db.prepare(`
      SELECT
        category,
        COUNT(*) as item_count,
        SUM(issued_quantity) as total_issued,
        SUM(returned_quantity) as total_returned,
        SUM(quantity) as total_consumed,
        SUM(total_cost) as total_cost,
        SUM(total_revenue) as total_revenue,
        SUM(CASE WHEN is_complimentary = 1 THEN total_cost ELSE 0 END) as comp_cost
      FROM party_items
      WHERE party_id = ?
      GROUP BY category
    `).all(partyId);

    return Response.json({ items, summary });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// POST: Issue items for a party (opening) — deducts from main inventory
export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { items, deduct_inventory } = body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items array is required' }, { status: 400 });
    }

    const allMaterials = db.prepare('SELECT id, name, average_price, unit, current_stock FROM raw_materials').all() as any[];
    const materialByName = new Map<string, any>();
    const materialById = new Map<string, any>();
    for (const m of allMaterials) {
      materialByName.set(m.name.toLowerCase().trim(), m);
      materialById.set(m.id, m);
    }

    const results = { success: 0, errors: [] as string[] };

    // THE FLOOR'S OWN READ. Prepared once, RUN per line inside the transaction —
    // see "THE BALANCE IS READ FRESH" in the file header. It carries the unit
    // metadata too, so the balance and the units the refusal is phrased in come
    // out of one row and cannot describe two different materials.
    const readBalance = db.prepare(`
      SELECT name, unit, purchase_unit, pack_size, COALESCE(current_stock, 0) AS current_stock
        FROM raw_materials WHERE id = ?
    `);

    const insertItems = db.transaction(() => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.party_id || !item.item_name) {
          results.errors.push(`Row ${i + 1}: party_id and item_name required`);
          continue;
        }

        // Match material
        let materialId = item.material_id || null;
        let purchasePrice = Number(item.purchase_price) || 0;

        if (!materialId && item.item_name) {
          const matched = materialByName.get(item.item_name.toLowerCase().trim());
          if (matched) {
            materialId = matched.id;
            if (purchasePrice === 0) purchasePrice = matched.average_price || 0;
          }
        }
        if (materialId && purchasePrice === 0) {
          const mat = materialById.get(materialId);
          if (mat) purchasePrice = mat.average_price || 0;
        }

        const issuedQuantity = Number(item.issued_quantity ?? item.quantity) || 0;
        const sellingPrice = Number(item.selling_price) || 0;
        const isComp = item.is_complimentary ? 1 : 0;

        if (issuedQuantity <= 0) {
          results.errors.push(`Row ${i + 1}: issued quantity must be greater than 0`);
          continue;
        }

        // ── THE CENTRAL FLOOR ────────────────────────────────────────────────
        // Gated on the SAME condition as the debit it bounds (`deduct_inventory
        // && materialId`), because a line that moves no stock has no central
        // balance to be short of — bounding it would refuse a pure bookkeeping
        // row that never touched the store. Placed BEFORE the INSERT so a
        // refused line leaves nothing behind at all.
        // The figure the central UPDATE subtracts. issuedQuantity unless the
        // floor below says this ask is "everything on the shelf", in which case
        // it is the balance itself — see planCentralDebit.
        let centralDebit = issuedQuantity;
        if (deduct_inventory && materialId) {
          const bal = readBalance.get(materialId) as {
            name: string; unit: string | null; purchase_unit: string | null;
            pack_size: number | null; current_stock: number;
          } | undefined;
          // A material_id the caller invented has no row, so the UPDATE below
          // matches nothing and no balance moves. There is nothing for a floor
          // to bound, and refusing here would newly reject a line that today
          // fails (or no-ops) further down — so leave that path exactly as it is.
          if (bal) {
            const stock = Number(bal.current_stock) || 0;
            // THE ONE RULE (src/lib/central-debit-clamp.ts planCentralDebit).
            // This floor used to round the allowance to 6 dp and then compare the
            // RAW ask with a 1e-9 slack — two decisions that disagreed both ways.
            // MEASURED: stored 14842.500000001 asked in full was REFUSED (production
            // answered 201 and landed on 0), and stored 99.9999996 rounded UP to
            // 100, so an ask of 100 passed and wrote -4e-7. The plan compares on
            // one 6-dp grid and says what to subtract, so both are gone.
            // max(0, …) lives inside it: an already-negative balance reads as
            // "nothing issuable", never as a negative allowance. See the header.
            const plan = planCentralDebit(stock, issuedQuantity);
            centralDebit = plan.debit;
            // A DISPLAY figure only — never compared. Rounded at the precision the
            // sentence prints (fmtQtyNum, 3 dp) without ever naming more than the
            // floor accepts, so "re-send it for X or less" is a figure that fits.
            // printableCap: never 0 while the store holds a grid step or more —
            // a crumb under 0.001 falls to 6 dp, so "holds none" is said only
            // when holdsAny() says it is true.
            const cap = printableCap(plan.available, 3);
            const available = cap.value;
            if (!plan.fits) {
              // BOTH BASES IN ONE SENTENCE. The caller's issued_quantity is
              // RECIPE units (this file's basis contract), so the recipe figure
              // leads — it is the number the client must change. The
              // purchase-unit figure follows for the owner's store-display rule
              // whenever the material is packed, and it comes from the imported
              // toPurchaseQty, never a re-derived pack factor (the 750x trap).
              const meta = { unit: bal.unit, purchase_unit: bal.purchase_unit, pack_size: bal.pack_size };
              const ru = String(bal.unit || '').trim();
              const pu = String(bal.purchase_unit || '').trim();
              const packed = packFactor(meta) > 1;
              const q = (n: number) => {
                const recipe = `${fmtQtyNum(n)}${ru ? ` ${ru}` : ''}`;
                return packed ? `${recipe} (${fmtQtyNum(toPurchaseQty(n, meta))}${pu ? ` ${pu}` : ''})` : recipe;
              };
              // THE CAP'S PURCHASE FIGURE ROUNDS DOWN TOO. toPurchaseQty rounds to
              // 3 dp and printed 14,842.5 g as "14.843 kg" — more than is there.
              // `available` is already floored on the recipe side; this keeps the
              // parenthetical from undoing that. The ASK keeps q() above.
              // The purchase parenthetical is DROPPED when its 3-dp floor reads 0
              // (0.4 g of a 1000-pack): "holds only 0.4 g (0 kg)" says nothing is
              // there in the very unit the store reads. A sub-display recipe
              // figure (cap.dp 6) prints at the grid's 6 dp.
              const qCap = (n: number) => {
                const recipe = `${cap.dp > 3 ? fmtGridQty(n) : fmtQtyNum(n)}${ru ? ` ${ru}` : ''}`;
                const puFig = qtyDown(n / packFactor(meta), 3);
                return packed && puFig > 0
                  ? `${recipe} (${fmtQtyNum(puFig)}${pu ? ` ${pu}` : ''})`
                  : recipe;
              };
              results.errors.push(
                available > 0
                  ? `Row ${i + 1}: ${bal.name} — the central store holds only ${qCap(available)}, `
                    + `so ${q(issuedQuantity)} cannot be issued. Nothing was recorded for this line; `
                    + `re-send it for ${qCap(available)} or less.`
                  : `Row ${i + 1}: ${bal.name} — the central store holds none of it, `
                    + `so ${q(issuedQuantity)} cannot be issued. Nothing was recorded for this line; `
                    + `receive the stock, or record a closing count, first.`,
              );
              continue;
            }
          }
        }

        // At issue time, consumed = issued (no return recorded yet)
        // purchasePrice is ₹/RECIPE unit — it falls back to matched.average_price
        // (canon: ₹ per recipe unit) above and never touches last_purchase_price.
        // issuedQuantity is RECIPE units — the same number debits
        // raw_materials.current_stock ~20 lines below. See the file header.
        // rate-basis: recipe
        const totalCost = Math.round(purchasePrice * issuedQuantity * 100) / 100;
        const totalRevenue = isComp ? 0 : Math.round(sellingPrice * issuedQuantity * 100) / 100;

        const id = generateId();

        db.prepare(`
          INSERT INTO party_items (id, party_id, item_name, material_id, category,
            quantity, issued_quantity, returned_quantity, unit, purchase_price, selling_price,
            total_cost, total_revenue, is_complimentary, status, issued_at, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'issued', datetime('now'), ?, datetime('now'))
        `).run(
          id, item.party_id, item.item_name, materialId,
          item.category || 'beverage', issuedQuantity, issuedQuantity,
          item.unit || 'pcs', purchasePrice, sellingPrice,
          totalCost, totalRevenue, isComp, item.notes || ''
        );

        // Deduct from main inventory if requested and material matched
        if (deduct_inventory && materialId) {
          // centralDebit, not issuedQuantity: on an ask of "everything on the
          // shelf" it is the balance itself, so this lands on exactly 0 instead
          // of -4e-7. Everywhere else it IS issuedQuantity. The party_items row
          // above keeps the caller's figure (the external client's contract); the
          // two differ by under one 6-dp step and only on that "everything" ask.
          // The movement row carries the debit, so it reconciles to the column.
          db.prepare(`
            UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(centralDebit, materialId);

          db.prepare(`
            INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
            VALUES (?, ?, 'party_issue', ?, ?, ?, datetime('now'))
          `).run(
            generateId(), materialId, -centralDebit, id,
            `Issued to party ${item.party_id}`
          );
        }

        results.success++;
      }
    });

    insertItems();

    return Response.json(results, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// PATCH: Record returns for party items (closing) — returns unused qty to inventory
export async function PATCH(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { returns, restore_inventory } = body;

    if (!returns || !Array.isArray(returns) || returns.length === 0) {
      return Response.json({ error: 'returns array is required' }, { status: 400 });
    }

    const results = { success: 0, errors: [] as string[] };

    const processReturns = db.transaction(() => {
      for (let i = 0; i < returns.length; i++) {
        const ret = returns[i];
        if (!ret.id) {
          results.errors.push(`Row ${i + 1}: item id required`);
          continue;
        }

        const item = db.prepare('SELECT * FROM party_items WHERE id = ?').get(ret.id) as any;
        if (!item) {
          results.errors.push(`Row ${i + 1}: item not found`);
          continue;
        }

        const returnedQty = Number(ret.returned_quantity) || 0;
        if (returnedQty < 0) {
          results.errors.push(`Row ${i + 1}: returned quantity cannot be negative`);
          continue;
        }
        if (returnedQty > item.issued_quantity) {
          results.errors.push(`Row ${i + 1}: returned (${returnedQty}) cannot exceed issued (${item.issued_quantity})`);
          continue;
        }

        const consumedQty = item.issued_quantity - returnedQty;
        // Re-costing the SAME stored row, so both halves keep the basis the POST
        // wrote: item.purchase_price is ₹/RECIPE unit and consumedQty is RECIPE
        // units (issued − returned, the pair that moves current_stock). No pack
        // factor — introducing one here would disagree with the issue-time cost.
        // rate-basis: recipe
        const totalCost = Math.round(item.purchase_price * consumedQty * 100) / 100;
        const totalRevenue = item.is_complimentary
          ? 0
          : Math.round(item.selling_price * consumedQty * 100) / 100;

        db.prepare(`
          UPDATE party_items SET
            returned_quantity = ?,
            quantity = ?,
            total_cost = ?,
            total_revenue = ?,
            status = 'closed',
            returned_at = datetime('now'),
            notes = COALESCE(?, notes)
          WHERE id = ?
        `).run(returnedQty, consumedQty, totalCost, totalRevenue, ret.notes || null, ret.id);

        // Restore unused to main inventory
        if (restore_inventory && item.material_id && returnedQty > 0) {
          db.prepare(`
            UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(returnedQty, item.material_id);

          db.prepare(`
            INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
            VALUES (?, ?, 'party_return', ?, ?, ?, datetime('now'))
          `).run(
            generateId(), item.material_id, returnedQty, ret.id,
            `Returned from party ${item.party_id} (unused)`
          );
        }

        results.success++;
      }
    });

    processReturns();

    return Response.json(results);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (!id) {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }

    // If deleting an issued item, restore the stock
    const item = db.prepare('SELECT * FROM party_items WHERE id = ?').get(id) as any;
    if (item && item.material_id && item.status === 'issued') {
      const netRemoved = item.issued_quantity - item.returned_quantity;
      if (netRemoved > 0) {
        db.prepare('UPDATE raw_materials SET current_stock = current_stock + ? WHERE id = ?')
          .run(netRemoved, item.material_id);
        db.prepare(`
          INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
          VALUES (?, ?, 'adjustment', ?, ?, ?, datetime('now'))
        `).run(generateId(), item.material_id, netRemoved, id, `Party item deleted — restored to stock`);
      }
    }

    db.prepare('DELETE FROM party_items WHERE id = ?').run(id);
    return Response.json({ success: true });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
