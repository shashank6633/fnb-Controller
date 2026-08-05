/**
 * THE duplicate-line rule. ONE MATERIAL = ONE LINE — for a Purchase Order and,
 * since the owner's "YES WANT LIKE PO", for "Enter Full Bill" too.
 *
 * THIS FILE IMPORTS NOTHING, AND MUST KEEP IMPORTING NOTHING. Not @/lib/db, not
 * @/lib/auth, not @/lib/store-engine, not anything that transitively reaches
 * better-sqlite3 — not even a `import type` from a module that does, because a
 * type-only import is still a resolved module edge that can drag the graph in.
 * WHY: src/app/purchases/page.tsx is a 'use client' component and imports this
 * file. better-sqlite3 is a native Node addon; the moment it reaches the browser
 * bundle the production build breaks. `npm run build` is the tripwire, not tsc.
 *
 * NEVER IMPORT @/lib/po-helpers FROM HERE (cycle). The dependency is one-way:
 * po-helpers re-exports duplicateLineError/mergeDuplicateLines from this module
 * with `export … from`, which binds the SAME declarations, so the PO's public API
 * is identical by construction. An import back the other way would both close a
 * cycle and hand the client bundle the native driver through the back door.
 *
 * DO NOT RESTATE THIS RULE INLINE ANYWHERE, EVER AGAIN. It used to live in
 * po-helpers with a hand-written mirror in the bill modal; the mirror grew a
 * rate/GST/brand merge key and a "Keep both" escape hatch the PO never had, the
 * two silently disagreed about what a duplicate even is, and that drift is the
 * entire reason this module exists. Import it — do not copy it.
 *
 * NO SQL IN THIS FILE. Keep it that way and the template-literal trap (a stray
 * // or backtick inside a SQL string) can never bite here.
 */

/** A PO line, as far as the two duplicate helpers below care. Every field is
 *  optional and `unknown` because both run BEFORE the payload has been shape-
 *  validated, and the four call sites hand over four different row shapes: the
 *  composer posts {material_id, quantity, unit_price, vendor, …} with no material
 *  name at all, Smart Reorder's rows name the quantity `qty`
 *  (ReorderPoItemInput), and the requisition auto-PO carries material_name +
 *  notes. */
export type DedupeLineLike = {
  material_id?: unknown;
  material_name?: unknown;
  name?: unknown;
  quantity?: unknown;
  qty?: unknown;
  unit_price?: unknown;
  total_price?: unknown;
  notes?: unknown;
};

/** The dedupe key is material_id ALONE — deliberately NOT (material, vendor).
 *  A PO is one document; the same item from two vendors is two POs, not two
 *  lines on one. Trimmed to match lineSanityError, which validates and stores
 *  the trimmed id. */
export function lineKey(it: DedupeLineLike | null | undefined): string {
  return String(it?.material_id ?? '').trim();
}

/** Smart Reorder's row shape names the quantity `qty`; every other caller says
 *  `quantity`. Non-numeric reads as 0 — every caller of mergeDuplicateLines has
 *  already rejected a non-finite quantity by the time it merges. */
function lineQty(it: DedupeLineLike | null | undefined): number {
  const n = Number(it?.quantity ?? it?.qty);
  return Number.isFinite(n) ? n : 0;
}

function lineLabel(it: DedupeLineLike | null | undefined): string {
  return String(it?.material_name ?? it?.name ?? '').trim();
}

/** ONE MATERIAL = ONE LINE PER PO. Returns null when no material_id repeats,
 *  else the ready-to-return 400 message naming both 1-based line numbers.
 *  WHY THIS IS AN ERROR, NOT A SILENT SUM: two lines for one item double-order
 *  it, and [id]/receive books each line separately — two `purchases` rows, two
 *  stock credits and two passes through updateMaterialPrice's weighted average
 *  for a single delivered item.
 *  BLANK LINES ARE LEGAL AND SKIPPED: the composer opens with an empty row, so a
 *  missing/blank material_id is left to lineSanityError ("pick an item") — this
 *  helper must never turn two untouched draft rows into a duplicate error.
 *  PURE, NO DB — so it works on the raw payload before any lookup. The composer
 *  does not post a material name, so the label falls back to the id
 *  (MAT-01055): the same identifier lineSanityError already names in its own
 *  messages, and the one the user sees on the line. */
/* DELIBERATELY ITS OWN LOOP, NOT duplicateLineGroups() + pick-the-first.
 * Three PO routes hand this string straight to the user, and its semantics are
 * "the FIRST repeat, in line order, wins and short-circuits". Re-basing it on
 * the grouper would re-derive both of those from a different traversal for no
 * behavioural gain — a pure risk trade with nothing on the other side. The two
 * share lineKey(), which is the part that actually has to agree. */
