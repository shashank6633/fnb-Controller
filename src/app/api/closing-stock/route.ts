import { getDb, generateId } from '@/lib/db';
import { allowedDeptIds, canSeeAllDeptStock } from '@/lib/dept-stock';
import {
  DEPT_REQUESTED_ITEM_SQL, NOT_STORE_MAPPED_SQL, deptRequestedParams, selectedDeptSet,
} from '@/lib/dept-requested-items';
import { materialStoreId, getStoreById } from '@/lib/store-engine';
import {
  recordCountVariance, readPhysicalCount, zeroPatternGuard, type CountInput,
} from '@/lib/variance-approval';
import { rateMap, valueCount, type RateSource } from '@/lib/closing-valuation';
import { packFactor, toPurchaseQty, type PackMeta } from '@/lib/pack-units';
import { checkClosingDate } from '@/lib/closing-date';

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
    //
    // ⚠ READ THE LINE ABOVE AS "one-CLICK", NOT AS "cannot". ONCE AN ADMIN ARMS
    // THE BAR (closing_variance_bar_value / _qty) a non-admin's saved count DOES
    // move central stock — automatically, up to the bar and never above
    // AUTO_APPLY_HARD_VALUE_CEILING, recorded as `system:auto-apply`. That is
    // the owner's approved model, not a hole: small differences apply
    // themselves and appear on the report; anything bigger is HELD for an
    // admin. What this flag still guarantees is that no non-admin can reconcile
    // an ARBITRARY difference away by ticking a box. The bar ships at 0 (off),
    // so on a fresh install the sentence above is literally true; the moment it
    // is set, this is the sentence that describes the system.
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

    /* ══════════════════════════════════════════════════════════════════════
     * THE DATE GUARD — ONCE FOR THE WHOLE SUBMIT, NEVER PER ITEM (2026-08)
     * ══════════════════════════════════════════════════════════════════════
     * Shape, real-calendar day and not-in-the-future, in that order, from the
     * one shared validator: src/lib/closing-date.ts — the single source of
     * truth EVERY writer into closing_stock must run its date through, so the
     * regex cannot drift between the several doors into the same table. That
     * module carries the full WHY; in short, one fat-fingered 2027-08-09
     * supersedes every later real count of that item until somebody rejects it
     * (e91c64c), and a malformed date saves a row that matches no GET date
     * filter and is invisible on every closing surface thereafter.
     *
     * Until dfbf0f0 this route checked only that `date` was TRUTHY — any
     * string at all went straight into closing_stock.date.
     *
     * BACKDATING MUST KEEP WORKING and is untouched. Counting last Tuesday is
     * ordinary business here — late sheets, paper counts typed up the next
     * morning, the department-ledger cutover — and several flows depend on it.
     * ONLY future and malformed are refused.
     *
     * ONE rejection for the whole request, before the loop. A ~950-line sheet
     * must not come back with 950 copies of the same complaint, and refusing
     * the submit whole means no half-written day: the transaction below never
     * opens, so not one upsert-delete fires against a bad date.
     * ────────────────────────────────────────────────────────────────────── */
    const checked = checkClosingDate(date);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    const dateStr = checked.date;

    /* ══════════════════════════════════════════════════════════════════════
     * THE COUNT IS READ ONCE, BEFORE ANYTHING IS WRITTEN (2026-08)
     * ══════════════════════════════════════════════════════════════════════
     * `Number(item.physical_stock)` used to sit inside the write loop, and
     * `Number('') === 0` / `Number(null) === 0` are both finite and >= 0 — so a
     * BLANK cell passed the `isNaN || < 0` guard and was stored as a REAL
     * COUNTED ZERO. Worse, the upsert-delete below fires for any line that gets
     * that far, so a blank DELETED the count already saved for that
     * (date, material, department) and replaced it with 0.
     *
     * readPhysicalCount() is the ONE reader (src/lib/variance-approval.ts):
     * blank ⇒ not_counted ⇒ this line does not exist for this submit — no
     * delete, no insert, no variance, no approval, no error. A 0 is a real
     * count and behaves like any other number.
     *
     * Parsed HERE rather than in the loop so the zero-pattern guard below can
     * judge the whole submit BEFORE the transaction opens. One parse, one
     * array, indexed alongside `items`.
     * ────────────────────────────────────────────────────────────────────── */
    const parsed: CountInput[] = (items as unknown[]).map(
      i => readPhysicalCount((i as { physical_stock?: unknown } | null)?.physical_stock),
    );

    /* THE UPLOAD PATTERN GUARD (owner requirement 7). Not a value check — a 0 is
     * a legitimate count and stays one. This refuses a submit in which an
     * IMPLAUSIBLE SHARE of the counted lines read 0, which is the signature of a
     * sheet whose blanks were filled in by a spreadsheet (the incident: 793 of
     * 1,033). It names the count, refuses before a single row is written, and a
     * genuine all-zero stocktake still goes through on a second submit carrying
     * `confirm_zeros: true`. Thresholds are in the lib and are generous enough
     * that an EOD keypad entry or a small correction can never reach them. */
    /* THE GUARD JUDGES WRITABLE LINES, NOT MERELY PARSED ONES.
     *
     * Counting every parsed line let unwritable lines DILUTE the share, and
     * dilution is the dangerous direction — it makes the guard quieter, never
     * louder. Measured: 20 real zeros plus 40 lines whose material does not
     * exist gave 20/60 = 33%, no warning, and 20 counted zeros written. The
     * realistic version is not a hand-built payload at all: a central sheet
     * carrying LIQUOR materials (rejected per line, a few lines below) or stale
     * material ids from an old export. It was also over-strict the other way —
     * 30 zeros that could never be written still 409'd.
     *
     * So the denominator is the two per-line refusals that sit above the
     * upsert-delete in the loop below: material not found, and store-mapped
     * material. Those lookups are by primary key on a set already in memory;
     * the loop keeps doing its OWN read (it must — an auto-applied line changes
     * current_stock, and a later line of the same material has to see it). */
    const guardCounts: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const pc = parsed[i];
      if (pc.kind !== 'count') continue;
      const mid = String(items[i]?.material_id || '').trim();
      if (!mid) continue;
      const m = db.prepare('SELECT id, category FROM raw_materials WHERE id = ?').get(mid) as
        { id: string; category?: string | null } | undefined;
      if (!m) continue;                          // per-line "Material not found"
      if (materialStoreId(db, m)) continue;      // per-line "use <store> closing"
      guardCounts.push(pc.qty);
    }
    const zeroGuard = zeroPatternGuard(guardCounts);
    if (zeroGuard.suspicious && body.confirm_zeros !== true) {
      return Response.json(
        { error: zeroGuard.message, zero_guard: { ...zeroGuard, confirm_field: 'confirm_zeros' } },
        { status: 409 },
      );
    }

    // ONE id for this whole save, stamped on every approval it raises, so the
    // monthly review can address "that upload" instead of a date range.
    const batchId = generateId();
    const batchLabel = topDeptId ? 'Closing sheet (department)' : 'Closing sheet';

    // `pending` = variances left for an admin to clear later; `applied` = variances
    // this submit already posted to stock (the admin's adjust_stock tick, or the
    // bar's auto-apply — central rows only). Every non-zero variance lands in
    // exactly one of the two. `not_counted` = blank lines, which are neither.
    const results = {
      success: 0, pending: 0, applied: 0, auto_applied: 0, not_counted: 0,
      // DEPARTMENT ROWS. `dept_anchored` counts the counts whose DEPARTMENT
      // balance moved at save time and which are therefore neither pending nor
      // reviewable — they used to be added to `pending`, which told the screen a
      // hold existed that never did. Variance-dependent, so it is blinded with
      // the rest below. `dept_immediate` is the rail-level fact (this submit
      // carried department rows at all) and is NOT variance-dependent, so it
      // stays whole for everyone: it is what lets a non-admin's screen say the
      // plain thing without answering "did my count match?".
      dept_anchored: 0, dept_immediate: false,
      alerts: 0, errors: [] as string[], total_value: 0,
      zero_guard: zeroGuard.suspicious ? { ...zeroGuard, confirmed: true } : null,
      batch_id: batchId,
    };

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

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        if (!item.material_id) continue;

        // BLANK = NOT COUNTED, and it is decided FIRST — before the material
        // lookup, before the store guard, and above all before the
        // upsert-delete. A line nobody counted is not a line: it must not
        // produce a row, must not remove the row that IS there, and must not
        // produce an error either (a blank cell on a stale material id is not
        // something to complain about). A counted 0 is not blank and falls
        // through to the normal path.
        const pc = parsed[idx];
        if (pc.kind === 'not_counted') { results.not_counted++; continue; }

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

        // Anything that was TYPED but is not a count (letters, a unit suffix, a
        // negative) is still a per-line error and still leaves the stored count
        // alone — only blanks are silent. Same rejection as before; the reason
        // is now specific instead of "Invalid physical stock".
        if (pc.kind === 'error') {
          results.errors.push(`${material.name}: ${pc.reason}`);
          continue;
        }
        const physicalStock = pc.qty;

        // THE UPSERT-DELETE RUNS ONLY AFTER THE LINE IS KNOWN GOOD. It used to
        // run before this validation, so a typo'd quantity DELETED the count
        // already stored for (date, material, department) and inserted nothing
        // in its place — the day's figure vanished and any pending approval
        // pointing at it was orphaned. Every per-line rejection above (missing
        // material, store-mapped item, bad quantity) must stay upstream of this
        // line. Same ordering as the sibling writer, ../dept-sheet.
        // dateStr, not date: `date` is the RAW body value and only dateStr —
        // what checkClosingDate() handed back — was validated. `["2026-08-09"]`
        // passes every check (String() flattens a one-element array) and then
        // throws at bind time INSIDE the transaction — a 500 and a full
        // rollback instead of a clean 400. Bind what was checked.
        delOne.run(dateStr, item.material_id, deptId);

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
        `).run(id, item.material_id, deptId, dateStr, systemStock, physicalStock, variance, varianceValue, item.notes || '', item.recorded_by || '', outletId || null,
               valued.ratePerPurchaseUnit, valued.source, valued.totalValue);

        results.total_value = r2(results.total_value + valued.totalValue);

        /* ══════════════════════════════════════════════════════════════════
         * THE ONE DOOR FROM A SAVED COUNT TO A MOVED STOCK FIGURE
         * ══════════════════════════════════════════════════════════════════
         * recordCountVariance() parks the PENDING approval and then decides,
         * against the admin's configured BAR, whether this difference is small
         * enough to apply itself:
         *   · under the bar → applied NOW, through the queue's own
         *     approveVariance() — never a second UPDATE of current_stock — so
         *     the delta, the floors, the supersede guard and the
         *     inventory_transactions log are identical to approving it a month
         *     from now.
         *   · above the bar → HELD. The count is saved and visible; the stock
         *     figure does not move until an admin approves it.
         * Bar unset (the shipped default) ⇒ nothing auto-applies and this
         * behaves exactly as it did before.
         *
         * `force_apply` is the admin's "Adjust system stock" tick, which used
         * to call approveVariance() inline here. It now goes through the same
         * function so there is ONE place a variance reaches raw_materials.
         * DEPARTMENT rows are carved out inside recordCountVariance (their
         * balance is already re-anchored by dept-ledger at save time), which is
         * why this passes `adjustStock` and not `adjustStock && !deptId` — the
         * carve-out moved into the shared rule instead of being repeated here.
         * ────────────────────────────────────────────────────────────────── */
        const decided = recordCountVariance(db, {
          source: 'central',
          material_id: item.material_id,
          department_id: deptId || '',
          date: dateStr,
          system_stock: systemStock,
          physical_stock: physicalStock,
          unit: material.unit,
          counted_by: item.recorded_by || me?.email || '',
          count_note: item.notes || '',
          outlet_id: outletId,
          batch_id: batchId,
          batch_label: batchLabel,
          pack: material,
          force_apply: adjustStock,
          applied_by: adjustStock ? (me?.email || 'admin') : undefined,
          applied_reason: adjustStock
            ? `Adjust system stock ticked on the closing sheet for ${dateStr} — approved at count time by the admin who saved the count.`
            : undefined,
        });
        if (decided.alert) results.alerts++;
        // Rail-level, not count-level: true as soon as this submit wrote a
        // department-tagged row at all, whether or not it differed from the
        // book. Set outside the `variance !== 0` block on purpose — a screen
        // must be able to say "department counts apply immediately" without
        // that sentence doubling as an answer to "did my counts match?".
        if (deptId) results.dept_immediate = true;
        if (variance !== 0) {
          // An apply that was ATTEMPTED and REFUSED (cutover floor, QC hold, a
          // newer count) must not be silent and must not cost the count: the
          // closing_stock row survives — better-sqlite3 nests approveVariance's
          // transaction as a SAVEPOINT inside ours, so its rollback unwinds only
          // its own writes — and the approval simply stays pending.
          //
          // ADMINS ONLY. The reason names the system figure's provenance and,
          // more sharply, its very presence tells a counter that their count was
          // small enough to try to auto-apply — which bisects system stock in a
          // few saves. Blind counts are load-bearing on every closing surface;
          // a non-admin's count is saved either way and there is nothing for
          // them to act on.
          if (decided.apply_error && isAdmin) {
            results.errors.push(`${material.name}: count saved, but system stock was NOT adjusted — ${decided.apply_error}`);
          }
          if (decided.outcome === 'applied') {
            results.applied++;
            if (decided.auto_applied) results.auto_applied++;
          } else if (decided.outcome === 'anchored') {
            // NOT pending. A department count re-anchored that department's
            // balance the moment the closing_stock row above was written, so
            // there is nothing parked and nothing to approve. Counting it as
            // pending is exactly the false hold this branch exists to stop.
            results.dept_anchored++;
          } else {
            results.pending++;
          }
        }

        results.success++;
      }
    });

    recordClosingStock();

    /* BLIND COUNTS ON THE WAY BACK OUT (2026-08). GET has stripped
     * system_stock/variance from non-admins since blind counts shipped; the
     * SAVE response had not caught up, and the bar makes it far sharper than it
     * was. `applied` is now a per-save answer to "was my count within ₹X of the
     * system figure?" — save one line, watch it flip between applied and
     * pending, and a handful of bisecting re-saves recovers current_stock
     * exactly. `pending` leaks the same thing in aggregate, and `alerts` leaks
     * "your count is more than N% off".
     *
     * The /closing-stock page already renders every one of these behind
     * `isAdmin` (page.tsx:1588-1589, 2684-2694) and coerces with `|| 0`, so
     * nulls change nothing on screen for anyone. `success`, `not_counted`,
     * `total_value` and `errors` stay whole: they describe what the counter
     * TYPED and what their count is worth, never what the system expected —
     * the same line GET already draws (cost data ships, variance data does not).
     * A caller must NOT render the null branch as "everything matched".
     */
    if (!isAdmin) {
      return Response.json({
        ...results,
        // dept_anchored is blinded with the rest: it only counts rows whose
        // count DIFFERED from the system figure, so leaving it whole would leak
        // the same bit `pending` does. `dept_immediate` stays — it says which
        // RAIL the save touched, never whether anything differed.
        pending: null, applied: null, auto_applied: null, alerts: null, dept_anchored: null,
      });
    }
    return Response.json(results);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
