/**
 * Food-Costing Workbook parser — handles the "AKAN Food Costing" workbook
 * (Purchase Rates / Sub-Recipe Cards / Recipe Cost Cards / Recipe Summary).
 *
 * Pure function; no DB or fs deps so it runs on both the server (Next API route)
 * and the CLI script. Pass the loaded `xlsx` module + workbook in.
 *
 * Workbook layout facts the parser relies on (verified against the real file):
 *  - "Purchase Rates":  header at row index 2, data rows 3+. Columns:
 *       [#, Ingredient, Category, Purchase Unit, Avg Rate (₹), Base Unit, Cost / Base Unit (₹)]
 *     "Cost / Base Unit" is already ₹ per base unit (g/ml/pc) → average_price, pack_size = 1.
 *  - "Sub-Recipe Cards" / "Recipe Cost Cards": block format. A block starts with a
 *     single col-0 cell like:
 *       "S1   Teriyaki sauce        ·        source: Asian Subs        ·        batch yield 3683 g"
 *       "R1   MANCHOW SOUP VEG / NONVEG        ·        yield 220 g"
 *     (separators are the middot "·"). The next row is the column header
 *     [Ingredient, Qty, Base Unit, Line Cost (₹)]; ingredient rows follow until the
 *     next block header. A recipe line whose Base Unit is "sub" is a SUB-RECIPE
 *     reference (qty in grams); base units "—"/"?" are the workbook's ₹0 "no cost"
 *     placeholder lines (salt to taste, stock water) and are skipped.
 *  - "Recipe Summary": header at row index 4; target food-cost % lives in cell B3
 *       [#, Recipe, Source, Yield (g), Food Cost (₹), Menu Price @ Target, Your Menu Price (₹), Actual FC %]
 *  - "Review — Unmatched": names the workbook itself could not map (informational).
 */

import type * as XLSX from 'xlsx';

export interface ParsedWBMaterial {
  name: string;
  category: string;
  purchaseUnit: string;
  baseUnit: string;              // 'g' | 'ml' | 'pcs'
  avgRatePerBaseUnit: number;    // ₹ per base unit (already normalized in the sheet)
}

export interface ParsedWBSubLine {
  ingredientName: string;
  qty: number;
  baseUnit: string;
  lineCost: number;
}

export interface ParsedWBSubRecipe {
  code: string;                  // "S1"
  name: string;
  source: string;                // category, e.g. "Asian Subs"
  batchYieldG: number;
  lines: ParsedWBSubLine[];      // costable raw-material lines only (g/ml/pcs)
  subRefLines: string[];         // names of sub-in-sub refs (cannot be modeled → reported)
  workbookBatchCost: number;     // from the "TOTAL BATCH COST →" footer (validation)
  noCostSkipped: number;         // "(no cost)" / placeholder lines skipped
}

export interface ParsedWBRecipeLine {
  name: string;                  // ingredient OR sub-recipe name
  qty: number;
  baseUnit: string;
  lineCost: number;
  isSubRef: boolean;             // baseUnit === 'sub'
}

export interface ParsedWBRecipe {
  code: string;                  // "R1"
  name: string;
  yieldQty: number;
  yieldUnit: string;             // 'g'
  lines: ParsedWBRecipeLine[];   // costable lines: raw ingredients (g/ml/pcs) + sub-refs
  workbookFoodCost: number;      // from the "TOTAL FOOD COST →" footer (validation)
  noCostSkipped: number;         // "(no cost)" / placeholder lines skipped
}

export interface ParsedWBSummaryRow {
  recipe: string;
  source: string;
  yieldG: number;
  foodCost: number;
  menuPriceAtTarget: number;
  yourMenuPrice: number;
}

export interface ParsedRecipeWorkbook {
  targetFoodCostPct: number | null;
  materials: ParsedWBMaterial[];
  subRecipes: ParsedWBSubRecipe[];
  recipes: ParsedWBRecipe[];
  summary: ParsedWBSummaryRow[];
  unmatchedReported: string[];
}

