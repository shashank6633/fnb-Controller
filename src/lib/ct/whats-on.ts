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
  area: string;
  package: string;
  time: string;
  status: string;
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

/** Read the cached AKAN party feed from `settings` — never live-fetches. */
function readPartyCache(db: Database.Database, date: string): UpcomingParty[] {
  try {
    const row = db
      .prepare(`SELECT value FROM settings WHERE key = 'upcoming_parties_cache'`)
      .get() as { value: string } | undefined;
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    const list: UpcomingParty[] = Array.isArray(parsed?.parties) ? parsed.parties : [];
    return list.filter((p) => p && p.date_of_event === date);
  } catch {
    return [];
  }
}

function isCancelled(status: string | undefined): boolean {
  return (status || '').trim().toLowerCase() === 'cancelled';
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

  // ── Parties (cached AKAN feed) ───────────────────────────────────────────
  let cachedParties: UpcomingParty[] = [];
  try {
    cachedParties = readPartyCache(db, date);
  } catch {
    cachedParties = [];
  }
  // A cancelled function is not "on" — drop it everywhere (list, count, pax,
  // entertainment) so the at-a-glance count and pax figure never disagree.
  cachedParties = cachedParties.filter((p) => !isCancelled(p.status));

  const parties: WhatsOnParty[] = cachedParties.map((p) => ({
    fp_id: p.fp_id,
    name: (p.guest_name || p.company || p.fp_id || '').trim(),
    guest_name: (p.guest_name || '').trim(),
    phone: (p.phone || '').trim(),
    pax: typeof p.pax_expected === 'number' ? p.pax_expected : 0,
    area: (p.allocated_area || '').trim(),
    package: (p.package_type || '').trim(),
    time: (p.time_of_event || '').trim(),
    status: (p.status || '').trim(),
  }));

  // Party rows that carry entertainment → fold into the entertainment panel.
  try {
    for (const p of cachedParties) {
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

  const partyPax = cachedParties
    .filter((p) => !isCancelled(p.status))
    .reduce((sum, p) => sum + (typeof p.pax_expected === 'number' ? p.pax_expected : 0), 0);

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
    parties_count: parties.length,
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
    summary,
  };
}
