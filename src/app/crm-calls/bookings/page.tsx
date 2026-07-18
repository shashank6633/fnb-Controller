'use client';

/**
 * CRM — Call-to-Table · Bookings board.
 *
 * Every booking captured by the CRM (quick bookings from screen-pops, guest
 * 360, recovery callbacks, walk-ins) in one working view: status tabs with
 * live counts, a date-range window (default today → +7 days), guest search,
 * and one-tap lifecycle actions (confirm → seat → complete / no-show /
 * cancel). "from call" links prove the call-to-table conversion chain.
 *
 * Data: GET /api/crm-calls/bookings (?from ?to, paged — fetched exhaustively
 * for the window, then tab counts/search/paging are client-side so the tab
 * numbers always agree with what's on screen). Status moves via
 * PUT /api/crm-calls/bookings/:id { status }. New bookings via the shared
 * QuickBookingModal in guest-picker mode (no guestId → it searches guests).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import QuickBookingModal from '@/components/ct/QuickBookingModal';
import {
  CalendarCheck, CalendarX2, Plus, Search, Users, Clock, PhoneIncoming,
  CheckCircle, AlertCircle, Loader2, ChevronLeft, ChevronRight, Star, RefreshCw,
} from 'lucide-react';

interface BookingRow {
  id: string;
  guest_id: string;
  source_call_id: string | null;
  booking_date: string;
  slot_time: string;
  party_size: number;
  occasion: string;
  section_pref: string;
  status: string;
  created_by: string;
  channel: string;
  advance_amount: number;
  notes: string;
  created_at: string;
  updated_at: string;
  guest_name?: string | null;
  guest_phone?: string | null;
  guest_tags?: string | null;
}

interface StatusAction {
  to: string;
  label: string;
  cls: string;
  confirmMsg?: string;
}

const PAGE_SIZE = 25;

const STATUS_TABS = ['all', 'pending', 'confirmed', 'seated', 'completed', 'no_show', 'cancelled'] as const;

const STATUS_META: Record<string, { label: string; chip: string }> = {
  pending:   { label: 'Pending',   chip: 'bg-amber-50 text-amber-700 border-amber-200' },
  confirmed: { label: 'Confirmed', chip: 'bg-blue-50 text-blue-700 border-blue-200' },
  seated:    { label: 'Seated',    chip: 'bg-purple-50 text-purple-700 border-purple-200' },
  completed: { label: 'Completed', chip: 'bg-green-50 text-green-700 border-green-200' },
  no_show:   { label: 'No-show',   chip: 'bg-red-50 text-red-700 border-red-200' },
  cancelled: { label: 'Cancelled', chip: 'bg-gray-100 text-gray-500 border-gray-200' },
};

const CHANNEL_META: Record<string, { label: string; chip: string }> = {
  call:     { label: 'Call',     chip: 'bg-[#FFF1E3] text-[#af4408] border-[#F0D9C0]' },
  walk_in:  { label: 'Walk-in',  chip: 'bg-[#F5EFE7] text-[#6B5744] border-[#E0D0BE]' },
  online:   { label: 'Online',   chip: 'bg-blue-50 text-blue-700 border-blue-200' },
  whatsapp: { label: 'WhatsApp', chip: 'bg-green-50 text-green-700 border-green-200' },
};

/** Forward moves allowed from each status. confirm() gates the destructive ones. */
const STATUS_ACTIONS: Record<string, StatusAction[]> = {
  pending: [
    { to: 'confirmed', label: 'Confirm', cls: 'bg-blue-600 hover:bg-blue-700 text-white' },
    { to: 'seated', label: 'Seat', cls: 'bg-purple-600 hover:bg-purple-700 text-white' },
    { to: 'cancelled', label: 'Cancel', cls: 'bg-white border border-[#E0D0BE] text-[#8B7355] hover:bg-red-50 hover:text-red-600 hover:border-red-200', confirmMsg: 'Cancel this booking?' },
  ],
  confirmed: [
    { to: 'seated', label: 'Seat', cls: 'bg-purple-600 hover:bg-purple-700 text-white' },
    { to: 'no_show', label: 'No-show', cls: 'bg-white border border-red-200 text-red-600 hover:bg-red-50', confirmMsg: 'Mark this booking as a NO-SHOW? This counts against the guest\'s visit record.' },
    { to: 'cancelled', label: 'Cancel', cls: 'bg-white border border-[#E0D0BE] text-[#8B7355] hover:bg-red-50 hover:text-red-600 hover:border-red-200', confirmMsg: 'Cancel this booking?' },
  ],
  seated: [
    { to: 'completed', label: 'Complete', cls: 'bg-green-600 hover:bg-green-700 text-white' },
  ],
};

