/**
 * Shared party revenue/attribution helpers, used by BOTH /api/party-events (the
 * sales-era P&L page) and /api/party-events/pnl (the booking-based P&L / Food
 * Consumption). Single source of truth so the two never drift.
 *
 * Revenue for a party = the AKAN Party Manager "Party Bookings" sheet Final Total
 * Amount (col U), matched by party_unique_id, but only counted once the party is
 * confirmed AND its date has passed (revenueGate). Party requisitions carry no
 * party_unique_id — they link to a party only by event_name+date, and the name
 * they were raised under may be the contact person, company or FP id — hence
 * candidateNames() + the resolver below match on date + ANY candidate name.
 */
import type { getDb } from '@/lib/db';

type DB = ReturnType<typeof getDb>;

export interface CachedParty {
  party_unique_id?: string; fp_id?: string; event_name?: string; event_date?: string;
  guest_name?: string; company?: string; contact_person?: string;
  pax_expected?: number; min_guarantee?: number; status?: string;
}

/** party_unique_id -> Final Total Amount, from settings['party_bookings_cache']. */
export function loadBookingsCache(db: DB): Map<string, number> {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'party_bookings_cache'`).get() as { value: string } | undefined;
    if (!row) return new Map();
    const parsed = JSON.parse(row.value);
    const m = new Map<string, number>();
    for (const b of parsed.bookings || []) m.set(b.party_unique_id, Number(b.final_total) || 0);
    return m;
  } catch { return new Map(); }
}

/** All parties from settings['upcoming_parties_cache'] (F&P Records). */
export function loadUpcomingParties(db: DB): CachedParty[] {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'upcoming_parties_cache'`).get() as { value: string } | undefined;
    if (!row) return [];
    const parsed = JSON.parse(row.value);
    return (parsed.parties || []).map((p: any) => ({
      party_unique_id: p.party_unique_id,
      fp_id: p.fp_id,
      // Match how "Raise Req" derives the requisition's event_name (contact_person first).
      event_name: p.contact_person || p.guest_name || p.company || p.fp_id,
      event_date: p.date_of_event,
      guest_name: p.guest_name,
      company: p.company,
      contact_person: p.contact_person,
      pax_expected: p.pax_expected,
      min_guarantee: p.min_guarantee,
      status: p.status,               // F&P Records status: Approved | Draft (sheet's real values)
    }));
  } catch { return []; }
}

/**
 * Final Total counts as revenue only when the party is locked-in — status
 * 'Approved' (the value the sheet uses; Confirmed/Done accepted as synonyms) — AND
 * the event date is over (event_date <= today). Returns the withheld reason or null.
 */
export function revenueGate(status: string | undefined, eventDate: string | undefined, today: string): { allow: boolean; reason: string | null } {
  const s = String(status || '').trim().toLowerCase();
  const confirmed = s === 'approved' || s === 'confirmed' || s === 'done';
  if (!confirmed) return { allow: false, reason: 'awaiting confirmation' };
  if (!eventDate || eventDate > today) return { allow: false, reason: 'party not over yet' };
  return { allow: true, reason: null };
}

/** Every name a party's requisition might have been raised under. */
export function candidateNames(p: CachedParty): string[] {
  return [...new Set([p.contact_person, p.guest_name, p.company, p.event_name, p.fp_id]
    .map(x => String(x || '').trim()).filter(Boolean))];
}

/**
 * Resolve the booking revenue for a party requisition event (event_name+date):
 * find the cached party whose date matches AND whose candidate names include the
 * event_name, then apply the gate to its booking Final Total.
 */
export function resolveBookingRevenue(
  bookings: Map<string, number>, parties: CachedParty[],
  eventName: string, eventDate: string, today: string,
  canonicalOnly = false,
): { party_unique_id: string | null; booking_total: number; revenue: number; withheld_reason: string | null } {
  const en = String(eventName || '').trim();
  const p = parties.find(x => x.event_date === eventDate && candidateNames(x).includes(en));
  if (!p || !p.party_unique_id) return { party_unique_id: null, booking_total: 0, revenue: 0, withheld_reason: 'no booking row' };
  // A party can have requisitions raised under several names (contact person AND
  // company). To avoid attributing its one booking Final Total to every such event
  // row, only the party's canonical name (contact_person-first) carries the revenue.
  if (canonicalOnly && en !== String(p.event_name || '').trim()) {
    return { party_unique_id: p.party_unique_id, booking_total: 0, revenue: 0, withheld_reason: 'counted on the primary event row' };
  }
  const total = bookings.get(p.party_unique_id) || 0;
  const gate = revenueGate(p.status, p.event_date, today);
  return {
    party_unique_id: p.party_unique_id,
    booking_total: total,
    revenue: gate.allow ? total : 0,
    withheld_reason: gate.allow ? null : gate.reason,
  };
}
