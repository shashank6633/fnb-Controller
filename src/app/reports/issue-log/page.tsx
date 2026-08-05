'use client';

/**
 * END-TO-END TRACEABILITY LOG (/reports/issue-log) — management only.
 *
 * Follows ONE material through the whole chain the owner asked for:
 *
 *   RECEIPT  →  REQUISITION raised/approved  →  ISSUE (full or partial, with
 *   what is still open)  →  CONSUMPTION
 *
 * Reads GET /api/reports/issue-log (isManagement-gated, same gate and same
 * wording as /api/reports/purchase-log — this page joins vendor rates and
 * purchase money onto material rows, which is exactly the content the Purchase
 * Report is already gated on). The store team's own /api/store-issued-log is
 * untouched and keeps its canProcessAsStore gate; nobody loses a surface.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULE THIS PAGE EXISTS TO ENFORCE: PER-STAGE TOTALS, NEVER A SUM
 * ═══════════════════════════════════════════════════════════════════════════
 * This is modelled on /reports/purchases → "Purchase log (itemwise)", which
 * already solved the hardest version of this problem honestly: one delivery is
 * legitimately written into three tables, so it prints three totals side by
 * side and never adds them.
 *
 * This report is WORSE exposed, not better, and the four stages are not merely
 * duplicates of each other — they are measured in DIFFERENT BASES:
 *
 *   RECEIPT      qty in PURCHASE units, money in ₹ (the books figure)
 *   REQUISITION  qty in the LINE's own unit (Option B)
 *   ISSUE        qty in RECIPE units
 *   CONSUMPTION  qty in RECIPE units, against a different event entirely
 *
 * Adding any two of them produces a number that is wrong in its unit AND in
 * its meaning. So: totals are rendered as SEPARATE cards, each with the
 * server's own `basis` sentence printed verbatim underneath, and there is
 * deliberately no combined figure anywhere on this page or in the CSV.
 * If you are ever tempted to add a "grand total" card here, re-read this
 * block — that single number is the bug.
 *
 * A SECOND, QUIETER SUMMING TRAP, guarded below: even WITHIN one stage a
 * quantity total is only meaningful when a single material is selected. 4 kg of
 * flour plus 3 L of oil is not 7 of anything. The quantity line on each stage
 * card therefore only renders when the Item filter is set; otherwise it says so
 * in words. Do not "fix" that by always showing the number.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ALWAYS-RECORD vs GATED-DEDUCT — the distinction this page has to SHOW
 * ═══════════════════════════════════════════════════════════════════════════
 * An issue row is now written to requisition_issue_ledger on EVERY hand-over,
 * whether or not central stock moved. Whether stock moves is governed
 * separately by settings.requisition_deduct_at_issue. Those are two different
 * facts and this page must never let them read as one:
 *
 *   stock_moved = true   → the hand-over ALSO debited raw_materials.current_stock
 *   stock_moved = false  → the hand-over happened and is recorded; no stock moved,
 *                          and `skip_reason` says why on the row's own face
 *
 * A reader who assumes "row exists ⇒ stock moved" will conclude the system is
 * double-deducting. The badge and the plain-English reason exist to stop that
 * conversation before it starts. Do not collapse them into one column.
 *
 * PRE-LEDGER ROWS ARE RECONSTRUCTED, NOT RECORDED. 14,148 requisition lines
 * were issued before any ledger existed. The server derives one remainder row
 * per line (quantity_issued minus what the ledger accounts for, reversed through
 * each ledger row's OWN stored pack_factor) so the log is not empty on day one.
 * Those rows have no actor and no exact time because those facts do not exist —
 * the report will not invent them, and it labels them as reconstructed on every
 * surface, on screen and in the CSV.
 *
 * UNITS: every quantity prints WITH its unit and its basis. Receipt rows lead
 * with the PURCHASE unit per the owner rule. The purchase-unit figure is taken
 * from the server (`purchase_qty`), which derives it once through
 * pack-units.packFactor() with the both-halves guard — this page never
 * re-derives a conversion, so PICKLED GINGER 1.5KG (unit=kg, purchase_unit=kg,
 * pack_size=1.5) cannot be converted here by accident.
 *
 * TAX: no GST or cess enters any figure shown here. Receipt value is
 * purchases.total_price — the goods figure.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { todayIST } from '@/lib/format-date';
import MaterialTypeahead, { type MaterialLite } from '@/components/MaterialTypeahead';
import {
  ScrollText, Download, AlertTriangle, Info, Loader2, Truck, ClipboardList,
  ArrowRightLeft, Flame, Link2, CircleSlash, Layers, CalendarDays,
} from 'lucide-react';

/* ═══════════════════════════════ WIRE CONTRACT ═══════════════════════════════
 * Mirrors src/lib/issue-log.ts. Kept as a local copy of the shape rather than a
 * type import so the page compiles independently of the lib's build order; the
 * field names are the contract and must not drift.
 */

