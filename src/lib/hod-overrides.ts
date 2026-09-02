import { getDb } from './db';
import { applyHodOnlyOverrides, getHodOnlyOverrides, PAGE_CATALOG } from './page-catalog';

/**
 * Server half of the HOD-only gate overrides (owner pick 9B) — reads the
 * admin-owned settings key and pushes it into page-catalog's per-bundle state.
 *
 * STORAGE: settings key 'hod_only_overrides', value JSON like
 *   {"/menu-engineering": false}
 * — a map of coded-hodOnly catalog paths whose hard gate an admin switched
 * OFF. NO boot seed anywhere: an absent row means "no overrides", so a fresh
 * install behaves exactly as the catalog is coded and the boot-migration lock
 * stays clean. The ONLY writer is /api/settings/hod-only (admin, validated);
 * the generic /api/settings PUT refuses the key via KEY_POLICY `owner:`.
 *
 * FAIL CLOSED: unreadable table, unparseable JSON, wrong shape — every failure
 * path lands on applyHodOnlyOverrides(null), which makes the CODED flags
 * stand. A corrupt row can only ever RESTORE gates, never open one.
 *
 * COST: canAccessPage runs on EVERY page navigation (proxy.ts step 2b), so the
 * settings read is cached for TTL_MS per bundle. Measured on this machine
 * (better-sqlite3, warm file): ~3–4 µs per uncached SELECT — the cache is
 * belt-and-braces, not a necessity. The TTL matters for a different reason:
 * the proxy is compiled as its OWN bundle, so invalidate() from a route
 * handler cannot reach the proxy's module instance — the proxy converges by
 * TTL expiry instead, i.e. a toggle takes at most TTL_MS to bite on page
 * navigation. Keep it small.
 */
export const HOD_OVERRIDES_KEY = 'hod_only_overrides';
const TTL_MS = 2000;
let loadedAt = 0;

/** Parse + sanity-check the stored value. Returns null on ANY doubt. */
function readRow(): Record<string, false> | null {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(HOD_OVERRIDES_KEY) as { value?: string } | undefined;
  if (!row?.value) return null;
  const parsed: unknown = JSON.parse(row.value); // throws → caller fails closed
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const clean: Record<string, false> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof k === 'string' && v === false) clean[k] = false;
  }
  return clean;
}

/**
 * Refresh page-catalog's override state from the DB (TTL-cached). Call before
 * canAccessPage / isHodOnlyPath on any server surface that must honour the
 * admin toggles — the proxy calls it on every page navigation.
 */
export function loadHodOnlyOverrides(): void {
  const now = Date.now();
  if (now - loadedAt < TTL_MS) return;
  loadedAt = now;
  try {
    applyHodOnlyOverrides(readRow());
  } catch {
    applyHodOnlyOverrides(null); // unreadable/corrupt → coded flags stand
  }
}

/** Drop the TTL so the next load re-reads (same-bundle immediacy after a write). */
export function invalidateHodOnlyOverrides(): void {
  loadedAt = 0;
}

/**
 * Fresh, sanitized override map for API responses (/api/auth/me, the settings
 * screen). Never throws; {} on any failure. Also pushes the result into this
 * bundle's page-catalog state so route handlers that gate right after reading
 * (e.g. auth/me consumers) see the same truth they were told.
 */
export function readHodOnlyOverrides(): Record<string, false> {
  try {
    const clean = readRow() ?? {};
    applyHodOnlyOverrides(clean);
    loadedAt = Date.now();
    return clean;
  } catch {
    applyHodOnlyOverrides(null);
    return {};
  }
}

/** Every catalog entry whose CODED flag is hodOnly — the only overridable set. */
export function codedHodOnlyPaths(): string[] {
  const out: string[] = [];
  for (const s of PAGE_CATALOG) for (const p of s.pages) if (p.hodOnly) out.push(p.path);
  return out;
}

export { getHodOnlyOverrides };
