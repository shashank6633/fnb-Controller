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

import { useEffect, useMemo, useState } from 'react';
import {
  ChefHat, Plus, Loader2, RefreshCw, Search, X, Package, Clock, MapPin,
  User as UserIcon, AlertTriangle, CheckCircle2, History, Barcode as BarcodeIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { fmtIST, fmtISTDate, todayIST } from '@/lib/format-date';

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

// ─── Page ───────────────────────────────────────────────────────────────
export default function KitchenProductionPage() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<'active' | 'all'>('active');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
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
  const [recipes, setRecipes] = useState<RecipeOpt[]>([]);

  // One-shot: current user (for prepared_by default) + recipes for the dropdown.
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => {
      const n = d?.user?.name || d?.user?.email || '';
      setMeName(n);
      setForm(f => (f.prepared_by ? f : { ...f, prepared_by: n }));
    }).catch(() => {});
    fetch('/api/recipes').then(r => r.json()).then(d => {
      const list: any[] = Array.isArray(d) ? d : (d.recipes || d.list || d.items || []);
      setRecipes(list.map((r: any) => ({ id: r.id, name: r.name })).filter(r => r.id && r.name));
    }).catch(() => {});
  }, []);

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
          <button onClick={() => setRefreshKey(k => k + 1)}
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> Refresh
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

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}

      {/* Cards */}
      {loading ? (
        <div className="p-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading batches…
        </div>
      ) : batches.length === 0 ? (
        <div className="p-10 bg-white border border-[#E8D5C4] rounded-xl text-center text-sm text-[#8B7355]">
          <Package className="w-8 h-8 mx-auto mb-2 text-[#D4B896]" />
          {search || category
            ? 'No batches match your filters.'
            : statusFilter === 'active'
              ? 'No active production batches yet. Click “New Production Batch” to log one.'
              : 'No production batches recorded yet.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {batches.map(b => (
            <BatchCard key={b.id} batch={b} onOpen={() => setDetailId(b.id)} />
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
        <BatchDetailDrawer id={detailId} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}

// ─── Batch card ─────────────────────────────────────────────────────────
function BatchCard({ batch, onOpen }: { batch: Batch; onOpen: () => void }) {
  const tone = EXPIRY_TONE[batch.expiry_status] || EXPIRY_TONE.green;
  const remaining = batch.remaining_quantity ?? Math.max(0, batch.quantity_produced - batch.quantity_consumed);
  return (
    <button onClick={onOpen}
            className={`text-left bg-white border-2 ${tone.border} rounded-xl p-4 hover:shadow-md transition-shadow flex flex-col gap-3`}>
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
    </button>
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
function BatchDetailDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [id]);

  const tone = batch ? (EXPIRY_TONE[batch.expiry_status] || EXPIRY_TONE.green) : EXPIRY_TONE.green;

  return (
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
