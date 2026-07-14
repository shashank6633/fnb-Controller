'use client';

/**
 * Liquor Store — per-store inventory page (Phase B of the multi-store engine).
 *
 * Everything renders from DYNAMIC store config (store_locations +
 * store_category_map + store_user_access): a future Wine Cellar shows up here
 * automatically via the store picker (hidden while only one store is active).
 *
 * Sections: STOCK (search + category chips + totals), NEW PURCHASE
 * (can_procure), ADJUSTMENT incl. one-time OPENING (can_adjust), LEDGER tab
 * (type chips / material search / date range), CLOSING STOCK tab
 * (can_close_stock — independent daily physical counts, Phase C) and REPORTS
 * tab (11 store-scoped reports + CSV download, Phase D). Store closing is
 * COMPLETELY separate from the central /closing-stock module.
 *
 * In-page gate: /api/stores/[id]/my-access → can_view (the APIs also 403
 * server-side, this is just the 🔒 UX). Stock quantities are RECIPE units on
 * the ledger; the page shows purchase-unit equivalents (÷ pack_size) alongside.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Wine, Plus, Search, X, Loader2, AlertCircle, AlertTriangle, CheckCircle2,
  SlidersHorizontal, ScrollText, Boxes, Warehouse, ClipboardCheck, BarChart3,
  Download, History, Save, ReceiptText, ArrowRightLeft, Trash2,
} from 'lucide-react';
import { api } from '@/lib/api';
import TabScroller from '@/components/TabScroller';
import MaterialTypeahead, { MaterialLite } from '@/components/MaterialTypeahead';
import {
  packFactor, caseFactor, entryMode, tripleToRecipe, fmtBreakdown, PackMeta,
} from '@/lib/pack-units';

/* ── Types ─────────────────────────────────────────────────────────────── */

interface StoreLite { id: string; name: string; code: string; is_active: number; }
interface Access { can_view: boolean; can_procure: boolean; can_adjust: boolean; can_close_stock: boolean; }
interface StockRow {
  material_id: string; material_name: string; category: string; unit: string;
  qty: number; avg_cost: number; value: number;
  sku: string; purchase_unit: string; pack_size: number; case_size: number;
  reorder_level: number;
  central_stock: number; average_price: number; has_ledger: boolean;
}
interface MatRow {
  id: string; name: string; sku: string; category: string; unit: string;
  purchase_unit: string; pack_size: number; case_size: number;
  reorder_level: number; average_price: number;
}
interface LedgerRow {
  id: string; txn_type: string; quantity: number; unit_cost: number;
  batch_no: string; supplier: string; vendor_id: string; expiry_date: string;
  ref: string; notes: string; created_by: string; created_at: string;
  material_name: string; unit: string; purchase_unit: string; pack_size: number;
  case_size: number;
}
interface VendorLite { id: string; name: string; }
/** Ledger render item: a plain row, or a bill-subtotal marker after a group
 *  of consecutive 'purchase' rows sharing one non-empty invoice ref. */
type LedgerItem =
  | { kind: 'row'; row: LedgerRow }
  | { kind: 'bill'; ref: string; count: number; total: number; supplier: string };

/* ── Helpers ───────────────────────────────────────────────────────────── */

const packConv = packFactor;   // recipe units per bottle (1 = no conversion)
const fq = (v: number, dp = 2) =>
  Number((Number(v) || 0).toFixed(dp)).toLocaleString('en-IN');
const inr = (v: number, dp = 2) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: dp });
const today = () => new Date().toISOString().slice(0, 10);
const numOr0 = (s?: string) => {
  const n = Number(s);
  return s != null && s !== '' && Number.isFinite(n) ? n : 0;
};

/* One quantity: '2 cs + 9 btl + 450 ml' (bold) with '· 25,200 ml' alongside.
   Plain-unit materials (pack_size ≤ 1) render exactly as before. */
function DualQty({ qty, m, boldCls, sign }: {
  qty: number; m: PackMeta; boldCls: string; sign?: boolean;
}) {
  const dual = fmtBreakdown(qty, m);
  const ru = String(m.unit || '');
  if (!dual) {
    return <span className={boldCls}>{sign && qty > 0 ? '+' : ''}{fq(qty)} {ru}</span>;
  }
  return (
    <>
      <span className={boldCls}>{sign && qty >= 0 ? '+' : ''}{dual}</span>
      <span className="text-[11px] text-[#8B7355] font-normal"> · {fq(qty)} {ru}</span>
    </>
  );
}

/* ── Cases + Bottles + loose triple entry (bar counting convention) ──────
   Degrades with the material: case_size ≤ 1 → Bottles + loose only;
   pack_size ≤ 1 → a single plain recipe-unit input (unchanged behaviour).
   Values live as raw strings (blank = 0); shows the live conversion line
   '2 cs + 9 btl + 450 ml = 25,200 ml'. */

interface CBLValue { cases: string; bottles: string; loose: string; }
const CBL_EMPTY: CBLValue = { cases: '', bottles: '', loose: '' };
const cblRecipe = (m: PackMeta | null, v: CBLValue) =>
  m ? tripleToRecipe(numOr0(v.cases), numOr0(v.bottles), numOr0(v.loose), m) : numOr0(v.bottles);

