import { getDb } from '@/lib/db';
import { getCurrentOutletId, getCurrentUser } from '@/lib/auth';
import { allowedDeptSetExpanded, canSeeAllDeptStock } from '@/lib/dept-stock';
import { toPurchaseQty, csvQty, type PackMeta } from '@/lib/pack-units';
import { todayIST } from '@/lib/format-date';

/**
 * CLOSING STOCK HISTORY — the download the owner asked for alongside the
 * all-departments upload: "keep an option to download closing stock HISTORY
 * for store manager / HOD / admin."
 *
 * GET /api/closing-stock/history?from=&to=&department_id=&format=csv|json
 *
 * ── WHY BOTH TABLES ────────────────────────────────────────────────────────
 * Raw-material counts live in `closing_stock`; semi-finished (sub-recipe)
 * counts physically CANNOT live there — that table's material_id is NOT NULL
 * with a FOREIGN KEY to raw_materials and `PRAGMA foreign_keys = ON`, so
 * sub-recipes got their own `closing_stock_semi` (see src/lib/db.ts). The
 * owner's sheet contains BOTH kinds of line, so a history that read only
 * closing_stock would understate the very sheet they filled in and silently
 * drop every chutney, paste and gravy from the day's valuation. Readers UNION
 * the two — this one does it in JS after two indexed queries, because the two
 * sides share no columns beyond qty/date and are valued on different bases.
 *
 * ── WHY THE STORED RATE, NEVER A FRESH ONE ─────────────────────────────────
 * `rate` and `value` come from the columns already ON the row
 * (closing_stock.rate_per_purchase_unit / total_value, closing_stock_semi
 * .rate / total_value). Those were computed at count time by
 * closing-valuation.ts. Re-deriving them today would restate history every
 * time a purchase price moved: last month's closing valuation would change
 * under the owner's feet between two downloads of the same date range, and a
 * report whose past changes is worthless for audit. A count is a DATED RECORD.
 * The one exception is a row written before rate capture existed — it has no
 * historical rate to honour, so it reports rate_source 'not_recorded' with a
 * NULL rate and NULL value rather than inventing a confident figure.
 *
 * ── UNITS ──────────────────────────────────────────────────────────────────
 * physical_stock is stored in RECIPE units on both tables. Per the house
 * purchase-unit rule every row LEADS with counted_purchase (via toPurchaseQty)
 * PURCHASE UNITS ONLY (owner rule, 2026-08-01). Closing stock is READ in the
 * unit the store buys in — kg / L / BTL / CASE — so the recipe columns were
 * removed from the CSV: a sheet showing 2 l beside 2000 ml invites someone to
 * total the wrong column. Storage is UNCHANGED — closing_stock.physical_stock
 * is still recipe units, and counted_recipe stays on the JSON for anything that
 * needs to reconcile against the stored figure. Only the report narrowed.
 *
 * and still carries counted_recipe — the exact stored truth — so the report
 * reads the way the owner counts while staying reconcilable to the database.
 * Sub-recipes have NO purchase unit and NO pack factor (running a yield
 * through packFactor is a category error), so their purchase columns are left
 * BLANK rather than echoing the yield figure, which would imply a conversion
 * that never happened.
 *
 * ── BLIND COUNTS ───────────────────────────────────────────────────────────
 * system_stock / variance / variance_value are deliberately NOT in this
 * payload for anyone, admin included. This is a count-and-valuation history,
 * not a variance report (/variance-approvals owns that), so there is nothing
 * to strip and no way for a non-admin to recover the system figure from it.
 *
 * ── ?view=matrix — THE COMPARISON VIEW (added 2026-08-02) ──────────────────
 * "Detailed closing stock where I can see the PREVIOUS closing stocks also."
 * The flat mode above answers "what was counted", one line per count. It
 * cannot answer "is this month's figure sane", because that question is only
 * ever answered by the SAME item's last count, and in the flat list those two
 * lines sit hundreds of rows apart. view=matrix pivots the identical
 * permission-scoped, identically-valued rows into one row per ITEM with one
 * column per COUNT DATE, newest first — so the previous count sits beside the
 * current one and the difference is a glance, not a spreadsheet exercise.
 *
 * Everything below the pivot is unchanged: same two tables, same department
 * scoping, same stored-rate valuation, same purchase-unit conversion, same
 * refusal to expose system stock or variance. `view` absent or 'flat' runs the
 * deployed code path byte for byte — this addition is purely additive.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Wording is load-bearing: the page matches /limited|authoriz/ to render its
 *  own lock notice instead of a red error (same contract as ../dept-sheet). */
const NO_SCOPE =
  'Closing stock history is limited to admins, managers, HODs and store managers — or to staff with a department assigned.';

