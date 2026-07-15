'use client';

/**
 * Discount Approvals — remote approval inbox for bill-discount requests.
 *
 * A cashier on the Captain app files a request (pct + reason); it lands here
 * (and in the notification bell). A Manager / Admin / HOD can Approve (applies
 * the discount to the order exactly like the at-the-till approver-login flow)
 * or Reject with an optional note. Below the queue: the last 20 decisions.
 *
 * Server enforces the gate (admin | manager tier | is_head_chef) on both the
 * list and the decide action; this page mirrors it for a friendly message.
 * Mobile-first: single-column cards, big touch targets. Polls every 20s.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  BadgePercent, Loader2, CheckCircle2, X, RefreshCw, ShieldAlert, Clock, User,
} from 'lucide-react';
import { api } from '@/lib/api';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');

interface DiscReq {
  id: string; order_id: string; requested_by: string; requester_name: string;
  kind?: string; requested_pct: number; reason: string; status: string;
  decided_by: string; decided_note: string; decided_at: string | null; created_at: string;
  order_number: number; order_type: string; order_status: string;
  order_subtotal: number; order_total: number; order_discount_pct: number;
  table_number: string | null; zone: string | null;
  impact_amount: number;
}

// SQLite datetime('now') is UTC without a zone marker → parse as UTC.
function ageOf(ts: string | null): string {
  if (!ts) return '';
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
  const ms = Date.now() - Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z');
  if (!Number.isFinite(ms)) return '';
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function DiscountApprovalsPage() {
  const [me, setMe] = useState<any | null | undefined>(undefined);   // undefined = loading
  const [pending, setPending] = useState<DiscReq[]>([]);
  const [history, setHistory] = useState<DiscReq[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);             // request id being decided
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Reject flow: which request has its note box open + the note text.
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2500); };

  const isApprover = !!me && (me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef);

  const load = useCallback(async () => {
    try {
      const r = await api('/api/dine-in/discount-requests');
      const j = await r.json();
      if (r.ok) {
        setPending(Array.isArray(j.pending) ? j.pending : []);
        setHistory(Array.isArray(j.history) ? j.history : []);
        setError(null);
      } else if (r.status !== 403) {
        setError(j.error || 'Failed to load');
      }
    } catch { /* offline — keep last state */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((j) => setMe(j.user || null)).catch(() => setMe(null));
  }, []);

  // Load + 20s poll, but only once we know the viewer is an approver.
  useEffect(() => {
    if (!isApprover) return;
    load();
    const t = setInterval(load, 20000);
    window.addEventListener('focus', load);
    return () => { clearInterval(t); window.removeEventListener('focus', load); };
  }, [isApprover, load]);

  async function decide(req: DiscReq, approve: boolean, note = '') {
    setBusy(req.id);
    try {
      const r = await api(`/api/dine-in/discount-requests/${req.id}/decide`, {
        method: 'POST', body: { approve, note },
      });
      const j = await r.json();
      if (!r.ok) { flash(j.error || 'Failed'); }
      else flash(approve ? `Approved ${req.requested_pct}% on #${req.order_number} ✓` : `Rejected request on #${req.order_number}`);
      setRejectFor(null); setRejectNote('');
      await load();
    } finally { setBusy(null); }
  }

  if (me === undefined) {
    return <div className="flex items-center justify-center min-h-[50vh] text-[#8B7355]"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }
  if (!isApprover) {
    return (
      <div className="max-w-lg mx-auto p-6 text-center">
        <ShieldAlert className="w-10 h-10 text-[#af4408] mx-auto mb-3" />
        <p className="font-bold text-[#2D1B0E]">Managers, Admins & HODs only</p>
        <p className="text-sm text-[#8B7355] mt-1">Bill-discount approvals are restricted. Ask a manager to review pending requests.</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-3 sm:p-6 pb-24">
      <div className="flex items-center gap-2 mb-1">
        <BadgePercent className="w-6 h-6 text-[#af4408]" />
        <h1 className="text-xl font-bold text-[#2D1B0E]">Discount Approvals</h1>
        <button onClick={load} className="ml-auto p-2 text-[#8B7355] hover:text-[#2D1B0E] active:scale-95" aria-label="Refresh">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>
      <p className="text-sm text-[#8B7355] mb-4">Bill discounts requested from the Captain app. Approving applies the discount to the order immediately.</p>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

      {/* ── Pending queue ── */}
      {loading ? (
        <div className="flex justify-center py-10 text-[#8B7355]"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : pending.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-2xl p-8 text-center text-[#8B7355]">
          <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-green-600" />
          <p className="text-sm font-medium">No discounts waiting for approval</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pending.map((req) => (
            <div key={req.id} className="bg-white border border-[#E8D5C4] rounded-2xl p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-bold text-[#2D1B0E] leading-tight">
                    {req.table_number ? `Table ${req.table_number}` : (req.order_type || 'Order')} · #{req.order_number}
                  </p>
                  <p className="text-xs text-[#8B7355] mt-0.5 flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {ageOf(req.created_at)}
                    <span>·</span>
                    <User className="w-3 h-3" /> {req.requester_name}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  {req.kind === 'service_charge' ? (
                    <p className="text-sm font-extrabold text-[#af4408] leading-tight">Waive<br />Service Charge</p>
                  ) : (
                    <>
                      <p className="text-lg font-extrabold text-[#af4408] leading-tight">{req.requested_pct}%</p>
                      <p className="text-[11px] text-[#8B7355]">−{fmt(req.impact_amount)}</p>
                    </>
                  )}
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between text-sm">
                <span className="text-[#8B7355]">Bill total</span>
                <span className="font-semibold text-[#2D1B0E]">{fmt(req.order_total)}</span>
              </div>
              {req.reason ? (
                <p className="mt-1.5 text-sm text-[#6B5744] bg-[#FFF9F3] border border-[#F0E4D6] rounded-lg px-2.5 py-1.5">“{req.reason}”</p>
              ) : null}

              {rejectFor === req.id ? (
                <div className="mt-3 space-y-2">
                  <input value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="Rejection note (optional)"
                    className="w-full border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
                  <div className="flex gap-2">
                    <button onClick={() => { setRejectFor(null); setRejectNote(''); }}
                      className="flex-1 border border-[#E8D5C4] text-[#6B5744] py-2.5 rounded-xl text-sm font-medium active:scale-95">Cancel</button>
                    <button onClick={() => decide(req, false, rejectNote.trim())} disabled={busy === req.id}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-red-600 text-white py-2.5 rounded-xl text-sm font-bold active:scale-95 disabled:opacity-50">
                      {busy === req.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />} Confirm reject
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex gap-2">
                  <button onClick={() => { setRejectFor(req.id); setRejectNote(''); }} disabled={busy === req.id}
                    className="flex-1 flex items-center justify-center gap-1.5 border border-red-300 text-red-600 py-2.5 rounded-xl text-sm font-semibold active:scale-95 disabled:opacity-50">
                    <X className="w-4 h-4" /> Reject
                  </button>
                  <button onClick={() => decide(req, true)} disabled={busy === req.id}
                    className="flex-[2] flex items-center justify-center gap-1.5 bg-green-700 text-white py-2.5 rounded-xl text-sm font-bold active:scale-95 disabled:opacity-50">
                    {busy === req.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Approve {req.kind === 'service_charge' ? 'waiver' : `${req.requested_pct}%`}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── History (last 20 decided) ── */}
      <h2 className="text-sm font-bold uppercase tracking-wider text-[#8B7355] mt-8 mb-2">Recent decisions</h2>
      {history.length === 0 ? (
        <p className="text-sm text-[#8B7355]">Nothing decided yet.</p>
      ) : (
        <ul className="bg-white border border-[#E8D5C4] rounded-2xl divide-y divide-[#F0E4D6] overflow-hidden">
          {history.map((h) => (
            <li key={h.id} className="px-3.5 py-2.5 text-sm">
              <div className="flex items-center gap-2">
                <span className={`shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${h.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                  {h.status}
                </span>
                <span className="font-semibold text-[#2D1B0E] truncate">
                  {h.table_number ? `Table ${h.table_number}` : (h.order_type || 'Order')} · #{h.order_number} · {h.requested_pct}%
                </span>
                <span className="ml-auto shrink-0 text-xs text-[#8B7355]">{ageOf(h.decided_at)}</span>
              </div>
              <p className="text-xs text-[#8B7355] mt-0.5">
                {h.requester_name} → {h.decided_by || '—'}
                {h.status === 'approved' ? ` · −${fmt(h.impact_amount)}` : ''}
                {h.decided_note ? ` · “${h.decided_note}”` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-[#2D1B0E] text-white text-sm font-medium px-4 py-2.5 rounded-full shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
