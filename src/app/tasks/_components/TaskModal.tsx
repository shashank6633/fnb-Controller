'use client';

/**
 * TaskModal — shared create / edit task form (CORE TASKS slice).
 *
 * A self-contained modal used by the Task Board (and reusable elsewhere) to
 * create a new task or edit an existing one. Covers the full task surface:
 * title, description, category, department, priority, status (edit only), due
 * date + time, estimated minutes, multiple assignees (chip input with a
 * datalist autocomplete pulled from /api/auth/users when the caller is an
 * admin — otherwise free-text email entry), an inline checklist, and an
 * optional parent task id (subtask).
 *
 * POSTs /api/tasks on create, PUTs /api/tasks/:id on edit. Calls onSaved(task)
 * on success. Warm theme, mobile-first (bottom-sheet under sm, centered card
 * sm+). Exported for reuse by other Task-Management pages.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ClipboardList, Loader2, Plus, Save, X } from 'lucide-react';
import { api } from '@/lib/api';
import {
  TASK_CATEGORIES, TASK_DEPARTMENTS, TASK_PRIORITIES, TASK_STATUSES,
} from '@/lib/tasks';

interface Assignee { email: string; name: string }
interface ChecklistItem { label: string; done: boolean }

export interface TaskModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: (task: any) => void;
  /** When set, the modal edits this task; otherwise it creates a new one. */
  task?: any | null;
  /** Optional preset default department (e.g. board is filtered to a dept). */
  defaultDepartment?: string;
  /** Optional preset default status column (create-in-column on the board). */
  defaultStatus?: string;
}

const emptyForm = () => ({
  title: '',
  description: '',
  category: 'Operations',
  department: '',
  priority: 'medium',
  status: 'draft',
  due_date: '',
  due_time: '',
  estimated_minutes: '',
  parent_task_id: '',
});

