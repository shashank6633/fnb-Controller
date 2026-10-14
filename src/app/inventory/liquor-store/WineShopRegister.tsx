'use client';

/**
 * WINE-SHOP BUYS — the rest of the L3 lifecycle, on the Liquor Store page.
 *
 * The Wine-shop Purchase modal (page.tsx WineShopModal) RECORDS an emergency
 * buy. Two of the three things that can happen to the record afterwards had a
 * route and no button, so nothing in the app could do them:
 *
 *   · PAY A CLAIM BACK. POST /api/liquor/retail/[id]/reimburse is the only
 *     writer of 'reimbursed': it pays the staff member out of the petty-cash box
 *     and links the payout to the claim. With no caller, every claim keyed in as
 *     'claimed_pending' sat in §E's "unreimbursed staff spend" for good.
 *   · PRICE AN UNPRICED BUY, and CORRECT A CLAIM. PATCH /api/liquor/retail/[id]
 *     backfills the depot rate on a buy recorded before its brand was mapped
 *     (only where none was frozen at entry) and moves a claim between
 *     not_required / claimed_pending / rejected. 'reimbursed' is never typed:
 *     the route refuses it, and so does this screen.
 *
 * WHAT THIS SCREEN DECIDES, AND WHAT IT LEAVES TO THE SERVER. It decides only
 * which buttons a row shows (retailRowState below, one function for both the
 * table and the phone cards). Every rule that matters is the server's and is
 * enforced there whatever this file does: the payout must equal the claim in
 * full, the box debited is the CLAIM's outlet, a payout cannot be future-dated,
 * a frozen depot rate is never re-priced, a payout-backed claim cannot be
 * re-statused. Refusals are shown in the server's own words, never paraphrased.
 *
 * WHO SEES IT. The tab is offered to MANAGEMENT (admin / manager / HOD) — the
 * read gate of GET /api/liquor/retail, because this list is the §E money: the
 * excess paid, depot spend and what is owed to named staff. Recording a buy
 * (the Wine-shop Purchase button, can_procure) is a stock authority and does
 * not open it. Inside, two write gates apply:
 *   · Set depot rate / Change claim — PATCH, can_procure on the material's own
 *     store. Offered only when `canCorrect` (the page: can_procure on any active
 *     store); the route decides per material and its refusal is shown verbatim.
 *   · Pay back — the petty-cash gate (Petty Cash page access + Management or
 *     the Store Manager). Not re-implemented here: a refusal comes back as the
 *     route's sentence. Duplicating the rule is how a read path and a write path
 *     drift apart.
 *
 * UNITS. A flag's `bottles` and both ₹ rates are per PURCHASE unit (the modal
 * records "Qty in {pu}" and "₹ paid per {pu}"), so every figure here is labelled
 * with the material's own purchase unit. No recipe-unit figure appears.
 *
 * VALUATION. Nothing here writes average_price, last_purchase_price or a ledger
 * unit_cost (owner decision 1): the depot rate is the analytics figure the
 * excess is measured against, and a payout is petty-cash money, not stock.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2, AlertCircle, AlertTriangle, CheckCircle2, X, RefreshCw,
  HandCoins, Tag, Pencil, Siren,
} from 'lucide-react';
import { api } from '@/lib/api';
import { todayIST } from '@/lib/format-date';

/* ── Types (mirror GET /api/liquor/retail → summary; liquor-retail.ts) ────── */

export type ReimbStatus = 'not_required' | 'claimed_pending' | 'reimbursed' | 'rejected';

export interface RetailFlag {
  id: string;
  /** LEGACY anchor only (a flag from the first, central-purchase design). */
  purchase_id: string | null;
  /** The store-ledger 'inward' row that moved the bottles (new flags). null on
   *  a COST-ONLY buy, which moved no stock. */
  ledger_id?: string | null;
  /** true → COST ONLY (owner ruling 2026-10-14): a closing count saved for the
   *  item on or after the buy's date already held these bottles, so the buy
   *  booked no stock and is on this register for its money alone. Absent from
   *  a server without the ruling (read as false). */
  cost_only?: boolean;
  /** The date of the count that holds the bottles, when the server names it. */
  cost_only_count_date?: string | null;
  bill_ref: string;
  date: string;
  shop_name: string;
  shop_licence_no: string;
  bottles: number;
  rate_paid_per_bottle: number;
  /** The four depot figures are null when WITHHELD from this viewer — they
   *  re-derive the admin-only TGBCL master rate (liquor-retail.ts
   *  retailSummaryForViewer). `priced` still says whether a rate is frozen. */
  depot_landed_per_bottle: number | null;
  excess_per_bottle: number | null;
  excess_total: number | null;
  excess_pct: number | null;
  /** depot rate > 0 (the server's own test). Absent only from an older server. */
  priced?: boolean;
  paid_by: string;
  payment_mode: string;
  reimbursement_status: ReimbStatus;
  petty_cash_id: string | null;
  reason: string;
  approved_by: string;
  material_id: string | null;
  material_name: string | null;
  outlet_id: string | null;
  total_paid: number;
}

