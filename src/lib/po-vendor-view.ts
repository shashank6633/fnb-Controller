/**
 * ONE PURCHASE ORDER, SEEN VENDOR BY VENDOR — the grouping every PO surface shares.
 *
 * Ruling #63 (2026-10-23): one master PO may carry lines from many vendors, and
 * each vendor's bill is received on its own GRN under the same PO number. The PO
 * list, the PO detail, the approval review, the printed sheet and the vendor PDF
 * all have to split the SAME lines into the SAME vendors, so the split lives here
 * once and every one of them calls it.
 *
 * THE GROUPING IS THE RECEIVE ROUTE'S, NOT A NEW ONE. A line is filed under its
 * own vendor name, else under the PO header's — and two names are the same
 * vendor when they match after trim + lower-case. That is byte-for-byte
 * vendorKeyOf() + the filing rule in src/app/api/purchase-orders/[id]/receive/
 * route.ts, which is what decides which lines go onto which GRN. A screen that
 * grouped any other way would show a vendor "delivered" that receiving still
 * thinks owes goods, or the reverse.
 *
 * NO RUNTIME IMPORTS. This file is imported by 'use client' pages AND by a
 * server route (the vendor PDF); it must stay pure. Do not add an import.
 */

/** Same fold as receive/route.ts vendorKeyOf(). */
export const vendorNameKey = (name: unknown): string => String(name ?? '').trim().toLowerCase();

export interface PoLineLike {
  id: string;
  vendor?: string | null;
  vendor_id?: string | null;
  quantity?: number | null;
  unit_price?: number | null;
  total_price?: number | null;
}
export interface PoHeaderLike { vendor?: string | null; vendor_id?: string | null }

export interface PoVendorGroup<L extends PoLineLike = PoLineLike> {
  /** Receive's grouping key (trimmed, lower-cased filed name). */
  key: string;
  /** What `?vendor=` carries for this vendor: the vendor master id when the
   *  lines know it, else the filed name (a legacy line with no id). */
  param: string;
  vendor_id: string | null;
  /** The filed name as the FIRST line spells it. */
  vendor_name: string;
  lines: L[];
  /** Σ total_price of the lines, rounded to paise — the ORDERED value. */
  ordered_total: number;
}

const r2 = (v: number) => Math.round((Number(v) || 0) * 100) / 100;

/** The vendor a line is FILED under: its own name, else the PO header's. */
export function filedVendorName(line: PoLineLike, po: PoHeaderLike): string {
  return String(line?.vendor ?? '').trim() || String(po?.vendor ?? '').trim();
}

/**
 * Split a PO's lines into vendors, in order of first appearance.
 * vendor_id = the first id a line of that vendor carries; a line with no id of
 * its own that is filed under the header takes the header's id (the receive
 * route does the same when it stamps po_vendor_bills.vendor_id).
 */
export function groupPoLinesByVendor<L extends PoLineLike>(lines: L[], po: PoHeaderLike): PoVendorGroup<L>[] {
  const out: PoVendorGroup<L>[] = [];
  const byKey = new Map<string, PoVendorGroup<L>>();
  const headerKey = vendorNameKey(po?.vendor);
  for (const line of lines || []) {
    const name = filedVendorName(line, po);
    const key = vendorNameKey(name);
    let g = byKey.get(key);
    if (!g) {
      g = { key, param: '', vendor_id: null, vendor_name: name || '(no vendor)', lines: [], ordered_total: 0 };
      byKey.set(key, g);
      out.push(g);
    }
    g.lines.push(line);
    if (!g.vendor_id && line?.vendor_id) g.vendor_id = String(line.vendor_id);
  }
  for (const g of out) {
    if (!g.vendor_id && g.key && g.key === headerKey && po?.vendor_id) g.vendor_id = String(po.vendor_id);
    g.param = g.vendor_id || g.vendor_name;
    g.ordered_total = r2(g.lines.reduce((s, l) => s + (Number(l.total_price) || 0), 0));
  }
  return out;
}

