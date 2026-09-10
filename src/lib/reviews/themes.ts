/**
 * GOOGLE REVIEWS — THEMES BY KEYWORD MATCHING.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS IS KEYWORD COUNTING. IT IS NOT SENTIMENT ANALYSIS.
 * ══════════════════════════════════════════════════════════════════════════
 * Everything in this file does one thing: it looks for phrases in the review
 * text and counts which reviews contain them. It has NO idea whether the guest
 * was praising or complaining. "The service was outstanding" and "the service
 * was appalling" both count once against SERVICE, and that is correct — the
 * theme is what they talked about, not how they felt.
 *
 * The tone signal on this page comes from the STAR RATING, which is a number
 * the guest actually chose, not something inferred from their words. So a theme
 * row reports its average rating alongside its count: "service, 34 mentions,
 * average 2.9" is a real finding built from two honest measurements. Nothing
 * here may be presented as sentiment analysis, and no label in this module says
 * "positive" or "negative".
 *
 * If the owner turns the AI toggle on, ./ai.ts adds a genuine model-produced
 * sentiment and summary per review — clearly separated, clearly labelled, and
 * off by default because it costs money per review. This file remains the
 * fallback, and remains the whole feature when the toggle is off.
 *
 * PURE: no database, no network. Rules in, counts out.
 *
 * Modelled on the shipped call-topic engine (src/lib/ct/topics.ts) — same
 * word-boundary discipline, same "a rule is a name plus phrases" shape — but
 * simplified: reviews have no transcript fields to search and no per-hit rows
 * to persist, so themes are recomputed on demand rather than stored. There is
 * no theme table on purpose: a stored hit would go stale the moment a rule is
 * edited, and matching a few thousand short strings is microseconds.
 */
import type { AnalysisReview } from './types';
import { round } from './analysis';

export interface ThemeRule {
  key: string;
  label: string;
  /** Phrases. Multi-word phrases are matched as phrases; single words are
   *  matched on word boundaries so "bar" does not fire on "barely". */
  terms: string[];
}

/**
 * The starting set for a restaurant, written from the vocabulary Indian diners
 * actually use in Google reviews (including the Hinglish that shows up
 * constantly: "tasty", "value for money", "ambience" rather than "atmosphere").
 *
 * It is a STARTING set, not a fixed one. The owner should expect to edit it —
 * these are his guests' words, not ours — and the functions below take rules as
 * an argument precisely so a settings-managed list can replace this without any
 * code change.
 */
export const DEFAULT_THEME_RULES: ThemeRule[] = [
  { key: 'food_quality', label: 'Food quality', terms: [
    'food', 'taste', 'tasty', 'tasteless', 'delicious', 'flavour', 'flavor', 'bland',
    'undercooked', 'overcooked', 'stale', 'fresh', 'dish', 'dishes', 'biryani', 'curry',
    'starter', 'starters', 'dessert', 'quality of food', 'food quality'] },
  { key: 'service', label: 'Service and staff', terms: [
    'service', 'staff', 'waiter', 'waitress', 'server', 'attentive', 'rude', 'polite',
    'courteous', 'hospitality', 'manager', 'captain', 'unprofessional', 'friendly staff',
    'ignored us', 'no one came'] },
  { key: 'wait_time', label: 'Waiting and speed', terms: [
    'wait', 'waited', 'waiting', 'slow', 'delay', 'delayed', 'took forever', 'quick service',
    'prompt', 'long queue', 'queue', 'an hour', 'served late'] },
  { key: 'price_value', label: 'Price and value', terms: [
    'price', 'prices', 'pricey', 'expensive', 'overpriced', 'cheap', 'value for money',
    'worth the money', 'not worth', 'costly', 'bill', 'charges', 'extra charge'] },
  { key: 'ambience', label: 'Ambience and decor', terms: [
    'ambience', 'ambiance', 'atmosphere', 'decor', 'interior', 'vibe', 'lighting',
    'seating', 'comfortable', 'cosy', 'cozy', 'crowded', 'noisy', 'loud'] },
  { key: 'cleanliness', label: 'Cleanliness and hygiene', terms: [
    'clean', 'cleanliness', 'dirty', 'unhygienic', 'hygiene', 'hygienic', 'washroom',
    'toilet', 'restroom', 'smell', 'smelly', 'fly', 'flies', 'cockroach', 'insect', 'hair in'] },
  { key: 'music_events', label: 'Music and events', terms: [
    'music', 'dj', 'live band', 'band', 'singer', 'karaoke', 'performance', 'loud music',
    'dance floor'] },
  { key: 'drinks_bar', label: 'Drinks and bar', terms: [
    'cocktail', 'cocktails', 'mocktail', 'bar', 'beer', 'whisky', 'wine', 'drinks',
    'bartender', 'happy hour'] },
  { key: 'booking', label: 'Booking and reservations', terms: [
    'reservation', 'reserved', 'booking', 'booked', 'table booked', 'no table',
    'did not honour', 'walk in', 'walk-in'] },
  { key: 'parking', label: 'Parking and access', terms: [
    'parking', 'valet', 'park the car', 'no parking', 'hard to find', 'location is'] },
  { key: 'portion', label: 'Portion size', terms: [
    'portion', 'portions', 'quantity', 'small serving', 'serving size', 'filling'] },
  { key: 'party_events', label: 'Parties and functions', terms: [
    'birthday', 'anniversary', 'party', 'celebration', 'function', 'banquet',
    'corporate event', 'get together', 'get-together'] },
];

