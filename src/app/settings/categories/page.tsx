'use client';

/**
 * Category Manager — assign every leaf category to a parent super_category.
 *
 * raw_materials carries two columns:
 *   super_category    — the BIG bucket (Bar, Meat, Dairy, ...) used for grouping
 *   category          — the leaf (Beers, Whisky, Mutton, Butter, ...)
 *
 * Admins use this page to:
 *   1. See every leaf in use, grouped under its parent (or "(Ungrouped)")
 *   2. Move a leaf to a different parent (e.g. drag "Beers" from Ungrouped to Bar)
 *   3. Rename a leaf (renames it on every material — bulk-merge if target exists)
 *   4. Seed a brand-new leaf under a parent so it appears in dropdowns before
 *      any material uses it (placeholder)
 *
 * The dropdowns on /inventory and /unit-audit pick up these mappings via
 * super_category and render with <optgroup> grouping.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Layers, Loader2, Plus, Save, Search, AlertCircle, AlertTriangle, CheckCircle2, Edit2,
} from 'lucide-react';
import { api } from '@/lib/api';

interface Leaf { category: string; super_category: string; count: number; }
interface Group { super_category: string; super_category_raw: string; leaves: Leaf[]; }

export default function CategoryManagerPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [allSupers, setAllSupers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [pendingAssign, setPendingAssign] = useState<Record<string, string>>({});
  const [pendingRename, setPendingRename] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [meRole, setMeRole] = useState<string | null>(null);

  // New-leaf form
  const [newLeaf, setNewLeaf] = useState('');
  const [newParent, setNewParent] = useState('');

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMeRole(d?.user?.role || null)).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/categories')
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        if (j.error) { setError(j.error); return; }
        setGroups(j.groups || []);
        setAllSupers(j.all_super_categories || []);
        if (!newParent && (j.all_super_categories || []).length > 0) setNewParent(j.all_super_categories[0]);
      })
      .catch(e => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const filtered = useMemo(() => {
    if (!search.trim()) return groups;
    const q = search.toLowerCase();
    return groups
      .map(g => ({
        ...g,
        leaves: g.leaves.filter(l => l.category.toLowerCase().includes(q) || g.super_category.toLowerCase().includes(q)),
      }))
      .filter(g => g.leaves.length > 0);
  }, [groups, search]);

  const totalLeaves = useMemo(() => groups.reduce((s, g) => s + g.leaves.length, 0), [groups]);
  const ungrouped = useMemo(() => groups.find(g => g.super_category_raw === '')?.leaves.length || 0, [groups]);

  const queueAssign = (leaf: string, newSuper: string) =>
    setPendingAssign(prev => ({ ...prev, [leaf]: newSuper }));
  const queueRename = (leaf: string, newName: string) =>
    setPendingRename(prev => ({ ...prev, [leaf]: newName }));

  const pendingCount = Object.keys(pendingAssign).length + Object.keys(pendingRename).length;
  // Staged renames that actually change the leaf name (matches saveAll's filter).
  // Renames are the risky op — they don't migrate the dept category whitelists.
  const renameCount = useMemo(
    () => Object.entries(pendingRename).filter(([from, to]) => from !== to && to.trim()).length,
    [pendingRename]
  );

  const saveAll = async () => {
    setSaving(true); setError(null); setFlash(null);
    try {
      const body: any = {};
      if (Object.keys(pendingAssign).length > 0) {
        body.assign = Object.entries(pendingAssign).map(([category, super_category]) => ({ category, super_category }));
      }
      if (Object.keys(pendingRename).length > 0) {
        body.rename = Object.entries(pendingRename)
          .filter(([from, to]) => from !== to && to.trim())
          .map(([from, to]) => ({ from, to: to.trim() }));
      }
      const r = await api('/api/categories', { method: 'POST', body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setPendingAssign({}); setPendingRename({});
      setFlash(`✓ Saved · ${j.assigned || 0} re-grouped · ${j.renamed || 0} renamed`);
      setRefreshKey(k => k + 1);
    } finally { setSaving(false); }
  };

  const createLeaf = async () => {
    const cat = newLeaf.trim();
    if (!cat) return;
    setSaving(true); setError(null); setFlash(null);
    try {
      const r = await api('/api/categories', {
        method: 'POST',
        body: { create: [{ category: cat, super_category: newParent }] },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setNewLeaf('');
      setFlash(`✓ Added "${cat}" under "${newParent}"`);
      setRefreshKey(k => k + 1);
    } finally { setSaving(false); }
  };

  if (meRole !== null && meRole !== 'admin') {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Admin only. Ask an admin to manage category hierarchy.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <Layers className="w-6 h-6 text-[#af4408]" /> Category Manager
        </h1>
        <p className="text-xs text-[#6B5744] mt-0.5">
          Assign every leaf category (Beers, Whisky, Mutton…) to a parent super-category
          (Bar, Meat…). This grouping drives the optgroup display on Raw Materials, Unit Audit,
          and requisition material pickers.
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Total leaf categories" value={totalLeaves.toString()} tone="bg-[#FFF1E3] border-[#D4B896] text-[#6B5744]" />
        <Stat label="Ungrouped (need parent)" value={ungrouped.toString()} tone={ungrouped > 0 ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-emerald-50 border-emerald-200 text-emerald-900'} />
        <Stat label="Super-categories available" value={allSupers.length.toString()} tone="bg-blue-50 border-blue-200 text-blue-900" />
      </div>

      {/* Quick add */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[200px]">
          <label className="text-[10px] uppercase tracking-wide text-[#8B7355]">Add a new sub-category</label>
          <input value={newLeaf} onChange={e => setNewLeaf(e.target.value)}
                 placeholder="e.g. Single Malt, Mocktails, Ice Cream"
                 className="w-full mt-0.5 px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-[#8B7355]">Under parent</label>
          <select value={newParent} onChange={e => setNewParent(e.target.value)}
                  className="mt-0.5 px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] min-w-[140px]">
            {allSupers.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <button onClick={createLeaf} disabled={!newLeaf.trim() || saving}
                className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-sm flex items-center gap-1 disabled:opacity-50">
          <Plus className="w-4 h-4" /> Add
        </button>
      </div>

      {/* Search + save bar */}
      <div className="flex flex-wrap items-center gap-2 bg-white border border-[#E8D5C4] rounded-xl p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-2 top-2 text-[#8B7355]" />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Search categories…"
                 className="w-full pl-8 pr-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </div>
        <button onClick={saveAll} disabled={pendingCount === 0 || saving}
                className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-sm flex items-center gap-1.5 disabled:opacity-50">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save {pendingCount > 0 ? `(${pendingCount})` : ''}
        </button>
      </div>

      {/* Rename is the one risky op: it rewrites the leaf name on every material
          but does NOT update the per-department category access lists (stored on
          /departments as the OLD leaf names). Warn the moment a rename is staged. */}
      {renameCount > 0 && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <span className="font-semibold">
              {renameCount} rename{renameCount > 1 ? 's' : ''} staged — this affects department access.
            </span>{' '}
            Renaming (or merging) a category updates it on every material, but it does <strong>not</strong> update
            the category access lists on the <strong>Departments</strong> page — those still hold the old name.
            After saving, a renamed category can disappear from a department's Inventory list and Requisition item
            picker until you re-add the new name to that department. Re-check each affected department's category
            access after saving. (Closing-stock counts are unaffected — they see every category.)
          </div>
        </div>
      )}

      {flash && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg p-3 text-sm flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> {flash}
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {/* Groups */}
      {loading ? (
        <div className="p-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(g => (
            <div key={g.super_category} className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
              <div className="px-4 py-2 bg-[#FFF1E3] border-b border-[#E8D5C4] flex items-center justify-between">
                <div className="font-semibold text-[#2D1B0E]">
                  {g.super_category}
                  <span className="ml-2 text-[10px] text-[#8B7355] font-normal">
                    {g.leaves.length} sub-categor{g.leaves.length === 1 ? 'y' : 'ies'}
                  </span>
                </div>
              </div>
              {g.leaves.length === 0 ? (
                <div className="px-4 py-3 text-xs text-[#8B7355] italic">No sub-categories yet. Use the form above to add one under "{g.super_category}".</div>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-xs">
                  <thead className="text-[#6B5744]">
                    <tr>
                      <th className="text-left  py-1.5 px-3 font-medium">Sub-category</th>
                      <th className="text-right py-1.5 px-3 font-medium">Materials using it</th>
                      <th className="text-left  py-1.5 px-3 font-medium">Move to parent</th>
                      <th className="text-left  py-1.5 px-3 font-medium">Rename (merges if name exists)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.leaves.map(l => {
                      const queuedParent = pendingAssign[l.category];
                      const queuedName   = pendingRename[l.category];
                      const isDirty = !!queuedParent || (queuedName !== undefined && queuedName !== l.category);
                      return (
                        <tr key={l.category} className={`border-t border-[#E8D5C4]/50 ${isDirty ? 'bg-amber-50/40' : ''}`}>
                          <td className="py-1.5 px-3 font-medium text-[#2D1B0E]">{l.category}</td>
                          <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]">
                            {l.count > 0
                              ? <span>{l.count}</span>
                              : <span className="text-[#C0A98F]">— placeholder</span>}
                          </td>
                          <td className="py-1.5 px-3">
                            <select value={queuedParent ?? g.super_category_raw}
                                    onChange={e => queueAssign(l.category, e.target.value)}
                                    className="px-1 py-0.5 border border-[#E8D5C4] rounded text-xs bg-[#FFF8F0]">
                              <option value="">(Ungrouped)</option>
                              {allSupers.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                          </td>
                          <td className="py-1.5 px-3">
                            <input type="text"
                                   value={queuedName ?? l.category}
                                   onChange={e => queueRename(l.category, e.target.value)}
                                   className={`w-48 px-1 py-0.5 border rounded text-xs bg-[#FFF8F0] ${queuedName !== undefined && queuedName !== l.category ? 'border-[#af4408]' : 'border-[#E8D5C4]'}`} />
                            {queuedName !== undefined && queuedName !== l.category && (
                              <Edit2 className="inline w-3 h-3 ml-1 text-[#af4408]" />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-[10px] text-[#8B7355]">
        Tip: leaves with <code className="px-1 bg-[#FFF1E3] rounded">— placeholder</code> count are
        sub-categories you created here but no material uses yet — they still appear in dropdowns
        so the kitchen team can pick them when adding a new material.
      </p>
      <p className="text-[10px] text-amber-700 flex items-start gap-1">
        <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
        <span>
          Renaming a category does not update department category-access lists (they store the old
          name). After a rename or merge, re-check <strong>Departments → category access</strong> or the
          renamed category may vanish from that department's Inventory &amp; Requisition pickers.
        </span>
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className={`border rounded-xl p-3 ${tone}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-xl font-bold font-mono mt-0.5">{value}</div>
    </div>
  );
}
