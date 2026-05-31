'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowUpDown, CheckCircle2, Droplets, Package,
  Search, TrendingDown, Link2, Link2Off, Loader2, Save, X as XIcon, Trash2, RotateCcw,
} from 'lucide-react';
import { api } from '@/lib/api';

function formatCurrency(v: number): string {
  return '\u20B9' + (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
function formatQty(v: number, unit = ''): string {
  if (!Number.isFinite(v)) return '-';
  return v.toLocaleString('en-IN', { maximumFractionDigits: 0 }) + (unit ? ` ${unit}` : '');
}
function formatCompact(v: number): string {
  if (Math.abs(v) >= 10000000) return (v / 10000000).toFixed(2) + 'Cr';
  if (Math.abs(v) >= 100000)   return (v / 100000).toFixed(2) + 'L';
  if (Math.abs(v) >= 1000)     return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v));
}

interface DirectItem {
  item_name: string;
  category: string | null;
  department: 'Bar' | 'Beverages' | null;
  dismissed?: number;
  qty_sold: number;
  revenue: number;
  line_count: number;
  nc_qty: number;
  nc_cost: number;
  sold_per_unit_ml: number | null;
  matched: null | {
    material_id: string;
    material_name: string;
    unit: string;
    per_unit_ml: number | null;
    avg_price: number;
    current_stock: number;
    purchased_qty: number;
    purchase_count: number;
    score: number;
  };
  sold_in_mat_unit?: number;
  conversion_note?: string;
  leakage_qty?: number;
  leakage_value?: number;
  qty_per_unit?: number;
  linked_material_id?: string | null;
  reviewed?: boolean;
}

interface MaterialLite { id: string; name: string; unit: string; sku?: string; }

interface Payload {
  count: number; matched: number; unmatched: number;
  total_leakage_value: number; items: DirectItem[];
}