export function duplicateLineError(
  items: readonly (DedupeLineLike | null | undefined)[] | null | undefined,
): string | null {
  const list = Array.isArray(items) ? items : [];
  const firstLine = new Map<string, number>();
  for (let i = 0; i < list.length; i++) {
    const key = lineKey(list[i]);
    if (!key) continue;
    const seen = firstLine.get(key);
    if (seen === undefined) { firstLine.set(key, i + 1); continue; }
    const label = lineLabel(list[i]) || lineLabel(list[seen - 1]) || key;
    return `Line ${i + 1} repeats an item already on line ${seen} (${label}) — put the full quantity on one line.`;
  }
  return null;
}

/** The GENERATED-path counterpart to duplicateLineError: folds a repeat line
 *  into its first occurrence instead of refusing the whole list. Only for lists
 *  a MACHINE assembled (Smart Reorder, the requisition auto-PO), where a repeat
 *  is an artefact of how the source rows were raised. A human authored specific
 *  numbers, so those paths must 400 — merging would order something nobody
 *  approved.
 *  SEMANTICS: quantity is summed onto the FIRST occurrence, which KEEPS its own
 *  unit_price / vendor / vendor_id (the merged line has to be bought at one
 *  rate from one vendor); notes are joined with ' | ', empties skipped;
 *  total_price is re-rounded to paise from qty × rate ONLY if the row shape
 *  carries one (the composer/auto-PO shapes compute it at insert instead).
 *  Input order is preserved, the caller's rows are never mutated, and a list
 *  with nothing repeated comes back as the SAME array — the clean path is
 *  bit-for-bit untouched. PURE, NO DB. */
export function mergeDuplicateLines<T extends DedupeLineLike>(items: T[]): T[] {
  if (!Array.isArray(items) || items.length < 2) return items;
  if (!duplicateLineError(items)) return items;

  const out: T[] = [];
  const firstIdx = new Map<string, number>();
  for (const it of items) {
    const key = lineKey(it);
    const idx = key ? firstIdx.get(key) : undefined;
    if (idx === undefined) {
      if (key) firstIdx.set(key, out.length);
      out.push({ ...it });                       // clone: the caller keeps its rows
      continue;
    }
    const first = out[idx] as unknown as Record<string, unknown>;
    // Write the sum back under the key the FIRST row already uses, so a
    // `qty`-shaped list stays `qty`-shaped for its caller's insert loop.
    const qtyKey = 'quantity' in first ? 'quantity' : ('qty' in first ? 'qty' : 'quantity');
    first[qtyKey] = lineQty(first) + lineQty(it);
    const notes = [first.notes, it.notes].map(n => String(n ?? '').trim()).filter(Boolean);
    if (notes.length) first.notes = notes.join(' | ');
    if ('total_price' in first) {
      const px = Number(first.unit_price);
      first.total_price = Math.round(lineQty(first) * (Number.isFinite(px) ? px : 0) * 100) / 100;
    }
  }
  return out;
}
/** A material that appears on 2+ lines, with both index bases the callers need:
 *  `indices` 0-based for highlighting rows in an array, `lineNos` 1-based for
 *  telling a human which lines to look at. */
export type DuplicateGroup = { key: string; indices: number[]; lineNos: number[] };

/** EVERY repeated material, not just the first — the UI counterpart to
 *  duplicateLineError, which short-circuits on the first repeat because a route
 *  only needs one sentence to 400 with. The bill modal instead has to highlight
 *  every offending row at once and name them all, so it needs the full picture.
 *  Same identity (lineKey → material_id alone) and the same "a blank material_id
 *  is a legal untouched draft row and is skipped" rule as duplicateLineError, so
 *  the two can never disagree about WHAT a duplicate is — only about how much
 *  they report. Groups come back in first-appearance order, each with 2+ entries.
 *  PURE, NO DB, and the caller's rows are never touched — only their positions
 *  are recorded. */
export function duplicateLineGroups(
  items: readonly (DedupeLineLike | null | undefined)[] | null | undefined,
): DuplicateGroup[] {
  const list = Array.isArray(items) ? items : [];
  const byKey = new Map<string, number[]>();
  const order: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const key = lineKey(list[i]);
    if (!key) continue;                       // blank rows are legal, see above
    const hit = byKey.get(key);
    if (hit) { hit.push(i); continue; }
    byKey.set(key, [i]);
    order.push(key);                          // first-appearance order, preserved
  }
  const out: DuplicateGroup[] = [];
  for (const key of order) {
    const indices = byKey.get(key)!;
    if (indices.length < 2) continue;
    out.push({ key, indices, lineNos: indices.map(i => i + 1) });
  }
  return out;
}

/** The one sentence that answers "but the bill really DOES charge two rates".
 *  SHARED ON PURPOSE: the client refusal in "Enter Full Bill" and the server's
 *  409 in /api/purchases both print this verbatim. Refusing a repeat is only
 *  fair if we say what to do instead, and the two surfaces must not say it
 *  differently — a storekeeper who sees one answer on screen and another in an
 *  error has been told nothing. Edit it here or not at all. */
export const SPLIT_RATE_REMEDY = 'If the bill really charges two rates for this item, put the full quantity on one line at the rate actually charged, or record the second rate as its own bill entry.';
