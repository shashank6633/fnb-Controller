'use client';

/**
 * Liquor Purchase Reconciliation — Summary (phase L5).
 *
 * The workbook's Summary sheet as a LIVE page over a date range: the four named
 * CHECKS as pass/fail cards, then sections A / A2 / B / C / D / E / F / G / H,
 * each with a per-section CSV export. Every figure is computed server-side from
 * recorded lines (src/lib/liquor-summary.ts) — nothing here is hardcoded, and
 * this page writes NOTHING: it is a reader and renderer.
 *
 * Source: GET /api/liquor/reconciliation (mgmtOnly; the route re-checks
 * isManagement server-side, and a 403 renders the 🔒 notice here). CSV per
 * section is the same route with &section=..&format=csv.
 *
 * A section whose data is fed by a sibling phase not yet landed (L1 brand map,
 * L3 retail flags, L4 withdrawals) degrades to a clearly-labelled "pending"
 * banner rather than a fabricated zero.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Scale, Loader2, AlertCircle, Download, CalendarDays, Wallet, TrendingUp,
  Beer, Percent, Store, ArrowRightLeft, PackageX, Landmark, CheckCircle2,
  XCircle, AlertTriangle, HelpCircle, IndianRupee,
} from 'lucide-react';

/* ── Types mirror the /api/liquor/reconciliation payload ─────────────────────── */
type Pending = { phase: string; reason: string } | null;
interface Check {
  key: string; label: string; state: 'pass' | 'fail' | 'warn' | 'no_data';
  detail: string; computed: number | null; observed: number | null; difference: number | null;
}
interface Bucket { key: string; lines: number; bottles: number; cases: number; invoiceValue: number; levies: number; landedValue: number; uplift: number | null; }
interface IndentRow { invoice_ref: string; date: string; supplier: string; lines: number; invoice_value: number; mrp_rounding: number; excise_turnover_tax: number; special_excise_cess: number; tcs: number; net_indent_value: number; has_charges: boolean; partial_in_range: boolean; }
interface RetailRow { id: string; date: string; shop_name: string; bottles: number; rate_paid_per_bottle: number; depot_landed_per_bottle: number; excess_per_bottle: number; excess_total: number; excess_pct: number; paid_by: string; reimbursement_status: string; reason: string; }
interface RateRow { ledgerId: string; invoiceRef: string; inwardDate: string; materialName: string; category: string; bottles: number; indentRate: number; masterRate: number | null; variance: number | null; varianceValue: number | null; proposedRatePerCase: number | null; mapReason: string; }
interface WdBucket { category: string; count: number; landed_value: number; mrp_value: number; recoverable: number; recovered: number; outstanding: number; }
interface Summary {
  store: { id: string; name: string };
  range: { from: string; to: string };
  generated_at: string;
  sections: {
    A: any; A2: any; B: { indents: IndentRow[]; totals: any; pending: Pending };
    C: { buckets: Bucket[]; beer: Bucket; spirits: any; unmapped: Bucket; mappedLines: number; totalLines: number; pending: Pending };
    D: any; E: { rows: RetailRow[]; bottles: number; spend: number; depot_equivalent: number; excess_total: number; unreimbursed_staff_spend: number; unknown_depot_count: number; unknown_depot_bottles: number; reopened_claim_count: number; pending: Pending };
    F: any; G: { rows: RateRow[]; moved_lines: number; scanned_lines: number; unmapped_lines: number; total_variance_value: number; pending: Pending };
    H: { buckets: WdBucket[]; total_landed_value: number; total_outstanding: number; pct_of_purchases: number | null; pending: Pending };
  };
  basis: {
    bill_invoice_value: number; line_invoice_value: number; difference: number; diverges: boolean;
    straddling_indents: string[]; unattributed_lines: number; unattributed_value: number; note: string;
  };
  checks: Check[];
  dependencies: Array<{ phase: string; label: string; live: boolean; note: string }>;
  stores: Array<{ id: string; name: string }>;
}

