'use client';

/**
 * Task-Module Settings (/tasks/settings) — admin control panel.
 *
 * Tabbed admin config for the whole task module. Every tab reads from and
 * persists to /api/tasks/settings (categories + scalar tm_* config) or
 * /api/tasks/departments (department registry):
 *   Categories · Priorities · Departments · Approval Levels ·
 *   Notifications & Escalation · Recurring · Working Hours & Holidays · Reminders
 *
 * Client gate: admin only (amber lock card otherwise); the API enforces the
 * same admin gate server-side. Warm theme, mobile-first.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, Bell, Building2, CalendarClock, CheckCircle2, Clock,
  GitBranch, Layers, Loader2, Pencil, Plus, RefreshCw, RotateCcw, Save, Settings2,
  Tag, Trash2, X, Zap,
} from 'lucide-react';
import { api } from '@/lib/api';
import { nextRecurrence, TASK_CATEGORIES, TASK_DEPARTMENTS, TASK_PRIORITIES } from '@/lib/tasks';
import UserPicker from '@/app/tasks/_components/UserPicker';

/* ── types ─────────────────────────────────────────────────────────────── */

interface Category { id: string; name: string; color: string; icon: string; sort_order: number; is_active: number }
interface PriorityCfg { key: string; label: string; color: string }
interface ApprovalLevel { name: string; min_priority: string; approver_role: string }
interface EscalationRule { priority: string; hours: number; escalate_to: string }
interface Holiday { date: string; name: string }
interface NotificationRules {
  on_assign: boolean; on_mention: boolean; on_status_change: boolean;
  on_overdue: boolean; on_approval: boolean; daily_digest: boolean;
}
interface WorkingHours { start: string; end: string; days: number[] }
interface Config {
  approval_levels: ApprovalLevel[];
  notification_rules: NotificationRules;
  escalation_matrix: EscalationRule[];
  working_hours: WorkingHours;
  holidays: Holiday[];
  reminder_interval_hours: number;
  /** Automation-consumed escalation controls (task-automation engine). */
  escalation_enabled: boolean;
  escalation_threshold_days: number;
  escalation_targets: string[];
}
interface AutomationStatus { last_run: string; today: string; ran_today: boolean }
interface SettingsPayload {
  categories: Category[];
  priorities: PriorityCfg[];
  config: Config;
  recurring: { rules: any[]; rule_count: number; maintenance_count: number };
  automation?: AutomationStatus;
  escalation_role_options?: string[];
}
interface Dept { id: string; name: string; code: string; is_active: number }

/** A recurring_task_rules row as returned by /api/tasks/recurring. */
interface RecurringRule {
  id: string;
  title: string;
  description: string;
  category: string;
  department: string;
  assignee_email: string;
  priority: string;
  frequency: 'daily' | 'weekly' | 'monthly' | string;
  day_of_week: number;
  day_of_month: number;
  next_run_date: string;
  last_run_date: string;
  next_run_preview?: string;
  is_active: number;
}

/**
 * Literal badge classes per color name. Kept as full literal strings (not
 * `bg-${color}-100`) so Tailwind v4's source scanner actually emits them.
 */
const SWATCH: Record<string, string> = {
  slate: 'bg-slate-100 text-slate-700 border-slate-200',
  gray: 'bg-gray-100 text-gray-700 border-gray-200',
  red: 'bg-red-100 text-red-700 border-red-200',
  orange: 'bg-orange-100 text-orange-700 border-orange-200',
  amber: 'bg-amber-100 text-amber-800 border-amber-200',
  yellow: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  lime: 'bg-lime-100 text-lime-700 border-lime-200',
  green: 'bg-green-100 text-green-700 border-green-200',
  emerald: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  teal: 'bg-teal-100 text-teal-700 border-teal-200',
  cyan: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  blue: 'bg-blue-100 text-blue-700 border-blue-200',
  indigo: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  violet: 'bg-violet-100 text-violet-700 border-violet-200',
  purple: 'bg-purple-100 text-purple-700 border-purple-200',
  rose: 'bg-rose-100 text-rose-700 border-rose-200',
};
const COLOR_OPTIONS = Object.keys(SWATCH);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PRIORITY_KEYS = TASK_PRIORITIES.map(p => p.key);

const TABS = [
  { key: 'categories', label: 'Categories', icon: Tag },
  { key: 'priorities', label: 'Priorities', icon: Layers },
  { key: 'departments', label: 'Departments', icon: Building2 },
  { key: 'approvals', label: 'Approval Levels', icon: CheckCircle2 },
  { key: 'notifications', label: 'Notifications & Escalation', icon: Bell },
  { key: 'recurring', label: 'Recurring', icon: GitBranch },
  { key: 'hours', label: 'Working Hours & Holidays', icon: Clock },
  { key: 'reminders', label: 'Reminders', icon: CalendarClock },
] as const;
type TabKey = typeof TABS[number]['key'];

