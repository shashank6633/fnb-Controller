'use client';

/**
 * Closing-stock by Storage Location — Phase 1 §6 EOD ritual.
 * Pick a physical area (Walk-in chiller, Bar back-bar, Dry store rack 3…),
 * see only the items present there, type counts inline, save the whole
 * location in one click. Lets multiple staff count parallel locations.
 *
 * Set the storage_location field on each material via Inventory → Edit.
 */

import { useEffect, useMemo, useState } from 'react';
import { MapPin, Loader2, Save, ChevronLeft, Package, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const today = () => new Date().toISOString().slice(0, 10);

interface LocSummary { location: string; items: number; counted_today: number; low_stock: number; }
interface Item {
  id: string; sku?: string; name: string; unit: string; purchase_unit?: string; pack_size?: number;
  current_stock: number; average_price: number; reorder_level?: number;
  super_category?: string; category?: string; closing_cadence?: string; shelf_life_days?: number;
  today_count: number | null; today_variance: number | null; today_by?: string;
}

export default function ClosingStockByLocationPage() {
  // Role gate — only admins see the "adjust system stock to match" shortcut.
  // Store managers would otherwise just click it without a physical recount,
  // which defeats the purpose of the closing-stock workflow.
  const [meRole, setMeRole] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMeRole(d?.user?.role || null)).catch(() => {});
  }, []);
  const isAdmin = meRole === 'admin';
  const [date, setDate] = useState(today());
  const [locations, setLocations] = useState<LocSummary[]>([]);
  const [totals, setTotals] = useState({ locations: 0, items: 0, counted: 0 });
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [adjustStock, setAdjustStock] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState('');
  const [filterUncountedOnly, setFilterUncountedOnly] = useState(false);
  // Category filter — narrows the detail-view item list to one super_category
  // (or category fallback). Empty string = all categories. Item search box
  // filters within the selected category.
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [itemSearch, setItemSearch] = useState<string>('');

  const reloadLocations = async () => {
    setLoading(true);
    const d = await fetch(`/api/closing-stock/locations?date=${date}`).then(r => r.json());
    setLocations(d.locations || []);
    setTotals(d.totals || { locations: 0, items: 0, counted: 0 });
    setLoading(false);
  };
  useEffect(() => { reloadLocations(); /* eslint-disable-next-line */ }, [date]);

  const openLocation = async (loc: string) => {
    setActive(loc);
    setItemsLoading(true);
    setEntries({});
    setSavedFlash('');
    const qs = new URLSearchParams({ date, location: loc === '— Unassigned —' ? '__unassigned__' : loc });
    const d = await fetch(`/api/closing-stock/by-location?${qs}`).then(r => r.json());
    setItems(d.items || []);
    setItemsLoading(false);
  };

  // Reset filters when switching to a different storage location
  useEffect(() => { setCategoryFilter(''); setItemSearch(''); }, [active]);

  // List of distinct categories present in the current location, with item counts.
  // Powers the chip strip above the count table. Counts respect the search box
  // and the "uncounted only" toggle so the chip labels show what you'd actually see.
  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    const q = itemSearch.trim().toLowerCase();
    for (const i of items) {
      if (filterUncountedOnly && i.today_count != null) continue;
      if (q && !i.name.toLowerCase().includes(q) && !(i.sku || '').toLowerCase().includes(q)) continue;
      const k = i.super_category || i.category || 'Uncategorised';
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].map(([name, count]) => ({ name, count }))
                          .sort((a, b) => b.count - a.count);
  }, [items, filterUncountedOnly, itemSearch]);

  const visibleItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    return items.filter(i => {
      if (filterUncountedOnly && i.today_count != null) return false;
      if (categoryFilter && (i.super_category || i.category || 'Uncategorised') !== categoryFilter) return false;
      if (q && !i.name.toLowerCase().includes(q) && !(i.sku || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, filterUncountedOnly, categoryFilter, itemSearch]);

  const pendingEntries = useMemo(
    () => Object.entries(entries).filter(([, v]) => v !== '' && !isNaN(Number(v))),
    [entries]
  );

  const saveAll = async () => {
    if (pendingEntries.length === 0) return;
    setSaving(true);
    try {
      const payload = pendingEntries.map(([material_id, raw]) => {
        const it = items.find(x => x.id === material_id);
        // Convert from purchase units → recipe units when pack_size > 1
        const physical = Number(raw) * (it && it.pack_size && it.pack_size > 1 ? it.pack_size : 1);
        return { material_id, physical_stock: physical };
      });
      const r = await api('/api/closing-stock', {
        method: 'POST',
        body: { date, items: payload, adjust_stock: adjustStock },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(j.error || 'Save failed');
      } else {
        setSavedFlash(`✓ Saved ${j.success} count${j.success === 1 ? '' : 's'} for "${active}"`);
        setEntries({});
        // Refresh both detail and the location summary
        await openLocation(active!);
        await reloadLocations();
        setTimeout(() => setSavedFlash(''), 4000);
      }
    } finally { setSaving(false); }
  };

  // Detail view
  if (active) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-3">
          <button onClick={() => { setActive(null); setItems([]); setEntries({}); }}
                  className="text-[#6B5744] hover:text-[#af4408] flex items-center gap-1 text-sm">
            <ChevronLeft size={16} /> Back to locations
          </button>
        </div>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 flex items-center gap-3 flex-wrap">
          <MapPin className="text-[#af4408]" size={22} />
          <div className="flex-1">
            <div className="text-lg font-semibold text-[#2D1B0E]">{active}</div>
            <div className="text-xs text-[#8B7355]">
              Counting on <strong>{date}</strong> · {items.length} item{items.length === 1 ? '' : 's'} in this area
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-[#6B5744]">
            <input type="checkbox" checked={filterUncountedOnly} onChange={e => setFilterUncountedOnly(e.target.checked)} />
            Only show un-counted
          </label>
          {/* Admin-only — store managers must not be able to one-click overwrite
              system stock without physically counting. */}
          {isAdmin && (
            <label className="flex items-center gap-1.5 text-xs text-[#6B5744]" title="Admin-only: set system stock to physical count and write an inventory adjustment line">
              <input type="checkbox" checked={adjustStock} onChange={e => setAdjustStock(e.target.checked)} />
              Adjust system stock to match
            </label>
          )}
          <button onClick={saveAll} disabled={saving || pendingEntries.length === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#933807] text-white rounded text-sm disabled:opacity-40">
            {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
            Save {pendingEntries.length > 0 ? `(${pendingEntries.length})` : 'All'}
          </button>
        </div>

        {savedFlash && (
          <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl px-4 py-2 text-sm flex items-center gap-2">
            <CheckCircle2 size={16} /> {savedFlash}
          </div>
        )}

        {/* Search + category chips — narrow the count table when an area has
            many items (e.g. dry store with 200+ groceries). Counts on chips
            update live based on the search box. */}
        {items.length > 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl px-4 py-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <input type="text" value={itemSearch}
                     onChange={e => setItemSearch(e.target.value)}
                     placeholder="Search by item name or SKU…"
                     className="flex-1 px-3 py-1.5 border border-[#D4B896] rounded-lg bg-[#FFF8F0] text-sm" />
              {itemSearch && (
                <button onClick={() => setItemSearch('')}
                        className="text-xs text-[#af4408] hover:underline whitespace-nowrap">clear</button>
              )}
              <span className="text-xs text-[#8B7355] whitespace-nowrap">
                {visibleItems.length} of {items.length}
              </span>
            </div>
            {categoryCounts.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                <button onClick={() => setCategoryFilter('')}
                        className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                          !categoryFilter ? 'bg-[#af4408] text-white'
                                          : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>
                  All <span className="opacity-70">({categoryCounts.reduce((s, c) => s + c.count, 0)})</span>
                </button>
                {categoryCounts.map(c => {
                  const active = categoryFilter === c.name;
                  return (
                    <button key={c.name}
                            onClick={() => setCategoryFilter(active ? '' : c.name)}
                            className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                              active ? 'bg-[#af4408] text-white'
                                     : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>
                      {c.name} <span className="opacity-70">({c.count})</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          {itemsLoading ? (
            <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14} /> Loading items…</div>
          ) : visibleItems.length === 0 ? (
            <div className="p-6 text-center text-sm text-[#8B7355]">No items match.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[#FFF1E3] text-[#6B5744]">
                  <tr>
                    <th className="text-left  py-2 px-3 font-medium">Material</th>
                    <th className="text-left  py-2 px-3 font-medium">Category</th>
                    <th className="text-right py-2 px-3 font-medium">System</th>
                    <th className="text-left  py-2 px-3 font-medium w-[200px]">Physical count</th>
                    <th className="text-right py-2 px-3 font-medium">Variance</th>
                    <th className="text-left  py-2 px-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map(it => {
                    const inPurchase = !!(it.pack_size && it.pack_size > 1);
                    const sysDisplay = inPurchase
                      ? `${(it.current_stock / it.pack_size!).toFixed(2)} ${it.purchase_unit}`
                      : `${it.current_stock} ${it.unit}`;
                    const todayDisplay = it.today_count != null
                      ? (inPurchase
                          ? `${(it.today_count / it.pack_size!).toFixed(2)} ${it.purchase_unit}`
                          : `${it.today_count} ${it.unit}`)
                      : null;
                    const isLow = (it.current_stock || 0) < (it.reorder_level || 0);
                    const cadenceTag = it.closing_cadence && !['monthly', 'none', ''].includes(String(it.closing_cadence).toLowerCase());
                    return (
                      <tr key={it.id} className={`border-t border-[#E8D5C4]/50 ${isLow ? 'bg-red-50/30' : ''}`}>
                        <td className="py-1.5 px-3">
                          <div className="font-medium text-[#2D1B0E]">{it.name}</div>
                          <div className="flex gap-1.5 mt-0.5 items-center">
                            <span className="text-[10px] font-mono text-[#8B7355]">{it.sku || '·'}</span>
                            {cadenceTag && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-[#FFF1E3] text-[#6B5744] uppercase">{it.closing_cadence}</span>
                            )}
                            {isLow && <span className="text-[9px] px-1 py-0.5 rounded bg-red-100 text-red-700">low</span>}
                          </div>
                        </td>
                        <td className="py-1.5 px-3 text-[10px] text-[#6B5744]">
                          {it.super_category || it.category || '—'}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono">{sysDisplay}</td>
                        <td className="py-1.5 px-3">
                          <div className="flex items-center gap-1">
                            <input
                              type="number" step="any" min={0}
                              value={entries[it.id] ?? (it.today_count != null
                                ? (inPurchase ? (it.today_count / it.pack_size!).toFixed(2) : String(it.today_count))
                                : '')}
                              onChange={e => setEntries(p => ({ ...p, [it.id]: e.target.value }))}
                              placeholder={inPurchase ? `count in ${it.purchase_unit}` : `count in ${it.unit}`}
                              className="w-32 px-2 py-1 border border-[#D4B896] rounded text-xs text-right font-mono bg-white focus:outline-none focus:ring-1 focus:ring-[#af4408]"
                            />
                            <span className="text-[10px] text-[#8B7355]">{inPurchase ? it.purchase_unit : it.unit}</span>
                          </div>
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono">
                          {(() => {
                            const raw = entries[it.id];
                            const phys = raw !== undefined && raw !== '' && !isNaN(Number(raw))
                              ? Number(raw) * (inPurchase ? it.pack_size! : 1)
                              : it.today_count;
                            if (phys == null) return <span className="text-[#8B7355]">—</span>;
                            const v = Math.round((phys - it.current_stock) * 1000) / 1000;
                            const tone = v < 0 ? 'text-amber-800' : v > 0 ? 'text-blue-800' : 'text-emerald-700';
                            return <span className={tone}>{v > 0 ? '+' : ''}{v} {it.unit}</span>;
                          })()}
                        </td>
                        <td className="py-1.5 px-3">
                          {it.today_count != null ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700"
                                  title={it.today_by ? `By ${it.today_by}` : ''}>
                              ✓ counted: {todayDisplay}
                            </span>
                          ) : entries[it.id] ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">↻ unsaved</span>
                          ) : (
                            <span className="text-[10px] text-[#8B7355]">pending</span>
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
      </div>
    );
  }

  // Locations grid view
  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3">
        <MapPin className="text-[#af4408]" size={24} />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Closing Stock by Location</h1>
          <p className="text-xs text-[#8B7355]">
            Pick a storage area, count the items there, save in one go. Set <code>storage_location</code> per material via{' '}
            <a href="/inventory" className="text-[#af4408] underline">Inventory</a>.
          </p>
        </div>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Date
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
                 className="px-2 py-1.5 border border-[#D4B896] rounded text-sm" />
        </label>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Locations</div>
          <div className="text-2xl font-semibold text-[#2D1B0E] mt-1">{totals.locations}</div>
        </div>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Total items</div>
          <div className="text-2xl font-semibold text-[#2D1B0E] mt-1">{totals.items}</div>
        </div>
        <div className="bg-white border border-emerald-200 rounded-xl p-4">
          <div className="text-[10px] uppercase tracking-wide text-emerald-700">Counted today</div>
          <div className="text-2xl font-semibold text-emerald-800 mt-1">
            {totals.counted}
            <span className="text-sm font-normal text-[#8B7355]"> / {totals.items}</span>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="p-10 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14} /> Loading locations…</div>
      ) : locations.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center text-sm text-[#8B7355]">
          No materials found. Make sure storage locations are set on the inventory page.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {locations.map(l => {
            const pct = l.items > 0 ? Math.round((l.counted_today / l.items) * 100) : 0;
            const done = l.items > 0 && l.counted_today === l.items;
            return (
              <button key={l.location} onClick={() => openLocation(l.location)}
                      className={`text-left bg-white border rounded-xl p-4 hover:border-[#af4408] hover:shadow transition ${done ? 'border-emerald-300' : 'border-[#E8D5C4]'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Package size={16} className="text-[#af4408] shrink-0" />
                    <div className="font-semibold text-[#2D1B0E] truncate">{l.location}</div>
                  </div>
                  {done && <CheckCircle2 size={18} className="text-emerald-600 shrink-0" />}
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs text-[#6B5744]">
                  <span><strong className="text-[#2D1B0E]">{l.items}</strong> items</span>
                  <span className="text-[#D4B896]">·</span>
                  <span className="text-emerald-700">{l.counted_today} counted</span>
                  {l.low_stock > 0 && <>
                    <span className="text-[#D4B896]">·</span>
                    <span className="text-red-700">{l.low_stock} low</span>
                  </>}
                </div>
                <div className="mt-2 h-1.5 bg-[#FFF1E3] rounded-full overflow-hidden">
                  <div className={`h-full transition-all ${done ? 'bg-emerald-500' : 'bg-[#af4408]'}`}
                       style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-1 text-[10px] text-[#8B7355]">{pct}% complete</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
