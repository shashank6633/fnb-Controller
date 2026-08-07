#!/usr/bin/env node
/**
 * RATE-BASIS LOCK — the sibling of the purchase-unit (quantity) lock.
 *
 *   node scripts/check-rate-basis.js            # exits 1 on any violation
 *   node scripts/check-rate-basis.js --root DIR # scan an alternate tree (proof runs)
 *   node scripts/check-rate-basis.js --json     # machine-readable findings
 *   npm run check:rates
 *
 * WHY THIS EXISTS — AND WHY IT IS A SEPARATE FILE
 * ────────────────────────────────────────────────
 * The owner asked, on 2026-08-06:
 *
 *   "wherever the raw material Qty is in Purchase Units then the Rate should
 *    also be in Purchase units right? Once check all the Prices or qty."
 *
 * He is right, and the failure is DIMENSIONAL. A quantity in kg multiplied by a
 * rate in rupees-per-GRAM is wrong by the pack size — 1,000x on a 1 kg pack. It
 * does not look wrong on screen. It looks like a plausible number.
 *
 * scripts/check-purchase-units.js already locks QUANTITY DISPLAY: every quantity
 * on a Purchase / Inventory surface must LEAD with the purchase unit. But that
 * script DELIBERATELY EXCLUDES money — it keeps a `moneyFmts` set (line 646) and
 * skips those formatters outright (line 968) precisely so that a Rs formatter is
 * never mistaken for a quantity render. That carve-out is CORRECT for its job,
 * which is FORMATTING. What it means is that no check has ever looked at PAIRING.
 *
 * The July 2026 rollout moved ~293 quantity sites into purchase units. Nothing
 * checked that the RATE beside each of them moved too. This script is that check.
 * It is a separate file rather than a fifth rule inside the quantity lock because
 * the two ask opposite questions of the same line — "which unit does this print?"
 * versus "do these two numbers share a basis?" — and folding a pairing rule into
 * a formatting scanner would mean relaxing the moneyFmts skip that makes the
 * formatting scanner honest.
 *
 * THE UNIT CANON (src/lib/pack-units.ts is the implementation)
 * ────────────────────────────────────────────────────────────
 *   raw_materials.unit               = RECIPE unit   (g, ml)
 *   raw_materials.purchase_unit      = PURCHASE unit (kg, L, BTL, CASE)
 *   raw_materials.pack_size          = RECIPE units per PURCHASE unit
 *   raw_materials.average_price      = Rs per RECIPE unit      <- recipe basis
 *   raw_materials.current_stock      = RECIPE units
 *   purchases.quantity               = PURCHASE units
 *   purchases.unit_price             = Rs per PURCHASE unit    <- purchase basis
 *   purchase_order_items.quantity / .unit_price = same purchase basis
 *
 * BOTH-HALVES GUARD: a pack conversion applies only when pack_size > 1 AND
 * lower(trim(unit)) !== lower(trim(purchase_unit)). Live counter-example that
 * must NOT convert: PICKLED GINGER 1.5KG (unit=kg, purchase_unit=kg, pack 1.5).
 *
 * THE INVARIANT THIS SCRIPT DEFENDS
 * ──────────────────────────────────
 * For any displayed or computed trio (quantity, rate, value):
 *
 *     purchase-unit qty  x  Rs/purchase-unit  = CORRECT
 *     recipe-unit   qty  x  Rs/recipe-unit    = CORRECT
 *     purchase-unit qty  x  Rs/recipe-unit    = WRONG by pack_size
 *     recipe-unit   qty  x  Rs/purchase-unit  = WRONG by 1/pack_size
 *
 * A recipe-unit rate beside a recipe-unit quantity is CORRECT and must not be
 * "fixed". So this script never asserts which basis a site should be in. It
 * asserts only that the site's two halves AGREE — resolved from the canon, from
 * a shared pack helper, or stated in writing. Silence on both halves is the
 * defect.
 *
 * HOW A BASIS IS ESTABLISHED (rule 2's model, in resolution order)
 * ─────────────────────────────────────────────────────────────────
 *  1. TABLE + COLUMN (TABLE_BASIS below). `p.unit_price` where `p` aliases
 *     `purchases` is Rs/purchase-unit BY CANON — not by guess. Aliases are read
 *     out of the file's own FROM / JOIN clauses.
 *  2. BARE COLUMN inside a SQL statement, resolved against the tables that
 *     statement actually reads — `SUM(quantity * unit_price) FROM purchases`
 *     resolves both halves to the purchase basis, which is why
 *     /api/inventory:79-83 and src/lib/purchase-log.ts are clean.
 *  3. COLUMN-NAME CANON (NAME_BASIS) for names whose basis is fixed wherever
 *     they appear: average_price is always Rs/recipe-unit; quantity_accepted is
 *     always purchase units; qty_per_unit is always RECIPE units per item sold.
 *  4. LOCAL DERIVATION. A local assigned from a basis-known expression inherits
 *     that basis (`const purchasePrice = matched.average_price` is recipe), and
 *     a local whose derivation went through the pack layer is RESOLVED.
 *  5. Otherwise UNKNOWN.
 *
 * A pairing passes when both halves agree, when either half is pack-resolved,
 * when the enclosing scope carries pack proof or the canon's both-halves SQL
 * guard, or when the line declares its basis in writing. It fails when the two
 * halves are opposite, when a known rate meets an unknown quantity, or when
 * either half is a MIXED-basis column (see rule 1).
 *
 * THE THREE RULES
 * ───────────────
 * RULE 1 — THE LPP BAN  (kind: rule-1-lpp)
 *   raw_materials.last_purchase_price is stored in MIXED bases on live data: of
 *   the 190 packed materials that hold both a stored LPP and a purchase history,
 *   115 are purchase-basis and 71 are ALREADY recipe-basis. COCO POWDER reads
 *   Rs 846,570/kg if you multiply it; MALA STRAWBERRY CRUSH 5 LTR reads Rs 0.13/BTL
 *   against a real Rs 674.10/BTL if you don't. There is no conversion that is right
 *   for both halves of that column, so the column may not be READ.
 *
 *   Flagged: any SQL that projects last_purchase_price without deriving it from
 *   the purchases table, and any JS that reads `.last_purchase_price` off a row.
 *   The three legitimate sites pass automatically because their value comes from
 *   purchases.unit_price, so the projecting line itself contains `FROM purchases`:
 *       src/app/api/inventory/route.ts:40
 *       src/app/api/requisitions/route.ts:92
 *       src/app/api/unit-audit/route.ts:118
 *   Not flagged: WRITES (`SET last_purchase_price = ?`) — the receive / GRN /
 *   inward-import path is what fills the column, and killing the writer would
 *   break cost-spike detection. Not flagged: WHERE-clause predicates, which
 *   filter rows rather than value them.
 *
 *   The dead-payload sites — approval-context:51, purchase-orders/route.ts:179,
 *   store-process:100 — SELECT the column and never use the value. They are
 *   silenced by DELETING the unused column from the SELECT, not by an allow-list
 *   entry: a column sitting in a payload is one `it.last_purchase_price` away
 *   from being multiplied by something.
 *
 * RULE 2 — THE PAIRING RULE  (kind: rule-2-pairing)
 *   Flags a multiplication of a QUANTITY by a RATE whose two bases do not
 *   provably agree. This is the shape of the largest live error in the
 *   2026-08-06 audit: /api/sales-import booked `mat.average_price *
 *   line.total_qty` — Rs per RECIPE unit times ITEMS SOLD — for Rs 13,96,808 of
 *   cost across 214 rows.
 *
 *   The spec for this rule was file-level ("...in a file that never calls
 *   packFactor / purchasePrice / lineFactor / toPurchaseQty / valueCount").
 *   DELIBERATE STRENGTHENING: it is resolved per SITE, in a window around the
 *   multiplication, not per file. A file-level gate would have cleared
 *   /api/staff-meals/items/route.ts:268 — that file DOES call lineFactor(), 161
 *   lines away, on the department branch, while the line that books the money
 *   multiplied a purchase-unit quantity by a recipe-unit rate. Fix-one-cell-
 *   leave-the-sibling is the likelier shape of this bug than a wholly innocent
 *   file, and a file-level gate cannot see it. The file-level reading survives as
 *   a special case of the site-level one: a file with no helpers anywhere has no
 *   window that can carry proof, so every undecided pairing in it is reported.
 *
 * RULE 3 — THE LABEL RULE  (kind: rule-3-label)
 *   The unit printed beside a rate must come from DATA, never from a literal, and
 *   the label above a money column must be the label OF that column. Three shapes:
 *     3a hardcoded-denominator — `Rs ${x.cost_per_unit}/kg`. The live example is
 *        src/app/api/butchering/route.ts:392 (and :404). A carcass bought by the
 *        piece still gets stamped "/kg".
 *     3b money-column-shift — a table whose <thead> cell count does not match the
 *        <td> count of a <tbody> row that renders Rs. Every money column then
 *        prints under its neighbour's header. src/app/purchases/page.tsx:3314
 *        rendered 7 <th> against 8 <td> on the Recaho inward-upload preview, so
 *        the Rs/purchase-unit RATE printed under the header "Subtotal" — whose own
 *        tooltip reads "Qty x Rate — THIS is what becomes the purchase amount".
 *        The stored numbers are each correct; only the labelling commits the
 *        error, on the screen that approves rows into `purchases`.
 *     3c literal-unit-vocabulary — a hand-rolled metric converter (`* 1000` keyed
 *        off 'ml'/'g' literals) plus a LITERAL unit-option list, in a file that
 *        prices those quantities with average_price and never reads pack_size.
 *        The unit vocabulary is then a literal, so a pack unit (BTL, CASE) can
 *        never be offered no matter what the material says.
 *        src/app/party-pnl/page.tsx:25 tells the bar manager to "Enter bottle /
 *        unit counts consumed" while unitOptions() could only ever return
 *        ['ml','L'] — a 750x understatement of the exact figure the page exists
 *        to produce.
 *
 *   3b and 3c are additions beyond the three literal rule statements, made
 *   because the audit's nine confirmed sites include two — purchases/page.tsx and
 *   party-pnl/page.tsx — that no basis-of-arithmetic rule can see: their numbers
 *   are individually right and it is the LABEL / the ENTRY VOCABULARY that is
 *   wrong. A gate that reported CLEAN over them would license exactly the drift
 *   it exists to stop.
 *
 * HOW TO CLEAR A HIT (in order of preference)
 * ────────────────────────────────────────────
 *  1. FIX IT with the existing helpers. Never re-derive the pack rule:
 *       packFactor / toPurchaseQty / purchasePrice / lineFactor  @/lib/pack-units
 *       materialRate / rateMap / valueCount                      @/lib/closing-valuation
 *     closing-valuation.ts is the SANCTIONED RATE LADDER: latest
 *     purchases.unit_price, then average_price x packFactor, then none.
 *  2. DECLARE THE BASIS in writing, on the same line (or up to 2 lines above it,
 *     for a JSX attribute or a wrapped expression):
 *         // rate-basis: recipe     Rs/g,  Rs/ml  — beside a recipe-unit qty
 *         // rate-basis: purchase   Rs/kg, Rs/BTL — beside a purchase-unit qty
 *     Inside a SQL template literal use the SQL comment form, never `//`:
 *         -- rate-basis: purchase
 *     Every declaration is ECHOED in this script's output. A basis stated in
 *     writing is reviewable; a silent exemption is not, which is the whole point
 *     of preferring a declaration to an allow-list.
 *  3. ALLOW-LIST — structural exceptions only, and each carries a written reason.
 *
 * WHAT THIS SCRIPT DOES NOT DO (stated honestly)
 * ───────────────────────────────────────────────
 * It is a BASIS check, not an arithmetic check. It cannot tell you that a pack
 * factor was applied in the wrong DIRECTION, only that one was applied (or that
 * the basis was resolved). Wrong-direction math is the review's job. It also does
 * not read the database: every claim it makes is about the source text.
 *
 * See also: scripts/check-purchase-units.js (the quantity half of the same rule),
 *           src/lib/pack-units.ts, src/lib/closing-valuation.ts.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const argRootIdx = process.argv.indexOf('--root');
const ROOT = argRootIdx > -1 && process.argv[argRootIdx + 1]
  ? path.resolve(process.argv[argRootIdx + 1])
  : path.join(__dirname, '..');
const AS_JSON = process.argv.includes('--json');

/* ──────────────────────────────────────────────────────────────────────────
 * SCOPE
 *
 * Wider than the quantity lock's, on purpose. The quantity lock scopes to the
 * Purchase + Inventory PAGES because that is where a quantity is displayed. A
 * rate basis, by contrast, is decided in the API/lib layer and then poisons
 * every consumer downstream — /api/sales-import is not an inventory page and it
 * booked the single largest rupee error in the audit. So: all of src/app,
 * src/lib and src/components.
 *
 * Rules 2 and 3 are then narrowed by MATERIAL RELEVANCE (see isMaterialFile):
 * a POS file multiplying covers by a menu price has no purchase unit and no pack
 * size, so there is no basis question to answer there. Rule 1 is not narrowed —
 * it is a ban on one column name and applies wherever that name is read.
 * ────────────────────────────────────────────────────────────────────────── */
