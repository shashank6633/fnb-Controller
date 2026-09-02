import type Database from 'better-sqlite3';
import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { resolveStationDepartment } from '@/lib/dept-ledger';
import {
  STATION_CONVENTION, normStationKey, validateStationName,
  findStationRow, stationUsage, stationInUseBy, stationKdsSection,
  deactivateWarning, insertStation, applyStationRename, nearDuplicateStation,
} from '@/lib/station-master';

/**
 * THE STATION MASTER — and the station → department map it doubles as.
 *
 *   GET   /api/settings/station-departments  → every station that EXISTS IN DATA,
 *                                              mapped or not, with what the
 *                                              mapping is worth.        (signed in)
 *   PUT   /api/settings/station-departments  → set or clear ONE mapping.   (admin)
 *   PATCH /api/settings/station-departments  → { action: 'add' | 'rename' } (admin)
 *                                            → { action: 'impact' }     (signed in)
 *
 * ── WHY PATCH AND NOT POST ─────────────────────────────────────────────────
 * POST is already an ALIAS FOR PUT (see the bottom of this file) because the
 * settings pages POST as often as they PUT, and taking that away would make a
 * mapping save silently persist nothing. So the master operations arrived on
 * PATCH with an `action` discriminator rather than by re-pointing POST. PUT and
 * POST are byte-identical to what they were: the department-assignment contract
 * — set / clear / switch off, with is_active preserved when not sent — is
 * untouched by any of this.
 *
 * ── WHY THIS ENDPOINT EXISTS AT ALL ────────────────────────────────────────
 * Recipe consumption now leaves the DEPARTMENT, not central. To debit a
 * department the consumption path has to answer "which kitchen cooked this?",
 * and the only field that can answer it per sold line is order_items.station —
 * free text, 12 live values. `departments` has 19 rows whose names do NOT
 * string-match those values ('Akan  Indian' carries TWO spaces, 'Akan Tandoori'
 * vs station 'tandoor', 'Akan - Bakery' is hyphenated). So the map is owner
 * -configurable data, seeded one-shot from exact UUIDs in db.ts, and this route
 * is how it is read and edited.
 *
 * ── THE RULE A FUTURE ENGINEER WILL WANT TO "SIMPLIFY" ─────────────────────
 * An UNMAPPED station must SKIP the deduction. It must never fall back to a
 * parent department, never fall back to "Kitchen", and never fall back to
 * central. Clearing a mapping here is a supported action that MEANS "stop
 * deducting for this station" — it is not a broken state to be repaired with a
 * default. Debiting the wrong kitchen silently reads as theft on the very
 * variance report this rail exists to produce; a skip reads as a gap, is
 * counted in consumption_skips, and is named on screen. Not deducting is
 * recoverable. Accusing the wrong chef is not.
 *
 * ── NO CACHE, ON PURPOSE ───────────────────────────────────────────────────
 * Nothing memoises this table. resolveStationDepartment() in dept-ledger.ts hits
 * the DB on every consumption, so an edit here is live on the very next sale
 * with no restart and no invalidation step to forget. Do not add a module-level
 * Map "for performance": the lookup is a single indexed read on a 13-row table,
 * and a stale cache here silently debits the kitchen the owner just unmapped.
 *
 * ── ONE RESOLVER ───────────────────────────────────────────────────────────
 * The `effective` state below is produced by calling resolveStationDepartment()
 * — the SAME function the consumption path calls — rather than by re-deriving
 * it from the row in this file's own SQL. A second copy of that logic is how
 * Settings ends up showing "mapped" for a station that skips in production.
 */

/* ── local, defensive schema probes ─────────────────────────────────────────
 * This route reads five tables, three of which (station_departments,
 * consumption_skips, and the order/kot station columns) arrived with the
 * department-inventory cutover. A Settings page that 500s because a migration
 * has not run yet is worse than one that renders with a column missing, so the
 * union below is assembled only from what actually exists. */
