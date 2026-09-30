/**
 * ⚠️ STATUS 2026-09-30: THIS MODULE HAS NO CALL SITES YET. NOTHING IMPORTS IT.
 *
 * Do not read the confident tense below as "this is live". It is not wired to
 * any screen. It compiles, and its behaviour is proven by a 54-check harness
 * (see the commit message), but no report and no dashboard calls it.
 *
 * WHY: two lanes built /reports/sales and /sales-dashboard in parallel and each
 * created THIS path as a new file. Their 21 files lived only in uncommitted
 * worktrees, which were reaped mid-session; 19 of them — every report and
 * dashboard call site — are unrecoverable (never committed, so in no git
 * object). Only the two rival copies of this module survived, and this file is
 * their reconciliation. The rival originals are kept at
 * `refs/rescue/sales-slice-lanes` so this merge can be audited.
 *
 * THREE THINGS NEED THE OWNER'S CALL BEFORE ANYTHING IMPORTS THIS:
 *   1. URL PARAM NAMES. The lanes disagreed (`t_from`/`t_to` vs `tfrom`/`tto`).
 *      This file uses t_from/t_to. If a shipped link or bookmark already uses
 *      the other spelling, that link breaks.
 *   2. THE NO-FLOOR BUCKET in the picker. listAreas() offers it and
 *      SliceFilter.floor can express it. One lane deleted it from the picker.
 *      Keeping it is the safer default and is what this file does — confirm
 *      that is wanted on screen.
 *   3. BAD INPUT: 400 OR IGNORE. This file throws SliceError (a 400 naming the
 *      problem). The other lane silently degraded to "no filter", which answers
 *      a question nobody asked. Confirm the 400 is acceptable in the UI.
 *
 * DELIBERATELY NOT TOUCHED: src/app/api/sales/analytics/route.ts and
 * src/app/sales/page.tsx. Commit 657d0f8 already shipped the heatmap fix there
 * (1,132 of 1,141 sales rows were piling into a fake 09:00 cell). BOTH lanes
 * also patched those two files and the losing lane's version was worse — no
 * 04:00 rollback on the weekday, no TRIM on sale_time, a duplicated NULL
 * predicate. Applying either would have reverted a live fix. Verified
 * byte-identical to e4ff7a2.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * sales-slice.ts — THE single definition of how POS sales are sliced in TIME and
 * SPACE, shared by the Sales Reports (/reports/sales) and the Sales Dashboard
 * (/sales-dashboard). Nothing in here touches access control: a slice narrows
 * rows, it never widens who may see them.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * Two screens drifted because each carried its own copy of the rules: a bill
 * settled 4:30 PM read "Lunch" on the Dashboard (`< 17`) and "Dinner" in
 * Reports (`< 16`) at the same moment. So every rule below is defined ONCE here
 * and imported. Do not re-declare IST, the 04:00 boundary or the 16:00 boundary
 * anywhere else on the sales rail.
 *
 * ── THE THREE OWNER RULINGS THIS FILE IMPLEMENTS (2026-09-23) ───────────────
 * 1. LUNCH ENDS AT 4 PM, AND TIME DISPLAYS AS 12-HOUR AM/PM.
 *    `LUNCH_END_HOUR = 16`. The API and the DB keep 24-hour ISO; only the
 *    DISPLAY is 12-hour, via fmt12h/fmtTimeRange/basisLine below.
 * 2. NC / COMPLIMENTARY BILLS ARE INCLUDED, BUT SHOWN SEPARATELY.
 *    `billBasis` selects which side you are asking for ('normal' | 'nc' |
 *    'all'). It is a REQUIRED field — see the note on it below.
 * 3. THE TRADING NIGHT IS 4 AM TO 4 AM.
 *    A bill settled 00:30 Wednesday IST belongs to TUESDAY. TRADING_DAY_START_HOUR
 *    = 4 drives the date range, the weekday filter, every day bucket and the
 *    Lunch/Dinner session, so none of them can disagree.
 *
 *    RELATION TO HRMS: src/lib/hr-attendance.ts already runs a 04:00 business
 *    day (DEFAULT_CUTOFF = '04:00'), and this is the SAME reasoning — a shift
 *    and a service that start on Tuesday evening stay Tuesday's until 4 AM.
 *    TWO DELIBERATE DIFFERENCES: (a) HRMS reads its cutoff from the
 *    `hr_day_cutoff` setting because HR policy can move; the sales trading
 *    night is a fixed standard, not a toggle, because moving it restates
 *    reported revenue. (b) HRMS formats its boundary as 'HH:MM' text; here it
 *    is an integer hour so it can be composed into SQL without parsing.
 *
 * ── THIS FILE IS THE UNION OF TWO PARALLEL IMPLEMENTATIONS ──────────────────
 * Two lanes each created this path independently. Where they disagreed, the
 * resolution and its reason are recorded at the point of the decision, tagged
 * `UNION:`. Four of those resolutions fixed a defect that was invisible to
 * `tsc` because both lanes exported the same name with the same type:
 *
 *   • sessionExpr — one lane read the RAW IST WALL HOUR, which calls a 02:00
 *     bill "Lunch". Proven by execution: the two bodies disagree for every bill
 *     settled 00:00–03:59 IST and agree everywhere else. The trading-clock body
 *     below is the correct one (ruling 3).
 *   • the floor sentinel — see SliceFilter.floor. One lane could not express
 *     "the no-floor bucket" at all and silently widened that request to
 *     EVERY area, which is a wrong money number with no error.
 *   • billBasis — defaulting it silently zeroes NC columns for a one-pass
 *     caller. It is now required, so TypeScript asks the question instead.
 *   • fmtArea — reported 'All areas' for the no-floor bucket, i.e. it LABELLED
 *     a narrowed figure as unnarrowed.
 *
 * ── CONTRACT FOR CONSUMERS ──────────────────────────────────────────────────
 *   const s = sliceFilter(slice, { from, to, timeCol: 'o.settled_at' });
 *   db.prepare(`SELECT ... FROM orders o
 *               WHERE o.status = 'settled'
 *                 AND (o.outlet_id = ? OR o.outlet_id IS NULL)
 *                 ${s.sql}`).all(outletId, ...s.params);
 *
 *   • `sql` is a LEADING-AND fragment ("AND x AND y"), safe to append to any
 *     non-empty WHERE. It is '' when the slice narrows nothing and no range is
 *     given.
 *   • `params` must be appended in the SAME ORDER the fragment appears.
 *   • Every value is bound as a `?` parameter — no user text is interpolated.
 *   • The query need only expose the ORDER alias (default `o`). The area test is
 *     a correlated EXISTS on `<order>.table_id`, so this fragment drops into a
 *     query that never joins restaurant_tables — the totals, the session split,
 *     the payment mix — unchanged. UNION: the other lane resolved floor against
 *     a joined `rt` alias and had to REFUSE any query without that join. EXISTS
 *     is used here instead because it is a primary-key lookup that cannot alter
 *     row counts, whereas adding a join can: an inner join silently drops
 *     table-less bills (takeaway, parcel, party) and that moves money.
 */

