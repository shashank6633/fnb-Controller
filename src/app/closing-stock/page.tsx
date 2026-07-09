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
import {
  MapPin,
  Loader2,
  Save,
  ChevronLeft,
  Package,
  CheckCircle2,
  ClipboardCheck,
  X,
  Search,
  AlertTriangle,
  TrendingDown,
  TrendingUp,
  Minus,
  CheckCircle,
  AlertCircle,
  Download,
  Upload,
} from 'lucide-react';
import Papa from 'papaparse';
import { api } from '@/lib/api';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* Closing-stock UPDATE modal helpers (moved from Raw Materials page)  */
/* ------------------------------------------------------------------ */

// Kept in sync with the Raw Materials page — drives category chips/labels in
// the Record Closing Stock modal below.
const CATEGORIES = [
  'veg',
  'non-veg',
  'bar',
  'grocery',
  'dairy',
  'bakery',
  'spices',
  'beverages',
  'packaging',
  'other',
] as const;

const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  veg: { bg: 'bg-green-500/15', text: 'text-green-400' },
  'non-veg': { bg: 'bg-red-500/15', text: 'text-red-400' },
  bar: { bg: 'bg-purple-500/15', text: 'text-purple-400' },
  grocery: { bg: 'bg-amber-500/15', text: 'text-amber-400' },
  dairy: { bg: 'bg-blue-500/15', text: 'text-[#af4408]' },
  bakery: { bg: 'bg-orange-500/15', text: 'text-orange-400' },
  spices: { bg: 'bg-yellow-500/15', text: 'text-yellow-400' },
  beverages: { bg: 'bg-cyan-500/15', text: 'text-cyan-400' },
  packaging: { bg: 'bg-slate-500/15', text: 'text-[#8B7355]' },
  other: { bg: 'bg-gray-500/15', text: 'text-gray-400' },
};

