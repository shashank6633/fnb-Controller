import type DatabaseT from 'better-sqlite3';
import { getDb } from './db';
import { todayIST } from './format-date';

/**
 * PURCHASE LOG — one row per ITEM per BILL, across all three procurement
 * sources (direct purchases, purchase orders, goods receipt notes), in one
 * chronological list the owner can download as a single CSV.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MODEL — WHY THESE THREE SOURCES ARE **NOT** ADDITIVE
 * ═══════════════════════════════════════════════════════════════════════════
 * Receiving a PO (src/app/api/purchase-orders/[id]/receive/route.ts) writes,
 * inside ONE transaction, for a single physical delivery:
 *
 *   1 × po_vendor_bills       — the vendor's bill event on that PO
 *   1 × goods_receipt_notes   — the GRN header (grn_number = GRN-<yyyy>-####)
 *   N × goods_receipt_note_items — one per received line, at GROSS bill rates
 *   N × purchases             — one per line with accepted > 0, at NET rates
 *
 * The ad-hoc path (POST /api/grn) does the same minus the PO: a GRN header,
 * GRN items, and a mirrored `purchases` row per accepted line.
 *
 * So a received PO line exists THREE times in the database:
 *   • purchase_order_items — what we ORDERED   (a commitment, not a spend)
 *   • goods_receipt_note_items — what the vendor BILLED (gross, the document)
 *   • purchases            — what we BOOKED    (net, the cost/stock entry)
 *
 * They are the same money. A naive UNION total would read ~2–3× the real
 * spend, and that is exactly the number an owner would quote. Hence:
 *   → totals are returned PER SOURCE and never summed (see PurchaseLogTotals),
 *   → every row carries `source`,
 *   → every row that belongs to one receipt event carries the same `link_key`.
 *
 * ── THE LINK. There is NO foreign key from `purchases` back to its GRN. ──
 * The only tie that exists in the schema is the GRN NUMBER, written literally
 * into `purchases.notes` by both writers, in the same transaction that minted
 * it (so it is always present and always correct):
 *
 *   PO receive : "Received against PO-2026-0001 (GRN GRN-2026-0007)"
 *                                                    ^^^^^^^^^^^^^
 *   Ad-hoc GRN : "Ad-hoc GRN GRN-2026-0007 · invoice 4841"
 *   Correction : "BACK-CORRECTION GRN GRN-2026-0007 · invoice 4841"
 *
 * A PO line reaches its GRN line through goods_receipt_note_items.po_item_id.
 * Chaining the two gives the receipt-event key used here:
 *
 *   link_key = "<grn_number>#<material_id>"
 *
 * present on the GRN line, on the `purchases` row it created, and on the PO
 * line it was received against. Sort or filter a download by link_key and the
 * three faces of one delivery sit together — the duplication is VISIBLE, which
 * is the whole point, rather than silently resolved by dropping a source.
 * link_key is null on a direct purchase (no GRN) and on a PO line not yet
 * received (or received outside the requested date window).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNITS — the standing error in this codebase, avoided here deliberately
 * ═══════════════════════════════════════════════════════════════════════════
 * purchases.quantity, purchase_order_items.quantity and the GRN quantity
 * columns are ALL ALREADY IN PURCHASE UNITS, and all three unit_price columns
 * are ₹ PER PURCHASE UNIT. pack_size / packFactor MUST NOT be applied to any
 * of them — that conversion belongs only on the way into raw_materials
 * .current_stock (recipe units). This file therefore never imports pack-units.
 * `purchase_unit` is printed beside every quantity so no reader can mistake a
 * "3" for 3 recipe units when it is 3 cases.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RATES — two legitimate rates for the same line
 * ═══════════════════════════════════════════════════════════════════════════
 * GRN rate is GROSS (what the bill document says, discount in its own column).
 * purchases.unit_price is NET of the allocated discount, because
 * updateMaterialPrice() averages SUM(qty × unit_price)/SUM(qty) and never
 * reads a discount column. The receive route therefore writes purchases
 * .discount as a LITERAL 0 on that path — a zero in the Discount column of a
 * PURCHASE row does NOT mean "no discount was given", it means the discount is
 * already inside the rate and lives, itemised, on the GRN row that shares this
 * row's link_key. The report shows both rates, labelled by source, and never
 * reconciles them silently.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * OTHER DECISIONS, STATED SO THEY CAN BE ARGUED WITH
 * ═══════════════════════════════════════════════════════════════════════════
 * • invoice_id vs bill_no are different things and get their own columns:
 *   invoice_id = OUR generated PINV-<yyyy>-#### (one per vendor bill, purchases
 *   only — POs and GRNs never mint one). bill_no = the VENDOR's own number.
 *   There is NO third fallback: purchases.invoice_number is not in this schema
 *   (see the note on the PURCHASE branch below). goods_receipt_notes DOES have
 *   an invoice_number — that one is real and is used on the GRN branch.
 * • The 8 per-line charges (discount, cgst, sgst, special_excise_cess,
 *   compensation_cess, tcs, delivery_charges, mrp_round_off) are RECORDED-ONLY.
 *   `value` is the item value and does NOT include them. They are null — not 0
 *   — on PO rows, because purchase_order_items has no such columns at all.
 *   compensation_cess is GST COMPENSATION CESS (the levy under the GST
 *   (Compensation to States) Act — aerated drinks, tobacco). It is NOT
 *   special_excise_cess, which means TGBCL Special Excise Cess everywhere it is
 *   read or labelled, and it is NOT part of the cgst + sgst invariant: it is a
 *   separate levy, never halved, and adding it to that pair would misstate the
 *   GST on a return. It exists on `purchases` only — goods_receipt_note_items
 *   has no such column — so it is null on GRN rows as well as PO rows.
 * • GRN qty is quantity_ACCEPTED (what became stock and became a purchases
 *   row), so qty × rate = value holds. quantity_rejected rides in its own
 *   column; received = qty + qty_rejected.
 * • PO rows exclude status draft / cancelled / rejected — a draft was never
 *   placed and a cancelled/rejected order will never be spend. Every other
 *   status is included with the status stamped into `notes`.
 * • raw_materials is LEFT JOINed, not inner JOINed (which /api/reports/purchases
 *   does): a log that silently drops a purchase because its material row was
 *   deleted is a wrong log. Such rows show "(unknown item)".
 * • No outlet scoping, matching the sibling /api/reports/purchases, so the two
 *   reports reconcile.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types (the route and the page import these — keep the shape stable)
// ─────────────────────────────────────────────────────────────────────────────

export type PurchaseLogSource = 'PURCHASE' | 'PO' | 'GRN';

/** ?source= filter values accepted on the wire. */
export type PurchaseLogSourceFilter = 'all' | 'purchase' | 'po' | 'grn';

