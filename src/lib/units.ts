/**
 * Unit Registry + Generic Converter.
 *
 * Three dimensions exist: VOLUME, WEIGHT, COUNT.
 * Within a dimension, conversions are deterministic (g↔kg, ml↔L, oz↔ml, …).
 * Across dimensions, conversion is only possible via a material-specific pack_size
 * (e.g. 1 BTL = 750 ml of 100 Pipers).
 *
 * Use cases:
 *   convert(60, 'ml', 'BTL', mat100Pipers)          → 0.08    (60 ÷ 750)
 *   convert(1, 'CASE', 'BTL', mat)                  → null    (need bridge or alias)
 *   convert(1, 'L', 'ml')                           → 1000
 *   convert(500, 'g', 'kg')                         → 0.5
 *   canConvert('BTL', 'ml', mat)                    → true
 *   canConvert('kg', 'ml')                          → false   (different dims, no bridge)
 *
 * Pure module — usable by both server (recipes, variance, inventory APIs) and
 * client (unit-audit, recipe editor live-preview).
 */

export type Dimension = 'volume' | 'weight' | 'count';

export interface UnitDef {
  /** Canonical short label shown in UI. */
  label: string;
  /** Aliases that resolve to this unit (case-insensitive). */
  aliases: string[];
  dimension: Dimension;
  /**
   * Multiplier to convert THIS unit to the dimension's base.
   *   volume base = ml,  weight base = g,  count base = pcs.
   * Example: { label: 'kg', toBase: 1000 } means 1 kg = 1000 g.
   * For "pack-style" count units (BTL, CASE, …) the toBase is 1 — they're
   * indistinguishable from generic count at the registry level. The bridge
   * to volume / weight comes from material.pack_size at conversion time.
   */
  toBase: number;
}

/** Master registry. Add new units here — both UI and converter pick them up. */
export const UNIT_REGISTRY: Record<string, UnitDef> = {
  // -------- VOLUME --------
  ml:    { label: 'ml',    aliases: ['ml', 'milliliter', 'millilitre'],     dimension: 'volume', toBase: 1 },
  cl:    { label: 'cl',    aliases: ['cl'],                                  dimension: 'volume', toBase: 10 },
  L:     { label: 'L',     aliases: ['l', 'lt', 'ltr', 'liter', 'litre'],    dimension: 'volume', toBase: 1000 },
  oz:    { label: 'oz',    aliases: ['oz', 'fl oz', 'fluid ounce'],          dimension: 'volume', toBase: 29.5735 },
  tsp:   { label: 'tsp',   aliases: ['tsp', 'teaspoon'],                     dimension: 'volume', toBase: 4.92892 },
  tbsp:  { label: 'tbsp',  aliases: ['tbsp', 'tablespoon'],                  dimension: 'volume', toBase: 14.7868 },
  cup:   { label: 'cup',   aliases: ['cup', 'cups'],                         dimension: 'volume', toBase: 240 },

  // -------- WEIGHT --------
  mg:    { label: 'mg',    aliases: ['mg', 'milligram'],                     dimension: 'weight', toBase: 0.001 },
  g:     { label: 'g',     aliases: ['g', 'gm', 'gms', 'grm', 'grms', 'gram'], dimension: 'weight', toBase: 1 },
  kg:    { label: 'kg',    aliases: ['kg', 'kilo', 'kilogram'],              dimension: 'weight', toBase: 1000 },
  lb:    { label: 'lb',    aliases: ['lb', 'lbs', 'pound'],                  dimension: 'weight', toBase: 453.592 },

  // -------- COUNT --------
  pcs:   { label: 'pcs',   aliases: ['pcs', 'pc', 'piece', 'each', 'unit', 'units'], dimension: 'count', toBase: 1 },

  // Purchase-style count units. They're all "1 each" at the registry level;
  // pack_size on the material (in recipe-unit terms) is what bridges them
  // to ml/g/etc. when needed.
  BTL:   { label: 'BTL',   aliases: ['btl', 'bottle', 'bottles'],            dimension: 'count', toBase: 1 },
  CASE:  { label: 'CASE',  aliases: ['case', 'cs'],                          dimension: 'count', toBase: 1 },
  PKT:   { label: 'PKT',   aliases: ['pkt', 'packet', 'pack'],               dimension: 'count', toBase: 1 },
  TIN:   { label: 'TIN',   aliases: ['tin'],                                 dimension: 'count', toBase: 1 },
  CAN:   { label: 'CAN',   aliases: ['can'],                                 dimension: 'count', toBase: 1 },
  JAR:   { label: 'JAR',   aliases: ['jar'],                                 dimension: 'count', toBase: 1 },
  BOX:   { label: 'BOX',   aliases: ['box', 'carton'],                       dimension: 'count', toBase: 1 },
  BAG:   { label: 'BAG',   aliases: ['bag', 'sack'],                         dimension: 'count', toBase: 1 },
  BUNCH: { label: 'BUNCH', aliases: ['bunch'],                               dimension: 'count', toBase: 1 },
  TRAY:  { label: 'TRAY',  aliases: ['tray'],                                dimension: 'count', toBase: 1 },
};

