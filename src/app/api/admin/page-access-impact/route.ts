import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import {
  PAGE_CATALOG,
  ALL_PAGE_PATHS,
  canAccessPage,
  canAccessPageStrict,
} from '@/lib/page-catalog';

/**
 * Page-access impact report — ADMIN ONLY, READ-ONLY, CHANGES NOTHING.
 *
 *   GET /api/admin/page-access-impact
 *
 * WHAT IT ANSWERS
 * canAccessPage() matches a grant by URL PREFIX, and many catalog parents are
 * also the prefix of their sibling pages — /tasks is the Task Dashboard and the
 * prefix of the 14 other Task Management pages, so ticking the dashboard hands
 * over the whole module. Eight parents carry 43 such grants (see `parents`
 * below). proxy.ts imports canAccessPage, so that is real server-side reach.
 *
 * Closing the hole TIGHTENS access. Any role configured while the leak was live
 * may have been given a parent in place of the pages actually intended, so the
 * switch would strip pages from staff mid-service. This endpoint is the
 * pre-flight: for every active user and every role it reports exactly which
 * pages they would LOSE, so the owner can top up the grants that should have
 * been ticked all along BEFORE anything is tightened.
 *
 * WHAT IT DOES NOT DO
 * It enforces nothing and writes nothing. canAccessPage() keeps its current
 * behaviour; canAccessPageStrict() is simulated here and called from nowhere
 * else. Reading this report can never change who can reach what.
 *
 * RESPONSE
 *   catalog_total   how many pages are in PAGE_CATALOG
 *   parents[]       the parent pages that currently carry siblings, and which
 *                   siblings they carry — the mechanism, for the UI to explain
 *   users[] roles[] one row each: effective_map_source, granted, now, strict,
 *                   and lost[] = the pages that disappear, each with the parent
 *                   grant (`via`) that is carrying it today
 *   totals          headline counts
 *
 * FULL-ACCESS SUBJECTS ARE MARKED, NOT OMITTED. A tier-admin, or anyone whose
 * effective map is null / [] / unparseable, is granted everything by design
 * (backward compat, "follow role"). The fix cannot touch them, so the diff is
 * skipped — but the row is still returned with full_access + a reason, so the
 * page can say WHY rather than leaving a name silently missing from the list.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** path → { label, section } for every catalog page. Built once at module load. */
const PAGE_META = new Map<string, { label: string; section: string }>(
  PAGE_CATALOG.flatMap(s => s.pages.map(p => [p.path, { label: p.label, section: s.label }] as const)),
);

function meta(path: string) {
  const m = PAGE_META.get(path);
  return { path, label: m?.label ?? path, section: m?.section ?? '' };
}

/**
 * The parents that silently carry siblings today: a catalog page that is the
 * URL prefix of OTHER catalog pages. '/' never qualifies — the prefix test
 * builds '//', which no pathname starts with.
 */
const PARENTS = ALL_PAGE_PATHS
  .map(parent => ({
    ...meta(parent),
    children: ALL_PAGE_PATHS.filter(c => c !== parent && c.startsWith(parent + '/')).map(meta),
  }))
  .filter(p => p.children.length > 0)
  .map(p => ({ ...p, carries: p.children.length }))
  .sort((a, b) => b.carries - a.carries || a.path.localeCompare(b.path));

/** The subject of a diff, shaped exactly as canAccessPage expects a user. */
type Subject = { role?: string; page_access?: string | null; is_head_chef?: boolean };

/** Row shapes for the two reads below. SQLite hands back 0/1 for booleans. */
interface UserRow {
  id: string; email: string; name: string; role: string;
  is_head_chef: number; page_access: string | null; role_id: string | null;
  role_name: string | null; role_base: string | null;
  role_page_access: string | null; role_head_chef: number | null; role_is_active: number | null;
}
interface RoleRow {
  id: string; name: string; base_role: string; page_access: string | null;
  is_head_chef: number; is_active: number; sort_order: number;
}

interface Diff {
  effective_map_source: 'user' | 'role' | 'none';
  full_access: boolean;
  full_access_reason: string | null;
  granted: number;
  now: number;
  strict: number;
  lost: { path: string; label: string; section: string; via: string | null }[];
}