export interface RetailSummary {
  from: string; to: string;
  /** null when the depot figures are withheld from this viewer. */
  excessTotal: number | null;
  /** false → every depot figure on this summary is null; the note says why. */
  depotFiguresVisible?: boolean;
  depotFiguresNote?: string | null;
  unknownDepotCount: number;
  unknownDepotBottles: number;
  wineShopSpend: number;
  unreimbursedStaffSpend: number;
  reopenedClaimCount: number;
  hiddenByOutletCount: number;
  byStatus: Record<ReimbStatus, number>;
  flagCount: number;
  totalBottles: number;
  rows: RetailFlag[];
}

/** The slice of a page material this file needs: its unit labels. */
export interface UnitMat { id: string; unit?: string; purchase_unit?: string }

/* ── Pure helpers (exported so the proof harness exercises the SAME code) ─── */

const r2 = (v: number) => Math.round((Number(v) || 0) * 100) / 100;

export const STATUS_LABEL: Record<ReimbStatus, string> = {
  not_required: 'Not required',
  claimed_pending: 'Claimed — pending',
  reimbursed: 'Reimbursed',
  rejected: 'Rejected',
};

/** The three states a person may SET. 'reimbursed' is reached only by a payout. */
const SETTABLE: ReadonlyArray<Exclude<ReimbStatus, 'reimbursed'>> = ['not_required', 'claimed_pending', 'rejected'];

export interface RowState {
  /** Closed by a real petty-cash payout — nothing on this screen may change it. */
  payoutBacked: boolean;
  /** Marked reimbursed but its payout was deleted — the debt is real again. */
  reopened: boolean;
  /** Money is still owed to whoever fronted it: pending, or reopened. */
  owed: boolean;
  /** No depot rate was frozen at entry, so its excess was never computed. */
  unpriced: boolean;
  /** Statuses the Change-claim action may move this row to. */
  statusTargets: Array<Exclude<ReimbStatus, 'reimbursed'>>;
  /** Owed or unpriced — what the default "open items" filter keeps. */
  open: boolean;
}

/**
 * Which actions a row offers. The SAME tests the server applies, read off the
 * row the server returned — so a button is never offered for an action the
 * route would refuse on state alone (it may still refuse on permission):
 *   owed      ⇔ closeReimbursementWithPettyCash accepts it (pending, or
 *               reimbursed with petty_cash_id NULL — a deleted payout)
 *   unpriced  ⇔ backfillDepotLanded accepts it (depot rate ≤ 0)
 *   statusTargets is empty ⇔ setReimbursementStatus answers 409 payout_backed
 */
export function retailRowState(r: RetailFlag): RowState {
  const payoutBacked = r.reimbursement_status === 'reimbursed' && !!r.petty_cash_id;
  const reopened = r.reimbursement_status === 'reimbursed' && !r.petty_cash_id;
  const owed = r.reimbursement_status === 'claimed_pending' || reopened;
  // `priced` when the server sends it: a WITHHELD rate arrives as null, and
  // reading null as "no rate" would offer Set depot rate on a priced buy (409).
  const unpriced = r.priced !== undefined ? !r.priced : !(Number(r.depot_landed_per_bottle) > 0);
  const statusTargets = payoutBacked ? [] : SETTABLE.filter(s => s !== r.reimbursement_status);
  return { payoutBacked, reopened, owed, unpriced, statusTargets, open: owed || unpriced };
}

/** POST /api/liquor/retail/[id]/reimburse body. `amount` is the CONFIRMATION
 *  of the figure on screen (the route refuses a mismatch — a payout closes a
 *  claim only in full), never a free amount. */
export function reimburseBody(r: RetailFlag, date: string, notes: string) {
  return {
    amount: r2(r.total_paid),
    date: date || undefined,
    notes: notes.trim() || undefined,
  };
}

