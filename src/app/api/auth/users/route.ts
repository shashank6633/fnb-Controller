import { getDb } from '@/lib/db';
import { hashPassword, requireRole } from '@/lib/auth';

// No caching — admins expect immediate reflection of role changes.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Admin-only: list / create / update / delete app users.
export async function GET() {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const db = getDb();
  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.position, u.is_active, u.created_at, u.last_login_at,
           u.department_id, u.is_head_chef, u.is_store_manager, u.page_access, u.visible_department_ids,
           d.name AS department_name
    FROM users u
    LEFT JOIN departments d ON d.id = u.department_id
    ORDER BY u.name ASC
  `).all();
  return Response.json({ users });
}

const VALID_ROLES = ['admin', 'manager', 'staff'] as const;

export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const { email, name, role, password, position, department_id, is_head_chef, is_store_manager } = await req.json();
  if (!email || !password) return Response.json({ error: 'email + password required' }, { status: 400 });
  if (!VALID_ROLES.includes(role)) {
    return Response.json({ error: `role must be one of ${VALID_ROLES.join(', ')}` }, { status: 400 });
  }
  const db = getDb();
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (exists) return Response.json({ error: 'Email already in use' }, { status: 409 });
  const hash = await hashPassword(password);
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, position, department_id, is_head_chef, is_store_manager)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(email).toLowerCase(), hash, name || '', role,
    position || '',
    department_id || null,
    is_head_chef ? 1 : 0,
    is_store_manager ? 1 : 0,
  );
  return Response.json({ success: true }, { status: 201 });
}

export async function PUT(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const { id, name, role, is_active, password, position, department_id, is_head_chef, is_store_manager, page_access, visible_department_ids } = await req.json();
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  if (role != null && !VALID_ROLES.includes(role)) {
    return Response.json({ error: `role must be one of ${VALID_ROLES.join(', ')}` }, { status: 400 });
  }
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];
  if (name != null)             { sets.push('name = ?'); params.push(name); }
  if (role != null)             { sets.push('role = ?'); params.push(role); }
  if (is_active != null)        { sets.push('is_active = ?'); params.push(is_active ? 1 : 0); }
  if (position !== undefined)   { sets.push('position = ?'); params.push(position || ''); }
  if (department_id !== undefined) { sets.push('department_id = ?'); params.push(department_id || null); }
  if (is_head_chef !== undefined)     { sets.push('is_head_chef = ?');     params.push(is_head_chef ? 1 : 0); }
  if (is_store_manager !== undefined) { sets.push('is_store_manager = ?'); params.push(is_store_manager ? 1 : 0); }
  // page_access: array of paths → JSON string. null/[] clears the map (= full access).
  if (page_access !== undefined) {
    if (page_access === null || (Array.isArray(page_access) && page_access.length === 0)) {
      sets.push('page_access = NULL'); // no param push for NULL
    } else if (Array.isArray(page_access)) {
      sets.push('page_access = ?'); params.push(JSON.stringify(page_access));
    }
  }
  // visible_department_ids: array of dept IDs → JSON string. null/[] clears
  // (= only own dept visible — current default behavior).
  if (visible_department_ids !== undefined) {
    if (visible_department_ids === null || (Array.isArray(visible_department_ids) && visible_department_ids.length === 0)) {
      sets.push('visible_department_ids = NULL');
    } else if (Array.isArray(visible_department_ids)) {
      sets.push('visible_department_ids = ?'); params.push(JSON.stringify(visible_department_ids));
    }
  }
  if (password)         { sets.push('password_hash = ?'); params.push(await hashPassword(password)); }
  if (sets.length === 0) return Response.json({ error: 'nothing to update' }, { status: 400 });
  params.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return Response.json({ success: true });
}

export async function DELETE(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  const db = getDb();
  // Soft-delete (deactivate) — keeps PO audit trail intact
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(id);
  return Response.json({ success: true });
}