function colorSwatch(color: string) {
  return SWATCH[color] || SWATCH.gray;
}

const FREQ_CLS: Record<string, string> = {
  daily: 'bg-blue-100 text-blue-700 border-blue-200',
  weekly: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  monthly: 'bg-purple-100 text-purple-700 border-purple-200',
};

const EMPTY_RULE: RecurringRule = {
  id: '',
  title: '',
  description: '',
  category: 'Operations',
  department: '',
  assignee_email: '',
  priority: 'medium',
  frequency: 'daily',
  day_of_week: 1,
  day_of_month: 1,
  next_run_date: '',
  last_run_date: '',
  is_active: 1,
};

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

/** Live "following run" preview from the form's cadence inputs. */
function previewNextRun(r: RecurringRule): string {
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(r.next_run_date) ? r.next_run_date : new Date().toISOString().slice(0, 10);
  return nextRecurrence(
    (['daily', 'weekly', 'monthly'].includes(r.frequency) ? r.frequency : 'daily') as any,
    anchor,
    r.frequency === 'weekly' ? r.day_of_week : undefined,
    r.frequency === 'monthly' ? r.day_of_month : undefined,
  );
}

/* ── page ──────────────────────────────────────────────────────────────── */

export default function TaskSettingsPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined);

  const [data, setData] = useState<SettingsPayload | null>(null);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [tab, setTab] = useState<TabKey>('categories');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // local editable copy of scalar config
  const [config, setConfig] = useState<Config | null>(null);
  const [priorities, setPriorities] = useState<PriorityCfg[]>([]);

  // recurring-rule manager state
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  const [escRoleOptions, setEscRoleOptions] = useState<string[]>(['manager', 'admin', 'staff']);
  const [showRecForm, setShowRecForm] = useState(false);
  const [recForm, setRecForm] = useState<RecurringRule>({ ...EMPTY_RULE });
  const [recSaving, setRecSaving] = useState(false);
  const [recModalError, setRecModalError] = useState<string | null>(null);

  const allowed = !!me && me.role === 'admin';

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user ?? null)).catch(() => setMe(null));
  }, []);

  const loadRecurring = useCallback(() => {
    setRulesLoading(true);
    fetch('/api/tasks/recurring?include_inactive=1')
      .then(r => r.json())
      .then(j => {
        if (j.error) return;
        setRules(j.rules || []);
        if (j.automation) setAutomation(j.automation);
      })
      .catch(() => { /* non-fatal */ })
      .finally(() => setRulesLoading(false));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch('/api/tasks/settings').then(r => r.json()),
      fetch('/api/tasks/departments?include_inactive=1').then(r => r.json()),
    ])
      .then(([s, d]) => {
        if (s.error) { setError(s.error); return; }
        setData(s);
        setConfig(s.config);
        setPriorities(s.priorities || []);
        setDepts(d.departments || []);
        if (s.automation) setAutomation(s.automation);
        if (Array.isArray(s.escalation_role_options)) setEscRoleOptions(s.escalation_role_options);
      })
      .catch(e => setError(e?.message || 'Failed to load settings'))
      .finally(() => setLoading(false));
    loadRecurring();
  }, [loadRecurring]);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(null), 2500); };

  /* ── category ops ── */
  const [newCat, setNewCat] = useState({ name: '', color: 'blue', icon: '' });
  const addCategory = async () => {
    if (!newCat.name.trim() || saving) return;
    setSaving(true); setError(null);
    try {
      const r = await api('/api/tasks/settings', { method: 'POST', body: newCat });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setNewCat({ name: '', color: 'blue', icon: '' });
      flash('Category added');
      load();
    } catch (e: any) { setError(e?.message || 'Failed'); } finally { setSaving(false); }
  };
  const patchCategory = async (id: string, patch: any) => {
    setSaving(true); setError(null);
    try {
      const r = await api('/api/tasks/settings', { method: 'PATCH', body: { id, ...patch } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      load();
    } catch (e: any) { setError(e?.message || 'Failed'); } finally { setSaving(false); }
  };
  const deactivateCategory = async (id: string) => {
    setSaving(true); setError(null);
    try {
      const r = await api(`/api/tasks/settings?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      flash('Category deactivated');
      load();
    } catch (e: any) { setError(e?.message || 'Failed'); } finally { setSaving(false); }
  };

  /* ── department ops ── */
  const [newDept, setNewDept] = useState({ name: '', code: '' });
  const addDept = async () => {
    if (!newDept.name.trim() || saving) return;
    setSaving(true); setError(null);
    try {
      const r = await api('/api/tasks/departments', { method: 'POST', body: newDept });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setNewDept({ name: '', code: '' });
      flash('Department added');
      load();
    } catch (e: any) { setError(e?.message || 'Failed'); } finally { setSaving(false); }
  };
  const toggleDept = async (d: Dept) => {
    setSaving(true); setError(null);
    try {
      const r = d.is_active
        ? await api(`/api/tasks/departments?id=${encodeURIComponent(d.id)}`, { method: 'DELETE' })
        : await api('/api/tasks/departments', { method: 'PUT', body: { id: d.id, is_active: 1 } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      load();
    } catch (e: any) { setError(e?.message || 'Failed'); } finally { setSaving(false); }
  };

  /* ── scalar config persist ── */
  const saveConfig = async (partial: Partial<Config>, extra?: { priorities?: PriorityCfg[] }) => {
    setSaving(true); setError(null);
    try {
      const body: any = { config: partial };
      if (extra?.priorities) body.priorities = extra.priorities;
      const r = await api('/api/tasks/settings', { method: 'PUT', body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      if (j.config) { setData(j); setConfig(j.config); setPriorities(j.priorities || []); if (j.automation) setAutomation(j.automation); }
      flash('Saved');
    } catch (e: any) { setError(e?.message || 'Failed'); } finally { setSaving(false); }
  };

  /* ── recurring-rule ops ── */
  const openRecCreate = () => {
    setRecForm({ ...EMPTY_RULE, next_run_date: automation?.today || new Date().toISOString().slice(0, 10) });
    setRecModalError(null);
    setShowRecForm(true);
  };
  const openRecEdit = (r: RecurringRule) => {
    setRecForm({ ...EMPTY_RULE, ...r });
    setRecModalError(null);
    setShowRecForm(true);
  };
  const saveRule = async () => {
    if (recSaving) return;
    if (!recForm.title.trim()) { setRecModalError('Title is required'); return; }
    setRecSaving(true); setRecModalError(null);
    try {
      const editing = !!recForm.id;
      const r = await api('/api/tasks/recurring', {
        method: editing ? 'PUT' : 'POST',
        body: {
          ...(editing ? { id: recForm.id } : {}),
          title: recForm.title,
          description: recForm.description,
          category: recForm.category,
          department: recForm.department,
          assignee_email: recForm.assignee_email,
          priority: recForm.priority,
          frequency: recForm.frequency,
          day_of_week: recForm.day_of_week,
          day_of_month: recForm.day_of_month,
          next_run_date: recForm.next_run_date,
          is_active: recForm.is_active,
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setRecModalError(j.error || `HTTP ${r.status}`); return; }
      setShowRecForm(false);
      setRecForm({ ...EMPTY_RULE });
      flash(editing ? 'Rule updated' : 'Rule created');
      loadRecurring();
    } catch (e: any) { setRecModalError(e?.message || 'Failed to save'); } finally { setRecSaving(false); }
  };
  const toggleRule = async (r: RecurringRule) => {
    setSaving(true); setError(null);
    try {
      const resp = r.is_active
        ? await api(`/api/tasks/recurring?id=${encodeURIComponent(r.id)}`, { method: 'DELETE' })
        : await api('/api/tasks/recurring', { method: 'PUT', body: { id: r.id, is_active: 1 } });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) { setError(j.error || `HTTP ${resp.status}`); return; }
      flash(r.is_active ? 'Rule deactivated' : 'Rule reactivated');
      loadRecurring();
    } catch (e: any) { setError(e?.message || 'Failed'); } finally { setSaving(false); }
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
          🔒 Admins only. Task-module configuration (categories, priorities, approvals, escalation and reminders) is system-wide — ask an admin to make changes.
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
            <Settings2 size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Task Settings</h1>
            <p className="text-xs text-[#8B7355]">Categories, priorities, departments, approvals, escalation and reminders</p>
          </div>
          <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* Banners */}
      {notice && (
        <div className="flex items-center justify-between gap-2 bg-green-50 border border-green-200 text-green-800 text-sm rounded-lg px-3 py-2">
          <span className="flex items-center gap-2"><CheckCircle2 size={15} /> {notice}</span>
          <button onClick={() => setNotice(null)} className="text-green-700 hover:text-green-900"><X size={14} /></button>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={15} className="shrink-0" /> {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-1.5 border-b border-[#E8D5C4] pb-2">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 text-sm rounded-lg px-3 py-1.5 border ${
                tab === t.key
                  ? 'bg-[#af4408] text-white border-[#af4408]'
                  : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:border-[#af4408]'
              }`}
            >
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {loading && !data && (
        <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading settings…</div>
      )}

      {data && config && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-5">
          {/* ── Categories ── */}
          {tab === 'categories' && (
            <div className="space-y-3">
              <p className="text-xs text-[#8B7355]">Task categories used across every task. Deactivating hides a category from pickers but keeps historic tasks intact.</p>
              <div className="flex flex-wrap gap-2 items-end bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
                <div className="flex-1 min-w-[140px]">
                  <label className="block text-[11px] text-[#8B7355] mb-1">Name</label>
                  <input value={newCat.name} onChange={e => setNewCat(f => ({ ...f, name: e.target.value }))} placeholder="Category name" className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                </div>
                <div>
                  <label className="block text-[11px] text-[#8B7355] mb-1">Color</label>
                  <select value={newCat.color} onChange={e => setNewCat(f => ({ ...f, color: e.target.value }))} className="border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                    {COLOR_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-[#8B7355] mb-1">Icon</label>
                  <input value={newCat.icon} onChange={e => setNewCat(f => ({ ...f, icon: e.target.value }))} placeholder="lucide name" className="w-28 border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                </div>
                <button onClick={addCategory} disabled={saving || !newCat.name.trim()} className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-1.5 disabled:opacity-50">
                  <Plus size={14} /> Add
                </button>
              </div>
              <div className="divide-y divide-[#F0E4D6] border border-[#E8D5C4] rounded-lg overflow-hidden">
                {data.categories.map(c => (
                  <div key={c.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 ${!c.is_active ? 'opacity-50' : ''}`}>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${colorSwatch(c.color || 'gray')}`}>{c.name}</span>
                    {c.icon && <span className="text-[11px] text-[#8B7355]">{c.icon}</span>}
                    {!c.is_active && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">inactive</span>}
                    <div className="ml-auto flex items-center gap-2">
                      <select
                        value={c.color || 'gray'}
                        onChange={e => patchCategory(c.id, { color: e.target.value })}
                        className="border border-[#E8D5C4] rounded-lg px-2 py-1 text-xs bg-white focus:outline-none focus:border-[#af4408]"
                      >
                        {COLOR_OPTIONS.map(col => <option key={col} value={col}>{col}</option>)}
                      </select>
                      {c.is_active ? (
                        <button onClick={() => deactivateCategory(c.id)} disabled={saving} className="p-1.5 rounded-lg text-[#8B7355] hover:text-red-600 hover:bg-red-50" title="Deactivate"><Trash2 size={14} /></button>
                      ) : (
                        <button onClick={() => patchCategory(c.id, { is_active: 1 })} disabled={saving} className="p-1.5 rounded-lg text-[#8B7355] hover:text-green-600 hover:bg-green-50" title="Reactivate"><RotateCcw size={14} /></button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Priorities ── */}
          {tab === 'priorities' && (
            <div className="space-y-3">
              <p className="text-xs text-[#8B7355]">Priority display labels &amp; badge colors. The underlying keys (low / medium / high / urgent) are fixed; only labels &amp; colors are editable.</p>
              <div className="space-y-2">
                {priorities.map((p, i) => (
                  <div key={p.key} className="flex flex-wrap items-center gap-2 border border-[#E8D5C4] rounded-lg px-3 py-2">
                    <span className="text-xs font-mono text-[#8B7355] w-16">{p.key}</span>
                    <input
                      value={p.label}
                      onChange={e => setPriorities(ps => ps.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                      className="flex-1 min-w-[120px] border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]"
                    />
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${p.color}`}>{p.label || p.key}</span>
                  </div>
                ))}
              </div>
              <button onClick={() => saveConfig({}, { priorities })} disabled={saving} className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-2 disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save Priorities
              </button>
            </div>
          )}

          {/* ── Departments ── */}
          {tab === 'departments' && (
            <div className="space-y-3">
              <p className="text-xs text-[#8B7355]">The task module's department registry. Manage full per-department stats on the <button onClick={() => router.push('/tasks/departments')} className="text-[#af4408] hover:underline">Departments</button> page.</p>
              <div className="flex flex-wrap gap-2 items-end bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
                <div className="flex-1 min-w-[140px]">
                  <label className="block text-[11px] text-[#8B7355] mb-1">Name</label>
                  <input value={newDept.name} onChange={e => setNewDept(f => ({ ...f, name: e.target.value }))} placeholder="Department name" className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                </div>
                <div>
                  <label className="block text-[11px] text-[#8B7355] mb-1">Code</label>
                  <input value={newDept.code} onChange={e => setNewDept(f => ({ ...f, code: e.target.value }))} placeholder="OPS" className="w-24 border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                </div>
                <button onClick={addDept} disabled={saving || !newDept.name.trim()} className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-1.5 disabled:opacity-50">
                  <Plus size={14} /> Add
                </button>
              </div>
              <div className="divide-y divide-[#F0E4D6] border border-[#E8D5C4] rounded-lg overflow-hidden">
                {depts.map(d => (
                  <div key={d.id} className={`flex items-center gap-2 px-3 py-2 ${!d.is_active ? 'opacity-50' : ''}`}>
                    <span className="text-sm font-medium text-[#2D1B0E]">{d.name}</span>
                    {d.code && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#FFF1E3] border border-[#E8D5C4] text-[#8a3606]">{d.code}</span>}
                    {!d.is_active && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">inactive</span>}
                    <div className="ml-auto">
                      {d.is_active ? (
                        <button onClick={() => toggleDept(d)} disabled={saving} className="p-1.5 rounded-lg text-[#8B7355] hover:text-red-600 hover:bg-red-50" title="Deactivate"><Trash2 size={14} /></button>
                      ) : (
                        <button onClick={() => toggleDept(d)} disabled={saving} className="p-1.5 rounded-lg text-[#8B7355] hover:text-green-600 hover:bg-green-50" title="Reactivate"><RotateCcw size={14} /></button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Approval Levels ── */}
          {tab === 'approvals' && (
            <div className="space-y-3">
              <p className="text-xs text-[#8B7355]">Ordered approval levels. A task at or above the minimum priority routes through each level's approver role before it can be approved.</p>
              {config.approval_levels.map((lvl, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2 border border-[#E8D5C4] rounded-lg p-3">
                  <div className="flex-1 min-w-[140px]">
                    <label className="block text-[11px] text-[#8B7355] mb-1">Level name</label>
                    <input value={lvl.name} onChange={e => setConfig(c => c && ({ ...c, approval_levels: c.approval_levels.map((x, j) => j === i ? { ...x, name: e.target.value } : x) }))} className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                  </div>
                  <div>
                    <label className="block text-[11px] text-[#8B7355] mb-1">Min priority</label>
                    <select value={lvl.min_priority} onChange={e => setConfig(c => c && ({ ...c, approval_levels: c.approval_levels.map((x, j) => j === i ? { ...x, min_priority: e.target.value } : x) }))} className="border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                      {PRIORITY_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-[#8B7355] mb-1">Approver role</label>
                    <select value={lvl.approver_role} onChange={e => setConfig(c => c && ({ ...c, approval_levels: c.approval_levels.map((x, j) => j === i ? { ...x, approver_role: e.target.value } : x) }))} className="border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                      {['manager', 'admin', 'head_chef', 'store_manager'].map(k => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </div>
                  <button onClick={() => setConfig(c => c && ({ ...c, approval_levels: c.approval_levels.filter((_, j) => j !== i) }))} className="p-1.5 rounded-lg text-[#8B7355] hover:text-red-600 hover:bg-red-50" title="Remove"><Trash2 size={14} /></button>
                </div>
              ))}
              <div className="flex gap-2">
                <button onClick={() => setConfig(c => c && ({ ...c, approval_levels: [...c.approval_levels, { name: '', min_priority: 'medium', approver_role: 'manager' }] }))} className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#6B5744] text-sm rounded-lg px-3 py-1.5">
                  <Plus size={14} /> Add level
                </button>
                <button onClick={() => saveConfig({ approval_levels: config.approval_levels })} disabled={saving} className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-1.5 disabled:opacity-50">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
                </button>
              </div>
            </div>
          )}

          {/* ── Notifications & Escalation ── */}
          {tab === 'notifications' && (
            <div className="space-y-4">
              <div>
                <div className="text-sm font-semibold text-[#2D1B0E] mb-2">Notification rules</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {([
                    ['on_assign', 'On assignment'],
                    ['on_mention', 'On @mention'],
                    ['on_status_change', 'On status change'],
                    ['on_overdue', 'On overdue'],
                    ['on_approval', 'On approval / reopen'],
                    ['daily_digest', 'Daily digest email'],
                  ] as [keyof NotificationRules, string][]).map(([k, label]) => (
                    <label key={k} className="inline-flex items-center gap-2 text-sm text-[#2D1B0E] bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2">
                      <input type="checkbox" checked={!!config.notification_rules[k]} onChange={e => setConfig(c => c && ({ ...c, notification_rules: { ...c.notification_rules, [k]: e.target.checked } }))} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-sm font-semibold text-[#2D1B0E] mb-2">Escalation matrix</div>
                {config.escalation_matrix.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2 border border-[#E8D5C4] rounded-lg p-3 mb-2">
                    <div>
                      <label className="block text-[11px] text-[#8B7355] mb-1">Priority</label>
                      <select value={r.priority} onChange={e => setConfig(c => c && ({ ...c, escalation_matrix: c.escalation_matrix.map((x, j) => j === i ? { ...x, priority: e.target.value } : x) }))} className="border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                        {PRIORITY_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-[#8B7355] mb-1">Escalate after (hrs)</label>
                      <input type="number" min={1} value={r.hours} onChange={e => setConfig(c => c && ({ ...c, escalation_matrix: c.escalation_matrix.map((x, j) => j === i ? { ...x, hours: Number(e.target.value) || 0 } : x) }))} className="w-28 border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                    </div>
                    <div className="flex-1 min-w-[160px]">
                      <label className="block text-[11px] text-[#8B7355] mb-1">Escalate to (email)</label>
                      <input value={r.escalate_to} onChange={e => setConfig(c => c && ({ ...c, escalation_matrix: c.escalation_matrix.map((x, j) => j === i ? { ...x, escalate_to: e.target.value } : x) }))} placeholder="manager@venue.com" className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                    </div>
                    <button onClick={() => setConfig(c => c && ({ ...c, escalation_matrix: c.escalation_matrix.filter((_, j) => j !== i) }))} className="p-1.5 rounded-lg text-[#8B7355] hover:text-red-600 hover:bg-red-50" title="Remove"><Trash2 size={14} /></button>
                  </div>
                ))}
                <button onClick={() => setConfig(c => c && ({ ...c, escalation_matrix: [...c.escalation_matrix, { priority: 'high', hours: 8, escalate_to: '' }] }))} className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#6B5744] text-sm rounded-lg px-3 py-1.5">
                  <Plus size={14} /> Add rule
                </button>
              </div>

              {/* Auto-escalation engine controls (consumed by the daily automation run) */}
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-[#2D1B0E]">
                  <Zap size={15} className="text-[#af4408]" /> Auto-escalation engine
                </div>
                <p className="text-[11px] text-[#8B7355] -mt-1">These drive the once-a-day overdue sweep that notifies assignees and escalates stale tasks to the roles below. The matrix above is retained for reference.</p>
                <label className="inline-flex items-center gap-2 text-sm text-[#2D1B0E]">
                  <input type="checkbox" checked={!!config.escalation_enabled} onChange={e => setConfig(c => c && ({ ...c, escalation_enabled: e.target.checked }))} className="accent-[#af4408]" />
                  Enable automatic escalation
                </label>
                <div className="flex flex-wrap items-end gap-4">
                  <div>
                    <label className="block text-[11px] text-[#8B7355] mb-1">Escalate after (days overdue)</label>
                    <input type="number" min={0} max={365} value={config.escalation_threshold_days}
                      onChange={e => setConfig(c => c && ({ ...c, escalation_threshold_days: Math.max(0, Number(e.target.value) || 0) }))}
                      className="w-28 border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                  </div>
                  <div>
                    <label className="block text-[11px] text-[#8B7355] mb-1">Escalate to roles</label>
                    <div className="flex flex-wrap gap-1.5">
                      {escRoleOptions.map(role => {
                        const on = config.escalation_targets.includes(role);
                        return (
                          <button key={role} type="button"
                            onClick={() => setConfig(c => c && ({ ...c, escalation_targets: on ? c.escalation_targets.filter(x => x !== role) : [...c.escalation_targets, role] }))}
                            className={`text-xs rounded-lg px-2.5 py-1 border capitalize ${on ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}>
                            {role}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              <button onClick={() => saveConfig({ notification_rules: config.notification_rules, escalation_matrix: config.escalation_matrix, escalation_enabled: config.escalation_enabled, escalation_threshold_days: config.escalation_threshold_days, escalation_targets: config.escalation_targets })} disabled={saving} className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-2 disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save Notifications &amp; Escalation
              </button>
            </div>
          )}

          {/* ── Recurring ── */}
          {tab === 'recurring' && (
            <div className="space-y-3">
              <p className="text-xs text-[#8B7355]">Recurring task rules the daily automation run turns into tasks. Maintenance schedules live on their own page.</p>

              {/* Automation status + counts */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
                  <div className="text-2xl font-bold text-[#af4408]">{rules.filter(r => r.is_active).length}</div>
                  <div className="text-xs text-[#8B7355]">Active recurring rules</div>
                </div>
                <button onClick={() => router.push('/tasks/maintenance')} className="bg-[#FFF8F0] border border-[#E8D5C4] hover:border-[#af4408] rounded-lg p-3 text-left">
                  <div className="text-2xl font-bold text-[#af4408]">{data.recurring.maintenance_count}</div>
                  <div className="text-xs text-[#8B7355]">Maintenance schedules →</div>
                </button>
                <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
                  <div className="text-sm font-bold text-[#2D1B0E] flex items-center gap-1.5">
                    <CalendarClock size={15} className="text-[#af4408]" />
                    {automation?.last_run ? fmtDate(automation.last_run) : 'Never'}
                  </div>
                  <div className="text-xs text-[#8B7355]">Last automation run{automation?.ran_today ? ' · today ✓' : ''}</div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-[#2D1B0E]">Rules</div>
                <button onClick={openRecCreate} className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-1.5">
                  <Plus size={14} /> New rule
                </button>
              </div>

              {rulesLoading && rules.length === 0 && (
                <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading rules…</div>
              )}
              {!rulesLoading && rules.length === 0 && (
                <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-6 text-center text-sm text-[#8B7355]">No recurring rules yet. Create one to auto-generate tasks on a cadence.</div>
              )}
              {rules.length > 0 && (
                <div className="divide-y divide-[#F0E4D6] border border-[#E8D5C4] rounded-lg overflow-hidden">
                  {rules.map((r) => (
                    <div key={r.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 text-sm ${!r.is_active ? 'opacity-50' : ''}`}>
                      <span className="font-medium text-[#2D1B0E] flex-1 min-w-[120px] truncate">{r.title}</span>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border capitalize ${FREQ_CLS[r.frequency] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                        {r.frequency}
                        {r.frequency === 'weekly' && ` · ${DOW[r.day_of_week] || '?'}`}
                        {r.frequency === 'monthly' && ` · day ${r.day_of_month}`}
                      </span>
                      {r.department && <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#FFF1E3] border border-[#E8D5C4] text-[#8a3606]">{r.department}</span>}
                      {r.assignee_email && <span className="text-[11px] text-[#8B7355] truncate max-w-[160px]">{r.assignee_email}</span>}
                      <span className="text-xs text-[#6B5744]">next {r.next_run_date ? fmtDate(r.next_run_date) : '—'}</span>
                      {!r.is_active && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">inactive</span>}
                      <div className="ml-auto flex items-center gap-1">
                        <button onClick={() => openRecEdit(r)} title="Edit" className="inline-flex items-center text-[#8B7355] hover:text-[#af4408] p-1"><Pencil size={14} /></button>
                        {r.is_active ? (
                          <button onClick={() => toggleRule(r)} disabled={saving} title="Deactivate" className="p-1 rounded-lg text-[#8B7355] hover:text-red-600 hover:bg-red-50"><Trash2 size={14} /></button>
                        ) : (
                          <button onClick={() => toggleRule(r)} disabled={saving} title="Reactivate" className="p-1 rounded-lg text-[#8B7355] hover:text-green-600 hover:bg-green-50"><RotateCcw size={14} /></button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Working Hours & Holidays ── */}
          {tab === 'hours' && (
            <div className="space-y-4">
              <div>
                <div className="text-sm font-semibold text-[#2D1B0E] mb-2">Working hours</div>
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label className="block text-[11px] text-[#8B7355] mb-1">Opens</label>
                    <input type="time" value={config.working_hours.start} onChange={e => setConfig(c => c && ({ ...c, working_hours: { ...c.working_hours, start: e.target.value } }))} className="border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                  </div>
                  <div>
                    <label className="block text-[11px] text-[#8B7355] mb-1">Closes</label>
                    <input type="time" value={config.working_hours.end} onChange={e => setConfig(c => c && ({ ...c, working_hours: { ...c.working_hours, end: e.target.value } }))} className="border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {DOW.map((d, idx) => {
                    const on = config.working_hours.days.includes(idx);
                    return (
                      <button key={idx} onClick={() => setConfig(c => c && ({ ...c, working_hours: { ...c.working_hours, days: on ? c.working_hours.days.filter(x => x !== idx) : [...c.working_hours.days, idx].sort() } }))} className={`text-xs rounded-lg px-2.5 py-1 border ${on ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}>
                        {d}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="text-sm font-semibold text-[#2D1B0E] mb-2">Holidays</div>
                {config.holidays.map((h, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 mb-2">
                    <input type="date" value={h.date} onChange={e => setConfig(c => c && ({ ...c, holidays: c.holidays.map((x, j) => j === i ? { ...x, date: e.target.value } : x) }))} className="border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                    <input value={h.name} onChange={e => setConfig(c => c && ({ ...c, holidays: c.holidays.map((x, j) => j === i ? { ...x, name: e.target.value } : x) }))} placeholder="Holiday name" className="flex-1 min-w-[140px] border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                    <button onClick={() => setConfig(c => c && ({ ...c, holidays: c.holidays.filter((_, j) => j !== i) }))} className="p-1.5 rounded-lg text-[#8B7355] hover:text-red-600 hover:bg-red-50" title="Remove"><Trash2 size={14} /></button>
                  </div>
                ))}
                <button onClick={() => setConfig(c => c && ({ ...c, holidays: [...c.holidays, { date: '', name: '' }] }))} className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#6B5744] text-sm rounded-lg px-3 py-1.5">
                  <Plus size={14} /> Add holiday
                </button>
              </div>
              <button onClick={() => saveConfig({ working_hours: config.working_hours, holidays: config.holidays.filter(h => h.date) })} disabled={saving} className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-2 disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save Hours &amp; Holidays
              </button>
            </div>
          )}

          {/* ── Reminders ── */}
          {tab === 'reminders' && (
            <div className="space-y-3">
              <p className="text-xs text-[#8B7355]">How often auto-reminders fire for open tasks approaching or past their due date.</p>
              <div className="flex items-end gap-2">
                <div>
                  <label className="block text-[11px] text-[#8B7355] mb-1">Reminder interval (hours)</label>
                  <input type="number" min={1} max={720} value={config.reminder_interval_hours} onChange={e => setConfig(c => c && ({ ...c, reminder_interval_hours: Number(e.target.value) || 0 }))} className="w-36 border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                </div>
                <button onClick={() => saveConfig({ reminder_interval_hours: config.reminder_interval_hours })} disabled={saving} className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-1.5 disabled:opacity-50">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Recurring-rule create/edit modal */}
      {showRecForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setShowRecForm(false)}>
          <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl p-4 sm:p-5 space-y-3 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2">
                <GitBranch size={18} className="text-[#af4408]" /> {recForm.id ? 'Edit Recurring Rule' : 'New Recurring Rule'}
              </h2>
              <button onClick={() => setShowRecForm(false)} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={18} /></button>
            </div>
            {recModalError && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-2.5 py-1.5">
                <AlertCircle size={13} className="shrink-0" /> {recModalError}
              </div>
            )}
            <div className="space-y-2">
              <input type="text" placeholder="Rule title *" value={recForm.title}
                onChange={(e) => setRecForm(f => ({ ...f, title: e.target.value }))}
                className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
              <textarea placeholder="Description (optional)" value={recForm.description} rows={2}
                onChange={(e) => setRecForm(f => ({ ...f, description: e.target.value }))}
                className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-[#8B7355]">Category</label>
                  <select value={recForm.category} onChange={(e) => setRecForm(f => ({ ...f, category: e.target.value }))} className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                    {TASK_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-[#8B7355]">Department</label>
                  <select value={recForm.department} onChange={(e) => setRecForm(f => ({ ...f, department: e.target.value }))} className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                    <option value="">— None —</option>
                    {TASK_DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-[#8B7355]">Priority</label>
                  <select value={recForm.priority} onChange={(e) => setRecForm(f => ({ ...f, priority: e.target.value }))} className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                    {PRIORITY_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-[#8B7355]">Frequency</label>
                  <select value={recForm.frequency} onChange={(e) => setRecForm(f => ({ ...f, frequency: e.target.value as any }))} className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]">
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
              </div>
              {recForm.frequency === 'weekly' && (
                <div>
                  <label className="text-xs text-[#8B7355]">Day of week</label>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {DOW.map((d, idx) => (
                      <button key={idx} type="button" onClick={() => setRecForm(f => ({ ...f, day_of_week: idx }))}
                        className={`text-xs rounded-lg px-2.5 py-1 border ${recForm.day_of_week === idx ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}>
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {recForm.frequency === 'monthly' && (
                <div>
                  <label className="text-xs text-[#8B7355]">Day of month (1–31)</label>
                  <input type="number" min={1} max={31} value={recForm.day_of_month}
                    onChange={(e) => setRecForm(f => ({ ...f, day_of_month: Math.min(31, Math.max(1, Number(e.target.value) || 1)) }))}
                    className="w-24 border border-[#E8D5C4] rounded-lg px-2.5 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]" />
                </div>
              )}
              <div>
                <label className="text-xs text-[#8B7355]">Assignee (optional)</label>
                <UserPicker
                  value={recForm.assignee_email || undefined}
                  onPick={(u) => setRecForm(f => ({ ...f, assignee_email: u.email }))}
                  allowClear
                  onClear={() => setRecForm(f => ({ ...f, assignee_email: '' }))}
                  placeholder="Unassigned — leave as draft"
                />
              </div>
              <div>
                <label className="text-xs text-[#8B7355]">Next run date</label>
                <input type="date" value={recForm.next_run_date}
                  onChange={(e) => setRecForm(f => ({ ...f, next_run_date: e.target.value }))}
                  className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]" />
              </div>
              <div className="text-[11px] text-[#8B7355] bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-2.5 py-1.5">
                Fires next on <span className="font-semibold text-[#2D1B0E]">{recForm.next_run_date ? fmtDate(recForm.next_run_date) : '—'}</span>,
                then <span className="font-semibold text-[#2D1B0E]">{fmtDate(previewNextRun(recForm))}</span>.
              </div>
              <label className="flex items-center gap-2 text-sm text-[#2D1B0E]">
                <input type="checkbox" checked={!!recForm.is_active} onChange={(e) => setRecForm(f => ({ ...f, is_active: e.target.checked ? 1 : 0 }))} className="accent-[#af4408]" />
                Active
              </label>
            </div>
            <button onClick={saveRule} disabled={recSaving || !recForm.title.trim()} className="w-full inline-flex items-center justify-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm font-semibold rounded-lg px-3 py-2.5 disabled:opacity-50">
              {recSaving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {recForm.id ? 'Save changes' : 'Create rule'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
