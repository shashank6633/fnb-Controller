'use client';

/**
 * Task Management — Reports & Analytics (/tasks/reports)
 *
 * Management dashboard over the whole Task-Management module. A report-type
 * selector switches between eight views (Overview, Departments, Employees,
 * Hygiene, Maintenance, Training, Knowledge, Overdue), all rendered from a
 * single /api/tasks/reports payload (switching never re-fetches). Each view is
 * KPI cards + recharts + a table. Export the active view to CSV or Excel, or
 * print the page to PDF.
 *
 * Gate: admin | manager | head chef | store manager (canManageTasks). The API
 * enforces the same gate; non-managers see a lock card.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as XLSX from 'xlsx';
import {
  AlertTriangle, ArrowLeft, BarChart3, Building2, CheckCheck, Download,
  FileSpreadsheet, GraduationCap, Loader2, Lock, Printer, RefreshCw,
  SprayCan, Users, Wrench, Brain, ClipboardList,
} from 'lucide-react';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { statusMeta, priorityMeta } from '@/lib/tasks';

/* ── helpers ──────────────────────────────────────────────────────────── */

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
const csvCell = (x: any) => {
  const s = String(x ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
function fmtMins(m: number | null): string {
  if (m == null) return '—';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

type ReportType =
  | 'overview' | 'departments' | 'employees' | 'hygiene'
  | 'maintenance' | 'training' | 'knowledge' | 'overdue';

const REPORT_TABS: { key: ReportType; label: string; icon: any }[] = [
  { key: 'overview', label: 'Overview', icon: BarChart3 },
  { key: 'departments', label: 'Departments', icon: Building2 },
  { key: 'employees', label: 'Employees', icon: Users },
  { key: 'hygiene', label: 'Hygiene', icon: SprayCan },
  { key: 'maintenance', label: 'Maintenance', icon: Wrench },
  { key: 'training', label: 'Training', icon: GraduationCap },
  { key: 'knowledge', label: 'Knowledge Tests', icon: Brain },
  { key: 'overdue', label: 'Overdue', icon: AlertTriangle },
];

const CHART = {
  primary: '#af4408',
  green: '#10B981',
  red: '#EF4444',
  amber: '#F59E0B',
  blue: '#3B82F6',
  purple: '#8B5CF6',
};
const PIE_COLORS = ['#af4408', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#14B8A6', '#F97316', '#EAB308', '#6366F1'];

/* ── page ─────────────────────────────────────────────────────────────── */

export default function TaskReportsPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined); // undefined = loading, null = signed out
  const allowed = !!me && (me.role === 'admin' || me.role === 'manager' || me.is_head_chef || me.is_store_manager);

  const [from, setFrom] = useState(daysAgoISO(29));
  const [to, setTo] = useState(todayISO());
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [tab, setTab] = useState<ReportType>('overview');

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ from, to, period });
      const res = await fetch(`/api/tasks/reports?${qs}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e: any) {
      setError(e?.message || 'Failed to load report');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [from, to, period]);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  /* ── export (active tab) ── */
  const exportRows = useMemo<{ name: string; rows: (string | number)[][] }>(() => {
    if (!data) return { name: 'report', rows: [] };
    switch (tab) {
      case 'departments':
        return {
          name: 'departments',
          rows: [
            ['Department', 'Total', 'Completed', 'Approved', 'Overdue', 'Completion %', 'Avg Time'],
            ...data.department_performance.map((d: any) => [
              d.department, d.total, d.completed, d.approved, d.overdue, d.completion_rate, fmtMins(d.avg_minutes),
            ]),
          ],
        };
      case 'employees':
        return {
          name: 'employees',
          rows: [
            ['Employee', 'Email', 'Total', 'Completed', 'Approved', 'Overdue', 'Completion %', 'On-time %'],
            ...data.employee_productivity.map((e: any) => [
              e.name, e.email, e.total, e.completed, e.approved, e.overdue, e.completion_rate, e.on_time_rate,
            ]),
          ],
        };
      case 'hygiene':
        return {
          name: 'hygiene',
          rows: [
            ['Area', 'Audits', 'Pass', 'Fail', 'Pass %', 'Avg Score'],
            ...data.hygiene_by_area.map((h: any) => [h.area, h.total, h.pass, h.fail, h.pass_rate, h.avg_score]),
          ],
        };
      case 'maintenance':
        return {
          name: 'maintenance',
          rows: [
            ['Frequency', 'Active Schedules', 'Completed', 'Compliance %'],
            ...data.maintenance.by_frequency.map((m: any) => [m.frequency, m.active, m.done, m.compliance_rate]),
          ],
        };
      case 'training':
        return {
          name: 'training',
          rows: [
            ['Metric', 'Value'],
            ['Total sessions', data.training.total],
            ['Completed', data.training.completed],
            ['Scheduled', data.training.scheduled],
            ['Cancelled', data.training.cancelled],
            ['Attendees', data.training.attendees],
            ['Completion %', data.training.completion_rate],
          ],
        };
      case 'knowledge':
        return {
          name: 'knowledge',
          rows: [
            ['Metric', 'Value'],
            ['Active tests', data.knowledge.tests_active],
            ['Attempts', data.knowledge.attempts],
            ['Passed', data.knowledge.passed],
            ['Pass %', data.knowledge.pass_rate],
            ['Avg score', data.knowledge.avg_score],
          ],
        };
      case 'overdue':
        return {
          name: 'overdue',
          rows: [
            ['Title', 'Department', 'Assignee', 'Due', 'Days Overdue', 'Priority', 'Status'],
            ...data.overdue.map((o: any) => [
              o.title, o.department, o.assignee_name, o.due_date, o.days_overdue, o.priority, o.status,
            ]),
          ],
        };
      default:
        return {
          name: 'overview',
          rows: [
            ['Period', 'Created', 'Completed', 'Approved'],
            ...data.period_series.map((p: any) => [p.period, p.created, p.completed, p.approved]),
          ],
        };
    }
  }, [data, tab]);

  const handleCsv = () => {
    if (!exportRows.rows.length) return;
    downloadCsv(`tasks-${exportRows.name}_${from}_to_${to}.csv`, exportRows.rows);
  };
  const handleExcel = () => {
    if (!data) return;
    const wb = XLSX.utils.book_new();
    const add = (name: string, rows: (string | number)[][]) => {
      if (!rows.length) return;
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name.slice(0, 31));
    };
    add('Overview', [
      ['Task Management Report'],
      ['Range', `${from} → ${to}`],
      [],
      ['KPI', 'Value'],
      ['Total tasks', data.summary.total],
      ['Completed', data.summary.completed],
      ['Approved', data.summary.approved],
      ['In progress', data.summary.in_progress],
      ['Overdue (now)', data.summary.overdue],
      ['Completion %', data.summary.completion_rate],
      [],
      ['Period', 'Created', 'Completed', 'Approved'],
      ...data.period_series.map((p: any) => [p.period, p.created, p.completed, p.approved]),
    ]);
    add('Departments', [
      ['Department', 'Total', 'Completed', 'Approved', 'Overdue', 'Completion %', 'Avg Minutes'],
      ...data.department_performance.map((d: any) => [d.department, d.total, d.completed, d.approved, d.overdue, d.completion_rate, d.avg_minutes ?? '']),
    ]);
    add('Employees', [
      ['Employee', 'Email', 'Total', 'Completed', 'Approved', 'Overdue', 'Completion %', 'On-time %'],
      ...data.employee_productivity.map((e: any) => [e.name, e.email, e.total, e.completed, e.approved, e.overdue, e.completion_rate, e.on_time_rate]),
    ]);
    add('Hygiene', [
      ['Area', 'Audits', 'Pass', 'Fail', 'Pass %', 'Avg Score'],
      ...data.hygiene_by_area.map((h: any) => [h.area, h.total, h.pass, h.fail, h.pass_rate, h.avg_score]),
    ]);
    add('Maintenance', [
      ['Frequency', 'Active', 'Completed', 'Compliance %'],
      ...data.maintenance.by_frequency.map((m: any) => [m.frequency, m.active, m.done, m.compliance_rate]),
    ]);
    add('Overdue', [
      ['Title', 'Department', 'Assignee', 'Due', 'Days Overdue', 'Priority', 'Status'],
      ...data.overdue.map((o: any) => [o.title, o.department, o.assignee_name, o.due_date, o.days_overdue, o.priority, o.status]),
    ]);
    XLSX.writeFile(wb, `tasks-report_${from}_to_${to}.xlsx`);
  };

  /* ── auth states ── */
  if (me === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FFF8F0]">
        <Loader2 className="w-6 h-6 animate-spin text-[#af4408]" />
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-4 sm:p-6">
        <div className="max-w-md mx-auto mt-16 bg-amber-50 border border-amber-200 rounded-xl p-6 text-center">
          <Lock className="w-10 h-10 text-amber-500 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-[#2D1B0E] mb-1">Manager access required</h2>
          <p className="text-sm text-[#8B7355]">Task reports are limited to admins, managers, head chefs, and store managers.</p>
          <button onClick={() => router.back()} className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-white border border-[#E8D5C4] rounded-lg text-sm text-[#2D1B0E] hover:bg-[#FFF1E3]">
            <ArrowLeft className="w-4 h-4" /> Go back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Back */}
        <button onClick={() => router.back()} className="inline-flex items-center gap-1.5 text-sm text-[#8B7355] hover:text-[#af4408] transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-[#af4408]/10 text-[#af4408]">
              <BarChart3 className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[#2D1B0E]">Task Reports & Analytics</h1>
              <p className="text-sm text-[#8B7355] mt-0.5">Throughput, compliance, and productivity across the Task-Management module.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 print:hidden">
            <button onClick={handleCsv} className="inline-flex items-center gap-2 px-3 py-2 bg-white border border-[#E8D5C4] rounded-lg text-sm text-[#2D1B0E] hover:bg-[#FFF1E3]">
              <Download className="w-4 h-4" /> CSV
            </button>
            <button onClick={handleExcel} className="inline-flex items-center gap-2 px-3 py-2 bg-white border border-[#E8D5C4] rounded-lg text-sm text-[#2D1B0E] hover:bg-[#FFF1E3]">
              <FileSpreadsheet className="w-4 h-4" /> Excel
            </button>
            <button onClick={() => window.print()} className="inline-flex items-center gap-2 px-3 py-2 bg-white border border-[#E8D5C4] rounded-lg text-sm text-[#2D1B0E] hover:bg-[#FFF1E3]">
              <Printer className="w-4 h-4" /> Print
            </button>
            <button onClick={load} className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg text-sm font-medium">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 flex flex-wrap items-end gap-4 print:hidden">
          <div>
            <label className="block text-xs text-[#8B7355] mb-1">From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
          </div>
          <div>
            <label className="block text-xs text-[#8B7355] mb-1">To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
          </div>
          <div>
            <label className="block text-xs text-[#8B7355] mb-1">Trend period</label>
            <div className="flex gap-1 bg-[#FFF1E3] rounded-lg p-1">
              {(['daily', 'weekly', 'monthly'] as const).map((p) => (
                <button key={p} onClick={() => setPeriod(p)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${period === p ? 'bg-[#af4408] text-white' : 'text-[#8B7355] hover:text-[#2D1B0E]'}`}>
                  {p[0].toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Report-type selector */}
        <div className="flex flex-wrap gap-2">
          {REPORT_TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                  tab === t.key
                    ? 'bg-[#af4408] text-white border-[#af4408]'
                    : 'bg-white text-[#2D1B0E] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                }`}>
                <Icon className="w-4 h-4" /> {t.label}
              </button>
            );
          })}
        </div>

        {/* Body */}
        {loading ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-16 flex flex-col items-center gap-3">
            <Loader2 className="w-7 h-7 animate-spin text-[#af4408]" />
            <p className="text-sm text-[#8B7355]">Building report…</p>
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
            <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
            <p className="text-sm text-red-700">{error}</p>
            <button onClick={load} className="mt-3 px-4 py-2 bg-white border border-[#E8D5C4] rounded-lg text-sm hover:bg-[#FFF1E3]">Retry</button>
          </div>
        ) : !data ? null : (
          <ReportBody tab={tab} data={data} period={period} />
        )}

        <p className="text-[10px] text-[#8B7355] text-center">
          Range {data?.range?.from} → {data?.range?.to} · generated {data?.generated_at ? new Date(data.generated_at).toLocaleString('en-IN') : ''}
        </p>
      </div>
    </div>
  );
}

