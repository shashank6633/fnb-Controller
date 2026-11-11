/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PURCHASE INWARD — the owner's Recaho-style 38-column inward list (owner
 * ruling 127, 2026-11-10). SERVER ONLY (better-sqlite3, xlsx).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE OWNER'S WORDS: "NEED A PURCHASE REPORT LIKE THIS CAN YOU BUILD IN
 * REPORTS?" — with a sheet "Purchase Inward Data" in RECAHO's Purchase Inward
 * layout, 38 columns A–AL. Built as a download inside Reports → Purchase Report.
 *
 * ROWS = THE PURCHASE REPORT'S OWN ROWS. One row per `purchases` row in
 * purchaseReportBase (src/lib/purchase-report-base.ts) for the INWARD DATE
 * window — the very rows the Summary cards and the Item-wise list add up —
 * and every money cell through the SAME per-row expression the Summary SUMs
 * (effectiveBillValueSql / effectiveChargeSql / effectiveLineTotalSql in
 * src/lib/purchase-charges.ts). Nothing is re-derived: the TOTAL INWARD AMOUNT
 * column is the Purchase Report's Grand Total line by line, so
 *
 *     Σ TOTAL INWARD AMOUNT  =  Purchase Report Grand Total, to the paisa
 *
 * and getPurchaseInward() CHECKS that (and every other money column against
 * its Summary figure) on every request by running the Summary's own aggregate
 * over the same base — the Item-wise list's pattern. The About sheet prints
 * the comparison.
 *
 * THE OWNER'S PICKS (ruling 127), column by column:
 *   A/B CREATED DATE/TIME  when the delivery was FIRST keyed in, Indian time:
 *                          the GRN header's created_at for a row with a GRN
 *                          (never the purchases row's, which on a kitchen-
 *                          checked delivery is the QC sign-off time), else the
 *                          purchases row's own created_at.
 *   C/D PO ID / PO DATE    the PO the goods were received against, through
 *                          purchases.grn_id → goods_receipt_notes.po_id (the
 *                          PO-ID trap: purchases.po_id is NULL at insert). Only
 *                          a row with NO GRN at all reads purchases.po_id, which
 *                          the boot migration fills for receives that predate
 *                          grn_id.
 *   G INWARD ID            our GRN number; on a row the Recaho Inward Import
 *                          wrote, Recaho's own inward number read EXACTLY from
 *                          the note that import writes (recaho-inward.ts) —
 *                          never guessed from other text.
 *   H INVOICE ID           the VENDOR's bill number: bill_no, else the GRN's
 *                          invoice_number. Our PINV is the extra column AM.
 *   M CATEGORY NAME        raw_materials.category, in capitals.
 *   R/U PO QTY / VARIANCE  the GRN line's quantity_ordered through a
 *                          DISPLAY-ONLY pairing over every GRN-linked row (the
 *                          money rail's pairing skips kitchen-checked rows), else
 *                          purchases.po_qty — whatever the row itself holds,
 *                          whichever door wrote it: production's July 2026
 *                          Recaho-imported rows carry it (owner's console,
 *                          99.9%); in today's code only the Generic CSV Upload
 *                          (/api/purchases/bulk) writes it, the Recaho Inward
 *                          Upload (/api/inward-import) does not. No upload keeps
 *                          a PO number, so such a row has PO QTY with PO ID /
 *                          PO DATE empty (About note 5). Variance =
 *                          INWARD QTY − PO QTY.
 *   T/W INWARD QTY / RATE  the pair that makes SUBTOTAL: the GRN line's
 *                          quantity_received and gross rate where SUBTOTAL is
 *                          read off the GRN line, else the purchases row's own.
 *   AD EXCISE              EMPTY here: special excise cess goes ONLY in
 *                          "TCS + SPECIAL EXCISE CESS" (once, never twice).
 *   AI INVOICE URL         a sign-in-only link to the bill photo uploaded in
 *                          Bill Submission, where one exists.
 *   AJ/AK PAID / BALANCE   only for a bill paid from the petty-cash box (the
 *                          app's own grnPaidInCash test, src/lib/cash-purchase.ts):
 *                          PAID = the line's TOTAL INWARD, BALANCE = 0. Credit
 *                          bills: both empty — never "unpaid".
 *   AL CREATED BY          the NAME of whoever keyed the GRN (received_by, an
 *                          email, resolved through users) — never the email;
 *                          empty when nothing matches.
 *   E F K L N P S AB       never held by the app — always empty.
 *
 * RE-IMPORT GUARD. This layout is exactly what Inward Import reads
 * (parseInwardWorkbook), which falls back to the FIRST sheet. So the first
 * sheet is "About this file" (no header row the importer can find) and no
 * sheet carries a name the importer prefers. A re-upload parses 0 rows.
 *
 * LIQUOR. A TGBCL bill recorded in the Liquor Store (Goods Receipt → TGBCL
 * Liquor Bill, or the Liquor Store page before that) writes no purchases row,
 * so it never enters the main sheet or its total. Liquor that was booked as an
 * ordinary purchases row instead (e.g. by an older Recaho inward import, before
 * the store guards: 67 "GOVERNMENT OF TELANGANA" rows on the local copies) IS
 * a Purchase Report line, so it stays on the main sheet and in its total like
 * any other; the About sheet words liquor by the door used, never as an
 * absolute (data-r2). The "Liquor Inward" sheet is a separate section, built by
 * src/lib/purchase-inward-liquor.ts and passed in through the `liquor` option
 * of buildPurchaseInwardWorkbook (see LiquorInwardSection); the About sheet
 * prints its total — = the bills' Net Indent — on its own line. The route
 * always passes one; without it the file has no liquor sheet and the About
 * sheet says so.
 */
import * as XLSX from 'xlsx';
import type DatabaseT from 'better-sqlite3';
import { getDb } from '@/lib/db';
import {
  effectiveBillValueSql, effectiveChargeSql, effectiveLineTotalSql, poReceiptMirrorSql,
  grnChargeCteSql, withGrnCharges, chargeSums, r2,
  type PurchaseChargeKey,
} from '@/lib/purchase-charges';
import { purchaseReportBase, purchaseReportSummarySql } from '@/lib/purchase-report-base';
import { BH_VOID } from '@/lib/bill-handover-schema';
import { fmtIST } from '@/lib/format-date';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE COLUMNS — the owner's 38, in his order, with his exact header text, and
 * our PINV as column AM.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** One row of the inward sheet. `null` = an empty cell. */
export interface InwardRow {
  created_date: string;
  created_time: string;
  po_id: string;
  po_date: string;
  inward_id: string;
  invoice_id: string;
  inward_date: string;
  supplier: string;
  category: string;
  item_id: string;
  item_name: string;
  po_qty: number | null;
  inward_qty: number;
  variance: number | null;
  purchase_unit: string;
  rate: number;
  subtotal: number;
  discount: number;
  cgst: number;
  sgst: number;
  /** GST compensation cess. EMPTY (null) on the Liquor Inward sheet: the liquor rail does not record it. */
  cess: number | null;
  /** EMPTY (null) on the main sheet; the Liquor Inward sheet fills it. */
  excise: number | null;
  delivery: number;
  tcs_spl: number;
  mrp_round_off: number;
  total_inward: number;
  invoice_url: string;
  paid: number | null;
  balance: number | null;
  created_by: string;
  pinv: string;
}

type Fmt = 'text' | 'qty' | 'rate' | 'money';
export interface InwardColumn {
  col: string;
  header: string;
  /** null = a column the app never holds: always empty. */
  key: keyof InwardRow | null;
  fmt: Fmt;
  wch: number;
}

/** The header of column AM — ours, after the owner's 38. */
export const PINV_HEADER = 'OUR PURCHASE INVOICE ID (PINV)';

export const INWARD_COLUMNS: readonly InwardColumn[] = [
  { col: 'A', header: 'CREATED DATE', key: 'created_date', fmt: 'text', wch: 12 },
  { col: 'B', header: 'CREATED TIME', key: 'created_time', fmt: 'text', wch: 8 },
  { col: 'C', header: 'PO ID', key: 'po_id', fmt: 'text', wch: 14 },
  { col: 'D', header: 'PO DATE', key: 'po_date', fmt: 'text', wch: 12 },
  { col: 'E', header: 'TO ID', key: null, fmt: 'text', wch: 8 },
  { col: 'F', header: 'TO DATE', key: null, fmt: 'text', wch: 8 },
  { col: 'G', header: 'INWARD ID', key: 'inward_id', fmt: 'text', wch: 14 },
  { col: 'H', header: 'INVOICE ID', key: 'invoice_id', fmt: 'text', wch: 16 },
  { col: 'I', header: 'INWARD DATE', key: 'inward_date', fmt: 'text', wch: 12 },
  { col: 'J', header: 'SUPPLIER NAME', key: 'supplier', fmt: 'text', wch: 28 },
  { col: 'K', header: 'VENDOR CODE', key: null, fmt: 'text', wch: 8 },
  { col: 'L', header: 'GL CODE', key: null, fmt: 'text', wch: 8 },
  { col: 'M', header: 'CATEGORY NAME', key: 'category', fmt: 'text', wch: 18 },
  { col: 'N', header: 'SUB CATEGORY', key: null, fmt: 'text', wch: 8 },
  { col: 'O', header: 'ITEM ID', key: 'item_id', fmt: 'text', wch: 11 },
  { col: 'P', header: 'EXTERNAL ITEM ID', key: null, fmt: 'text', wch: 8 },
  { col: 'Q', header: 'ITEM NAME', key: 'item_name', fmt: 'text', wch: 32 },
  { col: 'R', header: 'PO QTY', key: 'po_qty', fmt: 'qty', wch: 9 },
  { col: 'S', header: 'TO QTY', key: null, fmt: 'qty', wch: 7 },
  { col: 'T', header: 'INWARD QTY', key: 'inward_qty', fmt: 'qty', wch: 10 },
  { col: 'U', header: 'INWARD QUANTITY VARIANCE', key: 'variance', fmt: 'qty', wch: 12 },
  { col: 'V', header: 'PURCHASE UNIT', key: 'purchase_unit', fmt: 'text', wch: 10 },
  { col: 'W', header: 'RATE', key: 'rate', fmt: 'rate', wch: 11 },
  { col: 'X', header: 'SUBTOTAL', key: 'subtotal', fmt: 'money', wch: 13 },
  { col: 'Y', header: 'DISCOUNT', key: 'discount', fmt: 'money', wch: 11 },
  { col: 'Z', header: 'CGST', key: 'cgst', fmt: 'money', wch: 11 },
  { col: 'AA', header: 'SGST', key: 'sgst', fmt: 'money', wch: 11 },
  { col: 'AB', header: 'VAT', key: null, fmt: 'money', wch: 7 },
  { col: 'AC', header: 'CESS', key: 'cess', fmt: 'money', wch: 10 },
  { col: 'AD', header: 'EXCISE', key: 'excise', fmt: 'money', wch: 10 },
  { col: 'AE', header: 'DELIVERY CHARGES', key: 'delivery', fmt: 'money', wch: 11 },
  { col: 'AF', header: 'TCS + SPECIAL EXCISE CESS', key: 'tcs_spl', fmt: 'money', wch: 13 },
  { col: 'AG', header: 'MRP ROUND OFF', key: 'mrp_round_off', fmt: 'money', wch: 10 },
  { col: 'AH', header: 'TOTAL INWARD AMOUNT', key: 'total_inward', fmt: 'money', wch: 14 },
  { col: 'AI', header: 'INVOICE URL', key: 'invoice_url', fmt: 'text', wch: 30 },
  { col: 'AJ', header: 'PAID AMOUNT', key: 'paid', fmt: 'money', wch: 12 },
  { col: 'AK', header: 'BALANCE AMOUNT', key: 'balance', fmt: 'money', wch: 12 },
  { col: 'AL', header: 'CREATED BY', key: 'created_by', fmt: 'text', wch: 18 },
  { col: 'AM', header: PINV_HEADER, key: 'pinv', fmt: 'text', wch: 18 },
] as const;

/** The main sheet's name — the owner's own sheet name. The Inward Import does NOT prefer it. */
export const INWARD_SHEET_NAME = 'Purchase Inward Data';
/** The first sheet. Inward Import falls back to the first sheet and finds no header row here. */
export const ABOUT_SHEET_NAME = 'About this file';
/** The third sheet: liquor (TGBCL) bills recorded in the Liquor Store, built by src/lib/purchase-inward-liquor.ts. */
export const LIQUOR_SHEET_NAME = 'Liquor Inward';

/*
 * LIQUOR, WORDED BY THE DOOR USED — never as an absolute (data-r2). A TGBCL
 * bill recorded in the Liquor Store is on "Liquor Inward" and never on the
 * main sheet; liquor that was booked as an ordinary purchases row (an older
 * inward import did that) IS a Purchase Report line, so it is on the main
 * sheet and in its total. Every liquor sentence in the file says which it means.
 */
/** The empty "Liquor Inward" sheet's first sentence (true even when lines of a deleted item exist: the register leaves those out too). */
const LIQUOR_NONE_TEXT = 'No liquor (TGBCL) bills on the Liquor Store Inward Register for these inward dates.';
/** Liquor booked as an ordinary purchase line: where it is, and why. */
const LIQUOR_AS_PURCHASE_TEXT = `Liquor that was booked as an ordinary purchase line instead (for example by an earlier inward import) is a purchase line on the Purchase Report, so it is in "${INWARD_SHEET_NAME}" and its total, like any other purchase line.`;

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ROWS
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface InwardFilters {
  from: string;
  to: string;
  /**
   * The app's public origin (e.g. "https://fnb.example"), read off the request
   * by the route the way src/app/api/crm-calls/reviews/connect/route.ts does.
   * '' = unknown: INVOICE URL then carries the in-app path only.
   */
  origin?: string;
}

/** One figure compared with the Purchase Report's own Summary figure. */
export interface InwardCheck {
  figure: string;
  kind: 'money' | 'count';
  file: number;
  report: number;
  ok: boolean;
}

export interface InwardResult {
  from: string;
  to: string;
  rows: InwardRow[];
  /** purchases.id behind each row, same order — for tracing a row back; never printed. */
  ids: string[];
  checks: InwardCheck[];
  ok: boolean;
  grand_total: number;
  /** Rows where INWARD QTY × RATE misses SUBTOTAL by more than rounding to the paisa (stored that way). */
  qty_rate_misses: number;
  /**
   * Rows whose SUBTOTAL is read off a GRN line but whose INWARD QTY × RATE (the
   * display pairing's GRN line) misses it — the two pairings disagree. 0 expected;
   * named under "Found in this file" if ever not.
   */
  qty_rate_pairing_misses: number;
  /** Rows holding a money figure with a fraction of a paisa (kept exact). */
  subpaise_rows: number;
  /** Rows whose GRN line (the bill document) is gone, so tax/charges are missing (0 expected). */
  understated_rows: number;
  /** Rows that point at a GRN whose header no longer exists: CREATED DATE/TIME left empty (0 expected). */
  grn_header_missing: number;
  /** Counts for the About sheet. */
  counts: {
    grn_rows: number;
    imported_rows: number;
    po_qty_from_import: number;
    cash_paid_rows: number;
    photo_rows: number;
    created_by_rows: number;
  };
}

/** A money figure as stored, float noise removed, a genuine fraction of a paisa KEPT (as purchase-itemwise.ts). */
function money(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const p = r2(n);
  return Math.abs(n - p) < 1e-6 ? p : clean(n);
}
/** Float noise off a sum or a quantity (rounded to a millionth). */
function clean(v: number): number {
  const n = Number(v) || 0;
  return Math.round(n * 1e6) / 1e6;
}
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => String(v ?? '').trim();
const paise = (v: number) => Math.round((Number(v) || 0) * 100);

/** The eight charges as named on both `purchases` and the GRN line. */
const CHARGE_KEYS: PurchaseChargeKey[] = [
  'discount', 'cgst', 'sgst', 'compensation_cess', 'special_excise_cess', 'tcs', 'delivery_charges', 'mrp_round_off',
];

/**
 * THE RECAHO INWARD IMPORT'S OWN NOTE, AND NOTHING ELSE.
 *
 * src/lib/recaho-inward.ts builds `notes` as "Invoice: <INVOICE ID> · Inward:
 * <INWARD ID>" (either part only when the sheet had it), and
 * src/app/api/inward-import/commit/route.ts stores it, optionally followed by
 * " · GST ₹…" and " · TGBCL TCS + Special Excise Cess ₹…". Anchored at the start
 * and at one of those exact endings, so free text that merely mentions an
 * inward number never matches. The number itself must be one token (letters,
 * digits, - or /), as Recaho's inward ids are: "Inward: 55 pending" is prose,
 * not an id, and stays empty. Read only on rows with no GRN.
 */
const RECAHO_NOTE_RE = /^(?:Invoice: .+? · )?Inward: ([A-Za-z0-9][A-Za-z0-9\-\/]*)\s*(?:$| · GST ₹| · TGBCL TCS \+ Special Excise Cess ₹)/;

export function recahoInwardIdFromNotes(notes: unknown): string {
  const m = RECAHO_NOTE_RE.exec(String(notes ?? ''));
  return m ? m[1].trim() : '';
}

/** A person's name fit to print: never an email or a phone number. */
function printableName(v: unknown): string {
  const s = str(v);
  if (!s || s.includes('@') || /\d{7,}/.test(s.replace(/[\s\-()+]/g, ''))) return '';
  return s;
}

/** "YYYY-MM-DD" when it is one, else ''. */
const ymd = (v: unknown): string => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(v));
  return m ? m[1] : '';
};