/** Case/space/punctuation-tolerant key for matching ingredient strings → material names. */
export function normName(s: any): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Stricter key: also strips punctuation & bracketed sizes for the fuzzy fallback. */
function normLoose(s: any): string {
  return normName(s)
    .replace(/[().,/\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const num = (v: any): number => {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : 0;
};

/** Normalize a workbook base unit (g/ml/pc/...) to the app's canonical units.
 *  kg→g and L→ml normalize the UNIT here; the quantity is scaled separately by
 *  baseQtyFactor() so the amount lands in the canonical base unit. */
function normBaseUnit(u: any): string {
  const s = String(u ?? '').trim().toLowerCase();
  if (s === 'pc' || s === 'pcs' || s === 'pce' || s === 'no' || s === 'nos') return 'pcs';
  if (s === 'ml' || s === 'l' || s === 'ltr') return 'ml';
  if (s === 'g' || s === 'gm' || s === 'gms' || s === 'kg') return 'g';
  return s;
}

/** Multiplier to convert a workbook quantity into the canonical base unit:
 *  kg→g and L/LTR→ml are ×1000; everything else ×1. Without this an ingredient
 *  listed in kg or L is costed 1000× too low. */
function baseQtyFactor(u: any): number {
  const s = String(u ?? '').trim().toLowerCase();
  return (s === 'kg' || s === 'l' || s === 'ltr') ? 1000 : 1;
}

const sheetRows = (xlsx: typeof XLSX, wb: XLSX.WorkBook, name: string): any[][] => {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return xlsx.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) as any[][];
};

const isBlockHeader = (cell: any): boolean => /^[SR]\d+\b/.test(String(cell ?? '').trim());

/** A line carries real cost only if its base unit is a known raw unit. */
const isCostableRaw = (baseUnit: string): boolean => baseUnit === 'g' || baseUnit === 'ml' || baseUnit === 'pcs';

/** The card footer row, e.g. "TOTAL FOOD COST →" / "TOTAL BATCH COST →". */
const isTotalFooter = (name: string): boolean => /^total\s+(food|batch)\s+cost/i.test(name);

/** Explicit zero-cost markers in the workbook (salt to taste, stock water, etc.). */
const isNoCostName = (name: string): boolean => /\(no cost\)|to taste/i.test(name);

/** Split a block-header string on the middot separator into trimmed parts. */
function headerParts(cell: any): string[] {
  return String(cell ?? '')
    .split('·')               // "·"
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// ──────────────────────────── Purchase Rates ────────────────────────────
function parseMaterials(rows: any[][]): ParsedWBMaterial[] {
  const out: ParsedWBMaterial[] = [];
  // Header is at index 2; data starts at 3. Be tolerant if it shifts.
  let start = 3;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    if (String(rows[i]?.[1] ?? '').trim().toLowerCase() === 'ingredient') { start = i + 1; break; }
  }
  for (let i = start; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = String(r[1] ?? '').trim();
    if (!name) continue;
    out.push({
      name,
      category: String(r[2] ?? '').trim(),
      purchaseUnit: String(r[3] ?? '').trim(),
      baseUnit: normBaseUnit(r[5]),
      avgRatePerBaseUnit: num(r[6]),
    });
  }
  return out;
}

// ──────────────────────────── Card blocks ────────────────────────────
/** Generic block walker shared by sub-recipe and recipe cards. */
function walkBlocks(rows: any[][]): { code: string; header: string; lines: any[][] }[] {
  const blocks: { code: string; header: string; lines: any[][] }[] = [];
  let cur: { code: string; header: string; lines: any[][] } | null = null;
  for (const r of rows) {
    const c0 = String(r?.[0] ?? '').trim();
    if (isBlockHeader(c0)) {
      cur = { code: c0.match(/^[SR]\d+/)![0], header: c0, lines: [] };
      blocks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!c0) continue;                                  // blank spacer row
    if (c0.toLowerCase() === 'ingredient') continue;    // per-block column header
    cur.lines.push(r);
  }
  return blocks;
}

function parseSubRecipes(rows: any[][]): ParsedWBSubRecipe[] {
  return walkBlocks(rows).map((b) => {
    const parts = headerParts(b.header);
    const name = (parts[0] || '').replace(/^S\d+\s*/, '').trim();
    const sourcePart = parts.find((p) => /^source\s*:/i.test(p)) || '';
    const source = sourcePart.replace(/^source\s*:/i, '').trim();
    const yieldPart = parts.find((p) => /batch yield/i.test(p)) || '';
    const batchYieldG = num((yieldPart.match(/batch yield\s+([\d.]+)/i) || [])[1]);

    const lines: ParsedWBSubLine[] = [];
    const subRefLines: string[] = [];
    let workbookBatchCost = 0;
    let noCostSkipped = 0;
    for (const r of b.lines) {
      const ingredientName = String(r[0] ?? '').trim();
      if (!ingredientName) continue;
      const rawUnit = String(r[2] ?? '').trim().toLowerCase();
      if (isTotalFooter(ingredientName)) { workbookBatchCost = num(r[3]); continue; }
      if (isNoCostName(ingredientName)) { noCostSkipped++; continue; }          // salt to taste / stock water
      if (rawUnit === 'sub') { subRefLines.push(ingredientName); continue; }   // sub-in-sub: not modelable
      const baseUnit = normBaseUnit(rawUnit);
      if (!isCostableRaw(baseUnit)) { noCostSkipped++; continue; }              // "?" / blank placeholders
      lines.push({ ingredientName, qty: num(r[1]) * baseQtyFactor(rawUnit), baseUnit, lineCost: num(r[3]) });
    }
    return { code: b.code, name, source, batchYieldG, lines, subRefLines, workbookBatchCost, noCostSkipped };
  }).filter((s) => s.name);
}

function parseRecipes(rows: any[][]): ParsedWBRecipe[] {
  return walkBlocks(rows).map((b) => {
    const parts = headerParts(b.header);
    const name = (parts[0] || '').replace(/^R\d+\s*/, '').trim();
    const yieldPart = parts.find((p) => /yield/i.test(p)) || '';
    const yieldQty = num((yieldPart.match(/yield\s+([\d.]+)/i) || [])[1]);

    const lines: ParsedWBRecipeLine[] = [];
    let workbookFoodCost = 0;
    let noCostSkipped = 0;
    for (const r of b.lines) {
      const lineName = String(r[0] ?? '').trim();
      if (!lineName) continue;
      const rawUnit = String(r[2] ?? '').trim().toLowerCase();
      if (isTotalFooter(lineName)) { workbookFoodCost = num(r[3]); continue; }
      if (isNoCostName(lineName)) { noCostSkipped++; continue; }                // salt to taste / stock water
      const isSubRef = rawUnit === 'sub';
      const baseUnit = isSubRef ? 'sub' : normBaseUnit(rawUnit);
      if (!isSubRef && !isCostableRaw(baseUnit)) { noCostSkipped++; continue; } // "?" / blank placeholders
      lines.push({ name: lineName, qty: num(r[1]) * baseQtyFactor(rawUnit), baseUnit, lineCost: num(r[3]), isSubRef });
    }
    return { code: b.code, name, yieldQty, yieldUnit: 'g', lines, workbookFoodCost, noCostSkipped };
  }).filter((r) => r.name);
}

// ──────────────────────────── Recipe Summary ────────────────────────────
function parseSummary(rows: any[][]): { rows: ParsedWBSummaryRow[]; targetPct: number | null } {
  // B3 (row index 2, col index 1) holds the target food-cost %.
  let targetPct: number | null = null;
  for (let i = 0; i < Math.min(6, rows.length); i++) {
    if (/target food cost/i.test(String(rows[i]?.[0] ?? ''))) {
      const v = num(rows[i]?.[1]);
      if (v > 0) targetPct = v > 1 ? v / 100 : v;   // accept 0.3 or 30
      break;
    }
  }
  // Header at index 4; data after.
  let start = 5;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    if (String(rows[i]?.[1] ?? '').trim().toLowerCase() === 'recipe') { start = i + 1; break; }
  }
  const out: ParsedWBSummaryRow[] = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i] || [];
    const recipe = String(r[1] ?? '').trim();
    if (!recipe) continue;
    out.push({
      recipe,
      source: String(r[2] ?? '').trim(),
      yieldG: num(r[3]),
      foodCost: num(r[4]),
      menuPriceAtTarget: num(r[5]),
      yourMenuPrice: num(r[6]),
    });
  }
  return { rows: out, targetPct };
}

