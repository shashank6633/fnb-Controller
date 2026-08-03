'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
import Link from 'next/link';
import { fmtISTDate, todayIST } from '@/lib/format-date';
import {
  ShoppingCart,
  Plus,
  Search,
  X,
  Calendar,
  Loader2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Users,
  IndianRupee,
  FileText,
  Trash2,
  Receipt,
  Upload,
  FileSpreadsheet,
  CheckCircle,
  AlertCircle,
  Download,
  Merge,
  Link2,
} from 'lucide-react';
import Papa from 'papaparse';
import type { Purchase, RawMaterial } from '@/types';
import { api } from '@/lib/api';
import MaterialTypeahead from '@/components/MaterialTypeahead';
import Combobox from '@/components/Combobox';
import { packFactor, fmtQtyNum } from '@/lib/pack-units';

function formatCurrency(value: number): string {
  return '₹' + value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function todayString(): string {
  const d = new Date();
  return d.toISOString().split('T')[0];
}

/** Subtract n days from a YYYY-MM-DD string (UTC math avoids DST/local drift). */
function isoMinusDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}


/**
 * The GST rates this kitchen's bills actually carry. A fixed list, not a free
 * number box: a typo'd "1.8" on a ₹40,000 bill is a tax figure nobody catches
 * until the return is filed.
 */
const GST_RATES = ['0', '5', '12', '18', '28'] as const;

/**
 * Client-side mirror of store-engine's SQL catNorm(): lower-case, then strip
 * spaces / hyphens / underscores, so 'Single-Malt Whiskey', 'single malt
 * whiskey' and 'singlemaltwhiskey' all compare equal. Both sides of every
 * store_category_map ↔ raw_materials.category comparison must use it, or a
 * liquor category spelled with a hyphen goes unrecognised and gets taxed.
 */
const catKey = (s: unknown) => String(s || '').trim().toLowerCase().replace(/[\s\-_]/g, '');

/** Round to paisa. Every money figure on this form goes through this one place. */
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---- Bill Entry Types ----
interface BillLineItem {
  id: number;
  material_id: string;
  brand: string;
  quantity: string;
  unit_price: string;
  line_total: number;
  discount_share: number;
  delivery_share: number;
  final_unit_price: number;
  /** 'btl' = qty is bottles (default; price per bottle).
   *  'case' = qty is cases; submit-time we expand to qty × case_size bottles. */
  entry_mode?: 'btl' | 'case';
  /**
   * RAW select value. '' = inherit the bill-level rate; otherwise a percent
   * string ('5', '12', '18'). Deliberately a STRING in state and parsed only
   * inside billCalc — Number()-ing a rate box on every keystroke is what makes
   * a decimal untypeable, the same trap the qty/price boxes already avoid.
   */
  gst_rate: string;
  /**
   * GST COMPENSATION CESS %, per line. A separate levy from GST — never folded
   * into gst_rate, never split into halves, and NEVER added to tax_value: doing
   * either corrupts the CGST/SGST figure that a return is filed on.
   * Per-line only, with no bill-level default: one bill is almost always one GST
   * rate, but cess is item-specific (the Coke cases on a bill carry it, the rest
   * of the bill does not), so a bill-level default would seed cess onto lines
   * that never bore it. '' = none. Raw string, same reason as gst_rate.
   */
  cess_rate: string;
}

interface BillFormData {
  vendor: string;
  bill_number: string;
  date: string;
  /** Recorded against the bill for vendor/spend reporting. Never enters unit cost. */
  delivery_mode: 'percent' | 'amount';
  delivery_value: string;
  /** REDUCES unit cost — a discount genuinely lowers what the goods cost. */
  discount_mode: 'percent' | 'amount';
  discount_value: string;
  /**
   * Bill-level GST % that every line inherits unless that line overrides it.
   * One vendor bill is almost always one rate; retyping it on twenty lines is
   * how one line silently ends up on the wrong rate. Raw string, same reason
   * as BillLineItem.gst_rate.
   */
  gst_rate: string;
  notes: string;
  items: BillLineItem[];
}

let billLineIdCounter = 1;

/**
 * One bill-level charge row: By % / By Amount + the resolved ₹ figure.
 * Shared by Delivery Charges and Discount so the two always look and behave the
 * same — the only difference is what each does to cost, which `hint` states.
 */
