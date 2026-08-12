'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users, Plus, Edit, X, Save, Loader2, ShieldCheck, Shield, ChefHat, Warehouse, Building, ChevronDown, ChevronRight, ShieldAlert, MapPin, CheckSquare } from 'lucide-react';
import { api } from '@/lib/api';
import { PAGE_CATALOG, ALL_PAGE_PATHS } from '@/lib/page-catalog';

type UserRole = 'admin' | 'manager' | 'staff';
interface AppUser {
  id: string; email: string; name: string;
  role: UserRole;
  /** Assigned named role (roles table) + its display name. */
  role_id?: string | null;
  role_name?: string | null;
  position?: string;
  is_active: number;
  department_id?: string | null;
  department_name?: string | null;
  is_head_chef?: number;
  is_store_manager?: number;
  /** Granular: approve requisitions (dine-in + party) without the full HOD flag. */
  can_approve_requisitions?: number;
  /** JSON-stringified array of allowed page paths. NULL = full access. */
  page_access?: string | null;
  /** JSON-stringified array of department_ids whose data is visible. NULL = own dept only. */
  visible_department_ids?: string | null;
  /** JSON-stringified array of floor/zone names a captain is locked to. NULL = all areas. */
  preferred_zones?: string | null;
  /** JSON-stringified array of table_ids a captain is locked to. NULL = all tables. */
  preferred_table_ids?: string | null;
  last_login_at?: string; created_at?: string;
}
interface Department { id: string; name: string; code?: string; is_active: number; }
/** Dine-in table (subset of restaurant_tables) — used for the captain-area picker. */
interface RestTable { id: string; table_number: string; zone?: string | null; seats?: number; }
interface Role {
  id: string; name: string; base_role: UserRole;
  is_head_chef: number; is_store_manager: number; can_approve_requisitions?: number; description?: string;
  /** JSON-stringified array of the role's pages. NULL = the role grants every page. */
  page_access?: string | null;
  /** A DEACTIVATED role still governs the users assigned to it (getCurrentUser
   *  joins roles without an is_active filter), so we load and resolve those too. */
  is_active?: number;
}

/** The pages a user EFFECTIVELY sees — mirrors getCurrentUser()/proxy.ts:
 *  a personal override wins; else the assigned role's pages (a role with no
 *  restriction = every page); no role at all = every page.
 *  The checkbox grid is seeded from THIS so a follows-role user shows their
 *  role's pages ticked instead of an empty grid that reads as "no access".
 *  Same helper as Settings → Page Access; keep the two in step. */
function effectivePages(u: { page_access?: string | null; role_id?: string | null }, rolesArr: Role[]): Set<string> {
  const own = parseArr(u.page_access);
  if (own.size > 0) return own;
  if (u.role_id) {
    const r = rolesArr.find(x => x.id === u.role_id);
    if (r) {
      const rp = parseArr(r.page_access);
      return rp.size > 0 ? rp : new Set(ALL_PAGE_PATHS);
    }
    // Role assigned but not resolvable (roles fetch failed): FAIL CLOSED —
    // an empty grid is safer than a full-access grid a Save could persist.
    return new Set();
  }
  return new Set(ALL_PAGE_PATHS);
}

/**
 * Position templates — picking one auto-suggests the approval flags.
 * The admin can still override the flags after picking a position; the
 * template is just a sensible default so common roles don't need fiddling.
 */
const POSITION_TEMPLATES: Array<{
  value: string; label: string;
  defaults: { role: UserRole; is_head_chef: 0 | 1; is_store_manager: 0 | 1 };
  hint: string;
}> = [
  { value: '',                    label: '— None / Custom —',
    defaults: { role: 'staff', is_head_chef: 0, is_store_manager: 0 }, hint: 'Manually configure role + permissions below.' },
  { value: 'Department User',     label: 'Department User (own requisitions only)',
    defaults: { role: 'staff', is_head_chef: 0, is_store_manager: 0 }, hint: 'Raises & views ONLY their own department’s requisitions. Remember to set the Department below.' },
  { value: 'Head Chef',           label: 'HOD (Head of Department)',
    defaults: { role: 'manager', is_head_chef: 1, is_store_manager: 0 }, hint: 'Approves requisitions — ⚠ sees ALL departments’ requisitions.' },
  { value: 'Sous Chef',           label: 'Sous Chef',
    defaults: { role: 'manager', is_head_chef: 1, is_store_manager: 0 }, hint: 'Approves when HOD is away — ⚠ sees ALL requisitions.' },
  { value: 'Bar Manager',         label: 'Bar Manager',
    defaults: { role: 'manager', is_head_chef: 1, is_store_manager: 0 }, hint: 'Approves requisitions — ⚠ sees ALL departments’ requisitions.' },
  { value: 'Operations Manager',  label: 'Operations Manager',
    defaults: { role: 'manager', is_head_chef: 1, is_store_manager: 1 }, hint: 'Approves + processes store/POs — ⚠ sees ALL requisitions.' },
  { value: 'Store Manager',       label: 'Store Manager',
    defaults: { role: 'manager', is_head_chef: 0, is_store_manager: 1 }, hint: 'Issues stock + raises vendor POs — ⚠ sees ALL requisitions.' },
  { value: 'Storekeeper',         label: 'Storekeeper',
    defaults: { role: 'manager', is_head_chef: 0, is_store_manager: 1 }, hint: 'Handles physical stock — ⚠ sees ALL requisitions.' },
  { value: 'Bartender',           label: 'Bartender',
    defaults: { role: 'staff',   is_head_chef: 0, is_store_manager: 0 }, hint: 'Raises requisitions for the Bar — own department only.' },
  { value: 'Cook',                label: 'Cook',
    defaults: { role: 'staff',   is_head_chef: 0, is_store_manager: 0 }, hint: 'Raises requisitions for their kitchen — own department only.' },
  { value: 'Server',              label: 'Server / Service Staff',
    defaults: { role: 'staff',   is_head_chef: 0, is_store_manager: 0 }, hint: 'Raises service-side requisitions — own department only.' },
  { value: 'Other',               label: 'Other (specify in notes)',
    defaults: { role: 'staff',   is_head_chef: 0, is_store_manager: 0 }, hint: 'Custom title — set permissions below.' },
];

