/**
 * SUGGEST THE MAJOR INGREDIENTS — NEVER THE QUANTITIES.
 * ----------------------------------------------------
 * A cook entering "GONGURA PRAWNS" should not have to search a 952-material list
 * for the word "prawns". So the dish's own name is read for the materials it
 * obviously implies, and those are offered as tick-boxes.
 *
 * TWO RULES THIS MODULE WILL NOT BREAK:
 *
 *  1. NO INVENTED QUANTITIES. A suggestion carries a material and nothing else.
 *     A pre-filled "0.2 kg" would be a number the system made up, and the moment
 *     it is saved it becomes indistinguishable from a number the cook measured —
 *     it would then flow into food cost and into pricing. The cook types every
 *     quantity. There is no default.
 *
 *  2. SUGGEST, NEVER IMPOSE. Nothing here is pre-ticked. An empty suggestion list
 *     is a perfectly good outcome; the full material search is always present.
 *
 * WORD-BOUNDARY MATCHING, not substring. "PAYA" appears inside "PAPAYA", and a
 * paya dish offered papaya is the kind of wrongness that teaches a cook to stop
 * reading suggestions. Matching is on whole words, with a light plural fold.
 */

export interface SuggestableMaterial {
  id: string;
  name: string;
  unit: string;
  average_price?: number | null;
  pack_size?: number | null;
  category?: string | null;
  is_active?: number | null;
}

export interface Suggestion {
  material: SuggestableMaterial;
  /** Why this was offered, shown to the cook so a suggestion is never mysterious. */
  reason: string;
  /** Higher sorts first. Internal only. */
  score: number;
}

/**
 * Words that are in dish names but are not ingredients. Without this, "CURRY" and
 * "MASALA" match a dozen spice-blend materials and bury the protein.
 */
const NOISE = new Set([
  'the', 'and', 'with', 'in', 'of', 'a', 'an', 'on', 'our', 'style', 'stile',
  'special', 'house', 'classic', 'fresh', 'live', 'grill', 'grilled', 'roast',
  'roasted', 'fried', 'fry', 'tandoori', 'curry', 'masala', 'gravy', 'dry',
  'hot', 'spicy', 'sweet', 'sour', 'mix', 'mixed', 'combo', 'platter', 'plate',
  'half', 'full', 'small', 'large', 'regular', 'veg', 'non', 'nonveg',
  'starter', 'main', 'course', 'soup', 'salad', 'rice', 'bowl', 'pcs', 'piece',
  'new', 'old', 'best', 'chef', 'signature', 'served', 'sauce', 'dip',
]);

/**
 * Dish-name words that name an ingredient the material list spells differently.
 * Deliberately small and food-specific — an Indian menu calls chicken "murgh"
 * and mutton "gosht", and a cook should not have to translate.
 */
const SYNONYMS: Record<string, string[]> = {
  murgh: ['chicken'], murg: ['chicken'], murag: ['chicken'], kodi: ['chicken'],
  gosht: ['mutton'], ghost: ['mutton'], mamsam: ['mutton'], lamb: ['mutton'],
  jhinga: ['prawns'], jheenga: ['prawns'], royyala: ['prawns'], shrimp: ['prawns'],
  machhli: ['fish'], machli: ['fish'], chepa: ['fish'],
  cottage: ['paneer'],
  trotters: ['paya'],
  brain: ['bheja'],
  keema: ['mutton'], kheema: ['mutton'],
  calamari: ['squid'],
  egg: ['eggs'],
};

/** Material categories that are never a food ingredient. Demotes, never excludes. */
const NON_FOOD = new Set(['packaging', 'cleaning', 'housekeeping', 'stationery', 'crockery', 'equipment', 'consumables']);

/** Fold a simple English plural so "PRAWNS" matches "PRAWN" and vice versa. */
function fold(w: string): string {
  const s = w.toLowerCase();
  if (s.length > 3 && s.endsWith('es')) return s.slice(0, -2);
  if (s.length > 3 && s.endsWith('s')) return s.slice(0, -1);
  return s;
}