function tableExists(db: Database.Database, name: string): boolean {
  try {
    return !!db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`,
    ).get(name);
  } catch { return false; }
}

function columnExists(db: Database.Database, table: string, col: string): boolean {
  try {
    if (!tableExists(db, table)) return false;
    return (db.prepare(`PRAGMA table_info(${table})`).all() as any[])
      .some((c: any) => String(c.name) === col);
  } catch { return false; }
}

/** The house normalisation. Must match resolveStationDepartment() exactly. */
const normStation = (s: unknown) => String(s ?? '').trim().toLowerCase();

/**
 * Stations this route refuses to MAP without an explicit override.
 *
 * 'kitchen' is not a station — it is kot-fire.ts's BLANK-STATION SENTINEL: a
 * line that carries no station at all is written out as the literal string
 * 'kitchen'. 'Kitchen' also happens to be a real department (the main-kitchen
 * roll-up, 4,335 issued lines and the busiest receiver in the building). Map
 * the two together and every station-less item sold anywhere in the venue
 * quietly debits that one department — the exact silent-wrong-kitchen outcome
 * the skip rule above exists to prevent, arrived at by an admin picking a
 * plausible-looking name out of a dropdown.
 *
 * The fix for a station-less item is to give the MENU ITEM a real station, not
 * to map the sentinel. `force: true` is left as a deliberate escape hatch so
 * this is the owner's call and not the code's — but it costs a second, informed
 * click, which is the whole point.
 */
const SENTINEL_STATIONS = new Map<string, string>([
  ['kitchen',
    "'kitchen' is the blank-station sentinel, not a real station — a sold line with no station of its own is recorded as 'kitchen'. " +
    'Mapping it would debit that one department for every station-less item in the building. ' +
    'Give those menu items a real station instead. Re-send with force:true if you are certain.'],
]);

/**
 * Stations that belong to a DIFFERENT rail. Allowed, but answered with a
 * warning rather than silence.
 *
 * Liquor is store-mapped: it lives on the TGBCL store ledger
 * (store_stock_ledger / store_locations), and store-mapped materials are
 * skipped by BOTH the central debit and the department credit. Measured today:
 * 210 live liquor-station menu items, ZERO of them recipe-linked — so a liquor
 * mapping moves nothing at all. It is not blocked (the carve-out that actually
 * protects the liquor rail is at the MATERIAL level, where it belongs, not on a
 * station name), but the owner should not think he has switched something on.
 */
const OTHER_RAIL_STATIONS = new Map<string, string>([
  ['liquor',
    'Liquor is store-mapped and lives on the TGBCL store ledger, not the department raw-material rail. ' +
    'Store-mapped materials are skipped by the department ledger regardless of this mapping, so it will not deduct anything.'],
]);

type StationRow = {
  station: string;
  department_id: string | null;
  department_name: string | null;
  is_active: boolean;
  note: string;
  updated_at: string | null;
  /** Never a guess. Mirrors resolveStationDepartment() one-for-one. */
  effective: 'mapped' | 'unmapped' | 'inactive';
  /** Set when the row points at a department row that no longer exists. */
  dangling: boolean;
  /** True when nothing has ever been written for this station. */
  configured: boolean;
  /** WHAT THE MAPPING IS WORTH — see the GET comment. */
  menu_items: number;
  live_menu_items: number;
  live_recipe_items: number;
  sold_lines_30d: number;
  deducted_lines_30d: number;
  skips_30d: number;
  skip_qty_30d: number;
  /** Where the station was seen, so a stale mapping is distinguishable. */
  in_menu: boolean;
  in_orders: boolean;
  in_kots: boolean;
};

/** GROUP BY lower(trim(station)) → Map<station, number>, tolerant of absence. */
function groupCount(db: Database.Database, sql: string, params: any[] = []): Map<string, number> {
  const m = new Map<string, number>();
  try {
    for (const r of db.prepare(sql).all(...params) as any[]) {
      m.set(normStation(r.station), Number(r.n) || 0);
    }
  } catch (e) {
    console.error('[/api/settings/station-departments] count query failed (reporting 0):', e);
  }
  return m;
}

export async function GET(request: Request) {
  try {
    // READ is open to any signed-in user, matching the settings/route.ts
    // precedent: which kitchen a station belongs to is not a secret, only the
    // power to change it is. The proxy only checks that a session cookie is
    // PRESENT, so this call is the real authentication.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const db = getDb();
    const hasMap = tableExists(db, 'station_departments');

    /* ── ?list=1 — WHAT A PICKER NEEDS, AND NOTHING ELSE ───────────────────
     * The menu-item form builds its Station dropdown from this master (there is
     * deliberately no second station table — see station-master.ts). But
     * /menu-items is a hot staff page and the full answer below is a SETTINGS
     * DASHBOARD: eight aggregate scans over order_items, kots and
     * consumption_skips to price what each mapping is worth. A dropdown needs
     * none of it, and making every price edit pay for it is how a page gets
     * slow for a reason nobody can find later. So: one read of the master, no
     * aggregates.
     *
     * TWO DELIBERATE DIFFERENCES FROM THE FULL ANSWER, both load-bearing:
     *
     *  1. THIS IS THE MASTER ALONE — no union with stations found in data. The
     *     full GET unions menu_items/order_items/kots on purpose, so an
     *     unmapped station is VISIBLE as unmapped rather than absent. For a
     *     picker that union would be exactly wrong: it would re-offer any
     *     stray value already sitting in the data (a CSV import's "Pan Asian",
     *     a typo saved once) as a legitimate choice, which is the
     *     self-fulfilling list the dropdown exists to end. An item on such a
     *     value is not stranded — the form shows the item its OWN value, marked.
     *  2. NO `effective` / resolveStationDepartment() call. Whether a station
     *     currently maps to a department is a STOCK question; it has nothing to
     *     do with whether the station may be cooked at, and answering it here
     *     would invite a future edit to hide unmapped stations from the picker.
     *     'liquor' (293 items) and 'sushi' are deliberately unmapped and must
     *     stay pickable.
     *
     * `is_active` IS returned, so the picker can MARK a paused station rather
     * than hide it: pausing means "stop deducting stock", not "stop cooking
     * here" (deactivateWarning() promises the owner in as many words that KOTs
     * still print and still reach the section). Hiding paused rows would make
     * that promise false and quietly overload one flag with two meanings. */
    if (new URL(request.url).searchParams.get('list') === '1') {
      const rows = hasMap
        ? (db.prepare(
            `SELECT station, COALESCE(is_active, 1) AS is_active
               FROM station_departments
              WHERE trim(COALESCE(station,'')) <> ''
              ORDER BY lower(trim(station))`,
          ).all() as Array<{ station: unknown; is_active: unknown }>)
        : [];
      return Response.json({
        mode: 'list',
        // The STORED string, not the normalised key: it is what a save will
        // write into menu_items.station, and the house spelling is the one the
        // master row carries.
        stations: rows.map((r) => ({
          station: String(r.station),
          is_active: Number(r.is_active) === 1,
        })),
        // Same shape as the full answer, so the page keys its copy off the
        // server's list instead of hard-coding 'kitchen' a third time.
        reserved: {
          sentinel: [...SENTINEL_STATIONS.keys()],
          other_rail: [...OTHER_RAIL_STATIONS.keys()],
        },
        can_edit: me.role === 'admin',
        schema_ready: hasMap,
      });
    }

    const hasSkips = tableExists(db, 'consumption_skips');
    const hasOrderStation = columnExists(db, 'order_items', 'station');
    const hasKotStation = columnExists(db, 'kots', 'station');

    /* ── THE UNION IS THE POINT ────────────────────────────────────────────
     * Listing station_departments alone would show only stations somebody has
     * already thought about. The owner needs the opposite: every station that
     * EXISTS IN DATA, so one that has never been mapped is VISIBLE as unmapped
     * instead of being absent and looking like it does not exist. The mapping
     * table is unioned in as well, so a mapping left behind by a station that
     * has since disappeared from the menu is still listed and still clearable
     * — otherwise it would keep resolving in production with no way to see it. */
    const parts: string[] = [];
    parts.push(`SELECT lower(trim(station)) AS station FROM menu_items WHERE trim(COALESCE(station,'')) <> ''`);
    if (hasOrderStation) parts.push(`SELECT lower(trim(station)) FROM order_items WHERE trim(COALESCE(station,'')) <> ''`);
    if (hasKotStation) parts.push(`SELECT lower(trim(station)) FROM kots WHERE trim(COALESCE(station,'')) <> ''`);
    if (hasMap) parts.push(`SELECT lower(trim(station)) FROM station_departments WHERE trim(COALESCE(station,'')) <> ''`);
    const stationKeys = (db.prepare(
      `${parts.join(' UNION ')} ORDER BY 1`,
    ).all() as any[]).map((r) => normStation(r.station)).filter(Boolean);

    // Rows already written for a station (LEFT JOIN in spirit — the union above
    // supplies the left side, this supplies the right).
    const mapRows = new Map<string, any>();
    if (hasMap) {
      for (const r of db.prepare(`
        SELECT sd.station, sd.department_id, sd.is_active, sd.note, sd.updated_at,
               d.name AS department_name,
               (SELECT COUNT(*) FROM departments dx WHERE dx.id = sd.department_id) AS dept_exists
          FROM station_departments sd
          LEFT JOIN departments d ON d.id = sd.department_id
      `).all() as any[]) mapRows.set(normStation(r.station), r);
    }

    /* WHAT EACH MAPPING IS WORTH.
     * live_recipe_items is the number that matters: recipe consumption fires
     * ONLY for a sold line whose menu item carries an ACTIVE recipe, so a
     * station with 0 of them will move no department stock however it is
     * mapped. Measured today: 18 recipe-linked items across the whole 628-item
     * menu, all of them in continental/tandoor/pan-asian/indian/sushi/
     * terracegrill. That is a DATA gap, not a bug — the screen must show the
     * owner the gap rather than let him believe a mapping switched something on. */
    const menuAll = groupCount(db, `
      SELECT lower(trim(station)) AS station, COUNT(*) AS n FROM menu_items
       WHERE trim(COALESCE(station,'')) <> '' GROUP BY 1`);
    const menuLive = groupCount(db, `
      SELECT lower(trim(station)) AS station, COUNT(*) AS n FROM menu_items
       WHERE trim(COALESCE(station,'')) <> '' AND is_active = 1 GROUP BY 1`);
    const recipeLive = groupCount(db, `
      SELECT lower(trim(mi.station)) AS station, COUNT(*) AS n
        FROM menu_items mi
        JOIN recipes r ON r.id = mi.recipe_id
       WHERE trim(COALESCE(mi.station,'')) <> ''
         AND mi.is_active = 1 AND COALESCE(r.is_active, 1) = 1
       GROUP BY 1`);

    // 30-day traffic. recipe_deducted_at is stamped by the consumption path, so
    // sold-vs-deducted is the honest before/after of a mapping: a station with
    // traffic and no deducts is either unmapped or has no recipes.
    const sold30 = hasOrderStation ? groupCount(db, `
      SELECT lower(trim(station)) AS station, COUNT(*) AS n FROM order_items
       WHERE trim(COALESCE(station,'')) <> '' AND created_at >= datetime('now','-30 days')
       GROUP BY 1`) : new Map<string, number>();
    const deducted30 = (hasOrderStation && columnExists(db, 'order_items', 'recipe_deducted_at'))
      ? groupCount(db, `
        SELECT lower(trim(station)) AS station, COUNT(*) AS n FROM order_items
         WHERE trim(COALESCE(station,'')) <> '' AND created_at >= datetime('now','-30 days')
           AND recipe_deducted_at IS NOT NULL
         GROUP BY 1`)
      : new Map<string, number>();

    /* consumption_skips.date is an IST calendar day ('+330 minutes' — the house
     * convention), NOT a UTC timestamp, so the window is built the same way.
     * -29 days inclusive of today = 30 calendar days. */
    const skips30 = hasSkips ? groupCount(db, `
      SELECT lower(trim(station)) AS station, COUNT(*) AS n FROM consumption_skips
       WHERE date >= date('now','+330 minutes','-29 days') GROUP BY 1`) : new Map<string, number>();
    const skipQty30 = hasSkips ? groupCount(db, `
      SELECT lower(trim(station)) AS station, ROUND(SUM(COALESCE(quantity,0)), 3) AS n
        FROM consumption_skips
       WHERE date >= date('now','+330 minutes','-29 days') GROUP BY 1`) : new Map<string, number>();

    const inMenu = new Set(menuAll.keys());
    const inOrders = hasOrderStation
      ? new Set(groupCount(db, `SELECT lower(trim(station)) AS station, COUNT(*) AS n FROM order_items
           WHERE trim(COALESCE(station,'')) <> '' GROUP BY 1`).keys())
      : new Set<string>();
    const inKots = hasKotStation
      ? new Set(groupCount(db, `SELECT lower(trim(station)) AS station, COUNT(*) AS n FROM kots
           WHERE trim(COALESCE(station,'')) <> '' GROUP BY 1`).keys())
      : new Set<string>();

    const stations: StationRow[] = stationKeys.map((station) => {
      const row = mapRows.get(station);
      // ONE resolver — see the header. This is the same call the consumption
      // path makes, so the screen cannot disagree with production.
      const res = resolveStationDepartment(db, station);
      const dangling = !!(row?.department_id) && !Number(row?.dept_exists ?? 0);
      return {
        station,
        department_id: row?.department_id ?? null,
        department_name: row?.department_name ?? null,
        is_active: row ? Number(row.is_active ?? 1) === 1 : true,
        note: String(row?.note ?? ''),
        updated_at: row?.updated_at ?? null,
        effective: res.departmentId ? 'mapped' : (res.reason === 'inactive' ? 'inactive' : 'unmapped'),
        dangling,
        configured: !!row,
        menu_items: menuAll.get(station) ?? 0,
        live_menu_items: menuLive.get(station) ?? 0,
        live_recipe_items: recipeLive.get(station) ?? 0,
        sold_lines_30d: sold30.get(station) ?? 0,
        deducted_lines_30d: deducted30.get(station) ?? 0,
        skips_30d: skips30.get(station) ?? 0,
        skip_qty_30d: skipQty30.get(station) ?? 0,
        in_menu: inMenu.has(station),
        in_orders: inOrders.has(station),
        in_kots: inKots.has(station),
      };
    });

    // Departments to choose from. Inactive ones are INCLUDED but flagged: an
    // existing mapping may point at one, and hiding it would make that row
    // un-editable. resolveStationDepartment() checks existence, not is_active,
    // so an inactive department still receives stock — the flag is how the
    // screen can say so.
    const departments = (db.prepare(
      `SELECT id, name, COALESCE(is_active,1) AS is_active FROM departments ORDER BY name`,
    ).all() as any[]).map((d) => ({
      id: String(d.id), name: String(d.name), is_active: Number(d.is_active) === 1,
    }));

    /* The banner number. A station that is unmapped AND carries live
     * recipe-linked items is the only combination that silently loses a
     * deduction — everything else moves nothing either way. Naming those
     * stations is the difference between "the report is honest about a gap" and
     * "the report implies theft". */
    const needsAttention = stations
      .filter((s) => s.effective !== 'mapped' && (s.live_recipe_items > 0 || s.skips_30d > 0))
      .map((s) => s.station);

    return Response.json({
      stations,
      departments,
      summary: {
        total: stations.length,
        mapped: stations.filter((s) => s.effective === 'mapped').length,
        unmapped: stations.filter((s) => s.effective === 'unmapped').length,
        inactive: stations.filter((s) => s.effective === 'inactive').length,
        dangling: stations.filter((s) => s.dangling).length,
        skips_30d: stations.reduce((a, s) => a + s.skips_30d, 0),
        needs_attention: needsAttention,
      },
      // Surfaced so the page can label the reserved stations without hard-coding
      // the same list a second time.
      reserved: {
        sentinel: [...SENTINEL_STATIONS.keys()],
        other_rail: [...OTHER_RAIL_STATIONS.keys()],
      },
      can_edit: me.role === 'admin',
      schema_ready: hasMap,
    });
  } catch (e: any) {
    console.error('GET /api/settings/station-departments failed:', e);
    return Response.json(
      { error: e?.message || 'Failed to load the station → department map' },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  try {
    /* ADMIN ONLY, and deliberately stricter than the generic settings writer,
     * which floors at manager. This map decides WHICH kitchen's books a gram
     * leaves. It re-bases department variance, and a wrong mapping does not
     * announce itself — it shows up weeks later as an unexplained difference
     * against a chef. Same reasoning that made requisition_deduct_at_issue
     * admin-write in settings/route.ts: not a secret, but the flip is
     * privileged. Managers keep READ so they can see the map, not change it. */
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin') {
      return Response.json(
        { error: 'Admin role required to change the station → department map' },
        { status: 403 },
      );
    }

    const body = await req.json().catch(() => ({} as any));
    const station = normStation(body?.station);
    if (!station) return Response.json({ error: 'station required' }, { status: 400 });

    const db = getDb();
    if (!tableExists(db, 'station_departments')) {
      return Response.json(
        { error: 'The station → department map has not been created yet — restart the app so the migration runs' },
        { status: 503 },
      );
    }

    /* Only stations that EXIST somewhere may be written. Without this, a typo
     * ('tandor') writes a dead row that looks like a real mapping in Settings,
     * resolves for nothing, and hides the fact that the real station is still
     * unmapped. A genuinely new station appears here the moment a menu item
     * carries it, so this blocks typos and nothing else. */
    const known = new Set<string>();
    for (const r of db.prepare(`
      SELECT lower(trim(station)) AS station FROM menu_items WHERE trim(COALESCE(station,'')) <> ''
      UNION SELECT lower(trim(station)) FROM station_departments WHERE trim(COALESCE(station,'')) <> ''
      ${columnExists(db, 'order_items', 'station')
        ? `UNION SELECT lower(trim(station)) FROM order_items WHERE trim(COALESCE(station,'')) <> ''` : ''}
      ${columnExists(db, 'kots', 'station')
        ? `UNION SELECT lower(trim(station)) FROM kots WHERE trim(COALESCE(station,'')) <> ''` : ''}
    `).all() as any[]) known.add(normStation(r.station));
    if (!known.has(station)) {
      return Response.json(
        { error: `'${station}' is not a station any menu item, order line or KOT uses — check the spelling` },
        { status: 400 },
      );
    }

    // '' / null / undefined all mean CLEAR. Clearing is a supported action, not
    // a failure: it means "stop deducting for this station". See the header —
    // there is no fallback department, by design.
    const rawDept = body?.department_id;
    const departmentId = rawDept === null || rawDept === undefined || String(rawDept).trim() === ''
      ? null
      : String(rawDept).trim();

    const warnings: string[] = [];

    if (departmentId) {
      const dept = db.prepare(
        `SELECT id, name, COALESCE(is_active,1) AS is_active FROM departments WHERE id = ?`,
      ).get(departmentId) as any;
      // A dangling pointer is refused rather than stored: resolveStationDepartment()
      // treats it as unmapped, so storing it would show "mapped" in Settings
      // while production silently skips — the worst of both readings.
      if (!dept) {
        return Response.json({ error: 'That department does not exist' }, { status: 400 });
      }
      // Allowed, but said out loud: the resolver checks EXISTENCE, not is_active,
      // so a deactivated department still receives stock.
      if (!Number(dept.is_active)) {
        warnings.push(
          `'${dept.name}' is deactivated, but it will still receive stock — the mapping resolves on existence, not on the active flag.`,
        );
      }
      const sentinel = SENTINEL_STATIONS.get(station);
      if (sentinel && body?.force !== true) {
        return Response.json({ error: sentinel, code: 'SENTINEL_STATION', station }, { status: 409 });
      }
      if (sentinel) warnings.push(sentinel);
      const otherRail = OTHER_RAIL_STATIONS.get(station);
      if (otherRail) warnings.push(otherRail);
    }

    // is_active is a SEPARATE axis from the mapping and is preserved when not
    // sent: "switched off" (keep the department, stop deducting) and "cleared"
    // (forget the department) are different owner intentions and different
    // resolver reasons ('inactive' vs 'unmapped'), so the audit can tell them
    // apart later. Do not collapse them.
    const prev = db.prepare(
      `SELECT station, department_id, is_active, note FROM station_departments WHERE lower(trim(station)) = ?`,
    ).get(station) as any;
    const isActive = body?.is_active === undefined || body?.is_active === null
      ? (prev ? Number(prev.is_active ?? 1) : 1)
      : (body.is_active ? 1 : 0);
    const note = body?.note === undefined || body?.note === null
      ? String(prev?.note ?? '')
      : String(body.note).slice(0, 500);

    /* Clearing UPDATEs department_id to NULL — it does NOT delete the row. The
     * seed in db.ts is one-shot (settings.station_dept_seed_v1), so a deleted
     * row would never come back and the station would drop out of "configured"
     * entirely, losing the note and the timestamp that record the decision.
     * Keeping the row is also what makes the acceptance case honest: clear
     * continental, restart, and it is STILL cleared.
     *
     * WRITE BACK TO `prev.station`, NOT to the normalised key. The PRIMARY KEY
     * on station is plain TEXT, so it collates BINARY — 'Continental' and
     * 'continental' are two different keys — while every READER (this route's
     * union, and resolveStationDepartment) matches on lower(trim(station)).
     * Upserting the normalised key against a row stored in any other casing
     * would therefore MISS the conflict target and INSERT a second row for the
     * same station. The readers would then see two rows for one station and
     * resolveStationDepartment's LIMIT 1 would pick between them arbitrarily —
     * a station that deducts from one kitchen or another depending on row
     * order. Nothing writes mixed case today (the seed and this route are the
     * only writers and both normalise), so this is a guard, not a fix; keep it
     * anyway, because the failure it prevents is silent and lands on stock. */
    db.prepare(`
      INSERT INTO station_departments (station, department_id, is_active, note, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(station) DO UPDATE SET
        department_id = excluded.department_id,
        is_active     = excluded.is_active,
        note          = excluded.note,
        updated_at    = datetime('now')
    `).run(prev?.station ?? station, departmentId, isActive, note);

    // Append-only audit. This edit moves stock between books; who changed it,
    // when, and from what must outlive the row it overwrote.
    logAuditEvent(db, {
      event_type: departmentId ? 'station_department.set' : 'station_department.clear',
      entity_type: 'station_department',
      entity_id: station,
      actor_email: me.email || '',
      before: prev
        ? { department_id: prev.department_id ?? null, is_active: Number(prev.is_active ?? 1) }
        : null,
      after: { department_id: departmentId, is_active: isActive },
      note: departmentId
        ? `station '${station}' → department ${departmentId}`
        : `station '${station}' unmapped — recipe consumption for it will be skipped and recorded`,
    });

    /* Read the result back through the SAME resolver production uses, so the
     * response states what will actually happen on the next sale rather than
     * what was written. There is no cache to invalidate — the next consumption
     * re-reads this table. */
    const res = resolveStationDepartment(db, station);
    const deptName = res.departmentId
      ? (db.prepare(`SELECT name FROM departments WHERE id = ?`).get(res.departmentId) as any)?.name ?? null
      : null;

    return Response.json({
      station,
      department_id: res.departmentId,
      department_name: deptName,
      is_active: isActive === 1,
      note,
      effective: res.departmentId ? 'mapped' : (res.reason === 'inactive' ? 'inactive' : 'unmapped'),
      // Said plainly, because "cleared" must never read as an error.
      message: res.departmentId
        ? `Recipe consumption for '${station}' now deducts from ${deptName}.`
        : `'${station}' is not mapped — recipe consumption for it will be skipped and recorded, and no department will be deducted.`,
      warnings,
    });
  } catch (e: any) {
    console.error('PUT /api/settings/station-departments failed:', e);
    return Response.json(
      { error: e?.message || 'Failed to save the station → department mapping' },
      { status: 500 },
    );
  }
}

// POST is an alias for PUT — the upsert is idempotent (station is the PRIMARY
// KEY) and the settings pages in this app POST as often as they PUT. Without
// this a POST 405s and the save appears to succeed while persisting nothing,
// which is exactly the failure /api/settings had to fix.
export const POST = PUT;

/* ═══════════════════════════════════════════════════════════════════════════
 * THE MASTER OPERATIONS — add, rename, and "what would this cost".
 *
 * `station_departments` IS the station master: `station` is its PRIMARY KEY and
 * every station any menu item uses already has a row (measured: 13 rows, zero
 * orphans). NO SECOND TABLE WAS ADDED, and none should be — two masters is how
 * a station ends up pickable in one screen and unroutable in the other.
 *
 * STATION IS NOT CATEGORY. Category is what kind of dish it is on the menu;
 * station is WHICH KITCHEN SECTION COOKS IT, and it drives KOT routing, printer
 * selection, the KDS board split and the department the recipe deducts from. The
 * shape below is borrowed from /api/menu-items/rename-category — the refusal to
 * merge, the one transaction, the audit row — but nothing is imported from it:
 * that file belongs to a different table and a different fleet, and the hard
 * part here has no equivalent there. `menu_items.category` is a plain label;
 * `station_departments.station` is a PRIMARY KEY that is ALSO denormalised into
 * order_items and kots, which are history.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Wording shared by every refusal path, so the screen never invents its own. */
const SENTINEL_RENAME_REFUSAL =
  "'kitchen' cannot be renamed. It is not a station somebody chose — kot-fire.ts writes the literal string " +
  "'kitchen' onto any sold line that carries no station of its own, so new 'kitchen' rows would keep appearing " +
  'the moment this one was renamed away, and the renamed row would map nothing. ' +
  'The fix is to give those menu items a real station.';

export async function PATCH(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const body = await req.json().catch(() => ({} as any));
    const action = String(body?.action ?? '').trim().toLowerCase();

    const db = getDb();
    if (!tableExists(db, 'station_departments')) {
      return Response.json(
        { error: 'The station list has not been created yet — restart the app so the migration runs' },
        { status: 503 },
      );
    }

    /* ── impact: READ-ONLY, and open to the same audience as GET ───────────
     * It answers "what would this cost" and writes nothing, so it takes GET's
     * gate, not PUT's. It exists so the CONFIRMATION TEXT the owner reads is
     * the server's own — the same file that would carry out the change — rather
     * than a second copy of the reasoning living in the page, which is how a
     * screen ends up promising a consequence the server does not deliver. */
    if (action === 'impact') {
      const station = normStationKey(body?.station);
      if (!station) return Response.json({ error: 'station required' }, { status: 400 });
      const row = findStationRow(db, station);
      const usage = stationUsage(db, station);
      const deptName = row?.department_id
        ? (db.prepare(`SELECT name FROM departments WHERE id = ?`).get(row.department_id) as any)?.name ?? null
        : null;
      return Response.json({
        station,
        in_master: !!row,
        department_id: row?.department_id ?? null,
        department_name: deptName,
        is_active: row ? Number(row.is_active) === 1 : true,
        kds_section: stationKdsSection(station),
        usage,
        /* The two sentences the page puts in front of the owner. */
        deactivate_warning: deactivateWarning(usage, deptName),
        rename_note:
          `A rename moves the station list entry, all ${usage.menu_items} menu item${usage.menu_items === 1 ? '' : 's'} on it` +
          (usage.printers ? `, ${usage.printers} printer binding${usage.printers === 1 ? '' : 's'}` : '') +
          (usage.order_lines_live || usage.kots_live
            ? `, and the ${usage.order_lines_live} open line${usage.order_lines_live === 1 ? '' : 's'} / ${usage.kots_live} live ticket${usage.kots_live === 1 ? '' : 's'} that have not been served yet`
            : '') +
          `. History is NOT rewritten: ${usage.order_lines - usage.order_lines_live} closed sold line${usage.order_lines - usage.order_lines_live === 1 ? '' : 's'}, ` +
          `${usage.kots - usage.kots_live} served ticket${usage.kots - usage.kots_live === 1 ? '' : 's'} and ` +
          `${usage.dept_ledger_rows} department stock-ledger row${usage.dept_ledger_rows === 1 ? '' : 's'} keep the label they were recorded under.` +
          /* THE CONSEQUENCE THAT USED TO BE UNSAID. Because history keeps the
           * old name, that name is not free afterwards — renaming back onto it
           * is a second, confirmed decision, not an undo button. Saying it here
           * is the difference between a typo the owner fixes in ten seconds and
           * one he lives with. */
          (usage.order_lines + usage.kots + usage.kot_alerts + usage.consumption_skips + usage.dept_ledger_rows
            ? ` Because of that, '${station}' does not disappear: renaming a station back onto it later asks you to confirm that those old rows should read as the renamed station.`
            : ` Nothing has been recorded against '${station}' yet, so this rename is freely reversible.`),
      });
    }

    /* ADMIN ONLY for anything that writes — same reasoning as PUT's gate. The
     * master decides which section a ticket is cooked by AND which kitchen's
     * books a gram leaves; both are privileged, and neither announces a mistake. */
    if (me.role !== 'admin') {
      return Response.json({ error: 'Admin role required to change the station list' }, { status: 403 });
    }

    /* ── ADD ───────────────────────────────────────────────────────────────
     * A plain INSERT — `station` is the PRIMARY KEY, so a duplicate is refused,
     * and refused CASE-INSENSITIVELY because every reader joins on
     * lower(trim(station)): a second row differing only in case would give
     * resolveStationDepartment's LIMIT 1 two candidates and let one dish deduct
     * from either kitchen depending on row order.
     *
     * The typed name is CANONICALISED, not rejected: "Pan Asian" is stored as
     * "pan-asian" and the answer says so out loud. Rejecting it would send the
     * owner round a guessing loop; storing it as typed would create the twin
     * this check exists to prevent. */
    if (action === 'add') {
      const check = validateStationName(body?.station);
      if (!check.ok) return Response.json({ error: check.error, convention: STATION_CONVENTION }, { status: 400 });
      const canon = check.canon;

      if (SENTINEL_STATIONS.has(canon)) {
        return Response.json({
          error: `'${canon}' is reserved — it is the blank-station sentinel the KOT writer uses for a line with no station of its own, not a section anyone cooks in.`,
          code: 'SENTINEL_STATION', station: canon,
        }, { status: 409 });
      }

      const note = String(body?.note ?? '').slice(0, 500)
        || `Added from Settings by ${me.email || 'an admin'} — not mapped to a department yet.`;

      // Check and INSERT in ONE transaction, and IMMEDIATE so the check is
      // already holding the write lock: db.transaction() begins DEFERRED, so two
      // admins adding the same name both read "no row", and the loser's INSERT
      // then fails the PRIMARY KEY with SQLITE_BUSY_SNAPSHOT — a raw driver
      // message on a 500 instead of the friendly 409, for an outcome that was
      // never in doubt (no twin row is created either way). .immediate() takes
      // the lock at BEGIN so the second caller waits and then reads the truth.
      const run = db.transaction(() => {
        const existing = findStationRow(db, canon);
        if (existing) {
          const u = stationUsage(db, canon);
          const paused = Number(existing.is_active) !== 1;
          return {
            ok: false as const, status: 409, code: undefined as string | undefined,
            error: `'${canon}' is already in the station list${u.menu_items ? ` and ${u.menu_items} menu item${u.menu_items === 1 ? ' uses' : 's use'} it` : ' — no menu item uses it yet'}.`
              // "Pick a different name" is the WRONG instruction for the one case
              // where the admin's real intent is to bring the station back.
              + (paused
                ? ' It is switched OFF (paused), so it is not deducting — switch it back on in the list below rather than adding a second one.'
                : ' Pick a different name.'),
          };
        }

        /* The hyphen twin. Refusing outright would be wrong — two stations CAN
         * legitimately differ by a hyphen — so this is the informed second click
         * the file already uses twice, not a block. Inside the transaction with
         * the duplicate check, because both answer the same question. */
        const near = nearDuplicateStation(db, canon);
        if (near && body?.force !== true) {
          const nu = stationUsage(db, near);
          return {
            ok: false as const, status: 409, code: 'NEAR_DUPLICATE' as string | undefined,
            error: `'${near}' already exists${nu.menu_items ? ` and ${nu.menu_items} menu item${nu.menu_items === 1 ? ' uses' : 's use'} it` : ''}, and '${canon}' differs from it only by hyphens. `
              + 'These would be TWO separate stations: a menu item moved onto the wrong one resolves against the wrong master row, and if that row is unmapped its deduction is skipped in silence. '
              + `Did you mean '${near}'? Re-send with force:true to add '${canon}' as a genuinely separate station.`,
          };
        }
        // A station that exists ON DATA but has no master row is ADOPTED rather
        // than refused: refusing would leave it listed-but-unlisted forever.
        // Measured today there are none, but menu_items.station is free text, so
        // one can appear at any time.
        const before = stationUsage(db, canon);
        insertStation(db, canon, note);
        logAuditEvent(db, {
          event_type: 'station_department.add',
          entity_type: 'station_department',
          entity_id: canon,
          actor_email: me.email || '',
          before: null,
          after: { station: canon, department_id: null, is_active: 1 },
          note: `Station '${canon}' added${check.changed ? ` (typed "${check.typed}")` : ''} — UNMAPPED, so recipe consumption for it is skipped and recorded until a department is picked.`,
        });
        return { ok: true as const, adopted: before.menu_items + before.order_lines + before.kots > 0, usage: before };
      });

      const result = run.immediate();
      if (!result.ok) {
        return Response.json(
          { error: result.error, ...(result.code ? { code: result.code, station: canon } : {}) },
          { status: result.status },
        );
      }

      const warnings: string[] = [];
      if (check.changed) {
        warnings.push(`"${check.typed}" was stored as '${canon}' — stations are ${STATION_CONVENTION}.`);
      }
      if (result.adopted) {
        warnings.push(`'${canon}' was already in use by ${result.usage.menu_items} menu item(s); it is now on the list as well, so it can be mapped and renamed from here.`);
      }
      const nearAfter = nearDuplicateStation(db, canon);
      if (nearAfter) {
        warnings.push(`'${nearAfter}' also exists and differs only by hyphens — these are TWO separate stations. Check which one your menu items should be on.`);
      }
      // The KDS board split is decided by a hard-coded list in code, not by this
      // table. Stating it at ADD time is the only chance to catch a drink
      // station that would land on the Kitchen board.
      const section = stationKdsSection(canon);
      warnings.push(
        section === 'bar'
          ? `Tickets for '${canon}' will appear on the BAR board.`
          : `Tickets for '${canon}' will appear on the KITCHEN board. The bar board is a fixed list in code — ask for a change if this is a bar station.`,
      );

      return Response.json({
        station: canon, typed: check.typed, normalized: check.changed,
        created: true, kds_section: section,
        message: `'${canon}' added. It is NOT mapped to a department yet, so nothing is deducted for it — pick a department below when you are ready. Menu items reach it once you set their station.`,
        warnings,
      });
    }

    /* ── RENAME ────────────────────────────────────────────────────────────
     * HARDER THAN A CATEGORY RENAME, and the reason has to be respected:
     * `station` is the PRIMARY KEY here AND it is denormalised into
     * menu_items.station (live routing), order_items.station and kots.station
     * (HISTORY), print_stations.station (a physical printer binding),
     * consumption_skips.station and department_material_transactions.station
     * (the append-only department stock ledger).
     *
     * THE DECISION, AND ITS JUSTIFICATION:
     *   MOVE what still has a JOB to do — the master row, every menu item, every
     *   printer binding, and the sold lines / tickets that have NOT been served
     *   or settled yet.
     *   LEAVE what merely RECORDS what already happened — closed sold lines,
     *   served tickets, kot_alerts, consumption_skips, and above all
     *   department_material_transactions, the ledger a variance figure pointed at
     *   a chef is defended with. Past KOTs keep the label they actually printed
     *   under. Rewriting them would re-attribute a night's service to a section
     *   that did not exist then, and would put order_items permanently out of
     *   step with a stock ledger that cannot be rewritten at all.
     *   The one row type that sits between the two is an un-deducted line on an
     *   open bill: it is not history, because the deduction it feeds has not
     *   happened. Left behind it would resolve against a master row that no
     *   longer carries its name and SKIP — a deduction lost to a rename, showing
     *   up weeks later as a gap nobody can explain. So it moves.
     * The full reasoning, table by table, is in src/lib/station-master.ts. */
    if (action === 'rename') {
      const fromKey = normStationKey(body?.from);
      if (!fromKey) return Response.json({ error: 'Pick the station you want to rename.' }, { status: 400 });

      // The sentinel is unrenameable, and there is no force. Unlike MAPPING it —
      // which is a judgement call the owner is allowed to make — renaming it
      // cannot work at all: the literal is written by kot-fire.ts.
      if (SENTINEL_STATIONS.has(fromKey)) {
        return Response.json(
          { error: SENTINEL_RENAME_REFUSAL, code: 'SENTINEL_RENAME', station: fromKey },
          { status: 409 },
        );
      }

      const check = validateStationName(body?.to);
      if (!check.ok) return Response.json({ error: check.error, convention: STATION_CONVENTION }, { status: 400 });
      const to = check.canon;

      if (to === fromKey) {
        return Response.json(
          { error: `'${fromKey}' is already its name — there is nothing to rename. (Stations are stored ${STATION_CONVENTION}, so capitalisation alone is not a change.)` },
          { status: 400 },
        );
      }
      if (SENTINEL_STATIONS.has(to)) {
        return Response.json(
          { error: `'${to}' is reserved — it is the blank-station sentinel, not a section. Pick another name.`, code: 'SENTINEL_STATION' },
          { status: 409 },
        );
      }

      /* THE KDS SECTION SHIFT. kot-section.ts carries a HARD-CODED BAR_STATIONS
       * list and the Kitchen Display filters against it by NAME, so renaming
       * 'cocktail' to 'craft-cocktail' silently moves those tickets off the bar
       * board and onto the kitchen board. Nothing errors; the ticket simply
       * stops appearing where the person who has to make it is looking. That is
       * the worst failure available on this screen, so it takes the house's
       * informed-second-click shape (the same 409 + force:true the sentinel
       * mapping uses) rather than a warning nobody reads afterwards. */
      const fromSection = stationKdsSection(fromKey);
      const toSection = stationKdsSection(to);
      const shift = fromSection !== toSection;
      if (shift && body?.force !== true) {
        return Response.json({
          error:
            `'${fromKey}' currently shows on the ${fromSection.toUpperCase()} board, but '${to}' would show on the ${toSection.toUpperCase()} board. ` +
            'Which board a ticket appears on is decided by the station NAME against a fixed list in the code, not by this screen. ' +
            `Rename it and ${fromSection === 'bar' ? 'bar staff stop seeing these tickets' : 'kitchen staff stop seeing these tickets'} — the ticket prints, but the section watching for it does not see it. ` +
            'Re-send with force:true if that is what you want.',
          code: 'KDS_SECTION_SHIFT', from: fromKey, to, from_section: fromSection, to_section: toSection,
        }, { status: 409 });
      }

      const actorEmail = me.email || '';

      // Check AND move in ONE transaction — the master row and the menu items
      // must never be observable apart, or KOT routing and the department map
      // disagree for the width of the window.
      const run = db.transaction(() => {
        const src = findStationRow(db, fromKey);
        if (!src) {
          return {
            ok: false as const, status: 404, code: undefined as string | undefined,
            // The grid is a UNION of stations found in DATA and stations on the
            // list, so a name that survives only on closed bills is still shown
            // — and reloading will not remove it. Naming the actual recovery is
            // the difference between a dead control and a two-step one.
            error: `'${fromKey}' is not on the station list — it is only a label on past bills and tickets, which is why it is still shown. `
              + 'Add it with the "Add a station" box above (that adopts the name onto the list), then rename it. '
              + 'It may also have just been renamed by someone else, in which case reloading will show the new name.',
          };
        }

        /* THE REFUSAL TO MERGE, IN TWO STRENGTHS. See stationInUseBy().
         *
         * A name that is CURRENTLY A SECTION — a master row, menu items, a
         * printer binding — is never merged onto. Two sections under one string
         * destroys the record of which one cooked which ticket and leaves a
         * single master row deciding the department for both. No force.
         *
         * A name that survives ONLY IN HISTORY is a different thing entirely,
         * and treating it the same is what made every rename one-way: the moment
         * a station has been sold, its own name is left on those closed rows by
         * this very cascade, so renaming BACK — undoing a typo — was refused
         * citing history the rename itself created. 5 of the 13 stations here
         * were already unrecoverable. It is still not free (those old rows start
         * reading as the renamed section in the analytics, and a name that once
         * belonged to a different retired section would merge two pasts), so it
         * costs an informed second click rather than being silently allowed. */
        const used = stationInUseBy(db, to);
        if (used.live.length) {
          return {
            ok: false as const, status: 409, code: undefined as string | undefined,
            error: `'${to}' already exists (${used.live.join(', ')}). Renaming '${fromKey}' onto it would merge two kitchen sections into one, which this tool will not do. Pick a name that is not already in use.`,
          };
        }
        /* A SEPARATE FLAG, not `force`. `force` already answers the KDS-board
         * question, and one flag answering two different consequences is not an
         * informed click — a second confirm that was never shown. */
        if (used.history.length && body?.adopt_history !== true) {
          return {
            ok: false as const, status: 409, code: 'HISTORY_NAME' as string | undefined,
            error: `'${to}' is not a station any more, but it is still the label on ${used.history.join(', ')}. `
              + 'History is never rewritten, so those rows keep that name — and once this rename lands they will read as '
              + `'${to}' in the KOT-analytics and item-journey reports. That is right if you are undoing a rename of this same station, and wrong if '${to}' used to be a different section. `
              + 'Confirm to take the name back.',
          };
        }

        const before = stationUsage(db, fromKey);
        const adopted = used.history.length ? used.history.join(', ') : '';
        const moved = applyStationRename(db, src.station, to);

        logAuditEvent(db, {
          event_type: 'station_department.rename',
          entity_type: 'station_department',
          entity_id: fromKey,
          actor_email: actorEmail,
          before: {
            station: src.station, department_id: src.department_id, is_active: Number(src.is_active),
            menu_items: before.menu_items, order_lines: before.order_lines, kots: before.kots,
            printers: before.printers, kds_section: fromSection,
          },
          after: {
            station: to, moved, kds_section: toSection,
            forced: body?.force === true,
            // What the new name was already carrying, so a re-attributed report
            // can be traced back to the click that re-attributed it.
            adopted_history: adopted || null,
          },
          note:
            `Station '${fromKey}' renamed to '${to}'. Moved: the list entry, ${moved.menu_items} menu item(s), ` +
            `${moved.printers} printer binding(s), ${moved.order_lines_live} un-deducted open line(s), ${moved.kots_live} live ticket(s). ` +
            `NOT rewritten (history): ${before.order_lines - moved.order_lines_live} closed sold line(s), ` +
            `${before.kots - moved.kots_live} served ticket(s), ${before.kot_alerts} KOT alert(s), ` +
            `${before.consumption_skips} consumption skip(s), ${before.dept_ledger_rows} department stock-ledger row(s) — ` +
            'those keep the label they were recorded under.' +
            (shift ? ` KDS board changed from ${fromSection} to ${toSection} (forced).` : '') +
            (adopted ? ` '${to}' was already the label on ${adopted}; those rows now read as this station (confirmed).` : ''),
        });

        return { ok: true as const, moved, before, department_id: src.department_id, adopted };
      });

      const result = run.immediate();
      if (!result.ok) {
        return Response.json(
          { error: result.error, ...(result.code ? { code: result.code, from: fromKey, to } : {}) },
          { status: result.status },
        );
      }

      const { moved, before } = result;
      const warnings: string[] = [];
      if (check.changed) {
        warnings.push(`"${check.typed}" was stored as '${to}' — stations are ${STATION_CONVENTION}.`);
      }
      // A printer bound by its NAME rather than by its station field. print.ts
      // matches EITHER, so this printer was routing tickets and has just stopped
      // — and its label is not this screen's to rewrite.
      if (before.printers_by_name) {
        warnings.push(
          `${before.printers_by_name} printer${before.printers_by_name === 1 ? ' is' : 's are'} matched to '${fromKey}' by the printer's own NAME, not by its station field. That name was not changed, so ${before.printers_by_name === 1 ? 'it' : 'they'} will no longer match — re-point ${before.printers_by_name === 1 ? 'it' : 'them'} on the Printers page.`,
        );
      }
      if (moved.order_lines_live || moved.kots_live) {
        warnings.push(
          `${moved.order_lines_live} open sold line(s) and ${moved.kots_live} live ticket(s) moved with it, so their deduction still resolves. Closed bills and served tickets keep '${fromKey}' — that is the label they printed under.`,
        );
      }
      if (shift) {
        warnings.push(`Tickets for '${to}' now appear on the ${toSection.toUpperCase()} board, not the ${fromSection.toUpperCase()} board.`);
      }
      if (result.adopted) {
        warnings.push(`'${to}' was already the label on ${result.adopted}. Those rows were not rewritten, so they now read as this station in the KOT-analytics and item-journey reports.`);
      }
      // Said AFTER the fact as well as before it, because this is the sentence
      // that explains why undoing this later asks a question: the cascade has
      // just left the OLD name on rows it will never rewrite.
      const leftBehind = (before.order_lines - moved.order_lines_live) + (before.kots - moved.kots_live)
        + before.kot_alerts + before.consumption_skips + before.dept_ledger_rows;
      if (leftBehind) {
        warnings.push(`'${fromKey}' stays on ${leftBehind} history row(s) and cannot be deleted. Renaming a station back onto '${fromKey}' later still works — it asks you to confirm that the old rows should read as that station.`);
      }
      if (!result.department_id) {
        warnings.push(`'${to}' is still unmapped, exactly as '${fromKey}' was — recipe consumption for it is skipped and recorded.`);
      }

      return Response.json({
        from: fromKey, to, typed: check.typed, normalized: check.changed,
        moved,
        kept: {
          closed_order_lines: before.order_lines - moved.order_lines_live,
          served_kots: before.kots - moved.kots_live,
          kot_alerts: before.kot_alerts,
          consumption_skips: before.consumption_skips,
          dept_ledger_rows: before.dept_ledger_rows,
          printers_by_name: before.printers_by_name,
        },
        message: `'${fromKey}' is now '${to}' — the list entry, ${moved.menu_items} menu item${moved.menu_items === 1 ? '' : 's'} and ${moved.printers} printer binding${moved.printers === 1 ? '' : 's'} moved together. Past KOTs and the department stock ledger keep '${fromKey}'.`,
        warnings,
      });
    }

    return Response.json(
      { error: `Unknown action '${action}'. Use 'add', 'rename' or 'impact'.` },
      { status: 400 },
    );
  } catch (e: any) {
    console.error('PATCH /api/settings/station-departments failed:', e);
    return Response.json({ error: e?.message || 'The station list could not be changed' }, { status: 500 });
  }
}
