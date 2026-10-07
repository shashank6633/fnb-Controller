'use client';

/**
 * ROSTER READINESS PANEL — /hr/roster, above the week grid.
 *
 * Production measured 2026-10-06: 129 employees on rolls, 128 with NO
 * department, ZERO hr_shifts, ZERO hr_rosters rows ever. So BLOCKED is the
 * ordinary case, not the exception, and the whole job of this panel is to say
 * exactly what is missing and where it is fixed — a manager cannot learn any of
 * that from an empty grid.
 *
 * THE VERDICT IS NOT COMPUTED HERE. It comes from GET /api/hr/roster/readiness,
 * which runs the generator's own generateRosterPlan per department. A second
 * opinion written in the UI is how a panel comes to say READY about a week that
 * then refuses.
 *
 * Refusal messages are rendered VERBATIM — the server already writes them for a
 * human, and paraphrasing one in the UI is how the specific sentence ("128 of
 * 129 employees have no department") turns back into "something is missing".
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { refusalFix } from './roster-plan';

export interface ReadinessDept {
  department_id: string;
  department_name: string;
  parent_id: string;
  is_active: number;
  on_rolls: number;
  without_designation: number;
  designations: number;
  active_shifts: number;
  shift_map_rows: number;
  shift_roles: number;
  shift_map_gaps: number;
  coverage_rows: number;
  verdict: 'ready' | 'blocked' | 'not_measured';
  refusals: Array<{ code: string; message: string }>;
  warnings: string[];
  breaches: number;
}

export interface ReadinessGlobal {
  departments: number;
  active_departments: number;
  employees_on_rolls: number;
  employees_without_department: number;
  employees_without_designation: number;
  shifts_total: number;
  shifts_active: number;
  roster_rows_total: number;
  departments_measured: number;
}

interface Props {
  /** The grid's week (already the Monday). */
  weekStart: string;
  /** The grid's department filter; '' = all. Used only to highlight a row. */
  selectedDeptId: string;
  /** Bumped by the parent after a commit, so the panel re-measures. */
  refreshKey: number;
  onPickDepartment: (departmentId: string) => void;
  onOpenConfig: (departmentId: string, tab: 'coverage' | 'map') => void;
}

const card = 'bg-white border border-[#E8D5C4] rounded-xl shadow';

