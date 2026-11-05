import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { canonNameInput } from './name-canon';

/* ════════════════════════════════════════════════════════════════════════════
 * PARENT CATEGORIES — the owner's list (ruling #87, 2026-10-28)
 * ════════════════════════════════════════════════════════════════════════════
 * Every raw material has a sub-category (raw_materials.category: Beers, Whisky,
 * Mutton …) and a PARENT (raw_materials.super_category: Bar, Meat, Dairy …).
 * The parents used to be two different hard-coded lists — KNOWN_SUPERS in
 * /api/categories (16 names, used by Inventory → Categories) and
 * SUPER_CATEGORIES on the Raw Materials item form (12 names, with "Liquor"
 * but no "Bar"). They now live in ONE settings row, managed by an admin under
 * Inventory → Categories → Manage Parents, and both screens read it.
 *
 * ── NAME, NOT KEY ─────────────────────────────────────────────────────────
 * Unlike department areas, the stored value IS the name: raw_materials and
 * category_placeholders carry the parent's NAME as free text. So renaming a
 * parent has to rewrite those two columns (and only those) — see renameParent
 * below, which does it inside the caller's transaction and reports the counts.
 * Names are matched case- and space-insensitively (parentMatchKey), the same
 * way the duplicate check reads them, so "bar" on an old item is counted under
 * the parent "Bar".
 *
 * ── NO BOOT WRITE ─────────────────────────────────────────────────────────
 * When the row is absent the 16 defaults below are returned as-is; nothing is
 * written until an admin changes something (scripts/check-boot-migrations.js
 * stays clean, and a fresh database needs no migration).
 *
 * ── SWITCHED OFF vs DELETED ───────────────────────────────────────────────
 * Switched off: still in the list, still named on every screen; the items and
 * sub-categories under it keep it, but it is no longer offered as a new choice
 * ("Under parent", "Move to parent", the item form).
 * Deleted: gone from the list — allowed only while NO item (switched-off items
 * included) and NO placeholder sub-category carries the name.
 * ═══════════════════════════════════════════════════════════════════════════ */

export const CATEGORY_PARENTS_KEY = 'category_parents';
export const PARENT_LABEL_MAX = 40;

export interface CategoryParent {
  label: string;
  active: boolean;
  sort: number;
}

/** The 16 parents that existed before the list became editable (the old
 *  KNOWN_SUPERS, in its order). */
export const DEFAULT_CATEGORY_PARENTS: readonly CategoryParent[] = Object.freeze(
  ['Bar', 'Beverages', 'Meat', 'Seafood', 'Dairy', 'Produce', 'Vegetables', 'Fruits',
    'Grocery', 'Bakery', 'Spices', 'Frozen', 'Housekeeping', 'Stationery', 'Fuel', 'Other']
    .map((label, i) => Object.freeze({ label, active: true, sort: (i + 1) * 10 })),
);

export interface ParentList {
  parents: CategoryParent[];
  /** 'default' = no saved row (the 16 defaults); 'saved' = the admin's list;
   *  'unreadable' = a saved row that is not a list — the defaults are shown
   *  until an admin saves again. */
  source: 'default' | 'saved' | 'unreadable';
  /** Saved entries that could not be read (empty name / duplicate). */
  ignored: number;
  raw: string | null;
}

const defaults = (): CategoryParent[] => DEFAULT_CATEGORY_PARENTS.map((p) => ({ ...p }));

const bySort = (a: CategoryParent, b: CategoryParent) =>
  a.sort - b.sort || a.label.localeCompare(b.label);

/** A name as stored: canonical (no invisible characters, single spaces,
 *  trimmed), case kept as typed. '' when nothing visible is left. */
export function cleanParentLabel(v: unknown): string {
  return canonNameInput(v);
}

/** How two parent names are compared: canonical and case-folded. "Bar",
 *  " bar " and "BAR" are the same parent. */
export function parentMatchKey(v: unknown): string {
  return canonNameInput(v).toLowerCase();
}

/** Names the screens already use for "no parent" — a parent with one of these
 *  names could not be told apart from the blank bucket. */
const RESERVED = new Set(['(ungrouped)', '(other)', '(none)', 'ungrouped', 'none']);
export function isReservedParentLabel(label: string): boolean {
  return RESERVED.has(parentMatchKey(label));
}

/** The list, read-only. Never writes — a missing row means "the defaults". */
export function readCategoryParents(db: Database.Database): ParentList {
  let raw: string | null = null;
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(CATEGORY_PARENTS_KEY) as
      { value?: string } | undefined;
    raw = r?.value ?? null;
  } catch {
    raw = null;
  }
  if (raw == null) return { parents: defaults(), source: 'default', ignored: 0, raw: null };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  if (!Array.isArray(parsed)) return { parents: defaults(), source: 'unreadable', ignored: 0, raw };
  const out: CategoryParent[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  parsed.forEach((rawEntry: unknown, i: number) => {
    const e = (rawEntry && typeof rawEntry === 'object' ? rawEntry : {}) as Record<string, unknown>;
    const label = cleanParentLabel(e.label).slice(0, PARENT_LABEL_MAX).trim();
    const k = parentMatchKey(label);
    if (!label || seen.has(k)) { ignored++; return; }
    seen.add(k);
    const sort = Number(e.sort);
    out.push({
      label,
      active: !(e.active === false || e.active === 0 || e.active === '0' || e.active === 'false'),
      sort: Number.isFinite(sort) ? sort : (i + 1) * 10,
    });
  });
  out.sort(bySort);
  return { parents: out, source: 'saved', ignored, raw };
}

