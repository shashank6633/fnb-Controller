'use client';

/**
 * Variance Approvals (ADMIN only).
 *
 * A closing physical count that disagrees with the system lands here as PENDING
 * — stock is NOT changed. The admin asks the staff who counted, records the
 * reason, and either APPROVES or REJECTS (stock stays; the variance stands as an
 * open loss to investigate). Route is adminOnly in the page catalog and every
 * API is admin-gated server-side.
 *
 * APPROVE IS A DELTA, NEVER AN ABSOLUTE SET — and this page must not say
 * otherwise. approveVariance() posts the COUNT-TIME difference
 * (physical − system-as-counted) on top of whatever the rail holds at the moment
 * the admin clicks, so the balance lands on the counted figure PLUS anything
 * that moved in between. Worked example: system 5,000 g, counted 10,000 g at
 * 10:00; a 2,000 g issue at 12:00 takes live stock to 3,000; approving at 16:00
 * gives 8,000 g, not 10,000. That is deliberate — see the header comment in
 * lib/variance-approval.ts for why it is the only reading under which stock
 * moves exactly once — and it holds on all three rails (central, liquor ledger,
 * department ledger), because each posts the count-time difference to its own.
 * This page used to promise the counted figure outright ("set stock to counted",
 * "If approved → physical"); it now labels that a projection and caveats it.
 *
 * TWO COUNTS ON ONE ITEM DOUBLE-APPLY — the queue must say so before the click.
 * Each pending row froze its OWN system figure, and the pending-unique index is
 * keyed per DATE, so two counts on two dates are two independent rows that both
 * froze the SAME baseline. Owner's measured case (Testing Curd 2, g/kg pack
 * 1000, live −997 g): 07-08 counted 997 → delta +1,994; 08-08 counted 11,000 →
 * delta +11,997. Approving 08-08 lands 11,000 g = 11 kg, the shelf. Approving
 * 07-08 on top lands 12,994 g — the −997 baseline corrected a second time, and
 * it overstates, i.e. it inflates in the direction that HIDES a shortage.
 * So the server refuses any count that a newer pending/approved one supersedes
 * (findSupersedingCount / varianceApprovalBlock), and this page renders that
 * refusal THREE ways: a queue-level banner from `stacked`, a "Superseded" pill
 * and amber notice per row, and a disabled Approve whose label names the reason.
 * Reject stays live on those rows — rejecting is exactly how a stale count is
 * meant to leave the queue, and it moves no stock.
 *
 * THE PROJECTION IS COMPUTED FROM LIVE STOCK WHERE THE SERVER CAN SUPPLY IT.
 * `live_stock` arrives per row on its OWN rail (central → raw_materials.current_stock,
 * liquor → its store-ledger on-hand, department → null, because a dept balance
 * has no set-based source and guessing one would be wrong on that whole rail).
 * Where it is non-null the tile shows live + (physical − system), which is where
 * approval actually lands; where it is null the old count-time figure and its
 * caveat stay. A stale projection is what made the owner trust a number that had
 * already been overtaken — do not print one that cannot be computed.
 *
 * GET  /api/variance-approvals?status=pending|approved|rejected|all
 *        → { approvals, pending_count, stacked, … }
 * POST /api/variance-approvals/[id]/approve  { reason }
 * POST /api/variance-approvals/[id]/reject   { reason }
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  ScrollText, ShieldCheck, Loader2, RefreshCw, CheckCircle2, XCircle,
  AlertTriangle, Info, Lock, PackageX, PackagePlus, Store, Boxes, Layers,
} from 'lucide-react';
import { packFactor, toPurchaseQty, type PackMeta } from '@/lib/pack-units';

interface Approval {
  id: string; source: 'central' | 'liquor'; material_id: string; material_name: string; material_sku: string;
  store_id: string; store_name: string; department_id: string; department_name: string;
  date: string; system_stock: number; physical_stock: number; variance: number; variance_value: number;
  unit: string; counted_by: string; count_note: string;
  status: string; reviewed_by: string; reviewed_at: string; review_reason: string; created_at: string;
  /**
   * Server-side refusal reason for Approve, verbatim — the SAME sentence the
   * approve API answers with, so the queue can never offer a click the server
   * rejects. Two families now reach it: a department count that has no honest
   * ledger to correct, and a count SUPERSEDED by a newer one. Rendered as-is; do
   * not re-word it here or the page and the API start telling different stories.
   */
  approve_blocked?: string | null;
  /**
   * The newest count competing with this row, or null when this row IS newest.
   * Non-null ⇒ `approve_blocked` is already the supersede sentence; these two
   * exist so the page can say WHICH count wins without parsing that sentence.
   */
  superseded_by_date?: string | null;
  superseded_by_status?: 'pending' | 'approved' | null;
  /**
   * Live on-hand for THIS ROW'S rail, in the same recipe-unit basis as
   * system_stock / physical_stock beside it. null on department rows — an
   * honest gap, not a zero: never coerce it with `|| 0`, that would render a
   * confident "projected 0" on every department count.
   */
  live_stock?: number | null;
}