/* ── format helpers ──────────────────────────────────────────────────────────── */
const inr = (v: number | null | undefined, dp = 0) =>
  v == null ? '—' : '₹' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const n2 = (v: number | null | undefined, dp = 2) =>
  v == null ? '—' : (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: dp });
const pct = (v: number | null | undefined) => v == null ? '—' : `${(Number(v) || 0).toFixed(1)}%`;
const todayStr = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const firstOfMonth = () => todayStr().slice(0, 7) + '-01';

/* ── page ────────────────────────────────────────────────────────────────────── */
export default function LiquorReconciliationPage() {
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(todayStr);
  const [storeId, setStoreId] = useState<string>('');
  const [planned, setPlanned] = useState<string>('');
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const qs = useMemo(() => {
    const p = new URLSearchParams({ from, to });
    if (storeId) p.set('store_id', storeId);
    if (planned.trim() !== '' && Number.isFinite(Number(planned))) p.set('planned_indent', String(Number(planned)));
    return p.toString();
  }, [from, to, storeId, planned]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError('');
      try {
        const res = await fetch(`/api/liquor/reconciliation?${qs}`, { credentials: 'same-origin' });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        if (!alive) return;
        setData(json);
        if (!storeId && json?.store?.id) setStoreId(json.store.id);
      } catch (e: unknown) {
        if (alive) setError((e as Error)?.message || 'Failed to load');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [qs]); // eslint-disable-line react-hooks/exhaustive-deps

  const downloadCsv = useCallback(async (section: string) => {
    try {
      const p = new URLSearchParams({ from, to, section, format: 'csv' });
      if (storeId) p.set('store_id', storeId);
      if (planned.trim() !== '' && Number.isFinite(Number(planned))) p.set('planned_indent', String(Number(planned)));
      const res = await fetch(`/api/liquor/reconciliation?${p.toString()}`, { credentials: 'same-origin' });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error || `HTTP ${res.status}`); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `liquor-recon_${section}_${from}_to_${to}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } catch (e) { alert((e as Error)?.message || 'CSV export failed'); }
  }, [from, to, storeId, planned]);

  if (loading && !data) {
    return (
      <div className="p-6 max-w-3xl mx-auto text-sm text-[#6B5744]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading liquor reconciliation…
      </div>
    );
  }
  if (error && !data) {
    const denied = /manager|hod|admin|authoriz|sign in/i.test(error);
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-3">
        <H1 />
        <div className={`rounded-lg p-4 text-sm flex items-center gap-2 ${denied ? 'bg-amber-50 border border-amber-200 text-amber-900' : 'bg-red-50 border border-red-200 text-red-700'}`}>
          <AlertCircle className="w-4 h-4 shrink-0" /> {denied ? `🔒 ${error}` : error}
        </div>
      </div>
    );
  }
  if (!data) return null;
  const S = data.sections;

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-5">
      {/* Header + controls */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[220px]"><H1 subtitle={`${data.store.name} · ${data.range.from} → ${data.range.to}`} /></div>
        <label className="flex flex-col text-[11px] text-[#8B7355] font-medium">Store
          <select value={storeId} onChange={e => setStoreId(e.target.value)}
                  className="mt-0.5 px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white text-[#2D1B0E]">
            {(data.stores || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-[11px] text-[#8B7355] font-medium">From
          <input type="date" value={from} onChange={e => setFrom(e.target.value || firstOfMonth())}
                 className="mt-0.5 px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white text-[#2D1B0E]" />
        </label>
        <label className="flex flex-col text-[11px] text-[#8B7355] font-medium">To
          <input type="date" value={to} onChange={e => setTo(e.target.value || todayStr())}
                 className="mt-0.5 px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white text-[#2D1B0E]" />
        </label>
        {loading && <Loader2 className="w-4 h-4 animate-spin text-[#8B7355] mb-2.5" />}
      </div>

      {/* The four checks */}
      <div>
        <SectionTitle icon={<CheckCircle2 className="w-4 h-4" />} title="The four checks" onCsv={() => downloadCsv('checks')} />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 mt-2">
          {data.checks.map(c => <CheckCard key={c.key} c={c} />)}
        </div>
      </div>

      {/* §A Wallet + §A2 Top-up */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel icon={<Wallet className="w-4 h-4" />} title="A · Wallet reconciliation" onCsv={() => downloadCsv('A')} pending={S.A.pending}>
          <div className="grid grid-cols-2 gap-2.5">
            <Stat label="Balance" value={inr(S.A.balance)} tone={S.A.overdrawn ? 'bad' : 'good'} />
            <Stat label="Working capital parked" value={inr(S.A.working_capital_parked)} />
            <Stat label="Funded in" value={inr(S.A.funded_in)} />
            <Stat label="Utilised out" value={inr(S.A.utilised_out)} />
            <Stat label="Deposits utilised" value={pct(S.A.deposits_utilised_pct)} />
            <Stat label="Bank-unconfirmed" value={`${S.A.bank_unconfirmed_count} · ${inr(S.A.bank_unconfirmed_total)}`}
                  tone={S.A.bank_unconfirmed_count > 0 ? 'warn' : 'muted'} />
            <Stat label={`Window opening (${data.range.from})`} value={inr(S.A.window_opening_balance)} />
            <Stat label={`Window closing (${data.range.to})`} value={inr(S.A.window_closing_balance)} />
          </div>
          {/* The wallet is a POSITION. Everything above except the two window
              figures counts every recorded movement, so an empty date range
              still shows a balance — say so rather than let the range header
              imply otherwise. */}
          <p className="text-[11px] text-[#B9A896] mt-2">
            Balance, funded/utilised and bank-unconfirmed count ALL recorded wallet movements — they are a
            point-in-time position, not bounded by the date range. Only the two window figures follow it.
          </p>
        </Panel>
        <Panel icon={<Landmark className="w-4 h-4" />} title="A2 · Top-up planner" onCsv={() => downloadCsv('A2')} pending={S.A2.pending}>
          <div className="flex items-end gap-2 mb-3">
            <label className="flex flex-col text-[11px] text-[#8B7355] font-medium flex-1">Planned next indent (₹)
              <input type="number" value={planned} onChange={e => setPlanned(e.target.value)} placeholder="e.g. 250000"
                     className="mt-0.5 px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white text-[#2D1B0E]" />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Stat label="Shortfall" value={inr(S.A2.shortfall)} tone={S.A2.shortfall > 0 ? 'warn' : 'good'} />
            <Stat label={`Recommended challan (↑₹${n2(S.A2.step, 0)})`} value={inr(S.A2.recommended_challan)} tone="good" />
            <Stat label="Rounding added" value={inr(S.A2.rounding_add)} />
            <Stat label="Balance after" value={inr(S.A2.balance_after)} />
          </div>
          {!S.A2.planned && <p className="text-[11px] text-[#B9A896] mt-2">Enter a planned indent to size the next challan.</p>}
        </Panel>
      </div>

      {/* §B Purchase totals */}
      <Panel icon={<Store className="w-4 h-4" />} title="B · Purchase totals + per-indent value check" onCsv={() => downloadCsv('B')} pending={S.B.pending}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-3">
          <Stat label="Indents" value={n2(S.B.totals.indents, 0)} />
          <Stat label="Invoice value" value={inr(S.B.totals.invoice_value)} />
          <Stat label="Levies (4 TGBCL)" value={inr(S.B.totals.mrp_rounding + S.B.totals.excise_turnover_tax + S.B.totals.special_excise_cess + S.B.totals.tcs)} />
          <Stat label="Net indent" value={inr(S.B.totals.net_indent_value)} tone="good" />
        </div>
        {data.basis?.diverges && (
          <div className="mb-3 rounded-lg p-2.5 text-[11px] bg-[#FFF8F0] border border-[#E8D5C4] text-[#6B5744] flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600" />
            <span><span className="font-semibold">Two bases:</span> {data.basis.note}</span>
          </div>
        )}
        {S.B.indents.length > 0 && (
          <Scroll>
            <table className="w-full text-xs border-collapse">
              <thead><tr className="bg-[#FFF1E3] text-[#6B5744]">
                {['Invoice', 'Date', 'Supplier', 'Lines', 'Invoice ₹', 'MRP rnd', 'Turnover', 'Cess', 'TCS', 'Net indent'].map(h =>
                  <th key={h} className={`px-2 py-1.5 font-semibold ${h === 'Invoice' || h === 'Date' || h === 'Supplier' ? 'text-left' : 'text-right'}`}>{h}</th>)}
              </tr></thead>
              <tbody>
                {S.B.indents.map(i => (
                  <tr key={i.invoice_ref} className="border-t border-[#F0E4D6]">
                    <td className="px-2 py-1.5 font-medium text-[#2D1B0E]">{i.invoice_ref}
                      {!i.has_charges && <span title="No TGBCL levies recorded" className="text-[#B9A896]"> ·no levies</span>}
                      {i.partial_in_range && <span title="This bill has lines outside the selected range — its value is counted WHOLE here, and only the in-range lines reach §C/§D." className="text-amber-700"> ·straddles range</span>}
                    </td>
                    <td className="px-2 py-1.5 text-[#6B5744]">{i.date}</td>
                    <td className="px-2 py-1.5 text-[#6B5744]">{i.supplier || '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{i.lines}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(i.invoice_value)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(i.mrp_rounding)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(i.excise_turnover_tax)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(i.special_excise_cess)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(i.tcs)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-[#2D1B0E]">{inr(i.net_indent_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
      </Panel>

      {/* §C beer/spirit + §D factors */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel icon={<Beer className="w-4 h-4" />} title="C · Beer / spirit split" onCsv={() => downloadCsv('C')} pending={S.C.pending}>
          <Scroll>
            <table className="w-full text-xs border-collapse">
              <thead><tr className="bg-[#FFF1E3] text-[#6B5744]">
                {['Type', 'Lines', 'Bottles', 'Cases', 'Invoice ₹', 'Landed ₹', 'Uplift'].map(h =>
                  <th key={h} className={`px-2 py-1.5 font-semibold ${h === 'Type' ? 'text-left' : 'text-right'}`}>{h}</th>)}
              </tr></thead>
              <tbody>
                {S.C.buckets.map(b => (
                  <tr key={b.key} className="border-t border-[#F0E4D6]">
                    <td className="px-2 py-1.5 font-medium text-[#2D1B0E]">{b.key}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{b.lines}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{n2(b.bottles)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{n2(b.cases)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(b.invoiceValue)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(b.landedValue)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{b.uplift == null ? '—' : `${b.uplift.toFixed(3)}×`}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF8F0] font-semibold text-[#2D1B0E]">
                  <td className="px-2 py-1.5">Spirits (IML+DP)</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{S.C.spirits.lines}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{n2(S.C.spirits.bottles)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{n2(S.C.spirits.cases)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{inr(S.C.spirits.invoiceValue)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{inr(S.C.spirits.landedValue)}</td>
                  <td className="px-2 py-1.5" />
                </tr>
              </tbody>
            </table>
          </Scroll>
          <p className="text-[11px] text-[#B9A896] mt-2">
            {S.C.mappedLines}/{S.C.totalLines} lines mapped to a TGBCL brand. Cases count case-packed lines only
            {S.D.loose_bottles > 0 && <> — {n2(S.D.loose_bottles)} bottle(s) were bought loose and appear under Bottles alone</>}.
          </p>
        </Panel>

        <Panel icon={<Percent className="w-4 h-4" />} title="D · Derived factors (computed, not assumed)" onCsv={() => downloadCsv('D')} pending={S.D.pending}>
          <div className="grid grid-cols-2 gap-2.5">
            <Stat label="Uplift overall" value={S.D.uplift_overall == null ? '—' : `${S.D.uplift_overall.toFixed(3)}×`} />
            <Stat label="Effective TCS" value={pct(S.D.effective_tcs_pct)} />
            <Stat label="Cess / case (case-packed)" value={inr(S.D.cess_per_case, 2)} />
            <Stat label="MRP rounding / bottle" value={inr(S.D.mrp_rounding_per_bottle, 2)} />
            <Stat label="Avg landed / bottle" value={inr(S.D.avg_landed_per_bottle, 2)} />
            <Stat label="Cess / bottle" value={inr(S.D.cess_per_bottle, 2)} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {S.D.uplift_by_type.map((u: any) => (
              <span key={u.key} className="px-2 py-1 rounded-full text-[11px] bg-[#FFF1E3] border border-[#E8D5C4] text-[#6B5744]">
                {u.key}: {u.uplift == null ? '—' : `${u.uplift.toFixed(3)}×`}
              </span>
            ))}
          </div>
        </Panel>
      </div>

      {/* §E retail + §F total */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Panel icon={<TrendingUp className="w-4 h-4" />} title="E · Emergency wine-shop purchases" onCsv={() => downloadCsv('E')} pending={S.E.pending}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-3">
              <Stat label="Bottles" value={n2(S.E.bottles)} />
              <Stat label="Retail spend" value={inr(S.E.spend)} />
              <Stat label="Excess (price of running out)" value={inr(S.E.excess_total)} tone={S.E.excess_total > 0 ? 'warn' : 'good'} />
              <Stat label="Unreimbursed staff" value={inr(S.E.unreimbursed_staff_spend)} tone={S.E.unreimbursed_staff_spend > 0 ? 'warn' : 'muted'} />
            </div>
            {(S.E.unknown_depot_count > 0 || S.E.reopened_claim_count > 0) && (
              <p className="text-[11px] text-amber-700 mb-2">
                {S.E.unknown_depot_count > 0 && <>{S.E.unknown_depot_count} buy(s) ({n2(S.E.unknown_depot_bottles)} bottles) have no depot rate — excluded from Excess rather than counted as zero. </>}
                {S.E.reopened_claim_count > 0 && <>{S.E.reopened_claim_count} claim(s) marked reimbursed have no payout behind them — still owed.</>}
              </p>
            )}
            {S.E.rows.length > 0 && (
              <Scroll>
                <table className="w-full text-xs border-collapse">
                  <thead><tr className="bg-[#FFF1E3] text-[#6B5744]">
                    {['Date', 'Shop', 'Bottles', 'Rate paid', 'Depot landed', 'Excess', 'Reimb.'].map(h =>
                      <th key={h} className={`px-2 py-1.5 font-semibold ${h === 'Date' || h === 'Shop' || h === 'Reimb.' ? 'text-left' : 'text-right'}`}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {S.E.rows.map(r => (
                      <tr key={r.id} className="border-t border-[#F0E4D6]">
                        <td className="px-2 py-1.5 text-[#6B5744]">{r.date}</td>
                        <td className="px-2 py-1.5 text-[#2D1B0E]">{r.shop_name || '—'}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{n2(r.bottles)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{inr(r.rate_paid_per_bottle, 2)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{inr(r.depot_landed_per_bottle, 2)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-amber-700">{inr(r.excess_total)}</td>
                        <td className="px-2 py-1.5 text-[#6B5744]">{r.reimbursement_status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </Panel>
        </div>
        <Panel icon={<IndianRupee className="w-4 h-4" />} title="F · Total liquor cost" onCsv={() => downloadCsv('F')} pending={S.F.pending}>
          <div className="space-y-2.5">
            <Stat label="Depot net indent" value={inr(S.F.depot_net_indent)} />
            <Stat label="Retail spend" value={inr(S.F.retail_spend)} />
            <Stat label="Total" value={inr(S.F.total)} tone="good" />
            <Stat label="Retail share" value={pct(S.F.retail_share_pct)} />
          </div>
        </Panel>
      </div>

      {/* §G rate movement */}
      <Panel icon={<ArrowRightLeft className="w-4 h-4" />} title="G · Rate-movement watch" onCsv={() => downloadCsv('G')} pending={S.G.pending}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-3">
          <Stat label="Lines moved" value={n2(S.G.moved_lines, 0)} tone={S.G.moved_lines > 0 ? 'warn' : 'good'} />
          <Stat label="Lines scanned" value={n2(S.G.scanned_lines, 0)} />
          <Stat label="Unmapped" value={n2(S.G.unmapped_lines, 0)} />
          <Stat label="Total variance value" value={inr(S.G.total_variance_value)} />
        </div>
        {S.G.rows.length > 0 && (
          <Scroll>
            <table className="w-full text-xs border-collapse">
              <thead><tr className="bg-[#FFF1E3] text-[#6B5744]">
                {['Date', 'Invoice', 'Material', 'Bottles', 'Indent rate', 'Master rate', 'Variance', 'Value'].map(h =>
                  <th key={h} className={`px-2 py-1.5 font-semibold ${h === 'Date' || h === 'Invoice' || h === 'Material' ? 'text-left' : 'text-right'}`}>{h}</th>)}
              </tr></thead>
              <tbody>
                {S.G.rows.map(r => (
                  <tr key={r.ledgerId} className="border-t border-[#F0E4D6]">
                    <td className="px-2 py-1.5 text-[#6B5744]">{r.inwardDate}</td>
                    <td className="px-2 py-1.5 text-[#6B5744]">{r.invoiceRef}</td>
                    <td className="px-2 py-1.5 text-[#2D1B0E]">{r.materialName}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{n2(r.bottles)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(r.indentRate, 2)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(r.masterRate, 2)}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${(r.variance ?? 0) > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{inr(r.variance, 2)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(r.varianceValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
      </Panel>

      {/* §H withdrawals */}
      <Panel icon={<PackageX className="w-4 h-4" />} title="H · Non-sale issues (withdrawals)" onCsv={() => downloadCsv('H')} pending={S.H.pending}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mb-3">
          <Stat label="Total landed value" value={inr(S.H.total_landed_value)} />
          <Stat label="% of purchases" value={pct(S.H.pct_of_purchases)} />
          <Stat label="Outstanding recoverable" value={inr(S.H.total_outstanding)} tone={S.H.total_outstanding > 0 ? 'warn' : 'muted'} />
        </div>
        {S.H.buckets.length > 0 && (
          <Scroll>
            <table className="w-full text-xs border-collapse">
              <thead><tr className="bg-[#FFF1E3] text-[#6B5744]">
                {['Category', 'Count', 'Landed ₹', 'MRP ₹', 'Recoverable', 'Recovered', 'Outstanding'].map(h =>
                  <th key={h} className={`px-2 py-1.5 font-semibold ${h === 'Category' ? 'text-left' : 'text-right'}`}>{h}</th>)}
              </tr></thead>
              <tbody>
                {S.H.buckets.map(b => (
                  <tr key={b.category} className="border-t border-[#F0E4D6]">
                    <td className="px-2 py-1.5 text-[#2D1B0E]">{b.category}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{b.count}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(b.landed_value)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(b.mrp_value)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(b.recoverable)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(b.recovered)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{inr(b.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
      </Panel>

      {/* Dependency panel */}
      <div className="bg-[#FDFBF8] border border-[#E8D5C4] rounded-lg p-3.5">
        <div className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide mb-2 flex items-center gap-1.5">
          <HelpCircle className="w-3.5 h-3.5" /> Sibling-phase data status
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {data.dependencies.map(d => (
            <div key={d.phase} className="flex items-start gap-2 text-xs">
              <span className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${d.live ? 'bg-emerald-500' : 'bg-[#D9C4B0]'}`} />
              <span><span className="font-semibold text-[#2D1B0E]">{d.phase} · {d.label}</span> <span className="text-[#6B5744]">— {d.note}</span></span>
            </div>
          ))}
        </div>
      </div>

      <p className="text-[11px] text-[#B9A896]">Read-only summary · generated {new Date(data.generated_at).toLocaleString('en-IN')}</p>
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────────────────────── */
function H1({ subtitle }: { subtitle?: string }) {
  return (
    <div>
      <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
        <Scale className="w-6 h-6 text-[#af4408]" /> Liquor Reconciliation
      </h1>
      {subtitle && <p className="text-xs text-[#6B5744] mt-0.5">{subtitle}</p>}
    </div>
  );
}