/** Counts may be tagged with the current outlet, or left NULL/'' by pre-outlet
 *  writes + backfills — both must still show up. Same clause as ../dept-sheet. */
const OUTLET_SCOPE_CS  = `(cs.outlet_id = ? OR COALESCE(cs.outlet_id,'') = '')`;
const OUTLET_SCOPE_CSS = `(css.outlet_id = ? OR COALESCE(css.outlet_id,'') = '')`;

/** The Store / Overall bucket: closing rows with no department_id. */
const STORE_KEY = '__store__';
const STORE_LABEL = 'Store / Overall';

/** A silently truncated export is a WRONG report — the reader cannot tell a
 *  missing week from a week nobody counted. Cap the work, then say so. */
const ROW_CAP = 50000;

/* ── matrix caps ───────────────────────────────────────────────────────────
 * A matrix grows in TWO directions, so it needs two caps. Two years of daily
 * counts is ~730 columns: no screen shows it and Excel users cannot read it
 * sideways, so the columns stop at the newest DATE_CAP count dates. The rows
 * stop at MATRIX_ITEM_CAP items. CELL_CAP bounds the fetch itself — items ×
 * dates is a product, and an outlet with 5,000 items over 60 counts is
 * 300,000 rows that must not be built in memory to then be thrown away. */
const DATE_CAP = 60;
const MATRIX_ITEM_CAP = 20000;
const CELL_CAP = 120000;

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: unknown) => Number(v) || 0;

export interface HistoryRow {
  date: string;
  department: string;
  material: string;
  sku: string;
  category: string;
  /** Blank for SUB rows — a sub-recipe has no purchase unit. */
  purchase_unit: string;
  /** Derived display figure; NULL for SUB rows. Never sum across materials. */
  counted_purchase: number | null;
  recipe_unit: string;
  /** The stored truth, exactly as written at count time. */
  counted_recipe: number;
  /** RAW: ₹ per purchase unit. SUB: ₹ per yield unit. NULL when unpriced. */
  rate: number | null;
  rate_source: string;
  /** ₹, as stored at count time. NULL when the row has no rate basis. */
  value: number | null;
  recorded_by: string;
  type: 'RAW' | 'SUB';
}

interface RawCountRow {
  date: string;
  department: string | null;
  material: string;
  sku: string | null;
  category: string | null;
  unit: string | null;
  purchase_unit: string | null;
  pack_size: number | null;
  physical_stock: number;
  rate_per_purchase_unit: number | null;
  rate_source: string | null;
  total_value: number | null;
  recorded_by: string | null;
}

interface SemiCountRow {
  date: string;
  department: string | null;
  material: string;
  category: string | null;
  unit: string | null;
  yield_unit: string | null;
  physical_stock: number;
  rate: number | null;
  total_value: number | null;
  recorded_by: string | null;
}

/** One counted cell. A cell that EXISTS means somebody counted that item on
 *  that date; qty 0 means they counted it and found nothing. */
export interface MatrixCell {
  /** PURCHASE units for RAW (toPurchaseQty); the counted yield for SUB. */
  qty: number;
  /** ₹ as stored at count time. NULL when the row was never priced. */
  value: number | null;
  rate: number | null;
}

export interface MatrixRow {
  /** type + id + department — the only safe row identity, see below. */
  key: string;
  material_id: string | null;
  sub_recipe_id: string | null;
  type: 'RAW' | 'SUB';
  material: string;
  sku: string;
  category: string;
  department: string;
  department_id: string;
  /** The unit the qty column is in, so the page never has to guess. */
  purchase_unit: string;
  /**
   * One entry per date column, ALWAYS present.
   *   null  = NOT COUNTED — nobody looked at this item that day.
   *   {qty:0} = COUNTED ZERO — somebody looked and the shelf was empty.
   * These are different facts and collapsing them (0 for both, or blank for
   * both) is the single most dangerous thing this view could do: it would tell
   * the owner an item ran out on a day nobody counted it, or that a genuinely
   * empty shelf was simply skipped. Comparing to the previous count is the
   * whole point of the view, and a comparison against an invented zero is
   * worse than no comparison at all.
   */
  counts: Record<string, MatrixCell | null>;
  latest_date: string | null;
  previous_date: string | null;
  latest_qty: number | null;
  previous_qty: number | null;
  change_qty: number | null;
  /** NULL when previous_qty is 0 — a division by zero is not "infinite
   *  growth", it is unknown, and printing ∞ or 100% would be a fabrication. */
  change_pct: number | null;
  latest_value: number | null;
}

interface RawMatrixRow {
  date: string;
  material_id: string;
  department_id: string | null;
  department: string | null;
  material: string;
  sku: string | null;
  category: string | null;
  unit: string | null;
  purchase_unit: string | null;
  pack_size: number | null;
  physical_stock: number;
  rate_per_purchase_unit: number | null;
  rate_source: string | null;
  total_value: number | null;
}

