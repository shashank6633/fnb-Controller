import { getDb } from '@/lib/db';

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
