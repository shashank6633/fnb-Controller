'use client';

/**
 * Checklist Templates (/tasks/templates).
 *
 * Manager tool to list, create, edit, duplicate and archive checklist templates
 * (role + department + category + ordered items, each optionally photo-required),
 * plus a "Create task from template" action that materialises a one-off task with
 * the template's items baked into its inline checklist.
 *
 * Gate: canManageTasks (admin | manager | head chef | store manager). The API
 * enforces the same on every mutation. Warm theme, mobile-first.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, Archive, ArrowLeft, CheckCircle2, Copy, FileText, GripVertical,
  Loader2, Pencil, Plus, RefreshCw, Rocket, Search, Trash2, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import {
  canManageTasks, CHECKLIST_ROLES, TASK_CATEGORIES, TASK_DEPARTMENTS, TASK_PRIORITIES,
} from '@/lib/tasks';

interface Item { id?: string; label: string; requires_image: number; sort_order?: number; }
interface Template {
  id: string; name: string; role: string; department: string; category: string;
  is_active: number; items: Item[]; item_count: number;
}

const EMPTY_FORM = {
  id: '', name: '', role: '', department: '', category: 'Operations', is_active: 1,
  items: [] as Item[],
};

const csvCell = (x: any) => { const s = String(x ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export default function TemplatesPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined);

  const [rows, setRows] = useState<Template[]>([]);
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Edit / create modal
  const [showEdit, setShowEdit] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Create-task modal
  const [taskFor, setTaskFor] = useState<Template | null>(null);
  const [taskForm, setTaskForm] = useState({ assignee_email: '', due_date: '', priority: 'medium', department: '' });
  const [taskBusy, setTaskBusy] = useState(false);

  const allowed = canManageTasks(me ?? null);

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user ?? null)).catch(() => setMe(null));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (roleFilter) qs.set('role', roleFilter);
    if (includeArchived) qs.set('include_archived', '1');
    if (q.trim()) qs.set('q', q.trim());
    fetch(`/api/tasks/templates?${qs.toString()}`)
      .then(r => r.json())
      .then(j => { if (j.error) { setError(j.error); setRows([]); return; } setRows(j.templates || []); })
      .catch(e => { setError(e?.message || 'Failed to load templates'); setRows([]); })
      .finally(() => setLoading(false));
  }, [roleFilter, includeArchived, q]);

  useEffect(() => {
    if (!allowed) return;
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [allowed, load]);

  /* ── modal helpers ── */
  const openCreate = () => {
    setForm({ ...EMPTY_FORM, items: [{ label: '', requires_image: 0 }] });
    setModalError(null);
    setShowEdit(true);
  };
  const openEdit = (t: Template) => {
    setForm({
      id: t.id, name: t.name, role: t.role, department: t.department,
      category: t.category || 'Operations', is_active: t.is_active,
      items: t.items.map(i => ({ label: i.label, requires_image: i.requires_image })),
    });
    setModalError(null);
    setShowEdit(true);
  };

  const setItemAt = (i: number, patch: Partial<Item>) =>
    setForm(f => ({ ...f, items: f.items.map((it, idx) => idx === i ? { ...it, ...patch } : it) }));
  const addItem = () => setForm(f => ({ ...f, items: [...f.items, { label: '', requires_image: 0 }] }));
  const removeItem = (i: number) => setForm(f => ({ ...f, items: f.items.filter((_, idx) => idx !== i) }));
  const moveItem = (i: number, dir: -1 | 1) => setForm(f => {
    const j = i + dir;
    if (j < 0 || j >= f.items.length) return f;
    const items = [...f.items];
    [items[i], items[j]] = [items[j], items[i]];
    return { ...f, items };
  });

  const saveTemplate = async () => {
    if (saving) return;
    const name = form.name.trim();
    if (!name) { setModalError('Template name is required.'); return; }
    const items = form.items.map(i => ({ label: i.label.trim(), requires_image: i.requires_image ? 1 : 0 })).filter(i => i.label);
    setSaving(true);
    setModalError(null);
    try {
      const isEdit = !!form.id;
      const r = await api('/api/tasks/templates', {
        method: isEdit ? 'PUT' : 'POST',
        body: {
          id: form.id || undefined, name, role: form.role, department: form.department,
          category: form.category, is_active: form.is_active, items,
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setModalError(j.error || `HTTP ${r.status}`); return; }
      setShowEdit(false);
      setNotice(isEdit ? 'Template updated' : 'Template created');
      load();
    } catch (e: any) {
      setModalError(e?.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async (t: Template) => {
    try {
      const r = await api('/api/tasks/templates', { method: 'POST', body: { action: 'duplicate', template_id: t.id } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setNotice(`Duplicated “${t.name}”`);
      load();
    } catch (e: any) { setError(e?.message || 'Failed to duplicate'); }
  };

  const archive = async (t: Template) => {
    if (!confirm(`Archive template “${t.name}”? It stays in reports but won't appear in the checklist picker.`)) return;
    try {
      const r = await api(`/api/tasks/templates?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setNotice(`Archived “${t.name}”`);
      load();
    } catch (e: any) { setError(e?.message || 'Failed to archive'); }
  };

  const openTask = (t: Template) => {
    setTaskFor(t);
    setTaskForm({ assignee_email: '', due_date: '', priority: 'medium', department: t.department || '' });
  };
  const createTask = async () => {
    if (!taskFor || taskBusy) return;
    setTaskBusy(true);
    try {
      const r = await api('/api/tasks/templates', {
        method: 'POST',
        body: {
          action: 'create_task', template_id: taskFor.id,
          assignee_email: taskForm.assignee_email, department: taskForm.department,
          due_date: taskForm.due_date, priority: taskForm.priority,
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setTaskFor(null);
      setNotice('Task created from template');
    } catch (e: any) { setError(e?.message || 'Failed to create task'); }
    finally { setTaskBusy(false); }
  };

  const exportCsv = () => {
    const lines = [['Template', 'Role', 'Department', 'Category', 'Items', 'Active'].map(csvCell).join(',')];
    rows.forEach(t => lines.push([t.name, t.role, t.department, t.category, t.item_count, t.is_active ? 'yes' : 'archived'].map(csvCell).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'checklist-templates.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  /* ── gates ── */
  if (me === undefined) {
    return <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>;
  }
  if (!allowed) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] mb-3">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Managers, admins, head chefs and store managers only. Ask an admin for access to manage checklist templates.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl mx-auto pb-16">
      {/* Header */}
      <div>
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] mb-2">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <FileText size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Checklist Templates</h1>
            <p className="text-xs text-[#8B7355]">Reusable role checklists — edit items, duplicate, archive, or launch as a task.</p>
          </div>
          <button onClick={load} disabled={loading}
            className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={openCreate}
            className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-2">
            <Plus size={14} /> New Template
          </button>
        </div>
      </div>

      {/* Notices */}
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
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input type="text" value={q} onChange={e => setQ(e.target.value)} placeholder="Search templates…"
            className="w-full border border-[#E8D5C4] rounded-lg pl-9 pr-3 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
        </div>
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}
          className="border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
          <option value="">All roles</option>
          {CHECKLIST_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <label className="inline-flex items-center gap-1.5 text-sm text-[#6B5744]">
          <input type="checkbox" checked={includeArchived} onChange={e => setIncludeArchived(e.target.checked)} /> Show archived
        </label>
        <button onClick={exportCsv} disabled={rows.length === 0}
          className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50">
          Export CSV
        </button>
      </div>

      {/* Loading / empty */}
      {loading && rows.length === 0 && (
        <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading templates…</div>
      )}
      {!loading && rows.length === 0 && !error && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
          No templates{q ? ` match “${q}”` : ''}. Tap <span className="font-semibold">New Template</span> to create one.
        </div>
      )}

      {/* Cards */}
      {rows.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {rows.map(t => (
            <div key={t.id} className={`bg-white border rounded-xl p-4 space-y-3 ${t.is_active ? 'border-[#E8D5C4]' : 'border-gray-200 opacity-70'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">
                    {t.name}
                    {!t.is_active && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">archived</span>}
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-1 text-[11px]">
                    {t.role && <span className="px-1.5 py-0.5 rounded-full bg-[#FFF1E3] text-[#8a3606] border border-[#E8D5C4]">{t.role}</span>}
                    {t.department && <span className="px-1.5 py-0.5 rounded-full bg-[#FFF8F0] text-[#6B5744] border border-[#E8D5C4]">{t.department}</span>}
                    <span className="px-1.5 py-0.5 rounded-full bg-[#FFF8F0] text-[#6B5744] border border-[#E8D5C4]">{t.category}</span>
                  </div>
                </div>
                <span className="text-xs text-[#8B7355] shrink-0">{t.item_count} item{t.item_count === 1 ? '' : 's'}</span>
              </div>

              {t.items.length > 0 && (
                <div className="text-xs text-[#6B5744] line-clamp-2">
                  {t.items.slice(0, 6).map(i => i.label).join(' · ')}{t.items.length > 6 ? ' …' : ''}
                </div>
              )}

              <div className="flex flex-wrap gap-1.5 pt-1">
                <button onClick={() => openEdit(t)} className="inline-flex items-center gap-1 text-xs bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] rounded-lg px-2.5 py-1.5">
                  <Pencil size={12} /> Edit
                </button>
                <button onClick={() => openTask(t)} className="inline-flex items-center gap-1 text-xs bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-2.5 py-1.5">
                  <Rocket size={12} /> Create task
                </button>
                <button onClick={() => duplicate(t)} className="inline-flex items-center gap-1 text-xs bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] rounded-lg px-2.5 py-1.5">
                  <Copy size={12} /> Duplicate
                </button>
                {!!t.is_active && (
                  <button onClick={() => archive(t)} className="inline-flex items-center gap-1 text-xs bg-white border border-red-200 hover:border-red-400 text-red-700 rounded-lg px-2.5 py-1.5">
                    <Archive size={12} /> Archive
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit / create modal */}
      {showEdit && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setShowEdit(false)}>
          <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl p-4 sm:p-5 space-y-3 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2">
                <FileText size={18} className="text-[#af4408]" /> {form.id ? 'Edit Template' : 'New Template'}
              </h2>
              <button onClick={() => setShowEdit(false)} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={18} /></button>
            </div>
            {modalError && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-2.5 py-1.5">
                <AlertCircle size={13} className="shrink-0" /> {modalError}
              </div>
            )}
            <input type="text" placeholder="Template name *" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                className="border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                <option value="">Role…</option>
                {CHECKLIST_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <select value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
                className="border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                <option value="">Department…</option>
                {TASK_DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className="border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                {TASK_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {/* Items editor */}
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-[#2D1B0E] uppercase tracking-wide">Checklist Items</div>
              {form.items.length === 0 && <div className="text-xs text-[#8B7355]">No items yet — add one below.</div>}
              {form.items.map((it, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <div className="flex flex-col text-[#C9B49E]">
                    <button onClick={() => moveItem(i, -1)} className="hover:text-[#af4408] leading-none text-xs" title="Move up">▲</button>
                    <button onClick={() => moveItem(i, 1)} className="hover:text-[#af4408] leading-none text-xs" title="Move down">▼</button>
                  </div>
                  <GripVertical size={14} className="text-[#E8D5C4] shrink-0" />
                  <input type="text" placeholder={`Item ${i + 1}`} value={it.label}
                    onChange={e => setItemAt(i, { label: e.target.value })}
                    className="flex-1 border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-[#af4408]" />
                  <label className="inline-flex items-center gap-1 text-[11px] text-[#6B5744] shrink-0" title="Require a photo">
                    <input type="checkbox" checked={!!it.requires_image} onChange={e => setItemAt(i, { requires_image: e.target.checked ? 1 : 0 })} /> 📷
                  </label>
                  <button onClick={() => removeItem(i)} className="text-red-400 hover:text-red-600 shrink-0"><Trash2 size={14} /></button>
                </div>
              ))}
              <button onClick={addItem} className="inline-flex items-center gap-1 text-xs text-[#af4408] hover:text-[#8a3606] font-medium">
                <Plus size={13} /> Add item
              </button>
            </div>

            <button onClick={saveTemplate} disabled={saving}
              className="w-full inline-flex items-center justify-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm font-semibold rounded-lg px-3 py-2.5 disabled:opacity-50">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} {form.id ? 'Save Changes' : 'Create Template'}
            </button>
          </div>
        </div>
      )}

      {/* Create-task modal */}
      {taskFor && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setTaskFor(null)}>
          <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-4 sm:p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2">
                <Rocket size={18} className="text-[#af4408]" /> Create Task
              </h2>
              <button onClick={() => setTaskFor(null)} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={18} /></button>
            </div>
            <p className="text-xs text-[#8B7355]">From <span className="font-semibold text-[#2D1B0E]">{taskFor.name}</span> — {taskFor.item_count} items become the task&apos;s checklist.</p>
            <input type="email" placeholder="Assign to (email, optional)" value={taskForm.assignee_email}
              onChange={e => setTaskForm(f => ({ ...f, assignee_email: e.target.value }))}
              className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
            <div className="grid grid-cols-2 gap-2">
              <input type="date" value={taskForm.due_date} onChange={e => setTaskForm(f => ({ ...f, due_date: e.target.value }))}
                className="border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
              <select value={taskForm.priority} onChange={e => setTaskForm(f => ({ ...f, priority: e.target.value }))}
                className="border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                {TASK_PRIORITIES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>
            <button onClick={createTask} disabled={taskBusy}
              className="w-full inline-flex items-center justify-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm font-semibold rounded-lg px-3 py-2.5 disabled:opacity-50">
              {taskBusy ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />} Create Task
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
