import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

// Disable any caching — the list changes immediately on import / edit and we want
// the browser to always see a fresh count.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Departments — Bar, Hot Kitchen, Cold Kitchen, Pastry, Bakery, etc.
 *
 * GET    /api/departments              → list (with member + open-req counts)
 * GET    /api/departments?id=X         → single
 * POST   /api/departments               admin-only
 *        body: { name, code?, description?, head_chef_user_id? }
 * PUT    /api/departments               admin-only
 * DELETE /api/departments?id=X          admin-only — soft-delete (is_active=0)
 */
export async function GET(request: Request) {
  try {
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (id) {
      const row = db.prepare(`
        SELECT d.*, u.name AS head_chef_name, u.email AS head_chef_email,
               hu.name AS head_user_name, hu.email AS head_user_email,
               p.name AS parent_name
        FROM departments d
        LEFT JOIN users u ON u.id = d.head_chef_user_id
        LEFT JOIN users hu ON hu.id = d.head_user_id
        LEFT JOIN departments p ON p.id = d.parent_id
        WHERE d.id = ?
      `).get(id);
      if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json({ department: row });
    }
    const rows = db.prepare(`
      SELECT d.*,
             u.name  AS head_chef_name,
             u.email AS head_chef_email,
             hu.name  AS head_user_name,
             hu.email AS head_user_email,
             p.name  AS parent_name,
             (SELECT COUNT(*) FROM users WHERE department_id = d.id AND is_active = 1) AS member_count,
             (SELECT COUNT(*) FROM requisitions
               WHERE department_id = d.id
                 AND status NOT IN ('fulfilled', 'cancelled', 'chef_rejected')) AS open_requisition_count
      FROM departments d
      LEFT JOIN users u ON u.id = d.head_chef_user_id
      LEFT JOIN users hu ON hu.id = d.head_user_id
      LEFT JOIN departments p ON p.id = d.parent_id
      ORDER BY (d.parent_id IS NOT NULL), d.is_active DESC, d.name ASC
    `).all();
    console.log(`[/api/departments GET] returning ${(rows as any[]).length} departments`);
    return Response.json({ departments: rows });
  } catch (e: any) {
    console.error('[/api/departments GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const db = getDb();
    const b = await request.json();
    if (!b.name || !String(b.name).trim()) {
      return Response.json({ error: 'name required' }, { status: 400 });
    }
    const id = generateId();
    db.prepare(`
      INSERT INTO departments (id, name, code, description, head_chef_user_id, head_user_id, parent_id, is_active, submission_windows, submission_grace_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, String(b.name).trim(), b.code || '', b.description || '', b.head_chef_user_id || null,
            b.head_user_id || null, b.parent_id || null,
            String(b.submission_windows || '').trim(),
            b.submission_grace_minutes != null ? Number(b.submission_grace_minutes) : 30);
    const row = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
    return Response.json({ department: row }, { status: 201 });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const db = getDb();
    const b = await request.json();
    if (!b.id) return Response.json({ error: 'id required' }, { status: 400 });
    // material_categories: array of category names → JSON string. Empty array
    // or null clears the whitelist (= dept sees all materials).
    let matCatsJson: string | null | undefined;
    if (b.material_categories !== undefined) {
      if (Array.isArray(b.material_categories) && b.material_categories.length > 0) {
        matCatsJson = JSON.stringify(b.material_categories);
      } else {
        matCatsJson = null;
      }
    }
    db.prepare(`
      UPDATE departments SET
        name              = COALESCE(?, name),
        code              = COALESCE(?, code),
        description       = COALESCE(?, description),
        head_chef_user_id = ?,
        is_active         = COALESCE(?, is_active),
        submission_windows       = COALESCE(?, submission_windows),
        submission_grace_minutes = COALESCE(?, submission_grace_minutes),
        material_categories      = CASE WHEN ? = 1 THEN ? ELSE material_categories END,
        parent_id                = CASE WHEN ? = 1 THEN ? ELSE parent_id END,
        head_user_id             = CASE WHEN ? = 1 THEN ? ELSE head_user_id END,
        updated_at        = datetime('now')
      WHERE id = ?
    `).run(
      b.name ?? null, b.code ?? null, b.description ?? null,
      b.head_chef_user_id !== undefined ? b.head_chef_user_id : null,
      b.is_active != null ? (b.is_active ? 1 : 0) : null,
      b.submission_windows ?? null,
      b.submission_grace_minutes != null ? Number(b.submission_grace_minutes) : null,
      // CASE flag: 1 if caller explicitly sent material_categories, else 0 (keep old value)
      b.material_categories !== undefined ? 1 : 0,
      matCatsJson ?? null,
      // parent_id / head_user_id: CASE flag so they can be set OR cleared to NULL
      b.parent_id !== undefined ? 1 : 0,
      b.parent_id ?? null,
      b.head_user_id !== undefined ? 1 : 0,
      b.head_user_id ?? null,
      b.id,
    );
    const row = db.prepare('SELECT * FROM departments WHERE id = ?').get(b.id);
    return Response.json({ department: row });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    db.prepare(`UPDATE departments SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    return Response.json({ success: true });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
