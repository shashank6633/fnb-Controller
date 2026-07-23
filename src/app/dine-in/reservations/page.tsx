'use client';

/**
 * Dine-In — Host "Seat" board (Reservation → table check-in, Part A).
 *
 * Today's bookings in one working view for the host stand: the ones still to be
 * seated (pending / confirmed) each carry a SEAT button that opens a compact
 * table picker; on choose we POST the booking onto that table and it slides down
 * into the "Seated" list with its table + a link to the live order.
 *
 * A reservation is for a PARTY, not a person — the host finds "Rao · party of 4 ·
 * 8pm" and seats it, so it never matters which member walked in first (see
 * docs/reservation-table-checkin.md).
 *
 * Data:
 *   GET  /api/crm-calls/bookings?from=<today>&to=<today>  → { bookings }
 *          (each: guest_name, guest_phone, party_size, slot_time, occasion,
 *           section_pref, status, table_id, seated_at, guest_tags)
 *   GET  /api/dine-in/tables                              → { items }
 *          (each: table_number, zone, section, open_order_id, open_order_number)
 *   POST /api/crm-calls/bookings/:id/seat { table_id }    → { ok, orderId, … }
 * All calls go through api() (CSRF on POST). Server errors surface inline; a
 * seat never silently "succeeds" — we always check res.ok.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import {
  CalendarCheck, Search, Users, Clock, Loader2, X, Armchair, MapPin,
  ExternalLink, AlertCircle, RefreshCw, Star, PartyPopper, CheckCircle2,
} from 'lucide-react';

interface Booking {
  id: string;
  booking_date: string;
  slot_time: string;
  party_size: number;
  occasion: string;
  section_pref: string;
  status: string;
  table_id: string | null;
  seated_at?: string | null;
  guest_name?: string | null;
  guest_phone?: string | null;
  guest_tags?: string | null;
}

interface TableItem {
  id: string;
  table_number: string;
  zone: string;
  section: string;
  seats: number;
  open_order_id: string | null;
  open_order_number: number | null;
}

/** YYYY-MM-DD in IST — business dates for this venue are IST calendar days. */
function istToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** "20:00" → "8:00 PM"; leaves anything unparseable as-is. */
function fmtSlot(t: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec((t || '').trim());
  if (!m) return t || '—';
  let h = parseInt(m[1], 10);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}