function ChargeRow({ label, hint, mode, value, onMode, onValue, placeholder, total, tone, negative }: {
  label: string; hint: string;
  mode: 'percent' | 'amount'; value: string;
  onMode: (m: 'percent' | 'amount') => void;
  onValue: (v: string) => void;
  placeholder: string; total: number; tone: string; negative?: boolean;
}) {
  const name = label.replace(/\s+/g, '-').toLowerCase();
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <span className="text-sm font-medium text-[#6B5744] min-w-[130px]">
        {label}
        <span className="block text-[10px] font-normal text-[#8B7355]">{hint}</span>
      </span>
      <div className="flex items-center gap-2">
        {(['percent', 'amount'] as const).map(m => (
          <label key={m} className="flex items-center gap-1.5 cursor-pointer">
            {/* name= groups the pair, so the two rows don't share a selection */}
            <input type="radio" name={name} checked={mode === m} onChange={() => onMode(m)} className="accent-[#af4408]" />
            <span className="text-sm text-[#6B5744]">{m === 'percent' ? 'By %' : 'By Amount'}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-1">
        {mode === 'amount' && <span className="text-sm text-[#8B7355]">₹</span>}
        <input
          type="number" step="0.01" min="0" value={value}
          onChange={e => onValue(e.target.value)}
          placeholder={placeholder}
          className="w-28 px-3 py-1.5 bg-white border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
        />
        <span className="text-sm text-[#8B7355]">{mode === 'percent' ? '%' : ''}</span>
      </div>
      <span className={`text-sm font-medium ml-auto ${tone}`}>
        {negative && total > 0 ? '- ' : ''}{formatCurrency(total)}
      </span>
    </div>
  );
}

function emptyBillLine(): BillLineItem {
  return {
    id: billLineIdCounter++,
    material_id: '',
    brand: '',
    quantity: '',
    unit_price: '',
    line_total: 0,
    discount_share: 0,
    delivery_share: 0,
    final_unit_price: 0,
    entry_mode: 'btl',
    gst_rate: '',   // '' = follow the bill-level rate
    cess_rate: '',  // '' = no compensation cess (there is no bill-level cess to follow)
  };
}

const emptyBill: BillFormData = {
  vendor: '',
  bill_number: '',
  date: todayString(),
  delivery_mode: 'amount',
  delivery_value: '',
  discount_mode: 'percent',
  discount_value: '',
  // Default 0% so a bill entered exactly the way it always was books exactly the
  // same numbers. Tax is opt-in per bill, never assumed.
  gst_rate: '0',
  notes: '',
  items: [emptyBillLine(), emptyBillLine()],
};

export default function PurchasesPage() {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  /**
   * Vendor master for the bill's Vendor field. `vendorsFailed` flips that field
   * back to plain free text with a note: an empty dropdown that can't be filled
   * is worse than a typo — it stops a bill being entered at all.
   */
  const [vendors, setVendors] = useState<Array<{ id: string; name: string }>>([]);
  const [vendorsFailed, setVendorsFailed] = useState(false);
  /**
   * catKey()-normalised categories owned by an ACTIVE store location. A material
   * in one of these is TGBCL liquor: it is taxed through the store's bill charges
   * (excise / cess / TCS), never through GST, so its line is forced to 0%.
   * Empty set = unknown (fetch failed / no stores) — we then leave rates alone
   * rather than guess, and /api/purchases blocks store-mapped lines regardless.
   */
  const [storeCats, setStoreCats] = useState<Set<string>>(new Set());
  /**
   * PURCHASE-unit label resolver for every quantity/rate box on this page.
   * /api/purchases, /api/purchases/bulk and /api/purchases/opening-stock all
   * read `quantity` as PURCHASE units and `unit_price` as ₹ per purchase unit;
   * each applies the ×pack_size step to stock itself. So nothing here converts —
   * this only supplies the LABEL and the "= N g" reading hint, and posting is
   * untouched. `pf` is 1 unless BOTH halves of the guard hold (pack_size > 1 AND
   * recipe unit ≠ purchase unit) — packFactor owns that rule.
   */
  const matUnits = (materialId: string) => {
    const m = materials.find(x => x.id === materialId) as any;
    if (!m) return { pu: '', ru: '', pf: 1 };
    const ru = String(m.unit || '');
    return {
      pu: String(m.purchase_unit || ru || ''),
      ru,
      pf: packFactor({ unit: ru, purchase_unit: m.purchase_unit, pack_size: m.pack_size }),
    };
  };
  /** "= 20,000 g" for a purchase-unit entry box. Reads the RAW string — never
   *  writes it back (Number()-ing on each keystroke makes "2." untypeable). */
  const recipeHint = (raw: string, u: { ru: string; pf: number }) => {
    if (u.pf <= 1) return null;
    const q = parseFloat(raw);
    if (!Number.isFinite(q) || q === 0) return null;
    return `= ${fmtQtyNum(q * u.pf)} ${u.ru}`;
  };
  /**
   * Is this quantity/price box actually on the CASE basis? This is the LABEL
   * mirror of the guard inside billSubmit(): it multiplies
   * the typed quantity (and divide the typed rate) by case_size ONLY when the
   * mode is 'case' AND case_size > 1. A mode left on 'case' after switching to
   * a non-case material silently falls back to purchase-unit behaviour, so a
   * label keyed on entry_mode ALONE would announce a basis the arithmetic is
   * not using. Every annotation on both forms keys on this one helper — the
   * bug being fixed here was exactly one annotation guarding and its sibling
   * not (buyer read "in BTL", typed 60 cases-worth, booked 720 bottles).
   */
  const caseBasis = (materialId: string, mode?: 'btl' | 'case') => {
    const cs = Number((materials.find(x => x.id === materialId) as any)?.case_size) || 1;
    return { cs, on: mode === 'case' && cs > 1 };
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [appliedFilters, setAppliedFilters] = useState({ search: '', from: '', to: '' });

  // Sort
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Modal

  // Toast
  const [toast, setToast] = useState<string | null>(null);
  /** Non-blocking notes the SERVER returned on an otherwise successful bill save:
   *  a vendor↔item pair it would not map (not in the master / deliberately
   *  removed before), or lines it folded together. The save succeeded either
   *  way — these must never look like failures, and must never auto-dismiss:
   *  "N items added" followed by fewer rows is exactly the moment a storekeeper
   *  needs the reason on screen. */
  const [billNotices, setBillNotices] = useState<string[]>([]);

  // Backdate limit (configurable) + admin exemption. Server is the real guard;
  // these drive the date-input min/max (UX only) and the admin editor below.
  const [backdateLimit, setBackdateLimit] = useState(3);
  const [isAdmin, setIsAdmin] = useState(false);
  const [limitInput, setLimitInput] = useState('3');
  const [limitSaving, setLimitSaving] = useState(false);
  const [limitSaved, setLimitSaved] = useState(false);

  // Non-admins are penned to [today - N, today]. Admins get no min/max.
  const dateMin = isAdmin ? undefined : isoMinusDays(todayIST(), backdateLimit);
  const dateMax = isAdmin ? undefined : todayIST();
  const backdateHint = `Backdating limited to ${backdateLimit} day(s) (admins exempt)`;

  // Bill Entry Modal
  const [billModalOpen, setBillModalOpen] = useState(false);
  const [billData, setBillData] = useState<BillFormData>({ ...emptyBill });
  const [billSubmitting, setBillSubmitting] = useState(false);
  const [billError, setBillError] = useState<string | null>(null);

  // Recaho Inward Upload
  const [recahoOpen, setRecahoOpen] = useState(false);

  // Bulk Upload
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkFileName, setBulkFileName] = useState<string | null>(null);
  const [bulkParsedData, setBulkParsedData] = useState<any[]>([]);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkResult, setBulkResult] = useState<{
    success: number; skipped: number; errors: string[];
    duplicates?: number;
    skipped_rows?: Array<{
      row: number; item_name: string; sku: string; vendor: string; brand: string;
      quantity: any; unit_price: any; total_amount: any; gst_amount: any;
      date: string; notes: string; bill_no: string;
      category_name: string; po_qty: any; purchase_unit: string;
      discount: any; cgst: any; sgst: any; special_excise_cess: any; tcs: any; delivery_charges: any; mrp_round_off: any;
      kind: string; reason: string;
    }>;
  } | null>(null);

  // Build a re-uploadable CSV of the rows that did NOT import (fix + re-upload
  // just these). Same columns as the Bulk template + a reason column.
  const downloadSkippedRows = () => {
    const rows = bulkResult?.skipped_rows || [];
    if (rows.length === 0) return;
    // Must mirror the Bulk template's columns (incl. the 7 charges the server
    // echoes back) so fix-and-re-upload never silently zeroes a charge.
    const header = ['date', 'vendor', 'bill_no', 'category_name', 'sku', 'item_name',
      'po_qty', 'quantity', 'purchase_unit', 'unit_price', 'total_amount',
      'discount', 'cgst', 'sgst', 'special_excise_cess', 'tcs', 'delivery_charges', 'mrp_round_off',
      'brand', 'gst_amount', 'notes', 'reason'];
    const esc = (v: any) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;            // CSV formula-injection guard
      if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const lines = [header.join(',')].concat(rows.map(r =>
      [r.date, r.vendor, r.bill_no, r.category_name, r.sku, r.item_name,
       r.po_qty, r.quantity, r.purchase_unit, r.unit_price, r.total_amount,
       r.discount, r.cgst, r.sgst, r.special_excise_cess, r.tcs, r.delivery_charges, r.mrp_round_off,
       r.brand, r.gst_amount, r.notes, r.reason].map(esc).join(',')));
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `unuploaded-purchases-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };
  const [bulkDragOver, setBulkDragOver] = useState(false);
  const bulkFileInputRef = useRef<HTMLInputElement>(null);
  // Opening-stock import (natural purchase units → base units via pack_size)
  const [openingBusy, setOpeningBusy] = useState(false);
  const openingFileRef = useRef<HTMLInputElement>(null);

  // Pagination
  const [page, setPage] = useState(1);
  const pageSize = 15;

  const fetchPurchases = async (filters?: { search?: string; from?: string; to?: string }) => {
    try {
      const params = new URLSearchParams();
      if (filters?.from) params.set('from', filters.from);
      if (filters?.to) params.set('to', filters.to);
      const qs = params.toString();
      const res = await fetch(`/api/purchases${qs ? '?' + qs : ''}`);
      if (!res.ok) throw new Error('Failed to fetch purchases');
      const json = await res.json();
      setPurchases(json.purchases || []);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const fetchMaterials = async () => {
    try {
      // scope=all — Purchases is a store operation; show every material
      // regardless of the signed-in user's dept-category whitelist.
      const res = await fetch('/api/inventory?scope=all');
      if (!res.ok) throw new Error('Failed to fetch materials');
      const json = await res.json();
      setMaterials(json.materials || []);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const fetchVendors = async () => {
    try {
      const res = await fetch('/api/vendors');
      if (!res.ok) throw new Error('Failed to fetch vendors');
      const json = await res.json();
      // Read the payload EXACTLY as the ad-hoc GRN form does (src/app/grn/page.tsx
      // ~476): the route answers { vendors: [...] }, and an inactive vendor must
      // never be offered — picking one would fragment spend onto a dead master row.
      setVendors((json.vendors || []).filter((v: any) => v.is_active));
      setVendorsFailed(false);
    } catch {
      setVendorsFailed(true);
    }
  };

  /**
   * Which categories belong to an ACTIVE store location. Any signed-in user may
   * GET /api/stores, and it already returns each store's mapped categories, so
   * the client can recognise a TGBCL/liquor line without a new endpoint.
   */
  const fetchStoreCategories = async () => {
    try {
      const res = await fetch('/api/stores');
      if (!res.ok) return;                       // leave the set empty = "unknown"
      const json = await res.json();
      const next = new Set<string>();
      for (const st of json.stores || []) {
        // A deactivated store releases its categories back to Central behaviour —
        // same rule materialStoreId() applies server-side.
        if (!st?.is_active) continue;
        for (const c of st.categories || []) {
          const k = catKey(c?.category);
          if (k) next.add(k);
        }
      }
      setStoreCats(next);
    } catch {
      // Leave empty. Rates then behave normally and the server still refuses any
      // store-mapped line outright (centralFlowBlock in /api/purchases POST).
    }
  };

  /** Is this line a store-mapped (TGBCL liquor) material — i.e. zero-rated here? */
  const storeMappedLine = (materialId: string) => {
    if (storeCats.size === 0 || !materialId) return false;
    const m = materials.find((x) => x.id === materialId) as any;
    return !!m && storeCats.has(catKey(m.category));
  };

  /**
   * The GST% a line should START at when this material is picked — the master's
   * raw_materials.tax_percent, which until now was a write-only field nobody on
   * the purchase side ever read (the whole reported bug).
   *
   * It SEEDS, it does not FORCE: a bill is a fact, and the printed vendor
   * invoice wins over a possibly-stale master. The storekeeper can change the
   * select immediately after.
   *
   * Two refusals, both deliberate — do not "simplify" either away:
   *   · store-mapped (TGBCL liquor) is zero-rated here and returns '' so no rate
   *     can ever be seeded onto it. tax_percent is a free field on the master
   *     with no liquor guard, so a manager CAN type 18 on a TGBCL item; the
   *     existing zero-rate locks (billCalc + the server) stay the authority and
   *     this sits strictly beneath them.
   *   · a rate that is not in GST_RATES (say 7) returns '' rather than a value
   *     matching no <option> — React would render the select blank, the
   *     storekeeper would read 0%, and billCalc would book 7%.
   * '' means "follow the bill-level rate", which is the pre-existing default.
   */
  const seedGstForMaterial = (materialId: string): string => {
    if (!materialId) return '';
    if (storeMappedLine(materialId)) return '';
    const m = materials.find((x) => x.id === materialId) as any;
    const t = Number(m?.tax_percent) || 0;
    if (t <= 0) return '';
    const s = String(t);
    return (GST_RATES as readonly string[]).includes(s) ? s : '';
  };

  /**
   * The COMPENSATION CESS % a line should start at — raw_materials.cess_percent,
   * the other half of the reported bug ("GST % and Cess % are added in the Raw
   * Material Master, but they are not picking automatically during Purchase
   * Entry"). Seeds exactly like the GST rate above, and the TGBCL refusal is the
   * same: a store-mapped line's duty rides on the store's own bill, so no rate
   * may be seeded onto it.
   *
   * ONE DELIBERATE DIFFERENCE from seedGstForMaterial: there is no GST_RATES
   * membership test. That test exists only because the GST control is a <select>
   * — a value matching no <option> renders blank and the storekeeper reads 0%.
   * The cess control is a free number input (mirroring the master's own free
   * 0-100 field), so any in-range value renders honestly and refusing e.g. 12.5
   * would silently drop real money. Only non-finite / <=0 / >100 are refused.
   */
  const seedCessForMaterial = (materialId: string): string => {
    if (!materialId) return '';
    if (storeMappedLine(materialId)) return '';
    const m = materials.find((x) => x.id === materialId) as any;
    const c = Number(m?.cess_percent);
    if (!Number.isFinite(c) || c <= 0 || c > 100) return '';
    return String(c);
  };

  const fetchBackdateConfig = async () => {
    try {
      const [sRes, mRes] = await Promise.all([
        fetch('/api/settings?key=purchase_backdate_limit_days'),
        fetch('/api/auth/me'),
      ]);
      const sJson = await sRes.json().catch(() => null);
      const raw = sJson?.value;
      const n = Math.max(0, Math.floor(Number(raw)));
      const limit = Number.isFinite(n) && raw != null && raw !== '' ? n : 3;
      setBackdateLimit(limit);
      setLimitInput(String(limit));
      const mJson = await mRes.json().catch(() => null);
      setIsAdmin(mJson?.user?.role === 'admin');
    } catch {
      // Leave defaults (3 days, non-admin). Server still enforces the real guard.
    }
  };

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await Promise.all([
        fetchPurchases(), fetchMaterials(), fetchBackdateConfig(),
        fetchVendors(), fetchStoreCategories(),
      ]);
      setLoading(false);
    };
    init();
  }, []);

  const saveBackdateLimit = async () => {
    const n = Math.max(0, Math.floor(Number(limitInput)));
    if (!Number.isFinite(n)) return;
    setLimitSaving(true);
    setLimitSaved(false);
    try {
      const res = await api('/api/settings', {
        method: 'PUT',
        body: { key: 'purchase_backdate_limit_days', value: String(n) },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || 'Failed to save');
      }
      setBackdateLimit(n);
      setLimitInput(String(n));
      setLimitSaved(true);
      setTimeout(() => setLimitSaved(false), 2500);
    } catch (err: any) {
      setToast(err.message || 'Failed to save backdate limit');
      setTimeout(() => setToast(null), 3000);
    } finally {
      setLimitSaving(false);
    }
  };

  const applyFilters = () => {
    const filters = { search: searchTerm, from: dateFrom, to: dateTo };
    setAppliedFilters(filters);
    setPage(1);
    fetchPurchases(filters);
  };

  // Filter purchases by search term client-side (API doesn't support text search)
  const filteredPurchases = purchases.filter((p) => {
    if (!appliedFilters.search) return true;
    const term = appliedFilters.search.toLowerCase();
    return (
      (p.material_name || '').toLowerCase().includes(term) ||
      p.vendor.toLowerCase().includes(term) ||
      p.brand.toLowerCase().includes(term)
    );
  });

  // Sort
  const sortedPurchases = [...filteredPurchases].sort((a, b) => {
    const cmp = a.date.localeCompare(b.date);
    return sortDir === 'desc' ? -cmp : cmp;
  });

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sortedPurchases.length / pageSize));
  const paginatedPurchases = sortedPurchases.slice((page - 1) * pageSize, page * pageSize);

  // Summary calculations
  const today = todayString();
  const todayTotal = purchases
    .filter((p) => p.date === today)
    .reduce((sum, p) => sum + p.total_price, 0);

  const currentMonth = today.slice(0, 7); // YYYY-MM
  const monthTotal = purchases
    .filter((p) => p.date.startsWith(currentMonth))
    .reduce((sum, p) => sum + p.total_price, 0);

  const vendorCount = new Set(purchases.map((p) => p.vendor).filter(Boolean)).size;

  // NOTE: the single-line "Add Purchase" form and its handlers were removed
  // with the button. Every purchase now goes through the bill entry below, so
  // there is one write path instead of two that could drift apart.

  // ---- Bill Entry Handlers ----

  const openBillModal = () => {
    billLineIdCounter = 1;
    setBillData({ ...emptyBill, date: todayString(), items: [emptyBillLine(), emptyBillLine()] });
    setBillError(null);
    // A "keep both" acknowledgement belongs to ONE bill — never carry it into
    // the next one. Same for the mapping panel's transient note/expansion.
    setDupAck([]);
    setBillMapNote(null);
    setVendorItemsOpen(false);
    setBillModalOpen(true);
  };

  const updateBillField = (field: keyof Omit<BillFormData, 'items'>, value: string) => {
    setBillData((prev) => ({ ...prev, [field]: value }));
    setBillError(null);
  };

  const addBillLine = () => {
    setBillData((prev) => ({ ...prev, items: [...prev.items, emptyBillLine()] }));
  };

  const removeBillLine = (id: number) => {
    setBillData((prev) => ({
      ...prev,
      items: prev.items.filter((item) => item.id !== id),
    }));
  };

  const updateBillLine = (id: number, field: keyof BillLineItem, value: string) => {
    setBillData((prev) => ({
      ...prev,
      items: prev.items.map((item) => {
        if (item.id !== id) return item;
        if (field !== 'material_id') return { ...item, [field]: value };
        // Picking/swapping the material re-seeds the line's GST% from the new
        // material's master rate — but ONLY when the current rate is still
        // machine-set: either untouched ('') or exactly what the PREVIOUS
        // material would have seeded. Anything else is a rate the storekeeper
        // deliberately typed off the printed bill, and silently resetting it is
        // a tax error nobody notices until the return is filed. The test must
        // stay "equals the previous seed" — a hardcoded '' would clobber every
        // seeded line on a material swap.
        const prevSeed = seedGstForMaterial(item.material_id);
        const keepRate = !(item.gst_rate === '' || item.gst_rate === prevSeed);
        // Compensation cess re-seeds under the SAME test, judged against its own
        // previous seed — a storekeeper who typed 5% cess off the printed bill
        // keeps it through a material swap exactly as they keep a typed GST%.
        const prevCessSeed = seedCessForMaterial(item.material_id);
        const keepCess = !(item.cess_rate === '' || item.cess_rate === prevCessSeed);
        return {
          ...item,
          material_id: value,
          gst_rate: keepRate ? item.gst_rate : seedGstForMaterial(value),
          cess_rate: keepCess ? item.cess_rate : seedCessForMaterial(value),
        };
      }),
    }));
  };

  /* ==============================================================
   * A. DUPLICATE LINES ON ONE BILL
   *
   * WHY IT MATTERS, in one sentence: handleBillSubmit POSTs each line to
   * /api/purchases SEPARATELY, so the same material on two lines writes TWO
   * purchases rows — stock is credited twice and the item passes through
   * updateMaterialPrice's weighted average twice, which then re-costs every
   * recipe that uses it. (The reported case: MAT-00192 CHAR COAL entered as
   * 600 kg AND 400 kg at ₹35/kg — one bill line typed as two.)
   *
   * WHY THE RULE IS MIRRORED HERE INSTEAD OF IMPORTED: the shared
   * duplicateLineError() / mergeDuplicateLines() live in src/lib/po-helpers.ts,
   * whose module scope imports @/lib/db → better-sqlite3, a native Node addon.
   * This page is a 'use client' component, so importing that module drags the
   * driver into the browser bundle and the build fails. No client file in this
   * repo imports a lib module that reaches db.ts, and this is not the place to
   * become the first. The semantics below are deliberately the SAME rule:
   *   · identity is material_id ALONE, trimmed (po-helpers' lineKey)
   *   · blank rows are legal and skipped (the form opens with two)
   *   · a merge SUMS the quantity onto the FIRST occurrence, which keeps its own
   *     rate (po-helpers' mergeDuplicateLines semantics)
   * If those two helpers are ever moved into a db-free module (e.g.
   * src/lib/line-dedupe.ts, re-exported from po-helpers), this block should
   * import them instead of restating them — that is a cross-file change.
   * ============================================================== */

  /** Trimmed material id — the identity a duplicate is judged on. */
  const lineMat = (it: BillLineItem) => String(it.material_id || '').trim();

  /**
   * Everything that must be IDENTICAL before two lines of one material may be
   * folded into one. The rate is the headline — a split-rate bill is a
   * LEGITIMATE bill shape, and silently averaging two rates would corrupt both
   * the stored rate and every recipe cost derived from it — but three more
   * fields change what a merged line would MEAN:
   *   · GST %   — a merge carries the FIRST line's rate onto the summed
   *               quantity, which would re-tax the other line's value.
   *   · Cess %  — same trap, its own levy: merging a 12%-cess line into a
   *               0%-cess line re-applies 12% to the summed quantity.
   *   · BTL/CASE— a per-case rate and a per-bottle rate are different numbers
   *               even when they read the same (billSubmit expands cases).
   *   · Brand   — one material_id billed under two brands is two things.
   * Anything that differs lands in the "you decide" branch, never in a merge.
   */
  const lineMergeKey = (it: BillLineItem, billRate: number) => {
    const rate = r2(parseFloat(it.unit_price) || 0);
    // Mirrors billCalc's rate resolution exactly, TGBCL zero-rating included.
    const zeroRated = storeMappedLine(it.material_id);
    const gst = zeroRated
      ? 0
      : (it.gst_rate === '' ? billRate : (parseFloat(it.gst_rate) || 0));
    // No bill-level fallback: '' simply means no cess on this line.
    const cess = zeroRated ? 0 : (parseFloat(it.cess_rate) || 0);
    const basis = caseBasis(it.material_id, it.entry_mode).on ? 'case' : 'unit';
    const brand = String(it.brand || '').trim().toLowerCase();
    return `${rate}|${gst}|${cess}|${basis}|${brand}`;
  };

  /** Which field(s) actually differ between two+ merge keys — so the warning
   *  says "a different rate", not just "these are different". */
  const keyDiffLabels = (keys: string[]) => {
    // Order MUST track lineMergeKey's field order — these read positionally.
    const fields = [
      'a different rate',
      'a different GST %',
      'a different Cess %',
      'a different BTL / CASE basis',
      'a different brand',
    ];
    const parts = keys.map((k) => k.split('|'));
    return fields.filter((_, i) => new Set(parts.map((p) => p[i])).size > 1);
  };

  /**
   * Duplicates AS THEY ARE ENTERED (recomputed every keystroke), never only at
   * submit. `bookable` counts the rows that would really be written — a line
   * with no quantity or no rate is dropped by validItems, so it cannot
   * double-credit anything and must not block a save on its own.
   */
  const dupInfo = useMemo(() => {
    const billRate = parseFloat(billData.gst_rate) || 0;
    type Row = { idx: number; line: BillLineItem; key: string; bookable: boolean };
    const byMat = new Map<string, Row[]>();
    billData.items.forEach((line, idx) => {
      const mid = lineMat(line);
      if (!mid) return;                       // blank draft rows are legal
      const row: Row = {
        idx, line,
        key: lineMergeKey(line, billRate),
        bookable: (parseFloat(line.quantity) || 0) > 0 && (parseFloat(line.unit_price) || 0) > 0,
      };
      const arr = byMat.get(mid);
      if (arr) arr.push(row); else byMat.set(mid, [row]);
    });

    const groups: Array<{
      materialId: string; name: string; unit: string; sig: string;
      lineNos: number[];
      mergeable: Array<{ key: string; lineNos: number[]; parts: number[]; total: number; rate: number; bookable: number }>;
      differs: string[]; conflictBookable: boolean;
    }> = [];
    const flagged = new Set<number>();

    for (const [mid, rows] of byMat) {
      if (rows.length < 2) continue;
      rows.forEach((r) => flagged.add(r.idx));
      const mat = materials.find((m) => String(m.id) === mid) as any;
      const unit = matUnits(mid).pu || String(mat?.unit || '') || 'unit';
      const bySub = new Map<string, Row[]>();
      for (const r of rows) {
        const a = bySub.get(r.key);
        if (a) a.push(r); else bySub.set(r.key, [r]);
      }
      const mergeable = [...bySub.entries()]
        .filter(([, rs]) => rs.length > 1)
        .map(([key, rs]) => ({
          key,
          lineNos: rs.map((r) => r.idx + 1),
          parts: rs.map((r) => parseFloat(r.line.quantity) || 0),
          // 4 dp so 600 + 400 reads 1,000 and not 999.9999999999999.
          total: Math.round(rs.reduce((s, r) => s + (parseFloat(r.line.quantity) || 0), 0) * 10000) / 10000,
          rate: r2(parseFloat(rs[0].line.unit_price) || 0),
          bookable: rs.filter((r) => r.bookable).length,
        }));
      const keys = [...bySub.keys()];
      const differs = keys.length > 1 ? keyDiffLabels(keys) : [];
      // A split-rate warning only has to be answered when both sides would
      // actually be written.
      const conflictBookable = new Set(rows.filter((r) => r.bookable).map((r) => r.key)).size > 1;
      groups.push({
        materialId: mid,
        name: mat?.name || mid,
        unit,
        // The acknowledgement is keyed to the EXACT shape of the conflict, so
        // editing a rate afterwards invalidates a stale "keep both".
        sig: `${mid}::${[...keys].sort().join('~')}`,
        lineNos: rows.map((r) => r.idx + 1),
        mergeable, differs, conflictBookable,
      });
    }

    return {
      groups,
      flagged,
      /** Same-everything repeats that would really be booked twice. */
      blockingMerges: groups.flatMap((g) => g.mergeable.filter((m) => m.bookable > 1).map((m) => ({ g, m }))),
      conflicts: groups.filter((g) => g.differs.length > 0 && g.conflictBookable),
    };
    // storeCats/materials feed lineMergeKey + the labels; billData.gst_rate is
    // the inherited GST every un-overridden line resolves to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billData.items, billData.gst_rate, materials, storeCats]);

  /** Split-rate conflicts the user has explicitly said are real ("keep both"),
   *  by conflict signature. Cleared with the modal. */
  const [dupAck, setDupAck] = useState<string[]>([]);
  const toggleDupAck = (sig: string) =>
    setDupAck((prev) => (prev.includes(sig) ? prev.filter((s) => s !== sig) : [...prev, sig]));

  /**
   * Fold one exact-match group into a single line: quantity SUMMED onto the
   * FIRST occurrence, which keeps its own rate / brand / GST / basis — the same
   * semantics as po-helpers' mergeDuplicateLines. Nothing is averaged, and the
   * taxable base is not carried over: billCalc re-derives goods, discount share,
   * taxable, CGST and SGST from the merged quantity × the unchanged rate, so
   * tax can never leak into unit_price.
   * Re-derives the group from CURRENT state (never from the memo's snapshot) so
   * a keystroke between render and click cannot merge the wrong pair.
   */
  const mergeBillLines = (materialId: string, key: string) => {
    setBillData((prev) => {
      const billRate = parseFloat(prev.gst_rate) || 0;
      const idxs = prev.items
        .map((it, i) => ({ it, i }))
        .filter(({ it }) => lineMat(it) === materialId && lineMergeKey(it, billRate) === key)
        .map(({ i }) => i);
      if (idxs.length < 2) return prev;              // state moved on — do nothing
      const keepAt = idxs[0];
      const total = Math.round(
        idxs.reduce((s, i) => s + (parseFloat(prev.items[i].quantity) || 0), 0) * 10000,
      ) / 10000;
      const drop = new Set(idxs.slice(1));
      return {
        ...prev,
        items: prev.items
          .map((l, i) => (i === keepAt ? { ...l, quantity: String(total) } : l))
          .filter((_, i) => !drop.has(i)),
      };
    });
    setBillError(null);
  };

  /* ==============================================================
   * B. VENDOR ↔ ITEM MAPPING — CONSULTED, NEVER BLOCKING
   *
   * A PURCHASE ORDER is a document we author, so /purchase-orders refuses an
   * unmapped vendor↔item pair outright. A BILL IS A FACT: it already happened,
   * the goods are in the store, and refusing it here would only leave the
   * storekeeper holding an invoice with nowhere to enter it. So this screen
   * WARNS and still saves. That divergence from the strict PO rule is
   * deliberate — do not "align" the two.
   *
   * AUTO-LEARN — IT EXISTS, AND IT LEARNS ONCE. Saving a bill DOES write
   * vendor_materials, server-side (learnVendorMaterialPair in
   * src/app/api/purchases/route.ts). A bill is the strongest evidence there is
   * that a vendor supplies an item, so a pair that has NEVER existed is
   * recorded on first sight. What it must never do is resurrect a mapping an
   * admin deliberately deleted (the boot-backfill bug shape this codebase
   * already had), so the server stamps a one-time
   * `vm_learned:<vendor>:<material>` marker in `settings`:
   * marker present + row absent == a human removed it, and the learner
   * stays out. Do not "simplify" that marker away — it is the only thing
   * separating learn-once from re-add-forever.
   *
   * The "Add to this vendor's items" button below is therefore NOT the only
   * path; it is for the pairs the learner will not touch — a removed pair the
   * admin now wants back, or a vendor typed as free text (no master row, so
   * nothing to map against). The server WARNS in its response rather than
   * blocking; handleBillSubmit surfaces those warnings after the save.
   * ============================================================== */

  /** The bill's vendor as a MASTER ROW, or '' when the typed name is new/custom.
   *  The Vendor field is free text by design (allowCustom), and a mapping can
   *  only be read or written against a real vendor id. */
  const billVendorId = useMemo(() => {
    const typed = billData.vendor.trim().toLowerCase();
    if (!typed) return '';
    return vendors.find((v) => v.name.trim().toLowerCase() === typed)?.id || '';
  }, [billData.vendor, vendors]);

  /** { vendorId, ids } once loaded. null = unknown (never fetched, or the fetch
   *  failed) — in which case every mapping hint stays hidden and the form
   *  behaves exactly as it did before. A hint is not worth blocking bill entry. */
  const [vendorMap, setVendorMap] = useState<{ vendorId: string; ids: Set<string> } | null>(null);
  const [vendorMapBusy, setVendorMapBusy] = useState(false);
  const [vendorItemsOpen, setVendorItemsOpen] = useState(false);
  const [billMapNote, setBillMapNote] = useState<string | null>(null);

  useEffect(() => {
    if (!billModalOpen || !billVendorId) { setVendorMap(null); return; }
    let alive = true;
    // Same endpoint and same payload shape the ad-hoc GRN form reads.
    fetch(`/api/vendor-materials?vendor_id=${encodeURIComponent(billVendorId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!alive) return;
        setVendorMap({
          vendorId: billVendorId,
          ids: new Set<string>((d.mappings || []).map((m: any) => String(m.material_id))),
        });
      })
      .catch(() => { if (alive) setVendorMap(null); });   // degrade to today's behaviour
    return () => { alive = false; };
  }, [billModalOpen, billVendorId]);

  /** Only trust the map when it belongs to the vendor currently in the field —
   *  otherwise a mid-typing vendor change would annotate lines against the
   *  previous vendor's item list. */
  const vendorMapIds = vendorMap && vendorMap.vendorId === billVendorId && billVendorId
    ? vendorMap.ids : null;
  const vendorShort = billData.vendor.trim() || 'this vendor';

  /** The vendor's mapped items, alphabetical — the "show these first" list. */
  const vendorMappedMaterials = useMemo(() => {
    if (!vendorMapIds || vendorMapIds.size === 0) return [];
    return materials
      .filter((m) => vendorMapIds.has(String(m.id)))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, [vendorMapIds, materials]);

  /**
   * The picker's list, with this vendor's items MARKED. MaterialTypeahead is a
   * shared component (also mounted by /recipes) that re-sorts internally, so
   * array order cannot express priority and the mark has to travel on a field
   * it renders: the category line. Marking there — not in the name — keeps the
   * component's name-prefix relevance scoring intact, and as a bonus the mark
   * joins its search haystack, so typing the vendor's name lists their items.
   * EVERY material stays in the list; nothing is filtered out.
   */
  const billPickerMaterials = useMemo(() => {
    if (!vendorMapIds || vendorMapIds.size === 0) return materials;
    return materials.map((m: any) =>
      vendorMapIds.has(String(m.id))
        ? { ...m, category: `★ ${vendorShort}${m.category ? ` · ${m.category}` : ''}` }
        : m,
    );
  }, [materials, vendorMapIds, vendorShort]);

  /** Put a mapped item on the first empty line (else a new one). Refuses to add
   *  an item the bill already carries — this panel must not create the very
   *  duplicate the block above exists to catch. */
  const placeMaterialOnLine = (materialId: string, name: string) => {
    // Read the decision off current state and act OUTSIDE the updater — a
    // setState call inside another setState's updater is not safe (React may
    // re-run the updater).
    const at = billData.items.findIndex((l) => lineMat(l) === materialId);
    if (at >= 0) {
      setBillMapNote(`${name} is already on line ${at + 1} — add the quantity there.`);
      return;
    }
    setBillMapNote(null);
    // Seed the GST% here too — this panel is the second way a material lands on
    // a line, and a line seeded only on the dropdown path would tax differently
    // depending on which control the storekeeper happened to use. Unconditional
    // is safe on both branches: a fresh emptyBillLine() and an empty slot both
    // carry gst_rate '' (no human edit to clobber).
    const line = {
      ...emptyBillLine(),
      material_id: materialId,
      gst_rate: seedGstForMaterial(materialId),
      cess_rate: seedCessForMaterial(materialId),
    };
    setBillData((prev) => {
      const empty = prev.items.findIndex((l) => !lineMat(l));
      if (empty >= 0) {
        return {
          ...prev,
          items: prev.items.map((l, i) => (i === empty
            ? {
                ...l,
                material_id: materialId,
                gst_rate: seedGstForMaterial(materialId),
                cess_rate: seedCessForMaterial(materialId),
              }
            : l)),
        };
      }
      return { ...prev, items: [...prev.items, line] };
    });
  };

  /** The one action that actually keeps the map current, offered where the gap
   *  is noticed. Additive only (the route's INSERT OR IGNORE), one pair, on
   *  purpose. */
  const addToVendorItems = async (materialId: string, name: string) => {
    if (!billVendorId || !materialId) return;
    setVendorMapBusy(true);
    setBillMapNote(null);
    try {
      const res = await api('/api/vendor-materials', {
        method: 'POST',
        body: { vendor_id: billVendorId, material_id: materialId },
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setBillMapNote(j?.error || `Could not add ${name} to ${vendorShort}'s items.`);
        return;
      }
      setVendorMap((prev) =>
        prev && prev.vendorId === billVendorId
          ? { vendorId: prev.vendorId, ids: new Set(prev.ids).add(materialId) }
          : prev);
      setBillMapNote(`${name} added to ${vendorShort}'s items.`);
    } catch (err: any) {
      setBillMapNote(err?.message || `Could not add ${name} to ${vendorShort}'s items.`);
    } finally {
      setVendorMapBusy(false);
    }
  };

  // Calculate bill totals, split the two bill-level charges across the lines, and
  // derive each line's GST.
  //
  // GST is computed and carried ALONGSIDE the goods rate — it is NEVER folded into
  // unit_price / line_total / final_unit_price. Input GST is reclaimable credit,
  // not part of what the food costs: fold it in and average_price, and every
  // recipe cost derived from it, inflates by the GST rate silently and forever.
  // (That is exactly the bug the old bill-level GST control caused.)
  //
  // Order of operations, per line, in this order:
  //   goods   = qty × rate
  //   taxable = goods − its share of the bill discount   (a discount really does
  //                                                       lower the cost)
  //   tax     = taxable × gst%                           (tax is charged on the
  //                                                       post-discount value)
  //   cgst + sgst = tax
  const billCalc = (() => {
    const items = billData.items.map((item) => {
      const qty = parseFloat(item.quantity) || 0;
      const price = parseFloat(item.unit_price) || 0;
      return { ...item, line_total: Math.round(qty * price * 100) / 100 };
    });

    const subtotal = items.reduce((s, i) => s + i.line_total, 0);

    const pctOrFlat = (mode: 'percent' | 'amount', raw: string) => {
      const v = parseFloat(raw) || 0;
      if (v <= 0) return 0;
      return mode === 'percent' ? Math.round(subtotal * v / 100 * 100) / 100 : v;
    };

    // A discount can never exceed the goods value — that would produce a negative
    // unit cost and poison average_price. Clamp and flag it instead.
    const rawDiscount = pctOrFlat(billData.discount_mode, billData.discount_value);
    const discountAmount = Math.min(rawDiscount, subtotal);
    const discountClamped = rawDiscount > subtotal;
    const deliveryAmount = pctOrFlat(billData.delivery_mode, billData.delivery_value);

    // The bill-level rate is a DEFAULT that lines inherit. Parsed here, once —
    // the selects keep raw strings so nothing round-trips through Number() while
    // the storekeeper is still typing.
    const billRate = parseFloat(billData.gst_rate) || 0;

    const pricedItems = items.map((item) => {
      const proportion = subtotal > 0 ? item.line_total / subtotal : 0;
      const discountShare = Math.round(discountAmount * proportion * 100) / 100;
      const deliveryShare = Math.round(deliveryAmount * proportion * 100) / 100;
      // DISCOUNT lowers the cost basis; DELIVERY does not touch it. Delivery is
      // carried per line for vendor/spend reporting only — the same rule the GRN
      // and bulk-upload charge columns follow, so a bill costs the same whichever
      // screen books it. (The old GST control folded tax INTO this number, which
      // inflated average_price and every recipe cost built on it.)
      const netTotal = item.line_total - discountShare;
      const qty = parseFloat(item.quantity) || 0;
      // STILL the post-discount GOODS rate. Tax is derived below and shipped in
      // its own fields — adding it here is the one change that would break every
      // recipe cost in the app.
      const finalUnitPrice = qty > 0 ? Math.round(netTotal / qty * 100) / 100 : 0;

      // TGBCL liquor carries excise / cess / TCS on the store's own bill, not GST.
      // Force 0% rather than trusting whatever the select happens to hold — the
      // material can be swapped on a line that was already set to 18%.
      const zeroRated = storeMappedLine(item.material_id);
      const rate = zeroRated
        ? 0
        : (item.gst_rate === '' ? billRate : (parseFloat(item.gst_rate) || 0));

      const taxable = r2(netTotal);
      const taxValue = r2(taxable * rate / 100);
      // House invariant: tax_value = cgst + sgst. Rounding BOTH halves up
      // overshoots by a paisa on odd amounts (₹1.01 → 0.51 + 0.51 = 1.02), so
      // sgst takes the rounded half and cgst absorbs the remainder.
      // INTEGER PAISE, and the odd paisa lands in CGST — byte-identical to the
      // server (api/purchases/route.ts: sgstPaise = floor(taxPaise/2), cgst =
      // remainder). r2(taxValue/2) rounds the half UP, which put the spare paisa
      // in SGST instead: on a Rs 1.01 tax the screen said CGST 0.50 / SGST 0.51
      // while the row stored CGST 0.51 / SGST 0.50. The totals matched, so
      // nothing looked wrong — until someone reconciled a GST return line by line.
      const taxPaise = Math.round(taxValue * 100);
      const sgst = Math.floor(taxPaise / 2) / 100;
      const cgst = r2(taxValue - sgst);

      // GST COMPENSATION CESS — a SEPARATE levy on the same post-discount base.
      // Deliberately absent from taxValue/cgst/sgst: it is not GST, it is not
      // halved into CGST/SGST, and adding it to that sum would misstate the very
      // figure a GST return is filed on. It is also NOT input credit against GST
      // (only against cess output liability), so no label here may call it one.
      // Whole paise, byte-identical to the server's expression — the ÷100 for
      // percent and the ×100 for paise cancel, which is why there is no /100 in
      // sight. Same zero-rate lock: TGBCL duty rides on the store's own bill.
      const cessRate = zeroRated ? 0 : (parseFloat(item.cess_rate) || 0);
      const cessPaise = cessRate > 0 ? Math.max(0, Math.round(taxable * cessRate)) : 0;
      const compensationCess = cessPaise / 100;

      return {
        ...item,
        discount_share: discountShare,
        delivery_share: deliveryShare,
        final_unit_price: finalUnitPrice,
        gst_rate_effective: rate,
        cess_rate_effective: cessRate,
        compensation_cess: compensationCess,
        zero_rated: zeroRated,
        taxable,
        tax_value: taxValue,
        cgst,
        sgst,
        line_incl_tax: r2(taxable + taxValue + compensationCess),
      };
    });

    const cgstTotal = r2(pricedItems.reduce((s, i) => s + i.cgst, 0));
    const sgstTotal = r2(pricedItems.reduce((s, i) => s + i.sgst, 0));
    const taxTotal = r2(cgstTotal + sgstTotal);
    // Kept OUT of taxTotal on purpose — see the per-line note above.
    const cessTotal = r2(pricedItems.reduce((s, i) => s + i.compensation_cess, 0));
    // Bill-level taxable is goods − discount computed once, not the sum of the
    // per-line shares (those can drift a paisa on rounding). This is the figure
    // printed on the paper bill.
    const taxableTotal = r2(subtotal - discountAmount);

    // What you actually pay the vendor: goods, less discount, plus the tax the
    // vendor charges, plus compensation cess, plus delivery. Cess belongs here
    // — the vendor really does charge it — even though it is kept out of
    // taxTotal so the GST figure stays exactly the GST figure.
    const grandTotal = r2(taxableTotal + taxTotal + cessTotal + deliveryAmount);

    return {
      items: pricedItems, subtotal, discountAmount, deliveryAmount, grandTotal, discountClamped,
      taxableTotal, cgstTotal, sgstTotal, taxTotal, cessTotal,
    };
  })();

  const handleBillSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBillError(null);
    // Clear notes from the PREVIOUS bill before this one starts, or a warning
    // about last night's vendor sits on screen looking like it belongs to this
    // save. Collected per-line below and published once, after the save lands.
    setBillNotices([]);
    const notices: string[] = [];
    let merged = 0;

    if (!billData.vendor.trim()) {
      setBillError('Vendor name is required.');
      return;
    }
    if (!billData.date) {
      setBillError('Date is required.');
      return;
    }

    // DUPLICATE LINES. Checked before any money check because it is the one
    // error that silently doubles STOCK as well as cost: every line below is
    // POSTed as its own purchases row.
    // Only lines that would really be written count (quantity AND rate present)
    // — a half-typed second row cannot double anything, so it warns on screen
    // without holding the bill up.
    if (dupInfo.blockingMerges.length > 0) {
      const { g, m } = dupInfo.blockingMerges[0];
      setBillError(
        `${g.name} is on line ${m.lineNos.join(' and line ')} twice at the same rate ` +
        `(₹${m.rate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}/${g.unit}). ` +
        `Each line books its own purchase row, so stock would be credited twice. ` +
        `Use "Merge into one line" above — ${m.parts.map((p) => fmtQtyNum(p)).join(' + ')} = ${fmtQtyNum(m.total)} ${g.unit}.`
      );
      return;
    }
    // Different rates are NOT the same line. Nothing is merged and nothing is
    // averaged; the user says which it is.
    const unackedDup = dupInfo.conflicts.filter((g) => !dupAck.includes(g.sig));
    if (unackedDup.length > 0) {
      const g = unackedDup[0];
      setBillError(
        `${g.name} is on lines ${g.lineNos.join(', ')} with ${g.differs.join(' and ')}. ` +
        `Those are not the same line, so nothing is merged automatically — averaging them would ` +
        `corrupt the item's rate and every recipe cost built on it. ` +
        `Fix the lines, or tick "Keep both" above to confirm the bill really is split that way.`
      );
      return;
    }

    // A discount that swallows the whole subtotal zeroes EVERY line rate, which the
    // filter below would then read as "no items entered" — the wrong field, named
    // wrongly. Say what actually blocked it.
    if (billCalc.subtotal > 0 && billCalc.discountAmount >= billCalc.subtotal) {
      setBillError(
        `Discount (${formatCurrency(billCalc.discountAmount)}) equals or exceeds the items subtotal ` +
        `(${formatCurrency(billCalc.subtotal)}), so every line would be booked at ₹0. ` +
        `Reduce the discount, or record a free-of-charge receipt separately.`
      );
      return;
    }

    // Same trap one line at a time: a line whose net rate rounds to ₹0 (rate below
    // ₹0.005, or its discount share eating the whole line) used to be dropped in
    // silence, and the success toast then reported fewer items than were typed.
    // Name the lines instead of swallowing them.
    const zeroCostLines = billCalc.items
      .map((i, idx) => ({ i, idx }))
      .filter(({ i }) => i.material_id && parseFloat(i.quantity) > 0 && i.final_unit_price <= 0);

    if (zeroCostLines.length > 0) {
      const names = zeroCostLines
        .map(({ i, idx }) => {
          const mat = materials.find((m) => String(m.id) === String(i.material_id));
          return mat ? `line ${idx + 1} (${mat.name})` : `line ${idx + 1}`;
        })
        .join(', ');
      const many = zeroCostLines.length > 1;
      setBillError(
        `Net rate is ₹0 on ${names} — ${many ? 'those lines' : 'that line'} would be stocked at no cost. ` +
        `Enter a unit price, lower the discount, or remove the line${many ? 's' : ''}.`
      );
      return;
    }

    const validItems = billCalc.items.filter(
      (i) => i.material_id && parseFloat(i.quantity) > 0 && i.final_unit_price > 0
    );

    if (validItems.length === 0) {
      setBillError('Add at least one item with material, quantity, and price.');
      return;
    }

    setBillSubmitting(true);
    try {
      // Submit each line item as a separate purchase. unit_price here is the
      // DISCOUNT-NET, GST-FREE goods rate (final_unit_price above) — nothing is
      // folded into it, so average_price stays a true cost basis.
      // When entry_mode='case', expand cases → bottles using the material's case_size
      // BEFORE submitting, so the API still sees a bottle-count quantity (its native unit).
      for (const item of validItems) {
        const rawQty = parseFloat(item.quantity);
        let qtyForApi = rawQty;
        let unitPriceForApi = item.final_unit_price;
        const noteExtras: string[] = [];
        if (item.entry_mode === 'case') {
          const mat = materials.find(m => m.id === item.material_id) as any;
          const caseSize = Number(mat?.case_size) || 1;
          if (caseSize <= 1) {
            // No case configured for this material — fall back to bottle behaviour.
            noteExtras.push('case_mode_requested_but_no_case_size_set');
          } else {
            qtyForApi      = rawQty * caseSize;             // cases → bottles
            unitPriceForApi = item.final_unit_price / caseSize; // per-case → per-bottle
            noteExtras.push(`Case entry: ${rawQty} × ${caseSize} = ${qtyForApi} btl`);
          }
        }
        const body = {
          material_id: item.material_id,
          vendor: billData.vendor,
          brand: item.brand,
          quantity: qtyForApi,
          unit_price: unitPriceForApi,
          date: billData.date,
          // The VENDOR's bill number as a real field (it also stays in notes for
          // back-compat). The server mints our Invoice ID from it.
          bill_no: billData.bill_number || '',
          // DELIVERY only. Do NOT send `discount` here: unit_price above is
          // already net of it, and purchases.discount is a RECORDED-ONLY column
          // that every reader subtracts a second time (db.ts's "Total Inward =
          // total_price − discount + cgst + …", this page's own Total Inward
          // column, the bulk preview, /api/grn). Writing both netted it twice —
          // a ₹1,000 discount on a ₹10,000 bill rendered ₹8,500 instead of
          // ₹9,500. The rupees stay visible in the note below.
          delivery_charges: item.delivery_share,
          // GST, per the wire contract. These travel BESIDE unit_price, never
          // inside it: unit_price above is the discount-net goods rate, and the
          // server re-derives tax from (line_total − discount_share) × gst_rate
          // rather than trusting these figures. Sent even when 0 so an exempt or
          // zero-rated (TGBCL) line is recorded as deliberately 0%, not missing.
          gst_rate: item.gst_rate_effective,
          cgst: item.cgst,
          sgst: item.sgst,
          // COMPENSATION CESS as a RATE only. Unlike cgst/sgst — which still
          // accept figures purely for back-compat with this modal's pre-existing
          // wire shape — the server derives the rupees itself and does not take
          // a client amount. There is no legacy caller to keep, so the narrower
          // contract is the better one.
          cess_rate: item.cess_rate_effective,
          notes: [`Bill #${billData.bill_number || 'N/A'}`,
                  item.discount_share > 0 ? `Discount ₹${item.discount_share} (netted off rate)` : '',
                  item.tax_value > 0
                    ? `GST ${item.gst_rate_effective}% ₹${item.tax_value} (CGST ₹${item.cgst} + SGST ₹${item.sgst}, not in rate)`
                    : (item.zero_rated ? 'GST 0% (store/TGBCL item — taxed on the store bill)' : ''),
                  item.compensation_cess > 0
                    ? `Compensation cess ${item.cess_rate_effective}% ₹${item.compensation_cess} (not in rate)`
                    : '',
                  item.delivery_share > 0 ? `Delivery ₹${item.delivery_share} (not in rate)` : '',
                  billData.notes, ...noteExtras].filter(Boolean).join(' | '),
        };

        const res = await api('/api/purchases', {
          method: 'POST',
          body: body,
        });

        const json = await res.json().catch(() => null);

        if (!res.ok) {
          throw new Error(json?.error || `Failed to add purchase for item`);
        }

        // The save SUCCEEDED. Anything below is the server telling us something
        // the storekeeper needs to know anyway — a pair it would not map, or a
        // line it folded into an existing one. Dropping the body (which this
        // loop used to do) made both invisible: "4 items added" then 3 rows,
        // with no explanation on screen.
        const warn = json?.vendor_mapping?.warning;
        if (warn) notices.push(warn);
        if (json?.merge_message) notices.push(json.merge_message);
        if (json?.merged) merged += 1;
      }

      setBillModalOpen(false);
      setBillData({ ...emptyBill });
      setBillNotices(notices);
      await fetchPurchases(appliedFilters);
      // Count what LANDED, not what was sent: merged lines fold into an existing
      // row, so promising 4 new rows when 3 appear is the same lie as before.
      const landed = validItems.length - merged;
      setToast(
        merged > 0
          ? `Bill entered: ${landed} item${landed === 1 ? '' : 's'} from ${billData.vendor} added, ${merged} combined with a line already on this bill.`
          : `Bill entered: ${validItems.length} items from ${billData.vendor} added!`
      );
      setTimeout(() => setToast(null), 4000);
    } catch (err: any) {
      setBillError(err.message);
    } finally {
      setBillSubmitting(false);
    }
  };

  // ---- Bulk Upload Handlers ----

  const openBulkModal = () => {
    setBulkParsedData([]);
    setBulkFileName(null);
    setBulkResult(null);
    setBulkModalOpen(true);
  };

  const handleBulkFile = async (file: File) => {
    setBulkResult(null);
    setBulkFileName(file.name);

    if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
      const XLSX = await import('xlsx');
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<any>(sheet);
      setBulkParsedData(mapBulkRows(rows));
    } else {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          setBulkParsedData(mapBulkRows(results.data as any[]));
        },
      });
    }
  };

  const mapBulkRows = (rows: any[]) => {
    return rows.map((r: any) => {
      // Flexible column name matching
      const itemName = r.item_name || r.ITEM_NAME || r['Item Name'] || r['ITEM NAME'] || r.material || r.Material || r.name || r.Name || '';
      // SKU is the PREFERRED match key — unique across grocery + liquor and
      // immune to renames/typos. The server tries sku first, then the name.
      const sku = r.sku || r.SKU || r.Sku || r['Item Code'] || r.item_code || r.ITEM_CODE || r.code || '';
      const quantity = Number(r.quantity || r.QUANTITY || r.Quantity || r.qty || r.QTY || r.Qty || r['INWARD QTY'] || r.inward_qty || 0);
      const unitPrice = Number(r.unit_price || r.UNIT_PRICE || r['Unit Price'] || r.RATE || r.Rate || r.rate || r.price || r.Price || 0);
      // CHARGE-FREE line amount (qty × rate). SUBTOTAL is the register's
      // charge-free column; TOTAL INWARD AMOUNT is deliberately NOT in this
      // chain — it is charge-INCLUSIVE and is handled separately below.
      const totalAmount = Number(r.total_amount || r.TOTAL_AMOUNT || r['Total Amount']
        || r.subtotal || r.SUBTOTAL || r['Sub Total'] || r.total || r.Total || 0);
      // CHARGE-INCLUSIVE register total (see api/grn: subtotal − discount + cgst
      // + sgst + cess + tcs + delivery + round-off).
      const totalInward = Number(r['TOTAL INWARD AMOUNT'] || r.total_inward_amount || r['Total Inward Amount'] || 0);
      const vendor = r.vendor || r.VENDOR || r.Vendor || r['SUPPLIER NAME'] || r.supplier || r.Supplier || '';
      const brand = r.brand || r.BRAND || r.Brand || '';
      const gstAmount = Number(r.gst_amount || r.GST || r.gst || r['GST Amount'] || 0);
      const notes = r.notes || r.NOTES || r.Notes || '';
      // The VENDOR's bill number (printed on the bill they give us). Our own
      // Invoice ID is generated server-side and is never read from the file.
      const billNo = r.bill_no || r.bill_number || r['Bill No'] || r['BILL NO'] || r['Bill Number']
        || r.invoice_no || r.invoice_number || r.invoice || r.Invoice || r['INVOICE ID'] || r['Invoice No'] || '';
      // GRN-Inward per-line charges (₹) — optional. Accept snake_case + the sheet's UPPER names.
      const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
      // Inward-sheet columns: purchase_unit is verified server-side against the
      // item's configured unit; category is informational; po_qty is recorded.
      const purchaseUnit = r.purchase_unit ?? r['PURCHASE UNIT'] ?? r['Purchase Unit'] ?? r.unit ?? r.UNIT ?? '';
      const categoryName = r.category_name ?? r['CATEGORY NAME'] ?? r.category ?? r.Category ?? r.CATEGORY ?? '';
      const poQty = num(r.po_qty ?? r['PO QTY'] ?? r['PO Qty'] ?? r.po_quantity);
      const discount = num(r.discount ?? r.DISCOUNT ?? r.Discount);
      const cgst = num(r.cgst ?? r.CGST);
      const sgst = num(r.sgst ?? r.SGST);
      const specialExciseCess = num(r.special_excise_cess ?? r['SPECIAL EXCISE CESS'] ?? r.cess ?? r.CESS);
      // The EIGHTH charge. Read it under its FULL name only: a bare `cess`
      // column belongs to special_excise_cess above (TGBCL sheets have used it
      // that way for as long as the liquor register has existed), and quietly
      // re-pointing it here would move excise money into a GST levy.
      const compensationCess = num(r.compensation_cess ?? r['COMPENSATION CESS'] ?? r['Compensation Cess']);
      const tcs = num(r.tcs ?? r.TCS);
      const deliveryCharges = num(r.delivery_charges ?? r['DELIVERY CHARGES'] ?? r.delivery ?? r.Delivery);
      const mrpRoundOff = num(r.mrp_round_off ?? r['MRP ROUND OFF'] ?? r.mrp_rounding ?? r['MRP Round Off']);
      // A lump `gst_amount` column becomes CGST + SGST BESIDE the goods rate —
      // it is a reclaimable input credit and must never touch unit_price (that
      // feeds updateMaterialPrice → average_price → every recipe cost; a
      // bill-level GST control was deleted from this codebase for doing exactly
      // that). Same integer-paise split the bill form and the server use, odd
      // paisa to CGST, so tax_value === cgst + sgst exactly.
      // If the sheet already itemised cgst/sgst, those win and gst_amount is
      // ignored — otherwise the same rupee would be recorded twice.
      let cgstOut = cgst;
      let sgstOut = sgst;
      if (gstAmount > 0 && cgst === 0 && sgst === 0) {
        const taxPaise = Math.round(gstAmount * 100);
        sgstOut = Math.floor(taxPaise / 2) / 100;
        cgstOut = Math.round((gstAmount - sgstOut) * 100) / 100;
      }

      // Parse date - handle various formats
      let date = r.date || r.DATE || r.Date || r['INWARD DATE'] || r.inward_date || '';
      if (date) {
        // Handle DD-MM-YYYY or DD/MM/YYYY formats
        const dmy = String(date).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (dmy) {
          date = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
        }
        // Handle Excel serial date numbers
        if (typeof date === 'number') {
          const excelDate = new Date((date - 25569) * 86400 * 1000);
          date = excelDate.toISOString().split('T')[0];
        }
      }
      if (!date) date = todayString();

      // Calculate unit price from the line amount when no rate was given.
      // MUST use a CHARGE-FREE base: the 7 charges are stored separately, so
      // folding them into unit_price would bake them into the weighted-average
      // cost AND count them a second time in Total Inward. When only the
      // charge-inclusive TOTAL INWARD AMOUNT is available, back the charges out.
      // GST rides in the charge block (cgstOut/sgstOut), never in the rate —
      // so it is backed out of a charge-INCLUSIVE total exactly like every
      // other charge, and the derived rate stays charge-free.
      // compensationCess is in here for the same reason as every other charge:
      // when only the charge-INCLUSIVE total is given, anything left out of this
      // sum stays baked into the derived rate — and unit_price feeds
      // updateMaterialPrice → average_price → every recipe cost. Omitting the
      // 8th charge quietly folded GST compensation cess into the cost basis on
      // exactly the sheets that carry it (aerated drinks, tobacco).
      const chargeBlock = -discount + cgstOut + sgstOut + compensationCess + specialExciseCess + tcs + deliveryCharges + mrpRoundOff;
      let finalUnitPrice = unitPrice;
      if (finalUnitPrice === 0 && quantity > 0) {
        const base = totalAmount > 0 ? totalAmount
          : (totalInward !== 0 ? totalInward - chargeBlock : 0);
        if (base > 0) finalUnitPrice = Math.round((base / quantity) * 100) / 100;
      }
      // Report the charge-free base so the preview total and the list's
      // Total Inward reconcile back to the source sheet.
      const baseAmount = totalAmount > 0 ? totalAmount
        : (totalInward !== 0 ? Math.round((totalInward - chargeBlock) * 100) / 100 : 0);

      return {
        item_name: String(itemName).trim(),
        sku: String(sku).trim(),
        quantity,
        unit_price: finalUnitPrice,
        total_amount: baseAmount,
        vendor: String(vendor).trim(),
        brand: String(brand).trim(),
        date,
        gst_amount: gstAmount,
        notes: String(notes).trim(),
        bill_no: String(billNo).trim(),
        purchase_unit: String(purchaseUnit).trim(),
        category_name: String(categoryName).trim(),
        po_qty: poQty,
        discount, cgst: cgstOut, sgst: sgstOut,
        compensation_cess: compensationCess, special_excise_cess: specialExciseCess,
        tcs, delivery_charges: deliveryCharges, mrp_round_off: mrpRoundOff,
      };
    }).filter((r: any) => r.item_name || r.sku); // keep rows identified by name OR sku
  };

  const handleBulkDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setBulkDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleBulkFile(file);
  };

  const handleBulkFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleBulkFile(file);
  };

  const submitBulkUpload = async () => {
    try {
      setBulkUploading(true);
      setBulkResult(null);
      const res = await api('/api/purchases/bulk', {
        method: 'POST',
        body: { purchases: bulkParsedData },
      });
      const json = await res.json();
      if (!res.ok) {
        setBulkResult({ success: 0, skipped: 0, errors: [json.error || 'Upload failed'] });
      } else {
        setBulkResult(json);
        if (json.success > 0) {
          await fetchPurchases(appliedFilters);
        }
      }
    } catch (err: any) {
      setBulkResult({ success: 0, skipped: 0, errors: [err.message] });
    } finally {
      setBulkUploading(false);
    }
  };

  // ---- Opening Stock: template download + pack-aware upload ----
  const downloadOpeningTemplate = async () => {
    const XLSX = await import('xlsx');
    const rows = [...materials]
      .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))
      .map((m: any) => ({
        sku: m.sku || '',
        name: m.name || '',
        category: m.category || '',     // prefilled so the store manager can scan/sort by section
        purchase_unit: m.purchase_unit || m.unit || '',
        pack_size: m.pack_size || 1,
        qty: '',
        rate: '',
        date: '',
      }));
    const ws = XLSX.utils.json_to_sheet(rows, { header: ['sku', 'name', 'category', 'purchase_unit', 'pack_size', 'qty', 'rate', 'date'] });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Opening Stock');
    XLSX.writeFile(wb, `opening-stock-template-${todayString()}.xlsx`);
  };

  // ---- Bulk Purchases: ready-to-fill template (matches the Generic CSV upload
  // parser). Sheet 1 "Purchases" is what the upload reads (first sheet); sheet 2
  // "How to fill" explains every column. Two sample rows use real material names
  // so users learn the name must match an existing Raw Material exactly. ----
  const downloadBulkPurchaseTemplate = async () => {
    const XLSX = await import('xlsx');
    const sample = [...materials].sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
    const ex1: any = sample[0];
    // pack-rule-lock: picks a packed material to make the spreadsheet EXAMPLE row
    // illustrative. No quantity is converted here, so the both-halves guard has
    // nothing to protect — a kg/kg material chosen as the sample is still a valid sample.
    const ex2: any = sample.find((m: any) => (Number(m.pack_size) || 1) > 1) || sample[1];
    // Full GRN-Inward column set, in the inward sheet's order, + our extras
    // (bill_no, brand, gst_amount, notes). Invoice ID is NOT a column — it is
    // generated by the system.
    const header = ['date', 'vendor', 'bill_no', 'category_name', 'sku', 'item_name',
      'po_qty', 'quantity', 'purchase_unit', 'unit_price', 'total_amount',
      'discount', 'cgst', 'sgst', 'compensation_cess', 'special_excise_cess', 'tcs', 'delivery_charges', 'mrp_round_off',
      'total_inward_amount', 'brand', 'gst_amount', 'notes'];
    const unitOf = (m: any) => String(m?.purchase_unit || m?.unit || '').trim();
    const rows = [
      {
        date: todayString(), vendor: 'ABC Traders', bill_no: 'ABC/2026/117',
        category_name: ex1?.category || '', sku: ex1?.sku || '', item_name: ex1?.name || 'Tomato',
        po_qty: 10, quantity: 10, purchase_unit: unitOf(ex1) || 'kg', unit_price: 25, total_amount: 250,
        discount: '', cgst: '', sgst: '', compensation_cess: '', special_excise_cess: '', tcs: '', delivery_charges: '', mrp_round_off: '',
        total_inward_amount: '', brand: '', gst_amount: '',
        notes: 'SAMPLE — delete before uploading',
      },
      {
        date: todayString(), vendor: 'XYZ Supplies', bill_no: 'XYZ-8842',
        category_name: ex2?.category || '', sku: ex2?.sku || '', item_name: ex2?.name || 'Refined Oil',
        po_qty: 5, quantity: 5, purchase_unit: unitOf(ex2) || 'L', unit_price: 180, total_amount: 900,
        discount: 50, cgst: 45, sgst: 45, compensation_cess: 102, special_excise_cess: '', tcs: '', delivery_charges: 30, mrp_round_off: '',
        total_inward_amount: 1072, brand: '', gst_amount: '',
        notes: 'SAMPLE — 900 − 50 + 45 + 45 + 102 + 30 = 1072 total inward; rate stays 180',
      },
    ];
    const ws = XLSX.utils.json_to_sheet(rows, { header });
    ws['!cols'] = header.map((h) => ({ wch: h === 'item_name' ? 28 : h === 'notes' ? 40 : 14 }));

    const help = [
      ['Column', 'Required?', 'What to put'],
      ['sku', 'PREFERRED', 'The item\u2019s SKU (MAT-00123). Unique across grocery + liquor, so it is matched FIRST and is immune to renames/typos. Fill this and item_name becomes just a label.'],
      ['item_name', 'YES*', '*Only needed when sku is blank. Must EXACTLY match a Raw Material (case-insensitive). Unknown sku/name is skipped and reported.'],
      ['quantity', 'YES', "INWARD QTY — what actually came in, in the material's PURCHASE unit (kg, L, BTL, PKT…). Stock is converted to recipe units by pack size automatically."],
      ['purchase_unit', 'optional', "SAFETY CHECK. If filled, it must MATCH the item's configured purchase unit — otherwise the row is SKIPPED and reported (booking 5 CASE as 5 BTL would silently mis-state stock). Leave blank to trust the item's setup."],
      ['po_qty', 'optional', 'PO QTY — what the PO asked for. Recorded for the register only; never affects stock or cost.'],
      ['category_name', 'optional', "Informational only — the item's real category comes from the Raw Material master."],
      ['total_inward_amount', 'optional', 'Charge-INCLUSIVE bill total for the line. Only used to derive the rate when unit_price AND total_amount are both blank (the charges are backed out first). Never let it fill total_amount — that must be charge-free.'],
      ['unit_price', 'YES*', '₹ per PURCHASE unit. *Optional if you fill total_amount instead — the unit price is then derived.'],
      ['total_amount', 'optional', 'SUBTOTAL — the CHARGE-FREE line amount (qty × rate). If given without unit_price: unit_price = total_amount ÷ quantity. Do NOT put the charge-inclusive Total Inward here.'],
      ['gst_amount', 'optional', '₹ GST for the line. Recorded as CGST + SGST beside the rate — never added into the item price. Leave blank if you filled cgst/sgst yourself (those win).'],
      ['vendor', 'optional', 'Supplier name.'],
      ['bill_no', 'optional', "The VENDOR's own bill number, as printed on the bill they give you (aliases: bill_number, invoice_no, INVOICE ID). Part of the duplicate check — the same bill re-uploaded is skipped, but two different bills are both kept. Do NOT put our Invoice ID here."],
      ['(Invoice ID)', 'AUTO', 'NOT a column — our own system number (PINV-2026-0001) is generated automatically on upload. Lines sharing the same vendor + bill_no + date get ONE Invoice ID.'],
      ['discount / cgst / sgst / compensation_cess / special_excise_cess / tcs / delivery_charges / mrp_round_off', 'optional', '₹ per-line charges (GRN-Inward format). RECORDED ONLY — they do NOT change the unit cost/weighted-average. Total Inward = (qty × rate) − discount + cgst + sgst + compensation_cess + special_excise_cess + tcs + delivery + mrp_round_off. Leave blank/0 if not applicable. mrp_round_off may be negative.'],
      ['compensation_cess', 'optional', '₹ GST COMPENSATION CESS for the line (e.g. 12% on aerated/carbonated drinks, and tobacco). A SEPARATE levy from GST — do not add it into cgst/sgst. DISTINCT from special_excise_cess, which means TGBCL Special Excise Cess on the liquor inward register. Write the header out in full: a bare "cess" column is still read as special_excise_cess for back-compat with those TGBCL sheets.'],
      ['brand', 'optional', 'Brand, if you track it.'],
      ['date', 'optional', 'DD-MM-YYYY, DD/MM/YYYY or YYYY-MM-DD. Defaults to today. Non-admins cannot backdate beyond the allowed window or use future dates.'],
      ['notes', 'optional', 'Any remark.'],
      ['', '', ''],
      ['NOTE', '', 'Liquor / store-mapped items are NOT imported here — use the Liquor Store flow. They are reported as skipped, the batch still succeeds.'],
      ['NOTE', '', 'Accepts .xlsx, .xls or .csv. Delete the two sample rows before uploading.'],
    ];
    const wsHelp = XLSX.utils.aoa_to_sheet(help);
    wsHelp['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 95 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Purchases');
    XLSX.utils.book_append_sheet(wb, wsHelp, 'How to fill');
    XLSX.writeFile(wb, `bulk-purchases-template-${todayString()}.xlsx`);
  };

  // ---- Export the purchase list currently in view (honours the applied
  // search + date filters; with no filters that is every purchase). ----
  const exportPurchases = async () => {
    const XLSX = await import('xlsx');
    const rows = sortedPurchases.map((p: any) => ({
      date: p.date || '',
      item_name: p.material_name || p.material_id || '',
      vendor: p.vendor || '',
      invoice_id: p.invoice_id || '',
      bill_no: p.bill_no || '',
      brand: p.brand || '',
      quantity: Number(p.purchase_qty ?? p.quantity ?? 0),
      purchase_unit: p.material_purchase_unit || p.material_unit || '',
      unit_price: Number(p.purchase_unit_price ?? p.unit_price ?? 0),
      total_amount: Number(p.total_price ?? 0),
      notes: p.notes || '',
    }));
    const header = ['date', 'item_name', 'vendor', 'invoice_id', 'bill_no', 'brand', 'quantity', 'purchase_unit', 'unit_price', 'total_amount', 'notes'];
    const ws = XLSX.utils.json_to_sheet(rows, { header });
    ws['!cols'] = header.map((h) => ({ wch: h === 'item_name' ? 28 : h === 'notes' ? 30 : 14 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Purchases');
    const tag = (appliedFilters.from || appliedFilters.to)
      ? `${appliedFilters.from || 'start'}_to_${appliedFilters.to || 'end'}`
      : 'all';
    XLSX.writeFile(wb, `purchases-${tag}-${todayString()}.xlsx`);
  };

  const handleOpeningFile = async (file: File) => {
    setOpeningBusy(true);
    try {
      let rows: any[] = [];
      if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        rows = XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]]);
      } else {
        rows = await new Promise<any[]>((resolve) => {
          Papa.parse(file, { header: true, skipEmptyLines: true, complete: (r) => resolve(r.data as any[]) });
        });
      }
      // Read every column CASE-INSENSITIVELY. Operators fill the template with
      // varying header case (SKU/NAME/QTY/RATE vs sku/name/qty/rate); a mismatch
      // used to leave name/qty/rate blank so EVERY row was skipped ("0 created").
      const toIso = (v: any): string => {
        if (v == null || v === '') return '';
        if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
        // Excel serial date (e.g. 46204) → ISO. Guard tiny numbers.
        if (typeof v === 'number' && v > 59) { const d = new Date(Math.round((v - 25569) * 86400000)); return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); }
        const s = String(v).trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
      };
      const mapped = rows.map((r: any) => {
        const lc: Record<string, any> = {};
        for (const k in r) lc[String(k).toLowerCase().trim()] = r[k];
        const pick = (...keys: string[]) => { for (const k of keys) { const v = lc[k]; if (v !== undefined && v !== null && v !== '') return v; } return ''; };
        return {
          sku:  pick('sku'),
          name: pick('name', 'item_name', 'item name', 'material', 'material name'),
          qty:  pick('qty', 'quantity', 'opening_qty', 'opening qty', 'inward qty'),
          rate: pick('rate', 'unit_price', 'price', 'unit price'),
          date: toIso(pick('date')),
        };
      });
      const res = await api('/api/purchases/opening-stock', { method: 'POST', body: { rows: mapped } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { alert(j.error || 'Upload failed'); return; }
      if (j.skipped_rows?.length) console.warn('[opening-stock] skipped rows:', j.skipped_rows);
      alert(`${j.message}${j.skipped ? '\n\nSkipped rows are logged in the browser console (F12).' : ''}`);
      await Promise.all([fetchPurchases(appliedFilters), fetchMaterials()]);
    } catch (e: any) {
      alert('Failed: ' + e.message);
    } finally {
      setOpeningBusy(false);
      if (openingFileRef.current) openingFileRef.current.value = '';
    }
  };

  const toggleSort = () => {
    setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="flex justify-between items-center">
            <div className="h-9 w-48 bg-[#FFF1E3] rounded-lg" />
            <div className="h-10 w-40 bg-[#FFF1E3] rounded-lg" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-6 h-28" />
            ))}
          </div>
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 h-16" />
          <div className="bg-white border border-[#E8D5C4] rounded-xl h-96" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center">
        <div className="text-center space-y-4">
          <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto" />
          <p className="text-[#6B5744] text-lg">Error: {error}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-[#FFF1E3] text-[#2D1B0E] rounded-lg hover:bg-[#FFF1E3] transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-3">
              <ShoppingCart className="w-8 h-8 text-[#af4408]" />
              Purchases
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">Track and manage all raw material purchases</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setRecahoOpen(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-medium transition-colors"
              title="Upload Recaho Advanced Inward Report (Item Wise / Supplier Wise / Category Wise)"
            >
              <Upload className="w-4 h-4" />
              Recaho Inward Upload
            </button>
            <button
              onClick={downloadBulkPurchaseTemplate}
              className="flex items-center gap-2 px-4 py-2.5 border border-green-600 text-green-700 hover:bg-green-50 rounded-lg text-sm font-medium transition-colors"
              title="Download a ready-to-fill Excel template (with a 'How to fill' guide) for bulk-uploading purchases"
            >
              <FileSpreadsheet className="w-4 h-4" />
              Bulk Template
            </button>
            <button
              onClick={openBulkModal}
              className="flex items-center gap-2 px-4 py-2.5 border border-green-600 text-green-700 hover:bg-green-50 rounded-lg text-sm font-medium transition-colors"
            >
              <Upload className="w-4 h-4" />
              Generic CSV Upload
            </button>
            <button
              onClick={downloadOpeningTemplate}
              className="flex items-center gap-2 px-4 py-2.5 border border-blue-600 text-blue-700 hover:bg-blue-50 rounded-lg text-sm font-medium transition-colors"
              title="Download an Excel of every material to fill opening qty + rate (in purchase units like kg / BTL), then upload as opening stock"
            >
              <FileSpreadsheet className="w-4 h-4" />
              Opening Stock Template
            </button>
            <button
              onClick={() => openingFileRef.current?.click()}
              disabled={openingBusy}
              className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
              title="Upload the filled Opening Stock template — converts qty/rate by pack size and seeds stock + average cost"
            >
              <Upload className="w-4 h-4" />
              {openingBusy ? 'Uploading…' : 'Upload Opening Stock'}
            </button>
            <input ref={openingFileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) handleOpeningFile(f); }} />
            {/* "Enter Full Bill" is now the ONLY way to record a purchase here.
                The old single-line "Add Purchase" button was removed on the
                owner's call: it wrote the same purchases row by a second route,
                so the two drifted (the CASE/BTL entry-mode bug was fixed twice,
                once per form). A one-item purchase is simply a bill with one
                line, and this way the invoice number, vendor and bill charges
                are never optional. */}
            <button
              onClick={openBillModal}
              className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Receipt className="w-4 h-4" />
              Enter Full Bill
            </button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-green-500/10">
                <IndianRupee className="w-4 h-4 text-green-400" />
              </div>
              <span className="text-sm text-[#8B7355]">Total Purchases Today</span>
            </div>
            <p className="text-2xl font-bold text-green-400">{formatCurrency(todayTotal)}</p>
          </div>
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-[#af4408]/10">
                <Calendar className="w-4 h-4 text-[#af4408]" />
              </div>
              <span className="text-sm text-[#8B7355]">Total Spend This Month</span>
            </div>
            <p className="text-2xl font-bold text-[#af4408]">{formatCurrency(monthTotal)}</p>
          </div>
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <Users className="w-4 h-4 text-purple-400" />
              </div>
              <span className="text-sm text-[#8B7355]">Number of Vendors</span>
            </div>
            <p className="text-2xl font-bold text-purple-400">{vendorCount}</p>
          </div>
        </div>

        {/* Admin-only: configurable bill backdate limit */}
        {isAdmin && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow flex flex-col sm:flex-row sm:items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">
                Bill backdate limit (days)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={limitInput}
                  onChange={(e) => { setLimitInput(e.target.value); setLimitSaved(false); }}
                  className="w-24 px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
                />
                <button
                  onClick={saveBackdateLimit}
                  disabled={limitSaving}
                  className="flex items-center gap-2 px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {limitSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Save
                </button>
                {limitSaved && (
                  <span className="flex items-center gap-1 text-xs text-green-600">
                    <CheckCircle className="w-4 h-4" /> Saved
                  </span>
                )}
              </div>
            </div>
            <p className="text-[11px] text-[#8B7355] sm:pb-2">
              Non-admins can only enter purchase/bill/GRN dates within the last {backdateLimit} day(s) (no future dates). Admins are exempt.
            </p>
          </div>
        )}

        {/* Filters Row */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow">
          <div className="flex flex-col sm:flex-row gap-3 items-end">
            <div className="flex-1 min-w-0">
              <label className="block text-xs text-[#8B7355] mb-1">Search Material</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
                  placeholder="Search by material, vendor, or brand..."
                  className="w-full pl-10 pr-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] placeholder-[#8B7355] focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent"
                />
              </div>
            </div>
            <div className="w-full sm:w-40">
              <label className="block text-xs text-[#8B7355] mb-1">From Date</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent [color-scheme:light]"
              />
            </div>
            <div className="w-full sm:w-40">
              <label className="block text-xs text-[#8B7355] mb-1">To Date</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent [color-scheme:light]"
              />
            </div>
            <button
              onClick={applyFilters}
              className="flex items-center gap-2 px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
            >
              <Search className="w-4 h-4" />
              Filter
            </button>
            <button
              onClick={exportPurchases}
              disabled={sortedPurchases.length === 0}
              className="flex items-center gap-2 px-4 py-2 border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
              title="Download all purchases below as Excel (matches your current search / date filters)"
            >
              <Download className="w-4 h-4" />
              Export ({sortedPurchases.length})
            </button>
          </div>
        </div>

        {/* Purchases Table */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[#8B7355] border-b border-[#E8D5C4] bg-white/50">
                  <th
                    className="text-left py-3 px-4 font-medium cursor-pointer select-none hover:text-[#3D2614] transition-colors"
                    onClick={toggleSort}
                  >
                    <span className="inline-flex items-center gap-1">
                      Date
                      {sortDir === 'desc' ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronUp className="w-3.5 h-3.5" />
                      )}
                    </span>
                  </th>
                  <th className="text-left py-3 px-4 font-medium">Material</th>
                  <th className="text-left py-3 px-4 font-medium">Vendor</th>
                  <th className="text-left py-3 px-4 font-medium" title="Our system-generated invoice number">Invoice ID</th>
                  <th className="text-left py-3 px-4 font-medium" title="The vendor's own bill number">Bill No</th>
                  <th className="text-left py-3 px-4 font-medium">Brand</th>
                  <th className="text-right py-3 px-4 font-medium">Qty</th>
                  <th className="text-right py-3 px-4 font-medium">Unit Price</th>
                  <th className="text-right py-3 px-4 font-medium">Total</th>
                  <th className="text-right py-3 px-4 font-medium">Total Inward</th>
                  <th className="text-left py-3 px-4 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {paginatedPurchases.map((p, i) => (
                  <tr
                    key={p.id}
                    className={`border-b border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/40 transition-colors ${
                      i % 2 === 0 ? 'bg-white' : 'bg-white/60'
                    }`}
                  >
                    <td className="py-3 px-4 text-[#6B5744] font-mono text-xs whitespace-nowrap">
                      {fmtISTDate(p.date)}
                    </td>
                    <td className="py-3 px-4 text-[#2D1B0E] font-medium">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span>{p.material_name || p.material_id}</span>
                        {(p as any).is_emergency ? (
                          <span title={`Emergency / cash purchase${(p as any).emergency_reason ? ' — ' + (p as any).emergency_reason : ''}${(p as any).payment_mode ? ' (' + (p as any).payment_mode + ')' : ''}`}
                                className="text-[9px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200 font-medium uppercase tracking-wide">
                            🚨 EMRG{(p as any).payment_mode ? ` · ${(p as any).payment_mode}` : ''}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-[#6B5744]">{p.vendor || '-'}</td>
                      <td className="py-3 px-4 text-[#6B5744] font-mono text-xs">{(p as any).invoice_id || '-'}</td>
                    <td className="py-3 px-4 text-[#6B5744] font-mono text-xs">{(p as any).bill_no || '-'}</td>
                    <td className="py-3 px-4 text-[#6B5744]">{p.brand || '-'}</td>
                    <td className="py-3 px-4 text-right text-[#3D2614] font-mono">
                      {(() => {
                        // p.quantity is stored in PURCHASE units (e.g. 20 kg, 12 BTL),
                        // so purchase_qty == quantity. recipe_qty is the recipe-unit
                        // equivalent (e.g. 20,000 g) and is shown as a secondary hint
                        // only when it actually differs (kg→g, L→ml, BTL→ml).
                        const pq = (p as any).purchase_qty ?? p.quantity;
                        const rq = (p as any).recipe_qty;
                        const pu = (p as any).material_purchase_unit;
                        const ru = (p as any).material_unit;
                        if (rq != null && Number(rq) !== Number(pq)) {
                          return (
                            <>
                              <span>{Number(pq).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                              <span className="ml-1 text-[10px] text-[#8B7355]">{pu || ru}</span>
                              <div className="text-[10px] text-[#8B7355]">
                                = {Number(rq).toLocaleString('en-IN')} {ru}
                              </div>
                            </>
                          );
                        }
                        return <>{Number(pq).toLocaleString('en-IN')} <span className="text-[10px] text-[#8B7355]">{pu || ru || ''}</span></>;
                      })()}
                    </td>
                    <td className="py-3 px-4 text-right text-[#3D2614] font-mono">
                      {(() => {
                        // p.unit_price is ALREADY ₹ per purchase unit (purchase_unit_price
                        // is its alias), so there is no division here — only the label.
                        // It used to be printed bare for pack-1 materials, which left a
                        // ₹ figure next to a purchase quantity with no unit at all; the
                        // "/ kg" reads the same for pack 1 and pack 1000.
                        const pup = (p as any).purchase_unit_price;
                        const pu = (p as any).material_purchase_unit || (p as any).material_unit;
                        const rate = pup != null ? pup : p.unit_price;
                        return (
                          <>
                            {formatCurrency(rate)}
                            {pu ? <span className="ml-1 text-[10px] text-[#8B7355]">/ {pu}</span> : null}
                          </>
                        );
                      })()}
                    </td>
                    <td className="py-3 px-4 text-right text-green-400 font-mono font-medium">
                      {formatCurrency(p.total_price)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono">
                      {(() => {
                        // ALWAYS print a number. This is a right-aligned money
                        // column sitting next to Total; a dash reads as "the
                        // system lost the value" — which is exactly how it was
                        // reported. Every other inward surface (GRN detail, GRN
                        // print, both register CSVs, the bulk-upload preview on
                        // this same page) prints one unconditionally.
                        // The emphasis test is "is ANY charge column recorded",
                        // NOT "does the net come to zero": a ₹100 discount plus
                        // ₹100 delivery nets to zero and both are real.
                        const c = (k: string) => Number((p as any)[k]) || 0;
                        // compensation_cess is the EIGHTH charge column: GST
                        // Compensation Cess, distinct from special_excise_cess
                        // (which means TGBCL Special Excise Cess everywhere it
                        // is read). Both are recorded-only and both add.
                        const KEYS = ['discount', 'cgst', 'sgst', 'compensation_cess', 'special_excise_cess', 'tcs', 'delivery_charges', 'mrp_round_off'];
                        const anyCharge = KEYS.some((k) => c(k) !== 0);
                        const charges = -c('discount') + c('cgst') + c('sgst') + c('compensation_cess') + c('special_excise_cess') + c('tcs') + c('delivery_charges') + c('mrp_round_off');
                        const val = (Number(p.total_price) || 0) + charges;
                        return anyCharge
                          ? <span className="text-[#af4408] font-medium">{formatCurrency(val)}</span>
                          : <span className="text-[#8B7355]" title="No inward charges recorded — same as Total">{formatCurrency(val)}</span>;
                      })()}
                    </td>
                    <td className="py-3 px-4 text-[#8B7355] max-w-[200px] truncate">
                      {p.notes || '-'}
                    </td>
                  </tr>
                ))}
                {paginatedPurchases.length === 0 && (
                  <tr>
                    <td colSpan={11} className="py-12 text-center text-[#8B7355]">
                      <ShoppingCart className="w-10 h-10 mx-auto mb-3 opacity-40" />
                      <p>No purchases found.</p>
                      <p className="text-xs mt-1">Add your first purchase to get started.</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-[#E8D5C4]">
              <p className="text-xs text-[#8B7355]">
                Showing {(page - 1) * pageSize + 1}-
                {Math.min(page * pageSize, sortedPurchases.length)} of {sortedPurchases.length}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 text-xs bg-[#FFF1E3] text-[#6B5744] rounded hover:bg-[#FFF1E3] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Previous
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter(
                    (p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1
                  )
                  .map((p, idx, arr) => (
                    <span key={p}>
                      {idx > 0 && arr[idx - 1] !== p - 1 && (
                        <span className="px-1 text-[#8B7355] text-xs">...</span>
                      )}
                      <button
                        onClick={() => setPage(p)}
                        className={`px-3 py-1 text-xs rounded transition-colors ${
                          p === page
                            ? 'bg-[#af4408] text-white'
                            : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#FFF1E3]'
                        }`}
                      >
                        {p}
                      </button>
                    </span>
                  ))}
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-3 py-1 text-xs bg-[#FFF1E3] text-[#6B5744] rounded hover:bg-[#FFF1E3] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Toast */}
      {/* Server notes from the last successful bill. AMBER, not red, and it
          never auto-dismisses: the bill IS saved (see the "a bill is a fact"
          rule above), but a pair the map refused to learn is a decision only a
          human can finish, on Vendor Items. */}
      {billNotices.length > 0 && (
        <div className="fixed bottom-24 right-6 z-50 max-w-md rounded-lg border border-amber-300 bg-amber-50 shadow-lg">
          <div className="flex items-start gap-2 px-4 py-3">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
            <div className="flex-1 space-y-1.5">
              <p className="text-xs font-semibold text-amber-900">
                Bill saved — {billNotices.length === 1 ? 'one thing' : `${billNotices.length} things`} to know
              </p>
              {billNotices.map((n, i) => (
                <p key={i} className="text-[11px] leading-snug text-amber-800">{n}</p>
              ))}
            </div>
            <button
              onClick={() => setBillNotices([])}
              className="shrink-0 text-amber-700 hover:opacity-70 transition-opacity"
              aria-label="Dismiss notes"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3 bg-green-600 text-white rounded-lg shadow-lg animate-[fadeIn_0.3s_ease-out]">
          <span className="text-sm font-medium">{toast}</span>
          <button onClick={() => setToast(null)} className="hover:opacity-70 transition-opacity">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ================================================================ */}
      {/* BULK UPLOAD MODAL                                                */}
      {/* ================================================================ */}
      {bulkModalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 pb-8 overflow-y-auto">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setBulkModalOpen(false)} />
          <div className="relative w-full max-w-5xl bg-white rounded-2xl shadow-xl border border-[#E8D5C4] mx-4">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4]">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/10">
                  <Upload className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[#2D1B0E]">Bulk Upload Purchases</h2>
                  <p className="text-xs text-[#8B7355]">Upload CSV or Excel file with monthly purchase data</p>
                </div>
              </div>
              <button onClick={() => setBulkModalOpen(false)} className="p-1 text-[#8B7355] hover:text-[#2D1B0E]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              {/* Column Info */}
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-4">
                <p className="text-sm font-medium text-[#6B5744] mb-2">Supported Columns:</p>
                <div className="flex flex-wrap gap-2">
                  {['item_name / ITEM NAME', 'quantity / QTY', 'unit_price / RATE', 'total_amount', 'vendor / SUPPLIER NAME', 'date / INWARD DATE', 'brand', 'gst_amount', 'notes'].map((col) => (
                    <code key={col} className="text-xs bg-white border border-[#E8D5C4] text-[#6B5744] px-2 py-1 rounded">{col}</code>
                  ))}
                </div>
                <p className="text-xs text-[#8B7355] mt-2">
                  Items are matched by name to existing inventory materials. If <code className="bg-white px-1 rounded">unit_price</code> is missing, it&apos;s calculated from <code className="bg-white px-1 rounded">total_amount / quantity</code>.
                </p>
              </div>

              {/* Drop Zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setBulkDragOver(true); }}
                onDragLeave={() => setBulkDragOver(false)}
                onDrop={handleBulkDrop}
                onClick={() => bulkFileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
                  bulkDragOver
                    ? 'border-green-500 bg-green-50'
                    : 'border-[#D4B896] hover:border-[#af4408] hover:bg-[#FFF1E3]/30'
                }`}
              >
                <FileSpreadsheet className="w-10 h-10 text-[#8B7355] mx-auto mb-3" />
                <p className="text-[#6B5744] font-medium">
                  {bulkFileName ? bulkFileName : 'Drag & drop your file here, or click to browse'}
                </p>
                <p className="text-xs text-[#8B7355] mt-1">Accepts .csv, .xlsx, and .xls files</p>
                <input
                  ref={bulkFileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={handleBulkFileInput}
                  className="hidden"
                />
              </div>

              {/* Preview Table */}
              {bulkParsedData.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-[#2D1B0E]">
                      Preview ({bulkParsedData.length} rows)
                    </h3>
                    {/* Show BOTH bases so the figure can be reconciled against
                        the bill: Subtotal is charge-free (qty × rate, what the
                        cost basis uses); Total Inward adds the per-line charges
                        (CGST/SGST/cess/TCS/delivery/round-off − discount). */}
                    {(() => {
                      const sub = bulkParsedData.reduce((s, r) => s + (r.total_amount || r.unit_price * r.quantity), 0);
                      const chg = bulkParsedData.reduce((s, r) => s
                        - (Number(r.discount) || 0) + (Number(r.cgst) || 0) + (Number(r.sgst) || 0)
                        + (Number(r.compensation_cess) || 0)
                        + (Number(r.special_excise_cess) || 0) + (Number(r.tcs) || 0)
                        + (Number(r.delivery_charges) || 0) + (Number(r.mrp_round_off) || 0), 0);
                      return (
                        <div className="flex items-center gap-3 text-xs text-[#8B7355] flex-wrap justify-end">
                          <span>Subtotal: <span className="font-mono font-semibold text-[#2D1B0E]">{formatCurrency(sub)}</span></span>
                          {chg !== 0 && (
                            <span>+ charges <span className="font-mono">{formatCurrency(chg)}</span></span>
                          )}
                          <span>Total Inward: <span className="font-mono font-bold text-[#af4408]">
                            {formatCurrency(sub + chg)}
                          </span></span>
                        </div>
                      );
                    })()}
                  </div>
                  <div className="overflow-x-auto max-h-80 overflow-y-auto rounded-lg border border-[#E8D5C4]">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-[#FFF1E3] z-10">
                        <tr className="text-[#8B7355]">
                          <th className="text-left py-2 px-3 font-medium">#</th>
                          <th className="text-left py-2 px-3 font-medium">Item Name</th>
                          <th className="text-left py-2 px-3 font-medium">Vendor</th>
                          <th className="text-right py-2 px-3 font-medium" title="Inward qty in the material's PURCHASE unit — the importer multiplies by pack_size to get stock">Qty</th>
                          <th className="text-left py-2 px-3 font-medium" title="Purchase unit: from the sheet's purchase_unit column when present, otherwise the material's configured unit (matched by name). Blank = no matching material — the server will skip or auto-create the row.">Unit</th>
                          <th className="text-right py-2 px-3 font-medium" title="₹ per purchase unit">Unit Price</th>
                          <th className="text-right py-2 px-3 font-medium">Total</th>
                          <th className="text-right py-2 px-3 font-medium">GST</th>
                          <th className="text-left py-2 px-3 font-medium">Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bulkParsedData.slice(0, 100).map((row, i) => (
                          <tr key={i} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30">
                            <td className="py-1.5 px-3 text-[#8B7355] text-xs">{i + 1}</td>
                            <td className="py-1.5 px-3 text-[#2D1B0E] text-xs font-medium">{row.item_name}</td>
                            <td className="py-1.5 px-3 text-[#6B5744] text-xs">{row.vendor || '-'}</td>
                            <td className="py-1.5 px-3 text-right text-[#2D1B0E] font-mono text-xs">{row.quantity}</td>
                            {/* The importer reads `quantity` as PURCHASE units (it
                                applies ×pack_size itself). Printing it bare left a
                                sheet of naked numbers with no way to tell 20 kg from
                                20 g — resolve the unit the same way the server will:
                                sheet column first, else the material matched by name. */}
                            <td className="py-1.5 px-3 text-left text-[#8B7355] font-mono text-xs">
                              {(() => {
                                const sheetUnit = String(row.purchase_unit || '').trim();
                                if (sheetUnit) return sheetUnit;
                                const nm = String(row.item_name || '').toLowerCase().trim();
                                const m = nm ? (materials.find(x => String(x.name || '').toLowerCase().trim() === nm) as any) : null;
                                const u = m ? String(m.purchase_unit || m.unit || '').trim() : '';
                                return u || <span className="text-[#B8A590]">—</span>;
                              })()}
                            </td>
                            <td className="py-1.5 px-3 text-right text-[#2D1B0E] font-mono text-xs">{formatCurrency(row.unit_price)}</td>
                            <td className="py-1.5 px-3 text-right text-green-600 font-mono text-xs">
                              {formatCurrency(row.total_amount || row.unit_price * row.quantity)}
                            </td>
                            <td className="py-1.5 px-3 text-right text-amber-600 font-mono text-xs">
                              {row.gst_amount > 0 ? formatCurrency(row.gst_amount) : '-'}
                            </td>
                            <td className="py-1.5 px-3 text-[#6B5744] text-xs">{row.date}</td>
                          </tr>
                        ))}
                        {bulkParsedData.length > 100 && (
                          <tr>
                            <td colSpan={9} className="py-2 px-3 text-center text-xs text-[#8B7355]">
                              ... and {bulkParsedData.length - 100} more rows (showing first 100)
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Upload Actions */}
                  <div className="flex gap-3">
                    <button
                      onClick={submitBulkUpload}
                      disabled={bulkUploading}
                      className="flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-green-400 disabled:opacity-60 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      {bulkUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                      {bulkUploading ? `Uploading ${bulkParsedData.length} rows...` : `Upload ${bulkParsedData.length} Purchases`}
                    </button>
                    <button
                      onClick={() => { setBulkParsedData([]); setBulkFileName(null); setBulkResult(null); }}
                      className="px-4 py-2.5 bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm font-medium hover:bg-[#E8D5C4] transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

              {/* Upload Result */}
              {bulkResult && (
                <div className={`p-4 rounded-lg border ${
                  bulkResult.errors.length > 0 && bulkResult.success === 0
                    ? 'bg-red-50 border-red-200'
                    : bulkResult.errors.length > 0
                    ? 'bg-amber-50 border-amber-200'
                    : 'bg-green-50 border-green-200'
                }`}>
                  <div className="flex items-start gap-3">
                    {bulkResult.success > 0 ? (
                      <CheckCircle className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                    ) : (
                      <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
                    )}
                    <div className="flex-1 text-sm min-w-0">
                      {bulkResult.success > 0 && (
                        <p className="text-green-700 font-medium">{bulkResult.success} purchase(s) uploaded successfully!</p>
                      )}
                      {bulkResult.skipped > 0 && (
                        <p className="text-amber-700">
                          {bulkResult.skipped} row(s) NOT uploaded
                          {bulkResult.duplicates ? ` — including ${bulkResult.duplicates} already-uploaded duplicate(s)` : ''}.
                        </p>
                      )}

                      {bulkResult.skipped_rows && bulkResult.skipped_rows.length > 0 ? (
                        <div className="mt-2">
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <p className="text-[#6B5744] font-medium">Un-uploaded items ({bulkResult.skipped_rows.length}):</p>
                            <button
                              onClick={downloadSkippedRows}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#af4408] hover:bg-[#8a3506] text-white text-xs font-semibold whitespace-nowrap"
                            >
                              <Download className="w-3.5 h-3.5" /> Download un-uploaded rows
                            </button>
                          </div>
                          <div className="max-h-56 overflow-y-auto border border-[#E8D5C4] rounded-lg bg-white/70 divide-y divide-[#F0E4D6]">
                            {bulkResult.skipped_rows.map((r, i) => (
                              <div key={i} className="px-2.5 py-1.5 text-xs flex items-start justify-between gap-3">
                                <span className="font-medium text-[#2D1B0E] truncate">Row {r.row}: {r.item_name || '(no name)'}</span>
                                <span className={`shrink-0 text-right ${
                                  r.kind === 'liquor' ? 'text-blue-600'
                                  : r.kind === 'duplicate' ? 'text-amber-700'
                                  : r.kind === 'unit_mismatch' ? 'text-orange-700'
                                  : 'text-red-600'
                                }`}>{r.reason}</span>
                              </div>
                            ))}
                          </div>
                          <p className="text-[10px] text-[#8B7355] mt-1">
                            Fix the flagged items (or move liquor to Inventory → Liquor Store), then re-upload the downloaded file — already-uploaded rows are auto-skipped, so nothing doubles.
                          </p>
                        </div>
                      ) : bulkResult.errors.length > 0 ? (
                        <div className="mt-2 max-h-40 overflow-y-auto">
                          <p className="text-red-700 font-medium mb-1">Errors:</p>
                          {bulkResult.errors.slice(0, 20).map((err, i) => (
                            <p key={i} className="text-red-600 text-xs">{err}</p>
                          ))}
                          {bulkResult.errors.length > 20 && (
                            <p className="text-red-500 text-xs mt-1">... and {bulkResult.errors.length - 20} more</p>
                          )}
                        </div>
                      ) : null}
                    </div>
                    <button onClick={() => setBulkResult(null)} className="text-[#8B7355] hover:text-[#2D1B0E] text-xs">
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* BILL ENTRY MODAL                                                 */}
      {/* ================================================================ */}
      {billModalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 pb-8 overflow-y-auto">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setBillModalOpen(false)} />
          {/* maxHeight:none overrides the global mobile modal cap (globals.css §5,
              `max-height: calc(100vh-1rem)`), which has no overflow and so spilled
              tall bill content OUT of the card. The overlay above (items-start +
              overflow-y-auto) scrolls the grown card, and — unlike an internal
              scroll — never clips the material typeahead dropdown. */}
          {/* max-w-6xl (was 4xl): the line table now carries the goods → discount →
              taxable → tax → incl-tax reading across, and at 4xl every bill needed
              sideways scrolling to see the tax it was entered for. Still capped, and
              the table keeps its own overflow-x for narrower screens. */}
          <div style={{ maxHeight: 'none' }} className="relative w-full max-w-6xl bg-white rounded-2xl shadow-xl border border-[#E8D5C4] mx-4">
            {/* Bill Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4]">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-[#af4408]/10">
                  <Receipt className="w-5 h-5 text-[#af4408]" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[#2D1B0E]">Enter Full Bill</h2>
                  <p className="text-xs text-[#8B7355]">One vendor bill, many items — Delivery &amp; Discount auto-split across the lines. Enter each rate as the plain goods rate (no tax added in); GST is worked out per line after discount and recorded on its own.</p>
                </div>
              </div>
              <button onClick={() => setBillModalOpen(false)} className="p-1 text-[#8B7355] hover:text-[#2D1B0E]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleBillSubmit} className="px-6 py-5 space-y-5">
              {billError && (
                <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  {billError}
                </div>
              )}

              {/* Bill Info Row */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[#6B5744] mb-1">Vendor *</label>
                  {/* Picker over the vendor master, same interaction as the ad-hoc
                      GRN form so the two purchase-entry screens behave alike.
                      allowCustom because a real bill can arrive from a vendor
                      nobody has added yet — blocking it would just get the bill
                      entered somewhere worse. The badge below makes a NEW name
                      visible, so a typo'd second spelling of an existing vendor
                      isn't accepted in silence and split in spend reporting.
                      billData.vendor still carries the submitted string, so the
                      API contract is untouched. */}
                  {vendorsFailed ? (
                    <>
                      <input
                        type="text"
                        value={billData.vendor}
                        onChange={(e) => updateBillField('vendor', e.target.value)}
                        placeholder="Vendor name"
                        className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] placeholder-[#8B7355] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
                        required
                      />
                      <p className="mt-1 text-[10px] text-amber-800">
                        Vendor list unavailable — type the name exactly as it is spelled on other bills.
                      </p>
                    </>
                  ) : (
                    <>
                      <Combobox
                        options={vendors.map((v) => ({ value: v.name, label: v.name }))}
                        value={billData.vendor}
                        allowCustom
                        placeholder="Type or pick"
                        onChange={(typed) => updateBillField('vendor', typed)}
                        className="w-full pr-7 px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] placeholder-[#8B7355] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
                      />
                      {(() => {
                        const typed = billData.vendor.trim();
                        if (!typed) return null;
                        const known = vendors.some(
                          (v) => v.name.toLowerCase().trim() === typed.toLowerCase()
                        );
                        return known ? (
                          <p className="mt-1 text-[10px] text-emerald-700 flex items-center gap-1">
                            <CheckCircle className="w-3 h-3 shrink-0" /> In the vendor master
                          </p>
                        ) : (
                          <p className="mt-1 text-[10px] text-amber-800 flex items-start gap-1">
                            <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
                            <span>New vendor — check the spelling against an earlier bill before saving.</span>
                          </p>
                        );
                      })()}
                    </>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B5744] mb-1">Bill Number</label>
                  <input
                    type="text"
                    value={billData.bill_number}
                    onChange={(e) => updateBillField('bill_number', e.target.value)}
                    placeholder="INV-001"
                    className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] placeholder-[#8B7355] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B5744] mb-1">Date *</label>
                  <input
                    type="date"
                    value={billData.date}
                    onChange={(e) => updateBillField('date', e.target.value)}
                    min={dateMin}
                    max={dateMax}
                    className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408] [color-scheme:light]"
                    required
                  />
                  {!isAdmin && (
                    <p className="mt-1 text-[10px] text-[#8B7355]">{backdateHint}</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B5744] mb-1">Notes</label>
                  <input
                    type="text"
                    value={billData.notes}
                    onChange={(e) => updateBillField('notes', e.target.value)}
                    placeholder="Optional notes"
                    className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] placeholder-[#8B7355] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
                  />
                </div>
              </div>

              {/* Bill-level charges. Delivery is RECORDED ONLY; Discount REDUCES the
                  recorded cost of the goods. Both are split across the lines in
                  proportion to line value. (This replaced a GST control that folded
                  tax into every unit price — inflating average_price and every recipe
                  cost derived from it, with the tax stored nowhere it could be
                  reclaimed.) */}
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-4 space-y-3">
                <ChargeRow
                  label="Delivery Charges"
                  hint="recorded on the bill — does not change item cost"
                  mode={billData.delivery_mode}
                  value={billData.delivery_value}
                  onMode={(m) => updateBillField('delivery_mode', m)}
                  onValue={(v) => updateBillField('delivery_value', v)}
                  placeholder="e.g. 100"
                  total={billCalc.deliveryAmount}
                  tone="text-[#6B5744]"
                />
                <ChargeRow
                  label="Discount"
                  hint="reduces item cost"
                  mode={billData.discount_mode}
                  value={billData.discount_value}
                  onMode={(m) => updateBillField('discount_mode', m)}
                  onValue={(v) => updateBillField('discount_value', v)}
                  placeholder="e.g. 10"
                  total={billCalc.discountAmount}
                  tone="text-emerald-700"
                  negative
                />
                {billCalc.discountClamped && (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    Discount is larger than the bill&apos;s item value — capped at {formatCurrency(billCalc.subtotal)}{' '}
                    so the cost can&apos;t go negative.
                  </p>
                )}

                {/* GST is NOT a bill-level charge like the two rows above — it is a
                    DEFAULT rate each line inherits, and the tax is worked out per
                    line AFTER that line's discount share. Set once here because one
                    bill is normally one rate; a line can still override it. The tax
                    is recorded beside the goods rate and never inside it, so input
                    credit stays reclaimable and item cost stays true. */}
                <div className="flex items-center gap-4 flex-wrap border-t border-[#E8D5C4] pt-3">
                  <span className="text-sm font-medium text-[#6B5744] min-w-[130px]">
                    GST Rate
                    <span className="block text-[10px] font-normal text-[#8B7355]">every line follows this unless the line overrides it</span>
                  </span>
                  <select
                    value={billData.gst_rate}
                    onChange={(e) => updateBillField('gst_rate', e.target.value)}
                    className="px-3 py-1.5 bg-white border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
                  >
                    {GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
                  </select>
                  <span className="text-sm font-medium ml-auto text-[#6B5744]">
                    CGST {formatCurrency(billCalc.cgstTotal)} + SGST {formatCurrency(billCalc.sgstTotal)}
                    {' = '}<span className="text-[#2D1B0E]">{formatCurrency(billCalc.taxTotal)}</span>
                  </span>
                </div>
                <p className="text-[10px] text-[#8B7355]">
                  Tax is charged on the value <strong>after</strong> discount, shown per line, and recorded separately —
                  it is never added into the item rate, so recipe costs stay on the true goods price.
                </p>
              </div>

              {/* Line Items */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-[#2D1B0E]">Bill Items</h3>
                  <button
                    type="button"
                    onClick={addBillLine}
                    className="hidden md:flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-[#af4408] border border-[#af4408] rounded-lg hover:bg-[#af4408]/10 transition-colors"
                  >
                    <Plus className="w-3 h-3" /> Add Item
                  </button>
                </div>

                {/* VENDOR ↔ ITEM MAPPING — consulted, never blocking. Shown only
                    when the typed vendor resolves to a master row AND the map
                    actually loaded; a failed fetch leaves this whole block out
                    and the form behaves exactly as it did before. */}
                {billVendorId && vendorMapIds && (
                  <div className="mb-2 rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2">
                    {vendorMappedMaterials.length === 0 ? (
                      /* Said ONCE, at the top — annotating twenty lines with the
                         same sentence would be noise, not information. */
                      <p className="text-[11px] text-[#6B5744] flex items-start gap-1.5">
                        <Link2 className="w-3.5 h-3.5 shrink-0 mt-px text-[#8B7355]" />
                        <span>
                          No items are mapped to <strong>{vendorShort}</strong> yet, so there is nothing to
                          suggest on these lines. Saving this bill records each new pair automatically —
                          once. Use <strong>Add to this vendor&apos;s items</strong> on a line to bring back a
                          pair someone removed, or manage the list on{' '}
                          <Link
                            href={`/vendors/materials?vendor=${encodeURIComponent(billVendorId)}`}
                            target="_blank"
                            className="text-[#af4408] underline"
                          >
                            Vendor Items
                          </Link>.
                        </span>
                      </p>
                    ) : (
                      <>
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <p className="text-[11px] text-[#6B5744] flex items-start gap-1.5">
                            <Link2 className="w-3.5 h-3.5 shrink-0 mt-px text-[#af4408]" />
                            <span>
                              <strong>{vendorMappedMaterials.length}</strong> item
                              {vendorMappedMaterials.length === 1 ? ' is' : 's are'} mapped to{' '}
                              <strong>{vendorShort}</strong> — marked <span className="text-[#af4408]">★</span> in
                              every picker below. Any other material can still be picked and still saves.
                            </span>
                          </p>
                          <button
                            type="button"
                            onClick={() => setVendorItemsOpen((o) => !o)}
                            className="px-2 py-1 text-[10px] font-medium text-[#af4408] border border-[#af4408] rounded-lg hover:bg-[#af4408]/10"
                          >
                            {vendorItemsOpen ? 'Hide' : 'Show'} their items
                          </button>
                        </div>
                        {vendorItemsOpen && (
                          <div className="mt-2 max-h-40 overflow-y-auto flex flex-wrap gap-1.5">
                            {/* One click drops the item on the first empty line —
                                the vendor's own list, reachable before touching
                                the 900-row picker. */}
                            {vendorMappedMaterials.slice(0, 300).map((m: any) => (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => placeMaterialOnLine(String(m.id), String(m.name))}
                                title={`${m.sku ? m.sku + ' — ' : ''}${m.name}`}
                                className="px-2 py-1 rounded-full border border-[#E8D5C4] bg-white text-[10px] text-[#2D1B0E] hover:border-[#af4408] hover:bg-[#FFF1E3]"
                              >
                                {m.name}
                              </button>
                            ))}
                            {vendorMappedMaterials.length > 300 && (
                              <span className="self-center text-[10px] text-[#8B7355]">
                                +{(vendorMappedMaterials.length - 300).toLocaleString('en-IN')} more — use the picker
                              </span>
                            )}
                          </div>
                        )}
                      </>
                    )}
                    {billMapNote && (
                      <p className="mt-1.5 text-[10px] text-[#af4408]">{billMapNote}</p>
                    )}
                  </div>
                )}

                {/* Entry convention reminder */}
                <div className="text-[11px] text-[#6B5744] bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 mb-2">
                  <span className="font-semibold text-amber-900">Default: enter at bottle level.</span>
                  &nbsp;1 case of 12 bottles → qty = <code>12</code> (BTL), unit price per bottle.
                  &nbsp;<span className="text-amber-900">Want to type cases instead?</span> If the material has a <code>case_size</code>
                  set in inventory, a <strong>BTL / CASE</strong> toggle appears next to the qty input — pick CASE and type the case count + per-case price.
                </div>
                {/* SAME ITEM ON MORE THAN ONE LINE — flagged as it is typed, not
                    at submit. Merge is offered for an exact repeat; a split-rate
                    repeat is never merged, only surfaced for a decision. */}
                {dupInfo.groups.length > 0 && (
                  <div className="mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 space-y-2">
                    <p className="text-[11px] text-amber-900 flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                      <span>
                        <strong>The same item is on more than one line.</strong> Every line is saved as its
                        own purchase row — so a repeated item credits stock twice and is averaged into the
                        item&apos;s cost twice, which then re-costs every recipe that uses it.
                      </span>
                    </p>
                    {dupInfo.groups.map((g) => (
                      <div key={g.materialId} className="rounded-md border border-amber-200 bg-white px-2.5 py-2 space-y-1.5">
                        <p className="text-xs font-medium text-[#2D1B0E]">
                          {g.name}{' '}
                          <span className="font-normal text-[#8B7355]">— lines {g.lineNos.join(', ')}</span>
                        </p>

                        {/* Identical in every respect → one line, one click. The
                            quantity is summed onto the first of them; the rate is
                            untouched, so cost and tax are unchanged. */}
                        {g.mergeable.map((m) => (
                          <div key={m.key} className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-[11px] text-[#6B5744]">
                              Lines {m.lineNos.join(' + ')} are identical at{' '}
                              ₹{m.rate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}/{g.unit} —{' '}
                              <strong className="text-[#2D1B0E]">
                                {m.parts.map((p) => fmtQtyNum(p)).join(' + ')} = {fmtQtyNum(m.total)} {g.unit}
                              </strong>
                            </span>
                            <button
                              type="button"
                              onClick={() => mergeBillLines(g.materialId, m.key)}
                              className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-white bg-[#af4408] hover:bg-[#8a3506] rounded-lg"
                            >
                              <Merge className="w-3 h-3" /> Merge into one line
                            </button>
                          </div>
                        ))}

                        {/* Not the same thing. A bill really can charge two rates
                            for one item, so the choice is the user's — merging
                            would average the rate and corrupt every recipe cost
                            derived from it. */}
                        {g.differs.length > 0 && (
                          <div className="rounded border border-amber-200 bg-amber-50/70 px-2 py-1.5 space-y-1">
                            <p className="text-[11px] text-amber-900">
                              These lines have {g.differs.join(' and ')}, so they are <strong>not</strong> the
                              same line and nothing is merged automatically. Correct the entry if it was a
                              mis-type — or say the bill really is split this way.
                            </p>
                            <label className="flex items-start gap-1.5 text-[11px] text-[#6B5744] cursor-pointer">
                              <input
                                type="checkbox"
                                checked={dupAck.includes(g.sig)}
                                onChange={() => { toggleDupAck(g.sig); setBillError(null); }}
                                className="mt-0.5 accent-[#af4408]"
                              />
                              <span>
                                Keep both — the vendor really billed {g.name} at more than one rate/brand on
                                this bill.
                              </span>
                            </label>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="overflow-x-auto rounded-xl border border-[#E8D5C4]">
                  {/* md:min-w forces the horizontal scroll of the wrapper above
                      instead of crushing eleven columns; on mobile the rows are
                      block cards, where a min-width would only add a pointless
                      sideways scroll. */}
                  <table className="w-full md:min-w-[1180px] text-sm block md:table">
                    <thead className="bg-[#FFF1E3] hidden md:table-header-group">
                      <tr className="text-[#6B5744]">
                        <th className="text-left py-2.5 px-3 font-medium w-[19%]">Material *</th>
                        <th className="text-left py-2.5 px-3 font-medium w-[9%]">Brand</th>
                        {/* These two headers used to be hard-coded "(bottles)" and
                            "/btl" — true for a liquor bill, plain wrong for the kg /
                            L / PKT lines that make up most of a grocery bill. Both
                            columns are the material's own PURCHASE unit, printed
                            per line under each box. */}
                        <th className="text-right py-2.5 px-3 font-medium w-[9%]" title="In the material's purchase unit — bottles / kg / L / PKT (not cases, unless you switch the line to CASE)">Qty * <span className="text-[10px] font-normal text-[#8B7355]">(purchase units)</span></th>
                        <th className="text-right py-2.5 px-3 font-medium w-[10%]" title="Vendor rate per purchase unit (per bottle / per kg / per L)">Unit Price (₹) * <span className="text-[10px] font-normal text-[#8B7355]">/ purchase unit</span></th>
                        <th className="text-right py-2.5 px-3 font-medium w-[8%]">Line Total</th>
                        <th className="text-right py-2.5 px-3 font-medium w-[8%]">Discount</th>
                        {/* Reads left to right exactly as the arithmetic runs:
                            goods − discount = taxable, × GST% = tax, + tax = what
                            the bill charges. Final Unit ₹ sits last and stays the
                            GOODS rate — it is the number that becomes cost. */}
                        <th className="text-right py-2.5 px-3 font-medium w-[8%]" title="Line Total minus its discount share — the value GST is charged on">Taxable</th>
                        <th className="text-right py-2.5 px-3 font-medium w-[6%]">GST %</th>
                        <th className="text-right py-2.5 px-2 font-medium w-[6%]" title="GST Compensation Cess % — a SEPARATE levy from GST (12% on aerated drinks, other rates on tobacco). Charged on the same taxable value, recorded beside the rate, and never folded into CGST/SGST.">Cess %</th>
                        <th className="text-right py-2.5 px-3 font-medium w-[8%]" title="Charged on the taxable value above, split into CGST + SGST. Recorded separately — never added into the item rate.">Tax (C+S)</th>
                        <th className="text-right py-2.5 px-3 font-medium w-[8%]" title="Taxable + GST + compensation cess — what this line adds to the bill">Incl. Tax</th>
                        <th className="text-right py-2.5 px-3 font-medium w-[10%]" title="Post-discount GOODS rate — this is what is stored as the purchase price. Tax is NOT in it.">Final Unit ₹</th>
                        <th className="py-2.5 px-2 w-8"></th>
                      </tr>
                    </thead>
                    <tbody className="block md:table-row-group">
                      {billCalc.items.map((item, idx) => (
                        <tr key={item.id}
                            /* Tinted while this line shares its material with
                               another — the panel above names the pair, this
                               shows WHICH rows it is talking about. */
                            className={`border-t border-[#E8D5C4]/50 block md:table-row rounded-lg border border-[#E8D5C4] p-3 mb-2 space-y-2 md:p-0 md:mb-0 md:border-0 md:border-t md:space-y-0 ${
                              dupInfo.flagged.has(idx) ? 'bg-amber-50/70' : ''}`}>
                          <td className="py-2 px-2 block md:table-cell">
                            <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Material</span>
                            {/* billPickerMaterials = the same full catalogue with
                                this vendor's mapped items marked ★. Nothing is
                                filtered out — every material stays pickable. */}
                            <MaterialTypeahead
                              materials={billPickerMaterials as any} purchaseBasis
                              value={item.material_id}
                              onPick={(id) => updateBillLine(item.id, 'material_id', id)}
                            />
                            {/* A bill is a fact: an unmapped pair is a NOTE with a
                                one-click fix, never a block on saving. */}
                            {vendorMapIds && vendorMapIds.size > 0 && item.material_id
                              && !vendorMapIds.has(item.material_id) && (() => {
                              const mat = materials.find((m) => String(m.id) === String(item.material_id)) as any;
                              const nm = String(mat?.name || item.material_id);
                              return (
                                <div className="mt-1 text-[9px] leading-tight text-amber-800">
                                  Not in {vendorShort}&apos;s items.{' '}
                                  <button
                                    type="button"
                                    disabled={vendorMapBusy}
                                    onClick={() => addToVendorItems(String(item.material_id), nm)}
                                    className="underline font-medium text-[#af4408] disabled:opacity-50"
                                  >
                                    Add to this vendor&apos;s items
                                  </button>
                                </div>
                              );
                            })()}
                          </td>
                          <td className="py-2 px-2 block md:table-cell">
                            <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Brand</span>
                            <input
                              type="text"
                              value={item.brand}
                              onChange={(e) => updateBillLine(item.id, 'brand', e.target.value)}
                              placeholder="Brand"
                              className="w-full px-2 py-1.5 bg-white border border-[#D4B896] rounded text-xs text-[#2D1B0E] focus:outline-none focus:ring-1 focus:ring-[#af4408]"
                            />
                          </td>
                          <td className="py-2 px-2 block md:table-cell">
                            <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Qty</span>
                            {(() => {
                              const mat = materials.find(m => m.id === item.material_id) as any;
                              const caseSize = Number(mat?.case_size) || 1;
                              const hasCase = caseSize > 1;
                              const mode: 'btl' | 'case' = item.entry_mode || 'btl';
                              const rawQty = parseFloat(item.quantity) || 0;
                              const expandedBtl = mode === 'case' ? rawQty * caseSize : rawQty;
                              return (
                                <div className="space-y-0.5">
                                  <div className="flex gap-1">
                                    <input
                                      type="number" step="0.01" min="0"
                                      value={item.quantity}
                                      onChange={(e) => updateBillLine(item.id, 'quantity', e.target.value)}
                                      placeholder="0"
                                      className="flex-1 px-2 py-1.5 bg-white border border-[#D4B896] rounded text-xs text-right text-[#2D1B0E] focus:outline-none focus:ring-1 focus:ring-[#af4408]"
                                    />
                                    {hasCase && (
                                      <select
                                        value={mode}
                                        onChange={(e) => updateBillLine(item.id, 'entry_mode', e.target.value)}
                                        className="px-1.5 py-1.5 bg-white border border-[#D4B896] rounded text-[10px] text-[#2D1B0E] focus:outline-none"
                                        title={`This material has case_size = ${caseSize} bottles per case`}>
                                        <option value="btl">BTL</option>
                                        <option value="case">CASE</option>
                                      </select>
                                    )}
                                  </div>
                                  {hasCase && mode === 'case' && rawQty > 0 && (
                                    <div className="text-[9px] text-emerald-700 text-right font-mono">
                                      = {expandedBtl} btl × {caseSize}
                                    </div>
                                  )}
                                  {/* Purchase unit + the recipe reading of what was
                                      typed. Display only — the line still posts the
                                      purchase-unit number (expanded by case_size in
                                      CASE mode, exactly as before). */}
                                  {(() => {
                                    const u = matUnits(item.material_id);
                                    // A CASE line holds CASES, not BTL — billSubmit
                                    // posts qty × case_size. Printing the purchase
                                    // unit unconditionally declared "5 BTL" under a
                                    // box that meant 5 cases = 60 BTL. The recipe
                                    // hint below was already suppressed here; the
                                    // unit itself was not.
                                    if (mode === 'case' && hasCase) return (
                                      <div className="text-[9px] text-[#B8A590] text-right">
                                        case{u.pu ? ` (${caseSize} ${u.pu})` : ''}
                                      </div>
                                    );
                                    if (!u.pu) return null;
                                    const h = recipeHint(item.quantity, u);
                                    return (
                                      <div className="text-[9px] text-[#B8A590] text-right">
                                        {u.pu}{h ? ` · ${h}` : ''}
                                      </div>
                                    );
                                  })()}
                                </div>
                              );
                            })()}
                          </td>
                          <td className="py-2 px-2 block md:table-cell">
                            <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Unit Price</span>
                            <input
                              type="number" step="0.01" min="0"
                              value={item.unit_price}
                              onChange={(e) => updateBillLine(item.id, 'unit_price', e.target.value)}
                              placeholder="0"
                              className="w-full px-2 py-1.5 bg-white border border-[#D4B896] rounded text-xs text-right text-[#2D1B0E] focus:outline-none focus:ring-1 focus:ring-[#af4408]"
                              title={caseBasis(item.material_id, item.entry_mode).on ? 'Per-case rate' : 'Per-bottle rate'}
                            />
                            {/* Sibling of the Qty cell above — keyed on the SAME
                                effective guard, so a line left on 'case' after
                                switching to a material with no case_size (where
                                billSubmit falls back to the per-unit rate) stops
                                claiming "per case". */}
                            {caseBasis(item.material_id, item.entry_mode).on ? (
                              <div className="text-[9px] text-[#8B7355] text-right">per case</div>
                            ) : (() => {
                              // ₹ per PURCHASE unit. Stored as ₹/purchase-unit too;
                              // the ₹/recipe-unit average is derived server-side.
                              const u = matUnits(item.material_id);
                              return u.pu ? <div className="text-[9px] text-[#B8A590] text-right">₹ / {u.pu}</div> : null;
                            })()}
                          </td>
                          <td className="py-2 px-3 text-right text-xs font-mono text-[#6B5744] block md:table-cell">
                            <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Line Total</span>
                            {formatCurrency(item.line_total)}
                          </td>
                          <td className="py-2 px-3 text-right text-xs font-mono text-emerald-700 block md:table-cell">
                            <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Discount</span>
                            {item.discount_share > 0 ? `- ${formatCurrency(item.discount_share)}` : formatCurrency(0)}
                          </td>
                          <td className="py-2 px-3 text-right text-xs font-mono text-[#6B5744] block md:table-cell">
                            <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Taxable (after discount)</span>
                            {formatCurrency(item.taxable)}
                          </td>
                          <td className="py-2 px-2 text-right block md:table-cell">
                            <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">GST %</span>
                            {item.zero_rated ? (
                              // The rate is not the storekeeper's to set here: this
                              // material belongs to a store location, where excise /
                              // cess / TCS are charged on the store's own bill. A
                              // GST% on it would be tax that was never paid.
                              <div className="text-[10px] text-blue-700 leading-tight">
                                0%
                                <span className="block text-[9px] text-[#8B7355]">store item — taxed on the TGBCL bill</span>
                              </div>
                            ) : (
                              <select
                                value={item.gst_rate}
                                onChange={(e) => updateBillLine(item.id, 'gst_rate', e.target.value)}
                                className="w-full px-1.5 py-1.5 bg-white border border-[#D4B896] rounded text-xs text-right text-[#2D1B0E] focus:outline-none focus:ring-1 focus:ring-[#af4408]"
                                title="Blank follows the bill's GST rate. Change it only for a line the vendor billed at a different rate."
                              >
                                <option value="">Bill ({billData.gst_rate}%)</option>
                                {GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
                              </select>
                            )}
                          </td>
                          <td className="py-2 px-2 text-right block md:table-cell">
                            <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Cess %</span>
                            {item.zero_rated ? (
                              // Same reason as the GST cell: a TGBCL line's cess
                              // is levied on the store's own bill, not ours.
                              <div className="text-[10px] text-blue-700 leading-tight">0%</div>
                            ) : (
                              // A FREE number input, not a select — compensation
                              // cess has no fixed rate card (12% on aerated
                              // drinks, other rates on tobacco), and it mirrors
                              // the master's own free 0-100 field. Raw string in
                              // state so a decimal stays typeable.
                              <input
                                type="number" step="0.01" min="0" max="100"
                                value={item.cess_rate}
                                onChange={(e) => updateBillLine(item.id, 'cess_rate', e.target.value)}
                                placeholder="0"
                                className="w-full px-1.5 py-1.5 bg-white border border-[#D4B896] rounded text-xs text-right text-[#2D1B0E] focus:outline-none focus:ring-1 focus:ring-[#af4408]"
                                title="GST Compensation Cess % for this line (e.g. 12 on aerated drinks). Seeded from the Raw Material master; change it if the printed bill says otherwise. A separate levy — it is NOT part of CGST/SGST."
                              />
                            )}
                            {item.compensation_cess > 0 && (
                              <span className="block text-[9px] text-[#8B7355] font-mono">
                                {formatCurrency(item.compensation_cess)}
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-right text-xs font-mono text-[#6B5744] block md:table-cell">
                            <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Tax (CGST + SGST)</span>
                            {formatCurrency(item.tax_value)}
                            {item.tax_value > 0 && (
                              <span className="block text-[9px] text-[#8B7355]">
                                {formatCurrency(item.cgst)} + {formatCurrency(item.sgst)}
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-right text-xs font-mono text-[#2D1B0E] block md:table-cell">
                            <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Incl. Tax</span>
                            {formatCurrency(item.line_incl_tax)}
                          </td>
                          <td className="py-2 px-3 text-right text-xs font-mono font-semibold text-[#af4408] block md:table-cell">
                            <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Final Unit ₹ (goods, no tax)</span>
                            {formatCurrency(item.final_unit_price)}
                          </td>
                          <td className="py-2 px-1 block md:table-cell">
                            {billCalc.items.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeBillLine(item.id)}
                                className="p-1 text-red-400 hover:text-red-600 transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Primary Add-item — full width at the BOTTOM so on mobile it sits
                    right below the item you just entered (the top button is desktop-only). */}
                <button type="button" onClick={addBillLine}
                        className="mt-2 w-full flex items-center justify-center gap-1.5 py-2.5 border-2 border-dashed border-[#E8D5C4] rounded-lg text-sm font-medium text-[#af4408] hover:border-[#af4408] hover:bg-[#FFF1E3] active:bg-[#FFE8D5]">
                  <Plus className="w-4 h-4" /> Add line
                </button>
              </div>

              {/* Bill Summary */}
              {/* Reads in the same order as the paper bill in the storekeeper's
                  hand, so the screen can be reconciled against it line by line. */}
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-4 text-center">
                  <div>
                    <p className="text-xs text-[#8B7355] mb-0.5">Goods Total</p>
                    <p className="text-lg font-bold text-[#2D1B0E]">{formatCurrency(billCalc.subtotal)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[#8B7355] mb-0.5">Discount</p>
                    <p className="text-lg font-bold text-emerald-700">- {formatCurrency(billCalc.discountAmount)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[#8B7355] mb-0.5">Taxable</p>
                    <p className="text-lg font-bold text-[#2D1B0E]">{formatCurrency(billCalc.taxableTotal)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[#8B7355] mb-0.5">CGST</p>
                    <p className="text-lg font-bold text-[#6B5744]">+ {formatCurrency(billCalc.cgstTotal)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[#8B7355] mb-0.5">SGST</p>
                    <p className="text-lg font-bold text-[#6B5744]">+ {formatCurrency(billCalc.sgstTotal)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[#8B7355] mb-0.5" title="GST Compensation Cess — a separate levy, deliberately NOT part of CGST/SGST above">Cess</p>
                    <p className="text-lg font-bold text-[#6B5744]">+ {formatCurrency(billCalc.cessTotal)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[#8B7355] mb-0.5">Delivery</p>
                    <p className="text-lg font-bold text-[#6B5744]">+ {formatCurrency(billCalc.deliveryAmount)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[#8B7355] mb-0.5">Bill Total</p>
                    <p className="text-lg font-bold text-[#af4408]">{formatCurrency(billCalc.grandTotal)}</p>
                  </div>
                </div>
                <p className="text-[10px] text-[#8B7355] text-center mt-2">
                  Discount and Delivery are split across items in proportion to line value.
                  Per line: Taxable = Line Total − Discount Share, Tax = Taxable × GST% (split half CGST, half SGST).
                  Final Unit Price = Taxable ÷ Qty, and that is what is stored as the purchase price
                  (case-mode lines are stored per bottle, expanded by case size: rate ÷ case size against qty × case size).
                  So a discount lowers item cost, while delivery, GST and cess are recorded on the bill without changing it —
                  GST is reclaimable input credit, not part of what the food costs.
                  Compensation Cess is a separate levy (it is not GST and is not split into CGST/SGST); it is
                  recorded beside the rate the same way and is also kept out of item cost.
                </p>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setBillModalOpen(false)}
                  className="px-4 py-2 text-sm text-[#6B5744] hover:text-[#2D1B0E] bg-[#FFF1E3] rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={billSubmitting || materials.length === 0}
                  className="flex items-center gap-2 px-5 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {billSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Receipt className="w-4 h-4" />}
                  {billSubmitting ? 'Saving...' : `Save Bill (${billCalc.items.filter(i => i.material_id).length} items)`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {recahoOpen && <RecahoInwardModal onClose={() => setRecahoOpen(false)} onCommitted={() => { setRecahoOpen(false); fetchPurchases(); }} />}
    </div>
  );
}

/* ============================================================ */
/* RecahoInwardModal — drag/drop upload of the Advanced Inward   */
/* Report. Two steps: preview (parse server-side) → commit.      */
/* ============================================================ */
function RecahoInwardModal({ onClose, onCommitted }:
  { onClose: () => void; onCommitted: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const csrf = (() => {
    if (typeof document === 'undefined') return '';
    const m = document.cookie.split('; ').find(c => c.startsWith('fnb_csrf='));
    return m ? decodeURIComponent(m.split('=')[1]) : '';
  })();

  const onPick = async (f: File) => {
    setFile(f); setError(null); setPreview(null); setCommitted(null); setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await fetch('/api/inward-import/preview', {
        method: 'POST', body: fd, headers: { 'X-CSRF-Token': csrf },
        credentials: 'same-origin',
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setPreview(j);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const commit = async () => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch('/api/inward-import/commit', {
        method: 'POST', body: fd, headers: { 'X-CSRF-Token': csrf },
        credentials: 'same-origin',
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setCommitted(j);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) onPick(f);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <div>
            <h2 className="font-bold text-[#2D1B0E] inline-flex items-center gap-2">
              <Upload className="w-5 h-5 text-purple-600" /> Recaho Inward Upload
            </h2>
            <p className="text-xs text-[#8B7355] mt-0.5">
              Upload the <span className="font-semibold">Advanced Inward Report</span> from Recaho —
              any sheet (Item Wise / Supplier Wise / Category Wise) is auto-detected.
            </p>
          </div>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Drop zone */}
          {!preview && !committed && (
            <div onDragOver={e => { e.preventDefault(); }}
                 onDrop={handleDrop}
                 onClick={() => inputRef.current?.click()}
                 className="border-2 border-dashed border-purple-300 hover:border-purple-500 hover:bg-purple-50/30 rounded-xl p-10 text-center cursor-pointer transition-colors">
              <Upload className="w-10 h-10 text-purple-400 mx-auto mb-3" />
              <p className="text-sm font-medium text-[#2D1B0E]">
                {file ? file.name : 'Drop the .xlsx file here, or click to browse'}
              </p>
              <p className="text-[10px] text-[#8B7355] mt-1">
                Group / subtotal rows are skipped automatically. Vendors and materials are auto-created.
              </p>
              <input ref={inputRef} type="file" accept=".xlsx,.xls" className="hidden"
                     onChange={e => { const f = e.target.files?.[0]; if (f) onPick(f); }} />
            </div>
          )}

          {busy && <div className="text-center text-xs text-[#8B7355] inline-flex items-center gap-2 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Working…</div>}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
          )}

          {/* Preview */}
          {preview && !committed && (
            <div className="bg-[#FFF1E3]/50 border border-[#E8D5C4] rounded-lg p-4 space-y-3">
              <h3 className="text-sm font-semibold text-[#2D1B0E]">Preview</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <Stat label="Lines" value={preview.rows.toLocaleString('en-IN')} />
                <Stat label="Items" value={preview.summary?.unique_items?.toLocaleString('en-IN') || '0'} />
                <Stat label="Suppliers" value={preview.summary?.unique_suppliers?.toLocaleString('en-IN') || '0'} />
                <Stat label="Total ₹" value={'₹' + (preview.summary?.total_amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })} />
              </div>
              {/* The SPLIT of that Total, because the split is the whole point:
                  the importer used to write the tax-inclusive Total Inward into
                  purchases.total_price, so the goods rate itself carried the tax.
                  Now only Goods becomes the purchase value and the rest is
                  recorded in its own charge columns beside it. Showing all three
                  lets the file be reconciled against the sheet BEFORE committing. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <Stat label="Goods ₹" value={'₹' + (preview.summary?.goods_amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })} />
                <Stat label="GST ₹" value={'₹' + (preview.summary?.gst_amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })} />
                <Stat label="Other charges ₹" value={'₹' + (preview.summary?.other_charges_amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })} />
              </div>
              <p className="text-[10px] text-[#6B5744] leading-relaxed">
                Only <b>Goods</b> goes into the purchase rate and therefore into recipe cost.
                <b> GST</b> is recorded beside it as reclaimable input credit.
                <b> Other charges</b> — TGBCL excise / special cess / TCS, delivery, MRP round-off —
                are recorded beside it as non-creditable landed cost.
                Goods + GST + Other charges = Total (Other charges is net of any discount on the line).
              </p>
              <div className="text-[11px] text-[#6B5744]">
                Date range: <b>{preview.summary?.date_from || '?'}</b> → <b>{preview.summary?.date_to || '?'}</b>
                {preview.sheets?.length > 1 && <> · Sheets in file: {preview.sheets.join(', ')}</>}
              </div>
              {preview.sample?.length > 0 && (
                <div className="overflow-x-auto bg-white border border-[#E8D5C4] rounded">
                  <table className="w-full text-[10px]">
                    <thead className="bg-[#FFF1E3] text-[#6B5744]">
                      <tr>
                        <th className="text-left  py-1 px-2 font-medium">Date</th>
                        <th className="text-left  py-1 px-2 font-medium">Supplier</th>
                        <th className="text-left  py-1 px-2 font-medium">Item</th>
                        <th className="text-right py-1 px-2 font-medium">Qty</th>
                        <th className="text-left  py-1 px-2 font-medium">Unit</th>
                        <th className="text-right py-1 px-2 font-medium" title="Qty × Rate — the charge-free goods value. THIS is what becomes the purchase amount.">Subtotal</th>
                        {/* Two visibly different quantities, side by side. They were
                            being conflated: the tax-inclusive figure was written into
                            total_price, so a GoT (TGBCL) line's goods value silently
                            carried its excise. On an ordinary GST vendor the gap is
                            the reclaimable tax. */}
                        <th className="text-right py-1 px-2 font-medium" title="Subtotal − discount + GST + excise / cess / TCS + delivery + round-off — what the bill charges.">Total Inward</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sample.map((r: any, i: number) => (
                        <tr key={i} className="border-t border-[#E8D5C4]/50">
                          <td className="py-1 px-2">{r.inwardDate || '—'}</td>
                          <td className="py-1 px-2">{r.supplier || '—'}</td>
                          <td className="py-1 px-2">{r.itemName}</td>
                          <td className="py-1 px-2 text-right font-mono">{r.inwardQty}</td>
                          <td className="py-1 px-2">{r.purchaseUnit}</td>
                          <td className="py-1 px-2 text-right font-mono">₹{r.rate}</td>
                          <td className="py-1 px-2 text-right font-mono">₹{r.subtotal}</td>
                          <td className="py-1 px-2 text-right font-mono font-semibold text-[#af4408]">₹{r.totalAmount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                ⚠ Once committed, the rows above (and all rows in the file) are inserted as
                purchases for the <b>currently-selected outlet</b>. Stock + recipe costs update.
                If you uploaded the wrong file, click Cancel.
              </div>
            </div>
          )}

          {/* Result */}
          {committed && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 space-y-2">
              <h3 className="text-sm font-semibold text-green-900 inline-flex items-center gap-2">
                <CheckCircle className="w-4 h-4" /> Import complete
              </h3>
              <ul className="text-xs space-y-0.5 text-green-900">
                <li>· Purchases inserted: <span className="font-mono">{committed.purchases.toLocaleString('en-IN')}</span></li>
                <li>· New materials created: <span className="font-mono">{committed.newMaterials}</span></li>
                <li>· Re-used existing materials: <span className="font-mono">{committed.reusedMaterials}</span></li>
                <li>· New vendors added: <span className="font-mono">{committed.newVendors}</span></li>
                <li>· Skipped rows: <span className="font-mono">{committed.skipped}</span></li>
                <li>· Avg-price recomputed for: <span className="font-mono">{committed.materials_touched}</span> materials</li>
              </ul>
              {committed.errors?.length > 0 && (
                <div className="text-[10px] text-amber-700">First errors: {committed.errors.slice(0,3).join(' · ')}</div>
              )}
            </div>
          )}

          {/* Unreconciled-charge popup — the sheet carries a charge column this
              system has no home for (its VAT / CESS columns, which are 0 in every
              real export so far). The row is NOT rejected: its goods value is the
              one figure we are certain of, and refusing the line would lose the
              stock as well as the charge. So the purchase lands correct-by-goods
              and the rupees we could not file are named here rather than being
              silently dropped — or, worse, silently posted into special_excise_cess
              and reported as an excise the government never levied. */}
          {committed && committed.charge_warnings?.length > 0 && (
            <div className="bg-amber-50 border-2 border-amber-300 rounded-lg p-4 space-y-2">
              <h3 className="text-sm font-semibold text-amber-900 inline-flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" /> {committed.charge_warnings.length} line(s) with a charge that could not be recorded
              </h3>
              <p className="text-[11px] text-amber-900">
                These rows <b>were imported</b>, with their correct goods-only value — stock and cost
                are right, and the charge was <b>never folded into the rate</b>. Only the amount below
                could not be filed: either the sheet carries a charge this system has no column for,
                or it charged GST on a store/TGBCL line where zero-rating wins. It is therefore
                <b> missing from Total Inward</b> on those lines. Every other charge on them
                (GST, excise / cess / TCS, delivery, round-off) was recorded normally.
              </p>
              <div className="bg-white border border-amber-200 rounded max-h-44 overflow-y-auto">
                <table className="w-full text-[10px]">
                  <thead className="bg-amber-100 text-amber-900 sticky top-0">
                    <tr>
                      <th className="text-left  py-1 px-2 font-medium">Material</th>
                      <th className="text-left  py-1 px-2 font-medium">Vendor</th>
                      <th className="text-right py-1 px-2 font-medium">Unreconciled ₹</th>
                      <th className="text-left  py-1 px-2 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {committed.charge_warnings.slice(0, 50).map((w: any, i: number) => (
                      <tr key={i} className="border-t border-amber-100">
                        <td className="py-1 px-2">{w.material || '—'}</td>
                        <td className="py-1 px-2">{w.vendor || '—'}</td>
                        {/* resid is signed — the sheet total can come in UNDER what
                            we recorded as well as over. Sign first, then the ₹, so
                            it never reads as "₹-" mid-figure. */}
                        <td className="py-1 px-2 text-right font-mono">
                          {(Number(w.unreconciled) || 0) < 0 ? '- ' : ''}
                          ₹{Math.abs(Number(w.unreconciled) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-1 px-2 text-amber-800">{w.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {committed.charge_warnings.length > 50 && (
                <div className="text-[10px] text-amber-700">…and {committed.charge_warnings.length - 50} more.</div>
              )}
            </div>
          )}

          {/* Unit-audit drift popup — when an inward row would imply a unit different
              from the locked unit-audit. The material is NOT mutated; admin should
              re-export the audit, fix it, and re-upload via /unit-audit. */}
          {committed && committed.unit_audit_warnings?.length > 0 && (
            <div className="bg-amber-50 border-2 border-amber-300 rounded-lg p-4 space-y-2">
              <h3 className="text-sm font-semibold text-amber-900 inline-flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" /> {committed.unit_audit_warnings.length} unit-audit conflict(s) — please re-upload a fixed audit
              </h3>
              <p className="text-[11px] text-amber-900">
                Some purchase rows used a different unit than the locked unit-audit.
                The materials were <b>left unchanged</b> to protect recipe costing.
                Open <a href="/unit-audit" className="underline font-semibold">Unit Audit</a>,
                click <b>Download Audit</b>, fix the listed rows, and use <b>Re-upload Audit</b>.
              </p>
              <div className="bg-white border border-amber-200 rounded max-h-44 overflow-y-auto">
                <table className="w-full text-[10px]">
                  <thead className="bg-amber-100 text-amber-900 sticky top-0">
                    <tr>
                      <th className="text-left  py-1 px-2 font-medium">Material</th>
                      <th className="text-left  py-1 px-2 font-medium">Locked unit</th>
                      <th className="text-left  py-1 px-2 font-medium">Incoming unit</th>
                      <th className="text-left  py-1 px-2 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {committed.unit_audit_warnings.slice(0, 50).map((w: any, i: number) => (
                      <tr key={i} className="border-t border-amber-100">
                        <td className="py-1 px-2">{w.material}</td>
                        <td className="py-1 px-2 font-mono">{w.locked_purchase_unit || '—'}</td>
                        <td className="py-1 px-2 font-mono">{w.incoming_purchase_unit || '—'}</td>
                        <td className="py-1 px-2 text-amber-800">{w.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {committed.unit_audit_warnings.length > 50 && (
                <div className="text-[10px] text-amber-700">…and {committed.unit_audit_warnings.length - 50} more.</div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-between gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 text-sm text-[#6B5744]">
            {committed ? 'Close' : 'Cancel'}
          </button>
          {!committed ? (
            <button onClick={commit} disabled={busy || !preview}
                    className="px-3 py-2 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {preview ? `Commit ${preview.rows} lines` : 'Pick a file first'}
            </button>
          ) : (
            <button onClick={onCommitted}
                    className="px-3 py-2 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg">
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-lg p-2">
      <p className="text-[9px] uppercase text-[#8B7355]">{label}</p>
      <p className="text-sm font-bold text-[#2D1B0E]">{value}</p>
    </div>
  );
}