/** PATCH body that prices an unpriced buy. */
export function priceBody(depotPerUnit: number) {
  return { depot_landed_per_bottle: depotPerUnit };
}

/** PATCH body that corrects a claim's status, with the reason for the audit log. */
export function statusBody(status: Exclude<ReimbStatus, 'reimbursed'>, note: string) {
  return { reimbursement_status: status, note: note.trim() || undefined };
}

/** The excess the server WILL compute for a depot rate (computeRetailExcess),
 *  shown as a preview only — the saved figure is the route's reply. */
export function previewExcess(ratePaid: number, depot: number, bottles: number) {
  if (!(depot > 0)) return null;
  const per = r2(ratePaid - depot);
  return { per, total: r2(per * bottles), pct: r2(((ratePaid - depot) / depot) * 100) };
}

/* ── Formatting ─────────────────────────────────────────────────────────── */

const inr = (v: number, dp = 2) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: dp });
const fq = (v: number) => Number((Number(v) || 0).toFixed(2)).toLocaleString('en-IN');
/** The purchase unit a flag's quantity and rates are in — the material's own. */
const puFor = (r: RetailFlag, mats: Map<string, UnitMat>) => {
  const m = r.material_id ? mats.get(r.material_id) : undefined;
  return String(m?.purchase_unit || m?.unit || '').trim() || 'BTL';
};

const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]';
const btnGhost = 'px-2 py-1 bg-white border border-[#af4408]/50 text-[#af4408] hover:bg-[#af4408]/10 rounded-md text-[11px] font-medium inline-flex items-center gap-1 whitespace-nowrap';
const Lbl = ({ children }: { children: React.ReactNode }) => (
  <label className="block text-[10px] uppercase tracking-wide text-[#8B7355] mb-0.5">{children}</label>
);

function StatusChip({ r }: { r: RetailFlag }) {
  const st = retailRowState(r);
  if (st.reopened) {
    return (
      <span title="Marked reimbursed, but its petty-cash payout was deleted — the money is owed again"
            className="inline-block border rounded-full px-2 py-0.5 text-[10px] bg-amber-50 border-amber-300 text-amber-900">
        Reopened — still owed
      </span>
    );
  }
  const cls = r.reimbursement_status === 'claimed_pending'
    ? 'bg-amber-50 border-amber-300 text-amber-900'
    : r.reimbursement_status === 'reimbursed'
      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
      : r.reimbursement_status === 'rejected'
        ? 'bg-gray-50 border-gray-200 text-gray-600'
        : 'bg-white border-[#E8D5C4] text-[#6B5744]';
  return <span className={`inline-block border rounded-full px-2 py-0.5 text-[10px] ${cls}`}>{STATUS_LABEL[r.reimbursement_status]}</span>;
}

type Action = { kind: 'pay' | 'price' | 'status'; row: RetailFlag };

/** The action buttons for one row — shared by the table and the phone cards.
 *  `canCorrect` gates the two PATCH actions (price, claim status); Pay back is
 *  the petty-cash route's own decision. */
export function RowActions({ r, onAction, canCorrect = true }: {
  r: RetailFlag; onAction: (a: Action) => void; canCorrect?: boolean;
}) {
  const st = retailRowState(r);
  return (
    <div className="flex flex-wrap gap-1.5">
      {st.owed && (
        <button type="button" onClick={() => onAction({ kind: 'pay', row: r })} className={btnGhost}
                data-action="pay" title="Pay the claim back out of the petty-cash box">
          <HandCoins className="w-3 h-3" /> Pay back {inr(r.total_paid)}
        </button>
      )}
      {canCorrect && st.unpriced && (
        <button type="button" onClick={() => onAction({ kind: 'price', row: r })} className={btnGhost}
                data-action="price" title="Enter the depot landed rate so the excess can be computed">
          <Tag className="w-3 h-3" /> Set depot rate
        </button>
      )}
      {canCorrect && st.statusTargets.length > 0 && (
        <button type="button" onClick={() => onAction({ kind: 'status', row: r })} className={btnGhost}
                data-action="status" title="Correct whether anyone is owed this money">
          <Pencil className="w-3 h-3" /> Change claim
        </button>
      )}
      {st.payoutBacked && (
        <span className="text-[10px] text-[#8B7355]" title="Closed by a petty-cash payout. Delete or reverse that payout on Petty Cash to reopen it.">
          paid from petty cash
        </span>
      )}
    </div>
  );
}

