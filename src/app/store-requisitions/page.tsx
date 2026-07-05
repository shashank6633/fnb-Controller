'use client';

/**
 * Store Requisitions — the store team's daily issue desk.
 *
 * Lists every requisition that's been approved by Chef + Mgmt and is waiting
 * for the store to actually hand items over. For each line the store can:
 *   - Issue Now → records qty + timestamp + issuer; supports partial issue
 *                  (e.g. requested 5 kg, issued 3 kg now, issue 2 kg later).
 *   - Defer    → set a "I'll bring it at 7pm" timestamp + reason. The line
 *                  stays open and surfaces under the Deferred filter.
 *   - Undo     → clear actions on a line (mistakes happen).
 *
 * Status auto-advances:
 *   mgmt_approved / chef_approved → store_processed (once any action taken)
 *   store_processed → fulfilled (when every non-rejected, non-deferred line
 *                                has quantity_issued >= chef_approved_qty).
 *
 * Each line carries an `issue_history` JSON array of {qty, at, by, note},
 * so split-issues are fully traceable. The /audit page shows the per-line
 * + req-level audit_events written by the store-issue endpoint.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Package, Loader2, RefreshCw, Search, Clock, CheckCircle2, AlertCircle,
  Send, RotateCcw, ChevronRight, ChevronDown, History, User as UserIcon, XCircle,
} from 'lucide-react';
import { api } from '@/lib/api';
import { fmtIST } from '@/lib/format-date';

interface Department { id: string; name: string; }
interface ReqLine {
  id: string;
  material_id: string;
  material_name: string;
  /** Unit on the requisition line — may be blank for legacy reqs. */
  unit: string;
  /** Canonical recipe unit on raw_materials (from rm.unit AS material_unit). Fallback for `unit`. */
  material_unit?: string;
  quantity_requested: number;
  chef_approved_qty: number | null;
  is_rejected: number;
  /** Store-side rejection — distinct from is_rejected (which is the chef's). */
  store_rejected?: number;
  store_reject_reason?: string;
  chef_note: string;
  quantity_issued: number;
  issued_at: string | null;
  issued_by: string | null;
  deferred_until: string | null;
  defer_reason: string | null;
  issue_history: string;          // JSON of [{qty, at, by, note}]
  notes?: string;
  department_id?: string;
}
interface Requisition {
  id: string; req_number: string; purpose: string;
  status: string;
  department_id: string; department_name: string;
  drafted_by: string; submitted_at: string; chef_approved_at: string | null;
  mgmt_approved_at: string | null; store_processed_at: string | null;
  store_processed_by: string | null;
  event_name?: string; event_date?: string;
  items: ReqLine[];
  total_lines: number; lines_issued: number; lines_deferred: number; lines_open: number;
}

