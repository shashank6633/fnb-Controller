import { getDb, generateId } from '@/lib/db';
import { valueSemiCount } from '@/lib/closing-valuation';
import { checkClosingDate } from '@/lib/closing-date';
import { readPhysicalCount, zeroPatternGuard, type CountInput } from '@/lib/variance-approval';

/**
 * CLOSING COUNTS FOR SEMI-FINISHED ITEMS (sub_recipes)
 * ────────────────────────────────────────────────────
 * 68 live sub-recipes — Mint Chutney, Aioli, GG Paste — sit in the kitchen at
 * close in real quantities, but they live in `sub_recipes`, not
 * `raw_materials`, so the ordinary closing sheet could never list them. This
 * route is their read/write side; counts land in `closing_stock_semi`.
 *
 * WHY A SEPARATE TABLE AND ROUTE, not a flag on closing_stock: that table's
 * material_id is NOT NULL with a FOREIGN KEY to raw_materials and
 * `PRAGMA foreign_keys = ON`, so a sub-recipe id cannot physically be stored
 * there (see the migration note at src/lib/db.ts:1278).
 *
 * UNITS — a sub-recipe is counted in its OWN yield_unit and costed by
 * cost_per_unit (₹ per yield_unit). There is NO purchase unit and NO pack
 * factor; running one through packFactor would be a category error. All
 * valuation goes through valueSemiCount() for exactly that reason.
 *
 * BLIND COUNTS — nothing to strip here. A semi-finished count has no system
 * figure and no variance (the app does not track a running balance for
 * sub-recipes), so this payload cannot reveal what the system expected. Rate
 * and value are COST data and ship to everyone, matching the raw-material
 * sheet. If a system balance for sub-recipes is ever built, the admin guard
 * from ../route.ts must be copied here at the same time.
 *
 * Conventions (date, department_id, outlet_id, recorded_by, one row per
 * item-per-department-per-day) deliberately mirror ../route.ts line for line.
 *
 * THE COUNT DATE — validated by the SHARED guard (src/lib/closing-date.ts),
 * which is the same call ../route.ts makes, and it has to be the same CALL
 * rather than a copied rule: /closing-stock submits ONE sheet as TWO POSTs
 * under a single date — raw materials to ../route.ts, sub-recipes here. If the
 * two guards ever disagree, one submit is refused for raw materials and
 * accepted for semi-finished ones, half-recording the day. Until 2026-08 this
 * route had NO date validation whatsoever — not even the shape check the liquor
 * and dept-sheet writers carried — so a typo'd or future date was written here
 * verbatim, and a non-string threw at bind time inside the transaction.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * '' / null / '__store__' all mean the Store/Overall bucket, stored as NULL —
 * the same normalisation the raw-material POST uses, so the two sheets bucket
 * a department identically.
 */
