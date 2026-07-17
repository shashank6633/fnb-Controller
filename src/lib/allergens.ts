// Cookbook Phase 3 — allergen roll-up.
//
// We DERIVE allergens from ingredient names rather than storing them on
// raw_materials (a protected table). This gives an instant, advisory
// "contains" list on every recipe with zero data entry. It is a KITCHEN AID,
// not a guest-safety guarantee — always labelled "auto-detected, verify".
//
// Matching is word-boundary based (so "eggplant" never trips "egg", and
// "coconut" never trips a tree nut). A few negative-context guards suppress
// the obvious plant-milk / peanut-butter false positives.

export type AllergenKey =
  | 'dairy' | 'gluten' | 'tree_nuts' | 'peanuts' | 'egg'
  | 'soy' | 'fish' | 'shellfish' | 'sesame' | 'mustard';

export interface AllergenDef {
  key: AllergenKey;
  label: string;
  emoji: string;
  /** keyword phrases; matched on word boundaries, case-insensitive */
  keywords: string[];
  /** contextual: strip these phrases, then only flag if another keyword survives
   *  (e.g. "coconut milk" is not dairy, but "coconut milk paneer" still is) */
  exclude?: string[];
  /** hard negation: if any appears, suppress this allergen entirely
   *  (e.g. "eggless", "gluten-free", "vegan") */
  negate?: string[];
}

