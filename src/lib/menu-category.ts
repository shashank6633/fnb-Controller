/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';

/**
 * MENU CATEGORY NAMES — the one place the rules live.
 *
 * Two server-side writers now put names into `menu_categories` and
 * `menu_items.category`: POST/PUT /api/menu-items/categories (the master) and
 * POST /api/menu-items/rename-category (the items + the master, in one
 * transaction). A third, POST /api/menu-items/import, mints a master row for an
 * unknown CSV category. If those disagreed about what counts as "the same
 * name", the NOCASE unique index would refuse a write one of them had already
 * promised, or two names that render identically would sit side by side. So the
 * cleaning and the comparison key are defined ONCE, here, and imported.
 *
 * (src/app/menu-items/page.tsx keeps its own copy on purpose — it is client
 * code and must not pull a server module in. It is documented there as having
 * to stay character-for-character in step with this file.)
 */

/** Long enough for the longest live category (28 chars), short enough to stay
 *  legible in the category chips and the guest menu's section heading. */
export const MAX_CATEGORY_LEN = 60;

/**
 * Clean an incoming category name before it is stored OR compared.
 *
 * `trim().toLowerCase()` alone is not enough: a name can carry characters that
 * take no space on screen, and those defeat the whole point of the duplicate
 * refusal. Proven on a copy of the live DB before this existed — `beer` renamed
 * to `"breads" + U+200B` returned 200 and left `breads` (4 items) and a second
 * `breads` (24 items) side by side, indistinguishable in the picker, on the
 * guest QR menu and in the audit note. A lone U+200B passed the "cannot be
 * blank" guard and produced a category that renders as nothing; `beer` ->
 * `"beer" + U+200B` passed the "nothing to rename" guard and silently changed
 * the key while every surface still read `Renamed "beer" to "beer"`.
 *
 *   · NFC first, so `café` typed as e + U+0301 is the same string as `café`.
 *   · Every kind of whitespace (NBSP, U+3000, tab, newline) becomes one plain
 *     space — a category name is a heading, not a paragraph.
 *   · Format and control characters (U+200B/200C/200D/2060/00AD/180E/FEFF and
 *     friends — Unicode Cf and Cc) are removed outright. They are invisible, so
 *     nobody can have meant to type one.
 *
 * Identity on all 47 live category names (verified), so nothing existing moves.
 */
const SPACEY = /[\p{Zs}\t\n\r\f\v]+/gu;
const FORMAT_OR_CONTROL = /[\p{Cf}\p{Cc}]/gu;
export function sanitizeCategoryName(s: unknown): string {
  return String(s ?? '')
    .normalize('NFC')
    .replace(SPACEY, ' ')
    .replace(FORMAT_OR_CONTROL, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** The comparison key for "does this name already exist?". Sanitised, then
 *  NFKC (folds compatibility look-alikes such as the ﬁ ligature) and lowercased
 *  — JS toLowerCase, never SQLite's LOWER(), which is ASCII-only and lets CAFÉ
 *  through against café. On the live all-ASCII category list this is exactly
 *  the old trim().toLowerCase(), so no existing name starts colliding. */
export function foldCategoryName(s: unknown): string {
  return sanitizeCategoryName(s).normalize('NFKC').toLowerCase();
}

export interface MenuCategoryRow {
  id: string;
  name: string;
  sort_order: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

/**
 * Find the master row for a name. The lookup is COLLATE NOCASE because that is
 * what the unique index enforces — asking with `=` alone would report "not
 * there" for a name the INSERT is about to be refused for.
 *
 * NOTE this is deliberately NOT the JS fold above: SQLite's NOCASE is
 * ASCII-only, so `CAFÉ` and `café` are two rows as far as the index is
 * concerned, and a lookup that folded harder than the index would claim a row
 * exists where the INSERT would happily create a second one. The index is the
 * boundary; this matches it exactly. The JS fold stays where it belongs — in
 * the refusal messages and the client-side warnings, which are allowed to be
 * stricter than the index.
 */
export function findMenuCategory(db: Database.Database, name: string): MenuCategoryRow | undefined {
  return db.prepare(`SELECT * FROM menu_categories WHERE name = ? COLLATE NOCASE`).get(name) as MenuCategoryRow | undefined;
}

/**
 * Make sure a category exists in the master, creating it at the end of the sort
 * order if it does not. Returns the row and whether this call created it.
 *
 * Used by the CSV importer, per the owner's instruction that an UNKNOWN
 * category in a file is ACCEPTED and CREATED so it can be edited afterwards —
 * never refused, never silently dropped.
 *
 * It does NOT reactivate a category that an admin has retired. A file naming a
 * deactivated category is not a request to un-retire it; the item keeps the
 * string (the item form shows it, marked, so a later edit cannot silently
 * change it) and the category stays out of the picker until an admin says
 * otherwise. Resurrecting it here would be the same class of bug as a boot
 * migration recomputing an admin's decision.
 *
 * MUST be called inside the caller's transaction: the importer runs one
 * db.transaction for the whole file, and a category minted for a row that then
 * fails has to roll back with it.
 */
export function ensureMenuCategory(
  db: Database.Database,
  rawName: string,
): { row: MenuCategoryRow; created: boolean } | null {
  const name = sanitizeCategoryName(rawName);
  if (!name || name.length > MAX_CATEGORY_LEN) return null;
  const existing = findMenuCategory(db, name);
  if (existing) return { row: existing, created: false };
  const next = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM menu_categories`).get() as any;
  const id = generateId();
  db.prepare(
    `INSERT INTO menu_categories (id, name, sort_order) VALUES (?, ?, ?)`,
  ).run(id, name, Number(next?.n || 0));
  const row = db.prepare(`SELECT * FROM menu_categories WHERE id = ?`).get(id) as MenuCategoryRow;
  return { row, created: true };
}
