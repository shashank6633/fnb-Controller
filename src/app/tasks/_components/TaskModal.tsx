'use client';

/**
 * TaskModal — shared create / edit task form (Task Management, Phase 2).
 *
 * A self-contained modal used by the Task Board (and reusable elsewhere) to
 * create a new task or edit an existing one. Covers the full task surface:
 * title, description (with @mention autocomplete), category, department,
 * priority, status (edit only), due date + time, estimated minutes, a PRIMARY
 * assignee + additional assignees (both via the portaled UserPicker, written to
 * task_assignees), an inline checklist, image attachments (client-downscaled
 * data URIs), an optional parent task id (subtask), and — on create — a
 * "Recurring" section that spins up a recurring_task_rules row.
 *
 * Persistence:
 *   • Task itself  — POST /api/tasks (create) / PUT /api/tasks/:id (edit).
 *   • Assignees    — folded into the task payload as `assignees:[{email,name}]`
 *                    (the API mirrors the first as the primary + fills
 *                    task_assignees).
 *   • Attachments  — new images are stored through the EXISTING attachment path
 *                    (POST /api/tasks/:id/comments with an empty body + an
 *                    `attachments:[{kind:'image',url,filename}]` array) so the
 *                    modal needs no new endpoint and no schema change. Existing
 *                    attachments (when the caller passes task.attachments) are
 *                    shown read-only.
 *   • Recurring    — POST /api/tasks/recurring (built by the settings slice).
 *                    Best-effort: a task is never blocked if the rule fails.
 *
 * Warm theme, mobile-first (bottom-sheet under sm, centered card sm+). Any
 * dropdown/popover is PORTALED to <body> (position:fixed) so it is never clipped
 * by the modal's overflow — see UserPicker.tsx / MentionTextarea below.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle, ClipboardList, Loader2, Plus, Repeat, Save, Send, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import {
  TASK_CATEGORIES, TASK_DEPARTMENTS, TASK_PRIORITIES, TASK_STATUSES,
  nextRecurrence, type RecurrenceFrequency,
} from '@/lib/tasks';
import UserPicker, { useTaskUsers, type TaskUser } from './UserPicker';
import ImageUpload, { ImageThumb } from './ImageUpload';

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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ------------------------------------------------------------------ *
 * MentionTextarea — textarea with @mention autocomplete.
 *
 * Detects an `@token` immediately before the caret, shows a PORTALED (fixed,
 * anchored to the textarea) dropdown of matching users, and on pick replaces the
 * token with `@email `. Portaled so the modal's overflow can never clip it.
 * ------------------------------------------------------------------ */
