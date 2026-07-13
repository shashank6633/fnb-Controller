'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { PAGE_CATALOG } from '@/lib/page-catalog';
import { Shield, Plus, Pencil, Trash2, X, Check, Loader2, Users, ChevronDown, ChevronRight } from 'lucide-react';

interface Role {
  id: string;
  name: string;
  base_role: 'admin' | 'manager' | 'staff';
  page_access: string | null; // JSON array or null (= all)
  is_head_chef: number;
  is_store_manager: number;
  /** Granular: approve requisitions (dine-in + party) without the full HOD flag. */
  can_approve_requisitions: number;
  is_system: number;
  sort_order: number;
  description: string;
  user_count: number;
  /** Bill-discount authority: can this role's users request a discount, and up to what %? */
  can_request_discount: number;
  max_discount_pct: number;
}

const TIERS = [
  { v: 'admin', label: 'Admin', hint: 'full access — every page + every action' },
  { v: 'manager', label: 'Manager', hint: 'can manage operations (tables, void, approve)' },
  { v: 'staff', label: 'Staff', hint: 'limited — only the pages you pick below' },
] as const;

const tierLabel = (t: string) => TIERS.find((x) => x.v === t)?.label || t;

function parsePages(pa: string | null): string[] {
  if (!pa) return [];
  try { const a = JSON.parse(pa); return Array.isArray(a) ? a : []; } catch { return []; }
}

const blankDraft = () => ({
  id: '' as string, name: '', base_role: 'staff' as Role['base_role'], description: '',
  is_head_chef: false, is_store_manager: false, can_approve_requisitions: false,
  pages: new Set<string>(), is_system: 0,
  can_request_discount: false, max_discount_pct: 0,
});