export default function TaskModal({
  open, onClose, onSaved, task, defaultDepartment, defaultStatus,
}: TaskModalProps) {
  const editing = !!task?.id;
  const [form, setForm] = useState(emptyForm());
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [assigneeInput, setAssigneeInput] = useState('');
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [checklistInput, setChecklistInput] = useState('');
  const [userOptions, setUserOptions] = useState<{ email: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate the form whenever the modal opens (or the target task changes).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setAssigneeInput('');
    setChecklistInput('');
    if (task?.id) {
      setForm({
        title: task.title || '',
        description: task.description || '',
        category: task.category || 'Operations',
        department: task.department || '',
        priority: task.priority || 'medium',
        status: task.status || 'draft',
        due_date: task.due_date || '',
        due_time: task.due_time || '',
        estimated_minutes: task.estimated_minutes ? String(task.estimated_minutes) : '',
        parent_task_id: task.parent_task_id || '',
      });
      // Prefer an explicit assignees array (from the detail endpoint); else the
      // single primary mirror.
      if (Array.isArray(task.assignees) && task.assignees.length) {
        setAssignees(task.assignees.map((a: any) => ({ email: a.user_email || a.email || '', name: a.user_name || a.name || '' })).filter((a: Assignee) => a.email));
      } else if (task.assignee_email) {
        setAssignees([{ email: task.assignee_email, name: task.assignee_name || '' }]);
      } else {
        setAssignees([]);
      }
      try {
        const parsed = JSON.parse(task.checklist_json || '[]');
        setChecklist(Array.isArray(parsed) ? parsed.map((c: any) => ({ label: String(c.label ?? c ?? ''), done: !!c.done })).filter((c: ChecklistItem) => c.label) : []);
      } catch { setChecklist([]); }
    } else {
      setForm({ ...emptyForm(), department: defaultDepartment || '', status: defaultStatus || 'draft' });
      setAssignees([]);
      setChecklist([]);
    }
  }, [open, task, defaultDepartment, defaultStatus]);

  // Best-effort user list for the assignee autocomplete (admin-only endpoint —
  // silently ignored for non-admins, who type emails directly).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/auth/users')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.users) return;
        setUserOptions(j.users.filter((u: any) => u.is_active !== 0).map((u: any) => ({ email: u.email, name: u.name || '' })));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  const userByEmail = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of userOptions) m.set(u.email.toLowerCase(), u.name);
    return m;
  }, [userOptions]);

  if (!open) return null;

  const addAssignee = () => {
    const email = assigneeInput.trim();
    if (!email) return;
    if (assignees.some((a) => a.email.toLowerCase() === email.toLowerCase())) { setAssigneeInput(''); return; }
    setAssignees((prev) => [...prev, { email, name: userByEmail.get(email.toLowerCase()) || '' }]);
    setAssigneeInput('');
  };
  const removeAssignee = (email: string) =>
    setAssignees((prev) => prev.filter((a) => a.email.toLowerCase() !== email.toLowerCase()));

  const addChecklistItem = () => {
    const label = checklistInput.trim();
    if (!label) return;
    setChecklist((prev) => [...prev, { label, done: false }]);
    setChecklistInput('');
  };
  const removeChecklistItem = (i: number) =>
    setChecklist((prev) => prev.filter((_, idx) => idx !== i));

  const save = async () => {
    if (saving) return;
    const title = form.title.trim();
    if (!title) { setError('Title is required'); return; }
    setSaving(true);
    setError(null);
    // Fold any half-typed assignee/checklist entry in on save.
    const finalAssignees = [...assignees];
    if (assigneeInput.trim() && !finalAssignees.some((a) => a.email.toLowerCase() === assigneeInput.trim().toLowerCase())) {
      finalAssignees.push({ email: assigneeInput.trim(), name: userByEmail.get(assigneeInput.trim().toLowerCase()) || '' });
    }
    const finalChecklist = [...checklist];
    if (checklistInput.trim()) finalChecklist.push({ label: checklistInput.trim(), done: false });

    const payload: any = {
      title,
      description: form.description.trim(),
      category: form.category,
      department: form.department,
      priority: form.priority,
      due_date: form.due_date,
      due_time: form.due_time,
      estimated_minutes: form.estimated_minutes ? Number(form.estimated_minutes) : 0,
      parent_task_id: form.parent_task_id.trim(),
      assignees: finalAssignees,
      checklist: finalChecklist,
    };
    if (editing) payload.status = form.status;
    else if (form.status && form.status !== 'draft') payload.status = form.status;

    try {
      const res = editing
        ? await api(`/api/tasks/${task.id}`, { method: 'PUT', body: payload })
        : await api('/api/tasks', { method: 'POST', body: payload });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error || `HTTP ${res.status}`); return; }
      // POST → { task }; PUT → { task, assignees, … }. Both carry `task`.
      onSaved(j.task ?? j);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Failed to save task');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm bg-white text-[#2D1B0E] focus:outline-none focus:border-[#af4408]';
  const labelCls = 'text-xs font-semibold text-[#2D1B0E] uppercase tracking-wide';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl p-4 sm:p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between sticky -top-4 sm:-top-5 bg-white pb-1 pt-1 z-10">
          <h2 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2">
            <ClipboardList size={18} className="text-[#af4408]" />
            {editing ? 'Edit Task' : 'Create Task'}
          </h2>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={18} /></button>
        </div>

        {error && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-2.5 py-1.5">
            <AlertCircle size={13} className="shrink-0" /> {error}
          </div>
        )}

        {/* Title */}
        <div className="space-y-1">
          <label className={labelCls}>Title *</label>
          <input
            type="text" value={form.title} autoFocus
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="What needs doing?" className={inputCls}
          />
        </div>

        {/* Description */}
        <div className="space-y-1">
          <label className={labelCls}>Description</label>
          <textarea
            rows={2} value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Details, SOP notes, @mention teammates in comments…" className={inputCls}
          />
        </div>

        {/* Category / Department */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className={labelCls}>Category</label>
            <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} className={inputCls}>
              {TASK_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className={labelCls}>Department</label>
            <select value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} className={inputCls}>
              <option value="">— None —</option>
              {TASK_DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        </div>

        {/* Priority / Status */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className={labelCls}>Priority</label>
            <select value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))} className={inputCls}>
              {TASK_PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className={labelCls}>Status</label>
            <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} className={inputCls}>
              {TASK_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
        </div>

        {/* Due date / time / estimate */}
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <label className={labelCls}>Due date</label>
            <input type="date" value={form.due_date} onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} className={inputCls} />
          </div>
          <div className="space-y-1">
            <label className={labelCls}>Due time</label>
            <input type="time" value={form.due_time} onChange={(e) => setForm((f) => ({ ...f, due_time: e.target.value }))} className={inputCls} />
          </div>
          <div className="space-y-1">
            <label className={labelCls}>Est. min</label>
            <input type="number" min="0" inputMode="numeric" value={form.estimated_minutes} onChange={(e) => setForm((f) => ({ ...f, estimated_minutes: e.target.value }))} placeholder="0" className={inputCls} />
          </div>
        </div>

        {/* Assignees */}
        <div className="space-y-1">
          <label className={labelCls}>Assignees</label>
          <div className="flex gap-2">
            <input
              type="text" list="task-user-options" value={assigneeInput}
              onChange={(e) => setAssigneeInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAssignee(); } }}
              placeholder="email@company.com" className={inputCls}
            />
            <datalist id="task-user-options">
              {userOptions.map((u) => <option key={u.email} value={u.email}>{u.name}</option>)}
            </datalist>
            <button onClick={addAssignee} type="button" className="shrink-0 inline-flex items-center gap-1 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2">
              <Plus size={14} /> Add
            </button>
          </div>
          {assignees.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {assignees.map((a) => (
                <span key={a.email} className="inline-flex items-center gap-1 bg-[#FFF1E3] border border-[#E8D5C4] rounded-full px-2.5 py-1 text-xs text-[#2D1B0E]">
                  {a.name || a.email}
                  <button onClick={() => removeAssignee(a.email)} type="button" className="text-[#8B7355] hover:text-[#af4408]"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Checklist */}
        <div className="space-y-1">
          <label className={labelCls}>Checklist</label>
          <div className="flex gap-2">
            <input
              type="text" value={checklistInput}
              onChange={(e) => setChecklistInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addChecklistItem(); } }}
              placeholder="Add a sub-step…" className={inputCls}
            />
            <button onClick={addChecklistItem} type="button" className="shrink-0 inline-flex items-center gap-1 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2">
              <Plus size={14} /> Add
            </button>
          </div>
          {checklist.length > 0 && (
            <ul className="space-y-1 pt-1">
              {checklist.map((c, i) => (
                <li key={i} className="flex items-center justify-between gap-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm text-[#2D1B0E]">
                  <span className={c.done ? 'line-through text-[#8B7355]' : ''}>{c.label}</span>
                  <button onClick={() => removeChecklistItem(i)} type="button" className="text-[#8B7355] hover:text-[#af4408]"><X size={13} /></button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Parent task (subtask) */}
        <div className="space-y-1">
          <label className={labelCls}>Parent task id (optional — makes this a subtask)</label>
          <input type="text" value={form.parent_task_id} onChange={(e) => setForm((f) => ({ ...f, parent_task_id: e.target.value }))} placeholder="Paste a task id to nest under it" className={inputCls} />
        </div>

        <button
          onClick={save} disabled={saving || !form.title.trim()}
          className="w-full inline-flex items-center justify-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm font-semibold rounded-lg px-3 py-2.5 disabled:opacity-50"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          {editing ? 'Save changes' : 'Create task'}
        </button>
      </div>
    </div>
  );
}
