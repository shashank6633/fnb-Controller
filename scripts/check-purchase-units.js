#!/usr/bin/env node
/**
 * PURCHASE-UNIT LOCK — static guard for the Purchase + Inventory modules.
 *
 *   node scripts/check-purchase-units.js          # exits 1 on any violation
 *   npm run check:units
 *
 * WHY THIS EXISTS
 * ───────────────
 * Owner rule (2026-07-29): every quantity on a Purchase / Inventory page, sub-page
 * or tab LEADS with the PURCHASE unit (kg / L / BTL / CASE). The recipe figure
 * (g / ml) may only appear as a small declared hint — "= 3,000 g".
 *
 * The bug this catches is NOT a style nit. It is the fix-one-cell-leave-the-sibling
 * failure: on /requisitions one cell read "Requested 3,000 g" while the SAME row's
 * On Hand read "-16 kg". Quantities are stored in RECIPE units (or, for requisition
 * lines, in the line's own `unit` column — BLANK meaning recipe), so any cell that
 * prints the stored number next to `material_unit` / `.unit` without going through
 * the shared pack helpers silently renders grams. Seven converters swept the module
 * once; this script is what stops it drifting back one cell at a time.
 *
 * WHAT IT FLAGS
 * ─────────────
 * A line inside a scoped file that renders a NUMBER immediately followed by a
 * RECIPE-unit expression — `{qty} {m.unit}`, `${qty} ${it.material_unit}`, or the
 * same thing split by markup, `{qty} <span>{m.unit}</span>` — without proof that
 * it went through the shared pack layer (toPurchaseQty / dualQty / displayQty /
 * lineUnits / fmtBreakdown / packFactor / purchase_unit / qty_purchase / …).
 *
 * Where that proof must live depends on the shape, and this distinction is the
 * whole point of the check:
 *
 *   • LEAD  (no "=" prefix) → proof must be on the SAME LINE. A cell that truly
 *     leads in the purchase basis prints `pu` / `purchase_unit`, never `.unit`,
 *     so a lead printing a recipe unit is wrong by construction. Requiring
 *     same-line proof is what catches the owner's ACTUAL bug: one cell inside an
 *     already-converted table reverting to grams, where the converted siblings
 *     all around it would otherwise vouch for it.
 *
 *   • HINT  ("= {qty} {m.unit}") → may prove itself from the surrounding window,
 *     because the purchase lead is normally resolved once at the top of the row.
 *     The leading "=" is reserved for hints, so a hint can never be the lead.
 *
 * ── 2026-07-30 HARDENING: four blind spots that let live defects report CLEAN ──
 *
 * A guard that reports CLEAN over real drift is worse than no guard: it licenses
 * the drift it was built to stop. An adversarial pass found four renders in the
 * PURCHASE basis' own module that this script could not see. All four are now
 * covered. Nothing was relaxed to pay for them.
 *
 *   (a) BARE QUANTITY — a number printed with NO unit token beside it was never
 *       scanned at all, because the whole detector keys off a number→unit
 *       adjacency. Seven `fmt2(...)` columns on /daily-rollup and the Daily-rate
 *       cell on the home dashboard printed raw grams this way and passed.
 *       → `bareQty()`: a quantity-named field pushed through a number formatter
 *         inside an interpolation, with no unit token on the line and no proof of
 *         the shared pack layer within ±2 lines.
 *
 *   (b) LOCAL UNIT ALIAS — `const ru = m.recipe_unit || m.unit` then `<span>{ru}</span>`
 *       is a recipe unit that RECIPE_UNIT_RE cannot match, because by the time it
 *       reaches the JSX it is spelled `ru`. /unit-audit rendered its stock column
 *       that way. Same hole for `pu`, `unitOf(m)`, `req_unit`, `{ unit: u } = row`.
 *       → `analyzeFile()`: a per-file, two-pass alias resolver. A name bound to a
 *         recipe-unit expression becomes a recipe-unit token; a name bound to an
 *         expression containing a shared-helper marker becomes a local marker
 *         (so `const d = displayStock(m)` really does vouch for `{d.unit}`).
 *         Purchase beats recipe: an RHS mentioning purchase_unit is never an alias
 *         for the recipe unit.
 *
 *   (c) SELF-CERTIFYING PACK RULE — `pack_size` was itself a PURCHASE_MARKER, so a
 *       line that re-derived the pack rule BADLY counted as its own proof. That is
 *       precisely how /unit-audit's short-guard divide (PICKLED GINGER 1.5KG, kg/kg,
 *       pack 1.5, rendering a 6 kg stock as "4 kg") passed a clean run.
 *       → `pack_size` / `material_pack_size` are no longer markers. A marker now
 *         only ever vouches for a line when it is evidence the SHARED helper was
 *         used. Re-deriving the rule is not evidence of anything — so it is now a
 *         violation in its own right (`handrolledPackRule()`), which is the only
 *         honest reading of "must not be self-certifying".
 *
 *   (d) SHARED COMPONENTS UNSCANNED — src/components/ was entirely outside
 *       SCOPE_DIRS, yet MaterialTypeahead is mounted by six Purchase/Inventory
 *       pages and leaked grams into the /requisitions composer. A shared renderer
 *       is MORE dangerous than a page, not less: one leak reaches every mount.
 *       → src/components is in scope (minus the POS/CRM subtree, which deals in
 *         plates and covers and has no purchase unit).
 *
 * ── 2026-07-30 (later) — THREE PROVEN BYPASSES OF THE CHECKS THEMSELVES ──────
 *
 * The pass above widened WHAT is scanned. An adversarial review then showed the
 * scanner could be talked out of three findings it had already made. Each was
 * demonstrated by injection, not argued: the old script reported CLEAN over the
 * shape, the new one reports it. Nothing was relaxed to pay for them.
 *
 *   1. LEAD PROOF WAS HEARSAY (see the BYPASS 1 block above `resultExprs`).
 *      `hasSharedMarker(line, ctx.localMarkerRes)` accepted ANY local name the
 *      alias resolver had blessed, and a name is blessed for merely being bound
 *      to an expression that MENTIONS a marker. `const label = m.purchase_unit
 *      ? 'packed' : 'loose'` is a CSS class; riding the render line as
 *      `className={label}` it cleared a raw `{fmtQtyNum(m.current_stock)}
 *      {m.unit}`. A local now vouches for a lead only as the unit token's own
 *      root, or as a purchase-basis UNIT VALUE in the same interpolation.
 *
 *   2. THE PACK GUARD WAS FILE-WIDE (see the BYPASS 2 block by analyzeFile).
 *      One `pack_size: packConv` at src/app/requisitions/page.tsx:1818 switched
 *      handrolledPackRule() off for all 4,000 lines of that page. It is now
 *      resolved per RECEIVER — the construct that owns the guarded field and the
 *      iteration aliases it flows into — so the five genuine `ln.pack_size`
 *      sites stay silent while any other object's raw pack_size is judged.
 *
 *   3. QTY_FIELD_RE COULDN'T SEE SNAKE_CASE (see its own comment below). The
 *      leading `\b` re-made the exact mistake QTY_RE documents thirty lines
 *      earlier, hiding `inward_qty`, `chef_approved_qty`, `variance_qty` and
 *      every other field whose quantity word is not the first one.
 *
 * KNOWN LIMIT (stated honestly): this is a basis check, not an arithmetic check.
 * A hint whose number re-derives the pack rule WRONGLY still passes, so long as a
 * shared helper is used somewhere nearby. Wrong-math defects are the review's job.
 * The one arithmetic shape it now does judge is the hand-rolled pack rule (c) —
 * because that specific mistake has shipped to production twice.
 *
 * HOW TO CLEAR A HIT (in order of preference)
 * ───────────────────────────────────────────
 *  1. FIX IT — import from '@/lib/pack-units' (never re-derive the pack rule) and
 *     lead with the purchase unit. This is the right answer ~always.
 *  2. Declare it inline, when the line is genuinely recipe-basis by design — put
 *     the token "unit-lock:" in a comment (a // line comment, or a JSX comment
 *     for markup). It governs its own line and the 6 lines below it, so a
 *     multi-line justification above the element works. One-off cases only.
 *  3. Add an ALLOW-LIST entry below — required for anything structural. An
 *     exception must be DECLARED, never assumed: every entry carries the
 *     exception category and a written justification.
 *
 * THE FOUR LEGITIMATE RECIPE EXCEPTIONS (nothing else qualifies)
 * ──────────────────────────────────────────────────────────────
 *  1. recipe-authoring        — recipes / sub-recipes / cookbook / menu-item
 *                               costing. A recipe is authored in grams.
 *  2. food-consumption-recipe — food consumption computed FROM a recipe.
 *  3. exact-balance-ledger    — exact-balance ledger reports (liquor Movement).
 *                               Must be LABELLED "(recipe)" on screen.
 *  4. cross-material-sum      — never add ml + g + pcs. Print an em-dash and keep
 *                               the ₹ total. Precedent: inventory/stock-overview tfoot.
 *
 * In all four the recipe basis must be LABELLED on screen, never silently assumed.
 *
 * See also: src/lib/pack-units.ts (the helpers + the unit canon).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* ──────────────────────────────────────────────────────────────────────────
 * SCOPE — the Purchase + Inventory module, per src/lib/page-catalog.ts
 * (groups: Requisitions, Purchasing, Inventory) plus the party
 * requisition/approval/consumption surfaces the owner named, the End-of-Day
 * counting screen, the home dashboard's stock-alert widget, and every API
 * route that feeds them.
 *
 * Sales / POS / KDS / CRM / Tasks are deliberately OUT of scope: they deal in
 * plates and covers, which have no purchase unit.
 * ────────────────────────────────────────────────────────────────────────── */