type IssueLogStage = 'RECEIPT' | 'REQUISITION' | 'ISSUE' | 'ISSUE_PRELEDGER' | 'CONSUMPTION';

/** '' means "stock moved, nothing was skipped". */
type SkipReason = '' | 'flag_off' | 'party' | 'unit_review' | string;

interface IssueLogRow {
  stage: IssueLogStage;
  /** YYYY-MM-DD, IST calendar date as stored. */
  date: string;
  /** Full timestamp when one genuinely exists. null on reconstructed rows. */
  at: string | null;

  /** The document this row sits on: GRN-… / PINV-… / REQ-… / the ledger row id. */
  doc_no: string;
  /**
   * The chain key. '<grn_number>#<material_id>' on receipts (same shape as
   * purchase-log.ts, so the two reports reconcile), '<req_number>#<req_item_id>'
   * on requisition and issue rows — the owner's "issue id" doubt answered: every
   * issue names the requisition LINE, not just the header — and the bare
   * material_id on consumption, which cannot be attributed to a specific issue.
   */
  link_key: string;
  /** Cross-reference printed beside the row: PO number on a requisition, etc. */
  ref_no: string;

  material_id: string;
  material: string;
  sku: string;
  category: string;

  department_id: string | null;
  department: string;
  vendor: string;

  /** The row's own quantity, in `unit`. Never comparable across `qty_basis`. */
  qty: number;
  unit: string;
  qty_basis: 'purchase' | 'line' | 'recipe' | string;

  /** Same physical quantity restated in purchase units — server-derived only. */
  purchase_qty: number | null;
  purchase_unit: string;

  /** ₹. Present on receipts (spend); a labelled memo on issues; null elsewhere. */
  value: number | null;
  /** 'spend' | 'memo' | '' — what `value` is allowed to be used for. */
  value_basis: string;

  /* Fulfilment — stamped facts, not live recomputation. `effective_qty` is
   * snapshotted on the ledger row at issue time so a chef editing the approved
   * quantity next week cannot retro-rewrite what the store handed over today. */
  requested_qty: number | null;
  effective_qty: number | null;
  issued_qty: number | null;
  still_open: number | null;
  fulfilment: 'FULL' | 'PART' | 'OPEN' | null;

  /** ISSUE rows: did this hand-over also debit central stock? See header. */
  stock_moved: boolean | null;
  skip_reason: SkipReason;
  needs_unit_review: boolean;

  req_number: string;
  req_item_id: string;
  actor: string;
  notes: string;
}

interface StageTotal {
  stage: IssueLogStage;
  lines: number;
  /** Only meaningful when one material is selected — see the header. */
  qty: number | null;
  unit: string;
  value: number | null;
  /** Printed VERBATIM beneath the card. Never paraphrased on screen. */
  basis: string;
}

interface IssueLogResponse {
  rows: IssueLogRow[];
  totals: { by_stage: StageTotal[]; basis: string };
  truncated: boolean;
  from: string;
  to: string;
}

/* ═════════════════════════════ stage presentation ═════════════════════════ */

const STAGE_META: Record<IssueLogStage, {
  label: string; short: string; rank: number; badge: string; icon: React.ReactNode; blurb: string;
}> = {
  RECEIPT: {
    label: 'Receipt', short: 'RECEIPT', rank: 0,
    badge: 'bg-[#FFF1E3] text-[#af4408] border-[#F0CDAE]',
    icon: <Truck className="w-4 h-4" />,
    blurb: 'Goods in — purchase units, ₹ spend',
  },
  REQUISITION: {
    label: 'Requisition', short: 'REQUISITION', rank: 1,
    badge: 'bg-[#F4EFE9] text-[#6B5744] border-[#E8D5C4]',
    icon: <ClipboardList className="w-4 h-4" />,
    blurb: 'Asked for — the line’s own unit',
  },
  ISSUE: {
    label: 'Issue', short: 'ISSUE', rank: 2,
    badge: 'bg-[#EDF4EE] text-[#3F6B4C] border-[#CFE2D4]',
    icon: <ArrowRightLeft className="w-4 h-4" />,
    blurb: 'Handed over — recipe units',
  },
  ISSUE_PRELEDGER: {
    label: 'Issue (pre-ledger)', short: 'PRE-LEDGER', rank: 3,
    badge: 'bg-[#F1EEF7] text-[#5B4B7A] border-[#DAD2EA]',
    icon: <Layers className="w-4 h-4" />,
    blurb: 'Reconstructed from the requisition line',
  },
  CONSUMPTION: {
    label: 'Consumption', short: 'CONSUMPTION', rank: 4,
    badge: 'bg-[#FDEEEA] text-[#9A3412] border-[#F5D0C2]',
    icon: <Flame className="w-4 h-4" />,
    blurb: 'Used up — recipe units',
  },
};

