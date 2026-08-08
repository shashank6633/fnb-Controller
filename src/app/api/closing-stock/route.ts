import { getDb, generateId } from '@/lib/db';
import { allowedDeptIds, canSeeAllDeptStock } from '@/lib/dept-stock';
import {
  DEPT_REQUESTED_ITEM_SQL, NOT_STORE_MAPPED_SQL, deptRequestedParams, selectedDeptSet,
} from '@/lib/dept-requested-items';
import { materialStoreId, getStoreById } from '@/lib/store-engine';
import { upsertVarianceApproval, approveVariance } from '@/lib/variance-approval';
import { rateMap, valueCount, type RateSource } from '@/lib/closing-valuation';
import { packFactor, toPurchaseQty, type PackMeta } from '@/lib/pack-units';

/**
 * VALUATION ON THE CLOSING SHEET (2026-07-30)
 * ───────────────────────────────────────────
 * Every raw-material count is priced at ₹/PURCHASE unit through
 * src/lib/closing-valuation.ts — never from raw_materials.last_purchase_price,
 * which is stored in mixed bases on live data (100 PIPERS holds 2.21 where the
 * real last rate is ₹1,905.31/BTL). See that file's header for the ladder.
 *
 * A COUNT IS A DATED RECORD. POST stamps the rate that applied at count time
 * onto the row (closing_stock.rate_per_purchase_unit / rate_source /
 * total_value) and GET returns the STORED figure whenever one exists, so last
 * week's sheet cannot silently reprice itself when a new purchase lands. Only
 * rows written before this migration (stored rate NULL) are derived on read,
 * and those are flagged `rate_is_stored: false`.
 *
 * Blind counts are untouched: rate + value are COST data, so they ship to
 * everyone; system_stock and variance stay admin-only exactly as before.
 */

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** Resolved valuation for one closing row: stored when the row carries one. */
interface RowValuation {
  rate_per_purchase_unit: number;
  rate_source: RateSource;
  total_value: number;
  /** true = read back off the row (dated record); false = derived at read time. */
  rate_is_stored: boolean;
  /** Purchase date behind a freshly derived last_purchase rate; null when stored. */
  rate_as_of: string | null;
  /** Counted quantity expressed in PURCHASE units — what the rate multiplies. */
  physical_purchase_qty: number;
  pack_factor: number;
}

/**
 * Value one closing_stock row. `row` must carry the material's pack meta
 * (unit / purchase_unit / pack_size / average_price) — the GET query aliases
 * them. `rates` is the ONE-query rateMap for the whole request.
 */
function valueRow(
  db: any,
  row: any,
  rates: Map<string, { unit_price: number; date: string }>,
): RowValuation {
  const meta: PackMeta = { unit: row.unit, purchase_unit: row.purchase_unit, pack_size: row.pack_size };
  const qty = Number(row.physical_stock) || 0;
  const purchaseQty = toPurchaseQty(qty, meta);
  const pf = packFactor(meta);

  // Stored rate wins. `!= null` (not truthiness) on purpose: a stored rate of 0
  // with source 'none' is a real record of "we had no basis that day".
  if (row.rate_per_purchase_unit != null) {
    const rate = Number(row.rate_per_purchase_unit) || 0;
    return {
      rate_per_purchase_unit: rate,
      rate_source: (row.rate_source || 'none') as RateSource,
      total_value: row.total_value != null ? Number(row.total_value) : r2(purchaseQty * rate),
      rate_is_stored: true,
      rate_as_of: null,
      physical_purchase_qty: purchaseQty,
      pack_factor: pf,
    };
  }

  // Pre-migration row — derive, and say so.
  const v = valueCount(
    db,
    { id: row.material_id, unit: row.unit, purchase_unit: row.purchase_unit, pack_size: row.pack_size, average_price: row.average_price },
    qty,
    rates.get(row.material_id) ?? null,
  );
  return {
    rate_per_purchase_unit: v.ratePerPurchaseUnit,
    rate_source: v.source,
    total_value: v.totalValue,
    rate_is_stored: false,
    rate_as_of: v.asOf ?? null,
    physical_purchase_qty: v.purchaseQty,
    pack_factor: pf,
  };
}

