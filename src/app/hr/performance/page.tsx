'use client';

/**
 * HR — Performance (Phase 6, mgmtOnly via page-catalog; the APIs are the boundary).
 *
 * Contract: docs/HRMS_DECISIONS.md. Two surfaces on one page:
 *  · KPIs — the weighted scoring dimensions (hr_kpis). Reads are management-
 *    tier; every MUTATION is admin-only (canAdminHr) and the API re-checks —
 *    hiding the controls for non-admins is UX, never the boundary.
 *    Deactivation is SOFT (is_active = 0): old reviews keep their frozen
 *    scores; only the score entry rows hide the KPI.
 *  · Reviews — IMMUTABLE entries (the API has no edit/delete by design; a
 *    correction is a new period entry). The New Review modal scores every
 *    ACTIVE KPI 0–10; the overall preview mirrors the server's
 *    weight-weighted mean, but the stored value is always computed
 *    server-side.
 *
 * History renders the overall trend as PLAIN NUMBERS — deliberately no
 * recharts on this page. Structure copied from the canonical HR list page
 * (src/app/hr/employees/page.tsx): race-guarded fetches, house filter card,
 * house safe-modal shell, portaled Combobox for dropdowns in modals.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Gauge,
  Target,
  TrendingUp,
  Plus,
  Pencil,
  Search,
  X,
  Loader2,
  Save,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtISTShort, todayIST } from '@/lib/format-date';
import Combobox, { type ComboOption } from '@/components/Combobox';
import Toggle from '@/components/Toggle';
import TabScroller from '@/components/TabScroller';
import { canAdminHr, type HrKpi, type HrPerformanceReview } from '@/lib/hr';
import type { SessionUser } from '@/lib/auth';

const PAGE_SIZE = 25;

/* ------------------------------------------------------------------ *
 * Row shapes + local vocab
 * ------------------------------------------------------------------ */

/** GET /api/hr/performance row: r.* LEFT JOINed to the employee's names —
 *  a dangling employee_id degrades to blank, never drops the review. */
interface ReviewRow extends HrPerformanceReview {
  employee_name: string | null;
  employee_code: string | null;
}

/** The slice of GET /api/hr/employees rows the pickers need. */
interface EmpRow {
  id: string;
  employee_code: string;
  full_name: string;
}

/** One parsed scores_json entry ([{kpi_id, score, note}]). */
interface ScoreEntry {
  kpi_id: string;
  score: number;
  note?: string;
}

/** Review kinds (db.ts column comment; the API validates the same set). */
const REVIEW_KINDS = [
  { key: 'monthly', label: 'Monthly', color: 'bg-sky-100 text-sky-700 border-sky-200' },
  { key: 'quarterly', label: 'Quarterly', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  { key: 'annual', label: 'Annual', color: 'bg-purple-100 text-purple-700 border-purple-200' },
] as const;
type ReviewKind = (typeof REVIEW_KINDS)[number]['key'];

function kindMeta(key: string) {
  return (
    REVIEW_KINDS.find(k => k.key === key) ?? {
      key: 'monthly' as ReviewKind,
      label: key || 'Monthly',
      color: 'bg-slate-100 text-slate-600 border-slate-200',
    }
  );
}

/** Parse a scores_json value defensively (string or array). */
function parseScoresJson(raw: unknown): ScoreEntry[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is ScoreEntry =>
        !!e && typeof e === 'object' && typeof (e as { kpi_id?: unknown }).kpi_id === 'string',
    );
  } catch {
    return [];
  }
}

/** Plain-number rendering for an overall/score (7.5, not 7.50). */
function fmtScore(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return String(Math.round(v * 100) / 100);
}

/** Map thrown fetch errors to venue-friendly copy (server messages are generic). */
function niceErr(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : '';
  if (/403|forbidden/i.test(msg)) return 'You do not have permission for this action.';
  if (/401|unauthor/i.test(msg)) return 'Your session has expired — sign in again.';
  return msg && !/^HTTP \d+$/.test(msg) ? msg : fallback;
}

