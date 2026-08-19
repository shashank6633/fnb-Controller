'use client';

/**
 * HR — Payroll (Phase 4). adminOnly (page-catalog flag + every API re-checks).
 *
 * Contract: docs/HRMS_DECISIONS.md §5 + owner spec §19. Three tabs:
 *  · Runs — period picker → Create draft → Compute (skipped-employees report
 *    rendered honestly) → review items (expandable frozen compute trace from
 *    detail_json) → Finalize with confirm. Finalized runs are IMMUTABLE and
 *    render read-only with a badge.
 *  · Advances — request queue: approve (amount + installment → schedule
 *    preview), reject, disburse, per-advance installment ledger, close.
 *  · Statutory — effective-dated config rows (append-only: create / end /
 *    deactivate; rates are never edited in place).
 *
 * APIs (each verb re-gates on canAdminHr — this page renders the 403 as the
 * plain admin-only lock): /api/hr/payroll, /api/hr/advances, /api/hr/statutory.
 * Money renders ₹ via toLocaleString('en-IN'). Mutations go through
 * api()/apiJson() (CSRF); GETs are bare fetch. Dates render via fmtIST*.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IndianRupee, Plus, X, Loader2, Calculator, Lock, ChevronDown, ChevronUp,
  ChevronLeft, ChevronRight, CheckCircle2, XCircle, Banknote, Save,
} from 'lucide-react';
import { api, apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate, todayIST } from '@/lib/format-date';
import Combobox, { type ComboOption } from '@/components/Combobox';
import Toggle from '@/components/Toggle';
import TabScroller from '@/components/TabScroller';
import {
  HR_ADVANCE_STATUSES,
  advanceStatusMeta,
  payrollRunStatusMeta,
  type HrAdvance,
  type HrAdvanceInstallment,
  type HrEmployeeListRow,
  type HrPayrollRun,
  type HrStatutoryConfig,
} from '@/lib/hr';

const PAGE_SIZE = 25;

/* ------------------------------------------------------------------ *
 * Row shapes (what the APIs actually send)
 * ------------------------------------------------------------------ */

/** hr_payroll_items row + LEFT-JOINed names. detail_json rides ONLY on the
 *  single-run GET (?run_id=) — list items exclude the heavy trace. */
interface PayrollItemRow {
  id: string;
  run_id: string;
  employee_id: string;
  paid_days: number;
  lop_days: number;
  overtime_minutes: number;
  earnings_json: string;
  deductions_json: string;
  gross: number;
  net: number;
  employee_name: string;
  employee_code: string;
  detail_json?: string;
}

interface RunRow extends HrPayrollRun {
  items: PayrollItemRow[];
}

interface SkippedRow {
  employee_id: string;
  employee_code: string;
  full_name: string;
  reason: string;
}

interface AdvanceRow extends HrAdvance {
  employee_name: string | null;
  employee_code: string | null;
  installments: HrAdvanceInstallment[];
}

