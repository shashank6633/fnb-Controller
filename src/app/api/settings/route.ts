import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

export async function GET(req: Request) {
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
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value ?? ''));
  return Response.json({ key, value });
}

// Accept POST as an alias for PUT — the upsert is idempotent (settings.key is a
// PRIMARY KEY) and some callers (e.g. Print Design) POST. Without this a POST
// would 405 silently and the save would appear to succeed but persist nothing.
export const POST = PUT;
