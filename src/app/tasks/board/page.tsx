'use client';

/**
 * Task Board (/tasks/board) — CORE TASKS slice.
 *
 * Kanban across the task workflow statuses (every TASK_STATUSES key except the
 * off-ramp `cancelled`, which is reachable from a card menu but has no column).
 * Native HTML5 drag-and-drop moves a card between columns → PATCH /api/tasks/:id
 * status. Filters: department / assignee / priority / due, plus a title search.
 * Create-Task modal (shared TaskModal). Cards are colour-coded by priority and
 * carry a status badge, department, assignee and due date.
 *
 * Read is open to any signed-in user; creating and moving cards needs manage or
 * assignee rights (the API enforces it — the board surfaces the 403).
 * Mobile-first: columns scroll horizontally; each is a min-width lane.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, CalendarClock, KanbanSquare, Loader2, Plus,
  RefreshCw, Search, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import {
  TASK_STATUSES, TASK_PRIORITIES, TASK_DEPARTMENTS,
  priorityMeta, statusMeta, canManageTasks,
} from '@/lib/tasks';
import TaskModal from '../_components/TaskModal';

// Board columns: all statuses except the terminal `cancelled` (no column).
const BOARD_STATUSES = TASK_STATUSES.filter((s) => s.key !== 'cancelled');

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function TaskBoardPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined); // undefined = loading, null = signed out

  const [groups, setGroups] = useState<Record<string, any[]>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [fDept, setFDept] = useState('');
  const [fPriority, setFPriority] = useState('');
  const [fAssignee, setFAssignee] = useState('');
  const [fDue, setFDue] = useState('');

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editTask, setEditTask] = useState<any | null>(null);
  const [modalStatus, setModalStatus] = useState<string>('draft');

  const canManage = canManageTasks(me);

  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((d) => setMe(d?.user ?? null)).catch(() => setMe(null));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (fDept) p.set('department', fDept);
    if (fPriority) p.set('priority', fPriority);
    if (fAssignee) p.set('assignee', fAssignee);
    if (fDue) p.set('due', fDue);
    fetch(`/api/tasks/board?${p.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) { setError(j.error); return; }
        setGroups(j.groups || {});
        setCounts(j.counts || {});
      })
      .catch((e) => setError(e?.message || 'Failed to load board'))
      .finally(() => setLoading(false));
  }, [q, fDept, fPriority, fAssignee, fDue]);

  useEffect(() => {
    if (!me) return;
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [me, load]);

  const moveCard = async (taskId: string, toStatus: string) => {
    const task = Object.values(groups).flat().find((t: any) => t.id === taskId);
    if (!task || task.status === toStatus) return;
    // Optimistic move.
    const prevGroups = groups;
    setGroups((g) => {
      const next: Record<string, any[]> = {};
      for (const k of Object.keys(g)) next[k] = g[k].filter((t: any) => t.id !== taskId);
      const moved = { ...task, status: toStatus };
      next[toStatus] = [moved, ...(next[toStatus] || [])];
      return next;
    });
    try {
      const res = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { status: toStatus } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error || `HTTP ${res.status}`); setGroups(prevGroups); return; }
      setNotice(`Moved to ${statusMeta(toStatus).label}`);
      load();
    } catch (e: any) {
      setError(e?.message || 'Failed to move task');
      setGroups(prevGroups);
    }
  };

  const openCreate = (status: string) => { setEditTask(null); setModalStatus(status); setModalOpen(true); };
  const openEdit = async (taskId: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error || `HTTP ${res.status}`); return; }
      setEditTask({ ...j.task, assignees: j.assignees });
      setModalStatus(j.task?.status || 'draft');
      setModalOpen(true);
    } catch (e: any) { setError(e?.message || 'Failed to open task'); }
  };

  const filtersActive = q || fDept || fPriority || fAssignee || fDue;

  /* ── gates ── */
  if (me === undefined) {
    return (
      <div className="p-8 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    );
  }
  if (me === null) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] mb-3">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Please sign in to view the task board.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-[1600px] mx-auto pb-16">
      {/* Header */}
      <div>
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] mb-2">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <KanbanSquare size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Task Board</h1>
            <p className="text-xs text-[#8B7355]">Drag cards across the workflow — draft to approved</p>
          </div>
          <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          {canManage && (
            <button onClick={() => openCreate('draft')} className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-2">
              <Plus size={14} /> New Task
            </button>
          )}
        </div>
      </div>

      {/* Banners */}
      {notice && (
        <div className="flex items-center justify-between gap-2 bg-green-50 border border-green-200 text-green-800 text-sm rounded-lg px-3 py-2">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-green-700 hover:text-green-900"><X size={14} /></button>
        </div>
      )}
      {error && (
        <div className="flex items-center justify-between gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          <span className="flex items-center gap-2"><AlertCircle size={15} className="shrink-0" /> {error}</span>
          <button onClick={() => setError(null)} className="text-red-700 hover:text-red-900"><X size={14} /></button>
        </div>
      )}

      {/* Search + filters */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input
            type="text" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search tasks…"
            className="w-full border border-[#E8D5C4] rounded-lg pl-9 pr-3 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]"
          />
        </div>
        <select value={fDept} onChange={(e) => setFDept(e.target.value)} className="border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
          <option value="">All depts</option>
          {TASK_DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={fPriority} onChange={(e) => setFPriority(e.target.value)} className="border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
          <option value="">All priorities</option>
          {TASK_PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <select value={fDue} onChange={(e) => setFDue(e.target.value)} className="border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
          <option value="">Any due</option>
          <option value="overdue">Overdue</option>
          <option value="today">Due today</option>
          <option value="upcoming">Upcoming</option>
        </select>
        <input
          type="text" value={fAssignee} onChange={(e) => setFAssignee(e.target.value)}
          placeholder="Assignee email"
          className="border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408] w-40"
        />
        {filtersActive && (
          <button onClick={() => { setQ(''); setFDept(''); setFPriority(''); setFAssignee(''); setFDue(''); }} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#af4408] px-2">
            <X size={13} /> Clear
          </button>
        )}
      </div>

      {/* Board */}
      {loading && Object.keys(groups).length === 0 ? (
        <div className="p-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading board…
        </div>
      ) : (
        <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
          <div className="flex gap-3 min-w-max pb-2">
            {BOARD_STATUSES.map((col) => {
              const cards = groups[col.key] || [];
              const isOver = dragOver === col.key;
              return (
                <div
                  key={col.key}
                  className={`w-[260px] shrink-0 rounded-xl border ${isOver ? 'border-[#af4408] bg-[#FFF1E3]' : 'border-[#E8D5C4] bg-[#FFF8F0]'} flex flex-col`}
                  onDragOver={(e) => { if (dragId) { e.preventDefault(); setDragOver(col.key); } }}
                  onDragLeave={() => setDragOver((c) => (c === col.key ? null : c))}
                  onDrop={(e) => { e.preventDefault(); setDragOver(null); if (dragId) { moveCard(dragId, col.key); setDragId(null); } }}
                >
                  <div className="flex items-center justify-between px-3 py-2 border-b border-[#E8D5C4]">
                    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full border ${col.color}`}>
                      {col.label}
                    </span>
                    <span className="text-xs text-[#8B7355]">{counts[col.key] ?? cards.length}</span>
                  </div>
                  <div className="flex-1 p-2 space-y-2 min-h-[80px]">
                    {cards.length === 0 && (
                      <div className="text-[11px] text-[#B7A48F] text-center py-4">Drop here</div>
                    )}
                    {cards.map((t: any) => {
                      const pm = priorityMeta(t.priority);
                      const overdue = t.due_date && t.due_date < todayISO() && !['completed', 'approved', 'cancelled'].includes(t.status);
                      return (
                        <div
                          key={t.id}
                          draggable
                          onDragStart={() => setDragId(t.id)}
                          onDragEnd={() => { setDragId(null); setDragOver(null); }}
                          onClick={() => openEdit(t.id)}
                          className={`bg-white border rounded-lg p-2.5 cursor-pointer hover:border-[#af4408] transition-colors ${dragId === t.id ? 'opacity-50' : 'border-[#E8D5C4]'}`}
                        >
                          <div className="flex items-start justify-between gap-1.5">
                            <span className="text-sm font-medium text-[#2D1B0E] leading-snug">{t.title}</span>
                            <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${pm.color}`}>{pm.label}</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[11px] text-[#6B5744]">
                            {t.department && <span className="bg-[#FFF1E3] border border-[#E8D5C4] rounded px-1.5 py-0.5">{t.department}</span>}
                            {t.category && <span className="text-[#8B7355]">{t.category}</span>}
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-1 mt-1.5 text-[11px]">
                            <span className="text-[#8B7355] truncate max-w-[130px]">{t.assignee_name || t.assignee_email || 'Unassigned'}</span>
                            {t.due_date && (
                              <span className={`inline-flex items-center gap-1 ${overdue ? 'text-red-600 font-semibold' : 'text-[#8B7355]'}`}>
                                <CalendarClock size={11} /> {fmtDate(t.due_date)}{t.due_time ? ` ${t.due_time}` : ''}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {canManage && (
                    <button onClick={() => openCreate(col.key)} className="m-2 mt-0 inline-flex items-center justify-center gap-1 text-xs text-[#8B7355] hover:text-[#af4408] border border-dashed border-[#E8D5C4] hover:border-[#af4408] rounded-lg py-1.5">
                      <Plus size={12} /> Add
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <TaskModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={() => { setNotice(editTask ? 'Task updated' : 'Task created'); load(); }}
        task={editTask}
        defaultStatus={modalStatus}
        defaultDepartment={fDept || undefined}
      />
    </div>
  );
}
