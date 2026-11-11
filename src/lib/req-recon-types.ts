/**
 * REQUESTED → ORDERED → RECEIVED — the wire shapes and the plain-word rules,
 * shared by the server (src/lib/req-recon.ts, its API route and its Excel
 * file) and the page (src/app/reports/requested-vs-received/page.tsx).
 *
 * CLIENT-SAFE: this file imports nothing, so the page can pull the rule
 * sentences from here and the screen and the Excel file always say the same
 * thing about what was counted.
 */

/** The catalog path of the page. The API asks the access question about it. */
export const REQ_RECON_PAGE = '/reports/requested-vs-received';

/**
 * Where the rate behind "₹ Requested (estimate)" came from, in priority order.
 * Every one is a price actually paid or ordered. The item's stored average cost
 * is deliberately NOT a fallback: on items never bought it is held on the wrong
 * basis often enough (MAKHANA - FOXNUT would read ₹3,55,510 per kg) that an
 * estimate built on it would be confidently wrong.
 */
export type ReqReconRateBasis = 'received' | 'ordered' | 'last_purchase';

/** Plain words for each rate basis — screen and Excel. */
export const RATE_BASIS_WORDS: Record<ReqReconRateBasis, string> = {
  received: 'Average rate received in this period',
  ordered: 'Average PO rate in this period',
  last_purchase: 'Latest purchase rate',
};
/**
 * The same words mid-sentence (the documents dialog: "₹ Requested uses ₹50.00
 * per kg — average PO rate in this period"). Written out, never made with
 * toLowerCase(), which printed "average po rate" (checker nit): only the first
 * letter is lowered, so "PO" stays "PO".
 */
export const RATE_BASIS_WORDS_MID: Record<ReqReconRateBasis, string> = {
  received: 'average rate received in this period',
  ordered: 'average PO rate in this period',
  last_purchase: 'latest purchase rate',
};

/** Another department that asked for the same item in the same period. */
export interface ReqReconOther {
  /** Main department name (sections roll up to their main department). */
  department: string;
  /** In the item's purchase unit; null when none of its lines could be converted. */
  qty: number | null;
  lines: number;
}

export interface ReqReconItem {
  material_id: string;
  item: string;
  sku: string;
  category: string;
  /** The item's PURCHASE unit — every quantity on the row is in it. */
  unit: string;
  /** No raw_materials row for this id (kept, never dropped). */
  unlinked: boolean;

  requested_qty: number;
  requested_lines: number;
  /** Lines in a unit that cannot be converted to the purchase unit — NOT in requested_qty. */
  requested_unconverted: number;
  /** Lines with no unit recorded, read as the purchase unit (included). */
  requested_unit_assumed: number;

  ordered_qty: number;
  ordered_value: number;
  ordered_lines: number;
  /** PO lines whose vendor was closed on the order before anything arrived — NOT in ordered_qty. */
  closed_qty: number;
  closed_lines: number;

  received_qty: number;
  received_value: number;
  received_lines: number;

  /** Delivered, waiting for the kitchen's quality check — NOT in received_qty. */
  held_qty: number;
  held_value: number;
  held_lines: number;

  /** ₹ per purchase unit used for the requested estimate; null = no rate at all. */
  rate: number | null;
  rate_basis: ReqReconRateBasis | null;
  /** Date of the purchase the rate came from (latest-purchase basis only). */
  rate_as_of: string | null;
  /** requested_qty × rate, rounded to the paisa (so the rows add up to the total); null when there is no rate. AN ESTIMATE. */
  requested_value: number | null;

  ordered_minus_requested: number;
  received_minus_ordered: number;

  /** Other departments' counted requests for this item in the period (department view only). */
  others: ReqReconOther[];
}

export interface ReqReconTotals {
  /** Σ requested_value over items that have a rate. AN ESTIMATE. */
  requested_value: number;
  /** Items with a requested quantity but no rate — not in requested_value. */
  items_without_rate: number;
  ordered_value: number;
  received_value: number;
  held_value: number;
}

export interface ReqReconCounts {
  items: number;
  requisitions: number;
  request_lines: number;
  purchase_orders: number;
  po_lines: number;
  receipt_lines: number;
  held_lines: number;
  closed_lines: number;
  shared_items: number;
  unconverted_lines: number;
  unit_assumed_lines: number;
}