/** Minimal structural DB shape. UNION: deliberately NOT `import type Database
 *  from 'better-sqlite3'` (the other lane did) — that drags a server-only type
 *  into a module whose formatters are imported by client components. */
interface QueryableDb {
  prepare(sql: string): { all(...params: any[]): any[]; get(...params: any[]): any };
}

/* ──────────────────────────────── constants ─────────────────────────────── */

/** IST = UTC + 5:30. THE one copy for the sales rail; stored datetimes are UTC.
 *  The half-hour is load-bearing: a '+5 hours' shortcut wrongly EXCLUDES 12:15
 *  IST and wrongly INCLUDES 16:20 IST. */
export const IST = "'+330 minutes'";

/** The trading night starts at 04:00 IST. Owner ruling 2026-09-23. Fixed, not
 *  configurable — a settings toggle here could silently restate money. */
export const TRADING_DAY_START_HOUR = 4;

/** Lunch ends at 16:00 IST. Owner ruling 2026-09-23.
 *  UNION: the other lane called this SESSION_BOUNDARY_HOUR. One name only —
 *  two constants for one boundary is how the 16/17 drift started. */
export const LUNCH_END_HOUR = 16;

export const SESSION_LUNCH = 'Lunch';
export const SESSION_DINNER = 'Dinner';

const TRADING_START_MIN = TRADING_DAY_START_HOUR * 60;
/** Minutes from 04:00 to 16:00 — the Lunch width on the trading clock. */
const LUNCH_WIDTH_MIN = (LUNCH_END_HOUR - TRADING_DAY_START_HOUR) * 60;

/** 0 = Sunday … 6 = Saturday, matching SQLite strftime('%w') and JS getDay(). */
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ──────────────────────────────── SQL pieces ────────────────────────────── */

/**
 * The TRADING-NIGHT date of a stored UTC datetime column: shift to IST, then
 * back off the 04:00 start so 00:30 Wednesday reads as Tuesday.
 *   00:30 IST Wed → 20:30 IST Tue → Tue.  04:00 IST Wed → Wed.  03:59 Wed → Tue.
 *
 * UNION: the other lane called this tradingDayExpr (identical body). This is a
 * SQL EXPRESSION BUILDER and is NOT interchangeable with tradingDateNow(),
 * which is a JS function returning today's date. `tsc` will suggest renaming
 * one to the other; accepting that suggestion compiles and interpolates the
 * literal text `undefined` into the SQL string.
 */
export function tradingDate(col: string): string {
  return `date(${col}, ${IST}, '-${TRADING_DAY_START_HOUR} hours')`;
}

/**
 * The IST CALENDAR day bucket — what every sales figure used before ruling 3.
 * Kept ONLY so a migration/evidence query can quantify what moved. No product
 * surface should call it.
 */
