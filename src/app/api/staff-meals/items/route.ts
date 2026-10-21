/**
 * STAFF MEAL ITEMS — the food a kitchen cooks for its own staff.
 *
 * ── WHICH RAIL LOSES THE GRAM ──────────────────────────────────────────────
 * staff_meal_items.department_id decides, and the two branches are BOTH real:
 *
 *   department_id NULL  → the STORE handed the goods over for this meal, so
 *                         CENTRAL loses the gram. Byte-identical to the
 *                         behaviour that shipped before the department cutover,
 *                         down to the inventory_transactions type strings that
 *                         the central variance report whitelists.
 *   department_id SET   → the department ALREADY HOLDS the goods (they left
 *                         central at requisition issue). Debiting central again
 *                         would remove the same gram twice and would inflate
 *                         that kitchen's apparent variance by exactly the amount
 *                         eaten by its own staff — an accusation manufactured by
 *                         double-counting. So the DEPARTMENT ledger loses it and
 *                         central is not touched at all, not even for a record:
 *                         a 'staff_meal_issue' row against central is subtracted
 *                         from the central theoretical, so writing one here
 *                         would re-introduce the double count through the report
 *                         instead of through the stock column.
 *
 * The NULL branch is not a leftover to be tidied away. The store genuinely does
 * cook staff food out of its own shelf, and 0 rows existed at cutover so there
 * is no history that has to pick a side.
 *
 * ── THE CENTRAL FLOOR (2026-10-13) ────────────────────────────────────────
 * BOTH branches are now bounded. The department branch always was (Rule 2
 * below); the central branch was not, and the gate at the top of the dept block
 * is why: `if (deduct_inventory && materialId && departmentId)`. Every real
 * staff-meal issue misses it — src/app/staff-meals/page.tsx:450-452 posts
 * `{ items: payload, deduct_inventory: true }` and sends NO department_id, on
 * either half — so the one branch that every operator reaches was the unbounded
 * one. A guard that reads correctly and can never fire for the live caller is
 * this codebase's recorded inert-guard pattern; this one was merely in the wrong
 * scope.
 *
 * MEASURED, against a copy of the live DB with its -wal: CURD forced to
 * current_stock 0, then the page's own payload with issued_quantity 500 →
 * HTTP 201 {"success":1,"errors":[]} and current_stock 0 → −500. Nothing on the
 * path refused it. 486 of the 952 active materials sit at a balance of 0 today,
 * so more than half the catalog went below zero on its FIRST central line.
 *
 * THE RULE IS THE ONE EVERY OTHER RAIL USES — READ THE BALANCE, FLOOR IT AT
 * ZERO, AND DO NOT LET THE DEBIT GO BELOW — and it is IMPORTED, not retyped:
 * clampCentralDelta() from src/lib/central-debit-clamp.ts. That file is the
 * single implementation of "how far may this debit go" and its own header names
 * staff-meals as a lane that must call it rather than add another, because this
 * project has a recorded incident where two lanes each grew a helper of the same
 * shape and the same name and they silently disagreed. So there is no second
 * balance read in this route, no second max(0, …), no second epsilon and no
 * second rounding rule — and max(0, …) is the helper's, applied for
 * issue-stock.ts's original reason: an already-negative balance must read as
 * "nothing issuable", never as a negative allowance that lets the next issue dig
 * the hole deeper (0 of the 952 are negative today;
 * /api/inventory/fix-negative-stock exists because it has happened).
 *
 * IT REFUSES THE LINE AND REPORTS IT; IT DOES NOT CLAMP AND IT DOES NOT THROW.
 * The imported helper exists for the UNATTENDED writers, which clamp because a
 * throw there would roll back a delivery or a sign-off nobody is standing next
 * to. Its answer is used here as a QUESTION — "would this debit go below zero,
 * and by how much" — and the clamped delta it offers is never written, because:
 *   · Not a clamp, because staff_meal_items.issued_quantity and the debit are
 *     the same number, and PATCH credits returns back out of issued_quantity:
 *     a row reading "500 issued" against the 64 that actually moved would hand
 *     500 back to a store that only ever gave up 64. That is stock manufactured
 *     out of nothing. (The owner's clamp-instead-of-throw ruling is for
 *     UNATTENDED paths — a PO receipt, a QC sign-off, a cascade with no operator
 *     present — where destroying a correct delivery is the worse outcome. A
 *     staff-meal issue is a human at /staff-meals pressing Issue, so the
 *     refusal reaches someone who can act on it.)
 *   · Not a throw, because POST runs ONE db.transaction() for the whole batch
 *     and the owner's ruling is that a short line must not block its
 *     neighbours: the error goes on results.errors[] and the loop `continue`s,
 *     so the lines that CAN be issued still commit. Identical to how the
 *     department branch below already reports its own refusal.
 *
 * THE BALANCE IS READ FRESH, PER LINE, INSIDE THE TRANSACTION — never off the
 * `allMaterials` snapshot taken before the loop. One POST may carry two rows for
 * the same material (the page's grid allows it), and each fits while the pair
 * does not; re-reading means the second row sees the first row's debit already
 * in the balance. That is what the requisition floor relies on instead of an
 * accumulator, and it is PROVEN here (see the twice-on-one-material run in the
 * handoff), not assumed.
 *
 * NO STORE-MAPPED (LIQUOR) CARVE-OUT ON THIS BRANCH, and that is not an
 * oversight — see the asymmetry note in Rule 3. The department branch refuses a
 * store-mapped material because it structurally has no department balance; this
 * branch has always debited central for them and still does, so carving them
 * out of the FLOOR while leaving the DEBIT in place would excuse exactly the
 * materials that go negative first (95 of the 127 store-mapped materials hold a
 * central balance of 0). They are refused by the ordinary floor instead, and the
 * message points at the Liquor Store, which is where their balance really lives.
 *
 * WHAT THE FLOOR DELIBERATELY DOES NOT FIX: the pack-factor bug on this branch
 * (the PRE-EXISTING BUG note on the debit itself). The floor weighs the number
 * the UPDATE actually subtracts against the balance it actually subtracts it
 * from, so it bounds that statement exactly. Bounding the lineFactor()-converted
 * figure instead would refuse work the debit can safely do, and would apply the
 * pack fix to the GATE while leaving the WRITE wrong — the asymmetric half-fix
 * the PRE-EXISTING BUG note forbids. The refusal names the discrepancy out loud
 * and tells the operator the entry that makes the whole row right; it does not
 * paper over it.
 *
 * ── FOUR RULES A FUTURE ENGINEER WILL WANT TO "SIMPLIFY". DO NOT ───────────
 *  1. THE PACK FACTOR ON THE DEPARTMENT BRANCH. issued_quantity is in the LINE's
 *     unit (staff_meal_items.unit, which the UI defaults to 'kg'); the ledger and
 *     current_stock are in RECIPE units. 2 "kg" of a g/kg/1000 material is
 *     2,000 g, not 2. See the PRE-EXISTING BUG note on the central branch below:
 *     central gets this wrong today, and the ONLY thing keeping that from
 *     becoming two wrong numbers is that this branch converts with lineFactor(),
 *     the same helper the requisition rail uses. Never inline a `pack_size`
 *     multiply here — the both-halves rule (pack_size > 1 AND recipe unit !==
 *     purchase unit) is what stops PICKLED GINGER 1.5KG being multiplied by 1.5.
 *  2. THE NEGATIVE-BALANCE GUARD. A department cannot cook what it does not
 *     hold. The line is REFUSED with the available quantity named; it is never
 *     clamped and never allowed to drive the balance negative. A clamp would
 *     commit a meal costing 2 kg against a ledger that only gave up 0.4 kg, and
 *     the difference would surface later as unexplained loss on the department
 *     variance report with nothing on screen to explain it. THE CENTRAL BRANCH
 *     NOW CARRIES THE SAME GUARD, on the same terms — see THE CENTRAL FLOOR
 *     above. Neither rail may be left bare: whichever one is, it becomes the
 *     only one an operator can reach, which is precisely what happened here.
 *  3. THE LIQUOR CARVE-OUT. Store-mapped materials (TGBCL / store_stock_ledger)
 *     never enter the department raw-material rail. A department staff-meal line
 *     for one is REFUSED rather than quietly posted, because two rails claiming
 *     one bottle is the exact double count the cutover exists to remove. Note
 *     the asymmetry is deliberate: the NULL/central branch keeps its existing
 *     behaviour untouched, because changing what a shipped path does to central
 *     is not this change's business.
 *  4. THE RATE BASIS, RESOLVED SERVER-SIDE (2026-08-06). The trio this route
 *     writes — issued_quantity, purchase_price, total_cost — must be in ONE
 *     basis, and the client cannot be relied on to deliver one: /staff-meals
 *     seeds every row with unit 'kg' and copies raw_materials.average_price
 *     (Rs per RECIPE unit) straight into the rate box. 2 "kg" x Rs 0.4851/g =
 *     Rs 0.97 for Rs 970.20 of ARBORIO rice, a clean pack_size (1000x) error
 *     that looks like a plausible number on screen. So POST now decides the
 *     basis itself: a rate KNOWN to be recipe basis (server-filled from
 *     average_price, or the catalog value echoed back unedited) is lifted with
 *     purchasePrice() from pack-units whenever lineFactor() says the line is in
 *     purchase units. A rate a human actually typed is left alone — it is
 *     already Rs per the unit shown next to it. The quantity is NEVER re-labelled
 *     to "fix" this: re-labelling 2 kg as 2 g would move the error from the rate
 *     onto the ledger, where lineFactor() is currently getting it right.
 *
 * WHAT RULE 4 DELIBERATELY DOES NOT DO: it does not touch the CENTRAL stock
 * write. That statement still subtracts the raw line quantity (see the
 * PRE-EXISTING BUG note on it), so on a central staff meal the MONEY is now
 * right and the GRAMS are still short by pack_size. That is not an oversight and
 * it is not a reason to revert the money: two wrong numbers were never
 * "consistent", and the stock half changes a shipped figure on the central
 * variance report, which needs the owner's eyes and its own change. On the
 * DEPARTMENT branch there is no such gap — lineFactor() converts the ledger
 * debit and now the rate through the same factor, so 2000 g debited books
 * Rs 970.20.
 *
 * Nothing here fires unless deduct_inventory / restore_inventory is set — that
 * gate is unchanged and predates the cutover.
 */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { lineFactor } from '@/lib/issue-stock';
