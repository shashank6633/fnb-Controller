'use client';

/**
 * Quick Booking modal — the ONE booking-capture surface shared by the
 * screen-pop (CTScreenPop), Guest 360 and the Recovery queue.
 *
 * Contract (CRM_DECISIONS.md — both callers depend on these props):
 *   { open, onClose, onSaved?, guestId?, guestName?, sourceCallId? }
 *
 * - With `guestId`: the guest is fixed (launched from a pop/profile).
 * - Without: inline debounced guest search (GET /api/crm-calls/guests?search=)
 *   plus a quick-create (name + phone → POST /api/crm-calls/guests; a 409
 *   "already exists" simply selects the existing guest).
 * - Save → POST /api/crm-calls/bookings with channel:'call' and the
 *   source_call_id when launched from a call. Phase 2 swaps the slot input
 *   for a real availability picker behind the same API.
 *
 * Shell mirrors the house safe-modal (menu-items EditItemModal): card capped
 * to the viewport, body scrolls internally, header + footer stay on screen.
 */

import { useEffect, useState } from 'react';
import { X, Search, UserPlus, Loader2, CheckCircle, CalendarCheck, Phone, Music, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import { BOOKING_PREFERENCES, PREF_LIVE_BAND } from '@/lib/ct/live-band';
import PhoneField from '@/components/PhoneField';

interface GuestLite {
  id: string;
  name: string;
  phone_e164?: string;
  tags?: string[];
  metrics?: { badge?: string };
}

export interface QuickBookingModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (booking: any) => void;
  guestId?: string;
  guestName?: string;
  sourceCallId?: string;
}

const OCCASIONS = ['Casual', 'Birthday', 'Anniversary', 'Corporate', 'Other'];
const SECTIONS = ['Any', 'Rooftop', 'Indoor'];

