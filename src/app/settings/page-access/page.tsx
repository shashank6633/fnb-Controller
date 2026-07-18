'use client';

/**
 * Settings → Page Access — bulk matrix for granting page-level access per user.
 *
 *   Rows: users (excluding admins, since admins always have full access)
 *   Cols: sections (Parties, Store, ...) with expandable per-page checkboxes
 *
 * Persistence: each save calls PUT /api/auth/users with the updated page_access
 * array. Empty array → NULL on the server (= full access, backward compat).
 *
 * Admin-only screen — enforced both client-side (route check) and server-side
 * (the PUT route requires admin).
 */

import { useEffect, useMemo, useState } from 'react';
import { Shield, Save, Loader2, ChevronDown, ChevronRight, ChevronLeft, AlertTriangle, CheckCircle2, X, Search } from 'lucide-react';
import { PAGE_CATALOG, ALL_PAGE_PATHS } from '@/lib/page-catalog';
import { api } from '@/lib/api';

interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'manager' | 'staff';
  role_id?: string | null;
  role_name?: string | null;
  department_id?: string | null;
  department_name?: string;
  is_active: number;
  page_access: string | null;
  visible_department_ids: string | null;
}
interface Department { id: string; name: string; code?: string }

/** The pages a user EFFECTIVELY sees (mirrors getCurrentUser/proxy resolution):
 *  personal override → its pages; else assigned role → the role's pages
 *  (role with no restriction = every page); no role → every page.
 *  The checkbox grid is seeded from THIS, so "Follow role" shows the role's
 *  pages ticked instead of an empty grid that looks like a total reset. */
function effectivePages(u: User, rolesArr: any[]): Set<string> {
  const own = parseAccess(u.page_access);
  if (own.size > 0) return own;
  if (u.role_id) {
    const r = rolesArr.find((x: any) => x.id === u.role_id);
    if (r) {
      const rp = parseAccess(r.page_access);
      return rp.size > 0 ? rp : new Set(ALL_PAGE_PATHS);
    }
    // Role assigned but not resolvable client-side (roles fetch failed?):
    // FAIL CLOSED — show no inherited ticks rather than a full-access grid a
    // Save could accidentally persist as a near-ALL override. save() also
    // refuses page writes for this state.
    return new Set();
  }
  return new Set(ALL_PAGE_PATHS);
}