// `purchasePrice` is the DISPLAY-basis lift Rs/recipe-unit -> Rs/purchase-unit.
// Aliased because the loop below already owns a local named purchasePrice, and
// two things called the same name in one scope is how a basis gets swapped by
// accident.
import { packFactor, purchasePrice as ratePerPurchaseUnit } from '@/lib/pack-units';
import { postDeptLedger, deptOnHand } from '@/lib/dept-ledger';
import { centralFlowBlock } from '@/lib/store-engine';
// THE central cap, imported rather than retyped. Its own header names this lane
// as one that must call it instead of growing a near-copy; see THE CENTRAL FLOOR
// below for why this route uses its ANSWER as a refusal rather than writing the
// clamped delta it is built for.
import { clampCentralDelta, printableCap, fmtGridQty } from '@/lib/central-debit-clamp';

/** Float noise floor, matching dept-ledger's own. */
const EPS = 1e-9;
const r6 = (n: number) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const fmt = (n: number) => (Number.isInteger(r6(n)) ? String(r6(n)) : String(Math.round(n * 1000) / 1000));

/**
 * THE DEPARTMENT RAIL'S RESPONSIBLE USER: THE SESSION'S, OR NO MOVEMENT AT ALL.
 *
 * Owner ruling 15 fixed the department staff-meal crash by PASSING THE USER to
 * postDeptLedger. It did not authorise a movement nobody signed for, so a blank
 * session is refused here, never relabelled. A `system:staff-meal` stand-in
 * used to fill the gap, and the gap is reachable: src/proxy.ts step 2c reads
 * `s.expires_at > datetime('now')` as TEXT, while createSession() stores ISO
 * ('…T…Z', and 'T' sorts after ' '), so a token that expired earlier the same
 * UTC day passes the proxy while getCurrentUser() returns null. Production
 * refused that request (postDeptLedger threw: 500, whole batch rolled back).
 * This throws at the same point inside the same transaction, so the same
 * nothing is written. The handlers answer 401 'Sign in required' in place of
 * the developer-facing 500.
 *
 * Only the department rail calls this. The central branch never took a user
 * and is unchanged.
 */