function tableExists(db: DatabaseT.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}
function columnExists(db: DatabaseT.Database, table: string, col: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === col);
  } catch { return false; }
}

/**
 * A DISPLAY-ONLY pairing of every GRN-linked purchases row with its GRN line
 * (grn_id + material_id, 1:1 by ROW_NUMBER), for PO QTY and, where SUBTOTAL is
 * read off the GRN line, INWARD QTY and RATE. It moves no money: every money
 * cell comes from the Purchase Report's own rail (grn_line). It differs from
 * that rail's pairing only in taking kitchen-checked (PINV) rows too, which the
 * rail deliberately leaves on their own purchases row.
 */
const DISPLAY_PAIRING_CTE = `inward_disp AS (
      SELECT pm.purchase_id                     AS purchase_id,
             COALESCE(gm.quantity_ordered, 0)   AS quantity_ordered,
             COALESCE(gm.quantity_received, 0)  AS quantity_received,
             COALESCE(gm.unit_price, 0)         AS unit_price
        FROM (
          SELECT id AS purchase_id, grn_id, material_id,
                 ROW_NUMBER() OVER (PARTITION BY grn_id, material_id ORDER BY created_at, id) AS rn
            FROM purchases
           WHERE TRIM(COALESCE(grn_id, '')) <> ''
        ) pm
        JOIN (
          SELECT grn_id, material_id, quantity_ordered, quantity_received, unit_price,
                 ROW_NUMBER() OVER (PARTITION BY grn_id, material_id ORDER BY created_at, id) AS rn
            FROM goods_receipt_note_items
        ) gm
          ON gm.grn_id = pm.grn_id
         AND gm.material_id = pm.material_id
         AND gm.rn = pm.rn
    )`;

