/**
 * Fuzzy menu-item → recipe matcher.
 *
 * Menu names are worded differently from recipe names (e.g. "Veg Manchow Soup"
 * and "Chicken Manchow Soup" both map to the combined recipe "MANCHOW SOUP VEG /
 * NONVEG"; "Bhuna Bhutta Soup" → "BHUNA BUTTA KA SHORBA"). Exact matching misses
 * almost all of these, so we score on significant-token overlap with a small
 * spelling tolerance (Levenshtein) and only accept confident matches — a wrong
 * link pulls the wrong food cost, so we err toward "no match" over a bad one.
 *
 * Pure module (no DB/fs) so it is unit-testable and shared by the menu import.
 */

/** Pure connectives only. We deliberately KEEP content words — including
 *  proteins (chicken/fish/…) and diet words (veg) — as real tokens: the dish-name
 *  tokens already carry the combined-recipe case ("Chicken Manchow Soup" still
 *  matches "MANCHOW SOUP VEG / NONVEG" on manchow+soup), while keeping "fish"
 *  stops "Sweet Chilli Fish Bites" from wrongly matching a sweet-chilli potato
 *  dish on generic flavour words. */
const STOPWORDS = new Set([
  'with', 'and', 'the', 'of', 'in', 'on', 'a', 'an', 'or', 'to', 'for',
]);

export function normalize(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantTokens(s: string): string[] {
  return normalize(s).split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Bounded Damerau (optimal string alignment) distance — counts an adjacent
 *  transposition as one edit, so Caesar/Ceaser and Katsu/Kastu are close. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);   // adjacent transposition
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** Two tokens "match" if equal, or close enough given their length (catches
 *  Bhutta/Butta, Cream/Ceam, Korean/Korien, Kunafa/Khunafa, Caesar/Ceaser). */
function tokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;             // short tokens must be exact
  const max = Math.min(a.length, b.length) >= 6 ? 2 : 1;
  return editDistance(a, b, max) <= max;
}

export interface RecipeRef { id: string; name: string; }
export interface RecipeMatch { id: string; name: string; score: number; exact: boolean; }

/**
 * Build a matcher over a set of recipes. Returns (menuName) → best RecipeMatch
 * or null. Accepts a match only when the confidence is high enough to trust the
 * cost link.
 */
export function buildRecipeMatcher(recipes: RecipeRef[]): (menuName: string) => RecipeMatch | null {
  const byExact = new Map<string, RecipeRef>();
  const indexed = recipes.map((r) => {
    byExact.set(normalize(r.name), r);
    return { ref: r, tokens: significantTokens(r.name) };
  });

  // IDF over recipe tokens: common words (chicken/curry/pizza/soup) get low weight,
  // distinctive words (caesar/angara/aglio/telangana) get high weight.
  const N = Math.max(indexed.length, 1);
  const df = new Map<string, number>();
  for (const { tokens } of indexed) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = (t: string): number => Math.log(N / (1 + (df.get(t) || 0)));

  return (menuName: string): RecipeMatch | null => {
    const exact = byExact.get(normalize(menuName));
    if (exact) return { id: exact.id, name: exact.name, score: 1, exact: true };

    const q = significantTokens(menuName);
    if (q.length === 0) return null;

    // Require EVERY distinctive menu token (rare, content-bearing, non-diet) to be
    // matched. This is what separates a real link from a coincidental one on
    // generic words: "Butter Chicken Pizza" must match both "butter" AND "pizza",
    // so it won't link to the "Butter Chicken" curry. Generic words (chicken,
    // curry, soup) may go unmatched. Among candidates passing the gate, keep the
    // highest-scoring so a rejected candidate can't steal the right one.
    const DIET = new Set(['veg', 'nonveg', 'non', 'egg']);
    const idfThreshold = Math.log(N / (1 + N * 0.06));   // ~rarer than 6% of recipes
    const distinctive = q.filter((t) => !DIET.has(t) && t.length >= 4 && idf(t) >= idfThreshold);

    let best: { ref: RecipeRef; score: number } | null = null;
    for (const { ref, tokens } of indexed) {
      if (tokens.length === 0) continue;
      let matched = 0;
      for (const qt of q) if (tokens.some((t) => tokenMatch(qt, t))) matched++;
      const score = matched / q.length;
      const allDistinctiveMatched = distinctive.every((dt) => tokens.some((t) => tokenMatch(dt, t)));
      const ok =
        score >= 0.6 &&
        (matched >= 2 || (q.length === 1 && score >= 1)) &&
        allDistinctiveMatched;
      if (ok && (!best || score > best.score)) best = { ref, score };
    }
    return best ? { id: best.ref.id, name: best.ref.name, score: +best.score.toFixed(2), exact: false } : null;
  };
}
