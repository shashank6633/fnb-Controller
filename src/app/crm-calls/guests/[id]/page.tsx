'use client';

/**
 * CRM Call-to-Table — Guest 360 (master spec 5.3).
 *
 * One scroll = the whole "call-to-table" story for a guest:
 *   Header   — name, phone + device-dialed callback, editable tag chips, status badge,
 *              inline edit mode (prefs / dob / anniversary / notes).
 *   Metrics  — calls / bookings / visits / no-shows / conversion %.
 *   Timeline — unified reverse-chron: calls (with inline recording player),
 *              bookings (with quick status-advance), follow-ups (with Done).
 *
 * Data: GET /api/crm-calls/guests/[id] → { guest, metrics, timeline }.
 * Mutations via api() (CSRF): PUT guests/[id] (fields + actions),
 * PUT bookings/[id] {status}; device callback via <CallbackButton/>
 * (POST /api/crm-calls/calls/log-callback).
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, Award, Cake, CalendarDays, CalendarPlus, Check, CheckCircle2, ChevronRight,
  Clock, Edit, Heart, Loader2, PhoneIncoming, PhoneMissed, PhoneOutgoing,
  Plus, Save, Sparkles, StickyNote, Tag, User, Utensils, Voicemail, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import QuickBookingModal from '@/components/ct/QuickBookingModal';
import CallbackButton from '@/components/ct/CallbackButton';
import CallAnalysisCard, { type CallAnalysisData } from '@/app/crm/assistant/CallAnalysisCard';

// ─── Types (mirror /api/crm-calls/guests/[id]) ──────────────────────────────

interface Guest {
  id: string;
  phone_e164: string;
  name: string;
  alt_phone: string;
  email: string;
  tags: string[];
  source: string;
  notes: string;
  dob: string;
  anniversary: string;
  preferences: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  synthetic?: boolean;
}

// ─── Unified 360 (loyalty + dining) — keyed by phone ────────────────────────

interface Loyalty {
  crm_guest_id: string;
  name: string;
  points: number;
  tier: 'Bronze' | 'Silver' | 'Gold';
  visit_count: number;
  total_spend: number;
  first_visit_at: string | null;
  last_visit_at: string | null;
}

interface LoyaltyVisit {
  id: string;
  order_id: string;
  bill_amount: number;
  points_earned: number;
  visited_at: string;
  source: string;
}

interface DiningSummary {
  name: string;
  orders: number;
  visits: number;
  total_spent: number;
  qr_orders: number;
  first_seen: string | null;
  last_seen: string | null;
}

interface DiningOrder {
  id: string;
  order_number: string;
  status: string;
  origin: string;
  total: number;
  created_at: string;
  settled_at: string | null;
  guest_name: string;
  table_number: string | null;
  item_count: number;
}

interface Metrics {
  total_calls: number;
  calls_30d: number;
  missed_calls: number;
  last_call_at: string | null;
  total_bookings: number;
  completed_visits: number;
  no_shows: number;
  last_visit_at: string | null;
  conversion_rate: number;
  badge: string;
}

interface TimelineEntry {
  type: 'call' | 'booking' | 'follow_up';
  at: string;
  id: string;
  // call
  direction?: string;
  status?: string;
  agent_user?: string;
  agent_display?: string;
  queue?: string;
  started_at?: string | null;
  duration_sec?: number;
  disposition?: string;
  disposition_note?: string;
  has_recording?: boolean;
  // AI call enhancement (reuses the production scorecard engine)
  analysis_status?: string;        // ''|pending|done|error|skipped
  analysis_score?: number | null;  // 0–100
  analysis_outcome?: string;       // resolved|escalate|follow_up|lost
  // booking
  source_call_id?: string | null;
  booking_date?: string;
  slot_time?: string;
  party_size?: number;
  occasion?: string;
  section_pref?: string;
  created_by?: string;
  channel?: string;
  advance_amount?: number;
  notes?: string;
  // follow-up
  call_id?: string | null;
  due_at?: string;
  assigned_to?: string;
  note?: string;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function fmtIst(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/** Date-only formatter (IST) for stored dob/anniversary — no time component. */