interface SemiMatrixRow {
  date: string;
  sub_recipe_id: string;
  department_id: string | null;
  department: string | null;
  material: string;
  category: string | null;
  unit: string | null;
  yield_unit: string | null;
  physical_stock: number;
  rate: number | null;
  total_value: number | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Shift a YYYY-MM-DD IST date by whole days. Pure UTC arithmetic on the date
 *  PARTS, so no timezone offset can ever push the result onto the wrong day —
 *  the bug new Date(iso).setDate() produces for IST users near midnight. */
function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** Item names on this database contain commas ("MAIDA, REFINED"), quotes and
 *  the occasional newline from a paste. Quote-and-double is the only safe form. */
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** `%`, `_` and `\` are LIKE metacharacters. An item search for "50%" must
 *  match the literal text, not "50 followed by anything". */
function likeTerm(q: string): string {
  return '%' + q.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/**
 * Drop the trailing partial group after a LIMIT bit. The fetch is ordered so
 * every count of one item is contiguous; if the cap cut through the middle of
 * an item, the dates past the cut are MISSING, and a half-filled row is
 * indistinguishable from an item that genuinely was not counted on those dates
 * — the exact confusion this view exists to remove. So the partial item leaves
 * entirely and `truncated` says the range held more. Returns true if it bit.
 */
function trimPartialGroup<T>(rows: T[], cap: number, keyOf: (r: T) => string): boolean {
  if (rows.length <= cap) return false;
  const lastKey = keyOf(rows[rows.length - 1]);
  let end = rows.length;
  while (end > 0 && keyOf(rows[end - 1]) === lastKey) end--;
  rows.length = end;
  return true;
}

export async function GET(request: Request) {
  try {
    const db = getDb();
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Not authorized.' }, { status: 401 });

    // Same privilege predicate the department-stock surfaces use: admin,
    // manager, HOD (is_head_chef) and store manager see every department.
    const seesAll = canSeeAllDeptStock(me);
    // Everyone else is scoped to their own department plus explicitly granted
    // visible departments, each expanded to its sub-departments.
    const allowed = seesAll ? null : new Set(allowedDeptSetExpanded(db, me));
    if (allowed && allowed.size === 0) {
      return Response.json({ error: NO_SCOPE }, { status: 403 });
    }

    const url = new URL(request.url);
    const format = (url.searchParams.get('format') || 'json').toLowerCase() === 'csv' ? 'csv' : 'json';
    const deptParam = (url.searchParams.get('department_id') || '').trim();
    // Anything that is not exactly 'matrix' stays on the deployed flat path —
    // a typo must never silently change the shape of a live download.
    const view = (url.searchParams.get('view') || '').trim().toLowerCase() === 'matrix' ? 'matrix' : 'flat';
    const q = (url.searchParams.get('q') || '').trim();

    const today = todayIST();
    // The matrix defaults WIDER than the flat list on purpose: its job is to
    // put the previous count beside the current one, and on a monthly counting
    // cycle a 30-day window holds exactly one count — nothing to compare with.
    let from = (url.searchParams.get('from') || '').trim() || shiftIsoDate(today, view === 'matrix' ? -180 : -30);
    let to = (url.searchParams.get('to') || '').trim() || today;
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
      return Response.json({ error: 'from and to must be dates in YYYY-MM-DD form.' }, { status: 400 });
    }
    // An inverted range would match nothing, and an empty result reads as
    // "no counts were taken" — the one lie this report must not tell. Swap.
    if (from > to) { const t = from; from = to; to = t; }

    // A department the caller may not read is a 403, NOT an empty list. An
    // empty list is indistinguishable from "that department counted nothing",
    // so scoping must fail loudly or the reader draws the wrong conclusion.
    if (deptParam) {
      if (deptParam === STORE_KEY) {
        // Store / Overall counts belong to no department, so a department-scoped
        // user has no grant that could cover them.
        if (!seesAll) return Response.json({ error: NO_SCOPE }, { status: 403 });
      } else if (allowed && !allowed.has(deptParam)) {
        return Response.json({ error: NO_SCOPE }, { status: 403 });
      }
    }

    const outletId = await getCurrentOutletId();

    // Department predicate, built once and applied to BOTH tables so the raw
    // and semi halves of a sheet can never disagree about who may see them.
    // Filtering is EXACT (no parent roll-up): a count belongs to exactly one
    // department — the same rule ../dept-sheet enforces on write — and rolling
    // a main dept up would double-count nothing but would silently widen the
    // scope the caller asked for.
    const deptParams: string[] = [];
    let deptClause = '';
    if (deptParam === STORE_KEY) {
      deptClause = `AND COALESCE(%A%.department_id,'') = ''`;
    } else if (deptParam) {
      deptClause = `AND COALESCE(%A%.department_id,'') = ?`;
      deptParams.push(deptParam);
    } else if (allowed) {
      deptClause = `AND COALESCE(%A%.department_id,'') IN (SELECT value FROM json_each(?))`;
      deptParams.push(JSON.stringify([...allowed]));
    }
    const deptFor = (alias: string) => deptClause.replace(/%A%/g, alias);

    /* ════════════════════════════════════════════════════════════════════════
     * MATRIX VIEW — one row per item, one column per count date.
     * Deliberately placed AFTER the auth, date, department-scope and outlet
     * work above so it shares that code exactly: two views of the same history
     * that disagreed about who may see which department would be a permission
     * bug wearing a report's clothes.
     * ══════════════════════════════════════════════════════════════════════ */
    // HOISTED ABOVE THE VIEW SPLIT. These were built inside the matrix branch,
    // so the flat queries carried no name/SKU/category predicate at all — the
    // page shows ONE search box for both views and sends `q` for both, so a
    // manager typing "PANEER" in "All entries" got every row in the range back,
    // under a footer that said "filtered view". A search that silently matches
    // everything is worse than one that errors: the reader believes the list.
      const qRawParams: string[] = [];
      const qSemiParams: string[] = [];
      let qRaw = '';
      let qSemi = '';
      if (q) {
        const t = likeTerm(q);
        qRaw = `AND (LOWER(rm.name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(rm.sku,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(rm.category,'')) LIKE ? ESCAPE '\\')`;
        qRawParams.push(t, t, t);
        qSemi = `AND (LOWER(sr.name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(sr.category,'')) LIKE ? ESCAPE '\\')`;
        qSemiParams.push(t, t);
      }

    if (view === 'matrix') {
      // Free-text filter on item / SKU / category. Applied in SQL, not after
      // the fetch, so the caps below count the rows the user actually asked
      // for instead of being spent on rows about to be filtered away.
      // ── STEP 1: which dates are columns? ──────────────────────────────────
      // The columns are the dates a count ACTUALLY HAPPENED on, not every day
      // in the range: a calendar grid of mostly-empty columns buries the two
      // counts the owner came to compare. Each side is capped at DATE_CAP+1,
      // so the union's newest DATE_CAP dates are still exactly right.
      const rawDates = db.prepare(`
        SELECT DISTINCT cs.date AS date
          FROM closing_stock cs
          JOIN raw_materials rm ON rm.id = cs.material_id
         WHERE cs.date >= ? AND cs.date <= ?
           AND ${OUTLET_SCOPE_CS}
           ${deptFor('cs')}
           ${qRaw}
         ORDER BY cs.date DESC
         LIMIT ${DATE_CAP + 1}
      `).all(from, to, outletId, ...deptParams, ...qRawParams) as { date: string }[];

      const semiDates = db.prepare(`
        SELECT DISTINCT css.date AS date
          FROM closing_stock_semi css
          JOIN sub_recipes sr ON sr.id = css.sub_recipe_id
         WHERE css.date >= ? AND css.date <= ?
           AND ${OUTLET_SCOPE_CSS}
           ${deptFor('css')}
           ${qSemi}
         ORDER BY css.date DESC
         LIMIT ${DATE_CAP + 1}
      `).all(from, to, outletId, ...deptParams, ...qSemiParams) as { date: string }[];

      const dateSet = new Set<string>();
      for (const d of rawDates) dateSet.add(d.date);
      for (const d of semiDates) dateSet.add(d.date);
      // ISO dates sort lexically; reverse = NEWEST FIRST, the order the
      // contract promises and the order the page renders columns in.
      const allDates = [...dateSet].sort().reverse();
      let truncated = allDates.length > DATE_CAP;
      const dates = allDates.slice(0, DATE_CAP);
      const datesJson = JSON.stringify(dates);
      // Bound the scan by the kept window too — json_each alone gives SQLite
      // nothing to use the date index with.
      const minDate = dates.length ? dates[dates.length - 1] : from;
      const maxDate = dates.length ? dates[0] : to;

      // ── STEP 2: every count on those dates ────────────────────────────────
      // ORDER BY keeps one item's counts contiguous (so a cap can be trimmed
      // back to whole items) and puts each cell's duplicates in write order,
      // oldest first — the writers delete-then-insert per (date, material,
      // department), so if two rows for one cell ever survive, the LAST write
      // is the count that stands. A sum would double it.
      const rawCells = db.prepare(`
        SELECT cs.date                                            AS date,
               cs.material_id                                     AS material_id,
               COALESCE(cs.department_id,'')                      AS department_id,
               d.name                                             AS department,
               rm.name                                            AS material,
               rm.sku                                             AS sku,
               rm.category                                        AS category,
               rm.unit                                            AS unit,
               COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS purchase_unit,
               rm.pack_size                                       AS pack_size,
               cs.physical_stock                                  AS physical_stock,
               cs.rate_per_purchase_unit                          AS rate_per_purchase_unit,
               cs.rate_source                                     AS rate_source,
               cs.total_value                                     AS total_value
          FROM closing_stock cs
          JOIN raw_materials rm ON rm.id = cs.material_id
          LEFT JOIN departments d ON d.id = cs.department_id
         WHERE cs.date IN (SELECT value FROM json_each(?))
           AND cs.date >= ? AND cs.date <= ?
           AND ${OUTLET_SCOPE_CS}
           ${deptFor('cs')}
           ${qRaw}
         ORDER BY COALESCE(cs.department_id,''), cs.material_id, cs.date, cs.created_at
         LIMIT ${CELL_CAP + 1}
      `).all(datesJson, minDate, maxDate, outletId, ...deptParams, ...qRawParams) as RawMatrixRow[];

      const semiCells = db.prepare(`
        SELECT css.date                                           AS date,
               css.sub_recipe_id                                  AS sub_recipe_id,
               COALESCE(css.department_id,'')                     AS department_id,
               d.name                                             AS department,
               sr.name                                            AS material,
               COALESCE(NULLIF(TRIM(sr.category),''), 'sub-recipe') AS category,
               css.unit                                           AS unit,
               sr.yield_unit                                      AS yield_unit,
               css.physical_stock                                 AS physical_stock,
               css.rate                                           AS rate,
               css.total_value                                    AS total_value
          FROM closing_stock_semi css
          JOIN sub_recipes sr ON sr.id = css.sub_recipe_id
          LEFT JOIN departments d ON d.id = css.department_id
         WHERE css.date IN (SELECT value FROM json_each(?))
           AND css.date >= ? AND css.date <= ?
           AND ${OUTLET_SCOPE_CSS}
           ${deptFor('css')}
           ${qSemi}
         ORDER BY COALESCE(css.department_id,''), css.sub_recipe_id, css.date, css.created_at
         LIMIT ${CELL_CAP + 1}
      `).all(datesJson, minDate, maxDate, outletId, ...deptParams, ...qSemiParams) as SemiMatrixRow[];

      if (trimPartialGroup(rawCells, CELL_CAP, (r) => `${r.department_id}|${r.material_id}`)) truncated = true;
      if (trimPartialGroup(semiCells, CELL_CAP, (s) => `${s.department_id}|${s.sub_recipe_id}`)) truncated = true;

      // ── STEP 3: pivot ─────────────────────────────────────────────────────
      // Identity is type + id + department, NEVER the name. A raw material and
      // a sub-recipe can both be called "GINGER GARLIC PASTE" (one bought, one
      // made) and the same material is counted separately by each department:
      // key on the name and those become one row whose columns interleave two
      // different things — a comparison of an item against something else.
      const byKey = new Map<string, MatrixRow>();
      const blank = (): Record<string, MatrixCell | null> => {
        // Every date key is written up front so a missing count is an explicit
        // null the page can render as "not counted", not an absent property
        // that reads as undefined and gets styled like a zero.
        const o: Record<string, MatrixCell | null> = {};
        for (const d of dates) o[d] = null;
        return o;
      };

      for (const r of rawCells) {
        const key = `RAW|${r.material_id}|${r.department_id}`;
        let row = byKey.get(key);
        if (!row) {
          row = {
            key,
            material_id: r.material_id,
            sub_recipe_id: null,
            type: 'RAW',
            material: r.material,
            sku: r.sku || '',
            category: r.category || '',
            department: r.department || STORE_LABEL,
            department_id: r.department_id || '',
            purchase_unit: r.purchase_unit || r.unit || '',
            counts: blank(),
            latest_date: null, previous_date: null,
            latest_qty: null, previous_qty: null,
            change_qty: null, change_pct: null, latest_value: null,
          };
          byKey.set(key, row);
        }
        // PURCHASE units, always, via the shared helper — packFactor carries
        // both halves of the guard (pack_size > 1 AND unit !== purchase_unit),
        // so kg/kg items like PICKLED GINGER 1.5KG are left alone. Never
        // divide by pack_size here.
        const meta: PackMeta = { unit: r.unit, purchase_unit: r.purchase_unit, pack_size: r.pack_size };
        // Stored rate only — see the header. Re-deriving would restate the
        // previous column every time a price moved, which is precisely the
        // column the owner is comparing against.
        const hasStoredRate = r.rate_per_purchase_unit != null;
        const priced = hasStoredRate && String(r.rate_source || 'none') !== 'none';
        row.counts[r.date] = {
          qty: toPurchaseQty(num(r.physical_stock), meta),
          value: priced ? r2(num(r.total_value)) : null,
          rate: priced ? r2(num(r.rate_per_purchase_unit)) : null,
        };
      }

      for (const s of semiCells) {
        const key = `SUB|${s.sub_recipe_id}|${s.department_id}`;
        let row = byKey.get(key);
        if (!row) {
          row = {
            key,
            material_id: null,
            sub_recipe_id: s.sub_recipe_id,
            type: 'SUB',
            material: s.material,
            sku: '',
            category: s.category || 'sub-recipe',
            department: s.department || STORE_LABEL,
            department_id: s.department_id || '',
            purchase_unit: '',
            counts: blank(),
            latest_date: null, previous_date: null,
            latest_qty: null, previous_qty: null,
            change_qty: null, change_pct: null, latest_value: null,
          };
          byKey.set(key, row);
        }
        // A sub-recipe has NO purchase unit and NO pack factor — running a
        // yield through packFactor is a category error. It is counted in its
        // own yield unit, so the figure goes in the quantity column AS STORED
        // and the unit column names that yield unit. Rows arrive oldest-first
        // within a group, so this ends holding the newest count's snapshot.
        const unit = String(s.unit || '').trim() || String(s.yield_unit || '').trim();
        row.purchase_unit = unit;
        const priced = num(s.rate) > 0 || num(s.total_value) > 0;
        row.counts[s.date] = {
          qty: num(s.physical_stock),
          value: priced ? r2(num(s.total_value)) : null,
          rate: priced ? r2(num(s.rate)) : null,
        };
      }

      const mrows = [...byKey.values()].sort((a, b) =>
        a.department.localeCompare(b.department) ||
        a.material.localeCompare(b.material) ||
        a.type.localeCompare(b.type));

      if (mrows.length > MATRIX_ITEM_CAP) { mrows.length = MATRIX_ITEM_CAP; truncated = true; }

      // ── STEP 4: latest vs previous ────────────────────────────────────────
      // The two most recent dates THIS item was actually counted on — not the
      // two newest columns. An item skipped in last month's count would
      // otherwise be compared against a blank and report its whole stock as
      // the change. Totals are computed here, after truncation, so the figures
      // always describe exactly the rows the reader can see.
      const totals_by_date: Record<string, { lines: number; value: number }> = {};
      for (const d of dates) totals_by_date[d] = { lines: 0, value: 0 };

      for (const row of mrows) {
        const counted: string[] = [];
        for (const d of dates) {            // dates is newest-first
          const c = row.counts[d];
          if (!c) continue;
          counted.push(d);
          const t = totals_by_date[d];
          t.lines += 1;
          if (c.value != null) t.value += c.value;
        }
        const d0 = counted[0] ?? null;
        const d1 = counted[1] ?? null;
        row.latest_date = d0;
        row.previous_date = d1;
        row.latest_qty = d0 ? row.counts[d0]!.qty : null;
        row.previous_qty = d1 ? row.counts[d1]!.qty : null;
        row.latest_value = d0 ? row.counts[d0]!.value : null;
        if (row.latest_qty != null && row.previous_qty != null) {
          // 3 dp, the same precision the two quantities carry (toPurchaseQty
          // rounds to 3). Rounding the difference to 2 would make a real
          // 0.005 L movement print as a change of 0.01 against quantities
          // that both end in ...5 — a difference the columns don't show.
          row.change_qty = csvQty(row.latest_qty - row.previous_qty);
          // Against a previous count of zero there is no percentage to state:
          // 0 → 5 is not "500% up", it is "was zero". Leave it unknown and let
          // the page print an em-dash rather than invent a number.
          row.change_pct = row.previous_qty === 0
            ? null
            : r2((row.change_qty / Math.abs(row.previous_qty)) * 100);
        }
      }
      for (const d of dates) totals_by_date[d].value = r2(totals_by_date[d].value);

      const mnote = truncated
        ? `Showing ${mrows.length.toLocaleString('en-IN')} items across the newest ${dates.length} count ${dates.length === 1 ? 'date' : 'dates'} — the range holds more. Narrow the dates, pick one department, or search for an item to see the rest.`
        : null;

      if (format === 'csv') {
        // One column per date, newest first — the same left-to-right reading
        // order as the screen, so a printed sheet and the page agree.
        const headers = [
          'Department', 'Item', 'SKU', 'Category', 'Type', 'Unit',
          ...dates,
          'Change vs Previous', 'Change %', 'Latest Value (INR)',
        ];
        const lines = [headers.map(csvEscape).join(',')];
        for (const row of mrows) {
          const cells = dates.map((d) => {
            const c = row.counts[d];
            // BLANK = not counted, '0' = counted and empty. Excel shows the
            // difference plainly, and a reader totalling a column will not
            // silently add zeros for days nobody counted.
            return c ? String(csvQty(c.qty)) : '';
          });
          lines.push([
            csvEscape(row.department),
            csvEscape(row.material),
            csvEscape(row.sku),
            csvEscape(row.category),
            row.type,
            csvEscape(row.purchase_unit),
            ...cells,
            row.change_qty == null ? '' : csvQty(row.change_qty),
            row.change_pct == null ? '' : row.change_pct,
            row.latest_value == null ? '' : row.latest_value,
          ].join(','));
        }
        // Per-date footers. Quantities are NEVER totalled across materials
        // (2 BTL + 3 kg is meaningless), so the count columns carry the number
        // of items counted and the ₹ total sits on its own labelled line.
        const pad = ['', '', '', '', ''];
        lines.push('');
        lines.push(['Items counted', ...pad, ...dates.map((d) => totals_by_date[d].lines), '', '', ''].join(','));
        lines.push(['Value counted (INR)', ...pad, ...dates.map((d) => totals_by_date[d].value), '', '', ''].join(','));
        if (truncated) lines.push('', csvEscape(`TRUNCATED: ${mnote}`));
        // UTF-8 BOM — without it Excel on Windows reads the file as ANSI and
        // mangles Indian item names and the ₹ sign.
        const csv = '﻿' + lines.join('\n');
        return new Response(csv, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="closing-stock-matrix-${from}_${to}.csv"`,
            'Cache-Control': 'no-store',
            ...(truncated ? { 'X-Truncated': '1' } : {}),
          },
        });
      }

      return Response.json({
        mode: 'matrix',
        from, to,
        scope: seesAll ? 'all' : 'limited',
        dates,
        rows: mrows,
        totals_by_date,
        cap: MATRIX_ITEM_CAP,
        date_cap: DATE_CAP,
        truncated,
        note: mnote,
        generated_at: new Date().toISOString(),
      });
    }

    // LIMIT cap+1: the extra row is how we detect that the cap bit, without a
    // second COUNT(*) over the same range.
    const lim = ROW_CAP + 1;

    const rawRows = db.prepare(`
      SELECT cs.date                                            AS date,
             d.name                                             AS department,
             rm.name                                            AS material,
             rm.sku                                             AS sku,
             rm.category                                        AS category,
             rm.unit                                            AS unit,
             COALESCE(NULLIF(TRIM(rm.purchase_unit),''), rm.unit) AS purchase_unit,
             rm.pack_size                                       AS pack_size,
             cs.physical_stock                                  AS physical_stock,
             cs.rate_per_purchase_unit                          AS rate_per_purchase_unit,
             cs.rate_source                                     AS rate_source,
             cs.total_value                                     AS total_value,
             cs.recorded_by                                     AS recorded_by
        FROM closing_stock cs
        JOIN raw_materials rm ON rm.id = cs.material_id
        LEFT JOIN departments d ON d.id = cs.department_id
       WHERE cs.date >= ? AND cs.date <= ?
         AND ${OUTLET_SCOPE_CS}
         ${deptFor('cs')}
         ${qRaw}
       ORDER BY cs.date DESC, COALESCE(d.name,''), rm.name
       LIMIT ${lim}
    `).all(from, to, outletId, ...deptParams, ...qRawParams) as RawCountRow[];

    const semiRows = db.prepare(`
      SELECT css.date                                           AS date,
             d.name                                             AS department,
             sr.name                                            AS material,
             COALESCE(NULLIF(TRIM(sr.category),''), 'sub-recipe') AS category,
             css.unit                                           AS unit,
             sr.yield_unit                                      AS yield_unit,
             css.physical_stock                                 AS physical_stock,
             css.rate                                           AS rate,
             css.total_value                                    AS total_value,
             css.recorded_by                                    AS recorded_by
        FROM closing_stock_semi css
        JOIN sub_recipes sr ON sr.id = css.sub_recipe_id
        LEFT JOIN departments d ON d.id = css.department_id
       WHERE css.date >= ? AND css.date <= ?
         AND ${OUTLET_SCOPE_CSS}
         ${deptFor('css')}
         ${qSemi}
       ORDER BY css.date DESC, COALESCE(d.name,''), sr.name
       LIMIT ${lim}
    `).all(from, to, outletId, ...deptParams, ...qSemiParams) as SemiCountRow[];

    const rows: HistoryRow[] = [];

    for (const r of rawRows) {
      const meta: PackMeta = {
        unit: r.unit, purchase_unit: r.purchase_unit, pack_size: r.pack_size,
      };
      const recipeQty = num(r.physical_stock);
      // Stored rate ONLY. A NULL rate column means the row predates rate
      // capture: there is no historical figure to honour, and today's price is
      // not history, so it stays unpriced and says why.
      const hasStoredRate = r.rate_per_purchase_unit != null;
      const source = hasStoredRate ? String(r.rate_source || 'none') : 'not_recorded';
      // 'none' = no basis existed at count time; the row is genuinely unpriced.
      const priced = hasStoredRate && source !== 'none';
      rows.push({
        date: r.date,
        department: r.department || STORE_LABEL,
        material: r.material,
        sku: r.sku || '',
        category: r.category || '',
        purchase_unit: r.purchase_unit || r.unit || '',
        counted_purchase: toPurchaseQty(recipeQty, meta),
        recipe_unit: r.unit || '',
        counted_recipe: recipeQty,
        rate: priced ? r2(num(r.rate_per_purchase_unit)) : null,
        rate_source: source,
        value: priced ? r2(num(r.total_value)) : null,
        recorded_by: r.recorded_by || '',
        type: 'RAW',
      });
    }

    for (const s of semiRows) {
      // The unit snapshot taken at count time wins over the sub-recipe's
      // CURRENT yield_unit — the same dated-record principle as the rate.
      const unit = String(s.unit || '').trim() || String(s.yield_unit || '').trim();
      const priced = num(s.rate) > 0 || num(s.total_value) > 0;
      rows.push({
        date: s.date,
        department: s.department || STORE_LABEL,
        material: s.material,
        sku: '',
        category: s.category || 'sub-recipe',
        // A sub-recipe has no purchase unit and no pack factor — it is counted
        // in its own yield unit, which IS the unit it is handled in. So the
        // yield figure goes in the single quantity column rather than being
        // left blank: since the report narrowed to purchase units only, a blank
        // here meant a SUB row listed the item with NO quantity at all, which
        // is worse than useless in a stock history. No conversion is implied —
        // the unit column says kg, and kg is exactly what was counted.
        purchase_unit: unit,
        counted_purchase: num(s.physical_stock),
        recipe_unit: unit,
        counted_recipe: num(s.physical_stock),
        rate: priced ? r2(num(s.rate)) : null,
        rate_source: priced ? 'sub_recipe_cost' : 'none',
        value: priced ? r2(num(s.total_value)) : null,
        recorded_by: s.recorded_by || '',
        type: 'SUB',
      });
    }

    // Newest day first, then department, then item — the order the two halves
    // were each fetched in, re-applied across the merged set.
    rows.sort((a, b) =>
      (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
      a.department.localeCompare(b.department) ||
      a.material.localeCompare(b.material));

    const truncated = rows.length > ROW_CAP;
    if (truncated) rows.length = ROW_CAP;

    // Only ₹ may be summed across materials — never quantities (2 BTL + 3 kg
    // is meaningless). Unpriced rows contribute nothing and are counted apart
    // by the caller via rate_source.
    let value = 0;
    for (const r of rows) if (r.value != null) value += r.value;
    const totals = { count: rows.length, value: r2(value) };

    const note = truncated
      ? `Showing the first ${ROW_CAP.toLocaleString('en-IN')} rows — the range holds more. Narrow the dates or pick one department to see the rest.`
      : null;

    if (format === 'csv') {
      const headers = [
        'Date', 'Department', 'Item', 'SKU', 'Category',
        'Purchase Unit', 'Counted (purchase)',
        'Rate', 'Rate Source', 'Value (INR)', 'Recorded By', 'Type',
      ];
      const lines = [headers.join(',')];
      for (const r of rows) {
        lines.push([
          csvEscape(r.date),
          csvEscape(r.department),
          csvEscape(r.material),
          csvEscape(r.sku),
          csvEscape(r.category),
          csvEscape(r.purchase_unit),
          // csvQty, never toLocaleString: locale grouping ("1,500") would put a
          // comma inside a number cell and shift every column after it.
          r.counted_purchase == null ? '' : csvQty(r.counted_purchase),
          r.rate == null ? '' : r.rate,
          csvEscape(r.rate_source),
          r.value == null ? '' : r.value,
          csvEscape(r.recorded_by),
          r.type,
        ].join(','));
      }
      // The truncation warning must survive into the file itself — someone will
      // read the CSV without ever seeing the API response.
      if (truncated) lines.push('', csvEscape(`TRUNCATED: ${note}`));
      // UTF-8 BOM: without it Excel on Windows reads the file as ANSI and
      // mangles Indian item names (Telugu/Hindi text and the ₹ sign).
      const csv = '﻿' + lines.join('\n');
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="closing-stock-history-${from}_${to}.csv"`,
          'Cache-Control': 'no-store',
          ...(truncated ? { 'X-Truncated': '1' } : {}),
        },
      });
    }

    return Response.json({
      from, to,
      scope: seesAll ? 'all' : 'limited',
      rows,
      totals,
      cap: ROW_CAP,
      truncated,
      note,
      generated_at: new Date().toISOString(),
    });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error)?.message || 'Failed' }, { status: 500 });
  }
}
