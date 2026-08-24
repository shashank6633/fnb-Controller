'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
import Link from 'next/link';
import { fmtISTDate } from '@/lib/format-date';
import {
  ShoppingCart,
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
  Receipt,
  ArrowRight,
  Upload,
  FileSpreadsheet,
  CheckCircle,
  AlertCircle,
  Download,
} from 'lucide-react';
import Papa from 'papaparse';
import type { Purchase, RawMaterial } from '@/types';
import { api } from '@/lib/api';
// THE ONLY renderer of an in-hand Store/Dept figure (CONTRACT §5). This page
// converts nothing and formats nothing: it hands the snapshot to the shared
// component, which owns toPurchaseQty() and every "not a number" wording. A
// second hand-rolled copy here is exactly how this column and the two pickers
// would come to disagree about the same material on the same afternoon.
import StockOnHandNote from '@/components/StockOnHandNote';
import type { StockOnHand, StockLeg } from '@/components/StockOnHandNote';
import { useStockOnHand } from '@/lib/use-stock-on-hand';

function formatCurrency(value: number): string {
  return '₹' + value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function todayString(): string {
  const d = new Date();
  return d.toISOString().split('T')[0];
}

/* isoMinusDays() went with the bill form's date input. src/app/grn/page.tsx
   has its own copy for the receipt-date box, which is the only date entry left. */


/* NOTE — GST_RATES, catKey(), r2(), the BillLineItem / BillFormData shapes,
   ChargeRow and emptyBill() all left with "Enter Full Bill". They existed only
   to compose a bill, and a bill is composed on /grn now (src/app/grn/page.tsx).
   Keeping dead copies here is exactly how the two forms drifted the last time
   there were two. This page reads purchase history; it does not price one. */

/**
 * Pull the PO number out of a purchase's notes.
 *
 * THIS IS A DISPLAY FALLBACK AND NOTHING ELSE. When a PO is received the receive
 * route also records the link as a SENTENCE in notes:
 *   "Received against PO-2026-0001 (GRN GRN-2026-0001)"
 * and for rows written before `purchases.po_id` existed that sentence is the only
 * trace left. Matching it is fragile by nature — reword the receive route and this
 * quietly finds nothing — so it fails CLOSED: no match renders no link, never a
 * broken one.
 *
 * IT MUST NEVER KEY AN AUDIT FIGURE (CONTRACT §0). The "Stock when PO raised"
 * column joins on the stored `purchases.po_id` alone. A regex mismatch there would
 * put a confidently wrong stock number beside a purchase, which is the exact defect
 * that column exists to prevent.
 */
/* ── ANCHORED ON THE SENTENCE, NOT ON THE SHAPE "PO-…" ─────────────────────────
 * IT USED TO BE A BARE /\bPO-[^\s)(,;]+/ ACROSS THE WHOLE NOTE, and once every
 * hand-typed bill started arriving as an ad-hoc GRN that stopped failing closed.
 * The ad-hoc mirror's note is:
 *     "Ad-hoc GRN GRN-2026-0031 · invoice <the vendor's own bill number>"
 * and the vendor's bill number is now MANDATORY and free text — so a supplier
 * whose invoice reads `PO-4471/26` produced a live link to
 * /purchase-orders?q=PO-4471%2F26 on a purchase that has no purchase order at
 * all. Verified against the real route.
 *
 * So the match is now tied to the two sentences a receive route actually writes
 * ("Received against PO-…", "PO PO-… received via GRN …"), which is what the
 * fallback was always documented to read. Anything after " · invoice " is the
 * VENDOR's text and is never parsed. Still fails CLOSED: no match, no link.
 */
const PO_IN_NOTES = /(?:Received against|^PO)\s+(PO-[^\s)(,;]+)/;
function poNumberFromNotes(notes: string | null | undefined): string | null {
  // The vendor's own bill number lives after this separator and must not be
  // read as ours, whatever it happens to look like.
  const ours = String(notes || '').split(' · invoice ')[0];
  const m = ours.match(PO_IN_NOTES);
  return m ? m[1] : null;
}

/* ══ RECORDED IN-HAND STOCK — reading the snapshot (CONTRACT §5.4 / §6) ═══════
 *
 * `/api/purchases` returns, per row:
 *   po_id        the real link (NULL for 2,145 of 2,165 rows — direct bill,
 *                opening stock, bulk import, ad-hoc GRN. NULL means "no PO".)
 *   po_number    the PO's own number, joined through po_id. Exact, not parsed.
 *   stock_at_po  the frozen `po_line_stock_snapshots` row for (po_id, material_id),
 *                or absent when that PO was raised before snapshots existed.
 *
 * FOUR STATES, and none of them may look like a number:
 *   no po_id                    → "—"            (no purchase order)
 *   po_id, no stock_at_po       → "not recorded" (rendered by StockOnHandNote)
 *   stock_at_po, dept redacted  → "Dept restricted"
 *   a recorded zero             → "Store 0 kg"   — WITH its unit, normal weight
 *
 * There is NO `?? 0` below and there must never be one. `dept_counted_qty` arrives
 * as JS null when no department ever anchored a count and stays null to the screen.
 * Quantities stay in RECIPE units the whole way here; StockOnHandNote converts once
 * through toPurchaseQty(), using the pack meta STORED IN THE SNAPSHOT — so a later
 * pack correction cannot restate what a historical audit row says.
 */

/** Strict number read. '' / null / undefined / NaN are all "we do not have it". */
const snapNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * `stores_json` / `dept_json` → legs. Accepts either the stored JSON TEXT or an
 * already-parsed array, because the column is TEXT in SQLite and a route may hand
 * back either. Returns null if ANY leg is malformed: a breakdown that does not add
 * up to its own total reads as a stock discrepancy that does not exist, and
 * StockOnHandNote drops the breakdown and prints the total alone.
 */
function snapLegs(raw: unknown): StockLeg[] | null {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(arr)) return null;
  const out: StockLeg[] = [];
  for (const r of arr) {
    const q = snapNum((r as any)?.qty);
    if (q === null) return null;
    const id = (r as any)?.id;
    out.push({
      id: id === null || id === undefined ? null : String(id),
      name: String((r as any)?.name ?? '').trim(),
      qty: q,
      inactive: (r as any)?.inactive === true,
    });
  }
  return out;
}

