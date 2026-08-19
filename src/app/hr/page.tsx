'use client';

/**
 * HR Dashboard — live Phase 2-7 tiles (contract: docs/HRMS_DECISIONS.md).
 *
 * Deliberately CHEAP — a fixed, small number of GETs, every figure computed
 * client-side, nothing per-employee:
 *  - GET /api/hr/employees?page=1&pageSize=100 → people KPIs, recent joiners,
 *    department headcount, and the probation-review arithmetic (joining_date +
 *    probation_months, computed HERE — no dedicated endpoint).
 *  - GET /api/hr/attendance?pageSize=200 (NO date param — the API defaults to
 *    the current BUSINESS date per hr_day_cutoff; '?date=today' is not a real
 *    YYYY-MM-DD and would 400) → Present / On leave.
 *  - One more GET /api/hr/attendance?date=<register date − 1 day> → Missing
 *    checkouts (YESTERDAY). The engine only stamps MISSING_CHECKOUT when a
 *    business day CLOSES, so counting it on the open current day would
 *    structurally read 0 — yesterday's closed register is the honest source.
 *  - Count-only reads for the action queues: leave + advances + expiring docs
 *    read `total` from their list endpoints with pageSize=1; corrections has
 *    no pagination, so ?status=pending returns the (small) queue itself.
 *    A 403 on any of these HIDES that row (the documents AND advances queues
 *    are admin-only; a manager-tier caller simply doesn't get them) — never
 *    an error banner.
 *
 * NO 14-day attendance trend chart, ON PURPOSE: there is no trend endpoint,
 * and building the series client-side would mean 14 separate
 * GET /api/hr/attendance?date=X calls per dashboard load against a
 * SYNCHRONOUS better-sqlite3 that also serves the POS. Honest and cheap beats
 * fancy — add the chart only if a single-call trend mode ever lands in the
 * attendance API.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CalendarClock,
  CalendarDays,
  ClipboardList,
  DoorOpen,
  FileWarning,
  Hourglass,
  Loader2,
  Settings2,
  UserCheck,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import { employeeStatusMeta, type HrEmployeeListRow } from '@/lib/hr';
import { fmtISTDate, todayIST } from '@/lib/format-date';

/* ── date arithmetic (pure, IST-day strings in / out) ── */

/** iso + n months, month-end clamped (Jan 31 + 1m = Feb 28/29, never Mar 2/3). '' on garbage. */
function addMonthsIso(iso: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(d.getTime())) return '';
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== day) d.setUTCDate(0); // rolled over → clamp to month end
  return d.toISOString().slice(0, 10);
}

