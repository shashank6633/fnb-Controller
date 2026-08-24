import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
// SECRET_KEY_RE lives in @/lib/secret-keys, not in this file, because the
// read-only Database console (/api/admin/database) masks its query results with
// the SAME pattern: a raw `SELECT * FROM settings` there must redact exactly
// what this route redacts, or the console becomes the back door around it. Do
// NOT "simplify" it back to a local const — two copies drift the day one of
// them gains a key, and the copy that lags is the one that leaks. It is still
// pattern-matched rather than a fixed list, so a secret added later is redacted
// by DEFAULT instead of leaking until someone remembers to list it.
import { SECRET_KEY_RE } from '@/lib/secret-keys';

/**
 * ONE table for every key this generic endpoint treats specially. BOTH halves
 * read it — the GET redaction filter and the PUT write gate — so a privileged
 * setting can no longer be listed on one side and forgotten on the other. That
 * drift is exactly what left po_require_admin_approval UI-restricted with no
 * server counterpart for a whole release.
 *
 *   read:  'admin'  → non-admins read back null. This is ON TOP of
 *                     SECRET_KEY_RE below, which already redacts anything that
 *                     merely LOOKS like a secret; list a key here only when the
 *                     name does not give it away (e.g. a phone number).
 *   write: 'admin'  → a manager PUT/POST of this key 403s with `writeError`.
 *   owner: '<path>' → the key belongs to a dedicated route that validates and
 *                     masks it; this generic door is shut for EVERYONE, admins
 *                     included, so that route stays the single way in.
 */
type KeyPolicy = { read?: 'admin'; write?: 'admin'; writeError?: string; owner?: string };

const KEY_POLICY = new Map<string, KeyPolicy>([
  // The crash-alert WhatsApp number decides WHO gets production error alerts.
  // Admin-only to read (don't hand a personal number to every signed-in staff
  // session) and to write — the /api/error-report console is admin-only, so a
  // manager must not be able to redirect or silence the alerts either.
  ['error_alert_phone', {
    read: 'admin', write: 'admin',
    writeError: 'Admin role required to change the error alert number',
  }],
  // The backdate limit governs a hard block that managers (non-admins) are
  // themselves subject to on Purchase/Bulk/GRN dates. Managers keep write
  // access to every OTHER non-privileged setting, but must NOT be able to raise
  // this key to self-lift the block.
  ['purchase_backdate_limit_days', {
    write: 'admin',
    writeError: 'Admin role required to change the backdate limit',
  }],
  // Same self-lift reasoning as the backdate limit, and the sharpest case of it.
  // Approving a PO is admin-only (purchase-orders/[id]/approve returns 403 on
  // role !== 'admin'). Switching this key off makes submit auto-approve, and a
  // manager also passes poWriteGate on receive — so a manager who could write it
  // would go PUT '0' → submit own PO → auto-approved → receive, booking stock and
  // rewriting average_price across every recipe with no admin anywhere in the
  // chain. That is the approve gate defeated by exactly the role it denies.
  // READ stays open (the settings page shows managers the switch, read-only).
  ['po_require_admin_approval', {
    write: 'admin',
    writeError: 'Admin role required to change the PO approval requirement',
  }],
  // The cutover switch for WHERE stock leaves the building: '0' (shipped
  // default) debits central current_stock at recipe consumption, '1' debits it
  // when the store issues to a department. It re-bases every stock figure in
  // the system at once — on-hand, closing valuation, low-stock/buy-list,
  // variance — and it is a ONE-WAY DOOR operationally: flipping it back stops
  // new debits but does NOT restore stock a run of issues already removed. That
  // is a decision for whoever owns the count, not for whoever happens to be on
  // shift. Nothing in SECRET_KEY_RE matches this name, so without this row a
  // manager PUT writes it — do not "simplify" the entry away as redundant.
  // READ stays open so the Purchasing settings page can show a manager the
  // switch read-only; the value is not a secret, only the flip is privileged.
  ['requisition_deduct_at_issue', {
    write: 'admin',
    writeError: 'Admin role required to change when stock is deducted',
  }],
  // THE VARIANCE BAR — the sharpest self-lift in this table, and it was open.
  // These TWO decide how much stock movement happens with NO admin in the
  // loop: a count whose difference is under the bar applies itself to
  // raw_materials.current_stock / the store ledger at save time, recorded as
  // `system:auto-apply`, with the manager's name nowhere in the audit trail.
  // Saving a count is open to every signed-in user, so a manager who could
  // write these would be arming an unreviewed write path for the whole staff —
  // the identical shape as purchase_backdate_limit_days and
  // po_require_admin_approval above, one table over.
  //
  // MEASURED before this row existed: a manager PUT bar_qty=100 through this
  // endpoint, then saved a counted 0 on a 35-piece gas line and
  // ₹202,947.50 left the books with no admin anywhere in the chain.
  //
  // /api/closing-stock/variance-bar is the dedicated door and is admin-only,
  // but it is NOT registered `owner:` here on purpose: it writes nothing this
  // endpoint cannot write and adds no masking, so shutting the generic door for
  // admins too would buy nothing and break any admin client that PUTs settings
  // generically. write:'admin' is exactly the rule that was missing.
  // READ stays open — the numbers are policy, not a system-stock oracle, and
  // /variance-approvals shows managers nothing anyway (it is adminOnly).
  ['closing_variance_bar_value', {
    write: 'admin',
    writeError: 'Admin role required to change the variance auto-apply bar',
  }],
  ['closing_variance_bar_qty', {
    write: 'admin',
    writeError: 'Admin role required to change the variance auto-apply bar',
  }],
  // `closing_variance_alert_value` / `closing_variance_alert_pct` USED to sit
  // here as a third and fourth row. They are GONE, and their absence is correct
  // rather than an oversight: the per-row "large variance" alert they tuned was
  // deleted outright (it fired on 86% of a real sheet, because a counted zero is
  // 100% by arithmetic), replaced by one always-fired digest per COUNT that
  // nothing tunes. Nothing reads those keys any more, the live database holds no
  // row for either, and an unregistered key in this table is writable by a
  // manager — which is harmless for a key with no reader, and is exactly why
  // they must not be re-added "for safety" instead of the feature being gone.
  // Owned keys. Each has a dedicated admin-only route that VALIDATES the value
  // (Slack host check, service-account JSON parse, printer normalisation) and
  // masks it on read — writing it through here would bypass both gate and
  // validation, so this endpoint refuses the key outright.
  ['slack_webhook_url', { owner: '/api/admin/slack-webhook' }],
  ['google_sa_json', { owner: '/api/admin/google-sheets' }],
  ['label_printer', { owner: '/api/settings/label-printer' }],
]);