function prettyToday(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  if (isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
}

function isVip(tagsJson?: string | null): boolean {
  if (!tagsJson) return false;
  try {
    const tags = JSON.parse(tagsJson);
    return Array.isArray(tags) && tags.some(t => String(t).trim().toLowerCase() === 'vip');
  } catch { return false; }
}

function guestLabel(b: Booking): string {
  return (b.guest_name || '').trim() || (b.guest_phone ? formatPhone(b.guest_phone) : 'Walk-in guest');
}

/** slot_time ascending, blanks last — the natural order a host works the stand. */
function bySlot(a: Booking, b: Booking): number {
  const av = (a.slot_time || '').trim(), bv = (b.slot_time || '').trim();
  if (!av && !bv) return 0;
  if (!av) return 1;
  if (!bv) return -1;
  return av.localeCompare(bv);
}

export default function ReservationsPage() {
  const today = istToday();

  const [bookings, setBookings] = useState<Booking[]>([]);
  const [tables, setTables] = useState<TableItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Debounced search over the loaded list (name OR phone).
  const [rawSearch, setRawSearch] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(rawSearch.trim().toLowerCase()), 200);
    return () => clearTimeout(t);
  }, [rawSearch]);

  // Table picker + seat state.
  const [seatingFor, setSeatingFor] = useState<Booking | null>(null);
  const [showAllTables, setShowAllTables] = useState(false);
  const [seatBusyId, setSeatBusyId] = useState<string | null>(null);
  const [seatError, setSeatError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      // Bookings: exhaust the (paged) window so counts always match what's shown.
      const all: Booking[] = [];
      let page = 1;
      const pageSize = 200;
      for (;;) {
        const r = await api(`/api/crm-calls/bookings?from=${today}&to=${today}&page=${page}&page_size=${pageSize}`);
        if (!r.ok) {
          let msg = `Couldn't load bookings (HTTP ${r.status})`;
          try { msg = (await r.json()).error || msg; } catch {}
          throw new Error(msg);
        }
        const j = await r.json();
        const batch: Booking[] = j.bookings || [];
        all.push(...batch);
        const total = typeof j.total === 'number' ? j.total : all.length;
        if (batch.length === 0 || all.length >= total) break;
        page++;
      }
      setBookings(all);

      // Tables (best-effort — a booking still shows even if tables fail).
      try {
        const tr = await api('/api/dine-in/tables');
        if (tr.ok) { const tj = await tr.json(); setTables(tj.items || []); }
      } catch { /* table picker just falls back to empty */ }
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load reservations');
    } finally {
      setLoading(false);
    }
  }, [today]);

  useEffect(() => { load(); }, [load]);

  // Auto-dismiss the success toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const tableById = useMemo(() => {
    const m = new Map<string, TableItem>();
    for (const t of tables) m.set(t.id, t);
    return m;
  }, [tables]);

  const matches = useCallback((b: Booking): boolean => {
    if (!search) return true;
    const name = (b.guest_name || '').toLowerCase();
    if (name.includes(search)) return true;
    const qDigits = search.replace(/\D/g, '');
    if (qDigits) {
      const phoneDigits = (b.guest_phone || '').replace(/\D/g, '');
      if (phoneDigits.includes(qDigits)) return true;
    }
    return false;
  }, [search]);

  const toSeat = useMemo(
    () => bookings.filter(b => b.status === 'pending' || b.status === 'confirmed').filter(matches).sort(bySlot),
    [bookings, matches],
  );
  const seated = useMemo(
    () => bookings.filter(b => b.status === 'seated').filter(matches).sort(bySlot),
    [bookings, matches],
  );

  // Tables grouped floor → section for the picker (free-only unless "Show all").
  const groupedTables = useMemo(() => {
    const src = showAllTables ? tables : tables.filter(t => !t.open_order_id);
    const byFloor = new Map<string, Map<string, TableItem[]>>();
    for (const t of src) {
      const floor = t.zone || 'Floor';
      const sec = t.section || '';
      if (!byFloor.has(floor)) byFloor.set(floor, new Map());
      const secMap = byFloor.get(floor)!;
      if (!secMap.has(sec)) secMap.set(sec, []);
      secMap.get(sec)!.push(t);
    }
    return byFloor;
  }, [tables, showAllTables]);

  const freeCount = useMemo(() => tables.filter(t => !t.open_order_id).length, [tables]);

  function openPicker(b: Booking) {
    setSeatError(null);
    setShowAllTables(false);
    setSeatingFor(b);
  }

  async function seat(b: Booking, t: TableItem) {
    if (t.open_order_id) {
      const ok = window.confirm(
        `${t.table_number} already has open order #${t.open_order_number}. Seat ${guestLabel(b)} onto it? The reservation will be linked to that running bill.`,
      );
      if (!ok) return;
    }
    setSeatBusyId(t.id);
    setSeatError(null);
    try {
      const r = await api(`/api/crm-calls/bookings/${b.id}/seat`, { method: 'POST', body: { table_id: t.id } });
      let j: { ok?: boolean; error?: string } = {};
      try { j = await r.json(); } catch { /* body may be empty on error */ }
      if (!r.ok || !j.ok) {
        setSeatError(j.error || `Seat failed (HTTP ${r.status})`);
        return;
      }
      setSeatingFor(null);
      setToast(`Seated ${guestLabel(b)} at ${t.table_number}`);
      await load(); // re-fetch so the row moves to "Seated" with its live table/order
    } catch (e: unknown) {
      setSeatError(e instanceof Error ? e.message : 'Network error — please retry');
    } finally {
      setSeatBusyId(null);
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#af4408]/10 rounded-lg"><CalendarCheck className="w-6 h-6 text-[#af4408]" /></div>
          <div>
            <h1 className="text-2xl font-bold text-[#af4408]">Reservations</h1>
            <p className="text-sm text-[#8B7355]">Seat today&apos;s bookings — {prettyToday(today)}</p>
          </div>
        </div>
        <button
          onClick={() => { setLoading(true); load(); }}
          className="flex items-center gap-2 border border-[#D4B896] text-[#af4408] hover:bg-[#FFF1E3] px-4 py-2 rounded-lg text-sm font-medium"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {/* Search + counts */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
          <input
            value={rawSearch}
            onChange={e => setRawSearch(e.target.value)}
            placeholder="Search by guest name or phone…"
            className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg pl-9 pr-9 py-2 text-sm"
          />
          {rawSearch && (
            <button onClick={() => setRawSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8B7355] hover:text-[#2D1B0E]">
              <X size={15} />
            </button>
          )}
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#af4408] bg-[#af4408]/10 rounded-full px-3 py-1.5">
          <Armchair size={13} /> {toSeat.length} to seat
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-green-700 bg-green-500/10 rounded-full px-3 py-1.5">
          <CheckCircle2 size={13} /> {seated.length} seated
        </span>
      </div>

      {loadError && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 text-red-700 px-4 py-3 text-sm">
          <AlertCircle size={16} className="shrink-0" /> {loadError}
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-[#8B7355]"><Loader2 className="w-6 h-6 animate-spin inline" /> Loading…</div>
      ) : (
        <div className="space-y-8">
          {/* To seat */}
          <section>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[#6B5744] mb-3">
              <Armchair size={16} className="text-[#af4408]" /> To seat
            </h2>
            {toSeat.length === 0 ? (
              <div className="card text-center py-10 text-[#8B7355]">
                {search ? 'No matching bookings to seat.' : 'Nothing waiting — every reserved party today is seated or done.'}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {toSeat.map(b => (
                  <div key={b.id} className="card card-hover p-4 flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-bold text-[#2D1B0E] truncate flex items-center gap-1.5">
                          {isVip(b.guest_tags) && <Star size={14} className="text-amber-500 fill-amber-400 shrink-0" />}
                          {guestLabel(b)}
                        </p>
                        {b.guest_phone && <p className="text-[11px] text-[#8B7355] font-mono">{formatPhone(b.guest_phone)}</p>}
                      </div>
                      <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 ${
                        b.status === 'confirmed' ? 'bg-blue-500/10 text-blue-700' : 'bg-[#8B7355]/15 text-[#6B5744]'}`}>
                        {b.status}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#6B5744]">
                      <span className="inline-flex items-center gap-1"><Clock size={13} className="text-[#af4408]" /> {fmtSlot(b.slot_time)}</span>
                      <span className="inline-flex items-center gap-1"><Users size={13} className="text-[#af4408]" /> Party of {b.party_size}</span>
                    </div>
                    {(b.occasion || b.section_pref) && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {b.occasion && (
                          <span className="inline-flex items-center gap-1 text-[11px] bg-[#FFF1E3] border border-[#E8D5C4] rounded-full px-2 py-0.5 text-[#8B5A2B]">
                            <PartyPopper size={11} /> {b.occasion}
                          </span>
                        )}
                        {b.section_pref && (
                          <span className="inline-flex items-center gap-1 text-[11px] bg-[#FFF1E3] border border-[#E8D5C4] rounded-full px-2 py-0.5 text-[#8B5A2B]">
                            <MapPin size={11} /> Prefers {b.section_pref}
                          </span>
                        )}
                      </div>
                    )}
                    <button
                      onClick={() => openPicker(b)}
                      className="mt-auto flex items-center justify-center gap-2 bg-[#af4408] hover:bg-[#8a3506] text-white px-4 py-2 rounded-lg text-sm font-medium"
                    >
                      <Armchair size={16} /> Seat
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Seated */}
          <section>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[#6B5744] mb-3">
              <CheckCircle2 size={16} className="text-green-600" /> Seated
            </h2>
            {seated.length === 0 ? (
              <div className="card text-center py-8 text-[#8B7355]">
                {search ? 'No matching seated parties.' : 'No parties seated yet today.'}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {seated.map(b => {
                  const hasTable = !!(b.table_id && b.table_id.trim());
                  const t = hasTable ? tableById.get(b.table_id as string) : undefined;
                  const tableLabel = t?.table_number || (hasTable ? 'Assigned' : null);
                  const orderId = t?.open_order_id || null;
                  return (
                    <div key={b.id} className="card p-4 flex flex-col gap-3 border-green-200 bg-green-500/[0.03]">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-bold text-[#2D1B0E] truncate flex items-center gap-1.5">
                            {isVip(b.guest_tags) && <Star size={14} className="text-amber-500 fill-amber-400 shrink-0" />}
                            {guestLabel(b)}
                          </p>
                          {b.guest_phone && <p className="text-[11px] text-[#8B7355] font-mono">{formatPhone(b.guest_phone)}</p>}
                        </div>
                        {tableLabel ? (
                          <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold rounded-full px-2.5 py-1 bg-green-600 text-white">
                            <MapPin size={12} /> {tableLabel}
                          </span>
                        ) : (
                          <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-2.5 py-1 bg-green-500/10 text-green-700">
                            <CheckCircle2 size={12} /> Seated
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#6B5744]">
                        <span className="inline-flex items-center gap-1"><Clock size={13} className="text-green-600" /> {fmtSlot(b.slot_time)}</span>
                        <span className="inline-flex items-center gap-1"><Users size={13} className="text-green-600" /> Party of {b.party_size}</span>
                      </div>
                      {orderId ? (
                        <Link
                          href={`/dine-in/order/${orderId}`}
                          className="mt-auto flex items-center justify-center gap-2 border border-[#D4B896] text-[#af4408] hover:bg-[#FFF1E3] px-4 py-2 rounded-lg text-sm font-medium"
                        >
                          View order{t?.open_order_number ? ` #${t.open_order_number}` : ''} <ExternalLink size={14} />
                        </Link>
                      ) : (
                        <p className="mt-auto text-center text-xs text-[#8B7355] py-2">
                          {hasTable ? 'No open order on this table' : 'Seated — no table linked'}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Table picker */}
      {seatingFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => !seatBusyId && setSeatingFor(null)}
        >
          <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 p-5 pb-3 border-b border-[#E8D5C4]">
              <div className="min-w-0">
                <h2 className="font-semibold text-[#2D1B0E] flex items-center gap-2">
                  <Armchair size={18} className="text-[#af4408]" /> Seat {guestLabel(seatingFor)}
                </h2>
                <p className="text-xs text-[#8B7355] mt-0.5">
                  Party of {seatingFor.party_size} · {fmtSlot(seatingFor.slot_time)}
                  {seatingFor.section_pref ? ` · prefers ${seatingFor.section_pref}` : ''}
                </p>
              </div>
              <button onClick={() => !seatBusyId && setSeatingFor(null)} className="text-[#8B7355] hover:text-[#2D1B0E] shrink-0"><X size={18} /></button>
            </div>

            <div className="flex items-center justify-between gap-2 px-5 py-2.5 border-b border-[#E8D5C4] bg-[#FFFBF3]">
              <span className="text-xs text-[#8B7355]">{freeCount} free · {tables.length} total</span>
              <label className="inline-flex items-center gap-2 text-xs text-[#6B5744] cursor-pointer select-none">
                <input type="checkbox" checked={showAllTables} onChange={e => setShowAllTables(e.target.checked)} className="accent-[#af4408]" />
                Show occupied tables too
              </label>
            </div>

            {seatError && (
              <div className="mx-5 mt-3 flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 text-red-700 px-3 py-2 text-sm">
                <AlertCircle size={16} className="shrink-0" /> {seatError}
              </div>
            )}

            <div className="overflow-y-auto p-5 pt-3 space-y-4">
              {groupedTables.size === 0 ? (
                <div className="text-center py-10 text-[#8B7355] text-sm">
                  {tables.length === 0
                    ? <>No tables set up. <Link href="/dine-in/tables" className="text-[#af4408] hover:underline">Add tables →</Link></>
                    : 'No free tables. Turn on "Show occupied tables too" to seat onto a running table.'}
                </div>
              ) : (
                [...groupedTables.entries()].map(([floor, secMap]) => (
                  <div key={floor}>
                    <h3 className="text-xs font-bold text-[#2D1B0E] mb-2">{floor}</h3>
                    <div className="space-y-3">
                      {[...secMap.entries()].map(([sec, list]) => (
                        <div key={`${floor}:${sec}`}>
                          {sec && <div className="text-[10px] font-semibold uppercase tracking-wide text-[#af4408] mb-1.5">Section {sec}</div>}
                          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                            {list.map(t => {
                              const occupied = !!t.open_order_id;
                              const busy = seatBusyId === t.id;
                              return (
                                <button
                                  key={t.id}
                                  onClick={() => seat(seatingFor, t)}
                                  disabled={!!seatBusyId}
                                  className={`relative rounded-lg p-2.5 text-left border transition-colors disabled:opacity-60 ${
                                    occupied
                                      ? 'bg-amber-500/10 border-amber-300 hover:bg-amber-500/20'
                                      : 'bg-green-500/10 border-green-300 hover:bg-green-500/20'}`}
                                >
                                  <p className="text-sm font-bold text-[#2D1B0E] leading-tight">{t.table_number}</p>
                                  <p className="text-[10px] text-[#8B7355]">{t.seats} seats</p>
                                  <p className={`text-[10px] font-medium ${occupied ? 'text-amber-700' : 'text-green-700'}`}>
                                    {occupied ? `#${t.open_order_number}` : 'Free'}
                                  </p>
                                  {busy && <Loader2 className="absolute top-1.5 right-1.5 w-3.5 h-3.5 animate-spin text-[#af4408]" />}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Success toast */}
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 rounded-lg bg-green-600 text-white px-4 py-2.5 text-sm font-medium shadow-lg">
          <CheckCircle2 size={16} /> {toast}
        </div>
      )}
    </div>
  );
}