const SCOPE_DIRS = [
  'src/app/inventory',
  'src/app/purchases',
  'src/app/purchase-orders',
  'src/app/grn',
  'src/app/receiving-variance',
  'src/app/requisitions',
  'src/app/store-requisitions',
  'src/app/party-requisitions',
  'src/app/party-approvals',
  'src/app/variance-approvals',
  'src/app/closing-stock',
  'src/app/department-materials',
  'src/app/department-consumption',
  'src/app/food-consumption',
  'src/app/party-events',
  'src/app/wastage',
  'src/app/store-dashboard',
  'src/app/unit-audit',
  'src/app/daily-rollup',
  'src/app/variance-report',
  'src/app/eod',
  // APIs that feed the above
  'src/app/api/inventory',
  'src/app/api/purchases',
  'src/app/api/purchase-orders',
  'src/app/api/grn',
  'src/app/api/receiving-variance',
  'src/app/api/requisitions',
  'src/app/api/party-requisitions',
  'src/app/api/party-events',
  'src/app/api/party-consumption',
  'src/app/api/wastage',
  'src/app/api/stores',
  'src/app/api/store-dashboard',
  'src/app/api/store-issued-log',
  'src/app/api/closing-stock',
  'src/app/api/department-materials',
  'src/app/api/department-consumption',
  'src/app/api/department-stock',
  'src/app/api/variance-approvals',
  'src/app/api/variance-report',
  'src/app/api/daily-rollup',
  'src/app/api/unit-audit',
  // BLIND SPOT (d) — shared renderers. MaterialTypeahead alone is mounted by
  // /purchases, /requisitions, /grn, /wastage, /inventory/transfers and
  // /inventory/liquor-store; a basis leak inside it reaches all six at once,
  // which is exactly how grams got into the /requisitions composer. Scanning the
  // whole directory (rather than naming files) means the NEXT shared picker is
  // covered the day it is written, instead of the day it breaks.
  'src/components',
];

/**
 * Carved OUT of the scoped dirs above. Same rationale as the module boundary
 * itself: Sales / POS / KDS / CRM deal in plates and covers, which have no
 * purchase unit, so a recipe-unit render there is not a defect. Keep this list
 * as short as the truth allows — every entry is a place the lock cannot see.
 */
const SCOPE_EXCLUDE = [
  'src/components/ct', // CRM telephony (calls, bookings, screen-pop)
];

/** Individual files pulled into scope (they render raw-material stock). */
const SCOPE_FILES = [
  'src/app/page.tsx',            // home dashboard — Stock Alerts / low-stock widget
  'src/lib/dept-stock.ts',
  'src/lib/store-engine.ts',
];

/* ──────────────────────────────────────────────────────────────────────────
 * ALLOW-LIST — declared exceptions. An entry MUST name one of the four
 * categories above and say why. `contains` anchors the exception to the text
 * of the offending line (line numbers rot; snippets survive refactors).
 * Omitting `contains` exempts the whole file — blunt, use only with a reason
 * that applies to every quantity in it.
 * ────────────────────────────────────────────────────────────────────────── */
const ALLOW = [
  {
    file: 'src/app/food-consumption/page.tsx',
    category: 'food-consumption-recipe',
    contains: ['per_portion', 'recipe_qty', 'portionQty'],
    reason:
      'EXCEPTION 2 — per-portion figures come straight off the recipe, which is ' +
      'authored in grams. Converting them to kg would misstate the recipe. The ' +
      'column header labels the basis.',
  },
  {
    file: 'src/app/inventory/liquor-store/page.tsx',
    category: 'exact-balance-ledger',
    contains: ['Unit (recipe)', 'movement', 'Movement', 'Recipe qty', 'R.unit'],
    reason:
      'EXCEPTION 3 — the liquor Movement / Ledger / Current-Stock report column ' +
      'definitions. These are exact-balance reports: opening + in − out = closing ' +
      'must reconcile to the stored recipe figure with no rounding, so the recipe ' +
      'pair is carried alongside. In every one of them the PURCHASE pair leads ' +
      '(qty_purchase + purchase_unit) and the recipe columns are explicitly ' +
      'labelled — "Recipe qty" / "R.unit" / "Unit (recipe)".',
  },
  {
    file: 'src/app/inventory/liquor-store/page.tsx',
    category: 'exact-balance-ledger',
    contains: ['· {fq(qty)} {ru}'],
    reason:
      'EXCEPTION 3 — the <DualQty> companion figure. The LEAD one line above is ' +
      'fmtBreakdown()\'s purchase-basis string ("2 cs + 9 btl + 450 ml"); this span ' +
      'is the exact stored recipe total printed beside it ("· 25,200 ml"), labelled ' +
      'with its own unit. The breakdown rounds to whole cases and bottles, so the bar ' +
      'ledger carries the unrounded ml alongside or opening + in − out = closing stops ' +
      'reconciling. Surfaced by the 2026-07-30 alias widening (blind spot (b)): the ' +
      'unit is spelled `ru`, so the check could not see it before. It uses "·" rather ' +
      'than the house "=" hint marker, which is why it reads as a LEAD to the parser ' +
      'and needs a declared entry rather than the hint window.',
  },
  {
    file: 'src/app/inventory/stock-overview/page.tsx',
    category: 'cross-material-sum',
    contains: ['—'],
    reason:
      'EXCEPTION 4 — the tfoot prints an em-dash instead of a quantity total ' +
      'because summing across materials (ml + g + pcs) has no unit in any basis. ' +
      'The ₹ total is kept. This is the precedent every other footer copies.',
  },
  {
    file: 'src/app/variance-report/page.tsx',
    category: 'exact-balance-ledger',
    contains: ['material_unit'],
    reason:
      'EXCEPTION 3 — the whole table is one reconciliation identity: ' +
      'Purchases − Recipe − Wastage = Theoretical, and Loss = Theoretical − Closing. ' +
      '/api/variance-report converts purchase quantities ×pack_size INTO the recipe ' +
      'basis before subtracting, so all five terms share one basis and the balance ' +
      'closes exactly. Converting the columns would round five terms independently ' +
      'and the identity would stop reconciling on screen. Basis is instead declared ' +
      'in every column header — "(recipe)" — mirroring the liquor Movement report.',
  },
  {
    file: 'src/app/api/stores/[id]/adjust-bulk/route.ts',
    category: 'exact-balance-ledger',
    contains: ['Bulk opening', 'Bulk set'],
    reason:
      'EXCEPTION 3 — this is the ledger row\'s own stored `detail` string, not a ' +
      'screen. p.target / p.current / p.qty are RECIPE units (the route documents ' +
      'the POST body as such) and p.unit is the matching recipe unit, so the note ' +
      'is an honest, exactly-reconciling record of what was posted. Rewriting it to ' +
      'the purchase basis would put a rounded figure into a permanent audit record.',
  },
  {
    file: 'src/app/api/stores/empties/route.ts',
    category: 'exact-balance-ledger',
    contains: ['logAuditEvent', 'note: `'],
    reason:
      'EXCEPTION 3 — audit_event note for a bar-empties movement. qty is stored in ' +
      'RECIPE units (validated as such on the way in) and mat.unit is the matching ' +
      'recipe unit, so the record reconciles exactly with the ledger row it describes. ' +
      'The SCREEN is already purchase-lead: GET on this route ships dualQty().',
  },
];

