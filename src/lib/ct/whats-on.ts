/**
 * GRE "What's On" board — aggregator.
 *
 * Pulls together everything a Guest Relations Executive needs to know about a
 * single date when a guest calls: standalone entertainment calendar, party
 * functions (from the cached AKAN "F&P Records" feed), table reservations,
 * manager talking-points, and a how-full capacity gauge.
 *
 * Design rules (see whats-on build contract):
 *  - NEVER call Google Sheets live — read the cached JSON from `settings`.
 *  - NEVER throw. Every source is wrapped in try/catch and degrades to empty,
 *    so a single bad source can never take the whole board down.
 */
import type Database from 'better-sqlite3';
import { ctSettings } from '@/lib/ct/settings';
import type { UpcomingParty } from '@/lib/fp-records-mapper';
import type { PartyBooking } from '@/lib/party-bookings-mapper';

export interface WhatsOnPanels {
  entertainment: boolean;
  parties: boolean;
  reservations: boolean;
  specials: boolean;
  capacity: boolean;
  call_context: boolean;
}

export interface WhatsOnEntertainment {
  id: string;
  source: 'calendar' | 'party';
  type: string;
  name: string;
  start_time: string;
  end_time: string;
  area: string;
  description: string;
}

export interface WhatsOnParty {
  fp_id: string;
  name: string;
  guest_name: string;
  phone: string;
  pax: number;
  area: string;        // = place
  package: string;
  time: string;
  status: string;
  company: string;
  place: string;
  handled_by: string;
  occasion: string;
  special_requirements: string;
}

export interface PartyStatusCounts {
  confirmed: number;
  enquiry: number;
  tentative: number;
  completed: number;
  cancelled: number;
  other: number;
}

export interface WhatsOnReservation {
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

export interface WhatsOnCapacity {
  capacity: number;
  reserved_covers: number;
  party_pax: number;
  total: number;
  pct: number;
}

export interface WhatsOnResult {
  date: string;
  panels: WhatsOnPanels;
  entertainment: WhatsOnEntertainment[];
  parties: WhatsOnParty[];
  reservations: WhatsOnReservation[];
  specials: string;
  capacity: WhatsOnCapacity | null;
  // Where the parties came from + when the sheet cache last synced, for the
  // board's "synced X ago / refresh" affordance.
  party_sync: { source: 'sheet-cache' | 'db-fallback' | 'none'; fetched_at: string };
  // Breakdown of the day's bookings by status (so a GRE sees enquiries vs
  // confirmed at a glance before promising a guest the place).
  party_status: PartyStatusCounts;
  summary: {
    entertainment_count: number;
    parties_count: number;
    party_pax: number;
    reservations_count: number;
    reserved_covers: number;
  };
}

const DEFAULT_PANELS: WhatsOnPanels = {
  entertainment: true,
  parties: true,
  reservations: true,
  specials: true,
  capacity: true,
  call_context: true,
};

/** Parse whatson_panels JSON → the 6 known boolean keys (default all true). */
function parsePanels(raw: string | undefined): WhatsOnPanels {
  const out: WhatsOnPanels = { ...DEFAULT_PANELS };
  try {
    const obj = JSON.parse(raw || '{}');
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(DEFAULT_PANELS) as (keyof WhatsOnPanels)[]) {
        if (k in obj) out[k] = !!obj[k];
      }
    }
  } catch {
    /* keep defaults */
  }
  return out;
}

/** Read the cached AKAN party feed from `settings` — never live-fetches. Returns
 *  the date-matched parties plus when the whole cache was last synced. */
function readPartyCache(
  db: Database.Database,
  date: string,
): { parties: UpcomingParty[]; fetched_at: string } {
  try {
    const row = db
      .prepare(`SELECT value FROM settings WHERE key = 'upcoming_parties_cache'`)
      .get() as { value: string } | undefined;
    if (!row?.value) return { parties: [], fetched_at: '' };
    const parsed = JSON.parse(row.value);
    const list: UpcomingParty[] = Array.isArray(parsed?.parties) ? parsed.parties : [];
    return {
      parties: list.filter((p) => p && p.date_of_event === date),
      fetched_at: typeof parsed?.fetched_at === 'string' ? parsed.fetched_at : '',
    };
  } catch {
    return { parties: [], fetched_at: '' };
  }
}