const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';

export default function HrPerformancePage() {
  // Who am I — KPI mutation controls render only for admins (the API
  // re-checks server-side; hiding is UX, not the boundary).
  const [me, setMe] = useState<SessionUser | null>(null);
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setMe(j?.user || null))
      .catch(() => {});
  }, []);
  const isAdmin = canAdminHr(me);

  /* ── KPI master ─────────────────────────────────────────────────────── */
  const [kpis, setKpis] = useState<HrKpi[]>([]);
  const [kpisLoading, setKpisLoading] = useState(true);
  const [kpisError, setKpisError] = useState<string | null>(null);
  const [kpiBusyId, setKpiBusyId] = useState<string | null>(null);

  const fetchKpis = useCallback(async () => {
    setKpisError(null);
    try {
      const res = await fetch('/api/hr/kpis?include_inactive=1');
      if (!res.ok) {
        setKpisError(res.status === 401 || res.status === 403
          ? 'You need management access to view KPIs.'
          : "Couldn't load KPIs");
        return;
      }
      const j = await res.json();
      setKpis(Array.isArray(j?.kpis) ? j.kpis : []);
    } catch {
      setKpisError("Couldn't load KPIs");
    } finally {
      setKpisLoading(false);
    }
  }, []);
  useEffect(() => { fetchKpis(); }, [fetchKpis]);

  const activeKpis = useMemo(() => kpis.filter(k => k.is_active === 1), [kpis]);
  const kpiById = useMemo(() => new Map(kpis.map(k => [k.id, k])), [kpis]);

  // KPI add/edit modal (admin only)
  const [showKpiModal, setShowKpiModal] = useState(false);
  const [kpiEditing, setKpiEditing] = useState<HrKpi | null>(null);
  const [kpiName, setKpiName] = useState('');
  const [kpiWeight, setKpiWeight] = useState('1');
  const [kpiSaving, setKpiSaving] = useState(false);
  const [kpiError, setKpiError] = useState<string | null>(null);

  const openKpiModal = (k: HrKpi | null) => {
    setKpiEditing(k);
    setKpiName(k?.name ?? '');
    setKpiWeight(k ? String(k.weight) : '1');
    setKpiError(null);
    setShowKpiModal(true);
  };

  const saveKpi = async () => {
    const name = kpiName.trim();
    if (!name) { setKpiError('KPI name is required.'); return; }
    const w = Number(kpiWeight.trim() || '1');
    if (!Number.isFinite(w) || w <= 0) {
      setKpiError('Weight must be a number greater than 0.');
      return;
    }
    setKpiSaving(true);
    setKpiError(null);
    try {
      if (kpiEditing) {
        await apiJson('/api/hr/kpis', { method: 'PUT', body: { id: kpiEditing.id, name, weight: w } });
      } else {
        await apiJson('/api/hr/kpis', { method: 'POST', body: { name, weight: w } });
      }
      setShowKpiModal(false);
      fetchKpis();
    } catch (e) {
      setKpiError(niceErr(e, "Couldn't save the KPI"));
    } finally {
      setKpiSaving(false);
    }
  };

  const toggleKpi = async (k: HrKpi, next: boolean) => {
    setKpiBusyId(k.id);
    setKpisError(null);
    try {
      await apiJson('/api/hr/kpis', { method: 'PUT', body: { id: k.id, is_active: next } });
      await fetchKpis();
    } catch (e) {
      setKpisError(niceErr(e, "Couldn't update the KPI"));
    } finally {
      setKpiBusyId(null);
    }
  };

  /* ── Employee picker data ───────────────────────────────────────────── */
  const [employees, setEmployees] = useState<EmpRow[]>([]);
  useEffect(() => {
    fetch('/api/hr/employees?pageSize=100')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setEmployees(Array.isArray(j?.rows) ? j.rows : []))
      .catch(() => {});
  }, []);
  const empById = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees]);
  const empOptions = useMemo<ComboOption[]>(
    () => employees.map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code })),
    [employees],
  );
  const empFilterOptions = useMemo<ComboOption[]>(
    () => [{ value: '', label: 'All employees' }, ...empOptions],
    [empOptions],
  );

  /* ── Review history list ────────────────────────────────────────────── */
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);   // first paint only
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [empFilter, setEmpFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Race guard: a stale response must never overwrite a newer one.
  const fetchSeq = useRef(0);

  useEffect(() => { setPage(1); setExpandedId(null); }, [empFilter, kindFilter]);

  const fetchReviews = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setFetching(true);
    setError(null);
    try {
      const sp = new URLSearchParams();
      if (empFilter) sp.set('employee_id', empFilter);
      if (kindFilter) sp.set('kind', kindFilter);
      sp.set('page', String(page));
      sp.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(`/api/hr/performance?${sp.toString()}`);
      if (seq !== fetchSeq.current) return;
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403
          ? 'You need management access to view performance reviews.'
          : "Couldn't load performance reviews");
        return;
      }
      const json = await res.json();
      if (seq !== fetchSeq.current) return;
      setRows(Array.isArray(json?.rows) ? json.rows : []);
      setTotal(Number(json?.total) || 0);
    } catch {
      if (seq === fetchSeq.current) setError("Couldn't load performance reviews");
    } finally {
      if (seq === fetchSeq.current) { setFetching(false); setLoading(false); }
    }
  }, [empFilter, kindFilter, page]);

  useEffect(() => { fetchReviews(); }, [fetchReviews]);

  /** Overall trend for the filtered employee — this page of results, oldest
   *  first, rendered as PLAIN NUMBERS (no charts on this page by design). */
  const trend = useMemo(() => {
    if (!empFilter) return [];
    return [...rows].sort((a, b) =>
      a.period === b.period ? a.created_at.localeCompare(b.created_at) : a.period.localeCompare(b.period),
    );
  }, [empFilter, rows]);

  /* ── New Review modal ───────────────────────────────────────────────── */
  const [showReview, setShowReview] = useState(false);
  const [revEmp, setRevEmp] = useState('');
  const [revKind, setRevKind] = useState<ReviewKind>('monthly');
  const [revMonth, setRevMonth] = useState('');
  const [revYear, setRevYear] = useState('');
  const [revQuarter, setRevQuarter] = useState('1');
  const [scores, setScores] = useState<Record<string, { score: string; note: string }>>({});
  const [revRemarks, setRevRemarks] = useState('');
  const [revSaving, setRevSaving] = useState(false);
  const [revError, setRevError] = useState<string | null>(null);

  const openReview = () => {
    const today = todayIST(); // 'YYYY-MM-DD' (IST — the house calendar)
    setRevEmp(empFilter || '');
    setRevKind('monthly');
    setRevMonth(today.slice(0, 7));
    setRevYear(today.slice(0, 4));
    setRevQuarter('1');
    setScores({});
    setRevRemarks('');
    setRevError(null);
    setShowReview(true);
  };

  const setScore = (kpiId: string, patch: Partial<{ score: string; note: string }>) => {
    setScores(prev => {
      const cur = prev[kpiId] ?? { score: '', note: '' };
      return { ...prev, [kpiId]: { ...cur, ...patch } };
    });
  };

  /** Client-side preview of the server's weight-weighted mean (the stored
   *  value is always computed server-side — this is a preview only). */
  const overallPreview = useMemo(() => {
    let weighted = 0, weightSum = 0, plain = 0, n = 0;
    for (const k of activeKpis) {
      const raw = (scores[k.id]?.score ?? '').trim();
      if (raw === '') continue;
      const v = Number(raw);
      if (!Number.isFinite(v)) return null;
      const w = Number(k.weight) > 0 ? Number(k.weight) : 0;
      weighted += w * v;
      weightSum += w;
      plain += v;
      n++;
    }
    if (n === 0) return null;
    const overall = weightSum > 0 ? weighted / weightSum : plain / n;
    return Math.round(overall * 100) / 100;
  }, [activeKpis, scores]);

  const saveReview = async () => {
    if (!revEmp) { setRevError('Pick an employee.'); return; }
    let period = '';
    if (revKind === 'monthly') {
      if (!/^\d{4}-\d{2}$/.test(revMonth)) { setRevError('Pick the review month.'); return; }
      period = revMonth;
    } else if (revKind === 'quarterly') {
      if (!/^\d{4}$/.test(revYear.trim())) { setRevError('Enter a 4-digit year.'); return; }
      period = `${revYear.trim()}-Q${revQuarter}`;
    } else {
      if (!/^\d{4}$/.test(revYear.trim())) { setRevError('Enter a 4-digit year.'); return; }
      period = revYear.trim();
    }
    const entries: { kpi_id: string; score: number; note: string }[] = [];
    for (const k of activeKpis) {
      const raw = (scores[k.id]?.score ?? '').trim();
      if (raw === '') continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || v > 10) {
        setRevError(`Score for "${k.name}" must be between 0 and 10.`);
        return;
      }
      entries.push({ kpi_id: k.id, score: v, note: (scores[k.id]?.note ?? '').trim() });
    }
    if (entries.length === 0) { setRevError('Enter at least one KPI score.'); return; }

    setRevSaving(true);
    setRevError(null);
    try {
      await apiJson('/api/hr/performance', {
        method: 'POST',
        body: {
          employee_id: revEmp,
          period,
          kind: revKind,
          scores_json: entries,
          remarks: revRemarks.trim(),
        },
      });
      setShowReview(false);
      fetchReviews();
    } catch (e) {
      setRevError(niceErr(e, "Couldn't record the review"));
    } finally {
      setRevSaving(false);
    }
  };

  /* ── Pagination derived ─────────────────────────────────────────────── */
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromN = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const toN = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <Gauge className="w-6 h-6" /> Performance
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              KPI-weighted reviews{loading ? '' : ` — ${total} review${total === 1 ? '' : 's'}`}. Reviews are
              final once saved; record a correction as a new period entry.
            </p>
          </div>
          <button onClick={openReview}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" /> New Review
          </button>
        </div>

        {/* KPI master card */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow">
          <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-bold text-[#2D1B0E] flex items-center gap-2">
              <Target className="w-4 h-4 text-[#af4408]" /> KPIs
              <span className="text-xs font-normal text-[#8B7355]">
                {kpisLoading ? '' : `${activeKpis.length} active of ${kpis.length}`}
              </span>
            </h2>
            {isAdmin ? (
              <button onClick={() => openKpiModal(null)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium">
                <Plus className="w-3.5 h-3.5" /> Add KPI
              </button>
            ) : (
              <span className="text-[11px] text-[#8B7355]">KPI changes are admin-only.</span>
            )}
          </div>

          {kpisError && (
            <div className="m-3 rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
              <span>{kpisError}</span>
              <button onClick={() => fetchKpis()}
                      className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
                Retry
              </button>
            </div>
          )}

          {kpisLoading ? (
            <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          ) : kpis.length === 0 ? (
            <div className="p-6 text-center text-[#8B7355] text-sm">
              No KPIs yet{isAdmin ? ' — add the scoring dimensions before recording reviews.' : ' — an admin adds the scoring dimensions first.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                  <tr>
                    <th className="text-left py-2 px-3 font-medium">KPI</th>
                    <th className="text-left py-2 px-3 font-medium">Weight</th>
                    <th className="text-left py-2 px-3 font-medium">Active</th>
                    {isAdmin && <th className="text-left py-2 px-3 font-medium w-16"></th>}
                  </tr>
                </thead>
                <tbody>
                  {kpis.map(k => (
                    <tr key={k.id} className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3] ${k.is_active ? '' : 'opacity-60'}`}>
                      <td className="py-2 px-3 font-medium">{k.name}</td>
                      <td className="py-2 px-3 text-xs font-mono">{fmtScore(k.weight)}</td>
                      <td className="py-2 px-3">
                        <Toggle
                          size="sm"
                          checked={k.is_active === 1}
                          disabled={!isAdmin || kpiBusyId === k.id}
                          onChange={next => toggleKpi(k, next)}
                          label={`${k.name} active`}
                        />
                      </td>
                      {isAdmin && (
                        <td className="py-2 px-3">
                          <button onClick={() => openKpiModal(k)} title="Edit KPI"
                                  className="p-1.5 border border-[#E8D5C4] rounded-lg text-[#6B5744] hover:bg-[#FFF1E3]">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Search className="w-4 h-4 text-[#8B7355]" />
              <span className="text-xs text-[#6B5744]">Employee</span>
            </div>
            <div className="w-full sm:w-72">
              <Combobox
                options={empFilterOptions}
                value={empFilter ? (empById.get(empFilter)?.full_name || '') : ''}
                onChange={v => setEmpFilter(v)}
                placeholder="All employees"
              />
            </div>
          </div>
          <TabScroller className="gap-2">
            <button onClick={() => setKindFilter('')}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                      kindFilter === ''
                        ? 'bg-[#af4408] text-white border-[#af4408]'
                        : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                    }`}>
              All kinds
            </button>
            {REVIEW_KINDS.map(k => (
              <button key={k.key} onClick={() => setKindFilter(prev => (prev === k.key ? '' : k.key))}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                        kindFilter === k.key
                          ? 'bg-[#af4408] text-white border-[#af4408]'
                          : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                      }`}>
                {k.label}
              </button>
            ))}
          </TabScroller>
        </div>

        {/* Error banner */}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
            <span>{error}</span>
            <button onClick={() => fetchReviews()}
                    className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
              Retry
            </button>
          </div>
        )}

        {/* History */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          {/* Trend strip — plain numbers, oldest → newest, for the filtered employee */}
          {empFilter && !loading && trend.length > 0 && (
            <div className="px-3 py-2 border-b border-[#E8D5C4] bg-[#FFF8F0] flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-[#6B5744] inline-flex items-center gap-1">
                <TrendingUp className="w-3.5 h-3.5 text-[#af4408]" /> Overall trend
              </span>
              {trend.map((t, i) => {
                const prev = i > 0 ? Number(trend[i - 1].overall) : null;
                const cur = Number(t.overall);
                return (
                  <span key={t.id}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-[#E8D5C4] bg-white text-[11px] text-[#6B5744]">
                    {t.period}
                    <b className="text-[#2D1B0E]">{fmtScore(t.overall)}</b>
                    {prev !== null && (
                      cur > prev
                        ? <ArrowUpRight className="w-3 h-3 text-green-600" />
                        : cur < prev
                          ? <ArrowDownRight className="w-3 h-3 text-rose-600" />
                          : <Minus className="w-3 h-3 text-slate-400" />
                    )}
                  </span>
                );
              })}
              <span className="text-[10px] text-[#8B7355]">(this page of results, oldest → newest)</span>
            </div>
          )}

          {loading ? (
            <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-center text-[#8B7355] text-sm">
              {empFilter || kindFilter ? 'No reviews match these filters.' : 'No reviews yet — record the first one.'}
            </div>
          ) : (
            <>
              <div className={`overflow-x-auto ${fetching ? 'opacity-60' : ''}`}>
                <table className="w-full text-sm">
                  <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium">Employee</th>
                      <th className="text-left py-2 px-3 font-medium">Period</th>
                      <th className="text-left py-2 px-3 font-medium">Kind</th>
                      <th className="text-left py-2 px-3 font-medium">Overall</th>
                      <th className="text-left py-2 px-3 font-medium">Reviewed by</th>
                      <th className="text-left py-2 px-3 font-medium">Recorded</th>
                      <th className="text-left py-2 px-3 font-medium w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => {
                      const km = kindMeta(r.kind);
                      const open = expandedId === r.id;
                      const entries = open ? parseScoresJson(r.scores_json) : [];
                      return (
                        <Fragment key={r.id}>
                          <tr className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]">
                            <td className="py-2 px-3">
                              <span className="font-bold">{r.employee_name || <span className="text-[#8B7355] font-normal">—</span>}</span>
                              {r.employee_code && (
                                <div className="text-[10px] font-mono text-[#8B7355]">{r.employee_code}</div>
                              )}
                            </td>
                            <td className="py-2 px-3 text-xs font-mono whitespace-nowrap">{r.period}</td>
                            <td className="py-2 px-3">
                              <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${km.color}`}>
                                {km.label}
                              </span>
                            </td>
                            <td className="py-2 px-3 font-bold text-[#af4408]">{fmtScore(r.overall)}</td>
                            <td className="py-2 px-3 text-xs">{r.reviewed_by || <span className="text-[#8B7355]">—</span>}</td>
                            <td className="py-2 px-3 text-xs whitespace-nowrap">{fmtISTShort(r.created_at)}</td>
                            <td className="py-2 px-3">
                              <button onClick={() => setExpandedId(open ? null : r.id)}
                                      title={open ? 'Hide scores' : 'Show scores'}
                                      className="p-1.5 border border-[#E8D5C4] rounded-lg text-[#6B5744] hover:bg-white">
                                {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                              </button>
                            </td>
                          </tr>
                          {open && (
                            <tr className="border-t border-[#E8D5C4]/50 bg-[#FFF8F0]">
                              <td colSpan={7} className="py-3 px-4">
                                {entries.length === 0 ? (
                                  <div className="text-xs text-[#8B7355]">No per-KPI scores recorded.</div>
                                ) : (
                                  <div className="space-y-1.5">
                                    {entries.map((s, i) => {
                                      const k = kpiById.get(s.kpi_id);
                                      return (
                                        <div key={`${s.kpi_id}-${i}`} className="flex flex-wrap items-baseline gap-2 text-xs">
                                          <span className="font-medium text-[#2D1B0E]">
                                            {k?.name || <span className="text-[#8B7355]">(removed KPI)</span>}
                                          </span>
                                          <span className="font-mono font-bold text-[#af4408]">{fmtScore(s.score)}</span>
                                          <span className="text-[#8B7355]">/ 10</span>
                                          {s.note && <span className="text-[#6B5744]">— {s.note}</span>}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                                {r.remarks && (
                                  <div className="mt-2 pt-2 border-t border-[#E8D5C4]/60 text-xs text-[#6B5744]">
                                    <span className="font-semibold text-[#8B7355]">Remarks: </span>{r.remarks}
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
              </div>
              <div className="px-3 py-2 border-t border-[#E8D5C4] flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-[#8B7355]">Showing {fromN}–{toN} of {total}</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1 || fetching}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40">
                    <ChevronLeft className="w-3.5 h-3.5" /> Prev
                  </button>
                  <span className="text-xs text-[#6B5744]">Page {page} of {pageCount}</span>
                  <button onClick={() => setPage(p => Math.min(pageCount, p + 1))} disabled={page >= pageCount || fetching}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40">
                    Next <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* KPI add/edit modal — house safe-modal shell */}
        {showKpiModal && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-sm shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">{kpiEditing ? 'Edit KPI' : 'Add KPI'}</h2>
                <button onClick={() => { if (!kpiSaving) setShowKpiModal(false); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {kpiError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {kpiError}
                  </div>
                )}
                <div>
                  <label className="text-xs text-[#6B5744]">Name *</label>
                  <input value={kpiName} onChange={e => setKpiName(e.target.value)}
                         placeholder="e.g. Punctuality" className={inputCls} autoFocus />
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Weight *</label>
                  <input type="number" min={0.1} step={0.1} value={kpiWeight}
                         onChange={e => setKpiWeight(e.target.value)} className={inputCls} />
                  <p className="text-[11px] text-[#8B7355] mt-1">
                    A review&apos;s overall is the weight-weighted mean of its scores — heavier KPIs count more.
                  </p>
                </div>
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setShowKpiModal(false)} disabled={kpiSaving}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={saveKpi} disabled={kpiSaving}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {kpiSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* New Review modal — house safe-modal shell */}
        {showReview && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-xl shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">New Review</h2>
                <button onClick={() => { if (!revSaving) setShowReview(false); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {revError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {revError}
                  </div>
                )}

                <div>
                  <label className="text-xs text-[#6B5744]">Employee *</label>
                  <Combobox
                    options={empOptions}
                    value={revEmp ? (empById.get(revEmp)?.full_name || '') : ''}
                    onChange={v => setRevEmp(v)}
                    placeholder="Pick employee"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Kind</label>
                    <select value={revKind} onChange={e => setRevKind(e.target.value as ReviewKind)}
                            className={inputCls}>
                      {REVIEW_KINDS.map(k => (
                        <option key={k.key} value={k.key}>{k.label}</option>
                      ))}
                    </select>
                  </div>
                  {revKind === 'monthly' ? (
                    <div>
                      <label className="text-xs text-[#6B5744]">Month *</label>
                      <input type="month" value={revMonth} onChange={e => setRevMonth(e.target.value)}
                             className={inputCls} />
                    </div>
                  ) : revKind === 'quarterly' ? (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-[#6B5744]">Year *</label>
                        <input value={revYear} onChange={e => setRevYear(e.target.value)}
                               placeholder="2026" inputMode="numeric" className={inputCls} />
                      </div>
                      <div>
                        <label className="text-xs text-[#6B5744]">Quarter</label>
                        <select value={revQuarter} onChange={e => setRevQuarter(e.target.value)}
                                className={inputCls}>
                          {['1', '2', '3', '4'].map(qn => (
                            <option key={qn} value={qn}>Q{qn}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <label className="text-xs text-[#6B5744]">Year *</label>
                      <input value={revYear} onChange={e => setRevYear(e.target.value)}
                             placeholder="2026" inputMode="numeric" className={inputCls} />
                    </div>
                  )}
                </div>

                {/* Scores per active KPI */}
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide">
                    Scores (0–10)
                  </div>
                  {activeKpis.length === 0 ? (
                    <div className="text-sm text-[#8B7355]">
                      No active KPIs — {isAdmin ? 'add KPIs above before recording a review.' : 'an admin adds KPIs before reviews can be recorded.'}
                    </div>
                  ) : (
                    activeKpis.map(k => (
                      <div key={k.id} className="flex flex-wrap sm:flex-nowrap items-center gap-2">
                        <div className="w-full sm:w-44 shrink-0">
                          <div className="text-sm font-medium">{k.name}</div>
                          <div className="text-[10px] text-[#8B7355]">weight {fmtScore(k.weight)}</div>
                        </div>
                        <input
                          type="number" min={0} max={10} step={0.5}
                          value={scores[k.id]?.score ?? ''}
                          onChange={e => setScore(k.id, { score: e.target.value })}
                          placeholder="—"
                          className="w-20 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm"
                        />
                        <input
                          value={scores[k.id]?.note ?? ''}
                          onChange={e => setScore(k.id, { note: e.target.value })}
                          placeholder="Note (optional)"
                          className="flex-1 min-w-[120px] px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm"
                        />
                      </div>
                    ))
                  )}
                </div>

                {/* Computed overall preview */}
                <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2 flex items-center justify-between">
                  <span className="text-xs text-[#6B5744]">Computed overall (weighted)</span>
                  <span className="font-bold text-lg text-[#af4408]">
                    {overallPreview === null ? '—' : fmtScore(overallPreview)}
                  </span>
                </div>
                <p className="text-[11px] text-[#8B7355] -mt-2">
                  Preview only — the saved value is computed on the server from the same weights.
                </p>

                <div>
                  <label className="text-xs text-[#6B5744]">Remarks</label>
                  <textarea value={revRemarks} onChange={e => setRevRemarks(e.target.value)}
                            rows={2} placeholder="Overall remarks (optional)" className={inputCls} />
                </div>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setShowReview(false)} disabled={revSaving}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={saveReview} disabled={revSaving || activeKpis.length === 0}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {revSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save Review
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
