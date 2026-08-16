'use client';

/**
 * HR Dashboard — Phase 1 scope ONLY (contract: docs/HRMS_DECISIONS.md).
 *
 * Deliberately CHEAP: one GET /api/hr/employees?page=1&pageSize=100 and every
 * card is computed client-side from that single response. No recharts — charts
 * join in Phase 7. When the venue grows past 100 employees the status counts
 * become "first 100 of N" and we say so honestly under the KPI row instead of
 * firing one request per status.
 *
 * Attendance is a dashed placeholder on purpose: owner ruling §8.1 gates
 * go-live on biometric integration (Phase 2) — nothing here pretends otherwise.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CalendarClock,
  DoorOpen,
  Fingerprint,
  Hourglass,
  Loader2,
  Settings2,
  UserCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import { employeeStatusMeta, type HrEmployeeListRow } from '@/lib/hr';
import { fmtISTDate } from '@/lib/format-date';

export default function HrDashboardPage() {
  const [rows, setRows] = useState<HrEmployeeListRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
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
    } finally {
      setLoading(false);
    }
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
      else if (e.status === 'resigned' || e.status === 'terminated' || e.status === 'former') c.exited++;
    }
    return c;
  }, [rows]);

  const loadedCount = rows?.length || 0;
  const partial = total > loadedCount;

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
              People overview — employee master and designations are live; attendance, shifts and payroll arrive in later phases.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <QuickAction href="/hr/employees" icon={<UserPlus className="w-4 h-4" />} label="Employee Master" />
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
            {/* KPI cards */}
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

            {/* Phase 2 placeholder — owner ruling: go-live is biometric-gated. NOT built yet. */}
            <div className="border-2 border-dashed border-[#E8D5C4] rounded-xl p-6 text-center">
              <Fingerprint className="w-6 h-6 mx-auto text-[#8B7355] mb-2" />
              <p className="text-sm font-medium text-[#6B5744]">
                Attendance — arrives with Phase 2 (biometric-gated go-live)
              </p>
              <p className="text-xs text-[#8B7355] mt-1">
                Check-ins, business-day summaries and corrections land once the biometric device is integrated.
              </p>
            </div>
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
