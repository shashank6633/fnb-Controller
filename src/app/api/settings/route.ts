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
  // error_alert_phone (crash-alert WhatsApp number) is admin-only — don't leak
  // it to non-admin staff via the generic settings read.
  const isAdmin = me.role === 'admin';
  const ADMIN_ONLY_KEYS = new Set(['error_alert_phone']);
  // PRE-EXISTING LEAK, closed here: this table is also where the app keeps its
  // live credentials, and the unfiltered read below handed every one of them to
  // any signed-in session — a captain or storekeeper could GET /api/settings and
  // read the Gemini keys, the WhatsApp access token and verify token, the Slack
  // webhook and the Google service-account JSON. Those same values are masked by
  // whatsapp.ts's SECRET_KEYS, and /api/admin/slack-webhook refuses to show a
  // non-admin even a MASKED copy — this route was the back door around all of it.
  // Pattern-matched, not a fixed list, so a secret added later is redacted by
  // DEFAULT rather than leaking until someone remembers to list it.
  const SECRET_KEY_RE = /(token|api[_-]?key|_keys|secret|password|passwd|webhook|credential|sa_json|private)/i;
  const isSecret = (k: string) => SECRET_KEY_RE.test(k) || ADMIN_ONLY_KEYS.has(k);
  if (key) {
    if (isSecret(key) && !isAdmin) return Response.json({ key, value: null });
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
    return Response.json({ key, value: r?.value ?? null });
  }
  const all = (db.prepare('SELECT key, value FROM settings').all() as any[])
    .filter((row) => isAdmin || !isSecret(row.key));
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
  // The crash-alert WhatsApp number decides WHO gets production error alerts —
  // a manager must not redirect or silence it (the /api/error-report console is
  // admin-only, so this second door must be too).
  if (key === 'error_alert_phone' && me.role !== 'admin') {
    return Response.json({ error: 'Admin role required to change the error alert number' }, { status: 403 });
  }
  // Same self-lift reasoning as the backdate limit, and the sharpest case of it.
  // Approving a PO is admin-only (purchase-orders/[id]/approve returns 403 on
  // role !== 'admin'). Switching this key off makes submit auto-approve, and a
  // manager also passes poWriteGate on receive — so a manager who could write it
  // would go PUT '0' → submit own PO → auto-approved → receive, booking stock and
  // rewriting average_price across every recipe with no admin anywhere in the
  // chain. That is the approve gate defeated by exactly the role it denies.
  // READ stays open (the settings page shows managers the switch, read-only).
  if (key === 'po_require_admin_approval' && me.role !== 'admin') {
    return Response.json({ error: 'Admin role required to change the PO approval requirement' }, { status: 403 });
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value ?? ''));
  return Response.json({ key, value });
}

// Accept POST as an alias for PUT — the upsert is idempotent (settings.key is a
// PRIMARY KEY) and some callers (e.g. Print Design) POST. Without this a POST
// would 405 silently and the save would appear to succeed but persist nothing.
export const POST = PUT;
