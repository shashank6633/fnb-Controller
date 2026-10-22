import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { ALL_PAGE_PATHS } from '@/lib/page-catalog';

// Admin-only: manage named roles (Floor Manager, Captain, Cashier, Bar Manager …).
// A role = a privilege tier (base_role) + a default page-access set. Assigning a
// role to a user drives both; per-user page_access still overrides.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const VALID_BASE = ['admin', 'manager', 'staff'] as const;

/**
 * Keep only real catalog paths. THREE outcomes, and the difference between the
 * last two is a privilege boundary:
 *
 *   · nothing submitted (not an array, or an empty one) → `null`, which
 *     canAccessPage reads as ALL PAGES (`if (!user.page_access) return true`).
 *     That is this app's existing "the role just follows its tier" contract:
 *     the Roles screen sends `null` for an admin-tier role and `[]` when an
 *     admin unticks every box. UNCHANGED by this fix.
 *   · at least one submitted path is in the catalog → store exactly those.
 *   · paths WERE submitted but NOT ONE of them is in the catalog → REFUSED.
 *
 * THAT LAST CASE USED TO RETURN `null` AS WELL — i.e. it granted the ENTIRE
 * APPLICATION to a role whose admin had just tried to restrict it. Measured on
 * a running server before this fix: POST {base_role:'staff', page_access:[the
 * twenty /fssai paths]} while the catalog did not yet carry them → HTTP 201 with
 * page_access stored as NULL, and a staff user on that role then opened
 * /settings/roles, /users and /customers among 14 of 16 pages probed. An admin
 * who ticks pages this build has never heard of is trying to NARROW a role;
 * silently widening it to everything is the exact opposite of what he asked for.
 *
 * WHY REFUSE RATHER THAN STORE "no pages": there is no way to SPELL deny-all in
 * this column. canAccessPage grants everything for NULL, for an unparseable
 * value, AND for `[]` — so every value this function could return for an
 * all-unknown list means "all pages". Refusing to write is the only fail-closed
 * answer available to it. The caller turns this into a 400 the admin can read;
 * settings/roles/page.tsx already alerts `j.error`.
 *
 * A PARTIALLY known list still stores its known subset and drops the rest. That
 * is a narrowing, so it is safe, and it is long-standing behaviour — left alone
 * deliberately rather than widened into a second refusal.
 *
 * ORDERING RULE THIS DOES NOT REPLACE: catalog entries must still land BEFORE
 * or WITH any role that references them. This fix stops a late catalog causing
 * an escalation; it cannot make an uncatalogued page grantable.
 */
type CleanedPages =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

function cleanPages(input: unknown): CleanedPages {
  if (!Array.isArray(input) || input.length === 0) return { ok: true, value: null };
  const submitted = input.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  const valid = submitted.filter((p) => ALL_PAGE_PATHS.includes(p));
  if (valid.length) return { ok: true, value: JSON.stringify(valid) };
  if (!submitted.length) {
    return { ok: false, error: 'page_access must be a list of page paths. Refusing to save: an unrecognised page list would have granted this role every page in the app.' };
  }
  const shown = submitted.slice(0, 5).join(', ');
  const more = submitted.length > 5 ? ` (+${submitted.length - 5} more)` : '';
  return {
    ok: false,
    error: `None of these pages exist in this build: ${shown}${more}. Refusing to save: an unrecognised page list would have granted this role every page in the app. Re-tick the pages on this screen, or install the build that has them.`,
  };
}

/** Coerce a max-discount-% input to a sane number in [0, 100]. Non-numeric → 0. */
function clampPct(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 100 ? 100 : n;
}

