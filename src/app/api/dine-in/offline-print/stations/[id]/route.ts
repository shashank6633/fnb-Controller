import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/** Update / delete a single print station. Additive config only. */
export const dynamic = 'force-dynamic';

const FIELDS = ['name', 'role', 'station', 'transport', 'target', 'paper_width', 'copies', 'is_active', 'sort_order'] as const;

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && me.role !== 'manager') {
      return Response.json({ error: 'Admin or manager only' }, { status: 403 });
    }
    const { id } = await params;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM print_stations WHERE id = ?').get(id) as any;
    if (!existing) return Response.json({ error: 'Station not found' }, { status: 404 });

    const b = await request.json();
    const sets: string[] = [];
    const vals: any[] = [];
    for (const f of FIELDS) {
      if (!(f in b)) continue;
      let v: any = b[f];
      if (f === 'role') v = v === 'bill' ? 'bill' : 'kot';
      else if (f === 'transport') v = v === 'usb' ? 'usb' : 'ip';
      else if (f === 'paper_width') v = Number(v) === 32 ? 32 : 48;
      else if (f === 'copies') v = Math.max(1, Math.min(5, Number(v) || 1));
      else if (f === 'is_active') v = v ? 1 : 0;
      else if (f === 'sort_order') v = Number(v) || 0;
      else v = String(v ?? '').trim();
      sets.push(`${f} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return Response.json({ station: existing });
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    db.prepare(`UPDATE print_stations SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    const updated = db.prepare('SELECT * FROM print_stations WHERE id = ?').get(id);
    return Response.json({ station: updated });
  } catch (e: any) {
    console.error('[/api/dine-in/offline-print/stations/[id] PATCH]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && me.role !== 'manager') {
      return Response.json({ error: 'Admin or manager only' }, { status: 403 });
    }
    const { id } = await params;
    const db = getDb();
    const r = db.prepare('DELETE FROM print_stations WHERE id = ?').run(id);
    if (r.changes === 0) return Response.json({ error: 'Station not found' }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('[/api/dine-in/offline-print/stations/[id] DELETE]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
