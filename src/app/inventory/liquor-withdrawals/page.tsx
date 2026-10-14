'use client';

/**
 * LIQUOR WITHDRAWALS — non-sale issues register (phase L4). ADMIN-ONLY.
 *
 * This is the director/management personal-use ledger the workbook's "Stock
 * Withdrawals" sheet was, plus the stock movement that sheet never made. Every
 * row here DEDUCTS the liquor store ledger (like a wastage) and tracks what is
 * recoverable from a named person. The page is gated adminOnly in page-catalog
 * (proxy enforces the nav); the /api/liquor/withdrawals routes re-check admin
 * server-side — this UI is convenience, never the boundary.
 *
 * Landed cost shown here is ANALYTICS ONLY (owner decision 1a): it is frozen onto
 * each row at issue and never feeds average_price, recipe costs or variance.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PackageMinus, Plus, Loader2, AlertCircle, CheckCircle2, Download, X,
  IndianRupee, RotateCcw, Filter,
} from 'lucide-react';
import { api } from '@/lib/api';
import { todayIST } from '@/lib/format-date';
import Toggle from '@/components/Toggle';
import MaterialTypeahead, { type MaterialLite } from '@/components/MaterialTypeahead';
import { packFactor, fmtBreakdown, toPurchaseQty, type PackMeta } from '@/lib/pack-units';

/* ── Types ─────────────────────────────────────────────────────────────── */
interface StoreLite { id: string; name: string; }
interface WRow {
  id: string; ref: string; date: string; store_id: string; store_name: string;
  material_id: string; material_name: string; material_unit: string;
  material_purchase_unit: string; material_pack_size: number; material_case_size: number;
  category: string; cases: number; bottles: number; qty_recipe_units: number;
  landed_unit_cost: number; landed_value: number; mrp_unit_value: number; mrp_value: number;
  taken_by: string; authorised_by: string; recovery_basis: string;
  recoverable: number; recovered: number; outstanding: number;
  excise_register: number; ledger_id: string; wastage_id: string; remarks: string;
}
interface CatStat {
  category: string; count: number; qty_recipe_units: number; landed_value: number;
  mrp_value: number; recoverable: number; recovered: number; outstanding: number;
}
interface Summary {
  from: string; to: string; store_id: string; by_category: CatStat[];
  total_landed_value: number; total_recoverable: number; total_recovered: number;
  total_outstanding: number; purchases_value: number; pct_of_purchases: number | null;
}
interface MatMeta extends PackMeta {
  id: string; name: string; category: string; onHand: number;
  /** ₹/recipe-unit — this STORE's weighted-average ledger cost, 0 when the
   *  store has never received the item. Preview only; the server freezes the
   *  authoritative figure at issue. */
  storeCost: number;
}

