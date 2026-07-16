import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

export async function GET(req: Request) {
  // SECURITY: settings expose tax %, service charge, branding AND the OTP table
  // scope (which tables run captain-less). The proxy only checks that a session
  // cookie is PRESENT — real validation is delegated here. Without this, a forged
  // cookie could read every setting. Any signed-in staff may read (non-secret).
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  const db = getDb();
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (key) {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
    return Response.json({ key, value: r?.value ?? null });
  }
  const all = db.prepare('SELECT key, value FROM settings').all();
  return Response.json({ settings: all });
}

export async function PUT(req: Request) {
  // SECURITY: settings hold the tax percentages (bill_design), service charge,
  // require_mgmt_approval and current_role — a plain staff user must not change
  // them. Admin/manager only. (Was completely unauthenticated.)
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (me.role !== 'admin' && me.role !== 'manager') {
    return Response.json({ error: 'Manager or admin required to change settings' }, { status: 403 });
  }
  const db = getDb();
  const { key, value } = await req.json();
  if (!key) return Response.json({ error: 'key required' }, { status: 400 });
  // The backdate limit governs a hard block that managers (non-admins) are
  // themselves subject to on Purchase/Bulk/GRN dates. Managers keep write
  // access to every OTHER setting, but must NOT be able to raise this key to
  // self-lift the block — restrict this one key to admins.
  if (key === 'purchase_backdate_limit_days' && me.role !== 'admin') {
    return Response.json({ error: 'Admin role required to change the backdate limit' }, { status: 403 });
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value ?? ''));
  return Response.json({ key, value });
}

// Accept POST as an alias for PUT — the upsert is idempotent (settings.key is a
// PRIMARY KEY) and some callers (e.g. Print Design) POST. Without this a POST
// would 405 silently and the save would appear to succeed but persist nothing.
export const POST = PUT;