function rowSql(base: string, opts: { cashLink: boolean; handovers: boolean }): string {
  const charges = CHARGE_KEYS.map(k => `${effectiveChargeSql(k, 'p', 'gl')} AS ${k}`).join(',\n          ');
  // THE APP'S OWN "PAID FROM THE BOX" TEST — cashLedgerForGrn() in
  // src/lib/cash-purchase.ts: a petty_cash_ledger row with this grn_id, direction 'out'.
  const cash = opts.cashLink
    ? `CASE WHEN g.id IS NOT NULL AND EXISTS (SELECT 1 FROM petty_cash_ledger c
                                              WHERE c.grn_id = g.id AND c.direction = 'out')
            THEN 1 ELSE 0 END`
    : '0';
  // THE BILL PHOTO: a non-void Bill Submission record with at least one file —
  // the GRN's own record (one per GRN, by a partial unique index), or, for a row
  // with no GRN, the one manual record carrying this row's PINV.
  const handover = opts.handovers
    ? `CASE
         WHEN g.id IS NOT NULL THEN (
           SELECT h.id FROM bill_handovers h
            WHERE h.grn_id = g.id AND h.status <> '${BH_VOID}'
              AND EXISTS (SELECT 1 FROM bill_handover_files f WHERE f.handover_id = h.id)
            ORDER BY h.created_at, h.id LIMIT 1)
         WHEN TRIM(COALESCE(x.grn_id, '')) = '' AND TRIM(COALESCE(x.invoice_id, '')) <> '' THEN (
           SELECT CASE WHEN COUNT(*) = 1 THEN MAX(h.id) END FROM bill_handovers h
            WHERE TRIM(COALESCE(h.grn_id, '')) = '' AND TRIM(h.invoice_id) = TRIM(x.invoice_id)
              AND h.status <> '${BH_VOID}'
              AND EXISTS (SELECT 1 FROM bill_handover_files f WHERE f.handover_id = h.id))
       END`
    : 'NULL';
  return `
    WITH ${grnChargeCteSql()},
    ${DISPLAY_PAIRING_CTE}
    SELECT x.*,
           CASE WHEN g.id IS NOT NULL THEN 1 ELSE 0 END             AS g_found,
           COALESCE(TRIM(g.grn_number), '')                          AS grn_number,
           strftime('%Y-%m-%d', g.created_at, '+330 minutes')        AS g_created_date,
           strftime('%H:%M',    g.created_at, '+330 minutes')        AS g_created_time,
           COALESCE(TRIM(g.invoice_number), '')                      AS g_invoice_number,
           -- CREATED BY: the ONE user whose login (or id) is the GRN's received_by.
           (SELECT CASE WHEN COUNT(*) = 1 THEN MAX(TRIM(u.name)) END FROM users u
             WHERE TRIM(COALESCE(g.received_by, '')) <> ''
               AND (LOWER(TRIM(u.email)) = LOWER(TRIM(g.received_by)) OR u.id = TRIM(g.received_by))) AS created_by_name,
           CASE WHEN po.id IS NOT NULL THEN 1 ELSE 0 END             AS po_found,
           COALESCE(TRIM(po.po_number), '')                          AS po_number,
           COALESCE(po.date, '')                                     AS po_date,
           CASE WHEN d.purchase_id IS NOT NULL THEN 1 ELSE 0 END     AS d_found,
           d.quantity_ordered                                        AS d_qty_ordered,
           d.quantity_received                                       AS d_qty_received,
           d.unit_price                                              AS d_rate,
           ${cash}                                                   AS cash_paid,
           ${handover}                                               AS handover_id
      FROM (
        SELECT
          p.id                                               AS id,
          p.date                                             AS date,
          strftime('%Y-%m-%d', p.created_at, '+330 minutes') AS p_created_date,
          strftime('%H:%M',    p.created_at, '+330 minutes') AS p_created_time,
          COALESCE(TRIM(p.vendor), '')                       AS vendor,
          COALESCE(TRIM(p.bill_no), '')                      AS bill_no,
          COALESCE(TRIM(p.invoice_id), '')                   AS invoice_id,
          COALESCE(TRIM(p.grn_id), '')                       AS grn_id,
          COALESCE(TRIM(p.po_id), '')                        AS p_po_id,
          p.material_id                                      AS material_id,
          COALESCE(p.quantity, 0)                            AS qty,
          COALESCE(p.unit_price, 0)                          AS rate,
          COALESCE(p.po_qty, 0)                              AS p_po_qty,
          COALESCE(p.notes, '')                              AS notes,
          p.created_at                                       AS created_at_raw,
          COALESCE(NULLIF(TRIM(rm.name), ''),
                   '(material not linked · id ' || COALESCE(p.material_id, '?') || ')') AS item,
          COALESCE(TRIM(rm.sku), '')                         AS sku,
          COALESCE(TRIM(rm.category), '')                    AS category,
          COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), TRIM(rm.unit), '') AS unit,
          ${effectiveBillValueSql('p', 'gl')}                AS subtotal,
          ${charges},
          ${effectiveLineTotalSql('p', 'gl')}                AS grand_total,
          CASE WHEN gl.purchase_id IS NOT NULL THEN 1 ELSE 0 END AS from_grn_line,
          CASE WHEN ${poReceiptMirrorSql('p')} = 1 AND gl.purchase_id IS NULL
               THEN 1 ELSE 0 END                             AS understated
        ${base}
      ) x
      LEFT JOIN goods_receipt_notes g ON x.grn_id <> '' AND g.id = x.grn_id
      LEFT JOIN purchase_orders po ON po.id = CASE
             WHEN g.id IS NOT NULL THEN NULLIF(TRIM(COALESCE(g.po_id, '')), '')
             WHEN x.grn_id = '' THEN NULLIF(x.p_po_id, '')
           END
      LEFT JOIN inward_disp d ON d.purchase_id = x.id
     ORDER BY x.date ASC, x.vendor COLLATE NOCASE ASC, x.bill_no ASC, grn_number ASC,
              x.item COLLATE NOCASE ASC, x.created_at_raw ASC, x.id ASC
  `;
}

