import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { ALL_PAGE_PATHS } from '@/lib/page-catalog';

// Admin-only: manage named roles (Floor Manager, Captain, Cashier, Bar Manager …).
// A role = a privilege tier (base_role) + a default page-access set. Assigning a
// role to a user drives both; per-user page_access still overrides.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const VALID_BASE = ['admin', 'manager', 'staff'] as const;

/** Keep only real catalog paths; null/empty → NULL (= all pages). */
function cleanPages(input: unknown): string | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const valid = input.filter((p) => typeof p === 'string' && ALL_PAGE_PATHS.includes(p));
  return valid.length ? JSON.stringify(valid) : null;
}

/** Coerce a max-discount-% input to a sane number in [0, 100]. Non-numeric → 0. */
function clampPct(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 100 ? 100 : n;
}

export async function GET() {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const db = getDb();
  // r.* already includes can_request_discount + max_discount_pct (schema columns),
  // but list them explicitly-adjacent via r.* so future SELECTs stay in sync.
  const roles = db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.is_active = 1) AS user_count
    FROM roles r WHERE r.is_active = 1
    ORDER BY r.sort_order ASC, r.name ASC
  `).all();
  return Response.json({ roles });
}

export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const { name, base_role, page_access, is_head_chef, is_store_manager, can_approve_requisitions, description, sort_order,
          can_request_discount, max_discount_pct } = await req.json();
  const nm = String(name || '').trim();
  if (!nm) return Response.json({ error: 'Role name is required' }, { status: 400 });
  if (!VALID_BASE.includes(base_role)) return Response.json({ error: `tier must be one of ${VALID_BASE.join(', ')}` }, { status: 400 });
  const db = getDb();
  if (db.prepare('SELECT id FROM roles WHERE lower(name) = lower(?)').get(nm)) {
    return Response.json({ error: 'A role with that name already exists' }, { status: 409 });
  }
  const info = db.prepare(`
    INSERT INTO roles (id, name, base_role, page_access, is_head_chef, is_store_manager, can_approve_requisitions, is_system, sort_order, description,
                       can_request_discount, max_discount_pct)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(nm, base_role, cleanPages(page_access), is_head_chef ? 1 : 0, is_store_manager ? 1 : 0,
         can_approve_requisitions ? 1 : 0,
         Number(sort_order) || 50, String(description || ''),
         can_request_discount ? 1 : 0, clampPct(max_discount_pct));
  return Response.json({ success: true, id: info.lastInsertRowid }, { status: 201 });
}

export async function PUT(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const { id, name, base_role, page_access, is_head_chef, is_store_manager, can_approve_requisitions, description, sort_order,
          can_request_discount, max_discount_pct } = await req.json();
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  if (base_role != null && !VALID_BASE.includes(base_role)) {
    return Response.json({ error: `tier must be one of ${VALID_BASE.join(', ')}` }, { status: 400 });
  }
  const db = getDb();
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as any;
  if (!role) return Response.json({ error: 'Role not found' }, { status: 404 });

  const sets: string[] = [];
  const params: any[] = [];
  // System roles (Administrator/Manager/Staff): allow page/flag edits, but not a
  // rename or a tier change (those underpin enforcement defaults).
  if (name != null && !role.is_system)        { sets.push('name = ?'); params.push(String(name).trim()); }
  if (base_role != null && !role.is_system)   { sets.push('base_role = ?'); params.push(base_role); }
  if (page_access !== undefined)              { sets.push('page_access = ?'); params.push(cleanPages(page_access)); }
  if (is_head_chef !== undefined)             { sets.push('is_head_chef = ?'); params.push(is_head_chef ? 1 : 0); }
  if (is_store_manager !== undefined)         { sets.push('is_store_manager = ?'); params.push(is_store_manager ? 1 : 0); }
  if (can_approve_requisitions !== undefined) { sets.push('can_approve_requisitions = ?'); params.push(can_approve_requisitions ? 1 : 0); }
  if (description !== undefined)              { sets.push('description = ?'); params.push(String(description || '')); }
  if (sort_order !== undefined)              { sets.push('sort_order = ?'); params.push(Number(sort_order) || 0); }
  if (can_request_discount !== undefined)    { sets.push('can_request_discount = ?'); params.push(can_request_discount ? 1 : 0); }
  if (max_discount_pct !== undefined)        { sets.push('max_discount_pct = ?'); params.push(clampPct(max_discount_pct)); }
  if (sets.length === 0) return Response.json({ error: 'nothing to update' }, { status: 400 });
  sets.push(`updated_at = datetime('now')`);
  params.push(id);
  db.prepare(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  // If the tier changed, re-sync the denormalized users.role for everyone on this
  // role so direct reads (the users list) stay correct. (getCurrentUser already
  // resolves the live tier, so enforcement was never stale.)
  if (base_role != null && !role.is_system && base_role !== role.base_role) {
    db.prepare('UPDATE users SET role = ? WHERE role_id = ?').run(base_role, id);
  }
  return Response.json({ success: true });
}

export async function DELETE(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  const db = getDb();
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as any;
  if (!role) return Response.json({ error: 'Role not found' }, { status: 404 });
  if (role.is_system) return Response.json({ error: 'Built-in roles cannot be deleted' }, { status: 400 });
  const inUse = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ? AND is_active = 1').get(id) as any;
  if (inUse.n > 0) return Response.json({ error: `Reassign the ${inUse.n} user(s) on this role first` }, { status: 409 });
  db.prepare('UPDATE roles SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?').run(id);
  return Response.json({ success: true });
}
