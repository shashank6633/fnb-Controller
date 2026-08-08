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
 * GET  /api/variance-approvals?status=pending|approved|rejected|all
 * POST /api/variance-approvals/[id]/approve  { reason }
 * POST /api/variance-approvals/[id]/reject   { reason }
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  ScrollText, ShieldCheck, Loader2, RefreshCw, CheckCircle2, XCircle,
  AlertTriangle, Info, Lock, PackageX, PackagePlus, Store, Boxes,
} from 'lucide-react';
import { packFactor, toPurchaseQty, type PackMeta } from '@/lib/pack-units';

interface Approval {
  id: string; source: 'central' | 'liquor'; material_id: string; material_name: string; material_sku: string;
  store_id: string; store_name: string; department_id: string; department_name: string;
  date: string; system_stock: number; physical_stock: number; variance: number; variance_value: number;
  unit: string; counted_by: string; count_note: string;
  status: string; reviewed_by: string; reviewed_at: string; review_reason: string; created_at: string;
  /** Server-side refusal reason for Approve (department count vs central stock). */
  approve_blocked?: string | null;
}

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
      if (r.status === 401 || r.status === 403) { setForbidden(true); setRows([]); return; }
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || 'Failed to load');
      setRows(j.approvals || []);
      setPendingCount(j.pending_count || 0);
    } catch (e) { setLoadError((e as Error).message); }
    finally { setLoading(false); }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  const decide = async (row: Approval, action: 'approve' | 'reject') => {
    // Approving a department count would overwrite CENTRAL stock — the server
    // refuses it; mirror that here so the click never leaves the page. Reject is
    // always allowed: it moves no stock.
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
              // The counted figure in purchase units. Quoted twice in the caveat
              // below, so derive it once — the two readings cannot then drift.
              const countedTxt = `${qty(toPurchaseQty(row.physical_stock, metaOf(row)))} ${puOf(row)}`;
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
                          not do. The honest reading of the same number is "where
                          it lands if nothing has moved since the count" — the
                          count-time projection — so it is labelled as one. */}
                      <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">If approved · projected</div>
                      <div className="font-semibold">→ {qty(toPurchaseQty(row.physical_stock, metaOf(row)))} <span className="text-[11px] font-normal text-[#8B7355]">{puOf(row)}</span></div>
                      <div className="text-[9px] text-[#B8A590] leading-tight">only if nothing moved since</div>
                    </div>
                  </div>

                  {/* WHY THIS CAVEAT IS UNCONDITIONAL — and what would retire it.
                      The useful warning is the narrow one: flag only the rows
                      where stock HAS moved since the count, and print the real
                      projection beside the counted figure. That needs the LIVE
                      balance per row, and the list API sends none —
                      listVarianceApprovals() selects va.*, rm.name, rm.sku,
                      rm.purchase_unit, rm.pack_size and the two names, so there
                      is no rm.current_stock, no store-ledger on-hand and no
                      deptOnHand to compare against. Guessing one would put back
                      exactly the confident-but-wrong number this tile was fixed
                      to stop showing, so the page names the uncertainty instead.
                      WHEN ADDING THAT FIELD, RESOLVE IT PER RAIL. Do not reach
                      for a generic materials endpoint: raw_materials.current_stock
                      is the CENTRAL rail only. A liquor row's live balance is its
                      store_stock_ledger on-hand and a department row's is its
                      dept-ledger balance, so that shortcut would be wrong on two
                      of the three rails while looking authoritative on all three.
                      SHOWN ONLY WHERE APPROVE IS LIVE. A decided row has no
                      click left to inform, and a blocked row cannot be approved
                      at all — there, the amber refusal below is the whole
                      message and stacking a second notice above it would bury
                      the one that matters. */}
                  {!decided && !row.approve_blocked && (
                    <div className="mt-3 bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-2.5 text-[11px] leading-relaxed text-[#6B5744] flex gap-2">
                      <Info className="w-3.5 h-3.5 text-[#af4408] shrink-0 mt-0.5" />
                      <span>
                        Approving applies the counted <b>difference</b> to the balance as it stands when you click —
                        it does not force the balance to {countedTxt}. It lands on {countedTxt} plus anything that has
                        moved since the count on {row.date}, so if this item was issued, received or transferred after
                        that date the result differs by exactly that much. Worth a look at its movement since {row.date}
                        before you approve.
                      </span>
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
                      {row.approve_blocked && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[12px] text-amber-900 flex gap-2">
                          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                          <span>{row.approve_blocked}</span>
                        </div>
                      )}
                      <input
                        value={reasons[row.id] || ''}
                        onChange={e => setReasons(p => ({ ...p, [row.id]: e.target.value }))}
                        placeholder="Reason (ask the staff who counted — e.g. spillage, breakage, miscount, theft…)"
                        className="w-full px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]"
                      />
                      <div className="flex flex-wrap gap-2 justify-end">
                        <button onClick={() => decide(row, 'reject')} disabled={busy === row.id}
                                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50">
                          {busy === row.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />} Reject (keep stock)
                        </button>
                        <button onClick={() => decide(row, 'approve')} disabled={busy === row.id || !!row.approve_blocked}
                                title={row.approve_blocked || undefined}
                                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white disabled:opacity-50 disabled:cursor-not-allowed">
                          {busy === row.id ? <Loader2 className="w-4 h-4 animate-spin" /> : row.approve_blocked ? <Lock className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                          {/* NOT "set stock to counted" — approval posts the
                              count-time difference, it does not set an absolute.
                              The blocked label is unchanged. */}
                          {row.approve_blocked ? 'Approve blocked (department count)' : 'Approve → apply counted difference'}
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
