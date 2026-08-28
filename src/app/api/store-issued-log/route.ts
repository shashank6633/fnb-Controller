import { getDb } from '@/lib/db';
import { getCurrentUser, canProcessAsStore } from '@/lib/auth';
import { packFactor } from '@/lib/pack-units';
import { rateMap, materialRate } from '@/lib/closing-valuation';
import { isStoreMappedMaterial } from '@/lib/store-engine';

/**
 * Cross-requisition issued-items log.
 *
 * One row per *issue event* (a single hand-over from store to a department).
 * Built by unrolling the `issue_history` JSON on every requisition_item, so
 * split-issues (e.g. 30 kg now + 20 kg later) appear as two distinct rows.
 *
 * Query params:
 *   from           ISO date (inclusive). Defaults to today.
 *   to             ISO date (inclusive). Defaults to today.
 *   department_id  optional filter
 *   material_id    optional filter
 *   issuer         optional substring match on issuer email
 *
 * Response: {
 *   events:  [{ at, qty, unit, material_name, department_name, issuer,
 *               req_number, req_id, item_id, note }, ...],
 *   totals:  { events, total_qty_value, distinct_materials, distinct_departments }
 * }
 *
 * Access: store-managers (canProcessAsStore) + admins.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canProcessAsStore(me)) {
      return Response.json({ error: 'Store permission required' }, { status: 403 });
    }

    const db = getDb();
    const url = new URL(request.url);
    const today = new Date().toISOString().slice(0, 10);
    const from = url.searchParams.get('from') || today;
    const to   = url.searchParams.get('to')   || today;
    const departmentId = url.searchParams.get('department_id') || '';
    const materialId   = url.searchParams.get('material_id') || '';
    const issuer       = (url.searchParams.get('issuer') || '').toLowerCase();

    const where: string[] = ['ri.issue_history IS NOT NULL', 'ri.issue_history != \'\'', 'ri.issue_history != \'[]\''];
    const params: any[] = [];
    if (departmentId) {
      where.push('(ri.department_id = ? OR r.department_id = ?)');
      params.push(departmentId, departmentId);
    }
    if (materialId) { where.push('ri.material_id = ?'); params.push(materialId); }

    // Pull every line that has at least one issue event, then expand in JS.
    // SQLite's JSON1 could do this server-side, but keeping it in JS makes the
    // shape much easier to evolve.
    //
    // The stored last-purchase-price column on raw_materials is DELIBERATELY NOT
    // SELECTED here, and must not be added back. It holds mixed bases on this
    // database: of the 190 packed materials carrying both that column and a
    // purchase history, 115 hold Rs per PURCHASE unit and 71 already hold Rs per
    // RECIPE unit. This route used to divide it by pack_size unconditionally,
    // which converted those 71 a second time — 100 PIPERS (750ML) stores 2.2112
    // (Rs/ml, matching its average_price 2.5404), divided again by 750 gives
    // Rs 0.00295/ml, 862x low, so a 2-BTL issue logged Rs 4.42 instead of ~Rs 3811.
    // Rates now come from src/lib/closing-valuation.ts, the sanctioned ladder:
    // latest purchases.unit_price (Rs per PURCHASE unit by canon), then
    // average_price x packFactor, then none.
    const rows = db.prepare(`
      SELECT ri.id AS item_id, ri.req_id, ri.material_id, ri.department_id AS line_dept_id,
             ri.quantity_requested, ri.chef_approved_qty, ri.quantity_issued, ri.is_rejected,
             ri.issue_history, ri.notes, ri.unit AS line_unit,
             rm.name AS material_name, rm.unit, rm.average_price,
             rm.purchase_unit AS rm_purchase_unit, COALESCE(rm.pack_size, 1) AS rm_pack_size,
             rm.category AS rm_category, COALESCE(rm.tax_percent, 0) AS rm_tax_percent,
             r.req_number, r.department_id AS req_dept_id, r.purpose, r.event_name,
             COALESCE(d_line.name, d_req.name) AS department_name
      FROM requisition_items ri
      JOIN raw_materials rm ON rm.id = ri.material_id
      JOIN requisitions r   ON r.id   = ri.req_id
      LEFT JOIN departments d_req  ON d_req.id  = r.department_id
      LEFT JOIN departments d_line ON d_line.id = ri.department_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.req_number DESC
    `).all(...params) as any[];

    const events: any[] = [];
    let totalValue = 0;
    const dists = { materials: new Set<string>(), departments: new Set<string>() };

    // ONE query for the whole log: the latest priced purchase per material. Passing
    // the hit (or an explicit null) into materialRate as `preloaded` keeps it from
    // running its own per-material SELECT inside the loop.
    const rates = rows.length ? rateMap(db) : new Map<string, { unit_price: number; date: string }>();

    // ── LIQUOR ZERO-RATE LOCK for the derived GST columns ────────────────────
    // Both receiving routes hard-zero-rate store-mapped (TGBCL) materials —
    // api/grn/route.ts and purchase-orders/[id]/receive/route.ts both do
    // `isStoreMappedMaterial(...) ? 0 : rate` — because liquor duty rides on the
    // TGBCL bill as excise / cess / TCS, never as GST. The master is NOT a safe
    // unguarded source here: it already carries 18% on at least one liquor row
    // ('Vodka', category 'bar'), and this log carries liquor issues, so without
    // this lock the log would add a GST the venue never paid on top of duty it
    // already paid. Memoised per CATEGORY (isStoreMappedMaterial resolves an id
    // to its category anyway), the same shape as api/department-variance.
    // A failed check counts as ZERO-RATED: we cannot prove GST applies, and
    // inventing a tax is worse than omitting one on a derived column.
    const storeMappedMemo = new Map<string, boolean>();
    const zeroRated = (category: string): boolean => {
      const key = String(category || '').trim();
      if (!key) return false;
      const cached = storeMappedMemo.get(key);
      if (cached !== undefined) return cached;
      let v = true;
      try { v = isStoreMappedMaterial(db, key); }
      catch (e) { console.error(`[store-issued-log] store-mapped check failed for '${key}' — treating as zero-rated`, e); }
      storeMappedMemo.set(key, v);
      return v;
    };

    for (const row of rows) {
      // PackMeta + average_price, the shape closing-valuation reads. `unit` is the
      // RECIPE unit, `purchase_unit` the PURCHASE unit; packFactor/toPurchaseQty
      // apply the both-halves guard (pack_size > 1 AND unit !== purchase_unit), so
      // a kg/kg pack_size-1.5 material like PICKLED GINGER is never converted.
      const mat = {
        id: row.material_id as string,
        unit: row.unit,
        purchase_unit: row.rm_purchase_unit,
        pack_size: row.rm_pack_size,
        average_price: row.average_price,
      };
      const preloaded = rates.get(row.material_id) ?? null;
      const matPackFactor = packFactor(mat);
      // Resolved ONCE per requisition line: the rate depends only on the material,
      // never on the individual issue event, so a split issue (30 kg now + 20 kg
      // later) is costed at one consistent rate. ratePerPurchaseUnit is Rs per
      // PURCHASE unit by construction on every rung of the ladder.
      const rate = materialRate(db, mat, preloaded);
      const ratePU = rate.ratePerPurchaseUnit;

      // GST ONLY — compensation cess is deliberately NOT folded in. Three
      // reasons, all of them already settled elsewhere in this codebase:
      //   1. "Incl. Tax" ALREADY has a shipped meaning here and it excludes
      //      cess (purchase-orders/page.tsx: `incl_tax = taxable + tax_value`,
      //      "Cess is shown on its own line instead of being buried inside a
      //      column headed 'Incl. Tax'"). A second meaning on this screen would
      //      put the two at odds. The CSV header therefore says GST, not "tax".
      //   2. The two levies have DIFFERENT taxable bases (owner ruling
      //      2026-08-07: GST on goods MINUS discount, cess on the PRE-discount
      //      gross). An issue is not a bill — there is no gross and no discount
      //      share, the discount is already netted into unit_price and averaged
      //      into average_price — so the cess base does not exist on this side.
      //   3. GST is reclaimable input credit; compensation cess is not
      //      creditable against GST. Summing them into one number states the
      //      opposite of both facts.
      // The rate is the MATERIAL MASTER's default, not the rate on the bill this
      // stock arrived on (nothing in the purchase/GRN/receive flow ever writes a
      // rate back onto raw_materials — those columns are read-only seeds), and
      // the money it loads is a ladder-derived cost, not an amount paid on a
      // specific invoice. Hence "(master)" and "(est.)" in the CSV headers.
      // 0 is indistinguishable from "never filled in" (tax_percent is
      // NOT NULL DEFAULT 0 and there is no *_set flag), so `tax_known` travels
      // with it and the CSV prints a BLANK rate cell rather than a confident
      // "0" — the same call api/inventory/export/route.ts already makes.
      const rmCategory = String(row.rm_category || '');
      const taxPct = zeroRated(rmCategory) ? 0 : Math.max(0, Number(row.rm_tax_percent) || 0);

      // ── LINE UNIT BASIS — resolved ONCE per requisition line ───────────────
      // h.qty is stored IN THE LINE'S OWN UNIT (requisition_items.unit) — the
      // reqPackFactor convention. An earlier comment here claimed "h.qty is
      // RECIPE units"; that was only true of blank-unit lines. The composer
      // stamps the PURCHASE unit on every line (and a 2026-07-27 backfill
      // stamped the 16k Recaho-imported ones), so a "5" against unit 'kg' is
      // FIVE KILOS — reading it as grams understated qty and value pack_size×.
      //
      // These six were computed INSIDE the event loop below until the line-level
      // fulfilment columns arrived. Every one of them is a function of the
      // MATERIAL and the LINE alone — never of the individual hand-over — so
      // they are hoisted rather than copied: a second local copy of the
      // both-halves guard is the exact failure pack-units.ts warns about
      // ("local copies keep dropping the second half"). Hoisting is
      // behaviour-neutral for the event rows; the loop reads the same values it
      // used to compute for itself.
      const vPack = Number(row.rm_pack_size) || 1;
      const puNorm = String(row.rm_purchase_unit || row.unit || '').toLowerCase().trim();
      const ruNorm = String(row.unit || '').toLowerCase().trim();
      const luNorm = String(row.line_unit || '').toLowerCase().trim();
      const vDiffer = ruNorm !== puNorm;
      // Both-halves guard, applied to the LINE unit: the qty is purchase-basis
      // only when the line was requested in the purchase unit of a real pack.
      const lineIsPU = vPack > 1 && vDiffer && luNorm !== '' && luNorm === puNorm;

      // ── LINE-LEVEL FULFILMENT, IN PURCHASE UNITS ───────────────────────────
      // requisition_items.quantity_requested / chef_approved_qty / quantity_issued
      // are all stored in the LINE's own unit (Option B), the same basis as
      // h.qty — so they take the SAME restatement `qtyPurchase` takes below, and
      // they take it from the SAME hoisted guard rather than a re-derivation.
      //
      // Rounded to 6 dp, NOT the 3 dp the per-event `qty_purchase` uses. 3 dp is
      // enough for a hand-over a human counted out, but these columns also carry
      // the small pours this log exists to record: 12 ml of a pack-50,000 keg is
      // 0.00024 CAN, which 3 dp prints as a flat "0.000" — a quantity column that
      // renders a real issue as nothing is worse than a long decimal. This is a
      // DISPLAY precision only; no money is derived from these three (the money
      // columns still come off the recipe-basis pair above, deliberately — see
      // the MONEY note in the loop), so the rounding hazard that bans
      // toPurchaseQty()/valueCount() from the value math does not reach here.
      const toPurchaseBasis = (v: any): number => {
        const n = Number(v) || 0;
        const pu = lineIsPU ? n : n / ((vPack > 1 && vDiffer) ? vPack : 1);
        return Math.round(pu * 1e6) / 1e6;
      };
      // THE APPROVED RULE IS COPIED, NOT INVENTED. Verbatim from the requisition
      // status logic — api/requisitions/[id]/store-issue/route.ts:652, the
      // `allDone` test that decides whether a requisition flips to 'fulfilled':
      //
      //     const eff = (it.chef_approved_qty != null ? Number(it.chef_approved_qty)
      //                                               : Number(it.quantity_requested)) || 0;
      //
      // `!= null` is the rule, NOT `> 0` (requisitions/page.tsx:179 spells out
      // why: the store-issue MODAL's `> 0` variant answers a different question,
      // and copying it here would silently re-inflate a line the chef
      // deliberately cut to 0 back to the department's original ask). The same
      // rule again as SQL in api/requisitions/route.ts:218 and src/lib/issue-log.ts
      // (COALESCE(ri.chef_approved_qty, ri.quantity_requested, 0)), whose report
      // exports these same three columns as Requested / Approved-Effective /
      // Issued-To-Date. Four sites, one rule, so the CSV and the app cannot
      // disagree about what was approved.
      //
      // NO is_rejected CLAUSE, deliberately. The status logic short-circuits a
      // chef-rejected line as "done" BEFORE this expression runs, so the rule
      // itself has no rejection term, and issue-log.ts — the sibling report —
      // likewise reports the numbers and carries the rejection in its own
      // status column. Zeroing here would be re-inventing the rule, and would
      // erase what the chef actually approved on a line that nonetheless has
      // hand-over events against it.
      const effectiveLineQty = (row.chef_approved_qty != null
        ? Number(row.chef_approved_qty)
        : Number(row.quantity_requested)) || 0;
      const requestedQtyPurchase = toPurchaseBasis(row.quantity_requested);
      const effectiveQtyPurchase = toPurchaseBasis(effectiveLineQty);
      const issuedQtyPurchase    = toPurchaseBasis(row.quantity_issued);

      let history: Array<{ qty: number; at: string; by: string; note?: string }> = [];
      try { history = JSON.parse(row.issue_history || '[]'); } catch { continue; }
      if (!Array.isArray(history) || history.length === 0) continue;

      for (const h of history) {
        const at = String(h.at || '');
        // Date filter on the issue timestamp itself (not on req.date).
        const isoDay = at.slice(0, 10);
        if (isoDay < from || isoDay > to) continue;
        if (issuer && !String(h.by || '').toLowerCase().includes(issuer)) continue;
        const rawQty = Number(h.qty) || 0;
        const recipeQty   = lineIsPU ? rawQty * vPack : rawQty;
        const qtyPurchase = Math.round((lineIsPU ? rawQty : rawQty / ((vPack > 1 && vDiffer) ? vPack : 1)) * 1000) / 1000;
        // ── MONEY: one basis on BOTH halves of the multiplication ───────────
        // Both halves are RECIPE basis here:
        //     value = recipeQty [ml] × unitCost [Rs/ml]
        // and unitCost is derived from the ladder's Rs-per-PURCHASE-unit rate by
        // dividing ONCE by the same packFactor that carries the both-halves guard,
        // so the pack cancels exactly instead of being applied twice.
        //
        // Deliberately NOT valueCount(): that helper multiplies toPurchaseQty(qty)
        // × ratePU, and toPurchaseQty ROUNDS TO 3 dp before the multiply — the very
        // thing pack-units.ts warns against ("Money never round-trips through the
        // purchase basis"). It is exact for a whole-bottle issue but collapses on
        // the small pours this log exists to record: 12 ml of KF PREMIUM DRAUGHT
        // 50 LTRS (pack 50,000) rounds to 0.000 kegs and values at Rs 0.00 instead
        // of Rs 1.90, and 30 ml values 66% HIGH at Rs 7.91 against Rs 4.75.
        // valueCount stays right for closing stock, where counts are whole packs.
        const unitCost = matPackFactor > 1 ? ratePU / matPackFactor : ratePU;
        const lineValue = Math.round(recipeQty * unitCost * 100) / 100;
        // ── DERIVED "incl. GST" — a SCALAR on the ex-tax figures, nothing more ─
        // A percent carries NO basis of its own, so multiplying by (1 + gst/100)
        // cannot re-introduce the basis mismatch guarded above: both halves of
        // the multiplication that produced `lineValue` were RECIPE basis, and a
        // scalar leaves that untouched. What is FORBIDDEN — and what would
        // reopen the bug — is building a tax-loaded PURCHASE-unit rate and
        // re-multiplying `qtyPurchase` by it: qtyPurchase is rounded to 3 dp for
        // display, so 12 ml of a pack-50,000 material is 0.000 purchase units and
        // the whole line, tax and all, collapses to Rs 0.00. Derive from
        // `lineValue`, never from the purchase pair.
        // Derived from the ALREADY-ROUNDED lineValue on purpose, so
        // (value_incl_gst - value) is exactly the GST on the Value that is
        // printed, mirroring the house invariant incl_tax = taxable + tax_value.
        // At taxPct 0 both are returned BIT-IDENTICAL to their ex-tax
        // counterparts (no float round-trip) — on today's master that is ~97% of
        // materials, and an incl. column equal to its ex-tax column is the
        // CORRECT answer there, not a bug to paper over.
        const unitCostInclGst = taxPct > 0 ? unitCost * (1 + taxPct / 100) : unitCost;
        const valueInclGst = taxPct > 0 ? Math.round(lineValue * (1 + taxPct / 100) * 100) / 100 : lineValue;
        totalValue += lineValue;
        dists.materials.add(row.material_id);
        if (row.department_name) dists.departments.add(row.department_name);
        events.push({
          at,
          // RECIPE basis — what the value is computed from (resolved through the
          // line's unit above). Kept so the costing trail stays checkable.
          qty: recipeQty,
          unit: row.unit,
          // PURCHASE basis — what the store actually handed over, and what the log
          // leads with. Equal to qty when the material is not packed.
          qty_purchase: qtyPurchase,
          purchase_unit: row.rm_purchase_unit || row.unit,
          pack_factor: (vPack > 1 && vDiffer) ? vPack : 1,
          // ── LINE-LEVEL CONTEXT — REPEATS ON EVERY EVENT ROW OF THIS LINE ────
          // PURCHASE basis, like qty_purchase beside them, so the four can be
          // read across without a mental conversion. They are facts about the
          // LINE, not about this hand-over: a line issued in three parts emits
          // three rows carrying the SAME requested / approved / issued beside
          // three DIFFERENT qty_purchase values, which is the whole point —
          // "asked 240, approved 200, issued 200 so far" next to "this
          // hand-over was 50". issued_qty_purchase is the line's CUMULATIVE
          // quantity_issued, NOT the sum of the rows in the current date range
          // and NOT this event: either of those would just restate qty_purchase.
          // It is also the honest figure on a STORE-REJECTED line, which since
          // 2026-08-26 keeps what was physically handed over (store-issue's
          // 'reject' leaves quantity_issued untouched and moves no stock).
          requested_qty_purchase: requestedQtyPurchase,
          effective_qty_purchase: effectiveQtyPurchase,
          issued_qty_purchase: issuedQtyPurchase,
          material_id: row.material_id,
          material_name: row.material_name,
          // raw_materials.category, verbatim. 952/952 populated on this DB, but
          // 'other' IS the schema default (141 rows), so it doubles as the
          // unfilled state. super_category is blank on 44% and is not used.
          category: row.rm_category || '',
          department_id: row.line_dept_id || row.req_dept_id,
          department_name: row.department_name || '',
          issuer: h.by || '',
          note: h.note || '',
          req_id: row.req_id,
          req_number: row.req_number,
          purpose: row.purpose,
          event_name: row.event_name || '',
          item_id: row.item_id,
          // RECIPE basis (₹ per g / ml) — pairs with `qty` above. Unchanged field,
          // unchanged basis; consumers that multiply qty × unit_cost still balance.
          unit_cost: unitCost,
          // PURCHASE basis (₹ per kg / L / BTL) — pairs with `qty_purchase`, which
          // is what this log LEADS with. A reader multiplying the two visible
          // purchase-unit columns now lands on `value` instead of a pack_size-off
          // number. Equal to unit_cost when the material is not packed.
          unit_cost_purchase: ratePU,
          // Which rung of the closing-valuation ladder this rate came from
          // ('last_purchase' | 'average_cost' | 'none') and the purchase date behind
          // it. A valuation nobody can trace is a valuation nobody trusts.
          rate_source: rate.source,
          rate_as_of: rate.asOf || null,
          value: lineValue,
          // ── ADDITIVE, GST-ONLY, EX-TAX FIGURES ABOVE ARE UNTOUCHED ──────────
          // unit_cost / unit_cost_purchase / value / totals.total_value stay the
          // ex-tax goods cost forever: average_price is derived from those and
          // feeds every recipe, so folding tax in would inflate every recipe by
          // the tax rate and forfeit the input credit (api/grn/route.ts).
          // These four are a DERIVED estimate that sits BESIDE them.
          tax_percent: taxPct,             // 0 also means "master never filled in"
          tax_known: taxPct > 0,           // ...so consumers print blank, not 0
          unit_cost_incl_gst: unitCostInclGst,   // RECIPE basis, pairs with unit_cost
          value_incl_gst: valueInclGst,          // == value when taxPct is 0
        });
      }
    }

    // Newest first
    events.sort((a, b) => (b.at || '').localeCompare(a.at || ''));

    return Response.json({
      events,
      totals: {
        events: events.length,
        total_value: Math.round(totalValue * 100) / 100,
        distinct_materials: dists.materials.size,
        distinct_departments: dists.departments.size,
      },
      filters: { from, to, department_id: departmentId, material_id: materialId, issuer },
    });
  } catch (e: any) {
    console.error('[store-issued-log]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