/* ──────────────────────────────────────────────────────────────────────────
 * DETECTION
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Anything that proves the author went through the shared purchase-unit layer.
 * Includes the members lineUnits() exposes (toPU/fromPU/toRecipe/stockPU/.pf) —
 * seeing one of those IS proof the canon resolver was used for this render.
 *
 * BLIND SPOT (c), 2026-07-30 — `pack_size` and `material_pack_size` USED TO BE on
 * this list and have been removed. A marker may only ever vouch for a line when
 * it is evidence the SHARED helper ran. The raw column name is evidence of no
 * such thing: `{(m.pack_size > 1 ? s / m.pack_size : s).toFixed(2)} {m.unit}` is
 * a line that re-derives the pack rule with the short guard, gets it WRONG, and
 * under the old list handed itself a clean bill of health for doing so. That is
 * the /unit-audit divide that printed PICKLED GINGER 1.5KG's 6 kg as "4 kg".
 *
 * `pack_factor` STAYS: it is the frozen DualQty wire field (see pack-units.ts),
 * so its presence means a server payload built by dualQty() is in hand. A local
 * variable that reaches the same name by re-deriving it is caught instead by
 * handrolledPackRule() below, on the line where the derivation happens.
 */
const PURCHASE_MARKERS = [
  'toPurchaseQty', 'dualQty', 'displayQty', 'lineUnits', 'fmtBreakdown',
  'breakdownQty', 'packFactor', 'purchasePrice', 'purchase_unit', 'purchaseUnit',
  'qty_purchase', 'pack_factor', 'qtyText', 'puOf', 'puLabel', 'packConv',
  'toPU(', 'fromPU(', 'toRecipe(', 'stockPU(', 'U.pf', 'fmtPU(',
  'U.pu',
];

/**
 * A recipe-unit expression. Deliberately excludes every purchase-unit spelling.
 * The bare-`unit` alternative also excludes:
 *   • type annotations and object keys  — `unit?: string`, `unit: mat.unit`
 *   • string literals                   — `{ k: 'unit', l: 'R.unit' }` (column defs)
 * Neither renders a quantity, and both were noisy in the first draft.
 */