export async function GET(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const db = getDb();
  // include_inactive=1 → also return deactivated roles. A deactivated role still
  // governs its users' pages (getCurrentUser joins roles WITHOUT the is_active
  // filter), so admin screens that resolve a user's effective access (Page
  // Access) need the full list or they'd misread those users as "no role".
  const includeInactive = new URL(req.url).searchParams.get('include_inactive') === '1';
  // r.* already includes can_request_discount + max_discount_pct (schema columns),
  // but list them explicitly-adjacent via r.* so future SELECTs stay in sync.
  const roles = db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.is_active = 1) AS user_count
    FROM roles r ${includeInactive ? '' : 'WHERE r.is_active = 1'}
    ORDER BY r.sort_order ASC, r.name ASC
  `).all();
  return Response.json({ roles });
}

export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const { name, base_role, page_access, is_head_chef, is_store_manager, can_approve_requisitions, can_void_bill_handover, can_view_finance_reports, can_manage_label_printer, description, sort_order,
          can_request_discount, max_discount_pct } = await req.json();
  const nm = String(name || '').trim();
  if (!nm) return Response.json({ error: 'Role name is required' }, { status: 400 });
  if (!VALID_BASE.includes(base_role)) return Response.json({ error: `tier must be one of ${VALID_BASE.join(', ')}` }, { status: 400 });
  // Validate the page list BEFORE touching the database: an all-unknown list is
  // refused rather than silently stored as NULL (= every page). See cleanPages.
  const pages = cleanPages(page_access);
  if (!pages.ok) return Response.json({ error: pages.error }, { status: 400 });
  const db = getDb();
  if (db.prepare('SELECT id FROM roles WHERE lower(name) = lower(?)').get(nm)) {
    return Response.json({ error: 'A role with that name already exists' }, { status: 409 });
  }
  const info = db.prepare(`
    INSERT INTO roles (id, name, base_role, page_access, is_head_chef, is_store_manager, can_approve_requisitions, can_void_bill_handover, can_view_finance_reports, can_manage_label_printer, is_system, sort_order, description,
                       can_request_discount, max_discount_pct)
    -- 15 columns, 15 values. The literal 0 is is_system: a role created through
    -- this route is never a system role, so it is hardcoded rather than bound.
    -- COUNT THE PLACEHOLDERS AGAINST THE COLUMN LIST WHEN ADDING A CAPABILITY.
    -- a86cb50 added can_void_bill_handover to the column list above and a value
    -- to .run() below but no '?' here, leaving 12 values for 13 columns, which
    -- better-sqlite3 rejects at PREPARE time — so creating any new role 500'd
    -- while editing existing ones (PUT, which uses named sets.push) kept working.
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(nm, base_role, pages.value, is_head_chef ? 1 : 0, is_store_manager ? 1 : 0,
         can_approve_requisitions ? 1 : 0,
         can_void_bill_handover ? 1 : 0,
         can_view_finance_reports ? 1 : 0,
         can_manage_label_printer ? 1 : 0,
         Number(sort_order) || 50, String(description || ''),
         can_request_discount ? 1 : 0, clampPct(max_discount_pct));
  return Response.json({ success: true, id: info.lastInsertRowid }, { status: 201 });
}

export async function PUT(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const { id, name, base_role, page_access, is_head_chef, is_store_manager, can_approve_requisitions, can_void_bill_handover, can_view_finance_reports, can_manage_label_printer, description, sort_order,
          can_request_discount, max_discount_pct } = await req.json();
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  if (base_role != null && !VALID_BASE.includes(base_role)) {
    return Response.json({ error: `tier must be one of ${VALID_BASE.join(', ')}` }, { status: 400 });
  }
  const db = getDb();
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as any;
  if (!role) return Response.json({ error: 'Role not found' }, { status: 404 });

  // Validate the page list BEFORE the UPDATE is built, so a refusal can never
  // leave a half-applied change behind. See cleanPages: an all-unknown list used
  // to be stored as NULL, which means EVERY page.
  const pages = page_access === undefined ? null : cleanPages(page_access);
  if (pages && !pages.ok) return Response.json({ error: pages.error }, { status: 400 });

  const sets: string[] = [];
  const params: any[] = [];
  // System roles (Administrator/Manager/Staff): allow page/flag edits, but not a
  // rename or a tier change (those underpin enforcement defaults).
  if (name != null && !role.is_system)        { sets.push('name = ?'); params.push(String(name).trim()); }
  if (base_role != null && !role.is_system)   { sets.push('base_role = ?'); params.push(base_role); }
  if (pages && pages.ok)                      { sets.push('page_access = ?'); params.push(pages.value); }
  if (is_head_chef !== undefined)             { sets.push('is_head_chef = ?'); params.push(is_head_chef ? 1 : 0); }
  if (is_store_manager !== undefined)         { sets.push('is_store_manager = ?'); params.push(is_store_manager ? 1 : 0); }
  if (can_approve_requisitions !== undefined) { sets.push('can_approve_requisitions = ?'); params.push(can_approve_requisitions ? 1 : 0); }
  if (can_void_bill_handover !== undefined) { sets.push('can_void_bill_handover = ?'); params.push(can_void_bill_handover ? 1 : 0); }
  if (can_view_finance_reports !== undefined) { sets.push('can_view_finance_reports = ?'); params.push(can_view_finance_reports ? 1 : 0); }
  if (can_manage_label_printer !== undefined) { sets.push('can_manage_label_printer = ?'); params.push(can_manage_label_printer ? 1 : 0); }
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