/** Does `?vendor=<param>` name this group? By master id, else by filed name. */
export function vendorParamMatches(g: { vendor_id: string | null; key: string }, param: string | null | undefined): boolean {
  const p = String(param ?? '').trim();
  if (!p) return false;
  if (g.vendor_id && g.vendor_id === p) return true;
  return g.key !== '' && g.key === vendorNameKey(p);
}

/* ── the requisition lines behind a PO line ─────────────────────────────── */

/** One row of po_requisition_lines, joined to its requisition + department
 *  (served by GET /api/purchase-orders/vendor-view?id=). qty_purchase is in
 *  the PO line's PURCHASE unit; qty_line + line_unit are what the department
 *  typed. qty_purchase is null on a legacy single-requisition link (that path
 *  never stored a per-department share). */
export interface PoReqLink {
  id: string;
  po_item_id: string;
  requisition_id: string | null;
  req_number: string;
  req_item_id: string | null;
  department_id: string | null;
  department_name: string;
  qty_purchase: number | null;
  qty_line: number | null;
  line_unit: string;
  is_party: boolean;
  event_name: string;
  delivered_direct: boolean;
  vendor_closed: boolean;
  created_at: string;
  /** 'merge' = a po_requisition_lines row; 'legacy' = derived from
   *  purchase_order_items.req_item_id (the per-requisition PO tick). */
  source: 'merge' | 'legacy';
}

export type LinkArrivalState = 'arrived' | 'part' | 'none' | 'held' | 'direct' | 'closed' | 'unknown';
export interface LinkArrival { state: LinkArrivalState; covered: number }

/**
 * Has this department's share of a PO line arrived? VALUE-based, the contract's
 * rule: the line's ACCEPTED quantity (void and QC-held receipts count as nothing)
 * covers the links in creation order — the first department to ask is the first
 * to be covered. `acceptedQty` null = no live receipt on the line.
 *
 * delivered_direct and vendor_closed win over arithmetic: a Direct Issue line
 * landed on the rule's department ledger, and a closed vendor's line is not
 * coming. A held line is 'held' (the goods are in, the kitchen has not signed).
 */
export function linkArrivals(
  links: PoReqLink[],
  received: { acceptedQty: number | null; held: boolean },
): Map<string, LinkArrival> {
  const out = new Map<string, LinkArrival>();
  const ordered = [...links].sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  let left = received.acceptedQty == null ? null : Math.max(0, Number(received.acceptedQty) || 0);
  const EPS = 1e-6;
  for (const l of ordered) {
    if (l.delivered_direct) { out.set(l.id, { state: 'direct', covered: 0 }); continue; }
    if (l.vendor_closed)    { out.set(l.id, { state: 'closed', covered: 0 }); continue; }
    if (l.qty_purchase == null) { out.set(l.id, { state: 'unknown', covered: 0 }); continue; }
    if (received.held)      { out.set(l.id, { state: 'held', covered: 0 }); continue; }
    if (left == null)       { out.set(l.id, { state: 'none', covered: 0 }); continue; }
    const need = Math.max(0, Number(l.qty_purchase) || 0);
    if (left + EPS >= need) { out.set(l.id, { state: 'arrived', covered: need }); left -= need; }
    else if (left > EPS)    { out.set(l.id, { state: 'part', covered: left }); left = 0; }
    else                    { out.set(l.id, { state: 'none', covered: 0 }); }
  }
  return out;
}

/** The vendor-close record (po_vendor_closures), as the vendor-view route serves it. */
export interface PoVendorClosure {
  vendor_id: string;
  vendor_name: string;
  reason: string;
  closed_by: string;
  closed_at: string;
}

/* ── where one vendor stands on a PO (detail + internal sheet) ─────────────── */

