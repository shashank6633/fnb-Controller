'use client';

/**
 * TGBCL PORTAL WALLET — phase L2 of the Liquor Purchase Reconciliation module.
 * Plan: docs/liquor-reconciliation-plan.md § "Phase L2". API: /api/liquor/wallet.
 *
 * The workbook's Portal Wallet sheet, live: the ledger with a running balance,
 * Summary check A (computed vs what the portal shows), the reading Summary
 * check B needs (one indent's value on the portal vs its recorded Net Indent —
 * POST /api/liquor/wallet/portal-check with kind 'indent_value') and Summary
 * §A2 (the top-up planner).
 *
 * FOUR THINGS THIS PAGE REFUSES TO DO
 *   1. Show a stored balance. There is no balance column in lq_wallet_txns and
 *      none may be added — every figure here is SUM(amount) recomputed on the
 *      server for this request. A stored balance drifts the moment one
 *      back-dated deposit lands.
 *   2. Compute a running balance over the FILTERED rows. The running-balance
 *      column is always the true wallet, whatever date window is on screen —
 *      the window's own opening line is printed above the table so the two
 *      cannot be confused.
 *   3. Clamp a negative balance. An overdrawn TGBCL wallet is a real state (a
 *      debit landing before the challan clears). It is shown in red and named,
 *      never rounded up to a comfortable zero.
 *   4. Let the portal figure the owner types touch the balance. It is an
 *      OBSERVATION and is written to lq_portal_checks; the balance it is
 *      compared against is computed from the ledger alone. Storing it as a
 *      movement would corrupt the very number the check exists to test.
 *
 * INDENT DEBITS ARE NOT ENTERED HERE. They are created automatically from a
 * recorded indent's Net Indent, inside that indent's own transaction, so the
 * wallet cannot disagree with the indents. The form offers opening / deposit /
 * adjustment; auto rows are marked and read-only.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Wallet, RefreshCw, Download, Plus, X, AlertTriangle, Loader2, Info,
  ShieldAlert, Landmark, Calculator, ScrollText, CheckCircle2, Settings2,
} from 'lucide-react';
import { api } from '@/lib/api';

/* ── types mirroring /api/liquor/wallet ───────────────────────────────────── */
interface Row {
  id: string;
  date: string;
  type: 'opening' | 'deposit' | 'indent_debit' | 'adjustment';
  reference: string;
  amount: number;
  payment_mode: string;
  bank_debit_date: string;
  bank_amount: number;
  bank_match: 'pending' | 'verified';
  portal_status: string;
  source_ref: string;
  remarks: string;
  created_by: string;
  created_at: string;
  running_balance: number;
  auto: boolean;
  anomaly: string | null;
}
interface Summary {
  balance: number;
  overdrawn: boolean;
  working_capital_parked: number;
  funded_in: number;
  utilised_out: number;
  adjustment_in: number;
  adjustment_out: number;
  future_dated_count: number;
  future_dated_total: number;
  deposits_utilised_pct: number | null;
  opening_total: number;
  deposit_total: number;
  indent_debit_total: number;
  adjustment_net: number;
  bank_unconfirmed_count: number;
  bank_unconfirmed_total: number;
  row_count: number;
}
interface TopUp {
  planned_indent: number; balance: number; shortfall: number; step: number;
  recommended_challan: number; rounding_add: number; balance_after: number; surplus: number;
  planned_invalid: boolean;
}
interface PortalCheck {
  id: string; as_of_date: string; portal_amount: number; computed_balance: number;
  difference: number; difference_direction: string; matched: boolean; source: string;
  note: string; observed_by: string; replaced_amount?: number | null;
}
/** Summary check B's input — ONE indent's value as the portal shows it
 *  (GET/POST /api/liquor/wallet/portal-check, kind 'indent_value'). Mirrors
 *  IndentPortalCheckResult in src/lib/liquor-wallet.ts. */
interface IndentCheck {
  id: string; as_of_date: string; reference: string; portal_amount: number;
  /** The recorded indent compared against; null when no recorded bill carries the number yet. */
  matched_invoice_ref: string | null; store: string | null;
  net_indent_value: number | null;
  /** portal − recorded Net Indent; null when there is nothing on record to compare. */
  difference: number | null; difference_direction: string;
  /** null = no recorded indent to compare against (not a pass, not a fail). */
  matched: boolean | null;
  warning: string | null; register_ref: string | null;
  source: string; note: string; observed_by: string; replaced_amount?: number | null;
}
interface Integrity {
  missing: Array<{ source_ref: string; invoice_ref: string; date: string; net_indent_value: number; store: string; failure?: string | null }>;
  mismatched: Array<{ id: string; reference: string; debit: number; net_indent_value: number; diff: number; hand_entered?: boolean }>;
  orphaned: Array<{ id: string; reference: string; amount: number }>;
  non_positive: Array<{ invoice_ref: string; date: string; net_indent_value: number }>;
  undebited: Array<{ invoice_ref: string; store: string; date: string; recorded_value: number }>;
  foreign_store: Array<{ id: string; reference: string; amount: number; store: string }>;
}
interface WalletData {
  today: string;
  range: { from: string; to: string };
  opening_balance: number;
  closing_balance: number;
  rows: Row[];
  outside_window: number;
  summary: Summary;
  balance_as_of: { balance: number; lastTxnDate: string; depositTotal: number; debitTotal: number };
  top_up: TopUp;
  top_up_step: number;
  top_up_step_default: number;
  portal_checks: PortalCheck[];
  integrity: Integrity;
  types: Array<{ key: string; sign_rule: string }>;
  manual_types: string[];
}

/* ── formatting ───────────────────────────────────────────────────────────── */
const rs = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? '—'
    : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TYPE_LABEL: Record<string, string> = {
  opening: 'Opening balance',
  deposit: 'Challan deposit',
  indent_debit: 'Indent debit',
  adjustment: 'Adjustment',
};

