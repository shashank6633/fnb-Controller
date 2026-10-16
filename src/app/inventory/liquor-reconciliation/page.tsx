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
 *
 * VALUE AT (owner decision 1): a Recorded | Landed switch beside the dates.
 * The report opens on its default (the server's setting — recorded unless an
 * admin changed it); the switch overrides it for this view only and is never
 * stored; an admin can make the basis on screen the default (PUT, audited).
 * §C/§D/§F/§H render ONE basis per card and print the server's own sentence
 * naming it — on the recorded basis the server has nulled every landed figure,
 * so nothing here can lead with one.
 *
 * VENDOR NAME REVIEW (owner decision 3): near-duplicate vendor names listed as
 * flags — nothing is merged or changed from here.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import { canAccessPage, type CatalogUser } from '@/lib/page-catalog';
import { api } from '@/lib/api';
import {
  Scale, Loader2, AlertCircle, Download, CalendarDays, Wallet, TrendingUp,
  Beer, Percent, Store, ArrowRightLeft, PackageX, Landmark, CheckCircle2,
  XCircle, AlertTriangle, HelpCircle, IndianRupee, ArrowRight, Users,
} from 'lucide-react';

/* ── Types mirror the /api/liquor/reconciliation payload ─────────────────────── */
type Pending = { phase: string; reason: string } | null;
interface Check {
  key: string; label: string; state: 'pass' | 'fail' | 'warn' | 'no_data';
  detail: string; computed: number | null; observed: number | null; difference: number | null;
}
/** Owner decision 1: what §C/§D/§F/§H are valued at. 'recorded' is the default;
 *  every landed-only figure is null on it (the server nulls them, not this page). */
type ValueBasis = 'recorded' | 'landed';
interface Bucket { key: string; lines: number; bottles: number; cases: number; invoiceValue: number; levies: number;
  /** null on the recorded basis. */
  landedValue: number | null; uplift: number | null; }
interface IndentRow { invoice_ref: string; date: string; supplier: string; lines: number; invoice_value: number; mrp_rounding: number; excise_turnover_tax: number; special_excise_cess: number; tcs: number; net_indent_value: number; has_charges: boolean; partial_in_range: boolean; }
interface RetailRow { id: string; date: string; shop_name: string; bottles: number; rate_paid_per_bottle: number;
  /** The four depot figures are null for a non-admin (they re-derive the TGBCL master — liquor-summary.ts LqSectionE). */
  depot_landed_per_bottle: number | null; excess_per_bottle: number | null; excess_total: number | null; excess_pct: number | null;
  priced?: boolean; paid_by: string; reimbursement_status: string; reason: string; }
interface RateRow { ledgerId: string; invoiceRef: string; inwardDate: string; materialName: string; category: string; bottles: number; indentRate: number; masterRate: number | null; variance: number | null; varianceValue: number | null; proposedRatePerCase: number | null; mapReason: string;
  /** Which way the indent moved against the master — all a non-admin is told (the master-derived figures are null for them). */
  direction?: 'above_master' | 'below_master'; }
interface WdBucket { category: string; count: number;
  /** Recorded basis: qty × the store's recorded average cost on the withdrawal's date. */
  recorded_value: number; recorded_unpriced: number;
  /** null on the recorded basis, and for a non-admin on either basis (liquor-summary.ts LqSectionH). */
  landed_value: number | null; mrp_value: number;
  /** null for a non-admin when the bucket holds a withdrawal recovered AT LANDED
   *  COST — that recoverable IS its frozen landed value (the admin-only master
   *  for a brand never indented). Withheld whole, never shrunk. */
  recoverable: number | null; recovered: number | null; outstanding: number | null;
  /** How many landed-cost recoveries in this bucket are withheld from this viewer (0 for an admin). */
  landed_recovery_withheld?: number; }
/** §F — the card's total and share are ONE basis (owner decision 1). */
interface SectionF { value_basis: ValueBasis; depot_net_indent: number; retail_spend: number; depot_recorded_value: number;
  total_recorded: number; total_landed: number | null; total: number; retail_share_pct: number | null;
  retail_share_pct_of_total: number | null; share_pct: number | null; retail_share_basis: string; pending: Pending; }