type DbRow = Record<string, unknown>;

/**
 * Build the inward rows for an INWARD DATE window, and check them against the
 * Purchase Report's own Summary for the same window. SELECT only — the caller
 * owns the access gate.
 */
export function getPurchaseInward(f: InwardFilters, dbArg?: DatabaseT.Database): InwardResult {
  const db = dbArg || getDb();
  const origin = str(f.origin).replace(/\/+$/, '');
  // No vendor / category / item filter: the file is the whole window, as the Summary's Grand Total is.
  const { base, params } = purchaseReportBase({ from: f.from, to: f.to });

  const cashLink = tableExists(db, 'petty_cash_ledger') && columnExists(db, 'petty_cash_ledger', 'grn_id');
  const handovers = tableExists(db, 'bill_handovers') && tableExists(db, 'bill_handover_files');
  const raw = db.prepare(rowSql(base, { cashLink, handovers })).all(...params) as DbRow[];

  const counts = { grn_rows: 0, imported_rows: 0, po_qty_from_import: 0, cash_paid_rows: 0, photo_rows: 0, created_by_rows: 0 };
  let qtyRateMisses = 0;
  let qtyRatePairingMisses = 0;
  let subpaise = 0;
  let understated = 0;
  let grnHeaderMissing = 0;

  const rows: InwardRow[] = raw.map(r => {
    const hasGrnId = str(r.grn_id) !== '';
    const gFound = num(r.g_found) === 1;
    if (gFound) counts.grn_rows++;
    if (hasGrnId && !gFound) grnHeaderMissing++;

    // A, B — the GRN entry for a GRN row; the purchases row only when there is no GRN.
    const created_date = hasGrnId ? str(r.g_created_date) : str(r.p_created_date);
    const created_time = hasGrnId ? str(r.g_created_time) : str(r.p_created_time);

    // G — our GRN number, or Recaho's inward number on an imported row.
    let inward_id = '';
    if (gFound) inward_id = str(r.grn_number);
    else if (!hasGrnId) {
      inward_id = recahoInwardIdFromNotes(r.notes);
      if (inward_id) counts.imported_rows++;
    }

    // H — the vendor's bill number.
    const invoice_id = str(r.bill_no) || (gFound ? str(r.g_invoice_number) : '');

    // T, W — the qty and rate that make SUBTOTAL.
    const fromGrnLine = num(r.from_grn_line) === 1;
    const dFound = num(r.d_found) === 1;
    const inward_qty = clean(fromGrnLine && dFound ? num(r.d_qty_received) : num(r.qty));
    const rate = clean(fromGrnLine && dFound ? num(r.d_rate) : num(r.rate));

    // R — PO QTY: the GRN line's ordered qty on a PO receipt, else the PO qty
    // the purchases row itself holds (production's July Recaho-imported rows;
    // a Generic CSV Upload row whose file gave one), whatever door wrote it.
    const poFound = num(r.po_found) === 1;
    let po_qty: number | null = null;
    if (gFound && poFound && dFound && num(r.d_qty_ordered) > 0) po_qty = clean(num(r.d_qty_ordered));
    else if (num(r.p_po_qty) > 0) {
      po_qty = clean(num(r.p_po_qty));
      counts.po_qty_from_import++;
    }
    const variance = po_qty == null ? null : clean(inward_qty - po_qty);

    const subtotal = money(r.subtotal);
    const discount = money(r.discount);
    const cgst = money(r.cgst);
    const sgst = money(r.sgst);
    const cess = money(r.compensation_cess);
    const delivery = money(r.delivery_charges);
    const tcs_spl = clean(money(r.tcs) + money(r.special_excise_cess));
    const mrp_round_off = money(r.mrp_round_off);
    const total_inward = money(r.grand_total);

    // A miss = more than rounding to the paisa can explain.
    // On a row read off the GRN line, qty × rate is that line's own product, so a
    // miss there can only mean the two pairings chose different lines.
    if (Math.abs(inward_qty * rate - subtotal) > 0.005 + 1e-6) {
      if (fromGrnLine) qtyRatePairingMisses++; else qtyRateMisses++;
    }
    if ([subtotal, discount, cgst, sgst, cess, delivery, tcs_spl, mrp_round_off, total_inward]
      .some(v => Math.abs(v - r2(v)) >= 1e-6)) subpaise++;
    if (num(r.understated) === 1) understated++;

    // AJ, AK — only a bill paid from the petty-cash box.
    const cashPaid = num(r.cash_paid) === 1;
    if (cashPaid) counts.cash_paid_rows++;

    // AI — sign-in-only link to the uploaded bill photo.
    const hid = str(r.handover_id);
    const invoice_url = hid ? `${origin}/api/bill-submissions/${encodeURIComponent(hid)}/attachment` : '';
    if (hid) counts.photo_rows++;

    // AL — a NAME, never an email; empty when nothing matches.
    const created_by = gFound ? printableName(r.created_by_name) : '';
    if (created_by) counts.created_by_rows++;

    return {
      created_date,
      created_time,
      po_id: poFound ? str(r.po_number) : '',
      po_date: poFound ? ymd(r.po_date) : '',
      inward_id,
      invoice_id,
      inward_date: str(r.date),
      supplier: str(r.vendor),
      category: str(r.category).toUpperCase(),
      item_id: str(r.sku),
      item_name: str(r.item),
      po_qty,
      inward_qty,
      variance,
      purchase_unit: str(r.unit),
      rate,
      subtotal,
      discount,
      cgst,
      sgst,
      cess,
      excise: null,
      delivery,
      tcs_spl,
      mrp_round_off,
      total_inward,
      invoice_url,
      paid: cashPaid ? total_inward : null,
      balance: cashPaid ? 0 : null,
      created_by,
      pinv: str(r.invoice_id),
    };
  });

  // ── THE CHECK: the Summary's own aggregate over the identical base ──
  const sRaw = (db.prepare(withGrnCharges(purchaseReportSummarySql(base))).get(...params) || {}) as DbRow;
  const s = { ...sRaw, ...chargeSums(sRaw) };
  const sum = (k: keyof InwardRow) => clean(rows.reduce((t, x) => t + (Number(x[k]) || 0), 0));
  const m = (figure: string, fileV: number, reportV: unknown): InwardCheck => {
    const fv = clean(fileV);
    const rv = clean(num(reportV));
    return { figure, kind: 'money', file: fv, report: rv, ok: paise(fv) === paise(rv) };
  };
  const checks: InwardCheck[] = [
    { figure: 'Rows (purchase lines)', kind: 'count', file: rows.length, report: num(sRaw.purchase_count), ok: rows.length === num(sRaw.purchase_count) },
    m('SUBTOTAL', sum('subtotal'), s.bill_value),
    m('DISCOUNT', sum('discount'), s.discount),
    m('CGST', sum('cgst'), s.cgst),
    m('SGST', sum('sgst'), s.sgst),
    m('CESS (GST compensation cess)', sum('cess'), s.compensation_cess),
    m('DELIVERY CHARGES', sum('delivery'), s.delivery_charges),
    m('TCS + SPECIAL EXCISE CESS', sum('tcs_spl'), r2(num(s.tcs) + num(s.special_excise_cess))),
    m('MRP ROUND OFF', sum('mrp_round_off'), s.mrp_round_off),
    m('TOTAL INWARD AMOUNT', sum('total_inward'), sRaw.total_amount),
  ];
  return {
    from: f.from,
    to: f.to,
    rows,
    ids: raw.map(r => str(r.id)),
    checks,
    ok: checks.every(c => c.ok),
    grand_total: clean(num(sRaw.total_amount)),
    qty_rate_misses: qtyRateMisses,
    qty_rate_pairing_misses: qtyRatePairingMisses,
    subpaise_rows: subpaise,
    understated_rows: understated,
    grn_header_missing: grnHeaderMissing,
    counts,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE "Liquor Inward" SHEET'S SECTION.
 *
 * Computed in src/lib/purchase-inward-liquor.ts (TGBCL bills from the Liquor
 * Store's ledger, every money figure straight from getStoreInwardRegister in
 * src/lib/store-engine.ts) and handed to buildPurchaseInwardWorkbook({ liquor }).
 * Its rows use the SAME InwardRow shape and INWARD_COLUMNS, with EXCISE filled
 * (the Bar Excise Turnover Tax share). Its total is NEVER added to the main
 * sheet or to the Grand Total above; the About sheet prints it on its own line.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** One liquor column total compared with the bills' own figure. */
export interface LiquorCheck {
  figure: string;
  file: number;
  report: number;
  /** equal; or different only by the parts listed in `explained`; or a mismatch to report. */
  state: 'equal' | 'explained' | 'mismatch';
}

export interface LiquorInwardSection {
  rows: InwardRow[];
  /** store_stock_ledger.id behind each row, same order — for tracing a row back; never printed. */
  ids: string[];
  /** Σ TOTAL INWARD AMOUNT over `rows`. */
  total: number;
  /** Σ TOTAL INWARD AMOUNT of the Liquor Store Inward Register rows, same stores and dates. */
  register_total: number;
  /** Σ Net Indent (store_bill_charges.net_indent_value) of the bills these rows belong to, worked out independently. */
  net_indent: number;
  /** Bills (store + indent number) on the sheet. */
  bills: number;
  /** The stores the rows come from. */
  stores: { name: string; rows: number; bills: number; total: number }[];
  /** Stores with liquor lines on these dates that the viewer may not view: left out, and named. */
  withheld: string[];
  checks: LiquorCheck[];
  /** The non-zero parts of (total − net_indent), each an exact sum (the SUBTOTAL check's difference is the "no record" and "outside" parts). */
  explained: { label: string; amount: number }[];
  /** total − net_indent − Σ explained: 0 unless something is wrong. */
  residual: number;
  /** Liquor lines on these dates whose item no longer exists (the register leaves them out too). */
  orphan_lines: number;
  /** No check is a mismatch. */
  ok: boolean;
  /** Set when the sheet could not be built; the main sheet is unaffected. */
  error?: string;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE EXCEL FILE
 * ═══════════════════════════════════════════════════════════════════════════ */

const MONEY_FMT = '#,##0.00';
const RATE_FMT = '#,##0.00##';

/**
 * Formula-injection guard, as on every other export (purchase-itemwise.ts): a
 * text cell starting with = + - @ (or a tab / carriage return) gets a leading
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

type Cell = string | number | null;

/** One row's 39 cells, in column order. Empty = null (no cell written). */
export function inwardRowCells(r: InwardRow): Cell[] {
  return INWARD_COLUMNS.map(c => {
    if (!c.key) return null;
    const v = r[c.key];
    if (v == null) return null;
    if (typeof v === 'number') return v;
    const s = String(v);
    return s === '' ? null : safeText(s);
  });
}

/** A data sheet: the header row and the rows, nothing else (no totals row). */
function inwardSheet(rows: InwardRow[]): XLSX.WorkSheet {
  const aoa: Cell[][] = [INWARD_COLUMNS.map(c => c.header), ...rows.map(inwardRowCells)];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const urlCol = INWARD_COLUMNS.findIndex(c => c.key === 'invoice_url');
  for (let ri = 0; ri < rows.length; ri++) {
    const R = ri + 1;
    INWARD_COLUMNS.forEach((c, ci) => {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: ci })];
      if (!cell) return;
      if (cell.t === 'n') {
        if (c.fmt === 'money') cell.z = MONEY_FMT;
        else if (c.fmt === 'rate') cell.z = RATE_FMT;
        // qty: General — whole numbers print without a trailing "."
      }
    });
    // A clickable link where the URL is absolute.
    const u = rows[ri].invoice_url;
    if (urlCol >= 0 && /^https?:\/\//i.test(u)) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: urlCol })];
      if (cell) cell.l = { Target: u };
    }
  }
  ws['!cols'] = INWARD_COLUMNS.map(c => ({ wch: c.wch }));
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length), c: INWARD_COLUMNS.length - 1 } }),
  };
  return ws;
}

