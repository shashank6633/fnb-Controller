import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, requireRole } from '@/lib/auth';

export async function GET() {
  const db = getDb();
  const outlets = db.prepare(`SELECT * FROM outlets WHERE is_active = 1 ORDER BY is_default DESC, name ASC`).all();
  const me = await getCurrentUser();
  const currentOutletId = me ? (db.prepare('SELECT current_outlet_id FROM users WHERE id = ?').get(me.id) as any)?.current_outlet_id : null;
  return Response.json({ outlets, current_outlet_id: currentOutletId });
}

export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const { name, address, gstin } = await req.json();
  if (!name) return Response.json({ error: 'name required' }, { status: 400 });
  const db = getDb();
  const id = generateId();
  db.prepare(`INSERT INTO outlets (id, name, address, gstin) VALUES (?, ?, ?, ?)`)
    .run(id, name, address || '', gstin || '');
  return Response.json({ outlet: db.prepare('SELECT * FROM outlets WHERE id = ?').get(id) }, { status: 201 });
}

export async function PUT(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const { id, name, address, gstin, is_active } = await req.json();
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  const db = getDb();
  db.prepare(`
    UPDATE outlets SET
      name = COALESCE(?, name),
      address = COALESCE(?, address),
      gstin = COALESCE(?, gstin),
      is_active = COALESCE(?, is_active),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? null, address ?? null, gstin ?? null,
    is_active != null ? (is_active ? 1 : 0) : null,
    id,
  );
  return Response.json({ outlet: db.prepare('SELECT * FROM outlets WHERE id = ?').get(id) });
}