const SCAN_DIRS = ['src/app', 'src/lib', 'src/components'];

/** Never scanned: generated, vendored, or not source. */
const SCAN_EXCLUDE = [
  'src/app/api/admin/reset',   // the factory-reset writer; zeroes the columns
  'src/lib/db-explorer.ts',    // column-name metadata for the admin DB browser
];

/* ──────────────────────────────────────────────────────────────────────────
 * ALLOW-LIST — declared structural exceptions. Every entry names the rule it
 * clears and says why. `contains` anchors it to the TEXT of the offending line;
 * line numbers rot, snippets survive refactors. Keep this list as short as the
 * truth allows: each entry is a place the lock cannot see.
 * ────────────────────────────────────────────────────────────────────────── */
const ALLOW = [
  {
    file: 'src/lib/db.ts',
    rule: 'rule-1-lpp',
    contains: ['last_purchase_price = COALESCE(', 'WHERE last_purchase_price IS NULL'],
    reason:
      'THE WRITER, not a reader. This is the one-shot boot backfill that FILLS ' +
      'last_purchase_price from the most recent purchases row — i.e. it is the ' +
      'code that puts the purchase basis INTO the column. Banning it would leave ' +
      'the column empty and break cost-spike detection.',
  },
];

/* ──────────────────────────────────────────────────────────────────────────
 * THE DECLARATION ESCAPE
 *
 * `// rate-basis: recipe` / `// rate-basis: purchase` / `-- rate-basis: purchase`.
 * Same line, or up to ESCAPE_ABOVE lines above it (a JSX attribute or a wrapped
 * ternary cannot always take a trailing comment). Every use is echoed in the
 * report — the point is that a single-basis site states its basis in WRITING,
 * not that it disappears.
 * ────────────────────────────────────────────────────────────────────────── */
