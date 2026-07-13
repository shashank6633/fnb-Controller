import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { getStoreById } from '@/lib/store-engine';

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

    // One owner per category across ALL stores — otherwise materialStoreId
    // would be ambiguous. NOCASE + TRIM comparison.
    const owner = g.db.prepare(`
      SELECT s.name FROM store_category_map m JOIN store_locations s ON s.id = m.store_id
      WHERE TRIM(m.category) = TRIM(?) COLLATE NOCASE AND m.store_id != ?
    `).get(category, g.store.id) as any;
    if (owner) return Response.json({ error: `"${category}" is already mapped to ${owner.name}` }, { status: 409 });

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

    const clash = g.db.prepare(`
      SELECT s.name FROM store_category_map m JOIN store_locations s ON s.id = m.store_id
      WHERE TRIM(m.category) = TRIM(?) COLLATE NOCASE
        AND NOT (m.store_id = ? AND TRIM(m.category) = TRIM(?) COLLATE NOCASE)
    `).get(to, g.store.id, from) as any;
    if (clash) return Response.json({ error: `"${to}" is already mapped to ${clash.name}` }, { status: 409 });

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
