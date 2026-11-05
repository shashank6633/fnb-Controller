/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CLOSING STOCK — ESTIMATED GST ON THE COUNTED VALUE (owner #4, 2026-10-28)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE ASK, VERBATIM: "Closing Stock Report: Add tax values to the closing
 * stock report." and "Tax is missing in amount so it should add that also."
 * Rulings #77 (show TAX and a TOTAL INCLUDING TAX; default rate = each
 * material's last purchase GST %), #78 (fallback = the item's Master GST %,
 * else BLANK + "rate known for N of M"; liquor/store-mapped always blank) and
 * #81 (the three surfaces below).
 *
 * WHERE IT SHOWS — and nowhere else:
 *   · Closing Stock → History tab (/closing-stock) + its CSV.
 *     Data: GET /api/closing-stock?date=… (items carry the fields below).
 *   · Inventory → Closing History & Compare (/inventory/closing-history),
 *     "All entries" view + its flat CSV (GET /api/closing-stock/history).
 *     The history route adds the GST fields ONLY when asked with `gst=1`,
 *     which only this page sends; the "Compare dates" matrix and its CSV are
 *     unchanged.
 *   · Closing Overview (/inventory/closing-overview, managers) + its two CSVs
 *     (GET /api/closing-stock/overview).
 * The count-entry screen (Record Closing Stock), the Dept Closing Sheet — its
 * screen AND its "Download history" file, which calls the history route
 * without `gst=1` (ruling #81: "Dept Closing Sheet unchanged") — and liquor
 * closing (store_closing_counts) do NOT show tax.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE RATE — ONE RULE, RESOLVED HERE ONLY
 * ───────────────────────────────────────────────────────────────────────────
 * For each counted material, the GST % is, in this order:
 *
 *   1. LAST BILL WITH GST — the GST % ACTUALLY CHARGED on its latest purchase
 *      line dated ON OR BEFORE THE COUNT DATE that recorded GST. A later bill
 *      with NO GST recorded does not displace it (it says nothing about the
 *      rate), which is why every label says "last bill WITH GST", never
 *      "last bill". Both purchase rails:
 *        · an ordinary `purchases` row (its own cgst / sgst / discount /
 *          total_price), and
 *        · a PO-receipt cost mirror, whose charges live on the paired GRN line —
 *          read through purchase-charges.ts's withGrnCharges() /
 *          grnLineJoinSql() / effectiveChargeSql() / effectiveBillValueSql(),
 *          the one definition of "which table did this bill's tax come from".
 *      The rate is tax-applied.ts's taxAppliedPercent(): (CGST + SGST) ÷
 *      (bill value − discount) × 100 — GST is charged on the value AFTER
 *      discount. A line with no GST recorded is skipped (it says nothing about
 *      the rate), and so is a taxed line whose base is zero.
 *      THE COUNT DATE, NEVER TODAY: a bill dated after the count can never
 *      re-price that count's tax. Ties on one date: latest created_at, then id.
 *   2. MASTER — raw_materials.tax_percent when it is > 0. That column is a
 *      data-entry seed, not a record of what a vendor charged (see the
 *      tax-applied.ts header), which is exactly why every row says which of the
 *      two it is: "last bill with GST 12 Oct 2026" or "Master GST %".
 *   3. BLANK — never 0. A 0% would claim the item is GST-free; a blank says
 *      this report has no rate for it. The TAX total sums only the rows WITH a
 *      rate (and a value at count) and says "rate known for N of M items". EVERY
 *      note printed with a total — on all four surfaces and in their CSVs —
 *      comes from closingTaxNotes() below, which tells apart "no rate at all",
 *      "rates known but no value saved at count" and "some taxed", so a note
 *      never denies a rate the GST % column shows.
 *
 * TOTAL INCL. GST = VALUE + TAX (owner ruling 109, 5 Nov 2026). The owner read
 * a Total incl. GST that was SMALLER than the value beside it ("Total Value
 * Plus Tax is equal to Total Incl Tax right") — it then summed only the counts
 * that had a GST rate. Now it is the FULL value at count + the known tax:
 * a count with no GST rate is included AT ITS VALUE, with no GST added. Per
 * row, per column, per card, per total and in every CSV, a printed Total incl.
 * GST is exactly the value printed beside it + the tax printed beside it (a
 * blank tax = 0), worked from the same rounded figures the screen prints
 * (closingIncl / closingTaxOnValue below), so they foot to the paisa.
 *
 * ALWAYS BLANK, whatever a bill or the master says:
 *   · LIQUOR / STORE-MAPPED materials — their duty is excise / cess / TCS on the
 *     TGBCL bill, never GST. Same lock, same helper, as
 *     src/app/api/store-issued-log/route.ts (isStoreMappedMaterial); the master
 *     carries 18% on at least one liquor row, so the lock is not decorative. A
 *     FAILED check is also blank: inventing a tax is worse than omitting one.
 *   · SEMI-FINISHED (sub-recipe) counts — made in-house, never billed.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE MONEY — ON THE VALUE SAVED WITH THE COUNT, ON EVERY SURFACE
 * ───────────────────────────────────────────────────────────────────────────
 *   Tax            = value at count × GST % ÷ 100   (r2)
 *   Total incl. tax = value at count + Tax          (r2; no GST rate → the value)
 * "Value at count" is the STORED closing_stock.total_value — the count-time
 * rate × qty written when the count was saved — read through
 * storedCountValue() below, the ONE definition all three surfaces use:
 *   · the two history surfaces print that very figure in their Value column;
 *   · Closing Overview's own Value column is a DIFFERENT, pre-existing figure
 *     (qty × today's average price, left untouched), so the Overview prints
 *     the value at count beside its tax ("Value at count") and every GST
 *     figure there says it is on the value at count. Taxing the Overview's
 *     own board value would let a bill entered later move an old count's tax
 *     (the average price moves) and would make the same count show two
 *     different taxes on two screens — both broke the brief.
 * A count with NO stored value gets NO tax — blank, never a figure worked out
 * today: a count saved before values were recorded with counts (rate columns
 * NULL; the History tab shows such a row at today's price, marked "est."), or
 * one whose count-time basis was 'none'.
 * This module never values stock: src/lib/closing-valuation.ts and the stored
 * total_value are untouched (owner: the valuation is correct).
 *
 * WHY "(est.)" ON EVERY LABEL. Nobody was billed for closing stock. The rupees
 * are a rate (from a bill, or the master) applied to a stock VALUE, i.e. a
 * notional figure — the same reason the store-issued-log precedent prints
 * "Value incl. GST (est.)". tax-applied.ts's "Tax Value (GST)" wording means
 * TAX ACTUALLY CHARGED and is deliberately NOT reused here. GST only: cesses sit
 * on a different base (see tax-applied.ts) and are never folded in.
 *
 * VISIBILITY: the tax figures follow the value they derive from, exactly. Every
 * route ships them on the same rows / summaries the value already ships on.
 * The stored total_value is cost data GET /api/closing-stock already ships to
 * every caller; the Overview shows it (as "Value at count") only to readers
 * past its own managers gate, who already see each count's value there.
 *
 * CLIENT-SAFE: imports purchase-charges.ts and tax-applied.ts only (both
 * import-free) plus a TYPE from better-sqlite3, which is erased. The one
 * server dependency — the store-mapped check — is INJECTED by the route, so
 * the pages can import the labels and the totals helper from this same file.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { Database } from 'better-sqlite3';
import {
  effectiveBillValueSql,
  effectiveChargeSql,
  grnLineJoinSql,
  grnSourcedSql,
  r2,
  withGrnCharges,
} from '@/lib/purchase-charges';
import { fmtTaxPercent, gstValue, taxAppliedPercent } from '@/lib/tax-applied';

/* ───────────────────────────── THE WORDING ───────────────────────────────── */

/** Screen heading for the rate. Its sub-line says where the rate comes from. */
export const CLOSING_GST_PCT_LABEL = 'GST %';
export const CLOSING_GST_PCT_SUB = 'last bill with GST on/before count, else master';
/** Screen heading for the rupees. "(est.)": a rate applied to a stock value. */
export const CLOSING_TAX_LABEL = 'Tax (GST, est.)';
/** Screen heading for value at count + tax. */
export const CLOSING_INCL_LABEL = 'Total incl. GST (est.)';
/**
 * Closing Overview only: the STORED count-time value its GST is applied to —
 * printed beside the tax there because that board's own Value column is a
 * different (today's average price) figure. On the two history surfaces the
 * Value column already IS this figure, so they need no extra column.
 */
export const CLOSING_COUNT_VALUE_LABEL = 'Value at count';
export const CLOSING_COUNT_VALUE_TITLE =
  'The value SAVED with the count when it was taken (count-time rate × counted qty) — the same Value the '
  + 'Closing Stock History shows for this count. The GST beside it is worked out on this figure. The Value '
  + 'column to the left is a different figure (counted qty × TODAY\'s average price) and is unchanged. '
  + 'Blank where no value was saved with the count.';

export const CLOSING_GST_PCT_TITLE =
  'GST % for this material: the GST actually charged on its LATEST bill that RECORDED GST, dated on or before '
  + 'the count date (CGST + SGST ÷ (bill value − discount)); a PO receipt is read off its GRN line. A later bill '
  + "with no GST recorded is skipped. If no bill up to that date recorded GST, the item master's GST % is used. "
  + 'Otherwise BLANK — never 0%. Liquor / store items (excise, not GST) and semi-finished items are always '
  + 'blank. A bill dated after the count never changes it. Hover a cell for its source.';
export const CLOSING_TAX_TITLE =
  'ESTIMATED GST on the value saved with the count (value at count) × GST % ÷ 100. Nobody was billed for '
  + 'closing stock, so this is an estimate, not tax actually charged. GST only — cesses are not included. '
  + 'Blank where there is no rate, or no value was saved with the count.';
export const CLOSING_INCL_TITLE =
  'Value at count + estimated GST — the value saved with the count plus the Tax beside it. A count with no GST '
  + 'rate is included at its value at count, with no GST added. Blank only where there is no value at count.';
/**
 * Closing Stock History only: its Total incl. GST is built on the TOTAL VALUE
 * that tab prints, which for a count saved before values were stored is an
 * "est." figure worked out at today's price (no GST is added to it).
 */
export const CLOSING_INCL_HISTORY_TITLE =
  'Total Value + estimated GST — the Total Value beside it plus the Tax beside it. A row with no GST rate, or '
  + 'with no value saved at count (an "est." Total Value worked out at today\'s price), is included at its '
  + 'Total Value, with no GST added. Blank only where there is no Total Value.';

/**
 * CSV headings. Appended AFTER every existing column, never inserted.
 * NO COMMAS OR QUOTES in these: the history route joins its header row with a
 * bare ',' (its existing headings never needed escaping).
 */
export const CLOSING_GST_PCT_CSV = 'GST % (last bill with GST on/before count date; else master; blank = no rate)';
export const CLOSING_GST_SOURCE_CSV = 'GST % Source';
export const CLOSING_TAX_CSV = 'Tax INR (GST est. = value at count x GST % / 100)';
export const CLOSING_INCL_CSV = 'Total incl. GST INR (est. = value at count + GST; no GST rate = value at count)';
/** Closing Stock History CSV only (see CLOSING_INCL_HISTORY_TITLE): its basis is the Total Value column. */
export const CLOSING_INCL_HISTORY_CSV =
  'Total incl. GST INR (est. = Total Value + GST; no GST rate or no value saved at count = Total Value with no GST added)';
/** Closing Overview CSVs only (see CLOSING_COUNT_VALUE_LABEL). */
export const CLOSING_COUNT_VALUE_CSV = 'Value at count INR (saved with the count; the GST basis)';

/* ───────────────────────────── THE SHAPES ────────────────────────────────── */

/**
 *   last_bill — GST actually charged on a bill dated on/before the count
 *   master    — raw_materials.tax_percent
 *   none      — no rate anywhere → blank
 *   liquor    — store-mapped (excise) → always blank
 *   semi      — semi-finished / sub-recipe → always blank
 *   unknown   — the store-mapped check itself failed → blank, never a guess
 */
export type ClosingGstSource = 'last_bill' | 'master' | 'none' | 'liquor' | 'semi' | 'unknown';

export interface ClosingGst {
  /** GST % to 2 dp, or null (BLANK — never 0). */
  gst_pct: number | null;
  gst_source: ClosingGstSource;
  /** YYYY-MM-DD of the bill when gst_source = 'last_bill', else null. */
  gst_bill_date: string | null;
  /** Short, printable source: "last bill with GST 12 Oct 2026" / "Master GST %" / … */
  gst_note: string;
  /** Hover text: the same source in full, with the bill reference. */
  gst_title: string;
}

export interface ClosingTaxCells {
  /** value × pct ÷ 100, or null when there is no rate or no value. */
  tax: number | null;
  /** value + tax (ruling 109) — the value alone when there is no GST rate;
   *  null only when there is no value at count. */
  total_incl_tax: number | null;
}

export type ClosingTaxFields = ClosingGst & ClosingTaxCells;

/* ───────────────────────────── FORMATTING ────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-12" → "12 Oct 2026". Date PARTS only — no Date(), no timezone drift. */
export function fmtBillDay(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const mon = MONTHS[Number(m[2]) - 1];
  return mon ? `${Number(m[3])} ${mon} ${m[1]}` : String(iso);
}

/** The rate cell as text: "18.00%" or an em dash. Same formatter as the tax reports. */
export const fmtClosingGstPct = (p: number | null | undefined): string => fmtTaxPercent(p);

/** A rupee figure for a CSV cell: the number, or '' (blank) — never 0 for "unknown". */
export const closingTaxCsv = (v: number | null | undefined): number | '' => (v == null ? '' : r2(v));

/* ───────────────────────────── FIXED RESULTS ─────────────────────────────── */

export const SEMI_GST: ClosingGst = Object.freeze({
  gst_pct: null,
  gst_source: 'semi',
  gst_bill_date: null,
  gst_note: 'semi-finished — no GST rate',
  gst_title: 'Semi-finished (sub-recipe) stock is made in-house and never billed, so it carries no GST rate. '
    + 'Left blank: no GST is added for it, and Total incl. GST counts it at its value where one was saved.',
}) as ClosingGst;

const LIQUOR_GST: ClosingGst = Object.freeze({
  gst_pct: null,
  gst_source: 'liquor',
  gst_bill_date: null,
  gst_note: 'liquor / store item — excise, not GST',
  gst_title: 'Liquor / store-mapped material: its duty is excise, cess and TCS on the TGBCL bill, not GST. '
    + 'Always blank here, whatever a bill or the item master says.',
}) as ClosingGst;

const UNKNOWN_GST: ClosingGst = Object.freeze({
  gst_pct: null,
  gst_source: 'unknown',
  gst_bill_date: null,
  gst_note: 'GST rate not checked',
  gst_title: 'Could not confirm whether this is a liquor / store item, so no GST rate is shown rather than a guess.',
}) as ClosingGst;

const NONE_GST: ClosingGst = Object.freeze({
  gst_pct: null,
  gst_source: 'none',
  gst_bill_date: null,
  gst_note: 'no GST rate on record',
  gst_title: 'No bill dated on or before this count recorded GST for this material, and its item master has no '
    + 'GST %. Left blank (never 0%): no GST is added for it, and Total incl. GST counts it at its value '
    + 'where one was saved.',
}) as ClosingGst;

function masterGst(pct: number): ClosingGst {
  return {
    gst_pct: r2(pct),
    gst_source: 'master',
    gst_bill_date: null,
    gst_note: 'Master GST %',
    gst_title: `No bill dated on or before this count recorded GST for this material, so the item master's `
      + `GST % (${fmtTaxPercent(pct)}) is used. The master rate is a data-entry default, not a rate a vendor charged.`,
  };
}

/* ───────────────────────────── THE ARITHMETIC ────────────────────────────── */

/**
 * THE GST BASIS: the value SAVED with a closing_stock row at count time, or
 * null when it has none. Pass the row's STORED columns. Same rule as the
 * history route's own Value column (a stored rate whose source is not
 * 'none'), so the three surfaces tax the same figure for the same count:
 *   · rate_per_purchase_unit NULL → the row predates value capture; nothing
 *     was saved, and a figure worked out today is not this count's value;
 *   · rate_source 'none'          → no basis existed at count time;
 *   · total_value NULL            → nothing saved to apply a rate to.
 * Never re-values anything — closing-valuation.ts stays the only valuer.
 */
export function storedCountValue(row: {
  rate_per_purchase_unit?: number | string | null;
  rate_source?: string | null;
  total_value?: number | string | null;
} | null | undefined): number | null {
  if (!row || row.rate_per_purchase_unit == null) return null;
  if (String(row.rate_source || 'none') === 'none') return null;
  if (row.total_value == null || !Number.isFinite(Number(row.total_value))) return null;
  return r2(Number(row.total_value));
}

/**
 * Tax and Total incl. tax for one row, from its value at count
 * (storedCountValue). No value saved with the count → both BLANK, never ₹0.
 * No GST rate → Tax BLANK (never ₹0) and Total incl. = the value itself: the
 * count is included at its value with no GST added (ruling 109), so a
 * Total incl. column foots against the Value + Tax columns beside it.
 */
export function closingTaxCells(
  value: number | null | undefined,
  gst: Pick<ClosingGst, 'gst_pct'> | null | undefined,
): ClosingTaxCells {
  const pct = gst?.gst_pct;
  if (value == null || !Number.isFinite(Number(value))) {
    return { tax: null, total_incl_tax: null };
  }
  const v = r2(Number(value));
  if (pct == null) return { tax: null, total_incl_tax: v };
  const tax = r2((v * Number(pct)) / 100);
  return { tax, total_incl_tax: r2(v + tax) };
}

/**
 * Total incl. GST for a PRINTED value and a PRINTED tax (a blank tax = 0):
 * both rounded to the paisa first, exactly as the screen prints them, so the
 * three printed figures always add up (ruling 109).
 */
export function closingIncl(value: number | null | undefined, tax: number | null | undefined): number {
  return r2(r2(Number(value) || 0) + r2(Number(tax) || 0));
}

/**
 * A row any surface can total. `value` is the value THIS SURFACE PRINTS for
 * the row (null = none printed) — the figure its Total incl. GST is built on;
 * `tax` the row's tax (null = blank); `gst_pct` its rate (null = none).
 */
export interface ClosingTaxSummable {
  value?: number | null;
  gst_pct?: number | null;
  tax?: number | null;
  total_incl_tax?: number | null;
}

export interface ClosingTaxTotals {
  /** Σ tax over the rows that HAVE a tax figure (rate known AND a value at count). */
  tax: number;
  /** value + tax (ruling 109): the FULL value below plus the known tax. */
  total_incl_tax: number;
  /** Σ value over EVERY row with a value — with or without a GST rate. The
   *  figure Total incl. GST is built on; a surface that prints a value total
   *  of its own re-bases onto it with closingTaxOnValue(). */
  value: number;
  /** Σ value of the rows WITH a tax figure — what the Tax is worked out on. */
  value_taxed: number;
  /** Rows whose GST rate is known (gst_pct present). */
  rated: number;
  /** Rows with a tax figure (rate known AND a value at count to apply it to). */
  taxed: number;
  /** All rows considered (the M in "N of M"). */
  items: number;
  /** Rows with a value (in `value`). */
  valued: number;
  /** Rows with a value but NO tax — included in Total incl. at their value, no GST added. */
  at_value: number;
  /** …of those, the ones that DO have a GST rate (no value was saved with the
   *  count, so the value is not one the rate may be applied to). */
  at_value_rated: number;
}

const ZERO_TOTALS: ClosingTaxTotals = Object.freeze({
  tax: 0, total_incl_tax: 0, value: 0, value_taxed: 0,
  rated: 0, taxed: 0, items: 0, valued: 0, at_value: 0, at_value_rated: 0,
}) as ClosingTaxTotals;

const finiteOrNull = (v: unknown): number | null =>
  v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);

/**
 * Totals for a footer. Tax: only rows with a tax figure are summed, and the
 * footer says how many ("rate known for N of M"). Total incl. GST: the value
 * of EVERY row that has one + that tax (ruling 109). Summed from the same
 * per-row figures the columns print, so a footer foots its own columns.
 */
export function sumClosingTax(rows: readonly ClosingTaxSummable[]): ClosingTaxTotals {
  let tax = 0, val = 0, valTaxed = 0, rated = 0, taxed = 0, valued = 0, atValue = 0, atValueRated = 0;
  for (const r of rows) {
    const hasRate = r?.gst_pct != null;
    if (hasRate) rated += 1;
    const v = finiteOrNull(r?.value);
    const t = finiteOrNull(r?.tax);
    if (v != null) { valued += 1; val += v; }
    if (t != null) {
      taxed += 1;
      tax += t;
      valTaxed += v ?? 0;
    } else if (v != null) {
      atValue += 1;
      if (hasRate) atValueRated += 1;
    }
  }
  const value = r2(val), taxR = r2(tax);
  return {
    tax: taxR, total_incl_tax: closingIncl(value, taxR), value, value_taxed: r2(valTaxed),
    rated, taxed, items: rows.length, valued, at_value: atValue, at_value_rated: atValueRated,
  };
}

/** Add a set of already-computed totals together (board cells → department →
 *  grand total). Total incl. is re-worked from the summed value + summed tax —
 *  never a sum of parts — so it foots the two figures printed beside it. */
export function addClosingTaxTotals(parts: readonly (Partial<ClosingTaxTotals> | null | undefined)[]): ClosingTaxTotals {
  const out: ClosingTaxTotals = { ...ZERO_TOTALS };
  for (const p of parts) {
    if (!p) continue;
    out.tax += Number(p.tax) || 0;
    out.value += Number(p.value) || 0;
    out.value_taxed += Number(p.value_taxed) || 0;
    out.rated += Number(p.rated) || 0;
    out.taxed += Number(p.taxed) || 0;
    out.items += Number(p.items) || 0;
    out.valued += Number(p.valued) || 0;
    out.at_value += Number(p.at_value) || 0;
    out.at_value_rated += Number(p.at_value_rated) || 0;
  }
  out.tax = r2(out.tax);
  out.value = r2(out.value);
  out.value_taxed = r2(out.value_taxed);
  out.total_incl_tax = closingIncl(out.value, out.tax);
  return out;
}

/**
 * Re-base a set of totals onto the VALUE A SURFACE PRINTS beside them (a
 * column footer, a card): Total incl. GST = that printed value + the printed
 * tax, to the paisa. The counts are kept — they describe the rows.
 */
export function closingTaxOnValue(t: ClosingTaxTotals, value: number | null | undefined): ClosingTaxTotals {
  const v = r2(Number(value) || 0);
  return { ...t, value: v, total_incl_tax: closingIncl(v, t.tax) };
}

/** Is a Total incl. GST printed for these totals? Only where the value beside
 *  it is a figure — at least one row has a value. Otherwise it is a dash. */
export const closingInclShown = (t: Pick<ClosingTaxTotals, 'valued'> | null | undefined): boolean =>
  !!t && (Number(t.valued) || 0) > 0;

/* ───────────────────────────── THE TOTALS NOTES ──────────────────────────── */

/**
 * What a set of totals covers — exactly one of:
 *   empty    — no rows at all;
 *   no_rate  — rows, but NONE has a GST rate (rated = 0);
 *   no_value — some rows HAVE a rate, but none of them has a value saved at
 *              count (rated > 0, taxed = 0) — so there is no tax to show, and
 *              a note must NOT say "no row has a GST rate": the GST % column
 *              beside it prints those rates;
 *   taxed    — at least one row has a rate AND a value at count (taxed > 0).
 */
export type ClosingTaxSituation = 'empty' | 'no_rate' | 'no_value' | 'taxed';

/** What a surface calls its rows. The singular is needed for "no item has …". */
export type ClosingTaxNoun = 'items' | 'entries' | 'counts' | 'counted items';
const NOUN_ONE: Record<ClosingTaxNoun, string> = {
  items: 'item', entries: 'entry', counts: 'count', 'counted items': 'counted item',
};

export interface ClosingTaxNotes {
  situation: ClosingTaxSituation;
  /** The line under (or beside) the Tax total — "rate known for N of M …" and what that means here. */
  rate: string;
  /** The line under the Total incl. total: what it is built of — "GST added for N of M counts ·
   *  K with no GST rate included at value" (ruling 109). */
  incl: string;
  /** The same as `incl` (it names its rows) — for a summary card. Kept as its own field for callers. */
  covers: string;
  /** Compact Tax-line form for a tight cell (the Closing Overview board footers). */
  short: string;
  /** Compact `incl` for the same tight cells. */
  incl_short: string;
  /** Hover text: how the Tax and the Total incl. GST are each made up. */
  title: string;
}

export function closingTaxSituation(t: Pick<ClosingTaxTotals, 'rated' | 'taxed' | 'items'>): ClosingTaxSituation {
  const items = Number(t?.items) || 0;
  if (items <= 0) return 'empty';
  if ((Number(t?.taxed) || 0) > 0) return 'taxed';
  if ((Number(t?.rated) || 0) > 0) return 'no_value';
  return 'no_rate';
}

/**
 * THE ONE SOURCE of every note printed with the GST totals, on all four
 * surfaces and in their CSVs: the Tax-total line, the Total-incl. line, the
 * summary-card lines, the board-footer lines and their hover text. Each case
 * says what is actually true —
 *   Tax line           "rate known for 9 of 13 items (2 with no value saved
 *                       at count are not in the tax figure)" / "rate known for 0 of
 *                       3 items, so no tax is shown" / "… but none has a value
 *                       saved at count, so no tax is shown"
 *   Total incl. line   "GST added for 7 of 13 items · 4 with no GST rate
 *                       included at value · 2 with no value" / "no GST rate
 *                       known — value at count, no GST added"
 * — so no note can deny a rate the GST % column prints, or claim a figure
 * covers rows it does not. Pass the totals (sumClosingTax /
 * addClosingTaxTotals / closingTaxOnValue), the surface's noun, and its rupee
 * formatter (used in the hover text only). `valueWord` names the value the
 * Total incl. GST is built on where it is not purely the value at count
 * (Closing Stock History: "Total Value", which can hold an "est." figure).
 */
export function closingTaxNotes(
  t: Pick<ClosingTaxTotals, 'rated' | 'taxed' | 'items'>
    & Partial<Pick<ClosingTaxTotals, 'tax' | 'total_incl_tax' | 'value' | 'value_taxed' | 'valued' | 'at_value' | 'at_value_rated'>>,
  noun: ClosingTaxNoun = 'items',
  fmt: (v: number) => string = (v) => String(r2(v)),
  valueWord = 'value at count',
): ClosingTaxNotes {
  const items = Math.max(0, Number(t?.items) || 0);
  const taxed = Math.max(0, Number(t?.taxed) || 0);
  const rated = Math.max(0, Number(t?.rated) || 0);
  // Included at value, no GST added — split by whether a GST rate is known.
  const atValue = Math.max(0, Number(t?.at_value) || 0);
  const atValueRated = Math.min(atValue, Math.max(0, Number(t?.at_value_rated) || 0));
  const atValueNoRate = atValue - atValueRated;
  // In neither figure: no tax and no value.
  const unvalued = Math.max(0, items - taxed - atValue);
  const one = NOUN_ONE[noun] || noun;
  const N = (n: number) => n.toLocaleString('en-IN');
  const of = (n: number) => `${N(n)} ${n === 1 ? one : noun}`;          // "1 item" / "1,331 items"
  const are = (n: number) => (n === 1 ? 'is' : 'are');
  const have = (n: number) => (n === 1 ? 'has' : 'have');
  const situation = closingTaxSituation({ rated, taxed, items });
  const known = `rate known for ${N(rated)} of ${of(items)}`;

  if (situation === 'empty') {
    const s = `no ${noun}`;
    return { situation, rate: s, incl: s, covers: s, short: s, incl_short: s, title: `No ${noun} — nothing to estimate GST on.` };
  }

  /* ── the Total incl. GST line (ruling 109): value + tax, every row with a
   *    value included — those with no GST rate at their value, no GST added. */
  const parts = [
    atValueNoRate > 0 ? `${N(atValueNoRate)} with no GST rate included at value` : '',
    atValueRated > 0 ? `${N(atValueRated)} with no value saved at count included at the value shown, no GST` : '',
    unvalued > 0 ? `${N(unvalued)} with no value` : '',
  ].filter(Boolean);
  const shortParts = [
    atValueNoRate > 0 ? `${N(atValueNoRate)} no GST rate, at value` : '',
    atValueRated > 0 ? `${N(atValueRated)} not saved at count, at value` : '',
    unvalued > 0 ? `${N(unvalued)} no value` : '',
  ].filter(Boolean);
  let incl: string, inclShort: string;
  if (taxed > 0) {
    incl = [`GST added for ${N(taxed)} of ${of(items)}`, ...parts].join(' · ');
    inclShort = [`GST on ${N(taxed)} of ${N(items)}`, ...shortParts].join(' · ');
  } else if (atValue > 0) {
    if (rated === 0) {
      incl = [`no GST rate known — ${valueWord}, no GST added`, ...(unvalued > 0 ? [`${N(unvalued)} with no value`] : [])].join(' · ');
      inclShort = ['no GST rate · value only', ...(unvalued > 0 ? [`${N(unvalued)} no value`] : [])].join(' · ');
    } else {
      incl = ['no GST added', ...parts].join(' · ');
      inclShort = ['no GST added', ...shortParts].join(' · ');
    }
  } else {
    incl = items === 1 ? `the ${one} has no value` : `no ${one} has a value`;
    inclShort = 'no value';
  }

  /* ── the hover text: how each of the two figures is made up ─────────────── */
  // No tax worked out → no "+ ₹0" (a ₹0 reads as GST-free): the value alone.
  const inclTitle = atValue > 0 || taxed > 0
    ? (taxed > 0
      ? `Total incl. GST = the ${valueWord} ${fmt(Number(t?.value) || 0)} + the tax ${fmt(Number(t?.tax) || 0)}`
        + ` = ${fmt(Number(t?.total_incl_tax) || 0)}.`
      : `Total incl. GST = the ${valueWord} ${fmt(Number(t?.total_incl_tax) || 0)}, with no GST added.`)
      + (atValueNoRate > 0 ? ` ${N(atValueNoRate)} with no GST rate ${are(atValueNoRate)} included at value, with no GST added.` : '')
      + (atValueRated > 0 ? ` ${N(atValueRated)} with a GST rate but no value saved at count ${are(atValueRated)} included at`
        + ' the value shown, with no GST added — a rate is applied only to the value saved with the count.' : '')
      + (unvalued > 0 ? ` ${N(unvalued)} ${have(unvalued)} no value and ${are(unvalued)} in neither figure.` : '')
    : `Total incl. GST is blank: ${items === 1 ? `the ${one} has no value` : `none of the ${N(items)} ${noun} has a value`}.`;
  const rateWhere = ' A rate comes from the latest bill with GST on or before the count date, else the item '
    + "master's GST %; liquor / store and semi-finished items never carry one.";

  if (situation === 'no_rate') {
    return {
      situation,
      rate: `${known}, so no tax is shown`,
      incl, covers: incl,
      short: `${known} · no tax`,
      incl_short: inclShort,
      title: `Tax: ${items === 1 ? `the 1 ${one} has no GST rate` : `none of the ${N(items)} ${noun} has a GST rate`}, so no tax is `
        + `estimated and the Tax is blank.${rateWhere} ${inclTitle}`,
    };
  }

  if (situation === 'no_value') {
    // Rates ARE known — the GST % column prints them — but no rated row has a
    // value saved with its count, so there is nothing to apply them to.
    const which = rated === 1
      ? 'it has no value'
      : rated === items ? 'none has a value' : `none of those ${N(rated)} has a value`;
    const noRate = items - rated;
    // The compact board-footer form names WHICH rows have no value, like
    // `which` above: when some rows have no rate, one of THOSE may well have a
    // value at count, so a bare "none with a value at count" would be untrue.
    const shortWhich = rated === items
      ? 'none with a value at count'
      : rated === 1
        ? 'the 1 with a GST rate has no value at count'
        : `none of the ${N(rated)} with a GST rate has a value at count`;
    return {
      situation,
      rate: `${known}, but ${which} saved at count, so no tax is shown`,
      incl, covers: incl,
      short: `${known} · ${shortWhich} · no tax`,
      incl_short: inclShort,
      title: `Tax: GST rate known for ${N(rated)} of ${of(items)}, but ${which} saved with the count, so no tax is `
        + 'estimated and the Tax is blank. Tax is applied only to the value saved with the count — never to '
        + 'a value worked out today, which a later bill could move.'
        + (noRate > 0 ? ` The other ${N(noRate)} ${have(noRate)} no GST rate.` : '')
        + ` ${inclTitle}`,
    };
  }

  // taxed > 0
  const noValue = Math.max(0, rated - taxed);
  const noRate = Math.max(0, items - rated);
  const out = [
    noRate > 0 ? `${N(noRate)} with no GST rate` : '',
    noValue > 0 ? `${N(noValue)} with a GST rate but no value saved at count` : '',
  ].filter(Boolean);
  return {
    situation,
    rate: noValue > 0
      ? `${known} (${N(noValue)} with no value saved at count ${are(noValue)} not in the tax figure)`
      : known,
    incl, covers: incl,
    short: noValue > 0 ? `${known} · ${N(noValue)} with no value at count not in tax` : known,
    incl_short: inclShort,
    title: 'Tax: estimated GST on '
      + (taxed === items
        ? (items === 1 ? `the 1 ${one}, which has a GST rate and a value saved at count` : `all ${N(items)} ${noun} — each has a GST rate and a value saved at count`)
        : `the ${N(taxed)} of ${of(items)} with a GST rate and a value saved at count`)
      + ` (their value at count ${fmt(Number(t?.value_taxed) || 0)}) = ${fmt(Number(t?.tax) || 0)}.`
      + (out.length ? ` No tax on: ${out.join('; ')}.` : '')
      + ` ${inclTitle}`,
  };
}

/**
 * The Tax-total line alone — the same text as closingTaxNotes(t, noun).rate.
 * Kept as a named export for callers that need only that line.
 */
export function rateKnownNote(t: Pick<ClosingTaxTotals, 'rated' | 'taxed' | 'items'>, noun: ClosingTaxNoun = 'items'): string {
  return closingTaxNotes(t, noun).rate;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE RESOLVER — server side. One query for every taxed bill line, one for the
 * master rates; then each (material, count date) is a binary search.
 * ═══════════════════════════════════════════════════════════════════════════ */

interface TaxedLine {
  date: string;
  pct: number;
  ref: string;
  from_grn: boolean;
}

interface MasterRow { category: string; tax_percent: number }

export interface ClosingGstResolver {
  /** The GST for one counted material on one count date. */
  forMaterial(materialId: string, countDate: string): ClosingGst;
}

export interface ClosingGstResolverOptions {
  /**
   * Is this CATEGORY store-mapped (liquor)? Injected so this file stays
   * client-safe: routes pass `(c) => isStoreMappedMaterial(db, c)` from
   * src/lib/store-engine.ts, the store-issued-log precedent. A throw is
   * treated as "cannot confirm" → blank.
   */
  isStoreMapped: (category: string) => boolean;
  /** Narrow both queries to these materials (optional). */
  materialIds?: readonly string[];
}

/**
 * SQL: every purchase line that RECORDED GST, on the effective rail, with the
 * two figures taxAppliedPercent() needs. Exported for the proof harness.
 */
export function taxedPurchaseLinesSql(narrowed: boolean): string {
  // bill_no reads purchases.bill_no only: production's purchases table has NO
  // invoice_number column (only some old local copies carry one), and reading
  // it failed every GST screen with "no such column: p.invoice_number".
  const cg = effectiveChargeSql('cgst', 'p', 'gl');
  const sg = effectiveChargeSql('sgst', 'p', 'gl');
  const disc = effectiveChargeSql('discount', 'p', 'gl');
  const bv = effectiveBillValueSql('p', 'gl');
  return withGrnCharges(`
    SELECT p.material_id                                  AS material_id,
           substr(p.date, 1, 10)                          AS date,
           p.created_at                                   AS created_at,
           p.id                                           AS id,
           ${cg}                                          AS cgst,
           ${sg}                                          AS sgst,
           ${disc}                                        AS discount,
           ${bv}                                          AS bill_value,
           ${grnSourcedSql('gl')}                         AS from_grn,
           COALESCE(NULLIF(TRIM(p.bill_no), ''), '')      AS bill_no,
           COALESCE(NULLIF(TRIM(p.invoice_id), ''), '')   AS invoice_id,
           COALESCE(g.grn_number, '')                     AS grn_number
      FROM purchases p
      ${grnLineJoinSql('p', 'gl')}
      LEFT JOIN goods_receipt_notes g ON g.id = p.grn_id
     WHERE (${cg}) + (${sg}) > 0
       ${narrowed ? 'AND p.material_id IN (SELECT value FROM json_each(?))' : ''}
     ORDER BY p.material_id, substr(p.date, 1, 10), p.created_at, p.id
  `);
}

export function createClosingGstResolver(db: Database, opts: ClosingGstResolverOptions): ClosingGstResolver {
  const ids = opts.materialIds ? [...new Set(opts.materialIds.filter(Boolean).map(String))] : null;
  const narrowed = ids != null;

  // ── the bill lines, oldest first per material ──────────────────────────────
  const lines = new Map<string, TaxedLine[]>();
  if (!narrowed || ids.length > 0) {
    const raw = db.prepare(taxedPurchaseLinesSql(narrowed))
      .all(...(narrowed ? [JSON.stringify(ids)] : [])) as Array<Record<string, unknown>>;
    for (const r of raw) {
      const row = {
        cgst: Number(r.cgst) || 0,
        sgst: Number(r.sgst) || 0,
        discount: Number(r.discount) || 0,
        bill_value: Number(r.bill_value) || 0,
      };
      // gstValue / taxAppliedPercent — THE basis, from tax-applied.ts. A taxed
      // line whose base is ≤ 0 yields null and is skipped: a rate over nothing
      // is not a rate.
      if ((gstValue(row) ?? 0) <= 0) continue;
      const pct = taxAppliedPercent(row);
      if (pct == null || !(pct > 0)) continue;
      const date = String(r.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const fromGrn = Number(r.from_grn) === 1;
      const bill = String(r.bill_no || '');
      const ref = fromGrn
        ? [r.grn_number ? String(r.grn_number) : '', bill ? `vendor bill ${bill}` : ''].filter(Boolean).join(', ')
        : [r.invoice_id ? String(r.invoice_id) : '', bill ? `vendor bill ${bill}` : ''].filter(Boolean).join(', ');
      const mid = String(r.material_id);
      let arr = lines.get(mid);
      if (!arr) { arr = []; lines.set(mid, arr); }
      arr.push({ date, pct, ref, from_grn: fromGrn });
    }
  }

  // ── the master rates + categories ───────────────────────────────────────────
  const master = new Map<string, MasterRow>();
  if (!narrowed || ids.length > 0) {
    const mrows = db.prepare(`
      SELECT id, COALESCE(category, '') AS category, COALESCE(tax_percent, 0) AS tax_percent
        FROM raw_materials
       ${narrowed ? 'WHERE id IN (SELECT value FROM json_each(?))' : ''}
    `).all(...(narrowed ? [JSON.stringify(ids)] : [])) as Array<{ id: string; category: string; tax_percent: number }>;
    for (const m of mrows) master.set(String(m.id), { category: String(m.category || ''), tax_percent: Number(m.tax_percent) || 0 });
  }

  // ── liquor lock, memoised per category ──────────────────────────────────────
  const mappedMemo = new Map<string, boolean | null>();
  const storeMapped = (category: string): boolean | null => {
    const key = String(category || '').trim();
    if (!key) return false;
    if (mappedMemo.has(key)) return mappedMemo.get(key) as boolean | null;
    let v: boolean | null;
    try { v = !!opts.isStoreMapped(key); }
    catch (e) {
      console.error(`[closing-tax] store-mapped check failed for '${key}' — GST left blank`, e);
      v = null;
    }
    mappedMemo.set(key, v);
    return v;
  };

  const memo = new Map<string, ClosingGst>();

  return {
    forMaterial(materialId: string, countDate: string): ClosingGst {
      const mid = String(materialId || '');
      const day = String(countDate || '').slice(0, 10);
      const key = `${mid}|${day}`;
      const hit = memo.get(key);
      if (hit) return hit;

      const m = master.get(mid);
      let out: ClosingGst;
      const mapped = storeMapped(m?.category || '');
      if (mapped === true) out = LIQUOR_GST;
      else if (mapped === null) out = UNKNOWN_GST;
      else {
        // Latest taxed line dated ON/BEFORE the count date (binary search over
        // the date-ascending list; ties already ordered by created_at, id).
        const arr = lines.get(mid);
        let found: TaxedLine | null = null;
        if (arr && arr.length && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
          let lo = 0, hi = arr.length - 1, at = -1;
          while (lo <= hi) {
            const mid2 = (lo + hi) >> 1;
            if (arr[mid2].date <= day) { at = mid2; lo = mid2 + 1; } else hi = mid2 - 1;
          }
          if (at >= 0) found = arr[at];
        }
        if (found) {
          const when = fmtBillDay(found.date);
          // "WITH GST": a later bill on/before the count that recorded no GST
          // is skipped (it says nothing about the rate), so this is not
          // necessarily the latest bill — and the words must not claim it is.
          out = {
            gst_pct: found.pct,
            gst_source: 'last_bill',
            gst_bill_date: found.date,
            gst_note: `last bill with GST ${when}`,
            gst_title: `GST actually charged on the latest bill that recorded GST, dated on or before this count — ${when}`
              + `${found.ref ? ` (${found.ref})` : ''}${found.from_grn ? ', read off the GRN line' : ''}: `
              + `(CGST + SGST) ÷ (bill value − discount) = ${fmtTaxPercent(found.pct)}. `
              + 'Bills with no GST recorded are skipped; a bill dated after the count never changes it.',
          };
        } else if (m && m.tax_percent > 0) {
          out = masterGst(m.tax_percent);
        } else {
          out = NONE_GST;
        }
      }
      memo.set(key, out);
      return out;
    },
  };
}