interface SnapshotCell {
  /** null = a snapshot IS recorded but its payload could not be read whole. */
  data: StockOnHand | null;
  takenAt: string | null;
  /** Server stripped the department rail for this viewer (CONTRACT §4.3). */
  restricted: boolean;
}

/**
 * The purchase row → the cell's state, or null when NO snapshot is recorded.
 *
 * STRICT, deliberately. `central_qty` and `store_total_qty` are the two figures an
 * auditor acts on; if either is missing or unparseable the whole entry is refused
 * (data: null → "unavailable") rather than repaired with a zero. Repairing it would
 * print a quantity nobody ever measured next to a purchase order.
 */
function snapshotFromRow(p: any): SnapshotCell | null {
  const raw = p?.stock_at_po;
  if (!raw || typeof raw !== 'object') return null;      // no snapshot → "not recorded"

  const takenAt = raw.taken_at ? String(raw.taken_at) : null;
  // Absence of the dept keys is NOT evidence of restriction — only the explicit
  // server flag is. Guessing either way mislabels a real figure.
  const restricted = raw.dept_restricted === true;

  const central = snapNum(raw.central_qty);
  const storeTotal = snapNum(raw.store_total_qty);
  if (central === null || storeTotal === null) return { data: null, takenAt, restricted };

  // Pack meta AS IT WAS when the PO was raised — never today's catalogue row, or a
  // pack correction next year would restate what this audit record says.
  const unit = String(raw.unit ?? '').trim();
  const purchaseUnit = String(raw.purchase_unit ?? '').trim();
  const packSize = snapNum(raw.pack_size);
  // A pack factor we cannot read is a 1000× error waiting to happen: defaulting it
  // to 1 would print 6,000 g under a "kg" label. Defaulting is only safe when the
  // two units are the same word — packFactor's both-halves guard forces 1 there
  // anyway (PICKLED GINGER, kg/kg pack 1.5, must render 6 kg and never 4).
  const unitsDiffer = purchaseUnit !== '' && purchaseUnit.toLowerCase() !== unit.toLowerCase();
  if (packSize === null && unitsDiffer) return { data: null, takenAt, restricted };

  const countedCount = restricted ? 0 : Math.max(0, Math.trunc(snapNum(raw.dept_counted_count) ?? 0));
  const uncountedCount = restricted ? 0 : Math.max(0, Math.trunc(snapNum(raw.dept_uncounted_count) ?? 0));
  // No anchored department = NO total. null, never 0. And a payload carrying a
  // total without a count is not trusted to mean zero either — the count is what
  // decides whether the figure exists at all.
  const countedQty = countedCount > 0 ? snapNum(raw.dept_counted_qty) : null;

  return {
    takenAt,
    restricted,
    data: {
      material_id: String(p.material_id ?? ''),
      unit,
      purchase_unit: purchaseUnit,
      pack_size: packSize ?? 1,
      case_size: snapNum(raw.case_size) ?? 1,
      central_qty: central,
      // stores_json already carries the Grocery leg; StockOnHandNote adds one only
      // when it is absent, so nothing is counted twice.
      stores: snapLegs(raw.stores_json ?? raw.stores) ?? [],
      store_total_qty: storeTotal,
      store_mapped: raw.store_mapped === true || raw.store_mapped === 1,
      depts: restricted ? [] : (snapLegs(raw.dept_json ?? raw.depts) ?? []),
      dept_counted_qty: countedQty,
      dept_counted_count: countedCount,
      dept_uncounted_count: uncountedCount,
    },
  };
}