export function calendarDate(col: string): string {
  return `date(${col}, ${IST})`;
}

/** Wall-clock minutes past midnight IST (0..1439) — what the guest's watch said.
 *  UNION: the other lane called this minuteOfDayExpr (identical body). */
export function istMinutes(col: string): string {
  return `(CAST(strftime('%H', ${col}, ${IST}) AS INTEGER) * 60`
    + ` + CAST(strftime('%M', ${col}, ${IST}) AS INTEGER))`;
}

/** Minutes since 04:00 IST (0..1439) — position inside the trading night. */
export function tradingMinutes(col: string): string {
  return `((${istMinutes(col)} - ${TRADING_START_MIN} + 1440) % 1440)`;
}

/** 0 = Sunday … 6 = Saturday, computed on the TRADING night (ruling 3). */
export function tradingWeekday(col: string): string {
  return `CAST(strftime('%w', ${tradingDate(col)}) AS INTEGER)`;
}

/**
 * Lunch / Dinner, on the TRADING clock. 04:00–15:59 IST is Lunch; 16:00–03:59
 * is Dinner — so 1 AM is the tail of the night's Dinner service.
 *
 * UNION — THE SILENT COLLISION. The other lane exported this same name with
 * this same signature, but its body was `strftime('%H') < 16` on the RAW IST
 * WALL CLOCK, which calls a 02:00 bill "Lunch". Both lanes defined a 4 and a
 * 16, so they read as identical on inspection; only execution separates them.
 * Verified against SQLite: the two disagree for EVERY bill settled 00:00–03:59
 * IST and agree at 04:00, 12:00, 16:30 and 23:00. This body is correct per
 * ruling 3. Do not "simplify" it back to a bare hour comparison.
 */
export function sessionExpr(col: string): string {
  return `CASE WHEN ${tradingMinutes(col)} < ${LUNCH_WIDTH_MIN}`
    + ` THEN '${SESSION_LUNCH}' ELSE '${SESSION_DINNER}' END`;
}

/* ─────────────────── the trading date, in JS (not SQL) ──────────────────── */

/**
 * UTC "YYYY-MM-DD HH:MM:SS" (or ISO) → its trading date. Mirrors tradingDate().
 * This is JS, for defaults and labels; tradingDate() is the SQL builder. They
 * are different tools and must never be merged.
 */