const normDept = (v: any): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s === '' || s === '__store__' ? null : s;
};

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const date = url.searchParams.get('date');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const departmentId = url.searchParams.get('department_id');
    const countedOnly = url.searchParams.get('counted_only') === '1';
    const includeInactive = url.searchParams.get('include_inactive') === '1';

    // ── History index: which days have semi-finished counts. Mirrors the
    // dates branch of ../route.ts. Values are the STORED snapshots, never
    // re-derived, because a count is a dated record.
    if (!date && !from) {
      const dates = db.prepare(`
        SELECT date, COUNT(*) AS item_count, SUM(COALESCE(total_value, 0)) AS total_value
          FROM closing_stock_semi
         GROUP BY date
         ORDER BY date DESC
         LIMIT 50
      `).all() as any[];
      return Response.json({
        dates: dates.map(d => ({ date: d.date, item_count: d.item_count || 0, total_value: r2(d.total_value) })),
      });
    }

    // ── History rows: every saved count in the window, across departments.
    if (countedOnly) {
      let sql = `
        SELECT css.id, css.sub_recipe_id, css.date, css.department_id, css.outlet_id,
               css.physical_stock, css.unit, css.rate, css.total_value,
               css.notes, css.recorded_by, css.created_at,
               sr.name, sr.category, sr.yield_unit, sr.cost_per_unit, sr.is_active,
               d.name AS department_name, d.area AS department_area
          FROM closing_stock_semi css
          JOIN sub_recipes sr ON sr.id = css.sub_recipe_id
     LEFT JOIN departments d ON d.id = css.department_id
         WHERE 1=1
      `;
      const params: any[] = [];
      if (date) { sql += ' AND css.date = ?'; params.push(date); }
      if (from) { sql += ' AND css.date >= ?'; params.push(from); }
      if (to)   { sql += ' AND css.date <= ?'; params.push(to); }
      if (departmentId != null) {
        const dep = normDept(departmentId);
        if (dep === null) sql += " AND (css.department_id IS NULL OR css.department_id = '')";
        else { sql += ' AND css.department_id = ?'; params.push(dep); }
      }
      sql += ' ORDER BY css.date DESC, sr.category, sr.name';

      const rows = db.prepare(sql).all(...params) as any[];
      const items = rows.map(r => shapeCounted(r));
      return Response.json({
        items,
        summary: {
          total_items: items.length,
          counted_items: items.length,
          total_value: r2(items.reduce((s, i) => s + i.total_value, 0)),
          unvalued_items: items.filter(i => i.rate_source === 'none').length,
        },
      });
    }

    // ── Count sheet: EVERY active sub-recipe, with this department's count for
    // the day attached when one exists. The dept bucket is pinned so the
    // read-back matches how the POST wrote it — an unscoped LEFT JOIN would fan
    // one sub-recipe out into one row per department that counted it.
    const dep = normDept(departmentId);
    const rows = db.prepare(`
      SELECT sr.id AS sub_recipe_id, sr.name, sr.category, sr.yield_quantity,
             sr.yield_unit, sr.cost_per_unit, sr.is_active,
             css.id            AS count_id,
             css.physical_stock,
             css.unit          AS counted_unit,
             css.rate          AS stored_rate,
             css.total_value   AS stored_total_value,
             css.notes, css.recorded_by, css.created_at, css.department_id, css.outlet_id
        FROM sub_recipes sr
   LEFT JOIN closing_stock_semi css
          ON css.sub_recipe_id = sr.id
         AND css.date = ?
         AND COALESCE(css.department_id, '') = ?
       WHERE (sr.is_active = 1 OR ?)
       ORDER BY sr.category, sr.name
    `).all(date, dep ?? '', includeInactive ? 1 : 0) as any[];

    const items = rows.map(r => {
      const counted = r.count_id != null;
      // Stored snapshot wins for a saved row — the count is a dated record and
      // must not reprice when the recipe is re-costed. Uncounted lines preview
      // today's cost_per_unit so the sheet can show what a count would be worth.
      const live = valueSemiCount({ cost_per_unit: r.cost_per_unit, yield_unit: r.yield_unit }, Number(r.physical_stock) || 0);
      const rate = counted && r.stored_rate != null ? Number(r.stored_rate) : live.rate;
      const totalValue = counted
        ? (r.stored_total_value != null ? Number(r.stored_total_value) : r2((Number(r.physical_stock) || 0) * rate))
        : 0;
      return {
        sub_recipe_id: r.sub_recipe_id,
        name: r.name,
        category: r.category,
        yield_quantity: r.yield_quantity,
        yield_unit: r.yield_unit,
        cost_per_unit: r.cost_per_unit,
        is_active: r.is_active,
        // null (not 0) = not counted yet. A counter must be able to tell
        // "nobody counted this" from "we counted zero".
        physical_stock: counted ? Number(r.physical_stock) : null,
        unit: counted ? (r.counted_unit || r.yield_unit) : r.yield_unit,
        rate_per_unit: rate,
        // Same vocabulary as the raw-material sheet (RateSource in
        // closing-valuation.ts) — a sub-recipe's cost_per_unit IS its average
        // cost. rate_is_stored, not a fourth source label, marks the snapshot.
        rate_source: (rate > 0 ? 'average_cost' : 'none') as 'average_cost' | 'none',
        rate_is_stored: counted && r.stored_rate != null,
        total_value: totalValue,
        counted,
        count_id: r.count_id ?? null,
        department_id: counted ? (r.department_id ?? null) : dep,
        outlet_id: r.outlet_id ?? null,
        notes: r.notes ?? '',
        recorded_by: r.recorded_by ?? '',
        counted_at: r.created_at ?? null,
      };
    });

    return Response.json({
      date,
      department_id: dep,
      items,
      summary: {
        total_items: items.length,
        counted_items: items.filter(i => i.counted).length,
        total_value: r2(items.reduce((s, i) => s + i.total_value, 0)),
        // Sub-recipes whose costing has never been run — cost_per_unit 0. The
        // sheet must print an em-dash for these, not a confident ₹0.
        unvalued_items: items.filter(i => i.rate_source === 'none').length,
      },
    });
  } catch (e: any) {
    console.error('[closing-stock/semi GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

function shapeCounted(r: any) {
  const rate = Number(r.rate) || 0;
  return {
    id: r.id,
    sub_recipe_id: r.sub_recipe_id,
    name: r.name,
    category: r.category,
    date: r.date,
    department_id: r.department_id ?? null,
    department_name: r.department_name ?? null,
    department_area: r.department_area ?? null,
    outlet_id: r.outlet_id ?? null,
    physical_stock: Number(r.physical_stock) || 0,
    unit: r.unit || r.yield_unit || '',
    yield_unit: r.yield_unit,
    cost_per_unit: r.cost_per_unit,
    rate_per_unit: rate,
    rate_source: (rate > 0 ? 'average_cost' : 'none') as 'average_cost' | 'none',
    rate_is_stored: true,
    total_value: Number(r.total_value) || 0,
    is_active: r.is_active,
    notes: r.notes ?? '',
    recorded_by: r.recorded_by ?? '',
    counted: true,
    counted_at: r.created_at ?? null,
  };
}

/**
 * Save semi-finished counts.
 *
 * Body: { date, department_id?, items: [{ sub_recipe_id, physical_stock,
 *         notes?, recorded_by?, department_id? }] }
 *
 * Duplicate-per-day behaviour copies ../route.ts exactly: delete-then-insert
 * scoped to (date, item, department), so a department re-counting its own
 * items never clobbers another department's count of the same sub-recipe, and
 * the whole day is never wiped — counts arrive department-by-department
 * through the EOD ritual.
 */
export async function POST(request: Request) {
  try {
    const authMod = await import('@/lib/auth');
    const me = await authMod.getCurrentUser();
    // Tag the row with the current outlet so outlet-scoped reads see it at once,
    // rather than only after the next server-boot backfill.
    const outletId = await authMod.getCurrentOutletId();
    const db = getDb();
    const body = await request.json();
    const { date: rawDate, items } = body;
    const topDeptId = normDept(body.department_id);

    if (!rawDate || !items || !Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'date and items array are required' }, { status: 400 });
    }

    // ONE date check for the whole submit, BEFORE the transaction opens — a
    // sheet carrying all 68 sub-recipes must not come back with 68 copies of
    // the same complaint, and refusing it whole means no half-written day.
    // Deliberately AFTER the truthiness check above so a missing date keeps its
    // own message instead of being reported as an invalid one.
    const checked = checkClosingDate(rawDate);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    // Bind THIS at every SQL site below, never body.date: String() coercion
    // means ["2026-08-09"] passes every check, but binding the ARRAY throws at
    // bind time inside the write transaction — a 500 and a full rollback where
    // a clean save was due.
    const date = checked.date;

    /* THE COUNT IS READ ONCE, BEFORE ANY WRITE — the same rule and the same
     * CALL as the raw-material sheet (src/lib/variance-approval.ts).
     *
     * This route's GET has carried the `counted` concept since it shipped
     * (`counted ? Number(r.physical_stock) : null` at :165, derived from row
     * presence) and its POST had none of it: `Number(item.physical_stock)` made
     * `''`, `'   '` and `null` all a finite, non-negative 0 that walked past the
     * `isNaN || < 0` guard and was stored as a counted zero — then the
     * delete-then-insert below replaced the sub-recipe's real count for that day
     * with it. The read side could tell "nobody counted this" from "we counted
     * zero"; the write side could not, and the write side is the one that
     * decides. Same rule on both halves now.
     * ────────────────────────────────────────────────────────────────────── */
    const parsed: CountInput[] = (items as unknown[]).map(
      i => readPhysicalCount((i as { physical_stock?: unknown } | null)?.physical_stock),
    );

    // The pattern guard, identical to the raw sheet's. A sub-recipe sheet is 68
    // lines, so it only ever trips on a wholesale fill-down; the floors in the
    // lib keep an ordinary partial count well clear.
    // Judged on the lines that will actually be WRITTEN — a line whose
    // sub-recipe does not exist is refused per line in the loop below and must
    // not dilute the share (dilution only ever makes the guard quieter).
    const guardCounts: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const pc = parsed[i];
      if (pc.kind !== 'count') continue;
      const sid = String(items[i]?.sub_recipe_id || '').trim();
      if (!sid) continue;
      if (!db.prepare('SELECT 1 FROM sub_recipes WHERE id = ?').get(sid)) continue;
      guardCounts.push(pc.qty);
    }
    const zeroGuard = zeroPatternGuard(guardCounts);
    if (zeroGuard.suspicious && body.confirm_zeros !== true) {
      return Response.json(
        { error: zeroGuard.message, zero_guard: { ...zeroGuard, confirm_field: 'confirm_zeros' } },
        { status: 409 },
      );
    }

    const results = {
      success: 0, not_counted: 0, errors: [] as string[], total_value: 0,
      zero_guard: zeroGuard.suspicious ? { ...zeroGuard, confirmed: true } : null,
    };

    const record = db.transaction(() => {
      const delOne = db.prepare(
        "DELETE FROM closing_stock_semi WHERE date = ? AND sub_recipe_id = ? AND COALESCE(department_id, '') = COALESCE(?, '')"
      );
      const getSub = db.prepare('SELECT id, name, yield_unit, cost_per_unit, is_active FROM sub_recipes WHERE id = ?');
      const ins = db.prepare(`
        INSERT INTO closing_stock_semi
          (id, sub_recipe_id, date, department_id, outlet_id, physical_stock, unit, rate, total_value, notes, recorded_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        if (!item.sub_recipe_id) continue;

        // BLANK = NOT COUNTED. Decided before the sub-recipe lookup and long
        // before delOne — a line nobody counted must not delete the count that
        // is already stored for that (date, sub-recipe, department), and must
        // not raise an error either.
        const pc = parsed[idx];
        if (pc.kind === 'not_counted') { results.not_counted++; continue; }

        const deptId = item.department_id !== undefined ? normDept(item.department_id) : topDeptId;

        const sub = getSub.get(item.sub_recipe_id) as any;
        if (!sub) {
          results.errors.push(`Sub-recipe not found: ${item.sub_recipe_id}`);
          continue;
        }

        // Typed-but-not-a-count is still a per-line refusal; only blank is silent.
        if (pc.kind === 'error') {
          results.errors.push(`${sub.name}: ${pc.reason}`);
          continue;
        }
        const physicalStock = pc.qty;

        // Value at count time and STORE rate + unit + value on the row. No pack
        // factor: a sub-recipe is counted and costed in the same yield_unit.
        const valued = valueSemiCount(sub, physicalStock);

        delOne.run(date, item.sub_recipe_id, deptId);
        ins.run(
          generateId(), item.sub_recipe_id, date, deptId, outletId || null,
          physicalStock, valued.unit, valued.rate, valued.totalValue,
          item.notes || '',
          // There is no variance-approval row for a semi count to carry the
          // counter's identity, so the count row itself falls back to the
          // signed-in user (the same fallback ../route.ts uses on its approval).
          item.recorded_by || me?.email || '',
        );

        results.total_value = r2(results.total_value + valued.totalValue);
        results.success++;
      }
    });

    record();

    /* NO UPLOAD DIGEST HERE, AND THAT IS NOT AN OVERSIGHT.
     * ────────────────────────────────────────────────────
     * The digest (section 6 of src/lib/variance-approval.ts) is derived from
     * `variance_approvals` rows carrying a batch_id. This route raises NONE: a
     * sub-recipe has no system balance, so a semi count produces no variance, no
     * approval row, and no batch id at all — there is literally nothing for a
     * digest to report but the line count.
     *
     * Do NOT "fix" that by minting a batch id here. It would put an item in the
     * owner's bell that says "N counted, nothing differed" every single time, by
     * construction and for ever — the exact wallpaper the digest was built to
     * replace. The semi half of a sheet is already reported in this response and
     * on the closing sheet itself.
     *
     * /closing-stock posts ONE sheet as TWO POSTs (raw materials to ../route.ts,
     * sub-recipes here), and the raw half raises the digest for that sheet. It
     * counts raw lines only — see the note beside recordCountDigest in
     * ../dept-sheet/import/route.ts for why the semi lines stay out of that
     * denominator. */

    return Response.json(results);
  } catch (e: any) {
    console.error('[closing-stock/semi POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