/** §H — the card's value and % are ONE basis (owner decision 1). */
interface SectionH { value_basis: ValueBasis; buckets: WdBucket[]; total_recorded_value: number; recorded_unpriced_count: number;
  total_landed_value: number | null;
  /** null only for a non-admin on the LANDED basis (landed values are admin-only). */
  total_value: number | null;
  /** null for a non-admin when any withdrawal in range is recovered at landed cost. */
  total_outstanding: number | null;
  /** What is still owed on withdrawals recovered at MRP or a typed amount — shown to everyone. */
  total_outstanding_shown?: number;
  landed_recovery_withheld_count?: number;
  /** false → every landed-derived figure is null for this viewer, and landed_figures_note says why. */
  landed_figures_visible?: boolean; landed_figures_note?: string | null;
  purchases_value: number;
  pct_of_purchases: number | null; pct_of_net_indent: number | null; pct: number | null; pct_basis: string; pending: Pending; }
/** Owner decision 3 — near-duplicate vendor names, FLAGS ONLY. */
interface VendorRef { name: string; source: 'vendor' | 'purchase' | 'store_bill' | 'wine_shop'; vendor_id: string | null; is_active: boolean | null; uses: number; }
interface VendorReview { pairs: Array<{ distance: number; kind: 'same_name_two_ids' | 'case_or_spacing' | 'near_spelling'; a: VendorRef; b: VendorRef }>;
  pairs_total: number; max_distance: number; scanned: { vendors: number; free_text_spellings: number }; note: string; }
interface Summary {
  store: { id: string; name: string };
  range: { from: string; to: string };
  generated_at: string;
  sections: {
    A: any; A2: any; B: { indents: IndentRow[]; totals: any; pending: Pending };
    C: { buckets: Bucket[]; beer: Bucket; spirits: any; unmapped: Bucket; mappedLines: number; totalLines: number;
      value_basis: ValueBasis; basis_note: string; pending: Pending };
    D: any; E: { rows: RetailRow[]; bottles: number; spend: number;
      /** null when the depot figures are withheld (non-admin). */
      depot_equivalent: number | null; excess_total: number | null;
      unreimbursed_staff_spend: number; unknown_depot_count: number; unknown_depot_bottles: number; reopened_claim_count: number;
      depot_figures_visible?: boolean; depot_figures_note?: string | null; pending: Pending };
    F: SectionF; G: { rows: RateRow[]; moved_lines: number; scanned_lines: number; unmapped_lines: number;
      /** null when the master rates are withheld (non-admin). */
      total_variance_value: number | null;
      /** false → masterRate / variance / varianceValue are null on every row (TGBCL master is admin-only). */
      master_rates_visible?: boolean; master_rates_note?: string | null; pending: Pending };
    H: SectionH;
  };
  basis: {
    bill_invoice_value: number; line_invoice_value: number; difference: number; diverges: boolean;
    straddling_indents: string[]; unattributed_lines: number; unattributed_value: number; note: string;
  };
  checks: Check[];
  dependencies: Array<{ phase: string; label: string; live: boolean; note: string }>;
  stores: Array<{ id: string; name: string }>;
  value_basis: { active: ValueBasis; default_basis: ValueBasis; overridden: boolean; note: string };
  vendor_review: VendorReview | null;
}

/* ── format helpers ──────────────────────────────────────────────────────────── */
const inr = (v: number | null | undefined, dp = 0) =>
  v == null ? '—' : '₹' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const n2 = (v: number | null | undefined, dp = 2) =>
  v == null ? '—' : (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: dp });
const pct = (v: number | null | undefined) => v == null ? '—' : `${(Number(v) || 0).toFixed(1)}%`;
const todayStr = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const firstOfMonth = () => todayStr().slice(0, 7) + '-01';
/** §E shows the claim in words, not the stored token (claimed_pending …). */
const REIMB_LABEL: Record<string, string> = {
  not_required: 'Not required', claimed_pending: 'Claimed — pending',
  reimbursed: 'Reimbursed', rejected: 'Rejected',
};