// ──────────────────────────── Review — Unmatched ────────────────────────────
function parseUnmatched(rows: any[][]): string[] {
  const out: string[] = [];
  let start = 3;
  for (let i = 0; i < Math.min(8, rows.length); i++) {
    if (String(rows[i]?.[0] ?? '').trim().toLowerCase() === 'ingredient') { start = i + 1; break; }
  }
  for (let i = start; i < rows.length; i++) {
    const name = String(rows[i]?.[0] ?? '').trim();
    if (name) out.push(name);
  }
  return out;
}

// ──────────────────────────── Category inference ────────────────────────────
/**
 * Infer a menu category from a recipe name. The workbook carries no usable
 * recipe category ("Source" is "Docx" for every row), so we classify by keyword.
 * Rules are ORDERED — the first match wins, so dominant categories (a tikka-pasta
 * is Pasta, a tikka-pulao is Rice) are listed before the generic Tandoor rule.
 * Heuristic by design; users can correct any recipe in the editor.
 */
const CATEGORY_RULES: { category: string; test: RegExp }[] = [
  { category: 'Soups',           test: /\bsoup|shorba|tomyum\b/i },
  { category: 'Salads',          test: /\bsalad\b/i },
  { category: 'Sushi & Rolls',   test: /sushi|uramaki|\bmaki\b|california roll|cold roll/i },
  { category: 'Pizza',           test: /pizza|\bnsp\b|marghe?rita|margharita/i },
  { category: 'Pasta & Noodles', test: /pasta|penne|aglio olio|alfredo|arr?abiata|lasagne|fettucc?h?ini|spaghetti|noo?dd?les?/i },
  { category: 'Rice & Biryani',  test: /biryani|pulao|pul:ao|fried rice|\brice\b|nasi goreng|annam|pappu/i },
  { category: 'Dimsum & Bao',    test: /dimsum|\bbao\b|dumpling/i },
  { category: 'Tandoor & Grills', test: /tikka|kebab|tandoori|\bgrill|sh?eekh|skewer|taouk|shish|galouti|\bsteak\b|tikki|\btill\b/i },
  { category: 'Curries & Mains', test: /\bcurry|masala|makhani|rogan|iguru|pulusu|kofta|\bdal\b|tadka|butter chicken|stroganoff|khadai|kadai|chaman|tarkari/i },
];