const CAT_LABEL: Record<string, string> = {
  management_personal: 'Management / Director personal',
  staff_welfare: 'Staff welfare',
  marketing_sampling: 'Marketing / Sampling',
  breakage_spoilage: 'Breakage / Spoilage',
  transfer: 'Transfer (non-sale)',
};
const BASIS_LABEL: Record<string, string> = {
  none: 'Not recoverable', landed: 'At landed cost', mrp: 'At MRP', custom: 'Custom amount',
};
const inr = (n: number) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/* ── Page ──────────────────────────────────────────────────────────────── */
export default function LiquorWithdrawalsPage() {
  const [stores, setStores] = useState<StoreLite[]>([]);
  const [withdrawals, setWithdrawals] = useState<WRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [basisList, setBasisList] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [err, setErr] = useState('');

  // Filters
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [fCat, setFCat] = useState('');
  const [fStore, setFStore] = useState('');
  const [fOutstanding, setFOutstanding] = useState(false);

  const [showForm, setShowForm] = useState(false);

  const loadList = useCallback(async () => {
    setErr('');
    const p = new URLSearchParams();
    if (fFrom) p.set('from', fFrom);
    if (fTo) p.set('to', fTo);
    if (fCat) p.set('category', fCat);
    if (fStore) p.set('store_id', fStore);
    if (fOutstanding) p.set('outstanding_only', '1');
    try {
      const r = await api(`/api/liquor/withdrawals?${p.toString()}`);
      if (r.status === 403) { setForbidden(true); setLoading(false); return; }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Failed to load');
      setWithdrawals(j.withdrawals || []);
      setSummary(j.summary || null);
      setStores(j.stores || []);
      setCategories(j.categories || []);
      setBasisList(j.recovery_basis || []);
    } catch (e: any) {
      setErr(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [fFrom, fTo, fCat, fStore, fOutstanding]);

  useEffect(() => { loadList(); }, [loadList]);

  const packMeta = (r: WRow): PackMeta => ({
    unit: r.material_unit, purchase_unit: r.material_purchase_unit,
    pack_size: r.material_pack_size, case_size: r.material_case_size,
  });
  const qtyLabel = (r: WRow) => {
    const b = fmtBreakdown(r.qty_recipe_units, packMeta(r));
    return b || `${toPurchaseQty(r.qty_recipe_units, packMeta(r))} ${r.material_purchase_unit || r.material_unit}`;
  };

  const downloadCsv = () => {
    const head = ['Ref', 'Date', 'Store', 'Material', 'Category', 'Cases', 'Bottles', 'Qty (recipe)', 'Recipe unit',
      'Landed ₹/unit', 'Landed value', 'MRP value', 'Taken by', 'Authorised by', 'Recovery basis',
      'Recoverable', 'Recovered', 'Outstanding', 'Excise reg', 'Remarks'];
    const rows = withdrawals.map(r => [
      r.ref, r.date, r.store_name, r.material_name, CAT_LABEL[r.category] || r.category,
      r.cases, r.bottles, r.qty_recipe_units, r.material_unit,
      r.landed_unit_cost, r.landed_value, r.mrp_value, r.taken_by, r.authorised_by,
      BASIS_LABEL[r.recovery_basis] || r.recovery_basis, r.recoverable, r.recovered, r.outstanding,
      r.excise_register ? 'Yes' : '', (r.remarks || '').replace(/[\r\n]+/g, ' '),
    ]);
    const csv = [head, ...rows].map(cols => cols.map(c => {
      const s = String(c ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `liquor-withdrawals-${todayIST()}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return <div className="p-6 flex items-center gap-2 text-[#6B5744]"><Loader2 className="w-5 h-5 animate-spin" /> Loading…</div>;
  }
  if (forbidden) {
    return (
      <div className="p-6 max-w-2xl mx-auto space-y-3">
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <PackageMinus className="w-6 h-6 text-[#af4408]" /> Liquor Withdrawals
        </h1>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 This register is admin-only. It holds the director / management personal-use ledger
          and moves stock, so it is out of reach for everyone else.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[220px]">
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <PackageMinus className="w-6 h-6 text-[#af4408]" /> Liquor Withdrawals
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Non-sale issues — personal use, staff welfare, marketing, breakage, transfers.
            Each deducts the liquor store ledger and tracks what is recoverable.
            Landed cost is frozen at issue and is analytics only.
          </p>
        </div>
        <button onClick={downloadCsv} disabled={!withdrawals.length}
                className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm font-medium flex items-center gap-1.5 disabled:opacity-50">
          <Download className="w-4 h-4" /> CSV
        </button>
        <button onClick={() => setShowForm(v => !v)}
                className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> New Withdrawal
        </button>
      </div>

      {err && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> {err}
        </div>
      )}

      {showForm && (
        <NewWithdrawalForm
          stores={stores} categories={categories} basisList={basisList}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); loadList(); }}
        />
      )}

      {/* Section H summary */}
      {summary && <SummaryCards summary={summary} />}

      {/* Filters */}
      <div className="bg-white border border-[#E8D5C4] rounded-lg p-3 flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-1.5 text-[#6B5744] text-xs font-medium"><Filter className="w-4 h-4" /> Filter</div>
        <label className="text-xs text-[#6B5744]">From
          <input type="date" value={fFrom} onChange={e => setFFrom(e.target.value)}
                 className="block mt-0.5 px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm" />
        </label>
        <label className="text-xs text-[#6B5744]">To
          <input type="date" value={fTo} onChange={e => setFTo(e.target.value)}
                 className="block mt-0.5 px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm" />
        </label>
        <label className="text-xs text-[#6B5744]">Category
          <select value={fCat} onChange={e => setFCat(e.target.value)}
                  className="block mt-0.5 px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm">
            <option value="">All</option>
            {categories.map(c => <option key={c} value={c}>{CAT_LABEL[c] || c}</option>)}
          </select>
        </label>
        {stores.length > 1 && (
          <label className="text-xs text-[#6B5744]">Store
            <select value={fStore} onChange={e => setFStore(e.target.value)}
                    className="block mt-0.5 px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm">
              <option value="">All</option>
              {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5 text-xs text-[#6B5744] pb-1">
          <Toggle size="sm" checked={fOutstanding} onChange={setFOutstanding} /> Outstanding only
        </label>
      </div>

      {/* Register */}
      <div className="bg-white border border-[#E8D5C4] rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#FBF3EA] text-[#6B5744] text-xs">
              <th className="text-left px-3 py-2">Ref / Date</th>
              <th className="text-left px-3 py-2">Material</th>
              <th className="text-left px-3 py-2">Category</th>
              <th className="text-right px-3 py-2">Qty</th>
              <th className="text-right px-3 py-2">Landed</th>
              <th className="text-left px-3 py-2">Recovery</th>
              <th className="text-right px-3 py-2">Recoverable</th>
              <th className="text-right px-3 py-2">Recovered</th>
              <th className="text-right px-3 py-2">Outstanding</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {withdrawals.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-6 text-center text-[#6B5744] text-sm">No withdrawals in this range.</td></tr>
            )}
            {withdrawals.map(r => (
              <WithdrawalRow key={r.id} r={r} qtyLabel={qtyLabel(r)} onRecovered={loadList} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Section H cards ───────────────────────────────────────────────────── */
function SummaryCards({ summary }: { summary: Summary }) {
  const active = summary.by_category.filter(c => c.count > 0);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Total issued (landed)" value={inr(summary.total_landed_value)} />
        <Stat label="Recoverable" value={inr(summary.total_recoverable)} />
        <Stat label="Recovered" value={inr(summary.total_recovered)} />
        <Stat label="Outstanding" value={inr(summary.total_outstanding)} accent />
      </div>
      <div className="bg-white border border-[#E8D5C4] rounded-lg p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold text-[#2D1B0E]">By category</h3>
          <span className="text-xs text-[#6B5744]">
            {summary.pct_of_purchases != null
              ? `${summary.pct_of_purchases}% of purchases (${inr(summary.purchases_value)}) in range`
              : 'No purchases recorded in range'}
          </span>
        </div>
        {active.length === 0 ? (
          <p className="text-xs text-[#6B5744]">Nothing withdrawn in this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[#6B5744]">
                  <th className="text-left py-1">Category</th>
                  <th className="text-right py-1">Count</th>
                  <th className="text-right py-1">Landed value</th>
                  <th className="text-right py-1">Recoverable</th>
                  <th className="text-right py-1">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {active.map(c => (
                  <tr key={c.category} className="border-t border-[#F0E4D6]">
                    <td className="py-1 text-[#2D1B0E]">{CAT_LABEL[c.category] || c.category}</td>
                    <td className="py-1 text-right">{c.count}</td>
                    <td className="py-1 text-right">{inr(c.landed_value)}</td>
                    <td className="py-1 text-right">{inr(c.recoverable)}</td>
                    <td className="py-1 text-right font-medium">{inr(c.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg p-3 border ${accent ? 'bg-[#af4408]/5 border-[#af4408]/30' : 'bg-white border-[#E8D5C4]'}`}>
      <div className="text-[11px] text-[#6B5744]">{label}</div>
      <div className={`text-lg font-bold ${accent ? 'text-[#af4408]' : 'text-[#2D1B0E]'}`}>{value}</div>
    </div>
  );
}

/* ── One register row + inline recovery ────────────────────────────────── */
function WithdrawalRow({ r, qtyLabel, onRecovered }: { r: WRow; qtyLabel: string; onRecovered: () => void }) {
  const [open, setOpen] = useState(false);
  const [rec, setRec] = useState(String(r.recovered || ''));
  const [busy, setBusy] = useState(false);
  const [e, setE] = useState('');

  const save = async () => {
    // An EMPTY box means "I typed nothing", never "write back ₹0". Sending 0
    // here silently wiped a settled recovery (measured: ₹300 recovered → 0,
    // ₹300 outstanding, no confirmation) for an admin who opened the panel,
    // cleared the field and saved. Clearing a recovery on purpose is typing 0.
    if (rec.trim() === '') {
      setE('Enter the amount recovered so far — type 0 to clear a recorded recovery.');
      return;
    }
    setBusy(true); setE('');
    try {
      const res = await api(`/api/liquor/withdrawals/${r.id}`, { method: 'PATCH', body: { recovered: Number(rec) } });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Failed');
      setOpen(false); onRecovered();
    } catch (err: any) { setE(err.message || 'Failed'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <tr className="border-t border-[#F0E4D6] align-top">
        <td className="px-3 py-2">
          <div className="font-mono text-xs text-[#af4408]">{r.ref}</div>
          <div className="text-xs text-[#6B5744]">{r.date}</div>
          {r.excise_register ? <div className="text-[10px] text-[#8a3506] mt-0.5">excise reg</div> : null}
        </td>
        <td className="px-3 py-2">
          <div className="text-[#2D1B0E]">{r.material_name}</div>
          <div className="text-[11px] text-[#6B5744]">{r.store_name}{r.wastage_id ? ' · wastage co-written' : ''}</div>
        </td>
        <td className="px-3 py-2 text-xs text-[#2D1B0E]">{CAT_LABEL[r.category] || r.category}
          {r.taken_by ? <div className="text-[11px] text-[#6B5744]">by {r.taken_by}</div> : null}
        </td>
        <td className="px-3 py-2 text-right whitespace-nowrap">{qtyLabel}</td>
        <td className="px-3 py-2 text-right whitespace-nowrap">{inr(r.landed_value)}</td>
        <td className="px-3 py-2 text-xs">{BASIS_LABEL[r.recovery_basis] || r.recovery_basis}</td>
        <td className="px-3 py-2 text-right">{inr(r.recoverable)}</td>
        <td className="px-3 py-2 text-right">{inr(r.recovered)}</td>
        <td className={`px-3 py-2 text-right font-medium ${r.outstanding > 0 ? 'text-[#af4408]' : 'text-[#6B5744]'}`}>{inr(r.outstanding)}</td>
        <td className="px-3 py-2 text-right">
          {r.recoverable > 0 && (
            <button onClick={() => setOpen(o => !o)} title="Record recovery"
                    className="p-1.5 rounded hover:bg-[#af4408]/10 text-[#af4408]"><IndianRupee className="w-4 h-4" /></button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="bg-[#FBF3EA]">
          <td colSpan={10} className="px-3 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-[#6B5744]">Recovered so far (₹, max {inr(r.recoverable)})
                <input type="number" min={0} max={r.recoverable} step="0.01" value={rec}
                       onChange={ev => setRec(ev.target.value)}
                       className="block mt-0.5 px-2 py-1 border border-[#E8D5C4] rounded bg-white text-sm w-40" />
              </label>
              <button onClick={save} disabled={busy}
                      className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-sm font-medium flex items-center gap-1.5 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Save
              </button>
              <button onClick={() => { setOpen(false); setRec(String(r.recovered || '')); }}
                      className="px-2 py-1.5 text-[#6B5744] hover:text-[#2D1B0E] text-sm flex items-center gap-1">
                <RotateCcw className="w-3.5 h-3.5" /> Reset
              </button>
              {e && <span className="text-xs text-red-700">{e}</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ── New withdrawal form ───────────────────────────────────────────────── */
function NewWithdrawalForm({ stores, categories, basisList, onClose, onSaved }: {
  stores: StoreLite[]; categories: string[]; basisList: string[];
  onClose: () => void; onSaved: () => void;
}) {
  const [storeId, setStoreId] = useState(stores[0]?.id || '');
  const [mats, setMats] = useState<MatMeta[]>([]);
  const [matLoading, setMatLoading] = useState(false);
  const [materialId, setMaterialId] = useState('');
  const [date, setDate] = useState(todayIST());
  const [category, setCategory] = useState(categories[0] || 'management_personal');
  const [cases, setCases] = useState('');
  const [bottles, setBottles] = useState('');
  const [landedPerBottle, setLandedPerBottle] = useState('');
  const [mrpPerBottle, setMrpPerBottle] = useState('');
  const [takenBy, setTakenBy] = useState('');
  const [authorisedBy, setAuthorisedBy] = useState('');
  const [basis, setBasis] = useState('none');
  const [recoverableCustom, setRecoverableCustom] = useState('');
  const [recovered, setRecovered] = useState('');
  const [excise, setExcise] = useState(false);
  const [coWriteWastage, setCoWriteWastage] = useState(false);
  const [allowNeg, setAllowNeg] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** Set when the server refuses a save as a likely retry (409) — the admin can
   *  then say "no, this really is a second issue". */
  const [dupRef, setDupRef] = useState(false);

  // Load the store's materials (with on-hand) for the picker.
  useEffect(() => {
    if (!storeId) return;
    setMatLoading(true); setMaterialId('');
    (async () => {
      try {
        const r = await api(`/api/stores/${storeId}/stock`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Failed to load materials');
        const onHand = new Map<string, number>();
        for (const c of (j.catalog || j.stock || [])) onHand.set(c.material_id, Number(c.qty) || 0);
        // Preview cost basis: the STORE's own weighted-average unit cost, and
        // only for a material the store has actually received (has_ledger).
        // raw_materials.average_price is deliberately NOT used — this database
        // stores it in mixed bases (HENDRICKS GIN carries ₹5,641.83 against a
        // 700 ml recipe unit, i.e. ₹/bottle), and reading it as ₹/recipe-unit
        // previewed one bottle at ₹3.9 million. The server resolves the real
        // figure on save; where this is 0 the preview says so.
        const storeCost = new Map<string, number>();
        for (const c of (j.catalog || j.stock || [])) {
          if (c.has_ledger) storeCost.set(c.material_id, Number(c.avg_cost) || 0);
        }
        const list: MatMeta[] = (j.materials || []).map((m: any) => ({
          id: m.id, name: m.name, category: m.category, unit: m.unit,
          purchase_unit: m.purchase_unit, pack_size: m.pack_size, case_size: m.case_size,
          storeCost: storeCost.get(m.id) || 0,
          onHand: onHand.get(m.id) || 0,
        }));
        setMats(list);
      } catch (e: any) { setErr(e.message || 'Failed to load materials'); }
      finally { setMatLoading(false); }
    })();
  }, [storeId]);

  const mat = useMemo(() => mats.find(m => m.id === materialId) || null, [mats, materialId]);
  const pf = mat ? (packFactor(mat) || 1) : 1;
  const cf = mat ? (Number(mat.case_size) || 1) : 1;

  // Live computed figures (mirror the server maths for the preview only).
  const qtyRecipe = mat ? ((Number(cases) || 0) * cf * pf + (Number(bottles) || 0) * pf) : 0;
  const landedUnit = landedPerBottle !== '' ? (Number(landedPerBottle) / pf)
    : (mat ? mat.storeCost : 0);       // preview only; the server resolves L1 → store-avg → last purchase
  const landedValue = Math.round(qtyRecipe * landedUnit * 100) / 100;
  /** Nothing to preview from: the server may still resolve a cost on save. */
  const landedUnknown = landedPerBottle === '' && !(landedUnit > 0);
  const mrpUnit = mrpPerBottle !== '' ? Number(mrpPerBottle) / pf : 0;
  const mrpValue = Math.round(qtyRecipe * mrpUnit * 100) / 100;
  const recoverablePreview = basis === 'landed' ? landedValue : basis === 'mrp' ? mrpValue
    : basis === 'custom' ? (Number(recoverableCustom) || 0) : 0;

  // The server refuses a recovery basis whose recoverable would be ₹0 — such a
  // row says money is owed but can never be billed or corrected. Only the two
  // bases the BROWSER can settle are mirrored here; 'landed' is resolved
  // server-side (L1 landed cost → store weighted-avg → last purchase), so
  // blocking it from the preview figure would refuse saves the server accepts.
  const basisBlocked = basis === 'mrp' && !(mrpValue > 0) ? 'Enter the MRP ₹/bottle, or set recovery to "Not recoverable".'
    : basis === 'custom' && !(Number(recoverableCustom) > 0) ? 'Enter the recoverable amount, or set recovery to "Not recoverable".'
    : '';
  const wholeCounts = [cases, bottles].every(v => v === '' || (Number.isInteger(Number(v)) && Number(v) >= 0));

  const submit = async (confirmDuplicate = false) => {
    setBusy(true); setErr(''); if (!confirmDuplicate) setDupRef(false);
    try {
      const body: any = {
        store_id: storeId, material_id: materialId, date, category,
        cases: Number(cases) || 0, bottles: Number(bottles) || 0,
        taken_by: takenBy, authorised_by: authorisedBy,
        recovery_basis: basis, recovered: recovered === '' ? 0 : Number(recovered),
        excise_register: excise, co_write_wastage: coWriteWastage,
        allow_negative: allowNeg, remarks,
      };
      if (landedPerBottle !== '') body.landed_unit_cost = Number(landedPerBottle) / pf;
      if (mrpPerBottle !== '') body.mrp_unit_value = Number(mrpPerBottle) / pf;
      // Only a 'custom' row takes a typed recoverable — the server refuses it on
      // any other basis rather than dropping it silently.
      if (basis === 'custom') body.recoverable_custom = Number(recoverableCustom) || 0;
      if (confirmDuplicate) body.confirm_duplicate = true;
      const r = await api('/api/liquor/withdrawals', { method: 'POST', body });
      const j = await r.json();
      if (!r.ok) { if (j.duplicate) setDupRef(true); throw new Error(j.error || 'Failed to record'); }
      onSaved();
    } catch (e: any) { setErr(e.message || 'Failed to record'); }
    finally { setBusy(false); }
  };

  const matLite: MaterialLite[] = mats.map(m => ({
    id: m.id, name: m.name, category: m.category, unit: m.unit ?? undefined,
    purchase_unit: m.purchase_unit ?? undefined, pack_size: m.pack_size ?? undefined,
    current_stock: m.onHand,
  }));

  return (
    <div className="bg-white border-2 border-[#af4408]/30 rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
          <Plus className="w-5 h-5 text-[#af4408]" /> New Withdrawal
        </h2>
        <button onClick={onClose} className="p-1 text-[#6B5744] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {stores.length > 1 && (
          <label className="text-xs text-[#6B5744]">Store
            <select value={storeId} onChange={e => setStoreId(e.target.value)}
                    className="block mt-0.5 w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm">
              {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <label className="text-xs text-[#6B5744] lg:col-span-2">Material
          <div className="mt-0.5">
            <MaterialTypeahead materials={matLite} value={materialId} onPick={setMaterialId}
                               purchaseBasis compact={false}
                               placeholder={matLoading ? 'Loading materials…' : 'Type material name / category…'} />
          </div>
          {mat && (
            <span className="text-[11px] text-[#6B5744]">
              On hand: {toPurchaseQty(mat.onHand, mat)} {mat.purchase_unit || mat.unit}
              {' '}· case = {cf} {mat.purchase_unit || mat.unit}
            </span>
          )}
        </label>
        {/* A withdrawal records stock that has ALREADY left, so the business date
            cannot be in the future — the server refuses one too. */}
        <label className="text-xs text-[#6B5744]">Date
          <input type="date" value={date} max={todayIST()} onChange={e => setDate(e.target.value)}
                 className="block mt-0.5 w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm" />
        </label>
        <label className="text-xs text-[#6B5744]">Category
          <select value={category} onChange={e => setCategory(e.target.value)}
                  className="block mt-0.5 w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm">
            {categories.map(c => <option key={c} value={c}>{CAT_LABEL[c] || c}</option>)}
          </select>
        </label>
        {/* Whole counts only — you cannot take 0.3 of a bottle off a shelf, and
            a typed "−3" used to be recorded as 0 with no error. */}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-[#6B5744]">Cases
            <input type="number" min={0} step={1} value={cases} onChange={e => setCases(e.target.value)}
                   className="block mt-0.5 w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm" />
          </label>
          <label className="text-xs text-[#6B5744]">Bottles
            <input type="number" min={0} step={1} value={bottles} onChange={e => setBottles(e.target.value)}
                   className="block mt-0.5 w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm" />
          </label>
        </div>
        <label className="text-xs text-[#6B5744]">Landed ₹/bottle <span className="opacity-60">(blank = auto)</span>
          <input type="number" min={0} step="0.01" value={landedPerBottle} onChange={e => setLandedPerBottle(e.target.value)}
                 className="block mt-0.5 w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm" />
        </label>
        <label className="text-xs text-[#6B5744]">MRP ₹/bottle <span className="opacity-60">{basis === 'mrp' ? '(required — recovery is at MRP)' : '(optional)'}</span>
          <input type="number" min={0} step="0.01" value={mrpPerBottle} onChange={e => setMrpPerBottle(e.target.value)}
                 className="block mt-0.5 w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm" />
        </label>
        <label className="text-xs text-[#6B5744]">Taken by
          <input value={takenBy} onChange={e => setTakenBy(e.target.value)}
                 className="block mt-0.5 w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm" />
        </label>
        <label className="text-xs text-[#6B5744]">Authorised by
          <input value={authorisedBy} onChange={e => setAuthorisedBy(e.target.value)}
                 className="block mt-0.5 w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm" />
        </label>
        <label className="text-xs text-[#6B5744]">Recovery basis
          <select value={basis} onChange={e => setBasis(e.target.value)}
                  className="block mt-0.5 w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm">
            {basisList.map(bb => <option key={bb} value={bb}>{BASIS_LABEL[bb] || bb}</option>)}
          </select>
        </label>
        {basis === 'custom' && (
          <label className="text-xs text-[#6B5744]">Recoverable (₹)
            <input type="number" min={0} step="0.01" value={recoverableCustom} onChange={e => setRecoverableCustom(e.target.value)}
                   className="block mt-0.5 w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm" />
          </label>
        )}
        {basis !== 'none' && (
          <label className="text-xs text-[#6B5744]">Recovered so far (₹)
            <input type="number" min={0} step="0.01" value={recovered} onChange={e => setRecovered(e.target.value)}
                   className="block mt-0.5 w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm" />
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-[#6B5744]">
          <Toggle size="sm" checked={excise} onChange={setExcise} /> Goes in excise register
        </label>
        {category === 'breakage_spoilage' && (
          <label className="flex items-center gap-2 text-xs text-[#6B5744]">
            <Toggle size="sm" checked={coWriteWastage} onChange={setCoWriteWastage} /> Also record on wastage rail
          </label>
        )}
        {category === 'breakage_spoilage' && coWriteWastage && (
          <span className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            The /wastage copy is a RECORD ONLY — the stock has already left the liquor store ledger.
            It cannot be deleted from /wastage (this bottle never sat on central&apos;s shelf), and it stays
            for as long as this withdrawal does.
          </span>
        )}
        {/* The override covers a book that is merely behind the shelf. It never
            covers an item whose stock is still in Central (the server refuses it
            with not_migrated until Migrate has run): a forced first entry here
            would block Migrate and count that Central stock twice. */}
        <label className="flex items-center gap-2 text-xs text-[#6B5744]"
               title="Not for an item whose stock is still in Central stock: run Migrate on the store first.">
          <Toggle size="sm" checked={allowNeg} onChange={setAllowNeg} /> Allow issuing below on-hand
        </label>
        {allowNeg && (
          <span className="text-[11px] text-[#8B7355]">
            Does not apply to an item still held in Central stock — run Migrate on the store first.
          </span>
        )}
      </div>

      <label className="text-xs text-[#6B5744] block">Remarks
        <input value={remarks} onChange={e => setRemarks(e.target.value)}
               className="block mt-0.5 w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm" />
      </label>

      {/* Preview */}
      {mat && qtyRecipe > 0 && (
        <div className="bg-[#FBF3EA] border border-[#E8D5C4] rounded p-3 text-xs text-[#6B5744] flex flex-wrap gap-x-6 gap-y-1">
          <span>Qty: <b className="text-[#2D1B0E]">{fmtBreakdown(qtyRecipe, mat) || `${toPurchaseQty(qtyRecipe, mat)} ${mat.purchase_unit || mat.unit}`}</b> ({qtyRecipe} {mat.unit})</span>
          <span>Landed value: {landedUnknown
            ? <b className="text-[#8B7355]">resolved on save</b>
            : <><b className="text-[#2D1B0E]">{inr(landedValue)}</b>{landedPerBottle === '' ? ' (auto)' : ''}</>}</span>
          {mrpValue > 0 && <span>MRP value: <b className="text-[#2D1B0E]">{inr(mrpValue)}</b></span>}
          {basis !== 'none' && <span>Recoverable: <b className="text-[#af4408]">{inr(recoverablePreview)}</b></span>}
        </div>
      )}

      {basisBlocked && !err && (
        <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-amber-900 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> {basisBlocked}
        </div>
      )}
      {!wholeCounts && (
        <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-amber-900 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> Cases and bottles must be whole numbers, 0 or more.
        </div>
      )}
      {err && <div className="bg-red-50 border border-red-200 rounded p-2 text-sm text-red-800 flex items-center gap-2"><AlertCircle className="w-4 h-4" /> {err}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => submit()} disabled={busy || !materialId || qtyRecipe <= 0 || !!basisBlocked || !wholeCounts}
                className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Record Withdrawal
        </button>
        {/* The server refused this as a likely retry. Only a human can say it is
            a genuine second issue of the same item to the same person. */}
        {dupRef && (
          <button onClick={() => submit(true)} disabled={busy}
                  className="px-3 py-2 border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm font-medium disabled:opacity-50">
            Record anyway — this is a second issue
          </button>
        )}
        <button onClick={onClose} className="px-3 py-2 text-[#6B5744] hover:text-[#2D1B0E] text-sm">Cancel</button>
      </div>
    </div>
  );
}
