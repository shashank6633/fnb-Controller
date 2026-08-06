import type Database from 'better-sqlite3';
import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { resolveStationDepartment } from '@/lib/dept-ledger';

/**
 * THE STATION → DEPARTMENT MAP, as data the owner edits.
 *
 *   GET  /api/settings/station-departments   → every station that EXISTS IN DATA,
 *                                              mapped or not, with what the
 *                                              mapping is worth.        (signed in)
 *   PUT  /api/settings/station-departments   → set or clear ONE mapping.   (admin)
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

export async function GET() {
  try {
    // READ is open to any signed-in user, matching the settings/route.ts
    // precedent: which kitchen a station belongs to is not a secret, only the
    // power to change it is. The proxy only checks that a session cookie is
    // PRESENT, so this call is the real authentication.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const db = getDb();
    const hasMap = tableExists(db, 'station_departments');
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
