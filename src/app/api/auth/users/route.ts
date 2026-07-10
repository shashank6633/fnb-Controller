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
           u.preferred_zones, u.preferred_table_ids, u.section,
           u.role_id, r.name AS role_name,
           d.name AS department_name
    FROM users u
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN roles r ON r.id = u.role_id AND r.is_active = 1
    ORDER BY u.name ASC
  `).all();
  return Response.json({ users });
}

const VALID_ROLES = ['admin', 'manager', 'staff'] as const;
// Parent Role / functional section (per-user). '' = unset.
const VALID_SECTIONS = ['Kitchen', 'Bar', 'Service', 'Maintenance', 'Store', 'GRE'] as const;
function normSection(v: any): string | null {
  if (v == null) return '';
  const s = String(v).trim();
  if (s === '') return '';
  const hit = VALID_SECTIONS.find(x => x.toLowerCase() === s.toLowerCase());
  return hit || null; // null = invalid → caller rejects
}

/**
 * Resolve the effective privilege tier + flags for a user save. When a named
 * role_id is given, its base_role + flags win (the named role is the source of
 * truth); otherwise fall back to the explicitly-passed role + flags (legacy).
 * Returns null role_id if the role doesn't exist.
 */
function resolveRole(db: any, role_id: any, explicitRole: any, explicitChef: any, explicitStore: any) {
  if (role_id) {
    const r = db.prepare('SELECT id, base_role, is_head_chef, is_store_manager FROM roles WHERE id = ? AND is_active = 1').get(role_id) as any;
    if (r) return { role_id: r.id, role: r.base_role, is_head_chef: !!r.is_head_chef, is_store_manager: !!r.is_store_manager };
  }
  return { role_id: null, role: explicitRole, is_head_chef: !!explicitChef, is_store_manager: !!explicitStore };
}

export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const { email, name, role, role_id, password, position, department_id, is_head_chef, is_store_manager, section } = await req.json();
  if (!email || !password) return Response.json({ error: 'email + password required' }, { status: 400 });
  const sec = normSection(section);
  if (sec === null) return Response.json({ error: `section must be one of ${VALID_SECTIONS.join(', ')}` }, { status: 400 });
  const db = getDb();
  const eff = resolveRole(db, role_id, role, is_head_chef, is_store_manager);
  if (!VALID_ROLES.includes(eff.role)) {
    return Response.json({ error: `role must be one of ${VALID_ROLES.join(', ')}` }, { status: 400 });
  }
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (exists) return Response.json({ error: 'Email already in use' }, { status: 409 });
  const hash = await hashPassword(password);
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, role_id, position, department_id, is_head_chef, is_store_manager, section)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(email).toLowerCase(), hash, name || '', eff.role, eff.role_id,
    position || '',
    department_id || null,
    eff.is_head_chef ? 1 : 0,
    eff.is_store_manager ? 1 : 0,
    sec,
  );
  return Response.json({ success: true }, { status: 201 });
}

export async function PUT(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const b = await req.json();
  const { id, name, is_active, password, position, department_id, page_access, visible_department_ids, preferred_zones, preferred_table_ids } = b;
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];
  if (name != null)             { sets.push('name = ?'); params.push(name); }
  if (is_active != null)        { sets.push('is_active = ?'); params.push(is_active ? 1 : 0); }
  if (position !== undefined)   { sets.push('position = ?'); params.push(position || ''); }
  if (department_id !== undefined) { sets.push('department_id = ?'); params.push(department_id || null); }
  if (b.section !== undefined) {
    const sec = normSection(b.section);
    if (sec === null) return Response.json({ error: `section must be one of ${VALID_SECTIONS.join(', ')}` }, { status: 400 });
    sets.push('section = ?'); params.push(sec);
  }
  // Role: if role_id is present, resolve the named role (its tier + flags win);
  // if absent, honor any explicit role/flags (legacy edit).
  if ('role_id' in b) {
    const eff = resolveRole(db, b.role_id, b.role, b.is_head_chef, b.is_store_manager);
    if (eff.role != null && !VALID_ROLES.includes(eff.role)) {
      return Response.json({ error: `role must be one of ${VALID_ROLES.join(', ')}` }, { status: 400 });
    }
    sets.push('role_id = ?'); params.push(eff.role_id);
    if (eff.role != null) { sets.push('role = ?'); params.push(eff.role); }
    sets.push('is_head_chef = ?'); params.push(eff.is_head_chef ? 1 : 0);
    sets.push('is_store_manager = ?'); params.push(eff.is_store_manager ? 1 : 0);
  } else {
    if (b.role != null) {
      if (!VALID_ROLES.includes(b.role)) return Response.json({ error: `role must be one of ${VALID_ROLES.join(', ')}` }, { status: 400 });
      sets.push('role = ?'); params.push(b.role);
    }
    if (b.is_head_chef !== undefined)     { sets.push('is_head_chef = ?');     params.push(b.is_head_chef ? 1 : 0); }
    if (b.is_store_manager !== undefined) { sets.push('is_store_manager = ?'); params.push(b.is_store_manager ? 1 : 0); }
  }
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
  // Captain area assignment: JSON arrays of allowed zones + table ids. null/[] clears
  // (= all areas). Only enforced when the captain_area_lock setting is on.
  if (preferred_zones !== undefined) {
    if (preferred_zones === null || (Array.isArray(preferred_zones) && preferred_zones.length === 0)) sets.push('preferred_zones = NULL');
    else if (Array.isArray(preferred_zones)) { sets.push('preferred_zones = ?'); params.push(JSON.stringify(preferred_zones)); }
  }
  if (preferred_table_ids !== undefined) {
    if (preferred_table_ids === null || (Array.isArray(preferred_table_ids) && preferred_table_ids.length === 0)) sets.push('preferred_table_ids = NULL');
    else if (Array.isArray(preferred_table_ids)) { sets.push('preferred_table_ids = ?'); params.push(JSON.stringify(preferred_table_ids)); }
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