/**
 * The "Liquor Inward" sheet: the same columns as the main sheet. With no liquor
 * rows it keeps its header row and holds ONE line of plain text saying why
 * (never a blank sheet, never a totals row).
 */
function liquorSheet(liq: LiquorInwardSection): XLSX.WorkSheet {
  if (!liq.error && liq.rows.length > 0) return inwardSheet(liq.rows);
  const why = liq.error
    ? `This sheet could not be built (${liq.error}). See "${ABOUT_SHEET_NAME}".`
    : liq.withheld.length
      ? `Left out: your login cannot view ${liq.withheld.join(', ')} (Inventory → Liquor Store), so ${liq.withheld.length === 1 ? 'its' : 'their'} liquor bills are not in this file.`
      : `${LIQUOR_NONE_TEXT} Any liquor booked as an ordinary purchase line is on "${INWARD_SHEET_NAME}", as on the Purchase Report.`;
  const ws = XLSX.utils.aoa_to_sheet([INWARD_COLUMNS.map(c => c.header), [why]]);
  ws['!cols'] = INWARD_COLUMNS.map(c => ({ wch: c.wch }));
  return ws;
}

/** Freeze the header row of the given sheets (same technique as purchase-itemwise.ts). */
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

export function purchaseInwardFilename(from: string, to: string): string {
  return `purchase-inward_${from}_${to}.xlsx`;
}

