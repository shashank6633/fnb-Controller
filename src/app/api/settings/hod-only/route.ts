import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import {
  HOD_OVERRIDES_KEY,
  codedHodOnlyPaths,
  invalidateHodOnlyOverrides,
  readHodOnlyOverrides,
} from '@/lib/hod-overrides';

/**
 * /api/settings/hod-only — the ONE writer of the 'hod_only_overrides' settings
 * key (owner pick 9B). Registered `owner:` in the generic /api/settings
 * KEY_POLICY, so this route is the single door: the generic endpoint refuses
 * the key for everyone, admins included, and a manager (who may write ordinary
 * settings) can never touch it.
 *
 * ADMIN-ONLY both verbs. Switching a gate off widens who can OPEN a hodOnly
 * page — the same decision class as editing the page-catalog by hand, which is
 * exactly what this replaces (the 2026-08-31 Kitchen Production edit, from the
 * UI). The /settings/hod-gates catalog entry is adminOnly too, but THIS 403 is
 * the real lock; the catalog flag only stops the proxy waving through a legacy
 * null-map user.
 *
 * WHAT A WRITE CANNOT DO, by validation here + consumption there:
 *   - touch a page whose coded flag is not hodOnly (paths are checked against
 *     codedHodOnlyPaths(); mgmtOnly/adminOnly/unflagged rows are refused);
 *   - ADD a gate anywhere (only `false` = gate-off entries are ever stored;
 *     "on" is expressed by deleting the entry so the coded flag stands);
 *   - survive corruption as a wider grant (every reader fails CLOSED to the
 *     coded flags on any parse/shape problem).
 *
 * NO boot seed: an absent settings row means "no overrides". Toggling every
 * gate back on deletes the row, returning the DB to its pre-feature state.
 *
 * PROPAGATION: this bundle's cache is invalidated immediately; the proxy runs
 * in its own bundle and converges by TTL (≤2s) on the next page navigation.
 */

export async function GET() {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
  return Response.json({
    overrides: readHodOnlyOverrides(),   // {} = no overrides; never throws
    hod_only_paths: codedHodOnlyPaths(),
  });
}

export async function PUT(req: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const path = typeof body?.path === 'string' ? body.path : '';
  const enabled = body?.enabled;
  if (!path || typeof enabled !== 'boolean') {
    return Response.json({ error: 'Body must be { path: string, enabled: boolean }' }, { status: 400 });
  }
  const coded = codedHodOnlyPaths();
  if (!coded.includes(path)) {
    return Response.json(
      { error: `'${path}' is not a hodOnly catalog page — only coded hodOnly gates can be toggled here` },
      { status: 400 },
    );
  }

  const db = getDb();
  // Read-modify-write the whole map. A corrupt/malformed stored value reads as
  // {} here — the write REPAIRS it to a valid map rather than perpetuating it.
  let current: Record<string, false> = {};
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(HOD_OVERRIDES_KEY) as { value?: string } | undefined;
    if (row?.value) {
      const parsed: unknown = JSON.parse(row.value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (v === false && coded.includes(k)) current[k] = false;
        }
      }
    }
  } catch { current = {}; }

  if (enabled) delete current[path];   // gate ON = coded flag stands = no entry
  else current[path] = false;          // gate OFF = follow normal page_access

  if (Object.keys(current).length === 0) {
    // All gates back on → remove the row entirely (pre-feature state).
    db.prepare('DELETE FROM settings WHERE key = ?').run(HOD_OVERRIDES_KEY);
  } else {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(HOD_OVERRIDES_KEY, JSON.stringify(current));
  }
  invalidateHodOnlyOverrides();

  return Response.json({ overrides: readHodOnlyOverrides() });
}
