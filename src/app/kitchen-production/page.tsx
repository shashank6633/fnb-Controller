'use client';

/**
 * Kitchen Production — prepared-item batch tracking.
 *
 * The kitchen "produces" a batch of a prepared item (e.g. Chicken Gravy) and
 * logs it here. Each batch auto-gets a Batch Number + Barcode (server-side) and
 * carries an expiry. This screen lets the kitchen:
 *   - Record a New Production Batch (modal with every field; batch#/barcode auto)
 *   - See ACTIVE batches as colour-coded cards (green safe / amber near-expiry /
 *     red expired) with a FIFO badge marking the oldest batch of each item
 *   - Open a batch to view its details + full transaction history
 *
 * Data model + API were built in stage A. This page only talks to:
 *   GET  /api/kitchen-production?status=&category=&search=
 *   POST /api/kitchen-production
 *   GET  /api/kitchen-production/[id]
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ChefHat, Plus, Loader2, RefreshCw, Search, X, Package, Clock, MapPin,
  User as UserIcon, AlertTriangle, CheckCircle2, History, Barcode as BarcodeIcon,
  Printer, Settings, Eye, Copy, CheckSquare, Square, Save, CheckCircle, ScanLine,
  LayoutGrid, BarChart3, Trash2, Send, Undo2,
} from 'lucide-react';
import { api } from '@/lib/api';
import { fmtIST, fmtISTDate, todayIST, fmtISTIsoDate } from '@/lib/format-date';
import { parseDateTime } from '@/lib/production-batch';
import { bridgePrint } from '@/lib/offline-print/bridge-client';
import { labelPreview, LABEL_FIELD_KEYS } from '@/lib/tspl-label';
import type { LabelPrinterConfig, LabelBatch, LabelFieldKey } from '@/lib/tspl-label';
import LabelCanvas from '@/components/LabelCanvas';

// Representative batch used to render the live label-design preview.
const SAMPLE_LABEL_BATCH: LabelBatch = {
  item_name: 'Chicken Gravy',
  batch_number: 'CG260707001',
  barcode: 'PROD000123',
  production_date: '07 Jul 26',
  production_time: '14:30',
  expiry_date: '09 Jul 26',
  expiry_time: '14:30',
  quantity_produced: 5,
  unit: 'kg',
  prepared_by: 'Suresh',
  storage_location: 'Cold Room 2',
};
const LABEL_FIELD_LABELS: Record<LabelFieldKey, string> = {
  batch: 'Batch #', prepared: 'Prepared', expiry: 'Expiry', qty: 'Qty', by: 'Prepared by', loc: 'Location',
};

// ─── Types ──────────────────────────────────────────────────────────────
interface Batch {
  id: string;
  batch_number: string;
  barcode: string;
  item_name: string;
  category: string;
  material_id: string | null;
  recipe_id: string | null;
  production_date: string;
  production_time: string;
  expiry_date: string;
  expiry_time: string;
  shelf_life: string;
  quantity_produced: number;
  quantity_consumed: number;
  unit: string;
  prepared_by: string;
  kitchen_section: string;
  storage_location: string;
  remarks: string;
  status: string;
  created_at: string;
  updated_at: string;
  remaining_quantity: number;
  expiry_status: 'green' | 'yellow' | 'red';
  batch_age_hours: number;
  fifo_priority: number | null;
}
interface Txn {
  id: string;
  type: string;
  quantity: number;
  balance_quantity: number;
  user: string;
  department: string;
  remarks: string;
  created_at: string;
}
interface RecipeOpt { id: string; name: string; }

// ─── Helpers ────────────────────────────────────────────────────────────
const fmtNum = (v: number) =>
  (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

// production_time / expiry_time are bare local wall-clock "HH:mm" strings from
// the form. Format to 12-hour WITHOUT any timezone conversion (the shared IST
// helpers expect a full datetime and would mis-handle a lone time).
function fmt12h(t: string | null | undefined): string {
  const s = (t || '').trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return s || '';
  let h = Number(m[1]);
  const min = m[2];
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${ampm}`;
}

/** Date ("YYYY-MM-DD") + time ("HH:mm") → "07 Jul 2026, 2:30 pm" (no TZ shift). */
function fmtDateTimeParts(date: string, time: string): string {
  const d = date ? fmtISTDate(date) : '';
  const t = fmt12h(time);
  if (d && t) return `${d}, ${t}`;
  return d || t || '—';
}

/** "HH:mm" for now, in the browser's local wall-clock. */
function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Expiry-bucket deep-link support (from the dashboard tiles). Mirrors the
// bucket semantics in /api/kitchen-production/dashboard: buckets are over
// ACTIVE batches only; today/tomorrow are IST calendar days for still-future
// batches; 3d/7d are rolling 72h/168h windows; expired = active & past expiry.
const EXPIRY_BUCKET_LABEL: Record<string, string> = {
  expired: 'Expired', today: 'Expiring today', tomorrow: 'Expiring tomorrow',
  '3d': 'Expiring within 3 days', '7d': 'Expiring within 7 days',
};
function inExpiryBucket(b: Batch, bucket: string, now: Date, today: string, tomorrow: string): boolean {
  if (b.status !== 'active') return false;
  const exp = parseDateTime(b.expiry_date, b.expiry_time);
  if (!exp) return false;
  const delta = exp.getTime() - now.getTime();
  const expDay = fmtISTIsoDate(exp);
  switch (bucket) {
    case 'expired':  return delta <= 0;
    case 'today':    return delta > 0 && expDay === today;
    case 'tomorrow': return delta > 0 && expDay === tomorrow;
    case '3d':       return delta > 0 && delta <= 72 * 3600 * 1000;
    case '7d':       return delta > 0 && delta <= 168 * 3600 * 1000;
    default:         return true;
  }
}

// Colour tokens per expiry traffic-light.
const EXPIRY_TONE: Record<Batch['expiry_status'], {
  border: string; badge: string; label: string; dot: string;
}> = {
  green:  { border: 'border-emerald-300', badge: 'bg-emerald-100 text-emerald-800 border-emerald-300', label: 'Fresh',      dot: 'bg-emerald-500' },
  yellow: { border: 'border-amber-300',   badge: 'bg-amber-100 text-amber-800 border-amber-300',       label: 'Near expiry', dot: 'bg-amber-500' },
  red:    { border: 'border-red-300',     badge: 'bg-red-100 text-red-700 border-red-300',             label: 'Expired',     dot: 'bg-red-500' },
};

const CATEGORY_SUGGESTIONS = [
  'Gravy', 'Curry Base', 'Marinade', 'Sauce', 'Stock', 'Rice', 'Bread',
  'Dessert', 'Batter', 'Dough', 'Chutney', 'Pickle', 'Beverage', 'Other',
];

