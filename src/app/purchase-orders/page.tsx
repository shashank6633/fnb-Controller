'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ClipboardList, Plus, Trash2, Search, Loader2, CheckCircle2, XCircle, Send,
  ShieldCheck, PackageCheck, RefreshCw, AlertTriangle, ChevronDown, Printer,
} from 'lucide-react';
import { api } from '@/lib/api';

// Always 2 dp: at 0 dp the paise were dropped per row, so the item column
// visibly failed to add up to the footer/list total (₹235.50 + ₹118.50 showed
// as ₹236 + ₹119 = ₹355 against a ₹354 header). Every ₹ TOTAL on this page goes
// through this one formatter; the per-line rates spell out .toFixed(2) inline.
// Either way nothing on this page rounds money to whole rupees, so the same
// number never reads two different ways in two places.
const fmt = (v: number) => '₹' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateLabel = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

interface Material { id: string; name: string; unit: string; purchase_unit?: string; pack_size?: number; sku?: string; average_price: number; primary_vendor?: string; last_purchase_price?: number; }

/* ── PO UNIT BASIS ────────────────────────────────────────────────────────────
 * A Purchase Order is raised to a VENDOR, so it must be expressed in the
 * material's PURCHASE unit (kg, L, BTL, CASE…) at ₹ per PURCHASE unit — never
 * the recipe/stock unit (g, ml) the kitchen consumes in.
 *   raw_materials.unit           = RECIPE unit  (e.g. g)
 *   raw_materials.purchase_unit  = PURCHASE unit (e.g. kg)
 *   raw_materials.average_price  = ₹ per RECIPE unit  (e.g. ₹0.90/g)
 *   purchases.unit_price / last_purchase_price = ₹ per PURCHASE unit (₹900/kg)
 * So average_price must be multiplied by pack_size to become a PO rate.
 * (See lib/pack-units + the unit convention: stock is recipe units = purchase
 * qty × pack_size, hence ₹/purchase-unit = ₹/recipe-unit × pack_size.) */
const poUnitOf = (m?: Partial<Material> | null): string =>
  String(m?.purchase_unit || '').trim() || String(m?.unit || '').trim();
/** Seed rate for a PO line: ₹ per PURCHASE unit. Prefers the last actual
 *  purchase price (already ₹/purchase-unit); otherwise converts the recipe-unit
 *  average by pack size. Returns 0 when we genuinely have no price. */
const poRateOf = (m?: Partial<Material> | null): number => {
  const last = Number(m?.last_purchase_price) || 0;
  if (last > 0) return last;
  const pack = Number(m?.pack_size) || 1;
  const ru = String(m?.unit || '').toLowerCase().trim();
  const pu = String(m?.purchase_unit || m?.unit || '').toLowerCase().trim();
  const avg = Number(m?.average_price) || 0;
  return (pack > 1 && ru !== pu) ? Math.round(avg * pack * 100) / 100 : avg;
};
interface POItem { id: string; material_id: string; material_name?: string; material_sku?: string; material_unit?: string; quantity: number; unit_price: number; total_price: number; current_avg_price?: number; last_purchase_price?: number; notes?: string; }
interface PO { id: string; po_number: string; date: string; vendor: string; status: string; total_cost: number; notes: string; drafted_by: string; submitted_at?: string; approved_by?: string; approved_at?: string; rejected_reason?: string; received_at?: string; item_count?: number; items?: POItem[]; }

const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-800',
  received: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-100 text-slate-500 line-through',
};