export default function RolesAdmin() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [draft, setDraft] = useState<ReturnType<typeof blankDraft> | null>(null);
  const [saving, setSaving] = useState(false);
  // Mobile-only accordion UI state (which page-access sections are expanded).
  // Render-layer only — never touches the draft/save payload.
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const r = await api('/api/auth/roles');
      if (r.status === 403) { setForbidden(true); return; }
      const j = await r.json();
      setRoles(j.roles || []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function openCreate() { setOpenSections(new Set()); setDraft(blankDraft()); }
  function openEdit(role: Role) {
    setOpenSections(new Set());
    setDraft({
      id: role.id, name: role.name, base_role: role.base_role, description: role.description || '',
      is_head_chef: !!role.is_head_chef, is_store_manager: !!role.is_store_manager,
      can_approve_requisitions: !!role.can_approve_requisitions,
      pages: new Set(parsePages(role.page_access)), is_system: role.is_system,
      can_request_discount: !!role.can_request_discount, max_discount_pct: Number(role.max_discount_pct) || 0,
    });
  }

  function togglePage(path: string) {
    setDraft((d) => { if (!d) return d; const n = new Set(d.pages); n.has(path) ? n.delete(path) : n.add(path); return { ...d, pages: n }; });
  }
  function toggleSection(paths: string[]) {
    setDraft((d) => {
      if (!d) return d;
      const all = paths.every((p) => d.pages.has(p));
      const n = new Set(d.pages);
      paths.forEach((p) => all ? n.delete(p) : n.add(p));
      return { ...d, pages: n };
    });
  }
  /** Mobile accordion: expand/collapse a section card (UI-only). */
  function toggleAccordion(label: string) {
    setOpenSections((s) => { const n = new Set(s); n.has(label) ? n.delete(label) : n.add(label); return n; });
  }
  /** Mobile [All]/[None]: callers pass only SELECTABLE paths (HOD-locked excluded). */
  function setSectionPages(paths: string[], on: boolean) {
    setDraft((d) => {
      if (!d) return d;
      const n = new Set(d.pages);
      paths.forEach((p) => on ? n.add(p) : n.delete(p));
      return { ...d, pages: n };
    });
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) { alert('Give the role a name'); return; }
    setSaving(true);
    try {
      const body: any = {
        name: draft.name.trim(), base_role: draft.base_role, description: draft.description,
        is_head_chef: draft.is_head_chef, is_store_manager: draft.is_store_manager,
        can_approve_requisitions: draft.can_approve_requisitions,
        page_access: draft.base_role === 'admin' ? null : Array.from(draft.pages),
        can_request_discount: draft.can_request_discount,
        max_discount_pct: draft.can_request_discount ? Number(draft.max_discount_pct) || 0 : 0,
      };
      const r = draft.id
        ? await api('/api/auth/roles', { method: 'PUT', body: { id: draft.id, ...body } })
        : await api('/api/auth/roles', { method: 'POST', body });
      const j = await r.json();
      if (j.error) { alert(j.error); return; }
      setDraft(null);
      await load();
    } finally { setSaving(false); }
  }

  async function remove(role: Role) {
    if (!confirm(`Delete role "${role.name}"?`)) return;
    const r = await api(`/api/auth/roles?id=${role.id}`, { method: 'DELETE' });
    const j = await r.json();
    if (j.error) { alert(j.error); return; }
    await load();
  }

  if (forbidden) return <div className="p-8 text-[#8B7355]">Admins only.</div>;

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Shield className="w-6 h-6 text-[#af4408]" />
          <h1 className="text-2xl font-bold text-[#2D1B0E]">Roles</h1>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 bg-[#af4408] text-white px-4 py-2 rounded-lg text-sm font-semibold active:scale-95">
          <Plus className="w-4 h-4" /> New role
        </button>
      </div>
      <p className="text-sm text-[#8B7355] mb-5">A role bundles a permission <b>tier</b> (what they can do) with a <b>page set</b> (what they see). Assign roles to people on the <a href="/users" className="text-[#af4408] underline">Users</a> page.</p>

      {loading ? (
        <div className="py-16 text-center text-[#8B7355]"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {roles.map((role) => {
            const pages = parsePages(role.page_access);
            const allPages = role.base_role === 'admin' || role.page_access === null;
            return (
              <div key={role.id} className="bg-white border border-[#E8D5C4] rounded-xl p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-bold text-[#2D1B0E] flex items-center gap-2">
                      {role.name}
                      {!!role.is_system && <span className="text-[10px] bg-[#FFF1E3] text-[#8B7355] px-1.5 py-0.5 rounded-full font-medium">built-in</span>}
                    </p>
                    <p className="text-xs text-[#8B7355] mt-0.5">{role.description}</p>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(role)} className="p-2 text-[#6B5744] hover:bg-[#FFF1E3] rounded-lg"><Pencil className="w-4 h-4" /></button>
                    {!role.is_system && <button onClick={() => remove(role)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg"><Trash2 className="w-4 h-4" /></button>}
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-3 text-xs">
                  <span className={`px-2 py-1 rounded-full font-semibold ${role.base_role === 'admin' ? 'bg-purple-100 text-purple-700' : role.base_role === 'manager' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>{tierLabel(role.base_role)}</span>
                  <span className="text-[#8B7355]">{allPages ? 'all pages' : `${pages.length} pages`}</span>
                  {role.user_count > 0 && <span className="text-[#8B7355] flex items-center gap-1"><Users className="w-3 h-3" /> {role.user_count}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Editor */}
      {draft && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4" onClick={() => setDraft(null)}>
          <div className="absolute inset-0 bg-black/40" />
          <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-2xl bg-white rounded-2xl shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-[#F0E4D6] px-5 py-3 flex items-center justify-between">
              <h2 className="font-bold text-lg text-[#2D1B0E]">{draft.id ? 'Edit role' : 'New role'}</h2>
              <button onClick={() => setDraft(null)} className="p-1"><X className="w-5 h-5 text-[#8B7355]" /></button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-[#8B7355]">Role name</label>
                  <input value={draft.name} disabled={!!draft.is_system} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    className="w-full mt-1 border border-[#D4B896] rounded-lg px-3 py-2 text-sm disabled:bg-[#F7F0E8]" placeholder="e.g. Floor Manager" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-[#8B7355]">Description</label>
                  <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    className="w-full mt-1 border border-[#D4B896] rounded-lg px-3 py-2 text-sm" placeholder="what this role does" />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-[#8B7355]">Permission tier (what they can do)</label>
                <div className="grid sm:grid-cols-3 gap-2 mt-1">
                  {TIERS.map((t) => (
                    <button key={t.v} disabled={!!draft.is_system}
                      onClick={() => setDraft({ ...draft, base_role: t.v })}
                      className={`text-left p-3 rounded-xl border text-sm disabled:opacity-60 ${draft.base_role === t.v ? 'border-[#af4408] bg-[#FFF1E3]' : 'border-[#E8D5C4] bg-white'}`}>
                      <span className="font-semibold text-[#2D1B0E] flex items-center gap-1">{t.label}{draft.base_role === t.v && <Check className="w-3.5 h-3.5 text-[#af4408]" />}</span>
                      <span className="block text-[11px] text-[#8B7355] mt-0.5">{t.hint}</span>
                    </button>
                  ))}
                </div>
                {draft.is_system ? <p className="text-[11px] text-[#8B7355] mt-1">Built-in role — name and tier are fixed, but you can still adjust its pages.</p> : null}
              </div>

              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm text-[#2D1B0E]">
                  <input type="checkbox" checked={draft.is_head_chef} onChange={(e) => setDraft({ ...draft, is_head_chef: e.target.checked })} /> Is HOD (Head of Department)
                </label>
                <label className="flex items-center gap-2 text-sm text-[#2D1B0E]">
                  <input type="checkbox" checked={draft.is_store_manager} onChange={(e) => setDraft({ ...draft, is_store_manager: e.target.checked })} /> Can issue stock as Store Manager
                </label>
                <label className="flex items-center gap-2 text-sm text-[#2D1B0E]">
                  <input type="checkbox" checked={draft.can_approve_requisitions} onChange={(e) => setDraft({ ...draft, can_approve_requisitions: e.target.checked })} /> Can approve requisitions (dine-in + party)
                </label>
              </div>
              <p className="-mt-1 text-[11px] text-[#8B7355]">
                “Can approve requisitions” grants ONLY the approval inbox (dine-in + party) — no HOD-only pages, no party financials. “Is HOD” includes it.
              </p>
              {!draft.is_head_chef && !draft.can_approve_requisitions && (
                <p className="-mt-1 text-[11px] text-amber-700 flex items-start gap-1">
                  <span aria-hidden>⚠</span>
                  <span>This role <b>can’t approve requisitions</b> — tick an approval box above to allow it (admins can always approve).</span>
                </p>
              )}

              {/* Bill-discount authority — lets a cashier/captain request a discount on a
                  running bill (still needs a manager/admin approver at settle time). */}
              <div className="border border-[#E8D5C4] rounded-xl p-3 bg-[#FFF8F0]">
                <label className="flex items-center gap-2 text-sm text-[#2D1B0E] font-medium">
                  <input type="checkbox" checked={draft.can_request_discount}
                         onChange={(e) => setDraft({ ...draft, can_request_discount: e.target.checked })} />
                  Can request bill discount
                </label>
                <p className="text-[11px] text-[#8B7355] mt-0.5 ml-6">
                  Users with this role may request a discount on a bill (a manager/admin still approves it).
                </p>
                {draft.can_request_discount && (
                  <label className="flex items-center gap-2 text-sm text-[#2D1B0E] mt-2 ml-6">
                    Max discount %
                    <input type="number" min={0} max={100} step={1}
                           value={draft.max_discount_pct}
                           onChange={(e) => setDraft({ ...draft, max_discount_pct: Number(e.target.value) })}
                           className="w-24 border border-[#D4B896] rounded-lg px-3 py-1.5 text-sm" />
                  </label>
                )}
              </div>

              {draft.base_role === 'admin' ? (
                <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 text-sm text-purple-700">Admin tier sees <b>every</b> page — no page selection needed.</div>
              ) : (
                <div>
                  <label className="text-xs font-semibold text-[#8B7355]">Pages this role can open</label>

                  {/* Mobile (<lg): accordion — one collapsible card per section. Same
                      draft.pages state as the desktop grid below; render-layer only. */}
                  <div className="mt-1 space-y-2 lg:hidden">
                    {PAGE_CATALOG.map((section) => {
                      const selectable = section.pages
                        .filter((p) => !(p.hodOnly && !draft.is_head_chef))
                        .map((p) => p.path);
                      const selCount = section.pages.filter((p) => draft.pages.has(p.path)).length;
                      const open = openSections.has(section.label);
                      return (
                        <div key={section.label} className="border border-[#E8D5C4] rounded-xl bg-white overflow-hidden">
                          <button type="button" onClick={() => toggleAccordion(section.label)} aria-expanded={open}
                            className="w-full min-h-[44px] px-3 py-2.5 flex items-center justify-between gap-2 text-sm font-semibold text-[#2D1B0E]">
                            <span>{section.label}</span>
                            <span className="flex items-center gap-1.5 text-xs font-medium text-[#8B7355]">
                              {selCount}/{section.pages.length}
                              {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                            </span>
                          </button>
                          {open && (
                            <div className="border-t border-[#F0E4D6]">
                              <div className="flex gap-2 px-3 py-2 border-b border-[#F0E4D6] bg-[#FFF8F0]">
                                <button type="button" onClick={() => setSectionPages(selectable, true)}
                                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-[#D4B896] text-[#6B5744] active:scale-95">All</button>
                                <button type="button" onClick={() => setSectionPages(selectable, false)}
                                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-[#D4B896] text-[#6B5744] active:scale-95">None</button>
                              </div>
                              <div className="divide-y divide-[#F0E4D6]">
                                {section.pages.map((p) => {
                                  const lockedHod = !!p.hodOnly && !draft.is_head_chef;
                                  return (
                                    <label key={p.path}
                                           title={p.hodOnly ? 'Only HODs (tick “Is HOD” above) and admins can open this page' : undefined}
                                           className={`flex items-center gap-3 w-full min-h-[44px] px-3 py-2 text-sm ${lockedHod ? 'text-[#B79A82]' : 'text-[#6B5744] active:bg-[#FFF8F0]'}`}>
                                      <input type="checkbox" checked={draft.pages.has(p.path)} disabled={lockedHod} onChange={() => togglePage(p.path)} />
                                      <span className="flex-1">{p.label}</span>
                                      {p.hodOnly && <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium shrink-0">HOD only</span>}
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Desktop (≥lg): original section grid — unchanged. */}
                  <div className="mt-1 border border-[#E8D5C4] rounded-xl divide-y divide-[#F0E4D6] hidden lg:block">
                    {PAGE_CATALOG.map((section) => {
                      const paths = section.pages.map((p) => p.path);
                      const allOn = paths.every((p) => draft.pages.has(p));
                      const someOn = paths.some((p) => draft.pages.has(p));
                      return (
                        <div key={section.label} className="p-3">
                          <button onClick={() => toggleSection(paths)} className="flex items-center gap-2 text-sm font-semibold text-[#2D1B0E] mb-2">
                            <span className={`w-4 h-4 rounded border flex items-center justify-center ${allOn ? 'bg-[#af4408] border-[#af4408]' : someOn ? 'bg-[#af4408]/30 border-[#af4408]' : 'border-[#D4B896]'}`}>
                              {allOn && <Check className="w-3 h-3 text-white" />}
                            </span>
                            {section.label}
                          </button>
                          <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1 pl-6">
                            {section.pages.map((p) => {
                              // HOD-only pages can't be granted to a non-HOD role —
                              // the proxy would block them anyway. Lock the checkbox
                              // and show why until "Is HOD" is ticked for this role.
                              const lockedHod = !!p.hodOnly && !draft.is_head_chef;
                              return (
                              <label key={p.path}
                                     title={p.hodOnly ? 'Only HODs (tick “Is HOD” above) and admins can open this page' : undefined}
                                     className={`flex items-center gap-2 text-sm ${lockedHod ? 'text-[#B79A82]' : 'text-[#6B5744]'}`}>
                                <input type="checkbox" checked={draft.pages.has(p.path)} disabled={lockedHod} onChange={() => togglePage(p.path)} />
                                {p.label}
                                {p.hodOnly && <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">HOD only</span>}
                              </label>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            {/* Desktop (≥lg) footer — original, unchanged. */}
            <div className="sticky bottom-0 bg-white border-t border-[#F0E4D6] px-5 py-3 hidden lg:flex justify-end gap-2">
              <button onClick={() => setDraft(null)} className="px-4 py-2 text-sm text-[#6B5744]">Cancel</button>
              <button onClick={save} disabled={saving} className="flex items-center gap-2 bg-[#af4408] text-white px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save role
              </button>
            </div>
            {/* Mobile (<lg) sticky action bar — same handlers as the desktop buttons. */}
            <div className="sticky bottom-0 bg-white border-t border-[#F0E4D6] px-4 py-3 grid grid-cols-2 gap-2 lg:hidden">
              <button onClick={() => setDraft(null)} className="min-h-[44px] px-4 py-2 text-sm font-semibold text-[#6B5744] border border-[#D4B896] rounded-lg active:scale-95">Cancel</button>
              <button onClick={save} disabled={saving} className="min-h-[44px] flex items-center justify-center gap-2 bg-[#af4408] text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 active:scale-95">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save role
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