const RECIPE_UNIT_RE =
  /(?:\b(?:material_unit|recipe_unit|recipeUnit|mat_unit)\b|(?<![\w$])\w[\w$]*(?:\?)?\.unit\b(?!_)|(?<![\w$.'"`])unit\b(?!_|s\b|\??\s*[:=]))/;

/** Spellings that look like a unit but are NOT a recipe unit — never flag these. */
const NOT_RECIPE_UNIT_RE =
  /purchase_unit|purchaseUnit|unit_price|unitPrice|unit_cost|unitCost|unit_id|unit_name|unitLabel|\bunits\b/;

/**
 * Words that mean "there is a quantity on this line".
 * NO leading \b — snake_case names must match on their tail: `current_stock`,
 * `physical_stock` and `system_stock` all failed a `\bstock` test because `_`
 * is a word character, which silently blinded the whole check to the single
 * most common quantity field in this codebase.
 */
const QTY_RE =
  /(qty|quantity|quantities|stock|on_hand|onHand|physical|system|variance|count|balance|issued|received|requested|accepted|rejected|ordered|consumed|wastage|weight|reorder|loose|opening|closing|outstanding|leftover|transfer|toFixed|toLocaleString|fmtQtyNum|fmtNum|fmt2|fmt3|fq\()/i;

/** The number → unit adjacency, in JSX (`{n} {m.unit}`) and template literals. */
const ADJACENT_JSX_RE = /\}\s*(?:[^{}<>]{0,12})\{[^{}]{0,120}$/;   // …} …{  → next token is the unit expr
const ADJACENT_TPL_RE = /\}\s*(?:[^${}]{0,12})\$\{[^{}]{0,120}$/;  // …} …${ → same, inside a template

const INLINE_ESCAPE_RE = /unit-lock:/;

/**
 * Look-back window for a DECLARED HINT only. A LEAD has no window at all — it
 * must prove itself on its own line (see the rule in the file header), which is
 * what stops a single reverted cell from hiding among converted siblings.
 *
 * 26 lines suits the hint's usual shape: the purchase lead is resolved once at
 * the top of the row (`const conv = v => toPurchaseQty(...)`) and the hint
 * renders near the bottom of a tall JSX cell.
 */
const HINT_CONTEXT_ABOVE = 26;
const CONTEXT_BELOW = 3;
/** An inline `unit-lock:` note governs its own line and the 6 below it —
 *  enough for a multi-line justification plus the element it annotates. */
const ESCAPE_REACH = 6;

/**
 * "= {" or "= ${" with a space: the house hint marker. `=` must be followed by
 * WHITESPACE then an interpolation, which already excludes `=> {` (arrow) and
 * `attr={` (JSX prop); the leading class excludes `==`/`===`/`!=` and the
 * compound assignments. A JSX tag close before it (`…>= {fmtNum(q)}`) is the
 * normal shape and must still count.
 */
const HINT_MARKER_RE = /[^=!+\-*/%&|^]=\s+[{$]/;

/* ──────────────────────────────────────────────────────────────────────────
 * BLIND SPOT (b) — LOCAL ALIAS RESOLUTION
 *
 * `<span>{ru}</span>` prints the recipe unit, but by the time it reaches the JSX
 * it is spelled `ru`, and no regex over that one line can know. So resolve names
 * per file first, then scan lines with the file's own vocabulary.
 *
 * Two directions, and they are not symmetric:
 *   • a name bound to a RECIPE-unit expression becomes a recipe-unit TOKEN, so
 *     rendering it is exactly as suspicious as rendering `m.unit`;
 *   • a name bound to an expression that already contains a shared-helper MARKER
 *     becomes a local marker, so `const d = displayStock(m)` genuinely does
 *     vouch for the `{d.unit}` two lines below it. Without this half, widening
 *     (b) would fire on correct, basis-aware components — a checker that cries
 *     wolf gets muted, and a muted checker is the failure mode we are fixing.
 *
 * PURCHASE WINS. `const displayUnit = m => purchaseBasis && m.purchase_unit
 * ? m.purchase_unit : m.unit` mentions `.unit`, but it is basis-aware by
 * construction; NOT_RECIPE_UNIT_RE on the RHS keeps it out of the recipe set.
 *
 * Two passes, because aliases chain: `displayStock` earns its marker from
 * `toPurchaseQty`, and only then can `d` earn its marker from `displayStock`.
 * ────────────────────────────────────────────────────────────────────────── */

/** `const|let|var NAME = <rhs>` (optional type annotation). */
const DECL_RE = /(?:^|[;{}(),]|\s)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+?)?=\s*([^;\n]*)/g;
/** `const { a, unit: b } = <rhs>` — renamed destructuring of a unit field. */
const DESTRUCT_RE = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*([^;\n]*)/g;
/** Wire fields that ARE the recipe unit under a different column name. Each one
 *  is a real field in this schema: requisition_items.unit is the LINE unit
 *  (blank = recipe, "Option B"), and the APIs alias it on the way out. */
const RECIPE_UNIT_FIELDS = ['unit', 'recipe_unit', 'material_unit', 'mat_unit', 'req_unit', 'line_unit', 'item_unit'];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Strip string literals and trailing line comments so operators can be read. */
function codeOf(line) {
  return line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\$]|\\.)*`/g, '``')  // only templates with no ${…} to preserve
    .replace(/\/\/.*$/, '');
}

function hasSharedMarker(text, localMarkers) {
  if (PURCHASE_MARKERS.some(mk => text.includes(mk))) return true;
  return localMarkers.length > 0 && localMarkers.some(re => re.test(text));
}

/**
 * The declaration's WHOLE right-hand side, across as many lines as it spans.
 *
 * DECL_RE's own capture stops at the first `;` or newline, which is wrong for
 * every shape that matters here:
 *
 *   const displayStock = (m: MaterialLite): { qty: number; unit: string } => {
 *     …toPurchaseQty(…)…                    ← the proof lives HERE
 *   };
 *   const lppRecipe = isPack
 *     ? … / Number(r.pack_size)             ← and the guard lives one line UP
 *     : …;
 *
 * Cut the RHS at the first line, and MaterialTypeahead's correct basis-aware
 * picker gets reported and /api/store-dashboard's correctly-guarded divide gets
 * reported. Both are false positives, and a checker that fires on correct code
 * gets switched off — the same end state as one that misses defects.
 *
 * So: scan forward tracking bracket depth, skipping strings and comments, and
 * stop at a `;` or a newline that is genuinely the end of the expression (not a
 * line broken before `?`, `:`, `&&`, `!==`, …). Hard cap, and on running past
 * the enclosing scope we stop rather than over-claim.
 */
const CONT_END_RE = /(?:[?:&|+\-*/%,.([{<>!=]|=>|\b(?:return|typeof|instanceof|new|await|in|of))$/;
const CONT_START_RE = /^(?:\?\?|\?\.|\?|:|\.|\)|\]|\}|&&|\|\||=>|[!=<>]=|[+\-*/%])/;
const RHS_LIMIT = 6000;
/** The pack-root walk (below) needs the WHOLE statement, not a snippet of it —
 *  /requisitions' `const [lines, setLines] = useState(() => …)` spans 6.5 KB and
 *  the guarded `pack_size:` sits 67 lines inside it. */
const RANGE_LIMIT = 200000;

function skipQuoted(src, i, end) {
  const q = src[i];
  for (let j = i + 1; j < end; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q) return j + 1;
  }
  return end;
}

/** Index just past the end of the expression that starts at `start`. */
function rhsEnd(src, start, limit) {
  const end = Math.min(src.length, start + limit);
  let depth = 0, i = start;
  while (i < end) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipQuoted(src, i, end); continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? end : nl; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; if (depth < 0) break; i++; continue; }
    if (depth === 0) {
      if (c === ';') break;
      if (c === '\n') {
        const before = src.slice(start, i).trimEnd();
        let j = i + 1; while (j < end && /\s/.test(src[j])) j++;
        if (!CONT_END_RE.test(before) && !CONT_START_RE.test(src.slice(j, j + 4))) break;
      }
    }
    i++;
  }
  return i;
}

function rhsOf(src, m) {
  const start = m.index + m[0].length - (m[2] || '').length;
  return src.slice(start, rhsEnd(src, start, RHS_LIMIT));
}

/* ──────────────────────────────────────────────────────────────────────────
 * BYPASS 1 (2026-07-30) — "ANY LOCAL MARKER VOUCHES FOR A LEAD"
 *
 * The lead rule is the load-bearing one: a cell that truly leads in the purchase
 * basis prints `pu` / `purchase_unit`, never `.unit`, so a lead printing a recipe
 * unit is wrong BY CONSTRUCTION and must prove itself on its own line. The
 * implementation had quietly stopped enforcing that, because the same-line proof
 * accepted ANY local name the alias resolver had blessed — and a name is blessed
 * merely by being bound to an expression that MENTIONS a marker. So:
 *
 *     const label = m.purchase_unit ? 'packed' : 'loose';   // ← blesses `label`
 *     …
 *     <td className={label}>{fmtQtyNum(m.current_stock)} {m.unit}</td>   // ← passes
 *
 * `label` is a CSS class. It says nothing about the basis of the number beside
 * it. Any `key={…}`, `title={…}` or sibling `{…}` naming such a local cleared the
 * cell, which is exactly the fix-one-cell-leave-the-sibling failure this guard
 * exists to catch, dressed up as proof.
 *
 * A local may now vouch for a LEAD in only two ways, and both are about the UNIT
 * that is actually being printed rather than about vocabulary on the line:
 *
 *   (i)  IT IS THE TOKEN'S OWN ROOT — `const d = displayStock(m)` then `{d.unit}`.
 *        The unit came OUT of the shared layer, so it is the shared layer's
 *        answer. This is blind spot (b)'s original intent and it is preserved
 *        verbatim; without it, MaterialTypeahead's correct basis-aware picker
 *        would be reported.
 *
 *   (ii) IT IS A PURCHASE-BASIS UNIT VALUE standing in the same interpolation —
 *        `{pu || ru || ''}`, where `const pu = p.material_purchase_unit`. The
 *        purchase unit leads and the recipe unit is its fallback, which is the
 *        approved shape.
 *
 * (ii) turns on VALUE position, not mere mention: `m.purchase_unit || m.unit`
 * yields the purchase unit, whereas `m.purchase_unit ? 'packed' : 'loose'`
 * yields a CSS class and only tests it. resultExprs() below is that distinction.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The sub-expressions that can be the VALUE of `expr`, i.e. what it evaluates
 * to — the branches of a ternary, either side of `||` / `??`, the right of `&&`.
 * A ternary's CONDITION is not among them, which is the whole point: mentioning
 * `purchase_unit` in a test does not make the result a purchase unit.
 */
function resultExprs(expr, depth = 0) {
  const s = expr.trim();
  if (depth > 3 || !s) return [s];
  const tops = topLevelOps(s);
  if (tops.ternary >= 0 && tops.colon > tops.ternary) {
    return [
      ...resultExprs(s.slice(tops.ternary + 1, tops.colon), depth + 1),
      ...resultExprs(s.slice(tops.colon + 1), depth + 1),
    ];
  }
  if (tops.or.length) {
    const out = [];
    let prev = 0;
    for (const at of tops.or) { out.push(...resultExprs(s.slice(prev, at), depth + 1)); prev = at + 2; }
    out.push(...resultExprs(s.slice(prev), depth + 1));
    return out;
  }
  if (tops.and.length) return resultExprs(s.slice(tops.and[tops.and.length - 1] + 2), depth + 1);
  return [s];
}

/** Positions of the depth-0 `?` / `:` / `||` / `??` / `&&` in an expression. */
function topLevelOps(s) {
  const out = { ternary: -1, colon: -1, or: [], and: [] };
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') { i = skipQuoted(s, i, s.length) - 1; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (depth !== 0) continue;
    if (c === '?') {
      if (s[i + 1] === '.') { i++; continue; }             // optional chaining
      if (s[i + 1] === '?') { out.or.push(i); i++; continue; } // nullish coalescing
      if (out.ternary < 0) out.ternary = i;
      continue;
    }
    if (c === ':' && out.ternary >= 0 && out.colon < 0) { out.colon = i; continue; }
    if (c === '|' && s[i + 1] === '|') { out.or.push(i); i++; continue; }
    if (c === '&' && s[i + 1] === '&') { out.and.push(i); i++; continue; }
  }
  return out;
}

/**
 * A PURCHASE-BASIS UNIT value — the thing a correct lead actually prints.
 * Deliberately narrower than PURCHASE_MARKERS: a quantity helper (toPurchaseQty,
 * dualQty) converts a NUMBER and says nothing about which unit label follows it.
 */
const PU_UNIT_VALUE_RE = /purchase_unit|purchaseUnit|\bpuOf\s*\(|\bpuLabel\b|(?<![\w$])U\.pu\b|(?<![\w$])pu\b/;

/** Is this RHS bound to a purchase-basis unit value (not merely mentioning one)? */
function isPuUnitRhs(rhs) {
  if (!rhs || rhs.length > 400) return false;
  if (!PU_UNIT_VALUE_RE.test(rhs)) return false;
  return resultExprs(rhs).some(e => PU_UNIT_VALUE_RE.test(e));
}

/**
 * The pack-layer helpers proper — a strict subset of PURCHASE_MARKERS. Seeing
 * one means the PACK RULE itself was resolved by the shared code, which is the
 * only thing that can excuse pack arithmetic sitting beside it. `purchase_unit`
 * is NOT here: printing a column name proves nothing about the factor.
 */
const PACK_HELPERS = [
  'packFactor', 'toPurchaseQty', 'dualQty', 'displayQty', 'fmtBreakdown',
  'breakdownQty', 'lineUnits', 'purchasePrice', 'tripleToRecipe', 'caseFactor',
  'entryMode', 'packConv',
];

/** Build the per-file alias vocabulary. */
function analyzeFile(src) {
  const recipe = new Set();   // names that hold a RECIPE unit
  const marker = new Set();   // names that carry shared-pack-layer proof
  const puUnit = new Set();   // names that hold a PURCHASE-basis UNIT value
  const packMk = new Set();   // names whose value came through the PACK rule itself
  const guarded = new Set();  // flags derived with BOTH halves of the pack rule
  const moneyFmts = new Set();// local formatters that print ₹, not a quantity

  const declPairs = [];
  for (const m of src.matchAll(DECL_RE)) declPairs.push([m[1], rhsOf(src, m)]);
  for (const m of src.matchAll(DESTRUCT_RE)) {
    const rhs = m[2] || '';
    for (const part of m[1].split(',')) {
      const kv = part.split(':');
      if (kv.length !== 2) continue;
      const key = kv[0].trim();
      const name = kv[1].trim().replace(/=.*$/, '').trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      if (RECIPE_UNIT_FIELDS.includes(key) && !NOT_RECIPE_UNIT_RE.test(rhs)) recipe.add(name);
      if (/^purchase_unit$|^purchaseUnit$|^qty_purchase$|^pack_factor$/.test(key)) marker.add(name);
      // `const { purchase_unit: pu } = m` really is the purchase unit itself.
      if (/^purchase_unit$|^purchaseUnit$/.test(key)) puUnit.add(name);
    }
  }

  // Two passes to a fixpoint over the chained aliases: `displayStock` earns its
  // marker from toPurchaseQty, and only then can `d` earn one from displayStock.
  for (let pass = 0; pass < 2; pass++) {
    const localMarkerRes = [...marker].map(n => markerRe(n));
    const localPackRes = [...packMk].map(n => markerRe(n));
    const localPuRes = [...puUnit].map(n => markerRe(n));
    for (const [name, rhs] of declPairs) {
      if (PACK_HELPERS.some(h => rhs.includes(h)) || localPackRes.some(re => re.test(rhs))) packMk.add(name);
      // A flag whose own derivation carries BOTH halves — `const isPack =
      // pack_size > 1 && unit !== purchase_unit`. Length-capped so a 900-char
      // SQL template cannot accidentally qualify as "guarded".
      if (rhs.length < 400 && PACK_FIELD_RE.test(rhs) && SECOND_HALF_RE.test(rhs)) guarded.add(name);
      if (rhs.length < 400 && MONEY_FMT_RE.test(rhs) && /=>|function/.test(rhs)) moneyFmts.add(name);
      // Purchase-basis UNIT aliases — the only locals allowed to vouch for a
      // LEAD (bypass 1). Chains too: `const u = pu || ''`.
      if (isPuUnitRhs(rhs) || (rhs.length < 400 && resultExprs(rhs).some(e => localPuRes.some(re => re.test(e))))) {
        puUnit.add(name);
      }
      if (hasSharedMarker(rhs, localMarkerRes)) { marker.add(name); continue; }
      if (RECIPE_UNIT_RE.test(rhs) && !NOT_RECIPE_UNIT_RE.test(rhs)) recipe.add(name);
    }
  }
  for (const n of marker) recipe.delete(n);   // purchase wins
  for (const n of puUnit) recipe.delete(n);
  for (const n of packMk) marker.add(n);

  const localMarkerRes = [...marker].map(n => markerRe(n));

  return {
    recipeAliasRe: recipe.size
      ? new RegExp(`(?<![\\w$.])(?:${[...recipe].map(esc).join('|')})\\b(?!\\s*[:=][^=])`)
      : null,
    localMarkerRes,
    markerNames: marker,
    puUnitRes: [...puUnit].map(n => markerRe(n)),
    packGuardedRe: guardedPackReceivers(src, localMarkerRes),
    packHelperRes: [...packMk].map(n => markerRe(n)),
    guardedFlagRes: [...guarded].map(n => markerRe(n)),
    moneyFmts,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * BYPASS 2 (2026-07-30) — THE PACK GUARD WAS FILE-WIDE
 *
 * `pack_size` in a given file may be the RAW column (recipe units per purchase
 * unit, unguarded) or a value that already holds packFactor()'s canon-guarded
 * output. /requisitions ships the latter — `pack_size: packConv` — so every
 * `ln.pack_size > 1` downstream really IS the full two-halves rule and must not
 * be reported. That was implemented as one boolean for the whole file:
 *
 *     if (ctx.packGuarded) return null;   // ← kills the check for 4,000 lines
 *
 * One guarded assignment at line 1818 therefore switched the pack-rule check OFF
 * for the entire page, including any OTHER object's raw pack_size. A hand-rolled
 * `mat.pack_size > 1 ? s / mat.pack_size : s` pasted anywhere in that file — a
 * different variable, a different payload, the raw /api/inventory column —
 * inherited a clean bill of health it had not earned.
 *
 * The guard is now per-RECEIVER. We resolve WHICH construct carries the guarded
 * field (the innermost declaration whose expression contains the assignment),
 * follow it into its iteration aliases (`lines` → `lines.map(ln => …)` → `ln`),
 * and suppress only `<that receiver>.pack_size`. A pack_size on any other
 * receiver — or a bare one — is judged normally.
 * ────────────────────────────────────────────────────────────────────────── */

/** `const X =` / `const [X, Y] =` / `const { X } =` — with the range of its RHS. */
const DECL_HEAD_RE =
  /(?:^|[;{}(),]|\s)(?:const|let|var)\s+(\[[^\]\n]*\]|\{[^}\n]*\}|[A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+?)?=\s*/g;
/** Iteration forms that hand an element of a collection to a callback param. */
const ITER_METHODS = 'map|filter|forEach|find|findIndex|findLast|flatMap|some|every|sort|reduce|reduceRight';

function guardedPackReceivers(src, localMarkerRes) {
  const guardedAt = [];
  for (const m of src.matchAll(/\b(?:material_)?pack_size\s*:\s*([^,;\n}]+)/g)) {
    if (hasSharedMarker(m[1], localMarkerRes)) guardedAt.push(m.index);
  }
  if (!guardedAt.length) return null;

  // Every declaration's RHS range, so we can ask "who owns this assignment?".
  const ranges = [];
  DECL_HEAD_RE.lastIndex = 0;
  for (const m of src.matchAll(DECL_HEAD_RE)) {
    const start = m.index + m[0].length;
    ranges.push({ start, end: rhsEnd(src, start, RANGE_LIMIT), names: identsIn(m[1]) });
  }

  const roots = new Set();
  for (const at of guardedAt) {
    let best = null;
    for (const r of ranges) {
      if (r.start > at || at >= r.end) continue;
      if (!best || (r.end - r.start) < (best.end - best.start)) best = r;   // innermost wins
    }
    if (best) for (const n of best.names) roots.add(n);
  }
  if (!roots.size) return null;

  // The guarded object is normally a COLLECTION; the pack_size is read off its
  // elements under a different name. Follow the iteration one hop (twice, so a
  // derived list — `const buyLines = lines.filter(ln => …)` — carries through).
  const receivers = new Set(roots);
  for (let pass = 0; pass < 2; pass++) {
    for (const r of [...receivers]) {
      const iter = new RegExp(
        `(?<![\\w$])${esc(r)}\\s*(?:\\?\\.)?\\.\\s*(?:${ITER_METHODS})\\s*\\(\\s*(?:async\\s*)?` +
        `(\\([^()]*\\)|[A-Za-z_$][\\w$]*)`, 'g');
      for (const m of src.matchAll(iter)) for (const n of identsIn(m[1])) receivers.add(n);
      const forOf = new RegExp(
        `for\\s*(?:await\\s*)?\\(\\s*(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+${esc(r)}\\b`, 'g');
      for (const m of src.matchAll(forOf)) receivers.add(m[1]);
    }
  }
  return new RegExp(
    `(?<![\\w$])(?:${[...receivers].map(esc).join('|')})\\s*(?:\\?\\.|\\.)\\s*(?:material_)?pack_size\\b`, 'g');
}

