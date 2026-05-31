'use client';

/**
 * Departments admin page.
 * Admin-only — define Bar / Hot Kitchen / Cold Kitchen / Pastry / etc.,
 * assign a head chef per department, and see member + open-requisition counts.
 */

import { useEffect, useState } from 'react';
import { Building, Plus, Edit, Save, X, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

interface User { id: string; name: string; email: string; role: string; is_active?: number; is_head_chef?: number; }
interface CategoryCount { category: string; count: number }
interface Department {
  id: string; name: string; code: string; description: string;
  head_chef_user_id: string | null;
  head_chef_name?: string; head_chef_email?: string;
  is_active: number;
  member_count?: number; open_requisition_count?: number;
  submission_windows?: string;        // CSV of HH:MM e.g. "11:00,18:30"
  submission_grace_minutes?: number;  // default 30
  material_categories?: string | null; // JSON array of allowed raw_materials.category values
}

const empty = (): Partial<Department> => ({ name: '', code: '', description: '', head_chef_user_id: null, is_active: 1 });

export default function DepartmentsPage() {
  const [me, setMe] = useState<{ role: string } | null>(null);
  const [depts, setDepts] = useState<Department[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [editing, setEditing] = useState<Partial<Department> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [catalogCategories, setCatalogCategories] = useState<CategoryCount[]>([]);
  // Parsed allowed-categories for the currently-edited dept (Set for fast toggling).
  const editingCats: Set<string> = (() => {
    if (!editing?.material_categories) return new Set();
    try {
      const arr = JSON.parse(editing.material_categories);
      return Array.isArray(arr) ? new Set(arr) : new Set();
    } catch { return new Set(); }
  })();
  const toggleCat = (c: string) => {
    const next = new Set(editingCats);
    if (next.has(c)) next.delete(c); else next.add(c);
    setEditing(p => p ? { ...p, material_categories: JSON.stringify(Array.from(next)) } : p);
  };
  const clearCats = () =>
    setEditing(p => p ? { ...p, material_categories: null } : p);

  const reload = async () => {
    setLoading(true);
    const [d, u, m] = await Promise.all([
      fetch('/api/departments').then(r => r.json()),
      fetch('/api/auth/users').then(r => r.json()).catch(() => ({ users: [] })),
      fetch('/api/auth/me').then(r => r.json()).catch(() => ({ user: null })),
    ]);
    setDepts(d.departments || []);
    setUsers((u.users || []).filter((x: User) => x.is_active !== 0));
    setMe(m.user);
    setLoading(false);
  };
  useEffect(() => { reload(); }, []);
  useEffect(() => {
    fetch('/api/inventory/categories').then(r => r.json())
      .then(d => setCatalogCategories(d.categories || []))
      .catch(() => {});
  }, []);

  // Note: any signed-in user can VIEW the list (helps store managers see the org chart);
  // only admins get the New / Edit / Save actions, which are gated server-side too.
  const isAdmin = me?.role === 'admin';

  const save = async () => {
    if (!editing?.name) { alert('Name required'); return; }
    setSaving(true);
    try {
      // material_categories lives as a JSON string in state for easy round-trip
      // from the server; the API expects an actual array, so convert here.
      let matCats: string[] | null | undefined = undefined;
      if (editing.material_categories !== undefined) {
        if (editing.material_categories === null || editing.material_categories === '') {
          matCats = null;
        } else {
          try { const arr = JSON.parse(editing.material_categories); matCats = Array.isArray(arr) ? arr : null; }
          catch { matCats = null; }
        }
      }
      const body = { ...editing, material_categories: matCats };
      const r = await api('/api/departments', {
        method: editing.id ? 'PUT' : 'POST',
        body,
      });
      if (!r.ok) { alert((await r.json()).error || 'Failed'); return; }
      setEditing(null);
      reload();
    } finally { setSaving(false); }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Building className="w-7 h-7 text-[#af4408]" />
          <div>
            <h1 className="text-2xl font-bold text-[#2D1B0E]">Departments</h1>
            <p className="text-xs text-[#6B5744]">Define operating departments and assign their head chef approvers.</p>
          </div>
        </div>
        {isAdmin && (
          <div className="flex gap-2">
            <button onClick={async () => {
              const r = await fetch('/api/departments/seed-kitchen-subs', {
                method: 'POST',
                headers: { 'x-csrf-token': (document.cookie.split('; ').find(c => c.startsWith('fnb_csrf='))?.split('=')[1] || '') },
              });
              const j = await r.json();
              alert(j.summary || j.error || 'Done');
              reload();
            }}
                    className="px-3 py-2 border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] rounded-lg text-sm">
              + Seed Kitchen Sub-Depts
            </button>
            <button onClick={() => setEditing(empty())}
                    className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-2">
              <Plus className="w-4 h-4" /> New Department
            </button>
          </div>
        )}
      </div>
      {!loading && !isAdmin && (
        <div className="mb-3 px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-xs text-[#6B5744]">
          You're viewing the department list in read-only mode. Sign in as an admin to add or edit departments.
        </div>
      )}

      <div className="bg-white border border-[#E8D5C4] rounded-xl">
        {loading ? (
          <div className="p-8 text-center text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
        ) : depts.length === 0 ? (
          <div className="p-8 text-center text-[#8B7355]">No departments yet. Click "New Department" to add Bar, Hot Kitchen, Cold Kitchen, Pastry, etc.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-[#8B7355] bg-[#FFF8F0]">
              <tr>
                <th className="text-left  py-2 px-3 font-medium">Name</th>
                <th className="text-left  py-2 px-3 font-medium">Code</th>
                <th className="text-left  py-2 px-3 font-medium">Head Chef</th>
                <th className="text-right py-2 px-3 font-medium">Members</th>
                <th className="text-right py-2 px-3 font-medium">Open Reqs</th>
                <th className="text-left  py-2 px-3 font-medium">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {depts.map(d => (
                <tr key={d.id} className={`border-t border-[#E8D5C4]/50 ${d.is_active ? '' : 'opacity-60'}`}>
                  <td className="py-2 px-3 font-medium text-[#2D1B0E]">{d.name}
                    {d.description && <div className="text-[10px] text-[#8B7355]">{d.description}</div>}
                  </td>
                  <td className="py-2 px-3 font-mono text-xs text-[#6B5744]">
                    {d.code || '—'}
                    {d.submission_windows && (
                      <div className="text-[10px] text-blue-700 mt-0.5" title="Submission allowed only in these slots">
                        ⏰ {d.submission_windows}{d.submission_grace_minutes ? ` ±${d.submission_grace_minutes}m` : ''}
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-3">
                    {d.head_chef_name ? (
                      <>
                        <div className="text-[#2D1B0E]">{d.head_chef_name}</div>
                        <div className="text-[10px] text-[#8B7355]">{d.head_chef_email}</div>
                      </>
                    ) : <span className="text-[#8B7355] italic text-xs">unassigned</span>}
                  </td>
                  <td className="py-2 px-3 text-right font-mono">{d.member_count || 0}</td>
                  <td className="py-2 px-3 text-right font-mono">
                    {d.open_requisition_count ? (
                      <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">{d.open_requisition_count}</span>
                    ) : '0'}
                  </td>
                  <td className="py-2 px-3">
                    {d.is_active
                      ? <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">Active</span>
                      : <span className="text-[10px] px-2 py-0.5 rounded bg-[#E8D5C4] text-[#6B5744]">Archived</span>}
                  </td>
                  <td className="py-2 px-3 text-right">
                    {isAdmin && (
                      <button onClick={() => setEditing({ ...d })} className="text-[#6B5744] hover:text-[#af4408]">
                        <Edit className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md my-12 shadow-xl">
            <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
              <h2 className="font-bold text-[#2D1B0E]">{editing.id ? 'Edit Department' : 'New Department'}</h2>
              <button onClick={() => setEditing(null)} className="text-[#8B7355]"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 space-y-3">
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Name (required)
                <input value={editing.name || ''} onChange={e => setEditing(p => ({ ...p, name: e.target.value }))}
                       placeholder="e.g. Hot Kitchen"
                       className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
              </label>
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Code
                <input value={editing.code || ''} onChange={e => setEditing(p => ({ ...p, code: e.target.value }))}
                       placeholder="HK / CK / BAR"
                       className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
              </label>
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Description
                <textarea value={editing.description || ''} onChange={e => setEditing(p => ({ ...p, description: e.target.value }))}
                          rows={2}
                          className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
              </label>
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Head Chef
                <select value={editing.head_chef_user_id || ''}
                        onChange={e => setEditing(p => ({ ...p, head_chef_user_id: e.target.value || null }))}
                        className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm">
                  <option value="">(none)</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
                </select>
                <span className="text-[10px] text-[#8B7355]">Mark approvers via Users page (`is_head_chef` flag).</span>
              </label>
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Submission Windows
                <input value={editing.submission_windows || ''}
                       onChange={e => setEditing(p => ({ ...p, submission_windows: e.target.value }))}
                       placeholder="e.g. 11:00,18:30 (Kitchen) · 16:00 (Bar) · blank = anytime"
                       className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm font-mono" />
                <span className="text-[10px] text-[#8B7355]">
                  Comma-separated HH:MM. Department staff can only submit requisitions within these slots (±grace minutes). Admins can override.
                </span>
              </label>
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Grace minutes (± window)
                <input type="number" min={0} max={120}
                       value={editing.submission_grace_minutes ?? 30}
                       onChange={e => setEditing(p => ({ ...p, submission_grace_minutes: Number(e.target.value) || 0 }))}
                       className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm font-mono" />
              </label>
              <div className="text-xs text-[#6B5744] flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span>Material Categories <span className="text-[#8B7355] font-normal">— what staff in this dept can see in inventory pickers</span></span>
                  <button type="button" onClick={clearCats} className="text-[10px] text-[#af4408] hover:underline">
                    Clear (= see all)
                  </button>
                </div>
                {catalogCategories.length === 0 ? (
                  <div className="text-[10px] text-[#8B7355] italic px-2 py-1 bg-[#FFF8F0] border border-[#E8D5C4] rounded">
                    No categories found in inventory yet.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-1 px-2 py-1.5 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg max-h-48 overflow-y-auto">
                    {catalogCategories.map(c => (
                      <label key={c.category} className="flex items-center gap-1.5 text-xs hover:bg-white px-1 py-0.5 rounded cursor-pointer">
                        <input type="checkbox" checked={editingCats.has(c.category)} onChange={() => toggleCat(c.category)} />
                        <span className="text-[#2D1B0E] truncate">{c.category}</span>
                        <span className="text-[9px] text-[#8B7355] ml-auto">{c.count}</span>
                      </label>
                    ))}
                  </div>
                )}
                <span className="text-[10px] text-[#8B7355]">
                  {editingCats.size === 0
                    ? 'No filter set — dept sees all materials.'
                    : `${editingCats.size} categor${editingCats.size === 1 ? 'y' : 'ies'} selected. Staff in this dept will only see these in inventory pickers. Admins / head chef / store manager always see all.`}
                </span>
              </div>
              {editing.id && (
                <label className="text-xs text-[#6B5744] flex items-center gap-2">
                  <input type="checkbox" checked={!!editing.is_active}
                         onChange={e => setEditing(p => ({ ...p, is_active: e.target.checked ? 1 : 0 }))} />
                  Active
                </label>
              )}
            </div>
            <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
              <button onClick={save} disabled={saving}
                      className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
