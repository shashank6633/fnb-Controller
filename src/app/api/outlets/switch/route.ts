import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  const { outlet_id } = await req.json();
  if (!outlet_id) return Response.json({ error: 'outlet_id required' }, { status: 400 });
  const db = getDb();
  const o = db.prepare('SELECT id FROM outlets WHERE id = ? AND is_active = 1').get(outlet_id);
  if (!o) return Response.json({ error: 'Outlet not found or inactive' }, { status: 404 });
  db.prepare('UPDATE users SET current_outlet_id = ? WHERE id = ?').run(outlet_id, me.id);
  return Response.json({ success: true, outlet_id });
}