function MentionTextarea({
  value, onChange, users, placeholder, rows = 2, autoFocus, className,
}: {
  value: string;
  onChange: (v: string) => void;
  users: TaskUser[];
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  className: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const triggerStart = useRef<number>(-1);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? users.filter(
          (u) =>
            u.name.toLowerCase().includes(q) ||
            u.email.toLowerCase().includes(q) ||
            (u.position || '').toLowerCase().includes(q),
        )
      : users;
    return list.slice(0, 8);
  }, [users, query]);

  const detect = (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart ?? 0;
    const upto = el.value.slice(0, caret);
    const m = /(?:^|\s)@([\w.\-]*)$/.exec(upto);
    if (m) {
      triggerStart.current = caret - m[1].length - 1; // index of the '@'
      setQuery(m[1]);
      setOpen(true);
    } else {
      triggerStart.current = -1;
      setOpen(false);
      setQuery('');
    }
  };

  const insert = (u: TaskUser) => {
    const el = taRef.current;
    const start = triggerStart.current;
    if (!el || start < 0) { setOpen(false); return; }
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(caret);
    const token = `@${u.email} `;
    onChange(before + token + after);
    setOpen(false);
    setQuery('');
    triggerStart.current = -1;
    const nextCaret = (before + token).length;
    requestAnimationFrame(() => {
      el.focus();
      try { el.setSelectionRange(nextCaret, nextCaret); } catch { /* noop */ }
    });
  };

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const compute = () => {
      const el = taRef.current;
      if (!el || typeof window === 'undefined') return;
      const r = el.getBoundingClientRect();
      const width = Math.max(r.width, 220);
      const left = Math.min(r.left, window.innerWidth - width - 8);
      setPos({ top: r.bottom + 4, left: Math.max(8, left), width });
    };
    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open]);

  useEffect(() => { setActive(0); }, [query, open]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!taRef.current?.contains(t) && !dropRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); insert(results[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  return (
    <>
      <textarea
        ref={taRef}
        rows={rows}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className={className}
        onChange={(e) => { onChange(e.target.value); detect(e.target); }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) detect(e.currentTarget); }}
        onClick={(e) => detect(e.currentTarget)}
      />
      {open && pos && results.length > 0 && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
          className="z-[120] max-w-[calc(100vw-1rem)]"
        >
          <ul className="max-h-[45vh] overflow-y-auto overscroll-contain bg-white border border-[#D4B896] rounded shadow-lg text-sm">
            <li className="sticky top-0 bg-[#FFF8F0] border-b border-[#E8D5C4] px-2 py-1 text-[10px] text-[#8B7355]">
              Mention someone{query.trim() ? ` — "${query}"` : ''}
            </li>
            {results.map((u, i) => (
              <li
                key={u.id}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); insert(u); }}
                className={`px-2 py-1.5 cursor-pointer text-[#2D1B0E] leading-snug ${i === active ? 'bg-[#FFF1E3]' : 'hover:bg-[#FFF8F0]'}`}
              >
                <div className="font-medium">{u.name || u.email}</div>
                <div className="text-[11px] text-[#8B7355]">
                  {u.email}{u.position ? <span> · {u.position}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}

export default function TaskModal({
  open, onClose, onSaved, task, defaultDepartment, defaultStatus,
}: TaskModalProps) {
  const editing = !!task?.id;
  const { users } = useTaskUsers();

  const [form, setForm] = useState(emptyForm());
  const [primary, setPrimary] = useState<Assignee | null>(null);
  const [extraEmails, setExtraEmails] = useState<string[]>([]);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [checklistInput, setChecklistInput] = useState('');
  const [newImages, setNewImages] = useState<string[]>([]);
  const [existingAttachments, setExistingAttachments] = useState<string[]>([]);

  // Recurring (create-only).
  const [recurringOn, setRecurringOn] = useState(false);
  const [recFreq, setRecFreq] = useState<RecurrenceFrequency>('daily');
  const [recDow, setRecDow] = useState(1);   // Mon
  const [recDom, setRecDom] = useState(1);   // 1st

  // In-modal comment composer (edit-only).
  const [commentText, setCommentText] = useState('');
  const [commentImages, setCommentImages] = useState<string[]>([]);
  const [posting, setPosting] = useState(false);
  const [commentNotice, setCommentNotice] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The task saved OK but a best-effort follow-up (recurring rule / photo) did
  // not — we keep the modal open to show `notice` and swap the footer to Close
  // so the same task can't be submitted twice.
  const [savedWithWarning, setSavedWithWarning] = useState(false);

  // Hydrate the form whenever the modal opens (or the target task changes).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    setSavedWithWarning(false);
    setChecklistInput('');
    setNewImages([]);
    setCommentText('');
    setCommentImages([]);
    setCommentNotice(null);
    setRecurringOn(false);
    setRecFreq('daily');
    setRecDow(1);
    setRecDom(1);

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
      // Assignee list: prefer the explicit array (detail endpoint), else the
      // single primary mirror.
      let list: Assignee[] = [];
      if (Array.isArray(task.assignees) && task.assignees.length) {
        list = task.assignees
          .map((a: any) => ({ email: a.user_email || a.email || '', name: a.user_name || a.name || '' }))
          .filter((a: Assignee) => a.email);
      } else if (task.assignee_email) {
        list = [{ email: task.assignee_email, name: task.assignee_name || '' }];
      }
      setPrimary(list[0] || null);
      setExtraEmails(list.slice(1).map((a) => a.email));
      try {
        const parsed = JSON.parse(task.checklist_json || '[]');
        setChecklist(Array.isArray(parsed) ? parsed.map((c: any) => ({ label: String(c.label ?? c ?? ''), done: !!c.done })).filter((c: ChecklistItem) => c.label) : []);
      } catch { setChecklist([]); }
      // Existing image attachments (only present when the caller passes them).
      const atts = Array.isArray(task.attachments) ? task.attachments : [];
      setExistingAttachments(
        atts
          .filter((a: any) => (a?.kind === 'image' || String(a?.url || '').startsWith('data:image')))
          .map((a: any) => String(a.url || ''))
          .filter(Boolean),
      );
    } else {
      setForm({ ...emptyForm(), department: defaultDepartment || '', status: defaultStatus || 'draft' });
      setPrimary(null);
      setExtraEmails([]);
      setChecklist([]);
      setExistingAttachments([]);
    }
  }, [open, task, defaultDepartment, defaultStatus]);

  if (!open) return null;

  const addChecklistItem = () => {
    const label = checklistInput.trim();
    if (!label) return;
    setChecklist((prev) => [...prev, { label, done: false }]);
    setChecklistInput('');
  };
  const removeChecklistItem = (i: number) =>
    setChecklist((prev) => prev.filter((_, idx) => idx !== i));

  /** Merge the primary + additional pickers into a de-duped {email,name} list,
   *  primary first (so the API mirrors it as the task's assignee_email). */
  const buildAssignees = (): Assignee[] => {
    const out: Assignee[] = [];
    const seen = new Set<string>();
    const push = (email: string, name: string) => {
      const e = (email || '').trim();
      if (!e) return;
      const k = e.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ email: e, name: name || '' });
    };
    if (primary?.email) push(primary.email, primary.name);
    for (const e of extraEmails) {
      const u = users.find((x) => x.email.toLowerCase() === e.toLowerCase());
      push(e, u?.name || '');
    }
    return out;
  };

  /** Persist newly-added images through the existing comment-attachment path.
   *  Best-effort — never throws (a failed photo must not fail the task save). */
  const persistImages = async (taskId: string, imgs: string[]): Promise<boolean> => {
    const urls = imgs.filter((u) => u && u.startsWith('data:'));
    if (!urls.length) return true;
    try {
      const res = await api(`/api/tasks/${taskId}/comments`, {
        method: 'POST',
        body: {
          body: '',
          attachments: urls.map((url, i) => ({ kind: 'image', url, filename: `photo-${i + 1}.jpg` })),
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  /** Create the recurring rule mirroring this task. Best-effort. */
  const createRecurringRule = async (assignees: Assignee[]): Promise<boolean> => {
    const base = form.due_date || todayISO();
    const dow = recFreq === 'weekly' ? recDow : undefined;
    const dom = recFreq === 'monthly' ? recDom : undefined;
    const nextRun = nextRecurrence(recFreq, base, dow, dom) || base;
    try {
      const res = await api('/api/tasks/recurring', {
        method: 'POST',
        body: {
          title: form.title.trim(),
          description: form.description.trim(),
          category: form.category,
          department: form.department,
          priority: form.priority,
          assignee_email: assignees[0]?.email || '',
          frequency: recFreq,
          day_of_week: recFreq === 'weekly' ? recDow : 0,
          day_of_month: recFreq === 'monthly' ? recDom : 1,
          next_run_date: nextRun,
          is_active: 1,
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const save = async () => {
    if (saving) return;
    const title = form.title.trim();
    if (!title) { setError('Title is required'); return; }
    setSaving(true);
    setError(null);
    setNotice(null);

    const finalChecklist = [...checklist];
    if (checklistInput.trim()) finalChecklist.push({ label: checklistInput.trim(), done: false });
    const assignees = buildAssignees();

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
      assignees,
      checklist: finalChecklist,
    };
    if (editing) payload.status = form.status;
    else if (form.status && form.status !== 'draft') payload.status = form.status;

    try {
      const res = editing
        ? await api(`/api/tasks/${task.id}`, { method: 'PUT', body: payload })
        : await api('/api/tasks', { method: 'POST', body: payload });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error || `HTTP ${res.status}`); setSaving(false); return; }

      // POST → { task }; PUT → { task, assignees, … }. Both carry `task`.
      const savedTask = j.task ?? j;
      const savedId = savedTask?.id || task?.id;
      const warnings: string[] = [];

      if (newImages.length && savedId) {
        const ok = await persistImages(savedId, newImages);
        if (!ok) warnings.push('some photos could not be attached');
      }
      if (!editing && recurringOn) {
        const ok = await createRecurringRule(assignees);
        if (!ok) warnings.push('recurring schedule could not be created (settings route unavailable)');
      }

      // Refresh the parent's list either way — the task itself was saved.
      onSaved(savedTask);
      if (warnings.length) {
        // Task saved, but a best-effort follow-up failed — keep the modal open
        // so the note is seen and the task can't be re-submitted.
        setNotice(`Task saved — but ${warnings.join('; ')}.`);
        setSavedWithWarning(true);
        setSaving(false);
        return;
      }
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Failed to save task');
    } finally {
      setSaving(false);
    }
  };

  const postComment = async () => {
    if (posting || !editing) return;
    const text = commentText.trim();
    const imgs = commentImages.filter((u) => u && u.startsWith('data:'));
    if (!text && imgs.length === 0) { setCommentNotice('Type a comment or add a photo first.'); return; }
    setPosting(true);
    setCommentNotice(null);
    try {
      const res = await api(`/api/tasks/${task.id}/comments`, {
        method: 'POST',
        body: {
          body: text,
          attachments: imgs.map((url, i) => ({ kind: 'image', url, filename: `photo-${i + 1}.jpg` })),
        },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setCommentNotice(j.error || `HTTP ${res.status}`); return; }
      setCommentText('');
      setCommentImages([]);
      setCommentNotice('Comment added.');
    } catch (e: any) {
      setCommentNotice(e?.message || 'Failed to add comment');
    } finally {
      setPosting(false);
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
        {notice && (
          <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg px-2.5 py-1.5">
            <AlertCircle size={13} className="shrink-0" /> {notice}
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

        {/* Description with @mention autocomplete */}
        <div className="space-y-1">
          <label className={labelCls}>Description</label>
          <MentionTextarea
            value={form.description}
            onChange={(v) => setForm((f) => ({ ...f, description: v }))}
            users={users}
            placeholder="Details, SOP notes, @mention teammates…"
            className={inputCls}
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

        {/* Primary assignee */}
        <div className="space-y-1">
          <label className={labelCls}>Primary assignee</label>
          <UserPicker
            value={primary?.email}
            onPick={(u) => setPrimary({ email: u.email, name: u.name })}
            allowClear
            onClear={() => setPrimary(null)}
            placeholder="Assign to…"
          />
        </div>

        {/* Additional assignees */}
        <div className="space-y-1">
          <label className={labelCls}>Additional assignees</label>
          <UserPicker
            multiple
            values={extraEmails}
            onChange={(emails) => setExtraEmails(emails)}
            placeholder="Add more people…"
          />
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

        {/* Attachments */}
        <div className="space-y-1">
          <label className={labelCls}>Photos</label>
          {existingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 pb-1">
              {existingAttachments.map((src, i) => <ImageThumb key={`ex-${i}`} src={src} size={56} />)}
            </div>
          )}
          <ImageUpload multiple value={newImages} onChange={setNewImages} label="Add photo" />
        </div>

        {/* Recurring (create-only) */}
        {!editing && (
          <div className="space-y-2 rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={recurringOn} onChange={(e) => setRecurringOn(e.target.checked)} className="accent-[#af4408]" />
              <span className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                <Repeat size={14} className="text-[#af4408]" /> Make this recurring
              </span>
            </label>
            {recurringOn && (
              <div className="space-y-2 pt-1">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className={labelCls}>Frequency</label>
                    <select value={recFreq} onChange={(e) => setRecFreq(e.target.value as RecurrenceFrequency)} className={inputCls}>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                  </div>
                  {recFreq === 'weekly' && (
                    <div className="space-y-1">
                      <label className={labelCls}>Day of week</label>
                      <select value={recDow} onChange={(e) => setRecDow(Number(e.target.value))} className={inputCls}>
                        {DOW.map((d, i) => <option key={d} value={i}>{d}</option>)}
                      </select>
                    </div>
                  )}
                  {recFreq === 'monthly' && (
                    <div className="space-y-1">
                      <label className={labelCls}>Day of month</label>
                      <select value={recDom} onChange={(e) => setRecDom(Number(e.target.value))} className={inputCls}>
                        {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </div>
                  )}
                </div>
                <p className="text-[11px] text-[#8B7355]">
                  Creates a recurring rule that auto-generates this task {recFreq === 'daily' ? 'every day' : recFreq === 'weekly' ? `every ${DOW[recDow]}` : `on day ${recDom} of each month`}. The task you create now covers the current cycle.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Parent task (subtask) */}
        <div className="space-y-1">
          <label className={labelCls}>Parent task id (optional — makes this a subtask)</label>
          <input type="text" value={form.parent_task_id} onChange={(e) => setForm((f) => ({ ...f, parent_task_id: e.target.value }))} placeholder="Paste a task id to nest under it" className={inputCls} />
        </div>

        {savedWithWarning ? (
          <button
            onClick={onClose} type="button"
            className="w-full inline-flex items-center justify-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm font-semibold rounded-lg px-3 py-2.5"
          >
            <X size={15} /> Close
          </button>
        ) : (
          <button
            onClick={save} disabled={saving || !form.title.trim()}
            className="w-full inline-flex items-center justify-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm font-semibold rounded-lg px-3 py-2.5 disabled:opacity-50"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            {editing ? 'Save changes' : 'Create task'}
          </button>
        )}

        {/* In-modal comment composer (edit-only) */}
        {editing && (
          <div className="space-y-2 border-t border-[#E8D5C4] pt-3">
            <label className={labelCls}>Add a comment</label>
            <MentionTextarea
              value={commentText}
              onChange={setCommentText}
              users={users}
              placeholder="Leave a note, @mention teammates…"
              className={inputCls}
            />
            <ImageUpload multiple value={commentImages} onChange={setCommentImages} label="Add photo" />
            {commentNotice && <p className="text-[11px] text-[#8B7355]">{commentNotice}</p>}
            <button
              onClick={postComment} disabled={posting}
              type="button"
              className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm font-medium rounded-lg px-3 py-2 disabled:opacity-50"
            >
              {posting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Post comment
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
