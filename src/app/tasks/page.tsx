'use client';

/**
 * Task Management — Dashboard (/tasks index).
 *
 * Live operational overview of the whole task module: KPI cards (due today,
 * pending, completed, overdue, high-priority, maintenance, hygiene, training,
 * knowledge), a tasks-by-status bar chart + tasks-by-category pie, department
 * performance + employee productivity leaderboards, an upcoming-tasks strip,
 * a recent-activity feed (from task_status_history) and quick-action buttons.
 *
 * All numbers come from GET /api/tasks/dashboard (live SQL). Any signed-in user
 * may view — the API enforces the same. Warm theme, mobile-first + desktop.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity, AlertTriangle, ArrowLeft, ArrowRight, CalendarClock, CheckCheck,
  CheckCircle2, ClipboardList, Clock, Flame, GraduationCap, KanbanSquare,
  LayoutDashboard, ListTodo, Loader2, RefreshCw, SprayCan, Wrench,
} from 'lucide-react';
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { statusMeta, priorityMeta } from '@/lib/tasks';

/* ── types (mirror /api/tasks/dashboard) ──────────────────────────────── */

interface Kpis {
  due_today: number;
  pending: number;
  completed: number;
  overdue: number;
  high_priority: number;
  maintenance_due: number;
  maintenance_total: number;
  hygiene_score_avg: number;
  hygiene_pass_pct: number;
  training_completion_pct: number;
  knowledge_completion_pct: number;
  total_open: number;
}
interface DeptRow { department: string; total: number; completed: number; pending: number; overdue: number; completion_pct: number; }
interface EmpRow { assignee_email: string; assignee_name: string; total: number; completed: number; pending: number; overdue: number; completion_pct: number; }
interface UpcomingRow { id: string; title: string; priority: string; status: string; department: string; due_date: string; due_time: string; assignee_name: string; }
interface RecentRow { id: string; task_id: string; title: string | null; from_status: string; to_status: string; changed_by: string; note: string; created_at: string; }
interface DashboardData {
  kpis: Kpis;
  by_status: { status: string; count: number }[];
  by_category: { category: string; count: number }[];
  dept_performance: DeptRow[];
  employee_productivity: EmpRow[];
  upcoming: UpcomingRow[];
  recent: RecentRow[];
  range?: { from: string; to: string };
  generated_at: string;
}

/* ── helpers ──────────────────────────────────────────────────────────── */

// Hex swatches for recharts (Tailwind classes can't be read by SVG fills).
const STATUS_HEX: Record<string, string> = {
  draft: '#9CA3AF', assigned: '#3B82F6', accepted: '#6366F1', in_progress: '#F59E0B',
  waiting_verification: '#A855F7', completed: '#14B8A6', approved: '#22C55E',
  reopened: '#F97316', on_hold: '#EAB308', cancelled: '#F43F5E',
};
const CATEGORY_HEX = ['#af4408', '#8B5CF6', '#10B981', '#F59E0B', '#3B82F6', '#EF4444', '#EC4899', '#14B8A6', '#6366F1', '#F97316', '#84CC16', '#06B6D4', '#A855F7'];

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
const fmtDateTime = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};

/* ── page ─────────────────────────────────────────────────────────────── */