/** Plain identifiers inside a binding pattern / param list. */
function identsIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (!/^(?:async|const|let|var)$/.test(m[0])) out.push(m[0]);
  }
  return out;
}

/** Markers may sit behind a dot (`r.on_hand_pu`, `q.primaryValue`) — the value
 *  carries its provenance into the property. Recipe aliases may NOT: `x.ru` is a
 *  different thing from the local `ru`, and treating them alike invents hits. */
const markerRe = (n) => new RegExp(`(?<![\\w$])${esc(n)}\\b`);

/* ──────────────────────────────────────────────────────────────────────────
 * BLIND SPOT (c) — HAND-ROLLED PACK RULE
 *
 * The pack rule has TWO halves — `pack_size > 1 AND unit !== purchase_unit` —
 * and every local copy ever written in this repo has dropped the second one.
 * Live consequence: PICKLED GINGER 1.5KG is kg/kg with pack_size 1.5, so the
 * short guard divides a real 6 kg stock and prints "4 kg" to the store.
 *
 * WHAT IT DOES *NOT* FLAG, and why the line matters:
 *   • a complete copy — `pack_size > 1 && ru !== pu` — is not the defect. Seven
 *     API routes carry one, correctly, in SQL where packFactor() cannot reach.
 *     Failing them would make this the boy who cried wolf, and the SECOND time
 *     a checker cries wolf nobody reads the third report.
 *   • a `pack_size` field that already HOLDS packFactor()'s output (see
 *     ctx.packGuarded) — /requisitions ships exactly that.
 *   • comments, including SQL `--` comments describing the correct rule.
 *
 * What is left is the real thing: pack arithmetic with the second half missing.
 * ────────────────────────────────────────────────────────────────────────── */