export interface PurchaseLogRow {
  /** Which table this row came from. Rows are NEVER additive across sources. */
  source: PurchaseLogSource;
  /** YYYY-MM-DD (IST calendar date as stored). */
  date: string;
  /** PINV-… / PO-… / GRN-… — the document this line sits on. */
  doc_no: string;
  /** OUR number (PINV-yyyy-####). Purchases only; '' on PO/GRN rows. */
  invoice_id: string;
  /** The VENDOR'S own bill number. Never conflate with invoice_id. */
  bill_no: string;
  vendor: string;
  material: string;
  sku: string;
  category: string;
  /** ALREADY in purchase units — never multiplied by pack_size. */
  qty: number;
  purchase_unit: string;
  /** ₹ per PURCHASE unit. GROSS on GRN rows, NET of discount on PURCHASE rows. */
  rate: number;
  /** qty × rate. Excludes the 7 recorded-only charges below. */
  value: number;
  /** GRN rows only (units turned away at QC); null on PURCHASE/PO rows. */
  qty_rejected: number | null;
  // ── Recorded-only charges. null on PO rows (no such columns exist there).
  discount: number | null;
  cgst: number | null;
  sgst: number | null;
  special_excise_cess: number | null;
  /** GST compensation cess. PURCHASE rows only — null on GRN and PO rows. */
  compensation_cess: number | null;
  tcs: number | null;
  delivery_charges: number | null;
  mrp_round_off: number | null;
  /** "<grn_number>#<material_id>" — the one receipt event behind up to 3 rows. */
  link_key: string | null;
  notes: string;
}

