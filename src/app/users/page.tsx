'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users, Plus, Edit, X, Save, Loader2, ShieldCheck, Shield, ChefHat, Warehouse, Building, ChevronDown, ChevronRight, ShieldAlert, MapPin } from 'lucide-react';
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
interface Role { id: string; name: string; base_role: UserRole; is_head_chef: number; is_store_manager: number; description?: string; }

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
      fetch('/api/auth/roles').then(r => r.ok ? r.json() : { roles: [] }).catch(() => ({ roles: [] })),
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
    setRoles(roleRes.roles || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing?.email) { alert('Email required'); return; }
    const isNew = !editing.id;
    if (isNew && !editing.password) { alert('Password required for new users'); return; }

    // Convert stringified arrays → real arrays for the API. Sending null clears
    // the map; an empty array means "explicitly nothing".
    const body: any = { ...editing };
    if (typeof body.page_access === 'string') {
      try { body.page_access = JSON.parse(body.page_access); }
      catch { body.page_access = null; }
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
            department_id: null, is_head_chef: 0, is_store_manager: 0,
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
                        {u.role === 'admin' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">
                            ★ All
                          </span>
                        )}
                        {!u.is_head_chef && !u.is_store_manager && u.role !== 'admin' && (
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
                                page_access: u.page_access ?? null,
                                visible_department_ids: u.visible_department_ids ?? null,
                                preferred_zones: u.preferred_zones ?? null,
                                preferred_table_ids: u.preferred_table_ids ?? null,
                                section: (u as any).section ?? '',
                              } as any)}
                              className="p-1 text-[#6B5744] hover:text-[#af4408]"><Edit className="w-3.5 h-3.5" /></button>
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
                              page_access: null });
                          }}
                          className="w-full mt-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm font-medium">
                    <option value="">— Custom (set tier + pages manually) —</option>
                    {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
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

function PageAccessSection({ editing, setEditing, departments }: {
  editing: any;
  setEditing: (e: any) => void;
  departments: Array<{ id: string; name: string; code?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [sectionOpen, setSectionOpen] = useState<Set<string>>(new Set());

  const isAdmin = editing.role === 'admin';
  const currentPages = parseArr(editing.page_access);
  const currentDepts = parseArr(editing.visible_department_ids);

  const togglePage = (path: string) => {
    const next = new Set(currentPages);
    if (next.has(path)) next.delete(path); else next.add(path);
    setEditing({ ...editing, page_access: JSON.stringify(Array.from(next)) });
  };
  const toggleSectionPaths = (paths: string[]) => {
    const next = new Set(currentPages);
    const allOn = paths.every(p => next.has(p));
    if (allOn) { for (const p of paths) next.delete(p); }
    else { for (const p of paths) next.add(p); }
    setEditing({ ...editing, page_access: JSON.stringify(Array.from(next)) });
  };
  const toggleDept = (id: string) => {
    const next = new Set(currentDepts);
    if (next.has(id)) next.delete(id); else next.add(id);
    setEditing({ ...editing, visible_department_ids: JSON.stringify(Array.from(next)) });
  };
  const grantAll = () => setEditing({ ...editing, page_access: JSON.stringify(ALL_PAGE_PATHS) });
  const grantNone = () => setEditing({ ...editing, page_access: JSON.stringify([]) });
  const grantFullAccess = () => setEditing({ ...editing, page_access: null });
  const toggleSection = (label: string) =>
    setSectionOpen(prev => {
      const n = new Set(prev);
      if (n.has(label)) n.delete(label); else n.add(label);
      return n;
    });

  const summary = isAdmin
    ? 'Admin — always has full access (cannot be restricted)'
    : editing.page_access == null
      ? (editing.role_id
          ? "Inherits this role's pages (add an override here to customize)"
          : 'Full access (no map set — sees every page)')
      : currentPages.size === 0
        ? 'No pages granted — user will be locked out except /login'
        : `${currentPages.size} page${currentPages.size === 1 ? '' : 's'} granted (overrides the role)`;

  return (
    <div className="border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]">
      <button type="button"
              onClick={() => setOpen(o => !o)}
              className="w-full px-3 py-2 flex items-center gap-2 text-left text-xs text-[#6B5744] hover:bg-[#FFF1E3] rounded-t-lg">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <ShieldAlert size={14} className="text-[#af4408]" />
        <span className="font-semibold">Page Access &amp; Department Visibility</span>
        <span className="ml-2 text-[10px] text-[#8B7355] italic flex-1">{summary}</span>
        {!isAdmin && open && (
          <span className="text-[10px] flex gap-2" onClick={e => e.stopPropagation()}>
            <button type="button" onClick={grantAll} className="text-[#af4408] hover:underline">All</button>
            <button type="button" onClick={grantNone} className="text-[#af4408] hover:underline">None</button>
            <button type="button" onClick={grantFullAccess} className="text-[#af4408] hover:underline" title="Clear the map — user gets full access by default">Reset</button>
          </span>
        )}
      </button>

      {open && !isAdmin && (
        <div className="px-3 py-2 space-y-3 border-t border-[#E8D5C4]">
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
            const checkedCount = paths.filter(p => currentPages.has(p)).length;
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
                        <input type="checkbox" checked={currentPages.has(p.path)} onChange={() => togglePage(p.path)} />
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
            Empty page list = locked out. Reset (above) clears the map → user gets full access by default.
            Changes apply when you click Save below.
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
