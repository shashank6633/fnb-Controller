/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ITEM-WISE PURCHASES — the column spec the screen table and the Excel file
 * share (owner ruling 115, 2026-11-05). CLIENT-SAFE: imports nothing, so the
 * page and the server route read one list and cannot head a column two ways.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE LINE = ONE ROW OF `purchases`: one item on one purchase entry, exactly the
 * rows the Summary tab adds up (src/lib/purchase-report-base.ts). Every money
 * figure on a line is read off the SAME effective rail the Summary sums
 * (src/lib/purchase-charges.ts) — the GRN line for goods received against a PO,
 * the purchase row otherwise — so each money column adds up to the Summary card
 * of the same name.
 */

/** The money columns, in screen and file order. */
export type ItemwiseMoneyKey =
  | 'subtotal' | 'discount' | 'taxable'
  | 'cgst' | 'sgst' | 'compensation_cess' | 'special_excise_cess'
  | 'tcs' | 'delivery_charges' | 'mrp_round_off'
  | 'grand_total' | 'booked';

export interface ItemwiseMoneyColumn {
  key: ItemwiseMoneyKey;
  /** Column heading, on screen and in the Excel file. Plain words. */
  header: string;
  /** Hover text on screen. */
  title: string;
  /** May legitimately be negative (MRP round-off). */
  signed?: boolean;
}

export const ITEMWISE_MONEY_COLUMNS: readonly ItemwiseMoneyColumn[] = [
  { key: 'subtotal', header: 'Subtotal',
    // Round 3: true for every kind of line, and shorter. The value and the
    // discount come off the GRN line exactly when the purchase row has no
    // invoice number of ours (PINV) and its GRN line is on record — the
    // grn_line pairing in src/lib/purchase-charges.ts. That is a PO receive,
    // and also a goods receipt without a PO entered before such receipts got
    // a PINV (2026-08-24, 9b927e2). Every other line — PINV ones, old rows
    // with no GRN, and an UNDERSTATED line whose GRN line was deleted — books
    // its Subtotal as the value booked into stock.
    title: 'Goods value: the discount comes off it and the tax and charges are added to it. Where a line has no PINV of ours and its GRN bill line is on record (goods received against a PO, or an older goods receipt), it is that GRN line’s value: the vendor’s full rate on everything received. On every other line it is the value booked into stock, with any discount taken off the rate already inside it, so Discount can read 0 while the vendor’s bill showed one. A few older bills entered in bulk also have their tax inside it.' },
  { key: 'discount', header: 'Discount',
    title: 'The discount recorded for this line. Where a line has no PINV of ours and its GRN bill line is on record (goods received against a PO, or an older goods receipt), it is that GRN line’s own discount. On every other line a discount taken off the rate is already inside the Subtotal, so this can read 0 while the vendor’s bill showed one.' },
  { key: 'taxable', header: 'Taxable Value', title: 'Subtotal − Discount. On a delivery part-rejected at the door GST was charged on the accepted value only, so this can be more than the value GST was charged on — see the GST % hover on that line.' },
  { key: 'cgst', header: 'CGST', title: 'Central GST on the bill for this line.' },
  { key: 'sgst', header: 'SGST', title: 'State GST on the bill for this line.' },
  { key: 'compensation_cess', header: 'Compensation Cess',
    title: 'GST compensation cess (aerated drinks, tobacco). A separate levy from the special excise cess, never added into GST.' },
  { key: 'special_excise_cess', header: 'Special Excise Cess',
    title: 'TGBCL special excise cess — the liquor levy. A separate levy, never added into GST.' },
  { key: 'tcs', header: 'TCS', title: 'Tax collected at source, as billed.' },
  { key: 'delivery_charges', header: 'Delivery', title: 'Transport / delivery charged on the bill.' },
  { key: 'mrp_round_off', header: 'MRP Round-off', title: 'Round-off on the bill. A bill rounded down shows a minus.', signed: true },
  { key: 'grand_total', header: 'Grand Total',
    title: 'Subtotal − Discount + CGST + SGST + both cesses + TCS + Delivery + MRP Round-off: what is payable to the vendor for this line.' },
  { key: 'booked', header: 'Booked into stock',
    title: 'What was recorded into stock for this line, exactly as stored — the figure stock valuation uses. On goods received against a PO it can be lower than the Subtotal: where the discount was taken off the booked rate, or where part of the delivery was rejected at the door (the GRN bill’s Subtotal counts everything received).' },
] as const;

