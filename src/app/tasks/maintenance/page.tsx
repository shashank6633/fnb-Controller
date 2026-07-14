'use client';

/**
 * Maintenance Schedules (/tasks/maintenance) — Task Management slice.
 *
 * Preventive-maintenance register grouped Daily / Weekly / Monthly. Managers can
 * create/edit schedules, generate the due tasks in one click ("Generate due tasks
 * now" → source=maintenance tasks + advances next_due_date), log a schedule as done,
 * and browse the maintenance log history. Search + frequency/active filters + CSV.
 *
 * Client gate mirrors the API: canManageTasks (admin / manager / head chef / store
 * manager) may mutate; anyone signed in can view.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, CalendarClock, CheckCircle2, ClipboardList, Download,
  Loader2, Pencil, Play, Plus, RefreshCw, Search, Wrench, X, Zap,
} from 'lucide-react';
import { api } from '@/lib/api';
import { TASK_DEPARTMENTS, canManageTasks } from '@/lib/tasks';

/* ── types ─────────────────────────────────────────────────────────────── */

interface Schedule {
  id: string;
  name: string;
  category: string;
  frequency: 'daily' | 'weekly' | 'monthly' | string;
  department: string;
  assignee_email: string;
  next_due_date: string;
  last_generated_date: string;
  is_active: number;
  is_due?: boolean;
  created_at: string;
  updated_at: string;
}

interface MaintLog {
  id: string;
  schedule_id: string;
  task_id: string;
  performed_by: string;
  performed_at: string;
  status: string;
  notes: string;
  created_at: string;
  schedule_name?: string;
  schedule_frequency?: string;
}

/* ── helpers ───────────────────────────────────────────────────────────── */

const FREQ_GROUPS: { key: 'daily' | 'weekly' | 'monthly'; label: string }[] = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
];