const ESCAPE_RE = /rate-basis\s*:\s*(recipe|purchase|mixed)/i;
const ESCAPE_ABOVE = 2;

function escapeAt(lines, i) {
  for (let k = Math.max(0, i - ESCAPE_ABOVE); k <= i; k++) {
    const m = ESCAPE_RE.exec(lines[k]);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────────────────
 * SOURCE GEOMETRY — which lines are inside a SQL template literal, and where the
 * comments start. Rule 1 judges SQL and JS differently, so it needs to know what
 * SQL is; all rules need to know not to judge prose.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Line numbers (0-based) that sit inside a backtick template literal whose body
 * reads as SQL. A hand-rolled scanner rather than a parser: it tracks quotes,
 * line/block comments and `${}` nesting, which is all that is needed to tell a
 * SQL heredoc from a className string.
 */
function sqlLineSet(src) {
  const out = new Set();
  let line = 0;
  let i = 0;
  const n = src.length;
  // states: 0 code, 1 line-comment, 2 block-comment, 3 'str, 4 "str, 5 template
  let st = 0;
  let tplStartLine = 0;
  let tplStart = 0;
  let tplDepth = 0;      // ${ } nesting inside the template
  const tplStack = [];   // nested templates inside ${}
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '\n') { line++; if (st === 1) st = 0; i++; continue; }
    if (st === 1) { i++; continue; }
    if (st === 2) { if (c === '*' && d === '/') { st = 0; i += 2; continue; } i++; continue; }
    if (st === 3) { if (c === '\\') { i += 2; continue; } if (c === "'") st = 0; i++; continue; }
    if (st === 4) { if (c === '\\') { i += 2; continue; } if (c === '"') st = 0; i++; continue; }
    if (st === 5) {
      if (c === '\\') { i += 2; continue; }
      if (c === '$' && d === '{') { tplDepth++; i += 2; continue; }
      if (c === '}' && tplDepth > 0) { tplDepth--; i++; continue; }
      if (c === '`' && tplDepth === 0) {
        const body = src.slice(tplStart, i);
        if (/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|CREATE\s+TABLE|PRAGMA)\b/i.test(body)) {
          for (let l = tplStartLine; l <= line; l++) out.add(l);
        }
        const prev = tplStack.pop();
        if (prev) { tplStartLine = prev.l; tplStart = prev.s; tplDepth = prev.d; }
        else st = 0;
        i++;
        continue;
      }
      if (c === '`' && tplDepth > 0) {   // a template nested inside ${}
        tplStack.push({ l: tplStartLine, s: tplStart, d: tplDepth });
        tplStartLine = line; tplStart = i + 1; tplDepth = 0;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // st === 0 (code)
    if (c === '/' && d === '/') { st = 1; i += 2; continue; }
    if (c === '/' && d === '*') { st = 2; i += 2; continue; }
    if (c === "'") { st = 3; i++; continue; }
    if (c === '"') { st = 4; i++; continue; }
    if (c === '`') { st = 5; tplStartLine = line; tplStart = i + 1; tplDepth = 0; i++; continue; }
    i++;
  }
  return out;
}

/** Index at which a comment starts on this line, or Infinity. Cheap + sufficient. */
function commentStart(line) {
  const idx = [line.indexOf('//'), line.indexOf('--'), line.indexOf('/*')]
    .filter(x => x >= 0);
  return idx.length ? Math.min(...idx) : Infinity;
}

/** Is this line nothing but prose (a doc-comment body)? */
function isProseLine(line) {
  return /^\s*(\*|\/\/|--)/.test(line);
}

/** The code half of a line: comments carry prose, and prose must never be judged. */
function codeOf(line) {
  if (isProseLine(line)) return '';
  const cut = commentStart(line);
  return cut === Infinity ? line : line.slice(0, cut);
}

/* ──────────────────────────────────────────────────────────────────────────
 * RULE 1 — THE LPP BAN
 * ────────────────────────────────────────────────────────────────────────── */
const LPP_RE = /last_purchase_price/g;

/**
 * The sanctioned derivation. `(SELECT unit_price FROM purchases ... ) AS
 * last_purchase_price` is CORRECT — the value is purchases.unit_price, which is
 * Rs/purchase-unit by canon; only the alias reuses the poisoned name. Requiring
 * `FROM purchases` on the projecting line is what separates the three legitimate
 * sites from the raw reads, and it cannot be spoofed by a comment because
 * comment text is stripped before the test.
 */
const LPP_OK_SOURCE_RE = /FROM\s+purchases\b/i;

function rule1(lines, sqlLines) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const code = codeOf(lines[i]);
    if (!code.includes('last_purchase_price')) continue;
    if (LPP_OK_SOURCE_RE.test(code)) continue;      // derived from purchases.unit_price

    // ── JS side. `row.last_purchase_price`, `m?.last_purchase_price`,
    //    `{ last_purchase_price }` — a read of the mixed column off a row object.
    //    This is how src/lib/crm-analyst-data.ts built a lastPrice map and priced
    //    a draft PO line at 1/5000 of truth, and it is not SQL, so the SQL branch
    //    below can never see it.
    if (!sqlLines.has(i)) {
      if (/(?:\?\.|\.)\s*last_purchase_price/.test(code) ||
          /\blast_purchase_price\s*[,}\])]/.test(code)) {
        // A WRITE through an object literal (`{ last_purchase_price: rate }`) is
        // the filling path, same exemption as the SQL SET below.
        if (!/last_purchase_price\s*:/.test(code)) {
          hits.push({ rule: 'rule-1-lpp', detail: 'raw-lpp-read', line: i, text: lines[i].trim() });
        }
      }
      continue;
    }

    LPP_RE.lastIndex = 0;
    let m;
    while ((m = LPP_RE.exec(code))) {
      const before = code.slice(0, m.index);
      const after = code.slice(m.index + m[0].length);

      // A WRITE — `SET last_purchase_price = ?`. The receive / GRN / inward
      // path is what PUTS the purchase basis into this column; banning the
      // writer would empty it and break cost-spike detection.
      if (/^\s*=(?!=)/.test(after)) continue;

      // A PREDICATE — `WHERE last_purchase_price IS NULL`, `WHERE
      // COALESCE(last_purchase_price,0) > 0`. Filtering rows by the column
      // states nothing about a basis; only valuing something from it does.
      if (/\b(WHERE|AND|OR|HAVING|ON)\b[^)]*$/i.test(before) ||
          /\b(WHERE|AND|OR|HAVING)\b/i.test(before.split(/\bFROM\b/i).pop() || '')) continue;

      hits.push({ rule: 'rule-1-lpp', detail: 'raw-lpp-read', line: i, text: lines[i].trim() });
      break;                                        // one finding per line
    }
  }
  return hits;
}