export default function TaskDashboardPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined);      // undefined = loading, null = signed out
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(daysAgoISO(29));
  const [to, setTo] = useState(todayISO());

  const allowed = !!me; // any signed-in user

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({ from, to });
      const res = await fetch(`/api/tasks/dashboard?${qs}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (e: any) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  /* ── auth gates ── */
  if (me === undefined) {
    return (
      <div className="p-8 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-3">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Please sign in to view the task dashboard.
        </div>
      </div>
    );
  }

  const k = data?.kpis;
  const statusChart = (data?.by_status ?? []).map((r) => ({
    name: statusMeta(r.status).label, count: r.count, fill: STATUS_HEX[r.status] || '#9CA3AF',
  }));
  const categoryChart = (data?.by_category ?? []).filter((r) => r.count > 0).map((r) => ({
    name: r.category || 'Uncategorised', value: r.count,
  }));

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">

        {/* Back (breadcrumb) */}
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>

        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-[#af4408]/10 text-[#af4408]">
              <LayoutDashboard className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Task Dashboard</h1>
              <p className="text-[#8B7355] text-sm mt-0.5">
                Live overview of tasks, checklists, maintenance, hygiene & training
              </p>
            </div>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#3D2614] rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {/* Quick actions */}
        <div className="flex flex-wrap gap-2">
          <QuickAction href="/tasks/board" icon={<KanbanSquare className="w-4 h-4" />} label="Task Board" />
          <QuickAction href="/tasks/my" icon={<ListTodo className="w-4 h-4" />} label="My Tasks" />
          <QuickAction href="/tasks/checklists" icon={<ClipboardList className="w-4 h-4" />} label="Checklists" />
          <QuickAction href="/tasks/maintenance" icon={<Wrench className="w-4 h-4" />} label="Maintenance" />
          <QuickAction href="/tasks/hygiene" icon={<SprayCan className="w-4 h-4" />} label="Hygiene" />
          <QuickAction href="/tasks/approvals" icon={<CheckCheck className="w-4 h-4" />} label="Approvals" />
          <QuickAction href="/tasks/calendar" icon={<CalendarClock className="w-4 h-4" />} label="Calendar" />
        </div>

        {/* Date-range filter — bounds the throughput KPIs (Completed, Hygiene, Training, Knowledge) */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs text-[#8B7355] mb-1">From</label>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
              className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
          </div>
          <div>
            <label className="block text-xs text-[#8B7355] mb-1">To</label>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)}
              className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
          </div>
          <div className="flex gap-1.5">
            {([['7d', 6], ['30d', 29], ['90d', 89]] as const).map(([label, days]) => (
              <button key={label} onClick={() => { setFrom(daysAgoISO(days)); setTo(todayISO()); }}
                className="px-2.5 py-2 rounded-lg border border-[#E8D5C4] text-xs text-[#6B5744] hover:bg-[#FFF1E3] transition-colors">
                {label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-[#8B7355] ml-auto max-w-xs">
            Range bounds <span className="font-medium">Completed, Hygiene, Training &amp; Knowledge</span>. Pending, overdue &amp; due-today are always live.
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center justify-between gap-3">
            <span className="text-sm text-red-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {error}
            </span>
            <button onClick={load} className="px-3 py-1.5 text-xs font-medium bg-white border border-red-200 text-red-700 rounded-lg hover:bg-red-50">Retry</button>
          </div>
        )}

        {loading && !data ? (
          <div className="py-24 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-6 h-6 animate-spin inline mr-2" /> Loading dashboard…
          </div>
        ) : !data ? null : (
          <>
            {/* KPI cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
              <KpiCard icon={<CalendarClock className="w-4 h-4" />} label="Due Today" value={k!.due_today} color="blue" />
              <KpiCard icon={<Clock className="w-4 h-4" />} label="Pending" value={k!.pending} color="amber" />
              <KpiCard icon={<CheckCircle2 className="w-4 h-4" />} label="Completed" value={k!.completed} color="green" />
              <KpiCard icon={<AlertTriangle className="w-4 h-4" />} label="Overdue" value={k!.overdue} color="red" />
              <KpiCard icon={<Flame className="w-4 h-4" />} label="High Priority" value={k!.high_priority} color="red" />
              <KpiCard icon={<Wrench className="w-4 h-4" />} label="Maintenance Due" value={`${k!.maintenance_due}/${k!.maintenance_total}`} color="purple" />
              <KpiCard icon={<SprayCan className="w-4 h-4" />} label="Hygiene Score" value={k!.hygiene_score_avg || '—'} color="teal" />
              <KpiCard icon={<CheckCheck className="w-4 h-4" />} label="Hygiene Pass %" value={`${k!.hygiene_pass_pct}%`} color="teal" />
              <KpiCard icon={<GraduationCap className="w-4 h-4" />} label="Training Done %" value={`${k!.training_completion_pct}%`} color="indigo" />
              <KpiCard icon={<GraduationCap className="w-4 h-4" />} label="Knowledge Pass %" value={`${k!.knowledge_completion_pct}%`} color="indigo" />
              <KpiCard icon={<ListTodo className="w-4 h-4" />} label="Open Tasks" value={k!.total_open} color="blue" />
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ChartCard title="Tasks by Status" subtitle="All active tasks">
                {statusChart.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={statusChart} margin={{ left: -10, right: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
                      <XAxis dataKey="name" stroke="#8B7355" fontSize={10} tick={{ fill: '#6B5744' }} interval={0} angle={-30} textAnchor="end" height={70} />
                      <YAxis stroke="#8B7355" fontSize={11} tick={{ fill: '#6B5744' }} allowDecimals={false} />
                      <Tooltip contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid #E8D5C4', borderRadius: 8, color: '#2D1B0E' }} />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                        {statusChart.map((e, i) => <Cell key={i} fill={e.fill} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : <EmptyChart />}
              </ChartCard>

              <ChartCard title="Tasks by Category" subtitle="Distribution across categories">
                {categoryChart.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie data={categoryChart} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={105} paddingAngle={2} stroke="none">
                        {categoryChart.map((_e, i) => <Cell key={i} fill={CATEGORY_HEX[i % CATEGORY_HEX.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid #E8D5C4', borderRadius: 8, color: '#2D1B0E' }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : <EmptyChart />}
                {categoryChart.length > 0 && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 justify-center">
                    {categoryChart.map((e, i) => (
                      <span key={i} className="inline-flex items-center gap-1.5 text-xs text-[#6B5744]">
                        <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: CATEGORY_HEX[i % CATEGORY_HEX.length] }} />
                        {e.name} <span className="text-[#8B7355]">({e.value})</span>
                      </span>
                    ))}
                  </div>
                )}
              </ChartCard>
            </div>

            {/* Upcoming + Recent */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Upcoming */}
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
                    <CalendarClock className="w-5 h-5 text-[#af4408]" /> Upcoming Tasks
                  </h3>
                  <a href="/tasks/calendar" className="text-xs text-[#af4408] hover:underline flex items-center gap-1">
                    Calendar <ArrowRight className="w-3 h-3" />
                  </a>
                </div>
                {data.upcoming.length === 0 ? (
                  <p className="text-sm text-[#8B7355] text-center py-8">No upcoming scheduled tasks.</p>
                ) : (
                  <ul className="divide-y divide-[#E8D5C4]/60">
                    {data.upcoming.map((t) => {
                      const pm = priorityMeta(t.priority);
                      return (
                        <li key={t.id} className="py-2.5 flex items-start gap-3">
                          <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${pm.color}`}>{pm.label}</span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-[#2D1B0E] font-medium truncate">{t.title}</p>
                            <p className="text-xs text-[#8B7355] truncate">
                              {t.department || 'No dept'}{t.assignee_name ? ` · ${t.assignee_name}` : ''}
                            </p>
                          </div>
                          <span className="shrink-0 text-xs text-[#6B5744] text-right">
                            {fmtDate(t.due_date)}{t.due_time ? <><br /><span className="text-[10px] text-[#8B7355]">{t.due_time}</span></> : null}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* Recent activity */}
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
                <h3 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2 mb-3">
                  <Activity className="w-5 h-5 text-[#af4408]" /> Recent Activity
                </h3>
                {data.recent.length === 0 ? (
                  <p className="text-sm text-[#8B7355] text-center py-8">No recent status changes.</p>
                ) : (
                  <ul className="space-y-3">
                    {data.recent.map((r) => {
                      const to = statusMeta(r.to_status);
                      return (
                        <li key={r.id} className="flex items-start gap-3">
                          <span className={`shrink-0 mt-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${to.color}`}>{to.label}</span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-[#2D1B0E] truncate">{r.title || 'Task'}</p>
                            <p className="text-xs text-[#8B7355] truncate">
                              {r.from_status ? `${statusMeta(r.from_status).label} → ${to.label}` : to.label}
                              {r.changed_by ? ` · ${r.changed_by}` : ''}
                            </p>
                          </div>
                          <span className="shrink-0 text-[10px] text-[#8B7355] text-right">{fmtDateTime(r.created_at)}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>

            {/* Department performance */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
              <h3 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2 mb-3">
                <ListTodo className="w-5 h-5 text-[#af4408]" /> Department Performance
              </h3>
              {data.dept_performance.length === 0 ? (
                <p className="text-sm text-[#8B7355] text-center py-6">No tasks yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-[#E8D5C4]">
                  <table className="w-full text-sm">
                    <thead className="bg-[#FFF1E3] text-[#8B7355]">
                      <tr>
                        <th className="text-left py-2 px-3 font-medium">Department</th>
                        <th className="text-right py-2 px-3 font-medium">Total</th>
                        <th className="text-right py-2 px-3 font-medium">Done</th>
                        <th className="text-right py-2 px-3 font-medium">Pending</th>
                        <th className="text-right py-2 px-3 font-medium">Overdue</th>
                        <th className="text-left py-2 px-3 font-medium w-40">Completion</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.dept_performance.map((d) => (
                        <tr key={d.department} className="border-t border-[#E8D5C4]/50">
                          <td className="py-2 px-3 font-medium text-[#2D1B0E]">{d.department}</td>
                          <td className="py-2 px-3 text-right font-mono text-[#6B5744]">{d.total}</td>
                          <td className="py-2 px-3 text-right font-mono text-green-600">{d.completed}</td>
                          <td className="py-2 px-3 text-right font-mono text-amber-600">{d.pending}</td>
                          <td className={`py-2 px-3 text-right font-mono ${d.overdue > 0 ? 'text-red-600' : 'text-[#6B5744]'}`}>{d.overdue}</td>
                          <td className="py-2 px-3">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-2 bg-[#FFF1E3] rounded">
                                <div className="h-2 bg-[#af4408] rounded" style={{ width: `${d.completion_pct}%` }} />
                              </div>
                              <span className="text-xs font-mono text-[#6B5744] w-9 text-right">{d.completion_pct}%</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Employee productivity */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
              <h3 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2 mb-3">
                <CheckCheck className="w-5 h-5 text-[#af4408]" /> Employee Productivity
                <span className="text-xs font-normal text-[#8B7355]">Top 15 by assigned tasks</span>
              </h3>
              {data.employee_productivity.length === 0 ? (
                <p className="text-sm text-[#8B7355] text-center py-6">No assigned tasks yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-[#E8D5C4]">
                  <table className="w-full text-sm">
                    <thead className="bg-[#FFF1E3] text-[#8B7355]">
                      <tr>
                        <th className="text-left py-2 px-3 font-medium">Employee</th>
                        <th className="text-right py-2 px-3 font-medium">Total</th>
                        <th className="text-right py-2 px-3 font-medium">Done</th>
                        <th className="text-right py-2 px-3 font-medium">Pending</th>
                        <th className="text-right py-2 px-3 font-medium">Overdue</th>
                        <th className="text-left py-2 px-3 font-medium w-40">Completion</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.employee_productivity.map((e) => (
                        <tr key={e.assignee_email} className="border-t border-[#E8D5C4]/50">
                          <td className="py-2 px-3 font-medium text-[#2D1B0E]">
                            {e.assignee_name || e.assignee_email}
                            <span className="block text-[10px] text-[#8B7355] font-normal">{e.assignee_email}</span>
                          </td>
                          <td className="py-2 px-3 text-right font-mono text-[#6B5744]">{e.total}</td>
                          <td className="py-2 px-3 text-right font-mono text-green-600">{e.completed}</td>
                          <td className="py-2 px-3 text-right font-mono text-amber-600">{e.pending}</td>
                          <td className={`py-2 px-3 text-right font-mono ${e.overdue > 0 ? 'text-red-600' : 'text-[#6B5744]'}`}>{e.overdue}</td>
                          <td className="py-2 px-3">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-2 bg-[#FFF1E3] rounded">
                                <div className="h-2 bg-green-500 rounded" style={{ width: `${e.completion_pct}%` }} />
                              </div>
                              <span className="text-xs font-mono text-[#6B5744] w-9 text-right">{e.completion_pct}%</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {data.generated_at && (
              <p className="text-[10px] text-[#8B7355] text-right">
                Updated {fmtDateTime(data.generated_at)}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── sub-components ────────────────────────────────────────────────────── */

function QuickAction({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <a href={href} className="inline-flex items-center gap-2 px-3.5 py-2 bg-white border border-[#E8D5C4] hover:border-[#af4408] hover:bg-[#FFF1E3] text-[#3D2614] rounded-lg text-sm font-medium transition-colors">
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

function KpiCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: React.ReactNode; color: keyof typeof KPI_ACCENTS }) {
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

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-[#2D1B0E]">{title}</h3>
        <p className="text-xs text-[#8B7355]">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex items-center justify-center h-[300px] text-[#8B7355] text-sm">
      No data available
    </div>
  );
}