/**
 * wa_* (Meta/Interakt credentials, the master switch, template names and the
 * wa_notify_* prefs) all belong to /api/whatsapp/config, which is admin-gated
 * and never echoes a raw secret. Prefix-matched so a wa_ key added later is
 * owned by DEFAULT instead of falling through to this generic writer.
 */
const OWNED_PREFIXES: Array<{ re: RegExp; route: string }> = [
  { re: /^wa_/i, route: '/api/whatsapp/config' },
  // HRMS keys (hr_day_cutoff, hr_punch_debounce_min, ...) are owned by the HR
  // settings route so the manager-writable generic PUT here cannot touch them,
  // per docs/HRMS_DECISIONS.md §2.7. Registered BEFORE the first hr_* key
  // exists — the gate being decorative-until-registered is the trap.
  { re: /^hr_/i, route: '/api/hr/settings' },
];

/** The dedicated route that owns this key, or null when this endpoint owns it. */
function ownerRoute(key: string): string | null {
  const owned = KEY_POLICY.get(key)?.owner;
  if (owned) return owned;
  return OWNED_PREFIXES.find((p) => p.re.test(key))?.route ?? null;
}

/** Admin-only to READ: looks like a secret, or is listed read:'admin' above. */
const isSecret = (k: string) => SECRET_KEY_RE.test(k) || KEY_POLICY.get(k)?.read === 'admin';

/**
 * Admin-only to WRITE through this endpoint. Secret-looking keys are included
 * so the write side has the same default-deny posture as the read side: a new
 * credential dropped into settings is admin-write from the moment it exists,
 * not from the moment someone remembers to list it.
 */
const isAdminOnlyWrite = (k: string) => KEY_POLICY.get(k)?.write === 'admin' || SECRET_KEY_RE.test(k);

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
  const isAdmin = me.role === 'admin';
  // PRE-EXISTING LEAK, closed here: this table is also where the app keeps its
  // live credentials, and the unfiltered read below handed every one of them to
  // any signed-in session — a captain or storekeeper could GET /api/settings and
  // read the Gemini keys, the WhatsApp access token and verify token, the Slack
  // webhook and the Google service-account JSON. Those same values are masked by
  // whatsapp.ts's SECRET_KEYS, and /api/admin/slack-webhook refuses to show a
  // non-admin even a MASKED copy — this route was the back door around all of it.
  // isSecret() (module scope) is the read half of KEY_POLICY + SECRET_KEY_RE.
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
  // them. Admin/manager is the FLOOR (it was completely unauthenticated); the
  // per-key rules in KEY_POLICY / ownerRoute() then narrow it further.
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (me.role !== 'admin' && me.role !== 'manager') {
    return Response.json({ error: 'Manager or admin required to change settings' }, { status: 403 });
  }
  const db = getDb();
  const { key, value } = await req.json();
  if (!key) return Response.json({ error: 'key required' }, { status: 400 });
  const k = String(key);
  // Keys owned by a dedicated route are refused here for EVERYONE (admins too).
  // The generic writer takes any string: it would store an arbitrary URL as the
  // Slack webhook, unparseable text as the service-account JSON or a raw token
  // where /api/whatsapp/config would have validated and masked it — and, until
  // now, would do it for a manager whom every one of those routes 403s.
  const owner = ownerRoute(k);
  if (owner) {
    return Response.json(
      { error: `'${k}' is managed by ${owner} — the generic settings endpoint does not write it` },
      { status: 403 },
    );
  }
  // Admin-only writes (KEY_POLICY write:'admin' + anything secret-looking).
  // Each listed key carries its own reason in the table above.
  if (isAdminOnlyWrite(k) && me.role !== 'admin') {
    return Response.json(
      { error: KEY_POLICY.get(k)?.writeError ?? 'Admin role required to change this setting' },
      { status: 403 },
    );
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(value ?? ''));
  return Response.json({ key, value });
}

// Accept POST as an alias for PUT — the upsert is idempotent (settings.key is a
// PRIMARY KEY) and some callers (e.g. Print Design) POST. Without this a POST
// would 405 silently and the save would appear to succeed but persist nothing.
export const POST = PUT;
