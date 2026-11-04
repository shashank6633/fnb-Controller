import { getDb } from '@/lib/db';
import { getCurrentOutletId, getCurrentUser } from '@/lib/auth';
import { allowedDeptSetExpanded, canSeeAllDeptStock } from '@/lib/dept-stock';
import { toPurchaseQty, csvQty, type PackMeta } from '@/lib/pack-units';
import { todayIST } from '@/lib/format-date';
import { isStoreMappedMaterial } from '@/lib/store-engine';
import { bydeptCsv, bydeptCsvFilename } from '@/lib/closing-bydept-csv';
import {
  CLOSING_GST_PCT_CSV, CLOSING_GST_SOURCE_CSV, CLOSING_INCL_CSV, CLOSING_TAX_CSV, SEMI_GST,
  addClosingTaxTotals, closingTaxCells, closingTaxCsv, createClosingGstResolver, storedCountValue, sumClosingTax,
  type ClosingGstSource, type ClosingTaxSummable, type ClosingTaxTotals,
} from '@/lib/closing-tax';

/**
 * CLOSING STOCK HISTORY — the download the owner asked for alongside the
 * all-departments upload: "keep an option to download closing stock HISTORY
 * for store manager / HOD / admin."
 *
 * GET /api/closing-stock/history?from=&to=&department_id=&format=csv|json
 *     &gst=1  (flat view only) add the estimated-GST fields / CSV columns —
 *             see HistoryRow and src/lib/closing-tax.ts. Opt-in on purpose.
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
 *
 * ── ?view=bydept&date= — STORE vs DEPARTMENTS (owner ruling 99, 2026-11-01) ─
 * ONE date. One row per ITEM, one column per place that counted it that day:
 * "Store / Overall" (rows with no department_id — STORE_KEY) first, then every
 * department that counted on that date, GROUPED under its main department
 * (departments.parent_id; a department with no parent files under itself, as
 * on the Dept Closing Sheet), then a Total. Raw materials and semi-finished
 * (closing_stock_semi) come back as two separate blocks with the SAME columns,
 * each with its own ₹ totals per column, plus the two added together.
 *
 * Built on the matrix's own pieces, not beside them: the same SELECT lists and
 * row types, the same toPurchaseQty conversion, the same stored-value rule
 * (never re-priced), the same last-write-wins on a duplicated cell, the same
 * ROW_CAP + whole-item trim, and the same auth / department scope / outlet /
 * search predicates above. `date` absent = the newest count date in scope.
 * Still NO system stock and NO variance. Both tables are read in ONE request
 * that answers whole or fails whole — never a raw-less or semi-less sheet
 * (the 31-Oct report: a history that read zero when one half failed).
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
  /* ── ESTIMATED GST (owner #4, rulings #77/#78/#81 — src/lib/closing-tax.ts).
   * Flat view, and ONLY when the caller asks with `gst=1` (Closing History &
   * Compare does; the Dept Closing Sheet's "Download history" does not, so
   * its file stays exactly as it was — ruling #81). Absent otherwise. The
   * matrix is unchanged. Same visibility as `value`. ── */
  /** GST % at this row's COUNT DATE; null = BLANK (never 0). Always null on SUB rows. */
  gst_pct?: number | null;
  gst_source?: ClosingGstSource;
  /** "last bill with GST 12 Oct 2026" / "Master GST %" / "no GST rate on record" / … */
  gst_note?: string;
  gst_title?: string;
  /** value × gst_pct ÷ 100; null when there is no rate or no value. */
  tax?: number | null;
  /** value + tax; null when tax is null. */
  total_incl_tax?: number | null;
}

