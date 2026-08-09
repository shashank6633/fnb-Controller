import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, getCurrentUser } from '@/lib/auth';
import { allowedDeptSetExpanded, canSeeAllDeptStock } from '@/lib/dept-stock';
import { materialStoreId, getStoreById } from '@/lib/store-engine';
import { upsertVarianceApproval } from '@/lib/variance-approval';
import { rateMap, valueCount, type RateSource } from '@/lib/closing-valuation';
import { packFactor, toPurchaseQty, type PackMeta } from '@/lib/pack-units';
import { todayIST } from '@/lib/format-date';
import { checkClosingDate } from '@/lib/closing-date';

/**
 * DEPARTMENT CLOSING SHEET — one sheet spanning every ACTIVE department, for
 * physical-stock ENTRY and reporting (owner requirement 5). Feeds
 * /inventory/closing-sheet.
 *
 * ── WHY A SIBLING ROUTE, NOT AN EXTENSION ──────────────────────────────────
 * /api/closing-stock/overview is a READ-ONLY pivot whose rows are STORAGE AREAS
 * and whose columns are MAIN departments (subs folded into their parent). This
 * sheet's rows are MATERIALS, its grouping is the department that will actually
 * be counted (sub-departments stay separate — a count belongs to exactly one
 * department, and folding "Akan Tandoori" into "Kitchen" would make the entry
 * ambiguous), and it WRITES. Different axis, different verb: a separate route.
 *
 * ── DEPARTMENT LIST ────────────────────────────────────────────────────────
 * Read from `departments` at runtime — never hardcoded. Every ACTIVE department
 * is returned, including ones with an empty item set, so the day somebody
 * creates "Cold Room" it appears here with zero items instead of the page
 * needing a code change. Inactive departments are returned ONLY when they hold
 * a count on the requested date (so an existing count never silently vanishes).
 *
 * ── ITEM SET PER DEPARTMENT ────────────────────────────────────────────────
 * The house definition, shared with /api/department-stock: materials ever
 * ISSUED to that department, UNION materials ever COUNTED by it
 * (dept-stock.DEPT_ITEM_SET_SQL). Deliberately NOT rolled up to the parent —
 * see above. Store-mapped (liquor) materials are excluded: they are counted in
 * their own store's closing, and the POST here rejects them too.
 *
 * ── VALUATION ──────────────────────────────────────────────────────────────
 * Rates come from '@/lib/closing-valuation' only. raw_materials
 * .last_purchase_price is NEVER read — it is stored in mixed bases on live data
 * (MALA STRAWBERRY CRUSH 5 LTR holds 0.13 against a true Rs 674.10/BTL).
 * A saved count is a DATED RECORD: it carries the rate that applied AT COUNT
 * TIME (closing_stock.rate_per_purchase_unit / rate_source / total_value), and
 * this route reads that stored rate back rather than re-pricing history.
 * `rate_source: 'none'` means there is no basis at all → value comes back NULL
 * so the page can print an em-dash instead of a confident Rs 0.
 *
 * ── BLIND COUNTS ───────────────────────────────────────────────────────────
 * system_stock / variance / variance_value are ADMIN-ONLY and are stripped
 * SERVER-SIDE for everyone else — they are never serialised into the payload,
 * so a non-admin cannot recover them from the network tab either. Rate and
 * value are COST data, not variance data, and stay visible.
 *
 * GET  /api/closing-stock/dept-sheet?date=YYYY-MM-DD
 * POST /api/closing-stock/dept-sheet
 *   { date, entries: [{ department_id, material_id, physical_stock, notes? }] }
 *   physical_stock is in RECIPE units — the same basis the existing
 *   /api/closing-stock POST takes. No new storage basis is introduced.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Wording is load-bearing: the page matches /limited|authoriz/ to render its
 *  own lock notice instead of a red error. */
const NO_SCOPE =
  'The department closing sheet is limited to admins, managers, HODs and store managers — or to staff with a department assigned.';

// Store-mapped materials (liquor) belong to their own store's closing
// (/api/stores/[id]/closing). Kept byte-identical to the guard in ../overview so
// the two can never disagree about which side of the house owns a material.
const NOT_STORE_MAPPED = `NOT EXISTS (
  SELECT 1 FROM store_category_map scm
  JOIN store_locations sl ON sl.id = scm.store_id
  WHERE sl.is_active = 1 AND REPLACE(REPLACE(REPLACE(LOWER(TRIM(scm.category)),' ',''),'-',''),'_','') = REPLACE(REPLACE(REPLACE(LOWER(TRIM(rm.category)),' ',''),'-',''),'_','')
)`;

