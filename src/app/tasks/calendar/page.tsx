'use client';

/**
 * Task Management — Calendar (/tasks/calendar)
 *
 * Day / Week / Month planning surface over every dated Task-Management entity
 * (tasks, maintenance schedules, training sessions, hygiene audits, knowledge
 * tests) served by /api/tasks/calendar. Grids are built from native Date — no
 * calendar library. Items are colour-coded by type, filterable by type chip,
 * and clicking one navigates to its section page.
 *
 * Gate: any signed-in user (planning surface, not cross-employee sensitive).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, CalendarClock, ChevronLeft, ChevronRight, Loader2, RefreshCw,
  Wrench, GraduationCap, SprayCan, Brain, ClipboardList,
  X, ExternalLink, Play, Pause, CheckCircle2, RotateCcw, Ban, User, AlertTriangle,
} from 'lucide-react';
import { statusMeta, priorityMeta, canManageTasks } from '@/lib/tasks';
import { api } from '@/lib/api';

/* ── date helpers (local calendar days) ───────────────────────────────── */

function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseISO(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfWeek(d: Date): Date {
  // Monday-first week.
  const x = new Date(d);
  const dow = (x.getDay() + 6) % 7; // 0 = Mon
  return addDays(x, -dow);
}
function startOfMonthGrid(d: Date): Date {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  return startOfWeek(first);
}
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* ── type visuals ─────────────────────────────────────────────────────── */

type ViewMode = 'month' | 'week' | 'day';

const TYPE_META: Record<string, { label: string; icon: any; dot: string; chip: string; bar: string }> = {
  task: { label: 'Tasks', icon: ClipboardList, dot: 'bg-[#af4408]', chip: 'bg-[#af4408]', bar: 'bg-[#af4408]/10 border-[#af4408]/30 text-[#7a3105]' },
  maintenance: { label: 'Maintenance', icon: Wrench, dot: 'bg-amber-500', chip: 'bg-amber-500', bar: 'bg-amber-50 border-amber-300 text-amber-800' },
  training: { label: 'Training', icon: GraduationCap, dot: 'bg-indigo-500', chip: 'bg-indigo-500', bar: 'bg-indigo-50 border-indigo-300 text-indigo-800' },
  hygiene: { label: 'Hygiene', icon: SprayCan, dot: 'bg-emerald-500', chip: 'bg-emerald-500', bar: 'bg-emerald-50 border-emerald-300 text-emerald-800' },
  knowledge: { label: 'Knowledge', icon: Brain, dot: 'bg-purple-500', chip: 'bg-purple-500', bar: 'bg-purple-50 border-purple-300 text-purple-800' },
};
const TYPE_ORDER = ['task', 'maintenance', 'training', 'hygiene', 'knowledge'];
function typeMeta(t: string) {
  return TYPE_META[t] || { label: t, icon: ClipboardList, dot: 'bg-gray-400', chip: 'bg-gray-400', bar: 'bg-gray-50 border-gray-300 text-gray-700' };
}

/* ── page ─────────────────────────────────────────────────────────────── */

export default function TaskCalendarPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined);

  const [view, setView] = useState<ViewMode>('month');
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [activeTypes, setActiveTypes] = useState<Set<string>>(() => new Set(TYPE_ORDER));

  const [items, setItems] = useState<any[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Task-detail drawer (Phase 2). Clicking any calendar item opens it; task
  // items additionally expose quick status actions that PATCH /api/tasks/:id.
  const [selected, setSelected] = useState<any>(null);
  const [savingTo, setSavingTo] = useState<string | null>(null);
  const [drawerErr, setDrawerErr] = useState<string | null>(null);

  const openItem = useCallback((it: any) => {
    setDrawerErr(null);
    setSelected(it);
  }, []);

  const changeStatus = useCallback(async (to: string) => {
    if (!selected || selected.type !== 'task') return;
    setSavingTo(to);
    setDrawerErr(null);
    try {
      const res = await api(`/api/tasks/${encodeURIComponent(selected.id)}`, { method: 'PATCH', body: { status: to } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      // Reflect the new status locally (drawer + grid) without a full refetch.
      setSelected((s: any) => (s ? { ...s, status: to } : s));
      setItems((prev) => prev.map((x) => (x.type === 'task' && x.id === selected.id ? { ...x, status: to } : x)));
    } catch (e: any) {
      setDrawerErr(e?.message || 'Failed to update status');
    } finally {
      setSavingTo(null);
    }
  }, [selected]);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  // Visible range depends on the view.
  const range = useMemo(() => {
    if (view === 'day') return { from: iso(anchor), to: iso(anchor), days: [anchor] };
    if (view === 'week') {
      const start = startOfWeek(anchor);
      const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
      return { from: iso(start), to: iso(addDays(start, 6)), days };
    }
    // month grid: 6 weeks
    const start = startOfMonthGrid(anchor);
    const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
    return { from: iso(start), to: iso(days[41]), days };
  }, [view, anchor]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ from: range.from, to: range.to });
      const res = await fetch(`/api/tasks/calendar?${qs}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setItems(j.items || []);
      setCounts(j.counts || {});
    } catch (e: any) {
      setError(e?.message || 'Failed to load calendar');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    if (me) load();
  }, [me, load]);

  // Group items by date, respecting the type filter.
  const byDate = useMemo(() => {
    const m: Record<string, any[]> = {};
    for (const it of items) {
      if (!activeTypes.has(it.type)) continue;
      (m[it.date] ||= []).push(it);
    }
    return m;
  }, [items, activeTypes]);

  const toggleType = (t: string) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const step = (dir: 1 | -1) => {
    if (view === 'day') setAnchor((a) => addDays(a, dir));
    else if (view === 'week') setAnchor((a) => addDays(a, dir * 7));
    else setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + dir, 1));
  };

  const heading = useMemo(() => {
    if (view === 'day') return anchor.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (view === 'week') {
      const s = startOfWeek(anchor);
      const e = addDays(s, 6);
      return `${s.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${e.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    return `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;
  }, [view, anchor]);

  const todayStr = iso(new Date());

  if (me === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FFF8F0]">
        <Loader2 className="w-6 h-6 animate-spin text-[#af4408]" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {/* Back */}
        <button onClick={() => router.back()} className="inline-flex items-center gap-1.5 text-sm text-[#8B7355] hover:text-[#af4408] transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-[#af4408]/10 text-[#af4408]">
              <CalendarClock className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[#2D1B0E]">Task Calendar</h1>
              <p className="text-sm text-[#8B7355] mt-0.5">Tasks, maintenance, training, hygiene audits and tests on one timeline.</p>
            </div>
          </div>
          <button onClick={load} className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg text-sm font-medium self-start">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {/* Controls */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            <button onClick={() => step(-1)} className="p-2 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3]" aria-label="Previous">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button onClick={() => setAnchor(new Date())} className="px-3 py-2 rounded-lg border border-[#E8D5C4] text-sm hover:bg-[#FFF1E3]">Today</button>
            <button onClick={() => step(1)} className="p-2 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3]" aria-label="Next">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="text-base font-semibold text-[#2D1B0E] min-w-[180px]">{heading}</div>

          <div className="flex gap-1 bg-[#FFF1E3] rounded-lg p-1 ml-auto">
            {(['month', 'week', 'day'] as ViewMode[]).map((v) => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${view === v ? 'bg-[#af4408] text-white' : 'text-[#8B7355] hover:text-[#2D1B0E]'}`}>
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-[#8B7355]">Jump</label>
            <input type="date" value={iso(anchor)} onChange={(e) => e.target.value && setAnchor(parseISO(e.target.value))}
              className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:border-[#af4408]" />
          </div>
        </div>

        {/* Type filter legend */}
        <div className="flex flex-wrap gap-2">
          {TYPE_ORDER.map((t) => {
            const meta = typeMeta(t);
            const on = activeTypes.has(t);
            const Icon = meta.icon;
            return (
              <button key={t} onClick={() => toggleType(t)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors ${
                  on ? 'bg-white border-[#E8D5C4] text-[#2D1B0E]' : 'bg-[#FFF1E3]/50 border-[#E8D5C4] text-[#8B7355] opacity-60'
                }`}>
                <span className={`w-2.5 h-2.5 rounded-full ${meta.dot}`} />
                <Icon className="w-3.5 h-3.5" /> {meta.label}
                <span className="text-[10px] text-[#8B7355]">({counts[t] || 0})</span>
              </button>
            );
          })}
        </div>

        {/* Grid */}
        {loading ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-16 flex flex-col items-center gap-3">
            <Loader2 className="w-7 h-7 animate-spin text-[#af4408]" />
            <p className="text-sm text-[#8B7355]">Loading calendar…</p>
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
            <p className="text-sm text-red-700">{error}</p>
            <button onClick={load} className="mt-3 px-4 py-2 bg-white border border-[#E8D5C4] rounded-lg text-sm hover:bg-[#FFF1E3]">Retry</button>
          </div>
        ) : view === 'month' ? (
          <MonthGrid days={range.days} anchorMonth={anchor.getMonth()} byDate={byDate} today={todayStr} onItem={openItem} onDay={(d) => { setAnchor(d); setView('day'); }} />
        ) : view === 'week' ? (
          <WeekGrid days={range.days} byDate={byDate} today={todayStr} onItem={openItem} onDay={(d) => { setAnchor(d); setView('day'); }} />
        ) : (
          <DayList day={anchor} items={byDate[iso(anchor)] || []} onItem={openItem} />
        )}
      </div>

      {selected && (
        <ItemDrawer
          it={selected}
          me={me}
          savingTo={savingTo}
          error={drawerErr}
          onClose={() => setSelected(null)}
          onStatus={changeStatus}
          onOpen={(href: string) => router.push(href)}
        />
      )}
    </div>
  );
}

/* ── task-detail drawer ───────────────────────────────────────────────── */

// Quick status actions offered inside the drawer, keyed by target status.
const QUICK_ACTIONS: { to: string; label: string; icon: any; manager?: boolean }[] = [
  { to: 'in_progress', label: 'Start', icon: Play },
  { to: 'on_hold', label: 'Hold', icon: Pause },
  { to: 'waiting_verification', label: 'For Review', icon: CheckCircle2 },
  { to: 'completed', label: 'Complete', icon: CheckCircle2 },
  { to: 'approved', label: 'Approve', icon: CheckCircle2, manager: true },
  { to: 'reopened', label: 'Reopen', icon: RotateCcw, manager: true },
  { to: 'cancelled', label: 'Cancel', icon: Ban, manager: true },
];

function ItemDrawer({ it, me, savingTo, error, onClose, onStatus, onOpen }: {
  it: any; me: any; savingTo: string | null; error: string | null;
  onClose: () => void; onStatus: (to: string) => void; onOpen: (href: string) => void;
}) {
  const meta = typeMeta(it.type);
  const Icon = meta.icon;
  const isTask = it.type === 'task';
  const sm = statusMeta(it.status);
  const pm = priorityMeta(it.priority);
  const manager = canManageTasks(me);
  const dateLabel = (() => {
    try { return parseISO(it.date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }); }
    catch { return it.date; }
  })();

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      {/* panel */}
      <div className="relative w-full max-w-md bg-white h-full shadow-xl border-l border-[#E8D5C4] flex flex-col animate-[slideIn_.15s_ease-out]">
        <div className="flex items-start justify-between gap-3 p-4 border-b border-[#E8D5C4]">
          <div className="flex items-start gap-3 min-w-0">
            <span className={`p-2 rounded-lg text-white shrink-0 ${meta.chip}`}><Icon className="w-4 h-4" /></span>
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-[#8B7355]">{meta.label}</div>
              <h3 className="text-base font-semibold text-[#2D1B0E] break-words">{it.title}</h3>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#FFF1E3] text-[#8B7355] shrink-0" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {/* meta rows */}
          <div className="space-y-2.5 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#8B7355] w-20 shrink-0">Status</span>
              {isTask
                ? <span className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded-full border ${sm.color}`}>{sm.label}</span>
                : <span className="text-[#2D1B0E] capitalize">{String(it.status || '—').replace(/_/g, ' ')}</span>}
            </div>
            {isTask && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[#8B7355] w-20 shrink-0">Priority</span>
                <span className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded-full border ${pm.color}`}>{pm.label}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#8B7355] w-20 shrink-0">{isTask ? 'Due' : 'Date'}</span>
              <span className="text-[#2D1B0E] flex items-center gap-1.5">
                <CalendarClock className="w-3.5 h-3.5 text-[#8B7355]" />{dateLabel}{it.time ? <span className="font-mono text-xs text-[#8B7355]">· {it.time}</span> : null}
              </span>
            </div>
            {it.assignee_name && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[#8B7355] w-20 shrink-0">Assignee</span>
                <span className="text-[#2D1B0E] flex items-center gap-1.5"><User className="w-3.5 h-3.5 text-[#8B7355]" />{it.assignee_name}</span>
              </div>
            )}
            {it.department && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[#8B7355] w-20 shrink-0">Department</span>
                <span className="text-[#2D1B0E]">{it.department}</span>
              </div>
            )}
            {it.meta && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[#8B7355] w-20 shrink-0">Detail</span>
                <span className="text-[#2D1B0E]">{it.meta}</span>
              </div>
            )}
          </div>

          {/* quick status actions (tasks only) */}
          {isTask && (
            <div className="border-t border-[#E8D5C4] pt-4">
              <div className="text-xs font-medium text-[#8B7355] mb-2">Quick actions</div>
              {error && (
                <div className="mb-2 flex items-start gap-1.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{error}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {QUICK_ACTIONS.filter((a) => (a.manager ? manager : true) && a.to !== it.status).map((a) => {
                  const AI = a.icon;
                  const busy = savingTo === a.to;
                  return (
                    <button key={a.to} onClick={() => onStatus(a.to)} disabled={!!savingTo}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-[#E8D5C4] bg-white text-[#2D1B0E] hover:bg-[#FFF1E3] disabled:opacity-50 transition-colors">
                      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AI className="w-3.5 h-3.5" />} {a.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-[#E8D5C4]">
          <button onClick={() => onOpen(it.href)}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg text-sm font-medium transition-colors">
            <ExternalLink className="w-4 h-4" /> {isTask ? 'Open in board' : `Open ${meta.label}`}
          </button>
        </div>
      </div>
      <style>{`@keyframes slideIn{from{transform:translateX(16px);opacity:.6}to{transform:translateX(0);opacity:1}}`}</style>
    </div>
  );
}

/* ── event chip ───────────────────────────────────────────────────────── */

function EventChip({ it, onItem, compact }: { it: any; onItem: (it: any) => void; compact?: boolean }) {
  const meta = typeMeta(it.type);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onItem(it); }}
      title={`${meta.label}: ${it.title}${it.assignee_name ? ' · ' + it.assignee_name : ''}`}
      className={`w-full text-left rounded border px-1.5 py-0.5 truncate transition-colors hover:brightness-95 ${meta.bar} ${compact ? 'text-[10px]' : 'text-xs'}`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${meta.dot} mr-1 align-middle`} />
      {it.time ? <span className="font-mono mr-1">{it.time}</span> : null}
      {it.title}
    </button>
  );
}

/* ── month grid ───────────────────────────────────────────────────────── */

function MonthGrid({ days, anchorMonth, byDate, today, onItem, onDay }: {
  days: Date[]; anchorMonth: number; byDate: Record<string, any[]>; today: string;
  onItem: (it: any) => void; onDay: (d: Date) => void;
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
      <div className="grid grid-cols-7 border-b border-[#E8D5C4] bg-[#FFF1E3] text-xs font-medium text-[#8B7355]">
        {WEEKDAYS.map((w) => <div key={w} className="py-2 px-2 text-center">{w}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d, i) => {
          const ds = iso(d);
          const inMonth = d.getMonth() === anchorMonth;
          const dayItems = byDate[ds] || [];
          const isToday = ds === today;
          return (
            <div key={i}
              onClick={() => onDay(d)}
              className={`min-h-[96px] border-b border-r border-[#E8D5C4]/60 p-1.5 cursor-pointer transition-colors hover:bg-[#FFF1E3]/40 ${inMonth ? '' : 'bg-[#FFF8F0]/60'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className={`text-xs w-6 h-6 flex items-center justify-center rounded-full ${
                  isToday ? 'bg-[#af4408] text-white font-semibold' : inMonth ? 'text-[#2D1B0E]' : 'text-[#8B7355]'
                }`}>{d.getDate()}</span>
                {dayItems.length > 0 && <span className="text-[10px] text-[#8B7355]">{dayItems.length}</span>}
              </div>
              <div className="space-y-0.5">
                {dayItems.slice(0, 3).map((it) => <EventChip key={it.type + it.id} it={it} onItem={onItem} compact />)}
                {dayItems.length > 3 && (
                  <div className="text-[10px] text-[#af4408] px-1">+{dayItems.length - 3} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── week grid ────────────────────────────────────────────────────────── */

function WeekGrid({ days, byDate, today, onItem, onDay }: {
  days: Date[]; byDate: Record<string, any[]>; today: string;
  onItem: (it: any) => void; onDay: (d: Date) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-7 gap-2">
      {days.map((d, i) => {
        const ds = iso(d);
        const dayItems = byDate[ds] || [];
        const isToday = ds === today;
        return (
          <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-2 min-h-[160px] flex flex-col">
            <button onClick={() => onDay(d)} className={`text-left mb-2 pb-1 border-b border-[#E8D5C4]/60 ${isToday ? 'text-[#af4408]' : 'text-[#2D1B0E]'}`}>
              <div className="text-[10px] uppercase text-[#8B7355]">{WEEKDAYS[i]}</div>
              <div className="text-sm font-semibold">{d.getDate()} {d.toLocaleDateString('en-IN', { month: 'short' })}</div>
            </button>
            <div className="space-y-1 flex-1">
              {dayItems.length ? dayItems.map((it) => <EventChip key={it.type + it.id} it={it} onItem={onItem} />)
                : <p className="text-[10px] text-[#8B7355] text-center mt-4">—</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── day list ─────────────────────────────────────────────────────────── */

function DayList({ day, items, onItem }: { day: Date; items: any[]; onItem: (it: any) => void }) {
  const sorted = [...items].sort((a, b) => (a.time || '').localeCompare(b.time || '') || a.type.localeCompare(b.type));
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
      <h3 className="text-sm font-semibold text-[#2D1B0E] mb-3">
        {day.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
        <span className="ml-2 text-xs font-normal text-[#8B7355]">{sorted.length} item{sorted.length === 1 ? '' : 's'}</span>
      </h3>
      {sorted.length === 0 ? (
        <p className="text-sm text-[#8B7355] text-center py-10">Nothing scheduled on this day.</p>
      ) : (
        <ul className="space-y-2">
          {sorted.map((it) => {
            const meta = typeMeta(it.type);
            const Icon = meta.icon;
            const sm = statusMeta(it.status);
            return (
              <li key={it.type + it.id}>
                <button onClick={() => onItem(it)} className="w-full flex items-center gap-3 p-3 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3]/50 transition-colors text-left">
                  <span className={`p-2 rounded-lg text-white ${meta.chip}`}><Icon className="w-4 h-4" /></span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-[#2D1B0E] truncate">{it.title}</span>
                      {it.time && <span className="text-xs font-mono text-[#8B7355]">{it.time}</span>}
                    </div>
                    <div className="text-xs text-[#8B7355] flex items-center gap-2 flex-wrap mt-0.5">
                      <span>{meta.label}</span>
                      {it.department && <><span>·</span><span>{it.department}</span></>}
                      {it.assignee_name && <><span>·</span><span>{it.assignee_name}</span></>}
                      {it.meta && <><span>·</span><span>{it.meta}</span></>}
                    </div>
                  </div>
                  {it.type === 'task' && (
                    <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 ${sm.color}`}>{sm.label}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