/** Writes the whole list. Callers run it inside their own transaction. */
export function saveCategoryParents(db: Database.Database, parents: CategoryParent[]): void {
  const clean = [...parents].sort(bySort).map((p) => ({ label: p.label, active: !!p.active, sort: p.sort }));
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(CATEGORY_PARENTS_KEY, JSON.stringify(clean));
}

/** The list entry a name refers to (case/space-insensitive), if any. */
export function findParent(parents: CategoryParent[], name: unknown): CategoryParent | undefined {
  const k = parentMatchKey(name);
  return k ? parents.find((p) => parentMatchKey(p.label) === k) : undefined;
}

function placeholdersTableExists(db: Database.Database): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'category_placeholders'`).get();
}

export interface ParentUsage {
  /** The stored spellings that make up this parent, with how many rows carry each. */
  spellings: Map<string, number>;
  item_count: number;
  /** Of item_count, how many items are switched off. */
  inactive_item_count: number;
  placeholder_count: number;
  /** Distinct sub-categories under it: every non-blank raw_materials.category
   *  with this parent, plus placeholder sub-categories no item uses yet —
   *  the same leaves Inventory → Categories lists under it. */
  subcategories: Set<string>;
  /** The non-blank raw_materials.category values of its items — what "Move to
   *  parent" can move (it rewrites raw_materials only). */
  item_subcategories: Set<string>;
  /** Items carrying it with a BLANK sub-category: Inventory → Categories does
   *  not list them, so only the item form can give them another parent. */
  uncategorised_item_count: number;
  /** Every category_placeholders row carrying it, by name — including one whose
   *  name items now use (Inventory → Categories then lists that leaf under the
   *  items' parent, not here). "Move to parent" does NOT move these; adding the
   *  same name again under another parent ("Add a new sub-category") does. */
  placeholder_subcategories: Set<string>;
  /** Of placeholder_count, how many have a name no item uses yet. */
  placeholders_without_items: number;
}

/**
 * Who uses which parent, keyed by parentMatchKey. Read-only. Every row with a
 * non-blank super_category is counted — switched-off items included, because
 * they still carry the name and a delete would strand them.
 */
export function parentUsage(db: Database.Database): Map<string, ParentUsage> {
  const out = new Map<string, ParentUsage>();
  const slot = (stored: string): ParentUsage => {
    const k = parentMatchKey(stored);
    let u = out.get(k);
    if (!u) {
      u = {
        spellings: new Map(), item_count: 0, inactive_item_count: 0, placeholder_count: 0, subcategories: new Set(),
        item_subcategories: new Set(), uncategorised_item_count: 0, placeholder_subcategories: new Set(), placeholders_without_items: 0,
      };
      out.set(k, u);
    }
    return u;
  };
  const items = db.prepare(`
    SELECT super_category AS sup, TRIM(COALESCE(category, '')) AS category,
           COALESCE(is_active, 1) AS is_active, COUNT(*) AS n
      FROM raw_materials
     WHERE TRIM(COALESCE(super_category, '')) <> ''
     GROUP BY super_category, TRIM(COALESCE(category, '')), COALESCE(is_active, 1)
  `).all() as Array<{ sup: string; category: string; is_active: number; n: number }>;
  const liveLeaves = new Set(
    (db.prepare(`SELECT DISTINCT category FROM raw_materials WHERE category IS NOT NULL AND category != ''`)
      .all() as Array<{ category: string }>).map((r) => r.category),
  );
  for (const r of items) {
    if (!parentMatchKey(r.sup)) continue;
    const u = slot(r.sup);
    u.spellings.set(r.sup, (u.spellings.get(r.sup) || 0) + r.n);
    u.item_count += r.n;
    if (Number(r.is_active) === 0) u.inactive_item_count += r.n;
    if (r.category) {
      u.subcategories.add(r.category);
      u.item_subcategories.add(r.category);
    } else {
      u.uncategorised_item_count += r.n;
    }
  }
  if (placeholdersTableExists(db)) {
    const ph = db.prepare(`
      SELECT category, super_category AS sup FROM category_placeholders
       WHERE TRIM(COALESCE(super_category, '')) <> ''
    `).all() as Array<{ category: string; sup: string }>;
    for (const r of ph) {
      if (!parentMatchKey(r.sup)) continue;
      const u = slot(r.sup);
      u.spellings.set(r.sup, (u.spellings.get(r.sup) || 0) + 1);
      u.placeholder_count += 1;
      if (r.category) u.placeholder_subcategories.add(String(r.category));
      // A placeholder whose name an item already uses is shown under the
      // item's parent on the Categories page, not here (route.ts GET merge).
      if (r.category && !liveLeaves.has(r.category)) {
        u.subcategories.add(String(r.category).trim());
        u.placeholders_without_items += 1;
      }
    }
  }
  return out;
}

/** The spelling most rows carry — how an unlisted parent is named on screen. */
export function commonestSpelling(u: ParentUsage): string {
  let best = '';
  let n = -1;
  for (const [s, c] of u.spellings) {
    if (c > n || (c === n && s.localeCompare(best) < 0)) { best = s; n = c; }
  }
  return cleanParentLabel(best) || best;
}

export interface ParentRenameCounts {
  items_updated: number;
  placeholders_updated: number;
  /** The exact stored spellings that were rewritten. */
  spellings: string[];
}

/**
 * Rewrites every stored spelling of `fromKey` (a parentMatchKey) to `to` in
 * raw_materials.super_category and category_placeholders.super_category — and
 * nothing else: no other column, no category, no department / rule / store
 * mapping. Runs inside the CALLER's transaction.
 */
export function rewriteParentName(db: Database.Database, fromKey: string, to: string): ParentRenameCounts {
  const spellings = new Set<string>();
  const itemSp = db.prepare(`
    SELECT DISTINCT super_category AS sup FROM raw_materials WHERE TRIM(COALESCE(super_category, '')) <> ''
  `).all() as Array<{ sup: string }>;
  for (const r of itemSp) if (parentMatchKey(r.sup) === fromKey) spellings.add(r.sup);
  const hasPh = placeholdersTableExists(db);
  if (hasPh) {
    const phSp = db.prepare(`
      SELECT DISTINCT super_category AS sup FROM category_placeholders WHERE TRIM(COALESCE(super_category, '')) <> ''
    `).all() as Array<{ sup: string }>;
    for (const r of phSp) if (parentMatchKey(r.sup) === fromKey) spellings.add(r.sup);
  }
  let items = 0;
  let placeholders = 0;
  const updItems = db.prepare(`UPDATE raw_materials SET super_category = ? WHERE super_category = ?`);
  const updPh = hasPh ? db.prepare(`UPDATE category_placeholders SET super_category = ? WHERE super_category = ?`) : null;
  for (const s of spellings) {
    if (s === to) continue;
    items += updItems.run(to, s).changes;
    if (updPh) placeholders += updPh.run(to, s).changes;
  }
  return { items_updated: items, placeholders_updated: placeholders, spellings: [...spellings].filter((s) => s !== to).sort() };
}

/**
 * The audit row for a parent change, written INSIDE the caller's transaction.
 * Unlike logAuditEvent (which swallows a failed insert), this throws, so a
 * rename can never commit its item rewrite without its audit row.
 */
export function auditParentChange(db: Database.Database, p: {
  event_type: string;
  entity_id: string;
  actor_email: string;
  before: unknown;
  after: unknown;
  note: string;
}): void {
  db.prepare(`
    INSERT INTO audit_events
      (id, event_type, entity_type, entity_id, actor_email, outlet_id, before_json, after_json, note, created_at)
    VALUES (?, ?, 'category_parent', ?, ?, NULL, ?, ?, ?, datetime('now'))
  `).run(
    randomUUID(),
    p.event_type,
    p.entity_id,
    p.actor_email || '',
    p.before != null ? JSON.stringify(p.before) : null,
    p.after != null ? JSON.stringify(p.after) : null,
    p.note || '',
  );
}

/**
 * Validate a parent a sub-category is being put under (Inventory → Categories:
 * "Under parent" / "Move to parent").
 *   ''                         → no parent ("(Ungrouped)"), always allowed
 *   one of `keep` exactly      → allowed as-is (a sub-category may stay under
 *                                the parent it already has, even a switched-off
 *                                or unlisted one)
 *   a switched-ON parent       → allowed, stored with the list's spelling
 *   a switched-OFF parent      → refused (switch it on first)
 *   anything else              → refused (add it in Manage Parents first)
 */
export function checkParentChoice(
  parents: CategoryParent[],
  requested: unknown,
  keep: Set<string>,
): { ok: true; value: string } | { ok: false; error: string } {
  const v = cleanParentLabel(requested);
  if (!v) return { ok: true, value: '' };
  const rawStr = String(requested ?? '');
  if (keep.has(rawStr)) return { ok: true, value: rawStr };
  if (keep.has(v)) return { ok: true, value: v };
  const hit = findParent(parents, v);
  if (!hit) {
    return {
      ok: false,
      error: `"${v}" is not one of the parents in Manage Parents. Add it there first, or pick a parent from the list. Nothing was saved.`,
    };
  }
  if (!hit.active) {
    return {
      ok: false,
      error: `The parent "${hit.label}" is switched off, so nothing new can be put under it. Switch it on in Manage Parents first, or pick another parent. Nothing was saved.`,
    };
  }
  return { ok: true, value: hit.label };
}