const SIGN_IN_REQUIRED = 'Sign in required';
function deptActor(sessionEmail: string): string {
  if (!sessionEmail) throw Object.assign(new Error(SIGN_IN_REQUIRED), { staffMealNoSession: true });
  return sessionEmail;
}
/** 401 for deptActor()'s refusal; every other error keeps its 500. */
const errorStatus = (e: any) => (e && e.staffMealNoSession === true ? 401 : 500);

type DeptMove =
  | { ok: true; recipeQty: number; factor: number; departmentName: string; materialName: string; recipeUnit: string }
  | { ok: false; error: string };

/**
 * Everything that must be TRUE before a staff meal may move department stock,
 * resolved in one place so POST / PATCH / DELETE cannot drift apart.
 *
 * Returns a message instead of throwing: POST and PATCH process a BATCH inside a
 * single db.transaction(), and today a bad row is reported and skipped while its
 * siblings commit. A throw from inside the loop would roll the whole batch back
 * and change that contract for every caller, including the central-only rows
 * this change is not allowed to touch.
 */
function resolveDeptMove(
  db: any,
  a: { departmentId: string; materialId: string; lineUnit: string | null | undefined; qty: number },
): DeptMove {
  const dept = db.prepare('SELECT id, name FROM departments WHERE id = ?').get(a.departmentId) as
    | { id: string; name: string } | undefined;
  if (!dept) return { ok: false, error: `department ${a.departmentId} not found` };

  const rm = db.prepare(
    'SELECT id, name, unit, purchase_unit, pack_size FROM raw_materials WHERE id = ?',
  ).get(a.materialId) as
    | { id: string; name: string; unit: string; purchase_unit: string; pack_size: number } | undefined;
  if (!rm) return { ok: false, error: `material ${a.materialId} not found` };

  // Rule 3 — liquor keeps its own rail.
  const blocked = centralFlowBlock(db, a.materialId);
  if (blocked) {
    return {
      ok: false,
      error:
        `"${rm.name}" is a store-mapped (liquor) material and cannot be charged to a department's ` +
        `raw-material stock. Leave the department blank to record it against the store as before.`,
    };
  }

  // Rule 1 — the LINE unit -> RECIPE unit conversion, via the requisition rail's
  // own helper. needsReview means the line's unit is blank or unrecognised for a
  // packed material: refuse rather than guess, because guessing is a 1000x error
  // in whichever direction is wrong.
  const { factor, needsReview } = lineFactor(a.lineUnit, rm);
  if (needsReview) {
    return {
      ok: false,
      error:
        `"${rm.name}" is packed (${rm.pack_size} ${rm.unit} per ${rm.purchase_unit}) but this line's unit ` +
        `"${String(a.lineUnit ?? '').trim() || '(blank)'}" is neither. Set the line unit to ` +
        `"${rm.purchase_unit}" or "${rm.unit}" so the quantity can be converted.`,
    };
  }

  const recipeQty = r6(Number(a.qty) * factor);
  if (!Number.isFinite(recipeQty) || Math.abs(recipeQty) < EPS) {
    return { ok: false, error: `"${rm.name}" resolves to a zero quantity — nothing to move` };
  }
  return {
    ok: true, recipeQty, factor,
    departmentName: dept.name, materialName: rm.name,
    recipeUnit: String(rm.unit || '').trim(),
  };
}

/**
 * What the department may give up right now, RECIPE units.
 *
 * Before a cutover count exists deptOnHand() reports NULL rather than 0 — on
 * purpose, so no screen prints "0" for "nobody has counted this yet". For a
 * GUARD, NULL must resolve to the defensible number and not to either extreme:
 * treating it as 0 would refuse every staff meal until the admin runs a count,
 * and treating it as unlimited would defeat the guard. The signed movement sum
 * is what this rail has actually put in minus what it has taken out — the same
 * fallback assertReversible() uses for the same reason.
 */
function deptAvailable(db: any, departmentId: string, materialId: string): { available: number; neverCounted: boolean } {
  const bal = deptOnHand(db, departmentId, materialId);
  return {
    available: r6(bal.neverCounted ? bal.movementsSince : (bal.onHand ?? 0)),
    neverCounted: bal.neverCounted,
  };
}

