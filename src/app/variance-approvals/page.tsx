'use client';

/**
 * Variance Approvals (ADMIN only).
 *
 * A closing physical count that disagrees with the system lands here as PENDING
 * — stock is NOT changed. The admin asks the staff who counted, records the
 * reason, and either APPROVES (stock → physical count) or REJECTS (stock stays;
 * the variance stands as an open loss to investigate). Route is adminOnly in the
 * page catalog and every API is admin-gated server-side.
 *
 * GET  /api/variance-approvals?status=pending|approved|rejected|all
 * POST /api/variance-approvals/[id]/approve  { reason }
 * POST /api/variance-approvals/[id]/reject   { reason }
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  ScrollText, ShieldCheck, Loader2, RefreshCw, CheckCircle2, XCircle,
  AlertTriangle, Lock, PackageX, PackagePlus, Store, Boxes,
} from 'lucide-react';

interface Approval {
  id: string; source: 'central' | 'liquor'; material_id: string; material_name: string; material_sku: string;
  store_id: string; store_name: string; department_id: string; department_name: string;
  date: string; system_stock: number; physical_stock: number; variance: number; variance_value: number;
  unit: string; counted_by: string; count_note: string;
  status: string; reviewed_by: string; reviewed_at: string; review_reason: string; created_at: string;
}

const inr = (v: number) => '₹' + Math.abs(Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const qty = (v: number) => Number(Number(v || 0).toFixed(3)).toLocaleString('en-IN');
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
    const reason = (reasons[row.id] || '').trim();
    if (reason.length < 2) { flash('Enter a reason first — ask the staff what caused it.'); return; }
    setBusy(row.id);
    try {
      const res = await api(`/api/variance-approvals/${row.id}/${action}`, { method: 'POST', body: { reason } });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Failed');
      flash(action === 'approve'
        ? `Approved — ${row.material_name} stock set to ${qty(row.physical_stock)} ${row.unit}`
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
            <b>Approve</b> = the count is correct → stock is set to the counted number (loss written off with your reason).
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
                      <div className="text-[12px]">{row.variance > 0 ? '+' : '−'}{qty(Math.abs(row.variance))} {row.unit}</div>
                    </div>
                  </div>

                  {/* System vs physical (admin sees the system number here — the review is where it belongs) */}
                  <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg py-2">
                      <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">System</div>
                      <div className="font-semibold">{qty(row.system_stock)} <span className="text-[11px] font-normal text-[#8B7355]">{row.unit}</span></div>
                    </div>
                    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg py-2">
                      <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Counted</div>
                      <div className="font-semibold">{qty(row.physical_stock)} <span className="text-[11px] font-normal text-[#8B7355]">{row.unit}</span></div>
                    </div>
                    <div className={`rounded-lg py-2 border ${shortage ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
                      <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">If approved</div>
                      <div className="font-semibold">→ {qty(row.physical_stock)} <span className="text-[11px] font-normal text-[#8B7355]">{row.unit}</span></div>
                    </div>
                  </div>

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
                        <button onClick={() => decide(row, 'approve')} disabled={busy === row.id}
                                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white disabled:opacity-50">
                          {busy === row.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Approve → set stock to counted
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
