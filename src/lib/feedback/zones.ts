/**
 * Guest Feedback — WHOSE FLOOR IS THIS?  (P5 Lane C)
 *
 * SELECT-ONLY, like every other file under `src/lib/feedback/`.
 *
 * ── THE OWNER'S RULING THIS FILE EXISTS FOR ─────────────────────────────────
 * He asked *"A Floor assigned GRE should take the feedback right?"* and chose:
 *
 *     THE FLOOR IS A DEFAULT, NOT A RESTRICTION.
 *       · Page 1 OPENS on the GRE's own floor, and they can still switch.
 *       · COVERAGE IS MEASURED AGAINST THEIR FLOOR, not the whole restaurant.
 *       · NOBODY IS EVER BLOCKED from helping on another floor.
 *
 * That third line is why nothing in this file returns a WHERE fragment and why
 * no caller of it filters a board. It answers one question — "which tables were
 * this person's to visit" — and it is used for DENOMINATORS and for a default
 * selection. A GRE who walks onto another floor and records feedback there is
 * doing the restaurant a favour; the code must never make that disappear, and
 * `offArea` below is where it is counted instead.
 *
 * ── WHY IT IS NOT `captain-area.ts` ─────────────────────────────────────────
 * `captainAreaFilter()` already reads exactly these two columns and already
 * buckets `'Floor'` the way `floorLabel()` does. It is NOT reused, and not
 * modified, for one measured reason: **it is gated on the `captain_area_lock`
 * setting, which has ZERO rows in this database, so it returns `null` for
 * everybody.** Switching that lock on to make this module work would start
 * restricting CAPTAINS mid-service — a completely different population and not
 * what was asked. So this file reads the same columns directly and applies the
 * same conventions, and `captain-area.ts` is left untouched.
 *
 * ── THE CONVENTIONS, COPIED DELIBERATELY ────────────────────────────────────
 * From `captain-area.ts:8-13`, whose own comment is the owner's choice already
 * written down:
 *   · **No assignment = everything.** "unassigned = all, so nobody is locked
 *     out". An unassigned GRE is measured against the whole venue, exactly as
 *     before this file existed.
 *   · **Management runs the whole floor** — in practice, not by a tier test.
 *     ⚠️ Read this carefully, because the obvious reading is wrong: nothing
 *     below looks at a tier. The area is whatever the PERSON's own
 *     `preferred_zones` says, whoever they are, and management users carry no
 *     assignment (measured on this database: ZERO users of any tier hold
 *     `preferred_zones`), so they come back unassigned and are measured against
 *     everything. A tier test was deliberately NOT added: if the owner does
 *     assign a Floor Manager to the Terrace, measuring their own coverage
 *     against the Terrace is the honest answer, not a bug. What management
 *     never gets is a RESTRICTION — and nothing here restricts anybody, which
 *     is the point of the whole file.
 *   · **`'Floor'` matches the unzoned table.** An empty `restaurant_tables.zone`
 *     renders as the literal "Floor" in the captain UI (`captain-area.ts:29`,
 *     `floorLabel()`), so an assignment of "Floor" covers those tables.
 * A malformed `preferred_zones` (not JSON, or JSON that is not an array of
 * strings) is treated as NO assignment — over-measure, never under-measure: the
 * failure mode is "measured against the whole venue", which is the behaviour
 * that shipped before, never "measured against nothing", which would print a
 * fake 100 %.
 */

import type Database from 'better-sqlite3';
import { floorLabel } from './read';

/** One person's assignment. `assigned` false means "no restriction at all". */
export interface GreArea {
  /** Floor labels, already bucketed through `floorLabel()`. */
  zones: string[];
  /** `users.preferred_table_ids` — finer than a floor, and additive to it. */
  tableIds: string[];
  /** False ⇒ nothing was assigned (or it was unreadable) ⇒ measure against all. */
  assigned: boolean;
}

export const AREA_UNASSIGNED: GreArea = { zones: [], tableIds: [], assigned: false };

export const AREA_UNASSIGNED_NOTE =
  'No floor is assigned to this person, so their coverage is measured against every eligible '
  + 'table in scope - the same denominator the module used before floor assignment existed. '
  + 'Set Preferred zones on the user in Settings to measure them against their own floor.';

export const AREA_ASSIGNED_NOTE =
  'Coverage is measured against the eligible tables on this person\'s own floor. Visits they made '
  + 'on any other floor are still counted as work (see "off-floor"), and nobody is ever blocked '
  + 'from helping elsewhere - the floor is a default, not a restriction.';

/** JSON array of strings, defensively. Anything else is "not assigned". */
function parseList(raw: unknown): string[] {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x ?? '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Build an area from the two raw columns. Pure — no database, so the P6
 * evidence can drive it with literals.
 */
export function greAreaOf(preferredZones: unknown, preferredTableIds: unknown): GreArea {
  const zones = Array.from(new Set(parseList(preferredZones).map((z) => floorLabel(z))));
  const tableIds = Array.from(new Set(parseList(preferredTableIds)));
  return { zones, tableIds, assigned: zones.length > 0 || tableIds.length > 0 };
}

/**
 * Is this table one of theirs? A table matches when its FLOOR is assigned or
 * when the table itself is. `floorLabel()` has already bucketed `''` to
 * 'Floor', on both sides, so an assignment of "Floor" covers unzoned tables.
 */
export function areaCovers(area: GreArea, floor: string, tableId: string): boolean {
  if (!area.assigned) return true;                       // unassigned = all
  if (area.tableIds.includes(tableId)) return true;
  return area.zones.includes(floorLabel(floor));
}

/**
 * Areas for a set of user ids, in ONE query. A missing id, a blank id, an
 * unreadable table and a user who holds no assignment ALL come back as
 * `AREA_UNASSIGNED`, i.e. "measured against everything" — the behaviour that
 * shipped before this file existed. There is no tier test here; see the header.
 */
export function readGreAreas(db: Database.Database, userIds: string[]): Map<string, GreArea> {
  const out = new Map<string, GreArea>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return out;
  try {
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const rows = db
        .prepare(
          `SELECT id, preferred_zones, preferred_table_ids
             FROM users WHERE id IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as any[];
      for (const r of rows) {
        out.set(String(r.id), greAreaOf(r.preferred_zones, r.preferred_table_ids));
      }
    }
  } catch {
    /* unreadable → everyone unassigned → venue-wide denominators, as before */
  }
  return out;
}

/** The area for ONE user id, or the unassigned area. */
export function readGreArea(db: Database.Database, userId: string | null | undefined): GreArea {
  if (!userId) return AREA_UNASSIGNED;
  return readGreAreas(db, [userId]).get(String(userId)) ?? AREA_UNASSIGNED;
}

/** A sentence naming the floors, for the screen and for every export. */
export function areaLabel(area: GreArea): string {
  if (!area.assigned) return 'All floors (no assignment)';
  const z = area.zones.join(' · ');
  const t = area.tableIds.length ? `${area.tableIds.length} named table${area.tableIds.length === 1 ? '' : 's'}` : '';
  return [z, t].filter(Boolean).join(' + ') || 'All floors (no assignment)';
}
