import { getDb } from '@/lib/db';
import { writeDirectItemLink } from './_lib/link-writer';
import {
  loadMaterialIndex, loadMenuIndex, resolveMenuItems, nameKey,
  type MaterialRef, type MenuItemRef,
} from './_lib/mapping-rows';

/**
 * Discover "direct-sold items" — menu items sold as-is from a purchased raw material
 * (bottled beer, bottled water, cold drinks, liquor pegs from a bottle, etc.).
 *
 * Strategy:
 *   1. Aggregate sales by item_name.
 *   2. Parse "… NNN ML" / "… NNN ML BTL" from the item name → perUnitMl.
 *   3. Match each sold item to a raw_material by:
 *        - exact (case-insensitive) name match, OR
 *        - longest common token match (preferring raw materials with non-zero purchases & avg price).
 *   4. Compute expected stock + leakage:
 *        leakage_qty   = purchased_qty - sold_qty_converted
 *        leakage_value = leakage_qty × avg_cost (if negative: shortage, POSITIVE leakage)
 *
 * Query params:
 *   min_sold   — only include items with at least N sold units (default 5)
 *   limit      — default 200
 *   only_unmatched — "1" to only show items without a match
 */

type Mat = {
  purchase_unit?: string | null;
  pack_size?: number | null;
  id: string;
  name: string;
  unit: string;
  current_stock: number;
  average_price: number;
  purchased_qty: number;
  purchase_count: number;
};

// Generic qualifier tokens that shouldn't anchor a match by themselves
const GENERIC_TOKENS = new Set([
  'fresh','classic','premium','special','happy','hrs','hr','offer','draft','draught',
  'mix','mixed','veg','nonveg','non','house','single','double','triple','full','half',
  'small','large','mini','jumbo','staff','local','indian','chinese','continental',
  'master','serving','portion','piece','pieces','kg','lt','ltr','g','gm','gms','ml',
  'paper','empty','plain','new','old','1','2','3','4','5','10','20','30','60','90',
  'bo','br','pb','can','cans','tin','tins','btl','bottle','pc','pcs',
]);

// Strip common stop-tokens and pack suffixes to produce a comparable token set
function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[()\[\]{}]/g, ' ')
    .replace(/[-–—_/]+/g, ' ')
    // Drop volume/quantity tokens (they'll be matched separately via perUnitMl)
    .replace(/\d+\s*ml\b/g, ' ')
    .replace(/\d+\s*ltr\b/g, ' ')
    .replace(/\d+\s*l\b/g, ' ')
    .replace(/\d+\s*gm\b/g, ' ')
    .replace(/\d+\s*g\b/g, ' ')
    .replace(/\d+\s*kg\b/g, ' ')
    .replace(/\bbtl\b/g, ' ')
    .replace(/\bbottle\b/g, ' ')
    .replace(/\bcan\b/g, ' ')
    .replace(/\btin\b/g, ' ')
    .replace(/\bpc\b/g, ' ')
    .replace(/\bpcs\b/g, ' ')
    .replace(/\boffer\b/g, ' ')
    .replace(/\bbucket\s*of\s*\d+\b/g, ' ')
    .replace(/\bhappy\s*hrs?\b/g, ' ')
    .replace(/\bipl\b/g, ' ')
    .replace(/\bpb\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t.length >= 2);
}

// Return "anchor" tokens — tokens that carry identity (exclude generic qualifiers)
function anchorTokens(toks: string[]): string[] {
  return toks.filter(t => !GENERIC_TOKENS.has(t));
}

// Extract per-unit ml if present (e.g. "330 ML", "30ml", "1 LTR")
function parsePerUnitMl(name: string): number | null {
  const s = name.toUpperCase();
  const mMl = s.match(/(\d+(?:\.\d+)?)\s*ML\b/);
  if (mMl) return parseFloat(mMl[1]);
  const mLtr = s.match(/(\d+(?:\.\d+)?)\s*(?:LTR|LITRE|LITER|L)\b/);
  if (mLtr) return parseFloat(mLtr[1]) * 1000;
  return null;
}