// Order here = display order.
export const ALLERGEN_DEFS: AllergenDef[] = [
  {
    key: 'dairy', label: 'Dairy', emoji: '🥛',
    keywords: [
      'milk', 'butter', 'ghee', 'cheese', 'paneer', 'cream', 'curd',
      'yogurt', 'yoghurt', 'khoya', 'khoa', 'mawa', 'malai', 'dahi',
      'buttermilk', 'condensed milk', 'milk powder', 'clarified butter',
      'milkshake', 'cheesecake', 'custard', 'kulfi', 'lassi', 'kheer',
      'rabri', 'rasmalai', 'shrikhand', 'makhani', 'rasgulla', 'rosogolla',
      'sandesh', 'basundi', 'payasam', 'phirni', 'firni', 'peda', 'barfi',
      'burfi', 'kalakand', 'butterscotch', 'gulab jamun', 'milk cake', 'eggnog',
      // named cheese varieties (matched even without the word "cheese")
      'mozzarella', 'cheddar', 'parmesan', 'parmigiano', 'feta', 'brie',
      'ricotta', 'mascarpone', 'gouda', 'emmental', 'provolone',
      'camembert', 'gruyere', 'gorgonzola', 'burrata', 'halloumi',
      'pecorino', 'stilton',
    ],
    // plant "milks", peanut/cocoa butter, and the non-dairy "cream"/"custard"
    // homographs are not dairy
    exclude: [
      'coconut milk', 'almond milk', 'soy milk', 'soya milk', 'oat milk',
      'cashew milk', 'rice milk', 'peanut butter', 'cocoa butter',
      'coconut cream', 'cream of tartar', 'custard apple',
      // non-dairy "cream"/"cheese" homographs
      'cream soda', 'cream of wheat', 'cream of coconut', 'cream cracker',
      'cashew cheese', 'almond cheese', 'nut cheese',
    ],
    negate: ['dairy free', 'dairy-free', 'dairyfree', 'non dairy', 'non-dairy', 'vegan'],
  },
  {
    key: 'gluten', label: 'Gluten', emoji: '🌾',
    keywords: [
      'wheat', 'maida', 'atta', 'suji', 'sooji', 'rava', 'semolina',
      'bread', 'breadcrumb', 'pasta', 'noodle', 'barley', 'rye', 'malt',
      'vermicelli', 'dalia', 'roti', 'naan', 'seitan', 'couscous', 'bulgur',
      'malted', 'breadstick', 'biscuit', 'croissant', 'brioche', 'focaccia',
      'cracker', 'lavash', 'pita', 'baguette', 'panko', 'jalebi',
      'sponge cake', 'pound cake', 'plum cake', 'fruit cake',
    ],
    // 'bread' matches as a substring; these "bread" words are not gluten.
    exclude: ['breadfruit', 'sweetbread'],
    negate: ['gluten free', 'gluten-free', 'glutenfree'],
  },
  {
    key: 'tree_nuts', label: 'Tree Nuts', emoji: '🌰',
    keywords: [
      'almond', 'cashew', 'walnut', 'pistachio', 'hazelnut', 'pecan',
      'macadamia', 'pine nut', 'brazil nut', 'badam', 'kaju', 'pista',
      'akhrot', 'praline', 'marzipan', 'chestnut', 'chironji', 'charoli',
      'nutella', 'gianduja', 'frangipane',
    ],
    // coconut & nutmeg are not tree nuts (and we never match a bare "nut");
    // "water chestnut" is an aquatic veg, not the tree nut.
    exclude: ['nutmeg', 'water chestnut'],
  },
  {
    key: 'peanuts', label: 'Peanuts', emoji: '🥜',
    keywords: ['peanut', 'groundnut', 'moongphali', 'mungfali', 'singdana'],
  },
  {
    key: 'egg', label: 'Egg', emoji: '🥚',
    keywords: [
      'egg', 'anda', 'mayonnaise', 'mayo', 'albumen', 'meringue',
      'eggroll', 'eggnog', 'omelette', 'omelet', 'frittata', 'quiche',
    ],
    exclude: ['eggplant'],
    negate: ['eggless', 'egg free', 'egg-free', 'vegan'],
  },
  {
    key: 'soy', label: 'Soy', emoji: '🫘',
    keywords: ['soy', 'soya', 'soybean', 'soymilk', 'tofu', 'edamame', 'tempeh', 'miso'],
  },
  {
    key: 'fish', label: 'Fish', emoji: '🐟',
    keywords: [
      'fish', 'anchovy', 'anchovies', 'tuna', 'salmon', 'mackerel', 'sardine',
      'pomfret', 'bhetki', 'surmai', 'rohu', 'katla', 'basa', 'cod', 'tilapia',
      'hilsa', 'seer', 'kingfish', 'snapper', 'trout', 'halibut', 'bombil',
      'bangda',
    ],
    // 'fish' matches as a substring (swordfish/catfish/monkfish); strip the
    // shellfish/mollusc "-fish" homographs so they don't tag as finned fish.
    exclude: [
      'shellfish', 'cuttlefish', 'jellyfish', 'starfish', 'crayfish',
      'silverfish', 'kingfisher',
    ],
  },
  {
    key: 'shellfish', label: 'Shellfish', emoji: '🦐',
    keywords: [
      'prawn', 'shrimp', 'crab', 'lobster', 'squid', 'calamari', 'octopus',
      'mussel', 'clam', 'oyster', 'scallop', 'crayfish', 'crabmeat',
      'crabstick', 'langoustine', 'krill', 'cuttlefish', 'shellfish',
    ],
    // "crab apple" is a pome fruit, not a crustacean
    exclude: ['crab apple', 'crabapple'],
  },
  {
    key: 'sesame', label: 'Sesame', emoji: '⚪',
    keywords: ['sesame', 'til', 'tahini', 'gingelly'],
  },
  {
    key: 'mustard', label: 'Mustard', emoji: '🟡',
    keywords: ['mustard', 'sarson', 'kasundi'],
  },
];

export const ALLERGEN_MAP: Record<AllergenKey, AllergenDef> =
  Object.fromEntries(ALLERGEN_DEFS.map((d) => [d.key, d])) as Record<AllergenKey, AllergenDef>;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A few keywords are matched as a bare SUBSTRING (not word-boundary) because
// they form closed compounds constantly and no non-food word contains them:
//   'fish'   -> swordfish, catfish, monkfish, fishcake … (shellfish/cuttlefish/
//               jellyfish are peeled off via the fish `exclude` list)
//   'cheese' -> cheeseburger, cheesesteak, cheesecake …
//   'cream'  -> creamed, creamy, buttercream … (cream of tartar excluded)
//   'bread'  -> breaded, shortbread, gingerbread … (breadfruit/sweetbread excluded)
// Every OTHER keyword stays word-boundary matched, which is what keeps 'egg'
// out of "veggie", 'til' out of "lentil", 'butter' out of "butternut", etc.
const SUBSTRING_KEYWORDS = new Set(['fish', 'cheese', 'cream', 'bread']);