function CBLEntry({ mat, value, onChange }: {
  mat: PackMeta | null; value: CBLValue; onChange: (v: CBLValue) => void;
}) {
  const mode = mat ? entryMode(mat) : 'plain';
  const bu = String(mat?.purchase_unit || mat?.unit || 'units');
  const ru = String(mat?.unit || 'units');
  const recipe = cblRecipe(mat, value);
  const touched = value.cases !== '' || value.bottles !== '' || value.loose !== '';
  const box = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]';
  if (mode === 'plain') {
    return (
      <div>
        <L>Qty ({ru})</L>
        <input type="number" min={0} step="any" inputMode="decimal" value={value.bottles}
               onChange={e => onChange({ ...value, bottles: e.target.value })}
               placeholder="e.g. 2" className={box} />
      </div>
    );
  }
  return (
    <div>
      <div className={`grid gap-2 ${mode === 'cbl' ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {mode === 'cbl' && (
          <div>
            <L>Cases</L>
            <input type="number" min={0} step="any" inputMode="decimal" value={value.cases}
                   onChange={e => onChange({ ...value, cases: e.target.value })}
                   placeholder="0" className={box}
                   title={mat ? `1 case = ${fq(caseFactor(mat))} ${bu}` : undefined} />
          </div>
        )}
        <div>
          <L>{bu}</L>
          <input type="number" min={0} step="any" inputMode="decimal" value={value.bottles}
                 onChange={e => onChange({ ...value, bottles: e.target.value })}
                 placeholder="0" className={box}
                 title={mat ? `1 ${bu} = ${fq(packFactor(mat))} ${ru}` : undefined} />
        </div>
        <div>
          <L>Loose ({ru})</L>
          <input type="number" min={0} step="any" inputMode="decimal" value={value.loose}
                 onChange={e => onChange({ ...value, loose: e.target.value })}
                 placeholder="0" className={box} />
        </div>
      </div>
      {mat && touched && (
        <div className="mt-1 text-[11px] text-[#6B5744] bg-[#FFF1E3] border border-[#E8D5C4] rounded px-2 py-1">
          {mode === 'cbl' ? `${numOr0(value.cases)} cs + ` : ''}
          {`${numOr0(value.bottles)} ${bu.toLowerCase()} + ${numOr0(value.loose)} ${ru}`}
          {' = '}<b>{fq(recipe)} {ru}</b>
        </div>
      )}
    </div>
  );
}

const TXN_TYPES = ['purchase', 'opening', 'adjustment', 'inward', 'outward', 'closing', 'transfer'];
const TXN_BADGE: Record<string, string> = {
  purchase:   'bg-emerald-50 border-emerald-200 text-emerald-800',
  opening:    'bg-sky-50 border-sky-200 text-sky-800',
  adjustment: 'bg-amber-50 border-amber-200 text-amber-800',
  inward:     'bg-emerald-50 border-emerald-200 text-emerald-800',
  outward:    'bg-red-50 border-red-200 text-red-700',
  closing:    'bg-purple-50 border-purple-200 text-purple-800',
  transfer:   'bg-blue-50 border-blue-200 text-blue-800',
};

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function LiquorStorePage() {
  const [stores, setStores] = useState<StoreLite[]>([]);          // active stores
  const [accessByStore, setAccessByStore] = useState<Record<string, Access>>({});
  const [storeId, setStoreId] = useState<string>('');
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  // Selected-store data
  const [stock, setStock] = useState<StockRow[]>([]);
  const [materials, setMaterials] = useState<MatRow[]>([]);
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [vendors, setVendors] = useState<VendorLite[]>([]);
  const [stockLoading, setStockLoading] = useState(false);

  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  const [tab, setTab] = useState<'stock' | 'ledger' | 'closing' | 'reports'>('stock');
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meRole, setMeRole] = useState<string>('');   // admin-only closing 'adjust' toggle

  // Stock filters
  const [q, setQ] = useState('');
  const [catFilter, setCatFilter] = useState('');

  // Ledger filters
  const [lType, setLType] = useState('');
  const [lQ, setLQ] = useState('');
  const [lFrom, setLFrom] = useState('');
  const [lTo, setLTo] = useState('');

  // Modals
  const [showPurchase, setShowPurchase] = useState(false);
  const [showAdjust, setShowAdjust] = useState(false);
  const [showBill, setShowBill] = useState(false);
  // Migration modal target: material_ids to preview, or 'all'
  const [migrateTarget, setMigrateTarget] = useState<string[] | 'all' | null>(null);

  const access: Access = accessByStore[storeId] ||
    { can_view: false, can_procure: false, can_adjust: false, can_close_stock: false };
  const store = stores.find(s => s.id === storeId) || null;

  // Closing tab is gated on can_close_stock — bounce off it after a store switch.
  useEffect(() => {
    if (tab === 'closing' && !access.can_close_stock) setTab('stock');
  }, [tab, access.can_close_stock]);

  /* Boot: active stores + my access per store */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Role (for the admin-only "adjust to physical" toggle on Closing)
        fetch('/api/auth/me').then(r => r.json()).then(j => {
          if (!cancelled) setMeRole(j?.user?.role || '');
        }).catch(() => {});
        const r = await fetch('/api/stores');
        const j = await r.json();
        if (j.error) throw new Error(j.error);
        const active: StoreLite[] = (j.stores || []).filter((s: any) => s.is_active);
        const accEntries = await Promise.all(active.map(async s => {
          const ar = await fetch(`/api/stores/${s.id}/my-access`);
          const aj = await ar.json().catch(() => ({}));
          return [s.id, (aj.access || { can_view: false, can_procure: false, can_adjust: false, can_close_stock: false })] as const;
        }));
        if (cancelled) return;
        const accMap = Object.fromEntries(accEntries);
        setStores(active);
        setAccessByStore(accMap);
        const firstViewable = active.find(s => accMap[s.id]?.can_view);
        setStoreId(firstViewable ? firstViewable.id : (active[0]?.id || ''));
      } catch (e: any) {
        if (!cancelled) setBootError(e.message);
      } finally {
        if (!cancelled) setBootLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* Load stock for selected store */
  const loadStock = useCallback(async () => {
    if (!storeId || !accessByStore[storeId]?.can_view) return;
    setStockLoading(true); setError(null);
    try {
      const r = await fetch(`/api/stores/${storeId}/stock`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setStock(j.stock || []);
      setMaterials(j.materials || []);
      setSuppliers(j.recent_suppliers || []);
      setVendors(j.vendors || []);
    } catch (e: any) { setError(e.message); }
    finally { setStockLoading(false); }
  }, [storeId, accessByStore]);

  /* Load ledger for selected store (server-side filters) */
  const loadLedger = useCallback(async () => {
    if (!storeId || !accessByStore[storeId]?.can_view) return;
    setLedgerLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      if (lType) p.set('type', lType);
      if (lQ.trim()) p.set('q', lQ.trim());
      if (lFrom) p.set('from', lFrom);
      if (lTo) p.set('to', lTo);
      const r = await fetch(`/api/stores/${storeId}/ledger?${p.toString()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setLedger(j.ledger || []);
    } catch (e: any) { setError(e.message); }
    finally { setLedgerLoading(false); }
  }, [storeId, accessByStore, lType, lQ, lFrom, lTo]);

  useEffect(() => { loadStock(); }, [loadStock]);
  useEffect(() => { loadLedger(); }, [loadLedger]);

  const afterWrite = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 5000);
    loadStock(); loadLedger();
  };

  /* Stock derived */
  const cats = useMemo(
    () => Array.from(new Set(stock.map(r => r.category))).sort((a, b) => a.localeCompare(b)),
    [stock],
  );
  const filtered = useMemo(() => {
    const raw = q.trim().toLowerCase();
    return stock.filter(r => {
      if (catFilter && r.category !== catFilter) return false;
      if (!raw) return true;
      return `${r.material_name} ${r.sku} ${r.category}`.toLowerCase().includes(raw);
    });
  }, [stock, q, catFilter]);
  const totals = useMemo(() => ({
    items: filtered.length,
    value: filtered.reduce((s, r) => s + (Number(r.value) || 0), 0),
    low: filtered.filter(r => r.reorder_level > 0 && r.qty < r.reorder_level).length,
  }), [filtered]);
  // Stock now lists EVERY mapped material (zero-ledger rows included at qty 0)
  // — "has history" must come from the has_ledger flag, not mere presence.
  const hasHistory = useMemo(
    () => new Set(stock.filter(r => r.has_ledger).map(r => r.material_id)),
    [stock],
  );
  const isAdmin = meRole === 'admin';
  // Central-migration candidates: mapped, central stock > 0, no store history.
  const migratable = useMemo(
    () => stock.filter(r => (Number(r.central_stock) || 0) > 0 && !r.has_ledger),
    [stock],
  );
  const migrateBlocked = useMemo(
    () => stock.filter(r => (Number(r.central_stock) || 0) > 0 && r.has_ledger),
    [stock],
  );

  /* Ledger + bill subtotals: bulk-bill lines share ref + created_at, so they
     sit consecutively (newest first). A group of >1 purchase rows with the
     same non-empty ref gets a subtotal marker appended. */
  const ledgerItems = useMemo<LedgerItem[]>(() => {
    const out: LedgerItem[] = [];
    let i = 0;
    while (i < ledger.length) {
      const l = ledger[i];
      const ref = l.txn_type === 'purchase' ? String(l.ref || '').trim() : '';
      let j = i;
      while (j < ledger.length && ref !== '' &&
             ledger[j].txn_type === 'purchase' && String(ledger[j].ref || '').trim() === ref) j++;
      if (j === i) j = i + 1;
      const group = ledger.slice(i, j);
      for (const g of group) out.push({ kind: 'row', row: g });
      if (ref !== '' && group.length > 1) {
        out.push({
          kind: 'bill', ref, count: group.length,
          total: Math.round(group.reduce((s, g) => s + (Number(g.quantity) || 0) * (Number(g.unit_cost) || 0), 0) * 100) / 100,
          supplier: group[0].supplier || '',
        });
      }
      i = j;
    }
    return out;
  }, [ledger]);

  /* ── Render ── */

  if (bootLoading) {
    return (
      <div className="p-8 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    );
  }
  if (bootError) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {bootError}
        </div>
      </div>
    );
  }
  if (stores.length === 0) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          No active store locations. An admin can add one on Settings → Store Locations.
        </div>
      </div>
    );
  }
  if (!access.can_view) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-3">
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <Wine className="w-6 h-6 text-[#af4408]" /> Liquor Store
        </h1>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 You are not authorized for {store?.name || 'this store'}. Ask an admin to grant you access
          on Settings → Store Locations.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <Wine className="w-6 h-6 text-[#af4408]" /> Liquor Store
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            {store?.name} — separate stock on its own ledger. Liquor purchases are recorded HERE,
            never on Central Store purchases.
          </p>
        </div>
        {stores.length > 1 && (
          <label className="flex items-center gap-1.5 text-xs text-[#6B5744]">
            <Warehouse className="w-4 h-4 text-[#af4408]" />
            <select value={storeId} onChange={e => setStoreId(e.target.value)}
                    className="px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]">
              {stores.filter(s => accessByStore[s.id]?.can_view).map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
        )}
        {access.can_adjust && (
          <button onClick={() => setShowAdjust(true)}
                  className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm font-medium flex items-center gap-1.5">
            <SlidersHorizontal className="w-4 h-4" /> Adjustment
          </button>
        )}
        {access.can_procure && (
          <button onClick={() => setShowPurchase(true)}
                  className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm font-medium flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> New Purchase
          </button>
        )}
        {access.can_procure && (
          <button onClick={() => setShowBill(true)}
                  className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5">
            <ReceiptText className="w-4 h-4" /> New Bill
          </button>
        )}
      </div>

      {flash && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg p-3 text-sm flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" /> {flash}
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Tabs */}
      <TabScroller className="gap-2">
        <button onClick={() => setTab('stock')}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border flex items-center gap-1.5 ${
                  tab === 'stock' ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
          <Boxes className="w-3.5 h-3.5" /> Stock
        </button>
        <button onClick={() => setTab('ledger')}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border flex items-center gap-1.5 ${
                  tab === 'ledger' ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
          <ScrollText className="w-3.5 h-3.5" /> Ledger
        </button>
        {access.can_close_stock && (
          <button onClick={() => setTab('closing')}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border flex items-center gap-1.5 ${
                    tab === 'closing' ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
            <ClipboardCheck className="w-3.5 h-3.5" /> Closing Stock
          </button>
        )}
        <button onClick={() => setTab('reports')}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border flex items-center gap-1.5 ${
                  tab === 'reports' ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
          <BarChart3 className="w-3.5 h-3.5" /> Reports
        </button>
      </TabScroller>

      {tab === 'stock' ? (
        <>
          {/* Search + category filter */}
          <div className="space-y-2">
            <div className="relative max-w-md">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, SKU, category…"
                     className="w-full pl-8 pr-8 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white" />
              {q && (
                <button onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8B7355] hover:text-[#2D1B0E]">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            {cats.length > 1 && (
              <TabScroller className="gap-1.5">
                <button onClick={() => setCatFilter('')}
                        className={`px-2.5 py-1 rounded-full text-[11px] border ${!catFilter ? 'bg-[#2D1B0E] border-[#2D1B0E] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
                  All ({stock.length})
                </button>
                {cats.map(c => (
                  <button key={c} onClick={() => setCatFilter(catFilter === c ? '' : c)}
                          className={`px-2.5 py-1 rounded-full text-[11px] border ${catFilter === c ? 'bg-[#2D1B0E] border-[#2D1B0E] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
                    {c}
                  </button>
                ))}
              </TabScroller>
            )}
          </div>

          {/* Totals bar */}
          <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl px-3 sm:px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            <span className="text-[#6B5744]"><b className="text-[#2D1B0E]">{totals.items}</b> item{totals.items === 1 ? '' : 's'}</span>
            <span className="text-[#6B5744]">Stock value <b className="text-[#2D1B0E]">{inr(totals.value)}</b></span>
            {totals.low > 0 && (
              <span className="text-red-700 flex items-center gap-1 text-xs font-medium">
                <AlertTriangle className="w-3.5 h-3.5" /> {totals.low} low stock
              </span>
            )}
            {isAdmin && migratable.length > 0 && (
              <button onClick={() => setMigrateTarget('all')}
                      className="ml-auto px-2.5 py-1 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-xs font-medium flex items-center gap-1.5">
                <ArrowRightLeft className="w-3.5 h-3.5" /> Migrate all central stock ({migratable.length})
              </button>
            )}
          </div>

          {/* Stock list */}
          {stockLoading ? (
            <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading stock…</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">
              {stock.length === 0
                ? `No stock yet. ${access.can_procure ? 'Record your first purchase with “New Purchase”' : 'Purchases will appear here'} — or set opening stock via Adjustment.`
                : 'Nothing matches the current filters.'}
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-[#FFF1E3] text-[#8B7355] text-xs">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Material</th>
                        <th className="text-left px-3 py-2 font-medium">Category</th>
                        <th className="text-right px-3 py-2 font-medium">On hand</th>
                        <th className="text-right px-3 py-2 font-medium">Avg cost</th>
                        <th className="text-right px-3 py-2 font-medium">Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F0E4D6]">
                      {filtered.map(r => {
                        const pc = packConv(r);
                        const low = r.reorder_level > 0 && r.qty < r.reorder_level;
                        const central = Number(r.central_stock) || 0;
                        return (
                          <tr key={r.material_id} className="hover:bg-[#FFF8F0]">
                            <td className="px-3 py-2">
                              <div className="text-[#2D1B0E] font-medium">{r.material_name}</div>
                              {r.sku && <div className="text-[10px] font-mono text-[#8B7355]">{r.sku}</div>}
                            </td>
                            <td className="px-3 py-2 text-[#6B5744] text-xs">{r.category}</td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              <DualQty qty={r.qty} m={r} boldCls={`font-semibold ${low ? 'text-red-700' : 'text-[#2D1B0E]'}`} />
                              {low && (
                                <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] text-red-700 bg-red-50 border border-red-200 rounded-full px-1.5 py-px align-middle">
                                  <AlertTriangle className="w-3 h-3" /> low
                                </span>
                              )}
                              {central > 0 && (
                                <div className="text-[10px] text-[#8B7355] mt-0.5">
                                  In central: {fmtBreakdown(central, r) || `${fq(central)} ${r.unit}`}
                                  {isAdmin && !r.has_ledger && (
                                    <button onClick={() => setMigrateTarget([r.material_id])}
                                            className="ml-1.5 px-1.5 py-px border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded text-[10px] font-medium align-middle">
                                      Migrate
                                    </button>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap text-[#6B5744]">
                              {inr(r.avg_cost, 4)}/{r.unit}
                              {pc > 1 && <div className="text-[10px] text-[#8B7355]">{inr(r.avg_cost * pc)}/{r.purchase_unit}</div>}
                            </td>
                            <td className="px-3 py-2 text-right font-medium text-[#2D1B0E] whitespace-nowrap">{inr(r.value)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden space-y-2">
                {filtered.map(r => {
                  const low = r.reorder_level > 0 && r.qty < r.reorder_level;
                  const central = Number(r.central_stock) || 0;
                  return (
                    <div key={r.material_id} className="bg-white border border-[#E8D5C4] rounded-xl p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-[#2D1B0E] break-words">{r.material_name}</div>
                          <div className="text-[10px] text-[#8B7355]">{r.sku && <span className="font-mono">{r.sku} · </span>}{r.category}</div>
                        </div>
                        {low && (
                          <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] text-red-700 bg-red-50 border border-red-200 rounded-full px-1.5 py-0.5">
                            <AlertTriangle className="w-3 h-3" /> low
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-[#6B5744]">
                        <span>
                          <DualQty qty={r.qty} m={r} boldCls={`font-bold ${low ? 'text-red-700' : 'text-[#2D1B0E]'}`} />
                        </span>
                        <span>{inr(r.avg_cost, 4)}/{r.unit}</span>
                        <span className="ml-auto font-semibold text-[#2D1B0E]">{inr(r.value)}</span>
                      </div>
                      {central > 0 && (
                        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-[#8B7355]">
                          <span>In central: {fmtBreakdown(central, r) || `${fq(central)} ${r.unit}`}</span>
                          {isAdmin && !r.has_ledger && (
                            <button onClick={() => setMigrateTarget([r.material_id])}
                                    className="px-1.5 py-px border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded text-[10px] font-medium">
                              Migrate
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      ) : tab === 'closing' && store ? (
        <ClosingSection
          storeId={store.id} storeName={store.name}
          stock={stock} isAdmin={meRole === 'admin'}
          onSaved={afterWrite}
        />
      ) : tab === 'reports' && store ? (
        <ReportsSection storeId={store.id} storeCode={store.code || 'store'} />
      ) : (
        <>
          {/* Ledger filters */}
          <div className="space-y-2">
            <TabScroller className="gap-1.5">
              <button onClick={() => setLType('')}
                      className={`px-2.5 py-1 rounded-full text-[11px] border ${!lType ? 'bg-[#2D1B0E] border-[#2D1B0E] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
                All types
              </button>
              {TXN_TYPES.map(t => (
                <button key={t} onClick={() => setLType(lType === t ? '' : t)}
                        className={`px-2.5 py-1 rounded-full text-[11px] border capitalize ${lType === t ? 'bg-[#2D1B0E] border-[#2D1B0E] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
                  {t}
                </button>
              ))}
            </TabScroller>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[160px] max-w-xs">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
                <input value={lQ} onChange={e => setLQ(e.target.value)} placeholder="Material…"
                       className="w-full pl-8 pr-2 py-1.5 border border-[#E8D5C4] rounded-lg text-sm bg-white" />
              </div>
              <input type="date" value={lFrom} onChange={e => setLFrom(e.target.value)} aria-label="From date"
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-sm bg-white" />
              <span className="text-xs text-[#8B7355]">→</span>
              <input type="date" value={lTo} onChange={e => setLTo(e.target.value)} aria-label="To date"
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-sm bg-white" />
              {(lFrom || lTo || lQ || lType) && (
                <button onClick={() => { setLFrom(''); setLTo(''); setLQ(''); setLType(''); }}
                        className="text-xs text-[#af4408] hover:underline">clear</button>
              )}
            </div>
          </div>

          {ledgerLoading ? (
            <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading ledger…</div>
          ) : ledger.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">No ledger entries match.</div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] text-xs">
                    <thead className="bg-[#FFF1E3] text-[#8B7355]">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Date</th>
                        <th className="text-left px-3 py-2 font-medium">Type</th>
                        <th className="text-left px-3 py-2 font-medium">Material</th>
                        <th className="text-right px-3 py-2 font-medium">Qty</th>
                        <th className="text-right px-3 py-2 font-medium">Unit cost</th>
                        <th className="text-left px-3 py-2 font-medium">Batch</th>
                        <th className="text-left px-3 py-2 font-medium">Supplier</th>
                        <th className="text-left px-3 py-2 font-medium">Ref / notes</th>
                        <th className="text-left px-3 py-2 font-medium">By</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F0E4D6]">
                      {ledgerItems.map((item, idx) => {
                        if (item.kind === 'bill') {
                          return (
                            <tr key={`bill-${item.ref}-${idx}`} className="bg-[#FFF1E3]/70">
                              <td colSpan={9} className="px-3 py-1.5 text-[11px] text-[#6B5744]">
                                <ReceiptText className="w-3.5 h-3.5 inline mr-1 text-[#af4408]" />
                                Bill <span className="font-mono">{item.ref}</span>
                                {item.supplier ? ` · ${item.supplier}` : ''} — {item.count} lines,
                                subtotal <b className="text-[#2D1B0E]">{inr(item.total)}</b>
                              </td>
                            </tr>
                          );
                        }
                        const l = item.row;
                        return (
                          <tr key={l.id} className="hover:bg-[#FFF8F0] align-top">
                            <td className="px-3 py-2 whitespace-nowrap text-[#6B5744]">{String(l.created_at).slice(0, 16)}</td>
                            <td className="px-3 py-2">
                              <span className={`inline-block border rounded-full px-2 py-0.5 text-[10px] capitalize ${TXN_BADGE[l.txn_type] || 'bg-gray-50 border-gray-200 text-gray-600'}`}>
                                {l.txn_type}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-[#2D1B0E]">{l.material_name}</td>
                            <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${l.quantity < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                              <DualQty qty={l.quantity} m={l} sign
                                       boldCls={`font-medium ${l.quantity < 0 ? 'text-red-700' : 'text-emerald-700'}`} />
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap text-[#6B5744]">
                              {l.unit_cost > 0 ? <>{inr(l.unit_cost, 4)}/{l.unit}</> : '—'}
                            </td>
                            <td className="px-3 py-2 text-[#6B5744]">
                              {l.batch_no || '—'}
                              {l.expiry_date && <div className="text-[10px] text-[#8B7355]">exp {l.expiry_date}</div>}
                            </td>
                            <td className="px-3 py-2 text-[#6B5744]">{l.supplier || '—'}</td>
                            <td className="px-3 py-2 text-[#6B5744] max-w-[220px]">
                              {l.ref && <div className="font-mono text-[10px]">{l.ref}</div>}
                              {l.notes && <div className="break-words">{l.notes}</div>}
                              {!l.ref && !l.notes && '—'}
                            </td>
                            <td className="px-3 py-2 text-[#8B7355] whitespace-nowrap">{(l.created_by || '').split('@')[0] || '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden space-y-2">
                {ledgerItems.map((item, idx) => {
                  if (item.kind === 'bill') {
                    return (
                      <div key={`bill-${item.ref}-${idx}`}
                           className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl px-3 py-2 text-[11px] text-[#6B5744]">
                        <ReceiptText className="w-3.5 h-3.5 inline mr-1 text-[#af4408]" />
                        Bill <span className="font-mono">{item.ref}</span>
                        {item.supplier ? ` · ${item.supplier}` : ''} — {item.count} lines,
                        subtotal <b className="text-[#2D1B0E]">{inr(item.total)}</b>
                      </div>
                    );
                  }
                  const l = item.row;
                  return (
                    <div key={l.id} className="bg-white border border-[#E8D5C4] rounded-xl p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`inline-block border rounded-full px-2 py-0.5 text-[10px] capitalize ${TXN_BADGE[l.txn_type] || 'bg-gray-50 border-gray-200 text-gray-600'}`}>
                          {l.txn_type}
                        </span>
                        <span className="text-[10px] text-[#8B7355]">{String(l.created_at).slice(0, 16)}</span>
                      </div>
                      <div className="mt-1.5 text-sm font-medium text-[#2D1B0E] break-words">{l.material_name}</div>
                      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[#6B5744]">
                        <span>
                          <DualQty qty={l.quantity} m={l} sign
                                   boldCls={`font-semibold ${l.quantity < 0 ? 'text-red-700' : 'text-emerald-700'}`} />
                        </span>
                        {l.unit_cost > 0 && <span>{inr(l.unit_cost, 4)}/{l.unit}</span>}
                      </div>
                      <div className="mt-1 text-[10px] text-[#8B7355] space-x-2">
                        {l.supplier && <span>{l.supplier}</span>}
                        {l.batch_no && <span>batch {l.batch_no}</span>}
                        {l.expiry_date && <span>exp {l.expiry_date}</span>}
                        {l.ref && <span className="font-mono">{l.ref}</span>}
                        {l.created_by && <span>by {(l.created_by || '').split('@')[0]}</span>}
                      </div>
                      {l.notes && <div className="mt-1 text-[10px] text-[#6B5744] break-words">{l.notes}</div>}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {showPurchase && store && (
        <PurchaseModal
          storeId={store.id} storeName={store.name}
          materials={materials} suppliers={suppliers} vendors={vendors}
          onClose={() => setShowPurchase(false)}
          onSaved={msg => { setShowPurchase(false); afterWrite(msg); }}
        />
      )}
      {showAdjust && store && (
        <AdjustModal
          storeId={store.id} storeName={store.name}
          materials={materials} hasHistory={hasHistory}
          onClose={() => setShowAdjust(false)}
          onSaved={msg => { setShowAdjust(false); afterWrite(msg); }}
        />
      )}
      {showBill && store && (
        <BillModal
          storeId={store.id} storeName={store.name}
          materials={materials} suppliers={suppliers} vendors={vendors}
          onClose={() => setShowBill(false)}
          onSaved={msg => { setShowBill(false); afterWrite(msg); }}
        />
      )}
      {migrateTarget && store && (
        <MigrateModal
          storeId={store.id} storeName={store.name}
          candidates={migrateTarget === 'all'
            ? migratable
            : stock.filter(r => (migrateTarget as string[]).includes(r.material_id))}
          blockedCount={migrateTarget === 'all' ? migrateBlocked.length : 0}
          onClose={() => setMigrateTarget(null)}
          onDone={msg => { setMigrateTarget(null); afterWrite(msg); }}
        />
      )}
    </div>
  );
}

/* ── Shared modal shell (mobile-safe: max-h + internal scroll + sticky footer) */

function ModalShell({ title, icon, onClose, children, footer, wide }: {
  title: string; icon: React.ReactNode; onClose: () => void;
  children: React.ReactNode; footer: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto" onClick={onClose}>
      <div className={`bg-white rounded-xl border border-[#E8D5C4] w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} shadow-xl flex flex-col overflow-hidden`}
           style={{ maxHeight: 'calc(100vh - 1.5rem)' }} onClick={e => e.stopPropagation()}>
        <div className="px-4 sm:px-5 py-3 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">{icon} {title}</div>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-3">{children}</div>
        <div className="px-4 sm:px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0 bg-white">{footer}</div>
      </div>
    </div>
  );
}

const L = ({ children }: { children: React.ReactNode }) => (
  <label className="block text-[10px] uppercase tracking-wide text-[#8B7355] mb-0.5">{children}</label>
);
const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]';

/* ── New Purchase modal ────────────────────────────────────────────────── */

function PurchaseModal({ storeId, storeName, materials, suppliers, vendors, onClose, onSaved }: {
  storeId: string; storeName: string;
  materials: MatRow[]; suppliers: string[]; vendors: VendorLite[];
  onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [materialId, setMaterialId] = useState('');
  const [cbl, setCbl] = useState<CBLValue>(CBL_EMPTY);
  const [price, setPrice] = useState('');
  const [date, setDate] = useState(today());
  const [supplier, setSupplier] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [batch, setBatch] = useState('');
  const [expiry, setExpiry] = useState('');
  const [invoiceRef, setInvoiceRef] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mat = materials.find(m => m.id === materialId) || null;
  const pc = mat ? packConv(mat) : 1;
  const pu = mat ? (mat.purchase_unit || mat.unit) : '';
  const nPrice = Number(price) || 0;
  const recipeQty = cblRecipe(mat, cbl);                       // recipe units
  const bottleQty = pc > 1 ? recipeQty / pc : recipeQty;       // purchase units (₹ total)
  const totalCost = bottleQty * nPrice;

  const save = async () => {
    setErr(null);
    if (!materialId) { setErr('Pick a material'); return; }
    if (!(recipeQty > 0)) { setErr('Enter a quantity — cases, bottles and/or loose'); return; }
    if (!(nPrice >= 0) || price === '') { setErr(`Enter the price per ${pu || 'purchase unit'}`); return; }
    setBusy(true);
    try {
      const r = await api(`/api/stores/${storeId}/procure`, {
        method: 'POST',
        body: {
          material_id: materialId,
          cases: numOr0(cbl.cases), bottles: numOr0(cbl.bottles), loose: numOr0(cbl.loose),
          unit_price: nPrice,
          supplier: supplier.trim(), vendor_id: vendorId || undefined,
          batch_no: batch.trim(), expiry_date: expiry, invoice_ref: invoiceRef.trim(),
          notes: notes.trim(), date,
        },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onSaved(`Recorded ${mat ? fmtBreakdown(recipeQty, mat) || `${fq(recipeQty)} ${mat.unit}` : ''} of ${mat?.name} into ${storeName} (${inr(j.total ?? totalCost)})`);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <ModalShell title="New Store Purchase" icon={<Wine className="w-5 h-5 text-[#af4408]" />} onClose={onClose}
      footer={<>
        <button onClick={onClose} disabled={busy}
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">Cancel</button>
        <button onClick={save} disabled={busy || !materialId}
                className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Save purchase{recipeQty > 0 && nPrice > 0 ? ` — ${inr(totalCost)}` : ''}
        </button>
      </>}>
      <p className="text-[11px] text-[#8B7355] -mt-1">
        {`Goes straight to the ${storeName} ledger — Central Store purchases & costing are untouched.`}
      </p>
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-sm text-red-700">{err}</div>}

      <div>
        <L>Material ({materials.length} mapped to this store)</L>
        <MaterialTypeahead materials={materials as MaterialLite[]} value={materialId}
                           onPick={id => { setMaterialId(id); setCbl(CBL_EMPTY); }} showStock={false} compact={false}
                           placeholder="Type a liquor name, SKU or category…" />
        {mat && pc > 1 && (
          <div className="mt-1 text-[11px] text-[#6B5744] bg-[#FFF1E3] border border-[#E8D5C4] rounded px-2 py-1">
            {caseFactor(mat) > 1 && `1 case = ${fq(caseFactor(mat))} ${pu} · `}
            {`1 ${pu} = ${fq(mat.pack_size)} ${mat.unit}`}
          </div>
        )}
      </div>

      <CBLEntry mat={mat} value={cbl} onChange={setCbl} />
      <div>
        <L>Price / {mat ? pu : 'purchase unit'} (₹)</L>
        <input type="number" min={0} step="any" value={price} onChange={e => setPrice(e.target.value)}
               placeholder="e.g. 500" className={inputCls} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <L>Date</L>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} />
        </div>
        <div>
          <L>Invoice ref</L>
          <input value={invoiceRef} onChange={e => setInvoiceRef(e.target.value)} placeholder="INV-…" className={inputCls} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <L>Supplier</L>
          <input value={supplier} onChange={e => setSupplier(e.target.value)} list="liq-recent-suppliers"
                 placeholder="Type a supplier…" className={inputCls} />
          <datalist id="liq-recent-suppliers">
            {suppliers.map(s => <option key={s} value={s} />)}
          </datalist>
        </div>
        <div>
          <L>Vendor (optional)</L>
          <select value={vendorId} onChange={e => setVendorId(e.target.value)} className={inputCls}>
            <option value="">—</option>
            {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <L>Batch no.</L>
          <input value={batch} onChange={e => setBatch(e.target.value)} placeholder="optional" className={inputCls} />
        </div>
        <div>
          <L>Expiry</L>
          <input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} className={inputCls} />
        </div>
      </div>

      <div>
        <L>Notes</L>
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="optional" className={inputCls} />
      </div>
    </ModalShell>
  );
}

/* ── Adjustment / Opening modal ────────────────────────────────────────── */

function AdjustModal({ storeId, storeName, materials, hasHistory, onClose, onSaved }: {
  storeId: string; storeName: string;
  materials: MatRow[]; hasHistory: Set<string>;
  onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [materialId, setMaterialId] = useState('');
  const [sign, setSign] = useState<1 | -1>(1);
  const [cbl, setCbl] = useState<CBLValue>(CBL_EMPTY);
  const [reason, setReason] = useState('');
  const [opening, setOpening] = useState(false);
  const [openPrice, setOpenPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mat = materials.find(m => m.id === materialId) || null;
  const isNew = !!mat && !hasHistory.has(mat.id);
  const pu = mat ? (mat.purchase_unit || mat.unit) : '';
  const nQty = cblRecipe(mat, cbl);   // recipe units, unsigned

  // Opening is only offered for materials with zero ledger rows.
  useEffect(() => { if (!isNew) setOpening(false); }, [isNew]);

  const save = async () => {
    setErr(null);
    if (!materialId) { setErr('Pick a material'); return; }
    if (!(nQty > 0)) { setErr('Enter a quantity — cases, bottles and/or loose'); return; }
    if (!reason.trim()) { setErr('A reason is required'); return; }
    setBusy(true);
    try {
      const r = await api(`/api/stores/${storeId}/adjust`, {
        method: 'POST',
        body: {
          material_id: materialId,
          quantity: opening ? nQty : sign * nQty,
          reason: reason.trim(),
          txn_type: opening ? 'opening' : 'adjustment',
          unit_price: opening && openPrice !== '' ? Number(openPrice) : undefined,
        },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onSaved(`${opening ? 'Opening stock set' : 'Adjustment recorded'} for ${mat?.name} in ${storeName}`);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <ModalShell title="Stock Adjustment" icon={<SlidersHorizontal className="w-5 h-5 text-[#af4408]" />} onClose={onClose}
      footer={<>
        <button onClick={onClose} disabled={busy}
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">Cancel</button>
        <button onClick={save} disabled={busy || !materialId}
                className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          {opening ? 'Set opening stock' : 'Save adjustment'}
        </button>
      </>}>
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-sm text-red-700">{err}</div>}

      <div>
        <L>Material</L>
        <MaterialTypeahead materials={materials as MaterialLite[]} value={materialId}
                           onPick={id => { setMaterialId(id); setCbl(CBL_EMPTY); }} showStock={false} compact={false}
                           placeholder="Type a liquor name, SKU or category…" />
      </div>

      {isNew && (
        <label className="flex items-start gap-2 bg-sky-50 border border-sky-200 rounded-lg p-2.5 text-xs text-sky-900 cursor-pointer">
          <input type="checkbox" checked={opening} onChange={e => setOpening(e.target.checked)}
                 className="accent-[#af4408] mt-0.5" />
          <span>
            <b>Set opening stock</b> — first ledger entry for this material in {storeName}.
            Available only while it has no history.
          </span>
        </label>
      )}

      {!opening && (
        <div>
          <L>Direction</L>
          <div className="flex gap-2">
            <button type="button" onClick={() => setSign(1)}
                    className={`flex-1 px-3 py-1.5 rounded-lg text-sm border font-medium ${sign === 1 ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
              + Add stock
            </button>
            <button type="button" onClick={() => setSign(-1)}
                    className={`flex-1 px-3 py-1.5 rounded-lg text-sm border font-medium ${sign === -1 ? 'bg-red-600 border-red-600 text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
              − Remove stock
            </button>
          </div>
        </div>
      )}

      <CBLEntry mat={mat} value={cbl} onChange={setCbl} />

      {opening && (
        <div>
          <L>Cost / {pu || 'purchase unit'} (₹, optional — for stock valuation)</L>
          <input type="number" min={0} step="any" value={openPrice} onChange={e => setOpenPrice(e.target.value)}
                 placeholder="e.g. 500" className={inputCls} />
        </div>
      )}

      <div>
        <L>Reason (required)</L>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
                  placeholder={opening ? 'e.g. physical count at store handover' : 'e.g. breakage, spillage, count correction…'}
                  className={inputCls} />
      </div>
    </ModalShell>
  );
}

/* ── Bulk Bill modal (one invoice, many lines → /procure-bill) ─────────── */

interface BillLine {
  key: number; material_id: string; cbl: CBLValue;
  price: string; perCase: boolean; batch: string; expiry: string;
}
const newBillLine = (key: number): BillLine =>
  ({ key, material_id: '', cbl: CBL_EMPTY, price: '', perCase: false, batch: '', expiry: '' });

function BillModal({ storeId, storeName, materials, suppliers, vendors, onClose, onSaved }: {
  storeId: string; storeName: string;
  materials: MatRow[]; suppliers: string[]; vendors: VendorLite[];
  onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [supplier, setSupplier] = useState('');
  const [invoiceRef, setInvoiceRef] = useState('');
  const [date, setDate] = useState(today());
  const [vendorId, setVendorId] = useState('');
  const [lines, setLines] = useState<BillLine[]>([newBillLine(1)]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const matById = useMemo(() => new Map(materials.map(m => [m.id, m])), [materials]);
  const setLine = (key: number, patch: Partial<BillLine>) =>
    setLines(ls => ls.map(l => l.key === key ? { ...l, ...patch } : l));
  const addLine = () => setLines(ls => [...ls, newBillLine(Math.max(0, ...ls.map(l => l.key)) + 1)]);
  const removeLine = (key: number) => setLines(ls => ls.length > 1 ? ls.filter(l => l.key !== key) : ls);

  /** Line economics: recipe qty + ₹ line total (price ÷ case when perCase). */
  const lineCalc = (l: BillLine) => {
    const mat = matById.get(l.material_id) || null;
    if (!mat) return { mat: null, recipe: 0, total: 0 };
    const recipe = cblRecipe(mat, l.cbl);
    const cf = caseFactor(mat), pf = packFactor(mat);
    const perBottle = l.perCase ? (Number(l.price) || 0) / cf : (Number(l.price) || 0);
    const perRecipe = pf > 1 ? perBottle / pf : perBottle;
    return { mat, recipe, total: recipe * perRecipe };
  };
  const billTotal = lines.reduce((s, l) => s + lineCalc(l).total, 0);
  const filledLines = lines.filter(l => l.material_id || l.cbl.cases || l.cbl.bottles || l.cbl.loose || l.price);

  const save = async () => {
    setErr(null);
    if (!invoiceRef.trim()) { setErr('Enter the invoice number'); return; }
    if (!supplier.trim() && !vendorId) { setErr('Enter the supplier'); return; }
    if (filledLines.length === 0) { setErr('Add at least one bill line'); return; }
    for (let i = 0; i < filledLines.length; i++) {
      const l = filledLines[i];
      const { mat, recipe } = lineCalc(l);
      if (!mat) { setErr(`Line ${i + 1}: pick a material`); return; }
      if (!(recipe > 0)) { setErr(`Line ${i + 1} (${mat.name}): enter a quantity`); return; }
      if (l.price === '' || !(Number(l.price) >= 0)) { setErr(`Line ${i + 1} (${mat.name}): enter the price`); return; }
    }
    setBusy(true);
    try {
      const r = await api(`/api/stores/${storeId}/procure-bill`, {
        method: 'POST',
        body: {
          supplier: supplier.trim(), invoice_ref: invoiceRef.trim(),
          vendor_id: vendorId || undefined, date,
          lines: filledLines.map(l => ({
            material_id: l.material_id,
            cases: numOr0(l.cbl.cases), bottles: numOr0(l.cbl.bottles), loose: numOr0(l.cbl.loose),
            unit_price: Number(l.price) || 0, per_case: l.perCase || undefined,
            batch_no: l.batch.trim() || undefined, expiry_date: l.expiry || undefined,
          })),
        },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onSaved(`Bill ${invoiceRef.trim()} saved — ${j.posted} line${j.posted === 1 ? '' : 's'}, ${inr(j.total_value)}`);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <ModalShell wide title="New Bill (bulk entry)" icon={<ReceiptText className="w-5 h-5 text-[#af4408]" />} onClose={onClose}
      footer={<>
        <span className="mr-auto text-sm text-[#6B5744]">Bill total <b className="text-[#2D1B0E]">{inr(billTotal)}</b></span>
        <button onClick={onClose} disabled={busy}
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">Cancel</button>
        <button onClick={save} disabled={busy}
                className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save Bill
        </button>
      </>}>
      <p className="text-[11px] text-[#8B7355] -mt-1">
        One supplier invoice, many items — every line posts to the {storeName} ledger under the
        same invoice ref, in one save. Central Store stays untouched.
      </p>
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-sm text-red-700">{err}</div>}

      {/* Bill header */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <L>Supplier</L>
          <input value={supplier} onChange={e => setSupplier(e.target.value)} list="liq-bill-suppliers"
                 placeholder="Type a supplier…" className={inputCls} />
          <datalist id="liq-bill-suppliers">
            {suppliers.map(s => <option key={s} value={s} />)}
          </datalist>
        </div>
        <div>
          <L>Invoice no.</L>
          <input value={invoiceRef} onChange={e => setInvoiceRef(e.target.value)} placeholder="INV-…" className={inputCls} />
        </div>
        <div>
          <L>Date</L>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} />
        </div>
        <div>
          <L>Vendor (optional)</L>
          <select value={vendorId} onChange={e => setVendorId(e.target.value)} className={inputCls}>
            <option value="">—</option>
            {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
      </div>

      {/* Lines */}
      <div className="space-y-2">
        {lines.map((l, i) => {
          const { mat, recipe, total } = lineCalc(l);
          const cf = mat ? caseFactor(mat) : 1;
          return (
            <div key={l.key} className="border border-[#E8D5C4] rounded-lg p-2.5 space-y-2 bg-[#FFFDF9]">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-[#8B7355] shrink-0">#{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <MaterialTypeahead materials={materials as MaterialLite[]} value={l.material_id}
                                     onPick={id => setLine(l.key, { material_id: id, cbl: CBL_EMPTY })}
                                     showStock={false} compact
                                     placeholder="Material — name, SKU or category…" />
                </div>
                <button onClick={() => removeLine(l.key)} disabled={lines.length === 1}
                        className="shrink-0 text-[#8B7355] hover:text-red-700 disabled:opacity-30" title="Remove line">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <CBLEntry mat={mat} value={l.cbl} onChange={v => setLine(l.key, { cbl: v })} />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
                <div>
                  <L>₹ / {l.perCase ? 'case' : (mat?.purchase_unit || mat?.unit || 'btl')}</L>
                  <div className="flex gap-1">
                    <input type="number" min={0} step="any" inputMode="decimal" value={l.price}
                           onChange={e => setLine(l.key, { price: e.target.value })}
                           placeholder="0" className={inputCls} />
                    {cf > 1 && (
                      <button type="button" onClick={() => setLine(l.key, { perCase: !l.perCase })}
                              title="Toggle price per bottle / per case"
                              className={`shrink-0 px-1.5 rounded border text-[10px] font-medium ${l.perCase
                                ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
                        /cs
                      </button>
                    )}
                  </div>
                </div>
                <div>
                  <L>Batch no.</L>
                  <input value={l.batch} onChange={e => setLine(l.key, { batch: e.target.value })}
                         placeholder="optional" className={inputCls} />
                </div>
                <div>
                  <L>Expiry</L>
                  <input type="date" value={l.expiry} onChange={e => setLine(l.key, { expiry: e.target.value })} className={inputCls} />
                </div>
                <div className="text-right">
                  <L>Line total</L>
                  <div className="px-2 py-1.5 text-sm font-semibold text-[#2D1B0E]">
                    {recipe > 0 && l.price !== '' ? inr(total) : '—'}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <button onClick={addLine}
                className="w-full px-3 py-2 border border-dashed border-[#D4B896] hover:border-[#af4408] hover:text-[#af4408] text-[#6B5744] rounded-lg text-sm font-medium flex items-center justify-center gap-1.5">
          <Plus className="w-4 h-4" /> Add line
        </button>
      </div>
    </ModalShell>
  );
}

/* ── Central-stock migration modal (admin) ─────────────────────────────── */

function MigrateModal({ storeId, storeName, candidates, blockedCount, onClose, onDone }: {
  storeId: string; storeName: string;
  candidates: StockRow[]; blockedCount: number;
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Preview: central qty at central average_price (exactly what the API posts).
  const eligible = candidates.filter(r => (Number(r.central_stock) || 0) > 0 && !r.has_ledger);
  const ineligible = candidates.filter(r => !((Number(r.central_stock) || 0) > 0) || r.has_ledger);
  const totalValue = eligible.reduce(
    (s, r) => s + (Number(r.central_stock) || 0) * (Number(r.average_price) || 0), 0);

  const run = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await api(`/api/stores/${storeId}/migrate`, {
        method: 'POST',
        body: { material_ids: eligible.map(m => m.material_id) },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const skippedNote = (j.skipped || []).length ? ` · ${(j.skipped || []).length} skipped` : '';
      onDone(`Migrated ${(j.migrated || []).length} material${(j.migrated || []).length === 1 ? '' : 's'} (${inr(j.total_value)}) from Central Store into ${storeName}${skippedNote}`);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  return (
    <ModalShell title="Migrate central stock" icon={<ArrowRightLeft className="w-5 h-5 text-[#af4408]" />} onClose={onClose}
      footer={<>
        <button onClick={onClose} disabled={busy}
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">Cancel</button>
        <button onClick={run} disabled={busy || eligible.length === 0}
                className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}
          Migrate {eligible.length} material{eligible.length === 1 ? '' : 's'} — {inr(totalValue)}
        </button>
      </>}>
      <p className="text-[11px] text-[#8B7355] -mt-1">
        Moves each material&apos;s CENTRAL stock into the {storeName} ledger as its <b>opening</b> row
        (valued at central average price), then zeroes the central stock with an audit-trail
        adjustment. Materials that already have {storeName} history are skipped.
      </p>
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-sm text-red-700">{err}</div>}

      {eligible.length === 0 ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
          Nothing to migrate — no central stock on materials without store history.
        </div>
      ) : (
        <div className="border border-[#E8D5C4] rounded-lg overflow-hidden">
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF1E3] text-[#8B7355] sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Material</th>
                  <th className="text-right px-3 py-2 font-medium">Central stock</th>
                  <th className="text-right px-3 py-2 font-medium">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0E4D6]">
                {eligible.map(r => (
                  <tr key={r.material_id}>
                    <td className="px-3 py-1.5 text-[#2D1B0E]">{r.material_name}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap font-mono text-[#6B5744]">
                      {fmtBreakdown(r.central_stock, r) || `${fq(r.central_stock)} ${r.unit}`}
                      <span className="text-[10px]"> · {fq(r.central_stock)} {r.unit}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap font-medium text-[#2D1B0E]">
                      {inr((Number(r.central_stock) || 0) * (Number(r.average_price) || 0))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-[#FFF1E3]">
                <tr>
                  <td className="px-3 py-2 font-semibold text-[#2D1B0E]">{eligible.length} material{eligible.length === 1 ? '' : 's'}</td>
                  <td></td>
                  <td className="px-3 py-2 text-right font-semibold text-[#2D1B0E]">{inr(totalValue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {(ineligible.length > 0 || blockedCount > 0) && (
        <div className="text-[11px] text-[#8B7355]">
          {ineligible.length > 0 && <>⚠️ {ineligible.length} selected material{ineligible.length === 1 ? '' : 's'} will be skipped (no central stock or already has store history). </>}
          {blockedCount > 0 && <>{blockedCount} material{blockedCount === 1 ? '' : 's'} with central stock also have store history — resolve those manually via Adjustment.</>}
        </div>
      )}
    </ModalShell>
  );
}

/* ── Closing Stock section (Phase C — independent store closing counts) ──
   Counts are a pure REGISTER (store_closing_counts) — saving never moves
   stock. Admin-only "adjust to physical" additionally posts 'adjustment'
   ledger rows. Completely separate from the central /closing-stock page. */

interface ClosingCount {
  material_id: string; date: string; system_qty: number; physical_qty: number;
  variance: number; variance_value: number; counted_by: string; note: string;
  material_name: string; unit: string; purchase_unit: string; pack_size: number;
  case_size: number;
}
interface ClosingDay {
  date: string; item_count: number; shortage_count: number; excess_count: number;
  total_variance_value: number; abs_variance_value: number;
}

function ClosingSection({ storeId, storeName, stock, isAdmin, onSaved }: {
  storeId: string; storeName: string; stock: StockRow[];
  isAdmin: boolean; onSaved: (msg: string) => void;
}) {
  const [view, setView] = useState<'count' | 'history'>('count');
  const [date, setDate] = useState(today());
  const [counts, setCounts] = useState<ClosingCount[]>([]);
  const [systemAsof, setSystemAsof] = useState<Record<string, number>>({});
  const [dayLoading, setDayLoading] = useState(false);
  const [cases, setCases] = useState<Record<string, string>>({});   // full cases (case_size × BTL)
  const [whole, setWhole] = useState<Record<string, string>>({});   // purchase units (BTL)
  const [loose, setLoose] = useState<Record<string, string>>({});   // recipe units (ml)
  const [note, setNote] = useState('');
  const [adjust, setAdjust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // History
  const [days, setDays] = useState<ClosingDay[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histDate, setHistDate] = useState('');

  const loadDay = useCallback(async (d: string) => {
    setDayLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/stores/${storeId}/closing?date=${d}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setCounts(j.counts || []);
      const m: Record<string, number> = {};
      for (const s of j.system_asof || []) m[s.material_id] = Number(s.qty) || 0;
      setSystemAsof(m);
    } catch (e: any) { setErr(e.message); }
    finally { setDayLoading(false); }
  }, [storeId]);

  const loadHistory = useCallback(async () => {
    setHistLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/stores/${storeId}/closing`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setDays(j.dates || []);
    } catch (e: any) { setErr(e.message); }
    finally { setHistLoading(false); }
  }, [storeId]);

  useEffect(() => { loadDay(date); setCases({}); setWhole({}); setLoose({}); }, [date, loadDay]);
  useEffect(() => { if (view === 'history') { loadHistory(); setHistDate(''); } }, [view, loadHistory]);

  const countedBy = useMemo(() => {
    const m = new Map<string, ClosingCount>();
    for (const c of counts) m.set(c.material_id, c);
    return m;
  }, [counts]);

  // Physical qty in RECIPE units from the Cases/Bottles/loose entry (null =
  // untouched row): cases × case_size × pack + bottles × pack + loose.
  const physicalFor = (r: StockRow): number | null => {
    const pc = packConv(r);
    const cf = caseFactor(r);
    const num = (s?: string) => (s != null && s !== '' && !isNaN(Number(s))) ? Number(s) : null;
    const c = num(cases[r.material_id]), w = num(whole[r.material_id]), l = num(loose[r.material_id]);
    if (c == null && w == null && l == null) return null;
    return (c ?? 0) * cf * pc + (w ?? 0) * pc + (l ?? 0);
  };
  const systemFor = (r: StockRow): number =>
    systemAsof[r.material_id] !== undefined ? systemAsof[r.material_id] : (Number(r.qty) || 0);

  const rows = useMemo(
    () => [...stock].sort((a, b) => a.material_name.localeCompare(b.material_name)),
    [stock],
  );
  const pending = rows
    .map(r => ({ r, phys: physicalFor(r) }))
    .filter((x): x is { r: StockRow; phys: number } => x.phys != null);
  const pendingVarianceValue = pending.reduce(
    (s, { r, phys }) => s + (phys - systemFor(r)) * (Number(r.avg_cost) || 0), 0);

  const save = async () => {
    if (pending.length === 0) return;
    if (pending.some(p => p.phys < 0)) { setErr('Physical counts cannot be negative'); return; }
    setErr(null); setBusy(true);
    try {
      const r = await api(`/api/stores/${storeId}/closing`, {
        method: 'POST',
        body: {
          date,
          items: pending.map(({ r, phys }) => ({ material_id: r.material_id, physical_qty: phys })),
          note: note.trim(),
          adjust_to_physical: isAdmin ? adjust : undefined,
        },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setCases({}); setWhole({}); setLoose({}); setNote(''); setAdjust(false);
      await loadDay(date);
      onSaved(`Saved ${j.summary.items} closing count${j.summary.items === 1 ? '' : 's'} for ${date}` +
        (j.summary.adjusted_count ? ` — ${j.summary.adjusted_count} adjusted to physical` : ''));
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  /* history detail = read-only counts of a past date */
  const openHistDate = (d: string) => { setHistDate(d); loadDay(d); };

  return (
    <div className="space-y-3">
      {/* Sub-toggle: Count / History */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-[#E8D5C4] overflow-hidden">
          <button onClick={() => setView('count')}
                  className={`px-3 py-1.5 text-xs font-medium flex items-center gap-1.5 ${view === 'count' ? 'bg-[#af4408] text-white' : 'bg-white text-[#6B5744]'}`}>
            <ClipboardCheck className="w-3.5 h-3.5" /> Count
          </button>
          <button onClick={() => setView('history')}
                  className={`px-3 py-1.5 text-xs font-medium flex items-center gap-1.5 ${view === 'history' ? 'bg-[#af4408] text-white' : 'bg-white text-[#6B5744]'}`}>
            <History className="w-3.5 h-3.5" /> History
          </button>
        </div>
        {view === 'count' && (
          <input type="date" value={date} max={today()} onChange={e => setDate(e.target.value)}
                 aria-label="Count date"
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-sm bg-white" />
        )}
      </div>

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {err}
        </div>
      )}

      {view === 'count' ? (
        <>
          <p className="text-[11px] text-[#8B7355]">
            Physical count for <b>{date}</b> — system qty is the {storeName} ledger sum as of that date.
            Saving a count records it only; stock is never changed by a count.
          </p>

          {dayLoading ? (
            <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">
              Nothing to count yet — record a purchase or opening stock first.
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-xs">
                    <thead className="bg-[#FFF1E3] text-[#8B7355]">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Material</th>
                        <th className="text-right px-3 py-2 font-medium">System</th>
                        <th className="text-left px-3 py-2 font-medium w-[260px]">Physical count</th>
                        <th className="text-right px-3 py-2 font-medium">Variance</th>
                        <th className="text-left px-3 py-2 font-medium">Today</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F0E4D6]">
                      {rows.map(r => {
                        const pc = packConv(r);
                        const cf = caseFactor(r);
                        const sys = systemFor(r);
                        const phys = physicalFor(r);
                        const existing = countedBy.get(r.material_id);
                        const v = phys != null ? Math.round((phys - sys) * 1000) / 1000 : null;
                        const vv = v != null ? v * (Number(r.avg_cost) || 0) : null;
                        const box = 'w-16 px-1.5 py-1 border border-[#D4B896] rounded text-xs text-right font-mono bg-white focus:outline-none focus:ring-1 focus:ring-[#af4408]';
                        return (
                          <tr key={r.material_id} className="hover:bg-[#FFF8F0] align-top">
                            <td className="px-3 py-2">
                              <div className="text-[#2D1B0E] font-medium">{r.material_name}</div>
                              <div className="text-[10px] text-[#8B7355]">{r.category}</div>
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap font-mono text-[#6B5744]">
                              {pc > 1
                                ? <>{fmtBreakdown(sys, r)}<div className="text-[10px]">{fq(sys)} {r.unit}</div></>
                                : <>{fq(sys)} {r.unit}</>}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1 flex-wrap">
                                {pc > 1 && cf > 1 && (<>
                                  <input type="number" step="any" min={0} value={cases[r.material_id] ?? ''}
                                         onChange={e => setCases(p => ({ ...p, [r.material_id]: e.target.value }))}
                                         placeholder="0" title={`Full cases — 1 = ${fq(cf)} ${r.purchase_unit} = ${fq(cf * pc)} ${r.unit}`}
                                         className={box} />
                                  <span className="text-[10px] text-[#8B7355]">cs</span>
                                  <span className="text-[10px] text-[#8B7355]">+</span>
                                </>)}
                                {pc > 1 && (<>
                                  <input type="number" step="any" min={0} value={whole[r.material_id] ?? ''}
                                         onChange={e => setWhole(p => ({ ...p, [r.material_id]: e.target.value }))}
                                         placeholder="0" title={`Full ${r.purchase_unit} — 1 = ${fq(r.pack_size)} ${r.unit}`}
                                         className={box} />
                                  <span className="text-[10px] text-[#8B7355]">{r.purchase_unit}</span>
                                  <span className="text-[10px] text-[#8B7355]">+</span>
                                </>)}
                                <input type="number" step="any" min={0} value={loose[r.material_id] ?? ''}
                                       onChange={e => setLoose(p => ({ ...p, [r.material_id]: e.target.value }))}
                                       placeholder="0" title={pc > 1 ? `Loose / open ${r.unit}` : `Count in ${r.unit}`}
                                       className={box} />
                                <span className="text-[10px] text-[#8B7355]">{r.unit}</span>
                                {phys != null && pc > 1 && (
                                  <span className="text-[10px] font-mono text-[#af4408] whitespace-nowrap">= {fq(phys)} {r.unit}</span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap font-mono">
                              {v == null ? <span className="text-[#8B7355]">—</span> : (
                                <span className={v < 0 ? 'text-red-700' : v > 0 ? 'text-blue-700' : 'text-emerald-700'}>
                                  {v > 0 ? '+' : ''}{fq(v)} {r.unit}
                                  <div className="text-[10px]">{vv != null && vv !== 0 ? (vv > 0 ? '+' : '−') + inr(Math.abs(vv)) : inr(0)}</div>
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {existing ? (
                                <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700"
                                      title={`By ${existing.counted_by} — variance ${existing.variance > 0 ? '+' : ''}${existing.variance} ${r.unit}`}>
                                  ✓ {fq(existing.physical_qty)} {r.unit}
                                </span>
                              ) : <span className="text-[10px] text-[#8B7355]">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden space-y-2">
                {rows.map(r => {
                  const pc = packConv(r);
                  const cf = caseFactor(r);
                  const sys = systemFor(r);
                  const phys = physicalFor(r);
                  const existing = countedBy.get(r.material_id);
                  const v = phys != null ? Math.round((phys - sys) * 1000) / 1000 : null;
                  const vv = v != null ? v * (Number(r.avg_cost) || 0) : null;
                  const box = 'w-14 px-1.5 py-1 border border-[#D4B896] rounded text-xs text-right font-mono bg-white';
                  return (
                    <div key={r.material_id} className="bg-white border border-[#E8D5C4] rounded-xl p-3 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-[#2D1B0E] break-words">{r.material_name}</div>
                          <div className="text-[10px] text-[#8B7355]">
                            System: {pc > 1 ? `${fmtBreakdown(sys, r)} (${fq(sys)} ${r.unit})` : `${fq(sys)} ${r.unit}`}
                          </div>
                        </div>
                        {existing && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                            ✓ {fq(existing.physical_qty)} {r.unit}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex items-center gap-1 flex-wrap">
                        {pc > 1 && cf > 1 && (<>
                          <input type="number" step="any" min={0} inputMode="decimal" value={cases[r.material_id] ?? ''}
                                 onChange={e => setCases(p => ({ ...p, [r.material_id]: e.target.value }))}
                                 placeholder="0" className={box} />
                          <span className="text-[10px] text-[#8B7355]">cs</span>
                          <span className="text-[10px] text-[#8B7355]">+</span>
                        </>)}
                        {pc > 1 && (<>
                          <input type="number" step="any" min={0} inputMode="decimal" value={whole[r.material_id] ?? ''}
                                 onChange={e => setWhole(p => ({ ...p, [r.material_id]: e.target.value }))}
                                 placeholder="0" className={box} />
                          <span className="text-[10px] text-[#8B7355]">{r.purchase_unit}</span>
                          <span className="text-[10px] text-[#8B7355]">+</span>
                        </>)}
                        <input type="number" step="any" min={0} inputMode="decimal" value={loose[r.material_id] ?? ''}
                               onChange={e => setLoose(p => ({ ...p, [r.material_id]: e.target.value }))}
                               placeholder="0" className={box} />
                        <span className="text-[10px] text-[#8B7355]">{r.unit}</span>
                        {v != null && (
                          <span className={`ml-auto font-mono ${v < 0 ? 'text-red-700' : v > 0 ? 'text-blue-700' : 'text-emerald-700'}`}>
                            {v > 0 ? '+' : ''}{fq(v)} {r.unit}{vv != null ? ` · ${vv > 0 ? '+' : vv < 0 ? '−' : ''}${inr(Math.abs(vv))}` : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Save bar */}
              <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[#6B5744]">
                  <span><b className="text-[#2D1B0E]">{pending.length}</b> item{pending.length === 1 ? '' : 's'} entered</span>
                  {pending.length > 0 && (
                    <span>Variance <b className={pendingVarianceValue < 0 ? 'text-red-700' : 'text-[#2D1B0E]'}>
                      {pendingVarianceValue < 0 ? '−' : ''}{inr(Math.abs(pendingVarianceValue))}</b></span>
                  )}
                  <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional)…"
                         className="flex-1 min-w-[140px] px-2 py-1.5 border border-[#E8D5C4] rounded text-xs bg-white" />
                  <button onClick={save} disabled={busy || pending.length === 0}
                          className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Save counts{pending.length > 0 ? ` (${pending.length})` : ''}
                  </button>
                </div>
                {isAdmin && (
                  <label className="flex items-start gap-2 text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-2 cursor-pointer">
                    <input type="checkbox" checked={adjust} onChange={e => setAdjust(e.target.checked)} className="accent-[#af4408] mt-0.5" />
                    <span>
                      <b>Adjust stock to physical</b> (admin) — additionally posts an <i>adjustment</i> ledger row for
                      each variance so {storeName} stock matches the count. ⚠️ This reconciles away shortages — use only
                      after verifying the physical count.
                    </span>
                  </label>
                )}
              </div>
            </>
          )}
        </>
      ) : (
        /* ── History ── */
        histLoading ? (
          <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading history…</div>
        ) : days.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">
            No closing counts recorded yet for {storeName}.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-xs">
                  <thead className="bg-[#FFF1E3] text-[#8B7355]">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Date</th>
                      <th className="text-right px-3 py-2 font-medium">Items</th>
                      <th className="text-right px-3 py-2 font-medium">Short</th>
                      <th className="text-right px-3 py-2 font-medium">Excess</th>
                      <th className="text-right px-3 py-2 font-medium">Variance ₹</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F0E4D6]">
                    {days.map(d => (
                      <tr key={d.date} className={`hover:bg-[#FFF8F0] cursor-pointer ${histDate === d.date ? 'bg-[#FFF1E3]' : ''}`}
                          onClick={() => openHistDate(d.date)}>
                        <td className="px-3 py-2 font-medium text-[#2D1B0E] whitespace-nowrap">{d.date}</td>
                        <td className="px-3 py-2 text-right">{d.item_count}</td>
                        <td className="px-3 py-2 text-right text-red-700">{d.shortage_count || '—'}</td>
                        <td className="px-3 py-2 text-right text-blue-700">{d.excess_count || '—'}</td>
                        <td className={`px-3 py-2 text-right font-mono ${d.total_variance_value < 0 ? 'text-red-700' : 'text-[#2D1B0E]'}`}>
                          {d.total_variance_value < 0 ? '−' : ''}{inr(Math.abs(d.total_variance_value))}
                        </td>
                        <td className="px-3 py-2 text-right text-[10px] text-[#af4408]">view</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {histDate && (
              dayLoading ? (
                <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading {histDate}…</div>
              ) : (
                <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
                  <div className="px-3 py-2 bg-[#FFF1E3] text-xs font-medium text-[#2D1B0E]">Counts on {histDate}</div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-xs">
                      <thead className="text-[#8B7355] border-b border-[#F0E4D6]">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium">Material</th>
                          <th className="text-right px-3 py-2 font-medium">System</th>
                          <th className="text-right px-3 py-2 font-medium">Physical</th>
                          <th className="text-right px-3 py-2 font-medium">Variance</th>
                          <th className="text-right px-3 py-2 font-medium">₹</th>
                          <th className="text-left px-3 py-2 font-medium">By</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#F0E4D6]">
                        {counts.map(c => (
                          <tr key={c.material_id}>
                            <td className="px-3 py-2 text-[#2D1B0E]">{c.material_name}
                              {c.note && <div className="text-[10px] text-[#8B7355]">{c.note}</div>}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-[#6B5744]">
                              {fq(c.system_qty)} {c.unit}
                              {fmtBreakdown(c.system_qty, c) && <div className="text-[10px]">{fmtBreakdown(c.system_qty, c)}</div>}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-[#2D1B0E]">
                              {fq(c.physical_qty)} {c.unit}
                              {fmtBreakdown(c.physical_qty, c) && <div className="text-[10px]">{fmtBreakdown(c.physical_qty, c)}</div>}
                            </td>
                            <td className={`px-3 py-2 text-right font-mono ${c.variance < 0 ? 'text-red-700' : c.variance > 0 ? 'text-blue-700' : 'text-emerald-700'}`}>
                              {c.variance > 0 ? '+' : ''}{fq(c.variance)} {c.unit}
                            </td>
                            <td className={`px-3 py-2 text-right font-mono ${c.variance_value < 0 ? 'text-red-700' : 'text-[#6B5744]'}`}>
                              {c.variance_value < 0 ? '−' : ''}{inr(Math.abs(c.variance_value))}
                            </td>
                            <td className="px-3 py-2 text-[#8B7355]">{(c.counted_by || '').split('@')[0] || '—'}</td>
                          </tr>
                        ))}
                        {counts.length === 0 && (
                          <tr><td colSpan={6} className="px-3 py-4 text-center text-[#8B7355]">No counts on this date.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}
          </div>
        )
      )}
    </div>
  );
}

/* ── Reports section (Phase D — store-scoped reports + CSV) ────────────── */

type ColFmt = 'qty' | 'inr' | 'inr4' | undefined;
interface ReportCol { k: string; l: string; fmt?: ColFmt; }
interface ReportDef { key: string; label: string; dated?: boolean; days?: boolean; cols: ReportCol[]; }

const REPORT_DEFS: ReportDef[] = [
  { key: 'current_stock', label: 'Current Stock', cols: [
    { k: 'material', l: 'Material' }, { k: 'sku', l: 'SKU' }, { k: 'category', l: 'Category' },
    { k: 'qty_cbl', l: 'On hand (cs/btl)' },
    { k: 'qty', l: 'Recipe qty', fmt: 'qty' }, { k: 'unit', l: 'R.unit' },
    { k: 'avg_cost', l: 'Avg cost', fmt: 'inr4' }, { k: 'value', l: 'Value', fmt: 'inr' },
  ] },
  { key: 'ledger', label: 'Stock Ledger', dated: true, cols: [
    { k: 'date', l: 'Date' }, { k: 'txn_type', l: 'Type' }, { k: 'material', l: 'Material' },
    { k: 'qty_cbl', l: 'Cs/Btl' },
    { k: 'qty', l: 'Qty', fmt: 'qty' }, { k: 'unit', l: 'Unit' },
    { k: 'unit_cost', l: 'Unit cost', fmt: 'inr4' }, { k: 'running_balance', l: 'Balance', fmt: 'qty' },
    { k: 'supplier', l: 'Supplier' }, { k: 'ref', l: 'Ref' }, { k: 'by', l: 'By' },
  ] },
  { key: 'purchases', label: 'Purchase Register', dated: true, cols: [
    { k: 'date', l: 'Date' }, { k: 'material', l: 'Material' },
    { k: 'qty_cbl', l: 'Qty (cs/btl)' },
    { k: 'qty_purchase', l: 'Qty', fmt: 'qty' }, { k: 'purchase_unit', l: 'Unit' },
    { k: 'rate_purchase', l: 'Rate', fmt: 'inr' }, { k: 'cost', l: 'Cost', fmt: 'inr' },
    { k: 'supplier', l: 'Supplier' }, { k: 'vendor', l: 'Vendor' },
    { k: 'invoice', l: 'Invoice' }, { k: 'by', l: 'By' },
  ] },
  { key: 'movement', label: 'Movement', dated: true, cols: [
    { k: 'material', l: 'Material' }, { k: 'unit', l: 'Unit' },
    { k: 'opening', l: 'Opening', fmt: 'qty' }, { k: 'in_qty', l: 'In', fmt: 'qty' },
    { k: 'out_qty', l: 'Out', fmt: 'qty' }, { k: 'adjust_qty', l: 'Adjust', fmt: 'qty' },
    { k: 'closing', l: 'Closing', fmt: 'qty' },
  ] },
  { key: 'daily_closing', label: 'Daily Closing', dated: true, cols: [
    { k: 'date', l: 'Date' }, { k: 'items', l: 'Items' },
    { k: 'shortages', l: 'Short' }, { k: 'excesses', l: 'Excess' },
    { k: 'variance_value', l: 'Variance ₹', fmt: 'inr' },
    { k: 'abs_variance_value', l: 'Abs ₹', fmt: 'inr' },
  ] },
  { key: 'valuation', label: 'Valuation', cols: [
    { k: 'category', l: 'Category' }, { k: 'items', l: 'Items' },
    { k: 'qty', l: 'Qty (recipe)', fmt: 'qty' }, { k: 'value', l: 'Value', fmt: 'inr' },
  ] },
  { key: 'low_stock', label: 'Low Stock', cols: [
    { k: 'material', l: 'Material' }, { k: 'category', l: 'Category' },
    { k: 'qty', l: 'On hand', fmt: 'qty' }, { k: 'unit', l: 'Unit' },
    { k: 'reorder_level', l: 'Reorder at', fmt: 'qty' }, { k: 'deficit', l: 'Deficit', fmt: 'qty' },
    { k: 'value', l: 'Value', fmt: 'inr' },
  ] },
  { key: 'dead_stock', label: 'Dead Stock', days: true, cols: [
    { k: 'material', l: 'Material' }, { k: 'category', l: 'Category' },
    { k: 'qty', l: 'On hand', fmt: 'qty' }, { k: 'unit', l: 'Unit' },
    { k: 'value', l: 'Value', fmt: 'inr' }, { k: 'last_outward', l: 'Last outward' },
  ] },
  { key: 'supplier', label: 'Supplier-wise', dated: true, cols: [
    { k: 'supplier', l: 'Supplier' }, { k: 'purchases', l: 'Purchases' },
    { k: 'qty', l: 'Qty (recipe)', fmt: 'qty' }, { k: 'total_value', l: 'Value', fmt: 'inr' },
  ] },
  { key: 'category', label: 'Category-wise', cols: [
    { k: 'category', l: 'Category' }, { k: 'material', l: 'Material' }, { k: 'sku', l: 'SKU' },
    { k: 'qty_purchase', l: 'On hand', fmt: 'qty' }, { k: 'purchase_unit', l: 'Unit' },
    { k: 'avg_cost', l: 'Avg cost', fmt: 'inr4' }, { k: 'value', l: 'Value', fmt: 'inr' },
  ] },
  { key: 'audit', label: 'Audit Trail', dated: true, cols: [
    { k: 'date', l: 'Date' }, { k: 'event', l: 'Event' },
    { k: 'actor', l: 'Actor' }, { k: 'note', l: 'Note' },
  ] },
];

function csvEscape(v: any): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function ReportsSection({ storeId, storeCode }: { storeId: string; storeCode: string }) {
  const [type, setType] = useState('current_stock');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [deadDays, setDeadDays] = useState('30');
  const [rows, setRows] = useState<any[]>([]);
  const [totals, setTotals] = useState<Record<string, any>>({});
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const def = REPORT_DEFS.find(d => d.key === type) || REPORT_DEFS[0];

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams({ type });
      const d = REPORT_DEFS.find(x => x.key === type);
      if (d?.dated) { if (from) p.set('from', from); if (to) p.set('to', to); }
      if (d?.days && deadDays) p.set('days', deadDays);
      const r = await fetch(`/api/stores/${storeId}/reports?${p.toString()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setRows(j.rows || []);
      setTotals(j.totals || {});
      setTruncated(!!j.truncated);
    } catch (e: any) { setErr(e.message); setRows([]); setTotals({}); }
    finally { setLoading(false); }
  }, [storeId, type, from, to, deadDays]);

  useEffect(() => { load(); }, [load]);

  const fmtCell = (v: any, fmt: ColFmt) => {
    if (v == null || v === '') return '—';
    if (fmt === 'qty') return fq(Number(v));
    if (fmt === 'inr') {
      const num = Number(v) || 0;
      return num < 0 ? '−' + inr(Math.abs(num)) : inr(num);
    }
    if (fmt === 'inr4') return inr(Number(v), 4);
    return String(v);
  };
  const totalLabel = (k: string) => k.replace(/_/g, ' ');
  const totalFmt = (k: string, v: any) => {
    if (typeof v !== 'number') return String(v);
    if (/value|cost/.test(k)) return v < 0 ? '−' + inr(Math.abs(v)) : inr(v);
    return fq(v);
  };

  const downloadCsv = () => {
    const lines = [def.cols.map(c => csvEscape(c.l)).join(',')];
    for (const r of rows) lines.push(def.cols.map(c => csvEscape(r[c.k])).join(','));
    const blob = new Blob(['﻿' + lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${storeCode.toLowerCase()}-${type}-${today()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-3">
      {/* Report type pills */}
      <TabScroller className="gap-1.5">
        {REPORT_DEFS.map(d => (
          <button key={d.key} onClick={() => setType(d.key)}
                  className={`px-2.5 py-1 rounded-full text-[11px] border whitespace-nowrap ${
                    type === d.key ? 'bg-[#2D1B0E] border-[#2D1B0E] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
            {d.label}
          </button>
        ))}
      </TabScroller>

      {/* Filters + CSV */}
      <div className="flex flex-wrap items-center gap-2">
        {def.dated && (<>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="From date"
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-sm bg-white" />
          <span className="text-xs text-[#8B7355]">→</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="To date"
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-sm bg-white" />
          {(from || to) && (
            <button onClick={() => { setFrom(''); setTo(''); }} className="text-xs text-[#af4408] hover:underline">clear</button>
          )}
        </>)}
        {def.days && (
          <label className="flex items-center gap-1.5 text-xs text-[#6B5744]">
            No outward in
            <input type="number" min={1} max={365} value={deadDays} onChange={e => setDeadDays(e.target.value)}
                   className="w-16 px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-sm bg-white text-right" />
            days
          </label>
        )}
        <button onClick={downloadCsv} disabled={rows.length === 0}
                className="ml-auto px-3 py-1.5 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-xs font-medium flex items-center gap-1.5 disabled:opacity-40">
          <Download className="w-3.5 h-3.5" /> CSV
        </button>
      </div>

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {err}
        </div>
      )}

      {/* Totals strip */}
      {!loading && !err && (
        <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl px-3 sm:px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-[#6B5744]">
          {Object.entries(totals).map(([k, v]) => (
            <span key={k} className="capitalize">{totalLabel(k)} <b className="text-[#2D1B0E]">{totalFmt(k, v)}</b></span>
          ))}
          {truncated && <span className="text-amber-700">showing first 1000 rows</span>}
        </div>
      )}

      {loading ? (
        <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Building report…</div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">
          No data for this report{def.dated && (from || to) ? ' in the selected date range' : ''}.
        </div>
      ) : (
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs" style={{ minWidth: `${Math.max(def.cols.length * 90, 360)}px` }}>
              <thead className="bg-[#FFF1E3] text-[#8B7355]">
                <tr>
                  {def.cols.map(c => (
                    <th key={c.k} className={`px-3 py-2 font-medium whitespace-nowrap ${c.fmt ? 'text-right' : 'text-left'}`}>{c.l}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0E4D6]">
                {rows.map((r, i) => (
                  <tr key={i} className="hover:bg-[#FFF8F0]">
                    {def.cols.map(c => (
                      <td key={c.k}
                          className={`px-3 py-2 ${c.fmt ? 'text-right font-mono whitespace-nowrap' : 'text-[#2D1B0E]'} ${
                            c.fmt && Number(r[c.k]) < 0 ? 'text-red-700' : ''} ${!c.fmt ? 'max-w-[260px] break-words' : ''}`}>
                        {fmtCell(r[c.k], c.fmt)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