// Counts may be tagged with the current outlet, or left NULL/'' by pre-outlet
// writes + backfills — both must still show up.
const OUTLET_SCOPE = `(cs.outlet_id = ? OR COALESCE(cs.outlet_id,'') = '')`;

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: unknown) => Number(v) || 0;

interface DeptRow {
  id: string;
  name: string;
  parent_id: string | null;
  parent_name: string | null;
  area: string;
  is_active: number;
}

interface MatRow {
  dept_id: string;
  material_id: string;
  name: string;
  sku: string | null;
  category: string | null;
  unit: string | null;
  purchase_unit: string | null;
  pack_size: number | null;
  case_size: number | null;
  average_price: number | null;
  current_stock: number | null;
  is_active: number;
}

interface CountRow {
  material_id: string;
  dept_id: string;
  physical_stock: number;
  system_stock: number;
  variance: number;
  variance_value: number;
  rate_per_purchase_unit: number | null;
  rate_source: string | null;
  total_value: number | null;
  notes: string | null;
  recorded_by: string | null;
}

/* ── GET ──────────────────────────────────────────────────────────────────── */

export async function GET(request: Request) {
  try {
    const db = getDb();
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Not authorized.' }, { status: 401 });

    const seesAll = canSeeAllDeptStock(me);
    // A non-privileged user gets their OWN department plus any explicitly
    // granted visible departments (each expanded to its sub-departments) — the
    // same scope /api/department-stock and the dept-scoped closing lists use.
    const scopedIds = seesAll ? null : new Set(allowedDeptSetExpanded(db, me));
    if (scopedIds && scopedIds.size === 0) {
      return Response.json({ error: NO_SCOPE }, { status: 403 });
    }
    // Blind count: ONLY admins may see the system figure or anything derived
    // from it. Everything below branches on this before it is serialised.
    const isAdmin = me.role === 'admin';

    const url = new URL(request.url);
    const date = url.searchParams.get('date') || todayIST();
    const outletId = await getCurrentOutletId();

    // Every ACTIVE department, read at runtime. An INACTIVE one is included only
    // when it actually holds a count on this date.
    const allDepts = db.prepare(`
      SELECT d.id, d.name, NULLIF(TRIM(COALESCE(d.parent_id,'')),'') AS parent_id,
             COALESCE(p.name, '')  AS parent_name,
             COALESCE(d.area, '')  AS area,
             d.is_active
        FROM departments d
        LEFT JOIN departments p ON p.id = d.parent_id
       ORDER BY d.name
    `).all() as DeptRow[];

    const countedDeptIds = new Set(
      (db.prepare(`
        SELECT DISTINCT COALESCE(cs.department_id,'') AS dept_id
          FROM closing_stock cs
         WHERE cs.date = ? AND ${OUTLET_SCOPE}
      `).all(date, outletId) as { dept_id: string }[]).map(r => r.dept_id).filter(Boolean),
    );

    const depts = allDepts.filter(d =>
      (d.is_active === 1 || countedDeptIds.has(d.id)) &&
      (!scopedIds || scopedIds.has(d.id)),
    );
    if (depts.length === 0) {
      return Response.json({
        date, is_admin: isAdmin, scope: seesAll ? 'all' : 'limited',
        departments: [], totals: emptyTotals(isAdmin), generated_at: new Date().toISOString(),
      });
    }

    const deptIdsJson = JSON.stringify(depts.map(d => d.id));

    // ONE query for every (department, material) pair on the sheet. The pair set
    // is the house DEPT_ITEM_SET definition, expanded across all departments at
    // once rather than 19 separate round-trips.
    const matRows = db.prepare(`
      WITH pairs AS (
        SELECT COALESCE(ri.department_id, r.department_id) AS dept_id, ri.material_id AS material_id
          FROM requisition_items ri
          JOIN requisitions r ON r.id = ri.req_id
         WHERE COALESCE(ri.department_id, r.department_id) IN (SELECT value FROM json_each(?))
           AND r.status NOT IN ('cancelled','chef_rejected')
           AND COALESCE(r.purpose,'internal') <> 'party'
           AND ri.quantity_issued > 0
           AND COALESCE(ri.is_rejected,0) = 0
           AND COALESCE(ri.store_rejected,0) = 0
        UNION
        SELECT cs.department_id AS dept_id, cs.material_id AS material_id
          FROM closing_stock cs
         WHERE cs.department_id IN (SELECT value FROM json_each(?))
      )
      SELECT pairs.dept_id                                            AS dept_id,
             rm.id                                                    AS material_id,
             rm.name                                                  AS name,
             rm.sku                                                   AS sku,
             rm.category                                              AS category,
             rm.unit                                                  AS unit,
             COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit)     AS purchase_unit,
             rm.pack_size                                             AS pack_size,
             rm.case_size                                             AS case_size,
             rm.average_price                                         AS average_price,
             rm.current_stock                                         AS current_stock,
             COALESCE(rm.is_active, 1)                                AS is_active
        FROM pairs
        JOIN raw_materials rm ON rm.id = pairs.material_id
       WHERE ${NOT_STORE_MAPPED}
         AND (COALESCE(rm.is_active,1) = 1
              OR EXISTS (SELECT 1 FROM closing_stock cs2
                          WHERE cs2.material_id = rm.id
                            AND cs2.date = ?
                            AND COALESCE(cs2.department_id,'') = pairs.dept_id))
       ORDER BY COALESCE(NULLIF(TRIM(rm.category),''), 'zz') , rm.name
    `).all(deptIdsJson, deptIdsJson, date) as MatRow[];

    // Counts already recorded for this date, keyed by department+material.
    const countRows = db.prepare(`
      SELECT cs.material_id                    AS material_id,
             COALESCE(cs.department_id,'')     AS dept_id,
             cs.physical_stock                 AS physical_stock,
             cs.system_stock                   AS system_stock,
             cs.variance                       AS variance,
             cs.variance_value                 AS variance_value,
             cs.rate_per_purchase_unit         AS rate_per_purchase_unit,
             cs.rate_source                    AS rate_source,
             cs.total_value                    AS total_value,
             cs.notes                          AS notes,
             cs.recorded_by                    AS recorded_by
        FROM closing_stock cs
       WHERE cs.date = ? AND ${OUTLET_SCOPE}
       ORDER BY cs.created_at ASC
    `).all(date, outletId) as CountRow[];
    // Last write wins for a same-day re-count (matches the POST's per-key upsert).
    const counts = new Map<string, CountRow>();
    for (const c of countRows) if (c.dept_id) counts.set(`${c.dept_id}|${c.material_id}`, c);

    // ONE purchase lookup for the whole sheet (1,079 live rows today).
    const rates = rateMap(db);

    const byDept = new Map<string, MatRow[]>();
    for (const m of matRows) {
      const list = byDept.get(m.dept_id);
      if (list) list.push(m); else byDept.set(m.dept_id, [m]);
    }

    let gItems = 0, gCounted = 0, gValue = 0, gUnpriced = 0, gVariance = 0;

    const departments = depts.map(d => {
      const mats = byDept.get(d.id) || [];
      let items = 0, counted = 0, value = 0, unpriced = 0, variance = 0;

      const rows = mats.map(m => {
        const meta: PackMeta = {
          unit: m.unit, purchase_unit: m.purchase_unit,
          pack_size: m.pack_size, case_size: m.case_size,
        };
        const saved = counts.get(`${d.id}|${m.material_id}`);
        const preloaded = rates.get(m.material_id) ?? null;

        // Live ladder — what a count entered right now would be worth.
        const live = valueCount(db, {
          id: m.material_id, unit: m.unit, purchase_unit: m.purchase_unit,
          pack_size: m.pack_size, average_price: m.average_price,
        }, saved ? num(saved.physical_stock) : 0, preloaded);

        let rate: number = live.ratePerPurchaseUnit;
        let rateSource: RateSource | string = live.source;
        let rateAsOf: string | null = live.asOf ?? null;
        let rateAtCount = false;
        let val: number | null = null;

        if (saved) {
          if (saved.rate_per_purchase_unit != null) {
            // DATED RECORD: read the rate that applied at count time. Never
            // re-price a saved row from today's purchases.
            rate = num(saved.rate_per_purchase_unit);
            rateSource = String(saved.rate_source || 'none');
            rateAsOf = null;
            rateAtCount = true;
            val = saved.total_value != null
              ? num(saved.total_value)
              : r2(toPurchaseQty(num(saved.physical_stock), meta) * rate);
          } else {
            // A row written before rate capture existed. There is no historical
            // rate to honour, so it is valued at today's ladder and SAYS SO
            // (rate_at_count:false) rather than pretending to be a dated figure.
            val = live.totalValue;
          }
          // 'none' = no basis at all. NULL, so the sheet prints an em-dash
          // instead of a confident Rs 0.
          if (rateSource === 'none') val = null;
        }

        items++;
        if (saved) {
          counted++;
          if (val === null) unpriced++; else value += val;
          variance += num(saved.variance_value);
        }

        return {
          material_id: m.material_id,
          name: m.name,
          sku: m.sku || '',
          category: m.category || '',
          unit: m.unit || '',
          purchase_unit: m.purchase_unit || m.unit || '',
          pack_size: m.pack_size ?? 1,
          case_size: m.case_size ?? 1,
          pack_factor: packFactor(meta),
          is_active: m.is_active === 1,
          counted: !!saved,
          /** RECIPE units, exactly as stored. */
          physical_stock: saved ? num(saved.physical_stock) : null,
          rate_per_purchase_unit: rateSource === 'none' ? null : r2(rate),
          rate_source: rateSource,
          rate_as_of: rateAsOf,
          rate_at_count: rateAtCount,
          value: val,
          notes: saved?.notes || '',
          recorded_by: saved?.recorded_by || '',
          // ── BLIND COUNT ── admin-only. For a non-admin these three keys are
          // literally absent from the JSON, not merely hidden by CSS.
          ...(isAdmin
            ? {
                system_stock: saved ? num(saved.system_stock) : num(m.current_stock),
                variance: saved ? num(saved.variance) : null,
                variance_value: saved ? num(saved.variance_value) : null,
              }
            : {}),
        };
      });

      gItems += items; gCounted += counted; gValue += value; gUnpriced += unpriced;
      gVariance += variance;

      return {
        id: d.id,
        name: d.name,
        parent_id: d.parent_id,
        parent_name: d.parent_name || '',
        /** The heading this department files under (its parent, or itself). */
        group: d.parent_name || d.name,
        area: d.area,
        is_active: d.is_active === 1,
        items: rows,
        totals: {
          items, counted,
          uncounted: Math.max(0, items - counted),
          /** Rs — the only aggregate that is valid across materials. */
          value: r2(value),
          /** Counted rows with no rate basis; excluded from `value`. */
          unpriced,
          ...(isAdmin ? { variance_value: r2(variance) } : {}),
        },
      };
    });

    return Response.json({
      date,
      is_admin: isAdmin,
      scope: seesAll ? 'all' : 'limited',
      departments,
      totals: {
        departments: departments.length,
        items: gItems,
        counted: gCounted,
        uncounted: Math.max(0, gItems - gCounted),
        value: r2(gValue),
        unpriced: gUnpriced,
        ...(isAdmin ? { variance_value: r2(gVariance) } : {}),
      },
      generated_at: new Date().toISOString(),
    });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error)?.message || 'Failed' }, { status: 500 });
  }
}

