'use client';

/**
 * Party Approvals — Head Chef inbox grouped by party event.
 *
 * Each kitchen sub-department (Continental, Bakery, Indian, etc.) raises
 * its own party requisition. They all converge here, grouped by
 * (event_name + event_date). Head Chef can:
 *   - See total estimated cost per event + per dept
 *   - Approve a single req (calls /api/requisitions/[id]/chef-approve)
 *   - Approve ALL submitted reqs for one event in one click
 *   - Reject a req with a note
 *
 * Visibility: head chef / admin only (server enforces via canApproveAsChef).
 */

import { Fragment, useEffect, useState } from 'react';
import {
  PartyPopper, ChefHat, Loader2, CheckCircle2, X, AlertTriangle, RefreshCw,
  ChevronDown, ChevronRight, Pencil, Plus, Trash2, Save, ExternalLink,
} from 'lucide-react';
import { api } from '@/lib/api';
import MaterialTypeahead from '@/components/MaterialTypeahead';

import { fmtIST } from '@/lib/format-date';
const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');

/** Heuristic sanity check for a requisition line — returns a human-readable
 *  warning when the quantity smells like a UNIT mistake (the classic "12 ml of
 *  oil" when the chef meant 12 bottles). Warn-only; the approving chef decides.
 *  Uses the live qty so fixing the number clears the flag immediately. */
function plausibilityFlag(it: any, guests: number | null | undefined, effQty: number): string | null {
  if (it.is_rejected) return null;
  const qty = Number(effQty) || 0;
  if (qty <= 0) return null;
  const unit = String(it.material_unit || '').toLowerCase();
  const pack = Number(it.material_pack_size) || 1;
  const pu = String(it.material_purchase_unit || '').trim();
  const price = Number(it.average_price) || 0;
  const cost = qty * price;

  // A) Less than ONE purchase pack of a pack-based material (oil sold in 1L
  //    bottles, rice in 30kg bags): "12 ml" < 1,000 ml/BTL almost certainly
  //    means 12 BTL. pack >= 100 keeps kg/kg or pcs materials out of this rule.
  if (pack >= 100 && qty < pack) {
    return `Only ${qty.toLocaleString('en-IN')} ${unit} — less than one ${pu || 'pack'} (${pack.toLocaleString('en-IN')} ${unit}). Did the chef mean ${qty.toLocaleString('en-IN')} ${pu || 'packs'}?`;
  }
  // B) Absurdly small for the crowd AND nearly free: under 0.5 g/ml per guest
  //    with line cost < ₹50. The cost floor keeps genuinely tiny-but-expensive
  //    items (saffron) from being flagged.
  if (guests && guests > 0 && (unit === 'g' || unit === 'ml') && qty / guests < 0.5 && cost < 50) {
    return `${qty.toLocaleString('en-IN')} ${unit} ≈ ${(qty / guests).toFixed(2)} ${unit}/guest for ${guests} guests (≈${fmt(cost)}) — check the unit.`;
  }
  return null;
}

interface PartyReq {
  id: string;
  req_number: string;
  event_name: string;
  event_date: string;
  customer?: string;
  guest_count?: number;
  department_name: string;
  department_code?: string;
  status: string;
  item_count: number;
  estimated_value: number;
  drafted_by: string;
  created_at: string;
}

interface EventGroup {
  event_key: string;
  event_name: string;
  event_date: string;
  customer?: string;
  guest_count?: number;
  reqs: PartyReq[];
  total_cost: number;
  /** Awaiting Head Chef approval (status='submitted'). */
  submitted_count: number;
  /** Chef-approved, still awaiting Mgmt approval (status='chef_approved'). */
  pending_mgmt_count: number;
  /** Fully approved by both gates (status >= mgmt_approved). */
  approved_count: number;
}