/** Today's date in IST as YYYY-MM-DD (bookings are restaurant-local). */
const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** YYYY-MM-DD → "12 Aug", for warning copy a GRE reads mid-call. */
const shortDate = (d: string) => {
  const t = Date.parse(`${d}T00:00:00`);
  return isNaN(t) ? d : new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

interface BandLite { id: string; name: string; start_time?: string; area?: string; outlet_id?: string }

/**
 * The band lookup's outcome, kept as a state machine rather than "band or null"
 * because `none` (checked, nothing scheduled) and `error` (could not check) owe
 * the GRE different sentences, and neither may be silently shown as "no band".
 */
type BandState = 'idle' | 'loading' | 'found' | 'none' | 'error';

export default function QuickBookingModal({
  open, onClose, onSaved, guestId, guestName, sourceCallId,
}: QuickBookingModalProps) {
  // ── Guest selection ──
  const [guest, setGuest] = useState<GuestLite | null>(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<GuestLite[]>([]);
  const [searching, setSearching] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  // ── Booking fields ──
  const [date, setDate] = useState(istToday());
  const [slot, setSlot] = useState('');
  const [partySize, setPartySize] = useState(2);
  const [occasion, setOccasion] = useState('Casual');
  const [sectionPref, setSectionPref] = useState('Any');
  const [preference, setPreference] = useState('');
  const [notes, setNotes] = useState('');

  // ── Live Band for the chosen date ──
  const [band, setBand] = useState<BandLite | null>(null);
  const [bandState, setBandState] = useState<BandState>('idle');
  /** The GRE has seen the "no band scheduled" warning and clicked Save again. */
  const [ackNoBand, setAckNoBand] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Reset everything each time the modal opens (it is long-lived in the pop).
  useEffect(() => {
    if (!open) return;
    setGuest(guestId ? { id: guestId, name: guestName || '' } : null);
    setSearch('');
    setResults([]);
    setShowCreate(false);
    setNewName(guestName || '');
    setNewPhone('');
    setDate(istToday());
    setSlot('');
    setPartySize(2);
    setOccasion('Casual');
    setSectionPref('Any');
    setPreference('');
    setNotes('');
    setBand(null);
    setBandState('idle');
    setAckNoBand(false);
    setSaving(false);
    setError('');
  }, [open, guestId, guestName]);

  /**
   * Look the date's Live Band up as soon as the preference is set, so the
   * answer is on screen while the guest is still on the line.
   *
   * The ordering below mirrors resolveLiveBand() in src/lib/ct/live-band.ts
   * exactly — the server is what actually stamps the booking, and a modal that
   * named a different band than the one stored would be worse than no modal.
   * The API already filters to (current outlet OR legacy blank), so the only
   * non-blank outlet_id that can come back IS the current outlet; preferring it
   * here reproduces the server's first tiebreak without knowing the outlet id.
   */
  useEffect(() => {
    if (!open || preference !== PREF_LIVE_BAND || !date) { setBand(null); setBandState('idle'); return; }
    let stale = false;
    setBandState('loading');
    (async () => {
      try {
        const r = await fetch(`/api/crm-calls/entertainment?date=${encodeURIComponent(date)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const raw: unknown[] = Array.isArray(j?.entertainment) ? j.entertainment : [];
        const field = (e: unknown, k: string) => String((e as Record<string, unknown>)?.[k] ?? '');
        const bands: BandLite[] = raw
          .filter(e => field(e, 'type') === 'band' && field(e, 'name').trim() !== '')
          .map(e => ({
            id: field(e, 'id'), name: field(e, 'name'), start_time: field(e, 'start_time'),
            area: field(e, 'area'), outlet_id: field(e, 'outlet_id'),
          }))
          .sort((a, b) => {
            const rank = (e: BandLite) => (e.outlet_id === '' ? 1 : 0);
            const timed = (e: BandLite) => ((e.start_time || '').trim() === '' ? 1 : 0);
            return rank(a) - rank(b)
              || timed(a) - timed(b)
              || (a.start_time || '').localeCompare(b.start_time || '')
              || a.name.localeCompare(b.name);
          });
        if (stale) return;
        if (bands.length) { setBand(bands[0]); setBandState('found'); }
        else { setBand(null); setBandState('none'); }
      } catch {
        if (!stale) { setBand(null); setBandState('error'); }
      }
    })();
    return () => { stale = true; };
  }, [open, preference, date]);

  // A new date or preference is a new question — the previous "save anyway"
  // must not carry over and silently book a second blank band night.
  useEffect(() => { setAckNoBand(false); }, [preference, date]);

  // Debounced guest search (only when no guest is selected).
  useEffect(() => {
    if (!open || guest || search.trim().length < 2) { setResults([]); setSearching(false); return; }
    let stale = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/crm-calls/guests?search=${encodeURIComponent(search.trim())}&pageSize=8`);
        let list: GuestLite[] = [];
        if (r.ok) {
          try {
            const j = await r.json();
            if (Array.isArray(j?.guests)) list = j.guests;
          } catch { /* malformed body → empty list */ }
        }
        if (!stale) setResults(list);
      } catch {
        if (!stale) setResults([]);
      } finally {
        if (!stale) setSearching(false);
      }
    }, 300);
    return () => { stale = true; clearTimeout(t); };
  }, [search, open, guest]);

  if (!open) return null;

  const createGuest = async () => {
    const phone = newPhone.trim();
    if (!phone) { setError('Phone number is required to create a guest'); return; }
    setCreateBusy(true);
    setError('');
    try {
      const res = await api('/api/crm-calls/guests', {
        method: 'POST',
        body: { name: newName.trim(), phone, source: 'call' },
      });
      let j: any = {};
      try { j = await res.json(); } catch { /* keep {} */ }
      if (res.status === 409 && j?.existing_guest_id) {
        // Already on file — just select them.
        setGuest({ id: String(j.existing_guest_id), name: newName.trim(), phone_e164: phone });
        setShowCreate(false);
      } else if (!res.ok) {
        setError(j?.error || `Could not create guest (HTTP ${res.status})`);
      } else {
        const g = j?.guest || {};
        setGuest({ id: String(g.id || ''), name: String(g.name || newName.trim()), phone_e164: String(g.phone_e164 || phone) });
        setShowCreate(false);
      }
    } catch (e: any) {
      setError(e?.message || 'Network error — guest not created');
    } finally {
      setCreateBusy(false);
    }
  };

  const save = async () => {
    if (!guest?.id) { setError('Pick or create a guest first'); return; }
    if (!date) { setError('Booking date is required'); return; }
    // A Live Band booking on a date with no band is a promise nobody has made
    // yet. It still saves — refusing it would lose the table — but not on the
    // click that discovers it, so the GRE cannot hang up unaware.
    if (preference === PREF_LIVE_BAND && bandState === 'none' && !ackNoBand) {
      setAckNoBand(true);
      setError(`No Live Band is on the calendar for ${shortDate(date)}. Tell the guest you will confirm, then click Save Booking again to take it anyway.`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await api('/api/crm-calls/bookings', {
        method: 'POST',
        body: {
          guest_id: guest.id,
          booking_date: date,
          slot_time: slot,
          party_size: partySize,
          occasion,
          section_pref: sectionPref,
          preference,
          notes,
          channel: 'call',
          ...(sourceCallId ? { source_call_id: sourceCallId } : {}),
        },
      });
      let j: any = {};
      try { j = await res.json(); } catch { /* keep {} */ }
      if (!res.ok) {
        setError(j?.error || `Booking failed (HTTP ${res.status})`);
        setSaving(false);
        return;
      }
      onSaved?.(j?.booking ?? j);
      setSaving(false);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Network error — booking not saved');
      setSaving(false);
    }
  };

  const inputCls = 'w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E]';

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      {/* House safe-modal shell: card capped to viewport, body scrolls
          internally, so header + Save/Cancel stay on screen on phones. */}
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="relative w-full max-w-lg bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
            <CalendarCheck className="w-5 h-5 text-[#af4408]" /> Quick Booking
          </h2>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-[#FFF1E3]">
            <X className="w-5 h-5 text-[#6B5744]" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
          {/* ── Guest ── */}
          <div>
            <label className="block text-xs font-medium text-[#6B5744] mb-1">Guest *</label>
            {guest ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[#2D1B0E] truncate">{guest.name || 'Guest'}</p>
                  {guest.phone_e164 && (
                    <p className="text-xs text-[#8B7355] font-mono flex items-center gap-1">
                      <Phone className="w-3 h-3" /> {formatPhone(guest.phone_e164) || guest.phone_e164}
                    </p>
                  )}
                </div>
                {/* Fixed guest when launched from a pop/profile; changeable otherwise */}
                {!guestId && (
                  <button onClick={() => { setGuest(null); setSearch(''); }}
                          className="text-xs text-[#af4408] font-medium hover:underline shrink-0">
                    Change
                  </button>
                )}
              </div>
            ) : showCreate ? (
              <div className="space-y-2 p-3 bg-[#FFFBF5] border border-[#E8D5C4] rounded-lg">
                <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
                       placeholder="Guest name" className={inputCls} />
                <PhoneField value={newPhone} onChange={setNewPhone}
                       placeholder="mobile number" inputClassName={inputCls} />
                <div className="flex gap-2">
                  <button onClick={createGuest} disabled={createBusy || !newPhone.trim()}
                          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-xs font-semibold">
                    {createBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                    Create Guest
                  </button>
                  <button onClick={() => setShowCreate(false)}
                          className="px-3 py-2 text-xs text-[#6B5744] bg-[#FFF1E3] rounded-lg hover:bg-[#E8D5C4]">
                    Back to search
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="relative">
                  <Search className="w-4 h-4 text-[#8B7355] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                         placeholder="Search name or phone…" className={`${inputCls} pl-9`} />
                  {searching && <Loader2 className="w-4 h-4 text-[#8B7355] animate-spin absolute right-3 top-1/2 -translate-y-1/2" />}
                </div>
                {results.length > 0 && (
                  <ul className="mt-1 border border-[#E8D5C4] rounded-lg divide-y divide-[#F0E4D6] max-h-44 overflow-y-auto bg-white">
                    {results.map(g => (
                      <li key={g.id}>
                        <button onClick={() => setGuest(g)}
                                className="w-full text-left px-3 py-2 hover:bg-[#FFF8F0] flex items-center justify-between gap-2">
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-[#2D1B0E] truncate">{g.name || 'Unnamed guest'}</span>
                            <span className="block text-xs text-[#8B7355] font-mono">{formatPhone(g.phone_e164 || '') || g.phone_e164 || ''}</span>
                          </span>
                          {g.metrics?.badge && (
                            <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#FFF1E3] text-[#af4408] border border-[#E8D5C4]">
                              {g.metrics.badge}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {search.trim().length >= 2 && !searching && results.length === 0 && (
                  <p className="text-xs text-[#8B7355] mt-1">No guests match “{search.trim()}”.</p>
                )}
                <button onClick={() => setShowCreate(true)}
                        className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-[#af4408] hover:underline">
                  <UserPlus className="w-3.5 h-3.5" /> New guest (name + phone)
                </button>
              </div>
            )}
          </div>

          {/* ── Booking details ── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Date *</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Slot time</label>
              <input type="time" value={slot} onChange={e => setSlot(e.target.value)} className={inputCls} />
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Party size</label>
              <input type="number" min={1} max={500} step={1} value={partySize}
                     onChange={e => setPartySize(Math.max(1, Math.min(500, Math.round(Number(e.target.value) || 1))))}
                     className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Occasion</label>
              <select value={occasion} onChange={e => setOccasion(e.target.value)} className={inputCls}>
                {OCCASIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Section</label>
              <select value={sectionPref} onChange={e => setSectionPref(e.target.value)} className={inputCls}>
                {SECTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {/* Preference = what they are coming FOR. Its own field, not a
                flavour of Occasion (what they celebrate) or Section (where they
                sit). Defaults to unset: guessing "Dining" for every caller
                would make the field useless the day someone reports on it. */}
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Preference</label>
              <select value={preference} onChange={e => setPreference(e.target.value)} className={inputCls}>
                <option value="">Not stated</option>
                {BOOKING_PREFERENCES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>

          {/* Live Band answer for the chosen date — the question the phone is
              actually ringing about. Never left blank-and-silent: `none` says
              so in as many words, because that is a callback the GRE owes. */}
          {preference === PREF_LIVE_BAND && (
            <>
              {bandState === 'loading' && (
                <p className="text-xs text-[#8B7355] flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking the entertainment calendar…
                </p>
              )}
              {bandState === 'found' && band && (
                <p className="text-xs text-[#2D1B0E] bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2 flex items-start gap-1.5">
                  <Music className="w-3.5 h-3.5 text-[#af4408] mt-px shrink-0" />
                  <span>
                    <span className="font-semibold">{band.name}</span> plays on {shortDate(date)}
                    {band.start_time ? ` from ${band.start_time}` : ''}{band.area ? ` · ${band.area}` : ''}.
                    <span className="text-[#8B7355]"> Saved with the booking.</span>
                  </span>
                </p>
              )}
              {bandState === 'none' && (
                <p className="text-xs text-[#8a3506] bg-[#FFF1E3] border border-[#af4408]/40 rounded-lg px-3 py-2 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                  <span>
                    <span className="font-semibold">No Live Band is on the calendar for {shortDate(date)}.</span>{' '}
                    Do not promise one — the booking will save with no band recorded.
                    Ask the manager to add it, then follow up with the guest.
                  </span>
                </p>
              )}
              {bandState === 'error' && (
                <p className="text-xs text-[#8B7355] bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg px-3 py-2 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                  <span>Could not read the entertainment calendar just now, so the band for {shortDate(date)} is unconfirmed. The preference will still be saved.</span>
                </p>
              )}
            </>
          )}

          <div>
            <label className="block text-xs font-medium text-[#6B5744] mb-1">Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                      placeholder="Cake, window table, allergy…" className={inputCls} />
          </div>

          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
        </div>

        <div className="flex justify-end gap-3 px-6 py-3 border-t border-[#E8D5C4] shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B5744] bg-[#FFF1E3] rounded-lg hover:bg-[#E8D5C4]">
            Cancel
          </button>
          <button onClick={save} disabled={saving || !guest?.id || !date}
                  className="flex items-center gap-2 px-5 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-sm font-medium">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            {saving ? 'Saving…'
              : ackNoBand && preference === PREF_LIVE_BAND && bandState === 'none' ? 'Save without a band'
              : 'Save Booking'}
          </button>
        </div>
      </div>
    </div>
  );
}
