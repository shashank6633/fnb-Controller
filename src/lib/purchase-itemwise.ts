/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ITEM-WISE PURCHASES — one line per item bought, adding up to the Summary
 * (owner ruling 115, 2026-11-05). SERVER ONLY (better-sqlite3, xlsx).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE OWNER'S PROBLEM, IN HIS WORDS: "the Item wise Purchase Report Which is
 * Downloaded is Different its coming around 1.36 crore of Purchases of October
 * if we sum the Grand Totals. some Entries are Double". Nothing was saved
 * twice. The file he downloaded was the purchase LOG, which lists three
 * document types for the same goods — the purchase order (what was ordered),
 * the GRN (the vendor's bill) and the purchase entry (what was booked) — so
 * summing its Grand Total column counted one delivery two or three times.
 *
 * THIS LIST IS THE OTHER THING HE ASKED FOR: "Exact Purchases Date wise and
 * Item Wise … where i can Reconcile the data". One line per ROW OF `purchases`
 * in the window — the very rows the Summary tab adds up, read through the
 * Summary's own FROM / WHERE (purchaseReportBase, src/lib/purchase-report-base.ts)
 * — and every money figure on a line through the SAME per-row expression the
 * Summary SUMs (src/lib/purchase-charges.ts). So, by construction:
 *
 *     Σ lines, per column  =  the Summary card of the same name, to the paisa
 *
 * for any window and filter. It is not assumed: getPurchaseItemwise() runs the
 * Summary's own period aggregate (purchaseReportSummarySql) over the same base
 * and compares every card figure with the lines' own sums, in paise, on every
 * request. The screen and the Excel file print that comparison.
 *
 * WHAT IS DELIBERATELY NOT HERE: purchase orders (an order is not a purchase)
 * and GRN lines as separate rows (a GRN is the same delivery as the purchase it
 * booked — its charges ARE on the line, read off the GRN, which is the whole
 * point of the effective rail). The three-document log stays available, as the
 * "All documents (audit)" view, for checking documents against each other.
 *
 * NO NEW ARITHMETIC. Subtotal, the eight charges and Grand Total are the
 * Summary's per-row expressions; Taxable Value is Subtotal − Discount (the
 * ruling's own definition); GST % is the purchase log's per-line rate
 * (taxAppliedPercent over the value GST was charged on, gstChargedValueSql —
 * the ACCEPTED value on a delivery part-rejected at the door, exactly as the
 * log and the GRN Inward Register strike it). Bills are grouped with the
 * purchase log's BILL_KEY_SQL, which that module proves against the Purchase
 * Bill Summary per bill; the Bill-wise sheet is compared with the Bill Summary
 * per bill again here.
 */
import * as XLSX from 'xlsx';
import type DatabaseT from 'better-sqlite3';
import { getDb } from '@/lib/db';
import {
  effectiveBillValueSql, effectiveChargeSql, effectiveLineTotalSql,
  poReceiptMirrorSql, withGrnCharges, chargeSums, r2,
  type PurchaseChargeKey,
} from '@/lib/purchase-charges';
import { gstChargedValueSql, gstBaseAcceptedSql, acceptedBaseTotalNote } from '@/lib/purchase-gst-base';
import { gstValue, taxAppliedPercent } from '@/lib/tax-applied';
import { purchaseReportBase, purchaseReportSummarySql } from '@/lib/purchase-report-base';
import { BILL_KEY_SQL } from '@/lib/purchase-log';
import { getPurchaseBillSummary } from '@/lib/purchase-bill-summary';
import { fmtIST } from '@/lib/format-date';
import {
  ITEMWISE_MONEY_COLUMNS, billMatchSentence, billsDoNot,
  type ItemwiseRow, type ItemwiseMoney, type ItemwiseMoneyKey,
  type ItemwiseCheck, type ItemwiseProof, type ItemwiseBillCheck,
} from '@/lib/purchase-itemwise-columns';

/** Lines sent to the SCREEN at most (the Excel file always holds every line). Same cap as the purchase log. */
export const ITEMWISE_SCREEN_ROW_CAP = 50_000;

export interface ItemwiseFilters {
  from: string;
  to: string;
  vendor?: string;
  category?: string;
  materialId?: string;
}

/** A line plus the fields the checks need and the screen does not. */
interface Line extends ItemwiseRow {
  bill_key: string;
  material_id: string;
  vendor_raw: string;
  is_emergency: boolean;
}

export interface ItemwiseDateRow { date: string; lines: number; bills: number; vendors: number; money: ItemwiseMoney }

export type ItemwiseBillKind = 'INV' | 'GRN' | 'BILL' | 'DAY';
export interface ItemwiseBillRow {
  bill_key: string;
  kind: ItemwiseBillKind;
  date: string;
  vendor: string;
  bill_no: string;
  grn_no: string;
  invoice_id: string;
  lines: number;
  money: ItemwiseMoney;
}

export interface ItemwiseResult {
  from: string;
  to: string;
  vendor: string;
  category: string;
  material_id: string;
  material_name: string;
  lines: Line[];
  bills: number;
  days: number;
  totals: ItemwiseMoney;
  proof: ItemwiseProof;
  bill_check: ItemwiseBillCheck;
  date_rows: ItemwiseDateRow[];
  bill_rows: ItemwiseBillRow[];
  part_rejected_lines: number;
  understated_lines: number;
  /** Lines holding a money figure with a fraction of a paisa (kept exact so columns still add up). */
  subpaise_lines: number;
}

/**
 * A money figure as stored, with float noise removed: 1234.5600000001 → 1234.56.
 * A genuine fraction of a paisa (quantity × rate, e.g. 83.325) is KEPT, so that
 * a column adds up to the Summary — which sums the stored values — to the
 * paisa. Screens and the Excel file show two decimals.
 */
function money(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const p = r2(n);
  // A real fraction of a paisa keeps it, without float noise (3355.9759999999997 → 3355.976).
  return Math.abs(n - p) < 1e-6 ? p : clean(n);
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const paise = (v: number) => Math.round((Number(v) || 0) * 100);

/**
 * A SUM of money figures with the float noise of adding them removed
 * (87804.73000000001 → 87804.73), rounded to a millionth of a rupee — NOT to
 * two decimals, so a genuine fraction of a paisa carried by a line (see money())
 * survives and every column still adds up to the Summary to the paisa.
 */
const clean = (v: number): number => {
  const n = Number(v) || 0;
  return Math.round(n * 1e6) / 1e6;
};

function cleanMoney(m: ItemwiseMoney) {
  for (const k of Object.keys(m) as ItemwiseMoneyKey[]) m[k] = clean(m[k]);
}

const MONEY_KEYS = ITEMWISE_MONEY_COLUMNS.map(c => c.key);

const zeroMoney = (): ItemwiseMoney => {
  const m = {} as ItemwiseMoney;
  for (const k of MONEY_KEYS) m[k] = 0;
  return m;
};

/** The eight charges as named on both `purchases` and the line. */
const CHARGE_KEYS: PurchaseChargeKey[] = [
  'discount', 'cgst', 'sgst', 'compensation_cess', 'special_excise_cess', 'tcs', 'delivery_charges', 'mrp_round_off',
];

/**
 * One row per `purchases` row in the Summary's base, sorted date → bill → item.
 * Every money column is the Summary's own per-row expression.
 */
function lineSql(base: string): string {
  const charges = CHARGE_KEYS.map(k => `${effectiveChargeSql(k, 'p', 'gl')} AS ${k}`).join(',\n        ');
  return withGrnCharges(`
    SELECT * FROM (
      SELECT
        p.id                                               AS id,
        p.date                                             AS date,
        p.created_at                                       AS created_at,
        p.vendor                                           AS vendor_raw,
        COALESCE(NULLIF(TRIM(p.vendor), ''), '(no vendor)') AS vendor,
        COALESCE(TRIM(p.bill_no), '')                      AS bill_no,
        COALESCE(TRIM(p.invoice_id), '')                   AS invoice_id,
        -- The GRN NUMBER, by the row's own hard link. A scalar lookup on the
        -- GRN's primary key, so it can never add a row.
        CASE WHEN TRIM(COALESCE(p.grn_id, '')) = '' THEN ''
             ELSE COALESCE((SELECT TRIM(g.grn_number) FROM goods_receipt_notes g
                             WHERE g.id = TRIM(p.grn_id)), '') END AS grn_no,
        p.material_id                                      AS material_id,
        -- The Summary's own item label (by_item), so an unlinked material keeps
        -- its money under a name that says what is wrong.
        COALESCE(NULLIF(TRIM(rm.name), ''),
                 '(material not linked · id ' || COALESCE(p.material_id, '?') || ')') AS item,
        CASE WHEN rm.id IS NULL THEN 1 ELSE 0 END          AS unlinked,
        COALESCE(TRIM(rm.sku), '')                         AS sku,
        COALESCE(NULLIF(TRIM(rm.category), ''), '(uncategorised)') AS category,
        COALESCE(p.quantity, 0)                            AS qty,
        COALESCE(TRIM(rm.purchase_unit), '')               AS unit,
        COALESCE(p.unit_price, 0)                          AS rate,
        ${effectiveBillValueSql('p', 'gl')}                AS subtotal,
        ${charges},
        ${effectiveLineTotalSql('p', 'gl')}                AS grand_total,
        COALESCE(p.total_price, 0)                         AS booked,
        ${gstChargedValueSql('p', 'gl')}                   AS gst_base_value,
        ${gstBaseAcceptedSql('p', 'gl')}                   AS gst_base_accepted,
        CASE WHEN gl.purchase_id IS NOT NULL THEN 1 ELSE 0 END AS from_grn,
        CASE WHEN ${poReceiptMirrorSql('p')} = 1 AND gl.purchase_id IS NULL
             THEN 1 ELSE 0 END                             AS understated,
        CASE WHEN p.is_emergency = 1 THEN 1 ELSE 0 END     AS is_emergency,
        ${BILL_KEY_SQL}                                    AS bill_key
      ${base}
    )
    ORDER BY date ASC, vendor COLLATE NOCASE ASC, bill_key ASC, item COLLATE NOCASE ASC, created_at ASC, id ASC
  `);
}

type DbRow = Record<string, unknown>;

function toLine(r: DbRow): Line {
  const subtotal = money(r.subtotal);
  const discount = money(r.discount);
  const cgst = money(r.cgst);
  const sgst = money(r.sgst);
  // The purchase log's per-line GST % (src/lib/purchase-log.ts docTax), through
  // the same helpers: blank where no GST was recorded, never 0%.
  const docTax = { cgst, sgst, discount, value: num(r.gst_base_value) };
  const gst = gstValue(docTax);
  return {
    date: String(r.date || ''),
    vendor: String(r.vendor || ''),
    bill_no: String(r.bill_no || ''),
    grn_no: String(r.grn_no || ''),
    invoice_id: String(r.invoice_id || ''),
    item: String(r.item || ''),
    sku: String(r.sku || ''),
    category: String(r.category || ''),
    qty: num(r.qty),
    unit: String(r.unit || ''),
    rate: num(r.rate),
    subtotal,
    discount,
    taxable: money(subtotal - discount),
    gst_percent: taxAppliedPercent(docTax),
    cgst,
    sgst,
    compensation_cess: money(r.compensation_cess),
    special_excise_cess: money(r.special_excise_cess),
    tcs: money(r.tcs),
    delivery_charges: money(r.delivery_charges),
    mrp_round_off: money(r.mrp_round_off),
    grand_total: money(r.grand_total),
    booked: money(r.booked),
    from_grn: num(r.from_grn) === 1,
    gst_base_accepted: num(r.gst_base_accepted) === 1 && gst != null && gst !== 0,
    understated: num(r.understated) === 1,
    unlinked: num(r.unlinked) === 1,
    bill_key: String(r.bill_key || ''),
    material_id: String(r.material_id ?? ''),
    vendor_raw: String(r.vendor_raw ?? ''),
    is_emergency: num(r.is_emergency) === 1,
  };
}

function addMoney(into: ItemwiseMoney, l: ItemwiseMoney) {
  for (const k of MONEY_KEYS) into[k] += l[k];
}

function kindOf(key: string): ItemwiseBillKind {
  if (key.startsWith('INV:')) return 'INV';
  if (key.startsWith('GRN:')) return 'GRN';
  if (key.startsWith('BILL:')) return 'BILL';
  return 'DAY';
}

/** The bill type in plain words, for the Bill-wise sheet. */
export const BILL_KIND_WORDS: Record<ItemwiseBillKind, string> = {
  INV: 'Our invoice (PINV)',
  GRN: 'Goods receipt (GRN)',
  BILL: 'Vendor bill number',
  DAY: 'No bill number: this vendor’s purchases that day',
};

function hasSubPaisa(l: Line): boolean {
  return MONEY_KEYS.some(k => Math.abs(l[k] - r2(l[k])) >= 1e-6);
}

/**
 * Build the item-wise list for a window and filters. SELECT only — the caller
 * owns the access gate.
 */
export function getPurchaseItemwise(f: ItemwiseFilters, dbArg?: DatabaseT.Database): ItemwiseResult {
  const db = dbArg || getDb();
  const vendor = (f.vendor || '').trim();
  const category = (f.category || '').trim();
  const materialId = (f.materialId || '').trim();
  const { base, params } = purchaseReportBase({ from: f.from, to: f.to, vendor, category, materialId });

  const lines = (db.prepare(lineSql(base)).all(...params) as DbRow[]).map(toLine);

  // THE SUMMARY'S OWN FIGURES — the identical statement /api/reports/purchases
  // runs for its cards, over the identical base.
  const sRaw = (db.prepare(withGrnCharges(purchaseReportSummarySql(base))).get(...params) || {}) as DbRow;
  const s = { ...sRaw, ...chargeSums(sRaw) };

  const totals = zeroMoney();
  const dates = new Map<string, { lines: number; bills: Set<string>; vendors: Set<string>; money: ItemwiseMoney }>();
  const bills = new Map<string, { date: string; vendor: string; bill_no: string; grn_no: string; invoice_id: string; lines: number; money: ItemwiseMoney }>();
  const vendorsRaw = new Set<string>();
  const items = new Set<string>();
  let emergency = 0;
  let partRejected = 0;
  let understated = 0;
  let subpaise = 0;

  for (const l of lines) {
    addMoney(totals, l);
    vendorsRaw.add(l.vendor_raw);
    items.add(l.material_id);
    if (l.is_emergency) emergency += l.booked;
    if (l.gst_base_accepted) partRejected++;
    if (l.understated) understated++;
    if (hasSubPaisa(l)) subpaise++;

    let d = dates.get(l.date);
    if (!d) { d = { lines: 0, bills: new Set(), vendors: new Set(), money: zeroMoney() }; dates.set(l.date, d); }
    d.lines++;
    d.bills.add(l.bill_key);
    d.vendors.add(l.vendor.toLowerCase());
    addMoney(d.money, l);

    // Grouped as the Purchase Bill Summary groups: date = the bill's first
    // line, MIN(vendor) and MAX() of each number, exactly as it reads them.
    let b = bills.get(l.bill_key);
    if (!b) {
      b = { date: l.date, vendor: l.vendor, bill_no: l.bill_no, grn_no: l.grn_no, invoice_id: l.invoice_id, lines: 0, money: zeroMoney() };
      bills.set(l.bill_key, b);
    }
    if (l.date < b.date) b.date = l.date;
    if (l.vendor < b.vendor) b.vendor = l.vendor;
    if (l.bill_no > b.bill_no) b.bill_no = l.bill_no;
    if (l.grn_no > b.grn_no) b.grn_no = l.grn_no;
    if (l.invoice_id > b.invoice_id) b.invoice_id = l.invoice_id;
    b.lines++;
    addMoney(b.money, l);
  }

  // Every aggregated money cell leaves here without float noise — the JSON
  // totals, and the Date-wise, Bill-wise and Totals sheets.
  cleanMoney(totals);
  for (const d of dates.values()) cleanMoney(d.money);
  for (const b of bills.values()) cleanMoney(b.money);
  emergency = clean(emergency);

  const date_rows: ItemwiseDateRow[] = [...dates.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, d]) => ({ date, lines: d.lines, bills: d.bills.size, vendors: d.vendors.size, money: d.money }));

  const bill_rows: ItemwiseBillRow[] = [...bills.entries()]
    .map(([bill_key, b]) => ({ bill_key, kind: kindOf(bill_key), ...b }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
      || a.vendor.localeCompare(b.vendor, 'en', { sensitivity: 'base' })
      || (a.bill_key < b.bill_key ? -1 : a.bill_key > b.bill_key ? 1 : 0));

  // ── THE CHECKS, every Summary card figure, named as on the Summary screen ──
  const m = (figure: string, linesV: number, summaryV: unknown): ItemwiseCheck => {
    const lv = clean(linesV);
    const sv = clean(num(summaryV));
    return { figure, kind: 'money', lines: lv, summary: sv, ok: paise(lv) === paise(sv) };
  };
  const c = (figure: string, linesV: number, summaryV: unknown): ItemwiseCheck =>
    ({ figure, kind: 'count', lines: linesV, summary: num(summaryV), ok: linesV === num(summaryV) });
  const checks: ItemwiseCheck[] = [
    m('Total Purchases (Grand Total)', totals.grand_total, s.total_amount),
    m('booked into stock (under Total Purchases)', totals.booked, sRaw.total_spend),
    c('Purchases', lines.length, sRaw.purchase_count),
    c('Purchases — days', dates.size, sRaw.day_count),
    c('Vendors', vendorsRaw.size, sRaw.vendor_count),
    c('Items', items.size, sRaw.item_count),
    m('Emergency Spend', emergency, sRaw.emergency_spend),
    m('Subtotal (goods)', totals.subtotal, s.bill_value),
    m('Less: Discount', totals.discount, s.discount),
    m('Taxes (CGST+SGST)', totals.cgst + totals.sgst, r2(num(s.cgst) + num(s.sgst))),
    m('Taxes — CGST', totals.cgst, s.cgst),
    m('Taxes — SGST', totals.sgst, s.sgst),
    m('Cess', totals.compensation_cess + totals.special_excise_cess, r2(num(s.compensation_cess) + num(s.special_excise_cess))),
    m('Cess — GST comp.', totals.compensation_cess, s.compensation_cess),
    m('Cess — Spl. excise', totals.special_excise_cess, s.special_excise_cess),
    m('TCS', totals.tcs, s.tcs),
    m('Transport / Delivery', totals.delivery_charges, s.delivery_charges),
    m('MRP Round-off', totals.mrp_round_off, s.mrp_round_off),
    m('Grand Total', totals.grand_total, s.total_amount),
  ];
  const proof: ItemwiseProof = {
    ok: checks.every(x => x.ok),
    lines: lines.length,
    grand_total: r2(totals.grand_total),
    summary_grand_total: clean(num(s.total_amount)),
    checks,
  };

  // ── THE BILL-WISE SHEET AGAINST THE PURCHASE BILL SUMMARY, bill by bill ──
  // Only with no filter on: the Bill Summary has no category or item filter
  // and matches a vendor by "contains", so under a filter a bill here can hold
  // only some of the lines the Bill Summary adds up for it.
  let bill_check: ItemwiseBillCheck;
  if (vendor || category || materialId) {
    bill_check = {
      compared: false,
      reason: category || materialId
        ? 'A category or item filter is on, so each bill here holds only its matching lines; bills were not compared one by one with the Purchase Bill Summary, which adds up every line of a bill.'
        : 'A vendor filter is on, and the Purchase Bill Summary matches a vendor by any part of its name, so bills were not compared one by one with it.',
      bills: bill_rows.length, matched: 0, differences: [],
    };
  } else {
    const bs = getPurchaseBillSummary({ from: f.from, to: f.to }, db);
    const theirs = new Map(bs.rows.map(b => [b.bill_key, b]));
    const differences: ItemwiseBillCheck['differences'] = [];
    let matched = 0;
    let unverified = 0;
    for (const b of bill_rows) {
      const t = theirs.get(b.bill_key);
      if (t && t.lines === b.lines && paise(t.total_bill_value) === paise(b.money.grand_total)) { matched++; continue; }
      if (!t && bs.truncated) { unverified++; continue; }
      differences.push({
        bill: billLabel(b), lines: b.lines, grand_total: r2(b.money.grand_total),
        bill_summary_lines: t ? t.lines : null, bill_summary_grand_total: t ? t.total_bill_value : null,
      });
    }
    // A bill the Bill Summary lists and this sheet does not.
    if (!bs.truncated) {
      for (const t of bs.rows) {
        if (!bills.has(t.bill_key)) {
          differences.push({ bill: `${t.vendor || '(no vendor)'} · ${t.date} · ${t.bill_key}`, lines: 0, grand_total: 0,
            bill_summary_lines: t.lines, bill_summary_grand_total: t.total_bill_value });
        }
      }
    }
    bill_check = {
      compared: true,
      reason: unverified > 0
        ? `${unverified} bill${unverified === 1 ? '' : 's'} could not be compared: the Purchase Bill Summary lists at most ${bs.rows.length} bills for one window.`
        : '',
      bills: bill_rows.length, matched, differences,
    };
  }

  let material_name = '';
  if (materialId) {
    const mrow = db.prepare('SELECT name FROM raw_materials WHERE id = ?').get(materialId) as { name?: string } | undefined;
    material_name = String(mrow?.name || '').trim() || `(material not linked · id ${materialId})`;
  }

  return {
    from: f.from, to: f.to, vendor, category, material_id: materialId, material_name,
    lines, bills: bill_rows.length, days: date_rows.length,
    totals, proof, bill_check, date_rows, bill_rows,
    part_rejected_lines: partRejected, understated_lines: understated, subpaise_lines: subpaise,
  };
}

/** The bill in plain words, for a difference line. */
function billLabel(b: ItemwiseBillRow): string {
  const nums = [b.invoice_id && `invoice ${b.invoice_id}`, b.grn_no, b.bill_no && `vendor bill ${b.bill_no}`].filter(Boolean).join(' · ');
  return `${b.vendor} · ${b.date}${nums ? ` · ${nums}` : ' · no bill number'}`;
}

/** The line as the screen receives it — the check-only fields dropped. */
export function toScreenRow(l: Line): ItemwiseRow {
  const { bill_key: _k, material_id: _m, vendor_raw: _v, is_emergency: _e, ...row } = l;
  void _k; void _m; void _v; void _e;
  return row;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE EXCEL FILE — four sheets, built from the result above.
 * ═══════════════════════════════════════════════════════════════════════════ */

const MONEY_FMT = '#,##0.00';
const DATE_FMT = 'dd-mmm-yyyy';

/** "2026-10-01" → the Excel day number, computed in UTC so no time zone can move it. */
function excelDate(ymd: string): number | string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return safeText(ymd || '');
  return (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/**
 * Formula-injection guard, as on every other export: a text cell that starts
 * with = + - @ (or a tab / carriage return) is written with a leading
 * apostrophe. Numbers never pass through here.
 */
function safeText(s: string): string {
  const v = String(s ?? '');
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function humanDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${+m[3]} ${MON[+m[2] - 1]} ${m[1]}`;
}

const rupees = (v: number) => {
  const x = r2(v);
  const body = '₹' + Math.abs(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return x < 0 ? `−${body}` : body;
};

type Fmt = 'text' | 'date' | 'money' | 'pct' | 'rate' | 'plain';
interface SheetCol { header: string; fmt: Fmt; wch: number }

/** A data-only sheet: header row + one row per record, formats per column. */
function dataSheet(cols: SheetCol[], rows: (string | number | null)[][]): XLSX.WorkSheet {
  const aoa: (string | number | null)[][] = [cols.map(c => c.header), ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let r = 1; r <= rows.length; r++) {
    cols.forEach((c, ci) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c: ci })];
      if (!cell || cell.t !== 'n') return;
      if (c.fmt === 'money') cell.z = MONEY_FMT;
      else if (c.fmt === 'date') cell.z = DATE_FMT;
      else if (c.fmt === 'pct') cell.z = '0.00';
      else if (c.fmt === 'rate') cell.z = '#,##0.00##';
    });
  }
  ws['!cols'] = cols.map(c => ({ wch: c.wch }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length), c: cols.length - 1 } }) };
  return ws;
}

const moneyCols = (keys: readonly ItemwiseMoneyKey[]): SheetCol[] =>
  keys.map(k => {
    const col = ITEMWISE_MONEY_COLUMNS.find(x => x.key === k)!;
    return { header: k === 'taxable' ? 'Taxable Value (Subtotal − Discount)' : col.header, fmt: 'money' as const, wch: k === 'booked' ? 17 : 14 };
  });

/** Money keys before GST % on the Item-wise sheet, and after it. */
const BEFORE_PCT: ItemwiseMoneyKey[] = ['subtotal', 'discount', 'taxable'];
const AFTER_PCT: ItemwiseMoneyKey[] = MONEY_KEYS.filter(k => !BEFORE_PCT.includes(k));

/**
 * Freeze the header row of the given sheets. xlsx 0.18.5 (community build)
 * writes no pane, so the one element Excel needs is placed into the sheet XML
 * after writing — only where the library's own exact sheetView tag is found,
 * so a different library output leaves the file valid, just unfrozen.
 */
/** The slice of the bundled CFB (zip) API used below. */
interface ZipEntry { content?: Uint8Array | Buffer; size?: number }
interface ZipApi {
  read(data: Buffer, opts: { type: 'buffer' }): unknown;
  find(zip: unknown, path: string): ZipEntry | null;
  write(zip: unknown, opts: { fileType: 'zip'; type: 'buffer'; compression: boolean }): Uint8Array;
}

function freezeHeaderRows(buf: Buffer, sheetNumbers: number[]): Buffer {
  const CFB = (XLSX as unknown as { CFB: ZipApi }).CFB;
  const zip = CFB.read(buf, { type: 'buffer' });
  const TAG = '<sheetView workbookViewId="0"/>';
  const FROZEN = '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    + '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>';
  let changed = 0;
  for (const n of sheetNumbers) {
    const entry = CFB.find(zip, `/xl/worksheets/sheet${n}.xml`);
    if (!entry || !entry.content) continue;
    const xml = Buffer.from(entry.content).toString('utf8');
    if (!xml.includes(TAG)) continue;
    const out = Buffer.from(xml.replace(TAG, FROZEN), 'utf8');
    entry.content = out;
    entry.size = out.length;
    changed++;
  }
  if (!changed) return buf;
  return Buffer.from(CFB.write(zip, { fileType: 'zip', type: 'buffer', compression: true }));
}

export function itemwiseFilename(from: string, to: string): string {
  return `purchases-itemwise-${from}_${to}.xlsx`;
}

/** The four-sheet workbook. */
export function buildItemwiseWorkbook(res: ItemwiseResult, generatedAt: Date = new Date()): Buffer {
  const wb = XLSX.utils.book_new();

  // 1 ── Item-wise: the data rows ONLY.
  const itemCols: SheetCol[] = [
    { header: 'Date', fmt: 'date', wch: 12 },
    { header: 'Vendor', fmt: 'text', wch: 28 },
    { header: 'Vendor Bill No', fmt: 'text', wch: 14 },
    { header: 'GRN No', fmt: 'text', wch: 14 },
    { header: 'Our Invoice ID (PINV)', fmt: 'text', wch: 16 },
    { header: 'Item', fmt: 'text', wch: 34 },
    { header: 'SKU', fmt: 'text', wch: 11 },
    { header: 'Category', fmt: 'text', wch: 16 },
    { header: 'Qty', fmt: 'plain', wch: 8 },
    { header: 'Purchase Unit', fmt: 'text', wch: 10 },
    { header: 'Rate', fmt: 'rate', wch: 11 },
    ...moneyCols(BEFORE_PCT),
    { header: 'GST %', fmt: 'pct', wch: 7 },
    ...moneyCols(AFTER_PCT),
  ];
  const itemRows = res.lines.map(l => [
    excelDate(l.date), safeText(l.vendor), safeText(l.bill_no), safeText(l.grn_no), safeText(l.invoice_id),
    safeText(l.item), safeText(l.sku), safeText(l.category), l.qty, safeText(l.unit), l.rate,
    ...BEFORE_PCT.map(k => l[k]),
    l.gst_percent,
    ...AFTER_PCT.map(k => l[k]),
  ]);
  XLSX.utils.book_append_sheet(wb, dataSheet(itemCols, itemRows), 'Item-wise');

  // 2 ── Date-wise.
  const dayMoney = MONEY_KEYS;
  const dateCols: SheetCol[] = [
    { header: 'Date', fmt: 'date', wch: 12 },
    { header: 'Lines', fmt: 'plain', wch: 7 },
    { header: 'Bills', fmt: 'plain', wch: 7 },
    { header: 'Vendors', fmt: 'plain', wch: 8 },
    ...moneyCols(dayMoney),
  ];
  const dateRows = res.date_rows.map(d => [excelDate(d.date), d.lines, d.bills, d.vendors, ...dayMoney.map(k => d.money[k])]);
  XLSX.utils.book_append_sheet(wb, dataSheet(dateCols, dateRows), 'Date-wise');

  // 3 ── Bill-wise.
  const billCols: SheetCol[] = [
    { header: 'Date', fmt: 'date', wch: 12 },
    { header: 'Vendor', fmt: 'text', wch: 28 },
    { header: 'Vendor Bill No', fmt: 'text', wch: 14 },
    { header: 'GRN No', fmt: 'text', wch: 14 },
    { header: 'Our Invoice ID (PINV)', fmt: 'text', wch: 16 },
    { header: 'Lines', fmt: 'plain', wch: 7 },
    ...moneyCols(dayMoney),
    { header: 'Bill type', fmt: 'text', wch: 40 },
  ];
  const billRows = res.bill_rows.map(b => [
    excelDate(b.date), safeText(b.vendor), safeText(b.bill_no), safeText(b.grn_no), safeText(b.invoice_id), b.lines,
    ...dayMoney.map(k => b.money[k]),
    BILL_KIND_WORDS[b.kind],
  ]);
  XLSX.utils.book_append_sheet(wb, dataSheet(billCols, billRows), 'Bill-wise');

  // 4 ── Totals: what the file is, every Summary figure, and the checks.
  XLSX.utils.book_append_sheet(wb, totalsSheet(res, generatedAt), 'Totals');

  const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
  return freezeHeaderRows(raw, [1, 2, 3]);
}

/** The same column added up on the Date-wise and Bill-wise sheets. */
function sheetSum(rows: { money: ItemwiseMoney }[], keys: ItemwiseMoneyKey[]): number {
  let t = 0;
  for (const r of rows) for (const k of keys) t += r.money[k];
  return clean(t);
}

/** Which money columns make up each money check, for the Date-wise / Bill-wise sums. */
const CHECK_KEYS: Record<string, ItemwiseMoneyKey[]> = {
  'Total Purchases (Grand Total)': ['grand_total'],
  'booked into stock (under Total Purchases)': ['booked'],
  'Subtotal (goods)': ['subtotal'],
  'Less: Discount': ['discount'],
  'Taxes (CGST+SGST)': ['cgst', 'sgst'],
  'Taxes — CGST': ['cgst'],
  'Taxes — SGST': ['sgst'],
  'Cess': ['compensation_cess', 'special_excise_cess'],
  'Cess — GST comp.': ['compensation_cess'],
  'Cess — Spl. excise': ['special_excise_cess'],
  'TCS': ['tcs'],
  'Transport / Delivery': ['delivery_charges'],
  'MRP Round-off': ['mrp_round_off'],
  'Grand Total': ['grand_total'],
};

function totalsSheet(res: ItemwiseResult, generatedAt: Date): XLSX.WorkSheet {
  const filtered = !!(res.vendor || res.category || res.material_id);
  const aoa: (string | number | null)[][] = [];
  aoa.push(['Purchases — item-wise, date-wise and bill-wise']);
  aoa.push(['Period', `${humanDate(res.from)} to ${humanDate(res.to)}`]);
  aoa.push(['Vendor', res.vendor ? safeText(res.vendor) : 'All vendors']);
  aoa.push(['Category', res.category ? safeText(res.category) : 'All categories']);
  aoa.push(['Item', res.material_id ? safeText(res.material_name) : 'All items']);
  aoa.push(['Generated', fmtIST(generatedAt)]);
  aoa.push(['Lines in this file', res.lines.length]);
  aoa.push([]);

  aoa.push([
    res.material_id ? 'Figure (as named on the Summary tab)' : 'Summary card (as named on the Summary tab)',
    res.material_id ? 'Summary arithmetic, this item' : (filtered ? 'Summary, same filters' : 'Summary'),
    'Item-wise sheet', 'Date-wise sheet', 'Bill-wise sheet', 'Check',
  ]);
  const moneyRowIdx: number[] = [];
  for (const ch of res.proof.checks) {
    const keys = CHECK_KEYS[ch.figure];
    let dateV: number | null = null;
    let billV: number | null = null;
    if (ch.figure === 'Purchases') {
      dateV = res.date_rows.reduce((n, d) => n + d.lines, 0);
      billV = res.bill_rows.reduce((n, b) => n + b.lines, 0);
    } else if (ch.figure === 'Purchases — days') {
      dateV = res.date_rows.length;
    } else if (keys) {
      dateV = sheetSum(res.date_rows, keys);
      billV = sheetSum(res.bill_rows, keys);
    }
    const eq = (v: number | null) => v == null
      || (ch.kind === 'money' ? paise(v) === paise(ch.summary) : v === ch.summary);
    const all = ch.ok && eq(dateV) && eq(billV);
    const sheets = [
      'Item-wise',
      ...(dateV != null ? ['Date-wise'] : []), ...(billV != null ? ['Bill-wise'] : []),
    ];
    // The emergency mark is not a column of the Item-wise sheet, so say where
    // the figure was worked out from rather than send the reader looking for it.
    const how = ch.figure === 'Emergency Spend'
      ? ' (worked out from the lines marked emergency in the app — that mark is not a column in this file)'
      : '';
    const verdict = all
      ? `✓ ${sheets.join(' = ')} = Summary${how}`
      : `✗ DOES NOT MATCH — report it (Item-wise ${ch.kind === 'money' ? rupees(ch.lines) : ch.lines}, Summary ${ch.kind === 'money' ? rupees(ch.summary) : ch.summary})`;
    if (ch.kind === 'money') moneyRowIdx.push(aoa.length);
    aoa.push([ch.figure, ch.summary, ch.lines, dateV, billV, verdict]);
  }
  // Taxable value is not a card; its column is Subtotal − Discount, said once.
  const taxableRow = aoa.length;
  aoa.push([
    'Taxable Value (Subtotal − Discount) — not a card',
    r2(num(res.proof.checks.find(x => x.figure === 'Subtotal (goods)')?.summary) - num(res.proof.checks.find(x => x.figure === 'Less: Discount')?.summary)),
    res.totals.taxable,
    sheetSum(res.date_rows, ['taxable']),
    sheetSum(res.bill_rows, ['taxable']),
    '',
  ]);
  {
    const t = aoa[taxableRow];
    const ok = [t[2], t[3], t[4]].every(v => paise(num(v)) === paise(num(t[1])));
    t[5] = ok ? '✓ Item-wise = Date-wise = Bill-wise = Subtotal − Discount' : '✗ DOES NOT MATCH — report it';
  }
  moneyRowIdx.push(taxableRow);

  aoa.push([]);
  const counts = `${res.lines.length} line${res.lines.length === 1 ? '' : 's'} · ${res.bills} bill${res.bills === 1 ? '' : 's'} · ${res.days} day${res.days === 1 ? '' : 's'}`;
  aoa.push(['In this file', counts]);
  aoa.push([]);

  // ── NOTES — five, short and plain, the same on every file (ruling: 3–5) ──
  const notes: string[] = [
    // Round 2: qualified for an item filter, which the Summary tab does not have.
    'One line on the Item-wise sheet = one item on one purchase entry. With no item filter set, these are exactly the lines the Summary tab adds up for the same dates and filters, so every money column adds up to its Summary figure (the checks above; Taxable Value is Subtotal − Discount and has no card of its own).',
    'Purchase orders are not in this file: an order is not a purchase until it is received. Goods received against a PO appear once, with the GRN bill’s tax and charges on the line, so nothing is counted twice.',
    // Round 3: short plain sentences, true for every kind of line (see the
    // Subtotal column's note in src/lib/purchase-itemwise-columns.ts): the
    // GRN line's value and discount exactly when the row has no PINV and its
    // GRN line is on record; every other line books its Subtotal as stored.
    'Grand Total = Subtotal − Discount + CGST + SGST + both cesses + TCS + Delivery + MRP Round-off: what is payable to the vendors. Booked into stock and Rate are as recorded into stock. Where a line has no PINV of ours and its GRN bill line is on record (goods received against a PO, or an older goods receipt), Subtotal and Discount are that GRN line’s own, so the Subtotal can differ from Booked into stock. On every other line the Subtotal is the booked value: a discount taken off the rate is inside it, so Discount can read 0. A few older bills entered in bulk have their tax inside the Subtotal.',
    'Date-wise and Bill-wise add up the same lines per day and per bill. Bills are grouped as on the Purchase Bill Summary; a vendor’s purchases with no bill number on one day count as one bill, dated by its first line.',
    'Purchase orders, GRN bills and purchase entries side by side are in the audit file: Purchase Report → Purchase log → All documents (audit) → Download CSV. Never add its three document types together — they are the same goods seen three ways.',
  ];
  // ── WHAT WAS FOUND IN THIS FILE — only the lines that apply to it ──
  const found: string[] = [];
  if (res.material_id) {
    // Round 3: said for 0, 1 and many lines.
    const n = res.lines.length;
    const over = n === 0 ? 'for this item, which has no lines in these dates and filters'
      : n === 1 ? 'run over this item’s 1 line' : 'run over this item’s lines';
    found.push(`Item filter on: the Summary tab has no item filter, so the second column above is the Summary’s own arithmetic ${over}.`);
  }
  if (res.bill_check.compared) {
    const diffs = res.bill_check.differences.length;
    const nLines = (n: number) => `${n} line${n === 1 ? '' : 's'}`;
    found.push(diffs === 0
      ? billMatchSentence(res.bill_check, true)
      : `✗ ${billsDoNot(diffs)} match the Purchase Bill Summary for the same dates (Bill-wise sheet) — report it: `
        + res.bill_check.differences.slice(0, 10).map(d => `${d.bill} (here ${nLines(d.lines)} ${rupees(d.grand_total)}; Bill Summary ${d.bill_summary_lines == null ? 'no such bill' : `${nLines(d.bill_summary_lines)} ${rupees(num(d.bill_summary_grand_total))}`})`).join(' | ')
        + (diffs > 10 ? ` | and ${diffs - 10} more` : ''));
  } else if (filtered && res.bill_check.bills > 0) {
    // Round 3: with no bills in the file, why bills were not compared says nothing.
    found.push(res.bill_check.reason);
  }
  if (res.part_rejected_lines > 0) found.push(`GST %: ${acceptedBaseTotalNote(res.part_rejected_lines, true)}`);
  if (res.understated_lines > 0) {
    // Round 3: plural forms for many lines; only the GRN line's own tax and
    // charges are missing (a charge stored on the purchase row still shows).
    found.push(res.understated_lines === 1
      ? '⚠ 1 line was booked from a goods receipt whose GRN line (the bill document) has since been deleted: the tax and any charges recorded only on that GRN line are missing, so the Grand Total is UNDERSTATED by an amount that cannot be known from here. The Summary shows the same short figure. Do not pay a vendor against it — report it.'
      : `⚠ ${res.understated_lines} lines were booked from goods receipts whose GRN lines (the bill documents) have since been deleted: the tax and any charges recorded only on those GRN lines are missing, so the Grand Total is UNDERSTATED by an amount that cannot be known from here. The Summary shows the same short figure. Do not pay a vendor against it — report it.`);
  }
  if (res.subpaise_lines > 0) {
    found.push(`${res.subpaise_lines} line${res.subpaise_lines === 1 ? ' holds' : 's hold'} a fraction of a paisa, as stored. Cells show two decimals but keep the exact figure, so every column still adds up to the Summary to the paisa.`);
  }
  aoa.push(['Notes']);
  notes.forEach((n, i) => aoa.push([`${i + 1}. ${n}`]));
  if (found.length) {
    aoa.push([]);
    aoa.push(['Found in this file']);
    found.forEach(n => aoa.push([`• ${n}`]));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Money figures in the checks table carry the money format; counts stay plain.
  for (const r of moneyRowIdx) {
    for (let ci = 1; ci <= 4; ci++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: ci })];
      if (cell && cell.t === 'n') cell.z = MONEY_FMT;
    }
  }
  ws['!cols'] = [{ wch: 46 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 52 }];
  return ws;
}
