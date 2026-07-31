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
 * The tabs are ROLL-UPS of the line columns, not a second status field, so one
 * requisition can legitimately sit in more than one: a half-issued req is in
 * "Issued Today" (goods did move) AND "Balance Pending" (goods are still owed).
 * "Deferred" is NOT a synonym for either — it means a line carries a promised
 * date/time (deferred_until), which only a human sets.
 *
 * Each line carries an `issue_history` JSON array of {qty, at, by, note},
 * so split-issues are fully traceable. The /audit page shows the per-line
 * + req-level audit_events written by the store-issue endpoint.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Package, Loader2, RefreshCw, Search, Clock, CheckCircle2, AlertCircle,
  Send, RotateCcw, ChevronRight, ChevronDown, History, User as UserIcon, XCircle,
  Hourglass, Split,
} from 'lucide-react';
import { api } from '@/lib/api';
import { fmtIST, fmtISTIsoDate, todayIST } from '@/lib/format-date';
import TabScroller from '@/components/TabScroller';
import { packFactor } from '@/lib/pack-units';

interface Department { id: string; name: string; }
interface ReqLine {
  id: string;
  material_id: string;
  material_name: string;
  /** Unit on the requisition line — may be blank for legacy reqs. */
  unit: string;
  /** Canonical recipe unit on raw_materials (from rm.unit AS material_unit). Fallback for `unit`. */
  material_unit?: string;
  /** Pack meta (rm.purchase_unit / rm.pack_size) — the store works in purchase units. */
  material_purchase_unit?: string;
  material_pack_size?: number;
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
  /** Identity, for the item-level search. SKU doubles as the item code. */
  material_sku?: string;
  material_sku_code?: string;
  material_brand?: string | null;
  /** Central store on-hand + its reorder point, both RECIPE units. */
  reorder_level?: number;
  /** Last hand-over of THIS MATERIAL on any OTHER requisition — quantity is in
   *  that line's own unit (Option B), which is why the unit travels with it. */
  mat_last_issue_at?: string | null;
  mat_last_issue_qty?: number | null;
  mat_last_issue_unit?: string | null;
  mat_last_issue_dept?: string | null;
}
interface Requisition {
  id: string; req_number: string; purpose: string;
  status: string;
  department_id: string; department_name: string;
  drafted_by: string; submitted_at: string; chef_approved_at: string | null;
  mgmt_approved_at: string | null; store_processed_at: string | null;
  store_processed_by: string | null;
  event_name?: string; event_date?: string;
  fulfilled_at?: string | null;
  items: ReqLine[];
  total_lines: number; lines_issued: number; lines_deferred: number; lines_open: number;
  /** Lines with 0 < issued < effective — handed over, but not in full. */
  lines_partial: number;
  /**
   * Lines that have moved ANY goods (quantity_issued > 0), whatever else is true
   * of them. The three counters above are a PARTITION — each line lands in
   * exactly one of issued / deferred / open — so a line that gave out 2 of 4 and
   * carries a promised time for the balance is filed under `deferred` and the 2
   * that physically left the store disappear from the roll-up. This is the count
   * that still sees them. It is additive: nothing reads it in place of the five
   * fields above, which badges and tab predicates depend on.
   */
  lines_issued_any: number;
  /** Σ max(0, effective − issued) over non-rejected lines. MIXED UNITS by
   *  design (each line carries its own unit), so this is only ever asked
   *  `> 0` — "is anything still owed?". Never render it as a number. */
  qty_outstanding: number;
  /** Did any line move goods today (IST)? Independent of `status`. */
  issued_today: boolean;
}

