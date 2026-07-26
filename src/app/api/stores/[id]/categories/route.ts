import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { getStoreById, catNorm } from '@/lib/store-engine';

/**
 * Category mappings for one store — which raw_materials.category values the
 * store OWNS (drives materialStoreId + the Phase B central-store guard).
 * Matching is COLLATE NOCASE (column collation) + TRIM'd values on write.
 *
 * POST   /api/stores/[id]/categories  { category }        add        admin
 * PUT    /api/stores/[id]/categories  { from, to }        rename     admin
 * DELETE /api/stores/[id]/categories  { category }        remove     admin
 *        (DELETE also accepts ?category= for clients that can't send a body)
 */
export const dynamic = 'force-dynamic';

async function gate(params: Promise<{ id: string }>) {
  const auth = await requireRole('admin');
  if (!auth.ok) return { err: Response.json({ error: auth.message }, { status: auth.status }) };
  const { id } = await params;
  const db = getDb();
  const store = getStoreById(db, id);
  if (!store) return { err: Response.json({ error: 'Store not found' }, { status: 404 }) };
  return { db, store };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const g = await gate(params);
    if ('err' in g) return g.err;
    const b = await request.json();
    const category = String(b.category || '').trim();
    if (!category) return Response.json({ error: 'category is required' }, { status: 400 });

    // One owner per category across ALL stores — otherwise materialStoreId is
    // ambiguous. Compare with catNorm, the SAME normalisation every match uses
    // (case-, space-, hyphen- and underscore-insensitive). A TRIM/NOCASE compare
    // let 'RED WINE' onto a second store while 'red-wine' sat on the first: the
    // guard saw two different strings, but every lookup sees one category.
    const owner = g.db.prepare(`
      SELECT s.name, m.category FROM store_category_map m JOIN store_locations s ON s.id = m.store_id
      WHERE ${catNorm('m.category')} = ${catNorm('?')} AND m.store_id != ?
    `).get(category, g.store.id) as any;
    if (owner) {
      const spelt = String(owner.category || '').trim();
      const note = spelt && spelt.toLowerCase() !== category.toLowerCase() ? ` (spelt "${spelt}" there — same category)` : '';
      return Response.json({ error: `"${category}" is already mapped to ${owner.name}${note}` }, { status: 409 });
    }
    // Same normalisation WITHIN this store, so a separator variant of a category
    // the store already owns is rejected instead of silently adding a duplicate
    // row that only clutters the chip list.
    const mine = g.db.prepare(`
      SELECT category FROM store_category_map
      WHERE store_id = ? AND ${catNorm('category')} = ${catNorm('?')}
    `).get(g.store.id, category) as any;
    if (mine) {
      const spelt = String(mine.category || '').trim();
      const note = spelt && spelt.toLowerCase() !== category.toLowerCase() ? ` as "${spelt}"` : '';
      return Response.json({ error: `"${category}" is already mapped to ${g.store.name}${note}` }, { status: 409 });
    }

    const r = g.db.prepare(`
      INSERT OR IGNORE INTO store_category_map (id, store_id, category)
      VALUES (lower(hex(randomblob(16))), ?, ?)
    `).run(g.store.id, category);
    if (r.changes === 0) return Response.json({ error: `"${category}" is already mapped to ${g.store.name}` }, { status: 409 });
    return Response.json({ ok: true, added: category }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/stores/[id]/categories POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const g = await gate(params);
    if ('err' in g) return g.err;
    const b = await request.json();
    const from = String(b.from || '').trim();
    const to = String(b.to || '').trim();
    if (!from || !to) return Response.json({ error: 'from + to are required' }, { status: 400 });

    // catNorm, matching the POST guard and every lookup — a TRIM/NOCASE clash
    // check let a rename land on a separator variant of a category another store
    // (or this one) already owns. The NOT (…) clause exempts the row being renamed.
    const clash = g.db.prepare(`
      SELECT s.name, m.category FROM store_category_map m JOIN store_locations s ON s.id = m.store_id
      WHERE ${catNorm('m.category')} = ${catNorm('?')}
        AND NOT (m.store_id = ? AND ${catNorm('m.category')} = ${catNorm('?')})
    `).get(to, g.store.id, from) as any;
    if (clash) {
      const spelt = String(clash.category || '').trim();
      const note = spelt && spelt.toLowerCase() !== to.toLowerCase() ? ` (spelt "${spelt}" — same category)` : '';
      return Response.json({ error: `"${to}" is already mapped to ${clash.name}${note}` }, { status: 409 });
    }

    const r = g.db.prepare(`
      UPDATE store_category_map SET category = ?
      WHERE store_id = ? AND TRIM(category) = TRIM(?) COLLATE NOCASE
    `).run(to, g.store.id, from);
    if (r.changes === 0) return Response.json({ error: `"${from}" is not mapped to ${g.store.name}` }, { status: 404 });
    return Response.json({ ok: true, renamed: r.changes });
  } catch (e: any) {
    console.error('[/api/stores/[id]/categories PUT]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const g = await gate(params);
    if ('err' in g) return g.err;
    let category = new URL(request.url).searchParams.get('category') || '';
    if (!category) {
      try { category = String((await request.json())?.category || ''); } catch { /* no body */ }
    }
    category = category.trim();
    if (!category) return Response.json({ error: 'category is required' }, { status: 400 });

    const r = g.db.prepare(`
      DELETE FROM store_category_map
      WHERE store_id = ? AND TRIM(category) = TRIM(?) COLLATE NOCASE
    `).run(g.store.id, category);
    if (r.changes === 0) return Response.json({ error: `"${category}" is not mapped to ${g.store.name}` }, { status: 404 });
    return Response.json({ ok: true, removed: r.changes });
  } catch (e: any) {
    console.error('[/api/stores/[id]/categories DELETE]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