/** '' / whitespace is NOT a department. Treat it as the central branch. */
function normDept(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const mealId = url.searchParams.get('meal_id');
    if (!mealId) return Response.json({ error: 'meal_id is required' }, { status: 400 });

    const items = db.prepare(`
      SELECT smi.*, rm.name as material_name, rm.unit as material_unit,
        rm.average_price as current_avg_price, rm.current_stock as material_current_stock,
        rm.category as material_category,
        d.name as department_name
      FROM staff_meal_items smi
      LEFT JOIN raw_materials rm ON smi.material_id = rm.id
      LEFT JOIN departments d ON d.id = smi.department_id
      WHERE smi.meal_id = ?
      ORDER BY smi.category, smi.item_name
    `).all(mealId);

    const summary = db.prepare(`
      SELECT
        COUNT(*) as total_items,
        SUM(issued_quantity) as total_issued,
        SUM(returned_quantity) as total_returned,
        SUM(quantity) as total_consumed,
        SUM(total_cost) as total_cost,
        SUM(CASE WHEN status = 'issued' THEN 1 ELSE 0 END) as open_items,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_items
      FROM staff_meal_items
      WHERE meal_id = ?
    `).get(mealId);

    return Response.json({ items, summary });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// POST: Issue items (deducts from inventory)
export async function POST(request: Request) {
  try {
    // THE RESPONSIBLE USER, FROM THE SESSION — postDeptLedger refuses a blank
    // one ("a responsible user is required"), so without this every DEPARTMENT
    // issue 500'd and rolled the whole batch back. Read here, before the
    // synchronous transaction, and never from the body: the body is the
    // caller's to write. No session means '' here, and deptActor() then refuses
    // the department movement (401, nothing written). No `system:` stand-in:
    // see deptActor() for why the session-less path is reachable.
    // Only the department rail takes it; the central branch is unchanged.
    const itemActor = String((await getCurrentUser())?.email || '').trim();
    const db = getDb();
    const body = await request.json();
    const { items, deduct_inventory } = body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items array is required' }, { status: 400 });
    }

    // A meal is usually cooked by ONE kitchen, so the department may be given
    // once for the batch; a line may still override it. Absent on both = NULL =
    // the store handed the goods over, which is what every existing caller
    // sends and therefore what keeps this route a no-op until a screen opts in.
    const batchDept = normDept(body.department_id);

    // department_id arrived with the cutover migration. Naming it in the INSERT
    // unconditionally would break staff meals outright on a database that has
    // not run that ALTER (a restored backup, a test fixture) — so the column is
    // only named when there is actually a department to record. The central
    // path then stays literally byte-identical, schema included.
    const hasDeptCol = (() => {
      try {
        return (db.prepare('PRAGMA table_info(staff_meal_items)').all() as any[])
          .some((c: any) => String(c.name) === 'department_id');
      } catch { return false; }
    })();

    // purchase_unit + pack_size are SELECTed so packFactor()/lineFactor() can be
    // applied to the RATE as well as the quantity (Rule 4). Without them the
    // catalog row cannot answer "is this line's unit the purchase unit?", which
    // is the whole question the rate basis turns on.
    const allMaterials = db.prepare(
      'SELECT id, name, average_price, unit, purchase_unit, pack_size, category, current_stock FROM raw_materials',
    ).all() as any[];
    const materialByName = new Map<string, any>();
    const materialById = new Map<string, any>();
    for (const m of allMaterials) {
      materialByName.set(m.name.toLowerCase().trim(), m);
      materialById.set(m.id, m);
    }

    const results = { success: 0, errors: [] as string[] };

    const insertItems = db.transaction(() => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.meal_id || !item.item_name) {
          results.errors.push(`Row ${i + 1}: meal_id and item_name required`);
          continue;
        }

        let materialId = item.material_id || null;
        let purchasePrice = Number(item.purchase_price) || 0;
        let category = item.category || '';
        let unit = item.unit || '';

        // Rule 4 (see header) — WHICH BASIS IS THIS RATE IN?
        // raw_materials.average_price is Rs per RECIPE unit (Rs/g, Rs/ml). A rate
        // a human typed into the box that sits beside the unit box is Rs per that
        // LINE unit. The two are pack_size apart and nothing on the wire says
        // which arrived, so it is tracked from the moment the number is chosen.
        let rateIsRecipeBasis = false;

        if (!materialId && item.item_name) {
          const matched = materialByName.get(item.item_name.toLowerCase().trim());
          if (matched) {
            materialId = matched.id;
            if (purchasePrice === 0) { purchasePrice = matched.average_price || 0; rateIsRecipeBasis = true; }
            if (!category) category = matched.category || 'grocery';
            if (!unit) unit = matched.unit || 'kg';
          }
        }
        if (materialId && purchasePrice === 0) {
          const mat = materialById.get(materialId);
          if (mat) {
            purchasePrice = mat.average_price || 0;
            rateIsRecipeBasis = true;
            if (!category) category = mat.category || 'grocery';
            if (!unit) unit = mat.unit || 'kg';
          }
        }

        const issuedQuantity = Number(item.issued_quantity ?? item.quantity) || 0;
        if (issuedQuantity <= 0) {
          results.errors.push(`Row ${i + 1}: issued quantity must be > 0`);
          continue;
        }

        const id = generateId();
        const lineUnit = unit || 'kg';
        const departmentId = normDept(item.department_id) ?? batchDept;

        // ── Rule 4: THE RATE MOVES WITH THE UNIT, SERVER-SIDE ──────────────────
        // The trio written below is (issued_quantity, purchase_price, total_cost)
        // and it must be SINGLE-BASIS:
        //     issued_quantity is in `lineUnit`  ->  purchase_price must be
        //     Rs per lineUnit  ->  total_cost = the product of the two.
        // The client cannot be trusted to pair them: /staff-meals seeds every new
        // row with unit 'kg' and, on the catalog dropdown, copies average_price
        // (Rs/RECIPE unit) straight into the rate box. That pairs 2 kg with
        // Rs 0.4851/g and books Rs 0.97 for Rs 970.20 of rice — the exact
        // dimensional error the owner asked about. So the basis is settled here,
        // where both halves are visible, and no client path can separate them.
        const rateMat = materialId ? materialById.get(materialId) : null;
        if (rateMat) {
          // The catalog echo — a BELT-AND-BRACES check against a client that
          // pairs a purchase-unit line with a raw average_price. A rate that
          // still EQUALS average_price to the paise was never re-typed, so it
          // is recipe basis exactly like the two branches above.
          //
          // The CURRENT /staff-meals bundle no longer does this: rateForUnit()
          // there resolves the rate from the same unit string the quantity is
          // counted in, so a kg line arrives already lifted and this test
          // correctly does not fire (485.10 !== 0.4851 — no double lift). Do
          // not delete it as dead code on that basis. It is what protects an
          // OLD bundle, and this app ships as a PWA with an IndexedDB outbox:
          // a tablet running last week's cached JS, or replaying a queued
          // offline POST, still posts the pre-fix pairing at any time. The
          // server is the only place that sees every client.
          const avg = Number(rateMat.average_price) || 0;
          if (!rateIsRecipeBasis && purchasePrice > 0 && avg > 0
              && Math.abs(purchasePrice - avg) <= 1e-9 * Math.max(1, Math.abs(avg))) {
            rateIsRecipeBasis = true;
          }

          // packFactor() carries the BOTH-HALVES guard (pack_size > 1 AND recipe
          // unit !== purchase unit). PICKLED GINGER 1.5KG (kg/kg, pack_size 1.5)
          // returns 1 here and is therefore never lifted, on either half.
          if (rateIsRecipeBasis && purchasePrice > 0 && packFactor(rateMat) > 1) {
            // lineFactor answers RECIPE UNITS PER LINE UNIT for this exact line:
            //   line unit === purchase unit -> pack_size  (2 "kg" = 2000 g)
            //   line unit === recipe  unit  -> 1          (already recipe basis)
            // It is the same helper the department ledger below converts with, so
            // the money and the grams cannot disagree about what "2" means.
            const { factor, needsReview } = lineFactor(lineUnit, rateMat);
            if (needsReview) {
              // Neither unit. Any rate we wrote would be a guess, and a guess is
              // a pack_size-sized rupee error. Refuse the line the same way the
              // department branch refuses an unconvertible quantity — and
              // `continue`, never throw, so the rest of the batch still commits.
              results.errors.push(
                `Row ${i + 1}: "${rateMat.name}" is packed (${rateMat.pack_size} ${rateMat.unit} per ` +
                `${rateMat.purchase_unit}) but this line's unit "${String(lineUnit).trim() || '(blank)'}" is ` +
                `neither, so its rate cannot be stated per "${lineUnit}". Set the line unit to ` +
                `"${rateMat.purchase_unit}" or "${rateMat.unit}".`,
              );
              continue;
            }
            if (factor > 1) {
              // Line is in PURCHASE units, rate was in RECIPE units -> lift the
              // rate, do NOT re-label the quantity. The owner's purchase-unit rule
              // wants the kg on screen; this is what makes the rate beside it a
              // Rs/kg. Rs 0.4851/g x 1000 = Rs 485.10/kg, and 2 kg x 485.10 =
              // Rs 970.20 — identical to 2000 g x Rs 0.4851.
              //
              // YES, THIS IGNORES ONE LINE OF pack-units's OWN DOC. That helper
              // is headed "DISPLAY-ONLY ... never use the output to compute a
              // line value", because on a DISPLAY surface the stored recipe
              // number is still the truth and rounding the rate would make two
              // screens disagree by paise. Here the lifted rate is not a
              // derivative of a stored truth — it IS the stored truth:
              // staff_meal_items.purchase_price is a real column, PATCH
              // recomputes total_cost from it on every return, and the owner's
              // complaint is precisely that the two visible columns must
              // multiply out to the third. A rate carried at full precision
              // would reconcile on no screen at all.
              // Measured cost of the 2-dp rounding on live data: of 282 packed
              // materials holding a price, 17 are not exact at 2 dp, and the
              // worst is KAHLUA LIQUEUR (750ML) — Rs 3.3063/ml x 750 = Rs
              // 2,479.725 stored as Rs 2,479.73, i.e. 5 PAISE on a ten-bottle
              // line. Five paise is the price of a column that adds up; the bug
              // being fixed here is 1,000x. Do not "restore precision" and
              // reintroduce a trio that does not multiply.
              purchasePrice = ratePerPurchaseUnit(purchasePrice, rateMat);
            }
            // factor === 1 means the line is ALREADY in recipe units, so a
            // recipe-basis rate is correct beside it. Leave it alone: converting a
            // right number is how this bug gets reintroduced from the other side.
          }
        }

        // Both operands are now in the LINE basis, so the product is the line's
        // real value and — the part that was broken on screen — the two stored
        // columns multiply out to the stored total.
        const totalCost = Math.round(purchasePrice * issuedQuantity * 100) / 100;

        // EVERY department check happens BEFORE the row is written. postDeptLedger
        // throws by design (it is built to roll a caller's transaction back), and
        // this loop runs inside one transaction for the whole batch — so a refusal
        // discovered after the INSERT would take the other lines down with it.
        // Validate first, `continue`, and the batch contract is preserved.
        let deptMove: DeptMove | null = null;
        // What the CENTRAL branch subtracts: issuedQuantity, or — on an issue of
        // everything on the shelf — the balance itself, set by the central floor
        // below from clampCentralDelta's own figure so the write lands on exactly
        // 0 and never at -4e-7 (planCentralDebit, src/lib/central-debit-clamp.ts).
        let centralDebit = issuedQuantity;
        if (deduct_inventory && materialId && departmentId) {
          deptMove = resolveDeptMove(db, { departmentId, materialId, lineUnit, qty: issuedQuantity });
          if (!deptMove.ok) {
            results.errors.push(`Row ${i + 1}: ${deptMove.error}`);
            continue;
          }
          // Rule 2 — refuse, never clamp, and name the number.
          const { available, neverCounted } = deptAvailable(db, departmentId, materialId);
          if (deptMove.recipeQty > available + EPS) {
            results.errors.push(
              `Row ${i + 1}: ${deptMove.departmentName} holds only ${fmt(available)} ${deptMove.recipeUnit} ` +
              `of ${deptMove.materialName} — cannot issue ${fmt(deptMove.recipeQty)} ${deptMove.recipeUnit}.` +
              (neverCounted
                ? ' This department has no opening count for it yet; record a department count first.'
                : ''),
            );
            continue;
          }
        } else if (deduct_inventory && materialId) {
          // ── THE CENTRAL FLOOR ────────────────────────────────────────────
          // See THE CENTRAL FLOOR in this file's header for the measurement,
          // the rule and why it reports instead of throwing.
          //
          // THE `else` IS THE GATE, and it is the gate on purpose. The central
          // UPDATE below runs exactly when `deduct_inventory && materialId` is
          // true and `deptMove` is null — and deptMove is null exactly when the
          // branch above was not taken (a resolved-but-refused deptMove has
          // already `continue`d). So this `else if` is, by construction, the
          // precise complement: every line that reaches the central debit
          // passes through here first, and no line that takes the department
          // rail is bounded twice. Re-stating the condition as a sibling `if`
          // would be a second copy of the same predicate, free to drift.
          // ONE IMPLEMENTATION OF "HOW FAR MAY THIS DEBIT GO", IMPORTED.
          // clampCentralDelta() reads the balance and computes the cap, and its
          // own header names this lane as one that must call it rather than
          // add its own: this project has a recorded incident where two lanes
          // each grew a helper of the same shape that silently disagreed. So
          // there is no second balance read here, no second max(0, …), no
          // second epsilon and no second rounding rule.
          //
          // WHAT THIS LANE DOES DIFFERENTLY IS THE *ANSWER*, NOT THE
          // ARITHMETIC. That file is for the unattended paths, which clamp
          // because a throw would roll back a delivery nobody is standing next
          // to; it says so in its first paragraph. A staff-meal issue is a
          // human at /staff-meals pressing Issue, so the owner's ruling for an
          // attended path applies: REFUSE the line, name the figure, write
          // nothing. The clamp result is therefore used as the QUESTION
          // ("would this debit go below zero, and by how much") and the debit
          // is never written in clamped form — which is also why
          // recordCentralDebitClamp() is not called: nothing committed, so
          // there is no permanent shortfall to log, only a sentence to show.
          //
          // The delta is NEGATIVE `issuedQuantity`, RAW AND UNCONVERTED, because
          // that is the exact number the UPDATE below subtracts. This is the one
          // place in this file where NOT applying lineFactor() is correct: the
          // floor's job is to bound the statement that exists, not the statement
          // the PRE-EXISTING BUG note says should exist. Convert here and the
          // gate would refuse 500 kg against a 600 g balance while the debit it
          // guards would have taken 500 g and left 100 — refusing correct work,
          // and half-fixing the pack bug on the gate while the write stayed
          // wrong.
          const clamp = clampCentralDelta(db, { materialId, deltaRecipe: -issuedQuantity });
          // When the line fits, deltaToWrite is the ask — or the balance itself on
          // an ask of everything — and that is the figure the UPDATE below takes.
          // When it does not fit, the line is refused just below and this is
          // never written. A material with no row reports exists:false and
          // deltaToWrite = the ask, so the no-op UPDATE is unchanged.
          if (!clamp.clamped) centralDebit = -clamp.deltaToWrite;
          // `clamped` is true exactly when the debit exceeds max(0, balance) —
          // the helper's comparison, not a restatement of it. A material_id with
          // no row reports exists:false and clamped:false and is deliberately
          // let through: there is no balance to drive negative, the UPDATE below
          // matches nothing, and refusing here would newly reject a line that
          // today simply no-ops. The parties and wastage floors make the
          // identical call on the identical reasoning.
          if (clamp.clamped) {
            // `deltaToWrite` is the helper's own cap (−max(0, balance)), so the
            // figure this message prints is the figure the floor computed; a
            // locally re-derived "available" is exactly the near-copy that
            // disagrees in the sixth decimal.
            // Rounded DOWN at the precision `fmt` prints (3 dp) — a "holds only X"
            // that names more than the floor accepts sends the operator to retype
            // a refused figure (99.9996 g used to print as 100 g).
            // printableCap, not a bare qtyDown: a crumb under 0.001 would round to
            // 0 and the sentence would say "holds no X" over a balance that is
            // there. It falls to 6 dp instead (holdsAny decides "none").
            const cap = printableCap(-clamp.deltaToWrite, 3);
            const available = cap.value;
            // The PACK SHAPE comes from the pre-loop catalog snapshot, and that
            // is correct rather than lazy: unit / purchase_unit / pack_size are
            // CATALOG METADATA and nothing in this loop writes them, so there is
            // no stale-read hazard — that hazard is about the BALANCE, which is
            // why the balance is the thing read late, inside the transaction, by
            // the helper. Rule 4 twelve lines above already resolves this very
            // material from this very map for this very lineFactor() call, so
            // the floor and the rate decision cannot disagree about the
            // material's pack shape. The NAME is taken from the clamp instead,
            // because the helper reads it in the same statement as the balance.
            const shape = materialById.get(materialId);
            const matName = clamp.materialName || (shape ? String(shape.name) : materialId);

            // unit-lock: RECIPE basis, both figures. `available` is the cap on
            // raw_materials.current_stock, recipe units by canon;
            // `issuedQuantity` is the figure the UPDATE removes from that same
            // column, so recipe units is what it is WORTH to central whatever
            // the row is labelled. Printing the cap in purchase units — the
            // owner's store-display rule — would name a number this route will
            // not accept, because the debit never divides by pack_size.
            const ru = String(shape?.unit || '').trim();
            const q = (n: number) => `${fmt(n)}${ru ? ` ${ru}` : ''}`;
            const qCap = (n: number) => (cap.dp > 3 ? `${fmtGridQty(n)}${ru ? ` ${ru}` : ''}` : q(n));

            // THE WAY OUT answers "what do I do now", and it is the department
            // branch's own shape: name the figure when there is one, name the
            // screen when there is not.
            const wayOut = available > 0
              ? `Issue ${qCap(available)} or less on this line.`
              : centralFlowBlock(db, materialId)
                // 95 of the 127 store-mapped materials hold a central balance
                // of 0, so "receive the stock" would send the operator to a
                // screen that is never going to hold it. This branch DEBITS
                // store-mapped materials (see the header) — only the advice
                // differs, never the floor.
                ? `"${matName}" is a store-mapped (liquor) material — its balance lives on the ` +
                  `Liquor Store, not on the Central Store.`
                : 'Receive the stock, or record a closing count, first.';

            // THE BASIS NOTE answers a DIFFERENT question — "why does your
            // sentence say g when my row says kg" — so it is appended, not
            // substituted. Folding the two together shadowed the Liquor Store
            // pointer on every packed store-mapped material, which is most of
            // them.
            //
            // lineFactor() is what decides whether the note applies: the same
            // helper the department branch and Rule 4 use, never a hand-rolled
            // pack_size test. factor > 1 means this row is counted in the
            // PURCHASE unit while the debit it is about to be refused for
            // counts RECIPE units — the PRE-EXISTING BUG, showing through.
            // Saying so is the honest alternative to a sentence that looks
            // like an app error, and "enter the row in <recipe unit>" is a
            // real fix for the whole row: at that unit lineFactor is 1, the
            // debit is right, and rateForUnit on the page prices the line in
            // Rs per that same unit (Rule 4), so the money is right too.
            const basisNote = shape && lineFactor(lineUnit, shape).factor > 1
              ? ` This row is entered in ${shape.purchase_unit}; a central staff-meal issue comes off the `
                + `store in ${ru} (${shape.pack_size} ${ru} per ${shape.purchase_unit}), so the quantity above `
                + `is read as ${q(issuedQuantity)} — enter the row in ${ru} to match.`
              : '';

            results.errors.push(
              (available > 0
                ? `Row ${i + 1}: the Central Store holds only ${qCap(available)} of ${matName} — `
                  + `cannot issue ${q(issuedQuantity)}. `
                : `Row ${i + 1}: the Central Store holds no ${matName} — `
                  + `cannot issue ${q(issuedQuantity)}. `)
              + `Nothing was recorded for this line. ` + wayOut + basisNote,
            );
            continue;
          }
        }

        const withDept = hasDeptCol && !!departmentId;
        db.prepare(`
          INSERT INTO staff_meal_items (id, meal_id, item_name, material_id, category,
            quantity, issued_quantity, returned_quantity, unit, purchase_price, total_cost,
            status, issued_at, notes, created_at${withDept ? ', department_id' : ''})
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'issued', datetime('now'), ?, datetime('now')${withDept ? ', ?' : ''})
        `).run(
          id, item.meal_id, item.item_name, materialId,
          category || 'grocery', issuedQuantity, issuedQuantity,
          lineUnit, purchasePrice, totalCost, item.notes || '',
          ...(withDept ? [departmentId] : [])
        );

        if (deduct_inventory && materialId) {
          if (deptMove && deptMove.ok) {
            // DEPARTMENT branch. Central is deliberately NOT touched — see the
            // header. The signed ledger row IS the record; there is no central
            // inventory_transactions row to write, and adding one "for the audit"
            // would re-create the double count inside the variance report.
            postDeptLedger(db, {
              departmentId: departmentId!,
              materialId,
              type: 'staff_meal',
              quantity: -deptMove.recipeQty,
              referenceId: item.meal_id,
              source: 'staff-meals/items:POST',
              notes: `Staff meal ${item.meal_id} — ${item.item_name} (${fmt(issuedQuantity)} ${lineUnit})`,
              // Required by postDeptLedger. Its throw fires AFTER the
              // staff_meal_items INSERT above, so a missing user took every
              // other line of the batch down with it. With no session,
              // deptActor() throws here instead: same point, same rollback, 401.
              user: deptActor(itemActor),
            });
          } else {
            // CENTRAL branch — unchanged, on purpose.
            //
            // PRE-EXISTING BUG, DELIBERATELY NOT FIXED HERE (owner rule: never
            // silently undo shipped behaviour). issued_quantity is in the LINE's
            // unit — staff_meal_items.unit, which the UI defaults to 'kg' — while
            // current_stock is in RECIPE units. For a packed material (g/kg,
            // pack_size 1000) "2 kg" therefore removes 2 g from central, a 1000x
            // under-deduction, and the matching inventory_transactions row carries
            // the same wrong number into the central variance report. The fix is
            // to multiply by lineFactor(unit, rm) exactly as the department branch
            // above does, but it changes a shipped number on a shipped report and
            // needs its own change with the owner's eyes on it — see handoff.
            // Do NOT route this raw quantity at a department to "make them
            // consistent": that would copy the error into a second ledger.
            // Nor "restore consistency" by undoing Rule 4's rate lift above —
            // total_cost is now right on this branch while current_stock is still
            // short by pack_size. One right number and one wrong one is strictly
            // better than two wrong ones, and it is the wrong one that has to move.
            //
            // THE FIGURE IS THE FLOOR'S (centralDebit): issuedQuantity, except on
            // an issue of everything on the shelf, where it is the balance itself
            // and the write lands on exactly 0 — under one 6-dp step from the
            // ask. The basis question above is untouched by it.
            db.prepare(`
              UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now')
              WHERE id = ?
            `).run(centralDebit, materialId);

            db.prepare(`
              INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
              VALUES (?, ?, 'staff_meal_issue', ?, ?, ?, datetime('now'))
            `).run(
              generateId(), materialId, -centralDebit, id,
              `Issued to staff meal ${item.meal_id}`
            );
          }
        }

        results.success++;
      }
    });

    insertItems();
    return Response.json(results, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: errorStatus(error) });
  }
}