interface Line { label: string; amount: number }

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** ₹ with Indian grouping, always 2 decimals. */
function inr(v: unknown): string {
  const n = Number(v);
  const safe = Number.isFinite(n) ? n : 0;
  return `₹${safe.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Minutes → '5h 30m' ('0m' for none/invalid). */
function fmtMin(v: unknown): string {
  const m = Number(v);
  if (!Number.isFinite(m) || m <= 0) return '0m';
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h > 0 ? `${h}h ${r}m` : `${r}m`;
}

/** Safe parse of a [{label, amount}] JSON string. */
function parseLines(json: string | undefined | null): Line[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
      .map((l) => ({ label: String(l.label ?? ''), amount: Number(l.amount) || 0 }));
  } catch {
    return [];
  }
}

/** Safe parse of the frozen compute trace (null when unreadable). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseDetail(json: string | undefined | null): any | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Statutory kind vocabulary (mirrors /api/hr/statutory + hr-payroll.ts:
 * pf / esi / professional_tax are APPLIED by the payroll compute; the
 * other kinds are recorded-only in v1 — the hints say so honestly)
 * ------------------------------------------------------------------ */

interface StatKindMeta {
  key: string;
  label: string;
  applied: boolean;
  placeholder: string;
  hint: string;
}

const STATUTORY_KINDS: readonly StatKindMeta[] = [
  {
    key: 'pf', label: 'PF', applied: true,
    placeholder: '{ "percent_of_basic": 12, "wage_cap": 15000 }',
    hint: 'Applied by payroll: percent_of_basic on the earned (prorated) basic, capped at wage_cap (0 = no cap).',
  },
  {
    key: 'esi', label: 'ESI', applied: true,
    placeholder: '{ "percent_of_gross": 0.75, "gross_cap": 21000 }',
    hint: 'Applied by payroll: percent_of_gross on the earned gross. gross_cap is an eligibility ceiling judged on the FULL monthly gross (0 = none).',
  },
  {
    key: 'professional_tax', label: 'Professional Tax', applied: true,
    placeholder: '{ "slabs": [ { "upto": 15000, "amount": 0 }, { "upto": 20000, "amount": 150 }, { "upto": 0, "amount": 200 } ] }',
    hint: 'Applied by payroll: flat monthly amount from the slab the earned gross falls in. "upto": 0 means no upper bound.',
  },
  {
    key: 'tds', label: 'TDS', applied: false,
    placeholder: '{ "slabs": [ { "min": 0, "max": 300000, "rate_pct": 0 } ], "standard_deduction": 75000 }',
    hint: 'Recorded for reference in v1 — the payroll compute does not auto-deduct TDS yet.',
  },
  {
    key: 'bonus', label: 'Bonus', applied: false,
    placeholder: '{ "rate_pct": 8.33, "wage_ceiling": 21000, "calc_ceiling": 7000 }',
    hint: 'Recorded for reference in v1 — not auto-applied by the monthly payroll compute.',
  },
  {
    key: 'gratuity', label: 'Gratuity', applied: false,
    placeholder: '{ "days_per_year": 15, "min_service_years": 5 }',
    hint: 'Recorded for reference in v1 — not auto-applied by the monthly payroll compute.',
  },
  {
    key: 'min_wage', label: 'Minimum Wage', applied: false,
    placeholder: '{ "monthly": 12000, "daily": 462 }',
    hint: 'Recorded for reference in v1 — not auto-applied by the monthly payroll compute.',
  },
] as const;

function statKindMeta(key: string): StatKindMeta {
  return (
    STATUTORY_KINDS.find((k) => k.key === key) ?? {
      key, label: key || '—', applied: false, placeholder: '{ }', hint: '',
    }
  );
}

/** Installment status → badge classes. */
function instBadge(status: string): { label: string; color: string } {
  if (status === 'recovered') return { label: 'Recovered', color: 'bg-green-100 text-green-700 border-green-200' };
  if (status === 'waived') return { label: 'Waived', color: 'bg-slate-100 text-slate-600 border-slate-200' };
  return { label: 'Due', color: 'bg-amber-100 text-amber-800 border-amber-200' };
}

const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';
const btnPrimary = 'inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium disabled:opacity-50';
const btnGhost = 'inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40';
const chip = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-xs font-medium border ${
    active ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
  }`;

/* ------------------------------------------------------------------ *
 * Small shared pieces
 * ------------------------------------------------------------------ */

function Pager({ page, total, busy, onPage }: {
  page: number; total: number; busy: boolean; onPage: (p: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromN = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const toN = Math.min(page * PAGE_SIZE, total);
  return (
    <div className="px-3 py-2 border-t border-[#E8D5C4] flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-[#8B7355]">Showing {fromN}–{toN} of {total}</span>
      <div className="flex items-center gap-2">
        <button onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1 || busy} className={btnGhost}>
          <ChevronLeft className="w-3.5 h-3.5" /> Prev
        </button>
        <span className="text-xs text-[#6B5744]">Page {page} of {pageCount}</span>
        <button onClick={() => onPage(Math.min(pageCount, page + 1))} disabled={page >= pageCount || busy} className={btnGhost}>
          Next <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function ErrorBanner({ msg, onRetry }: { msg: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
      <span>{msg}</span>
      {onRetry && (
        <button onClick={onRetry}
                className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
          Retry
        </button>
      )}
    </div>
  );
}

/** Modal shell — the house safe-modal (fixed inset, internal scroll). */
function Modal({ title, onClose, children, footer, wide = false }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className={`bg-white rounded-xl border border-[#E8D5C4] w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} shadow-xl flex flex-col overflow-hidden`}>
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <h2 className="font-bold text-[#2D1B0E]">{title}</h2>
          <button onClick={onClose} className="text-[#8B7355]"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">{children}</div>
        {footer && (
          <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** Expandable payslip detail — renders the frozen compute trace honestly:
 *  the structured sections it understands, plus the full raw trace. */
function ItemDetail({ item }: { item: PayrollItemRow }) {
  const earnings = parseLines(item.earnings_json);
  const deductions = parseLines(item.deductions_json);
  const d = parseDetail(item.detail_json);

  const lineTable = (title: string, lines: Line[]) => (
    <div className="border border-[#E8D5C4] rounded-lg overflow-hidden">
      <div className="bg-[#FFF1E3] px-3 py-1.5 text-xs font-semibold text-[#6B5744]">{title}</div>
      {lines.length === 0 ? (
        <div className="px-3 py-2 text-xs text-[#8B7355]">None.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-t border-[#E8D5C4]/50 first:border-t-0">
                  <td className="px-3 py-1.5">{l.label || '—'}</td>
                  <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{inr(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statApplied: any[] = Array.isArray(d?.statutory?.applied) ? d.statutory.applied : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const advApplied: any[] = Array.isArray(d?.advance_recovery?.applied) ? d.advance_recovery.applied : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const advDeferred: any[] = Array.isArray(d?.advance_recovery?.deferred) ? d.advance_recovery.deferred : [];

  return (
    <div className="p-3 bg-[#FFF8F0] border-t border-[#E8D5C4]/60 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {lineTable('Earnings', earnings)}
        {lineTable('Deductions', deductions)}
      </div>

      <div className="flex flex-wrap gap-2 text-[11px]">
        <span className="px-2 py-1 rounded-lg bg-white border border-[#E8D5C4]">Paid days: <b>{item.paid_days}</b></span>
        <span className="px-2 py-1 rounded-lg bg-white border border-[#E8D5C4]">LOP days: <b>{item.lop_days}</b></span>
        {d?.attendance && (
          <span className="px-2 py-1 rounded-lg bg-white border border-[#E8D5C4]">
            Present days: <b>{Number(d.attendance.present_days) || 0}</b>
          </span>
        )}
        {d?.leave && (
          <span className="px-2 py-1 rounded-lg bg-white border border-[#E8D5C4]">
            Paid leave days: <b>{Number(d.leave.paid_leave_days) || 0}</b>
          </span>
        )}
        <span className="px-2 py-1 rounded-lg bg-white border border-[#E8D5C4]">Overtime: <b>{fmtMin(item.overtime_minutes)}</b> (reported only in v1)</span>
      </div>

      {statApplied.length > 0 && (
        <div className="border border-[#E8D5C4] rounded-lg overflow-hidden bg-white">
          <div className="bg-[#FFF1E3] px-3 py-1.5 text-xs font-semibold text-[#6B5744]">Statutory trace</div>
          <div className="divide-y divide-[#E8D5C4]/50">
            {statApplied.map((s, i) => (
              <div key={i} className="px-3 py-1.5 text-xs flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{s?.kind ? statKindMeta(String(s.kind)).label : 'Note'}</span>
                {s?.amount !== undefined && <span className="font-mono">{inr(s.amount)}</span>}
                {s?.note && <span className="text-[#8B7355]">{String(s.note)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {(advApplied.length > 0 || advDeferred.length > 0) && (
        <div className="border border-[#E8D5C4] rounded-lg overflow-hidden bg-white">
          <div className="bg-[#FFF1E3] px-3 py-1.5 text-xs font-semibold text-[#6B5744]">Advance recovery</div>
          <div className="divide-y divide-[#E8D5C4]/50">
            {advApplied.map((a, i) => (
              <div key={`a${i}`} className="px-3 py-1.5 text-xs flex flex-wrap items-baseline gap-x-2">
                <span className="text-green-700 font-medium">Recovered this period</span>
                <span className="font-mono">{inr(a?.amount)}</span>
              </div>
            ))}
            {advDeferred.map((a, i) => (
              <div key={`d${i}`} className="px-3 py-1.5 text-xs flex flex-wrap items-baseline gap-x-2">
                <span className="text-amber-700 font-medium">Deferred</span>
                <span className="font-mono">{inr(a?.amount)}</span>
                {a?.reason && <span className="text-[#8B7355]">{String(a.reason)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-xs text-[#6B5744]">
        Gross <b className="font-mono">{inr(item.gross)}</b> − deductions ={' '}
        <b className="font-mono">{inr(item.net)}</b> net
      </div>

      {item.detail_json ? (
        d ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-[#8B7355] hover:text-[#af4408]">Full compute trace (frozen at run time)</summary>
            <pre className="mt-2 p-3 bg-white border border-[#E8D5C4] rounded-lg overflow-auto max-h-80 text-[11px]">
              {JSON.stringify(d, null, 2)}
            </pre>
          </details>
        ) : (
          <div className="text-xs text-[#8B7355]">The stored compute trace could not be parsed — raw value below.
            <pre className="mt-2 p-3 bg-white border border-[#E8D5C4] rounded-lg overflow-auto max-h-40 text-[11px]">{item.detail_json}</pre>
          </div>
        )
      ) : (
        <div className="text-xs text-[#8B7355]">Compute trace not loaded for this view.</div>
      )}
    </div>
  );
}

/* ================================================================== */

export default function HrPayrollPage() {
  const [tab, setTab] = useState<'runs' | 'advances' | 'statutory'>('runs');
  const [locked, setLocked] = useState(false);

  // ── Shared picker data ──────────────────────────────────────────────────
  const [employees, setEmployees] = useState<HrEmployeeListRow[]>([]);
  const [outletNames, setOutletNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    fetch('/api/hr/employees?pageSize=100')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => setEmployees(Array.isArray(j?.rows) ? j.rows : []))
      .catch(() => {});
    fetch('/api/outlets')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => {
        const list = Array.isArray(j?.outlets) ? j.outlets : [];
        setOutletNames(new Map(list.map((o: { id: string; name: string }) => [o.id, o.name])));
      })
      .catch(() => {});
  }, []);

  const employeeOptions = useMemo<ComboOption[]>(
    () => employees.map((e) => ({ value: e.id, label: e.full_name, hint: e.employee_code })),
    [employees],
  );
  const employeeName = useCallback(
    (id: string) => employees.find((e) => e.id === id)?.full_name || '',
    [employees],
  );

  /* ── Runs tab state ──────────────────────────────────────────────────── */
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsPage, setRunsPage] = useState(1);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsFetching, setRunsFetching] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const runsSeq = useRef(0);

  const [createPeriod, setCreatePeriod] = useState(() => todayIST().slice(0, 7));
  const [createNote, setCreateNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailSeq = useRef(0);

  const [computing, setComputing] = useState(false);
  const [skipped, setSkipped] = useState<SkippedRow[] | null>(null); // null = no compute this session
  const [computedCount, setComputedCount] = useState(0);
  const [runActionError, setRunActionError] = useState<string | null>(null);

  const [showFinalize, setShowFinalize] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeInfo, setFinalizeInfo] = useState<{ count: number; amount: number } | null>(null);

  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    const seq = ++runsSeq.current;
    setRunsFetching(true);
    setRunsError(null);
    try {
      const res = await fetch(`/api/hr/payroll?page=${runsPage}&pageSize=${PAGE_SIZE}`);
      if (seq !== runsSeq.current) return;
      if (res.status === 401 || res.status === 403) { setLocked(true); return; }
      if (!res.ok) { setRunsError("Couldn't load payroll runs"); return; }
      const json = await res.json();
      if (seq !== runsSeq.current) return;
      setRuns(Array.isArray(json?.rows) ? json.rows : []);
      setRunsTotal(Number(json?.total) || 0);
    } catch {
      if (seq === runsSeq.current) setRunsError("Couldn't load payroll runs");
    } finally {
      if (seq === runsSeq.current) { setRunsFetching(false); setRunsLoading(false); }
    }
  }, [runsPage]);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  const fetchRunDetail = useCallback(async (runId: string) => {
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await fetch(`/api/hr/payroll?run_id=${encodeURIComponent(runId)}`);
      if (seq !== detailSeq.current) return;
      if (!res.ok) {
        setDetailError(res.status === 404 ? 'This payroll run no longer exists.' : "Couldn't load the run detail");
        return;
      }
      const json = await res.json();
      if (seq !== detailSeq.current) return;
      const run = json?.run;
      setRunDetail(run && run.id ? { ...run, items: Array.isArray(run.items) ? run.items : [] } : null);
    } catch {
      if (seq === detailSeq.current) setDetailError("Couldn't load the run detail");
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, []);

  const selectRun = (runId: string) => {
    setSelectedRunId(runId);
    setSkipped(null);
    setComputedCount(0);
    setRunActionError(null);
    setFinalizeInfo(null);
    setExpandedItemId(null);
    fetchRunDetail(runId);
  };

  const createRun = async () => {
    if (!/^\d{4}-\d{2}$/.test(createPeriod)) {
      setCreateError('Pick a payroll month (YYYY-MM).');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiJson<{ run: RunRow }>('/api/hr/payroll', {
        method: 'POST',
        body: { action: 'create', period: createPeriod, note: createNote.trim() },
      });
      setCreateNote('');
      await fetchRuns();
      if (res?.run?.id) selectRun(res.run.id);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Could not create the draft run');
    } finally {
      setCreating(false);
    }
  };

  const computeRun = async () => {
    if (!selectedRunId) return;
    setComputing(true);
    setRunActionError(null);
    setFinalizeInfo(null);
    try {
      const res = await apiJson<{ run: RunRow; items: PayrollItemRow[]; skipped: SkippedRow[] }>(
        '/api/hr/payroll',
        { method: 'POST', body: { action: 'compute', run_id: selectedRunId } },
      );
      setSkipped(Array.isArray(res?.skipped) ? res.skipped : []);
      setComputedCount(Array.isArray(res?.items) ? res.items.length : 0);
      await fetchRunDetail(selectedRunId); // re-read with the frozen traces
      fetchRuns();
    } catch (e) {
      setRunActionError(e instanceof Error ? e.message : 'Compute failed');
    } finally {
      setComputing(false);
    }
  };

  const finalizeRun = async () => {
    if (!selectedRunId) return;
    setFinalizing(true);
    setRunActionError(null);
    try {
      const res = await apiJson<{ run: RunRow; recovered_installments: number; recovered_amount: number }>(
        '/api/hr/payroll',
        { method: 'POST', body: { action: 'finalize', run_id: selectedRunId } },
      );
      setFinalizeInfo({
        count: Number(res?.recovered_installments) || 0,
        amount: Number(res?.recovered_amount) || 0,
      });
      setShowFinalize(false);
      await fetchRunDetail(selectedRunId);
      fetchRuns();
    } catch (e) {
      setShowFinalize(false);
      setRunActionError(e instanceof Error ? e.message : 'Finalize failed');
    } finally {
      setFinalizing(false);
    }
  };

  const runTotals = (r: RunRow) => {
    let gross = 0; let net = 0;
    for (const it of r.items) { gross += Number(it.gross) || 0; net += Number(it.net) || 0; }
    return { gross, net };
  };

  /* ── Advances tab state ──────────────────────────────────────────────── */
  const [advRows, setAdvRows] = useState<AdvanceRow[]>([]);
  const [advTotal, setAdvTotal] = useState(0);
  const [advPage, setAdvPage] = useState(1);
  const [advStatus, setAdvStatus] = useState('');
  const [advLoading, setAdvLoading] = useState(true);
  const [advFetching, setAdvFetching] = useState(false);
  const [advError, setAdvError] = useState<string | null>(null);
  const [advActionError, setAdvActionError] = useState<string | null>(null);
  const advSeq = useRef(0);

  const [expandedAdvanceId, setExpandedAdvanceId] = useState<string | null>(null);
  const [advBusyId, setAdvBusyId] = useState<string | null>(null);

  const [showNewAdvance, setShowNewAdvance] = useState(false);
  const [advForm, setAdvForm] = useState({ employee_id: '', requested_amount: '', reason: '' });
  const [advSaving, setAdvSaving] = useState(false);
  const [advModalError, setAdvModalError] = useState<string | null>(null);

  const [approveTarget, setApproveTarget] = useState<AdvanceRow | null>(null);
  const [approveAmt, setApproveAmt] = useState('');
  const [approveInst, setApproveInst] = useState('');
  const [rejectTarget, setRejectTarget] = useState<AdvanceRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => { setAdvPage(1); }, [advStatus]);

  const fetchAdvances = useCallback(async () => {
    const seq = ++advSeq.current;
    setAdvFetching(true);
    setAdvError(null);
    try {
      const sp = new URLSearchParams();
      if (advStatus) sp.set('status', advStatus);
      sp.set('page', String(advPage));
      sp.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(`/api/hr/advances?${sp.toString()}`);
      if (seq !== advSeq.current) return;
      if (res.status === 401 || res.status === 403) { setLocked(true); return; }
      if (!res.ok) { setAdvError("Couldn't load advances"); return; }
      const json = await res.json();
      if (seq !== advSeq.current) return;
      setAdvRows(Array.isArray(json?.rows) ? json.rows : []);
      setAdvTotal(Number(json?.total) || 0);
    } catch {
      if (seq === advSeq.current) setAdvError("Couldn't load advances");
    } finally {
      if (seq === advSeq.current) { setAdvFetching(false); setAdvLoading(false); }
    }
  }, [advPage, advStatus]);

  useEffect(() => { if (tab === 'advances') fetchAdvances(); }, [tab, fetchAdvances]);

  const submitNewAdvance = async () => {
    if (!advForm.employee_id) { setAdvModalError('Pick an employee.'); return; }
    const amt = Number(advForm.requested_amount);
    if (!Number.isFinite(amt) || amt <= 0) { setAdvModalError('Requested amount must be a positive number.'); return; }
    setAdvSaving(true);
    setAdvModalError(null);
    try {
      await apiJson('/api/hr/advances', {
        method: 'POST',
        body: { employee_id: advForm.employee_id, requested_amount: amt, reason: advForm.reason.trim() },
      });
      setShowNewAdvance(false);
      setAdvForm({ employee_id: '', requested_amount: '', reason: '' });
      fetchAdvances();
    } catch (e) {
      setAdvModalError(e instanceof Error ? e.message : 'Could not create the request');
    } finally {
      setAdvSaving(false);
    }
  };

  /** Approve-preview: ceil(approved/installment) rows, last = remainder. */
  const approvePreview = useMemo(() => {
    const ap = Math.round(Number(approveAmt) * 100);
    const ip = Math.round(Number(approveInst) * 100);
    if (!Number.isFinite(ap) || !Number.isFinite(ip) || ap <= 0 || ip <= 0) return null;
    const n = Math.ceil(ap / ip);
    const last = (ap - ip * (n - 1)) / 100;
    return { n, last };
  }, [approveAmt, approveInst]);

  const submitApprove = async () => {
    if (!approveTarget) return;
    const ap = Number(approveAmt);
    const ip = Number(approveInst);
    if (!Number.isFinite(ap) || ap <= 0 || !Number.isFinite(ip) || ip <= 0) {
      setAdvModalError('Approved amount and monthly installment must both be positive numbers.');
      return;
    }
    setAdvSaving(true);
    setAdvModalError(null);
    try {
      await apiJson('/api/hr/advances', {
        method: 'PATCH',
        body: { id: approveTarget.id, action: 'approve', approved_amount: ap, installment_amount: ip },
      });
      setApproveTarget(null);
      fetchAdvances();
    } catch (e) {
      setAdvModalError(e instanceof Error ? e.message : 'Approve failed');
    } finally {
      setAdvSaving(false);
    }
  };

  const submitReject = async () => {
    if (!rejectTarget) return;
    if (!rejectReason.trim()) { setAdvModalError('A reason for rejecting is required.'); return; }
    setAdvSaving(true);
    setAdvModalError(null);
    try {
      await apiJson('/api/hr/advances', {
        method: 'PATCH',
        body: { id: rejectTarget.id, action: 'reject', review_reason: rejectReason.trim() },
      });
      setRejectTarget(null);
      setRejectReason('');
      fetchAdvances();
    } catch (e) {
      setAdvModalError(e instanceof Error ? e.message : 'Reject failed');
    } finally {
      setAdvSaving(false);
    }
  };

  const advanceAction = async (row: AdvanceRow, action: 'disburse' | 'close') => {
    const who = row.employee_name || 'this employee';
    const msg = action === 'disburse'
      ? `Mark ${inr(row.approved_amount)} to ${who} as disbursed?`
      : `Close this advance for ${who}? Only fully recovered advances can be closed.`;
    if (!confirm(msg)) return;
    setAdvBusyId(row.id);
    setAdvActionError(null);
    try {
      await apiJson('/api/hr/advances', { method: 'PATCH', body: { id: row.id, action } });
      fetchAdvances();
    } catch (e) {
      setAdvActionError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setAdvBusyId(null);
    }
  };

  /* ── Statutory tab state ─────────────────────────────────────────────── */
  const [statRows, setStatRows] = useState<HrStatutoryConfig[]>([]);
  const [statTotal, setStatTotal] = useState(0);
  const [statPage, setStatPage] = useState(1);
  const [statKind, setStatKind] = useState('');
  const [statInactive, setStatInactive] = useState(false);
  const [statLoading, setStatLoading] = useState(true);
  const [statFetching, setStatFetching] = useState(false);
  const [statError, setStatError] = useState<string | null>(null);
  const [statActionError, setStatActionError] = useState<string | null>(null);
  const statSeq = useRef(0);

  const [expandedConfigId, setExpandedConfigId] = useState<string | null>(null);
  const [statBusyId, setStatBusyId] = useState<string | null>(null);

  const emptyStatForm = () => ({
    kind: 'pf', state: '', employee_category: '',
    effective_from: todayIST(), effective_to: '', config_json: '',
  });
  const [showStatCreate, setShowStatCreate] = useState(false);
  const [statForm, setStatForm] = useState(emptyStatForm());
  const [statSaving, setStatSaving] = useState(false);
  const [statModalError, setStatModalError] = useState<string | null>(null);

  const [endTarget, setEndTarget] = useState<HrStatutoryConfig | null>(null);
  const [endDate, setEndDate] = useState('');

  useEffect(() => { setStatPage(1); }, [statKind, statInactive]);

  const fetchStatutory = useCallback(async () => {
    const seq = ++statSeq.current;
    setStatFetching(true);
    setStatError(null);
    try {
      const sp = new URLSearchParams();
      if (statKind) sp.set('kind', statKind);
      if (statInactive) sp.set('include_inactive', '1');
      sp.set('page', String(statPage));
      sp.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(`/api/hr/statutory?${sp.toString()}`);
      if (seq !== statSeq.current) return;
      if (res.status === 401 || res.status === 403) { setLocked(true); return; }
      if (!res.ok) { setStatError("Couldn't load statutory configs"); return; }
      const json = await res.json();
      if (seq !== statSeq.current) return;
      setStatRows(Array.isArray(json?.rows) ? json.rows : []);
      setStatTotal(Number(json?.total) || 0);
    } catch {
      if (seq === statSeq.current) setStatError("Couldn't load statutory configs");
    } finally {
      if (seq === statSeq.current) { setStatFetching(false); setStatLoading(false); }
    }
  }, [statPage, statKind, statInactive]);

  useEffect(() => { if (tab === 'statutory') fetchStatutory(); }, [tab, fetchStatutory]);

  const submitStatCreate = async () => {
    if (!statForm.effective_from) { setStatModalError('An effective-from date is required.'); return; }
    const raw = statForm.config_json.trim();
    if (raw) {
      try {
        const v = JSON.parse(raw);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      } catch {
        setStatModalError('Config must be a valid JSON object — see the placeholder for this kind.');
        return;
      }
    }
    setStatSaving(true);
    setStatModalError(null);
    try {
      await apiJson('/api/hr/statutory', {
        method: 'POST',
        body: {
          kind: statForm.kind,
          state: statForm.state.trim(),
          employee_category: statForm.employee_category.trim(),
          effective_from: statForm.effective_from,
          effective_to: statForm.effective_to,
          config_json: raw || '{}',
        },
      });
      setShowStatCreate(false);
      setStatForm(emptyStatForm());
      fetchStatutory();
    } catch (e) {
      setStatModalError(e instanceof Error ? e.message : 'Could not create the config');
    } finally {
      setStatSaving(false);
    }
  };

  const submitEndDate = async () => {
    if (!endTarget) return;
    setStatSaving(true);
    setStatModalError(null);
    try {
      await apiJson('/api/hr/statutory', {
        method: 'PUT',
        body: { id: endTarget.id, effective_to: endDate },
      });
      setEndTarget(null);
      fetchStatutory();
    } catch (e) {
      setStatModalError(e instanceof Error ? e.message : 'Could not update the end date');
    } finally {
      setStatSaving(false);
    }
  };

  const toggleStatActive = async (row: HrStatutoryConfig) => {
    if (row.is_active) {
      const ok = confirm(
        `Deactivate this ${statKindMeta(row.kind).label} config? History is kept — the payroll compute will simply stop seeing it.`,
      );
      if (!ok) return;
    }
    setStatBusyId(row.id);
    setStatActionError(null);
    try {
      if (row.is_active) {
        const res = await api(`/api/hr/statutory?id=${encodeURIComponent(row.id)}`, { method: 'DELETE' });
        if (!res.ok) {
          const j = await res.json().catch(() => null);
          throw new Error(j?.error || 'Could not deactivate the config');
        }
      } else {
        await apiJson('/api/hr/statutory', { method: 'PUT', body: { id: row.id, is_active: 1 } });
      }
      fetchStatutory();
    } catch (e) {
      setStatActionError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setStatBusyId(null);
    }
  };

  /* ── Lock screen (adminOnly) ─────────────────────────────────────────── */
  if (locked) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
          <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
            <IndianRupee className="w-6 h-6" /> Payroll
          </h1>
          <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 text-sm text-[#6B5744]">
            Payroll is admin-only.
          </div>
        </div>
      </div>
    );
  }

  const selectedIsDraft = runDetail?.status === 'draft';

  /* ================================================================== */
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
            <IndianRupee className="w-6 h-6" /> Payroll
          </h1>
          <p className="text-[#8B7355] text-sm mt-1">
            Monthly runs, salary advances and statutory configs. Finalized runs are immutable payslips.
          </p>
        </div>

        {/* Tabs */}
        <TabScroller className="gap-2">
          {([['runs', 'Runs'], ['advances', 'Advances'], ['statutory', 'Statutory']] as const).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} className={chip(tab === key)}>{label}</button>
          ))}
        </TabScroller>

        {/* ════════════════ RUNS ════════════════ */}
        {tab === 'runs' && (
          <>
            {/* Create draft */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3 space-y-2">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="text-xs text-[#6B5744] block">Payroll month</label>
                  <input type="month" value={createPeriod} onChange={(e) => setCreatePeriod(e.target.value)}
                         className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                </div>
                <div className="flex-1 min-w-[180px]">
                  <label className="text-xs text-[#6B5744] block">Note (optional)</label>
                  <input value={createNote} onChange={(e) => setCreateNote(e.target.value)}
                         placeholder="e.g. includes festival week" className={inputCls} />
                </div>
                <button onClick={createRun} disabled={creating} className={btnPrimary}>
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create draft
                </button>
              </div>
              {createError && (
                <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">{createError}</div>
              )}
              <p className="text-[11px] text-[#8B7355]">
                One run per month per outlet. A draft can be computed any number of times; finalizing freezes it.
              </p>
            </div>

            {runsError && <ErrorBanner msg={runsError} onRetry={fetchRuns} />}

            {/* Runs table */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
              {runsLoading ? (
                <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                </div>
              ) : runs.length === 0 ? (
                <div className="p-6 text-center text-[#8B7355] text-sm">No payroll runs yet — create the first draft above.</div>
              ) : (
                <>
                  <div className={`overflow-x-auto ${runsFetching ? 'opacity-60' : ''}`}>
                    <table className="w-full text-sm">
                      <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                        <tr>
                          <th className="text-left py-2 px-3 font-medium">Period</th>
                          <th className="text-left py-2 px-3 font-medium">Outlet</th>
                          <th className="text-left py-2 px-3 font-medium">Status</th>
                          <th className="text-right py-2 px-3 font-medium">Payslips</th>
                          <th className="text-right py-2 px-3 font-medium">Gross</th>
                          <th className="text-right py-2 px-3 font-medium">Net</th>
                          <th className="text-left py-2 px-3 font-medium">Created</th>
                          <th className="text-left py-2 px-3 font-medium">Finalized</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((r) => {
                          const meta = payrollRunStatusMeta(r.status);
                          const t = runTotals(r);
                          return (
                            <tr key={r.id} onClick={() => selectRun(r.id)}
                                className={`border-t border-[#E8D5C4]/50 cursor-pointer hover:bg-[#FFF1E3] ${
                                  selectedRunId === r.id ? 'bg-[#FFF1E3]' : ''
                                }`}>
                              <td className="py-2 px-3 font-bold whitespace-nowrap">{r.period}</td>
                              <td className="py-2 px-3 text-xs">{r.outlet_id ? (outletNames.get(r.outlet_id) || r.outlet_id) : <span className="text-[#8B7355]">—</span>}</td>
                              <td className="py-2 px-3">
                                <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${meta.color}`}>{meta.label}</span>
                              </td>
                              <td className="py-2 px-3 text-right text-xs">{r.items.length}</td>
                              <td className="py-2 px-3 text-right font-mono text-xs whitespace-nowrap">{r.items.length ? inr(t.gross) : '—'}</td>
                              <td className="py-2 px-3 text-right font-mono text-xs whitespace-nowrap">{r.items.length ? inr(t.net) : '—'}</td>
                              <td className="py-2 px-3 text-xs whitespace-nowrap">{fmtIST(r.created_at)}<div className="text-[10px] text-[#8B7355]">{r.created_by}</div></td>
                              <td className="py-2 px-3 text-xs whitespace-nowrap">
                                {r.finalized_at ? (<>{fmtIST(r.finalized_at)}<div className="text-[10px] text-[#8B7355]">{r.finalized_by}</div></>) : <span className="text-[#8B7355]">—</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={runsPage} total={runsTotal} busy={runsFetching} onPage={setRunsPage} />
                </>
              )}
            </div>

            {/* Selected run detail */}
            {selectedRunId && (
              <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
                {detailLoading && !runDetail ? (
                  <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading run...
                  </div>
                ) : detailError ? (
                  <div className="p-4"><ErrorBanner msg={detailError} onRetry={() => fetchRunDetail(selectedRunId)} /></div>
                ) : runDetail ? (
                  <>
                    <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-wrap items-center justify-between gap-3 bg-[#FFF1E3]/60">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold">Run {runDetail.period}</span>
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${payrollRunStatusMeta(runDetail.status).color}`}>
                          {payrollRunStatusMeta(runDetail.status).label}
                        </span>
                        {runDetail.note && <span className="text-xs text-[#8B7355]">{runDetail.note}</span>}
                      </div>
                      {selectedIsDraft ? (
                        <div className="flex items-center gap-2">
                          <button onClick={computeRun} disabled={computing || finalizing} className={btnPrimary}>
                            {computing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calculator className="w-4 h-4" />}
                            {runDetail.items.length > 0 ? 'Recompute' : 'Compute'}
                          </button>
                          <button onClick={() => setShowFinalize(true)}
                                  disabled={computing || finalizing || runDetail.items.length === 0}
                                  title={runDetail.items.length === 0 ? 'Compute the run before finalizing' : undefined}
                                  className="inline-flex items-center gap-2 px-3 py-2 border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] rounded-lg text-sm font-medium disabled:opacity-50">
                            <Lock className="w-4 h-4" /> Finalize
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-[#6B5744] inline-flex items-center gap-1">
                          <Lock className="w-3.5 h-3.5" /> Finalized {runDetail.finalized_at ? fmtIST(runDetail.finalized_at) : ''} by {runDetail.finalized_by || '—'} — payslips are immutable.
                        </span>
                      )}
                    </div>

                    <div className="p-4 space-y-3">
                      {runActionError && (
                        <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">{runActionError}</div>
                      )}

                      {computing && (
                        <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2 text-sm text-[#6B5744] flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Computing payroll — replacing this draft&apos;s payslips from attendance, leave, salary structures, statutory configs and due advance installments…
                        </div>
                      )}

                      {finalizeInfo && (
                        <div className="rounded-lg border border-green-200 bg-green-50 text-green-800 px-3 py-2 text-sm flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                          Run finalized. {finalizeInfo.count} advance installment{finalizeInfo.count === 1 ? '' : 's'} marked recovered ({inr(finalizeInfo.amount)}).
                        </div>
                      )}

                      {/* Skipped-employees report — rendered honestly */}
                      {skipped !== null ? (
                        skipped.length === 0 ? (
                          <div className="rounded-lg border border-green-200 bg-green-50 text-green-800 px-3 py-2 text-sm">
                            Compute finished — {computedCount} payslip{computedCount === 1 ? '' : 's'} written, nobody skipped.
                          </div>
                        ) : (
                          <div className="rounded-lg border border-amber-200 bg-amber-50 overflow-hidden">
                            <div className="px-3 py-2 text-sm text-amber-900 font-medium">
                              Compute finished — {computedCount} payslip{computedCount === 1 ? '' : 's'} written, {skipped.length} employee{skipped.length === 1 ? '' : 's'} SKIPPED:
                            </div>
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead className="text-amber-900/70">
                                  <tr>
                                    <th className="text-left py-1 px-3 font-medium">Code</th>
                                    <th className="text-left py-1 px-3 font-medium">Employee</th>
                                    <th className="text-left py-1 px-3 font-medium">Reason</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {skipped.map((s) => (
                                    <tr key={s.employee_id} className="border-t border-amber-200/60">
                                      <td className="py-1 px-3 font-mono whitespace-nowrap">{s.employee_code || '—'}</td>
                                      <td className="py-1 px-3">{s.full_name || s.employee_id}</td>
                                      <td className="py-1 px-3 text-amber-900">{s.reason}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <div className="px-3 py-1.5 text-[11px] text-amber-800/80">
                              This list is also frozen into the audit trail with every compute.
                            </div>
                          </div>
                        )
                      ) : (
                        selectedIsDraft && runDetail.items.length > 0 && (
                          <p className="text-[11px] text-[#8B7355]">
                            Skipped-employee details for past computes live on the audit trail — recompute to see the report here.
                          </p>
                        )
                      )}

                      {/* Items table */}
                      {runDetail.items.length === 0 ? (
                        <p className="text-sm text-[#8B7355]">
                          {selectedIsDraft ? 'No payslips yet — compute the run to build them.' : 'This run has no payslip items.'}
                        </p>
                      ) : (
                        <div className="border border-[#E8D5C4] rounded-lg overflow-hidden">
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                                <tr>
                                  <th className="w-8"></th>
                                  <th className="text-left py-2 px-3 font-medium">Code</th>
                                  <th className="text-left py-2 px-3 font-medium">Employee</th>
                                  <th className="text-right py-2 px-3 font-medium">Paid days</th>
                                  <th className="text-right py-2 px-3 font-medium">LOP</th>
                                  <th className="text-right py-2 px-3 font-medium">OT</th>
                                  <th className="text-right py-2 px-3 font-medium">Gross</th>
                                  <th className="text-right py-2 px-3 font-medium">Net</th>
                                </tr>
                              </thead>
                              <tbody>
                                {runDetail.items.map((it) => {
                                  const open = expandedItemId === it.id;
                                  return (
                                    <Fragment key={it.id}>
                                      <tr onClick={() => setExpandedItemId(open ? null : it.id)}
                                          className="border-t border-[#E8D5C4]/50 cursor-pointer hover:bg-[#FFF1E3]">
                                        <td className="py-2 pl-3 text-[#8B7355]">
                                          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                        </td>
                                        <td className="py-2 px-3 text-xs font-mono whitespace-nowrap">{it.employee_code || '—'}</td>
                                        <td className="py-2 px-3 font-medium">{it.employee_name || <span className="text-[#8B7355]">(employee record missing)</span>}</td>
                                        <td className="py-2 px-3 text-right text-xs">{it.paid_days}</td>
                                        <td className="py-2 px-3 text-right text-xs">{it.lop_days}</td>
                                        <td className="py-2 px-3 text-right text-xs whitespace-nowrap">{fmtMin(it.overtime_minutes)}</td>
                                        <td className="py-2 px-3 text-right font-mono text-xs whitespace-nowrap">{inr(it.gross)}</td>
                                        <td className="py-2 px-3 text-right font-mono text-xs font-bold whitespace-nowrap">{inr(it.net)}</td>
                                      </tr>
                                      {open && (
                                        <tr>
                                          <td colSpan={8} className="p-0"><ItemDetail item={it} /></td>
                                        </tr>
                                      )}
                                    </Fragment>
                                  );
                                })}
                              </tbody>
                              <tfoot>
                                <tr className="border-t border-[#E8D5C4] bg-[#FFF8F0] text-xs font-bold">
                                  <td colSpan={6} className="py-2 px-3 text-right">Totals</td>
                                  <td className="py-2 px-3 text-right font-mono whitespace-nowrap">{inr(runTotals(runDetail).gross)}</td>
                                  <td className="py-2 px-3 text-right font-mono whitespace-nowrap">{inr(runTotals(runDetail).net)}</td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                ) : null}
              </div>
            )}
          </>
        )}

        {/* ════════════════ ADVANCES ════════════════ */}
        {tab === 'advances' && (
          <>
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <TabScroller className="gap-2 flex-1">
                  <button onClick={() => setAdvStatus('')} className={chip(advStatus === '')}>All</button>
                  {HR_ADVANCE_STATUSES.map((s) => (
                    <button key={s.key} onClick={() => setAdvStatus((p) => (p === s.key ? '' : s.key))} className={chip(advStatus === s.key)}>
                      {s.label}
                    </button>
                  ))}
                </TabScroller>
                <button onClick={() => { setAdvForm({ employee_id: '', requested_amount: '', reason: '' }); setAdvModalError(null); setShowNewAdvance(true); }}
                        className={btnPrimary}>
                  <Plus className="w-4 h-4" /> New request
                </button>
              </div>
            </div>

            {advError && <ErrorBanner msg={advError} onRetry={fetchAdvances} />}
            {advActionError && <ErrorBanner msg={advActionError} />}

            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
              {advLoading ? (
                <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                </div>
              ) : advRows.length === 0 ? (
                <div className="p-6 text-center text-[#8B7355] text-sm">
                  {advStatus ? 'No advances with this status.' : 'No salary advances yet.'}
                </div>
              ) : (
                <>
                  <div className={`overflow-x-auto ${advFetching ? 'opacity-60' : ''}`}>
                    <table className="w-full text-sm">
                      <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                        <tr>
                          <th className="w-8"></th>
                          <th className="text-left py-2 px-3 font-medium">Employee</th>
                          <th className="text-right py-2 px-3 font-medium">Requested</th>
                          <th className="text-right py-2 px-3 font-medium">Approved</th>
                          <th className="text-right py-2 px-3 font-medium">Installment</th>
                          <th className="text-right py-2 px-3 font-medium">Recovered</th>
                          <th className="text-left py-2 px-3 font-medium">Status</th>
                          <th className="text-left py-2 px-3 font-medium">Requested at</th>
                          <th className="text-right py-2 px-3 font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {advRows.map((a) => {
                          const meta = advanceStatusMeta(a.status);
                          const open = expandedAdvanceId === a.id;
                          const busy = advBusyId === a.id;
                          return (
                            <Fragment key={a.id}>
                              <tr className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]">
                                <td className="py-2 pl-3">
                                  <button onClick={() => setExpandedAdvanceId(open ? null : a.id)} className="text-[#8B7355]" title="Installment schedule">
                                    {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                  </button>
                                </td>
                                <td className="py-2 px-3">
                                  <span className="font-medium">{a.employee_name || <span className="text-[#8B7355]">(employee record missing)</span>}</span>
                                  {a.employee_code && <div className="text-[10px] text-[#8B7355] font-mono">{a.employee_code}</div>}
                                </td>
                                <td className="py-2 px-3 text-right font-mono text-xs whitespace-nowrap">{inr(a.requested_amount)}</td>
                                <td className="py-2 px-3 text-right font-mono text-xs whitespace-nowrap">{a.approved_amount > 0 ? inr(a.approved_amount) : '—'}</td>
                                <td className="py-2 px-3 text-right font-mono text-xs whitespace-nowrap">{a.installment_amount > 0 ? inr(a.installment_amount) : '—'}</td>
                                <td className="py-2 px-3 text-right font-mono text-xs whitespace-nowrap">{inr(a.recovered_amount)}</td>
                                <td className="py-2 px-3">
                                  <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${meta.color}`}>{meta.label}</span>
                                </td>
                                <td className="py-2 px-3 text-xs whitespace-nowrap">{fmtISTDate(a.requested_at)}</td>
                                <td className="py-2 px-3">
                                  <div className="flex items-center justify-end gap-1.5">
                                    {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#8B7355]" />}
                                    {a.status === 'pending' && (
                                      <>
                                        <button onClick={() => { setApproveTarget(a); setApproveAmt(String(a.requested_amount || '')); setApproveInst(''); setAdvModalError(null); }}
                                                disabled={busy} className={btnGhost}>
                                          <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                                        </button>
                                        <button onClick={() => { setRejectTarget(a); setRejectReason(''); setAdvModalError(null); }}
                                                disabled={busy}
                                                className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-red-200 bg-white hover:bg-red-50 text-red-700 rounded-lg text-xs font-medium disabled:opacity-40">
                                          <XCircle className="w-3.5 h-3.5" /> Reject
                                        </button>
                                      </>
                                    )}
                                    {a.status === 'approved' && (
                                      <button onClick={() => advanceAction(a, 'disburse')} disabled={busy} className={btnGhost}>
                                        <Banknote className="w-3.5 h-3.5" /> Disburse
                                      </button>
                                    )}
                                    {a.status === 'disbursed' && (
                                      <button onClick={() => advanceAction(a, 'close')} disabled={busy}
                                              title="Allowed once recovery has caught up with the approved amount"
                                              className={btnGhost}>
                                        <Lock className="w-3.5 h-3.5" /> Close
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                              {open && (
                                <tr>
                                  <td colSpan={9} className="p-0">
                                    <div className="p-3 bg-[#FFF8F0] border-t border-[#E8D5C4]/60">
                                      {a.installments.length === 0 ? (
                                        <p className="text-xs text-[#8B7355]">No installment schedule yet — it is generated when the advance is approved.</p>
                                      ) : (
                                        <div className="border border-[#E8D5C4] rounded-lg overflow-hidden bg-white max-w-xl">
                                          <div className="bg-[#FFF1E3] px-3 py-1.5 text-xs font-semibold text-[#6B5744]">Recovery schedule</div>
                                          <div className="overflow-x-auto">
                                            <table className="w-full text-xs">
                                              <thead className="text-[#8B7355]">
                                                <tr>
                                                  <th className="text-left py-1.5 px-3 font-medium">Period</th>
                                                  <th className="text-right py-1.5 px-3 font-medium">Amount</th>
                                                  <th className="text-left py-1.5 px-3 font-medium">Status</th>
                                                  <th className="text-left py-1.5 px-3 font-medium">Recovered</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {a.installments.map((inst) => {
                                                  const b = instBadge(inst.status);
                                                  return (
                                                    <tr key={inst.id} className="border-t border-[#E8D5C4]/50">
                                                      <td className="py-1.5 px-3 font-mono">{inst.period}</td>
                                                      <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">{inr(inst.amount)}</td>
                                                      <td className="py-1.5 px-3">
                                                        <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium border ${b.color}`}>{b.label}</span>
                                                      </td>
                                                      <td className="py-1.5 px-3 whitespace-nowrap">{inst.recovered_at ? fmtIST(inst.recovered_at) : '—'}</td>
                                                    </tr>
                                                  );
                                                })}
                                              </tbody>
                                            </table>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={advPage} total={advTotal} busy={advFetching} onPage={setAdvPage} />
                </>
              )}
            </div>
          </>
        )}

        {/* ════════════════ STATUTORY ════════════════ */}
        {tab === 'statutory' && (
          <>
            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <TabScroller className="gap-2 flex-1">
                  <button onClick={() => setStatKind('')} className={chip(statKind === '')}>All kinds</button>
                  {STATUTORY_KINDS.map((k) => (
                    <button key={k.key} onClick={() => setStatKind((p) => (p === k.key ? '' : k.key))} className={chip(statKind === k.key)}>
                      {k.label}
                    </button>
                  ))}
                </TabScroller>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-[#6B5744]">
                    <Toggle checked={statInactive} onChange={setStatInactive} size="sm" label="Show inactive configs" />
                    Show inactive
                  </label>
                  <button onClick={() => { setStatForm(emptyStatForm()); setStatModalError(null); setShowStatCreate(true); }} className={btnPrimary}>
                    <Plus className="w-4 h-4" /> Add config
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-[#8B7355]">
                Statutory rates are append-only: a wrong or changed rate gets a NEW forward-dated config — existing rows can only be ended, deactivated or reactivated.
              </p>
            </div>

            {statError && <ErrorBanner msg={statError} onRetry={fetchStatutory} />}
            {statActionError && <ErrorBanner msg={statActionError} />}

            <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
              {statLoading ? (
                <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                </div>
              ) : statRows.length === 0 ? (
                <div className="p-6 text-center text-[#8B7355] text-sm">
                  {statKind || statInactive ? 'No configs match these filters.' : 'No statutory configs yet — payroll deducts nothing until a rate row exists.'}
                </div>
              ) : (
                <>
                  <div className={`overflow-x-auto ${statFetching ? 'opacity-60' : ''}`}>
                    <table className="w-full text-sm">
                      <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                        <tr>
                          <th className="w-8"></th>
                          <th className="text-left py-2 px-3 font-medium">Kind</th>
                          <th className="text-left py-2 px-3 font-medium">State</th>
                          <th className="text-left py-2 px-3 font-medium">Category</th>
                          <th className="text-left py-2 px-3 font-medium">From</th>
                          <th className="text-left py-2 px-3 font-medium">To</th>
                          <th className="text-left py-2 px-3 font-medium">Active</th>
                          <th className="text-left py-2 px-3 font-medium">Created</th>
                          <th className="text-right py-2 px-3 font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statRows.map((c) => {
                          const meta = statKindMeta(c.kind);
                          const open = expandedConfigId === c.id;
                          const busy = statBusyId === c.id;
                          return (
                            <Fragment key={c.id}>
                              <tr className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]">
                                <td className="py-2 pl-3">
                                  <button onClick={() => setExpandedConfigId(open ? null : c.id)} className="text-[#8B7355]" title="Config JSON">
                                    {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                  </button>
                                </td>
                                <td className="py-2 px-3">
                                  <span className="font-medium">{meta.label}</span>
                                  {!meta.applied && <div className="text-[10px] text-[#8B7355]">recorded only (v1)</div>}
                                </td>
                                <td className="py-2 px-3 text-xs">{c.state || <span className="text-[#8B7355]">All India</span>}</td>
                                <td className="py-2 px-3 text-xs">{c.employee_category || <span className="text-[#8B7355]">All</span>}</td>
                                <td className="py-2 px-3 text-xs whitespace-nowrap">{fmtISTDate(c.effective_from)}</td>
                                <td className="py-2 px-3 text-xs whitespace-nowrap">{c.effective_to ? fmtISTDate(c.effective_to) : <span className="text-[#8B7355]">open</span>}</td>
                                <td className="py-2 px-3">
                                  <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                                    c.is_active ? 'bg-green-100 text-green-700 border-green-200' : 'bg-slate-100 text-slate-600 border-slate-200'
                                  }`}>
                                    {c.is_active ? 'Active' : 'Inactive'}
                                  </span>
                                </td>
                                <td className="py-2 px-3 text-xs whitespace-nowrap">{fmtISTDate(c.created_at)}<div className="text-[10px] text-[#8B7355]">{c.created_by}</div></td>
                                <td className="py-2 px-3">
                                  <div className="flex items-center justify-end gap-1.5">
                                    {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#8B7355]" />}
                                    <button onClick={() => { setEndTarget(c); setEndDate(c.effective_to || ''); setStatModalError(null); }}
                                            disabled={busy} className={btnGhost}>
                                      End date…
                                    </button>
                                    <button onClick={() => toggleStatActive(c)} disabled={busy}
                                            className={c.is_active
                                              ? 'inline-flex items-center gap-1 px-2.5 py-1.5 border border-red-200 bg-white hover:bg-red-50 text-red-700 rounded-lg text-xs font-medium disabled:opacity-40'
                                              : btnGhost}>
                                      {c.is_active ? 'Deactivate' : 'Reactivate'}
                                    </button>
                                  </div>
                                </td>
                              </tr>
                              {open && (
                                <tr>
                                  <td colSpan={9} className="p-0">
                                    <div className="p-3 bg-[#FFF8F0] border-t border-[#E8D5C4]/60">
                                      <div className="text-[11px] text-[#8B7355] mb-1">{meta.hint}</div>
                                      <pre className="p-3 bg-white border border-[#E8D5C4] rounded-lg overflow-auto max-h-60 text-[11px]">
                                        {(() => { try { return JSON.stringify(JSON.parse(c.config_json), null, 2); } catch { return c.config_json; } })()}
                                      </pre>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={statPage} total={statTotal} busy={statFetching} onPage={setStatPage} />
                </>
              )}
            </div>
          </>
        )}

        {/* ════════════════ MODALS ════════════════ */}

        {/* Finalize confirm */}
        {showFinalize && runDetail && (
          <Modal title={`Finalize payroll ${runDetail.period}`} onClose={() => { if (!finalizing) setShowFinalize(false); }}
                 footer={
                   <>
                     <button onClick={() => setShowFinalize(false)} disabled={finalizing}
                             className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">Cancel</button>
                     <button onClick={finalizeRun} disabled={finalizing} className={btnPrimary}>
                       {finalizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />} Finalize run
                     </button>
                   </>
                 }>
            <div className="space-y-3 text-sm">
              <p>
                This freezes <b>{runDetail.items.length}</b> payslip{runDetail.items.length === 1 ? '' : 's'} for{' '}
                <b>{runDetail.period}</b> — gross {inr(runTotals(runDetail).gross)}, net <b>{inr(runTotals(runDetail).net)}</b>.
              </p>
              <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 text-xs space-y-1">
                <p>· A finalized run is <b>immutable</b> — it can never be recomputed or edited.</p>
                <p>· Every advance installment these payslips deduct is marked <b>recovered</b> in the same step.</p>
                <p>· If installments changed since the last compute, finalize will refuse and ask for a recompute.</p>
              </div>
            </div>
          </Modal>
        )}

        {/* New advance request */}
        {showNewAdvance && (
          <Modal title="New advance request" onClose={() => { if (!advSaving) setShowNewAdvance(false); }}
                 footer={
                   <>
                     <button onClick={() => setShowNewAdvance(false)} disabled={advSaving}
                             className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">Cancel</button>
                     <button onClick={submitNewAdvance} disabled={advSaving} className={btnPrimary}>
                       {advSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                     </button>
                   </>
                 }>
            {advModalError && (
              <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">{advModalError}</div>
            )}
            <div>
              <label className="text-xs text-[#6B5744]">Employee *</label>
              <Combobox
                options={employeeOptions}
                value={advForm.employee_id ? employeeName(advForm.employee_id) : ''}
                onChange={(v) => setAdvForm({ ...advForm, employee_id: v })}
                placeholder="Pick employee"
              />
            </div>
            <div>
              <label className="text-xs text-[#6B5744]">Requested amount (₹) *</label>
              <input type="number" min="1" step="0.01" value={advForm.requested_amount}
                     onChange={(e) => setAdvForm({ ...advForm, requested_amount: e.target.value })}
                     placeholder="e.g. 10000" className={inputCls} />
            </div>
            <div>
              <label className="text-xs text-[#6B5744]">Reason</label>
              <textarea value={advForm.reason} onChange={(e) => setAdvForm({ ...advForm, reason: e.target.value })}
                        rows={2} placeholder="Why the advance is needed" className={inputCls} />
            </div>
          </Modal>
        )}

        {/* Approve advance */}
        {approveTarget && (
          <Modal title="Approve advance" onClose={() => { if (!advSaving) setApproveTarget(null); }}
                 footer={
                   <>
                     <button onClick={() => setApproveTarget(null)} disabled={advSaving}
                             className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">Cancel</button>
                     <button onClick={submitApprove} disabled={advSaving} className={btnPrimary}>
                       {advSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Approve
                     </button>
                   </>
                 }>
            {advModalError && (
              <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">{advModalError}</div>
            )}
            <p className="text-sm">
              <b>{approveTarget.employee_name || 'Employee'}</b>
              {approveTarget.employee_code && <span className="text-[#8B7355] font-mono text-xs"> · {approveTarget.employee_code}</span>}
              {' '}requested <b>{inr(approveTarget.requested_amount)}</b>
              {approveTarget.reason && <span className="text-[#8B7355]"> — {approveTarget.reason}</span>}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-[#6B5744]">Approved amount (₹) *</label>
                <input type="number" min="1" step="0.01" value={approveAmt}
                       onChange={(e) => setApproveAmt(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-[#6B5744]">Monthly installment (₹) *</label>
                <input type="number" min="1" step="0.01" value={approveInst}
                       onChange={(e) => setApproveInst(e.target.value)} placeholder="e.g. 2000" className={inputCls} />
              </div>
            </div>
            {approvePreview && (
              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2 text-xs text-[#6B5744]">
                Recovery schedule: <b>{approvePreview.n}</b> monthly installment{approvePreview.n === 1 ? '' : 's'} starting next
                month{approvePreview.n > 1 ? <> — last installment <b>{inr(approvePreview.last)}</b></> : null}. Deductions happen
                through payroll runs, never here.
              </div>
            )}
          </Modal>
        )}

        {/* Reject advance */}
        {rejectTarget && (
          <Modal title="Reject advance" onClose={() => { if (!advSaving) setRejectTarget(null); }}
                 footer={
                   <>
                     <button onClick={() => setRejectTarget(null)} disabled={advSaving}
                             className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">Cancel</button>
                     <button onClick={submitReject} disabled={advSaving}
                             className="inline-flex items-center gap-2 px-3 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                       {advSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />} Reject
                     </button>
                   </>
                 }>
            {advModalError && (
              <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">{advModalError}</div>
            )}
            <p className="text-sm">
              Rejecting <b>{inr(rejectTarget.requested_amount)}</b> requested by{' '}
              <b>{rejectTarget.employee_name || 'employee'}</b>. The reason is kept on the audit trail.
            </p>
            <div>
              <label className="text-xs text-[#6B5744]">Reason *</label>
              <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={2}
                        placeholder="Why this request is rejected" className={inputCls} autoFocus />
            </div>
          </Modal>
        )}

        {/* Add statutory config */}
        {showStatCreate && (
          <Modal title="Add statutory config" wide onClose={() => { if (!statSaving) setShowStatCreate(false); }}
                 footer={
                   <>
                     <button onClick={() => setShowStatCreate(false)} disabled={statSaving}
                             className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">Cancel</button>
                     <button onClick={submitStatCreate} disabled={statSaving} className={btnPrimary}>
                       {statSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                     </button>
                   </>
                 }>
            {statModalError && (
              <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">{statModalError}</div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-[#6B5744]">Kind *</label>
                <select value={statForm.kind} onChange={(e) => setStatForm({ ...statForm, kind: e.target.value })} className={inputCls}>
                  {STATUTORY_KINDS.map((k) => (
                    <option key={k.key} value={k.key}>{k.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-[#6B5744]">State</label>
                <input value={statForm.state} onChange={(e) => setStatForm({ ...statForm, state: e.target.value })}
                       placeholder="Blank = all India" className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-[#6B5744]">Employee category</label>
                <input value={statForm.employee_category}
                       onChange={(e) => setStatForm({ ...statForm, employee_category: e.target.value })}
                       placeholder="Blank = all" className={inputCls} />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-[#6B5744]">Effective from *</label>
                <input type="date" value={statForm.effective_from}
                       onChange={(e) => setStatForm({ ...statForm, effective_from: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className="text-xs text-[#6B5744]">Effective to (blank = open)</label>
                <input type="date" value={statForm.effective_to}
                       onChange={(e) => setStatForm({ ...statForm, effective_to: e.target.value })} className={inputCls} />
              </div>
            </div>
            <div>
              <label className="text-xs text-[#6B5744]">Config (JSON object)</label>
              <textarea value={statForm.config_json}
                        onChange={(e) => setStatForm({ ...statForm, config_json: e.target.value })}
                        rows={5} placeholder={statKindMeta(statForm.kind).placeholder}
                        className={`${inputCls} font-mono text-xs`} spellCheck={false} />
              <p className="text-[11px] text-[#8B7355] mt-1">{statKindMeta(statForm.kind).hint}</p>
            </div>
            <p className="text-[11px] text-[#8B7355]">
              Creating a config for a scope that already has an open row automatically closes the old row to the day before this start date — old rates are never edited.
            </p>
          </Modal>
        )}

        {/* End / reopen statutory config */}
        {endTarget && (
          <Modal title={`${statKindMeta(endTarget.kind).label} — end date`} onClose={() => { if (!statSaving) setEndTarget(null); }}
                 footer={
                   <>
                     <button onClick={() => setEndTarget(null)} disabled={statSaving}
                             className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">Cancel</button>
                     <button onClick={submitEndDate} disabled={statSaving} className={btnPrimary}>
                       {statSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                     </button>
                   </>
                 }>
            {statModalError && (
              <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">{statModalError}</div>
            )}
            <p className="text-sm">
              In force since <b>{fmtISTDate(endTarget.effective_from)}</b>
              {endTarget.state ? <> in <b>{endTarget.state}</b></> : ' (all India)'}.
              Set the last day this config applies, or clear the date to reopen it.
            </p>
            <div>
              <label className="text-xs text-[#6B5744]">Effective to (blank = open)</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputCls} />
            </div>
          </Modal>
        )}

      </div>
    </div>
  );
}
