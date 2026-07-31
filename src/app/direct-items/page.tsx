'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowUpDown, CheckCircle2, Droplets, Package,
  Search, TrendingDown, Link2, Link2Off, Loader2, Save, X as XIcon, Trash2, RotateCcw,
  Download, Upload, MoonStar, UtensilsCrossed, FileWarning,
} from 'lucide-react';
import { api } from '@/lib/api';
import { displayQty, type PackMeta } from '@/lib/pack-units';

function formatCurrency(v: number): string {
  return '₹' + (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
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

/** The raw material a row is actually LINKED to (the saved mapping), with the
 *  pack meta the purchase-unit display layer needs. */
interface MaterialLink {
  material_id: string;
  material_name: string;
  sku: string;
  /** RECIPE unit — the stored basis. Never printed as a bare lead. */
  unit: string;
  purchase_unit: string;
  pack_size: number;
  case_size: number;
  average_price: number;
  current_stock_recipe: number;
}

interface MenuItemLink {
  id: string;
  name: string;
  category: string;
  pos_id: string;
  material_id: string | null;
  is_active: boolean;
  /** 'pos_id' is the stronger signal (survives a menu rename). */
  matched_by: 'pos_id' | 'name';
}

interface DirectItem {
  item_name: string;
  category: string | null;
  department: 'Bar' | 'Beverages' | null;
  dismissed?: number | boolean;
  qty_sold: number;
  revenue: number;
  line_count: number;
  nc_qty: number;
  nc_cost: number;
  sold_per_unit_ml: number | null;
  matched: null | {
    material_id?: string;
    material_name?: string;
    /** The saved-mapping rows carry the short shape {id, name, unit}. */
    id?: string;
    name?: string;
    unit?: string;
    per_unit_ml?: number | null;
    avg_price?: number;
    current_stock?: number;
    purchased_qty?: number;
    purchase_count?: number;
    score?: number;
  };
  /** Pack meta of the material `matched`'s figures are expressed in. */
  matched_meta?: PackMeta | null;
  sold_in_mat_unit?: number;
  conversion_note?: string;
  leakage_qty?: number;
  leakage_value?: number;
  qty_per_unit?: number;
  linked_material_id?: string | null;
  reviewed?: boolean;
  /** A saved mapping the sales pass never produced (the recovery block). */
  no_recent_sales?: boolean;
  /** No sales at all in this window — true for the recovery rows AND for the
   *  manual block's rows, which are the same state. This is what the row
   *  renders on; `no_recent_sales` is the narrower subset. */
  zero_sales?: boolean;
  manual?: boolean;
  // ── the chain, both ways ──
  material_link?: MaterialLink | null;
  material_missing?: boolean;
  menu_items?: MenuItemLink[];
  menu_item_count?: number;
  menu_item_missing?: boolean;
  link_source?: 'direct_item_links' | 'menu_items' | null;
  has_saved_mapping?: boolean;
  suggestion_differs?: boolean;
}

interface MaterialLite { id: string; name: string; unit: string; sku?: string; }

interface Payload {
  count: number; matched: number; unmatched: number;
  total_leakage_value: number; items: DirectItem[];
  /** Saved mappings the sales window could not show at all (recovery block). */
  saved_without_sales?: number;
  /** Every row with no sales in this window (recovery + manual rows). */
  no_sales_rows?: number;
  material_missing?: number;
  menu_item_missing?: number;
}

/** A row with no sales in this window, whichever block produced it. */
const isNoSales = (i: DirectItem) => !!(i.zero_sales ?? (i.no_recent_sales || (!i.qty_sold && !i.line_count)));

/* ── import preview types ─────────────────────────────────────────────────── */
interface PreviewChange { field: string; from: string; to: string }
interface PreviewUpdate { line: number; item_name: string; is_new: boolean; changes: PreviewChange[] }
interface PreviewError  { line: number; item_name: string; reason: string }
interface ImportPreview {
  mode: 'preview' | 'apply';
  total_rows: number;
  will_update: number;
  unchanged: number;
  errors: number;
  new_mappings: number;
  updates?: PreviewUpdate[];
  error_rows?: PreviewError[];
  applied?: number;
  menu_items_updated?: number;
}

/**
 * A raw-material quantity. PURCHASE-UNIT LOCK (src/lib/pack-units.ts): every
 * material quantity on this page LEADS with the purchase unit (BTL / kg / L) and
 * carries the stored recipe figure only as the small declared hint. The stored
 * numbers are recipe-basis, so the conversion happens here, through the shared
 * helper — never re-derived locally.
 */
function MatQty({ recipeQty, meta, className = '' }:
  { recipeQty: number | null | undefined; meta?: PackMeta | null; className?: string }) {
  if (recipeQty === null || recipeQty === undefined || !Number.isFinite(Number(recipeQty))) {
    return <span className="text-[#B8A590]">-</span>;
  }
  const d = displayQty(Number(recipeQty), meta || {});
  return (
    <span className={`inline-block ${className}`}>
      <span className="block whitespace-nowrap">{d.primary}</span>
      {d.hint && <span className="block text-[9px] text-[#B8A590] whitespace-nowrap">{d.hint}</span>}
    </span>
  );
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
  // Both bulk buttons are Admin/Manager/HOD only server-side (the sheet carries
  // per-item qty_sold and revenue). Same shape the Sales Dashboard uses for its
  // gated tab — the server is the gate, this only avoids offering a button that
  // is going to 403.
  const [me, setMe] = useState<{ role?: string; is_head_chef?: boolean } | null>(null);
  const isMgmt = !!me && (me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef);
  // Chain filters — additive, default off so the page opens exactly as before.
  const [chainFilter, setChainFilter] = useState<'' | 'no_sales' | 'no_material' | 'no_menu_item'>('');
  // Bulk CSV
  const [importOpen, setImportOpen] = useState(false);
  const [importFileName, setImportFileName] = useState('');
  const [importCsv, setImportCsv] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importBusy, setImportBusy] = useState<'' | 'preview' | 'apply'>('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importDone, setImportDone] = useState<ImportPreview | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = () => {
    setLoading(true); setError(null);
    fetch(`/api/direct-items?min_sold=${minSold}&limit=500${showDismissed ? '&include_dismissed=1' : ''}`)
      .then(async r => r.ok ? r.json() : Promise.reject(await r.text()))
      .then(setData)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [minSold, showDismissed]);
  // Fails closed: on any error `me` stays null, isMgmt stays false, and the two
  // bulk buttons simply do not render.
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null)).catch(() => {});
  }, []);

  // Toggle dismissed flag for one item. Doesn't touch sales — just marks the
  // direct_item_links row so the report stops surfacing this name.
  //
  // SENDS ONLY `dismissed`. It used to also send `material_id: null` and
  // `qty_per_unit: 1` — values it had no business asserting — and because the
  // write is a full overwrite of the row, one click on Dismiss unlinked the
  // material AND reset the quantity. "Budweiser Bucket of 4" silently became an
  // unlinked item worth 1 bottle a sale. The server now preserves any field a
  // caller omits, and this caller omits everything it does not mean to change.
  const setDismissed = async (itemName: string, value: boolean) => {
    setDismissingRow(itemName);
    try {
      const r = await api('/api/direct-items', {
        method: 'POST',
        body: { item_name: itemName, dismissed: value },
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
    setEditMatId(i.linked_material_id || i.material_link?.material_id || i.matched?.material_id || i.matched?.id || '');
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

  /* ── bulk CSV ───────────────────────────────────────────────────────────── */

  // The export is deliberately NOT "what is on screen": it comes from
  // /api/direct-items/export, which unions direct_item_links + menu_items +
  // sales, so the saved mappings with no recent sales are in the file. Exporting
  // the filtered table would repeat the original bug.
  //
  // Fetched as a blob rather than `window.location.href = …`: a plain navigation
  // to a 403 replaces the whole page with raw JSON, so a staff user who somehow
  // reached the button would lose the screen instead of seeing a message.
  const downloadCsv = async () => {
    try {
      const r = await fetch('/api/direct-items/export?min_sold=0');
      if (!r.ok) {
        alert((await r.json().catch(() => ({}))).error || 'Download failed');
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'direct-items.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      alert('Download failed');
    }
  };

  const resetImport = () => {
    setImportCsv(''); setImportFileName(''); setPreview(null);
    setImportError(null); setImportDone(null); setImportBusy('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const onPickFile = async (f: File | null) => {
    resetImport();
    if (!f) return;
    setImportFileName(f.name);
    const text = await f.text();
    setImportCsv(text);
    await runImport(text, 'preview');
  };

  const runImport = async (csv: string, mode: 'preview' | 'apply') => {
    setImportBusy(mode); setImportError(null);
    try {
      const r = await api('/api/direct-items/import', { method: 'POST', body: { csv, mode } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setImportError(j.error || `Import failed (HTTP ${r.status})`); return; }
      if (mode === 'preview') setPreview(j);
      else { setImportDone(j); setPreview(null); load(); }
    } catch (e: any) {
      setImportError(String(e?.message || e));
    } finally { setImportBusy(''); }
  };

  const filteredMaterials = useMemo(() => {
    if (!matSearch.trim()) return materials.slice(0, 50);
    const s = matSearch.toLowerCase();
    return materials
      .filter(m => m.name.toLowerCase().includes(s) || (m.sku || '').toLowerCase().includes(s))
      .slice(0, 50);
  }, [materials, matSearch]);

  /** Search / matched / unmatched / chain — shared by the list and the counts so
   *  the dropdown labels can never disagree with the table. */
  const applyFilters = (list: DirectItem[], opts: { chain?: boolean } = {}) => {
    let out = list;
    if (search) {
      const s = search.toLowerCase();
      out = out.filter(i =>
        i.item_name.toLowerCase().includes(s) ||
        (i.material_link?.material_name.toLowerCase().includes(s) ?? false) ||
        (i.material_link?.sku?.toLowerCase().includes(s) ?? false) ||
        (i.matched?.material_name?.toLowerCase().includes(s) ?? false) ||
        (i.menu_items || []).some(m => m.name.toLowerCase().includes(s))
      );
    }
    if (showOnly === 'matched')   out = out.filter(i => i.matched || i.material_link);
    if (showOnly === 'unmatched') out = out.filter(i => !i.matched && !i.material_link);
    if (opts.chain !== false) {
      if (chainFilter === 'no_sales')      out = out.filter(isNoSales);
      if (chainFilter === 'no_material')   out = out.filter(i => i.material_missing);
      if (chainFilter === 'no_menu_item')  out = out.filter(i => i.menu_item_missing);
    }
    return out;
  };

  const items = useMemo(() => {
    if (!data) return [];
    let list = applyFilters(data.items);
    if (departmentFilter) list = list.filter(i => i.department === departmentFilter);
    list = [...list];
    if (sortBy === 'revenue')    list.sort((a, b) => b.revenue - a.revenue);
    if (sortBy === 'qty')        list.sort((a, b) => b.qty_sold - a.qty_sold);
    if (sortBy === 'leakage_abs')list.sort((a, b) => Math.abs(b.leakage_value || 0) - Math.abs(a.leakage_value || 0));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, search, showOnly, departmentFilter, sortBy, chainFilter]);

  // Compute counts per department (Bar / Beverages) honouring the search +
  // matched/unmatched filter so the dropdown labels show live numbers.
  const departmentCounts = useMemo(() => {
    const counts = { Bar: 0, Beverages: 0, total: 0 };
    if (!data) return counts;
    for (const i of applyFilters(data.items)) {
      if (i.department === 'Bar')        counts.Bar++;
      else if (i.department === 'Beverages') counts.Beverages++;
      counts.total++;
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, search, showOnly, chainFilter]);

  /** Chain-filter chip counts — computed WITHOUT the chain filter itself so the
   *  numbers stay stable while one of them is active. */
  const chainCounts = useMemo(() => {
    const c = { no_sales: 0, no_material: 0, no_menu_item: 0 };
    if (!data) return c;
    for (const i of applyFilters(data.items, { chain: false })) {
      if (isNoSales(i))       c.no_sales++;
      if (i.material_missing) c.no_material++;
      if (i.menu_item_missing) c.no_menu_item++;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, search, showOnly]);

  // Summary tiles.
  //
  // THE MONEY TILES ARE COMPUTED OVER ROWS THAT ACTUALLY SOLD. A row with no
  // sales in this window carries revenue 0 and leakage 0, so today it adds
  // nothing either way — but reducing over `withSales` states that intent in
  // code rather than relying on the zeros staying zero. "Matched items" keeps
  // counting every matched row exactly as it did before (no behaviour change);
  // the rows with no sales get their own tile, because the owner needs to see
  // that they exist rather than have them quietly folded into a total.
  const summary = useMemo(() => {
    if (!data) return null;
    const matched   = data.items.filter(i => i.matched);
    const withSales = matched.filter(i => !isNoSales(i));
    const totalRev  = withSales.reduce((a, b) => a + (b.revenue || 0), 0);
    const shortage  = withSales.filter(i => (i.leakage_qty || 0) < 0).reduce((a, b) => a + Math.abs(b.leakage_value || 0), 0);
    const overstock = withSales.filter(i => (i.leakage_qty || 0) > 0).reduce((a, b) => a + Math.abs(b.leakage_value || 0), 0);
    return {
      matched: matched.length, withSales: withSales.length, totalRev, shortage, overstock,
      noSales: data.no_sales_rows ?? data.items.filter(isNoSales).length,
      /** The subset that had no report row at all before the recovery block. */
      recovered: data.saved_without_sales ?? data.items.filter(i => i.no_recent_sales).length,
      materialMissing: data.material_missing ?? data.items.filter(i => i.material_missing).length,
      menuMissing: data.menu_item_missing ?? data.items.filter(i => i.menu_item_missing).length,
    };
  }, [data]);

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-[110rem] mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Direct Items — Purchase vs Sales</h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Items sold as-is from a purchased raw material (bottled beer, soft drinks, liquor pegs).
              Surfaces leakage where inventory doesn&apos;t explain recorded sales.
            </p>
          </div>
          {isMgmt && (
            <div className="flex items-center gap-2">
              <button onClick={downloadCsv}
                      className="px-3 py-2 text-xs font-semibold rounded-lg bg-white border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3] inline-flex items-center gap-1.5">
                <Download className="w-3.5 h-3.5" /> Download CSV
              </button>
              <button onClick={() => { resetImport(); setImportOpen(true); }}
                      className="px-3 py-2 text-xs font-semibold rounded-lg bg-[#af4408] text-white hover:bg-[#8f3606] inline-flex items-center gap-1.5">
                <Upload className="w-3.5 h-3.5" /> Upload CSV
              </button>
            </div>
          )}
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

        {/* Saved-but-unsold banner. These rows are the ones that used to be
            invisible — the report is built from sales, and a mapping with no
            sales in the window has none. They are real saved work, so they are
            listed, flagged, and kept out of every money total. */}
        {!!summary?.noSales && (
          <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3 text-xs text-indigo-900 flex gap-2 items-start">
            <MoonStar className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">{summary.noSales} saved mapping{summary.noSales === 1 ? '' : 's'} with no sales in this window</span>
              {' '}(of {data?.count ?? 0} rows;{' '}
              {summary.recovered} of them had no row on this report at all before the recovery fix).{' '}
              They are listed below tagged <span className="font-semibold">no sales in this window</span>, with their
              sales cells left as an em-dash rather than a misleading zero — the mapping is saved, the item simply did
              not sell in the window (or its POS category is outside Bar / Beverages). They contribute nothing to the
              revenue and leakage totals.
              <button onClick={() => setChainFilter(chainFilter === 'no_sales' ? '' : 'no_sales')}
                      className="ml-1 underline font-semibold">
                {chainFilter === 'no_sales' ? 'Show everything' : 'Show only these'}
              </button>
            </div>
          </div>
        )}

        {/* Filter row */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-[#8B7355]" />
            <input value={search} onChange={e=>setSearch(e.target.value)}
                   placeholder="Search item, menu item, material or SKU…"
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
          {/* Chain filters — the actionable states. */}
          <div className="flex gap-1 bg-[#FFF1E3] rounded-lg p-1">
            {([
              ['', 'All rows', null],
              ['no_sales', 'No sales', chainCounts.no_sales],
              ['no_material', 'No material', chainCounts.no_material],
              ['no_menu_item', 'No menu item', chainCounts.no_menu_item],
            ] as const).map(([v, label, n]) => (
              <button key={v || 'all'} onClick={() => setChainFilter(v as typeof chainFilter)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${chainFilter === v ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-white'}`}>
                {label}{n === null ? '' : ` (${n})`}
              </button>
            ))}
          </div>
        </div>

        {/* Summary tiles */}
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-4">
            <SummaryCard icon={<Link2 className="w-4 h-4" />} label="Matched items" value={String(summary.matched)} color="text-green-700" sub={`${summary.withSales} sold in window`} />
            <SummaryCard icon={<Package className="w-4 h-4" />} label="Revenue (matched)" value={formatCurrency(summary.totalRev)} color="text-[#af4408]" sub="rows with sales only" />
            <SummaryCard icon={<TrendingDown className="w-4 h-4" />} label="Total shortage |₹|" value={formatCurrency(summary.shortage)} color="text-red-600" sub="sales > inventory" />
            <SummaryCard icon={<Droplets className="w-4 h-4" />} label="Total overstock |₹|" value={formatCurrency(summary.overstock)} color="text-amber-700" sub="purchased > sold" />
            <SummaryCard icon={<MoonStar className="w-4 h-4" />} label="Saved, no sales" value={String(summary.noSales)} color="text-indigo-700" sub={`${summary.recovered} recovered by the fix`} />
            <SummaryCard icon={<Link2Off className="w-4 h-4" />} label="No raw material" value={String(summary.materialMissing)} color="text-red-600" sub="nothing to cost against" />
            <SummaryCard icon={<UtensilsCrossed className="w-4 h-4" />} label="No menu item" value={String(summary.menuMissing)} color="text-amber-700" sub="POS can't reach it" />
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
                    <th className="text-left  py-2.5 px-3 font-medium">Sold as (POS item)</th>
                    <th className="text-left  py-2.5 px-3 font-medium">Menu item(s)</th>
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
                    <tr><td colSpan={12} className="py-6 text-center text-[#8B7355] text-xs">No direct items in this view.</td></tr>
                  ) : items.map((i, idx) => {
                    const leakVal = i.leakage_value || 0;
                    const leakQty = i.leakage_qty || 0;
                    const bad = Math.abs(leakVal) > 10000;
                    const sign = leakQty < 0 ? 'text-red-600' : leakQty > 0 ? 'text-amber-700' : 'text-[#6B5744]';
                    const isEditing = editingRow === i.item_name;
                    const pickedMat = materials.find(m => m.id === editMatId);
                    const noSales = isNoSales(i);
                    // The pack meta each number belongs to. `matched` figures are
                    // in the MATCHED material's basis; the stock read-back for a
                    // no-sales row comes from the LINKED material.
                    const matchedMeta: PackMeta = i.matched_meta || { unit: i.matched?.unit };
                    const linkMeta: PackMeta | null = i.material_link
                      ? { unit: i.material_link.unit, purchase_unit: i.material_link.purchase_unit,
                          pack_size: i.material_link.pack_size, case_size: i.material_link.case_size }
                      : null;
                    // The row is LABELLED with the saved link but the figures are
                    // enriched against `matched`. When those are two different
                    // materials every figure carries this mark, so nobody reads a
                    // number as belonging to the name printed next to it.
                    const figMark = (i.suggestion_differs && i.matched)
                      ? <SuggestedFigureMark name={i.matched.material_name || i.matched.name} />
                      : null;
                    return (
                      <tr key={idx} className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 align-top ${noSales ? 'bg-indigo-50/40' : ''}`}>
                        <td className="py-2 px-3 text-[#2D1B0E] text-xs font-medium">
                          {i.item_name}
                          {i.category && <span className="ml-2 text-[10px] text-[#8B7355] bg-[#FFF8F0] px-1.5 py-0.5 rounded">{i.category}</span>}
                          {noSales && (
                            <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-indigo-800 bg-indigo-100 border border-indigo-200 px-1.5 py-0.5 rounded whitespace-nowrap">
                              <MoonStar className="w-2.5 h-2.5" /> no sales in this window
                            </span>
                          )}
                          {i.has_saved_mapping && (
                            <span className="ml-2 text-[9px] text-emerald-800 bg-emerald-50 border border-emerald-200 px-1 py-0.5 rounded">saved</span>
                          )}
                        </td>

                        {/* ── MENU ITEM(S) — the other half of the chain ── */}
                        <td className="py-2 px-3 text-xs">
                          {(i.menu_items && i.menu_items.length > 0) ? (
                            <div className="flex flex-col gap-0.5">
                              {i.menu_items.slice(0, 3).map(m => (
                                <span key={m.id} className="flex items-center gap-1 whitespace-nowrap">
                                  <UtensilsCrossed className="w-3 h-3 text-[#8B7355] shrink-0" />
                                  <span className={m.is_active ? 'text-[#2D1B0E]' : 'text-[#8B7355] line-through'}>{m.name}</span>
                                  <span className="text-[9px] text-[#8B7355]">
                                    {m.matched_by === 'pos_id' ? `· POS ${m.pos_id}` : '· by name'}
                                  </span>
                                  {!m.material_id && (
                                    <span className="text-[9px] text-amber-700 bg-amber-50 border border-amber-200 px-1 rounded">no material</span>
                                  )}
                                </span>
                              ))}
                              {i.menu_items.length > 3 && (
                                <span className="text-[10px] text-[#8B7355]">+{i.menu_items.length - 3} more</span>
                              )}
                            </div>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] text-amber-800 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                              <FileWarning className="w-3 h-3" /> No menu item — POS can&apos;t reach this
                            </span>
                          )}
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
                          ) : i.material_link ? (
                            /* The SAVED link — what the mapping actually is. */
                            <div className="flex flex-col">
                              <button onClick={() => startEdit(i)} className="text-[#2D1B0E] hover:text-[#af4408] text-left font-medium">
                                {i.material_link.material_name}
                              </button>
                              <span className="text-[10px] text-[#8B7355] flex items-center gap-1 flex-wrap">
                                <CheckCircle2 className="w-3 h-3 text-green-600" />
                                {i.material_link.sku && <span className="font-mono">{i.material_link.sku}</span>}
                                <span>· {i.material_link.purchase_unit || i.material_link.unit}</span>
                                {i.link_source === 'menu_items' && <span className="text-amber-700">· via menu item</span>}
                              </span>
                              {i.suggestion_differs && (
                                /* Says which material the ≠ figures on this row belong to,
                                   so the mark is readable without hovering it. */
                                <span className="text-[9px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1 mt-0.5">
                                  name-match suggests {i.matched?.material_name || i.matched?.name} — review
                                  {i.matched && <> · figures marked <span className="font-semibold">≠</span> are for it, not for the link</>}
                                </span>
                              )}
                            </div>
                          ) : i.matched ? (
                            /* No saved link, only the heuristic suggestion. */
                            <div className="flex flex-col">
                              <button onClick={() => startEdit(i)} className="text-[#2D1B0E] hover:text-[#af4408] text-left">
                                {i.matched.material_name || i.matched.name}
                              </button>
                              <span className="text-[10px] text-amber-800 flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" />
                                suggestion{Number.isFinite(Number(i.matched.score)) ? ` ${Math.round(Number(i.matched.score) * 100)}%` : ''} — not saved
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
                              {/* The note's unit is the suggestion's unit, not the link's. */}
                              {figMark}
                              {(i.qty_per_unit && i.qty_per_unit !== 1) && (
                                <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-purple-100 text-purple-800 font-semibold">×{i.qty_per_unit}</span>
                              )}
                              <span className="text-[9px] text-[#8B7355]">✎</span>
                            </button>
                          </td>
                        )}
                        {/* SALES-DERIVED cells. On a no-sales row these are an
                            em-dash, not a zero: "0 sold, 0 revenue, 0 leakage,
                            reconciled" reads as a dead item that balances, when
                            the truth is that this window has nothing to say
                            about it. MATERIAL-derived cells (Purchased, Stock)
                            stay populated — they are facts about the material
                            and are true whether or not anything sold. */}
                        <td className="py-2 px-3 text-xs text-right font-mono">
                          {noSales ? <NoSalesCell /> : formatQty(i.qty_sold)}
                        </td>
                        <td className="py-2 px-3 text-xs text-right font-mono text-green-700">
                          {noSales ? <NoSalesCell /> : formatCurrency(i.revenue)}
                        </td>
                        <td className="py-2 px-3 text-xs text-right font-mono">
                          <MatQty recipeQty={i.matched ? i.matched.purchased_qty : null} meta={matchedMeta} />
                          {figMark}
                        </td>
                        <td className="py-2 px-3 text-xs text-right font-mono">
                          {noSales ? <NoSalesCell />
                            : <>
                                <MatQty recipeQty={i.matched ? (i.sold_in_mat_unit ?? 0) : null} meta={matchedMeta} />
                                {figMark}
                              </>}
                        </td>
                        <td className="py-2 px-3 text-xs text-right font-mono">
                          {/* Stock is a property of the MATERIAL, so it is honest even
                              for a row with no sales — read it off the linked material. */}
                          {i.matched?.current_stock !== undefined
                            ? <>
                                <MatQty recipeQty={i.matched.current_stock} meta={matchedMeta} />
                                {figMark}
                              </>
                            /* The fallback reads the LINKED material, so it needs no mark. */
                            : <MatQty recipeQty={i.material_link ? i.material_link.current_stock_recipe : null} meta={linkMeta} />}
                        </td>
                        <td className={`py-2 px-3 text-xs text-right font-mono font-semibold ${noSales ? '' : sign}`}>
                          {noSales ? <NoSalesCell />
                            : i.matched ? <><MatQty recipeQty={leakQty} meta={matchedMeta} />{figMark}</> : <span className="text-[#B8A590]">-</span>}
                        </td>
                        <td className={`py-2 px-3 text-xs text-right font-mono font-semibold ${noSales ? '' : sign} ${bad && !noSales ? 'bg-red-50/40' : ''}`}>
                          {noSales ? <NoSalesCell />
                            : i.matched ? <>{(leakVal > 0 ? '+' : '') + formatCurrency(leakVal)}{figMark}</> : '-'}
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
          Ranked matching uses token-anchor + pack-volume heuristics — a <em>suggestion</em> until you save it.
          Material quantities lead in the <strong>purchase unit</strong> (BTL / kg / L); the small grey figure
          underneath is the stored recipe amount. To fix many mappings at once, use
          <strong className="mx-1">Download CSV</strong>→ edit → <strong className="mx-1">Upload CSV</strong>;
          the import resolves materials by SKU (then exact name) only, never by guesswork.
        </p>
      </div>

      {importOpen && (
        <ImportDialog
          fileRef={fileRef}
          fileName={importFileName}
          csv={importCsv}
          preview={preview}
          done={importDone}
          busy={importBusy}
          error={importError}
          onPick={onPickFile}
          onApply={() => runImport(importCsv, 'apply')}
          onReset={resetImport}
          onClose={() => { setImportOpen(false); resetImport(); }}
        />
      )}
    </div>
  );
}

/** A sales cell on a row that had no sales in this window. An em-dash with a
 *  title, never a 0 — a zero here is a claim about the item, and we don't have
 *  one to make. */
function NoSalesCell() {
  return <span className="text-[#B8A590]" title="No sales in this window — the mapping is saved, nothing sold">—</span>;
}

/** Marks a figure that was computed against the name-match SUGGESTION while the
 *  row is labelled with the saved link — two different materials. The whole row
 *  otherwise reads as one coherent fact about one material, so every number that
 *  belongs to the other one has to say so on its own face; a manager acting on
 *  an unmarked figure would be attributing this material's purchases, stock and
 *  rupees to the name printed beside them. */
function SuggestedFigureMark({ name }: { name?: string }) {
  return (
    <span
      className="ml-0.5 align-super text-[9px] text-amber-700 cursor-help font-semibold"
      title={`This figure is for the name-match suggestion${name ? ` "${name}"` : ''} — NOT for the linked material named in this row.`}
    >≠</span>
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

/**
 * Bulk CSV dialog. Nothing is written until the preview has been seen and the
 * user presses Apply: the file is POSTed once in `preview` mode (read-only,
 * returns the counts and every error with its line number) and a second time in
 * `apply` mode. Rows that error are reported and skipped — never written as a
 * blank material, which would silently delete a good mapping.
 */
function ImportDialog({
  fileRef, fileName, csv, preview, done, busy, error, onPick, onApply, onReset, onClose,
}: {
  fileRef: React.RefObject<HTMLInputElement | null>;
  fileName: string;
  csv: string;
  preview: ImportPreview | null;
  done: ImportPreview | null;
  busy: '' | 'preview' | 'apply';
  error: string | null;
  onPick: (f: File | null) => void;
  onApply: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl my-8 border border-[#E8D5C4]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#E8D5C4]">
          <h2 className="text-lg font-bold text-[#af4408] flex items-center gap-2">
            <Upload className="w-4 h-4" /> Bulk upload direct-item mappings
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#FFF1E3] text-[#6B5744]">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-xs text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 space-y-1">
            <p>
              Upload the file you got from <strong>Download CSV</strong>. Only the first five columns are read:
              <code className="mx-1 px-1 bg-white rounded">item_name</code>
              <code className="mx-1 px-1 bg-white rounded">material_sku</code>
              <code className="mx-1 px-1 bg-white rounded">material_name</code>
              <code className="mx-1 px-1 bg-white rounded">qty_per_unit</code>
              <code className="mx-1 px-1 bg-white rounded">dismissed</code>.
              Everything else in the file is context and is ignored.
            </p>
            <p>
              Materials are resolved by <strong>SKU first, then exact name</strong> — never a close match. A row whose
              material can&apos;t be resolved is reported with its line number and skipped, and a blank material cell
              will not clear a mapping that already exists.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={e => onPick(e.target.files?.[0] || null)}
              className="text-xs"
            />
            {fileName && <span className="text-xs text-[#8B7355]">{fileName} · {(csv.length / 1024).toFixed(0)} KB</span>}
            {busy === 'preview' && <span className="text-xs text-[#8B7355] inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Checking…</span>}
          </div>

          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>
          )}

          {done && (
            <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3 space-y-1">
              <p className="font-semibold">
                Applied {done.applied ?? done.will_update} mapping{(done.applied ?? done.will_update) === 1 ? '' : 's'}
                {done.menu_items_updated ? ` · ${done.menu_items_updated} menu item rows relinked` : ''}.
              </p>
              <p className="text-xs">
                {done.unchanged} row{done.unchanged === 1 ? '' : 's'} unchanged
                {done.errors ? ` · ${done.errors} row${done.errors === 1 ? '' : 's'} skipped with errors (listed below)` : ''}.
              </p>
              {!!done.error_rows?.length && <ErrorList rows={done.error_rows} />}
              <div className="pt-1">
                <button onClick={onReset} className="text-xs px-2 py-1 bg-white border border-emerald-300 rounded">Upload another file</button>
              </div>
            </div>
          )}

          {preview && !done && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <PreviewTile label="Will update" value={preview.will_update} tone="text-emerald-700"
                             sub={preview.new_mappings ? `${preview.new_mappings} new` : undefined} />
                <PreviewTile label="Unchanged" value={preview.unchanged} tone="text-[#6B5744]" />
                <PreviewTile label="Errors (skipped)" value={preview.errors} tone={preview.errors ? 'text-red-600' : 'text-[#6B5744]'} />
              </div>

              {!!preview.updates?.length && (
                <div className="border border-[#E8D5C4] rounded-lg overflow-hidden">
                  <div className="px-3 py-1.5 bg-[#FFF1E3] text-[10px] uppercase tracking-wider text-[#6B5744]">
                    Changes to apply
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    <table className="w-full text-xs">
                      <tbody>
                        {preview.updates.map(u => (
                          <tr key={u.line} className="border-t border-[#E8D5C4]/50">
                            <td className="py-1.5 px-3 text-[#8B7355] w-16 align-top">line {u.line}</td>
                            <td className="py-1.5 px-3 font-medium align-top">
                              {u.item_name}
                              {u.is_new && <span className="ml-1 text-[9px] px-1 rounded bg-emerald-100 text-emerald-800">new</span>}
                            </td>
                            <td className="py-1.5 px-3 align-top">
                              {u.changes.map((c, k) => (
                                <div key={k} className="text-[11px]">
                                  <span className="text-[#8B7355]">{c.field}:</span>{' '}
                                  <span className="line-through text-[#B8A590]">{c.from}</span>{' → '}
                                  <span className="text-emerald-800 font-medium">{c.to}</span>
                                </div>
                              ))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {!!preview.error_rows?.length && <ErrorList rows={preview.error_rows} />}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={onApply}
                  disabled={busy !== '' || preview.will_update === 0}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#af4408] text-white hover:bg-[#8f3606] disabled:opacity-40 inline-flex items-center gap-1.5">
                  {busy === 'apply' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  Apply {preview.will_update} update{preview.will_update === 1 ? '' : 's'}
                </button>
                <button onClick={onReset} className="px-3 py-2 text-xs rounded-lg bg-[#FFF1E3] text-[#6B5744]">
                  Choose a different file
                </button>
                {preview.will_update === 0 && (
                  <span className="text-xs text-[#8B7355]">Nothing to apply — this file matches what is already saved.</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewTile({ label, value, sub, tone }: { label: string; value: number; sub?: string; tone: string }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-lg p-3">
      <p className="text-[10px] uppercase tracking-wider text-[#8B7355]">{label}</p>
      <p className={`text-xl font-bold ${tone}`}>{value}</p>
      {sub && <p className="text-[10px] text-[#8B7355]">{sub}</p>}
    </div>
  );
}

function ErrorList({ rows }: { rows: PreviewError[] }) {
  return (
    <div className="border border-red-200 rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 bg-red-50 text-[10px] uppercase tracking-wider text-red-700">
        Rows with errors — reported and skipped, nothing is written for them
      </div>
      <div className="max-h-56 overflow-y-auto">
        <table className="w-full text-xs">
          <tbody>
            {rows.map((e, k) => (
              <tr key={k} className="border-t border-red-100">
                <td className="py-1.5 px-3 text-red-700 w-16 align-top">line {e.line}</td>
                <td className="py-1.5 px-3 font-medium align-top w-64">{e.item_name || <em className="text-[#8B7355]">(blank)</em>}</td>
                <td className="py-1.5 px-3 text-red-800 align-top">{e.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