/**
 * How many catalog pages this subject can reach under each matcher. Counted,
 * never assumed: a full-access non-admin is NOT reaching all 130 pages, because
 * the hodOnly / mgmtOnly / adminOnly tier gates run before the null-map grant
 * and block them regardless. Hard-coding the catalog size for those rows would
 * put a number on screen that is simply false.
 */
function countReach(subject: Subject): { now: number; strict: number } {
  let now = 0, strict = 0;
  for (const path of ALL_PAGE_PATHS) {
    if (canAccessPage(path, subject)) now++;
    if (canAccessPageStrict(path, subject)) strict++;
  }
  return { now, strict };
}

/**
 * Compare the two matchers over the whole catalog for one subject.
 *
 * `now` and `strict` count CATALOG pages only (ALWAYS_ALLOWED /login + /launch
 * are not catalog entries and are unaffected by the fix either way). `lost` is
 * now − strict; it can never be negative because strict is a strict subset —
 * see the contract on canAccessPageStrict.
 */
function diffSubject(subject: Subject, source: Diff['effective_map_source']): Diff {
  // Full access, three ways: admin tier, no/blank map, empty or garbled map.
  // All three make the fix a NO-OP for this subject, because both matchers
  // return at the same early exit long before their final match differs — so
  // the diff is skipped and `lost` is empty by construction, not by omission.
  // The subject is still returned, flagged with the reason, so the page can say
  // WHY it has nothing to report instead of dropping the name silently.
  let parsed: unknown = null;
  let unparseable = false;
  if (subject.page_access) {
    try { parsed = JSON.parse(subject.page_access); }
    catch { unparseable = true; }
  }
  const allowed = Array.isArray(parsed) ? (parsed as string[]) : [];

  // Parsed BEFORE this early exit purely so an admin's `granted` reports the
  // real number of ticked paths rather than a hardcoded 0.
  if (subject.role === 'admin') {
    return { effective_map_source: source, full_access: true, full_access_reason: 'Admin tier — full access, unaffected by the fix', granted: allowed.length, ...countReach(subject), lost: [] };
  }

  if (!subject.page_access || unparseable || allowed.length === 0) {
    const reason = unparseable
      ? 'Page map is not valid JSON — canAccessPage deliberately fails open, so this subject has full access'
      : !subject.page_access
        ? (source === 'none'
          ? 'No page map on the user and none on the role — full access by design (backward compat)'
          : `Effective page map is blank (source: ${source}) — full access by design`)
        // Not "empty array" — `allowed` is coerced to [] for ANY non-array JSON
        // too ("hello", {"a":1}), so this branch is reached by a map that is
        // valid JSON but the wrong shape. Saying "empty array" there is simply
        // false, and this report is only useful if every sentence on it is true.
        : Array.isArray(parsed)
          ? `Page map is an empty array (source: ${source}) — full access by design (follow-role)`
          : `Page map is valid JSON but not a list of paths (source: ${source}) — canAccessPage falls back to full access`;
    // granted = what is actually stored, not a hardcoded 0. An admin with a real
    // 14-path map reported "0 ticked", which reads as "nothing configured".
    return { effective_map_source: source, full_access: true, full_access_reason: reason, granted: allowed.length, ...countReach(subject), lost: [] };
  }

  const allowedSet = new Set(allowed);
  let now = 0, strict = 0;
  const lost: Diff['lost'] = [];
  for (const path of ALL_PAGE_PATHS) {
    const a = canAccessPage(path, subject);
    const b = canAccessPageStrict(path, subject);
    if (a) now++;
    if (b) strict++;
    if (a && !b) {
      // Which granted parent is carrying it today? Longest wins — that is the
      // one the owner most likely meant to grant, and it names the mechanism.
      let via: string | null = null;
      for (const p of allowedSet) {
        if (path.startsWith(p + '/') && (via === null || p.length > via.length)) via = p;
      }
      lost.push({ ...meta(path), via });
    }
  }
  return {
    effective_map_source: source,
    full_access: false,
    full_access_reason: null,
    granted: allowed.length,
    now,
    strict,
    lost,
  };
}