export default function PageAccessSettingsPage() {
  const [me, setMe] = useState<any>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedFor, setSavedFor] = useState<string | null>(null);
  // userId → Set<path> of currently checked paths
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  // userId → Set<departmentId> of currently checked departments
  const [deptDraft, setDeptDraft] = useState<Record<string, Set<string>>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['Parties', 'Purchasing', 'Inventory', 'Production', 'Reports'])); // default-expand likely-used sections
  const [busy, setBusy] = useState<string | null>(null);
  // Master-detail: pick an employee, then edit their pages. Far less clutter than
  // rendering every user's full catalogue at once.
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState('');   // find an employee
  const [pageSearch, setPageSearch] = useState('');    // find a page within the selected employee
  // False when the roles list failed to load — the grid then can't know a
  // role-user's real pages, so page edits are blocked (fail closed).
  const [rolesReady, setRolesReady] = useState(true);

  // reseedOnly: after saving ONE user, refresh data but keep every OTHER
  // user's unsaved draft edits instead of silently discarding them.
  const load = async (reseedOnly?: string) => {
    if (!reseedOnly) setLoading(true);
    const [m, u, d, rl] = await Promise.all([
      fetch('/api/auth/me').then(r => r.json()),
      fetch('/api/auth/users').then(r => r.json()),
      fetch('/api/departments').then(r => r.json()),
      // include_inactive: a deactivated role still governs its users' pages, so
      // we must resolve it here too. null = fetch failed → editing is blocked.
      fetch('/api/auth/roles?include_inactive=1').then(r => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    setMe(m?.user);
    const list = (u.users || []).filter((x: User) => x.is_active);
    setUsers(list);
    const rolesArr = rl?.roles || [];
    setRoles(rolesArr);
    setRolesReady(!!rl);
    if (!rl) setError('Roles could not be loaded — page-access editing is disabled so no wrong grants can be saved. Reload the page to retry.');
    setDepartments((d.departments || []).filter((x: any) => x.is_active !== 0));
    // Seed draft state from EFFECTIVE access (override, else role's pages) so
    // the grid always shows the truth — a follows-role user's boxes come
    // pre-ticked with the role's pages, and any edit starts FROM that set
    // (ticking one extra page no longer wipes the role's pages).
    setDraft(prev => {
      const pages: Record<string, Set<string>> = {};
      for (const usr of list) {
        pages[usr.id] = (reseedOnly && usr.id !== reseedOnly && prev[usr.id])
          ? prev[usr.id]
          : effectivePages(usr, rolesArr);
      }
      return pages;
    });
    setDeptDraft(prev => {
      const depts: Record<string, Set<string>> = {};
      for (const usr of list) {
        depts[usr.id] = (reseedOnly && usr.id !== reseedOnly && prev[usr.id])
          ? prev[usr.id]
          : parseAccess(usr.visible_department_ids);
      }
      return depts;
    });
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const isAdminUser = me?.role === 'admin';

  // Non-admin users that we can manage. Admins are not editable (always full access).
  const managedUsers = useMemo(() => users.filter(u => u.role !== 'admin'), [users]);

  // A user has a PERSONAL page override when their SAVED page_access is a
  // non-empty set — that override wins over their role, so editing the role
  // won't change what they see until it's cleared. (Empty/null = follow role.)
  const hasOverride = (u: User) => parseAccess(u.page_access).size > 0;

  // Resolve what a user's assigned named role grants, so we can warn the admin
  // BEFORE clearing an override (roles like "Captain"/"Staff" may grant only 1
  // page — following them then looks like "all access was wiped").
  const roleInfo = (roleId?: string | null) => {
    if (!roleId) return null;
    const r = roles.find((x: any) => x.id === roleId);
    if (!r) return null;
    const paths = parseAccess(r.page_access); // empty set = role grants FULL access
    return { name: `${r.name || 'role'}${r.is_active === 0 ? ' (deactivated)' : ''}`, count: paths.size };
  };

  // Clear a user's personal page override so they FOLLOW THEIR ROLE again
  // (save empty page_access → server stores NULL → role's pages apply). Keeps
  // the on-screen department visibility as-is. Confirms first, spelling out
  // exactly what the role grants so it's never a surprise "reset".
  const followRole = async (userId: string) => {
    const u = users.find(x => x.id === userId);
    const ri = roleInfo(u?.role_id);
    // Don't act (or claim "full access") while the role can't be resolved.
    if (!rolesReady || (u?.role_id && !ri)) {
      setError('Roles could not be loaded — reload the page before changing access.'); return;
    }
    const consequence = !u?.role_id
      ? `They have no assigned role, so they will get FULL access to every page. Assign a role in Settings → Roles to restrict them.`
      : ri && ri.count > 0
        ? `They will then follow the “${ri.name}” role, which grants only ${ri.count} page${ri.count === 1 ? '' : 's'} — they will lose access to every other page.`
        : `They will then follow the “${ri?.name || 'their'}” role, which currently grants FULL access (no pages are restricted on that role).`;
    if (!confirm(`Remove ${u?.name || 'this user'}'s custom page access?\n\n${consequence}\n\nYou can re-grant pages any time: tick the pages below and click Save.`)) return;
    setBusy(userId); setError(null); setSavedFor(null);
    try {
      const r = await api('/api/auth/users', {
        method: 'PUT',
        body: {
          id: userId,
          page_access: [],
          // Send the on-screen dept draft (falls back to the saved value) so an
          // unsaved Department Visibility edit isn't silently reverted by load().
          visible_department_ids: Array.from(deptDraft[userId] ?? parseAccess(u?.visible_department_ids)),
        },
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.error || `HTTP ${r.status}`); return; }
      setSavedFor(userId);
      await load(userId);
      setTimeout(() => setSavedFor(null), 2500);
    } finally { setBusy(null); }
  };

  const toggleSection = (label: string) =>
    setExpanded(p => {
      const n = new Set(p);
      if (n.has(label)) n.delete(label); else n.add(label);
      return n;
    });

  const togglePath = (userId: string, path: string) => {
    setDraft(p => {
      const next = { ...p };
      const set = new Set(next[userId] || []);
      if (set.has(path)) set.delete(path); else set.add(path);
      next[userId] = set;
      return next;
    });
  };

  const toggleSectionForUser = (userId: string, paths: string[]) => {
    setDraft(p => {
      const next = { ...p };
      const set = new Set(next[userId] || []);
      const allOn = paths.every(pp => set.has(pp));
      if (allOn) { for (const pp of paths) set.delete(pp); }
      else       { for (const pp of paths) set.add(pp); }
      next[userId] = set;
      return next;
    });
  };

  const selectAll = (userId: string) => {
    setDraft(p => ({ ...p, [userId]: new Set(ALL_PAGE_PATHS) }));
  };
  const clearAll = (userId: string) => {
    setDraft(p => ({ ...p, [userId]: new Set() }));
  };
  const resetUser = (userId: string) => {
    const u = users.find(x => x.id === userId);
    setDraft(p => ({ ...p, [userId]: u ? effectivePages(u, roles) : new Set<string>() }));
    setDeptDraft(p => ({ ...p, [userId]: parseAccess(u?.visible_department_ids) }));
  };

  const toggleDept = (userId: string, deptId: string) => {
    setDeptDraft(p => {
      const next = { ...p };
      const set = new Set(next[userId] || []);
      if (set.has(deptId)) set.delete(deptId); else set.add(deptId);
      next[userId] = set;
      return next;
    });
  };

  const setsEqual = (a: Set<string>, b: Set<string>) => {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  };
  const isDirty = (userId: string) => {
    const u = users.find(x => x.id === userId);
    // Baseline = EFFECTIVE pages (override, else role's set) — the same thing
    // the draft was seeded from, so an untouched grid is never "dirty".
    const savedPages = u ? effectivePages(u, roles) : new Set<string>();
    const savedDepts = parseAccess(u?.visible_department_ids);
    const curPages = draft[userId] || new Set();
    const curDepts = deptDraft[userId] || new Set();
    return !setsEqual(savedPages, curPages) || !setsEqual(savedDepts, curDepts);
  };

  const save = async (userId: string) => {
    const u = users.find(x => x.id === userId);
    const curPages = draft[userId] || new Set<string>();
    // Fail closed while role data is unavailable — the grid can't know a
    // role-user's real pages, so any page write risks a wrong grant.
    if (!rolesReady) { setError('Roles could not be loaded — reload the page before editing access.'); return; }
    if (u?.role_id && !roles.some((x: any) => x.id === u.role_id)) {
      setError(`${u.name || 'This user'}'s role couldn't be resolved — reload the page before editing their access.`); return;
    }
    // If the user follows their role and the ticked pages still equal the
    // role's set (e.g. only Department Visibility was edited), keep them
    // following the role — don't freeze the role's pages into an override.
    const keepFollowingRole = !!u && !hasOverride(u) && setsEqual(curPages, effectivePages(u, roles));
    // Zero ticks can NOT be saved: on the wire [] means "follow role" (or full
    // access with no role), so "None + Save" would silently GRANT access, not
    // revoke it. Force an explicit path instead.
    if (curPages.size === 0 && !keepFollowingRole) {
      setError(u && hasOverride(u)
        ? `Zero pages can't be saved. To remove ${u.name || 'this user'}'s custom pages use “Follow role” (it explains exactly what they'll get). To block them entirely, deactivate them on /users.`
        : `Zero pages can't be saved — with no ticks this user would simply follow their role (or get full access if they have no role). Tick the pages they should have, or restrict their role in Settings → Roles.`);
      return;
    }
    setBusy(userId); setError(null); setSavedFor(null);
    try {
      const pageArr = keepFollowingRole ? [] : Array.from(curPages);
      const deptArr = Array.from(deptDraft[userId] || []);
      // Empty arrays → server stores NULL → defaults apply:
      //   page_access null    = follow role (or full access if no role)
      //   visible_dept null   = only own dept
      const r = await api('/api/auth/users', {
        method: 'PUT',
        body: {
          id: userId,
          page_access: pageArr,
          visible_department_ids: deptArr,
        },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `HTTP ${r.status}`); return;
      }
      setSavedFor(userId);
      await load(userId);
      setTimeout(() => setSavedFor(null), 2500);
    } finally { setBusy(null); }
  };

  if (!isAdminUser && !loading) {
    return (
      <div className="p-6">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          <AlertTriangle size={16} className="inline mr-1" />
          Admin only. Sign in as admin to manage page access.
        </div>
      </div>
    );
  }

  const selectedUser = selectedUserId ? managedUsers.find(u => u.id === selectedUserId) || null : null;
  const userQuery = userSearch.trim().toLowerCase();
  const filteredUsers = userQuery
    ? managedUsers.filter(u =>
        (u.name || '').toLowerCase().includes(userQuery) ||
        (u.email || '').toLowerCase().includes(userQuery) ||
        (u.role || '').toLowerCase().includes(userQuery))
    : managedUsers;

  const initials = (u: User) => (u.name || u.email || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

  // Compact status pill — reused in the list and the detail header.
  const StatusBadge = ({ u }: { u: User }) => {
    if (hasOverride(u)) return (
      <span title="This user has a personal page override that beats their role. Editing their role won't change what they see until you clear it."
            className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200 font-semibold whitespace-nowrap">
        ⚠ Personal override
      </span>
    );
    if (u.role_id) { const ri = roleInfo(u.role_id); return (
      <span title={`Follows their role${u.role_name ? ` "${u.role_name}"` : ''}'s page set.`}
            className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium whitespace-nowrap">
        Follows role{u.role_name ? ` · ${u.role_name}` : ''}{ri ? ` · ${ri.count > 0 ? `${ri.count} pg` : 'full'}` : ''}
      </span>
    ); }
    return (
      <span title="No named role and no personal override — currently sees EVERY page. Assign a role or tick specific pages."
            className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200 font-semibold whitespace-nowrap">
        ⚠ Full access — no role
      </span>
    );
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3">
        <Shield className="text-[#af4408]" size={24} />
        <div>
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Page Access</h1>
          <p className="text-xs text-[#8B7355]">
            Pick an employee, then tick the pages they can see. The ticks show their
            <b> current effective access</b> — a user on a role starts with that role's pages.
            Changing the ticks creates a personal override for that user. Admins always see everything.
          </p>
        </div>
      </div>

      {/* Precedence warning — the #1 cause of "I changed the role but it didn't apply". */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 flex items-start gap-2">
        <AlertTriangle size={15} className="shrink-0 mt-0.5" />
        <div>
          <b>Ticking pages here creates a personal override that beats the user's role.</b> While a user has a
          personal override, editing their <a href="/settings/roles" className="underline">role's</a> pages will
          <b> not</b> change what they see. To make a user follow their role again, use
          <b> “Follow role”</b> on their row (clears the override).
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      {loading ? (
        <div className="p-10 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14}/>Loading…</div>
      ) : managedUsers.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-10 text-center text-sm text-[#8B7355]">
          No non-admin users yet. <a href="/users" className="text-[#af4408] underline">Create users on /users</a> first.
        </div>
      ) : selectedUser ? (() => {
        const u = selectedUser;
        const cur = draft[u.id] || new Set<string>();
        const dirty = isDirty(u.id);
        const pq = pageSearch.trim().toLowerCase();
        return (
          <div className="space-y-3">
            <button onClick={() => { setSelectedUserId(null); setPageSearch(''); }}
                    className="inline-flex items-center gap-1 text-sm text-[#af4408] hover:underline">
              <ChevronLeft size={16} /> All employees
            </button>
              <div key={u.id} className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E8D5C4] bg-[#FFF1E3] flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-2 flex-wrap">
                      {u.name || u.email}
                      {hasOverride(u) ? (
                        <span title="This user has a personal page override that beats their role. Editing their role won't change what they see until you clear it."
                              className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200 font-semibold">
                          ⚠ Personal override — ignores role
                        </span>
                      ) : u.role_id ? (
                        <span title={`This user follows their role${u.role_name ? ` "${u.role_name}"` : ''}'s page set.`}
                              className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium">
                          Follows role{u.role_name ? ` · ${u.role_name}` : ''}{(() => { const ri = roleInfo(u.role_id); return ri ? ` · ${ri.count > 0 ? `${ri.count} page${ri.count === 1 ? '' : 's'}` : 'full access'}` : ''; })()}
                        </span>
                      ) : (
                        <span title="This user has no named role and no personal override — so they can currently see EVERY page. Assign a role (Settings → Roles) or tick specific pages to restrict them."
                              className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200 font-semibold">
                          ⚠ Full access — no role
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-[#8B7355]">{u.email} · {u.role}{u.department_name ? ` · ${u.department_name}` : ''}</div>
                  </div>
                  <div className="text-[10px] text-[#8B7355]">
                    {hasOverride(u)
                      ? `${cur.size} pages granted`
                      : u.role_id
                        ? (() => {
                            // Reflect the LIVE draft: once the admin changes ticks,
                            // "its N pages ticked below" would be a lie.
                            const eff = effectivePages(u, roles);
                            if (!setsEqual(cur, eff)) return `${cur.size} page${cur.size === 1 ? '' : 's'} ticked — unsaved changes`;
                            const ri = roleInfo(u.role_id);
                            return ri && ri.count > 0 ? `Follows role — its ${ri.count} page${ri.count === 1 ? '' : 's'} ticked below` : 'Follows role · full access';
                          })()
                        : 'Full access — no role'}
                  </div>
                  {hasOverride(u) && (
                    <button onClick={() => followRole(u.id)} disabled={busy === u.id}
                            title="Clear this user's personal override so they follow their role's pages again"
                            className="text-[10px] text-[#af4408] hover:underline disabled:opacity-50">
                      Follow role
                    </button>
                  )}
                  <button onClick={() => selectAll(u.id)} className="text-[10px] text-[#af4408] hover:underline">All</button>
                  <button onClick={() => clearAll(u.id)} className="text-[10px] text-[#af4408] hover:underline">None</button>
                  {dirty && (
                    <button onClick={() => resetUser(u.id)} className="text-[10px] text-[#8B7355] hover:underline">Reset</button>
                  )}
                  {savedFor === u.id && (
                    <span className="text-emerald-700 text-[11px] flex items-center gap-0.5"><CheckCircle2 size={11} /> Saved</span>
                  )}
                  <button onClick={() => save(u.id)} disabled={busy === u.id || !dirty}
                          className={`inline-flex items-center gap-1 text-xs px-3 py-1 rounded ${dirty ? 'bg-[#af4408] text-white hover:bg-[#933807]' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}>
                    {busy === u.id ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} Save
                  </button>
                </div>
                <div className="divide-y divide-[#E8D5C4]/50">
                  {/* Department visibility — which depts' requisitions/data this user sees */}
                  {(() => {
                    const curDepts = deptDraft[u.id] || new Set<string>();
                    return (
                      <div className="px-4 py-3 bg-blue-50/40 border-b border-blue-200">
                        <div className="flex items-center justify-between mb-1.5">
                          <div>
                            <div className="text-xs font-semibold text-[#2D1B0E]">🏷 Department Visibility</div>
                            <div className="text-[10px] text-[#8B7355]">
                              {curDepts.size === 0
                                ? `Default: only this user's own department (${u.department_name || 'none'}).`
                                : `Sees requisitions / data for ${curDepts.size} department${curDepts.size === 1 ? '' : 's'}.`}
                              {' '}Admins / HOD / store manager always see all.
                            </div>
                          </div>
                          <button onClick={() => setDeptDraft(p => ({ ...p, [u.id]: new Set() }))}
                                  className="text-[10px] text-[#af4408] hover:underline">
                            Reset (own dept only)
                          </button>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 text-xs">
                          {departments.map(d => (
                            <label key={d.id} className="flex items-center gap-1.5 cursor-pointer hover:bg-white px-1 py-0.5 rounded">
                              <input type="checkbox" checked={curDepts.has(d.id)} onChange={() => toggleDept(u.id, d.id)} />
                              <span className="text-[#2D1B0E] truncate">{d.code ? `[${d.code}] ` : ''}{d.name}</span>
                              {u.department_id === d.id && <span className="text-[9px] text-[#af4408] ml-auto">own</span>}
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                  {/* Find a page quickly */}
                  <div className="px-4 py-2 bg-white">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" size={14} />
                      <input value={pageSearch} onChange={e => setPageSearch(e.target.value)} placeholder="Search a page…"
                             className="w-full pl-8 pr-3 py-1.5 bg-[#FFF8F0] border border-[#E8D5C4] rounded text-xs focus:outline-none focus:border-[#af4408]" />
                    </div>
                  </div>
                  {PAGE_CATALOG.map(section => {
                    const matchPages = pq ? section.pages.filter(p => p.label.toLowerCase().includes(pq) || p.path.toLowerCase().includes(pq)) : section.pages;
                    if (pq && matchPages.length === 0) return null;
                    // While searching, the header checkbox + count act on the VISIBLE
                    // subset only — never silently grant/revoke hidden pages.
                    const paths = matchPages.map(p => p.path);
                    const checkedCount = paths.filter(p => cur.has(p)).length;
                    const allChecked = checkedCount === paths.length && paths.length > 0;
                    const someChecked = checkedCount > 0 && !allChecked;
                    const isExpanded = pq ? true : expanded.has(section.label);
                    return (
                      <div key={section.label}>
                        <div role="button" tabIndex={pq ? -1 : 0} aria-expanded={isExpanded}
                             className={`px-4 py-2 flex items-center gap-2 bg-[#FFF8F0] ${pq ? '' : 'cursor-pointer hover:bg-[#FFF1E3]'}`}
                             onClick={() => { if (!pq) toggleSection(section.label); }}
                             onKeyDown={e => { if (!pq && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleSection(section.label); } }}>
                          {isExpanded ? <ChevronDown size={14} className="text-[#6B5744]" /> : <ChevronRight size={14} className="text-[#6B5744]" />}
                          <input type="checkbox" checked={allChecked}
                                 ref={el => { if (el) el.indeterminate = someChecked; }}
                                 onClick={e => e.stopPropagation()}
                                 onChange={() => toggleSectionForUser(u.id, paths)} />
                          <span className="text-xs font-semibold text-[#2D1B0E] flex-1">{section.label}</span>
                          <span className="text-[10px] text-[#8B7355]">{checkedCount} / {paths.length}</span>
                        </div>
                        {isExpanded && (
                          <div className="px-4 py-2 grid grid-cols-2 md:grid-cols-3 gap-1.5 text-xs">
                            {matchPages.map(p => (
                              <label key={p.path} title={p.hodOnly ? 'Only HODs (Is HOD) and admins can open this page — this grant is ignored for non-HODs' : p.mgmtOnly ? 'Only Admins, Managers and HODs can open this page — this grant is ignored for other roles' : undefined}
                                     className="flex items-center gap-1.5 cursor-pointer hover:bg-[#FFF8F0] px-1 py-0.5 rounded min-w-0">
                                <input type="checkbox" checked={cur.has(p.path)}
                                       onChange={() => togglePath(u.id, p.path)} />
                                <span className="text-[#2D1B0E]">{p.label}</span>
                                {p.hodOnly && <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">HOD only</span>}
                                {p.mgmtOnly && <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">Mgmt</span>}
                                <span className="text-[9px] font-mono text-[#8B7355] ml-auto truncate max-w-full">{p.path}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {pq && !PAGE_CATALOG.some(s => s.pages.some(p => p.label.toLowerCase().includes(pq) || p.path.toLowerCase().includes(pq))) && (
                    <div className="px-4 py-8 text-center text-sm text-[#8B7355]">No pages match “{pageSearch}”.</div>
                  )}
                </div>
              </div>
          </div>
        );
      })() : (
        /* ===== LIST: pick an employee, then edit their pages ===== */
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" size={16} />
            <input value={userSearch} onChange={e => setUserSearch(e.target.value)}
                   placeholder="Search employee by name, email or role…"
                   className="w-full pl-10 pr-3 py-2.5 bg-white border border-[#E8D5C4] rounded-lg text-sm focus:outline-none focus:border-[#af4408]" />
          </div>
          <p className="text-[11px] text-[#8B7355] px-1">{filteredUsers.length} employee{filteredUsers.length === 1 ? '' : 's'} · tap one to set the pages they can see.</p>
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden divide-y divide-[#E8D5C4]/60">
            {filteredUsers.length === 0 ? (
              <div className="p-8 text-center text-sm text-[#8B7355]">No employees match “{userSearch}”.</div>
            ) : filteredUsers.map(u => {
              const savedCount = parseAccess(u.page_access).size;
              return (
                <button key={u.id} onClick={() => { setSelectedUserId(u.id); setPageSearch(''); }}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#FFF8F0] transition-colors">
                  <div className="w-9 h-9 rounded-full bg-[#F3E2D0] text-[#a8632b] flex items-center justify-center text-[11px] font-bold shrink-0">{initials(u)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-2 flex-wrap">
                      <span className="truncate">{u.name || u.email}</span>
                      <StatusBadge u={u} />
                    </div>
                    <div className="text-[11px] text-[#8B7355] truncate">{u.email} · {u.role}{u.department_name ? ` · ${u.department_name}` : ''}</div>
                  </div>
                  <div className="text-[11px] text-[#8B7355] whitespace-nowrap hidden sm:block">
                    {savedCount > 0 ? `${savedCount} pages` : (u.role_id ? 'Follows role' : 'Full access')}
                  </div>
                  <ChevronRight size={16} className="text-[#C4B09A] shrink-0" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function parseAccess(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch { return new Set(); }
}
