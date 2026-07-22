'use client';

/**
 * Unit-of-Measure audit — flag-driven cleanup view for raw_materials units.
 * Use this BEFORE wiring recipes so material units are correct.
 *
 * Each material is tagged with one or more flags (volume_in_name_not_pcs,
 * pack_in_name_not_pcs, auto_discovered, recipe_unit_mismatch, etc.) and a
 * severity level (high / medium / low / ok). The page lets you:
 *   - Filter by severity or flag
 *   - Edit unit + category inline (per row, fast keyboard flow)
 *   - Bulk-apply a unit to selected rows for sweep-cleaning
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Loader2, Search, Save, RefreshCw, Filter,
  Download, Upload,
} from 'lucide-react';
import { api } from '@/lib/api';
import TabScroller from '@/components/TabScroller';

const fmt = (v: number) => '₹' + (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

interface AuditMaterial {
  id: string; sku?: string; name: string; category: string;
  unit: string;                // legacy alias = recipe_unit
  recipe_unit: string;         // explicit
  purchase_unit: string;
  pack_size: number;           // recipe-units per purchase-unit (e.g. 750 ml in 1 BTL)
  case_size?: number;          // purchase-units per outer pack (e.g. 12 BTL per CASE; default 1)
  current_stock: number; average_price: number;
  last_purchase_price: number; last_purchase_date: string;
  purchase_count: number; recipe_use_count: number;
  is_auto_discovered?: number;
  flags: string[]; severity: 'high' | 'medium' | 'low' | 'ok';
  /** Set by the API: this item has a unit-audit lock and its live units differ from it. */
  locked?: boolean;
  drifted?: boolean;
  lock?: { unit: string | null; purchase_unit: string | null; pack_size: number | null; case_size: number | null } | null;
}

/** Best-effort pack-size suggestion from material name.
 *  "100 PIPERS (750ML)" → 750     "ABSOLUT 1 LTR" → 1000     "BUTTER 500 GM" → 500  */
function suggestPackSizeFromName(name: string, recipeUnit: string): number | null {
  if (!name) return null;
  const s = name.toUpperCase();
  if ((recipeUnit === 'ml' || recipeUnit === 'L')) {
    const ml = s.match(/(\d+(?:\.\d+)?)\s*ML\b/);
    if (ml) return recipeUnit === 'L' ? Number(ml[1]) / 1000 : Number(ml[1]);
    const l  = s.match(/(\d+(?:\.\d+)?)\s*L(?:TR)?\b/);
    if (l)  return recipeUnit === 'ml' ? Number(l[1]) * 1000 : Number(l[1]);
  }
  if ((recipeUnit === 'g' || recipeUnit === 'kg')) {
    const g  = s.match(/(\d+(?:\.\d+)?)\s*G(?:M|MS|RMS)?\b/);
    if (g)  return recipeUnit === 'kg' ? Number(g[1]) / 1000 : Number(g[1]);
    const k  = s.match(/(\d+(?:\.\d+)?)\s*KG\b/);
    if (k)  return recipeUnit === 'g' ? Number(k[1]) * 1000 : Number(k[1]);
  }
  return null;
}