export async function GET() {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const db = getDb();

  // ONE query for users. The LEFT JOIN carries NO r.is_active filter, exactly
  // like getCurrentUser() in src/lib/auth.ts: a DEACTIVATED role still governs
  // its users' pages and tier. Filtering it out here would resolve those users
  // to a null map = every page, and the report would then claim they lose
  // nothing when in fact the whole question is about them.
  const userRows = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.is_head_chef, u.page_access, u.role_id,
           r.name AS role_name, r.base_role AS role_base,
           r.page_access AS role_page_access, r.is_head_chef AS role_head_chef,
           r.is_active AS role_is_active
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.is_active = 1
    ORDER BY u.name COLLATE NOCASE
  `).all() as UserRow[];

  // ONE query for roles. Inactive roles are INCLUDED (and flagged) for the same
  // reason as above — they are still governing whoever is assigned to them.
  const roleRows = db.prepare(`
    SELECT id, name, base_role, page_access, is_head_chef, is_active, sort_order
    FROM roles
    ORDER BY sort_order, name COLLATE NOCASE
  `).all() as RoleRow[];

  const users = userRows.map(row => {
    // Effective tier / flags / map, resolved with the SAME precedence as
    // getCurrentUser(): the assigned role's base_role wins over users.role, the
    // HOD flag is the UNION of user and role, and a per-user page_access
    // overrides the role's. Do not simplify — proxy.ts mirrors this too.
    const hasRole = !!row.role_id && !!row.role_base;
    const subject: Subject = {
      role: (hasRole ? row.role_base : row.role) || 'staff',
      is_head_chef: !!row.is_head_chef || (hasRole && !!row.role_head_chef),
      page_access: row.page_access != null ? row.page_access : (hasRole ? (row.role_page_access ?? null) : null),
    };
    const source: Diff['effective_map_source'] =
      row.page_access != null ? 'user'
        : (hasRole && row.role_page_access != null) ? 'role'
          : 'none';
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      effective_role: subject.role,
      is_head_chef: subject.is_head_chef,
      role_id: row.role_id || null,
      role_name: row.role_name || null,
      role_is_active: row.role_id ? !!row.role_is_active : null,
      ...diffSubject(subject, source),
    };
  });

  // Headcount per role in ONE pass over the users already in hand — no second
  // query, and no filter-inside-a-map over every role.
  const headcount = new Map<string, number>();
  for (const u of userRows) if (u.role_id) headcount.set(u.role_id, (headcount.get(u.role_id) ?? 0) + 1);

  const roles = roleRows.map(row => {
    // A role's own reach: what a user carrying this role and NO per-user
    // override resolves to. That is the row the owner edits to fix a whole
    // group at once.
    const subject: Subject = {
      role: row.base_role || 'staff',
      is_head_chef: !!row.is_head_chef,
      page_access: row.page_access ?? null,
    };
    return {
      id: row.id,
      name: row.name,
      base_role: row.base_role,
      is_active: !!row.is_active,
      is_head_chef: !!row.is_head_chef,
      // ACTIVE users only — same population as `users` above, so the two
      // sections of the report always describe the same set of people.
      active_users_assigned: headcount.get(row.id) ?? 0,
      ...diffSubject(subject, row.page_access != null ? 'role' : 'none'),
    };
  });

  const affectedUsers = users.filter(u => !u.full_access && u.lost.length > 0);
  const affectedRoles = roles.filter(r => !r.full_access && r.lost.length > 0);

  return Response.json({
    generated_at: new Date().toISOString(),
    enforced: false,
    note: 'Simulation only. canAccessPage is unchanged and still the sole enforcement authority; canAccessPageStrict is called from this report and nowhere else.',
    catalog_total: ALL_PAGE_PATHS.length,
    parents: PARENTS,
    parents_total_grants: PARENTS.reduce((n, p) => n + p.carries, 0),
    users,
    roles,
    totals: {
      users_scanned: users.length,
      users_full_access: users.filter(u => u.full_access).length,
      users_affected: affectedUsers.length,
      user_pages_lost: affectedUsers.reduce((n, u) => n + u.lost.length, 0),
      roles_scanned: roles.length,
      roles_full_access: roles.filter(r => r.full_access).length,
      roles_affected: affectedRoles.length,
      role_pages_lost: affectedRoles.reduce((n, r) => n + r.lost.length, 0),
    },
  });
}
