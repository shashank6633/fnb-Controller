/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Task Users directory (/api/tasks/users).
 *
 * A lightweight, read-only directory of active users, used to power the
 * assignee / @-mention pickers in the Task module (see UserPicker.tsx).
 *
 * GET  /api/tasks/users
 *        → { users: [{ id, name, email, position, department_id }], generated_at }
 *
 * Auth: ANY signed-in user (401 if not) — assignee selection and @mention
 * autocomplete are needed by every task participant, not just managers.
 *
 * Sensitivity: LOW. Deliberately returns ONLY names / emails / position /
 * department_id — never password_hash, role tiers, permission flags, page
 * access, or any other privilege internals. Do NOT widen this SELECT.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    const db = getDb();
    const users = db
      .prepare(
        `SELECT id, name, email, position, department_id
           FROM users
          WHERE is_active = 1
          ORDER BY name COLLATE NOCASE ASC, email COLLATE NOCASE ASC`,
      )
      .all() as any[];

    return Response.json({
      users: users.map((u) => ({
        id: u.id,
        name: u.name || '',
        email: u.email || '',
        position: u.position || '',
        department_id: u.department_id || null,
      })),
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('GET /api/tasks/users failed:', e);
    return Response.json({ error: e?.message || 'Failed to load users' }, { status: 500 });
  }
}
