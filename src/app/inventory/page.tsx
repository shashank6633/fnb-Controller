'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Package,
  Plus,
  Search,
  AlertTriangle,
  Edit,
  Filter,
  X,
  Loader2,
  ArrowUpDown,
  IndianRupee,
  Layers,
  ChevronDown,
  Upload,
  CheckCircle,
  ClipboardCheck,
  Star,
  Sparkles,
} from 'lucide-react';
import Papa from 'papaparse';
import { api } from '@/lib/api';
import { packFactor } from '@/lib/pack-units';
import Toggle from '@/components/Toggle';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface RawMaterial {
  id: string;
  name: string;
  category: string;
  unit: string;
  current_stock: number;
  average_price: number;
  reorder_level: number;
  costing_method: string;
  last_purchase_price: number;
  last_purchase_date: string;
  total_consumed: number;
  stock_value: number;
  created_at: string;
  updated_at: string;
  is_auto_discovered?: number;
  discovered_source?: string;
  /** Priority stars: 3 = critical, 2 = standard, 1 = low (default 2). */
  priority?: number;
}

interface FormData {
  id?: string;
  name: string;
  sku?: string;        // Phase 1 §1: unique per material (auto-generated MAT-NNNNN if blank)
  category: string;
  unit: string;             // recipe / stock unit (canonical, drives recipe deduction)
  purchase_unit?: string;   // how the vendor invoices (BTL, CASE, etc.)
  pack_size?: number;       // recipe-units per purchase-unit (e.g. 750 ml per BTL)
  case_size?: number;       // purchase-units per outer pack (e.g. 12 BTL per CASE; default 1)
  reorder_level: number;
  costing_method: string;
  // ----- Phase 1 master fields -----
  super_category?: string;          // Meat / Seafood / Dairy / Liquor / etc.
  brand?: string;                   // explicit on master (was only on purchase rows)
  yield_percent?: number;           // default 100; meat/seafood get 98
  tax_percent?: number;             // GST %
  cess_percent?: number;            // additional cess (esp. liquor)
  standard_purchase_rate?: number;  // expected rate; PO above this needs mgmt approval
  closing_cadence?: 'daily' | 'weekly' | 'monthly' | 'none';
  is_recipe_item?: number;
  is_direct_sell?: number;
  is_semifinished?: number;
  storage_location?: string;   // where it lives (cold room A, dry store, bar fridge)
  shelf_life_days?: number;    // days from receipt; 0 = none / undefined
  priority?: number;           // 3★ critical / 2★ standard / 1★ low
  /** Editable in purchase-unit terms (e.g. ₹/kg). On save we divide by
   *  pack_size and store the per-recipe-unit value in raw_materials.average_price. */
  avg_price_per_purchase_unit?: number;
  /** Editable in purchase-unit terms (e.g. 5 kg or 2 BTL). On save we multiply
   *  by pack_size and store in recipe units (current_stock < reorder_level → low stock). */
  reorder_level_purchase_unit?: number;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

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

const UNITS = ['kg', 'g', 'ml', 'l', 'pcs', 'bottle', 'dozen', 'bunch'] as const;

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

const EMPTY_FORM: FormData = {
  name: '',
  category: 'other',
  unit: 'kg',
  purchase_unit: 'kg',
  pack_size: 1,
  case_size: 1,
  reorder_level: 5,
  costing_method: 'average',
  super_category: '',
  brand: '',
  yield_percent: 100,
  tax_percent: 0,
  cess_percent: 0,
  standard_purchase_rate: 0,
  closing_cadence: 'none',
  is_recipe_item: 0,
  is_direct_sell: 0,
  is_semifinished: 0,
  storage_location: '',
  shelf_life_days: 0,
  priority: 2,
};

/** Priority-star options — order matters (3★ first, like the alert tiers). */
const PRIORITY_OPTIONS = [
  { v: 3, stars: '⭐⭐⭐', label: 'Critical', hint: 'counted in the alert bell + WhatsApp daily low-stock ping' },
  { v: 2, stars: '⭐⭐',  label: 'Standard', hint: 'shown on dashboards, not in the bell' },
  { v: 1, stars: '⭐',   label: 'Low',      hint: 'lowest tier — dashboards only' },
] as const;

const SUPER_CATEGORIES = ['', 'Meat', 'Seafood', 'Dairy', 'Vegetables', 'Fruits', 'Liquor', 'Beverages', 'Grocery', 'Housekeeping', 'Stationery', 'Fuel', 'Other'] as const;
const CLOSING_CADENCES = [
  { v: 'none',    label: 'None (only on demand)' },
  { v: 'daily',   label: 'Daily — counted every day' },
  { v: 'weekly',  label: 'Weekly — counted weekly' },
  { v: 'monthly', label: 'Monthly — counted monthly' },
] as const;

type SortKey = 'name' | 'current_stock' | 'stock_value';
type SortDir = 'asc' | 'desc';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatCurrency(value: number): string {
  return '₹' + value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function formatCurrencyRounded(value: number): string {
  return '₹' + value.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function categoryLabel(cat: string): string {
  return cat
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
}

/* ------------------------------------------------------------------ */
/* Page Component                                                      */
/* ------------------------------------------------------------------ */

export default function InventoryPage() {
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [showLowStock, setShowLowStock] = useState(false);
  const [showAutoDiscovered, setShowAutoDiscovered] = useState(false);

  // Sorting
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [formData, setFormData] = useState<FormData>({ ...EMPTY_FORM });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // CSV Import
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  // Round-trip CSV (export edits + re-upload)
  const [roundtripImporting, setRoundtripImporting] = useState(false);
  // Bulk rate-correction tool
  const [showRates, setShowRates] = useState(false);
  // Bulk priority-star tool (admin / store manager only)
  const [showPriority, setShowPriority] = useState(false);
  // Inline per-row priority save in flight (material id)
  const [savingPriorityId, setSavingPriorityId] = useState<string | null>(null);
  const [me, setMe] = useState<any>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(j => setMe(j?.user ?? null))
      .catch(() => setMe(null));
  }, []);
  const canBulkPriority = !!me && (me.role === 'admin' || me.is_store_manager);

  // Inline per-row priority setter — same apply path as the bulk tool, so a
  // single item's level can be set straight from the list (optimistic; reverts
  // on failure). Gated to the same roles as the bulk tool via canBulkPriority.
  async function setItemPriority(id: string, priority: number) {
    const prev = materials;
    setSavingPriorityId(id);
    setMaterials((ms) => ms.map((m) => (m.id === id ? { ...m, priority } : m)));
    try {
      const res = await api('/api/inventory/priority', {
        method: 'POST',
        body: { mode: 'apply', rows: [{ id, priority }] },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to set priority');
    } catch {
      setMaterials(prev); // revert on failure
    } finally {
      setSavingPriorityId(null);
    }
  }

  /* ---- Fetch ---- */

  /** silent = refresh data without flipping to the page skeleton (which would
   *  unmount any open modal and wipe its state — e.g. the Update Rates
   *  success message / audit list). */
  const fetchMaterials = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      setError(null);
      const res = await fetch('/api/inventory');
      if (!res.ok) throw new Error('Failed to fetch inventory');
      const json = await res.json();
      setMaterials(json.materials ?? []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMaterials();
  }, [fetchMaterials]);

  /* ---- Filtering + Sorting ---- */

  const filtered = useMemo(() => {
    let list = [...materials];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((m) => m.name.toLowerCase().includes(q));
    }
    if (categoryFilter) {
      list = list.filter((m) => m.category === categoryFilter);
    }
    if (showLowStock) {
      list = list.filter((m) => m.current_stock < m.reorder_level);
    }
    if (showAutoDiscovered) {
      list = list.filter((m) => !!m.is_auto_discovered);
    }

    list.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortKey === 'current_stock') cmp = a.current_stock - b.current_stock;
      else if (sortKey === 'stock_value') cmp = (a.stock_value ?? 0) - (b.stock_value ?? 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [materials, searchQuery, categoryFilter, showLowStock, showAutoDiscovered, sortKey, sortDir]);

  /* ---- Summary ---- */

  const summary = useMemo(() => {
    const totalItems = materials.length;
    const totalValue = materials.reduce((s, m) => s + (m.stock_value ?? 0), 0);
    const lowStockItems = materials.filter((m) => m.current_stock < m.reorder_level).length;
    const categories = new Set(materials.map((m) => m.category)).size;
    return { totalItems, totalValue, lowStockItems, categories };
  }, [materials]);

  /* ---- Category filter options ----
     Union of the hardcoded canonical list (CATEGORIES) AND every distinct
     category that actually exists on a raw_material. This makes the dropdown
     pick up new categories created in /unit-audit, /contracts, recipe imports,
     etc. without needing a code change. Sorted alphabetically; canonical
     categories are *not* dropped even when no material uses them yet (so the
     dropdown stays consistent on an empty DB). */
  const availableCategories = useMemo(() => {
    const live = new Set(materials.map(m => (m.category || '').trim()).filter(Boolean));
    const all = new Set<string>([...CATEGORIES, ...live]);
    return Array.from(all).sort((a, b) => a.localeCompare(b));
  }, [materials]);

  /** Same options but grouped by super_category so the dropdowns render with
   *  <optgroup> headers like "Bar > Beers / Whisky / Vodka …". Leaves not yet
   *  assigned a parent fall under "(Other)". */
  const categoryGroups = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const m of materials) {
      const cat = (m.category || '').trim();
      if (!cat) continue;
      const sup = ((m as any).super_category || '').trim() || '(Other)';
      if (!map.has(sup)) map.set(sup, new Set());
      map.get(sup)!.add(cat);
    }
    // Ensure every category in `availableCategories` is represented even if
    // no material in the current list uses it (e.g. placeholder leaves).
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

  /* ---- Low-stock items ---- */

  const lowStockMaterials = useMemo(
    () => materials.filter((m) => m.current_stock < m.reorder_level),
    [materials],
  );

  /* ---- Sort toggle ---- */

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  /* ---- Modal ---- */

  function openAddModal() {
    setFormData({ ...EMPTY_FORM });
    setFormError(null);
    setModalOpen(true);
  }

  function openEditModal(m: RawMaterial) {
    setFormData({
      id: m.id,
      name: m.name,
      sku: (m as any).sku || '',
      category: m.category,
      unit: m.unit,
      purchase_unit: (m as any).purchase_unit || m.unit,
      pack_size:     (m as any).pack_size     || 1,
      case_size:     (m as any).case_size     || 1,
      reorder_level: m.reorder_level,
      costing_method: m.costing_method,
      super_category:         (m as any).super_category         || '',
      brand:                  (m as any).brand                  || '',
      yield_percent:          (m as any).yield_percent          ?? 100,
      tax_percent:            (m as any).tax_percent            ?? 0,
      cess_percent:           (m as any).cess_percent           ?? 0,
      standard_purchase_rate: (m as any).standard_purchase_rate ?? 0,
      closing_cadence:        (m as any).closing_cadence        || 'none',
      is_recipe_item:         (m as any).is_recipe_item         ?? 0,
      is_direct_sell:         (m as any).is_direct_sell         ?? 0,
      is_semifinished:        (m as any).is_semifinished        ?? 0,
      storage_location:       (m as any).storage_location       || '',
      shelf_life_days:        (m as any).shelf_life_days        ?? 0,
      priority:               (m as any).priority               ?? 2,
      // Show price in purchase-unit terms (₹/kg) for editing — easier to read off invoices.
      // packFactor guards the conversion: it is 1 unless pack_size > 1 AND the
      // recipe unit differs from the purchase unit (kg/kg rows convert by 1).
      avg_price_per_purchase_unit: Number(
        (((m as any).average_price || 0) * packFactor(m as any)).toFixed(4)
      ),
      // Show reorder level in purchase-unit terms (kg / BTL) — easier to think about
      reorder_level_purchase_unit: Number(
        ((m.reorder_level || 0) / packFactor(m as any)).toFixed(3)
      ),
    });
    setFormError(null);
    setModalOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formData.name.trim()) {
      setFormError('Name is required');
      return;
    }

    try {
      setSubmitting(true);
      setFormError(null);
      const isEdit = !!formData.id;
      // Convert avg_price_per_purchase_unit (₹/kg) → average_price (₹/g) by
      // dividing by the guarded pack factor (1 when recipe unit = purchase
      // unit, mirroring /api/inventory/update-rates). The stored value is
      // always per recipe-unit so recipe-cost math (qty × average_price)
      // stays correct.
      const ps = packFactor(formData as any);
      const avgPerPurchase = formData.avg_price_per_purchase_unit;
      const reorderPerPurchase = formData.reorder_level_purchase_unit;
      const bodyToSend: any = { ...formData };
      if (avgPerPurchase != null && Number.isFinite(Number(avgPerPurchase))) {
        bodyToSend.average_price = Number(avgPerPurchase) / ps;
      }
      // Reorder level: user enters in purchase units; store as recipe units
      // (since current_stock is in recipe units and we compare them directly).
      if (reorderPerPurchase != null && Number.isFinite(Number(reorderPerPurchase))) {
        bodyToSend.reorder_level = Number(reorderPerPurchase) * ps;
      }
      delete bodyToSend.avg_price_per_purchase_unit;
      delete bodyToSend.reorder_level_purchase_unit;
      // Use the api() helper so the X-CSRF-Token header is injected automatically.
      const res = await api('/api/inventory', {
        method: isEdit ? 'PUT' : 'POST',
        body: bodyToSend,
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || 'Request failed');
      }
      setModalOpen(false);
      await fetchMaterials();
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  /* ---- Loading ---- */

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="flex justify-between items-center">
            <div className="h-9 w-48 bg-[#FFF1E3] rounded-lg" />
            <div className="h-10 w-44 bg-[#FFF1E3] rounded-lg" />
          </div>
          <div className="h-12 bg-[#FFF1E3] rounded-lg" />
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-6 h-28" />
            ))}
          </div>
          <div className="bg-white border border-[#E8D5C4] rounded-xl h-96" />
        </div>
      </div>
    );
  }

  /* ---- Error ---- */

  if (error) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center">
        <div className="text-center space-y-4">
          <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto" />
          <p className="text-[#6B5744] text-lg">Error: {error}</p>
          <button
            onClick={() => fetchMaterials()}
            className="px-4 py-2 bg-[#FFF1E3] text-[#2D1B0E] rounded-lg hover:bg-[#FFF1E3] transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  /* ---- Round-trip CSV (Export → Edit → Re-upload) ---- */

  async function handleRoundTripUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so re-selecting same file fires onChange
    if (!file) return;

    // Step 1 — confirmation dialog with the "Remove old inventory details" option
    const deactivate = window.confirm(
      `Re-upload ${file.name}?\n\n` +
      `• Rows with an id will UPDATE existing materials.\n` +
      `• Rows with no id will CREATE new materials.\n\n` +
      `🟡 OK = Replace mode (deactivate any active material NOT in the file).\n` +
      `⚪ Cancel = Merge mode (keep all existing materials, only apply file rows).\n\n` +
      `(Deactivate = soft-delete only; purchase / recipe history is preserved.)`,
    );
    // Use a clearer 3-state prompt: yes / no / abort
    // window.confirm only gives 2 options, so re-prompt for explicit abort.
    if (!deactivate) {
      const proceed = window.confirm(
        'Proceed in MERGE mode (no deactivations)?\n\n' +
        'OK = upload edits, keep everything else.\n' +
        'Cancel = abort the upload entirely.',
      );
      if (!proceed) return;
    }

    setRoundtripImporting(true);
    setImportResult(null);
    try {
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      if (parsed.errors?.length) {
        throw new Error('CSV parse error: ' + parsed.errors[0]?.message);
      }
      const rows = (parsed.data as any[]).filter(r => r && (r.id || r.name));
      if (rows.length === 0) throw new Error('No rows with name (or id) found in CSV');

      const res = await api('/api/inventory/round-trip-import', {
        method: 'POST',
        body: { rows, deactivateMissing: deactivate },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);

      setImportResult({ message: '✓ ' + (j.summary || 'Done'), type: 'success' });
      await fetchMaterials();
    } catch (err: any) {
      setImportResult({ message: 'Re-upload failed: ' + err.message, type: 'error' });
    } finally {
      setRoundtripImporting(false);
    }
  }

  /* ---- CSV Import ---- */

  async function handleCSVImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setImportResult(null);

    try {
      const text = await file.text();

      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });

      if (parsed.errors.length > 0 && parsed.data.length === 0) {
        throw new Error('Failed to parse CSV: ' + parsed.errors[0]?.message);
      }

      const materials = (parsed.data as any[]).map((row) => ({
        id: row['Id'] || undefined,
        name: row['Name'] || '',
        category: row['Category Name'] || 'other',
        purchaseUnit: row['Purchase Unit'] || 'pcs',
        stockUnit: row['Stock Unit'] || '',
        consumptionUnit: row['Consumption Unit'] || '',
        usableInventory: parseFloat(row['Usable Inventory']) || 0,
        minimumStockLevel: parseFloat(row['Minimum Stock Level']) || 0,
        defaultPurchaseRate: parseFloat(row['Default Purchase Rate']) || 0,
      })).filter((m) => m.name.trim() !== '');

      // Additive import — never clears existing data. The route skips materials
      // that already exist (matched by name) and only inserts genuinely new rows.
      const res = await api('/api/import-materials', {
        method: 'POST',
        body: { materials },
      });

      const result = await res.json();

      if (!res.ok) throw new Error(result.error || 'Import failed');

      setImportResult({ message: result.message, type: 'success' });
      await fetchMaterials();
    } catch (err: any) {
      setImportResult({ message: err.message, type: 'error' });
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  }

  /* ---- Render ---- */

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Raw Materials</h1>
            <p className="text-[#8B7355] text-sm mt-1">Manage raw materials and stock levels</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <label
              title="Adds new materials from the CSV. Items that already exist (matched by name) are skipped — existing data is never deleted or overwritten."
              className={`flex items-center gap-2 px-4 py-2.5 border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm font-medium transition-colors cursor-pointer ${importing ? 'opacity-50 pointer-events-none' : ''}`}>
              {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {importing ? 'Importing...' : 'Import POS CSV'}
              <input type="file" accept=".csv" onChange={handleCSVImport} className="hidden" disabled={importing} />
            </label>
            <button
              onClick={() => { window.location.href = '/api/inventory/export'; }}
              className="flex items-center gap-2 px-4 py-2.5 border border-emerald-600 text-emerald-700 hover:bg-emerald-50 rounded-lg text-sm font-medium transition-colors"
              title="Download every material as CSV. Edit in Excel, then re-upload via 'Re-upload Edits'."
            >
              <ClipboardCheck className="w-4 h-4" />
              Export Raw Materials CSV
            </button>
            <label className={`flex items-center gap-2 px-4 py-2.5 border border-amber-600 text-amber-700 hover:bg-amber-50 rounded-lg text-sm font-medium transition-colors cursor-pointer ${roundtripImporting ? 'opacity-50 pointer-events-none' : ''}`}
                   title="Upload the edited Raw Materials CSV (from Export). Rows with an id update existing materials; rows with no id create new ones.">
              {roundtripImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {roundtripImporting ? 'Uploading...' : 'Re-upload Edits'}
              <input type="file" accept=".csv" onChange={handleRoundTripUpload} className="hidden" disabled={roundtripImporting} />
            </label>
            <button
              onClick={() => setShowRates(true)}
              className="flex items-center gap-2 px-4 py-2.5 border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm font-medium transition-colors"
              title="Bulk-correct average rates by SKU or name. Updates existing materials in place, so all past requisition costs recompute at the corrected rate."
            >
              <ClipboardCheck className="w-4 h-4" />
              Update Rates
            </button>
            {canBulkPriority && (
              <button
                onClick={() => setShowPriority(true)}
                className="flex items-center gap-2 px-4 py-2.5 border border-amber-500 text-amber-700 hover:bg-amber-50 rounded-lg text-sm font-medium transition-colors"
                title="Bulk-set priority stars (3★ critical / 2★ standard / 1★ low) by category, or let Smart Suggest compute them from consumption + recipe usage."
              >
                <Star className="w-4 h-4" />
                Set Priority
              </button>
            )}
            <button
              onClick={openAddModal}
              className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Raw Material
            </button>
          </div>
        </div>

        {/* Import Result Toast */}
        {importResult && (
          <div className={`flex items-center justify-between p-4 rounded-xl border ${importResult.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
            <div className="flex items-center gap-2">
              {importResult.type === 'success' ? <CheckCircle className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
              <span className="text-sm font-medium">{importResult.message}</span>
            </div>
            <button onClick={() => setImportResult(null)} className="p-2 -m-1 hover:opacity-70"><X className="w-4 h-4" /></button>
          </div>
        )}

        {/* Filter Bar */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
          <div className="flex flex-col md:flex-row gap-3 items-start md:items-center">
            {/* Search */}
            <div className="relative flex-1 min-w-0 w-full md:w-auto">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
              <input
                type="text"
                placeholder="Search by name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] placeholder:text-[#8B7355] focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent"
              />
            </div>

            {/* Category Filter */}
            <div className="relative w-full md:w-48">
              <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="w-full appearance-none pl-10 pr-8 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent"
              >
                <option value="">All Categories</option>
                {categoryGroups.map(g => (
                  <optgroup key={g.sup} label={g.sup}>
                    {g.cats.map(c => (
                      <option key={c} value={c}>{categoryLabel(c)}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355] pointer-events-none" />
            </div>

            {/* Low Stock Toggle — label wrapper so the text is clickable too */}
            <label className="flex items-center gap-2 select-none whitespace-nowrap cursor-pointer">
              <Toggle checked={showLowStock} onChange={(v) => setShowLowStock(v)} label="Show Low Stock Only" />
              <span className="text-sm text-[#6B5744]">Show Low Stock Only</span>
            </label>

            {/* Auto-discovered Toggle — surfaces materials that need review */}
            <label className="flex items-center gap-2 select-none whitespace-nowrap cursor-pointer"
                 title="Materials auto-created from imports (e.g. Recaho transfers). Review price/unit/category before relying on them.">
              <Toggle checked={showAutoDiscovered} onChange={(v) => setShowAutoDiscovered(v)} label="Needs Review" />
              <span className="text-sm text-[#6B5744]">⚠ Needs Review</span>
            </label>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-4">
          <SummaryCard
            icon={<Package className="w-5 h-5" />}
            label="Total Items"
            value={summary.totalItems.toString()}
            color="blue"
          />
          <SummaryCard
            icon={<IndianRupee className="w-5 h-5" />}
            label="Total Stock Value"
            value={formatCurrencyRounded(summary.totalValue)}
            color="green"
          />
          <SummaryCard
            icon={<AlertTriangle className="w-5 h-5" />}
            label="Low Stock Items"
            value={summary.lowStockItems.toString()}
            color={summary.lowStockItems > 0 ? 'red' : 'green'}
          />
          <SummaryCard
            icon={<Layers className="w-5 h-5" />}
            label="Categories"
            value={summary.categories.toString()}
            color="purple"
          />
        </div>

        {/* Inventory Table */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E8D5C4] text-[#8B7355] text-left">
                  <th className="px-4 py-3 font-medium">
                    <button
                      onClick={() => toggleSort('name')}
                      className="flex items-center gap-1 hover:text-[#3D2614] transition-colors"
                    >
                      Name
                      <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium" title="Recipe / stock unit — what recipes consume in. Drives recipe-deduction.">Recipe Unit</th>
                  <th className="px-4 py-3 font-medium" title="How the vendor invoices — set this on Unit Audit page or via the edit form.">Purchase Unit</th>
                  <th className="px-4 py-3 font-medium text-right" title="Always in the material's recipe unit. e.g. for MAKHANA (recipe unit = g, purchase unit = kg) pack_size = 1000 g per 1 kg.">Pack Size <span className="text-[9px] font-normal text-[#8B7355]">(in recipe unit)</span></th>
                  <th className="px-4 py-3 font-medium">
                    <button
                      onClick={() => toggleSort('current_stock')}
                      className="flex items-center gap-1 hover:text-[#3D2614] transition-colors"
                    >
                      Current Stock
                      <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="px-4 py-3 font-medium text-right" title="Most recent purchase price (per recipe unit); hover a value for the purchase date. — = never purchased.">Latest ₹</th>
                  <th className="px-4 py-3 font-medium text-right">Avg Price</th>
                  <th className="px-4 py-3 font-medium text-right">
                    <button
                      onClick={() => toggleSort('stock_value')}
                      className="flex items-center gap-1 justify-end hover:text-[#3D2614] transition-colors"
                    >
                      Stock Value
                      <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="px-4 py-3 font-medium text-right" title="Triggers low-stock badge when current stock falls below this. Shown in purchase units; stored in recipe units.">Reorder Level</th>
                  <th className="px-4 py-3 font-medium text-center">Status</th>
                  <th className="px-4 py-3 font-medium text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-12 text-center text-[#8B7355]">
                      {materials.length === 0
                        ? 'No raw materials found. Add your first material to get started.'
                        : 'No materials match the current filters.'}
                    </td>
                  </tr>
                ) : (
                  filtered.map((m) => {
                    const isLow = m.current_stock < m.reorder_level;
                    const catColor = CATEGORY_COLORS[m.category] ?? CATEGORY_COLORS.other;

                    return (
                      <tr
                        key={m.id}
                        className={`border-b border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 transition-colors ${
                          isLow ? 'bg-red-500/5' : ''
                        }`}
                      >
                        <td className="px-4 py-3 text-[#2D1B0E] font-medium">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span>{m.name}</span>
                            {canBulkPriority ? (
                              <select
                                value={m.priority ?? 2}
                                disabled={savingPriorityId === m.id}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => { e.stopPropagation(); setItemPriority(m.id, Number(e.target.value)); }}
                                title="Set this item's priority — 3★ Critical is counted in the alert bell + WhatsApp daily low-stock ping"
                                aria-label={`Priority for ${m.name}`}
                                className="text-[10px] leading-none bg-[#FFF1E3] border border-[#D4B896] rounded px-1 py-0.5 cursor-pointer disabled:opacity-50"
                              >
                                {PRIORITY_OPTIONS.map((p) => (
                                  <option key={p.v} value={p.v}>{p.stars} {p.label}</option>
                                ))}
                              </select>
                            ) : (
                              <span className="text-[10px] tracking-tighter"
                                    title={`Priority: ${(m.priority ?? 2) === 3 ? 'Critical — counted in the alert bell + WhatsApp daily ping' : (m.priority ?? 2) === 1 ? 'Low' : 'Standard'}`}>
                                {'⭐'.repeat((m.priority ?? 2) === 3 ? 3 : (m.priority ?? 2) === 1 ? 1 : 2)}
                              </span>
                            )}
                            {m.is_auto_discovered ? (
                              <span title={`Auto-discovered from ${m.discovered_source || 'import'} — review price/unit/category before relying on this material.`}
                                    className="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200 font-medium uppercase tracking-wide">
                                ⚠ auto-discovered
                              </span>
                            ) : null}
                            {(m as any).storage_location && (
                              <span title={`Storage: ${(m as any).storage_location}`}
                                    className="text-[9px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                                📍 {(m as any).storage_location}
                              </span>
                            )}
                            {(m as any).shelf_life_days > 0 && (
                              <span title={`Shelf life: ${(m as any).shelf_life_days} days`}
                                    className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                                {(m as any).shelf_life_days}d
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-[10px] font-mono text-[#8B7355]">
                          {(m as any).sku || '-'}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${catColor.bg} ${catColor.text}`}
                          >
                            {categoryLabel(m.category)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-[#6B5744]">{m.unit}</td>
                        <td className="px-4 py-3 text-[#6B5744]">
                          {(m as any).purchase_unit || <span className="text-[#8B7355] italic">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right text-[#6B5744] font-mono">
                          {(() => {
                            // Guarded: kg/kg rows with a stray pack_size have no
                            // real conversion — render them as plain 1:1, never
                            // "15 kg per 1 kg".
                            const ps = packFactor(m as any);
                            const ru = m.unit;
                            const pu = (m as any).purchase_unit || m.unit;
                            if (ps > 1) {
                              return (
                                <>
                                  {ps} <span className="text-[10px] text-[#8B7355]">{ru}</span>
                                  <div className="text-[10px] text-[#8B7355]">per 1 {pu}</div>
                                </>
                              );
                            }
                            return <span className="text-[#8B7355]">1 <span className="text-[10px]">{ru}</span></span>;
                          })()}
                        </td>
                        <td className="px-4 py-3 text-[#3D2614] font-mono">
                          {(() => {
                            const ps = packFactor(m as any);
                            const pu = (m as any).purchase_unit || m.unit;
                            if (ps > 1) {
                              return (
                                <>
                                  <span>{(m.current_stock / ps).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                                  <span className="ml-1 text-[10px] text-[#8B7355]">{pu}</span>
                                  <div className="text-[10px] text-[#8B7355]">
                                    = {m.current_stock.toLocaleString('en-IN')} {m.unit}
                                  </div>
                                </>
                              );
                            }
                            return <>{m.current_stock.toLocaleString('en-IN')} <span className="text-[10px] text-[#8B7355]">{m.unit}</span></>;
                          })()}
                        </td>
                        {/* Latest ₹ — most recent purchase price PER PURCHASE UNIT, right
                            beside Current Stock. Derived server-side as total/qty of the
                            last purchase (purchase rows record quantity in purchase units
                            per the core convention). */}
                        <td className="px-4 py-3 text-right text-[#6B5744] font-mono"
                            title={(m as any).last_purchase_date ? `Last bought ${(m as any).last_purchase_date}` : 'Never purchased'}>
                          {(() => {
                            const lp = Number((m as any).latest_price_purchase_unit) || 0;
                            if (!lp) return <span className="text-[#C0A98F]">—</span>;
                            const pu = (m as any).purchase_unit || m.unit;
                            return <>{formatCurrency(lp)}<span className="ml-1 text-[10px] text-[#8B7355]">/ {pu}</span></>;
                          })()}
                        </td>
                        <td className="px-4 py-3 text-right text-[#6B5744] font-mono">
                          {/* Inline-editable rate: shown & entered in ₹ per purchase unit
                              (₹/kg), auto-converted to per-recipe-unit average_price on save. */}
                          <EditableRate m={m} onSaved={fetchMaterials} />
                        </td>
                        <td className="px-4 py-3 text-right text-[#3D2614] font-mono">
                          {formatCurrency(m.stock_value ?? 0)}
                        </td>
                        <td className="px-4 py-3 text-right text-[#8B7355] font-mono">
                          {(() => {
                            const ps = packFactor(m as any);
                            const pu = (m as any).purchase_unit || m.unit;
                            if (ps > 1) {
                              return (
                                <>
                                  {(m.reorder_level / ps).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                                  <span className="ml-1 text-[10px] text-[#8B7355]">{pu}</span>
                                </>
                              );
                            }
                            return m.reorder_level;
                          })()}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {isLow ? (
                            <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-500/15 text-red-400">
                              Low Stock
                            </span>
                          ) : (
                            <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-500/15 text-green-400">
                              OK
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => openEditModal(m)}
                            className="p-2 -m-0.5 rounded-lg text-[#8B7355] hover:text-[#2D1B0E] hover:bg-[#FFF1E3] transition-colors"
                            title="Edit"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Stock Alert Section */}
        {lowStockMaterials.length > 0 && (
          <div className="bg-white border border-red-500/20 rounded-xl p-6 shadow">
            <h3 className="text-lg font-semibold text-[#2D1B0E] mb-4 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-400" />
              Stock Alerts
              <span className="ml-2 inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/15 text-red-400">
                {lowStockMaterials.length}
              </span>
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[#8B7355] border-b border-[#E8D5C4]">
                    <th className="text-left py-2 px-3 font-medium">Material</th>
                    <th className="text-left py-2 px-3 font-medium">Category</th>
                    <th className="text-right py-2 px-3 font-medium">Current Stock</th>
                    <th className="text-right py-2 px-3 font-medium">Reorder Level</th>
                    <th className="text-right py-2 px-3 font-medium">Deficit</th>
                  </tr>
                </thead>
                <tbody>
                  {lowStockMaterials.map((m) => {
                    const deficit = m.reorder_level - m.current_stock;
                    return (
                      <tr
                        key={m.id}
                        className="border-b border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 transition-colors"
                      >
                        <td className="py-2.5 px-3 text-[#3D2614] font-medium">{m.name}</td>
                        <td className="py-2.5 px-3">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                              CATEGORY_COLORS[m.category]?.bg ?? 'bg-gray-500/15'
                            } ${CATEGORY_COLORS[m.category]?.text ?? 'text-gray-400'}`}
                          >
                            {categoryLabel(m.category)}
                          </span>
                        </td>
                        {(() => {
                          const ps = packFactor(m as any);
                          const pu = (m as any).purchase_unit || m.unit;
                          const showAsPurchase = ps > 1;
                          const fmtQ = (q: number) =>
                            showAsPurchase
                              ? <>{(q / ps).toLocaleString('en-IN', { maximumFractionDigits: 2 })} <span className="text-[10px] text-[#8B7355]">{pu}</span></>
                              : <>{q} <span className="text-[10px] text-[#8B7355]">{m.unit}</span></>;
                          return (
                            <>
                              <td className="py-2.5 px-3 text-right text-red-400 font-mono">{fmtQ(m.current_stock)}</td>
                              <td className="py-2.5 px-3 text-right text-[#8B7355] font-mono">{fmtQ(m.reorder_level)}</td>
                              <td className="py-2.5 px-3 text-right text-red-400 font-mono font-medium">-{fmtQ(deficit)}</td>
                            </>
                          );
                        })()}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Add/Edit Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
          onClick={() => setModalOpen(false)}
        >
          {/* Backdrop */}
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />

          {/* Modal Content — capped at viewport height, with sticky header + footer
              and scrollable body so the Save button is always reachable. */}
          <div
            className="relative bg-white border border-[#D4B896] rounded-2xl shadow-2xl w-full max-w-lg my-4 flex flex-col max-h-[calc(100vh-2rem)]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header (sticky) */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
              <h2 className="text-lg font-semibold text-[#2D1B0E]">
                {formData.id ? 'Edit Raw Material' : 'Add Raw Material'}
              </h2>
              <button
                onClick={() => setModalOpen(false)}
                className="p-1.5 rounded-lg text-[#8B7355] hover:text-[#2D1B0E] hover:bg-[#FFF1E3] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body (scrolls) */}
            <form id="materialForm" onSubmit={handleSubmit} className="px-6 py-5 space-y-4 overflow-y-auto flex-1 min-h-0">
              {formError && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                  {formError}
                </div>
              )}

              {/* Name + SKU (Phase 1 §1: every material must have a unique SKU; auto-generated if blank) */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-[#6B5744] mb-1.5">Name <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData((f) => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Chicken Breast"
                    className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] placeholder:text-[#8B7355] focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent"
                    autoFocus
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#6B5744] mb-1.5">SKU
                    <span className="text-[10px] font-normal text-[#8B7355] ml-1">{formData.id ? '(immutable)' : '(auto if blank)'}</span>
                  </label>
                  <input
                    type="text"
                    value={(formData as any).sku || ''}
                    onChange={(e) => setFormData((f) => ({ ...f, ...(({ sku: e.target.value } as any)) }))}
                    placeholder={formData.id ? '' : 'MAT-NNNNN'}
                    disabled={!!formData.id}
                    className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] placeholder:text-[#8B7355] font-mono uppercase focus:outline-none focus:ring-2 focus:ring-[#af4408] disabled:opacity-60 disabled:bg-[#E8D5C4]/40"
                  />
                </div>
              </div>

              {/* Category */}
              <div>
                <label className="block text-sm font-medium text-[#6B5744] mb-1.5">Category</label>
                <select
                  value={formData.category}
                  onChange={(e) => setFormData((f) => ({ ...f, category: e.target.value }))}
                  className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent"
                >
                  {categoryGroups.map(g => (
                    <optgroup key={g.sup} label={g.sup}>
                      {g.cats.map(c => (
                        <option key={c} value={c}>{categoryLabel(c)}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <p className="text-[10px] text-[#8B7355] mt-1">
                  Need a new sub-category? Add it on <a href="/settings/categories" className="text-[#af4408] underline">Settings → Categories</a> (admins) — it appears here automatically, grouped under its parent.
                </p>
              </div>

              {/* Recipe Unit (canonical) */}
              <div>
                <label className="block text-sm font-medium text-[#6B5744] mb-1.5" title="What recipes consume in. Drives recipe-deduction and recipe cost.">
                  Recipe Unit
                </label>
                <select
                  value={formData.unit}
                  onChange={(e) => setFormData((f) => ({ ...f, unit: e.target.value }))}
                  className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent"
                >
                  {UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>

              {/* Purchase Unit */}
              <div>
                <label className="block text-sm font-medium text-[#6B5744] mb-1.5" title="How the vendor invoices — BTL, CASE, KG, etc.">
                  Purchase Unit
                </label>
                <select
                  value={formData.purchase_unit || formData.unit}
                  onChange={(e) => setFormData((f) => ({ ...f, purchase_unit: e.target.value }))}
                  className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent"
                >
                  {['kg', 'g', 'L', 'ml', 'pcs', 'BTL', 'CASE', 'PKT', 'TIN', 'CAN', 'JAR', 'BOX', 'BAG', 'BUNCH'].map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>

              {/* Pack Size */}
              <div>
                <label className="block text-sm font-medium text-[#6B5744] mb-1.5" title="Always in the Recipe Unit. e.g. for MAKHANA (recipe unit = g, purchase unit = kg) enter 1000.">
                  Pack Size <span className="text-xs font-normal text-[#8B7355]">(in {formData.unit || 'recipe unit'})</span>
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="any"
                    min={0}
                    value={formData.pack_size ?? 1}
                    onChange={(e) => setFormData((f) => ({ ...f, pack_size: Number(e.target.value) || 1 }))}
                    className="w-full px-3 py-2 pr-20 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent font-mono"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#8B7355] font-mono pointer-events-none">
                    {formData.unit || 'unit'} / 1 {formData.purchase_unit || formData.unit || 'unit'}
                  </span>
                </div>
                <p className="text-[10px] text-[#8B7355] mt-1">
                  e.g. <span className="font-mono">1000</span> g per 1 kg ·{' '}
                  <span className="font-mono">750</span> ml per 1 BTL ·{' '}
                  Set to <span className="font-mono">1</span> when Recipe Unit = Purchase Unit.
                </p>
              </div>

              {/* Avg Price (per purchase unit) — auto-divided by pack_size on save */}
              <div>
                <label className="block text-sm font-medium text-[#6B5744] mb-1.5"
                       title="Enter as ₹ per purchase unit (₹/kg, ₹/BTL). Auto-divided by Pack Size and stored as per-recipe-unit so recipe cost stays correct.">
                  Avg Price (₹ per {formData.purchase_unit || formData.unit || 'unit'})
                </label>
                <input
                  type="number" step="any" min={0}
                  value={formData.avg_price_per_purchase_unit ?? ''}
                  onChange={(e) => setFormData((f) => ({ ...f, avg_price_per_purchase_unit: e.target.value === '' ? undefined : Number(e.target.value) }))}
                  placeholder={`e.g. 355.51 for ₹355.51 / ${formData.purchase_unit || formData.unit || 'unit'}`}
                  className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] font-mono focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent"
                />
                {(() => {
                  const ps = packFactor(formData as any);
                  const apu = Number(formData.avg_price_per_purchase_unit);
                  if (!Number.isFinite(apu) || apu <= 0 || ps <= 0) return null;
                  const perRecipe = apu / ps;
                  return (
                    <p className="text-[10px] text-[#8B7355] mt-1">
                      ≡ <span className="font-mono">₹{perRecipe.toFixed(4)}</span> per {formData.unit || 'recipe-unit'}{' '}
                      <span className="opacity-60">(stored value — auto-converted from your entry)</span>
                    </p>
                  );
                })()}
              </div>

              {/* Case Size — purchase-units per outer pack */}
              <div>
                <label className="block text-sm font-medium text-[#6B5744] mb-1.5"
                       title="Bottles / cans per CASE wrapper. Used when entering vendor invoices by case.">
                  Case Size <span className="text-xs font-normal text-[#8B7355]">(bottles per case · default 1 = no outer pack)</span>
                </label>
                <input
                  type="number" step="any" min={1}
                  value={formData.case_size ?? 1}
                  onChange={(e) => setFormData((f) => ({ ...f, case_size: Number(e.target.value) || 1 }))}
                  className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent"
                />
                <p className="text-[10px] text-[#8B7355] mt-1">
                  e.g. <span className="font-mono">12</span> for a case of 12 bottles, <span className="font-mono">24</span> for a beer case.
                  On the Purchases form you can then toggle <em>"Buy by Case"</em> and the system multiplies by this number.
                </p>
              </div>

              {/* Reorder Level — entered in purchase units (kg / BTL) OR cases. Two
                  inputs that auto-sync via case_size. Whichever the user touches
                  drives the other. Persisted as recipe units on save. */}
              <div>
                <label className="block text-sm font-medium text-[#6B5744] mb-1.5"
                       title="Trigger a low-stock alert when current stock falls below this. Enter in packs (purchase units like kg / BTL) OR in cases — whichever is more natural for this item.">
                  Reorder Level
                  <span className="text-xs font-normal text-[#8B7355] ml-1">
                    — enter in {(formData.case_size && formData.case_size > 1)
                      ? <>cases <em>or</em> packs of {formData.purchase_unit || formData.unit || 'unit'}</>
                      : <>packs of {formData.purchase_unit || formData.unit || 'unit'} (this item has no case)</>}
                  </span>
                </label>

                <div className={`grid ${(formData.case_size && formData.case_size > 1) ? 'grid-cols-2' : 'grid-cols-1'} gap-2`}>
                  {/* Packs (purchase-unit) input */}
                  <div className="relative">
                    <input
                      type="number" step="any" min={0}
                      value={formData.reorder_level_purchase_unit ?? ''}
                      onChange={(e) => setFormData((f) => ({
                        ...f,
                        reorder_level_purchase_unit: e.target.value === '' ? undefined : Number(e.target.value),
                      }))}
                      placeholder={`Packs of ${formData.purchase_unit || formData.unit || 'unit'}`}
                      className="w-full px-3 py-2 pr-16 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] font-mono focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#8B7355] font-mono pointer-events-none">
                      {formData.purchase_unit || formData.unit || 'unit'}
                    </span>
                  </div>

                  {/* Cases input — only when case_size > 1. Setting this updates the packs field too. */}
                  {(formData.case_size && formData.case_size > 1) && (
                    <div className="relative">
                      <input
                        type="number" step="any" min={0}
                        value={
                          formData.reorder_level_purchase_unit != null && formData.case_size
                            ? Number((Number(formData.reorder_level_purchase_unit) / formData.case_size).toFixed(2))
                            : ''
                        }
                        onChange={(e) => {
                          const cs = formData.case_size || 1;
                          const cases = e.target.value === '' ? undefined : Number(e.target.value);
                          setFormData((f) => ({
                            ...f,
                            reorder_level_purchase_unit: cases == null ? undefined : cases * cs,
                          }));
                        }}
                        placeholder={`Cases of ${formData.case_size}`}
                        className="w-full px-3 py-2 pr-16 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] font-mono focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#8B7355] font-mono pointer-events-none">
                        case{formData.case_size === 1 ? '' : 's'}
                      </span>
                    </div>
                  )}
                </div>

                {(() => {
                  const ps = packFactor(formData as any);
                  const cs = Number(formData.case_size) || 1;
                  const rpu = Number(formData.reorder_level_purchase_unit);
                  if (!Number.isFinite(rpu) || rpu <= 0) return null;
                  const inRecipeUnits = rpu * ps;
                  const inCases = cs > 1 ? rpu / cs : null;
                  return (
                    <p className="text-[10px] text-[#8B7355] mt-1">
                      ≡ <span className="font-mono">{rpu}</span> {formData.purchase_unit || formData.unit || 'unit'}
                      {inCases !== null && (
                        <> · <span className="font-mono">{inCases.toFixed(2)}</span> case{inCases === 1 ? '' : 's'} of {cs}</>
                      )}
                      {' · '}<span className="font-mono">{inRecipeUnits.toLocaleString('en-IN')}</span> {formData.unit || 'recipe-unit'}
                      <span className="opacity-60"> (stored as recipe-units)</span>
                    </p>
                  );
                })()}
              </div>

              {/* Costing Method */}
              <div>
                <label className="block text-sm font-medium text-[#6B5744] mb-1.5">
                  Costing Method
                </label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="costing_method"
                      value="average"
                      checked={formData.costing_method === 'average'}
                      onChange={(e) =>
                        setFormData((f) => ({ ...f, costing_method: e.target.value }))
                      }
                      className="w-4 h-4 accent-[#af4408]"
                    />
                    <span className="text-sm text-[#6B5744]">Average</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="costing_method"
                      value="fifo"
                      checked={formData.costing_method === 'fifo'}
                      onChange={(e) =>
                        setFormData((f) => ({ ...f, costing_method: e.target.value }))
                      }
                      className="w-4 h-4 accent-[#af4408]"
                    />
                    <span className="text-sm text-[#6B5744]">FIFO</span>
                  </label>
                </div>
              </div>

              {/* Priority stars — drives tiered low-stock alerting */}
              <div>
                <label className="block text-sm font-medium text-[#6B5744] mb-1.5"
                       title="3★ items are counted in the notification bell and the WhatsApp daily low-stock ping. 2★/1★ stay visible on dashboards only.">
                  Priority
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {PRIORITY_OPTIONS.map(p => (
                    <button
                      key={p.v}
                      type="button"
                      onClick={() => setFormData(f => ({ ...f, priority: p.v }))}
                      title={p.hint}
                      className={`flex flex-col items-center gap-0.5 px-2 py-2 rounded-lg border text-xs transition-colors ${
                        (formData.priority ?? 2) === p.v
                          ? 'border-[#af4408] bg-[#af4408]/10 text-[#af4408] font-semibold'
                          : 'border-[#D4B896] bg-[#FFF1E3] text-[#6B5744] hover:border-[#af4408]'
                      }`}
                    >
                      <span className="text-sm leading-none">{p.stars}</span>
                      <span>{p.label}</span>
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-[#8B7355] mt-1">
                  Only <b>⭐⭐⭐ Critical</b> items count in the alert bell &amp; WhatsApp daily low-stock summary.
                </p>
              </div>

              {/* ============================================================ */}
              {/* Phase 1 Master Fields (Inventory Management SOP §1)           */}
              {/* ============================================================ */}
              <div className="border-t border-[#E8D5C4] pt-4 mt-2">
                <h3 className="text-sm font-bold text-[#af4408] mb-2">Master Fields (Phase 1)</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                    Super Category
                    <select value={formData.super_category || ''}
                            onChange={e => setFormData(f => ({ ...f, super_category: e.target.value }))}
                            className="px-2 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm">
                      {SUPER_CATEGORIES.map(s => <option key={s} value={s}>{s || '— None —'}</option>)}
                    </select>
                  </label>
                  <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                    Brand
                    <input value={formData.brand || ''}
                           onChange={e => setFormData(f => ({ ...f, brand: e.target.value }))}
                           placeholder="e.g. Saffola, Amul"
                           className="px-2 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
                  </label>
                  <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                    Yield % <span className="text-[10px] text-[#8B7355]">(meat/seafood default 98)</span>
                    <input type="number" min={0} max={100} step="any"
                           value={formData.yield_percent ?? 100}
                           onChange={e => setFormData(f => ({ ...f, yield_percent: Number(e.target.value) }))}
                           className="px-2 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
                  </label>
                  <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                    Standard Purchase Rate (₹)
                    <input type="number" min={0} step="any"
                           value={formData.standard_purchase_rate ?? 0}
                           onChange={e => setFormData(f => ({ ...f, standard_purchase_rate: Number(e.target.value) }))}
                           className="px-2 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
                  </label>
                  <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                    Tax % (GST)
                    <input type="number" min={0} max={100} step="any"
                           value={formData.tax_percent ?? 0}
                           onChange={e => setFormData(f => ({ ...f, tax_percent: Number(e.target.value) }))}
                           className="px-2 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
                  </label>
                  <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                    Cess %
                    <input type="number" min={0} max={100} step="any"
                           value={formData.cess_percent ?? 0}
                           onChange={e => setFormData(f => ({ ...f, cess_percent: Number(e.target.value) }))}
                           className="px-2 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
                  </label>
                  <label className="text-xs text-[#6B5744] flex flex-col gap-1 sm:col-span-2">
                    Closing-Stock Cadence
                    <select value={formData.closing_cadence || 'none'}
                            onChange={e => setFormData(f => ({ ...f, closing_cadence: e.target.value as any }))}
                            className="px-2 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm">
                      {CLOSING_CADENCES.map(c => <option key={c.v} value={c.v}>{c.label}</option>)}
                    </select>
                  </label>
                  <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                    Storage Location
                    <input value={formData.storage_location || ''}
                           onChange={e => setFormData(f => ({ ...f, storage_location: e.target.value }))}
                           placeholder="e.g. Cold Room A · Dry Store · Bar Fridge"
                           list="storage-locations"
                           className="px-2 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
                    <datalist id="storage-locations">
                      <option value="Cold Room A" />
                      <option value="Cold Room B" />
                      <option value="Freezer" />
                      <option value="Dry Store" />
                      <option value="Bar Fridge" />
                      <option value="Wine Cellar" />
                      <option value="Spice Rack" />
                    </datalist>
                  </label>
                  <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                    Shelf Life (days)
                    <input type="number" min={0}
                           value={formData.shelf_life_days ?? 0}
                           onChange={e => setFormData(f => ({ ...f, shelf_life_days: Number(e.target.value) || 0 }))}
                           placeholder="0 = no expiry tracking"
                           className="px-2 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
                    <span className="text-[10px] text-[#8B7355]">
                      Powers expiry alerts. 7 for fresh produce, 30 for dairy, 0 for dry/non-perishable.
                    </span>
                  </label>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={!!formData.is_recipe_item}
                           onChange={e => setFormData(f => ({ ...f, is_recipe_item: e.target.checked ? 1 : 0 }))} />
                    <span>Used in recipes</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={!!formData.is_direct_sell}
                           onChange={e => setFormData(f => ({ ...f, is_direct_sell: e.target.checked ? 1 : 0 }))} />
                    <span>Sold directly (e.g. bottled beer)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={!!formData.is_semifinished}
                           onChange={e => setFormData(f => ({ ...f, is_semifinished: e.target.checked ? 1 : 0 }))} />
                    <span>Semi-finished (in-house produced)</span>
                  </label>
                </div>
              </div>

            </form>
            {/* Sticky footer — buttons always visible regardless of form height */}
            <div className="flex justify-end gap-3 px-6 py-3 border-t border-[#E8D5C4] bg-white rounded-b-2xl shrink-0">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-[#6B5744] bg-[#FFF1E3] hover:bg-[#F5EDE2] rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                form="materialForm"
                disabled={submitting}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#af4408] hover:bg-[#8a3506] disabled:bg-[#8a3506] disabled:opacity-60 rounded-lg transition-colors"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                {formData.id ? 'Update Material' : 'Add Material'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showRates && (
        <UpdateRatesModal onClose={() => setShowRates(false)} onApplied={() => fetchMaterials(true)} canAudit={canBulkPriority} />
      )}

      {showPriority && (
        <SetPriorityModal
          categories={availableCategories}
          onClose={() => setShowPriority(false)}
          onApplied={fetchMaterials}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function SummaryCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: 'blue' | 'green' | 'red' | 'purple';
}) {
  const accents: Record<string, { bg: string; text: string }> = {
    blue: { bg: 'bg-[#af4408]/10', text: 'text-[#af4408]' },
    green: { bg: 'bg-green-500/10', text: 'text-green-400' },
    red: { bg: 'bg-red-500/10', text: 'text-red-400' },
    purple: { bg: 'bg-purple-500/10', text: 'text-purple-400' },
  };
  const a = accents[color];

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
      <div className="flex items-center gap-3 mb-2">
        <div className={`p-2 rounded-lg ${a.bg}`}>
          <span className={a.text}>{icon}</span>
        </div>
        <span className="text-sm text-[#8B7355]">{label}</span>
      </div>
      <p className={`text-2xl font-bold ${a.text}`}>{value}</p>
    </div>
  );
}

// ─── Bulk rate correction ────────────────────────────────────────────────
// Paste "SKU or name, rate" lines (or upload a 2-column CSV). Rates default to
// per-purchase-unit (₹/kg etc.) and are converted to the per-recipe-unit
// average_price with each material's pack_size, then written in place. Because
// requisition/party costs read average_price LIVE, every past requisition
// recomputes at the corrected rate. Preview first, then apply.
//
// Guardrails (added after a real prod incident where per-BOTTLE rates were
// applied in per-recipe mode and re-baked a ×pack corruption):
//   1. Dual-unit preview — every row shows the new/old avg in BOTH bases,
//      e.g. "₹3.44/ml = ₹2,580/BTL", so a wrong basis is visually obvious.
//   2. Wrong-mode detector — if the pasted rates match the items' latest
//      PER-PURCHASE-UNIT purchase prices while per-recipe mode is selected
//      (or vice versa), a banner warns and offers a one-click mode switch.
//   3. "Audit price bases" — scans the whole DB for materials whose stored
//      average_price looks ~pack× too big vs their latest real purchase and
//      offers a one-click repair.
interface RateMatch {
  sku: string; name: string; unit: string; purchase_unit: string;
  pack_size: number; old: number; new: number;
  /** Basis-safe latest purchase price per PURCHASE unit (0 = never purchased). */
  latest_ppu: number;
}
interface AuditRow {
  id: string; sku: string; name: string; unit: string; purchase_unit: string;
  pack: number; stored_avg: number; expected_avg: number; latest_ppu: number;
  ratio: number; checked: boolean;
}

/** "₹3.44" / "₹2,580" — more decimals for small per-recipe values. */
const fmtRate = (n: number) =>
  '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: Math.abs(n) < 100 ? 4 : 2 });

/** Dual-basis rendering: "₹3.44/ml = ₹2,580/BTL" (real pack conversion) or
 *  "₹458/pcs". Guarded via packFactor so a kg/kg row with a stray pack_size
 *  never shows a bogus "= ₹2,655/kg" second basis. */
function DualAvg({ perRecipe, unit, pack, pu, className }: {
  perRecipe: number; unit: string; pack: number; pu: string; className?: string;
}) {
  const v = Number(perRecipe) || 0;
  const pf = packFactor({ unit, purchase_unit: pu, pack_size: pack });
  return (
    <span className={`whitespace-nowrap ${className || ''}`}>
      {fmtRate(v)}/{unit}
      {pf > 1 && <span> = {fmtRate(v * pf)}/{pu || unit}</span>}
    </span>
  );
}

function UpdateRatesModal({ onClose, onApplied, canAudit }: { onClose: () => void; onApplied: () => void; canAudit?: boolean }) {
  const [text, setText] = useState('');
  const [basis, setBasis] = useState<'purchase' | 'recipe'>('purchase');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<null | {
    basis: 'purchase' | 'recipe';
    matched: RateMatch[]; matchedCount: number; unmatched: string[];
    ambiguous: { key: string; count: number }[]; invalid: { key: string; reason: string }[];
  }>(null);
  const [done, setDone] = useState<string | null>(null);
  // Basis-corruption audit tool
  const [auditRows, setAuditRows] = useState<AuditRow[] | null>(null);
  const [auditScanned, setAuditScanned] = useState(0);
  const [auditBusy, setAuditBusy] = useState(false);

  // Parse "identifier <comma|tab> rate" per line. Ignores a header row.
  const parseRows = () => {
    const out: { key: string; rate: number }[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(/\t|,(?=[^,]*$)/); // split on tab, or the LAST comma (names may contain commas)
      if (parts.length < 2) continue;
      const rate = Number(parts[parts.length - 1].replace(/[₹,\s]/g, ''));
      const key = parts.slice(0, parts.length - 1).join(',').trim().replace(/^"|"$/g, '');
      if (!key || /^(sku|name|item|material)$/i.test(key)) continue; // skip header
      out.push({ key, rate });
    }
    return out;
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setText(await f.text());
    e.target.value = '';
  };

  const run = async (dryRun: boolean, basisOverride?: 'purchase' | 'recipe') => {
    const rows = parseRows();
    if (!rows.length) { setError('Paste at least one line: SKU-or-name, rate'); return; }
    setBusy(true); setError(null); if (!dryRun) setDone(null);
    try {
      const r = await api('/api/inventory/update-rates', { method: 'POST', body: { rows, basis: basisOverride ?? basis, dryRun } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (dryRun) { setPreview(j); }
      else {
        setDone(`Updated ${j.applied} material${j.applied === 1 ? '' : 's'} — all past requisition costs now use the corrected rate.`);
        setPreview(null);
        onApplied();
      }
    } catch (e: any) { setError(e?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  /** Switching the basis invalidates the current preview (apply always uses the
   *  previewed basis — never a silently flipped one). */
  const pickBasis = (b: 'purchase' | 'recipe') => { setBasis(b); setPreview(null); };
  /** One-click fix from the wrong-mode banner: switch AND re-preview. */
  const switchModeAndRerun = (b: 'purchase' | 'recipe') => { setBasis(b); run(true, b); };

  // ── Wrong-mode detector ─────────────────────────────────────────────────
  // Compares each pasted rate against the item's basis-safe latest purchase
  // price per PURCHASE unit (from the API). Simple + effective:
  //  · per-RECIPE mode: >30% of pack>1 rows have rate > 20 AND within ±20% of
  //    the latest ₹/purchase-unit → these are almost certainly BOTTLE prices.
  //  · per-PURCHASE mode (mirror): >30% of pack>1 rows have rate < latest/20
  //    → these look like per-recipe (₹/ml) values.
  const modeWarning = useMemo(() => {
    if (!preview || !preview.matched?.length) return null;
    const eligible = preview.matched.filter(m => packFactor(m) > 1 && (m.latest_ppu || 0) > 0);
    if (!eligible.length) return null;
    if (preview.basis === 'recipe') {
      const hits = eligible.filter(m => {
        const rate = m.new; // recipe basis stores the pasted rate as-is
        return rate > 20 && Math.abs(rate - m.latest_ppu) <= 0.2 * m.latest_ppu;
      });
      if (hits.length / eligible.length > 0.3) {
        return { to: 'purchase' as const, hits: hits.length, eligible: eligible.length, example: hits[0] };
      }
    } else {
      const hits = eligible.filter(m => (m.new * m.pack_size) < m.latest_ppu / 20);
      if (hits.length / eligible.length > 0.3) {
        return { to: 'recipe' as const, hits: hits.length, eligible: eligible.length, example: hits[0] };
      }
    }
    return null;
  }, [preview]);

  // ── Basis-corruption audit ──────────────────────────────────────────────
  const runAudit = async () => {
    setAuditBusy(true); setError(null); setDone(null);
    try {
      const r = await api('/api/inventory/update-rates?audit=1');
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setAuditScanned(Number(j.scanned) || 0);
      setAuditRows((j.rows || []).map((x: any) => ({ ...x, checked: true })));
    } catch (e: any) { setError(e?.message || 'Audit failed'); }
    finally { setAuditBusy(false); }
  };

  const repairSelected = async () => {
    const picked = (auditRows || []).filter(r => r.checked);
    if (!picked.length) { setError('No audit rows ticked'); return; }
    setAuditBusy(true); setError(null);
    try {
      const r = await api('/api/inventory/update-rates', {
        method: 'POST',
        body: { repair: picked.map(p => ({ material_id: p.id, new_avg: p.expected_avg })) },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onApplied();
      await runAudit(); // refresh the list (repaired rows drop out)
      setDone(`Repaired ${j.repaired} material${j.repaired === 1 ? '' : 's'} — averages now stored per recipe unit.`);
    } catch (e: any) { setError(e?.message || 'Repair failed'); }
    finally { setAuditBusy(false); }
  };

  const auditTicked = (auditRows || []).filter(r => r.checked).length;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl shadow-xl flex flex-col overflow-hidden" style={{ maxHeight: 'calc(100vh - 1.5rem)' }} onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <div className="font-semibold text-[#2D1B0E] flex items-center gap-2"><ClipboardCheck className="w-5 h-5 text-[#af4408]" /> Update Rates</div>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          <p className="text-xs text-[#8B7355]">
            Correct wrong rates in bulk. One line per item: <b>SKU or exact name</b>, then the rate.
            Existing materials are updated in place (nothing deleted), so <b>every past requisition &amp;
            party cost recomputes at the corrected rate</b>. Preview before applying.
          </p>

          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-[#8B7355]">Rate is:</span>
            <label className="flex items-center gap-1.5"><input type="radio" checked={basis === 'purchase'} onChange={() => pickBasis('purchase')} className="accent-[#af4408]" /> per purchase unit (₹/kg, ₹/BTL…)</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={basis === 'recipe'} onChange={() => pickBasis('recipe')} className="accent-[#af4408]" /> per recipe unit (₹/g, ₹/ml…)</label>
          </div>

          <textarea value={text} onChange={e => { setText(e.target.value); setPreview(null); }}
            rows={6} placeholder={"MAT-00123, 180\nChicken Boneless, 320\nRefined Oil, 140"}
            className="w-full border border-[#D4B896] rounded-lg px-3 py-2 text-sm font-mono" />
          <label className="text-xs text-[#af4408] hover:underline cursor-pointer inline-flex items-center gap-1">
            <Upload className="w-3.5 h-3.5" /> …or upload a 2-column CSV (identifier, rate)
            <input type="file" accept=".csv,.txt" onChange={onFile} className="hidden" />
          </label>

          {error && <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-sm text-red-700">{error}</div>}
          {done && <div className="bg-green-50 border border-green-200 rounded-lg p-2.5 text-sm text-green-800 flex items-center gap-2"><CheckCircle className="w-4 h-4" /> {done}</div>}

          {/* Wrong-mode banner — fires when the pasted rates clearly match the
              other basis. No hard block: one click switches mode + re-previews. */}
          {preview && modeWarning && (
            <div className={`rounded-lg border p-3 text-sm space-y-2 ${modeWarning.to === 'purchase' ? 'bg-red-50 border-red-300 text-red-800' : 'bg-amber-50 border-amber-300 text-amber-900'}`}>
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  {modeWarning.to === 'purchase' ? (
                    <>
                      <b>These rates match these items&apos; PER-BOTTLE/PACK purchase prices</b> — you probably
                      want <b>per PURCHASE unit</b> mode. {modeWarning.hits} of {modeWarning.eligible} pack
                      items are within ±20% of their latest ₹/{modeWarning.example.purchase_unit || 'pack'} purchase price.
                      <div className="text-xs mt-1">
                        e.g. {modeWarning.example.name}: pasted <b>{fmtRate(modeWarning.example.new)}</b> ≈ its latest{' '}
                        {fmtRate(modeWarning.example.latest_ppu)}/{modeWarning.example.purchase_unit}. In per-purchase mode it
                        would store <b><DualAvg perRecipe={modeWarning.example.new / (modeWarning.example.pack_size || 1)} unit={modeWarning.example.unit} pack={modeWarning.example.pack_size} pu={modeWarning.example.purchase_unit} /></b>{' '}
                        — as previewed below it would store {fmtRate(modeWarning.example.new)}/{modeWarning.example.unit} instead.
                      </div>
                    </>
                  ) : (
                    <>
                      <b>These rates look ~pack× too small vs these items&apos; latest purchase prices</b> — they
                      may be per RECIPE unit (₹/g, ₹/ml). {modeWarning.hits} of {modeWarning.eligible} pack items
                      are under 1/20th of their latest ₹/{modeWarning.example.purchase_unit || 'pack'} purchase price.
                    </>
                  )}
                </div>
              </div>
              <button onClick={() => switchModeAndRerun(modeWarning.to)} disabled={busy}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-50 ${modeWarning.to === 'purchase' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'}`}>
                {`Switch to per ${modeWarning.to === 'purchase' ? 'PURCHASE' : 'RECIPE'} unit & re-preview`}
              </button>
            </div>
          )}

          {preview && (
            <div className="space-y-2">
              <div className="text-sm font-semibold text-[#2D1B0E]">
                {preview.matchedCount} matched
                <span className="ml-2 text-xs font-normal text-[#8B7355]">(previewed as per {preview.basis === 'recipe' ? 'RECIPE' : 'PURCHASE'} unit)</span>
              </div>
              {preview.matched.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-[#E8D5C4] max-h-64 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-[#FFF1E3] text-[#8B7355] sticky top-0"><tr>
                      <th className="text-left px-2 py-1.5">SKU</th><th className="text-left px-2 py-1.5">Name</th>
                      <th className="text-right px-2 py-1.5">Old avg (both units)</th>
                      <th className="text-right px-2 py-1.5">New avg (both units)</th>
                    </tr></thead>
                    <tbody className="divide-y divide-[#F0E4D6]">
                      {preview.matched.map((m, i) => (
                        <tr key={i}>
                          <td className="px-2 py-1.5 font-mono text-[#8B7355]">{m.sku}</td>
                          <td className="px-2 py-1.5 text-[#2D1B0E]">{m.name}</td>
                          <td className="px-2 py-1.5 text-right text-[#8B7355]">
                            <DualAvg perRecipe={m.old} unit={m.unit} pack={m.pack_size} pu={m.purchase_unit} />
                          </td>
                          <td className="px-2 py-1.5 text-right font-semibold text-emerald-700">
                            <DualAvg perRecipe={m.new} unit={m.unit} pack={m.pack_size} pu={m.purchase_unit} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {preview.ambiguous.length > 0 && <div className="text-xs text-amber-700">⚠ {preview.ambiguous.length} name(s) match multiple materials — use the SKU instead: {preview.ambiguous.map(a => a.key).join(', ')}</div>}
              {preview.unmatched.length > 0 && <div className="text-xs text-red-700">✗ {preview.unmatched.length} not found: {preview.unmatched.slice(0, 20).join(', ')}{preview.unmatched.length > 20 ? '…' : ''}</div>}
              {preview.invalid.length > 0 && <div className="text-xs text-red-700">✗ {preview.invalid.length} invalid rate(s): {preview.invalid.map(i => i.key).slice(0, 10).join(', ')}</div>}
            </div>
          )}

          {/* Basis-corruption audit results */}
          {auditRows !== null && (
            <div className="space-y-2 border-t border-[#E8D5C4] pt-3">
              <div className="text-sm font-semibold text-[#2D1B0E]">
                Price-basis audit
                <span className="ml-2 text-xs font-normal text-[#8B7355]">
                  {auditScanned} pack materials scanned · {auditRows.length} suspicious
                </span>
              </div>
              {auditRows.length === 0 ? (
                <div className="bg-green-50 border border-green-200 rounded-lg p-2.5 text-sm text-green-800 flex items-center gap-2">
                  <CheckCircle className="w-4 h-4" /> No basis corruption detected — every stored average is plausible vs its latest purchase.
                </div>
              ) : (
                <>
                  <p className="text-xs text-[#8B7355]">
                    These stored averages look like <b>per-bottle/pack prices</b> sitting in the
                    per-recipe-unit field (~pack× too big vs the latest real purchase). Repair rewrites each
                    to <b>latest purchase price ÷ pack size</b>.
                  </p>
                  <div className="overflow-x-auto rounded-lg border border-[#E8D5C4] max-h-64 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-[#FFF1E3] text-[#8B7355] sticky top-0"><tr>
                        <th className="px-2 py-1.5 w-8"></th>
                        <th className="text-left px-2 py-1.5">Material</th>
                        <th className="text-right px-2 py-1.5">Stored avg (both units)</th>
                        <th className="text-right px-2 py-1.5">Will become (both units)</th>
                        <th className="text-right px-2 py-1.5">Off by</th>
                      </tr></thead>
                      <tbody className="divide-y divide-[#F0E4D6]">
                        {auditRows.map(r => (
                          <tr key={r.id} className={r.checked ? '' : 'opacity-50'}>
                            <td className="px-2 py-1.5">
                              <input type="checkbox" checked={r.checked}
                                     onChange={e => setAuditRows(rs => (rs || []).map(x => x.id === r.id ? { ...x, checked: e.target.checked } : x))}
                                     className="w-3.5 h-3.5 accent-[#af4408]" />
                            </td>
                            <td className="px-2 py-1.5">
                              <div className="text-[#2D1B0E] font-medium">{r.name}</div>
                              <div className="text-[9px] font-mono text-[#8B7355]">{r.sku} · pack {r.pack} {r.unit}/{r.purchase_unit} · latest {fmtRate(r.latest_ppu)}/{r.purchase_unit}</div>
                            </td>
                            <td className="px-2 py-1.5 text-right text-red-700">
                              <DualAvg perRecipe={r.stored_avg} unit={r.unit} pack={r.pack} pu={r.purchase_unit} />
                            </td>
                            <td className="px-2 py-1.5 text-right font-semibold text-emerald-700">
                              <DualAvg perRecipe={r.expected_avg} unit={r.unit} pack={r.pack} pu={r.purchase_unit} />
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono text-red-700">≈{r.ratio}×</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-end">
                    <button onClick={repairSelected} disabled={auditBusy || auditTicked === 0}
                      className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
                      {auditBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                      Repair selected ({auditTicked})
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[#E8D5C4] flex flex-wrap items-center gap-2 shrink-0">
          {canAudit && (
            <button onClick={runAudit} disabled={auditBusy}
              title="Scan all pack materials for averages that look per-bottle/pack instead of per-recipe-unit (compared against the latest real purchase)."
              className="px-3 py-2 bg-white border border-amber-500 text-amber-700 hover:bg-amber-50 rounded-lg text-sm font-medium flex items-center gap-1.5 disabled:opacity-50">
              {auditBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Audit price bases
            </button>
          )}
          <div className="flex-1" />
          <button onClick={onClose} disabled={busy} className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">Close</button>
          <button onClick={() => run(true)} disabled={busy} className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm font-medium flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Preview
          </button>
          <button onClick={() => run(false)} disabled={busy || !preview || preview.matchedCount === 0}
            title={!preview ? 'Preview first' : ''}
            className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />} Apply {preview ? `(${preview.matchedCount})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Inline per-row rate edit ─────────────────────────────────────────────
// The Avg Price cell: click to edit the rate in ₹ per PURCHASE unit (how you
// read it off an invoice). On save it POSTs to /api/inventory/update-rates
// (basis 'purchase'), which divides by pack_size → per-recipe-unit average_price.
// Because requisition/party costs read average_price LIVE, the fix flows to all
// past requisitions immediately.
function EditableRate({ m, onSaved }: { m: RawMaterial; onSaved: () => void }) {
  // Guarded factor (1 when recipe unit = purchase unit) — must mirror the
  // server's update-rates conversion or a kg/kg pack-15 row would display
  // average_price × 15 and re-save it 15× inflated.
  const ps = packFactor(m as any);
  const pu = (m as any).purchase_unit || m.unit;
  const current = (Number(m.average_price) || 0) * ps;   // ₹ per purchase unit
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = () => { setVal(current ? String(Math.round(current * 10000) / 10000) : ''); setErr(null); setEditing(true); };
  const save = async () => {
    const rate = Number(val);
    if (!Number.isFinite(rate) || rate < 0) { setErr('bad'); return; }
    setSaving(true); setErr(null);
    try {
      const r = await api('/api/inventory/update-rates', { method: 'POST', body: { rows: [{ key: (m as any).sku || m.name, rate }], basis: 'purchase' } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if ((j.applied || 0) < 1) throw new Error('no match');
      setEditing(false);
      onSaved();
    } catch (e: any) { setErr(e?.message || 'failed'); }
    finally { setSaving(false); }
  };

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1 justify-end">
        <span className="text-[10px] text-[#8B7355]">₹</span>
        <input
          autoFocus type="number" min={0} step="any" value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
          className={`w-20 border rounded px-1.5 py-0.5 text-right text-xs bg-white ${err ? 'border-red-400' : 'border-[#D4B896]'}`}
        />
        <span className="text-[10px] text-[#8B7355]">/{pu}</span>
        <button onClick={save} disabled={saving} title="Save" className="text-emerald-600 hover:text-emerald-700 disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
        </button>
        <button onClick={() => setEditing(false)} disabled={saving} title="Cancel" className="text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-3.5 h-3.5" /></button>
      </span>
    );
  }
  return (
    <button onClick={start} title="Click to edit the rate (₹ per purchase unit)"
      className="group inline-flex items-center gap-1 justify-end hover:text-[#af4408]">
      {current ? formatCurrency(current) : <span className="text-[#C0A98F]">—</span>}
      {ps > 1 && <span className="ml-0.5 text-[10px] text-[#8B7355]">/ {pu}</span>}
      <Edit className="w-3 h-3 opacity-0 group-hover:opacity-100 text-[#af4408]" />
    </button>
  );
}

// ─── Bulk priority stars ─────────────────────────────────────────────────
// Two modes against POST /api/inventory/priority (admin / store manager):
//   By category  — tick categories + pick a star level → preview count → apply.
//   Smart suggest — pure-SQL heuristic (consumption frequency + recipe usage,
//   NO LLM call): preview table with per-row untick → apply selected.
interface SuggestRow {
  id: string; sku: string; name: string; category: string;
  current: number; suggested: number; reason: string; ticked: boolean;
}
const starsOf = (n: number) => '⭐'.repeat(n === 3 ? 3 : n === 1 ? 1 : 2);

function SetPriorityModal({ categories, onClose, onApplied }: {
  categories: string[]; onClose: () => void; onApplied: () => void;
}) {
  const [tab, setTab] = useState<'category' | 'suggest'>('category');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // By-category state
  const [selCats, setSelCats] = useState<Set<string>>(new Set());
  const [level, setLevel] = useState<1 | 2 | 3>(3);
  const [catPreview, setCatPreview] = useState<number | null>(null);

  // Smart-suggest state
  const [sugRows, setSugRows] = useState<SuggestRow[] | null>(null);

  const toggleCat = (c: string) => {
    setCatPreview(null);
    setSelCats(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  };

  const post = async (body: any) => {
    const r = await api('/api/inventory/priority', { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };

  const previewCategory = async () => {
    if (selCats.size === 0) { setError('Pick at least one category'); return; }
    setBusy(true); setError(null); setDone(null);
    try {
      const j = await post({ mode: 'category', categories: [...selCats], priority: level, dryRun: true });
      setCatPreview(Number(j.count) || 0);
    } catch (e: any) { setError(e?.message || 'Preview failed'); }
    finally { setBusy(false); }
  };

  const applyCategory = async () => {
    setBusy(true); setError(null);
    try {
      const j = await post({ mode: 'category', categories: [...selCats], priority: level });
      setDone(`Set ${j.applied} material${j.applied === 1 ? '' : 's'} to ${starsOf(level)}.`);
      setCatPreview(null);
      onApplied();
    } catch (e: any) { setError(e?.message || 'Apply failed'); }
    finally { setBusy(false); }
  };

  const runSuggest = async () => {
    setBusy(true); setError(null); setDone(null);
    try {
      const j = await post({ mode: 'suggest' });
      setSugRows((j.rows || []).map((r: any) => ({ ...r, ticked: true })));
    } catch (e: any) { setError(e?.message || 'Suggest failed'); }
    finally { setBusy(false); }
  };

  const applySuggest = async () => {
    const picked = (sugRows || []).filter(r => r.ticked);
    if (picked.length === 0) { setError('No rows ticked'); return; }
    setBusy(true); setError(null);
    try {
      const j = await post({ mode: 'apply', rows: picked.map(r => ({ id: r.id, priority: r.suggested })) });
      setDone(`Applied ${j.applied} suggestion${j.applied === 1 ? '' : 's'}.`);
      setSugRows(null);
      onApplied();
    } catch (e: any) { setError(e?.message || 'Apply failed'); }
    finally { setBusy(false); }
  };

  const tickedCount = (sugRows || []).filter(r => r.ticked).length;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl shadow-xl flex flex-col overflow-hidden"
           style={{ maxHeight: 'calc(100vh - 1.5rem)' }} onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">
            <Star className="w-5 h-5 text-amber-500" /> Set Priority Stars
          </div>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
        </div>

        {/* Mode tabs */}
        <div className="px-5 pt-3 flex gap-2 text-sm shrink-0">
          <button onClick={() => { setTab('category'); setError(null); }}
                  className={`px-3 py-1.5 rounded-lg border ${tab === 'category' ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}>
            By category
          </button>
          <button onClick={() => { setTab('suggest'); setError(null); }}
                  className={`px-3 py-1.5 rounded-lg border flex items-center gap-1.5 ${tab === 'suggest' ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}>
            <Sparkles className="w-3.5 h-3.5" /> Smart suggest
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          <p className="text-xs text-[#8B7355]">
            <b>⭐⭐⭐ Critical</b> items are the ONLY ones counted in the notification bell and the WhatsApp
            daily low-stock ping. <b>⭐⭐ Standard</b> / <b>⭐ Low</b> stay visible on the Store Dashboard
            and Smart Reorder, grouped below critical.
          </p>

          {error && <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-sm text-red-700">{error}</div>}
          {done && <div className="bg-green-50 border border-green-200 rounded-lg p-2.5 text-sm text-green-800 flex items-center gap-2"><CheckCircle className="w-4 h-4" /> {done}</div>}

          {tab === 'category' ? (
            <>
              <div>
                <div className="text-xs font-medium text-[#6B5744] mb-1.5">1. Pick categories ({selCats.size} selected)</div>
                <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto border border-[#E8D5C4] rounded-lg p-2">
                  {categories.map(c => (
                    <button key={c} onClick={() => toggleCat(c)}
                            className={`px-2 py-1 rounded-full border text-xs ${selCats.has(c) ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-[#FFF8F0] text-[#6B5744] border-[#E8D5C4]'}`}>
                      {categoryLabel(c)}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-[#6B5744] mb-1.5">2. Star level to apply</div>
                <div className="grid grid-cols-3 gap-2 max-w-sm">
                  {PRIORITY_OPTIONS.map(p => (
                    <button key={p.v} onClick={() => { setLevel(p.v); setCatPreview(null); }} title={p.hint}
                            className={`flex flex-col items-center gap-0.5 px-2 py-2 rounded-lg border text-xs ${level === p.v ? 'border-[#af4408] bg-[#af4408]/10 text-[#af4408] font-semibold' : 'border-[#D4B896] bg-[#FFF1E3] text-[#6B5744]'}`}>
                      <span className="text-sm leading-none">{p.stars}</span>
                      <span>{p.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              {catPreview != null && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-sm text-amber-900">
                  <b>{catPreview}</b> material{catPreview === 1 ? '' : 's'} in {selCats.size} categor{selCats.size === 1 ? 'y' : 'ies'} will
                  be set to <b>{starsOf(level)} {PRIORITY_OPTIONS.find(p => p.v === level)?.label}</b>.
                </div>
              )}
            </>
          ) : (
            <>
              {sugRows === null ? (
                <div className="text-center py-6 space-y-3">
                  <p className="text-xs text-[#8B7355] max-w-md mx-auto">
                    Computes a suggestion per material from the last 30/90 days of issues &amp; consumption
                    plus recipe usage — instant and free (pure SQL, no AI tokens):
                    <br />⭐⭐⭐ top-25% consumption OR in ≥3 active recipes, with a reorder level set
                    <br />⭐ nothing consumed in 90 days AND not in any recipe
                    <br />⭐⭐ everything else
                  </p>
                  <button onClick={runSuggest} disabled={busy}
                          className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    Compute suggestions
                  </button>
                </div>
              ) : sugRows.length === 0 ? (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
                  Every material already matches its suggested star level — nothing to change.
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-[#6B5744]">
                    <span><b>{sugRows.length}</b> change{sugRows.length === 1 ? '' : 's'} suggested · {tickedCount} ticked</span>
                    <span className="flex gap-2">
                      <button onClick={() => setSugRows(rs => (rs || []).map(r => ({ ...r, ticked: true })))} className="text-[#af4408] hover:underline">tick all</button>
                      <button onClick={() => setSugRows(rs => (rs || []).map(r => ({ ...r, ticked: false })))} className="text-[#af4408] hover:underline">untick all</button>
                    </span>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-[#E8D5C4] max-h-72 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-[#FFF1E3] text-[#8B7355] sticky top-0"><tr>
                        <th className="px-2 py-1.5 w-8"></th>
                        <th className="text-left px-2 py-1.5">Material</th>
                        <th className="text-center px-2 py-1.5 whitespace-nowrap">Current → Suggested</th>
                        <th className="text-left px-2 py-1.5">Reason</th>
                      </tr></thead>
                      <tbody className="divide-y divide-[#F0E4D6]">
                        {sugRows.map(r => (
                          <tr key={r.id} className={r.ticked ? '' : 'opacity-50'}>
                            <td className="px-2 py-1.5">
                              <input type="checkbox" checked={r.ticked}
                                     onChange={e => setSugRows(rs => (rs || []).map(x => x.id === r.id ? { ...x, ticked: e.target.checked } : x))}
                                     className="w-3.5 h-3.5 accent-[#af4408]" />
                            </td>
                            <td className="px-2 py-1.5">
                              <div className="text-[#2D1B0E] font-medium">{r.name}</div>
                              <div className="text-[9px] font-mono text-[#8B7355]">{r.sku}{r.sku && r.category ? ' · ' : ''}{r.category}</div>
                            </td>
                            <td className="px-2 py-1.5 text-center whitespace-nowrap">
                              {starsOf(r.current)} <span className="text-[#8B7355]">→</span> <b>{starsOf(r.suggested)}</b>
                            </td>
                            <td className="px-2 py-1.5 text-[#6B5744]">{r.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">Close</button>
          {tab === 'category' ? (
            <>
              <button onClick={previewCategory} disabled={busy || selCats.size === 0}
                      className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm font-medium flex items-center gap-1.5 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Preview
              </button>
              <button onClick={applyCategory} disabled={busy || catPreview == null || catPreview === 0}
                      title={catPreview == null ? 'Preview first' : ''}
                      className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                Apply {catPreview != null ? `(${catPreview})` : ''}
              </button>
            </>
          ) : (
            sugRows !== null && sugRows.length > 0 && (
              <button onClick={applySuggest} disabled={busy || tickedCount === 0}
                      className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                Apply selected ({tickedCount})
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
