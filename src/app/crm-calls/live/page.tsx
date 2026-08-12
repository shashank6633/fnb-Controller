'use client';

/**
 * CRM — Live Calls wallboard.
 *
 * Real-time view of RECEIVING calls: what's ringing right now, today's
 * answer/miss counters ticking live, and a rolling feed of call events.
 * Data: SSE /api/crm-calls/events (primary) + /api/crm-calls/live poll
 * fallback + /api/crm-calls/dashboard for today's aggregates. Designed to be
 * left open on a counter screen (wallboard), so it is glanceable from far:
 * big numbers, pulsing ring cards, color-coded feed.
 *
 * WHO HAS THE CALL. An answered call is owned by one app user, who gets the
 * screen-pop and the disposition write-up while the lock is in force; everyone
 * below Admin/Manager/HOD is refused the write (src/lib/ct/call-owner.ts). This
 * board is a supervisor's view of that: the owner is shown wherever the data
 * carries one. It rides entirely on feeds the board already reads — the SSE/poll
 * event's ownerName and owner_name on the live snapshot rows — so there is no
 * per-row lookup and no new request. NOTE the owner is a different thing from
 * `agent_user`/agentName: that is the raw TeleCMI agent, which for an unmapped
 * agent belongs to no app user at all.
 *
 * OWNERSHIP MOVING IS ITS OWN FEED LINE. A claim, a management takeover and the
 * release a saved disposition broadcasts all arrive as CtEvent 'ownership' —
 * NOT 'answered', which is what they used to be and why a claim four minutes
 * after the hangup printed "Call answered" underneath "Call ended". They change
 * neither the ringing list nor the counters; only who is writing the call up.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PhoneIncoming, PhoneMissed, PhoneCall, Radio, Users, CalendarCheck, ArrowDownLeft, ArrowUpRight,
  MessageCircle, Send, X, Crown, UserCheck,
} from 'lucide-react';
import { formatPhone } from '@/lib/ct/phone';

interface QuickDoc { label: string; url: string; message?: string }

/* ── "Who should take this call" hints (both OFF by default) ────────────────
 * /api/crm-calls/live/routing returns a sticky-agent line and a VIP badge for
 * the ringing numbers. NOT routing: this app does not control the PBX, so the
 * hints only tell the human at the counter what they'd otherwise look up
 * mid-ring. Whether they are on at all rides along on the /api/crm-calls/live
 * poll the board already makes, so with ct_settings.sticky_agent and
 * vip_routing both off (the default) this file issues NO extra request and
 * renders nothing extra — the board is byte-for-byte what it is today. */
interface RoutingHint {
  sticky: {
    agent_user: string;
    agent_label: string;
    last_answered_at: string;
    answered_calls: number;
    total_answered_calls: number;
    window_days: number;
  } | null;
  vip: { isVip: boolean; visits: number; spend: number; reasons: string[] };
}

// Build a wa.me deep link to a number with pre-filled text — opens the GRE's
// WhatsApp to that caller so a menu / band list / corporate menu goes out in
// one tap. Mirrors normalizeWaNumber: bare 10-digit → +91; keep other codes.
function waLink(phone: string, text: string): string {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  return d ? `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}` : '';
}

// Compose the WhatsApp text for one quick-send doc: greeting + (custom message
// OR an auto "Here's our <label>:") + the link when present.
function docText(d: QuickDoc, hi: string): string {
  const msg = (d.message || '').trim();
  const body = msg || `Here's our ${d.label}:`;
  return `${hi}${body}${d.url ? ` ${d.url}` : ''}`.trim();
}

