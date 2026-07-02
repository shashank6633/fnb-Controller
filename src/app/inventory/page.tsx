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
  AlertCircle,
  TrendingDown,
  TrendingUp,
  Minus,
} from 'lucide-react';
import Papa from 'papaparse';
import { api } from '@/lib/api';

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
};

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

  // Closing Stock
  const [closingStockOpen, setClosingStockOpen] = useState(false);
  const [closingDate, setClosingDate] = useState(new Date().toISOString().split('T')[0]);
  const [closingItems, setClosingItems] = useState<Record<string, { physical_stock: string; notes: string }>>({});
  const [closingSearch, setClosingSearch] = useState('');
  const [closingCategory, setClosingCategory] = useState('');
  const [adjustStock, setAdjustStock] = useState(false);
  const [closingSubmitting, setClosingSubmitting] = useState(false);
  const [closingResult, setClosingResult] = useState<{ success: number; errors: string[] } | null>(null);
  const [closingHistory, setClosingHistory] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyDate, setHistoryDate] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<any[]>([]);
  const [historySummary, setHistorySummary] = useState<any>(null);

  /* ---- Fetch ---- */

  const fetchMaterials = useCallback(async () => {
    try {
      setLoading(true);
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
      // Show price in purchase-unit terms (₹/kg) for editing — easier to read off invoices
      avg_price_per_purchase_unit: Number(
        (((m as any).average_price || 0) * ((m as any).pack_size || 1)).toFixed(4)
      ),
      // Show reorder level in purchase-unit terms (kg / BTL) — easier to think about
      reorder_level_purchase_unit: Number(
        ((m.reorder_level || 0) / ((m as any).pack_size || 1)).toFixed(3)
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
      // dividing by pack_size. The stored value is always per recipe-unit so
      // recipe-cost math (qty × average_price) stays correct.
      const ps = Number(formData.pack_size) || 1;
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
            onClick={fetchMaterials}
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

  /* ---- Closing Stock ---- */

  const openClosingStock = () => {
    setClosingStockOpen(true);
    setClosingDate(new Date().toISOString().split('T')[0]);
    setClosingResult(null);
    setClosingSearch('');
    setClosingCategory('');
    setShowHistory(false);
    // Pre-fill with current system stock
    const items: Record<string, { physical_stock: string; notes: string }> = {};
    for (const m of materials) {
      items[m.id] = { physical_stock: '', notes: '' };
    }
    setClosingItems(items);
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

  const viewHistoryDate = async (date: string) => {
    setHistoryDate(date);
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/closing-stock?date=${date}`);
      if (res.ok) {
        const json = await res.json();
        setHistoryItems(json.items || []);
        setHistorySummary(json.summary || null);
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
        body: { date: closingDate, items: itemsToSubmit, adjust_stock: adjustStock },
      });
      const json = await res.json();
      setClosingResult(json);
      if (json.success > 0) {
        await fetchMaterials();
        await fetchClosingHistory();
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
            <button
              onClick={openClosingStock}
              className="flex items-center gap-2 px-4 py-2.5 border border-green-600 text-green-700 hover:bg-green-50 rounded-lg text-sm font-medium transition-colors"
            >
              <ClipboardCheck className="w-4 h-4" />
              Closing Stock
            </button>
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
            <button onClick={() => setImportResult(null)} className="p-1 hover:opacity-70"><X className="w-4 h-4" /></button>
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

            {/* Low Stock Toggle */}
            <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={showLowStock}
                  onChange={(e) => setShowLowStock(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-[#D4B896] rounded-full peer-checked:bg-red-600 transition-colors" />
                <div className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow peer-checked:translate-x-4 transition-transform" />
              </div>
              <span className="text-sm text-[#6B5744]">Show Low Stock Only</span>
            </label>

            {/* Auto-discovered Toggle — surfaces materials that need review */}
            <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap"
                   title="Materials auto-created from imports (e.g. Recaho transfers). Review price/unit/category before relying on them.">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={showAutoDiscovered}
                  onChange={(e) => setShowAutoDiscovered(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-[#D4B896] rounded-full peer-checked:bg-amber-600 transition-colors" />
                <div className="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow peer-checked:translate-x-4 transition-transform" />
              </div>
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
                            const ps = (m as any).pack_size;
                            const ru = m.unit;
                            const pu = (m as any).purchase_unit || m.unit;
                            if (ps && ps !== 1) {
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
                            const ps = (m as any).pack_size || 1;
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
                            beside Current Stock. Derived server-side from total/qty of the
                            last purchase (basis-safe against historical rows whose quantity
                            was recorded in recipe units instead of purchase units). */}
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
                          {(() => {
                            // Show price in purchase-unit terms too: ₹/BTL = ₹/ml × pack_size
                            const ps = (m as any).pack_size || 1;
                            const pu = (m as any).purchase_unit || m.unit;
                            if (ps > 1) {
                              return (
                                <>
                                  {formatCurrency(m.average_price * ps)}
                                  <span className="ml-1 text-[10px] text-[#8B7355]">/ {pu}</span>
                                </>
                              );
                            }
                            return formatCurrency(m.average_price);
                          })()}
                        </td>
                        <td className="px-4 py-3 text-right text-[#3D2614] font-mono">
                          {formatCurrency(m.stock_value ?? 0)}
                        </td>
                        <td className="px-4 py-3 text-right text-[#8B7355] font-mono">
                          {(() => {
                            const ps = (m as any).pack_size || 1;
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
                            className="p-1.5 rounded-lg text-[#8B7355] hover:text-[#2D1B0E] hover:bg-[#FFF1E3] transition-colors"
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
                          const ps = (m as any).pack_size || 1;
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
                  const ps = Number(formData.pack_size) || 1;
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
                  const ps = Number(formData.pack_size) || 1;
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
      {/* ================================================================ */}
      {/* CLOSING STOCK MODAL                                              */}
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
              <div className="flex items-center gap-3">
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
                {/* Date & Options */}
                <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-end">
                  <div>
                    <label className="block text-xs font-medium text-[#6B5744] mb-1">Closing Date *</label>
                    <input
                      type="date"
                      value={closingDate}
                      onChange={e => setClosingDate(e.target.value)}
                      className="px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408] [color-scheme:light]"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
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
                  <label className="flex items-center gap-2 cursor-pointer bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <input type="checkbox" checked={adjustStock} onChange={e => setAdjustStock(e.target.checked)} className="accent-[#af4408] w-4 h-4" />
                    <span className="text-xs text-amber-800 font-medium whitespace-nowrap">Adjust system stock</span>
                  </label>
                </div>

                {adjustStock && (
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
