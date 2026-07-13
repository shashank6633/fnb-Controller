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
import { Shield, Save, Loader2, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { PAGE_CATALOG, ALL_PAGE_PATHS } from '@/lib/page-catalog';
import { api } from '@/lib/api';

interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'manager' | 'staff';
  department_id?: string | null;
  department_name?: string;
  is_active: number;
  page_access: string | null;
  visible_department_ids: string | null;
}
interface Department { id: string; name: string; code?: string }

export default function PageAccessSettingsPage() {
  const [me, setMe] = useState<any>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedFor, setSavedFor] = useState<string | null>(null);
  // userId → Set<path> of currently checked paths
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  // userId → Set<departmentId> of currently checked departments
  const [deptDraft, setDeptDraft] = useState<Record<string, Set<string>>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['Parties', 'Purchasing', 'Inventory', 'Production'])); // default-expand likely-used sections
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const [m, u, d] = await Promise.all([
      fetch('/api/auth/me').then(r => r.json()),
      fetch('/api/auth/users').then(r => r.json()),
      fetch('/api/departments').then(r => r.json()),
    ]);
    setMe(m?.user);
    const list = (u.users || []).filter((x: User) => x.is_active);
    setUsers(list);
    setDepartments((d.departments || []).filter((x: any) => x.is_active !== 0));
    // Seed draft state from current values
    const pages: Record<string, Set<string>> = {};
    const depts: Record<string, Set<string>> = {};
    for (const usr of list) {
      pages[usr.id] = parseAccess(usr.page_access);
      depts[usr.id] = parseAccess(usr.visible_department_ids);
    }
    setDraft(pages);
    setDeptDraft(depts);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const isAdminUser = me?.role === 'admin';

  // Non-admin users that we can manage. Admins are not editable (always full access).
  const managedUsers = useMemo(() => users.filter(u => u.role !== 'admin'), [users]);

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
    setDraft(p => ({ ...p, [userId]: parseAccess(u?.page_access) }));
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
    const savedPages = parseAccess(u?.page_access);
    const savedDepts = parseAccess(u?.visible_department_ids);
    const curPages = draft[userId] || new Set();
    const curDepts = deptDraft[userId] || new Set();
    return !setsEqual(savedPages, curPages) || !setsEqual(savedDepts, curDepts);
  };

  const save = async (userId: string) => {
    setBusy(userId); setError(null); setSavedFor(null);
    try {
      const pageArr = Array.from(draft[userId] || []);
      const deptArr = Array.from(deptDraft[userId] || []);
      // Empty arrays → server stores NULL → defaults apply:
      //   page_access null    = full page access
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
      await load();
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

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3">
        <Shield className="text-[#af4408]" size={24} />
        <div>
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Page Access</h1>
          <p className="text-xs text-[#8B7355]">
            Per-user page visibility. Tick the pages each user should see in the sidebar.
            Empty selection = full access (backward compat). Admins always see everything.
          </p>
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
      ) : (
        <div className="space-y-3">
          {managedUsers.map(u => {
            const cur = draft[u.id] || new Set<string>();
            const dirty = isDirty(u.id);
            return (
              <div key={u.id} className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E8D5C4] bg-[#FFF1E3] flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-[#2D1B0E]">{u.name || u.email}</div>
                    <div className="text-[10px] text-[#8B7355]">{u.email} · {u.role}{u.department_name ? ` · ${u.department_name}` : ''}</div>
                  </div>
                  <div className="text-[10px] text-[#8B7355]">
                    {cur.size === 0 ? 'Full access (no map)' : `${cur.size} pages granted`}
                  </div>
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
                  {PAGE_CATALOG.map(section => {
                    const paths = section.pages.map(p => p.path);
                    const checkedCount = paths.filter(p => cur.has(p)).length;
                    const allChecked = checkedCount === paths.length;
                    const someChecked = checkedCount > 0 && !allChecked;
                    const isExpanded = expanded.has(section.label);
                    return (
                      <div key={section.label}>
                        <div className="px-4 py-2 flex items-center gap-2 bg-[#FFF8F0] cursor-pointer hover:bg-[#FFF1E3]"
                             onClick={() => toggleSection(section.label)}>
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
                            {section.pages.map(p => (
                              <label key={p.path} title={p.hodOnly ? 'Only HODs (Is HOD) and admins can open this page — this grant is ignored for non-HODs' : undefined}
                                     className="flex items-center gap-1.5 cursor-pointer hover:bg-[#FFF8F0] px-1 py-0.5 rounded">
                                <input type="checkbox" checked={cur.has(p.path)}
                                       onChange={() => togglePath(u.id, p.path)} />
                                <span className="text-[#2D1B0E]">{p.label}</span>
                                {p.hodOnly && <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">HOD only</span>}
                                <span className="text-[9px] font-mono text-[#8B7355] ml-auto">{p.path}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
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