/** Built-in defaults — seeded into the DB on first run. Kept as the fallback
 *  when DB seeding hasn't happened yet (e.g. in pure unit tests). */
export const BUILT_IN_REGISTRY: Record<string, UnitDef> = JSON.parse(JSON.stringify(UNIT_REGISTRY));

/** Case-insensitive alias → canonical-key map. Rebuilt whenever the registry
 *  changes via applyRegistryRows() (e.g. after a UI edit). */
let ALIAS_INDEX: Record<string, string> = buildAliasIndex(UNIT_REGISTRY);
function buildAliasIndex(reg: Record<string, UnitDef>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, def] of Object.entries(reg)) {
    out[key.toLowerCase()] = key;
    for (const alias of def.aliases) out[alias.toLowerCase()] = key;
  }
  return out;
}

/** Replace the live registry from a flat array of DB rows. Called at server
 *  startup and after every CRUD write so subsequent convert() calls use the
 *  latest values without a process restart. */
export function applyRegistryRows(rows: Array<{
  key: string; label: string; aliases: string[] | string; dimension: Dimension; to_base: number;
}>) {
  // Clear current registry (keep object identity for callers that captured the reference)
  for (const k of Object.keys(UNIT_REGISTRY)) delete UNIT_REGISTRY[k];
  for (const r of rows) {
    const aliases = typeof r.aliases === 'string'
      ? (r.aliases.trim().startsWith('[') ? JSON.parse(r.aliases) : r.aliases.split(',').map(s => s.trim()).filter(Boolean))
      : (r.aliases || []);
    UNIT_REGISTRY[r.key] = { label: r.label, aliases, dimension: r.dimension, toBase: Number(r.to_base) };
  }
  ALIAS_INDEX = buildAliasIndex(UNIT_REGISTRY);
}

/** Look up a unit by any string (case-insensitive, trimmed). Returns the canonical key or null. */
export function resolveUnit(input: string | null | undefined): string | null {
  if (!input) return null;
  return ALIAS_INDEX[String(input).toLowerCase().trim()] || null;
}

/** Get the dimension (volume/weight/count) for a unit, or null if unknown. */
export function dimensionOf(input: string | null | undefined): Dimension | null {
  const k = resolveUnit(input);
  return k ? UNIT_REGISTRY[k].dimension : null;
}

/**
 * Material context used for cross-dimension conversion.
 *   recipe_unit:    canonical ml / g / pcs in which the material is internally tracked
 *   purchase_unit:  the buy-side unit (BTL, CASE, etc.)
 *   pack_size:      number of recipe-units in one purchase-unit (e.g. 750 ml in 1 BTL)
 */
export interface MaterialPackContext {
  recipe_unit?: string;
  purchase_unit?: string;
  pack_size?: number;
  /** Optional name — used to fall back to volume-from-name parsing for legacy data. */
  name?: string;
}

/** Best-effort: parse "(750ML)" / "1 LTR" out of a material name. Returns ml or null. */
export function parseVolumeFromName(name: string | null | undefined): number | null {
  if (!name) return null;
  const s = String(name).toUpperCase();
  const ml = s.match(/(\d+(?:\.\d+)?)\s*ML\b/);
  if (ml) return Number(ml[1]);
  const l  = s.match(/(\d+(?:\.\d+)?)\s*L(?:TR)?\b/);
  if (l)  return Number(l[1]) * 1000;
  return null;
}

/**
 * Generic unit converter.
 * Returns the converted quantity, or `null` if the conversion can't be made
 * (e.g. weight → count without a pack bridge).
 *
 * Same-dimension conversions don't need a context. Cross-dimension does.
 */