/* ──────────────────────────────────────────────────────────────────────────
 * RULE 2 — THE PAIRING RULE
 *
 * Basis codes:  'P' purchase   'R' recipe   'M' mixed (must declare)
 *               'X' pack-resolved (the shared layer decided it)   null unknown
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * TABLE + COLUMN — the canon, written down. This is the difference between
 * "quantity times unit_price looks scary" and "these two columns are on the same
 * purchase-side row, so they share a basis by construction". Every entry here is
 * a statement about the SCHEMA, and the schema is what the canon fixes.
 *
 * staff_meal_items and party_event_items are DELIBERATELY ABSENT. Their
 * issued_quantity / purchase_price pair is exactly the pair the audit found
 * holding two different bases in one row, so the schema cannot vouch for them —
 * those sites must resolve their basis in code or declare it.
 */
const TABLE_BASIS = {
  // ── PURCHASE side: quantity in purchase units, rate in Rs/purchase-unit ──
  purchases:                { quantity: 'P', unit_price: 'P' },
  purchase_order_items:     { quantity: 'P', received_quantity: 'P', unit_price: 'P' },
  goods_receipt_note_items: {
    quantity_received: 'P', quantity_accepted: 'P', quantity_rejected: 'P',
    quantity_ordered: 'P', unit_price: 'P',
  },
  grn_items:                { quantity_received: 'P', quantity_accepted: 'P', quantity_rejected: 'P', unit_price: 'P' },
  store_stock_ledger:       { quantity: 'P', unit_cost: 'P' },
  store_closing_counts:     { counted_qty: 'P', unit_cost: 'P' },
  vendor_contracts:         { unit_price: 'P' },
  // ── RECIPE side: quantity in recipe units, rate in Rs/recipe-unit ──
  raw_materials:            { current_stock: 'R', average_price: 'R', reorder_level: 'R', last_purchase_price: 'M' },
  closing_stock:            { physical_stock: 'R', system_stock: 'R', opening_stock: 'R', variance: 'R' },
  wastage:                  { quantity: 'R' },
  inventory_transactions:   { quantity: 'R' },
  recipe_ingredients:       { quantity: 'R' },
  sub_recipe_ingredients:   { quantity: 'R' },
  recipes:                  { cost_per_unit: 'R', yield_quantity: 'R' },
  party_consumption:        { quantity: 'R' },
  direct_item_links:        { qty_per_unit: 'R' },
};

/**
 * COLUMN-NAME CANON — names whose basis is the same wherever they are read, so
 * they resolve even as a bare local or an un-aliased select. Narrow on purpose:
 * a bare `quantity`, `qty`, `price`, `rate` or `cost` is NOT here, because those
 * genuinely mean different things per table and guessing at them is how a lock
 * starts lying.
 */
const NAME_BASIS = new Map(Object.entries({
  // recipe-basis RATES — Rs per gram / per ml
  average_price: 'R', avg_price: 'R', avgprice: 'R', avg_cost: 'R', avgcost: 'R',
  cost_per_unit: 'R', costperunit: 'R', rateperrecipeunit: 'R', recipe_rate: 'R',
  // purchase-basis RATES — Rs per kg / per BTL
  unit_price: 'P', unitprice: 'P', unit_cost: 'P', unitcost: 'P',
  received_unit_price: 'P', eff_unit_price: 'P', effective_unit_price: 'P',
  rateperpurchaseunit: 'P', ratepu: 'P', rate_pu: 'P', purchase_rate: 'P', purchaserate: 'P',
  // recipe-basis QUANTITIES
  current_stock: 'R', physical_stock: 'R', system_stock: 'R',
  recipe_qty: 'R', qty_recipe: 'R', recipeqty: 'R', effectiveqty: 'R', effective_qty: 'R',
  // direct_item_links.qty_per_unit is RECIPE units per ITEM SOLD — this is the
  // very column /api/sales-import defaulted to 1 and then multiplied by items
  // sold. As a factor it is recipe-basis, which is what makes
  // `average_price * qty_per_unit` (api/menu-items:60) dimensionally right.
  qty_per_unit: 'R', qtyperunit: 'R', per_portion: 'R',
  // purchase-basis QUANTITIES
  quantity_received: 'P', quantity_accepted: 'P', quantity_rejected: 'P',
  quantity_ordered: 'P', packs: 'P', purchase_qty: 'P', purchaseqty: 'P',
  qty_purchase: 'P', inward_qty: 'P', inwardqty: 'P', ordered_qty: 'P',
  // MIXED — observed holding both bases on live rows. Must be resolved or declared.
  last_purchase_price: 'M', material_last_price: 'M',
  purchase_price: 'M', purchaseprice: 'M',
}));