const FLAG_META: Record<string, { label: string; tone: string; help: string }> = {
  unit_reverted:          { label: '⚠ Reverted from saved units', tone: 'bg-red-600 text-white border-red-700',
                            help: 'This item\'s live units differ from the units you saved in Unit Audit — it was reverted (usually by an old import/edit before lock protection). Click "Restore saved units" to put your saved units back.' },
  volume_in_name_not_pcs: { label: 'Volume in name, unit ≠ pcs', tone: 'bg-red-100 text-red-700 border-red-200',
                            help: 'Name contains ML or LTR but the unit is kg/g — usually means a bottled item should be tracked in pieces.' },
  pack_in_name_not_pcs:   { label: 'Pack in name, unit ≠ pcs',   tone: 'bg-red-100 text-red-700 border-red-200',
                            help: 'Name has BTL/PKT/TIN/CAN or "(500 GM)" but unit is loose weight — usually should be pcs.' },
  recipe_unit_mismatch:   { label: 'Recipe unit mismatch',       tone: 'bg-red-100 text-red-700 border-red-200',
                            help: 'A recipe references this material in a different unit than the material itself.' },
  zero_price_with_stock:  { label: 'Stock with no price',         tone: 'bg-red-100 text-red-700 border-red-200',
                            help: 'Has stock but average_price = 0 — recipe cost calculations will all be 0.' },
  missing_pack_size:      { label: 'Missing pack size',          tone: 'bg-red-100 text-red-700 border-red-200',
                            help: 'Purchase Unit ≠ Recipe Unit but Pack Size = 1. The system can\'t convert between buy-unit and recipe-unit; recipe cost will be wrong.' },
  purchase_unit_same_as_recipe: { label: 'Buy ≠ consume — fix Purchase Unit',
                            tone: 'bg-red-100 text-red-700 border-red-200',
                            help: 'Pack Size > 1 means one purchase-unit holds many recipe-units (e.g. 1 BTL = 750 ml), but Purchase Unit and Recipe Unit are the same. Set Purchase Unit to BTL / PKT / TIN / CASE so the books reflect how you actually buy it.' },
  auto_discovered:        { label: 'Auto-discovered',             tone: 'bg-amber-100 text-amber-800 border-amber-200',
                            help: 'Created automatically from a Recaho import. Review price/unit/category before relying on it.' },
  no_purchase_history:    { label: 'No purchase history',         tone: 'bg-amber-100 text-amber-800 border-amber-200',
                            help: 'Never appeared in `purchases` — could be wrong, dormant, or just newly added.' },
  suspicious_unit:        { label: 'Unusual unit',                 tone: 'bg-[#E8D5C4] text-[#6B5744] border-[#D4B896]',
                            help: 'Unit string is non-standard (we expect kg/g/L/ml/pcs).' },
};

/** Recipe / stock units — canonical, granular. Used by recipe-deduction. */
const RECIPE_UNIT_OPTIONS  = ['kg', 'g', 'L', 'ml', 'pcs'];
/** All purchase-unit options that ever appear in the dropdown. */
const PURCHASE_UNIT_OPTIONS = ['kg', 'g', 'L', 'ml', 'pcs', 'BTL', 'CASE', 'PKT', 'TIN', 'CAN', 'JAR', 'BOX', 'BAG', 'BUNCH'];

/** Category-keyword → ranked suggestions. Match is by substring (case-insensitive),
 *  so "blended-scotch", "scotch-malt", "white-wine" all map to liquor units. */
const CATEGORY_HINTS: Array<{ keys: string[]; suggested: string[] }> = [
  // Liquor / wine / beer — vendors invoice in bottles or cases
  { keys: ['beer'],                                  suggested: ['BTL', 'CASE', 'CAN', 'pcs'] },
  { keys: ['scotch', 'whisky', 'whiskey', 'malt',
           'vodka', 'gin', 'rum', 'tequila',
           'wine', 'liqueur', 'liquor', 'bitter',
           'vermouth', 'brandy', 'champagne'],       suggested: ['BTL', 'CASE', 'pcs'] },

  // Soft drinks / mixers
  { keys: ['juice', 'soda', 'mixer', 'water',
           'soft', 'aerated', 'beverage'],           suggested: ['BTL', 'CAN', 'TIN', 'PKT', 'CASE'] },
  { keys: ['syrup', 'crush'],                        suggested: ['BTL', 'CAN', 'L'] },

  // Dairy
  { keys: ['cheese'],                                suggested: ['PKT', 'KG', 'BOX'] },
  { keys: ['butter'],                                suggested: ['PKT', 'KG'] },
  { keys: ['dairy', 'milk', 'yogurt', 'curd',
           'cream'],                                 suggested: ['PKT', 'BTL', 'L', 'KG'] },

  // Produce
  { keys: ['vegetable', 'veg', 'tomato', 'onion'],   suggested: ['KG', 'BAG', 'BUNCH', 'pcs'] },
  { keys: ['fruit', 'berry'],                        suggested: ['KG', 'BAG', 'BOX', 'pcs'] },
  { keys: ['herb', 'leaf', 'mint', 'basil'],         suggested: ['BUNCH', 'KG', 'PKT'] },

  // Pantry / grocery
  { keys: ['oil'],                                   suggested: ['BTL', 'CAN', 'L', 'TIN'] },
  { keys: ['spice', 'powder', 'masala'],             suggested: ['PKT', 'KG', 'JAR'] },
  { keys: ['rice', 'grain', 'dal', 'pulse',
           'flour', 'sugar', 'salt'],                suggested: ['BAG', 'KG', 'PKT'] },
  { keys: ['sauce', 'paste', 'jam'],                 suggested: ['BTL', 'JAR', 'TIN', 'PKT'] },
  { keys: ['frozen'],                                suggested: ['PKT', 'BOX', 'KG'] },
  { keys: ['grocery'],                               suggested: ['PKT', 'KG', 'TIN', 'JAR', 'BAG', 'BTL'] },

  // Proteins
  { keys: ['chicken', 'mutton', 'lamb', 'beef',
           'pork', 'meat'],                          suggested: ['KG', 'pcs'] },
  { keys: ['fish', 'prawn', 'seafood', 'crab'],      suggested: ['KG', 'pcs', 'BOX'] },
  { keys: ['egg'],                                   suggested: ['pcs', 'BOX', 'TRAY'] },

  // Non-consumable
  { keys: ['housekeeping', 'cleaning'],              suggested: ['BTL', 'PKT', 'L', 'pcs'] },
  { keys: ['stationery', 'paper'],                   suggested: ['pcs', 'BOX', 'PKT'] },
  { keys: ['gas', 'charcoal', 'fuel', 'wood'],       suggested: ['KG', 'BAG', 'pcs'] },
];

