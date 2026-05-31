import { cookies } from 'next/headers';
import { randomBytes } from 'crypto';
import { getDb } from '@/lib/db';
import { verifyPassword, createSession, SESSION_COOKIE, ensureFirstUser } from '@/lib/auth';

const CSRF_COOKIE = 'fnb_csrf';

export async function POST(req: Request) {
  try {
    // First-run bootstrap — creates admin@local / admin123 if no users exist
    await ensureFirstUser();

    const { email, password } = await req.json();
    if (!email || !password) return Response.json({ error: 'Email and password required' }, { status: 400 });
    const db = getDb();
    const u = db.prepare('SELECT id, email, name, role, password_hash, is_active FROM users WHERE email = ?').get(String(email).toLowerCase()) as any;
    if (!u || !u.is_active) return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    const ok = await verifyPassword(password, u.password_hash);
    if (!ok) return Response.json({ error: 'Invalid credentials' }, { status: 401 });

    const { token, expiresAt } = createSession(u.id);
    db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(u.id);
    const c = await cookies();
    // Use maxAge (relative seconds) instead of expires (absolute date) so the
    // cookie can't be marked expired by clock skew between server and client.
    const maxAgeSec = Math.max(60, Math.round((expiresAt.getTime() - Date.now()) / 1000));
    c.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: maxAgeSec,
      secure: false, // local dev / LAN access over HTTP
    });
    // Issue a fresh CSRF token. NOT httpOnly so the browser JS can read & echo it in the header.
    const csrf = randomBytes(16).toString('hex');
    c.set(CSRF_COOKIE, csrf, {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      maxAge: maxAgeSec,
      secure: false,
    });

    return Response.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role }, csrf });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}