// PATCH: Record returns (restores unused to inventory)
export async function PATCH(request: Request) {
  try {
    // The responsible user, from the SESSION — see POST. A department return
    // posts through postDeptLedger and failed the same way. No session: '',
    // and deptActor() refuses the department return (401, nothing written).
    const itemActor = String((await getCurrentUser())?.email || '').trim();
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
        if (!ret.id) { results.errors.push(`Row ${i + 1}: item id required`); continue; }

        const item = db.prepare('SELECT * FROM staff_meal_items WHERE id = ?').get(ret.id) as any;
        if (!item) { results.errors.push(`Row ${i + 1}: item not found`); continue; }

        const returnedQty = Number(ret.returned_quantity) || 0;
        if (returnedQty < 0) {
          results.errors.push(`Row ${i + 1}: returned qty cannot be negative`);
          continue;
        }
        if (returnedQty > item.issued_quantity) {
          results.errors.push(`Row ${i + 1}: returned (${returnedQty}) cannot exceed issued (${item.issued_quantity})`);
          continue;
        }

        const consumedQty = item.issued_quantity - returnedQty;
        // BOTH OPERANDS ARE THE STORED ROW'S OWN LINE BASIS. consumedQty is
        // issued_quantity minus returned_quantity, both counted in `item.unit`;
        // item.purchase_price is Rs for one of that same unit because POST above
        // settled it there (Rule 4) before the row was ever written. Nothing here
        // re-derives a rate, and re-labelling either half would break the trio.
        // Declared "mixed" because the LINE unit is per-row (kg on a packed line,
        // g when the recipe unit was chosen) — single-basis WITHIN a row, which is
        // all this multiplication needs.  rate-basis: mixed
        const totalCost = Math.round(item.purchase_price * consumedQty * 100) / 100;

        // The return goes back to whichever rail the ISSUE came out of — read
        // off the row, never off the request. A meal charged to a department
        // must not be able to hand its leftovers back to central: that would
        // move a gram from a rail that never lost it, which is stock created
        // out of nothing. Validate BEFORE the UPDATE, same reason as POST.
        const departmentId = normDept(item.department_id);
        let deptMove: DeptMove | null = null;
        if (restore_inventory && item.material_id && returnedQty > 0 && departmentId) {
          deptMove = resolveDeptMove(db, {
            departmentId, materialId: item.material_id, lineUnit: item.unit, qty: returnedQty,
          });
          if (!deptMove.ok) {
            results.errors.push(`Row ${i + 1}: ${deptMove.error}`);
            continue;
          }
          // No availability guard on the way IN: a positive movement cannot
          // drive a balance negative, and the returned <= issued check above
          // already caps how much can come back.
        }

        db.prepare(`
          UPDATE staff_meal_items SET
            returned_quantity = ?, quantity = ?, total_cost = ?,
            status = 'closed', returned_at = datetime('now'),
            notes = COALESCE(?, notes)
          WHERE id = ?
        `).run(returnedQty, consumedQty, totalCost, ret.notes || null, ret.id);

        if (restore_inventory && item.material_id && returnedQty > 0) {
          if (deptMove && deptMove.ok) {
            // Back onto the department's own shelf. Typed 'adjustment' (the only
            // signed type in the vocabulary) because there is no
            // 'staff_meal_return' type yet — see handoff. The sign is what the
            // balance sums, so the arithmetic is right today; the type string is
            // what the audit reads, which is why the note spells out the reason
            // rather than leaving it to look like a stock correction.
            // Non-null by construction: deptMove is only set when departmentId is.
            postDeptLedger(db, {
              departmentId: departmentId!,
              materialId: item.material_id,
              type: 'adjustment',
              quantity: deptMove.recipeQty,
              referenceId: item.meal_id,
              source: 'staff-meals/items:PATCH',
              notes: `Staff meal ${item.meal_id} — ${item.item_name} returned unused (${fmt(returnedQty)} ${item.unit})`,
              // Required by postDeptLedger; see POST and deptActor().
              user: deptActor(itemActor),
            });
          } else {
            // CENTRAL branch — unchanged. Carries the same line-unit-vs-recipe-unit
            // bug as the issue above, and deliberately so: an asymmetric fix would
            // restore more than was taken. Both halves move together or neither.
            db.prepare(`
              UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now')
              WHERE id = ?
            `).run(returnedQty, item.material_id);

            db.prepare(`
              INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
              VALUES (?, ?, 'staff_meal_return', ?, ?, ?, datetime('now'))
            `).run(
              generateId(), item.material_id, returnedQty, ret.id,
              `Returned from staff meal ${item.meal_id} (unused)`
            );
          }
        }

        results.success++;
      }
    });

    processReturns();
    return Response.json(results);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: errorStatus(error) });
  }
}

