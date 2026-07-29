import { getDb } from '@/lib/db';
import { getCurrentOutletId, getCurrentUser } from '@/lib/auth';
import { canSeeAllDeptStock, resolveDeptSet } from '@/lib/dept-stock';
import { todayIST } from '@/lib/format-date';

/**
 * CENTRAL closing-stock overview — Grocery Store / Chiller / Kitchen / … × department.
 * The Liquor mirror of this board lives on the store surfaces (store_closing_counts);
 * liquor/store-mapped materials are excluded here so the two never double-count.
 *
 * Two orthogonal axes:
 *   rows    = raw_materials.storage_location (free text; blank → '— Unassigned —')
 *   columns = closing_stock.department_id, folded to the MAIN department
 *             (departments.parent_id IS NULL). NULL/'' → the Store/Overall bucket.
 *
 * GET /api/closing-stock/overview
 *   ?date=YYYY-MM-DD            default: today (IST)
 *   ?location=<name>            present → ITEMS mode (drill-down). '__unassigned__' = blank.
 *   ?department_id=<id>         items mode. '__store__' = the NULL/'' bucket; a MAIN
 *                               department id expands to itself + its sub-departments.
 *   ?include_uncounted=1        items mode — append this location's not-yet-counted materials.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UNASSIGNED = '— Unassigned —';
const STORE_KEY = '__store__';
const STORE_NAME = 'Store / Overall';

// Store-mapped materials (liquor) are counted in their OWN store's closing
// (/api/stores/[id]/closing) — never on Central surfaces. Kept byte-identical to
// the guard in ../locations and ../by-location so the three can never diverge.
const NOT_STORE_MAPPED = `NOT EXISTS (
          SELECT 1 FROM store_category_map scm
          JOIN store_locations sl ON sl.id = scm.store_id
          WHERE sl.is_active = 1 AND REPLACE(REPLACE(REPLACE(LOWER(TRIM(scm.category)),' ',''),'-',''),'_','') = REPLACE(REPLACE(REPLACE(LOWER(TRIM(rm.category)),' ',''),'-',''),'_','')
        )`;

// Counts may be tagged with the current outlet, or left NULL/'' by pre-outlet
// writes + backfills — both must still show up on the board.
const OUTLET_SCOPE = (alias: string) => `(${alias}.outlet_id = ? OR COALESCE(${alias}.outlet_id,'') = '')`;

/** ₹ to paise. Null passes through so blind-count nulls survive the rounding. */
const paise = (n: number | null | undefined): number | null =>
  n == null ? null : Math.round(n * 100) / 100;