const STAGE_ORDER: IssueLogStage[] = ['RECEIPT', 'REQUISITION', 'ISSUE', 'ISSUE_PRELEDGER', 'CONSUMPTION'];

/**
 * The server's pre-ledger stage token. Accepting the human label as well is
 * deliberate belt-and-braces: this page and src/lib/issue-log.ts ship in the
 * same change but are written separately, and a row whose stage does not match
 * would otherwise render with no badge and sort to the end of every chain —
 * a silent presentation failure on exactly the rows most in need of a label.
 */
function normStage(raw: string): IssueLogStage {
  const s = String(raw || '').toUpperCase().trim();
  if (s === 'ISSUE_PRELEDGER' || s === 'ISSUE (PRE-LEDGER)' || s === 'PRE_LEDGER' || s === 'PRELEDGER') return 'ISSUE_PRELEDGER';
  if (s === 'RECEIPT' || s === 'REQUISITION' || s === 'ISSUE' || s === 'CONSUMPTION') return s as IssueLogStage;
  return 'CONSUMPTION';
}

/**
 * ?stage= values, matching GET /api/reports/issue-log's STAGES exactly — the
 * route 400s on anything else, so this list is a contract, not a convenience.
 *
 * `issue` and `preledger` are SEPARATE on purpose, as they are on the route:
 * both are hand-overs, but one is a recorded ledger row with an actor and a
 * time and the other is an arithmetic remainder with neither. Folding them into
 * one option would let a reader ask for "issues" and be handed rows that look
 * sourced but are derived.
 */
const STAGE_FILTERS = [
  { k: 'all', label: 'All stages' },
  { k: 'receipt', label: 'Receipts only' },
  { k: 'requisition', label: 'Requisitions only' },
  { k: 'issue', label: 'Issues only (recorded)' },
  { k: 'preledger', label: 'Pre-ledger issues (reconstructed)' },
  { k: 'consumption', label: 'Consumption only' },
] as const;
type StageFilter = (typeof STAGE_FILTERS)[number]['k'];

/* ══════════════════════════════════ format ════════════════════════════════ */

const fmtINR = (n: number) => '₹' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN');
const fmtNum = (n: number) => (Number(n) || 0).toLocaleString('en-IN');
/** Quantities are routinely fractional (0.5 CTN, 12.5 g) — never round them away. */
const fmtQty = (n: number) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