export interface ReqReconDept {
  id: string; name: string; is_active: boolean;
  /**
   * The department has sections under it, at any depth — the report's own
   * rule for what a view of it counts (req-recon.ts subtree(): more than the
   * department itself). Only then do the words say "with its sections".
   */
  has_sections: boolean;
}

export interface ReqReconResponse {
  from: string;
  to: string;
  /** null = All departments. */
  department: ReqReconDept | null;
  /** Main departments for the picker (sections roll up into these). */
  departments: ReqReconDept[];
  items: ReqReconItem[];
  totals: ReqReconTotals;
  counts: ReqReconCounts;
  /** What the Purchase Report books into stock for the same dates, ALL items (Spend). */
  purchase_report_booked: number;
  /** All departments only: Σ received_value === purchase_report_booked, to the paisa. */
  matches_purchase_report: boolean | null;
}

/* ── drill-down ─────────────────────────────────────────────────────────── */

export interface ReqReconRequestRow {
  date: string;
  req_number: string;
  /** The LINE's own department, else its requisition's (a section, or the main department itself). */
  department: string;
  /** Its main department. */
  main_department: string;
  raised_by: string;
  party: boolean;
  status_label: string;
  /** As asked, in the line's own unit. */
  qty: number;
  /** The line's own unit; '' when the line recorded none (it is then read in the purchase unit — see note). */
  line_unit: string;
  /** The same quantity in the item's purchase unit; null when it cannot be converted. */
  qty_purchase: number | null;
  /** HOD-approved quantity, line unit, when the HOD changed it. */
  approved_qty: number | null;
  counted: boolean;
  /** Why not counted, or a fact worth knowing about a counted line. '' = nothing. */
  note: string;
  /** false = another department's request (shown for shared items, never counted here). */
  in_view: boolean;
}

export interface ReqReconPoRow {
  date: string;
  po_number: string;
  vendor: string;
  qty: number;
  rate: number;
  value: number;
  status_label: string;
  counted: boolean;
  note: string;
  /** Accepted against this PO line so far (any date), purchase units. Held / voided receipts excluded. */
  received_on_line: number;
  /** Requisitions this PO line was raised for, e.g. "REQ-2026-0012 (Akan Tandoori)". '' = none recorded. */
  raised_for: string;
}

export type ReqReconReceiptKind = 'booked' | 'held' | 'void' | 'rejected';

export interface ReqReconReceiptRow {
  kind: ReqReconReceiptKind;
  date: string;
  grn_number: string;
  /** Our invoice id (PINV-…). */
  invoice_id: string;
  bill_no: string;
  po_number: string;
  vendor: string;
  /** booked: accepted + booked qty · held: delivered qty · void: qty on the voided receipt · rejected: 0. */
  qty: number;
  rejected_qty: number;
  rate: number;
  /** booked: booked ₹ · held / void: qty × rate, NOT booked · rejected: 0. */
  value: number;
  counted: boolean;
  status_label: string;
}

export interface ReqReconDetail {
  from: string;
  to: string;
  department: ReqReconDept | null;
  item: ReqReconItem | null;
  /** The item's name even when it is not a row of this view. */
  item_name: string;
  unit: string;
  requests: ReqReconRequestRow[];
  purchase_orders: ReqReconPoRow[];
  receipts: ReqReconReceiptRow[];
}

/* ── the rules, in plain words (screen + Excel) ─────────────────────────── */

export const RULE_REQUESTED =
  'Requested: requisitions dated in the period, as the department asked for them (before any HOD change). '
  + 'Not counted: drafts, cancelled requisitions, requisitions or lines the HOD rejected, and lines with no quantity asked '
  + '(older imported lines that record only what was issued). '
  + 'A line the store could not supply is still counted — it was asked for. '
  + 'Converted to the item’s purchase unit with its pack size.';

export const RULE_ORDERED =
  'Ordered: purchase-order lines dated in the period on orders awaiting approval, approved or received. '
  + 'Not counted: draft, rejected and cancelled orders, and lines whose vendor was closed on the order before anything arrived. '
  + 'Whole-outlet figure for the item.';

export const RULE_RECEIVED =
  'Received: everything booked into stock in the period — goods accepted at receipt (with or without a PO) and direct purchase entries. '
  + 'Each delivery counts once: the same entries and the same ₹ the Purchase Report books. '
  + 'Not counted: voided receipts, and deliveries still held for the kitchen’s quality check (shown separately). '
  + 'Whole-outlet figure for the item.';

