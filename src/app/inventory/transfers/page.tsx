'use client';

/**
 * Store → Floor Transfers (requisition / issue / receive) — Multi-floor bar
 * operations, Phase 1, slice [transfers-page].
 *
 * A floor bar raises a REQUEST for stock from a source store (usually the
 * central LIQUOR STORE); the source store ISSUES it (debits its ledger); the
 * floor RECEIVES/acknowledges it (credits the floor's ledger). In-transit
 * (issued − received) and per-line DISCREPANCY (loss in transit) are surfaced
 * the moment a receive under-counts. A still-'requested' transfer can be
 * cancelled (no stock has moved).
 *
 * All stock movement lives in the append-only store_stock_ledger via the
 * transfer engine (src/lib/store-engine.ts) — this page is pure UI over the
 * transfer APIs:
 *   GET   /api/stores/transfers?status=&storeId=   → { transfers: Summary[] }
 *   POST  /api/stores/transfers                    → { transfer }   (create)
 *   GET   /api/stores/transfers/[id]               → { transfer }   (detail)
 *   PATCH /api/stores/transfers/[id]  { action: 'issue'|'receive'|'cancel', … }
 *   GET   /api/stores/[id]/items                   → { items: StoreItemMeta[] }
 *         (source-store catalog for the request builder; falls back to the
 *          store's /stock `materials` when the items route is unavailable)
 *
 * Access (resolved per store via /api/stores/[id]/my-access): raising a request
 * needs dest-floor view; ISSUE needs source procure/adjust; RECEIVE needs dest
 * close/adjust; CANCEL is allowed to either side while still requested. The
 * APIs enforce this server-side — the gating here is only UX.
 *
 * Quantities are RECIPE units on the ledger; wherever a material has a pack
 * conversion (pack_size > 1) the Cases + Bottles + loose (CBL) convention from
 * src/lib/pack-units.ts is used for both entry and display. Mobile-first 375px.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRightLeft, ArrowLeft, Plus, Search, X, Loader2, AlertCircle, AlertTriangle,
  CheckCircle2, Wine, Warehouse, Download, Send, PackageCheck, Ban, Trash2,
  ChevronRight, PackageOpen, ShoppingBasket,
} from 'lucide-react';
import Papa from 'papaparse';
import { api } from '@/lib/api';
import TabScroller from '@/components/TabScroller';
import MaterialTypeahead, { MaterialLite } from '@/components/MaterialTypeahead';
import {
  entryMode, tripleToRecipe, breakdownQty, fmtBreakdown, caseFactor, packFactor, PackMeta,
} from '@/lib/pack-units';

/* ── Types (mirror src/lib/store-engine.ts exports) ──────────────────────── */

interface StoreLite { id: string; name: string; code: string; is_active: number; }
interface Access { can_view: boolean; can_procure: boolean; can_adjust: boolean; can_close_stock: boolean; }
type TransferStatus = 'requested' | 'issued' | 'received' | 'cancelled';

interface ItemMeta {
  material_id: string; name: string; category: string; unit: string;
  pack_size: number; case_size: number; average_price: number;
}
interface TransferItem {
  id: string; transfer_id: string; material_id: string; material_name: string;
  category: string; unit: string; pack_size: number; case_size: number;
  qty_requested: number; qty_issued: number; qty_received: number;
  in_transit: number; discrepancy: number; note: string;
}
interface TransferBase {
  id: string;
  from_store_id: string; from_store_name: string;
  /** True when the SOURCE is the central grocery (raw_materials.current_stock),
   *  not a store_location — from_store_id is empty in that case. */
  from_central: boolean;
  to_store_id: string; to_store_name: string;
  status: TransferStatus; note: string;
  requested_by: string; requested_at: string | null;
  issued_by: string; issued_at: string | null;
  received_by: string; received_at: string | null;
  created_at: string; updated_at: string;
  total_requested: number; total_issued: number; total_received: number; total_in_transit: number;
}
interface TransferSummary extends TransferBase { item_count: number; }
interface TransferFull extends TransferBase { items: TransferItem[]; }

/* ── Small helpers ───────────────────────────────────────────────────────── */

const fq = (v: number, dp = 2) => Number((Number(v) || 0).toFixed(dp)).toLocaleString('en-IN');
const numOr0 = (s?: string) => {
  const n = Number(s);
  return s != null && s !== '' && Number.isFinite(n) ? n : 0;
};
const PAGE_SIZE = 20;

/** Sentinel `from` value selecting the CENTRAL GROCERY as the transfer source
 *  (raw_materials.current_stock) rather than a store_location. */
const CENTRAL_SRC = '__central__';

/** Human label for a transfer's source — 'Grocery' for a central-grocery
 *  source, else the source store's name. */