interface RawCountRow {
  material_id: string;
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

/* ── view=bydept wire shapes ─────────────────────────────────────────────── */

/** One column of the Store vs Departments sheet. */
export interface BydeptColumn {
  /** STORE_KEY for Store / Overall, otherwise the department id. */
  key: string;
  name: string;
  /** The heading this column files under: its main department, or itself. */
  group_key: string;
  group: string;
  is_store: boolean;
  /** The main department's OWN count (a department with no parent). */
  is_main: boolean;
  is_active: boolean;
  /** False only for the Store column on a day the store did not count. Every
   *  department column exists BECAUSE that department counted on the date. */
  counted: boolean;
}

/** A counted cell — the matrix cell plus the unit it was counted in, because
 *  a SUB row's unit is the count-time snapshot and is read per row written. */
export interface BydeptCell extends MatrixCell {
  unit: string;
}

export interface BydeptRow {
  /** type + id — one row per ITEM; the department is the column. */
  key: string;
  material_id: string | null;
  sub_recipe_id: string | null;
  type: 'RAW' | 'SUB';
  material: string;
  sku: string;
  category: string;
  /** PURCHASE unit for RAW; the counted yield unit for SUB. */
  purchase_unit: string;
  /** Every column key present. null = NOT COUNTED there; {qty:0} = COUNTED
   *  ZERO — the same two different facts the matrix keeps apart. */
  cells: Record<string, BydeptCell | null>;
  /** Σ of the counted cells, in the row's one unit (same material, same unit,
   *  so this sum is meaningful — unlike any sum ACROSS items). NULL only when a
   *  SUB row's cells were counted in different units. */
  total_qty: number | null;
  /** Σ of the stored values of the counted cells; NULL when none was priced. */
  total_value: number | null;
  /** How many columns counted this item. */
  counted_in: number;
  /** Counted cells with no stored value (they add nothing to total_value). */
  unpriced: number;
  mixed_units: boolean;
}

export interface BydeptTotal { lines: number; value: number; unpriced: number }

export interface BydeptBlockTotals {
  by_column: Record<string, BydeptTotal>;
  total: BydeptTotal & { items: number };
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
    // Anything that is not exactly 'matrix' or 'bydept' stays on the deployed
    // flat path — a typo must never silently change the shape of a live download.
    const viewParam = (url.searchParams.get('view') || '').trim().toLowerCase();
    const view = viewParam === 'matrix' ? 'matrix' : viewParam === 'bydept' ? 'bydept' : 'flat';
    const q = (url.searchParams.get('q') || '').trim();
    // Estimated GST (rulings #77/#81) is OPT-IN: exactly `gst=1`, sent only by
    // /inventory/closing-history. Without it the flat JSON and CSV are the
    // deployed shape byte for byte — the Dept Closing Sheet's "Download
    // history" calls this route too, and ruling #81 keeps that sheet unchanged.
    const withGst = view === 'flat' && url.searchParams.get('gst') === '1';

