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
  GitBranch, Layers, Loader2, Plus, RefreshCw, RotateCcw, Save, Settings2, Tag,
  Trash2, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { TASK_PRIORITIES } from '@/lib/tasks';

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
}
interface SettingsPayload {
  categories: Category[];
  priorities: PriorityCfg[];
  config: Config;
  recurring: { rules: any[]; rule_count: number; maintenance_count: number };
}
interface Dept { id: string; name: string; code: string; is_active: number }

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

  const allowed = !!me && me.role === 'admin';

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user ?? null)).catch(() => setMe(null));
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
      })
      .catch(e => setError(e?.message || 'Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

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
      if (j.config) { setData(j); setConfig(j.config); setPriorities(j.priorities || []); }
      flash('Saved');
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
              <button onClick={() => saveConfig({ notification_rules: config.notification_rules, escalation_matrix: config.escalation_matrix })} disabled={saving} className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-2 disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save Notifications &amp; Escalation
              </button>
            </div>
          )}

          {/* ── Recurring ── */}
          {tab === 'recurring' && (
            <div className="space-y-3">
              <p className="text-xs text-[#8B7355]">Recurring task rules &amp; maintenance schedules that auto-generate tasks. Create and edit rules on their dedicated pages.</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
                  <div className="text-2xl font-bold text-[#af4408]">{data.recurring.rule_count}</div>
                  <div className="text-xs text-[#8B7355]">Active recurring rules</div>
                </div>
                <button onClick={() => router.push('/tasks/maintenance')} className="bg-[#FFF8F0] border border-[#E8D5C4] hover:border-[#af4408] rounded-lg p-3 text-left">
                  <div className="text-2xl font-bold text-[#af4408]">{data.recurring.maintenance_count}</div>
                  <div className="text-xs text-[#8B7355]">Maintenance schedules →</div>
                </button>
              </div>
              {data.recurring.rules.length > 0 && (
                <div className="divide-y divide-[#F0E4D6] border border-[#E8D5C4] rounded-lg overflow-hidden">
                  {data.recurring.rules.map((r: any) => (
                    <div key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                      <span className="font-medium text-[#2D1B0E] flex-1 min-w-[120px] truncate">{r.title}</span>
                      <span className="text-xs text-[#8B7355]">{r.frequency}</span>
                      {r.department && <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#FFF1E3] border border-[#E8D5C4] text-[#8a3606]">{r.department}</span>}
                      {r.next_run_date && <span className="text-xs text-[#6B5744]">next {r.next_run_date}</span>}
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
    </div>
  );
}