function fmtDateOnly(s?: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function fmtDuration(sec?: number): string {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s === 0) return '0s';
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

const BADGE_STYLES: Record<string, string> = {
  'NEW CALLER': 'bg-sky-50 text-sky-700 border-sky-200',
  'ENQUIRED–NOT CONVERTED': 'bg-amber-50 text-amber-700 border-amber-200',
  'ENQUIRED-NOT CONVERTED': 'bg-amber-50 text-amber-700 border-amber-200',
  CONVERTED: 'bg-green-50 text-green-700 border-green-200',
  'REPEAT GUEST': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'DINE-IN GUEST': 'bg-[#F3E9DC] text-[#8B5E34] border-[#E8D5C4]',
  LAPSED: 'bg-red-50 text-red-700 border-red-200',
};

const DISPOSITION_LABELS: Record<string, string> = {
  booking_made: 'Booking made',
  enquiry: 'Enquiry',
  event_enquiry: 'Event enquiry',
  complaint: 'Complaint',
  wrong_number: 'Wrong number',
  follow_up_needed: 'Follow-up needed',
  no_action: 'No action',
};

const BOOKING_STATUS_STYLES: Record<string, string> = {
  pending: 'badge-warning',
  confirmed: 'badge-primary',
  seated: 'badge-primary',
  completed: 'badge-success',
  no_show: 'badge-danger',
  cancelled: 'badge-danger',
};

const NEXT_BOOKING_STATUS: Record<string, string> = {
  pending: 'confirmed',
  confirmed: 'seated',
  seated: 'completed',
};

/** AI quality-score chip colour: green ≥80 / amber 60–79 / red <60. */
function aiScoreChipStyle(score?: number | null): string {
  if (typeof score !== 'number') return 'bg-purple-50 text-purple-700 border-purple-200';
  if (score >= 80) return 'bg-green-50 text-green-700 border-green-200';
  if (score >= 60) return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-red-50 text-red-700 border-red-200';
}

/** ₹ integer formatter (en-IN grouping, no decimals). */
const inr = (n: unknown): string =>
  '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

/** Loyalty tier chip colours (light theme only). */
const TIER_CHIP_STYLES: Record<string, string> = {
  Bronze: 'bg-amber-100 text-amber-800 border-amber-300',
  Silver: 'bg-slate-100 text-slate-700 border-slate-300',
  Gold: 'bg-yellow-100 text-yellow-800 border-yellow-300',
};

// ─── Page ───────────────────────────────────────────────────────────────────

export default function GuestProfilePage() {
  const params = useParams<{ id: string }>();
  // useParams can hand back the raw (still-percent-encoded) segment, e.g. a
  // synthetic `phone%3A9876543210` handle. Decode it once so `guestId` is the
  // canonical `phone:9876543210`; load() re-encodes it for the fetch URL.
  const rawId = typeof params?.id === 'string' ? params.id : '';
  const guestId = rawId ? (() => { try { return decodeURIComponent(rawId); } catch { return rawId; } })() : '';
  const router = useRouter();

  const [guest, setGuest] = useState<Guest | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loyalty, setLoyalty] = useState<Loyalty | null>(null);
  const [loyaltyVisits, setLoyaltyVisits] = useState<LoyaltyVisit[]>([]);
  const [dining, setDining] = useState<DiningSummary | null>(null);
  const [diningOrders, setDiningOrders] = useState<DiningOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Synthetic (phone-only) guest → save into CRM before write actions work
  const [savingToCrm, setSavingToCrm] = useState(false);

  // Transient feedback (call fired, save failed, …)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  // Header actions
  const [newTag, setNewTag] = useState('');
  const [savingTags, setSavingTags] = useState(false);

  // Inline edit mode
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', email: '', dob: '', anniversary: '', notes: '' });
  const [editPrefs, setEditPrefs] = useState<{ k: string; v: string }[]>([]);

  // Quick booking modal
  const [bookingOpen, setBookingOpen] = useState(false);
  const [bookingSourceCall, setBookingSourceCall] = useState<string | undefined>(undefined);

  // Follow-up mini form
  const [fuOpen, setFuOpen] = useState(false);
  const [fuDue, setFuDue] = useState('');
  const [fuNote, setFuNote] = useState('');
  const [fuSaving, setFuSaving] = useState(false);
  const [fuBusyId, setFuBusyId] = useState('');

  // Booking quick-advance busy row
  const [bookingBusyId, setBookingBusyId] = useState('');

  // AI call enhancement (reuses the production scorecard engine — no new AI)
  const [aiEnhancingId, setAiEnhancingId] = useState('');
  const [aiExpanded, setAiExpanded] = useState<Record<string, boolean>>({});
  const [aiCache, setAiCache] = useState<
    Record<
      string,
      {
        loading: boolean;
        error: string;
        status: string;
        data: CallAnalysisData | null;
        score?: number | null;   // done-but-unstructured fallback
        summary?: string;        // done-but-unstructured fallback
        outcome?: string;        // done-but-unstructured fallback
      }
    >
  >({});

  const load = useCallback(async () => {
    if (!guestId) return;
    try {
      const res = await fetch(`/api/crm-calls/guests/${encodeURIComponent(guestId)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(data?.error || `Failed to load guest (HTTP ${res.status})`);
        return;
      }
      setGuest(data.guest || null);
      setMetrics(data.metrics || null);
      setTimeline(Array.isArray(data.timeline) ? data.timeline : []);
      setLoyalty(data.loyalty || null);
      setLoyaltyVisits(Array.isArray(data.loyalty_visits) ? data.loyalty_visits : []);
      setDining(data.dining || null);
      setDiningOrders(Array.isArray(data.dining_orders) ? data.dining_orders : []);
      setLoadError('');
    } catch {
      setLoadError('Network error — could not load this guest.');
    } finally {
      setLoading(false);
    }
  }, [guestId]);

  useEffect(() => { load(); }, [load]);

  // ── Header actions ────────────────────────────────────────────────────────

  async function saveTags(tags: string[]) {
    if (!guest) return;
    setSavingTags(true);
    try {
      const res = await api(`/api/crm-calls/guests/${guest.id}`, { method: 'PUT', body: { tags } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        flash('err', data?.error || 'Could not save tags');
      } else if (data?.guest) {
        setGuest(data.guest);
      }
    } catch {
      flash('err', 'Could not save tags');
    } finally {
      setSavingTags(false);
    }
  }

  function addTag() {
    const t = newTag.trim();
    if (!t || !guest) return;
    if (guest.tags.some((x) => x.toLowerCase() === t.toLowerCase())) { setNewTag(''); return; }
    setNewTag('');
    saveTags([...guest.tags, t]);
  }

  function removeTag(tag: string) {
    if (!guest) return;
    saveTags(guest.tags.filter((t) => t !== tag));
  }

  // ── Synthetic guest → save into CRM ─────────────────────────────────────────
  // A loyalty/dining-only guest has no ct_guests row yet (id = "phone:…").
  // Create it, then navigate to the real (saved) guest so write actions work.
  async function saveToCrm() {
    if (!guest || savingToCrm) return;
    setSavingToCrm(true);
    try {
      const res = await api('/api/crm-calls/guests', {
        method: 'POST',
        body: { phone: guest.phone_e164, name: guest.name },
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.guest?.id) {
        router.push(`/crm-calls/guests/${json.guest.id}`);
        return;
      }
      if (res.status === 409 && json?.existing_guest_id) {
        router.push(`/crm-calls/guests/${json.existing_guest_id}`);
        return;
      }
      flash('err', json?.error || 'Could not save this guest to the CRM');
    } catch {
      flash('err', 'Could not save this guest to the CRM');
    } finally {
      setSavingToCrm(false);
    }
  }

  // ── Edit mode ─────────────────────────────────────────────────────────────

  function openEdit() {
    if (!guest) return;
    setEditForm({
      name: guest.name || '',
      email: guest.email || '',
      dob: guest.dob || '',
      anniversary: guest.anniversary || '',
      notes: guest.notes || '',
    });
    setEditPrefs(
      Object.entries(guest.preferences || {}).map(([k, v]) => ({ k, v: String(v ?? '') })),
    );
    setEditing(true);
  }

  async function saveEdit() {
    if (!guest || saving) return;
    setSaving(true);
    try {
      const preferences: Record<string, string> = {};
      for (const p of editPrefs) {
        const k = p.k.trim();
        if (k) preferences[k] = p.v.trim();
      }
      const res = await api(`/api/crm-calls/guests/${guest.id}`, {
        method: 'PUT',
        body: {
          name: editForm.name,
          email: editForm.email,
          dob: editForm.dob,
          anniversary: editForm.anniversary,
          notes: editForm.notes,
          preferences,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        flash('err', data?.error || 'Could not save changes');
        return;
      }
      if (data?.guest) setGuest(data.guest);
      setEditing(false);
      flash('ok', 'Guest updated');
    } catch {
      flash('err', 'Could not save changes');
    } finally {
      setSaving(false);
    }
  }

  // ── Timeline actions ──────────────────────────────────────────────────────

  async function advanceBooking(bookingId: string, next: string) {
    setBookingBusyId(bookingId);
    try {
      const res = await api(`/api/crm-calls/bookings/${bookingId}`, { method: 'PUT', body: { status: next } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        flash('err', data?.error || 'Could not update the booking');
      } else {
        flash('ok', `Booking marked ${next.replace('_', ' ')}`);
        await load();
      }
    } catch {
      flash('err', 'Could not update the booking');
    } finally {
      setBookingBusyId('');
    }
  }

  async function completeFollowUp(followUpId: string) {
    if (!guest) return;
    setFuBusyId(followUpId);
    try {
      const res = await api(`/api/crm-calls/guests/${guest.id}`, {
        method: 'PUT',
        body: { action: 'complete_follow_up', follow_up_id: followUpId },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        flash('err', data?.error || 'Could not complete the follow-up');
      } else {
        await load();
      }
    } catch {
      flash('err', 'Could not complete the follow-up');
    } finally {
      setFuBusyId('');
    }
  }

  async function addFollowUp() {
    if (!guest || fuSaving) return;
    const due = new Date(fuDue);
    if (!fuDue || isNaN(due.getTime())) {
      flash('err', 'Pick a due date & time for the follow-up');
      return;
    }
    setFuSaving(true);
    try {
      const res = await api(`/api/crm-calls/guests/${guest.id}`, {
        method: 'PUT',
        body: { action: 'add_follow_up', due_at: due.toISOString(), note: fuNote.trim() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        flash('err', data?.error || 'Could not add the follow-up');
      } else {
        setFuOpen(false);
        setFuDue('');
        setFuNote('');
        flash('ok', 'Follow-up scheduled');
        await load();
      }
    } catch {
      flash('err', 'Could not add the follow-up');
    } finally {
      setFuSaving(false);
    }
  }

  function openQuickBooking(sourceCallId?: string) {
    setBookingSourceCall(sourceCallId);
    setBookingOpen(true);
  }

  // ── AI call enhancement ─────────────────────────────────────────────────────

  // GET the stored scorecard for a call and cache it for inline rendering.
  const fetchAnalysis = useCallback(async (callId: string) => {
    setAiCache((prev) => ({
      ...prev,
      [callId]: { loading: true, error: '', status: '', data: prev[callId]?.data ?? null },
    }));
    try {
      const res = await fetch(`/api/crm-calls/calls/${callId}/analyze`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAiCache((prev) => ({
          ...prev,
          [callId]: {
            loading: false,
            error: data?.error || data?.analysis_error || `Failed to load analysis (HTTP ${res.status})`,
            status: data?.status || 'error',
            data: null,
          },
        }));
        return;
      }
      // The scorecard may arrive as { analysis } or as the bare CallAnalysisData object.
      const analysis: CallAnalysisData | null =
        data?.analysis && typeof data.analysis === 'object'
          ? data.analysis
          : data && typeof data === 'object' && (data.dimensions || data.kind === 'call_analysis')
            ? data
            : null;
      const status = data?.status || data?.analysis_status || (analysis ? 'done' : '');
      const error = data?.error || data?.analysis_error || '';
      const score = typeof data?.score === 'number' ? data.score : null;
      const summary = typeof data?.summary === 'string' ? data.summary : '';
      const outcome = typeof data?.outcome === 'string' ? data.outcome : '';
      setAiCache((prev) => ({
        ...prev,
        [callId]: { loading: false, error, status, data: analysis, score, summary, outcome },
      }));
    } catch {
      setAiCache((prev) => ({
        ...prev,
        [callId]: { loading: false, error: 'Network error — could not load the AI analysis.', status: 'error', data: null },
      }));
    }
  }, []);

  // Expand/collapse the inline scorecard; lazy-fetch on first open.
  function toggleAnalysis(callId: string) {
    const willExpand = !aiExpanded[callId];
    setAiExpanded((prev) => ({ ...prev, [callId]: willExpand }));
    if (willExpand) {
      const cached = aiCache[callId];
      if (!cached?.data && !cached?.loading) fetchAnalysis(callId);
    }
  }

  // Fire the production scorecard engine for a call, then reflect the score.
  async function enhanceCall(callId: string) {
    if (aiEnhancingId) return;
    setAiEnhancingId(callId);
    try {
      const res = await api(`/api/crm-calls/calls/${callId}/analyze`, { method: 'POST', body: {} });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        const msg =
          data?.error ||
          (data?.status === 'rate_limited' ? 'AI provider is busy — try again shortly' : 'AI analysis failed');
        flash('err', msg);
        await load(); // reflect 'error'/'skipped' status back onto the chip/button
        return;
      }
      // Reflect the fresh scorecard straight from the POST body — in ephemeral
      // mode nothing is persisted, so a follow-up GET would come back empty and
      // throw the result away. A structured object renders the full card; a
      // done-but-unstructured result (analysis === null) still carries its
      // status/score/summary here, so the panel shows that gracefully instead of
      // re-fetching into an empty state or getting stuck on a perpetual "Loading…".
      if (data?.analysis && typeof data.analysis === 'object') {
        setAiCache((prev) => ({
          ...prev,
          [callId]: {
            loading: false, error: '', status: data?.status || 'done', data: data.analysis,
            score: typeof data?.score === 'number' ? data.score : null,
          },
        }));
      } else {
        setAiCache((prev) => ({
          ...prev,
          [callId]: {
            loading: false,
            error: data?.error || data?.analysis_error || '',
            status: data?.status || data?.analysis_status || 'done',
            data: null,
            score: typeof data?.score === 'number' ? data.score : null,
            summary: typeof data?.summary === 'string' ? data.summary : '',
            outcome: typeof data?.outcome === 'string' ? data.outcome : '',
          },
        }));
      }
      // Optimistically reflect "analysed" onto the timeline row. In ephemeral
      // mode nothing is persisted, so refetching via load() would revert
      // analysis_status back to '' — flipping the chip back to "Enhance with AI"
      // (and re-clicking would re-run the paid AI). Patch locally instead of
      // reloading, so the chip + collapse control stick and the POST-body
      // scorecard cached above isn't thrown away.
      setTimeline((prev) =>
        prev.map((e) =>
          e.type === 'call' && e.id === callId
            ? {
                ...e,
                analysis_status: 'done',
                analysis_score: typeof data?.score === 'number' ? data.score : e.analysis_score,
              }
            : e,
        ),
      );
      setAiExpanded((prev) => ({ ...prev, [callId]: true }));
      flash('ok', typeof data?.score === 'number' ? `AI analysis ready — score ${data.score}/100` : 'AI analysis ready');
    } catch {
      flash('err', 'AI analysis failed');
    } finally {
      setAiEnhancingId('');
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-[#af4408]" />
      </div>
    );
  }

  if (loadError || !guest) {
    return (
      <div>
        <button
          onClick={() => router.push('/crm-calls/guests')}
          className="flex items-center gap-2 text-[#8B7355] hover:text-[#3D2614] mb-6 transition-colors"
        >
          <ArrowLeft size={18} /> <span>Back to Guests</span>
        </button>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <User size={32} className="mx-auto text-[#B9A48C] mb-3" />
          <p className="text-[#2D1B0E] font-medium">{loadError || 'Guest not found'}</p>
          <p className="text-sm text-[#8B7355] mt-1">The guest may have been removed, or the link is stale.</p>
        </div>
      </div>
    );
  }

  const badgeStyle = BADGE_STYLES[metrics?.badge || ''] || 'bg-[#FFF1E3] text-[#af4408] border-[#E8D5C4]';
  const prefEntries = Object.entries(guest.preferences || {}).filter(([k]) => k);
  const noteLines = (guest.notes || '').split('\n').map((l) => l.trim()).filter(Boolean);

  return (
    <div className="max-w-5xl">
      {/* Toast */}
      {toast && (
        <div
          role="status"
          aria-live={toast.kind === 'err' ? 'assertive' : 'polite'}
          aria-atomic="true"
          className={`fixed top-4 right-4 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium border ${
            toast.kind === 'ok'
              ? 'bg-green-50 text-green-800 border-green-200'
              : 'bg-red-50 text-red-800 border-red-200'
          }`}
        >
          {toast.text}
        </div>
      )}

      <button
        onClick={() => router.push('/crm-calls/guests')}
        className="flex items-center gap-2 text-[#8B7355] hover:text-[#3D2614] mb-6 transition-colors"
      >
        <ArrowLeft size={18} /> <span>Back to Guests</span>
      </button>

      {/* Synthetic (loyalty/dining-only) guest — not yet saved to the CRM */}
      {guest.synthetic && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <p className="text-sm text-amber-800 flex-1 min-w-0">
            This guest was seen via loyalty/dining and isn&apos;t saved to the CRM yet. Save to add notes, tags &amp; follow-ups.
          </p>
          <button
            onClick={saveToCrm}
            disabled={savingToCrm}
            className="flex items-center gap-2 shrink-0 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            {savingToCrm ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Save to CRM
          </button>
        </div>
      )}

      {/* ── Header card ── */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-6 mb-6">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-[#2D1B0E] truncate" title={guest.name || 'Unknown Guest'}>
                {guest.name || 'Unknown Guest'}
              </h1>
              <span className={`inline-flex items-center text-xs font-semibold px-2.5 py-1 rounded-full border ${badgeStyle}`}>
                {metrics?.badge || 'NEW CALLER'}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-2 flex-wrap text-[#6B5744]">
              <span className="font-mono text-base text-[#2D1B0E]">{formatPhone(guest.phone_e164)}</span>
              <CallbackButton
                phone={guest.phone_e164}
                guestId={guest.id}
                guestName={guest.name}
                label="Call"
                onLogged={() => load()}
              />
              {guest.alt_phone && (
                <span className="text-xs text-[#8B7355]">Alt: {formatPhone(guest.alt_phone)}</span>
              )}
              {guest.email && <span className="text-xs text-[#8B7355]">{guest.email}</span>}
            </div>

            {/* Tag chips — always editable */}
            <div className="flex items-center gap-1.5 mt-3 flex-wrap">
              <Tag size={14} className="text-[#8B7355]" />
              {guest.tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-[#FFF1E3] text-[#af4408] border border-[#E8D5C4]"
                >
                  {t}
                  <button
                    onClick={() => removeTag(t)}
                    disabled={savingTags}
                    className="hover:text-[#8a3506] disabled:opacity-50"
                    aria-label={`Remove tag ${t}`}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              {!guest.synthetic && (
                <span className="inline-flex items-center gap-1">
                  <input
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addTag(); }}
                    placeholder="Add tag"
                    className="w-24 text-xs px-2 py-1 rounded-full border border-dashed border-[#E8D5C4] bg-white focus:outline-none focus:border-[#af4408] text-[#2D1B0E]"
                  />
                  <button
                    onClick={addTag}
                    disabled={savingTags || !newTag.trim()}
                    className="text-[#af4408] hover:text-[#8a3506] disabled:opacity-40"
                    aria-label="Add tag"
                  >
                    {savingTags ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  </button>
                </span>
              )}
            </div>
          </div>

          {!guest.synthetic && (
            <div className="flex gap-2 shrink-0 flex-wrap">
              <button
                onClick={() => openQuickBooking()}
                className="flex items-center gap-2 bg-[#af4408] hover:bg-[#8a3506] text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                <CalendarPlus size={16} /> Quick Booking
              </button>
              <button
                onClick={() => setFuOpen((v) => !v)}
                className="flex items-center gap-2 bg-white hover:bg-[#FFF1E3] text-[#af4408] border border-[#E8D5C4] px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                <Clock size={16} /> Follow-up
              </button>
              {!editing && (
                <button
                  onClick={openEdit}
                  className="flex items-center gap-2 bg-white hover:bg-[#FFF1E3] text-[#6B5744] border border-[#E8D5C4] px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  <Edit size={16} /> Edit
                </button>
              )}
            </div>
          )}
        </div>

        {/* Follow-up mini form */}
        {fuOpen && (
          <div className="mt-4 p-3 rounded-lg bg-[#FFF8F0] border border-[#E8D5C4] flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="flex-1 min-w-0">
              <label className="block text-xs text-[#8B7355] mb-1">Due (date & time)</label>
              <input
                type="datetime-local"
                value={fuDue}
                onChange={(e) => setFuDue(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
              />
            </div>
            <div className="flex-[2] min-w-0">
              <label className="block text-xs text-[#8B7355] mb-1">Note</label>
              <input
                value={fuNote}
                onChange={(e) => setFuNote(e.target.value)}
                placeholder="e.g. Call back about Sunday party quote"
                className="w-full px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={addFollowUp}
                disabled={fuSaving}
                className="flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {fuSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save
              </button>
              <button
                onClick={() => setFuOpen(false)}
                className="px-3 py-2 rounded-lg text-sm text-[#8B7355] hover:bg-[#FFF1E3] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── Profile details / inline edit ── */}
        {!editing ? (
          <div className="mt-4 pt-4 border-t border-[#F4E8DA] grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            <div className="flex items-start gap-2 text-sm">
              <Cake size={15} className="text-[#8B7355] mt-0.5 shrink-0" />
              <div>
                <span className="text-[#8B7355]">Birthday: </span>
                <span className="text-[#2D1B0E]">{fmtDateOnly(guest.dob)}</span>
                <span className="text-[#8B7355] ml-4">Anniversary: </span>
                <span className="text-[#2D1B0E]">{fmtDateOnly(guest.anniversary)}</span>
              </div>
            </div>
            <div className="flex items-start gap-2 text-sm">
              <Heart size={15} className="text-[#8B7355] mt-0.5 shrink-0" />
              <div className="flex flex-wrap gap-1.5">
                {prefEntries.length === 0 && <span className="text-[#8B7355]">No preferences noted</span>}
                {prefEntries.map(([k, v]) => (
                  <span key={k} className="text-xs px-2.5 py-1 rounded-full bg-[#FFF8F0] border border-[#E8D5C4] text-[#6B5744]">
                    <span className="font-medium text-[#2D1B0E]">{k}</span>{String(v ?? '') ? `: ${String(v)}` : ''}
                  </span>
                ))}
              </div>
            </div>
            {noteLines.length > 0 && (
              <div className="sm:col-span-2 flex items-start gap-2 text-sm">
                <StickyNote size={15} className="text-[#8B7355] mt-0.5 shrink-0" />
                <div className="space-y-1 min-w-0">
                  {noteLines.map((l, i) => (
                    <p key={i} className="text-[#2D1B0E] break-words">{l}</p>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 pt-4 border-t border-[#F4E8DA]">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[#8B7355] mb-1">Name</label>
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                />
              </div>
              <div>
                <label className="block text-xs text-[#8B7355] mb-1">Email</label>
                <input
                  value={editForm.email}
                  onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                />
              </div>
              <div>
                <label className="block text-xs text-[#8B7355] mb-1">Birthday</label>
                <input
                  type="date"
                  value={editForm.dob}
                  onChange={(e) => setEditForm((f) => ({ ...f, dob: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                />
              </div>
              <div>
                <label className="block text-xs text-[#8B7355] mb-1">Anniversary</label>
                <input
                  type="date"
                  value={editForm.anniversary}
                  onChange={(e) => setEditForm((f) => ({ ...f, anniversary: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                />
              </div>
            </div>

            {/* Preferences editor — key/value rows */}
            <div className="mt-3">
              <label className="block text-xs text-[#8B7355] mb-1">
                Preferences (seating, dietary, favourite dishes…)
              </label>
              <div className="space-y-2">
                {editPrefs.map((p, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input
                      value={p.k}
                      onChange={(e) => setEditPrefs((rows) => rows.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))}
                      placeholder="e.g. seating"
                      className="w-36 sm:w-44 px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                    />
                    <input
                      value={p.v}
                      onChange={(e) => setEditPrefs((rows) => rows.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))}
                      placeholder="e.g. window table"
                      className="flex-1 px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                    />
                    <button
                      onClick={() => setEditPrefs((rows) => rows.filter((_, j) => j !== i))}
                      className="text-red-400 hover:text-red-500 p-1"
                      aria-label="Remove preference"
                    >
                      <X size={15} />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setEditPrefs((rows) => [...rows, { k: '', v: '' }])}
                  className="flex items-center gap-1.5 text-xs text-[#af4408] hover:text-[#8a3506] font-medium"
                >
                  <Plus size={13} /> Add preference
                </button>
              </div>
            </div>

            <div className="mt-3">
              <label className="block text-xs text-[#8B7355] mb-1">Notes</label>
              <textarea
                value={editForm.notes}
                onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                rows={3}
                className="w-full px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
              />
            </div>

            <div className="flex gap-2 mt-4">
              <button
                onClick={saveEdit}
                disabled={saving}
                className="flex items-center gap-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save changes
              </button>
              <button
                onClick={() => setEditing(false)}
                disabled={saving}
                className="px-4 py-2 rounded-lg text-sm text-[#8B7355] hover:bg-[#FFF1E3] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Metrics strip ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 sm:gap-4 mb-6">
        {[
          { label: 'Calls', value: metrics?.total_calls ?? 0, sub: metrics?.last_call_at ? `${metrics?.missed_calls ?? 0} missed · last call ${fmtIst(metrics.last_call_at).split(',')[0]}` : `${metrics?.missed_calls ?? 0} missed` },
          { label: 'Bookings', value: metrics?.total_bookings ?? 0, sub: '' },
          { label: 'Visits', value: metrics?.completed_visits ?? 0, sub: metrics?.last_visit_at ? `last ${fmtIst(metrics.last_visit_at)}` : '' },
          { label: 'No-shows', value: metrics?.no_shows ?? 0, sub: '' },
          { label: 'Conversion', value: `${Math.round((metrics?.conversion_rate ?? 0) * 100)}%`, sub: 'answered → booked' },
        ].map((m) => (
          <div key={m.label} className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
            <p className="text-xs text-[#8B7355] uppercase tracking-wide">{m.label}</p>
            <p className="text-xl font-bold text-[#2D1B0E] mt-1">{m.value}</p>
            {m.sub && <p className="text-[11px] text-[#8B7355] mt-0.5 truncate">{m.sub}</p>}
          </div>
        ))}
      </div>

      {/* ── Loyalty & Dining (unified 360, keyed by phone) ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {/* Loyalty card */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-6">
          <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2 mb-4">
            <Award size={18} /> Loyalty
          </h2>

          {loyalty ? (
            <>
              <div className="flex items-end gap-3 flex-wrap">
                <div>
                  <p className="text-3xl font-bold text-[#2D1B0E] leading-none">
                    {Math.round(Number(loyalty.points) || 0).toLocaleString('en-IN')}
                  </p>
                  <p className="text-xs text-[#8B7355] uppercase tracking-wide mt-1">points</p>
                </div>
                <span
                  className={`inline-flex items-center text-xs font-semibold px-2.5 py-1 rounded-full border ${
                    TIER_CHIP_STYLES[loyalty.tier] || 'bg-[#FFF1E3] text-[#af4408] border-[#E8D5C4]'
                  }`}
                >
                  {loyalty.tier || 'Bronze'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 mt-4">
                <div className="rounded-lg bg-[#FFF8F0] border border-[#F4E8DA] p-3">
                  <p className="text-xs text-[#8B7355] uppercase tracking-wide">Visits</p>
                  <p className="text-lg font-bold text-[#2D1B0E] mt-0.5">{loyalty.visit_count ?? 0}</p>
                </div>
                <div className="rounded-lg bg-[#FFF8F0] border border-[#F4E8DA] p-3">
                  <p className="text-xs text-[#8B7355] uppercase tracking-wide">Spend</p>
                  <p className="text-lg font-bold text-[#2D1B0E] mt-0.5">{inr(loyalty.total_spend)}</p>
                </div>
              </div>

              {(loyalty.first_visit_at || loyalty.last_visit_at) && (
                <p className="text-[11px] text-[#8B7355] mt-3">
                  {loyalty.first_visit_at && <>First visit {fmtDateOnly(loyalty.first_visit_at)}</>}
                  {loyalty.first_visit_at && loyalty.last_visit_at && ' · '}
                  {loyalty.last_visit_at && <>Last visit {fmtDateOnly(loyalty.last_visit_at)}</>}
                </p>
              )}

              {loyaltyVisits.length > 0 && (
                <div className="mt-4 pt-4 border-t border-[#F4E8DA] space-y-2">
                  {loyaltyVisits.slice(0, 5).map((v) => (
                    <div key={v.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-[#6B5744] min-w-0 truncate">{fmtIst(v.visited_at)}</span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="text-[#2D1B0E] font-medium">{inr(v.bill_amount)}</span>
                        <span className="text-green-700 font-semibold">+{Math.round(Number(v.points_earned) || 0)} pts</span>
                        {v.source && <span className="text-[#B9A48C]">{v.source}</span>}
                      </span>
                    </div>
                  ))}
                  {loyaltyVisits.length > 5 && (
                    <p className="text-[11px] text-[#8B7355]">+{loyaltyVisits.length - 5} more</p>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-[#8B7355] py-6 text-center">No loyalty record yet.</p>
          )}
        </div>

        {/* Dining card */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-6">
          <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2 mb-4">
            <Utensils size={18} /> Dining
          </h2>

          {dining ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Orders', value: dining.orders ?? 0 },
                { label: 'Visits', value: dining.visits ?? 0 },
                { label: 'Spend', value: inr(dining.total_spent) },
                { label: 'QR', value: dining.qr_orders ?? 0 },
              ].map((s) => (
                <div key={s.label} className="rounded-lg bg-[#FFF8F0] border border-[#F4E8DA] p-3">
                  <p className="text-xs text-[#8B7355] uppercase tracking-wide">{s.label}</p>
                  <p className="text-lg font-bold text-[#2D1B0E] mt-0.5 truncate">{s.value}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[#8B7355] py-6 text-center">No dine-in / QR orders yet.</p>
          )}

          {diningOrders.length > 0 ? (
            <div className="mt-4 pt-4 border-t border-[#F4E8DA] overflow-x-auto">
              <table className="w-full text-xs min-w-[420px]">
                <thead>
                  <tr className="text-left text-[#8B7355]">
                    <th className="font-medium py-1.5 pr-3">Order</th>
                    <th className="font-medium py-1.5 pr-3">Date</th>
                    <th className="font-medium py-1.5 pr-3">Table</th>
                    <th className="font-medium py-1.5 pr-3 text-right">Items</th>
                    <th className="font-medium py-1.5 pr-3">Status</th>
                    <th className="font-medium py-1.5 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {diningOrders.slice(0, 6).map((o) => (
                    <tr key={o.id} className="border-t border-[#F4E8DA]">
                      <td className="py-1.5 pr-3 text-[#2D1B0E] font-medium whitespace-nowrap">{o.order_number || '—'}</td>
                      <td className="py-1.5 pr-3 text-[#6B5744] whitespace-nowrap">{fmtIst(o.created_at)}</td>
                      <td className="py-1.5 pr-3 text-[#6B5744] whitespace-nowrap">{o.table_number || '—'}</td>
                      <td className="py-1.5 pr-3 text-[#6B5744] text-right">{o.item_count ?? 0}</td>
                      <td className="py-1.5 pr-3 text-[#6B5744] whitespace-nowrap">{(o.status || '—').replace('_', ' ')}</td>
                      <td className="py-1.5 text-[#2D1B0E] font-medium text-right whitespace-nowrap">{inr(o.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            dining && <p className="text-sm text-[#8B7355] mt-4 pt-4 border-t border-[#F4E8DA] text-center">No orders yet.</p>
          )}
        </div>
      </div>

      {/* ── Unified timeline ── */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2 mb-4">
          <CalendarDays size={18} /> Timeline
          <span className="text-xs font-normal text-[#8B7355]">({timeline.length} events, newest first)</span>
        </h2>

        {timeline.length === 0 && (
          <p className="text-sm text-[#8B7355] py-6 text-center">
            Nothing yet — calls, bookings and follow-ups for this guest will appear here.
          </p>
        )}

        <div className="space-y-0">
          {timeline.map((t, idx) => (
            <div key={`${t.type}-${t.id}`} className="flex gap-3">
              {/* Rail */}
              <div className="flex flex-col items-center">
                <TimelineIcon entry={t} />
                {idx < timeline.length - 1 && <div className="w-px flex-1 bg-[#F4E8DA] my-1" />}
              </div>

              {/* Body */}
              <div className="flex-1 min-w-0 pb-5">
                <p className="text-xs text-[#8B7355]">{fmtIst(t.at)}</p>

                {t.type === 'call' && (
                  <div className="mt-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-[#2D1B0E]">
                        {t.direction === 'outbound' ? 'Outgoing call' : 'Incoming call'}
                        {t.status && t.status !== 'answered' ? ` — ${String(t.status).replace('_', ' ')}` : ''}
                      </span>
                      {t.status === 'answered' && (
                        <span className="text-xs text-[#8B7355]">{fmtDuration(t.duration_sec)}</span>
                      )}
                      {(t.agent_display || t.agent_user) && <span className="text-xs text-[#8B7355]">· {t.agent_display || t.agent_user}</span>}
                      {t.queue && <span className="text-xs text-[#B9A48C]">· {t.queue}</span>}
                      {t.disposition && (
                        <span className={`badge ${t.disposition === 'booking_made' ? 'badge-success' : t.disposition === 'complaint' ? 'badge-danger' : 'badge-primary'}`}>
                          {DISPOSITION_LABELS[t.disposition] || t.disposition}
                        </span>
                      )}
                      {t.status === 'answered' && (
                        <button
                          onClick={() => openQuickBooking(t.id)}
                          className="flex items-center gap-1 text-xs text-[#af4408] hover:text-[#8a3506] font-medium"
                          title="Create a booking from this call"
                        >
                          <CalendarPlus size={13} /> Book
                        </button>
                      )}
                      {/* AI call enhancement — chip when analysed, else Enhance button.
                          In ephemeral retention the timeline row's analysis_status stays ''
                          (nothing persisted), so also treat a locally-cached analysis (from
                          the enhance POST body / a prior fetch, or an open panel) as analysed
                          so the collapsible chip renders and the user can collapse it. */}
                      {t.has_recording && (() => {
                        const cached = aiCache[t.id];
                        const analysed =
                          t.analysis_status === 'done' ||
                          !!aiExpanded[t.id] ||
                          !!(cached && (cached.data || cached.status === 'done' || typeof cached.score === 'number' || cached.summary));
                        const chipScore =
                          typeof t.analysis_score === 'number'
                            ? t.analysis_score
                            : typeof cached?.score === 'number'
                              ? cached.score
                              : null;
                        return analysed ? (
                          <button
                            onClick={() => toggleAnalysis(t.id)}
                            className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border transition-colors ${aiScoreChipStyle(chipScore)}`}
                            title="View AI call analysis"
                            aria-expanded={!!aiExpanded[t.id]}
                          >
                            <Sparkles size={11} />
                            AI {typeof chipScore === 'number' ? chipScore : '✓'}
                            <ChevronRight size={11} className={`transition-transform ${aiExpanded[t.id] ? 'rotate-90' : ''}`} />
                          </button>
                        ) : (
                          <button
                            onClick={() => enhanceCall(t.id)}
                            disabled={!!aiEnhancingId}
                            className="inline-flex items-center gap-1 text-xs text-[#af4408] hover:text-[#8a3506] disabled:opacity-60 font-medium"
                            title="Analyse this recording with AI"
                          >
                            {aiEnhancingId === t.id ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                            {aiEnhancingId === t.id
                              ? 'Analyzing…'
                              : t.analysis_status === 'error'
                                ? 'Retry AI'
                                : 'Enhance with AI'}
                          </button>
                        );
                      })()}
                    </div>
                    {t.disposition_note && (
                      <p className="text-xs text-[#6B5744] mt-1 break-words">{t.disposition_note}</p>
                    )}
                    {t.has_recording && (
                      <audio
                        controls
                        preload="none"
                        src={`/api/telecmi/recording/${t.id}`}
                        className="mt-2 w-full max-w-sm h-9"
                      />
                    )}
                    {/* Inline AI scorecard (expanded) */}
                    {t.has_recording && aiExpanded[t.id] && (
                      <div className="mt-3">
                        {(() => {
                          const c = aiCache[t.id];
                          if (!c || c.loading) {
                            return (
                              <div className="flex items-center gap-2 text-sm text-[#8B7355] py-3">
                                <Loader2 size={16} className="animate-spin text-[#af4408]" /> Loading AI analysis…
                              </div>
                            );
                          }
                          if (c.status === 'error' || c.error) {
                            return (
                              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                                <div className="min-w-0">
                                  <p className="font-medium">AI analysis failed</p>
                                  <p className="text-xs mt-0.5 break-words">
                                    {c.error || 'Something went wrong analysing this recording.'}
                                  </p>
                                </div>
                              </div>
                            );
                          }
                          if (c.data) return <CallAnalysisCard data={c.data} />;
                          // Analysed, but the model output wasn't structured into a
                          // scorecard — surface whatever state we do have (score /
                          // summary) rather than a perpetual "Loading…".
                          if (c.status === 'done' || c.status === 'skipped' || typeof c.score === 'number' || c.summary) {
                            return (
                              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3 text-sm">
                                {typeof c.score === 'number' && (
                                  <p className="font-semibold text-[#2D1B0E]">AI score {c.score}/100</p>
                                )}
                                {c.summary
                                  ? <p className="text-[#6B5744] mt-1 break-words whitespace-pre-line">{c.summary}</p>
                                  : <p className="text-[#8B7355] mt-1">Analysed, but no detailed scorecard was produced for this call.</p>}
                              </div>
                            );
                          }
                          return <p className="text-sm text-[#8B7355] py-3">No AI analysis available for this call yet.</p>;
                        })()}
                      </div>
                    )}
                  </div>
                )}

                {t.type === 'booking' && (
                  <div className="mt-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-[#2D1B0E]">
                        Booking · {t.booking_date || 'no date'}{t.slot_time ? ` ${t.slot_time}` : ''} · {t.party_size ?? '?'} pax
                      </span>
                      <span className={`badge ${BOOKING_STATUS_STYLES[t.status || ''] || 'badge-primary'}`}>
                        {(t.status || 'pending').replace('_', ' ')}
                      </span>
                      {NEXT_BOOKING_STATUS[t.status || ''] && (
                        <button
                          onClick={() => advanceBooking(t.id, NEXT_BOOKING_STATUS[t.status || ''])}
                          disabled={bookingBusyId === t.id}
                          className="flex items-center gap-1 text-xs bg-[#FFF1E3] hover:bg-[#FBE3CC] disabled:opacity-60 text-[#af4408] border border-[#E8D5C4] px-2.5 py-1 rounded-full font-medium transition-colors"
                        >
                          {bookingBusyId === t.id
                            ? <Loader2 size={12} className="animate-spin" />
                            : <ChevronRight size={12} />}
                          Mark {NEXT_BOOKING_STATUS[t.status || ''].replace('_', ' ')}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-[#8B7355] mt-1">
                      {[
                        t.occasion && `Occasion: ${t.occasion}`,
                        t.section_pref && `Section: ${t.section_pref}`,
                        (t.advance_amount || 0) > 0 && `Advance ₹${t.advance_amount}`,
                        t.channel && `via ${t.channel}`,
                        t.source_call_id && 'from a call',
                        t.created_by && `by ${t.created_by}`,
                      ].filter(Boolean).join(' · ')}
                    </p>
                    {t.notes && <p className="text-xs text-[#6B5744] mt-1 break-words">{t.notes}</p>}
                  </div>
                )}

                {t.type === 'follow_up' && (
                  <div className="mt-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-[#2D1B0E]">Follow-up</span>
                      <span className={`badge ${t.status === 'open' ? 'badge-warning' : t.status === 'done' ? 'badge-success' : 'badge-primary'}`}>
                        {t.status || 'open'}
                      </span>
                      <span className="text-xs text-[#8B7355]">due {fmtIst(t.due_at)}</span>
                      {t.assigned_to && <span className="text-xs text-[#B9A48C]">· {t.assigned_to}</span>}
                      {t.status === 'open' && (
                        <button
                          onClick={() => completeFollowUp(t.id)}
                          disabled={fuBusyId === t.id}
                          className="flex items-center gap-1 text-xs bg-green-50 hover:bg-green-100 disabled:opacity-60 text-green-700 border border-green-200 px-2.5 py-1 rounded-full font-medium transition-colors"
                        >
                          {fuBusyId === t.id
                            ? <Loader2 size={12} className="animate-spin" />
                            : <CheckCircle2 size={12} />}
                          Done
                        </button>
                      )}
                    </div>
                    {t.note && <p className="text-xs text-[#6B5744] mt-1 break-words">{t.note}</p>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick Booking modal (shared fleet component) */}
      <QuickBookingModal
        open={bookingOpen}
        onClose={() => setBookingOpen(false)}
        guestId={guest.id}
        guestName={guest.name || formatPhone(guest.phone_e164)}
        sourceCallId={bookingSourceCall}
        onSaved={() => { setBookingOpen(false); load(); }}
      />
    </div>
  );
}

// ─── Timeline rail icon per entry ───────────────────────────────────────────

function TimelineIcon({ entry }: { entry: TimelineEntry }) {
  let icon: React.ReactNode;
  let ring = 'bg-[#FFF1E3] text-[#af4408] border-[#E8D5C4]';

  if (entry.type === 'call') {
    const missedFamily = entry.status === 'missed' || entry.status === 'abandoned';
    if (entry.status === 'voicemail') {
      icon = <Voicemail size={15} />;
      ring = 'bg-amber-50 text-amber-600 border-amber-200';
    } else if (missedFamily) {
      icon = <PhoneMissed size={15} />;
      ring = 'bg-red-50 text-red-600 border-red-200';
    } else if (entry.direction === 'outbound') {
      icon = <PhoneOutgoing size={15} />;
      ring = 'bg-green-50 text-green-600 border-green-200';
    } else {
      icon = <PhoneIncoming size={15} />;
      ring = entry.status === 'answered'
        ? 'bg-green-50 text-green-600 border-green-200'
        : 'bg-[#FFF1E3] text-[#af4408] border-[#E8D5C4]';
    }
  } else if (entry.type === 'booking') {
    icon = <CalendarDays size={15} />;
    ring = entry.status === 'completed'
      ? 'bg-green-50 text-green-600 border-green-200'
      : entry.status === 'no_show' || entry.status === 'cancelled'
        ? 'bg-red-50 text-red-600 border-red-200'
        : 'bg-[#FFF1E3] text-[#af4408] border-[#E8D5C4]';
  } else {
    icon = <Clock size={15} />;
    ring = entry.status === 'done'
      ? 'bg-green-50 text-green-600 border-green-200'
      : 'bg-amber-50 text-amber-600 border-amber-200';
  }

  return (
    <div className={`w-8 h-8 rounded-full border flex items-center justify-center shrink-0 ${ring}`}>
      {icon}
    </div>
  );
}