    const today = todayIST();
    // The matrix defaults WIDER than the flat list on purpose: its job is to
    // put the previous count beside the current one, and on a monthly counting
    // cycle a 30-day window holds exactly one count — nothing to compare with.
    let from = (url.searchParams.get('from') || '').trim() || shiftIsoDate(today, view === 'matrix' ? -180 : -30);
    let to = (url.searchParams.get('to') || '').trim() || today;
    // Store vs Departments reads ONE `date` and never from/to, so a stray
    // malformed from/to must not fail it (it checks its own `date` below).
    if (view !== 'bydept' && (!ISO_DATE.test(from) || !ISO_DATE.test(to))) {
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

    /* ════════════════════════════════════════════════════════════════════════
     * STORE vs DEPARTMENTS — one date, one row per item, one column per place
     * that counted (owner ruling 99). Same position as the matrix and for the
     * same reason: AFTER the auth, department-scope, outlet and search work
     * above, so all three views agree on who may see which department.
     * ══════════════════════════════════════════════════════════════════════ */
    if (view === 'bydept') {
      const dateParam = (url.searchParams.get('date') || '').trim();
      if (dateParam && !ISO_DATE.test(dateParam)) {
        return Response.json({ error: 'date must be a date in YYYY-MM-DD form.' }, { status: 400 });
      }

      // ── STEP 1: the count dates in scope, newest first ────────────────────
      // The page's date picker, and the date this view opens on when none is
      // asked for — the last REAL count, not an empty "today". NO item search
      // here: the dates (like the columns below) say who COUNTED, which a
      // search for one item must not narrow. Capped at today so a fat-fingered
      // future date (the e91c64c incident) can never be the default; an
      // explicit ?date= is honoured as asked.
      const rawCountDates = db.prepare(`
        SELECT DISTINCT cs.date AS date
          FROM closing_stock cs
         WHERE cs.date <= ?
           AND ${OUTLET_SCOPE_CS}
           ${deptFor('cs')}
         ORDER BY cs.date DESC
         LIMIT ${DATE_CAP}
      `).all(today, outletId, ...deptParams) as { date: string }[];
      const semiCountDates = db.prepare(`
        SELECT DISTINCT css.date AS date
          FROM closing_stock_semi css
         WHERE css.date <= ?
           AND ${OUTLET_SCOPE_CSS}
           ${deptFor('css')}
         ORDER BY css.date DESC
         LIMIT ${DATE_CAP}
      `).all(today, outletId, ...deptParams) as { date: string }[];
      const countDateSet = new Set<string>();
      for (const d of rawCountDates) countDateSet.add(d.date);
      for (const d of semiCountDates) countDateSet.add(d.date);
      const countDates = [...countDateSet].sort().reverse().slice(0, DATE_CAP);
      const date = dateParam || countDates[0] || today;

      // ── STEP 2: which places counted on that date? ────────────────────────
      // Scope-filtered, search-free: a department that counted today but not
      // the searched item still gets its column, full of "not counted" — which
      // is exactly the answer to "who counted PANEER?".
      const countedRaw = db.prepare(`
        SELECT DISTINCT COALESCE(cs.department_id,'') AS dept_id
          FROM closing_stock cs
          JOIN raw_materials rm ON rm.id = cs.material_id
         WHERE cs.date = ?
           AND ${OUTLET_SCOPE_CS}
           ${deptFor('cs')}
      `).all(date, outletId, ...deptParams) as { dept_id: string }[];
      const countedSemi = db.prepare(`
        SELECT DISTINCT COALESCE(css.department_id,'') AS dept_id
          FROM closing_stock_semi css
          JOIN sub_recipes sr ON sr.id = css.sub_recipe_id
         WHERE css.date = ?
           AND ${OUTLET_SCOPE_CSS}
           ${deptFor('css')}
      `).all(date, outletId, ...deptParams) as { dept_id: string }[];

      // ── STEP 3: every count on that date ──────────────────────────────────
      // The matrix's SELECT lists exactly (so the unit and value handling below
      // reads the same columns), keyed by one date. ORDER BY keeps one item's
      // cells contiguous for the whole-item trim, and puts a duplicated cell in
      // write order so the LAST write stands — the writers delete-then-insert
      // per (date, item, department), and a sum would double a duplicate.
      // The name sorts COLLATE NOCASE so that, if ROW_CAP ever cuts the day,
      // the items kept are the top of the same A–Z list the page shows (which
      // ignores case) — not a case-sensitive run where "Chicken" sorts after
      // "COFFEE" and is cut while sorting before the last item shown.
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
         WHERE cs.date = ?
           AND ${OUTLET_SCOPE_CS}
           ${deptFor('cs')}
           ${qRaw}
         ORDER BY rm.name COLLATE NOCASE, cs.material_id, COALESCE(cs.department_id,''), cs.created_at, cs.rowid
         LIMIT ${ROW_CAP + 1}
      `).all(date, outletId, ...deptParams, ...qRawParams) as RawMatrixRow[];

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
         WHERE css.date = ?
           AND ${OUTLET_SCOPE_CSS}
           ${deptFor('css')}
           ${qSemi}
         ORDER BY sr.name COLLATE NOCASE, css.sub_recipe_id, COALESCE(css.department_id,''), css.created_at, css.rowid
         LIMIT ${ROW_CAP + 1}
      `).all(date, outletId, ...deptParams, ...qSemiParams) as SemiMatrixRow[];

      // A half-filled row is indistinguishable from "those departments did not
      // count it" — so a cut item leaves whole, and `truncated` says so.
      let truncated = false;
      if (trimPartialGroup(rawCells, ROW_CAP, (r) => r.material_id)) truncated = true;
      if (trimPartialGroup(semiCells, ROW_CAP, (s) => s.sub_recipe_id)) truncated = true;

      // ── STEP 4: the columns ───────────────────────────────────────────────
      // Every place in STEP 2, plus any place a cell names (belt and braces: a
      // count saved between the two reads must get a column, never be dropped).
      const counted = new Set<string>();
      for (const r of countedRaw) counted.add(r.dept_id);
      for (const r of countedSemi) counted.add(r.dept_id);
      for (const r of rawCells) counted.add(r.department_id || '');
      for (const s of semiCells) counted.add(s.department_id || '');

      // The ONE department read, at runtime — never a hardcoded list of names.
      const deptMeta = new Map((db.prepare(`
        SELECT d.id, d.name, NULLIF(TRIM(COALESCE(d.parent_id,'')),'') AS parent_id,
               p.name AS parent_name, d.is_active
          FROM departments d
          LEFT JOIN departments p ON p.id = d.parent_id
      `).all() as { id: string; name: string; parent_id: string | null; parent_name: string | null; is_active: number }[])
        .map((d) => [d.id, d]));

      const columns: BydeptColumn[] = [];
      // Store / Overall is the comparison baseline, so it is shown to everyone
      // who may read it even on a day it did not count — a column of "not
      // counted" is the honest answer to "Store vs Departments". A department-
      // scoped caller cannot read it (deptClause excludes ''), so has no column.
      const storeInScope = seesAll && (!deptParam || deptParam === STORE_KEY);
      if (storeInScope || counted.has('')) {
        columns.push({
          key: STORE_KEY, name: STORE_LABEL, group_key: STORE_KEY, group: STORE_LABEL,
          is_store: true, is_main: false, is_active: true, counted: counted.has(''),
        });
      }
      const deptCols: BydeptColumn[] = [];
      for (const id of counted) {
        if (!id) continue;
        const m = deptMeta.get(id);
        // Filed under the parent only when the parent row still exists — a
        // dangling parent_id must not invent a heading with no name.
        const parent = m?.parent_id && m.parent_name != null ? { id: m.parent_id, name: m.parent_name } : null;
        const name = m?.name || `Unknown department (${id.slice(0, 8)})`;
        deptCols.push({
          key: id, name,
          group_key: parent ? parent.id : id,
          group: parent ? parent.name : name,
          is_store: false,
          is_main: !parent,
          is_active: m ? Number(m.is_active) === 1 : false,
          counted: true,
        });
      }
      // Groups by name; inside a group the main department's own count first,
      // then its sections by name. Ids break ties so the order never wobbles.
      deptCols.sort((a, b) =>
        a.group.localeCompare(b.group) || a.group_key.localeCompare(b.group_key) ||
        (a.is_main === b.is_main ? 0 : a.is_main ? -1 : 1) ||
        a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
      columns.push(...deptCols);
      const colKeys = columns.map((c) => c.key);
      const colOf = (deptId: string | null) => deptId || STORE_KEY;

      // ── STEP 5: pivot — one row per ITEM ──────────────────────────────────
      // Identity is type + id, never the name (a bought and a made "GINGER
      // GARLIC PASTE" are two items). Every column key is written up front so
      // a missing count is an explicit null, not an absent property.
      const blankCells = (): Record<string, BydeptCell | null> => {
        const o: Record<string, BydeptCell | null> = {};
        for (const k of colKeys) o[k] = null;
        return o;
      };
      const newRow = (key: string, type: 'RAW' | 'SUB', material_id: string | null, sub_recipe_id: string | null,
                      material: string, sku: string, category: string, purchase_unit: string): BydeptRow => ({
        key, material_id, sub_recipe_id, type, material, sku, category, purchase_unit,
        cells: blankCells(), total_qty: null, total_value: null, counted_in: 0, unpriced: 0, mixed_units: false,
      });

      const rawByKey = new Map<string, BydeptRow>();
      /** row key | column key → the GST basis of that cell's count (the value
       *  SAVED with it — storedCountValue, the one rule every GST surface uses).
       *  Written in the same order as the cell, so the last write stands here too. */
      const rawBasis = new Map<string, number | null>();
      for (const r of rawCells) {
        const key = `RAW|${r.material_id}`;
        let row = rawByKey.get(key);
        if (!row) {
          row = newRow(key, 'RAW', r.material_id, null, r.material, r.sku || '', r.category || '',
                       r.purchase_unit || r.unit || '');
          rawByKey.set(key, row);
        }
        // PURCHASE units via the shared helper — identical to the matrix cell.
        // packFactor carries both halves of the guard; never divide by
        // pack_size here.
        const meta: PackMeta = { unit: r.unit, purchase_unit: r.purchase_unit, pack_size: r.pack_size };
        // Stored rate and value only — identical to the matrix cell. Never
        // re-priced: a count is a dated record.
        const hasStoredRate = r.rate_per_purchase_unit != null;
        const priced = hasStoredRate && String(r.rate_source || 'none') !== 'none';
        row.cells[colOf(r.department_id)] = {
          qty: toPurchaseQty(num(r.physical_stock), meta),
          value: priced ? r2(num(r.total_value)) : null,
          rate: priced ? r2(num(r.rate_per_purchase_unit)) : null,
          unit: row.purchase_unit,
        };
        rawBasis.set(`${key}|${colOf(r.department_id)}`, storedCountValue(r));
      }

      const semiByKey = new Map<string, BydeptRow>();
      for (const s of semiCells) {
        const key = `SUB|${s.sub_recipe_id}`;
        // The count-time unit snapshot wins over the CURRENT yield_unit — the
        // same dated-record rule as the matrix and the flat list. No pack
        // factor: running a yield through packFactor is a category error.
        const unit = String(s.unit || '').trim() || String(s.yield_unit || '').trim();
        let row = semiByKey.get(key);
        if (!row) {
          row = newRow(key, 'SUB', null, s.sub_recipe_id, s.material, '', s.category || 'sub-recipe', unit);
          semiByKey.set(key, row);
        } else if (row.purchase_unit !== unit) {
          // Two places counted it in different yield units (the unit was edited
          // between their saves). Each cell keeps its own unit; the Total will
          // not add kg to g.
          row.mixed_units = true;
        }
        const priced = num(s.rate) > 0 || num(s.total_value) > 0;
        row.cells[colOf(s.department_id)] = {
          qty: num(s.physical_stock),
          value: priced ? r2(num(s.total_value)) : null,
          rate: priced ? r2(num(s.rate)) : null,
          unit,
        };
      }

      // ── STEP 6: the Total column, per row ─────────────────────────────────
      // Adding ACROSS departments is valid because it is ONE item in ONE unit —
      // the opposite of adding across items (2 BTL + 3 kg), which no column or
      // footer here ever does. A RAW cell is already rounded to 3 dp by
      // toPurchaseQty, so a RAW Total foots exactly against its printed row. A
      // SUB cell is stored as counted; the sum is taken at full precision and
      // rounded once (the 3-dp house rule, owner-kept), so a semi-finished count
      // entered with MORE than 3 decimals can differ from the sum of its printed
      // cells by under 0.001 per cell (1.0004 + 1.0004 prints 1 + 1, Total 2.001).
      const finishRow = (row: BydeptRow) => {
        let qty = 0, value = 0, valued = 0;
        for (const k of colKeys) {
          const c = row.cells[k];
          if (!c) continue;
          row.counted_in += 1;
          qty += c.qty;
          if (c.value != null) { value += c.value; valued += 1; } else row.unpriced += 1;
        }
        row.total_qty = row.mixed_units ? null : csvQty(qty);
        row.total_value = valued ? r2(value) : null;
      };
      // A–Z in EXACTLY the order STEP 3's SQL read the cells (name COLLATE
      // NOCASE, then id): SQLite NOCASE folds only ASCII A–Z and compares the
      // UTF-8 bytes, which is what nocaseKey + a byte compare reproduce. So if
      // ROW_CAP ever cuts the day, the rows shown are a true prefix of the list
      // and no item is missing ahead of the last one shown — localeCompare
      // could order a name with ~ { | } or a non-ASCII letter differently.
      // (Identical to localeCompare on every name on file today.)
      const nocaseKey = (s: string) => Buffer.from(String(s ?? '').replace(/[A-Z]/g, (c) => c.toLowerCase()), 'utf8');
      const byName = (list: BydeptRow[]): BydeptRow[] => list
        .map((row) => ({ row, k: nocaseKey(row.material) }))
        .sort((a, b) => Buffer.compare(a.k, b.k) || (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0))
        .map((x) => x.row);
      const rows = byName([...rawByKey.values()]);
      const semiRows = byName([...semiByKey.values()]);
      for (const row of rows) finishRow(row);
      for (const row of semiRows) finishRow(row);

      // ── STEP 7: ₹ per column, per block, and both blocks together ─────────
      // Only ₹ is totalled down a column (never quantities). The stored value
      // per cell, summed — the same figure History already sums, never
      // re-priced. Computed after truncation so the totals describe exactly
      // the rows the reader can see.
      const zeroTotal = (): BydeptTotal => ({ lines: 0, value: 0, unpriced: 0 });
      const blockTotals = (list: BydeptRow[]): BydeptBlockTotals => {
        const by_column: Record<string, BydeptTotal> = {};
        for (const k of colKeys) by_column[k] = zeroTotal();
        const total = { ...zeroTotal(), items: list.length };
        for (const row of list) {
          for (const k of colKeys) {
            const c = row.cells[k];
            if (!c) continue;
            const t = by_column[k];
            t.lines += 1; total.lines += 1;
            if (c.value != null) { t.value += c.value; total.value += c.value; }
            else { t.unpriced += 1; total.unpriced += 1; }
          }
        }
        for (const k of colKeys) by_column[k].value = r2(by_column[k].value);
        total.value = r2(total.value);
        return { by_column, total };
      };
      const rawTotals = blockTotals(rows);
      const semiTotals = blockTotals(semiRows);
      const allTotals: BydeptBlockTotals = {
        by_column: {},
        total: {
          items: rawTotals.total.items + semiTotals.total.items,
          lines: rawTotals.total.lines + semiTotals.total.lines,
          value: r2(rawTotals.total.value + semiTotals.total.value),
          unpriced: rawTotals.total.unpriced + semiTotals.total.unpriced,
        },
      };
      for (const k of colKeys) {
        const a = rawTotals.by_column[k], b = semiTotals.by_column[k];
        allTotals.by_column[k] = { lines: a.lines + b.lines, value: r2(a.value + b.value), unpriced: a.unpriced + b.unpriced };
      }

      // ── STEP 8: estimated GST on the RAW block, per column (ruling 107) ──
      // Not a new rule: the resolver, the basis and the arithmetic are the ones
      // All entries, Closing Stock History and Closing Overview use
      // (src/lib/closing-tax.ts) — GST % from the last bill with GST on or
      // before THIS count date, else the item master; liquor / store items
      // always blank; applied to the value SAVED with each count. Only counts
      // with a rate are summed, and every footer says how many ("rate known for
      // N of M"). Semi-finished counts are made in-house and never carry GST,
      // so they have no tax lines. After truncation, like the ₹ totals.
      const gstResolver = rows.length
        ? createClosingGstResolver(db, {
            isStoreMapped: (category) => isStoreMappedMaterial(db, category),
            materialIds: rows.map((row) => String(row.material_id)),
          })
        : null;
      const taxCells: Record<string, ClosingTaxSummable[]> = {};
      for (const k of colKeys) taxCells[k] = [];
      for (const row of rows) {
        const gst = gstResolver!.forMaterial(String(row.material_id), date);
        for (const k of colKeys) {
          if (!row.cells[k]) continue;
          const basis = rawBasis.get(`${row.key}|${k}`) ?? null;
          taxCells[k].push({ value: basis, gst_pct: gst.gst_pct, ...closingTaxCells(basis, gst) });
        }
      }
      const taxByColumn: Record<string, ClosingTaxTotals> = {};
      for (const k of colKeys) taxByColumn[k] = sumClosingTax(taxCells[k]);
      const rawTax = { by_column: taxByColumn, total: addClosingTaxTotals(colKeys.map((k) => taxByColumn[k])) };

      const bnote = truncated
        ? `Showing the first ${(rows.length + semiRows.length).toLocaleString('en-IN')} items counted on ${date} — the day holds more. Search for an item to see the rest.`
        : null;

      if (format === 'csv') {
        // The ONE Store vs Departments CSV layout (src/lib/closing-bydept-csv.ts)
        // — the page's Download builds the same file in the browser from the
        // sheet on screen with this very function, so the two cannot drift.
        const csv = bydeptCsv({
          date, columns, rows, semi_rows: semiRows,
          totals: { raw: rawTotals, semi: semiTotals, all: allTotals },
          tax: rawTax,
          truncated, note: bnote, q,
        });
        return new Response(csv, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${bydeptCsvFilename(date, q)}"`,
            'Cache-Control': 'no-store',
            ...(truncated ? { 'X-Truncated': '1' } : {}),
          },
        });
      }

