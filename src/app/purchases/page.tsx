'use client';

import { useEffect, useState, useRef } from 'react';
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
} from 'lucide-react';
import Papa from 'papaparse';
import type { Purchase, RawMaterial } from '@/types';
import { api } from '@/lib/api';
import MaterialTypeahead from '@/components/MaterialTypeahead';
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
  notes: '',
  items: [emptyBillLine(), emptyBillLine()],
};

export default function PurchasesPage() {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
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
      await Promise.all([fetchPurchases(), fetchMaterials(), fetchBackdateConfig()]);
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
      items: prev.items.map((item) =>
        item.id === id ? { ...item, [field]: value } : item
      ),
    }));
  };

  // Calculate bill totals and split the two bill-level charges across the lines.
  // No GST anywhere on this path: Discount is netted OFF each line rate, Delivery
  // is carried per line for reporting only, and unit_price stays the goods rate.
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

    // What you actually pay the vendor. Delivery is part of the bill total but NOT
    // of the goods cost — see the per-line split below.
    const grandTotal = Math.round((subtotal - discountAmount + deliveryAmount) * 100) / 100;

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
      const finalUnitPrice = qty > 0 ? Math.round(netTotal / qty * 100) / 100 : 0;
      return { ...item, discount_share: discountShare, delivery_share: deliveryShare, final_unit_price: finalUnitPrice };
    });

    return { items: pricedItems, subtotal, discountAmount, deliveryAmount, grandTotal, discountClamped };
  })();

  const handleBillSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBillError(null);

    if (!billData.vendor.trim()) {
      setBillError('Vendor name is required.');
      return;
    }
    if (!billData.date) {
      setBillError('Date is required.');
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
          notes: [`Bill #${billData.bill_number || 'N/A'}`,
                  item.discount_share > 0 ? `Discount ₹${item.discount_share} (netted off rate)` : '',
                  item.delivery_share > 0 ? `Delivery ₹${item.delivery_share} (not in rate)` : '',
                  billData.notes, ...noteExtras].filter(Boolean).join(' | '),
        };

        const res = await api('/api/purchases', {
          method: 'POST',
          body: body,
        });

        if (!res.ok) {
          const errJson = await res.json().catch(() => null);
          throw new Error(errJson?.error || `Failed to add purchase for item`);
        }
      }

      setBillModalOpen(false);
      setBillData({ ...emptyBill });
      await fetchPurchases(appliedFilters);
      setToast(`Bill entered: ${validItems.length} items from ${billData.vendor} added!`);
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
      const tcs = num(r.tcs ?? r.TCS);
      const deliveryCharges = num(r.delivery_charges ?? r['DELIVERY CHARGES'] ?? r.delivery ?? r.Delivery);
      const mrpRoundOff = num(r.mrp_round_off ?? r['MRP ROUND OFF'] ?? r.mrp_rounding ?? r['MRP Round Off']);

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
      const chargeBlock = -discount + cgst + sgst + specialExciseCess + tcs + deliveryCharges + mrpRoundOff;
      let finalUnitPrice = unitPrice;
      if (finalUnitPrice === 0 && quantity > 0) {
        const base = totalAmount > 0 ? totalAmount
          : (totalInward !== 0 ? totalInward - chargeBlock : 0);
        if (base > 0) finalUnitPrice = Math.round(((base + gstAmount) / quantity) * 100) / 100;
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
        discount, cgst, sgst, special_excise_cess: specialExciseCess,
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
      'discount', 'cgst', 'sgst', 'special_excise_cess', 'tcs', 'delivery_charges', 'mrp_round_off',
      'total_inward_amount', 'brand', 'gst_amount', 'notes'];
    const unitOf = (m: any) => String(m?.purchase_unit || m?.unit || '').trim();
    const rows = [
      {
        date: todayString(), vendor: 'ABC Traders', bill_no: 'ABC/2026/117',
        category_name: ex1?.category || '', sku: ex1?.sku || '', item_name: ex1?.name || 'Tomato',
        po_qty: 10, quantity: 10, purchase_unit: unitOf(ex1) || 'kg', unit_price: 25, total_amount: 250,
        discount: '', cgst: '', sgst: '', special_excise_cess: '', tcs: '', delivery_charges: '', mrp_round_off: '',
        total_inward_amount: '', brand: '', gst_amount: '',
        notes: 'SAMPLE — delete before uploading',
      },
      {
        date: todayString(), vendor: 'XYZ Supplies', bill_no: 'XYZ-8842',
        category_name: ex2?.category || '', sku: ex2?.sku || '', item_name: ex2?.name || 'Refined Oil',
        po_qty: 5, quantity: 5, purchase_unit: unitOf(ex2) || 'L', unit_price: 180, total_amount: 900,
        discount: 50, cgst: 45, sgst: 45, special_excise_cess: '', tcs: '', delivery_charges: 30, mrp_round_off: '',
        total_inward_amount: 970, brand: '', gst_amount: '',
        notes: 'SAMPLE — 900 − 50 + 45 + 45 + 30 = 970 total inward; rate stays 180',
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
      ['total_amount', 'optional', 'SUBTOTAL — the CHARGE-FREE line amount (qty × rate). If given without unit_price: unit_price = (total_amount + gst_amount) ÷ quantity. Do NOT put the charge-inclusive Total Inward here.'],
      ['gst_amount', 'optional', '₹ GST for the line. Folded into the effective unit price.'],
      ['vendor', 'optional', 'Supplier name.'],
      ['bill_no', 'optional', "The VENDOR's own bill number, as printed on the bill they give you (aliases: bill_number, invoice_no, INVOICE ID). Part of the duplicate check — the same bill re-uploaded is skipped, but two different bills are both kept. Do NOT put our Invoice ID here."],
      ['(Invoice ID)', 'AUTO', 'NOT a column — our own system number (PINV-2026-0001) is generated automatically on upload. Lines sharing the same vendor + bill_no + date get ONE Invoice ID.'],
      ['discount / cgst / sgst / special_excise_cess / tcs / delivery_charges / mrp_round_off', 'optional', '₹ per-line charges (GRN-Inward format). RECORDED ONLY — they do NOT change the unit cost/weighted-average. Total Inward = (qty × rate) − discount + cgst + sgst + cess + tcs + delivery + mrp_round_off. Leave blank/0 if not applicable. mrp_round_off may be negative.'],
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
                        const c = (k: string) => Number((p as any)[k]) || 0;
                        const charges = -c('discount') + c('cgst') + c('sgst') + c('special_excise_cess') + c('tcs') + c('delivery_charges') + c('mrp_round_off');
                        if (charges === 0) return <span className="text-[#8B7355]">—</span>;
                        return <span className="text-[#af4408] font-medium">{formatCurrency((Number(p.total_price) || 0) + charges)}</span>;
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
          <div style={{ maxHeight: 'none' }} className="relative w-full max-w-4xl bg-white rounded-2xl shadow-xl border border-[#E8D5C4] mx-4">
            {/* Bill Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4]">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-[#af4408]/10">
                  <Receipt className="w-5 h-5 text-[#af4408]" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[#2D1B0E]">Enter Full Bill</h2>
                  <p className="text-xs text-[#8B7355]">One vendor bill, many items — Delivery &amp; Discount auto-split across the lines. Enter each rate as the plain goods rate (no tax added in).</p>
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
                  <input
                    type="text"
                    value={billData.vendor}
                    onChange={(e) => updateBillField('vendor', e.target.value)}
                    placeholder="Vendor name"
                    className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] placeholder-[#8B7355] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
                    required
                  />
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

                {/* Entry convention reminder */}
                <div className="text-[11px] text-[#6B5744] bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 mb-2">
                  <span className="font-semibold text-amber-900">Default: enter at bottle level.</span>
                  &nbsp;1 case of 12 bottles → qty = <code>12</code> (BTL), unit price per bottle.
                  &nbsp;<span className="text-amber-900">Want to type cases instead?</span> If the material has a <code>case_size</code>
                  set in inventory, a <strong>BTL / CASE</strong> toggle appears next to the qty input — pick CASE and type the case count + per-case price.
                </div>
                <div className="overflow-x-auto rounded-xl border border-[#E8D5C4]">
                  <table className="w-full text-sm block md:table">
                    <thead className="bg-[#FFF1E3] hidden md:table-header-group">
                      <tr className="text-[#6B5744]">
                        <th className="text-left py-2.5 px-3 font-medium w-[30%]">Material *</th>
                        <th className="text-left py-2.5 px-3 font-medium w-[12%]">Brand</th>
                        {/* These two headers used to be hard-coded "(bottles)" and
                            "/btl" — true for a liquor bill, plain wrong for the kg /
                            L / PKT lines that make up most of a grocery bill. Both
                            columns are the material's own PURCHASE unit, printed
                            per line under each box. */}
                        <th className="text-right py-2.5 px-3 font-medium w-[10%]" title="In the material's purchase unit — bottles / kg / L / PKT (not cases, unless you switch the line to CASE)">Qty * <span className="text-[10px] font-normal text-[#8B7355]">(purchase units)</span></th>
                        <th className="text-right py-2.5 px-3 font-medium w-[12%]" title="Vendor rate per purchase unit (per bottle / per kg / per L)">Unit Price (₹) * <span className="text-[10px] font-normal text-[#8B7355]">/ purchase unit</span></th>
                        <th className="text-right py-2.5 px-3 font-medium w-[10%]">Line Total</th>
                        <th className="text-right py-2.5 px-3 font-medium w-[10%]">Discount</th>
                        <th className="text-right py-2.5 px-3 font-medium w-[12%]">Final Unit ₹</th>
                        <th className="py-2.5 px-2 w-8"></th>
                      </tr>
                    </thead>
                    <tbody className="block md:table-row-group">
                      {billCalc.items.map((item, idx) => (
                        <tr key={item.id} className="border-t border-[#E8D5C4]/50 block md:table-row rounded-lg border border-[#E8D5C4] p-3 mb-2 space-y-2 md:p-0 md:mb-0 md:border-0 md:border-t md:space-y-0">
                          <td className="py-2 px-2 block md:table-cell">
                            <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Material</span>
                            <MaterialTypeahead
                              materials={materials as any} purchaseBasis
                              value={item.material_id}
                              onPick={(id) => updateBillLine(item.id, 'material_id', id)}
                            />
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
                          <td className="py-2 px-3 text-right text-xs font-mono font-semibold text-[#af4408] block md:table-cell">
                            <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Final Unit ₹</span>
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
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
                  <div>
                    <p className="text-xs text-[#8B7355] mb-0.5">Items Subtotal</p>
                    <p className="text-lg font-bold text-[#2D1B0E]">{formatCurrency(billCalc.subtotal)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[#8B7355] mb-0.5">Discount</p>
                    <p className="text-lg font-bold text-emerald-700">- {formatCurrency(billCalc.discountAmount)}</p>
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
                  Final Unit Price = (Line Total − Discount Share) ÷ Qty, and that is what is stored as the purchase price
                  (case-mode lines are stored per bottle, expanded by case size: rate ÷ case size against qty × case size) —
                  so a discount lowers item cost while delivery is recorded on the bill without changing it.
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
                        <th className="text-right py-1 px-2 font-medium">Rate</th>
                        <th className="text-right py-1 px-2 font-medium">Total</th>
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
                          <td className="py-1 px-2 text-right font-mono">₹{r.totalAmount}</td>
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
