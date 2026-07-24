'use client';

/**
 * Settings manager for the GRE "What's On" board's Specials, Workshops & Notices
 * (ct_specials). A central place to add/edit/delete the per-date heading+details
 * cards the board shows — either RECURRING on a weekday (e.g. "Every Sunday:
 * Sushi Workshop") or a ONE-OFF on a date. Mirrors the board's inline editor but
 * lets you see & manage every entry at once regardless of the date on screen.
 *
 * Reads GET /api/crm-calls/specials (any signed-in user); writes go through
 * POST/PUT/DELETE /api/crm-calls/specials[...] which are management-gated.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { todayIST } from '@/lib/format-date';
import { Plus, Pencil, Trash2, X, CalendarClock, CalendarDays } from 'lucide-react';

interface Special {
  id: string;
  scope: 'weekday' | 'date';
  weekday: number;
  event_date: string;
  category: string;
  title: string;
  details: string;
  start_time: string;
  end_time: string;
  active: number;
}

interface SForm {
  scope: 'weekday' | 'date';
  weekday: number;
  event_date: string;
  category: string;
  title: string;
  details: string;
  start_time: string;
  end_time: string;
}

const WEEKDAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CATEGORIES: { value: string; label: string }[] = [
  { value: 'special', label: 'Special' },
  { value: 'offer', label: 'Offer' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'event', label: 'Event' },
  { value: 'notice', label: 'Notice' },
  { value: 'vip', label: 'VIP' },
];
function catChip(cat: string): { label: string; cls: string } {
  switch ((cat || '').toLowerCase()) {
    case 'offer': return { label: 'Offer', cls: 'bg-rose-50 text-rose-700 border-rose-200' };
    case 'workshop': return { label: 'Workshop', cls: 'bg-violet-50 text-violet-700 border-violet-200' };
    case 'event': return { label: 'Event', cls: 'bg-blue-50 text-blue-700 border-blue-200' };
    case 'notice': return { label: 'Notice', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
    case 'vip': return { label: 'VIP', cls: 'bg-purple-50 text-purple-700 border-purple-200' };
    default: return { label: 'Special', cls: 'bg-amber-50 text-amber-700 border-amber-200' };
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function labelDate(iso: string): string {
  const [y, m, d] = (iso || '').split('-').map(Number);
  if (!y || !m || !d) return iso || '—';
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}
function timeRange(s: string, e: string): string {
  const a = (s || '').trim(); const b = (e || '').trim();
  if (a && b) return `${a} – ${b}`;
  return a || b || '';
}

const emptyForm = (): SForm => ({ scope: 'weekday', weekday: 0, event_date: todayIST(), category: 'special', title: '', details: '', start_time: '', end_time: '' });

export default function SpecialsManager() {
  const [items, setItems] = useState<Special[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<SForm>(emptyForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<SForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/crm-calls/specials');
      if (res.ok) {
        const j = await res.json();
        setItems(Array.isArray(j?.specials) ? j.specials : []);
      }
    } catch { /* leave list as-is */ }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function toBody(f: SForm) {
    const common = {
      category: f.category,
      title: f.title.trim(),
      details: f.details.trim(),
      start_time: f.start_time.trim(),
      end_time: f.end_time.trim(),
    };
    return f.scope === 'date'
      ? { scope: 'date' as const, event_date: f.event_date, ...common }
      : { scope: 'weekday' as const, weekday: f.weekday, ...common };
  }

  async function create() {
    if (!addForm.title.trim()) { setError('Title is required.'); return; }
    setSaving(true); setError('');
    try {
      const res = await api('/api/crm-calls/specials', { method: 'POST', body: toBody(addForm) });
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error || 'Could not add.'); return; }
      setShowAdd(false); setAddForm(emptyForm()); await load();
    } catch { setError('Network error — please try again.'); }
    finally { setSaving(false); }
  }

  function startEdit(s: Special) {
    setShowAdd(false);
    setEditingId(s.id);
    setError('');
    setEditForm({
      scope: s.scope,
      weekday: s.weekday >= 0 && s.weekday <= 6 ? s.weekday : 0,
      event_date: s.event_date || todayIST(),
      category: s.category || 'special',
      title: s.title,
      details: s.details,
      start_time: s.start_time,
      end_time: s.end_time,
    });
  }

  async function saveEdit(id: string) {
    if (!editForm.title.trim()) { setError('Title is required.'); return; }
    setSaving(true); setError('');
    try {
      const res = await api(`/api/crm-calls/specials/${id}`, { method: 'PUT', body: toBody(editForm) });
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error || 'Could not save.'); return; }
      setEditingId(null); await load();
    } catch { setError('Network error — please try again.'); }
    finally { setSaving(false); }
  }

  async function del(id: string) {
    if (typeof window !== 'undefined' && !window.confirm('Remove this entry from the board?')) return;
    setSaving(true);
    try {
      const res = await api(`/api/crm-calls/specials/${id}`, { method: 'DELETE' });
      if (res.ok) await load();
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }

  const recurring = items.filter(s => s.scope === 'weekday');
  const dated = items.filter(s => s.scope === 'date');

  return (
    <div className="border-t border-[#E8D5C4]/60 pt-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <label className="block text-xs font-semibold text-[#2D1B0E]">Specials, Workshops &amp; Notices</label>
          <p className="text-[10px] text-[#6B5744] mt-0.5">
            Titled cards with details shown on the board for the dates they match — recurring weekly
            (e.g. <strong>Every Sunday: Sushi Workshop</strong>) or a one-off date.
          </p>
        </div>
        {!showAdd && !editingId && (
          <button
            onClick={() => { setAddForm(emptyForm()); setShowAdd(true); setError(''); }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white transition-colors shrink-0"
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        )}
      </div>

      {showAdd && (
        <SEditor form={addForm} setForm={setAddForm} onSave={create} onCancel={() => { setShowAdd(false); setError(''); }} saving={saving} error={error} submitLabel="Add to board" />
      )}

      <div className="mt-3 space-y-3">
        {loading ? (
          <p className="text-xs text-[#8B7355]">Loading…</p>
        ) : items.length === 0 && !showAdd ? (
          <p className="text-xs text-[#8B7355] italic">Nothing added yet. Click <strong>Add</strong> to create your first Sunday workshop or special.</p>
        ) : (
          <>
            {recurring.length > 0 && (
              <Group icon={<CalendarClock className="w-3.5 h-3.5" />} title="Recurring weekly">
                {recurring.map(s => editingId === s.id ? (
                  <SEditor key={s.id} form={editForm} setForm={setEditForm} onSave={() => saveEdit(s.id)} onCancel={() => { setEditingId(null); setError(''); }} saving={saving} error={error} submitLabel="Save" />
                ) : (
                  <Row key={s.id} s={s} schedule={`Every ${WEEKDAYS_FULL[s.weekday] || '—'}`} onEdit={() => startEdit(s)} onDelete={() => del(s.id)} saving={saving} />
                ))}
              </Group>
            )}
            {dated.length > 0 && (
              <Group icon={<CalendarDays className="w-3.5 h-3.5" />} title="One-off dates">
                {dated.map(s => editingId === s.id ? (
                  <SEditor key={s.id} form={editForm} setForm={setEditForm} onSave={() => saveEdit(s.id)} onCancel={() => { setEditingId(null); setError(''); }} saving={saving} error={error} submitLabel="Save" />
                ) : (
                  <Row key={s.id} s={s} schedule={labelDate(s.event_date)} onEdit={() => startEdit(s)} onDelete={() => del(s.id)} saving={saving} />
                ))}
              </Group>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Group({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-[#8B7355] uppercase tracking-wide flex items-center gap-1 mb-1.5">
        <span className="text-[#af4408]">{icon}</span>{title}
      </p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({ s, schedule, onEdit, onDelete, saving }: {
  s: Special; schedule: string; onEdit: () => void; onDelete: () => void; saving: boolean;
}) {
  const chip = catChip(s.category);
  return (
    <div className="flex items-start gap-2 border border-[#E8D5C4] rounded-lg bg-[#FFFDFB] px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-[#2D1B0E] truncate">{s.title}</span>
          <span className={`text-[10px] font-semibold uppercase tracking-wide border rounded px-1.5 py-0.5 ${chip.cls}`}>{chip.label}</span>
        </div>
        <p className="text-[11px] text-[#6B5744] mt-0.5">
          {schedule}{timeRange(s.start_time, s.end_time) ? ` · ${timeRange(s.start_time, s.end_time)}` : ''}
        </p>
        {s.details && <p className="text-[11px] text-[#8B7355] mt-0.5 line-clamp-2 whitespace-pre-line">{s.details}</p>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button onClick={onEdit} className="p-1.5 rounded-lg text-[#8B7355] hover:text-[#af4408] hover:bg-[#FFF1E3] transition-colors" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
        <button onClick={onDelete} disabled={saving} className="p-1.5 rounded-lg text-[#8B7355] hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  );
}

function SEditor({ form, setForm, onSave, onCancel, saving, error, submitLabel }: {
  form: SForm;
  setForm: (updater: (f: SForm) => SForm) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string;
  submitLabel: string;
}) {
  const inputCls = 'w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm text-[#2D1B0E] outline-none focus:border-[#af4408]';
  const lblCls = 'text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide';
  return (
    <div className="mt-2 p-3 rounded-xl border border-[#E8D5C4] bg-[#FFFBF5]">
      {/* Category */}
      <div className="mb-3">
        <span className={lblCls}>Type</span>
        <div className="flex flex-wrap gap-1.5 mt-1">
          {CATEGORIES.map(c => (
            <button
              key={c.value}
              type="button"
              onClick={() => setForm(f => ({ ...f, category: c.value }))}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                form.category === c.value ? 'bg-[#af4408] text-white border-[#903905]' : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
              }`}
            >{c.label}</button>
          ))}
        </div>
      </div>

      {/* Scope */}
      <div className="flex flex-wrap gap-2 mb-3">
        <button type="button" onClick={() => setForm(f => ({ ...f, scope: 'weekday' }))}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${form.scope === 'weekday' ? 'bg-[#af4408] text-white border-[#903905]' : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'}`}>
          Every week
        </button>
        <button type="button" onClick={() => setForm(f => ({ ...f, scope: 'date' }))}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${form.scope === 'date' ? 'bg-[#af4408] text-white border-[#903905]' : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'}`}>
          One-off date
        </button>
      </div>

      <div className="grid sm:grid-cols-2 gap-2.5">
        {form.scope === 'weekday' ? (
          <label className="block">
            <span className={lblCls}>Repeats on</span>
            <select value={form.weekday} onChange={e => setForm(f => ({ ...f, weekday: Number(e.target.value) }))} className={inputCls + ' mt-1'}>
              {WEEKDAYS_FULL.map((w, i) => <option key={i} value={i}>Every {w}</option>)}
            </select>
          </label>
        ) : (
          <label className="block">
            <span className={lblCls}>On date</span>
            <input type="date" value={form.event_date} onChange={e => e.target.value && setForm(f => ({ ...f, event_date: e.target.value }))} className={inputCls + ' mt-1'} />
          </label>
        )}
        <label className="block">
          <span className={lblCls}>Title</span>
          <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} maxLength={120} placeholder="e.g. Sushi Workshop" className={inputCls + ' mt-1'} />
        </label>
        <label className="block">
          <span className={lblCls}>Start time</span>
          <input value={form.start_time} onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))} maxLength={20} placeholder="12:00" className={inputCls + ' mt-1'} />
        </label>
        <label className="block">
          <span className={lblCls}>End time</span>
          <input value={form.end_time} onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))} maxLength={20} placeholder="16:00" className={inputCls + ' mt-1'} />
        </label>
        <label className="block sm:col-span-2">
          <span className={lblCls}>Details</span>
          <textarea value={form.details} onChange={e => setForm(f => ({ ...f, details: e.target.value }))} maxLength={2000} rows={3} placeholder="Menu highlights, price, what's included…" className={inputCls + ' mt-1 resize-y'} />
        </label>
      </div>
      {error && <p className="mt-2 text-xs font-medium text-red-500">{error}</p>}
      <div className="flex items-center gap-2 mt-3">
        <button onClick={onSave} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white transition-colors disabled:opacity-50">
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button onClick={onCancel} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium text-[#6B5744] hover:bg-[#FFF1E3] transition-colors disabled:opacity-50 inline-flex items-center gap-1">
          <X className="w-3.5 h-3.5" /> Cancel
        </button>
      </div>
    </div>
  );
}