/** One material carrying more than one pending count — GET → `stacked`. */
interface StackedItem {
  material_id: string;
  material_name: string;
  pending_count: number;
  latest_date: string;
}

/** How many stacked items the banner names before it rolls up the rest. */
const STACKED_SHOWN = 8;
/** 3 dp — the rounding approveVariance applies to the delta it posts. */
const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
/** Float slack. Below this, live and the frozen system figure are the same number. */
const EPS = 1e-6;

const inr = (v: number) => '₹' + Math.abs(Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const qty = (v: number) => Number(Number(v || 0).toFixed(3)).toLocaleString('en-IN');
/**
 * The two pack fields listVarianceApprovals() joins on but `Approval` above has
 * never declared. Optional on purpose: a cached pre-conversion payload can
 * arrive without them, and packFactor() already degrades to 1 (no conversion)
 * when they are missing — which is the honest reading, not a silent divide.
 */
type ApprovalWire = Approval & { material_purchase_unit?: string; material_pack_size?: number };
/** Pack meta for the purchase-unit display layer, read in ONE place. */
const metaOf = (r: Approval): PackMeta => ({
  unit: r.unit,
  purchase_unit: (r as ApprovalWire).material_purchase_unit,
  pack_size: (r as ApprovalWire).material_pack_size,
});
/** Purchase unit to print beside a converted quantity (falls back to recipe). */
const puOf = (r: Approval): string => (r as ApprovalWire).material_purchase_unit || r.unit;
function istWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('Z') || iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return iso || '—';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}

