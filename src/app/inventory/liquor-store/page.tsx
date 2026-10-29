'use client';

/**
 * Liquor Store — per-store inventory page (Phase B of the multi-store engine).
 *
 * Everything renders from DYNAMIC store config (store_locations +
 * store_category_map + store_user_access): a future Wine Cellar shows up here
 * automatically via the store picker (hidden while only one store is active).
 *
 * Sections: STOCK (search + category chips + totals), a link to enter a bill
 * on Goods Receipt (GRN) → TGBCL Liquor Bill (can_procure — since the
 * liquor-on-GRN switch-over, owner rulings #83/#84, liquor bills are entered
 * there and post straight into this store's ledger; the old New Bill / Upload
 * CSV (Bill) doors here are retired, their routes answer 410), ADJUSTMENT incl.
 * one-time OPENING (can_adjust), LEDGER tab
 * (type chips / material search / date range), CLOSING STOCK tab
 * (can_close_stock — independent daily physical counts, Phase C) and REPORTS
 * tab (11 store-scoped reports + CSV download, Phase D). Store closing is
 * COMPLETELY separate from the central /closing-stock module.
 *
 * In-page gate: /api/stores/[id]/my-access → can_view (the APIs also 403
 * server-side, this is just the 🔒 UX). Stock quantities are RECIPE units on
 * the ledger; the page shows purchase-unit equivalents (÷ pack_size) alongside.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Wine, Plus, Search, X, Loader2, AlertCircle, AlertTriangle, CheckCircle2,
  SlidersHorizontal, ScrollText, Boxes, Warehouse, ClipboardCheck, BarChart3,
  Download, Upload, History, Save, ReceiptText, ArrowRightLeft, Trash2,
} from 'lucide-react';
import Papa from 'papaparse';
import { api } from '@/lib/api';
import { todayIST } from '@/lib/format-date';
import TabScroller from '@/components/TabScroller';
import MaterialTypeahead, { MaterialLite } from '@/components/MaterialTypeahead';
import ZeroCountGuard, { readZeroGuard, type ZeroGuardInfo } from '@/components/ZeroCountGuard';
import CountState from '@/components/CountState';
import {
  packFactor, caseFactor, entryMode, tripleToRecipe, breakdownQty, fmtBreakdown,
  toPurchaseQty, csvQty, PackMeta,
} from '@/lib/pack-units';

/* ── Types ─────────────────────────────────────────────────────────────── */

interface StoreLite {
  id: string; name: string; code: string; is_active: number;
  /** Mapped categories (GET /api/stores). A store that owns ≥ 1 category is
   *  where a Goods Receipt TGBCL Liquor Bill posts its bottles (materialStoreId);
   *  a FLOOR bar owns none and is filled by transfers. */
  categories?: { id: string; category: string }[];
}
interface Access { can_view: boolean; can_procure: boolean; can_adjust: boolean; can_close_stock: boolean; }
interface StockRow {
  material_id: string; material_name: string; category: string; unit: string;
  qty: number; avg_cost: number; value: number;
  sku: string; purchase_unit: string; pack_size: number; case_size: number;
  reorder_level: number;
  /** Priority stars (read-only here — edit on /inventory): 3 critical / 2 standard / 1 low. */
  priority?: number;
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
  /** Synthetic closing-count register rows (ledger ?counts=1) — never move stock. */
  is_count?: boolean; system_qty?: number; variance?: number; saved_at?: string;
}
/** Ledger render item: a plain row, or a bill-subtotal marker after a group
 *  of consecutive 'purchase' rows sharing one non-empty invoice ref. */
/** Bill-level charges on a liquor invoice (TGBCL): recorded on top of the line
 *  amounts, shown on the bill subtotal. Keyed in state by lower(invoice_ref). */
interface BillChargeRow {
  invoice_ref: string; supplier: string; date: string;
  invoice_value: number; mrp_rounding: number; excise_turnover_tax: number;
  special_excise_cess: number; tcs: number; net_indent_value: number;
}
type LedgerItem =
  | { kind: 'row'; row: LedgerRow }
  | { kind: 'bill'; ref: string; count: number; total: number; supplier: string; charges?: BillChargeRow | null;
      /** The bill's Goods Receipt stamp ('Goods Receipt GRN-yyyy-#### · PINV-yyyy-L####'),
       *  when every line of the group carries the same one — a TGBCL bill entered
       *  on Goods Receipt writes it as each ledger row's notes. '' for bills
       *  recorded here before the switch-over. */
      grn: string };

/* ── Helpers ───────────────────────────────────────────────────────────── */

const packConv = packFactor;   // recipe units per bottle (1 = no conversion)
const fq = (v: number, dp = 2) =>
  Number((Number(v) || 0).toFixed(dp)).toLocaleString('en-IN');
const inr = (v: number, dp = 2) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: dp });

/** The unit every quantity on this page READS in — the PURCHASE unit, falling
 *  back to the recipe unit only when the material has none. */
const puOf = (m: PackMeta) => String(m?.purchase_unit || m?.unit || '').trim() || 'units';

/**
 * One quantity as text, ALWAYS purchase-first.
 *   packs (pack_size > 1 or a case size) → '2 cs + 9 btl + 450 ml'
 *   no pack conversion                   → '2,279 BTL'
 *
 * The second branch is why this helper exists. fmtBreakdown returns null when
 * packFactor's both-halves guard fails, and every call site used to fall back to
 * `${qty} ${m.unit}` — the RECIPE unit. On the beer catalog (unit 'pcs',
 * purchase_unit 'BTL', pack_size 1) that printed "2,279 pcs" on a floor that
 * counts bottles. The factor is 1 there, so the number is identical in both
 * bases and labelling it with the purchase unit is exact, not a conversion.
 */
const qtyText = (qty: number, m: PackMeta) => fmtBreakdown(qty, m) || `${fq(qty)} ${puOf(m)}`;

/** Compact breakdown of the TGBCL bill-level charges, shown under a bill
 *  subtotal. Only non-zero charges are listed; Net Indent Value is always shown. */
function BillChargesLine({ c }: { c: BillChargeRow }) {
  const parts: Array<[string, number]> = [
    ['MRP Rounding', Number(c.mrp_rounding) || 0],
    ['Excise Turnover Tax', Number(c.excise_turnover_tax) || 0],
    ['Special Excise Cess', Number(c.special_excise_cess) || 0],
    ['TCS', Number(c.tcs) || 0],
  ].filter(([, v]) => v !== 0) as Array<[string, number]>;
  return (
    <span className="ml-1 text-[#8B7355]">
      · Invoice <b className="text-[#2D1B0E]">{inr(c.invoice_value)}</b>
      {parts.map(([label, v]) => (
        <span key={label}> + {label} {inr(v)}</span>
      ))}
      {' '}= Net Indent <b className="text-[#af4408]">{inr(c.net_indent_value)}</b>
    </span>
  );
}
// IST calendar date (not UTC) — a post-midnight bar closing (00:00–05:30 IST)
// must file under today, not yesterday's UTC date.
const today = () => todayIST();
const numOr0 = (s?: string) => {
  const n = Number(s);
  return s != null && s !== '' && Number.isFinite(n) ? n : 0;
};

/* One quantity: '2 cs + 9 btl + 450 ml' (bold) with '· 25,200 ml' alongside.
   Materials with no pack conversion read in the PURCHASE unit ('2,279 BTL') —
   same number, right label (see qtyText). */