/* WHERE A FIGURE ON THIS PAGE IS ACTED ON. This page writes nothing, so the two
   sections that report something a person must DO link to the screen that does
   it — shown only to a viewer canAccessPage() lets open, the same authority the
   sidebar and the proxy use, so a link is never a bounce:
     §E → Liquor Store · Wine-shop buys (?tab=retail): pay a pending claim back
          from petty cash, price a buy recorded with the depot rate unknown.
          Also needs view access on the store (see storeView below).
     §G → Liquor Brand Map · Rate Movement (?tab=movement): the drift card with
          the one-tap, audited "accept new rate into master" (owner decision 2).
          The Brand Map is admin-only, so a manager is told who can act instead
          of being handed a link that 403s. */
const RETAIL_HREF = '/inventory/liquor-store?tab=retail';
const VENDOR_SOURCE_LABEL: Record<VendorRef['source'], string> = {
  vendor: 'Vendor master', purchase: 'Typed on a purchase', store_bill: 'Typed on a store bill', wine_shop: 'Wine-shop name',
};
const VENDOR_KIND_LABEL: Record<VendorReview['pairs'][number]['kind'], string> = {
  same_name_two_ids: 'same name, two ids', case_or_spacing: 'case / spacing only', near_spelling: 'near spelling',
};
const MOVEMENT_HREF = '/inventory/liquor-brand-map?tab=movement';

