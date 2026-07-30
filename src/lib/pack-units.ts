/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE PURCHASE-UNIT LOCK — read this before rendering any quantity.        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * OWNER RULE (2026-07-29): every quantity on a Purchase / Inventory page,
 * sub-page or tab LEADS with the PURCHASE unit (kg / L / BTL / CASE). The
 * recipe figure (g / ml) may appear only as a small declared hint, house style:
 *
 *     <div className="text-[9px] text-[#B8A590]">= {fmtQtyNum(q)} {m.unit}</div>
 *
 * Only four things stay in recipe units, and each must be LABELLED as recipe on
 * screen — never silently converted, never silently assumed:
 *   1. recipes / sub-recipes / cookbook / menu-item costing (authored in grams)
 *   2. food consumption computed FROM a recipe
 *   3. exact-balance ledger reports (liquor Movement, variance reconciliation)
 *   4. cross-material sums — never add ml + g + pcs. Print an em-dash, keep ₹.
 *
 * ALWAYS import packFactor / toPurchaseQty / dualQty / fmtBreakdown from here.
 * NEVER re-derive the pack rule. The guard has TWO halves and local copies keep
 * dropping the second one:
 *
 *     pack_size > 1  AND  lower(trim(unit)) !== lower(trim(purchase_unit))
 *
 * A local `pack_size > 1` alone mis-converts every material whose recipe unit
 * already equals its purchase unit (live example: PICKLED GINGER 1.5KG, kg/kg,
 * pack_size 1.5 — the short guard divides a 6 kg stock into "4.00 kg").
 *
 * ENFORCEMENT: scripts/check-purchase-units.js fails the build on any bare
 * recipe-unit render in these modules, and carries the declared allow-list.
 *
 *     npm run check:units
 *
 * ── original notes ────────────────────────────────────────────────────────
 *
 * Cases / Bottles / loose ↔ recipe-unit conversion helpers (bar counting
 * convention) — shared by the store APIs AND the Liquor Store page, so the
 * math can never drift between client preview and server posting.
 *
 * House convention (raw_materials):
 *   pack_size — recipe units per PURCHASE unit  (750 ml per BTL)
 *   case_size — purchase units per outer CASE   (12 BTL per case)
 *
 * A material only has a real pack conversion when pack_size > 1 AND the
 * recipe unit differs from the purchase unit (same rule as packConv on the
 * closing-stock page / procure route). Entry/display modes degrade:
 *   pack factor > 1 && case factor > 1 → Cases + Bottles + loose   ('cbl')
 *   pack factor > 1 && case factor ≤ 1 → Bottles + loose           ('bl')
 *   pack factor ≤ 1 && case factor > 1 → Cases + pieces            ('cb')
 *   pack factor ≤ 1 && case factor ≤ 1 → plain recipe units        ('plain')
 *
 * 'cb' is the beer/can case: a piece-counted item (pack_size 1) that is BOUGHT
 * by the case — e.g. Budweiser 330ml, recipe unit pcs, case_size 24. It still
 * gets a Cases box so you can enter "10 cases" (= 240 pcs), even though there
 * is no bottle→ml pack conversion.
 *
 * e.g. whisky case 12 × 750 ml: 2 cs + 9 btl + 450 ml
 *        = 2×12×750 + 9×750 + 450 = 25,200 ml  (exact integer math — never
 *        convert through fractional bottles).
 */

export interface PackMeta {
  unit?: string | null;
  purchase_unit?: string | null;
  pack_size?: number | null;
  case_size?: number | null;
}

/** Recipe units per purchase unit (1 = no real conversion). */
export function packFactor(m: PackMeta): number {
  const ps = Number(m?.pack_size) || 1;
  const ru = String(m?.unit || '').toLowerCase().trim();
  const pu = String(m?.purchase_unit || m?.unit || '').toLowerCase().trim();
  return ps > 1 && ru !== pu ? ps : 1;
}

/** Purchase units (bottles) per case (1 = cases not used). */
export function caseFactor(m: PackMeta): number {
  const cs = Number(m?.case_size) || 1;
  return cs > 1 ? cs : 1;
}

export type EntryMode = 'cbl' | 'cb' | 'bl' | 'plain';

/** Which quantity-entry inputs this material gets. */
export function entryMode(m: PackMeta): EntryMode {
  const pf = packFactor(m);
  const cf = caseFactor(m);
  if (pf > 1) return cf > 1 ? 'cbl' : 'bl';   // volume/pack items
  return cf > 1 ? 'cb' : 'plain';             // piece items: Cases+pieces, or plain
}

/**
 * Cases + bottles + loose → recipe units (exact: multiplies whole counts by
 * whole factors, never divides). Blank/NaN inputs must be passed as 0.
 */