export function convert(
  qty: number,
  fromUnit: string,
  toUnit: string,
  ctx?: MaterialPackContext,
): number | null {
  const fromKey = resolveUnit(fromUnit);
  const toKey   = resolveUnit(toUnit);
  if (!fromKey || !toKey) return null;
  if (fromKey === toKey) return qty;

  const f = UNIT_REGISTRY[fromKey];
  const t = UNIT_REGISTRY[toKey];

  // Same dimension: convert via base.
  if (f.dimension === t.dimension) {
    return (qty * f.toBase) / t.toBase;
  }

  // Cross-dimension: pack-bridge required.
  // pack_size is "recipe-units per purchase-unit"; recipe_unit identifies the bridge dimension.
  const packSize  = Number(ctx?.pack_size) > 1 ? Number(ctx?.pack_size)
                  : (parseVolumeFromName(ctx?.name) || 0);
  if (packSize <= 0) {
    // Density-1 fallback for volume↔weight pairs (water-density assumption).
    // 1 ml ≈ 1 g works within 5-15% for milk, sauces, oils — close enough for
    // food-cost. Without this, recipes that mix ml/g/kg/l units against a
    // mismatched material unit return null and silently zero-out the cost.
    const isVolWeightPair = (f.dimension === 'volume' && t.dimension === 'weight')
                         || (f.dimension === 'weight' && t.dimension === 'volume');
    if (isVolWeightPair) {
      // Convert via grams-per-ml = 1
      const qtyInBase = qty * f.toBase;   // → ml-base or g-base
      // 1 g = 1 ml so base values are interchangeable
      return qtyInBase / t.toBase;
    }
    return null;
  }

  // Bridge dimension = recipe_unit's dimension (or fall back to whatever non-count side is).
  const bridgeKey = resolveUnit(ctx?.recipe_unit)
                  || (f.dimension !== 'count' ? fromKey : toKey);
  const bridge = bridgeKey ? UNIT_REGISTRY[bridgeKey] : null;
  if (!bridge) return null;

  // Step 1: get qty into the bridge dimension as a count of recipe-units (i.e. in `bridgeKey`).
  let qtyInBridge: number;
  if (f.dimension === 'count') {
    // 1 count-unit = packSize bridge-units (in recipe-unit terms)
    qtyInBridge = qty * packSize;
  } else if (f.dimension === bridge.dimension) {
    // From is volume/weight in the same dimension as bridge → just rebase.
    qtyInBridge = (qty * f.toBase) / bridge.toBase;
  } else {
    // From is volume/weight but bridge is the other one (e.g. from=g, bridge=ml). Not possible.
    return null;
  }

  // Step 2: convert from bridge-units to target.
  if (t.dimension === 'count') {
    // qtyInBridge bridge-units ÷ packSize = qty in count
    return qtyInBridge / packSize;
  }
  if (t.dimension === bridge.dimension) {
    return (qtyInBridge * bridge.toBase) / t.toBase;
  }
  return null;
}

/** Whether a from→to conversion is achievable given an optional material context. */
export function canConvert(fromUnit: string, toUnit: string, ctx?: MaterialPackContext): boolean {
  return convert(1, fromUnit, toUnit, ctx) != null;
}

/** Returns the conversion factor for `1 fromUnit → ? toUnit`. */
export function conversionFactor(fromUnit: string, toUnit: string, ctx?: MaterialPackContext): number | null {
  return convert(1, fromUnit, toUnit, ctx);
}

/** All canonical unit keys grouped by dimension — useful for UI dropdowns. */
export function unitsByDimension(): Record<Dimension, string[]> {
  const out: Record<Dimension, string[]> = { volume: [], weight: [], count: [] };
  for (const [key, def] of Object.entries(UNIT_REGISTRY)) {
    out[def.dimension].push(key);
  }
  return out;
}

/**
 * Build a same-dimension conversion table for UI display:
 *   { volume: { ml→L: 0.001, L→ml: 1000, ... }, weight: ..., count: {} }
 * Cross-dimension is excluded since it depends on material pack_size.
 */
export function buildSameDimensionMatrix(): Record<Dimension, Array<{ from: string; to: string; factor: number }>> {
  const out: Record<Dimension, Array<{ from: string; to: string; factor: number }>> = { volume: [], weight: [], count: [] };
  for (const [fromKey, fromDef] of Object.entries(UNIT_REGISTRY)) {
    for (const [toKey, toDef] of Object.entries(UNIT_REGISTRY)) {
      if (fromKey === toKey) continue;
      if (fromDef.dimension !== toDef.dimension) continue;
      out[fromDef.dimension].push({
        from: fromKey, to: toKey,
        factor: fromDef.toBase / toDef.toBase,
      });
    }
  }
  return out;
}
