import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

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
 *       all_super_categories: [...],
 *       ungrouped_count }
 *
 * POST /api/categories                                            admin only
 *   body: {
 *     assign?:    [{ category, super_category }]     // set parent for a leaf
 *     rename?:    [{ from, to }]                     // rename leaf category
 *     create?:    [{ category, super_category }]     // seed an empty leaf (no
 *                                                       material yet — placeholder)
 *   }
 */
export const dynamic = 'force-dynamic';

const KNOWN_SUPERS = [
  'Bar', 'Beverages',
  'Meat', 'Seafood',
  'Dairy', 'Produce', 'Vegetables', 'Fruits',
  'Grocery', 'Bakery', 'Spices', 'Frozen',
  'Housekeeping', 'Stationery', 'Fuel', 'Other',
];

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

    // Include every KNOWN_SUPERS bucket even if empty, so the UI lets the
    // admin assign categories under them.
    for (const s of KNOWN_SUPERS) {
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
      all_super_categories: KNOWN_SUPERS,
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

    const txn = db.transaction(() => {
      // Assign parent (super_category) to all materials in a given leaf
      if (Array.isArray(b.assign)) {
        const upd = db.prepare(`
          UPDATE raw_materials SET super_category = ?, updated_at = datetime('now')
          WHERE category = ?
        `);
        for (const a of b.assign) {
          const cat = String(a.category || '').trim();
          const sup = String(a.super_category || '').trim();
          if (!cat) continue;
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
          const sup = String(c.super_category || '').trim();
          if (!cat) continue;
          ins.run(cat, sup);
          created += 1;
        }
      }
    });
    txn();

    return Response.json({ ok: true, assigned, renamed, created });
  } catch (e: any) {
    console.error('[/api/categories]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