type FormState = {
  item_name: string; category: string;
  production_date: string; production_time: string;
  expiry_date: string; expiry_time: string;
  shelf_life: string; quantity_produced: string; unit: string;
  prepared_by: string; kitchen_section: string; storage_location: string;
  recipe_id: string; remarks: string;
};

const blankForm = (preparedBy = ''): FormState => ({
  item_name: '', category: '',
  production_date: todayIST(), production_time: nowHHMM(),
  expiry_date: '', expiry_time: '',
  shelf_life: '', quantity_produced: '', unit: '',
  prepared_by: preparedBy, kitchen_section: '', storage_location: '',
  recipe_id: '', remarks: '',
});

// ─── Label printing ──────────────────────────────────────────────────────
// Ask the server for the batch's TSPL2 label, then forward it to the on-box
// print bridge (localhost:9920) EXACTLY like the KOT/bill flow: same bridgePrint
// helper, a raw `tspl` doc the bridge (v2.4.0+) sends to the TE210 verbatim.
type PrintOpts = { reprint?: boolean; copies?: number; qr?: boolean };

async function printLabelViaBridge(id: string, opts: PrintOpts = {}): Promise<void> {
  const body: Record<string, any> = { reprint: !!opts.reprint };
  if (opts.copies != null) body.copies = opts.copies;
  if (opts.qr !== undefined) body.qr = opts.qr;

  const r = await api(`/api/kitchen-production/${id}/print`, { method: 'POST', body });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);

  const printer = j.printer as LabelPrinterConfig;
  let res;
  try {
    res = await bridgePrint({
      jobId: `label_${id}_${Date.now()}`,
      printer: { transport: printer.transport, target: printer.target },
      doc: { type: 'tspl', payload: j.tspl },
    });
  } catch (e: any) {
    throw new Error(`Print bridge not reachable at localhost:9920 — is the counter print agent running? (${e?.message || e})`);
  }
  if (!res.ok) throw new Error(res.error || 'Printer rejected the label');
}