/**
 * A quantity word and a rate word. No leading \b: the significant word is very
 * often NOT the first word of the identifier — `total_qty`, `issued_quantity`,
 * `gross_weight` — and a leading \b hides every one of them. (The quantity lock
 * learned this the hard way; see its QTY_FIELD_RE note.)
 */
const QTY_RE = /qty|quantity|weight|issued|packs|accepted|physical|stock/i;
const RATE_RE = /price|rate|cost_per|unit_cost|avg/i;

/**
 * `cost` alone is NOT a rate — `lineCost`, `totalCost`, `est_cost` are VALUES
 * (Rs, already multiplied out), and treating a value as a rate would make
 * `qty * lineCost` look like a basis question when it is just wrong arithmetic.
 */
const NOT_RATE_RE = /^(line_?cost|total_?cost|net_?cost|est_?cost|sub_?total|amount|stock_value)$/i;

/** Numeric-literal-ish operand — `* 100`, `* 1000`. Nothing to pair. */
function isLiteral(tok) { return !tok || /^[\d_.]+$/.test(tok); }

/** Last segment of an identifier chain: `line.total_qty` -> `total_qty`. */
function leaf(tok) { return tok.split(/[?.]+/).filter(Boolean).pop() || tok; }

/** Second-to-last segment — the alias: `p.unit_price` -> `p`. '' when bare. */
function qualifierOf(tok) {
  const parts = tok.split(/\??\./).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

const IDENT_CHAIN = '[A-Za-z_$][\\w$]*(?:\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*)*';

/**
 * Operand immediately LEFT of a `*`. Handles three shapes:
 *   `baseQty *`                      -> baseQty
 *   `(m?.average_price || 0) *`      -> average_price   (last ident in the group)
 *   `toBaseQty(a, b, c) *`           -> toBaseQty       (the CALLEE, because the
 *                                       call's own name carries the basis:
 *                                       `toBaseQty(...) * average_price` is
 *                                       exactly the shape that must not slip
 *                                       through as "m?.unit")
 */
function leftOperand(s) {
  let j = s.length - 1;
  while (j >= 0 && /\s/.test(s[j])) j--;
  if (j < 0) return null;
  if (s[j] === ')') {
    let depth = 0;
    let k = j;
    for (; k >= 0; k--) {
      if (s[k] === ')') depth++;
      else if (s[k] === '(') { depth--; if (depth === 0) break; }
    }
    if (k < 0) return null;
    const callee = new RegExp(`(${IDENT_CHAIN})\\s*$`).exec(s.slice(0, k));
    if (callee) return callee[1].replace(/\s+/g, '');           // a call: use its name
    const inner = s.slice(k + 1, j);                            // a group: last ident
    const idents = inner.match(new RegExp(IDENT_CHAIN, 'g')) || [];
    return idents.length ? idents[idents.length - 1].replace(/\s+/g, '') : null;
  }
  const m = new RegExp(`(${IDENT_CHAIN})\\s*$`).exec(s.slice(0, j + 1));
  return m ? m[1].replace(/\s+/g, '') : null;
}

/** Operand immediately RIGHT of a `*`, skipping `(`, `Number(`, `+`/`-` signs. */
function rightOperand(s) {
  const m = new RegExp(
    `^[\\s(+-]*(?:Number|Math\\.abs|r2|r4)?[\\s(]*(${IDENT_CHAIN})`,
  ).exec(s);
  return m ? m[1].replace(/\s+/g, '') : null;
}

/** Which side of the trio is this — a quantity, a rate, or neither? */
function kindOf(tok) {
  if (isLiteral(tok)) return null;
  const lf = leaf(tok);
  if (RATE_RE.test(lf) && !NOT_RATE_RE.test(lf)) return 'rate';
  if (QTY_RE.test(lf)) return 'qty';
  return null;
}

/**
 * PROOF that the shared pack layer resolved the basis here. Every entry is a
 * call into the sanctioned helpers — never a re-derivation of the pack rule.
 * `pack_size` on its own is NOT here, for the same reason the quantity lock
 * removed it: a line that re-derives the pack rule badly would otherwise count
 * as its own proof.
 */
const PACK_PROOF_RE = new RegExp([
  'pack_?factor',            // packFactor(), PACK_FACTOR sql const, packF
  '\\bpackF\\b',
  'toPurchaseQty',
  'purchasePrice\\s*\\(',
  'lineFactor',
  'valueCount',
  'valueSemiCount',
  'materialRate',
  'rateMap',
  'closing-valuation',
  'ratePerPurchaseUnit',
  'ratePerRecipeUnit',
].join('|'), 'i');

/**
 * A local whose DERIVATION went through the pack layer (`const issued = issuedReq
 * * reqPackFactor`) is basis-resolved even though its own name says nothing. This
 * is deliberately wider than PACK_PROOF_RE — it includes a bare `pack_size`,
 * because a derivation that reads pack_size at least CONSIDERED the pack rule,
 * and the direction of that arithmetic is a review question, not a lock question
 * (see "WHAT THIS SCRIPT DOES NOT DO").
 */
const PACK_TOUCH_RE = /pack_?size|pack_?factor|\bpackF\b|toPurchaseQty|lineFactor|toBaseQty|convertTo/i;

/**
 * THE BOTH-HALVES GUARD, written out inline. The certified-correct exemplar is
 * /api/party-events/pnl/route.ts:132-136, where the pack rule is a SQL CASE:
 *     CASE WHEN ri.unit = rm.purchase_unit AND ri.unit <> rm.unit
 *               AND COALESCE(rm.pack_size,1) > 1 THEN rm.pack_size ELSE 1 END
 * That is not a hand-rolled shortcut — it is the canon's own guard, both halves
 * present, expressed in SQL because the multiplication happens in SQL. It proves
 * the basis as well as a helper call does, so it must clear the pairing rule.
 */
function hasBothHalvesGuard(win) {
  return /pack_size/i.test(win)
      && /purchase_unit/i.test(win)
      && /(<>|!==|!=|=|===)\s*(rm\.)?unit\b|\bunit\s*(<>|!==|!=|===|=)/i.test(win);
}

/** alias -> table, read out of this file's own FROM / JOIN clauses. */
function tableAliases(src) {
  const out = new Map();
  const re = /\b(?:FROM|JOIN)\s+([a-z_][\w]*)\s*(?:\bAS\s+)?([a-z_][\w]*)?/gi;
  let m;
  while ((m = re.exec(src))) {
    const table = m[1].toLowerCase();
    if (!TABLE_BASIS[table]) continue;
    out.set(table, table);                                    // `raw_materials.average_price`
    const alias = (m[2] || '').toLowerCase();
    if (alias && !/^(on|where|group|order|left|inner|outer|join|as|using|limit|set|values|select)$/.test(alias)) {
      out.set(alias, table);
    }
  }
  return out;
}

/**
 * Which canon tables does the SQL statement around line `i` read? Used to give a
 * BARE column an owner: `SUM(quantity * unit_price) ... FROM purchases` resolves
 * to the purchase basis, which is what makes /api/inventory:79-83, the
 * /api/reports/purchases roll-up and src/lib/purchase-log.ts clean rather than
 * "two scary column names".
 *
 * Only accepted when the candidate tables agree on the column — an ambiguous
 * join stays unknown rather than being guessed at.
 */
const STMT_ABOVE = 6;
const STMT_BELOW = 8;
function stmtTables(lines, i) {
  const win = lines.slice(Math.max(0, i - STMT_ABOVE), Math.min(lines.length, i + STMT_BELOW + 1)).join('\n');
  const out = [];
  const re = /\b(?:FROM|JOIN)\s+([a-z_][\w]*)/gi;
  let m;
  while ((m = re.exec(win))) {
    const t = m[1].toLowerCase();
    if (TABLE_BASIS[t]) out.push(t);
  }
  return out;
}

/**
 * Locals whose basis is known — either inherited from a basis-known RHS
 * (`const purchasePrice = matched.average_price` is RECIPE, which is what made
 * staff-meals bookable at 1/1000 of truth) or marked 'X' because the derivation
 * went through the pack layer. Two passes so a chain resolves:
 * `const packF = packFactor(m)` then `const issued = qty * packF`.
 */
function localBasis(src, aliases) {
  const map = new Map();
  const decls = [];
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*([^\n;]*)/g;
  let m;
  while ((m = re.exec(src))) decls.push([m[1], m[2]]);

  for (let pass = 0; pass < 2; pass++) {
    for (const [name, rhs] of decls) {
      if (!rhs || rhs.length > 300) continue;
      if (PACK_TOUCH_RE.test(rhs) || PACK_PROOF_RE.test(rhs)) { map.set(name, 'X'); continue; }
      if (map.get(name) === 'X') continue;
      // Inherit from whichever canon names appear on the right-hand side, but
      // only when they AGREE — `a.average_price || b.unit_price` is a ladder
      // across bases and must stay unknown.
      const seen = new Set();
      for (const tok of rhs.match(new RegExp(IDENT_CHAIN, 'g')) || []) {
        const b = tokenBasis(tok.replace(/\s+/g, ''), aliases, map);
        if (b === 'X') { seen.add('X'); continue; }
        if (b) seen.add(b);
      }
      seen.delete('X');
      if (seen.size === 1) map.set(name, [...seen][0]);
    }
  }
  return map;
}

/** Resolve ONE token to a basis code, steps 1, 3 and 4 of the model. */
function tokenBasis(tok, aliases, locals) {
  if (!tok) return null;
  const lf = leaf(tok).toLowerCase();
  const q = qualifierOf(tok).toLowerCase();

  // 1. alias.column against the schema canon
  if (q && aliases.has(q)) {
    const cols = TABLE_BASIS[aliases.get(q)] || {};
    if (cols[lf]) return cols[lf];
  }
  // 3. column-name canon
  if (NAME_BASIS.has(lf)) return NAME_BASIS.get(lf);
  // 4. local derivation (only for bare locals — `x.foo` is a field, not a local)
  if (!q && locals && locals.has(tok)) return locals.get(tok);
  if (!q && locals && locals.has(lf)) return locals.get(lf);
  return null;
}

/** Step 2 — a bare column resolved against the tables this statement reads. */
function bareColumnBasis(tok, lines, i) {
  if (qualifierOf(tok)) return null;
  const lf = leaf(tok).toLowerCase();
  const tables = stmtTables(lines, i);
  if (!tables.length) return null;
  const found = new Set();
  for (const t of tables) {
    const b = (TABLE_BASIS[t] || {})[lf];
    if (b) found.add(b);
  }
  return found.size === 1 ? [...found][0] : null;   // ambiguous join -> unknown
}

const PAIR_ABOVE = 12;
const PAIR_BELOW = 4;

function rule2(lines, src, aliases, locals) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const code = codeOf(lines[i]);
    if (!code.includes('*')) continue;

    for (let c = 0; c < code.length; c++) {
      if (code[c] !== '*') continue;
      if (code[c + 1] === '*' || code[c - 1] === '*') continue;   // exponent
      if (code[c - 1] === '/' || code[c + 1] === '/') continue;   // comment fence

      const L = leftOperand(code.slice(0, c));
      const R = rightOperand(code.slice(c + 1));
      const lk = kindOf(L);
      const rk = kindOf(R);
      if (!lk || !rk) continue;
      if (lk === rk) continue;                       // qty*qty or rate*rate

      const qtyTok = lk === 'qty' ? L : R;
      const rateTok = lk === 'rate' ? L : R;

      const qb = tokenBasis(qtyTok, aliases, locals) || bareColumnBasis(qtyTok, lines, i);
      const rb = tokenBasis(rateTok, aliases, locals) || bareColumnBasis(rateTok, lines, i);

      // Either half resolved through the shared pack layer -> the basis was
      // decided by the code that owns the pack rule. Nothing left to assert.
      if (qb === 'X' || rb === 'X') continue;

      let why = null;
      if (qb === 'M' || rb === 'M') {
        why = `${qb === 'M' ? qtyTok : rateTok} is a MIXED-basis column`;
      } else if (qb && rb && qb !== rb) {
        why = `${qtyTok} is ${qb === 'P' ? 'PURCHASE' : 'RECIPE'}-basis but ` +
              `${rateTok} is Rs per ${rb === 'P' ? 'PURCHASE' : 'RECIPE'} unit`;
      } else if (rb && !qb) {
        why = `${rateTok} is Rs per ${rb === 'P' ? 'PURCHASE' : 'RECIPE'} unit; ` +
              `the basis of ${qtyTok} is never established`;
      } else {
        continue;                                    // both agree, or nothing is known
      }

      // Escapes, cheapest last: a pack helper anywhere in the neighbourhood, or
      // the canon's own both-halves guard expressed in SQL.
      const win = lines
        .slice(Math.max(0, i - PAIR_ABOVE), Math.min(lines.length, i + PAIR_BELOW + 1))
        .join('\n');
      if (PACK_PROOF_RE.test(win)) continue;
      if (hasBothHalvesGuard(win)) continue;

      hits.push({
        rule: 'rule-2-pairing',
        detail: 'basis-mismatch',
        line: i,
        text: lines[i].trim(),
        note: `${qtyTok} x ${rateTok} — ${why}`,
      });
      break;                                          // one finding per line
    }
  }
  return hits;
}