export interface VendorGroupState {
  /** 'delivered' = every line has a live receipt; 'closed' = the store closed
   *  the vendor with lines still owed; 'part' = some lines in; 'open' = none. */
  state: 'delivered' | 'closed' | 'part' | 'open';
  in_count: number;
  owed_count: number;
  /** GRN numbers this vendor's lines were received on (live receipts only). */
  grns: string[];
  /** Some received line's receipt is still held for the kitchen's QC. */
  held: boolean;
}

/**
 * A line is IN when GET /api/purchase-orders?id= folded a live receipt onto it
 * (received_line_total present — voided bills are not folded). `heldStatus`
 * is the caller's isReceiptHeldForQc (kept out of here so this file stays
 * import-free).
 */
export function vendorGroupState(
  // Lines are read loosely on purpose: they are PO detail payload rows, and the
  // received_* fields exist only on lines a receipt was folded onto.
  g: { lines: readonly any[] },
  closure: unknown,
  heldStatus: (status: unknown) => boolean,
): VendorGroupState {
  const isIn = (l: any) => l?.received_line_total != null;
  const inLines = g.lines.filter(isIn);
  const in_count = inLines.length;
  const owed_count = g.lines.length - in_count;
  const grns = [...new Set(inLines.map(l => String(l.received_grn_number || '')).filter(Boolean))];
  const held = inLines.some(l => heldStatus(l.received_grn_status));
  const state = owed_count === 0 ? 'delivered' : closure ? 'closed' : in_count > 0 ? 'part' : 'open';
  return { state, in_count, owed_count, grns, held };
}

/* ── who asked for this order: the internal sheet's department breakdown ──── */

export interface DeptBreakdownRow { key: string; name: string; reqs: string[]; lines: number; value: number }
export interface DeptBreakdown {
  rows: DeptBreakdownRow[];
  /** Ordered beyond every requisition share, plus lines with no link at all. */
  top_up_lines: number;
  top_up_value: number;
  /** Lines whose requisition shares add up to MORE than the PO now orders
   *  (the PO was edited after merging) — named so the sheet can say so. */
  over_linked: string[];
}

/**
 * One row per department from po_requisition_lines: its share in PURCHASE
 * units × the PO line's ordered rate, so the rows plus the store's top-up add
 * back to the ordered subtotal. Legacy links (no per-department quantity) are
 * never valued. Returns null when the PO has no merge links at all.
 */
export function departmentBreakdown(
  items: Array<{ id: string; quantity?: unknown; unit_price?: unknown; total_price?: unknown; material_name?: unknown }>,
  linksByItem: Record<string, PoReqLink[]>,
): DeptBreakdown | null {
  const anyMerge = Object.values(linksByItem || {}).some(ls => ls.some(l => l.source === 'merge'));
  if (!anyMerge) return null;
  const rows = new Map<string, { name: string; reqs: Set<string>; lines: number; value: number }>();
  let top_up_lines = 0; let top_up_value = 0; const over_linked: string[] = [];
  for (const it of items || []) {
    const all = linksByItem[String(it.id)] || [];
    const links = all.filter(l => l.source === 'merge' && l.qty_purchase != null);
    const rate = Number(it.unit_price) || 0;
    if (links.length === 0) {
      if (all.length === 0) { top_up_lines++; top_up_value = r2(top_up_value + (Number(it.total_price) || 0)); }
      continue;
    }
    let linked = 0;
    const seen = new Set<string>();
    for (const l of links) {
      const key = l.department_id || l.department_name || '(no department)';
      let row = rows.get(key);
      if (!row) { row = { name: l.department_name || '(no department)', reqs: new Set(), lines: 0, value: 0 }; rows.set(key, row); }
      if (l.req_number) row.reqs.add(l.req_number);
      if (!seen.has(key)) { row.lines++; seen.add(key); }
      row.value = r2(row.value + r2(Number(l.qty_purchase) * rate));
      linked += Number(l.qty_purchase) || 0;
    }
    const extra = (Number(it.quantity) || 0) - linked;
    if (extra > 1e-6) { top_up_lines++; top_up_value = r2(top_up_value + r2(extra * rate)); }
    else if (extra < -1e-6) over_linked.push(String(it.material_name || ''));
  }
  return {
    rows: [...rows.entries()].map(([key, r]) => ({ key, name: r.name, reqs: [...r.reqs], lines: r.lines, value: r.value }))
      .sort((a, b) => b.value - a.value),
    top_up_lines, top_up_value, over_linked,
  };
}