const sourceLabel = (t: { from_central: boolean; from_store_name: string }) =>
  t.from_central ? 'Grocery' : t.from_store_name;

/** A quantity rendered in the bar convention when the material packs, else plain. */
function qtyText(qty: number, m: PackMeta): string {
  const dual = fmtBreakdown(qty, m);
  return dual ? dual : `${fq(qty)} ${String(m.unit || '').trim() || 'units'}`;
}

const STATUS_BADGE: Record<TransferStatus, string> = {
  requested: 'bg-amber-50 border-amber-200 text-amber-800',
  issued:    'bg-blue-50 border-blue-200 text-blue-800',
  received:  'bg-emerald-50 border-emerald-200 text-emerald-800',
  cancelled: 'bg-gray-100 border-gray-300 text-gray-500',
};
const StatusPill = ({ s }: { s: TransferStatus }) => (
  <span className={`inline-block border rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${STATUS_BADGE[s]}`}>{s}</span>
);

const CBL_EMPTY = { cases: '', bottles: '', loose: '' };
type CBL = { cases: string; bottles: string; loose: string };
const cblRecipe = (m: PackMeta | null, v: CBL) =>
  m ? tripleToRecipe(numOr0(v.cases), numOr0(v.bottles), numOr0(v.loose), m) : numOr0(v.bottles);
/** Seed a CBL triple from a recipe qty (largest-unit breakdown) for edit forms. */
function cblFrom(m: PackMeta, qty: number): CBL {
  const b = breakdownQty(qty, m);
  if (!b) return { cases: '', bottles: qty ? String(qty) : '', loose: '' };
  return {
    cases: b.cases ? String(b.cases) : '',
    bottles: b.bottles ? String(b.bottles) : '',
    loose: b.loose ? String(b.loose) : '',
  };
}

const L = ({ children }: { children: React.ReactNode }) => (
  <label className="block text-[10px] uppercase tracking-wide text-[#8B7355] mb-0.5">{children}</label>
);
const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]';

/* ── Cases + Bottles + loose entry (degrades to a plain input) ───────────── */

