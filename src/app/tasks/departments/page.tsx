'use client';

/**
 * Task Departments (/tasks/departments) — per-department task overview.
 *
 * A card per task department showing independent live stats (open / overdue /
 * completed / total) with completion %. Click a card to drill in: it expands to
 * that department's open tasks (fetched live) with a jump to the filtered board.
 * Managers/admins get an inline add form + rename / code edit / deactivate.
 *
 * Client gate: any signed-in user may VIEW; managers/admins may MANAGE. The API
 * enforces the same gate server-side. Warm theme, mobile-first, CSV export.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, Building2, CheckCircle2, ChevronDown, ChevronUp,
  Download, KanbanSquare, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { canManageTasks, priorityMeta, statusMeta } from '@/lib/tasks';

interface DeptStats { open: number; overdue: number; completed: number; total: number }
interface Dept {
  id: string;
  name: string;
  code: string;
  is_active: number;
  created_at: string;
  updated_at: string;
  stats: DeptStats;
}

interface DeptTask {
  id: string;
  title: string;
  priority: string;
  status: string;
  due_date: string;
  assignee_name: string;
  assignee_email: string;
}

const csvCell = (x: any) => {
  const s = String(x ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const pct = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0);

export default function TaskDepartmentsPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined); // undefined = loading, null = signed out

  const [rows, setRows] = useState<Dept[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  // Add form
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', code: '' });
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Inline edit
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', code: '' });

  // Drill-in
  const [openId, setOpenId] = useState<string | null>(null);
  const [deptTasks, setDeptTasks] = useState<DeptTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);

  const canManage = canManageTasks(me);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  const load = useCallback((incInactive: boolean) => {
    setLoading(true);
    setError(null);
    fetch(`/api/tasks/departments?include_inactive=${incInactive ? '1' : '0'}`)
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError(j.error); setRows([]); return; }
        setRows(j.departments || []);
      })
      .catch(e => { setError(e?.message || 'Failed to load departments'); setRows([]); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!me) return;
    load(showInactive);
  }, [me, showInactive, load]);

  const openDept = (d: Dept) => {
    if (openId === d.id) { setOpenId(null); setDeptTasks([]); return; }
    setOpenId(d.id);
    setDeptTasks([]);
    setTasksLoading(true);
    fetch(`/api/tasks?department=${encodeURIComponent(d.name)}&status=draft,assigned,accepted,in_progress,waiting_verification,reopened,on_hold&pageSize=25`)
      .then(r => r.json())
      .then(j => setDeptTasks(j.rows || []))
      .catch(() => setDeptTasks([]))
      .finally(() => setTasksLoading(false));
  };

  const addDept = async () => {
    if (saving) return;
    setSaving(true);
    setModalError(null);
    try {
      const r = await api('/api/tasks/departments', { method: 'POST', body: addForm });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setModalError(j.error || `HTTP ${r.status}`); return; }
      setShowAdd(false);
      setAddForm({ name: '', code: '' });
      setNotice('Department added');
      load(showInactive);
    } catch (e: any) {
      setModalError(e?.message || 'Failed to save department');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (d: Dept) => {
    setEditId(d.id);
    setEditForm({ name: d.name, code: d.code });
  };

  const saveEdit = async (d: Dept) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api('/api/tasks/departments', { method: 'PUT', body: { id: d.id, ...editForm } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setEditId(null);
      setNotice('Department updated');
      load(showInactive);
    } catch (e: any) {
      setError(e?.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (d: Dept) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      if (d.is_active) {
        const r = await api(`/api/tasks/departments?id=${encodeURIComponent(d.id)}`, { method: 'DELETE' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
        setNotice('Department deactivated');
      } else {
        const r = await api('/api/tasks/departments', { method: 'PUT', body: { id: d.id, is_active: 1 } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
        setNotice('Department reactivated');
      }
      load(showInactive);
    } catch (e: any) {
      setError(e?.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const filtered = rows.filter(d =>
    !q || `${d.name} ${d.code}`.toLowerCase().includes(q.toLowerCase()));

  const exportCsv = () => {
    const header = ['Department', 'Code', 'Active', 'Open', 'Overdue', 'Completed', 'Total', 'Completion %'];
    const lines = [header.join(',')];
    filtered.forEach(d => {
      lines.push([
        d.name, d.code, d.is_active ? 'Yes' : 'No',
        d.stats.open, d.stats.overdue, d.stats.completed, d.stats.total,
        pct(d.stats.completed, d.stats.total),
      ].map(csvCell).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `task-departments-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /* ── gates ── */
  if (me === undefined) {
    return (
      <div className="p-8 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    );
  }
  if (!me) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] mb-3">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Please sign in to view task departments.
        </div>
      </div>
    );
  }

  const totals = filtered.reduce(
    (a, d) => ({
      open: a.open + d.stats.open,
      overdue: a.overdue + d.stats.overdue,
      completed: a.completed + d.stats.completed,
      total: a.total + d.stats.total,
    }),
    { open: 0, overdue: 0, completed: 0, total: 0 },
  );

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto pb-16">
      {/* Header */}
      <div>
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] mb-2">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Building2 size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Task Departments</h1>
            <p className="text-xs text-[#8B7355]">Per-department task load with live open / overdue / completed stats</p>
          </div>
          <button
            onClick={() => load(showInactive)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={exportCsv}
            disabled={!filtered.length}
            className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <Download size={14} /> CSV
          </button>
          {canManage && (
            <button
              onClick={() => { setShowAdd(true); setModalError(null); }}
              className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-2"
            >
              <Plus size={14} /> Add Department
            </button>
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

      {/* Totals strip */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: 'Open', val: totals.open, cls: 'text-blue-700' },
            { label: 'Overdue', val: totals.overdue, cls: 'text-red-700' },
            { label: 'Completed', val: totals.completed, cls: 'text-green-700' },
            { label: 'Total', val: totals.total, cls: 'text-[#2D1B0E]' },
          ].map(k => (
            <div key={k.label} className="bg-white border border-[#E8D5C4] rounded-xl p-3">
              <div className="text-xs text-[#8B7355]">{k.label}</div>
              <div className={`text-2xl font-bold ${k.cls}`}>{k.val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Search + filter */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input
            type="text" value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search departments…"
            className="w-full border border-[#E8D5C4] rounded-lg pl-9 pr-3 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]"
          />
        </div>
        <label className="inline-flex items-center gap-1.5 text-sm text-[#6B5744] bg-white border border-[#E8D5C4] rounded-lg px-3 py-2">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      {/* Loading / empty */}
      {loading && rows.length === 0 && (
        <div className="p-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading departments…
        </div>
      )}
      {!loading && filtered.length === 0 && !error && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
          {q ? <>No departments match “{q}”.</> : <>No departments yet.</>}
        </div>
      )}

      {/* Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {filtered.map(d => {
          const p = pct(d.stats.completed, d.stats.total);
          return (
            <div key={d.id} className={`bg-white border rounded-xl ${openId === d.id ? 'border-[#af4408]' : 'border-[#E8D5C4]'} ${!d.is_active ? 'opacity-60' : ''}`}>
              {editId === d.id ? (
                <div className="p-4 space-y-2">
                  <input
                    type="text" value={editForm.name}
                    onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Department name"
                    className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]"
                  />
                  <input
                    type="text" value={editForm.code}
                    onChange={e => setEditForm(f => ({ ...f, code: e.target.value }))}
                    placeholder="Code (e.g. OPS)"
                    className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => saveEdit(d)} disabled={saving || !editForm.name.trim()} className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-1.5 disabled:opacity-50">
                      {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Save
                    </button>
                    <button onClick={() => setEditId(null)} className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] text-[#6B5744] text-sm rounded-lg px-3 py-1.5">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <button onClick={() => openDept(d)} className="flex items-center gap-2 min-w-0 text-left">
                        <div className="min-w-0">
                          <div className="font-semibold text-[#2D1B0E] truncate flex items-center gap-2">
                            {d.name}
                            {d.code && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#FFF1E3] border border-[#E8D5C4] text-[#8a3606]">{d.code}</span>}
                            {!d.is_active && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">inactive</span>}
                          </div>
                          <div className="text-xs text-[#8B7355] mt-0.5">{d.stats.total} task{d.stats.total === 1 ? '' : 's'} · {p}% complete</div>
                        </div>
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        {canManage && (
                          <>
                            <button onClick={() => startEdit(d)} title="Edit" className="p-1.5 rounded-lg text-[#8B7355] hover:text-[#af4408] hover:bg-[#FFF1E3]"><Pencil size={14} /></button>
                            <button onClick={() => toggleActive(d)} title={d.is_active ? 'Deactivate' : 'Reactivate'} className="p-1.5 rounded-lg text-[#8B7355] hover:text-red-600 hover:bg-red-50">
                              {d.is_active ? <Trash2 size={14} /> : <CheckCircle2 size={14} />}
                            </button>
                          </>
                        )}
                        <button onClick={() => openDept(d)} className="p-1.5 rounded-lg text-[#8B7355] hover:text-[#af4408]">
                          {openId === d.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                      </div>
                    </div>

                    {/* Stat pills */}
                    <div className="grid grid-cols-3 gap-2 mt-3">
                      <div className="rounded-lg bg-blue-50 border border-blue-100 px-2 py-1.5 text-center">
                        <div className="text-lg font-bold text-blue-700 leading-none">{d.stats.open}</div>
                        <div className="text-[10px] text-blue-700/80 mt-0.5">Open</div>
                      </div>
                      <div className="rounded-lg bg-red-50 border border-red-100 px-2 py-1.5 text-center">
                        <div className="text-lg font-bold text-red-700 leading-none">{d.stats.overdue}</div>
                        <div className="text-[10px] text-red-700/80 mt-0.5">Overdue</div>
                      </div>
                      <div className="rounded-lg bg-green-50 border border-green-100 px-2 py-1.5 text-center">
                        <div className="text-lg font-bold text-green-700 leading-none">{d.stats.completed}</div>
                        <div className="text-[10px] text-green-700/80 mt-0.5">Done</div>
                      </div>
                    </div>

                    {/* Completion bar */}
                    <div className="mt-3 h-1.5 rounded-full bg-[#F0E4D6] overflow-hidden">
                      <div className="h-full bg-[#af4408]" style={{ width: `${p}%` }} />
                    </div>
                  </div>

                  {/* Drill-in */}
                  {openId === d.id && (
                    <div className="border-t border-[#E8D5C4] bg-[#FFFDF9] p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold text-[#2D1B0E] uppercase tracking-wide">Open tasks</div>
                        <button
                          onClick={() => router.push(`/tasks/board?department=${encodeURIComponent(d.name)}`)}
                          className="inline-flex items-center gap-1 text-xs text-[#af4408] hover:text-[#8a3606]"
                        >
                          <KanbanSquare size={13} /> View on board
                        </button>
                      </div>
                      {tasksLoading ? (
                        <div className="text-xs text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Loading…</div>
                      ) : deptTasks.length === 0 ? (
                        <div className="text-xs text-[#8B7355]">No open tasks in this department.</div>
                      ) : (
                        <div className="divide-y divide-[#F0E4D6] border border-[#E8D5C4] rounded-lg bg-white overflow-hidden">
                          {deptTasks.map(t => {
                            const sm = statusMeta(t.status);
                            const pm = priorityMeta(t.priority);
                            return (
                              <div key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                                <span className="font-medium text-[#2D1B0E] flex-1 min-w-[120px] truncate">{t.title}</span>
                                <span className={`px-1.5 py-0.5 rounded border ${pm.color}`}>{pm.label}</span>
                                <span className={`px-1.5 py-0.5 rounded border ${sm.color}`}>{sm.label}</span>
                                {t.due_date && <span className="text-[#8B7355]">due {fmtDate(t.due_date)}</span>}
                                {t.assignee_name && <span className="text-[#6B5744]">{t.assignee_name}</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Add modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-4 sm:p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2">
                <Building2 size={18} className="text-[#af4408]" /> Add Department
              </h2>
              <button onClick={() => setShowAdd(false)} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={18} /></button>
            </div>
            {modalError && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-2.5 py-1.5">
                <AlertCircle size={13} className="shrink-0" /> {modalError}
              </div>
            )}
            <input
              type="text" placeholder="Department name *" value={addForm.name}
              onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
              className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]"
            />
            <input
              type="text" placeholder="Code (optional, e.g. OPS)" value={addForm.code}
              onChange={e => setAddForm(f => ({ ...f, code: e.target.value }))}
              className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]"
            />
            <button
              onClick={addDept}
              disabled={saving || !addForm.name.trim()}
              className="w-full inline-flex items-center justify-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm font-semibold rounded-lg px-3 py-2.5 disabled:opacity-50"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Save Department
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