export function categorizeRecipeName(name: string): string {
  const n = String(name || '');
  for (const r of CATEGORY_RULES) if (r.test.test(n)) return r.category;
  return 'Starters';   // sensible default for the remaining small-plates / appetizers
}

// ──────────────────────────── Public API ────────────────────────────
export function parseRecipeWorkbook(xlsx: typeof XLSX, wb: XLSX.WorkBook): ParsedRecipeWorkbook {
  const materials = parseMaterials(sheetRows(xlsx, wb, 'Purchase Rates'));
  const subRecipes = parseSubRecipes(sheetRows(xlsx, wb, 'Sub-Recipe Cards'));
  const recipes = parseRecipes(sheetRows(xlsx, wb, 'Recipe Cost Cards'));
  const { rows: summary, targetPct } = parseSummary(sheetRows(xlsx, wb, 'Recipe Summary'));
  const unmatchedReported = parseUnmatched(sheetRows(xlsx, wb, 'Review — Unmatched'));
  return { targetFoodCostPct: targetPct, materials, subRecipes, recipes, summary, unmatchedReported };
}

export interface MaterialMatch { id: string; name: string; }

/**
 * Build a name→id resolver over a set of materials. Resolution order:
 * exact normName → loose (punctuation-stripped) → token-subset. Shared by the
 * preview (matchMaterials) and the commit (which resolves against DB + newly
 * created materials).
 */
export function buildMaterialResolver(materials: MaterialMatch[]): (raw: string) => string | null {
  const byExact = new Map<string, string>();
  const byLoose = new Map<string, string>();
  const tokenIndex: { id: string; tokens: Set<string> }[] = [];
  for (const m of materials) {
    byExact.set(normName(m.name), m.id);
    if (!byLoose.has(normLoose(m.name))) byLoose.set(normLoose(m.name), m.id);
    tokenIndex.push({ id: m.id, tokens: new Set(normLoose(m.name).split(' ').filter(Boolean)) });
  }
  return (raw: string): string | null => {
    const exact = byExact.get(normName(raw));
    if (exact) return exact;
    const loose = byLoose.get(normLoose(raw));
    if (loose) return loose;
    const q = normLoose(raw).split(' ').filter(Boolean);
    if (q.length >= 2) {
      for (const t of tokenIndex) {
        if (q.every((tok) => t.tokens.has(tok))) return t.id;
      }
    }
    return null;
  };
}

/**
 * Resolve every ingredient name referenced in the parsed workbook to an existing
 * raw_material. Returns a name→id map (keyed by normName) and the de-duplicated
 * list of names that could not be resolved.
 */
export function matchMaterials(
  parsed: ParsedRecipeWorkbook,
  existingMaterials: MaterialMatch[],
): { matched: Map<string, string>; unmatched: string[] } {
  const resolve = buildMaterialResolver(existingMaterials);
  const matched = new Map<string, string>();
  const unmatched = new Set<string>();

  const consider = (rawName: string) => {
    const key = normName(rawName);
    if (!key || matched.has(key)) return;
    const id = resolve(rawName);
    if (id) matched.set(key, id);
    else unmatched.add(rawName);
  };

  // Workbook's own purchase rates establish the material universe to add; but for
  // matching we only care about names referenced by sub-recipes & recipes.
  for (const s of parsed.subRecipes) for (const l of s.lines) consider(l.ingredientName);
  for (const r of parsed.recipes) for (const l of r.lines) if (!l.isSubRef) consider(l.name);

  return { matched, unmatched: [...unmatched] };
}