/* ── vendor-level delivery on a PO LIST row ───────────────────────────────── */

export interface VendorProgress { total: number; delivered: number; closed: number; names: string[] }

/**
 * "2 of 5 vendors delivered · 1 closed", from the list API's own line tallies
 * (delivered_vendors / outstanding_vendors — filed by the receive route's rule;
 * a vendor who part-delivered appears in both) plus the PO's vendor closures.
 * DELIVERED = none of its lines is still owed. CLOSED = the store closed it and
 * it still has un-received lines (they are not coming) — counted as closed,
 * never as delivered. Names fold with the receive route's key. null = the list
 * row carries neither tally (a cached payload) — show nothing.
 */
export function vendorProgress(
  delivered: Array<{ vendor_name: string }> | null | undefined,
  outstanding: Array<{ vendor_name: string }> | null | undefined,
  closures: Array<{ vendor_name?: string | null }> | null | undefined,
): VendorProgress | null {
  if (!Array.isArray(delivered) && !Array.isArray(outstanding)) return null;
  const names = new Map<string, string>();
  const owed = new Set<string>();
  for (const v of delivered || []) {
    const k = vendorNameKey(v?.vendor_name);
    if (!names.has(k)) names.set(k, String(v?.vendor_name ?? '').trim() || '(no vendor)');
  }
  for (const v of outstanding || []) {
    const k = vendorNameKey(v?.vendor_name);
    if (!names.has(k)) names.set(k, String(v?.vendor_name ?? '').trim() || '(no vendor)');
    owed.add(k);
  }
  const closedKeys = new Set((closures || []).map(c => vendorNameKey(c?.vendor_name)).filter(k => names.has(k) && owed.has(k)));
  let deliveredCount = 0;
  for (const k of names.keys()) if (!owed.has(k)) deliveredCount++;
  return { total: names.size, delivered: deliveredCount, closed: closedKeys.size, names: [...names.values()] };
}

/** The closure that applies to a vendor group: by vendor-master id, else (a
 *  closure or group with no id) by the receive route's name key. */
export function closureForGroup<C extends { vendor_id?: string | null; vendor_name?: string | null }>(
  closures: C[] | null | undefined, g: { vendor_id: string | null; key: string },
): C | null {
  for (const c of closures || []) {
    if (c.vendor_id && g.vendor_id && c.vendor_id === g.vendor_id) return c;
  }
  for (const c of closures || []) {
    if ((!c.vendor_id || !g.vendor_id) && g.key && vendorNameKey(c.vendor_name) === g.key) return c;
  }
  return null;
}

/** Vendor master identity — the block a vendor copy prints. */
export interface PoVendorIdentity {
  id: string;
  name: string;
  contact_person: string;
  phone: string;
  email: string;
  address: string;
  gstin: string;
  payment_terms: string;
}

/** GET /api/purchase-orders/vendor-view?id=<po> */
export interface PoVendorViewPayload {
  po_id: string;
  merged: boolean;
  /** settings.po_send_to_vendor === '1' — shows the per-vendor Print / PDF. */
  send_to_vendor: boolean;
  /** Store manager or admin (canProcessAsStore) — may close a vendor. */
  can_close_vendor: boolean;
  /** false on a DB where the link/closure tables do not exist yet. */
  links_available: boolean;
  closures: PoVendorClosure[];
  vendors: PoVendorIdentity[];
  /** po_item_id → the requisition lines behind it. */
  links_by_item: Record<string, PoReqLink[]>;
}
