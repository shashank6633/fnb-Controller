'use client';

/**
 * GRE "What's On" board (/crm-calls/whats-on)
 *
 * A single day-at-a-glance board a GRE keeps open while working the phones:
 * what's playing tonight (entertainment), which parties/reservations are on the
 * book, the day's specials/talking-points, a covers-vs-capacity gauge, and a
 * live caller-context strip. Everything hangs off ONE aggregated read
 * (GET /api/crm-calls/whats-on?date=) whose panels{} flags decide what shows.
 *
 * Managers (admin/manager/HOD) get inline add/edit/delete for the calendar
 * entertainment rows (source==='calendar'); party-derived rows are read-only.
 * The call-context strip polls /api/crm-calls/live so a ringing caller pops
 * without a page refresh.
 *
 * Style mirrors /crm-calls (page.tsx): cream board, white cards, #af4408 accent,
 * lucide icons, api() for writes, plain fetch for reads.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { todayIST } from '@/lib/format-date';
import { formatPhone } from '@/lib/ct/phone';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Disc3,
  Gauge,
  Gift,
  GraduationCap,
  Megaphone,
  Mic2,
  Music,
  PartyPopper,
  Pencil,
  Percent,
  Phone,
  PhoneCall,
  Plus,
  Sparkles,
  Star,
  Ticket,
  Trash2,
  Users,
  X,
  RefreshCw,
} from 'lucide-react';

// ─── API shapes (mirror src/lib/ct/whats-on.ts response) ─────────────────────

type EntType = 'band' | 'dj' | 'live_music' | 'event' | 'offer' | 'other';

interface Panels {
  entertainment: boolean;
  parties: boolean;
  reservations: boolean;
  specials: boolean;
  capacity: boolean;
  call_context: boolean;
}
interface EntRow {
  id: string;
  source: 'calendar' | 'party';
  type: EntType;
  name: string;
  start_time: string;
  end_time: string;
  area: string;
  description: string;
}
interface PartyRow {
  fp_id: string;
  name: string;
  guest_name: string;
  phone: string;
  pax: number;
  area: string;
  package: string;
  time: string;
  status: string;
  company: string;
  place: string;
  handled_by: string;
  occasion: string;
  special_requirements: string;
}
interface PartyStatusCounts {
  confirmed: number; enquiry: number; tentative: number;
  completed: number; cancelled: number; other: number;
}
interface ReservationRow {
  id: string;
  slot_time: string;
  guest_name: string;
  guest_phone: string;
  party_size: number;
  occasion: string;
  section_pref: string;
  status: string;
  table_id: string | null;
}
interface SpecialItem {
  id: string;
  scope: 'weekday' | 'date';
  weekday: number;
  event_date: string;
  category: string;
  title: string;
  details: string;
  start_time: string;
  end_time: string;
  recurring_label: string;
}
interface CapacityBlock {
  capacity: number;
  reserved_covers: number;
  party_pax: number;
  total: number;
  pct: number;
}
interface Summary {
  entertainment_count: number;
  parties_count: number;
  party_pax: number;
  reservations_count: number;
  reserved_covers: number;
}
interface WhatsOn {
  date: string;
  panels: Panels;
  entertainment: EntRow[];
  parties: PartyRow[];
  reservations: ReservationRow[];
  specials: string;
  specials_items?: SpecialItem[];
  capacity: CapacityBlock | null;
  party_sync?: { source: 'sheet-cache' | 'db-fallback' | 'none'; fetched_at: string };
  party_status?: PartyStatusCounts;
  summary: Summary;
}

// ── /api/crm-calls/live (subset used here) ─────────────────
interface RingingCall {
  id: string;
  phone_e164: string;
  guest_id: string | null;
  guest_name: string;
}

// ─── Date helpers (string math — no timezone surprises) ──────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "just now" / "3 min ago" / "2 h ago" from an ISO timestamp (client-side). */
function syncAgo(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Weekday (0=Sun..6=Sat) for a YYYY-MM-DD string, or -1. */
function weekdayOfIso(iso: string): number {
  const [y, m, d] = (iso || '').split('-').map(Number);
  if (!y || !m || !d) return -1;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = (iso || '').split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** "2026-08-15" → "Sat 15 Aug". */
function labelDate(iso: string, withWeekday = true): string {
  const [y, m, d] = (iso || '').split('-').map(Number);
  if (!y || !m || !d) return iso || '—';
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = WEEKDAYS[dt.getUTCDay()] || '';
  const body = `${d} ${MONTHS[m - 1] || ''}`;
  return withWeekday ? `${wd} ${body}` : body;
}

function isTodayIso(iso: string): boolean {
  return iso === todayIST();
}

function fmtNum(n: number | undefined): string {
  return (Number(n) || 0).toLocaleString('en-IN');
}

/** "20:00" + "23:30" → "20:00 – 23:30"; tolerant of blanks. */
function timeRange(start: string, end: string): string {
  const s = (start || '').trim();
  const e = (end || '').trim();
  if (s && e) return `${s} – ${e}`;
  return s || e || '';
}

// ─── Entertainment type meta ─────────────────────────────────────────────────

const ENT_TYPES: { value: EntType; label: string }[] = [
  { value: 'band', label: 'Band' },
  { value: 'dj', label: 'DJ' },
  { value: 'live_music', label: 'Live Music' },
  { value: 'event', label: 'Event' },
  { value: 'offer', label: 'Offer' },
  { value: 'other', label: 'Other' },
];

function entIcon(type: EntType) {
  const cls = 'w-4 h-4';
  switch (type) {
    case 'band': return <Music className={cls} />;
    case 'dj': return <Disc3 className={cls} />;
    case 'live_music': return <Mic2 className={cls} />;
    case 'event': return <Sparkles className={cls} />;
    case 'offer': return <Gift className={cls} />;
    default: return <Star className={cls} />;
  }
}

function entLabel(type: EntType): string {
  return ENT_TYPES.find(t => t.value === type)?.label || 'Other';
}

// ─── Status chip ─────────────────────────────────────────────────────────────

function statusTone(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'confirmed' || s === 'approved' || s === 'seated') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (s === 'completed') return 'bg-blue-50 text-blue-700 border-blue-200';
  if (s === 'pending' || s === 'draft') return 'bg-amber-50 text-amber-700 border-amber-200';
  if (s === 'cancelled' || s === 'no_show') return 'bg-red-50 text-red-600 border-red-200';
  return 'bg-[#F7EEE3] text-[#8B7355] border-[#E8D5C4]';
}

function StatusChip({ status }: { status: string }) {
  if (!status) return null;
  const label = status.replace(/_/g, ' ');
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap ${statusTone(status)}`}>
      {label}
    </span>
  );
}

// ─── Entertainment form state ────────────────────────────────────────────────

interface EntForm {
  type: EntType;
  name: string;
  start_time: string;
  end_time: string;
  area: string;
  description: string;
}
const EMPTY_FORM: EntForm = { type: 'band', name: '', start_time: '', end_time: '', area: '', description: '' };

// ─── Special/offer form state ────────────────────────────────────────────────

interface SpecialForm {
  scope: 'weekday' | 'date';
  weekday: number;       // 0=Sun..6=Sat (scope='weekday')
  category: string;      // special|offer|workshop|event|notice|vip
  title: string;
  details: string;
  start_time: string;
  end_time: string;
}
const EMPTY_SPECIAL: SpecialForm = { scope: 'weekday', weekday: 0, category: 'special', title: '', details: '', start_time: '', end_time: '' };

// Category meta — icon + colours + label. Full class-literals so Tailwind keeps them.
const SPECIAL_CATEGORIES: { value: string; label: string }[] = [
  { value: 'special', label: 'Special' },
  { value: 'offer', label: 'Offer' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'event', label: 'Event' },
  { value: 'notice', label: 'Notice' },
  { value: 'vip', label: 'VIP' },
];
function specialCatMeta(cat: string): { label: string; icon: React.ReactNode; sq: string; chip: string } {
  const cls = 'w-4 h-4';
  switch ((cat || '').toLowerCase()) {
    case 'offer':
      return { label: 'Offer', icon: <Percent className={cls} />, sq: 'bg-rose-100 text-rose-700', chip: 'bg-rose-50 text-rose-700 border-rose-200' };
    case 'workshop':
      return { label: 'Workshop', icon: <GraduationCap className={cls} />, sq: 'bg-violet-100 text-violet-700', chip: 'bg-violet-50 text-violet-700 border-violet-200' };
    case 'event':
      return { label: 'Event', icon: <Ticket className={cls} />, sq: 'bg-blue-100 text-blue-700', chip: 'bg-blue-50 text-blue-700 border-blue-200' };
    case 'notice':
      return { label: 'Notice', icon: <Megaphone className={cls} />, sq: 'bg-slate-100 text-slate-600', chip: 'bg-slate-100 text-slate-600 border-slate-200' };
    case 'vip':
      return { label: 'VIP', icon: <Star className={cls} />, sq: 'bg-purple-100 text-purple-700', chip: 'bg-purple-50 text-purple-700 border-purple-200' };
    default:
      return { label: 'Special', icon: <Sparkles className={cls} />, sq: 'bg-amber-100 text-amber-700', chip: 'bg-amber-50 text-amber-700 border-amber-200' };
  }
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function WhatsOnPage() {
  const [date, setDate] = useState<string>(todayIST());
  const [data, setData] = useState<WhatsOn | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [isManagement, setIsManagement] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Entertainment editor
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<EntForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EntForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // Specials & offers editor (management)
  const [showAddSpecial, setShowAddSpecial] = useState(false);
  const [specialForm, setSpecialForm] = useState<SpecialForm>(EMPTY_SPECIAL);
  const [editingSpecialId, setEditingSpecialId] = useState<string | null>(null);
  const [editSpecialForm, setEditSpecialForm] = useState<SpecialForm>(EMPTY_SPECIAL);
  const [savingSpecial, setSavingSpecial] = useState(false);
  const [specialError, setSpecialError] = useState('');

  // Talking-points inline edit (admin only — writes the admin-gated setting)
  const [editingTalking, setEditingTalking] = useState(false);
  const [talkingDraft, setTalkingDraft] = useState('');
  const [savingTalking, setSavingTalking] = useState(false);
  const [talkingError, setTalkingError] = useState('');

  // Live call context
  const [ringing, setRinging] = useState<RingingCall[]>([]);

  // Party sheet refresh (any signed-in user may pull the AKAN feed).
  const [refreshingParties, setRefreshingParties] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/crm-calls/whats-on?date=${encodeURIComponent(date)}`);
      if (res.ok) {
        const j = (await res.json()) as WhatsOn;
        if (j && j.panels) { setData(j); setFailed(false); }
        else if (!silent) setFailed(true);
      } else if (!silent) {
        setFailed(true);
      }
    } catch {
      if (!silent) setFailed(true);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [date]);

  // Force a fresh pull of the AKAN party sheet, then reload the board. POST
  // /api/upcoming-parties re-fetches the sheet + rewrites the cache the board reads.
  const refreshParties = useCallback(async () => {
    setRefreshingParties(true);
    // Party Bookings tab feeds the list; F&P Records feeds party entertainment.
    // Refresh both, in parallel, then reload the board.
    await Promise.allSettled([
      api('/api/party-bookings', { method: 'POST' }),
      api('/api/upcoming-parties', { method: 'POST' }),
    ]);
    try { await load(true); } catch { /* ignore */ }
    setRefreshingParties(false);
  }, [load]);

  useEffect(() => { load(); }, [load]);

  // Who am I? — decides whether the entertainment editor shows.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) return;
        const j = (await res.json()) as { user?: { role?: string; is_head_chef?: boolean } | null };
        const u = j?.user;
        if (alive && u) {
          setIsManagement(u.role === 'admin' || u.role === 'manager' || !!u.is_head_chef);
          setIsAdmin(u.role === 'admin');
        }
      } catch { /* stay non-management */ }
    })();
    return () => { alive = false; };
  }, []);

  // Poll live calls for the call-context strip (~10s) — ONLY while the
  // call_context panel is enabled (default on until settings load). When a
  // manager turns it off the poll stops entirely (no wasted /live hits).
  const seqRef = useRef(0);
  const callCtxOn = data?.panels?.call_context !== false;
  useEffect(() => {
    if (!callCtxOn) { setRinging([]); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/crm-calls/live?after=${seqRef.current}`);
        if (res.ok) {
          const j = (await res.json()) as { seq?: number; ringing?: RingingCall[] };
          if (alive) {
            if (typeof j.seq === 'number') seqRef.current = j.seq;
            setRinging(Array.isArray(j.ringing) ? j.ringing : []);
          }
        }
      } catch { /* ignore — strip just stays empty */ }
      if (alive) timer = setTimeout(poll, 10_000);
    };
    poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [callCtxOn]);

  const next7 = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(todayIST(), i)), []);

  // ── Entertainment CRUD ──
  function resetEditor() {
    setShowAdd(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setEditForm(EMPTY_FORM);
    setFormError('');
  }

  async function createEvent() {
    if (!form.name.trim()) { setFormError('Name is required.'); return; }
    setSaving(true);
    setFormError('');
    try {
      const res = await api('/api/crm-calls/entertainment', {
        method: 'POST',
        body: {
          event_date: date,
          type: form.type,
          name: form.name.trim(),
          start_time: form.start_time.trim(),
          end_time: form.end_time.trim(),
          area: form.area.trim(),
          description: form.description.trim(),
        },
      });
      if (!res.ok) {
        let msg = 'Could not add the event.';
        try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
        setFormError(msg);
        return;
      }
      setForm(EMPTY_FORM);
      setShowAdd(false);
      await load(true);
    } catch {
      setFormError('Network error — please try again.');
    } finally {
      setSaving(false);
    }
  }

  function startEdit(row: EntRow) {
    setShowAdd(false);
    setEditingId(row.id);
    setFormError('');
    setEditForm({
      type: row.type,
      name: row.name,
      start_time: row.start_time,
      end_time: row.end_time,
      area: row.area,
      description: row.description,
    });
  }

  async function saveEdit(id: string) {
    if (!editForm.name.trim()) { setFormError('Name is required.'); return; }
    setSaving(true);
    setFormError('');
    try {
      const res = await api(`/api/crm-calls/entertainment/${id}`, {
        method: 'PUT',
        body: {
          event_date: date,
          type: editForm.type,
          name: editForm.name.trim(),
          start_time: editForm.start_time.trim(),
          end_time: editForm.end_time.trim(),
          area: editForm.area.trim(),
          description: editForm.description.trim(),
        },
      });
      if (!res.ok) {
        let msg = 'Could not save changes.';
        try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
        setFormError(msg);
        return;
      }
      setEditingId(null);
      await load(true);
    } catch {
      setFormError('Network error — please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteEvent(id: string) {
    if (typeof window !== 'undefined' && !window.confirm('Remove this entertainment event?')) return;
    setSaving(true);
    try {
      const res = await api(`/api/crm-calls/entertainment/${id}`, { method: 'DELETE' });
      if (res.ok) await load(true);
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }

  // ── Specials & offers CRUD ──
  function resetSpecialEditor() {
    setShowAddSpecial(false);
    setEditingSpecialId(null);
    setSpecialForm({ ...EMPTY_SPECIAL, weekday: Math.max(0, weekdayOfIso(date)) });
    setEditSpecialForm(EMPTY_SPECIAL);
    setSpecialError('');
  }

  /** Build the API body for a special form (weekday recurring OR this exact date). */
  function specialBody(f: SpecialForm) {
    const common = {
      category: f.category,
      title: f.title.trim(),
      details: f.details.trim(),
      start_time: f.start_time.trim(),
      end_time: f.end_time.trim(),
    };
    return f.scope === 'date'
      ? { scope: 'date' as const, event_date: date, ...common }
      : { scope: 'weekday' as const, weekday: f.weekday, ...common };
  }

  async function createSpecial() {
    if (!specialForm.title.trim()) { setSpecialError('Title is required.'); return; }
    setSavingSpecial(true);
    setSpecialError('');
    try {
      const res = await api('/api/crm-calls/specials', { method: 'POST', body: specialBody(specialForm) });
      if (!res.ok) {
        let msg = 'Could not add the special.';
        try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
        setSpecialError(msg);
        return;
      }
      setShowAddSpecial(false);
      setSpecialForm({ ...EMPTY_SPECIAL, weekday: Math.max(0, weekdayOfIso(date)) });
      await load(true);
    } catch {
      setSpecialError('Network error — please try again.');
    } finally {
      setSavingSpecial(false);
    }
  }

  function startEditSpecial(row: SpecialItem) {
    setShowAddSpecial(false);
    setEditingSpecialId(row.id);
    setSpecialError('');
    setEditSpecialForm({
      scope: row.scope,
      weekday: row.weekday >= 0 && row.weekday <= 6 ? row.weekday : Math.max(0, weekdayOfIso(date)),
      category: row.category || 'special',
      title: row.title,
      details: row.details,
      start_time: row.start_time,
      end_time: row.end_time,
    });
  }

  async function saveSpecialEdit(id: string) {
    if (!editSpecialForm.title.trim()) { setSpecialError('Title is required.'); return; }
    setSavingSpecial(true);
    setSpecialError('');
    try {
      const res = await api(`/api/crm-calls/specials/${id}`, { method: 'PUT', body: specialBody(editSpecialForm) });
      if (!res.ok) {
        let msg = 'Could not save changes.';
        try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
        setSpecialError(msg);
        return;
      }
      setEditingSpecialId(null);
      await load(true);
    } catch {
      setSpecialError('Network error — please try again.');
    } finally {
      setSavingSpecial(false);
    }
  }

  async function deleteSpecial(id: string) {
    if (typeof window !== 'undefined' && !window.confirm('Remove this special?')) return;
    setSavingSpecial(true);
    try {
      const res = await api(`/api/crm-calls/specials/${id}`, { method: 'DELETE' });
      if (res.ok) await load(true);
    } catch { /* ignore */ }
    finally { setSavingSpecial(false); }
  }

  // ── Talking-points inline edit (admin only) ──
  function startEditTalking() {
    setTalkingDraft(data?.specials || '');
    setTalkingError('');
    setEditingTalking(true);
  }

  async function saveTalking() {
    setSavingTalking(true);
    setTalkingError('');
    try {
      const res = await api('/api/crm-calls/settings', {
        method: 'PUT',
        body: { whatson_specials: talkingDraft },
      });
      if (!res.ok) {
        let msg = 'Could not save talking points.';
        try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
        setTalkingError(msg);
        return;
      }
      setEditingTalking(false);
      await load(true);
    } catch {
      setTalkingError('Network error — please try again.');
    } finally {
      setSavingTalking(false);
    }
  }

  // ── Loading skeleton ──
  if (loading && !data) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-7xl mx-auto space-y-5">
          <div className="h-9 w-72 bg-[#FFF1E3] rounded-lg" />
          <div className="h-16 bg-white border border-[#E8D5C4] rounded-2xl" />
          <div className="grid lg:grid-cols-2 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl h-56" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const panels: Panels = data?.panels ?? {
    entertainment: true, parties: true, reservations: true, specials: true, capacity: true, call_context: true,
  };
  const s = data?.summary;
  // Refetch (date switch) with data already on screen — dim the body + swap the
  // at-a-glance counts for "updating…" so the numbers never contradict the date.
  const refetching = loading && !!data;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className={`max-w-7xl mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4 sm:space-y-5 transition-opacity ${refetching ? 'opacity-60' : ''}`}>

        {/* Header + date controls */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">CRM — Call-to-Table</p>
              <h1 className="text-2xl sm:text-3xl font-bold mt-0.5">What&apos;s On</h1>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-xl border border-[#E0D0BE] bg-white overflow-hidden shadow-sm">
                <button
                  onClick={() => setDate(d => addDays(d, -1))}
                  className="px-2.5 py-2 text-[#6B5744] hover:bg-[#FFF1E3] transition-colors"
                  title="Previous day"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setDate(todayIST())}
                  className={`px-3.5 py-2 text-sm font-medium border-l border-r border-[#F0E4D6] transition-colors ${
                    isTodayIso(date) ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-[#FFF1E3]'
                  }`}
                >
                  Today
                </button>
                <button
                  onClick={() => setDate(d => addDays(d, 1))}
                  className="px-2.5 py-2 text-[#6B5744] hover:bg-[#FFF1E3] transition-colors"
                  title="Next day"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
              <input
                type="date"
                value={date}
                onChange={e => e.target.value && setDate(e.target.value)}
                className="px-3 py-2 rounded-xl border border-[#E0D0BE] bg-white text-sm text-[#2D1B0E] shadow-sm outline-none focus:border-[#af4408]"
              />
            </div>
          </div>

          {/* Next-7-days chips */}
          <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
            {next7.map(d => {
              const active = d === date;
              return (
                <button
                  key={d}
                  onClick={() => setDate(d)}
                  className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    active
                      ? 'bg-[#af4408] text-white border-[#903905]'
                      : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                  }`}
                >
                  {isTodayIso(d) ? 'Today' : labelDate(d)}
                </button>
              );
            })}
          </div>
        </div>

        {/* At-a-glance line */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm px-4 sm:px-5 py-3.5">
          <p className="text-sm sm:text-base font-semibold text-[#2D1B0E] flex flex-wrap items-center gap-x-2 gap-y-1">
            <CalendarDays className="w-4 h-4 text-[#af4408]" />
            <span>{labelDate(date)}</span>
            {refetching ? (
              <span className="text-[#8B7355] font-normal animate-pulse">· updating…</span>
            ) : s ? (
              <>
                <Dot />
                <span>{fmtNum(s.entertainment_count)} {s.entertainment_count === 1 ? 'act' : 'acts'}</span>
                <Dot />
                <span>{fmtNum(s.parties_count)} {s.parties_count === 1 ? 'party' : 'parties'}{s.party_pax > 0 ? ` (${fmtNum(s.party_pax)} pax)` : ''}</span>
                <Dot />
                <span>{fmtNum(s.reservations_count)} {s.reservations_count === 1 ? 'reservation' : 'reservations'}{s.reserved_covers > 0 ? ` (${fmtNum(s.reserved_covers)} covers)` : ''}</span>
              </>
            ) : (
              <span className="text-[#8B7355] font-normal">— nothing on the board yet</span>
            )}
          </p>
        </div>

        {failed && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800 flex items-center justify-between gap-3">
            <span>Could not refresh the board. Check that you are signed in.</span>
            <button onClick={() => load()} className="font-semibold text-[#af4408] hover:underline whitespace-nowrap">Retry</button>
          </div>
        )}

        {/* Call-context strip */}
        {panels.call_context && ringing.length > 0 && (
          <div className="bg-white border-2 border-[#af4408] rounded-2xl shadow-sm px-4 py-3">
            <p className="text-[11px] font-semibold text-[#af4408] uppercase tracking-wide flex items-center gap-1.5 mb-2">
              <PhoneCall className="w-3.5 h-3.5 animate-pulse" /> Live call{ringing.length > 1 ? 's' : ''} ringing
            </p>
            <div className="space-y-2">
              {ringing.map(c => (
                <div key={c.id} className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-[#F3E2D0] text-[#a8632b] flex items-center justify-center shrink-0">
                    <Phone className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold truncate">{c.guest_name || 'Unknown caller'}</p>
                    <p className="text-xs text-[#8B7355] truncate">{formatPhone(c.phone_e164)}</p>
                  </div>
                  <Link
                    href={c.guest_id ? `/crm-calls/guests/${c.guest_id}` : '/crm-calls/guests'}
                    className="shrink-0 text-xs font-medium text-[#af4408] hover:underline whitespace-nowrap"
                  >
                    Open guest →
                  </Link>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Entertainment ── */}
        {panels.entertainment && (
          <Card
            icon={<Music className="w-4 h-4" />}
            title="Entertainment"
            subtitle={`${fmtNum(data?.entertainment.length)} on ${labelDate(date, false)}`}
            action={isManagement ? (
              <button
                onClick={() => { if (showAdd) { setShowAdd(false); setFormError(''); } else { resetEditor(); setShowAdd(true); } }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white transition-colors"
              >
                {showAdd ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                {showAdd ? 'Close' : 'Add event'}
              </button>
            ) : null}
          >
            {/* Add form */}
            {isManagement && showAdd && (
              <EntEditor
                form={form}
                setForm={setForm}
                onSave={createEvent}
                onCancel={() => { setShowAdd(false); setFormError(''); }}
                saving={saving}
                error={formError}
                submitLabel="Add to board"
              />
            )}

            {(data?.entertainment.length ?? 0) === 0 && !showAdd ? (
              <Empty text="Nothing booked for this day." />
            ) : (
              <div className="space-y-2.5 mt-1">
                {data?.entertainment.map(row => (
                  editingId === row.id && isManagement && row.source === 'calendar' ? (
                    <EntEditor
                      key={row.id}
                      form={editForm}
                      setForm={setEditForm}
                      onSave={() => saveEdit(row.id)}
                      onCancel={() => { setEditingId(null); setFormError(''); }}
                      saving={saving}
                      error={formError}
                      submitLabel="Save"
                    />
                  ) : (
                    <div
                      key={row.id}
                      className="flex items-start gap-3 p-3 rounded-lg border border-[#F0E4D6] bg-[#FFFDFA]"
                    >
                      <div className="w-9 h-9 rounded-lg bg-[#F3E2D0] text-[#a8632b] flex items-center justify-center shrink-0">
                        {entIcon(row.type)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold truncate">{row.name}</p>
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-[#8B7355] bg-[#F7EEE3] border border-[#E8D5C4] rounded px-1.5 py-0.5">
                            {entLabel(row.type)}
                          </span>
                          {row.source === 'party' && (
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-700 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">
                              Party
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[#8B7355] mt-0.5 flex flex-wrap gap-x-2">
                          {timeRange(row.start_time, row.end_time) && <span>{timeRange(row.start_time, row.end_time)}</span>}
                          {row.area && <span>· {row.area}</span>}
                        </p>
                        {row.description && (
                          <p className="text-xs text-[#6B5744] mt-1 whitespace-pre-line">{row.description}</p>
                        )}
                      </div>
                      {isManagement && row.source === 'calendar' && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => startEdit(row)}
                            className="p-1.5 rounded-lg text-[#8B7355] hover:text-[#af4408] hover:bg-[#FFF1E3] transition-colors"
                            title="Edit"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => deleteEvent(row.id)}
                            disabled={saving}
                            className="p-1.5 rounded-lg text-[#8B7355] hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  )
                ))}
              </div>
            )}
          </Card>
        )}

        {/* ── Parties ── */}
        {panels.parties && (
          <Card
            icon={<PartyPopper className="w-4 h-4" />}
            title="Parties & Events"
            subtitle={(() => {
              const ps = data?.party_status;
              const bits: string[] = [];
              if (ps) {
                if (ps.confirmed) bits.push(`${ps.confirmed} confirmed`);
                if (ps.enquiry) bits.push(`${ps.enquiry} enquiry`);
                if (ps.tentative) bits.push(`${ps.tentative} tentative`);
                if (ps.completed) bits.push(`${ps.completed} completed`);
                if (ps.other) bits.push(`${ps.other} other`);
                if (ps.cancelled) bits.push(`${ps.cancelled} cancelled`);
              }
              return `${fmtNum(data?.parties.length)} on this date${bits.length ? ' · ' + bits.join(' · ') : ''}`;
            })()}
          >
            {/* Sync status + manual refresh (pulls the AKAN sheet). */}
            <div className="flex items-center justify-between gap-2 mb-2 text-[11px] text-[#8B7355]">
              <span>
                {data?.party_sync?.source === 'db-fallback'
                  ? 'From local records — sheet not synced yet'
                  : data?.party_sync?.fetched_at
                    ? `Sheet synced ${syncAgo(data.party_sync.fetched_at)}`
                    : 'Sheet not synced yet'}
              </span>
              <button
                onClick={refreshParties}
                disabled={refreshingParties}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-50"
                title="Pull the latest parties from the AKAN sheet"
              >
                <RefreshCw className={`w-3 h-3 ${refreshingParties ? 'animate-spin' : ''}`} />
                {refreshingParties ? 'Syncing…' : 'Refresh'}
              </button>
            </div>
            {(data?.parties.length ?? 0) === 0 ? (
              <Empty text="No party bookings for this day." />
            ) : (
              <div className="divide-y divide-[#F7EEE3] -my-1">
                {data?.parties.map((p, idx) => (
                  <div key={p.fp_id || `${p.guest_name}|${p.time}|${idx}`} className="py-2.5 flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold truncate">{p.guest_name || p.name || 'Party'}</p>
                        <StatusChip status={p.status} />
                      </div>
                      <p className="text-xs text-[#8B7355] mt-0.5 flex flex-wrap gap-x-2">
                        {p.time && <span>{p.time}</span>}
                        {p.place && <span>· {p.place}</span>}
                        {p.occasion && <span>· {p.occasion}</span>}
                        {p.package && <span>· {p.package}</span>}
                      </p>
                      {(p.company || p.handled_by) && (
                        <p className="text-xs text-[#8B7355] mt-0.5 flex flex-wrap gap-x-2">
                          {p.company && <span>{p.company}</span>}
                          {p.handled_by && <span className="text-[#af4408]">· Handled by {p.handled_by}</span>}
                        </p>
                      )}
                      {p.special_requirements && (
                        <p className="text-[11px] text-[#8B7355] italic mt-0.5 line-clamp-2">“{p.special_requirements}”</p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-[#af4408] flex items-center justify-end gap-1">
                        <Users className="w-3.5 h-3.5" />{fmtNum(p.pax)}
                      </p>
                      <p className="text-[10px] text-[#8B7355] uppercase tracking-wide">pax</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* ── Reservations ── */}
        {panels.reservations && (
          <Card
            icon={<CalendarDays className="w-4 h-4" />}
            title="Reservations"
            subtitle={`${fmtNum(data?.reservations.length)} on the book${s && s.reserved_covers > 0 ? ` · ${fmtNum(s.reserved_covers)} covers` : ''}`}
          >
            {(data?.reservations.length ?? 0) === 0 ? (
              <Empty text="No reservations for this day." />
            ) : (
              <div className="divide-y divide-[#F7EEE3] -my-1">
                {data?.reservations.map(r => (
                  <div key={r.id} className="py-2.5 flex items-center gap-3">
                    <div className="w-14 shrink-0 text-center">
                      <p className="text-sm font-bold text-[#2D1B0E]">{r.slot_time || '—'}</p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold truncate">{r.guest_name || 'Guest'}</p>
                        <StatusChip status={r.status} />
                      </div>
                      <p className="text-xs text-[#8B7355] mt-0.5 flex flex-wrap gap-x-2">
                        {r.guest_phone && <span>{formatPhone(r.guest_phone)}</span>}
                        {r.occasion && <span>· {r.occasion}</span>}
                        {r.section_pref && <span>· {r.section_pref}</span>}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-[#af4408] flex items-center justify-end gap-1">
                        <Users className="w-3.5 h-3.5" />{fmtNum(r.party_size)}
                      </p>
                      <p className="text-[10px] text-[#8B7355] uppercase tracking-wide">covers</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* ── Specials & Offers ── */}
        {panels.specials && (
          <Card
            icon={<Sparkles className="w-4 h-4" />}
            title="Specials & Workshops"
            subtitle={`${fmtNum(data?.specials_items?.length)} on ${labelDate(date, false)}`}
            action={isManagement ? (
              <button
                onClick={() => { if (showAddSpecial) { setShowAddSpecial(false); setSpecialError(''); } else { resetSpecialEditor(); setShowAddSpecial(true); } }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white transition-colors"
              >
                {showAddSpecial ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                {showAddSpecial ? 'Close' : 'Add'}
              </button>
            ) : null}
          >
            {/* Add form */}
            {isManagement && showAddSpecial && (
              <SpecialEditor
                form={specialForm}
                setForm={setSpecialForm}
                boardDate={date}
                onSave={createSpecial}
                onCancel={() => { setShowAddSpecial(false); setSpecialError(''); }}
                saving={savingSpecial}
                error={specialError}
                submitLabel="Add to board"
              />
            )}

            {/* Special cards */}
            {(data?.specials_items?.length ?? 0) === 0 && !showAddSpecial ? (
              <Empty text="Nothing listed for this day." />
            ) : (
              <div className="space-y-2.5 mt-1">
                {data?.specials_items?.map(row => {
                  const cat = specialCatMeta(row.category);
                  return editingSpecialId === row.id && isManagement ? (
                    <SpecialEditor
                      key={row.id}
                      form={editSpecialForm}
                      setForm={setEditSpecialForm}
                      boardDate={date}
                      onSave={() => saveSpecialEdit(row.id)}
                      onCancel={() => { setEditingSpecialId(null); setSpecialError(''); }}
                      saving={savingSpecial}
                      error={specialError}
                      submitLabel="Save"
                    />
                  ) : (
                    <div
                      key={row.id}
                      className="flex items-start gap-3 p-3 rounded-lg border border-[#F0E4D6] bg-[#FFFDFA]"
                    >
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${cat.sq}`}>
                        {cat.icon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold truncate">{row.title}</p>
                          <span className={`text-[10px] font-semibold uppercase tracking-wide border rounded px-1.5 py-0.5 ${cat.chip}`}>
                            {cat.label}
                          </span>
                          {row.recurring_label ? (
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                              {row.recurring_label}
                            </span>
                          ) : (
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-700 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">
                              This date
                            </span>
                          )}
                        </div>
                        {timeRange(row.start_time, row.end_time) && (
                          <p className="text-xs text-[#8B7355] mt-0.5">{timeRange(row.start_time, row.end_time)}</p>
                        )}
                        {row.details && (
                          <p className="text-xs text-[#6B5744] mt-1 whitespace-pre-line">{row.details}</p>
                        )}
                      </div>
                      {isManagement && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => startEditSpecial(row)}
                            className="p-1.5 rounded-lg text-[#8B7355] hover:text-[#af4408] hover:bg-[#FFF1E3] transition-colors"
                            title="Edit"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => deleteSpecial(row.id)}
                            disabled={savingSpecial}
                            className="p-1.5 rounded-lg text-[#8B7355] hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Talking points (always-on note, edited by admins) */}
            <div className="mt-4 pt-4 border-t border-[#F0E4D6]">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">Talking points</p>
                {isAdmin && !editingTalking && (
                  <button
                    onClick={startEditTalking}
                    className="inline-flex items-center gap-1 text-xs font-medium text-[#af4408] hover:underline"
                  >
                    <Pencil className="w-3 h-3" /> Edit
                  </button>
                )}
              </div>
              {editingTalking ? (
                <div>
                  <textarea
                    value={talkingDraft}
                    onChange={e => setTalkingDraft(e.target.value)}
                    rows={4}
                    maxLength={4000}
                    placeholder="General talking points shown on every date (e.g. current promotions, house rules)…"
                    className="w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm text-[#2D1B0E] outline-none focus:border-[#af4408] resize-y"
                  />
                  {talkingError && <p className="mt-1 text-xs font-medium text-red-500">{talkingError}</p>}
                  <div className="flex items-center gap-2 mt-2">
                    <button
                      onClick={saveTalking}
                      disabled={savingTalking}
                      className="px-4 py-2 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white transition-colors disabled:opacity-50"
                    >
                      {savingTalking ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditingTalking(false)}
                      disabled={savingTalking}
                      className="px-4 py-2 rounded-lg text-sm font-medium text-[#6B5744] hover:bg-[#FFF1E3] transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : data?.specials && data.specials.trim() ? (
                <p className="text-sm text-[#3A2A1B] whitespace-pre-line leading-relaxed">{data.specials}</p>
              ) : (
                <p className="text-sm text-[#B8A48E] italic">
                  {isAdmin ? 'No talking points yet — click Edit to add.' : 'No talking points set.'}
                </p>
              )}
            </div>
          </Card>
        )}

        {/* ── Capacity ── */}
        {panels.capacity && data?.capacity && (
          <Card icon={<Gauge className="w-4 h-4" />} title="Covers vs Capacity">
            <CapacityGauge cap={data.capacity} />
          </Card>
        )}

      </div>
    </div>
  );
}

// ─── Presentational bits ─────────────────────────────────────────────────────

function Dot() {
  return <span className="text-[#E0D0BE]" aria-hidden>·</span>;
}

function Card({ icon, title, subtitle, action, children }: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex items-baseline gap-2 min-w-0">
          <h2 className="text-sm font-bold text-[#2D1B0E] flex items-center gap-2 shrink-0">
            <span className="text-[#af4408]">{icon}</span>{title}
          </h2>
          {subtitle ? <p className="text-[11px] text-[#8B7355] truncate">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-8 text-center text-sm text-[#8B7355]">{text}</p>;
}

function CapacityGauge({ cap }: { cap: CapacityBlock }) {
  const pct = Math.max(0, Number(cap.pct) || 0);
  const clamped = Math.min(100, pct);
  const tone = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500';
  const textTone = pct >= 100 ? 'text-red-500' : pct >= 80 ? 'text-amber-600' : 'text-emerald-600';
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-sm text-[#6B5744]">
          <span className="font-bold text-[#2D1B0E]">{fmtNum(cap.total)}</span> of {fmtNum(cap.capacity)} seats
        </p>
        <p className={`text-lg font-bold ${textTone}`}>{fmtNum(cap.pct)}%</p>
      </div>
      <div className="h-4 bg-[#FAF3EA] rounded-full overflow-hidden border border-[#F0E4D6]">
        <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${clamped}%` }} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs text-[#8B7355]">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-[#af4408]" />
          Reservations <span className="font-semibold text-[#2D1B0E]">{fmtNum(cap.reserved_covers)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-[#d98e5f]" />
          Parties <span className="font-semibold text-[#2D1B0E]">{fmtNum(cap.party_pax)}</span>
        </span>
      </div>
      {pct >= 100 && (
        <p className="mt-2 text-xs font-semibold text-red-500">At / over capacity — check before confirming more covers.</p>
      )}
    </div>
  );
}

/** Shared add/edit form for a calendar entertainment row. */
function EntEditor({ form, setForm, onSave, onCancel, saving, error, submitLabel }: {
  form: EntForm;
  setForm: (updater: (f: EntForm) => EntForm) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string;
  submitLabel: string;
}) {
  const inputCls = 'w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm text-[#2D1B0E] outline-none focus:border-[#af4408]';
  return (
    <div className="mb-3 p-3 sm:p-4 rounded-xl border border-[#E8D5C4] bg-[#FFFBF5]">
      <div className="grid sm:grid-cols-2 gap-2.5">
        <label className="block">
          <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">Type</span>
          <select
            value={form.type}
            onChange={e => setForm(f => ({ ...f, type: e.target.value as EntType }))}
            className={inputCls + ' mt-1'}
          >
            {ENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">Name</span>
          <input
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            maxLength={120}
            placeholder="e.g. The Local Collective"
            className={inputCls + ' mt-1'}
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">Start time</span>
          <input
            value={form.start_time}
            onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))}
            maxLength={10}
            placeholder="20:00"
            className={inputCls + ' mt-1'}
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">End time</span>
          <input
            value={form.end_time}
            onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))}
            maxLength={10}
            placeholder="23:30"
            className={inputCls + ' mt-1'}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">Area</span>
          <input
            value={form.area}
            onChange={e => setForm(f => ({ ...f, area: e.target.value }))}
            maxLength={80}
            placeholder="e.g. Rooftop"
            className={inputCls + ' mt-1'}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">Description</span>
          <textarea
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            maxLength={1000}
            rows={2}
            placeholder="Notes for the team…"
            className={inputCls + ' mt-1 resize-y'}
          />
        </label>
      </div>
      {error && <p className="mt-2 text-xs font-medium text-red-500">{error}</p>}
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={onSave}
          disabled={saving}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="px-4 py-2 rounded-lg text-sm font-medium text-[#6B5744] hover:bg-[#FFF1E3] transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Add/edit form for a special/offer — recurring weekly OR this exact date. */
function SpecialEditor({ form, setForm, boardDate, onSave, onCancel, saving, error, submitLabel }: {
  form: SpecialForm;
  setForm: (updater: (f: SpecialForm) => SpecialForm) => void;
  boardDate: string;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string;
  submitLabel: string;
}) {
  const inputCls = 'w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm text-[#2D1B0E] outline-none focus:border-[#af4408]';
  return (
    <div className="mb-3 p-3 sm:p-4 rounded-xl border border-[#E8D5C4] bg-[#FFFBF5]">
      {/* Category picker */}
      <div className="mb-3">
        <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">Type</span>
        <div className="flex flex-wrap gap-1.5 mt-1">
          {SPECIAL_CATEGORIES.map(c => (
            <button
              key={c.value}
              type="button"
              onClick={() => setForm(f => ({ ...f, category: c.value }))}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                form.category === c.value
                  ? 'bg-[#af4408] text-white border-[#903905]'
                  : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Scope toggle: recurring weekly vs this date only */}
      <div className="flex flex-wrap gap-2 mb-3">
        <button
          type="button"
          onClick={() => setForm(f => ({ ...f, scope: 'weekday' }))}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
            form.scope === 'weekday'
              ? 'bg-[#af4408] text-white border-[#903905]'
              : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
          }`}
        >
          Every week
        </button>
        <button
          type="button"
          onClick={() => setForm(f => ({ ...f, scope: 'date' }))}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
            form.scope === 'date'
              ? 'bg-[#af4408] text-white border-[#903905]'
              : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
          }`}
        >
          This date only
        </button>
      </div>

      <div className="grid sm:grid-cols-2 gap-2.5">
        {form.scope === 'weekday' ? (
          <label className="block">
            <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">Repeats on</span>
            <select
              value={form.weekday}
              onChange={e => setForm(f => ({ ...f, weekday: Number(e.target.value) }))}
              className={inputCls + ' mt-1'}
            >
              {WEEKDAYS_FULL.map((w, i) => <option key={i} value={i}>Every {w}</option>)}
            </select>
          </label>
        ) : (
          <label className="block">
            <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">On date</span>
            <div className={inputCls + ' mt-1 bg-[#F7EEE3] text-[#6B5744]'}>{labelDate(boardDate)}</div>
          </label>
        )}
        <label className="block">
          <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">Title</span>
          <input
            value={form.title}
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            maxLength={120}
            placeholder="e.g. Sunday Brunch, Sushi Workshop"
            className={inputCls + ' mt-1'}
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">Start time</span>
          <input
            value={form.start_time}
            onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))}
            maxLength={20}
            placeholder="12:00"
            className={inputCls + ' mt-1'}
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">End time</span>
          <input
            value={form.end_time}
            onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))}
            maxLength={20}
            placeholder="16:00"
            className={inputCls + ' mt-1'}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">Details</span>
          <textarea
            value={form.details}
            onChange={e => setForm(f => ({ ...f, details: e.target.value }))}
            maxLength={2000}
            rows={3}
            placeholder="Menu highlights, price, unlimited food/drinks, etc."
            className={inputCls + ' mt-1 resize-y'}
          />
        </label>
      </div>
      {error && <p className="mt-2 text-xs font-medium text-red-500">{error}</p>}
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={onSave}
          disabled={saving}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="px-4 py-2 rounded-lg text-sm font-medium text-[#6B5744] hover:bg-[#FFF1E3] transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
