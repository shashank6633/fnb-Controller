/**
 * CATEGORY ORDER — the one rule for "which shelf is this item on, and in what
 * order do the shelves come" on a requisition / purchasing list.
 *
 * It is the store desk's own rule (store-requisitions/page.tsx, the hand-over
 * sheet grouped category-wise), lifted here so a second screen can use it
 * without a local copy drifting:
 *   - a blank (or missing) category is "Uncategorised";
 *   - categories sort A-Z, case-insensitive, and "Uncategorised" always comes
 *     LAST, so a blank never sorts above a real shelf.
 *
 * ONE SHELF PER NAME, HOWEVER IT WAS TYPED. Two spellings of one category that
 * differ only in letter case or in spacing ("Grocery", "GROCERY", "grocery",
 * "  grocery  ", "dry  goods" / "dry goods") are the SAME shelf: the screens
 * upper-case the name, so two shelves would print the same label twice. The
 * rest of the app already treats a category case-insensitively
 * (inventory/route.ts matches the dept whitelist COLLATE NOCASE). So:
 *   - categoryKey   — what items are GROUPED, FILTERED and SORTED on:
 *                     trimmed, inner whitespace collapsed, lower-cased;
 *   - categoryLabel — what is PRINTED for one item: the same text with its own
 *                     letter case kept (trimmed, inner whitespace collapsed).
 * A category typed as "Uncategorised" (any case) shares the blank shelf, as on
 * the store desk, where a blank becomes that very word.
 *
 * Display only. Nothing here changes what a list contains, only how it is
 * grouped and ordered on screen. Live categories are lower-case slugs with no
 * stray spaces, so for them key === label === the stored text.
 */

/** The bucket an item with no category falls into (also its categoryKey). */
export const UNCATEGORISED = 'Uncategorised';

/** One item's category as printed: trimmed, inner runs of whitespace → one
 *  space, letter case kept; blank → "Uncategorised". */
export function categoryLabel(category: unknown): string {
  return String(category ?? '').trim().replace(/\s+/g, ' ') || UNCATEGORISED;
}

/** The category an item is GROUPED under: categoryLabel lower-cased, so case
 *  and spacing variants of one name are one group. Blank (or a category typed
 *  as "Uncategorised" in any case) → UNCATEGORISED. */
export function categoryKey(category: unknown): string {
  const k = categoryLabel(category).toLowerCase();
  return k === UNCATEGORISED.toLowerCase() ? UNCATEGORISED : k;
}

/**
 * Sort two category keys (as categoryKey returns them): A-Z, case-insensitive,
 * "Uncategorised" last. Keys are already lower-cased; two that differ only in
 * accents ("cafe" / "café") compare equal at base sensitivity and fall back to
 * a plain string order, so the order is total and one category's items can
 * never interleave with another's.
 */
export function compareCategory(a: string, b: string): number {
  if (a === b) return 0;
  if (a === UNCATEGORISED) return 1;
  if (b === UNCATEGORISED) return -1;
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : 1);
}