// "Send menu" popover — lists the admin-configured quick-send documents that
// have a link OR a message; each opens WhatsApp to the caller pre-filled.
function SendMenu({ phone, guestName, docs }: { phone: string; guestName?: string; docs: QuickDoc[] }) {
  const [open, setOpen] = useState(false);
  const sendable = docs.filter(d => d.url || (d.message || '').trim());
  const hi = guestName && guestName !== 'Unknown caller' ? `Hi ${guestName}! ` : 'Hello! ';
  if (!phone) return null;
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)}
              className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
              aria-label="Send a document on WhatsApp">
        <MessageCircle className="w-3.5 h-3.5" /> Send
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 z-[61] w-52 bg-white border border-[#E8D5C4] rounded-lg shadow-xl py-1">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#F0E4D6]">
              <span className="text-[10px] font-semibold text-[#8B7355] uppercase tracking-wide">Send on WhatsApp</span>
              <button onClick={() => setOpen(false)} aria-label="Close"><X className="w-3.5 h-3.5 text-[#8B7355]" /></button>
            </div>
            {sendable.length === 0 ? (
              <a href="/crm-calls/settings" className="block px-3 py-2 text-xs text-[#af4408] hover:bg-[#FFF1E3]">
                No documents set up — add links in CRM settings →
              </a>
            ) : sendable.map((d, i) => (
              <button key={i}
                      onClick={() => { window.open(waLink(phone, docText(d, hi)), '_blank'); setOpen(false); }}
                      className="w-full text-left px-3 py-2 text-xs text-[#2D1B0E] hover:bg-[#FFF1E3] flex items-center gap-2">
                <Send className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> {d.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface FeedItem {
  key: string;
  /**
   * The FEED's own row kinds, which are not the bus's event types — 'ownership'
   * in particular must never land on the same row kind as an answer. A claim
   * used to be broadcast as 'answered' and printed "Call answered — Ravi K"
   * minutes AFTER "Call ended"; it now arrives as its own CtEvent type and gets
   * its own row. See handleEvent, where the mapping (and the refusal to guess at
   * an unknown type) lives.
   *
   * EVERY MEMBER HERE IS PRODUCED. 'answered' and 'call_ended' were previously
   * both pushed as 'call_ended' — same grey handset icon for "picked up" and for
   * "over" — while a 'missed' member was declared and never produced at all. A
   * union that lists a row kind nothing emits is a claim about this board that
   * is not true, so the phantom is gone and the answer now uses the member that
   * was already sitting here unused.
   */
  type: 'incoming_call' | 'answered' | 'call_ended' | 'recovery_update' | 'ownership';
  phone?: string;
  guestName?: string;
  agentName?: string;
  /** App user holding the write-up of this answered call ('' = nobody). */
  ownerName?: string;
  at: string;
  label: string;
}

interface RingingCall {
  id?: string;
  telecmi_call_id?: string;
  phone_e164?: string;
  phone?: string;
  guest_name?: string;
  started_at?: string;
  agent_user?: string;
  queue?: string;
  /** Owner of the call, from /api/crm-calls/live. See the ring-card render for
   *  why these are normally blank on a row in THIS list. */
  owner_email?: string;
  owner_name?: string;
}

/** "11 Jul" — the day an answered call happened, for the sticky-agent line. */
const istDay = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
};

const istTime = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
};

export default function LiveCallsPage() {
  const [today, setToday] = useState<{ calls: number; answered: number; missed: number; answered_pct: number; pending_recoveries: number; bookings_from_calls: number } | null>(null);
  const [byHour, setByHour] = useState<Array<{ hour: number; total: number; missed: number }>>([]);
  const [ringing, setRinging] = useState<RingingCall[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [liveMode, setLiveMode] = useState<'sse' | 'poll' | 'connecting'>('connecting');
  const [statsUpdatedAt, setStatsUpdatedAt] = useState<number | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [docs, setDocs] = useState<QuickDoc[]>([]);   // quick-send documents (menu, band list…)
  // Routing hints — null until the first /api/crm-calls/live poll reports the
  // flags; {sticky:false,vip:false} (the default) means the page never fetches
  // hints and renders nothing extra.
  const [hintFlags, setHintFlags] = useState<{ sticky: boolean; vip: boolean } | null>(null);
  const [hints, setHints] = useState<Record<string, RoutingHint>>({});
  const hintReqRef = useRef<Set<string>>(new Set());  // phones already requested (in-flight or done)
  const seqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 1-second tick drives ringing-duration counters
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Load the quick-send documents (menu / band list / corporate menu …) once.
  useEffect(() => {
    fetch('/api/crm-calls/settings')
      .then(r => r.json())
      .then(j => { try { const a = JSON.parse(j?.settings?.quick_send_links || '[]'); if (Array.isArray(a)) setDocs(a.map((x: QuickDoc) => ({ label: String(x?.label || ''), url: String(x?.url || ''), message: String(x?.message || '') }))); } catch { /* ignore */ } })
      .catch(() => {});
  }, []);

  // Fetch hints for any ringing number we haven't asked about yet. Skipped
  // entirely while both flags are off.
  useEffect(() => {
    if (!hintFlags || (!hintFlags.sticky && !hintFlags.vip)) return;
    const want = ringing
      .map(r => r.phone_e164 || r.phone || '')
      .filter(p => p && !hintReqRef.current.has(p));
    if (want.length === 0) return;
    const batch = Array.from(new Set(want)).slice(0, 20);
    for (const p of batch) hintReqRef.current.add(p);
    fetch(`/api/crm-calls/live/routing?phones=${encodeURIComponent(batch.join(','))}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        const got = j?.hints;
        if (!got || typeof got !== 'object') return;
        setHints(prev => {
          const next = { ...prev, ...got };
          // Bound the cache on a wallboard that runs for days.
          const keys = Object.keys(next);
          if (keys.length > 60) {
            for (const k of keys.slice(0, keys.length - 60)) { delete next[k]; hintReqRef.current.delete(k); }
          }
          return next;
        });
      })
      .catch(() => { for (const p of batch) hintReqRef.current.delete(p); });   // allow a retry
  }, [ringing, hintFlags]);

  const pushFeed = useCallback((item: FeedItem) => {
    setFeed(prev => {
      if (prev.some(p => p.key === item.key)) return prev;
      return [item, ...prev].slice(0, 60);
    });
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      const r = await fetch('/api/crm-calls/dashboard?days=1');
      if (!r.ok) { setStatsError(true); return; }
      const j = await r.json();
      if (j?.today) setToday(j.today);
      if (Array.isArray(j?.byHour)) setByHour(j.byHour);
      setStatsError(false);
      setStatsUpdatedAt(Date.now());
    } catch { setStatsError(true); }
  }, []);

  // The Live poll already tells us whether the call hints are switched on
  // (two ct_settings reads on a request the board makes anyway), so a board
  // with both flags off — the default — issues no extra request at all.
  // Identity-stable when nothing changed, so it can't cause re-render churn.
  const applyRoutingFlags = useCallback((routing: { sticky_agent?: boolean; vip_routing?: boolean } | null | undefined) => {
    if (!routing) return;
    const next = { sticky: routing.sticky_agent === true, vip: routing.vip_routing === true };
    setHintFlags(prev => (prev && prev.sticky === next.sticky && prev.vip === next.vip ? prev : next));
  }, []);

  const pollLive = useCallback(async () => {
    try {
      const r = await fetch(`/api/crm-calls/live?after=${seqRef.current}`);
      if (!r.ok) return;
      const j = await r.json();
      applyRoutingFlags(j?.routing);
      if (typeof j?.seq === 'number') seqRef.current = Math.max(seqRef.current, j.seq);
      const ring: RingingCall[] = Array.isArray(j?.ringing) ? j.ringing : [];
      setRinging(ring);
      const events: any[] = Array.isArray(j?.events) ? j.events : [];
      for (const e of events) handleEvent(e);
    } catch { /* transient */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-seed ONLY the ringing list from the server's authoritative snapshot
  // (status='ringing' rows) without touching the seq cursor or replaying
  // events. Runs on a slow interval even while SSE is healthy so the board
  // self-heals: answered calls (status flips off 'ringing') and stale rings
  // (reconciled to 'missed' after 5 min) drop off, and a transient wipe can
  // never leave the board permanently empty.
  const syncRinging = useCallback(async () => {
    try {
      const r = await fetch(`/api/crm-calls/live?after=${seqRef.current}`);
      if (!r.ok) return;
      const j = await r.json();
      applyRoutingFlags(j?.routing);   // also self-heals if an admin flips a flag
      if (Array.isArray(j?.ringing)) setRinging(j.ringing);
    } catch { /* transient */ }
  }, [applyRoutingFlags]);

  /**
   * ONE FEED LINE PER EVENT — and only for event types this board actually
   * understands.
   *
   * EVERY BRANCH BELOW IS EXPLICIT, AND AN UNKNOWN TYPE FALLS OFF THE END AND IS
   * IGNORED. That is deliberate: a new CtEvent type quietly inheriting whichever
   * branch it happened to land in is how a claim came to be printed as "Call
   * answered". A row this board cannot label is not news it should invent a
   * label for — it waits for someone to teach it the type.
   */
  const handleEvent = useCallback((e: any) => {
    if (!e || !e.type) return;
    const phone = e.phone || '';
    const name = e.guest?.name || '';
    const at = e.at || new Date().toISOString();
    const key = `${e.type}:${e.telecmiCallId || e.callId || phone}:${at}`;
    if (e.type === 'incoming_call') {
      setRinging(prev => {
        const id = e.telecmiCallId || e.callId || phone;
        if (prev.some(r => (r.telecmi_call_id || r.id || r.phone_e164) === id)) return prev;
        return [{ telecmi_call_id: e.telecmiCallId, id: e.callId, phone_e164: phone, guest_name: name, started_at: at, agent_user: e.agent || '', queue: e.queue || '' }, ...prev].slice(0, 12);
      });
      pushFeed({ key, type: 'incoming_call', phone, guestName: name, at, label: 'Incoming call ringing' });
    } else if (e.type === 'call_ended' || e.type === 'answered') {
      // THE CARD FOR THIS CALL COMES OFF THE BOARD. Two passes, ids then phone,
      // deliberately — the same shape matchIdx() uses in the screen-pop, and for
      // the same reason.
      //
      // It used to be a single cascade that consulted ONLY the first identifier
      // the event happened to carry: an event with a telecmi id that matched no
      // card stopped there, even when its callId matched one perfectly. Ids on
      // this account do not reliably correlate — the ring, the live answer and
      // the CDR can arrive keyed differently — so that was precisely the case
      // that left an answered call sitting in "Ringing now".
      //
      // Phone gets a say only when NEITHER id matched anything. It is a blunter
      // instrument: it would also drop a second, genuinely-ringing card for the
      // same number. That is bounded to at most one 12s syncRinging cycle (the
      // server snapshot puts back anything still ringing), where a stuck card is
      // bounded by nothing.
      setRinging(prev => {
        const idHit = (r: RingingCall) =>
          (!!e.telecmiCallId && (r.telecmi_call_id === e.telecmiCallId || r.id === e.telecmiCallId)) ||
          (!!e.callId && (r.id === e.callId || r.telecmi_call_id === e.callId));
        if (prev.some(idHit)) return prev.filter(r => !idHit(r));
        if (!e.phone) return prev;   // no identifier at all → never nuke the board
        return prev.filter(r => (r.phone_e164 || r.phone) !== e.phone);
      });
      // ownerName rides along on the same event — this is the moment a
      // supervisor can see who picked the call up and now owns writing it up.
      pushFeed({
        key,
        type: e.type === 'answered' ? 'answered' : 'call_ended',
        phone, guestName: name,
        agentName: e.agentName || '', ownerName: e.ownerName || '', at,
        label: e.type === 'answered' ? 'Call answered' : 'Call ended',
      });
      refreshStats();
    } else if (e.type === 'ownership') {
      // THE OWNER OR THE LOCK CHANGED ON A CALL THAT ALREADY EXISTS — a claim, a
      // management takeover, or the release the disposition PUT broadcasts.
      //
      // DELIBERATELY DOES NOT TOUCH THE RINGING LIST. This lands at CHIP time,
      // i.e. minutes after the hangup, so re-running the ringing filter for it
      // would be filtering a call that is long over. Nor does it move the
      // counters: nobody was answered or missed, the write-up simply moved.
      //
      // The name goes in the label rather than into ownerName, because the
      // generic "· taken by X" suffix below reads as a claim and would be a lie
      // on the release line.
      const who = String(e.ownerName || '').trim();
      const label = e.locked === false
        ? (who ? `Write-up saved by ${who} — call open to everyone` : 'Write-up saved — call open to everyone')
        : (who ? `Write-up taken by ${who}` : 'Write-up ownership changed');
      pushFeed({ key, type: 'ownership', phone, guestName: name, at, label });
    } else if (e.type === 'recovery_update') {
      pushFeed({ key, type: 'recovery_update', phone, at, label: 'Recovery queue updated' });
      refreshStats();
    }
    // Anything else: a type this board does not know. Ignored on purpose — see
    // the note above. Never add an `else` that labels it.
  }, [pushFeed, refreshStats]);

  // SSE with poll fallback
  useEffect(() => {
    let closed = false;
    const startPolling = () => {
      if (pollTimer.current) return;
      setLiveMode('poll');
      pollTimer.current = setInterval(pollLive, 5000);
    };
    const connect = () => {
      if (closed) return;
      try {
        const es = new EventSource('/api/crm-calls/events');
        esRef.current = es;
        es.onopen = () => {
          setLiveMode('sse');
          if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
        };
        es.onmessage = (m) => { try { handleEvent(JSON.parse(m.data)); } catch { /* heartbeat */ } };
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
    pollLive();          // initial snapshot (ringing list + seq)
    refreshStats();      // initial counters
    const statTimer = setInterval(refreshStats, 60000); // safety refresh
    const ringTimer = setInterval(syncRinging, 12000);  // authoritative ringing re-sync
    return () => {
      closed = true;
      esRef.current?.close();
      if (pollTimer.current) clearInterval(pollTimer.current);
      clearInterval(statTimer);
      clearInterval(ringTimer);
    };
  }, [handleEvent, pollLive, refreshStats, syncRinging]);

  const ringSeconds = (r: RingingCall) => {
    const t = r.started_at ? new Date(r.started_at).getTime() : NaN;
    if (isNaN(t)) return 0;
    return Math.max(0, Math.floor((nowTick - t) / 1000));
  };

  const maxHour = Math.max(1, ...byHour.map(h => h.total));
  const statsStale = statsUpdatedAt != null && nowTick - statsUpdatedAt > 120000;
  const statsBroken = statsError && statsUpdatedAt == null; // never succeeded

  return (
    <div className="p-4 sm:p-6 space-y-5 min-h-screen bg-[#FFF8F0]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">CRM · Call to Table</p>
          <h1 className="text-2xl sm:text-3xl font-bold text-[#2D1B0E] flex items-center gap-3">
            Live Calls
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${liveMode === 'sse' ? 'bg-green-100 text-green-700' : liveMode === 'poll' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
              <span className={`w-2 h-2 rounded-full ${liveMode === 'sse' ? 'bg-green-500 animate-pulse' : liveMode === 'poll' ? 'bg-amber-500 animate-pulse' : 'bg-gray-400'}`} />
              {liveMode === 'sse' ? 'LIVE' : liveMode === 'poll' ? 'LIVE (poll)' : 'connecting…'}
            </span>
          </h1>
        </div>
        <div className="text-right">
          <p className="text-sm text-[#6B5744]">
            {new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          {statsError ? (
            <span role="status" aria-live="polite" className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
              stats unavailable
            </span>
          ) : statsStale ? (
            <span role="status" aria-live="polite" className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
              stats may be stale · {istTime(new Date(statsUpdatedAt!).toISOString())}
            </span>
          ) : statsUpdatedAt != null ? (
            <p className="mt-0.5 text-[11px] text-[#6B5744] tabular-nums">stats updated {istTime(new Date(statsUpdatedAt).toISOString())}</p>
          ) : null}
        </div>
      </div>

      {/* Today counters — big, glanceable */}
      <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: 'Calls today', value: today?.calls ?? '—', cls: 'text-[#2D1B0E]', icon: <PhoneCall className="w-4 h-4" /> },
          { label: 'Answered', value: today?.answered ?? '—', cls: 'text-green-600', icon: <PhoneIncoming className="w-4 h-4" /> },
          { label: 'Missed', value: today?.missed ?? '—', cls: 'text-red-500', icon: <PhoneMissed className="w-4 h-4" /> },
          { label: 'Answer rate', value: today ? `${Math.round(today.answered_pct)}%` : '—', cls: 'text-blue-600', icon: <Radio className="w-4 h-4" /> },
          { label: 'Pending recoveries', value: today?.pending_recoveries ?? '—', cls: (today?.pending_recoveries || 0) > 0 ? 'text-amber-600' : 'text-green-600', icon: <Users className="w-4 h-4" /> },
          { label: 'Bookings from calls', value: today?.bookings_from_calls ?? '—', cls: 'text-[#af4408]', icon: <CalendarCheck className="w-4 h-4" /> },
        ].map((s) => (
          <div key={s.label} className="px-3 py-4 text-center border-r border-b lg:border-b-0 border-[#F0E4D6]">
            <p className="text-[10px] sm:text-[11px] text-[#6B5744] uppercase tracking-wide flex items-center justify-center gap-1">{s.icon}{s.label}</p>
            <p className={`text-3xl sm:text-4xl font-bold mt-1 tabular-nums ${s.cls}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Ringing NOW */}
      <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4">
        <h2 className="text-sm font-semibold text-[#2D1B0E] mb-3 flex items-center gap-2">
          <PhoneIncoming className="w-4 h-4 text-[#af4408]" /> Ringing now
          {ringing.length > 0 && <span className="text-xs bg-red-100 text-red-700 rounded-full px-2 py-0.5 font-bold animate-pulse">{ringing.length}</span>}
        </h2>
        {ringing.length === 0 ? (
          <p className="text-sm text-[#6B5744] py-4 text-center">No calls ringing right now — they'll appear here the moment TeleCMI signals a ring.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {ringing.map((r, i) => {
              const phone = r.phone_e164 || r.phone || '';
              const secs = ringSeconds(r);
              // Undefined unless the feature is on AND the hint has arrived.
              const hint = hints[phone];
              return (
                <div key={r.telecmi_call_id || r.id || `${phone}-${i}`}
                     className="relative rounded-xl border-2 border-red-300 bg-red-50/60 p-4">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="font-bold text-[#2D1B0E] truncate">{r.guest_name || 'Unknown caller'}</p>
                      <p className="text-sm text-[#6B5744] font-mono truncate">{formatPhone(phone) || phone || '—'}</p>
                      {(r.queue || r.agent_user) && (
                        <p className="text-[11px] text-[#8B7355] mt-0.5 truncate">{[r.queue, r.agent_user].filter(Boolean).join(' · ')}</p>
                      )}
                      {/* WHO HAS IT. Reads owner_name straight off the snapshot
                          row — no extra request, and nothing to render when the
                          row does not name one.
                          BE HONEST ABOUT TODAY: every row in this list has
                          status='ringing', a ringing call is by definition not
                          yet answered, and only an ANSWERED call can be owned —
                          so this stays blank in production as things stand, and
                          the board is byte-for-byte what it is today. It is here
                          so the line is already right if /api/crm-calls/live ever
                          carries in-progress answered calls, which is the only
                          way an owned call could reach this list. The surface
                          that shows ownership TODAY is the Live feed below. */}
                      {(r.owner_name || r.owner_email) && (
                        <p className="mt-1 text-[11px] text-[#6B5744] flex items-center gap-1">
                          <UserCheck className="w-3.5 h-3.5 text-[#af4408] shrink-0" />
                          <span className="truncate">On this call: <b className="text-[#2D1B0E]">{r.owner_name || r.owner_email}</b></span>
                        </p>
                      )}
                      {/* VIP badge — always carries its own evidence, so it is
                          auditable rather than a mysterious star. */}
                      {hint?.vip?.isVip && (
                        <p className="mt-1.5">
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 align-middle">
                            <Crown className="w-3 h-3" /> VIP
                          </span>
                          <span className="ml-1.5 text-[11px] text-amber-800 align-middle">
                            {hint.vip.reasons.join(' · ')}
                          </span>
                        </p>
                      )}
                      {/* Sticky agent — continuity hint, NOT a re-route. */}
                      {hint?.sticky && (
                        <p className="mt-1 text-[11px] text-[#6B5744] flex items-start gap-1"
                           title={`${hint.sticky.answered_calls} of this guest's ${hint.sticky.total_answered_calls} answered calls in the last ${hint.sticky.window_days} days were handled by ${hint.sticky.agent_label}. Hint only — the call is not re-routed.`}>
                          <UserCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-px" />
                          <span className="min-w-0">
                            {hint.sticky.total_answered_calls > 1 ? 'Regular' : 'Called before'} — last handled by{' '}
                            <b className="text-[#2D1B0E]">{hint.sticky.agent_label}</b>
                            {hint.sticky.last_answered_at && <> · {istDay(hint.sticky.last_answered_at)}</>}
                            {hint.sticky.answered_calls > 1 && <> · {hint.sticky.answered_calls} of {hint.sticky.total_answered_calls} calls</>}
                          </span>
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0 ml-3 flex flex-col items-end gap-1.5">
                      <PhoneIncoming className="w-6 h-6 text-red-500 animate-pulse" />
                      <p className="text-xs text-red-600 font-semibold tabular-nums">{secs}s</p>
                      <SendMenu phone={phone} guestName={r.guest_name} docs={docs} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Live feed */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4">
          <h2 className="text-sm font-semibold text-[#2D1B0E] mb-3 flex items-center gap-2">
            <Radio className="w-4 h-4 text-[#af4408]" /> Live feed
          </h2>
          {feed.length === 0 ? (
            <p className="text-sm text-[#8B7355] py-4 text-center">
              Waiting for call activity — new calls will appear here live.
              {process.env.NODE_ENV !== 'production' && (
                <> (test with <code className="font-mono bg-[#FFF1E3] px-1 rounded">npm run simulate:call</code>)</>
              )}
            </p>
          ) : (
            <ul className="divide-y divide-[#F0E4D6] max-h-[420px] overflow-y-auto">
              {feed.map(f => (
                <li key={f.key} className="py-2 flex items-center gap-3 text-sm">
                  {/* One icon per row kind. 'answered' is green and its own
                      glyph — it used to share the grey handset with 'call_ended',
                      so at a glance "picked up" and "over" were the same row. The
                      final arm is 'recovery_update', the only kind left. */}
                  {f.type === 'incoming_call'
                    ? <ArrowDownLeft className="w-4 h-4 text-green-600 shrink-0" />
                    : f.type === 'answered'
                      ? <PhoneIncoming className="w-4 h-4 text-green-700 shrink-0" />
                      : f.type === 'call_ended'
                        ? <PhoneCall className="w-4 h-4 text-[#8B7355] shrink-0" />
                        : f.type === 'ownership'
                          ? <UserCheck className="w-4 h-4 text-[#af4408] shrink-0" />
                          : <ArrowUpRight className="w-4 h-4 text-amber-500 shrink-0" />}
                  <span className="flex-1 min-w-0 truncate text-[#3D2614]">
                    <b>{f.guestName || formatPhone(f.phone || '') || 'System'}</b> — {f.label}
                    {f.agentName && <span className="text-[#8B7355]"> · answered by {f.agentName}</span>}
                    {/* Suppressed when it just repeats the agent: a MAPPED
                        TeleCMI agent resolves to the same person, and "answered
                        by Pushpa · taken by Pushpa" reads like two people. */}
                    {f.ownerName && f.ownerName !== f.agentName && (
                      <span className="text-[#8B7355]"> · taken by {f.ownerName}</span>
                    )}
                  </span>
                  {f.phone && <SendMenu phone={f.phone} guestName={f.guestName} docs={docs} />}
                  <span className="text-[11px] text-[#8B7355] tabular-nums shrink-0">{istTime(f.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Today by hour */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4">
          <h2 className="text-sm font-semibold text-[#2D1B0E] mb-3">Today by hour <span className="text-[11px] font-normal text-[#8B7355]">(red = missed)</span></h2>
          {byHour.every(h => h.total === 0) ? (
            <p className="text-sm text-[#8B7355] py-4 text-center">
              {statsBroken ? "Couldn't load call stats — retrying automatically…" : 'No calls yet today.'}
            </p>
          ) : (
            <div className="flex items-end gap-1 h-40">
              {byHour.map(h => (
                <div key={h.hour} className="flex-1 flex flex-col items-center gap-1 min-w-0" title={`${h.hour}:00 — ${h.total} calls, ${h.missed} missed`}>
                  <div className="w-full flex flex-col justify-end" style={{ height: '128px' }}>
                    <div className="w-full bg-red-400 rounded-t-sm" style={{ height: `${(h.missed / maxHour) * 128}px` }} />
                    <div className="w-full bg-[#E8955C]" style={{ height: `${(Math.max(0, h.total - h.missed) / maxHour) * 128}px` }} />
                  </div>
                  <span className="text-[9px] text-[#8B7355]">{h.hour}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
