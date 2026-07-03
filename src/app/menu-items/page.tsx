'use client';

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
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
  Link2,
  Package,
  ChefHat,
  Leaf,
  Beef,
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

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch('/api/menu-items');
      const json = await res.json();
      setItems(json.items || []);
      setSummary(json.summary || summary);
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
        }
      }
      return true;
    });
  }, [items, searchQuery, categoryFilter, stationFilter, typeFilter, vegFilter, statusFilter, issueFilter]);

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
      <div className="max-w-[100rem] mx-auto px-4 sm:px-6 py-6 space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-3">
              <Utensils className="w-8 h-8" />
              Menu Items
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">Complete product catalog — food, liquor, beverages</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={openImport} className="flex items-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-medium">
              <FileSpreadsheet className="w-4 h-4" />Import from Akan POS
            </button>
            <button onClick={() => setEditItem({ id: '', name: '', category: '', station: '', item_type: 'foods', dietary_tag: '', selling_price: 0, listing_price: 0, item_code: '', tax_value: 5, prep_minutes: 15, is_active: 1, recipe_id: null, material_id: null, source: 'manual', notes: '', pos_id: '' })} className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
              <Plus className="w-4 h-4" />New Item
            </button>
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <StatCard label="Total" value={summary.total} color="text-[#2D1B0E]" />
          <StatCard label="Active" value={summary.active} color="text-green-600" />
          <StatCard label="Foods" value={summary.foods} color="text-orange-500" icon={<Utensils className="w-3.5 h-3.5" />} />
          <StatCard label="Liquor" value={summary.liquors} color="text-purple-600" icon={<Package className="w-3.5 h-3.5" />} />
          <StatCard label="Beverages" value={summary.beverages} color="text-blue-500" />
          <StatCard label="With Recipe" value={summary.withRecipe} color="text-indigo-600" icon={<ChefHat className="w-3.5 h-3.5" />} />
        </div>

        {/* Issue chips */}
        {(summary.noPrice + summary.noCategory + summary.noStation + summary.noDietaryTag) > 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                Menu Health Check
              </h3>
              {issueFilter && <button onClick={() => setIssueFilter(null)} className="text-xs text-[#af4408] hover:underline">Clear filter</button>}
            </div>
            <div className="flex flex-wrap gap-2">
              {summary.noPrice > 0 && <IssueChip active={issueFilter === 'noPrice'} onClick={() => setIssueFilter(issueFilter === 'noPrice' ? null : 'noPrice')} color="red" count={summary.noPrice} label="No Selling Price" />}
              {summary.noCategory > 0 && <IssueChip active={issueFilter === 'noCategory'} onClick={() => setIssueFilter(issueFilter === 'noCategory' ? null : 'noCategory')} color="amber" count={summary.noCategory} label="No Category" />}
              {summary.noStation > 0 && <IssueChip active={issueFilter === 'noStation'} onClick={() => setIssueFilter(issueFilter === 'noStation' ? null : 'noStation')} color="amber" count={summary.noStation} label="No Station" />}
              {summary.noDietaryTag > 0 && <IssueChip active={issueFilter === 'noDietaryTag'} onClick={() => setIssueFilter(issueFilter === 'noDietaryTag' ? null : 'noDietaryTag')} color="orange" count={summary.noDietaryTag} label="Foods Missing Veg/Non-Veg" />}
              {(summary.total - summary.withRecipe - summary.withMaterial) > 0 && (
                <IssueChip active={issueFilter === 'noRecipe'} onClick={() => setIssueFilter(issueFilter === 'noRecipe' ? null : 'noRecipe')} color="blue" count={summary.total - summary.withRecipe - summary.withMaterial} label="No Recipe / Material Link" />
              )}
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
          {/* Category chips — always-visible, click to filter. Counts honour the
              other active filters so the user knows how many they'll see. */}
          {categories.length > 0 && (() => {
            const baseList = items.filter(it => {
              if (statusFilter === 'active'   && !it.is_active) return false;
              if (statusFilter === 'inactive' &&  it.is_active) return false;
              if (stationFilter && it.station !== stationFilter) return false;
              if (typeFilter    && it.item_type !== typeFilter) return false;
              if (vegFilter     && it.dietary_tag !== vegFilter) return false;
              if (searchQuery) {
                const q = searchQuery.toLowerCase();
                if (!it.name.toLowerCase().includes(q) && !(it.item_code || '').toLowerCase().includes(q)) return false;
              }
              return true;
            });
            const countByCat: Record<string, number> = {};
            for (const it of baseList) {
              const k = it.category || 'Uncategorised';
              countByCat[k] = (countByCat[k] || 0) + 1;
            }
            const sortedCats = [...categories].sort((a, b) => (countByCat[b] || 0) - (countByCat[a] || 0));
            return (
              <div className="flex flex-wrap gap-1.5">
                <button onClick={() => setCategoryFilter('')}
                        className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                          !categoryFilter ? 'bg-[#af4408] text-white'
                                          : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>
                  All <span className="opacity-70">({baseList.length})</span>
                </button>
                {sortedCats.map(c => {
                  const n = countByCat[c] || 0;
                  const active = categoryFilter === c;
                  return (
                    <button key={c}
                            onClick={() => setCategoryFilter(active ? '' : c)}
                            className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                              active ? 'bg-[#af4408] text-white'
                                     : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>
                      {c} <span className="opacity-70">({n})</span>
                    </button>
                  );
                })}
              </div>
            );
          })()}

          {/* Search + secondary dropdowns (station / type / veg / status).
              Category dropdown removed — chips above replace it. */}
          <div className="flex flex-col lg:flex-row gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
              <input type="text" placeholder="Search by name or item code..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="w-full pl-10 pr-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]" />
            </div>
            <select value={stationFilter} onChange={e => setStationFilter(e.target.value)} className="px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm">
              <option value="">All Stations ({stations.length})</option>
              {stations.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm">
              <option value="">All Types</option>
              <option value="foods">Foods</option>
              <option value="liquors">Liquor</option>
              <option value="beverages">Beverages</option>
            </select>
            <select value={vegFilter} onChange={e => setVegFilter(e.target.value)} className="px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm">
              <option value="">Veg/Non-Veg: All</option>
              <option value="Veg">Veg</option>
              <option value="Non-Veg">Non-Veg</option>
              <option value="Egg">Egg</option>
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm">
              <option value="active">Active only</option>
              <option value="inactive">Inactive only</option>
              <option value="all">All</option>
            </select>
          </div>
          <p className="text-xs text-[#8B7355] mt-2">Showing {filteredItems.length} of {items.length} items</p>
        </div>

        {/* Items table */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[#8B7355] border-b border-[#E8D5C4] bg-[#FFF1E3]/50">
                  <th className="text-left py-3 px-3 font-medium">Name</th>
                  <th className="text-left py-3 px-3 font-medium">Category</th>
                  <th className="text-left py-3 px-3 font-medium">Station</th>
                  <th className="text-left py-3 px-3 font-medium">Type</th>
                  <th className="text-left py-3 px-3 font-medium">V/NV</th>
                  <th className="text-right py-3 px-3 font-medium">Sell Price</th>
                  <th className="text-right py-3 px-3 font-medium">Cost</th>
                  <th className="text-right py-3 px-3 font-medium">FC %</th>
                  <th className="text-left py-3 px-3 font-medium">Link</th>
                  <th className="text-center py-3 px-3 font-medium">Active</th>
                  <th className="text-center py-3 px-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="py-12 text-center text-[#8B7355]">
                      <Utensils className="w-10 h-10 mx-auto mb-3 opacity-40" />
                      <p>No menu items found</p>
                      <p className="text-xs mt-1">Import from Akan POS or add manually</p>
                    </td>
                  </tr>
                ) : filteredItems.slice(0, 500).map((it) => (
                  <tr key={it.id} className={`border-b border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 ${!it.is_active ? 'opacity-50' : ''}`}>
                    <td className="py-2 px-3 text-[#2D1B0E] font-medium text-xs">
                      {it.name}
                      {it.item_code && <span className="ml-2 text-[10px] text-[#8B7355] font-mono">[{it.item_code}]</span>}
                    </td>
                    <td className="py-2 px-3 text-xs text-[#6B5744]">{it.category || <span className="text-red-400">—</span>}</td>
                    <td className="py-2 px-3 text-xs text-[#6B5744]">{it.station || <span className="text-red-400">—</span>}</td>
                    <td className="py-2 px-3">
                      <TypeBadge type={it.item_type} />
                    </td>
                    <td className="py-2 px-3">
                      {it.dietary_tag === 'Veg' && <span className="inline-flex items-center gap-1 text-[10px] text-green-700 font-medium"><Leaf className="w-3 h-3" />Veg</span>}
                      {it.dietary_tag === 'Non-Veg' && <span className="inline-flex items-center gap-1 text-[10px] text-red-600 font-medium"><Beef className="w-3 h-3" />NV</span>}
                      {it.dietary_tag === 'Egg' && <span className="text-[10px] text-amber-600 font-medium">Egg</span>}
                      {!it.dietary_tag && it.item_type === 'foods' && <span className="text-red-400 text-xs">—</span>}
                    </td>
                    <td className="py-2 px-3 text-right text-xs font-mono font-semibold text-[#2D1B0E]">
                      {it.selling_price > 0 ? formatCurrency(it.selling_price) : <span className="text-red-400">₹0</span>}
                    </td>
                    <td className="py-2 px-3 text-right text-xs font-mono text-[#6B5744]">
                      {it.recipe_cost ? formatCurrency(it.recipe_cost) : it.material_cost ? formatCurrency(it.material_cost) : '—'}
                    </td>
                    <td className="py-2 px-3 text-right text-xs font-mono">
                      {it.recipe_food_cost_percent ? (
                        <span className={it.recipe_food_cost_percent > 50 ? 'text-red-500' : it.recipe_food_cost_percent > 30 ? 'text-amber-600' : 'text-green-600'}>
                          {it.recipe_food_cost_percent}%
                        </span>
                      ) : '—'}
                    </td>
                    <td className="py-2 px-3">
                      {it.recipe_id ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-indigo-600"><ChefHat className="w-3 h-3" />Recipe</span>
                      ) : it.material_id ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-purple-600"><Package className="w-3 h-3" />Direct</span>
                      ) : (
                        <span className="text-[10px] text-[#C4B09A]">—</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-center">
                      <button onClick={() => toggleActive(it)} className={`text-[10px] px-2 py-0.5 rounded-full border ${it.is_active ? 'bg-green-100 text-green-700 border-green-200' : 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                        {it.is_active ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => setEditItem(it)} className="p-1 text-[#6B5744] hover:text-[#af4408]"><Edit className="w-3.5 h-3.5" /></button>
                        <button onClick={() => deleteItem(it.id)} className="p-1 text-red-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filteredItems.length > 500 && (
            <div className="p-3 bg-amber-50 border-t border-amber-200 text-xs text-amber-800 text-center">
              Showing first 500 of {filteredItems.length} results. Use filters to narrow down.
            </div>
          )}
        </div>
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
              </div>

              {/* Drop zone */}
              <div onClick={() => importFileRef.current?.click()} className="border-2 border-dashed border-[#D4B896] hover:border-purple-600 hover:bg-purple-50/30 rounded-xl p-8 text-center cursor-pointer transition-colors">
                <FileSpreadsheet className="w-10 h-10 text-purple-500 mx-auto mb-3" />
                <p className="text-[#6B5744] font-medium">{importFileName || 'Click to select Excel file'}</p>
                <p className="text-xs text-[#8B7355] mt-1">Looks for sheet named "Existing Product" or "Products"</p>
                <input ref={importFileRef} type="file" accept=".xlsx,.xls" onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); }} className="hidden" />
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

function StatCard({ label, value, color, icon }: { label: string; value: number; color: string; icon?: React.ReactNode }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 shadow-sm">
      <p className="text-[10px] text-[#8B7355] uppercase tracking-wide flex items-center gap-1">{icon}{label}</p>
      <p className={`text-xl font-bold ${color} mt-1`}>{value}</p>
    </div>
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

function IssueChip({ active, onClick, color, count, label }: { active: boolean; onClick: () => void; color: string; count: number; label: string }) {
  const colors: Record<string, string> = {
    red: active ? 'bg-red-600 text-white border-red-600' : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100',
    amber: active ? 'bg-amber-500 text-white border-amber-500' : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100',
    orange: active ? 'bg-orange-500 text-white border-orange-500' : 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100',
    blue: active ? 'bg-blue-600 text-white border-blue-600' : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100',
  };
  return (
    <button onClick={onClick} className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${colors[color]}`}>
      <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold ${active ? 'bg-white/25' : 'bg-white'}`}>{count}</span>
      {label}
    </button>
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
      <div className="relative w-full max-w-2xl bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4]">
          <h2 className="text-lg font-semibold text-[#2D1B0E]">{isNew ? 'New Menu Item' : 'Edit Menu Item'}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#FFF1E3]"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-6 py-5 space-y-4">
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
                      onChange={e => { const t = e.target.value; setForm({ ...form, item_type: t, tax_value: t === 'liquors' ? 0 : 5 }); }}
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
              <label className="block text-xs font-medium text-[#6B5744] mb-1">GST %</label>
              <input type="number" step="0.01" value={form.tax_value} onChange={e => setForm({ ...form, tax_value: Number(e.target.value) })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
              <p className="text-[10px] text-[#8B7355] mt-0.5">Food &amp; Beverages 5% · Liquor 0%. Auto-set by Type; override if needed.</p>
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
                  <option value={0}>None</option><option value={1}>Mild</option><option value={2}>Medium</option><option value={3}>Hot</option>
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
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B5744] bg-[#FFF1E3] rounded-lg hover:bg-[#E8D5C4]">Cancel</button>
            <button onClick={save} disabled={saving || !form.name} className="flex items-center gap-2 px-5 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-sm font-medium">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
