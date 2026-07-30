'use client';

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ClipboardList, Plus, Trash2, Search, Loader2, CheckCircle2, XCircle, Send,
  ShieldCheck, PackageCheck, RefreshCw, AlertTriangle, ChevronDown, Printer, Lock,
} from 'lucide-react';
import { api } from '@/lib/api';
import { allocateBillCharges, resolveCharge, MIN_NET_RATE, NON_ADMIN_DISCOUNT_CAP_PCT } from '@/lib/po-charges';
import { packFactor, toPurchaseQty, fmtQtyNum, type PackMeta } from '@/lib/pack-units';

// Always 2 dp: at 0 dp the paise were dropped per row, so the item column
// visibly failed to add up to the footer/list total (₹235.50 + ₹118.50 showed
// as ₹236 + ₹119 = ₹355 against a ₹354 header). Every ₹ TOTAL on this page goes
// through this one formatter; the per-line rates spell out .toFixed(2) inline.
// Either way nothing on this page rounds money to whole rupees, so the same
// number never reads two different ways in two places.
const fmt = (v: number) => '₹' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateLabel = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
/** QTY for humans. Binary floats make 2.4 − 2.5 = −0.09999999999999964, and that
 *  string was being read out to the receiver in the deviation hint, the blocking
 *  banner, the button tooltip and the submit alert. 6 dp is far finer than any
 *  qty a receiving bay types, so this only ever trims the noise. */
const qfmt = (n: number) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 6 });
/** "Differs from the PO" tolerances — the receive route's own values
 *  (receive/route.ts QTY_EPS / RATE_EPS). Kept identical so this screen never
 *  demands a reason for a difference the server would ignore, or vice versa. */
const QTY_EPS = 1e-6;
const RATE_EPS = 0.005;   // ₹ — half a paisa

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

/* ── PURCHASE-LEAD DISPLAY (owner rule) ───────────────────────────────────────
 * Every quantity on this page LEADS in the purchase unit; the recipe figure
 * rides along as a small hint whenever the pack factor is real. A PO quantity is
 * ALREADY stored in purchase units, so nothing here ever DIVIDES an ordered /
 * received qty — the hint MULTIPLIES up to the recipe basis. Only the approval
 * drawer's stock + usage columns (recipe-basis columns off raw_materials) get
 * divided, and they go through toPurchaseQty.
 *
 * The both-halves guard (pack > 1 AND recipe unit ≠ purchase unit) lives in
 * packFactor() and is never re-derived here — two copies is how the bases drift.
 */
const HINT_CLS = 'text-[9px] text-[#B8A590]';
/** Pack meta off any API row that carries the material_* trio (PO items,
 *  approval-context items). purchase_unit falls back to the recipe unit exactly
 *  as the SQL COALESCE does, so packFactor's guard sees the same pair server and
 *  client. */
const packMetaOf = (r: any): PackMeta => ({
  unit: r?.material_unit,
  purchase_unit: r?.material_purchase_unit || r?.material_unit,
  pack_size: r?.material_pack_size,
});
/** Pack meta from an inventory Material (the composer's picker list). */
const packMetaOfMat = (m?: Partial<Material> | null): PackMeta => ({
  unit: m?.unit, purchase_unit: m?.purchase_unit || m?.unit, pack_size: m?.pack_size,
});
/** "= 10,000 g" — the recipe-unit equivalent of a PURCHASE quantity. Null when
 *  there is no real pack conversion: the two bases are then the same number and
 *  a hint would only add noise. DISPLAY ONLY — never post this back. */
const recipeHint = (purchaseQty: number, m: PackMeta): string | null => {
  const pf = packFactor(m);
  if (pf <= 1) return null;
  return `= ${fmtQtyNum((Number(purchaseQty) || 0) * pf)} ${String(m.unit || '').trim()}`.trim();
};
/** "1 kg = 1,000 g" — states the pack itself, for the composer's item note. */
const packNote = (m: PackMeta): string | null => {
  const pf = packFactor(m);
  if (pf <= 1) return null;
  return `1 ${String(m.purchase_unit || '').trim()} = ${fmtQtyNum(pf)} ${String(m.unit || '').trim()}`;
};

interface POItem {
  id: string; material_id: string; material_name?: string; material_sku?: string;
  /** RECIPE unit (g/ml) — for the hint only; a PO line is never expressed in it. */
  material_unit?: string;
  /** PURCHASE unit (kg/BTL/CASE) — the basis of quantity AND unit_price. */
  material_purchase_unit?: string;
  /** raw_materials.pack_size — recipe units per purchase unit. */
  material_pack_size?: number;
  quantity: number; unit_price: number; total_price: number;
  current_avg_price?: number; last_purchase_price?: number; notes?: string;
}
interface PO { id: string; po_number: string; date: string; vendor: string; status: string; total_cost: number; notes: string; drafted_by: string; submitted_at?: string; approved_by?: string; approved_at?: string; rejected_reason?: string; received_at?: string; item_count?: number; items?: POItem[]; }

const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  pending: 'bg-amber-100 text-amber-800',
  pending_reapproval: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-800',
  received: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-100 text-slate-500 line-through',
};

/**
 * THE tab → statuses map. The row filter and the tab badge both read this, so a
 * PO counted in a tab is always listed in it.
 *
 * They used to be written separately and had drifted apart in two places:
 *   • the badge counted 'cancelled' under Rejected/Cancelled while the filter
 *     tested `status === 'rejected'`, so a cancelled PO showed as "(1)" over an
 *     empty "No POs in this view";
 *   • 'pending_reapproval' — written by [id]/edit-approved and accepted by
 *     approve/reject — appeared in NO map at all, so a PO sent back for
 *     re-approval was invisible everywhere except the All tab, silently missing
 *     from the approval queue.
 * Add a new status here and both surfaces pick it up together.
 */
const TAB_STATUSES: Record<string, string[]> = {
  draft:    ['draft'],
  pending:  ['pending', 'pending_reapproval'],
  approved: ['approved'],
  received: ['received'],
  rejected: ['rejected', 'cancelled'],
};