// All timestamps render in IST (Asia/Kolkata) via the shared formatter.
// Storage stays UTC; conversion happens here at display time.
const fmtDateTime = (iso: string | null) => fmtIST(iso);
const fmtNum = (v: number) => (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
// Stable empty set — passed as the default `selectedIds` so ReqCard doesn't get
// a fresh Set identity every render when a requisition has no selection yet.
const EMPTY_SET: Set<string> = new Set();

export default function StoreRequisitionsPage() {
  const [list, setList] = useState<Requisition[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'open' | 'deferred' | 'today_fulfilled' | 'issued_log'>('open');
  // Issued-log state (date range, fetched separately from the queue).
  const todayStr = new Date().toISOString().slice(0, 10);
  const [logFrom, setLogFrom] = useState(todayStr);
  const [logTo, setLogTo] = useState(todayStr);
  const [log, setLog] = useState<{ events: any[]; totals: any } | null>(null);
  const [logLoading, setLogLoading] = useState(false);

  // fetch wrapper that gives a useful error if the server returned HTML (login
  // redirect, 404, etc.) instead of JSON. Avoids the cryptic
  // "Unexpected token '<', '<!DOCTYPE'..." that breaks the page.
  const fetchJson = async (url: string) => {
    const r = await fetch(url, { credentials: 'same-origin' });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      const text = (await r.text()).slice(0, 120);
      throw new Error(`${url} returned non-JSON (status ${r.status}): ${text}`);
    }
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `${url} → HTTP ${r.status}`);
    return j;
  };
  const [deptId, setDeptId] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [editQty, setEditQty] = useState<Record<string, string>>({});
  const [editDefer, setEditDefer] = useState<Record<string, { until: string; reason: string }>>({});
  const [showHistoryFor, setShowHistoryFor] = useState<string | null>(null);
  // "Issue All Items" confirmation — holds the requisition whose bulk-issue is
  // awaiting confirmation (null = no modal). We compute the lines to issue at
  // confirm time from the same req object.
  const [confirmIssueAll, setConfirmIssueAll] = useState<Requisition | null>(null);
  const [issuingAll, setIssuingAll] = useState(false);
  // Feature 3 — line-level selection for "Issue Selected". Selection is scoped
  // per requisition: a map of reqId → Set of selected line ids. We clear a
  // requisition's set after a successful "Issue Selected" for that req.
  const [selectedLines, setSelectedLines] = useState<Record<string, Set<string>>>({});
  const [issuingSelected, setIssuingSelected] = useState<string | null>(null);

  // Toggle a single line's checkbox within a requisition's selection set.
  const toggleLineSelect = (reqId: string, lineId: string) => {
    setSelectedLines(prev => {
      const next = new Set(prev[reqId] || []);
      next.has(lineId) ? next.delete(lineId) : next.add(lineId);
      return { ...prev, [reqId]: next };
    });
  };

  // "Select all open" — set the requisition's selection to exactly its open
  // issuable line ids, or clear it if all are already selected.
  const toggleSelectAll = (req: Requisition) => {
    const openIds = openIssuableLines(req).map(l => l.id);
    setSelectedLines(prev => {
      const cur = prev[req.id] || new Set<string>();
      const allSelected = openIds.length > 0 && openIds.every(id => cur.has(id));
      return { ...prev, [req.id]: allSelected ? new Set<string>() : new Set(openIds) };
    });
  };

  // Issue ONLY the checked lines of a requisition in one /store-issue POST.
  // Each selected line is issued at its remaining (effective − issued) qty, the
  // same amount "Issue All" uses. Skips lines that are no longer issuable (e.g.
  // remaining fell to 0 since selection). Clears this req's selection on success.
  const issueSelected = async (req: Requisition) => {
    const sel = selectedLines[req.id] || new Set<string>();
    const lines = openIssuableLines(req).filter(l => sel.has(l.id));
    if (lines.length === 0) { alert('No selected items to issue.'); return; }
    setIssuingSelected(req.id);
    try {
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: lines.map(l => ({ id: l.id, action: 'issue', quantity: l.remaining })) },
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Issue selected failed'); return; }
      setSelectedLines(prev => { const n = { ...prev }; delete n[req.id]; return n; });
      setRefreshKey(k => k + 1);
    } finally { setIssuingSelected(null); }
  };

  const reload = async () => {
    setLoading(true); setError(null);
    try {
      // Use the existing inbox=store filter to grab mgmt-approved + chef-approved + in-progress
      const params = new URLSearchParams({ inbox: 'store' });
      if (deptId) params.set('department_id', deptId);
      const j = await fetchJson(`/api/requisitions?${params}`);
      const reqs: any[] = (j.requisitions || j.list || j.items || j) as any;
      // The list endpoint returns lightweight rows — fetch full detail (with
      // items) in parallel via the ?id= form (the only single-req GET shape).
      const detailed = await Promise.all(
        reqs.map(async (rq: any) => {
          const d = await fetchJson(`/api/requisitions?id=${encodeURIComponent(rq.id)}`);
          return mergeStats(d.requisition || d);
        }),
      );
      // Also pull anything fulfilled today (so the store can review what they
      // did earlier in the day without losing it). We don't pass from/to here
      // because those filter on r.date (when the req was raised), not on
      // fulfilled_at (when items were issued). Filter client-side instead.
      // Limit to recent fulfilled reqs so the list doesn't balloon.
      const todayPrefix = new Date().toISOString().slice(0, 10);
      // Pull every fulfilled req (both purposes). Party reqs live on
      // /party-approvals for the approval workflow, but once Mgmt-approved
      // they're issued from the store here too, so they belong in this log.
      const fulfilled = await fetchJson(`/api/requisitions?status=fulfilled${deptId ? `&department_id=${deptId}` : ''}`);
      const fulfilledRaw: any[] = (fulfilled.requisitions || fulfilled.list || fulfilled.items || fulfilled) as any[];
      const fulfilledToday = (fulfilledRaw || []).filter((rq: any) => {
        const ts = String(rq.fulfilled_at || rq.store_processed_at || '');
        // fulfilled_at may be ISO ("2026-05-26T13:45:00") or SQLite ("2026-05-26 13:45:00")
        return ts.startsWith(todayPrefix);
      });
      const fulfilledDetailed = await Promise.all(
        fulfilledToday.map(async (rq: any) => {
          const d = await fetchJson(`/api/requisitions?id=${encodeURIComponent(rq.id)}`);
          return mergeStats(d.requisition || d);
        }),
      );
      // Dedup
      const seen = new Set<string>();
      const all = [...detailed, ...fulfilledDetailed].filter(r => {
        if (seen.has(r.id)) return false;
        seen.add(r.id); return true;
      });
      setList(all);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [deptId, refreshKey]);

  // Load the issued-log only when its tab is active (or its filters change).
  // Reload when the queue refreshes too, so a fresh issue shows up immediately.
  useEffect(() => {
    if (filter !== 'issued_log') return;
    let cancelled = false;
    setLogLoading(true);
    const qs = new URLSearchParams({ from: logFrom, to: logTo });
    if (deptId) qs.set('department_id', deptId);
    fetchJson(`/api/store-issued-log?${qs}`)
      .then(j => { if (!cancelled) setLog(j); })
      .catch(e => { if (!cancelled) { setLog(null); setError(e.message); } })
      .finally(() => { if (!cancelled) setLogLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [filter, logFrom, logTo, deptId, refreshKey]);

  // One-shot: load department list for the filter dropdown.
  useEffect(() => {
    fetch('/api/departments').then(r => r.json()).then(j => {
      setDepartments(Array.isArray(j) ? j : (j.departments || []));
    }).catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    let rows = list;
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r => r.req_number?.toLowerCase().includes(q)
        || r.department_name?.toLowerCase().includes(q)
        || r.event_name?.toLowerCase().includes(q));
    }
    if (filter === 'open') {
      // pending issue: status != fulfilled AND at least one open line
      rows = rows.filter(r => r.status !== 'fulfilled' && r.lines_open > 0);
    } else if (filter === 'deferred') {
      rows = rows.filter(r => r.lines_deferred > 0);
    } else if (filter === 'today_fulfilled') {
      rows = rows.filter(r => r.status === 'fulfilled');
    }
    return rows;
  }, [list, filter, search]);

  const toggleRow = (id: string) => {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const issueLine = async (req: Requisition, line: ReqLine, qtyOverride?: number) => {
    const requested = effectiveQty(line);
    const outstanding = Math.max(0, requested - (line.quantity_issued || 0));
    const qty = qtyOverride ?? Number(editQty[line.id] ?? outstanding);
    if (!qty || qty <= 0) { alert('Enter a quantity > 0'); return; }
    setBusyLine(line.id);
    try {
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: [{ id: line.id, action: 'issue', quantity: qty }] },
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Issue failed'); return; }
      setEditQty(s => ({ ...s, [line.id]: '' }));
      setRefreshKey(k => k + 1);
    } finally { setBusyLine(null); }
  };

  const deferLine = async (req: Requisition, line: ReqLine) => {
    const cfg = editDefer[line.id];
    if (!cfg?.until) { alert('Pick a date/time you can issue this'); return; }
    setBusyLine(line.id);
    try {
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: [{ id: line.id, action: 'defer', defer_until: cfg.until, reason: cfg.reason || '' }] },
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Defer failed'); return; }
      setEditDefer(s => { const n = { ...s }; delete n[line.id]; return n; });
      setRefreshKey(k => k + 1);
    } finally { setBusyLine(null); }
  };

  const undoLine = async (req: Requisition, line: ReqLine) => {
    if (!confirm(`Undo all actions on ${line.material_name}?`)) return;
    setBusyLine(line.id);
    try {
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: [{ id: line.id, action: 'undo' }] },
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Undo failed'); return; }
      setRefreshKey(k => k + 1);
    } finally { setBusyLine(null); }
  };

  // Store-side rejection — the store cannot fulfil this line at all (discontinued,
  // wrong item, etc.). Distinct from the chef's rejection. Prompts for a reason,
  // then marks the line store_rejected via the store-issue endpoint.
  const rejectLine = async (req: Requisition, line: ReqLine) => {
    const reason = prompt(`Reject "${line.material_name}"? Give a reason (the store cannot fulfil this line):`, '');
    if (reason === null) return;                       // cancelled
    setBusyLine(line.id);
    try {
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: [{ id: line.id, action: 'reject', reason: reason.trim() }] },
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Reject failed'); return; }
      setRefreshKey(k => k + 1);
    } finally { setBusyLine(null); }
  };

  const unrejectLine = async (req: Requisition, line: ReqLine) => {
    setBusyLine(line.id);
    try {
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: [{ id: line.id, action: 'unreject' }] },
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Un-reject failed'); return; }
      setRefreshKey(k => k + 1);
    } finally { setBusyLine(null); }
  };

  // Issue EVERY still-open line of a requisition in ONE POST. "Open" here means:
  // not rejected, not deferred, and with remaining > 0 (remaining = effective
  // qty − already-issued). Deferred lines are intentionally skipped — the store
  // committed to a later time for those. Reuses the same /store-issue endpoint
  // as issueLine, which already supports multiple lines per call.
  const issueAllOpen = async (req: Requisition) => {
    const lines = openIssuableLines(req);
    if (lines.length === 0) { alert('No open items to issue.'); return; }
    setIssuingAll(true);
    try {
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: lines.map(l => ({ id: l.id, action: 'issue', quantity: l.remaining })) },
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Issue all failed'); return; }
      setConfirmIssueAll(null);
      setRefreshKey(k => k + 1);
    } finally { setIssuingAll(false); }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <Package className="w-6 h-6 text-[#af4408]" /> Store Requisitions
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Every requisition currently waiting on the store team to hand over goods —
            <b> internal kitchen</b> reqs (after Chef approval) and <b>party</b> reqs (after Chef + Mgmt approval).
            Issue full or partial, or defer with a promised time. Every action is time-stamped and traceable per item.
          </p>
        </div>
        <button onClick={() => setRefreshKey(k => k + 1)}
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {/* Status tabs */}
      <div className="flex gap-2 flex-wrap text-xs">
        {([
          { k: 'open',             label: 'Pending Issue',   icon: AlertCircle, tone: 'amber' },
          { k: 'deferred',         label: 'Deferred',        icon: Clock,       tone: 'blue' },
          { k: 'today_fulfilled',  label: 'Fulfilled Today', icon: CheckCircle2,tone: 'emerald' },
          { k: 'issued_log',       label: 'Issued Items Log',icon: History,     tone: 'amber' },
        ] as const).map(t => {
          const n = filter === t.k ? (t.k === 'issued_log' ? (log?.totals?.events || 0) : filtered.length) :
            t.k === 'open'            ? list.filter(r => r.status !== 'fulfilled' && r.lines_open > 0).length :
            t.k === 'deferred'        ? list.filter(r => r.lines_deferred > 0).length :
            t.k === 'today_fulfilled' ? list.filter(r => r.status === 'fulfilled').length :
                                        (log?.totals?.events || 0);
          const active = filter === t.k;
          const Icon = t.icon;
          const onStyle: Record<string, string> = {
            amber: active ? 'bg-amber-600 text-white border-amber-600' : 'bg-amber-50 text-amber-800 border-amber-200',
            blue:  active ? 'bg-blue-600  text-white border-blue-600'  : 'bg-blue-50  text-blue-800  border-blue-200',
            emerald: active ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-emerald-50 text-emerald-800 border-emerald-200',
          };
          return (
            <button key={t.k} onClick={() => setFilter(t.k)}
                    className={`px-3 py-1.5 rounded border flex items-center gap-1.5 ${onStyle[t.tone]}`}>
              <Icon className="w-3.5 h-3.5" /> {t.label} <span className="font-mono">{n}</span>
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 bg-white border border-[#E8D5C4] rounded-xl p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-2 top-2 text-[#8B7355]" />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Search req# / department / event…"
                 className="w-full pl-8 pr-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </div>
        <select value={deptId} onChange={e => setDeptId(e.target.value)}
                className="px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] min-w-[160px]">
          <option value="">All departments</option>
          {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}

      {/* Tab body — Issued Log gets its own panel, the other three share the requisition list. */}
      {filter === 'issued_log' ? (
        <IssuedLogPanel
          loading={logLoading} log={log}
          from={logFrom} to={logTo}
          onFromChange={setLogFrom} onToChange={setLogTo}
        />
      ) : loading ? (
        <div className="p-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-10 bg-white border border-[#E8D5C4] rounded-xl text-center text-sm text-[#8B7355]">
          <CheckCircle2 className="w-7 h-7 mx-auto mb-2 text-emerald-500" />
          Nothing here. {filter === 'open' && 'Caught up — no pending requisitions.'}
          {filter === 'deferred' && 'No deferred items.'}
          {filter === 'today_fulfilled' && 'No fulfilments recorded today yet.'}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(req => (
            <ReqCard key={req.id}
                     req={req}
                     expanded={expanded.has(req.id)}
                     onToggle={() => toggleRow(req.id)}
                     showIssueAll={filter === 'open'}
                     onIssueAll={() => setConfirmIssueAll(req)}
                     selectable={filter === 'open'}
                     selectedIds={selectedLines[req.id] || EMPTY_SET}
                     onToggleLineSelect={(lineId) => toggleLineSelect(req.id, lineId)}
                     onToggleSelectAll={() => toggleSelectAll(req)}
                     onIssueSelected={() => issueSelected(req)}
                     issuingSelected={issuingSelected === req.id}
                     busyLine={busyLine}
                     editQty={editQty}
                     setEditQty={setEditQty}
                     editDefer={editDefer}
                     setEditDefer={setEditDefer}
                     onIssue={(line, qty) => issueLine(req, line, qty)}
                     onDefer={(line) => deferLine(req, line)}
                     onUndo={(line) => undoLine(req, line)}
                     onReject={(line) => rejectLine(req, line)}
                     onUnreject={(line) => unrejectLine(req, line)}
                     onShowHistory={(line) => setShowHistoryFor(line.id)} />
          ))}
        </div>
      )}

      {/* History drawer */}
      {showHistoryFor && (() => {
        const found = list.flatMap(r => r.items).find(i => i.id === showHistoryFor);
        if (!found) return null;
        return <HistoryDrawer line={found} onClose={() => setShowHistoryFor(null)} />;
      })()}

      {/* Issue-All confirmation modal */}
      {confirmIssueAll && (
        <IssueAllModal
          req={confirmIssueAll}
          busy={issuingAll}
          onCancel={() => { if (!issuingAll) setConfirmIssueAll(null); }}
          onConfirm={() => issueAllOpen(confirmIssueAll)}
        />
      )}
    </div>
  );
}

/**
 * Confirmation modal for "Issue All Items". Lists every open line that will be
 * issued (material × remaining qty) to the requisition's department, with
 * Confirm / Cancel. Nothing is POSTed until the user confirms.
 */
function IssueAllModal({ req, busy, onCancel, onConfirm }: {
  req: Requisition; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const lines = openIssuableLines(req);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#E8D5C4]">
          <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">
            <Send className="w-4 h-4 text-emerald-600" /> Issue all items
          </div>
          <div className="text-[11px] text-[#8B7355] mt-0.5">
            {req.req_number} — these items are being issued to <b className="text-[#6B5744]">{req.department_name}</b>:
          </div>
        </div>
        <div className="p-4 max-h-[50vh] overflow-y-auto">
          {lines.length === 0 ? (
            <div className="text-sm text-[#8B7355] text-center py-4">No open items to issue.</div>
          ) : (
            <ul className="space-y-1">
              {lines.map(l => {
                const u = l.unit || l.material_unit || '';
                return (
                  <li key={l.id} className="flex items-center justify-between text-sm border-b border-[#E8D5C4]/50 py-1.5">
                    <span className="text-[#2D1B0E]">{l.material_name}</span>
                    <span className="font-mono font-semibold text-emerald-700">
                      × {fmtNum(l.remaining)}{u && <span className="text-[10px] text-[#8B7355] ml-0.5">{u}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2">
          <button onClick={onCancel} disabled={busy}
                  className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy || lines.length === 0}
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Confirm & Issue
          </button>
        </div>
      </div>
    </div>
  );
}

function effectiveQty(line: ReqLine): number {
  if (line.is_rejected) return 0;
  if (line.chef_approved_qty != null) return Number(line.chef_approved_qty);
  return Number(line.quantity_requested) || 0;
}

/**
 * Lines that "Issue All Items" will issue: not rejected, not deferred, and with
 * a positive remaining qty. Returns each with its `remaining` (effective − issued)
 * so both the confirmation list and the POST body use the same numbers.
 */
function openIssuableLines(req: Requisition): Array<ReqLine & { remaining: number }> {
  const out: Array<ReqLine & { remaining: number }> = [];
  for (const line of req.items || []) {
    if (line.is_rejected) continue;
    if (line.store_rejected) continue;      // store rejected — never in the Issue-All batch
    if (line.deferred_until) continue;
    const remaining = Math.max(0, effectiveQty(line) - (Number(line.quantity_issued) || 0));
    if (remaining > 0) out.push({ ...line, remaining });
  }
  return out;
}

function mergeStats(req: any): Requisition {
  const items: ReqLine[] = req.items || [];
  let issued = 0, deferred = 0, open = 0;
  for (const it of items) {
    if (it.is_rejected) continue;
    if (it.store_rejected) continue;      // store rejected — not counted as open/issued/deferred
    const eff = effectiveQty(it);
    const got = Number(it.quantity_issued) || 0;
    if (got >= eff && !it.deferred_until) issued++;
    else if (it.deferred_until) deferred++;
    else open++;
  }
  return {
    ...req,
    items,
    total_lines: items.length,
    lines_issued: issued,
    lines_deferred: deferred,
    lines_open: open,
  } as Requisition;
}

function ReqCard(props: {
  req: Requisition; expanded: boolean; onToggle: () => void;
  showIssueAll?: boolean; onIssueAll?: () => void;
  // Feature 3 — per-requisition line selection.
  selectable?: boolean;
  selectedIds: Set<string>;
  onToggleLineSelect: (lineId: string) => void;
  onToggleSelectAll: () => void;
  onIssueSelected: () => void;
  issuingSelected: boolean;
  busyLine: string | null;
  editQty: Record<string, string>; setEditQty: (f: any) => void;
  editDefer: Record<string, { until: string; reason: string }>;
  setEditDefer: (f: any) => void;
  onIssue: (line: ReqLine, qty?: number) => void;
  onDefer: (line: ReqLine) => void;
  onUndo: (line: ReqLine) => void;
  onReject: (line: ReqLine) => void;
  onUnreject: (line: ReqLine) => void;
  onShowHistory: (line: ReqLine) => void;
}) {
  const { req, expanded, onToggle } = props;
  // Feature 3 — selection derived state. Open issuable lines are the only
  // selectable ones; the header checkbox reflects/controls all of them.
  const openLines = openIssuableLines(req);
  const openIds = openLines.map(l => l.id);
  const selectedCount = openIds.filter(id => props.selectedIds.has(id)).length;
  const allOpenSelected = openIds.length > 0 && selectedCount === openIds.length;
  const someOpenSelected = selectedCount > 0 && !allOpenSelected;
  const statusTone: Record<string, string> = {
    mgmt_approved:   'bg-amber-100 text-amber-800 border-amber-200',
    chef_approved:   'bg-amber-100 text-amber-800 border-amber-200',
    store_processed: 'bg-blue-100 text-blue-800 border-blue-200',
    fulfilled:       'bg-emerald-100 text-emerald-800 border-emerald-200',
  };
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
      <button onClick={onToggle}
              className="w-full px-4 py-3 flex items-center gap-3 hover:bg-[#FFF1E3]/40 text-left">
        {expanded ? <ChevronDown className="w-4 h-4 text-[#8B7355]" /> : <ChevronRight className="w-4 h-4 text-[#8B7355]" />}
        <div className="flex-1 min-w-0">
          <div className="font-mono text-sm font-semibold text-[#2D1B0E] flex items-center gap-2">
            {/* Purpose badge — tells the store user immediately whether this is
                a kitchen restock or a party-specific issue. Party events have
                hard deadlines, so this visual distinction matters. */}
            {req.purpose === 'party' ? (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-pink-100 text-pink-800 border border-pink-200 font-semibold">PARTY</span>
            ) : (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#FFF1E3] text-[#6B5744] border border-[#D4B896] font-semibold">INTERNAL</span>
            )}
            {req.req_number}
          </div>
          <div className="text-[11px] text-[#8B7355] flex flex-wrap gap-x-3">
            <span>Dept: <b className="text-[#6B5744]">{req.department_name}</b></span>
            {req.event_name && <span>Event: <b className="text-[#6B5744]">{req.event_name}</b></span>}
            {req.purpose === 'party' && req.event_date && (
              <span className="text-pink-700">Date: <b>{req.event_date}</b></span>
            )}
            <span>By: {req.drafted_by}</span>
            <span>Approved: {fmtDateTime(req.mgmt_approved_at || req.chef_approved_at)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          {req.lines_issued > 0 && <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">{req.lines_issued} issued</span>}
          {req.lines_deferred > 0 && <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">{req.lines_deferred} deferred</span>}
          {req.lines_open > 0 && <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">{req.lines_open} open</span>}
          <span className={`px-2 py-0.5 rounded border ${statusTone[req.status] || 'bg-gray-50 text-gray-700 border-gray-200'}`}>{req.status}</span>
        </div>
      </button>

      {/* Issue All Items — one-click bulk issue of every open (non-rejected,
          non-deferred, remaining>0) line. Only on the Pending Issue tab, and
          only when at least one such line exists. Clicking opens a confirmation
          modal (handled by the page) before anything is POSTed. */}
      {props.showIssueAll && openIssuableLines(req).length > 0 && (
        <div className="px-4 py-2 border-t border-[#E8D5C4] bg-[#FFF8F0] flex items-center justify-between gap-2">
          <span className="text-[11px] text-[#8B7355]">
            {openIssuableLines(req).length} open item{openIssuableLines(req).length > 1 ? 's' : ''} ready to hand over.
          </span>
          <button onClick={props.onIssueAll}
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium flex items-center gap-1.5">
            <Send className="w-3.5 h-3.5" /> Issue All Items
          </button>
        </div>
      )}

      {/* Issue Selected — appears when the card is expanded, selection is
          enabled (Pending Issue tab) and at least one open line is checked.
          Issues ONLY the checked lines (each at its remaining qty) in one POST. */}
      {props.selectable && expanded && selectedCount > 0 && (
        <div className="px-4 py-2 border-t border-[#E8D5C4] bg-emerald-50/60 flex items-center justify-between gap-2">
          <span className="text-[11px] text-emerald-800">
            {selectedCount} item{selectedCount > 1 ? 's' : ''} selected.
          </span>
          <div className="flex items-center gap-2">
            <button onClick={props.onToggleSelectAll}
                    className="text-[11px] text-[#8B7355] hover:underline">
              {allOpenSelected ? 'Clear selection' : 'Select all open'}
            </button>
            <button onClick={props.onIssueSelected} disabled={props.issuingSelected}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 disabled:opacity-50">
              {props.issuingSelected ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Issue Selected
            </button>
          </div>
        </div>
      )}

      {expanded && (
        <div className="border-t border-[#E8D5C4] overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-[#FFF1E3] text-[#6B5744]">
              <tr>
                {props.selectable && (
                  <th className="py-1.5 px-2 w-8 text-center">
                    <input type="checkbox"
                           aria-label="Select all open lines"
                           title="Select all open lines"
                           checked={allOpenSelected}
                           ref={el => { if (el) el.indeterminate = someOpenSelected; }}
                           disabled={openIds.length === 0}
                           onChange={props.onToggleSelectAll}
                           className="align-middle accent-emerald-600" />
                  </th>
                )}
                <th className="text-left  py-1.5 px-2 font-medium">Material</th>
                <th className="text-right py-1.5 px-2 font-medium" title="Quantity requested in the recipe unit (kg / L / pcs / etc.)">Requested (qty + unit)</th>
                <th className="text-right py-1.5 px-2 font-medium" title="HOD-approved quantity (overrides requested if set)">HOD OK</th>
                <th className="text-right py-1.5 px-2 font-medium">Issued so far</th>
                <th className="text-right py-1.5 px-2 font-medium">Outstanding</th>
                <th className="text-left  py-1.5 px-2 font-medium">Last issue</th>
                <th className="text-left  py-1.5 px-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {req.items.map(line => (
                <LineRow key={line.id} line={line} req={req}
                         selectable={props.selectable}
                         selected={props.selectedIds.has(line.id)}
                         onToggleSelect={() => props.onToggleLineSelect(line.id)}
                         busy={props.busyLine === line.id}
                         editQty={props.editQty} setEditQty={props.setEditQty}
                         editDefer={props.editDefer} setEditDefer={props.setEditDefer}
                         onIssue={props.onIssue} onDefer={props.onDefer}
                         onUndo={props.onUndo} onReject={props.onReject} onUnreject={props.onUnreject}
                         onShowHistory={props.onShowHistory} />
              ))}
            </tbody>
          </table>
          {req.store_processed_by && (
            <div className="px-4 py-2 text-[11px] text-[#8B7355] bg-[#FFF8F0] border-t border-[#E8D5C4]">
              First touched by <b className="text-[#6B5744]">{req.store_processed_by}</b> at {fmtDateTime(req.store_processed_at)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LineRow(props: {
  line: ReqLine; req: Requisition; busy: boolean;
  // Feature 3 — per-line selection checkbox (only meaningful on open lines).
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  editQty: Record<string, string>; setEditQty: (f: any) => void;
  editDefer: Record<string, { until: string; reason: string }>;
  setEditDefer: (f: any) => void;
  onIssue: (line: ReqLine, qty?: number) => void;
  onDefer: (line: ReqLine) => void;
  onUndo: (line: ReqLine) => void;
  onReject: (line: ReqLine) => void;
  onUnreject: (line: ReqLine) => void;
  onShowHistory: (line: ReqLine) => void;
}) {
  const { line, busy } = props;
  const eff = effectiveQty(line);
  const issued = Number(line.quantity_issued) || 0;
  const outstanding = Math.max(0, eff - issued);
  // Display unit — prefer the line's own unit, else fall back to the canonical
  // material_unit returned by the API. We render it next to every quantity so
  // the store user always knows what they're handing over (kg / L / pcs / BTL).
  const u = line.unit || line.material_unit || '';
  const unitTag = u ? <span className="text-[9px] text-[#8B7355] ml-0.5">{u}</span> : null;
  const rowTone = line.is_rejected ? 'bg-red-50/40 text-[#999] line-through'
                : line.store_rejected ? 'bg-red-50/40 text-[#999]'
                : outstanding === 0 && !line.deferred_until ? 'bg-emerald-50/30'
                : line.deferred_until ? 'bg-blue-50/30' : '';
  const deferOpen = !!props.editDefer[line.id];
  // A line is selectable only when it's an open issuable line: not rejected by
  // chef or store, not deferred, and with a positive outstanding qty. Matches
  // openIssuableLines() so header select-all and per-line boxes stay in sync.
  const isCheckable = !line.is_rejected && !line.store_rejected && !line.deferred_until && outstanding > 0;
  return (
    <tr className={`border-t border-[#E8D5C4]/50 ${rowTone}`}>
      {props.selectable && (
        <td className="py-1.5 px-2 align-top text-center">
          {isCheckable ? (
            <input type="checkbox"
                   aria-label={`Select ${line.material_name}`}
                   checked={!!props.selected}
                   onChange={props.onToggleSelect}
                   className="align-middle accent-emerald-600" />
          ) : null}
        </td>
      )}
      <td className="py-1.5 px-2 align-top">
        <div className="font-medium text-[#2D1B0E] flex items-center gap-1.5">
          {line.material_name}
          {line.store_rejected ? (
            <span className="text-[8px] px-1 py-0.5 rounded bg-red-100 text-red-700 border border-red-300 font-semibold no-underline">
              STORE REJECTED
            </span>
          ) : null}
        </div>
        {line.store_rejected ? (
          <div className="text-[10px] text-red-700 mt-0.5 flex items-center gap-1 no-underline">
            <XCircle className="w-3 h-3" /> Rejected by store
            {line.store_reject_reason && <span className="text-[#6B5744]">— {line.store_reject_reason}</span>}
          </div>
        ) : null}
        {line.chef_note && <div className="text-[9px] text-amber-700">Chef: {line.chef_note}</div>}
        {line.notes && <div className="text-[9px] text-[#8B7355]">Note: {line.notes}</div>}
        {line.deferred_until && (() => {
          const due = deferDueStatus(line.deferred_until);
          return (
            <div className="mt-0.5 space-y-0.5">
              <div className="text-[10px] text-blue-700 flex items-center gap-1 flex-wrap">
                <Clock className="w-3 h-3" /> Deferred until {fmtDateTime(line.deferred_until)}
                {line.defer_reason && <span className="text-[#6B5744]">— {line.defer_reason}</span>}
                {/* Feature 4 — due-soon / overdue chip. Amber when the promised
                    time is within 4h, red once it's past. Draws the store
                    manager's eye to lines that need action now. */}
                {due.soon && !due.overdue && (
                  <span className="px-1 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 font-semibold">
                    due in {due.hours}h
                  </span>
                )}
                {due.overdue && (
                  <span className="px-1 py-0.5 rounded bg-red-100 text-red-700 border border-red-300 font-semibold">
                    overdue
                  </span>
                )}
              </div>
              {/* Raise Vendor PO — for a deferred line about to come due (or
                  already past), the store manager can jump straight to the
                  purchase-orders flow to buy the material instead of waiting.
                  The PO create flow doesn't accept a material prefill, so we
                  just link to /purchase-orders. */}
              {(due.soon || due.overdue) && (
                <a href="/purchase-orders"
                   title="Raise a vendor purchase order for this material instead of issuing from store"
                   className="inline-flex items-center gap-1 text-[10px] text-[#af4408] hover:underline font-medium">
                  <Send className="w-3 h-3" /> Raise Vendor PO
                </a>
              )}
            </div>
          );
        })()}
      </td>
      <td className="py-1.5 px-2 text-right font-mono">{fmtNum(line.quantity_requested)}{unitTag}</td>
      <td className="py-1.5 px-2 text-right font-mono">
        {line.is_rejected
          ? <span className="text-red-600">rejected</span>
          : line.chef_approved_qty != null
            ? <span className="text-amber-700">{fmtNum(line.chef_approved_qty)}{unitTag}</span>
            : '—'}
      </td>
      <td className="py-1.5 px-2 text-right font-mono">{fmtNum(issued)}{unitTag}</td>
      <td className="py-1.5 px-2 text-right font-mono font-semibold">
        <span className={outstanding === 0 ? 'text-emerald-700' : 'text-[#af4408]'}>{fmtNum(outstanding)}{unitTag}</span>
      </td>
      <td className="py-1.5 px-2 align-top text-[10px] text-[#6B5744]">
        {line.issued_at ? (
          <>
            <div>{fmtDateTime(line.issued_at)}</div>
            <div className="text-[#8B7355]">by {line.issued_by}</div>
          </>
        ) : '—'}
        <button onClick={() => props.onShowHistory(line)}
                className="mt-0.5 text-[10px] text-[#af4408] hover:underline inline-flex items-center gap-0.5">
          <History className="w-3 h-3" /> history
        </button>
      </td>
      <td className="py-1.5 px-2 align-top">
        {line.is_rejected ? (
          <span className="text-[10px] text-[#8B7355]">no action — rejected by chef</span>
        ) : line.store_rejected ? (
          // Store-rejected: only an un-reject action to put the line back in play.
          <button onClick={() => props.onUnreject(line)} disabled={busy}
                  title="Clear the store rejection — the line becomes issuable again"
                  className="px-2 py-0.5 bg-white border border-red-200 text-red-700 hover:bg-red-50 rounded text-[10px] flex items-center gap-1 disabled:opacity-50">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
            Un-reject
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {outstanding > 0 && !deferOpen && (
              <>
                <input type="number" step="any" min={0} max={outstanding}
                       value={props.editQty[line.id] ?? ''}
                       onChange={e => props.setEditQty((s: any) => ({ ...s, [line.id]: e.target.value }))}
                       placeholder={String(outstanding)}
                       title={`Outstanding: ${outstanding}${u ? ' ' + u : ''}`}
                       className="w-16 px-1 py-0.5 border border-[#E8D5C4] rounded text-right text-xs bg-[#FFF8F0]" />
                {u && <span className="text-[10px] text-[#6B5744] font-medium">{u}</span>}
                <button onClick={() => props.onIssue(line)} disabled={busy}
                        className="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[10px] flex items-center gap-1 disabled:opacity-50">
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  Issue Now
                </button>
                <button onClick={() => props.setEditDefer((s: any) => ({ ...s, [line.id]: { until: defaultDefer(), reason: '' } }))}
                        className="px-2 py-0.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded text-[10px] flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Defer
                </button>
                {/* Store rejection — distinct from the chef's. Prompts for a reason. */}
                <button onClick={() => props.onReject(line)} disabled={busy}
                        title="Store cannot fulfil this line (discontinued / wrong item)"
                        className="px-2 py-0.5 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded text-[10px] flex items-center gap-1 disabled:opacity-50">
                  <XCircle className="w-3 h-3" /> Reject
                </button>
              </>
            )}
            {deferOpen && (
              <div className="flex items-center gap-1 bg-blue-50 border border-blue-200 rounded px-1.5 py-1">
                <input type="datetime-local" value={props.editDefer[line.id]?.until || ''}
                       onChange={e => props.setEditDefer((s: any) => ({ ...s, [line.id]: { ...s[line.id], until: e.target.value } }))}
                       className="px-1 py-0.5 border border-blue-200 rounded text-[10px] bg-white" />
                <input type="text" placeholder="reason (optional)"
                       value={props.editDefer[line.id]?.reason || ''}
                       onChange={e => props.setEditDefer((s: any) => ({ ...s, [line.id]: { ...s[line.id], reason: e.target.value } }))}
                       className="w-32 px-1 py-0.5 border border-blue-200 rounded text-[10px] bg-white" />
                <button onClick={() => props.onDefer(line)} disabled={busy}
                        className="px-2 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-[10px] disabled:opacity-50">
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save defer'}
                </button>
                <button onClick={() => props.setEditDefer((s: any) => { const n = { ...s }; delete n[line.id]; return n; })}
                        className="text-[10px] text-blue-700 px-1">cancel</button>
              </div>
            )}
            {(issued > 0 || line.deferred_until) && (
              <button onClick={() => props.onUndo(line)} disabled={busy}
                      title="Clear all issue/defer actions on this line"
                      className="px-1.5 py-0.5 bg-white border border-[#E8D5C4] text-[#8B7355] hover:bg-[#FFF1E3] rounded text-[10px] flex items-center gap-1">
                <RotateCcw className="w-3 h-3" /> undo
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

/**
 * Feature 4 — classify a deferred line's promised time relative to now:
 *   - soon:    due within the next 4 hours (inclusive of overdue)
 *   - overdue: the promised time is already in the past
 *   - hours:   whole-ish hours until due (for the "due in Xh" chip)
 *
 * deferred_until is a bare local datetime string (as written by
 * <input type="datetime-local">). new Date(str) parses it in the browser's
 * local timezone — the same wall-clock the store manager entered — so the
 * comparison against Date.now() is consistent.
 */
function deferDueStatus(deferredUntil: string | null): { soon: boolean; overdue: boolean; hours: number } {
  if (!deferredUntil) return { soon: false, overdue: false, hours: 0 };
  const dueMs = new Date(deferredUntil).getTime();
  if (!Number.isFinite(dueMs)) return { soon: false, overdue: false, hours: 0 };
  const delta = dueMs - Date.now();
  const overdue = delta < 0;
  const soon = delta <= 4 * 3600 * 1000;   // within 4h (or already past)
  const hours = Math.max(0, Math.round(delta / 3600000));
  return { soon, overdue, hours };
}

/** Default defer to +2h from now, formatted for <input type="datetime-local">. */
function defaultDefer(): string {
  const d = new Date(Date.now() + 2 * 3600 * 1000);
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function HistoryDrawer({ line, onClose }: { line: ReqLine; onClose: () => void }) {
  let history: Array<{ qty: number; at: string; by: string; note?: string }> = [];
  try { history = JSON.parse(line.issue_history || '[]'); } catch {}
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#E8D5C4] flex items-center justify-between">
          <div>
            <div className="font-semibold text-[#2D1B0E]">{line.material_name}</div>
            <div className="text-[10px] text-[#8B7355]">Per-issue history</div>
          </div>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-4 space-y-2 max-h-[60vh] overflow-y-auto">
          {history.length === 0 ? (
            <div className="text-sm text-[#8B7355] text-center py-6">No issue events yet for this item.</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left  py-1.5 px-2">When</th>
                  <th className="text-right py-1.5 px-2">Qty</th>
                  <th className="text-left  py-1.5 px-2">By</th>
                  <th className="text-left  py-1.5 px-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {history.slice().reverse().map((h, i) => (
                  <tr key={i} className="border-t border-[#E8D5C4]/50">
                    <td className="py-1.5 px-2">{fmtDateTime(h.at)}</td>
                    <td className="py-1.5 px-2 text-right font-mono font-semibold text-emerald-700">
                      {fmtNum(h.qty)}
                      {(line.unit || line.material_unit) && (
                        <span className="text-[9px] text-[#8B7355] ml-0.5">{line.unit || line.material_unit}</span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-[#6B5744] flex items-center gap-1"><UserIcon className="w-3 h-3" /> {h.by}</td>
                    <td className="py-1.5 px-2 text-[#8B7355]">{h.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Issued Items Log — flat list of every hand-over event in the chosen date range.
 *
 * Rows are unrolled from issue_history JSON across all requisition_items, so a
 * 30+20 kg split-issue appears as two distinct rows with their own timestamps.
 * Lets a store manager / admin audit "what went out today, to whom, and by who."
 */
function IssuedLogPanel({ loading, log, from, to, onFromChange, onToChange }: {
  loading: boolean;
  log: { events: any[]; totals: any } | null;
  from: string; to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
}) {
  const events = log?.events || [];
  const totals = log?.totals || { events: 0, total_value: 0, distinct_materials: 0, distinct_departments: 0 };

  const downloadCsv = () => {
    if (events.length === 0) return;
    const headers = ['When', 'Material', 'Qty', 'Unit', 'Department', 'Req #', 'Issuer', 'Unit Cost', 'Value', 'Purpose', 'Event', 'Note'];
    const escape = (v: any) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.join(',')];
    for (const e of events) {
      lines.push([e.at, e.material_name, e.qty, e.unit, e.department_name, e.req_number,
                  e.issuer, e.unit_cost?.toFixed?.(2), e.value?.toFixed?.(2),
                  e.purpose, e.event_name, e.note].map(escape).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `store-issued-log-${from}_to_${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-3">
      {/* Date range + CSV */}
      <div className="flex flex-wrap items-end gap-3 bg-white border border-[#E8D5C4] rounded-xl p-3">
        <label className="text-[11px] text-[#6B5744]">
          From
          <input type="date" value={from} onChange={e => onFromChange(e.target.value)}
                 className="ml-2 px-2 py-1 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </label>
        <label className="text-[11px] text-[#6B5744]">
          To
          <input type="date" value={to} onChange={e => onToChange(e.target.value)}
                 className="ml-2 px-2 py-1 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </label>
        <div className="flex-1" />
        <button onClick={downloadCsv} disabled={events.length === 0}
                className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded text-sm disabled:opacity-50">
          ⬇ Download CSV
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard label="Issue events" value={totals.events.toLocaleString('en-IN')} tone="bg-amber-50 border-amber-200 text-amber-900" />
        <SummaryCard label="Approx. value" value={'₹' + Math.round(totals.total_value || 0).toLocaleString('en-IN')} tone="bg-emerald-50 border-emerald-200 text-emerald-900" />
        <SummaryCard label="Distinct items" value={String(totals.distinct_materials)} tone="bg-[#FFF1E3] border-[#D4B896] text-[#6B5744]" />
        <SummaryCard label="Departments served" value={String(totals.distinct_departments)} tone="bg-blue-50 border-blue-200 text-blue-900" />
      </div>

      {/* Table */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
          </div>
        ) : events.length === 0 ? (
          <div className="p-10 text-center text-sm text-[#8B7355]">
            <CheckCircle2 className="w-7 h-7 mx-auto mb-2 text-emerald-500" />
            No issue events in this date range.
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF1E3] text-[#6B5744] sticky top-0">
                <tr>
                  <th className="text-left  py-2 px-2 font-medium">When</th>
                  <th className="text-left  py-2 px-2 font-medium">Material</th>
                  <th className="text-right py-2 px-2 font-medium">Qty</th>
                  <th className="text-left  py-2 px-2 font-medium">To Dept</th>
                  <th className="text-left  py-2 px-2 font-medium">Req #</th>
                  <th className="text-left  py-2 px-2 font-medium">Issued By</th>
                  <th className="text-right py-2 px-2 font-medium">Value</th>
                  <th className="text-left  py-2 px-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30">
                    <td className="py-1.5 px-2 whitespace-nowrap">{fmtDateTime(e.at)}</td>
                    <td className="py-1.5 px-2 font-medium text-[#2D1B0E]">
                      {e.material_name}
                      {e.purpose === 'party' && e.event_name && (
                        <div className="text-[9px] text-[#8B7355]">party: {e.event_name}</div>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono font-semibold text-emerald-700">
                      {fmtNum(e.qty)} <span className="text-[9px] text-[#8B7355]">{e.unit}</span>
                    </td>
                    <td className="py-1.5 px-2 text-[#6B5744]">{e.department_name || '—'}</td>
                    <td className="py-1.5 px-2 font-mono text-[10px] text-[#8B7355]">{e.req_number}</td>
                    <td className="py-1.5 px-2 text-[#6B5744]">{e.issuer || '—'}</td>
                    <td className="py-1.5 px-2 text-right font-mono">
                      {e.value > 0 ? '₹' + Math.round(e.value).toLocaleString('en-IN') : '—'}
                    </td>
                    <td className="py-1.5 px-2 text-[#8B7355]">{e.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className={`border rounded-xl p-3 ${tone}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-xl font-bold font-mono mt-0.5">{value}</div>
    </div>
  );
}