function suggestedPurchaseUnits(category?: string): string[] {
  const c = (category || '').toLowerCase();
  if (!c) return [];
  for (const hint of CATEGORY_HINTS) {
    if (hint.keys.some(k => c.includes(k))) return hint.suggested;
  }
  return [];
}

export default function UnitAuditPage() {
  const [data, setData] = useState<{ materials: AuditMaterial[]; total: number; filtered: number; flag_counts: Record<string, number>; severity_counts: Record<string, number>; categories?: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState<'all' | 'high' | 'medium' | 'low' | 'ok'>('high');
  const [flagFilter, setFlagFilter] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [edits, setEdits] = useState<Record<string, { recipe_unit?: string; purchase_unit?: string; pack_size?: number; case_size?: number; category?: string }>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [bulkTarget, setBulkTarget] = useState<'recipe_unit' | 'purchase_unit' | 'case_size'>('recipe_unit');
  const [bulkUnit, setBulkUnit] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<null | {
    rows_processed: number; locks_upserted: number;
    applied_to_materials: number; unmatched_materials: number;
    unmatched_sample: string[];
  }>(null);
  const [importFileEl, setImportFileEl] = useState<HTMLInputElement | null>(null);

  const onDownload = () => {
    // Pull the CSV. Browser handles the Save dialog via Content-Disposition.
    window.location.href = '/api/unit-audit/export';
  };

  const onReupload = () => importFileEl?.click();

  const onImportFile = async (f: File | null) => {
    if (!f) return;
    setImportBusy(true);
    setImportResult(null);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await api('/api/unit-audit/import', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Import failed'); return; }
      setImportResult(j);
      setRefreshKey(k => k + 1);
    } finally {
      setImportBusy(false);
      if (importFileEl) importFileEl.value = '';
    }
  };

  const reload = async () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (search) qs.set('q', search);
    if (flagFilter) qs.set('only', flagFilter);
    if (categoryFilter) qs.set('category', categoryFilter);
    const r = await fetch(`/api/unit-audit?${qs}`);
    const j = await r.json();
    setData(j);
    setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [search, flagFilter, categoryFilter, refreshKey]);

  const filteredBySeverity = useMemo(() => {
    if (!data) return [];
    if (severityFilter === 'all') return data.materials;
    return data.materials.filter(m => m.severity === severityFilter);
  }, [data, severityFilter]);

  // Use the API-supplied list (independent of current filter) so the dropdown
  // doesn't collapse to a single option once a category is selected.
  const categories = useMemo(() => {
    if (data?.categories && data.categories.length > 0) return data.categories;
    const set = new Set((data?.materials || []).map(m => m.category).filter(Boolean));
    return Array.from(set).sort();
  }, [data]);

  const updateEdit = (id: string, patch: { recipe_unit?: string; purchase_unit?: string; pack_size?: number; case_size?: number; category?: string }) =>
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const toggleSelect = (id: string) =>
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const selectAllVisible = () => setSelected(new Set(filteredBySeverity.map(m => m.id)));
  const clearSelection   = () => setSelected(new Set());

  const applyBulk = () => {
    if (!bulkUnit || selected.size === 0) return;
    const next = { ...edits };
    // case_size is numeric; everything else is a string.
    const isNumeric = bulkTarget === 'case_size';
    const value: any = isNumeric ? (parseFloat(bulkUnit) || 1) : bulkUnit;
    for (const id of selected) next[id] = { ...next[id], [bulkTarget]: value };
    setEdits(next);
  };

  const save = async () => {
    const updates = Object.entries(edits)
      .map(([id, patch]) => ({ id, ...patch }))
      .filter(u => u.recipe_unit || u.purchase_unit || u.pack_size != null || u.case_size != null || u.category);
    if (updates.length === 0) { alert('No edits to save'); return; }
    setSaving(true);
    try {
      const r = await api('/api/unit-audit', { method: 'PUT', body: { updates } });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Failed'); return; }
      // When a unit/pack change alters the conversion factor, the server
      // re-bases price & stock so the ₹/purchase-unit reality is preserved —
      // show exactly what it did so the numbers never change "silently".
      const rb: any[] = j.rebased || [];
      const rbNote = rb.length
        ? `\n\nPrice & stock re-based to the new units (₹/purchase-unit preserved):\n` +
          rb.slice(0, 8).map((x: any) =>
            `• ${x.name}: avg ₹${x.old_avg} → ₹${x.new_avg}/unit · stock ${x.old_stock} → ${x.new_stock}`).join('\n') +
          (rb.length > 8 ? `\n…and ${rb.length - 8} more` : '')
        : '';
      alert(`Saved ${j.updated} update(s).${rbNote}`);
      setEdits({});
      setSelected(new Set());
      setRefreshKey(k => k + 1);
    } finally { setSaving(false); }
  };

  // One-click heal of a reverted item: re-apply its saved (locked) units through
  // the curation route (which updates both the material AND the lock).
  const restore = async (m: AuditMaterial) => {
    if (!m.lock) return;
    const upd: any = { id: m.id };
    if (m.lock.unit != null)          upd.recipe_unit   = m.lock.unit;
    if (m.lock.purchase_unit != null) upd.purchase_unit = m.lock.purchase_unit;
    if (m.lock.pack_size != null)     upd.pack_size     = m.lock.pack_size;
    if (m.lock.case_size != null)     upd.case_size     = m.lock.case_size;
    setSaving(true);
    try {
      const r = await api('/api/unit-audit', { method: 'PUT', body: { updates: [upd] } });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Failed'); return; }
      setRefreshKey(k => k + 1);
    } finally { setSaving(false); }
  };

  const editCount = Object.values(edits).filter(e => e.recipe_unit || e.purchase_unit || e.pack_size != null || e.case_size != null || e.category).length;
  const sev = data?.severity_counts || { high: 0, medium: 0, low: 0, ok: 0 };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <AlertTriangle className="w-6 h-6 text-amber-600" /> Unit-of-Measure Audit
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Sweep through raw_materials and fix wrong units before recipes go live.
            Wrong units = wrong recipe cost + wrong recipe deductions.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={onDownload}
                  title="Download a CSV snapshot of the curated unit audit. Edit offline or keep for disaster recovery."
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <Download className="w-4 h-4" /> Download Audit
          </button>
          <button onClick={onReupload} disabled={importBusy}
                  title="Re-apply a previously downloaded audit CSV. Use after a data wipe or to apply offline edits."
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2 disabled:opacity-50">
            {importBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Re-upload Audit
          </button>
          <input ref={el => setImportFileEl(el)} type="file" accept=".csv,text/csv" className="hidden"
                 onChange={e => onImportFile(e.target.files?.[0] || null)} />
          <button onClick={() => setRefreshKey(k => k + 1)}
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {importResult && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900 flex items-start justify-between gap-3">
          <div>
            <div className="font-semibold">Audit re-imported.</div>
            <ul className="mt-1 space-y-0.5">
              <li>· Rows processed: <b>{importResult.rows_processed}</b></li>
              <li>· Locks upserted: <b>{importResult.locks_upserted}</b> (these survive a data wipe)</li>
              <li>· Applied to live materials: <b>{importResult.applied_to_materials}</b></li>
              {importResult.unmatched_materials > 0 && (
                <li>· Unmatched (no raw_material yet, lock saved for later): <b>{importResult.unmatched_materials}</b>
                  {importResult.unmatched_sample.length > 0 && <> — e.g. {importResult.unmatched_sample.join(', ')}</>}
                </li>
              )}
            </ul>
          </div>
          <button onClick={() => setImportResult(null)} className="text-emerald-700 hover:text-emerald-900">✕</button>
        </div>
      )}

      {/* Severity tabs */}
      <TabScroller className="gap-2 text-xs">
        {(['high', 'medium', 'low', 'ok', 'all'] as const).map(s => {
          const counts = (data?.severity_counts || {}) as Record<string, number>;
          const n = s === 'all' ? data?.total ?? 0 : (counts[s] ?? 0);
          const tones: Record<string, string> = {
            high:   severityFilter === s ? 'bg-red-600 text-white' : 'bg-red-50 text-red-700 border-red-200',
            medium: severityFilter === s ? 'bg-amber-600 text-white' : 'bg-amber-50 text-amber-800 border-amber-200',
            low:    severityFilter === s ? 'bg-[#6B5744] text-white' : 'bg-[#FFF1E3] text-[#6B5744] border-[#D4B896]',
            ok:     severityFilter === s ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 border-emerald-200',
            all:    severityFilter === s ? 'bg-[#af4408] text-white' : 'bg-white text-[#6B5744] border-[#E8D5C4]',
          };
          const labels: Record<string, string> = { high: 'High severity', medium: 'Medium', low: 'Low', ok: 'OK', all: 'All' };
          return (
            <button key={s} onClick={() => setSeverityFilter(s)}
                    className={`px-3 py-1.5 rounded border ${tones[s]}`}>
              {labels[s]} <span className="ml-1 font-mono">{n}</span>
            </button>
          );
        })}
      </TabScroller>

      {/* Flag chips */}
      {data && (
        <TabScroller className="gap-1 text-[10px] items-center">
          <Filter className="w-3 h-3 text-[#8B7355]" />
          <span className="text-[#8B7355] mr-1">Flag:</span>
          <button onClick={() => setFlagFilter('')}
                  className={`px-2 py-0.5 rounded border ${flagFilter === '' ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}>
            All flags
          </button>
          {Object.entries(FLAG_META).map(([k, m]) => {
            const n = data.flag_counts[k] || 0;
            const active = flagFilter === k;
            if (n === 0) return null;
            return (
              <button key={k} onClick={() => setFlagFilter(active ? '' : k)} title={m.help}
                      className={`px-2 py-0.5 rounded border ${active ? 'bg-[#af4408] text-white border-[#af4408]' : m.tone}`}>
                {m.label} <span className="ml-1 font-mono">{n}</span>
              </button>
            );
          })}
        </TabScroller>
      )}

      {/* Search + bulk actions */}
      <div className="flex flex-wrap items-center gap-2 bg-white border border-[#E8D5C4] rounded-xl p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-2 top-2 text-[#8B7355]" />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Search SKU or name…"
                 className="w-full pl-8 pr-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </div>
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
                className="px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] min-w-[160px]"
                title="Filter by raw_material category">
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {categoryFilter && (
          <button onClick={() => setCategoryFilter('')} className="text-[#af4408] underline text-xs">
            Clear category
          </button>
        )}
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className="text-[#6B5744]">{selected.size} selected</span>
          <span className="text-[#8B7355]">· bulk set</span>
          <select value={bulkTarget} onChange={e => { setBulkTarget(e.target.value as any); setBulkUnit(''); }}
                  className="px-2 py-1 border border-[#E8D5C4] rounded text-xs bg-[#FFF8F0]">
            <option value="recipe_unit">Recipe Unit</option>
            <option value="purchase_unit">Purchase Unit</option>
            <option value="case_size">Case Size</option>
          </select>
          {bulkTarget === 'case_size' ? (
            // Numeric input for case size — common values offered as datalist
            <>
              <input type="number" min={1} step="any" list="bulk-case-sizes"
                     value={bulkUnit} onChange={e => setBulkUnit(e.target.value)}
                     placeholder="e.g. 12"
                     className="w-20 px-2 py-1 border border-[#E8D5C4] rounded text-xs bg-[#FFF8F0]" />
              <datalist id="bulk-case-sizes">
                <option value="6" /><option value="12" /><option value="24" />
                <option value="4" /><option value="8" /><option value="48" />
              </datalist>
            </>
          ) : (
            <select value={bulkUnit} onChange={e => setBulkUnit(e.target.value)}
                    className="px-2 py-1 border border-[#E8D5C4] rounded text-xs bg-[#FFF8F0]">
              <option value="">to…</option>
              {(() => {
                if (bulkTarget === 'recipe_unit') return RECIPE_UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>);
                const selectedRows = filteredBySeverity.filter(m => selected.has(m.id));
                const cats = new Set(selectedRows.map(m => (edits[m.id]?.category ?? m.category)));
                const sharedCat = cats.size === 1 ? [...cats][0] : '';
                const suggested = suggestedPurchaseUnits(sharedCat);
                if (suggested.length > 0) {
                  const others = PURCHASE_UNIT_OPTIONS.filter(u => !suggested.includes(u));
                  return (
                    <>
                      <optgroup label={`For ${sharedCat}`}>
                        {suggested.map(u => <option key={u} value={u}>{u}</option>)}
                      </optgroup>
                      <optgroup label="Other">
                        {others.map(u => <option key={u} value={u}>{u}</option>)}
                      </optgroup>
                    </>
                  );
                }
                return PURCHASE_UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>);
              })()}
            </select>
          )}
          <button onClick={applyBulk} disabled={!bulkUnit || selected.size === 0}
                  className="px-2 py-1 bg-[#FFF1E3] border border-[#D4B896] text-[#6B5744] rounded disabled:opacity-50 hover:bg-[#FFE9D4]">
            Apply
          </button>
          {selected.size > 0 && (
            <button onClick={clearSelection} className="text-[#af4408] underline">Clear</button>
          )}
        </div>
        <button onClick={save} disabled={editCount === 0 || saving}
                className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-sm flex items-center gap-1.5 disabled:opacity-50">
          <Save className="w-4 h-4" /> Save {editCount > 0 ? `(${editCount})` : ''}
        </button>
      </div>

      {/* Summary */}
      <div className="text-xs text-[#6B5744]">
        Showing <b>{filteredBySeverity.length}</b> of <b>{data?.total ?? '—'}</b> materials
        {categoryFilter && <> · category = <code className="px-1 bg-[#FFF1E3] rounded">{categoryFilter}</code></>}
        {flagFilter && <> · flag = <code className="px-1 bg-[#FFF1E3] rounded">{flagFilter}</code></>}
        {severityFilter !== 'all' && <> · severity = <b>{severityFilter}</b></>}
      </div>

      {/* Table */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
          </div>
        ) : filteredBySeverity.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#8B7355]">
            <CheckCircle2 className="w-6 h-6 mx-auto mb-2 text-emerald-500" />
            Nothing flagged in this slice. {severityFilter !== 'all' && 'Try another severity tab.'}
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF1E3] text-[#6B5744] sticky top-0">
                <tr>
                  <th className="w-8 px-2 py-1.5">
                    <input type="checkbox"
                           checked={selected.size > 0 && selected.size === filteredBySeverity.length}
                           onChange={e => e.target.checked ? selectAllVisible() : clearSelection()} />
                  </th>
                  <th className="text-left  py-1.5 px-2 font-medium">SKU</th>
                  <th className="text-left  py-1.5 px-2 font-medium">Material</th>
                  <th className="text-left  py-1.5 px-2 font-medium">Category</th>
                  <th className="text-left  py-1.5 px-2 font-medium" title="How the vendor invoices this — case, bottle, kg, etc.">Purchase Unit</th>
                  <th className="text-left  py-1.5 px-2 font-medium" title="The canonical unit recipes consume in. Drives recipe cost + recipe-deduction.">Recipe Unit</th>
                  <th className="text-right py-1.5 px-2 font-medium" title="How many recipe-units are in one purchase-unit. e.g. 750 ml in 1 BTL of 100 Pipers.">Pack Size</th>
                  <th className="text-right py-1.5 px-2 font-medium" title="Bottles per outer case. 12 for a case of 12, 24 for a beer case. 1 = no outer pack.">Case Size</th>
                  <th className="text-right py-1.5 px-2 font-medium">Stock</th>
                  <th className="text-right py-1.5 px-2 font-medium">Last ₹</th>
                  <th className="text-right py-1.5 px-2 font-medium">Used in</th>
                  <th className="text-left  py-1.5 px-2 font-medium">Flags</th>
                </tr>
              </thead>
              <tbody>
                {filteredBySeverity.map(m => {
                  const e = edits[m.id] || {};
                  const currentRecipe   = m.recipe_unit ?? m.unit;
                  const currentPurchase = m.purchase_unit ?? currentRecipe;
                  const isEditedRecipe   = e.recipe_unit   && e.recipe_unit   !== currentRecipe;
                  const isEditedPurchase = e.purchase_unit && e.purchase_unit !== currentPurchase;
                  const isEditedCat      = e.category && e.category !== m.category;
                  const unitsDiffer      = (e.purchase_unit ?? currentPurchase) !== (e.recipe_unit ?? currentRecipe);
                  const sevColor = m.severity === 'high' ? 'bg-red-50/40' : m.severity === 'medium' ? 'bg-amber-50/30' : '';
                  return (
                    <tr key={m.id} className={`border-t border-[#E8D5C4]/50 ${sevColor}`}>
                      <td className="px-2 py-1.5">
                        <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggleSelect(m.id)} />
                      </td>
                      <td className="py-1.5 px-2 font-mono text-[10px] text-[#8B7355]">{m.sku || '·'}</td>
                      <td className="py-1.5 px-2 font-medium text-[#2D1B0E]">{m.name}</td>
                      <td className="py-1.5 px-2">
                        <input value={e.category ?? m.category}
                               onChange={ev => updateEdit(m.id, { category: ev.target.value })}
                               list={`unit-audit-categories`}
                               className={`w-32 px-1 py-0.5 border rounded text-xs bg-[#FFF8F0] ${isEditedCat ? 'border-[#af4408]' : 'border-[#E8D5C4]'}`} />
                      </td>
                      <td className="py-1.5 px-2">
                        {/* Purchase unit — category-aware dropdown.
                            Suggested units (based on category) appear at the top;
                            the rest live under "Other" so admins can still pick anything. */}
                        {(() => {
                          const effectiveCat = e.category ?? m.category;
                          const suggested = suggestedPurchaseUnits(effectiveCat);
                          const others = PURCHASE_UNIT_OPTIONS.filter(u => !suggested.includes(u));
                          const value = e.purchase_unit ?? currentPurchase;
                          const inWhitelist = PURCHASE_UNIT_OPTIONS.includes(value);
                          return (
                            <select value={value}
                                    onChange={ev => updateEdit(m.id, { purchase_unit: ev.target.value })}
                                    title={suggested.length > 0 ? `Suggested for "${effectiveCat}": ${suggested.join(', ')}` : 'No category suggestion'}
                                    className={`w-24 px-1 py-0.5 border rounded text-xs bg-[#FFF8F0] ${isEditedPurchase ? 'border-[#af4408] font-semibold' : 'border-[#E8D5C4]'}`}>
                              {suggested.length > 0 ? (
                                <>
                                  <optgroup label={`For ${effectiveCat || 'category'}`}>
                                    {suggested.map(u => <option key={u} value={u}>{u}</option>)}
                                  </optgroup>
                                  <optgroup label="Other">
                                    {others.map(u => <option key={u} value={u}>{u}</option>)}
                                  </optgroup>
                                </>
                              ) : (
                                PURCHASE_UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)
                              )}
                              {!inWhitelist && value && (
                                <option value={value}>{value}</option>
                              )}
                            </select>
                          );
                        })()}
                        {unitsDiffer && (
                          <div className="text-[9px] text-[#8B7355] mt-0.5" title="Buy as one unit, consume in another">≠ recipe</div>
                        )}
                      </td>
                      <td className="py-1.5 px-2">
                        {/* Recipe unit — drives recipe cost + recipe-deduction. Strict whitelist. */}
                        <select value={e.recipe_unit ?? currentRecipe}
                                onChange={ev => updateEdit(m.id, { recipe_unit: ev.target.value })}
                                className={`w-20 px-1 py-0.5 border rounded text-xs bg-[#FFF8F0] ${isEditedRecipe ? 'border-[#af4408] font-semibold' : 'border-[#E8D5C4]'}`}>
                          {RECIPE_UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
                          {!RECIPE_UNIT_OPTIONS.includes(currentRecipe) && <option value={currentRecipe}>{currentRecipe}</option>}
                        </select>
                      </td>
                      <td className="py-1.5 px-2">
                        {(() => {
                          const currentPackSize = e.pack_size ?? m.pack_size ?? 1;
                          const effectiveRecipe = e.recipe_unit ?? currentRecipe;
                          const isEditedPack = e.pack_size != null && e.pack_size !== (m.pack_size ?? 1);
                          const suggested = suggestPackSizeFromName(m.name, effectiveRecipe);
                          const showSuggestion = suggested && Math.abs(suggested - currentPackSize) > 0.001;
                          return (
                            <div className="flex items-center gap-1 justify-end">
                              <input type="number" step="any" min={0}
                                     value={currentPackSize || ''}
                                     onChange={ev => updateEdit(m.id, { pack_size: parseFloat(ev.target.value) || 1 })}
                                     className={`w-16 px-1 py-0.5 border rounded text-right text-xs bg-[#FFF8F0] ${isEditedPack ? 'border-[#af4408] font-semibold' : 'border-[#E8D5C4]'}`} />
                              {showSuggestion && (
                                <button type="button"
                                        title={`Auto-fill from name: 1 ${e.purchase_unit ?? currentPurchase} = ${suggested} ${effectiveRecipe}`}
                                        onClick={() => updateEdit(m.id, { pack_size: suggested! })}
                                        className="text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-200">
                                  ⚡{suggested}
                                </button>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="py-1.5 px-2">
                        {(() => {
                          // Case Size — bottles per outer case (12, 24, 6, etc.)
                          const currentCase = e.case_size ?? m.case_size ?? 1;
                          const isEditedCase = e.case_size != null && e.case_size !== (m.case_size ?? 1);
                          return (
                            <input type="number" step="any" min={1}
                                   value={currentCase || ''}
                                   onChange={ev => updateEdit(m.id, { case_size: parseFloat(ev.target.value) || 1 })}
                                   placeholder="1"
                                   title="Bottles per case (default 1 = no outer pack)"
                                   className={`w-14 px-1 py-0.5 border rounded text-right text-xs bg-[#FFF8F0] ${isEditedCase ? 'border-[#af4408] font-semibold' : 'border-[#E8D5C4]'}`} />
                          );
                        })()}
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono text-[#6B5744]">
                        {(() => {
                          const ps = m.pack_size || 1;
                          const pu = m.purchase_unit || m.recipe_unit || m.unit;
                          const ru = m.recipe_unit || m.unit;
                          if (ps > 1) {
                            return (
                              <>
                                <span>{(m.current_stock / ps).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                                <span className="ml-1 text-[9px] text-[#8B7355]">{pu}</span>
                                <div className="text-[9px] text-[#8B7355]">
                                  = {m.current_stock.toLocaleString('en-IN')} {ru}
                                </div>
                              </>
                            );
                          }
                          return <>{m.current_stock.toLocaleString('en-IN', { maximumFractionDigits: 2 })} <span className="text-[9px] text-[#8B7355]">{ru}</span></>;
                        })()}
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono">{fmt(m.last_purchase_price || m.average_price)}</td>
                      <td className="py-1.5 px-2 text-right font-mono text-[#6B5744]">
                        {m.purchase_count} buy · {m.recipe_use_count} rec
                      </td>
                      <td className="py-1.5 px-2">
                        <div className="flex flex-wrap gap-1 items-center">
                          {m.flags.map(f => {
                            const meta = FLAG_META[f];
                            if (!meta) return <span key={f} className="text-[10px] px-1 rounded bg-[#E8D5C4] text-[#6B5744]">{f}</span>;
                            return (
                              <span key={f} title={meta.help}
                                    className={`text-[10px] px-1 rounded border ${meta.tone}`}>
                                {meta.label}
                              </span>
                            );
                          })}
                          {m.drifted && m.lock && (
                            <button onClick={() => restore(m)} disabled={saving}
                                    title={`Saved units → recipe ${m.lock.unit ?? '—'} · buy ${m.lock.purchase_unit ?? '—'} · pack ${m.lock.pack_size ?? '—'} · case ${m.lock.case_size ?? '—'}`}
                                    className="text-[10px] px-1.5 py-0.5 rounded border border-red-300 bg-white text-red-700 hover:bg-red-50 disabled:opacity-50 font-medium">
                              ↺ Restore saved units
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <datalist id="unit-audit-categories">
              {categories.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
        )}
      </div>
    </div>
  );
}