// What the rate code in req-recon.ts build() actually does: the period's
// counted receipts, else the period's counted PO lines, else the latest priced
// purchases row of ANY date (closing-valuation rateMap). A line this report
// does not count — a cancelled or vendor-closed PO line, a voided, QC-held or
// turned-away delivery — never sets the rate, even though the documents list
// beside it shows its own price (screen-r1). Keep these sentences in step.
export const RULE_VALUES =
  '₹ Requested is an ESTIMATE: requested quantity × the item’s average rate received in this period; '
  + 'if nothing was received at a price, its average PO rate in this period; if neither, the rate of its latest purchase at a price, whatever its date. '
  + 'A cancelled or vendor-closed order, a voided receipt, and a delivery held for QC or turned away never give a rate. '
  + 'An item with no rate from any of these is left blank and not added. '
  + '₹ Ordered = PO quantity × PO rate. '
  + '₹ Received = the value booked into stock (goods value; taxes and bill charges are on the Purchase Report).';

/** Why an item's ₹ Requested is blank — the documents dialog (full) and the Excel Notes column (short). */
export const NO_RATE_WORDS =
  'No rate for this item, so ₹ Requested is left blank and not added to the total: nothing counted in this period '
  + 'was received or ordered at a price, and no purchase of it at a price is on record.';
export const NO_RATE_WORDS_SHORT =
  'No rate — ₹ Requested left blank: nothing counted in this period was received or ordered at a price, '
  + 'and no purchase of it at a price is on record';

export const RULE_SHARED =
  'Ordered and Received are totals for the whole outlet. When another department also asked for the item in the period, '
  + 'the row says so, so a large “extra” is not misread.';

/* ── the department and the held-for-QC card, in words (screen + Excel) ──── */

/**
 * The department a view shows: the screen's "Showing …" line, the documents
 * dialog's header and the Excel Summary's Department row. "(with its sections)"
 * only when the department really has sections (has_sections) — ACCOUNTS and
 * HR have none, and said so wrongly before (checker nit).
 */
export function deptViewWords(d: ReqReconDept | null): string {
  if (!d) return 'All departments';
  return d.has_sections ? `${d.name} (with its sections)` : d.name;
}

/** A department's line in the picker: "Kitchen — with its sections", "ACCOUNTS", "Old Bar (inactive)". */
export function deptOptionWords(d: ReqReconDept): string {
  return `${d.name}${d.is_active ? '' : ' (inactive)'}${d.has_sections ? ' — with its sections' : ''}`;
}

/**
 * The line under the "₹ Held for QC" card. It counts deliveries dated in the
 * period that are still held for the kitchen's check — in a department view,
 * only for the items that department asked for (the rows), exactly like every
 * other card there. So a department view says "these items": "Nothing waiting"
 * was false when the outlet had a delivery held for an item outside the view
 * (checker nit). The zero case names the period, because a delivery dated
 * before it can still be held and is not counted here.
 */
export function heldCardWords(heldLines: number, departmentView: boolean): string {
  if (heldLines > 0) {
    return `${plural(heldLines, 'receipt line', 'receipt lines')}${departmentView ? ' for these items' : ''} waiting for the kitchen’s check`;
  }
  return departmentView
    ? 'No delivery of these items in this period is held for QC'
    : 'No delivery in this period is held for QC';
}

/* ── small client-safe formatters ───────────────────────────────────────── */

/** "1 item" / "0 items" / "3 items". */
export function plural(n: number, one: string, many: string): string {
  return `${(Number(n) || 0).toLocaleString('en-IN')} ${n === 1 ? one : many}`;
}

/** "2026-10-01" → "1 Oct 2026". */
export function humanDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${+m[3]} ${MON[+m[2] - 1]} ${m[1]}`;
}

/** The period in words: "1–31 Oct 2026", "28 Sep – 3 Oct 2026", "1 Oct 2026". */
export function periodWords(from: string, to: string): string {
  if (from === to) return humanDate(from);
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from || '');
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(to || '');
  if (!a || !b) return `${humanDate(from)} to ${humanDate(to)}`;
  if (a[1] === b[1] && a[2] === b[2]) {
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${+a[3]}–${+b[3]} ${MON[+a[2] - 1]} ${a[1]}`;
  }
  if (a[1] === b[1]) return `${humanDate(from).replace(` ${a[1]}`, '')} – ${humanDate(to)}`;
  return `${humanDate(from)} – ${humanDate(to)}`;
}