export default function PurchaseOrdersPage() {
  const [pos, setPos] = useState<PO[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [role, setRole] = useState<'admin' | 'manager'>('admin');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'all' | 'draft' | 'pending' | 'approved' | 'received' | 'rejected'>('pending');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [openDetailId, setOpenDetailId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);   // approval-context drawer
  const [receivingId, setReceivingId] = useState<string | null>(null);
  const [rejectingPo, setRejectingPo] = useState<PO | null>(null);
  const [approvingPo, setApprovingPo] = useState<PO | null>(null);
  const [poFlagCount, setPoFlagCount] = useState<Record<string, number>>({});  // poId → flag total


  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [posRes, invRes] = await Promise.all([
        fetch('/api/purchase-orders').then(r => r.json()),
        // scope=all — POs are a store operation; show every material.
        fetch('/api/inventory?scope=all').then(r => r.json()),
      ]);
      setPos(posRes.purchase_orders || []);
      setRole((posRes.viewer_role === 'manager' ? 'manager' : 'admin'));
      setMaterials(invRes.materials || []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Role is now driven by the logged-in user (api/auth/me). Toggle is removed.

  const filtered = useMemo(() => {
    let list = pos;
    if (tab !== 'all') list = list.filter(p => p.status === tab);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p => p.po_number.toLowerCase().includes(q) || (p.vendor || '').toLowerCase().includes(q));
    }
    return list;
  }, [pos, tab, search]);

  const counts = useMemo(() => ({
    draft: pos.filter(p => p.status === 'draft').length,
    pending: pos.filter(p => p.status === 'pending').length,
    approved: pos.filter(p => p.status === 'approved').length,
    received: pos.filter(p => p.status === 'received').length,
    rejected: pos.filter(p => p.status === 'rejected' || p.status === 'cancelled').length,
  }), [pos]);

  const action = async (id: string, kind: 'submit' | 'approve' | 'reject' | 'cancel' | 'receive', body: any = {}) => {
    setSavingId(id);
    try {
      const r = await api(`/api/purchase-orders/${id}/${kind}`, { method: 'POST', body });
      if (!r.ok) { alert(((await r.json()).error) || `Failed to ${kind}`); return; }
      await fetchAll();
    } finally { setSavingId(null); }
  };

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <ClipboardList className="w-6 h-6" /> Purchase Orders
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Manager drafts &amp; submits — Admin approves — Receiving updates stock and re-prices recipes.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-[#8B7355]">
              You are signed in as <span className={`font-semibold ${role === 'admin' ? 'text-[#af4408]' : 'text-[#6B5744]'}`}>{role.toUpperCase()}</span>
              {role !== 'admin' && <span className="ml-1">— Approve / Reject is admin-only</span>}
            </span>
            <button onClick={() => setCreating(true)}
                    className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
              <Plus className="w-4 h-4" /> New PO
            </button>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 shadow flex flex-wrap items-center gap-3">
          {/* Segmented control scrolls sideways on phones instead of overflowing;
              scrollbar hidden. max-w-full keeps it inside the wrapping toolbar. */}
          <div className="flex gap-1 bg-[#FFF1E3] rounded-lg p-1 text-xs flex-nowrap overflow-x-auto max-w-full no-scrollbar">
            {([
              ['all',      `All (${pos.length})`,                       'bg-[#af4408]'],
              ['draft',    `Draft (${counts.draft})`,                   'bg-gray-600'],
              ['pending',  `Pending Approval (${counts.pending})`,      'bg-amber-500'],
              ['approved', `Approved (${counts.approved})`,             'bg-blue-600'],
              ['received', `Received (${counts.received})`,             'bg-green-600'],
              ['rejected', `Rejected/Cancelled (${counts.rejected})`,   'bg-red-600'],
            ] as const).map(([v, label, bg]) => (
              <button key={v} onClick={() => setTab(v as any)}
                      className={`px-2.5 py-1 rounded-md font-medium transition-colors shrink-0 whitespace-nowrap ${tab === v ? `${bg} text-white` : 'text-[#6B5744] hover:bg-white'}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-[#8B7355]" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="PO number or vendor…"
                   className="flex-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </div>
          <button onClick={fetchAll} className="text-xs text-[#6B5744] hover:text-[#af4408] flex items-center gap-1">
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {/* List */}
        {loading ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-[#8B7355] text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-[#8B7355] text-sm">
            {tab === 'pending' && counts.pending === 0
              ? '✓ Nothing waiting for approval.'
              : 'No POs in this view.'}
          </div>
        ) : (
          <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                  <tr>
                    <th className="text-left  py-2.5 px-3 font-medium">PO #</th>
                    <th className="text-left  py-2.5 px-3 font-medium">Date</th>
                    <th className="text-left  py-2.5 px-3 font-medium">Vendor</th>
                    <th className="text-right py-2.5 px-3 font-medium">Items</th>
                    <th className="text-right py-2.5 px-3 font-medium">Total</th>
                    <th className="text-left  py-2.5 px-3 font-medium">Status</th>
                    <th className="text-right py-2.5 px-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(p => {
                    const isSaving = savingId === p.id;
                    const isOpen = openDetailId === p.id;
                    const canEdit = p.status === 'draft';
                    const canSubmit = p.status === 'draft';
                    const canApprove = p.status === 'pending' && role === 'admin';
                    const canReject = p.status === 'pending' && role === 'admin';
                    const canCancel = ['draft', 'pending', 'rejected'].includes(p.status);
                    const canReceive = p.status === 'approved';
                    const canDelete = p.status === 'draft';
                    return (
                      <>
                        <tr key={p.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30">
                          <td className="py-2 px-3 text-xs font-mono">
                            <button onClick={() => setOpenDetailId(isOpen ? null : p.id)}
                                    className="inline-flex items-center gap-1 hover:text-[#af4408]">
                              <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                              {p.po_number}
                            </button>
                          </td>
                          <td className="py-2 px-3 text-xs">{dateLabel(p.date)}</td>
                          <td className="py-2 px-3 text-xs">{p.vendor || <span className="text-[#8B7355]">—</span>}</td>
                          <td className="py-2 px-3 text-xs text-right font-mono">{p.item_count ?? '-'}</td>
                          <td className="py-2 px-3 text-xs text-right font-mono font-semibold">{fmt(p.total_cost)}</td>
                          <td className="py-2 px-3 text-xs">
                            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${STATUS_COLOR[p.status] || 'bg-gray-100'}`}>
                              {p.status.toUpperCase()}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-xs text-right">
                            <div className="inline-flex items-center gap-1 justify-end">
                              {canEdit && (
                                <button onClick={() => { setEditingId(p.id); setOpenDetailId(p.id); }}
                                        className="px-2 py-1 rounded text-[10px] text-[#6B5744] hover:bg-[#FFF1E3]">Edit</button>
                              )}
                              <a href={`/purchase-orders/${p.id}/print`} target="_blank"
                                 className="px-2 py-1 rounded text-[10px] text-[#6B5744] hover:bg-[#FFF1E3] inline-flex items-center gap-1">
                                <Printer className="w-3 h-3" /> Print
                              </a>
                              {canSubmit && (
                                <button onClick={() => action(p.id, 'submit')} disabled={isSaving}
                                        className="px-2 py-1 rounded text-[10px] bg-amber-500 hover:bg-amber-600 text-white inline-flex items-center gap-1 disabled:opacity-50">
                                  <Send className="w-3 h-3" /> Submit
                                </button>
                              )}
                              {p.status === 'pending' && (
                                <button onClick={() => setReviewId(reviewId === p.id ? null : p.id)}
                                        className="px-2 py-1 rounded text-[10px] bg-amber-100 hover:bg-amber-200 text-amber-800 inline-flex items-center gap-1">
                                  <AlertTriangle className="w-3 h-3" /> {reviewId === p.id ? 'Hide' : 'Review'}
                                </button>
                              )}
                              {canApprove && (
                                <button onClick={() => setApprovingPo(p)} disabled={isSaving}
                                        className="px-2 py-1 rounded text-[10px] bg-blue-600 hover:bg-blue-700 text-white inline-flex items-center gap-1 disabled:opacity-50">
                                  <ShieldCheck className="w-3 h-3" /> Approve
                                </button>
                              )}
                              {canReject && (
                                <button onClick={() => setRejectingPo(p)} disabled={isSaving}
                                        className="px-2 py-1 rounded text-[10px] bg-red-100 text-red-700 hover:bg-red-200 inline-flex items-center gap-1 disabled:opacity-50">
                                  <XCircle className="w-3 h-3" /> Reject
                                </button>
                              )}
                              {canReceive && (
                                <button onClick={() => setReceivingId(p.id)} disabled={isSaving}
                                        className="px-2 py-1 rounded text-[10px] bg-green-600 hover:bg-green-700 text-white inline-flex items-center gap-1 disabled:opacity-50">
                                  <PackageCheck className="w-3 h-3" /> Receive
                                </button>
                              )}
                              {/* Gated on the status itself, NOT the canCancel
                                  array or the tab — the Rejected/Cancelled tab
                                  also holds cancelled POs, which cannot be
                                  revised. Reads before the destructive Cancel. */}
                              {p.status === 'rejected' && (
                                <button onClick={async () => {
                                  setSavingId(p.id);
                                  try {
                                    // DELETE on /reject = withdraw the rejection (back to draft for re-submit).
                                    // Can't use action(): that helper hardcodes method POST.
                                    const r = await api(`/api/purchase-orders/${p.id}/reject`, { method: 'DELETE' });
                                    if (!r.ok) { alert(((await r.json()).error) || 'Failed to revise'); return; }
                                    await fetchAll();
                                  } finally { setSavingId(null); }
                                }} disabled={isSaving}
                                        className="px-2 py-1 rounded text-[10px] bg-amber-500 hover:bg-amber-600 text-white inline-flex items-center gap-1 disabled:opacity-50">
                                  <Send className="w-3 h-3" /> Revise
                                </button>
                              )}
                              {canCancel && p.status !== 'draft' && (
                                <button onClick={() => action(p.id, 'cancel')} disabled={isSaving}
                                        className="px-2 py-1 rounded text-[10px] text-[#8B7355] hover:text-red-700 hover:bg-red-50">
                                  Cancel
                                </button>
                              )}
                              {canDelete && (
                                <button onClick={async () => {
                                  if (!confirm('Delete this draft?')) return;
                                  await api(`/api/purchase-orders?id=${p.id}`, { method: 'DELETE' });
                                  fetchAll();
                                }}
                                        className="p-1 rounded text-red-500 hover:bg-red-50">
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {isOpen && (
                          <PODetail key={p.id + '-d'} po={p} editing={editingId === p.id}
                                    onCancelEdit={() => setEditingId(null)}
                                    materials={materials}
                                    onSaved={() => { setEditingId(null); fetchAll(); }} />
                        )}
                        {reviewId === p.id && (
                          <ApprovalContextPanel key={p.id + '-r'} poId={p.id} />
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {creating && (
          <CreatePOModal materials={materials} onClose={() => setCreating(false)} onCreated={fetchAll} />
        )}

        {receivingId && (
          <ReceiveModal poId={receivingId}
                        onClose={() => setReceivingId(null)}
                        onReceived={() => { setReceivingId(null); fetchAll(); }} />
        )}

        {rejectingPo && (
          <RejectPOModal po={rejectingPo}
                         onClose={() => setRejectingPo(null)}
                         onRejected={async (reason) => {
                           await action(rejectingPo.id, 'reject', { reason });
                           setRejectingPo(null);
                         }} />
        )}

        {approvingPo && (
          <ApprovePOModal po={approvingPo}
                          onClose={() => setApprovingPo(null)}
                          onApproved={async (note) => {
                            await action(approvingPo.id, 'approve', { approval_note: note });
                            setApprovingPo(null);
                          }} />
        )}
      </div>
    </div>
  );
}

/* ============================================================ */
/* Receive Modal — adjust per-line qty/price for partial deliveries */
/* ============================================================ */
function ReceiveModal({ poId, onClose, onReceived }: { poId: string; onClose: () => void; onReceived: () => void }) {
  const [po, setPo] = useState<PO | null>(null);
  const [items, setItems] = useState<POItem[]>([]);
  const [overrides, setOverrides] = useState<Record<string, { quantity: number; unit_price: number }>>({});
  const [receivedAt, setReceivedAt] = useState<string>(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/purchase-orders?id=${poId}`).then(r => r.json()).then(d => {
      setPo(d.purchase_order);
      const its = d.purchase_order?.items || [];
      setItems(its);
      const map: Record<string, { quantity: number; unit_price: number }> = {};
      for (const it of its) map[it.id] = { quantity: it.quantity, unit_price: it.unit_price };
      setOverrides(map);
      setLoading(false);
    });
  }, [poId]);

  const setQty   = (id: string, v: number) => setOverrides(o => ({ ...o, [id]: { ...o[id], quantity: v } }));
  const setPrice = (id: string, v: number) => setOverrides(o => ({ ...o, [id]: { ...o[id], unit_price: v } }));

  const total = items.reduce((s, it) => {
    const ov = overrides[it.id] || it;
    return s + (Number(ov.quantity) || 0) * (Number(ov.unit_price) || 0);
  }, 0);
  const orderedTotal = items.reduce((s, it) => s + it.quantity * it.unit_price, 0);

  const submit = async () => {
    setSaving(true);
    try {
      const item_overrides = items
        .filter(it => {
          const ov = overrides[it.id];
          return ov && (ov.quantity !== it.quantity || ov.unit_price !== it.unit_price);
        })
        .map(it => ({ po_item_id: it.id, quantity: overrides[it.id].quantity, unit_price: overrides[it.id].unit_price }));
      const r = await api(`/api/purchase-orders/${poId}/receive`, {
        method: 'POST', body: { received_at: receivedAt, item_overrides },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(j.error || 'Failed');
        // 409 = someone else already received this PO (the route claims the row
        // with UPDATE … WHERE status = 'approved' inside the txn). The list row
        // behind this modal still says "approved", so close + refetch rather
        // than leave a Receive button that can only fail again.
        if (r.status === 409) onReceived();
        return;
      }
      // Store-mapped (liquor) lines are SKIPPED by the receive route so they
      // never touch Central stock — but the "Receive total" the receiver just
      // confirmed counted them, so name the lines that did NOT arrive.
      if (Array.isArray(j.store_blocked) && j.store_blocked.length > 0) {
        alert(
          `${j.store_blocked.length} line(s) were NOT received:\n` +
          j.store_blocked.map((b: any) => `• ${b.material_name} — ${b.error}`).join('\n') +
          '\n\nThese must be procured through Inventory → Liquor Store instead.'
        );
      }
      // Excess-acceptance acknowledgement — show the receiver that the admin
      // has been notified (audit_event + in-app notification + optional Slack).
      if (j.excess_lines > 0) {
        alert(
          `Received. ${j.excess_lines} line(s) accepted over the ordered qty (${fmt(j.excess_value || 0)} excess).\n\n` +
          'The admin has been notified for review (visible on /audit as "po.received_excess").'
        );
      }
      onReceived();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-3xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <div>
            <h2 className="font-bold text-[#2D1B0E]">Receive PO {po?.po_number}</h2>
            <p className="text-xs text-[#8B7355] mt-0.5">Adjust each line if you got more / less or at a different price. Stock + recipe costs update on submit.</p>
          </div>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <label className="text-xs text-[#6B5744] flex flex-col gap-1 max-w-xs">
            Received on
            <input type="date" value={receivedAt} onChange={e => setReceivedAt(e.target.value)}
                   className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </label>

          {loading ? <div className="text-center text-xs text-[#8B7355] py-4">Loading items…</div> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[#8B7355]">
                  <tr>
                    <th className="text-left py-1 px-2 font-medium">Item</th>
                    <th className="text-right py-1 px-2 font-medium">Ordered Qty</th>
                    <th className="text-right py-1 px-2 font-medium">Received Qty</th>
                    <th className="text-right py-1 px-2 font-medium">Ordered ₹</th>
                    <th className="text-right py-1 px-2 font-medium">Actual ₹</th>
                    <th className="text-right py-1 px-2 font-medium">Line Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(it => {
                    const ov = overrides[it.id] || { quantity: it.quantity, unit_price: it.unit_price };
                    const lineTotal = Number(ov.quantity) * Number(ov.unit_price);
                    const qtyDiff = Number(ov.quantity) - it.quantity;
                    const priceDiff = Number(ov.unit_price) - it.unit_price;
                    // A PO's qty + rate are in the PURCHASE unit (kg, BTL, CASE)
                    // — NOT the recipe/stock unit (g, ml), which differs by
                    // pack_size. Label every qty/rate cell with it so the
                    // receiver knows exactly what they're confirming.
                    const u = (it as any).material_purchase_unit || (it as any).material_unit || '';
                    return (
                      <tr key={it.id} className="border-t border-[#E8D5C4]/50">
                        <td className="py-1.5 px-2">
                          <div className="text-[#2D1B0E]">{it.material_name}</div>
                          <div className="text-[10px] text-[#8B7355]">{it.material_sku} · {u}</div>
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono">
                          {it.quantity.toLocaleString('en-IN')}
                          {u && <span className="ml-1 text-[10px] text-[#8B7355]">{u}</span>}
                        </td>
                        <td className="py-1.5 px-2">
                          <div className="flex items-center gap-1 justify-end">
                            {/* min=0 — receiving cannot be negative. Negative
                                stock corrections belong on the GRN page's
                                "back-correction" workflow, not here. */}
                            <input type="number" step="any" min={0} value={ov.quantity}
                                   onChange={e => {
                                     const v = parseFloat(e.target.value);
                                     setQty(it.id, Number.isFinite(v) ? Math.max(0, v) : 0);
                                   }}
                                   className={`w-full px-1.5 py-1 border rounded text-right ${qtyDiff !== 0 ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4]'}`} />
                            {u && <span className="text-[10px] text-[#8B7355]">{u}</span>}
                          </div>
                          {qtyDiff !== 0 && (
                            <div className={`text-[9px] mt-0.5 text-right ${qtyDiff > 0 ? 'text-blue-600' : 'text-amber-700'}`}>
                              {qtyDiff > 0 ? '+' : ''}{qtyDiff}{u ? ' ' + u : ''} vs ordered
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono text-[10px] text-[#8B7355]">
                          ₹{it.unit_price.toFixed(2)}{u && <span>/{u}</span>}
                        </td>
                        <td className="py-1.5 px-2">
                          <div className="flex items-center gap-1 justify-end">
                            <input type="number" step="any" min={0} value={ov.unit_price}
                                   onChange={e => {
                                     const v = parseFloat(e.target.value);
                                     setPrice(it.id, Number.isFinite(v) ? Math.max(0, v) : 0);
                                   }}
                                   className={`w-full px-1.5 py-1 border rounded text-right ${priceDiff !== 0 ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4]'}`} />
                            {u && <span className="text-[10px] text-[#8B7355]">/{u}</span>}
                          </div>
                          {priceDiff !== 0 && (
                            <div className={`text-[9px] mt-0.5 text-right ${priceDiff > 0 ? 'text-red-600' : 'text-green-700'}`}>
                              {priceDiff > 0 ? '+' : ''}₹{priceDiff.toFixed(2)}{u && `/${u}`} vs ordered
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono font-semibold">{fmt(lineTotal)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-[#E8D5C4] font-semibold">
                    <td className="py-2 px-2 text-right" colSpan={3}>Ordered total</td>
                    <td colSpan={2} className="py-2 px-2 text-right font-mono text-[#8B7355]">{fmt(orderedTotal)}</td>
                    <td></td>
                  </tr>
                  <tr className="font-semibold">
                    <td className="py-2 px-2 text-right" colSpan={3}>Receive total</td>
                    <td colSpan={2} className="py-2 px-2 text-right font-mono">{fmt(total)}</td>
                    <td className={`py-2 px-2 text-right font-mono text-xs ${total !== orderedTotal ? (total > orderedTotal ? 'text-red-600' : 'text-amber-700') : 'text-[#8B7355]'}`}>
                      {total !== orderedTotal ? `${total > orderedTotal ? '+' : ''}${fmt(total - orderedTotal)}` : '—'}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={saving || loading}
                  className="px-3 py-2 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <PackageCheck className="w-4 h-4" />}
            Confirm Receive
          </button>
        </div>
      </div>
    </div>
  );
}

function RoleToggle({ role, onChange }: { role: 'admin' | 'manager'; onChange: (r: 'admin' | 'manager') => void }) {
  return (
    <div className="flex items-center gap-1 bg-[#FFF1E3] rounded-lg p-1 text-xs">
      <span className="text-[#8B7355] px-2">Role:</span>
      {(['manager', 'admin'] as const).map(r => (
        <button key={r} onClick={() => onChange(r)}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors capitalize ${role === r ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-white'}`}>
          {r === 'admin' ? <ShieldCheck className="w-3 h-3 inline mr-1" /> : null}{r}
        </button>
      ))}
    </div>
  );
}

/* ============================================================ */
/* PO Detail row (expanded items table) + inline edit support    */
/* ============================================================ */
function PODetail({ po, editing, materials, onCancelEdit, onSaved }: {
  po: PO; editing: boolean; materials: Material[]; onCancelEdit: () => void; onSaved: () => void;
}) {
  const [items, setItems] = useState<POItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/purchase-orders?id=${po.id}`).then(r => r.json()).then(d => {
      setItems(d.purchase_order?.items || []); setLoading(false);
    });
  }, [po.id]);

  if (loading) {
    return <tr><td colSpan={7} className="py-3 px-3 text-xs text-[#8B7355] bg-[#FFF8F0]">Loading items…</td></tr>;
  }
  if (editing) {
    return <tr><td colSpan={7} className="py-3 px-3 bg-[#FFF8F0]">
      <EditPOItems poId={po.id} initialDate={po.date} initialVendor={po.vendor} initialNotes={po.notes}
                   initialItems={items} materials={materials} onCancel={onCancelEdit} onSaved={onSaved} />
    </td></tr>;
  }
  // Status-based column layout — once the PO is received we mirror the print
  // page and show Ordered + Received side-by-side so any variance is obvious
  // on screen too (until now it was print-only).
  const isReceived = po.status === 'received';
  return (
    <tr><td colSpan={7} className="py-3 px-3 bg-[#FFF8F0]">
      <div className="flex items-start gap-6">
        <div className="text-xs text-[#6B5744] space-y-1">
          {po.notes && <div><span className="font-semibold">Notes:</span> {po.notes}</div>}
          {po.submitted_at && <div><span className="font-semibold">Submitted:</span> {dateLabel(po.submitted_at)}</div>}
          {po.approved_at  && <div><span className="font-semibold">Approved:</span>  {dateLabel(po.approved_at)} by {po.approved_by}</div>}
          {po.received_at  && <div><span className="font-semibold">Received:</span>  {dateLabel(po.received_at)}</div>}
          {po.rejected_reason && <div className="text-red-600"><span className="font-semibold">Rejected:</span> {po.rejected_reason}</div>}
        </div>
        <div className="flex-1 min-w-0 overflow-x-auto">
        <table className="text-xs w-full min-w-[640px]">
          <thead className="text-[#8B7355]">
            <tr>
              <th className="text-left  py-1 px-2 font-medium">SKU</th>
              <th className="text-left  py-1 px-2 font-medium">Material</th>
              <th className="text-left  py-1 px-2 font-medium">Vendor</th>
              <th className="text-right py-1 px-2 font-medium">{isReceived ? 'Ordered Qty' : 'Qty'}</th>
              <th className="text-left  py-1 px-2 font-medium">Unit</th>
              <th className="text-right py-1 px-2 font-medium">{isReceived ? 'Rate (Ord)' : 'Unit ₹'}</th>
              <th className="text-right py-1 px-2 font-medium">{isReceived ? 'Ordered ₹' : 'Total ₹'}</th>
              {isReceived && <>
                <th className="text-right py-1 px-2 font-medium bg-emerald-50">Received Qty</th>
                <th className="text-right py-1 px-2 font-medium bg-emerald-50">Rate (Act)</th>
                <th className="text-right py-1 px-2 font-medium bg-emerald-50">Received ₹</th>
                <th className="text-right py-1 px-2 font-medium bg-amber-50">Variance</th>
              </>}
            </tr>
          </thead>
          <tbody>
            {items.map(it => {
              // received_* fields come from /api/purchase-orders when grn_id is set
              // (server folds the linked GRN items into the response). See the
              // PO API GET handler for the join logic.
              const recQty   = (it as any).quantity_accepted ?? (it as any).quantity_received;
              const recPrice = (it as any).received_unit_price ?? it.unit_price;
              const recTotal = (it as any).received_line_total ?? (recQty != null ? Number(recQty) * Number(recPrice) : null);
              const qtyDiff   = recQty != null ? Number(recQty) - Number(it.quantity) : 0;
              const priceDiff = recPrice != null ? Number(recPrice) - Number(it.unit_price) : 0;
              const valDiff   = recTotal != null ? Number(recTotal) - Number(it.total_price) : 0;
              const rejected  = Number((it as any).quantity_rejected) || 0;
              // A PO line is expressed in the PURCHASE unit (kg/BTL/CASE) at
              // ₹/purchase-unit — never the recipe unit (g/ml), which differs by
              // pack_size. GET /api/purchase-orders?id= returns
              // material_purchase_unit for exactly this label (same derivation as
              // the receive modal), so "10 kg @ ₹900/kg" can't read as ₹900/g.
              const u = (it as any).material_purchase_unit || it.material_unit || '';
              return (
                <tr key={it.id} className="border-t border-[#E8D5C4]/50">
                  <td className="py-1 px-2 font-mono text-[10px] text-[#8B7355]">{it.material_sku || '·'}</td>
                  <td className="py-1 px-2">
                    {it.material_name}
                    {isReceived && rejected > 0 && (
                      <div className="text-[10px] text-red-700 mt-0.5">
                        Rejected: {rejected} {u}
                        {(it as any).rejection_reason && <span className="capitalize"> ({String((it as any).rejection_reason).replace(/_/g, ' ')})</span>}
                      </div>
                    )}
                  </td>
                  <td className="py-1 px-2 text-[#6B5744]">{(it as any).vendor || <span className="text-[#8B7355] italic">—</span>}</td>
                  <td className="py-1 px-2 text-right font-mono">{it.quantity.toLocaleString('en-IN')}</td>
                  <td className="py-1 px-2 text-[#6B5744]">{u}</td>
                  <td className="py-1 px-2 text-right font-mono">{fmt(it.unit_price)}</td>
                  <td className="py-1 px-2 text-right font-mono font-semibold">{fmt(it.total_price)}</td>
                  {isReceived && <>
                    <td className={`py-1 px-2 text-right font-mono ${qtyDiff !== 0 ? (qtyDiff > 0 ? 'bg-amber-50 text-amber-900 font-semibold' : 'bg-red-50 text-red-700 font-semibold') : 'bg-emerald-50/30'}`}>
                      {recQty != null ? Number(recQty).toLocaleString('en-IN') : '—'}
                    </td>
                    <td className={`py-1 px-2 text-right font-mono ${priceDiff !== 0 ? (priceDiff > 0 ? 'bg-red-50 text-red-700 font-semibold' : 'bg-emerald-50 text-emerald-800 font-semibold') : 'bg-emerald-50/30'}`}>
                      {recPrice != null ? fmt(Number(recPrice)) : '—'}
                    </td>
                    <td className="py-1 px-2 text-right font-mono bg-emerald-50/30">
                      {recTotal != null ? fmt(Number(recTotal)) : '—'}
                    </td>
                    <td className={`py-1 px-2 text-right font-mono text-[10px] ${valDiff === 0 ? 'text-[#8B7355]' : valDiff > 0 ? 'text-red-700' : 'text-amber-700'}`}>
                      {qtyDiff !== 0 && (
                        <div title={`Qty ${qtyDiff > 0 ? '+' : ''}${qtyDiff} ${u}`}>
                          {qtyDiff > 0 ? '+' : ''}{qtyDiff} {u}
                        </div>
                      )}
                      {valDiff !== 0 && (
                        <div>{valDiff > 0 ? '+' : ''}{fmt(valDiff)}</div>
                      )}
                      {qtyDiff === 0 && valDiff === 0 && '—'}
                    </td>
                  </>}
                </tr>
              );
            })}
          </tbody>
          {isReceived && (
            <tfoot>
              <tr className="border-t border-[#E8D5C4] font-semibold bg-white/60">
                <td colSpan={6} className="py-1.5 px-2 text-right">Totals</td>
                <td className="py-1.5 px-2 text-right font-mono">
                  {fmt(items.reduce((s, it) => s + Number(it.total_price || 0), 0))}
                </td>
                <td colSpan={2}></td>
                <td className="py-1.5 px-2 text-right font-mono bg-emerald-50">
                  {fmt(items.reduce((s, it) => s + Number((it as any).received_line_total || 0), 0))}
                </td>
                <td className="py-1.5 px-2 text-right font-mono text-[10px] bg-amber-50">
                  {(() => {
                    const ord = items.reduce((s, it) => s + Number(it.total_price || 0), 0);
                    const rec = items.reduce((s, it) => s + Number((it as any).received_line_total || 0), 0);
                    const d = rec - ord;
                    return d === 0 ? '—' : (d > 0 ? '+' : '') + fmt(d);
                  })()}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
        </div>
      </div>
    </td></tr>
  );
}

/* ============================================================ */
/* Create new PO modal                                            */
/* ============================================================ */
interface POLine {
  uid: string;             // stable row identity — see newLineUid()
  material_id: string;
  quantity: number;
  unit_price: number;
  vendor: string;          // master vendor name, or a purchase-history name the
                           // master no longer resolves (the __legacy__ option)
  vendor_id: string;       // optional FK to vendors master
}

/* Rows were keyed by array index, so deleting a line handed the removed row's
 * per-line child state (ContractFlag's fetched contract, EligibleVendorChips'
 * list) to the row that shifted into its slot — and "remove the line to change
 * the item" makes deletion routine. A monotonic counter, not crypto.randomUUID,
 * which is undefined on plain-http LAN origins. */
let poLineSeq = 0;
const newLineUid = () => `poline-${++poLineSeq}`;

/**
 * Eligible-vendor quick-pick chips for a PO line.
 * Loads vendors we've actually purchased this material from (purchases table).
 * Click a chip → fills vendor name + vendor_id + (optionally) last unit price.
 */
interface EligibleVendor {
  vendor: string; vendor_id: string | null;
  payment_terms: string | null; lead_time_days: number | null;
  purchase_count: number; last_date: string | null;
  last_price: number | null; avg_price: number | null; total_qty: number;
  contract_id: string | null;
  contract_price: number | null;
  contract_valid_to: string | null;
}
/**
 * Off-contract flag for a PO line. Looks up the active contract for the
 * (vendor_id, material_id) pair and compares against the buyer-entered price.
 * - On contract → small green "📄 Contract ₹X" chip
 * - Diverges    → red flag with delta and a one-click "match contract" button
 */
function ContractFlag({ materialId, vendorId, unitPrice, onMatch }: {
  materialId: string; vendorId: string; unitPrice: number;
  onMatch: (price: number) => void;
}) {
  const [contract, setContract] = useState<{ unit_price: number; valid_to: string | null } | null>(null);
  useEffect(() => {
    // Clear FIRST, always: the previous (material, vendor) pair's contract used
    // to stay on screen — and stay wired to the one-click "match" button — when
    // the pair changed or the refetch failed (the .catch below is silent).
    setContract(null);
    if (!materialId || !vendorId) return;
    const ctrl = new AbortController();
    fetch(`/api/vendor-contracts?material_id=${materialId}&vendor_id=${vendorId}&active=1`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(d => {
        const c = (d.contracts || [])[0];
        // A 0/blank contract rate is "no price agreed", not an authoritative ₹0
        // — otherwise "match" would wipe the line rate to zero.
        setContract(c && Number(c.unit_price) > 0 ? { unit_price: Number(c.unit_price), valid_to: c.valid_to } : null);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [materialId, vendorId]);
  if (!contract) return null;
  const diff = unitPrice - contract.unit_price;
  const pct = contract.unit_price > 0 ? (diff / contract.unit_price) * 100 : 0;
  const onPrice = Math.abs(diff) < 0.01;
  if (onPrice) {
    return (
      <div className="text-[10px] text-emerald-700 mt-0.5 font-medium">
        📄 On contract ₹{contract.unit_price.toFixed(2)}
        {contract.valid_to && <span className="text-[#8B7355] ml-1">(until {contract.valid_to})</span>}
      </div>
    );
  }
  return (
    <div className="text-[10px] text-red-700 mt-0.5 font-medium flex items-center gap-1 flex-wrap">
      ⚠ Off-contract: ₹{contract.unit_price.toFixed(2)} ({diff > 0 ? '+' : ''}{pct.toFixed(1)}%)
      <button type="button" onClick={() => onMatch(contract.unit_price)}
              className="underline hover:text-red-900">match</button>
    </div>
  );
}

function EligibleVendorChips({ materialId, currentVendor, onPick }: {
  materialId: string;
  currentVendor: string;
  onPick: (v: EligibleVendor) => void;
}) {
  const [list, setList] = useState<EligibleVendor[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!materialId) { setList([]); return; }
    setLoading(true);
    fetch(`/api/vendors/for-material?material_id=${materialId}`)
      .then(r => r.json())
      .then(d => setList(d.vendors || []))
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  }, [materialId]);

  if (!materialId) return null;
  if (loading)     return <div className="text-[10px] text-[#8B7355] mt-1">Loading vendors…</div>;
  if (list.length === 0) {
    return <div className="text-[10px] text-[#8B7355] italic mt-1">No prior purchases — pick a vendor from the dropdown above.</div>;
  }
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      <span className="text-[10px] text-[#8B7355] mr-1 self-center">Past suppliers:</span>
      {list.slice(0, 6).map(v => {
        const active = currentVendor.toLowerCase().trim() === v.vendor.toLowerCase().trim();
        // > 0, not != null: a ₹0 contract row means no rate was agreed, so it must
        // not show as a contract chip nor be picked as the line rate.
        const hasContract = Number(v.contract_price) > 0;
        return (
          <button
            key={v.vendor}
            type="button"
            onClick={() => onPick(v)}
            title={[
              `${v.purchase_count} purchase${v.purchase_count > 1 ? 's' : ''}`,
              v.last_date ? `last ${v.last_date}` : null,
              v.last_price != null ? `last ₹${v.last_price.toFixed(2)}` : null,
              v.avg_price  != null ? `avg ₹${v.avg_price.toFixed(2)}`  : null,
              hasContract ? `CONTRACT ₹${Number(v.contract_price).toFixed(2)}${v.contract_valid_to ? ` until ${v.contract_valid_to}` : ' (open)'}` : null,
              v.payment_terms || null,
              v.lead_time_days ? `${v.lead_time_days}d lead` : null,
            ].filter(Boolean).join(' · ')}
            className={`text-[10px] px-1.5 py-0.5 rounded border transition ${
              active
                ? 'bg-[#af4408] text-white border-[#af4408]'
                : hasContract
                  ? 'bg-emerald-50 text-emerald-900 border-emerald-300 hover:border-emerald-500'
                  : 'bg-white text-[#2D1B0E] border-[#E8D5C4] hover:border-[#af4408] hover:bg-[#FFF1E3]'
            }`}
          >
            {v.vendor}
            {hasContract ? (
              <span className={`ml-1 font-mono font-semibold ${active ? 'text-white' : 'text-emerald-700'}`}>
                {/* 2 dp, like every other ₹ here: at 0 dp this chip showed
                    "₹236" while the ContractFlag directly below it showed the
                    same contract as ₹235.50. */}
                📄₹{Number(v.contract_price).toFixed(2)}
              </span>
            ) : v.last_price != null && (
              <span className={`ml-1 font-mono ${active ? 'text-white/80' : 'text-[#8B7355]'}`}>
                ₹{v.last_price.toFixed(2)}
              </span>
            )}
            <span className={`ml-1 ${active ? 'text-white/70' : 'text-[#8B7355]'}`}>×{v.purchase_count}</span>
          </button>
        );
      })}
    </div>
  );
}

function CreatePOModal({ materials, onClose, onCreated }: {
  materials: Material[]; onClose: () => void; onCreated: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [vendors, setVendors] = useState<Array<{ id: string; name: string; payment_terms?: string; lead_time_days?: number }>>([]);
  const [notes, setNotes] = useState('');
  // Lazy initializer — newLineUid() must be called once, not on every render.
  const [items, setItems] = useState<POLine[]>(() => [
    { uid: newLineUid(), material_id: '', quantity: 1, unit_price: 0, vendor: '', vendor_id: '' },
  ]);
  const [saving, setSaving] = useState(false);
  // Phase 1 §3 — pick vendor FIRST. Materials list filters to "purchased from this
  // vendor before" (via purchases history OR an active vendor_contract). Toggle
  // `showAllMaterials` to bypass the filter for first-time orders from a new vendor.
  const [primaryVendorId, setPrimaryVendorId] = useState<string>('');
  const [primaryVendorName, setPrimaryVendorName] = useState<string>('');
  const [showAllMaterials, setShowAllMaterials] = useState(false);
  const [vendorMaterialIds, setVendorMaterialIds] = useState<Set<string>>(new Set());
  const [loadingVendorMats, setLoadingVendorMats] = useState(false);
  const [vendorLoadError, setVendorLoadError] = useState('');

  // This list feeds BOTH the header dropdown and every line dropdown, and a line
  // vendor is required to save. A silently failed fetch would therefore leave the
  // form unsubmittable with no explanation. Surface it instead.
  useEffect(() => {
    fetch('/api/vendors')
      .then(r => r.json())
      .then(d => {
        const list = (d.vendors || []).filter((v: any) => v.is_active);
        setVendors(list);
        setVendorLoadError(list.length === 0 ? 'No active vendors found — add one under Vendors first.' : '');
      })
      .catch(() => setVendorLoadError('Could not load the vendor list — reload the page to try again.'));
  }, []);

  // Whenever vendor changes, fetch the explicit vendor↔material MAPPINGS
  // (vendor_materials table — distinct from vendor_contracts which carries
  // negotiated prices). User manages this on /vendors/materials.
  useEffect(() => {
    if (!primaryVendorId) { setVendorMaterialIds(new Set()); return; }
    setLoadingVendorMats(true);
    const v = vendors.find(x => x.id === primaryVendorId);
    setPrimaryVendorName(v?.name || '');
    fetch(`/api/vendor-materials?vendor_id=${primaryVendorId}`)
      .then(r => r.json())
      .then(d => {
        const ids = new Set<string>();
        for (const m of (d.mappings || [])) if (m.material_id) ids.add(m.material_id);
        setVendorMaterialIds(ids);
      })
      .catch(() => setVendorMaterialIds(new Set()))
      .finally(() => setLoadingVendorMats(false));
  }, [primaryVendorId, vendors]);

  // Materials list shown to the SimpleMaterialPicker — narrowed when vendor is picked.
  const eligibleMaterials = (primaryVendorId && !showAllMaterials && vendorMaterialIds.size > 0)
    ? materials.filter(m => vendorMaterialIds.has(m.id))
    : materials;

  const addLine = () => setItems(prev => [...prev, { uid: newLineUid(), material_id: '', quantity: 1, unit_price: 0, vendor: '', vendor_id: '' }]);
  const removeLine = (i: number) => setItems(prev => prev.filter((_, j) => j !== i));
  const updateLine = (i: number, patch: Partial<POLine>) =>
    setItems(prev => prev.map((it, j) => j === i ? { ...it, ...patch } : it));

  const total = items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0);

  // Header derives "Vendor(s) used" from line items so user has a quick visual summary
  const vendorSummary = (() => {
    const set = new Set(items.map(i => i.vendor.trim()).filter(Boolean));
    if (set.size === 0) return null;
    if (set.size === 1) return [...set][0];
    return `Mixed (${set.size} vendors)`;
  })();

  const submit = async () => {
    // Validate PER ROW instead of silently filtering: a blank qty/rate box looks
    // unfinished, not invalid, so a dropped line used to vanish without a word
    // even though the footer Total (which sums EVERY row, material chosen or
    // not) had already counted it. The trash button stays the way to discard a
    // line.
    // Empty list first: `items.some(...)` is false on an empty array, so running
    // the vendor gate ahead of this blamed a missing vendor when the real
    // blocker was that the user had deleted every line.
    if (items.length === 0) { alert('Add at least one item'); return; }
    // The header vendor is OPTIONAL. One PO here legitimately spans several
    // vendors (it is an internal approval/costing document, not a sheet sent to
    // a vendor), and such a PO has no single header vendor — deriveHeaderVendor
    // writes "Mixed (N vendors)" from the lines. What the PO actually needs is a
    // vendor on every LINE, which is checked below and is what receive files
    // each purchase against.
    if (!primaryVendorId && !items.some(i => i.vendor.trim())) {
      alert('Pick a vendor — on the header, or per line.'); return;
    }
    const problems: string[] = [];
    items.forEach((it, i) => {
      const qty = Number(it.quantity);
      const px  = Number(it.unit_price);
      const u   = poUnitOf(materials.find(m => m.id === it.material_id));
      if (!it.material_id)      problems.push(`Line ${i + 1}: select an item (or remove the line)`);
      else if (!(qty > 0))      problems.push(`Line ${i + 1}: enter a quantity greater than 0`);
      // A ₹0 / negative rate reaches the purchases row at receive and drags
      // average_price toward (or below) zero — never let it be saved.
      else if (!(px > 0))       problems.push(`Line ${i + 1}: enter a unit rate greater than 0 (₹ per ${u || 'purchase unit'})`);
      else if (!it.vendor.trim()) problems.push(`Line ${i + 1}: pick a vendor — receiving files the purchase against it`);
    });
    if (problems.length) { alert(problems.join('\n')); return; }
    setSaving(true);
    try {
      const r = await api('/api/purchase-orders', {
        method: 'POST',
        body: {
          date,
          notes,
          // Seed only: the route INSERTs the header with these, then
          // deriveHeaderVendor() rewrites it from the LINE vendors before the
          // same txn commits (one vendor → that line's vendor_id, several →
          // "Mixed (N)" with vendor_id NULL). Every line is validated above to
          // carry a vendor, so that derivation always wins; these are sent so a
          // PO raised here is never INSERTed vendor-less.
          vendor_id: primaryVendorId,
          vendor: primaryVendorName,
          // Items carry their own vendor. uid is client-only row identity.
          items: items.map(({ uid, ...line }) => line),
        },
      });
      if (!r.ok) { alert((await r.json()).error || 'Failed'); return; }
      onCreated(); onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      {/* House safe-modal shell: card capped to the viewport, BODY scrolls
          internally, header + footer pinned — so Save/Cancel are always on
          screen (previously the card grew ~1000px tall and Save sat below the
          fold on phones). The material-picker dropdown lives inside the
          scrollable body; its absolute panel extends the body's scroll area,
          so it stays reachable. */}
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-3xl shadow-xl flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <h2 className="font-bold text-[#2D1B0E]">New Purchase Order</h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          {/* Header vendor is OPTIONAL: it seeds the line vendors and narrows the
              material list to that vendor's mapped items. A PO that spans several
              vendors just leaves it blank and sets the vendor per line. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              Vendor <span className="text-[#8B7355] font-normal">(optional — filters the item list)</span>
              <select value={primaryVendorId} onChange={e => setPrimaryVendorId(e.target.value)}
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm">
                <option value="">Select vendor…</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}{v.payment_terms ? ` · ${v.payment_terms}` : ''}{v.lead_time_days ? ` · ${v.lead_time_days}d` : ''}</option>)}
              </select>
              {vendorLoadError && (
                <span className="text-[10px] text-red-600">{vendorLoadError}</span>
              )}
              {primaryVendorId && (
                <span className="text-[10px] text-[#8B7355]">
                  {loadingVendorMats ? 'Loading mapped materials…' :
                   vendorMaterialIds.size > 0
                     ? <>Showing <strong>{vendorMaterialIds.size}</strong> materials mapped to {primaryVendorName} (Vendor → Items)</>
                     : <>No materials mapped to {primaryVendorName}. <a href="/vendors/materials" className="text-[#af4408] underline">Map them</a> or tick &quot;Show all&quot; to proceed.</>}
                </span>
              )}
            </label>
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              Date
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
            </label>
            <div className="text-xs text-[#6B5744] flex flex-col gap-1 justify-end">
              <span className="text-[10px] text-[#8B7355]">Vendor(s) on this PO</span>
              <div className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF1E3] text-sm font-medium text-[#2D1B0E] min-h-[34px]">
                {vendorSummary || <span className="text-[#8B7355] italic">{primaryVendorId ? 'Pick a material below — vendor auto-fills' : 'Set a vendor per line below, or pick one above ↑'}</span>}
              </div>
            </div>
          </div>
          {primaryVendorId && vendorMaterialIds.size > 0 && (
            <label className="flex items-center gap-2 text-[11px] text-[#6B5744]">
              <input type="checkbox" checked={showAllMaterials} onChange={e => setShowAllMaterials(e.target.checked)} />
              Show all materials (e.g. trying something new from this vendor)
            </label>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-[#2D1B0E]">Items</h3>
              {/* Desktop keeps a quick top button; the primary one lives at the
                  bottom of the list so on mobile you always see it right after the
                  material you just added (rather than scrolled off the top). */}
              <button onClick={addLine} className="hidden md:flex text-xs text-[#af4408] hover:underline items-center gap-1">
                <Plus className="w-3 h-3" /> Add line
              </button>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full text-xs block md:table md:min-w-[600px]">
              <thead className="text-[#8B7355] hidden md:table-header-group">
                <tr>
                  <th className="text-left py-1 px-2 font-medium" style={{ width: '34%' }}>Material</th>
                  <th className="text-left py-1 px-2 font-medium" style={{ width: '26%' }}>Vendor</th>
                  <th className="text-right py-1 px-2 font-medium w-16">Qty</th>
                  <th className="text-right py-1 px-2 font-medium w-20">Unit ₹</th>
                  <th className="text-right py-1 px-2 font-medium w-20">Line ₹</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody className="block md:table-row-group">
                {items.map((it, i) => {
                  const mat = materials.find(m => m.id === it.material_id);
                  const lineTotal = Number(it.quantity) * Number(it.unit_price);
                  return (
                    <tr key={it.uid} className="border-t border-[#E8D5C4]/50 align-top block md:table-row rounded-lg border border-[#E8D5C4] p-3 mb-2 space-y-2 md:p-0 md:mb-0 md:border-0 md:space-y-0">
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Material</span>
                        {/* Once an item is chosen the line is LOCKED to it — to
                            order a different item, remove the line and add a new
                            one. Swapping in place used to leave the previous
                            item's rate/vendor/contract behind on the line. */}
                        {mat ? (
                          <div className="px-2 py-1 rounded border border-[#E8D5C4] bg-[#FFF8F0] text-xs text-[#2D1B0E]">
                            <span className="font-mono text-[10px] text-[#8B7355] mr-1">{mat.sku}</span>{mat.name}
                          </div>
                        ) : (
                          <SimpleMaterialPicker value={it.material_id} materials={eligibleMaterials}
                                              onChange={(id, m) => {
                                                const patch: Partial<POLine> = { material_id: id };
                                                // Seed ₹ per PURCHASE unit (kg), never the recipe unit (g).
                                                // Re-seeds on any material change too (belt-and-braces:
                                                // the line is locked above, so this can't go stale).
                                                if (m && (id !== it.material_id || !it.unit_price)) patch.unit_price = poRateOf(m);
                                                if (m && (!it.vendor || it.vendor.trim() === '')) {
                                                  // Phase 1 §3: vendor was picked at header level — default the line vendor to it.
                                                  // Falls back to the material's primary_vendor only if no header vendor was set.
                                                  // Resolve against the master FIRST: the line vendor is a dropdown now, so a
                                                  // name with no matching id can't be shown — leave it blank and make the
                                                  // user pick rather than seeding a value the select can't represent.
                                                  const seed = vendors.find(v => v.id === primaryVendorId)
                                                    || vendors.find(v => v.name.toLowerCase().trim() === String((m as any).primary_vendor || '').toLowerCase().trim());
                                                  patch.vendor    = seed ? seed.name : '';
                                                  patch.vendor_id = seed ? seed.id : '';
                                                }
                                                updateLine(i, patch);
                                              }} />
                        )}
                        {mat && (
                          <div className="text-[10px] text-[#8B7355] mt-0.5">
                            order unit {poUnitOf(mat)} · ₹{poRateOf(mat).toFixed(2)}/{poUnitOf(mat)}
                            <span className="ml-1 text-[#B8A590]">· 🗑 remove the line to change the item</span>
                          </div>
                        )}
                      </td>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Vendor</span>
                        {/* Vendor must come FROM the master, not be typed. A typed
                            name that doesn't match a master row leaves vendor_id
                            empty, and every downstream join (contracts, vendor
                            history, payment terms) is keyed on vendor_id — so a
                            single typo silently cost the line its contract price.
                            Select by id; the name is cached alongside for display. */}
                        {(() => {
                          // A vendor deactivated AFTER this line was saved is no
                          // longer in `vendors`; keep it selectable so an existing
                          // draft still round-trips instead of blanking itself.
                          const knownVendor = vendors.some(v => v.id === it.vendor_id);
                          const legacy = !!it.vendor.trim() && !knownVendor;
                          return (
                            <select
                              value={legacy ? '__legacy__' : (it.vendor_id || '')}
                              onChange={e => {
                                if (e.target.value === '__legacy__') return;   // unchanged
                                const v = vendors.find(x => x.id === e.target.value);
                                updateLine(i, { vendor_id: v ? v.id : '', vendor: v ? v.name : '' });
                              }}
                              className={`w-full px-1.5 py-1 border rounded text-xs bg-white ${legacy ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4]'}`}
                            >
                              <option value="">Select vendor…</option>
                              {legacy && <option value="__legacy__">{it.vendor} — not in vendor master</option>}
                              {vendors.map(v => (
                                <option key={v.id} value={v.id}>
                                  {v.name}
                                  {v.payment_terms ? ` · ${v.payment_terms}` : ''}
                                  {v.lead_time_days ? ` · ${v.lead_time_days}d lead` : ''}
                                </option>
                              ))}
                            </select>
                          );
                        })()}
                        <EligibleVendorChips
                          materialId={it.material_id}
                          currentVendor={it.vendor}
                          onPick={v => {
                            // Chips come from purchase HISTORY, which can name a
                            // vendor the master no longer resolves. Re-resolve by
                            // name so the dropdown can actually show the pick
                            // instead of falling back to the legacy option.
                            const mv = vendors.find(x => x.id === v.vendor_id)
                                    || vendors.find(x => x.name.toLowerCase().trim() === v.vendor.toLowerCase().trim());
                            updateLine(i, {
                              vendor: mv ? mv.name : v.vendor,
                              vendor_id: mv ? mv.id : '',
                              // Contract beats last_price beats nothing.
                              // Always overwrite when a contract exists — that's the point.
                              // > 0, not != null: a ₹0 contract row means no rate was
                              // agreed and must not wipe a correctly seeded rate.
                              ...(Number(v.contract_price) > 0
                                  ? { unit_price: Number(v.contract_price) }
                                  : (!it.unit_price && Number(v.last_price) > 0 ? { unit_price: Number(v.last_price) } : {})),
                            });
                          }}
                        />
                        {it.vendor && it.vendor_id && (() => {
                          const v = vendors.find(x => x.id === it.vendor_id);
                          return v && (v.payment_terms || v.lead_time_days) ? (
                            <div className="text-[10px] text-[#8B7355] mt-0.5">
                              {v.payment_terms || ''}{v.payment_terms && v.lead_time_days ? ' · ' : ''}{v.lead_time_days ? `${v.lead_time_days}d lead` : ''}
                            </div>
                          ) : null;
                        })()}
                      </td>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Qty</span>
                        {/* min=0 + clamp: a negative qty/rate used to flow straight
                            through save → approve → receive into the purchases row
                            and average_price. Ordering can never be negative. */}
                        <input type="number" step="any" min={0} value={it.quantity || ''}
                               onChange={e => {
                                 const v = parseFloat(e.target.value);
                                 updateLine(i, { quantity: Number.isFinite(v) ? Math.max(0, v) : 0 });
                               }}
                               className="w-full px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs" />
                        {/* Spell out the ORDER unit so qty can never be read as
                            the recipe/stock unit (g) — a PO is in kg/BTL/CASE. */}
                        {mat && <div className="text-[9px] text-[#8B7355] text-right mt-0.5">{poUnitOf(mat)}</div>}
                      </td>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Unit ₹</span>
                        <input type="number" step="any" min={0} value={it.unit_price || ''}
                               onChange={e => {
                                 const v = parseFloat(e.target.value);
                                 updateLine(i, { unit_price: Number.isFinite(v) ? Math.max(0, v) : 0 });
                               }}
                               className="w-full px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs" />
                        {mat && <div className="text-[9px] text-[#8B7355] text-right mt-0.5">/ {poUnitOf(mat)}</div>}
                        {/* The box renders blank at 0 (value={it.unit_price || ''}), which
                            reads as optional — say it out loud instead. */}
                        {it.material_id && !(Number(it.unit_price) > 0) && (
                          <div className="text-[9px] text-red-600 text-right mt-0.5">rate required</div>
                        )}
                        {it.material_id && it.vendor_id && (
                          <ContractFlag materialId={it.material_id} vendorId={it.vendor_id}
                                        unitPrice={Number(it.unit_price) || 0}
                                        onMatch={p => updateLine(i, { unit_price: p })} />
                        )}
                      </td>
                      <td className="py-1 px-2 text-right font-mono pt-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Line ₹</span>
                        {fmt(lineTotal)}
                      </td>
                      <td className="py-1 px-2 pt-2 block md:table-cell">
                        <button onClick={() => removeLine(i)} className="text-red-500 hover:text-red-700">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="block md:table-footer-group">
                <tr className="border-t border-[#E8D5C4] font-semibold block md:table-row">
                  <td className="py-2 px-2 text-right block md:table-cell" colSpan={4}>Total</td>
                  <td className="py-2 px-2 text-right font-mono block md:table-cell">{fmt(total)}</td>
                  <td className="block md:table-cell"></td>
                </tr>
              </tfoot>
            </table>
            </div>
            {/* Primary Add-line — full width at the BOTTOM so after entering a
                material the button sits right below it (mobile-friendly). */}
            <button type="button" onClick={addLine}
                    className="mt-2 w-full flex items-center justify-center gap-1.5 py-2.5 border-2 border-dashed border-[#E8D5C4] rounded-lg text-sm font-medium text-[#af4408] hover:border-[#af4408] hover:bg-[#FFF1E3] active:bg-[#FFE8D5]">
              <Plus className="w-4 h-4" /> Add line
            </button>
          </div>

          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Notes
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </label>
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-3 py-2 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={saving}
                  className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg disabled:opacity-50 inline-flex items-center gap-1">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Save as Draft
          </button>
        </div>
      </div>
    </div>
  );
}

/* Simple inline picker for the PO modal/edit (separate from the recipe picker so the file stays self-contained) */
function SimpleMaterialPicker({ value, materials, onChange }: {
  value: string; materials: Material[]; onChange: (id: string, mat?: Material) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  // Portal the dropdown to <body> (fixed position) so the PO modal's overflow
  // can't clip it — the same clipping that hid this list inside the modal.
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const sel = materials.find(m => m.id === value);
  const list = useMemo(() => {
    const norm = q.toLowerCase().trim();
    return (norm ? materials.filter(m => m.name.toLowerCase().includes(norm) || (m.sku || '').toLowerCase().includes(norm)) : materials).slice(0, 1000);
  }, [q, materials]);
  const computePos = () => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 300);
    const left = Math.min(r.left, window.innerWidth - width - 8);
    setPos({ top: r.bottom + 4, left: Math.max(8, left), width });
  };
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    computePos();
    const onMove = () => computePos();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => { window.removeEventListener('scroll', onMove, true); window.removeEventListener('resize', onMove); };
  }, [open]);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !dropRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick); return () => document.removeEventListener('mousedown', onClick);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => { setOpen(!open); setQ(''); }}
              className="w-full text-left px-2 py-1 border border-[#E8D5C4] rounded text-xs bg-[#FFF8F0]">
        {sel ? (<><span className="text-[10px] font-mono text-[#8B7355] mr-1">{sel.sku}</span>{sel.name}</>) : <span className="text-[#8B7355]">Select…</span>}
      </button>
      {open && pos && typeof document !== 'undefined' && createPortal(
        <div ref={dropRef} style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
             className="z-[100] max-w-[calc(100vw-1rem)] bg-white border border-[#D4B896] rounded shadow-lg p-2 max-h-[55vh] overflow-y-auto overscroll-contain">
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search SKU or name…"
                 className="w-full px-2 py-1 text-xs border border-[#E8D5C4] rounded mb-1 sticky top-0" />
          <div className="space-y-0.5">
            {list.length === 0 && (
              <div className="px-2 py-1 text-[11px] text-[#8B7355]">
                {q.trim() ? <>No materials match &quot;{q}&quot;.</> : <>No materials loaded yet — refresh if this stays empty.</>}
              </div>
            )}
            {list.map(m => (
              <button type="button" key={m.id} onClick={() => { onChange(m.id, m); setOpen(false); setQ(''); }}
                      className="w-full text-left px-2 py-1 hover:bg-[#FFF1E3] rounded text-xs flex items-center gap-2">
                <span className="text-[10px] font-mono text-[#8B7355] w-16 shrink-0">{m.sku || '·'}</span>
                <span className="flex-1 truncate">{m.name}</span>
                <span className="text-[10px] text-[#6B5744]">{poUnitOf(m)}</span>
                <span className="text-[10px] font-mono text-[#6B5744]">₹{poRateOf(m).toFixed(2)}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/* Inline edit of items (drafts only) */
function EditPOItems({ poId, initialDate, initialVendor, initialNotes, initialItems, materials, onCancel, onSaved }:
  { poId: string; initialDate: string; initialVendor: string; initialNotes: string; initialItems: POItem[]; materials: Material[]; onCancel: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(initialDate);
  const [notes, setNotes] = useState(initialNotes || '');
  // Lazy initializer — newLineUid() must be called once per row, not per render.
  const [items, setItems] = useState(() => initialItems.map(i => ({
    uid: newLineUid(),      // stable row identity — index keys leaked child state on remove
    material_id: i.material_id,
    quantity: i.quantity,
    unit_price: i.unit_price,
    vendor: (i as any).vendor || '',
    vendor_id: (i as any).vendor_id || '',
  })));
  const [vendors, setVendors] = useState<Array<{ id: string; name: string; payment_terms?: string; lead_time_days?: number }>>([]);
  const [saving, setSaving] = useState(false);

  // is_active filter matches the new-PO composer: a retired vendor must not be
  // offered for a fresh line. One already saved on this draft stays visible via
  // the select's legacy option, so editing an old draft never blanks its vendor.
  useEffect(() => {
    fetch('/api/vendors')
      .then(r => r.json())
      .then(d => setVendors((d.vendors || []).filter((v: any) => v.is_active)))
      .catch(() => {});
  }, []);

  const update = (i: number, patch: any) => setItems(prev => prev.map((it, j) => j === i ? { ...it, ...patch } : it));
  const add = () => setItems(prev => [...prev, { uid: newLineUid(), material_id: '', quantity: 1, unit_price: 0, vendor: '', vendor_id: '' }]);
  const remove = (i: number) => setItems(prev => prev.filter((_, j) => j !== i));

  const save = async () => {
    // PUT replaces the whole item list, so an empty list silently WIPED the
    // draft's items (total_cost 0) and a blank row was silently dropped. Validate
    // per row, and never send an empty list.
    if (items.length === 0) {
      alert('A PO needs at least one item. To scrap this PO, use Delete on the draft instead.');
      return;
    }
    const problems: string[] = [];
    items.forEach((it, i) => {
      const qty = Number(it.quantity);
      const px  = Number(it.unit_price);
      const u   = poUnitOf(materials.find(m => m.id === it.material_id));
      if (!it.material_id)      problems.push(`Line ${i + 1}: select an item (or remove the line)`);
      else if (!(qty > 0))      problems.push(`Line ${i + 1}: enter a quantity greater than 0`);
      // ₹0 / negative rates reach the purchases row at receive and drag
      // average_price toward zero.
      else if (!(px > 0))       problems.push(`Line ${i + 1}: enter a unit rate greater than 0 (₹ per ${u || 'purchase unit'})`);
      else if (!it.vendor.trim()) problems.push(`Line ${i + 1}: pick a vendor — receiving files the purchase against it`);
    });
    if (problems.length) {
      // State it as POLICY, because it is one: Smart Reorder deliberately files
      // drafts with a blank line vendor and a 0 rate (lib/crm-reorder-po.ts) for
      // the buyer to complete here. Editing such a draft therefore means
      // finishing every line, not just the one you came to change — approve and
      // receive both reject a zero rate anyway.
      alert(
        problems.join('\n') +
        '\n\nA draft is only saved once every line is complete (item + qty + rate + vendor). ' +
        'Smart Reorder drafts arrive with the vendor and rate blank on purpose — fill those in here.'
      );
      return;
    }
    setSaving(true);
    try {
      const r = await api('/api/purchase-orders', {
        method: 'PUT',
        // uid is client-only row identity — strip it off the wire.
        body: { id: poId, date, notes, items: items.map(({ uid, ...line }) => line) },
      });
      if (!r.ok) { alert((await r.json()).error || 'Failed'); return; }
      onSaved();
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 text-xs">
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className="px-2 py-1 border border-[#E8D5C4] rounded" />
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes" className="px-2 py-1 border border-[#E8D5C4] rounded col-span-2" />
      </div>
      <div className="grid grid-cols-12 gap-2 text-[10px] text-[#8B7355] font-medium px-1">
        <div className="col-span-4">Material</div>
        <div className="col-span-3">Vendor</div>
        <div className="col-span-2 text-right">Qty</div>
        <div className="col-span-1 text-right">Unit ₹</div>
        <div className="col-span-1 text-right">Line ₹</div>
        <div className="col-span-1"></div>
      </div>
      {items.map((it, i) => {
        const mat = materials.find(m => m.id === it.material_id);
        return (
          <div key={it.uid} className="grid grid-cols-12 gap-2 text-xs items-start">
            <div className="col-span-4">
              {/* Locked once chosen — remove the line to order a different item. */}
              {mat ? (
                <div className="px-2 py-1 rounded border border-[#E8D5C4] bg-[#FFF8F0] text-xs text-[#2D1B0E]">
                  <span className="font-mono text-[10px] text-[#8B7355] mr-1">{mat.sku}</span>{mat.name}
                  <div className="text-[9px] text-[#8B7355]">order unit {poUnitOf(mat)} · ₹{poRateOf(mat).toFixed(2)}/{poUnitOf(mat)}</div>
                </div>
              ) : (
                <SimpleMaterialPicker value={it.material_id} materials={materials} onChange={(id, m) => {
                  const patch: any = { material_id: id };
                  // ₹ per PURCHASE unit (kg) — never the raw recipe-unit average.
                  if (m && (id !== it.material_id || !it.unit_price)) patch.unit_price = poRateOf(m);
                  if (m && (!it.vendor || it.vendor.trim() === '')) {
                    // Only seed a vendor the dropdown can actually show — see the
                    // matching comment in the new-PO composer.
                    const dv = (m as any).primary_vendor || '';
                    const mv = vendors.find(v => v.name.toLowerCase().trim() === dv.toLowerCase().trim());
                    patch.vendor    = mv ? mv.name : '';
                    patch.vendor_id = mv ? mv.id : '';
                  }
                  update(i, patch);
                }} />
              )}
            </div>
            <div className="col-span-3">
              {/* Pick from the master — a typed name leaves vendor_id empty and
                  silently breaks every vendor_id-keyed join. Same rule as the
                  new-PO composer, including the legacy escape hatch. */}
              {(() => {
                const knownVendor = vendors.some(v => v.id === it.vendor_id);
                const legacy = !!it.vendor.trim() && !knownVendor;
                return (
                  <select
                    value={legacy ? '__legacy__' : (it.vendor_id || '')}
                    onChange={e => {
                      if (e.target.value === '__legacy__') return;
                      const v = vendors.find(x => x.id === e.target.value);
                      update(i, { vendor_id: v ? v.id : '', vendor: v ? v.name : '' });
                    }}
                    className={`w-full px-1.5 py-1 border rounded text-xs bg-white ${legacy ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4]'}`}
                  >
                    <option value="">Select vendor…</option>
                    {legacy && <option value="__legacy__">{it.vendor} — not in vendor master</option>}
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                );
              })()}
              <EligibleVendorChips
                materialId={it.material_id}
                currentVendor={it.vendor}
                onPick={v => {
                  // Re-resolve the history name against the master so the select
                  // can show it — see the new-PO composer.
                  const mv = vendors.find(x => x.id === v.vendor_id)
                          || vendors.find(x => x.name.toLowerCase().trim() === v.vendor.toLowerCase().trim());
                  update(i, {
                    vendor: mv ? mv.name : v.vendor,
                    vendor_id: mv ? mv.id : '',
                    // > 0, not != null — a ₹0 contract row is "no rate agreed" and
                    // must not overwrite a correctly seeded rate with 0.
                    ...(Number(v.contract_price) > 0
                        ? { unit_price: Number(v.contract_price) }
                        : (!it.unit_price && Number(v.last_price) > 0 ? { unit_price: Number(v.last_price) } : {})),
                  });
                }}
              />
            </div>
            {/* min=0 + clamp — a negative ordered qty/rate is never re-checked at
                receive (only overrides are) so it would reach purchases. */}
            <div className="col-span-2">
              <input type="number" step="any" min={0} value={it.quantity || ''}
                     onChange={e => { const v = parseFloat(e.target.value); update(i, { quantity: Number.isFinite(v) ? Math.max(0, v) : 0 }); }}
                     className="w-full px-2 py-1 border border-[#E8D5C4] rounded text-right" />
              {/* Same labels as the new-PO composer: a PO is in kg/BTL/CASE at
                  ₹/purchase-unit, and here the basis was stated only in the
                  material cell — which wraps out of line on a narrow screen
                  while this box rewrites a live PO's money. */}
              {mat && <div className="text-[9px] text-[#8B7355] text-right mt-0.5">{poUnitOf(mat)}</div>}
            </div>
            <div className="col-span-1">
              <input type="number" step="any" min={0} value={it.unit_price || ''}
                     onChange={e => { const v = parseFloat(e.target.value); update(i, { unit_price: Number.isFinite(v) ? Math.max(0, v) : 0 }); }}
                     className="w-full px-2 py-1 border border-[#E8D5C4] rounded text-right" />
              {mat && <div className="text-[9px] text-[#8B7355] text-right mt-0.5">/ {poUnitOf(mat)}</div>}
              {it.material_id && it.vendor_id && (
                <ContractFlag materialId={it.material_id} vendorId={it.vendor_id}
                              unitPrice={Number(it.unit_price) || 0}
                              onMatch={p => update(i, { unit_price: p })} />
              )}
            </div>
            <div className="col-span-1 text-right font-mono pt-1">{fmt((it.quantity || 0) * (it.unit_price || 0))}</div>
            <button onClick={() => remove(i)} className="col-span-1 text-red-500"><Trash2 className="w-3 h-3" /></button>
          </div>
        );
      })}
      <div className="flex items-center justify-between">
        <button onClick={add} className="text-xs text-[#af4408]"><Plus className="w-3 h-3 inline" /> Add line</button>
        <div className="flex gap-2">
          <button onClick={onCancel} className="text-xs text-[#6B5744]">Cancel</button>
          <button onClick={save} disabled={saving} className="px-3 py-1.5 text-xs bg-[#af4408] hover:bg-[#8a3506] text-white rounded disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/* Approval Context Panel — last 2 purchases + usage + flags     */
/* Helps admin spot stockpiling / panic ordering before approving */
/* ============================================================ */
const FLAG_DEF: Record<string, { label: string; tone: string; help: string }> = {
  over_order:        { label: 'Over-order',         tone: 'bg-red-100 text-red-700 border-red-200',          help: 'Requested qty + current stock would exceed your last 90 days of consumption' },
  recent_purchase:   { label: 'Bought recently',    tone: 'bg-amber-100 text-amber-800 border-amber-200',    help: 'Last purchase was less than 7 days ago' },
  price_jump:        { label: 'Price jump >10%',    tone: 'bg-indigo-100 text-indigo-700 border-indigo-200', help: 'Requested unit price is more than 10% above weighted average' },
  overstock:         { label: 'Already overstocked',tone: 'bg-amber-100 text-amber-800 border-amber-200',    help: 'Current stock alone covers >60 days of usage' },
  no_recent_usage:   { label: 'No recent usage',    tone: 'bg-rose-100 text-rose-700 border-rose-200',       help: 'Item has stock but zero consumption in the last 90 days' },
};

function ApprovalContextPanel({ poId }: { poId: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/purchase-orders/${poId}/approval-context`)
      .then(async r => { if (!r.ok) throw new Error((await r.json()).error || 'Failed'); return r.json(); })
      .then(setData).catch(e => setErr(e.message)).finally(() => setLoading(false));
  }, [poId]);

  if (loading) return <tr><td colSpan={7} className="px-3 py-4 bg-amber-50/30 text-xs text-[#8B7355]">Loading approval context…</td></tr>;
  if (err)     return <tr><td colSpan={7} className="px-3 py-4 bg-red-50 text-xs text-red-700">Error: {err}</td></tr>;
  if (!data)   return null;

  return (
    <tr><td colSpan={7} className="bg-amber-50/30 px-3 py-3 border-b border-amber-200">
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <AlertTriangle className="w-4 h-4 text-amber-700" />
          <span className="text-sm font-semibold text-amber-900">Approval Review</span>
          <span className="text-xs text-[#6B5744]">— check past purchases, current stock, and consumption before approving</span>
          {data.summary.total_flags > 0 ? (
            <span className="ml-auto text-xs text-red-700 font-semibold">⚠ {data.summary.total_flags} flag(s)</span>
          ) : (
            <span className="ml-auto text-xs text-green-700 font-semibold">✓ No flags — looks clean</span>
          )}
        </div>

        <div className="bg-white border border-amber-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-amber-50 text-[#6B5744]">
              <tr>
                <th className="text-left  py-1.5 px-2 font-medium">Item</th>
                <th className="text-right py-1.5 px-2 font-medium">Requested</th>
                <th className="text-right py-1.5 px-2 font-medium">Current Stock</th>
                <th className="text-right py-1.5 px-2 font-medium">Used 30 / 60 / 90 d</th>
                <th className="text-right py-1.5 px-2 font-medium">Days of Stock</th>
                <th className="text-left  py-1.5 px-2 font-medium">Last 2 purchases</th>
                <th className="text-left  py-1.5 px-2 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it: any) => {
                // requested_qty is in PURCHASE units (10 kg) while current_stock and
                // the usage columns are in RECIPE units (2,000 g) — they differ by
                // pack_size, so they must not be labelled the same nor divided
                // directly. Same pack guard as the rest of the app: convert only when
                // pack>1 AND the two units genuinely differ.
                const poUnit = it.material_purchase_unit || it.material_unit;
                const pack   = Number(it.material_pack_size) || 1;
                const packFactor = (pack > 1 && String(poUnit).toLowerCase().trim() !== String(it.material_unit).toLowerCase().trim()) ? pack : 1;
                const reqInStockUnits = (Number(it.requested_qty) || 0) * packFactor;
                const reqVsStock = it.current_stock > 0 && it.requested_qty > 0
                  ? `+${((reqInStockUnits / it.current_stock) * 100).toFixed(0)}%`
                  : null;
                return (
                  <tr key={it.po_item_id} className={`border-t border-amber-100 ${it.flags.length > 0 ? 'bg-red-50/20' : ''}`}>
                    <td className="py-2 px-2">
                      <div className="font-medium text-[#2D1B0E]">{it.material_name}</div>
                      <div className="text-[10px] font-mono text-[#8B7355]">{it.material_sku}</div>
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      <div className="font-semibold">{it.requested_qty.toLocaleString('en-IN')} {poUnit}</div>
                      {/* Always state the basis: a bare "@ ₹151.50" beside the
                          recipe-unit columns reads as ₹/g. poUnit is never blank
                          — the API COALESCEs purchase_unit to the recipe unit. */}
                      <div className="text-[10px] text-[#8B7355]">@ ₹{it.requested_unit_price.toFixed(2)}/{poUnit}</div>
                      {/* Spell out the stock-unit equivalent so "10 kg" can be compared
                          with the recipe-unit stock/usage columns beside it. */}
                      {packFactor > 1 && (
                        <div className="text-[10px] text-[#8B7355]">= {reqInStockUnits.toLocaleString('en-IN')} {it.material_unit}</div>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      <div>{it.current_stock.toLocaleString('en-IN')} {it.material_unit}</div>
                      {reqVsStock && <div className="text-[10px] text-[#8B7355]">order is {reqVsStock} of stock</div>}
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-[#6B5744]">
                      {Math.round(it.usage_30d).toLocaleString('en-IN')} / {Math.round(it.usage_60d).toLocaleString('en-IN')} / {Math.round(it.usage_90d).toLocaleString('en-IN')}
                      {it.avg_daily_usage_30d > 0 && <div className="text-[10px] text-[#8B7355]">avg {it.avg_daily_usage_30d.toFixed(1)}/day</div>}
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      {it.days_of_stock != null
                        ? <span className={it.days_of_stock > 60 ? 'text-amber-700 font-semibold' : it.days_of_stock < 7 ? 'text-red-600 font-semibold' : 'text-[#2D1B0E]'}>
                            {Math.round(it.days_of_stock)} days
                          </span>
                        : <span className="text-[#8B7355]">—</span>}
                    </td>
                    <td className="py-2 px-2">
                      {it.last_purchases.length === 0 ? (
                        <span className="text-[10px] text-[#8B7355]">No history</span>
                      ) : (
                        <div className="space-y-0.5">
                          {it.last_purchases.map((p: any, i: number) => (
                            <div key={i} className="text-[10px]">
                              <span className="text-[#6B5744]">{dateLabel(p.date)}</span>
                              {/* purchases.quantity/unit_price are PURCHASE-unit
                                  basis (canon) — say so, or "10 × ₹900" beside
                                  the recipe-unit stock column reads as 10 g. */}
                              <span className="ml-1 font-mono">{p.quantity.toLocaleString('en-IN')} {poUnit} × ₹{p.unit_price.toFixed(2)}/{poUnit}</span>
                              <span className="ml-1 text-[#8B7355]">· {p.vendor || 'unknown'}</span>
                            </div>
                          ))}
                          {it.days_since_last_purchase != null && (
                            <div className="text-[10px] text-[#8B7355]">{it.days_since_last_purchase}d ago</div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      {it.flags.length === 0 ? (
                        <span className="text-[10px] text-green-700">✓ ok</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {it.flags.map((f: string) => {
                            const def = FLAG_DEF[f] || { label: f, tone: 'bg-gray-100 text-gray-700 border-gray-200', help: '' };
                            return (
                              <span key={f} title={def.help}
                                    className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border ${def.tone}`}>
                                {def.label}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {data.summary.total_flags > 0 && (
          <div className="text-[10px] text-[#6B5744]">
            <span className="font-semibold">Tip:</span> hover any flag for an explanation. Common pattern — store keeps ordering an item where stock already covers months of usage.
            Reject and ask the requester to verify stock first.
          </div>
        )}
      </div>
    </td></tr>
  );
}

/* ============================================================ */
/* Reject PO Modal — quick templates + optional email to drafter */
/* ============================================================ */
const REJECT_TEMPLATES: Array<{ key: string; label: string; reason: string }> = [
  { key: 'overstock',    label: 'Stock too high',
    reason: 'We already have enough stock to cover the next several weeks of usage. Please verify physical stock before re-ordering.' },
  { key: 'no_usage',     label: 'Item not selling',
    reason: 'This item has had no consumption recently. Please confirm there is real demand before stocking up further.' },
  { key: 'price_high',   label: 'Price too high',
    reason: 'The unit price on this PO is significantly above our recent weighted average. Please get a better quote or use a different vendor.' },
  { key: 'wrong_vendor', label: 'Wrong vendor',
    reason: 'Please source from our preferred vendor for this item — better terms / faster lead time / proven quality.' },
  { key: 'duplicate',    label: 'Duplicate / recent PO',
    reason: 'A recent PO for the same item is still pending or was received within the last few days. Avoid duplicate ordering.' },
  { key: 'incomplete',   label: 'Needs more info',
    reason: 'Please add the supplier invoice / quotation reference and confirm the brand/specifications before re-submitting.' },
];

function RejectPOModal({ po, onClose, onRejected }: {
  po: PO;
  onClose: () => void;
  onRejected: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [emailDrafter, setEmailDrafter] = useState(true);
  const [busy, setBusy] = useState(false);

  // Drafted_by stores the user email (per Phase 10 changes); fall back to it for the mailto.
  const drafterEmail = (po.drafted_by || '').includes('@') ? po.drafted_by : '';

  const pickTemplate = (k: string) => {
    const t = REJECT_TEMPLATES.find(x => x.key === k);
    if (!t) return;
    setPickedKey(k);
    setReason(t.reason);
  };

  const buildMailto = (finalReason: string) => {
    const subject = encodeURIComponent(`PO ${po.po_number} rejected — please review`);
    const body = encodeURIComponent(
      `Hi,\n\nYour purchase order ${po.po_number} dated ${po.date} (vendor: ${po.vendor || 'unspecified'}, total ${fmt(po.total_cost)}) was rejected.\n\nReason:\n${finalReason}\n\nPlease address the above and re-submit.\n\nThanks.`,
    );
    return `mailto:${encodeURIComponent(drafterEmail || '')}?subject=${subject}&body=${body}`;
  };

  const submit = async () => {
    if (!reason.trim()) { alert('Please pick a template or write a reason.'); return; }
    setBusy(true);
    try {
      await onRejected(reason.trim());
      // Open mail client AFTER reject succeeds so the action is recorded first
      if (emailDrafter && drafterEmail) {
        window.open(buildMailto(reason.trim()), '_blank');
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <div>
            <h2 className="font-bold text-[#2D1B0E] inline-flex items-center gap-2">
              <XCircle className="w-5 h-5 text-red-600" /> Reject {po.po_number}
            </h2>
            <p className="text-xs text-[#8B7355] mt-0.5">Pick a quick reason or write your own. The requester will see this on the PO.</p>
          </div>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Quick templates */}
          <div>
            <label className="text-xs font-semibold text-[#6B5744]">Quick reasons</label>
            <div className="flex flex-wrap gap-2 mt-2">
              {REJECT_TEMPLATES.map(t => (
                <button key={t.key} type="button" onClick={() => pickTemplate(t.key)}
                        className={`px-2.5 py-1.5 text-xs rounded-md border transition-colors ${
                          pickedKey === t.key
                            ? 'bg-red-600 text-white border-red-600'
                            : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
                        }`}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Reason textarea */}
          <label className="block text-xs text-[#6B5744]">
            Reason
            <textarea value={reason} onChange={e => { setReason(e.target.value); setPickedKey(null); }}
                      rows={4}
                      placeholder="Type a custom reason or tap a quick reason above…"
                      className="w-full mt-1 px-3 py-2 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </label>

          {/* Mailto option */}
          <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 text-xs space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={emailDrafter && !!drafterEmail} disabled={!drafterEmail}
                     onChange={e => setEmailDrafter(e.target.checked)} />
              <span className="font-semibold text-[#2D1B0E]">Email the requester</span>
              {drafterEmail
                ? <span className="text-[#6B5744]">→ <code className="bg-white px-1 rounded">{drafterEmail}</code></span>
                : <span className="text-[#8B7355]">(no email on file — drafter user has no email)</span>}
            </label>
            {emailDrafter && drafterEmail && (
              <p className="text-[10px] text-[#8B7355]">
                Opens your default email client with the PO summary &amp; reason pre-filled — you just hit Send.
              </p>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={busy || !reason.trim()}
                  className="px-3 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
            Reject{emailDrafter && drafterEmail ? ' & Email' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/* Approve PO Modal — confirms approval, requires note if flags  */
/* ============================================================ */
function ApprovePOModal({ po, onClose, onApproved }: {
  po: PO;
  onClose: () => void;
  onApproved: (note: string) => Promise<void>;
}) {
  const [ctx, setCtx] = useState<any>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/purchase-orders/${po.id}/approval-context`)
      .then(r => r.json()).then(setCtx).finally(() => setLoading(false));
  }, [po.id]);

  const flagCount = ctx?.summary?.total_flags || 0;
  const requiresNote = flagCount > 0;
  const canSubmit = !requiresNote || note.trim().length >= 10;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try { await onApproved(note.trim()); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <div>
            <h2 className="font-bold text-[#2D1B0E] inline-flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-blue-600" /> Approve {po.po_number}
            </h2>
            <p className="text-xs text-[#8B7355] mt-0.5">Vendor: {po.vendor || '—'} · Total: {fmt(po.total_cost)}</p>
          </div>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {loading ? (
            <div className="text-center text-xs text-[#8B7355] py-3">Checking flags…</div>
          ) : flagCount === 0 ? (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-xs text-green-800 inline-flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">No flags raised</div>
                <div>This PO passes all auto-checks. You can approve directly.</div>
              </div>
            </div>
          ) : (
            <>
              <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-xs text-amber-900">
                <div className="font-semibold inline-flex items-center gap-1">
                  <AlertTriangle className="w-4 h-4" /> {flagCount} flag(s) detected
                </div>
                <div className="mt-1">
                  Please justify the override. The note becomes part of the audit trail and is visible
                  on the PO history alongside your name.
                </div>
                <ul className="mt-2 space-y-0.5">
                  {(['over_order','recent_purchase','price_jump','overstock','no_recent_usage'] as const).map(k => {
                    const n = ctx?.summary?.[`${k}_count`] || 0;
                    if (!n) return null;
                    const label = (FLAG_DEF[k] || { label: k }).label;
                    return <li key={k}>• <span className="font-mono">{n}×</span> {label}</li>;
                  })}
                </ul>
              </div>

              <label className="block text-xs text-[#6B5744]">
                Override note <span className="text-red-600">*</span>
                <textarea value={note} onChange={e => setNote(e.target.value)}
                          rows={3}
                          placeholder="e.g. Confirmed with vendor that price jump is one-time festival surcharge…"
                          className="w-full mt-1 px-3 py-2 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                <span className="text-[10px] text-[#8B7355]">Minimum 10 characters.</span>
              </label>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={busy || !canSubmit}
                  className="px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
            {requiresNote ? 'Approve with override' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}
