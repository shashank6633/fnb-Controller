'use client';

/**
 * MERGE INTO ONE PO — the shared modal (owner rulings #63-#70, 2026-10-23).
 *
 * Mounted by:
 *   - the store desk header (/store-requisitions, "Merge into one PO"),
 *   - a deferred store-desk line ("Add to a merged PO", opens pre-ticked),
 *   - the /requisitions header (same button, same modal).
 *
 * WHAT IT DOES. Lists every requisition line still OWED to a department
 * (internal and party, deferred and part-issued included) that can go on a PO,
 * from GET /api/purchase-orders/merge/candidates — grouped ONE ROW PER MATERIAL
 * with each department's share under it. The storekeeper ticks the lines to
 * buy, picks a vendor + rate per material (default: the server's suggested
 * vendor and that vendor's own last rate) and saves ONE DRAFT PO through
 * POST /api/purchase-orders/merge. Many vendors on one PO number; each vendor's
 * bill later gets its own GRN under that number (#63). Approval is the whole PO
 * once, on Purchase Orders (#66). Owed lines that CANNOT go on a PO (already on
 * one, liquor / store-mapped, unreadable unit, …) are listed with the server's
 * own reason, never silently dropped.
 *
 * WHAT IT NEVER DOES. It issues nothing and moves no stock: its ticks are its
 * own state, never the store desk's "Issue Selected" set, so a PO pick can never
 * fire a hand-over. It writes no requisition. One material is ONE PO line with
 * ONE vendor (#70 default: no split of one item across vendors).
 *
 * UNITS (owner rule, pack-units.ts): every quantity LEADS with the PURCHASE unit
 * (kg / BTL / PKT); the recipe figure is only ever the small "= 3,000 g" hint.
 * Rates are ₹ per PURCHASE unit — the basis purchase_order_items stores.
 *
 * VENDOR LIST = THE SERVER'S RULE. A PO line may only pair a vendor with an item
 * the Vendor Items map declares (src/lib/vendor-mapping.ts) and the vendor must
 * be active. The dropdown offers exactly the mapped, active vendors the
 * candidates feed names per material (`materials[id].mapped_vendors`); the
 * Vendor Items ?index=1 map is the fallback; only when both are missing does it
 * list every active vendor, and it says so.
 *
 * Who may open it: store manager + admin (#65). The mounting page decides
 * whether to show the button; both routes enforce it regardless.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Loader2, Merge, RefreshCw, Search, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { packFactor, shownPurchaseQty } from '@/lib/pack-units';

/* ════════════════════════════════════════════════════════════════════════════
 * PROPS — the contract every mounting page builds to.
 * ══════════════════════════════════════════════════════════════════════════ */
export interface MergePoModalProps {
  /** Close the modal (Cancel, Escape, backdrop, or Close after a success). */
  onClose: () => void;
  /** Called once the draft PO exists — the page refreshes its badges. */
  onCreated?: (po: { id: string; po_number: string }) => void;
  /** requisition_items ids to tick when the modal opens ("Add to a merged PO"). */
  preselectReqItemIds?: string[];
  /** Optional: render nothing while false. Omit it and mount conditionally instead. */
  open?: boolean;
}

/* ════════════════════════════════════════════════════════════════════════════
 * THE FEED — GET /api/purchase-orders/merge/candidates
 *   { lines: [...orderable], materials: { [material_id]: {...} }, not_orderable: [...] }
 * ══════════════════════════════════════════════════════════════════════════ */
export interface MergeCandidate {
  req_item_id: string;
  requisition_id: string;
  req_number: string;
  purpose: 'internal' | 'party';
  department_id: string;
  department_name: string;
  event_name: string;
  event_date: string;
  material_id: string;
  material_name: string;
  material_category: string;
  /** rm.unit — the RECIPE unit (g / ml / pcs). */
  recipe_unit: string;
  /** rm.purchase_unit (falls back to the recipe unit). */
  purchase_unit: string;
  pack_size: number;
  /** requisition_items.unit — what the department asked in. */
  line_unit: string;
  /** Still owed, in the LINE's own unit. */
  owed_line: number;
  /** Still owed, PURCHASE units (the server's figure; converted here only if absent). */
  owed_purchase: number;
  deferred_until: string;
  /** Already handed over on this line, in the line's own unit (0 = untouched). */
  issued_line: number;
  /** rm.current_stock — the central balance, RECIPE units. null = not sent. */
  current_stock: number | null;
  default_vendor_id: string;
  default_vendor_name: string;
  /** ₹ per PURCHASE unit (purchases.unit_price). 0 = never bought. */
  last_rate: number;
  /** 'default_vendor' = the suggested vendor's own rate; 'any_vendor' = someone else's. */
  last_rate_source: string;
  last_rate_vendor: string;
  last_rate_date: string;
}

/** An owed line the server will NOT put on a PO, with its reason. */
export interface NotOrderable {
  req_item_id: string;
  req_number: string;
  department_id: string;
  department_name: string;
  purpose: 'internal' | 'party';
  material_id: string;
  material_name: string;
  purchase_unit: string;
  owed_purchase: number;
  code: string;
  reason: string;
}

export interface MappedVendor { id: string; name: string; is_active: boolean; last_rate: number | null; last_rate_date: string | null }
export interface MaterialHint {
  mapped_vendors: MappedVendor[];
  default_vendor: { id: string; name: string; source?: string } | null;
  last_purchase: { rate: number; vendor_name: string; date: string } | null;
}

const str = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v: unknown) => {
  if (v == null || v === '') return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
};
export const r3 = (n: number) => { const v = Math.round((Number(n) || 0) * 1000) / 1000; return v === 0 ? 0 : v; };
const r2 = (n: number) => { const v = Math.round((Number(n) || 0) * 100) / 100; return v === 0 ? 0 : v; };

/** Line-unit quantity → PURCHASE units, the store desk's lineUnits rule: a line
 *  stored in the purchase unit converts nothing; a recipe-unit (or legacy blank)
 *  line divides by the shared pack factor. Only used when the feed sends no
 *  owed_purchase. */
export function linePurchaseQty(qtyLine: number, m: { recipe_unit: string; purchase_unit: string; pack_size: number; line_unit: string }): number {
  const pf = packFactor({ unit: m.recipe_unit, purchase_unit: m.purchase_unit, pack_size: m.pack_size });
  const pu = String(m.purchase_unit || m.recipe_unit || '').toLowerCase().trim();
  const lu = String(m.line_unit || '').toLowerCase().trim();
  const isPU = pf > 1 && lu !== '' && lu === pu;
  const q = Number(qtyLine) || 0;
  return isPU ? q : q / pf;
}

/** One raw feed line → MergeCandidate, or null when it names no line. */
export function normalizeCandidate(raw: any): MergeCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.req_item_id);
  const materialId = str(raw.material_id);
  if (!id || !materialId) return null;
  const recipeUnit = str(raw.recipe_unit);
  const purchaseUnit = str(raw.purchase_unit) || recipeUnit;
  const packSize = num(raw.pack_size) || 1;
  const lineUnit = str(raw.line_unit);
  const owedLine = num(raw.owed_line);
  const owedPurchase = numOrNull(raw.owed_purchase);
  return {
    req_item_id: id,
    requisition_id: str(raw.requisition_id),
    req_number: str(raw.req_number),
    purpose: raw.purpose === 'party' ? 'party' : 'internal',
    department_id: str(raw.department_id),
    department_name: str(raw.department_name) || 'No department',
    event_name: str(raw.event_name),
    event_date: str(raw.event_date),
    material_id: materialId,
    material_name: str(raw.material_name) || materialId,
    material_category: str(raw.material_category),
    recipe_unit: recipeUnit,
    purchase_unit: purchaseUnit,
    pack_size: packSize,
    line_unit: lineUnit,
    owed_line: owedLine,
    owed_purchase: owedPurchase != null ? owedPurchase
      : linePurchaseQty(owedLine, { recipe_unit: recipeUnit, purchase_unit: purchaseUnit, pack_size: packSize, line_unit: lineUnit }),
    deferred_until: str(raw.deferred_until),
    issued_line: num(raw.qty_issued),
    current_stock: numOrNull(raw.current_stock),
    default_vendor_id: str(raw.default_vendor_id),
    default_vendor_name: str(raw.default_vendor_name),
    last_rate: num(raw.last_rate),
    last_rate_source: str(raw.last_rate_source),
    last_rate_vendor: str(raw.last_rate_vendor_name ?? raw.last_rate_vendor),
    last_rate_date: str(raw.last_rate_date),
  };
}