export function tripleToRecipe(cases: number, bottles: number, loose: number, m: PackMeta): number {
  const pf = packFactor(m);
  const cf = caseFactor(m);
  const c = Number(cases) || 0;
  const b = Number(bottles) || 0;
  // Loose only exists when there's a real pack conversion (ml/g remainder).
  // Piece-counted items (pf ≤ 1: plain / 'cb' cases) have NO fractional loose —
  // ignore any stray loose so a malformed CSV can't add an invisible fraction.
  const l = pf > 1 ? (Number(loose) || 0) : 0;
  return c * cf * pf + b * pf + l;
}

export interface QtyBreakdown {
  sign: 1 | -1;
  cases: number;
  bottles: number;
  /** Recipe units left over (may be fractional). */
  loose: number;
  mode: EntryMode;
}

/**
 * Largest-unit breakdown of a signed recipe quantity. Returns null for
 * plain-unit materials (no conversion — display the raw qty unchanged).
 */
export function breakdownQty(qty: number, m: PackMeta): QtyBreakdown | null {
  const pf = packFactor(m);
  const cf = caseFactor(m);
  // Plain items (no pack conversion AND no case size) have no breakdown.
  if (pf <= 1 && cf <= 1) return null;
  const hasCases = cf > 1;
  const mode: EntryMode = hasCases ? (pf > 1 ? 'cbl' : 'cb') : 'bl';
  const sign: 1 | -1 = (Number(qty) || 0) < 0 ? -1 : 1;
  let rem = Math.abs(Number(qty) || 0);
  const EPS = 1e-9;
  const perCase = cf * pf;
  const cases = hasCases ? Math.floor((rem + EPS) / perCase) : 0;
  rem -= cases * perCase;
  const bottles = Math.floor((rem + EPS) / pf);
  rem -= bottles * pf;
  let loose = Math.round(rem * 1000) / 1000;
  if (loose <= 1e-6) loose = 0;
  return { sign, cases, bottles, loose, mode };
}

const short = (u?: string | null) => {
  const s = String(u || '').trim();
  return s ? s.toLowerCase() : 'unit';
};

/**
 * Human dual form: '2 cs + 9 btl + 450 ml' (largest-unit breakdown).
 * Zero parts are omitted ('3 cs', '9 btl + 450 ml'); an all-zero qty renders
 * as '0 <bottle unit>'. Negative quantities get a leading '−'. Returns null
 * for plain-unit materials.
 */
export function fmtBreakdown(qty: number, m: PackMeta): string | null {
  const b = breakdownQty(qty, m);
  if (!b) return null;
  const bu = short(m.purchase_unit || m.unit);
  const ru = short(m.unit);
  const parts: string[] = [];
  if (b.cases > 0) parts.push(`${b.cases.toLocaleString('en-IN')} cs`);
  if (b.bottles > 0) parts.push(`${b.bottles.toLocaleString('en-IN')} ${bu}`);
  if (b.loose > 0) parts.push(`${Number(b.loose.toFixed(3)).toLocaleString('en-IN')} ${ru}`);
  if (parts.length === 0) parts.push(`0 ${bu}`);
  return (b.sign < 0 ? '−' : '') + parts.join(' + ');
}

/* ────────────────────────────────────────────────────────────────────────────
 * DUAL-BASIS DISPLAY LAYER (owner rule, 2026-07-27): every quantity shown on
 * an Inventory / Store / Purchase / Requisition / Issuing / Dept-Stock surface
 * reads in PURCHASE units; recipes, food-consumption and exact-balance reports
 * stay in recipe units.
 *
 * Storage is UNCHANGED: current_stock stays recipe units, average_price stays
 * ₹/recipe-unit. Only the display converts, through here — one helper, so no
 * two surfaces can drift (drift is the root of every unit bug this app has had).
 *
 * Wire/prop contract is FROZEN to match /api/store-issued-log, the first
 * shipped implementation: { qty, unit, qty_purchase, purchase_unit, pack_factor }.
 *
 * TRAPS the callers must respect:
 *  • qty_purchase is a ROUNDED DERIVATIVE. Never store it, never post it back,
 *    never sum it across rows — sum the recipe numbers, convert the total once.
 *  • Money never round-trips through the purchase basis:
 *    (146/1000)×(1000×0.05) ≠ 146×0.05 in floats. value = recipeQty × ₹/recipe.
 *  • Never sum qty_purchase across MATERIALS (2 BTL + 3 kg is meaningless).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Frozen wire + prop shape (matches /api/store-issued-log exactly). */
export interface DualQty {
  /** RECIPE basis — the stored truth; what money + stock deductions use. */
  qty: number;
  /** Recipe unit, raw stored string (not lowercased). */
  unit: string;
  /** PURCHASE basis — derived, display-only, rounded to 3 dp. */
  qty_purchase: number;
  /** Purchase unit, raw stored string; falls back to the recipe unit. */
  purchase_unit: string;
  /** packFactor(m) — 1 when there is no real pack conversion. */
  pack_factor: number;
}