function shiftDays(ymd: string, days: number) {
  // Parsed as UTC midnight on purpose: the input is already an IST calendar date
  // from todayIST(), so plain day arithmetic on it is exact. A local Date here
  // would shift the window by a day on a non-IST browser.
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function firstOfMonth(iso: string) { return iso.slice(0, 8) + '01'; }
function fyStart(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return (m >= 4 ? y : y - 1) + '-04-01';
}

/** Rows painted before asking. A year of issues is tens of thousands of lines
 *  and painting them all locks the tab; the CSV always carries everything. */
const ROW_PAINT_CAP = 500;

/* ════════════════════════════════ the page ════════════════════════════════ */

export default function IssueLogPage() {
  const today = todayIST();
  // Default window: the last 30 days, matching /api/reports/purchase-log's own
  // default so the two reports open on the same period.
  const [from, setFrom] = useState(shiftDays(today, -29));
  const [to, setTo] = useState(today);

  const [departmentId, setDepartmentId] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [vendor, setVendor] = useState('');
  const [vendorQ, setVendorQ] = useState('');
  const [reqNumber, setReqNumber] = useState('');
  const [reqNumberQ, setReqNumberQ] = useState('');
  const [stage, setStage] = useState<StageFilter>('all');
  const [grouped, setGrouped] = useState(true);

  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [materials, setMaterials] = useState<MaterialLite[]>([]);
  const [materialsError, setMaterialsError] = useState(false);
  const [deptError, setDeptError] = useState(false);

  const [data, setData] = useState<IssueLogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [paintAll, setPaintAll] = useState(false);

  // Filter option lists. Both are non-fatal: if either fails the log still
  // loads unfiltered, but say so rather than leave a picker that silently
  // finds nothing.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/inventory?scope=all', { cache: 'no-store' });
        if (!res.ok) { setMaterialsError(true); return; }
        const j = await res.json();
        setMaterials(Array.isArray(j.materials) ? j.materials : []);
      } catch { setMaterialsError(true); }
    })();
    (async () => {
      try {
        const res = await fetch('/api/departments', { cache: 'no-store' });
        if (!res.ok) { setDeptError(true); return; }
        const j = await res.json();
        setDepartments(Array.isArray(j.departments) ? j.departments : []);
      } catch { setDeptError(true); }
    })();
  }, []);

  // Vendor and requisition number are free text. Without debouncing, every
  // keystroke re-runs a multi-thousand-row query against a live production DB.
  useEffect(() => { const id = setTimeout(() => setVendorQ(vendor.trim()), 400); return () => clearTimeout(id); }, [vendor]);
  useEffect(() => { const id = setTimeout(() => setReqNumberQ(reqNumber.trim()), 400); return () => clearTimeout(id); }, [reqNumber]);

  const qs = useCallback((format: 'json' | 'csv') => {
    const p = new URLSearchParams({ from, to, stage, format });
    if (departmentId) p.set('department_id', departmentId);
    if (materialId) p.set('material_id', materialId);
    if (vendorQ) p.set('vendor', vendorQ);
    if (reqNumberQ) p.set('req_number', reqNumberQ);
    return p.toString();
  }, [from, to, stage, departmentId, materialId, vendorQ, reqNumberQ]);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setPaintAll(false);
    try {
      const res = await fetch(`/api/reports/issue-log?${qs('json')}`, { cache: 'no-store' });
      // A failed load must never look like "nothing happened in this period" —
      // clear the rows and say why. An empty traceability report that is really
      // an auth failure is how a manager concludes the store issued nothing.
      if (res.status === 401) { setError('Sign in required.'); setData(null); return; }
      if (res.status === 403) { setError('Management only — you don’t have access to the traceability log.'); setData(null); return; }
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        setError(j?.error || `Failed to load the traceability log (HTTP ${res.status}).`); setData(null); return;
      }
      const j = (await res.json()) as IssueLogResponse;
      setData({
        ...j,
        rows: (Array.isArray(j.rows) ? j.rows : []).map(r => ({ ...r, stage: normStage(r.stage) })),
        totals: { by_stage: Array.isArray(j.totals?.by_stage) ? j.totals.by_stage : [], basis: j.totals?.basis || '' },
      });
    } catch { setError('Network error — please try again.'); setData(null); }
    finally { setLoading(false); }
  }, [qs]);

  useEffect(() => { load(); }, [load]);

  const download = async () => {
    setDownloading(true); setError('');
    try {
      const res = await fetch(`/api/reports/issue-log?${qs('csv')}`, { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        setError(j?.error || (res.status === 403 ? 'Management only — download refused.' : `Download failed (HTTP ${res.status}).`));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `traceability-log-${from}_${to}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch { setError('Network error — download failed.'); }
    finally { setDownloading(false); }
  };

  const rows = data?.rows || [];

  /**
   * CHAIN ORDER. The owner's question is "where did this material go", so the
   * default view groups by MATERIAL and, inside it, keeps each link_key
   * together: a requisition line and the issues against it share
   * '<req_number>#<req_item_id>', so sorting the sub-groups by their earliest
   * stage makes the chain read RECEIPT → REQUISITION → its own ISSUEs →
   * CONSUMPTION without ever interleaving two different requisition lines.
   *
   * Sorting by stage alone would NOT do this: it would print every requisition
   * row first and every issue row after, so the 7 kg asked for and the 5 kg
   * issued against it would sit pages apart.
   */
  const groups = useMemo(() => {
    if (!grouped) return null;
    const byMaterial = new Map<string, IssueLogRow[]>();
    for (const r of rows) {
      const k = r.material_id || r.material || '—';
      const list = byMaterial.get(k);
      if (list) list.push(r); else byMaterial.set(k, [r]);
    }
    const out: { key: string; material: string; sku: string; rows: IssueLogRow[] }[] = [];
    for (const [key, list] of byMaterial) {
      const chains = new Map<string, IssueLogRow[]>();
      for (const r of list) {
        const ck = r.link_key || `${r.stage}#${r.doc_no}`;
        const c = chains.get(ck);
        if (c) c.push(r); else chains.set(ck, [r]);
      }
      const ordered: IssueLogRow[] = [];
      const chainList = [...chains.values()].map(c => {
        c.sort((a, b) => (STAGE_META[a.stage].rank - STAGE_META[b.stage].rank) || String(a.date).localeCompare(String(b.date)) || String(a.at || '').localeCompare(String(b.at || '')));
        return c;
      });
      chainList.sort((a, b) => {
        const ra = Math.min(...a.map(r => STAGE_META[r.stage].rank));
        const rb = Math.min(...b.map(r => STAGE_META[r.stage].rank));
        return (ra - rb) || String(a[0].date).localeCompare(String(b[0].date)) || String(a[0].link_key).localeCompare(String(b[0].link_key));
      });
      for (const c of chainList) ordered.push(...c);
      out.push({ key, material: ordered[0]?.material || key, sku: ordered[0]?.sku || '', rows: ordered });
    }
    out.sort((a, b) => a.material.localeCompare(b.material));
    return out;
  }, [rows, grouped]);

  // Painting cap applies to the flat list and to the grouped list alike, so the
  // browser never has to lay out 20,000 <tr>s to show the first chain.
  const flat = useMemo(() => (grouped ? (groups || []).flatMap(g => g.rows) : rows), [grouped, groups, rows]);
  const paintLimit = paintAll ? flat.length : ROW_PAINT_CAP;

  const totals = data?.totals.by_stage || [];
  const anyFilter = !!(departmentId || materialId || vendorQ || reqNumberQ || stage !== 'all');

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E] overflow-x-hidden">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Reports</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2">
              <ScrollText className="w-6 h-6 text-[#af4408] shrink-0" /> Traceability Log
            </h1>
            <p className="text-xs text-[#8B7355] mt-1">
              Purchase → requisition → issue (full or partial) → consumption, one material at a time.
            </p>
          </div>
          <Link href="/reports/purchases" className="text-sm font-medium text-[#af4408] hover:underline shrink-0">Purchase Report →</Link>
        </div>

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">From</span>
              <input type="date" value={from} onChange={e => e.target.value && setFrom(e.target.value)}
                className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>
            <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">To</span>
              <input type="date" value={to} onChange={e => e.target.value && setTo(e.target.value)}
                className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>

            <label className="block min-w-[160px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Department</span>
              <select value={departmentId} onChange={e => setDepartmentId(e.target.value)}
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]">
                <option value="">All departments</option>
                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              {deptError && <p className="text-[10px] text-amber-700 mt-0.5">Department list didn’t load — showing all departments.</p>}</label>

            <div className="block min-w-[220px] flex-1"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Item</span>
              <div className="mt-1">
                <MaterialTypeahead materials={materials} value={materialId} onPick={setMaterialId} compact={false} showStock={false}
                  placeholder="All items — type name, SKU or category…" />
              </div>
              {materialsError && <p className="text-[10px] text-amber-700 mt-0.5">Item list didn’t load — showing all items.</p>}</div>

            {/* Free text, not a <select>: receipts carry vendors that may never
                appear anywhere else in the chain, so a fixed list would hide them. */}
            <label className="block min-w-[150px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Vendor</span>
              <input value={vendor} onChange={e => setVendor(e.target.value)} placeholder="All vendors"
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>

            <label className="block min-w-[150px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Requisition No</span>
              <input value={reqNumber} onChange={e => setReqNumber(e.target.value)} placeholder="e.g. REQ-2026-0123"
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>

            <label className="block min-w-[190px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Stage</span>
              <select value={stage} onChange={e => setStage(e.target.value as StageFilter)}
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]">
                {STAGE_FILTERS.map(o => <option key={o.k} value={o.k}>{o.label}</option>)}
              </select></label>

            <button onClick={download} disabled={downloading}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white">
              {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download CSV
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {([
              ['Last 30 days', shiftDays(today, -29), today],
              ['This month', firstOfMonth(today), today],
              ['This FY', fyStart(today), today],
            ] as const).map(([label, f, t]) => (
              <button key={label} onClick={() => { setFrom(f); setTo(t); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]">
                <CalendarDays className="w-3 h-3" />{label}
              </button>
            ))}
            <span className="mx-1 w-px h-5 bg-[#F0E4D6]" />
            <label className="inline-flex items-center gap-1.5 text-xs text-[#6B5744] cursor-pointer">
              <input type="checkbox" checked={grouped} onChange={e => setGrouped(e.target.checked)} className="accent-[#af4408]" />
              Chain view (group by item)
            </label>
            {anyFilter && (
              <button onClick={() => { setDepartmentId(''); setMaterialId(''); setVendor(''); setReqNumber(''); setStage('all'); }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-white text-[#af4408] border-[#E8D5C4] hover:bg-[#FFF1E3]">Clear filters</button>
            )}
          </div>
        </div>

        {error && <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">{error}</div>}

        {/* ── PER-STAGE TOTALS. Four separate cards, never a sum. ── */}
        {totals.length > 0 && (
          <div className="space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              {STAGE_ORDER.map(st => {
                const t = totals.find(x => normStage(x.stage) === st);
                if (!t) return null;
                return <StageCard key={st} stage={st} total={t} singleMaterial={!!materialId} />;
              })}
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <p>
                <strong>Do not add these totals together.</strong> Each stage is measured in a different basis —
                receipts in purchase units and rupees, requisitions in the line’s own unit, issues and consumption
                in recipe units — and they describe different events. A sum of them is wrong in its unit and in its
                meaning. Use the <strong>Link key</strong> column to follow one material’s chain instead.
                {data?.totals.basis ? <> {data.totals.basis}</> : null}
              </p>
            </div>
          </div>
        )}

        {data?.truncated && (
          <div className="bg-[#af4408] text-white rounded-xl px-4 py-3 text-sm font-semibold flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>This list was TRUNCATED by the server — it is not the full log. Narrow the date range, pick an item
              or a department, or download the CSV, which contains every row.</span>
          </div>
        )}

        {/* ── The log ── */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-bold flex items-center gap-2 min-w-0">
              <span className="text-[#af4408] shrink-0"><ScrollText className="w-4 h-4" /></span>
              <span className="truncate">Traceability log — one row per event</span>
              <span className="text-[11px] text-[#8B7355] font-normal shrink-0">({fmtNum(rows.length)} row{rows.length === 1 ? '' : 's'})</span>
            </h2>
            {loading && <span className="text-xs text-[#8B7355] inline-flex items-center gap-1.5 shrink-0"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</span>}
          </div>

          {/* The table scrolls inside THIS container. The page body must never
              scroll horizontally on a phone — hence overflow-x-hidden on the
              page shell and overflow-x-auto only here. */}
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <table className="w-full text-sm whitespace-nowrap">
              <thead><tr className="text-left text-[11px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
                <th className="py-2 pr-3">Stage</th>
                <th className="py-2 px-3">Date</th>
                <th className="py-2 px-3">Document</th>
                <th className="py-2 px-3">Item</th>
                <th className="py-2 px-3">Dept / Vendor</th>
                <th className="py-2 px-3 text-right">Qty</th>
                <th className="py-2 px-3">Fulfilment</th>
                <th className="py-2 px-3 text-right">Value</th>
                <th className="py-2 px-3">Who</th>
                <th className="py-2 pl-3">Link key</th>
              </tr></thead>
              <tbody>
                {loading && rows.length === 0 ? (
                  <tr><td colSpan={10} className="py-6 text-center text-[#8B7355] animate-pulse">Loading traceability log…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={10} className="py-6 text-center text-[#8B7355]">
                    {error ? 'Not loaded — see the message above.' : 'No receipts, requisitions, issues or consumption in this range.'}
                  </td></tr>
                ) : grouped ? (
                  <GroupedBody groups={groups || []} paintLimit={paintLimit} />
                ) : (
                  rows.slice(0, paintLimit).map((r, i) => <LogRow key={rowKey(r, i)} r={r} />)
                )}
              </tbody>
            </table>
          </div>

          {flat.length > paintLimit && (
            <div className="pt-3 flex flex-wrap items-center gap-2 text-xs text-[#8B7355]">
              <Info className="w-3.5 h-3.5 shrink-0" />
              Showing the first {fmtNum(paintLimit)} of {fmtNum(flat.length)} loaded rows on screen — the CSV contains all of them.
              <button onClick={() => setPaintAll(true)} className="px-2.5 py-1 rounded-md border border-[#E8D5C4] text-[#af4408] hover:bg-[#FFF1E3] font-semibold">
                Show all {fmtNum(flat.length)}
              </button>
            </div>
          )}
        </div>

        {/* How to read it. This is not decoration: three of these four sentences
            are the difference between the log being believed and the log being
            used to "prove" a bug that does not exist. */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 text-[11px] text-[#6B5744] space-y-1.5 leading-relaxed">
          <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">How to read this log</p>
          <p><strong>Receipt</strong> quantities and rates are in <strong>purchase units</strong> (₹ per purchase unit), the way the bill reads.
            <strong> Requisition</strong> quantities are in the requisition line’s own unit. <strong>Issue</strong> and <strong>consumption</strong> quantities
            are in recipe units. Each row prints its own unit — nothing is converted between bases here.</p>
          <p><strong>FULL / PART.</strong> Measured against the effective quantity for the line (chef-approved if there is one, otherwise requested),
            <em> as it stood when the store handed the goods over</em>. A later change to the approved quantity does not rewrite what already happened.
            <strong> Still open</strong> is the outstanding balance in the line’s own unit.</p>
          <p><strong>“Recorded, stock not moved”.</strong> An issue is always recorded, whether or not it debited central stock — those are two separate
            facts. When stock did not move the row says why. Do not read a recorded issue as a stock deduction.</p>
          <p><strong>Pre-ledger rows are reconstructed</strong> from the requisition line for issues made before this log existed. They carry no actor and no exact
            time because those facts were never recorded. They never overlap a recorded issue: together they add back to the line’s issued quantity exactly.</p>
          <p><strong>Consumption is not attributed to a specific issue.</strong> Recipe deduction happens against a material, not against a hand-over, so a consumption row
            links by item only. Anyone tying a specific consumption to a specific issue is guessing.</p>
          <p>No GST or cess is included in any figure on this page — receipt value is the goods figure.</p>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════ sub-components ═══════════════════════════ */

function rowKey(r: IssueLogRow, i: number) {
  return `${r.stage}-${r.doc_no}-${r.link_key}-${r.material_id}-${i}`;
}

/**
 * One stage total. The `basis` sentence from the server is printed VERBATIM
 * beneath the figure — it is the only thing stopping the four cards being read
 * as four parts of one number.
 */
function StageCard({ stage, total, singleMaterial }: { stage: IssueLogStage; total: StageTotal; singleMaterial: boolean }) {
  const meta = STAGE_META[stage];
  return (
    <div className="rounded-xl border border-[#E8D5C4] bg-white shadow-sm p-3.5">
      <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide flex items-center gap-1.5">
        <span className="text-[#af4408] shrink-0">{meta.icon}</span><span className="truncate">{meta.label}</span>
      </p>
      <p className="text-xl font-bold mt-1 text-[#2D1B0E]">{fmtNum(total.lines)} <span className="text-xs font-semibold text-[#8B7355]">line{total.lines === 1 ? '' : 's'}</span></p>

      {/* Quantity is only a number when one item is selected. Adding 4 kg of
          flour to 3 L of oil is not 7 of anything, so this refuses to print a
          figure rather than print a meaningless one. */}
      <p className="text-[11px] text-[#6B5744] mt-1">
        {singleMaterial && total.qty != null
          ? <>Qty <strong>{fmtQty(total.qty)} {total.unit}</strong></>
          : <span className="text-[#B8A48E]">Qty total needs a single item — pick one in the Item filter.</span>}
      </p>

      {total.value != null && (
        <p className="text-[11px] text-[#6B5744] mt-0.5">Value <strong>{fmtINR(total.value)}</strong></p>
      )}

      <p className="text-[10px] text-[#8B7355] mt-1.5 whitespace-normal leading-snug">{total.basis || meta.blurb}</p>
    </div>
  );
}

function StageBadge({ stage }: { stage: IssueLogStage }) {
  const meta = STAGE_META[stage];
  return <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-wide ${meta.badge}`}>{meta.short}</span>;
}

/** Plain-English reason a hand-over did not move central stock. */
function skipWords(reason: SkipReason): string {
  switch (reason) {
    case 'flag_off':    return 'recorded, stock not moved — deduct-at-issue is off';
    case 'party':       return 'recorded, stock not moved — party requisition (stock moves at party fulfilment)';
    case 'unit_review': return 'recorded, stock not moved — unit needs review on this material';
    case '':            return '';
    default:            return `recorded, stock not moved — ${reason}`;
  }
}

function FulfilmentCell({ r }: { r: IssueLogRow }) {
  if (!r.fulfilment) return <span className="text-[#B8A48E]">—</span>;
  const tone = r.fulfilment === 'FULL' ? 'bg-[#EDF4EE] text-[#3F6B4C] border-[#CFE2D4]'
    : r.fulfilment === 'PART' ? 'bg-amber-50 text-amber-800 border-amber-200'
    : 'bg-[#F4EFE9] text-[#6B5744] border-[#E8D5C4]';
  const openQty = Number(r.still_open || 0);
  return (
    <span className="inline-block">
      <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-wide ${tone}`}>{r.fulfilment}</span>
      {/* Outstanding is stated in the LINE's own unit — the unit the line was
          raised in — because that is the unit the store and the chef argue in. */}
      {openQty > 0 && (
        <span className="block text-[10px] text-amber-800 mt-0.5">
          still open {fmtQty(openQty)} {r.unit || ''}
        </span>
      )}
      {r.effective_qty != null && r.issued_qty != null && (
        <span className="block text-[10px] text-[#8B7355]">
          {fmtQty(r.issued_qty)} of {fmtQty(r.effective_qty)} {r.unit || ''}
        </span>
      )}
    </span>
  );
}

function LogRow({ r }: { r: IssueLogRow }) {
  const isReceipt = r.stage === 'RECEIPT';
  const isPreLedger = r.stage === 'ISSUE_PRELEDGER';
  const skip = r.stock_moved === false ? skipWords(r.skip_reason) : '';

  return (
    <tr className="border-b border-[#F7EEE3] last:border-0 align-top">
      <td className="py-2 pr-3"><StageBadge stage={r.stage} /></td>
      <td className="py-2 px-3 text-[#6B5744]">
        {r.date || '—'}
        {/* No exact time on a reconstructed row: it was never recorded. */}
        {isPreLedger
          ? <span className="block text-[10px] text-[#B8A48E]">time not recorded</span>
          : r.at ? <span className="block text-[10px] text-[#B8A48E]">{String(r.at).slice(11, 16)}</span> : null}
      </td>
      <td className="py-2 px-3 font-medium">
        {r.doc_no || '—'}
        {r.ref_no && <span className="block text-[10px] text-[#8B7355] font-normal">{r.ref_no}</span>}
        {isPreLedger && <span className="block text-[10px] text-[#5B4B7A] font-normal whitespace-normal max-w-[200px]">reconstructed from the requisition line</span>}
      </td>
      <td className="py-2 px-3 font-medium whitespace-normal min-w-[170px]">
        {r.material || '—'}
        {r.sku && <span className="block text-[10px] text-[#8B7355] font-normal">{r.sku}</span>}
      </td>
      <td className="py-2 px-3 text-[#6B5744] whitespace-normal min-w-[130px]">
        {r.department || '—'}
        {r.vendor && <span className="block text-[10px] text-[#8B7355]">{r.vendor}</span>}
      </td>
      <td className="py-2 px-3 text-right tabular-nums">
        {/* OWNER RULE: a receipt row leads with the PURCHASE unit. Every other
            stage leads with the unit the event was actually recorded in, and
            carries the purchase-unit restatement underneath — server-derived,
            never re-computed here. */}
        {isReceipt ? (
          <>
            <span className="font-semibold">{fmtQty(r.qty)} <span className="text-[11px] text-[#8B7355] font-normal">{r.purchase_unit || r.unit}</span></span>
            <span className="block text-[10px] text-[#B8A48E]">purchase units</span>
          </>
        ) : (
          <>
            <span className="font-semibold">{fmtQty(r.qty)} <span className="text-[11px] text-[#8B7355] font-normal">{r.unit}</span></span>
            <span className="block text-[10px] text-[#B8A48E]">{r.qty_basis === 'line' ? 'line unit' : r.qty_basis === 'recipe' ? 'recipe units' : r.qty_basis || ''}</span>
            {r.purchase_qty != null && r.purchase_unit && (
              <span className="block text-[10px] text-[#8B7355]">= {fmtQty(r.purchase_qty)} {r.purchase_unit}</span>
            )}
          </>
        )}
      </td>
      <td className="py-2 px-3 whitespace-normal min-w-[130px]">
        <FulfilmentCell r={r} />
        {/* Recorded ≠ deducted. Two facts, two lines, never merged. */}
        {skip && (
          <span className="inline-flex items-start gap-1 text-[10px] text-[#8A6D3B] bg-amber-50 border border-amber-200 rounded px-1 py-0.5 mt-1 whitespace-normal max-w-[220px]">
            <CircleSlash className="w-3 h-3 shrink-0 mt-[1px]" />{skip}
          </span>
        )}
        {r.needs_unit_review && (
          <span className="block text-[10px] text-amber-800 mt-0.5">unit needs review</span>
        )}
      </td>
      <td className="py-2 px-3 text-right tabular-nums">
        {r.value == null ? <span className="text-[#B8A48E]">—</span> : (
          <>
            <span className={r.value_basis === 'spend' ? 'font-semibold' : ''}>{fmtINR(r.value)}</span>
            {/* A valued issue is a MEMO, not a spend. The spend already
                happened at receipt; printing it unlabelled invites it being
                added to the receipt total. */}
            <span className="block text-[10px] text-[#B8A48E]">{r.value_basis === 'spend' ? 'spend' : r.value_basis === 'memo' ? 'valued memo' : ''}</span>
          </>
        )}
      </td>
      <td className="py-2 px-3 text-[#6B5744]">
        {isPreLedger ? <span className="text-[#B8A48E]">not recorded</span> : (r.actor || '—')}
      </td>
      <td className="py-2 pl-3 text-[11px] text-[#8B7355] font-mono">
        <span className="inline-flex items-center gap-1"><Link2 className="w-3 h-3 shrink-0 text-[#C9B39C]" />{r.link_key || '—'}</span>
        {r.notes && <span className="block text-[10px] text-[#B8A48E] font-sans whitespace-normal max-w-[220px]">{r.notes}</span>}
      </td>
    </tr>
  );
}

/** Chain view: an item heading, then that item's rows already in chain order. */
function GroupedBody({ groups, paintLimit }: { groups: { key: string; material: string; sku: string; rows: IssueLogRow[] }[]; paintLimit: number }) {
  const out: React.ReactNode[] = [];
  let painted = 0;
  for (const g of groups) {
    if (painted >= paintLimit) break;
    out.push(
      <tr key={`h-${g.key}`} className="bg-[#FFF6EE] border-y border-[#F0E4D6]">
        <td colSpan={10} className="py-1.5 px-3 text-[11px] font-bold text-[#af4408] uppercase tracking-wide">
          {g.material}{g.sku ? <span className="font-normal text-[#8B7355] normal-case"> · {g.sku}</span> : null}
          <span className="font-normal text-[#8B7355] normal-case"> · {fmtNum(g.rows.length)} event{g.rows.length === 1 ? '' : 's'}</span>
        </td>
      </tr>,
    );
    for (let i = 0; i < g.rows.length && painted < paintLimit; i++, painted++) {
      out.push(<LogRow key={rowKey(g.rows[i], i)} r={g.rows[i]} />);
    }
  }
  return <>{out}</>;
}