export async function DELETE(request: Request) {
  try {
    // The responsible user, from the SESSION — see POST. Restoring a deleted
    // department line posts through postDeptLedger and failed the same way.
    // No session: '', and deptActor() refuses the restore inside the delete's
    // transaction, so the row stays (401, nothing written).
    const itemActor = String((await getCurrentUser())?.email || '').trim();
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    const item = db.prepare('SELECT * FROM staff_meal_items WHERE id = ?').get(id) as any;
    const departmentId = item ? normDept(item.department_id) : null;
    const netRemoved = item && item.material_id && item.status === 'issued'
      ? item.issued_quantity - item.returned_quantity
      : 0;

    // Resolved BEFORE anything is written so a refusal can answer 409 without a
    // half-applied delete behind it.
    let move: DeptMove | null = null;
    if (netRemoved > 0 && departmentId) {
      move = resolveDeptMove(db, {
        departmentId, materialId: item.material_id, lineUnit: item.unit, qty: netRemoved,
      });
      if (!move.ok) {
        // Refuse the DELETE rather than delete the row and strand the ledger
        // debit with nothing pointing at it. An orphaned department debit is
        // indistinguishable from theft on the variance report, and this row is
        // the only remaining evidence of why the stock moved.
        return Response.json(
          { error: `Cannot delete: the department restore could not be resolved — ${move.error}` },
          { status: 409 },
        );
      }
    }

    // The restore and the delete are ONE unit. Two statements that can half-apply
    // is how a department ends up credited for a meal whose row still exists (or
    // debited for one that no longer does).
    db.transaction(() => {
      if (netRemoved > 0) {
        if (move && move.ok) {
          // Mirror of the issue: the department gets its grams back, central is
          // untouched because central never lost them.
          postDeptLedger(db, {
            departmentId: departmentId!,
            materialId: item.material_id,
            type: 'adjustment',
            quantity: move.recipeQty,
            referenceId: item.meal_id,
            source: 'staff-meals/items:DELETE',
            notes: `Staff meal item deleted — restored to ${move.departmentName} (${fmt(netRemoved)} ${item.unit})`,
            // Required by postDeptLedger; see POST and deptActor().
            user: deptActor(itemActor),
          });
        } else {
          // CENTRAL branch — unchanged, including its line-unit bug (see POST).
          db.prepare('UPDATE raw_materials SET current_stock = current_stock + ? WHERE id = ?')
            .run(netRemoved, item.material_id);
          db.prepare(`
            INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
            VALUES (?, ?, 'adjustment', ?, ?, ?, datetime('now'))
          `).run(generateId(), item.material_id, netRemoved, id, `Staff meal item deleted — restored`);
        }
      }
      db.prepare('DELETE FROM staff_meal_items WHERE id = ?').run(id);
    })();

    return Response.json({ success: true });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: errorStatus(error) });
  }
}
