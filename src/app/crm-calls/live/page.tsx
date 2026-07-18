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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PhoneIncoming, PhoneMissed, PhoneCall, Radio, Users, CalendarCheck, ArrowDownLeft, ArrowUpRight,
} from 'lucide-react';
import { formatPhone } from '@/lib/ct/phone';

interface FeedItem {
  key: string;
  type: 'incoming_call' | 'call_ended' | 'recovery_update' | 'answered' | 'missed';
  phone?: string;
  guestName?: string;
  agentName?: string;
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
}

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
  const [nowTick, setNowTick] = useState(Date.now());
  const seqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 1-second tick drives ringing-duration counters
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const pushFeed = useCallback((item: FeedItem) => {
    setFeed(prev => {
      if (prev.some(p => p.key === item.key)) return prev;
      return [item, ...prev].slice(0, 60);
    });
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      const r = await fetch('/api/crm-calls/dashboard?days=1');
      if (!r.ok) return;
      const j = await r.json();
      if (j?.today) setToday(j.today);
      if (Array.isArray(j?.byHour)) setByHour(j.byHour);
    } catch { /* transient */ }
  }, []);

  const pollLive = useCallback(async () => {
    try {
      const r = await fetch(`/api/crm-calls/live?after=${seqRef.current}`);
      if (!r.ok) return;
      const j = await r.json();
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
      if (Array.isArray(j?.ringing)) setRinging(j.ringing);
    } catch { /* transient */ }
  }, []);

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
      // Remove ONLY the matching card, cascading id → callId → phone. A
      // call_ended can arrive with no telecmi id (CDR with no call id, or a
      // live hangup that never carried one) — in that case fall back to phone,
      // and if there's no identifier at all keep every card (never nuke the
      // whole board off one id-less event).
      setRinging(prev => prev.filter(r => {
        if (e.telecmiCallId) return (r.telecmi_call_id || r.id) !== e.telecmiCallId;
        if (e.callId) return r.id !== e.callId;
        if (e.phone) return (r.phone_e164 || r.phone) !== e.phone;
        return true;
      }));
      pushFeed({ key, type: 'call_ended', phone, guestName: name, agentName: e.agentName || '', at, label: e.type === 'answered' ? 'Call answered' : 'Call ended' });
      refreshStats();
    } else if (e.type === 'recovery_update') {
      pushFeed({ key, type: 'recovery_update', phone, at, label: 'Recovery queue updated' });
      refreshStats();
    }
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

  return (
    <div className="p-4 sm:p-6 space-y-5 min-h-screen bg-[#FFF8F0]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">CRM · Call to Table</p>
          <h1 className="text-2xl sm:text-3xl font-bold text-[#2D1B0E] flex items-center gap-3">
            Live Calls
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${liveMode === 'sse' ? 'bg-green-100 text-green-700' : liveMode === 'poll' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
              <span className={`w-2 h-2 rounded-full ${liveMode === 'sse' ? 'bg-green-500 animate-pulse' : liveMode === 'poll' ? 'bg-amber-500 animate-pulse' : 'bg-gray-400'}`} />
              {liveMode === 'sse' ? 'LIVE' : liveMode === 'poll' ? 'LIVE (poll)' : 'connecting…'}
            </span>
          </h1>
        </div>
        <p className="text-sm text-[#8B7355]">
          {new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
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
          <div key={s.label} className="px-3 py-4 text-center border-r border-b sm:border-b-0 border-[#F0E4D6]">
            <p className="text-[10px] sm:text-[11px] text-[#8B7355] uppercase tracking-wide flex items-center justify-center gap-1">{s.icon}{s.label}</p>
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
          <p className="text-sm text-[#8B7355] py-4 text-center">No calls ringing right now — they'll appear here the moment TeleCMI signals a ring.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {ringing.map((r, i) => {
              const phone = r.phone_e164 || r.phone || '';
              const secs = ringSeconds(r);
              return (
                <div key={r.telecmi_call_id || r.id || `${phone}-${i}`}
                     className="relative rounded-xl border-2 border-red-300 bg-red-50/60 p-4 animate-pulse">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="font-bold text-[#2D1B0E] truncate">{r.guest_name || 'Unknown caller'}</p>
                      <p className="text-sm text-[#6B5744] font-mono">{formatPhone(phone) || phone || '—'}</p>
                      {(r.queue || r.agent_user) && (
                        <p className="text-[11px] text-[#8B7355] mt-0.5 truncate">{[r.queue, r.agent_user].filter(Boolean).join(' · ')}</p>
                      )}
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <PhoneIncoming className="w-6 h-6 text-red-500 ml-auto" />
                      <p className="text-xs text-red-600 font-semibold tabular-nums mt-1">{secs}s</p>
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
            <p className="text-sm text-[#8B7355] py-4 text-center">Waiting for events… (test with <code className="font-mono bg-[#FFF1E3] px-1 rounded">npm run simulate:call</code>)</p>
          ) : (
            <ul className="divide-y divide-[#F0E4D6] max-h-[420px] overflow-y-auto">
              {feed.map(f => (
                <li key={f.key} className="py-2 flex items-center gap-3 text-sm">
                  {f.type === 'incoming_call'
                    ? <ArrowDownLeft className="w-4 h-4 text-green-600 shrink-0" />
                    : f.type === 'call_ended'
                      ? <PhoneCall className="w-4 h-4 text-[#8B7355] shrink-0" />
                      : <ArrowUpRight className="w-4 h-4 text-amber-500 shrink-0" />}
                  <span className="flex-1 min-w-0 truncate text-[#3D2614]">
                    <b>{f.guestName || formatPhone(f.phone || '') || 'System'}</b> — {f.label}
                    {f.agentName && <span className="text-[#8B7355]"> · answered by {f.agentName}</span>}
                  </span>
                  <span className="text-[11px] text-[#8B7355] tabular-nums shrink-0">{istTime(f.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Today by hour */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4">
          <h2 className="text-sm font-semibold text-[#2D1B0E] mb-3">Today by hour <span className="text-[11px] font-normal text-[#8B7355]">(red = missed)</span></h2>
          {byHour.length === 0 ? (
            <p className="text-sm text-[#8B7355] py-4 text-center">No calls yet today.</p>
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