/**
 * The register body: stat tiles, the table (md+) and the phone cards, rendered
 * from a summary the caller already holds. Pure — no fetch, no effect — so the
 * proof can render it from the real GET's output.
 */
export function RegisterView({ summary, rows, materials, onAction, canCorrect = true }: {
  summary: RetailSummary; rows: RetailFlag[]; materials: UnitMat[];
  onAction: (a: Action) => void;
  /** Offer Set depot rate / Change claim (PATCH, can_procure). */
  canCorrect?: boolean;
}) {
  const mats = useMemo(() => new Map(materials.map(m => [m.id, m])), [materials]);
  const openClaims = summary.rows.filter(r => retailRowState(r).owed).length;
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Tile label="Owed to staff" value={inr(summary.unreimbursedStaffSpend)}
              sub={`${openClaims} open claim${openClaims === 1 ? '' : 's'}`}
              tone={summary.unreimbursedStaffSpend > 0 ? 'warn' : 'muted'} />
        <Tile label="Unpriced buys" value={String(summary.unknownDepotCount)}
              sub="excess not computed" tone={summary.unknownDepotCount > 0 ? 'warn' : 'muted'} />
        <Tile label="Excess over depot" value={summary.excessTotal == null ? 'Admin-only' : inr(summary.excessTotal)}
              sub={summary.excessTotal == null ? 'withheld — see the note above' : 'priced buys only'} />
        <Tile label="Wine-shop spend" value={inr(summary.wineShopSpend)} sub={`${summary.flagCount} buy${summary.flagCount === 1 ? '' : 's'}`} />
      </div>

      {rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">
          {summary.rows.length === 0 ? 'No wine-shop buys recorded in this range.' : 'Nothing open — every claim is settled and every buy is priced.'}
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] text-xs">
                <thead className="bg-[#FFF1E3] text-[#8B7355]">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Date</th>
                    <th className="text-left px-3 py-2 font-medium">Item</th>
                    <th className="text-left px-3 py-2 font-medium">Shop · bill</th>
                    <th className="text-right px-3 py-2 font-medium">Qty</th>
                    {/* ₹ per PURCHASE unit, both columns. rate-basis: purchase */}
                    <th className="text-right px-3 py-2 font-medium">Paid / unit</th>
                    <th className="text-right px-3 py-2 font-medium">Depot / unit</th>
                    <th className="text-right px-3 py-2 font-medium">Excess</th>
                    <th className="text-left px-3 py-2 font-medium">Paid by</th>
                    <th className="text-left px-3 py-2 font-medium">Claim</th>
                    <th className="text-left px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F0E4D6]">
                  {rows.map(r => {
                    const pu = puFor(r, mats);
                    const st = retailRowState(r);
                    return (
                      <tr key={r.id} data-flag={r.id} className="hover:bg-[#FFF8F0] align-top">
                        <td className="px-3 py-2 whitespace-nowrap text-[#6B5744]">{r.date}</td>
                        <td className="px-3 py-2 text-[#2D1B0E]">{r.material_name || '—'}</td>
                        <td className="px-3 py-2 text-[#6B5744]">
                          {r.shop_name || '—'}
                          {r.bill_ref && <div className="text-[10px] font-mono text-[#8B7355]">{r.bill_ref}</div>}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap font-medium text-[#2D1B0E]">
                          {fq(r.bottles)} {pu}
                          {r.cost_only && <CostOnlyNote r={r} />}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{inr(r.rate_paid_per_bottle)}/{pu}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {st.unpriced ? <span className="text-amber-700">unknown</span>
                            : r.depot_landed_per_bottle == null ? <span className="text-[#8B7355]">priced · admin-only</span>
                            : <>{inr(r.depot_landed_per_bottle)}/{pu}</>}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {st.unpriced
                            ? <span className="text-[#8B7355]">not computed</span>
                            : r.excess_total == null ? <span className="text-[#8B7355]">admin-only</span>
                            : <span className="text-amber-800">{inr(r.excess_total)} <span className="text-[10px] text-[#8B7355]">({fq(Number(r.excess_pct))}%)</span></span>}
                        </td>
                        <td className="px-3 py-2 text-[#6B5744]">{r.paid_by || '—'}</td>
                        <td className="px-3 py-2"><StatusChip r={r} /></td>
                        <td className="px-3 py-2"><RowActions r={r} onAction={onAction} canCorrect={canCorrect} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Phone cards */}
          <div className="md:hidden space-y-2">
            {rows.map(r => {
              const pu = puFor(r, mats);
              const st = retailRowState(r);
              return (
                <div key={r.id} className="bg-white border border-[#E8D5C4] rounded-xl p-3 text-xs space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <StatusChip r={r} />
                    <span className="text-[10px] text-[#8B7355]">{r.date}</span>
                  </div>
                  <div className="text-sm font-medium text-[#2D1B0E] break-words">{r.material_name || '—'}</div>
                  <div className="text-[#6B5744]">
                    <b className="text-[#2D1B0E]">{fq(r.bottles)} {pu}</b> at {inr(r.rate_paid_per_bottle)}/{pu} = {inr(r.total_paid)}
                    {r.cost_only && <CostOnlyNote r={r} />}
                  </div>
                  <div className="text-[#6B5744]">
                    Depot {st.unpriced ? <span className="text-amber-700">unknown — excess not computed</span>
                      : (r.depot_landed_per_bottle == null || r.excess_total == null)
                        ? <span className="text-[#8B7355]">priced — rate and excess are admin-only</span>
                        : <>{inr(r.depot_landed_per_bottle)}/{pu} · excess <span className="text-amber-800">{inr(r.excess_total)}</span></>}
                  </div>
                  <div className="text-[10px] text-[#8B7355] space-x-2">
                    {r.shop_name && <span>{r.shop_name}</span>}
                    {r.bill_ref && <span className="font-mono">bill {r.bill_ref}</span>}
                    {r.paid_by && <span>paid by {r.paid_by}</span>}
                  </div>
                  <RowActions r={r} onAction={onAction} canCorrect={canCorrect} />
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

/** A cost-only buy's bottles are a money fact, not stock: said beside the
 *  quantity so nobody reads the column as bottles that reached the shelf book. */
function CostOnlyNote({ r }: { r: Pick<RetailFlag, 'cost_only_count_date'> }) {
  return (
    <div data-cost-only="1" className="text-[10px] font-normal text-[#8B7355] whitespace-normal"
         title="A closing count already included these bottles, so this buy added no stock — its cost is recorded here only.">
      cost only — no stock added{r.cost_only_count_date ? ` (already in the ${r.cost_only_count_date} count)` : ''}
    </div>
  );
}

function Tile({ label, value, sub, tone = 'muted' }: { label: string; value: string; sub?: string; tone?: 'muted' | 'warn' }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl px-3 py-2.5">
      <div className="text-[10px] text-[#8B7355] leading-tight">{label}</div>
      <div className={`text-lg font-bold tabular-nums mt-0.5 ${tone === 'warn' ? 'text-amber-700' : 'text-[#2D1B0E]'}`}>{value}</div>
      {sub && <div className="text-[9px] text-[#B8A590] leading-tight mt-0.5">{sub}</div>}
    </div>
  );
}

/* ── The tab ─────────────────────────────────────────────────────────────── */

export default function WineShopRegister({ materials, canCorrect, refreshKey, onFlash }: {
  materials: UnitMat[];
  /** can_procure on any active store — offers Set depot rate / Change claim. */
  canCorrect: boolean;
  /** Bumped by the page when the Wine-shop Purchase modal records a buy. */
  refreshKey: number;
  onFlash: (msg: string) => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [openOnly, setOpenOnly] = useState(true);
  const [allOutlets, setAllOutlets] = useState(false);
  const [summary, setSummary] = useState<RetailSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams();
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      if (allOutlets) p.set('outlet', 'all');
      const res = await api(`/api/liquor/retail?${p.toString()}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setSummary(null); setErr(j?.error || `HTTP ${res.status}`); return; }
      setSummary(j.summary as RetailSummary);
    } catch (e: any) { setErr(e?.message || 'Network error — the register was not loaded.'); }
    finally { setLoading(false); }
  }, [from, to, allOutlets]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const rows = useMemo(
    () => (summary?.rows || []).filter(r => !openOnly || retailRowState(r).open),
    [summary, openOnly],
  );

  return (
    <div className="space-y-3">
      <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-3 text-[11px] text-[#6B5744] leading-relaxed flex items-start gap-2">
        <Siren className="w-4 h-4 shrink-0 mt-0.5 text-[#af4408]" />
        <span>
          Emergency buys from a wine shop, across every liquor store. <b>Pay back</b>{' '}closes a pending
          claim with a real petty-cash payout (the only way a claim becomes “Reimbursed”).{' '}
          <b>Set depot rate</b>{' '}prices a buy recorded before its brand was in the TGBCL Brand Map, so
          its excess is counted. <b>Change claim</b>{' '}corrects whether anyone is owed. None of these
          changes stock, average price or recipe costs.
          {!canCorrect && (
            <>{' '}<b>Set depot rate</b>{' '}and <b>Change claim</b>{' '}need purchase rights on the liquor store,
              which this login does not have — they are not shown.</>
          )}
          {summary?.depotFiguresNote && <>{' '}{summary.depotFiguresNote}</>}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Lbl>From</Lbl>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="From date"
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-sm bg-white" />
        </div>
        <div>
          <Lbl>To</Lbl>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="To date"
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-sm bg-white" />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-[#6B5744] pb-1.5">
          <input type="checkbox" checked={openOnly} onChange={e => setOpenOnly(e.target.checked)} />
          Open items only
        </label>
        <label className="flex items-center gap-1.5 text-xs text-[#6B5744] pb-1.5">
          <input type="checkbox" checked={allOutlets} onChange={e => setAllOutlets(e.target.checked)} />
          All outlets
        </label>
        {(from || to) && (
          <button onClick={() => { setFrom(''); setTo(''); }} className="text-xs text-[#af4408] hover:underline pb-1.5">clear dates</button>
        )}
        <button onClick={load} disabled={loading}
                className="ml-auto px-3 py-1.5 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm font-medium flex items-center gap-1.5 disabled:opacity-50">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
        </button>
      </div>

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {err}
        </div>
      )}

      {summary && summary.hiddenByOutletCount > 0 && !allOutlets && (
        <div className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-2.5 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>
            {summary.hiddenByOutletCount} buy{summary.hiddenByOutletCount === 1 ? '' : 's'} in this range
            belong{summary.hiddenByOutletCount === 1 ? 's' : ''} to another outlet (or to none) and{' '}
            {summary.hiddenByOutletCount === 1 ? 'is' : 'are'} not shown.{' '}
            <button onClick={() => setAllOutlets(true)} className="underline font-medium">Show all outlets</button>
          </span>
        </div>
      )}

      {loading && !summary ? (
        <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading wine-shop buys…</div>
      ) : summary ? (
        <RegisterView summary={summary} rows={rows} materials={materials} onAction={setAction} canCorrect={canCorrect} />
      ) : null}

      {action && (
        <ActionModal
          action={action}
          pu={puFor(action.row, new Map(materials.map(m => [m.id, m])))}
          onClose={() => setAction(null)}
          onDone={msg => { setAction(null); onFlash(msg); }}
          onRefresh={load}
        />
      )}
    </div>
  );
}

/* ── The three actions ───────────────────────────────────────────────────── */

function ActionModal({ action, pu, onClose, onDone, onRefresh }: {
  action: Action; pu: string;
  onClose: () => void; onDone: (msg: string) => void; onRefresh: () => void;
}) {
  const r = action.row;
  const st = retailRowState(r);
  const [date, setDate] = useState(todayIST());
  const [notes, setNotes] = useState('');
  const [rate, setRate] = useState('');
  const [target, setTarget] = useState<Exclude<ReimbStatus, 'reimbursed'>>(st.statusTargets[0] || 'not_required');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; code: string; status: number } | null>(null);
  /** What the server said on success — the modal stays open on it so an
   *  overdraft warning or the computed excess is SEEN, not flashed for 5s. */
  const [done, setDone] = useState<{ msg: string; detail?: string; warning?: string } | null>(null);
  const errRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (err) errRef.current?.scrollIntoView?.({ block: 'center' }); }, [err]);

  const nRate = Number(rate);
  const preview = rate.trim() !== '' && Number.isFinite(nRate) ? previewExcess(r.rate_paid_per_bottle, nRate, r.bottles) : null;
  const what = `${fq(r.bottles)} ${pu} × ${r.material_name || 'item'} (${r.shop_name || 'wine shop'}, ${r.date})`;

  const send = async () => {
    setErr(null);
    let url = `/api/liquor/retail/${encodeURIComponent(r.id)}`;
    let method: 'POST' | 'PATCH' = 'PATCH';
    let body: Record<string, unknown>;
    if (action.kind === 'pay') {
      if (date && date > todayIST()) { setErr({ text: 'The payout date cannot be in the future — enter the day the cash left the box.', code: 'client', status: 0 }); return; }
      url += '/reimburse'; method = 'POST';
      body = reimburseBody(r, date, notes);
    } else if (action.kind === 'price') {
      /* Below one paisa is not a rate: the route accepts > 0, the library
         rounds to 2dp and would store 0 — still "unknown", with an audit row
         claiming it was priced. Same floor as the Wine-shop Purchase modal. */
      if (!Number.isFinite(nRate) || nRate < 0.01) {
        setErr({ text: `Enter the depot landed ₹ per ${pu} (at least ₹0.01).`, code: 'client', status: 0 });
        return;
      }
      body = priceBody(nRate);
    } else {
      if (target === 'claimed_pending' && !r.paid_by.trim() && !notes.trim()) {
        setErr({ text: 'This buy names nobody as having paid. A pending claim is owed to a person — say who in the note.', code: 'client', status: 0 });
        return;
      }
      body = statusBody(target, notes);
    }
    setBusy(true);
    try {
      const res = await api(url, { method, body });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr({ text: j?.error || `HTTP ${res.status}`, code: String(j?.code || ''), status: res.status }); return; }
      if (action.kind === 'pay') {
        setDone({
          msg: `Paid back ${inr(Number(j.amount) || r.total_paid)} to ${r.paid_by || 'staff'} from petty cash (${j.date}) — claim closed.`,
          warning: j.warning,
        });
      } else if (action.kind === 'price') {
        // The server returns the recomputed excess to management only (it is
        // the rate paid minus the rate typed). Absent → say it was computed,
        // never print a ₹0 that reads as "no premium".
        const ex = j.excess;
        setDone({
          msg: `Depot rate set to ${inr(Number(j.depot_landed_per_bottle) || nRate)} per ${pu}.`,
          detail: ex
            ? `Excess now ${inr(Number(ex.excessTotal) || 0)} (${inr(Number(ex.excessPerBottle) || 0)} per ${pu}, ${fq(Number(ex.excessPct) || 0)}%) — counted in the “price of running out” total from now on.`
            : 'The excess was computed and is counted in the “price of running out” total from now on.',
        });
      } else {
        setDone({ msg: `Claim changed from “${STATUS_LABEL[(j.reimbursement_status_from || r.reimbursement_status) as ReimbStatus]}” to “${STATUS_LABEL[(j.reimbursement_status || target) as ReimbStatus]}”.` });
      }
      onRefresh();
    } catch (e: any) { setErr({ text: e?.message || 'Network error — nothing was changed.', code: 'network', status: 0 }); }
    finally { setBusy(false); }
  };

  const title = action.kind === 'pay' ? 'Pay back a wine-shop claim'
    : action.kind === 'price' ? 'Set the depot rate' : 'Change the claim';
  const cta = action.kind === 'pay' ? `Pay ${inr(r.total_paid)} from petty cash`
    : action.kind === 'price' ? 'Save depot rate' : 'Save claim';

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto"
         onClick={() => (done ? onDone(done.msg) : onClose())}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden"
           style={{ maxHeight: 'calc(100vh - 1.5rem)' }} onClick={e => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="px-4 sm:px-5 py-3 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">
            {action.kind === 'pay' ? <HandCoins className="w-5 h-5 text-[#af4408]" />
              : action.kind === 'price' ? <Tag className="w-5 h-5 text-[#af4408]" /> : <Pencil className="w-5 h-5 text-[#af4408]" />}
            {title}
          </div>
          <button onClick={() => (done ? onDone(done.msg) : onClose())} className="text-[#8B7355] hover:text-[#2D1B0E]" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-3 text-sm">
          <div className="text-[12px] text-[#6B5744]">
            <b className="text-[#2D1B0E]">{what}</b>
            {r.bill_ref && <> · bill <span className="font-mono">{r.bill_ref}</span></>}
            {' · '}paid {inr(r.rate_paid_per_bottle)}/{pu}{r.paid_by ? <> by <b>{r.paid_by}</b></> : null}
          </div>

          {err && (
            <div ref={errRef}
                 className={`rounded-lg p-2.5 text-sm flex items-start gap-2 ${err.status === 409
                   ? 'bg-amber-50 border border-amber-200 text-amber-900'
                   : 'bg-red-50 border border-red-200 text-red-700'}`}>
              {err.status === 409 ? <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
              <span>{err.text}</span>
            </div>
          )}

          {done ? (
            <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-3 space-y-2">
              <div className="flex items-start gap-2 font-semibold text-emerald-900 text-sm">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> <span>{done.msg}</span>
              </div>
              {done.detail && <div className="text-[12px] text-emerald-900">{done.detail}</div>}
              {/* The server's own overdraft sentence, verbatim. The payout is
                  recorded either way — the cash already left the box. */}
              {done.warning && (
                <div className="bg-amber-50 border border-amber-200 rounded p-2 text-[12px] text-amber-900 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /><span>{done.warning}</span>
                </div>
              )}
            </div>
          ) : action.kind === 'pay' ? (
            <>
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
                <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Owed{r.paid_by ? ` to ${r.paid_by}` : ''}</div>
                <div className="text-xl font-bold text-[#2D1B0E] tabular-nums">{inr(r.total_paid)}</div>
                <div className="text-[11px] text-[#6B5744]">{fq(r.bottles)} {pu} × {inr(r.rate_paid_per_bottle)}</div>
              </div>
              {st.reopened && (
                <div className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                  This claim was marked reimbursed, but the petty-cash payout behind it was deleted — so it is owed again.
                </div>
              )}
              <div className="text-[11px] text-[#6B5744] leading-relaxed">
                A payout closes the claim <b>in full</b>{' '}— the record has nowhere to keep a part-payment. The cash comes
                out of the petty-cash box of the outlet this buy was recorded at, and shows on the Petty Cash page.
                If the amount is not going to be paid, use <b>Change claim → Rejected</b>{' '}instead.
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Lbl>Date the cash left the box</Lbl>
                  <input type="date" value={date} max={todayIST()} onChange={e => setDate(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <Lbl>Note (optional)</Lbl>
                  <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. paid in cash at close" className={inputCls} />
                </div>
              </div>
              <div className="text-[10px] text-[#8B7355]">Needs Petty Cash access (Management or the Store Manager).</div>
            </>
          ) : action.kind === 'price' ? (
            <>
              <div className="text-[11px] text-[#6B5744] leading-relaxed">
                This buy was recorded with the depot rate <b>unknown</b>, so its excess was never computed and it is left
                out of the “price of running out” total. Enter what one {pu} costs from the TGBCL depot, landed. A rate is
                set <b>once</b>: after it is saved it is frozen, like a rate set when the buy was recorded.
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  {/* ₹ per PURCHASE unit, same basis as the rate paid. rate-basis: purchase */}
                  <Lbl>Depot landed ₹ per {pu}</Lbl>
                  <input type="number" min={0} step="0.01" inputMode="decimal" value={rate}
                         onChange={e => setRate(e.target.value)} placeholder="e.g. 3200" className={inputCls} />
                </div>
                <div className="text-[12px] text-[#6B5744] self-end pb-1">
                  {preview
                    ? <>Excess <b className="text-amber-800">{inr(preview.total)}</b>{' '}({inr(preview.per)} per {pu}, {fq(preview.pct)}%)</>
                    : <span className="text-[#8B7355]">The excess is computed when you save.</span>}
                </div>
              </div>
              <div className="text-[10px] text-[#8B7355]">
                The TGBCL Brand Map’s figure is ₹ per bottle; if a {pu} of this item is not a single bottle, enter the depot ₹ per {pu}.
              </div>
            </>
          ) : (
            <>
              <div>
                <Lbl>Claim is now</Lbl>
                <div className="mb-2"><StatusChip r={r} /></div>
                <Lbl>Change it to</Lbl>
                <select value={target} onChange={e => setTarget(e.target.value as typeof target)} className={inputCls}>
                  {st.statusTargets.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
                <div className="text-[10px] text-[#8B7355] mt-0.5">
                  {target === 'claimed_pending' ? 'someone fronted the money and is owed it back — it then shows a Pay back button'
                    : target === 'rejected' ? 'the claim was refused — nothing will be paid back'
                      : 'the house paid directly — nobody is owed anything'}
                </div>
              </div>
              <div>
                <Lbl>Why (kept in the audit log)</Lbl>
                <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. settled in cash outside the app" className={inputCls} />
              </div>
              <div className="text-[10px] text-[#8B7355]">
                “Reimbursed” is not on this list: it is set only by a real petty-cash payout (Pay back).
              </div>
            </>
          )}
        </div>

        <div className="px-4 sm:px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0 bg-white">
          {done ? (
            <button onClick={() => onDone(done.msg)}
                    className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold">
              Close
            </button>
          ) : (
            <>
              <button onClick={onClose} disabled={busy}
                      className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">
                Cancel
              </button>
              <button onClick={send} disabled={busy || (action.kind === 'status' && st.statusTargets.length === 0)}
                      className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
                {busy && <Loader2 className="w-4 h-4 animate-spin" />} {cta}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