const FREQ_CLS: Record<string, string> = {
  daily: 'bg-blue-100 text-blue-700 border-blue-200',
  weekly: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  monthly: 'bg-purple-100 text-purple-700 border-purple-200',
};

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const fmtDateTime = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const csvCell = (x: any) => {
  const s = String(x ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const EMPTY_FORM = {
  id: '',
  name: '',
  frequency: 'daily' as 'daily' | 'weekly' | 'monthly',
  category: 'Maintenance',
  department: 'Maintenance',
  assignee_email: '',
  next_due_date: '',
  is_active: 1,
};

/* ── page ──────────────────────────────────────────────────────────────── */

export default function MaintenancePage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined); // undefined=loading, null=signed out

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [logs, setLogs] = useState<MaintLog[]>([]);
  const [today, setToday] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [freqFilter, setFreqFilter] = useState<string>('');
  const [activeFilter, setActiveFilter] = useState<string>('');

  const [generating, setGenerating] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  // Create/edit modal
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // per-row busy id (log-complete)
  const [busyId, setBusyId] = useState<string | null>(null);

  const allowed = !!me; // any signed-in user can view
  const canManage = canManageTasks(me);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (freqFilter) params.set('frequency', freqFilter);
    if (activeFilter) params.set('active', activeFilter);
    fetch(`/api/tasks/maintenance?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) { setError(j.error); setSchedules([]); setLogs([]); return; }
        setSchedules(j.schedules || []);
        setLogs(j.logs || []);
        setToday(j.today || '');
      })
      .catch((e) => { setError(e?.message || 'Failed to load'); setSchedules([]); })
      .finally(() => setLoading(false));
  }, [q, freqFilter, activeFilter]);

  useEffect(() => {
    if (!allowed) return;
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [allowed, load]);

  /* ── actions ── */

  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    setError(null);
    try {
      const r = await api('/api/tasks/maintenance', { method: 'POST', body: { action: 'generate' } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setNotice(j.generated > 0 ? `Generated ${j.generated} maintenance task${j.generated === 1 ? '' : 's'}` : 'No schedules are due right now');
      load();
    } catch (e: any) {
      setError(e?.message || 'Failed to generate');
    } finally {
      setGenerating(false);
    }
  };

  const saveSchedule = async () => {
    if (saving) return;
    if (!form.name.trim()) { setModalError('Name is required'); return; }
    setSaving(true);
    setModalError(null);
    try {
      const editing = !!form.id;
      const r = await api('/api/tasks/maintenance', {
        method: editing ? 'PUT' : 'POST',
        body: editing
          ? { ...form }
          : { action: 'create', ...form },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setModalError(j.error || `HTTP ${r.status}`); return; }
      setShowForm(false);
      setForm({ ...EMPTY_FORM });
      setNotice(editing ? 'Schedule updated' : 'Schedule created');
      load();
    } catch (e: any) {
      setModalError(e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const logComplete = async (s: Schedule) => {
    if (busyId) return;
    setBusyId(s.id);
    setError(null);
    try {
      const r = await api('/api/tasks/maintenance', {
        method: 'POST',
        body: { action: 'log-complete', schedule_id: s.id },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setNotice(`Logged "${s.name}" as done`);
      load();
    } catch (e: any) {
      setError(e?.message || 'Failed to log');
    } finally {
      setBusyId(null);
    }
  };

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, next_due_date: today });
    setModalError(null);
    setShowForm(true);
  };

  const openEdit = (s: Schedule) => {
    setForm({
      id: s.id,
      name: s.name,
      frequency: (['daily', 'weekly', 'monthly'].includes(s.frequency) ? s.frequency : 'daily') as any,
      category: s.category || 'Maintenance',
      department: s.department || 'Maintenance',
      assignee_email: s.assignee_email || '',
      next_due_date: s.next_due_date || '',
      is_active: s.is_active,
    });
    setModalError(null);
    setShowForm(true);
  };

  const exportCsv = () => {
    const header = ['Name', 'Frequency', 'Category', 'Department', 'Assignee', 'Next Due', 'Last Generated', 'Active', 'Due Now'];
    const lines = [header.join(',')];
    for (const s of schedules) {
      lines.push([
        s.name, s.frequency, s.category, s.department, s.assignee_email,
        s.next_due_date, s.last_generated_date, s.is_active ? 'Yes' : 'No', s.is_due ? 'Yes' : 'No',
      ].map(csvCell).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `maintenance-schedules-${today || 'export'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const dueCount = useMemo(() => schedules.filter((s) => s.is_due).length, [schedules]);

  const grouped = useMemo(() => {
    const g: Record<string, Schedule[]> = { daily: [], weekly: [], monthly: [], other: [] };
    for (const s of schedules) {
      (g[s.frequency] || g.other).push(s);
    }
    return g;
  }, [schedules]);

  /* ── gates ── */
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
          🔒 Please sign in to view maintenance schedules.
        </div>
      </div>
    );
  }

  const scheduleCard = (s: Schedule) => (
    <div key={s.id} className={`bg-white border rounded-xl p-3 ${s.is_due ? 'border-[#af4408]' : 'border-[#E8D5C4]'} ${!s.is_active ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm text-[#2D1B0E] truncate">{s.name}</span>
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${FREQ_CLS[s.frequency] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
              {s.frequency}
            </span>
            {s.is_due && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">due</span>
            )}
            {!s.is_active && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200">inactive</span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-[#6B5744]">
            <span>{s.department || '—'}</span>
            {s.assignee_email && <span>· {s.assignee_email}</span>}
            <span>· next: <span className="text-[#2D1B0E]">{fmtDate(s.next_due_date)}</span></span>
            {s.last_generated_date && <span>· last gen: {fmtDate(s.last_generated_date)}</span>}
          </div>
        </div>
        {canManage && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => logComplete(s)}
              disabled={busyId === s.id}
              title="Log as done"
              className="inline-flex items-center gap-1 text-xs bg-white border border-[#E8D5C4] hover:border-green-400 text-green-700 rounded-lg px-2 py-1 disabled:opacity-50"
            >
              {busyId === s.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Log
            </button>
            <button
              onClick={() => openEdit(s)}
              title="Edit"
              className="inline-flex items-center text-[#8B7355] hover:text-[#af4408] p-1"
            >
              <Pencil size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto pb-16">
      {/* Header */}
      <div>
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-2">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Wrench size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Maintenance Schedules</h1>
            <p className="text-xs text-[#8B7355]">
              Preventive maintenance register — generate due tasks & log completion
              {dueCount > 0 && <span className="text-[#af4408] font-semibold"> · {dueCount} due now</span>}
            </p>
          </div>
          <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          {canManage && (
            <>
              <button onClick={generate} disabled={generating} className="inline-flex items-center gap-1.5 bg-[#8a3606] hover:bg-[#732d05] text-white text-sm rounded-lg px-3 py-2 disabled:opacity-50">
                {generating ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} Generate due tasks now
              </button>
              <button onClick={openCreate} className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-2">
                <Plus size={14} /> New Schedule
              </button>
            </>
          )}
        </div>
      </div>

      {/* Banners */}
      {notice && (
        <div className="flex items-center justify-between gap-2 bg-green-50 border border-green-200 text-green-800 text-sm rounded-lg px-3 py-2">
          <span className="flex items-center gap-2"><CheckCircle2 size={15} className="shrink-0" /> {notice}</span>
          <button onClick={() => setNotice(null)} className="text-green-700 hover:text-green-900"><X size={14} /></button>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={15} className="shrink-0" /> {error}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input
            type="text" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search schedules…"
            className="w-full border border-[#E8D5C4] rounded-lg pl-9 pr-3 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]"
          />
        </div>
        <select value={freqFilter} onChange={(e) => setFreqFilter(e.target.value)} className="border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
          <option value="">All frequencies</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
        <select value={activeFilter} onChange={(e) => setActiveFilter(e.target.value)} className="border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
          <option value="">Active & inactive</option>
          <option value="1">Active only</option>
          <option value="0">Inactive only</option>
        </select>
        <button onClick={exportCsv} disabled={!schedules.length} className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50">
          <Download size={14} /> CSV
        </button>
        <button onClick={() => setShowLogs((v) => !v)} className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2">
          <ClipboardList size={14} /> {showLogs ? 'Hide' : 'Show'} logs
        </button>
      </div>

      {/* Loading / empty */}
      {loading && schedules.length === 0 && (
        <div className="p-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading schedules…
        </div>
      )}
      {!loading && schedules.length === 0 && !error && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
          {q || freqFilter || activeFilter ? 'No schedules match the filters.' : 'No maintenance schedules yet.'}
        </div>
      )}

      {/* Groups */}
      {schedules.length > 0 && FREQ_GROUPS.map((grp) => {
        const rows = grouped[grp.key] || [];
        if (!rows.length) return null;
        return (
          <div key={grp.key} className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#2D1B0E]">
              <CalendarClock size={16} className="text-[#af4408]" /> {grp.label}
              <span className="text-xs font-normal text-[#8B7355]">({rows.length})</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {rows.map(scheduleCard)}
            </div>
          </div>
        );
      })}
      {schedules.length > 0 && (grouped.other?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-semibold text-[#2D1B0E]">Other</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">{grouped.other.map(scheduleCard)}</div>
        </div>
      )}

      {/* Logs / history */}
      {showLogs && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 bg-[#FFF8F0] text-sm font-semibold text-[#2D1B0E] flex items-center gap-2">
            <ClipboardList size={15} className="text-[#af4408]" /> Maintenance Logs
            <span className="text-xs font-normal text-[#8B7355]">(last {logs.length})</span>
          </div>
          {logs.length === 0 ? (
            <div className="p-6 text-center text-sm text-[#8B7355]">No log entries yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#FFF8F0] text-left text-xs text-[#8B7355] uppercase tracking-wide">
                    <th className="px-4 py-2 font-semibold">When</th>
                    <th className="px-4 py-2 font-semibold">Schedule</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                    <th className="px-4 py-2 font-semibold">By</th>
                    <th className="px-4 py-2 font-semibold">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F0E4D6]">
                  {logs.map((l) => (
                    <tr key={l.id}>
                      <td className="px-4 py-2 text-[#6B5744] whitespace-nowrap">{fmtDateTime(l.created_at)}</td>
                      <td className="px-4 py-2 text-[#2D1B0E]">{l.schedule_name || '—'}</td>
                      <td className="px-4 py-2">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${l.status === 'done' ? 'bg-green-100 text-green-700 border-green-200' : 'bg-blue-100 text-blue-700 border-blue-200'}`}>
                          {l.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-[#6B5744]">{l.performed_by || '—'}</td>
                      <td className="px-4 py-2 text-[#6B5744]">{l.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Create/edit modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-4 sm:p-5 space-y-3 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2">
                <Wrench size={18} className="text-[#af4408]" /> {form.id ? 'Edit Schedule' : 'New Schedule'}
              </h2>
              <button onClick={() => setShowForm(false)} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={18} /></button>
            </div>
            {modalError && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-2.5 py-1.5">
                <AlertCircle size={13} className="shrink-0" /> {modalError}
              </div>
            )}
            <div className="space-y-2">
              <input
                type="text" placeholder="Schedule name *" value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]"
              />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-[#8B7355]">Frequency</label>
                  <select value={form.frequency} onChange={(e) => setForm((f) => ({ ...f, frequency: e.target.value as any }))} className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-[#8B7355]">Department</label>
                  <select value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                    {TASK_DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-[#8B7355]">Category</label>
                  <input type="text" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
                </div>
                <div>
                  <label className="text-xs text-[#8B7355]">Next due date</label>
                  <input type="date" value={form.next_due_date} onChange={(e) => setForm((f) => ({ ...f, next_due_date: e.target.value }))} className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
                </div>
              </div>
              <div>
                <label className="text-xs text-[#8B7355]">Assignee email (optional)</label>
                <input type="email" placeholder="name@example.com" value={form.assignee_email} onChange={(e) => setForm((f) => ({ ...f, assignee_email: e.target.value }))} className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
              </div>
              <label className="flex items-center gap-2 text-sm text-[#2D1B0E]">
                <input type="checkbox" checked={!!form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked ? 1 : 0 }))} className="accent-[#af4408]" />
                Active
              </label>
            </div>
            <button onClick={saveSchedule} disabled={saving || !form.name.trim()} className="w-full inline-flex items-center justify-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm font-semibold rounded-lg px-3 py-2.5 disabled:opacity-50">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} {form.id ? 'Save changes' : 'Create schedule'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
