'use client';

/**
 * CT Screen-Pop — the "killer feature" of the Call-to-Table CRM.
 *
 * Mounted by src/app/crm-calls/layout.tsx, so the pop lives on every
 * /crm-calls/* page (and ONLY there — documented decision: GREs work inside
 * the CRM section; app-wide popping would interrupt KDS/cashier screens).
 *
 * Transport: EventSource('/api/crm-calls/events') primary; on error falls
 * back to polling /api/crm-calls/live?after=<seq> every 5s while retrying
 * SSE every 30s (same pattern as the Live Calls wallboard).
 *
 * Behavior contract (CRM_DECISIONS.md §5.1):
 * - incoming_call → slide-in card top-right (below the floating bell).
 *   Known guest: name, VIP/tags, badge, calls/bookings counts, last visit
 *   (IST). Unknown: "New caller" + phone + name mini-form → Create Guest.
 * - call_ended for the SAME call does NOT dismiss the card — it switches to
 *   disposition mode: 7 one-tap chips → PUT /api/crm-calls/calls/[id].
 *   "Booking Made" opens QuickBookingModal (pre-filled source_call_id) and
 *   dispositions after the booking saves.
 * - Multiple simultaneous calls stack, max 3 cards.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  PhoneIncoming, PhoneOff, X, UserPlus, CalendarPlus, ExternalLink, Loader2, Star,
} from 'lucide-react';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import QuickBookingModal from './QuickBookingModal';

interface GuestSnap {
  id: string;
  name: string;
  tags: string[];
  total_calls?: number;
  total_bookings?: number;
  last_visit_at?: string | null;
  badge?: string;
}

interface PopCard {
  /** Dedupe key: telecmiCallId || callId || phone */
  key: string;
  telecmiCallId?: string;
  callId?: string;
  phone: string;
  guest: GuestSnap | null;
  agent?: string;
  queue?: string;
  startedAt: string;
  mode: 'ringing' | 'disposition';
  endedAt?: string;
  /** New-caller mini-form name input */
  newName: string;
  creating?: boolean;
  saving?: boolean;
  error: string;
}

/** Loose bus-event shape (SSE + poll deliver the same CtEvent JSON). */
interface AnyEvent {
  type?: string;
  callId?: string;
  telecmiCallId?: string;
  phone?: string;
  guest?: GuestSnap | null;
  agent?: string;
  queue?: string;
  at?: string;
}

const MAX_CARDS = 5;

const DISPOSITIONS: Array<{ value: string; label: string }> = [
  { value: 'booking_made', label: 'Booking Made' },
  { value: 'enquiry', label: 'Enquiry' },
  { value: 'event_enquiry', label: 'Event' },
  { value: 'complaint', label: 'Complaint' },
  { value: 'wrong_number', label: 'Wrong No.' },
  { value: 'follow_up_needed', label: 'Follow-up' },
  { value: 'no_action', label: 'No Action' },
];

const istDay = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
};

const eventKey = (e: AnyEvent): string => String(e.telecmiCallId || e.callId || e.phone || '');

/**
 * Append a card, enforcing the max-3 stack. When full, drop an already-ended
 * (disposition-mode) card first — a live ringing call always wins the slot.
 * We permanently suppress (add to `dismissed`) ONLY an ended card; if we're
 * forced to evict a still-ringing card (all slots ringing), we drop it WITHOUT
 * suppressing so it can re-pop from the poll once a slot frees — a live caller
 * must never be hidden forever.
 */
function pushCard(list: PopCard[], card: PopCard, dismissed: Set<string>): PopCard[] {
  const next = [...list, card];
  if (next.length <= MAX_CARDS) return next;
  let idx = next.findIndex(c => c.mode === 'disposition');
  if (idx === -1 || idx === next.length - 1) idx = 0;
  if (next[idx].mode === 'disposition') dismissed.add(next[idx].key);
  next.splice(idx, 1);
  return next;
}