// All timestamps render in IST (Asia/Kolkata) via the shared formatter.
// Storage stays UTC; conversion happens here at display time.
const fmtDateTime = (iso: string | null) => fmtIST(iso);
const fmtNum = (v: number) => (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
// Stable empty set — passed as the default `selectedIds` so ReqCard doesn't get
// a fresh Set identity every render when a requisition has no selection yet.
const EMPTY_SET: Set<string> = new Set();

/**
 * Resolve one requisition line's UNIT BASIS and expose the purchase-unit view.
 *
 * Requisition quantities are stored in the LINE's own `unit` (option B), and the
 * two composers disagree: the internal picker stamps the PURCHASE unit, the
 * party composer stamps the RECIPE unit (and converts qty ×pack). Legacy lines
 * can be blank — read as recipe, matching what this page has always displayed.
 * The store hands over bottles/kg, so everything here READS and is ENTERED in
 * purchase units; `fromPU` converts back to the line's unit at the POST
 * boundary, because /store-issue adds the number to quantity_issued verbatim.
 */
function lineUnits(line: ReqLine) {
  const recipeUnit = line.material_unit || line.unit || '';
  const pf = packFactor({
    unit: recipeUnit,
    purchase_unit: line.material_purchase_unit,
    pack_size: line.material_pack_size,
  });
  const pu = line.material_purchase_unit || recipeUnit;
  const lu = String(line.unit || '').toLowerCase().trim();
  // Already stored in the purchase unit → no conversion in either direction.
  const isPU = pf > 1 && lu !== '' && lu === String(pu).toLowerCase().trim();
  return {
    pf, pu, recipeUnit, isPU,
    /** stored line qty → purchase-unit display figure (3 dp, display only) */
    toPU: (q: any) => isPU ? (Number(q) || 0) : Math.round(((Number(q) || 0) / pf) * 1000) / 1000,
    /** purchase-unit entry → the line's stored unit (what the API adds verbatim) */
    fromPU: (q: any) => isPU ? (Number(q) || 0) : Math.round((Number(q) || 0) * pf * 1e6) / 1e6,
    /** stored line qty → recipe units (the small "= N g" hint) */
    toRecipe: (q: any) => isPU ? (Number(q) || 0) * pf : (Number(q) || 0),
    /** MATERIAL-level qty → purchase-unit display. current_stock is ALWAYS
     *  recipe units regardless of what basis this LINE is stored in, so it must
     *  never go through toPU — that would leave a purchase-basis line's stock
     *  undivided and print grams as kilos. */
    stockPU: (q: any) => Math.round(((Number(q) || 0) / pf) * 1000) / 1000,
  };
}

export default function StoreRequisitionsPage() {
  const [list, setList] = useState<Requisition[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StoreTab>('open');
  // Issued-log state (date range, fetched separately from the queue).
  // IST, not UTC: before 05:30 IST a UTC "today" is still yesterday's date, and
  // the store opens its log expecting the day it is standing in.
  const todayStr = todayIST();
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
  // Why more than approved was handed over — recorded on the issue-history entry.
  const [issueNotes, setIssueNotes] = useState<Record<string, string>>({});
  const [editDefer, setEditDefer] = useState<Record<string, { until: string; reason: string }>>({});
  // "Issue N, defer the rest" — the gesture, captured the moment the store asks
  // for the split:
  //   qty   the hand-over quantity in the LINE's own stored unit. Held apart
  //         from editQty (a purchase-unit STRING the user keeps typing in) so
  //         the number cannot drift while the promised time is being picked.
  //   token the per-gesture idempotency token /store-issue accepts as
  //         body.client_token (route.ts:121-127). Minted HERE, not at POST time,
  //         so a re-submit of the SAME gesture carries the SAME token and the
  //         ledger's (client_token, req_item_id) index can recognise the replay.
  //         Optional by contract, and inert while requisition_deduct_at_issue is
  //         '0' — no ledger row exists to collide with, so today it changes
  //         nothing whatsoever.
  // A key here is also what turns the defer panel into the combined action.
  const [splitIssueQty, setSplitIssueQty] = useState<Record<string, { qty: number; token: string }>>({});
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
      const resolvedLines = lines.map(l => ({ l, r: resolveIssueQty(l, l.remaining) }));
      const needReason = resolvedLines.filter(x => x.r.over && x.r.note.length < 3);
      if (needReason.length > 0) {
        alert('These lines are being issued OVER what was approved — say why first:\n'
          + needReason.map(x => `• ${x.l.material_name}`).join('\n'));
        return;
      }
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: resolvedLines.map(x => ({ id: x.l.id, action: 'issue', quantity: x.r.qty, note: x.r.note })) },
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
      const todayPrefix = todayIST();
      // Pull every fulfilled req (both purposes). Party reqs live on
      // /party-approvals for the approval workflow, but once Mgmt-approved
      // they're issued from the store here too, so they belong in this log.
      const fulfilled = await fetchJson(`/api/requisitions?status=fulfilled${deptId ? `&department_id=${deptId}` : ''}`);
      const fulfilledRaw: any[] = (fulfilled.requisitions || fulfilled.list || fulfilled.items || fulfilled) as any[];
      const fulfilledToday = (fulfilledRaw || []).filter((rq: any) => {
        // fulfilled_at may be ISO ("2026-05-26T13:45:00") or SQLite ("2026-05-26 13:45:00");
        // both are UTC, so compare on the IST CALENDAR DAY rather than the raw
        // prefix — a 23:10 IST hand-over is stamped 17:40 UTC of the same date,
        // but a 01:00 IST one is stamped on the previous UTC date and a raw
        // prefix match would drop it off the store's own day.
        return fmtISTIsoDate(rq.fulfilled_at || rq.store_processed_at) === todayPrefix;
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

  // The search narrows the whole list first; matchesTab then slices it. Both the
  // body below and the tab badges read this same searched set through the same
  // predicate, so a badge can never promise rows the tab won't render.
  const searched = useMemo(() => {
    if (!search) return list;
    const q = search.toLowerCase();
    return list.filter(r => r.req_number?.toLowerCase().includes(q)
      || r.department_name?.toLowerCase().includes(q)
      || r.event_name?.toLowerCase().includes(q)
      // ...and by what is actually IN the requisition. The store person is
      // asked "who wanted the paneer?", and until now the only way to answer
      // was to expand every open card in turn. Item code = SKU (MAT-00885);
      // brand is matched too, though it is unpopulated on all 928 materials
      // today, so it contributes nothing until someone fills it in.
      || (r.items || []).some(it =>
           it.material_name?.toLowerCase().includes(q)
        || it.material_sku?.toLowerCase().includes(q)
        || (it as any).material_sku_code?.toLowerCase?.().includes(q)
        || (it as any).material_brand?.toLowerCase?.().includes(q)));
  }, [list, search]);

  const filtered = useMemo(
    () => searched.filter(r => matchesTab(r, filter)),
    [searched, filter],
  );

  const toggleRow = (id: string) => {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  /* THE one place an issue quantity is decided — used by "Issue Now" AND by
     "Issue All Items" / "Issue Selected". The bulk buttons used to post the
     approved remainder and ignore whatever the store had typed, so a store that
     handed over 10 against an approved 3 still recorded 3 whenever it used the
     big green button. Anything typed for a line now wins on every path.
     Returns the qty in the LINE's stored unit, plus whether it is an over-issue. */
  const resolveIssueQty = (line: ReqLine, outstanding: number) => {
    const U = lineUnits(line);
    const typed = editQty[line.id];
    const typedPU = Number(typed);
    const hasTyped = typed !== undefined && String(typed).trim() !== '' && Number.isFinite(typedPU);
    // Typing exactly what the row displays means "all of it" — post the exact
    // outstanding rather than a 3-dp round trip that leaves a residue.
    const saysOutstanding = hasTyped && Math.abs(typedPU - U.toPU(outstanding)) < 1e-9;
    const qty = !hasTyped || saysOutstanding ? outstanding : U.fromPU(typedPU);
    const over = qty - outstanding > 1e-9;
    // The reason belongs to an OVER-issue. Left unguarded, a reason typed for an
    // abandoned over-issue attached itself to the next within-approval issue.
    return { qty, over, note: over ? (issueNotes[line.id] || '').trim() : '' };
  };

  const issueLine = async (req: Requisition, line: ReqLine, qtyOverride?: number) => {
    const requested = effectiveQty(line);
    const outstanding = Math.max(0, requested - (line.quantity_issued || 0));
    // The box is in PURCHASE units; /store-issue adds the number to
    // quantity_issued verbatim, which lives in the LINE's own unit → convert
    // once, here. qtyOverride (programmatic) is already in the line's unit.
    //
    // TWO EXACT PATHS, because the displayed purchase figure is rounded to 3 dp
    // and fromPU(toPU(q)) !== q in general (1000 ml of a 750 ml/BTL material
    // shows as 1.333 BTL and converts back to 999.75 ml). Left uncorrected, the
    // 0.25 ml residue keeps quantity_issued under the approved qty forever: the
    // line never reaches "fully issued", the requisition never advances to
    // fulfilled, and for a party req the store→department transfer never fires.
    //   - untouched box            → issue the EXACT outstanding
    //   - typed what the row shows → issue the EXACT outstanding
    // Anything else is a deliberate different number and converts normally (and
    // is NOT clamped — issuing more than outstanding is a real thing a store
    // does, and silently truncating it would hide stock that physically left).
    const resolved = resolveIssueQty(line, outstanding);
    // Enforced HERE rather than by grey-ing the button: a disabled button with
    // no message reads as "the app ignored me", which is exactly how an
    // over-issue looked before this.
    if (qtyOverride == null && resolved.over && resolved.note.length < 3) {
      alert(`You are issuing more than was approved for ${line.material_name}.\n\n`
        + `Type a short reason in the amber box next to the quantity (at least 3 characters) — `
        + `it is recorded on the issue history so the extra stock is accounted for.`);
      return;
    }
    const qty = qtyOverride != null ? qtyOverride : resolved.qty;
    if (!qty || qty <= 0) { alert('Enter a quantity > 0'); return; }
    setBusyLine(line.id);
    try {
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: [{
          id: line.id, action: 'issue', quantity: qty,
          // Over-issue reason rides on the issue-history entry, so "why did 10
          // leave against an approved 3" is answerable from the log alone.
          note: (issueNotes[line.id] || '').trim(),
        }] },
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Issue failed'); return; }
      setEditQty(s => ({ ...s, [line.id]: '' }));
      setIssueNotes(s => { const n = { ...s }; delete n[line.id]; return n; });
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

  /* ── "Issue N, defer the rest" ───────────────────────────────────────────
     Step 1 of 2 (this function): capture WHAT is going out now and open the
     defer editor pre-filled. The store types the quantity in the same box it
     always has, in PURCHASE units; it is converted once, here, to the line's
     stored unit and parked in splitIssueQty. Nothing is POSTed yet — a defer is
     a promise about a TIME, and only a human may set it.

     It refuses the whole outstanding on purpose: with nothing left over there is
     no "rest" to defer, and silently degrading to a plain issue would leave a
     promised time hanging on a finished line. */
  const beginIssueAndDeferRest = (line: ReqLine) => {
    const U = lineUnits(line);
    const s = lineSplit(line);
    const typed = editQty[line.id];
    const typedPU = Number(typed);
    const hasTyped = typed !== undefined && String(typed).trim() !== '' && Number.isFinite(typedPU) && typedPU > 0;
    if (!hasTyped) {
      alert(`Type how much ${line.material_name} is going out NOW in the quantity box`
        + `${U.pu ? ` (in ${U.pu})` : ''}, then press this again.\n\n`
        + `The balance is what gets the promised time — so it has to be less than the `
        + `${fmtNum(U.toPU(s.outstanding))}${U.pu ? ` ${U.pu}` : ''} still outstanding.`);
      return;
    }
    const qty = U.fromPU(typedPU);
    if (qty >= s.outstanding - 1e-9) {
      alert(`${fmtNum(typedPU)}${U.pu ? ` ${U.pu}` : ''} is the whole outstanding quantity — `
        + `there is no balance left to defer.\n\nUse "Issue Now" for that.`);
      return;
    }
    setSplitIssueQty(p => ({ ...p, [line.id]: { qty, token: gestureToken() } }));
    setEditDefer(p => ({ ...p, [line.id]: { until: defaultDefer(), reason: '' } }));
  };

  /* Step 2 of 2: ONE POST, ONE transaction — hand part of the line over and put
     the promised time on the balance. Before this the store had to issue, watch
     the row drop out of the open list, hunt it down and defer it separately.

     ORDER IS LOAD-BEARING. /store-issue walks `lines` in array order, and its
     'issue' branch clears the deferred fields — historically always (its
     `updIssue` statement), and now only when the line ends up fully satisfied
     (`updIssuePartial`, see "THE DEFER RULE (half-transfer)" in that route's
     header). A defer written FIRST would be wiped by the issue that follows it.
     Issue-then-defer lands in the same final state under BOTH readings, which is
     why this ordering is not conditional on that change. Nothing here duplicates
     it: the client never decides whether a defer survives, it just orders the
     two actions so it never has to ask. The route re-reads each line inside its
     own transaction, so the second entry for this same line id sees the first. */
  const issueAndDeferRest = async (req: Requisition, line: ReqLine) => {
    const gesture = splitIssueQty[line.id];
    const qty = gesture?.qty as number;
    const cfg = editDefer[line.id];
    const U = lineUnits(line);
    const s = lineSplit(line);
    if (!Number.isFinite(qty) || !(qty > 0)) { alert('Nothing captured to issue — start again.'); return; }
    if (qty >= s.outstanding - 1e-9) {
      alert('The outstanding quantity changed — there is no balance left to defer. Refresh and try again.');
      return;
    }
    if (!cfg?.until) { alert('Pick the date/time you can issue the balance'); return; }
    const restPU = fmtNum(U.toPU(s.outstanding - qty));
    setBusyLine(line.id);
    try {
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { client_token: gesture.token, lines: [
          { id: line.id, action: 'issue', quantity: qty, note: (issueNotes[line.id] || '').trim() },
          { id: line.id, action: 'defer', defer_until: cfg.until,
            // A defer with no words on it reads as "forgotten" three hours later.
            // Say what the promise is FOR when the store didn't.
            reason: (cfg.reason || '').trim()
              || `Balance ${restPU}${U.pu ? ` ${U.pu}` : ''} to follow` },
        ] },
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Issue + defer failed'); return; }
      setEditQty(sm => ({ ...sm, [line.id]: '' }));
      setIssueNotes(sm => { const n = { ...sm }; delete n[line.id]; return n; });
      setEditDefer(sm => { const n = { ...sm }; delete n[line.id]; return n; });
      setSplitIssueQty(sm => { const n = { ...sm }; delete n[line.id]; return n; });
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
      const resolvedLines = lines.map(l => ({ l, r: resolveIssueQty(l, l.remaining) }));
      const needReason = resolvedLines.filter(x => x.r.over && x.r.note.length < 3);
      if (needReason.length > 0) {
        alert('These lines are being issued OVER what was approved — say why first:\n'
          + needReason.map(x => `• ${x.l.material_name}`).join('\n'));
        return;
      }
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: resolvedLines.map(x => ({ id: x.l.id, action: 'issue', quantity: x.r.qty, note: x.r.note })) },
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
      <TabScroller className="gap-2 text-xs">
        {([
          { k: 'open',             label: 'Pending Issue',    icon: AlertCircle, tone: 'amber' },
          { k: 'deferred',         label: 'Deferred',         icon: Clock,       tone: 'blue' },
          // Balance Pending covers BOTH shapes of "we still owe them something":
          // a single line handed over in pieces (asked 4, gave 2), and whole
          // lines issued complete while others were never touched.
          //
          // There used to be a separate Part-Issued tab for the first shape.
          // It was removed on the owner's call: it was a strict SUBSET of this
          // one — a split line always leaves an outstanding quantity — so the
          // two counts moved together and nobody could tell them apart. The
          // split itself is not lost; it is named on the row by partialSummary
          // ("1 of 2 kg issued — 1 kg deferred"), which is where a storekeeper
          // actually reads it.
          { k: 'balance_pending',  label: 'Balance Pending',  icon: Hourglass,   tone: 'rose' },
          { k: 'issued_today',     label: 'Issued Today',     icon: CheckCircle2,tone: 'emerald' },
          { k: 'issued_log',       label: 'Issued Items Log', icon: History,     tone: 'amber' },
        ] as const).map(t => {
          // ONE source for the badge — the same predicate the body filters with.
          // These used to be re-written inline here, so changing a tab's meaning
          // in one place left the badge promising rows the tab wouldn't render.
          // (The Issued Items Log isn't a requisition view; it counts its own events.)
          const n = t.k === 'issued_log'
            ? (log?.totals?.events || 0)
            : searched.filter(r => matchesTab(r, t.k)).length;
          const active = filter === t.k;
          const Icon = t.icon;
          const onStyle: Record<string, string> = {
            amber: active ? 'bg-amber-600 text-white border-amber-600' : 'bg-amber-50 text-amber-800 border-amber-200',
            blue:  active ? 'bg-blue-600  text-white border-blue-600'  : 'bg-blue-50  text-blue-800  border-blue-200',
            emerald: active ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-emerald-50 text-emerald-800 border-emerald-200',
            rose: active ? 'bg-rose-600 text-white border-rose-600' : 'bg-rose-50 text-rose-800 border-rose-200',
            violet: active ? 'bg-violet-600 text-white border-violet-600' : 'bg-violet-50 text-violet-800 border-violet-200',
          };
          return (
            <button key={t.k} onClick={() => setFilter(t.k)}
                    className={`px-3 py-1.5 rounded border flex items-center gap-1.5 ${onStyle[t.tone]}`}>
              <Icon className="w-3.5 h-3.5" /> {t.label} <span className="font-mono">{n}</span>
            </button>
          );
        })}
      </TabScroller>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 bg-white border border-[#E8D5C4] rounded-xl p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-2 top-2 text-[#8B7355]" />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Search req# / department / event / item name / SKU…"
                 className="w-full pl-8 pr-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </div>
        <select value={deptId} onChange={e => setDeptId(e.target.value)}
                className="px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] min-w-[160px]">
          <option value="">All departments</option>
          {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}

      {/* Tab body — Issued Log gets its own panel, the other four share the requisition list. */}
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
          {filter === 'deferred' && 'No items promised for a later time.'}
          {filter === 'balance_pending' && 'No balances owed — every issued requisition went out in full.'}
          {filter === 'issued_today' && 'Nothing has been handed over today yet.'}
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
                     issueNotes={issueNotes} setIssueNotes={setIssueNotes}
                     setEditQty={setEditQty}
                     editDefer={editDefer}
                     setEditDefer={setEditDefer}
                     splitIssueQty={splitIssueQty}
                     setSplitIssueQty={setSplitIssueQty}
                     onBeginIssueDeferRest={(line) => beginIssueAndDeferRest(line)}
                     onIssueDeferRest={(line) => issueAndDeferRest(req, line)}
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
          resolveQty={(line, remaining) => resolveIssueQty(line, remaining)}
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
function IssueAllModal({ req, resolveQty, busy, onCancel, onConfirm }: {
  req: Requisition;
  /** The SAME resolver the POST uses — the list must show what will be issued,
      not the approved remainder, or the confirmation lies about an over-issue. */
  resolveQty: (line: ReqLine, remaining: number) => { qty: number; over: boolean; note: string };
  busy: boolean; onCancel: () => void; onConfirm: () => void;
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
                const U = lineUnits(l);
                const u = U.pu;
                const rq = resolveQty(l, l.remaining);
                return (
                  <li key={l.id} className="flex items-center justify-between text-sm border-b border-[#E8D5C4]/50 py-1.5">
                    <span className="text-[#2D1B0E]">{l.material_name}</span>
                    <span className="font-mono font-semibold text-emerald-700">
                      × {fmtNum(U.toPU(rq.qty))}{u && <span className="text-[10px] text-[#8B7355] ml-0.5">{u}</span>}
                      {U.pf > 1 && <span className="text-[9px] text-[#B8A590] ml-1">= {fmtNum(U.toRecipe(rq.qty))} {U.recipeUnit}</span>}
                      {rq.over && (
                        <span className="ml-1 text-[9px] px-1 rounded bg-amber-100 text-amber-800 border border-amber-300">
                          over approved ({fmtNum(U.toPU(l.remaining))} {u})
                        </span>
                      )}
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
 * ONE line's quantity, split three ways. THE unit basis is the LINE's own stored
 * `unit` (option B) for every figure here — nothing is converted. Push each part
 * through lineUnits() at the point it is displayed, exactly as the row's other
 * quantities already are.
 *
 *   issued    — what physically left the store (quantity_issued). NOT capped at
 *               `effective`: an over-issue is a real event the store records as
 *               what actually went, and clamping it here would quietly hide it.
 *   deferred  — the part of the remainder a human has promised a time for.
 *   open      — the part of the remainder nobody has promised anything about.
 *
 * WHY THIS IS THE WHOLE FIX: the store's real answer to "issue 4 kg?" is often
 * "2 now, 2 at 7pm", and the line has only ever been able to land WHOLLY in one
 * bucket — deferring it filed it as 1 deferred / 0 issued and the 2 kg that left
 * the counter became invisible. Split into three parts they are all sayable.
 *
 * `deferred` and `open` are mutually exclusive TODAY, because deferred_until is
 * a flag on the whole line: set, and the entire remainder is the promise; unset,
 * and the entire remainder is open. That is a property of the schema, not an
 * assumption baked in here — the shape stays correct if a per-quantity defer
 * ever lands, and every caller renders whichever parts are non-zero.
 */
/**
 * Red / Amber / Green on the store's in-hand quantity.
 *
 * The bands are about THIS hand-over, not a generic reorder alert — the
 * question at the counter is "can I give what is being asked for", so the
 * outstanding quantity is the yardstick:
 *
 *   RED    nothing on the shelf, or less than this line still needs
 *   AMBER  enough for this line, but the shelf drops to or below the reorder
 *          point once it goes out
 *   GREEN  enough, and still above the reorder point afterwards
 *
 * A material with no reorder_level set can never be amber — there is no
 * threshold to cross — so it reads green whenever it covers the line. Saying
 * amber there would be inventing a judgement nobody configured.
 *
 * All quantities are RECIPE units, the basis current_stock is stored in.
 */
function stockLevel(line: ReqLine): {
  qty: number | null; dot: string; text: string; title: string;
} {
  const raw = (line as any).current_stock;
  if (raw == null) return { qty: null, dot: '', text: '', title: '' };
  const qty = Number(raw) || 0;
  const need = Math.max(0, effectiveQty(line) - (Number(line.quantity_issued) || 0));
  const reorder = Number(line.reorder_level) || 0;

  if (qty <= 0 || qty < need) {
    return {
      qty, dot: 'bg-red-500', text: 'text-red-700 font-semibold',
      title: qty <= 0 ? 'Out of stock in the store' : 'Short — less on the shelf than this line still needs',
    };
  }
  if (reorder > 0 && qty - need <= reorder) {
    return {
      qty, dot: 'bg-amber-500', text: 'text-amber-700',
      title: 'Enough for this line, but the store drops to its reorder point once it goes out',
    };
  }
  return { qty, dot: 'bg-emerald-500', text: 'text-[#6B5744]', title: 'In stock' };
}

function lineSplit(line: ReqLine): {
  effective: number; issued: number; outstanding: number;
  deferred: number; open: number; isSplit: boolean;
} {
  const effective = effectiveQty(line);
  const issued = Math.max(0, Number(line.quantity_issued) || 0);
  const outstanding = Math.max(0, effective - issued);
  const promised = !!line.deferred_until;
  return {
    effective, issued, outstanding,
    deferred: promised ? outstanding : 0,
    open:     promised ? 0 : outstanding,
    // The owner's case in one boolean: goods went out AND goods are still owed,
    // on the SAME line.
    isSplit: issued > 0 && outstanding > 0,
  };
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

/**
 * Did this line hand goods over on `dayIST`?
 *
 * issue_history is the per-hand-over log written by /store-issue. The one-shot
 * /store-process path writes quantity_issued with NO history entry and no
 * issued_at, so the requisition's own store_processed_at stamp is the only date
 * that hand-over has — used last, and only for a line that did move something.
 */
function issuedOnDay(line: ReqLine, reqStamp: unknown, dayIST: string): boolean {
  if ((Number(line.quantity_issued) || 0) <= 0) return false;
  let history: unknown[] = [];
  try { const p: unknown = JSON.parse(line.issue_history || '[]'); if (Array.isArray(p)) history = p; } catch { /* corrupt JSON reads as no history */ }
  if (history.length > 0) return history.some(h => fmtISTIsoDate((h as { at?: unknown } | null)?.at) === dayIST);
  if (line.issued_at) return fmtISTIsoDate(line.issued_at) === dayIST;
  return fmtISTIsoDate(reqStamp) === dayIST;
}

function mergeStats(req: any): Requisition {
  const items: ReqLine[] = req.items || [];
  const today = todayIST();
  const reqStamp = req.fulfilled_at || req.store_processed_at || null;
  let issued = 0, deferred = 0, open = 0, partial = 0, outstanding = 0;
  // Counted ALONGSIDE the partition above, never instead of it — the five
  // existing fields are what the header badges and every tab predicate read.
  let issuedAny = 0;
  let issuedToday = false;
  for (const it of items) {
    if (it.is_rejected) continue;
    if (it.store_rejected) continue;      // store rejected — not counted as open/issued/deferred
    const eff = effectiveQty(it);
    const got = Number(it.quantity_issued) || 0;
    if (got >= eff && !it.deferred_until) issued++;
    else if (it.deferred_until) deferred++;
    else open++;
    // A part-issued line is NOT the same as an untouched one — it used to be
    // filed as `open` above, which is why "some of it went out" was invisible.
    if (got > 0 && got < eff) partial++;
    // "Did goods leave the store on this line?" — the question the partition
    // cannot answer, because a part-issued DEFERRED line answers `deferred` to
    // it and `lines_issued` stays 0. Deliberately not gated on `got < eff` or on
    // deferred_until: it counts hand-overs, not completeness.
    if (got > 0) issuedAny++;
    outstanding += Math.max(0, eff - got);
    if (!issuedToday && issuedOnDay(it, reqStamp, today)) issuedToday = true;
  }
  return {
    ...req,
    items,
    total_lines: items.length,
    lines_issued: issued,
    lines_deferred: deferred,
    lines_open: open,
    lines_partial: partial,
    lines_issued_any: issuedAny,
    qty_outstanding: outstanding,
    issued_today: issuedToday,
  } as Requisition;
}

/** The queue tabs. 'issued_log' is a separate panel, not a slice of the list. */
type StoreTab = 'open' | 'deferred' | 'balance_pending' | 'issued_today' | 'issued_log';

/**
 * THE definition of every tab — called by the tab body AND by the tab badges.
 *
 * These are roll-ups of the LINE columns, not readings of requisitions.status
 * (which is a single scalar and cannot say "issued some, owes the rest"), so a
 * requisition can match more than one tab. That is the point: a half-issued req
 * belongs in Issued Today *and* Balance Pending.
 *
 * 'deferred' stays strictly "a human promised a time on this line"
 * (deferred_until) — it is NOT the generic "something is still owed" bucket,
 * because a deferred line also suppresses Issue All and the selection checkbox.
 */
function matchesTab(r: Requisition, tab: StoreTab): boolean {
  switch (tab) {
    case 'open':            return r.status !== 'fulfilled' && r.lines_open > 0;
    case 'deferred':        return r.lines_deferred > 0;
    // NOTE: there is no 'part_issued' case any more. A split line
    // (0 < issued < effective) always leaves an outstanding quantity, so it
    // already matches 'balance_pending' below — the two tabs were never
    // independent, and their counts moved together. lines_partial is still
    // computed and still drives the row chip; it just no longer earns a tab.
    // Goods went out, goods are still owed, and the req is not closed — the
    // half-transfer bucket. The "something was actually handed over" clause is
    // what makes this tab DISTINCT: without it every untouched requisition
    // (nothing issued, therefore everything outstanding) matches too and the
    // tab becomes a copy of Pending Issue.
    case 'balance_pending':
      return r.status !== 'fulfilled'
        && r.qty_outstanding > 0
        && (r.lines_issued > 0 || r.lines_partial > 0);
    // "Goods moved today", NOT "requisition closed" — the two are different
    // events and this tab used to conflate them under the name "Fulfilled Today".
    case 'issued_today':    return r.status === 'fulfilled' || r.issued_today;
    default:                return false;
  }
}

/**
 * Requisition status in the department's words. Same vocabulary as the sister
 * page /requisitions (its STATUS_LABEL) — kept as a local map rather than an
 * import so this page doesn't pull a 2,000-line page module into its bundle for
 * a handful of strings. Keep the wording in step with that page.
 *
 * ONE deliberate difference: chef_approved reads 'With Store' here, not 'With
 * Mgmt'. Anything chef_approved that reaches THIS page reached it through the
 * inbox=store query — it is, by definition, sitting on the store's counter.
 */
const STATUS_LABEL: Record<string, string> = {
  draft:           'Draft',
  submitted:       'With HOD',
  chef_approved:   'With Store',
  mgmt_approved:   'With Store',
  chef_rejected:   'Rejected',
  store_processed: 'Issued (partial)',
  fulfilled:       'Fulfilled',
  cancelled:       'Cancelled',
};

/**
 * Header summary for a part-issued requisition, in PURCHASE units (the store
 * hands over bottles and packets, not millilitres).
 *
 * One part-issued line reads as real numbers — "4 of 6 BTL issued". Two or more
 * can't be added up: each line carries its own unit, so a sum would be a
 * meaningless number presented as a fact. Those report the count and leave the
 * quantities to the expanded rows.
 *
 * BOTH shapes now name WHERE THE BALANCE SAT when the store walked away, because
 * "4 of 6 BTL issued" is only half the sentence: it never said whether someone
 * promised the other 2 for 7pm or whether they are simply unhandled. The
 * single-line form says the balance in the same purchase unit as the lead; the
 * many-line form counts them, since the units still cannot be added.
 */
function partialSummary(req: Requisition): string | null {
  const partials = (req.items || []).filter(l => {
    if (l.is_rejected || l.store_rejected) return false;
    const got = Number(l.quantity_issued) || 0;
    return got > 0 && got < effectiveQty(l);
  });
  if (partials.length === 0) return null;
  if (partials.length > 1) {
    const promised = partials.filter(l => !!l.deferred_until).length;
    const tail = promised === 0            ? 'balances still open'
               : promised === partials.length ? 'balances deferred'
               : `${promised} deferred, ${partials.length - promised} still open`;
    return `${partials.length} items part-issued — ${tail}`;
  }
  const l = partials[0];
  const U = lineUnits(l);
  const s = lineSplit(l);
  // s.deferred / s.open are mutually exclusive per line (deferred_until is a
  // line flag), so exactly one of these two sentences is the true one.
  const balance = s.deferred > 0
    ? `${fmtNum(U.toPU(s.deferred))}${U.pu ? ` ${U.pu}` : ''} deferred`
    : `${fmtNum(U.toPU(s.open))}${U.pu ? ` ${U.pu}` : ''} still open`;
  return `${fmtNum(U.toPU(s.issued))} of ${fmtNum(U.toPU(s.effective))}${U.pu ? ` ${U.pu}` : ''} issued — ${balance}`;
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
  issueNotes: Record<string, string>; setIssueNotes: (f: any) => void;
  editDefer: Record<string, { until: string; reason: string }>;
  setEditDefer: (f: any) => void;
  // "Issue N, defer the rest" — the captured gesture per line + its two steps.
  splitIssueQty: Record<string, { qty: number; token: string }>;
  setSplitIssueQty: (f: any) => void;
  onBeginIssueDeferRest: (line: ReqLine) => void;
  onIssueDeferRest: (line: ReqLine) => void;
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
  const partialText = partialSummary(req);
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
        {/* flex-wrap because this row now carries up to six chips — the store's
            tablet was squeezing the requisition number to make them all fit on
            one line. */}
        <div className="flex flex-wrap justify-end items-center gap-2 text-[11px]">
          {req.lines_issued > 0 && <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">{req.lines_issued} issued</span>}
          {req.lines_deferred > 0 && <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">{req.lines_deferred} deferred</span>}
          {req.lines_open > 0 && <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">{req.lines_open} open</span>}
          {/* Lines that DID hand goods over but are not counted in "N issued" —
              part-issued, or fully issued with a promise still parked on them.
              The three counters above partition each line into one bucket, so
              without this the 2 kg that left the counter on a deferred line is
              nowhere on the card. Purely additive: it reads lines_issued_any and
              changes none of them. */}
          {req.lines_issued_any > req.lines_issued && (
            <span title="Goods went out on these lines, but they are still owed (part-issued, or deferred with a promised time)"
                  className="px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200">
              {req.lines_issued_any - req.lines_issued} sent, not closed
            </span>
          )}
          {/* What actually went out, in the store's own units. The card used to
              print the raw column value ("store_processed") at the person
              holding the goods and say nothing about the shortfall. */}
          {partialText && (
            <span className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">{partialText}</span>
          )}
          <span className={`px-2 py-0.5 rounded border ${statusTone[req.status] || 'bg-gray-50 text-gray-700 border-gray-200'}`}>
            {STATUS_LABEL[req.status] || req.status}
          </span>
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
                {/* All four quantity columns read in the PURCHASE unit (BTL / kg /
                    PKT), with the recipe equivalent as the small grey hint under
                    packed materials. This tooltip used to say "recipe unit", which
                    is exactly how the store was reading the numbers. */}
                <th className="text-right py-1.5 px-2 font-medium" title="Quantity requested, in the PURCHASE unit (BTL / kg / PKT / pcs). The small grey line is the recipe equivalent.">Requested</th>
                <th className="text-right py-1.5 px-2 font-medium" title="What the STORE holds right now, in the PURCHASE unit. Red = nothing, or less than this line still needs. Amber = enough, but the store hits its reorder point once it goes out. Green = enough to spare.">In hand</th>
                <th className="text-right py-1.5 px-2 font-medium" title="HOD-approved quantity, in the PURCHASE unit (overrides requested if set)">HOD OK</th>
                <th className="text-right py-1.5 px-2 font-medium" title="Handed over so far, in the PURCHASE unit">Issued so far</th>
                <th className="text-right py-1.5 px-2 font-medium" title="Still owed, in the PURCHASE unit">Outstanding</th>
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
                         issueNotes={props.issueNotes} setIssueNotes={props.setIssueNotes}
                         editDefer={props.editDefer} setEditDefer={props.setEditDefer}
                         splitIssueQty={props.splitIssueQty} setSplitIssueQty={props.setSplitIssueQty}
                         onBeginIssueDeferRest={props.onBeginIssueDeferRest}
                         onIssueDeferRest={props.onIssueDeferRest}
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
  issueNotes: Record<string, string>; setIssueNotes: (f: any) => void;
  editDefer: Record<string, { until: string; reason: string }>;
  setEditDefer: (f: any) => void;
  // "Issue N, defer the rest". A key in splitIssueQty for this line means the
  // defer panel below is showing the COMBINED action, not a plain defer.
  splitIssueQty: Record<string, { qty: number; token: string }>;
  setSplitIssueQty: (f: any) => void;
  onBeginIssueDeferRest: (line: ReqLine) => void;
  onIssueDeferRest: (line: ReqLine) => void;
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
  // The same three numbers as above, named — split.effective / .issued /
  // .outstanding are identical to eff / issued / outstanding by construction;
  // what it adds is WHICH BUCKET the remainder sits in. eff, issued and
  // outstanding stay in place because the over-issue maths below reads them.
  const split = lineSplit(line);
  // Everything reads in PURCHASE units (owner rule) — the store hands over
  // bottles/kg, not ml/g — regardless of which unit the composer stored the
  // line in. `hint` carries the recipe equivalent for packed materials.
  const U = lineUnits(line);
  const u = U.pu;
  const unitTag = u ? <span className="text-[9px] text-[#8B7355] ml-0.5">{u}</span> : null;
  // Suppressed at q = 0: "= 0 ml" under a "0 BTL" says nothing, and it used to
  // appear on every fully-issued row's Outstanding cell. Gate on the STORED qty,
  // not the 3-dp purchase figure — a 0.25 ml residue shows "<0.001 BTL" up top
  // and its hint is the only place the real remainder is legible.
  const hint = (q: number) => U.pf > 1 && (Number(q) || 0) > 0
    ? <div className="text-[9px] text-[#B8A590] font-normal">= {fmtNum(U.toRecipe(q))} {U.recipeUnit}</div>
    : null;
  const outstandingPU = U.toPU(outstanding);
  // A remainder smaller than the 3-dp display (e.g. 0.25 ml of a 750 ml bottle)
  // would print a flat "0" on a line the card still counts as OPEN. Say "<0.001"
  // instead, so the row never claims to be finished when it isn't.
  const puNum = (v: number, raw: number) =>
    v === 0 && raw > 0 ? '<0.001' : fmtNum(v);
  /* OVER-ISSUE — the store handed over more than the HOD approved. It is a real
     thing (a bag is a bag), so it is recorded as what actually left, not capped
     to the approval; it just has to be deliberate and explained. Compared in the
     PURCHASE basis the box is typed in. */
  const typedPU = Number(props.editQty[line.id]);
  // Only meaningful while the line is still open — on a completed line
  // outstanding is 0, so any leftover text in the box read as an "over-issue".
  const overIssue = outstanding > 0 && Number.isFinite(typedPU) && typedPU - outstandingPU > 1e-9;
  const overBy = overIssue ? Math.round((typedPU - outstandingPU) * 1000) / 1000 : 0;
  const rowTone = line.is_rejected ? 'bg-red-50/40 text-[#999] line-through'
                : line.store_rejected ? 'bg-red-50/40 text-[#999]'
                : outstanding === 0 && !line.deferred_until ? 'bg-emerald-50/30'
                : line.deferred_until ? 'bg-blue-50/30' : '';
  const deferOpen = !!props.editDefer[line.id];
  /* "Issue N, defer the rest" — two derived states.
     `splitQty` is the hand-over quantity already captured (in the LINE's stored
     unit), which is what turns the defer panel below into the combined action.
     `typedIsPartial` drives the button's live label BEFORE that: it is true only
     while the box holds a genuine PART of what is still owed, so the button can
     say the actual numbers instead of a generic promise. */
  const splitQty = props.splitIssueQty[line.id]?.qty;
  const splitMode = deferOpen && Number.isFinite(splitQty) && splitQty > 0;
  const splitRest = splitMode ? Math.max(0, outstanding - splitQty) : 0;
  const typedIsPartial = Number.isFinite(typedPU) && typedPU > 0 && outstandingPU - typedPU > 1e-9;
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
      <td className="py-1.5 px-2 text-right font-mono">
        {fmtNum(U.toPU(line.quantity_requested))}{unitTag}
        {hint(line.quantity_requested)}
      </td>
      {/* IN-HAND — what the store can actually give, read at the moment of
          deciding. Without it the storekeeper approved a hand-over blind and
          found out at the shelf. current_stock is RECIPE units (material-level),
          so it converts with stockPU, never the line-basis toPU. */}
      <td className="py-1.5 px-2 text-right font-mono">
        {(() => {
          const st = stockLevel(line);
          if (st.qty == null) return <span className="text-[#C0A98F]">—</span>;
          return (
            <span title={st.title}>
              <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle ${st.dot}`} />
              <span className={st.text}>{fmtNum(U.stockPU(st.qty))}{unitTag}</span>
              {U.pf > 1 && (
                <div className="text-[9px] text-[#B8A590] font-normal">= {fmtNum(st.qty)} {U.recipeUnit}</div>
              )}
            </span>
          );
        })()}
      </td>
      <td className="py-1.5 px-2 text-right font-mono">
        {line.is_rejected
          ? <span className="text-red-600">rejected</span>
          : line.chef_approved_qty != null
            ? <>
                <span className="text-amber-700">{fmtNum(U.toPU(line.chef_approved_qty))}{unitTag}</span>
                {hint(line.chef_approved_qty)}
              </>
            : '—'}
      </td>
      {/* Issued so far carries the recipe hint too — without it this cell was the
          odd one out on a row whose other three quantities all showed one. */}
      <td className="py-1.5 px-2 text-right font-mono">
        {puNum(U.toPU(issued), issued)}{unitTag}
        {hint(issued)}
      </td>
      {/* OUTSTANDING, split by who owes what.
          The total stays the lead — the column header and its tooltip promise
          "still owed", and that number is still the answer. Under it, when the
          line has actually been divided, the remainder is named: DEFERRED (a
          human put a time on it) or OPEN (nobody has). Before this the two were
          the same figure, so "2 kg issued, 2 kg promised for 7pm" and "2 kg
          issued, 2 kg nobody has touched" printed identically.
          A line that has moved nothing and carries no promise renders exactly as
          it always did — no extra markup, no second figure. Both parts lead with
          the PURCHASE unit (unitTag = U.pu) and carry the recipe hint. */}
      <td className="py-1.5 px-2 text-right font-mono font-semibold">
        <span className={outstanding === 0 ? 'text-emerald-700' : 'text-[#af4408]'}>{puNum(outstandingPU, outstanding)}{unitTag}</span>
        {hint(outstanding)}
        {(split.isSplit || split.deferred > 0) && (
          <>
            {split.deferred > 0 && (
              <div className="mt-0.5 font-normal text-[10px] text-blue-700">
                Deferred {puNum(U.toPU(split.deferred), split.deferred)}{unitTag}
                {hint(split.deferred)}
              </div>
            )}
            {split.open > 0 && (
              <div className="mt-0.5 font-normal text-[10px] text-[#af4408]">
                Open {puNum(U.toPU(split.open), split.open)}{unitTag}
                {hint(split.open)}
              </div>
            )}
          </>
        )}
      </td>
      <td className="py-1.5 px-2 align-top text-[10px] text-[#6B5744]">
        {line.issued_at ? (
          <>
            <div>{fmtDateTime(line.issued_at)}</div>
            <div className="text-[#8B7355]">by {line.issued_by}</div>
          </>
        ) : '—'}
        {/* PREVIOUS hand-over of this MATERIAL, on some other requisition.
            The line above answers "what happened on this line"; this answers
            "when did this item last leave the store, and how much" — which is
            what tells the storekeeper a department is asking again three days
            early. Quantity is in that PREVIOUS line's own unit (Option B), so
            it is printed with the unit that came with it rather than being
            converted through this row's resolver, which would be a different
            basis. Absent for a material that has never gone out. */}
        {line.mat_last_issue_at && (
          <div className="mt-1 pt-1 border-t border-[#E8D5C4]/60 text-[9px] text-[#8B7355]"
               title="The last time this item was issued on another requisition">
            prev: {fmtDateTime(line.mat_last_issue_at)}
            {Number(line.mat_last_issue_qty) > 0 && (
              <> · {fmtNum(Number(line.mat_last_issue_qty))} {String(line.mat_last_issue_unit || U.recipeUnit)}</>
            )}
            {line.mat_last_issue_dept && <> → {line.mat_last_issue_dept}</>}
          </div>
        )}
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
                {/* NO max — the store can physically hand over more than was
                    approved, and the number here must be what actually left the
                    store. A max= capped the spinner at the approved qty and made
                    a genuine over-issue look impossible, so 10 given against 3
                    approved got recorded as 3. Over-issues are allowed, flagged
                    and reasoned (below) rather than quietly trimmed. */}
                <input type="number" step="any" min={0}
                       value={props.editQty[line.id] ?? ''}
                       onChange={e => props.setEditQty((s: any) => ({ ...s, [line.id]: e.target.value }))}
                       placeholder={String(puNum(outstandingPU, outstanding))}
                       title={`Issue in ${u || 'units'} (purchase unit) — outstanding ${puNum(outstandingPU, outstanding)}${u ? ' ' + u : ''}`
                              + (U.pf > 1 ? ` (= ${fmtNum(U.toRecipe(outstanding))} ${U.recipeUnit})` : '')
                              + '. You may issue more than approved — say why when you do.'}
                       className={`w-16 px-1 py-0.5 border rounded text-right text-xs ${
                         overIssue ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4] bg-[#FFF8F0]'}`} />
                {u && <span className="text-[10px] text-[#6B5744] font-medium">{u}</span>}
                <button onClick={() => props.onIssue(line)}
                        disabled={busy}
                        title={overIssue ? 'Issuing more than approved — a short reason is required' : undefined}
                        className="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[10px] flex items-center gap-1 disabled:opacity-50">
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  Issue Now
                </button>
                <button onClick={() => props.setEditDefer((s: any) => ({ ...s, [line.id]: { until: defaultDefer(), reason: '' } }))}
                        className="px-2 py-0.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded text-[10px] flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Defer
                </button>
                {/* THE SPLIT. Issue what is physically on the shelf and promise
                    the balance in the same gesture — one POST, one transaction,
                    one row in the history. Doing it as Issue-then-Defer left the
                    line out of the open list between the two clicks, and the
                    store had to go and find it again. The label carries the real
                    numbers as soon as the box holds a partial quantity, so the
                    button says exactly what it is about to do. */}
                <button onClick={() => props.onBeginIssueDeferRest(line)} disabled={busy}
                        title="Hand over part of this line now and put a promised time on the balance — one action, recorded as both"
                        className="px-2 py-0.5 bg-violet-50 hover:bg-violet-100 text-violet-700 border border-violet-200 rounded text-[10px] flex items-center gap-1 disabled:opacity-50">
                  <Split className="w-3 h-3" />
                  {typedIsPartial
                    ? <>Issue {fmtNum(typedPU)} {u}, defer {fmtNum(Math.round((outstandingPU - typedPU) * 1000) / 1000)} {u}</>
                    : <>Issue part, defer rest</>}
                </button>
                {/* Store rejection — distinct from the chef's. Prompts for a reason. */}
                <button onClick={() => props.onReject(line)} disabled={busy}
                        title="Store cannot fulfil this line (discontinued / wrong item)"
                        className="px-2 py-0.5 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded text-[10px] flex items-center gap-1 disabled:opacity-50">
                  <XCircle className="w-3 h-3" /> Reject
                </button>
              </>
            )}
            {overIssue && !deferOpen && (
              <div className="w-full flex flex-col sm:flex-row sm:items-center gap-1 bg-amber-50 border border-amber-300 rounded px-1.5 py-1">
                <span className="text-[10px] text-amber-900 shrink-0">
                  <AlertCircle className="w-3 h-3 inline mr-0.5 -mt-0.5" />
                  {/* Say ALL the numbers. The first version called `outstanding`
                      "approved", so a line approved for 4 kg with 3 kg already
                      issued read "2 kg more than approved (1 kg)" — which looks
                      like the approval was 1 kg. It never was. */}
                  Only {fmtNum(outstandingPU)} {u} is still open — {fmtNum(U.toPU(issued))} of {fmtNum(U.toPU(eff))} {u} already issued.
                  {' '}Handing over {fmtNum(typedPU)} {u} takes the total to <b>{fmtNum(U.toPU(issued) + typedPU)} {u}</b>,
                  {' '}which is {fmtNum(overBy)} {u} over the {fmtNum(U.toPU(eff))} {u} approved.
                </span>
                <input value={props.issueNotes[line.id] || ''}
                       onChange={e => props.setIssueNotes((s: any) => ({ ...s, [line.id]: e.target.value }))}
                       placeholder="Why more than approved? e.g. full 10 kg bag, cannot split"
                       className="flex-1 min-w-0 px-1.5 py-0.5 border border-amber-400 rounded text-[10px] bg-white" />
              </div>
            )}
            {deferOpen && (
              // The SAME editor serves both actions. In split mode it is tinted
              // violet, states the two quantities it is about to record, and its
              // save button performs the combined issue+defer; otherwise it is
              // the plain defer it has always been, unchanged.
              <div className={`flex flex-wrap items-center gap-1 border rounded px-1.5 py-1 ${
                splitMode ? 'bg-violet-50 border-violet-200' : 'bg-blue-50 border-blue-200'}`}>
                {splitMode && (
                  <span className="w-full sm:w-auto text-[10px] text-[#6B5744] shrink-0">
                    Handing over <b className="text-emerald-700">{fmtNum(U.toPU(splitQty))} {u}</b> now
                    {U.pf > 1 && <span className="text-[9px] text-[#B8A590] ml-0.5">= {fmtNum(U.toRecipe(splitQty))} {U.recipeUnit}</span>}
                    , the balance <b className="text-violet-700">{fmtNum(U.toPU(splitRest))} {u}</b>
                    {U.pf > 1 && <span className="text-[9px] text-[#B8A590] ml-0.5">= {fmtNum(U.toRecipe(splitRest))} {U.recipeUnit}</span>}
                    {' '}is promised for
                  </span>
                )}
                <input type="datetime-local" value={props.editDefer[line.id]?.until || ''}
                       onChange={e => props.setEditDefer((s: any) => ({ ...s, [line.id]: { ...s[line.id], until: e.target.value } }))}
                       className={`px-1 py-0.5 border rounded text-[10px] bg-white ${splitMode ? 'border-violet-200' : 'border-blue-200'}`} />
                <input type="text" placeholder="reason (optional)"
                       value={props.editDefer[line.id]?.reason || ''}
                       onChange={e => props.setEditDefer((s: any) => ({ ...s, [line.id]: { ...s[line.id], reason: e.target.value } }))}
                       className={`w-32 px-1 py-0.5 border rounded text-[10px] bg-white ${splitMode ? 'border-violet-200' : 'border-blue-200'}`} />
                {splitMode ? (
                  <button onClick={() => props.onIssueDeferRest(line)} disabled={busy}
                          title="Records the hand-over AND the promised time in one transaction"
                          className="px-2 py-0.5 bg-violet-600 hover:bg-violet-700 text-white rounded text-[10px] disabled:opacity-50 flex items-center gap-1">
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Split className="w-3 h-3" />}
                    Issue &amp; defer balance
                  </button>
                ) : (
                  <button onClick={() => props.onDefer(line)} disabled={busy}
                          className="px-2 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-[10px] disabled:opacity-50">
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save defer'}
                  </button>
                )}
                {/* Cancel drops the captured quantity too — leaving it behind
                    would re-arm the split the next time the plain Defer button
                    opened this panel. */}
                <button onClick={() => {
                          props.setEditDefer((s: any) => { const n = { ...s }; delete n[line.id]; return n; });
                          props.setSplitIssueQty((s: any) => { const n = { ...s }; delete n[line.id]; return n; });
                        }}
                        className={`text-[10px] px-1 ${splitMode ? 'text-violet-700' : 'text-blue-700'}`}>cancel</button>
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

/**
 * One id per GESTURE, for /store-issue's optional body.client_token. randomUUID
 * needs a secure context; the fallback is only ever used where it isn't (plain
 * http on a LAN IP), and uniqueness per gesture is all the token has to promise.
 */
function gestureToken(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `split-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
  // h.qty is stored in the LINE's own unit (store-issue adds it verbatim), so it
  // reads through the same resolver as the row it came from. Hoisted out of the
  // map — it was rebuilt twice per history row.
  const U = lineUnits(line);
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
            <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left  py-1.5 px-2">When</th>
                  <th className="text-right py-1.5 px-2" title="Handed over, in the PURCHASE unit">Qty</th>
                  <th className="text-left  py-1.5 px-2">By</th>
                  <th className="text-left  py-1.5 px-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {history.slice().reverse().map((h, i) => (
                  <tr key={i} className="border-t border-[#E8D5C4]/50">
                    <td className="py-1.5 px-2">{fmtDateTime(h.at)}</td>
                    <td className="py-1.5 px-2 text-right font-mono font-semibold text-emerald-700">
                      {fmtNum(U.toPU(h.qty))}
                      <span className="text-[9px] text-[#8B7355] ml-0.5">{U.pu}</span>
                      {U.pf > 1 && (Number(h.qty) || 0) > 0 && (
                        <div className="text-[9px] font-normal text-[#B8A590]">= {fmtNum(U.toRecipe(h.qty))} {U.recipeUnit}</div>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-[#6B5744] flex items-center gap-1"><UserIcon className="w-3 h-3" /> {h.by}</td>
                    <td className="py-1.5 px-2 text-[#8B7355]">{h.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
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
    // Both bases: the purchase figure is what was handed over, the recipe
    // figure is what Value and the stock deduction were computed from.
    // Column names say WHICH basis each figure is in — an unqualified "Qty"/"Unit"
    // next to a "Qty (recipe)" invites the reader to assume the first pair is the
    // recipe one too. Header text only; the values are unchanged.
    const headers = ['When', 'Material', 'Qty (purchase)', 'Purchase Unit', 'Qty (recipe)', 'Recipe Unit',
                     'Department', 'Req #', 'Issuer', 'Unit Cost', 'Value', 'Purpose', 'Event', 'Note'];
    const escape = (v: any) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.join(',')];
    for (const e of events) {
      lines.push([e.at, e.material_name, e.qty_purchase ?? e.qty, e.purchase_unit || e.unit,
                  e.qty, e.unit, e.department_name, e.req_number,
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
                  <th className="text-right py-2 px-2 font-medium" title="Handed over, in the PURCHASE unit. The small grey line is the recipe equivalent that Value was computed from.">Qty</th>
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
                    {/* Lead with the PURCHASE figure — that is what the store
                        physically handed over. `qty` is RECIPE units (g, ml), which
                        reads as nonsense on a hand-over row ("issued 4 g of butter"),
                        so it is shown underneath only when the two differ, because it
                        is the number the Value column and the stock deduction use.
                        ?? / || fallbacks keep an older payload rendering. */}
                    <td className="py-1.5 px-2 text-right font-mono font-semibold text-emerald-700">
                      {fmtNum(e.qty_purchase ?? e.qty)}{' '}
                      <span className="text-[9px] text-[#8B7355]">{e.purchase_unit || e.unit}</span>
                      {Number(e.pack_factor) > 1 && (
                        <div className="text-[9px] font-normal text-[#B8A590]">= {fmtNum(e.qty)} {e.unit}</div>
                      )}
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