/* ── report body (per tab) ────────────────────────────────────────────── */

function ReportBody({ tab, data, period }: { tab: ReportType; data: any; period: string }) {
  if (tab === 'overview') return <OverviewReport data={data} period={period} />;
  if (tab === 'departments') return <DepartmentsReport data={data} />;
  if (tab === 'employees') return <EmployeesReport data={data} />;
  if (tab === 'hygiene') return <HygieneReport data={data} />;
  if (tab === 'maintenance') return <MaintenanceReport data={data} />;
  if (tab === 'training') return <TrainingReport data={data} />;
  if (tab === 'knowledge') return <KnowledgeReport data={data} />;
  return <OverdueReport data={data} />;
}

function Kpi({ label, value, tone = 'default', icon }: { label: string; value: string | number; tone?: 'default' | 'good' | 'bad' | 'warn'; icon?: any }) {
  const toneCls =
    tone === 'good' ? 'text-green-600' : tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-[#af4408]';
  const Icon = icon;
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1.5 text-[#8B7355]">
        {Icon ? <Icon className="w-4 h-4" /> : null}
        <span className="text-xs">{label}</span>
      </div>
      <p className={`text-2xl font-bold ${toneCls}`}>{value}</p>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-5">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-[#2D1B0E]">{title}</h3>
        {subtitle && <p className="text-xs text-[#8B7355] mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function EmptyChart({ label = 'No data in this range' }: { label?: string }) {
  return <div className="flex items-center justify-center h-[280px] text-sm text-[#8B7355]">{label}</div>;
}

const chartTooltip = { backgroundColor: '#FFFFFF', border: '1px solid #E8D5C4', borderRadius: '8px', color: '#2D1B0E', fontSize: 12 };
const axisTick = { fill: '#6B5744', fontSize: 11 };

function StatusPill({ status }: { status: string }) {
  const m = statusMeta(status);
  return <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded-full border ${m.color}`}>{m.label}</span>;
}
function PriorityPill({ priority }: { priority: string }) {
  const m = priorityMeta(priority);
  return <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded-full border ${m.color}`}>{m.label}</span>;
}

/* Overview */
function OverviewReport({ data, period }: { data: any; period: string }) {
  const s = data.summary;
  const statusData = data.status_breakdown.map((r: any) => ({ name: statusMeta(r.status).label, value: r.count }));
  const catData = data.category_breakdown.map((r: any) => ({ name: r.category, value: r.count }));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Kpi label="Total Tasks" value={s.total} icon={ClipboardList} />
        <Kpi label="Completed" value={s.completed} tone="good" icon={CheckCheck} />
        <Kpi label="Approved" value={s.approved} tone="good" />
        <Kpi label="In Progress" value={s.in_progress} tone="warn" />
        <Kpi label="Overdue (now)" value={s.overdue} tone="bad" icon={AlertTriangle} />
        <Kpi label="Completion %" value={`${s.completion_rate}%`} tone={s.completion_rate >= 70 ? 'good' : 'warn'} />
      </div>

      <Card title="Task Trend" subtitle={`Created vs completed vs approved · ${period}`}>
        {data.period_series.length ? (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.period_series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
              <XAxis dataKey="period" tick={axisTick} stroke="#8B7355" />
              <YAxis tick={axisTick} stroke="#8B7355" allowDecimals={false} />
              <Tooltip contentStyle={chartTooltip} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="created" name="Created" stroke={CHART.primary} strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="completed" name="Completed" stroke={CHART.green} strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="approved" name="Approved" stroke={CHART.blue} strokeWidth={2} strokeDasharray="5 5" dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        ) : <EmptyChart />}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="By Status">
          {statusData.length ? (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={100} paddingAngle={2} stroke="none">
                  {statusData.map((_e: any, i: number) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={chartTooltip} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : <EmptyChart />}
        </Card>

        <Card title="By Category">
          {catData.length ? (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={catData} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
                <XAxis type="number" tick={axisTick} stroke="#8B7355" allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={axisTick} stroke="#8B7355" width={90} />
                <Tooltip contentStyle={chartTooltip} />
                <Bar dataKey="value" name="Tasks" fill={CHART.primary} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyChart />}
        </Card>
      </div>

      <Card title="Priority Mix">
        <div className="flex flex-wrap gap-3">
          {data.priority_breakdown.length ? data.priority_breakdown.map((p: any) => (
            <div key={p.priority} className="flex items-center gap-2 bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg px-3 py-2">
              <PriorityPill priority={p.priority} />
              <span className="text-lg font-bold text-[#2D1B0E]">{p.count}</span>
            </div>
          )) : <p className="text-sm text-[#8B7355]">No tasks in range.</p>}
        </div>
      </Card>
    </div>
  );
}

/* Departments */
function DepartmentsReport({ data }: { data: any }) {
  const rows = data.department_performance;
  return (
    <div className="space-y-6">
      <Card title="Completion by Department" subtitle="Tasks completed vs overdue">
        {rows.length ? (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
              <XAxis dataKey="department" tick={axisTick} stroke="#8B7355" interval={0} angle={-20} textAnchor="end" height={70} />
              <YAxis tick={axisTick} stroke="#8B7355" allowDecimals={false} />
              <Tooltip contentStyle={chartTooltip} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="completed" name="Completed" stackId="a" fill={CHART.green} radius={[4, 4, 0, 0]} />
              <Bar dataKey="overdue" name="Overdue" stackId="a" fill={CHART.red} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <EmptyChart />}
      </Card>
      <Card title="Department Detail">
        <DataTable
          empty="No department activity in range."
          head={['Department', 'Total', 'Completed', 'Approved', 'Overdue', 'Completion %', 'Avg Time']}
          rows={rows.map((d: any) => [
            d.department, d.total, d.completed, d.approved,
            d.overdue > 0 ? <span key="o" className="text-red-600 font-medium">{d.overdue}</span> : d.overdue,
            `${d.completion_rate}%`, fmtMins(d.avg_minutes),
          ])}
        />
      </Card>
    </div>
  );
}

/* Employees */
function EmployeesReport({ data }: { data: any }) {
  const rows = data.employee_productivity;
  const top = rows.slice(0, 12).map((e: any) => ({ name: e.name, completed: e.completed, overdue: e.overdue }));
  return (
    <div className="space-y-6">
      <Card title="Top Performers" subtitle="Completed vs overdue (top 12 by volume)">
        {top.length ? (
          <ResponsiveContainer width="100%" height={340}>
            <BarChart data={top} layout="vertical" margin={{ left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
              <XAxis type="number" tick={axisTick} stroke="#8B7355" allowDecimals={false} />
              <YAxis type="category" dataKey="name" tick={axisTick} stroke="#8B7355" width={120} />
              <Tooltip contentStyle={chartTooltip} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="completed" name="Completed" fill={CHART.green} radius={[0, 4, 4, 0]} />
              <Bar dataKey="overdue" name="Overdue" fill={CHART.red} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <EmptyChart label="No assigned tasks in range" />}
      </Card>
      <Card title="Employee Productivity">
        <DataTable
          empty="No assignee activity in range."
          head={['Employee', 'Total', 'Completed', 'Approved', 'Overdue', 'Completion %', 'On-time %']}
          rows={rows.map((e: any) => [
            <div key="n"><div className="font-medium text-[#2D1B0E]">{e.name}</div><div className="text-[10px] text-[#8B7355]">{e.email}</div></div>,
            e.total, e.completed, e.approved,
            e.overdue > 0 ? <span key="o" className="text-red-600 font-medium">{e.overdue}</span> : e.overdue,
            `${e.completion_rate}%`,
            <span key="t" className={e.on_time_rate >= 80 ? 'text-green-600' : e.on_time_rate >= 50 ? 'text-amber-600' : 'text-red-600'}>{e.on_time_rate}%</span>,
          ])}
        />
      </Card>
    </div>
  );
}

/* Hygiene */
function HygieneReport({ data }: { data: any }) {
  const series = data.hygiene_series;
  const areas = data.hygiene_by_area;
  const totalAudits = areas.reduce((s: number, a: any) => s + a.total, 0);
  const totalPass = areas.reduce((s: number, a: any) => s + a.pass, 0);
  const totalFail = areas.reduce((s: number, a: any) => s + a.fail, 0);
  const avgScore = areas.length ? Math.round((areas.reduce((s: number, a: any) => s + a.avg_score * a.total, 0) / (totalAudits || 1)) * 10) / 10 : 0;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Audits" value={totalAudits} icon={SprayCan} />
        <Kpi label="Pass" value={totalPass} tone="good" />
        <Kpi label="Fail" value={totalFail} tone="bad" />
        <Kpi label="Avg Score" value={avgScore} tone={avgScore >= 80 ? 'good' : 'warn'} />
      </div>
      <Card title="Hygiene Score Over Time" subtitle="Average audit score per day">
        {series.length ? (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
              <XAxis dataKey="date" tick={axisTick} stroke="#8B7355" />
              <YAxis tick={axisTick} stroke="#8B7355" domain={[0, 100]} />
              <Tooltip contentStyle={chartTooltip} />
              <Line type="monotone" dataKey="avg_score" name="Avg Score" stroke={CHART.green} strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        ) : <EmptyChart />}
      </Card>
      <Card title="By Area">
        <DataTable
          empty="No hygiene audits in range."
          head={['Area', 'Audits', 'Pass', 'Fail', 'Pass %', 'Avg Score']}
          rows={areas.map((a: any) => [
            a.area, a.total, a.pass,
            a.fail > 0 ? <span key="f" className="text-red-600 font-medium">{a.fail}</span> : a.fail,
            `${a.pass_rate}%`, a.avg_score,
          ])}
        />
      </Card>
    </div>
  );
}

/* Maintenance */
function MaintenanceReport({ data }: { data: any }) {
  const m = data.maintenance;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Active Schedules" value={m.schedules_active} icon={Wrench} />
        <Kpi label="Serviced" value={m.schedules_done} tone="good" />
        <Kpi label="Logs Recorded" value={m.logs_done} />
        <Kpi label="Compliance %" value={`${m.compliance_rate}%`} tone={m.compliance_rate >= 80 ? 'good' : m.compliance_rate >= 50 ? 'warn' : 'bad'} />
      </div>
      <Card title="Compliance by Frequency" subtitle="Serviced schedules vs active schedules">
        {m.by_frequency.length ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={m.by_frequency}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
              <XAxis dataKey="frequency" tick={axisTick} stroke="#8B7355" />
              <YAxis tick={axisTick} stroke="#8B7355" allowDecimals={false} />
              <Tooltip contentStyle={chartTooltip} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="active" name="Active" fill={CHART.amber} radius={[4, 4, 0, 0]} />
              <Bar dataKey="done" name="Serviced" fill={CHART.green} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <EmptyChart />}
      </Card>
      <Card title="Frequency Detail">
        <DataTable
          empty="No maintenance schedules."
          head={['Frequency', 'Active', 'Serviced', 'Compliance %']}
          rows={m.by_frequency.map((r: any) => [
            r.frequency, r.active, r.done,
            <span key="c" className={r.compliance_rate >= 80 ? 'text-green-600' : r.compliance_rate >= 50 ? 'text-amber-600' : 'text-red-600'}>{r.compliance_rate}%</span>,
          ])}
        />
      </Card>
    </div>
  );
}

/* Training */
function TrainingReport({ data }: { data: any }) {
  const t = data.training;
  const pieData = [
    { name: 'Completed', value: t.completed },
    { name: 'Scheduled', value: t.scheduled },
    { name: 'Cancelled', value: t.cancelled },
  ].filter((d) => d.value > 0);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="Sessions" value={t.total} icon={GraduationCap} />
        <Kpi label="Completed" value={t.completed} tone="good" />
        <Kpi label="Scheduled" value={t.scheduled} tone="warn" />
        <Kpi label="Attendees" value={t.attendees} />
        <Kpi label="Completion %" value={`${t.completion_rate}%`} tone={t.completion_rate >= 70 ? 'good' : 'warn'} />
      </div>
      <Card title="Session Status">
        {pieData.length ? (
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={100} paddingAngle={2} stroke="none">
                <Cell fill={CHART.green} /><Cell fill={CHART.amber} /><Cell fill={CHART.red} />
              </Pie>
              <Tooltip contentStyle={chartTooltip} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        ) : <EmptyChart label="No training sessions in range" />}
      </Card>
    </div>
  );
}

/* Knowledge */
function KnowledgeReport({ data }: { data: any }) {
  const k = data.knowledge;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="Active Tests" value={k.tests_active} icon={Brain} />
        <Kpi label="Attempts" value={k.attempts} />
        <Kpi label="Passed" value={k.passed} tone="good" />
        <Kpi label="Pass %" value={`${k.pass_rate}%`} tone={k.pass_rate >= 60 ? 'good' : 'warn'} />
        <Kpi label="Avg Score" value={k.avg_score} tone={k.avg_score >= 60 ? 'good' : 'warn'} />
      </div>
      <Card title="Pass vs Fail" subtitle="Attempts in the selected range">
        {k.attempts > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={[{ name: 'Passed', value: k.passed }, { name: 'Failed', value: Math.max(0, k.attempts - k.passed) }]}
                dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={100} paddingAngle={2} stroke="none">
                <Cell fill={CHART.green} /><Cell fill={CHART.red} />
              </Pie>
              <Tooltip contentStyle={chartTooltip} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        ) : <EmptyChart label="No test attempts in range" />}
      </Card>
    </div>
  );
}

/* Overdue */
function OverdueReport({ data }: { data: any }) {
  const rows = data.overdue;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Kpi label="Overdue Tasks (now)" value={rows.length} tone="bad" icon={AlertTriangle} />
        <Kpi label="Most Overdue (days)" value={rows.length ? rows[0].days_overdue : 0} tone="bad" />
        <Kpi label="Urgent Overdue" value={rows.filter((o: any) => o.priority === 'urgent').length} tone="bad" />
      </div>
      <Card title="Overdue Tasks" subtitle="Current open tasks past their due date (all time, not range-bound)">
        <DataTable
          empty="Nothing overdue — great."
          head={['Task', 'Department', 'Assignee', 'Due', 'Days', 'Priority', 'Status']}
          rows={rows.map((o: any) => [
            <span key="t" className="font-medium text-[#2D1B0E]">{o.title}</span>,
            o.department || '—',
            o.assignee_name || '—',
            o.due_date,
            <span key="d" className="text-red-600 font-semibold">{o.days_overdue}</span>,
            <PriorityPill key="p" priority={o.priority} />,
            <StatusPill key="s" status={o.status} />,
          ])}
        />
      </Card>
    </div>
  );
}

/* generic table */
function DataTable({ head, rows, empty }: { head: string[]; rows: any[][]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-[#8B7355] text-center py-8">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-[#E8D5C4]">
      <table className="w-full text-sm">
        <thead className="bg-[#FFF1E3]">
          <tr className="text-[#8B7355]">
            {head.map((h, i) => (
              <th key={i} className={`py-2.5 px-3 font-medium ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/40">
              {r.map((c, ci) => (
                <td key={ci} className={`py-2.5 px-3 ${ci === 0 ? 'text-left text-[#3D2614]' : 'text-right text-[#3D2614] font-mono'}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