export default function LiquorWalletPage() {
  const [data, setData] = useState<WalletData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [planned, setPlanned] = useState('');
  /* Check B's readings. The wallet GET carries only the balance readings
     (check A), so the per-indent ones are read from the portal-check route,
     which re-compares each against the indent's CURRENT Net Indent. A failure
     here is said on the panel; it never takes the wallet down. */
  const [indentChecks, setIndentChecks] = useState<IndentCheck[]>([]);
  const [indentChecksErr, setIndentChecksErr] = useState('');

  const load = useCallback(async (f?: string, t?: string, p?: string) => {
    setLoading(true); setErr('');
    try {
      const q = new URLSearchParams();
      if (f) q.set('from', f);
      if (t) q.set('to', t);
      if (p) q.set('planned', p);
      const [r, rc] = await Promise.all([
        fetch('/api/liquor/wallet' + (q.toString() ? '?' + q.toString() : ''), { credentials: 'same-origin' }),
        fetch('/api/liquor/wallet/portal-check', { credentials: 'same-origin' }).catch(() => null),
      ]);
      const j = await r.json();
      if (!r.ok) { setErr(j.error || `HTTP ${r.status}`); setData(null); return; }
      setData(j);
      if (!f) setFrom(j.range.from);
      if (!t) setTo(j.range.to);
      const jc = rc ? await rc.json().catch(() => null) : null;
      if (rc && rc.ok && jc && Array.isArray(jc.indent_checks)) {
        setIndentChecks(jc.indent_checks); setIndentChecksErr('');
      } else {
        setIndentChecks([]);
        setIndentChecksErr(jc?.error || (rc ? `HTTP ${rc.status}` : 'network error'));
      }
    } catch (e: any) {
      setErr(e?.message || 'Could not load the wallet.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const csvHref = useMemo(() => {
    const q = new URLSearchParams({ format: 'csv' });
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    return '/api/liquor/wallet?' + q.toString();
  }, [from, to]);

  const reload = () => load(from, to, planned);

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* ── Header ── */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-3">
              <Wallet className="w-8 h-8" />
              TGBCL Wallet
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Working capital parked with the excise department — challans in, indents out.
              The balance is <span className="font-medium text-[#6B5744]">computed from the ledger on every read</span>, never stored.
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={reload}
              className="flex items-center gap-2 px-3 py-2.5 border border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3] rounded-lg text-sm font-medium">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <a href={csvHref}
              className="flex items-center gap-2 px-4 py-2.5 border border-green-600 text-green-700 hover:bg-green-50 rounded-lg text-sm font-medium">
              <Download className="w-4 h-4" /> CSV
            </a>
          </div>
        </div>

        {err && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm flex items-start gap-2">
            <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" /> <span>{err}</span>
          </div>
        )}
        {notice && (
          <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl p-3 text-sm flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> <span>{notice}</span>
          </div>
        )}

        {loading && !data && (
          <div className="flex items-center gap-2 text-[#8B7355] text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading the wallet…</div>
        )}

        {data && (
          <>
            <Cards s={data.summary} />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <PortalCheckPanel data={data} onSaved={(m) => { setNotice(m); reload(); }} onError={setErr} />
              <TopUpPanel data={data} planned={planned} setPlanned={setPlanned}
                          onReload={(p) => load(from, to, p)} onStepSaved={(m) => { setNotice(m); reload(); }} onError={setErr} />
            </div>

            <IndentCheckPanel data={data} checks={indentChecks} checksError={indentChecksErr}
                              onSaved={(m) => { setNotice(m); reload(); }} onError={setErr} />

            <RecordPanel data={data} onSaved={(m) => { setNotice(m); reload(); }} onError={setErr} />

            <IntegrityPanel integrity={data.integrity}
                            openingDate={data.rows.find(r => r.type === 'opening')?.date || null}
                            onSaved={(m) => { setNotice(m); reload(); }} onError={setErr} />

            <Ledger data={data} from={from} to={to} setFrom={setFrom} setTo={setTo} onApply={() => load(from, to, planned)} />
          </>
        )}
      </div>
    </div>
  );
}

/* ── §A cards ─────────────────────────────────────────────────────────────── */
function Cards({ s }: { s: Summary }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <div className={`rounded-xl border p-4 ${s.overdrawn ? 'bg-red-50 border-red-300' : 'bg-white border-[#E8D5C4]'}`}>
        <div className="text-xs text-[#8B7355] uppercase tracking-wide">Wallet balance (computed)</div>
        <div className={`text-2xl font-bold mt-1 ${s.overdrawn ? 'text-red-700' : 'text-[#2D1B0E]'}`}>{rs(s.balance)}</div>
        <div className="text-[11px] text-[#8B7355] mt-1">
          {s.overdrawn
            ? 'OVERDRAWN — a debit landed before its challan cleared. Not clamped: this is what the wallet actually stands at.'
            : `Σ of ${s.row_count} recorded movement${s.row_count === 1 ? '' : 's'}. Never stored.`}
        </div>
        {s.future_dated_count > 0 && (
          <div className="text-[11px] text-amber-800 mt-1 font-medium">
            ⚠ Includes {s.future_dated_count} movement{s.future_dated_count === 1 ? '' : 's'} dated in the FUTURE
            ({rs(s.future_dated_total)}). They are outside every &ldquo;as at&rdquo; figure below, check A included —
            so this headline and the check-A balance will differ by that much.
          </div>
        )}
      </div>
      <div className="rounded-xl border border-[#E8D5C4] bg-white p-4">
        <div className="text-xs text-[#8B7355] uppercase tracking-wide">Working capital parked</div>
        <div className="text-2xl font-bold mt-1 text-[#2D1B0E]">{rs(s.working_capital_parked)}</div>
        <div className="text-[11px] text-[#8B7355] mt-1">
          {s.working_capital_parked < 0 ? 'Nothing parked — TGBCL is carrying us.' : 'Our money sitting with TGBCL, not in the bank.'}
        </div>
      </div>
      <div className="rounded-xl border border-[#E8D5C4] bg-white p-4">
        <div className="text-xs text-[#8B7355] uppercase tracking-wide">Deposits utilised</div>
        <div className="text-2xl font-bold mt-1 text-[#2D1B0E]">
          {s.deposits_utilised_pct === null ? '—' : s.deposits_utilised_pct.toFixed(1) + '%'}
        </div>
        <div className="text-[11px] text-[#8B7355] mt-1">
          {rs(s.utilised_out)} spent of {rs(s.funded_in)} funded (opening + deposits + positive adjustments).
          {(s.adjustment_in > 0 || s.adjustment_out > 0) && (
            <> Adjustments are counted gross: {rs(s.adjustment_in)} in, {rs(s.adjustment_out)} out.</>
          )}
        </div>
      </div>
      <div className={`rounded-xl border p-4 ${s.bank_unconfirmed_count ? 'bg-amber-50 border-amber-300' : 'bg-white border-[#E8D5C4]'}`}>
        <div className="text-xs text-[#8B7355] uppercase tracking-wide">Bank-unconfirmed deposits</div>
        <div className="text-2xl font-bold mt-1 text-[#2D1B0E]">{s.bank_unconfirmed_count}</div>
        <div className="text-[11px] text-[#8B7355] mt-1">
          {s.bank_unconfirmed_count ? `${rs(s.bank_unconfirmed_total)} recorded but not yet matched to a bank debit (check C).` : 'Every recorded challan is matched to a bank debit.'}
        </div>
      </div>
    </div>
  );
}