export default function PurchasesPage() {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  /* NOTE — the vendor master, the store-category set, matUnits(), recipeHint()
     and caseBasis() left with "Enter Full Bill". Every one of them existed to
     LABEL or PRICE a line being typed; this page reads finished rows, and
     /api/purchases already returns them pack-aware. src/app/grn/page.tsx now
     holds the live copies. */
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  /** Vendor picked in the Vendor filter. '' = every vendor. Exact match on the
   *  name, unlike the free-text box which matches material/vendor/brand loosely
   *  — a buyer reconciling one supplier's bills needs "this vendor and nothing
   *  else", which a substring search cannot promise (searching "SRI" also
   *  returns SRI SAI and SRINIVAS). */
  const [vendorFilter, setVendorFilter] = useState('');
  const [appliedFilters, setAppliedFilters] = useState({ search: '', from: '', to: '', vendor: '' });
  /** Bills recorded but NOT yet on this register — held for a kitchen check.
   *  Date + value only; see fetchHeldBills for why they are disclosed here. */
  const [heldBills, setHeldBills] = useState<Array<{ date: string; value: number }>>([]);

  // Sort
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Modal

  // Toast
  const [toast, setToast] = useState<string | null>(null);
  // Backdate limit (configurable) + admin exemption. Server is the real guard;
  // this now drives ONLY the admin editor below — the date-input min/max it also
  // fed went with the bill form, and /grn derives its own from the same setting.
  const [backdateLimit, setBackdateLimit] = useState(3);
  const [isAdmin, setIsAdmin] = useState(false);
  const [limitInput, setLimitInput] = useState('3');
  const [limitSaving, setLimitSaving] = useState(false);
  const [limitSaved, setLimitSaved] = useState(false);

  /* The backdate limit is still edited here, by an admin, even though bills are
     entered on /grn. It is a SETTING (purchase_backdate_limit_days), not a bill
     field, and both receiving forms read the same key — /grn's ad-hoc modal
     fetches it on mount and checkPurchaseDate() enforces it server-side on every
     receiving route. Moving the editor to /grn would only hide it from the admin
     who looks for it beside the purchase register. */

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
      discount: any; cgst: any; sgst: any; compensation_cess: any; special_excise_cess: any; tcs: any; delivery_charges: any; mrp_round_off: any;
      kind: string; reason: string;
    }>;
  } | null>(null);

  // Build a re-uploadable CSV of the rows that did NOT import (fix + re-upload
  // just these). Same columns as the Bulk template + a reason column.
  const downloadSkippedRows = () => {
    const rows = bulkResult?.skipped_rows || [];
    if (rows.length === 0) return;
    // Must mirror the Bulk template's columns (incl. ALL EIGHT charges the
    // server echoes back) so fix-and-re-upload never silently zeroes a charge.
    // compensation_cess was missed when it was added as the 8th charge, so a
    // skipped row lost its cess on the way back out — the recovery file is the
    // one path where a dropped column is invisible, because the uploader is
    // re-uploading what they believe is their own data. If a ninth charge is
    // ever added, it belongs in THREE places: the template, the server echo,
    // and here.
    const header = ['date', 'vendor', 'bill_no', 'category_name', 'sku', 'item_name',
      'po_qty', 'quantity', 'purchase_unit', 'unit_price', 'total_amount',
      'discount', 'cgst', 'sgst', 'compensation_cess', 'special_excise_cess', 'tcs',
      'delivery_charges', 'mrp_round_off',
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
       r.discount, r.cgst, r.sgst, r.compensation_cess, r.special_excise_cess, r.tcs,
       r.delivery_charges, r.mrp_round_off,
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

  /* ── THE BILLS THIS REGISTER CANNOT SEE YET ────────────────────────────────
   * A QC-held delivery is a recorded bill with NO `purchases` row: the cost is
   * booked at sign-off, hours or days later. So this page — which the notice
   * above calls "the record and the reports" — is silently short by every bill
   * still in the kitchen queue, and its Total Spend card and any month-end
   * figure pulled before the queue drains are LOW and will quietly correct
   * themselves afterwards (the sign-off books against the RECEIPT date, so the
   * money lands back in the period it belonged to).
   *
   * That is the right accounting and the wrong silence. This reads the same
   * queue the bell reads and states the gap in the same breath as the numbers.
   * FAILS SILENT, NOT LOUD: any error leaves the banner hidden rather than
   * putting a scary red box on the register — a missing disclosure is a smaller
   * harm here than a broken-looking page, and nothing on this screen depends on
   * it. Fetched once with the rest; the queue moves in hours, not seconds.
   */
  const fetchHeldBills = async () => {
    try {
      const res = await fetch('/api/grn/qc');
      if (!res.ok) return;
      const json = await res.json();
      const rows = Array.isArray(json?.rows) ? json.rows : [];
      setHeldBills(rows.map((r: any) => ({
        date: String(r.date || ''),
        value: Number(r.held_value) || 0,
      })));
    } catch { /* disclosure only — never break the register over it */ }
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

  /* NOTE — fetchVendors(), fetchStoreCategories(), storeMappedLine(),
     seedGstForMaterial() and seedCessForMaterial() left with "Enter Full Bill".
     They read the vendor master and the store-category map to SEED and
     ZERO-RATE a line being typed. src/app/grn/page.tsx holds them now, verbatim,
     and is the only place that needs them. */

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
      // The vendor master and the store-category map are no longer fetched here:
      // both were read only to compose a bill. `materials` stays — the CSV
      // preview and the Recaho import still resolve names against it.
      await Promise.all([
        fetchPurchases(), fetchMaterials(), fetchBackdateConfig(), fetchHeldBills(),
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
    const filters = { search: searchTerm, from: dateFrom, to: dateTo, vendor: vendorFilter };
    setAppliedFilters(filters);
    setPage(1);
    fetchPurchases(filters);
  };

  // Filter purchases by search term client-side (API doesn't support text search)
  const filteredPurchases = purchases.filter((p) => {
    // Vendor first, and it is an EXACT name match, not a substring: the point of
    // this filter is "this supplier's bills and no one else's". Compared
    // case- and space-insensitively because the same vendor reaches these rows
    // from three places — the bill modal's picker, the CSV importer and the
    // Recaho inward import — and they do not agree on trailing spaces or case.
    if (appliedFilters.vendor) {
      const want = appliedFilters.vendor.trim().toLowerCase();
      if ((p.vendor || '').trim().toLowerCase() !== want) return false;
    }
    if (!appliedFilters.search) return true;
    const term = appliedFilters.search.toLowerCase();
    return (
      (p.material_name || '').toLowerCase().includes(term) ||
      p.vendor.toLowerCase().includes(term) ||
      p.brand.toLowerCase().includes(term)
    );
  });

  /* Options come from the vendors actually PRESENT in the loaded rows, not from
   * the vendor master. The master would offer suppliers with nothing to show in
   * this window, and would silently omit any vendor that has been deactivated
   * since — or that arrived as free text through an import and was never in the
   * master at all. Every option here is guaranteed to return rows. */
  const vendorOptions = Array.from(
    new Set(purchases.map((p) => (p.vendor || '').trim()).filter(Boolean)),
  ).sort((x, y) => x.localeCompare(y));

  // Sort
  const sortedPurchases = [...filteredPurchases].sort((a, b) => {
    const cmp = a.date.localeCompare(b.date);
    return sortDir === 'desc' ? -cmp : cmp;
  });

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sortedPurchases.length / pageSize));
  const paginatedPurchases = sortedPurchases.slice((page - 1) * pageSize, page * pageSize);

  /* ── "Stock when PO raised": why the Dept half can read "not counted" ───────
   *
   * A department figure is only ever "not counted" for one reason worth putting a
   * banner up for: the department ledger cutover has never been run, so NO pair
   * has an opening balance and every department balance in the building is
   * legitimately unknown. CONTRACT §5.4 wants that said once, above the table,
   * rather than left to read as a bug in this column.
   *
   * The cutover stamp lives on GET /api/stock-on-hand, which returns the whole
   * catalogue. Downloading it to learn ONE scalar is waste, so the fetch is gated:
   * it fires only once a snapshot with an uncounted department rail is actually on
   * screen — i.e. only when there is something for the banner to explain. On
   * today's data (no snapshots yet) it never fires at all.
   *
   * Cheap test, no parsing: the explicit dept_restricted rows are excluded because
   * those read "Dept restricted", which the banner does not explain.
   */
  const cutoverBannerRelevant = useMemo(
    () =>
      purchases.some((p: any) => {
        const s = p?.stock_at_po;
        return (
          !!p?.po_id && !!s && typeof s === 'object' && s.dept_restricted !== true &&
          Math.trunc(Number(s.dept_counted_count) || 0) === 0
        );
      }),
    [purchases],
  );
  const liveStock = useStockOnHand(cutoverBannerRelevant);
  // cutoverKnown gates the claim: an endpoint that 404s or errors leaves cutoverAt
  // null too, and asserting "cutover has never been run" off a failed fetch would
  // be a guess. No banner is the honest render when we do not know.
  const showCutoverBanner =
    cutoverBannerRelevant && liveStock.cutoverKnown && liveStock.cutoverAt === null;

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

  /* ══ THIS PAGE NO LONGER WRITES A PURCHASE ═══════════════════════════════
   *
   * "Enter Full Bill" and its handlers (openBillModal, updateBillLine, the
   * duplicate-line panel, the vendor<->item panel, billCalc and handleBillSubmit)
   * were removed with the button, and the single-line "Add Purchase" form before
   * them. Both wrote a `purchases` row DIRECTLY — that route's own comment says a
   * purchase "writes STRAIGHT to stock and to updateMaterialPrice" — with no
   * Kitchen QC gate, no inward register, no void, no line-edit and, for the
   * ad-hoc shape, no duplicate-bill refusal.
   *
   * A hand-typed vendor bill is recorded on /grn now, which inherits all five by
   * construction rather than by a second implementation. The whole capability
   * moved, field for field: vendor, invoice number and invoice date, bill-level
   * Discount and Delivery split across the lines, per-line GST and compensation
   * cess, the BTL/CASE entry mode, brand, and the goods -> discount -> taxable ->
   * tax -> incl-tax reading across.
   *
   * ⚠ DO NOT PUT A BILL FORM BACK ON THIS PAGE, in any shape. That is the mistake
   *   this codebase has already paid for: two forms writing one row drift, and
   *   the CASE/BTL entry-mode bug had to be found and fixed once per form. There
   *   is ONE writer. If a bill needs a field it does not accept, add it to
   *   POST /api/grn and to src/app/grn/page.tsx.
   *
   * WHAT IS STILL WRITTEN FROM HERE, and none of it is bill entry:
   *   · Generic CSV Upload      -> POST /api/purchases/bulk
   *   · Upload Opening Stock    -> POST /api/purchases/opening-stock
   *   · Recaho inward import    -> POST /api/inward-import/commit
   * Each is a separate route with its own INSERT; none passed through
   * POST /api/purchases, and none is touched by the move.
   */

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
            {/* ══ WHERE "ENTER FULL BILL" WENT ═══════════════════════════════
                This page no longer creates purchase rows. A hand-typed vendor
                bill is now recorded on /grn as a goods receipt, so it inherits —
                automatically, not by a second implementation — the Kitchen QC
                gate, the inward register, void, line-edit and the duplicate-bill
                refusal, none of which this screen ever had. Its own route said
                what it did: a purchase "writes STRAIGHT to stock and to
                updateMaterialPrice", with no QC gate at all.

                THE BUTTON IS STILL HERE, and it still says the words a
                storekeeper is looking for. It is a LINK now, not a form: somebody
                who has pressed this every morning must land on the right screen,
                not be told a feature moved and left to hunt for it. The bulk CSV
                and Opening Stock buttons beside it stay exactly where they are.

                ?new=1 OPENS THE FORM. Without it this landed on the GRN LIST,
                where the storekeeper had to find and press a SECOND button with
                the identical label — a page navigation and an extra click added
                to the job they do every morning, on the one screen whose whole
                purpose is that they use it instead of the ungated CSV beside it.
                /grn reads the flag once on mount and strips it from the URL. */}
            <Link
              href="/grn?new=1"
              title="Vendor bills are recorded on Goods Receipt Notes now — same form, plus the kitchen quality check, the inward register, void and line-edit."
              className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Receipt className="w-4 h-4" />
              Enter Vendor Bill
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>

        {/* Said in full where the button used to be, because the button alone
            cannot explain a hold that has not happened yet. Whoever entered
            bills here needs BOTH facts before their next delivery: where the
            form lives, and that perishables no longer inward on the spot. */}
        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-4 flex flex-col sm:flex-row sm:items-start gap-3">
          <div className="p-2 rounded-lg bg-[#af4408]/10 shrink-0 self-start">
            <Receipt className="w-4 h-4 text-[#af4408]" />
          </div>
          <div className="flex-1 space-y-1.5">
            <p className="text-sm font-semibold text-[#2D1B0E]">
              Bills are entered on Goods Receipt Notes now. This page is the record and the reports.
            </p>
            <p className="text-xs text-[#6B5744] leading-relaxed">
              Everything the old <b>Enter Full Bill</b> form did is on <Link href="/grn?new=1" className="text-[#af4408] font-medium hover:underline">Goods Receipt Notes</Link>:
              the vendor and invoice number, the invoice date, bill-level Discount and Delivery split across the lines,
              per-line GST and cess, BTL / CASE entry, and brand — plus a tick for the cash buy that came with no bill number
              at all. It adds what this screen never had — the receipt can be voided or line-edited, and it lands on the
              inward register. If the same vendor and bill number are entered twice on one day it is refused outright;
              on a different day it asks first, because plenty of suppliers reuse the same number on every slip.
            </p>
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-300 rounded px-2 py-1.5 leading-relaxed">
              <b>One thing genuinely changes at the bay:</b> a bill carrying perishables — veg, meat, dairy, frozen, fruit —
              is saved in full but <b>no stock appears until the kitchen checks it</b>. The bill is not lost and nothing needs
              re-typing; the goods wait, which is what lets the vendor still take them back. The GRN screen says so before you
              save and again after. <b>Until it is signed off that bill is on the GRN screen, not on this register</b> — this
              page lists booked cost, so a delivery still waiting for the kitchen has not reached it yet.
            </p>
            <p className="text-xs text-[#6B5744]">
              Still here, unchanged: the register and its filters, the exports, the Goods value vs Total amount split,
              <b> Generic CSV Upload</b> and <b>Upload Opening Stock</b>. The CSV is for backfilling and correcting in bulk,
              not for the day&rsquo;s bill — and it holds to the same rule: a perishable line is declined there with a note
              telling you to enter that bill on Goods Receipt Notes, so the kitchen check cannot be sidestepped by uploading
              instead of typing.
            </p>
          </div>
        </div>

        {/* ══ BILLS RECORDED BUT NOT YET ON THIS REGISTER ═══════════════════
            A held delivery has a GRN and no `purchases` row until the kitchen
            signs, so every figure below it — the spend cards, the exports, any
            month-end total — is short by exactly this much and will grow later
            without anyone touching it. Scoped to the SAME from/to the register
            is filtered by, because a period total is what someone reconciles.
            Rendered only when there is something to disclose. */}
        {(() => {
          const inRange = heldBills.filter(h => {
            if (appliedFilters.from && h.date < appliedFilters.from) return false;
            if (appliedFilters.to && h.date > appliedFilters.to) return false;
            return true;
          });
          if (inRange.length === 0) return null;
          const value = inRange.reduce((s, h) => s + h.value, 0);
          const ranged = !!(appliedFilters.from || appliedFilters.to);
          return (
            <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 text-xs text-amber-900">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span className="flex-1 leading-relaxed">
                <b>{inRange.length} vendor {inRange.length === 1 ? 'bill is' : 'bills are'} recorded but not on this register yet</b>
                {ranged ? ' in the dates you have filtered to' : ''} — about <b>{formatCurrency(value)}</b> of goods
                waiting for a kitchen check. Their cost is booked when the check is signed, against the delivery date,
                so the totals on this page will rise for dates already past. Read a period total only once the queue is clear.
              </span>
              <Link href="/grn/qc" className="shrink-0 font-medium underline hover:no-underline">Open the check queue</Link>
            </div>
          );
        })()}

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
            {/* Vendor — exact match, options drawn from the rows on screen so
                every choice returns something. Sits before the dates because
                "whose bills" is the question asked first when reconciling. */}
            <div className="w-full sm:w-52">
              <label className="block text-xs text-[#8B7355] mb-1">Vendor</label>
              <select
                value={vendorFilter}
                onChange={(e) => setVendorFilter(e.target.value)}
                className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408] focus:border-transparent"
              >
                <option value="">All vendors</option>
                {vendorOptions.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
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
              title="Download all purchases below as Excel (matches your current vendor / search / date filters)"
            >
              <Download className="w-4 h-4" />
              Export ({sortedPurchases.length})
            </button>
          </div>
        </div>

        {/* CONTRACT §5.4 — said once, above the table, not per row. Without it a
            whole column of "Dept not counted" reads as a broken feature instead of
            an unopened ledger. */}
        {showCutoverBanner && (
          <div className="flex items-start gap-2 rounded-xl border border-[#E8D5C4] bg-[#FFF1E3] px-4 py-3 text-xs text-[#6B5744]">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-[#af4408]" />
            <p>
              Department stock has never been opened (no cutover run), so every department
              figure reads &quot;not counted&quot;. Run Inventory → Department Ledger → Cutover
              to start recording it.
            </p>
          </div>
        )}

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
                  <th className="text-left py-3 px-4 font-medium" title="The purchase order this bill was received against, when it came from one">PO No</th>
                  <th className="text-left py-3 px-4 font-medium" title="The goods receipt this bill came in on. Read from the real grn_id link, not from notes text. Blank for purchases that never went through a GRN — imports and direct bills.">GRN No</th>
                  <th
                    className="text-left py-3 px-4 font-medium whitespace-nowrap"
                    title="The Store and Department stock recorded at the moment this purchase order was raised. Blank or 'not recorded' means no figure was stored for this line; the reason is not something this column can know."
                  >
                    Stock when PO raised
                  </th>
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
                    <td className="py-3 px-4">
                      {(() => {
                        // The STORED link wins. `po_number` reaches this row through
                        // purchases.po_id -> purchase_orders, so it is the PO this
                        // bill was actually received against — not a number scraped
                        // out of a sentence. The notes parse stays only as the
                        // fallback for rows written before po_id existed, and it
                        // still fails closed.
                        const linked = String((p as any).po_number || '').trim();
                        const po = linked || poNumberFromNotes(p.notes);
                        if (!po) return <span className="text-[#8B7355]">-</span>;
                        // Deep-links into the PO list's existing "PO number or
                        // vendor" search, because there is no
                        // /purchase-orders/[id] detail page to open.
                        return (
                          <a
                            href={`/purchase-orders?q=${encodeURIComponent(po)}`}
                            title={
                              linked
                                ? `Open ${po} on Purchase Orders — linked by purchase order id`
                                : `Open ${po} on Purchase Orders — read from this bill's notes, not a stored link`
                            }
                            className={`hover:underline font-mono text-xs whitespace-nowrap ${
                              linked ? 'text-[#af4408]' : 'text-[#af4408]/80 decoration-dotted underline-offset-2 underline'
                            }`}
                          >
                            {po}
                          </a>
                        );
                      })()}
                    </td>
                    <td className="py-3 px-4">
                      {/* The one identifier a received row always has. Invoice ID is
                          blank on GRN rows and Bill No is blank on the ad-hoc ones,
                          so this is what gets you back to the paperwork. A real FK,
                          so unlike PO No it cannot be broken by a wording change. */}
                      {(p as any).grn_number
                        ? <span className="font-mono text-xs whitespace-nowrap text-[#2D1B0E]">{(p as any).grn_number}</span>
                        : <span className="text-[#8B7355]">-</span>}
                    </td>
                    {/* ── Recorded In-Hand Stock (CONTRACT §5.4 / §6) ──────────
                        Keyed ONLY on the stored po_id. Never on the notes parse:
                        a text mismatch would put a confidently wrong stock figure
                        beside a purchase, and a wrong audit number is worse than
                        no column at all. */}
                    <td className="py-3 px-4 align-top">
                      {(() => {
                        if (!(p as any).po_id) {
                          return (
                            <span className="text-[#8B7355]" title="No stock record for this bill. purchases.po_id is written by the boot migration, not at receive time, so a bill received since the last restart has no link yet even when the PO No column beside this one shows a number - that number is read from the notes text on the row itself.">
                              —
                            </span>
                          );
                        }
                        const snap = snapshotFromRow(p);
                        // No snapshot row: this PO was raised before the record
                        // existed. StockOnHandNote prints "not recorded" — grey,
                        // italic, wordy, so it cannot read as a quantity.
                        if (!snap) return <StockOnHandNote variant="cell" />;
                        if (!snap.data) {
                          // A snapshot IS on file but its payload could not be read
                          // whole. Saying "not recorded" here would be a false claim
                          // about the past, and printing a repaired zero would be a
                          // false claim about the stock. Say neither.
                          return (
                            <span
                              className="text-[11px] italic text-[#B8A590]"
                              title="A stock snapshot is recorded for this PO line but could not be read. Nothing is shown rather than a repaired figure."
                            >
                              unavailable
                            </span>
                          );
                        }
                        return (
                          <StockOnHandNote
                            variant="cell"
                            data={snap.data}
                            deptScope={snap.restricted ? 'none' : 'all'}
                            asOf={snap.takenAt}
                            poNumber={String((p as any).po_number || '').trim() || null}
                          />
                        );
                      })()}
                    </td>
                    <td className="py-3 px-4 text-[#8B7355] max-w-[200px] truncate">
                      {p.notes || '-'}
                    </td>
                  </tr>
                ))}
                {paginatedPurchases.length === 0 && (
                  <tr>
                    {/* 14, matching the header row above. It was 13, so the
                        empty state sat one column short of the table. */}
                    <td colSpan={14} className="py-12 text-center text-[#8B7355]">
                      <ShoppingCart className="w-10 h-10 mx-auto mb-3 opacity-40" />
                      <p>No purchases found.</p>
                      {/* This page cannot add one any more, so it must not ask.
                          A delivery still waiting for a kitchen check is not
                          here yet either, which is the likelier surprise. */}
                      <p className="text-xs mt-1">
                        Vendor bills are recorded on{' '}
                        <Link href="/grn?new=1" className="text-[#af4408] font-medium hover:underline">Goods Receipt Notes</Link>
                        {' '}— and a bill still waiting for its kitchen check appears here only once it is signed off.
                      </p>
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
      {/* NOTE: the amber "Bill saved — N things to know" panel left with the bill
          form. The vendor↔item warnings it rendered come back on the server's
          `vendor_mapping[]` and are shown by /grn, where the bill is now saved. */}
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
                      // Sheet rows go to POST /api/purchases/bulk verbatim. That route
                      // REJECTS a row whose `purchase_unit` column disagrees with the
                      // material's configured purchase unit (bulk/route.ts:288-296) and
                      // then does toStockQty(mat, quantity) = qty × pack_size to credit
                      // stock — so `quantity` is purchase units by contract, and
                      // `unit_price` is what lands in purchases.unit_price (₹/purchase
                      // unit). total_amount is the charge-free qty × rate, same basis.
                      // rate-basis: purchase
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
                              {/* Same pair as the Subtotal roll-up above: the Qty header
                                  declares purchase units and the Unit Price header
                                  declares ₹ per purchase unit, which is the contract
                                  /api/purchases/bulk verifies and stores. */}
                              {/* rate-basis: purchase */}
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
                        {/* This header was missing, so all three money cells printed one
                            column to the left and the RATE appeared under "Subtotal" — a
                            5-BTL @ ₹180 line read as ₹180 of value instead of ₹900. */}
                        <th className="text-right py-1 px-2 font-medium" title="₹ per PURCHASE unit — the vendor's rate. Same basis as the Qty beside it (purchase units), so Qty × Rate = Subtotal.">Rate</th>
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