function formatCurrency(value: number): string {
  return '₹' + value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function categoryLabel(cat: string): string {
  return cat
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
}

interface LocSummary { location: string; items: number; counted_today: number; low_stock: number; }
interface Item {
  id: string; sku?: string; name: string; unit: string; purchase_unit?: string; pack_size?: number; case_size?: number;
  current_stock: number; average_price: number; reorder_level?: number;
  super_category?: string; category?: string; closing_cadence?: string; shelf_life_days?: number;
  today_count: number | null; today_variance: number | null; today_by?: string;
}

export default function ClosingStockByLocationPage() {
  // Role gate — only admins see the "adjust system stock to match" shortcut.
  // Store managers would otherwise just click it without a physical recount,
  // which defeats the purpose of the closing-stock workflow.
  const [meRole, setMeRole] = useState<string | null>(null);
  // Full viewer so we can scope closing stock per-department. A plain department
  // user (staff, not head-chef / store-manager) only counts their OWN department;
  // Admin / Manager / HOD (head-chef) / Store Manager may pick any department and
  // see the per-area rollup.
  const [me, setMe] = useState<any>(null);
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => { setMe(d?.user || null); setMeRole(d?.user?.role || null); }).catch(() => {});
  }, []);
  const isAdmin = meRole === 'admin';
  // Can this viewer see/update ALL departments (and the rollup)?
  const canSeeAllDepts = !!me && (me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef || !!me.is_store_manager);
  // The department a plain user is locked to (their own). null = store/overall.
  const ownDeptId: string | null = me?.department_id || null;

  // Departments list (for the admin/HOD selector) + the currently-selected dept.
  // '' means store / overall (no owning department).
  const [departments, setDepartments] = useState<any[]>([]);
  const [selectedDept, setSelectedDept] = useState<string>('');
  useEffect(() => {
    if (!me) return;
    // Plain department users are pinned to their own department.
    if (!canSeeAllDepts) { setSelectedDept(ownDeptId || ''); return; }
    fetch('/api/departments').then(r => r.json()).then(d => {
      setDepartments((d?.departments || []).filter((x: any) => x.is_active));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);
  // The department_id sent on POST to scope saved counts. Plain users → own dept.
  const activeDeptId: string = canSeeAllDepts ? selectedDept : (ownDeptId || '');
  const [date, setDate] = useState(today());
  const [locations, setLocations] = useState<LocSummary[]>([]);
  const [totals, setTotals] = useState({ locations: 0, items: 0, counted: 0 });
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [entries, setEntries] = useState<Record<string, string>>({});
  // Three count levels so liquor can be entered the way it's physically counted:
  //   cases   → full outer cases (case_size bottles each)
  //   entries → individual bottles / purchase units (pack_size recipe-units each)
  //   loose   → loose / open recipe units (e.g. 450 ml left in an open bottle)
  // e.g. whisky 2 cases + 9 bottles + 450 ml = 2×12×750 + 9×750 + 450 = 25,200 ml.
  const [cases, setCases] = useState<Record<string, string>>({});
  const [loose, setLoose] = useState<Record<string, string>>({});
  const [adjustStock, setAdjustStock] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState('');
  const [filterUncountedOnly, setFilterUncountedOnly] = useState(false);
  // Category filter — narrows the detail-view item list to one super_category
  // (or category fallback). Empty string = all categories. Item search box
  // filters within the selected category.
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [itemSearch, setItemSearch] = useState<string>('');

  /* ---- Closing-stock UPDATE modal (moved from Raw Materials page) ---- */
  // Full raw-material list — only fetched when the modal opens so the
  // location-count workflow above stays lightweight.
  const [materials, setMaterials] = useState<any[]>([]);
  const [closingStockOpen, setClosingStockOpen] = useState(false);
  const [closingDate, setClosingDate] = useState(new Date().toISOString().split('T')[0]);
  const [closingItems, setClosingItems] = useState<Record<string, { physical_stock: string; notes: string }>>({});
  const [closingSearch, setClosingSearch] = useState('');
  const [closingCategory, setClosingCategory] = useState('');
  const [adjustStockModal, setAdjustStockModal] = useState(false);
  const [closingSubmitting, setClosingSubmitting] = useState(false);
  const [closingResult, setClosingResult] = useState<{ success: number; errors: string[] } | null>(null);
  const [closingHistory, setClosingHistory] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyDate, setHistoryDate] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<any[]>([]);
  const [historySummary, setHistorySummary] = useState<any>(null);
  // Per-area rollup (admin/HOD only) — each area's overall physical closing value
  // for the selected date. Sourced from summary.by_area on /api/closing-stock.
  const [byArea, setByArea] = useState<any[]>([]);
  const AREA_LABELS: Record<string, string> = {
    kitchen: 'Kitchen', bar: 'Bar', store: 'Store', service: 'Service / Ops', other: 'Other', __store__: 'Store / Overall',
  };

  /** Category options grouped by super_category so the modal dropdown renders
   *  with <optgroup> headers. Mirrors the derivation on the Raw Materials page. */
  const availableCategories = useMemo(() => {
    const live = new Set(materials.map(m => (m.category || '').trim()).filter(Boolean));
    const all = new Set<string>([...CATEGORIES, ...live]);
    return Array.from(all).sort((a, b) => a.localeCompare(b));
  }, [materials]);

  const categoryGroups = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const m of materials) {
      const cat = (m.category || '').trim();
      if (!cat) continue;
      const sup = ((m as any).super_category || '').trim() || '(Other)';
      if (!map.has(sup)) map.set(sup, new Set());
      map.get(sup)!.add(cat);
    }
    for (const c of availableCategories) {
      const found = Array.from(map.values()).some(set => set.has(c));
      if (!found) {
        if (!map.has('(Other)')) map.set('(Other)', new Set());
        map.get('(Other)')!.add(c);
      }
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => (a === '(Other)' ? 1 : b === '(Other)' ? -1 : a.localeCompare(b)))
      .map(([sup, set]) => ({ sup, cats: Array.from(set).sort((a, b) => a.localeCompare(b)) }));
  }, [materials, availableCategories]);

  const fetchMaterials = async () => {
    try {
      // Closing stock is a PHYSICAL count organised by storage location — a
      // single location (walk-in chiller, dry store, bar counter) holds items
      // from many departments. So the counter must see every category/material
      // regardless of their own department's whitelist. scope=all bypasses the
      // dept-category filter, matching the (already unfiltered) by-location view.
      const res = await fetch('/api/inventory?scope=all');
      if (res.ok) {
        const json = await res.json();
        setMaterials(json.materials ?? []);
        return json.materials ?? [];
      }
    } catch (_) {}
    return [];
  };

  const openClosingStock = async () => {
    setClosingStockOpen(true);
    setClosingDate(new Date().toISOString().split('T')[0]);
    setClosingResult(null);
    setClosingSearch('');
    setClosingCategory('');
    setShowHistory(false);
    // Pull the full material list, then pre-seed an empty entry per material.
    const list = await fetchMaterials();
    const seed: Record<string, { physical_stock: string; notes: string }> = {};
    for (const m of list) {
      seed[m.id] = { physical_stock: '', notes: '' };
    }
    setClosingItems(seed);
    fetchClosingHistory();
  };

  const fetchClosingHistory = async () => {
    try {
      const res = await fetch('/api/closing-stock');
      if (res.ok) {
        const json = await res.json();
        setClosingHistory(json.dates || []);
      }
    } catch (_) {}
  };

  const viewHistoryDate = async (d: string) => {
    setHistoryDate(d);
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/closing-stock?date=${d}`);
      if (res.ok) {
        const json = await res.json();
        setHistoryItems(json.items || []);
        setHistorySummary(json.summary || null);
        setByArea(json.summary?.by_area || []);
      }
    } catch (_) {}
    setHistoryLoading(false);
  };

  const updateClosingItem = (materialId: string, field: 'physical_stock' | 'notes', value: string) => {
    setClosingItems(prev => ({
      ...prev,
      [materialId]: { ...prev[materialId], [field]: value },
    }));
  };

  const submitClosingStock = async () => {
    setClosingSubmitting(true);
    setClosingResult(null);
    try {
      const itemsToSubmit = Object.entries(closingItems)
        .filter(([_, v]) => v.physical_stock !== '')
        .map(([materialId, v]) => ({
          material_id: materialId,
          physical_stock: parseFloat(v.physical_stock),
          notes: v.notes,
        }));

      if (itemsToSubmit.length === 0) {
        setClosingResult({ success: 0, errors: ['Enter physical stock for at least one material'] });
        setClosingSubmitting(false);
        return;
      }

      const res = await api('/api/closing-stock', {
        method: 'POST',
        // department_id scopes this batch of counts to the active department
        // ('' = store/overall). Plain users are pinned to their own department.
        body: { date: closingDate, items: itemsToSubmit, adjust_stock: adjustStockModal, department_id: activeDeptId },
      });
      const json = await res.json();
      setClosingResult(json);
      if (json.success > 0) {
        await fetchMaterials();
        await fetchClosingHistory();
        await reloadLocations();
      }
    } catch (err: any) {
      setClosingResult({ success: 0, errors: [err.message] });
    } finally {
      setClosingSubmitting(false);
    }
  };

  // --- CSV template download + bulk upload -----------------------------
  // Mirror the modal's manual save exactly: physical_stock is a plain number
  // in the material's RECIPE unit (m.unit), matched to a material by id, and
  // POSTed to the same /api/closing-stock endpoint. adjust_stock is FORCED
  // off for the CSV path — a bulk file must never overwrite system stock.
  const csvEscape = (v: any) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const CSV_COLS = ['material_id', 'SKU', 'Name', 'Category', 'Unit', 'System stock', 'Physical count'];
  const downloadClosingTemplate = async () => {
    let mats = materials;
    if (!mats.length) mats = await fetchMaterials();
    const lines = [CSV_COLS.join(',')];
    for (const m of mats) {
      lines.push([
        m.id, m.sku || '', m.name || '',
        (m.super_category || m.category || ''), m.unit || '',
        m.current_stock ?? 0, '',   // Physical count — left blank for the counter
      ].map(csvEscape).join(','));
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `closing-stock-template-${closingDate}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
  const uploadClosingCsv = async (file: File) => {
    setClosingSubmitting(true);
    setClosingResult(null);
    try {
      let mats = materials;
      if (!mats.length) mats = await fetchMaterials();
      const byId = new Map(mats.map(m => [String(m.id), m]));
      const bySku = new Map(mats.filter(m => m.sku).map(m => [String(m.sku).trim().toLowerCase(), m]));
      const byName = new Map(mats.map(m => [String(m.name).trim().toLowerCase(), m]));
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      if (parsed.errors?.length) {
        setClosingResult({ success: 0, errors: ['CSV parse error: ' + parsed.errors[0].message] });
        return;
      }
      const rows = parsed.data as any[];
      const items: { material_id: string; physical_stock: number }[] = [];
      const errors: string[] = [];
      const get = (row: any, ...keys: string[]) => {
        for (const k of keys) if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
        return '';
      };
      for (const row of rows) {
        const pc = get(row, 'Physical count', 'Physical Count', 'physical_count', 'physical count');
        if (pc === '') continue;                               // blank = not counted → skip
        const label = get(row, 'Name', 'name') || get(row, 'material_id') || get(row, 'SKU', 'sku') || 'row';
        const qty = parseFloat(pc);
        if (isNaN(qty) || qty < 0) { errors.push(`${label}: invalid physical count "${pc}"`); continue; }
        const idKey = get(row, 'material_id');
        const skuKey = get(row, 'SKU', 'sku').toLowerCase();
        const nameKey = get(row, 'Name', 'name').toLowerCase();
        const m = (idKey && byId.get(idKey)) || (skuKey && bySku.get(skuKey)) || (nameKey && byName.get(nameKey));
        if (!m) { errors.push(`${label}: material not found (check material_id / SKU / Name)`); continue; }
        items.push({ material_id: m.id, physical_stock: qty });
      }
      if (items.length === 0) {
        setClosingResult({ success: 0, errors: errors.length ? errors : ['No physical counts found in the file'] });
        return;
      }
      const res = await api('/api/closing-stock', {
        method: 'POST',
        body: { date: closingDate, items, adjust_stock: false, department_id: activeDeptId },
      });
      const json = await res.json();
      setClosingResult({ success: json.success || 0, errors: [...errors, ...(json.errors || [])] });
      if (json.success > 0) {
        await fetchMaterials();
        await fetchClosingHistory();
        await reloadLocations();
      }
    } catch (err: any) {
      setClosingResult({ success: 0, errors: [err.message] });
    } finally {
      setClosingSubmitting(false);
    }
  };

  const closingFiltered = materials.filter(m => {
    if (closingSearch) {
      if (!m.name.toLowerCase().includes(closingSearch.toLowerCase())) return false;
    }
    if (closingCategory && m.category !== closingCategory) return false;
    return true;
  });

  const reloadLocations = async () => {
    setLoading(true);
    const d = await fetch(`/api/closing-stock/locations?date=${date}`).then(r => r.json());
    setLocations(d.locations || []);
    setTotals(d.totals || { locations: 0, items: 0, counted: 0 });
    setLoading(false);
  };
  useEffect(() => { reloadLocations(); /* eslint-disable-next-line */ }, [date]);

  // Per-area rollup for the top-level date — admin / HOD / store-manager only.
  // Uses the summary.by_area block, which is date-scoped and independent of any
  // department filter, so it always reflects every area's overall closing value.
  const reloadRollup = async () => {
    if (!canSeeAllDepts) { setByArea([]); return; }
    try {
      const json = await fetch(`/api/closing-stock?date=${date}`).then(r => r.json());
      setByArea(json?.summary?.by_area || []);
    } catch { setByArea([]); }
  };
  useEffect(() => { reloadRollup(); /* eslint-disable-next-line */ }, [date, canSeeAllDepts]);

  const openLocation = async (loc: string) => {
    setActive(loc);
    setItemsLoading(true);
    setEntries({});
    setCases({});
    setLoose({});
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

  // Total physical count in RECIPE units:
  //   cases × (case_size × pack_size) + bottles × pack_size + loose units.
  const physicalFor = (it: Item, casesRaw?: string, bottlesRaw?: string, looseRaw?: string): number | null => {
    const packSize = it.pack_size && it.pack_size > 1 ? it.pack_size : 1;
    const caseSize = it.case_size && it.case_size > 1 ? it.case_size : 1;
    const num = (s?: string) => (s != null && s !== '' && !isNaN(Number(s))) ? Number(s) : null;
    const c = num(casesRaw), b = num(bottlesRaw), l = num(looseRaw);
    if (c == null && b == null && l == null) return null;
    return (c ?? 0) * caseSize * packSize + (b ?? 0) * packSize + (l ?? 0);
  };

  const pendingEntries = useMemo(() => {
    const out: { material_id: string; physical: number }[] = [];
    for (const it of items) {
      const phys = physicalFor(it, cases[it.id], entries[it.id], loose[it.id]);
      if (phys != null) out.push({ material_id: it.id, physical: phys });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, cases, entries, loose]);

  const saveAll = async () => {
    if (pendingEntries.length === 0) return;
    setSaving(true);
    try {
      const payload = pendingEntries.map(({ material_id, physical }) => ({ material_id, physical_stock: physical }));
      const r = await api('/api/closing-stock', {
        method: 'POST',
        // Scope these location counts to the active department ('' = store/overall).
        body: { date, items: payload, adjust_stock: adjustStock, department_id: activeDeptId },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(j.error || 'Save failed');
      } else {
        setSavedFlash(`✓ Saved ${j.success} count${j.success === 1 ? '' : 's'} for "${active}"`);
        setEntries({});
        setCases({});
        setLoose({});
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
                    <th className="text-left  py-2 px-3 font-medium w-[280px]">Physical count <span className="font-normal text-[9px] text-[#8B7355]">(packs + loose)</span></th>
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
                          {(() => {
                            const packSize = it.pack_size && it.pack_size > 1 ? it.pack_size : 1;
                            const caseSize = it.case_size && it.case_size > 1 ? it.case_size : 1;
                            const showCases = caseSize > 1;   // outer case of bottles
                            const showLoose = packSize > 1;   // open/partial bottle (ml/g)
                            const box = "w-12 px-1 py-1 border border-[#D4B896] rounded text-xs text-right font-mono bg-white focus:outline-none focus:ring-1 focus:ring-[#af4408]";
                            // Simple item (no case, no pack) — one box in the recipe unit.
                            if (!showCases && !showLoose) {
                              return (
                                <div className="flex items-center gap-1">
                                  <input type="number" step="any" min={0}
                                         value={entries[it.id] ?? (it.today_count != null ? String(it.today_count) : '')}
                                         onChange={e => setEntries(p => ({ ...p, [it.id]: e.target.value }))}
                                         placeholder={`count in ${it.unit}`}
                                         className="w-32 px-2 py-1 border border-[#D4B896] rounded text-xs text-right font-mono bg-white focus:outline-none focus:ring-1 focus:ring-[#af4408]" />
                                  <span className="text-[10px] text-[#8B7355]">{it.unit}</span>
                                </div>
                              );
                            }
                            const total = physicalFor(it, cases[it.id], entries[it.id], loose[it.id]);
                            return (
                              <div className="flex items-center gap-1 flex-wrap">
                                {showCases && (<>
                                  <input type="number" step="any" min={0} value={cases[it.id] ?? ''}
                                         onChange={e => setCases(p => ({ ...p, [it.id]: e.target.value }))}
                                         placeholder="0"
                                         title={`Full cases — 1 case = ${caseSize} ${it.purchase_unit || 'unit'} = ${caseSize * packSize} ${it.unit}`}
                                         className={box} />
                                  <span className="text-[10px] text-[#8B7355]">case</span>
                                  <span className="text-[10px] text-[#8B7355]">+</span>
                                </>)}
                                <input type="number" step="any" min={0} value={entries[it.id] ?? ''}
                                       onChange={e => setEntries(p => ({ ...p, [it.id]: e.target.value }))}
                                       placeholder="0"
                                       title={`${it.purchase_unit || 'unit'} — 1 = ${packSize} ${it.unit}`}
                                       className={box} />
                                <span className="text-[10px] text-[#8B7355]">{it.purchase_unit || it.unit}</span>
                                {showLoose && (<>
                                  <span className="text-[10px] text-[#8B7355]">+</span>
                                  <input type="number" step="any" min={0} value={loose[it.id] ?? ''}
                                         onChange={e => setLoose(p => ({ ...p, [it.id]: e.target.value }))}
                                         placeholder="0"
                                         title={`Loose / open ${it.unit}`}
                                         className={box} />
                                  <span className="text-[10px] text-[#8B7355]">{it.unit}</span>
                                </>)}
                                {total != null && (
                                  <span className="text-[10px] font-mono text-[#af4408] whitespace-nowrap">= {total} {it.unit}</span>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono">
                          {(() => {
                            const phys = physicalFor(it, cases[it.id], entries[it.id], loose[it.id]) ?? it.today_count;
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
                          ) : (cases[it.id] || entries[it.id] || loose[it.id]) ? (
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
            <a href="/inventory" className="text-[#af4408] underline">Raw Materials</a>.
          </p>
        </div>
        <button
          onClick={openClosingStock}
          className="flex items-center gap-2 px-4 py-2.5 border border-green-600 text-green-700 hover:bg-green-50 rounded-lg text-sm font-medium transition-colors"
        >
          <ClipboardCheck className="w-4 h-4" />
          Update / Record Closing Stock
        </button>
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

      {/* Department scope — who's count is being viewed/recorded. Admin / Manager /
          HOD / Store Manager may pick any department (or the store/overall bucket);
          a plain department user is pinned to their own department. */}
      {canSeeAllDepts ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="text-xs font-medium text-[#6B5744]">Counting for department</span>
          <select value={selectedDept} onChange={e => setSelectedDept(e.target.value)}
                  className="px-2 py-1.5 border border-[#D4B896] rounded text-sm bg-white">
            <option value="">— Store / Overall —</option>
            {departments.map(d => (
              <option key={d.id} value={d.id}>
                {d.name}{d.area ? ` · ${AREA_LABELS[d.area] || d.area}` : ''}
              </option>
            ))}
          </select>
          <span className="text-[10px] text-[#8B7355]">
            Counts you save below are recorded against this department.
          </span>
        </div>
      ) : ownDeptId ? (
        <div className="bg-[#FFF1E3] border border-[#D4B896] rounded-xl px-4 py-2.5 text-xs text-[#6B5744]">
          You are recording closing stock for your own department only.
        </div>
      ) : null}

      {/* Per-area rollup — admin/HOD view of each area's overall closing value. */}
      {canSeeAllDepts && byArea.length > 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
          <div className="text-xs font-semibold text-[#2D1B0E] mb-2">Area rollup — physical closing value ({date})</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {byArea.map((a: any) => (
              <div key={a.area} className="border border-[#E8D5C4] rounded-lg p-3 bg-[#FFF8F0]">
                <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">{AREA_LABELS[a.area] || a.area}</div>
                <div className="text-lg font-semibold text-[#2D1B0E] mt-1">{fmt(a.physical_value)}</div>
                <div className="text-[10px] text-[#8B7355] mt-0.5">{a.item_count} item{a.item_count === 1 ? '' : 's'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

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
      {/* ================================================================ */}
      {/* CLOSING STOCK MODAL (moved from Raw Materials page)              */}
      {/* ================================================================ */}
      {closingStockOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-4 pb-4 overflow-y-auto">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setClosingStockOpen(false)} />
          <div className="relative w-full max-w-6xl bg-white rounded-2xl shadow-xl border border-[#E8D5C4] mx-4 my-4">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] sticky top-0 bg-white rounded-t-2xl z-20">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-100">
                  <ClipboardCheck className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[#2D1B0E]">Record Closing Stock</h2>
                  <p className="text-xs text-[#8B7355]">Enter physical count for each material</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                {!showHistory && (
                  <>
                    {/* Download a template pre-filled with current stock, count
                        offline in Excel, then upload the filled file back. */}
                    <button
                      onClick={downloadClosingTemplate}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[#FFF1E3] text-[#6B5744] hover:bg-[#E8D5C4] inline-flex items-center gap-1"
                      title="Download a CSV of current stock with a blank Physical count column"
                    >
                      <Download className="w-3.5 h-3.5" /> Template
                    </button>
                    <label
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[#FFF1E3] text-[#6B5744] hover:bg-[#E8D5C4] inline-flex items-center gap-1 cursor-pointer"
                      title="Upload the filled CSV to record physical counts in bulk"
                    >
                      <Upload className="w-3.5 h-3.5" /> Upload CSV
                      <input
                        type="file" accept=".csv,text/csv" className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) uploadClosingCsv(f); e.target.value = ''; }}
                      />
                    </label>
                  </>
                )}
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${showHistory ? 'bg-purple-100 text-purple-700' : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#E8D5C4]'}`}
                >
                  {showHistory ? 'Back to Entry' : 'View History'}
                </button>
                <button onClick={() => setClosingStockOpen(false)} className="p-1 text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
              </div>
            </div>

            {showHistory ? (
              /* History View */
              <div className="px-6 py-5 space-y-4">
                {closingHistory.length === 0 ? (
                  <div className="text-center py-12 text-[#8B7355]">
                    <ClipboardCheck className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p>No closing stock records found</p>
                  </div>
                ) : !historyDate ? (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-[#2D1B0E]">Closing Stock Records</h3>
                    {closingHistory.map((h: any) => (
                      <div
                        key={h.date}
                        onClick={() => viewHistoryDate(h.date)}
                        className="bg-white border border-[#E8D5C4] rounded-lg p-4 cursor-pointer hover:shadow-md transition-shadow"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-semibold text-[#2D1B0E]">{new Date(h.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}</p>
                            <p className="text-xs text-[#8B7355]">{h.item_count} items recorded</p>
                          </div>
                          <div className="flex items-center gap-4 text-xs">
                            {h.shortage_count > 0 && (
                              <span className="flex items-center gap-1 text-red-500"><TrendingDown className="w-3 h-3" />{h.shortage_count} shortage</span>
                            )}
                            {h.excess_count > 0 && (
                              <span className="flex items-center gap-1 text-blue-500"><TrendingUp className="w-3 h-3" />{h.excess_count} excess</span>
                            )}
                            <span className="text-[#af4408] font-semibold">Variance: {formatCurrency(h.total_variance_value)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : historyLoading ? (
                  <div className="text-center py-12"><Loader2 className="w-8 h-8 text-[#af4408] animate-spin mx-auto" /></div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <button onClick={() => setHistoryDate(null)} className="text-xs text-[#af4408] hover:underline mb-1">&larr; Back to dates</button>
                        <h3 className="text-sm font-semibold text-[#2D1B0E]">
                          Closing Stock — {new Date(historyDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}
                        </h3>
                      </div>
                      {historySummary && (
                        <div className="flex gap-4 text-xs">
                          <span className="text-[#6B5744]">Items: <span className="font-bold">{historySummary.total_items}</span></span>
                          <span className="text-red-500">Shortage: <span className="font-bold">{historySummary.shortage_count}</span></span>
                          <span className="text-blue-500">Excess: <span className="font-bold">{historySummary.excess_count}</span></span>
                          <span className="text-[#af4408]">Variance Value: <span className="font-bold">{formatCurrency(Math.abs(historySummary.total_variance_value))}</span></span>
                        </div>
                      )}
                    </div>
                    <div className="overflow-x-auto max-h-[60vh] overflow-y-auto rounded-lg border border-[#E8D5C4]">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-[#FFF1E3] z-10">
                          <tr className="text-[#8B7355]">
                            <th className="text-left py-2.5 px-3 font-medium">Material</th>
                            <th className="text-left py-2.5 px-3 font-medium">Category</th>
                            <th className="text-right py-2.5 px-3 font-medium">System Stock</th>
                            <th className="text-right py-2.5 px-3 font-medium">Physical Stock</th>
                            <th className="text-right py-2.5 px-3 font-medium">Variance</th>
                            <th className="text-right py-2.5 px-3 font-medium">Variance (₹)</th>
                            <th className="text-left py-2.5 px-3 font-medium">Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {historyItems.map((item: any) => {
                            const isShortage = item.variance < 0;
                            const isExcess = item.variance > 0;
                            return (
                              <tr key={item.id} className={`border-t border-[#E8D5C4]/50 ${isShortage ? 'bg-red-50/50' : isExcess ? 'bg-blue-50/50' : ''}`}>
                                <td className="py-2 px-3 text-[#2D1B0E] font-medium text-xs">{item.material_name}</td>
                                <td className="py-2 px-3 text-xs text-[#6B5744]">{categoryLabel(item.category)}</td>
                                <td className="py-2 px-3 text-right text-xs font-mono">{item.system_stock} {item.unit}</td>
                                <td className="py-2 px-3 text-right text-xs font-mono font-semibold">{item.physical_stock} {item.unit}</td>
                                <td className={`py-2 px-3 text-right text-xs font-mono font-semibold ${isShortage ? 'text-red-500' : isExcess ? 'text-blue-500' : 'text-green-600'}`}>
                                  {item.variance > 0 ? '+' : ''}{item.variance} {item.unit}
                                </td>
                                <td className={`py-2 px-3 text-right text-xs font-mono ${isShortage ? 'text-red-500' : isExcess ? 'text-blue-500' : 'text-green-600'}`}>
                                  {item.variance_value > 0 ? '+' : ''}{formatCurrency(item.variance_value)}
                                </td>
                                <td className="py-2 px-3 text-xs text-[#8B7355]">{item.notes || '-'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Entry View */
              <div className="px-6 py-5 space-y-4">
                {/* Date & Options — wrap so the 5 controls never overflow or
                    overlap on narrow/tablet widths (they stack/wrap instead). */}
                <div className="flex flex-wrap gap-4 items-end">
                  <div>
                    <label className="block text-xs font-medium text-[#6B5744] mb-1">Closing Date *</label>
                    <input
                      type="date"
                      value={closingDate}
                      onChange={e => setClosingDate(e.target.value)}
                      className="px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408] [color-scheme:light]"
                    />
                  </div>
                  {/* Department scope — same selection as the grid header. Admin /
                      HOD pick any department; plain users are shown read-only. */}
                  <div>
                    <label className="block text-xs font-medium text-[#6B5744] mb-1">Department</label>
                    {canSeeAllDepts ? (
                      <select
                        value={selectedDept}
                        onChange={e => setSelectedDept(e.target.value)}
                        className="px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
                      >
                        <option value="">Store / Overall</option>
                        {departments.map(d => (
                          <option key={d.id} value={d.id}>
                            {d.name}{d.area ? ` · ${AREA_LABELS[d.area] || d.area}` : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#6B5744]">
                        {departments.find(d => d.id === ownDeptId)?.name || 'Your department'}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-[180px]">
                    <label className="block text-xs font-medium text-[#6B5744] mb-1">Search Material</label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
                      <input
                        type="text"
                        value={closingSearch}
                        onChange={e => setClosingSearch(e.target.value)}
                        placeholder="Filter by name..."
                        className="w-full pl-10 pr-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] placeholder-[#8B7355] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B5744] mb-1">Category</label>
                    <select
                      value={closingCategory}
                      onChange={e => setClosingCategory(e.target.value)}
                      className="px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
                    >
                      <option value="">All Categories</option>
                      {categoryGroups.map(g => (
                        <optgroup key={g.sup} label={g.sup}>
                          {g.cats.map(c => <option key={c} value={c}>{categoryLabel(c)}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  {/* Only admins may overwrite system stock from a count. The
                      server also forces adjust_stock=false for non-admins (see
                      /api/closing-stock POST), so hiding it here just matches. */}
                  {isAdmin && (
                    <label className="flex items-center gap-2 cursor-pointer bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <input type="checkbox" checked={adjustStockModal} onChange={e => setAdjustStockModal(e.target.checked)} className="accent-[#af4408] w-4 h-4" />
                      <span className="text-xs text-amber-800 font-medium whitespace-nowrap">Adjust system stock</span>
                    </label>
                  )}
                </div>

                {adjustStockModal && (
                  <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    System stock will be updated to match physical counts. Variances will be logged as inventory adjustments.
                  </div>
                )}

                {/* Materials Table */}
                <div className="overflow-x-auto max-h-[55vh] overflow-y-auto rounded-lg border border-[#E8D5C4]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-[#FFF1E3] z-10">
                      <tr className="text-[#8B7355]">
                        <th className="text-left py-2.5 px-3 font-medium">Material</th>
                        <th className="text-left py-2.5 px-3 font-medium">Category</th>
                        <th className="text-right py-2.5 px-3 font-medium">System Stock</th>
                        <th className="text-right py-2.5 px-3 font-medium">Unit</th>
                        <th className="text-right py-2.5 px-3 font-medium w-32">Physical Count *</th>
                        <th className="text-right py-2.5 px-3 font-medium">Variance</th>
                        <th className="text-left py-2.5 px-3 font-medium w-40">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {closingFiltered.map((m) => {
                        const ci = closingItems[m.id];
                        const physicalVal = ci ? parseFloat(ci.physical_stock) : NaN;
                        const variance = !isNaN(physicalVal) ? Math.round((physicalVal - m.current_stock) * 1000) / 1000 : null;
                        const isShortage = variance !== null && variance < 0;
                        const isExcess = variance !== null && variance > 0;
                        return (
                          <tr key={m.id} className={`border-t border-[#E8D5C4]/50 ${isShortage ? 'bg-red-50/30' : isExcess ? 'bg-blue-50/30' : ''}`}>
                            <td className="py-1.5 px-3 text-[#2D1B0E] font-medium text-xs">{m.name}</td>
                            <td className="py-1.5 px-3">
                              <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${CATEGORY_COLORS[m.category]?.bg || ''} ${CATEGORY_COLORS[m.category]?.text || ''}`}>
                                {categoryLabel(m.category)}
                              </span>
                            </td>
                            <td className="py-1.5 px-3 text-right text-xs font-mono text-[#2D1B0E]">{m.current_stock}</td>
                            <td className="py-1.5 px-3 text-right text-xs text-[#8B7355]">{m.unit}</td>
                            <td className="py-1.5 px-2">
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={ci?.physical_stock || ''}
                                onChange={e => updateClosingItem(m.id, 'physical_stock', e.target.value)}
                                placeholder={m.current_stock.toString()}
                                className="w-full px-2 py-1 bg-white border border-[#D4B896] rounded text-xs text-right font-mono text-[#2D1B0E] focus:outline-none focus:ring-1 focus:ring-[#af4408] placeholder-[#C4B09A]"
                              />
                            </td>
                            <td className={`py-1.5 px-3 text-right text-xs font-mono font-semibold ${isShortage ? 'text-red-500' : isExcess ? 'text-blue-500' : variance === 0 ? 'text-green-600' : 'text-[#8B7355]'}`}>
                              {variance !== null ? (
                                <span className="flex items-center justify-end gap-1">
                                  {isShortage && <TrendingDown className="w-3 h-3" />}
                                  {isExcess && <TrendingUp className="w-3 h-3" />}
                                  {variance === 0 && <Minus className="w-3 h-3" />}
                                  {variance > 0 ? '+' : ''}{variance} {m.unit}
                                </span>
                              ) : '-'}
                            </td>
                            <td className="py-1.5 px-2">
                              <input
                                type="text"
                                value={ci?.notes || ''}
                                onChange={e => updateClosingItem(m.id, 'notes', e.target.value)}
                                placeholder="Optional"
                                className="w-full px-2 py-1 bg-white border border-[#D4B896] rounded text-xs text-[#2D1B0E] placeholder-[#C4B09A] focus:outline-none focus:ring-1 focus:ring-[#af4408]"
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Submit */}
                <div className="flex items-center justify-between">
                  <p className="text-xs text-[#8B7355]">
                    {Object.values(closingItems).filter(v => v.physical_stock !== '').length} of {materials.length} items filled
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setClosingStockOpen(false)}
                      className="px-4 py-2 text-sm text-[#6B5744] bg-[#FFF1E3] rounded-lg hover:bg-[#E8D5C4] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={submitClosingStock}
                      disabled={closingSubmitting}
                      className="flex items-center gap-2 px-5 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      {closingSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
                      {closingSubmitting ? 'Saving...' : 'Save Closing Stock'}
                    </button>
                  </div>
                </div>

                {/* Result */}
                {closingResult && (
                  <div className={`p-3 rounded-lg border ${closingResult.errors.length > 0 && closingResult.success === 0 ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
                    <div className="flex items-start gap-2 text-sm">
                      {closingResult.success > 0 ? <CheckCircle className="w-4 h-4 text-green-600 mt-0.5" /> : <AlertCircle className="w-4 h-4 text-red-500 mt-0.5" />}
                      <div>
                        {closingResult.success > 0 && <p className="text-green-700">Closing stock recorded for {closingResult.success} items!</p>}
                        {closingResult.errors.map((e, i) => <p key={i} className="text-red-600 text-xs">{e}</p>)}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
