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

    const today = todayIST();
    let from = (url.searchParams.get('from') || '').trim() || shiftIsoDate(today, -30);
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
       ORDER BY cs.date DESC, COALESCE(d.name,''), rm.name
       LIMIT ${lim}
    `).all(from, to, outletId, ...deptParams) as RawCountRow[];

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
       ORDER BY css.date DESC, COALESCE(d.name,''), sr.name
       LIMIT ${lim}
    `).all(from, to, outletId, ...deptParams) as SemiCountRow[];

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
