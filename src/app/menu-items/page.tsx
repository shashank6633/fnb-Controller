'use client';

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
import TabScroller from '@/components/TabScroller';
import Toggle from '@/components/Toggle';
import {
  Utensils,
  Plus,
  Search,
  Upload,
  Download,
  X,
  Loader2,
  AlertTriangle,
  CheckCircle,
  AlertCircle,
  Edit,
  Trash2,
  FileSpreadsheet,
  ChevronDown,
  MoreVertical,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

function formatCurrency(value: number): string {
  return '₹' + value.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

interface MenuItem {
  id: string;
  name: string;
  category: string;
  station: string;
  item_type: string;
  dietary_tag: string;
  selling_price: number;
  listing_price: number;
  item_code: string;
  tax_value: number;
  cgst_percent: number;
  sgst_percent: number;
  prep_minutes: number;
  is_active: number;
  recipe_id: string | null;
  material_id: string | null;
  source: string;
  notes: string;
  pos_id: string;
  recipe_cost?: number;
  recipe_food_cost_percent?: number;
  material_name?: string;
  material_cost?: number;
}

interface Summary {
  total: number; active: number; inactive: number;
  foods: number; liquors: number; beverages: number;
  withRecipe: number; withMaterial: number;
  noPrice: number; noCategory: number; noStation: number; noDietaryTag: number;
}

const PAGE_SIZE = 25;
const TOP_CATS = 8;   // category chips shown inline before the "All N categories" dropdown

const NEW_ITEM: MenuItem = {
  id: '', name: '', category: '', station: '', item_type: 'foods', dietary_tag: '',
  selling_price: 0, listing_price: 0, item_code: '', tax_value: 5, cgst_percent: 2.5, sgst_percent: 2.5, prep_minutes: 15,
  is_active: 1, recipe_id: null, material_id: null, source: 'manual', notes: '', pos_id: '',
};

export default function MenuItemsPage() {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, active: 0, inactive: 0, foods: 0, liquors: 0, beverages: 0, withRecipe: 0, withMaterial: 0, noPrice: 0, noCategory: 0, noStation: 0, noDietaryTag: 0 });
  const [categories, setCategories] = useState<string[]>([]);
  const [stations, setStations] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [stationFilter, setStationFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [vegFilter, setVegFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [issueFilter, setIssueFilter] = useState<string | null>(null);

  // Import
  const [importOpen, setImportOpen] = useState(false);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<any>(null);
  const [importPayload, setImportPayload] = useState<any>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const [importSkipInactive, setImportSkipInactive] = useState(false);
  const [importSkipZero, setImportSkipZero] = useState(false);
  const [importOverwrite, setImportOverwrite] = useState(true);
  const importFileRef = useRef<HTMLInputElement>(null);

  // Edit modal
  const [editItem, setEditItem] = useState<MenuItem | null>(null);

  const [toast, setToast] = useState<string | null>(null);

  // Pagination + category dropdown + search focus
  const [page, setPage] = useState(1);
  const [catMenuOpen, setCatMenuOpen] = useState(false);
  const [catSearch, setCatSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch('/api/menu-items');
      const json = await res.json();
      setItems(json.items || []);
      setSummary(prev => json.summary || prev);
      setCategories(json.categories || []);
      setStations(json.stations || []);
    } catch (_) {}
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await fetchItems();
      setLoading(false);
    })();
  }, [fetchItems]);

  // Filtering
  const filteredItems = useMemo(() => {
    return items.filter((it) => {
      const q = searchQuery.toLowerCase().trim();
      if (q && !it.name.toLowerCase().includes(q) && !it.item_code.toLowerCase().includes(q)) return false;
      if (categoryFilter && it.category !== categoryFilter) return false;
      if (stationFilter && it.station !== stationFilter) return false;
      if (typeFilter && it.item_type !== typeFilter) return false;
      if (vegFilter && it.dietary_tag !== vegFilter) return false;
      if (statusFilter === 'active' && !it.is_active) return false;
      if (statusFilter === 'inactive' && it.is_active) return false;

      // Issue filter
      if (issueFilter) {
        switch (issueFilter) {
          case 'noPrice': if (it.selling_price > 0) return false; break;
          case 'noCategory': if (it.category) return false; break;
          case 'noStation': if (it.station) return false; break;
          case 'noDietaryTag': if (it.item_type !== 'foods' || it.dietary_tag) return false; break;
          case 'noRecipe': if (it.recipe_id || it.material_id) return false; break;
          case 'any': {
            const bad = !(it.selling_price > 0)
              || (it.item_type === 'foods' && !it.dietary_tag)
              || (!it.recipe_id && !it.material_id);
            if (!bad) return false;
            break;
          }
        }
      }
      return true;
    });
  }, [items, searchQuery, categoryFilter, stationFilter, typeFilter, vegFilter, statusFilter, issueFilter]);

  // Attention counts — distinct items + per-issue (drives the banner)
  const attn = useMemo(() => {
    let noPrice = 0, noVeg = 0, noLink = 0; const bad = new Set<string>();
    for (const it of items) {
      let issue = false;
      if (!(it.selling_price > 0)) { noPrice++; issue = true; }
      if (it.item_type === 'foods' && !it.dietary_tag) { noVeg++; issue = true; }
      if (!it.recipe_id && !it.material_id) { noLink++; issue = true; }
      if (issue) bad.add(it.id);
    }
    return { noPrice, noVeg, noLink, total: bad.size };
  }, [items]);

  // Activating a health filter also drops the active-only scope, so the drill-down
  // reveals every flagged item the banner counted (incl. inactive ones).
  const reviewIssue = (key: string) => {
    if (issueFilter === key) { setIssueFilter(null); }
    else { setIssueFilter(key); setStatusFilter('all'); }
  };

  // Pagination (reset to page 1 whenever the filtered set changes)
  useEffect(() => { setPage(1); }, [searchQuery, categoryFilter, stationFilter, typeFilter, vegFilter, statusFilter, issueFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageItems = filteredItems.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // "/" focuses the search box (but never while a modal is open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editItem || importOpen) return;
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (e.key === '/' && tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
        e.preventDefault(); searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editItem, importOpen]);

  // Import handling
  const openImport = () => {
    setImportOpen(true);
    setImportFileName(null);
    setImportPreview(null);
    setImportPayload(null);
    setImportResult(null);
  };

  const handleImportFile = async (file: File) => {
    setImportResult(null);
    setImportFileName(file.name);

    try {
      const XLSX = await import('xlsx');
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });

      // Detect format: Akan POS export, AKAN Recipe Template, or generic
      let sheetName = wb.SheetNames.find(n => /existing.*product|products/i.test(n))
        || wb.SheetNames.find(n => /^menu.?items?$/i.test(n))
        || wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<any>(sheet, { header: 1, defval: null });

      // Find header row — scan first 5 rows for one that has "name" or "product name" or "menu item"
      let headerRowIdx = 0;
      for (let i = 0; i < Math.min(5, rows.length); i++) {
        const r = rows[i];
        if (!r) continue;
        const hasName = r.some((c: any) => c && /^(menu\s*item|item\s*name|product\s*name|name|category\s*name)$/i.test(String(c).trim()));
        if (hasName) { headerRowIdx = i; break; }
      }

      const header = rows[headerRowIdx] || [];
      const colIdx: Record<string, number> = {};
      header.forEach((h: any, i: number) => {
        if (!h) return;
        const key = String(h).toLowerCase().trim();
        // Category column — "Category Name" (POS) or "Category" (template)
        if ((key === 'category name' || key === 'category') && colIdx.category === undefined) colIdx.category = i;
        // Name column — "Product Name" (POS) or "Menu Item" (template)
        else if ((key === 'product name' || key === 'menu item' || key === 'item name' || key === 'name') && colIdx.name === undefined) colIdx.name = i;
        else if (key === 'selling price' || key === 'selling price (₹)' || key === 'price') colIdx.sellingPrice = i;
        else if (key === 'listing price') colIdx.listingPrice = i;
        else if (key === 'master status' || key === 'status') colIdx.masterStatus = i;
        else if (key === 'item type' || key === 'type') colIdx.itemType = i;
        else if (key === 'tax value' || key === 'tax') colIdx.taxValue = i;
        else if (key === 'item code' || key === 'code') colIdx.itemCode = i;
        else if (key === 'station') colIdx.station = i;
        else if (key === 'dietary tag' || key === 'veg/non-veg' || key === 'veg / non-veg') colIdx.dietaryTag = i;
        else if (key === 'cuisine') colIdx.cuisine = i;
      });

      // If template format detected (has "cuisine", "menu item", or "item name"), apply category → station mapping
      const isTemplate = colIdx.cuisine !== undefined || /menu\s*item|item\s*name/i.test(String(header[colIdx.name ?? 0] || ''));
      const stationMap: Record<string, string> = {
        'Bar Bites': 'bar', 'Burgers / Sandwiches': 'continental', 'Desserts': 'bakery',
        'Dimsums/Baos': 'pan-asian', 'Grills': 'tandoor', 'Live Grills': 'terracegrill',
        'Non-Veg Main Course': 'indian', 'Pasta': 'continental', 'Pizzas': 'pizza',
        'Pulaos / Biryanis/ Noodles': 'indian', 'Salads': 'continental',
        'Small Plates - Veg': 'tandoor', 'Soups': 'continental', 'Starters Non-Veg': 'tandoor',
        'Sushi': 'sushi', 'Veg - Main Course': 'indian',
      };
      // Case-insensitive station lookup — this sheet's categories are UPPERCASE.
      const stationLower: Record<string, string> = {};
      for (const [k, v] of Object.entries(stationMap)) stationLower[k.toLowerCase()] = v;
      const stationFor = (cat: string) => stationMap[cat] || stationLower[cat.toLowerCase()] || '';
      const vegNormalize = (v: any): string => {
        if (!v) return '';
        const s = String(v).toUpperCase().trim();
        if (s === 'VEG') return 'Veg';
        if (s === 'NON-VEG' || s === 'NONVEG') return 'Non-Veg';
        if (s === 'EGG') return 'Egg';
        if (s.includes('VEG') && s.includes('NON')) return 'Non-Veg';
        return String(v).trim();
      };
      // When the sheet has no dietary column, infer from the item name first, then
      // the category (e.g. "NON-VEG MAIN COURSE", "SMALL PLATES - VEG").
      const deriveDietary = (cat: string, name: string): string => {
        const n = name.toLowerCase();
        if (/\b(chicken|mutton|lamb|fish|prawn|prawns|crab|seafood|keema|kheema)\b/.test(n)) return 'Non-Veg';
        if (/\begg\b/.test(n)) return 'Egg';
        const c = cat.toUpperCase();
        if (c.includes('NON-VEG') || c.includes('NON VEG')) return 'Non-Veg';
        if (c.includes('VEG')) return 'Veg';
        return '';
      };
      const slugify = (c: string) => c.toLowerCase().replace(/\s*\/\s*/g, '-').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

      // Start parsing from row after header
      const parsedRows: any[] = [];
      for (let i = headerRowIdx + 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[colIdx.name]) continue;

        const rawCategory = String(r[colIdx.category] || '').trim();
        const name = String(r[colIdx.name] || '').trim();
        const cuisine = colIdx.cuisine !== undefined ? String(r[colIdx.cuisine] || '').trim() : '';

        parsedRows.push({
          name,
          category: isTemplate && rawCategory ? slugify(rawCategory) : rawCategory,
          selling_price: Number(r[colIdx.sellingPrice]) || 0,
          listing_price: Number(r[colIdx.listingPrice]) || 0,
          master_status: String(r[colIdx.masterStatus] || 'Active').trim(),
          item_type: String(r[colIdx.itemType] || 'foods').trim() || 'foods',
          tax_value: Number(r[colIdx.taxValue]) || (isTemplate ? 5 : 0),
          item_code: String(r[colIdx.itemCode] || '').trim() || (isTemplate ? name.split(' ').map((w: string) => w[0] || '').join('').toUpperCase().slice(0, 5) : ''),
          station: String(r[colIdx.station] || '').trim() || (isTemplate ? stationFor(rawCategory) : ''),
          dietary_tag: vegNormalize(r[colIdx.dietaryTag]) || deriveDietary(rawCategory, name),
          notes: isTemplate && cuisine ? `Cuisine: ${cuisine}` : '',
        });
      }

      // Compute preview stats
      const active = parsedRows.filter(r => r.master_status?.toLowerCase() !== 'inactive').length;
      const withTypos = parsedRows.filter(r => /COSMOPOLTIAN|GLENMORNGIE|HEINKEIN|HOEGARDEN|BUDWISER|VERMOTH|EXPRESSO|TOBASCO|CARDMOM|BTTL/i.test(r.name)).length;
      const withExtraSpaces = parsedRows.filter(r => r.name !== r.name.replace(/\s+/g, ' ').trim() || /  /.test(r.name)).length;
      const withZeroPrice = parsedRows.filter(r => !r.selling_price).length;
      const foodsNoTag = parsedRows.filter(r => r.item_type === 'foods' && !r.dietary_tag).length;

      // In-file duplicates
      const nameCounts = new Map<string, number>();
      for (const r of parsedRows) {
        const key = r.name.toLowerCase().trim();
        nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
      }
      const dupes = [...nameCounts.entries()].filter(([, n]) => n > 1).length;

      setImportPreview({
        total: parsedRows.length,
        active, inactive: parsedRows.length - active,
        typos: withTypos, spaces: withExtraSpaces,
        zeroPrice: withZeroPrice, foodsNoTag, duplicates: dupes,
        categories: [...new Set(parsedRows.map(r => r.category).filter(Boolean))].length,
      });
      setImportPayload({ rows: parsedRows, isTemplate });
    } catch (err: any) {
      setImportResult({ error: err.message });
    }
  };

  const submitImport = async () => {
    if (!importPayload) return;
    setImporting(true);
    setImportResult(null);
    try {
      const res = await api('/api/menu-items/import', {
        method: 'POST',
        body: {
          ...importPayload,
          overwrite_existing: importOverwrite,
          fix_typos: true,
          strip_spaces: true,
          skip_inactive: importSkipInactive,
          skip_zero_price: importSkipZero,
          // Food menus (template format) link to recipes only — never auto-link a
          // dish to a raw material by prefix (a soup must not become "TOMATO KETCHUP").
          link_materials: !importPayload.isTemplate,
        },
      });
      const json = await res.json();
      setImportResult(json);
      if (json.items_created > 0 || json.items_updated > 0) {
        await fetchItems();
      }
    } catch (err: any) {
      setImportResult({ error: err.message });
    } finally {
      setImporting(false);
    }
  };

  const deleteItem = async (id: string) => {
    if (!confirm('Delete this menu item?')) return;
    await api(`/api/menu-items?id=${id}`, { method: 'DELETE' });
    await fetchItems();
    setToast('Item deleted');
    setTimeout(() => setToast(null), 2000);
  };

  const toggleActive = async (item: MenuItem) => {
    await api('/api/menu-items', {
      method: 'PUT',
      body: { id: item.id, is_active: !item.is_active },
    });
    await fetchItems();
  };

  const saveEdit = async (updates: Partial<MenuItem>) => {
    if (!editItem) return;
    await api('/api/menu-items', {
      method: 'PUT',
      body: { id: editItem.id, ...updates },
    });
    setEditItem(null);
    await fetchItems();
    setToast('Saved');
    setTimeout(() => setToast(null), 2000);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-[100rem] mx-auto space-y-6">
          <div className="h-9 w-64 bg-[#FFF1E3] rounded-lg" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
            {[...Array(4)].map((_, i) => <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-6 h-32" />)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-[100rem] mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4 sm:space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Dine-In</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#2D1B0E] mt-0.5">Menu Items</h1>
          </div>
          <div className="flex gap-2">
            {/* Round-trip: download the CURRENT menu in the exact columns the
                Import accepts → edit in a spreadsheet → re-import with Overwrite. */}
            <a href="/api/menu-items/export" download
               className="flex items-center gap-2 px-3 sm:px-4 py-2.5 bg-white border border-[#E0D0BE] hover:border-[#af4408] hover:bg-[#af4408]/5 text-[#6B5744] rounded-xl text-sm font-medium shadow-sm transition-colors">
              <Download className="w-4 h-4" /><span className="hidden sm:inline">Download Menu (CSV)</span><span className="sm:hidden">Menu CSV</span>
            </a>
            <button onClick={openImport} className="flex items-center gap-2 px-3 sm:px-4 py-2.5 bg-white border border-[#E0D0BE] hover:border-purple-400 hover:bg-purple-50/40 text-purple-700 rounded-xl text-sm font-medium shadow-sm transition-colors">
              <Upload className="w-4 h-4" /><span className="hidden sm:inline">Import from Akan POS</span><span className="sm:hidden">Import</span>
            </button>
            <button onClick={() => setEditItem(NEW_ITEM)} className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold shadow-sm transition-colors">
              <Plus className="w-4 h-4" />New Item
            </button>
          </div>
        </div>

        {/* Stat bar */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden grid grid-cols-3 sm:grid-cols-6">
          <Stat label="Total" value={summary.total} className="text-[#2D1B0E]" />
          <Stat label="Active" value={summary.active} className="text-green-600" />
          <Stat label="Foods" value={summary.foods} className="text-orange-500" />
          <Stat label="Liquor" value={summary.liquors} className="text-purple-600" />
          <Stat label="Beverages" value={summary.beverages} className="text-[#B9A48C]" />
          <Stat label="With Recipe" value={summary.withRecipe} className="text-blue-600" />
        </div>

        {/* Attention banner */}
        {attn.total > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-semibold text-amber-900">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
              {attn.total} items need attention
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {attn.noPrice > 0 && <AttnPill tone="red" count={attn.noPrice} label="no selling price" active={issueFilter === 'noPrice'} onClick={() => reviewIssue('noPrice')} />}
              {attn.noVeg > 0 && <AttnPill tone="amber" count={attn.noVeg} label="missing veg/non-veg" active={issueFilter === 'noDietaryTag'} onClick={() => reviewIssue('noDietaryTag')} />}
              {attn.noLink > 0 && <AttnPill tone="blue" count={attn.noLink} label="no recipe link" active={issueFilter === 'noRecipe'} onClick={() => reviewIssue('noRecipe')} />}
            </div>
            <button onClick={() => reviewIssue('any')} className="ml-auto text-sm font-medium text-[#af4408] hover:underline whitespace-nowrap">
              {issueFilter ? 'Clear filter' : 'Review all →'}
            </button>
          </div>
        )}

        {/* Search + filters */}
        <div className="flex flex-col lg:flex-row gap-2.5">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
            <input ref={searchRef} type="text" placeholder="Search by name or item code…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                   className="w-full pl-10 pr-9 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 focus:border-[#af4408] shadow-sm" />
            <kbd className="hidden sm:flex absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 items-center justify-center rounded border border-[#E0D0BE] bg-[#FFF8F0] text-[11px] text-[#8B7355]">/</kbd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={stationFilter} onChange={e => setStationFilter(e.target.value)} className="px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm shadow-sm">
              <option value="">All Stations ({stations.length})</option>
              {stations.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm shadow-sm">
              <option value="">All Types</option>
              <option value="foods">Foods</option>
              <option value="liquors">Liquor</option>
              <option value="beverages">Beverages</option>
            </select>
            <SegmentedVeg value={vegFilter} onChange={setVegFilter} />
            <ActiveToggle on={statusFilter === 'active'} onToggle={() => setStatusFilter(statusFilter === 'active' ? 'all' : 'active')} />
          </div>
        </div>

        {/* Category chips + "All N categories" dropdown */}
        {categories.length > 0 && (() => {
          const baseList = items.filter(it => {
            if (statusFilter === 'active'   && !it.is_active) return false;
            if (statusFilter === 'inactive' &&  it.is_active) return false;
            if (stationFilter && it.station !== stationFilter) return false;
            if (typeFilter    && it.item_type !== typeFilter) return false;
            if (vegFilter     && it.dietary_tag !== vegFilter) return false;
            const q = searchQuery.toLowerCase().trim();
            if (q && !it.name.toLowerCase().includes(q) && !(it.item_code || '').toLowerCase().includes(q)) return false;
            return true;
          });
          const countByCat: Record<string, number> = {};
          for (const it of baseList) { const k = it.category; if (k) countByCat[k] = (countByCat[k] || 0) + 1; }
          const sortedCats = [...categories].sort((a, b) => (countByCat[b] || 0) - (countByCat[a] || 0));
          const inline = sortedCats.slice(0, TOP_CATS);
          if (categoryFilter && !inline.includes(categoryFilter)) inline.unshift(categoryFilter);
          return (
            <div className="flex items-center gap-2">
              <TabScroller className="gap-1.5 flex-1 min-w-0">
                <CatChip active={!categoryFilter} label="All" count={baseList.length} onClick={() => setCategoryFilter('')} />
                {inline.map(c => <CatChip key={c} active={categoryFilter === c} label={c} count={countByCat[c] || 0} onClick={() => setCategoryFilter(categoryFilter === c ? '' : c)} />)}
              </TabScroller>
              <div className="relative shrink-0">
                <button onClick={() => setCatMenuOpen(!catMenuOpen)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors ${catMenuOpen ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'}`}>
                  All {categories.length} categories <ChevronDown className="w-3.5 h-3.5" />
                </button>
                {catMenuOpen && (
                  <CategoryMenu categories={sortedCats} counts={countByCat} current={categoryFilter} search={catSearch} setSearch={setCatSearch}
                                onPick={(c) => { setCategoryFilter(c); setCatMenuOpen(false); setCatSearch(''); }}
                                onClose={() => { setCatMenuOpen(false); setCatSearch(''); }} />
                )}
              </div>
            </div>
          );
        })()}

        {/* ---- Items: table on desktop, cards on mobile ---- */}
        {filteredItems.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl py-16 text-center text-[#8B7355]">
            <Utensils className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p>No menu items found</p>
            <p className="text-xs mt-1">Try clearing filters, or import from Akan POS</p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4] bg-[#FFF8F0]">
                      <th className="text-left py-3 px-4 font-semibold">Name</th>
                      <th className="text-left py-3 px-3 font-semibold">Category / Station</th>
                      <th className="text-left py-3 px-3 font-semibold">Type</th>
                      <th className="text-left py-3 px-3 font-semibold">V/NV</th>
                      <th className="text-right py-3 px-3 font-semibold">Sell ₹</th>
                      <th className="text-right py-3 px-3 font-semibold">Cost ₹</th>
                      <th className="text-right py-3 px-3 font-semibold">FC %</th>
                      <th className="text-left py-3 px-3 font-semibold">Link</th>
                      <th className="text-center py-3 px-3 font-semibold">Active</th>
                      <th className="w-10" aria-label="Actions"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((it) => (
                      <tr key={it.id} className={`border-b border-[#F0E4D6] last:border-0 hover:bg-[#FFF8F0] ${!it.is_active ? 'opacity-55' : ''}`}>
                        <td className="py-2.5 px-4">
                          <div className="flex items-center gap-3">
                            <Avatar name={it.name} type={it.item_type} />
                            <div className="min-w-0">
                              <p className="font-semibold text-[#2D1B0E] text-[13px] truncate max-w-[240px]">{it.name}</p>
                              {it.item_code && <p className="text-[11px] text-[#8B7355] font-mono">{it.item_code}</p>}
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-3">
                          <p className="text-[13px] text-[#3D2614]">{it.category || <span className="text-red-400">—</span>}</p>
                          {it.station && <p className="text-[11px] text-[#8B7355]">{it.station}</p>}
                        </td>
                        <td className="py-2.5 px-3"><TypeBadge type={it.item_type} /></td>
                        <td className="py-2.5 px-3"><VegSquare tag={it.dietary_tag} type={it.item_type} /></td>
                        <td className="py-2.5 px-3 text-right font-semibold text-[#2D1B0E]">
                          {it.selling_price > 0 ? formatCurrency(it.selling_price) : <span className="text-red-400 font-normal">₹0</span>}
                        </td>
                        <td className="py-2.5 px-3 text-right text-[#6B5744]">
                          {it.recipe_cost ? formatCurrency(it.recipe_cost) : it.material_cost ? formatCurrency(it.material_cost) : <span className="text-[#C4B09A]">—</span>}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {it.recipe_food_cost_percent
                            ? <span className={`font-medium ${fcColor(it.recipe_food_cost_percent)}`}>{it.recipe_food_cost_percent}</span>
                            : <span className="text-[#C4B09A]">—</span>}
                        </td>
                        <td className="py-2.5 px-3"><LinkBadge item={it} /></td>
                        <td className="py-2.5 px-3 text-center"><RowToggle on={!!it.is_active} onClick={() => toggleActive(it)} /></td>
                        <td className="py-2.5 px-2 text-center"><RowMenu onEdit={() => setEditItem(it)} onDelete={() => deleteItem(it.id)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-2.5">
              {pageItems.map((it) => (
                <MobileCard key={it.id} it={it} onEdit={() => setEditItem(it)} onDelete={() => deleteItem(it.id)} onToggle={() => toggleActive(it)} />
              ))}
            </div>

            {/* Pagination */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
              <p className="text-xs text-[#8B7355]">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredItems.length)} of {filteredItems.length} items
              </p>
              <Pagination page={safePage} pageCount={pageCount} onPage={setPage} />
            </div>
          </>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3 bg-green-600 text-white rounded-lg shadow-lg">
          <CheckCircle className="w-4 h-4" />
          <span className="text-sm font-medium">{toast}</span>
        </div>
      )}

      {/* Import Modal */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-6 pb-6 overflow-y-auto">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setImportOpen(false)} />
          <div className="relative w-full max-w-4xl bg-white rounded-2xl shadow-xl border border-[#E8D5C4] mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] sticky top-0 bg-white z-20">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-100"><FileSpreadsheet className="w-5 h-5 text-purple-600" /></div>
                <div>
                  <h2 className="text-lg font-semibold text-[#2D1B0E]">Import Menu Items from Akan POS</h2>
                  <p className="text-xs text-[#8B7355]">Auto-fixes typos, strips extra spaces, links to recipes</p>
                </div>
              </div>
              <button onClick={() => setImportOpen(false)} className="p-1 text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-4 text-sm">
                <p className="text-[#6B5744] font-medium mb-2">This importer expects Akan Brewing Co Products format with columns:</p>
                <p className="text-xs text-[#8B7355]">Category Name, Product Name, Selling Price, Listing Price, Master Status, Item Type, Tax Value, Item Code, Station, Dietary Tag</p>
                <p className="text-xs text-[#8B7355] mt-2">Will auto-fix: COSMOPOLTIAN → COSMOPOLITAN, HEINKEIN → HEINEKEN, VERMOTH → VERMOUTH, etc. Plus extra-space cleanup.</p>
                <div className="flex flex-wrap gap-2 mt-3">
                  <a href="/api/menu-items/export" download
                     className="inline-flex items-center gap-1.5 text-xs font-medium text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 px-3 py-1.5 rounded-lg">
                    <Download className="w-3.5 h-3.5" /> Download current menu (CSV)
                  </a>
                  <a href="/api/menu-items/export?sample=1" download
                     className="inline-flex items-center gap-1.5 text-xs font-medium text-[#6B5744] border border-[#D4B896] hover:bg-[#FFF1E3] px-3 py-1.5 rounded-lg">
                    <Download className="w-3.5 h-3.5" /> Download sample template
                  </a>
                  <span className="text-[11px] text-[#8B7355] self-center">edit in a spreadsheet → re-upload here (Overwrite updates matching items)</span>
                </div>
              </div>

              {/* Drop zone */}
              <div onClick={() => importFileRef.current?.click()} className="border-2 border-dashed border-[#D4B896] hover:border-purple-600 hover:bg-purple-50/30 rounded-xl p-8 text-center cursor-pointer transition-colors">
                <FileSpreadsheet className="w-10 h-10 text-purple-500 mx-auto mb-3" />
                <p className="text-[#6B5744] font-medium">{importFileName || 'Click to select Excel / CSV file'}</p>
                <p className="text-xs text-[#8B7355] mt-1">Excel: looks for sheet "Existing Product" / "Products" · CSV: the downloaded menu format above</p>
                <input ref={importFileRef} type="file" accept=".xlsx,.xls,.csv" onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); }} className="hidden" />
              </div>

              {importPreview && (
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-4">
                  <h3 className="text-sm font-semibold text-[#2D1B0E]">File Parsed ✓</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <StatBlock label="Total Items" value={importPreview.total} color="text-[#af4408]" />
                    <StatBlock label="Active" value={importPreview.active} color="text-green-600" />
                    <StatBlock label="Inactive" value={importPreview.inactive} color="text-gray-500" />
                    <StatBlock label="Categories" value={importPreview.categories} color="text-blue-600" />
                    {importPreview.typos > 0 && <StatBlock label="Typos to Fix" value={importPreview.typos} color="text-amber-600" />}
                    {importPreview.spaces > 0 && <StatBlock label="Space Issues" value={importPreview.spaces} color="text-amber-600" />}
                    {importPreview.duplicates > 0 && <StatBlock label="In-File Dupes" value={importPreview.duplicates} color="text-red-500" />}
                    {importPreview.zeroPrice > 0 && <StatBlock label="Zero Price" value={importPreview.zeroPrice} color="text-red-500" />}
                  </div>

                  <div className="space-y-2 text-xs">
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={importOverwrite} onChange={e => setImportOverwrite(e.target.checked)} className="accent-purple-600 w-4 h-4" /><span className="text-[#6B5744]">Overwrite existing items with same name</span></label>
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={importSkipInactive} onChange={e => setImportSkipInactive(e.target.checked)} className="accent-purple-600 w-4 h-4" /><span className="text-[#6B5744]">Skip inactive items ({importPreview.inactive} will be excluded)</span></label>
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={importSkipZero} onChange={e => setImportSkipZero(e.target.checked)} className="accent-purple-600 w-4 h-4" /><span className="text-[#6B5744]">Skip items with ₹0 selling price ({importPreview.zeroPrice} will be excluded)</span></label>
                  </div>

                  <div className="flex gap-3">
                    <button onClick={submitImport} disabled={importing} className="flex items-center gap-2 px-5 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
                      {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                      {importing ? 'Importing...' : `Import ${importPreview.total} Items`}
                    </button>
                    <button onClick={() => { setImportPreview(null); setImportPayload(null); setImportFileName(null); }} className="px-4 py-2.5 bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm hover:bg-[#E8D5C4]">Clear</button>
                  </div>
                </div>
              )}

              {importResult && (
                <div className="space-y-3">
                  {importResult.error ? (
                    <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                      <div className="flex items-start gap-2"><AlertCircle className="w-5 h-5 text-red-500" /><div><p className="text-red-700 font-medium">Import failed</p><p className="text-red-600 text-xs mt-1">{importResult.error}</p></div></div>
                    </div>
                  ) : (
                    <>
                      <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                        <div className="flex items-start gap-2 mb-2"><CheckCircle className="w-5 h-5 text-green-600" /><p className="text-green-700 font-medium">Import complete!</p></div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                          {importResult.items_created > 0 && <StatBlock label="Created" value={importResult.items_created} color="text-green-600" />}
                          {importResult.items_updated > 0 && <StatBlock label="Updated" value={importResult.items_updated} color="text-blue-600" />}
                          {importResult.items_linked_to_recipe > 0 && <StatBlock label="Linked to Recipes" value={importResult.items_linked_to_recipe} color="text-indigo-600" />}
                          {importResult.items_linked_to_material > 0 && <StatBlock label="Linked to Materials" value={importResult.items_linked_to_material} color="text-purple-600" />}
                          {importResult.items_skipped_inactive > 0 && <StatBlock label="Skipped Inactive" value={importResult.items_skipped_inactive} color="text-gray-500" />}
                          {importResult.items_skipped_zero_price > 0 && <StatBlock label="Skipped ₹0" value={importResult.items_skipped_zero_price} color="text-gray-500" />}
                          {importResult.items_skipped_duplicate > 0 && <StatBlock label="Skipped Duplicate" value={importResult.items_skipped_duplicate} color="text-amber-600" />}
                          {importResult.typos_fixed?.length > 0 && <StatBlock label="Typos Fixed" value={importResult.typos_fixed.length} color="text-amber-600" />}
                          {importResult.spaces_fixed > 0 && <StatBlock label="Spaces Fixed" value={importResult.spaces_fixed} color="text-amber-600" />}
                        </div>
                      </div>
                      {importResult.typos_fixed?.length > 0 && (
                        <details className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
                          <summary className="cursor-pointer font-medium text-amber-800">🔧 {importResult.typos_fixed.length} typos fixed (click to view)</summary>
                          <div className="mt-2 max-h-48 overflow-y-auto bg-white rounded p-2 space-y-1">
                            {importResult.typos_fixed.map((t: string, i: number) => <p key={i} className="text-amber-700">{t}</p>)}
                          </div>
                        </details>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editItem && (
        <EditItemModal item={editItem} onClose={() => setEditItem(null)} onSave={saveEdit} categories={categories} stations={stations} isNew={!editItem.id} />
      )}
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <div className="px-2 sm:px-3 py-3 text-center border-r border-b sm:border-b-0 border-[#F0E4D6]">
      <p className="text-[10px] sm:text-[11px] text-[#8B7355] uppercase tracking-wide truncate">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold mt-1 ${className}`}>{value}</p>
    </div>
  );
}

function fcColor(pct: number): string {
  return pct > 50 ? 'text-red-500' : pct > 30 ? 'text-amber-600' : 'text-green-600';
}

function Avatar({ name, type }: { name: string; type: string }) {
  const initials = (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  const tone = type === 'liquors' ? 'bg-purple-100 text-purple-700'
    : type === 'beverages' ? 'bg-blue-100 text-blue-700'
    : 'bg-[#F3E2D0] text-[#a8632b]';
  return <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${tone}`}>{initials}</div>;
}

// FSSAI-style veg/non-veg marker. Shape (not just colour) distinguishes each state
// for colour-blind users: Veg = dot, Non-Veg = triangle, Egg = ring; plus role/aria
// so screen readers announce it. "?" when a food is missing its tag.
function VegSquare({ tag, type }: { tag: string; type: string }) {
  if (tag === 'Veg')
    return <span role="img" aria-label="Veg" title="Veg" className="inline-flex items-center justify-center w-[18px] h-[18px] rounded border-2 border-green-600"><span className="w-2 h-2 rounded-full bg-green-600" /></span>;
  if (tag === 'Non-Veg')
    return <span role="img" aria-label="Non-Veg" title="Non-Veg" className="inline-flex items-center justify-center w-[18px] h-[18px] rounded border-2 border-red-600"><span className="w-0 h-0 border-l-[4px] border-r-[4px] border-b-[7px] border-l-transparent border-r-transparent border-b-red-600" /></span>;
  if (tag === 'Egg')
    return <span role="img" aria-label="Egg" title="Egg" className="inline-flex items-center justify-center w-[18px] h-[18px] rounded border-2 border-amber-500"><span className="w-2 h-2 rounded-full border-2 border-amber-500" /></span>;
  if (type === 'foods')
    return <span role="img" aria-label="Veg/Non-Veg not set" className="inline-flex items-center justify-center w-[18px] h-[18px] rounded border-2 border-amber-400 text-[11px] font-bold text-amber-500 leading-none" title="Veg/Non-Veg not set">?</span>;
  return <span className="text-[#C4B09A]" aria-hidden>—</span>;
}

function LinkBadge({ item }: { item: MenuItem }) {
  if (item.recipe_id) return <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200">Recipe</span>;
  if (item.material_id) return <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-purple-50 text-purple-700 border border-purple-200">Direct</span>;
  return <span className="text-[#C4B09A]">—</span>;
}

function RowToggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <Toggle checked={on} onChange={() => onClick()} size="sm" label={on ? 'Active' : 'Inactive'} />;
}

// ⋮ row menu. The dropdown is fixed-positioned so it isn't clipped by the
// table's horizontal-scroll container.
function RowMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };
  // Fixed dropdown can't follow the row, so close it on any scroll/resize.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);
  return (
    <>
      <button ref={btnRef} onClick={() => (open ? setOpen(false) : openMenu())} className="p-1.5 rounded-lg text-[#8B7355] hover:bg-[#FFF1E3]" aria-label="Row actions">
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && pos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div style={{ top: pos.top, right: pos.right }} className="fixed z-50 w-32 bg-white border border-[#E8D5C4] rounded-lg shadow-xl py-1 text-sm">
            <button onClick={() => { setOpen(false); onEdit(); }} className="w-full text-left px-3 py-1.5 hover:bg-[#FFF1E3] flex items-center gap-2 text-[#2D1B0E]"><Edit className="w-3.5 h-3.5" />Edit</button>
            <button onClick={() => { setOpen(false); onDelete(); }} className="w-full text-left px-3 py-1.5 hover:bg-red-50 flex items-center gap-2 text-red-600"><Trash2 className="w-3.5 h-3.5" />Delete</button>
          </div>
        </>
      )}
    </>
  );
}

function StatBlock({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-2 text-center">
      <p className="text-[10px] text-[#8B7355] uppercase tracking-wide">{label}</p>
      <p className={`text-lg font-bold ${color}`}>{value}</p>
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    foods: { bg: 'bg-orange-100', text: 'text-orange-700', label: 'Food' },
    liquors: { bg: 'bg-purple-100', text: 'text-purple-700', label: 'Liquor' },
    beverages: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Bev' },
    'beverages.': { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Bev' },
  };
  const m = map[type] || { bg: 'bg-gray-100', text: 'text-gray-700', label: type || '—' };
  return <span className={`text-[10px] px-2 py-0.5 rounded-full ${m.bg} ${m.text} font-medium`}>{m.label}</span>;
}

function AttnPill({ tone, count, label, active, onClick }: { tone: 'red' | 'amber' | 'blue'; count: number; label: string; active: boolean; onClick: () => void }) {
  const tones: Record<string, string> = {
    red: active ? 'bg-red-600 text-white border-red-600' : 'bg-white text-red-700 border-red-200 hover:bg-red-50',
    amber: active ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-amber-800 border-amber-300 hover:bg-amber-50',
    blue: active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-blue-700 border-blue-200 hover:bg-blue-50',
  };
  return (
    <button onClick={onClick} className={`text-xs font-medium px-2.5 py-1 rounded-full border transition-colors ${tones[tone]}`}>
      <span className="font-bold">{count}</span> {label}
    </button>
  );
}

function SegmentedVeg({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const opts: [string, string][] = [['', 'All'], ['Veg', 'Veg'], ['Non-Veg', 'Non-Veg']];
  return (
    <div className="inline-flex rounded-xl border border-[#E0D0BE] bg-white p-0.5 shadow-sm">
      {opts.map(([v, label]) => {
        const on = value === v;
        const activeCls = v === '' ? 'bg-[#af4408] text-white' : v === 'Veg' ? 'bg-green-600 text-white' : 'bg-red-600 text-white';
        const idleCls = v === 'Veg' ? 'text-green-700 hover:bg-[#FFF1E3]' : v === 'Non-Veg' ? 'text-red-600 hover:bg-[#FFF1E3]' : 'text-[#6B5744] hover:bg-[#FFF1E3]';
        return <button key={v || 'all'} onClick={() => onChange(v)} className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${on ? activeCls : idleCls}`}>{label}</button>;
      })}
    </div>
  );
}

function ActiveToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-[#E0D0BE] bg-white text-sm text-[#6B5744] shadow-sm cursor-pointer">
      <Toggle checked={on} onChange={() => onToggle()} size="sm" label="Active only" />
      Active only
    </label>
  );
}

function CatChip({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`text-xs px-3 py-1.5 rounded-full whitespace-nowrap transition-colors ${active ? 'bg-[#af4408] text-white' : 'bg-white border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
      {label} <span className={active ? 'opacity-75' : 'text-[#8B7355]'}>· {count}</span>
    </button>
  );
}

function CategoryMenu({ categories, counts, current, search, setSearch, onPick, onClose }: {
  categories: string[]; counts: Record<string, number>; current: string; search: string;
  setSearch: (s: string) => void; onPick: (c: string) => void; onClose: () => void;
}) {
  const list = categories.filter(c => c.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute right-0 top-full mt-2 z-40 w-64 max-w-[85vw] bg-white border border-[#E8D5C4] rounded-xl shadow-xl overflow-hidden">
        <div className="p-2 border-b border-[#F0E4D6]">
          <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter categories…"
                 className="w-full px-2.5 py-1.5 bg-[#FFF8F0] border border-[#E0D0BE] rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-[#af4408]" />
        </div>
        <div className="max-h-72 overflow-y-auto py-1 text-sm">
          <button onClick={() => onPick('')} className={`w-full text-left px-3 py-1.5 hover:bg-[#FFF1E3] ${!current ? 'text-[#af4408] font-semibold' : 'text-[#3D2614]'}`}>All categories</button>
          {list.map(c => (
            <button key={c} onClick={() => onPick(c)} className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-[#FFF1E3] ${current === c ? 'text-[#af4408] font-semibold' : 'text-[#3D2614]'}`}>
              <span className="truncate">{c}</span><span className="text-[11px] text-[#8B7355] shrink-0">{counts[c] || 0}</span>
            </button>
          ))}
          {list.length === 0 && <p className="px-3 py-2 text-xs text-[#8B7355]">No matches</p>}
        </div>
      </div>
    </>
  );
}

function MobileCard({ it, onEdit, onDelete, onToggle }: { it: MenuItem; onEdit: () => void; onDelete: () => void; onToggle: () => void }) {
  return (
    <div className={`bg-white border border-[#E8D5C4] rounded-2xl p-3 shadow-sm ${!it.is_active ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        <Avatar name={it.name} type={it.item_type} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold text-[#2D1B0E] text-sm leading-snug">{it.name}</p>
              <p className="text-[11px] text-[#8B7355] truncate">
                {it.category || '—'}{it.station ? ` · ${it.station}` : ''}{it.item_code ? ` · ${it.item_code}` : ''}
              </p>
            </div>
            <RowMenu onEdit={onEdit} onDelete={onDelete} />
          </div>
          <div className="flex items-center flex-wrap gap-2 mt-2">
            <TypeBadge type={it.item_type} />
            <VegSquare tag={it.dietary_tag} type={it.item_type} />
            <LinkBadge item={it} />
            <span className="ml-auto font-bold text-[#2D1B0E]">{it.selling_price > 0 ? formatCurrency(it.selling_price) : <span className="text-red-400">₹0</span>}</span>
          </div>
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#F0E4D6] text-[11px] text-[#8B7355]">
            <span>Cost {it.recipe_cost ? formatCurrency(it.recipe_cost) : it.material_cost ? formatCurrency(it.material_cost) : '—'}{it.recipe_food_cost_percent ? ` · FC ${it.recipe_food_cost_percent}%` : ''}</span>
            <span className="flex items-center gap-1.5">{it.is_active ? 'Active' : 'Inactive'}<RowToggle on={!!it.is_active} onClick={onToggle} /></span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Pagination({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (n: number) => void }) {
  if (pageCount <= 1) return null;
  const set = new Set<number>([1, 2, 3, page - 1, page, page + 1, pageCount]);
  const nums = [...set].filter(n => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const items: (number | string)[] = [];
  nums.forEach((n, i) => { if (i > 0 && n - nums[i - 1] > 1) items.push(`gap${i}`); items.push(n); });
  return (
    <div className="flex items-center gap-1">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="h-9 w-9 flex items-center justify-center rounded-lg border border-[#E8D5C4] text-[#6B5744] disabled:opacity-40 hover:bg-[#FFF1E3]" aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
      {items.map((n) => typeof n === 'string'
        ? <span key={n} className="px-1 text-[#8B7355]">…</span>
        : <button key={n} onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined} className={`min-w-[36px] h-9 px-2 rounded-lg text-sm font-medium ${n === page ? 'bg-[#af4408] text-white' : 'border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'}`}>{n}</button>)}
      <button disabled={page >= pageCount} onClick={() => onPage(page + 1)} className="h-9 w-9 flex items-center justify-center rounded-lg border border-[#E8D5C4] text-[#6B5744] disabled:opacity-40 hover:bg-[#FFF1E3]" aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
    </div>
  );
}

// Options/variants <-> the admin textarea ("Label: a, b" per line).
function optionsToText(raw: any): string {
  let arr: any[] = [];
  if (Array.isArray(raw)) arr = raw;
  else { try { const j = JSON.parse(raw || '[]'); if (Array.isArray(j)) arr = j; } catch { /* ignore */ } }
  return arr.map((g: any) => `${g?.label || ''}: ${(g?.choices || []).join(', ')}`).join('\n');
}
function textToOptions(t: string): Array<{ label: string; choices: string[] }> {
  return t.split('\n').map(line => {
    const i = line.indexOf(':'); if (i < 0) return null;
    const label = line.slice(0, i).trim();
    const choices = line.slice(i + 1).split(',').map(c => c.trim()).filter(Boolean);
    return label && choices.length >= 2 ? { label, choices } : null;
  }).filter((x): x is { label: string; choices: string[] } => !!x);
}

function EditItemModal({ item, onClose, onSave, categories, stations, isNew }: { item: MenuItem; onClose: () => void; onSave: (updates: any) => void; categories: string[]; stations: string[]; isNew: boolean }) {
  const [form, setForm] = useState({ ...item });
  const [saving, setSaving] = useState(false);
  const [optsText, setOptsText] = useState(() => optionsToText((item as any).options));
  const F = form as any;
  const tagArr: string[] = Array.isArray(F.tags) ? F.tags : (F.tags ? (() => { try { const j = JSON.parse(F.tags); return Array.isArray(j) ? j : String(F.tags).split(','); } catch { return String(F.tags).split(','); } })() : []);
  const toggleTag = (tg: string) => setForm({ ...form, tags: (tagArr.indexOf(tg) >= 0 ? tagArr.filter(x => x !== tg) : tagArr.concat(tg)) } as any);
  const TAGS: [string, string][] = [['most-ordered', 'Most Ordered'], ['chef', "Chef's"], ['bestseller', 'Bestseller'], ['popular', 'Popular']];

  const save = async () => {
    setSaving(true);
    if (isNew) {
      await api('/api/menu-items', {
        method: 'POST',
        body: form,
      });
      onSave(form);
    } else {
      await onSave(form);
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      {/* House safe-modal shell: card capped to viewport, body scrolls
          internally, so header + Save/Cancel stay on screen on phones. */}
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="relative w-full max-w-2xl bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <h2 className="text-lg font-semibold text-[#2D1B0E]">{isNew ? 'New Menu Item' : 'Edit Menu Item'}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#FFF1E3]"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-[#6B5744] mb-1">Name *</label>
            <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Category</label>
              <input type="text" list="categories" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
              <datalist id="categories">{categories.map(c => <option key={c} value={c} />)}</datalist>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Station</label>
              <input type="text" list="stations" value={form.station} onChange={e => setForm({ ...form, station: e.target.value })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
              <datalist id="stations">{stations.map(s => <option key={s} value={s} />)}</datalist>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Type</label>
              <select value={form.item_type}
                      onChange={e => { const t = e.target.value; const half = t === 'liquors' ? 0 : 2.5; setForm({ ...form, item_type: t, cgst_percent: half, sgst_percent: half, tax_value: half * 2 }); }}
                      className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm">
                <option value="foods">Foods</option>
                <option value="liquors">Liquor</option>
                <option value="beverages">Beverages</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Veg/Non-Veg</label>
              <select value={form.dietary_tag} onChange={e => setForm({ ...form, dietary_tag: e.target.value })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm">
                <option value="">—</option>
                <option value="Veg">Veg</option>
                <option value="Non-Veg">Non-Veg</option>
                <option value="Egg">Egg</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Item Code</label>
              <input type="text" value={form.item_code} onChange={e => setForm({ ...form, item_code: e.target.value })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Selling Price (₹)</label>
              <input type="number" step="0.01" value={form.selling_price} onChange={e => setForm({ ...form, selling_price: Number(e.target.value) })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Listing Price (₹)</label>
              <input type="number" step="0.01" value={form.listing_price} onChange={e => setForm({ ...form, listing_price: Number(e.target.value) })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">GST % (CGST + SGST)</label>
              <div className="flex gap-2">
                <input type="number" step="0.01" min="0" placeholder="CGST" aria-label="CGST %"
                       value={form.cgst_percent}
                       onChange={e => setForm({ ...form, cgst_percent: Number(e.target.value) })}
                       className="w-full px-2 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
                <input type="number" step="0.01" min="0" placeholder="SGST" aria-label="SGST %"
                       value={form.sgst_percent}
                       onChange={e => setForm({ ...form, sgst_percent: Number(e.target.value) })}
                       className="w-full px-2 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
              </div>
              <p className="text-[10px] text-[#8B7355] mt-0.5">
                Total GST {Math.round(((Number(form.cgst_percent) || 0) + (Number(form.sgst_percent) || 0)) * 100) / 100}% · added to the bill per item · Liquor 0%. Auto-set by Type.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Prep time (minutes)</label>
              <input type="number" step="1" min="0" value={form.prep_minutes ?? 0} onChange={e => setForm({ ...form, prep_minutes: Number(e.target.value) })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
            </div>
          </div>
          {/* Customer QR-menu presentation */}
          <div className="rounded-xl border border-[#E8D5C4] bg-[#FFFBF5] p-4 space-y-3">
            <p className="text-[11px] font-semibold text-[#8B5A2B] uppercase tracking-wide">Customer Menu (QR)</p>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Image URL</label>
              <input type="url" value={F.image_url || ''} onChange={e => setForm({ ...form, image_url: e.target.value } as any)} placeholder="https://…/paneer-tikka.jpg" className="w-full px-3 py-2 bg-white border border-[#D4B896] rounded-lg text-sm" />
              <p className="text-[10px] text-[#8B7355] mt-0.5">Best: square ~1080×1080px, JPG/WebP, under 300 KB. It’s cropped to fit the card thumbnails and the item photo.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[#6B5744] mb-1">Spice level</label>
                <select value={F.spice_level ?? 0} onChange={e => setForm({ ...form, spice_level: Number(e.target.value) } as any)} className="w-full px-3 py-2 bg-white border border-[#D4B896] rounded-lg text-sm">
                  <option value={0}>None</option><option value={1}>🌶️ Mild</option><option value={2}>🌶️🌶️ Medium</option><option value={3}>🌶️🌶️🌶️ Hot</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-[#6B5744] mb-1">Serves</label>
                <input type="text" value={F.serves || ''} onChange={e => setForm({ ...form, serves: e.target.value } as any)} placeholder="e.g. 1-2" className="w-full px-3 py-2 bg-white border border-[#D4B896] rounded-lg text-sm" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Tags</label>
              <div className="flex gap-2 flex-wrap">
                {TAGS.map(([id, label]) => {
                  const on = tagArr.indexOf(id) >= 0;
                  return <button type="button" key={id} onClick={() => toggleTag(id)} className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${on ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#D4B896] hover:bg-[#FFF1E3]'}`}>{label}</button>;
                })}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Taste profile <span className="text-[#8B7355] font-normal">(0–4 each — powers the radar chart)</span></label>
              <div className="grid grid-cols-4 gap-2">
                {(['sour', 'sweet', 'spicy', 'tangy'] as const).map(t => (
                  <div key={t}>
                    <span className="block text-[10px] uppercase tracking-wide text-[#8B7355] mb-1">{t}</span>
                    <input type="number" min={0} max={4} step={1} value={F['taste_' + t] ?? 0} onChange={e => setForm({ ...form, ['taste_' + t]: Math.max(0, Math.min(4, Number(e.target.value) || 0)) } as any)} className="w-full px-2 py-2 bg-white border border-[#D4B896] rounded-lg text-sm text-center" />
                  </div>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Options / Variants <span className="text-[#8B7355] font-normal">(optional)</span></label>
              <textarea value={optsText} onChange={e => { setOptsText(e.target.value); setForm({ ...form, options: textToOptions(e.target.value) } as any); }} rows={2} placeholder="Temperature: Normal, Chilled" className="w-full px-3 py-2 bg-white border border-[#D4B896] rounded-lg text-sm font-mono" />
              <p className="text-[10px] text-[#8B7355] mt-0.5">One per line as <b>Label: choice1, choice2</b>. The guest picks one when ordering (e.g. a water bottle → <b>Temperature: Normal, Chilled</b>), and the choice prints on the KOT.</p>
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={!!form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked ? 1 : 0 })} className="accent-[#af4408] w-4 h-4" />
            <span className="text-sm text-[#6B5744]">Active (shown on menu)</span>
          </label>
        </div>
        <div className="flex justify-end gap-3 px-6 py-3 border-t border-[#E8D5C4] shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B5744] bg-[#FFF1E3] rounded-lg hover:bg-[#E8D5C4]">Cancel</button>
          <button onClick={save} disabled={saving || !form.name} className="flex items-center gap-2 px-5 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-sm font-medium">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