export default function PartyApprovalsPage() {
  const [reqs, setReqs] = useState<PartyReq[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Req being edited inline (chef can tweak qtys before approving)
  const [editingReqId, setEditingReqId] = useState<string | null>(null);
  // Per-requisition inline expand: shows items table beneath the row.
  // Detail is fetched lazily on first expand and cached in `reqDetails`.
  const [expandedReqs, setExpandedReqs] = useState<Set<string>>(new Set());
  const [reqDetails, setReqDetails] = useState<Record<string, any>>({});
  const [reqLoading, setReqLoading] = useState<Set<string>>(new Set());
  // Audit drawer
  const [auditFor, setAuditFor] = useState<{ reqId: string; reqNum: string } | null>(null);
  // Track which item is currently being edited (for visual focus)
  const [savingItemId, setSavingItemId] = useState<string | null>(null);
  // Local per-line pending qty drafts. Keeps the input controlled so cost
  // recomputes immediately when the chef clicks the up/down spin buttons or
  // types — instead of staying stale until onBlur fires. Committed to the
  // server (and cleared from this map) on blur via updateItem().
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({});
  // Current user + Mgmt-gate setting — together drive whether the "Mgmt Approve"
  // button appears on chef-approved rows. Two conditions must hold:
  //   1. The viewer is an admin (today's Mgmt role)
  //   2. require_mgmt_approval is ON (admin can flip on Settings → Integrations)
  // When the setting is OFF, chef approval is the final gate; no Mgmt action
  // needed — the requisition is already in the store inbox.
  const [me, setMe] = useState<{ role?: string; email?: string } | null>(null);
  const [requireMgmt, setRequireMgmt] = useState(false);
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null)).catch(() => {});
    fetch('/api/admin/party-rules').then(r => r.json()).then(d => setRequireMgmt(d?.require_mgmt_approval === true)).catch(() => {});
  }, []);
  const canMgmtApprove = me?.role === 'admin' && requireMgmt;

  // PUT a single item change (qty / reject / note). Updates local detail in
  // place so the UI reflects the change instantly. Server logs the audit event.
  const updateItem = async (reqId: string, itemId: string, patch: { chef_approved_qty?: number | null; is_rejected?: boolean; chef_note?: string }) => {
    setSavingItemId(itemId);
    try {
      const r = await api(`/api/requisitions/${reqId}/items/${itemId}`, { method: 'PUT', body: patch });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      if (j.item) {
        // Merge updated fields into the cached detail
        setReqDetails(prev => {
          const det = prev[reqId];
          if (!det) return prev;
          return {
            ...prev,
            [reqId]: {
              ...det,
              items: det.items.map((x: any) => x.id === itemId ? { ...x, ...j.item } : x),
            },
          };
        });
      }
    } finally { setSavingItemId(null); }
  };

  const toggleReqExpand = async (reqId: string) => {
    setExpandedReqs(prev => {
      const n = new Set(prev);
      if (n.has(reqId)) n.delete(reqId); else n.add(reqId);
      return n;
    });
    // Lazy-fetch detail on first expand
    if (!reqDetails[reqId]) {
      setReqLoading(p => new Set(p).add(reqId));
      try {
        const r = await fetch(`/api/requisitions?id=${reqId}`).then(r => r.json());
        if (r.requisition) setReqDetails(p => ({ ...p, [reqId]: r.requisition }));
      } finally {
        setReqLoading(p => { const n = new Set(p); n.delete(reqId); return n; });
      }
    }
  };

  // Invalidate cached detail after any action (approve/reject/edit)
  // so next expand re-fetches fresh items/status.
  const invalidateReqDetail = (reqId: string) =>
    setReqDetails(p => { const n = { ...p }; delete n[reqId]; return n; });

  const load = async () => {
    setLoading(true); setError(null);
    try {
      // Pull all party requisitions; we filter client-side so the user can
      // toggle pending/all without re-fetching.
      const r = await fetch('/api/requisitions?purpose=party');
      const j = await r.json();
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setReqs(j.requisitions || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // Group by event_name + event_date
  const groups: EventGroup[] = (() => {
    const map = new Map<string, EventGroup>();
    for (const r of reqs) {
      // "Pending" means waiting on a human approval action on this page:
      //   - submitted    → always pending Chef
      //   - chef_approved → pending Mgmt, but only when the Mgmt gate is ON.
      //                     When the gate is OFF, chef_approved means done-from-here.
      if (filter === 'pending') {
        if (r.status === 'submitted') {
          // always pending chef
        } else if (r.status === 'chef_approved' && requireMgmt) {
          // pending mgmt only when the gate is on
        } else {
          continue;
        }
      }
      const key = `${r.event_name}|${r.event_date}`;
      if (!map.has(key)) {
        map.set(key, {
          event_key: key,
          event_name: r.event_name,
          event_date: r.event_date,
          customer: r.customer,
          guest_count: r.guest_count,
          reqs: [],
          total_cost: 0,
          submitted_count: 0,
          pending_mgmt_count: 0,
          approved_count: 0,
        });
      }
      const g = map.get(key)!;
      g.reqs.push(r);
      g.total_cost += r.estimated_value || 0;
      if (r.status === 'submitted')     g.submitted_count += 1;
      // chef_approved counts as "pending mgmt" only when the gate is ON.
      // When OFF, those reqs are already in the store inbox → count as approved.
      if (r.status === 'chef_approved') {
        if (requireMgmt) g.pending_mgmt_count += 1;
        else             g.approved_count    += 1;
      }
      // "approved" in the per-event header only counts requisitions that have
      // fully cleared BOTH approval gates (Chef + Mgmt). Chef-only approvals
      // are still in-flight (waiting for Mgmt) and shouldn't bump the count —
      // that was making the "approved" stat lie.
      if (r.status === 'mgmt_approved' || r.status === 'store_processed' || r.status === 'fulfilled') g.approved_count += 1;
    }
    return Array.from(map.values()).sort((a, b) => a.event_date.localeCompare(b.event_date));
  })();

  const toggleExpand = (key: string) => {
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  };

  const approve = async (reqId: string) => {
    // Pre-flight: if we already have the expanded detail cached, check whether
    // every line was rejected. If so, the chef almost certainly wants to reject
    // the whole requisition with a reason — route them straight to reject().
    // (The server enforces the same rule with a 400; this is the friendly UX.)
    const cached = reqDetails[reqId];
    if (cached?.items?.length) {
      const liveItems = cached.items.filter((it: any) => !it.is_rejected);
      if (liveItems.length === 0) {
        const proceed = window.confirm(
          'You\'ve rejected every line on this requisition. ' +
          'Approving would forward an empty requisition to the store, which isn\'t useful.\n\n' +
          'Click OK to Reject the whole requisition (you\'ll be asked for a reason). ' +
          'Click Cancel to go back and un-reject at least one line.'
        );
        if (proceed) return reject(reqId);   // reuse the reject() helper below
        return;                              // bail without calling chef-approve
      }
    }
    setBusy(p => new Set(p).add(reqId));
    try {
      const r = await api(`/api/requisitions/${reqId}/chef-approve`, { method: 'POST', body: {} });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        // Server returns { all_rejected: true } when every line was rejected
        // (and the client cache was stale). Route to reject() in that case.
        if (j.all_rejected) {
          const proceed = window.confirm(
            (j.error || '') + '\n\nClick OK to reject the whole requisition with a reason.'
          );
          if (proceed) return reject(reqId);
          return;
        }
        setError(j.error || `Failed to approve req: HTTP ${r.status}`);
        return;
      }
      invalidateReqDetail(reqId);
      await load();
    } finally {
      setBusy(p => { const n = new Set(p); n.delete(reqId); return n; });
    }
  };
  /** 2nd-stage Mgmt approval — moves a chef-approved req to mgmt_approved so
   *  the Store team can issue it. Admin-only today. */
  const mgmtApprove = async (reqId: string) => {
    const note = window.prompt('Mgmt approval note (optional — sent with audit log):') ?? '';
    setBusy(p => new Set(p).add(reqId));
    try {
      const r = await api(`/api/requisitions/${reqId}/mgmt-approve`, { method: 'POST', body: { note } });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `Failed Mgmt approval: HTTP ${r.status}`);
        return;
      }
      invalidateReqDetail(reqId);
      await load();
    } finally {
      setBusy(p => { const n = new Set(p); n.delete(reqId); return n; });
    }
  };

  const reject = async (reqId: string) => {
    // Server requires a non-empty `reason` (it explicitly 400s otherwise).
    // Loop until the chef enters one or cancels — saves a round-trip and
    // avoids the "reason required" error after they typed something but
    // it landed on the wrong key.
    let reason = '';
    while (!reason.trim()) {
      const entered = window.prompt('Reason for rejection (sent to dept) — required:');
      if (entered === null) return;                  // chef hit Cancel
      reason = entered.trim();
      if (!reason) window.alert('Please enter a reason — required for rejection.');
    }
    setBusy(p => new Set(p).add(reqId));
    try {
      // Field name MUST be `reason` — server reads body.reason. Previously
      // we sent `note` which the server ignored and 400'd back as
      // "reason required" even after the chef typed one.
      const r = await api(`/api/requisitions/${reqId}/chef-reject`, { method: 'POST', body: { reason } });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `Failed to reject: HTTP ${r.status}`);
        return;
      }
      invalidateReqDetail(reqId);
      await load();
    } finally {
      setBusy(p => { const n = new Set(p); n.delete(reqId); return n; });
    }
  };

  const approveAllForEvent = async (g: EventGroup) => {
    const submittedReqs = g.reqs.filter(r => r.status === 'submitted');
    if (submittedReqs.length === 0) return;
    if (!window.confirm(`Approve all ${submittedReqs.length} pending requisition(s) for ${g.event_name}?`)) return;
    let approved = 0, skipped = 0;
    for (const r of submittedReqs) {
      // Skip all-rejected reqs silently in bulk mode — they need a manual
      // Reject (with a reason). Surface a count at the end so the chef
      // knows to deal with them individually.
      const cached = reqDetails[r.id];
      if (cached?.items?.length) {
        const liveItems = cached.items.filter((it: any) => !it.is_rejected);
        if (liveItems.length === 0) { skipped += 1; continue; }
      }
      const res = await api(`/api/requisitions/${r.id}/chef-approve`, { method: 'POST', body: {} });
      if (res.ok) {
        approved += 1;
        invalidateReqDetail(r.id);
      } else {
        const j = await res.json().catch(() => ({}));
        if (j.all_rejected) skipped += 1;
        else { setError(j.error || `Req ${r.req_number}: HTTP ${res.status}`); break; }
      }
    }
    await load();
    if (skipped > 0) {
      setError(`Approved ${approved} of ${submittedReqs.length}. Skipped ${skipped} that had every line rejected — reject those individually with a reason.`);
    }
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <ChefHat className="text-[#af4408]" size={24} />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Party Approvals</h1>
          <p className="text-xs text-[#8B7355]">
            All dept requisitions for each upcoming party, in one place. Approve individually or per-event.
          </p>
        </div>
        <select value={filter} onChange={e => setFilter(e.target.value as any)}
                className="text-xs px-2 py-1 border border-[#D4B896] rounded bg-white">
          <option value="pending">Pending only</option>
          <option value="all">All statuses</option>
        </select>
        <button onClick={load} className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-[#af4408] hover:bg-[#FFF1E3] rounded">
          <RefreshCw size={11} /> Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs flex items-center justify-between">
          <span><AlertTriangle size={12} className="inline mr-1" />{error}</span>
          <button onClick={() => setError(null)} className="text-red-700"><X size={12} /></button>
        </div>
      )}

      {loading ? (
        <div className="p-10 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14}/>Loading…</div>
      ) : groups.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-10 text-center text-sm text-[#8B7355]">
          {filter === 'pending' ? 'No pending party requisitions. 🎉' : 'No party requisitions yet.'}
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(g => {
            const isOpen = expanded.has(g.event_key);
            // "All approved" only when there's nothing pending at either gate
            // AND at least one req has cleared both. Previously this fired as
            // soon as chef approved, before mgmt acted — misleading.
            const allApproved = g.submitted_count === 0 && g.pending_mgmt_count === 0 && g.approved_count > 0;
            return (
              <div key={g.event_key} className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
                <div className="px-4 py-3 bg-[#FFF1E3] flex items-center gap-3 flex-wrap cursor-pointer hover:bg-[#FFE8D0]"
                     onClick={() => toggleExpand(g.event_key)}>
                  <button className="text-[#6B5744]">
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <PartyPopper size={16} className="text-[#af4408]" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-[#2D1B0E]">
                      {g.event_name}
                      <span className="text-[#8B7355] text-xs font-normal ml-2">{g.event_date}</span>
                      {g.guest_count != null && <span className="text-[#8B7355] text-xs font-normal ml-2">· {g.guest_count} pax</span>}
                    </div>
                    {g.customer && <div className="text-[10px] text-[#8B7355]">{g.customer}</div>}
                  </div>
                  <div className="text-xs text-[#6B5744]">
                    {g.reqs.length} req{g.reqs.length === 1 ? '' : 's'}
                    {g.submitted_count > 0 && (
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800"
                            title="Awaiting HOD approval">{g.submitted_count} with HOD</span>
                    )}
                    {g.pending_mgmt_count > 0 && (
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800"
                            title="HOD-approved — waiting for Management approval">{g.pending_mgmt_count} with mgmt</span>
                    )}
                    {g.approved_count > 0 && (
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-blue-100 text-blue-800"
                            title="Mgmt-approved — with store / partially issued / fulfilled">{g.approved_count} approved</span>
                    )}
                    {allApproved && <span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">✓ all cleared</span>}
                  </div>
                  <div className="text-sm font-mono font-semibold text-[#2D1B0E]">{fmt(g.total_cost)}</div>
                  {g.submitted_count > 0 && (
                    <button onClick={(e) => { e.stopPropagation(); approveAllForEvent(g); }}
                            className="inline-flex items-center gap-1 text-xs px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded">
                      <CheckCircle2 size={12} /> Approve all
                    </button>
                  )}
                </div>

                {isOpen && (
                  <table className="w-full text-xs">
                    <thead className="bg-white border-b border-[#E8D5C4] text-[#6B5744]">
                      <tr>
                        <th className="text-left  py-2 px-3 font-medium">Req #</th>
                        <th className="text-left  py-2 px-3 font-medium">Department</th>
                        <th className="text-left  py-2 px-3 font-medium">Drafted by</th>
                        <th className="text-right py-2 px-3 font-medium">Items</th>
                        <th className="text-right py-2 px-3 font-medium">Est. cost</th>
                        <th className="text-left  py-2 px-3 font-medium">Status</th>
                        <th className="text-right py-2 px-3 font-medium">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.reqs.map(r => {
                        const isBusy = busy.has(r.id);
                        const isExpanded = expandedReqs.has(r.id);
                        const detailLoading = reqLoading.has(r.id);
                        const detail = reqDetails[r.id];
                        // When the dropdown is expanded and the chef has rejected
                        // every line, disable the Chef Approve button on this row
                        // — they should use Reject instead. We can only check this
                        // when the detail is already cached; otherwise the server
                        // 400 guard kicks in.
                        const allLinesRejected = !!(detail?.items?.length
                          && detail.items.every((it: any) => it.is_rejected));
                        return (
                          <Fragment key={r.id}>
                          <tr className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                            <td className="py-1.5 px-3 font-mono text-[#af4408]">
                              <button onClick={() => toggleReqExpand(r.id)}
                                      className="inline-flex items-center gap-1 hover:underline"
                                      title="Click to view items inline">
                                {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                {r.req_number}
                              </button>
                              <a href={`/requisitions?id=${r.id}`} target="_blank" rel="noopener noreferrer"
                                 className="ml-1 text-[#8B7355] hover:text-[#af4408]"
                                 title="Open the full requisition page in a new tab">
                                <ExternalLink size={10} className="inline" />
                              </a>
                            </td>
                            <td className="py-1.5 px-3 text-[#2D1B0E]">
                              {r.department_code && <span className="text-[10px] font-mono text-[#8B7355] mr-1">[{r.department_code}]</span>}
                              {r.department_name}
                            </td>
                            <td className="py-1.5 px-3 text-[10px] text-[#8B7355]">{r.drafted_by}</td>
                            <td className="py-1.5 px-3 text-right font-mono">{r.item_count}</td>
                            <td className="py-1.5 px-3 text-right font-mono font-semibold">{fmt(r.estimated_value || 0)}</td>
                            <td className="py-1.5 px-3">
                              {/* Status badge — colour AND label are explicit about
                                  which gate the req is at so admins don't mistake a
                                  chef-only-approved req for fully-approved. */}
                              {(() => {
                                // chef_approved label depends on the global Mgmt-gate setting:
                                //   require_mgmt=ON  → "With Mgmt" (indigo, pending 2nd gate)
                                //   require_mgmt=OFF → "With Store" (blue, direct to issue desk)
                                const chefApprovedLabel = requireMgmt
                                  ? { label: 'With Mgmt',  cls: 'bg-indigo-100 text-indigo-800',
                                      tip: 'HOD has approved — waiting for Management approval' }
                                  : { label: 'With Store', cls: 'bg-blue-100 text-blue-800',
                                      tip: 'HOD has approved — sent directly to Store (Mgmt gate is OFF)' };
                                const labelMap: Record<string, { label: string; cls: string; tip?: string }> = {
                                  submitted:       { label: 'With HOD',         cls: 'bg-amber-100 text-amber-800',
                                                     tip: 'Awaiting HOD approval' },
                                  chef_approved:   chefApprovedLabel,
                                  mgmt_approved:   { label: 'With Store',       cls: 'bg-blue-100 text-blue-800',
                                                     tip: 'Mgmt-approved — waiting for Store to issue' },
                                  chef_rejected:   { label: 'Rejected by HOD', cls: 'bg-red-100 text-red-700' },
                                  store_processed: { label: 'Issued (partial)', cls: 'bg-purple-100 text-purple-700' },
                                  fulfilled:       { label: 'Fulfilled',        cls: 'bg-emerald-200 text-emerald-900' },
                                  cancelled:       { label: 'Cancelled',        cls: 'bg-gray-200 text-gray-700' },
                                  draft:           { label: 'Draft',            cls: 'bg-gray-100 text-gray-700' },
                                };
                                const m = labelMap[r.status] || { label: r.status.replace(/_/g, ' '), cls: 'bg-gray-100 text-gray-700' };
                                return (
                                  <span title={m.tip} className={`text-[10px] px-1.5 py-0.5 rounded ${m.cls}`}>
                                    {m.label}
                                  </span>
                                );
                              })()}
                            </td>
                            <td className="py-1.5 px-3 text-right">
                              {r.status === 'submitted' ? (
                                // Per-item edits + line-level rejects are now
                                // available in the expanded dropdown ("view items"),
                                // so the bulky row-level Edit modal button is
                                // redundant. Keep the Approve / Reject row actions.
                                <div className="inline-flex gap-1">
                                  <button onClick={() => approve(r.id)} disabled={isBusy || allLinesRejected}
                                          className="text-emerald-700 hover:bg-emerald-100 px-2 py-0.5 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                                          title={allLinesRejected
                                            ? 'Every line is rejected — use Reject (with a reason) to send the whole requisition back.'
                                            : 'Approve as HOD (1st gate). Use "view items" on the row to edit qty / reject lines first.'}>
                                    {isBusy ? <Loader2 size={11} className="animate-spin" /> : '✓ HOD Approve'}
                                  </button>
                                  <button onClick={() => reject(r.id)} disabled={isBusy}
                                          className="text-red-700 hover:bg-red-100 px-2 py-0.5 rounded">
                                    ✗ Reject
                                  </button>
                                </div>
                              ) : r.status === 'chef_approved' && canMgmtApprove ? (
                                // 2nd gate — Mgmt approval. Visible only to admins
                                // (the Mgmt role today). After this, the req lands
                                // in the Store team's queue.
                                <div className="inline-flex gap-1">
                                  <button onClick={() => mgmtApprove(r.id)} disabled={isBusy}
                                          className="text-indigo-700 hover:bg-indigo-100 px-2 py-0.5 rounded inline-flex items-center gap-1"
                                          title="Approve as Management (2nd gate) — forwards to Store">
                                    {isBusy ? <Loader2 size={11} className="animate-spin" /> : '✓ Mgmt Approve'}
                                  </button>
                                  <button onClick={() => toggleReqExpand(r.id)}
                                          className="text-[10px] text-[#af4408] hover:underline">
                                    {isExpanded ? 'hide items' : 'view items'}
                                  </button>
                                </div>
                              ) : (
                                <button onClick={() => toggleReqExpand(r.id)}
                                        className="text-[10px] text-[#af4408] hover:underline">
                                  {isExpanded ? 'hide items' : 'view items'}
                                </button>
                              )}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-[#FFF8F0] border-t border-[#E8D5C4]/30">
                              <td colSpan={7} className="py-2 px-6">
                                {detailLoading || !detail ? (
                                  <div className="text-[11px] text-[#8B7355]"><Loader2 size={11} className="inline animate-spin mr-1" />Loading items…</div>
                                ) : detail.items?.length === 0 ? (
                                  <div className="text-[11px] text-[#8B7355] italic">No items on this requisition.</div>
                                ) : (
                                  <div>
                                    <div className="text-[10px] uppercase tracking-wide text-[#8B7355] mb-1.5 flex items-center gap-2">
                                      <span>Items — {detail.items.length} line{detail.items.length === 1 ? '' : 's'} · drafted {fmtIST(detail.created_at)}</span>
                                      <button onClick={() => setAuditFor({ reqId: r.id, reqNum: r.req_number })}
                                              className="ml-auto text-[10px] text-[#af4408] hover:underline">
                                        📜 audit history
                                      </button>
                                    </div>
                                    {/* Edit / reject is allowed when the req is still submitted (chef approval phase). */}
                                    {(() => {
                                      const editable = r.status === 'submitted';
                                      const guests = detail.guest_count ?? r.guest_count ?? null;
                                      // Count implausible lines against the SAVED qtys (drafts are per-row below).
                                      const flaggedCount = detail.items.filter((x: any) => {
                                        const q = x.chef_approved_qty != null ? Number(x.chef_approved_qty) : Number(x.quantity_requested);
                                        return !!plausibilityFlag(x, guests, q || 0);
                                      }).length;
                                      return (
                                    <>
                                    {flaggedCount > 0 && (
                                      <div className="mb-1.5 px-2 py-1 rounded bg-amber-100 border border-amber-300 text-amber-900 text-[11px]">
                                        ⚠ {flaggedCount} line{flaggedCount === 1 ? ' looks' : 's look'} implausible (likely a unit mistake — e.g. ml instead of bottles). Hover the ⚠ on each line, and fix the qty before approving.
                                      </div>
                                    )}
                                    <table className="w-full text-[11px]">
                                      <thead className="text-[#6B5744]">
                                        <tr>
                                          <th className="text-left  py-0.5 font-medium">SKU</th>
                                          <th className="text-left  py-0.5 font-medium">Material</th>
                                          <th className="text-right py-0.5 font-medium">Qty req'd</th>
                                          <th className="text-right py-0.5 font-medium">Qty approved</th>
                                          <th className="text-left  py-0.5 font-medium pl-3">Chef note</th>
                                          <th className="text-right py-0.5 font-medium">₹/unit</th>
                                          <th className="text-right py-0.5 font-medium">Line cost</th>
                                          {editable && <th className="text-center py-0.5 font-medium">Reject</th>}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {detail.items.map((it: any) => {
                                          const price = it.average_price || 0;
                                          // Effective qty: chef's approved value if set, else what was requested
                                          const reqQty = Number(it.quantity_requested) || 0;
                                          const serverQty = it.chef_approved_qty != null ? Number(it.chef_approved_qty) : reqQty;
                                          // Live qty for display + cost: prefer the local draft (chef is
                                          // currently editing this line — spin buttons / typing both update it),
                                          // otherwise fall back to what's on the server. lineCost is computed
                                          // from this so the cost column tracks the input value in real time.
                                          const draftRaw = qtyDraft[it.id];
                                          const liveQty = draftRaw != null && draftRaw !== ''
                                            ? (Number(draftRaw) || 0)
                                            : serverQty;
                                          const effQty = liveQty;
                                          const rejected = !!it.is_rejected;
                                          const lineCost = rejected ? 0 : effQty * price;
                                          const isSaving = savingItemId === it.id;
                                          // Plausibility check against the LIVE qty — editing the
                                          // number to a sane value clears the flag immediately.
                                          const flag = plausibilityFlag(it, guests, effQty);
                                          const rowCls = `border-t border-[#E8D5C4]/40 ${rejected ? 'opacity-50 line-through' : flag ? 'bg-amber-50' : ''}`;
                                          return (
                                            <tr key={it.id} className={rowCls}>
                                              <td className="py-0.5 font-mono text-[10px] text-[#8B7355]">{it.material_sku || '—'}</td>
                                              <td className="py-0.5 text-[#2D1B0E]">
                                                {it.material_name}
                                                {rejected && <span className="ml-1 text-[9px] px-1 rounded bg-red-100 text-red-700 no-underline inline-block">rejected</span>}
                                                {flag && (
                                                  <span title={flag}
                                                        className="ml-1 text-[9px] px-1 rounded bg-amber-200 text-amber-900 inline-block cursor-help align-middle">
                                                    ⚠ check unit
                                                  </span>
                                                )}
                                              </td>
                                              <td className="py-0.5 text-right font-mono text-[#8B7355]">
                                                {reqQty} <span className="text-[9px]">{it.material_unit || ''}</span>
                                              </td>
                                              <td className="py-0.5 text-right">
                                                {editable && !rejected ? (
                                                  <input type="number" step="any" min={0}
                                                         // CONTROLLED input — value tracks the draft map.
                                                         // Up/down spin buttons fire onChange too, so cost
                                                         // updates immediately instead of waiting for blur.
                                                         value={draftRaw != null ? draftRaw : String(serverQty)}
                                                         disabled={isSaving}
                                                         onChange={e => setQtyDraft(prev => ({ ...prev, [it.id]: e.target.value }))}
                                                         onBlur={e => {
                                                           const v = e.target.value === '' ? null : Number(e.target.value);
                                                           // Clear the draft regardless — server detail re-fetch
                                                           // will reflect the canonical value.
                                                           setQtyDraft(prev => { const n = { ...prev }; delete n[it.id]; return n; });
                                                           if (v !== serverQty) updateItem(r.id, it.id, { chef_approved_qty: v });
                                                         }}
                                                         onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                                                         className={`w-20 px-1 py-0.5 border rounded text-right text-[11px] font-mono ${effQty !== reqQty ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4] bg-white'}`}
                                                         title={effQty !== reqQty ? `Chef adjusted from ${reqQty} → ${effQty}` : 'Click / spin / type to edit; tab/enter/blur to save'} />
                                                ) : (
                                                  <span className={`font-mono ${effQty !== reqQty ? 'text-amber-700 font-semibold' : 'text-[#2D1B0E]'}`}>
                                                    {effQty} <span className="text-[9px] text-[#8B7355]">{it.material_unit || ''}</span>
                                                  </span>
                                                )}
                                              </td>
                                              <td className="py-0.5 text-[10px] pl-3">
                                                {editable ? (
                                                  <input defaultValue={it.chef_note || ''}
                                                         disabled={isSaving}
                                                         placeholder="Optional reason…"
                                                         onBlur={e => {
                                                           const v = e.target.value;
                                                           if (v !== (it.chef_note || '')) updateItem(r.id, it.id, { chef_note: v });
                                                         }}
                                                         className="w-full px-1 py-0.5 border border-[#E8D5C4] rounded text-[11px] bg-white" />
                                                ) : (
                                                  <span className="text-[#6B5744] italic">{it.chef_note || it.notes || ''}</span>
                                                )}
                                              </td>
                                              <td className="py-0.5 text-right font-mono text-[#6B5744]">{fmt(price)}</td>
                                              <td className="py-0.5 text-right font-mono font-medium">{rejected ? '—' : fmt(lineCost)}</td>
                                              {editable && (
                                                <td className="py-0.5 text-center">
                                                  <input type="checkbox" checked={rejected} disabled={isSaving}
                                                         onChange={e => updateItem(r.id, it.id, { is_rejected: e.target.checked })}
                                                         title={rejected ? 'Un-reject this item' : 'Reject this item (store will not issue)'} />
                                                </td>
                                              )}
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                      <tfoot>
                                        <tr className="border-t border-[#E8D5C4]">
                                          <td colSpan={editable ? 6 : 5} className="py-1 text-right font-medium text-[#6B5744]">Approved total</td>
                                          <td className="py-1 text-right font-mono font-semibold">
                                            {fmt(detail.items.reduce((s: number, it: any) => {
                                              if (it.is_rejected) return s;
                                              const q = it.chef_approved_qty != null ? Number(it.chef_approved_qty) : Number(it.quantity_requested);
                                              return s + (q || 0) * (it.average_price || 0);
                                            }, 0))}
                                          </td>
                                          {editable && <td></td>}
                                        </tr>
                                      </tfoot>
                                    </table>
                                    </>
                                      );
                                    })()}
                                    {detail.notes && (
                                      <div className="text-[10px] text-[#6B5744] mt-1.5 italic">Notes: {detail.notes}</div>
                                    )}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}

      {auditFor && (
        <AuditTimelineDrawer
          reqId={auditFor.reqId}
          reqNum={auditFor.reqNum}
          onClose={() => setAuditFor(null)}
        />
      )}
      {editingReqId && (
        <ChefEditModal
          reqId={editingReqId}
          onClose={() => setEditingReqId(null)}
          onSaved={(approved) => {
            invalidateReqDetail(editingReqId);
            setEditingReqId(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/* ──────────────── Chef Edit Modal ──────────────── */

function ChefEditModal({ reqId, onClose, onSaved }: {
  reqId: string;
  onClose: () => void;
  onSaved: (approved: boolean) => void;
}) {
  const [req, setReq] = useState<any>(null);
  const [items, setItems] = useState<{ id?: string; material_id: string; qty: string; notes: string }[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/requisitions?id=${reqId}`).then(r => r.json()).then(d => {
      const r = d.requisition;
      setReq(r);
      setItems((r.items || []).map((it: any) => ({
        id: it.id,
        material_id: it.material_id,
        qty: String(it.quantity_requested),
        notes: it.notes || '',
      })));
    });
    fetch('/api/inventory').then(r => r.json()).then(d => setMaterials(d.materials || d || []));
  }, [reqId]);

  const addLine = () => setItems(p => [...p, { material_id: '', qty: '', notes: '' }]);
  const removeLine = (i: number) => setItems(p => p.filter((_, idx) => idx !== i));
  const update = (i: number, patch: any) => setItems(p => p.map((it, idx) => idx === i ? { ...it, ...patch } : it));

  const totalCost = items.reduce((acc, it) => {
    const m = materials.find(x => x.id === it.material_id);
    const q = Number(it.qty) || 0;
    return acc + q * (m?.average_price || 0);
  }, 0);

  const persist = async (alsoApprove: boolean) => {
    setSaving(true); setError(null);
    try {
      const cleaned = items
        .filter(it => it.material_id && Number(it.qty) > 0)
        .map(it => ({ material_id: it.material_id, quantity_requested: Number(it.qty), notes: it.notes }));
      if (cleaned.length === 0) { setError('At least one item with qty > 0 required'); return; }

      const putRes = await api('/api/requisitions', { method: 'PUT', body: { id: reqId, items: cleaned } });
      if (!putRes.ok) {
        const j = await putRes.json().catch(() => ({}));
        setError(j.error || `Save failed: HTTP ${putRes.status}`); return;
      }
      if (alsoApprove) {
        const ar = await api(`/api/requisitions/${reqId}/chef-approve`, { method: 'POST', body: {} });
        if (!ar.ok) {
          const j = await ar.json().catch(() => ({}));
          setError(`Saved but approve failed: ${j.error || `HTTP ${ar.status}`}`); return;
        }
      }
      onSaved(alsoApprove);
    } finally { setSaving(false); }
  };

  if (!req) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="bg-white rounded-xl p-6"><Loader2 className="animate-spin inline mr-2" />Loading…</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-4xl my-4 flex flex-col max-h-[calc(100vh-2rem)]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
              <Pencil size={18} className="text-[#af4408]" /> Edit Requisition <span className="font-mono text-[#af4408] text-sm">{req.req_number}</span>
            </h2>
            <div className="text-xs text-[#8B7355] mt-0.5">
              {req.event_name} · {req.event_date} · {req.department_name}
              <span className="ml-2 text-[10px] italic">Adjust quantities, add or remove items before approving.</span>
            </div>
          </div>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={20} /></button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1 space-y-3">
          <div className="grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wide text-[#8B7355] px-1">
            <div className="col-span-5">Material</div>
            <div className="col-span-2 text-right">Qty</div>
            <div className="col-span-1">Unit</div>
            <div className="col-span-2">Notes</div>
            <div className="col-span-2 text-right">Line cost</div>
          </div>
          {items.map((it, i) => {
            const m = materials.find(x => x.id === it.material_id);
            const lineCost = m && Number(it.qty) > 0 ? Number(it.qty) * (m.average_price || 0) : 0;
            return (
              <div key={i} className="grid grid-cols-12 gap-2 items-start">
                <div className="col-span-5">
                  <MaterialTypeahead
                    materials={materials as any}
                    value={it.material_id}
                    onPick={(id: string) => update(i, { material_id: id })}
                    excludeIds={items.map(x => x.material_id).filter((id, idx) => id && idx !== i) as string[]}
                  />
                </div>
                <input type="number" step="any" value={it.qty}
                       onChange={e => update(i, { qty: e.target.value })}
                       className="col-span-2 px-2 py-1.5 border border-[#D4B896] rounded text-xs text-right font-mono" />
                <span className="col-span-1 text-xs text-[#8B7355] py-2">{m?.unit || ''}</span>
                <input value={it.notes} onChange={e => update(i, { notes: e.target.value })}
                       placeholder="Notes"
                       className="col-span-2 px-2 py-1.5 border border-[#D4B896] rounded text-xs" />
                <div className="col-span-2 flex items-center justify-end gap-1">
                  <span className="text-xs font-mono text-[#6B5744]">{fmt(lineCost)}</span>
                  <button onClick={() => removeLine(i)} className="text-red-600 hover:text-red-700"><Trash2 size={12} /></button>
                </div>
              </div>
            );
          })}
          <button onClick={addLine} className="text-xs text-[#af4408] hover:underline inline-flex items-center gap-1">
            <Plus size={12} /> Add line
          </button>

          <div className="bg-[#FFF1E3] border border-[#D4B896] rounded-lg p-3 flex items-center justify-between">
            <div className="text-xs text-[#8B7355]">Estimated total</div>
            <div className="text-lg font-bold text-[#2D1B0E]">{fmt(totalCost)}</div>
          </div>

          {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs">{error}</div>}
        </div>

        <div className="flex justify-end gap-2 px-6 py-3 border-t border-[#E8D5C4] shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B5744] hover:bg-[#FFF1E3] rounded">Cancel</button>
          <button onClick={() => persist(false)} disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 border border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3] rounded text-sm disabled:opacity-50">
            {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
            Save Changes
          </button>
          <button onClick={() => persist(true)} disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-sm disabled:opacity-50">
            {saving ? <Loader2 className="animate-spin" size={14} /> : <CheckCircle2 size={14} />}
            Save & Approve
          </button>
        </div>
      </div>
    </div>
  );
}

/* ──────────────── Audit Timeline Drawer ──────────────── */

function AuditTimelineDrawer({ reqId, reqNum, onClose }: { reqId: string; reqNum: string; onClose: () => void }) {
  const [events, setEvents] = useState<any[] | null>(null);
  useEffect(() => {
    fetch(`/api/requisitions/${reqId}/audit`).then(r => r.json()).then(d => setEvents(d.events || []));
  }, [reqId]);

  const fmtEvent = (e: any) => {
    // Human-readable summary of what changed
    if (e.entity_type === 'requisition_item') {
      const mat = e.material_name || e.entity_id.slice(0, 6);
      if (e.event_type === 'req_item.reject') return `Rejected line: ${mat}${e.note ? ` — ${e.note}` : ''}`;
      if (e.event_type === 'req_item.unreject') return `Un-rejected line: ${mat}`;
      // Edit
      const parts: string[] = [];
      if (e.before && e.after && e.before.chef_approved_qty !== e.after.chef_approved_qty) {
        parts.push(`qty ${e.before.chef_approved_qty ?? 'req\'d'} → ${e.after.chef_approved_qty ?? 'req\'d'}`);
      }
      if (e.before && e.after && e.before.chef_note !== e.after.chef_note) {
        parts.push(`note: "${e.after.chef_note}"`);
      }
      return `Edited line ${mat}: ${parts.join(' · ') || 'no change'}`;
    }
    // Requisition-level events (submit / chef approve / chef reject / etc.)
    return e.event_type.replace(/[_.]/g, ' ');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-2xl my-12" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#E8D5C4]">
          <h3 className="text-base font-semibold text-[#2D1B0E]">Audit Timeline — <span className="font-mono text-[#af4408]">{reqNum}</span></h3>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={18} /></button>
        </div>
        <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
          {events == null ? (
            <div className="text-sm text-[#8B7355]"><Loader2 size={12} className="inline animate-spin mr-1" />Loading…</div>
          ) : events.length === 0 ? (
            <div className="text-sm text-[#8B7355] italic">No events recorded for this requisition.</div>
          ) : (
            <ol className="space-y-2">
              {events.map((e: any) => (
                <li key={e.id} className="border-l-2 border-[#E8D5C4] pl-3 py-1">
                  <div className="text-xs text-[#2D1B0E]">{fmtEvent(e)}</div>
                  <div className="text-[10px] text-[#8B7355] mt-0.5">
                    {e.actor_email || 'system'} · {fmtIST(e.created_at)}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