const PACK_FIELD_RE = /\b(?:material_)?pack_size\b/;
const PACK_ARITH_RES = [
  // ÷ or × BY pack_size:  `q / m.pack_size`, `q * (row.pack_size || 1)`
  /[*/]\s*\(*\s*(?:Number\(|parseFloat\(|Math\.\w+\()?\s*[\w$.?[\]]*\b(?:material_)?pack_size\b/,
  // pack_size ÷ or ×:     `m.pack_size * qty`, `(Number(m.pack_size)||1) / x`
  /\b(?:material_)?pack_size\b[\s)|?\d.]{0,14}[*/](?![*/=])/,
  // the short guard:      `pack_size > 1`, `(m.pack_size ?? 1) > 1`
  /\b(?:material_)?pack_size\b[^;,\n{}]{0,20}?[<>]=?\s*1(?![\d.])/,
];
/**
 * THE SECOND HALF: an actual comparison against the purchase unit. Both operand
 * orders, both JS (`!==`) and SQL (`<>`) spellings, and the `ru !== pu` shorthand
 * the API routes use. Its ABSENCE is what turns pack arithmetic into the bug.
 *
 * `<>` must be preceded by an OPERAND (identifier, `)`, quote, `]`) — in TSX the
 * bare `<>` is a fragment, not an operator, and matching it let
 * `{r.pack_size > 1 ? <>{…}{r.purchase_unit}…}` on /store-dashboard clear itself
 * with its own JSX. A comparison operator that is really a tag is worse than no
 * check at all, because it clears exactly the render-side hits this exists for.
 */
const CMP = String.raw`(?:!==?|===?|(?<=[\w)'"\]]\s?)<>)`;
const SECOND_HALF_RE = new RegExp(
  `${CMP}[^;\\n]{0,90}?(?:purchase_unit|purchaseUnit|\\bpu\\b)` +
  `|(?:purchase_unit|purchaseUnit|\\bpu\\b)[^;\\n]{0,90}?${CMP}`, 'i');
/** ±4 lines: enough for the multi-line `String(a).toLowerCase() !== String(b)…`
 *  form all seven correct copies are written in, and no more. */
const SECOND_HALF_REACH = 4;
/** Declared escape for the pack rule, deliberately its OWN token: a `unit-lock:`
 *  note about a nearby display line must never silently absolve arithmetic. */
const PACK_ESCAPE_RE = /pack-rule-lock:/;
const PACK_ESCAPE_REACH = 3;
/** Comment lines, including SQL `--` inside a template literal. */
const COMMENT_LINE_RE = /^\s*(?:\*|\/\/|\/\*|--)/;

function handrolledPackRule(line, ctx, window) {
  if (COMMENT_LINE_RE.test(line)) return null;
  let code = codeOf(line);
  if (!PACK_FIELD_RE.test(code)) return null;
  if (!PACK_ARITH_RES.some(re => re.test(code))) return null;
  // (bypass 2) Blank out the pack_size reads that are provably the canon factor —
  // per RECEIVER, not per file. Anything still spelled pack_size after that is a
  // raw column and is judged on its own merits.
  if (ctx.packGuardedRe) {
    code = code.replace(ctx.packGuardedRe, 'GUARDED_PACK_FACTOR');
    if (!PACK_FIELD_RE.test(code)) return null;
  }
  if (SECOND_HALF_RE.test(window)) return null;                  // complete copy
  if (ctx.guardedFlagRes.some(re => re.test(window))) return null; // under a both-halves flag
  // The value in hand came through the pack layer already — /inventory's
  // wrong-mode detector multiplies by pack_size only over `eligible`, which
  // packFactor(m) > 1 built. That is the shared rule, applied one line up.
  if (ctx.packHelperRes.some(re => re.test(code))) return null;
  if (PACK_HELPERS.some(h => code.includes(h))) return null;
  return 'pack_size';
}

/* ──────────────────────────────────────────────────────────────────────────
 * BLIND SPOT (a) — BARE QUANTITY (a number with NO unit beside it)
 *
 * The adjacency detector above is blind by construction to `<td>{fmt2(r.opening)}</td>`:
 * there is no unit token, so there is nothing to be adjacent TO. That is how all
 * seven quantity columns on /daily-rollup printed raw grams — KAHLUA LIQUEUR
 * (750 ML) showed a closing of "6,630" against a real 8.84 BTL — and how the
 * Daily-rate cell on the home dashboard did the same.
 *
 * A bare number is not automatically wrong, so the test is deliberately narrow.
 * All of these must hold:
 *   1. a number FORMATTER call inside an interpolation (`{…}` or `${…}`);
 *   2. its argument names a MATERIAL QUANTITY (strict list — not `count`, which
 *      is usually a row count, and not `total`, which is usually money);
 *   3. it is not money or a percentage;
 *   4. NO unit token anywhere on the line — if there is one, the adjacency
 *      detector owns this line and a second opinion would only double-report;
 *   5. no shared-pack-layer proof within ±2 lines — the tight window is what
 *      lets the legitimate `<span>{fmtQtyNum(pq)}</span><span>{pu}</span>` split
 *      pass while a row of seven bare `<td>`s does not.
 * ────────────────────────────────────────────────────────────────────────── */
/**
 * A number formatter call, by SHAPE rather than by a fixed list of names.
 *
 * A hard-coded list is the wrong tool here: this repo has nine local quantity
 * formatters (fmt2, fmt3, fq, fmtNum, fmtQtyNum, csvQty, …) and nothing stops
 * the tenth. A list would silently exempt every new one — the same "unknown
 * spelling walks straight past" failure as blind spot (b). So match any callee
 * whose name contains fmt / format / fq, plus the two built-ins, and then
 * disambiguate MONEY formatters by resolving them per file (a formatter whose
 * body prints ₹ is not a quantity formatter) — exact instead of guessed.
 */
const FORMATTER_RE =
  /(?:\b([\w$]*(?:fmt|Fmt|format|Format|fq|Fq)[\w$]*)|(\.toFixed|\.toLocaleString))\s*\(/g;
/** A formatter that prints currency — its output is never a stock quantity. */
const MONEY_FMT_RE = /₹|'INR'|"INR"|currency/;
/**
 * Field names that mean "a quantity of a raw material". Strict on purpose.
 *
 * `counted` is deliberately NOT here, and the omission is load-bearing. On
 * /inventory/closing-overview `counted` is the number of ITEMS counted — the
 * "42 / 900" on the Items-counted card — and flagging it would have put four
 * false positives in the first widened run. The counted QUANTITY is spelled
 * `physical_stock` everywhere in this schema (closing_stock.physical_stock),
 * and that IS on the list.
 *
 * BYPASS 3 (2026-07-30) — the leading `\b` is GONE, and its absence is the fix.
 * `\b` before an alternative only matches at a non-word→word transition, and `_`
 * is a word character, so `\bqty\b` never saw `inward_qty` (16 live uses),
 * `chef_approved_qty` (58), `variance_qty` (21) or any other snake_case field
 * whose quantity word is not the first one. That is the identical mistake QTY_RE
 * documents in its own comment thirty lines above — made again, one constant
 * later, in the check that was added precisely to see quantities with no unit
 * beside them. A `(?<![A-Za-z0-9$])` lookbehind keeps `xqty` / `subtotalqty` out
 * while letting the `_` prefix through. The TRAILING `\b` stays: it is what
 * keeps `received_at`, `opening_time` and `count_rows` off the list.
 */
const QTY_FIELD_RE =
  /(?<![A-Za-z0-9$])(?:current_stock|physical_stock|system_stock|theoretical_stock|closing_stock|opening_stock|stock_qty|stock_level|counted_qty|physical_qty|on_hand|onHand|qty|quantity|qty_recipe|recipe_qty|received_qty|issued_qty|opening|closing|received|consumed|consumed_recipe|consumed_wastage|issued|requested|accepted|rejected|wastage|shortfall|transferred|deferred|reorder_level|daily_consumption_rate)\b/;
/**
 * Money / percentage / duration / row-counts / TIMESTAMPS — not a stock quantity.
 *
 * The date group is the price of the bypass-3 boundary fix: once a quantity word
 * may sit at the tail of a snake_case name, `date_received` and `closing_time`
 * match the field list, and `new Date(x).toLocaleString()` matches the formatter
 * shape — a bare-qty report on a timestamp. `\bdate\b` cannot touch "upDATEd"
 * (no word boundary), so the exclusion costs no real quantity.
 */
const NOT_QTY_CONTEXT_RE =
  /₹|\bprice\b|_price|price_|\bcost\b|_cost|\bvalue\b|_value|\bamount\b|_amount|\btotal\b|_total|rupee|\binr\b|\bgst\b|\btax\b|_tax|charge|discount|\bpct\b|percent|\bdays?\b|_days|\bage\b|margin|\bpnl\b|\bitems\b|_items|\bareas\b|\brows\b|\bcount\b|\bnew\s+Date\b|\bDate\.|\bdate\b|_date\b|\bdate_|_at\b|\btime\b|_time\b|timestamp/i;
const BARE_CONTEXT = 2;

/** Text of the innermost interpolation containing `idx`, or null. */
function interpolationAt(line, idx) {
  let open = -1;
  for (let i = idx; i >= 0; i--) {
    if (line[i] === '{') { open = i; break; }
    if (line[i] === '}') return null;
  }
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '{') depth++;
    else if (line[i] === '}') { depth--; if (depth === 0) return line.slice(open, i + 1); }
  }
  return line.slice(open);
}

function bareQtyOnLine(line, ctx) {
  // (4) any unit token on the line hands ownership back to the adjacency check.
  if (RECIPE_UNIT_RE.test(line) || NOT_RECIPE_UNIT_RE.test(line)) return null;
  if (ctx.recipeAliasRe && ctx.recipeAliasRe.test(line)) return null;
  if (ctx.localMarkerRes.some(re => re.test(line))) return null;

  FORMATTER_RE.lastIndex = 0;
  let m;
  while ((m = FORMATTER_RE.exec(line))) {
    if (m[1] && ctx.moneyFmts.has(m[1])) continue;           // ₹ formatter, not a qty
    const interp = interpolationAt(line, m.index);
    if (!interp) continue;                                   // (1) must be a render
    if (!QTY_FIELD_RE.test(interp)) continue;                // (2) must be a qty
    if (NOT_QTY_CONTEXT_RE.test(interp)) continue;           // (3) not money/%/days
    return (QTY_FIELD_RE.exec(interp) || [interp])[0];
  }
  return null;
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    if (SCOPE_EXCLUDE.some(x => rel === x || rel.startsWith(x + '/'))) continue;
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

function collectFiles() {
  const out = [];
  for (const d of SCOPE_DIRS) walk(path.join(ROOT, d), out);
  for (const f of SCOPE_FILES) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) out.push(p);
  }
  return [...new Set(out)].sort();
}

/**
 * Find every recipe-unit token on the line and test the text just before it.
 *
 * Run TWICE per line: once raw (catches renders inside attributes, e.g. a
 * `title={`${qty} ${m.unit}`}` tooltip) and once with JSX tags collapsed to a
 * space (catches `{qty} <span …>{m.unit}</span>`, which is how /variance-report
 * hid a whole table of recipe figures from the first draft of this check).
 */
function violationsOnLine(rawLine, ctx) {
  const stripped = rawLine.replace(/<[^<>]*>/g, ' ');
  const hits = [...scanOne(rawLine, ctx), ...scanOne(stripped, ctx)];
  return hits;
}

/**
 * The recipe-unit vocabulary for THIS file: the global spellings, plus every
 * local name the alias resolver proved holds a recipe unit (blind spot (b)).
 */
function unitTokenRe(ctx) {
  if (!ctx.recipeAliasRe) return RECIPE_UNIT_RE;
  return new RegExp(`(?:${RECIPE_UNIT_RE.source})|(?:${ctx.recipeAliasRe.source})`);
}

function scanOne(line, ctx) {
  const re = unitTokenRe(ctx);
  const hits = [];
  let cursor = 0;
  for (let guard = 0; guard < 40; guard++) {
    const rest = line.slice(cursor);
    const m = re.exec(rest);
    if (!m) break;
    const at = cursor + m.index;
    const token = m[0];
    cursor = at + token.length;

    // Never flag a purchase-unit spelling that merely contains "unit".
    const around = line.slice(Math.max(0, at - 20), at + token.length + 10);
    if (NOT_RECIPE_UNIT_RE.test(around)) continue;

    const before = line.slice(0, at);
    if (!QTY_RE.test(before)) continue;
    if (!ADJACENT_JSX_RE.test(before) && !ADJACENT_TPL_RE.test(before)) continue;
    hits.push({ token, at, src: line });
  }
  return hits;
}

/** The object the unit was read off — `d` in `{d.unit}`, `r` in `{r.material_unit}`. */
function rootOf(hit) {
  const own = /^([A-Za-z_$][\w$]*)\s*\??\.\s*unit$/.exec(hit.token);
  if (own) return own[1];
  const back = /([A-Za-z_$][\w$]*)\s*\??\.\s*$/.exec(hit.src.slice(0, hit.at));
  return back ? back[1] : null;
}

/**
 * Same-line proof for a LEAD (see the BYPASS 1 note above). A local name only
 * counts when it is the unit's own provenance or a purchase unit standing in the
 * same interpolation — never merely for appearing on the line.
 */
function leadProven(line, hits, ctx) {
  // The shared layer itself is invoked, or its frozen wire field is in hand,
  // right here on this line. Unchanged: this is the documented lead rule.
  if (PURCHASE_MARKERS.some(mk => line.includes(mk))) return true;
  // Otherwise EVERY recipe-unit token on the line must account for itself.
  return hits.length > 0 && hits.every(h => {
    const root = rootOf(h);
    if (root && ctx.markerNames.has(root)) return true;     // (i) the token came OUT of the shared layer
    const scope = interpolationAt(h.src, h.at) || h.src;    // (ii) a purchase unit leads it, right here
    return ctx.puUnitRes.some(re => re.test(scope));
  });
}

function isAllowed(relFile, line) {
  for (const a of ALLOW) {
    if (a.file !== relFile) continue;
    if (!a.contains) return a;
    if (a.contains.some(s => line.includes(s))) return a;
  }
  return null;
}

function scanFile(abs) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const src = fs.readFileSync(abs, 'utf8');
  const lines = src.split('\n');
  const ctx = analyzeFile(src);   // blind spot (b): this file's own vocabulary
  const found = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;           // comments & doc blocks

    // ── (c) hand-rolled pack rule — judged first, because it is a defect even
    //    when the render around it is otherwise perfectly purchase-lead.
    const secondHalfWin = lines
      .slice(Math.max(0, i - SECOND_HALF_REACH), Math.min(lines.length, i + SECOND_HALF_REACH + 1))
      .join('\n');
    const rolled = handrolledPackRule(line, ctx, secondHalfWin);
    if (rolled) {
      const packEsc = lines.slice(Math.max(0, i - PACK_ESCAPE_REACH), i + 1).join('\n');
      if (!PACK_ESCAPE_RE.test(packEsc)) {
        found.push({
          kind: 'pack-rule', file: rel, line: i + 1, text: line.trim(),
          token: rolled, allowed: isAllowed(rel, line),
        });
      }
    }

    // ── (a) bare quantity — a number with no unit token to be adjacent to.
    const bare = bareQtyOnLine(line, ctx);
    if (bare) {
      const win = lines
        .slice(Math.max(0, i - BARE_CONTEXT), Math.min(lines.length, i + BARE_CONTEXT + 1))
        .join('\n');
      const escapeWin = lines.slice(Math.max(0, i - ESCAPE_REACH), i + 1).join('\n');
      if (!INLINE_ESCAPE_RE.test(escapeWin) && !hasSharedMarker(win, ctx.localMarkerRes)) {
        found.push({
          kind: 'bare-qty', file: rel, line: i + 1, text: line.trim(),
          token: bare, allowed: isAllowed(rel, line),
        });
      }
    }

    const hits = violationsOnLine(line, ctx);
    if (hits.length === 0) continue;

    // Declared inline? (own line, or a `unit-lock:` note just above it)
    const escapeWin = lines.slice(Math.max(0, i - ESCAPE_REACH), i + 1).join('\n');
    if (INLINE_ESCAPE_RE.test(escapeWin)) continue;

    // Is this a declared HINT ("= {qty} {m.unit}") or a LEAD?
    //
    // A LEAD that prints a recipe-unit token is wrong by construction: a cell
    // that truly leads in the purchase basis prints `pu` / `purchase_unit`, not
    // `.unit`. So a lead must carry its proof on its OWN line — a nearby marker
    // is not enough. This is the rule that catches the owner's actual bug, where
    // ONE cell inside an already-converted table reverts to grams and the
    // converted siblings around it would otherwise vouch for it.
    //
    // A HINT is the low-risk shape (the leading "=" is reserved for it, so it can
    // never be the lead), and its purchase lead is normally resolved once at the
    // top of the row — so a hint may prove itself from the surrounding window.
    const isHint = HINT_MARKER_RE.test(line);
    if (isHint) {
      // A hint may prove itself from the window — the purchase lead it annotates
      // is normally resolved once at the top of the row. Local aliases count,
      // but only via the resolver: a name earns marker status by being BOUND to
      // a shared helper, never by looking like one.
      const proof = lines
        .slice(Math.max(0, i - HINT_CONTEXT_ABOVE), Math.min(lines.length, i + CONTEXT_BELOW + 1))
        .join('\n');
      if (hasSharedMarker(proof, ctx.localMarkerRes)) continue;
    } else if (leadProven(line, hits, ctx)) {
      continue;
    }

    const allowed = isAllowed(rel, line);
    found.push({
      kind: isHint ? 'recipe-hint' : 'recipe-lead',
      file: rel, line: i + 1, text: line.trim(), token: hits[0].token, allowed,
    });
  }
  return found;
}