/** iso + n days. '' on garbage. */
function addDaysIso(iso: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ── slim row shapes for the extra fetches ── */

/** The register columns this page actually reads (GET /api/hr/attendance rows). */
interface AttRow {
  employee_id: string;
  status: string;
  first_in: string;
  missing_checkout: number;
}

interface AttSnapshot {
  rows: AttRow[];
  total: number;
  /** IST BUSINESS date the register is for (hr_day_cutoff-shifted). */
  date: string;
}

/** null = not loaded / no access (row hidden) — never conflated with 0. */
interface QueueCounts {
  leave: number | null;
  corrections: number | null;
  advances: number | null;
  docs: number | null;
}

const EXITED = new Set(['resigned', 'terminated', 'former']);

/** Read { total } from a paginated list endpoint; null = failed or 403. */
async function fetchTotal(url: string): Promise<number | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const n = Number(j?.total);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export default function HrDashboardPage() {
  const [rows, setRows] = useState<HrEmployeeListRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [att, setAtt] = useState<AttSnapshot | null>(null);
  const [attFailed, setAttFailed] = useState(false);
  /** MISSING_CHECKOUT count on YESTERDAY's (closed) register; null = unavailable. */
  const [yMissing, setYMissing] = useState<number | null>(null);
  const [queues, setQueues] = useState<QueueCounts>({
    leave: null,
    corrections: null,
    advances: null,
    docs: null,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAttFailed(false);

    // Employee master — the page-blocking fetch (KPIs, joiners, probation).
    const employees = (async () => {
      try {
        // Bare fetch is fine for GETs (CSRF header is only for mutations).
        const r = await fetch('/api/hr/employees?page=1&pageSize=100');
        const j = await r.json().catch(() => null);
        if (!r.ok) {
          setError(
            j?.error ||
              (r.status === 403
                ? 'HR is a management-only module. Ask an admin for access via Settings → Page Access.'
                : 'Could not load employees.'),
          );
          setRows(null);
          return;
        }
        setRows(Array.isArray(j?.rows) ? j.rows : []);
        setTotal(Number(j?.total) || 0);
      } catch {
        setError('Could not load employees. Check your connection and retry.');
        setRows(null);
      }
    })();

    // Today's register — current business date (omit ?date on purpose).
    // Then YESTERDAY's register for the Missing-checkouts tile: the engine
    // only stamps MISSING_CHECKOUT when a business day closes, so the current
    // (open) day always reads 0 — the last CLOSED day is the honest number.
    const attendance = (async () => {
      try {
        const r = await fetch('/api/hr/attendance?pageSize=200');
        const j = await r.json().catch(() => null);
        if (!r.ok || !Array.isArray(j?.rows)) {
          setAtt(null);
          setAttFailed(true);
          setYMissing(null);
          return;
        }
        setAtt({ rows: j.rows, total: Number(j?.total) || 0, date: String(j?.date || '') });

        const yDate = addDaysIso(String(j?.date || ''), -1);
        if (!yDate) {
          setYMissing(null);
          return;
        }
        try {
          const yr = await fetch(`/api/hr/attendance?date=${yDate}&pageSize=200`);
          const yj = await yr.json().catch(() => null);
          if (!yr.ok || !Array.isArray(yj?.rows)) {
            setYMissing(null);
            return;
          }
          let missing = 0;
          for (const row of yj.rows as AttRow[]) {
            if (row.missing_checkout === 1 || row.status === 'MISSING_CHECKOUT') missing++;
          }
          setYMissing(missing);
        } catch {
          setYMissing(null);
        }
      } catch {
        setAtt(null);
        setAttFailed(true);
        setYMissing(null);
      }
    })();

    // Action queues — count-only; a 403 hides the row (docs is admin-only).
    const counts = (async () => {
      const [leave, corrections, advances, docs] = await Promise.all([
        fetchTotal('/api/hr/leave/requests?status=pending&pageSize=1'),
        (async (): Promise<number | null> => {
          try {
            const r = await fetch('/api/hr/attendance/corrections?status=pending');
            if (!r.ok) return null;
            const j = await r.json().catch(() => null);
            return Array.isArray(j?.corrections) ? j.corrections.length : null;
          } catch {
            return null;
          }
        })(),
        fetchTotal('/api/hr/advances?status=pending&pageSize=1'),
        fetchTotal('/api/hr/documents?expiring_days=60&pageSize=1'),
      ]);
      setQueues({ leave, corrections, advances, docs });
    })();

    await Promise.all([employees, attendance, counts]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* KPI counts from the loaded page (up to 100 rows). */
  const k = useMemo(() => {
    const c = { active: 0, probation: 0, notice: 0, exited: 0 };
    for (const e of rows || []) {
      if (e.status === 'active' || e.status === 'confirmed') c.active++;
      else if (e.status === 'probation') c.probation++;
      else if (e.status === 'notice_period') c.notice++;
      else if (EXITED.has(e.status)) c.exited++;
    }
    return c;
  }, [rows]);

  const loadedCount = rows?.length || 0;
  const partial = total > loadedCount;

  /* Today's attendance tiles, from the register snapshot. */
  const today = useMemo(() => {
    if (!att) return null;
    let present = 0;
    let onLeave = 0;
    for (const r of att.rows) {
      if (r.first_in) present++; // punched in this business day (any current status)
      if (r.status === 'ON_LEAVE') onLeave++;
    }
    return { present, onLeave, partial: att.total > att.rows.length };
  }, [att]);

  /* Probation reviews due — joining_date + probation_months, client-side.
   * Due within 30 days (or overdue), not yet confirmed, not exited. */
  const probationDue = useMemo(() => {
    const base = todayIST();
    const horizon = addDaysIso(base, 30);
    if (!horizon) return [];
    const out: (HrEmployeeListRow & { review_due: string; overdue: boolean })[] = [];
    for (const e of rows || []) {
      if (!e.joining_date || !e.probation_months) continue;
      if (e.confirmation_date) continue; // already confirmed
      if (EXITED.has(e.status)) continue;
      const due = addMonthsIso(e.joining_date, e.probation_months);
      if (!due || due > horizon) continue;
      out.push({ ...e, review_due: due, overdue: due < base });
    }
    return out
      .sort((a, b) => (a.review_due < b.review_due ? -1 : a.review_due > b.review_due ? 1 : 0))
      .slice(0, 8);
  }, [rows]);

  /* Recently joined — top 8 by joining_date desc (rows without a date are skipped). */
  const recent = useMemo(
    () =>
      (rows || [])
        .filter((e) => e.joining_date)
        .slice()
        .sort((a, b) => (a.joining_date < b.joining_date ? 1 : a.joining_date > b.joining_date ? -1 : 0))
        .slice(0, 8),
    [rows],
  );

  /* Department headcount, largest first. */
  const deptCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of rows || []) {
      const name = e.department_name || 'Unassigned';
      m.set(name, (m.get(name) || 0) + 1);
    }
    return [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [rows]);
  const maxDept = deptCounts.length ? deptCounts[0].count : 0;

  /* Action queues — hide rows that failed / 403'd, show honest zeros. */
  const queueRows = useMemo(
    () =>
      [
        {
          key: 'leave',
          count: queues.leave,
          label: 'Leave requests pending',
          href: '/hr/leave',
          icon: <CalendarDays className="w-4 h-4" />,
        },
        {
          key: 'corrections',
          count: queues.corrections,
          label: 'Attendance corrections pending',
          href: '/hr/attendance',
          icon: <ClipboardList className="w-4 h-4" />,
        },
        {
          key: 'advances',
          count: queues.advances,
          label: 'Salary advances pending',
          href: '/hr/payroll',
          icon: <Wallet className="w-4 h-4" />,
        },
        {
          key: 'docs',
          count: queues.docs,
          label: 'Documents expiring within 60 days',
          href: '/hr/documents',
          icon: <FileWarning className="w-4 h-4" />,
        },
      ].filter((q) => q.count !== null),
    [queues],
  );

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <Users className="w-6 h-6" /> HR Dashboard
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              People, today&apos;s attendance and the approval queues — one screen, live counts.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <QuickAction href="/hr/employees" icon={<UserPlus className="w-4 h-4" />} label="Employee Master" />
            <QuickAction href="/hr/attendance" icon={<ClipboardList className="w-4 h-4" />} label="Attendance" />
            <QuickAction href="/hr/settings" icon={<Settings2 className="w-4 h-4" />} label="HR Settings" />
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center justify-between gap-3">
            <span className="text-sm text-red-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {error}
            </span>
            <button
              onClick={load}
              className="px-3 py-1.5 text-xs font-medium bg-white border border-red-200 text-red-700 rounded-lg hover:bg-red-50"
            >
              Retry
            </button>
          </div>
        )}

        {loading && !rows ? (
          <div className="py-24 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-6 h-6 animate-spin inline mr-2" /> Loading...
          </div>
        ) : !rows ? null : (
          <>
            {/* People KPI cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
              <KpiCard icon={<Users className="w-4 h-4" />} label="Total Employees" value={total} color="blue" />
              <KpiCard icon={<UserCheck className="w-4 h-4" />} label="Active" value={k.active} color="green" />
              <KpiCard icon={<Hourglass className="w-4 h-4" />} label="On Probation" value={k.probation} color="amber" />
              <KpiCard icon={<CalendarClock className="w-4 h-4" />} label="Notice Period" value={k.notice} color="purple" />
              <KpiCard icon={<DoorOpen className="w-4 h-4" />} label="Exited" value={k.exited} color="red" />
            </div>
            {partial && (
              <p className="text-xs text-[#8B7355] -mt-2">
                Status counts are computed from the first {loadedCount} of {total} employees — open the{' '}
                <a href="/hr/employees" className="text-[#af4408] hover:underline">Employee Master</a> for exact filtered
                counts.
              </p>
            )}

            {/* Today's attendance (current business day per hr_day_cutoff) */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h3 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
                  <ClipboardList className="w-5 h-5 text-[#af4408]" /> Today&apos;s Attendance
                  {att?.date && (
                    <span className="text-xs font-normal text-[#8B7355]">business day {fmtISTDate(att.date)}</span>
                  )}
                </h3>
                <a href="/hr/attendance" className="text-xs text-[#af4408] hover:underline flex items-center gap-1">
                  Open register <ArrowRight className="w-3 h-3" />
                </a>
              </div>
              {attFailed || !today ? (
                <p className="text-sm text-[#8B7355] text-center py-6">
                  The attendance register could not be loaded — open it directly from the link above.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                    <KpiCard
                      icon={<UserCheck className="w-4 h-4" />}
                      label="Present today"
                      value={today.present}
                      color="green"
                    />
                    <KpiCard
                      icon={<CalendarDays className="w-4 h-4" />}
                      label="On leave"
                      value={today.onLeave}
                      color="purple"
                    />
                    <KpiCard
                      icon={<AlertTriangle className="w-4 h-4" />}
                      label="Missing checkouts (yesterday)"
                      value={yMissing === null ? '—' : yMissing}
                      color="red"
                    />
                  </div>
                  {today.partial && (
                    <p className="text-xs text-[#8B7355] mt-2">
                      Computed from the first {att!.rows.length} of {att!.total} register rows — the full picture is on
                      the register itself.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Action queues */}
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
                <h3 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2 mb-3">
                  <Hourglass className="w-5 h-5 text-[#af4408]" /> Waiting on HR
                </h3>
                {queueRows.length === 0 ? (
                  <p className="text-sm text-[#8B7355] text-center py-8">
                    No approval queues are visible for your role.
                  </p>
                ) : (
                  <ul className="divide-y divide-[#E8D5C4]/50">
                    {queueRows.map((q) => (
                      <li key={q.key}>
                        <a
                          href={q.href}
                          className="flex items-center gap-3 py-2.5 px-2 -mx-2 rounded-lg hover:bg-[#FFF1E3] transition-colors"
                        >
                          <span className="text-[#af4408]">{q.icon}</span>
                          <span className="flex-1 text-sm text-[#2D1B0E]">{q.label}</span>
                          <span
                            className={`inline-block min-w-[1.75rem] text-center text-xs font-bold px-2 py-0.5 rounded-full border ${
                              (q.count || 0) > 0
                                ? 'bg-amber-100 text-amber-800 border-amber-200'
                                : 'bg-[#FFF1E3] text-[#8B7355] border-[#E8D5C4]'
                            }`}
                          >
                            {q.count}
                          </span>
                          <ArrowRight className="w-3.5 h-3.5 text-[#8B7355]" />
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Probation reviews due */}
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
                    <Hourglass className="w-5 h-5 text-[#af4408]" /> Probation Reviews Due
                    <span className="text-xs font-normal text-[#8B7355]">next 30 days</span>
                  </h3>
                  <a href="/hr/employees" className="text-xs text-[#af4408] hover:underline flex items-center gap-1">
                    View all <ArrowRight className="w-3 h-3" />
                  </a>
                </div>
                {probationDue.length === 0 ? (
                  <p className="text-sm text-[#8B7355] text-center py-8">No probation reviews falling due.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                        <tr>
                          <th className="text-left py-2 px-3 font-medium">Employee</th>
                          <th className="text-left py-2 px-3 font-medium">Joined</th>
                          <th className="text-left py-2 px-3 font-medium">Review Due</th>
                          <th className="text-left py-2 px-3 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {probationDue.map((e) => (
                          <tr key={e.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]">
                            <td className="py-2 px-3">
                              <a href={`/hr/employees/${e.id}`} className="font-medium text-[#2D1B0E] hover:text-[#af4408]">
                                {e.full_name}
                              </a>
                              <span className="block text-[10px] text-[#8B7355] font-mono">{e.employee_code}</span>
                            </td>
                            <td className="py-2 px-3 text-xs text-[#6B5744] whitespace-nowrap">
                              {fmtISTDate(e.joining_date)}
                            </td>
                            <td className="py-2 px-3 text-xs text-[#6B5744] whitespace-nowrap">
                              {fmtISTDate(e.review_due)}
                            </td>
                            <td className="py-2 px-3">
                              <span
                                className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                                  e.overdue
                                    ? 'bg-red-100 text-red-700 border-red-200'
                                    : 'bg-amber-100 text-amber-800 border-amber-200'
                                }`}
                              >
                                {e.overdue ? 'Overdue' : 'Due soon'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {total === 0 ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-8 text-center">
                <Users className="w-8 h-8 mx-auto text-[#8B7355] mb-3" />
                <p className="text-sm font-medium text-[#2D1B0E]">No employees yet.</p>
                <p className="text-sm text-[#8B7355] mt-1">
                  Add the first one in the{' '}
                  <a href="/hr/employees" className="text-[#af4408] hover:underline">Employee Master</a> — kitchen and
                  service staff without app logins are employees too.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Recently joined */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
                      <UserPlus className="w-5 h-5 text-[#af4408]" /> Recently Joined
                    </h3>
                    <a href="/hr/employees" className="text-xs text-[#af4408] hover:underline flex items-center gap-1">
                      View all <ArrowRight className="w-3 h-3" />
                    </a>
                  </div>
                  {recent.length === 0 ? (
                    <p className="text-sm text-[#8B7355] text-center py-8">No joining dates recorded yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                          <tr>
                            <th className="text-left py-2 px-3 font-medium">Employee</th>
                            <th className="text-left py-2 px-3 font-medium">Department</th>
                            <th className="text-left py-2 px-3 font-medium">Designation</th>
                            <th className="text-left py-2 px-3 font-medium">Joined</th>
                            <th className="text-left py-2 px-3 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recent.map((e) => {
                            const sm = employeeStatusMeta(e.status);
                            return (
                              <tr key={e.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]">
                                <td className="py-2 px-3">
                                  <span className="font-medium text-[#2D1B0E]">{e.full_name}</span>
                                  <span className="block text-[10px] text-[#8B7355] font-mono">{e.employee_code}</span>
                                </td>
                                <td className="py-2 px-3 text-xs text-[#6B5744]">
                                  {e.department_name || <span className="text-[#8B7355]">—</span>}
                                  {e.sub_department_name && (
                                    <span className="block text-[10px] text-[#8B7355]">{e.sub_department_name}</span>
                                  )}
                                </td>
                                <td className="py-2 px-3 text-xs text-[#6B5744]">
                                  {e.designation_name || <span className="text-[#8B7355]">—</span>}
                                </td>
                                <td className="py-2 px-3 text-xs text-[#6B5744] whitespace-nowrap">
                                  {fmtISTDate(e.joining_date)}
                                </td>
                                <td className="py-2 px-3">
                                  <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border ${sm.color}`}>
                                    {sm.label}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Department headcount */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
                  <h3 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2 mb-3">
                    <Building2 className="w-5 h-5 text-[#af4408]" /> Department Headcount
                    {partial && <span className="text-xs font-normal text-[#8B7355]">first {loadedCount} employees</span>}
                  </h3>
                  {deptCounts.length === 0 ? (
                    <p className="text-sm text-[#8B7355] text-center py-8">No employees to count yet.</p>
                  ) : (
                    <ul className="space-y-2.5">
                      {deptCounts.map((d) => (
                        <li key={d.name} className="flex items-center gap-3">
                          <span className="w-36 shrink-0 text-sm text-[#2D1B0E] truncate" title={d.name}>
                            {d.name}
                          </span>
                          <div className="flex-1 h-2 bg-[#FFF1E3] rounded">
                            <div
                              className="h-2 bg-[#af4408] rounded"
                              style={{ width: `${maxDept ? Math.max(4, Math.round((d.count / maxDept) * 100)) : 0}%` }}
                            />
                          </div>
                          <span className="w-8 shrink-0 text-right text-xs font-mono text-[#6B5744]">{d.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── page-local helpers (copied from src/app/tasks/page.tsx — the house KPI pattern) ── */

function QuickAction({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-2 px-3.5 py-2 bg-white border border-[#E8D5C4] hover:border-[#af4408] hover:bg-[#FFF1E3] text-[#3D2614] rounded-lg text-sm font-medium transition-colors"
    >
      <span className="text-[#af4408]">{icon}</span> {label}
    </a>
  );
}

const KPI_ACCENTS: Record<string, { bg: string; text: string }> = {
  green: { bg: 'bg-green-500/10', text: 'text-green-600' },
  red: { bg: 'bg-red-500/10', text: 'text-red-600' },
  blue: { bg: 'bg-[#af4408]/10', text: 'text-[#af4408]' },
  amber: { bg: 'bg-amber-500/10', text: 'text-amber-600' },
  purple: { bg: 'bg-purple-500/10', text: 'text-purple-600' },
  teal: { bg: 'bg-teal-500/10', text: 'text-teal-600' },
  indigo: { bg: 'bg-indigo-500/10', text: 'text-indigo-600' },
};

function KpiCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  color: keyof typeof KPI_ACCENTS;
}) {
  const a = KPI_ACCENTS[color];
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow">
      <div className="flex items-center gap-2 mb-2">
        <div className={`p-1.5 rounded-lg ${a.bg}`}>
          <span className={a.text}>{icon}</span>
        </div>
        <span className="text-xs text-[#8B7355] leading-tight">{label}</span>
      </div>
      <p className={`text-xl font-bold ${a.text}`}>{value}</p>
    </div>
  );
}