// ─── Page ───────────────────────────────────────────────────────────────
export default function KitchenProductionPage() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<'active' | 'all'>('active');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [expiryFilter, setExpiryFilter] = useState('');   // deep-link from dashboard tiles
  const [refreshKey, setRefreshKey] = useState(0);

  // New-batch modal
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Detail drawer
  const [detailId, setDetailId] = useState<string | null>(null);

  // Reference data
  const [meName, setMeName] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [recipes, setRecipes] = useState<RecipeOpt[]>([]);
  const [printerCfg, setPrinterCfg] = useState<LabelPrinterConfig | null>(null);

  // Label printing UI state
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPrinting, setBulkPrinting] = useState(false);
  const [previewBatch, setPreviewBatch] = useState<Batch | null>(null);
  const [showPrinterSettings, setShowPrinterSettings] = useState(false);
  const [justCreated, setJustCreated] = useState<{ id: string; batch_number: string } | null>(null);

  // Toast
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = (msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3800);
  };

  const loadPrinterCfg = () => {
    fetch('/api/settings/label-printer', { credentials: 'same-origin' })
      .then(r => r.json()).then(d => { if (d?.printer) setPrinterCfg(d.printer); }).catch(() => {});
  };

  // One-shot: current user (for prepared_by default) + recipes for the dropdown
  // + the saved label-printer config (dimensions / qr default for previews).
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => {
      const n = d?.user?.name || d?.user?.email || '';
      setMeName(n);
      setIsAdmin(d?.user?.role === 'admin');
      setForm(f => (f.prepared_by ? f : { ...f, prepared_by: n }));
    }).catch(() => {});
    fetch('/api/recipes').then(r => r.json()).then(d => {
      const list: any[] = Array.isArray(d) ? d : (d.recipes || d.list || d.items || []);
      setRecipes(list.map((r: any) => ({ id: r.id, name: r.name })).filter(r => r.id && r.name));
    }).catch(() => {});
    loadPrinterCfg();
    // Honour ?expiry=<bucket> deep-links from the dashboard expiry tiles. Buckets
    // are over active batches, so also force the Active tab on.
    try {
      const b = new URLSearchParams(window.location.search).get('expiry') || '';
      if (b && EXPIRY_BUCKET_LABEL[b]) { setExpiryFilter(b); setStatusFilter('active'); }
    } catch { /* ignore */ }
  }, []);

  // Print one batch's label (reprint flag flows through to the transaction type).
  const handlePrint = async (id: string, reprint: boolean) => {
    setPrintingId(id);
    try {
      await printLabelViaBridge(id, { reprint });
      showToast(reprint ? 'Label reprinted' : 'Label sent to printer', 'ok');
    } catch (e: any) {
      showToast(e?.message || 'Print failed', 'err');
    } finally {
      setPrintingId(null);
    }
  };

  const toggleSelect = (id: string) =>
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); };

  // Bulk print: one API call → then forward each job's tspl to the bridge in order.
  const bulkPrint = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBulkPrinting(true);
    try {
      const r = await api('/api/kitchen-production/print-bulk', { method: 'POST', body: { ids } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const printer = j.printer as LabelPrinterConfig;
      const jobs: Array<{ id: string; batch_number: string; tspl: string }> = Array.isArray(j.jobs) ? j.jobs : [];
      let ok = 0, fail = 0;
      for (const job of jobs) {
        try {
          const res = await bridgePrint({
            jobId: `label_${job.id}_${Date.now()}`,
            printer: { transport: printer.transport, target: printer.target },
            doc: { type: 'tspl', payload: job.tspl },
          });
          res.ok ? ok++ : fail++;
        } catch { fail++; }
      }
      showToast(`Printed ${ok}/${jobs.length} label${jobs.length === 1 ? '' : 's'}${fail ? ` — ${fail} failed (bridge?)` : ''}`, fail ? 'err' : 'ok');
      exitSelect();
    } catch (e: any) {
      showToast(e?.message || 'Bulk print failed', 'err');
    } finally {
      setBulkPrinting(false);
    }
  };

  const reload = async () => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ status: statusFilter });
      if (category) qs.set('category', category);
      if (search.trim()) qs.set('search', search.trim());
      const r = await fetch(`/api/kitchen-production?${qs}`, { credentials: 'same-origin' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setBatches(Array.isArray(j.batches) ? j.batches : []);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [statusFilter, category, refreshKey]);

  // Debounced search — reload 350ms after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setRefreshKey(k => k + 1), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [search]);

  // Category options derived from whatever's loaded, unioned with suggestions.
  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    batches.forEach(b => { if (b.category) set.add(b.category); });
    return Array.from(set).sort();
  }, [batches]);

  // Apply the (client-side) expiry-bucket deep-link filter on top of whatever
  // the server returned. Kept out of the fetch query since buckets are derived.
  const visibleBatches = useMemo(() => {
    if (!expiryFilter) return batches;
    const now = new Date();
    const today = todayIST();
    const tomorrow = fmtISTIsoDate(new Date(now.getTime() + 24 * 3600 * 1000));
    return batches.filter(b => inExpiryBucket(b, expiryFilter, now, today, tomorrow));
  }, [batches, expiryFilter]);

  const openNewForm = () => {
    setForm(blankForm(meName));
    setFormError(null);
    setShowForm(true);
  };

  const setField = (k: keyof FormState, v: string) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.item_name.trim()) { setFormError('Production Item Name is required.'); return; }
    const qty = Number(form.quantity_produced);
    if (!qty || qty <= 0) { setFormError('Quantity Produced must be greater than 0.'); return; }
    setSaving(true); setFormError(null);
    try {
      const r = await api('/api/kitchen-production', {
        method: 'POST',
        body: {
          item_name: form.item_name.trim(),
          category: form.category.trim(),
          production_date: form.production_date,
          production_time: form.production_time,
          expiry_date: form.expiry_date,
          expiry_time: form.expiry_time,
          shelf_life: form.shelf_life.trim(),
          quantity_produced: qty,
          unit: form.unit.trim(),
          prepared_by: form.prepared_by.trim(),
          kitchen_section: form.kitchen_section.trim(),
          storage_location: form.storage_location.trim(),
          recipe_id: form.recipe_id || undefined,
          remarks: form.remarks.trim(),
        },
      });
      const j = await r.json();
      if (!r.ok) { setFormError(j.error || 'Failed to save batch'); return; }
      setShowForm(false);
      setRefreshKey(k => k + 1);
      if (j?.batch?.id) setJustCreated({ id: j.batch.id, batch_number: j.batch.batch_number || '' });
    } catch (e: any) { setFormError(e.message || 'Failed to save batch'); }
    finally { setSaving(false); }
  };

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <ChefHat className="w-6 h-6 text-[#af4408]" /> Kitchen Production
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5 max-w-2xl">
            Log every prepared-item batch and track it through its shelf life. Each batch
            auto-gets a <b>batch number</b> and <b>barcode</b>. Cards are colour-coded by
            freshness and flagged <b>FIFO</b> so the oldest batch is used first.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/kitchen-production/dashboard"
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <LayoutGrid className="w-4 h-4" /> <span className="hidden sm:inline">Dashboard</span>
          </Link>
          <Link href="/kitchen-production/reports"
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <BarChart3 className="w-4 h-4" /> <span className="hidden sm:inline">Reports</span>
          </Link>
          <Link href="/kitchen-production/scan"
                className="px-3 py-2 bg-white border border-[#af4408] hover:bg-[#FFF1E3] text-[#af4408] rounded-lg text-sm font-medium flex items-center gap-2">
            <ScanLine className="w-4 h-4" /> Scan
          </Link>
          {isAdmin && (
            <button onClick={() => setShowPrinterSettings(true)}
                    title="Label printer settings"
                    className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
              <Settings className="w-4 h-4" /> <span className="hidden sm:inline">Printer</span>
            </button>
          )}
          <button onClick={() => setRefreshKey(k => k + 1)}
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> <span className="hidden sm:inline">Refresh</span>
          </button>
          <button onClick={openNewForm}
                  className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium flex items-center gap-2">
            <Plus className="w-4 h-4" /> New Production Batch
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 bg-white border border-[#E8D5C4] rounded-xl p-3">
        <div className="flex rounded-lg border border-[#E8D5C4] overflow-hidden text-sm">
          {(['active', 'all'] as const).map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
                    className={`px-3 py-1.5 ${statusFilter === s
                      ? 'bg-[#af4408] text-white'
                      : 'bg-white text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
              {s === 'active' ? 'Active' : 'All'}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-2 top-2.5 text-[#8B7355]" />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Search item / barcode / batch #…"
                 className="w-full pl-8 pr-2 py-2 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </div>
        <select value={category} onChange={e => setCategory(e.target.value)}
                className="px-2 py-2 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] min-w-[150px]">
          <option value="">All categories</option>
          {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Active expiry deep-link chip */}
      {expiryFilter && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-[#FFF1E3] border border-[#D4B896] text-[#8a3506]">
            <AlertTriangle className="w-3.5 h-3.5" />
            {EXPIRY_BUCKET_LABEL[expiryFilter]}
            <button onClick={() => setExpiryFilter('')} className="ml-0.5 hover:text-[#af4408]" title="Clear filter">
              <X className="w-3.5 h-3.5" />
            </button>
          </span>
          <span className="text-xs text-[#8B7355]">{visibleBatches.length} match{visibleBatches.length === 1 ? '' : 'es'}</span>
        </div>
      )}

      {/* Bulk-select action bar */}
      {!loading && visibleBatches.length > 0 && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs text-[#8B7355]">
            {visibleBatches.length} batch{visibleBatches.length === 1 ? '' : 'es'}
            {selectMode && <> · <span className="font-semibold text-[#af4408]">{selected.size} selected</span></>}
          </div>
          <div className="flex items-center gap-2">
            {!selectMode ? (
              <button onClick={() => setSelectMode(true)}
                      className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
                <CheckSquare className="w-4 h-4" /> Select
              </button>
            ) : (
              <>
                <button onClick={() => setSelected(new Set(visibleBatches.map(b => b.id)))}
                        className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm">
                  Select all
                </button>
                <button onClick={bulkPrint} disabled={!selected.size || bulkPrinting}
                        className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50">
                  {bulkPrinting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                  Print selected ({selected.size})
                </button>
                <button onClick={exitSelect} disabled={bulkPrinting}
                        className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}

      {/* Cards */}
      {loading ? (
        <div className="p-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading batches…
        </div>
      ) : visibleBatches.length === 0 ? (
        <div className="p-10 bg-white border border-[#E8D5C4] rounded-xl text-center text-sm text-[#8B7355]">
          <Package className="w-8 h-8 mx-auto mb-2 text-[#D4B896]" />
          {expiryFilter
            ? `No active batches are ${EXPIRY_BUCKET_LABEL[expiryFilter].toLowerCase()}.`
            : search || category
              ? 'No batches match your filters.'
              : statusFilter === 'active'
                ? 'No active production batches yet. Click “New Production Batch” to log one.'
                : 'No production batches recorded yet.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {visibleBatches.map(b => (
            <BatchCard
              key={b.id}
              batch={b}
              onOpen={() => setDetailId(b.id)}
              selectMode={selectMode}
              selected={selected.has(b.id)}
              onToggleSelect={() => toggleSelect(b.id)}
              onPrint={() => handlePrint(b.id, false)}
              onReprint={() => handlePrint(b.id, true)}
              onPreview={() => setPreviewBatch(b)}
              printing={printingId === b.id}
            />
          ))}
        </div>
      )}

      {/* New-batch modal */}
      {showForm && (
        <BatchFormModal
          form={form} setField={setField}
          saving={saving} error={formError}
          recipes={recipes}
          onCancel={() => { if (!saving) setShowForm(false); }}
          onSave={save}
        />
      )}

      {/* Detail drawer */}
      {detailId && (
        <BatchDetailDrawer
          id={detailId}
          onClose={() => setDetailId(null)}
          onChanged={() => setRefreshKey(k => k + 1)}
          showToast={showToast}
        />
      )}

      {/* Just-created → one-click print */}
      {justCreated && (
        <JustCreatedModal
          batchNumber={justCreated.batch_number}
          onClose={() => setJustCreated(null)}
          onPrint={async () => {
            const id = justCreated.id;
            setPrintingId(id);
            try {
              await printLabelViaBridge(id, {});
              showToast('Label sent to printer', 'ok');
              setJustCreated(null);
            } catch (e: any) {
              showToast(e?.message || 'Print failed', 'err');
            } finally { setPrintingId(null); }
          }}
          printing={printingId === justCreated.id}
        />
      )}

      {/* Preview (WYSIWYG, no printing) */}
      {previewBatch && (
        <LabelPreviewModal
          batch={previewBatch}
          cfg={printerCfg}
          onClose={() => setPreviewBatch(null)}
        />
      )}

      {/* Printer settings (admin) */}
      {showPrinterSettings && (
        <PrinterSettingsModal
          onClose={() => setShowPrinterSettings(false)}
          onSaved={(cfg) => { setPrinterCfg(cfg); showToast('Printer settings saved', 'ok'); }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] max-w-[92vw]">
          <div className={`px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium flex items-center gap-2 border ${
            toast.kind === 'ok'
              ? 'bg-emerald-600 text-white border-emerald-700'
              : 'bg-red-600 text-white border-red-700'}`}>
            {toast.kind === 'ok' ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
            <span>{toast.msg}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Batch card ─────────────────────────────────────────────────────────
function BatchCard({
  batch, onOpen, selectMode, selected, onToggleSelect, onPrint, onReprint, onPreview, printing,
}: {
  batch: Batch; onOpen: () => void;
  selectMode: boolean; selected: boolean; onToggleSelect: () => void;
  onPrint: () => void; onReprint: () => void; onPreview: () => void; printing: boolean;
}) {
  const tone = EXPIRY_TONE[batch.expiry_status] || EXPIRY_TONE.green;
  const remaining = batch.remaining_quantity ?? Math.max(0, batch.quantity_produced - batch.quantity_consumed);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div onClick={() => (selectMode ? onToggleSelect() : onOpen())}
         className={`relative text-left bg-white border-2 rounded-xl p-4 ${selectMode ? 'pl-9' : ''} hover:shadow-md transition-shadow flex flex-col gap-3 cursor-pointer ${
           selected ? 'border-[#af4408] ring-2 ring-[#af4408]/30' : tone.border}`}>
      {selectMode && (
        <div className="absolute top-3 left-2.5">
          {selected ? <CheckSquare className="w-5 h-5 text-[#af4408]" /> : <Square className="w-5 h-5 text-[#8B7355]" />}
        </div>
      )}
      {/* Top row: item + status/FIFO badges */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-[#2D1B0E] truncate flex items-center gap-1.5">
            <span className={`inline-block w-2 h-2 rounded-full ${tone.dot} shrink-0`} />
            {batch.item_name}
          </div>
          {batch.category && (
            <div className="text-[11px] text-[#8B7355] mt-0.5">{batch.category}</div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium whitespace-nowrap ${tone.badge}`}>
            {batch.expiry_status === 'red'
              ? <><AlertTriangle className="w-3 h-3 inline mr-0.5" />{tone.label}</>
              : batch.expiry_status === 'yellow'
                ? <><Clock className="w-3 h-3 inline mr-0.5" />{tone.label}</>
                : <><CheckCircle2 className="w-3 h-3 inline mr-0.5" />{tone.label}</>}
          </span>
          {batch.status === 'active' && batch.fifo_priority != null && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#D4B896] bg-[#FFF1E3] text-[#6B5744] font-semibold whitespace-nowrap">
              FIFO #{batch.fifo_priority}
            </span>
          )}
          {batch.status !== 'active' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 text-gray-600 font-medium capitalize">
              {batch.status}
            </span>
          )}
        </div>
      </div>

      {/* Batch # / barcode */}
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <span className="font-mono font-semibold text-[#2D1B0E] bg-[#FFF1E3] border border-[#E8D5C4] rounded px-1.5 py-0.5">
          {batch.batch_number}
        </span>
        <span className="font-mono text-[#8B7355] flex items-center gap-1">
          <BarcodeIcon className="w-3.5 h-3.5" /> {batch.barcode}
        </span>
      </div>

      {/* Quantities */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <QtyChip label="Produced" value={`${fmtNum(batch.quantity_produced)}${batch.unit ? ' ' + batch.unit : ''}`} tone="text-[#6B5744]" />
        <QtyChip label="Consumed" value={`${fmtNum(batch.quantity_consumed)}${batch.unit ? ' ' + batch.unit : ''}`} tone="text-amber-700" />
        <QtyChip label="Remaining" value={`${fmtNum(remaining)}${batch.unit ? ' ' + batch.unit : ''}`} tone="text-emerald-700" />
      </div>

      {/* Meta */}
      <div className="text-[11px] text-[#6B5744] space-y-1 border-t border-[#E8D5C4] pt-2">
        <div className="flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-[#8B7355] shrink-0" />
          <span>Produced {fmtDateTimeParts(batch.production_date, batch.production_time)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-[#8B7355] shrink-0" />
          <span>Expires {batch.expiry_date ? fmtDateTimeParts(batch.expiry_date, batch.expiry_time) : '—'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <UserIcon className="w-3.5 h-3.5 text-[#8B7355] shrink-0" />
          <span>{batch.prepared_by || '—'}</span>
          {batch.storage_location && (
            <>
              <MapPin className="w-3.5 h-3.5 text-[#8B7355] shrink-0 ml-1" />
              <span className="truncate">{batch.storage_location}</span>
            </>
          )}
        </div>
      </div>

      {/* Label actions */}
      <div className="flex items-center gap-1.5 border-t border-[#E8D5C4] pt-2" onClick={stop}>
        <button onClick={onPrint} disabled={printing}
                className="flex-1 px-2 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 disabled:opacity-50">
          {printing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
          Print label
        </button>
        <button onClick={onReprint} disabled={printing} title="Reprint label"
                className="px-2 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs flex items-center gap-1 disabled:opacity-50">
          <Copy className="w-3.5 h-3.5" /> Reprint
        </button>
        <button onClick={onPreview} title="Preview label"
                className="px-2 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs flex items-center gap-1">
          <Eye className="w-3.5 h-3.5" /> Preview
        </button>
      </div>
    </div>
  );
}

function QtyChip({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg py-1.5 px-1">
      <div className="text-[9px] uppercase tracking-wide text-[#8B7355]">{label}</div>
      <div className={`text-sm font-bold font-mono ${tone} leading-tight`}>{value}</div>
    </div>
  );
}

// ─── New-batch modal ────────────────────────────────────────────────────
function BatchFormModal({ form, setField, saving, error, recipes, onCancel, onSave }: {
  form: FormState;
  setField: (k: keyof FormState, v: string) => void;
  saving: boolean; error: string | null;
  recipes: RecipeOpt[];
  onCancel: () => void; onSave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto"
         onClick={onCancel}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl shadow-xl my-4"
           onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-3 border-b border-[#E8D5C4] flex items-center justify-between sticky top-0 bg-white rounded-t-xl">
          <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">
            <ChefHat className="w-5 h-5 text-[#af4408]" /> New Production Batch
          </div>
          <button onClick={onCancel} disabled={saving} className="text-[#8B7355] hover:text-[#2D1B0E] disabled:opacity-50">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Auto-generated notice */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ReadOnlyField label="Batch Number" />
            <ReadOnlyField label="Barcode" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Production Item Name" required>
              <input value={form.item_name} onChange={e => setField('item_name', e.target.value)}
                     placeholder="e.g. Chicken Gravy" className={inputCls} autoFocus />
            </Field>
            <Field label="Category">
              <input list="kp-category-list" value={form.category} onChange={e => setField('category', e.target.value)}
                     placeholder="e.g. Gravy" className={inputCls} />
              <datalist id="kp-category-list">
                {CATEGORY_SUGGESTIONS.map(c => <option key={c} value={c} />)}
              </datalist>
            </Field>

            <Field label="Production Date">
              <input type="date" value={form.production_date} onChange={e => setField('production_date', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Production Time">
              <input type="time" value={form.production_time} onChange={e => setField('production_time', e.target.value)} className={inputCls} />
            </Field>

            <Field label="Expiry Date">
              <input type="date" value={form.expiry_date} onChange={e => setField('expiry_date', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Expiry Time">
              <input type="time" value={form.expiry_time} onChange={e => setField('expiry_time', e.target.value)} className={inputCls} />
            </Field>

            <Field label="Shelf Life">
              <input value={form.shelf_life} onChange={e => setField('shelf_life', e.target.value)}
                     placeholder="e.g. 2 days / 48 hrs" className={inputCls} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Quantity Produced" required>
                <input type="number" step="any" min={0} value={form.quantity_produced}
                       onChange={e => setField('quantity_produced', e.target.value)}
                       placeholder="0" className={inputCls} />
              </Field>
              <Field label="Unit">
                <input value={form.unit} onChange={e => setField('unit', e.target.value)}
                       placeholder="kg / L / pcs" className={inputCls} />
              </Field>
            </div>

            <Field label="Prepared By">
              <input value={form.prepared_by} onChange={e => setField('prepared_by', e.target.value)}
                     placeholder="Chef name" className={inputCls} />
            </Field>
            <Field label="Kitchen Section">
              <input value={form.kitchen_section} onChange={e => setField('kitchen_section', e.target.value)}
                     placeholder="e.g. Hot Kitchen / Bakery" className={inputCls} />
            </Field>

            <Field label="Storage Location">
              <input value={form.storage_location} onChange={e => setField('storage_location', e.target.value)}
                     placeholder="e.g. Walk-in Chiller 2" className={inputCls} />
            </Field>
            <Field label="Recipe Reference (optional)">
              <select value={form.recipe_id} onChange={e => setField('recipe_id', e.target.value)} className={inputCls}>
                <option value="">— none —</option>
                {recipes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Remarks">
            <textarea value={form.remarks} onChange={e => setField('remarks', e.target.value)}
                      rows={2} placeholder="Any notes about this batch…" className={inputCls} />
          </Field>

          {error && <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-sm text-red-700">{error}</div>}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 sticky bottom-0 bg-white rounded-b-xl">
          <button onClick={onCancel} disabled={saving}
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">
            Cancel
          </button>
          <button onClick={onSave} disabled={saving}
                  className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Save Batch
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls = 'w-full px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]/30';

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium text-[#6B5744] mb-1 block">
        {label}{required && <span className="text-[#af4408]"> *</span>}
      </span>
      {children}
    </label>
  );
}

function ReadOnlyField({ label }: { label: string }) {
  return (
    <div className="block">
      <span className="text-[11px] font-medium text-[#6B5744] mb-1 block">{label}</span>
      <div className="w-full px-2.5 py-2 border border-dashed border-[#E8D5C4] rounded-lg text-sm bg-[#FFF1E3]/50 text-[#8B7355] italic">
        auto-generated on save
      </div>
    </div>
  );
}

// ─── Detail drawer ──────────────────────────────────────────────────────
function BatchDetailDrawer({ id, onClose, onChanged, showToast }: {
  id: string; onClose: () => void;
  onChanged?: () => void;
  showToast?: (msg: string, kind?: 'ok' | 'err') => void;
}) {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Waste / dispose / transfer / return action modal.
  const [action, setAction] = useState<DisposeAction | null>(null);

  const load = () => {
    let cancelled = false;
    setLoading(true); setError(null);
    fetch(`/api/kitchen-production/${id}`, { credentials: 'same-origin' })
      .then(async r => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        return j;
      })
      .then(j => { if (!cancelled) { setBatch(j.batch); setTxns(Array.isArray(j.transactions) ? j.transactions : []); } })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  };

  useEffect(() => load(), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onActionDone = (label: string) => {
    setAction(null);
    load();                        // refresh drawer (batch + txns)
    onChanged?.();                 // refresh the card list behind it
    showToast?.(label, 'ok');
  };

  const tone = batch ? (EXPIRY_TONE[batch.expiry_status] || EXPIRY_TONE.green) : EXPIRY_TONE.green;
  const remaining = batch ? (batch.remaining_quantity ?? Math.max(0, batch.quantity_produced - batch.quantity_consumed)) : 0;
  const canAct = !!batch && batch.status === 'active';

  return (
    <>
    <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch justify-end" onClick={onClose}>
      <div className="bg-[#FFF8F0] w-full max-w-md h-full shadow-xl overflow-y-auto border-l border-[#E8D5C4]"
           onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-3 border-b border-[#E8D5C4] bg-white flex items-center justify-between sticky top-0 z-10">
          <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">
            <Package className="w-5 h-5 text-[#af4408]" /> Batch Details
          </div>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
          </div>
        ) : error ? (
          <div className="m-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
        ) : batch ? (
          <div className="p-4 space-y-4">
            {/* Title */}
            <div className={`bg-white border-2 ${tone.border} rounded-xl p-4`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-lg font-bold text-[#2D1B0E]">{batch.item_name}</div>
                  {batch.category && <div className="text-xs text-[#8B7355]">{batch.category}</div>}
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded border font-medium ${tone.badge}`}>{tone.label}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap text-[11px] mt-2">
                <span className="font-mono font-semibold text-[#2D1B0E] bg-[#FFF1E3] border border-[#E8D5C4] rounded px-1.5 py-0.5">
                  {batch.batch_number}
                </span>
                <span className="font-mono text-[#8B7355] flex items-center gap-1">
                  <BarcodeIcon className="w-3.5 h-3.5" /> {batch.barcode}
                </span>
              </div>
            </div>

            {/* Fields */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <Detail label="Produced" value={`${fmtNum(batch.quantity_produced)}${batch.unit ? ' ' + batch.unit : ''}`} />
              <Detail label="Consumed" value={`${fmtNum(batch.quantity_consumed)}${batch.unit ? ' ' + batch.unit : ''}`} />
              <Detail label="Remaining" value={`${fmtNum(batch.remaining_quantity)}${batch.unit ? ' ' + batch.unit : ''}`} strong />
              <Detail label="Status" value={batch.status} capitalize />
              <Detail label="Production" value={fmtDateTimeParts(batch.production_date, batch.production_time)} />
              <Detail label="Expiry" value={batch.expiry_date ? fmtDateTimeParts(batch.expiry_date, batch.expiry_time) : '—'} />
              <Detail label="Shelf Life" value={batch.shelf_life || '—'} />
              <Detail label="Batch Age" value={`${fmtNum(batch.batch_age_hours)} hrs`} />
              <Detail label="Prepared By" value={batch.prepared_by || '—'} />
              <Detail label="Kitchen Section" value={batch.kitchen_section || '—'} />
              <Detail label="Storage" value={batch.storage_location || '—'} />
              <Detail label="Logged" value={fmtIST(batch.created_at)} />
            </div>
            {batch.remarks && (
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 text-sm">
                <div className="text-[11px] font-medium text-[#8B7355] mb-1">Remarks</div>
                <div className="text-[#2D1B0E]">{batch.remarks}</div>
              </div>
            )}

            {/* Actions */}
            {canAct ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
                <div className="text-[11px] font-medium text-[#8B7355] mb-2">Batch actions</div>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setAction('wasted')} disabled={remaining <= 0}
                          className="px-2.5 py-2 bg-red-50 border border-red-200 hover:bg-red-100 text-red-700 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 disabled:opacity-40">
                    <Trash2 className="w-4 h-4" /> Waste
                  </button>
                  <button onClick={() => setAction('disposed')} disabled={remaining <= 0}
                          className="px-2.5 py-2 bg-red-50 border border-red-200 hover:bg-red-100 text-red-700 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 disabled:opacity-40">
                    <AlertTriangle className="w-4 h-4" /> Dispose
                  </button>
                  <button onClick={() => setAction('transferred')}
                          className="px-2.5 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium flex items-center justify-center gap-1.5">
                    <Send className="w-4 h-4" /> Transfer
                  </button>
                  <button onClick={() => setAction('returned')}
                          className="px-2.5 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium flex items-center justify-center gap-1.5">
                    <Undo2 className="w-4 h-4" /> Return
                  </button>
                </div>
                {remaining <= 0 && (
                  <div className="text-[11px] text-[#8B7355] mt-2">Nothing left on hand to waste or dispose.</div>
                )}
              </div>
            ) : batch.status !== 'active' ? (
              <div className="bg-[#FFF1E3]/60 border border-[#E8D5C4] rounded-xl p-3 text-[11px] text-[#8B7355]">
                This batch is <span className="capitalize font-medium">{batch.status}</span> — no further actions.
              </div>
            ) : null}

            {/* Transactions */}
            <div>
              <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5 mb-2">
                <History className="w-4 h-4 text-[#af4408]" /> Transaction History
              </div>
              {txns.length === 0 ? (
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 text-sm text-[#8B7355] text-center">
                  No transactions yet.
                </div>
              ) : (
                <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden divide-y divide-[#E8D5C4]/60">
                  {txns.map(t => (
                    <div key={t.id} className="p-3 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium capitalize ${txnTone(t.type)}`}>
                            {t.type}
                          </span>
                          <span className="text-[11px] text-[#8B7355]">{fmtIST(t.created_at)}</span>
                        </div>
                        <div className="text-[11px] text-[#6B5744] mt-1">
                          {t.user || '—'}{t.department ? ` · ${t.department}` : ''}
                          {t.remarks ? ` — ${t.remarks}` : ''}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono text-sm font-semibold text-[#2D1B0E]">
                          {t.type === 'consumed' ? '-' : '+'}{fmtNum(t.quantity)}
                        </div>
                        <div className="text-[10px] text-[#8B7355]">bal {fmtNum(t.balance_quantity)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>

    {/* Action modal (waste / dispose / transfer / return) */}
    {action && batch && (
      <DisposeActionModal
        batch={batch}
        action={action}
        remaining={remaining}
        onCancel={() => setAction(null)}
        onDone={onActionDone}
      />
    )}
    </>
  );
}

// ─── Waste / dispose / transfer / return modal ───────────────────────────
type DisposeAction = 'wasted' | 'disposed' | 'transferred' | 'returned';

const ACTION_META: Record<DisposeAction, {
  title: string; verb: string; removes: boolean; danger: boolean; blurb: string;
}> = {
  wasted:      { title: 'Record Waste',   verb: 'Record waste', removes: true,  danger: true,
                 blurb: 'Remove spoiled / unusable stock from this batch.' },
  disposed:    { title: 'Dispose Stock',  verb: 'Dispose',      removes: true,  danger: true,
                 blurb: 'Write off and dispose stock from this batch.' },
  transferred: { title: 'Transfer Batch', verb: 'Transfer',     removes: false, danger: false,
                 blurb: 'Log a movement of this batch to another location — stock on hand is unchanged.' },
  returned:    { title: 'Return Batch',   verb: 'Return',       removes: false, danger: false,
                 blurb: 'Log a return of this batch — stock on hand is unchanged.' },
};

function DisposeActionModal({ batch, action, remaining, onCancel, onDone }: {
  batch: Batch; action: DisposeAction; remaining: number;
  onCancel: () => void; onDone: (label: string) => void;
}) {
  const meta = ACTION_META[action];
  const [qty, setQty] = useState<string>(String(remaining || ''));
  const [remarks, setRemarks] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) { setError('Enter a quantity greater than 0.'); return; }
    if (meta.removes && q > remaining + 1e-9) { setError(`Only ${fmtNum(remaining)} on hand.`); return; }
    setSubmitting(true); setError(null);
    try {
      const r = await api(`/api/kitchen-production/${batch.id}/dispose`, {
        method: 'POST',
        body: { action, quantity: q, remarks: remarks.trim() },
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error || 'Failed to record'); return; }
      onDone(`${batch.item_name} — ${meta.verb.toLowerCase()} (${fmtNum(q)}${batch.unit ? ' ' + batch.unit : ''})`);
    } catch (e: any) { setError(e?.message || 'Failed to record'); }
    finally { setSubmitting(false); }
  };

  const disabled = submitting || (meta.removes && !confirmed);

  return (
    <div className="fixed inset-0 z-[55] bg-black/50 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#E8D5C4] flex items-center justify-between">
          <div className={`font-semibold flex items-center gap-2 ${meta.danger ? 'text-red-700' : 'text-[#2D1B0E]'}`}>
            {meta.danger ? <Trash2 className="w-5 h-5" /> : <Send className="w-5 h-5 text-[#af4408]" />}
            {meta.title}
          </div>
          <button onClick={onCancel} disabled={submitting} className="text-[#8B7355] hover:text-[#2D1B0E] disabled:opacity-50">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div className="text-xs text-[#6B5744]">{meta.blurb}</div>
          <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2 text-xs text-[#6B5744]">
            <span className="font-semibold text-[#2D1B0E]">{batch.item_name}</span>
            <span className="font-mono ml-2">{batch.batch_number}</span>
            <div className="mt-0.5">On hand: <b className="text-emerald-700">{fmtNum(remaining)}{batch.unit ? ' ' + batch.unit : ''}</b></div>
          </div>
          <Field label={`Quantity${batch.unit ? ` (${batch.unit})` : ''}`} required>
            <input type="number" step="any" min={0} value={qty} onChange={e => setQty(e.target.value)}
                   className={inputCls} autoFocus />
          </Field>
          <Field label="Remarks">
            <textarea value={remarks} onChange={e => setRemarks(e.target.value)} rows={2}
                      placeholder={meta.removes ? 'Reason (e.g. spoilage, over-prep)…' : 'Where to / why…'}
                      className={inputCls} />
          </Field>
          {meta.removes && (
            <label className="flex items-start gap-2 text-xs text-[#6B5744] cursor-pointer">
              <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}
                     className="accent-[#af4408] mt-0.5" />
              I confirm removing this stock — this cannot be undone.
            </label>
          )}
          {error && <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-sm text-red-700">{error}</div>}
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2">
          <button onClick={onCancel} disabled={submitting}
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">
            Cancel
          </button>
          <button onClick={submit} disabled={disabled}
                  className={`px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50 text-white ${
                    meta.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-[#af4408] hover:bg-[#8a3506]'}`}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            {meta.verb}
          </button>
        </div>
      </div>
    </div>
  );
}

function txnTone(type: string): string {
  switch (type) {
    case 'created':   return 'bg-emerald-100 text-emerald-800 border-emerald-300';
    case 'consumed':  return 'bg-amber-100 text-amber-800 border-amber-300';
    case 'wasted':
    case 'expired':
    case 'disposed':  return 'bg-red-100 text-red-700 border-red-300';
    default:          return 'bg-[#FFF1E3] text-[#6B5744] border-[#D4B896]';
  }
}

function Detail({ label, value, strong, capitalize }: { label: string; value: string; strong?: boolean; capitalize?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-[#8B7355]">{label}</div>
      <div className={`${strong ? 'font-bold text-emerald-700' : 'text-[#2D1B0E]'} ${capitalize ? 'capitalize' : ''}`}>{value}</div>
    </div>
  );
}

// ─── Just-created → one-click print ───────────────────────────────────────
function JustCreatedModal({ batchNumber, onClose, onPrint, printing }: {
  batchNumber: string; onClose: () => void; onPrint: () => void; printing: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-sm shadow-xl p-5 text-center" onClick={e => e.stopPropagation()}>
        <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-3">
          <CheckCircle2 className="w-6 h-6 text-emerald-600" />
        </div>
        <div className="font-semibold text-[#2D1B0E]">Batch created</div>
        {batchNumber && <div className="font-mono text-sm text-[#af4408] mt-1">{batchNumber}</div>}
        <p className="text-xs text-[#8B7355] mt-2">Print the label now, or later from the card.</p>
        <div className="flex items-center gap-2 mt-4">
          <button onClick={onClose} disabled={printing}
                  className="flex-1 px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">
            Later
          </button>
          <button onClick={onPrint} disabled={printing}
                  className="flex-1 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50">
            {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
            Print label
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Label preview (WYSIWYG; does NOT print) ──────────────────────────────
// Renders the 50×40 mm label using labelPreview() data — the CODE128 via
// jsbarcode, the QR via the qrcode lib — at true label proportions.
function LabelPreviewModal({ batch, cfg, onClose }: {
  batch: Batch; cfg: LabelPrinterConfig | null; onClose: () => void;
}) {
  const [qr, setQr] = useState<boolean>(!!cfg?.qr);
  const widthMm = cfg?.label_width_mm || 50;
  const heightMm = cfg?.label_height_mm || 40;
  // Same `design` the printer uses → the preview matches the printed label.
  const pv = labelPreview(batch, {
    qr,
    labelWidthMm: widthMm,
    labelHeightMm: heightMm,
    design: cfg?.design,
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#E8D5C4] flex items-center justify-between">
          <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">
            <Eye className="w-5 h-5 text-[#af4408]" /> Label Preview
          </div>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="text-[11px] text-[#8B7355] text-center">{widthMm} × {heightMm} mm · preview only (not printed)</div>
          <div className="flex justify-center">
            <LabelCanvas preview={pv} scale={7} />
          </div>
          <label className="flex items-center justify-center gap-2 text-sm text-[#6B5744]">
            <input type="checkbox" checked={qr} onChange={e => setQr(e.target.checked)} className="accent-[#af4408]" />
            Show QR code
          </label>
        </div>
      </div>
    </div>
  );
}

// ─── Printer settings (admin) ─────────────────────────────────────────────
function PrinterSettingsModal({ onClose, onSaved }: {
  onClose: () => void; onSaved: (cfg: LabelPrinterConfig) => void;
}) {
  const [cfg, setCfg] = useState<LabelPrinterConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings/label-printer', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => { if (d?.printer) setCfg(d.printer); else setError(d?.error || 'Failed to load'); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const [tab, setTab] = useState<'printer' | 'design'>('printer');

  const set = <K extends keyof LabelPrinterConfig>(k: K, v: LabelPrinterConfig[K]) =>
    setCfg(c => (c ? { ...c, [k]: v } : c));
  // Patch a sub-field of the label design (font sizes, barcode, toggles).
  const setDesign = <K extends keyof LabelPrinterConfig['design']>(k: K, v: LabelPrinterConfig['design'][K]) =>
    setCfg(c => (c ? { ...c, design: { ...c.design, [k]: v } } : c));
  const setField = (k: LabelFieldKey, v: boolean) =>
    setCfg(c => (c ? { ...c, design: { ...c.design, fields: { ...c.design.fields, [k]: v } } } : c));

  const save = async () => {
    if (!cfg) return;
    setSaving(true); setError(null);
    try {
      const r = await api('/api/settings/label-printer', { method: 'POST', body: { printer: cfg } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onSaved(j.printer);
      onClose();
    } catch (e: any) { setError(e?.message || 'Failed to save'); }
    finally { setSaving(false); }
  };

  // Live preview of the current design (same renderer + config the printer uses).
  const designPreview = cfg
    ? labelPreview(SAMPLE_LABEL_BATCH, {
        qr: cfg.qr,
        labelWidthMm: cfg.label_width_mm,
        labelHeightMm: cfg.label_height_mm,
        design: cfg.design,
      })
    : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl shadow-xl my-4" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#E8D5C4] flex items-center justify-between">
          <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">
            <Settings className="w-5 h-5 text-[#af4408]" /> Label Printer &amp; Design
          </div>
          <button onClick={onClose} disabled={saving} className="text-[#8B7355] hover:text-[#2D1B0E] disabled:opacity-50"><X className="w-5 h-5" /></button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
        ) : cfg ? (
          <>
            <div className="px-5 pt-4">
              <div className="flex gap-1 bg-[#FFF1E3] rounded-xl p-1 w-fit">
                {([['printer', 'Printer', Printer], ['design', 'Label design', Eye]] as const).map(([k, label, Icon]) => (
                  <button key={k} type="button" onClick={() => setTab(k)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold ${tab === k ? 'bg-[#af4408] text-white' : 'text-[#6B5744]'}`}>
                    <Icon className="w-4 h-4" /> {label}
                  </button>
                ))}
              </div>
            </div>

            {tab === 'printer' ? (
              <div className="p-5 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Mode">
                    <select value={cfg.mode} onChange={e => set('mode', e.target.value as LabelPrinterConfig['mode'])} className={inputCls}>
                      <option value="tspl">TSPL (TE210 native)</option>
                      <option value="bartender">BarTender</option>
                    </select>
                  </Field>
                  <Field label="Transport">
                    <select value={cfg.transport} onChange={e => set('transport', e.target.value as LabelPrinterConfig['transport'])} className={inputCls}>
                      <option value="usb">USB</option>
                      <option value="ip">Network (IP)</option>
                    </select>
                  </Field>
                </div>
                <Field label={cfg.transport === 'ip' ? 'Target (host:port)' : 'Target (USB queue / share name)'}>
                  <input value={cfg.target} onChange={e => set('target', e.target.value)}
                         placeholder={cfg.transport === 'ip' ? '192.168.1.60:9100' : 'TE210'} className={inputCls} />
                </Field>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Width (mm)">
                    <input type="number" min={1} value={cfg.label_width_mm} onChange={e => set('label_width_mm', Number(e.target.value))} className={inputCls} />
                  </Field>
                  <Field label="Height (mm)">
                    <input type="number" min={1} value={cfg.label_height_mm} onChange={e => set('label_height_mm', Number(e.target.value))} className={inputCls} />
                  </Field>
                  <Field label="Copies">
                    <input type="number" min={1} value={cfg.copies} onChange={e => set('copies', Number(e.target.value))} className={inputCls} />
                  </Field>
                </div>
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-sm text-[#6B5744]">
                    <input type="checkbox" checked={cfg.qr} onChange={e => set('qr', e.target.checked)} className="accent-[#af4408]" />
                    Add a QR code to every label by default
                  </label>
                  <label className="flex items-center gap-2 text-sm text-[#6B5744]">
                    <input type="checkbox" checked={cfg.print_preview} onChange={e => set('print_preview', e.target.checked)} className="accent-[#af4408]" />
                    Show preview before printing
                  </label>
                </div>
                {cfg.mode === 'bartender' && (
                  <Field label="BarTender template (.btw)">
                    <input value={cfg.bartender_template} onChange={e => set('bartender_template', e.target.value)}
                           placeholder="C:\labels\batch.btw" className={inputCls} />
                  </Field>
                )}
              </div>
            ) : (
              <div className="p-5 grid md:grid-cols-2 gap-5 items-start">
                {/* Design controls */}
                <div className="space-y-4">
                  <p className="text-xs text-[#8B7355]">Sizes apply to both the on-screen preview and the printed label. The label prints with a 2 mm safe margin and rounded corners.</p>
                  <div>
                    <div className="flex items-center justify-between text-sm font-semibold text-[#8B7355]">
                      <span>Item name size</span><span className="text-[#af4408]">{cfg.design.title_scale.toFixed(1)}×</span>
                    </div>
                    <input type="range" min={0.8} max={3} step={0.1} value={cfg.design.title_scale}
                           onChange={e => setDesign('title_scale', Number(e.target.value))} className="w-full accent-[#af4408]" />
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-sm font-semibold text-[#8B7355]">
                      <span>Detail text size (Batch / Prepared / Expiry / Qty / By / Loc)</span><span className="text-[#af4408]">{cfg.design.field_scale.toFixed(1)}×</span>
                    </div>
                    <input type="range" min={0.8} max={3} step={0.1} value={cfg.design.field_scale}
                           onChange={e => setDesign('field_scale', Number(e.target.value))} className="w-full accent-[#af4408]" />
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-sm font-semibold text-[#8B7355]">
                      <span>Barcode height</span><span className="text-[#af4408]">{cfg.design.barcode_height} dots</span>
                    </div>
                    <input type="range" min={20} max={90} step={2} value={cfg.design.barcode_height}
                           onChange={e => setDesign('barcode_height', Number(e.target.value))} className="w-full accent-[#af4408]" />
                  </div>
                  <label className="flex items-center gap-2 text-sm text-[#6B5744]">
                    <input type="checkbox" checked={cfg.design.show_barcode_text} onChange={e => setDesign('show_barcode_text', e.target.checked)} className="accent-[#af4408]" />
                    Print the barcode number under the bars
                  </label>
                  <div>
                    <div className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide mb-1">Show fields</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {LABEL_FIELD_KEYS.map(k => (
                        <label key={k} className="flex items-center gap-2 text-sm text-[#6B5744]">
                          <input type="checkbox" checked={cfg.design.fields[k]} onChange={e => setField(k, e.target.checked)} className="accent-[#af4408]" />
                          {LABEL_FIELD_LABELS[k]}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
                {/* Live preview */}
                <div>
                  <p className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide mb-2 text-center">Live preview · {cfg.label_width_mm} × {cfg.label_height_mm} mm</p>
                  <div className="flex justify-center">
                    {designPreview && <LabelCanvas preview={designPreview} scale={7} />}
                  </div>
                  <p className="text-[11px] text-[#8B7355] text-center mt-2">Sample data — real batches fill their own values.</p>
                </div>
              </div>
            )}

            {error && <div className="mx-5 mb-2 bg-red-50 border border-red-200 rounded-lg p-2.5 text-sm text-red-700">{error}</div>}
            <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2">
              <button onClick={onClose} disabled={saving} className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">Cancel</button>
              <button onClick={save} disabled={saving} className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
              </button>
            </div>
          </>
        ) : (
          <div className="p-6 text-sm text-red-700">{error || 'Failed to load settings.'}</div>
        )}
      </div>
    </div>
  );
}