/** YYYY-MM-DD in IST (business dates for this venue are IST dates). */
function istDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function prettyDate(ymd: string, todayYmd: string): string {
  if (!ymd) return '—';
  if (ymd === todayYmd) return 'Today';
  const d = new Date(`${ymd}T00:00:00`);
  if (isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

function isVip(tagsJson?: string | null): boolean {
  if (!tagsJson) return false;
  try {
    const tags = JSON.parse(tagsJson);
    return Array.isArray(tags) && tags.some(t => String(t).trim().toLowerCase() === 'vip');
  } catch {
    return false;
  }
}

export default function BookingsBoardPage() {
  const todayYmd = istDate(new Date());
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filters
  const [statusTab, setStatusTab] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState<string>(() => istDate(new Date()));
  const [to, setTo] = useState<string>(() => istDate(new Date(Date.now() + 7 * 86400000)));

  // Row action + modal + toast
  const [acting, setActing] = useState<string | null>(null); // `${id}:${to}`
  const [newOpen, setNewOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);

  const [page, setPage] = useState(1);

  const showToast = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
    setTimeout(() => setToast(null), error ? 4000 : 2500);
  }, []);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (opts?.silent) setRefreshing(true); else setLoading(true);
    setLoadError(null);
    try {
      const base = new URLSearchParams({ page_size: '200' });
      if (from) base.set('from', from);
      if (to) base.set('to', to);
      let pageNum = 1;
      let all: BookingRow[] = [];
      let total = 0;
      // Exhaust the window (capped) so tab counts are truthful.
      do {
        const res = await fetch(`/api/crm-calls/bookings?${base.toString()}&page=${pageNum}`);
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
          throw new Error(msg);
        }
        const json = await res.json();
        all = all.concat(Array.isArray(json.bookings) ? json.bookings : []);
        total = Number(json.total) || 0;
        pageNum++;
      } while (all.length < total && pageNum <= 6); // cap: 1200 rows per window
      setBookings(all);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load bookings');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [statusTab, search, from, to]);

  // Search (guest name / phone digits) applies before tab counts so the
  // numbers on the tabs always match the rows on screen.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return bookings;
    const qDigits = q.replace(/\D/g, '');
    return bookings.filter(b => {
      const name = (b.guest_name || '').toLowerCase();
      if (name.includes(q)) return true;
      if (qDigits.length >= 3) {
        const phoneDigits = (b.guest_phone || '').replace(/\D/g, '');
        if (phoneDigits.includes(qDigits)) return true;
      }
      return false;
    });
  }, [bookings, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: searched.length };
    for (const s of STATUS_TABS) if (s !== 'all') c[s] = 0;
    for (const b of searched) c[b.status] = (c[b.status] || 0) + 1;
    return c;
  }, [searched]);

  const filtered = useMemo(() => {
    const list = statusTab === 'all' ? searched : searched.filter(b => b.status === statusTab);
    // Board order: soonest first.
    return [...list].sort((a, b) =>
      (a.booking_date || '').localeCompare(b.booking_date || '')
      || (a.slot_time || '').localeCompare(b.slot_time || '')
      || (a.created_at || '').localeCompare(b.created_at || ''));
  }, [searched, statusTab]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const advance = useCallback(async (b: BookingRow, action: StatusAction) => {
    if (action.confirmMsg && !window.confirm(action.confirmMsg)) return;
    const key = `${b.id}:${action.to}`;
    setActing(key);
    try {
      const res = await api(`/api/crm-calls/bookings/${b.id}`, { method: 'PUT', body: { status: action.to } });
      let json: { booking?: BookingRow; error?: string } | null = null;
      try { json = await res.json(); } catch { /* non-JSON error body */ }
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      const updated = json?.booking;
      setBookings(prev => prev.map(x => (x.id === b.id ? (updated || { ...x, status: action.to }) : x)));
      showToast(`Booking ${STATUS_META[action.to]?.label.toLowerCase() || action.to}`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Update failed', true);
    } finally {
      setActing(null);
    }
  }, [showToast]);

  const setRange = (f: string, t: string) => { setFrom(f); setTo(t); };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-[100rem] mx-auto space-y-5">
          <div className="h-9 w-64 bg-[#FFF1E3] rounded-lg" />
          <div className="h-10 w-full bg-[#FFF1E3] rounded-xl" />
          {[...Array(5)].map((_, i) => <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl h-16" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-[100rem] mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">CRM — Call-to-Table</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2.5">
              <CalendarCheck className="w-7 h-7 text-[#af4408]" />Bookings
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => load({ silent: true })} disabled={refreshing}
                    className="p-2.5 bg-white border border-[#E0D0BE] rounded-xl text-[#8B7355] hover:text-[#2D1B0E] hover:bg-[#FFF1E3] shadow-sm transition-colors disabled:opacity-50"
                    aria-label="Refresh" title="Refresh">
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={() => setNewOpen(true)}
                    className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold shadow-sm transition-colors">
              <Plus className="w-4 h-4" />New Booking
            </button>
          </div>
        </div>

        {/* Search + date range */}
        <div className="flex flex-col lg:flex-row gap-2.5">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
            <input type="text" placeholder="Search guest by name or phone…" value={search}
                   onChange={e => setSearch(e.target.value)}
                   className="w-full pl-10 pr-4 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 focus:border-[#af4408] shadow-sm" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 bg-white border border-[#E0D0BE] rounded-xl px-2.5 py-1.5 shadow-sm">
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="From date"
                     className="text-sm bg-transparent focus:outline-none text-[#2D1B0E] w-[8.2rem]" />
              <span className="text-[#C4B09A] text-sm">→</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="To date"
                     className="text-sm bg-transparent focus:outline-none text-[#2D1B0E] w-[8.2rem]" />
            </div>
            <div className="inline-flex rounded-xl border border-[#E0D0BE] bg-white p-0.5 shadow-sm">
              {([
                ['Today', todayYmd, todayYmd],
                ['7d', todayYmd, istDate(new Date(Date.now() + 7 * 86400000))],
                ['30d', todayYmd, istDate(new Date(Date.now() + 30 * 86400000))],
                ['All', '', ''],
              ] as [string, string, string][]).map(([label, f, t]) => {
                const on = from === f && to === t;
                return (
                  <button key={label} onClick={() => setRange(f, t)}
                          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${on ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Status tabs with counts */}
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 -mx-1 px-1">
          {STATUS_TABS.map(s => {
            const on = statusTab === s;
            const label = s === 'all' ? 'All' : STATUS_META[s].label;
            return (
              <button key={s} onClick={() => setStatusTab(s)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors ${on ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'}`}>
                {label}
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${on ? 'bg-white/20 text-white' : 'bg-[#FFF1E3] text-[#8B7355]'}`}>
                  {counts[s] || 0}
                </span>
              </button>
            );
          })}
        </div>

        {loadError && (
          <div className="flex items-center gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{loadError}</span>
            <button onClick={() => load()} className="ml-auto font-medium text-red-700 underline">Retry</button>
          </div>
        )}

        {/* ---- Bookings: table on desktop, cards on mobile ---- */}
        {filtered.length === 0 && !loadError ? (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl py-16 text-center text-[#8B7355]">
            <CalendarX2 className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p>No bookings found</p>
            <p className="text-xs mt-1">Try widening the date range or clearing the search</p>
          </div>
        ) : filtered.length > 0 && (
          <>
            {/* Desktop table */}
            <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4] bg-[#FFF8F0]">
                      <th className="text-left py-3 px-4 font-semibold">Date &amp; Slot</th>
                      <th className="text-left py-3 px-3 font-semibold">Guest</th>
                      <th className="text-center py-3 px-3 font-semibold">Party</th>
                      <th className="text-left py-3 px-3 font-semibold">Occasion</th>
                      <th className="text-left py-3 px-3 font-semibold">Channel</th>
                      <th className="text-left py-3 px-3 font-semibold">Source</th>
                      <th className="text-left py-3 px-3 font-semibold">Status</th>
                      <th className="text-right py-3 px-4 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map(b => (
                      <tr key={b.id} className="border-b border-[#F0E4D6] last:border-0 hover:bg-[#FFF8F0]">
                        <td className="py-2.5 px-4">
                          <p className={`font-semibold text-[13px] ${b.booking_date === todayYmd ? 'text-[#af4408]' : 'text-[#2D1B0E]'}`}>
                            {prettyDate(b.booking_date, todayYmd)}
                          </p>
                          <p className="text-[11px] text-[#8B7355] flex items-center gap-1">
                            <Clock className="w-3 h-3" />{b.slot_time || '—'}
                          </p>
                        </td>
                        <td className="py-2.5 px-3">
                          <Link href={`/crm-calls/guests/${b.guest_id}`} className="group inline-block">
                            <p className="font-semibold text-[13px] text-[#2D1B0E] group-hover:text-[#af4408] transition-colors flex items-center gap-1.5">
                              {b.guest_name || 'Unknown guest'}
                              {isVip(b.guest_tags) && (
                                <span className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
                                  <Star className="w-2.5 h-2.5 fill-amber-500 text-amber-500" />VIP
                                </span>
                              )}
                            </p>
                            <p className="text-[11px] text-[#8B7355] font-mono">{formatPhone(b.guest_phone || '')}</p>
                          </Link>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span className="inline-flex items-center gap-1 font-semibold text-[#2D1B0E]">
                            <Users className="w-3.5 h-3.5 text-[#8B7355]" />{b.party_size}
                          </span>
                        </td>
                        <td className="py-2.5 px-3">
                          <p className="text-[13px] text-[#3D2614]">{b.occasion || <span className="text-[#C4B09A]">—</span>}</p>
                          {(b.section_pref || b.advance_amount > 0) && (
                            <p className="text-[11px] text-[#8B7355]">
                              {b.section_pref}{b.section_pref && b.advance_amount > 0 ? ' · ' : ''}
                              {b.advance_amount > 0 ? `₹${b.advance_amount.toLocaleString('en-IN')} adv` : ''}
                            </p>
                          )}
                        </td>
                        <td className="py-2.5 px-3"><ChannelChip channel={b.channel} /></td>
                        <td className="py-2.5 px-3">
                          {b.source_call_id ? (
                            <Link href={`/crm-calls/log?call_id=${encodeURIComponent(b.source_call_id)}`}
                                  className="inline-flex items-center gap-1 text-[12px] font-medium text-[#af4408] hover:underline"
                                  title="This booking was converted from a call — open it in the call log">
                              <PhoneIncoming className="w-3.5 h-3.5" />from call
                            </Link>
                          ) : <span className="text-[#C4B09A]">—</span>}
                        </td>
                        <td className="py-2.5 px-3"><StatusChip status={b.status} /></td>
                        <td className="py-2.5 px-4">
                          <div className="flex items-center justify-end gap-1.5">
                            {(STATUS_ACTIONS[b.status] || []).map(a => (
                              <ActionButton key={a.to} action={a} busy={acting === `${b.id}:${a.to}`}
                                            disabled={acting !== null} onClick={() => advance(b, a)} />
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-2.5">
              {pageRows.map(b => (
                <div key={b.id} className="bg-white border border-[#E8D5C4] rounded-xl p-3.5 space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className={`font-semibold text-sm ${b.booking_date === todayYmd ? 'text-[#af4408]' : 'text-[#2D1B0E]'}`}>
                        {prettyDate(b.booking_date, todayYmd)}
                        <span className="text-[#8B7355] font-normal"> · {b.slot_time || 'no slot'}</span>
                      </p>
                      <Link href={`/crm-calls/guests/${b.guest_id}`} className="mt-0.5 inline-block">
                        <span className="font-semibold text-[13px] text-[#2D1B0E] flex items-center gap-1.5">
                          {b.guest_name || 'Unknown guest'}
                          {isVip(b.guest_tags) && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
                              <Star className="w-2.5 h-2.5 fill-amber-500 text-amber-500" />VIP
                            </span>
                          )}
                        </span>
                        <span className="text-[11px] text-[#8B7355] font-mono">{formatPhone(b.guest_phone || '')}</span>
                      </Link>
                    </div>
                    <StatusChip status={b.status} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[#6B5744]">
                    <span className="inline-flex items-center gap-1 font-medium">
                      <Users className="w-3.5 h-3.5 text-[#8B7355]" />{b.party_size} pax
                    </span>
                    {b.occasion && <span>{b.occasion}</span>}
                    {b.section_pref && <span className="text-[#8B7355]">{b.section_pref}</span>}
                    {b.advance_amount > 0 && <span className="text-[#8B7355]">₹{b.advance_amount.toLocaleString('en-IN')} adv</span>}
                    <ChannelChip channel={b.channel} />
                    {b.source_call_id && (
                      <Link href={`/crm-calls/log?call_id=${encodeURIComponent(b.source_call_id)}`}
                            className="inline-flex items-center gap-1 font-medium text-[#af4408]">
                        <PhoneIncoming className="w-3.5 h-3.5" />from call
                      </Link>
                    )}
                  </div>
                  {(STATUS_ACTIONS[b.status] || []).length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {(STATUS_ACTIONS[b.status] || []).map(a => (
                        <ActionButton key={a.to} action={a} busy={acting === `${b.id}:${a.to}`}
                                      disabled={acting !== null} onClick={() => advance(b, a)} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Pagination */}
            {filtered.length > PAGE_SIZE && (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
                <p className="text-xs text-[#8B7355]">
                  Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length} bookings
                </p>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => setPage(safePage - 1)} disabled={safePage <= 1}
                          className="p-2 bg-white border border-[#E0D0BE] rounded-lg text-[#6B5744] disabled:opacity-40 hover:bg-[#FFF1E3]" aria-label="Previous page">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-xs text-[#6B5744] px-2">Page {safePage} / {pageCount}</span>
                  <button onClick={() => setPage(safePage + 1)} disabled={safePage >= pageCount}
                          className="p-2 bg-white border border-[#E0D0BE] rounded-lg text-[#6B5744] disabled:opacity-40 hover:bg-[#FFF1E3]" aria-label="Next page">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3 rounded-lg shadow-lg text-white ${toast.error ? 'bg-red-600' : 'bg-green-600'}`}>
          {toast.error ? <AlertCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
          <span className="text-sm font-medium">{toast.msg}</span>
        </div>
      )}

      {/* New booking — shared QuickBookingModal in guest-picker mode (no guestId:
          the modal searches ct_guests by name/phone per its contract). */}
      <QuickBookingModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onSaved={() => {
          setNewOpen(false);
          showToast('Booking created');
          load({ silent: true });
        }}
      />
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const m = STATUS_META[status] || { label: status || '—', chip: 'bg-gray-100 text-gray-600 border-gray-200' };
  return (
    <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${m.chip}`}>
      {m.label}
    </span>
  );
}

function ChannelChip({ channel }: { channel: string }) {
  const m = CHANNEL_META[channel] || { label: channel || '—', chip: 'bg-gray-100 text-gray-600 border-gray-200' };
  return (
    <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${m.chip}`}>
      {m.label}
    </span>
  );
}

function ActionButton({ action, busy, disabled, onClick }: { action: StatusAction; busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold whitespace-nowrap shadow-sm transition-colors disabled:opacity-50 ${action.cls}`}>
      {busy && <Loader2 className="w-3 h-3 animate-spin" />}
      {action.label}
    </button>
  );
}
