'use client';

/**
 * Daily Checklists (/tasks/checklists).
 *
 * Pick a checklist template (filtered by role / department), choose a date, and
 * mark each item Pass / Fail / NA with an optional comment, photo URL and — for
 * fails — a corrective action that can spin off a corrective task (optionally
 * assigned by email). A live progress bar tracks how many items are answered and
 * the pass rate. Saving upserts one daily_checklist_record per item for the day.
 *
 * Any signed-in user may run a checklist (the API enforces the same). Warm theme,
 * mobile-first.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, CheckCircle2, ClipboardCheck, Image as ImageIcon,
  Loader2, MinusCircle, RefreshCw, Save, XCircle,
} from 'lucide-react';
import { api } from '@/lib/api';
import { CHECKLIST_ROLES, TASK_DEPARTMENTS, TASK_PRIORITIES } from '@/lib/tasks';
import ImageUpload from '@/app/tasks/_components/ImageUpload';
import UserPicker from '@/app/tasks/_components/UserPicker';

interface Item { id: string; label: string; sort_order: number; requires_image: number; }
interface Template {
  id: string; name: string; role: string; department: string; category: string;
  is_active: number; items: Item[];
}
interface RecordRow {
  id: string; item_id: string; result: string; comment: string; image_url: string;
  corrective_action: string; created_task_id: string;
}
type Result = 'pass' | 'fail' | 'na' | '';
interface ItemState {
  result: Result; comment: string; image_url: string; corrective_action: string;
  create_task: boolean; assignee_email: string; assignee_name: string; priority: string; created_task_id: string;
}

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const blankState = (): ItemState => ({
  result: '', comment: '', image_url: '', corrective_action: '',
  create_task: true, assignee_email: '', assignee_name: '', priority: 'high', created_task_id: '',
});

/** requires_image gate: an item flagged requires_image, answered pass/fail, with no photo. */
const photoMissing = (it: Item, st: ItemState | undefined): boolean =>
  !!it.requires_image && !!st && (st.result === 'pass' || st.result === 'fail') && !st.image_url.trim();