// Score how well two names overlap — Jaccard over tokens
function scoreMatch(saleTokens: string[], matTokens: string[]): number {
  if (saleTokens.length === 0 || matTokens.length === 0) return 0;
  const sSet = new Set(saleTokens);
  const mSet = new Set(matTokens);
  let common = 0;
  for (const t of sSet) if (mSet.has(t)) common++;
  const union = sSet.size + mSet.size - common;
  return union === 0 ? 0 : common / union;
}

// Categories that represent items sold AS-IS from a purchased material —
// beer pulled from a bottle, peg poured from a whisky bottle, soft drink
// poured from a can. Anything cooked (small plates, mains, breads, sushi)
// is NOT a direct item — those go through recipes. Match is substring,
// case-insensitive, on the sales.category text.
// Bar items — anything alcoholic, served from the Akan Bar department.
const BAR_PATTERNS = [
  'beer', 'wine', 'champagne', 'whisk', 'vodka', 'gin', 'rum', 'tequila',
  'cocktail', 'liqueur', 'bar', 'scotch', 'spirit', 'crush', 'liquor',
  'brandy', 'shooter', 'bitter', 'aperitif', 'sake',
];
// Beverages — non-alcoholic items poured AS-IS from packaged stock.
const BEVERAGE_PATTERNS = [
  'mocktail', 'soft beverage', 'soft-beverage', 'soft drink', 'soft-drink',
  'beverage', 'juice', 'water', 'soda', 'tonic',
];
function deriveDepartment(category: string | null | undefined): 'Bar' | 'Beverages' | null {
  const c = String(category || '').toLowerCase();
  if (!c) return null;
  if (BAR_PATTERNS.some(p => c.includes(p)))      return 'Bar';
  if (BEVERAGE_PATTERNS.some(p => c.includes(p))) return 'Beverages';
  return null;   // anything else (cooked dishes etc.) gets filtered out
}

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const minSold = Number(url.searchParams.get('min_sold') || 5);
    const limit = Math.min(Number(url.searchParams.get('limit') || 200), 500);
    const onlyUnmatched = url.searchParams.get('only_unmatched') === '1';
    const includeDismissed = url.searchParams.get('include_dismissed') === '1';

    // Aggregate sales by item_name — include any existing menu_items.material_id link
    const salesAgg = db.prepare(`
      SELECT s.item_name,
             SUM(s.quantity_sold)                            AS qty_sold,
             SUM(s.total_revenue)                            AS revenue,
             SUM(CASE WHEN s.bill_type != 'normal' THEN s.quantity_sold ELSE 0 END) AS nc_qty,
             SUM(CASE WHEN s.bill_type != 'normal' THEN s.total_cost    ELSE 0 END) AS nc_cost,
             COUNT(*)                                        AS line_count,
             MAX(s.category)                                 AS category,
             COALESCE(dil.material_id, MAX(mi.material_id), MAX(mi_pos.material_id))          AS linked_material_id,
             COALESCE(dil.reviewed,    MAX(mi.direct_reviewed), MAX(mi_pos.direct_reviewed), 0) AS reviewed,
             COALESCE(dil.qty_per_unit, 1)                                                     AS qty_per_unit,
             COALESCE(dil.dismissed, 0)                                                        AS dismissed,
             MAX(s.pos_item_id)                                                                AS pos_item_id
      FROM sales s
      LEFT JOIN direct_item_links dil ON dil.item_name = s.item_name COLLATE NOCASE
      LEFT JOIN menu_items mi ON LOWER(mi.name) = LOWER(s.item_name)
      -- Strongest signal: same POS item id (stable across name changes)
      LEFT JOIN menu_items mi_pos ON mi_pos.pos_id = s.pos_item_id AND s.pos_item_id IS NOT NULL AND s.pos_item_id != ''
      WHERE s.item_name IS NOT NULL AND TRIM(s.item_name) != '' AND TRIM(s.item_name) != '-'
      GROUP BY s.item_name
      HAVING SUM(s.quantity_sold) >= ?
      ORDER BY SUM(s.quantity_sold) DESC
    `).all(minSold) as any[];

    // Keep ONLY items whose POS category maps to Bar or Beverages. Direct
    // items by definition are sold AS-IS from a purchased material — beer
    // bottles, whisky pegs, soft drinks. Cooked dishes belong on /recipes.
    // Annotate each row with its derived department for grouping in the UI.
    const filteredSalesAgg = salesAgg
      .map(s => ({ ...s, department: deriveDepartment(s.category) }))
      .filter(s => s.department !== null)
      // Drop dismissed rows unless caller explicitly asks for them
      .filter(s => includeDismissed || !s.dismissed);

    // Pre-aggregate material data
    const materials = db.prepare(`
      SELECT rm.id, rm.name, rm.unit, rm.current_stock, rm.average_price,
             rm.purchase_unit, COALESCE(rm.pack_size, 1) AS pack_size,
             COALESCE(SUM(p.quantity), 0)  AS purchased_qty,
             COUNT(p.id)                   AS purchase_count
      FROM raw_materials rm
      LEFT JOIN purchases p ON p.material_id = rm.id
      GROUP BY rm.id
    `).all() as Mat[];

    // Pre-tokenize materials (only keep those with purchases — direct items are by definition purchased)
    const matTokens: Array<{ mat: Mat; toks: string[]; perUnitMl: number | null }> = materials
      .filter(m => m.purchase_count > 0)
      .map(m => ({ mat: m, toks: tokens(m.name), perUnitMl: parsePerUnitMl(m.name) }));

    // For each sale item, pick best matching material
    const results: any[] = [];
    for (const s of filteredSalesAgg) {
      const soldName: string = s.item_name;
      const soldToks = tokens(soldName);
      const soldPerUnitMl = parsePerUnitMl(soldName);

      // Exact match wins
      const nameKey = soldName.toLowerCase().trim();
      let best = matTokens.find(m => m.mat.name.toLowerCase().trim() === nameKey) || null;
      let bestScore = best ? 1 : 0;

      if (!best) {
        const soldAnchors = anchorTokens(soldToks);
        // An anchor word must match for a candidate to be considered
        if (soldAnchors.length === 0) {
          // Nothing to anchor on — skip
          results.push({
            item_name: soldName, category: s.category,
            qty_sold: s.qty_sold, revenue: s.revenue, line_count: s.line_count,
            nc_qty: s.nc_qty, nc_cost: s.nc_cost,
            matched: null, match_score: 0, reason: 'no-anchor-tokens',
            sold_per_unit_ml: soldPerUnitMl,
            finalized: false,
            linked_material_id: s.linked_material_id, department: s.department,
            reviewed: !!s.reviewed,
          });
          continue;
        }

        for (const m of matTokens) {
          const matAnchors = anchorTokens(m.toks);
          const matAnchorSet = new Set(matAnchors);
          const anchorsInCommon = soldAnchors.filter(t => matAnchorSet.has(t)).length;
          if (anchorsInCommon === 0) continue;  // require ≥1 non-generic shared token

          let score = scoreMatch(soldToks, m.toks);
          // Boost when multiple anchors align
          score += Math.min(anchorsInCommon - 1, 3) * 0.15;

          // Volume compatibility bonus/penalty
          if (soldPerUnitMl && m.perUnitMl) {
            if (soldPerUnitMl === m.perUnitMl) score += 0.25;        // same pack → strong signal
            else if (m.mat.unit === 'ml' || m.mat.unit === 'l') {
              // Could be peg from bigger bottle — small penalty only
              score -= 0.05;
            }
          } else if (!soldPerUnitMl && m.perUnitMl && (m.mat.unit === 'ml' || m.mat.unit === 'l')) {
            // Sold name has no volume — could still be ok (e.g. "CORONA" → "CORONA (330ML)")
            // Neutral — rely on anchor + score.
          }

          // Require first anchor of sold name to also appear in material anchors (avoids Fresh Lime→Mushroom)
          const soldFirst = soldAnchors[0];
          if (!matAnchorSet.has(soldFirst)) score -= 0.2;

          if (score > bestScore) { bestScore = score; best = m; }
        }
      }

      const isGoodMatch = best !== null && bestScore >= 0.5;
      if (onlyUnmatched && isGoodMatch) continue;
      if (!isGoodMatch) {
        results.push({
          item_name: soldName, category: s.category,
          qty_sold: s.qty_sold, revenue: s.revenue, line_count: s.line_count,
          nc_qty: s.nc_qty, nc_cost: s.nc_cost,
          matched: null, match_score: bestScore,
          sold_per_unit_ml: soldPerUnitMl,
          finalized: false,
          linked_material_id: s.linked_material_id, department: s.department,
          reviewed: !!s.reviewed,
          qty_per_unit: Number(s.qty_per_unit) || 1,
        });
        continue;
      }

      // Compute sold quantity in raw-material units.
      // Rules:
      //   material unit != ml/l        → 1:1 unless qty_per_unit override is set
      //                                  (e.g. "bucket of 4" → qty_per_unit=4)
      //   material unit == ml/l, sold name has "NNN ML" → use that × qty_per_unit
      //   material unit == ml/l, no volume in sold name → use material's own perUnitMl (pack) × qty_per_unit
      //   material unit == ml/l, no perUnitMl either → default 30ml (liquor peg assumption) × qty_per_unit
      const qtyPerUnit = Number(s.qty_per_unit) > 0 ? Number(s.qty_per_unit) : 1;
      let soldInMatUnit = s.qty_sold * qtyPerUnit;
      let conversionNote = qtyPerUnit !== 1 ? `1 sold = ${qtyPerUnit} ${best?.mat.unit || ''}` : '1:1';
      let perUnitMl: number | null = null;
      if (best && (best.mat.unit === 'ml' || best.mat.unit === 'l')) {
        perUnitMl = soldPerUnitMl || best.perUnitMl || 30;
        // Convert to material unit (ml if l, treat l×1000)
        const matMlFactor = best.mat.unit === 'l' ? 1 / 1000 : 1;
        soldInMatUnit = s.qty_sold * qtyPerUnit * perUnitMl * matMlFactor;
        conversionNote = qtyPerUnit !== 1
          ? `1 sold = ${qtyPerUnit} × ${perUnitMl} ml`
          : (soldPerUnitMl
              ? `1 sold = ${soldPerUnitMl} ml`
              : best.perUnitMl
                ? `1 sold = ${best.perUnitMl} ml (from pack)`
                : `assumed 30 ml/peg`);
      }

      // purchases.quantity is PURCHASE units (canon); everything below —
      // soldInMatUnit, current_stock, avgCost (₹/recipe-unit) — is RECIPE basis.
      // Subtracting bottles from ml understated purchases pack_size× and turned
      // the leakage/purchase-error verdicts into noise for packed materials.
      const _pm = best?.mat;
      const _pf = _pm && Number(_pm.pack_size) > 1
        && String(_pm.unit || '').toLowerCase().trim()
           !== String(_pm.purchase_unit || _pm.unit || '').toLowerCase().trim()
        ? Number(_pm.pack_size) : 1;
      const purchasedQty = (_pm?.purchased_qty ?? 0) * _pf;
      const currentStock = best?.mat.current_stock ?? 0;
      const avgCost = best?.mat.average_price ?? 0;

      // Diff = sold - purchased  (in raw-material units)
      //   diff < 0  → LEAKAGE (purchased more than sold; bottles missing) → shown −X RED
      //              (e.g. JAMESON 5400 purchased − 1691 sold ⇒ diff -3709)
      //   diff > 0  → PURCHASE ERROR (sold more than purchased; missing inwards) → +X AMBER
      //   diff ≈ 0  → reconciled
      // Sign convention reflects P&L intuition: leakage = loss = negative.
      // Stock is intentionally NOT used here because direct-item stock isn't auto-deducted
      // on sale yet — using it would make the diff always equal to -sold which is misleading.
      const diffQty   = soldInMatUnit - purchasedQty;
      const diffValue = diffQty * avgCost;
      const status    =
        Math.abs(diffQty) < 0.5 ? 'reconciled' :
        diffQty < 0             ? 'leakage' :         // purchased > sold → negative diff → red
                                  'purchase_error';   // sold > purchased → positive diff → amber

      // Convert into sold-unit (bottles/pegs) for an intuitive display.
      const matUnitsPerSold     = s.qty_sold > 0 ? soldInMatUnit / s.qty_sold : 1;
      const purchasedInSoldUnit = matUnitsPerSold > 0 ? purchasedQty / matUnitsPerSold : purchasedQty;
      const stockInSoldUnit     = matUnitsPerSold > 0 ? currentStock / matUnitsPerSold : currentStock;
      // diff_in_sold_unit = sold_in_sold_unit − purchased_in_sold_unit (same sign as diffQty)
      const diffInSoldUnit      = matUnitsPerSold > 0 ? diffQty      / matUnitsPerSold : diffQty;
      const soldUnitLabel       = (best?.mat.unit === 'ml' || best?.mat.unit === 'l') ? 'bottles/pegs' : best?.mat.unit || 'units';

      const finalized = !!s.linked_material_id && best?.mat.id === s.linked_material_id;

      results.push({
        item_name: soldName,
        category: s.category,
        qty_sold: s.qty_sold,
        revenue: s.revenue,
        line_count: s.line_count,
        nc_qty: s.nc_qty,
        nc_cost: s.nc_cost,
        sold_per_unit_ml: soldPerUnitMl,
        matched: best ? {
          material_id: best.mat.id,
          material_name: best.mat.name,
          unit: best.mat.unit,
          per_unit_ml: best.perUnitMl,
          avg_price: avgCost,
          current_stock: best.mat.current_stock,
          purchased_qty: purchasedQty,
          purchase_count: best.mat.purchase_count,
          score: Math.round(bestScore * 100) / 100,
        } : null,
        sold_in_mat_unit: Math.round(soldInMatUnit * 100) / 100,
        conversion_note: conversionNote,

        // Diff-based reconciliation
        diff_qty:    Math.round(diffQty * 100) / 100,
        diff_value:  Math.round(diffValue * 100) / 100,
        status,                                     // 'leakage' | 'purchase_error' | 'reconciled'

        // Backwards-compat fields (kept for any client that still reads them)
        leakage_qty: Math.round(diffQty * 100) / 100,
        leakage_value: Math.round(diffValue * 100) / 100,

        // Same-unit values — for direct apples-to-apples comparison
        purchased_in_sold_unit: Math.round(purchasedInSoldUnit * 100) / 100,
        stock_in_sold_unit:     Math.round(stockInSoldUnit * 100) / 100,
        diff_in_sold_unit:      Math.round(diffInSoldUnit * 100) / 100,
        leakage_in_sold_unit:   Math.round(diffInSoldUnit * 100) / 100,   // alias
        sold_unit_label:        soldUnitLabel,

        finalized,
        linked_material_id: s.linked_material_id, department: s.department,
        reviewed: !!s.reviewed,
        qty_per_unit: qtyPerUnit,
      });

      if (results.length >= limit) break;
    }

    // ── Manually-added direct items ───────────────────────────────────────
    // A direct_item_links row linked to a material but with NO sales yet won't
    // have come through the sales loop above (which starts FROM sales). Surface
    // those as finalized rows so a user who pre-registers a direct item (before
    // it's ever sold) can actually see what they added.
    {
      const seen = new Set(results.map(r => String(r.item_name).toLowerCase().trim()));
      const matById = new Map(materials.map(m => [m.id, m]));
      const links = db.prepare(`
        SELECT item_name, material_id, COALESCE(dismissed, 0) AS dismissed
        FROM direct_item_links WHERE material_id IS NOT NULL
      `).all() as any[];
      for (const dl of links) {
        if (results.length >= limit) break;
        if (seen.has(String(dl.item_name).toLowerCase().trim())) continue;  // already shown via sales
        if (!includeDismissed && dl.dismissed) continue;
        const m = matById.get(dl.material_id);
        if (!m) continue;
        results.push({
          item_name: dl.item_name, category: null,
          qty_sold: 0, revenue: 0, line_count: 0, nc_qty: 0, nc_cost: 0,
          sold_per_unit_ml: null,
          matched: {
            material_id: m.id, material_name: m.name, unit: m.unit, per_unit_ml: null,
            avg_price: m.average_price || 0, current_stock: m.current_stock || 0,
            // Same recipe-basis normalisation as the sales-matched path above.
            purchased_qty: (m.purchased_qty || 0) * (Number(m.pack_size) > 1
              && String(m.unit || '').toLowerCase().trim()
                 !== String(m.purchase_unit || m.unit || '').toLowerCase().trim()
              ? Number(m.pack_size) : 1),
            purchase_count: m.purchase_count || 0, score: 1,
          },
          sold_in_mat_unit: 0, conversion_note: 'manual — no sales yet',
          diff_qty: 0, diff_value: 0, status: 'reconciled',
          leakage_qty: 0, leakage_value: 0,
          purchased_in_sold_unit: 0, stock_in_sold_unit: m.current_stock || 0,
          diff_in_sold_unit: 0, leakage_in_sold_unit: 0, sold_unit_label: m.unit || 'units',
          finalized: !dl.dismissed, linked_material_id: dl.material_id, department: 'Manual',
          reviewed: true, dismissed: !!dl.dismissed, qty_per_unit: 1, manual: true,
        });
      }
    }

    // ── EVERY SAVED MAPPING COMES BACK, whatever the sales say ──────────────
    //
    // The list above is built FROM sales and then narrowed twice: HAVING
    // qty_sold >= min_sold (5 by default) and "POS category must map to Bar or
    // Beverages". That is right for DISCOVERY — it answers "what am I selling
    // that still needs mapping?".
    //
    // It is wrong as the only source, because it silently swallowed the user's
    // own work. Measured on this database: of 415 saved links, 210 have no
    // sales rows at all, another 32 sold fewer than five, and more are dropped
    // by the category filter (Custom 46, Small Plates Non Veg 8, Party Package
    // 8, thin-crust-pizza 5…). Over half of everything ever mapped could not be
    // displayed back. From the counter's chair that reads as "it didn't save" —
    // which was the actual bug report.
    //
    // So anything in direct_item_links that the sales pass did not already
    // produce is appended here, flagged so the UI can say why it has no sales
    // figures. A saved mapping is data; it does not stop existing because the
    // item went out of season.
    const seen = new Set(results.map(r => String(r.item_name || '').toLowerCase().trim()));
    const matLookup = new Map(materials.map(m => [m.id, m]));
    const savedLinks = db.prepare(`
      SELECT d.item_name, d.material_id, d.qty_per_unit, d.dismissed, d.reviewed, d.updated_at
        FROM direct_item_links d
       ORDER BY d.item_name COLLATE NOCASE ASC
    `).all() as any[];

    for (const l of savedLinks) {
      const key = String(l.item_name || '').toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      if (!includeDismissed && l.dismissed) continue;
      const mat = l.material_id ? matLookup.get(l.material_id) : null;
      results.push({
        item_name: l.item_name,
        category: '',
        qty_sold: 0, revenue: 0, line_count: 0, nc_qty: 0, nc_cost: 0,
        matched: mat ? { id: mat.id, name: mat.name, unit: mat.unit } : null,
        match_score: l.material_id ? 1 : 0,
        reason: 'saved-mapping',
        sold_per_unit_ml: null,
        finalized: true,
        linked_material_id: l.material_id || null,
        department: null,
        reviewed: !!l.reviewed,
        qty_per_unit: Number(l.qty_per_unit) || 1,
        dismissed: !!l.dismissed,
        updated_at: l.updated_at,
        /** No sales in the window that built the list above — mapping only. */
        no_recent_sales: true,
      });
    }

    /* ── BOTH ENDS OF THE CHAIN, on every row ──────────────────────────────
     *
     * Owner's ask: "in Recipes Direct Items it should show mapping for raw
     * material items and menu items." A row is a sold ITEM NAME, and it has two
     * independent links — a RAW MATERIAL (what it costs) and one or more MENU
     * ITEMS (how the POS reaches it). Either can be missing, and a missing one
     * is the actionable state, so both are resolved here for every row rather
     * than only for the rows the sales pass happened to match.
     *
     * This is a separate pass on purpose. The three blocks above each build
     * rows in their own shape (and the saved-mapping block must stay exactly as
     * it is), so enriching them all in one place is the only way the screen can
     * be sure every row carries the same chain fields.
     *
     * Nothing here touches leakage, revenue or any total — it only adds link
     * information. The saved-mapping rows still carry zero money.
     */
    {
      const matIdx = loadMaterialIndex(db);
      const menuIdx = loadMenuIndex(db);
      // POS item id per sold name, for the strong menu-item match.
      const posByName = new Map<string, string>();
      for (const s of salesAgg) {
        const p = String(s.pos_item_id || '').trim();
        if (p) posByName.set(nameKey(s.item_name), p);
      }
      // Which rows have a real direct_item_links row (vs. a link inherited from
      // menu_items.material_id) — the owner needs to know where a link lives.
      const dilByName = new Map<string, string | null>();
      for (const l of db.prepare('SELECT item_name, material_id FROM direct_item_links').all() as any[]) {
        dilByName.set(nameKey(l.item_name), l.material_id || null);
      }

      /** Wire shape for the linked material — carries the pack meta so the page
       *  can lead with the PURCHASE unit via '@/lib/pack-units'. Quantities stay
       *  in the stored RECIPE basis and are named for it. */
      const materialWire = (m: MaterialRef) => ({
        material_id: m.material_id,
        material_name: m.material_name,
        sku: m.sku,
        unit: m.unit,                       // RECIPE unit (stored basis)
        purchase_unit: m.purchase_unit || m.unit,
        pack_size: m.pack_size,
        case_size: m.case_size,
        average_price: m.average_price,     // ₹ per RECIPE unit
        current_stock_recipe: m.current_stock,
      });
      const menuWire = (mi: MenuItemRef) => ({
        id: mi.id, name: mi.name, category: mi.category, pos_id: mi.pos_id,
        material_id: mi.material_id, is_active: mi.is_active, matched_by: mi.matched_by,
      });

      for (const r of results) {
        const key = nameKey(r.item_name);
        /**
         * ZERO SALES IN THIS WINDOW — the honest state, whichever block built
         * the row. Two of the three blocks above produce sales-less rows: the
         * manual block (a saved link whose item never came through the sales
         * pass) and the saved-mapping block (flagged `no_recent_sales`). They
         * are the same situation from the counter's chair, so the screen must
         * label them the same way. Measured here: 333 manual + 19 appended =
         * 352 of 464 rows carry no sales, against 112 that do. Rendering 352
         * rows of zeroes as if they were dead items is what the bug report
         * actually described. A sales-pass row can never land here — it had to
         * clear HAVING SUM(quantity_sold) >= min_sold to exist.
         */
        r.zero_sales = !Number(r.qty_sold) && !Number(r.line_count);
        const menuItems = resolveMenuItems(menuIdx, r.item_name, posByName.get(key));
        r.menu_items = menuItems.map(menuWire);
        r.menu_item_count = menuItems.length;
        r.menu_item_missing = menuItems.length === 0;

        // The SAVED link (what the mapping actually is), not the heuristic
        // suggestion in `matched` — those are different things and conflating
        // them is how a suggestion gets mistaken for a decision.
        const dilMat = dilByName.has(key) ? dilByName.get(key) || null : null;
        const menuMat = menuItems.find(m => m.material_id)?.material_id || null;
        const linkedId = r.linked_material_id || dilMat || menuMat || null;
        const linked = linkedId ? matIdx.byId.get(linkedId) || null : null;
        r.material_link = linked ? materialWire(linked) : null;
        r.material_missing = !linked;
        // Pack meta for the material the `matched` figures are expressed in.
        // It can be a DIFFERENT material from the saved link (the heuristic is a
        // suggestion), and converting a number with the wrong pack factor is
        // exactly the class of bug the purchase-unit lock exists to stop — so the
        // basis travels with the numbers, not with the link.
        const suggested = (r.matched?.material_id || r.matched?.id || null) as string | null;
        const sm = suggested ? matIdx.byId.get(suggested) || null : null;
        r.matched_meta = sm
          ? { unit: sm.unit, purchase_unit: sm.purchase_unit || sm.unit, pack_size: sm.pack_size, case_size: sm.case_size }
          : null;
        r.link_source = linked ? (dilMat === linkedId ? 'direct_item_links' : 'menu_items') : null;
        r.has_saved_mapping = dilByName.has(key);
        // Heuristic disagrees with the saved link — worth surfacing, never applied.
        const suggestedId = r.matched?.material_id || r.matched?.id || null;
        r.suggestion_differs = !!(linked && suggestedId && suggestedId !== linked.material_id);
      }
    }

    // Summary totals
    const totalLeakageValue = results.reduce((a, r) => a + (r.leakage_value || 0), 0);
    const matched = results.filter(r => r.matched).length;
    const unmatched = results.length - matched;

    return Response.json({
      count: results.length,
      matched, unmatched,
      total_leakage_value: Math.round(totalLeakageValue * 100) / 100,
      /** How many rows are saved mappings with no sales in the discovery window. */
      saved_without_sales: results.filter(r => r.no_recent_sales).length,
      /** Every row with no sales in this window — the appended saved mappings
       *  above PLUS the manual block's rows, which are the same state. This is
       *  the number the screen shows; saved_without_sales is the subset that had
       *  no report row at all before the recovery block existed. */
      no_sales_rows: results.filter(r => r.zero_sales).length,
      /** Chain health — how many rows are missing one end of the mapping. */
      material_missing: results.filter(r => r.material_missing).length,
      menu_item_missing: results.filter(r => r.menu_item_missing).length,
      items: results,
    });
  } catch (error: any) {
    console.error('[/api/direct-items] error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Finalize (or unlink) a direct-item ↔ raw_material mapping.
 *
 * Body:
 *   { item_name: string, material_id: string | null }
 *
 *   material_id = null → unlinks any existing mapping for menu items with that name.
 *   material_id = uuid → sets menu_items.material_id for every menu_items row matching
 *   LOWER(name) = LOWER(item_name).
 *
 * Returns the number of menu_items rows updated.
 */
export async function POST(request: Request) {
  try {
    const db = getDb();
    const { item_name, material_id, qty_per_unit, dismissed } = await request.json();
    if (!item_name || typeof item_name !== 'string') {
      return Response.json({ error: 'item_name is required' }, { status: 400 });
    }
    if (material_id && typeof material_id !== 'string') {
      return Response.json({ error: 'material_id must be a string or null' }, { status: 400 });
    }
    const qpu = Number.isFinite(Number(qty_per_unit)) && Number(qty_per_unit) > 0
                ? Number(qty_per_unit) : 1;
    const dismissedFlag = dismissed ? 1 : 0;
    if (material_id) {
      const exists = db.prepare('SELECT id FROM raw_materials WHERE id = ?').get(material_id);
      if (!exists) return Response.json({ error: 'material_id not found' }, { status: 404 });
    }

    // The upsert + menu_items sweep live in _lib/link-writer.ts. The bulk CSV
    // importer calls the SAME function, so a single-item edit and a bulk edit
    // can never mean two different things.
    const txn = db.transaction(() => writeDirectItemLink(db, {
      item_name,
      material_id: material_id || null,
      qty_per_unit: qpu,
      dismissed: !!dismissedFlag,
    }));

    const updatedMenuItems = txn();

    return Response.json({
      success: true,
      item_name,
      material_id: material_id || null,
      qty_per_unit: qpu,
      updated_menu_items: updatedMenuItems,
    });
  } catch (error: any) {
    console.error('[/api/direct-items] POST error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