export async function GET(request: Request) {
  try {
    const db = getDb();
    // Blind count: only admins may see the system figure + variance anywhere on
    // the closing-stock surfaces (so a counter can't read back the expected
    // number). Everything system/variance-related is stripped for non-admins.
    const me = await (await import('@/lib/auth')).getCurrentUser();
    const isAdmin = me?.role === 'admin';
    const url = new URL(request.url);
    const date = url.searchParams.get('date');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    // Department-wise scoping (2026-07):
    //   department_id — restrict to one department's counts. Special value
    //     '__store__' matches the store/overall rows (department_id NULL or '').
    //   area          — restrict to all departments in one area (kitchen/bar/…).
    const departmentId = url.searchParams.get('department_id');
    const area = url.searchParams.get('area');

    /* ══════════════════════════════════════════════════════════════════════
     * dept_items=1 — THE DEPARTMENT'S OWN COUNT LIST (owner requirement 4)
     * ══════════════════════════════════════════════════════════════════════
     * "If a department requests the 40 items till now, only those items to be
     * shown to the departments for their closing stock updating." This mode
     * answers exactly that: the materials `department_id` has EVER
     * requisitioned (no recency window — see src/lib/dept-requested-items.ts),
     * with rejected lines excluded, as ready-to-render rows.
     *
     * Purely additive: a brand-new query param with its own early return, so
     * every existing caller of this route is byte-for-byte unaffected. Nothing
     * here writes.
     *
     * BLIND COUNTS: current_stock is the system figure, so it is stripped for
     * non-admins here exactly as it is in ../by-location. No variance is
     * computed or returned on this path at all. average_price is COST data
     * (same treatment as the rest of this route) and ships to everyone.
     * ────────────────────────────────────────────────────────────────────── */
    if (url.searchParams.get('dept_items') === '1') {
      if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
      const wanted = (departmentId || '').trim();
      // Store / Overall is NOT department-scoped — say so explicitly rather
      // than returning an empty list the client could mistake for "no items".
      if (!wanted || wanted === '__store__') {
        return Response.json({ scoped: false, department: null, count: 0, items: [], candidates: [] });
      }
      const dept = db.prepare('SELECT id, name FROM departments WHERE id = ?').get(wanted) as
        { id: string; name: string } | undefined;
      if (!dept) return Response.json({ error: 'Unknown department' }, { status: 400 });
      // Same gate as /api/department-stock: privileged tiers see any
      // department, everyone else only their own + granted visible ones.
      if (!canSeeAllDeptStock(me) && !allowedDeptIds(me).has(dept.id)) {
        return Response.json({ error: 'Not allowed for this department' }, { status: 403 });
      }
      const deptSet = selectedDeptSet(db, dept.id);
      const COLS = `rm.id, rm.sku, rm.name, rm.category, rm.super_category, rm.unit,
             COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS purchase_unit,
             COALESCE(rm.pack_size, 1) AS pack_size, COALESCE(rm.case_size, 1) AS case_size,
             rm.current_stock, rm.average_price, rm.reorder_level,
             rm.storage_location, rm.closing_cadence, rm.shelf_life_days`;
      const rows = deptSet.length === 0 ? [] : db.prepare(`
        SELECT ${COLS}
        FROM raw_materials rm
        WHERE ${NOT_STORE_MAPPED_SQL} AND ${DEPT_REQUESTED_ITEM_SQL}
        ORDER BY rm.category, rm.name
      `).all(...deptRequestedParams(deptSet)) as any[];

      /* THE ESCAPE HATCH (requirement 3). The first time a department holds
         something new the list cannot know about it yet, and a counter who
         cannot record real stock writes it on paper instead. `search` returns
         central materials NOT already on this department's list so the counter
         can pull one in. Capped at 50 — this is a search box, not a catalogue
         dump. Once counted, the closing_stock arm of DEPT_REQUESTED_ITEM_SQL
         keeps it on the sheet permanently. */
      const search = (url.searchParams.get('search') || '').trim();
      let candidates: any[] = [];
      if (search) {
        const like = `%${search}%`;
        candidates = db.prepare(`
          SELECT ${COLS}
          FROM raw_materials rm
          WHERE ${NOT_STORE_MAPPED_SQL}
            AND NOT (${DEPT_REQUESTED_ITEM_SQL})
            AND (rm.name LIKE ? OR COALESCE(rm.sku,'') LIKE ?)
          ORDER BY rm.name
          LIMIT 50
        `).all(...deptRequestedParams(deptSet), like, like) as any[];
      }
      const blind = (r: any) => (isAdmin ? r : { ...r, current_stock: null });
      return Response.json({
        scoped: true,
        department: { id: dept.id, name: dept.name },
        // Sub-departments folded in when a MAIN department is selected, the
        // same rollup every other dept-scoped surface uses.
        department_ids: deptSet,
        count: rows.length,
        items: rows.map(blind),
        candidates: candidates.map(blind),
      });
    }

    // Get list of closing stock dates
    if (!date && !from) {
      const dates = db.prepare(`
        SELECT DISTINCT date, COUNT(*) as item_count,
          SUM(ABS(variance_value)) as total_variance_value,
          SUM(CASE WHEN variance < 0 THEN 1 ELSE 0 END) as shortage_count,
          SUM(CASE WHEN variance > 0 THEN 1 ELSE 0 END) as excess_count,
          -- Closing VALUE of the day, read straight off the stored snapshots.
          -- Deliberately NOT re-derived here: this index lists dozens of dates
          -- and a dated record must not reprice. unvalued_count says how many
          -- rows predate the valuation columns, so a partial total is visible
          -- as partial instead of quietly reading low.
          SUM(COALESCE(total_value, 0)) as total_value,
          SUM(CASE WHEN total_value IS NULL THEN 1 ELSE 0 END) as unvalued_count
        FROM closing_stock
        GROUP BY date
        ORDER BY date DESC
        LIMIT 50
      `).all() as any[];
      // Non-admins get item counts only — the variance/shortage figures reveal
      // the system total, so they are admin-only. total_value is COST data
      // (physical count × rate), not a system figure, so it ships to everyone.
      const safeDates = isAdmin ? dates : dates.map(d => ({
        date: d.date, item_count: d.item_count,
        total_variance_value: null, shortage_count: null, excess_count: null,
        total_value: d.total_value || 0, unvalued_count: d.unvalued_count || 0,
      }));
      return Response.json({ dates: safeDates });
    }

    // Get closing stock for a specific date.
    // LEFT JOIN departments so store/overall rows (department_id NULL/'') still
    // return, and we can expose the owning department's name + area per item.
    let query = `
      SELECT cs.*, rm.name as material_name, rm.unit, rm.category, rm.average_price,
             COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS purchase_unit,
             COALESCE(rm.pack_size, 1) AS pack_size,
             d.name as department_name, d.area as department_area
      FROM closing_stock cs
      JOIN raw_materials rm ON cs.material_id = rm.id
      LEFT JOIN departments d ON d.id = cs.department_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (date) {
      query += ' AND cs.date = ?';
      params.push(date);
    }
    if (from) {
      query += ' AND cs.date >= ?';
      params.push(from);
    }
    if (to) {
      query += ' AND cs.date <= ?';
      params.push(to);
    }
    if (departmentId) {
      if (departmentId === '__store__') {
        // Store / overall rows — no owning department.
        query += " AND (cs.department_id IS NULL OR cs.department_id = '')";
      } else {
        query += ' AND cs.department_id = ?';
        params.push(departmentId);
      }
    }
    if (area) {
      // All departments in the given area.
      query += ' AND d.area = ?';
      params.push(area);
    }

    query += ' ORDER BY rm.category, rm.name';

    const rawItems = db.prepare(query).all(...params) as any[];

    // ONE purchase lookup for the whole request (never per line — a sheet is
    // several hundred rows). Shared by the item list and the area rollup below.
    const rates = rateMap(db);

    // Valuation, additively merged onto each row. rate_per_purchase_unit /
    // rate_source / total_value are the RESOLVED figures: the stored snapshot
    // when the row has one, derived only for pre-migration rows (which carry
    // rate_is_stored:false so nobody mistakes a re-derived number for history).
    const items = rawItems.map(i => ({ ...i, ...valueRow(db, i, rates) }));

    // Per-area rollup of the physical closing VALUE (physical_stock × average_price).
    // Built from the SAME date/range window as `items` but WITHOUT the department_id
    // / area filters, so admins always see every area's total even when they've
    // drilled into one department. Rows with no owning department roll up under
    // the '__store__' bucket. Kept as its own aggregate query for correctness.
    const rollupParams: any[] = [];
    let rollupWhere = 'WHERE 1=1';
    if (date) { rollupWhere += ' AND cs.date = ?'; rollupParams.push(date); }
    if (from) { rollupWhere += ' AND cs.date >= ?'; rollupParams.push(from); }
    if (to)   { rollupWhere += ' AND cs.date <= ?'; rollupParams.push(to); }
    const areaRows = db.prepare(`
      SELECT COALESCE(NULLIF(d.area, ''), '__store__') AS area,
             SUM(cs.physical_stock * rm.average_price)  AS physical_value,
             SUM(cs.system_stock   * rm.average_price)  AS system_value,
             SUM(cs.variance_value)                     AS variance_value,
             COUNT(*)                                   AS item_count
      FROM closing_stock cs
      JOIN raw_materials rm ON cs.material_id = rm.id
      LEFT JOIN departments d ON d.id = cs.department_id
      ${rollupWhere}
      GROUP BY COALESCE(NULLIF(d.area, ''), '__store__')
      ORDER BY area
    `).all(...rollupParams) as any[];
    // Rate-based closing value per area, as a SEPARATE pass. The aggregate above
    // is left byte-for-byte alone: physical_value is an existing rupee formula
    // (physical_stock × average_price, ₹/recipe-unit) and rewriting it in JS
    // could shift it by paise. This pass answers a different question — what the
    // count is worth at its OWN stored purchase rate — over the identical window.
    const areaValueRows = db.prepare(`
      SELECT COALESCE(NULLIF(d.area, ''), '__store__') AS area,
             cs.material_id, cs.physical_stock,
             cs.rate_per_purchase_unit, cs.rate_source, cs.total_value,
             rm.unit, rm.average_price,
             COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS purchase_unit,
             COALESCE(rm.pack_size, 1) AS pack_size
      FROM closing_stock cs
      JOIN raw_materials rm ON cs.material_id = rm.id
      LEFT JOIN departments d ON d.id = cs.department_id
      ${rollupWhere}
    `).all(...rollupParams) as any[];
    const closingValueByArea = new Map<string, number>();
    for (const r of areaValueRows) {
      const v = valueRow(db, r, rates);
      closingValueByArea.set(r.area, r2((closingValueByArea.get(r.area) || 0) + v.total_value));
    }

    const by_area = areaRows.map(r => ({
      area: r.area,
      physical_value: r.physical_value || 0,
      system_value: r.system_value || 0,
      variance_value: r.variance_value || 0,
      item_count: r.item_count || 0,
      /** Counted qty × ₹/purchase-unit — the rate-based closing value. */
      closing_value: closingValueByArea.get(r.area) || 0,
    }));

    // Summary
    const summary = {
      total_items: items.length,
      total_system_value: (items as any[]).reduce((s, i) => s + i.system_stock * i.average_price, 0),
      total_physical_value: (items as any[]).reduce((s, i) => s + i.physical_stock * i.average_price, 0),
      total_variance_value: (items as any[]).reduce((s, i) => s + i.variance_value, 0),
      shortage_count: (items as any[]).filter(i => i.variance < 0).length,
      excess_count: (items as any[]).filter(i => i.variance > 0).length,
      match_count: (items as any[]).filter(i => i.variance === 0).length,
      by_area,
      // Whole-sheet valuation. Money sums across materials are legitimate (unlike
      // quantities); unvalued_items is the honest count of lines with no price
      // basis at all, which the sheet shows as an em-dash rather than ₹0.
      total_closing_value: r2((items as any[]).reduce((s, i) => s + (Number(i.total_value) || 0), 0)),
      unvalued_items: (items as any[]).filter(i => i.rate_source === 'none').length,
      derived_rate_items: (items as any[]).filter(i => !i.rate_is_stored).length,
    };

    // Blind count: strip the system figure + variance from every payload for
    // non-admins (items, the value/variance summary, and the area rollup).
    if (!isAdmin) {
      const safeItems = (items as any[]).map(i => ({
        ...i, system_stock: null, variance: null, variance_value: null,
      }));
      // by_area is a physical-value rollup, not a system figure — managers / HODs /
      // store managers render the same panel, so emit it for the whole
      // canSeeAllDeptStock set (it was admin-only, leaving them a silently empty
      // panel) with only the system/variance columns blinded.
      const safeByArea = me && canSeeAllDeptStock(me)
        ? by_area.map(a => ({ ...a, system_value: null, variance_value: null }))
        : [];
      const safeSummary = {
        total_items: summary.total_items,
        total_system_value: null, total_physical_value: null, total_variance_value: null,
        shortage_count: null, excess_count: null, match_count: null, by_area: safeByArea,
        // Cost data, not variance data — a counter may see what they counted is
        // worth without learning what the system expected.
        total_closing_value: summary.total_closing_value,
        unvalued_items: summary.unvalued_items,
        derived_rate_items: summary.derived_rate_items,
      };
      return Response.json({ items: safeItems, summary: safeSummary });
    }
    return Response.json({ items, summary });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    // ADMIN GATE ON `adjust_stock` (2026-08). The flag decides WHEN a count's
    // variance is posted, never IF it is reviewed:
    //   unticked (and ALWAYS for non-admins) → the count raises a PENDING
    //     variance_approvals row and stock does not move. This stays the default
    //     for everyone, admins included.
    //   ticked by an admin → the same pending row is raised and then approved
    //     immediately, through the SAME approveVariance() the queue calls. That
    //     is the one place a count is allowed to move stock, so "approve now"
    //     and "approve later" post the identical count-time delta and leave the
    //     identical audit trail (inventory_transactions + reviewed_by).
    // Forced false for non-admins even though the UI hides the checkbox — the
    // route must not trust the client, or a store user could one-click
    // reconcile away genuine shrinkage. Saving counts is unaffected and remains
    // open to all. DEPARTMENT-tagged rows are carved out below: a department
    // count already re-anchors its own balance the moment it is saved, which is
    // why varianceApprovalBlock() refuses them, so ticking the box leaves those
    // rows pending exactly as before.
    const authMod = await import('@/lib/auth');
    const me = await authMod.getCurrentUser();
    const isAdmin = me?.role === 'admin';
    // Tag every saved count with the current outlet so outlet-scoped reads (e.g.
    // the Variance Report) see it immediately — without this the row is written
    // outlet_id NULL and only appears after the next server-boot backfill.
    const outletId = await authMod.getCurrentOutletId();
    const db = getDb();
    const body = await request.json();
    const { date, items } = body;
    // Strict `=== true`: a truthy string from an old client must not turn a
    // routine save into a stock adjustment.
    const adjustStock = isAdmin && body.adjust_stock === true;
    // Department-wise counts (2026-07): a top-level department_id applies to every
    // item unless the item carries its own. Normalize '' / null / '__store__' to
    // NULL so store/overall counts (no owning department) are stored consistently.
    const normDept = (v: any): string | null => {
      const s = v == null ? '' : String(v).trim();
      return s === '' || s === '__store__' ? null : s;
    };
    const topDeptId = normDept(body.department_id);

    if (!date || !items || !Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'date and items array are required' }, { status: 400 });
    }

    // `pending` = variances left for an admin to clear later; `applied` = variances
    // this submit already posted to stock (adjust_stock, admin, central rows only).
    // Every non-zero variance lands in exactly one of the two.
    const results = { success: 0, pending: 0, applied: 0, errors: [] as string[], total_value: 0 };

    // ONE purchase lookup for the entire submit, resolved BEFORE the write
    // transaction opens. A sheet posts several hundred lines; a per-line
    // "latest purchase" query would be several hundred index scans held inside
    // a write txn. Each line passes its own entry in as `preloaded`.
    const rates = rateMap(db);

    const recordClosingStock = db.transaction(() => {
      // Per-(material, department) upsert (do NOT wipe the whole day — counts may
      // arrive department-by-department / location-by-location throughout the EOD
      // ritual). The delete is scoped by department_id so saving one department's
      // count never clobbers another department's count of the same material.
      const delOne = db.prepare(
        "DELETE FROM closing_stock WHERE date = ? AND material_id = ? AND COALESCE(department_id, '') = COALESCE(?, '')"
      );

      for (const item of items) {
        if (!item.material_id) continue;
        // Per-item department_id overrides the top-level one when present.
        const deptId = item.department_id !== undefined ? normDept(item.department_id) : topDeptId;

        const material = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(item.material_id) as any;
        if (!material) {
          results.errors.push(`Material not found: ${item.material_id}`);
          continue;
        }

        // Store guard: store-mapped materials (liquor) are counted in their OWN
        // store's closing (/api/stores/[id]/closing) — reject per item, before
        // the upsert-delete so an existing count is never clobbered. Other
        // items in the same submit still save normally.
        const storeId = materialStoreId(db, material);
        if (storeId) {
          const storeName = getStoreById(db, storeId)?.name || 'store';
          results.errors.push(
            `${material.name}: ${storeName.toUpperCase()} material — use ${storeName} closing (Inventory → ${storeName}), not Central closing stock.`
          );
          continue;
        }

        // KNOWN LIMITATION — the system figure is the CENTRAL pool
        // (raw_materials.current_stock) even for a row tagged to a department.
        // A department's count is therefore NOT comparable to it. Left as-is
        // (changing it would change what every existing count means); instead
        // approveVariance() refuses to move central stock for a central count
        // with a department_id — see varianceApprovalBlock() in
        // src/lib/variance-approval.ts. Counting a department against its own
        // computed balance is a separate build.
        const systemStock = material.current_stock;
        const physicalStock = Number(item.physical_stock);

        if (isNaN(physicalStock) || physicalStock < 0) {
          results.errors.push(`Invalid physical stock for ${material.name}`);
          continue;
        }

        // THE UPSERT-DELETE RUNS ONLY AFTER THE LINE IS KNOWN GOOD. It used to
        // run before this validation, so a typo'd quantity DELETED the count
        // already stored for (date, material, department) and inserted nothing
        // in its place — the day's figure vanished and any pending approval
        // pointing at it was orphaned. Every per-line rejection above (missing
        // material, store-mapped item, bad quantity) must stay upstream of this
        // line. Same ordering as the sibling writer, ../dept-sheet.
        delOne.run(date, item.material_id, deptId);

        const variance = Math.round((physicalStock - systemStock) * 1000) / 1000;
        const varianceValue = Math.round(variance * material.average_price * 100) / 100;

        const id = generateId();

        // Value the count AT COUNT TIME and stamp the rate onto the row. The
        // rate comes from the shared ladder (last purchase → average cost →
        // none), never from raw_materials.last_purchase_price. Persisting it
        // is what makes the count a dated record: a purchase landing tomorrow
        // must not reprice tonight's sheet.
        const valued = valueCount(db, material, physicalStock, rates.get(item.material_id) ?? null);

        db.prepare(`
          INSERT INTO closing_stock (id, material_id, department_id, date, system_stock, physical_stock, variance, variance_value, notes, recorded_by, outlet_id, rate_per_purchase_unit, rate_source, total_value, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(id, item.material_id, deptId, date, systemStock, physicalStock, variance, varianceValue, item.notes || '', item.recorded_by || '', outletId || null,
               valued.ratePerPurchaseUnit, valued.source, valued.totalValue);

        results.total_value = r2(results.total_value + valued.totalValue);

        // A non-zero variance never changes stock from HERE — it creates a
        // PENDING approval, and stock moves only when that approval is granted.
        // A re-count that now matches clears any stale pending row and returns
        // null (handled inside).
        const approvalId = upsertVarianceApproval(db, {
          source: 'central',
          material_id: item.material_id,
          department_id: deptId || '',
          date,
          system_stock: systemStock,
          physical_stock: physicalStock,
          unit: material.unit,
          counted_by: item.recorded_by || me?.email || '',
          count_note: item.notes || '',
          outlet_id: outletId,
        });
        if (variance !== 0) {
          // `adjust_stock` ticked by an admin on a CENTRAL row = grant that
          // approval right now, in the same breath, as the admin who saved.
          // It is the queue's own approveVariance() — never a second
          // UPDATE of raw_materials.current_stock — so the delta posted, the
          // negative-stock behaviour, the inventory_transactions log and the
          // reviewed_by trail are byte-for-byte what "approve later" produces.
          //
          // It lands exactly on the counted figure because `systemStock` above
          // IS live current_stock at this instant, so approveVariance's
          // (physical − system-at-count) delta is (physical − current):
          // before + delta == physical. That equality is only true here, at
          // save time — which is precisely why the deferred path posts a delta
          // instead of an absolute set.
          //
          // DEPARTMENT rows are excluded on purpose: saving the count has
          // already re-anchored that department's own balance (dept-ledger
          // prefers the count as anchor), so approving would take the same
          // difference off twice — varianceApprovalBlock() refuses them for
          // exactly this reason. They stay pending, and central is not touched.
          let applied = false;
          if (adjustStock && !deptId && approvalId) {
            // Failure must NOT be silent and must NOT cost the count: the
            // approval simply stays pending and the admin is told why. The
            // saved closing_stock row survives because better-sqlite3 nests
            // approveVariance's transaction as a SAVEPOINT inside ours, so its
            // rollback unwinds only its own writes.
            try {
              const res = approveVariance(
                db, approvalId, me?.email || 'admin',
                `Adjust system stock ticked on the closing sheet for ${date} — approved at count time by the admin who saved the count.`,
              );
              if (res.ok) applied = true;
              else results.errors.push(`${material.name}: count saved, but system stock was NOT adjusted — ${res.error}`);
            } catch (e: any) {
              results.errors.push(`${material.name}: count saved, but system stock was NOT adjusted — ${e?.message || 'approval failed'}`);
            }
          }
          if (applied) results.applied++;
          else results.pending++;
        }

        results.success++;
      }
    });

    recordClosingStock();

    return Response.json(results);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