/* ── page ────────────────────────────────────────────────────────────────────── */
export default function LiquorReconciliationPage() {
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(todayStr);
  const [storeId, setStoreId] = useState<string>('');
  const [planned, setPlanned] = useState<string>('');
  // Owner decision 1: '' = the report's default basis (the server's setting);
  // otherwise this view's override. Never stored — a fresh visit is the default.
  const [valueAt, setValueAt] = useState<'' | ValueBasis>('');
  const [savingDefault, setSavingDefault] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // The viewer, for the two "act on this" links only — never for a figure.
  // Null until /api/auth/me answers (and on any failure): no link is offered.
  const [me, setMe] = useState<CatalogUser | null>(null);
  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(r => r.json()).then(d => setMe(d?.user || null)).catch(() => setMe(null));
  }, []);
  /* The Liquor Store page shows NOTHING but a 🔒 to someone without can_view
     on the store (its own early return), whatever their page map says — a
     plain manager with no store grant is exactly that. So the §E link also
     needs view access on this report's store, read from the same
     /api/stores/[id]/my-access the Liquor Store page boots from. */
  const [storeView, setStoreView] = useState<boolean | null>(null);
  const reportStoreId = data?.store?.id || '';
  useEffect(() => {
    if (!reportStoreId) return;
    let alive = true;
    fetch(`/api/stores/${encodeURIComponent(reportStoreId)}/my-access`, { credentials: 'same-origin' })
      .then(r => r.json()).then(j => { if (alive) setStoreView(!!j?.access?.can_view); })
      .catch(() => { if (alive) setStoreView(false); });
    return () => { alive = false; };
  }, [reportStoreId]);
  const canRetail = canAccessPage('/inventory/liquor-store', me) && storeView === true;
  const canMovement = canAccessPage('/inventory/liquor-brand-map', me);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ from, to });
    if (storeId) p.set('store_id', storeId);
    if (planned.trim() !== '' && Number.isFinite(Number(planned))) p.set('planned_indent', String(Number(planned)));
    if (valueAt) p.set('value_at', valueAt);
    return p.toString();
  }, [from, to, storeId, planned, valueAt]);

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
  }, [qs, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const downloadCsv = useCallback(async (section: string) => {
    try {
      const p = new URLSearchParams({ from, to, section, format: 'csv' });
      if (storeId) p.set('store_id', storeId);
      if (planned.trim() !== '' && Number.isFinite(Number(planned))) p.set('planned_indent', String(Number(planned)));
      // The file is valued at the basis the screen shows, whatever the default.
      const shown = data?.value_basis?.active;
      if (valueAt || shown) p.set('value_at', valueAt || shown || 'recorded');
      const res = await fetch(`/api/liquor/reconciliation?${p.toString()}`, { credentials: 'same-origin' });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j?.error || `HTTP ${res.status}`); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `liquor-recon_${section}_${from}_to_${to}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } catch (e) { alert((e as Error)?.message || 'CSV export failed'); }
  }, [from, to, storeId, planned, valueAt, data?.value_basis?.active]);

  /** Admin: make the basis on screen the report's default (audited server-side). */
  const makeDefault = useCallback(async (basis: ValueBasis) => {
    setSavingDefault(true);
    try {
      const res = await api('/api/liquor/reconciliation', { method: 'PUT', body: { value_basis: basis } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setValueAt('');            // follow the (new) default
      setReloadKey(k => k + 1);
    } catch (e) { alert((e as Error)?.message || 'Could not change the default basis'); }
    finally { setSavingDefault(false); }
  }, []);

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
  // Owner decision 1. An older payload with no value_basis is read as recorded.
  const vb: ValueBasis = data.value_basis?.active === 'landed' ? 'landed' : 'recorded';
  const isLanded = vb === 'landed';
  const isAdmin = me?.role === 'admin';
  /* §G: the server withheld the master-derived figures from this viewer (the
     TGBCL master is admin-only — liquor-summary.ts LqSectionG). Read off the
     payload, never off `me`: the server decides, the page only labels it. */
  const gWithheld = S.G.master_rates_visible === false;
  /* §H: the same switch for the withdrawals' frozen LANDED values, and for every
     recoverable that is one (liquor-summary.ts LqSectionH). Read off the
     payload too. A server that predates the field sends no flag and nothing
     null, so this stays false and the card renders exactly as before. */
  const hWithheld = S.H.landed_figures_visible === false;
  const hOutstandingHeld = S.H.total_outstanding == null;
  const hHeldCount = S.H.landed_recovery_withheld_count ?? 0;

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
        {/* OWNER DECISION 1 — Value at: RECORDED (the default) or LANDED (opt-in).
            Changes this report only; nothing is revalued. */}
        <div className="flex flex-col text-[11px] text-[#8B7355] font-medium">Value at
          <div className="mt-0.5 inline-flex rounded-lg border border-[#E8D5C4] overflow-hidden bg-white" role="group" aria-label="Value at">
            {(['recorded', 'landed'] as const).map(b => (
              <button key={b} type="button" onClick={() => setValueAt(b === data.value_basis?.default_basis ? '' : b)}
                      aria-pressed={vb === b}
                      className={`px-3 py-2 text-sm ${vb === b ? 'bg-[#af4408] text-white font-semibold' : 'text-[#2D1B0E] hover:bg-[#FFF1E3]'}`}>
                {b === 'recorded' ? 'Recorded' : 'Landed'}
                {data.value_basis?.default_basis === b && <span className={`ml-1 text-[10px] ${vb === b ? 'text-white/80' : 'text-[#B9A896]'}`}>(default)</span>}
              </button>
            ))}
          </div>
        </div>
        {loading && <Loader2 className="w-4 h-4 animate-spin text-[#8B7355] mb-2.5" />}
      </div>
      <div className={`rounded-lg p-2.5 text-[11px] border flex flex-wrap items-center gap-x-3 gap-y-1 ${isLanded ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-[#FDFBF8] border-[#E8D5C4] text-[#6B5744]'}`}>
        <span className="flex-1 min-w-[240px]">{data.value_basis?.note}</span>
        {isAdmin && data.value_basis?.overridden && (
          <button type="button" disabled={savingDefault} onClick={() => makeDefault(vb)}
                  className="px-2 py-1 rounded-md border border-[#af4408]/40 text-[#af4408] hover:bg-[#af4408]/10 disabled:opacity-50">
            {savingDefault ? 'Saving…' : `Make ${vb} the default`}
          </button>
        )}
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
                {(isLanded ? ['Type', 'Lines', 'Bottles', 'Cases', 'Invoice ₹', 'Landed ₹', 'Uplift'] : ['Type', 'Lines', 'Bottles', 'Cases', 'Invoice ₹']).map(h =>
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
                    {isLanded && <td className="px-2 py-1.5 text-right tabular-nums">{inr(b.landedValue)}</td>}
                    {isLanded && <td className="px-2 py-1.5 text-right tabular-nums">{b.uplift == null ? '—' : `${b.uplift.toFixed(3)}×`}</td>}
                  </tr>
                ))}
                <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF8F0] font-semibold text-[#2D1B0E]">
                  <td className="px-2 py-1.5">Spirits (IML+DP)</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{S.C.spirits.lines}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{n2(S.C.spirits.bottles)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{n2(S.C.spirits.cases)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{inr(S.C.spirits.invoiceValue)}</td>
                  {isLanded && <td className="px-2 py-1.5 text-right tabular-nums">{inr(S.C.spirits.landedValue)}</td>}
                  {isLanded && <td className="px-2 py-1.5" />}
                </tr>
              </tbody>
            </table>
          </Scroll>
          <p className="text-[11px] text-[#B9A896] mt-2">
            {S.C.mappedLines}/{S.C.totalLines} lines mapped to a TGBCL brand. Cases count case-packed lines only
            {S.D.loose_bottles > 0 && <> — {n2(S.D.loose_bottles)} bottle(s) were bought loose and appear under Bottles alone</>}.
          </p>
          {S.C.basis_note && <p className="text-[11px] text-[#8B7355] mt-1">{S.C.basis_note}</p>}
        </Panel>

        <Panel icon={<Percent className="w-4 h-4" />} title="D · Derived factors (computed, not assumed)" onCsv={() => downloadCsv('D')} pending={S.D.pending}>
          <div className="grid grid-cols-2 gap-2.5">
            {isLanded
              ? <Stat label="Uplift overall (landed ÷ invoice)" value={S.D.uplift_overall == null ? '—' : `${S.D.uplift_overall.toFixed(3)}×`} />
              : <Stat label="Avg recorded / bottle (rate paid)" value={inr(S.D.avg_recorded_per_bottle, 2)} />}
            <Stat label="Effective TCS" value={pct(S.D.effective_tcs_pct)} />
            <Stat label="Cess / case (case-packed)" value={inr(S.D.cess_per_case, 2)} />
            <Stat label="MRP rounding / bottle" value={inr(S.D.mrp_rounding_per_bottle, 2)} />
            {isLanded
              ? <Stat label="Avg landed / bottle" value={inr(S.D.avg_landed_per_bottle, 2)} />
              : <Stat label="Levies total (recorded only)" value={inr(S.D.levies_total)} />}
            <Stat label="Cess / bottle" value={inr(S.D.cess_per_bottle, 2)} />
          </div>
          {isLanded && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {S.D.uplift_by_type.map((u: any) => (
                <span key={u.key} className="px-2 py-1 rounded-full text-[11px] bg-[#FFF1E3] border border-[#E8D5C4] text-[#6B5744]">
                  {u.key}: {u.uplift == null ? '—' : `${u.uplift.toFixed(3)}×`}
                </span>
              ))}
            </div>
          )}
          {S.D.basis_note && <p className="text-[11px] text-[#8B7355] mt-2">{S.D.basis_note}</p>}
        </Panel>
      </div>

      {/* §E retail + §F total */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Panel icon={<TrendingUp className="w-4 h-4" />} title="E · Emergency wine-shop purchases" onCsv={() => downloadCsv('E')} pending={S.E.pending}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-3">
              <Stat label="Bottles" value={n2(S.E.bottles)} />
              <Stat label="Retail spend" value={inr(S.E.spend)} />
              <Stat label="Excess (price of running out)" value={S.E.excess_total == null ? 'Admin-only' : inr(S.E.excess_total)}
                    tone={S.E.excess_total == null ? 'muted' : (S.E.excess_total > 0 ? 'warn' : 'good')} />
              <Stat label="Unreimbursed staff" value={inr(S.E.unreimbursed_staff_spend)} tone={S.E.unreimbursed_staff_spend > 0 ? 'warn' : 'muted'} />
            </div>
            {canRetail && (S.E.unreimbursed_staff_spend > 0 || S.E.unknown_depot_count > 0) && (
              <ActLink href={RETAIL_HREF}
                       text={S.E.unreimbursed_staff_spend > 0
                         ? 'Pay a claim back or price an unpriced buy — Liquor Store · Wine-shop buys'
                         : 'Price the unpriced buys — Liquor Store · Wine-shop buys'} />
            )}
            {S.E.depot_figures_note && (
              <p className="text-[11px] text-[#8B7355] mb-2">{S.E.depot_figures_note}</p>
            )}
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
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.depot_landed_per_bottle == null
                          ? <span className="text-[#8B7355]">{r.priced === false ? 'unknown' : 'admin-only'}</span>
                          : inr(r.depot_landed_per_bottle, 2)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-amber-700">{r.excess_total == null
                          ? (r.priced === false
                            ? <span className="text-[#8B7355]" title="No depot rate on record — the excess was not computed">—</span>
                            : <AdminOnly title="The excess re-derives the admin-only TGBCL master rate" />)
                          : inr(r.excess_total)}</td>
                        <td className="px-2 py-1.5 text-[#6B5744]">{REIMB_LABEL[r.reimbursement_status] || r.reimbursement_status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </Panel>
        </div>
        <Panel icon={<IndianRupee className="w-4 h-4" />} title="F · Total liquor cost" onCsv={() => downloadCsv('F')} pending={S.F.pending}>
          {/* ONE BASIS PER CARD (owner decision 1): the total and the share
              beside it share a denominator, and the sentence below names it. */}
          <div className="space-y-2.5">
            {isLanded
              ? <Stat label="Depot net indent (invoice + TGBCL levies)" value={inr(S.F.depot_net_indent)} />
              : <Stat label="Depot purchases (recorded, rate paid)" value={inr(S.F.depot_recorded_value)} />}
            <Stat label="Retail spend" value={inr(S.F.retail_spend)} />
            <Stat label={isLanded ? 'Total (landed)' : 'Total (recorded)'} value={inr(S.F.total)} tone="good" />
            <Stat label={isLanded ? 'Retail share of the landed total' : 'Retail share of the recorded total'} value={pct(S.F.share_pct)} />
          </div>
          {S.F.retail_share_basis && <p className="text-[11px] text-[#8B7355] mt-2">{S.F.retail_share_basis}</p>}
        </Panel>
      </div>

      {/* §G rate movement */}
      <Panel icon={<ArrowRightLeft className="w-4 h-4" />} title="G · Rate-movement watch" onCsv={() => downloadCsv('G')} pending={S.G.pending}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-3">
          <Stat label="Lines moved" value={n2(S.G.moved_lines, 0)} tone={S.G.moved_lines > 0 ? 'warn' : 'good'} />
          <Stat label="Lines scanned" value={n2(S.G.scanned_lines, 0)} />
          <Stat label="Unmapped" value={n2(S.G.unmapped_lines, 0)} />
          {/* Withheld ≠ zero ≠ unknown: a manager is told the figure exists and
              who may see it, not shown a bare "—" that reads as "no data". */}
          <Stat label="Total variance value"
                value={gWithheld ? 'admin-only' : inr(S.G.total_variance_value)} />
        </div>
        {/* The server withholds the master-derived figures from a non-admin
            (the TGBCL master is admin-only) and says so in its own sentence. */}
        {S.G.master_rates_note
          ? <p className="text-[11px] text-[#8B7355] mb-2">{S.G.master_rates_note}</p>
          : gWithheld && (
            /* A server that withholds but sends no sentence: the cells still say why. */
            <p className="text-[11px] text-[#8B7355] mb-2">
              Master rate, Variance and Value read “admin-only”: the TGBCL master rate is admin-only, and each of those
              figures gives it back. The arrow says which way the indent moved.
            </p>
          )}
        {S.G.moved_lines > 0 && (canMovement
          ? <ActLink href={MOVEMENT_HREF} text="Review each drift and accept a new rate into the master — Liquor Brand Map · Rate Movement" />
          : (
            <p className="text-[11px] text-[#8B7355] mb-2">
              Accepting a moved rate into the TGBCL master is an admin action — ask an admin to review these
              lines on Liquor Brand Map · Rate Movement.
            </p>
          ))}
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
                    <td className="px-2 py-1.5 text-right tabular-nums">{gWithheld && r.masterRate == null
                      ? <AdminOnly title="TGBCL master rates are admin-only" />
                      : inr(r.masterRate, 2)}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${(r.variance != null ? r.variance > 0 : r.direction === 'above_master') ? 'text-red-700' : 'text-emerald-700'}`}>
                      {r.variance != null ? inr(r.variance, 2)
                        : r.direction === 'above_master' ? '↑ above master'
                          : r.direction === 'below_master' ? '↓ below master' : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{gWithheld && r.varianceValue == null
                      ? <AdminOnly title="Derived from the admin-only TGBCL master rate" />
                      : inr(r.varianceValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
      </Panel>

      {/* §H withdrawals */}
      <Panel icon={<PackageX className="w-4 h-4" />} title="H · Non-sale issues (withdrawals)" onCsv={() => downloadCsv('H')} pending={S.H.pending}>
        {/* ONE BASIS PER CARD (owner decision 1): value and % on the same basis. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mb-3">
          <Stat label={isLanded ? 'Total landed value (frozen at issue)' : 'Total value (recorded store cost)'}
                value={hWithheld && S.H.total_value == null ? 'admin-only' : inr(S.H.total_value)} />
          <Stat label={isLanded ? '% of Net Indent (landed ÷ landed)' : '% of purchases (recorded ÷ recorded)'}
                value={hWithheld && S.H.pct == null && isLanded ? 'admin-only' : pct(S.H.pct)} />
          {/* A withheld total is not a smaller total: when any recovery in range
              is at landed cost, a non-admin sees what is owed on the rest, and
              how many recoveries are held back — never a sum read as the whole debt. */}
          {hOutstandingHeld
            ? <Stat label={`Outstanding — MRP / typed recoveries only${hHeldCount > 0 ? ` (+ ${hHeldCount} at landed cost, admin-only)` : ''}`}
                    value={inr(S.H.total_outstanding_shown ?? null)} tone={(S.H.total_outstanding_shown ?? 0) > 0 || hHeldCount > 0 ? 'warn' : 'muted'} />
            : <Stat label="Outstanding recoverable" value={inr(S.H.total_outstanding)} tone={(S.H.total_outstanding ?? 0) > 0 ? 'warn' : 'muted'} />}
        </div>
        {S.H.pct_basis && <p className="text-[11px] text-[#8B7355] mb-2">{S.H.pct_basis}</p>}
        {/* The server's own sentence when the landed figures are withheld from
            this viewer — printed once: the server may already end pct_basis
            with it (liquor-summary.ts), and then it is not repeated. */}
        {S.H.landed_figures_note && !(S.H.pct_basis || '').includes(S.H.landed_figures_note) && (
          <p className="text-[11px] text-[#8B7355] mb-2">{S.H.landed_figures_note}</p>
        )}
        {S.H.buckets.length > 0 && (
          <Scroll>
            <table className="w-full text-xs border-collapse">
              <thead><tr className="bg-[#FFF1E3] text-[#6B5744]">
                {['Category', 'Count', isLanded ? 'Landed ₹' : 'Recorded ₹', 'MRP ₹', 'Recoverable', 'Recovered', 'Outstanding'].map(h =>
                  <th key={h} className={`px-2 py-1.5 font-semibold ${h === 'Category' ? 'text-left' : 'text-right'}`}>{h}</th>)}
              </tr></thead>
              <tbody>
                {S.H.buckets.map(b => (
                  <tr key={b.category} className="border-t border-[#F0E4D6]">
                    <td className="px-2 py-1.5 text-[#2D1B0E]">{b.category}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{b.count}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {isLanded
                        ? (hWithheld && b.landed_value == null
                          ? <AdminOnly title="The frozen landed value is admin-only — for a brand never indented it IS the TGBCL master per bottle" />
                          : inr(b.landed_value))
                        : inr(b.recorded_value)}
                      {!isLanded && b.recorded_unpriced > 0 && <span className="block text-[10px] text-amber-700">{b.recorded_unpriced} not priced</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(b.mrp_value)}</td>
                    {([b.recoverable, b.recovered, b.outstanding] as const).map((v, k) => (
                      <td key={k} className={`px-2 py-1.5 text-right tabular-nums ${k === 2 ? 'font-semibold' : ''}`}>
                        {v == null
                          ? <AdminOnly title={`Holds ${b.landed_recovery_withheld || 'a'} withdrawal(s) recovered at landed cost — that recoverable IS the frozen landed value, which is admin-only`} />
                          : inr(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
      </Panel>

      {/* OWNER DECISION 3 — near-duplicate vendor names: a review FLAG, never a merge. */}
      <Panel icon={<Users className="w-4 h-4" />} title="Vendor name review — near-duplicate names (flag only)" onCsv={() => downloadCsv('vendors')} pending={null}>
        {!data.vendor_review
          ? <p className="text-[11px] text-[#8B7355]">The vendor review could not be read on this database.</p>
          : (
            <>
              <p className={`text-[11px] mb-2 ${data.vendor_review.pairs_total > 0 ? 'text-amber-800' : 'text-[#6B5744]'}`}>
                {data.vendor_review.note} Scanned {data.vendor_review.scanned.vendors} vendor(s) and {data.vendor_review.scanned.free_text_spellings} other spelling(s); not bounded by the date range.
              </p>
              {data.vendor_review.pairs.length > 0 && (
                <Scroll>
                  <table className="w-full text-xs border-collapse">
                    <thead><tr className="bg-[#FFF1E3] text-[#6B5744]">
                      {['Differ by', 'Name A', 'Name B', 'Kind'].map(h =>
                        <th key={h} className={`px-2 py-1.5 font-semibold ${h === 'Differ by' ? 'text-right' : 'text-left'}`}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {data.vendor_review.pairs.map((p, i) => (
                        <tr key={i} className="border-t border-[#F0E4D6] align-top">
                          <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-amber-800">{p.distance} char{p.distance === 1 ? '' : 's'}</td>
                          {[p.a, p.b].map((v, j) => (
                            <td key={j} className="px-2 py-1.5 text-[#2D1B0E]">
                              {v.name}
                              <span className="block text-[10px] text-[#8B7355]">
                                {VENDOR_SOURCE_LABEL[v.source]}{v.vendor_id ? ` · id ${v.vendor_id.slice(0, 8)}` : ''}
                                {v.is_active === false ? ' · inactive' : ''} · {v.uses} use{v.uses === 1 ? '' : 's'}
                              </span>
                            </td>
                          ))}
                          <td className="px-2 py-1.5 text-[#6B5744]">{VENDOR_KIND_LABEL[p.kind]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroll>
              )}
            </>
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

/** A figure the server withheld from this viewer — said as such, never as a bare
 *  "—" (which reads as "no data") or ₹0. The tooltip says why. */
function AdminOnly({ title }: { title: string }) {
  return <span className="text-[#8B7355]" title={title} data-admin-only="1">admin-only</span>;
}

function ActLink({ href, text }: { href: string; text: string }) {
  return (
    <div className="mb-2">
      <Link href={href} className="inline-flex items-start gap-1.5 text-[12px] font-medium text-[#af4408] hover:underline">
        <span>{text}</span> <ArrowRight className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      </Link>
    </div>
  );
}

function Scroll({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto border border-[#F0E4D6] rounded-lg">{children}</div>;
}
