import { cookies } from 'next/headers';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { getDb } from './db';

export const SESSION_COOKIE = 'fnb_session';
const SESSION_DAYS = 30;

export type UserRole = 'admin' | 'manager' | 'staff';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  /**
   * Base role:
   *   - admin   : full access (approves vendor POs, manages users, etc.)
   *   - manager : can be granted approval permissions via flags below.
   *               Bar Managers, Head Chefs, Sous Chefs, Operations Managers fall here.
   *   - staff   : raises requisitions for their department; cannot approve.
   */
  role: UserRole;
  /** Assigned named role id (roles table), or null for a legacy per-user role. */
  role_id: string | null;
  /** Display name of the assigned role (e.g. "Floor Manager"), or null. */
  role_name: string | null;
  /** Optional descriptive title (Bar Manager, Sous Chef, Storekeeper, etc.) */
  position: string;
  /** Department staff are tied to a department; null for admin/store/chef who are cross-cutting. */
  department_id: string | null;
  /** Additive flags. Admin always implicitly has both. */
  is_head_chef: boolean;
  is_store_manager: boolean;
  /** JSON-stringified array of allowed page paths. null = full access (backward compat). */
  page_access: string | null;
  /** JSON-stringified array of department_ids whose data is visible. null = only own dept. */
  visible_department_ids: string | null;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function newSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export function createSession(userId: string): { token: string; expiresAt: Date } {
  const db = getDb();
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000);
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(token, userId, expiresAt.toISOString());
  return { token, expiresAt };
}

export function destroySession(token: string): void {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Resolve the current user from the request cookie. Returns null if not signed in. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const c = await cookies();
  const token = c.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = getDb();
  // LEFT JOIN the assigned named role (if any, and still active) so we can resolve
  // the EFFECTIVE privilege tier + page set here — every downstream enforcement
  // site reads these resolved values, so none of them needs to know about roles.
  const row = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.position, u.department_id,
           u.is_head_chef, u.is_store_manager, u.page_access, u.visible_department_ids,
           u.role_id,
           r.name AS role_name, r.base_role AS role_base, r.page_access AS role_page_access,
           r.is_head_chef AS role_head_chef, r.is_store_manager AS role_store,
           s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    LEFT JOIN roles r ON r.id = u.role_id AND r.is_active = 1
    WHERE s.token = ? AND u.is_active = 1
  `).get(token) as any;
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    destroySession(token);
    return null;
  }
  const hasRole = !!row.role_id && !!row.role_base;
  return {
    id: row.id, email: row.email, name: row.name,
    // Tier: the assigned role's base_role wins (kept correct even if the role's
    // tier was edited after assignment); falls back to the legacy users.role.
    role: ((hasRole ? row.role_base : row.role) as UserRole) || 'staff',
    role_id: row.role_id || null,
    role_name: row.role_name || null,
    position: row.position || '',
    department_id: row.department_id || null,
    // Flags: union of the user's own flags and the role's flags.
    is_head_chef: !!row.is_head_chef || (hasRole && !!row.role_head_chef),
    is_store_manager: !!row.is_store_manager || (hasRole && !!row.role_store),
    // Pages: a per-user page_access overrides; else inherit the role's set; else
    // null = full access (backward compat for users without a role or override).
    page_access: row.page_access != null ? row.page_access : (hasRole ? (row.role_page_access ?? null) : null),
    visible_department_ids: row.visible_department_ids || null,
  };
}

/** Can this user approve requisitions as head chef? Admin always true. */
export function canApproveAsChef(user: SessionUser): boolean {
  return user.role === 'admin' || user.is_head_chef;
}
/** Can this user process requisitions / raise vendor POs as store manager? Admin always true. */
export function canProcessAsStore(user: SessionUser): boolean {
  return user.role === 'admin' || user.is_store_manager;
}
/** Can this user approve requisitions as Management (the 2nd gate after Chef)?
 *  Per Phase 1 SOP: Dept → Chef → Mgmt → Store. Today admin = mgmt; expand later
 *  with an explicit `is_management` flag if you want to separate it from admin. */
export function canApproveAsMgmt(user: SessionUser): boolean {
  return user.role === 'admin';
}

/** Server-side role check used by gated API routes. */
export async function requireRole(role: 'admin' | 'manager'): Promise<{ ok: true; user: SessionUser } | { ok: false; status: number; message: string }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, message: 'Sign in required' };
  if (role === 'admin' && user.role !== 'admin') {
    return { ok: false, status: 403, message: 'Admin role required' };
  }
  return { ok: true, user };
}

/** Return the currently-selected outlet_id for the signed-in user, or the default outlet. */
export async function getCurrentOutletId(): Promise<string | null> {
  const db = getDb();
  const me = await getCurrentUser();
  if (me) {
    const r = db.prepare('SELECT current_outlet_id FROM users WHERE id = ?').get(me.id) as any;
    if (r?.current_outlet_id) return r.current_outlet_id;
  }
  // Fall back to the default outlet so unauthenticated routes / scripts still work
  const def = db.prepare("SELECT id FROM outlets WHERE is_default = 1 LIMIT 1").get() as any;
  return def?.id || null;
}

/** Initialize default admin user on first run if `users` is empty.
 *  Returns the credentials so we can show a one-time setup banner. */
export async function ensureFirstUser(): Promise<{ created: boolean; email?: string; tempPassword?: string }> {
  const db = getDb();
  const c = db.prepare('SELECT COUNT(*) AS n FROM users').get() as any;
  if (c.n > 0) return { created: false };
  const email = 'admin@local';
  const tempPassword = 'admin123';   // user is told to change this immediately
  const hash = await hashPassword(tempPassword);
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role)
    VALUES (lower(hex(randomblob(16))), ?, ?, 'Admin', 'admin')
  `).run(email, hash);
  return { created: true, email, tempPassword };
}