/* ── Summary check A: computed vs the portal ──────────────────────────────── */
function PortalCheckPanel(
  { data, onSaved, onError }: { data: WalletData; onSaved: (m: string) => void; onError: (m: string) => void },
) {
  const [asOf, setAsOf] = useState(data.range.to);
  const [amount, setAmount] = useState('');
  const [source, setSource] = useState('portal screen');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<PortalCheck | null>(null);

  const save = async () => {
    setBusy(true); onError('');
    try {
      const r = await api('/api/liquor/wallet/portal-check', {
        method: 'POST',
        // Named, not left to the route's default: this form is the BALANCE
        // reading. Check B's per-indent figure has its own form below.
        body: { kind: 'wallet_balance', as_of_date: asOf, portal_amount: Number(amount), source, note },
      });
      const j = await r.json();
      if (!r.ok) { onError(j.error || `HTTP ${r.status}`); return; }
      setLast(j.check);
      setAmount('');
      onSaved(
        (j.check.matched
          ? `Portal check saved — the portal and the ledger agree at ${rs(j.check.portal_amount)}.`
          : `Portal check saved — the portal shows ${rs(j.check.portal_amount)}, we compute ${rs(j.check.computed_balance)}.`)
        + (j.check.replaced_amount === null || j.check.replaced_amount === undefined
          ? ''
          : ` It REPLACED the earlier reading of ${rs(j.check.replaced_amount)} for ${j.check.as_of_date} — one reading is kept per day.`),
      );
    } catch (e: any) { onError(e?.message || 'Could not save the portal check.'); }
    finally { setBusy(false); }
  };

  const recent = data.portal_checks.slice(0, 5);
  // The receipt below is a snapshot of the moment it was saved; the list the
  // server sends is re-derived on every load (a back-dated deposit changes what
  // we compute for a past day). Prefer the server's row so one screen cannot
  // show two different differences for the same date.
  const lastLive = last ? (data.portal_checks.find(c => c.as_of_date === last.as_of_date) || last) : null;
  // The hint beside the button is the balance for the WINDOW's end date. If the
  // owner has moved the "As at" date, that is a different day's figure and the
  // check will not use it — so it is not offered as if it were.
  const hintMatchesAsOf = asOf === data.range.to;

  return (
    <div className="rounded-xl border border-[#E8D5C4] bg-white p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Landmark className="w-5 h-5 text-[#af4408]" />
        <h2 className="font-semibold text-[#2D1B0E]">Check A — computed vs the portal</h2>
      </div>
      <p className="text-xs text-[#8B7355]">
        Type what the TGBCL portal SHOWS. It is stored as an observation
        (<code className="text-[10px]">lq_portal_checks</code>) and <span className="font-medium">cannot move the balance</span> —
        it is what the balance is measured against. The difference is
        <span className="font-medium"> the portal MINUS what we compute</span>: positive means TGBCL holds more than our
        ledger accounts for. One reading is kept per day — saving a second for the same date replaces the first.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          As at
          <input type="date" value={asOf} max={data.today} onChange={e => setAsOf(e.target.value)}
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Balance shown on the portal (₹)
          <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="e.g. 431550.00"
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Read from
          <input value={source} onChange={e => setSource(e.target.value)} placeholder="portal screen / indent PDF"
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Note
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="optional"
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy || amount === ''}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-[#af4408] text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Record the portal figure'}
        </button>
        <span className="text-xs text-[#8B7355]">
          {hintMatchesAsOf
            ? <>We compute {rs(data.balance_as_of.balance)} as at {data.range.to}.</>
            : <>We compute {rs(data.balance_as_of.balance)} as at {data.range.to} — the balance for <span className="font-medium">{asOf}</span> is computed when you save, and it is that day&apos;s figure the check uses.</>}
        </span>
      </div>

      {lastLive && (
        <div className={`rounded-lg p-3 text-sm border ${lastLive.matched ? 'bg-emerald-50 border-emerald-300 text-emerald-900' : 'bg-amber-50 border-amber-400 text-amber-900'}`}>
          <div className="font-semibold">
            {lastLive.matched ? 'MATCH' : `DIFFERENCE ${rs(lastLive.difference)} (portal − computed)`}
          </div>
          <div className="text-xs mt-0.5">
            Portal {rs(lastLive.portal_amount)} · computed {rs(lastLive.computed_balance)} · as at {lastLive.as_of_date}
          </div>
          {!lastLive.matched && lastLive.difference_direction && (
            <div className="text-xs mt-1">{lastLive.difference_direction}</div>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[#8B7355]">
              <tr><th className="text-left py-1">As at</th><th className="text-right">Portal</th><th className="text-right">Computed</th><th className="text-right">Difference (portal − computed)</th></tr>
            </thead>
            <tbody>
              {recent.map(c => (
                <tr key={c.id} className="border-t border-[#E8D5C4]/60">
                  <td className="py-1 text-[#6B5744]">{c.as_of_date}</td>
                  <td className="text-right">{rs(c.portal_amount)}</td>
                  <td className="text-right">{rs(c.computed_balance)}</td>
                  <td className={`text-right font-semibold ${c.matched ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {c.matched ? '—' : rs(c.difference)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Summary check B: one indent's value, portal vs recorded Net Indent ──────
   The per-indent reading check B waits on. Nothing else in the app writes a
   kind 'indent_value' row: the check A form above posts the wallet BALANCE,
   and a per-indent figure filed there would be read as that day's balance
   (that is why the route now refuses to guess a kind). Like check A it is an
   OBSERVATION in lq_portal_checks: it moves no money and never edits the
   indent's recorded Net Indent. One reading per indent per day — saving the
   same indent and date again replaces the figure. */
function IndentCheckPanel(
  { data, checks, checksError, onSaved, onError }: {
    data: WalletData; checks: IndentCheck[]; checksError: string;
    onSaved: (m: string) => void; onError: (m: string) => void;
  },
) {
  const [reference, setReference] = useState('');
  const [asOf, setAsOf] = useState(data.today);
  const [amount, setAmount] = useState('');
  const [source, setSource] = useState('indent PDF');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<IndentCheck | null>(null);

  /* Indent numbers to pick from: the debits in this window and the recorded
     indents that have none. A suggestion only — the field takes any number,
     because a reading may be taken off the portal before the bill is keyed. */
  const suggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of [
      ...data.rows.filter(r => r.type === 'indent_debit').map(r => r.reference),
      ...data.integrity.missing.map(m => m.invoice_ref),
    ]) {
      const s = String(v || '').trim();
      if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
    }
    return out.slice(0, 200);
  }, [data.rows, data.integrity.missing]);

  const save = async () => {
    setBusy(true); onError('');
    try {
      const r = await api('/api/liquor/wallet/portal-check', {
        method: 'POST',
        body: {
          kind: 'indent_value', reference: reference.trim(), as_of_date: asOf,
          portal_amount: Number(amount), source, note,
        },
      });
      const j = await r.json();
      if (!r.ok) { onError(j.error || `HTTP ${r.status}`); return; }
      const c = j.check as IndentCheck;
      setLast(c);
      setAmount('');
      onSaved(
        (c.matched === null
          ? `Indent reading saved for ${c.reference} — no recorded indent to compare it with yet.`
          : c.matched
            ? `Indent reading saved — ${c.reference}: the portal and the recorded Net Indent agree at ${rs(c.portal_amount)}.`
            : `Indent reading saved — ${c.reference}: the portal shows ${rs(c.portal_amount)}, the recorded Net Indent is ${rs(c.net_indent_value)}.`)
        + (c.replaced_amount === null || c.replaced_amount === undefined
          ? ''
          : ` It REPLACED the earlier reading of ${rs(c.replaced_amount)} for ${c.reference} on ${c.as_of_date} — one reading is kept per indent per day.`),
      );
    } catch (e: any) { onError(e?.message || 'Could not save the indent reading.'); }
    finally { setBusy(false); }
  };

  // As on check A: the receipt is the moment of saving; the list is re-compared
  // on every load (a corrected levy changes the Net Indent), so prefer it.
  const lastLive = last ? (checks.find(c => c.id === last.id) || last) : null;
  const recent = checks.slice(0, 8);

  return (
    <div className="rounded-xl border border-[#E8D5C4] bg-white p-4 space-y-3" data-panel="check-b">
      <div className="flex items-center gap-2">
        <ScrollText className="w-5 h-5 text-[#af4408]" />
        <h2 className="font-semibold text-[#2D1B0E]">Check B — one indent: the portal vs its recorded Net Indent</h2>
      </div>
      <p className="text-xs text-[#8B7355]">
        Type the value the TGBCL portal (or the indent PDF) shows for <span className="font-medium">one indent</span>.
        It is compared with that indent&apos;s recorded Net Indent (invoice value + the four TGBCL levies) and kept as an
        observation — it <span className="font-medium">moves no money</span> and does not change the recorded bill.
        The difference is <span className="font-medium">the portal MINUS the recorded Net Indent</span>. The wallet
        balance goes in check A, not here. One reading is kept per indent per day.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <label className="text-xs text-[#6B5744] flex flex-col gap-1 lg:col-span-2">
          Indent number
          <input value={reference} onChange={e => setReference(e.target.value)} list="lq-indent-refs"
            placeholder="e.g. IND/2026/10/0457"
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
          <datalist id="lq-indent-refs">
            {suggestions.map(s => <option key={s} value={s} />)}
          </datalist>
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          As at
          <input type="date" value={asOf} max={data.today} onChange={e => setAsOf(e.target.value)}
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Indent value on the portal (₹)
          <input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="e.g. 105450.60"
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Read from
          <input value={source} onChange={e => setSource(e.target.value)} placeholder="indent PDF / portal screen"
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
        </label>
      </div>
      <label className="text-xs text-[#6B5744] flex flex-col gap-1">
        Note
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="optional"
          className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
      </label>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy || amount === '' || reference.trim() === ''}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-[#af4408] text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Record the indent figure'}
        </button>
        <span className="text-xs text-[#8B7355]">The recorded Net Indent is looked up when you save.</span>
      </div>

      {lastLive && (
        <div data-receipt="check-b"
             className={`rounded-lg p-3 text-sm border ${lastLive.matched === null
               ? 'bg-[#FFF8F0] border-[#D4B896] text-[#6B5744]'
               : lastLive.matched ? 'bg-emerald-50 border-emerald-300 text-emerald-900' : 'bg-amber-50 border-amber-400 text-amber-900'}`}>
          <div className="font-semibold">
            {lastLive.matched === null
              ? 'NOT COMPARED — no recorded Net Indent for this number'
              : lastLive.matched ? 'MATCH' : `DIFFERENCE ${rs(lastLive.difference)} (portal − recorded Net Indent)`}
          </div>
          <div className="text-xs mt-0.5">
            {lastLive.reference} · portal {rs(lastLive.portal_amount)}
            {lastLive.net_indent_value !== null && <> · recorded Net Indent {rs(lastLive.net_indent_value)}</>}
            {lastLive.store && <> · {lastLive.store}</>} · as at {lastLive.as_of_date}
          </div>
          {lastLive.matched !== true && lastLive.difference_direction && (
            <div className="text-xs mt-1">{lastLive.difference_direction}</div>
          )}
          {lastLive.warning && <div className="text-xs mt-1">{lastLive.warning}</div>}
        </div>
      )}

      {checksError && (
        <div className="text-xs text-amber-800">The recorded indent readings could not be loaded ({checksError}).</div>
      )}
      {recent.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[#8B7355]">
              <tr>
                <th className="text-left py-1">As at</th><th className="text-left">Indent</th>
                <th className="text-right">Portal</th><th className="text-right">Recorded Net Indent</th>
                <th className="text-right">Difference (portal − recorded)</th>
              </tr>
            </thead>
            <tbody>
              {recent.map(c => (
                <tr key={c.id} className="border-t border-[#E8D5C4]/60" data-indent-check={c.reference}>
                  <td className="py-1 text-[#6B5744]">{c.as_of_date}</td>
                  <td className="text-[#6B5744]">
                    {c.reference}
                    {c.register_ref && c.register_ref !== c.reference && <span className="text-[10px] text-[#8B7355]"> · in register {c.register_ref}</span>}
                  </td>
                  <td className="text-right">{rs(c.portal_amount)}</td>
                  <td className="text-right">{c.net_indent_value === null ? <span className="text-[#8B7355]">not on record</span> : rs(c.net_indent_value)}</td>
                  <td className={`text-right font-semibold ${c.matched === null ? 'text-[#8B7355]' : c.matched ? 'text-emerald-700' : 'text-amber-700'}`}
                      title={c.matched === true ? '' : c.difference_direction}>
                    {c.matched === null ? 'not compared' : c.matched ? '—' : rs(c.difference)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Summary §A2: the top-up planner ──────────────────────────────────────── */
function TopUpPanel(
  { data, planned, setPlanned, onReload, onStepSaved, onError }: {
    data: WalletData; planned: string; setPlanned: (v: string) => void;
    onReload: (p: string) => void; onStepSaved: (m: string) => void; onError: (m: string) => void;
  },
) {
  const [stepEdit, setStepEdit] = useState(false);
  const [step, setStep] = useState(String(data.top_up_step));
  const [busy, setBusy] = useState(false);
  const t = data.top_up;

  const saveStep = async () => {
    setBusy(true); onError('');
    try {
      const r = await api('/api/liquor/wallet', { method: 'PUT', body: { top_up_step: Number(step) } });
      const j = await r.json();
      if (!r.ok) { onError(j.error || `HTTP ${r.status}`); return; }
      setStepEdit(false);
      onStepSaved(`Top-up rounding step set to ${rs(j.top_up_step)}.`);
    } catch (e: any) { onError(e?.message || 'Could not save the step.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border border-[#E8D5C4] bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Calculator className="w-5 h-5 text-[#af4408]" />
          <h2 className="font-semibold text-[#2D1B0E]">§A2 — next top-up planner</h2>
        </div>
        <button onClick={() => setStepEdit(v => !v)}
          className="text-xs text-[#6B5744] flex items-center gap-1 hover:text-[#af4408]">
          <Settings2 className="w-3.5 h-3.5" /> Round to {rs(data.top_up_step)}
        </button>
      </div>

      {stepEdit && (
        <div className="flex items-end gap-2 bg-[#FFF1E3] rounded-lg p-3">
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Rounding step (₹)
            <input type="number" step="1" min="1" value={step} onChange={e => setStep(e.target.value)}
              className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm w-40" />
          </label>
          <button onClick={saveStep} disabled={busy}
            className="px-3 py-2 rounded-lg text-sm bg-[#af4408] text-white disabled:opacity-50">Save</button>
          <button onClick={() => { setStep(String(data.top_up_step)); setStepEdit(false); }}
            className="px-3 py-2 rounded-lg text-sm border border-[#D4B896] text-[#6B5744]">Cancel</button>
          <span className="text-[11px] text-[#8B7355] pb-2">Default {rs(data.top_up_step_default)}. Challans are rounded UP to a whole multiple.</span>
        </div>
      )}

      <label className="text-xs text-[#6B5744] flex flex-col gap-1">
        Planned next indent value (₹)
        <div className="flex gap-2">
          <input type="number" step="0.01" value={planned} onChange={e => setPlanned(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onReload(planned); }}
            placeholder="what the next indent will cost"
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm flex-1" />
          <button onClick={() => onReload(planned)}
            className="px-3 py-2 rounded-lg text-sm border border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3]">Plan</button>
        </div>
      </label>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
        <Stat label="Planned indent" value={rs(t.planned_indent)} />
        <Stat label="Wallet balance" value={rs(t.balance)} tone={t.balance < 0 ? 'bad' : undefined} />
        <Stat label="Shortfall" value={rs(t.shortfall)} tone={t.shortfall > 0 ? 'warn' : 'good'} />
        <Stat label={`Challan (to ${rs(t.step)})`} value={rs(t.recommended_challan)} tone={t.recommended_challan > 0 ? 'warn' : 'good'} strong />
      </div>

      <p className={`text-xs ${t.planned_invalid ? 'text-red-700 font-medium' : 'text-[#8B7355]'}`}>
        {t.planned_invalid
          ? 'A planned indent cannot be negative — an indent takes money OUT of the wallet. Nothing was planned; enter the indent value as a positive figure.'
          : <>
              {t.shortfall <= 0
                ? `The wallet already covers this indent — no challan needed${t.surplus > 0 ? `, with ${rs(t.surplus)} to spare` : ''}.`
                : `Deposit ${rs(t.recommended_challan)} (${rs(t.shortfall)} short, rounded up by ${rs(t.rounding_add)}). `
                  + `After the challan and the indent the wallet stands at ${rs(t.balance_after)}.`}
              {t.balance < 0 && ' The overdraft is included in the shortfall — the challan has to clear the hole before it buys anything.'}
            </>}
      </p>
    </div>
  );
}

function Stat({ label, value, tone, strong }: { label: string; value: string; tone?: 'good' | 'warn' | 'bad'; strong?: boolean }) {
  const color = tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-emerald-700' : 'text-[#2D1B0E]';
  return (
    <div className="rounded-lg bg-[#FFF8F0] border border-[#E8D5C4] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">{label}</div>
      <div className={`${strong ? 'text-lg font-bold' : 'font-semibold'} ${color}`}>{value}</div>
    </div>
  );
}

/* ── record a movement ────────────────────────────────────────────────────── */
function RecordPanel(
  { data, onSaved, onError }: { data: WalletData; onSaved: (m: string) => void; onError: (m: string) => void },
) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'opening' | 'deposit' | 'adjustment'>('deposit');
  const [date, setDate] = useState(data.today);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [mode, setMode] = useState('neft');
  const [bankDate, setBankDate] = useState('');
  const [bankAmount, setBankAmount] = useState('');
  const [verified, setVerified] = useState(false);
  const [portalStatus, setPortalStatus] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);

  const hasOpening = data.summary.opening_total !== 0 || data.rows.some(r => r.type === 'opening');
  const rule = data.types.find(t => t.key === type)?.sign_rule || '';

  const reset = () => {
    setAmount(''); setReference(''); setBankDate(''); setBankAmount('');
    setVerified(false); setPortalStatus(''); setRemarks('');
  };

  const save = async () => {
    setBusy(true); onError('');
    try {
      const r = await api('/api/liquor/wallet', {
        method: 'POST',
        body: {
          date, type, amount: Number(amount), reference,
          payment_mode: type === 'deposit' ? mode : '',
          bank_debit_date: type === 'deposit' ? bankDate : '',
          bank_amount: type === 'deposit' && bankAmount !== '' ? Number(bankAmount) : 0,
          bank_match: type === 'deposit' && verified ? 'verified' : 'pending',
          portal_status: portalStatus,
          remarks,
        },
      });
      const j = await r.json();
      if (!r.ok) { onError(j.error || `HTTP ${r.status}`); return; }
      reset();
      setOpen(false);
      onSaved(`${TYPE_LABEL[type]} recorded. Wallet balance ${rs(j.balance)}.${j.warning ? ' ' + j.warning : ''}`);
    } catch (e: any) { onError(e?.message || 'Could not record the movement.'); }
    finally { setBusy(false); }
  };

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <button onClick={() => setOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] text-white rounded-lg text-sm font-medium">
          <Plus className="w-4 h-4" /> Record a movement
        </button>
        <span className="text-xs text-[#8B7355] flex items-center gap-1">
          <Info className="w-3.5 h-3.5" />
          Indent debits are created automatically from the recorded indent — they are not entered here.
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#D4B896] bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-[#2D1B0E]">Record a wallet movement</h2>
        <button onClick={() => setOpen(false)} className="text-[#8B7355] hover:text-[#af4408]"><X className="w-4 h-4" /></button>
      </div>

      <div className="flex flex-wrap gap-2">
        {(['deposit', 'opening', 'adjustment'] as const).map(t => {
          const disabled = t === 'opening' && hasOpening;
          return (
            <button key={t} type="button" disabled={disabled} onClick={() => setType(t)}
              title={disabled ? 'This wallet already has an opening balance — correct it with an adjustment.' : ''}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${
                type === t ? 'bg-[#af4408] border-[#af4408] text-white'
                  : disabled ? 'bg-[#F5EDE2] border-[#E8D5C4] text-[#B8A590] cursor-not-allowed'
                  : 'bg-white border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
              {TYPE_LABEL[t]}
            </button>
          );
        })}
        <span className="text-[11px] text-[#8B7355] self-center">{rule}</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Date
          <input type="date" value={date} max={data.today} onChange={e => setDate(e.target.value)}
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Amount (₹){type === 'adjustment' && <span className="text-[10px] text-[#8B7355]"> — negative takes money out</span>}
          <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          {type === 'deposit' ? 'Challan number' : 'Reference'}
          <input value={reference} onChange={e => setReference(e.target.value)}
            placeholder={type === 'deposit' ? 'may be filled in later' : 'optional'}
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
        </label>
      </div>

      {type === 'deposit' && (
        <div className="rounded-lg bg-[#FFF1E3] border border-[#E8D5C4] p-3 space-y-3">
          <div className="text-xs font-semibold text-[#6B5744]">Bank confirmation checklist</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              Payment mode
              <select value={mode} onChange={e => setMode(e.target.value)}
                className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm">
                {['neft', 'rtgs', 'imps', 'cheque', 'cash', 'portal'].map(m => <option key={m} value={m}>{m.toUpperCase()}</option>)}
              </select>
            </label>
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              Bank debit date
              <input type="date" value={bankDate} max={data.today} onChange={e => setBankDate(e.target.value)}
                className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
            </label>
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              Bank amount (₹)
              <input type="number" step="0.01" value={bankAmount} onChange={e => setBankAmount(e.target.value)}
                className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs text-[#6B5744]">
            <input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />
            The bank statement shows this debit (marks it verified — check C stops counting it)
          </label>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Portal status
          <input value={portalStatus} onChange={e => setPortalStatus(e.target.value)} placeholder="what TGBCL shows against this row"
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Remarks{type === 'adjustment' && <span className="text-[10px] text-red-700"> — required on an adjustment</span>}
          <input value={remarks} onChange={e => setRemarks(e.target.value)}
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
        </label>
      </div>

      <div className="flex gap-2">
        <button onClick={save} disabled={busy || amount === ''}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-[#af4408] text-white disabled:opacity-50">
          {busy ? 'Recording…' : 'Record'}
        </button>
        <button onClick={() => { reset(); setOpen(false); }}
          className="px-4 py-2 rounded-lg text-sm border border-[#D4B896] text-[#6B5744]">Cancel</button>
      </div>
    </div>
  );
}

/* ── wallet vs recorded indents ───────────────────────────────────────────── */
function IntegrityPanel(
  { integrity, openingDate, onSaved, onError }: {
    integrity: Integrity;
    /** The opening row's date when it is inside the window on screen; null when
     *  it is not (the panel then cannot tell, and says the general rule). */
    openingDate: string | null;
    onSaved: (m: string) => void; onError: (m: string) => void;
  },
) {
  /* An indent with no failure on record, dated BEFORE the opening: the opening
     is a portal balance read on that day, so it already reflects this spend
     (finding: a healed debit dated before the opening took ₹22,251 out twice
     and failed check A by the whole indent). The server now leaves such an
     indent off missing[] and refuses its retry (409 before_opening); should
     one still be listed, the page says why by date and offers no button. */
  const beforeOpening = (m: { failure?: string | null; date: string }) =>
    !m.failure && !!openingDate && !!m.date && m.date < openingDate;
  // The heal path for a debit that could not be written when its bill was
  // saved: re-runs it from the RECORDED indent (POST action retry_auto_debit).
  // Re-saving the bill cannot do it — a recorded invoice is refused as a duplicate.
  const [busyRef, setBusyRef] = useState('');
  const writeDebit = async (sourceRef: string, label: string, failure: string | null | undefined, date: string) => {
    /* NO FAILURE ON RECORD → most often an indent saved BEFORE this ledger
       existed. The debit is dated on the indent's own date, and nothing on the
       server compares that with the opening balance — so for an indent the
       opening already reflects, writing it takes the same spend out twice and
       check A then fails by the whole indent. Only the person pressing knows
       which case this is, so they are asked, plainly, before anything is written. */
    if (!failure && typeof window !== 'undefined' && !window.confirm(
      `${label} (${date || 'no date'}) has no failed debit on record — it was most likely recorded before this wallet ledger existed, `
      + 'or its debit was removed by hand.\n\n'
      + 'If the wallet\'s OPENING balance was read off the portal AFTER this indent was charged, the opening already includes it: '
      + 'writing the debit now would take the same money out twice. Press Cancel in that case.\n\n'
      + 'Write the debit for this indent?',
    )) return;
    setBusyRef(sourceRef); onError('');
    try {
      const r = await api('/api/liquor/wallet', { method: 'POST', body: { action: 'retry_auto_debit', source_ref: sourceRef } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onError(j.error || `HTTP ${r.status}`); return; }
      onSaved(`${label}: ${j.result?.note || 'wallet debit written.'}`);
    } catch (e: any) { onError(e?.message || 'Could not write the debit.'); }
    finally { setBusyRef(''); }
  };
  const undebited = integrity.undebited || [];
  const foreign = integrity.foreign_store || [];
  const n = integrity.missing.length + integrity.mismatched.length + integrity.orphaned.length
    + undebited.length + foreign.length;
  if (n === 0 && integrity.non_positive.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-2">
      <div className="flex items-center gap-2 text-amber-900 font-semibold">
        <AlertTriangle className="w-5 h-5" /> Wallet vs recorded indents
      </div>
      {integrity.missing.length > 0 && (
        <div className="text-sm text-amber-900">
          <div className="font-medium">{integrity.missing.length} recorded indent(s) with NO wallet debit</div>
          <ul className="text-xs mt-1 space-y-1">
            {integrity.missing.slice(0, 8).map(m => (
              <li key={m.source_ref} className="flex flex-wrap items-start gap-x-2 gap-y-0.5">
                <span>{m.invoice_ref} · {m.date || 'no date'} · {rs(m.net_indent_value)} · {m.store}</span>
                {/* Not offered for an indent dated before the opening: the
                    server refuses that write (409 before_opening — the opening
                    already includes it), so a button would only promise it. */}
                {!beforeOpening(m) && (
                  <button onClick={() => writeDebit(m.source_ref, m.invoice_ref, m.failure, m.date)} disabled={!!busyRef}
                    className="px-2 py-0.5 rounded border border-amber-500 text-amber-900 hover:bg-amber-100 disabled:opacity-50">
                    {busyRef === m.source_ref ? 'Writing…' : 'Write the debit'}
                  </button>
                )}
                {m.failure
                  ? <span className="basis-full text-[11px] text-amber-800">Why it was not written: {m.failure}</span>
                  : beforeOpening(m)
                    ? <span className="basis-full text-[11px] font-medium text-red-800" data-missing="before-opening">
                        Dated before the wallet&apos;s opening balance ({openingDate}) — that opening was read off the
                        portal, so it already includes this indent. A debit for it would count it twice, so the wallet
                        does not write one: nothing to do.
                      </span>
                    : <span className="basis-full text-[11px] text-amber-800">
                        No failure on record — most likely recorded before this ledger existed. If the opening balance
                        already includes it, do not write it.
                      </span>}
              </li>
            ))}
          </ul>
          <div className="text-[11px] mt-1">
            Recorded before this ledger existed, the debit was removed by hand, or it could not be written when the bill
            was saved (the reason is shown). Fix the cause, then press <b>Write the debit</b> — it writes the debit from
            the recorded indent&apos;s Net Indent, dated on the indent&apos;s own date. Re-saving the bill does not: a
            recorded invoice is refused as a duplicate. An indent charged <b>before</b> the portal balance you typed as
            the opening is already inside that opening — writing its debit would count it twice, so leave it.
          </div>
        </div>
      )}
      {undebited.length > 0 && (
        <div className="text-sm text-amber-900">
          <div className="font-medium">{undebited.length} recorded liquor purchase(s) with NO indent record — nothing was debited</div>
          <ul className="text-xs mt-1 space-y-0.5">
            {undebited.slice(0, 8).map(u => (
              <li key={u.invoice_ref + u.store}>{u.invoice_ref} · {u.date || 'no date'} · {rs(u.recorded_value)} · {u.store}</li>
            ))}
          </ul>
          <div className="text-[11px] mt-1">
            The stock arrived but no TGBCL charges row was written, so no Net Indent exists and the wallet never
            moved. Only the old Liquor Store bill CSV did this (retired 29 Oct 2026 — it skipped the charges row when
            all four TGBCL levy fields were blank); a bill entered on Goods Receipt always writes it. The bill cannot
            be entered again (Goods Receipt refuses an indent the store already holds), so if the TGBCL portal charged
            it, record what it charged as an <b>Adjustment</b> naming the indent; the bill stays listed here as the
            record that it has no charges row. Bills dated before the wallet&apos;s opening balance are not listed:
            the opening already includes them.
          </div>
        </div>
      )}
      {foreign.length > 0 && (
        <div className="text-sm text-amber-900">
          <div className="font-medium">{foreign.length} wallet debit(s) from a store that is NOT the liquor store</div>
          <ul className="text-xs mt-1 space-y-0.5">
            {foreign.slice(0, 8).map(f => <li key={f.id}>{f.reference}: {rs(f.amount)} · {f.store}</li>)}
          </ul>
          <div className="text-[11px] mt-1">
            Every recorded TGBCL bill debits this one wallet, whichever store it posted to — a Goods Receipt liquor bill
            goes to the store its items&apos; categories belong to (Settings → Store Locations). Check these belong
            here; if they do not, correct the balance with an adjustment.
          </div>
        </div>
      )}
      {integrity.mismatched.length > 0 && (
        <div className="text-sm text-amber-900">
          <div className="font-medium">{integrity.mismatched.length} debit(s) no longer equal to their Net Indent</div>
          <ul className="text-xs mt-1 space-y-0.5">
            {integrity.mismatched.slice(0, 8).map(m => (
              <li key={m.id}>{m.reference}: debit {rs(m.debit)} vs Net Indent {rs(m.net_indent_value)} (out by {rs(m.diff)}){m.hand_entered ? ' · entered by hand' : ''}</li>
            ))}
          </ul>
        </div>
      )}
      {integrity.orphaned.length > 0 && (
        <div className="text-sm text-amber-900">
          <div className="font-medium">{integrity.orphaned.length} debit(s) whose indent no longer exists</div>
          <ul className="text-xs mt-1 space-y-0.5">
            {integrity.orphaned.slice(0, 8).map(m => <li key={m.id}>{m.reference}: {rs(m.amount)}</li>)}
          </ul>
          <div className="text-[11px] mt-1">
            The bill these debits were written for is no longer recorded — usually its Goods Receipt was voided. Voiding
            removes a debit the app wrote; one that was typed by hand and taken over by the bill is kept, because it is
            somebody&apos;s entry. If the TGBCL portal did not charge it, take it back out with an <b>Adjustment</b>.
          </div>
        </div>
      )}
      {integrity.non_positive.length > 0 && (
        <div className="text-xs text-amber-900">
          {integrity.non_positive.length} indent(s) recorded with a Net Indent of ₹0 or less are deliberately not debited
          ({integrity.non_positive.slice(0, 4).map(m => m.invoice_ref).join(', ')}).
        </div>
      )}
    </div>
  );
}

/* ── the ledger ───────────────────────────────────────────────────────────── */
function Ledger(
  { data, from, to, setFrom, setTo, onApply }: {
    data: WalletData; from: string; to: string;
    setFrom: (v: string) => void; setTo: (v: string) => void; onApply: () => void;
  },
) {
  return (
    <div className="rounded-xl border border-[#E8D5C4] bg-white overflow-hidden">
      <div className="p-4 flex flex-col sm:flex-row sm:items-end gap-3 border-b border-[#E8D5C4]">
        <div className="flex items-center gap-2 mr-auto">
          <ScrollText className="w-5 h-5 text-[#af4408]" />
          <h2 className="font-semibold text-[#2D1B0E]">Ledger</h2>
        </div>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          From
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          To
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            className="px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-sm" />
        </label>
        <button onClick={onApply}
          className="px-3 py-2 rounded-lg text-sm border border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3]">Apply</button>
      </div>

      <div className="px-4 py-2 text-xs text-[#8B7355] bg-[#FFF8F0] border-b border-[#E8D5C4]">
        Opening balance before {data.range.from}: <span className="font-semibold text-[#2D1B0E]">{rs(data.opening_balance)}</span>
        {data.outside_window > 0 && <> · {data.outside_window} movement(s) outside this window are still counted in the balance above.</>}
        {' '}The running balance is the TRUE wallet, computed over every row in date order — not over the rows shown.
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[#FFF1E3] text-[#6B5744]">
            <tr>
              <th className="text-left py-2 px-3">Date</th>
              <th className="text-left py-2 px-3">Type</th>
              <th className="text-left py-2 px-3">Reference</th>
              <th className="text-right py-2 px-3">Amount</th>
              <th className="text-right py-2 px-3">Running balance</th>
              <th className="text-left py-2 px-3">Bank</th>
              <th className="text-left py-2 px-3">Remarks</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && (
              <tr><td colSpan={7} className="py-6 text-center text-[#8B7355] text-sm">No movements in this window.</td></tr>
            )}
            {data.rows.map(r => (
              <tr key={r.id} className={`border-t border-[#E8D5C4]/50 ${r.anomaly ? 'bg-amber-50/60' : ''}`}>
                <td className="py-1.5 px-3 whitespace-nowrap text-[#6B5744]">{r.date}</td>
                <td className="py-1.5 px-3">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                    r.type === 'indent_debit' ? 'bg-orange-100 text-orange-800'
                      : r.type === 'adjustment' ? 'bg-purple-100 text-purple-800'
                      : 'bg-emerald-100 text-emerald-800'}`}>
                    {TYPE_LABEL[r.type]}
                  </span>
                  {r.auto && <span className="ml-1 text-[10px] text-[#8B7355]" title="Created automatically from the recorded indent">auto</span>}
                </td>
                <td className="py-1.5 px-3 text-[#6B5744]">{r.reference || '—'}</td>
                <td className={`py-1.5 px-3 text-right font-medium tabular-nums ${r.amount < 0 ? 'text-orange-800' : 'text-emerald-800'}`}>{rs(r.amount)}</td>
                <td className={`py-1.5 px-3 text-right font-semibold tabular-nums ${r.running_balance < 0 ? 'text-red-700' : 'text-[#2D1B0E]'}`}>{rs(r.running_balance)}</td>
                <td className="py-1.5 px-3 text-xs text-[#6B5744]">
                  {r.type === 'deposit'
                    ? (r.bank_match === 'verified'
                      ? <span className="text-emerald-700">verified{r.bank_debit_date ? ' · ' + r.bank_debit_date : ''}</span>
                      : <span className="text-amber-700">pending</span>)
                    : '—'}
                </td>
                <td className="py-1.5 px-3 text-xs text-[#6B5744]">
                  {r.remarks || '—'}
                  {r.anomaly && <div className="text-[11px] text-amber-800 mt-0.5">⚠ {r.anomaly}</div>}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[#D4B896] bg-[#FFF8F0]">
              <td colSpan={4} className="py-2 px-3 text-right text-xs text-[#6B5744]">Closing balance at {data.range.to}</td>
              <td className={`py-2 px-3 text-right font-bold tabular-nums ${data.closing_balance < 0 ? 'text-red-700' : 'text-[#2D1B0E]'}`}>{rs(data.closing_balance)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