export interface MergeFeed {
  lines: MergeCandidate[];
  materials: Record<string, MaterialHint>;
  not_orderable: NotOrderable[];
}

/** The whole candidates payload → the feed (lines de-duplicated by id). */
export function normalizeFeed(payload: any): MergeFeed {
  const rows: any[] = Array.isArray(payload?.lines) ? payload.lines : [];
  const lines: MergeCandidate[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const c = normalizeCandidate(r);
    if (!c || seen.has(c.req_item_id)) continue;
    seen.add(c.req_item_id);
    lines.push(c);
  }
  const materials: Record<string, MaterialHint> = {};
  for (const [mid, h] of Object.entries((payload?.materials || {}) as Record<string, any>)) {
    materials[mid] = {
      mapped_vendors: (Array.isArray(h?.mapped_vendors) ? h.mapped_vendors : []).map((v: any) => ({
        id: str(v?.id), name: str(v?.name) || str(v?.id), is_active: v?.is_active === true || v?.is_active === 1,
        last_rate: numOrNull(v?.last_rate), last_rate_date: v?.last_rate_date ? str(v.last_rate_date) : null,
      })).filter((v: MappedVendor) => !!v.id),
      default_vendor: h?.default_vendor?.id ? { id: str(h.default_vendor.id), name: str(h.default_vendor.name), source: str(h.default_vendor.source) } : null,
      last_purchase: h?.last_purchase && Number(h.last_purchase.rate) > 0
        ? { rate: Number(h.last_purchase.rate), vendor_name: str(h.last_purchase.vendor_name), date: str(h.last_purchase.date) }
        : null,
    };
  }
  const not_orderable: NotOrderable[] = (Array.isArray(payload?.not_orderable) ? payload.not_orderable : [])
    .filter((r: any) => r && r.req_item_id)
    .map((r: any) => ({
      req_item_id: str(r.req_item_id), req_number: str(r.req_number),
      department_id: str(r.department_id),
      department_name: str(r.department_name) || 'No department',
      purpose: r.purpose === 'party' ? 'party' : 'internal',
      material_id: str(r.material_id), material_name: str(r.material_name) || str(r.material_id),
      purchase_unit: str(r.purchase_unit) || str(r.recipe_unit),
      owed_purchase: num(r.owed_purchase), code: str(r.code), reason: str(r.reason),
    }));
  return { lines, materials, not_orderable };
}

/* ════════════════════════════════════════════════════════════════════════════
 * ONE ROW PER MATERIAL.
 * ══════════════════════════════════════════════════════════════════════════ */
export interface MaterialGroup {
  material_id: string;
  material_name: string;
  material_category: string;
  recipe_unit: string;
  purchase_unit: string;
  pack_size: number;
  lines: MergeCandidate[];
  /** RECIPE units, material-level (same on every line); null when not sent. */
  current_stock: number | null;
  default_vendor_id: string;
  default_vendor_name: string;
  hint: MaterialHint | null;
  /** The feed line's rate fields (used only when `hint` is absent). */
  last_rate: number;
  last_rate_vendor: string;
  last_rate_date: string;
}

export function groupCandidates(cands: MergeCandidate[], materials: Record<string, MaterialHint> = {}): MaterialGroup[] {
  const by = new Map<string, MaterialGroup>();
  for (const c of cands) {
    let g = by.get(c.material_id);
    if (!g) {
      g = {
        material_id: c.material_id, material_name: c.material_name, material_category: c.material_category,
        recipe_unit: c.recipe_unit, purchase_unit: c.purchase_unit, pack_size: c.pack_size,
        lines: [], current_stock: c.current_stock,
        default_vendor_id: c.default_vendor_id, default_vendor_name: c.default_vendor_name,
        hint: materials[c.material_id] || null,
        last_rate: c.last_rate, last_rate_vendor: c.last_rate_vendor, last_rate_date: c.last_rate_date,
      };
      by.set(c.material_id, g);
    }
    g.lines.push(c);
    if (g.current_stock == null && c.current_stock != null) g.current_stock = c.current_stock;
    if (!g.default_vendor_id && c.default_vendor_id) { g.default_vendor_id = c.default_vendor_id; g.default_vendor_name = c.default_vendor_name; }
  }
  const groups = [...by.values()];
  for (const g of groups) {
    g.lines.sort((a, b) => a.department_name.localeCompare(b.department_name, undefined, { sensitivity: 'base' })
      || a.req_number.localeCompare(b.req_number));
  }
  groups.sort((a, b) => a.material_name.localeCompare(b.material_name, undefined, { sensitivity: 'base' }));
  return groups;
}

/** Σ owed of the ticked lines of one material, PURCHASE units (3 dp) — the
 *  same rounding the merge route applies to its default quantity. */
export function tickedOwedPurchase(g: MaterialGroup, ticked: Set<string>): number {
  let s = 0;
  for (const l of g.lines) if (ticked.has(l.req_item_id)) s += l.owed_purchase;
  return r3(s);
}

/* ════════════════════════════════════════════════════════════════════════════
 * VENDORS AND RATES
 * ══════════════════════════════════════════════════════════════════════════ */
export interface VendorOpt { id: string; name: string }
export interface VendorIndex {
  by_vendor?: Record<string, string[]>;
  vendor_names?: Record<string, string>;
}

/** material_id → mapped vendors from the Vendor Items ?index=1 map (A-Z),
 *  restricted to ACTIVE vendors when that list is known. The fallback when the
 *  candidates feed sends no `materials` entry for an item. */
export function vendorsByMaterialOf(idx: VendorIndex | null, active: VendorOpt[] | null): Record<string, VendorOpt[]> {
  const m: Record<string, VendorOpt[]> = {};
  if (!idx) return m;
  const names = idx.vendor_names || {};
  const activeIds = active ? new Set(active.map(v => v.id)) : null;
  for (const [vid, mids] of Object.entries(idx.by_vendor || {})) {
    if (activeIds && !activeIds.has(vid)) continue;
    for (const mid of mids) (m[mid] ||= []).push({ id: vid, name: names[vid] || vid });
  }
  for (const list of Object.values(m)) list.sort((a, b) => a.name.localeCompare(b.name));
  return m;
}

/** The vendors a material may be ordered from (mapped AND active), or null
 *  when nothing tells us (the server then decides, and the page says so). */