/* ──────────────────────────────────────────────────────────────────────────
 * RUN
 * ────────────────────────────────────────────────────────────────────────── */
const files = collectFiles();
const all = files.flatMap(scanFile);
const violations = all.filter(v => !v.allowed);
const exempted = all.filter(v => v.allowed);

const B = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const R = (s) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const G = (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const D = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

const KINDS = {
  'recipe-lead':  'recipe unit LEADS the cell — the store reads grams/ml',
  'recipe-hint':  'recipe hint with no purchase lead anywhere near it',
  'bare-qty':     'bare quantity, NO unit printed — silently the recipe basis',
  'pack-rule':    'pack rule re-derived by hand — use packFactor() from @/lib/pack-units',
};

console.log(B('\nPurchase-unit lock — Purchase + Inventory modules'));
console.log(D(`scanned ${files.length} files across ${SCOPE_DIRS.length} scoped dirs` +
  (SCOPE_EXCLUDE.length ? ` (− ${SCOPE_EXCLUDE.length} carve-out)` : '') + '\n'));

if (exempted.length) {
  console.log(B(`Declared exceptions (${exempted.length}) — allowed, recipe basis by design:`));
  for (const v of exempted) {
    console.log(`  ${D('·')} ${v.file}:${v.line}  [${v.allowed.category}]`);
    console.log(D(`      ${v.text.slice(0, 120)}`));
  }
  console.log('');
}

if (violations.length === 0) {
  console.log(G('✓ CLEAN — every quantity in scope leads with the purchase unit.\n'));
  process.exit(0);
}

console.log(R(B(`✗ ${violations.length} violation(s) — these print the wrong basis to the store:\n`)));
for (const kind of Object.keys(KINDS)) {
  const group = violations.filter(v => v.kind === kind);
  if (!group.length) continue;
  console.log(B(`  ${kind} (${group.length}) — ${KINDS[kind]}`));
  let last = '';
  for (const v of group) {
    if (v.file !== last) { console.log(`    ${B(v.file)}`); last = v.file; }
    console.log(`      ${R(`line ${v.line}`)}  ${v.text.slice(0, 150)}`);
  }
  console.log('');
}
console.log(D(`
Fix by importing packFactor / toPurchaseQty / dualQty / fmtBreakdown from
'@/lib/pack-units' and leading with the purchase unit — never re-derive the
pack rule. If the line is a genuine recipe exception, declare it: add
"// unit-lock: <reason>" (or "// pack-rule-lock: <reason>" for a pack-rule hit)
or an ALLOW entry in ${path.relative(ROOT, __filename)}.
`));
process.exit(1);
