/**
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