function emptyTotals(isAdmin: boolean) {
  return {
    departments: 0, items: 0, counted: 0, uncounted: 0, value: 0, unpriced: 0,
    ...(isAdmin ? { variance_value: 0 } : {}),
  };
}

/* ── POST ─────────────────────────────────────────────────────────────────── */

interface PostEntry {
  department_id?: string;
  material_id?: string;
  /** RECIPE units — same basis and same field name as /api/closing-stock POST. */
  physical_stock?: number | string;
  notes?: string;
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Not authorized.' }, { status: 401 });

    const seesAll = canSeeAllDeptStock(me);
    const scopedIds = seesAll ? null : new Set(allowedDeptSetExpanded(db, me));
    if (scopedIds && scopedIds.size === 0) {
      return Response.json({ error: NO_SCOPE }, { status: 403 });
    }
    const outletId = await getCurrentOutletId();

    const body = await request.json();
    const entries: PostEntry[] = Array.isArray(body?.entries) ? body.entries : [];
    // ONE date check for the whole submit, BEFORE the transaction opens. This
    // sheet posts every department at once, so a per-entry check would answer a
    // hundred copies of the same complaint; refusing the submit whole also means
    // not one upsert-delete fires against a bad date.
    //
    // SHARED GUARD, not a local regex. The shape test that used to live here
    // passed 2027-08-09 and 2026-02-31 straight through: a future-dated count
    // becomes the newest count for those materials and then silently refuses
    // every real count after it (only the newest-dated count per item is
    // approvable — e91c64c), and a count dated to a day that does not exist
    // matches no GET date filter, so it saves and is invisible everywhere.
    // Backdating is untouched — counting last Tuesday is ordinary business.
    // The .trim() is kept: it predates the shared guard, which by design has no
    // whitespace tolerance of its own.
    const checked = checkClosingDate(String(body?.date || '').trim());
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    // Bind THIS below, never body.date — the raw value can be an array that
    // survives String() coercion and then throws at bind time mid-transaction.
    const date = checked.date;
    if (entries.length === 0) {
      return Response.json({ error: 'entries array is required' }, { status: 400 });
    }