      return Response.json({
        mode: 'bydept',
        date,
        latest_date: countDates[0] ?? null,
        count_dates: countDates,
        scope: seesAll ? 'all' : 'limited',
        columns,
        rows,
        semi_rows: semiRows,
        totals: { raw: rawTotals, semi: semiTotals, all: allTotals },
        /** Estimated GST on the raw block — per column and in total (STEP 8). */
        tax: rawTax,
        cap: ROW_CAP,
        truncated,
        note: bnote,
        generated_at: new Date().toISOString(),
      });
    }

    // LIMIT cap+1: the extra row is how we detect that the cap bit, without a
    // second COUNT(*) over the same range.
    const lim = ROW_CAP + 1;

    const rawRows = db.prepare(`
      SELECT cs.date                                            AS date,
             cs.material_id                                     AS material_id,
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

    // The GST rate per (material, COUNT DATE) — never today's: a bill dated
    // after a count can never re-price that count's tax. Liquor / store-mapped
    // materials are always blank (the store-issued-log lock). Only on gst=1.
    const gstResolver = withGst && rawRows.length
      ? createClosingGstResolver(db, {
          isStoreMapped: (category) => isStoreMappedMaterial(db, category),
          materialIds: rawRows.map((r) => String(r.material_id)),
        })
      : null;

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
      const row: HistoryRow = {
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
      };
      if (gstResolver) {
        const gst = gstResolver.forMaterial(String(r.material_id), r.date);
        // Tax on the value SAVED with the count — the figure this row prints
        // as `value` (closing-tax.ts storedCountValue, the one rule all three
        // surfaces use). An unpriced / pre-capture row has no tax.
        const taxCells = closingTaxCells(storedCountValue(r), gst);
        row.gst_pct = gst.gst_pct;
        row.gst_source = gst.gst_source;
        row.gst_note = gst.gst_note;
        row.gst_title = gst.gst_title;
        row.tax = taxCells.tax;
        row.total_incl_tax = taxCells.total_incl_tax;
      }
      rows.push(row);
    }

    for (const s of semiRows) {
      // The unit snapshot taken at count time wins over the sub-recipe's
      // CURRENT yield_unit — the same dated-record principle as the rate.
      const unit = String(s.unit || '').trim() || String(s.yield_unit || '').trim();
      const priced = num(s.rate) > 0 || num(s.total_value) > 0;
      const semi: HistoryRow = {
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
      };
      if (withGst) {
        // Semi-finished stock is made in-house, never billed: always blank.
        semi.gst_pct = null;
        semi.gst_source = SEMI_GST.gst_source;
        semi.gst_note = SEMI_GST.gst_note;
        semi.gst_title = SEMI_GST.gst_title;
        semi.tax = null;
        semi.total_incl_tax = null;
      }
      rows.push(semi);
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
    // Estimated GST (gst=1 only) over the rows WITH a rate only, with the
    // counts the page needs to say "rate known for N of M" — computed after
    // truncation, from the same per-row figures the table prints, so the
    // footer foots. Without gst=1 the totals are the deployed { count, value }.
    const totals: { count: number; value: number; tax?: ClosingTaxTotals } = { count: rows.length, value: r2(value) };
    if (withGst) totals.tax = sumClosingTax(rows);

    const note = truncated
      ? `Showing the first ${ROW_CAP.toLocaleString('en-IN')} rows — the range holds more. Narrow the dates or pick one department to see the rest.`
      : null;

    if (format === 'csv') {
      const headers = [
        'Date', 'Department', 'Item', 'SKU', 'Category',
        'Purchase Unit', 'Counted (purchase)',
        'Rate', 'Rate Source', 'Value (INR)', 'Recorded By', 'Type',
        // Estimated GST (gst=1 only) — APPENDED after the last existing
        // column; every column above keeps its position. Blank = no rate
        // (never 0). Without gst=1 the file is the deployed one, unchanged.
        ...(withGst ? [CLOSING_GST_PCT_CSV, CLOSING_GST_SOURCE_CSV, CLOSING_TAX_CSV, CLOSING_INCL_CSV] : []),
      ];
      const lines = [headers.join(',')];
      for (const r of rows) {
        const gstCells = withGst
          ? [
              closingTaxCsv(r.gst_pct),
              csvEscape(r.gst_note || ''),
              closingTaxCsv(r.tax),
              closingTaxCsv(r.total_incl_tax),
            ]
          : [];
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
          ...gstCells,
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