function isCancelled(status: string | undefined): boolean {
  // startsWith, not includes — so a status like "No-cancel guarantee" or
  // "Confirmed (cancellation waived)" is NOT treated as a cancellation.
  return (status || '').trim().toLowerCase().startsWith('cancel');
}

/** Bucket a free-text booking status into the six the board summarises. */
function classifyStatus(s: string | undefined): keyof PartyStatusCounts {
  const t = (s || '').trim().toLowerCase();
  if (!t) return 'other';
  if (t.startsWith('cancel')) return 'cancelled';
  if (t.includes('complet') || t.includes('done')) return 'completed';
  if (t.includes('confirm')) return 'confirmed';
  if (t.includes('tentat') || t.includes('hold') || t.includes('provisional')) return 'tentative';
  if (t.includes('enquir') || t.includes('inquir') || t.includes('lead') || t.includes('new')) return 'enquiry';
  return 'other';
}

/**
 * Build the whole board for `date`. `outletId` scopes the standalone
 * entertainment calendar (legacy blank-outlet rows are always included).
 */
export function buildWhatsOn(
  db: Database.Database,
  date: string,
  outletId: string | null,
): WhatsOnResult {
  // ── Settings (panels / specials / capacity) ──────────────────────────────
  let panels: WhatsOnPanels = { ...DEFAULT_PANELS };
  let specials = '';
  let capacitySeats = 0;
  try {
    const s = ctSettings(db);
    panels = parsePanels(s.whatson_panels);
    specials = typeof s.whatson_specials === 'string' ? s.whatson_specials : '';
    const cap = parseInt(s.whatson_capacity || '0', 10);
    capacitySeats = Number.isFinite(cap) && cap > 0 ? cap : 0;
  } catch {
    /* keep defaults */
  }

  // ── Entertainment calendar (ct_entertainment) ────────────────────────────
  const entertainment: WhatsOnEntertainment[] = [];
  try {
    // Always scope to (current outlet OR legacy blank). When outletId is null
    // (no default outlet configured) oid='' → this matches ONLY blank-outlet
    // rows, never every outlet — so a missing outlet can't leak cross-outlet.
    const oid = (outletId || '').trim();
    const rows = db
      .prepare(
        `SELECT id, type, name, start_time, end_time, area, description
         FROM ct_entertainment
         WHERE event_date = ? AND (outlet_id = ? OR outlet_id = '')
         ORDER BY start_time, name`,
      )
      .all(date, oid) as any[];
    for (const r of rows) {
      entertainment.push({
        id: String(r.id),
        source: 'calendar',
        type: String(r.type || 'other'),
        name: String(r.name || ''),
        start_time: String(r.start_time || ''),
        end_time: String(r.end_time || ''),
        area: String(r.area || ''),
        description: String(r.description || ''),
      });
    }
  } catch {
    /* leave calendar rows out on failure */
  }

  // ── Party FUNCTIONS from F&P Records (prepared) → used ONLY to fold their
  //    entertainment (DJ / decor / notes) into the Entertainment panel. The
  //    parties LIST itself comes from the fuller "Party Bookings" tab below. ──
  let fpParties: UpcomingParty[] = [];
  try {
    fpParties = readPartyCache(db, date).parties.filter((p) => !isCancelled(p.status));
  } catch {
    fpParties = [];
  }
  try {
    for (const p of fpParties) {
      const dj = (p.dj || '').trim();
      const notes = (p.entertainment_notes || '').trim();
      const decor = (p.decor || '').trim();
      const mc = (p.mc || '').trim();
      if (!dj && !notes && !decor && !mc) continue;
      const who = (p.guest_name || p.company || p.fp_id || 'Party').trim();
      const act = dj ? dj : 'Live entertainment';
      entertainment.push({
        id: `party-${p.fp_id}`,
        source: 'party',
        type: dj ? 'dj' : 'event',
        name: `${who} — ${act}`,
        start_time: (p.time_of_event || p.drinks_start_time || '').trim(),
        end_time: (p.drinks_end_time || '').trim(),
        area: (p.allocated_area || '').trim(),
        description: notes || decor || dj || mc,
      });
    }
  } catch {
    /* skip party entertainment on failure */
  }

  // ── Parties & Events — the FULL booking pipeline from the "Party Bookings"
  //    sheet tab (every enquiry / confirmed / tentative, ANY status), so a GRE
  //    can see who's already booked the place before promising a guest. Falls
  //    back to the local `parties` table when that cache hasn't synced yet. ────
  let bookingsRead: { bookings: PartyBooking[]; fetched_at: string } = { bookings: [], fetched_at: '' };
  try {
    const row = db
      .prepare(`SELECT value FROM settings WHERE key = 'party_bookings_cache'`)
      .get() as { value: string } | undefined;
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      bookingsRead = {
        bookings: Array.isArray(parsed?.bookings) ? parsed.bookings : [],
        fetched_at: typeof parsed?.fetched_at === 'string' ? parsed.fetched_at : '',
      };
    }
  } catch {
    bookingsRead = { bookings: [], fetched_at: '' };
  }
  const dateBookings = bookingsRead.bookings.filter((b) => b && b.date === date);

  let partySource: 'sheet-cache' | 'db-fallback' | 'none' =
    dateBookings.length > 0 ? 'sheet-cache' : 'none';
  let partyFetchedAt = bookingsRead.fetched_at;

  let parties: WhatsOnParty[] = dateBookings.map((b) => ({
    fp_id: (b.party_unique_id || '').trim(),
    name: (b.host_name || b.company || b.party_unique_id || 'Party').trim(),
    guest_name: (b.host_name || '').trim(),
    phone: (b.phone || '').trim(),
    pax: b.expected_pax || 0,
    area: (b.place || '').trim(),
    package: (b.package || '').trim(),
    time: (b.party_time || '').trim(),
    status: (b.status || '').trim(),
    company: (b.company || '').trim(),
    place: (b.place || '').trim(),
    handled_by: (b.handled_by || '').trim(),
    occasion: (b.occasion || '').trim(),
    special_requirements: (b.special_requirements || '').trim(),
  }));

  // Fallback: only when the Party Bookings cache has NEVER synced (no timestamp)
  // → read the local `parties` table. Once the sheet has synced, an empty date
  // is authoritatively empty (don't resurrect stale local rows as "ghost" parties).
  if (parties.length === 0 && !bookingsRead.fetched_at) {
    try {
      const rows = db
        .prepare(
          `SELECT id, name, guest_count, status, venue, floor,
                  akan_unique_id, akan_host_name, akan_company, akan_phone,
                  akan_occasion, akan_package
           FROM parties
           WHERE date = ?
           ORDER BY name`,
        )
        .all(date) as any[];
      if (rows.length > 0) {
        partySource = 'db-fallback';
        partyFetchedAt = '';
        parties = rows.map((p) => ({
          fp_id: String(p.akan_unique_id || p.id || ''),
          name: String(p.akan_host_name || p.name || '').trim(),
          guest_name: String(p.akan_host_name || p.name || '').trim(),
          phone: String(p.akan_phone || '').trim(),
          pax: Number(p.guest_count) || 0,
          area: String(p.venue || p.floor || '').trim(),
          package: String(p.akan_package || '').trim(),
          time: '',
          status: String(p.status || '').trim(),
          company: String(p.akan_company || '').trim(),
          place: String(p.venue || p.floor || '').trim(),
          handled_by: '',
          occasion: String(p.akan_occasion || '').trim(),
          special_requirements: '',
        }));
      }
    } catch {
      /* leave parties empty on failure */
    }
  }

  // Status breakdown (enquiry vs confirmed vs …) + sort cancelled last.
  const partyStatus: PartyStatusCounts = {
    confirmed: 0, enquiry: 0, tentative: 0, completed: 0, cancelled: 0, other: 0,
  };
  for (const p of parties) partyStatus[classifyStatus(p.status)]++;
  parties.sort((a, b) => {
    const ca = isCancelled(a.status) ? 1 : 0;
    const cb = isCancelled(b.status) ? 1 : 0;
    if (ca !== cb) return ca - cb;
    return (a.time || '').localeCompare(b.time || '') || (a.guest_name || '').localeCompare(b.guest_name || '');
  });

  // ── Reservations (ct_bookings LEFT JOIN ct_guests) ───────────────────────
  const reservations: WhatsOnReservation[] = [];
  try {
    const rows = db
      .prepare(
        `SELECT b.id, b.slot_time, b.party_size, b.occasion, b.section_pref,
                b.status, b.table_id,
                g.name AS guest_name, g.phone_e164 AS guest_phone
         FROM ct_bookings b
         LEFT JOIN ct_guests g ON g.id = b.guest_id
         WHERE b.booking_date = ?
         ORDER BY b.slot_time, b.created_at`,
      )
      .all(date) as any[];
    for (const r of rows) {
      reservations.push({
        id: String(r.id),
        slot_time: String(r.slot_time || ''),
        guest_name: String(r.guest_name || ''),
        guest_phone: String(r.guest_phone || ''),
        party_size: typeof r.party_size === 'number' ? r.party_size : Number(r.party_size) || 0,
        occasion: String(r.occasion || ''),
        section_pref: String(r.section_pref || ''),
        status: String(r.status || ''),
        table_id: r.table_id != null ? String(r.table_id) : null,
      });
    }
  } catch {
    /* leave reservations empty on failure */
  }

  // ── Capacity gauge ───────────────────────────────────────────────────────
  const reservedCovers = reservations
    .filter((r) => {
      const s = (r.status || '').toLowerCase();
      return s !== 'cancelled' && s !== 'no_show';
    })
    .reduce((sum, r) => sum + (r.party_size || 0), 0);

  // Covers from parties = expected pax of NON-cancelled bookings (a cancelled
  // party frees the place, so it doesn't occupy capacity).
  const partyPax = parties
    .filter((p) => !isCancelled(p.status))
    .reduce((sum, p) => sum + (p.pax || 0), 0);

  let capacity: WhatsOnCapacity | null = null;
  if (capacitySeats > 0) {
    const total = reservedCovers + partyPax;
    capacity = {
      capacity: capacitySeats,
      reserved_covers: reservedCovers,
      party_pax: partyPax,
      total,
      pct: Math.round((total / capacitySeats) * 100),
    };
  }

  // Summary is computed from the FULL data (so the at-a-glance line + capacity
  // gauge stay correct even when a panel's list is hidden)…
  const summary = {
    entertainment_count: entertainment.length,
    // The at-a-glance headline counts ACTIVE bookings (non-cancelled) so it agrees
    // with party_pax; the panel card subtitle shows the full "N on this date +
    // status breakdown" including cancelled.
    parties_count: parties.filter((p) => !isCancelled(p.status)).length,
    party_pax: partyPax,
    reservations_count: reservations.length,
    reserved_covers: reservedCovers,
  };

  // …but a DISABLED panel ships no rows/PII — the flag is a data-scoping control,
  // not just a client-side hide (a manager turning off "reservations" should stop
  // guest phone numbers leaving the server, capacity still works from the summary).
  return {
    date,
    panels,
    entertainment: panels.entertainment ? entertainment : [],
    parties: panels.parties ? parties : [],
    reservations: panels.reservations ? reservations : [],
    specials: panels.specials ? specials : '',
    capacity: panels.capacity ? capacity : null,
    party_sync: { source: partySource, fetched_at: partyFetchedAt },
    party_status: partyStatus,
    summary,
  };
}
