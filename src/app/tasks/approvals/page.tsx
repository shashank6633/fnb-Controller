'use client';

/**
 * Task Approvals (/tasks/approvals) — the verification queue.
 *
 * Lists every task sitting in `waiting_verification` and lets an approver
 * Approve (→ approved) or Reopen (→ reopened, bounced back to the assignee) with
 * an optional note. Search + department / priority filters, CSV export.
 *
 * Client gate: admin, manager tier, head chef, or store manager — the API
 * enforces the same set (canApproveTasks). Mobile-first cards, warm theme.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, CheckCheck, CheckCircle2, Clock, Download, Loader2,
  RotateCcw, Search, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import {
  TASK_DEPARTMENTS, TASK_PRIORITIES, priorityMeta, type Task,
} from '@/lib/tasks';

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function TaskApprovalsPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined); // undefined = loading, null = signed out

  const [rows, setRows] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [priority, setPriority] = useState('');

  // Per-task inline note + busy state.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const allowed = !!me && (me.role === 'admin' || me.role === 'manager' || me.is_head_chef || me.is_store_manager);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (dept) params.set('department', dept);
    if (priority) params.set('priority', priority);
    fetch(`/api/tasks/approvals?${params.toString()}`)
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError(j.error); setRows([]); return; }
        setRows(j.rows || []);
      })
      .catch(e => { setError(e?.message || 'Failed to load approval queue'); setRows([]); })
      .finally(() => setLoading(false));
  }, [q, dept, priority]);

  useEffect(() => {
    if (!allowed) return;
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [allowed, load]);

  const decide = async (task: Task, decision: 'approved' | 'reopened') => {
    if (busyId) return;
    setBusyId(task.id);
    setError(null);
    try {
      const r = await api('/api/tasks/approvals', {
        method: 'POST',
        body: { task_id: task.id, decision, note: notes[task.id] || '' },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setNotice(decision === 'approved' ? `Approved “${task.title}”` : `Reopened “${task.title}”`);
      setNotes(n => { const c = { ...n }; delete c[task.id]; return c; });
      setRows(rs => rs.filter(t => t.id !== task.id));
    } catch (e: any) {
      setError(e?.message || 'Failed to record decision');
    } finally {
      setBusyId(null);
    }
  };

  const csvCell = (x: any) => { const s = String(x ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const exportCsv = () => {
    if (!rows.length) return;
    const lines = [['title', 'category', 'department', 'priority', 'assignee', 'due_date', 'completed_at', 'created_by'].join(',')];
    for (const t of rows) {
      lines.push([t.title, t.category, t.department, t.priority, t.assignee_name || t.assignee_email,
        t.due_date, t.completed_at || '', t.created_by].map(csvCell).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `task-approvals-${todayISO()}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

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
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Approvals are for admins, managers, head chefs and store managers only.
          Ask an admin if you need approval rights.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto pb-16">
      {/* Header */}
      <div>
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-2"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <CheckCheck size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Task Approvals</h1>
            <p className="text-xs text-[#8B7355]">
              Verify completed work — approve to close, or reopen to send it back
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <Loader2 size={14} className={loading ? 'animate-spin' : 'hidden'} />
            <Search size={14} className={loading ? 'hidden' : ''} /> Refresh
          </button>
          <button
            onClick={exportCsv}
            disabled={!rows.length}
            className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <Download size={14} /> Export
          </button>
        </div>
      </div>

      {/* Notice / error */}
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

      {/* Search + filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input
            type="text" value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search title or description…"
            className="w-full border border-[#E8D5C4] rounded-lg pl-9 pr-3 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]"
          />
        </div>
        <select
          value={dept} onChange={e => setDept(e.target.value)}
          className="border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]"
        >
          <option value="">All departments</option>
          {TASK_DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select
          value={priority} onChange={e => setPriority(e.target.value)}
          className="border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]"
        >
          <option value="">All priorities</option>
          {TASK_PRIORITIES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>

      {/* Loading / empty */}
      {loading && rows.length === 0 && (
        <div className="p-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading queue…
        </div>
      )}
      {!loading && rows.length === 0 && !error && (
        <div className="bg-white border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#8B7355]">
          Nothing awaiting verification. Completed tasks that need sign-off will appear here.
        </div>
      )}

      {/* Queue */}
      {rows.length > 0 && (
        <div className="space-y-3">
          {rows.map(t => {
            const pm = priorityMeta(t.priority);
            const overdue = !!t.due_date && t.due_date < todayISO();
            const busy = busyId === t.id;
            return (
              <div key={t.id} className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-sm text-[#2D1B0E]">{t.title}</div>
                    {t.description && (
                      <div className="text-xs text-[#6B5744] mt-0.5 line-clamp-2">{t.description}</div>
                    )}
                  </div>
                  <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border ${pm.color}`}>
                    {pm.label}
                  </span>
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#6B5744]">
                  {t.category && <span>{t.category}</span>}
                  {t.department && <span>· {t.department}</span>}
                  <span>· Assignee: <span className="text-[#2D1B0E]">{t.assignee_name || t.assignee_email || '—'}</span></span>
                  <span className={`inline-flex items-center gap-1 ${overdue ? 'text-red-600 font-semibold' : ''}`}>
                    <Clock size={11} /> Due {fmtDate(t.due_date)}{t.due_time ? ` ${t.due_time}` : ''}
                  </span>
                  {t.completed_at && <span>· Completed {fmtDate(t.completed_at)}</span>}
                </div>

                <textarea
                  placeholder="Verification note (optional) — use @name to mention someone"
                  value={notes[t.id] || ''}
                  onChange={e => setNotes(n => ({ ...n, [t.id]: e.target.value }))}
                  rows={2}
                  className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]"
                />

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => decide(t, 'approved')}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-1.5 disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Approve
                  </button>
                  <button
                    onClick={() => decide(t, 'reopened')}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 bg-white border border-orange-300 text-orange-700 hover:border-orange-500 text-sm rounded-lg px-3 py-1.5 disabled:opacity-50"
                  >
                    <RotateCcw size={14} /> Reopen
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