function CBLEntry({ mat, value, onChange, compact }: {
  mat: PackMeta | null; value: CBL; onChange: (v: CBL) => void; compact?: boolean;
}) {
  const mode = mat ? entryMode(mat) : 'plain';
  const bu = String(mat?.purchase_unit || mat?.unit || 'units');
  const ru = String(mat?.unit || 'units');
  const recipe = cblRecipe(mat, value);
  const touched = value.cases !== '' || value.bottles !== '' || value.loose !== '';
  const box = `w-full px-2 ${compact ? 'py-1 text-xs' : 'py-1.5 text-sm'} border border-[#E8D5C4] rounded bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]`;
  if (mode === 'plain') {
    return (
      <input type="number" min={0} step="any" inputMode="decimal" value={value.bottles}
             onChange={e => onChange({ ...value, bottles: e.target.value })}
             placeholder={`Qty (${ru})`} className={box} aria-label={`Quantity in ${ru}`} />
    );
  }
  return (
    <div>
      <div className={`grid gap-1.5 ${mode === 'cbl' ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {mode === 'cbl' && (
          <input type="number" min={0} step="any" inputMode="decimal" value={value.cases}
                 onChange={e => onChange({ ...value, cases: e.target.value })}
                 placeholder="cs" className={box} aria-label="Cases"
                 title={mat ? `1 case = ${fq(caseFactor(mat))} ${bu}` : undefined} />
        )}
        <input type="number" min={0} step="any" inputMode="decimal" value={value.bottles}
               onChange={e => onChange({ ...value, bottles: e.target.value })}
               placeholder={bu.toLowerCase()} className={box} aria-label={bu}
               title={mat ? `1 ${bu} = ${fq(packFactor(mat))} ${ru}` : undefined} />
        <input type="number" min={0} step="any" inputMode="decimal" value={value.loose}
               onChange={e => onChange({ ...value, loose: e.target.value })}
               placeholder={`loose ${ru}`} className={box} aria-label={`Loose ${ru}`} />
      </div>
      {mat && touched && (
        <div className="mt-1 text-[10px] text-[#6B5744]">= <b>{qtyText(recipe, mat)}</b></div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Page
   ══════════════════════════════════════════════════════════════════════════ */

export default function TransfersPage() {
  const [stores, setStores] = useState<StoreLite[]>([]);
  const [accessByStore, setAccessByStore] = useState<Record<string, Access>>({});
  // Elevated = admin / manager / store-manager / HOD — the set allowed to raise
  // and issue a CENTRAL GROCERY source transfer (grocery has no per-store grant).
  const [elevated, setElevated] = useState(false);
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  const [transfers, setTransfers] = useState<TransferSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Filters
  const [statusTab, setStatusTab] = useState<'requested' | 'issued' | 'received' | 'all'>('all');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  // Modals
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const viewable = useMemo(
    () => stores.filter(s => accessByStore[s.id]?.can_view),
    [stores, accessByStore],
  );

  /* Boot: active stores + my access per store */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [r, meR] = await Promise.all([
          fetch('/api/stores'),
          fetch('/api/auth/me'),
        ]);
        const j = await r.json();
        if (j.error) throw new Error(j.error);
        const meJ = await meR.json().catch(() => ({}));
        const u = meJ.user || null;
        const isElevated = !!u && (u.role === 'admin' || u.role === 'manager' || u.is_store_manager || u.is_head_chef);
        const active: StoreLite[] = (j.stores || []).filter((s: any) => s.is_active);
        const accEntries = await Promise.all(active.map(async s => {
          const ar = await fetch(`/api/stores/${s.id}/my-access`);
          const aj = await ar.json().catch(() => ({}));
          return [s.id, (aj.access || { can_view: false, can_procure: false, can_adjust: false, can_close_stock: false })] as const;
        }));
        if (cancelled) return;
        setStores(active);
        setElevated(isElevated);
        setAccessByStore(Object.fromEntries(accEntries));
      } catch (e: any) {
        if (!cancelled) setBootError(e.message);
      } finally {
        if (!cancelled) setBootLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* Load transfer list (status filtered server-side; from/to/search client-side) */
  const loadList = useCallback(async () => {
    setListLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      if (statusTab !== 'all') p.set('status', statusTab);
      const r = await fetch(`/api/stores/transfers?${p.toString()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setTransfers(j.transfers || []);
    } catch (e: any) { setError(e.message); }
    finally { setListLoading(false); }
  }, [statusTab]);

  useEffect(() => { if (!bootLoading) loadList(); }, [bootLoading, loadList]);
  useEffect(() => { setPage(1); }, [statusTab, fromFilter, toFilter, q]);

  const afterWrite = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 5000);
    loadList();
  };

  /* Filtered + paged */
  const filtered = useMemo(() => {
    const raw = q.trim().toLowerCase();
    return transfers.filter(t => {
      if (fromFilter) {
        if (fromFilter === CENTRAL_SRC) { if (!t.from_central) return false; }
        else if (t.from_central || t.from_store_id !== fromFilter) return false;
      }
      if (toFilter && t.to_store_id !== toFilter) return false;
      if (!raw) return true;
      return `${sourceLabel(t)} ${t.to_store_name} ${t.note} ${t.requested_by} ${t.id}`.toLowerCase().includes(raw);
    });
  }, [transfers, fromFilter, toFilter, q]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, (page - 1) * PAGE_SIZE + PAGE_SIZE),
    [filtered, page],
  );

  const totals = useMemo(() => ({
    count: filtered.length,
    inTransit: filtered.filter(t => t.status === 'issued').length,
    discrepancies: filtered.filter(t => t.status === 'received' && t.total_in_transit > 0).length,
  }), [filtered]);

  const canCreate = viewable.length > 0;

  const exportCsv = () => {
    const rows = filtered.map(t => ({
      id: t.id,
      from: sourceLabel(t),
      to: t.to_store_name,
      status: t.status,
      items: t.item_count,
      requested: t.total_requested,
      issued: t.total_issued,
      received: t.total_received,
      in_transit_or_discrepancy: t.total_in_transit,
      requested_by: t.requested_by,
      requested_at: t.requested_at || '',
      issued_by: t.issued_by,
      issued_at: t.issued_at || '',
      received_by: t.received_by,
      received_at: t.received_at || '',
      note: t.note,
    }));
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `store-transfers-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
          No active store locations. An admin can add the Liquor Store and floor bars on
          Settings → Store Locations before transfers can be raised.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[220px]">
          <Link href="/inventory/liquor-store"
                className="inline-flex items-center gap-1 text-xs text-[#8B7355] hover:text-[#af4408] mb-1">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to stores
          </Link>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <ArrowRightLeft className="w-6 h-6 text-[#af4408]" /> Store Transfers
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Floor bars request stock from a store; the store issues it, the floor acknowledges receipt.
            In-transit and discrepancy (loss in transit) are tracked per line.
          </p>
        </div>
        <button onClick={exportCsv} disabled={filtered.length === 0}
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm font-medium flex items-center gap-1.5 disabled:opacity-50">
          <Download className="w-4 h-4" /> Export
        </button>
        {canCreate && (
          <button onClick={() => setShowCreate(true)}
                  className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> New Request
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

      {/* Status tabs */}
      <TabScroller className="gap-2">
        {(['requested', 'issued', 'received', 'all'] as const).map(s => (
          <button key={s} onClick={() => setStatusTab(s)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border capitalize ${
                    statusTab === s ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
            {s === 'all' ? 'All' : s}
          </button>
        ))}
      </TabScroller>

      {/* Filters: from + to + search */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-[#6B5744]">
          <Warehouse className="w-4 h-4 text-[#af4408]" /> From
          <select value={fromFilter} onChange={e => setFromFilter(e.target.value)}
                  className="px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]">
            <option value="">Any source</option>
            <option value={CENTRAL_SRC}>Grocery (central)</option>
            {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <span className="text-[#8B7355]">→</span>
        <label className="flex items-center gap-1.5 text-xs text-[#6B5744]">
          To
          <select value={toFilter} onChange={e => setToFilter(e.target.value)}
                  className="px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]">
            <option value="">Any destination</option>
            {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search store, note, by…"
                 className="w-full pl-8 pr-8 py-1.5 border border-[#E8D5C4] rounded-lg text-sm bg-white" />
          {q && (
            <button onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8B7355] hover:text-[#2D1B0E]">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        {(fromFilter || toFilter || q) && (
          <button onClick={() => { setFromFilter(''); setToFilter(''); setQ(''); }}
                  className="text-xs text-[#af4408] hover:underline">clear</button>
        )}
      </div>

      {/* Summary bar */}
      <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl px-3 sm:px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
        <span className="text-[#6B5744]"><b className="text-[#2D1B0E]">{totals.count}</b> transfer{totals.count === 1 ? '' : 's'}</span>
        {totals.inTransit > 0 && (
          <span className="text-blue-800 flex items-center gap-1 text-xs font-medium">
            <PackageOpen className="w-3.5 h-3.5" /> {totals.inTransit} in transit
          </span>
        )}
        {totals.discrepancies > 0 && (
          <span className="text-red-700 flex items-center gap-1 text-xs font-medium">
            <AlertTriangle className="w-3.5 h-3.5" /> {totals.discrepancies} with discrepancy
          </span>
        )}
      </div>

      {/* List */}
      {listLoading ? (
        <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading transfers…</div>
      ) : filtered.length === 0 ? (
        <div className="p-8 text-center text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">
          {transfers.length === 0
            ? `No transfers yet. ${canCreate ? 'Raise the first one with “New Request”.' : ''}`
            : 'Nothing matches the current filters.'}
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="bg-[#FFF1E3] text-[#8B7355] text-xs">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Route</th>
                    <th className="text-left px-3 py-2 font-medium">Status</th>
                    <th className="text-right px-3 py-2 font-medium">Items</th>
                    <th className="text-right px-3 py-2 font-medium">Req / Iss / Rec</th>
                    <th className="text-right px-3 py-2 font-medium">In transit</th>
                    <th className="text-left px-3 py-2 font-medium">Raised</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F0E4D6]">
                  {paged.map(t => {
                    const disc = t.status === 'received' && t.total_in_transit > 0;
                    return (
                      <tr key={t.id} className="hover:bg-[#FFF8F0] cursor-pointer" onClick={() => setDetailId(t.id)}>
                        <td className="px-3 py-2">
                          <div className="text-[#2D1B0E] font-medium flex items-center gap-1.5">
                            {t.from_central
                              ? <ShoppingBasket className="w-3.5 h-3.5 text-[#af4408]" />
                              : <Wine className="w-3.5 h-3.5 text-[#af4408]" />}
                            {sourceLabel(t)}
                            <ChevronRight className="w-3.5 h-3.5 text-[#8B7355]" /> {t.to_store_name}
                          </div>
                          {t.note && <div className="text-[10px] text-[#8B7355] mt-0.5 truncate max-w-[280px]">{t.note}</div>}
                        </td>
                        <td className="px-3 py-2"><StatusPill s={t.status} /></td>
                        <td className="px-3 py-2 text-right text-[#6B5744]">{t.item_count}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap text-[#6B5744]">
                          {fq(t.total_requested)} / {fq(t.total_issued)} / {fq(t.total_received)}
                        </td>
                        <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${disc ? 'text-red-700' : t.total_in_transit > 0 ? 'text-blue-800' : 'text-[#8B7355]'}`}>
                          {t.total_in_transit > 0
                            ? <span className="inline-flex items-center gap-1">{disc && <AlertTriangle className="w-3.5 h-3.5" />}{fq(t.total_in_transit)}</span>
                            : '—'}
                        </td>
                        <td className="px-3 py-2 text-[#8B7355] whitespace-nowrap text-xs">
                          {(t.requested_by || '').split('@')[0] || '—'}
                          <div className="text-[10px]">{String(t.requested_at || t.created_at || '').slice(0, 16)}</div>
                        </td>
                        <td className="px-3 py-2 text-right"><ChevronRight className="w-4 h-4 text-[#8B7355] inline" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {paged.map(t => {
              const disc = t.status === 'received' && t.total_in_transit > 0;
              return (
                <button key={t.id} onClick={() => setDetailId(t.id)}
                        className="w-full text-left bg-white border border-[#E8D5C4] rounded-xl p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[#2D1B0E] flex items-center gap-1 flex-wrap">
                        {t.from_central
                          ? <ShoppingBasket className="w-3.5 h-3.5 text-[#af4408]" />
                          : <Wine className="w-3.5 h-3.5 text-[#af4408]" />}
                        {sourceLabel(t)}
                        <ChevronRight className="w-3.5 h-3.5 text-[#8B7355]" /> {t.to_store_name}
                      </div>
                      {t.note && <div className="text-[10px] text-[#8B7355] mt-0.5 break-words">{t.note}</div>}
                    </div>
                    <StatusPill s={t.status} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#6B5744]">
                    <span>{t.item_count} item{t.item_count === 1 ? '' : 's'}</span>
                    <span>req {fq(t.total_requested)} · iss {fq(t.total_issued)} · rec {fq(t.total_received)}</span>
                    {t.total_in_transit > 0 && (
                      <span className={`ml-auto font-medium flex items-center gap-1 ${disc ? 'text-red-700' : 'text-blue-800'}`}>
                        {disc && <AlertTriangle className="w-3.5 h-3.5" />}
                        {disc ? 'discrepancy' : 'in transit'} {fq(t.total_in_transit)}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Pagination */}
          {pageCount > 1 && (
            <div className="flex items-center justify-center gap-2 pt-1">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
                      className="px-3 py-1.5 border border-[#E8D5C4] rounded-lg text-sm text-[#6B5744] disabled:opacity-40">Prev</button>
              <span className="text-xs text-[#8B7355]">Page {page} of {pageCount}</span>
              <button onClick={() => setPage(p => Math.min(pageCount, p + 1))} disabled={page >= pageCount}
                      className="px-3 py-1.5 border border-[#E8D5C4] rounded-lg text-sm text-[#6B5744] disabled:opacity-40">Next</button>
            </div>
          )}
        </>
      )}

      {showCreate && (
        <CreateModal
          stores={stores} accessByStore={accessByStore} elevated={elevated}
          onClose={() => setShowCreate(false)}
          onSaved={msg => { setShowCreate(false); afterWrite(msg); }}
        />
      )}
      {detailId && (
        <DetailModal
          transferId={detailId} accessByStore={accessByStore} elevated={elevated}
          onClose={() => setDetailId(null)}
          onChanged={msg => { setDetailId(null); afterWrite(msg); }}
        />
      )}
    </div>
  );
}

/* ── Shared modal shell ──────────────────────────────────────────────────── */

function ModalShell({ title, icon, onClose, children, footer, wide }: {
  title: string; icon: React.ReactNode; onClose: () => void;
  children: React.ReactNode; footer?: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto" onClick={onClose}>
      <div className={`bg-white rounded-xl border border-[#E8D5C4] w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} shadow-xl flex flex-col overflow-hidden`}
           style={{ maxHeight: 'calc(100vh - 1.5rem)' }} onClick={e => e.stopPropagation()}>
        <div className="px-4 sm:px-5 py-3 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">{icon} {title}</div>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-3">{children}</div>
        {footer && <div className="px-4 sm:px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0 bg-white">{footer}</div>}
      </div>
    </div>
  );
}

/* ── Create request modal ────────────────────────────────────────────────── */

interface Line { key: string; material_id: string; cbl: CBL; note: string; }
let lineSeq = 0;
const newLine = (): Line => ({ key: `l${++lineSeq}`, material_id: '', cbl: { ...CBL_EMPTY }, note: '' });

function CreateModal({ stores, accessByStore, elevated, onClose, onSaved }: {
  stores: StoreLite[]; accessByStore: Record<string, Access>; elevated: boolean;
  onClose: () => void; onSaved: (msg: string) => void;
}) {
  const viewable = stores.filter(s => accessByStore[s.id]?.can_view);
  const [from, setFrom] = useState('');
  const fromCentral = from === CENTRAL_SRC;
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [items, setItems] = useState<ItemMeta[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Source catalog (what the source can issue).
  //  • CENTRAL GROCERY: the raw_materials universe held in the central grocery
  //    (beverages + groceries). scope=all bypasses the dept whitelist and
  //    exclude_store_mapped=1 drops liquor (which lives in the store ledger, not
  //    grocery) so the picker stays grocery-relevant.
  //  • STORE source: prefer the store's items route; fall back to /stock.
  useEffect(() => {
    if (!from) { setItems([]); return; }
    let cancelled = false;
    setItemsLoading(true);
    (async () => {
      try {
        let list: ItemMeta[] = [];
        if (fromCentral) {
          const r = await fetch('/api/inventory?scope=all&exclude_store_mapped=1');
          const j = await r.json().catch(() => ({}));
          list = (j.materials || []).map((m: any) => ({
            material_id: m.id, name: m.name, category: m.category, unit: m.unit,
            pack_size: Number(m.pack_size) || 1, case_size: Number(m.case_size) || 1,
            average_price: Number(m.average_price) || 0,
          }));
        } else {
          const r = await fetch(`/api/stores/${from}/items`);
          if (r.ok) {
            const j = await r.json();
            list = (j.items || []) as ItemMeta[];
          } else {
            const sr = await fetch(`/api/stores/${from}/stock`);
            const sj = await sr.json().catch(() => ({}));
            list = (sj.materials || []).map((m: any) => ({
              material_id: m.id, name: m.name, category: m.category, unit: m.unit,
              pack_size: Number(m.pack_size) || 1, case_size: Number(m.case_size) || 1,
              average_price: Number(m.average_price) || 0,
            }));
          }
        }
        if (!cancelled) setItems(list);
      } catch { if (!cancelled) setItems([]); }
      finally { if (!cancelled) setItemsLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [from, fromCentral]);

  const matLite: MaterialLite[] = useMemo(
    () => items.map(m => ({ id: m.material_id, name: m.name, category: m.category, unit: m.unit })),
    [items],
  );
  const metaById = useMemo(() => new Map(items.map(m => [m.material_id, m])), [items]);
  const chosenIds = lines.map(l => l.material_id).filter(Boolean);

  const setLine = (key: string, patch: Partial<Line>) =>
    setLines(ls => ls.map(l => l.key === key ? { ...l, ...patch } : l));

  const validLines = lines.filter(l => {
    const m = metaById.get(l.material_id) || null;
    return l.material_id && cblRecipe(m, l.cbl) > 0;
  });

  const save = async () => {
    setErr(null);
    if (!from) { setErr('Pick a source'); return; }
    if (!to) { setErr('Pick a destination floor'); return; }
    if (!fromCentral && from === to) { setErr('Source and destination must differ'); return; }
    if (validLines.length === 0) { setErr('Add at least one material with a quantity'); return; }
    setBusy(true);
    try {
      const payload = {
        from_store_id: fromCentral ? '' : from,
        to_store_id: to,
        from_central: fromCentral,
        note: note.trim(),
        items: validLines.map(l => {
          const m = metaById.get(l.material_id) || null;
          return { material_id: l.material_id, qty_requested: cblRecipe(m, l.cbl), note: l.note.trim() };
        }),
      };
      const r = await api('/api/stores/transfers', { method: 'POST', body: payload });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const toName = stores.find(s => s.id === to)?.name || 'floor';
      onSaved(`Request raised to ${toName} — ${validLines.length} item${validLines.length === 1 ? '' : 's'}`);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <ModalShell title="New Transfer Request" icon={<ArrowRightLeft className="w-5 h-5 text-[#af4408]" />} onClose={onClose} wide
      footer={<>
        <button onClick={onClose} disabled={busy}
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">Cancel</button>
        <button onClick={save} disabled={busy || validLines.length === 0}
                className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Raise request
        </button>
      </>}>
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-sm text-red-700">{err}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <L>From (source)</L>
          <select value={from} onChange={e => { setFrom(e.target.value); setLines([newLine()]); }} className={inputCls}>
            <option value="">Select source…</option>
            {elevated && <option value={CENTRAL_SRC}>Grocery (central)</option>}
            {viewable.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <L>To (destination floor)</L>
          <select value={to} onChange={e => setTo(e.target.value)} className={inputCls}>
            <option value="">Select floor…</option>
            {viewable.filter(s => s.id !== from).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <L>Items requested</L>
          {from && <span className="text-[10px] text-[#8B7355]">{itemsLoading ? 'loading catalog…' : `${items.length} available`}</span>}
        </div>
        {!from ? (
          <div className="text-xs text-[#8B7355] bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">Pick a source store to choose materials.</div>
        ) : (
          <div className="space-y-2">
            {lines.map(l => {
              const m = metaById.get(l.material_id) || null;
              return (
                <div key={l.key} className="border border-[#E8D5C4] rounded-lg p-2.5 bg-[#FFF8F0] space-y-2">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <MaterialTypeahead
                        materials={matLite} value={l.material_id}
                        excludeIds={chosenIds.filter(id => id !== l.material_id)}
                        onPick={id => setLine(l.key, { material_id: id, cbl: { ...CBL_EMPTY } })}
                        showStock={false} compact={false}
                        placeholder="Type a material name or category…" />
                    </div>
                    {lines.length > 1 && (
                      <button onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}
                              className="text-[#8B7355] hover:text-red-700 mt-1.5" aria-label="Remove line">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  {l.material_id && (
                    <>
                      <CBLEntry mat={m} value={l.cbl} onChange={cbl => setLine(l.key, { cbl })} compact />
                      <input value={l.note} onChange={e => setLine(l.key, { note: e.target.value })}
                             placeholder="Line note (optional)"
                             className="w-full px-2 py-1 border border-[#E8D5C4] rounded text-xs bg-white" />
                    </>
                  )}
                </div>
              );
            })}
            <button onClick={() => setLines(ls => [...ls, newLine()])}
                    className="text-xs text-[#af4408] hover:underline flex items-center gap-1">
              <Plus className="w-3.5 h-3.5" /> Add another material
            </button>
          </div>
        )}
      </div>

      <div>
        <L>Note (optional)</L>
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Friday restock"
               className={inputCls} />
      </div>
    </ModalShell>
  );
}

/* ── Detail modal (view + issue / receive / cancel) ──────────────────────── */

type Mode = 'view' | 'issue' | 'receive';

function DetailModal({ transferId, accessByStore, elevated, onClose, onChanged }: {
  transferId: string; accessByStore: Record<string, Access>; elevated: boolean;
  onClose: () => void; onChanged: (msg: string) => void;
}) {
  const [t, setT] = useState<TransferFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [qty, setQty] = useState<Record<string, CBL>>({});   // material_id → CBL
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/stores/transfers/${transferId}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setT(j.transfer as TransferFull);
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }, [transferId]);
  useEffect(() => { load(); }, [load]);

  const fromAcc = t ? accessByStore[t.from_store_id] : undefined;
  const toAcc = t ? accessByStore[t.to_store_id] : undefined;
  // Grocery source (from_central) has no per-store grant — issuing/cancelling it
  // is gated on elevation (admin/manager/store-manager/HOD), mirroring the API.
  const canIssue = t?.status === 'requested' &&
    (t.from_central ? elevated : !!(fromAcc?.can_procure || fromAcc?.can_adjust));
  const canReceive = t?.status === 'issued' && !!(toAcc?.can_close_stock || toAcc?.can_adjust);
  const canCancel = t?.status === 'requested' &&
    (t.from_central
      ? (elevated || !!toAcc?.can_view)
      : !!(fromAcc?.can_procure || fromAcc?.can_adjust || toAcc?.can_view));

  // Seed the qty form when entering issue/receive.
  const startMode = (next: Mode) => {
    if (!t) return;
    const seed: Record<string, CBL> = {};
    for (const it of t.items) {
      const def = next === 'issue' ? it.qty_requested : it.qty_issued;
      seed[it.material_id] = cblFrom(it, def);
    }
    setQty(seed);
    setMode(next);
  };

  const submit = async () => {
    if (!t) return;
    setErr(null); setBusy(true);
    try {
      const action = mode === 'issue' ? 'issue' : 'receive';
      const items = t.items.map(it => {
        const recipe = cblRecipe(it, qty[it.material_id] || CBL_EMPTY);
        return mode === 'issue'
          ? { material_id: it.material_id, qty_issued: recipe }
          : { material_id: it.material_id, qty_received: recipe };
      });
      const r = await api(`/api/stores/transfers/${t.id}`, { method: 'PATCH', body: { action, items } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onChanged(mode === 'issue' ? 'Transfer issued — stock debited from source' : 'Receipt acknowledged — stock credited to floor');
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  const cancel = async () => {
    if (!t) return;
    setErr(null); setBusy(true);
    try {
      const r = await api(`/api/stores/transfers/${t.id}`, { method: 'PATCH', body: { action: 'cancel' } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onChanged('Request cancelled');
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  const title = t ? `${sourceLabel(t)} → ${t.to_store_name}` : 'Transfer';

  return (
    <ModalShell title={title} icon={<ArrowRightLeft className="w-5 h-5 text-[#af4408]" />} onClose={onClose} wide
      footer={t && mode === 'view' ? (
        <div className="flex items-center gap-2 w-full">
          {canCancel && (
            <button onClick={cancel} disabled={busy}
                    className="px-3 py-2 bg-white border border-red-200 text-red-700 hover:bg-red-50 rounded-lg text-sm font-medium flex items-center gap-1.5 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />} Cancel
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {canIssue && (
              <button onClick={() => startMode('issue')} disabled={busy}
                      className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
                <Send className="w-4 h-4" /> Issue
              </button>
            )}
            {canReceive && (
              <button onClick={() => startMode('receive')} disabled={busy}
                      className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
                <PackageCheck className="w-4 h-4" /> Receive
              </button>
            )}
          </div>
        </div>
      ) : t && mode !== 'view' ? (
        <>
          <button onClick={() => setMode('view')} disabled={busy}
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">Back</button>
          <button onClick={submit} disabled={busy}
                  className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : mode === 'issue' ? <Send className="w-4 h-4" /> : <PackageCheck className="w-4 h-4" />}
            {mode === 'issue' ? 'Confirm issue' : 'Confirm receipt'}
          </button>
        </>
      ) : undefined}>

      {loading ? (
        <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
      ) : !t ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{err || 'Transfer not found'}</div>
      ) : (
        <>
          {err && <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-sm text-red-700">{err}</div>}

          {/* Header meta */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#6B5744]">
            <StatusPill s={t.status} />
            {t.requested_at && <span>Requested {String(t.requested_at).slice(0, 16)}{t.requested_by ? ` · ${t.requested_by.split('@')[0]}` : ''}</span>}
            {t.issued_at && <span>Issued {String(t.issued_at).slice(0, 16)}{t.issued_by ? ` · ${t.issued_by.split('@')[0]}` : ''}</span>}
            {t.received_at && <span>Received {String(t.received_at).slice(0, 16)}{t.received_by ? ` · ${t.received_by.split('@')[0]}` : ''}</span>}
          </div>
          {t.note && <div className="text-xs text-[#6B5744] bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg px-2.5 py-1.5">{t.note}</div>}

          {mode !== 'view' && (
            <div className="text-xs text-[#6B5744] bg-blue-50 border border-blue-200 rounded-lg px-2.5 py-1.5">
              {mode === 'issue'
                ? (t.from_central
                    ? 'Set the quantity issued per line (defaults to requested). This debits the central grocery stock.'
                    : 'Set the quantity issued per line (defaults to requested). This debits the source store ledger.')
                : 'Set the quantity received per line (defaults to issued). Any shortfall is recorded as a discrepancy.'}
            </div>
          )}

          {/* Items */}
          <div className="space-y-2">
            {t.items.map(it => {
              const disc = it.discrepancy;
              const showDisc = t.status === 'received' && disc !== 0;
              return (
                <div key={it.id} className="border border-[#E8D5C4] rounded-lg p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[#2D1B0E] break-words">{it.material_name}</div>
                      <div className="text-[10px] text-[#8B7355]">{it.category}</div>
                    </div>
                    {showDisc && (
                      <span className={`shrink-0 inline-flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5 border ${disc > 0 ? 'text-red-700 bg-red-50 border-red-200' : 'text-amber-700 bg-amber-50 border-amber-200'}`}>
                        <AlertTriangle className="w-3 h-3" /> {disc > 0 ? 'short' : 'over'} {qtyText(Math.abs(disc), it)}
                      </span>
                    )}
                  </div>

                  <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11px]">
                    <div><div className="text-[9px] uppercase text-[#8B7355]">Requested</div><div className="text-[#2D1B0E]">{qtyText(it.qty_requested, it)}</div></div>
                    <div><div className="text-[9px] uppercase text-[#8B7355]">Issued</div><div className="text-[#2D1B0E]">{it.qty_issued ? qtyText(it.qty_issued, it) : '—'}</div></div>
                    <div><div className="text-[9px] uppercase text-[#8B7355]">Received</div><div className="text-[#2D1B0E]">{it.qty_received ? qtyText(it.qty_received, it) : '—'}</div></div>
                  </div>

                  {/* In-transit line while issued but not fully received */}
                  {t.status === 'issued' && it.in_transit > 0 && (
                    <div className="mt-1 text-[10px] text-blue-800 flex items-center gap-1">
                      <PackageOpen className="w-3 h-3" /> in transit {qtyText(it.in_transit, it)}
                    </div>
                  )}
                  {it.note && <div className="mt-1 text-[10px] text-[#8B7355]">{it.note}</div>}

                  {/* Issue / receive entry */}
                  {mode !== 'view' && (
                    <div className="mt-2 border-t border-[#F0E4D6] pt-2">
                      <L>{mode === 'issue' ? 'Issue qty' : 'Receive qty'}</L>
                      <CBLEntry mat={it} value={qty[it.material_id] || CBL_EMPTY}
                                onChange={v => setQty(q => ({ ...q, [it.material_id]: v }))} compact />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Rollup */}
          <div className="text-xs text-[#6B5744] flex flex-wrap gap-x-4 gap-y-1 pt-1 border-t border-[#F0E4D6]">
            <span>Requested <b className="text-[#2D1B0E]">{fq(t.total_requested)}</b></span>
            <span>Issued <b className="text-[#2D1B0E]">{fq(t.total_issued)}</b></span>
            <span>Received <b className="text-[#2D1B0E]">{fq(t.total_received)}</b></span>
            {t.total_in_transit > 0 && (
              <span className={t.status === 'received' ? 'text-red-700 font-medium' : 'text-blue-800 font-medium'}>
                {t.status === 'received' ? 'Discrepancy' : 'In transit'} {fq(t.total_in_transit)}
              </span>
            )}
          </div>
        </>
      )}
    </ModalShell>
  );
}