/* ──────────────────────────────────────────────────────────────────────────
 * RULE 3 — THE LABEL RULE
 * ────────────────────────────────────────────────────────────────────────── */

/* 3a — a rate interpolated with a HARDCODED denominator: `Rs ${x.cost_per_unit}/kg`.
 *      The unit must come from the material row, because the material decides it.
 *      Live example: src/app/api/butchering/route.ts:392 and :404. */
const HARD_DENOM_RE = new RegExp(
  '\\$?\\{[^}]*(?:price|rate|cost|avg)[^}]*\\}\\s*\\/\\s*(kg|kgs|g|gm|gms|ml|l|ltr|litre|btl|bottle|case|pcs|nos|piece)\\b',
  'i',
);

function rule3a(lines) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (isProseLine(lines[i])) continue;
    const m = HARD_DENOM_RE.exec(lines[i]);
    if (!m) continue;
    hits.push({
      rule: 'rule-3-label', detail: 'hardcoded-denominator',
      line: i, text: lines[i].trim(), note: `literal "/${m[1]}" beside a rate`,
    });
  }
  return hits;
}

/* 3b — MONEY-COLUMN SHIFT. A <thead> whose cell count does not match the <td>
 *      count of a Rs-rendering <tbody> row: every money column then prints under
 *      its neighbour's header. Only Rs rows are judged, and only when both counts
 *      are unambiguous — a row carrying a spread or a conditional cell cannot be
 *      counted statically and is skipped rather than guessed at. */
