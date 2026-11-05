/**
 * THE WASTE HANDOVER LOG'S WORDS — Hyderabad audit checklist line #114,
 * "Waste disposal record".
 *
 * PURE CONSTANTS, NO IMPORTS. This file is read by the route (server) AND by the
 * page (a client component), so it must never pull in the database, crypto or
 * the session. Anything that needs those lives in ./lib.ts.
 *
 * It sits in this lane's own underscore folder (never routed by the App Router)
 * rather than in src/lib/fssai.ts, because fssai.ts is shared by every FSSAI lane
 * and these words belong to one register.
 */

/** Who took the waste away. GHMC first: it is who collects from most kitchens in Hyderabad. */
export const WASTE_COLLECTOR_KINDS: readonly { key: string; label: string; hint: string }[] = [
  { key: 'ghmc',   label: 'GHMC',             hint: 'The municipal collection vehicle or its sanitation worker' },
  { key: 'agency', label: 'Authorised agency', hint: 'A registered waste collector or recycler under contract' },
  { key: 'other',  label: 'Other',            hint: 'Anyone else — say who in the name' },
] as const;

export function isWasteCollectorKind(v: unknown): boolean {
  return WASTE_COLLECTOR_KINDS.some((k) => k.key === String(v ?? ''));
}

export function wasteCollectorLabel(v: unknown): string {
  return WASTE_COLLECTOR_KINDS.find((k) => k.key === String(v ?? ''))?.label || String(v ?? '');
}

/**
 * ONE unit for the whole row, as the collector's receipt states it. A GHMC
 * worker counts bins or bags; an agency weighs. Mixing units inside one handover
 * would make the printed register's columns unaddable, so the row carries one.
 */
export const WASTE_QTY_UOMS: readonly { key: string; label: string }[] = [
  { key: 'kg',   label: 'kg' },
  { key: 'bags', label: 'bags' },
  { key: 'bins', label: 'bins' },
] as const;

export function isWasteUom(v: unknown): boolean {
  return WASTE_QTY_UOMS.some((u) => u.key === String(v ?? ''));
}

/** The three streams, in the order the printed register reads them. */
export const WASTE_STREAMS: readonly { key: 'wet' | 'dry' | 'other'; label: string; column: 'wet_qty' | 'dry_qty' | 'other_qty' }[] = [
  { key: 'wet',   label: 'Wet',   column: 'wet_qty' },
  { key: 'dry',   label: 'Dry',   column: 'dry_qty' },
  { key: 'other', label: 'Other', column: 'other_qty' },
] as const;

/**
 * HOW OFTEN WASTE IS EXPECTED TO LEAVE — PROVISIONAL, FOR THE OWNER TO CONFIRM.
 *
 * GHMC collects from a commercial kitchen every day, and wet waste kept a second
 * night is the overflowing-bin finding the same authority's Checklist 3 asks
 * about. So:
 *   fresh — the last handover is at most this many days old → PRESENT
 *   stale — older than fresh, at most this many days       → EXPIRING
 *   older, or none at all                                   → MISSING
 * Age 0 = today, 1 = yesterday (business dates, IST). Same shape as the audit
 * file's CADENCE table, so that lane can adopt it without translation.
 */
export const WASTE_HANDOVER_CADENCE = { fresh: 2, stale: 7, words: 'at every collection (GHMC collects daily)' } as const;

/**
 * THE DOUBLE-TAP WINDOW. At the back door the network drops and the button gets
 * pressed twice. A second handover from the same person, for the same date,
 * time, collector and quantities inside this many minutes is refused as the
 * same handover, with the number of the one already saved.
 */
export const WASTE_DUPLICATE_WINDOW_MIN = 10;

/** How many photographs (receipt, the bins at the door) one handover may carry. */
export const WASTE_MAX_PHOTOS = 4;

/**
 * How many may travel in ONE request. Production's nginx refuses a body over
 * 1 MB (HARD RULE 14); a photograph is ~165–250 KB after ImageUpload shrinks it
 * and a third more as base64, so two per request stays under the ceiling with
 * room for the form. A third and fourth are added afterwards, one at a time.
 */
export const WASTE_PHOTOS_PER_REQUEST = 2;

/** A handover can be printed with this many blank lines below it, for a paper fallback. */
export const WASTE_PRINT_BLANK_ROW_CHOICES = [0, 10, 20] as const;

/** 'WST-2026-0001' prefix. */
export const WASTE_HANDOVER_PREFIX = 'WST';
