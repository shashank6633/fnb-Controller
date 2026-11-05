import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { readCategoryParents, checkParentChoice } from '@/lib/category-parents';

/**
 * Category management — drives the parent/child hierarchy on raw_materials.
 *
 * raw_materials.super_category  → parent bucket  (Liquor, Meat, Dairy, Bar, ...)
 * raw_materials.category        → leaf bucket    (Beers, Whisky, Mutton, Butter, ...)
 *
 * The same leaf can live under one parent only — `super_category` is owned by
 * the LEAF here, so reassigning the parent reassigns every material in that leaf.
 *
 * GET  /api/categories
 *   → { groups: [{ super_category, leaves: [{ category, count, super_category }] }],
 *       all_super_categories: [...],   // the SWITCHED-ON parents of Manage Parents
 *       parents: [{ label, active }],  // the whole managed list (switched-off too)
 *       ungrouped_count }
 *
 * POST /api/categories                                            admin only
 *   body: {
 *     assign?:    [{ category, super_category }]     // set parent for a leaf
 *     rename?:    [{ from, to }]                     // rename leaf category
 *     create?:    [{ category, super_category }]     // seed an empty leaf (no
 *                                                       material yet — placeholder)
 *   }
 *   A parent given in assign / create must be a switched-ON parent of Manage
 *   Parents, blank (ungrouped), or the parent the leaf already has — otherwise
 *   the whole request is refused (400) and nothing is saved.
 *
 * The parents themselves (add / rename / switch off / delete) are managed by
 * /api/categories/parents (owner ruling #87); the list used to be a hard-coded
 * KNOWN_SUPERS here and now lives in src/lib/category-parents.ts.
 */
export const dynamic = 'force-dynamic';

/** Thrown inside the POST transaction to roll it back with a plain message. */
class ParentRefused extends Error {}

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();

    // Live categories from raw_materials, then merge in any placeholders
    // (empty leaves seeded via POST create — show up in dropdowns even before
    // a material uses them).
    db.exec(`
      CREATE TABLE IF NOT EXISTS category_placeholders (
        category TEXT PRIMARY KEY,
        super_category TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    const live = db.prepare(`
      SELECT category,
             COALESCE(super_category, '') AS super_category,
             COUNT(*) AS count
      FROM raw_materials
      WHERE category IS NOT NULL AND category != ''
      GROUP BY category, super_category
      ORDER BY super_category, category
    `).all() as { category: string; super_category: string; count: number }[];
    const placeholders = db.prepare(`
      SELECT category, super_category, 0 AS count FROM category_placeholders
    `).all() as { category: string; super_category: string; count: number }[];
    // Merge: live wins on count, placeholder fills only if leaf is brand-new.
    const liveKeys = new Set(live.map(r => r.category));
    const rows = [...live, ...placeholders.filter(p => !liveKeys.has(p.category))];

    // Group leaves by super_category, with an "(Ungrouped)" bucket for leaves
    // that don't yet have a super_category set.
    const byParent = new Map<string, { category: string; count: number; super_category: string }[]>();
    for (const r of rows) {
      const p = r.super_category || '';
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p)!.push(r);
    }

    // Include every switched-ON managed parent's bucket even if empty, so the
    // UI lets the admin assign categories under them. (Switched-off parents
    // appear only when something still sits under them.)
    const managed = readCategoryParents(db).parents;
    const activeSupers = managed.filter(p => p.active).map(p => p.label);
    for (const s of activeSupers) {
      if (!byParent.has(s)) byParent.set(s, []);
    }

    const groups = Array.from(byParent.entries())
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
      .map(([super_category, leaves]) => ({
        super_category: super_category || '(Ungrouped)',
        super_category_raw: super_category,
        leaves: leaves.sort((x, y) => x.category.localeCompare(y.category)),
      }));

    return Response.json({
      groups,
      all_super_categories: activeSupers,
      parents: managed.map(p => ({ label: p.label, active: p.active })),
      ungrouped_count: rows.filter(r => !r.super_category).length,
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }
    const db = getDb();
    const b = await request.json();

    let assigned = 0, renamed = 0, created = 0;

    // The parent a leaf is put under must be a switched-ON parent of Manage
    // Parents, blank, or one the leaf already has (so a leaf under a
    // switched-off / unlisted parent can stay there).
    const parents = readCategoryParents(db).parents;
    const hasPlaceholders = () => !!db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'category_placeholders'`).get();
    const currentParents = (cat: string): Set<string> => {
      const s = new Set((db.prepare(`SELECT DISTINCT COALESCE(super_category, '') AS sup FROM raw_materials WHERE category = ?`)
        .all(cat) as { sup: string }[]).map(r => r.sup));
      if (hasPlaceholders()) {
        const p = db.prepare(`SELECT super_category AS sup FROM category_placeholders WHERE category = ?`).get(cat) as { sup: string } | undefined;
        if (p) s.add(p.sup);
      }
      return s;
    };
    const parentFor = (cat: string, sup: unknown): string => {
      const chk = checkParentChoice(parents, sup, currentParents(cat));
      if (!chk.ok) throw new ParentRefused(chk.error);
      return chk.value;
    };

    const txn = db.transaction(() => {
      // Assign parent (super_category) to all materials in a given leaf
      if (Array.isArray(b.assign)) {
        const upd = db.prepare(`
          UPDATE raw_materials SET super_category = ?, updated_at = datetime('now')
          WHERE category = ?
        `);
        for (const a of b.assign) {
          const cat = String(a.category || '').trim();
          if (!cat) continue;
          const sup = parentFor(cat, String(a.super_category || '').trim());
          const r = upd.run(sup, cat);
          assigned += r.changes;
        }
      }

      // Rename a leaf (merges if target exists)
      if (Array.isArray(b.rename)) {
        const upd = db.prepare(`
          UPDATE raw_materials SET category = ?, updated_at = datetime('now')
          WHERE category = ?
        `);
        for (const rn of b.rename) {
          const from = String(rn.from || '').trim();
          const to = String(rn.to || '').trim();
          if (!from || !to || from === to) continue;
          const r = upd.run(to, from);
          renamed += r.changes;
        }
      }

      // Create placeholder leaves (no materials yet, but the leaf shows up
      // in dropdowns). We store these in a tiny aux table so they survive
      // even when no real material uses them.
      db.exec(`
        CREATE TABLE IF NOT EXISTS category_placeholders (
          category TEXT PRIMARY KEY,
          super_category TEXT NOT NULL DEFAULT '',
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      if (Array.isArray(b.create)) {
        const ins = db.prepare(`
          INSERT INTO category_placeholders (category, super_category)
          VALUES (?, ?)
          ON CONFLICT(category) DO UPDATE SET super_category = excluded.super_category
        `);
        for (const c of b.create) {
          const cat = String(c.category || '').trim();
          if (!cat) continue;
          const sup = parentFor(cat, String(c.super_category || '').trim());
          ins.run(cat, sup);
          created += 1;
        }
      }
    });
    txn();

    return Response.json({ ok: true, assigned, renamed, created });
  } catch (e: any) {
    if (e instanceof ParentRefused) return Response.json({ error: e.message }, { status: 400 });
    console.error('[/api/categories]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