export interface PurchaseLogTotals {
  /** Rows matching the filters BEFORE any truncation. */
  lines: number;
  /**
   * SPEND. This is the only figure that equals money booked against cost —
   * `purchases` is the table every cost report and the weighted-average price
   * read back. Do not add the two below to it.
   */
  purchase_value: number;
  /**
   * ORDERED, not spent. A commitment on purchase_order_items; the matching
   * spend, once received, is already inside purchase_value.
   */
  po_value: number;
  /**
   * BILLED at gross bill rates. The SAME money as the mirrored part of
   * purchase_value, restated as the vendor's document states it.
   */
  grn_value: number;
  // ── Additive detail (beyond the agreed four) — this is what makes the
  //    double-count arithmetic checkable instead of a claim in a header.
  purchase_lines: number;
  po_lines: number;
  grn_lines: number;
  /** Part of purchase_value that is a mirror of a GRN line (link_key set). */
  purchase_value_mirrored_from_grn: number;
  /** Part of purchase_value entered directly, with no GRN behind it. */
  purchase_value_direct: number;
  /**
   * Plain-English statement of what may and may not be added. Render this
   * verbatim next to any total; it is the guard against the one misreading
   * that matters.
   */
  basis: string;
}

export interface PurchaseLogResult {
  rows: PurchaseLogRow[];
  totals: PurchaseLogTotals;
  /** true when `lines` exceeded PURCHASE_LOG_MAX_ROWS and rows were capped. */
  truncated: boolean;
  from: string;
  to: string;
}

export interface PurchaseLogFilters {
  from?: string | null;
  to?: string | null;
  vendor?: string | null;
  material_id?: string | null;
  source?: PurchaseLogSourceFilter | null;
}

/**
 * Hard cap on returned rows. A silently truncated report is a wrong report, so
 * `truncated` is reported alongside and `totals` are computed by SQL aggregate
 * over the FULL filtered set — the cap never distorts a number.
 */
export const PURCHASE_LOG_MAX_ROWS = 50_000;

const TOTALS_BASIS =
  'PURCHASE = money booked (the spend). GRN = the same money restated at gross bill rates. '
  + 'PO = ordered, not spent. These three DO NOT add up — adding them roughly doubles the spend.';

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isYmd = (s: unknown): s is string => typeof s === 'string' && YMD.test(s);
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const nullNum = (v: unknown): number | null =>
  v === null || v === undefined ? null : (Number.isFinite(Number(v)) ? r2(Number(v)) : null);

/**
 * Calendar arithmetic on a YYYY-MM-DD string via UTC, deliberately.
 * `new Date('2026-08-02')` parses as UTC midnight and then renders in the
 * server's local zone, which lands on the previous day west of Greenwich —
 * that is how a "last 30 days" default silently becomes 29 or 31.
 */
function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/**
 * Resolve the requested window, defaulting to the last 30 days INCLUSIVE of
 * today in IST (today − 29 … today). Invalid or missing values fall back to
 * the default rather than throwing, and a reversed range is swapped — a report
 * that returns nothing because from > to looks identical to "no purchases".
 */
export function resolvePurchaseLogRange(
  from?: string | null,
  to?: string | null,
): { from: string; to: string } {
  const today = todayIST();
  let f = isYmd(from) ? from : addDaysYmd(today, -29);
  let t = isYmd(to) ? to : today;
  if (f > t) [f, t] = [t, f];
  return { from: f, to: t };
}

/**
 * Pull "GRN-yyyy-####" out of the tail SQL handed us (the substring of
 * purchases.notes starting at the first 'GRN-'). Anchored, so an unrelated note
 * that merely mentions GRN cannot fabricate a link.
 */