export default function ChecklistsPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [roleFilter, setRoleFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [date, setDate] = useState(todayStr());

  const [state, setState] = useState<Record<string, ItemState>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const allowed = !!me; // any signed-in user may run checklists

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user ?? null)).catch(() => setMe(null));
  }, []);

  const activeTemplate = useMemo(
    () => templates.find(t => t.id === templateId) || null,
    [templates, templateId],
  );

  /** Load templates (+ records for the selected template/date) and hydrate state. */
  const load = useCallback((tid: string, d: string) => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (tid) qs.set('template_id', tid);
    if (d) qs.set('date', d);
    if (roleFilter) qs.set('role', roleFilter);
    if (deptFilter) qs.set('department', deptFilter);
    fetch(`/api/tasks/checklists?${qs.toString()}`)
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError(j.error); return; }
        setTemplates(j.templates || []);
        const tpl: Template | null = j.template || (j.templates || []).find((t: Template) => t.id === tid) || null;
        const recs: RecordRow[] = j.records || [];
        if (tpl) {
          const byItem: Record<string, RecordRow> = {};
          recs.forEach(r => { byItem[r.item_id] = r; });
          const next: Record<string, ItemState> = {};
          tpl.items.forEach(it => {
            const r = byItem[it.id];
            next[it.id] = r
              ? {
                  result: (r.result as Result) || '', comment: r.comment || '',
                  image_url: r.image_url || '', corrective_action: r.corrective_action || '',
                  create_task: !r.created_task_id, assignee_email: '', assignee_name: '', priority: 'high',
                  created_task_id: r.created_task_id || '',
                }
              : blankState();
          });
          setState(next);
        } else {
          setState({});
        }
      })
      .catch(e => setError(e?.message || 'Failed to load checklists'))
      .finally(() => setLoading(false));
  }, [roleFilter, deptFilter]);

  // Initial + on template/date/filter change.
  useEffect(() => {
    if (!allowed) return;
    load(templateId, date);
  }, [allowed, templateId, date, load]);

  const setItem = (itemId: string, patch: Partial<ItemState>) =>
    setState(s => ({ ...s, [itemId]: { ...(s[itemId] || blankState()), ...patch } }));

  const items = activeTemplate?.items || [];
  const answered = items.filter(it => (state[it.id]?.result || '') !== '').length;
  const passed = items.filter(it => state[it.id]?.result === 'pass').length;
  const failed = items.filter(it => state[it.id]?.result === 'fail').length;
  const pct = items.length ? Math.round((answered / items.length) * 100) : 0;

  const save = async () => {
    if (!activeTemplate || saving) return;
    // Enforce requires_image: a photo-required item answered pass/fail must have a photo.
    const missingPhoto = items.filter(it => photoMissing(it, state[it.id]));
    if (missingPhoto.length) {
      setError(`Photo required before saving: ${missingPhoto.map(it => it.label).join(', ')}`);
      return;
    }
    const records = items
      .map(it => ({ it, st: state[it.id] }))
      .filter(x => x.st && x.st.result)
      .map(({ it, st }) => ({
        item_id: it.id,
        result: st.result,
        comment: st.comment,
        image_url: st.image_url,
        corrective_action: st.corrective_action,
        create_task: st.result === 'fail' ? st.create_task : false,
        assignee_email: st.assignee_email,
        assignee_name: st.assignee_name,
        priority: st.priority,
      }));
    if (records.length === 0) { setError('Mark at least one item before saving.'); return; }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api('/api/tasks/checklists', {
        method: 'POST',
        body: { template_id: activeTemplate.id, date, department: activeTemplate.department, records },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      const n = j.created_task_ids?.length || 0;
      setNotice(`Saved ${j.saved} item${j.saved === 1 ? '' : 's'}${n ? ` · ${n} corrective task${n === 1 ? '' : 's'} created` : ''}`);
      load(activeTemplate.id, date);
    } catch (e: any) {
      setError(e?.message || 'Failed to save checklist');
    } finally {
      setSaving(false);
    }
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
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] mb-3">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Please sign in to run daily checklists.
        </div>
      </div>
    );
  }

  const RESULT_BTN: { key: Result; label: string; icon: any; on: string; off: string }[] = [
    { key: 'pass', label: 'Pass', icon: CheckCircle2, on: 'bg-green-600 text-white border-green-600', off: 'bg-white text-green-700 border-green-200 hover:border-green-400' },
    { key: 'fail', label: 'Fail', icon: XCircle, on: 'bg-red-600 text-white border-red-600', off: 'bg-white text-red-700 border-red-200 hover:border-red-400' },
    { key: 'na', label: 'NA', icon: MinusCircle, on: 'bg-gray-500 text-white border-gray-500', off: 'bg-white text-gray-600 border-gray-200 hover:border-gray-400' },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-4xl mx-auto pb-24">
      {/* Header */}
      <div>
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] mb-2">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <ClipboardCheck size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Daily Checklists</h1>
            <p className="text-xs text-[#8B7355]">Run a role checklist — Pass / Fail / NA, photos, and corrective tasks on fails.</p>
          </div>
          <button
            onClick={() => load(templateId, date)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* Notices */}
      {notice && (
        <div className="flex items-center justify-between gap-2 bg-green-50 border border-green-200 text-green-800 text-sm rounded-lg px-3 py-2">
          <span className="flex items-center gap-2"><CheckCircle2 size={15} className="shrink-0" /> {notice}</span>
          <button onClick={() => setNotice(null)} className="text-green-700 hover:text-green-900">✕</button>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={15} className="shrink-0" /> {error}
        </div>
      )}

      {/* Filters + picker */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div>
            <label className="block text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide mb-1">Role</label>
            <select value={roleFilter} onChange={e => { setRoleFilter(e.target.value); setTemplateId(''); }}
              className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
              <option value="">All roles</option>
              {CHECKLIST_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide mb-1">Department</label>
            <select value={deptFilter} onChange={e => { setDeptFilter(e.target.value); setTemplateId(''); }}
              className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
              <option value="">All departments</option>
              {TASK_DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide mb-1">Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
          </div>
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide mb-1">Checklist</label>
          <select value={templateId} onChange={e => setTemplateId(e.target.value)}
            className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
            <option value="">Select a checklist…</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.department ? ` · ${t.department}` : ''}</option>)}
          </select>
        </div>
      </div>

      {loading && (
        <div className="p-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
        </div>
      )}

      {!loading && !activeTemplate && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
          {templates.length === 0 ? 'No active checklists match these filters.' : 'Pick a checklist above to begin.'}
        </div>
      )}

      {/* Progress */}
      {!loading && activeTemplate && items.length > 0 && (
        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-3 sm:p-4 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-[#2D1B0E]">{answered}/{items.length} answered</span>
            <span className="flex items-center gap-3 text-[#6B5744]">
              <span className="text-green-700">{passed} pass</span>
              <span className="text-red-700">{failed} fail</span>
            </span>
          </div>
          <div className="h-2 bg-[#E8D5C4] rounded-full overflow-hidden">
            <div className="h-full bg-[#af4408] transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {/* Items */}
      {!loading && activeTemplate && items.length > 0 && (
        <div className="space-y-2">
          {items.map((it, idx) => {
            const st = state[it.id] || blankState();
            const isFail = st.result === 'fail';
            return (
              <div key={it.id} className={`bg-white border rounded-xl p-3 sm:p-4 ${isFail ? 'border-red-200' : 'border-[#E8D5C4]'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#2D1B0E]">
                      <span className="text-[#8B7355] font-normal mr-1">{idx + 1}.</span>{it.label}
                      {!!it.requires_image && <span className="ml-2 inline-flex items-center gap-0.5 text-[10px] text-[#af4408]"><ImageIcon size={11} /> photo</span>}
                    </div>
                    {st.created_task_id && (
                      <div className="text-[11px] text-[#af4408] mt-0.5">Corrective task already created ✓</div>
                    )}
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    {RESULT_BTN.map(b => {
                      const active = st.result === b.key;
                      const Icon = b.icon;
                      return (
                        <button key={b.key} onClick={() => setItem(it.id, { result: active ? '' : b.key })}
                          className={`inline-flex items-center gap-1 text-xs font-semibold rounded-lg px-2.5 py-1.5 border ${active ? b.on : b.off}`}>
                          <Icon size={13} /> <span className="hidden sm:inline">{b.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Detail row shown once answered */}
                {st.result && (
                  <div className="mt-3 space-y-2">
                    <input type="text" placeholder="Comment (optional)" value={st.comment}
                      onChange={e => setItem(it.id, { comment: e.target.value })}
                      className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />

                    {/* Photo — required for requires_image items answered pass/fail */}
                    <div className={`rounded-lg p-2.5 border ${photoMissing(it, st) ? 'border-red-300 bg-red-50' : 'border-[#E8D5C4] bg-[#FFF8F0]'}`}>
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-[#8B7355]">
                          Photo {it.requires_image ? <span className="text-[#af4408]">(required)</span> : <span className="text-[#8B7355]">(optional)</span>}
                        </span>
                        {photoMissing(it, st) && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-red-600 font-medium">
                            <AlertCircle size={12} /> Add a photo to save
                          </span>
                        )}
                      </div>
                      <ImageUpload
                        value={st.image_url ? [st.image_url] : []}
                        onChange={list => setItem(it.id, { image_url: list[0] || '' })}
                        label="Add photo"
                      />
                    </div>

                    {isFail && (
                      <div className="bg-red-50 border border-red-100 rounded-lg p-2.5 space-y-2">
                        <input type="text" placeholder="Corrective action (use @email to notify)" value={st.corrective_action}
                          onChange={e => setItem(it.id, { corrective_action: e.target.value })}
                          className="w-full border border-red-200 rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                        {!st.created_task_id && (
                          <div className="space-y-2">
                            <label className="inline-flex items-center gap-1.5 text-xs text-[#6B5744]">
                              <input type="checkbox" checked={st.create_task}
                                onChange={e => setItem(it.id, { create_task: e.target.checked })} />
                              Create corrective task
                            </label>
                            {st.create_task && (
                              <div className="flex flex-wrap items-end gap-2">
                                <div className="flex-1 min-w-[180px]">
                                  <label className="block text-[10px] font-semibold uppercase tracking-wide text-[#8B7355] mb-1">Assign to</label>
                                  <UserPicker
                                    value={st.assignee_email}
                                    onPick={u => setItem(it.id, { assignee_email: u.email, assignee_name: u.name })}
                                    allowClear
                                    onClear={() => setItem(it.id, { assignee_email: '', assignee_name: '' })}
                                    placeholder="Assign to… (optional)"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] font-semibold uppercase tracking-wide text-[#8B7355] mb-1">Priority</label>
                                  <select value={st.priority} onChange={e => setItem(it.id, { priority: e.target.value })}
                                    className="border border-[#E8D5C4] rounded-lg px-2 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                                    {TASK_PRIORITIES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                                  </select>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Sticky save */}
      {!loading && activeTemplate && items.length > 0 && (
        <div className="sticky bottom-0 -mx-4 sm:mx-0 px-4 sm:px-0 py-3 bg-gradient-to-t from-[#FFF8F0] via-[#FFF8F0] to-transparent">
          <button onClick={save} disabled={saving || answered === 0}
            className="w-full inline-flex items-center justify-center gap-2 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm font-semibold rounded-lg px-4 py-3 disabled:opacity-50">
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Save Checklist{answered > 0 ? ` (${answered})` : ''}
          </button>
        </div>
      )}
    </div>
  );
}