function countCells(block, tag) {
  const re = new RegExp(`<${tag}\\b([^>]*)>`, 'g');
  let n = 0;
  let m;
  while ((m = re.exec(block))) {
    const cs = /colSpan\s*=\s*\{?\s*(\d+)/.exec(m[1]);
    n += cs ? Number(cs[1]) : 1;
  }
  return n;
}

function rule3b(lines, src) {
  const hits = [];
  const theadRe = /<thead\b[\s\S]*?<\/thead>/g;
  let m;
  while ((m = theadRe.exec(src))) {
    const thead = m[0];
    const rows = thead.match(/<tr\b[\s\S]*?<\/tr>/g) || [];
    if (rows.length !== 1) continue;                      // stacked header rows: skip
    const thCount = countCells(rows[0], 'th');
    if (!thCount) continue;

    // The <tbody> that follows this <thead>.
    const rest = src.slice(m.index + thead.length);
    const bodyM = /<tbody\b[\s\S]*?<\/tbody>/.exec(rest);
    if (!bodyM || bodyM.index > 400) continue;            // not this table's body
    const bodyRows = bodyM[0].match(/<tr\b[\s\S]*?<\/tr>/g) || [];
    if (bodyRows.length !== 1) continue;                  // multiple shapes: skip
    const row = bodyRows[0];
    if (!/₹/.test(row)) continue;                         // only money rows
    if (/\{\.\.\.|&&\s*<td|\?\s*<td/.test(row)) continue; // not statically countable
    const tdCount = countCells(row, 'td');
    if (!tdCount || tdCount === thCount) continue;

    const line = src.slice(0, m.index).split('\n').length - 1;
    hits.push({
      rule: 'rule-3-label', detail: 'money-column-shift',
      line, text: lines[line].trim(),
      note: `${thCount} <th> vs ${tdCount} <td> — every money column prints under its neighbour's header`,
    });
  }
  return hits;
}

/* 3c — LITERAL UNIT VOCABULARY. A hand-rolled metric converter (two or more
 *      hardcoded x1000 steps keyed off 'ml' / 'g' / 'kg' / 'l' literals) AND a
 *      literal list of unit options, inside a file that PRICES those quantities
 *      with average_price and never reads pack_size. The unit vocabulary is then
 *      a literal, so BTL / CASE can never be offered no matter what the material
 *      row says — which is party-pnl's defect: the page asks for bottle counts it
 *      has no way to accept.
 *
 *      All four conditions are required. A recipe importer that converts L to ml
 *      (api/recipes/bar-import) is not this shape: it offers no unit picker and
 *      prices nothing per unit, so there is no rate to get wrong. */
const METRIC_STEP_RE = /(['"](?:ml|l|g|kg)['"][\s\S]{0,60}?[*/]\s*1000)|([*/]\s*1000[\s\S]{0,60}?['"](?:ml|l|g|kg)['"])/gi;
const UNIT_OPTION_LIST_RE = /\[\s*'(?:ml|l|g|kg)'\s*,\s*'(?:ml|l|g|kg|L|KG)'/i;
const PRICES_PER_UNIT_RE = /average_price|cost_at_time/i;

function rule3c(lines, src) {
  if (/pack_size|packFactor|pack_factor/i.test(src)) return [];   // pack-aware: not this shape
  if (!PRICES_PER_UNIT_RE.test(src)) return [];                   // nothing priced per unit
  if (!UNIT_OPTION_LIST_RE.test(src)) return [];                  // no literal unit picker
  const steps = [...src.matchAll(METRIC_STEP_RE)];
  if (steps.length < 2) return [];
  const line = src.slice(0, steps[0].index).split('\n').length - 1;
  return [{
    rule: 'rule-3-label', detail: 'literal-unit-vocabulary',
    line, text: lines[line].trim(),
    note: `${steps.length} hardcoded metric conversions + a literal unit list, no pack_size ` +
          'anywhere — a pack unit (BTL / CASE) can never be entered or offered',
  }];
}

/* ──────────────────────────────────────────────────────────────────────────
 * DRIVER
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Does this file deal in RAW MATERIALS at all? Rules 2 and 3 only make sense
 * where a pack size can exist. A POS route multiplying covers by a menu price is
 * dimensionally fine and has no purchase unit to get wrong.
 */
function isMaterialFile(src) {
  return /raw_materials|average_price|purchase_unit|pack_size|material_id|last_purchase_price/.test(src);
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    if (SCAN_EXCLUDE.some(x => rel === x || rel.startsWith(x + '/'))) continue;
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

function collectFiles() {
  const out = [];
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), out);
  return [...new Set(out)].sort();
}

function isAllowed(rel, rule, text) {
  return ALLOW.find(a =>
    a.file === rel && a.rule === rule &&
    (!a.contains || a.contains.some(s => text.includes(s))),
  ) || null;
}

function scanFile(abs) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const src = fs.readFileSync(abs, 'utf8');
  const lines = src.split('\n');
  const sqlLines = sqlLineSet(src);

  let hits = rule1(lines, sqlLines);
  if (isMaterialFile(src)) {
    const aliases = tableAliases(src);
    hits = hits
      .concat(rule2(lines, src, aliases, localBasis(src, aliases)))
      .concat(rule3a(lines))
      .concat(rule3b(lines, src))
      .concat(rule3c(lines, src));
  }

  const out = [];
  for (const h of hits) {
    const declared = escapeAt(lines, h.line);
    out.push({
      ...h,
      file: rel,
      line: h.line + 1,
      declared,
      allowed: declared ? null : isAllowed(rel, h.rule, lines[h.line]),
    });
  }
  return out;
}

const files = collectFiles();
const all = files.flatMap(scanFile);
const declared = all.filter(v => v.declared);
const exempted = all.filter(v => !v.declared && v.allowed);
const violations = all.filter(v => !v.declared && !v.allowed);

if (AS_JSON) {
  console.log(JSON.stringify({ scanned: files.length, violations, declared: declared.length }, null, 2));
  process.exit(violations.length ? 1 : 0);
}

const B = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const R = (s) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const G = (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const D = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

const RULES = {
  'rule-1-lpp':
    'LPP BAN — raw_materials.last_purchase_price is stored in MIXED bases ' +
    '(115 purchase-basis rows, 71 recipe-basis). Value from purchases.unit_price ' +
    'or from src/lib/closing-valuation.ts, never from this column.',
  'rule-2-pairing':
    'PAIRING — a quantity times a rate whose bases do not provably agree. ' +
    'purchase-unit qty x Rs/recipe-unit is wrong by pack_size.',
  'rule-3-label':
    'LABEL — the unit beside a rate, and the header above a money column, must ' +
    'come from the data, never from a literal or a neighbouring cell.',
};

console.log(B('\nRate-basis lock — is the RATE in the same unit as the QTY beside it?'));
console.log(D(`scanned ${files.length} files across ${SCAN_DIRS.join(', ')}\n`));

if (declared.length) {
  console.log(B(`Declared bases (${declared.length}) — stated in writing, review these:`));
  for (const v of declared) {
    console.log(`  ${D('·')} ${v.file}:${v.line}  [${v.rule}] rate-basis: ${v.declared}`);
  }
  console.log('');
}

if (exempted.length) {
  console.log(B(`Allow-listed (${exempted.length}):`));
  for (const v of exempted) {
    console.log(`  ${D('·')} ${v.file}:${v.line}  [${v.rule}]`);
    console.log(D(`      ${v.allowed.reason.slice(0, 160)}`));
  }
  console.log('');
}

if (violations.length === 0) {
  console.log(G('✓ CLEAN — every rate in scope agrees with the quantity beside it.\n'));
  process.exit(0);
}

console.log(R(B(`✗ ${violations.length} violation(s) — a rate whose basis is not established:\n`)));
for (const rule of Object.keys(RULES)) {
  const group = violations.filter(v => v.rule === rule);
  if (!group.length) continue;
  console.log(B(`  ${rule} (${group.length})`));
  console.log(D(`  ${RULES[rule]}`));
  let last = '';
  for (const v of group) {
    if (v.file !== last) { console.log(`    ${B(v.file)}`); last = v.file; }
    console.log(`      ${R(`line ${v.line}`)}  ${D(`[${v.detail}]`)} ${v.text.slice(0, 130)}`);
    if (v.note) console.log(D(`                  ↳ ${v.note}`));
  }
  console.log('');
}
console.log(D(`
Fix with the EXISTING helpers — never re-derive the pack rule:
  packFactor / toPurchaseQty / purchasePrice / lineFactor   @/lib/pack-units
  materialRate / rateMap / valueCount                       @/lib/closing-valuation
Or, if the site is genuinely single-basis by design, SAY SO on the line:
  // rate-basis: recipe      (Rs/g, Rs/ml — beside a recipe-unit quantity)
  // rate-basis: purchase    (Rs/kg, Rs/BTL — beside a purchase-unit quantity)
  -- rate-basis: purchase    (inside a SQL template literal)
Every declaration is echoed above, so a stated basis stays reviewable.
Structural exceptions go in the ALLOW list in ${path.relative(process.cwd(), __filename)}.
`));

// ── BLOCKING, AS OF 2026-08-07 ───────────────────────────────────────────────
// It shipped report-only. On the day it was written it found 57 sites: 14 direct
// reads of the mixed-basis last_purchase_price column, 41 rate x quantity pairs
// with no stated basis, 2 wrong labels. Most were arithmetically correct and
// needed a one-line `rate-basis:` declaration rather than a code change, so
// failing the build on them would have blocked every commit over a documentation
// backlog — and the usual result of that is the check gets deleted rather than
// the backlog cleared.
//
// THE BACKLOG IS NOW ZERO. The 14 LPP reads are gone or routed through
// src/lib/closing-valuation.ts, and the remaining 47 pairings each state their
// basis in writing (they are echoed above on every run, so a stated basis stays
// reviewable). With nothing left to hide among, a NEW violation is unambiguous —
// which is exactly the condition under which this must fail rather than print.
//
// So it is blocking, and it is in the `test` script in package.json alongside
// the boot-migrations and purchase-units locks. Reaching this line means
// violations.length > 0 — the clean path already exited 0 further up.
// `--strict` is retained as a no-op so existing CI / pre-commit invocations
// that pass it keep working.
process.exit(1);