// Cache one compiled boundary regex per keyword phrase.
const _kwRegex = new Map<string, RegExp>();
function kwMatch(haystack: string, phrase: string): boolean {
  if (SUBSTRING_KEYWORDS.has(phrase)) return haystack.includes(phrase);
  let re = _kwRegex.get(phrase);
  if (!re) {
    // Boundary match with an optional plural "s" so "prawn" catches "prawns",
    // "cashew" catches "cashews", etc. \b-style boundaries keep "egg" out of
    // "eggplant" and "coconut" out of tree nuts.
    re = new RegExp(`(^|[^a-z])${escapeRegExp(phrase)}s?([^a-z]|$)`, 'i');
    _kwRegex.set(phrase, re);
  }
  return re.test(haystack);
}

// Boundary-aware strip of an exclude phrase (non-consuming lookarounds so the
// surrounding boundary chars survive). This is why "goat milk" is NOT eaten by
// the "oat milk" exclude — the 'oat milk' inside "g|oat milk" is preceded by a
// letter, so the lookbehind blocks it.
const _exRegex = new Map<string, RegExp>();
function excludeStrip(hay: string, phrases: string[]): string {
  let out = hay;
  for (const p of phrases) {
    let re = _exRegex.get(p);
    if (!re) { re = new RegExp(`(?<![a-z])${escapeRegExp(p)}s?(?![a-z])`, 'gi'); _exRegex.set(p, re); }
    out = out.replace(re, ' ');
  }
  return out;
}

// A negate token ("vegan", "eggless"…) is only active if it is NOT itself
// negated — "non-vegan" / "not vegan" / "nonvegan" must NOT suppress the allergen.
// Separator-agnostic (space, hyphen, or joined) so all spellings are caught.
const _negRegex = new Map<string, RegExp>();
function negateActive(hay: string, phrase: string): boolean {
  if (!hay.includes(phrase)) return false;
  let guard = _negRegex.get(phrase);
  if (!guard) { guard = new RegExp(`(?:non|not)[ -]?${escapeRegExp(phrase)}`, 'gi'); _negRegex.set(phrase, guard); }
  return hay.replace(guard, ' ').includes(phrase); // still present outside a non-/not- prefix?
}

/** Allergen keys implied by a single ingredient/material name. */
export function detectAllergens(name: string): AllergenKey[] {
  if (!name) return [];
  // Normalise hyphen/slash/underscore separators to spaces so "custard-apple",
  // "not-vegan", "gluten-free" match the same phrases as their spaced spellings.
  const hay = ` ${String(name).toLowerCase().trim().replace(/[-_/]+/g, ' ')} `;
  const out: AllergenKey[] = [];
  for (const def of ALLERGEN_DEFS) {
    // hard negation ("eggless", "gluten-free", "vegan") suppresses the allergen,
    // unless the negate token is itself negated ("non-vegan", "not vegan").
    if (def.negate && def.negate.some((n) => negateActive(hay, n))) continue;
    if (def.exclude) {
      // Strip exclude phrases (boundary-aware). If that removed something and no
      // keyword survives outside the excluded phrase, this allergen doesn't apply.
      const stripped = excludeStrip(hay, def.exclude);
      if (stripped !== hay && !def.keywords.some((kw) => kwMatch(stripped, kw))) continue;
    }
    if (def.keywords.some((kw) => kwMatch(hay, kw))) out.push(def.key);
  }
  return out;
}

/** Union of allergens across many ingredient names, in display order. */
export function rollUpAllergens(names: string[]): AllergenKey[] {
  const set = new Set<AllergenKey>();
  for (const n of names) for (const k of detectAllergens(n)) set.add(k);
  // preserve ALLERGEN_DEFS ordering
  return ALLERGEN_DEFS.filter((d) => set.has(d.key)).map((d) => d.key);
}

export function allergenLabel(key: string): string {
  return (ALLERGEN_MAP as Record<string, AllergenDef>)[key]?.label ?? key;
}
export function allergenEmoji(key: string): string {
  return (ALLERGEN_MAP as Record<string, AllergenDef>)[key]?.emoji ?? '•';
}