const GRN_TOKEN = /^(GRN-\d{4}-\d+)/;
function grnFromNoteTail(tail: unknown): string | null {
  const m = GRN_TOKEN.exec(String(tail || '').trim());
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The query
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every branch of the UNION must project the SAME columns in the SAME order —
 * SQLite matches compound SELECTs positionally, so a column added to one branch
 * and not the others silently shifts every value to its right.
 *
 * SHAPE / EFFICIENCY. One compound SELECT, wrapped once for the ordered+capped
 * row fetch and once for the GROUP BY totals. Each branch is driven by its
 * table's indexed date column (idx_purchases_date, idx_po_date, idx_grn_date),
 * so the range — not the table size — bounds the scan. The only lookups that
 * are not a plain index seek are two CORRELATED SCALAR subqueries on the PO and
 * GRN branches; both start from idx_po_vendor_bills_po / idx_grn_po, i.e. the
 * handful of bills or GRNs belonging to ONE po_id, then idx_grni_grn inside it.
 * That keeps them O(receipts-of-this-PO) per row instead of the full scan a
 * LEFT JOIN on the unindexed goods_receipt_note_items.po_item_id would cost —
 * and, being scalar, they cannot fan a PO line into one row per GRN the way a
 * multi-vendor PO would with a join.
 */
function buildUnion(f: {
  from: string; to: string; vendor: string; materialId: string; source: PurchaseLogSourceFilter;
}): { sql: string; params: any[] } {
  const parts: string[] = [];
  const params: any[] = [];
  const want = (s: PurchaseLogSourceFilter) => f.source === 'all' || f.source === s;

  // Shared fragments. Bound per-branch (each takes its own copy of the params).
  const matFilter = (col: string) => (f.materialId ? ` AND ${col} = ?` : '');
  // CONTAINS, not equality. The filter on screen is a free-text box with a
  // datalist, and a datalist constrains nothing — typing "Metro" against a
  // stored "Metro Cash & Carry Pvt Ltd" matched zero rows and the page rendered
  // three Rs 0 totals. A silent wrong answer is worse than an error, and worse
  // than a slightly loose match.
  const venFilter = (expr: string) => (f.vendor ? ` AND LOWER(TRIM(${expr})) LIKE '%' || LOWER(TRIM(?)) || '%'` : '');

  // ── PURCHASE ──────────────────────────────────────────────────────────────
  if (want('purchase')) {
    parts.push(`
      SELECT
        'PURCHASE'                                        AS source,
        3                                                 AS source_rank,
        p.id                                              AS row_id,
        COALESCE(p.material_id, '')                       AS material_id,
        p.date                                            AS date,
        -- DO NOT add p.invoice_number back as a fallback here. That column is
        -- NOT part of this schema: CREATE TABLE purchases never declares it
        -- and no ALTER adds it, unlike the eight columns that are migrated at
        -- db.ts:2134-2155. Databases that happen to carry it got it out of band,
        -- and it is empty in every row even there — so referencing it bought
        -- nothing and made this whole report a hard 500 ("no such column:
        -- p.invoice_number") on any database without it. The vendor's own
        -- number lives in p.bill_no; ours is p.invoice_id.
        COALESCE(NULLIF(TRIM(p.invoice_id), ''),
                 NULLIF(TRIM(p.bill_no), ''), '')         AS doc_no,
        COALESCE(TRIM(p.invoice_id), '')                  AS invoice_id,
        COALESCE(TRIM(p.bill_no), '')                     AS bill_no,
        COALESCE(TRIM(p.vendor), '')                      AS vendor,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        p.quantity                                        AS qty,
        COALESCE(NULLIF(rm.purchase_unit, ''), rm.unit, '') AS purchase_unit,
        p.unit_price                                      AS rate,
        COALESCE(p.total_price, p.quantity * p.unit_price) AS value,
        NULL                                              AS qty_rejected,
        p.discount, p.cgst, p.sgst, p.special_excise_cess,
        -- GST compensation cess. A DIFFERENT levy from special_excise_cess
        -- (which is TGBCL's) and deliberately outside the cgst + sgst pair —
        -- it is never split into halves and must not be folded into the GST
        -- figure a return is filed on. Recorded-only, like its 7 siblings.
        p.compensation_cess,
        p.tcs, p.delivery_charges, p.mrp_round_off,
        -- Tail of the note starting at the GRN number, if any. The regex that
        -- turns this into a link_key lives in JS; SQLite has no REGEXP here.
        CASE WHEN instr(COALESCE(p.notes, ''), 'GRN-') > 0
             THEN substr(p.notes, instr(p.notes, 'GRN-'))
             ELSE '' END                                  AS link_raw,
        -- MUST agree with grnFromNoteTail()'s anchored /^GRN-\d{4}-\d+/ regex.
        -- A bare instr(notes,'GRN-') also matched a free-text note that merely
        -- mentions a GRN, so a purchase counted as "mirrored from a GRN" while
        -- link_key stayed null — money moved between
        -- purchase_value_mirrored_from_grn and _direct with nothing tying it to
        -- a receipt. GLOB gives the same digit-shape test SQLite-side.
        CASE WHEN COALESCE(p.notes, '') GLOB '*GRN-[0-9][0-9][0-9][0-9]-[0-9]*'
             THEN 1 ELSE 0 END AS is_mirror,
        COALESCE(p.notes, '')                             AS notes
      FROM purchases p
      LEFT JOIN raw_materials rm ON rm.id = p.material_id
      WHERE p.date >= ? AND p.date <= ?${venFilter('p.vendor')}${matFilter('p.material_id')}
    `);
    params.push(f.from, f.to);
    if (f.vendor) params.push(f.vendor);
    if (f.materialId) params.push(f.materialId);
  }

  // ── GRN ───────────────────────────────────────────────────────────────────
  if (want('grn')) {
    parts.push(`
      SELECT
        'GRN'                                             AS source,
        2                                                 AS source_rank,
        gi.id                                             AS row_id,
        COALESCE(gi.material_id, '')                      AS material_id,
        g.date                                            AS date,
        g.grn_number                                      AS doc_no,
        ''                                                AS invoice_id,
        -- The GRN header carries the bill number on both writers; po_vendor_bills
        -- is the fallback for older PO receives that left invoice_number blank.
        COALESCE(NULLIF(TRIM(g.invoice_number), ''),
                 (SELECT TRIM(b.bill_no) FROM po_vendor_bills b
                   WHERE b.po_id = g.po_id
                     AND LOWER(TRIM(b.vendor_name)) = LOWER(TRIM(COALESCE(g.vendor, '')))
                   ORDER BY b.created_at LIMIT 1), '')    AS bill_no,
        COALESCE(TRIM(g.vendor), '')                      AS vendor,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        -- ACCEPTED, not received: this is the qty that became stock and became
        -- the mirrored purchases row, so qty × rate = value holds.
        gi.quantity_accepted                              AS qty,
        COALESCE(NULLIF(rm.purchase_unit, ''), rm.unit, '') AS purchase_unit,
        gi.unit_price                                     AS rate,
        ROUND(gi.quantity_accepted * gi.unit_price, 2)    AS value,
        gi.quantity_rejected                              AS qty_rejected,
        gi.discount, gi.cgst, gi.sgst, gi.special_excise_cess,
        -- goods_receipt_note_items has NO compensation_cess column; GST
        -- compensation cess is recorded on the purchases table only. NULL, not
        -- 0 (a receipt note carries no such levy, it is not "zero cess"), and
        -- aliased explicitly — with ?source=grn this branch is the FIRST of the
        -- compound SELECT and its names become the outer SELECT *'s names.
        NULL AS compensation_cess,
        gi.tcs, gi.delivery_charges, gi.mrp_round_off,
        g.grn_number                                      AS link_raw,
        0                                                 AS is_mirror,
        COALESCE(NULLIF(TRIM(gi.notes), ''), TRIM(COALESCE(g.notes, ''))) AS notes
      FROM goods_receipt_note_items gi
      JOIN goods_receipt_notes g ON g.id = gi.grn_id
      LEFT JOIN raw_materials rm ON rm.id = gi.material_id
      WHERE g.date >= ? AND g.date <= ?${venFilter('g.vendor')}${matFilter('gi.material_id')}
    `);
    params.push(f.from, f.to);
    if (f.vendor) params.push(f.vendor);
    if (f.materialId) params.push(f.materialId);
  }

  // ── PO ────────────────────────────────────────────────────────────────────
  if (want('po')) {
    parts.push(`
      SELECT
        'PO'                                              AS source,
        1                                                 AS source_rank,
        poi.id                                            AS row_id,
        COALESCE(poi.material_id, '')                     AS material_id,
        po.date                                           AS date,
        po.po_number                                      AS doc_no,
        ''                                                AS invoice_id,
        COALESCE((SELECT TRIM(b.bill_no) FROM po_vendor_bills b
                   WHERE b.po_id = po.id
                     AND LOWER(TRIM(b.vendor_name)) =
                         LOWER(TRIM(COALESCE(NULLIF(TRIM(poi.vendor), ''), po.vendor, '')))
                   ORDER BY b.created_at LIMIT 1), '')    AS bill_no,
        COALESCE(NULLIF(TRIM(poi.vendor), ''), TRIM(COALESCE(po.vendor, '')), '') AS vendor,
        COALESCE(rm.name, '(unknown item)')               AS material,
        COALESCE(rm.sku, '')                              AS sku,
        COALESCE(rm.category, '')                         AS category,
        poi.quantity                                      AS qty,
        COALESCE(NULLIF(rm.purchase_unit, ''), rm.unit, '') AS purchase_unit,
        poi.unit_price                                    AS rate,
        COALESCE(poi.total_price, poi.quantity * poi.unit_price) AS value,
        NULL                                              AS qty_rejected,
        -- purchase_order_items has NO charge columns. NULL, not 0: an order
        -- carries no bill charges, it is not "a bill with zero charges".
        -- Aliased explicitly — with ?source=po this branch is the FIRST of the
        -- compound SELECT and its names become the outer SELECT *'s names.
        NULL AS discount, NULL AS cgst, NULL AS sgst,
        NULL AS special_excise_cess, NULL AS compensation_cess, NULL AS tcs,
        NULL AS delivery_charges, NULL AS mrp_round_off,
        -- The GRN this ordered line was received on, via po_item_id. NULL until
        -- it is received (or when the receipt fell outside this date window).
        COALESCE((SELECT g2.grn_number
                    FROM goods_receipt_note_items gi2
                    JOIN goods_receipt_notes g2 ON g2.id = gi2.grn_id
                   WHERE g2.po_id = po.id AND gi2.po_item_id = poi.id
                   ORDER BY g2.date LIMIT 1), '')         AS link_raw,
        0                                                 AS is_mirror,
        -- Status is stamped in because a PO row is a COMMITMENT, and whether it
        -- is still pending or already received changes what the line means.
        TRIM('PO ' || COALESCE(po.status, '')
             || CASE WHEN TRIM(COALESCE(poi.notes, '')) <> ''
                     THEN ' · ' || TRIM(poi.notes) ELSE '' END) AS notes
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.po_id
      LEFT JOIN raw_materials rm ON rm.id = poi.material_id
      WHERE po.date >= ? AND po.date <= ?
        -- A draft was never placed; a cancelled/rejected order will never be
        -- spend. Including them would inflate po_value with money nobody owes.
        AND COALESCE(po.status, '') NOT IN ('draft', 'cancelled', 'rejected')
        ${venFilter("COALESCE(NULLIF(TRIM(poi.vendor), ''), po.vendor, '')")}${matFilter('poi.material_id')}
    `);
    params.push(f.from, f.to);
    if (f.vendor) params.push(f.vendor);
    if (f.materialId) params.push(f.materialId);
  }

  return { sql: parts.join('\nUNION ALL\n'), params };
}

/**
 * Build the purchase log for a date range.
 *
 * Caller (the route) is responsible for the management gate — this is a pure
 * query layer and applies no authorisation of its own.
 */
export function getPurchaseLog(
  filters: PurchaseLogFilters = {},
  dbArg?: DatabaseT.Database,
): PurchaseLogResult {
  const db = dbArg || getDb();
  const { from, to } = resolvePurchaseLogRange(filters.from, filters.to);
  const vendor = String(filters.vendor || '').trim();
  const materialId = String(filters.material_id || '').trim();
  const rawSource = String(filters.source || 'all').toLowerCase();
  const source: PurchaseLogSourceFilter =
    rawSource === 'purchase' || rawSource === 'po' || rawSource === 'grn'
      ? (rawSource as PurchaseLogSourceFilter)
      : 'all';

  const { sql: union, params } = buildUnion({ from, to, vendor, materialId, source });

  const empty: PurchaseLogTotals = {
    lines: 0, purchase_value: 0, po_value: 0, grn_value: 0,
    purchase_lines: 0, po_lines: 0, grn_lines: 0,
    purchase_value_mirrored_from_grn: 0, purchase_value_direct: 0,
    basis: TOTALS_BASIS,
  };
  // buildUnion returns '' only if `source` matched nothing, which the
  // normalisation above makes impossible — but an empty compound SELECT is a
  // syntax error, so never hand one to SQLite.
  if (!union) return { rows: [], totals: empty, truncated: false, from, to };

  // ── TOTALS FIRST, over the FULL filtered set ──────────────────────────────
  // Computed by the database, not by summing the (possibly capped) rows, so the
  // cap can never quietly understate the spend.
  const agg = db.prepare(`
    SELECT source,
           COUNT(*)                                                  AS lines,
           COALESCE(SUM(value), 0)                                   AS value,
           COALESCE(SUM(CASE WHEN is_mirror = 1 THEN value ELSE 0 END), 0) AS mirrored
    FROM (${union})
    GROUP BY source
  `).all(...params) as Array<{ source: string; lines: number; value: number; mirrored: number }>;

  const totals: PurchaseLogTotals = { ...empty };
  for (const a of agg) {
    if (a.source === 'PURCHASE') {
      totals.purchase_lines = num(a.lines);
      totals.purchase_value = r2(a.value);
      totals.purchase_value_mirrored_from_grn = r2(a.mirrored);
      totals.purchase_value_direct = r2(num(a.value) - num(a.mirrored));
    } else if (a.source === 'PO') {
      totals.po_lines = num(a.lines);
      totals.po_value = r2(a.value);
    } else if (a.source === 'GRN') {
      totals.grn_lines = num(a.lines);
      totals.grn_value = r2(a.value);
    }
    totals.lines += num(a.lines);
  }

  // ── ROWS ──────────────────────────────────────────────────────────────────
  // Ordered so ONE receipt event reads as one event: within a day and a vendor,
  // the three faces of the same item sit on consecutive lines in the order they
  // happened — PO (ordered) → GRN (billed) → PURCHASE (booked) — with unlinked
  // direct purchases first.
  //
  // substr(link_raw, 1, 13), not link_raw: on GRN/PO rows link_raw is the bare
  // "GRN-2026-0007" (13 chars) but on a PURCHASE row it is the TAIL of the note,
  // e.g. "GRN-2026-0007)" or "GRN-2026-0007 · invoice 4841". Sorting the raw
  // value puts the booked row after the whole rest of the group instead of
  // beside its own item. The exact key is still link_key, computed below —
  // this substring only drives the grouping of the sort.
  //
  // row_id is the final tie-break so the LIMIT takes a deterministic prefix
  // rather than an arbitrary one.
  const raw = db.prepare(`
    SELECT * FROM (${union})
    ORDER BY date ASC,
             vendor COLLATE NOCASE ASC,
             substr(link_raw, 1, 13) ASC,
             material COLLATE NOCASE ASC,
             source_rank ASC,
             doc_no ASC,
             row_id ASC
    LIMIT ?
  `).all(...params, PURCHASE_LOG_MAX_ROWS) as any[];

  const rows: PurchaseLogRow[] = raw.map((r) => {
    const src = r.source as PurchaseLogSource;
    // PURCHASE rows carry a note TAIL that must be parsed; GRN/PO rows already
    // hold the bare grn_number (or '' when the line was never received).
    const grn = src === 'PURCHASE' ? grnFromNoteTail(r.link_raw) : (String(r.link_raw || '') || null);
    const materialId2 = String(r.material_id ?? '');
    return {
      source: src,
      date: String(r.date || ''),
      doc_no: String(r.doc_no || ''),
      invoice_id: String(r.invoice_id || ''),
      bill_no: String(r.bill_no || ''),
      vendor: String(r.vendor || ''),
      material: String(r.material || ''),
      sku: String(r.sku || ''),
      category: String(r.category || ''),
      qty: num(r.qty),
      purchase_unit: String(r.purchase_unit || ''),
      rate: num(r.rate),
      value: r2(r.value),
      qty_rejected: r.qty_rejected == null ? null : num(r.qty_rejected),
      discount: nullNum(r.discount),
      cgst: nullNum(r.cgst),
      sgst: nullNum(r.sgst),
      special_excise_cess: nullNum(r.special_excise_cess),
      compensation_cess: nullNum(r.compensation_cess),
      tcs: nullNum(r.tcs),
      delivery_charges: nullNum(r.delivery_charges),
      mrp_round_off: nullNum(r.mrp_round_off),
      // Material is part of the key so the PO line, the GRN line and the
      // purchases row of the SAME item pair up, not just the same delivery.
      // (Falls back to the bare GRN number if the material row was purged.)
      link_key: grn ? (materialId2 ? `${grn}#${materialId2}` : grn) : null,
      notes: String(r.notes || '').trim(),
    };
  });

  return { rows, totals, truncated: totals.lines > rows.length, from, to };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV — shared so the download and the on-screen table cannot drift apart
// ─────────────────────────────────────────────────────────────────────────────

export interface PurchaseLogColumn {
  key: keyof PurchaseLogRow;
  label: string;
  /** Numeric columns skip the spreadsheet-formula guard (it would break "-12.5"). */
  numeric?: boolean;
}

export const PURCHASE_LOG_COLUMNS: PurchaseLogColumn[] = [
  { key: 'date',                label: 'Date' },
  { key: 'source',              label: 'Source' },
  { key: 'doc_no',              label: 'Document No' },
  { key: 'invoice_id',          label: 'Invoice ID (ours)' },
  { key: 'bill_no',             label: 'Bill No (vendor)' },
  { key: 'vendor',              label: 'Vendor' },
  { key: 'material',            label: 'Item' },
  { key: 'sku',                 label: 'SKU' },
  { key: 'category',            label: 'Category' },
  { key: 'qty',                 label: 'Qty', numeric: true },
  { key: 'purchase_unit',       label: 'Purchase Unit' },
  { key: 'rate',                label: 'Rate (Rs/purchase unit)', numeric: true },
  { key: 'value',               label: 'Value (Rs)', numeric: true },
  { key: 'qty_rejected',        label: 'Qty Rejected', numeric: true },
  { key: 'discount',            label: 'Discount', numeric: true },
  { key: 'cgst',                label: 'CGST', numeric: true },
  { key: 'sgst',                label: 'SGST', numeric: true },
  { key: 'special_excise_cess', label: 'Spl Excise Cess', numeric: true },
  { key: 'compensation_cess',   label: 'Compensation Cess', numeric: true },
  { key: 'tcs',                 label: 'TCS', numeric: true },
  { key: 'delivery_charges',    label: 'Delivery Charges', numeric: true },
  { key: 'mrp_round_off',       label: 'MRP Round Off', numeric: true },
  { key: 'link_key',            label: 'Link Key (same receipt)' },
  { key: 'notes',               label: 'Notes' },
];

/**
 * Escape one CSV field. Free-text (vendor, item, notes) gets the leading
 * `=+-@` guard — Excel executes those as formulas, and a vendor name is
 * user-entered text that reaches this file unfiltered.
 */
function csvCell(v: unknown, numeric: boolean): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialise rows to CSV. Returns the body WITHOUT the UTF-8 BOM — the caller
 * prepends '﻿' when writing the HTTP response (prepending it twice puts a
 * stray glyph in the first header cell).
 */
export function purchaseLogToCsv(rows: PurchaseLogRow[]): string {
  const out: string[] = [PURCHASE_LOG_COLUMNS.map(c => csvCell(c.label, false)).join(',')];
  for (const r of rows) {
    out.push(PURCHASE_LOG_COLUMNS.map(c => csvCell(r[c.key], !!c.numeric)).join(','));
  }
  return out.join('\r\n');
}

/** Filename the download must use: purchase-log-<from>_<to>.csv */
export function purchaseLogFilename(from: string, to: string): string {
  return `purchase-log-${from}_${to}.csv`;
}