    const results = { saved: 0, pending: 0, errors: [] as string[] };
    const rates = rateMap(db);

    const run = db.transaction(() => {
      // Per-(date, material, department) upsert. Scoped by department so saving
      // one department's count never clobbers another department's count of the
      // same material — identical to the existing /api/closing-stock writer.
      const delOne = db.prepare(
        "DELETE FROM closing_stock WHERE date = ? AND material_id = ? AND COALESCE(department_id,'') = ?",
      );

      for (const e of entries) {
        const deptId = String(e?.department_id || '').trim();
        const materialId = String(e?.material_id || '').trim();
        if (!materialId) continue;

        // This sheet is department-wise by definition. A Store/Overall count
        // (no department) is a different record and stays on /closing-stock.
        if (!deptId) {
          results.errors.push('A department is required for every line on the department sheet.');
          continue;
        }
        if (scopedIds && !scopedIds.has(deptId)) {
          results.errors.push('You are not allowed to record counts for one of the selected departments.');
          continue;
        }
        const dept = db.prepare('SELECT id, name FROM departments WHERE id = ?').get(deptId) as
          { id: string; name: string } | undefined;
        if (!dept) { results.errors.push(`Unknown department: ${deptId}`); continue; }

        const material = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(materialId) as
          Record<string, unknown> | undefined;
        if (!material) { results.errors.push(`Material not found: ${materialId}`); continue; }

        // Store guard: liquor/store-mapped materials are counted in their own
        // store's closing. Rejected per line, BEFORE the delete, so an existing
        // count is never clobbered and the rest of the batch still saves.
        const storeId = materialStoreId(db, material as { category?: string | null });
        if (storeId) {
          const storeName = getStoreById(db, storeId)?.name || 'store';
          results.errors.push(
            `${material.name}: ${storeName.toUpperCase()} material — use ${storeName} closing (Inventory → ${storeName}), not the department sheet.`,
          );
          continue;
        }

        const physicalStock = Number(e?.physical_stock);
        if (!isFinite(physicalStock) || physicalStock < 0) {
          results.errors.push(`Invalid physical stock for ${material.name}`);
          continue;
        }

        delOne.run(date, materialId, deptId);

        // KNOWN LIMITATION, inherited verbatim from /api/closing-stock: the
        // system figure is the CENTRAL pool (raw_materials.current_stock) even
        // for a row tagged to a department, so a department count is not
        // directly comparable to it. Changing that would change what every
        // existing count means; approveVariance() already refuses to move
        // central stock for a departmental central count.
        const systemStock = Number(material.current_stock) || 0;
        const variance = Math.round((physicalStock - systemStock) * 1000) / 1000;
        // UNCHANGED rupee formula (variance x average_price, Rs/recipe unit).
        const varianceValue = Math.round(variance * (Number(material.average_price) || 0) * 100) / 100;

        // The rate that applies AT COUNT TIME, from the shared ladder. Stored
        // with the row so the sheet never re-prices history.
        const valued = valueCount(db, {
          id: materialId,
          unit: material.unit as string | null,
          purchase_unit: material.purchase_unit as string | null,
          pack_size: material.pack_size as number | null,
          average_price: material.average_price as number | null,
        }, physicalStock, rates.get(materialId) ?? null);

        db.prepare(`
          INSERT INTO closing_stock
            (id, material_id, department_id, date, system_stock, physical_stock, variance,
             variance_value, notes, recorded_by, outlet_id,
             rate_per_purchase_unit, rate_source, total_value, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          generateId(), materialId, deptId, date, systemStock, physicalStock, variance,
          varianceValue, String(e?.notes || ''), me.email || '', outletId || null,
          valued.ratePerPurchaseUnit, valued.source, valued.totalValue,
        );

        // A non-zero variance never moves stock here — it raises a PENDING
        // approval for an admin. Same call the existing writer makes, so counts
        // from this sheet land in the same queue.
        upsertVarianceApproval(db, {
          source: 'central',
          material_id: materialId,
          department_id: deptId,
          date,
          system_stock: systemStock,
          physical_stock: physicalStock,
          unit: String(material.unit || ''),
          counted_by: me.email || '',
          count_note: String(e?.notes || ''),
          outlet_id: outletId,
        });
        if (variance !== 0) results.pending++;
        results.saved++;
      }
    });

    run();
    return Response.json(results);
  } catch (error: unknown) {
    return Response.json({ error: (error as Error)?.message || 'Failed' }, { status: 500 });
  }
}