export function tradingDateOf(atUtc: string | Date): string {
  const raw = String(atUtc).trim();
  const ms = atUtc instanceof Date
    ? atUtc.getTime()
    : Date.parse(raw.replace(' ', 'T') + (/[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? '' : 'Z'));
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + (330 - TRADING_DAY_START_HOUR * 60) * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * TODAY, on the trading night — the correct default for both surfaces.
 *
 * This is NOT todayIST(). At 02:00 IST Wednesday the IST calendar day is
 * Wednesday but the service running at that moment is TUESDAY night's, so a
 * dashboard defaulted to the calendar day shows the cashier an empty screen in
 * the middle of their own shift. Same reasoning as hr-attendance
 * currentBusinessDate().
 */
export function tradingDateNow(): string {
  return tradingDateOf(new Date());
}

/* ──────────────────────────────── the slice ─────────────────────────────── */

/** 'normal' = chargeable bills (the headline). 'nc' = NC/complimentary, shown
 *  separately. 'all' = both — what a ONE-PASS caller wants when it splits NC in
 *  its own SELECT list with paired n_* / c_* CASE columns. */
export type BillBasis = 'normal' | 'nc' | 'all';

export interface SliceFilter {
  /** 0..6 (Sun..Sat) on the TRADING night. Empty/undefined/all-seven = every day. */
  weekdays?: number[] | null;
  /** 'HH:MM' IST, INCLUSIVE start. Null with toTime null = all day. */
  fromTime?: string | null;
  /** 'HH:MM' IST, EXCLUSIVE end. May be <= fromTime, which wraps past midnight. */
  toTime?: string | null;
  /**
   * THREE DISTINCT STATES — read this before touching it.
   *   undefined / null → no area filter at all (every bill).
   *   ''               → THE NO-FLOOR BUCKET: bills whose table exists but has
   *                      a blank zone. This is a REAL, NARROWER selection.
   *   'First Floor'    → that zone.
   *
   * UNION — THE SILENT COLLISION. One lane treated '' and null as the SAME
   * thing ("no filter"), so a request for the no-floor bucket silently became
   * an UNFILTERED query returning every area — a wrong money number with no
   * error anywhere. The gate below is therefore `floor != null`, never the
   * truthiness test `if (floor)`. Bills with NO table at all (takeaway, parcel,
   * party) are a different concept again and are reported by sliceCoverage()'s
   * `unattributed*`, never folded in here.
   */
  floor?: string | null;
  /** restaurant_tables.section, exact after TRIM. REQUIRES a floor selection
   *  (including the '' bucket) — the same section code exists on more than one
   *  floor in production, so a bare section is ambiguous and is refused. */
  section?: string | null;
  /**
   * Which bills (ruling 2). REQUIRED — deliberately not optional.
   *
   * UNION: one lane defaulted this to 'normal', which pushes
   * `bill_type = 'normal'` into the WHERE. A one-pass caller that splits NC in
   * its SELECT list then has every c_* column silently read zero, because the
   * comp rows were already filtered out before the CASE could see them. The
   * other lane had no such field, so its callers could not say what they meant.
   * Requiring it turns that silent money bug into a compile error.
   */
  billBasis: BillBasis;
}

/** The do-nothing slice: all days, all day, all areas, BOTH bill sides.
 *  billBasis is 'all' because NO_SLICE means "narrow nothing" — including not
 *  narrowing away the comps. A report headline wants 'normal', not this. */
export const NO_SLICE: SliceFilter = {
  weekdays: [], fromTime: null, toTime: null, floor: null, section: null, billBasis: 'all',
};

export interface SliceSql { sql: string; params: any[] }

export interface SliceOptions {
  /** The datetime column the time/weekday/date rules apply to. Default 'o.settled_at'. */
  timeCol?: string;
  /** Alias of the orders row (for bill_type and table_id). Default 'o'. */
  orderAlias?: string;
  /** Trading-night date range, YYYY-MM-DD inclusive. Omit to leave the range to the caller. */
  from?: string;
  to?: string;
  /** Set false on a query with no bill_type column (e.g. the KOT rail). Default true. */
  applyBillBasis?: boolean;
}

/** 'HH:MM' → minutes past midnight, or null when unparseable/out of range.
 *  Accepts '24:00' (= 1440) so a window ending at midnight can be expressed. */
export function parseHhmm(v: unknown): number | null {
  const m = String(v ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 24 || mi > 59) return null;
  const t = h * 60 + mi;
  return t >= 0 && t <= 1440 ? t : null;
}

/** minutes past midnight → 'HH:MM' (24h). The API/URL/database form. */
export function formatHhmm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Thrown for a slice that cannot be honoured; the API turns it into a 400. */
export class SliceError extends Error {}

/**
 * Build the WHERE fragment for a slice. See the file header for the contract.
 * Throws SliceError rather than quietly dropping a filter it cannot apply — a
 * filter that silently does nothing is how a reader trusts the wrong number.
 */
export function sliceFilter(slice: SliceFilter, opt: SliceOptions = {}): SliceSql {
  const s = slice;
  if (!s) throw new SliceError('sliceFilter needs a slice; pass NO_SLICE to narrow nothing.');
  const timeCol = opt.timeCol || 'o.settled_at';
  const o = opt.orderAlias || 'o';
  const parts: string[] = [];
  const params: any[] = [];

  // Date range — on the TRADING night, not the IST calendar day (ruling 3).
  if (opt.from != null && opt.to != null) {
    parts.push(`${tradingDate(timeCol)} BETWEEN ? AND ?`);
    params.push(opt.from, opt.to);
  }

  // Days — Mon..Sun chips, computed on the TRADING night. All seven = no filter.
  // UNION: one lane used the trading clock here but the WALL clock in
  // sessionExpr, and no rollback at all in its heatmap weekday. One shared
  // helper (tradingWeekday) is what removes that whole class of disagreement.
  const days = Array.from(new Set((s.weekdays || []).map(Number)
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)));
  if (days.length > 0 && days.length < 7) {
    parts.push(`${tradingWeekday(timeCol)} IN (${days.map(() => '?').join(',')})`);
    params.push(...days);
  }

  // When — an IST wall-clock window, [from, to). from > to wraps past midnight
  // (Late night 11 PM–4 AM). Composed with the trading-night bucket that is ONE
  // night: the 01:00 half already carries the previous day's trading date, so
  // it cannot leak into the following night.
  const fromMin = parseHhmm(s.fromTime);
  const toMin = parseHhmm(s.toTime);
  if (fromMin != null && toMin != null && fromMin !== toMin) {
    const mins = istMinutes(timeCol);
    parts.push(fromMin < toMin ? `(${mins} >= ? AND ${mins} < ?)` : `(${mins} >= ? OR ${mins} < ?)`);
    params.push(fromMin, toMin);
  } else if ((fromMin == null) !== (toMin == null)) {
    throw new SliceError('A time window needs both a start and an end (HH:MM).');
  }

  // Where — floor, then section beneath it. Note `!= null`, NOT truthiness:
  // floor '' is the no-floor bucket, a real narrowing. See SliceFilter.floor.
  const floor = s.floor == null ? null : String(s.floor).trim();
  const section = s.section == null ? null : (String(s.section).trim() || null);
  if (section && floor == null) {
    throw new SliceError('A section filter needs its floor — the same section code exists on more than one floor.');
  }
  if (floor != null) {
    let ex = `EXISTS (SELECT 1 FROM restaurant_tables rt_slice`
      + ` WHERE rt_slice.id = ${o}.table_id AND TRIM(COALESCE(rt_slice.zone, '')) = ?`;
    params.push(floor);
    if (section) { ex += ` AND TRIM(COALESCE(rt_slice.section, '')) = ?`; params.push(section); }
    parts.push(ex + ')');
  }

  // NC / complimentary (ruling 2). 'comp' and 'complimentary' both occur —
  // src/types/index.ts says 'complimentary' while the sales importer writes
  // 'comp' — so anything that is not 'normal' is the NC side.
  if (opt.applyBillBasis !== false) {
    const basis = s.billBasis;
    if (basis !== 'normal' && basis !== 'nc' && basis !== 'all') {
      throw new SliceError(`billBasis must be 'normal', 'nc' or 'all' — got ${JSON.stringify(basis)}.`);
    }
    if (basis === 'normal') parts.push(`COALESCE(${o}.bill_type, 'normal') = 'normal'`);
    else if (basis === 'nc') parts.push(`COALESCE(${o}.bill_type, 'normal') <> 'normal'`);
    // 'all' pushes nothing, so a one-pass caller's n_*/c_* CASE columns see
    // every row. This is what makes the two NC styles coexist.
  }

  return { sql: parts.length ? ' AND ' + parts.join('\n      AND ') : '', params };
}

/** True when this slice narrows to a floor or a section (including the '' bucket). */
export function hasAreaFilter(s: SliceFilter | null | undefined): boolean {
  return !!s && (s.floor != null || (s.section != null && String(s.section).trim() !== ''));
}

/**
 * True when the slice narrows ANYTHING — days, time or area.
 * UNION: this is NOT hasAreaFilter (which is area only); both are needed and
 * both are kept. billBasis is deliberately excluded: it is always set and says
 * WHICH ledger you are reading, which the basis line states outright rather
 * than hiding behind a "filters active" badge.
 */
export function isSliceActive(s: SliceFilter | null | undefined): boolean {
  if (!s) return false;
  const days = (s.weekdays || []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return (days.length > 0 && days.length < 7)
    || (s.fromTime != null && s.toTime != null)
    || hasAreaFilter(s);
}

/** A slice with the area narrowing removed — the reconciliation denominator. */
export function withoutArea(s: SliceFilter): SliceFilter {
  return { ...s, floor: null, section: null };
}

/* ─────────────────────────── 12-hour display (ruling 1) ─────────────────── */

/** '16:00' → '4:00 PM'. Owner standard: every sales time on screen, in a filter
 *  label, in a CSV/Excel heading and on a PDF is 12-hour AM/PM. Pair with
 *  formatHhmm() when you hold minutes rather than 'HH:MM'. */
export function fmt12h(hhmm: string | null | undefined): string {
  const t = parseHhmm(hhmm);
  if (t == null) return '';
  const total = t % 1440;
  const h24 = Math.floor(total / 60), mi = total % 60;
  const ap = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mi).padStart(2, '0')} ${ap}`;
}

/** A bare hour as the owner writes it: 16 → '4 PM', 4 → '4 AM'. */
export function fmtHour12(hour: number): string {
  const h = ((Math.round(hour) % 24) + 24) % 24;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
}

/** 'All day', or '12:00 PM – 4:00 PM' (en dash, his format). */
export function fmtTimeRange(fromTime?: string | null, toTime?: string | null): string {
  const a = fmt12h(fromTime), b = fmt12h(toTime);
  if (!a || !b || a === b) return 'All day';
  return `${a} – ${b}`;
}

/** 'Tuesdays', 'Sat & Sun', 'All days'. */
export function fmtWeekdays(weekdays?: number[] | null): string {
  const d = Array.from(new Set((weekdays || []).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))).sort();
  if (d.length === 0 || d.length === 7) return 'All days';
  if (d.length === 1) return WEEKDAY_LONG[d[0]] + 's';
  return d.map((x) => WEEKDAY_SHORT[x]).join(' & ');
}

/**
 * 'All areas', 'No floor set', 'First Floor', 'First Floor › FA'.
 *
 * UNION: one lane returned 'All areas' whenever the floor was falsy, so the
 * no-floor bucket ('') was LABELLED as unnarrowed while the query underneath it
 * was narrowed. The null/'' distinction is load-bearing here, exactly as it is
 * in sliceFilter.
 */
export function fmtArea(floor?: string | null, section?: string | null): string {
  if (floor == null) return 'All areas';
  const f = String(floor).trim() || 'No floor set';
  const s = (section || '').trim();
  return s ? `${f} › ${s}` : f;
}

const TRADING_CLOCK = fmt12h(`${String(TRADING_DAY_START_HOUR).padStart(2, '0')}:00`);
/** The trading-night suffix every basis line carries, in his 12-hour format. */
export const TRADING_NIGHT_LABEL = `trading night ${TRADING_CLOCK}–${TRADING_CLOCK}`;

/**
 * THE always-visible basis line, identical on Reports and the Dashboard:
 *   "Tuesdays · 12:00 PM – 4:00 PM · First Floor › FA · settled bills
 *    (NC / complimentary shown separately) · trading night 4:00 AM–4:00 AM"
 *
 * The bill clause is not optional: ruling 2 says the headline must state what
 * it contains, so a reader never has to guess which total they are looking at.
 * UNION: the other lane's describeSlice() emitted a bare 'settled bills',
 * omitting that clause entirely. It is dropped in favour of this one — two
 * basis-line renderers is the aliasing this file exists to end.
 */
export function basisLine(slice: SliceFilter | null | undefined, opt: { from?: string; to?: string } = {}): string {
  const s = slice || NO_SLICE;
  const basis: BillBasis = s.billBasis || 'normal';
  const bills =
    basis === 'nc' ? 'NC / complimentary bills only'
      : basis === 'all' ? 'settled bills incl. NC / complimentary'
        : 'settled bills (NC / complimentary shown separately)';
  const bits = [
    fmtWeekdays(s.weekdays),
    fmtTimeRange(s.fromTime, s.toTime),
    fmtArea(s.floor, s.section),
    bills,
    TRADING_NIGHT_LABEL,
  ];
  if (opt.from && opt.to) bits.unshift(opt.from === opt.to ? opt.from : `${opt.from} → ${opt.to}`);
  return bits.join(' · ');
}

/** A short filename-safe tag for exports, e.g. 'Tue_1200-1600_First-Floor-FA'. */
export function sliceTag(s: SliceFilter | null | undefined): string {
  if (!s) return '';
  const bits: string[] = [];
  const d = (s.weekdays || []).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
  if (d.length > 0 && d.length < 7) bits.push(d.map((x) => WEEKDAY_SHORT[x]).join('-'));
  const a = parseHhmm(s.fromTime), b = parseHhmm(s.toTime);
  if (a != null && b != null) bits.push(`${formatHhmm(a)}-${formatHhmm(b)}`.replace(/:/g, ''));
  if (s.floor != null) bits.push([String(s.floor).trim() || 'no-floor', s.section].filter(Boolean).join('-'));
  if (s.billBasis === 'nc') bits.push('NC');
  else if (s.billBasis === 'all') bits.push('incl-NC');
  return bits.join('_').replace(/[^A-Za-z0-9_-]+/g, '-');
}

/* ──────────────────────────── the When presets ──────────────────────────── */

/**
 * The key of a WHEN preset. UNION: the other lane's `PresetKey` is this string
 * union; its `TimePreset` equivalent was the OBJECT. They are different kinds
 * of thing and renaming one to the other turns `useState<TimePresetKey>('all')`
 * into a type error. 'custom' is a UI state (the user typed their own times) and
 * deliberately has no row in TIME_PRESETS.
 */
export type TimePresetKey = 'all' | 'lunch' | 'evening' | 'late' | 'custom';

export interface TimePreset { key: TimePresetKey; label: string; fromTime: string | null; toTime: string | null }

const hhmm = (h: number) => `${String(h).padStart(2, '0')}:00`;

/**
 * Presets, derived from the SAME constants as the session column so a preset
 * and a Session cell can never disagree: Lunch ends at LUNCH_END_HOUR, Late
 * night ends where the trading night does.
 *
 * UNION: the other lane's rows carried `fromMin`/`toMin` as minutes and
 * HARDCODED the label text ('Lunch 12 PM – 4 PM'). These labels are computed
 * from LUNCH_END_HOUR, so moving the boundary moves the label with it. Note
 * `.key` and `.label` exist in both shapes with compatible types, so a dropdown
 * built as TIME_PRESETS.map(p => <option value={p.key}>{p.label}</option>)
 * compiles clean against EITHER — the type gate cannot catch a mix-up here.
 */
export const TIME_PRESETS: TimePreset[] = [
  { key: 'all', label: 'All day', fromTime: null, toTime: null },
  { key: 'lunch', label: `Lunch ${fmt12h('12:00')} – ${fmt12h(hhmm(LUNCH_END_HOUR))}`, fromTime: '12:00', toTime: hhmm(LUNCH_END_HOUR) },
  { key: 'evening', label: `Evening ${fmt12h('19:00')} – ${fmt12h('23:00')}`, fromTime: '19:00', toTime: '23:00' },
  { key: 'late', label: `Late night ${fmt12h('23:00')} – close`, fromTime: '23:00', toTime: hhmm(TRADING_DAY_START_HOUR) },
];

/* ────────────────────────────── Where options ───────────────────────────── */

export interface AreaFloor {
  /** The raw zone value to send back as ?floor= ('' = the no-floor bucket). */
  floor: string;
  /** What to show a human. */
  label: string;
  /** Section codes on this floor, '' excluded. Empty ⇒ 'no sections defined'. */
  sections: string[];
  /** How many tables sit here — lets the picker show weight. */
  tables: number;
}

/**
 * Floors and their sections, straight from restaurant_tables — never a
 * hardcoded list. FLOOR = `zone`, SECTION = `section`.
 *
 * Deactivated tables are INCLUDED on purpose: a floor that was retired still
 * has history, and dropping it from the picker would make that history
 * unreachable. A floor with no sections comes back with an empty array so the
 * UI can say 'no sections defined' instead of offering an empty submenu.
 *
 * UNION: the other lane's listAreas did `if (!floor) continue`, DELETING the
 * no-floor bucket from the picker — while the rest of that same lane could
 * express and query it. Kept here, labelled 'No floor set' and sorted last.
 */
export function listAreas(db: QueryableDb, outletId: string | null): AreaFloor[] {
  const rows = db.prepare(`
    SELECT TRIM(COALESCE(zone, ''))    AS floor,
           TRIM(COALESCE(section, '')) AS section,
           COUNT(*)                    AS tables
    FROM restaurant_tables
    WHERE (outlet_id = ? OR outlet_id IS NULL)
    GROUP BY floor, section
    ORDER BY floor, section
  `).all(outletId) as any[];

  const byFloor = new Map<string, AreaFloor>();
  for (const r of rows) {
    const floor = String(r.floor || '');
    let f = byFloor.get(floor);
    if (!f) {
      f = { floor, label: floor || 'No floor set', sections: [], tables: 0 };
      byFloor.set(floor, f);
    }
    f.tables += Number(r.tables) || 0;
    const sec = String(r.section || '');
    if (sec && !f.sections.includes(sec)) f.sections.push(sec);
  }
  for (const f of byFloor.values()) f.sections.sort();
  // Named floors first, the 'no floor set' bucket last.
  return Array.from(byFloor.values()).sort((a, b) =>
    (a.floor === '' ? 1 : 0) - (b.floor === '' ? 1 : 0) || a.floor.localeCompare(b.floor));
}

/* ─────────────────────── parsing a slice off a URL ──────────────────────── */

/**
 * Read a slice off query params. Shared so Reports and the Dashboard accept
 * EXACTLY the same parameter names:
 *   days=0,2,5   t_from=12:00   t_to=16:00   floor=First%20Floor   section=FA
 *
 * `floor` uses has()-not-value, so a PRESENT-but-empty ?floor= is the no-floor
 * bucket and an ABSENT one is 'all areas'. Collapsing those two is the silent
 * widening described on SliceFilter.floor.
 *
 * Throws SliceError on anything it cannot honour. UNION: the other lane
 * degraded bad input to 'no filter', which answers a question nobody asked;
 * a 400 that names the problem is the safer failure.
 */
export function parseSlice(sp: URLSearchParams, billBasis: BillBasis = 'normal'): SliceFilter {
  const rawDays = (sp.get('days') || '').trim();
  let weekdays: number[] | null = null;
  if (rawDays) {
    const parts = rawDays.split(',').map((x) => x.trim()).filter(Boolean);
    // A bare Number() check would be wrong here: Number('') and Number(' ') are
    // both 0, so a malformed ?days= could silently mean "Sundays only".
    if (parts.some((x) => !/^\d+$/.test(x))) {
      throw new SliceError('days must be a comma-separated list of 0–6 (0 = Sunday).');
    }
    const nums = parts.map((x) => Number(x));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) {
      throw new SliceError('days must be a comma-separated list of 0–6 (0 = Sunday).');
    }
    weekdays = Array.from(new Set(nums)).sort((a, b) => a - b);
  }

  const tFrom = (sp.get('t_from') || '').trim() || null;
  const tTo = (sp.get('t_to') || '').trim() || null;
  if (tFrom && parseHhmm(tFrom) == null) throw new SliceError('t_from must be HH:MM (24-hour).');
  if (tTo && parseHhmm(tTo) == null) throw new SliceError('t_to must be HH:MM (24-hour).');
  if (!!tFrom !== !!tTo) throw new SliceError('A time window needs both t_from and t_to.');

  const floor = sp.has('floor') ? String(sp.get('floor') || '').trim() : null;
  const sectionRaw = sp.has('section') ? String(sp.get('section') || '').trim() : null;
  if (sectionRaw && floor == null) {
    throw new SliceError('section requires floor — the same section code exists on more than one floor.');
  }
  return { weekdays, fromTime: tFrom, toTime: tTo, floor, section: sectionRaw || null, billBasis };
}

/** The slice as query params. Mirrors parseSlice exactly, including the
 *  present-but-empty ?floor= that means the no-floor bucket. */
export function sliceToQuery(s: SliceFilter | null | undefined): URLSearchParams {
  const q = new URLSearchParams();
  const d = (s?.weekdays || []).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
  if (d.length > 0 && d.length < 7) q.set('days', Array.from(new Set(d)).sort((a, b) => a - b).join(','));
  if (s?.fromTime && s?.toTime) { q.set('t_from', s.fromTime); q.set('t_to', s.toTime); }
  if (s?.floor != null) {
    q.set('floor', String(s.floor));
    if (s.section) q.set('section', s.section);
  }
  return q;
}

/* ─────────────────────────── reconciliation ────────────────────────────── */

export interface SliceCoverage {
  /** Settled bills matching the day/weekday/time slice, ALL areas, ALL bill types. */
  rangeOrders: number; rangeSales: number;
  /** …of those, the ones the chosen floor/section keeps. */
  shownOrders: number; shownSales: number;
  /** …the ones no floor can ever claim (no table, or the table was deleted). */
  unattributedOrders: number; unattributedSales: number;
  /** RULING 2 — the NC/complimentary slice of `shown`, reported, never dropped. */
  ncOrders: number; ncSales: number;
}

/**
 * What the slice kept, and what it left behind.
 *
 * A floor filter silently under-reports unless the screen says so: takeaway,
 * parcel and party bills carry no table_id and therefore belong to no floor.
 * Measured with the weekday + time window applied but WITHOUT the floor filter,
 * so the footer can honestly read 'Showing ₹X of ₹Y settled in range'.
 *
 * RULING 2: this counts EVERY settled bill, NC and complimentary included, and
 * reports the NC share separately — so it forces billBasis:'all' on its own
 * measurement regardless of what the caller's slice asks for. It must never be
 * the thing that quietly drops a comp bill out of a reconciliation total.
 */
export function sliceCoverage(
  db: QueryableDb, outletId: string | null, from: string, to: string, slice: SliceFilter,
): SliceCoverage {
  // Weekday/time only — the area filter is exactly what we are measuring — and
  // 'all' bills, because this is the denominator the footer reconciles against.
  const timeOnly: SliceFilter = { ...slice, floor: null, section: null, billBasis: 'all' };
  const w = sliceFilter(timeOnly, { timeCol: 'o.settled_at', orderAlias: 'o' });

  // The 'kept by the area filter' test, as a CASE-able boolean.
  const areaParams: any[] = [];
  let areaTest = '1';
  const floor = slice.floor == null ? null : String(slice.floor).trim();
  const section = slice.section == null ? null : (String(slice.section).trim() || null);
  if (floor != null) {
    areaTest = `EXISTS (SELECT 1 FROM restaurant_tables rt_cov`
      + ` WHERE rt_cov.id = o.table_id AND TRIM(COALESCE(rt_cov.zone, '')) = ?`;
    areaParams.push(floor);
    if (section) { areaTest += ` AND TRIM(COALESCE(rt_cov.section, '')) = ?`; areaParams.push(section); }
    areaTest += ')';
  }
  const NC = `COALESCE(o.bill_type, 'normal') <> 'normal'`;
  const UNATTR = `NOT EXISTS (SELECT 1 FROM restaurant_tables rt_u WHERE rt_u.id = o.table_id)`;

  const row = db.prepare(`
    SELECT
      COUNT(*)                  AS rangeOrders,
      COALESCE(SUM(o.total), 0) AS rangeSales,
      SUM(CASE WHEN ${areaTest} THEN 1 ELSE 0 END)                              AS shownOrders,
      COALESCE(SUM(CASE WHEN ${areaTest} THEN o.total ELSE 0 END), 0)           AS shownSales,
      SUM(CASE WHEN ${UNATTR} THEN 1 ELSE 0 END)                                AS unattributedOrders,
      COALESCE(SUM(CASE WHEN ${UNATTR} THEN o.total ELSE 0 END), 0)             AS unattributedSales,
      SUM(CASE WHEN ${areaTest} AND ${NC} THEN 1 ELSE 0 END)                    AS ncOrders,
      COALESCE(SUM(CASE WHEN ${areaTest} AND ${NC} THEN o.total ELSE 0 END), 0) AS ncSales
    FROM orders o
    WHERE o.status = 'settled'
      AND ${tradingDate('o.settled_at')} BETWEEN ? AND ?
      AND (o.outlet_id = ? OR o.outlet_id IS NULL)${w.sql}
  `).get(
    // SELECT-list params bind first, in the order the CASEs appear: areaTest is
    // used by FOUR of them (shownOrders, shownSales, ncOrders, ncSales).
    ...areaParams, ...areaParams, ...areaParams, ...areaParams,
    from, to, outletId, ...w.params,
  ) as any;

  const n = (v: any) => Number(v) || 0;
  const r2 = (v: any) => Math.round((Number(v) || 0) * 100) / 100;
  return {
    rangeOrders: n(row?.rangeOrders), rangeSales: r2(row?.rangeSales),
    shownOrders: n(row?.shownOrders), shownSales: r2(row?.shownSales),
    unattributedOrders: n(row?.unattributedOrders), unattributedSales: r2(row?.unattributedSales),
    ncOrders: n(row?.ncOrders), ncSales: r2(row?.ncSales),
  };
}