export function mappedVendorsFor(g: MaterialGroup, fallback: Record<string, VendorOpt[]> | null): VendorOpt[] | null {
  if (g.hint) {
    return g.hint.mapped_vendors.filter(v => v.is_active).map(v => ({ id: v.id, name: v.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  if (fallback) return fallback[g.material_id] || [];
  return null;
}

/** The vendor a material starts with: the server's suggestion when it is
 *  orderable (or nothing says otherwise), else the only mapped vendor, else none. */
export function defaultVendorFor(g: MaterialGroup, mapped: VendorOpt[] | null): string {
  if (g.default_vendor_id && (mapped == null || mapped.some(v => v.id === g.default_vendor_id))) return g.default_vendor_id;
  if (mapped && mapped.length === 1) return mapped[0].id;
  return '';
}

export interface RateHint {
  rate: number;
  /** 'vendor' = this vendor's own last rate; 'other' = the last rate paid to someone else. */
  source: 'vendor' | 'other';
  vendor_name: string;
  date: string;
}

/** The last ₹/purchase-unit paid that bears on `vendorId`: that vendor's own
 *  last rate for this item when there is one, else the last rate paid to
 *  anyone (named as such). null = this item was never bought. Never another
 *  vendor's rate under this vendor's name. */
export function rateHintFor(g: MaterialGroup, vendorId: string): RateHint | null {
  const h = g.hint;
  if (h) {
    const own = vendorId ? h.mapped_vendors.find(v => v.id === vendorId) : undefined;
    if (own && own.last_rate != null && own.last_rate > 0) {
      return { rate: own.last_rate, source: 'vendor', vendor_name: own.name, date: own.last_rate_date || '' };
    }
    if (h.last_purchase) {
      const sameName = !!vendorId && h.mapped_vendors.find(v => v.id === vendorId)?.name.trim().toLowerCase()
        === h.last_purchase.vendor_name.trim().toLowerCase();
      return { rate: h.last_purchase.rate, source: sameName ? 'vendor' : 'other', vendor_name: h.last_purchase.vendor_name, date: h.last_purchase.date };
    }
    return null;
  }
  if (g.last_rate > 0) {
    const own = !!vendorId && vendorId === g.default_vendor_id
      && g.last_rate_vendor.trim().toLowerCase() === g.default_vendor_name.trim().toLowerCase();
    return { rate: g.last_rate, source: own ? 'vendor' : 'other', vendor_name: g.last_rate_vendor, date: g.last_rate_date };
  }
  return null;
}

const rateText = (n: number) => String(Math.round(n * 10000) / 10000);

/* ════════════════════════════════════════════════════════════════════════════
 * THE SAVE — validation + the POST body, pure so it can be proved.
 * ══════════════════════════════════════════════════════════════════════════ */
export interface GroupChoice {
  vendor_id: string;
  /** ₹ per purchase unit, as typed. */
  rate: string;
  /** true once the person typed a rate — a vendor change then leaves it alone. */
  rate_user: boolean;
  /** Purchase units as typed; undefined = follow what the ticked lines owe. */
  buy: string | undefined;
}
const EMPTY_CHOICE: GroupChoice = { vendor_id: '', rate: '', rate_user: false, buy: undefined };

export interface GroupCheck {
  material_id: string; material_name: string;
  included: boolean;      // at least one ticked line
  buyQty: number;         // PURCHASE units
  rate: number;           // ₹ / purchase unit (NaN when blank / not a number)
  amount: number;         // ₹, 0 when not computable
  errors: string[];
  shortOfOwed: number;    // purchase units the buy falls short of the ticked owed (0 = none)
}

export function checkGroup(g: MaterialGroup, ticked: Set<string>, choice: GroupChoice, mapped: VendorOpt[] | null): GroupCheck {
  const owed = tickedOwedPurchase(g, ticked);
  const included = g.lines.some(l => ticked.has(l.req_item_id));
  const buyQty = choice.buy == null || choice.buy.trim() === '' ? owed : Number(choice.buy);
  const rt = String(choice.rate ?? '').trim();
  const rate = rt === '' ? NaN : Number(rt);
  const errors: string[] = [];
  if (included) {
    if (!choice.vendor_id) {
      errors.push(mapped != null && mapped.length === 0
        ? 'No active vendor is mapped to this item — map one on Vendor Items first'
        : 'Pick a vendor');
    } else if (mapped != null && !mapped.some(v => v.id === choice.vendor_id)) {
      errors.push('This vendor is not mapped to this item (or is inactive) — pick another');
    }
    if (!Number.isFinite(buyQty)) errors.push('The quantity is not a number');
    else if (!(buyQty > 0)) errors.push('Enter a quantity above 0');
    if (rt === '') errors.push('Enter the rate');
    else if (!Number.isFinite(rate)) errors.push('The rate is not a number');
    else if (rate < 0) errors.push('The rate cannot be negative');
  }
  const amount = included && Number.isFinite(buyQty) && buyQty > 0 && Number.isFinite(rate) && rate >= 0
    ? r2(buyQty * rate) : 0;
  const shortOfOwed = included && Number.isFinite(buyQty) && buyQty > 0 && owed - buyQty > 1e-9 ? r3(owed - buyQty) : 0;
  return { material_id: g.material_id, material_name: g.material_name, included, buyQty, rate, amount, errors, shortOfOwed };
}

export interface MergeBody {
  requisition_item_ids: string[];
  lines: Array<{ material_id: string; vendor_id: string; rate: number; qty_purchase: number }>;
  notes: string;
  expected_date: string | null;
}

/** The exact POST /api/purchase-orders/merge body for the current choices:
 *  only ticked lines, one PO line per material that has a ticked line. */
export function buildMergeBody(
  groups: MaterialGroup[], ticked: Set<string>, choices: Record<string, GroupChoice>,
  notes: string, expectedDate: string,
): MergeBody {
  const ids: string[] = [];
  const lines: MergeBody['lines'] = [];
  for (const g of groups) {
    const mine = g.lines.filter(l => ticked.has(l.req_item_id));
    if (mine.length === 0) continue;
    for (const l of mine) ids.push(l.req_item_id);
    const ch = choices[g.material_id] || EMPTY_CHOICE;
    const buy = ch.buy == null || ch.buy.trim() === '' ? tickedOwedPurchase(g, ticked) : Number(ch.buy);
    lines.push({ material_id: g.material_id, vendor_id: ch.vendor_id, rate: Number(String(ch.rate).trim()), qty_purchase: buy });
  }
  return { requisition_item_ids: ids, lines, notes: notes.trim(), expected_date: expectedDate.trim() || null };
}

/** Subtotals per chosen vendor over the included materials (₹). */
export function vendorTotals(
  checks: GroupCheck[], choices: Record<string, GroupChoice>, vendorName: (id: string) => string,
): { vendors: Array<{ id: string; name: string; items: number; amount: number }>; unassigned: number; total: number } {
  const by = new Map<string, { id: string; name: string; items: number; amount: number }>();
  let unassigned = 0; let total = 0;
  for (const c of checks) {
    if (!c.included) continue;
    const vid = choices[c.material_id]?.vendor_id || '';
    if (!vid) { unassigned++; continue; }
    let v = by.get(vid);
    if (!v) { v = { id: vid, name: vendorName(vid), items: 0, amount: 0 }; by.set(vid, v); }
    v.items++; v.amount = r2(v.amount + c.amount); total = r2(total + c.amount);
  }
  return { vendors: [...by.values()].sort((a, b) => a.name.localeCompare(b.name)), unassigned, total };
}

/* ════════════════════════════════════════════════════════════════════════════
 * THE BADGES a requisition line carries once a PO buys for it — read from the
 * per-line fields GET /api/requisitions?id= adds (po-helpers.ts
 * requisitionLinePoState). Shared by the store desk and any desk that reads the
 * same feed.
 * ══════════════════════════════════════════════════════════════════════════ */
export interface MergeLineFields {
  on_po?: { po_id?: string | null; po_number?: string | null; vendor_name?: string | null; status?: string | null } | null;
  arrived?: { grn_number?: string | null; at?: string | null; qty_purchase?: number | null } | null;
  arrived_partial?: { grn_number?: string | null; at?: string | null; qty_purchase?: number | null; of_qty_purchase?: number | null } | null;
  delivered_direct?: unknown;
  vendor_closed?: unknown;
  vendor_closed_reason?: string | null;
  also_on_po?: Array<{ po_id?: string | null; po_number?: string | null; status?: string | null }> | null;
  /** The department a Direct Issue rule sent the goods to, when the feed names it. */
  delivered_direct_dept?: string | null;
  delivered_direct_dept_name?: string | null;
  /** The bill (GRN number) the Direct Issue delivery came on, when the feed names it. */
  delivered_direct_grn?: string | null;
}

export function poStatusWord(status: unknown): string {
  const s = str(status).toLowerCase();
  switch (s) {
    case 'draft': return 'draft';
    case 'pending': return 'awaiting approval';
    case 'pending_reapproval': return 'awaiting re-approval';
    case 'approved': return 'approved';
    case 'received': return 'received';
    case 'rejected': return 'rejected';
    case 'cancelled': return 'cancelled';
    default: return s || 'status unknown';
  }
}

/** /purchase-orders link for a PO. ?q= is what the page has always read (it
 *  widens the tab to All and seeds the search); ?id= rides along for the
 *  page's own deep link. */
export function poHref(po: { po_id?: string | null; po_number?: string | null } | null | undefined): string {
  const qs = new URLSearchParams();
  if (po?.po_number) qs.set('q', String(po.po_number));
  if (po?.po_id) qs.set('id', String(po.po_id));
  const s = qs.toString();
  return s ? `/purchase-orders?${s}` : '/purchase-orders';
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || (typeof v === 'object' && v != null);

export function isDeliveredDirect(line: MergeLineFields | null | undefined): boolean {
  return !!line && truthy(line.delivered_direct);
}
export function isVendorClosed(line: MergeLineFields | null | undefined): boolean {
  return !!line && truthy(line.vendor_closed);
}
/** The department a Direct Issue delivery went to — ONLY when the feed names
 *  it. Never guessed: the rule's department is often not the asking one. */
export function deliveredDirectDept(line: MergeLineFields | null | undefined): string {
  if (!line) return '';
  const dd: any = line.delivered_direct;
  if (dd && typeof dd === 'object') {
    const n = str(dd.department_name ?? dd.dept_name ?? dd.to ?? dd.name);
    if (n) return n;
  }
  return str(line.delivered_direct_dept_name ?? line.delivered_direct_dept);
}
/** Is this line held by a live PO — i.e. would the merge refuse it? The feed
 *  never reports a cancelled PO, and a vendor closed without delivering
 *  releases the line (po-helpers.ts held_by). */
export function onOpenPo(line: MergeLineFields | null | undefined): boolean {
  return !!line?.on_po && str(line.on_po.status).toLowerCase() !== 'cancelled' && !isVendorClosed(line);
}

export interface MergeBadge {
  kind: 'direct' | 'closed' | 'arrived' | 'partial' | 'on_po';
  text: string;
  po: MergeLineFields['on_po'];
  title: string;
  tone: string;
}

const fmtNum = (v: number) => (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

/** The ONE badge a line shows, most decisive first:
 *  delivered direct > vendor closed > arrived > part arrived > on a PO.
 *  `pu` = the line's PURCHASE unit (the feed's arrival figures are in it). */
export function mergeBadgeOf(line: MergeLineFields | null | undefined, pu = ''): MergeBadge | null {
  if (!line) return null;
  const po = line.on_po || null;
  const poRef = po?.po_number ? `${po.po_number}${po.vendor_name ? ` (${po.vendor_name})` : ''}` : '';
  if (isDeliveredDirect(line)) {
    const dept = deliveredDirectDept(line);
    return {
      kind: 'direct', po,
      text: `Delivered direct${dept ? ` to ${dept}` : ''} — do not issue`,
      title: `The vendor delivered this item straight to ${dept || 'a department'} under a Direct Issue rule`
        + `${poRef ? ` on ${poRef}` : ''}, so the central store never received it and does not issue it.`
        + ' If the asking department still needs it, the department that received it passes it on by department transfer.',
      tone: 'bg-violet-100 text-violet-800 border-violet-300',
    };
  }
  if (isVendorClosed(line)) {
    return {
      kind: 'closed', po,
      text: 'Vendor closed — not delivered',
      title: `${po?.vendor_name || 'The vendor'} was closed on ${po?.po_number || 'the PO'} before delivering this line`
        + `${line.vendor_closed_reason ? ` (${line.vendor_closed_reason})` : ''}.`
        + ' It is still owed to the department: issue it from stock, defer it, or put it on another PO.',
      tone: 'bg-gray-100 text-gray-700 border-gray-300',
    };
  }
  if (line.arrived && (line.arrived.grn_number || line.arrived.at)) {
    return {
      kind: 'arrived', po,
      text: `Arrived${line.arrived.grn_number ? ` — ${line.arrived.grn_number}` : ''}`,
      title: `This line's share was received into the central store${po?.po_number ? ` on ${po.po_number}` : ''}`
        + `${line.arrived.grn_number ? ` (${line.arrived.grn_number})` : ''}. The line stays open: issue it from here as usual.`,
      tone: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    };
  }
  const part = line.arrived_partial;
  if (part && Number(part.qty_purchase) > 0) {
    const of = Number(part.of_qty_purchase) || 0;
    const u = pu ? ` ${pu}` : '';
    return {
      kind: 'partial', po,
      text: `Part arrived — ${fmtNum(Number(part.qty_purchase))}${of > 0 ? ` of ${fmtNum(of)}` : ''}${u}`
        + `${part.grn_number ? ` · ${part.grn_number}` : ''}`,
      title: `Only part of this line's share has been received${po?.po_number ? ` on ${po.po_number}` : ''}`
        + `${part.grn_number ? ` (latest ${part.grn_number})` : ''}; the rest has not arrived yet.`
        + ' What arrived can be issued from here as usual.',
      tone: 'bg-teal-50 text-teal-800 border-teal-300',
    };
  }
  if (po && (po.po_number || po.po_id)) {
    return {
      kind: 'on_po', po,
      text: `On ${po.po_number || 'a PO'}${po.vendor_name ? ` (${po.vendor_name})` : ''} · ${poStatusWord(po.status)}`,
      title: `This line is on ${po.po_number || 'a purchase order'}${po.vendor_name ? ` from ${po.vendor_name}` : ''}`
        + ` (${poStatusWord(po.status)}). Nothing has arrived for it yet.`,
      tone: 'bg-indigo-50 text-indigo-800 border-indigo-200',
    };
  }
  return null;
}

/** Does the line carry anything a badge would show? */
export function hasMergeState(line: MergeLineFields | null | undefined): boolean {
  return !!mergeBadgeOf(line) || (Array.isArray(line?.also_on_po) && line!.also_on_po!.length > 0);
}

/** The badge as a chip with its PO link, plus a warning when the same line is
 *  on a second live PO (ordered twice). `at` formats the arrival date. */
export function MergeLineBadge({ line, pu, at }: { line: MergeLineFields | null | undefined; pu?: string; at?: (iso: string) => string }) {
  const b = mergeBadgeOf(line, pu || '');
  const twice = (Array.isArray(line?.also_on_po) ? line!.also_on_po! : []).filter(p => p && (p.po_number || p.po_id));
  if (!b && twice.length === 0) return null;
  const arrivedAt = b && b.kind === 'arrived' && line?.arrived?.at && at ? at(String(line.arrived.at)) : '';
  return (
    <span className="inline-flex flex-wrap items-center gap-1 no-underline">
      {b && (
        <span title={b.title} className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold ${b.tone}`}>
          {b.text}{arrivedAt ? ` · ${arrivedAt}` : ''}
        </span>
      )}
      {b && b.po?.po_number && b.kind !== 'on_po' && (
        <a href={poHref(b.po)} title={b.title} className="text-[9px] text-[#af4408] hover:underline">
          {b.po.po_number}
        </a>
      )}
      {b && b.kind === 'on_po' && b.po && (
        <a href={poHref(b.po)} className="text-[9px] text-[#af4408] hover:underline inline-flex items-center gap-0.5">
          open <ExternalLink className="w-2.5 h-2.5" />
        </a>
      )}
      {twice.map(p => (
        <a key={String(p.po_id || p.po_number)} href={poHref(p)}
           title="This line is on two live purchase orders at once — it is being bought twice. Cancel one of them."
           className="text-[9px] px-1.5 py-0.5 rounded border font-semibold bg-red-50 text-red-700 border-red-300 hover:underline">
          Also on {p.po_number || 'another PO'} · {poStatusWord(p.status)} — ordered twice
        </a>
      ))}
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * FORMATTING
 * ══════════════════════════════════════════════════════════════════════════ */
const fmtRs = (v: number) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A purchase figure for an input box: plain digits, 3 dp, no grouping. */
const plain3 = (v: number) => String(r3(v));
/** "23 Oct" — a bare date (purchases.date) or a promised date-time. */
const fmtDay = (iso: string) => {
  if (!iso) return '';
  const s = String(iso).trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`) : new Date(s.replace(' ', 'T'));
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short' });
};
/** Today's IST calendar day, YYYY-MM-DD (the merge route dates the PO the same way). */
const todayIso = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/* ════════════════════════════════════════════════════════════════════════════
 * THE MODAL
 * ══════════════════════════════════════════════════════════════════════════ */
export default function MergePoModal(props: MergePoModalProps) {
  if (props.open === false) return null;
  return <MergePoModalInner {...props} />;
}
export { MergePoModal };

function MergePoModalInner({ onClose, onCreated, preselectReqItemIds }: MergePoModalProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // ── data ──────────────────────────────────────────────────────────────────
  const [feed, setFeed] = useState<MergeFeed | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loadKey, setLoadKey] = useState(0);
  const [active, setActive] = useState<VendorOpt[] | null>(null);
  const [vmIdx, setVmIdx] = useState<VendorIndex | null>(null);
  const [vmFailed, setVmFailed] = useState('');
  // ── save state (declared before the loaders that clear it) ──
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [refusedLines, setRefusedLines] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{ id: string; po_number: string; items: number; vendors: number; total: number; lines: number; depts: number } | null>(null);

  const getJson = async (url: string) => {
    const r = await fetch(url, { credentials: 'same-origin' });
    const ct = r.headers.get('content-type') || '';
    const j = ct.includes('application/json') ? await r.json().catch(() => null) : null;
    if (!r.ok) throw new Error((j && (j.error || j.message)) || `${url} answered HTTP ${r.status}`);
    if (j == null) throw new Error(`${url} did not answer with data`);
    return j;
  };
  useEffect(() => {
    let cancelled = false;
    setLoadError('');
    getJson('/api/purchase-orders/merge/candidates')
      .then(j => {
        if (cancelled) return;
        setFeed(normalizeFeed(j));
        // A reload answers a refusal: the lines it named have moved (onto a PO,
        // or out of the owed set), so the old sentence and marks no longer
        // describe the list.
        setRefusedLines({}); setSaveError('');
      })
      .catch(e => { if (!cancelled) setLoadError(e?.message || 'Could not load the requisition lines.'); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);
  // The Vendor Items map + active vendors: the FALLBACK for an item the feed
  // sends no vendor list for. Advisory — a failure here never blocks the modal.
  useEffect(() => {
    let cancelled = false;
    getJson('/api/vendors')
      .then(j => {
        if (cancelled) return;
        const list = (Array.isArray(j?.vendors) ? j.vendors : [])
          .filter((v: any) => v && (v.is_active === 1 || v.is_active === true))
          .map((v: any) => ({ id: String(v.id), name: String(v.name || v.id) }));
        list.sort((a: VendorOpt, b: VendorOpt) => a.name.localeCompare(b.name));
        setActive(list);
      })
      .catch(() => { if (!cancelled) setActive(null); });
    getJson('/api/vendor-materials?index=1')
      .then(j => { if (!cancelled) { setVmIdx(j || {}); setVmFailed(''); } })
      .catch(e => { if (!cancelled) { setVmIdx(null); setVmFailed(e?.message || 'Could not load the vendor ↔ item map.'); } });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = useMemo(() => groupCandidates(feed?.lines || [], feed?.materials || {}), [feed]);
  const fallbackMap = useMemo(() => (vmIdx ? vendorsByMaterialOf(vmIdx, active) : null), [vmIdx, active]);
  const mappedOf = (g: MaterialGroup) => mappedVendorsFor(g, fallbackMap);
  const vendorNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) for (const v of g.hint?.mapped_vendors || []) m.set(v.id, v.name);
    for (const v of active || []) if (!m.has(v.id)) m.set(v.id, v.name);
    for (const [id, n] of Object.entries(vmIdx?.vendor_names || {})) if (!m.has(id)) m.set(id, n);
    for (const g of groups) if (g.default_vendor_id && g.default_vendor_name && !m.has(g.default_vendor_id)) m.set(g.default_vendor_id, g.default_vendor_name);
    return m;
  }, [active, vmIdx, groups]);
  const vendorName = (id: string) => vendorNames.get(id) || id;
  const groupNeedsFallback = groups.some(g => !g.hint);

  // ── choices ───────────────────────────────────────────────────────────────
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [choices, setChoices] = useState<Record<string, GroupChoice>>({});
  const [notes, setNotes] = useState('');
  const [expected, setExpected] = useState('');
  const [preselectNote, setPreselectNote] = useState<string[]>([]);
  const preselectDone = useRef(false);
  const groupRefs = useRef<Record<string, HTMLTableSectionElement | null>>({});
  const [scrollTo, setScrollTo] = useState<string | null>(null);

  // Seed a vendor + rate for every material that has no choice yet — on the
  // first load and on a reload (a reload keeps every choice already made and
  // every tick whose line is still offered).
  const fallbackReady = !groupNeedsFallback || vmIdx != null || vmFailed !== '';
  useEffect(() => {
    if (!feed || !fallbackReady) return;
    setChoices(prev => {
      const next = { ...prev };
      for (const g of groups) {
        if (next[g.material_id]) continue;
        const vid = defaultVendorFor(g, mappedOf(g));
        const rh = rateHintFor(g, vid);
        next[g.material_id] = { vendor_id: vid, rate: rh ? rateText(rh.rate) : '', rate_user: false, buy: undefined };
      }
      return next;
    });
    const have = new Set(feed.lines.map(c => c.req_item_id));
    setTicked(prev => {
      const kept = new Set([...prev].filter(id => have.has(id)));
      return kept.size === prev.size ? prev : kept;
    });
    if (!preselectDone.current) {
      preselectDone.current = true;
      const pre = (preselectReqItemIds || []).filter(Boolean);
      if (pre.length > 0) {
        setTicked(new Set(pre.filter(id => have.has(id))));
        const msgs: string[] = [];
        for (const id of pre.filter(x => !have.has(x))) {
          const no = feed.not_orderable.find(n => n.req_item_id === id);
          msgs.push(no
            ? `${no.material_name} on ${no.req_number || 'its requisition'} cannot go on a PO here: ${no.reason}`
            : 'The line you came from is not in this list — it is no longer owed, or it was rejected.');
        }
        setPreselectNote(msgs);
        const hit = feed.lines.find(c => pre.includes(c.req_item_id));
        if (hit) setScrollTo(hit.material_id);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed, groups, fallbackReady]);
  useEffect(() => {
    if (!scrollTo) return;
    const el = groupRefs.current[scrollTo];
    if (el) { el.scrollIntoView({ block: 'center' }); setScrollTo(null); }
  }, [scrollTo, groups]);

  const touch = () => { if (saveError) setSaveError(''); };
  const setChoice = (mid: string, patch: Partial<GroupChoice>) => {
    touch();
    setChoices(p => ({ ...p, [mid]: { ...(p[mid] || EMPTY_CHOICE), ...patch } }));
  };
  /** A vendor change carries that vendor's own last rate — unless the person
   *  already typed a rate, which is theirs and stays. */
  const pickVendor = (g: MaterialGroup, vid: string) => {
    const cur = choices[g.material_id] || EMPTY_CHOICE;
    if (cur.rate_user) { setChoice(g.material_id, { vendor_id: vid }); return; }
    const rh = rateHintFor(g, vid);
    setChoice(g.material_id, { vendor_id: vid, rate: rh ? rateText(rh.rate) : cur.rate });
  };
  const toggleLine = (id: string) => {
    touch();
    setTicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const setLines = (ids: string[], on: boolean) => {
    touch();
    setTicked(p => { const n = new Set(p); for (const id of ids) on ? n.add(id) : n.delete(id); return n; });
  };

  // ── filters (display only — they never untick anything) ──────────────────
  const [q, setQ] = useState('');
  const [deptF, setDeptF] = useState('');
  const [purposeF, setPurposeF] = useState<'' | 'internal' | 'party'>('');
  const [showBlocked, setShowBlocked] = useState(false);
  const departments = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of feed?.lines || []) if (c.department_id) m.set(c.department_id, c.department_name);
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [feed]);
  const matchText = (...xs: unknown[]) => {
    const s = q.trim().toLowerCase();
    return !s || xs.some(x => String(x || '').toLowerCase().includes(s));
  };
  const lineShown = (l: MergeCandidate) => (!deptF || l.department_id === deptF)
    && (!purposeF || l.purpose === purposeF)
    && matchText(l.material_name, l.material_category, l.department_name, l.req_number, l.event_name);
  const shownGroups = useMemo(
    () => groups.map(g => ({ g, lines: g.lines.filter(lineShown) })).filter(x => x.lines.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, q, deptF, purposeF]);
  const shownBlocked = (feed?.not_orderable || []).filter(n =>
    (!deptF || n.department_id === deptF)
    && (!purposeF || n.purpose === purposeF)
    && matchText(n.material_name, n.department_name, n.req_number, n.reason));
  /** Orderable = some vendor can take it (or nothing says otherwise). */
  const orderable = (g: MaterialGroup) => { const m = mappedOf(g); return m == null || m.length > 0; };
  const shownOrderableIds = shownGroups.filter(x => orderable(x.g)).flatMap(x => x.lines.map(l => l.req_item_id));

  // ── checks + totals ───────────────────────────────────────────────────────
  const checks = useMemo(
    () => groups.map(g => checkGroup(g, ticked, choices[g.material_id] || EMPTY_CHOICE, mappedOf(g))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, ticked, choices, fallbackMap]);
  const checkOf = useMemo(() => new Map(checks.map(c => [c.material_id, c])), [checks]);
  const included = checks.filter(c => c.included);
  const withErrors = included.filter(c => c.errors.length > 0);
  const totals = vendorTotals(checks, choices, vendorName);
  const tickedLines = (feed?.lines || []).filter(c => ticked.has(c.req_item_id));
  const tickedDepts = new Set(tickedLines.map(c => c.department_id || c.department_name));
  const tickedParty = tickedLines.filter(c => c.purpose === 'party').length;
  const hiddenTicked = tickedLines.filter(c => !lineShown(c)).length;

  // ── save ──────────────────────────────────────────────────────────────────
  const save = async () => {
    if (saving) return;
    if (included.length === 0) { setSaveError('Tick at least one requisition line to buy.'); return; }
    if (withErrors.length > 0) {
      setSaveError(`Fix ${withErrors.length} item${withErrors.length > 1 ? 's' : ''} first: `
        + withErrors.slice(0, 4).map(c => `${c.material_name} (${c.errors[0]})`).join('; ')
        + (withErrors.length > 4 ? ` and ${withErrors.length - 4} more` : '') + '.');
      return;
    }
    const body = buildMergeBody(groups, ticked, choices, notes, expected);
    setSaving(true); setSaveError(''); setRefusedLines({});
    try {
      const r = await api('/api/purchase-orders/merge', { method: 'POST', body });
      const ct = r.headers.get('content-type') || '';
      const j: any = ct.includes('application/json') ? await r.json().catch(() => null) : null;
      if (!r.ok || !j || j.ok === false) {
        // The server's own sentence, verbatim — plus, on the lines it names,
        // the reason for each, so the person can untick exactly those.
        setSaveError((j && (j.error || j.message)) || `The PO was not created (HTTP ${r.status}).`);
        const refused: Record<string, string> = {};
        for (const x of (Array.isArray(j?.details?.refused) ? j.details.refused : [])) {
          if (x?.req_item_id) refused[String(x.req_item_id)] = String(x.reason || x.code || 'refused');
        }
        setRefusedLines(refused);
        return;
      }
      // 201 → { purchase_order, items, links, merged_from } (merge/route.ts).
      const po = j?.purchase_order ?? j?.po ?? null;
      const id = str(po?.id ?? j?.id);
      const poNumber = str(po?.po_number ?? j?.po_number);
      const items = Array.isArray(j?.items) ? j.items : null;
      const total = po?.total_cost != null && Number.isFinite(Number(po.total_cost)) ? Number(po.total_cost) : totals.total;
      setCreated({
        id, po_number: poNumber,
        items: items ? items.length : body.lines.length,
        vendors: new Set((items || body.lines).map((l: any) => String(l.vendor_id || ''))).size,
        total,
        lines: Array.isArray(j?.links) ? j.links.length : body.requisition_item_ids.length,
        depts: tickedDepts.size,
      });
      onCreated?.({ id, po_number: poNumber });
    } catch (e: any) {
      setSaveError(e?.message || 'The PO was not created — the request did not reach the server.');
    } finally { setSaving(false); }
  };

  // A stray backdrop click or Escape must not throw away a half-built PO: once
  // anything is ticked (and nothing was created yet) closing asks first.
  const close = () => {
    if (saving) return;
    if (!created && ticked.size > 0
        && !window.confirm('Close without creating the PO? Your ticks, vendors and rates will be lost.')) return;
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving, created, ticked]);

  if (!mounted) return null;

  const view = (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-2 sm:p-4" onClick={close}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-6xl max-h-[94vh] flex flex-col shadow-xl"
           role="dialog" aria-modal="true" aria-label="Merge requisitions into one PO"
           onClick={e => e.stopPropagation()}>
        {/* ── header ── */}
        <div className="px-5 py-3 border-b border-[#E8D5C4] flex items-start justify-between gap-3">
          <div>
            <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">
              <Merge className="w-4 h-4 text-[#af4408]" /> Merge requisitions into one PO
            </div>
            <div className="text-[11px] text-[#8B7355] mt-0.5 max-w-3xl">
              Requisition lines still owed to a department — internal and party, deferred and part-issued included.
              Tick what to buy; each item becomes one PO line with one vendor. It saves as a <b>DRAFT</b> PO: check it
              and submit it for approval on Purchase Orders. Each vendor&apos;s bill gets its own GRN under the same PO
              number. Nothing is issued from here.
            </div>
          </div>
          <button onClick={close} disabled={saving} aria-label="Close"
                  className="p-1 rounded hover:bg-[#FFF1E3] text-[#8B7355] disabled:opacity-50">
            <X className="w-4 h-4" />
          </button>
        </div>

        {created ? (
          <div className="p-6 space-y-3">
            <div className="flex items-start gap-2 text-emerald-800">
              <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">Draft {created.po_number || 'PO'} created</div>
                <div className="text-sm text-[#6B5744] mt-0.5">
                  {created.items} item{created.items === 1 ? '' : 's'} from {created.vendors} vendor{created.vendors === 1 ? '' : 's'}
                  {' '}· {fmtRs(created.total)} · for {created.lines} requisition line{created.lines === 1 ? '' : 's'}
                  {' '}from {created.depts} department{created.depts === 1 ? '' : 's'}.
                </div>
                <div className="text-xs text-[#8B7355] mt-1">
                  It is a draft: nothing has gone to any vendor yet. Open it on Purchase Orders to check it and submit it
                  for approval. The requisition lines stay open and are issued from the store desk as usual once the
                  goods arrive.
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <a href={poHref({ po_id: created.id, po_number: created.po_number })}
                 className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8f3706] text-white rounded-lg text-sm inline-flex items-center gap-1.5">
                Open {created.po_number || 'the PO'} <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <button onClick={onClose}
                      className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm">
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* ── toolbar ── */}
            <div className="px-5 py-2 border-b border-[#E8D5C4] bg-[#FFF8F0] flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-[#8B7355]" />
                <input value={q} onChange={e => setQ(e.target.value)}
                       placeholder="Search item / department / req# / event…"
                       className="w-full pl-7 pr-2 py-1 border border-[#E8D5C4] rounded text-xs bg-white" />
              </div>
              <select value={deptF} onChange={e => setDeptF(e.target.value)}
                      className="px-2 py-1 border border-[#E8D5C4] rounded text-xs bg-white min-w-[140px]">
                <option value="">All departments</option>
                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <select value={purposeF} onChange={e => setPurposeF(e.target.value as '' | 'internal' | 'party')}
                      className="px-2 py-1 border border-[#E8D5C4] rounded text-xs bg-white">
                <option value="">Internal + party</option>
                <option value="internal">Internal only</option>
                <option value="party">Party only</option>
              </select>
              <button onClick={() => setLines(shownOrderableIds, true)} disabled={shownOrderableIds.length === 0}
                      title="Tick every line shown whose item has a vendor that can supply it"
                      className="px-2 py-1 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded text-xs disabled:opacity-50">
                Tick all shown
              </button>
              <button onClick={() => { touch(); setTicked(new Set()); }} disabled={ticked.size === 0}
                      className="px-2 py-1 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded text-xs disabled:opacity-50">
                Clear ticks
              </button>
              <button onClick={() => setLoadKey(k => k + 1)} disabled={saving}
                      title="Read the owed lines again (keeps your vendors, rates and ticks)"
                      className="px-2 py-1 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded text-xs flex items-center gap-1 disabled:opacity-50">
                <RefreshCw className="w-3 h-3" /> Reload
              </button>
            </div>

            {/* ── notices ── */}
            {((vmFailed && groupNeedsFallback) || preselectNote.length > 0) && (
              <div className="px-5 pt-2 space-y-1">
                {vmFailed && groupNeedsFallback && (
                  <div className="text-[11px] rounded border border-amber-300 bg-amber-50 text-amber-900 px-2 py-1">
                    The vendor ↔ item map could not be loaded ({vmFailed}), so some items list every active vendor. The
                    server refuses a vendor that is not mapped to the item on Vendor Items.
                  </div>
                )}
                {preselectNote.map(n => (
                  <div key={n} className="text-[11px] rounded border border-amber-300 bg-amber-50 text-amber-900 px-2 py-1">{n}</div>
                ))}
              </div>
            )}

            {/* ── the grid ── */}
            <div className="flex-1 overflow-auto px-2 sm:px-5 py-2">
              {loadError ? (
                <div className="m-3 rounded border border-red-200 bg-red-50 text-red-700 text-sm p-3 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {loadError}
                </div>
              ) : feed == null || !fallbackReady ? (
                <div className="p-8 text-center text-sm text-[#8B7355]">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading the owed lines…
                </div>
              ) : groups.length === 0 ? (
                <div className="p-8 text-center text-sm text-[#8B7355]">
                  No owed requisition line can go on a PO right now
                  {feed.not_orderable.length > 0 ? ' — the owed lines below are already on a PO or cannot be bought on one.' : ' — nothing is owed.'}
                </div>
              ) : shownGroups.length === 0 ? (
                <div className="p-8 text-center text-sm text-[#8B7355]">Nothing matches the filter.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-[#FFF1E3] text-[#6B5744] sticky top-0 z-10">
                    <tr>
                      <th className="py-1.5 px-2 w-7"></th>
                      <th className="text-left py-1.5 px-2 font-medium">Item / who asked</th>
                      <th className="text-right py-1.5 px-2 font-medium" title="Still owed to the departments, in the PURCHASE unit">Owed</th>
                      <th className="text-right py-1.5 px-2 font-medium" title="What the central store holds now, in the PURCHASE unit">In store</th>
                      <th className="text-right py-1.5 px-2 font-medium" title="Quantity to order, in the PURCHASE unit. Starts at what the ticked lines owe.">Buy</th>
                      <th className="text-left py-1.5 px-2 font-medium">Vendor</th>
                      <th className="text-right py-1.5 px-2 font-medium" title="₹ per PURCHASE unit">Rate</th>
                      <th className="text-right py-1.5 px-2 font-medium">Amount</th>
                    </tr>
                  </thead>
                  {shownGroups.map(({ g, lines }) => {
                    const pu = g.purchase_unit || g.recipe_unit;
                    const ru = g.recipe_unit;
                    const meta = { unit: g.recipe_unit, purchase_unit: g.purchase_unit, pack_size: g.pack_size };
                    const pf = packFactor(meta);
                    const ck = checkOf.get(g.material_id)!;
                    const ch = choices[g.material_id] || EMPTY_CHOICE;
                    const mapped = mappedOf(g);
                    const vendorOpts: VendorOpt[] = mapped != null ? mapped : (active || []);
                    const owedTicked = tickedOwedPurchase(g, ticked);
                    const owedAll = r3(g.lines.reduce((s, l) => s + l.owed_purchase, 0));
                    const ids = lines.map(l => l.req_item_id);
                    const nTicked = g.lines.filter(l => ticked.has(l.req_item_id)).length;
                    const allOn = ids.length > 0 && ids.every(id => ticked.has(id));
                    const someOn = ids.some(id => ticked.has(id)) && !allOn;
                    const stockPU = g.current_stock != null ? shownPurchaseQty(g.current_stock, meta) : null;
                    const short = stockPU != null && owedAll - stockPU > 1e-9;
                    const canOrder = orderable(g);
                    const buyShown = ch.buy != null ? ch.buy : (ck.included ? plain3(owedTicked) : '');
                    const rh = rateHintFor(g, ch.vendor_id);
                    return (
                      <tbody key={g.material_id} ref={el => { groupRefs.current[g.material_id] = el; }}
                             className={`border-t-2 border-[#E8D5C4] ${ck.included ? 'bg-amber-50/30' : ''}`}>
                        <tr className="align-top">
                          <td className="py-1.5 px-2 text-center">
                            <input type="checkbox" aria-label={`Tick every shown line of ${g.material_name}`}
                                   checked={allOn} disabled={ids.length === 0 || (!canOrder && !someOn && !allOn)}
                                   ref={el => { if (el) el.indeterminate = someOn; }}
                                   onChange={() => setLines(ids, !allOn)}
                                   className="align-middle accent-[#af4408]" />
                          </td>
                          <td className="py-1.5 px-2">
                            <div className="font-semibold text-[#2D1B0E]">{g.material_name}</div>
                            <div className="text-[10px] text-[#8B7355]">
                              {g.material_category || 'Uncategorised'} · {g.lines.length} line{g.lines.length === 1 ? '' : 's'}
                              {nTicked > 0 && <> · <b className="text-[#af4408]">{nTicked} ticked</b></>}
                            </div>
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono">
                            <span title="Owed across every department's line for this item in this list">
                              {fmtNum(owedAll)} <span className="text-[9px] text-[#8B7355]">{pu}</span>
                            </span>
                            {pf > 1 && <div className="text-[9px] text-[#B8A590]">= {fmtNum(r3(owedAll * packFactor(meta)))} {ru}</div>}
                            {nTicked > 0 && Math.abs(owedTicked - owedAll) > 1e-9 && (
                              <div className="text-[9px] text-[#af4408]">ticked {fmtNum(owedTicked)} {pu}</div>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono">
                            {stockPU == null ? <span className="text-[#C0A98F]">—</span> : (
                              <span className={short ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}
                                    title={short ? 'The central store holds less than the departments are owed for this item' : 'What the central store holds now'}>
                                {fmtNum(stockPU)} <span className="text-[9px] text-[#8B7355]">{pu}</span>
                                {pf > 1 && <div className="text-[9px] text-[#B8A590] font-normal">= {fmtNum(g.current_stock!)} {ru}</div>}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-right whitespace-nowrap">
                            <input type="number" step="any" min={0} inputMode="decimal"
                                   value={buyShown} disabled={!ck.included}
                                   placeholder={ck.included ? plain3(owedTicked) : '—'}
                                   onChange={e => setChoice(g.material_id, { buy: e.target.value })}
                                   aria-label={`Quantity of ${g.material_name} to buy, in ${pu}`}
                                   className="w-20 px-1 py-0.5 border border-[#E8D5C4] rounded text-right text-xs bg-white disabled:bg-gray-50" />
                            <span className="ml-0.5 text-[10px] text-[#6B5744]">{pu}</span>
                            {ck.included && ch.buy != null && Math.abs((Number(ch.buy) || 0) - owedTicked) > 1e-9 && (
                              <button onClick={() => setChoice(g.material_id, { buy: undefined })}
                                      className="block ml-auto text-[9px] text-[#af4408] hover:underline">
                                back to owed ({fmtNum(owedTicked)} {pu})
                              </button>
                            )}
                            {ck.included && pf > 1 && Number.isFinite(ck.buyQty) && ck.buyQty > 0 && (
                              <div className="text-[9px] text-[#B8A590]">= {fmtNum(r3(ck.buyQty * packFactor(meta)))} {ru}</div>
                            )}
                          </td>
                          <td className="py-1.5 px-2">
                            {mapped != null && mapped.length === 0 ? (
                              <span className="text-[10px] text-red-700">
                                No active vendor is mapped to this item —{' '}
                                <a href="/vendors/materials" className="underline font-medium">map one on Vendor Items</a>
                              </span>
                            ) : (
                              <select value={ch.vendor_id}
                                      onChange={e => pickVendor(g, e.target.value)}
                                      aria-label={`Vendor for ${g.material_name}`}
                                      className={`w-full min-w-[130px] px-1 py-0.5 border rounded text-xs bg-white ${
                                        ck.included && !ch.vendor_id ? 'border-red-300' : 'border-[#E8D5C4]'}`}>
                                <option value="">— pick vendor —</option>
                                {vendorOpts.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                              </select>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-right whitespace-nowrap">
                            <span className="text-[10px] text-[#8B7355] mr-0.5">₹</span>
                            <input type="number" step="any" min={0} inputMode="decimal"
                                   value={ch.rate}
                                   onChange={e => setChoice(g.material_id, { rate: e.target.value, rate_user: true })}
                                   aria-label={`Rate for ${g.material_name}, rupees per ${pu}`}
                                   className="w-20 px-1 py-0.5 border border-[#E8D5C4] rounded text-right text-xs bg-white" />
                            <span className="ml-0.5 text-[10px] text-[#6B5744]">/{pu}</span>
                            {rh ? (
                              <div className="text-[9px] text-[#8B7355]" title="The last rate paid for this item, per purchase unit">
                                {rh.source === 'vendor'
                                  ? <>last from this vendor {fmtRs(rh.rate)}/{pu}{rh.date ? ` · ${fmtDay(rh.date)}` : ''}</>
                                  : <>{ch.vendor_id ? 'no rate from this vendor yet · ' : ''}last paid {fmtRs(rh.rate)}/{pu}
                                      {rh.vendor_name ? ` to ${rh.vendor_name}` : ''}{rh.date ? ` · ${fmtDay(rh.date)}` : ''}</>}
                              </div>
                            ) : (
                              <div className="text-[9px] text-[#8B7355]">never bought before — type the rate</div>
                            )}
                            {ck.included && Number.isFinite(ck.rate) && ck.rate === 0 && (
                              <div className="text-[9px] text-amber-800">₹0 — the PO cannot be approved until this rate is filled in</div>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono font-semibold text-[#2D1B0E]">
                            {ck.included && ck.amount > 0 ? fmtRs(ck.amount) : <span className="text-[#C0A98F] font-normal">—</span>}
                          </td>
                        </tr>
                        {(ck.errors.length > 0 || ck.shortOfOwed > 0) && (
                          <tr>
                            <td></td>
                            <td colSpan={7} className="px-2 pb-1">
                              {ck.errors.map(e => (
                                <div key={e} className="text-[10px] text-red-700 flex items-center gap-1">
                                  <AlertCircle className="w-3 h-3" /> {e}
                                </div>
                              ))}
                              {ck.shortOfOwed > 0 && (
                                <div className="text-[10px] text-amber-800">
                                  Buying {fmtNum(ck.shortOfOwed)} {pu} less than the ticked lines owe — not every ticked line will
                                  read &quot;arrived&quot; from this PO.
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                        {lines.map(l => {
                          const on = ticked.has(l.req_item_id);
                          const lineIsPU = String(l.line_unit || '').toLowerCase().trim() === String(pu).toLowerCase().trim();
                          const refused = refusedLines[l.req_item_id];
                          return (
                            <tr key={l.req_item_id} className={`text-[11px] ${on ? '' : 'text-[#8B7355]'}`}>
                              <td className="py-0.5 px-2 text-center">
                                <input type="checkbox" checked={on} disabled={!canOrder && !on}
                                       aria-label={`Tick ${l.req_number} ${l.department_name} ${g.material_name}`}
                                       onChange={() => toggleLine(l.req_item_id)}
                                       className="align-middle accent-[#af4408]" />
                              </td>
                              <td className="py-0.5 px-2 pl-4">
                                <span className="font-mono">{l.req_number || 'REQ'}</span>
                                {' · '}<b className="text-[#6B5744]">{l.department_name}</b>
                                {l.purpose === 'party' ? (
                                  <span className="ml-1 text-[8px] px-1 py-0.5 rounded bg-pink-100 text-pink-800 border border-pink-200 font-semibold">
                                    PARTY{l.event_name ? ` · ${l.event_name}` : ''}{l.event_date ? ` · ${l.event_date}` : ''}
                                  </span>
                                ) : null}
                                {l.deferred_until ? <span className="ml-1 text-[9px] text-blue-700">deferred to {fmtDay(l.deferred_until)}</span> : null}
                                {l.issued_line > 0 ? <span className="ml-1 text-[9px] text-violet-700">part-issued</span> : null}
                                {refused ? <div className="text-[10px] text-red-700">{refused}</div> : null}
                              </td>
                              <td className="py-0.5 px-2 text-right font-mono">
                                {fmtNum(r3(l.owed_purchase))} <span className="text-[9px] text-[#8B7355]">{pu}</span>
                                {pf > 1 && !lineIsPU && l.owed_line > 0 && (
                                  <span className="text-[9px] text-[#B8A590] ml-1">= {fmtNum(l.owed_line)} {ru}</span>
                                )}
                              </td>
                              <td colSpan={5}></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    );
                  })}
                </table>
              )}

              {/* OWED BUT NOT ORDERABLE — the server's own reason per line, so
                  no owed line silently vanishes from the storekeeper's view. */}
              {feed && shownBlocked.length > 0 && (
                <div className="mt-3 border border-[#E8D5C4] rounded-lg">
                  <button onClick={() => setShowBlocked(s => !s)}
                          className="w-full px-3 py-1.5 text-left text-[11px] text-[#6B5744] flex items-center gap-1 hover:bg-[#FFF8F0]">
                    {showBlocked ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    {shownBlocked.length} owed line{shownBlocked.length === 1 ? '' : 's'} cannot go on this PO
                    <span className="text-[#8B7355]">— already on a PO, bought on a store&apos;s own ledger, or similar</span>
                  </button>
                  {showBlocked && (
                    <ul className="px-3 pb-2 space-y-0.5">
                      {shownBlocked.map(n => (
                        <li key={n.req_item_id} className="text-[10px] text-[#6B5744]">
                          <b className="text-[#2D1B0E]">{n.material_name}</b> · <span className="font-mono">{n.req_number}</span> · {n.department_name}
                          {n.purpose === 'party' ? ' · party' : ''} · owed {fmtNum(n.owed_purchase)} {n.purchase_unit}
                          <span className="text-[#8B7355]"> — {n.reason}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {/* ── totals + save ── */}
            <div className="border-t border-[#E8D5C4] px-5 py-3 space-y-2 bg-white rounded-b-xl">
              {included.length > 0 && (
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {totals.vendors.map(v => (
                    <span key={v.id} className="px-2 py-0.5 rounded border border-[#E8D5C4] bg-[#FFF8F0] text-[#6B5744]">
                      <b className="text-[#2D1B0E]">{v.name}</b> · {v.items} item{v.items === 1 ? '' : 's'} · {fmtRs(v.amount)}
                    </span>
                  ))}
                  {totals.unassigned > 0 && (
                    <span className="px-2 py-0.5 rounded border border-red-200 bg-red-50 text-red-700">
                      No vendor yet · {totals.unassigned} item{totals.unassigned === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="text-[11px] text-[#6B5744]">
                  {included.length === 0 ? (
                    <>Nothing ticked yet.</>
                  ) : (
                    <>
                      <b>{tickedLines.length}</b> requisition line{tickedLines.length === 1 ? '' : 's'} from{' '}
                      <b>{tickedDepts.size}</b> department{tickedDepts.size === 1 ? '' : 's'}
                      {tickedParty > 0 ? <> ({tickedParty} party)</> : null}
                      {' '}→ <b>{included.length}</b> item{included.length === 1 ? '' : 's'},{' '}
                      <b>{totals.vendors.length}</b> vendor{totals.vendors.length === 1 ? '' : 's'} ·{' '}
                      <b className="text-[#2D1B0E]">{fmtRs(totals.total)}</b>
                      {hiddenTicked > 0 && <span className="text-amber-800"> · {hiddenTicked} ticked line{hiddenTicked === 1 ? ' is' : 's are'} hidden by the filter and still included</span>}
                    </>
                  )}
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-[10px] text-[#8B7355]">
                    Expected delivery
                    <input type="date" value={expected} min={todayIso()}
                           onChange={e => { setExpected(e.target.value); touch(); }}
                           className="block px-1.5 py-1 border border-[#E8D5C4] rounded text-xs bg-white" />
                  </label>
                  <label className="text-[10px] text-[#8B7355]">
                    Notes
                    <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
                           placeholder="optional"
                           className="block w-48 px-1.5 py-1 border border-[#E8D5C4] rounded text-xs bg-white" />
                  </label>
                  <button onClick={close} disabled={saving}
                          className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">
                    Cancel
                  </button>
                  <button onClick={save} disabled={saving || included.length === 0 || feed == null}
                          className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8f3706] text-white rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-50">
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Merge className="w-4 h-4" />}
                    Create draft PO
                  </button>
                </div>
              </div>
              {saveError && (
                <div className="text-[11px] rounded border border-red-200 bg-red-50 text-red-700 px-2 py-1 flex items-start gap-1">
                  <AlertCircle className="w-3.5 h-3.5 mt-[1px] shrink-0" />
                  <span className="flex-1">{saveError}</span>
                  {Object.keys(refusedLines).length > 0 && (
                    <button onClick={() => setLoadKey(k => k + 1)}
                            className="shrink-0 underline font-medium">Reload the list</button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
  return createPortal(view, document.body);
}