export default function PurchaseOrdersPage() {
  const [pos, setPos] = useState<PO[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  // Starts at the LOWER tier, same rule as the setter below: until the server
  // has actually said "admin", the answer to "is this viewer an admin" is no.
  // (It also stops a manager's first paint claiming "signed in as ADMIN".)
  const [role, setRole] = useState<'admin' | 'manager'>('manager');
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
      // Fail CLOSED to the lower tier. This was `=== 'manager' ? 'manager' : 'admin'`,
      // which handed out 'admin' for anything that wasn't literally "manager" — an
      // absent field, an error body, a future role string. `role` gates the
      // admin-only rate unlock in the receive modal, so an unexpected value must
      // never resolve to the MORE privileged answer. Only an explicit 'admin' is admin.
      setRole(posRes.viewer_role === 'admin' ? 'admin' : 'manager');
      setMaterials(invRes.materials || []);
    } catch {
      // Promise.all rejecting (network blip, a non-JSON 500 so r.json() throws)
      // used to skip BOTH setters and leave `role` at whatever it was — which,
      // on the first load, was 'admin'. Fail closed explicitly: no rows, lower
      // tier. Refresh re-runs this.
      setPos([]);
      setRole('manager');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Role is now driven by the logged-in user (api/auth/me). Toggle is removed.

  const filtered = useMemo(() => {
    let list = pos;
    // Same map the badges use — never `status === tab`, which silently drops any
    // status whose name isn't identical to the tab key (cancelled, pending_reapproval).
    if (tab !== 'all') {
      const allowed = TAB_STATUSES[tab] || [tab];
      list = list.filter(p => allowed.includes(p.status));
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p => p.po_number.toLowerCase().includes(q) || (p.vendor || '').toLowerCase().includes(q));
    }
    return list;
  }, [pos, tab, search]);

  // Derived from TAB_STATUSES so a badge can never count something the tab
  // won't show (or miss something it will).
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [key, statuses] of Object.entries(TAB_STATUSES)) {
      out[key] = pos.filter(p => statuses.includes(p.status)).length;
    }
    return out as { draft: number; pending: number; approved: number; received: number; rejected: number };
  }, [pos]);

  const action = async (id: string, kind: 'submit' | 'approve' | 'reject' | 'cancel' | 'receive', body: any = {}) => {
    setSavingId(id);
    try {
      const r = await api(`/api/purchase-orders/${id}/${kind}`, { method: 'POST', body });
      const j = await r.json().catch(() => ({} as any));
      if (!r.ok) { alert(j.error || `Failed to ${kind}`); return; }
      // With `po_require_admin_approval` OFF, submit ALSO approves in the same
      // txn (submit/route.ts returns auto_approved). The default tab is Pending
      // Approval, so without this the PO just vanishes from the list and the
      // user is never told it is now receivable. Say it, then show it.
      if (kind === 'submit' && j.auto_approved) {
        alert('Submitted and auto-approved — admin approval is currently OFF (Settings → Purchasing).\n\nThis PO is in Approved and can be received now.');
        setTab('approved');
      }
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
                    // Derive from the SAME map the tab uses. Testing the literal
                    // 'pending' left a pending_reapproval PO counted in the Pending
                    // Approval tab with no Approve/Reject button — visible but
                    // un-actionable, a worse dead end than being hidden. Both
                    // approve/route.ts:18 and reject/route.ts:22 already accept it.
                    const inApproval = TAB_STATUSES.pending.includes(p.status);
                    const canApprove = inApproval && role === 'admin';
                    const canReject = inApproval && role === 'admin';
                    // Deliberately NOT inApproval: cancel/route.ts:22 accepts only
                    // draft/pending/rejected, so offering it on pending_reapproval
                    // would render a button that 400s. Widen BOTH or neither.
                    const canCancel = ['draft', 'pending', 'rejected'].includes(p.status);
                    const canReceive = p.status === 'approved';
                    const canDelete = p.status === 'draft';
                    return (
                      // Key belongs on the FRAGMENT, not the inner <tr>: a row can
                      // render up to three siblings (row + detail + review), so a
                      // keyless <> makes React reconcile this list by index and
                      // remount everything below an approve/reject reorder.
                      <Fragment key={p.id}>
                        <tr className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30">
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
                              {inApproval && (
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
                      </Fragment>
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
                        role={role}
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
/**
 * One bill-level charge row: By % / By Amount + the resolved ₹ figure.
 * Same shape and behaviour as the Enter Full Bill modal on /purchases, so the
 * two places a bill is entered look identical; only the effect on cost differs,
 * and `hint` is where that is stated.
 */
function ChargeRow({ label, hint, mode, value, onMode, onValue, placeholder, resolved, tone, negative }: {
  label: string; hint: string;
  mode: 'pct' | 'amt'; value: string;
  onMode: (m: 'pct' | 'amt') => void;
  onValue: (v: string) => void;
  placeholder: string; resolved: number; tone: string; negative?: boolean;
}) {
  const name = label.replace(/\s+/g, '-').toLowerCase();
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-xs font-medium text-[#6B5744] min-w-[120px]">
        {label}
        <span className="block text-[10px] font-normal text-[#8B7355]">{hint}</span>
      </span>
      <div className="flex items-center gap-2">
        {(['pct', 'amt'] as const).map(m => (
          <label key={m} className="flex items-center gap-1 cursor-pointer">
            {/* name= groups each pair, so the two rows keep separate selections */}
            <input type="radio" name={name} checked={mode === m} onChange={() => onMode(m)} className="accent-[#af4408]" />
            <span className="text-xs text-[#6B5744]">{m === 'pct' ? 'By %' : 'By Amount'}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-1">
        {mode === 'amt' && <span className="text-xs text-[#8B7355]">₹</span>}
        <input type="number" step="0.01" min="0" value={value}
               onChange={e => onValue(e.target.value)} placeholder={placeholder}
               className="w-24 px-2 py-1 bg-white border border-[#D4B896] rounded text-xs text-right" />
        <span className="text-xs text-[#8B7355]">{mode === 'pct' ? '%' : ''}</span>
      </div>
      <span className={`text-xs font-semibold ml-auto ${tone}`}>
        {negative && resolved > 0 ? '− ' : ''}{fmt(resolved)}
      </span>
    </div>
  );
}

function ReceiveModal({ poId, role, onClose, onReceived }: {
  poId: string; role: 'admin' | 'manager'; onClose: () => void; onReceived: () => void;
}) {
  const [po, setPo] = useState<PO | null>(null);
  const [items, setItems] = useState<POItem[]>([]);
  const [overrides, setOverrides] = useState<Record<string, { quantity: number; unit_price: number }>>({});
  const [receivedAt, setReceivedAt] = useState<string>(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  // Per-line rate unlock + per-line "why does this differ from the PO" reason.
  const [rateUnlocked, setRateUnlocked] = useState<Record<string, boolean>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  /* BILL CHARGES — entered once for the whole delivery, allocated per line by
     the server. Discount REDUCES cost (it is netted into the rate written to
     purchases.unit_price, which is what average_price averages); Delivery is
     RECORDED ONLY. The %/₹ mode is transient UI state and is never persisted —
     the client resolves it to rupees before posting, same as /purchases. */
  const [deliveryMode, setDeliveryMode] = useState<'pct' | 'amt'>('amt');
  const [deliveryValue, setDeliveryValue] = useState('');
  const [discountMode, setDiscountMode] = useState<'pct' | 'amt'>('amt');
  const [discountValue, setDiscountValue] = useState('');
  const [chargesNote, setChargesNote] = useState('');
  const [billNo, setBillNo] = useState('');

  /* WHO MAY UNLOCK A LINE'S RATE.
   * The rate typed here is written to purchases.unit_price and then through
   * updateMaterialPrice into raw_materials.average_price — i.e. into the cost of
   * every recipe that uses the material. A silent re-type at the receiving bay is
   * exactly what must not happen, so the rate is plain text by default.
   * Only 'admin' unlocks it. `role` comes from /api/purchase-orders' viewer_role,
   * which is effectiveRole() — and that collapses staff → 'manager'. So on this
   * page 'manager' means "everyone who got past poWriteGate and is doing the
   * receiving" (manager, HOD, storekeeper): precisely the people the lock exists
   * for. Admin is the only tier this response can actually distinguish, so admin
   * is the unlock. A manager who genuinely got a re-rated bill asks an admin —
   * the same person who already approves the PO. */
  const canChangeRate = role === 'admin';

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

  /* ── THE ONE DEFINITION OF "THIS LINE DEVIATES" ───────────────────────────
   * A line deviates when the received qty differs from the ordered qty (short OR
   * excess) or the effective rate differs from the ordered rate. Every deviating
   * line needs a typed reason and raises an admin alert server-side.
   * The row hint, the blocking banner, the disabled Confirm button and the
   * submitted item_overrides all read THIS memo, so they can never disagree
   * about which lines are deviating (the payload filter used to be a separate
   * copy of the same predicate).
   * Qty and rate here are PURCHASE units / ₹ per purchase unit — never the
   * recipe unit — so every number is labelled with material_purchase_unit.
   * The tolerances are the receive route's own (QTY_EPS 1e-6, RATE_EPS 0.005 —
   * receive/route.ts), so a line this screen demands a reason for is exactly a
   * line the server would refuse without one: an exact `!== 0` here blocked
   * Confirm on ₹900.002 vs ₹900, which the route treats as no change at all. */
  const deviations = useMemo(() => items.map(it => {
    const ov = overrides[it.id] || { quantity: it.quantity, unit_price: it.unit_price };
    const qty       = Number(ov.quantity);
    const price     = Number(ov.unit_price);
    const qtyDiff   = qty - it.quantity;
    const priceDiff = price - it.unit_price;
    const qtyOff    = Math.abs(qtyDiff) > QTY_EPS;
    const rateOff   = Math.abs(priceDiff) > RATE_EPS;
    const u = (it as any).material_purchase_unit || (it as any).material_unit || '';
    // Pack meta rides along so every qty cell on the row can print its recipe
    // hint from ONE resolution — a per-cell re-derivation is how "Ordered 10 kg"
    // ended up beside a sibling reading grams.
    const meta = packMetaOf(it);
    const bits: string[] = [];
    if (qtyOff) {
      bits.push(`${qtyDiff > 0 ? 'excess' : 'short'} ${qfmt(Math.abs(qtyDiff))}${u ? ' ' + u : ''} ` +
                `(received ${qfmt(qty)}${u ? ' ' + u : ''} vs ordered ${qfmt(it.quantity)}${u ? ' ' + u : ''})`);
    }
    if (rateOff) {
      bits.push(`rate ₹${price.toFixed(2)}${u ? '/' + u : ''} vs ordered ₹${it.unit_price.toFixed(2)}${u ? '/' + u : ''}`);
    }
    return { it, ov, qtyDiff, priceDiff, qtyOff, rateOff, u, meta, deviates: bits.length > 0, label: bits.join(' · ') };
  }), [items, overrides]);

  // Free text, trimmed, ≥ 3 chars — same floor the receive route enforces, so a
  // reason the server would reject can never look accepted here.
  const MIN_REASON = 3;
  const missingReason = deviations.filter(d => d.deviates && (reasons[d.it.id] || '').trim().length < MIN_REASON);
  const missingList = (prefix: string) =>
    prefix + missingReason.map(d => `• ${d.it.material_name} — ${d.label}`).join('\n');

  const total = items.reduce((s, it) => {
    const ov = overrides[it.id] || it;
    return s + (Number(ov.quantity) || 0) * (Number(ov.unit_price) || 0);
  }, 0);
  const orderedTotal = items.reduce((s, it) => s + it.quantity * it.unit_price, 0);

  /* The bill preview runs the SAME allocator the route runs, on the SAME
     effective numbers the deviations memo uses — so the figure the receiver
     confirms is the figure that gets booked. */
  const billCalc = useMemo(() => {
    const chargeLines = deviations.map(d => ({
      id: d.it.id, name: d.it.material_name,
      qty: Number(d.ov.quantity) || 0, rate: Number(d.ov.unit_price) || 0,
    }));
    const subtotal = chargeLines.reduce((s, l) => s + (l.qty > 0 && l.rate > 0 ? l.qty * l.rate : 0), 0);
    const discount = resolveCharge(discountMode, discountValue, subtotal);
    const delivery = resolveCharge(deliveryMode, deliveryValue, subtotal);
    return { alloc: allocateBillCharges(chargeLines, { discount, delivery }), discount, delivery };
  }, [deviations, discountMode, discountValue, deliveryMode, deliveryValue]);

  const alloc = billCalc.alloc;
  const hasCharges = alloc.discount_applied > 0 || alloc.delivery > 0;
  // A discount changes what stock cost — it needs the same "say why" discipline
  // as an off-PO line, and the server enforces the identical floor.
  const needsChargeNote = alloc.discount_applied > 0 && chargesNote.trim().length < MIN_REASON;
  // > cap + half a paisa — the same headroom the route uses, so an exactly-25%
  // discount is not refused here while the server would accept it.
  const overDiscountCap = !canChangeRate && alloc.subtotal > 0
    && alloc.discount_applied - (alloc.subtotal * NON_ADMIN_DISCOUNT_CAP_PCT) / 100 > 0.005;
  const zeroCost = alloc.zero_cost_lines;
  const chargeBlockers: string[] = [
    ...(needsChargeNote ? ['Say why the vendor gave the discount (min 3 characters).'] : []),
    ...(overDiscountCap ? [`A discount above ${NON_ADMIN_DISCOUNT_CAP_PCT}% of the bill needs an admin to receive.`] : []),
    ...(zeroCost.length > 0 ? [`The discount is bigger than these lines are worth: ${zeroCost.map(l => l.name).join(', ')}.`] : []),
    ...(alloc.subtotal <= 0 && hasCharges ? ['Nothing is being accepted, so there is nothing to apply the bill charges to.'] : []),
  ];

  const submit = async () => {
    // Belt-and-braces with the disabled button: the reason gate must not be
    // skippable by a stale click. (The receive route re-checks it anyway — that
    // is the real gate; this is only so the receiver gets a readable message.)
    if (missingReason.length > 0) {
      alert(missingList('Add a reason for these lines before receiving:\n'));
      return;
    }
    // Same belt-and-braces as the reason gate — the route re-checks every one of
    // these; this is only so the receiver gets a readable message.
    if (chargeBlockers.length > 0) {
      alert('Fix the bill charges before receiving:\n' + chargeBlockers.map(b => `• ${b}`).join('\n'));
      return;
    }
    setSaving(true);
    try {
      // Only deviating lines are sent — and every one of them carries the reason
      // the receiver typed, as deviation_reason (why it differs from the PO).
      // rejection_reason stays what it always was: QC, why units were rejected.
      const deviating = deviations.filter(d => d.deviates);
      const item_overrides = deviating.map(d => ({
        po_item_id: d.it.id,
        quantity: d.ov.quantity,
        unit_price: d.ov.unit_price,
        deviation_reason: (reasons[d.it.id] || '').trim(),
      }));
      const r = await api(`/api/purchase-orders/${poId}/receive`, {
        method: 'POST',
        body: {
          received_at: receivedAt, item_overrides,
          // Rupees, resolved from the %/₹ toggle here. The server re-allocates
          // from its own effective line values — it never trusts these shares.
          bill_charges: hasCharges || billNo.trim() ? {
            // Mode + raw value travel WITH the resolved rupees: this preview
            // sums every PO line, but the route allocates only over the lines it
            // actually receives (store-mapped ones are dropped), so a "5%" here
            // could land as 10% there. The route re-resolves a percentage
            // against its own base; the ₹ figure covers By-Amount + old clients.
            discount_mode: discountMode, discount_value: Number(discountValue) || 0,
            delivery_mode: deliveryMode, delivery_value: Number(deliveryValue) || 0,
            discount_amount: alloc.discount_applied,
            delivery_amount: alloc.delivery,
            charges_note: chargesNote.trim(),
            bill_no: billNo.trim(),
          } : undefined,
        },
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
      // Off-PO acknowledgement — show the receiver that the admin has been
      // notified (audit_event + in-app notification + optional Slack).
      // Excess and short/rate are NOT alternatives: a mixed receive is 1 line
      // over AND 2 short. These used to be if/else-if, so the excess line
      // swallowed the confirmation for exactly the short lines the receiver had
      // just been forced to justify. One alert, both facts.
      const notes: string[] = [];
      if (deviating.length > 0) {
        // Counted from what we SENT rather than a response field, so this stays
        // true whatever the route names its counters. Short qty and rate changes
        // raise the same admin alert as excess.
        notes.push(
          `${deviating.length} line(s) differed from the PO (qty and/or rate). ` +
          'The reason you gave has been recorded and the admin has been notified for review.'
        );
      }
      if (j.excess_lines > 0) {
        notes.push(
          `${j.excess_lines} line(s) were accepted OVER the ordered qty (${fmt(j.excess_value || 0)} excess) — ` +
          'recorded on /audit with the rest of this receive.'
        );
      }
      if (j.charges_applied && (j.charges_applied.discount_applied > 0 || j.charges_applied.delivery > 0)) {
        const c = j.charges_applied;
        notes.push(
          `Bill charges booked: discount ${fmt(c.discount_applied)} (reduced the cost of stock)` +
          `${c.discount_clamped ? ' — capped at the bill value' : ''}` +
          ` · delivery ${fmt(c.delivery)} (recorded against the bill, not added to item cost).`
        );
      }
      if (notes.length > 0) alert('Received.\n\n' + notes.join('\n\n'));
      onReceived();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-3 overflow-y-auto">
      {/* Capped shell (header + footer pinned, body scrolls): the charges card
          made this modal tall enough to push Confirm below the fold on phones —
          the same bug the create-PO modal already fixed once. */}
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-3xl my-4 shadow-xl flex flex-col overflow-hidden"
           style={{ maxHeight: 'calc(100vh - 1.5rem)' }}>
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <div>
            <h2 className="font-bold text-[#2D1B0E]">Receive PO {po?.po_number}</h2>
            <p className="text-xs text-[#8B7355] mt-0.5">
              Adjust the qty if you got more / less. The rate is locked to the PO
              {canChangeRate ? ' — unlock a line only if the vendor genuinely billed differently.' : ' and only an admin can change it.'}
              {' '}Any line that differs from the PO needs a reason and alerts the admin. Stock + recipe costs update on submit.
            </p>
          </div>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
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
                  {/* Rows are driven by `deviations`, not `items`, so the hints,
                      the reason gate and the payload all read one computation.
                      A PO's qty + rate are in the PURCHASE unit (kg, BTL, CASE)
                      — NOT the recipe/stock unit (g, ml), which differs by
                      pack_size. `u` is that purchase unit and labels every
                      qty/rate cell so the receiver knows what they're confirming. */}
                  {deviations.map(({ it, ov, qtyDiff, priceDiff, qtyOff, rateOff, u, meta, deviates, label }) => {
                    const lineTotal = Number(ov.quantity) * Number(ov.unit_price);
                    // Recipe hints — display only. Both bases are printed on the
                    // SAME row so an ordered "10 kg" and a received "10 kg" can
                    // never be read against a sibling cell in grams.
                    const ordHint = recipeHint(it.quantity, meta);
                    const rcvHint = recipeHint(Number(ov.quantity) || 0, meta);
                    const unlocked = !!rateUnlocked[it.id];
                    const reason = reasons[it.id] || '';
                    const needsReason = deviates && reason.trim().length < MIN_REASON;
                    return (
                      <Fragment key={it.id}>
                      <tr className={`border-t border-[#E8D5C4]/50 ${deviates ? 'bg-amber-50/40' : ''}`}>
                        <td className="py-1.5 px-2">
                          <div className="text-[#2D1B0E]">{it.material_name}</div>
                          <div className="text-[10px] text-[#8B7355]">{it.material_sku} · {u}</div>
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono">
                          {it.quantity.toLocaleString('en-IN')}
                          {u && <span className="ml-1 text-[10px] text-[#8B7355]">{u}</span>}
                          {ordHint && <div className={HINT_CLS}>{ordHint}</div>}
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
                                   className={`w-full px-1.5 py-1 border rounded text-right ${qtyOff ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4]'}`} />
                            {u && <span className="text-[10px] text-[#8B7355]">{u}</span>}
                          </div>
                          {/* The box is a PURCHASE-unit box (same basis the PO
                              and the receive route store), so this hint only
                              reads the typed number out in recipe units — the
                              value posted is never round-tripped through it. */}
                          {rcvHint && <div className={`${HINT_CLS} mt-0.5 text-right`}>{rcvHint}</div>}
                          {qtyOff && (
                            <div className={`text-[9px] mt-0.5 text-right ${qtyDiff > 0 ? 'text-blue-600' : 'text-amber-700'}`}>
                              {qtyDiff > 0 ? '+' : ''}{qfmt(qtyDiff)}{u ? ' ' + u : ''} vs ordered
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono text-[10px] text-[#8B7355]">
                          ₹{it.unit_price.toFixed(2)}{u && <span>/{u}</span>}
                        </td>
                        {/* RATE — read-only unless this line was explicitly
                            unlocked by an admin (see canChangeRate). It is the
                            number that rewrites average_price, so it is never
                            a stray keystroke away. */}
                        <td className="py-1.5 px-2">
                          {unlocked ? (
                            <>
                              <div className="flex items-center gap-1 justify-end">
                                <input type="number" step="any" min={0} value={ov.unit_price} autoFocus
                                       onChange={e => {
                                         const v = parseFloat(e.target.value);
                                         setPrice(it.id, Number.isFinite(v) ? Math.max(0, v) : 0);
                                       }}
                                       className={`w-full px-1.5 py-1 border rounded text-right ${rateOff ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4]'}`} />
                                {u && <span className="text-[10px] text-[#8B7355]">/{u}</span>}
                              </div>
                              {rateOff && (
                                <div className={`text-[9px] mt-0.5 text-right ${priceDiff > 0 ? 'text-red-600' : 'text-green-700'}`}>
                                  {priceDiff > 0 ? '+' : ''}₹{priceDiff.toFixed(2)}{u && `/${u}`} vs ordered
                                </div>
                              )}
                              <button type="button"
                                      onClick={() => {
                                        // Re-locking restores the PO rate, so a
                                        // half-typed change can't survive as a
                                        // deviation nobody meant to make.
                                        setPrice(it.id, it.unit_price);
                                        setRateUnlocked(m => ({ ...m, [it.id]: false }));
                                      }}
                                      className="mt-0.5 block ml-auto text-[9px] text-[#8B7355] hover:text-[#af4408] underline">
                                Reset to PO rate
                              </button>
                            </>
                          ) : (
                            <div className="text-right">
                              <div className="font-mono text-[#2D1B0E] flex items-center gap-1 justify-end">
                                <Lock className="w-3 h-3 text-[#8B7355]" />
                                ₹{Number(ov.unit_price).toFixed(2)}{u && <span className="text-[10px] text-[#8B7355]">/{u}</span>}
                              </div>
                              {canChangeRate ? (
                                <button type="button" onClick={() => setRateUnlocked(m => ({ ...m, [it.id]: true }))}
                                        className="mt-0.5 text-[9px] text-[#af4408] hover:text-[#8a3506] underline">
                                  Change rate
                                </button>
                              ) : (
                                <div className="mt-0.5 text-[9px] text-[#8B7355]">PO rate — admin only</div>
                              )}
                              {/* A ₹0 PO rate is rejected by the receive route
                                  (it would wipe average_price to 0), and the
                                  lock means only an admin can fix it — say so
                                  here instead of failing on submit.
                                  Gated on qty > 0 the same way the route is
                                  (`effAcc > 0 && effPrice <= 0`): a line
                                  received at 0 never reaches updateMaterialPrice,
                                  so the server accepts it and this must not
                                  claim otherwise. */}
                              {Number(ov.quantity) > 0 && Number(ov.unit_price) <= 0 && (
                                <div className="mt-0.5 text-[9px] text-red-600">
                                  PO rate is ₹0 — {canChangeRate ? 'set a real rate to receive this line.' : 'an admin must set a real rate before this can be received.'}
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono font-semibold">{fmt(lineTotal)}</td>
                      </tr>
                      {/* REASON — appears the moment a line stops matching the
                          PO (short, excess, or a changed rate). Required: the
                          receive route rejects a deviating line without one, and
                          the admin alert quotes it. */}
                      {deviates && (
                        <tr className="bg-amber-50/40">
                          <td colSpan={6} className="px-2 pb-2">
                            <div className="flex flex-col sm:flex-row sm:items-center gap-1.5">
                              <span className={`text-[10px] shrink-0 ${needsReason ? 'text-amber-800 font-semibold' : 'text-[#6B5744]'}`}>
                                <AlertTriangle className="w-3 h-3 inline mr-1 -mt-0.5" />
                                {label}{needsReason ? ' — reason required' : ''}
                              </span>
                              <input value={reason}
                                     onChange={e => setReasons(r => ({ ...r, [it.id]: e.target.value }))}
                                     placeholder="Why does this differ from the PO? e.g. vendor short-supplied; rate revised on bill #1234"
                                     className={`flex-1 min-w-0 px-2 py-1 border rounded text-[11px] bg-white ${needsReason ? 'border-amber-400' : 'border-[#E8D5C4]'}`} />
                            </div>
                          </td>
                        </tr>
                      )}
                      </Fragment>
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

          {/* BILL CHARGES — what the vendor's bill carries beyond the goods.
              Discount REDUCES the cost of the stock (it is netted into the rate
              booked to purchases.unit_price, which is what average_price — and
              therefore every recipe cost — averages). Delivery is RECORDED only:
              it is stored against the bill and never enters item cost. */}
          {!loading && (
            <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2.5 space-y-2">
              <div className="text-xs font-semibold text-[#2D1B0E]">Bill charges (optional)</div>
              <ChargeRow label="Delivery Charges" hint="recorded on the bill — does not change item cost"
                         mode={deliveryMode} value={deliveryValue}
                         onMode={setDeliveryMode} onValue={setDeliveryValue}
                         placeholder={deliveryMode === 'pct' ? 'e.g. 2' : 'e.g. 500'}
                         resolved={alloc.delivery} tone="text-[#6B5744]" />
              <ChargeRow label="Discount" hint="reduces what the goods cost — updates stock value + recipe costs"
                         mode={discountMode} value={discountValue}
                         onMode={setDiscountMode} onValue={setDiscountValue}
                         placeholder={discountMode === 'pct' ? 'e.g. 5' : 'e.g. 250'}
                         resolved={alloc.discount_applied} tone="text-emerald-700" negative />
              <div className="flex flex-col sm:flex-row gap-2">
                <input value={billNo} onChange={e => setBillNo(e.target.value)}
                       placeholder="Vendor bill no. (optional)"
                       className="sm:w-48 px-2 py-1 border border-[#E8D5C4] rounded text-[11px] bg-white" />
                {alloc.discount_applied > 0 && (
                  <input value={chargesNote} onChange={e => setChargesNote(e.target.value)}
                         placeholder="Why the discount? e.g. 5% scheme on bill #4471"
                         className={`flex-1 min-w-0 px-2 py-1 border rounded text-[11px] bg-white ${needsChargeNote ? 'border-amber-400' : 'border-[#E8D5C4]'}`} />
                )}
              </div>
              {hasCharges && alloc.subtotal > 0 && (
                <div className="border-t border-[#E8D5C4] pt-1.5 text-[11px] font-mono space-y-0.5">
                  <div className="flex justify-between text-[#6B5744]"><span>Accepted subtotal</span><span>{fmt(alloc.subtotal)}</span></div>
                  {alloc.discount_applied > 0 && (
                    <div className="flex justify-between text-emerald-700"><span>− Discount</span><span>− {fmt(alloc.discount_applied)}</span></div>
                  )}
                  <div className="flex justify-between font-semibold text-[#2D1B0E]">
                    <span>= Cost basis booked to stock</span><span>{fmt(alloc.net_subtotal)}</span>
                  </div>
                  {alloc.delivery > 0 && (
                    <div className="flex justify-between text-[#8B7355]"><span>+ Delivery (recorded only)</span><span>{fmt(alloc.delivery)}</span></div>
                  )}
                  <div className="flex justify-between text-[#6B5744] border-t border-[#E8D5C4]/60 pt-0.5">
                    <span>Bill total</span><span>{fmt(alloc.net_subtotal + alloc.delivery)}</span>
                  </div>
                </div>
              )}
              {alloc.discount_clamped && (
                <div className="text-[10px] text-amber-800">
                  The discount is larger than the bill — capped at {fmt(alloc.subtotal)}.
                </div>
              )}
              {chargeBlockers.length > 0 && (
                <ul className="text-[10px] text-red-700 space-y-0.5">
                  {chargeBlockers.map((b, i) => <li key={i}>• {b}</li>)}
                </ul>
              )}
              {zeroCost.length > 0 && (
                <div className="text-[10px] text-red-700">
                  A line booked at ₹0 would wipe that material&apos;s average price and every recipe that uses it
                  (floor {fmt(MIN_NET_RATE)}). Reduce the discount, or record it as a credit note instead.
                </div>
              )}
            </div>
          )}

          {/* Names every line still blocking the receive, so the receiver never
              has to hunt for which row the disabled button is waiting on. */}
          {missingReason.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">
                  {missingReason.length} line(s) differ from the PO and still need a reason (min {MIN_REASON} characters):
                </div>
                <ul className="mt-0.5 space-y-0.5">
                  {missingReason.map(d => (
                    <li key={d.it.id}>• <span className="font-medium">{d.it.material_name}</span> — {d.label}</li>
                  ))}
                </ul>
                <div className="mt-1 text-[10px]">The admin is alerted with the reason you give.</div>
              </div>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-3 py-2 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={saving || loading || missingReason.length > 0 || chargeBlockers.length > 0}
                  title={missingReason.length > 0 ? missingList('Reason still needed on:\n')
                       : chargeBlockers.length > 0 ? chargeBlockers.join('\n') : undefined}
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
              {/* Spelled out, same as the liquor Movement report's "Unit
                  (recipe)": every qty in this table is in the PURCHASE unit. */}
              <th className="text-left  py-1 px-2 font-medium">Unit (purchase)</th>
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
              // ONE pack resolution for the whole row — ordered, received and
              // rejected are all purchase-basis GRN/PO numbers, so they share it.
              const meta = packMetaOf(it);
              const ordHint = recipeHint(it.quantity, meta);
              const rcvHint = recQty != null ? recipeHint(Number(recQty), meta) : null;
              const rejHint = recipeHint(rejected, meta);
              return (
                <tr key={it.id} className="border-t border-[#E8D5C4]/50">
                  <td className="py-1 px-2 font-mono text-[10px] text-[#8B7355]">{it.material_sku || '·'}</td>
                  <td className="py-1 px-2">
                    {it.material_name}
                    {isReceived && rejected > 0 && (
                      <div className="text-[10px] text-red-700 mt-0.5">
                        {/* quantity_rejected is a GRN qty = PURCHASE units, and
                            it was printing raw (0.30000000000000004). */}
                        Rejected: {qfmt(rejected)} {u}
                        {(it as any).rejection_reason && <span className="capitalize"> ({String((it as any).rejection_reason).replace(/_/g, ' ')})</span>}
                        {rejHint && <span className={`${HINT_CLS} ml-1`}>{rejHint}</span>}
                      </div>
                    )}
                  </td>
                  <td className="py-1 px-2 text-[#6B5744]">{(it as any).vendor || <span className="text-[#8B7355] italic">—</span>}</td>
                  <td className="py-1 px-2 text-right font-mono">
                    {it.quantity.toLocaleString('en-IN')}
                    {ordHint && <div className={HINT_CLS}>{ordHint}</div>}
                  </td>
                  <td className="py-1 px-2 text-[#6B5744]">{u}</td>
                  <td className="py-1 px-2 text-right font-mono">{fmt(it.unit_price)}</td>
                  <td className="py-1 px-2 text-right font-mono font-semibold">{fmt(it.total_price)}</td>
                  {isReceived && <>
                    <td className={`py-1 px-2 text-right font-mono ${qtyDiff !== 0 ? (qtyDiff > 0 ? 'bg-amber-50 text-amber-900 font-semibold' : 'bg-red-50 text-red-700 font-semibold') : 'bg-emerald-50/30'}`}>
                      {recQty != null ? Number(recQty).toLocaleString('en-IN') : '—'}
                      {rcvHint && <div className={HINT_CLS}>{rcvHint}</div>}
                    </td>
                    <td className={`py-1 px-2 text-right font-mono ${priceDiff !== 0 ? (priceDiff > 0 ? 'bg-red-50 text-red-700 font-semibold' : 'bg-emerald-50 text-emerald-800 font-semibold') : 'bg-emerald-50/30'}`}>
                      {recPrice != null ? fmt(Number(recPrice)) : '—'}
                    </td>
                    <td className="py-1 px-2 text-right font-mono bg-emerald-50/30">
                      {recTotal != null ? fmt(Number(recTotal)) : '—'}
                    </td>
                    <td className={`py-1 px-2 text-right font-mono text-[10px] ${valDiff === 0 ? 'text-[#8B7355]' : valDiff > 0 ? 'text-red-700' : 'text-amber-700'}`}>
                      {/* qfmt, not the raw float: 2.4 − 2.5 prints as
                          −0.09999999999999964 straight out of the subtraction.
                          Purchase basis on both sides, so the delta is too. */}
                      {qtyDiff !== 0 && (
                        <div title={`Qty ${qtyDiff > 0 ? '+' : ''}${qfmt(qtyDiff)} ${u}`}>
                          {qtyDiff > 0 ? '+' : ''}{qfmt(qtyDiff)} {u}
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
  /* material_id → the 1-based line it already sits on. Feeds the picker so a
     material that is already on this PO can't be added twice (one material =
     one line: a duplicate double-orders and, on receive, bumps stock twice). */
  const takenIds = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((l, idx) => { if (l.material_id && !m.has(l.material_id)) m.set(l.material_id, idx + 1); });
    return m;
  }, [items]);
  const [flashLine, setFlashLine] = useState<number | null>(null);
  const [dupNote, setDupNote] = useState<string | null>(null);
  // Scoped to THIS composer's item list: a document-wide [data-po-qty=N] lookup
  // focused the inline PO editor's row when both were mounted.
  const linesRef = useRef<HTMLDivElement | null>(null);
  /* Send the user to the line that already holds the item instead of silently
     doing nothing: focus its qty box, flash the row, and say where it went. */
  const goToTakenLine = (lineNo: number) => {
    const existing = items[lineNo - 1];
    const mat = materials.find(mm => mm.id === existing?.material_id);
    setDupNote(`${mat?.name || 'That item'} is already on line ${lineNo} — add the extra quantity there.`);
    setFlashLine(lineNo);
    setTimeout(() => setFlashLine(null), 1400);
    setTimeout(() => {
      const el = (linesRef.current || document).querySelector<HTMLInputElement>(`[data-po-qty="${lineNo}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.focus(); el?.select();
    }, 0);
  };

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
            <div ref={linesRef} className="overflow-x-auto">
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
                    <tr key={it.uid} className={`border-t border-[#E8D5C4]/50 align-top block md:table-row rounded-lg border border-[#E8D5C4] p-3 mb-2 space-y-2 md:p-0 md:mb-0 md:border-0 md:space-y-0 ${
                      flashLine === i + 1 ? 'ring-2 ring-[#af4408] bg-[#FFF1E3]' : ''}`}>
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
                                              takenIds={takenIds} onPickTaken={goToTakenLine}
                                              onChange={(id, m) => {
                                                // Belt-and-braces: keyboard selection or stale state could
                                                // reach here even though the row renders as un-pickable.
                                                const taken = takenIds.get(id);
                                                if (taken && taken !== i + 1) { goToTakenLine(taken); return; }
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
                            {/* State the pack itself so the buyer knows what one
                                order unit contains — the kitchen's recipes are
                                written in the other unit. */}
                            {packNote(packMetaOfMat(mat)) && (
                              <span className="ml-1 text-[#B8A590]">· {packNote(packMetaOfMat(mat))}</span>
                            )}
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
                        <input type="number" step="any" min={0} value={it.quantity || ''} data-po-qty={i + 1}
                               onChange={e => {
                                 const v = parseFloat(e.target.value);
                                 updateLine(i, { quantity: Number.isFinite(v) ? Math.max(0, v) : 0 });
                               }}
                               className="w-full px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs" />
                        {/* Spell out the ORDER unit so qty can never be read as
                            the recipe/stock unit (g) — a PO is in kg/BTL/CASE.
                            The hint below reads the SAME typed number out in
                            recipe units; the box itself stays purchase-basis, so
                            what is posted is exactly what was typed. */}
                        {mat && <div className="text-[9px] text-[#8B7355] text-right mt-0.5">{poUnitOf(mat)}</div>}
                        {/* qty > 0 gate: the box renders blank at 0, so an
                            unconditional hint would read "= 0 g" under an empty
                            field the buyer has not filled in yet. */}
                        {mat && Number(it.quantity) > 0 && (
                          <div className={`${HINT_CLS} text-right`}>{recipeHint(Number(it.quantity), packMetaOfMat(mat))}</div>
                        )}
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
            {dupNote && (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-[#D4B896] bg-[#FFF1E3] px-3 py-2 text-[11px] text-[#6B5744]">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#af4408]" />
                <span className="flex-1">{dupNote}</span>
                <button type="button" onClick={() => setDupNote(null)} className="text-[#8B7355] hover:text-[#2D1B0E]">✕</button>
              </div>
            )}
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

/* Simple inline picker for the PO modal/edit (separate from the recipe picker so the file stays self-contained)
 *
 * ONE MATERIAL = ONE LINE. A PO carrying the same material twice double-orders,
 * and on receive it writes two purchases rows and bumps stock twice for one
 * item — which then skews that material's weighted-average cost. `takenIds`
 * maps material_id → the 1-based line it is already on; those rows stay VISIBLE
 * (hiding them reads as "we don't stock that") but cannot be picked, and
 * clicking one sends the user to the line that already has it. */
function SimpleMaterialPicker({ value, materials, onChange, takenIds, onPickTaken }: {
  value: string; materials: Material[]; onChange: (id: string, mat?: Material) => void;
  takenIds?: Map<string, number>; onPickTaken?: (lineNo: number) => void;
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
            {list.map(m => {
              const takenLine = takenIds?.get(m.id);
              return (
              <button type="button" key={m.id}
                      onClick={() => {
                        setOpen(false); setQ('');
                        if (takenLine) { onPickTaken?.(takenLine); return; }
                        onChange(m.id, m);
                      }}
                      title={takenLine ? `Already on line ${takenLine} — add the extra quantity there` : undefined}
                      className={`w-full text-left px-2 py-1 rounded text-xs flex items-center gap-2 ${
                        takenLine ? 'bg-[#FFF8F0] text-[#A08B76] cursor-default' : 'hover:bg-[#FFF1E3]'}`}>
                <span className="text-[10px] font-mono text-[#8B7355] w-16 shrink-0">{m.sku || '·'}</span>
                <span className="flex-1 truncate">{m.name}</span>
                {takenLine ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#F0E4D6] text-[#8B7355] shrink-0">
                    already on line {takenLine}
                  </span>
                ) : (<>
                  <span className="text-[10px] text-[#6B5744]">{poUnitOf(m)}</span>
                  {/* Rate carries its own basis: a bare "₹86.00" next to a list
                      of kitchen materials reads as ₹/g. poRateOf is already
                      ₹/purchase-unit — say which unit that is. */}
                  <span className="text-[10px] font-mono text-[#6B5744]">₹{poRateOf(m).toFixed(2)}/{poUnitOf(m)}</span>
                </>)}
              </button>
              );
            })}
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
  /* material_id → the 1-based line it already sits on. Feeds the picker so a
     material that is already on this PO can't be added twice (one material =
     one line: a duplicate double-orders and, on receive, bumps stock twice). */
  const takenIds = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((l, idx) => { if (l.material_id && !m.has(l.material_id)) m.set(l.material_id, idx + 1); });
    return m;
  }, [items]);
  const [flashLine, setFlashLine] = useState<number | null>(null);
  const [dupNote, setDupNote] = useState<string | null>(null);
  // Scoped to THIS composer's rows — see the matching ref in the new-PO modal.
  const linesRef = useRef<HTMLDivElement | null>(null);
  /* Send the user to the line that already holds the item instead of silently
     doing nothing: focus its qty box, flash the row, and say where it went. */
  const goToTakenLine = (lineNo: number) => {
    const existing = items[lineNo - 1];
    const mat = materials.find(mm => mm.id === existing?.material_id);
    setDupNote(`${mat?.name || 'That item'} is already on line ${lineNo} — add the extra quantity there.`);
    setFlashLine(lineNo);
    setTimeout(() => setFlashLine(null), 1400);
    setTimeout(() => {
      const el = (linesRef.current || document).querySelector<HTMLInputElement>(`[data-po-qty="${lineNo}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.focus(); el?.select();
    }, 0);
  };

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
    <div ref={linesRef} className="space-y-3">
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
          <div key={it.uid} className={`grid grid-cols-12 gap-2 text-xs items-start rounded ${
            flashLine === i + 1 ? 'ring-2 ring-[#af4408] bg-[#FFF1E3]' : ''}`}>
            <div className="col-span-4">
              {/* Locked once chosen — remove the line to order a different item. */}
              {mat ? (
                <div className="px-2 py-1 rounded border border-[#E8D5C4] bg-[#FFF8F0] text-xs text-[#2D1B0E]">
                  <span className="font-mono text-[10px] text-[#8B7355] mr-1">{mat.sku}</span>{mat.name}
                  <div className="text-[9px] text-[#8B7355]">
                    order unit {poUnitOf(mat)} · ₹{poRateOf(mat).toFixed(2)}/{poUnitOf(mat)}
                    {packNote(packMetaOfMat(mat)) && <span className="ml-1 text-[#B8A590]">· {packNote(packMetaOfMat(mat))}</span>}
                  </div>
                </div>
              ) : (
                <SimpleMaterialPicker value={it.material_id} materials={materials}
                                      takenIds={takenIds} onPickTaken={goToTakenLine}
                                      onChange={(id, m) => {
                  // Belt-and-braces — see the matching guard in the new-PO composer.
                  const taken = takenIds.get(id);
                  if (taken && taken !== i + 1) { goToTakenLine(taken); return; }
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
              <input type="number" step="any" min={0} value={it.quantity || ''} data-po-qty={i + 1}
                     onChange={e => { const v = parseFloat(e.target.value); update(i, { quantity: Number.isFinite(v) ? Math.max(0, v) : 0 }); }}
                     className="w-full px-2 py-1 border border-[#E8D5C4] rounded text-right" />
              {/* Same labels as the new-PO composer: a PO is in kg/BTL/CASE at
                  ₹/purchase-unit, and here the basis was stated only in the
                  material cell — which wraps out of line on a narrow screen
                  while this box rewrites a live PO's money. */}
              {mat && <div className="text-[9px] text-[#8B7355] text-right mt-0.5">{poUnitOf(mat)}</div>}
              {/* qty > 0 gate — see the matching note in the new-PO composer. */}
              {mat && Number(it.quantity) > 0 && (
                <div className={`${HINT_CLS} text-right`}>{recipeHint(Number(it.quantity), packMetaOfMat(mat))}</div>
              )}
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
                // directly. ONE resolution per row through the shared guard: the
                // "pack > 1 AND the units differ" test lives in packFactor() and is
                // never re-derived here, because a local copy is exactly how one
                // cell in a row ends up on the other basis.
                const meta   = packMetaOf(it);
                // Never blank — the API COALESCEs purchase_unit to the recipe unit.
                // Used for EVERY column, including pack-1 materials (pcs vs BTL):
                // labelling stock "pcs" beside a request in "BTL" is the same
                // sibling mismatch, even when the two numbers happen to be equal.
                const poUnit = String(meta.purchase_unit || '').trim() || it.material_unit;
                const pf     = packFactor(meta);
                const reqInStockUnits = (Number(it.requested_qty) || 0) * pf;
                // Recipe-basis columns → purchase basis for the lead figure.
                const stockPU = toPurchaseQty(it.current_stock, meta);
                const usePU   = (v: number) => fmtQtyNum(toPurchaseQty(v, meta));
                // % of stock — recipe ÷ recipe, so it is basis-independent and
                // must NOT be recomputed from the rounded purchase figures.
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
                      {/* Already PURCHASE units (canon) — printed, never divided. */}
                      <div className="font-semibold">{fmtQtyNum(it.requested_qty)} {poUnit}</div>
                      {/* Always state the basis: a bare "@ ₹151.50" beside the
                          recipe-unit columns reads as ₹/g. poUnit is never blank
                          — the API COALESCEs purchase_unit to the recipe unit. */}
                      <div className="text-[10px] text-[#8B7355]">@ ₹{it.requested_unit_price.toFixed(2)}/{poUnit}</div>
                      {/* Spell out the stock-unit equivalent so "10 kg" can be compared
                          with the recipe-unit figures the kitchen works in. */}
                      {pf > 1 && (
                        <div className={HINT_CLS}>= {fmtQtyNum(reqInStockUnits)} {it.material_unit}</div>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      {/* Purchase basis (owner rule): current_stock is recipe units;
                          toPurchaseQty so "2 BTL on hand" reads as 2, not 1500. */}
                      <div>{fmtQtyNum(stockPU)} {poUnit}</div>
                      {pf > 1 && <div className={HINT_CLS}>= {fmtQtyNum(it.current_stock)} {it.material_unit}</div>}
                      {reqVsStock && <div className="text-[10px] text-[#8B7355]">order is {reqVsStock} of stock</div>}
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-[#6B5744]">
                      {/* Consumption is stored in recipe units; converted so it
                          reads against the Requested and Current Stock columns
                          without the reader dividing by the pack in their head. */}
                      {usePU(it.usage_30d)} / {usePU(it.usage_60d)} / {usePU(it.usage_90d)}
                      <div className="text-[10px] text-[#8B7355]">{poUnit}{it.avg_daily_usage_30d > 0 ? ` · avg ${toPurchaseQty(it.avg_daily_usage_30d, meta).toFixed(2)}/day` : ''}</div>
                      {pf > 1 && (
                        <div className={HINT_CLS}>
                          = {fmtQtyNum(it.usage_30d)} / {fmtQtyNum(it.usage_60d)} / {fmtQtyNum(it.usage_90d)} {it.material_unit}
                        </div>
                      )}
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