/** Hover text for the Rate column — which rate it is (findings 2026-11-07). */
export const ITEMWISE_RATE_TITLE =
  'The rate booked into stock for this line, after any discount taken off it. Where a line has no PINV of ours and its GRN bill line is on record (goods received against a PO, or an older goods receipt), the Subtotal is that GRN line’s value at the vendor’s full rate on everything received, so Qty × Rate can differ from the Subtotal.';

/**
 * The bill-by-bill sentence when no bill differs, on screen and on the Excel
 * Totals sheet — one wording, with a singular for one bill and plain words for
 * a window with no bills at all. `onSheet` names the Bill-wise sheet.
 */
export function billMatchSentence(bc: ItemwiseBillCheck, onSheet: boolean, fmt: (n: number) => string = String): string {
  if (bc.bills === 0) return 'No bills in these dates.';
  const where = onSheet ? ' on the Bill-wise sheet' : '';
  const tail = onSheet ? ' — the same lines and the same Grand Total.' : '.';
  const n = bc.matched;
  const subject = n === bc.bills
    ? (n === 1 ? `the 1 bill${where} matches` : `all ${fmt(n)} bills${where} match`)
    : `${fmt(n)} of the ${fmt(bc.bills)} bills${where} ${n === 1 ? 'matches' : 'match'}`;
  return `Bill by bill, ${subject} the Purchase Bill Summary for the same dates${tail}${bc.reason ? ` ${bc.reason}` : ''}`;
}

/** "1 bill does not" / "3 bills do not" — for the not-matching sentence. */
export function billsDoNot(n: number, fmt: (n: number) => string = String): string {
  return n === 1 ? '1 bill does not' : `${fmt(n)} bills do not`;
}

/** One line of the list, as the route sends it to the screen. */
export interface ItemwiseRow {
  date: string;
  vendor: string;
  /** The vendor's own bill number. */
  bill_no: string;
  /** Goods receipt number, where the line was booked from a GRN. */
  grn_no: string;
  /** Our invoice id (PINV-…), where one exists. */
  invoice_id: string;
  item: string;
  sku: string;
  category: string;
  qty: number;
  unit: string;
  rate: number;
  subtotal: number;
  discount: number;
  taxable: number;
  /** GST % on this line, 2 dp. null = no GST recorded (shown blank, never 0). */
  gst_percent: number | null;
  cgst: number;
  sgst: number;
  compensation_cess: number;
  special_excise_cess: number;
  tcs: number;
  delivery_charges: number;
  mrp_round_off: number;
  grand_total: number;
  booked: number;
  /** The charges were read off the GRN line (goods received against a PO). */
  from_grn: boolean;
  /** GST % struck on the ACCEPTED value: part of the delivery was rejected at the door. */
  gst_base_accepted: boolean;
  /** A PO-receipt line whose GRN line has been deleted: charges missing, Grand Total short. */
  understated: boolean;
  /** The item record behind this line no longer exists. */
  unlinked: boolean;
}

export type ItemwiseMoney = Record<ItemwiseMoneyKey, number>;

/** One figure the list was checked against, named as on the Summary screen. */
export interface ItemwiseCheck {
  figure: string;
  kind: 'money' | 'count';
  /** Worked out from the lines. */
  lines: number;
  /** The Summary's own figure for the same window and filters. */
  summary: number;
  ok: boolean;
}

/** The headline proof, computed on the server from the same query. */
export interface ItemwiseProof {
  ok: boolean;
  lines: number;
  grand_total: number;
  summary_grand_total: number;
  checks: ItemwiseCheck[];
}

/** Per-bill comparison with the Purchase Bill Summary (only with no filter on). */
export interface ItemwiseBillCheck {
  compared: boolean;
  /** Why it was not compared, when it was not. */
  reason: string;
  bills: number;
  matched: number;
  differences: { bill: string; lines: number; grand_total: number; bill_summary_lines: number | null; bill_summary_grand_total: number | null }[];
}

export interface ItemwiseResponse {
  from: string;
  to: string;
  vendor: string;
  category: string;
  material_id: string;
  material_name: string;
  rows: ItemwiseRow[];
  /** true when `rows` was cut at `row_cap`. The totals are always over every line. */
  truncated: boolean;
  row_cap: number;
  lines: number;
  bills: number;
  days: number;
  /** Σ of every line, per money column — the table's footer. */
  totals: ItemwiseMoney;
  proof: ItemwiseProof;
  bill_check: ItemwiseBillCheck;
  part_rejected_lines: number;
  understated_lines: number;
}