export default function CTScreenPop() {
  const [cards, setCards] = useState<PopCard[]>([]);
  const [booking, setBooking] = useState<{
    cardKey: string;
    guestId?: string;
    guestName?: string;
    sourceCallId?: string;
    dispositionAfter: boolean;
  } | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  const cardsRef = useRef<PopCard[]>([]);
  const seqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Keys the user dismissed / completed — never re-pop them from the poll. */
  const dismissedRef = useRef<Set<string>>(new Set());

  useEffect(() => { cardsRef.current = cards; }, [cards]);

  // 1s tick drives the ringing-seconds counter (only while something rings).
  const hasRinging = cards.some(c => c.mode === 'ringing');
  useEffect(() => {
    if (!hasRinging) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasRinging]);

  const updateCard = useCallback((key: string, patch: Partial<PopCard>) => {
    setCards(prev => prev.map(c => (c.key === key ? { ...c, ...patch } : c)));
  }, []);

  const removeCard = useCallback((key: string) => {
    dismissedRef.current.add(key);
    setCards(prev => prev.filter(c => c.key !== key));
  }, []);

  // ── Event handling (shared by SSE + poll) ─────────────────────────────────
  const handleEvent = useCallback((e: AnyEvent) => {
    if (!e || typeof e !== 'object' || !e.type) return;

    if (e.type === 'incoming_call') {
      const key = eventKey(e);
      if (!key || dismissedRef.current.has(key)) return;
      setCards(prev => {
        const existing = prev.find(c => c.key === key);
        if (existing) {
          // Ring repeat / richer payload — merge ids and guest, never duplicate.
          return prev.map(c => c.key === key
            ? { ...c, callId: c.callId || e.callId, guest: c.guest || e.guest || null }
            : c);
        }
        return pushCard(prev, {
          key,
          telecmiCallId: e.telecmiCallId,
          callId: e.callId,
          phone: String(e.phone || ''),
          guest: e.guest || null,
          agent: e.agent || '',
          queue: e.queue || '',
          startedAt: e.at || new Date().toISOString(),
          mode: 'ringing',
          newName: '',
          error: '',
        }, dismissedRef.current);
      });
      return;
    }

    if (e.type === 'call_ended') {
      // Same call → do NOT dismiss; switch the card to disposition mode.
      setCards(prev => {
        const idx = prev.findIndex(c =>
          (!!e.telecmiCallId && c.telecmiCallId === e.telecmiCallId) ||
          (!!e.callId && c.callId === e.callId) ||
          (!e.telecmiCallId && !e.callId && !!e.phone && c.phone === e.phone && c.mode === 'ringing'),
        );
        if (idx === -1) return prev;
        const c = prev[idx];
        const next = [...prev];
        next[idx] = {
          ...c,
          mode: 'disposition',
          callId: e.callId || c.callId,
          guest: e.guest || c.guest, // CDR event carries a fresher snapshot
          endedAt: e.at || c.endedAt || new Date().toISOString(),
        };
        return next;
      });
    }
    // recovery_update is not a pop concern.
  }, []);

  /** Merge currently-ringing calls (poll payload) into the stack. */
  const mergeRinging = useCallback((rows: any[]) => {
    if (!Array.isArray(rows) || rows.length === 0) return;
    setCards(prev => {
      let next = prev;
      for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const key = String(r.telecmi_call_id || r.id || r.phone_e164 || '');
        if (!key || dismissedRef.current.has(key)) continue;
        if (next.some(c => c.key === key || (!!r.id && c.callId === r.id))) continue;
        const guest: GuestSnap | null = r.guest_id
          ? {
              id: String(r.guest_id),
              name: String(r.guest_name || ''),
              tags: Array.isArray(r.guest_tags) ? r.guest_tags.map((t: unknown) => String(t)) : [],
            }
          : null;
        next = pushCard(next, {
          key,
          telecmiCallId: r.telecmi_call_id ? String(r.telecmi_call_id) : undefined,
          callId: r.id ? String(r.id) : undefined,
          phone: String(r.phone_e164 || ''),
          guest,
          agent: String(r.agent_user || ''),
          queue: String(r.queue || ''),
          startedAt: String(r.started_at || new Date().toISOString()),
          mode: 'ringing',
          newName: '',
          error: '',
        }, dismissedRef.current);
      }
      return next;
    });
  }, []);

  const pollLive = useCallback(async (processEvents: boolean) => {
    try {
      const r = await fetch(`/api/crm-calls/live?after=${seqRef.current}`);
      if (!r.ok) return;
      let j: any = null;
      try { j = await r.json(); } catch { return; }
      if (typeof j?.seq === 'number') seqRef.current = Math.max(seqRef.current, j.seq);
      mergeRinging(Array.isArray(j?.ringing) ? j.ringing : []);
      if (processEvents && Array.isArray(j?.events)) {
        for (const e of j.events) handleEvent(e);
      }
    } catch { /* transient network error — next tick retries */ }
  }, [handleEvent, mergeRinging]);

  // ── SSE with poll fallback (mirrors the Live Calls wallboard) ─────────────
  useEffect(() => {
    let closed = false;
    const startPolling = () => {
      if (pollTimer.current) return;
      pollTimer.current = setInterval(() => { void pollLive(true); }, 5000);
    };
    const connect = () => {
      if (closed) return;
      try {
        const es = new EventSource('/api/crm-calls/events');
        esRef.current = es;
        es.onopen = () => {
          if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
        };
        es.onmessage = (m) => {
          try { handleEvent(JSON.parse(m.data)); } catch { /* heartbeat */ }
        };
        es.onerror = () => {
          es.close();
          esRef.current = null;
          startPolling();
          if (!closed) setTimeout(connect, 30000); // keep retrying SSE
        };
      } catch {
        startPolling();
      }
    };
    connect();
    // Initial seed: latest seq + mid-ring calls, but SKIP the historical
    // event backlog (after=0 would replay old, long-finished calls).
    void pollLive(false);
    return () => {
      closed = true;
      esRef.current?.close();
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [handleEvent, pollLive]);

  // ── Actions ────────────────────────────────────────────────────────────────

  /** ct_calls.id for a card — from the event, else the live ringing list. */
  const resolveCallId = useCallback(async (card: PopCard): Promise<string | null> => {
    if (card.callId) return card.callId;
    try {
      const r = await fetch(`/api/crm-calls/live?after=${seqRef.current}`);
      if (r.ok) {
        let j: any = null;
        try { j = await r.json(); } catch { return null; }
        const rows: any[] = Array.isArray(j?.ringing) ? j.ringing : [];
        const m = rows.find(x =>
          (card.telecmiCallId && x?.telecmi_call_id === card.telecmiCallId) ||
          (!card.telecmiCallId && card.phone && x?.phone_e164 === card.phone),
        );
        if (m?.id) return String(m.id);
      }
    } catch { /* fall through */ }
    return null;
  }, []);

  const createGuest = useCallback(async (card: PopCard) => {
    if (!card.phone) {
      updateCard(card.key, { error: 'No phone number on this call — cannot create a guest' });
      return;
    }
    updateCard(card.key, { creating: true, error: '' });
    try {
      const res = await api('/api/crm-calls/guests', {
        method: 'POST',
        body: { name: card.newName.trim(), phone: card.phone, source: 'call' },
      });
      let j: any = {};
      try { j = await res.json(); } catch { /* keep {} */ }
      if (res.status === 409 && j?.existing_guest_id) {
        updateCard(card.key, {
          creating: false,
          guest: { id: String(j.existing_guest_id), name: card.newName.trim(), tags: [] },
        });
      } else if (!res.ok) {
        updateCard(card.key, { creating: false, error: j?.error || `Could not create guest (HTTP ${res.status})` });
      } else {
        const g = j?.guest || {};
        updateCard(card.key, {
          creating: false,
          guest: {
            id: String(g.id || ''),
            name: String(g.name || card.newName.trim()),
            tags: Array.isArray(g.tags) ? g.tags.map((t: unknown) => String(t)) : [],
          },
        });
      }
    } catch (e: any) {
      updateCard(card.key, { creating: false, error: e?.message || 'Network error — guest not created' });
    }
  }, [updateCard]);

  const submitDisposition = useCallback(async (card: PopCard, value: string) => {
    updateCard(card.key, { saving: true, error: '' });
    const callId = await resolveCallId(card);
    if (!callId) {
      updateCard(card.key, { saving: false, error: 'Call record not found yet — try again in a moment.' });
      return;
    }
    if (!card.callId) updateCard(card.key, { callId });
    try {
      const res = await api(`/api/crm-calls/calls/${callId}`, {
        method: 'PUT',
        body: { disposition: value },
      });
      let j: any = {};
      try { j = await res.json(); } catch { /* keep {} */ }
      if (!res.ok) {
        updateCard(card.key, { saving: false, error: j?.error || `Failed to save (HTTP ${res.status})` });
        return;
      }
      removeCard(card.key); // dispositioned → done
    } catch (e: any) {
      updateCard(card.key, { saving: false, error: e?.message || 'Network error — outcome not saved' });
    }
  }, [removeCard, resolveCallId, updateCard]);

  /** "Booking Made" chip: open Quick Booking first, disposition after save. */
  const openBookingForDisposition = useCallback(async (card: PopCard) => {
    updateCard(card.key, { error: '' });
    const callId = card.callId || (await resolveCallId(card)) || undefined;
    if (callId && !card.callId) updateCard(card.key, { callId });
    setBooking({
      cardKey: card.key,
      guestId: card.guest?.id,
      guestName: card.guest?.name,
      sourceCallId: callId,
      dispositionAfter: true,
    });
  }, [resolveCallId, updateCard]);

  const onChip = useCallback((card: PopCard, value: string) => {
    if (value === 'booking_made') void openBookingForDisposition(card);
    else void submitDisposition(card, value);
  }, [openBookingForDisposition, submitDisposition]);

  /** [+ Quick Booking] while ringing / talking. */
  const openQuickBooking = useCallback((card: PopCard) => {
    setBooking({
      cardKey: card.key,
      guestId: card.guest?.id,
      guestName: card.guest?.name,
      sourceCallId: card.callId,
      dispositionAfter: false,
    });
  }, []);

  const handleBookingSaved = useCallback((b: NonNullable<typeof booking>) => {
    if (!b.dispositionAfter) return;
    const card = cardsRef.current.find(c => c.key === b.cardKey);
    if (card) void submitDisposition(card, 'booking_made');
  }, [submitDisposition]);

  const ringSeconds = (card: PopCard) => {
    const t = new Date(card.startedAt).getTime();
    if (isNaN(t)) return 0;
    return Math.max(0, Math.floor((nowTick - t) / 1000));
  };

  if (cards.length === 0 && !booking) return null;

  return (
    <>
      {/* Below the floating bell; container is click-through, cards are not. */}
      <div className="fixed top-24 right-4 md:right-6 z-50 w-[min(92vw,22.5rem)] space-y-3 pointer-events-none">
        <style>{'@keyframes ctPopSlideIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}'}</style>
        {cards.map(card => {
          const tags = card.guest?.tags || [];
          const isVip = tags.some(t => String(t).toLowerCase() === 'vip');
          const otherTags = tags.filter(t => String(t).toLowerCase() !== 'vip').slice(0, 3);
          return (
            <div key={card.key}
                 style={{ animation: 'ctPopSlideIn .3s ease-out' }}
                 className="pointer-events-auto w-full bg-white border border-[#E8D5C4] rounded-xl shadow-2xl overflow-hidden">
              {/* Header strip */}
              <div className={`flex items-center gap-2 px-3 py-2 text-white ${card.mode === 'ringing' ? 'bg-[#af4408]' : 'bg-[#2D1B0E]'}`}>
                {card.mode === 'ringing'
                  ? <PhoneIncoming className="w-4 h-4 animate-pulse shrink-0" />
                  : <PhoneOff className="w-4 h-4 shrink-0" />}
                <span className="text-xs font-semibold uppercase tracking-wide flex-1 truncate">
                  {card.mode === 'ringing' ? 'Incoming call' : 'Call ended — log outcome'}
                </span>
                {card.mode === 'ringing' && (
                  <span className="text-[11px] tabular-nums opacity-90 shrink-0">{ringSeconds(card)}s</span>
                )}
                <button onClick={() => removeCard(card.key)} aria-label="Dismiss"
                        className="p-0.5 rounded hover:bg-white/20 shrink-0">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-3 space-y-2.5">
                {/* Identity */}
                {card.guest ? (
                  <div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="font-bold text-[#2D1B0E] truncate max-w-full">{card.guest.name || 'Guest'}</p>
                      {isVip && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-300">
                          <Star className="w-3 h-3 fill-amber-500 text-amber-500" /> VIP
                        </span>
                      )}
                      {card.guest.badge && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#FFF1E3] text-[#af4408] border border-[#E8D5C4]">
                          {card.guest.badge}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-[#6B5744] font-mono">{formatPhone(card.phone) || card.phone || '—'}</p>
                    {otherTags.length > 0 && (
                      <div className="flex gap-1 flex-wrap mt-1">
                        {otherTags.map(t => (
                          <span key={String(t)} className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#FFF8F0] text-[#8B7355] border border-[#E8D5C4]">
                            {String(t)}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="text-[11px] text-[#8B7355] mt-1">
                      {card.guest.total_calls ?? 0} calls · {card.guest.total_bookings ?? 0} bookings
                      {card.guest.last_visit_at ? ` · last visit ${istDay(card.guest.last_visit_at)}` : ''}
                    </p>
                    {(card.queue || card.agent) && (
                      <p className="text-[10px] text-[#8B7355] truncate">{[card.queue, card.agent].filter(Boolean).join(' · ')}</p>
                    )}
                  </div>
                ) : (
                  <div>
                    <p className="font-bold text-[#2D1B0E]">New caller</p>
                    <p className="text-sm text-[#6B5744] font-mono">{formatPhone(card.phone) || card.phone || 'Unknown number'}</p>
                    <div className="flex gap-2 mt-2">
                      <input type="text" value={card.newName}
                             onChange={e => updateCard(card.key, { newName: e.target.value })}
                             placeholder="Guest name"
                             className="flex-1 min-w-0 px-2.5 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E]" />
                      <button onClick={() => createGuest(card)} disabled={card.creating || !card.phone}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-xs font-semibold shrink-0">
                        {card.creating
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <UserPlus className="w-3.5 h-3.5" />}
                        Create Guest
                      </button>
                    </div>
                  </div>
                )}

                {card.error && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">{card.error}</p>
                )}

                {card.mode === 'ringing' ? (
                  <div className="flex items-center gap-2 pt-0.5">
                    <button onClick={() => openQuickBooking(card)}
                            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-xs font-semibold">
                      <CalendarPlus className="w-3.5 h-3.5" /> Quick Booking
                    </button>
                    {card.guest?.id && (
                      <Link href={`/crm-calls/guests/${card.guest.id}`}
                            className="inline-flex items-center gap-1 px-3 py-2 bg-[#FFF1E3] hover:bg-[#E8D5C4] text-[#6B5744] rounded-lg text-xs font-semibold shrink-0">
                        <ExternalLink className="w-3.5 h-3.5" /> Profile
                      </Link>
                    )}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="grid grid-cols-2 gap-1.5">
                      {DISPOSITIONS.map((d, i) => (
                        <button key={d.value} disabled={card.saving}
                                onClick={() => onChip(card, d.value)}
                                className={`px-2 py-1.5 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-50 ${
                                  i === 0
                                    ? 'bg-[#af4408] text-white border-[#af4408] hover:bg-[#8a3506]'
                                    : 'bg-white text-[#6B5744] border-[#D4B896] hover:bg-[#FFF1E3]'
                                } ${i === DISPOSITIONS.length - 1 ? 'col-span-2' : ''}`}>
                          {d.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center justify-between">
                      {card.saving ? (
                        <span className="text-[11px] text-[#8B7355] inline-flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" /> Saving…
                        </span>
                      ) : <span />}
                      {card.guest?.id && (
                        <Link href={`/crm-calls/guests/${card.guest.id}`}
                              className="text-[11px] text-[#af4408] font-medium hover:underline inline-flex items-center gap-1">
                          <ExternalLink className="w-3 h-3" /> Open Profile
                        </Link>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {booking && (
        <QuickBookingModal
          open
          onClose={() => setBooking(null)}
          onSaved={() => handleBookingSaved(booking)}
          guestId={booking.guestId}
          guestName={booking.guestName}
          sourceCallId={booking.sourceCallId}
        />
      )}
    </>
  );
}