export default function RosterReadinessPanel({
  weekStart,
  selectedDeptId,
  refreshKey,
  onPickDepartment,
  onOpenConfig,
}: Props) {
  const [data, setData] = useState<{ global: ReadinessGlobal; departments: ReadinessDept[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    try {
      const res = await fetch(`/api/hr/roster/readiness?week_start=${encodeURIComponent(weekStart)}`);
      if (mine !== seq.current) return; // a newer fetch superseded this one
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403
          ? 'You need management access to read roster readiness.'
          : "Couldn't measure roster readiness");
        return;
      }
      const json = await res.json();
      if (mine !== seq.current) return;
      setData({
        global: json?.global ?? null,
        departments: Array.isArray(json?.departments) ? json.departments : [],
      });
    } catch {
      if (mine === seq.current) setError("Couldn't measure roster readiness");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [weekStart]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const toggle = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  /** Blocked first — the rows that need doing are the rows to show first; then
   *  the selected department, then by name (the server's order within that). */
  const rows = useMemo(() => {
    const list = data?.departments ?? [];
    const rank = (d: ReadinessDept) =>
      d.verdict === 'blocked' ? 0 : d.verdict === 'not_measured' ? 1 : 2;
    return [...list].sort((a, b) => {
      if (a.department_id === selectedDeptId) return -1;
      if (b.department_id === selectedDeptId) return 1;
      return rank(a) - rank(b);
    });
  }, [data, selectedDeptId]);

  const readyCount = rows.filter(d => d.verdict === 'ready').length;
  const blockedCount = rows.filter(d => d.verdict === 'blocked').length;
  const g = data?.global;

  return (
    <div className={`${card} print:hidden`}>
      <button onClick={() => setOpen(o => !o)}
              className="w-full px-4 py-3 flex items-center gap-2 text-left">
        <ClipboardCheck className="w-5 h-5 text-[#af4408] shrink-0" />
        <span className="font-semibold text-[#2D1B0E]">Roster readiness</span>
        {!loading && !error && (
          <span className="text-xs text-[#8B7355]">
            {readyCount} ready · {blockedCount} blocked
          </span>
        )}
        {loading && <Loader2 className="w-4 h-4 animate-spin text-[#8B7355]" />}
        <span className="flex-1" />
        <span className="text-[#8B7355]">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-[#F3E7D9] pt-3">
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm flex items-center justify-between gap-3">
              <span>{error}</span>
              <button onClick={load} className="underline shrink-0">Retry</button>
            </div>
          )}

          {/* Venue-wide facts. These numbers are what make the usual refusal make
              sense — "128 of 129 have no department" is the whole story. */}
          {g && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#6B5744]">
              <span><strong>{g.employees_on_rolls}</strong> on rolls</span>
              <span className={g.employees_without_department > 0 ? 'text-amber-700' : ''}>
                <strong>{g.employees_without_department}</strong> with no department
              </span>
              <span className={g.employees_without_designation > 0 ? 'text-amber-700' : ''}>
                <strong>{g.employees_without_designation}</strong> with no designation
              </span>
              <span className={g.shifts_active === 0 ? 'text-amber-700' : ''}>
                <strong>{g.shifts_active}</strong> active shift{g.shifts_active === 1 ? '' : 's'}
                {g.shifts_total > g.shifts_active ? ` (${g.shifts_total} total)` : ''}
              </span>
              <span><strong>{g.roster_rows_total}</strong> roster rows ever</span>
              <span className="text-[#8B7355]">week of {weekStart}</span>
            </div>
          )}

          {!loading && rows.length === 0 && !error && (
            <p className="text-sm text-[#8B7355]">
              No department exists yet. Departments are set in the app — this generator reads them
              and never creates one.
            </p>
          )}

          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[820px]">
                <thead className="bg-[#FFF1E3]">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">Department</th>
                    <th className="text-right px-2 py-2 font-semibold">On rolls</th>
                    <th className="text-right px-2 py-2 font-semibold">No designation</th>
                    <th className="text-right px-2 py-2 font-semibold">Shifts</th>
                    <th className="text-right px-2 py-2 font-semibold">Shift map</th>
                    <th className="text-right px-2 py-2 font-semibold">Coverage</th>
                    <th className="text-left px-3 py-2 font-semibold">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(d => {
                    const isOpen = expanded.has(d.department_id);
                    const isSel = d.department_id === selectedDeptId;
                    return (
                      <Fragment key={d.department_id}>
                        <tr className={`border-t border-[#F3E7D9] ${isSel ? 'bg-[#FFF8F0]' : ''}`}>
                          <td className="px-3 py-2">
                            <button onClick={() => toggle(d.department_id)}
                                    className="inline-flex items-center gap-1 text-left hover:underline">
                              {isOpen ? <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                                      : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
                              <span className="font-medium">{d.department_name || d.department_id}</span>
                            </button>
                            {d.parent_id && <div className="text-[11px] text-[#8B7355] pl-5">sub-department</div>}
                            {!d.is_active && <div className="text-[11px] text-amber-700 pl-5">inactive</div>}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">{d.on_rolls}</td>
                          <td className={`px-2 py-2 text-right tabular-nums ${d.without_designation > 0 ? 'text-amber-700 font-medium' : ''}`}>
                            {d.without_designation}
                          </td>
                          <td className={`px-2 py-2 text-right tabular-nums ${d.active_shifts === 0 ? 'text-rose-700 font-medium' : ''}`}>
                            {d.active_shifts}
                          </td>
                          <td className={`px-2 py-2 text-right tabular-nums ${d.shift_map_rows === 0 ? 'text-rose-700 font-medium' : ''}`}>
                            {d.shift_map_rows}
                            {d.shift_map_gaps > 0 && (
                              <span className="text-amber-700" title={`${d.shift_map_gaps} (role, weekday) pair(s) unmapped — Sunday counts, and an unmapped day is a refusal, never a substitution`}>
                                {' '}· {d.shift_map_gaps} gap{d.shift_map_gaps === 1 ? '' : 's'}
                              </span>
                            )}
                          </td>
                          <td className={`px-2 py-2 text-right tabular-nums ${d.coverage_rows === 0 ? 'text-rose-700 font-medium' : ''}`}>
                            {d.coverage_rows}
                          </td>
                          <td className="px-3 py-2">
                            {d.verdict === 'ready' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium bg-green-50 text-green-700 border-green-200">
                                <CheckCircle2 className="w-3.5 h-3.5" /> Ready
                              </span>
                            ) : d.verdict === 'blocked' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium bg-rose-50 text-rose-700 border-rose-200">
                                <AlertTriangle className="w-3.5 h-3.5" /> Blocked
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium bg-slate-50 text-slate-600 border-slate-200"
                                    title="Past the per-load measurement cap — not guessed either way. Open it to measure.">
                                <Info className="w-3.5 h-3.5" /> Not measured
                              </span>
                            )}
                            {d.verdict === 'ready' && d.breaches > 0 && (
                              <div className="text-[11px] text-amber-700 mt-1">
                                {d.breaches} coverage breach{d.breaches === 1 ? '' : 'es'} this week
                              </div>
                            )}
                          </td>
                        </tr>

                        {isOpen && (
                          <tr className="border-t border-[#F3E7D9] bg-[#FFFDF9]">
                            <td colSpan={7} className="px-3 py-3 space-y-2">
                              {d.verdict === 'ready' && d.refusals.length === 0 && (
                                <p className="text-sm text-green-700">
                                  Nothing is missing — the generator will plan this week for{' '}
                                  <strong>{d.department_name}</strong>.
                                </p>
                              )}
                              {d.refusals.map((r, i) => {
                                const fix = refusalFix(r.code);
                                return (
                                  <div key={`${r.code}-${i}`}
                                       className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
                                    {/* VERBATIM — the server wrote this for a human. */}
                                    <div>{r.message}</div>
                                    <div className="mt-1.5 flex items-center gap-3">
                                      <code className="text-[11px] text-rose-700/80">{r.code}</code>
                                      {fix.kind === 'page' && (
                                        <a href={fix.href}
                                           className="inline-flex items-center gap-1 text-[11px] font-medium text-[#af4408] hover:underline">
                                          {fix.label} <ExternalLink className="w-3 h-3" />
                                        </a>
                                      )}
                                      {fix.kind === 'config' && (
                                        <button onClick={() => onOpenConfig(d.department_id, fix.tab)}
                                                className="text-[11px] font-medium text-[#af4408] hover:underline">
                                          {fix.label}
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                              {d.warnings.map((w, i) => (
                                <div key={`w-${i}`}
                                     className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                  {w}
                                </div>
                              ))}
                              <div className="flex flex-wrap items-center gap-2 pt-1">
                                <button onClick={() => onPickDepartment(d.department_id)}
                                        className="px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] text-xs text-[#6B5744]">
                                  Use this department
                                </button>
                                <button onClick={() => onOpenConfig(d.department_id, 'coverage')}
                                        className="px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] text-xs text-[#6B5744]">
                                  Coverage floors
                                </button>
                                <button onClick={() => onOpenConfig(d.department_id, 'map')}
                                        className="px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] text-xs text-[#6B5744]">
                                  Shift map
                                </button>
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
          )}

          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-[#8B7355]">
              Every verdict is the generator&apos;s own answer for this week, not a second set of
              checks — Ready here means Generate will not refuse. Coverage is a{' '}
              <strong>minimum present</strong> floor, never a cap on offs.
            </p>
            <button onClick={load}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] text-xs text-[#6B5744] shrink-0">
              <RefreshCw className="w-3.5 h-3.5" /> Re-measure
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