export async function GET(request: Request) {
  try {
    const db = getDb();
    const me = await getCurrentUser();
    // This board aggregates every department's counts, so it is gated to the same
    // set as /api/department-stock. Message wording is load-bearing — the page
    // matches on "limited"/"authoriz" to render its own no-access state.
    if (!me || !canSeeAllDeptStock(me)) {
      return Response.json(
        { error: 'Closing overview is limited to admins, managers, HODs and store managers.' },
        { status: 403 },
      );
    }
    // Blind count: only admins may see the system figure + anything derived from
    // it (variance, shortage/excess). physical_* is what was actually counted and
    // stays visible to every viewer who passes the gate above.
    const isAdmin = me.role === 'admin';

    const url = new URL(request.url);
    const date = url.searchParams.get('date') || todayIST();
    const outletId = await getCurrentOutletId();
    const rawLocation = url.searchParams.get('location');

    if (rawLocation !== null) {
      return itemsMode(db, url, date, outletId, rawLocation, isAdmin);
    }

    // ---- PIVOT -------------------------------------------------------------
    // Column set: the Store/Overall bucket plus every MAIN department. Inactive
    // mains are kept only when they actually hold counts on this date, so a
    // retired department never silently swallows its rows.
    const mainDepts = db.prepare(`
      SELECT d.id, d.name, d.is_active,
             (SELECT COUNT(*) FROM departments c WHERE c.parent_id = d.id) AS sub_count
      FROM departments d
      WHERE d.parent_id IS NULL OR TRIM(d.parent_id) = ''
      ORDER BY d.name
    `).all() as { id: string; name: string; is_active: number; sub_count: number }[];

    // (a) counts, grouped by location × MAIN department. A sub-department folds
    // into its parent; an unresolvable department_id (deleted dept) falls back to
    // the Store bucket rather than vanishing.
    const countRows = db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(rm.storage_location), ''), '${UNASSIGNED}') AS location,
        CASE WHEN d.id IS NULL THEN '${STORE_KEY}'
             ELSE COALESCE(NULLIF(TRIM(d.parent_id), ''), d.id) END      AS dept_key,
        COUNT(*)                                         AS counted,
        SUM(cs.physical_stock * rm.average_price)        AS physical_value,
        SUM(cs.system_stock   * rm.average_price)        AS system_value,
        SUM(cs.variance_value)                           AS variance_value,
        SUM(CASE WHEN cs.variance < 0 THEN 1 ELSE 0 END) AS shortage,
        SUM(CASE WHEN cs.variance > 0 THEN 1 ELSE 0 END) AS excess
      FROM closing_stock cs
      JOIN raw_materials rm ON rm.id = cs.material_id
      LEFT JOIN departments d ON d.id = cs.department_id
      WHERE cs.date = ?
        AND ${OUTLET_SCOPE('cs')}
        AND ${NOT_STORE_MAPPED}
      GROUP BY location, dept_key
    `).all(date, outletId) as any[];

    // (b) the countable universe per location. Spans active AND inactive
    // materials so counts on a since-deactivated item still register as counted,
    // but the denominator (total_items) tallies active ones only.
    const universeRows = db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(rm.storage_location), ''), '${UNASSIGNED}') AS location,
        COUNT(DISTINCT CASE WHEN rm.is_active = 1 THEN rm.id END)        AS total_items,
        COUNT(DISTINCT CASE WHEN cs.id IS NOT NULL THEN rm.id END)       AS counted_items
      FROM raw_materials rm
      LEFT JOIN closing_stock cs
             ON cs.material_id = rm.id
            AND cs.date = ?
            AND ${OUTLET_SCOPE('cs')}
      WHERE ${NOT_STORE_MAPPED}
      GROUP BY location
      ORDER BY location
    `).all(date, outletId) as any[];

    const knownKeys = new Set<string>([STORE_KEY, ...mainDepts.map(d => d.id)]);
    const usedKeys = new Set<string>();

    interface Cell {
      counted: number; physical_value: number;
      system_value: number; variance_value: number; shortage: number; excess: number;
    }
    const byLocation = new Map<string, Map<string, Cell>>();
    for (const r of countRows) {
      // Fold anything outside the known column set into Store/Overall so a row's
      // by_dept always adds up to its total.
      const key = knownKeys.has(r.dept_key) ? r.dept_key : STORE_KEY;
      usedKeys.add(key);
      let cells = byLocation.get(r.location);
      if (!cells) { cells = new Map(); byLocation.set(r.location, cells); }
      const cur = cells.get(key) || { counted: 0, physical_value: 0, system_value: 0, variance_value: 0, shortage: 0, excess: 0 };
      cur.counted += Number(r.counted) || 0;
      cur.physical_value += Number(r.physical_value) || 0;
      cur.system_value += Number(r.system_value) || 0;
      cur.variance_value += Number(r.variance_value) || 0;
      cur.shortage += Number(r.shortage) || 0;
      cur.excess += Number(r.excess) || 0;
      cells.set(key, cur);
    }

    const departments: { key: string; name: string; sub_count?: number }[] = [
      { key: STORE_KEY, name: STORE_NAME },
      ...mainDepts
        .filter(d => d.is_active === 1 || usedKeys.has(d.id))
        .map(d => ({ key: d.id, name: d.name, sub_count: Number(d.sub_count) || 0 })),
    ];

    // Locations come from the universe query (stable, alphabetical, '— Unassigned —'
    // last under BINARY collation); any location that only exists via counts is
    // appended so nothing counted is ever invisible.
    const order: string[] = universeRows.map(u => u.location);
    for (const loc of byLocation.keys()) if (!order.includes(loc)) order.push(loc);
    const universeByLoc = new Map(universeRows.map(u => [u.location, u]));

    const rows = order.map(location => {
      const u = universeByLoc.get(location);
      const cells = byLocation.get(location);
      const by_dept: Record<string, any> = {};
      const tot = { counted: 0, physical_value: 0, system_value: 0, variance_value: 0 };
      if (cells) {
        for (const [key, c] of cells) {
          tot.counted += c.counted;
          tot.physical_value += c.physical_value;
          tot.system_value += c.system_value;
          tot.variance_value += c.variance_value;
          by_dept[key] = {
            counted: c.counted,
            physical_value: paise(c.physical_value),
            system_value: isAdmin ? paise(c.system_value) : null,
            variance_value: isAdmin ? paise(c.variance_value) : null,
            shortage: isAdmin ? c.shortage : null,
            excess: isAdmin ? c.excess : null,
          };
        }
      }
      return {
        location,
        total_items: Number(u?.total_items) || 0,
        // Distinct materials counted at this location (a material counted under two
        // departments is one item here, but two entries across by_dept.counted).
        counted_items: Number(u?.counted_items) || 0,
        by_dept,
        total: {
          counted: tot.counted,
          physical_value: paise(tot.physical_value),
          system_value: isAdmin ? paise(tot.system_value) : null,
          variance_value: isAdmin ? paise(tot.variance_value) : null,
        },
      };
    }).filter(r => r.total_items > 0 || r.total.counted > 0);

    const totals = {
      areas: rows.length,
      items: rows.reduce((s, r) => s + r.total_items, 0),
      counted: rows.reduce((s, r) => s + r.counted_items, 0),
      physical_value: paise(rows.reduce((s, r) => s + (r.total.physical_value || 0), 0)),
      variance_value: isAdmin ? paise(rows.reduce((s, r) => s + (r.total.variance_value || 0), 0)) : null,
    };

    return Response.json({ date, departments, rows, totals, generated_at: new Date().toISOString() });
  } catch (e: any) {
    console.error('[closing-stock/overview]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/** Drill-down: the individual counts behind one (location, department, date) cell. */
function itemsMode(
  db: ReturnType<typeof getDb>,
  url: URL,
  date: string,
  outletId: string | null,
  rawLocation: string,
  isAdmin: boolean,
) {
  const isUnassigned = rawLocation === '__unassigned__' || rawLocation === UNASSIGNED;
  const locSql = isUnassigned
    ? `(rm.storage_location IS NULL OR TRIM(rm.storage_location) = '')`
    : `TRIM(rm.storage_location) = ?`;
  const locParams: any[] = isUnassigned ? [] : [rawLocation];

  const rawDept = url.searchParams.get('department_id');
  const deptId = rawDept == null ? null : String(rawDept).trim();
  // A MAIN department drills into itself + its sub-departments (resolveDeptSet);
  // a sub-department id resolves to just itself. An unknown id keeps the literal
  // id so the query returns nothing rather than silently widening to everything.
  const deptSet = deptId && deptId !== '' && deptId !== STORE_KEY
    ? (resolveDeptSet(db, deptId).length ? resolveDeptSet(db, deptId) : [deptId])
    : [];
  const deptWhere = (alias: string): { sql: string; params: any[] } => {
    if (deptId == null || deptId === '') return { sql: '1=1', params: [] };
    if (deptId === STORE_KEY) return { sql: `COALESCE(${alias}.department_id, '') = ''`, params: [] };
    return { sql: `${alias}.department_id IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(deptSet)] };
  };

  const dw = deptWhere('cs');
  const counted = db.prepare(`
    SELECT cs.material_id, cs.department_id,
           cs.physical_stock, cs.system_stock, cs.variance, cs.variance_value,
           cs.notes, cs.recorded_by,
           cs.created_at AS last_counted_at, cs.date AS last_counted_date,
           rm.name, rm.sku, rm.category, rm.unit, rm.average_price,
           COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS purchase_unit,
           COALESCE(rm.pack_size, 1) AS pack_size,
           d.name AS department_name
    FROM closing_stock cs
    JOIN raw_materials rm ON rm.id = cs.material_id
    LEFT JOIN departments d ON d.id = cs.department_id
    WHERE cs.date = ?
      AND ${OUTLET_SCOPE('cs')}
      AND ${locSql}
      AND ${dw.sql}
      AND ${NOT_STORE_MAPPED}
    ORDER BY rm.category, rm.name
  `).all(date, outletId, ...locParams, ...dw.params) as any[];

  const items: any[] = counted.map(r => ({
    material_id: r.material_id,
    name: r.name,
    sku: r.sku || '',
    category: r.category || '',
    unit: r.unit || '',
    purchase_unit: r.purchase_unit || '',
    pack_size: Number(r.pack_size) || 1,
    average_price: r.average_price,
    department_id: r.department_id || '',
    department_name: r.department_name || STORE_NAME,
    counted: true,
    physical_stock: r.physical_stock,
    // physical_stock is in RECIPE units and average_price is ₹/RECIPE unit —
    // multiply straight through, do NOT divide by pack_size.
    value: paise(r.physical_stock * r.average_price),
    system_stock: isAdmin ? r.system_stock : null,
    variance: isAdmin ? r.variance : null,
    variance_value: isAdmin ? paise(r.variance_value) : null,
    notes: r.notes || '',
    recorded_by: r.recorded_by || '',
    last_counted_at: r.last_counted_at,
    last_counted_date: r.last_counted_date,
  }));

  if (url.searchParams.get('include_uncounted') === '1') {
    // "Uncounted" is scoped to the SAME department filter as the counted list —
    // with a department selected this is that department's still-to-do list, not
    // "nobody has touched it".
    const uw = deptWhere('cs2');
    const pending = db.prepare(`
      SELECT rm.id AS material_id, rm.name, rm.sku, rm.category, rm.unit, rm.average_price,
             COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS purchase_unit,
             COALESCE(rm.pack_size, 1) AS pack_size
      FROM raw_materials rm
      WHERE rm.is_active = 1
        AND ${locSql}
        AND ${NOT_STORE_MAPPED}
        AND NOT EXISTS (
          SELECT 1 FROM closing_stock cs2
          WHERE cs2.material_id = rm.id AND cs2.date = ?
            AND ${OUTLET_SCOPE('cs2')}
            AND ${uw.sql}
        )
      ORDER BY rm.category, rm.name
    `).all(...locParams, date, outletId, ...uw.params) as any[];
    for (const r of pending) {
      items.push({
        material_id: r.material_id,
        name: r.name,
        sku: r.sku || '',
        category: r.category || '',
        unit: r.unit || '',
        purchase_unit: r.purchase_unit || '',
        pack_size: Number(r.pack_size) || 1,
        average_price: r.average_price,
        department_id: '',
        department_name: null,
        counted: false,
        physical_stock: null,
        value: null,
        system_stock: null,
        variance: null,
        variance_value: null,
        notes: '',
        recorded_by: '',
        last_counted_at: null,
        last_counted_date: null,
      });
    }
  }

  const summary = {
    items: items.length,
    counted: counted.length,
    physical_value: paise(counted.reduce((s, r) => s + r.physical_stock * r.average_price, 0)),
    system_value: isAdmin ? paise(counted.reduce((s, r) => s + r.system_stock * r.average_price, 0)) : null,
    variance_value: isAdmin ? paise(counted.reduce((s, r) => s + (r.variance_value || 0), 0)) : null,
  };

  return Response.json({
    date,
    location: isUnassigned ? UNASSIGNED : rawLocation,
    department_id: deptId,
    items,
    summary,
    generated_at: new Date().toISOString(),
  });
}