export default function VarianceApprovalsPage() {
  const [tab, setTab] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [rows, setRows] = useState<Approval[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  // Queue-level, NOT derived from `rows`. The list carries a LIMIT (500) while
  // stackedPendingCounts() sweeps every pending row, so deriving this client-side
  // would go quiet on exactly the overflow the limit hides — and that overflow is
  // the OLDEST pending counts, i.e. the ones most likely to be superseded.
  const [stacked, setStacked] = useState<StackedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await fetch(`/api/variance-approvals?status=${tab}`);
      if (r.status === 401 || r.status === 403) { setForbidden(true); setRows([]); setStacked([]); return; }
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || 'Failed to load');
      setRows(j.approvals || []);
      setPendingCount(j.pending_count || 0);
      // Array.isArray, not `|| []`: an older cached/proxied payload that predates
      // this field must clear the banner, not leave the previous tab's warning
      // sitting over a queue it no longer describes.
      setStacked(Array.isArray(j.stacked) ? j.stacked : []);
    } catch (e) { setLoadError((e as Error).message); }
    finally { setLoading(false); }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  const decide = async (row: Approval, action: 'approve' | 'reject') => {
    // The server refuses some approvals outright — a department count with no
    // honest ledger to correct, and a count superseded by a newer one. Both
    // arrive pre-resolved as `approve_blocked`, so mirror it here and the click
    // never leaves the page. Reject is NEVER gated: it moves no stock, and it is
    // how a superseded count is supposed to leave the queue.
    if (action === 'approve' && row.approve_blocked) { flash(row.approve_blocked); return; }
    const reason = (reasons[row.id] || '').trim();
    if (reason.length < 2) { flash('Enter a reason first — ask the staff what caused it.'); return; }
    setBusy(row.id);
    try {
      const res = await api(`/api/variance-approvals/${row.id}/${action}`, { method: 'POST', body: { reason } });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Failed');
      // NO RESULTING FIGURE IN THIS TOAST. It used to read "stock set to
      // <physical>", which is the absolute-set claim the approval does not make
      // (see the delta note at the top of this file). The approve route replies
      // { ok, applied } and nothing more, so the balance the item actually
      // landed on is not knowable here — naming the counted figure again would
      // just repeat the old promise. Say what was applied instead.
      flash(action === 'approve'
        ? `Approved — ${row.material_name}: counted difference applied to live stock`
        : `Rejected — ${row.material_name} stock unchanged; logged as an open loss`);
      setReasons(p => { const n = { ...p }; delete n[row.id]; return n; });
      await load();
    } catch (e) { flash((e as Error).message); }
    finally { setBusy(null); }
  };

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 max-w-md text-center">
          <Lock className="w-10 h-10 text-[#af4408] mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-[#2D1B0E] mb-1">Admins only</h1>
          <p className="text-sm text-[#8B7355]">Variance approvals decide whether stock changes, so only admins can review them.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-3">
              <ScrollText className="w-7 h-7" /> Variance Approvals
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Physical counts that disagree with the system wait here. Nothing changes stock until you approve.
            </p>
          </div>
          <button onClick={load} disabled={loading}
                  className="self-start inline-flex items-center gap-2 px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm text-[#6B5744] hover:bg-white disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
          </button>
        </div>

        {/* How it works */}
        <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 text-[12px] text-[#6B5744] flex gap-2">
          <ShieldCheck className="w-4 h-4 text-[#af4408] shrink-0 mt-0.5" />
          <span>
            <b>Approve</b> = the count is correct → the counted difference is applied to live stock (loss written off with your reason).
            It lands on the counted number only if nothing has moved since the count.
            <b className="ml-2">Reject</b> = keep system stock → the shortage stands as an open loss to chase. Staff never see the system number, so the count is blind.
            {/* "per item" ALONE WOULD BE FALSE AND EXPENSIVE. The supersede key
                is (source, material, store, department) — Curd counted in the
                kitchen and Curd counted centrally are two rails with two
                independent baselines, and BOTH are legitimately approvable.
                stackedPendingCounts deliberately refuses to conflate them; this
                strip must not put the conflation back in prose, or an admin
                rejects a good count and leaves a real shortage un-booked. */}
            <b className="ml-2">Only the newest count per item, per store or department, can be approved</b> — an older one for the same place would apply the same correction twice, so reject it. The same item counted in two different places is two separate counts, and both can be approved.
          </span>
        </div>

        {/* Tabs */}
        <div className="flex gap-2">
          {(['pending', 'approved', 'rejected'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
                    className={`px-3.5 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      tab === t ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
              {t === 'pending' && pendingCount > 0 && (
                <span className={`ml-2 px-1.5 py-0.5 rounded-full text-[11px] font-bold ${tab === t ? 'bg-white/25' : 'bg-red-100 text-red-700'}`}>{pendingCount}</span>
              )}
            </button>
          ))}
        </div>

        {loadError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> {loadError}
          </div>
        )}

        {/* STACKED COUNTS — the queue-level headline of the double-apply.
            Working 963 pending rows top-to-bottom is the natural thing to do and
            is exactly what breaks: an item holding two counts corrects the same
            frozen baseline twice, and it overstates, which hides a shortage.
            Every one of those rows is individually refused below, but a refusal
            you only meet on the row you happen to open is not a warning — this
            names the items up front so the admin can go straight to them.
            Server-ordered newest date first; NOT re-sorted here.
            `stacked` is empty on the approved/rejected tabs (nothing is pending
            there to stack), so no tab check is needed — but it is hidden while
            loading, because the array in state still describes the previous
            read. It is also queue-wide while the list below carries a LIMIT, so
            the copy never promises that every named item is visible in it. */}
        {!loading && stacked.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 text-[12px] text-amber-900">
            <div className="flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="font-semibold text-[13px]">
                  {stacked.length} item{stacked.length === 1 ? ' has' : 's have'} more than one pending count.
                </div>
                <p className="mt-0.5 leading-relaxed">
                  Each count froze its own system figure, so approving two of them applies the same correction
                  twice — and it overstates, which hides a shortage. <b>Approve the newest count for each item
                  and reject the older ones.</b>
                </p>
                <ul className="mt-2 space-y-0.5">
                  {stacked.slice(0, STACKED_SHOWN).map(s => (
                    <li key={s.material_id} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{s.material_name || s.material_id}</span>
                      <span className="text-amber-800">
                        {s.pending_count} counts · newest {s.latest_date}
                      </span>
                    </li>
                  ))}
                </ul>
                {stacked.length > STACKED_SHOWN && (
                  <div className="mt-1 text-amber-800">
                    +{stacked.length - STACKED_SHOWN} more item{stacked.length - STACKED_SHOWN === 1 ? '' : 's'} with
                    stacked counts.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-[#8B7355] text-sm py-10 justify-center">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-10 text-center text-[#8B7355]">
            <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
            <p className="font-medium text-[#2D1B0E]">Nothing {tab}.</p>
            {tab === 'pending' && <p className="text-sm mt-1">All counts reconcile with the system — no variances to review.</p>}
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map(row => {
              const shortage = row.variance < 0;
              const decided = row.status !== 'pending';
              const meta = metaOf(row);
              const pu = puOf(row);
              /** Recipe qty → the purchase-unit string this page prints. */
              const pq = (v: number) => `${qty(toPurchaseQty(v, meta))} ${pu}`;
              // Each figure is quoted more than once below, so derive it once —
              // the readings cannot then drift between tile and caveat.
              const countedTxt = pq(row.physical_stock);
              const systemTxt = pq(row.system_stock);

              // SUPERSEDED. Non-null ⇒ approve_blocked already carries the
              // server's refusal sentence; these two only name which count wins.
              // Shown on PENDING rows only: a decided row has no click left to
              // warn about, and marking a settled row "Superseded" is noise.
              const supDate = !decided ? (row.superseded_by_date || null) : null;
              const supStatus = row.superseded_by_status || null;

              // LIVE-BASED PROJECTION — where approval actually lands.
              // `live_stock` is null on department rows, and null is an answer:
              // typeof-checked rather than `|| 0`, because a coerced zero would
              // print a confident "projected 0" on every department count.
              // ADDED IN RECIPE UNITS, CONVERTED ONCE (pack-units rule: never sum
              // rounded purchase-basis derivatives), and r3 to match the delta
              // approveVariance actually posts.
              const live = typeof row.live_stock === 'number' && Number.isFinite(row.live_stock)
                ? row.live_stock : null;
              const delta = r3(row.physical_stock - row.system_stock);
              const projected = live === null ? null : r3(live + delta);
              // PENDING ONLY. On the approved tab "if approved" is already
              // answered, and live + delta would there read as applying the same
              // correction a SECOND time — the exact figure this fix exists to
              // stop showing. Decided rows keep the count-time tile untouched.
              const useLive = !decided && projected !== null;
              const moved = live !== null && Math.abs(live - row.system_stock) > EPS;
              return (
                <div key={row.id} className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-[#2D1B0E]">{row.material_name}</span>
                        {row.material_sku && <span className="text-[11px] text-[#B0987F]">#{row.material_sku}</span>}
                        <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border bg-[#FFF8F0] border-[#E8D5C4] text-[#6B5744]">
                          {row.source === 'liquor' ? <Store className="w-3 h-3" /> : <Boxes className="w-3 h-3" />}
                          {row.source === 'liquor' ? (row.store_name || 'Store') : (row.department_name || 'Store / Overall')}
                        </span>
                        {/* Scannable mark of the refusal. 963 pending rows are
                            read by scrolling, not by opening each card, so the
                            verdict has to be visible in the row header too. */}
                        {supDate && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border bg-amber-50 border-amber-200 text-amber-900">
                            <Layers className="w-3 h-3" /> Superseded
                          </span>
                        )}
                      </div>
                      <div className="text-[12px] text-[#8B7355] mt-0.5">
                        Count date {row.date} · counted by {row.counted_by || '—'}
                        {row.count_note && <> · note: <span className="italic">{row.count_note}</span></>}
                      </div>
                    </div>
                    <div className={`text-right shrink-0 ${shortage ? 'text-red-700' : 'text-emerald-700'}`}>
                      <div className="inline-flex items-center gap-1 font-semibold">
                        {shortage ? <PackageX className="w-4 h-4" /> : <PackagePlus className="w-4 h-4" />}
                        {shortage ? 'Shortage' : 'Surplus'} {inr(row.variance_value)}
                      </div>
                      <div className="text-[12px]">{row.variance > 0 ? '+' : '−'}{qty(toPurchaseQty(Math.abs(row.variance), { unit: row.unit, purchase_unit: (row as any).material_purchase_unit, pack_size: (row as any).material_pack_size }))} {(row as any).material_purchase_unit || row.unit}</div>
                    </div>
                  </div>

                  {/* System vs physical (admin sees the system number here — the review is where it belongs) */}
                  <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg py-2">
                      <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">System</div>
                      <div className="font-semibold" title={packFactor({ unit: row.unit, purchase_unit: (row as any).material_purchase_unit, pack_size: (row as any).material_pack_size }) > 1 ? `= ${qty(row.system_stock)} ${row.unit}` : undefined}>{qty(toPurchaseQty(row.system_stock, { unit: row.unit, purchase_unit: (row as any).material_purchase_unit, pack_size: (row as any).material_pack_size }))} <span className="text-[11px] font-normal text-[#8B7355]">{(row as any).material_purchase_unit || row.unit}</span></div>
                    </div>
                    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg py-2">
                      <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Counted</div>
                      <div className="font-semibold">{qty(toPurchaseQty(row.physical_stock, { unit: row.unit, purchase_unit: (row as any).material_purchase_unit, pack_size: (row as any).material_pack_size }))} <span className="text-[11px] font-normal text-[#8B7355]">{(row as any).material_purchase_unit || row.unit}</span></div>
                    </div>
                    <div className={`rounded-lg py-2 border ${shortage ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
                      {/* PROJECTION, NOT A PROMISE. This tile read "If approved
                          → <physical>", which is the absolute set approval does
                          not do. It then read the counted figure with an
                          unconditional "only if nothing moved since" caveat,
                          because no live balance reached the page.
                          IT NOW DOES, PER RAIL (`live_stock`), so where the
                          server can supply one this prints the real landing
                          figure — live + (physical − system) — and the caveat
                          below turns into the actual arithmetic. Department rows
                          still arrive null and keep the count-time figure and
                          the old caveat: a dept balance has no set-based source,
                          and rm.current_stock is the CENTRAL pool, so borrowing
                          it here would look authoritative and be wrong on that
                          whole rail. Print nothing you cannot compute. */}
                      {/* A BLOCKED ROW GETS NO FORECAST. The tile is what a
                          scanner reads, and on a superseded row it was printing
                          a confident "If approved → 12.994 kg" in the same
                          styling an approvable row uses — for an approval the
                          server refuses outright. The number was arithmetically
                          right and the framing was a lie, which is the exact
                          defect this whole change exists to remove. Say the
                          state instead; the amber block below explains it. */}
                      {row.approve_blocked ? (
                        <>
                          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Not approvable</div>
                          <div className="font-semibold text-[#8B7355]">—</div>
                          <div className="text-[9px] text-[#B8A590] leading-tight">reject this one</div>
                        </>
                      ) : (
                        <>
                          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">If approved · projected</div>
                          <div className="font-semibold">→ {qty(toPurchaseQty(useLive ? projected! : row.physical_stock, meta))} <span className="text-[11px] font-normal text-[#8B7355]">{pu}</span></div>
                          <div className="text-[9px] text-[#B8A590] leading-tight">
                            {useLive
                              ? (moved ? `from live ${pq(live!)}` : 'live stock unchanged since the count')
                              : 'only if nothing moved since'}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* THE CAVEAT USED TO BE UNCONDITIONAL — it no longer has to be.
                      It said "it lands on the counted figure plus anything that
                      moved since, go and look" because the list API sent no live
                      balance and a guessed one would have put back exactly the
                      confident-but-wrong number this card was fixed to stop
                      showing. `live_stock` now arrives PER RAIL (central →
                      raw_materials.current_stock, liquor → its store-ledger
                      on-hand), so for those two rails the page states the
                      arithmetic instead of asking the admin to go and do it.
                      DEPARTMENT ROWS STILL GET THE OLD WORDING, unchanged, and
                      that stays right: live_stock is null there because a dept
                      balance comes from deptOnHand()'s per-row window with no
                      set-based form, and its landing figure is
                      counted + movements-since, which this page cannot compute.
                      Do not "finish" it with rm.current_stock — that is the
                      CENTRAL pool and would be wrong on every department row.
                      SHOWN ONLY WHERE APPROVE IS LIVE. A decided row has no
                      click left to inform, and a blocked row cannot be approved
                      at all — there, the amber refusal below is the whole
                      message and stacking a second notice above it would bury
                      the one that matters, so a superseded row carries its live
                      figure inside that amber block instead. */}
                  {!decided && !row.approve_blocked && (
                    <div className="mt-3 bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-2.5 text-[11px] leading-relaxed text-[#6B5744] flex gap-2">
                      <Info className="w-3.5 h-3.5 text-[#af4408] shrink-0 mt-0.5" />
                      {live === null ? (
                        <span>
                          Approving applies the counted <b>difference</b> to the balance as it stands when you click —
                          it does not force the balance to {countedTxt}. It lands on {countedTxt} plus anything that has
                          moved since the count on {row.date}, so if this item was issued, received or transferred after
                          that date the result differs by exactly that much. Worth a look at its movement since {row.date}
                          before you approve.
                        </span>
                      ) : moved ? (
                        <span>
                          <b>Stock has moved since the count on {row.date}.</b> Live now reads {pq(live)}, not the{' '}
                          {systemTxt} this count froze. Approving applies the counted <b>difference</b> of{' '}
                          {delta > 0 ? '+' : '−'}{pq(Math.abs(delta))} to live, landing on <b>{pq(projected!)}</b> — not
                          on the counted {countedTxt}. Check what moved before you approve.
                        </span>
                      ) : (
                        <span>
                          Nothing has moved since the count on {row.date} — live stock still reads {systemTxt}, so
                          approving lands on the counted {countedTxt}. It applies the counted <b>difference</b>, not an
                          absolute, so if something moves before you click the result shifts by exactly that much.
                        </span>
                      )}
                    </div>
                  )}

                  {decided ? (
                    <div className="mt-3 text-[12px] border-t border-[#F0E4D6] pt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className={`inline-flex items-center gap-1 font-medium ${row.status === 'approved' ? 'text-emerald-700' : 'text-red-700'}`}>
                        {row.status === 'approved' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                        {row.status === 'approved' ? 'Approved' : 'Rejected'}
                      </span>
                      <span className="text-[#8B7355]">by {row.reviewed_by || '—'} · {istWhen(row.reviewed_at)}</span>
                      {row.review_reason && <span className="text-[#6B5744]">Reason: <span className="italic">{row.review_reason}</span></span>}
                    </div>
                  ) : (
                    <div className="mt-3 border-t border-[#F0E4D6] pt-3 space-y-2">
                      {/* THE REFUSAL, IN THE PAGE'S EXISTING AMBER LANGUAGE — the
                          department block already looked like this and is
                          untouched. A superseded row adds two things around the
                          SAME server sentence and never rewrites it: a heading
                          naming the count that wins, and (where the rail can
                          supply a live balance) the figure approving anyway
                          would actually produce. That figure is the owner's case
                          made visible — Testing Curd 2 lands on 12.994 kg when
                          11 kg is on the shelf. */}
                      {row.approve_blocked && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[12px] text-amber-900 flex gap-2">
                          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                          <span>
                            {supDate && (
                              <b className="block mb-0.5">
                                Superseded — {supStatus === 'approved'
                                  ? `the newer count dated ${supDate} was already approved.`
                                  : `a newer count dated ${supDate} is still pending.`}
                              </b>
                            )}
                            {row.approve_blocked}
                            {/* Compare the RENDERED STRINGS, not the raw numbers.
                                EPS = 1e-6 is a recipe-unit threshold while pq()
                                prints 3 dp of the PURCHASE unit (÷ pack_size, so
                                ÷1000 for g→kg). A 0.4 g gap cleared 1e-6 and then
                                printed "would land this item on 11 kg against a
                                counted 11 kg" — a sentence arguing with itself.
                                Gating on the strings makes that unreachable by
                                construction, whatever the pack size. */}
                            {supDate && projected !== null && pq(projected) !== countedTxt && (
                              <span className="block mt-1">
                                Approving it anyway would land this item on <b>{pq(projected)}</b> against a counted{' '}
                                {countedTxt}.
                              </span>
                            )}
                          </span>
                        </div>
                      )}
                      <input
                        value={reasons[row.id] || ''}
                        onChange={e => setReasons(p => ({ ...p, [row.id]: e.target.value }))}
                        placeholder="Reason (ask the staff who counted — e.g. spillage, breakage, miscount, theft…)"
                        className="w-full px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]"
                      />
                      <div className="flex flex-wrap gap-2 justify-end">
                        {/* REJECT IS NEVER GATED and, on a superseded row, it is
                            the action — so there it takes the solid treatment
                            the (disabled) Approve can no longer carry. Only
                            there: a department-blocked row keeps the outline it
                            has always had. DOM order is unchanged either way, so
                            the buttons never swap under a hand already moving. */}
                        <button onClick={() => decide(row, 'reject')} disabled={busy === row.id}
                                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm border disabled:opacity-50 ${
                                  supDate
                                    ? 'font-semibold bg-red-600 border-red-600 text-white hover:bg-red-700'
                                    : 'font-medium border-red-300 text-red-700 hover:bg-red-50'}`}>
                          {busy === row.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />} Reject (keep stock)
                        </button>
                        <button onClick={() => decide(row, 'approve')} disabled={busy === row.id || !!row.approve_blocked}
                                title={row.approve_blocked || undefined}
                                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white disabled:opacity-50 disabled:cursor-not-allowed">
                          {busy === row.id ? <Loader2 className="w-4 h-4 animate-spin" /> : row.approve_blocked ? <Lock className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                          {/* NOT "set stock to counted" — approval posts the
                              count-time difference, it does not set an absolute.
                              `disabled` above is the real gate (and decide()
                              re-checks it); this label only has to say WHICH
                              refusal, and there are now two. Keyed off supDate
                              rather than sniffing the message text, so a reworded
                              server sentence cannot mislabel the button. */}
                          {supDate
                            ? 'Approve blocked (superseded count)'
                            : row.approve_blocked
                              ? 'Approve blocked (department count)'
                              : 'Approve → apply counted difference'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-lg shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