export default function DirectItemsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showOnly, setShowOnly] = useState<'all' | 'matched' | 'unmatched'>('all');
  // Renamed from categoryFilter — we now group by Department (Bar / Beverages)
  const [departmentFilter, setDepartmentFilter] = useState<'' | 'Bar' | 'Beverages'>('');
  const [showDismissed, setShowDismissed] = useState(false);
  const [dismissingRow, setDismissingRow] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'revenue' | 'qty' | 'leakage_abs'>('revenue');
  const [minSold, setMinSold] = useState(20);
  const [materials, setMaterials] = useState<MaterialLite[]>([]);
  const [editingRow, setEditingRow] = useState<string | null>(null);
  const [editMatId, setEditMatId] = useState('');
  const [editQpu, setEditQpu] = useState('1');
  const [matSearch, setMatSearch] = useState('');
  const [savingRow, setSavingRow] = useState<string | null>(null);

  const load = () => {
    setLoading(true); setError(null);
    fetch(`/api/direct-items?min_sold=${minSold}&limit=500${showDismissed ? '&include_dismissed=1' : ''}`)
      .then(async r => r.ok ? r.json() : Promise.reject(await r.text()))
      .then(setData)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [minSold, showDismissed]);

  // Toggle dismissed flag for one item. Doesn't touch sales — just marks the
  // direct_item_links row so the report stops surfacing this name.
  const setDismissed = async (itemName: string, value: boolean) => {
    setDismissingRow(itemName);
    try {
      const r = await api('/api/direct-items', {
        method: 'POST',
        body: { item_name: itemName, material_id: null, qty_per_unit: 1, dismissed: value },
      });
      if (!r.ok) { alert((await r.json().catch(() => ({}))).error || 'Action failed'); return; }
      load();
    } finally { setDismissingRow(null); }
  };

  // Load materials for the picker
  useEffect(() => {
    fetch('/api/inventory').then(r => r.json()).then(d => {
      const arr = (d.materials || d || []).map((m: any) => ({
        id: m.id, name: m.name, unit: m.unit, sku: m.sku,
      }));
      setMaterials(arr);
    }).catch(() => {});
  }, []);

  const startEdit = (i: DirectItem) => {
    setEditingRow(i.item_name);
    setEditMatId(i.linked_material_id || i.matched?.material_id || '');
    setEditQpu(String(i.qty_per_unit || 1));
    setMatSearch('');
  };
  const cancelEdit = () => {
    setEditingRow(null); setEditMatId(''); setEditQpu('1'); setMatSearch('');
  };
  const saveEdit = async (itemName: string) => {
    setSavingRow(itemName);
    try {
      const r = await api('/api/direct-items', {
        method: 'POST',
        body: {
          item_name: itemName,
          material_id: editMatId || null,
          qty_per_unit: Number(editQpu) || 1,
        },
      });
      if (!r.ok) { alert((await r.json().catch(() => ({}))).error || 'Save failed'); return; }
      cancelEdit();
      load();
    } finally { setSavingRow(null); }
  };

  const filteredMaterials = useMemo(() => {
    if (!matSearch.trim()) return materials.slice(0, 50);
    const s = matSearch.toLowerCase();
    return materials
      .filter(m => m.name.toLowerCase().includes(s) || (m.sku || '').toLowerCase().includes(s))
      .slice(0, 50);
  }, [materials, matSearch]);

  const items = useMemo(() => {
    if (!data) return [];
    let list = data.items;
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(i =>
        i.item_name.toLowerCase().includes(s) ||
        (i.matched?.material_name.toLowerCase().includes(s) ?? false)
      );
    }
    if (showOnly === 'matched')   list = list.filter(i => i.matched);
    if (showOnly === 'unmatched') list = list.filter(i => !i.matched);
    if (departmentFilter)         list = list.filter(i => i.department === departmentFilter);
    list = [...list];
    if (sortBy === 'revenue')    list.sort((a, b) => b.revenue - a.revenue);
    if (sortBy === 'qty')        list.sort((a, b) => b.qty_sold - a.qty_sold);
    if (sortBy === 'leakage_abs')list.sort((a, b) => Math.abs(b.leakage_value || 0) - Math.abs(a.leakage_value || 0));
    return list;
  }, [data, search, showOnly, departmentFilter, sortBy]);

  // Compute counts per department (Bar / Beverages) honouring the search +
  // matched/unmatched filter so the dropdown labels show live numbers.
  const departmentCounts = useMemo(() => {
    const counts = { Bar: 0, Beverages: 0, total: 0 };
    if (!data) return counts;
    let list = data.items;
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(i =>
        i.item_name.toLowerCase().includes(s) ||
        (i.matched?.material_name.toLowerCase().includes(s) ?? false)
      );
    }
    if (showOnly === 'matched')   list = list.filter(i => i.matched);
    if (showOnly === 'unmatched') list = list.filter(i => !i.matched);
    for (const i of list) {
      if (i.department === 'Bar')        counts.Bar++;
      else if (i.department === 'Beverages') counts.Beverages++;
      counts.total++;
    }
    return counts;
  }, [data, search, showOnly]);

  // Summary tiles
  const summary = useMemo(() => {
    if (!data) return null;
    const matched    = data.items.filter(i => i.matched);
    const totalRev   = matched.reduce((a, b) => a + (b.revenue || 0), 0);
    const shortage   = matched.filter(i => (i.leakage_qty || 0) < 0).reduce((a, b) => a + Math.abs(b.leakage_value || 0), 0);
    const overstock  = matched.filter(i => (i.leakage_qty || 0) > 0).reduce((a, b) => a + Math.abs(b.leakage_value || 0), 0);
    return { matched: matched.length, totalRev, shortage, overstock };
  }, [data]);

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Direct Items — Purchase vs Sales</h1>
          <p className="text-[#8B7355] text-sm mt-1">
            Items sold as-is from a purchased raw material (bottled beer, soft drinks, liquor pegs).
            Surfaces leakage where inventory doesn&apos;t explain recorded sales.
          </p>
        </div>

        {/* Explainer banner */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900 flex gap-2 items-start">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">How leakage is computed: </span>
            For each direct item, we compare inventory-consumed (<code>purchased − current_stock</code>) against
            recorded sales-consumption (sold × pack volume).
            <span className="ml-1 font-medium">Negative leakage = sales record more than inventory had</span>
            (opening stock not captured or unmapped POS variants).
            <span className="ml-1 font-medium">Positive leakage = purchased more than sold/in-stock</span>
            (waste, staff, complimentary, or not-yet-sold).
          </div>
        </div>

        {/* Filter row */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-[#8B7355]" />
            <input value={search} onChange={e=>setSearch(e.target.value)}
                   placeholder="Search item or material…"
                   className="flex-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </div>
          {/* Department dropdown — only Bar / Beverages, derived from category.
              Counts honour the search + matched/unmatched filter so the labels
              tell the user exactly how many they'll get. */}
          <select value={departmentFilter}
                  onChange={e => setDepartmentFilter(e.target.value as '' | 'Bar' | 'Beverages')}
                  className="px-3 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm min-w-[200px]">
            <option value="">All departments ({departmentCounts.total})</option>
            <option value="Bar">Bar ({departmentCounts.Bar})</option>
            <option value="Beverages">Beverages ({departmentCounts.Beverages})</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-[#6B5744] cursor-pointer select-none whitespace-nowrap">
            <input type="checkbox" checked={showDismissed}
                   onChange={e => setShowDismissed(e.target.checked)} />
            Show dismissed
          </label>
          <div className="flex gap-1 bg-[#FFF1E3] rounded-lg p-1">
            {(['all', 'matched', 'unmatched'] as const).map(v => (
              <button key={v} onClick={()=>setShowOnly(v)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${showOnly === v ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-white'}`}>
                {v}
              </button>
            ))}
          </div>
          <div className="flex gap-1 bg-[#FFF1E3] rounded-lg p-1">
            {([
              ['revenue', 'By Revenue'],
              ['qty', 'By Qty'],
              ['leakage_abs', 'By Leakage |₹|'],
            ] as const).map(([v, label]) => (
              <button key={v} onClick={()=>setSortBy(v)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1 ${sortBy === v ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-white'}`}>
                <ArrowUpDown className="w-3 h-3" /> {label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-[#6B5744]">
            <span>Min sold:</span>
            <select value={minSold} onChange={e=>setMinSold(Number(e.target.value))}
                    className="px-2 py-1 rounded border border-[#E8D5C4] bg-white">
              <option value={5}>5</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
        </div>

        {/* Summary tiles */}
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <SummaryCard icon={<Link2 className="w-4 h-4" />} label="Matched items" value={String(summary.matched)} color="text-green-700" />
            <SummaryCard icon={<Package className="w-4 h-4" />} label="Revenue (matched)" value={formatCurrency(summary.totalRev)} color="text-[#af4408]" />
            <SummaryCard icon={<TrendingDown className="w-4 h-4" />} label="Total shortage |₹|" value={formatCurrency(summary.shortage)} color="text-red-600" sub="sales > inventory" />
            <SummaryCard icon={<Droplets className="w-4 h-4" />} label="Total overstock |₹|" value={formatCurrency(summary.overstock)} color="text-amber-700" sub="purchased > sold" />
          </div>
        )}

        {/* Items table */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow">
          {loading ? (
            <div className="p-8 text-center text-[#8B7355] flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Analysing {formatQty(38577)} sales rows…
            </div>
          ) : error ? (
            <div className="p-4 text-red-600 text-sm">Error: {error}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3] sticky top-0 z-10">
                  <tr className="text-[#6B5744] text-xs">
                    <th className="text-left  py-2.5 px-3 font-medium">Sold as (menu item)</th>
                    <th className="text-left  py-2.5 px-3 font-medium">Matched raw material</th>
                    <th className="text-left  py-2.5 px-3 font-medium">Conversion</th>
                    <th className="text-right py-2.5 px-3 font-medium">Sold qty</th>
                    <th className="text-right py-2.5 px-3 font-medium">Revenue</th>
                    <th className="text-right py-2.5 px-3 font-medium">Purchased</th>
                    <th className="text-right py-2.5 px-3 font-medium">Sold (in mat unit)</th>
                    <th className="text-right py-2.5 px-3 font-medium">Stock</th>
                    <th className="text-right py-2.5 px-3 font-medium">Leakage</th>
                    <th className="text-right py-2.5 px-3 font-medium">Leakage ₹</th>
                    <th className="w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr><td colSpan={11} className="py-6 text-center text-[#8B7355] text-xs">No direct items in this view.</td></tr>
                  ) : items.map((i, idx) => {
                    const leakVal = i.leakage_value || 0;
                    const leakQty = i.leakage_qty || 0;
                    const bad = Math.abs(leakVal) > 10000;
                    const sign = leakQty < 0 ? 'text-red-600' : leakQty > 0 ? 'text-amber-700' : 'text-[#6B5744]';
                    const isEditing = editingRow === i.item_name;
                    const pickedMat = materials.find(m => m.id === editMatId);
                    return (
                      <tr key={idx} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 align-top">
                        <td className="py-2 px-3 text-[#2D1B0E] text-xs font-medium">
                          {i.item_name}
                          {i.category && <span className="ml-2 text-[10px] text-[#8B7355] bg-[#FFF8F0] px-1.5 py-0.5 rounded">{i.category}</span>}
                        </td>
                        <td className="py-2 px-3 text-xs" colSpan={isEditing ? 2 : 1}>
                          {isEditing ? (
                            <div className="space-y-1.5">
                              <input
                                value={matSearch}
                                onChange={e => setMatSearch(e.target.value)}
                                placeholder="Type to search raw materials…"
                                className="w-full px-2 py-1 border border-[#D4B896] rounded text-xs"
                              />
                              <div className="max-h-32 overflow-y-auto border border-[#E8D5C4] rounded bg-white">
                                {filteredMaterials.map(m => (
                                  <button
                                    key={m.id}
                                    onClick={() => { setEditMatId(m.id); setMatSearch(''); }}
                                    className={`w-full text-left px-2 py-1 text-[11px] hover:bg-[#FFF1E3] ${editMatId === m.id ? 'bg-[#FFF1E3] font-semibold' : ''}`}>
                                    {m.name} <span className="text-[#8B7355]">· {m.unit}</span>
                                  </button>
                                ))}
                                {filteredMaterials.length === 0 && (
                                  <div className="px-2 py-1 text-[10px] text-[#8B7355]">No match</div>
                                )}
                              </div>
                              {pickedMat && (
                                <div className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                                  Linked → <strong>{pickedMat.name}</strong> ({pickedMat.unit})
                                </div>
                              )}
                              <div className="flex items-center gap-2 pt-1">
                                <label className="text-[10px] text-[#6B5744] whitespace-nowrap">1 sold =</label>
                                <input
                                  type="number" step="any" min={0.0001}
                                  value={editQpu}
                                  onChange={e => setEditQpu(e.target.value)}
                                  className="w-20 px-2 py-1 border border-[#D4B896] rounded text-xs text-right font-mono"
                                />
                                <span className="text-[10px] text-[#6B5744]">{pickedMat?.unit || 'units'}</span>
                              </div>
                              <div className="flex gap-1 pt-1">
                                <button onClick={() => saveEdit(i.item_name)}
                                        disabled={savingRow === i.item_name}
                                        className="text-[10px] px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded disabled:opacity-40 inline-flex items-center gap-1">
                                  <Save className="w-3 h-3" /> {savingRow === i.item_name ? 'Saving…' : 'Save'}
                                </button>
                                <button onClick={cancelEdit} className="text-[10px] px-2 py-1 bg-[#FFF1E3] text-[#6B5744] rounded inline-flex items-center gap-1">
                                  <XIcon className="w-3 h-3" /> Cancel
                                </button>
                                <button onClick={() => { setEditMatId(''); setEditQpu('1'); saveEdit(i.item_name); }}
                                        className="text-[10px] px-2 py-1 bg-red-50 text-red-700 rounded ml-auto">
                                  Unlink
                                </button>
                              </div>
                            </div>
                          ) : i.matched ? (
                            <div className="flex flex-col">
                              <button onClick={() => startEdit(i)} className="text-[#2D1B0E] hover:text-[#af4408] text-left">
                                {i.matched.material_name}
                              </button>
                              <span className="text-[10px] text-[#8B7355] flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3 text-green-600" />
                                score {(i.matched.score * 100).toFixed(0)}% · stock unit: {i.matched.unit}
                              </span>
                            </div>
                          ) : (
                            <button onClick={() => startEdit(i)} className="text-[#af4408] flex items-center gap-1 hover:underline">
                              <Link2Off className="w-3 h-3" /> Link material
                            </button>
                          )}
                        </td>
                        {!isEditing && (
                          <td className="py-2 px-3 text-xs text-[#6B5744]">
                            <button onClick={() => startEdit(i)} className="text-left hover:text-[#af4408] inline-flex items-center gap-1">
                              {i.matched ? (i.conversion_note || '-') : '-'}
                              {(i.qty_per_unit && i.qty_per_unit !== 1) && (
                                <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-purple-100 text-purple-800 font-semibold">×{i.qty_per_unit}</span>
                              )}
                              <span className="text-[9px] text-[#8B7355]">✎</span>
                            </button>
                          </td>
                        )}
                        <td className="py-2 px-3 text-xs text-right font-mono">{formatQty(i.qty_sold)}</td>
                        <td className="py-2 px-3 text-xs text-right font-mono text-green-700">{formatCurrency(i.revenue)}</td>
                        <td className="py-2 px-3 text-xs text-right font-mono">{i.matched ? formatQty(i.matched.purchased_qty) : '-'}</td>
                        <td className="py-2 px-3 text-xs text-right font-mono">{i.matched ? formatQty(i.sold_in_mat_unit || 0) : '-'}</td>
                        <td className="py-2 px-3 text-xs text-right font-mono">{i.matched ? formatQty(i.matched.current_stock) : '-'}</td>
                        <td className={`py-2 px-3 text-xs text-right font-mono font-semibold ${sign}`}>
                          {i.matched ? (leakQty > 0 ? '+' : '') + formatQty(leakQty) : '-'}
                        </td>
                        <td className={`py-2 px-3 text-xs text-right font-mono font-semibold ${sign} ${bad ? 'bg-red-50/40' : ''}`}>
                          {i.matched ? (leakVal > 0 ? '+' : '') + formatCurrency(leakVal) : '-'}
                        </td>
                        <td className="py-2 px-2 text-right">
                          {i.dismissed ? (
                            <button
                              onClick={() => setDismissed(i.item_name, false)}
                              disabled={dismissingRow === i.item_name}
                              title="Restore — bring this item back into the report"
                              className="p-1 rounded text-emerald-700 hover:bg-emerald-50 disabled:opacity-40">
                              {dismissingRow === i.item_name ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                if (!confirm(`Dismiss "${i.item_name}" from the Direct Items report?\n\nThis hides the row but does NOT delete any sales history. You can restore it later with "Show dismissed".`)) return;
                                setDismissed(i.item_name, true);
                              }}
                              disabled={dismissingRow === i.item_name}
                              title="Dismiss — hide this row from the Direct Items report (sales history stays intact)"
                              className="p-1 rounded text-red-600 hover:bg-red-50 disabled:opacity-40">
                              {dismissingRow === i.item_name ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                            </button>
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

        <p className="text-xs text-[#8B7355]">
          Ranked matching uses token-anchor + pack-volume heuristics. If the wrong material was matched (or none),
          a manual linking UI will follow — for now review the list and the engineering team will wire up
          <code className="mx-1 px-1 bg-[#FFF1E3] rounded">menu_items.material_id</code> for the correct rows.
        </p>
      </div>
    </div>
  );
}

function SummaryCard({ icon, label, value, sub, color }:
  { icon: React.ReactNode; label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow">
      <p className="text-[10px] uppercase tracking-wider text-[#8B7355] flex items-center gap-1">
        {icon} {label}
      </p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-[#8B7355] mt-1">{sub}</p>}
    </div>
  );
}