function SectionTitle({ icon, title, onCsv }: { icon: React.ReactNode; title: string; onCsv: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">{icon} {title}</div>
      <button onClick={onCsv} className="px-2 py-1 text-[11px] text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 rounded-md flex items-center gap-1">
        <Download className="w-3 h-3" /> CSV
      </button>
    </div>
  );
}

function Panel({ icon, title, onCsv, pending, children }: {
  icon: React.ReactNode; title: string; onCsv: () => void; pending: Pending; children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-3.5">
      <SectionTitle icon={icon} title={title} onCsv={onCsv} />
      {pending && (
        <div className="mt-2 rounded-lg p-2.5 text-[11px] bg-amber-50 border border-amber-200 text-amber-900 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span><span className="font-semibold">Pending {pending.phase}:</span> {pending.reason}</span>
        </div>
      )}
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Stat({ label, value, tone = 'muted' }: { label: string; value: string; tone?: 'muted' | 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-red-700' : 'text-[#2D1B0E]';
  return (
    <div className="bg-[#FFF8F0] border border-[#F0E4D6] rounded-lg p-2.5">
      <div className="text-[10px] text-[#8B7355] font-medium leading-tight">{label}</div>
      <div className={`mt-0.5 text-base font-bold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function CheckCard({ c }: { c: Check }) {
  const map = {
    pass: { icon: <CheckCircle2 className="w-4 h-4" />, cls: 'bg-emerald-50 border-emerald-200 text-emerald-800' },
    fail: { icon: <XCircle className="w-4 h-4" />, cls: 'bg-red-50 border-red-200 text-red-800' },
    warn: { icon: <AlertTriangle className="w-4 h-4" />, cls: 'bg-amber-50 border-amber-200 text-amber-900' },
    no_data: { icon: <HelpCircle className="w-4 h-4" />, cls: 'bg-[#FDFBF8] border-[#E8D5C4] text-[#8B7355]' },
  }[c.state];
  return (
    <div className={`rounded-xl border p-3 ${map.cls}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">{map.icon} Check {c.key}</div>
      <div className="mt-1 text-sm font-semibold">{c.label}</div>
      <div className="text-[11px] mt-0.5 opacity-90">{c.detail}</div>
      {/* Checks C and D carry a `computed` and nothing else — the bank-unconfirmed
          total and the retail excess are the whole point of those cards, and
          gating the line on observed/difference hid them. */}
      {c.state !== 'no_data' && (c.computed != null || c.observed != null || c.difference != null) && (
        <div className="mt-1.5 text-[11px] tabular-nums">
          {c.computed != null && <span>{c.observed != null ? 'computed ' : ''}{inr(c.computed)}</span>}
          {c.observed != null && <span> · portal {inr(c.observed)}</span>}
          {c.difference != null && <span> · Δ {inr(c.difference)}</span>}
        </div>
      )}
    </div>
  );
}

function Scroll({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto border border-[#F0E4D6] rounded-lg">{children}</div>;
}