/** The About sheet: what the file is, its totals and checks, and every column rule in plain words. */
function aboutSheet(res: InwardResult, generatedAt: Date, liquor?: LiquorInwardSection): XLSX.WorkSheet {
  const aoa: Cell[][] = [];
  const moneyRows: number[] = [];
  const total = res.checks.find(c => c.figure === 'TOTAL INWARD AMOUNT');
  const n = res.rows.length;
  const plural = (k: number, one: string, many: string) => `${k.toLocaleString('en-IN')} ${k === 1 ? one : many}`;

  aoa.push(['About this file — Purchase Inward (Recaho-style layout)']);
  aoa.push(['THIS IS A REPORT. Do not upload it into Inward Import: it is not an inward file, and the purchases in it are already booked.']);
  aoa.push([]);
  aoa.push(['Inward dates', `${humanDate(res.from)} to ${humanDate(res.to)}`]);
  aoa.push(['Generated', fmtIST(generatedAt)]);
  aoa.push([`Sheet "${INWARD_SHEET_NAME}"`, `${plural(n, 'row', 'rows')} — one row per item on one purchase entry`]);
  if (total) {
    moneyRows.push(aoa.length);
    aoa.push([
      'Total of TOTAL INWARD AMOUNT',
      total.file,
      total.ok
        ? `= Purchase Report Grand Total for the same dates, ${rupees(total.report)}`
        : `✗ DOES NOT MATCH the Purchase Report Grand Total (${rupees(total.report)}) — report it`,
    ]);
  }
  if (liquor) {
    const label = `Sheet "${LIQUOR_SHEET_NAME}"`;
    const names = (xs: string[]) => xs.join(', ');
    const withheldText = liquor.withheld.length
      ? ` Left out: ${names(liquor.withheld)} — your login cannot view ${liquor.withheld.length === 1 ? 'that store' : 'those stores'} (Inventory → Liquor Store), so ${liquor.withheld.length === 1 ? 'its' : 'their'} liquor bills are not in this file.`
      : '';
    if (liquor.error) {
      aoa.push([label, null, `✗ Could not be built (${liquor.error}). Report it. "${INWARD_SHEET_NAME}" and its total are not affected.`]);
    } else if (liquor.rows.length === 0) {
      if (liquor.withheld.length) aoa.push([label, null, withheldText.trim()]);
      else {
        moneyRows.push(aoa.length);
        aoa.push([label, 0, `${LIQUOR_NONE_TEXT.replace(/\.$/, '')} — the sheet says so in one line. Any liquor booked as an ordinary purchase line is a purchase line, so it is in "${INWARD_SHEET_NAME}" and the total above, as on the Purchase Report.`]);
      }
    } else {
      const ni = liquor.checks.find(c => c.figure.startsWith('TOTAL INWARD AMOUNT — Net Indent'));
      const niText = !ni || ni.state === 'equal'
        ? `= Net Indent of those bills, ${rupees(liquor.net_indent)}.`
        : ni.state === 'explained'
          ? `Net Indent of those bills is ${rupees(liquor.net_indent)}; the difference is explained below.`
          : `✗ DOES NOT MATCH the Net Indent of those bills (${rupees(liquor.net_indent)}) — report it.`;
      moneyRows.push(aoa.length);
      aoa.push([
        label,
        liquor.total,
        `${plural(liquor.rows.length, 'row', 'rows')} from ${plural(liquor.bills, 'liquor (TGBCL) bill', 'liquor (TGBCL) bills')}, ${names(liquor.stores.map(s => s.name))}. ${niText} Not included in the total above.${withheldText}`,
      ]);
    }
  }
  aoa.push([]);

  // The totals, column by column, against the Purchase Report.
  aoa.push(['Column total', 'This file', 'Purchase Report, same dates', 'Check']);
  for (const c of res.checks) {
    if (c.kind === 'money') moneyRows.push(aoa.length);
    aoa.push([c.figure, c.file, c.report, c.ok ? '✓ equal' : '✗ DOES NOT MATCH — report it']);
  }
  aoa.push([]);

  // The liquor totals, column by column, against the bills' own figures.
  if (liquor && !liquor.error && liquor.checks.length) {
    aoa.push([`"${LIQUOR_SHEET_NAME}" column total`, 'This file', 'The liquor bills, same dates', 'Check']);
    for (const c of liquor.checks) {
      moneyRows.push(aoa.length);
      aoa.push([c.figure, c.file, c.report,
        c.state === 'equal' ? '✓ equal' : c.state === 'explained' ? '✓ differs only as explained below' : '✗ DOES NOT MATCH — report it']);
    }
    if (liquor.explained.length || Math.round(liquor.residual * 100) !== 0) {
      aoa.push(['Why these liquor totals differ from the bills\' own figures:']);
      for (const p of liquor.explained) {
        moneyRows.push(aoa.length);
        aoa.push([`• ${p.label}`, p.amount]);
      }
      if (Math.round(liquor.residual * 100) !== 0) {
        moneyRows.push(aoa.length);
        aoa.push(['• ✗ not explained by anything above — report it', liquor.residual]);
      }
    }
    aoa.push([]);
  }

  // What the columns hold — short and plain.
  const notes: string[] = [
    'Rows: exactly the purchase lines the Purchase Report adds up for these inward dates (bills typed in, goods receipts, CSV uploads, opening stock and imports included). Purchase orders, deliveries still waiting for the kitchen check and voided receipts are not purchases, so they are not here.',
    'CREATED DATE / CREATED TIME: when the delivery was first keyed into the app, Indian time — the goods receipt (GRN) entry, not the kitchen check sign-off; for a purchase with no GRN, when it was saved. CREATED BY: the name of the person who entered the GRN; empty where the app records no person (purchases with no GRN: direct entries, CSV uploads, opening stock, imports) or the login no longer matches a user.',
    `INVOICE ID: the vendor's own bill number (on a cash market run with no bill, our cash voucher number). Our own purchase invoice number is the last column, ${PINV_HEADER}.`,
    'INWARD ID: our GRN number. On a row brought in from a Recaho inward file it is Recaho\'s inward number, as the import noted it. Empty otherwise.',
    'PO ID / PO DATE / PO QTY: from the purchase order the goods were received against, through the GRN. A row with no GRN shows PO ID and PO DATE only where the app has linked it to a purchase order, and PO QTY only where the purchase line itself recorded a PO quantity: nearly all of the July 2026 rows brought in from Recaho carry one, and a Purchases → Generic CSV Upload row carries the PO QTY its file gave, where it gave one (Recaho Inward Upload as it works today records none). No upload keeps the PO number, so such a row can show PO QTY and INWARD QUANTITY VARIANCE with PO ID and PO DATE empty. INWARD QUANTITY VARIANCE = INWARD QTY − PO QTY (minus = short), empty where there is no PO QTY.',
    'Quantities are in purchase units. INWARD QTY × RATE = SUBTOTAL (to the paisa) on every row'
      + (res.qty_rate_misses > 0
        ? ` except ${plural(res.qty_rate_misses, 'row', 'rows')} whose amount was stored as something other than quantity × rate (for example an older bulk-loaded bill with the tax inside the amount); there SUBTOTAL is the amount as stored, the same as on the Purchase Report`
          + (res.qty_rate_pairing_misses > 0 ? ', and the rows named under "Found in this file" below.' : '.')
        : (res.qty_rate_pairing_misses > 0 ? ' except the rows named under "Found in this file" below.' : '.')),
    'TOTAL INWARD AMOUNT = SUBTOTAL − DISCOUNT + CGST + SGST + CESS + DELIVERY CHARGES + (TCS + SPECIAL EXCISE CESS) + MRP ROUND OFF. CESS is the GST compensation cess. Special excise cess is counted once, in the "TCS + SPECIAL EXCISE CESS" column, so EXCISE is empty here.',
    'PAID AMOUNT / BALANCE AMOUNT: filled only for bills paid in cash from the petty-cash box (paid = the line\'s TOTAL INWARD AMOUNT, balance 0). Empty for credit bills: the app does not record vendor payments, so empty does not mean unpaid.',
    'INVOICE URL: a link to the bill photo uploaded in Bill Submission, where there is one. It opens only for someone signed in to the app who can view vendor bills.',
    'Always empty, because the app does not hold them: TO ID, TO DATE and TO QTY (no transfer orders from other outlets), VENDOR CODE and GL CODE (no vendor or ledger codes), SUB CATEGORY (an item has one category), EXTERNAL ITEM ID (no outside item codes), VAT (none recorded).',
    'CATEGORY NAME (in capitals), ITEM NAME, ITEM ID and PURCHASE UNIT are as set on the item today.',
    liquor
      ? `Liquor (TGBCL) bills recorded in the Liquor Store — entered on Goods Receipt (GRN) → TGBCL Liquor Bill, or on the Liquor Store page before that — are never in "${INWARD_SHEET_NAME}" or its total: they go on the "${LIQUOR_SHEET_NAME}" sheet (see below). ${LIQUOR_AS_PURCHASE_TEXT}`
      : `Liquor (TGBCL) bills recorded in the Liquor Store — entered on Goods Receipt (GRN) → TGBCL Liquor Bill, or on the Liquor Store page before that — are not in this file: they are not in the Purchase Report. See Liquor Store → Inward Register. ${LIQUOR_AS_PURCHASE_TEXT}`,
  ];
  aoa.push(['What the columns hold']);
  notes.forEach((t, i) => aoa.push([`${i + 1}. ${t}`]));

  if (liquor) {
    const lq: string[] = [
      `Rows: one row per item line of a liquor (TGBCL) bill recorded in the Liquor Store for these inward dates — the same lines, with the same figures, as Inventory → Liquor Store → Inward Register for the same dates. These bills are not purchases in the Purchase Report, so this sheet is never added to "${INWARD_SHEET_NAME}" or its total.`,
      'INWARD DATE: the date the Liquor Store files the line under (the bill\'s date), as on its Inward Register.',
      'TOTAL INWARD AMOUNT = SUBTOTAL − DISCOUNT + CGST + SGST + EXCISE + DELIVERY CHARGES + (TCS + SPECIAL EXCISE CESS) + MRP ROUND OFF. EXCISE is the Bar Excise Turnover Tax. The four TGBCL charges (Bar Excise Turnover Tax, Special Excise Cess, TCS, MRP Rounding Off) are typed once per bill and spread over its lines in proportion to SUBTOTAL, one line taking the paise left over, exactly as the Liquor Store Inward Register does — so a bill\'s lines add up to its Net Indent (invoice value + the four charges), less any discount and plus any delivery charge or CGST/SGST typed on a line (Net Indent leaves those out).',
      `INVOICE ID: the TGBCL indent / invoice number. For a bill entered on Goods Receipt, INWARD ID is its GRN number and ${PINV_HEADER} is our liquor invoice number (PINV-…-L…); both are empty for a bill entered on the Liquor Store page before liquor bills moved to Goods Receipt.`,
      'CREATED DATE / CREATED TIME / CREATED BY: when the bill was first keyed in, Indian time, and the name of the person who keyed it — the Goods Receipt entry; for a bill entered on the Liquor Store page before the move, when its TGBCL charges were first saved. Empty where the app records neither.',
      'INWARD QTY and RATE are in the PURCHASE UNIT (bottles), as on the Liquor Store register: INWARD QTY × RATE = SUBTOTAL.',
      'Empty on this sheet: PO ID, PO DATE, PO QTY and INWARD QUANTITY VARIANCE (a liquor bill records no purchase order); CESS (liquor carries no GST compensation cess); INVOICE URL (Bill Submission does not take liquor bills, so no bill photo is kept); PAID AMOUNT and BALANCE AMOUNT (the app does not let a liquor bill be paid from the petty-cash box); and the columns that are always empty.',
      'Emergency wine-shop buys (Liquor Store → Wine-shop Purchase) are not TGBCL bills and are not on this sheet.',
      'A store\'s liquor bills are included only if your login can view that store in Inventory → Liquor Store (the Inward Register\'s own rule).',
      `If no liquor bill falls on these dates, the "${LIQUOR_SHEET_NAME}" sheet is still there, with its header row and one line saying so.`,
    ];
    aoa.push([]);
    aoa.push([`The "${LIQUOR_SHEET_NAME}" sheet`]);
    lq.forEach((t, i) => aoa.push([`${i + 1}. ${t}`]));
  }

  const found: string[] = [];
  if (res.subpaise_rows > 0) {
    found.push(`${plural(res.subpaise_rows, 'row holds', 'rows hold')} a fraction of a paisa, as stored. Cells show 2 decimals but keep the exact figure, so the columns add up to the Purchase Report to the paisa.`);
  }
  if (res.understated_rows > 0) {
    found.push(`⚠ ${plural(res.understated_rows, 'row was', 'rows were')} booked from a goods receipt whose bill line has since been deleted: its tax and charges are missing, so TOTAL INWARD AMOUNT is UNDERSTATED there, as on the Purchase Report. Report it.`);
  }
  if (res.qty_rate_pairing_misses > 0) {
    found.push(`⚠ ${plural(res.qty_rate_pairing_misses, 'row', 'rows')} read off a goods-receipt line ${res.qty_rate_pairing_misses === 1 ? 'shows' : 'show'} an INWARD QTY × RATE that is not its SUBTOTAL. The money columns are still the Purchase Report's; report it.`);
  }
  if (res.grn_header_missing > 0) {
    found.push(`⚠ ${plural(res.grn_header_missing, 'row points', 'rows point')} at a goods receipt that no longer exists, so CREATED DATE, CREATED TIME, INWARD ID and CREATED BY are empty there. Report it.`);
  }
  if (liquor && liquor.orphan_lines > 0) {
    found.push(`⚠ ${plural(liquor.orphan_lines, 'liquor line', 'liquor lines')} on these dates belong${liquor.orphan_lines === 1 ? 's' : ''} to an item that no longer exists; the Liquor Store Inward Register leaves ${liquor.orphan_lines === 1 ? 'it' : 'them'} out too, so ${liquor.orphan_lines === 1 ? 'it is' : 'they are'} not on the "${LIQUOR_SHEET_NAME}" sheet. Report it.`);
  }
  if (found.length) {
    aoa.push([]);
    aoa.push(['Found in this file']);
    found.forEach(t => aoa.push([`• ${t}`]));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (const r of moneyRows) {
    for (let ci = 1; ci <= 2; ci++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: ci })];
      if (cell && cell.t === 'n') cell.z = MONEY_FMT;
    }
  }
  ws['!cols'] = [{ wch: 34 }, { wch: 18 }, { wch: 30 }, { wch: 30 }];
  return ws;
}

/**
 * The workbook: "About this file" FIRST (the re-import guard), then the
 * inward sheet, then — only when a liquor section is passed — "Liquor Inward".
 */
export function buildPurchaseInwardWorkbook(
  res: InwardResult,
  opts: { generatedAt?: Date; liquor?: LiquorInwardSection } = {},
): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, aboutSheet(res, opts.generatedAt || new Date(), opts.liquor), ABOUT_SHEET_NAME);
  XLSX.utils.book_append_sheet(wb, inwardSheet(res.rows), INWARD_SHEET_NAME);
  const frozen = [2];
  if (opts.liquor) {
    XLSX.utils.book_append_sheet(wb, liquorSheet(opts.liquor), LIQUOR_SHEET_NAME);
    frozen.push(3);
  }
  const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
  return freezeHeaderRows(raw, frozen);
}