/** recipeQty → purchase units. Display-only: rounded to 3 dp, −0 normalised. */
export function toPurchaseQty(recipeQty: number, m: PackMeta): number {
  const v = Math.round(((Number(recipeQty) || 0) / packFactor(m)) * 1000) / 1000;
  return v === 0 ? 0 : v; // normalises -0 → 0 ((-0).toLocaleString prints "-0")
}

/** Build the frozen wire shape from a recipe qty + the material's pack meta. */
export function dualQty(recipeQty: number, m: PackMeta): DualQty {
  const q = Number(recipeQty) || 0;
  return {
    qty: q,
    unit: String(m?.unit || '').trim(),
    qty_purchase: toPurchaseQty(q, m),
    purchase_unit: String(m?.purchase_unit || m?.unit || '').trim(),
    pack_factor: packFactor(m),
  };
}

/**
 * DISPLAY-ONLY unit price: ₹/recipe-unit → ₹/purchase-unit (× packFactor).
 * Never use the output to compute a line value — value = recipeQty × ₹/recipe,
 * always, or rounding drift creates paise-level disagreements between surfaces.
 */
export function purchasePrice(pricePerRecipeUnit: number, m: PackMeta): number {
  return Math.round((Number(pricePerRecipeUnit) || 0) * packFactor(m) * 100) / 100;
}

/**
 * Adaptive-precision en-IN number: whole numbers plain, fractions to 3 dp with
 * trailing zeros trimmed. Exported so pages stop re-inventing fmtNum (there
 * were nine divergent local copies with 2-vs-3 dp disagreements).
 */
export function fmtQtyNum(v: number): string {
  const n = Number(v) || 0;
  return n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
}

/** CSV-safe number: fixed 3 dp, NO locale grouping (never toLocaleString in an export). */
export function csvQty(v: number): number {
  return Math.round((Number(v) || 0) * 1000) / 1000;
}

export type HintStyle = 'recipe' | 'breakdown' | 'none';
export interface QtyDisplay {
  /** e.g. "2 l" — formatted, ready to print. */
  primary: string;
  primaryUnit: string;
  primaryValue: number;
  /** "= 2,000 ml" | "9 btl + 450 ml" | null. */
  hint: string | null;
  /** Which basis `primary` is in — 'recipe' is the honest fallback when pack
   *  meta is missing (an older cached payload, a route that forgot the JOIN). */
  basis: 'purchase' | 'recipe';
}

/**
 * THE display entry point. Accepts a server DualQty payload, or a recipe qty +
 * PackMeta for client-side conversion. The recipe hint appears only when the
 * two bases actually differ; bar surfaces pass hint:'breakdown' to keep the
 * cases+bottles+loose string they already use.
 */
export function displayQty(d: DualQty, opts?: { hint?: HintStyle; meta?: PackMeta }): QtyDisplay;
export function displayQty(recipeQty: number, m: PackMeta, opts?: { hint?: HintStyle }): QtyDisplay;
export function displayQty(a: DualQty | number, b?: PackMeta | { hint?: HintStyle; meta?: PackMeta }, c?: { hint?: HintStyle }): QtyDisplay {
  let d: DualQty; let hint: HintStyle; let meta: PackMeta | undefined;
  if (typeof a === 'number') {
    meta = (b as PackMeta) || {};
    d = dualQty(a, meta);
    hint = c?.hint ?? 'recipe';
  } else {
    // Tolerate an older cached payload that predates the dual fields (PWA +
    // IndexedDB outbox can replay pre-conversion responses).
    d = {
      qty: Number(a?.qty) || 0,
      unit: String(a?.unit || '').trim(),
      qty_purchase: a?.qty_purchase ?? (Number(a?.qty) || 0),
      purchase_unit: String(a?.purchase_unit || a?.unit || '').trim(),
      pack_factor: Number(a?.pack_factor) || 1,
    };
    const o = b as { hint?: HintStyle; meta?: PackMeta } | undefined;
    hint = o?.hint ?? 'recipe';
    meta = o?.meta;
  }
  const converts = d.pack_factor > 1;
  const primaryValue = converts ? d.qty_purchase : Number(d.qty) || 0;
  const primaryUnit = d.purchase_unit || d.unit;
  const out: QtyDisplay = {
    primary: `${fmtQtyNum(primaryValue)} ${primaryUnit}`.trim(),
    primaryUnit,
    primaryValue,
    hint: null,
    basis: converts || d.purchase_unit === d.unit || !d.unit ? 'purchase' : 'purchase',
  };
  // Honest fallback: no pack meta AND no conversion means we cannot know the
  // purchase basis — say recipe rather than lie.
  if (!converts && d.purchase_unit === d.unit && d.pack_factor === 1 && !d.purchase_unit) out.basis = 'recipe';
  if (hint === 'none' || !converts) return out;
  if (hint === 'breakdown' && meta) {
    const br = fmtBreakdown(d.qty, meta);
    if (br) { out.hint = br; return out; }
  }
  out.hint = `= ${fmtQtyNum(d.qty)} ${d.unit}`.trim();
  return out;
}