function DualQty({ qty, m, boldCls, sign }: {
  qty: number; m: PackMeta; boldCls: string; sign?: boolean;
}) {
  const dual = fmtBreakdown(qty, m);
  const ru = String(m.unit || '');
  if (!dual) {
    return <span className={boldCls}>{sign && qty > 0 ? '+' : ''}{fq(qty)} {puOf(m)}</span>;
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
    // No pack conversion (factor 1), so the single box is the purchase unit —
    // label it that way rather than with the recipe unit ('BTL', not 'pcs').
    return (
      <div>
        <L>Qty ({bu})</L>
        <input type="number" min={0} step="any" inputMode="decimal" value={value.bottles}
               onChange={e => onChange({ ...value, bottles: e.target.value })}
               placeholder="e.g. 2" className={box} />
      </div>
    );
  }
  const showCases = mode === 'cbl' || mode === 'cb';
  const showLoose = mode === 'cbl' || mode === 'bl';
  const cols = (showCases ? 1 : 0) + 1 + (showLoose ? 1 : 0);   // Cases? + Bottles + Loose?
  return (
    <div>
      <div className={`grid gap-2 ${cols === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {showCases && (
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
        {showLoose && (
          <div>
            <L>Loose ({ru})</L>
            <input type="number" min={0} step="any" inputMode="decimal" value={value.loose}
                   onChange={e => onChange({ ...value, loose: e.target.value })}
                   placeholder="0" className={box} />
          </div>
        )}
      </div>
      {mat && touched && (
        <div className="mt-1 text-[11px] text-[#6B5744] bg-[#FFF1E3] border border-[#E8D5C4] rounded px-2 py-1">
          {/* Live preview of the bar's cases + bottles + loose entry, e.g.
              "2 cs + 9 btl + 450 ml = 25,200 ml". The LEAD is the purchase
              basis (cs / bu, resolved from purchase_unit). The trailing
              "= 25,200 ml" is the EXACT figure this entry will post, and the
              "+ 450 ml" is the Loose box's own value, whose input is labelled
              "Loose (ml)" right above. Same reason as the DualQty companion
              higher up this file: the cs/btl breakdown rounds to whole units,
              so the ledger must carry the unrounded recipe total or
              opening + in − out = closing stops reconciling exactly.
              unit-lock: exact-balance-ledger — bar entry preview, purchase-lead */}
          {showCases ? `${numOr0(value.cases)} cs + ` : ''}
          {`${numOr0(value.bottles)} ${bu.toLowerCase()}`}
          {showLoose ? ` + ${numOr0(value.loose)} ${ru}` : ''}
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
  // Full catalog (held + all mapped/liquor at qty 0) — for bulk-adjust + closing
  // lists so a floor can set opening/closing for any liquor item. Equals `stock`
  // for the category-owning Liquor Store. Falls back to `stock` if a store's API
  // response predates this field.
  const [catalog, setCatalog] = useState<StockRow[]>([]);
  const [materials, setMaterials] = useState<MatRow[]>([]);
  const [stockLoading, setStockLoading] = useState(false);

  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [billCharges, setBillCharges] = useState<Record<string, BillChargeRow>>({});
  const [ledgerLoading, setLedgerLoading] = useState(false);

  // Which store the current `stock` belongs to (set on successful load) — gates
  // the no-ledger closing-count banner so a store switch can't act on stale rows.
  const [stockLoadedFor, setStockLoadedFor] = useState('');
  // storeId → latest saved closing-count date (null = none); fetched only for
  // stores with zero ledger history, keyed by store so it can't go stale.
  const [latestCountByStore, setLatestCountByStore] = useState<Record<string, string | null>>({});

  const [tab, setTab] = useState<'stock' | 'ledger' | 'closing' | 'reports'>('stock');
  /* The Closing Stock sheet's business date, held HERE rather than inside
     ClosingSection because that component is keyed on the store (see its
     render site) and is therefore destroyed and rebuilt on every floor
     switch. The date is a property of the counting session, not of the
     floor — counting four bars for one night's close must not silently snap
     the date back to today on each switch. Everything that IS per-floor
     (the typed counts, the notes, the ✓saved markers, the as-of system
     figures, the history list) dies with the instance, which is the fix. */
  const [closingDate, setClosingDate] = useState(today());
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
  const [showAdjust, setShowAdjust] = useState(false);
  const [showBulkAdjust, setShowBulkAdjust] = useState(false);
  // Migration modal target: material_ids to preview, or 'all'
  const [migrateTarget, setMigrateTarget] = useState<string[] | 'all' | null>(null);

  const access: Access = accessByStore[storeId] ||
    { can_view: false, can_procure: false, can_adjust: false, can_close_stock: false };
  const store = stores.find(s => s.id === storeId) || null;
  // Where liquor bills land: the active stores that own ≥ 1 category. The
  // Goods Receipt TGBCL Liquor Bill posts each line into its material's
  // category-owning store, never into a floor bar (floors fill by transfer).
  const ownerStores = stores.filter(s => (s.categories?.length || 0) > 0);
  const ownsCategories = !!store && ownerStores.some(s => s.id === store.id);
  const ownerNames = ownerStores.map(s => s.name).join(', ');
  // The Goods Receipt liquor modal is offered to users with 'procure' on a
  // category-owning store (GET /api/grn?liquor_option=1) — same test here, so
  // the link never leads to a screen without the button.
  const canEnterLiquorBill = ownerStores.some(s => accessByStore[s.id]?.can_procure);

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
      setCatalog(j.catalog || j.stock || []);
      setMaterials(j.materials || []);
      setStockLoadedFor(storeId);
    } catch (e: any) { setError(e.message); }
    finally { setStockLoading(false); }
  }, [storeId, accessByStore]);

  /* Load ledger for selected store (server-side filters) */
  const loadLedger = useCallback(async () => {
    if (!storeId || !accessByStore[storeId]?.can_view) return;
    setLedgerLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      p.set('counts', '1');   // merge synthetic closing-count register rows (is_count)
      if (lType) p.set('type', lType);
      if (lQ.trim()) p.set('q', lQ.trim());
      if (lFrom) p.set('from', lFrom);
      if (lTo) p.set('to', lTo);
      const r = await fetch(`/api/stores/${storeId}/ledger?${p.toString()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setLedger(j.ledger || []);
      setBillCharges(j.bill_charges || {});
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

  /* Download the liquor inward register (one row per purchase line, TGBCL sheet
     column order; bill-level charges allocated per line) for the ledger's
     current date range. */
  const [regBusy, setRegBusy] = useState(false);
  const downloadInwardRegister = async () => {
    if (!storeId) return;
    setRegBusy(true);
    try {
      const p = new URLSearchParams();
      if (lFrom) p.set('from', lFrom);
      if (lTo) p.set('to', lTo);
      const r = await fetch(`/api/stores/${storeId}/inward-register?${p.toString()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const rows: any[] = j.rows || [];
      if (!rows.length) { setError('No inward lines for this store in the selected range.'); setTimeout(() => setError(null), 4000); return; }
      const clean = (v: any) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s) && !Number.isFinite(Number(s))) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const header = ['INVOICE ID', 'INWARD DATE', 'SUPPLIER NAME', 'CATEGORY NAME', 'ITEM NAME',
        'INWARD QTY', 'PURCHASE UNIT', 'RATE', 'SUBTOTAL', 'DISCOUNT', 'CGST', 'SGST',
        'SPECIAL EXCISE CESS', 'TCS', 'DELIVERY CHARGES', 'MRP ROUND OFF', 'EXCISE TURNOVER TAX', 'TOTAL INWARD AMOUNT'];
      const lines = [header.join(',')];
      for (const r0 of rows) lines.push([
        r0.invoice_ref, r0.inward_date, r0.supplier, r0.category, r0.item,
        r0.inward_qty, r0.purchase_unit, r0.rate, r0.subtotal, r0.discount, r0.cgst, r0.sgst,
        r0.special_excise_cess, r0.tcs, r0.delivery_charges, r0.mrp_round_off, r0.excise_turnover_tax, r0.total_inward_amount,
      ].map(clean).join(','));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `liquor-inward-register-${lFrom || 'all'}_to_${lTo || 'now'}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e: any) { setError(e.message); }
    finally { setRegBusy(false); }
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

  // Store has NO ledger history at all: saving a closing count is a pure
  // register write (it posts no ledger row), so stock stays empty until an
  // admin approves the variance it raised — look up the latest count date once
  // per stock load and surface the explainer banner.
  const noLedgerYet = stockLoadedFor === storeId && stock.every(r => !r.has_ledger);
  useEffect(() => {
    if (!storeId || stockLoadedFor !== storeId) return;
    if (!stock.every(r => !r.has_ledger)) return;   // only fetch when the condition holds
    let cancelled = false;
    fetch(`/api/stores/${storeId}/closing`)
      .then(r => r.json())
      .then(j => {
        if (!cancelled) setLatestCountByStore(prev => ({ ...prev, [storeId]: j?.dates?.[0]?.date || null }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [stock, stockLoadedFor, storeId]);

  /* Ledger + bill subtotals: bulk-bill lines share ref + created_at, so they
     sit consecutively (newest first). A group of >1 purchase rows with the
     same non-empty ref gets a subtotal marker appended. Synthetic closing-count
     rows (is_count, txn_type 'closing') can never be swallowed into a purchase
     group — grouping only chains consecutive txn_type==='purchase' rows. */
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
          // BOTH halves are store_stock_ledger columns, and that table is
          // recipe-basis on both: `quantity` is signed RECIPE units and
          // `unit_cost` is ₹ per RECIPE unit (src/lib/store-engine.ts:68,80).
          // The writers prove it: the Goods Receipt TGBCL Liquor Bill (and the
          // retired /api/stores/[id]/procure-bill before it) convert the
          // cases/bottles/loose entry to a recipe quantity and divide the
          // per-bottle price by the pack factor before storing, then book the
          // line_total as recipe_qty × unit_cost. This subtotal reproduces that
          // sum, so it equals the invoice line total. NOTE: `unit_cost` is
          // purchase-basis in the PURCHASE tables — it is recipe-basis only here.
          // rate-basis: recipe (store_stock_ledger.quantity × .unit_cost)
          total: Math.round(group.reduce((s, g) => s + (Number(g.quantity) || 0) * (Number(g.unit_cost) || 0), 0) * 100) / 100,
          supplier: group[0].supplier || '',
          charges: billCharges[ref.toLowerCase()] || null,
          grn: (() => {
            const n0 = String(group[0].notes || '').trim();
            return /^Goods Receipt /.test(n0) && group.every(g => String(g.notes || '').trim() === n0)
              ? n0 : '';
          })(),
        });
      }
      i = j;
    }
    return out;
  }, [ledger, billCharges]);

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
            {store?.name} — separate stock on its own ledger.
            {ownsCategories ? (
              <> Liquor bills are entered on Goods Receipt (GRN) → TGBCL Liquor Bill and post straight into this
                store; bills recorded here earlier stay on these reports.</>
            ) : ownerStores.length > 0 ? (
              <> Liquor bills are entered on Goods Receipt (GRN) → TGBCL Liquor Bill and post straight into
                {' '}{ownerNames}; this store&apos;s bottles arrive by transfer from there.</>
            ) : null}
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
        {access.can_adjust && (
          <button onClick={() => setShowBulkAdjust(true)}
                  title="Set / correct many materials' stock at once (opening or adjustment) via CSV"
                  className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm font-medium flex items-center gap-1.5">
            <Upload className="w-4 h-4" /> Bulk Adjust
          </button>
        )}
        {/* ONE DOOR PER INDENT (owner rulings #83/#84). New Bill and Upload CSV
            (Bill) are retired: a TGBCL bill — typed or uploaded as the TGBCL
            CSV — is entered on Goods Receipt (GRN) → TGBCL Liquor Bill, which
            records the GRN + PINV and posts the bottles straight into this
            store's ledger with the TGBCL charges and Net Indent. Their routes
            (procure / procure-bill / procure-bulk) answer 410. Bills recorded
            here before the switch-over stay on every tab and report below. */}
        {canEnterLiquorBill && (
          <a href="/grn?liquor=1"
             title={`Liquor bills are entered on Goods Receipt (GRN) → TGBCL Liquor Bill (cases / bottles / loose, the TGBCL charges, or the TGBCL CSV) — the bottles post straight into ${ownerNames}`}
             className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5">
            <ReceiptText className="w-4 h-4" /> Enter bill on Goods Receipt
          </a>
        )}
        {access.can_view && (
          <button onClick={downloadInwardRegister} disabled={regBusy}
                  title="Download the inward register (one row per line, TGBCL sheet column order) as CSV/Excel"
                  className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm font-medium flex items-center gap-1.5 disabled:opacity-50">
            {regBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Inward Register
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

          {/* Counts-without-ledger explainer: counts are a register, not stock.
              The old instruction here (“re-save each date with Adjust system
              stock ticked”) was doubly wrong — that tick has never existed on
              this screen, and the store closing route retired the flag when the
              approval queue shipped. The route now raises a PENDING variance
              approval per non-zero count, so the only way stock catches up is an
              admin decision in /variance-approvals.
              The double-post warning SURVIVES the rewrite, in a new shape: each
              pending row froze its difference against this store's EMPTY ledger,
              so every date approved posts the whole counted quantity again. */}
          {noLedgerYet && latestCountByStore[storeId] && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 sm:px-4 py-2.5 text-xs text-amber-900 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="flex-1 min-w-[240px]">
                <AlertTriangle className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
                Closing counts recorded (latest {latestCountByStore[storeId]}) — a count is a register entry, so
                saving one gave this store no stock. Re-save the <b>latest</b> count date in Closing Stock to send
                it to{' '}
                {isAdmin
                  ? <a href="/variance-approvals" className="text-amber-900 underline font-medium">Variance Approvals</a>
                  : 'Variance Approvals'}; stock reconciles to it only once an admin approves. Send <b>one</b> date
                only — every count here measured itself against an empty ledger, so approving two dates for one item
                posts its quantity twice. Or set opening stock via Adjustment / a transfer.
              </span>
              {access.can_close_stock && (
                <button onClick={() => setTab('closing')}
                        className="shrink-0 px-2.5 py-1 bg-white border border-amber-300 text-amber-900 hover:bg-amber-100 rounded-lg text-xs font-medium">
                  Open Closing Stock
                </button>
              )}
            </div>
          )}

          {/* Stock list */}
          {stockLoading ? (
            <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading stock…</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">
              {stock.length === 0
                ? (ownsCategories
                  ? 'No stock yet. Liquor bills are entered on Goods Receipt → TGBCL Liquor Bill — or set opening stock via Adjustment.'
                  : ownerStores.length > 0
                    ? `No stock yet. Bottles reach ${store?.name || 'this store'} by transfer from ${ownerNames} (Inventory → Store Transfers) — or set opening stock via Adjustment.`
                    : 'No stock yet. Set opening stock via Adjustment.')
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
                              <div className="text-[#2D1B0E] font-medium">
                                {r.material_name}
                                <span className="ml-1.5 text-[10px] align-middle"
                                      title={`Priority: ${r.priority === 3 ? 'Critical' : r.priority === 1 ? 'Low' : 'Standard'} (set on Raw Materials)`}>
                                  {'⭐'.repeat(r.priority === 3 ? 3 : r.priority === 1 ? 1 : 2)}
                                </span>
                              </div>
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
                                  In central: {qtyText(central, r)}
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
                              {/* ₹/purchase-unit leads (owner rule) — the row's quantities are
                                  bottles, so the rate beside them must be per bottle too.
                                  pc === 1 → ₹/recipe IS ₹/purchase, so only the label changes. */}
                              {pc > 1 ? <>{inr(r.avg_cost * pc)}/{r.purchase_unit}</> : <>{inr(r.avg_cost, 4)}/{puOf(r)}</>}
                              {pc > 1 && <div className="text-[10px] text-[#8B7355]">{inr(r.avg_cost, 4)}/{r.unit}</div>}
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
                          <div className="text-sm font-medium text-[#2D1B0E] break-words">
                            {r.material_name}
                            <span className="ml-1.5 text-[10px] align-middle"
                                  title={`Priority: ${r.priority === 3 ? 'Critical' : r.priority === 1 ? 'Low' : 'Standard'} (set on Raw Materials)`}>
                              {'⭐'.repeat(r.priority === 3 ? 3 : r.priority === 1 ? 1 : 2)}
                            </span>
                          </div>
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
                        <span>{(() => {
                          const mpc = packFactor(r);
                          return mpc > 1 ? `${inr(r.avg_cost * mpc)}/${r.purchase_unit}` : `${inr(r.avg_cost, 4)}/${puOf(r)}`;
                        })()}</span>
                        <span className="ml-auto font-semibold text-[#2D1B0E]">{inr(r.value)}</span>
                      </div>
                      {central > 0 && (
                        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-[#8B7355]">
                          <span>In central: {qtyText(central, r)}</span>
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
        /* ══════════════════════════════════════════════════════════════════
         * ONE COUNT SHEET PER FLOOR — `key={store.id}` IS THE FIX, NOT DECOR
         * ══════════════════════════════════════════════════════════════════
         * BAR FLOOR 1/2/3 and the LIQUOR STORE are SEPARATE store_locations
         * with separate ledgers, and this screen raises VARIANCE APPROVALS
         * that move real stock once an admin signs them. Without a key React
         * reconciled the SAME ClosingSection instance across a floor switch,
         * so every per-material box (cases/whole/loose/notes, keyed on
         * material_id alone), the "counted" chip and the client-computed
         * variance survived verbatim onto the next floor — and pressing Save
         * there wrote a REAL store_closing_counts row and a REAL pending
         * variance_approvals row against a floor nobody had counted.
         *
         * KEYING, NOT CLEARING, is deliberate. A clear-on-change effect has
         * to enumerate every piece of state, which is exactly how the bug was
         * born: the only reset this component had (seedFromCounts, reached
         * through `seed`) was gated on the DATE alone and had no notion of
         * which store was selected. A key needs no enumeration and cannot
         * rot as state is added — the instance is destroyed outright.
         *
         * `closingDate` is LIFTED so the remount does not silently snap the
         * Closing Date back to today. Counting a venue means counting four
         * stores for ONE business date; a date that resets itself mid-round
         * is its own wrong-day-count hazard. The date belongs to the counting
         * session, not to the floor, so it is the one thing that survives.
         *
         * THE LOAD GATE. `catalog` still holds the PREVIOUS floor's rows
         * until loadStock() resolves. Mounting against those would paint the
         * old floor's material list under the new floor's name, so the
         * section is not rendered at all until `stockLoadedFor` says the
         * catalog in hand belongs to the selected store. */
        stockLoadedFor === store.id ? (
          <ClosingSection
            key={store.id}
            storeId={store.id} storeName={store.name}
            stock={catalog} isAdmin={meRole === 'admin'}
            date={closingDate} onDateChange={setClosingDate}
            onSaved={afterWrite}
          />
        ) : stockLoading ? (
          <div className="p-8 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading {store.name}…
          </div>
        ) : (
          /* loadStock() failed (its message is in the `error` banner above).
             Refusing to render the sheet is the point: a count typed against
             another floor's catalog is the bug this screen just fixed. */
          <div className="p-8 text-center text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl space-y-3">
            <p>Could not load {store.name}&apos;s materials, so there is nothing safe to count against yet.</p>
            <button onClick={() => loadStock()}
                    className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm font-medium">
              Retry
            </button>
          </div>
        )
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
                        <th className="text-left px-3 py-2 font-medium">Invoice No.</th>
                        <th className="text-left px-3 py-2 font-medium">Notes</th>
                        <th className="text-left px-3 py-2 font-medium">By</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F0E4D6]">
                      {ledgerItems.map((item, idx) => {
                        if (item.kind === 'bill') {
                          return (
                            <tr key={`bill-${item.ref}-${idx}`} className="bg-[#FFF1E3]/70">
                              <td colSpan={10} className="px-3 py-1.5 text-[11px] text-[#6B5744]">
                                <ReceiptText className="w-3.5 h-3.5 inline mr-1 text-[#af4408]" />
                                Bill <span className="font-mono">{item.ref}</span>
                                {item.supplier ? ` · ${item.supplier}` : ''}
                                {item.grn && <> · <span className="font-mono">{item.grn}</span></>} — {item.count} lines,
                                subtotal <b className="text-[#2D1B0E]">{inr(item.total)}</b>
                                {item.charges && <BillChargesLine c={item.charges} />}
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
                                {l.is_count ? 'closing count' : l.txn_type}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-[#2D1B0E]">{l.material_name}</td>
                            {l.is_count ? (
                              /* Register row: never moves stock — no sign/value semantics */
                              <td className="px-3 py-2 text-right whitespace-nowrap">
                                {/* Same cases+bottles breakdown as every other qty in the module */}
                                <span className="font-medium text-[#2D1B0E]">Counted <DualQty qty={l.quantity} m={l} boldCls="font-medium text-[#2D1B0E]" /></span>
                                {isAdmin && (
                                  <div className="text-[10px] text-[#8B7355]">
                                    system {qtyText(l.system_qty ?? 0, l)} · variance {(l.variance ?? 0) > 0 ? '+' : ''}{(l.variance ?? 0) < 0 ? '−' : ''}{qtyText(Math.abs(l.variance ?? 0), l)}
                                  </div>
                                )}
                                <div className="text-[10px] italic text-[#8B7355]">count only — stock unchanged</div>
                              </td>
                            ) : (
                              <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${l.quantity < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                                <DualQty qty={l.quantity} m={l} sign
                                         boldCls={`font-medium ${l.quantity < 0 ? 'text-red-700' : 'text-emerald-700'}`} />
                              </td>
                            )}
                            <td className="px-3 py-2 text-right whitespace-nowrap text-[#6B5744]">
                              {!l.is_count && l.unit_cost > 0 ? (() => {
                                const lpc = packConv(l);
                                return lpc > 1
                                  ? <>{inr(l.unit_cost * lpc)}/{l.purchase_unit}<div className="text-[10px] text-[#8B7355]">{inr(l.unit_cost, 4)}/{l.unit}</div></>
                                  : <>{inr(l.unit_cost, 4)}/{puOf(l)}</>;
                              })() : '—'}
                            </td>
                            <td className="px-3 py-2 text-[#6B5744]">
                              {l.batch_no || '—'}
                              {l.expiry_date && <div className="text-[10px] text-[#8B7355]">exp {l.expiry_date}</div>}
                            </td>
                            <td className="px-3 py-2 text-[#6B5744]">{l.supplier || '—'}</td>
                            <td className="px-3 py-2 text-[#2D1B0E] font-mono text-[11px] whitespace-nowrap">{l.ref || '—'}</td>
                            <td className="px-3 py-2 text-[#6B5744] max-w-[180px] break-words">{l.notes || '—'}</td>
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
                        {item.supplier ? ` · ${item.supplier}` : ''}
                        {item.grn && <> · <span className="font-mono">{item.grn}</span></>} — {item.count} lines,
                        subtotal <b className="text-[#2D1B0E]">{inr(item.total)}</b>
                        {item.charges && <div className="mt-1"><BillChargesLine c={item.charges} /></div>}
                      </div>
                    );
                  }
                  const l = item.row;
                  return (
                    <div key={l.id} className="bg-white border border-[#E8D5C4] rounded-xl p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`inline-block border rounded-full px-2 py-0.5 text-[10px] capitalize ${TXN_BADGE[l.txn_type] || 'bg-gray-50 border-gray-200 text-gray-600'}`}>
                          {l.is_count ? 'closing count' : l.txn_type}
                        </span>
                        <span className="text-[10px] text-[#8B7355]">{String(l.created_at).slice(0, 16)}</span>
                      </div>
                      <div className="mt-1.5 text-sm font-medium text-[#2D1B0E] break-words">{l.material_name}</div>
                      {l.is_count ? (
                        /* Register row: never moves stock — no sign/value semantics */
                        <div className="mt-1 text-[#6B5744]">
                          <span className="font-semibold text-[#2D1B0E]">Counted <DualQty qty={l.quantity} m={l} boldCls="font-semibold text-[#2D1B0E]" /></span>
                          {isAdmin && (
                            <div className="text-[10px] text-[#8B7355]">
                              system {qtyText(l.system_qty ?? 0, l)} · variance {(l.variance ?? 0) > 0 ? '+' : ''}{(l.variance ?? 0) < 0 ? '−' : ''}{qtyText(Math.abs(l.variance ?? 0), l)}
                            </div>
                          )}
                          <div className="text-[10px] italic text-[#8B7355]">count only — stock unchanged</div>
                        </div>
                      ) : (
                        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[#6B5744]">
                          <span>
                            <DualQty qty={l.quantity} m={l} sign
                                     boldCls={`font-semibold ${l.quantity < 0 ? 'text-red-700' : 'text-emerald-700'}`} />
                          </span>
                          {l.unit_cost > 0 && <span>{(() => {
                            const lpc = packConv(l);
                            return lpc > 1 ? `${inr(l.unit_cost * lpc)}/${l.purchase_unit}` : `${inr(l.unit_cost, 4)}/${puOf(l)}`;
                          })()}</span>}
                        </div>
                      )}
                      <div className="mt-1 text-[10px] text-[#8B7355] space-x-2">
                        {l.supplier && <span>{l.supplier}</span>}
                        {l.batch_no && <span>batch {l.batch_no}</span>}
                        {l.expiry_date && <span>exp {l.expiry_date}</span>}
                        {l.ref && <span className="font-mono">inv {l.ref}</span>}
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

      {showAdjust && store && (
        <AdjustModal
          storeId={store.id} storeName={store.name}
          materials={materials} hasHistory={hasHistory}
          onClose={() => setShowAdjust(false)}
          onSaved={msg => { setShowAdjust(false); afterWrite(msg); }}
        />
      )}
      {showBulkAdjust && store && (
        <BulkAdjustModal
          storeId={store.id} storeName={store.name}
          stock={catalog} materials={materials}
          onClose={() => setShowBulkAdjust(false)}
          onSaved={msg => { setShowBulkAdjust(false); afterWrite(msg); }}
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

/* ── Bulk Adjustment / Opening Stock modal (CSV + manual lines) ────────────
   Set / correct many materials' stock for this store in ONE save. Each line
   carries a TARGET quantity (what's physically there now); the server posts
   'opening' for a brand-new material or an 'adjustment' delta for one that
   already has stock, so the ledger becomes that target. Multi-line entry in
   the layout the retired New Bill modal used + ClosingSection's Template /
   Upload-CSV convention. */

interface BulkLine { key: number; material_id: string; cbl: CBLValue; cost: string; }
const newBulkLine = (key: number): BulkLine => ({ key, material_id: '', cbl: CBL_EMPTY, cost: '' });

function BulkAdjustModal({ storeId, storeName, stock, materials, onClose, onSaved }: {
  storeId: string; storeName: string;
  stock: StockRow[]; materials: MatRow[];
  onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<BulkLine[]>([newBulkLine(1)]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tplCat, setTplCat] = useState('');
  const [importNote, setImportNote] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);

  const matById = useMemo(() => new Map(materials.map(m => [m.id, m])), [materials]);
  const stockById = useMemo(() => new Map(stock.map(r => [String(r.material_id), r])), [stock]);
  const cats = useMemo(
    () => Array.from(new Set(stock.map(r => r.category).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [stock]);

  const setLine = (key: number, patch: Partial<BulkLine>) =>
    setLines(ls => ls.map(l => l.key === key ? { ...l, ...patch } : l));
  const addLine = () => setLines(ls => [...ls, newBulkLine(Math.max(0, ...ls.map(l => l.key)) + 1)]);
  const removeLine = (key: number) => setLines(ls => ls.length > 1 ? ls.filter(l => l.key !== key) : [newBulkLine(1)]);

  /** Per-line plan mirroring the server: opening (new material) vs adjustment
   *  (delta to target) vs no-change. `touched` = the counter entered something. */
  const calc = (l: BulkLine) => {
    const mat = matById.get(l.material_id) || null;
    const srow = stockById.get(l.material_id) || null;
    const touched = l.cbl.cases !== '' || l.cbl.bottles !== '' || l.cbl.loose !== '';
    const target = mat ? cblRecipe(mat, l.cbl) : 0;
    const current = srow ? Number(srow.qty) || 0 : 0;
    const hasHist = srow ? !!srow.has_ledger : false;
    const delta = Math.round((target - current) * 1000) / 1000;
    let action: 'opening' | 'adjust' | 'nochange' | 'none';
    if (!l.material_id || !touched) action = 'none';
    else if (!hasHist) action = target > 0 ? 'opening' : 'nochange';
    else action = delta === 0 ? 'nochange' : 'adjust';
    return { mat, srow, touched, target, current, hasHist, delta, action };
  };

  const filled = lines.filter(l => l.material_id && (l.cbl.cases !== '' || l.cbl.bottles !== '' || l.cbl.loose !== ''));
  const willChange = lines.reduce((n, l) => n + (['opening', 'adjust'].includes(calc(l).action) ? 1 : 0), 0);

  const save = async () => {
    setErr(null);
    if (!reason.trim()) { setErr('A reason is required'); return; }
    if (filled.length === 0) { setErr('Add at least one material with a target quantity'); return; }
    const ids = filled.map(l => l.material_id);
    if (new Set(ids).size !== ids.length) { setErr('The same material is on more than one line — combine them into one'); return; }
    for (const l of filled) {
      const c = calc(l);
      if (c.target < 0) { setErr(`${c.mat?.name || 'A line'}: target quantity cannot be negative`); return; }
    }
    if (willChange === 0) { setErr('Nothing to change — every target already matches current stock'); return; }
    setBusy(true);
    try {
      const r = await api(`/api/stores/${storeId}/adjust-bulk`, {
        method: 'POST',
        body: {
          reason: reason.trim(),
          lines: filled.map(l => {
            const c = calc(l);
            return {
              material_id: l.material_id,
              quantity: c.target,
              // Cost basis only meaningful when this is the material's first
              // (opening) entry — server ignores it for adjustments.
              unit_price: (!c.hasHist && l.cost !== '') ? Number(l.cost) : undefined,
            };
          }),
        },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const s = j.summary || {};
      onSaved(`Bulk stock set in ${storeName} — ${s.opened || 0} opening, ${s.adjusted || 0} adjusted` +
        (s.unchanged ? `, ${s.unchanged} unchanged` : ''));
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  /* CSV template: filtered materials with current stock + blank target CBL. */
  const downloadTemplate = () => {
    const rows = stock
      .filter(r => !tplCat || r.category === tplCat)
      .sort((a, b) => a.material_name.localeCompare(b.material_name));
    const out = [CSV_COLS_BULKADJ.join(',')];
    for (const r of rows) {
      // Purchase figure leads; the recipe figure follows, explicitly labelled.
      // csvQty (not toLocaleString) — a grouped "1,250" breaks every spreadsheet.
      out.push([
        r.material_id, r.sku || '', r.material_name || '', r.category || '', puOf(r), r.unit || '',
        csvQty(toPurchaseQty(r.qty, r)), csvQty(r.qty), qtyText(r.qty, r),
        '', '', '', '',   // Cases / Bottles / Loose / Cost — blank to fill
      ].map(csvEscape).join(','));
    }
    const blob = new Blob([out.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${storeName.replace(/\s+/g, '-').toLowerCase()}-bulk-adjust-template.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  /* CSV upload: match id → SKU → Name, load Cases/Bottles/Loose as the TARGET
     into editable lines for review before Save (this moves stock, so we never
     fire straight from the file). */
  const uploadCsv = async (file: File) => {
    setErr(null); setImportNote(null); setImportErrors([]);
    try {
      const byId = new Map(stock.map(r => [String(r.material_id), r]));
      const bySku = new Map(stock.filter(r => r.sku).map(r => [String(r.sku).trim().toLowerCase(), r]));
      const byName = new Map(stock.map(r => [String(r.material_name).trim().toLowerCase(), r]));
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      if (parsed.errors?.length) { setImportErrors(['CSV parse error: ' + parsed.errors[0].message]); return; }
      const get = (row: any, ...keys: string[]) => {
        for (const k of keys) if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
        return '';
      };
      const imported: BulkLine[] = [];
      const errors: string[] = [];
      const usedIds = new Set<string>();
      let key = 1;
      for (const row of parsed.data as any[]) {
        const casesRaw = get(row, 'Cases', 'cases', 'Case', 'cs');
        const btlRaw = get(row, 'Bottles', 'bottles', 'Bottle', 'btl', 'Btl');
        const looseRaw = get(row, 'Loose', 'loose', 'Loose (ml)', 'ml');
        const costRaw = get(row, 'Cost/unit (opening only)', 'Cost/unit', 'Cost', 'cost', 'Price', 'price');
        const label = get(row, 'Name', 'name') || get(row, 'material_id') || get(row, 'SKU', 'sku') || 'row';
        if (casesRaw === '' && btlRaw === '' && looseRaw === '') continue;   // untouched row
        const idKey = get(row, 'material_id');
        const skuKey = get(row, 'SKU', 'sku').toLowerCase();
        const nameKey = get(row, 'Name', 'name').toLowerCase();
        const m = (idKey && byId.get(idKey)) || (skuKey && bySku.get(skuKey)) || (nameKey && byName.get(nameKey));
        if (!m) { errors.push(`${label}: material not found (check material_id / SKU / Name)`); continue; }
        if (usedIds.has(m.material_id)) { errors.push(`${label}: duplicate material in file — kept the first row`); continue; }
        // Non-numeric → SKIP the row (never silently coerce a bad token to 0),
        // mirroring the proven ClosingSection upload.
        let bad = false;
        for (const [v, nm] of [[casesRaw, 'Cases'], [btlRaw, 'Bottles'], [looseRaw, 'Loose'], [costRaw, 'Cost']] as const) {
          if (v !== '' && !Number.isFinite(Number(v))) { errors.push(`${label}: ${nm} must be a number`); bad = true; }
        }
        if (bad) continue;
        if ([casesRaw, btlRaw, looseRaw, costRaw].some(v => v !== '' && Number(v) < 0)) { errors.push(`${label}: values cannot be negative`); continue; }
        usedIds.add(m.material_id);
        // Normalise the CSV triple to the material's NATIVE entry mode via
        // breakdownQty (same round-trip ClosingSection uses to seed counts) so
        // the editable line shows exactly what will post — a plain/bl material
        // never hides a Cases/Loose value the single-box UI can't display.
        const rt = tripleToRecipe(numOr0(casesRaw), numOr0(btlRaw), numOr0(looseRaw), m);
        const bd = breakdownQty(rt, m);
        const cbl: CBLValue = bd
          ? { cases: bd.cases ? String(bd.cases) : '', bottles: bd.bottles ? String(bd.bottles) : '', loose: bd.loose ? String(bd.loose) : '' }
          : { cases: '', bottles: String(rt), loose: '' };
        // An explicit target of 0 (write stock down to zero) must stay "touched".
        if (!cbl.cases && !cbl.bottles && !cbl.loose) cbl.loose = '0';
        imported.push({ key: key++, material_id: m.material_id, cbl, cost: costRaw });
      }
      if (imported.length === 0) {
        setImportErrors(errors.length ? errors : ['No target quantities found — fill Cases / Bottles / Loose in the template']);
        return;
      }
      setLines(imported);
      setImportErrors(errors);
      setImportNote(`Loaded ${imported.length} material${imported.length === 1 ? '' : 's'} from CSV — review below, then Save.`);
    } catch (e: any) { setImportErrors([e.message]); }
  };

  const badge = (c: ReturnType<typeof calc>) => {
    const bd = (v: number) => c.mat ? qtyText(Math.abs(v), c.mat) : fq(Math.abs(v));
    if (c.action === 'opening') return <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-sky-50 border border-sky-200 text-sky-800 rounded-full px-2 py-0.5">Opening +{bd(c.target)}</span>;
    if (c.action === 'adjust') return <span className={`inline-flex items-center gap-1 text-[10px] font-semibold rounded-full px-2 py-0.5 border ${c.delta < 0 ? 'bg-red-50 border-red-200 text-red-700' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>{c.delta > 0 ? '+' : '−'}{bd(c.delta)}</span>;
    if (c.action === 'nochange') return <span className="text-[10px] text-[#8B7355]">No change</span>;
    return <span className="text-[10px] text-[#8B7355]">—</span>;
  };

  return (
    <ModalShell wide title="Bulk Adjustment / Opening Stock" icon={<SlidersHorizontal className="w-5 h-5 text-[#af4408]" />} onClose={onClose}
      footer={<>
        <span className="mr-auto text-sm text-[#6B5744]">
          <b className="text-[#2D1B0E]">{willChange}</b> line{willChange === 1 ? '' : 's'} will change
        </span>
        <button onClick={onClose} disabled={busy}
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">Cancel</button>
        <button onClick={save} disabled={busy || willChange === 0}
                className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Apply {willChange > 0 ? willChange : ''} change{willChange === 1 ? '' : 's'}
        </button>
      </>}>
      <p className="text-[11px] text-[#8B7355] -mt-1">
        Set each material's stock to the quantity physically on the floor. A brand-new material gets an
        <b> opening</b> entry; one that already has stock gets an <b>adjustment</b> to that target. {storeName} ledger only —
        Central Store is untouched.
      </p>
      {stock.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-2.5 text-xs">
          No materials are mapped to {storeName} yet — map its categories on Settings → Store Locations first,
          then they will appear here to set opening stock.
        </div>
      )}
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-sm text-red-700">{err}</div>}

      {/* Reason + CSV toolbar */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <L>Reason (required — applies to every line)</L>
          <input value={reason} onChange={e => setReason(e.target.value)}
                 aria-label="Adjustment reason" aria-required="true"
                 placeholder="e.g. monthly physical count / store handover" className={inputCls} />
        </div>
        <div>
          <L>Template category</L>
          <select value={tplCat} onChange={e => setTplCat(e.target.value)} className={inputCls}>
            <option value="">All categories</option>
            {cats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <button onClick={downloadTemplate} type="button"
                className="px-3 py-2 text-xs font-medium rounded-lg bg-[#FFF1E3] text-[#6B5744] hover:bg-[#E8D5C4] inline-flex items-center gap-1.5">
          <Download className="w-3.5 h-3.5" /> Template
        </button>
        <label className="px-3 py-2 text-xs font-medium rounded-lg bg-[#FFF1E3] text-[#6B5744] hover:bg-[#E8D5C4] inline-flex items-center gap-1.5 cursor-pointer focus-within:outline-none focus-within:ring-2 focus-within:ring-[#af4408]">
          <Upload className="w-3.5 h-3.5" /> Upload CSV
          <input type="file" accept=".csv,text/csv" className="sr-only" aria-label="Upload bulk-adjust CSV"
                 onChange={e => { const f = e.target.files?.[0]; if (f) uploadCsv(f); e.target.value = ''; }} />
        </label>
      </div>

      {importNote && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg p-2.5 text-xs flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> {importNote}
        </div>
      )}
      {importErrors.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-2.5 text-xs space-y-0.5">
          {importErrors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}

      {/* Lines */}
      <div className="space-y-2">
        {lines.map((l, i) => {
          const c = calc(l);
          return (
            <div key={l.key} className="border border-[#E8D5C4] rounded-lg p-2.5 space-y-2 bg-[#FFFDF9]">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-[#8B7355] shrink-0">#{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <MaterialTypeahead materials={materials as MaterialLite[]} value={l.material_id}
                                     onPick={id => setLine(l.key, { material_id: id, cbl: CBL_EMPTY, cost: '' })}
                                     showStock={false} compact
                                     placeholder="Material — name, SKU or category…" />
                </div>
                <button type="button" onClick={() => removeLine(l.key)} disabled={lines.length === 1 && !l.material_id}
                        className="shrink-0 text-[#8B7355] hover:text-red-700 disabled:opacity-30" title="Remove line">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <CBLEntry mat={c.mat} value={l.cbl} onChange={v => setLine(l.key, { cbl: v })} />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#6B5744]">
                {l.material_id && (
                  <span>Current: <b className="text-[#2D1B0E]">{c.srow ? qtyText(c.current, c.srow) : '—'}</b></span>
                )}
                {c.touched && <span>Change: {badge(c)}</span>}
                {c.action === 'opening' && (
                  <span className="flex items-center gap-1.5">
                    <label className="text-[10px] uppercase tracking-wide text-[#8B7355]">Cost / {c.mat?.purchase_unit || c.mat?.unit || 'unit'} (₹, optional)</label>
                    <input type="number" min={0} step="any" inputMode="decimal" value={l.cost}
                           onChange={e => setLine(l.key, { cost: e.target.value })}
                           aria-label={`Opening cost per ${c.mat?.purchase_unit || c.mat?.unit || 'unit'}`}
                           placeholder="0" className="w-24 px-2 py-1 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]" />
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <button onClick={addLine} type="button"
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
  // `central_stock` is raw_materials.current_stock (RECIPE units;
  // /api/stores/[id]/stock sets central_stock from that column) and
  // `average_price` is raw_materials.average_price (₹ per RECIPE unit by canon).
  // Recipe qty × recipe rate = a rupee VALUE, and a value is basis-invariant, so
  // it sits safely beside the purchase-unit quantity column below — the same
  // shape the Inventory audit certified. Live proof: SUNFLOWER OIL 1LTR
  // 1,182,000 ml × ₹0.1785/ml = ₹210,987 = 1,182 BTL × ₹178.50/BTL. This is also
  // exactly what /api/stores/[id]/migrate posts (qty = current_stock,
  // unit_cost = average_price), so the preview matches the API to the paisa.
  // rate-basis: recipe (raw_materials.current_stock × raw_materials.average_price)
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
                      {qtyText(r.central_stock, r)}
                      {packConv(r) > 1 && <span className="text-[10px]"> · {fq(r.central_stock)} {r.unit}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap font-medium text-[#2D1B0E]">
                      {/* Same pair as totalValue above: current_stock (RECIPE
                          units) × average_price (₹/RECIPE unit). The rupee VALUE
                          is basis-invariant, so it is correct beside the
                          purchase-unit qty rendered in the cell to its left.
                          rate-basis: recipe (current_stock × average_price) */}
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
  case_size: number; category?: string;
}
interface ClosingDay {
  date: string; item_count: number; shortage_count: number; excess_count: number;
  total_variance_value: number; abs_variance_value: number;
}

/* Closing-stock CSV template columns — keeps the liquor Cases+Bottles+loose
   entry convention (blank for the counter to fill). The stock columns say WHICH
   basis they are in: the purchase figure leads, the recipe figure is labelled.
   COL_SYS_* are the admin-only pair the blind-count filter strips — keep those
   names in sync with the filter below (they are matched by string). */
const COL_SYS_PU = 'System stock (purchase)';
const COL_SYS_RECIPE = 'System stock (recipe)';
const COL_SYS_CBL = 'System (cs+btl+loose)';
const CSV_COLS_CLOSE = ['material_id', 'SKU', 'Name', 'Category', 'Purchase unit', 'Recipe unit',
  COL_SYS_PU, COL_SYS_RECIPE, COL_SYS_CBL, 'Cases', 'Bottles', 'Loose'];

/* Bulk-adjust CSV template columns — Cases/Bottles/Loose is the TARGET stock
   to set (blank row = untouched); Cost/unit is optional, used only when the
   material is getting its first (opening) entry. */
const CSV_COLS_BULKADJ = ['material_id', 'SKU', 'Name', 'Category', 'Purchase unit', 'Recipe unit',
  'Current stock (purchase)', 'Current stock (recipe)', 'Current (cs+btl+loose)',
  'Cases', 'Bottles', 'Loose', 'Cost/unit (opening only)'];

/* ── Closing Stock section — category-wise "Record Closing Stock" ──────────
   Mirrors the central /closing-stock modal (header + Template / Upload CSV /
   View History, filter row, Material|Category|System Stock|Unit|Physical
   Count|Variance|Notes table) but keeps the liquor Cases + Bottles + loose
   entry convention. Rows come from the page-loaded `stock` (every mapped
   material, zero-stock included); GET …/closing?date= prefills existing
   counts + notes for the chosen date. */
function ClosingSection({ storeId, storeName, stock, isAdmin, date, onDateChange, onSaved }: {
  storeId: string; storeName: string; stock: StockRow[];
  isAdmin: boolean;
  /** Owned by the page so it survives the per-store remount (see render site). */
  date: string; onDateChange: (d: string) => void;
  onSaved: (msg: string) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [counts, setCounts] = useState<ClosingCount[]>([]);
  const [systemAsof, setSystemAsof] = useState<Record<string, number>>({});
  /* TRUE on mount, not false. A fresh instance must never paint the count
     grid before its GET lands: `systemAsof` is empty until then, so every
     System Stock cell would read 0 btl and every typed figure would show as
     a full-quantity EXCESS — the exact number the owner saw leak across his
     floors. The grid is already gated on `dayLoading` (below); starting it
     armed closes the one frame between mount and the first effect. */
  const [dayLoading, setDayLoading] = useState(true);
  const [cases, setCases] = useState<Record<string, string>>({});   // full cases (case_size × BTL)
  const [whole, setWhole] = useState<Record<string, string>>({});   // purchase units (BTL)
  const [loose, setLoose] = useState<Record<string, string>>({});   // recipe units (ml)
  const [notes, setNotes] = useState<Record<string, string>>({});   // per-row note
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // `pending` mirrors summary.pending_count so the import panel can say the same
  // thing the manual Save toast says. Optional because every failure path sets a
  // result with nothing imported — and therefore nothing queued for approval.
  const [csvResult, setCsvResult] = useState<{ success: number; pending?: number; errors: string[]; notCounted?: number } | null>(null);
  /* THE ZERO-PATTERN REFUSAL (owner requirement 7). Both write paths here — the
     manual Save and the CSV upload — post to /api/stores/[id]/closing, which
     answers 409 with `zero_guard` when an implausible share of the counted lines
     read 0. Nothing is written; `onConfirm` re-sends the SAME payload with
     confirm_zeros so a bar that really was emptied can still be recorded. */
  const [zeroGuard, setZeroGuard] = useState<(ZeroGuardInfo & { what: string; onConfirm: () => void }) | null>(null);
  // Filters
  const [catFilter, setCatFilter] = useState('');
  const [q, setQ] = useState('');
  // History
  const [days, setDays] = useState<ClosingDay[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histDate, setHistDate] = useState('');
  const [histCat, setHistCat] = useState('');

  /* ════════════════════════════════════════════════════════════════════════
   * WHICH FLOOR ARE THE BOXES FILLED FOR? — the honest answer, kept in a ref
   * ════════════════════════════════════════════════════════════════════════
   * Not "which floor is selected" (that is `storeId`), but "which floor was
   * selected when the figures now sitting in cases/whole/loose/notes were
   * typed". The two are the same only because this component is keyed on the
   * store and because the guard below re-arms it — and it is precisely the
   * gap between those two questions that let a count typed on BAR FLOOR 1 be
   * saved onto BAR FLOOR 2. It rides along in every POST body as `store_id`,
   * where the route compares it with the store in its own URL and refuses the
   * write if they disagree (src/app/api/stores/[id]/closing/route.ts).
   *
   * Because it is seeded once per MOUNT, it cannot be fooled by the same
   * refactor that would reintroduce the bug: strip the key and drop the reset
   * below, and this ref stays pinned to the floor the boxes were filled for,
   * so the server — not the screen — stops the write. */
  const gatheredForStore = useRef(storeId);
  /** Last `${store}|${date}` the input boxes were seeded for. Carries the
   *  STORE as well as the date; tracking the date alone is the defect. */
  const seededFor = useRef<string | null>(null);

  /* ════════════════════════════════════════════════════════════════════════
   * SECOND LINE OF DEFENCE — reset DURING RENDER if the store ever changes
   * ════════════════════════════════════════════════════════════════════════
   * The page keys this component on the store, so in the shipped tree this
   * branch never runs: a floor switch destroys the instance instead. It is
   * here for the day someone removes that key. React's documented "adjust
   * state when a prop changes" pattern — a set during render, applied before
   * anything is painted — so the previous floor's figures are gone BEFORE a
   * frame can show them or a click can save them, which an effect could not
   * promise. Everything derived from a floor is listed; `date` is not,
   * because the date is the session's, not the floor's. */
  const [renderedForStore, setRenderedForStore] = useState(storeId);
  if (renderedForStore !== storeId) {
    setRenderedForStore(storeId);
    gatheredForStore.current = storeId;
    seededFor.current = null;
    setCases({}); setWhole({}); setLoose({}); setNotes({});
    setCounts([]); setSystemAsof({}); setDayLoading(true);
    setCsvResult(null); setZeroGuard(null); setErr(null); setBusy(false);
    setCatFilter(''); setQ('');
    setShowHistory(false); setDays([]); setHistDate(''); setHistCat('');
  }

  const seedFromCounts = useCallback((rows: ClosingCount[]) => {
    // Prefill the Cases/Bottles/loose inputs + notes from that date's saved
    // counts so re-opening a counted day is editable, not blank.
    const c: Record<string, string> = {};
    const w: Record<string, string> = {};
    const l: Record<string, string> = {};
    const n: Record<string, string> = {};
    for (const row of rows) {
      const meta: PackMeta = { unit: row.unit, purchase_unit: row.purchase_unit, pack_size: row.pack_size, case_size: row.case_size };
      const bd = breakdownQty(row.physical_qty, meta);
      if (bd) {
        if (bd.cases) c[row.material_id] = String(bd.cases);
        if (bd.bottles) w[row.material_id] = String(bd.bottles);
        if (bd.loose) l[row.material_id] = String(bd.loose);
        // A saved count of exactly 0 must still round-trip (all parts blank →
        // treated as "not entered"), so pin a 0 in the loose box.
        if (!bd.cases && !bd.bottles && !bd.loose) l[row.material_id] = '0';
      } else {
        l[row.material_id] = String(row.physical_qty);
      }
      if (row.note) n[row.material_id] = row.note;
    }
    setCases(c); setWhole(w); setLoose(l); setNotes(n);
  }, []);

  const loadDay = useCallback(async (d: string, seed: boolean) => {
    setDayLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/stores/${storeId}/closing?date=${d}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const rows: ClosingCount[] = j.counts || [];
      setCounts(rows);
      const m: Record<string, number> = {};
      for (const s of j.system_asof || []) m[s.material_id] = Number(s.qty) || 0;
      setSystemAsof(m);
      if (seed) seedFromCounts(rows);
    } catch (e: any) { setErr(e.message); }
    finally { setDayLoading(false); }
  }, [storeId, seedFromCounts]);

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

  // Changing the count date reloads + re-seeds inputs from that day's counts.
  // Returning from History (showHistory true→false) must NOT re-seed: it would
  // wipe in-progress physical counts / notes. We still reload (seed=false) so
  // the ✓saved markers and System Stock refresh to `date` after browsing other
  // dates in history — but only actually re-seed when the SHEET changed.
  //
  // "THE SHEET" IS STORE **AND** DATE — this was the defect. The key was the
  // bare date, so the effect re-ran on a floor switch (loadDay's identity
  // changes with storeId, which is why counts and systemAsof correctly
  // reloaded) but computed seed === false, seedFromCounts was never called,
  // and the typed boxes carried the previous floor's count over verbatim.
  // A count sheet is identified by the floor it is for as much as by the day.
  useEffect(() => {
    if (showHistory) return;
    setCsvResult(null);
    const sheet = `${storeId}|${date}`;
    const seed = seededFor.current !== sheet;
    seededFor.current = sheet;
    loadDay(date, seed);
  }, [storeId, date, showHistory, loadDay]);
  useEffect(() => { if (showHistory) { loadHistory(); setHistDate(''); setHistCat(''); } }, [showHistory, loadHistory]);

  const countedBy = useMemo(() => {
    const m = new Map<string, ClosingCount>();
    for (const c of counts) m.set(c.material_id, c);
    return m;
  }, [counts]);

  const cats = useMemo(
    () => Array.from(new Set(stock.map(r => r.category).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [stock],
  );

  const rows = useMemo(() => {
    const raw = q.trim().toLowerCase();
    return [...stock]
      .filter(r => {
        if (catFilter && r.category !== catFilter) return false;
        if (!raw) return true;
        return `${r.material_name} ${r.sku} ${r.category}`.toLowerCase().includes(raw);
      })
      .sort((a, b) => a.material_name.localeCompare(b.material_name));
  }, [stock, catFilter, q]);

  // Physical qty in RECIPE units from the Cases/Bottles/loose entry (null =
  // untouched row): cases × case_size × pack + bottles × pack + loose.
  const physicalFor = (r: StockRow): number | null => {
    // `.trim()` before the emptiness test: a whitespace-only box is a BLANK box,
    // and Number('   ') is 0, so without it one stray space in any of the three
    // slots turned "nobody counted this" into a counted zero for the whole row.
    const num = (s?: string) => {
      const t = (s ?? '').trim();
      return t !== '' && !isNaN(Number(t)) ? Number(t) : null;
    };
    const c = num(cases[r.material_id]), w = num(whole[r.material_id]), l = num(loose[r.material_id]);
    if (c == null && w == null && l == null) return null;
    return tripleToRecipe(c ?? 0, w ?? 0, l ?? 0, r);
  };

  /* BLANK vs ZERO, made an explicit action rather than a typing convention.
     "None left" fills the row's primary box with a literal 0, which makes
     physicalFor() return 0 — a real count of an empty shelf. "Clear" empties all
     three boxes, which makes it return null — not counted, nothing posted. */
  const markNone = (r: StockRow, hasWholeBox: boolean) => {
    if (hasWholeBox) setWhole(p => ({ ...p, [r.material_id]: '0' }));
    else setLoose(p => ({ ...p, [r.material_id]: '0' }));
  };
  const clearCount = (r: StockRow) => {
    setCases(p => ({ ...p, [r.material_id]: '' }));
    setWhole(p => ({ ...p, [r.material_id]: '' }));
    setLoose(p => ({ ...p, [r.material_id]: '' }));
  };
  // As-of-date ledger sum for the chosen closing date (0 when the material has
  // no ledger rows on/before that date). Must NOT fall back to the live
  // all-time qty — that would make a backdated System Stock/variance disagree
  // with what the POST route persists (which computes SUM as-of `date` = 0).
  const systemFor = (r: StockRow): number => systemAsof[r.material_id] ?? 0;

  // Every material the user entered a physical count for is saved — derived from
  // the FULL mapped stock list, not the filtered `rows`, so a count typed before
  // changing the Category/Search filter is never silently dropped on Save.
  const pending = stock
    .map(r => ({ r, phys: physicalFor(r) }))
    .filter((x): x is { r: StockRow; phys: number } => x.phys != null);
  const pendingVarianceValue = pending.reduce(
    (s, { r, phys }) => s + (phys - systemFor(r)) * (Number(r.avg_cost) || 0), 0);
  /** How many of the counts about to be saved read 0 — the pattern the server
   *  guards on, surfaced before the save rather than only in its refusal. */
  const pendingZeros = pending.filter(p => p.phys === 0).length;

  const save = async (confirmZeros = false) => {
    if (pending.length === 0) return;
    if (pending.some(p => p.phys < 0)) { setErr('Physical counts cannot be negative'); return; }
    setErr(null); setBusy(true);
    try {
      // Each row carries its OWN note. The batch-level `note` is left empty so
      // the route's fallback (blank item note → batch note) cannot copy one
      // row's note onto rows the counter left un-noted.
      const r = await api(`/api/stores/${storeId}/closing`, {
        method: 'POST',
        body: {
          // THE FLOOR THESE FIGURES WERE TYPED FOR, declared to the server so
          // it can refuse a sheet aimed at a different store than the one in
          // its URL. Deliberately gatheredForStore.current, NOT `storeId`:
          // sending the URL's store back to the server would assert nothing.
          store_id: gatheredForStore.current,
          date,
          items: pending.map(({ r, phys }) => ({
            material_id: r.material_id,
            physical_qty: phys,
            note: (notes[r.material_id] || '').trim(),
          })),
          note: '',
          confirm_zeros: confirmZeros,
        },
      });
      const j = await r.json();
      // THE ZERO-PATTERN REFUSAL. 409 + zero_guard and nothing was written —
      // a bar count of 200 lines can reach the guard's floors easily. Ask.
      if (!r.ok && r.status === 409) {
        const guard = readZeroGuard(j);
        if (guard) {
          setZeroGuard({
            ...guard, what: `${storeName}'s count`,
            onConfirm: () => { setZeroGuard(null); save(true); },
          });
          setBusy(false);
          return;
        }
      }
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadDay(date, true);
      // BLIND COUNTS: the server now returns pending_count as null for non-admins,
      // so branch on isAdmin rather than on the value — a null would otherwise fall
      // into the "all match the system" arm and tell the counter their figure was
      // right, which is the exact disclosure the null is there to prevent.
      onSaved(`Saved ${j.summary.items} closing count${j.summary.items === 1 ? '' : 's'} for ${date}` +
        (isAdmin
          ? (j.summary.pending_count
              ? ` — ${j.summary.pending_count} sent to Variance Approvals for review`
              : ' — all match the system, nothing to approve')
          : ' — recorded; any difference goes to Variance Approvals for review'));
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  /* ── CSV template + bulk upload ──────────────────────────────────────
     Template exports the currently-filtered material set with blank
     Cases/Bottles/Loose columns; upload matches by material_id → SKU → Name,
     converts the triple to recipe units and posts to the SAME endpoint as the
     manual Save — so a bulk file records counts and raises the same PENDING
     variance approvals. Neither path reconciles stock on its own. */
  const downloadTemplate = () => {
    // Blind count: non-admins get the template WITHOUT any System stock column.
    const cols = isAdmin
      ? CSV_COLS_CLOSE
      : CSV_COLS_CLOSE.filter(c => c !== COL_SYS_PU && c !== COL_SYS_RECIPE && c !== COL_SYS_CBL);
    const lines = [cols.join(',')];
    for (const r of rows) {
      const base = [r.material_id, r.sku || '', r.material_name || '', r.category || '', puOf(r), r.unit || ''];
      // System stock only for admins — purchase basis first, recipe labelled.
      // Cases / Bottles / Loose stay blank for the counter to fill.
      lines.push((isAdmin
        ? [...base, csvQty(toPurchaseQty(systemFor(r), r)), csvQty(systemFor(r)), qtyText(systemFor(r), r), '', '', '']
        : [...base, '', '', '']).map(csvEscape).join(','));
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `liquor-closing-template-${date}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const uploadCsv = async (file: File) => {
    setBusy(true); setErr(null); setCsvResult(null);
    try {
      const byId = new Map(stock.map(r => [String(r.material_id), r]));
      const bySku = new Map(stock.filter(r => r.sku).map(r => [String(r.sku).trim().toLowerCase(), r]));
      const byName = new Map(stock.map(r => [String(r.material_name).trim().toLowerCase(), r]));
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      if (parsed.errors?.length) {
        setCsvResult({ success: 0, errors: ['CSV parse error: ' + parsed.errors[0].message] });
        return;
      }
      const get = (row: any, ...keys: string[]) => {
        for (const k of keys) if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
        return '';
      };
      const items: { material_id: string; physical_qty: number; note: string }[] = [];
      const errors: string[] = [];
      for (const row of parsed.data as any[]) {
        const casesRaw = get(row, 'Cases', 'cases', 'Case', 'cs');
        const btlRaw = get(row, 'Bottles', 'bottles', 'Bottle', 'btl', 'Btl');
        const looseRaw = get(row, 'Loose', 'loose', 'Loose (ml)', 'ml');
        const label = get(row, 'Name', 'name') || get(row, 'material_id') || get(row, 'SKU', 'sku') || 'row';
        if (casesRaw === '' && btlRaw === '' && looseRaw === '') continue;   // nothing entered → skip
        const idKey = get(row, 'material_id');
        const skuKey = get(row, 'SKU', 'sku').toLowerCase();
        const nameKey = get(row, 'Name', 'name').toLowerCase();
        const m = (idKey && byId.get(idKey)) || (skuKey && bySku.get(skuKey)) || (nameKey && byName.get(nameKey));
        if (!m) { errors.push(`${label}: material not found (check material_id / SKU / Name)`); continue; }
        const c = casesRaw === '' ? 0 : Number(casesRaw);
        const w = btlRaw === '' ? 0 : Number(btlRaw);
        const l = looseRaw === '' ? 0 : Number(looseRaw);
        if ([c, w, l].some(v => !Number.isFinite(v))) { errors.push(`${label}: Cases/Bottles/Loose must be numbers`); continue; }
        if (c < 0 || w < 0 || l < 0) { errors.push(`${label}: counts cannot be negative`); continue; }
        items.push({ material_id: m.material_id, physical_qty: tripleToRecipe(c, w, l, m), note: '' });
      }
      if (items.length === 0) {
        setCsvResult({ success: 0, errors: errors.length ? errors : ['No counts found in the file (fill Cases / Bottles / Loose)'] });
        return;
      }
      await sendClosingItems(items, errors, false);
    } catch (e: any) { setCsvResult({ success: 0, errors: [e.message] }); }
    finally { setBusy(false); }
  };

  /**
   * POST a parsed file. A zero-guard retry re-sends THIS payload — the file is
   * not re-read and the rows are not re-derived, so the number the dialog quoted
   * is the number that gets written.
   */
  const sendClosingItems = async (
    items: { material_id: string; physical_qty: number; note: string }[],
    parseErrors: string[],
    confirmZeros: boolean,
  ) => {
    setBusy(true);
    const errors = [...parseErrors];
    try {
      const r = await api(`/api/stores/${storeId}/closing`, {
        method: 'POST',
        // `adjust_to_physical` is retired — the route ignores it and sends every
        // non-zero variance to the approval queue. Kept pinned to false so the
        // bulk path can never opt into an inline reconcile if the flag returns.
        // `store_id` is the floor the file was parsed against (see save()).
        body: {
          store_id: gatheredForStore.current,
          date, items, adjust_to_physical: false, confirm_zeros: confirmZeros,
        },
      });
      const j = await r.json();
      // THE ZERO-PATTERN REFUSAL — the spreadsheet door, and the one the
      // incident came through on the central rail. Nothing was written.
      if (!r.ok && r.status === 409) {
        const guard = readZeroGuard(j);
        if (guard) {
          setZeroGuard({
            ...guard, what: 'this file',
            onConfirm: () => { setZeroGuard(null); sendClosingItems(items, parseErrors, true); },
          });
          return;
        }
      }
      if (!r.ok) { setCsvResult({ success: 0, errors: [...errors, j.error || `HTTP ${r.status}`] }); return; }
      // Same POST as the manual Save, so the same thing happened to the counts —
      // say so in the SAME words, or a spreadsheet counter (the usual path here)
      // never learns their variances are sitting in a queue.
      const imported = j.summary?.items || 0;
      const queued = j.summary?.pending_count || 0;
      // Blank rows the server refused to invent a zero for. Not an error and not
      // a loss — but a file of 300 rows answering "imported 40" reads as one
      // unless the rest is accounted for. Safe for everyone: it counts what the
      // file CONTAINED, never how those figures compare to system stock.
      const notCounted = Number(j.summary?.not_counted) || 0;
      setCsvResult({ success: imported, pending: queued, errors, notCounted });
      await loadDay(date, true);
      // BLIND COUNTS: the "N queued" / "all match the system" pair is an exact
      // oracle for the figure this screen deliberately withholds — upload one
      // line, nudge the number, and the message flips at precisely system stock.
      // downloadTemplate() strips the system columns and the GET route nulls
      // shortage/excess/match for non-admins for this reason. Admins get the
      // count; everyone else gets a variance-independent confirmation.
      onSaved(`Imported ${imported} closing count${imported === 1 ? '' : 's'} for ${date}` +
        (isAdmin
          ? (queued
              ? ` — ${queued} sent to Variance Approvals for review`
              : ' — all match the system, nothing to approve')
          : ' — recorded; any difference goes to Variance Approvals for review'));
    } catch (e: any) { setCsvResult({ success: 0, errors: [e.message] }); }
    finally { setBusy(false); }
  };

  /* history detail = read-only counts of a past date */
  const openHistDate = (d: string) => { setHistDate(d); setHistCat(''); loadDay(d, false); };
  const histCats = useMemo(
    () => Array.from(new Set(counts.map(c => c.category || '').filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [counts],
  );
  const histRows = useMemo(
    () => counts.filter(c => !histCat || (c.category || '') === histCat),
    [counts, histCat],
  );

  const inCls = 'w-full px-2 py-2 border border-[#D4B896] rounded-lg text-sm bg-[#FFF1E3] text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]';
  const box = 'w-16 px-1.5 py-1 border border-[#D4B896] rounded text-xs text-right font-mono bg-white focus:outline-none focus:ring-1 focus:ring-[#af4408]';
  const boxM = 'w-14 px-1.5 py-1 border border-[#D4B896] rounded text-xs text-right font-mono bg-white focus:outline-none focus:ring-1 focus:ring-[#af4408]';

  return (
    <div className="space-y-4">
      {/* Header — mirrors the central Record Closing Stock modal */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
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
              <button onClick={downloadTemplate}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[#FFF1E3] text-[#6B5744] hover:bg-[#E8D5C4] inline-flex items-center gap-1"
                      title="Download a CSV of the filtered materials with blank Cases / Bottles / Loose columns">
                <Download className="w-3.5 h-3.5" /> Template
              </button>
              <label className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[#FFF1E3] text-[#6B5744] hover:bg-[#E8D5C4] inline-flex items-center gap-1 cursor-pointer focus-within:outline-none focus-within:ring-2 focus-within:ring-[#af4408]"
                     title="Upload the filled CSV to record physical counts in bulk">
                <Upload className="w-3.5 h-3.5" /> Upload CSV
                {/* sr-only (not `hidden`) keeps the input in the tab order so
                    keyboard / screen-reader users can reach the bulk upload. */}
                <input type="file" accept=".csv,text/csv" className="sr-only" aria-label="Upload closing-stock CSV"
                       onChange={e => { const f = e.target.files?.[0]; if (f) uploadCsv(f); e.target.value = ''; }} />
              </label>
            </>
          )}
          <button onClick={() => setShowHistory(v => !v)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg inline-flex items-center gap-1 ${showHistory ? 'bg-purple-100 text-purple-700' : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#E8D5C4]'}`}>
            <History className="w-3.5 h-3.5" /> {showHistory ? 'Back to Entry' : 'View History'}
          </button>
        </div>
      </div>

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {err}
        </div>
      )}

      {!showHistory ? (
        <>
          {/* Filter row: Closing Date* · Category · Search Material · Adjust */}
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label htmlFor="lc-date" className="block text-xs font-medium text-[#6B5744] mb-1">Closing Date *</label>
              <input id="lc-date" type="date" value={date} max={today()}
                     onChange={e => onDateChange(e.target.value)}
                     className={`${inCls} [color-scheme:light]`} />
            </div>
            <div>
              <label htmlFor="lc-cat" className="block text-xs font-medium text-[#6B5744] mb-1">Category</label>
              <select id="lc-cat" value={catFilter} onChange={e => setCatFilter(e.target.value)} className={inCls}>
                <option value="">All Categories</option>
                {cats.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-[180px]">
              <label htmlFor="lc-search" className="block text-xs font-medium text-[#6B5744] mb-1">Search Material</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
                <input id="lc-search" type="text" value={q} onChange={e => setQ(e.target.value)}
                       placeholder="Filter by name, SKU, category…" className={`${inCls} pl-10`} />
              </div>
            </div>
          </div>

          {/* The Variance Approvals link is ADMIN-only — the page is adminOnly in
              the catalog, so linking a counter there just sends them to a door
              that will not open. Non-admins get the same sentence, unlinked. */}
          <p className="text-[11px] text-[#8B7355]">
            Physical count for <b>{date}</b>. Saving records the count only — any difference from the system is
            sent to {isAdmin
              ? <a href="/variance-approvals" className="text-[#af4408] underline">Variance Approvals</a>
              : 'Variance Approvals'} for an admin to review; stock changes only after approval.
            {!isAdmin && ' The system figure is hidden so your count is unbiased.'}
          </p>

          {csvResult && (
            <div className={`p-3 rounded-lg border ${csvResult.errors.length > 0 && csvResult.success === 0 ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
              <div className="flex items-start gap-2 text-sm">
                {csvResult.success > 0 ? <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5" /> : <AlertCircle className="w-4 h-4 text-red-500 mt-0.5" />}
                <div>
                  {csvResult.success > 0 && (
                    <p className="text-green-700">
                      Imported {csvResult.success} count{csvResult.success === 1 ? '' : 's'} from CSV
                      {/* Admin-only figures — same blind-count oracle as the toast above. */}
                      {isAdmin
                        ? (csvResult.pending
                            ? ` — ${csvResult.pending} sent to Variance Approvals for review; stock changes only after approval.`
                            : ' — all match the system, nothing to approve.')
                        : ' — recorded; any difference goes to Variance Approvals for review, and stock changes only after approval.'}
                    </p>
                  )}
                  {(csvResult.notCounted ?? 0) > 0 && (
                    <p className="text-xs text-[#6B5744]">
                      {csvResult.notCounted} row{csvResult.notCounted === 1 ? ' was' : 's were'} left blank — recorded as <b>not counted</b>, not as zero. Nothing was written for them.
                    </p>
                  )}
                  {csvResult.errors.map((e, i) => <p key={i} className="text-red-600 text-xs">{e}</p>)}
                </div>
              </div>
            </div>
          )}

          {dayLoading ? (
            <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
          ) : stock.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">
              Nothing to count yet — record a purchase or opening stock first.
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">
              No materials match the current filters.
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead className="bg-[#FFF1E3] text-[#8B7355] text-xs">
                      <tr>
                        <th className="text-left px-3 py-2.5 font-medium">Material</th>
                        <th className="text-left px-3 py-2.5 font-medium">Category</th>
                        {/* Blind count: only admins see System Stock + Variance. */}
                        {isAdmin && <th className="text-right px-3 py-2.5 font-medium">System Stock</th>}
                        <th className="text-right px-3 py-2.5 font-medium">Unit</th>
                        <th className="text-left px-3 py-2.5 font-medium w-[260px]">Physical Count *</th>
                        {isAdmin && <th className="text-right px-3 py-2.5 font-medium">Variance</th>}
                        <th className="text-left px-3 py-2.5 font-medium w-40">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F0E4D6]">
                      {rows.map(r => {
                        const pc = packConv(r);
                        const cf = caseFactor(r);
                        // Show a Cases box whenever there IS a case size (incl.
                        // piece-counted beer, pc=1 cf=24); hide Loose for those
                        // 'cb' items (pieces are whole). Loose stays the single
                        // box for plain items.
                        const showCasesBox = cf > 1;
                        const showWholeBox = pc > 1 || cf > 1;
                        const showLooseBox = pc > 1 || cf <= 1;
                        const sys = systemFor(r);
                        const phys = physicalFor(r);
                        const existing = countedBy.get(r.material_id);
                        const v = phys != null ? Math.round((phys - sys) * 1000) / 1000 : null;
                        const vv = v != null ? v * (Number(r.avg_cost) || 0) : null;
                        const vTone = v == null ? '' : v < 0 ? 'text-red-700' : v > 0 ? 'text-blue-700' : 'text-emerald-700';
                        return (
                          <tr key={r.material_id} className={`hover:bg-[#FFF8F0] align-top ${isAdmin && v != null && v < 0 ? 'bg-red-50/30' : isAdmin && v != null && v > 0 ? 'bg-blue-50/30' : ''}`}>
                            <td className="px-3 py-2">
                              <div className="text-[#2D1B0E] font-medium">{r.material_name}</div>
                              {r.sku && <div className="text-[10px] font-mono text-[#8B7355]">{r.sku}</div>}
                              {/* A SAVED ZERO IS NOT A SAVED COUNT OF SOMETHING.
                                  "✓ saved" alone read the same for both, which
                                  is the ambiguity this change exists to end. */}
                              {existing && (
                                <div className={`text-[10px] mt-0.5 ${Number(existing.physical_qty) === 0 ? 'text-amber-800' : 'text-emerald-700'}`}
                                     title={`Counted by ${existing.counted_by}`}>
                                  {Number(existing.physical_qty) === 0 ? '✓ saved · none left' : '✓ saved'}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-[#6B5744] text-xs">{r.category}</td>
                            {isAdmin && (
                              <td className="px-3 py-2 text-right whitespace-nowrap font-mono text-[#6B5744]">
                                {qtyText(sys, r)}
                                {/* House style: a recipe figure under a purchase lead is a
                                    HINT and reads "= N ml". Without the "=" it looks like a
                                    second, contradictory quantity. */}
                                {pc > 1 && <div className="text-[10px]">= {fq(sys)} {r.unit}</div>}
                              </td>
                            )}
                            <td className="px-3 py-2 text-right text-xs text-[#8B7355] whitespace-nowrap"
                                title={packConv(r) > 1 ? `recipe unit: ${r.unit} · 1 ${r.purchase_unit} = ${fq(packConv(r))} ${r.unit}` : undefined}>
                              {r.purchase_unit || r.unit}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1 flex-wrap">
                                {showCasesBox && (<>
                                  <input type="number" step="any" min={0} value={cases[r.material_id] ?? ''}
                                         onChange={e => setCases(p => ({ ...p, [r.material_id]: e.target.value }))}
                                         placeholder="0" aria-label={`${r.material_name} — cases`}
                                         title={`Full cases — 1 = ${fq(cf)} ${r.purchase_unit} = ${fq(cf * pc)} ${r.unit}`}
                                         className={box} />
                                  <span className="text-[10px] text-[#8B7355]">cs</span>
                                  <span className="text-[10px] text-[#8B7355]">+</span>
                                </>)}
                                {showWholeBox && (<>
                                  <input type="number" step="any" min={0} value={whole[r.material_id] ?? ''}
                                         onChange={e => setWhole(p => ({ ...p, [r.material_id]: e.target.value }))}
                                         placeholder="0" aria-label={`${r.material_name} — ${r.purchase_unit}`}
                                         title={`Full ${r.purchase_unit} — 1 = ${fq(r.pack_size)} ${r.unit}`}
                                         className={box} />
                                  <span className="text-[10px] text-[#8B7355]">{r.purchase_unit}</span>
                                  {showLooseBox && <span className="text-[10px] text-[#8B7355]">+</span>}
                                </>)}
                                {/* pc > 1 → this really is the LOOSE remainder, counted in the
                                    recipe unit. pc === 1 → it is the ONLY box and the count is a
                                    whole-unit count, so it reads in the PURCHASE unit. */}
                                {showLooseBox && (<>
                                  <input type="number" step="any" min={0} value={loose[r.material_id] ?? ''}
                                         onChange={e => setLoose(p => ({ ...p, [r.material_id]: e.target.value }))}
                                         placeholder="0" aria-label={`${r.material_name} — ${pc > 1 ? `loose ${r.unit}` : puOf(r)}`}
                                         title={pc > 1 ? `Loose / open ${r.unit}` : `Count in ${puOf(r)}`}
                                         className={box} />
                                  <span className="text-[10px] text-[#8B7355]">{pc > 1 ? r.unit : puOf(r)}</span>
                                </>)}
                                {phys != null && (pc > 1 || cf > 1) && (
                                  <span className="text-[10px] font-mono text-[#af4408] whitespace-nowrap">= {fq(phys)} {r.unit}</span>
                                )}
                              </div>
                              {/* Which of the two this row currently says, plus
                                  the one-click way to say the other. Three empty
                                  boxes and three boxes reading 0 are completely
                                  different statements and used to look alike. */}
                              <CountState raw={phys == null ? '' : String(phys)}
                                          className="max-w-[12rem]"
                                          onZero={() => markNone(r, showWholeBox)}
                                          onClear={() => clearCount(r)} />
                            </td>
                            {isAdmin && (
                              <td className={`px-3 py-2 text-right whitespace-nowrap font-mono ${vTone}`}>
                                {v == null ? <span className="text-[#8B7355]">—</span> : (
                                  <>
                                    {v > 0 ? '+' : ''}{qtyText(v, r)}
                                    <div className="text-[10px]">{vv != null && vv !== 0 ? (vv > 0 ? '+' : '−') + inr(Math.abs(vv)) : inr(0)}</div>
                                  </>
                                )}
                              </td>
                            )}
                            <td className="px-3 py-2">
                              <input type="text" value={notes[r.material_id] ?? ''}
                                     onChange={e => setNotes(p => ({ ...p, [r.material_id]: e.target.value }))}
                                     placeholder="Optional" aria-label={`${r.material_name} — note`}
                                     className="w-full px-2 py-1 bg-white border border-[#D4B896] rounded text-xs text-[#2D1B0E] placeholder-[#C4B09A] focus:outline-none focus:ring-1 focus:ring-[#af4408]" />
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
                  const showCasesBox = cf > 1;
                  const showWholeBox = pc > 1 || cf > 1;
                  const showLooseBox = pc > 1 || cf <= 1;
                  const sys = systemFor(r);
                  const phys = physicalFor(r);
                  const existing = countedBy.get(r.material_id);
                  const v = phys != null ? Math.round((phys - sys) * 1000) / 1000 : null;
                  const vv = v != null ? v * (Number(r.avg_cost) || 0) : null;
                  return (
                    <div key={r.material_id} className="bg-white border border-[#E8D5C4] rounded-xl p-3 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-[#2D1B0E] break-words">{r.material_name}</div>
                          <div className="text-[10px] text-[#8B7355]">
                            {r.sku && <span className="font-mono">{r.sku} · </span>}{r.category}
                          </div>
                          {isAdmin && (
                            <div className="text-[10px] text-[#8B7355] mt-0.5">
                              System: {qtyText(sys, r)}{pc > 1 ? ` (${fq(sys)} ${r.unit})` : ''}
                            </div>
                          )}
                        </div>
                        {existing && (
                          <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${Number(existing.physical_qty) === 0 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-700'}`}>
                            {Number(existing.physical_qty) === 0 ? '✓ saved · none' : '✓ saved'}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex items-center gap-1 flex-wrap">
                        {showCasesBox && (<>
                          <input type="number" step="any" min={0} inputMode="decimal" value={cases[r.material_id] ?? ''}
                                 onChange={e => setCases(p => ({ ...p, [r.material_id]: e.target.value }))}
                                 placeholder="0" aria-label={`${r.material_name} — cases`} className={boxM} />
                          <span className="text-[10px] text-[#8B7355]">cs</span>
                          <span className="text-[10px] text-[#8B7355]">+</span>
                        </>)}
                        {showWholeBox && (<>
                          <input type="number" step="any" min={0} inputMode="decimal" value={whole[r.material_id] ?? ''}
                                 onChange={e => setWhole(p => ({ ...p, [r.material_id]: e.target.value }))}
                                 placeholder="0" aria-label={`${r.material_name} — ${r.purchase_unit}`} className={boxM} />
                          <span className="text-[10px] text-[#8B7355]">{r.purchase_unit}</span>
                          {showLooseBox && <span className="text-[10px] text-[#8B7355]">+</span>}
                        </>)}
                        {showLooseBox && (<>
                          <input type="number" step="any" min={0} inputMode="decimal" value={loose[r.material_id] ?? ''}
                                 onChange={e => setLoose(p => ({ ...p, [r.material_id]: e.target.value }))}
                                 placeholder="0" aria-label={`${r.material_name} — ${pc > 1 ? `loose ${r.unit}` : puOf(r)}`} className={boxM} />
                          <span className="text-[10px] text-[#8B7355]">{pc > 1 ? r.unit : puOf(r)}</span>
                        </>)}
                        {v != null && (
                          <span className={`ml-auto font-mono ${v < 0 ? 'text-red-700' : v > 0 ? 'text-blue-700' : 'text-emerald-700'}`}>
                            {v > 0 ? '+' : ''}{qtyText(v, r)}{vv != null && vv !== 0 ? ` · ${vv > 0 ? '+' : '−'}${inr(Math.abs(vv))}` : ''}
                          </span>
                        )}
                      </div>
                      {/* Same tri-state as the desktop table — a phone counter
                          needs it more, not less: the boxes are smaller and a
                          stray 0 is easier to leave behind. */}
                      <CountState raw={phys == null ? '' : String(phys)}
                                  onZero={() => markNone(r, showWholeBox)}
                                  onClear={() => clearCount(r)} />
                      <input type="text" value={notes[r.material_id] ?? ''}
                             onChange={e => setNotes(p => ({ ...p, [r.material_id]: e.target.value }))}
                             placeholder="Note (optional)" aria-label={`${r.material_name} — note`}
                             className="mt-2 w-full px-2 py-1.5 bg-white border border-[#D4B896] rounded text-xs text-[#2D1B0E] placeholder-[#C4B09A] focus:outline-none focus:ring-1 focus:ring-[#af4408]" />
                    </div>
                  );
                })}
              </div>

              {/* Save bar */}
              <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[#6B5744]">
                {/* THE TALLY SPLITS THE TWO — a row counted at 0 and a row
                    nobody counted are different answers, and "N counted" alone
                    hid exactly that difference. */}
                <span>
                  <b className="text-[#2D1B0E]">{pending.length}</b> of {stock.length} material{stock.length === 1 ? '' : 's'} counted
                  {pendingZeros > 0 && <span className="text-amber-800"> ({pendingZeros} at 0 — counted, none left)</span>}
                </span>
                <span className="basis-full text-[11px] text-[#8B7355]">
                  <b>Blank = not counted</b> — nothing is written and the previously saved count stays as it is.
                  <b> A typed 0 = counted and found empty</b>, which is a real count and is compared against the system.
                </span>
                {isAdmin && pending.length > 0 && (
                  <span>Variance <b className={pendingVarianceValue < 0 ? 'text-red-700' : 'text-[#2D1B0E]'}>
                    {pendingVarianceValue < 0 ? '−' : ''}{inr(Math.abs(pendingVarianceValue))}</b></span>
                )}
                {/* NOT `onClick={save}` — React would hand the click event in as
                    `confirmZeros`, and an event object is truthy, which would
                    wave a mass-zero count past the guard on the first click. */}
                <button onClick={() => save()} disabled={busy || pending.length === 0}
                        className="ml-auto px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save counts{pending.length > 0 ? ` (${pending.length})` : ''}
                </button>
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
                      {/* Variance columns are admin-only (blind count). */}
                      {isAdmin && <th className="text-right px-3 py-2 font-medium">Short</th>}
                      {isAdmin && <th className="text-right px-3 py-2 font-medium">Excess</th>}
                      {isAdmin && <th className="text-right px-3 py-2 font-medium">Variance ₹</th>}
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F0E4D6]">
                    {days.map(d => (
                      <tr key={d.date} className={`hover:bg-[#FFF8F0] cursor-pointer ${histDate === d.date ? 'bg-[#FFF1E3]' : ''}`}
                          onClick={() => openHistDate(d.date)}>
                        <td className="px-3 py-2 font-medium text-[#2D1B0E] whitespace-nowrap">{d.date}</td>
                        <td className="px-3 py-2 text-right">{d.item_count}</td>
                        {isAdmin && <td className="px-3 py-2 text-right text-red-700">{d.shortage_count || '—'}</td>}
                        {isAdmin && <td className="px-3 py-2 text-right text-blue-700">{d.excess_count || '—'}</td>}
                        {isAdmin && (
                          <td className={`px-3 py-2 text-right font-mono ${(d.total_variance_value ?? 0) < 0 ? 'text-red-700' : 'text-[#2D1B0E]'}`}>
                            {(d.total_variance_value ?? 0) < 0 ? '−' : ''}{inr(Math.abs(d.total_variance_value ?? 0))}
                          </td>
                        )}
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
                  <div className="px-3 py-2 bg-[#FFF1E3] flex flex-wrap items-center gap-2 justify-between">
                    <span className="text-xs font-medium text-[#2D1B0E]">Counts on {histDate}</span>
                    {histCats.length > 1 && (
                      <label className="flex items-center gap-1.5 text-[11px] text-[#6B5744]">
                        <span className="sr-only">Filter history by category</span>
                        <select value={histCat} onChange={e => setHistCat(e.target.value)}
                                aria-label="Filter history by category"
                                className="px-2 py-1 border border-[#D4B896] rounded text-xs bg-white">
                          <option value="">All Categories</option>
                          {histCats.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[680px] text-xs">
                      <thead className="text-[#8B7355] border-b border-[#F0E4D6]">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium">Material</th>
                          <th className="text-left px-3 py-2 font-medium">Category</th>
                          {isAdmin && <th className="text-right px-3 py-2 font-medium">System</th>}
                          <th className="text-right px-3 py-2 font-medium">Physical</th>
                          {isAdmin && <th className="text-right px-3 py-2 font-medium">Variance</th>}
                          {isAdmin && <th className="text-right px-3 py-2 font-medium">Variance ₹</th>}
                          <th className="text-left px-3 py-2 font-medium">Notes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#F0E4D6]">
                        {histRows.map(c => (
                          <tr key={c.material_id} className={isAdmin && c.variance < 0 ? 'bg-red-50/40' : isAdmin && c.variance > 0 ? 'bg-blue-50/40' : ''}>
                            <td className="px-3 py-2 text-[#2D1B0E]">{c.material_name}</td>
                            <td className="px-3 py-2 text-[#6B5744]">{c.category || '—'}</td>
                            {isAdmin && (
                              <td className="px-3 py-2 text-right font-mono text-[#6B5744]">
                                {qtyText(c.system_qty, c)}
                              </td>
                            )}
                            <td className="px-3 py-2 text-right font-mono text-[#2D1B0E]">
                              {qtyText(c.physical_qty, c)}
                            </td>
                            {isAdmin && (
                              <td className={`px-3 py-2 text-right font-mono ${c.variance < 0 ? 'text-red-700' : c.variance > 0 ? 'text-blue-700' : 'text-emerald-700'}`}>
                                {c.variance > 0 ? '+' : ''}{qtyText(c.variance, c)}
                              </td>
                            )}
                            {isAdmin && (
                              <td className={`px-3 py-2 text-right font-mono ${c.variance_value < 0 ? 'text-red-700' : 'text-[#6B5744]'}`}>
                                {c.variance_value < 0 ? '−' : ''}{inr(Math.abs(c.variance_value))}
                              </td>
                            )}
                            <td className="px-3 py-2 text-[#8B7355]">{c.note || '—'}</td>
                          </tr>
                        ))}
                        {histRows.length === 0 && (
                          <tr><td colSpan={isAdmin ? 7 : 4} className="px-3 py-4 text-center text-[#8B7355]">No counts on this date.</td></tr>
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

      {/* THE ZERO-PATTERN REFUSAL — manual Save and CSV upload both land here. */}
      {zeroGuard && (
        <ZeroCountGuard guard={zeroGuard} what={zeroGuard.what} busy={busy}
                        onCancel={() => setZeroGuard(null)} onConfirm={zeroGuard.onConfirm} />
      )}
    </div>
  );
}

/* ── Reports section (Phase D — store-scoped reports + CSV) ────────────── */

type ColFmt = 'qty' | 'inr' | 'inr4' | undefined;
interface ReportCol { k: string; l: string; fmt?: ColFmt; }
interface ReportDef { key: string; label: string; dated?: boolean; days?: boolean; cols: ReportCol[]; }

const REPORT_DEFS: ReportDef[] = [
  // qty_cbl is BLANK for a material with no pack conversion (fmtBreakdown
  // returns null), so every report that leads with it must ALSO carry the plain
  // qty_purchase + purchase_unit pair — otherwise the beer catalog (pcs ↔ BTL,
  // pack_size 1) shows nothing but its recipe figure.
  { key: 'current_stock', label: 'Current Stock', cols: [
    { k: 'material', l: 'Material' }, { k: 'sku', l: 'SKU' }, { k: 'category', l: 'Category' },
    { k: 'qty_purchase', l: 'On hand', fmt: 'qty' }, { k: 'purchase_unit', l: 'Unit' },
    { k: 'qty_cbl', l: 'On hand (cs/btl)' },
    { k: 'qty', l: 'Recipe qty', fmt: 'qty' }, { k: 'unit', l: 'R.unit' },
    { k: 'avg_cost_purchase', l: '₹/purchase unit', fmt: 'inr' },
    { k: 'avg_cost', l: '₹/recipe unit', fmt: 'inr4' }, { k: 'value', l: 'Value', fmt: 'inr' },
  ] },
  // Ledger is an EXACT-BALANCE report: the recipe columns stay (a running
  // balance must not round through a 3-dp derivative) but they are LABELLED as
  // recipe, and the purchase pair leads.
  { key: 'ledger', label: 'Stock Ledger', dated: true, cols: [
    { k: 'date', l: 'Date' }, { k: 'txn_type', l: 'Type' }, { k: 'material', l: 'Material' },
    { k: 'qty_purchase', l: 'Qty', fmt: 'qty' }, { k: 'purchase_unit', l: 'Unit' },
    { k: 'qty_cbl', l: 'Cs/Btl' },
    { k: 'qty', l: 'Qty (recipe)', fmt: 'qty' }, { k: 'unit', l: 'Unit (recipe)' },
    { k: 'rate_purchase', l: '₹/purchase unit', fmt: 'inr' },
    { k: 'unit_cost', l: '₹/recipe unit', fmt: 'inr4' },
    { k: 'balance_purchase', l: 'Balance', fmt: 'qty' },
    { k: 'balance_cbl', l: 'Balance (cs/btl)' }, { k: 'running_balance', l: 'Balance (recipe)', fmt: 'qty' },
    // Notes carries the Goods Receipt stamp ('Goods Receipt GRN-… · PINV-…L…') on
    // the purchase rows of a TGBCL bill entered on Goods Receipt.
    { k: 'supplier', l: 'Supplier' }, { k: 'ref', l: 'Ref' }, { k: 'notes', l: 'Notes' }, { k: 'by', l: 'By' },
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
    { k: 'material', l: 'Material' }, { k: 'unit', l: 'Unit (recipe)' },
    { k: 'opening', l: 'Opening', fmt: 'qty' }, { k: 'in_qty', l: 'In', fmt: 'qty' },
    { k: 'out_qty', l: 'Out', fmt: 'qty' }, { k: 'adjust_qty', l: 'Adjust', fmt: 'qty' },
    { k: 'closing', l: 'Closing', fmt: 'qty' }, { k: 'closing_cbl', l: 'Closing (cs/btl)' },
  ] },
  { key: 'daily_closing', label: 'Daily Closing', dated: true, cols: [
    { k: 'date', l: 'Date' }, { k: 'items', l: 'Items' },
    { k: 'shortages', l: 'Short' }, { k: 'excesses', l: 'Excess' },
    { k: 'variance_value', l: 'Variance ₹', fmt: 'inr' },
    { k: 'abs_variance_value', l: 'Abs ₹', fmt: 'inr' },
  ] },
  { key: 'valuation', label: 'Valuation', cols: [
    // qty column dropped: Σ of ml+g+pcs across a category is meaningless in
    // any unit basis — Value is what a valuation report answers.
    { k: 'category', l: 'Category' }, { k: 'items', l: 'Items' },
    { k: 'value', l: 'Value', fmt: 'inr' },
  ] },
  { key: 'low_stock', label: 'Low Stock', cols: [
    { k: 'material', l: 'Material' }, { k: 'category', l: 'Category' },
    { k: 'qty_cbl', l: 'On hand (cs/btl)' },
    { k: 'qty_purchase', l: 'On hand', fmt: 'qty' }, { k: 'purchase_unit', l: 'Unit' },
    { k: 'reorder_purchase', l: 'Reorder at', fmt: 'qty' }, { k: 'deficit_purchase', l: 'To buy', fmt: 'qty' },
    { k: 'value', l: 'Value', fmt: 'inr' },
  ] },
  { key: 'dead_stock', label: 'Dead Stock', days: true, cols: [
    { k: 'material', l: 'Material' }, { k: 'category', l: 'Category' },
    { k: 'qty_cbl', l: 'On hand (cs/btl)' },
    { k: 'qty_purchase', l: 'On hand', fmt: 'qty' }, { k: 'purchase_unit', l: 'Unit' },
    { k: 'value', l: 'Value', fmt: 'inr' }, { k: 'last_outward', l: 'Last outward' },
  ] },
  { key: 'supplier', label: 'Supplier-wise', dated: true, cols: [
    // qty dropped for the same cross-material reason as Valuation.
    { k: 'supplier', l: 'Supplier' }, { k: 'purchases', l: 'Purchases' },
    { k: 'total_value', l: 'Value', fmt: 'inr' },
  ] },
  { key: 'category', label: 'Category-wise', cols: [
    { k: 'category', l: 'Category' }, { k: 'material', l: 'Material' }, { k: 'sku', l: 'SKU' },
    { k: 'qty_purchase', l: 'On hand', fmt: 'qty' }, { k: 'purchase_unit', l: 'Unit' },
    { k: 'avg_cost_purchase', l: '₹/purchase unit', fmt: 'inr' }, { k: 'value', l: 'Value', fmt: 'inr' },
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
          {Object.entries(totals)
            // in_qty/out_qty are Σ of recipe quantities ACROSS materials (ml+g+pcs
            // added together) — no unit exists for them, so they are dropped
            // rather than shown as bare misleading numbers.
            .filter(([k]) => k !== 'in_qty' && k !== 'out_qty')
            .map(([k, v]) => (
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