/* ── Matching ─────────────────────────────────────────────────────────────── */

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const escape = (s: string) => s.replace(ESCAPE_RE, '\\$&');

/**
 * A term becomes a case-insensitive regex with word boundaries at BOTH ends,
 * so "bar" matches "the bar was" and not "barely" or "rhubarb". Inside a
 * multi-word phrase, runs of whitespace are allowed to vary ("value for money"
 * matches "value  for money" and a line break between the words), because
 * review text is typed on phones.
 *
 * The limits are the same ones the call-topic engine learned: a term shorter
 * than 3 characters matches too much to be useful and is dropped rather than
 * silently producing noise.
 */
export const MIN_TERM_CHARS = 3;

export function termPattern(term: string): RegExp | null {
  const t = term.trim().toLowerCase();
  if (t.length < MIN_TERM_CHARS) return null;
  const body = escape(t).replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${body}([^\\p{L}\\p{N}]|$)`, 'iu');
}

export interface CompiledTheme { rule: ThemeRule; terms: Array<{ term: string; re: RegExp }> }

export function compileThemes(rules: ThemeRule[] = DEFAULT_THEME_RULES): CompiledTheme[] {
  return rules.map(rule => ({
    rule,
    terms: rule.terms
      .map(term => ({ term: term.trim().toLowerCase(), re: termPattern(term) }))
      .filter((x): x is { term: string; re: RegExp } => !!x.re),
  })).filter(c => c.terms.length > 0);
}

/** Which themes does this text mention, and on which words. Each theme counts
 *  AT MOST ONCE per review: a guest who says "food" five times is one review
 *  talking about food, not five. */
export function matchThemes(text: string, compiled: CompiledTheme[]):
    Array<{ key: string; label: string; matched: string[] }> {
  const body = (text || '').trim();
  if (!body) return [];
  const out: Array<{ key: string; label: string; matched: string[] }> = [];
  for (const c of compiled) {
    const matched: string[] = [];
    for (const { term, re } of c.terms) {
      if (re.test(body)) matched.push(term);
      if (matched.length >= 5) break;      // enough to explain the hit
    }
    if (matched.length) out.push({ key: c.rule.key, label: c.rule.label, matched });
  }
  return out;
}

/* ── Aggregation ──────────────────────────────────────────────────────────── */

export interface ThemeTally {
  key: string;
  label: string;
  /** Reviews mentioning this theme. */
  count: number;
  /** count / reviews that had any text — NOT / all reviews. A rating-only
   *  review cannot mention a theme, so including it in the denominator would
   *  understate every theme by however many silent 5-stars the venue collects. */
  share_of_text_reviews: number | null;
  /** Mean STAR RATING of the reviews that mention it. This is the only tone
   *  signal in this module and it comes from the guest's own rating, never from
   *  their words. */
  average_rating: number | null;
  low_count: number;
  /** A few review ids so a page can drill in without re-matching. */
  sample_ids: string[];
  /** The words that actually fired, most common first — so the owner can see
   *  WHY a review was filed under a theme and fix a rule that is over-matching. */
  top_terms: Array<{ term: string; count: number }>;
}

export interface ThemeReport {
  method: 'keyword';
  /** Printed verbatim by any surface that shows these numbers. */
  disclaimer: string;
  themes: ThemeTally[];
  text_reviews: number;
  /** Reviews with text that matched no rule at all. A large number here means
   *  the rule set is missing the venue's actual vocabulary, and it is shown so
   *  that gap is visible rather than being read as "guests said nothing". */
  unmatched: number;
  rules_used: number;
}

export const KEYWORD_DISCLAIMER =
  'Themes are counted by matching words and phrases in the review text. ' +
  'This is keyword matching, not sentiment analysis: it shows what guests ' +
  'mentioned, not how they felt. The average rating beside each theme is the ' +
  'guests’ own star rating.';

export function computeThemes(
  rows: AnalysisReview[],
  opts: { rules?: ThemeRule[]; sampleSize?: number } = {},
): ThemeReport {
  const compiled = compileThemes(opts.rules || DEFAULT_THEME_RULES);
  const sampleSize = Math.max(0, opts.sampleSize ?? 5);

  const acc = new Map<string, {
    label: string; count: number; sum: number; low: number; ids: string[]; terms: Map<string, number>;
  }>();

  let textReviews = 0;
  let unmatched = 0;

  for (const r of rows) {
    const text = (r.text || '').trim();
    if (!text) continue;
    textReviews++;
    const hits = matchThemes(text, compiled);
    if (!hits.length) { unmatched++; continue; }
    for (const h of hits) {
      let a = acc.get(h.key);
      if (!a) { a = { label: h.label, count: 0, sum: 0, low: 0, ids: [], terms: new Map() }; acc.set(h.key, a); }
      a.count++;
      a.sum += r.rating;
      if (r.rating <= 2) a.low++;
      if (a.ids.length < sampleSize) a.ids.push(r.id);
      for (const term of h.matched) a.terms.set(term, (a.terms.get(term) || 0) + 1);
    }
  }

  const themes: ThemeTally[] = [...acc.entries()].map(([key, a]) => ({
    key,
    label: a.label,
    count: a.count,
    share_of_text_reviews: textReviews ? round(a.count / textReviews, 4) : null,
    average_rating: a.count ? round(a.sum / a.count, 2) : null,
    low_count: a.low,
    sample_ids: a.ids,
    top_terms: [...a.terms.entries()]
      .map(([term, count]) => ({ term, count }))
      .sort((x, y) => y.count - x.count || x.term.localeCompare(y.term))
      .slice(0, 6),
  })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return {
    method: 'keyword',
    disclaimer: KEYWORD_DISCLAIMER,
    themes,
    text_reviews: textReviews,
    unmatched,
    rules_used: compiled.length,
  };
}

/**
 * The same tally split by period key, for "is 'wait time' getting worse?".
 * Deliberately a separate function: the headline theme table should not pay for
 * a per-period breakdown nobody asked to see.
 */
export function computeThemesByPeriod(
  rows: Array<AnalysisReview & { bucket: string }>,
  opts: { rules?: ThemeRule[] } = {},
): Record<string, ThemeReport> {
  const groups = new Map<string, AnalysisReview[]>();
  for (const r of rows) {
    const g = groups.get(r.bucket);
    if (g) g.push(r); else groups.set(r.bucket, [r]);
  }
  const out: Record<string, ThemeReport> = {};
  for (const [bucket, group] of groups) out[bucket] = computeThemes(group, opts);
  return out;
}