/** Whole words of a string, lowercased, punctuation and digits dropped. */
function words(s: string): string[] {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3);
}

/**
 * Materials this dish probably contains, best first, each with its reason.
 *
 * `dishName` is the menu item's name; `category` is its menu category, used only
 * as a weak secondary signal. `materials` is the already-loaded material list —
 * this module does no I/O so the entry screen can re-run it on every keystroke.
 */
export function suggestMaterials(
  dishName: string,
  category: string | null | undefined,
  materials: SuggestableMaterial[],
  limit = 8,
): Suggestion[] {
  const dishWords = words(dishName).filter((w) => !NOISE.has(w));
  if (!dishWords.length) return [];

  // Expand the dish's words with any synonyms, remembering which original word
  // produced each target so the reason can quote the cook's own wording.
  const wanted = new Map<string, string>(); // folded target → dish word that asked for it
  for (const w of dishWords) {
    wanted.set(fold(w), w);
    for (const syn of SYNONYMS[w] || []) wanted.set(fold(syn), w);
  }

  const catWords = new Set(words(category || '').filter((w) => !NOISE.has(w)).map(fold));

  const out: Suggestion[] = [];

  for (const m of materials) {
    if (m.is_active !== undefined && m.is_active !== null && !Number(m.is_active)) continue;

    const mWords = words(m.name).map(fold);
    if (!mWords.length) continue;

    let hits = 0;
    let via = '';
    for (const mw of mWords) {
      const asked = wanted.get(mw);
      if (asked) {
        hits++;
        if (!via) via = asked;
      }
    }

    if (!hits) {
      // Weak secondary signal: the menu CATEGORY names the material. Only used
      // when the dish name itself matched nothing for this material, and scored
      // well below a name match so it can never outrank one.
      const catHit = mWords.some((mw) => catWords.has(mw));
      if (!catHit) continue;
      /**
       * NON-FOOD IS DROPPED HERE, NOT MERELY DEMOTED — and the difference
       * matters only on this branch.
       *
       * A name match earns a demotion because there is still evidence: "Butter
       * Chicken" really does contain the word BUTTER PAPER matched on. This
       * branch has NO name evidence at all — the only thing said is that the
       * material's name shares a word with the menu category. For a non-food
       * item that is not a weak signal, it is no signal, and the penalty below
       * was never applied here, so it shipped as a suggestion.
       *
       * Measured: "Grilled jumbo prawns" (category "grills") was offering
       * TASKI SUMA GRILL D9 5 LTR — a 5-litre floor cleaner, category
       * `packaging` — under the heading "Likely ingredients for this dish".
       * One suggestion like that is what teaches a cook to stop reading the
       * list, which costs more than the list is worth.
       */
      if (NON_FOOD.has(String(m.category || '').toLowerCase())) continue;
      out.push({
        material: m,
        reason: `matches the menu category “${category}”`,
        score: 1,
      });
      continue;
    }

    // A material whose name is ALL matched words ("PANEER" for a paneer dish) is
    // a better suggestion than one that merely contains the word among many
    // ("CHICKEN SEASONING IMPPORTED (Non Veg), 1 Kg"). Shorter, more fully
    // matched names win.
    const coverage = hits / mWords.length;

    out.push({
      material: m,
      reason: `matches “${via}” in the dish name`,
      // Demoted, never excluded. "Butter Chicken" matches BUTTER PAPER on the
      // word "butter", and packaging is not an ingredient — but is_recipe_item
      // cannot be used to filter here: 425 of the 568 ingredient rows actually
      // in use on this data carry is_recipe_item = 0, so filtering on it would
      // hide real ingredients. Category is the honest signal, and it only
      // reorders the list; anything the cook is looking for is still findable
      // through the full material search beside it.
      score: 100 * hits + 50 * coverage - (NON_FOOD.has(String(m.category || '').toLowerCase()) ? 150 : 0),
    });
  }

  out.sort((a, b) => b.score - a.score || a.material.name.length - b.material.name.length);
  return out.slice(0, limit);
}