/**
 * Composite role label — combines base role with the additive department/flags
 * so admins can see at a glance who is the chef of which kitchen.
 */
function roleSummary(u: AppUser): string {
  if (u.role === 'admin') return 'Admin (full access)';
  const tags: string[] = [];
  if (u.position) tags.push(u.position);
  else {
    if (u.is_head_chef)     tags.push('HOD');
    if (u.is_store_manager) tags.push('Store Manager');
  }
  if (u.department_name)  tags.push(u.department_name);
  return tags.length ? tags.join(' · ') : `${u.role} (no department)`;
}

export default function UsersPage() {
  const router = useRouter();
  const [list, setList] = useState<AppUser[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [tables, setTables] = useState<RestTable[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<AppUser> & { password?: string } | null>(null);
  const [me, setMe] = useState<AppUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  // False when the roles list failed to load. The page-access grid then can't
  // know what a role-based user actually inherits, so page edits are blocked
  // (fail closed) rather than saved from a grid that may be showing nothing.
  const [rolesReady, setRolesReady] = useState(true);

  const load = async () => {
    setLoading(true);
    const meRes = await fetch('/api/auth/me').then(r => r.json());
    setMe(meRes.user);
    if (meRes.user?.role !== 'admin') {
      setError('Only Admin can manage users.');
      setLoading(false);
      return;
    }
    const [r, dRes, roleRes, tRes] = await Promise.all([
      fetch('/api/auth/users'),
      fetch('/api/departments').then(r => r.json()).catch(() => ({ departments: [] })),
      // include_inactive: a deactivated role STILL governs its users' tier and
      // pages, so we need it here to resolve them honestly (and to name it in
      // the Role picker). null = the fetch failed → page editing is blocked.
      fetch('/api/auth/roles?include_inactive=1').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/dine-in/tables').then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] })),
    ]);
    if (r.ok) {
      const d = await r.json();
      setList(d.users || []);
    } else {
      setError((await r.json()).error || 'Failed to load users');
    }
    setDepartments((dRes.departments || []).filter((d: Department) => d.is_active));
    setTables(tRes.items || []);
    setRoles(roleRes?.roles || []);
    setRolesReady(!!roleRes);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing?.email) { alert('Email required'); return; }
    const isNew = !editing.id;
    if (isNew && !editing.password) { alert('Password required for new users'); return; }

    // Fail closed while the roles list is unavailable: the page grid was seeded
    // from an unresolvable role, so saving it could strip or over-grant pages.
    if (!rolesReady) { alert('Roles could not be loaded — reload the page before saving access changes.'); return; }
    if (editing.role_id && !roles.some(r => r.id === editing.role_id)) {
      alert("This user's role couldn't be resolved — reload the page before saving."); return;
    }

    // Convert stringified arrays → real arrays for the API. Sending null leaves
    // the user following their role (or full access if they have no role).
    const body: any = { ...editing };
    if (typeof body.page_access === 'string') {
      try { body.page_access = JSON.parse(body.page_access); }
      catch { body.page_access = null; }
    }
    // An empty page list can NOT be saved: on the wire [] is stored as NULL,
    // which means FOLLOW ROLE / full access — so "untick everything + Save"
    // would silently GRANT access instead of revoking it. Make the admin pick.
    if (Array.isArray(body.page_access) && body.page_access.length === 0) {
      alert(
        'No pages are ticked, and that cannot be saved as "no access".\n\n' +
        'An empty page list means "follow the assigned role" (or full access when there is no role).\n\n' +
        '• To restrict this user: tick the pages they should have.\n' +
        '• To hand them back to their role: use "Follow role".\n' +
        '• To block them entirely: untick Active.'
      );
      return;
    }
    if (typeof body.visible_department_ids === 'string') {
      try { body.visible_department_ids = JSON.parse(body.visible_department_ids); }
      catch { body.visible_department_ids = null; }
    }
    if (typeof body.preferred_zones === 'string') {
      try { body.preferred_zones = JSON.parse(body.preferred_zones); }
      catch { body.preferred_zones = null; }
    }
    if (typeof body.preferred_table_ids === 'string') {
      try { body.preferred_table_ids = JSON.parse(body.preferred_table_ids); }
      catch { body.preferred_table_ids = null; }
    }

    const r = await api('/api/auth/users', { method: isNew ? 'POST' : 'PUT', body });
    if (!r.ok) { alert((await r.json()).error || 'Failed'); return; }
    setEditing(null); load();
  };

  if (error) return <div className="max-w-2xl mx-auto p-8 text-center text-red-700 bg-red-50 border border-red-200 rounded-xl">{error}</div>;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <Users className="w-6 h-6" /> Users &amp; Roles
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">Admin can create users and gate Approve actions on Purchase Orders.</p>
          </div>
          <button onClick={() => setEditing({
            role: 'staff', role_id: null, is_active: 1, name: '', email: '', password: '',
            position: '',
            department_id: null, is_head_chef: 0, is_store_manager: 0, can_approve_requisitions: 0,
          })}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" /> New User
          </button>
        </div>

        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          {loading ? <div className="p-6 text-center text-sm text-[#8B7355]">Loading…</div> : (
            <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-sm">
              <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                <tr>
                  <th className="text-left  py-2 px-3 font-medium">Name / Email</th>
                  <th className="text-left  py-2 px-3 font-medium">Position</th>
                  <th className="text-left  py-2 px-3 font-medium">Role</th>
                  <th className="text-left  py-2 px-3 font-medium">Effective tier</th>
                  <th className="text-left  py-2 px-3 font-medium">Department</th>
                  <th className="text-left  py-2 px-3 font-medium">Permissions</th>
                  <th className="text-left  py-2 px-3 font-medium">Status</th>
                  <th className="text-left  py-2 px-3 font-medium">Last login</th>
                  <th className="text-right py-2 px-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map(u => (
                  <tr key={u.id} className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 ${!u.is_active ? 'opacity-50' : ''}`}>
                    <td className="py-2 px-3">
                      <div className="text-xs font-medium">{u.name || '—'} {me?.id === u.id && <span className="text-[10px] text-[#af4408]">(you)</span>}</div>
                      <div className="text-[10px] text-[#8B7355]">{u.email}</div>
                    </td>
                    <td className="py-2 px-3 text-xs text-[#6B5744]">
                      {u.position
                        ? <span className="font-medium">{u.position}</span>
                        : <span className="text-[#8B7355] italic">—</span>}
                    </td>
                    <td className="py-2 px-3">
                      {u.role_name && <div className="text-xs font-semibold text-[#2D1B0E] mb-0.5">{u.role_name}</div>}
                      <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                        u.role === 'admin'   ? 'bg-[#af4408] text-white' :
                        u.role === 'manager' ? 'bg-blue-100 text-blue-700' :
                                               'bg-gray-100 text-[#6B5744]'
                      }`}>
                        {u.role === 'admin' ? <ShieldCheck className="w-3 h-3" /> : <Shield className="w-3 h-3" />} {(u.role || 'staff').toUpperCase()}
                      </span>
                    </td>
                    {/* EFFECTIVE tier — what getCurrentUser actually resolves: the
                        assigned named role's base_role wins over the legacy user
                        tier. Surfaces silent downgrades (e.g. a "manager" user
                        whose named role is staff-based). Purely display. */}
                    <td className="py-2 px-3">
                      {(() => {
                        const assignedRole = u.role_id ? roles.find(x => x.id === u.role_id) : undefined;
                        const tier: UserRole = (assignedRole?.base_role || u.role || 'staff') as UserRole;
                        const cls = tier === 'admin'   ? 'bg-red-100 text-red-700'
                                  : tier === 'manager' ? 'bg-amber-100 text-amber-800'
                                                       : 'bg-gray-100 text-gray-600';
                        const fromRole = u.role_id ? (assignedRole?.name || u.role_name || '') : '';
                        return (
                          <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded ${cls}`}
                                title={fromRole ? `from role ${fromRole}` : undefined}>
                            {tier.toUpperCase()}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="py-2 px-3 text-xs text-[#6B5744]">
                      {u.department_name
                        ? <span className="inline-flex items-center gap-1"><Building className="w-3 h-3" /> {u.department_name}</span>
                        : <span className="text-[#8B7355] italic">—</span>}
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex gap-1 flex-wrap">
                        {u.is_head_chef ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-medium inline-flex items-center gap-0.5">
                            <ChefHat className="w-3 h-3" /> HOD
                          </span>
                        ) : null}
                        {u.is_store_manager ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-medium inline-flex items-center gap-0.5">
                            <Warehouse className="w-3 h-3" /> Store
                          </span>
                        ) : null}
                        {!u.is_head_chef && !!u.can_approve_requisitions ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 font-medium inline-flex items-center gap-0.5">
                            <CheckSquare className="w-3 h-3" /> Approver
                          </span>
                        ) : null}
                        {u.role === 'admin' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">
                            ★ All
                          </span>
                        )}
                        {!u.is_head_chef && !u.is_store_manager && !u.can_approve_requisitions && u.role !== 'admin' && (
                          <span className="text-[10px] text-[#8B7355] italic">staff</span>
                        )}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-xs">{u.is_active ? <span className="text-green-700">Active</span> : <span className="text-gray-500">Disabled</span>}</td>
                    <td className="py-2 px-3 text-xs text-[#6B5744]">
                      {u.last_login_at ? new Date(u.last_login_at).toLocaleString('en-IN') : <span className="text-[#8B7355]">never</span>}
                    </td>
                    <td className="py-2 px-3 text-right">
                      <button onClick={() => setEditing({
                                id: u.id, name: u.name, email: u.email,
                                role: u.role, role_id: u.role_id ?? null, is_active: u.is_active, password: '',
                                position: u.position || '',
                                department_id: u.department_id ?? null,
                                is_head_chef: u.is_head_chef ?? 0,
                                is_store_manager: u.is_store_manager ?? 0,
                                can_approve_requisitions: u.can_approve_requisitions ?? 0,
                                // Normalize a stored empty array to null: '[]' already
                                // resolves as "follow role" everywhere, so carrying it
                                // into the modal would misread as a real override.
                                page_access: parseArr(u.page_access).size > 0 ? u.page_access! : null,
                                visible_department_ids: u.visible_department_ids ?? null,
                                preferred_zones: u.preferred_zones ?? null,
                                preferred_table_ids: u.preferred_table_ids ?? null,
                                section: (u as any).section ?? '',
                              } as any)}
                              className="p-2 -m-1 text-[#6B5744] hover:text-[#af4408]"><Edit className="w-4 h-4" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>

        {editing && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
            {/* House safe-modal shell: card capped to viewport, body scrolls
                internally, so header + Save/Cancel stay on screen on phones. */}
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">{editing.id ? 'Edit User' : 'New User'}</h2>
                <button onClick={() => setEditing(null)}><X className="w-5 h-5 text-[#8B7355]" /></button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
                {!editing.id && (
                  <label className="block text-xs text-[#6B5744]">Email
                    <input value={editing.email || ''} onChange={e => setEditing({ ...editing, email: e.target.value })}
                           className="w-full mt-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                  </label>
                )}
                <label className="block text-xs text-[#6B5744]">Name
                  <input value={editing.name || ''} onChange={e => setEditing({ ...editing, name: e.target.value })}
                         className="w-full mt-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                </label>

                <label className="block text-xs text-[#6B5744]">Position / Title
                  <select value={editing.position || ''}
                          onChange={e => {
                            const v = e.target.value;
                            const tpl = POSITION_TEMPLATES.find(t => t.value === v);
                            // Apply template defaults — admin can still tweak the checkboxes below.
                            // We don't override role=admin (admins are admin regardless of position template).
                            setEditing(prev => ({
                              ...prev!, position: v,
                              // Don't let the position template clobber tier/flags when a
                              // named role is driving them.
                              ...(tpl && !prev?.role_id && prev?.role !== 'admin' ? {
                                role: tpl.defaults.role,
                                is_head_chef: tpl.defaults.is_head_chef,
                                is_store_manager: tpl.defaults.is_store_manager,
                              } : {}),
                            }));
                          }}
                          className="w-full mt-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm">
                    {POSITION_TEMPLATES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  {(() => {
                    const tpl = POSITION_TEMPLATES.find(t => t.value === (editing.position || ''));
                    return tpl ? <span className="block text-[10px] text-[#8B7355] mt-0.5">{tpl.hint}</span> : null;
                  })()}
                </label>

                <label className="block text-xs text-[#6B5744]">Role
                  <select value={editing.role_id || ''}
                          onChange={e => {
                            const rid = e.target.value;
                            if (!rid) { setEditing({ ...editing, role_id: null }); return; }
                            const r = roles.find(x => x.id === rid);
                            if (!r) return;
                            // A named role drives the tier + flags + (default) pages.
                            setEditing({ ...editing!, role_id: rid, role: r.base_role,
                              is_head_chef: r.is_head_chef ? 1 : 0, is_store_manager: r.is_store_manager ? 1 : 0,
                              can_approve_requisitions: r.can_approve_requisitions ? 1 : 0,
                              page_access: null });
                          }}
                          className="w-full mt-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm font-medium">
                    <option value="">— Custom (set tier + pages manually) —</option>
                    {/* Only ACTIVE roles are offered, plus this user's own role if it
                        has since been deactivated — that role still governs them, so
                        hiding it would make the picker read as "Custom" and lie. */}
                    {roles
                      .filter(r => r.is_active !== 0 || r.id === editing.role_id)
                      .map(r => (
                        <option key={r.id} value={r.id}>
                          {r.name}{r.is_active === 0 ? ' (deactivated)' : ''}
                        </option>
                      ))}
                  </select>
                  <span className="block text-[10px] text-[#8B7355] mt-0.5">
                    {editing.role_id
                      ? 'This role sets what they can do + which pages they see. Edit roles in Settings → Roles. Per-user page overrides below still apply.'
                      : 'Pick a named role for a ready preset, or set the tier + pages manually below.'}
                  </span>
                </label>

                <label className="block text-xs text-[#6B5744]">Permission tier
                  <select value={editing.role} disabled={!!editing.role_id}
                          onChange={e => setEditing({ ...editing, role: e.target.value as any })}
                          className="w-full mt-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm disabled:opacity-60">
                    <option value="staff">Staff — raises requisitions only</option>
                    <option value="manager">Manager — can be granted approval permissions (Bar Manager, Sous Chef, Ops Mgr…)</option>
                    <option value="admin">Admin — full access, approves vendor POs</option>
                  </select>
                  {editing.role_id ? <span className="block text-[10px] text-[#8B7355] mt-0.5">Set by the role above.</span> : null}
                </label>

                <label className="block text-xs text-[#6B5744]">Department
                  <select value={editing.department_id || ''}
                          onChange={e => setEditing({ ...editing, department_id: e.target.value || null })}
                          disabled={editing.role === 'admin'}
                          className="w-full mt-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm disabled:opacity-60">
                    <option value="">— No department (cross-functional) —</option>
                    {departments.map(d => (
                      <option key={d.id} value={d.id}>
                        {d.code ? `[${d.code}] ` : ''}{d.name}
                      </option>
                    ))}
                  </select>
                  <span className="block text-[10px] text-[#8B7355] mt-0.5">
                    Department staff (e.g. Bartender, Pizza Cook) raise requisitions for their own department.
                    Leave blank for HOD / Store Manager who span all kitchens.
                  </span>
                </label>

                <label className="block text-xs text-[#6B5744]">Parent Role / Section
                  <select value={(editing as any).section || ''}
                          onChange={e => setEditing({ ...editing, section: e.target.value } as any)}
                          className="w-full mt-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm">
                    <option value="">— None —</option>
                    <option value="Kitchen">Kitchen</option>
                    <option value="Bar">Bar</option>
                    <option value="Service">Service</option>
                    <option value="Maintenance">Maintenance</option>
                    <option value="Store">Store</option>
                    <option value="GRE">GRE (Front Office)</option>
                  </select>
                  <span className="block text-[10px] text-[#8B7355] mt-0.5">
                    Kitchen &amp; Bar auto-filter the Kitchen Display to that section&apos;s KOTs and route KOT
                    printing (food vs bar). Service / Maintenance / Store are organisational only.
                  </span>
                </label>

                <fieldset className="border border-[#E8D5C4] rounded-lg p-3">
                  <legend className="px-1 text-[10px] uppercase tracking-wide text-[#8B7355]">Approval Permissions</legend>
                  <label className="flex items-start gap-2 text-xs text-[#6B5744] py-1">
                    <input type="checkbox" className="mt-0.5" disabled={!!editing.role_id}
                           checked={!!editing.is_head_chef}
                           onChange={e => setEditing({ ...editing, is_head_chef: e.target.checked ? 1 : 0 })} />
                    <span>
                      <span className="inline-flex items-center gap-1 font-medium text-blue-700">
                        <ChefHat className="w-3 h-3" /> Is HOD (Head of Department)
                      </span>
                      <span className="block text-[10px] text-[#8B7355]">
                        Approves / rejects requisitions submitted by department staff.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-xs text-[#6B5744] py-1 border-t border-[#E8D5C4]/50">
                    <input type="checkbox" className="mt-0.5" disabled={!!editing.role_id}
                           checked={!!editing.is_store_manager}
                           onChange={e => setEditing({ ...editing, is_store_manager: e.target.checked ? 1 : 0 })} />
                    <span>
                      <span className="inline-flex items-center gap-1 font-medium text-purple-700">
                        <Warehouse className="w-3 h-3" /> Store Manager
                      </span>
                      <span className="block text-[10px] text-[#8B7355]">
                        Processes HOD-approved requisitions — issues from stock, raises vendor POs for shortfall.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-xs text-[#6B5744] py-1 border-t border-[#E8D5C4]/50">
                    <input type="checkbox" className="mt-0.5" disabled={!!editing.role_id}
                           checked={!!editing.can_approve_requisitions}
                           onChange={e => setEditing({ ...editing, can_approve_requisitions: e.target.checked ? 1 : 0 })} />
                    <span>
                      <span className="inline-flex items-center gap-1 font-medium text-teal-700">
                        <CheckSquare className="w-3 h-3" /> Can approve requisitions (dine-in + party)
                      </span>
                      <span className="block text-[10px] text-[#8B7355]">
                        Approval inbox only — no HOD-only pages, no party financials. Not needed if “Is HOD” is ticked.
                      </span>
                    </span>
                  </label>
                  {editing.role_id ? (
                    <p className="text-[10px] text-[#8B7355] mt-1 italic">
                      Set by the assigned role — edit them in Settings → Roles.
                    </p>
                  ) : null}
                  {editing.role === 'admin' && (
                    <p className="text-[10px] text-amber-800 mt-1 italic">
                      Admin role already includes both permissions implicitly.
                    </p>
                  )}
                </fieldset>

                <label className="block text-xs text-[#6B5744]">{editing.id ? 'New password (leave blank to keep)' : 'Password'}
                  <input type="password" value={editing.password || ''} onChange={e => setEditing({ ...editing, password: e.target.value })}
                         className="w-full mt-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                </label>
                <label className="flex items-center gap-2 text-xs text-[#6B5744]">
                  <input type="checkbox" checked={!!editing.is_active} onChange={e => setEditing({ ...editing, is_active: e.target.checked ? 1 : 0 })} />
                  Active
                </label>

                {/* Page Access matrix — admin can grant/deny specific pages
                    per user without bouncing to /settings/page-access.
                    Disabled when role=admin since admins always have full access. */}
                <PageAccessSection
                  editing={editing}
                  setEditing={setEditing}
                  departments={departments}
                  roles={roles}
                  rolesReady={rolesReady}
                />

                {/* Captain Area — restrict this captain to specific floors + tables.
                    Only enforced when the 'captain_area_lock' setting is on (Settings → Integrations). */}
                <CaptainAreaSection
                  editing={editing}
                  setEditing={setEditing}
                  tables={tables}
                />
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2 shrink-0">
                <button onClick={() => setEditing(null)} className="px-3 py-2 text-sm text-[#6B5744]">Cancel</button>
                <button onClick={save} className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1">
                  <Save className="w-4 h-4" /> Save
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ──────────────── Page Access section embedded in the user-edit modal ────────────────
   Lets admin grant/revoke specific pages + department visibility per user, inline.
   Same data model as /settings/page-access — they edit the same DB columns. */

function PageAccessSection({ editing, setEditing, departments, roles, rolesReady }: {
  editing: any;
  setEditing: (e: any) => void;
  departments: Array<{ id: string; name: string; code?: string }>;
  roles: Role[];
  rolesReady: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sectionOpen, setSectionOpen] = useState<Set<string>>(new Set());

  const isAdmin = editing.role === 'admin';
  const assignedRole = editing.role_id ? roles.find(r => r.id === editing.role_id) : undefined;
  // A PERSONAL override exists only while users.page_access is a non-empty set.
  // null (and the empty set, which stores as NULL) both mean "follow the role".
  const hasOverride = parseArr(editing.page_access).size > 0;
  const roleUnresolved = !!editing.role_id && !assignedRole;
  // A role whose own page_access is empty/NULL restricts nothing = every page.
  const rolePageCount = assignedRole ? parseArr(assignedRole.page_access).size : 0;
  const roleGrantsEveryPage = !!assignedRole && rolePageCount === 0;
  // The admin emptied the grid (Clear, or unticking the last page). This is a
  // real, distinct state: it is NOT "follow role" and it is NOT saveable —
  // an empty list stores as NULL, which grants rather than revokes. save()
  // refuses it; here we just have to stop calling it something it isn't.
  const touchedEmpty = typeof editing.page_access === 'string' && parseArr(editing.page_access).size === 0;

  // The TICKED set. Seeded from EFFECTIVE pages (override, else the role's
  // pages, else all) — not from the raw users.page_access column. That is the
  // whole fix: a follows-role user used to render an all-empty grid, so ticking
  // one extra page saved just that page and silently dropped the role's set.
  const [draft, setDraft] = useState<Set<string>>(() => effectivePages(editing, roles));
  const currentDepts = parseArr(editing.visible_department_ids);

  // Reseed when the modal switches to a different user, or when the assigned
  // role changes (picking a role clears the override, so the grid must show
  // the new role's pages). Keyed so ordinary keystrokes never reseed.
  const seedKey = `${editing.id ?? 'new'}|${editing.role_id ?? ''}`;
  const seededFor = useRef(seedKey);
  useEffect(() => {
    if (seededFor.current === seedKey) return;
    seededFor.current = seedKey;
    setDraft(effectivePages({ page_access: editing.page_access, role_id: editing.role_id }, roles));
  }, [seedKey, editing.page_access, editing.role_id, roles]);

  // Any grid edit writes the WHOLE ticked set as a personal override, so
  // whatever the user already had is carried along instead of being dropped.
  const commit = (next: Set<string>) => {
    setDraft(next);
    setEditing({ ...editing, page_access: JSON.stringify(Array.from(next)) });
  };
  const togglePage = (path: string) => {
    const next = new Set(draft);
    if (next.has(path)) next.delete(path); else next.add(path);
    commit(next);
  };
  const toggleSectionPaths = (paths: string[]) => {
    const next = new Set(draft);
    const allOn = paths.every(p => next.has(p));
    if (allOn) { for (const p of paths) next.delete(p); }
    else { for (const p of paths) next.add(p); }
    commit(next);
  };
  const toggleDept = (id: string) => {
    const next = new Set(currentDepts);
    if (next.has(id)) next.delete(id); else next.add(id);
    setEditing({ ...editing, visible_department_ids: JSON.stringify(Array.from(next)) });
  };
  const grantAll = () => commit(new Set(ALL_PAGE_PATHS));
  // Unticks everything so a fresh set can be picked. Saving with nothing ticked
  // is refused in save() — an empty list stores as NULL, which GRANTS (follow
  // role / full access) rather than revoking.
  const clearTicks = () => commit(new Set());
  // Drop the personal override: back to whatever the role says, and keep
  // following it as the role is edited later.
  const followRole = () => {
    setDraft(effectivePages({ page_access: null, role_id: editing.role_id }, roles));
    setEditing({ ...editing, page_access: null });
  };
  const toggleSection = (label: string) =>
    setSectionOpen(prev => {
      const n = new Set(prev);
      if (n.has(label)) n.delete(label); else n.add(label);
      return n;
    });

  const summary = isAdmin
    ? 'Admin — always has full access (cannot be restricted)'
    : roleUnresolved
      ? "⚠ This user's role could not be loaded — reload before editing access"
      : touchedEmpty
        ? '⚠ Nothing ticked — this cannot be saved as “no access”'
        : hasOverride
          ? `Custom override — ${draft.size} page${draft.size === 1 ? '' : 's'}${assignedRole ? ` (ignores the ${assignedRole.name} role)` : ''}`
          : assignedRole
            ? `Following the ${assignedRole.name} role — ${roleGrantsEveryPage ? 'every page' : `${rolePageCount} page${rolePageCount === 1 ? '' : 's'}`}`
            : 'No role assigned — full access to every page';

  return (
    <div className="border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]">
      {/* Header row is a DIV, not a button: the All / Clear / Follow-role
          controls are real buttons and a button may not nest inside a button
          (React logs a hydration error and the inner clicks are unreliable).
          The disclosure toggle is its own button beside them. */}
      <div className="w-full px-3 py-2 flex items-center gap-2 text-xs text-[#6B5744] rounded-t-lg">
        <button type="button"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                className="flex items-center gap-2 text-left flex-1 min-w-0 hover:text-[#af4408]">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <ShieldAlert size={14} className="text-[#af4408] shrink-0" />
          <span className="font-semibold whitespace-nowrap">Page Access &amp; Dept Visibility</span>
          <span className={`ml-2 text-[10px] italic flex-1 ${hasOverride && !isAdmin ? 'text-amber-700 not-italic font-medium' : 'text-[#8B7355]'}`}>{summary}</span>
        </button>
        {!isAdmin && open && (
          <span className="text-[10px] flex gap-2 shrink-0">
            <button type="button" onClick={grantAll} className="text-[#af4408] hover:underline"
                    title="Tick every page — saves as a personal override">All</button>
            <button type="button" onClick={clearTicks} className="text-[#af4408] hover:underline"
                    title="Untick everything so you can pick a fresh set. An empty list cannot be saved — it would mean “follow role”, not “no access”.">Clear</button>
            {/* ALWAYS RENDERED. Both branches clear the personal override to
                NULL; only the CONSEQUENCE differs, which is why the label does.
                With a role, NULL means "follow the role". Without one, NULL is
                the legacy full-access map. Gating this on role_id (as it was
                briefly) left a user who has NO role and a personal override
                with no way back to NULL from this screen at all — the only
                control that used to do it was the old Reset button, which this
                replaced. */}
            <button type="button" onClick={followRole} className="text-[#af4408] hover:underline"
                    title={editing.role_id
                      ? 'Remove the personal override so this user follows their role again (and keeps following it as the role is edited)'
                      : 'Remove the personal override. This user has no role, so clearing it restores full access — assign a role if you want them to follow one.'}>
              {editing.role_id ? 'Follow role' : 'Full access'}
            </button>
          </span>
        )}
      </div>

      {open && !isAdmin && (
        <div className="px-3 py-2 space-y-3 border-t border-[#E8D5C4]">
          {/* INHERITANCE STATE — the screen must say plainly whether this user
              follows their role, because the boxes below look identical either
              way once they are seeded from the role's pages. */}
          {roleUnresolved ? (
            <div className="text-[11px] bg-red-50 border border-red-200 text-red-800 rounded p-2">
              This user&apos;s role could not be loaded, so their real pages can&apos;t be shown.
              Reload the page before changing access — saving now could grant or strip the wrong pages.
            </div>
          ) : touchedEmpty ? (
            <div className="text-[11px] bg-amber-50 border border-amber-300 text-amber-900 rounded p-2">
              <span className="font-semibold">Nothing is ticked — Save will refuse this.</span>{' '}
              An empty page list is stored as “no restriction”, so it would{' '}
              {assignedRole ? <>hand this user back to the <b>{assignedRole.name}</b> role</> : <>grant every page</>},
              not block them. Tick the pages they should have
              {assignedRole ? <>, or use <b>Follow role</b> to do that deliberately</> : null}.
              To block someone entirely, untick <b>Active</b> above.
            </div>
          ) : hasOverride ? (
            <div className="text-[11px] bg-amber-50 border border-amber-200 text-amber-900 rounded p-2">
              <span className="font-semibold">Personal override.</span>{' '}
              {assignedRole
                ? <>These ticks beat the <b>{assignedRole.name}</b> role — editing that role will no longer change what this
                    user sees. Use <b>Follow role</b> above to hand them back.</>
                : <>These ticks are this user&apos;s own page list.</>}
            </div>
          ) : assignedRole ? (
            <div className="text-[11px] bg-green-50 border border-green-200 text-green-900 rounded p-2">
              <span className="font-semibold">Following the {assignedRole.name} role.</span>{' '}
              {roleGrantsEveryPage
                ? <>That role restricts nothing, so this user sees every page.</>
                : <>The {rolePageCount} ticked page{rolePageCount === 1 ? '' : 's'} below {rolePageCount === 1 ? 'is' : 'are'}{' '}
                    the role&apos;s — applied automatically, nothing to save here.
                    Change them for everyone in Settings → Roles.</>}
              {' '}Ticking anything here creates a personal override for this user only.
            </div>
          ) : (
            <div className="text-[11px] bg-blue-50 border border-blue-200 text-blue-900 rounded p-2">
              <span className="font-semibold">No role assigned</span> — this user gets <b>every page</b>.
              Assign a role above, or tick only the pages they should have.
            </div>
          )}
          {!rolesReady && (
            <div className="text-[11px] bg-red-50 border border-red-200 text-red-800 rounded p-2">
              Roles could not be loaded — page access cannot be saved. Reload the page.
            </div>
          )}
          {/* DEPARTMENT VISIBILITY */}
          <div className="bg-blue-50/40 border border-blue-200 rounded p-2">
            <div className="text-[11px] font-semibold text-[#2D1B0E] mb-1">
              🏷 Department Visibility
              <span className="ml-2 text-[10px] font-normal text-[#8B7355]">
                {currentDepts.size === 0 ? 'Default: own dept only' : `Sees ${currentDepts.size} dept${currentDepts.size === 1 ? '' : 's'}`}
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1 text-xs">
              {departments.map(d => (
                <label key={d.id} className="flex items-center gap-1.5 cursor-pointer hover:bg-white px-1 rounded">
                  <input type="checkbox" checked={currentDepts.has(d.id)} onChange={() => toggleDept(d.id)} />
                  <span className="text-[#2D1B0E]">{d.code ? `[${d.code}] ` : ''}{d.name}</span>
                  {editing.department_id === d.id && <span className="text-[9px] text-[#af4408] ml-auto">own</span>}
                </label>
              ))}
            </div>
          </div>

          {/* PAGE ACCESS */}
          {PAGE_CATALOG.map(section => {
            const paths = section.pages.map(p => p.path);
            const checkedCount = paths.filter(p => draft.has(p)).length;
            const allChecked = checkedCount === paths.length;
            const someChecked = checkedCount > 0 && !allChecked;
            const isExpanded = sectionOpen.has(section.label);
            return (
              <div key={section.label} className="border border-[#E8D5C4]/60 rounded">
                <div className="px-2 py-1 flex items-center gap-2 bg-white cursor-pointer hover:bg-[#FFF1E3]"
                     onClick={() => toggleSection(section.label)}>
                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <input type="checkbox" checked={allChecked}
                         ref={el => { if (el) el.indeterminate = someChecked; }}
                         onClick={e => e.stopPropagation()}
                         onChange={() => toggleSectionPaths(paths)} />
                  <span className="text-xs font-semibold text-[#2D1B0E] flex-1">{section.label}</span>
                  <span className="text-[10px] text-[#8B7355]">{checkedCount}/{paths.length}</span>
                </div>
                {isExpanded && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-1 px-3 py-1.5 text-xs bg-white">
                    {section.pages.map(p => (
                      <label key={p.path} className="flex items-center gap-1.5 cursor-pointer hover:bg-[#FFF8F0] px-1 rounded">
                        <input type="checkbox" checked={draft.has(p.path)} onChange={() => togglePage(p.path)} />
                        <span className="text-[#2D1B0E]">{p.label}</span>
                        <span className="text-[9px] font-mono text-[#8B7355] ml-auto">{p.path}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <div className="text-[10px] text-[#8B7355] italic">
            Ticking any page here creates a personal override that beats the role. An empty list cannot be
            saved — it means “follow role” (or full access with no role), not “no access”; to block someone
            entirely, untick <b>Active</b> above. Changes apply when you click Save below.
          </div>
        </div>
      )}
    </div>
  );
}

/* ──────────────── Captain Area section embedded in the user-edit modal ────────────────
   Locks a captain to specific floors (zones) and/or specific tables. Writes JSON arrays
   to editing.preferred_zones / editing.preferred_table_ids (mirrors visible_department_ids).
   Only enforced when the 'captain_area_lock' setting is ON — see Settings → Integrations. */

function CaptainAreaSection({ editing, setEditing, tables }: {
  editing: any;
  setEditing: (e: any) => void;
  tables: RestTable[];
}) {
  const [open, setOpen] = useState(false);

  const currentZones = parseArr(editing.preferred_zones);
  const currentTableIds = parseArr(editing.preferred_table_ids);

  // Distinct floors/areas: unique t.zone (falling back to 'Floor' when blank).
  const zones = Array.from(new Set(tables.map(t => (t.zone && t.zone.trim()) || 'Floor')));

  const toggleZone = (z: string) => {
    const next = new Set(currentZones);
    if (next.has(z)) next.delete(z); else next.add(z);
    setEditing({ ...editing, preferred_zones: JSON.stringify(Array.from(next)) });
  };
  const toggleTable = (id: string) => {
    const next = new Set(currentTableIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setEditing({ ...editing, preferred_table_ids: JSON.stringify(Array.from(next)) });
  };
  const clearAll = () => setEditing({ ...editing, preferred_zones: null, preferred_table_ids: null });

  const summary =
    currentZones.size === 0 && currentTableIds.size === 0
      ? 'All areas (no restriction)'
      : [
          currentZones.size ? `${currentZones.size} floor${currentZones.size === 1 ? '' : 's'}` : '',
          currentTableIds.size ? `${currentTableIds.size} table${currentTableIds.size === 1 ? '' : 's'}` : '',
        ].filter(Boolean).join(' · ');

  return (
    <div className="border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]">
      <button type="button"
              onClick={() => setOpen(o => !o)}
              className="w-full px-3 py-2 flex items-center gap-2 text-left text-xs text-[#6B5744] hover:bg-[#FFF1E3] rounded-t-lg">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <MapPin size={14} className="text-[#af4408]" />
        <span className="font-semibold">Captain Area</span>
        <span className="ml-2 text-[10px] text-[#8B7355] italic flex-1">{summary}</span>
        {open && (currentZones.size > 0 || currentTableIds.size > 0) && (
          <span className="text-[10px]" onClick={e => e.stopPropagation()}>
            <button type="button" onClick={clearAll} className="text-[#af4408] hover:underline">Clear</button>
          </span>
        )}
      </button>

      {open && (
        <div className="px-3 py-2 space-y-3 border-t border-[#E8D5C4]">
          <p className="text-[10px] text-[#8B7355] italic">
            Restrict this captain to the floors / tables below. Only enforced when
            “Restrict captains to their assigned area” is ON (Settings → Integrations).
            Leave everything unchecked for no restriction.
          </p>

          {/* PREFERRED FLOORS / AREAS */}
          <div className="bg-blue-50/40 border border-blue-200 rounded p-2">
            <div className="text-[11px] font-semibold text-[#2D1B0E] mb-1">
              Preferred Floors / Areas
              <span className="ml-2 text-[10px] font-normal text-[#8B7355]">
                {currentZones.size === 0 ? 'Any floor' : `${currentZones.size} selected`}
              </span>
            </div>
            {zones.length === 0 ? (
              <div className="text-[10px] text-[#8B7355] italic">No tables configured yet.</div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-1 text-xs">
                {zones.map(z => (
                  <label key={z} className="flex items-center gap-1.5 cursor-pointer hover:bg-white px-1 rounded">
                    <input type="checkbox" checked={currentZones.has(z)} onChange={() => toggleZone(z)} />
                    <span className="text-[#2D1B0E]">{z}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* SPECIFIC TABLES */}
          <div className="bg-amber-50/40 border border-amber-200 rounded p-2">
            <div className="text-[11px] font-semibold text-[#2D1B0E] mb-1">
              Specific Tables
              <span className="ml-2 text-[10px] font-normal text-[#8B7355]">
                {currentTableIds.size === 0 ? 'Any table' : `${currentTableIds.size} selected`}
              </span>
            </div>
            {tables.length === 0 ? (
              <div className="text-[10px] text-[#8B7355] italic">No tables configured yet.</div>
            ) : (
              <div className="grid grid-cols-3 md:grid-cols-4 gap-1 text-xs max-h-40 overflow-y-auto">
                {tables.map(t => {
                  const z = (t.zone && t.zone.trim()) || 'Floor';
                  return (
                    <label key={t.id} className="flex items-center gap-1.5 cursor-pointer hover:bg-white px-1 rounded">
                      <input type="checkbox" checked={currentTableIds.has(t.id)} onChange={() => toggleTable(t.id)} />
                      <span className="text-[#2D1B0E]">{t.table_number}</span>
                      <span className="text-[9px] text-[#8B7355] ml-auto">{z}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function parseArr(raw: any): Set<string> {
  if (!raw) return new Set();
  try { const a = JSON.parse(raw); return Array.isArray(a) ? new Set(a) : new Set(); }
  catch { return new Set(); }
}
