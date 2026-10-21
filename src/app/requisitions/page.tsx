'use client';

/**
 * Requisitions — internal department workflow.
 *
 *   draft → submitted → chef_approved → store_processed → fulfilled
 *                    ↘  chef_rejected
 *
 * The page renders a single list with status filters and inline expansion.
 * Action buttons appear contextually based on (status, viewer permissions).
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ClipboardList, Plus, Trash2, Send, CheckCircle2, XCircle, Package,
  AlertTriangle, AlertCircle, ChevronDown, ChevronRight, Loader2, Upload, Search, X, Eye, Pencil,
} from 'lucide-react';
import { api } from '@/lib/api';
import { packFactor, toPurchaseQty, shownPurchaseQty } from '@/lib/pack-units';
// THE RULE and the shelf take, as both desks run them — ONE transcription of the
// server's (central-debit-clamp.ts / issue-stock.ts), proved against it by
// scripts/desk-rule-tests.ts. Never re-type any of it on this page.
import { deskLineComplete, planDeskDebit, forecastDeskTake, type DeskTakeForecast } from '@/lib/desk-rule';
import { fmtIST } from '@/lib/format-date';
import MaterialTypeahead from '@/components/MaterialTypeahead';
import TabScroller from '@/components/TabScroller';
import StaffCatalogPicker, { type DeptStockLite, type DeptStockProp } from './StaffCatalogPicker';

const fmt = (v: number) => '₹' + (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
/** Quantity formatter — 3 dp, trailing zeros trimmed. Same as the sibling
 *  requisition screens, so a converted figure prints identically on all four. */
const fmtNum = (v: number) => (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
/**
 * A central-store CAP in the purchase unit — fmtNum, except for the one figure
 * fmtNum cannot carry: a balance the "In Stock" column shows as 0 that the store
 * still holds (a sub-display crumb, under half a 0.001 step — 0.4 g on a
 * 1000-pack). The server names that cap at the precision that takes it when
 * typed back (issue-stock.ts puFine: 6 dp of the recipe unit, carried through
 * the pack), and fmtNum would print it as "0" or "0.001" — "holds 0 kg" over a
 * real 0.4 g, or a figure that is refused when typed. Every figure of 0.001 or
 * more is a shown figure already, so it prints exactly as fmtNum prints it.
 */
const fmtCapPU = (v: number, pf = 1) => {
  const n = Number(v) || 0;
  if (!(n > 0 && n < 0.001)) return fmtNum(n);
  const dp = Math.min(20, 6 + Math.max(0, Math.ceil(Math.log10(pf > 1 ? pf : 1))));
  return n.toLocaleString('en-IN', { maximumFractionDigits: dp });
};
/** Who a held row's balance goes to when the server gave it to sibling rows of
 *  the same item first — the store desk's CentralHoldBanner words. */
const sharedTarget = (n: number) => (n === 1 ? 'the other line' : `the ${n} other lines`);
/**
 * The sentence for lines a gesture leaves at 0 while another line is held —
 * "SALT is entered as 0, so it is not issued either." Said before "every other
 * line is issued" so that sentence never counts a line nothing goes out on.
 * The store desk's ⛔ banner uses the same words (store-requisitions/page.tsx
 * zeroEntrySentence); `past` is the result panel's tense, the words of the
 * server's stock_held_note (issue-stock.ts zeroEntriesSentence).
 */
function zeroEntrySentence(names: string[], past = false): string {
  const list = names.length <= 1 ? (names[0] || '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const one = names.length <= 1;
  return past
    ? `${list} ${one ? 'was' : 'were'} entered as 0, so ${one ? 'it was' : 'they were'} not issued either.`
    : `${list} ${one ? 'is' : 'are'} entered as 0, so ${one ? 'it is' : 'they are'} not issued either.`;
}

interface Material {
  id: string; name: string; sku?: string; unit: string;
  current_stock: number; average_price: number;
  last_purchase_price?: number; last_purchase_date?: string;
  reorder_level?: number;        // a.k.a. buffer stock per Phase 1 §2
  purchase_unit?: string; pack_size?: number;
  category?: string;
}
interface Department { id: string; name: string; code?: string; }
/**
 * One row of a refusal's `blocked[]` array — the envelope both issue routes use
 * (the same one the department-reversal block already used, which is why the
 * existing `code` / `blocked` handling applies unchanged).
 *
 * ⚠ TWO BASES ON ONE OBJECT, and they must never be swapped:
 *   · `requested` / `available` are in the PURCHASE unit (`purchase_unit`) —
 *     what the message prints and what any banner must show (owner rule: store
 *     surfaces lead with the purchase unit).
 *   · `max_issue_qty` is in the LINE's own unit (`line_unit`), because it is
 *     the value the ISSUE BOX takes.
 * They coincide on every live pack line; that is luck, not a licence.
 *
 * `message` is a finished sentence written for a storekeeper — print it
 * verbatim, do not re-word it, and do not rebuild it from the numbers.
 *
 * THE SAME ROW SHAPE ARRIVES ON A 200 as `held_lines[]` (store-process/route.ts,
 * "WHAT THE CENTRAL FLOOR HELD BACK"): a line the central store could not cover,
 * left at the quantity_issued it had while every other line of the gesture went
 * out. Its figures are scored AFTER the gesture ran (rescoreHeldIssue), so they
 * are what the next issue of that line will meet.
 */
interface ServerBlock {
  code?: string;
  material?: string;
  material_id?: string;
  req_item_id?: string;
  /** PURCHASE unit. */
  requested?: number;
  /** PURCHASE unit. 0 on 508 of the 564 refusable live lines — a reader must
   *  make sense at zero and never print "issue up to 0".
   *  Since round 6 it is the balance's SHOWN figure (round 8: shownPurchaseQty
   *  — the 6-dp grid point, then 3 dp half-up — the "In Stock" column's own number), which the server accepts
   *  when typed back and debits as the whole balance; below 0.001 it is a
   *  sub-display crumb carried at the precision that takes it (print it with
   *  fmtCapPU, never fmtNum). 0 when the store holds none of it — OR (round 7)
   *  when another held row of the same item was given the whole pool first
   *  (scoreHeldAtTurn); centralCapOf's `sharedWith` tells the two apart. */
  available?: number;
  purchase_unit?: string;
  /** LINE unit — the Issue box's own basis. */
  max_issue_qty?: number;
  line_unit?: string;
  message?: string;
}
interface ReqItem {
  id: string; req_id: string; material_id: string;
  material_name: string; material_sku?: string; material_unit: string;
  /** raw_materials.category, shipped by the ?id= detail SELECT
   *  (api/requisitions/route.ts:88) and used to group the store's line table by
   *  shelf. The column is `TEXT NOT NULL DEFAULT 'other'`, so on live data it is
   *  never NULL and never blank — 'other' is a REAL shelf with 141 materials on
   *  it, not a stand-in for "unset". Optional here only because an older payload
   *  (or a caller that hand-builds a ReqItem) may omit it. */
  material_category?: string;
  /** Unit the department REQUESTED in (recipe unit or purchase unit, e.g. 'BTL').
   *  quantity_requested / chef_approved_qty / quantity_issued are all in THIS unit. */
  unit?: string;
  material_purchase_unit?: string; material_pack_size?: number;
  quantity_requested: number; quantity_issued: number; quantity_to_purchase: number;
  current_stock: number; average_price: number; last_purchase_price?: number; notes: string;
  /** Chef-edited approval qty (overrides quantity_requested if set). NULL = no edit. */
  chef_approved_qty?: number | null;
  /** Chef explicitly rejected this line — store will skip it during issue. */
  is_rejected?: number | boolean;
  /** Chef's per-line note ("over budget", "out of season", etc.). */
  chef_note?: string;
  /** requisition_items.shelf_emptied_qty — THE RULE's memory (round 8): the
   *  quantity_issued a take that EMPTIED the central shelf closed this line at.
   *  Written by the server at the take, never inferred here (desk-rule.ts
   *  deskShelfMarkHolds). Arrives with ri.* on the ?id= detail payload. */
  shelf_emptied_qty?: number | null;
}
interface Requisition {
  id: string; req_number: string;
  department_id: string; department_name: string; department_code?: string;
  date: string; status: string; notes: string;
  /** 'internal' (kitchen restock) or 'party' (for a specific event). Drives whether
   *  the "For Party" column shows host + company + event date or just a dash. */
  purpose?: 'internal' | 'party' | string;
  /** Host name (guest_name on the FP), populated only for party reqs. */
  event_name?: string;
  /** Company name (guest_company on the FP), populated only for party reqs. */
  customer?: string;
  /** Event date (ISO) — when the party is happening. Useful to spot last-minute reqs. */
  event_date?: string;
  /** Headcount the party is being cooked for. */
  guest_count?: number;
  drafted_by: string; submitted_at?: string; submitted_by?: string;
  chef_approved_at?: string; chef_approved_by?: string; chef_note?: string;
  mgmt_approved_at?: string; mgmt_approved_by?: string; mgmt_note?: string;
  dept_acknowledged_at?: string; dept_acknowledged_by?: string; dept_ack_note?: string;
  rejected_at?: string; rejected_by?: string; rejected_reason?: string;
  store_processed_at?: string; store_processed_by?: string; store_note?: string;
  linked_po_id?: string | null; linked_po_number?: string | null; linked_po_status?: string | null;
  fulfilled_at?: string;
  item_count?: number; estimated_value?: number;
  /* ── Half-transfer roll-ups (additive columns on /api/requisitions) ────────
   * `status` is ONE scalar and cannot say "handed two lines over, still owes
   * two more", which is why 'fulfilled' and 'partially-issued' used to be
   * mutually exclusive here. These are LINE counts, so a requisition may
   * legitimately answer yes to several of them at once.
   *
   *   lines_issued_any — lines where quantity_issued > 0 (goods actually went out)
   *   lines_deferred   — lines a human promised a later time on (deferred_until)
   *   lines_owing      — lines still short of their effective qty
   *
   * OPTIONAL on purpose: an older payload (or the API deployed a beat behind
   * this page) omits them, every reader below coerces the absent value to 0,
   * and each new predicate collapses back to exactly today's status-only
   * behaviour. Never read these directly — go through the predicates. */
  lines_issued_any?: number;
  lines_deferred?: number;
  lines_owing?: number;
  items?: ReqItem[];
}

/** Unit a line was REQUESTED in (legacy rows without ri.unit fall back to the
 *  material's recipe unit — identical behaviour to before the UOM selector). */
function reqUnit(it: ReqItem): string {
  return it.unit || it.material_unit;
}
/** Recipe-units per 1 requested-unit: pack_size when the request was made in the
 *  material's PURCHASE unit (e.g. 1 BTL = 750 ml), else 1. Multiply a requested
 *  qty by this to compare it against current_stock (always in recipe units). */
function reqPackFactor(it: ReqItem): number {
  const pack = Number(it.material_pack_size) || 1;
  // Normalised compare: purchase_unit tokens are stored in mixed case (BTL, kg,
  // Kg) and an exact === silently returned 1 for a case-only mismatch, flipping
  // the whole line's basis. Same lowercase+trim rule as pack-units' packFactor.
  const lu = String(it.unit || '').toLowerCase().trim();
  const pu = String(it.material_purchase_unit || '').toLowerCase().trim();
  const ru = String(it.material_unit || '').toLowerCase().trim();
  return (lu && pu && lu === pu && lu !== ru && pack > 1) ? pack : 1;
}

/**
 * Is the central book balance actually ON this payload?
 *
 * THE DIFFERENCE BETWEEN "ZERO" AND "NOT TOLD" IS THE WHOLE POINT. The store
 * grid caps the Issue box against current_stock now, because the server refuses
 * a debit that would take it below zero. `Number(undefined) || 0` is 0, so a
 * payload that simply does not carry the field would cap every line on the
 * sheet to nothing and announce that the store holds none of anything.
 *
 * The detail SELECT does project it bare (`rm.current_stock`, no COALESCE —
 * api/requisitions/route.ts) and the column holds 0 NULLs across all 952 live
 * materials, so on today's data this returns true for every line. It is the
 * compatibility floor for an older/partial payload, and the one thing that can
 * leave the client-side cap UNARMED — which the modal then says in an amber
 * panel rather than pretending the grid is capped.
 */
function stockIsKnown(it: { current_stock?: number | null }): boolean {
  return it.current_stock != null && Number.isFinite(Number(it.current_stock));
}

/**
 * Resolve one line's UNIT BASIS and expose the purchase-unit view — mirrors
 * lineUnits() on /store-requisitions and /party-approvals VERBATIM, so the four
 * requisition screens can never disagree about what "3 kg" means. (Before this,
 * this page alone labelled every qty with the line's STORED unit, so a legacy
 * blank-unit line read "4,500 ml" here and "6 BTL" everywhere else.)
 *
 * Quantities are stored in the LINE's own `unit` (option B) and the composers
 * disagree: the internal picker stamps the PURCHASE unit, older/imported rows
 * are blank. Blank/legacy reads as RECIPE, which is what it has always meant.
 *
 * Identity that keeps money safe: toRecipe(q) === q × reqPackFactor(it) — isPU
 * is true on exactly the lines reqPackFactor returns pack for. So every ₹ figure
 * (qty × reqPackFactor × ₹/recipe-unit) is untouched by this display layer.
 */
type Q = number | null | undefined;
function lineUnits(it: ReqItem) {
  const recipeUnit = it.material_unit || it.unit || '';
  const pf = packFactor({
    unit: recipeUnit,
    purchase_unit: it.material_purchase_unit,
    pack_size: it.material_pack_size,
  });
  const pu = it.material_purchase_unit || recipeUnit;
  const lu = String(it.unit || '').toLowerCase().trim();
  // Already stored in the purchase unit → no conversion in either direction.
  const isPU = pf > 1 && lu !== '' && lu === String(pu).toLowerCase().trim();
  const meta = { unit: recipeUnit, purchase_unit: it.material_purchase_unit, pack_size: it.material_pack_size };
  return {
    pf, pu, recipeUnit, isPU,
    /* Qty params are `number | null | undefined` rather than the siblings' `any`
       — same tolerance (Number(null) || 0 === 0), without a fresh lint error. */
    /** stored line qty → purchase-unit display figure (3 dp, display only) */
    toPU: (q: Q) => isPU ? (Number(q) || 0) : Math.round(((Number(q) || 0) / pf) * 1000) / 1000,
    /** purchase-unit entry → the line's stored unit (what the API writes verbatim) */
    fromPU: (q: Q) => isPU ? (Number(q) || 0) : Math.round((Number(q) || 0) * pf * 1e6) / 1e6,
    /** stored line qty → recipe units (the small "= N g" hint) */
    toRecipe: (q: Q) => isPU ? (Number(q) || 0) * pf : (Number(q) || 0),
    /** material-level recipe figure (current_stock) → purchase units. Stock is
     *  ALWAYS recipe units — never route it through toPU, which reads the line.
     *  SNAPPED TO THE 6-dp GRID BEFORE THE 3-dp ROUNDING (round 8):
     *  pack-units.ts shownPurchaseQty, the function the server's shown-figure
     *  rule prints and matches against — the store desk's U.stockPU is the same
     *  call. Rounded raw, float dust moved a printed balance a whole step
     *  (WHITE DAL 3.1504999999999996 kg printed 3.15 for a 3.1505 kg shelf;
     *  FRESH CREAM 130,125.5 ml printed 130.125 BTL through the division). On
     *  every live balance today the figure is the one this column always
     *  printed. */
    stockPU: (q: Q) => shownPurchaseQty(Number(q) || 0, meta),
  };
}

/**
 * HOD-effective demand for a line, in the line's STORED unit.
 *
 * `!= null` is the rule, NOT `> 0`: it is what the server uses to decide whether
 * a requisition is fully issued (store-issue/route.ts `allDone`) and what the
 * full item table prints under "HOD OK". The store-issue MODAL further insists
 * on `> 0`, which is a different question (what to pre-fill an editable box
 * with) — copying that variant here would make a line the HOD deliberately cut
 * to 0 silently re-inflate to the department's original ask.
 */
function effectiveQty(it: ReqItem): number {
  return (it.chef_approved_qty != null
    ? Number(it.chef_approved_qty)
    : Number(it.quantity_requested)) || 0;
}

/**
 * IS THIS LINE COMPLETE? — THE RULE (round 8), the server's own predicate, so
 * this desk, the store desk and the routes can never disagree about which lines
 * are done. issue-stock.ts lineIssueComplete → central-debit-clamp.ts
 * issuedCoversAsk, through the desks' ONE transcription of it
 * (src/lib/desk-rule.ts deskLineComplete, proved against the server by
 * scripts/desk-rule-tests.ts — store-requisitions/page.tsx calls the same):
 *
 *     complete ⇔ issued + 1e-9 ≥ approved
 *              ∨ ( the line's shelf mark speaks for its quantity_issued
 *                  ∧ step > 0 ∧ grid(issued) > 0
 *                  ∧ grid(approved − issued) < grid(step) )
 *
 * The shelf mark (shelf_emptied_qty) is the server's record that a take
 * EMPTIED the central shelf and closed the line there — THREE MANGO approved
 * 14.843 kg, the take emptied a 14,842.5 g shelf and recorded 14.8425: complete,
 * so this desk prints no "0.001 still to come" on a line nobody can issue.
 * Round 7's arms that closed a line on the figures alone (the two SHOW as one
 * number; anything below one printed step owed) are gone: MALA MANGO CRUSH 5
 * LTR, 1,000 of 1,004 ml issued with 49 L on the shelf, printed Fulfilled here
 * and dropped "· 0.001 still to come" while the store could serve the 4 ml. A
 * remainder below a step over a stocked shelf is an ordinary partial.
 */
function lineIssueComplete(it: ReqItem): boolean {
  return deskLineComplete(Number(it.quantity_issued) || 0, effectiveQty(it), {
    unit: it.unit, material_unit: it.material_unit,
    material_purchase_unit: it.material_purchase_unit, material_pack_size: it.material_pack_size,
    shelf_emptied_qty: it.shelf_emptied_qty,
  });
}

/**
 * The ONE quantity a department should be shown for a line — in the line's
 * stored unit, so it still needs lineUnits().toPU() to be printed.
 *
 * Once the store has processed the requisition, the only figure that means
 * anything to a kitchen is what physically arrived. Before that there is
 * nothing issued yet, so the effective demand is the honest answer.
 *
 * The owner's report: "requested 7 kg of Curd 1, store issued 5, the screen
 * still says 7." A kitchen reads the headline number and plans around it, so
 * the headline has to be the truth about goods, not the truth about paperwork.
 *
 * Rejected lines return 0 — they are excluded from the requisition's value and
 * render as an em-dash, matching the full table.
 */
function deptLeadQty(it: ReqItem, storeHasIssued: boolean): number {
  if (it.is_rejected) return 0;
  return storeHasIssued ? (Number(it.quantity_issued) || 0) : effectiveQty(it);
}

/**
 * Group a requisition's lines BY SHELF so a store person walks one aisle at a
 * time instead of criss-crossing the room down a flat, name-ordered list.
 *
 * This is the SAME RULE as /store-requisitions (page.tsx:1508-1532), copied
 * deliberately rather than approximated: the two screens render the same
 * requisition to the same picker, and a hand-over sheet that reads one way here
 * and another way there is worse than no grouping at all.
 *   · categories A-Z, case-insensitive
 *   · 'Uncategorised' pinned LAST, so a blank never sorts above a real shelf
 *   · items A-Z by name INSIDE each group
 *
 * WHAT COUNTS AS BLANK. Only a genuinely empty/whitespace value collapses into
 * the no-category bucket. The literal 'other' is left alone as its own group
 * because on this database it is a REAL category carrying 141 materials / 3,222
 * requisition lines — folding it into "no category" would tell the picker that a
 * fifth of the sheet is unfiled when it is not. raw_materials.category is
 * `TEXT NOT NULL DEFAULT 'other'` and today holds 0 NULLs and 0 empty strings,
 * so that bucket is the compatibility floor, not a live case.
 *
 * TWO SHELVES MUST NEVER PRINT THE SAME NAME. Both of these are latent today
 * (checked on a copy of the live db: 0 case-variant categories, 0 blank, 0 rows
 * literally named 'Uncategorised') and both mislead the one person this grouping
 * exists for — a picker counting items off a shelf:
 *   · The bucket key is CASE-FOLDED. Keying on the raw string while sorting
 *     case-INSENSITIVELY put 'Veg' and 'veg' in two buckets that then rendered
 *     as two adjacent header rows both reading VEG (the header is
 *     CSS-uppercased), e.g. 'VEG (117 items)' followed by 'VEG (1 item)'. The
 *     first spelling seen is kept for display, so nothing renders differently on
 *     data that has no variants.
 *   · The no-category bucket is keyed on a SENTINEL that no category string can
 *     equal, and prints 'No category' rather than 'Uncategorised' — a material
 *     genuinely filed under "Uncategorised" is a real shelf and now keeps its own
 *     group instead of being merged into the unfiled pile and sorted below every
 *     real shelf. This is the one deliberate divergence from
 *     /store-requisitions' wording; it applies only to a bucket that is empty on
 *     this database, and the alternative is two shelves sharing a label.
 *
 * PRESENTATION ONLY. Callers keep reading `detail.items` for totals, costing and
 * every action — this returns the same rows in a different order and nothing
 * else. The server still sends them ORDER BY department, material
 * (api/requisitions/route.ts:130); re-ordering here is a display decision on
 * this screen and does not touch that query (which /store-requisitions shares).
 */
/** Key for the "this material has no category" bucket. The LEADING SPACE is what
 *  makes it safe: a real key is `category.trim().toLowerCase()` and non-empty, so
 *  no real category can ever produce a key that starts with a space. */
const NO_CATEGORY_KEY = ' no-category';
const NO_CATEGORY_LABEL = 'No category';

function groupLinesByCategory<T extends { material_category?: string; material_name?: string }>(
  items: readonly T[],
): Array<{ name: string; lines: T[] }> {
  // key (case-folded, or the sentinel) → the spelling to print + its rows.
  const groups = new Map<string, { name: string; lines: T[] }>();
  for (const line of items) {
    const raw = String(line.material_category || '').trim();
    const key = raw ? raw.toLowerCase() : NO_CATEGORY_KEY;
    const bucket = groups.get(key);
    if (bucket) bucket.lines.push(line);
    else groups.set(key, { name: raw || NO_CATEGORY_LABEL, lines: [line] });
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === NO_CATEGORY_KEY) return 1;
      if (b === NO_CATEGORY_KEY) return -1;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    })
    .map(([, g]) => ({
      name: g.name,
      lines: g.lines.slice().sort((x, y) =>
        String(x.material_name || '').localeCompare(String(y.material_name || ''), undefined, { sensitivity: 'base' })),
    }));
}

/**
 * Purchase units that are a MEASURE rather than a countable pack.
 *
 * Rounding a shortfall UP to a whole purchase unit is right for a bottle, a
 * packet or a case — no vendor sells 0.4 of a bottle. It is wrong for a unit
 * that is itself a measurement: a 0.01 kg shortfall of KAFFIRLIME LEAF became a
 * pre-priced 1 kg order, +9,900%, and 100 g of BASIL / LEMON GRASS / ROSEMERRY
 * each became 1 kg, +900%. Measured on a copy of the live db: with Issue Now
 * cleared across every requisition, 281 auto-filled Buy quantities order more
 * than the line is short, and EVERY ONE of them is on a `kg` purchase unit.
 *
 * The six purchase units with a real pack conversion on this database are
 * btl (2,536 requisition lines), kg (4,000), pkt (350), l (338), can (20) and
 * case (4) — so only kg and l need the relaxation, and the set is deliberately
 * a MEASURE list rather than a count list: anything unrecognised keeps today's
 * ceil, which is the safe direction for a unit nobody has seen yet.
 */
const MEASURE_PURCHASE_UNITS = new Set(['g', 'gm', 'gms', 'gram', 'grams', 'kg', 'kgs', 'kilogram',
                                        'ml', 'l', 'ltr', 'ltrs', 'lt', 'litre', 'liter', 'litres', 'liters']);
const isMeasurePurchaseUnit = (u?: string) => MEASURE_PURCHASE_UNITS.has(String(u || '').toLowerCase().trim());

const STATUS_BADGE: Record<string, string> = {
  draft:           'bg-[#E8D5C4] text-[#6B5744]',
  submitted:       'bg-amber-100 text-amber-800',
  chef_approved:   'bg-blue-100 text-blue-800',
  mgmt_approved:   'bg-indigo-100 text-indigo-800',
  chef_rejected:   'bg-red-100 text-red-700',
  store_processed: 'bg-purple-100 text-purple-800',
  fulfilled:       'bg-emerald-100 text-emerald-700',
  cancelled:       'bg-[#E8D5C4] text-[#6B5744]',
};
const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', submitted: 'With HOD',
  chef_approved: 'With Mgmt', mgmt_approved: 'With Store',
  chef_rejected: 'Rejected', store_processed: 'Issued (partial)', fulfilled: 'Fulfilled', cancelled: 'Cancelled',
};

/* ============================================================================
 * HALF-TRANSFER PREDICATES — the single definition of each roll-up tab.
 *
 * Every one of these is called by BOTH statusFiltered() (which rows the table
 * renders) and tally() (the number printed on the tab). That is the whole
 * reason they are functions and not two copies of an expression: the previous
 * pair of hand-copied predicates is how a badge starts promising four rows and
 * the list hands you three.
 *
 * They read the LINE roll-ups, not `status`, so they overlap by design — a
 * requisition with two lines handed over and two still owing is genuinely
 * BOTH fulfilled (for the part that arrived) and partially issued (for the
 * part that has not). That overlap is the owner's ask, not a bug.
 *
 * num() is the compatibility floor: a missing column reads 0, so on a payload
 * without these fields matchesFulfilled() degenerates to `status ===
 * 'fulfilled'` and the other two match nothing — i.e. today's behaviour.
 * ========================================================================== */
const num = (v: number | undefined | null) => Number(v) || 0;

/** Did goods physically leave the store on at least one line? */
function hasIssuedAnyLine(r: Requisition): boolean { return num(r.lines_issued_any) > 0; }

/**
 * Statuses a requisition holds BEFORE the store can hand anything over. Goods
 * cannot legitimately have left the store in any of them, so a stray
 * quantity_issued on such a row is bad data, not a half-transfer.
 */
const PRE_STORE_STATUSES = ['draft', 'submitted', 'cancelled', 'chef_rejected'];

/**
 * The 'fulfilled' tab. A SUPERSET of the old `status === 'fulfilled'` test —
 * it can only ever add rows, never drop one a staff member sees there today.
 * The extra rows are the half-transfers: the part that WAS handed over is
 * fulfilled, whatever the requisition-level status still says.
 *
 * The pre-store exclusion keeps that honest. REQ-TEST-PACKFIX is `submitted`
 * with all three lines carrying a full quantity_issued — seeded harness data
 * that never passed the store. Without the guard it renders under Fulfilled
 * wearing a "With HOD" chip, which reads as a bug to anyone looking at it.
 * One live row today, but the shape recurs with every import and fixture.
 */
function matchesFulfilled(r: Requisition): boolean {
  return r.status === 'fulfilled'
    || (hasIssuedAnyLine(r) && !PRE_STORE_STATUSES.includes(r.status));
}

/** The 'deferred' tab — strictly "a human promised a time on this line". */
function matchesDeferred(r: Requisition): boolean { return num(r.lines_deferred) > 0; }

/**
 * Part-issued: goods went out, more is still owed, and the requisition is still
 * LIVE. Drives the "Part" chip, so a requisition now appearing under both
 * Fulfilled and Partially Issued reads as one half-transfer, not a duplicate.
 *
 * The terminal exclusion is not cosmetic tidying — it is what keeps the chip
 * true. On this database 737 of the 1,620 `fulfilled` requisitions (45%) still
 * have a short line: REQ-IMP-5380 was closed having issued 0 of 2 BTL FRESH
 * CREAM 1 LTR, and 736 more like it. Those were closed SHORT months ago;
 * nothing is owed on them any more, so a chip reading "the rest is still owed"
 * would be false on 737 rows and would rose-wash half the Fulfilled tab.
 * Short-closed history is a real thing to look at, but it is a report, not a
 * per-row alarm on a closed requisition. Same terminal vocabulary as canCancel.
 */
const TERMINAL_STATUSES = ['fulfilled', 'cancelled', 'chef_rejected'];
function isPartIssued(r: Requisition): boolean {
  return !TERMINAL_STATUSES.includes(r.status)
    && hasIssuedAnyLine(r) && num(r.lines_owing) > 0;
}

/**
 * Render children at the end of document.body via a React portal.
 *
 * The Mgmt/Chef/Store modals on this page live inside an expanded requisition
 * row (`<tr><td colSpan>...</td></tr>`). Putting a `position: fixed` overlay
 * inside a `<td>` triggers HTML-parser fix-ups and layout thrash in some
 * browsers — the modal would flicker open/close as the table re-laid out.
 * Portaling to body lifts the modal out of the table context entirely, so
 * `position: fixed` resolves against the viewport as intended.
 */
function ModalPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted || typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}

export default function RequisitionsPage() {
  const [reqs, setReqs] = useState<Requisition[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  // Draft being edited — when set, the create modal opens in edit mode (PUT).
  const [editDraft, setEditDraft] = useState<Requisition | null>(null);
  // Full user record — viewer (from list endpoint) only carries permission
  // flags; we need department_id + is_head_chef + is_store_manager to decide
  // whether the dept selector in the create modal should be locked.
  const [me, setMe] = useState<{
    role?: string; email?: string; department_id?: string | null;
    is_head_chef?: boolean; is_store_manager?: boolean;
    visible_department_ids?: string | null;
  } | null>(null);
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null)).catch(() => {});
  }, []);
  // Department-stock map for the requisition's department — the picker shows
  // "With dept: N / PU" (the dept's own computed balance) instead of the
  // central-store stock. Fetched alongside the /api/inventory load for the
  // dept a new/edited requisition resolves to: the draft's department, else
  // the viewer's own (same resolution as StaffCatalogPicker's deptId init).
  const [deptStock, setDeptStock] = useState<DeptStockProp>({ deptId: '', byId: new Map() });
  useEffect(() => {
    const deptId = editDraft?.department_id || me?.department_id || '';
    if (!deptId) return;
    if (deptStock.deptId === deptId) return;
    let live = true;
    fetch(`/api/department-stock?department_id=${encodeURIComponent(deptId)}`)
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!live || !j) return;
        const byId = new Map<string, DeptStockLite>(
          (j.rows || []).map((r: any) => [r.material_id, { on_hand_est: r.on_hand_est, never_counted: !!r.never_counted }]));
        setDeptStock({ deptId, byId });
      })
      .catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.department_id, editDraft?.department_id]);
  // Mgmt-approval setting — when OFF, the Mgmt inbox banner and tab on this
  // page should disappear entirely (chef approval is the only gate). When ON,
  // legacy Chef → Mgmt → Store flow applies and the indigo banner reappears.
  const [requireMgmt, setRequireMgmt] = useState(false);
  useEffect(() => {
    fetch('/api/admin/party-rules').then(r => r.json()).then(d => {
      setRequireMgmt(d?.require_mgmt_approval === true);
    }).catch(() => {});
  }, []);
  const [importing, setImporting] = useState(false);
  const [viewer, setViewer] = useState<{ email: string; role: string; can_chef: boolean; can_mgmt: boolean; can_store: boolean; can_issue: boolean }>({
    email: '', role: '', can_chef: false, can_mgmt: false, can_store: false, can_issue: false,
  });

  const reload = async () => {
    setLoading(true);
    const [r, d, m] = await Promise.all([
      fetch('/api/requisitions').then(r => r.json()),
      fetch('/api/departments').then(r => r.json()),
      fetch('/api/inventory').then(r => r.json()).catch(() => ({ materials: [] })),
    ]);
    setReqs(r.requisitions || []);
    setDepartments((d.departments || []).filter((x: any) => x.is_active));
    setMaterials(m.materials || []);
    setViewer({
      email: r.viewer_email || '', role: r.viewer_role || '',
      can_chef: !!r.viewer_can_approve_chef, can_mgmt: !!r.viewer_can_approve_mgmt, can_store: !!r.viewer_can_process_store,
      can_issue: !!r.viewer_can_issue_store,
    });
    setLoading(false);
  };
  useEffect(() => { reload(); }, []);

  // Free-text search over every column printed on the row — req #, department
  // (name + code), the party host/company, the linked PO number and who drafted
  // it — plus the status BOTH as displayed ("With HOD") and as the raw code
  // ("submitted"), so typing what you can see on the badge works. `notes` is
  // also searched even though it only shows in the expanded detail, not the row.
  const searchMatch = (r: Requisition, q: string) => {
    if (!q) return true;
    const hay = [r.req_number, r.department_name, r.department_code, r.notes,
                 r.event_name, r.customer, r.status, STATUS_LABEL[r.status],
                 r.linked_po_number, r.drafted_by]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  };

  // The search narrows the WHOLE list first; the status tab then slices it
  // (both are plain filters, so the order doesn't change the result). The tab
  // badges below are counted off this same searched set, so a badge can never
  // promise more rows than the table will actually render for that tab.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? reqs.filter(r => searchMatch(r, q)) : reqs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqs, search]);

  const filtered = useMemo(() => statusFiltered(searched, statusFilter), [searched, statusFilter]);

  function statusFiltered(reqs: Requisition[], statusFilter: string) {
    if (statusFilter === 'all') return reqs;
    // "Open" = awaiting an approval / decision. store_processed (partially
    // issued) is NOT open — the store has already acted on it; it's mid-flight.
    // It has its own dedicated tab below ("Partially Issued").
    if (statusFilter === 'open') return reqs.filter(r => !['fulfilled', 'cancelled', 'chef_rejected', 'store_processed'].includes(r.status));
    if (statusFilter === 'inbox-chef')  return reqs.filter(r => r.status === 'submitted');
    if (statusFilter === 'inbox-mgmt')  return reqs.filter(r => r.status === 'chef_approved');
    // Store inbox includes partially-issued so the store can find a req they
    // started but didn't finish — otherwise it would vanish after first issue.
    if (statusFilter === 'inbox-store') return reqs.filter(r => ['mgmt_approved', 'chef_approved', 'store_processed'].includes(r.status));
    if (statusFilter === 'partially-issued') return reqs.filter(r => r.status === 'store_processed');
    // ── Half-transfer tabs. Both sit BEFORE the status fallthrough because
    // they are line roll-ups, not statuses. 'fulfilled' would otherwise mean
    // `status === 'fulfilled'` and a half-transferred requisition could only
    // ever appear in ONE of Fulfilled / Partially Issued; now the part that
    // was handed over counts as fulfilled while the rest stays owing.
    // 'deferred' is not a status at all — the fallthrough matched nothing.
    if (statusFilter === 'fulfilled') return reqs.filter(matchesFulfilled);
    if (statusFilter === 'deferred')  return reqs.filter(matchesDeferred);
    return reqs.filter(r => r.status === statusFilter);
  }

  // Same predicates, same order, no second copy of any expression — the tab
  // badge and the tab body are computed from ONE definition each.
  const tally = (list: Requisition[]) => ({
    inbox_chef:  list.filter(r => r.status === 'submitted').length,
    inbox_mgmt:  list.filter(r => r.status === 'chef_approved').length,
    inbox_store: list.filter(r => ['mgmt_approved', 'chef_approved', 'store_processed'].includes(r.status)).length,
    // partially-issued is its own bucket — keep it out of `open`.
    partially_issued: list.filter(r => r.status === 'store_processed').length,
    open:        list.filter(r => !['fulfilled', 'cancelled', 'chef_rejected', 'store_processed'].includes(r.status)).length,
    fulfilled:   list.filter(matchesFulfilled).length,
    deferred:    list.filter(matchesDeferred).length,
  });

  // Tab badges count the SEARCH-narrowed set, so "(4)" on a tab always equals
  // the rows you get when you click it.
  const counts = useMemo(() => tally(searched), [searched]);
  // The inbox call-outs are a workload alert about the REAL queue, so they
  // count the unsearched list — and their buttons clear the search before
  // switching tabs, so the queue you land on holds exactly that many rows.
  const inboxCounts = useMemo(() => tally(reqs), [reqs]);
  const openQueue = (tab: string) => { setSearch(''); setStatusFilter(tab); };

  const toggleExpand = (id: string) => setExpanded(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header matches /party-requisitions: icon inline, flex-1 title block,
          flex-wrap so the actions drop to their own row on a narrow screen
          instead of being squeezed until the button text wraps. */}
      <div className="flex items-center gap-3 flex-wrap mb-5">
        <ClipboardList className="w-6 h-6 text-[#af4408] shrink-0" />
        {/* min-w is the wrap trigger: this page has TWO action buttons (Party has
            one), so a small floor let them squeeze the heading onto two lines.
            Keep enough width for the title and let the buttons wrap instead.
            The floor MUST stay under the phone content column (viewport minus
            the AppShell + page padding) — main is overflow-x:hidden below
            1024px, so anything wider is clipped, not scrollable. Hence the
            repo-standard 220px on phones, full 330px from `sm` up. */}
        <div className="flex-1 min-w-[220px] sm:min-w-[330px]">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Department Requisitions</h1>
          <p className="text-xs text-[#8B7355]">Internal stock requests → HOD (Head of Department) → Store Manager → Vendor PO (admin approves) → Fulfilled.</p>
        </div>
        <div className="flex gap-2 shrink-0">
          {viewer.role === 'admin' && (
            <button onClick={() => setImporting(true)}
                    className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2 whitespace-nowrap">
              <Upload className="w-4 h-4" /> Import Recaho Transfers
            </button>
          )}
          <button onClick={() => setCreating(true)}
                  className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-2 whitespace-nowrap">
            <Plus className="w-4 h-4" /> Raise Requisition
          </button>
        </div>
      </div>

      {/* Search — same control as /party-requisitions. Counter reads against the
          ACTIVE tab, so "3 of 12" means 3 matches within the tab you are on. */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex items-center gap-2 mb-4">
        <Search size={14} className="text-[#8B7355]" />
        <input value={search} onChange={e => setSearch(e.target.value)}
               placeholder="Search by req #, department, party, status, PO # or notes…"
               className="flex-1 px-2 py-1 text-sm bg-transparent focus:outline-none" />
        {search && (
          <button onClick={() => setSearch('')} title="Clear search" className="text-[#8B7355] hover:text-[#af4408]">
            <X size={12} />
          </button>
        )}
        <span className="text-xs text-[#8B7355]">{filtered.length} of {statusFiltered(reqs, statusFilter).length}</span>
      </div>

      {/* Inbox call-outs. These count the FULL queue (inboxCounts), not the
          search-narrowed one, so an old query in the box can never hide work
          from an approver — and openQueue() clears the search on the way in. */}
      {(viewer.can_chef && inboxCounts.inbox_chef > 0) && (
        <div className="mb-3 px-4 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {inboxCounts.inbox_chef} requisition(s) waiting for your chef approval.
          <button onClick={() => openQueue('inbox-chef')} className="ml-auto underline">Review</button>
        </div>
      )}
      {/* Mgmt callout only when the gate is ON. When OFF, chef approval is the
          final gate and there's no Mgmt action to take here. */}
      {(requireMgmt && viewer.can_mgmt && inboxCounts.inbox_mgmt > 0) && (
        <div className="mb-3 px-4 py-2 bg-indigo-50 border border-indigo-200 rounded-lg text-xs text-indigo-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> {inboxCounts.inbox_mgmt} HOD-approved requisition(s) waiting for Management approval.
          <button onClick={() => openQueue('inbox-mgmt')} className="ml-auto underline">Approve</button>
        </div>
      )}
      {(viewer.can_store && inboxCounts.inbox_store > 0) && (
        <div className="mb-3 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800 flex items-center gap-2">
          <Package className="w-4 h-4" />
          {inboxCounts.inbox_store} {requireMgmt ? 'mgmt-approved' : 'HOD-approved'} requisition(s) for store to process.
          <button onClick={() => openQueue('inbox-store')} className="ml-auto underline">Process</button>
        </div>
      )}

      {/* View-only context banner — fires when a user without approval rights
          (typically the Store Manager) lands on the Chef or Mgmt inbox. Lets
          them see what's in the queue without confusing them about why the
          Approve / Reject buttons don't appear. */}
      {((statusFilter === 'inbox-chef' && !viewer.can_chef) ||
        (statusFilter === 'inbox-mgmt' && !viewer.can_mgmt)) && (
        <div className="mb-3 px-3 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-[11px] text-[#6B5744] flex items-center gap-2">
          <Eye className="w-3.5 h-3.5" />
          <span>
            <b>View only.</b> This is the {statusFilter === 'inbox-chef' ? 'HOD\'s' : 'Management\'s'} approval queue —
            you can see what's pending but the action buttons (Approve / Reject) are gated to that role.
          </span>
        </div>
      )}

      {/* Filters. The Mgmt Inbox tab only appears when the Mgmt-approval gate
          is enabled on Settings → Integrations — otherwise it's noise. */}
      <TabScroller className="gap-1 mb-3 text-xs">
        {[
          { k: 'all', l: 'All' }, { k: 'open', l: `Open (${counts.open})` },
          { k: 'inbox-chef', l: `HOD Inbox (${counts.inbox_chef})` },
          ...(requireMgmt ? [{ k: 'inbox-mgmt', l: `Mgmt Inbox (${counts.inbox_mgmt})` }] : []),
          { k: 'inbox-store', l: `Store Inbox (${counts.inbox_store})` },
          // "Partially issued" only appears when there's at least one — saves
          // tab-row noise when everything is either pending or fully issued.
          // Kept visible while it's the ACTIVE tab, so a search that matches
          // nothing here can't pull the highlighted tab out from under you.
          ...(counts.partially_issued > 0 || statusFilter === 'partially-issued'
            ? [{ k: 'partially-issued', l: `Partially Issued (${counts.partially_issued})` }]
            : []),
          // "Deferred" = the store promised a later time on at least one line.
          // Same appear-only-when-non-empty rule as Partially Issued, so a
          // venue that never defers sees the exact tab row it sees today.
          ...(counts.deferred > 0 || statusFilter === 'deferred'
            ? [{ k: 'deferred', l: `Deferred (${counts.deferred})` }]
            : []),
          { k: 'draft', l: 'Drafts' }, { k: 'fulfilled', l: `Fulfilled (${counts.fulfilled})` },
          { k: 'chef_rejected', l: 'Rejected' },
        ].map(o => (
          <button key={o.k} onClick={() => setStatusFilter(o.k)}
                  className={`px-2.5 py-1 rounded ${statusFilter === o.k ? 'bg-[#af4408] text-white' : 'bg-white border border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'}`}>
            {o.l}
          </button>
        ))}
      </TabScroller>

      {/* overflow-x-auto (NOT hidden): the 10-column table is wider than a phone
          viewport — clipping made the right columns + row actions unreachable. */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-[#8B7355]">
            <ClipboardList className="w-8 h-8 mx-auto mb-2 opacity-50" />
            {/* Name the search first (like /party-requisitions) — otherwise a
                query that matches nothing reads exactly like an empty list. */}
            {search.trim()
              ? <>No requisitions match &ldquo;{search.trim()}&rdquo;{statusFilter !== 'all' ? ' on this tab' : ''}.</>
              : <>No requisitions{statusFilter !== 'all' ? ' matching that filter' : ''}.</>}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-[#8B7355] bg-[#FFF8F0]">
              <tr>
                <th className="w-6"></th>
                <th className="text-left py-2 px-3 font-medium">Requisition #</th>
                <th className="text-left py-2 px-3 font-medium">Department</th>
                <th className="text-left py-2 px-3 font-medium" title="For party requisitions: host name + company. Internal kitchen reqs show '—'.">For Party</th>
                <th className="text-left py-2 px-3 font-medium">Date</th>
                <th className="text-right py-2 px-3 font-medium">Items</th>
                <th className="text-right py-2 px-3 font-medium">Est. Value</th>
                <th className="text-left py-2 px-3 font-medium">Status</th>
                <th className="text-left py-2 px-3 font-medium">Linked PO</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <RequisitionRow key={r.id} r={r}
                                expanded={expanded.has(r.id)}
                                onToggle={() => toggleExpand(r.id)}
                                materials={materials}
                                viewer={viewer}
                                requireMgmt={requireMgmt}
                                reload={reload}
                                onEdit={(draft) => { setEditDraft(draft); setCreating(true); }} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (() => {
        // NEW requisitions: EVERY role uses the catalog-and-cart picker (the
        // picker gives privileged users a department selector in its header).
        // DRAFT EDITING: plain department staff (NOT admin / HOD / store
        // manager / manager — same condition as `simple` / `canChangeDept`
        // inside CreateRequisitionModal) keep the picker; privileged roles
        // keep the classic modal for edits.
        const isStaff = !!me && me.role !== 'admin' && me.role !== 'manager'
          && !me.is_head_chef && !me.is_store_manager;
        return (!editDraft || isStaff) ? (
          <StaffCatalogPicker materials={materials} me={me} departments={departments}
                              editDraft={editDraft} deptStock={deptStock}
                              onClose={() => { setCreating(false); setEditDraft(null); }}
                              onCreated={reload} />
        ) : (
          <CreateRequisitionModal departments={departments} materials={materials}
                                  me={me}
                                  editDraft={editDraft}
                                  onClose={() => { setCreating(false); setEditDraft(null); }}
                                  onCreated={reload} />
        );
      })()}
      {importing && (
        <RecahoImportModal onClose={() => setImporting(false)} onCommitted={reload} />
      )}
    </div>
  );
}

/* ============================================================ */
/* Import past transfers from a Recaho "Transfer sales report"   */
/* ============================================================ */
function RecahoImportModal({ onClose, onCommitted }: { onClose: () => void; onCommitted: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [committedSummary, setCommittedSummary] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (mode: 'preview' | 'commit' | 'departments' | 'materials') => {
    if (!file) { alert('Pick a Recaho .xlsx first'); return; }
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.set('file', file);
      if (mode === 'commit')      fd.set('commit', 'true');
      if (mode === 'departments') fd.set('departments_only', 'true');
      if (mode === 'materials')   fd.set('materials_only', 'true');
      const r = await api('/api/requisitions-import', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      if (mode === 'commit') { setCommittedSummary(j); onCommitted(); }
      else if (mode === 'departments' || mode === 'materials') {
        // Re-run the preview so badges/counts refresh in place.
        const fd2 = new FormData(); fd2.set('file', file);
        const r2 = await api('/api/requisitions-import', { method: 'POST', body: fd2 });
        if (r2.ok) setPreview(await r2.json());
        onCommitted();
        if (mode === 'departments') {
          alert(`Created ${j.created_departments.length} department(s):\n` + (j.created_departments.join('\n') || '(none)'));
        } else {
          const head = j.created_materials.slice(0, 8).map((m: any) => `· ${m.name} (${m.unit}) ₹${m.price}`).join('\n');
          alert(`Created ${j.created_count} material(s) — flagged "auto-discovered" for review.\n\n${head}${j.created_count > 8 ? `\n…and ${j.created_count - 8} more` : ''}`);
        }
      } else { setPreview(j); }
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-3xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <h2 className="font-bold text-[#2D1B0E] flex items-center gap-2"><Upload className="w-5 h-5" /> Import Recaho Transfer Report</h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <p className="text-[#6B5744] text-xs">
            Upload the <code className="px-1 py-0.5 bg-[#FFF1E3] rounded">Transfer sales report-detail</code> .xlsx
            from Recaho POS. Each <span className="font-mono">TRANSFER/SALE ID</span> becomes one Requisition (status:
            <span className="ml-1 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-medium">Fulfilled</span>).
            Departments not in our master will be auto-created. Items not in raw_materials will be skipped (and listed below).
          </p>

          <div className="flex items-center gap-2">
            <input type="file" accept=".xlsx,.xls"
                   onChange={e => { setFile(e.target.files?.[0] || null); setPreview(null); setCommittedSummary(null); setError(null); }}
                   className="text-xs flex-1" />
            <button onClick={() => send('preview')} disabled={!file || busy || !!committedSummary}
                    className="px-3 py-1.5 text-xs bg-white border border-[#E8D5C4] rounded hover:bg-[#FFF1E3] disabled:opacity-50">
              {busy && !preview ? 'Parsing…' : 'Preview'}
            </button>
          </div>

          {/* Departments-only fast path — useful when masters aren't ready yet */}
          {preview && preview.missing_departments?.length > 0 && !committedSummary && (
            <div className="border border-amber-200 rounded-lg p-3 bg-amber-50/60 text-xs flex items-start gap-3">
              <div className="flex-1">
                <div className="font-semibold text-amber-900">
                  Just create departments? ({preview.missing_departments.length} new)
                </div>
                <div className="text-amber-800 mt-0.5">
                  Skip the transfer import for now and only seed the Departments page so you can assign HODs (Heads of Department) and Store Managers right away.
                </div>
              </div>
              <button onClick={() => send('departments')} disabled={busy}
                      className="shrink-0 px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded disabled:opacity-50">
                Create {preview.missing_departments.length} departments
              </button>
            </div>
          )}

          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
              {error}
            </div>
          )}

          {preview && !committedSummary && (
            <div className="border border-[#E8D5C4] rounded-lg p-3 space-y-2 bg-[#FFF8F0] text-xs">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[#6B5744]">
                <span><b>Sheet:</b> {preview.sheet}</span>
                <span><b>Date range:</b> {preview.date_min} → {preview.date_max}</span>
                <span><b>Transfers:</b> <span className="font-mono">{preview.group_count}</span> ({preview.line_count} item lines)</span>
                <span><b>New to import:</b> <span className="font-mono text-emerald-700">{preview.new_transfer_count}</span></span>
                {preview.skipped_existing_count > 0 && (
                  <span><b>Already imported:</b> <span className="font-mono text-[#8B7355]">{preview.skipped_existing_count}</span></span>
                )}
              </div>

              <div>
                <b>Departments found ({preview.departments.length}):</b>
                <div className="mt-1 flex flex-wrap gap-1">
                  {preview.departments.map((d: string) => {
                    const isNew = preview.missing_departments.includes(d);
                    return (
                      <span key={d} className={`text-[10px] px-1.5 py-0.5 rounded border ${
                        isNew
                          ? 'bg-amber-50 text-amber-800 border-amber-200'
                          : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      }`}>
                        {isNew && '+ '}{d}
                      </span>
                    );
                  })}
                </div>
                {preview.missing_departments.length > 0 && (
                  <div className="text-[10px] text-amber-800 mt-1">
                    {preview.missing_departments.length} department(s) marked with <b>+</b> will be auto-created.
                  </div>
                )}
              </div>

              {preview.unmatched_item_count > 0 && (
                <div className="border border-amber-200 rounded-lg p-3 bg-amber-50/60">
                  <div className="flex items-start gap-3">
                    <div className="flex-1">
                      <div className="font-semibold text-amber-900">
                        ⚠ {preview.unmatched_item_count} unmatched item(s)
                      </div>
                      <div className="text-amber-800 mt-0.5">
                        These items appear in the file but aren't in your Materials master. Auto-create them now —
                        unit + category + price will be inferred from the file and each row gets flagged
                        <span className="font-mono mx-1 px-1 py-0.5 bg-amber-100 rounded text-[10px]">auto-discovered</span>
                        so you can review/correct them in <a href="/inventory" className="underline">Raw Materials</a>. The import is idempotent — re-uploading later picks up the now-matched lines.
                      </div>
                    </div>
                    <button onClick={() => send('materials')} disabled={busy}
                            className="shrink-0 px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded disabled:opacity-50">
                      Create {preview.unmatched_item_count} materials
                    </button>
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[10px] text-amber-800 hover:underline">Show item names</summary>
                    <div className="mt-1 max-h-40 overflow-y-auto bg-white border border-[#E8D5C4] rounded p-2 text-[10px] text-[#6B5744] font-mono">
                      {preview.unmatched_items.map((n: string, i: number) => <div key={i}>· {n}</div>)}
                      {preview.unmatched_item_count > preview.unmatched_items.length && (
                        <div className="italic text-[#8B7355]">…and {preview.unmatched_item_count - preview.unmatched_items.length} more</div>
                      )}
                    </div>
                  </details>
                </div>
              )}

              {preview.sample_groups?.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-[#6B5744] font-medium">Sample of new transfers</summary>
                  <div className="overflow-x-auto">
                  <table className="w-full mt-1 text-[10px] max-lg:text-xs font-mono">
                    <thead className="text-[#8B7355]"><tr>
                      <th className="text-left">Transfer ID</th><th className="text-left">Department</th>
                      <th className="text-left">Date</th><th className="text-right">Lines</th><th className="text-right">Total ₹</th>
                    </tr></thead>
                    <tbody>
                      {preview.sample_groups.map((s: any) => (
                        <tr key={s.transfer_id} className="border-t border-[#E8D5C4]/50">
                          <td>{s.transfer_id}</td><td>{s.department}</td><td>{s.date}</td>
                          <td className="text-right">{s.line_count}</td><td className="text-right">{s.total_amount.toLocaleString('en-IN')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </details>
              )}

              {/* Hard rule: imported transfers do not affect stock or recipe calculations. */}
              <div className="text-[11px] px-3 py-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded text-[#6B5744]">
                <b>Internal transfers ≠ recipe consumption.</b> Imported transfers create requisitions for audit / department analytics only — they do <b>not</b> deduct stock and are <b>not</b> counted as consumption. Real consumption comes from recipe-deduction on sales, parties, staff meals, and closing-stock variance.
              </div>
            </div>
          )}

          {committedSummary && (
            <div className="border border-emerald-200 rounded-lg p-3 bg-emerald-50 text-xs space-y-1">
              <div className="font-semibold text-emerald-800">✓ Import committed</div>
              <ul className="text-emerald-900 space-y-0.5">
                <li>Created {committedSummary.summary.created_departments} departments</li>
                <li>Created {committedSummary.summary.created_requisitions} fulfilled requisitions</li>
                <li>Created {committedSummary.summary.created_lines} line items</li>
                {committedSummary.summary.skipped_existing > 0 && <li>Skipped {committedSummary.summary.skipped_existing} already-imported transfers</li>}
                {committedSummary.summary.skipped_unmatched_lines > 0 && <li>Skipped {committedSummary.summary.skipped_unmatched_lines} lines without a matching material</li>}
              </ul>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">{committedSummary ? 'Close' : 'Cancel'}</button>
          {preview && !committedSummary && (
            <button onClick={() => send('commit')} disabled={busy || preview.new_transfer_count === 0}
                    className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg disabled:opacity-50 inline-flex items-center gap-1.5">
              {busy ? 'Committing…' : <><CheckCircle2 className="w-4 h-4" /> Commit {preview.new_transfer_count} transfers</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
function RequisitionRow({ r, expanded, onToggle, materials, viewer, requireMgmt, reload, onEdit }: {
  r: Requisition; expanded: boolean; onToggle: () => void;
  materials: Material[];
  viewer: { email: string; role: string; can_chef: boolean; can_mgmt: boolean; can_store: boolean; can_issue: boolean };
  requireMgmt: boolean;
  reload: () => void;
  onEdit: (draft: Requisition) => void;
}) {
  return (
    <>
      <tr className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]/50">
        <td className="py-2 px-2 align-top">
          {/* p-1 -m-1 widens the tap target without shifting layout; shrink-0
              keeps the icon from collapsing to 0 width in the squeezed cell. */}
          <button onClick={onToggle} aria-label={expanded ? 'Collapse' : 'Expand'}
                  className="text-[#6B5744] inline-flex items-center justify-center p-1 -m-1">
            {expanded ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
          </button>
        </td>
        <td className="py-2 px-3 font-mono font-semibold text-[#2D1B0E]">{r.req_number}</td>
        <td className="py-2 px-3">
          <div className="text-[#2D1B0E]">{r.department_name}</div>
          {r.department_code && <div className="text-[10px] font-mono text-[#8B7355]">{r.department_code}</div>}
        </td>
        {/* For Party — host name + company + event date for party reqs.
            Internal kitchen reqs show a dash so the column stays scannable. */}
        <td className="py-2 px-3">
          {r.purpose === 'party' ? (
            <div>
              <div className="text-[#2D1B0E] font-medium">{r.event_name || <span className="text-[#C0A98F] italic">(no host name)</span>}</div>
              {r.customer && <div className="text-[10px] text-[#6B5744]">{r.customer}</div>}
              {r.event_date && (
                <div className="text-[10px] text-[#8B7355]">
                  Event: {r.event_date}{r.guest_count ? ` · ${r.guest_count} pax` : ''}
                </div>
              )}
            </div>
          ) : (
            <span className="text-[10px] text-[#8B7355]" title="Internal kitchen requisition — not tied to a specific party">— internal —</span>
          )}
        </td>
        <td className="py-2 px-3 text-[#6B5744]">{r.date}</td>
        <td className="py-2 px-3 text-right font-mono">{r.item_count || 0}</td>
        <td className="py-2 px-3 text-right font-mono text-[#6B5744]">{fmt(r.estimated_value || 0)}</td>
        <td className="py-2 px-3">
          <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${STATUS_BADGE[r.status]}`}>
            {STATUS_LABEL[r.status] || r.status}
          </span>
          {/* Part — goods went out on some lines and the rest is still owed on a
              LIVE requisition. Without it, the same req appearing under both
              Fulfilled and Partially Issued reads as a duplicate rather than a
              state. Hidden when the roll-ups are absent (they read 0). */}
          {isPartIssued(r) && (
            <span title={`Part-issued — ${num(r.lines_issued_any)} line(s) handed over, ${num(r.lines_owing)} still owed`}
                  className="ml-1 text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap bg-rose-100 text-rose-700">
              Part
            </span>
          )}
        </td>
        <td className="py-2 px-3 font-mono text-xs">
          {r.linked_po_number ? (
            <a href={`/purchase-orders?id=${r.linked_po_id}`} className="text-[#af4408] hover:underline">
              {r.linked_po_number} <span className="text-[#8B7355]">({r.linked_po_status})</span>
            </a>
          ) : <span className="text-[#8B7355]">—</span>}
        </td>
        <td className="py-2 px-3 text-[10px] text-[#8B7355]">
          {r.drafted_by}
        </td>
      </tr>
      {expanded && <RequisitionDetail r={r} materials={materials} viewer={viewer} requireMgmt={requireMgmt} reload={reload} onEdit={onEdit} />}
    </>
  );
}

function RequisitionDetail({ r, materials, viewer, requireMgmt, reload, onEdit }: {
  r: Requisition; materials: Material[];
  viewer: { email: string; role: string; can_chef: boolean; can_mgmt: boolean; can_store: boolean; can_issue: boolean };
  requireMgmt: boolean;
  reload: () => void;
  onEdit: (draft: Requisition) => void;
}) {
  const [detail, setDetail] = useState<Requisition | null>(null);
  const [busy, setBusy] = useState(false);
  const [showProcess, setShowProcess] = useState(false);
  const [showApprove, setShowApprove] = useState(false);
  const [showMgmtApprove, setShowMgmtApprove] = useState(false);
  const [showReject, setShowReject] = useState(false);

  useEffect(() => {
    fetch(`/api/requisitions?id=${r.id}`).then(x => x.json()).then(d => setDetail(d.requisition));
  }, [r.id]);

  if (!detail) {
    return <tr><td colSpan={10} className="bg-[#FFF8F0] py-3 px-4 text-xs text-[#8B7355]">Loading detail…</td></tr>;
  }

  const isAuthor = detail.drafted_by === viewer.email;
  const isAdmin  = viewer.role === 'admin';
  const canEdit  = (isAuthor || isAdmin) && detail.status === 'draft';
  const canSubmit = (isAuthor || isAdmin) && detail.status === 'draft' && (detail.items?.length || 0) > 0;
  // Per-requisition: only the head of THIS req's main department (or admin) sees
  // Approve/Reject. detail.can_approve_chef comes from the API (isMainDeptHead);
  // fall back to the global hint only if the field is absent (older payload).
  const canChefAct = ((detail as any).can_approve_chef ?? viewer.can_chef) && detail.status === 'submitted';
  // Only show Mgmt Approve when the global gate is ON. When OFF, chef approval
  // is the final gate — the requisition is already in the store inbox and
  // there's no Mgmt action to take.
  const canMgmtAct = requireMgmt && viewer.can_mgmt && detail.status === 'chef_approved';
  // Store may act on mgmt-approved (current SOP) or chef_approved (legacy in-flight)
  const canStoreAct = viewer.can_issue && (detail.status === 'mgmt_approved' || detail.status === 'chef_approved');  // STRICT: store person only, no admin bypass (mirrors canIssueAsStore)
  // Cancel: HOD/admin may cancel any live requisition. The department drafter may
  // cancel ONLY while it is still a DRAFT — once it is submitted (Chef Inbox) or
  // being issued (Partially Issued), only HOD/admin can cancel it.
  const isHodOrAdmin = isAdmin || viewer.can_chef;
  const canCancel = !['fulfilled', 'cancelled', 'chef_rejected'].includes(detail.status)
    && (isHodOrAdmin || (isAuthor && detail.status === 'draft'));
  // Phase 1 §2: dept staff confirms goods physically arrived. One-shot — only on fulfilled, not yet acked.
  const canAck   = detail.status === 'fulfilled' && !detail.dept_acknowledged_at && (isAuthor || isAdmin);

  // Plain department staff (NOT admin / manager / HOD / store) get a stripped-down,
  // mobile-friendly item view: Item / Qty / Unit per line + one overall total.
  // HOD, admin, store and manager keep the full table (the else branch below).
  const isPlainDept = viewer.role !== 'admin' && viewer.role !== 'manager'
    && !viewer.can_chef && !viewer.can_mgmt && !viewer.can_store && !viewer.can_issue;
  // Has the store actually handed anything over? This MUST stay the same
  // predicate the full item table uses to reveal its Issued / To Purchase
  // columns (both call sites below read this const) — the department view and
  // the store view render the same lines, and if the two ever disagreed about
  // whether a requisition had been issued they would print different
  // quantities for the same row to two people standing next to each other.
  //
  // Deliberately status-only, NOT `lines_issued_any` (which the tab predicates
  // use): a requisition cancelled after a partial issue would keep showing the
  // requested figure. There are zero such rows today; if one ever appears this
  // is the one line to change, in lockstep with the store table.
  const storeHasIssued = detail.status === 'store_processed' || detail.status === 'fulfilled';
  // Closed = nothing more is coming. Drives "short" vs "still to come" on a
  // part-issued line — see the note on isPartIssued: 45% of `fulfilled`
  // requisitions here were closed SHORT months ago, so "still to come" would be
  // a lie on most of the rows this sub-line will ever render on.
  const reqIsClosed = TERMINAL_STATUSES.includes(detail.status);
  // Overall requisition cost = Σ lead-qty × pack-factor × ₹/recipe-unit.
  // reqPackFactor converts a purchase-unit request (e.g. 1 BTL) to recipe units
  // before costing at average_price (₹/recipe-unit) — same convention as party
  // costing. Rejected lines excluded by deptLeadQty (they won't be issued).
  //
  // The BASIS follows the table above it (deptLeadQty), because a table reading
  // 5 kg above a total pricing 7 kg is worse than either number alone. The
  // arithmetic convention is untouched — toRecipe(q) === q × reqPackFactor(it),
  // so this is still qty × pack × ₹/recipe-unit, only a different qty.
  const reqTotal = (detail.items || []).reduce(
    (s, it) => s + deptLeadQty(it, storeHasIssued) * reqPackFactor(it) * (it.average_price || 0), 0);

  const submit = async () => {
    if (!confirm('Submit this requisition for head-chef approval?')) return;
    setBusy(true);
    let res = await api(`/api/requisitions/${r.id}/submit`, { method: 'POST', body: {} });
    if (!res.ok) {
      const j = await res.json();
      // Phase 1 §2 — submission window enforcement. Admin can override.
      if (j.outside_window && viewer.role === 'admin') {
        const ok = confirm(`${j.error}\n\nOverride as admin and submit anyway?`);
        if (ok) {
          res = await api(`/api/requisitions/${r.id}/submit`, { method: 'POST', body: { force_outside_window: true } });
          if (!res.ok) { alert((await res.json()).error || 'Failed'); setBusy(false); return; }
        } else { setBusy(false); return; }
      } else {
        alert(j.error || 'Failed'); setBusy(false); return;
      }
    }
    reload();
    setBusy(false);
  };
  const cancel = async () => {
    if (!confirm('Cancel this requisition?')) return;
    setBusy(true);
    const res = await api(`/api/requisitions/${r.id}/cancel`, { method: 'POST', body: {} });
    if (!res.ok) alert((await res.json()).error || 'Failed');
    else reload();
    setBusy(false);
  };
  const ack = async () => {
    const note = prompt('Confirm receipt of all issued items at the department.\n\nOptional note (e.g. condition, time received):') ?? '';
    if (note === null) return;
    setBusy(true);
    const res = await api(`/api/requisitions/${r.id}/acknowledge`, { method: 'POST', body: { note } });
    if (!res.ok) alert((await res.json()).error || 'Failed');
    else reload();
    setBusy(false);
  };

  return (
    <tr><td colSpan={10} className="bg-[#FFF8F0] py-3 px-4">
      {/* The td spans the FULL table width (wider than a phone screen inside the
          horizontally-scrolling list). sticky left-0 + a viewport-width cap keep
          the detail card (items, audit trail, action buttons) pinned and fully
          visible without sideways scrolling on phones; lg: restores full width. */}
      <div className="sticky left-0 max-w-[calc(100vw-4rem)] lg:static lg:max-w-none">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-3">
        <div className="lg:col-span-3">
          {isPlainDept ? (
            /* Department (plain staff) view — only Item / Qty / Unit + one total. */
            <>
              <table className="w-full text-xs">
                <thead className="text-[#8B7355]">
                  <tr>
                    <th className="text-left  py-1 px-2 font-medium">Item</th>
                    <th className="text-right py-1 px-2 font-medium">Qty</th>
                    <th className="text-left  py-1 px-2 font-medium">Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.items || []).map(it => {
                    const rejected = !!it.is_rejected;
                    // Owner rule: purchase basis leads, recipe figure as the hint.
                    const U = lineUnits(it);
                    // ONE headline figure per line — the truth about goods (see
                    // deptLeadQty). Everything below is the exception report.
                    const lead = deptLeadQty(it, storeHasIssued);
                    const approved = effectiveQty(it);
                    const issued = Number(it.quantity_issued) || 0;
                    // Nothing is still to come on a line the server calls
                    // complete (lineIssueComplete — THE RULE: in full, or a
                    // take emptied the shelf with less than a step owed).
                    const open = lineIssueComplete(it) ? 0 : Math.max(0, approved - issued);
                    const over = issued - approved;
                    // "requested" vs "approved" — say which number the line fell
                    // short OF, or the department reads its own ask back at it
                    // when it was actually the HOD who cut the line.
                    const basis = it.chef_approved_qty != null ? 'approved' : 'requested';
                    // QUIET BY DEFAULT. A line that arrived whole, or has not
                    // reached the store yet, renders exactly as it did before
                    // this change: one figure, no commentary. Only a line that
                    // did NOT arrive whole earns a second line of text.
                    //
                    // The `approved > 0` guard is load-bearing, not defensive:
                    // 3,395 imported lines carry quantity_requested = 0 with a
                    // real issued qty, and "of 0 kg requested" on a fifth of
                    // every list is how a genuine warning stops being read.
                    const caveat = rejected
                      ? 'Rejected by HOD — not issued'
                      : (!storeHasIssued && it.chef_approved_qty != null
                          && Number(it.chef_approved_qty) !== Number(it.quantity_requested))
                        ? `HOD approved · requested ${fmtNum(U.toPU(it.quantity_requested))} ${U.pu}`
                      : (storeHasIssued && approved > 0 && open > 1e-9)
                        ? `of ${fmtNum(U.toPU(approved))} ${U.pu} ${basis} · ${fmtNum(U.toPU(open))} ${reqIsClosed ? 'short' : 'still to come'}`
                      : (storeHasIssued && approved > 0 && over > 1e-9)
                        ? `${fmtNum(U.toPU(over))} ${U.pu} over the ${fmtNum(U.toPU(approved))} ${U.pu} ${basis}`
                      : null;
                    return (
                      <tr key={it.id} className={`border-t border-[#E8D5C4]/50 ${rejected ? 'opacity-50 line-through bg-red-50/30' : ''}`}>
                        <td className="py-1 px-2">{it.material_name}</td>
                        <td className="py-1 px-2 text-right font-mono">
                          {/* Rejected prints an em-dash, same as the full table.
                              It used to print the placeholder 1 that
                              chef-approve/route.ts writes on a rejected line —
                              a quantity nobody ever asked for or issued. */}
                          {rejected ? <span className="text-red-700 no-underline">—</span> : fmtNum(U.toPU(lead))}
                          {!rejected && U.pf > 1 && (
                            <div className="text-[9px] text-[#B8A590] font-normal no-underline">
                              = {fmtNum(U.toRecipe(lead))} {U.recipeUnit}
                            </div>
                          )}
                          {caveat && (
                            <div className={`text-[9px] font-normal no-underline ${rejected ? 'text-red-700' : 'text-amber-700'}`}>
                              {caveat}
                            </div>
                          )}
                        </td>
                        <td className="py-1 px-2 font-bold text-[#2D1B0E]">{U.pu}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="mt-2 flex items-center justify-between border-t-2 border-[#D4B896] pt-2">
                {/* Relabelled once the basis moves, so the number changing is
                    legible rather than mysterious to someone who saw it before
                    the store issued. */}
                <span className="text-xs font-semibold text-[#2D1B0E]">{storeHasIssued ? 'Issued value' : 'Requisition total'}</span>
                <span className="text-sm font-mono font-semibold text-[#2D1B0E]">{fmt(reqTotal)}</span>
              </div>
            </>
          ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[#8B7355]">
              <tr>
                <th className="text-left py-1 px-2 font-medium">SKU</th>
                <th className="text-left py-1 px-2 font-medium">Material</th>
                <th className="text-right py-1 px-2 font-medium">Requested</th>
                <th className="text-right py-1 px-2 font-medium" title="HOD-approved quantity (overrides Requested when set)">HOD OK</th>
                <th className="text-right py-1 px-2 font-medium">On Hand</th>
                {/* Same const the department table leads with — see storeHasIssued. */}
                {storeHasIssued && (
                  <>
                    <th className="text-right py-1 px-2 font-medium">Issued</th>
                    <th className="text-right py-1 px-2 font-medium">To Purchase</th>
                  </>
                )}
                <th className="text-right py-1 px-2 font-medium" title="Average price per purchase/ordering unit">Avg ₹ / unit</th>
                <th className="text-left  py-1 px-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {/* CATEGORY-WISE, so the store person walks one shelf at a time.
                  Full-width header rows rather than a per-row Category column:
                  that is how /store-requisitions already prints the same
                  requisition (page.tsx:1508-1552), it costs the table ZERO
                  horizontal width — which is what keeps this readable on a
                  tablet inside the existing overflow-x-auto — and a bare column
                  would not have helped anyway, because the rows arrive ordered
                  by department + material name, so the categories would still be
                  scattered down the list. Deliberately NOT collapsible: a
                  collapsed group on a hand-over sheet is a line quietly not
                  issued. Grouping is presentation only — reqTotal and every
                  action still read detail.items. */}
              {groupLinesByCategory(detail.items || []).map(group => (
              <Fragment key={`cat-${group.name}`}>
                <tr className="bg-[#FFF1E3] border-t border-[#E8D5C4]">
                  {/* colSpan tracks the header row above: 7 columns normally,
                      9 once Issued / To Purchase appear (same storeHasIssued
                      const the <thead> uses, so the two can never drift). */}
                  <td colSpan={storeHasIssued ? 9 : 7}
                      className="py-1 px-2 text-[10px] font-semibold uppercase tracking-wide text-[#8B7355]">
                    {group.name}
                    {/* THE COUNT IS WHAT THE PICKER HANDS OVER. detail.items
                        includes chef-rejected lines (they render struck-through
                        below), while the Issue modal's identical header counts a
                        list those are already filtered out of — so one shelf
                        printed "5 items" here and "4 items" there, on the two
                        surfaces this grouping exists to reconcile. Count the
                        pickable rows and name the rejected ones separately
                        rather than folding them into the same number. */}
                    {(() => {
                      const pick = group.lines.filter(l => !l.is_rejected).length;
                      const rej  = group.lines.length - pick;
                      return (
                        <span className="ml-1.5 font-normal normal-case">
                          ({pick} item{pick === 1 ? '' : 's'}{rej > 0 ? ` + ${rej} rejected` : ''})
                        </span>
                      );
                    })()}
                  </td>
                </tr>
                {group.lines.map(it => {
                const rejected = !!it.is_rejected;
                // Stock is in recipe units; the request may be in the purchase
                // unit (e.g. BTL) — convert before comparing.
                const short = (it.current_stock < it.quantity_requested * reqPackFactor(it));
                // Purchase-unit context for display: stock is stored in recipe
                // units (g/ml) and average_price is ₹/recipe-unit — both are
                // unreadable raw (18,000 / ₹0). Convert to the ordering unit.
                // Every basis question on this row goes through the ONE resolver
                // (was a local packN/hasPU pair whose case-sensitive purchase_unit
                // compare could disagree with packFactor's normalised one).
                const U = lineUnits(it);
                const puLbl = U.pu;
                const avgPerPU = (it.average_price || 0) * U.pf;
                // Small "= N g" recipe hint under a purchase-unit figure. no-underline
                // keeps it legible on the struck-through rejected rows.
                const hint = (q: number) => U.pf > 1
                  ? <div className="text-[9px] text-[#B8A590] font-normal no-underline">= {fmtNum(U.toRecipe(q))} {U.recipeUnit}</div>
                  : null;
                // Rejected lines get strikethrough + faded; rest render normal.
                const rowCls = `border-t border-[#E8D5C4]/50 ${rejected ? 'opacity-50 line-through bg-red-50/30' : ''}`;
                return (
                  <tr key={it.id} className={rowCls}>
                    <td className="py-1 px-2 font-mono text-[10px] text-[#8B7355]">{it.material_sku || '·'}</td>
                    <td className="py-1 px-2">
                      {it.material_name}
                      {it.chef_note && <div className="text-[9px] text-amber-700 no-underline">Chef: {it.chef_note}</div>}
                    </td>
                    <td className="py-1 px-2 text-right font-mono">
                      {fmtNum(U.toPU(it.quantity_requested))} {puLbl}
                      {hint(it.quantity_requested)}
                    </td>
                    <td className="py-1 px-2 text-right font-mono">
                      {rejected
                        ? <span className="text-red-700 no-underline">—</span>
                        : it.chef_approved_qty != null
                          ? <><span className="text-amber-700">{fmtNum(U.toPU(it.chef_approved_qty))} {puLbl}</span>{hint(Number(it.chef_approved_qty))}</>
                          : <span className="text-[#C0A98F]">—</span>}
                    </td>
                    <td className={`py-1 px-2 text-right font-mono ${short ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>
                      {/* Owner rule: purchase basis leads; the exact recipe figure
                          stays underneath — it is the stored truth. current_stock
                          is ALWAYS recipe units (material-level), so it converts
                          with stockPU, never with the line-basis toPU. */}
                      {U.pf > 1
                        ? <>{fmtNum(U.stockPU(it.current_stock))} {puLbl}{short && ' ⚠'}
                            <div className="text-[9px] text-[#B8A590] font-normal no-underline">
                              = {fmtNum(it.current_stock)} {U.recipeUnit}
                            </div></>
                        : <>{fmtNum(it.current_stock)} {puLbl}{short && ' ⚠'}</>}
                    </td>
                    {storeHasIssued && (
                      <>
                        <td className="py-1 px-2 text-right font-mono text-emerald-700">
                          {rejected ? '—' : <>{fmtNum(U.toPU(it.quantity_issued))} {puLbl}{hint(it.quantity_issued || 0)}</>}
                        </td>
                        <td className="py-1 px-2 text-right font-mono text-blue-700">
                          {rejected ? '—' : <>{fmtNum(U.toPU(it.quantity_to_purchase))} {puLbl}{hint(it.quantity_to_purchase || 0)}</>}
                        </td>
                      </>
                    )}
                    {/* unit-lock: the CELL shows ₹/purchase-unit (avgPerPU); the tooltip
                        deliberately shows the STORED basis, ₹/recipe-unit, because that is
                        the number every money formula uses. Converting it would hide the
                        only auditable figure on the row. */}
                    <td className="py-1 px-2 text-right font-mono text-[#6B5744]"
                        title={`avg ₹${(it.average_price || 0).toFixed(4)}/${it.material_unit}`}>
                      {avgPerPU >= 1 ? fmt(avgPerPU) : `₹${avgPerPU.toFixed(2)}`}
                      <span className="text-[#8B7355]">/{puLbl}</span>
                    </td>
                    <td className="py-1 px-2 no-underline">
                      {rejected
                        ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200 font-medium">Rejected by HOD</span>
                        : it.chef_approved_qty != null
                          ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">Qty edited</span>
                          : <span className="text-[10px] text-[#C0A98F]">—</span>}
                    </td>
                  </tr>
                );
                })}
              </Fragment>
              ))}
            </tbody>
          </table>
          </div>
          )}
        </div>
        <div className="text-[11px] text-[#6B5744] space-y-1.5">
          <div><b>Drafted by:</b> {detail.drafted_by}</div>
          {detail.notes && <div><b>Notes:</b> {detail.notes}</div>}
          {detail.submitted_at  && <div><b>Submitted:</b> {fmtIST(detail.submitted_at)} by {detail.submitted_by}</div>}
          {detail.chef_approved_at && <div className="text-blue-700"><b>HOD approved:</b> {fmtIST(detail.chef_approved_at)} by {detail.chef_approved_by}{detail.chef_note && ` — "${detail.chef_note}"`}</div>}
          {detail.mgmt_approved_at && <div className="text-indigo-700"><b>Mgmt approved:</b> {fmtIST(detail.mgmt_approved_at)} by {detail.mgmt_approved_by}{detail.mgmt_note && ` — "${detail.mgmt_note}"`}</div>}
          {detail.rejected_at && <div className="text-red-700"><b>Rejected:</b> {detail.rejected_reason} ({detail.rejected_by} · {fmtIST(detail.rejected_at)})</div>}
          {detail.store_processed_at && <div className="text-purple-700"><b>Store processed:</b> {fmtIST(detail.store_processed_at)} by {detail.store_processed_by}{detail.store_note && ` — "${detail.store_note}"`}</div>}
          {detail.fulfilled_at && <div className="text-emerald-700"><b>Fulfilled:</b> {fmtIST(detail.fulfilled_at)}</div>}
          {detail.dept_acknowledged_at && (
            <div className="text-emerald-700"><b>Dept acknowledged:</b> {fmtIST(detail.dept_acknowledged_at)} by {detail.dept_acknowledged_by}{detail.dept_ack_note && ` — "${detail.dept_ack_note}"`}</div>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2 mt-2">
        {canEdit    && <button disabled={busy} onClick={() => onEdit(detail)} className="px-3 py-1.5 text-xs bg-[#af4408] hover:bg-[#8a3506] text-white rounded inline-flex items-center gap-1"><Pencil className="w-3 h-3" /> Edit</button>}
        {canSubmit  && <button disabled={busy} onClick={submit}     className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded inline-flex items-center gap-1"><Send className="w-3 h-3" /> Submit to HOD</button>}
        {canChefAct && <button onClick={() => setShowApprove(true)} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> HOD Approve</button>}
        {canChefAct && <button onClick={() => setShowReject(true)}  className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded inline-flex items-center gap-1"><XCircle className="w-3 h-3" /> Reject</button>}
        {canMgmtAct && <button onClick={() => setShowMgmtApprove(true)} className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Mgmt Approve</button>}
        {canStoreAct && <button onClick={() => setShowProcess(true)} className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded inline-flex items-center gap-1"><Package className="w-3 h-3" /> Issue to Department</button>}
        {canAck     && <button disabled={busy} onClick={ack} className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Confirm Received at Dept</button>}
        {canCancel  && <button disabled={busy} onClick={cancel}     className="px-3 py-1.5 text-xs text-red-600 hover:underline">Cancel</button>}
      </div>
      </div>

      {/* All modals portaled to body — see ModalPortal docstring. Rendering
          fixed overlays inside a <tr><td> caused open/close flicker because
          the browser kept re-laying out the table when the modal mounted. */}
      {showApprove && <ModalPortal><ChefApproveModal req={detail} onClose={() => setShowApprove(false)} onDone={() => { setShowApprove(false); reload(); }} /></ModalPortal>}
      {showMgmtApprove && <ModalPortal><MgmtApproveModal req={detail} onClose={() => setShowMgmtApprove(false)} onDone={() => { setShowMgmtApprove(false); reload(); }} /></ModalPortal>}
      {showReject  && <ModalPortal><ChefRejectModal  req={detail} onClose={() => setShowReject(false)}  onDone={() => { setShowReject(false);  reload(); }} /></ModalPortal>}
      {showProcess && <ModalPortal><StoreProcessModal req={detail} onClose={() => setShowProcess(false)} onDone={() => { setShowProcess(false); reload(); }} /></ModalPortal>}
    </td></tr>
  );
}

/* ============================================================ */
/* Create new requisition                                        */
/* ============================================================ */
function CreateRequisitionModal({ departments, materials, me, editDraft, onClose, onCreated }: {
  departments: Department[]; materials: Material[];
  me: { role?: string; department_id?: string | null; is_head_chef?: boolean; is_store_manager?: boolean } | null;
  editDraft?: Requisition | null;
  onClose: () => void; onCreated: () => void;
}) {
  // When editing a draft, we PUT instead of POST and pre-fill the form from it.
  const isEditing = !!editDraft;
  // Department locking — internal requisitions belong to the user's home dept.
  // Only privileged roles can pick a different dept (e.g. an admin raising on
  // behalf of a team that doesn't have its own dispatcher yet):
  //   - admin            → free choice
  //   - head chef        → free choice (multi-dept oversight)
  //   - store manager    → free choice (cross-dept inventory ops)
  //   - everyone else    → locked to their own department_id
  const canChangeDept = me?.role === 'admin'
    || !!me?.is_head_chef
    || !!me?.is_store_manager
    || me?.role === 'manager';
  const lockedDeptId = !canChangeDept ? (me?.department_id || '') : '';

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(editDraft?.date || today);
  // Default the department to the user's OWN department automatically for everyone
  // who has one (a staff user is locked to it; admin/manager/head see it pre-selected
  // but can still switch). Only fall back to the first dept when the user has no home
  // department (e.g. a pure admin). When editing, honour the draft's own department.
  const [departmentId, setDepartmentId] = useState(editDraft?.department_id || me?.department_id || lockedDeptId || departments[0]?.id || '');
  // Safety net: if `me` resolves after this modal mounts, adopt the user's home
  // department — but never override a choice already made. Skip entirely when
  // editing so we don't clobber the draft's department.
  useEffect(() => {
    if (isEditing) return;
    if (me?.department_id) setDepartmentId((cur) => cur || me.department_id!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.department_id]);
  const [notes, setNotes] = useState(editDraft?.notes || '');
  const [items, setItems] = useState<Array<{ material_id: string; quantity_requested: number; unit: string; notes: string }>>(
    editDraft && (editDraft.items?.length || 0) > 0
      ? editDraft.items!.map(it => ({
          material_id: it.material_id,
          quantity_requested: it.quantity_requested,
          unit: it.unit || '',
          notes: it.notes || '',
        }))
      : [{ material_id: '', quantity_requested: 1, unit: '', notes: '' }],
  );
  const [saving, setSaving] = useState(false);

  const addLine = () => setItems(p => [...p, { material_id: '', quantity_requested: 1, unit: '', notes: '' }]);
  const update = (i: number, patch: any) => setItems(p => p.map((it, j) => j === i ? { ...it, ...patch } : it));
  const remove = (i: number) => setItems(p => p.filter((_, j) => j !== i));

  // Staff (non-privileged) get a stripped create form — Material / Qty / Unit only
  // + one overall requisition total. Privileged roles keep the full stock/price
  // columns (On hand · Buffer, PUoM · Last ₹, per-line Notes).
  const simple = !canChangeDept;
  const createTotal = items.reduce((s, it) => {
    const m = materials.find(x => x.id === it.material_id);
    if (!m) return s;
    const pack = Number(m.pack_size) || 1;
    // reqPackFactor: ×pack only when requested in the purchase unit (1 BTL = pack recipe units).
    const factor = (it.unit && m.purchase_unit && it.unit === m.purchase_unit && it.unit !== m.unit && pack > 1) ? pack : 1;
    return s + (Number(it.quantity_requested) || 0) * factor * (m.average_price || 0);
  }, 0);

  // submitAfter=false → just save as draft. submitAfter=true → create then
  // immediately POST /submit so it lands in the Head Chef's inbox in one click.
  const save = async (submitAfter: boolean) => {
    if (!departmentId) {
      alert(canChangeDept
        ? 'Pick a department.'
        : 'Your user has no home department set. Ask an admin to assign one on /users.');
      return;
    }
    const cleaned = items.filter(i => i.material_id && i.quantity_requested > 0);
    if (cleaned.length === 0) { alert('Add at least one item'); return; }
    setSaving(true);
    try {
      // Editing a draft → PUT (replaces items on the existing requisition).
      // Creating → POST (unchanged behaviour). The submitted-to-chef id is the
      // draft's own id when editing, or the newly-created id when creating.
      const r = isEditing
        ? await api('/api/requisitions', {
            method: 'PUT',
            body: { id: editDraft!.id, date, department_id: departmentId, notes, items: cleaned },
          })
        : await api('/api/requisitions', {
            method: 'POST',
            body: { date, department_id: departmentId, notes, items: cleaned },
          });
      if (!r.ok) { alert((await r.json()).error || 'Failed'); return; }
      if (submitAfter) {
        const j = await r.json().catch(() => ({}));
        const targetId = isEditing ? editDraft!.id : j?.requisition?.id;
        if (targetId) {
          const s = await api(`/api/requisitions/${targetId}/submit`, { method: 'POST', body: {} });
          if (!s.ok) {
            const sj = await s.json().catch(() => ({}));
            alert('Saved as draft, but submit to HOD failed: ' + (sj.error || 'unknown') +
                  '\nYou can submit it from the requisition’s detail view.');
          }
        } else {
          alert('Saved as draft. Open it to submit to HOD.');
        }
      }
      onCreated(); onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      {/* maxHeight:none overrides the global mobile modal cap (globals.css §5,
          `max-height: calc(100vh-1rem)`). That cap has no overflow, so with many
          item lines the content spilled OUT of the white card. Letting the card
          grow keeps every line inside it — the overlay above (overflow-y-auto)
          scrolls the tall card — and, unlike an internal scroll, never clips the
          absolutely-positioned material dropdown. */}
      <div style={{ maxHeight: 'none' }}
           className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-3xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <h2 className="font-bold text-[#2D1B0E]">{isEditing ? 'Edit Draft Requisition' : 'New Department Requisition'}</h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              Date
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
            </label>
            <label className="text-xs text-[#6B5744] flex flex-col gap-1 sm:col-span-2">
              Department {!canChangeDept && <span className="text-[10px] text-blue-700">🔒 locked to your role</span>}
              {canChangeDept ? (
                <select value={departmentId} onChange={e => setDepartmentId(e.target.value)}
                        className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm">
                  <option value="">Select…</option>
                  {departments.map(d => <option key={d.id} value={d.id}>{d.code ? `[${d.code}] ` : ''}{d.name}</option>)}
                </select>
              ) : (
                // Read-only display — the staff/dept user can't request on behalf
                // of another department. Server also enforces this on POST.
                <input value={(() => {
                  const d = departments.find(x => x.id === departmentId);
                  return d ? `${d.code ? `[${d.code}] ` : ''}${d.name}` : '(no department assigned to your user)';
                })()}
                       readOnly
                       title="Internal requisitions are scoped to your home department. Admins / HODs / Store Managers can pick any."
                       className="px-2 py-1.5 border border-blue-200 rounded-lg bg-blue-50/40 text-sm text-[#6B5744] cursor-not-allowed" />
              )}
            </label>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-[#2D1B0E]">Items needed</h3>
              {/* Desktop keeps a quick top button; the primary one lives at the
                  bottom of the list so on mobile you always see it right after the
                  material you just added (rather than scrolled off the top). */}
              <button onClick={addLine} className="hidden md:flex text-xs text-[#af4408] hover:underline items-center gap-1">
                <Plus className="w-3 h-3" /> Add line
              </button>
            </div>
            <div className="space-y-2">
              {/* Column header — desktop only; on mobile each field carries its own
                  inline label so a cramped 12-col grid never hides the material name. */}
              <div className="hidden md:grid md:grid-cols-12 gap-2 text-[10px] uppercase tracking-wide text-[#8B7355] px-1">
                {simple ? (
                  <>
                    <div className="col-span-7">Material · Category</div>
                    <div className="col-span-4 text-right">Qty · Unit</div>
                    <div className="col-span-1"></div>
                  </>
                ) : (
                  <>
                    <div className="col-span-3">Material · Category</div>
                    <div className="col-span-2 text-right">On hand · Buffer</div>
                    <div className="col-span-2 text-right">Qty · Unit</div>
                    <div className="col-span-2 text-right">PUoM · Last ₹</div>
                    <div className="col-span-2">Notes</div>
                    <div className="col-span-1"></div>
                  </>
                )}
              </div>
              {items.map((it, i) => {
                const mat = materials.find(m => m.id === it.material_id);
                // Units the requester can pick: the recipe (base) unit + the
                // purchase unit if different. When they choose the purchase unit,
                // 1 of it = pack_size recipe units — so convert for the on-hand /
                // buffer warnings (which are shown in recipe units).
                const packSize = Number(mat?.pack_size || 1);
                // packFactor() rather than a local `packSize > 1`: the shared helper
                // carries BOTH halves of the guard (pack_size > 1 AND recipe unit ≠
                // purchase unit). The short test converted PICKLED GINGER 1.5KG
                // (kg/kg, pack 1.5, current_stock 6 kg — the ONLY live row with
                // pack_size > 1 and identical units, checked on a copy of the db), so
                // a 5 kg ask became 7.5 kg of recipe demand and falsely read short
                // against 6 kg on hand.
                const packConv = mat ? packFactor(mat) : 1;
                const inPurchaseUnit = !!mat && !!mat.purchase_unit && it.unit === mat.purchase_unit && packConv > 1;
                const reqRecipe = it.quantity_requested * (inPurchaseUnit ? packConv : 1);
                const short    = mat ? mat.current_stock < reqRecipe : false;
                const buffer   = Number(mat?.reorder_level || 0);
                const postReq  = mat ? (mat.current_stock - reqRecipe) : 0;
                const belowBuffer = mat && buffer > 0 && postReq < buffer;
                const pu = mat?.purchase_unit || mat?.unit || '';
                // ── "Last ₹" cell (below) — resolved HERE so the basis can be stated
                // once, in code, instead of inside a JSX ternary.
                //
                // NAME TRAP: this is NOT raw_materials.last_purchase_price. `materials`
                // is loaded from GET /api/inventory, which projects
                //   `SELECT rm.*, COALESCE((SELECT unit_price FROM purchases
                //      WHERE material_id = rm.id ORDER BY date DESC, created_at DESC
                //      LIMIT 1), 0) as last_purchase_price`
                // (api/inventory/route.ts:39-40). The alias comes AFTER rm.*, so it
                // overwrites the raw column in the returned row — checked against a copy
                // of the live db: CURD raw 86 → 80, MALA STRAWBERRY CRUSH 5 LTR raw
                // 0.13482 → 674.10. So the value is purchases.unit_price = ₹/PURCHASE
                // unit by canon, which is what the "/{pu}" suffix below prints.
                // rate-basis: purchase
                const lastPaidPerPU = Number(mat?.last_purchase_price) || 0;
                // Fallback = step 2 of the closing-valuation ladder: average_price is
                // ₹/recipe-unit, × packFactor lifts it to ₹/purchase-unit. packFactor()
                // rather than the inline `purchase_unit !== unit && packSize > 1` test
                // this replaced — the shared helper lower/trims both units, so 'Kg' vs
                // 'kg' can no longer be read as a real pack conversion and multiply the
                // rate by pack_size. Identical output on all 929 materials today (0 rows
                // differ only by case/whitespace); the change is to the latent rule.
                // rate-basis: purchase
                const lastRatePerPU = lastPaidPerPU > 0
                  ? lastPaidPerPU
                  : (mat ? (mat.average_price || 0) * packFactor(mat) : 0);
                // Tiny inline field label — mobile only (desktop uses the header row).
                const Lbl = ({ children }: { children: React.ReactNode }) => (
                  <div className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] mb-0.5">{children}</div>
                );
                return (
                  // Mobile: a stacked card (material name on its own full-width line,
                  // then On-hand / Qty / Last-₹ side by side, then Notes). Desktop
                  // (md+): the original single-line 12-col grid, unchanged.
                  <div key={i} className="rounded-lg border border-[#E8D5C4] bg-white p-3 space-y-2.5 text-xs
                                          md:rounded-none md:border-0 md:bg-transparent md:p-0 md:space-y-0
                                          md:grid md:grid-cols-12 md:gap-2 md:items-start">
                    {/* Material — full width on mobile (name never truncated); wider on
                        desktop for staff (fewer columns), col-3 for the full form. */}
                    <div className={simple ? 'md:col-span-7' : 'md:col-span-3'}>
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          {isEditing && it.material_id ? (
                            // Editing a draft: a chosen material is LOCKED (read-only text,
                            // no dropdown, no clear ×). To swap it, delete the line (trash)
                            // and add a new one — so only the current selection ever shows.
                            <div title="To change the material, delete this line and add a new one"
                                 className="w-full text-left px-2 py-1 text-xs border border-[#E8D5C4] rounded bg-[#F5EDE3] text-[#2D1B0E] break-words leading-snug cursor-not-allowed">
                              {mat?.sku && <span className="text-[#8B7355] font-mono">{mat.sku} — </span>}
                              <span>{mat?.name || '(material removed)'}</span>
                              {/* Locked chip = the SAME slot the typeahead occupies when not
                                  editing, so it must carry the SAME basis. `pu` is
                                  purchase_unit ?? unit — identical to the component's
                                  displayUnit(). It used to print mat.unit, so an edited draft
                                  read "(g)" while the freshly-picked chip read "(PKT)". */}
                              {pu && <span className="text-[#8B7355]"> ({pu})</span>}
                            </div>
                          ) : (
                            <MaterialTypeahead
                              materials={materials}
                              value={it.material_id}
                              // Owner rule: this composer counts in PURCHASE units — the
                              // On-hand cell two columns right already reads via
                              // toPurchaseQty, and onPick seeds the line unit with
                              // purchase_unit. Without this prop the dropdown's "on hand"
                              // printed the RECIPE figure (SALTED BUTTER 500 GM: "1,01,500 g"
                              // in the list, "203 PKT" on the row it fills) — the
                              // fix-one-cell-leave-the-sibling failure, on one screen.
                              // Every sibling mount (purchases, grn, wastage, transfers)
                              // passes it; /api/inventory carries purchase_unit + pack_size.
                              purchaseBasis
                              excludeIds={items.map(x => x.material_id).filter((id, idx) => id && idx !== i) as string[]}
                              onPick={(id) => { const m = materials.find(x => x.id === id); update(i, { material_id: id, unit: (m?.purchase_unit || m?.unit || '') }); }}
                            />
                          )}
                          {mat?.category && <div className="text-[9px] text-[#8B7355] mt-0.5">{mat.category}</div>}
                        </div>
                        {/* delete — inline on mobile (top-right of the card) */}
                        <button onClick={() => remove(i)} className="md:hidden text-red-500 shrink-0 pt-2" aria-label="Remove line"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </div>
                    {/* Numeric group: 3-up on mobile; on desktop `contents` lets each
                        block flow straight into the parent 12-col grid. */}
                    <div className={simple ? 'md:contents' : 'grid grid-cols-3 gap-2 md:contents'}>
                      {!simple && (
                      <div className="md:col-span-2 md:text-right text-[10px] leading-snug">
                        <Lbl>On hand · Buf</Lbl>
                        {mat ? (
                          <>
                            {/* On hand — purchase basis, via the SHARED resolver. This cell
                                used to re-derive the pack rule inline with a 2-dp formatter,
                                which (a) drifted from toPurchaseQty's 3 dp and (b) fell back
                                to the RECIPE unit whenever pack_size was 1 — so a pack-1
                                material bought by the bottle (unit 'pcs', purchase_unit 'BTL')
                                read "2,279 pcs" on a buy list that counts bottles. The number
                                is identical in both bases there; only the label was wrong. */}
                            <div className={`font-mono ${short ? 'text-red-700 font-semibold' : 'text-[#2D1B0E]'}`}
                                 title={`= ${mat.current_stock.toLocaleString('en-IN')} ${mat.unit} (exact)`}>
                              {`${fmtNum(toPurchaseQty(mat.current_stock, mat as any))} ${pu}`}
                            </div>
                            <div className={`font-mono ${belowBuffer ? 'text-red-700 font-semibold' : 'text-[#8B7355]'}`}
                                 title={belowBuffer
                                   ? `Will drop to ${fmtNum(toPurchaseQty(postReq, mat as any))} ${pu} (= ${postReq.toFixed(2)} ${mat.unit}), below buffer ${fmtNum(toPurchaseQty(buffer, mat as any))} ${pu}`
                                   : `Buffer / reorder level`}>
                              {/* reorder_level is stored in RECIPE units — read it in the
                                  same basis as the On-hand figure directly above it, or the
                                  two numbers on this row are not comparable. */}
                              buf: {buffer ? `${fmtNum(toPurchaseQty(buffer, mat as any))} ${pu}` : '—'}{belowBuffer && <span className="ml-1">⚠</span>}
                            </div>
                          </>
                        ) : <span className="text-[#8B7355]">—</span>}
                      </div>
                      )}
                      <div className={simple ? 'md:col-span-4' : 'md:col-span-2'}>
                        <Lbl>Qty · Unit</Lbl>
                        {simple ? (
                          // Staff: unit shown BOLD right beside the qty input.
                          <>
                            <div className="flex items-center gap-2">
                              <input type="number" step="any" min={0} value={it.quantity_requested || ''}
                                     onChange={e => update(i, { quantity_requested: Math.max(0, parseFloat(e.target.value) || 0) })}
                                     placeholder="Qty"
                                     className="flex-1 min-w-0 px-2 md:px-3 py-2 border border-[#E8D5C4] rounded text-right text-sm tabular-nums" />
                              {mat && (
                                <span className="text-sm font-bold text-[#2D1B0E] whitespace-nowrap" title="Ordering unit">
                                  {mat.purchase_unit || mat.unit}
                                </span>
                              )}
                            </div>
                            {mat && mat.purchase_unit && mat.purchase_unit !== mat.unit && packSize > 1 ? (
                              <div className="text-[10px] text-[#8B7355] mt-0.5 text-right whitespace-nowrap">= {packSize.toLocaleString('en-IN')} {mat.unit}</div>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <input type="number" step="any" min={0} value={it.quantity_requested || ''}
                                   onChange={e => update(i, { quantity_requested: Math.max(0, parseFloat(e.target.value) || 0) })}
                                   placeholder="Qty"
                                   className="w-full min-w-0 px-2 md:px-3 py-2 border border-[#E8D5C4] rounded text-right text-sm tabular-nums" />
                            {mat ? (
                              <div className="text-[10px] text-[#8B7355] mt-0.5 text-right whitespace-nowrap" title="Ordering unit (purchase unit)">
                                {mat.purchase_unit || mat.unit}{mat.purchase_unit && mat.purchase_unit !== mat.unit && packSize > 1 ? <span className="text-[#B99]"> = {packSize.toLocaleString('en-IN')} {mat.unit}</span> : ''}
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                      {!simple && (
                      <div className="md:col-span-2 md:text-right text-[10px] leading-snug">
                        <Lbl>PUoM · Last ₹</Lbl>
                        {mat ? (
                          <>
                            <div className="text-[#6B5744]">{pu}</div>
                            {/* unit-lock: the ₹ figure below is ₹/purchase-unit; this tooltip
                                deliberately exposes the STORED basis, ₹/recipe-unit, which is
                                what every money formula multiplies. Converting it would remove
                                the only auditable price on the row. */}
                            <div className="font-mono text-[#6B5744]"
                                 title={`avg ₹${(mat.average_price || 0).toFixed(4)}/${mat.unit}${mat.last_purchase_date ? ' · last bought ' + mat.last_purchase_date : ''}`}>
                              ₹{lastRatePerPU.toFixed(2)}
                              <span className="text-[#8B7355]">/{pu}</span>
                            </div>
                          </>
                        ) : <span className="text-[#8B7355]">—</span>}
                      </div>
                      )}
                    </div>
                    {/* Notes — full width on mobile, col-2 desktop. Hidden for staff
                        (their form is Material / Qty / Unit only). */}
                    {!simple && (
                    <div className="md:col-span-2">
                      <Lbl>Notes</Lbl>
                      <input value={it.notes} onChange={e => update(i, { notes: e.target.value })}
                             placeholder="Notes (optional)"
                             className="w-full px-2 py-2 md:py-1 border border-[#E8D5C4] rounded" />
                    </div>
                    )}
                    {/* delete — desktop only (mobile has the inline one above) */}
                    <button onClick={() => remove(i)} className="hidden md:block md:col-span-1 text-red-500 pt-1" aria-label="Remove line"><Trash2 className="w-3 h-3" /></button>
                  </div>
                );
              })}
            </div>
            {/* Primary Add-line — full width at the BOTTOM so after entering a
                material the button sits right below it (mobile-friendly). */}
            <button onClick={addLine} type="button"
                    className="mt-2 w-full flex items-center justify-center gap-1.5 py-2.5 border-2 border-dashed border-[#E8D5C4] rounded-lg text-sm font-medium text-[#af4408] hover:border-[#af4408] hover:bg-[#FFF1E3] active:bg-[#FFE8D5]">
              <Plus className="w-4 h-4" /> Add line
            </button>
          </div>

          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Notes / Justification
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                      placeholder="Why is this needed?"
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </label>

          {/* Overall requisition value — staff form only (privileged users see
              per-line prices instead). Σ qty × pack-factor × avg ₹/recipe-unit. */}
          {simple && (
            <div className="flex items-center justify-between border-t-2 border-[#D4B896] pt-3">
              <span className="text-sm font-semibold text-[#2D1B0E]">Requisition total</span>
              <span className="text-base font-mono font-semibold text-[#2D1B0E]">{fmt(createTotal)}</span>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex flex-wrap justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={() => save(false)} disabled={saving}
                  className="px-3 py-1.5 border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] text-sm rounded-lg disabled:opacity-50">
            {saving ? 'Saving…' : (isEditing ? 'Save Changes' : 'Save as Draft')}
          </button>
          <button onClick={() => save(true)} disabled={saving}
                  className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg disabled:opacity-50 inline-flex items-center gap-1">
            <Send className="w-3.5 h-3.5" /> {saving ? 'Working…' : 'Submit to HOD'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
function ChefApproveModal({ req, onClose, onDone }: { req: Requisition; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  // Per-line qty + reject toggle. Initial values reflect any pre-existing
  // chef edits (chef_approved_qty / is_rejected) from earlier approval passes.
  //
  // The box is ENTERED and READ in PURCHASE units (owner rule) but the API writes
  // the number into the line's own stored unit verbatim — so the draft is kept as
  // a RAW STRING in the purchase basis and converted back exactly ONCE, in submit().
  // Raw string, not a number: running every keystroke through Number() turns "2."
  // into "2" and makes decimals untypeable. Clamping happens where it is USED.
  const [overrides, setOverrides] = useState<Record<string, string>>(
    Object.fromEntries((req.items || []).map(it =>
      [it.id, String(lineUnits(it).toPU(it.chef_approved_qty ?? it.quantity_requested))]))
  );
  const [rejected, setRejected] = useState<Record<string, boolean>>(
    Object.fromEntries((req.items || []).map(it => [it.id, !!it.is_rejected]))
  );
  const [busy, setBusy] = useState(false);

  const allRejected = (req.items || []).length > 0 && (req.items || []).every(it => rejected[it.id]);

  const submit = async () => {
    if (allRejected) {
      alert('You\'ve rejected every line. Use the Reject button instead to reject the whole requisition.');
      return;
    }
    setBusy(true);
    // Two-phase: first push per-line is_rejected via the items PUT endpoint,
    // then call chef-approve to seal the qty overrides + flip the req status.
    // chef-approve treats qty=0 as "delete line", so rejected lines pass qty=1
    // (any positive number) on that call — the PUT already marked them rejected
    // so they're skipped downstream regardless.
    const itemsPutPromises = (req.items || []).map(it => {
      const isRej = !!rejected[it.id];
      const wasRej = !!it.is_rejected;
      // Only PUT lines whose reject state actually changed (avoids needless audit noise)
      if (isRej === wasRej) return Promise.resolve({ ok: true });
      return api(`/api/requisitions/${req.id}/items/${it.id}`, {
        method: 'PUT', body: { is_rejected: isRej },
      });
    });
    try {
      await Promise.all(itemsPutPromises);
    } catch (e: any) {
      alert(`Failed to apply line rejections: ${e?.message || 'unknown'}`);
      setBusy(false);
      return;
    }

    const item_overrides = (req.items || []).map(it => {
      const U = lineUnits(it);
      // The ONE conversion boundary: the box holds purchase units, the API stores
      // the line's own unit. Compare in the PURCHASE basis the chef was looking at —
      // an untouched value must never be re-posted through the 3-dp display figure
      // (fromPU(toPU(q)) !== q in general, e.g. 4,500 ml → 6 BTL → 4,500 ml is fine
      // but 146 g → 0.146 kg → 146 g only survives because of the 1e6 rounding).
      const serverQty = Number(it.chef_approved_qty ?? it.quantity_requested) || 0;
      const raw = overrides[it.id];
      // Clamp HERE, not in onChange: approving a NEGATIVE quantity would issue
      // stock backwards. Blank still means 0 → chef-approve deletes the line.
      const vPU = Math.max(0, Number(raw) || 0);
      const qty = vPU === U.toPU(serverQty) ? serverQty : U.fromPU(vPU);
      return {
        id: it.id,
        // For rejected lines: send qty 1 placeholder (chef-approve interprets
        // qty=0 as delete, which we don't want — we want the line preserved
        // with is_rejected=1 so the audit trail stays intact).
        quantity_requested: rejected[it.id] ? 1 : qty,
      };
    });
    const r = await api(`/api/requisitions/${req.id}/chef-approve`, { method: 'POST', body: { note, item_overrides } });
    if (!r.ok) { alert((await r.json()).error || 'Failed'); setBusy(false); return; }
    onDone();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <h2 className="font-bold text-[#2D1B0E]">HOD Approve — {req.req_number}</h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-5 space-y-3 text-xs">
          <p className="text-[#6B5744]">
            Adjust quantities or reject individual lines. Rejected lines are kept on the requisition
            (with a "Rejected by Chef" badge) so the audit trail is preserved — they're skipped
            during store issue.
          </p>
          <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[#8B7355]"><tr>
              <th className="text-left py-1 px-2 font-medium">Material</th>
              <th className="text-right py-1 px-2 font-medium">Requested</th>
              <th className="text-right py-1 px-2 font-medium">Approve Qty</th>
              <th className="text-center py-1 px-2 font-medium" title="Reject this line entirely">Reject</th>
            </tr></thead>
            <tbody>
              {(req.items || []).map(it => {
                const isRej = !!rejected[it.id];
                // Owner rule: this grid READS and is ENTERED in purchase units.
                const U = lineUnits(it);
                // Takes a qty in the line's STORED unit — same signature as the
                // detail table's hint, so the two can't drift.
                const hint = (q: number) => U.pf > 1
                  ? <div className="text-[9px] text-[#B8A590] font-normal no-underline">= {fmtNum(U.toRecipe(q))} {U.recipeUnit}</div>
                  : null;
                // What is in the box right now, back on the stored basis, so the
                // hint tracks typing. Display-only — submit() does its own convert.
                const liveStored = U.fromPU(Math.max(0, Number(overrides[it.id]) || 0));
                return (
                  <tr key={it.id} className={`border-t border-[#E8D5C4]/50 ${isRej ? 'opacity-50 line-through bg-red-50/30' : ''}`}>
                    <td className="py-1 px-2">{it.material_name}</td>
                    <td className="py-1 px-2 text-right font-mono text-[#6B5744]">
                      {fmtNum(U.toPU(it.quantity_requested))} {U.pu}
                      {hint(it.quantity_requested)}
                    </td>
                    <td className="py-1 px-2">
                      {/* Entered in PURCHASE units — submit() converts back to the
                          line's stored unit once. min= stops the spinner walking
                          past zero; the typed/pasted minus is stripped here and the
                          value is clamped at USE, so "2." stays typeable. */}
                      <input type="number" step="any" min={0} value={overrides[it.id] ?? ''}
                             disabled={isRej}
                             onChange={e => setOverrides(p => ({ ...p, [it.id]: e.target.value.replace(/^-/, '') }))}
                             title={`Enter in ${U.pu || 'units'}`}
                             className="w-24 px-1.5 py-1 border border-[#E8D5C4] rounded text-right disabled:opacity-50" />
                      <span className="ml-1 text-[10px] text-[#8B7355]">{U.pu}</span>
                      {hint(liveStored)}
                    </td>
                    <td className="py-1 px-2 text-center no-underline">
                      <input type="checkbox" checked={isRej}
                             onChange={e => setRejected(p => ({ ...p, [it.id]: e.target.checked }))} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Approval note (optional)
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]" />
          </label>
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={busy}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg disabled:opacity-50">
            {busy ? 'Approving…' : 'Approve & forward to Store'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/* Phase 1 §2 — Management approves a chef-approved requisition */
/* ============================================================ */
function MgmtApproveModal({ req, onClose, onDone }: { req: Requisition; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await api(`/api/requisitions/${req.id}/mgmt-approve`, { method: 'POST', body: { note } });
    if (!r.ok) { alert((await r.json()).error || 'Failed'); setBusy(false); return; }
    onDone();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] bg-indigo-50 flex items-center justify-between">
          <h2 className="font-bold text-indigo-900">Management Approve — {req.req_number}</h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-5 space-y-3 text-xs">
          <p className="text-[#6B5744]">
            2nd-stage approval. Chef has already signed off on the items + quantities.
            On approval, the requisition moves to the Store Manager's queue for processing.
          </p>
          <div className="text-xs text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
            <div><b>Department:</b> {req.department_name}</div>
            <div><b>Items:</b> {(req.items || []).length}</div>
            {req.chef_note && <div className="mt-1"><b>Chef note:</b> "{req.chef_note}"</div>}
          </div>
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Mgmt note (optional)
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]" />
          </label>
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={busy}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-lg disabled:opacity-50">
            {busy ? 'Approving…' : 'Approve & forward to Store'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChefRejectModal({ req, onClose, onDone }: { req: Requisition; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!reason.trim()) { alert('Reason required'); return; }
    setBusy(true);
    const r = await api(`/api/requisitions/${req.id}/chef-reject`, { method: 'POST', body: { reason } });
    if (!r.ok) { alert((await r.json()).error || 'Failed'); setBusy(false); return; }
    onDone();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4">
      <div className="bg-white rounded-xl border border-red-200 w-full max-w-md my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-red-200 bg-red-50 flex items-center justify-between">
          <h2 className="font-bold text-red-800">Reject — {req.req_number}</h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-5 space-y-3 text-xs">
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Reason for rejection (required)
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
                      placeholder="e.g. Already have enough on hand; over-ordering."
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]" />
          </label>
          <div className="flex gap-1 flex-wrap">
            {['Already have on hand', 'Over-ordering', 'Use existing stock first', 'Wrong item'].map(t => (
              <button key={t} onClick={() => setReason(t)} className="text-[10px] px-2 py-0.5 bg-[#FFF1E3] border border-[#E8D5C4] rounded hover:bg-[#E8D5C4]">{t}</button>
            ))}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-red-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={busy}
                  className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg disabled:opacity-50">
            {busy ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/* Store Process — heart of the workflow                         */
/* ============================================================ */
function StoreProcessModal({ req, onClose, onDone }: { req: Requisition; onClose: () => void; onDone: () => void }) {
  // Issue + (optional) PO workflow.
  //
  // Default: pure issuance — record what was handed to the department, no
  // vendor side-effect. Store managers raise POs on /purchase-orders.
  //
  // Opt-in: store manager ticks "Also raise a vendor PO" →
  // backend `auto_create_po: true` flag is sent → for any line with
  // quantity_to_purchase > 0, a single vendor PO is auto-created in `pending`
  // and goes to the admin's PO approval queue. Vendor + unit price fields
  // appear per-line ONLY when this checkbox is on.
  // Reject-aware line list:
  //   1) Drop chef-rejected lines entirely — the store should never see them
  //      here, and they're tagged "Rejected by Chef" in the read-only detail
  //      table for audit. Issuing or buying a rejected item would defeat the
  //      whole point of the chef's rejection.
  //   2) Use chef_approved_qty (when set) as the effective demand instead of
  //      quantity_requested. The store works off what the chef approved, not
  //      what the dept originally asked for.
  const visibleItems = (req.items || []).filter(it => !it.is_rejected);
  const rejectedCount = (req.items || []).length - visibleItems.length;
  /** A party requisition's goods move on the party rail, so the central-stock
   *  floor the server added does not apply to ANY of its lines (applyIssueDelta
   *  carves purpose === 'party' out before the debit). Resolved once, from the
   *  same field the party banner below keys on, and read by the seed and by
   *  every cap/warning — so the screen cannot cap one and exempt the other. */
  const isPartyReq = String(req.purpose || '') === 'party';
  const [lines, setLines] = useState(() =>
    visibleItems.map(it => {
      // effective demand is in the REQUESTED unit (ri.unit — may be the purchase
      // unit like BTL); chef_approved_qty is edited in that same unit.
      const effective = (it.chef_approved_qty != null && it.chef_approved_qty > 0)
        ? Number(it.chef_approved_qty)
        : it.quantity_requested;
      // requested-unit → recipe-unit factor (1 BTL = pack_size recipe units).
      const reqFactor = reqPackFactor(it);
      // THE BOOK BALANCE IS THE CAP AGAIN — BECAUSE THE SERVER MAKES IT ONE.
      //
      // current_stock is the STORE's book figure, in RECIPE units. This seed
      // used to relax to the FULL APPROVED DEMAND the moment that figure hit 0
      // or below, on the reasoning that the books had stopped describing the
      // shelf. That reasoning is now moot: src/lib/issue-stock.ts
      // (assertCentralIssue) REFUSES a debit that would take current_stock
      // below zero, and both issue routes refuse the whole gesture before their
      // transaction even opens. So the old relaxation pre-filled a number the
      // server answers with a 400 — measured over the 16,353 live lines this
      // grid can render, the old seed is refusable on 862 of them.
      //
      // The old comment's real warning still stands and is NOT being undone: a
      // cap of 0 must not turn into vendor spend for goods already on the
      // premises. Two things keep that from happening now and neither existed
      // when it was written — the Buy box is re-derived live (autoBuyQty) rather
      // than frozen from this seed, and it only becomes a VALUE once a vendor is
      // picked (buyStr); until then the shortfall is a grey placeholder that
      // orders nothing. What is left is a blank Issue box next to a banner that
      // says what the store's books hold and that the way out is a received
      // delivery or a recorded closing count — not a PO.
      //
      // WHAT THE SERVER WILL NOT REFUSE, so this seed must not either:
      //   · A PARTY requisition. applyIssueDelta carves it out (the goods move
      //     on the party rail), so checkCentralIssue reports debits:false and
      //     the central balance never gates it. `req.purpose` is on the payload,
      //     so this one the screen KNOWS — keep the full demand, exactly as
      //     today. 1 live line is in this state.
      //   · A LIQUOR / store-mapped line, carved out the same way. The screen
      //     CANNOT know which those are — the category→store map lives in
      //     store_category_map and this page has no endpoint for it, and
      //     guessing would be a second copy of a server rule (see the note
      //     above the paragraph further down). 156 live lines sit at a central
      //     balance of 0 and would be issued happily by the server. They are
      //     why nothing below LOCKS or BLOCKS: the box stays typeable, the
      //     submit button stays live, and the banner names the exception. A cap
      //     the screen cannot be sure of is a suggestion, never a gate.
      //   · A line that ALREADY carries an issue. The server's own ceiling is
      //     max(before, before + available) — a credit is not its business — so
      //     a seed below `alreadyIssued` would silently hand stock BACK on a
      //     desk that writes quantity_issued absolutely. 0 live lines in the two
      //     statuses this modal opens on are in that state (and 0 ever have
      //     been), so this is the compatibility floor, not a live case.
      //
      // Stock is in RECIPE units — convert to requested units before comparing
      // (floor when packs: you can't hand over 0.4 of a bottle against a BTL ask).
      // That floor is kept verbatim: it only ever seeds LESS than the server
      // allows, and the server's own 6-dp ceiling is what the validation below
      // compares against, so the screen never claims a refusal the server
      // would not make.
      const stockKnown = stockIsKnown(it);
      const bookStock = Number(it.current_stock) || 0;
      const stockInReqUnits = reqFactor > 1 ? Math.floor(bookStock / reqFactor) : bookStock;
      const alreadyIssued = Math.max(0, Number(it.quantity_issued) || 0);
      // Unknown balance (an older payload that does not project current_stock)
      // is NOT zero: treating it as zero would seed a blank box on every line in
      // the grid and tell the storekeeper the store holds nothing. It leaves the
      // check UNARMED, which the amber panel below says out loud.
      // A PARTY line (round 8b) is NOT exempt from the balance on this desk: the
      // party transfer runs on this very submit whenever no PO is raised
      // (store-process 3a) and is bounded by the same floor, all-or-nothing, so
      // the full demand over a short shelf was refused whole — THREE MANGO
      // 14.843 kg over 14,842.4 g seeded 14.843, printed "✓ Every line fully
      // issued", and answered 400 (round-8 verifier, md_party_seeded). It is
      // seeded at what the transfer accepts: the demand when it fits (the
      // shown-figure rule included), otherwise the server's own cap on the
      // line's total — the balance's shown figure, which takes everything the
      // store holds (and closes the line by THE RULE when less than one printed
      // step is left owing).
      const partySeed = (() => {
        if (!isPartyReq || !stockKnown || Number((it as any).central_flow_blocked || 0)) return effective;
        const meta = { unit: it.material_unit, purchase_unit: it.material_purchase_unit, pack_size: it.material_pack_size };
        const ask = Math.round(effective * reqFactor * 1e6) / 1e6;
        const plan = planDeskDebit(bookStock, ask, meta);
        if (plan.fits) return effective;
        const pfm = packFactor(meta);
        const gAvail = Math.round(Math.max(0, bookStock) * 1e6);
        return plan.shownAvailable > 0
          ? Math.round((plan.shownAvailable * pfm / reqFactor) * 1e6) / 1e6
          : gAvail > 0 ? (gAvail / 1e6) / reqFactor : 0;
      })();
      const issuable = isPartyReq ? partySeed
        : !stockKnown ? effective
        : Math.max(alreadyIssued, Math.min(effective, alreadyIssued + Math.max(0, stockInReqUnits)));
      // (There used to be a `const shortfall = effective - issuable` here, frozen
      //  into the Buy box below. See the note above buyInPurchaseUnit.)
      // Purchase-unit metadata so the PO math can switch between recipe-unit
      // (kg / ml / pcs) and purchase-unit (BTL / PKT / CASE) entry. pack_size
      // is recipe-units per purchase-unit (e.g. 750 ml in 1 BTL).
      const purchaseUnit = (it as any).material_purchase_unit || it.material_unit || '';
      const packSize     = Number((it as any).material_pack_size) || 1;
      // Recipe-units per purchase-unit under the canon guard: a real conversion
      // needs BOTH pack_size > 1 AND a recipe unit that differs from the purchase
      // unit. packFactor() is that guard; PO-receive applies the identical test to
      // the stock credit (api/purchase-orders/[id]/receive line `isPack`), so what
      // we order here and what receive credits can never disagree. pack_size > 1
      // alone would under-order by pack for a material bought AND cooked in kg.
      const packConv = packFactor({ unit: it.material_unit, purchase_unit: purchaseUnit, pack_size: packSize });
      // Vendors quote per purchase-unit. Default the PO line to that unit when
      // there is a real pack conversion; otherwise the recipe-unit IS the
      // purchase-unit and the distinction doesn't matter.
      const buyInPurchaseUnit = packConv > 1;
      // NOTE: the Buy qty is NOT frozen here any more — see autoBuyQty() below.
      // `effective − issuable` is still the figure the box opens on (autoBuyQty
      // returns exactly that while Issue Now is untouched), but it is now
      // RE-DERIVED on every render from `requested − Issue Now`, which is the
      // same subtraction the Shortfall COLUMN has always printed. Frozen, it
      // disagreed with the column standing next to it the moment the storekeeper
      // typed a smaller Issue Now: the column said "16 kg short", the Buy box
      // stayed blank, and the submit button greyed out. Measured over all 16,353
      // live requisition lines, the frozen seed filled the box on 137 of them
      // (0.8%) — it is 0 both when the store has enough AND (via the
      // deliberate relaxation above) when the book balance is at or below zero.
      // PRICE BASES (canon): last_purchase_price is ₹ per PURCHASE unit
      // (PO-receive + db backfill write it that way); average_price is ₹ per
      // RECIPE unit. The old code asserted the opposite and multiplied lpp by
      // pack_size again — a 500 g line estimated at ₹89,825 instead of ₹89.82.
      //
      // AND THE FIELD IS SAFE HERE DESPITE THE NAME, which is the thing to check
      // before reusing this pattern. `req` is the detail payload from GET
      // /api/requisitions?id= (fetched at page.tsx:950), whose items SELECT
      // projects `(SELECT unit_price FROM purchases WHERE material_id = rm.id
      // ORDER BY date DESC, created_at DESC LIMIT 1) AS last_purchase_price`
      // (api/requisitions/route.ts:92). It is an ALIAS over purchases.unit_price —
      // ₹/purchase-unit by canon — not raw_materials.last_purchase_price, which is
      // stored in mixed bases (CURD 86 where ₹/g truth is 0.086) and may never be
      // valued from. Same ladder as src/lib/closing-valuation.ts materialRate():
      // latest purchases.unit_price first, average_price × packConv second.
      // rate-basis: purchase
      const lpp = Number((it as any).last_purchase_price) || 0;
      // Driven by the SAME canon guard as the qty above — the two bases only
      // diverge when the pack conversion is real, so one test must decide both
      // or a line's price and qty end up on opposite bases.
      const buyUnitPrice = buyInPurchaseUnit
        ? (lpp || (it.average_price || 0) * packConv)     // entry is ₹/purchase-unit
        : (lpp || it.average_price || 0);                 // recipe unit IS the purchase unit → same basis
      // ONE unit resolver per line, built HERE because the seed is the only
      // place the ReqItem is in scope. Every cell below and the submit boundary
      // read this same object, so the issue grid can never disagree with the
      // approve grid / detail table about what "1 PKT" means.
      const U = lineUnits(it);
      return {
        id: it.id,
        material_id: it.material_id,         // needed to look up mapped vendors
        material_name: it.material_name,
        /** Shelf this item lives on. Carried onto the line ONLY so this grid can
         *  be grouped the same way the read-only Store Inbox table and
         *  /store-requisitions are — the store person picks off this grid, and
         *  three renderings of one requisition in three different orders is the
         *  thing the grouping was asked for to stop. Presentation only: nothing
         *  in the PO math, the POST body or any total reads it. */
        material_category: it.material_category,
        material_unit: it.material_unit,     // recipe unit (canonical)
        req_unit: reqUnit(it),               // unit the dept requested in — requested/issued qtys are STORED in THIS unit
        /** requisition_items.unit RAW (no fallback) — what the server's
         *  lineFactor reads; the take forecast (desk-rule.ts) needs it to tell
         *  a blank unit (needsReview, no take forecast) from a recipe-unit line. */
        line_unit: it.unit ?? '',
        /** 1 for a liquor / store-mapped material (round 8b) — the take
         *  forecast says nothing about it (desk-rule.ts). */
        central_flow_blocked: Number((it as any).central_flow_blocked || 0),
        U,                                   // purchase-unit view of req_unit (display only — see lineUnits)
        purchase_unit: purchaseUnit,         // vendor-facing unit
        pack_size: packConv,                 // recipe-units per purchase-unit, canon-guarded (1 = no real conversion, so every `pack_size > 1` test below is the full guard)
        /** Recipe-units per REQUESTED unit (pack when the dept asked in BTL, else
         *  1). Kept on the line so autoBuyQty() can reproduce the seed's own
         *  conversion expression verbatim instead of re-deriving it from U — the
         *  two agree on every live row, but a Buy qty is money and it must be
         *  the SAME arithmetic, not an equivalent one. */
        req_factor: reqFactor,
        current_stock: it.current_stock,     // keep raw value for the warning render
        /** Was current_stock on the payload at all? Separates "the books say 0"
         *  (cap to 0) from "we were not told" (do not cap, say so). */
        stock_known: stockKnown,
        /** quantity_issued as it stood when the modal opened — the server's
         *  `beforeLineQty`. The central ceiling is max(before, before +
         *  available), never below it, so this keeps a cap from reversing an
         *  issue that already happened. 0 on every live line this modal can
         *  open on. */
        already_issued: alreadyIssued,
        requested: effective,                // chef-approved demand, not raw request
        /** STORED-basis seed. Posted VERBATIM while the box still reads its own
         *  seeded purchase figure — fromPU(toPU(q)) is not the identity, so a
         *  quantity nobody touched must never round-trip through the display. */
        issued_seed: issuable,
        /** What the store user types: PURCHASE units (owner rule), held as a RAW
         *  STRING. Number() on every keystroke turns "2." into "2" and makes
         *  decimals untypeable — clamp where the value is USED, not on change. */
        issued_pu: U.toPU(issuable) > 0 ? String(U.toPU(issuable)) : '',
        // PO-only fields, hidden until raisePo is ticked. These are ALREADY on
        // the purchase basis (po_entry_unit names it) — raw strings for the same
        // typing reason, but no basis change: the PO side is not re-converted.
        /** The storekeeper's OVERRIDE of the Buy qty. Empty + buy_touched false
         *  means "follow the shortfall" (autoBuyQty). Read it through buyStr(),
         *  never directly, or the box goes back to being a frozen snapshot. */
        quantity_to_purchase: '',
        /** True once the Buy box has been typed in — including CLEARED to blank,
         *  which is how a storekeeper says "do not order this line". Without the
         *  flag a cleared box would silently refill itself from the shortfall. */
        buy_touched: false,
        unit_price: buyUnitPrice > 0 ? String(buyUnitPrice) : '',
        /** Unit the user is entering qty + price in. Drives both the column
         *  labels and the on-submit conversion, which normalises a recipe-unit
         *  entry UP to the PO's purchase-unit basis (never the other way). */
        po_entry_unit: buyInPurchaseUnit ? purchaseUnit : (it.material_unit || ''),
        vendor: '',
        vendor_id: '',
      };
    })
  );
  // Lines whose central BOOK balance is BELOW zero — a data-quality fact, kept
  // separate from "the store cannot cover this line" because the remedy is
  // different: a negative book means issues have outrun recorded purchases and
  // a physical count has to re-base central.
  //
  // IT IS NO LONGER "REPORTING ONLY". That sentence used to end this comment
  // and it is now false: the server refuses a debit that would take
  // current_stock below zero, so the book balance gates every ordinary line.
  // What the banner below must therefore do is say what the store CAN give and
  // why the rest cannot be issued — not merely flag the deficit.
  const negativeStockLines = lines.filter(ln => Number(ln.current_stock) < 0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [raisePo, setRaisePo] = useState(false);
  /* The server's own answer to the last submit. Set on a 200 and rendered as a
     result panel INSTEAD of the form — the modal no longer closes itself, so a
     report about lines that were not ordered cannot be swept away by the same
     click that submitted them. onDone() (close + reload) is on the Done button. */
  const [result, setResult] = useState<any | null>(null);
  /* A refused submit (400). Nothing was written, so the form stays exactly as it
     is and the named rows are outlined — every 400 from store-process carries a
     `code` plus the req_item_id(s) it is about. */
  const [errorText, setErrorText] = useState('');
  const [errorRows, setErrorRows] = useState<Set<string>>(new Set());
  /* The server's per-line refusal rows from a `blocked[]` answer, keyed by
     req_item_id. Rendered against the named line instead of an alert(), and
     read by the cap below — a refusal carries max_issue_qty, which is a FRESHER
     reading of the balance than the snapshot this modal opened with. */
  const [blockedRows, setBlockedRows] = useState<Record<string, ServerBlock>>({});
  const [poDate, setPoDate] = useState(new Date().toISOString().slice(0, 10));
  // Deliberately BLANK, unlike poDate. Defaulting this to today would put an
  // invented delivery promise on the vendor PO that nobody agreed to, and the
  // GRN/ageing screens would then chase the vendor against a date we made up.
  const [poDeliveryDate, setPoDeliveryDate] = useState('');

  // Vendor lookup state — only fetched when the PO checkbox is ticked, so the
  // modal stays light when the store user is just issuing items.
  //   allVendors : every active vendor (fallback dropdown options)
  //   vmIdx      : the WHOLE vendor↔item map, one payload
  //
  // WHY THE WHOLE MAP AND NOT ONE FETCH PER LINE. The previous version asked
  // /api/vendor-materials?material_id= only for lines whose Buy qty was ALREADY
  // seeded above 0, with deps [raisePo] so it never re-ran when the storekeeper
  // typed one afterwards. On 99.2% of live requisitions no line seeds a Buy qty
  // (see autoBuyQty), so `vendorsByMaterial` stayed permanently empty and every
  // Vendor dropdown fell through to "All active vendors" while its tooltip
  // asserted "No mapped vendors yet" — false for BANGLORE TOMATO, which is
  // mapped to TARKARI. The one control that steers the storekeeper to a vendor
  // the SERVER will accept was switched off and then denied existing.
  // ?index=1 answers every line in a single request (same endpoint and same
  // rows the /purchase-orders composer reads, so the two screens agree), and it
  // also names the vendors that carry no item list at all.
  const [allVendors, setAllVendors] = useState<{ id: string; name: string }[]>([]);
  const [vmIdx, setVmIdx] = useState<{
    by_vendor?: Record<string, string[]>;
    vendor_names?: Record<string, string>;
    vendors_no_items?: Array<{ id: string; name: string }>;
  } | null>(null);
  const [vmError, setVmError] = useState('');
  useEffect(() => {
    if (!raisePo) return;
    // Active vendors — always fetched once when the box is ticked.
    if (allVendors.length === 0) {
      fetch('/api/vendors').then(r => r.json()).then(j => {
        setAllVendors((j.vendors || []).filter((v: any) => v.is_active).map((v: any) => ({ id: v.id, name: v.name })));
      }).catch(() => {});
    }
    if (vmIdx) return;
    fetch('/api/vendor-materials?index=1')
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        return r.json();
      })
      .then(j => { setVmIdx(j || {}); setVmError(''); })
      // FAILS OPEN, unlike the /purchase-orders composer. There the server 400s
      // an unmapped pair, so hiding the list until it loads costs nothing; HERE
      // the server DROPS the line and records the issue anyway, so refusing to
      // show vendors would strand a storekeeper mid-hand-over over a lookup that
      // is only ever advisory. The warnings below all test `vmReady` first and
      // simply go quiet when it is false.
      .catch(e => { setVmIdx(null); setVmError(e?.message || 'Could not load the vendor → item mapping.'); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raisePo]);

  /** Vendors mapped to each material, inverted out of the one index payload.
   *  Same rows /api/vendor-materials?material_id= returns (both read
   *  vendor_materials joined to vendors), so no vendor appears or disappears
   *  relative to the previous per-material fetch — only the coverage changes. */
  const vendorsByMaterial = useMemo(() => {
    const m: Record<string, { id: string; name: string }[]> = {};
    const names = vmIdx?.vendor_names || {};
    for (const [vid, mids] of Object.entries(vmIdx?.by_vendor || {})) {
      for (const mid of mids) (m[mid] ||= []).push({ id: vid, name: names[vid] || vid });
    }
    for (const list of Object.values(m)) list.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [vmIdx]);
  /** Active vendors with NO item list at all — 20 of 59 on this database. Every
   *  PO line naming one of them is refused by the server, whatever the item. */
  const vendorsNoItems = useMemo(
    () => new Set((vmIdx?.vendors_no_items || []).map(v => v.id)),
    [vmIdx]);
  const vmReady = !!vmIdx;

  const update = (i: number, patch: any) => {
    // Any edit invalidates the last refusal: the sentence named a row and a
    // value that no longer describe the form, and a stale red banner over a
    // corrected grid is how a storekeeper stops reading red banners.
    //
    // `blockedRows` DELIBERATELY SURVIVES. The banner is about a QUANTITY that
    // has just been corrected; those rows carry a BALANCE, which has not
    // changed and is a fresher reading than the snapshot this modal opened
    // with (it is why a refusal from the write-lock race leaves the grid more
    // accurate, not less). The server's own sentence is only rendered while the
    // box still exceeds that balance, so it clears itself the moment the number
    // is right — and the ceiling stays correct meanwhile. Dropping it would
    // walk the cap back to the stale figure and invite the same refusal twice.
    if (errorText) { setErrorText(''); setErrorRows(new Set()); }
    setLines(p => p.map((ln, j) => j === i ? { ...ln, ...patch } : ln));
  };

  type Line = (typeof lines)[number];
  /**
   * Live issued qty back in the LINE's STORED unit. The box holds purchase
   * units, but everything downstream — shortfall, the over-issue test and the
   * POST body — is stored-basis, and store-process persists the number verbatim.
   *
   * THE conversion boundary, crossed exactly once. An UNTOUCHED box must post
   * the server's own number: compare in the purchase basis the store user is
   * looking at, and convert only a figure they actually changed (4,500 ml →
   * 6 BTL → 4,500 ml survives, but a 3-dp display figure in general does not).
   */
  const issuedOf = (ln: Line) => {
    // Clamp HERE, not in onChange: a negative issue would hand stock backwards.
    const vPU = Math.max(0, Number(ln.issued_pu) || 0);
    return vPU === ln.U.toPU(ln.issued_seed) ? ln.issued_seed : ln.U.fromPU(vPU);
  };
  /** What is still short on this line, in the line's STORED unit — the exact
   *  subtraction the Shortfall column prints (`requested − Issue Now`). */
  // THE TAKE'S OWN BALANCE where the take is not the figure (round 8b): 20 kg
  // approved, 14.842 typed over 14,842.4 g takes 14,842.4 g and records
  // 14.8424, so 5,157.6 g is owed — "requested − typed" printed 5,158 g.
  // owingLine is 0 on a line THE RULE closes.
  // A HELD line (heldOf, round 9) keeps "requested − typed" HERE on purpose:
  // this figure is what the Buy box follows, and a held line's rest is issued
  // later from the shelf on Issue Requisitions — following the whole
  // outstanding would order the shelf's own stock from a vendor. What the line
  // still owes after this submit is printed beside it instead (the Shortfall
  // cell's held note).
  const shortOf = (ln: Line) => {
    const tk = takeOf(ln);
    return tk ? tk.owingLine : Math.max(0, ln.requested - issuedOf(ln));
  };

  /* ──────────────────────────────────────────────────────────────────────────
   * THE CENTRAL CAP — THE SCREEN'S COPY OF THE SERVER'S FLOOR.
   *
   * The server will not let an issue take raw_materials.current_stock below
   * zero (src/lib/issue-stock.ts checkCentralIssue / assertCentralIssue). Since
   * round 4 store-process does not refuse the gesture for it: every line the
   * books cover is issued and the short line is HELD — its quantity_issued is
   * left as it was and it stays outstanding (`held_lines` on the 200). Only a
   * gesture in which not one line can hand anything over is refused whole, with
   * a 400 and nothing written.
   * This is the SAME ARITHMETIC asked on the client so the storekeeper is told
   * before the round trip instead of after — a courtesy, NOT a guard. The
   * server is the authority; everything here is advisory and nothing here
   * blocks a submit.
   *
   * IT IS DELIBERATELY NOT A GATE, and the reason is measured: 156 live lines
   * are liquor / store-mapped materials sitting at a central balance of 0 that
   * the server issues happily (applyIssueDelta carves them out — their stock
   * moves on the Liquor Store ledger), and this page cannot tell which lines
   * those are. Blocking on the client would stop 156 real hand-overs to protect
   * a rule the server already enforces for itself. So: warn, never lock.
   *
   * THE SAME CEILING EXPRESSION THE SERVER USES, so the two cannot disagree:
   *   max(before, before + available)      where available = max(0, stock)
   * `max(0, …)` on the balance is what makes an ALREADY-negative book read as
   * "nothing issuable" instead of as a negative allowance that digs deeper, and
   * the `before` floor is why a cap can never reverse an issue that happened.
   *
   * AND THE SAME "FITS" (round 6). The rule is decided ONCE, server-side, in
   * src/lib/central-debit-clamp.ts planCentralDebit ("THE SHOWN FIGURE IS THE
   * BALANCE"): an ask whose SHOWN figure equals the balance's shown figure, and
   * that figure is above 0, is "all of it" — it fits and lands on exactly 0.
   * checkCentralIssue hands it shownPurchaseQty (round 8: the grid point, then
   * integer half-up; toPurchaseQty renderings still matched), which is
   * U.stockPU here — the "In Stock" column's own number. That file imports the database,
   * so it cannot be bundled into this page; `wouldHold` below asks the SAME two
   * questions in the same order on the same converter (grid fit, then shown
   * figure) and cites it, rather than deciding anything of its own. Before
   * round 6 this cap FLOORED the balance to 3 dp, which printed 14.842 kg next
   * to an In Stock of 14.843 kg and called the column's own figure a refusal —
   * the server now accepts that figure and takes the 0.5 g with it.
   *
   * UNITS, which is where a clamp like this kills people: current_stock is a
   * MATERIAL-level RECIPE figure. `req_factor` converts the LINE's unit to
   * recipe units (the same factor the server's lineFactor returns for this
   * row), so the ceiling comes back in the LINE's own unit — what the Issue box
   * holds. Printing it needs the PURCHASE unit (owner rule), which is
   * U.stockPU() for a material figure and U.toPU() for a line figure; the two
   * agree on this number by construction, and the pack-floored SEED above is
   * the only place a whole-pack floor is applied.
   * ────────────────────────────────────────────────────────────────────────── */
  const EPSQ = 1e-9;
  /** The house quantity grid — central-debit-clamp.ts qtyGrid(): a RECIPE
   *  quantity as a whole count of 6-dp steps. Two quantities with the same
   *  grid6() are the same quantity to every floor in the app. */
  const grid6 = (n: number) => { const v = Math.round((Number(n) || 0) * 1e6); return v === 0 ? 0 : v; };
  const centralCapOf = (ln: Line) => {
    const srv = blockedRows[ln.id];
    // ARMED only when the screen genuinely knows the balance. A party
    // requisition is EXEMPT by the server's own rule, so there is nothing to
    // cap; an unknown balance leaves the cap off rather than guessing 0.
    // A PARTY line is floored by the TRANSFER (round 8b), which runs on this
    // submit whenever no vendor PO is raised (store-process 3a) and moves the
    // line's WHOLE quantity from 0 — so its base is 0, not what the line held
    // before. transferRuns() is that trigger, read the way the server reads it
    // (round 9): the PO box ticked with no Buy qty raises no PO, so the
    // transfer runs and floors the line exactly as with the box unticked. Only
    // a submit that really raises a PO leaves the transfer for a later gesture.
    // A liquor / store-mapped PARTY line is declined by the transfer, never
    // refused, so it is exempt too (central_flow_blocked, round 8b). An
    // internal one keeps its round-6 advisory cap and words: its seed is
    // capped to the books, and the banner is what explains the blank box.
    const exempt = isPartyReq && (!transferRuns() || !!ln.central_flow_blocked);
    const armed = !exempt && (ln.stock_known || !!srv);
    const base = isPartyReq ? 0 : ln.already_issued;
    const availRecipe = Math.max(0, Number(ln.current_stock) || 0);
    const factor = ln.req_factor || 1;
    const pf = ln.U.pf || 1;
    /* ── THE BOOKS' CAP, FIELD FOR FIELD AS checkCentralIssue BUILDS IT ──────
       availablePurchase — the balance's SHOWN figure (U.stockPU is
         shownPurchaseQty, the In Stock column's own number). Below
         the display (it shows 0 but holds at least one grid step — holdsAny)
         the balance's 6-dp grid point carried in purchase units, so the cap
         is never printed as 0 over stock that is there. 0 only when the store
         holds none of it.
       maxIssueLineQty — before + that figure's image in the LINE's unit,
         rounded at the 6 dp both desks' fromPU rounds an entry to; the crumb
         unrounded (6 dp of a purchase-unit line would shave 0.4 g to nothing).
       Typed back, either one is accepted and lands the balance on exactly 0. */
    const shownAvail = ln.U.stockPU(availRecipe);
    const holds = grid6(availRecipe) > 0;                 // holdsAny()
    const gridAvail = grid6(availRecipe) / 1e6;           // qtyDown(x, 6)
    const booksPU = shownAvail > 0 ? shownAvail : holds ? gridAvail / pf : 0;
    const booksMaxLine = shownAvail > 0
      ? base + Math.round((shownAvail * pf / factor) * 1e6) / 1e6
      : holds ? base + gridAvail / factor : base;
    // THE SERVER'S OWN NUMBER WINS once it has spoken about this line. It is
    // the only fresh reading available — `current_stock` here is a snapshot
    // taken when the modal opened, and max_issue_qty arrives in the LINE's unit
    // (`line_unit`), which is exactly the basis the Issue box holds. Do NOT
    // reach for `available`/`requested` on that row for the line ceiling:
    // those are in the PURCHASE unit and mixing the two is the 1000x error.
    const maxLine = srv && Number.isFinite(Number(srv.max_issue_qty))
      ? Math.max(0, Number(srv.max_issue_qty))
      : booksMaxLine;
    /** Printable PURCHASE-unit cap (owner rule). The server's own `available`
     *  when it has spoken — the fresher reading, already in the purchase unit
     *  and already the shown figure, so it is neither converted nor re-rounded. */
    const availPU = srv && Number.isFinite(Number(srv.available))
      ? Math.max(0, Number(srv.available))
      : booksPU;
    /* A HELD ROW LEFT NOTHING BY ITS SIBLING (round 7). Held rows of one
       material share the pool in row order on the server (issue-stock.ts
       scoreHeldAtTurn / rescoreHeldIssue), so the second of two MANGO rows over
       a 1 kg shelf arrives with available 0 and the sentence "holds only 1 kg,
       and all of it goes to the line above for the same item". Read as "the
       books are empty" that printed "Store books hold none of this", "(books:
       none)" and "the books hold none of it … (books: 1,000 g)" over a stocked
       shelf (round-7 verifier, md_twice_typed_ask). It is the sibling's share
       exactly when another line of the same item has a server row that WAS
       given something, and the books hold some. Then the figure to print is
       the books' (the pool both rows share), never 0. */
    const sharedWith = srv && !(availPU > 0) && holds
      ? lines.filter(o => o.id !== ln.id && o.material_id === ln.material_id
          && (Number(blockedRows[o.id]?.available) || 0) > 0).length
      : 0;
    const purchaseUnit = (srv && String(srv.purchase_unit || '').trim()) || ln.U.pu;
    // The shown-figure test compares availPU with U.stockPU of the ask, so the
    // two must be on ONE basis. They are read off the same raw_materials row;
    // on a payload that ever lost material_purchase_unit, U falls back to the
    // recipe unit with pf 1 and the comparison would be across units — then
    // the test is skipped and the line-unit ceiling alone decides (it errs
    // towards a warning, which is advisory, never towards a false "fits").
    const sameBasis = String(purchaseUnit).toLowerCase().trim() === String(ln.U.pu || '').toLowerCase().trim();
    /**
     * WOULD THE SERVER HOLD THIS LINE AT `lineQty`? (or, were it the only line
     * handing anything over, refuse the gesture with it). The two questions
     * planCentralDebit asks, in its order:
     *   1. GRID — at or under the line-unit ceiling. The ceiling is the cap's
     *      own image, so everything at or under it shows at or under the cap;
     *   2. THE SHOWN FIGURE — the ask's shown figure IS the balance's, and the
     *      balance's is above 0 (availPU ≥ 0.001 ⇔ it is a shown figure; a
     *      crumb sits below it and has none). "All of it", from above as well
     *      as from below: 14.843 kg typed over 14,842.5 g, 14.842 kg typed over
     *      14,842.4 g — both fit, and both take the whole balance.
     * Anything else holds. A credit or a zero delta is not the floor's business.
     */
    const wouldHold = (lineQty: number) => {
      if (!armed) return false;
      const q = Number(lineQty) || 0;
      const askRecipe = Math.round((q - base) * factor * 1e6) / 1e6;
      if (!(askRecipe > EPSQ)) return false;
      if (q <= maxLine + EPSQ) return false;
      if (sameBasis && availPU >= 0.001 && ln.U.stockPU(askRecipe) === availPU) return false;
      // THE SERVER'S OTHER RENDERINGS OF THE SAME BALANCE (round 8). Its match
      // compares the ask's grid-point figure with the balance's
      // shownPurchaseQty AND with toPurchaseQty of the raw balance and of its
      // grid point (checkCentralIssue's `alts`), so a figure an older screen
      // printed is never refused. Asked through desk-rule.ts planDeskDebit —
      // the same function the store desk's forecast asks — on the snapshot the
      // modal opened with. Once the server has spoken (srv) its own figure
      // stands alone, as above.
      if (!srv && sameBasis && planDeskDebit(availRecipe, askRecipe, {
        unit: ln.material_unit, purchase_unit: ln.purchase_unit, pack_size: ln.pack_size,
      }).byShownFigure) return false;
      return true;
    };
    /* ── THE BOX'S OWN NUMBER ────────────────────────────────────────────────
       `maxLine` is in the LINE's stored unit; this Issue box is entered in
       PURCHASE units (`issued_pu`, converted once by U.fromPU at use). Round 5
       floored this to 3 dp so a 14,842.5 g balance read 14.842 kg — and the
       click left a 0.5 g crumb that the next ask was then told was "none of
       it". Round 6 makes the shown figure the cap, so the box figure is that
       figure, rounded only enough to shed binary noise (14843 / 1000) while
       still carrying a crumb's last recipe step (6 dp of the recipe unit,
       through the pack — the precision fmtCapPU prints it at). */
    const boxDp = Math.min(12, 6 + Math.max(0, Math.ceil(Math.log10(pf > 1 ? pf : 1))));
    const maxBoxRaw = ln.U.isPU ? maxLine : maxLine / pf;
    const maxBoxPU = Math.round(maxBoxRaw * Math.pow(10, boxDp)) / Math.pow(10, boxDp);
    return {
      armed, exempt,
      /** Recipe units the books say are issuable (never negative). */
      availRecipe,
      /** Ceiling in the LINE's own unit — what the POST body may hold. */
      maxLine,
      /** THE SAME CEILING IN THE BOX'S OWN UNIT — the one number on this row a
       *  storekeeper can type and have accepted. This is the `max_issue_qty`
       *  the server sends, converted to what the box takes. */
      maxBoxPU,
      /** Books cannot cover what this line asks for — the full ask would be held. */
      capped: wouldHold(ln.requested),
      /** Books hold nothing at all (holdsAny is false). Never true while the
       *  store holds even one grid step — that is a crumb with a figure — and
       *  never for a row whose 0 is a sibling's share (`sharedWith`). */
      empty: armed && !(availPU > 0) && sharedWith === 0,
      /** How many other lines of the same item the server gave the balance to
       *  first, when THIS row was left nothing (0 otherwise). Print the books'
       *  figure (`booksPU`) with "all of it goes to …", never "none". */
      sharedWith,
      /** The books' own figure, purchase unit (the In Stock column's number,
       *  or a crumb's grid point) — the pool sibling rows share. */
      booksPU,
      wouldHold,
      /** The server has already refused this line, in its own words. */
      serverMessage: srv ? String(srv.message || '') : '',
      /** Has the SERVER refused this very line, or is this only the screen's
       *  own reading of a snapshot? The difference decides whether a one-click
       *  "use the cap" may be offered: a liquor / store-mapped line is carved
       *  out of the central floor server-side and never produces a refusal row,
       *  but this page cannot identify one (which is why the box is not clamped
       *  and no `max=` is set — see the input below). So before the server has
       *  spoken the ceiling is advisory and is only STATED; once it has, the
       *  refusal is authoritative and the figure can be acted on. */
      fromServer: !!srv,
      /** Printable PURCHASE-unit cap — print it with fmtCapPU(availPU, pf). */
      availPU,
      pf,
      purchaseUnit,
    };
  };
  /** Is the quantity currently in the box one the server will hold back? Live,
   *  on the stored basis, by the same rule. Silent whenever the cap is not
   *  armed — an unsure screen says nothing rather than crying wolf. */
  const overCapOf = (ln: Line) => centralCapOf(ln).wouldHold(issuedOf(ln));
  /** Will the server HOLD this line on submit — issue the rest of the gesture
   *  and leave this one exactly as it was (round 9)? Only an INTERNAL line is
   *  held (a party line's transfer refuses the whole gesture instead), and only
   *  while another line hands something over (store-process `issuableLines`);
   *  with none, the gesture is refused whole and nothing is saved. A held line
   *  records nothing, so its typed figure is not "what gets stored" and what it
   *  owes after the submit is everything it owed before (harness md_held_row:
   *  20 kg typed 15 over a 14,842.4 g shelf printed "= 15,000 g" and "Shortfall
   *  5 kg"; the server held all 20). */
  const heldOf = (ln: Line) => !isPartyReq && overCapOf(ln)
    && lines.some(o => o.id !== ln.id && !overCapOf(o) && issuedOf(o) > o.already_issued + EPSQ);
  /* ──────────────────────────────────────────────────────────────────────────
   * WHAT THE TAKE WILL RECORD (round 8) — the server's shelf take, asked before
   * the click through desk-rule.ts forecastDeskTake (the store desk asks the
   * same function). The shelf rule takes the whole balance when the figure sent
   * IS the balance's shown figure: 14.842 kg typed over a 14,842.4 g shelf
   * takes all 14,842.4 g, the line records 14.8424, and THE RULE closes it —
   * the 0.6 g left is below one printed step and no desk can issue it. This
   * screen printed "Shortfall 0.001 kg = 1 g" and "⚠ 1 line is short … To buy
   * the rest, tick Also raise a vendor PO", then "Requisition is now
   * Fulfilled" (round-7 verifier). The two rails:
   *   · internal: each line's increment, in row order, with a running claim per
   *     material (store-process's write loop → applyIssueDelta);
   *   · PARTY: the transfer moves each line's whole quantity once, after the
   *     write loop, when no PO is raised and nothing is held
   *     (store-process 3a, applyPartyFulfillment) — forecast only when no
   *     vendor PO is raised (transferRuns: the box unticked, or ticked with no
   *     Buy qty) and on a line nothing was issued on before.
   * Printed ONLY where the take is not the typed figure (`changed`) or THE RULE
   * closes the line by the shelf (`byShelf`); every other row is untouched. A
   * line the server has already spoken about (blockedRows) is forecast only
   * while the server's balance is the one this modal opened with (round 9,
   * serverAgrees); otherwise it keeps the server's figures. Advisory: liquor /
   * store-mapped lines are invisible from here.
   * ────────────────────────────────────────────────────────────────────────── */
  let takeMemo: Record<string, DeskTakeForecast> | null = null;
  /** Does the server's refusal row still describe the balance this modal
   *  opened with — the same purchase unit and the same shown figure (the In
   *  Stock column's U.stockPU)? Only then may a take be forecast from the
   *  snapshot for a line the server has spoken about. */
  const serverAgrees = (l: Line, srv: ServerBlock) =>
    l.stock_known
    && String(srv.purchase_unit || '').toLowerCase().trim() === String(l.U.pu || '').toLowerCase().trim()
    && Number.isFinite(Number(srv.available))
    && Number(srv.available) === l.U.stockPU(Math.max(0, Number(l.current_stock) || 0));
  /* DOES THE PARTY TRANSFER RUN ON THIS SUBMIT? (round 9) — store-process 3a's
     own trigger, `!linkedPoId && poDropped.length === 0` (a party line is never
     held on the internal rail, so its heldItemIds clause is always empty here).
     A PO is raised, or a purchase line dropped, exactly when some line carries
     a Buy qty (store-process builds poLines from quantity_to_purchase > 0 and
     answers "No vendor PO was raised — no line had a Buy quantity" otherwise).
     So the PO BOX does not decide it: ticked with every Buy box empty, the
     transfer runs, takes the shelf by the shown-figure rule and refuses the
     whole gesture over a line it cannot move — round-9 harness
     md_party_po_nobuy printed "= 14,842 g" and "Shortfall 0.001 kg = 1 g" over a
     line the server closed at 14,842.4 g, and md_party_po_nobuy_over printed no
     warning at all over a 400.
     A Buy box nobody typed in FOLLOWS the shortfall (autoBuyQty), which itself
     depends on whether the transfer runs, so the answer is a fixed point: read
     every Buy figure as if the transfer runs; if one is still above 0 a PO is
     raised and it does not. That is consistent — a line still short under the
     take is at least as short without it, so its Buy stays above 0. */
  /* A DROPPED purchase line stops the transfer only while its own line still
     owes after this submit's write loop (round 9, store-process
     poDroppedOwing): a Buy qty on a line issued IN FULL is extra stock for the
     store, owes the party nothing, and no longer blocks it. "Dropped" is the
     footer's own predicate (dropLines: a vendor named and refused by the
     mapping rule); "still owes" is the server's pre-transfer reading — the
     typed figure short of the approved one, BEFORE any take (a line only the
     take could close is still the shortfall the buyer meant to order). A Buy
     line that goes onto a PO stops it, as before. */
  let transferMemo: boolean | null = null;
  const transferRuns = (): boolean => {
    if (!isPartyReq) return false;
    if (!raisePo) return true;
    if (transferMemo === null) {
      transferMemo = true;                       // provisional, while the Buy figures are read
      const blocks = (l: Line) => buyOf(l) > 0
        && (!(hasVendor(l) && !!mappingWarning(l)) || issuedOf(l) + EPSQ < l.requested);
      if (lines.some(blocks)) {
        transferMemo = false;
        takeMemo = null;                         // built under the provisional answer — rebuild
      }
    }
    return transferMemo;
  };
  const takeOf = (ln: Line): DeskTakeForecast | undefined => {
    if (!takeMemo) {
      const out: Record<string, DeskTakeForecast> = {};
      const claimed = new Map<string, number>();
      const partyRuns = isPartyReq && transferRuns();
      // The transfer is all-or-nothing: one line it cannot move refuses the
      // whole submit, and then nothing is taken anywhere.
      const partyRefused = partyRuns && lines.some(l => overCapOf(l));
      for (const l of lines) {
        if (partyRefused) break;
        // THE SERVER HAS SPOKEN about this line (a refused submit). Its cap is
        // fresher than the snapshot, but it carries only the SHOWN figure of
        // the balance, not the raw one the take needs. Skipping the line
        // outright (round 8) left the take unsaid after the server's own
        // "use it": 14.842 kg typed back over the 14,842.4 g shelf printed
        // "= 14,842 g" and "Shortfall 0.001 kg = 1 g", and "1 line is short",
        // and the server took 14,842.4 g and closed the line (round-9 harness
        // md_int_useit, md_party_useit). The snapshot is used while the server
        // still shows the same balance on the same unit; a balance that moved
        // keeps the server's figures alone, as before.
        const srvRow = blockedRows[l.id];
        if (srvRow && !serverAgrees(l, srvRow)) continue;
        if (!l.stock_known) continue;
        const after = issuedOf(l);
        const units = {
          unit: l.line_unit, material_unit: l.material_unit,
          material_purchase_unit: l.purchase_unit, material_pack_size: l.pack_size,
          current_stock: l.current_stock,
          // A liquor / store-mapped line has no central take (round 8b).
          central_flow_blocked: l.central_flow_blocked,
        };
        let tk: DeskTakeForecast | null = null;
        if (!isPartyReq) {
          if (overCapOf(l)) continue;      // held — the hold forecasts say so
          tk = forecastDeskTake({
            line: { ...units, quantity_issued: l.already_issued }, purpose: 'internal',
            approved: l.requested, deltaLine: after - l.already_issued,
            claimedRecipe: claimed.get(l.material_id) || 0,
          });
        } else if (partyRuns) {
          // The line's WHOLE quantity, from 0 (the transfer's beforeLineQty).
          tk = forecastDeskTake({
            line: { ...units, quantity_issued: 0 }, purpose: 'internal',
            approved: l.requested, deltaLine: after,
            claimedRecipe: claimed.get(l.material_id) || 0,
          });
        }
        if (!tk) continue;
        claimed.set(l.material_id, (claimed.get(l.material_id) || 0) + tk.takeRecipe);
        if (tk.changed || tk.byShelf) out[l.id] = tk;
      }
      takeMemo = out;
    }
    return takeMemo[ln.id];
  };
  /** Typed down to the books' cap, does the take close the line (round 8b)?
   *  The cap is the shown figure of what is left (`maxLine`), so the take is
   *  everything left; THE RULE closes the line when less than one printed step
   *  is then owed. Asked of desk-rule.ts forecastDeskTake from the line's base
   *  (the party transfer's 0, or what the line already held). */
  const capClosesLine = (ln: Line): boolean => {
    const cap = centralCapOf(ln);
    if (!cap.armed || cap.empty) return false;
    const base = isPartyReq ? 0 : ln.already_issued;
    const tk = forecastDeskTake({
      line: {
        unit: ln.line_unit, material_unit: ln.material_unit,
        material_purchase_unit: ln.purchase_unit, material_pack_size: ln.pack_size,
        current_stock: ln.current_stock, central_flow_blocked: ln.central_flow_blocked,
        quantity_issued: base,
      },
      purpose: 'internal', approved: ln.requested, deltaLine: cap.maxLine - base,
    });
    return !!tk?.complete;
  };
  /**
   * The Buy qty a line offers while nobody has overridden it: the LIVE shortfall,
   * expressed in whatever unit the Buy box is currently entering in.
   *
   * This is the seed's own expression, unchanged, with the frozen `shortfall`
   * swapped for the live one — `req_factor` and `pack_size` are the very values
   * the seed computed, so a line that opens untouched shows the identical number
   * it showed before this change. What is new is only that it KEEPS UP: lower
   * Issue Now to what you can actually hand over and the shortfall appears in
   * both the column and the box, instead of the column alone.
   *
   * Rounded UP on the purchase basis because vendors do not sell fractional
   * bottles — but only for a purchase unit that is actually a countable pack.
   * For a unit that is itself a measurement (kg / L) the shortfall is kept, to
   * 3 dp; see isMeasurePurchaseUnit above for the numbers.
   */
  const autoBuyQty = (ln: Line) => {
    const short = shortOf(ln);
    if (short <= 0) return 0;
    // Entering in the PURCHASE unit (the default whenever the two units differ).
    if (ln.pack_size > 1 && ln.po_entry_unit === ln.purchase_unit) {
      // A whole pack for btl / pkt / can / case; the real figure for kg / L.
      const upToOrderable = (v: number) =>
        isMeasurePurchaseUnit(ln.purchase_unit) ? Math.ceil(v * 1000) / 1000 : Math.ceil(v);
      // requested-unit IS the purchase unit → already there; else recipe → ÷ pack.
      return ln.req_factor > 1 ? upToOrderable(short) : upToOrderable(short / ln.pack_size);
    }
    // 6 dp, the same precision lineUnits.fromPU() rounds an entered figure to.
    // `short` is a subtraction of two floats, so without it a 4 kg shortfall can
    // reach the box as "4.000000000000001" and get POSTed as the PO quantity.
    const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
    // Entering in the RECIPE unit → the shortfall has to be expressed there too.
    if (ln.pack_size > 1) return round6(short * ln.req_factor);
    // No real pack conversion: recipe unit IS the purchase unit, nothing to do.
    return round6(short);
  };
  /** The vendor this line would be ordered from, as the server will read it.
   *  Declared ABOVE buyStr because the Buy box reads it — see the note there. */
  const vendorIdOf   = (ln: Line) => String(ln.vendor_id || '').trim();
  const vendorNameOf = (ln: Line) => String(ln.vendor || '').trim();
  const hasVendor    = (ln: Line) => !!(vendorIdOf(ln) || vendorNameOf(ln));
  /**
   * The string the Buy box shows: the storekeeper's own text once he has typed
   * in it (blank included — that is how a line is taken off the PO), otherwise
   * the live shortfall — BUT ONLY ONCE THE LINE HAS A VENDOR. EVERY reader goes
   * through here, so the box, the line total, the footer total and the POST body
   * can never disagree.
   *
   * WHY THE VENDOR GATES THE AUTO-FILL. The submit button is disabled while any
   * line with a Buy qty is missing its vendor or its rate, because the server
   * 400s that request and a 400 throws the ISSUE away too. Auto-filling the Buy
   * box from the shortfall alone turned that gate inside out: the seed never
   * fills a vendor, so every short line became a "Buy line" with no vendor and
   * the button locked. Measured on a copy of the live db with Issue Now cleared:
   * 12,964 of 16,359 requisition lines auto-filled a Buy qty and ALL 12,964 had
   * no vendor — including both requisitions sitting in the Store Inbox today,
   * where ticking the box and lowering Issue Now disabled the hand-over
   * outright. That is the same "the ticked box blocks the issue" defect the
   * checkbox copy below says was fixed, arriving through the other door.
   *
   * A vendor is the ONLY reliable signal that a human means to buy this line —
   * the server's own words (store-process/route.ts, vendorRefOf). So: the
   * shortfall is shown as the box's PLACEHOLDER (grey, visible, not a value)
   * until a vendor is picked, and fills in as a real value the moment one is.
   * Nothing is hidden and nothing is silently dropped — an empty Buy box orders
   * nothing, which is exactly what it looks like, and the Shortfall column next
   * to it prints the same figure regardless. Typing in the box still wins over
   * everything (buy_touched), so a line can be ordered with no shortfall at all.
   */
  const buyStr = (ln: Line) =>
    ln.buy_touched ? ln.quantity_to_purchase
                   : (hasVendor(ln) && autoBuyQty(ln) > 0 ? String(autoBuyQty(ln)) : '');
  /** What the Buy box OFFERS while it is still empty — the same figure buyStr
   *  will fill in the moment a vendor is picked, shown as a placeholder so the
   *  storekeeper can see the suggestion without it counting as an order. */
  const buyHint = (ln: Line) =>
    (!ln.buy_touched && !hasVendor(ln) && autoBuyQty(ln) > 0) ? String(autoBuyQty(ln)) : '';
  /** Buy qty / unit price as numbers — the boxes hold raw strings (see seed).
   *  NO basis change: both stay in ln.po_entry_unit, exactly as before. */
  const buyOf   = (ln: Line) => Math.max(0, Number(buyStr(ln)) || 0);
  const priceOf = (ln: Line) => Math.max(0, Number(ln.unit_price) || 0);
  /**
   * The client's copy of the SERVER's mapping rule (src/lib/vendor-mapping.ts
   * vendorMappingError), so the storekeeper is told BEFORE the round trip
   * instead of after — and "after" here is unrecoverable: the issue commits,
   * the requisition flips to store_processed, and the Issue button that opens
   * this modal disappears, so the purchase intent cannot be retried from this
   * screen at all. Returns null when there is nothing to say, including while
   * the index has not loaded (advisory only — the server still has the last
   * word, and its wording is what a 200 response prints).
   *
   * Scale, measured on live data: 308 of the 737 materials that appear on
   * requisitions (42%) have NO vendor mapped, and 20 of 59 active vendors have
   * no item list at all.
   */
  const mappingWarning = (ln: Line): string | null => {
    if (!vmReady) return null;
    const mapped = vendorsByMaterial[ln.material_id] || [];
    const vid = vendorIdOf(ln);
    if (!hasVendor(ln)) {
      return mapped.length === 0
        ? `No vendor is mapped to supply ${ln.material_name}. Map one on Vendor Items first — any vendor picked here will be refused and the line dropped from the PO.`
        : null;
    }
    if (!vid) {
      return `"${vendorNameOf(ln)}" was not picked from the vendor list, so its item list cannot be checked.`;
    }
    if (vendorsNoItems.has(vid)) {
      return `${vendorNameOf(ln) || 'This vendor'} has no items mapped at all, so nothing can be ordered from them. This line will be DROPPED from the PO — add their item list on Vendor Items first.`;
    }
    if (!mapped.some(v => v.id === vid)) {
      return `${vendorNameOf(ln) || 'This vendor'} is not mapped to supply ${ln.material_name}. This line will be DROPPED from the PO — pick a mapped vendor${mapped.length ? ` (${mapped.map(v => v.name).join(', ')})` : ''}, or map the pair on Vendor Items.`;
    }
    return null;
  };

  /* Lines the central store's books cannot cover in full — the set the red
     banner is about. Derived through centralCapOf, so the banner, the row and
     the box can never quote three different ceilings. */
  // A line THE RULE closes by the shelf on this submit (takeOf: the take
  // empties the shelf and less than one printed step is left owing) is not one
  // the books "cannot cover" — there is no rest to receive stock for (round 8b).
  const cappedLines = lines.filter(ln => centralCapOf(ln).capped && !takeOf(ln)?.byShelf);
  /** Lines currently holding a quantity the server will hold back (not issue). */
  const overCapLines = lines.filter(ln => overCapOf(ln));
  /** Lines that clear the floor AND hand goods over on this submit — the
   *  route's own `issuableLines` (store-process/route.ts: a line the floor
   *  cleared whose posted quantity_issued is above the stored one). With a held
   *  line and NONE of these, the route refuses the gesture whole (400, nothing
   *  written); with at least one, it issues them and holds the rest (200,
   *  `held_lines`). Advisory like every cap on this screen. */
  const handOverLines = lines.filter(ln => !overCapOf(ln) && issuedOf(ln) > ln.already_issued + EPSQ);
  // A PARTY submit's transfer is all-or-nothing (round 8b): one line it cannot
  // move refuses the whole submit, whatever the other lines hand over.
  const partyWhole = isPartyReq && transferRuns() && overCapLines.length > 0;
  const refusedWhole = partyWhole || (overCapLines.length > 0 && handOverLines.length === 0);
  /** Lines entered as 0 that are still owed: not held, and nothing goes out on
   *  them — they stay outstanding exactly like a held line. The ⛔ banner's
   *  "Every other line is issued" must not count them (round 7 verifier:
   *  MIRCHI held + SALT at 0 + EGGS read "Every other line is issued" and SALT
   *  was not). The store desk's forecastCentralHolds `idle` is the same set. */
  const zeroEntryLines = lines.filter(ln => !overCapOf(ln) && issuedOf(ln) <= EPSQ
    && ln.requested - ln.already_issued > EPSQ);
  /** The cap could not arm itself on these lines: the payload did not carry a
   *  balance for them. NOT a quiet fallback — the amber panel says so, because
   *  a cap that disarms in silence is how the previous attempt at this ended up
   *  claiming a protection it did not have. 0 live lines are in this state. */
  const unarmedLines = isPartyReq ? [] : lines.filter(ln => !ln.stock_known && !blockedRows[ln.id]);

  // A cross-line SUM of shortfalls mixes units (kg + BTL + pcs) and is
  // meaningless as a number — count the lines that are short instead.
  // shortOf, not a bare subtraction: a line THE RULE will close by the shelf
  // (takeOf) is not short — nothing more can be issued on it.
  const shortLineCount = lines.filter(ln => shortOf(ln) > 0).length;
  const totalShortfall = lines.reduce((s, ln) => s + shortOf(ln), 0);
  const poTotal = lines.reduce((s, ln) => s + (buyOf(ln) * priceOf(ln)), 0);

  const submit = async () => {
    if (raisePo) {
      // PO-mode validations — fire before any DB write so the store user gets
      // a clear, line-specific error instead of a half-created PO.
      //
      // "NO LINE HAS A BUY QTY" IS NO LONGER REFUSED. It is a legitimate
      // outcome — the store had everything on the shelf — and refusing it left
      // the storekeeper unable to record the hand-over at all until he unticked
      // a box he had ticked on purpose. The server's own answer to it is
      // "No vendor PO was raised — no line had a Buy quantity", which the
      // result panel prints; the footer says the same thing BEFORE the click.
      const buyLines = lines.filter(ln => buyOf(ln) > 0);
      // 1. Every Buy-qty line must have a positive unit price. Mirrors the
      //    server's po_price_required 400, which refuses the WHOLE gesture
      //    (issue included) — so it is worth stopping here.
      const noPrice = buyLines.find(ln => !(priceOf(ln) > 0));
      if (noPrice) {
        alert(`Enter a unit price (> 0) for "${noPrice.material_name}" before raising the PO. POs cannot be raised at ₹0.`);
        return;
      }
      // 2. Every Buy-qty line must have a vendor picked (server: po_vendor_required).
      const noVendor = buyLines.find(ln => !hasVendor(ln));
      if (noVendor) {
        alert(`Pick a vendor for "${noVendor.material_name}" before raising the PO.`);
        return;
      }
      // 3. LINES THE SERVER WILL DROP. Unlike the two above, an unmapped
      //    vendor/item pair does NOT get a 400 — the server records the issue,
      //    reports the drop, and moves on. That is the right call there (it
      //    refuses to strand a hand-over over a mapping it cannot fix), but it
      //    is also a one-way door on this screen: once the requisition is
      //    store_processed the Issue button vanishes and the purchase intent
      //    cannot be re-submitted here. So ASK first, and let him back out and
      //    fix the mapping instead. Advisory — `mappingWarning` is silent while
      //    the index has not loaded, and the storekeeper can always continue.
      // hasVendor() first: mappingWarning also speaks up on a line with NO
      // vendor yet (to say the item has no mapped supplier at all), and that
      // case is already refused by the price/vendor gate above — it must not be
      // relabelled here as "the vendor you picked will be rejected".
      const willDrop = buyLines
        .filter(ln => hasVendor(ln))
        .map(ln => ({ ln, why: mappingWarning(ln) }))
        .filter(x => !!x.why);
      if (willDrop.length > 0) {
        const ok = confirm(
          `${willDrop.length} purchase line${willDrop.length === 1 ? '' : 's'} will be DROPPED from the vendor PO:\n\n` +
          willDrop.map(x => `• ${x.ln.material_name} — ${x.why}`).join('\n\n') +
          `\n\nThe issue itself WILL be recorded either way, and this requisition cannot be issued again from this screen afterwards — ` +
          `so the dropped quantity would have to be ordered by hand on Purchase Orders.\n\n` +
          `Continue anyway?`,
        );
        if (!ok) return;
      }
    }
    setBusy(true);
    const body: any = {
      note,
      lines: lines.map(ln => {
        // Send qty + price in PURCHASE units — purchase_order_items is
        // purchase-unit basis (a PO is raised to a VENDOR; the receive route
        // then ×pack_size for the recipe-unit stock credit, exactly like
        // /api/grn and /api/purchases). So a value the store user typed IN the
        // purchase unit goes through unchanged; only a recipe-unit entry is
        // converted UP to the purchase unit. The line total is identical either
        // way, so vendor totals on the PO print still match what was entered.
        const enteredInPurchaseUnit = raisePo && ln.po_entry_unit === ln.purchase_unit && ln.pack_size > 1;
        const enteredInRecipeUnit = raisePo && !enteredInPurchaseUnit
          && ln.pack_size > 1 && ln.po_entry_unit === ln.material_unit;
        // round6 on BOTH halves. These are the numbers that land in
        // purchase_order_items.quantity / .unit_price and get multiplied into
        // total_price, and a recipe→purchase conversion is a float multiply:
        // ₹0.10164/g × 1000 is 101.64000000000001, not 101.64. 6 dp is far below
        // any real rate or quantity and removes exactly that artefact. A value
        // entered directly in the purchase unit passes through unchanged.
        const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
        const poQty = round6(enteredInRecipeUnit
          ? buyOf(ln) / ln.pack_size
          : buyOf(ln));
        const poPrice = round6(enteredInRecipeUnit
          ? priceOf(ln) * ln.pack_size
          : priceOf(ln));
        return {
          id: ln.id,
          // Purchase-unit box → the line's own stored unit, converted ONCE here
          // (and not at all when the store user never touched the figure).
          quantity_issued: issuedOf(ln),
          // Only send the purchase qty when raisePo is ticked. Backend's default
          // (auto_create_po=false) makes it ignore this field anyway, but keep
          // the payload honest.
          quantity_to_purchase: raisePo ? poQty : 0,
          unit_price:           raisePo ? poPrice : undefined,
          // Send BOTH the vendor display name and vendor_id when we have it —
          // server prefers vendor_id (proper FK), falls back to name lookup.
          vendor:    raisePo ? ln.vendor    : undefined,
          vendor_id: raisePo ? ln.vendor_id : undefined,
        };
      }),
    };
    if (raisePo) {
      body.auto_create_po = true;
      body.po_date = poDate;
      // Blank means "no date agreed with the vendor" — send nothing at all so the
      // PO column stays NULL instead of holding an empty string that later date
      // comparisons (overdue/ageing) would have to special-case.
      body.po_delivery_date = poDeliveryDate || undefined;
    }
    const r = await api(`/api/requisitions/${req.id}/store-process`, { method: 'POST', body });
    const j = await r.json();
    if (!r.ok) {
      // The 400s now name the offending row (code + req_item_id / req_item_ids).
      // Keep the modal open, highlight those rows, and say the sentence — the
      // whole gesture was refused before anything was written, so it is
      // replayable after one correction.
      const ids: string[] = Array.isArray(j?.req_item_ids)
        ? j.req_item_ids.map(String)
        : (j?.req_item_id ? [String(j.req_item_id)] : []);
      // ── THE CENTRAL STORE REFUSED (the over-issue clamp) ──────────────────
      // Two spellings, ONE case: 'central_stock_short' comes from the
      // pre-flight (nothing was written) and 'CENTRAL_STOCK_SHORT' from the
      // catch (the balance moved between the pre-flight and the write lock, and
      // the whole transaction was rolled back). Same payload, same meaning —
      // and in both cases the requisition is unchanged, so the form below is
      // still exactly what was typed and one corrected number replays it.
      //
      // Each row is kept against its req_item_id so the server's own sentence
      // prints next to the line it is about, and so the cap above can use
      // max_issue_qty — a FRESHER reading of the balance than the snapshot this
      // modal opened with. Only rows the server tagged as a stock shortage are
      // taken: a future refusal with a different `blocked` shape must not end
      // up feeding a stock ceiling.
      const blocked: ServerBlock[] = Array.isArray(j?.blocked) ? j.blocked : [];
      const byItem: Record<string, ServerBlock> = {};
      for (const b of blocked) {
        const rid = String(b?.req_item_id || '');
        if (!rid) continue;
        if (String(b?.code || '').toLowerCase() !== 'central_stock_short') continue;
        byItem[rid] = b;
      }
      setBlockedRows(byItem);
      // The rows the server named, from either field — `blocked[]` carries them
      // even if req_item_ids is ever absent.
      setErrorRows(new Set(ids.length > 0 ? ids : Object.keys(byItem)));
      setErrorText(String(j?.error || 'Failed'));
      setBusy(false);
      return;
    }
    // ── SHOW WHAT THE SERVER SAID, ALL OF IT ────────────────────────────────
    // This used to be a two-branch alert() whose fallback read "Issuance
    // recorded. If any items still need to be purchased, raise a vendor PO on
    // the Purchase Orders page." — printed verbatim over a PO the storekeeper
    // had just successfully raised, because it only ever looked at
    // po_skipped_note. That single sentence is most of what "raise PO to vendor
    // is not functioning" looks like from the counter.
    //
    // The result panel below renders the structured fields (the PO, every line
    // that did not reach it with its own reason, the merge report, the lines
    // whose stock did not move) AND `po_note` verbatim, which the route
    // documents as the one field that is true on every path. Belt and braces on
    // purpose: if a field is ever added that this panel does not know about,
    // po_note still carries it.
    setResult(j);
    setBusy(false);
  };

  // ── RESULT VIEW ───────────────────────────────────────────────────────────
  // Shown after a 200 instead of the form. Everything on it comes off the
  // response; nothing is inferred from what the screen asked for.
  if (result) {
    const skipped: any[] = Array.isArray(result.po_skipped_lines) ? result.po_skipped_lines : [];
    // 'unmapped_vendor' and 'store_mapped' still owe goods — the route says so
    // explicitly (its poDropped filter is these two) and keeps those quantities
    // on the requisition. The other three codes are reported for honesty but
    // nothing is outstanding, so they must not be dressed up as an unfilled
    // order. KEEP THIS LIST IN STEP WITH poDropped in
    // api/requisitions/[id]/store-process/route.ts — it decides the sentence
    // this panel prints (and the server's remedy clause). Since round 9 it no
    // longer decides the status on its own: a dropped line on a line issued in
    // full owes the department nothing, and the requisition can be Fulfilled
    // with the purchase still to raise — result.status says which.
    const stillOwed = skipped.filter(s => s.code === 'unmapped_vendor' || s.code === 'store_mapped');
    // Their remedies are NOT the same: an unmapped pair is fixed on Vendor Items
    // and then raised on Purchase Orders, while a store-mapped (liquor / TGBCL)
    // material can never go on a Central PO at all and has to be bought through
    // the Liquor Store. Sending a bar item to Vendor Items would be a dead end.
    const owedMappingOnly = stillOwed.length > 0 && stillOwed.every(s => s.code === 'unmapped_vendor');
    const unitReview: string[] = Array.isArray(result.issue_unit_review) ? result.issue_unit_review : [];
    /* THE LINES THE CENTRAL STORE HELD BACK. store-process issues every line
       the books cover and leaves a short one exactly as it was — outstanding —
       answering 200 with `held_lines` (the 400's `blocked` row shape, scored
       AFTER the gesture so the cap is what the next issue will meet). Before
       this panel the only trace on this screen was a sentence folded into
       po_note, printed in the muted 10px "Server summary" box under a header
       that said "issued" — a partly-issued result looked like a full one.
       Absent or empty ⇒ nothing was held ⇒ nothing below changes. */
    const held: ServerBlock[] = Array.isArray(result.held_lines)
      ? (result.held_lines as unknown[]).filter((h): h is ServerBlock => !!h && typeof h === 'object')
      : [];
    const SKIP_LABEL: Record<string, string> = {
      unmapped_vendor: 'Vendor not mapped to this item',
      store_mapped:    'Liquor Store item — not a Central Store purchase',
      no_quantity:     'Vendor picked, Buy qty left blank',
      chef_rejected:   'Chef rejected this line',
      po_not_requested: 'No vendor PO was requested',
    };
    return (
      <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
        <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-3xl my-8 shadow-xl">
          <div className="px-5 py-4 border-b border-[#E8D5C4]">
            {/* "Issued (partial)" is this page's own label for store_processed
                (STATUS_LABEL) — a held line keeps the requisition there. A
                result with nothing held keeps the header it always had. */}
            <h2 className="font-bold text-[#2D1B0E]">{req.req_number} — {held.length > 0 ? 'issued (partial)' : 'issued'}</h2>
            <div className="text-[11px] text-[#8B7355] mt-0.5">
              Requisition is now <b>{STATUS_LABEL[result.status] || result.status}</b>.
            </div>
          </div>
          <div className="p-5 space-y-3 text-xs">
            {/* ── HELD BACK: THE ONE FACT HERE ABOUT GOODS, SO IT LEADS ────────
                The store desk's held panel (store-requisitions/page.tsx, "THE
                CENTRAL STORE WILL NOT GIVE THE GOODS") line for line — its title,
                the server's own sentence verbatim, "Most it can give now", and
                its held footer — so both desks say a hold the same way. Two
                differences, both forced by where this panel sits:
                  · the material is named on each row, because the panel is not
                    beside the line it is about;
                  · NO "Issue X" button. The submit moved the requisition out of
                    the statuses this screen can issue from (`canStoreAct`), so
                    the server's "Issue 1 kg or less on this line" has no line to
                    act on HERE — the panel says where it does: the store desk.
                The gesture-level sentence is store-process's own
                stock_held_note wording ("on this requisition"; the store desk's
                is "in that gesture"). Figures go through fmtCapPU: below 0.001
                the cap is a sub-display crumb that fmtNum would print as 0. */}
            {held.length > 0 && (
              <div className="px-3 py-2 rounded border-2 border-rose-300 bg-rose-50 text-rose-900 space-y-1.5">
                <div className="font-semibold flex items-start gap-1">
                  <AlertCircle className="w-3.5 h-3.5 mt-[1px] shrink-0" />
                  <span>
                    {held.length} line{held.length === 1 ? ' was' : 's were'} NOT issued and {held.length === 1 ? 'stays' : 'stay'} outstanding
                    {' '}— the central store does not hold the quantity asked.
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {held.map((h, k) => {
                    const ln = lines.find(l => l.id === String(h.req_item_id || ''));
                    const pu = String(h.purchase_unit || '').trim();
                    const avail = Math.max(0, Number(h.available) || 0);
                    const asked = Math.max(0, Number(h.requested) || 0);
                    // Re-scored AFTER the gesture: a credit later in the same
                    // gesture can leave enough for it now (rescoreHeldIssue says
                    // so in its sentence). "Does not hold this much" would then be
                    // false, so the title becomes the server's own phrase for it.
                    const fitsNow = asked > 0 && avail >= asked - 1e-9;
                    // Same guard as the store desk's `sameBasis`: the recipe hint
                    // converts through this line's units, so only when the
                    // server's unit IS this line's purchase unit.
                    const U = ln?.U;
                    const sameBasis = !!U && !!pu && pu.toLowerCase() === String(U.pu || '').toLowerCase();
                    const msg = String(h.message || '').trim();
                    return (
                      <li key={`${h.req_item_id || ''}-${k}`}
                          className="rounded border border-rose-300 bg-white/70 px-2 py-1 text-[10px] leading-snug">
                        <div className="font-semibold">
                          {h.material || ln?.material_name || 'this item'}
                          {' '}· {fitsNow ? 'Not issued with the rest of this gesture' : 'The central store does not hold this much'}
                        </div>
                        {msg ? <div className="mt-0.5 opacity-90">{msg}</div> : null}
                        {avail > 0 && (
                          <div className="mt-0.5">
                            Most it can give now:{' '}
                            <b className="font-mono">{fmtCapPU(avail, U?.pf || 1)}{pu ? ` ${pu}` : ''}</b>
                            {/* The recipe equivalent only where it is EXACT: a
                                crumb (under 0.001) is carried at its own grid
                                point. A shown figure is the balance rounded to
                                3 dp — 14.843 kg over 14,842.5 g — so "= 14,843 g"
                                would claim half a gram the store does not hold;
                                typing 14.843 takes the 14,842.5 g that is there. */}
                            {U && U.pf > 1 && sameBasis && avail < 0.001
                              ? <span className="text-[9px] opacity-70"> (= {fmtNum(U.toRecipe(U.fromPU(avail)))} {U.recipeUnit})</span>
                              : null}
                          </div>
                        )}
                        <div className="mt-0.5 opacity-90"><b>This line was NOT issued and stays outstanding.</b></div>
                      </li>
                    );
                  })}
                </ul>
                <div className="text-[10px]">
                  {/* A line entered as 0 went out with nothing either, so it is
                      named before "everything else" (the lines state is the
                      gesture that was posted). None ⇒ the sentence as before. */}
                  {zeroEntryLines.length > 0 && <>{zeroEntrySentence(zeroEntryLines.map(ln => ln.material_name), true)}{' '}</>}
                  Everything else on this requisition was issued. This requisition can no longer be issued from this
                  screen — issue the held quantity on{' '}
                  <a href="/store-requisitions" className="underline font-semibold">Issue Requisitions</a>.
                </div>
              </div>
            )}

            {/* THE PO — the thing the old message never mentioned. */}
            {result.linked_po_number ? (
              <div className="px-3 py-2 rounded border border-emerald-300 bg-emerald-50 text-emerald-900">
                <div className="font-semibold">
                  ✓ Purchase order {result.linked_po_number} raised
                  {result.po_line_count != null && <> for {result.po_line_count} item{result.po_line_count === 1 ? '' : 's'}</>}
                  {result.po_total_cost != null && <> (₹{Number(result.po_total_cost).toLocaleString('en-IN')})</>}.
                </div>
                <div className="text-[10px] mt-0.5">
                  It is <b>PENDING ADMIN APPROVAL</b> — nothing is ordered from the vendor until an admin approves it.{' '}
                  <a href={`/purchase-orders?id=${result.linked_po_id}`} className="underline font-medium">Open {result.linked_po_number} →</a>
                </div>
              </div>
            ) : raisePo ? (
              <div className="px-3 py-2 rounded border border-amber-300 bg-amber-50 text-amber-900 font-semibold">
                ⚠ No vendor PO was raised.
                {skipped.length === 0 && <span className="font-normal"> No line had a Buy quantity.</span>}
              </div>
            ) : null}

            {/* EVERY LINE THE SERVER DID NOT TURN INTO A PO LINE. */}
            {skipped.length > 0 && (
              <div className={`px-3 py-2 rounded border ${stillOwed.length > 0 ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900'}`}>
                <div className="font-semibold">
                  {skipped.length} purchase line{skipped.length === 1 ? ' was' : 's were'} NOT ordered
                </div>
                <ul className="mt-1 space-y-1.5">
                  {skipped.map((s, k) => (
                    <li key={`${s.req_item_id}-${k}`} className="border-t border-current/20 pt-1">
                      <div className="font-medium">
                        {s.material}
                        {s.vendor ? <span className="font-normal"> → {s.vendor}</span> : null}
                        {Number(s.quantity) > 0 && (
                          <span className="font-normal"> · {fmtNum(Number(s.quantity))} {s.purchase_unit}
                            {Number(s.unit_price) > 0 && <> @ ₹{fmtNum(Number(s.unit_price))}/{s.purchase_unit}</>}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] opacity-90">
                        <b>{SKIP_LABEL[s.code] || s.code}.</b> {s.reason}
                      </div>
                    </li>
                  ))}
                </ul>
                {stillOwed.length > 0 && (
                  <div className="text-[10px] mt-1.5 pt-1.5 border-t border-current/20">
                    The quantity is still recorded on the requisition, and this requisition can no longer be issued from this
                    screen.{' '}
                    {owedMappingOnly ? (
                      <>Fix the pair on{' '}
                        <a href="/vendors/materials" className="underline font-medium">Vendor Items</a>, then raise it on{' '}
                        <a href="/purchase-orders" className="underline font-medium">Purchase Orders</a>.</>
                    ) : (
                      /* A liquor line is in the list, so the way out differs per row —
                         send the reader to the reason above rather than to one screen
                         that can only help half of them. */
                      <>Each line above says where to raise it: a vendor-mapping gap is fixed on{' '}
                        <a href="/vendors/materials" className="underline font-medium">Vendor Items</a> and then ordered on{' '}
                        <a href="/purchase-orders" className="underline font-medium">Purchase Orders</a>, while a Liquor Store
                        item is bought on{' '}
                        <a href="/inventory/liquor-store" className="underline font-medium">Inventory → Liquor Store</a>.</>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Two lines of the same item collapsed onto one PO line. */}
            {result.po_merged_note && (
              <div className="px-3 py-2 rounded border border-amber-300 bg-amber-50 text-amber-900">
                <div className="font-semibold">One item was ordered on a single combined line</div>
                <div className="text-[10px] mt-0.5">{result.po_merged_note}</div>
              </div>
            )}

            {/* STOCK DID NOT MOVE. The route reports this and the old alert
                discarded it, so the screen said "Issuance recorded" over a line
                whose quantity was written but whose stock never budged. */}
            {unitReview.length > 0 && (
              <div className="px-3 py-2 rounded border-2 border-red-300 bg-red-50 text-red-900">
                <div className="font-semibold">🚨 Stock was NOT adjusted on {unitReview.length} line{unitReview.length === 1 ? '' : 's'}</div>
                <div className="text-[10px] mt-0.5">
                  The hand-over is recorded against the requisition, but the line&apos;s unit could not be resolved
                  safely, so central stock was left untouched for: <b>{unitReview.join(', ')}</b>. Fix the unit /
                  pack size on the material and correct the count.
                </div>
              </div>
            )}

            {/* The route's own one-true-sentence field, verbatim. Kept even
                though the blocks above already say it: it is documented as
                correct on every path, so a field this panel has not learned
                about yet still reaches the storekeeper. */}
            {result.po_note && (
              <div className="px-3 py-2 rounded border border-[#E8D5C4] bg-[#FFF8F0] text-[10px] text-[#6B5744]">
                <span className="font-semibold text-[#8B7355]">Server summary: </span>{result.po_note}
              </div>
            )}
            {!result.po_note && !result.linked_po_number && skipped.length === 0 && (
              <div className="px-3 py-2 rounded border border-emerald-200 bg-emerald-50 text-emerald-900">
                ✓ Issuance recorded against {req.req_number}.
              </div>
            )}
          </div>
          <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end">
            <button onClick={onDone}
                    className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded-lg">
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-3xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <h2 className="font-bold text-[#2D1B0E]">Store — Issue {req.req_number}</h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-5 space-y-3 text-xs">
          <p className="text-[#6B5744]">
            Enter the quantity <span className="text-emerald-700 font-semibold">handed to the department</span> per line.
            Tick &quot;Also raise a vendor PO&quot; below and every line still short after Issue Now shows the shortfall as a
            greyed-out suggestion in its <b>Buy</b> box. Pick a vendor and it becomes the quantity to order; a shortfall is
            not required either — type a Buy qty on any line to order it. Only lines with a Buy qty go onto the vendor PO,
            and an empty Buy box never blocks the hand-over.
          </p>
          {/* THIS PARAGRAPH USED TO SAY THE ISSUE MOVES NO STOCK. IT DOES —
              src/lib/issue-stock.ts:12 "THE FLAG IS GONE. THE DEDUCT IS
              UNCONDITIONAL", measured by calling the route against a copy of the
              live db (21 kg of WHOLE GARLIC: current_stock 227.2 → 206.2). The
              In Stock tooltip below already said "Issuing debits it", so the
              modal was contradicting itself on the one fact a storekeeper needs
              before pressing the button. No behaviour changed here or there —
              this is the sentence catching up with the code.

              BUT THE REPLACEMENT MUST NOT BE ABSOLUTE EITHER. issue-stock.ts:32-38
              names three hand-overs that move no central stock, and two of them
              are ordinary on this screen:
                · LIQUOR-STORE items. centralFlowBlock() (store-engine.ts:211) is
                  keyed on the material's CATEGORY and 23 categories map to LIQUOR
                  STORE; 464 of the 16,353 requisition lines on this database sit
                  in them ('bar' alone is 445). Both sides are gated — no central
                  debit, no department credit, one row stamped store_mapped — so
                  an unqualified "stock moves once, here" is false for them. It is
                  named in the paragraph rather than detected per line: the
                  category→store map lives in store_category_map, which this page
                  has no endpoint for, and guessing at it client-side would be a
                  second copy of a server rule. The grid below is grouped by
                  category, so those lines are visibly under their own headers.
                · PARTY requisitions. applyIssueDelta skips them (skip_reason
                  'party'); the goods move on the party rail instead, and the
                  banner below says so only when this really is one.
              The third case (an unresolvable line unit) is REPORTED by the server
              and printed on the result panel, so it is not claimed here. */}
          {/* AND THE DEBIT NOW HAS A FLOOR. The server refuses an issue that
              would take raw_materials.current_stock below zero — on both issue
              desks and on a direct API call — so "In Stock" below is a LIMIT,
              not just a reading. Said here because it is the one fact that
              changed about the button this storekeeper is about to press.
              "REFUSED AND NOTHING IS SAVED" WAS TRUE ONLY UNTIL ROUND 4: the
              route now issues the covered lines and holds the short one, so a
              line above the balance is NOT issued while the rest go out (a
              whole refusal is left only for a gesture with nothing to hand
              over — the ⛔ panel above the button says which of the two this
              submit will be). */}
          <p className="text-[10px] text-[#8B7355] italic">
            Issuing <b>debits the central store</b> and credits the department — stock moves once, here, when you submit.
            The store <b>cannot be taken below zero</b>: a line above the balance in <b>In Stock</b> is <b>NOT issued</b> and
            stays outstanding while the other lines go out, so get the stock received or a closing count recorded first.
            Liquor-store items (bar / wine / spirits) are the exception: the hand-over is recorded, but the stock itself
            moves on the Liquor Store ledger, not on this one — so the central figure does not limit them.
            A negative figure below means issues have outrun recorded purchases on that material, not that the shelf is empty.
          </p>
          {/* Only on a real party requisition, so the normal case is not made
              noisier by a rule that does not apply to it. Trigger, verbatim from
              store-process route.ts:992: `!linkedPoId && poDropped.length === 0
              && r.purpose === 'party'` — and store-issue/route.ts:432 fires the
              same helper when the requisition finally reaches 'fulfilled', which
              is why "later, when the requisition is completed" is the honest
              second half rather than "never". */}
          {req.purpose === 'party' && (
            <p className="text-[10px] px-3 py-2 bg-indigo-50 border border-indigo-200 rounded text-indigo-900">
              <b>Party requisition.</b> These goods move on the party rail — store → department — not through the issue
              debit above. That transfer runs on this submit only if no vendor PO is raised and no purchase line is
              dropped; otherwise it runs later, when the requisition is completed on Store Requisitions.
            </p>
          )}
          <p className="text-[10px] text-[#8B7355] italic">
            Every quantity below is shown and entered in the material&apos;s <b>purchase unit</b> (PKT / BTL / CASE) — the same unit the HOD approved in. The small grey figure underneath is the exact recipe-unit equivalent; under <b>Issue Now</b> it is what the line stores when this issue goes through (a line marked <b>not issued</b> stores nothing).
          </p>

          {/* A REFUSED SUBMIT. Every 400 store-process raises happens BEFORE its
              transaction opens, so nothing was written and the form below is
              still exactly what the storekeeper typed — correct the named row
              and press the button again. Shown here rather than in an alert()
              so the sentence stays on screen next to the outlined row. */}
          {errorText && (
            <div className="text-[11px] px-3 py-2 bg-red-50 border-2 border-red-300 rounded text-red-900">
              <div className="font-semibold">Nothing was saved — this issue was refused.</div>
              <div className="mt-0.5">{errorText}</div>
              {errorRows.size > 0 && (
                <div className="text-[10px] mt-0.5">The affected line{errorRows.size === 1 ? ' is' : 's are'} outlined in red below.</div>
              )}
            </div>
          )}

          {rejectedCount > 0 && (
            <div className="text-[11px] px-3 py-2 bg-red-50 border border-red-200 rounded text-red-800">
              🚫 <b>{rejectedCount}</b> chef-rejected line{rejectedCount === 1 ? '' : 's'} hidden from this view — they will <b>not</b> be issued or purchased.
              Open the requisition details (collapse this modal and expand the row) to see them.
            </div>
          )}

          {lines.length === 0 && (
            <div className="text-[11px] px-3 py-2 bg-amber-50 border border-amber-200 rounded text-amber-900">
              ⚠ Every line on this requisition was rejected by the chef. Nothing to issue — Cancel out and reject the whole requisition if appropriate.
            </div>
          )}

          {/* ── WHAT THE CENTRAL STORE CAN ACTUALLY GIVE ─────────────────────
              THE SERVER NOW REFUSES AN OVER-ISSUE, so this banner has a job it
              did not have before. It used to describe a negative book balance
              and then say, in its own words, that it was "reporting only: it no
              longer gates what can be issued" — and the rows backed that up by
              seeding the FULL approved demand against a red 0. That sentence is
              now false in both halves: raw_materials.current_stock is the
              ceiling, and the hand-over is refused above it with a 400.

              So the banner says the two things a storekeeper needs before he
              types: HOW MUCH is issuable per line, in the PURCHASE unit (owner
              rule), and WHY the rest cannot go — with the way out, which is a
              received delivery or a recorded closing count, NOT a vendor PO for
              goods that may well be on the premises.

              THE ONE CLAIM IT MUST NOT MAKE is that this screen is the guard.
              It is not, and it cannot be: a liquor / store-mapped line is
              exempt on the server (its stock moves on the Liquor Store ledger)
              and this page has no way to identify one — 156 live lines sit at a
              central balance of 0 and issue perfectly well. Hence "the central
              store's books", the named exception, and a box that stays
              typeable. */}
          {cappedLines.length > 0 && (
            <div className="text-[11px] px-3 py-2 bg-red-50 border-2 border-red-300 rounded text-red-900 space-y-1">
              <div className="font-semibold">
                🚨 The central store&apos;s books cannot cover {cappedLines.length} line{cappedLines.length === 1 ? '' : 's'} — a line asking above the balance is <b>NOT issued</b>.
              </div>
              <ul className="ml-5 list-disc">
                {cappedLines.map(ln => {
                  const c = centralCapOf(ln);
                  return (
                    <li key={ln.id}>
                      <b>{ln.material_name}</b> —{' '}
                      {/* NEVER "issue up to 0": on 508 of the 564 refusable
                          live lines the balance is zero and there is no smaller
                          number to offer, so the empty case gets its own
                          sentence. Same split the server's own message makes. */}
                      {c.sharedWith > 0
                        ? <>the books hold <b>{fmtCapPU(c.booksPU, c.pf)} {c.purchaseUnit}</b>, and all of it goes to {sharedTarget(c.sharedWith)} for the same item, so nothing can be issued on this line.</>
                        : c.empty
                        ? <>the books hold <b>none of it</b>, so nothing can be issued on this line.</>
                        : capClosesLine(ln)
                        /* Round 9: typed down to that figure the take is the whole
                           shelf and THE RULE closes the line — there is no "rest"
                           for a delivery or a count to cover (md_party_typed_full
                           printed "To issue the rest, get the stock received"
                           beside the ⛔ panel's "the line closes"). */
                        ? <>the books hold <b>{fmtCapPU(c.availPU, c.pf)} {c.purchaseUnit}</b> of the {fmtNum(ln.U.toPU(ln.requested))} {ln.U.pu} asked — issue up to that, not more. That takes
                            everything the store holds and the line closes: what is still owed is below the 0.001 {ln.U.pu} the store can issue.</>
                        : <>the books hold <b>{fmtCapPU(c.availPU, c.pf)} {c.purchaseUnit}</b> of the {fmtNum(ln.U.toPU(ln.requested))} {ln.U.pu} asked — issue up to that, not more.</>}
                      {/* The exact stored figure stays visible, negative and
                          all: current_stock is a MATERIAL-level RECIPE figure,
                          so stockPU / the raw value, never the line-basis toPU. */}
                      {ln.U.pf > 1 && (
                        <span className="text-[10px] text-red-800"> (books: {fmtNum(ln.current_stock)} {ln.U.recipeUnit})</span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="text-[10px]">
                {/* Only while some listed line leaves a rest (round 9): a line
                    the cap closes owes nothing anyone can issue. */}
                {cappedLines.some(ln => !capClosesLine(ln)) && (<>
                To issue the rest, get the stock <b>received</b> or a <b>closing count recorded</b> first — that is what
                re-bases the balance the store is measured against. A{' '}
                <a href="/purchase-orders" className="underline">vendor PO</a> is only the answer if the material is
                genuinely finished.
                </>)}
                {negativeStockLines.length > 0 && (
                  <> {negativeStockLines.length} of these read <b>below zero</b>: issues have outrun recorded purchases
                    there, so a physical count is the fix, not a purchase.</>
                )}
                {' '}Liquor-store items (bar / wine / spirits) are the exception — their stock moves on the Liquor Store
                ledger, so this central figure does not gate them and the boxes below stay open.
              </div>
            </div>
          )}

          {/* Books below zero on a line the banner above did not already list
              (it asks for less than 0 — i.e. nothing, so it is not "capped").
              Kept because the deficit still needs a recount; it is a data
              problem, not a refusal. */}
          {cappedLines.length === 0 && negativeStockLines.length > 0 && (
            <div className="text-[11px] px-3 py-2 bg-red-50 border-2 border-red-300 rounded text-red-900 space-y-1">
              <div className="font-semibold">
                🚨 {negativeStockLines.length} line{negativeStockLines.length === 1 ? '' : 's'} show a <b>negative store book balance</b> — recount pending.
              </div>
              <div className="text-[10px]">
                Issues have outrun recorded purchases on these materials. Get a physical count recorded so central can be
                re-based — the store&apos;s balance is what an issue is now measured against.
              </div>
              <ul className="ml-5 list-disc">
                {negativeStockLines.map(ln => (
                  <li key={ln.id}>
                    {/* current_stock is a MATERIAL-level recipe figure — stockPU,
                        never the line-basis toPU. (Was a local re-derivation of
                        the pack guard; one resolver now answers it.) */}
                    <b>{ln.material_name}</b> — books show {ln.U.pf > 1
                      ? `${fmtNum(ln.U.stockPU(ln.current_stock))} ${ln.U.pu} (= ${fmtNum(ln.current_stock)} ${ln.U.recipeUnit})`
                      : `${fmtNum(ln.current_stock)} ${ln.U.pu}`}.
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* THE CHECK COULD NOT ARM ITSELF. The previous attempt at this
              shipped a client cap that fell silently open when its lookup
              failed, and a verifier's whole point was that a guard which
              disarms in silence is worse than none. This screen's cap needs
              current_stock on the payload; if it is not there, the ceiling is
              unknown and the grid says so instead of pretending. The SERVER
              still refuses the over-issue either way — that is the protection,
              and this panel must not suggest otherwise. 0 live lines are in
              this state (current_stock is NOT NULL on all 952 materials). */}
          {unarmedLines.length > 0 && (
            <div className="text-[11px] px-3 py-2 bg-amber-50 border border-amber-300 rounded text-amber-900">
              ⚠ <b>This screen cannot check {unarmedLines.length === lines.length ? 'these lines' : `${unarmedLines.length} line${unarmedLines.length === 1 ? '' : 's'}`} against the store balance</b> — the
              central figure did not come through on this requisition ({unarmedLines.slice(0, 4).map(ln => ln.material_name).join(', ')}
              {unarmedLines.length > 4 ? `, +${unarmedLines.length - 4} more` : ''}). Nothing is capped or warned about here, so
              reload the page before issuing. The central store still will not issue a line it cannot cover, and will name
              the line if it does.
            </div>
          )}

          {/* Opt-in: store manager decides whether to also raise a vendor PO. */}
          <label className="flex items-start gap-2 text-xs cursor-pointer bg-blue-50 border border-blue-200 rounded p-2">
            <input type="checkbox" checked={raisePo} onChange={e => setRaisePo(e.target.checked)}
                   className="mt-0.5" />
            <div>
              {/* "…for the shortfall" made a shortfall read as a PRECONDITION.
                  It is not one: the server takes any positive Buy qty and 99.2%
                  of live requisition lines open with no shortfall at all, so the
                  label was describing a feature the storekeeper could not find.
                  The shortfall is where the Buy box STARTS, which is what the
                  parenthesis now says. */}
              <div className="font-medium text-blue-900">Also raise a vendor PO (pick a vendor to order a line&apos;s shortfall)</div>
              {/* The old sub-copy was true but incomplete, and the gap is what
                  made the feature look broken: it said "lines with a positive
                  Buy qty are bundled" without ever saying that Buy is a box you
                  can type in, while the ₹ and Vendor controls beside an empty
                  Buy box sat greyed out — which reads as "this row is dead". */}
              <div className="text-[10px] text-blue-800 mt-0.5">
                {raisePo
                  ? 'Buy / Unit ₹ / Vendor appear on every line. A short line shows what it is short of as a grey suggestion in the Buy box; picking a vendor fills it in as the quantity to order, and you can type over it or clear it. Nothing is ordered while the box is empty, so an untouched grid still submits. Each Buy line needs a price and a vendor mapped to that item; the lot goes onto ONE purchase order, pending admin approval.'
                  : 'Default OFF. Issuance only — store manager raises POs separately on /purchase-orders.'}
              </div>
              {raisePo && vmError && (
                <div className="text-[10px] text-amber-800 mt-1">
                  ⚠ The vendor → item mapping could not be loaded ({vmError}), so this screen cannot tell you in
                  advance which vendors will be accepted. The server still enforces it and will report any line it drops.
                </div>
              )}
            </div>
          </label>

          <div className="bg-[#FFF8F0] rounded border border-[#E8D5C4] overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[#8B7355]">
                <tr>
                  <th className="text-left  py-1.5 px-2 font-medium">Material</th>
                  <th className="text-right py-1.5 px-2 font-medium">Requested</th>
                  {/* The old tooltip said "issuing does not change this". Under
                      deduct-at-issue it is the opposite: the issue IS the central
                      debit. Left stale, this label would have told the storekeeper
                      the exact inverse of what the button he is about to press does. */}
                  {/* AND IT IS NOW THE CEILING, not just a reading: the server
                      refuses an issue that would take this figure below zero. */}
                  <th className="text-right py-1.5 px-2 font-medium" title="Central store book balance, and the LIMIT an issue is measured against — the store refuses a hand-over that would take it below zero (liquor-store items excepted; those move on the Liquor Store ledger). A negative figure means issues have outrun recorded purchases, not that the shelf is empty.">In Stock*</th>
                  <th className="text-right py-1.5 px-2 font-medium">Issue Now</th>
                  {/* Say what this subtracts. It is NOT "what the store is out
                      of" — it is Requested minus what you are handing over on
                      this line, which is also what the Buy box follows. */}
                  <th className="text-right py-1.5 px-2 font-medium"
                      title="Requested (or HOD-approved) minus Issue Now — what this department is still owed after this hand-over. The Buy box follows this figure until you type over it.">Shortfall</th>
                  {raisePo && <>
                    <th className="text-right py-1.5 px-2 font-medium"
                        title="Quantity to put on the vendor PO. Starts at the Shortfall beside it and is fully editable — type one on any line to order it, whatever the shortfall says; clear it to leave the item off the PO.">Buy</th>
                    <th className="text-right py-1.5 px-2 font-medium" title="Price per the unit shown, seeded from the last purchase of this item. Only used on lines with a Buy qty.">Unit ₹</th>
                    <th className="text-left  py-1.5 px-2 font-medium" title="Vendor for this PO line. It must be mapped to supply this item on Vendor Items, or the server drops the line from the PO.">Vendor</th>
                    <th className="text-right py-1.5 px-2 font-medium">PO Line ₹</th>
                  </>}
                </tr>
              </thead>
              <tbody>
                {/* CATEGORY-WISE, exactly like the read-only Store Inbox table
                    above and like /store-requisitions (page.tsx:1508-1552) —
                    same helper, same rule, so the SAME requisition reads the
                    same way on all three surfaces. This is the grid the store
                    person actually works down while walking the room, so
                    grouping only the read-only table would have left the one
                    screen that matters ordered by name.

                    THE ARRAY ITSELF IS NOT REORDERED. `lines` keeps its original
                    order and its original indices; the map below walks groups of
                    {original index} and reads `lines[i]`, so update(i, …), the
                    POST body, poTotal and every accessor are byte-identical to
                    an ungrouped render. Nothing here is collapsible: a hidden
                    group on a hand-over sheet is a line quietly not issued. */}
                {groupLinesByCategory(lines.map((ln, i) => ({ ...ln, __i: i }))).map(group => (
                <Fragment key={`cat-${group.name}`}>
                  <tr className="bg-[#FFF1E3] border-t border-[#E8D5C4]">
                    {/* 5 columns normally, 9 once Buy / Unit ₹ / Vendor / PO Line ₹
                        appear — same `raisePo` the <thead> and <tfoot> use. */}
                    <td colSpan={raisePo ? 9 : 5}
                        className="py-1 px-2 text-[10px] font-semibold uppercase tracking-wide text-[#8B7355]">
                      {group.name}
                      <span className="ml-1.5 font-normal normal-case">
                        ({group.lines.length} item{group.lines.length === 1 ? '' : 's'})
                      </span>
                    </td>
                  </tr>
                  {group.lines.map(g => {
                  const i = g.__i;
                  const ln = lines[i];
                  const U = ln.U;
                  // Live issued qty in the STORED unit — every comparison below
                  // stays on the stored basis (exact, and it is what gets saved);
                  // only the PRINTING is converted to purchase units.
                  const issued = issuedOf(ln);
                  // THE TAKE, when it is not the typed figure or closes the line
                  // by the shelf (takeOf, round 8). shortOf is 0 on a line the
                  // shelf closes; on every other row it is the subtraction below.
                  const take = takeOf(ln);
                  const short = shortOf(ln);
                  /* OVER-ISSUE. The field is seeded with the APPROVED qty
                     (min(approved, stock)), so a store that physically handed
                     over more had no way to know it could type the real figure —
                     it just submitted the seeded number. The value is allowed
                     and recorded as-is; this only makes it visible.

                     NOTE this is over the APPROVED DEMAND, which the server has
                     never refused and still does not. It is a different question
                     from `overCap` below — over the central STOCK — which the
                     server now refuses with a 400. A line can be either, both,
                     or neither, so the two warnings are separate sentences. */
                  const overIssued = issued - ln.requested > 1e-9;
                  // Negative BOOK balance — a red flag on the row, NOT a lock on
                  // the box. It used to disable the input and force 0; that made
                  // the honest figure untypeable and pushed the line into the PO
                  // block. It now only drives colour + the "recount pending" label.
                  const negStock = Number(ln.current_stock) < 0;
                  /* THE CENTRAL CEILING FOR THIS ROW. `cap.maxLine` is in the
                     LINE's stored unit (the Issue box's own basis); every
                     printed figure goes through the purchase unit. Advisory:
                     the box is NOT clamped and the submit is NOT disabled — see
                     centralCapOf for why (the liquor carve-out this page cannot
                     see), and the server refuses regardless. */
                  const cap      = centralCapOf(ln);
                  const overCap  = overCapOf(ln);
                  /** Recipe-unit hint under a purchase-lead figure. Takes a qty in
                   *  the LINE's stored unit — same signature as the approve grid's
                   *  hint(), so the two screens print identical equivalents. */
                  // On an unpacked material (pack 1) the exact figure when 3 dp
                  // would hide it (round 8b): 3.2174 kg stored reads "3.217".
                  const hint = (q: number) => {
                    if (U.pf > 1) return <div className="text-[9px] text-[#B8A590] font-normal">= {fmtNum(U.toRecipe(q))} {U.recipeUnit}</div>;
                    const r = Math.round((Number(q) || 0) * 1e6) / 1e6;
                    const ex = r.toLocaleString('en-IN', { maximumFractionDigits: 6 });
                    return r > 0 && ex !== fmtNum(r) ? <div className="text-[9px] text-[#B8A590] font-normal">= {ex} {U.recipeUnit}</div> : null;
                  };
                  // PO-side state for this row, all read through the one set of
                  // accessors so the row, the footer and the POST body agree.
                  const buy      = buyOf(ln);
                  const mapWarn  = raisePo && buy > 0 ? mappingWarning(ln) : null;
                  // Picked a vendor and left Buy at 0. Legal, and the server
                  // reports it back as `no_quantity` — but say so BEFORE the
                  // click, since nothing gets ordered for the item.
                  const vendorNoQty = raisePo && buy <= 0 && hasVendor(ln);
                  const rowFlagged  = errorRows.has(ln.id);
                  return (
                    <tr key={ln.id} className={`border-t border-[#E8D5C4]/50 ${
                      rowFlagged ? 'bg-red-100 border-l-4 border-l-red-500'
                      : negStock ? 'bg-red-50/50' : ''}`}>
                      <td className="py-1.5 px-2 font-medium">
                        {ln.material_name}
                        {negStock && (
                          <div className="text-[9px] text-red-700 font-semibold">⚠ Store book balance — recount pending</div>
                        )}
                        {/* A row the books cannot cover, marked on the line
                            itself: a balance of exactly 0 used to carry no flag
                            at all (only a NEGATIVE one did), so on a long sheet
                            the one row that will be refused looked ordinary. */}
                        {cap.capped && !negStock && (
                          <div className="text-[9px] text-red-700 font-semibold">
                            {cap.sharedWith > 0
                              ? `⚠ Store books hold ${fmtCapPU(cap.booksPU, cap.pf)} ${cap.purchaseUnit} — all of it goes to ${sharedTarget(cap.sharedWith)} for the same item`
                              : cap.empty ? '⚠ Store books hold none of this' : `⚠ Store books hold ${fmtCapPU(cap.availPU, cap.pf)} ${cap.purchaseUnit}`}
                          </div>
                        )}
                      </td>
                      {/* Approved demand — printed in the unit the HOD approved
                          in, not the unit it happens to be stored in. */}
                      <td className="py-1.5 px-2 text-right font-mono">
                        {fmtNum(U.toPU(ln.requested))} {U.pu}
                        {hint(ln.requested)}
                      </td>
                      {/* THE FIGURE THE HEADER NOW CALLS THE LIMIT, so it has
                          to read like one. It was coloured on `negStock` alone
                          — current_stock < 0 — and NOT ONE of the 952 live
                          materials is negative (min(current_stock) = 0), so
                          this cell has never once been red on real data. The
                          balance that actually occurs is EXACTLY ZERO: 486 of
                          the 952, behind 1,198 requisition lines the server now
                          refuses. Those printed a plain grey 0 next to a box
                          pre-filled with the full demand, which is the defect
                          this lane was opened for, seen from the cell.
                          `cap.capped` covers both (a negative balance caps too),
                          so the red now appears on every row the store cannot
                          cover and the storekeeper's eye lands on the number
                          rather than only on the banner above. */}
                      <td className={`py-1.5 px-2 text-right font-mono ${negStock || cap.capped ? 'text-red-700 font-bold' : 'text-[#6B5744]'}`}
                          title={`= ${fmtNum(ln.current_stock)} ${U.recipeUnit} (exact)`}>
                        {/* On hand is a MATERIAL-level recipe figure — stockPU,
                            never toPU (which reads the LINE's basis). */}
                        {U.pf > 1
                          ? <>{fmtNum(U.stockPU(ln.current_stock))} {U.pu}{negStock && ' ⚠'}
                              <div className="text-[9px] text-[#B8A590] font-normal">
                                = {fmtNum(ln.current_stock)} {U.recipeUnit}
                              </div></>
                          : <>{fmtNum(ln.current_stock)} {U.pu}{negStock && ' ⚠'}</>}
                      </td>
                      <td className="py-1.5 px-2">
                        {/* Entered in PURCHASE units — the same unit the HOD
                            approved in. min= stops the spinner walking past zero;
                            a typed/pasted minus is stripped here and the value is
                            clamped at USE (issuedOf), so "2." stays typeable. */}
                        {/* NOT disabled on a negative book balance. The books
                            being below 0 says purchases were under-recorded, not
                            that the shelf is empty — locking the box made the
                            storekeeper unable to record a handover he had just
                            physically made. */}
                        {/* STILL NOT CLAMPED, and not disabled either. `max=` is
                            deliberately absent: a hard max would make a liquor /
                            store-mapped line untypeable (the server issues those
                            whatever central says, and this page cannot identify
                            them), which is the one way a convenience turns into
                            lost work. The cap is said, not enforced. */}
                        <input type="number" step="any" min={0}
                               value={ln.issued_pu}
                               onChange={e => update(i, { issued_pu: e.target.value.replace(/^-/, '') })}
                               title={cap.armed
                                 ? (cap.sharedWith > 0
                                   ? `Quantity actually handed over, in ${U.pu || 'units'}. The central store's books hold ${fmtCapPU(cap.booksPU, cap.pf)} ${cap.purchaseUnit} of this material, and all of it goes to ${sharedTarget(cap.sharedWith)} for the same item — so the store will NOT issue this line.`
                                   : cap.empty
                                     ? `Quantity actually handed over, in ${U.pu || 'units'}. The central store's books hold NONE of this material, so the store will NOT issue this line — get stock received or a closing count recorded first. (Liquor-store items are the exception: their stock moves on the Liquor Store ledger.)`
                                     : `Quantity actually handed over, in ${U.pu || 'units'}. The central store's books hold ${fmtCapPU(cap.availPU, cap.pf)} ${cap.purchaseUnit} — more than that is NOT issued.`)
                                 : `Quantity actually handed over, in ${U.pu || 'units'}. Seeded with the approved qty — type the real figure if more or less left the store.`}
                               className={`w-20 px-1.5 py-1 border rounded text-right text-xs ${
                                 overCap ? 'border-red-400 bg-red-50 text-red-900 font-semibold'
                                 : overIssued ? 'border-amber-400 bg-amber-50'
                                 : negStock ? 'border-red-300'
                                 : 'border-[#E8D5C4]'}`} />
                        {/* ── THE CENTRAL REFUSAL, AGAINST THE NAMED LINE ─────
                            The server's OWN sentence when it has spoken about
                            this row (it is written for a storekeeper and names
                            the figures in the purchase unit — printed verbatim,
                            not re-worded), otherwise this screen's own advance
                            warning. Inline, under the box it is about, instead
                            of the alert() this used to be. */}
                        {overCap && (
                          <div className="text-[9px] text-red-800 mt-0.5 text-right font-semibold">
                            {cap.serverMessage
                              ? cap.serverMessage
                              : (cap.empty
                                  ? <>The store&apos;s books hold <b>none</b> of this — the central store will NOT issue this line.</>
                                  : <>Over the store&apos;s balance of <b>{fmtCapPU(cap.availPU, cap.pf)} {cap.purchaseUnit}</b> — the central store will NOT issue this line.</>)}
                          </div>
                        )}
                        {/* ── THE NUMBER TO TYPE, AND A WAY TO TYPE IT ─────────
                            `max_issue_qty` has been on the wire since the floor
                            shipped and NOTHING rendered it: the sentence above
                            states a limit, and the storekeeper was then left to
                            work out what to put in the box. `cap.maxBoxPU` is
                            that same ceiling converted to the unit this box is
                            entered in — since round 6 the balance's SHOWN
                            figure (the In Stock column's own number), which the
                            server accepts and debits as the whole balance, so
                            nothing is left behind; below 0.001 the crumb's exact
                            figure — and the chip writes it straight in, which is
                            the only version of "the number reached the screen"
                            that cannot be mis-transcribed.
                            Hidden when the books hold nothing: a chip offering
                            0 is not a way out, and the sentence above already
                            names the real one (receive stock or count it). */}
                        {overCap && !cap.empty && cap.maxBoxPU > 0 && (
                          <div className="text-[9px] text-red-900 mt-0.5 text-right flex items-center justify-end gap-1">
                            <span>Issuable now: <b className="font-mono">{fmtCapPU(cap.maxBoxPU, cap.pf)} {cap.purchaseUnit}</b></span>
                            {/* THE BUTTON WAITS FOR THE SERVER — see `fromServer`
                                on the cap. Until the server has refused THIS
                                line the ceiling is this screen's reading of a
                                snapshot, and on a liquor / store-mapped line it
                                is simply wrong (central does not govern those
                                and the server issues them regardless). Stating the
                                number is as wrong as the sentence above it
                                already is; turning it into one click that cuts a
                                legitimate full issue down to the central balance
                                is not. */}
                            {cap.fromServer && (
                              <button type="button"
                                      /* Sets the SEED as well, and that is not
                                         belt-and-braces. issuedOf() posts
                                         `issued_seed` verbatim whenever the box
                                         still reads toPU(seed) — there to stop a
                                         quantity nobody touched round-tripping
                                         through a 3-dp display. If the cap and
                                         the seed ever round into the same 3rd
                                         decimal, that shortcut would post the
                                         SEED where this button promised the cap,
                                         and the line would be refused again by
                                         the figure it was told to use. Writing
                                         both makes the two branches of issuedOf
                                         return the same number. */
                                      onClick={() => update(i, {
                                        issued_pu: String(cap.maxBoxPU),
                                        issued_seed: U.fromPU(cap.maxBoxPU),
                                      })}
                                      title={`Put ${fmtCapPU(cap.maxBoxPU, cap.pf)} ${cap.purchaseUnit} in the Issue box — the most this line can hand over against the store's books`}
                                      className="px-1 py-[1px] rounded border border-red-400 bg-white hover:bg-red-50 font-semibold">
                                use it
                              </button>
                            )}
                          </div>
                        )}
                        {/* Same warning as before, said in purchase units: the
                            over-issue is measured on the exact stored basis, only
                            the two printed figures are converted. */}
                        {overIssued && (
                          <div className="text-[9px] text-amber-800 mt-0.5 text-right">
                            {fmtNum(U.toPU(issued - ln.requested))} {U.pu} over
                            the approved {fmtNum(U.toPU(ln.requested))} {U.pu} — recorded as issued
                          </div>
                        )}
                        {/* The box reads in the PURCHASE unit; store-process still
                            persists the number in the line's own stored unit
                            (ReqItem documents quantity_issued as ri.unit) — the
                            hint below is that stored figure, so the store user can
                            see both sides of the one conversion. */}
                        <span className="ml-1 text-[10px] text-[#8B7355]">{U.pu}</span>
                        {/* What gets STORED (the header's promise): the take's
                            record when the shelf rule takes a balance that is not
                            the typed figure — 14,842.4 g, not 14,842 (round 8b).
                            A line the store will NOT issue stores nothing, so its
                            typed figure is not printed as one (round 9,
                            md_held_row: "= 15,000 g" under a held line). */}
                        {overCap
                          ? <div className="text-[9px] text-red-700 font-normal">
                              {U.pf > 1 && <>= {fmtNum(U.toRecipe(issued))} {U.recipeUnit} asked — </>}not issued, nothing is stored on this line
                            </div>
                          : hint(take?.changed ? take.recordedLine : issued)}
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono">
                        {/* requested − issued: both stored-basis, printed in PU. */}
                        {short > 0
                          ? <span className="text-amber-700">{fmtNum(U.toPU(short))} {U.pu}</span>
                          : <span className="text-emerald-700">0 {U.pu}</span>}
                        {short > 0 && hint(short)}
                        {/* A HELD line (heldOf): the figure above is requested −
                            typed, which the Buy box follows; what the line owes
                            once this submit has issued the rest is everything it
                            owed before — said here, beside it (round 9). */}
                        {heldOf(ln) && (() => {
                          const owed = Math.max(0, ln.requested - ln.already_issued);
                          return (
                            <div className="text-[9px] font-sans text-red-800 mt-0.5 text-right max-w-[14rem] ml-auto font-semibold">
                              held — nothing goes out on this line, so {fmtNum(U.toPU(owed))} {U.pu}
                              {U.pf > 1 && <> (= {fmtNum(U.toRecipe(owed))} {U.recipeUnit})</>} stays owed
                            </div>
                          );
                        })()}
                        {/* What leaves the shelf and what it leaves the line at —
                            only when the take is not the typed figure or THE RULE
                            closes the line (takeOf). Round 8. */}
                        {take && (() => {
                          const takePU = U.stockPU(take.takeRecipe);
                          const rem = Math.max(0, ln.requested - take.recordedLine);
                          const remPU = U.isPU ? rem : rem / (U.pf || 1);
                          return (
                            <div className="text-[9px] font-sans text-emerald-800 mt-0.5 text-right max-w-[14rem] ml-auto"
                                 title="The central store's shelf rule: a figure that IS the balance's shown figure takes the whole balance and lands the shelf on exactly 0. The line records what left the shelf.">
                              takes everything the store holds — {takePU > 0 ? fmtNum(takePU) : fmtCapPU(take.takeRecipe / (U.pf || 1), U.pf)} {U.pu}
                              {U.pf > 1
                                ? <> (= {fmtNum(take.takeRecipe)} {U.recipeUnit})</>
                                // Unpacked (pf 1): the exact figure when 3 dp would hide it
                                // (WHOLE DHANIYA 3.2174 kg prints 3.217 above).
                                : (Math.round(take.takeRecipe * 1e6) / 1e6) !== takePU
                                  ? <> (= {(Math.round(take.takeRecipe * 1e6) / 1e6).toLocaleString('en-IN', { maximumFractionDigits: 6 })} {U.recipeUnit})</>
                                  : null}
                              {take.byShelf && rem > 1e-9 && (
                                <> — the line closes: the {fmtCapPU(remPU, U.pf)} {U.pu}{U.pf > 1 && <> (= {fmtNum(U.toRecipe(rem))} {U.recipeUnit})</>} still
                                  owing is below the 0.001 {U.pu} the store can issue</>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      {raisePo && <>
                        <td className="py-1.5 px-2">
                          <div className="flex items-center gap-1">
                            {/* Buy qty is ALREADY on the PO's own basis (whatever
                                po_entry_unit says, defaulted to the purchase unit)
                                — it is NOT put through the issue-side conversion,
                                or the rate would end up on the other basis from
                                the qty. Raw string only so decimals stay typeable. */}
                            {/* buyStr(), not ln.quantity_to_purchase: once this
                                line has a vendor the box FOLLOWS the Shortfall
                                column beside it. buy_touched freezes it the
                                moment he types — including clearing it, which is
                                how a line is taken off the PO. Before a vendor is
                                picked the shortfall shows as the PLACEHOLDER
                                (buyHint) instead of a value: visible, but not an
                                order, so an untouched grid never locks the submit
                                button. See buyStr() for why. */}
                            <input type="number" step="any" min={0}
                                   value={buyStr(ln)}
                                   placeholder={buyHint(ln)}
                                   onChange={e => update(i, {
                                     quantity_to_purchase: e.target.value.replace(/^-/, ''),
                                     buy_touched: true,
                                   })}
                                   title={ln.buy_touched
                                     ? `Quantity to order, in ${ln.po_entry_unit || 'units'} (the unit the rate beside it is per). You have set this by hand — clear the box to leave this item off the PO.`
                                     : hasVendor(ln)
                                       ? `Quantity to order, in ${ln.po_entry_unit || 'units'} (the unit the rate beside it is per). Following the Shortfall column — type over it to order a different amount, or clear it to leave this item off the PO.`
                                       : `${buyHint(ln) ? `${buyHint(ln)} ${ln.po_entry_unit || 'units'} is short. ` : ''}Nothing is ordered for this item yet — pick a vendor to put the shortfall on the PO, or type a quantity here to order it anyway.`}
                                   className="w-20 px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs" />
                            {/* Unit selector only when the two units really differ
                                (ln.pack_size is the canon-guarded factor, so > 1
                                means recipe unit ≠ purchase unit — never two
                                identical options). User picks which one they're
                                entering qty / price in; the math + submit
                                conversion both follow. */}
                            {ln.pack_size > 1 ? (
                              <select value={ln.po_entry_unit}
                                      onChange={e => {
                                        const newUnit = e.target.value;
                                        const oldUnit = ln.po_entry_unit;
                                        if (newUnit === oldUnit) return;
                                        // Convert the existing qty + price between
                                        // recipe and purchase units so the line
                                        // total stays the same after the switch.
                                        //
                                        // THIS IS A BASIS SWITCH, NOT A NEW ORDER,
                                        // so neither half may move. Two things
                                        // used to move it, both silently:
                                        //   · Math.ceil on the quantity. 500 g
                                        //     switched to kg became ceil(0.5) = 1
                                        //     kg — the line DOUBLED, ₹50.82 →
                                        //     ₹101.64, one click. Rounding up to a
                                        //     whole pack is right when SEEDING a
                                        //     fresh order (autoBuyQty does it, for
                                        //     countable units only); it is never
                                        //     right when re-expressing a quantity
                                        //     the storekeeper has already decided.
                                        //   · 2-dp rounding on the price. ₹101.64
                                        //     per kg became ₹0.10 per g instead of
                                        //     ₹0.10164, and switching back read
                                        //     ₹100 — 1.61% of a money field gone,
                                        //     with the original rate unrecoverable.
                                        // 6 dp is the precision lineUnits already
                                        // rounds entered figures to, and it is
                                        // enough to make the round trip exact
                                        // while keeping the float noise
                                        // (0.10164000000000001) out of the box.
                                        const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
                                        const goingToPurchase = newUnit === ln.purchase_unit;
                                        const newQty   = round6(goingToPurchase
                                          ? buyOf(ln) / ln.pack_size
                                          : buyOf(ln) * ln.pack_size);
                                        const newPrice = round6(goingToPurchase
                                          ? priceOf(ln) * ln.pack_size
                                          : priceOf(ln) / ln.pack_size);
                                        // Back to strings — the boxes hold raw text (blank stays blank).
                                        // An UNTOUCHED Buy box is not rewritten:
                                        // autoBuyQty() already reads po_entry_unit
                                        // and re-expresses the shortfall in the new
                                        // unit itself. Writing a converted figure
                                        // here would silently freeze it as a manual
                                        // override.
                                        update(i, {
                                          po_entry_unit: newUnit,
                                          ...(ln.buy_touched
                                            ? { quantity_to_purchase: newQty > 0 ? String(newQty) : '' }
                                            : {}),
                                          unit_price: newPrice > 0 ? String(newPrice) : '',
                                        });
                                      }}
                                      title="Switch between vendor's purchase unit and recipe unit. Math stays consistent."
                                      className="px-1 py-1 border border-[#E8D5C4] rounded text-xs bg-white">
                                <option value={ln.purchase_unit}>{ln.purchase_unit}</option>
                                <option value={ln.material_unit}>{ln.material_unit}</option>
                              </select>
                            ) : (
                              <span className="text-[10px] text-[#8B7355]">{ln.po_entry_unit}</span>
                            )}
                          </div>
                          {ln.pack_size > 1 && (
                            <div className="text-[9px] text-[#8B7355] mt-0.5">
                              1 {ln.purchase_unit} = {ln.pack_size} {ln.material_unit}
                            </div>
                          )}
                          {/* Recipe-unit equivalent of what is being ordered —
                              only meaningful while the box is on the purchase
                              basis (the recipe option already IS recipe units). */}
                          {ln.pack_size > 1 && ln.po_entry_unit === ln.purchase_unit && buyOf(ln) > 0 && (
                            <div className="text-[9px] text-[#B8A590]">
                              = {fmtNum(buyOf(ln) * ln.pack_size)} {ln.material_unit}
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 px-2">
                          {/* ₹ per po_entry_unit — same basis as the qty beside it,
                              so rate × qty is one basis end to end. Raw string for
                              the same reason as the qty: "450." must stay typeable. */}
                          {/* NOT disabled on a 0 Buy qty any more. Greying the
                              price and the vendor out was what made a fully
                              stocked row read as dead — the storekeeper saw
                              "Shortfall 0 / — pick vend…" in grey and concluded
                              the feature was broken, when the enabled Buy box
                              beside it was the way in the whole time. Both are
                              live now; a vendor without a qty is reported by the
                              server as `no_quantity` and warned about below. */}
                          <input type="number" step="any" min={0} value={ln.unit_price}
                                 onChange={e => update(i, { unit_price: e.target.value.replace(/^-/, '') })}
                                 title={`Price per ${ln.po_entry_unit}. Seeded from the last purchase of this item; only used if this line has a Buy qty.`}
                                 className={`w-20 px-1.5 py-1 border rounded text-right text-xs ${
                                   buy > 0 && !(priceOf(ln) > 0) ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4]'}`} />
                          <span className="ml-1 text-[10px] text-[#8B7355]">/{ln.po_entry_unit}</span>
                          {buy > 0 && !(priceOf(ln) > 0) && (
                            <div className="text-[9px] text-amber-800 mt-0.5">Price required — a PO cannot be raised at ₹0.</div>
                          )}
                        </td>
                        <td className="py-1.5 px-2">
                          {/* Vendor dropdown — mapped vendors for this material
                              first (curated via /vendors/materials), then the
                              full active-vendor catalog. The unmapped ones stay
                              on the list ON PURPOSE: the server DROPS such a line
                              rather than refusing the request, so hiding them
                              here would not prevent anything, and on this data 42%
                              of requisitioned materials have no mapping at all —
                              a store person needs to see that and be told why,
                              not handed an empty dropdown. Each one is labelled,
                              and the row warns underneath. */}
                          {(() => {
                            const mapped  = vendorsByMaterial[ln.material_id] || [];
                            const mappedIds = new Set(mapped.map(v => v.id));
                            const others  = allVendors.filter(v => !mappedIds.has(v.id));
                            return (
                              <select value={ln.vendor_id}
                                      onChange={e => {
                                        const vid = e.target.value;
                                        const v = [...mapped, ...others].find(x => x.id === vid);
                                        update(i, { vendor_id: vid, vendor: v?.name || '' });
                                      }}
                                      title={!vmReady
                                        ? 'The vendor → item mapping has not loaded, so this list is not filtered. The server still enforces it.'
                                        : mapped.length > 0
                                          ? `${mapped.length} vendor(s) mapped to this material on Vendor Items. Anyone else will be refused and the line dropped from the PO.`
                                          : 'NO vendor is mapped to this material yet, so every option here will be refused. Map one on Vendor Items first.'}
                                      className={`w-36 px-1.5 py-1 border rounded text-xs bg-white ${
                                        mapWarn ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4]'}`}>
                                <option value="">— pick vendor —</option>
                                {mapped.length > 0 && (
                                  <optgroup label={`Mapped to ${ln.material_name}`}>
                                    {mapped.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                                  </optgroup>
                                )}
                                {others.length > 0 && (
                                  <optgroup label={!vmReady
                                    ? 'All active vendors (mapping not loaded)'
                                    : mapped.length > 0 ? 'Other active vendors — NOT mapped to this item' : 'All active vendors — NONE mapped to this item'}>
                                    {others.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                                  </optgroup>
                                )}
                              </select>
                            );
                          })()}
                          {/* The whole point of loading the mapping: say it HERE,
                              before submit. Afterwards the requisition is
                              store_processed and this modal is unreachable. */}
                          {mapWarn && (
                            <div className="text-[9px] text-amber-800 mt-0.5 max-w-[9rem]">
                              ⚠ {mapWarn}{' '}
                              <a href="/vendors/materials" target="_blank" rel="noopener noreferrer" className="underline">Vendor Items</a>
                            </div>
                          )}
                          {vendorNoQty && (
                            <div className="text-[9px] text-amber-800 mt-0.5 max-w-[9rem]">
                              ⚠ Buy qty is 0 — nothing will be ordered for this item.
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono"
                            title={buyOf(ln) > 0 ? `${fmtNum(buyOf(ln))} × ₹${priceOf(ln)} per ${ln.po_entry_unit}` : ''}>
                          {buyOf(ln) > 0
                            ? '₹' + (buyOf(ln) * priceOf(ln)).toFixed(0)
                            : <span className="text-[#8B7355]">—</span>}
                        </td>
                      </>}
                    </tr>
                  );
                  })}
                </Fragment>
                ))}
              </tbody>
              {raisePo && (
                <tfoot>
                  {/* EVERY Buy line, including any the mapping rule will drop —
                      so this is what was ASKED FOR, not necessarily what the PO
                      will be worth. The blue panel under the table states the
                      net figure; labelling this one "Vendor PO total" while a
                      line was silently dropped is how the screen came to promise
                      a PO of ₹365 and write one of ₹320. */}
                  <tr className="border-t border-[#E8D5C4] font-semibold bg-white">
                    <td colSpan={8} className="py-1.5 px-2 text-right"
                        title="Sum of every line with a Buy qty. Lines flagged for an unmapped vendor are included here but will not reach the PO.">
                      Buy lines total
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono">₹{poTotal.toFixed(0)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div className={`grid grid-cols-1 ${raisePo ? 'sm:grid-cols-3' : ''} gap-3`}>
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              Store note (optional)
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                        placeholder="e.g. Issued at 11:30 to Hot Kitchen; rest pending Tuesday delivery"
                        className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]" />
            </label>
            {raisePo && (
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Vendor PO date
                <input type="date" value={poDate} onChange={e => setPoDate(e.target.value)}
                       className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]" />
              </label>
            )}
            {raisePo && (
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Expected Delivery Date
                <input type="date" value={poDeliveryDate} onChange={e => setPoDeliveryDate(e.target.value)}
                       className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]" />
                <span className="text-[9px] text-[#B8A590]">Optional — leave blank if the vendor hasn&apos;t committed a date.</span>
              </label>
            )}
          </div>

          {/* ── WHAT HAPPENS TO A LINE THE STORE CANNOT COVER ─────────────────
              Shown in ALL THREE modes below (PO ticked, short, fully issued),
              because it outranks each of them.

              IT USED TO SAY THE OPPOSITE OF WHAT THE SERVER DOES. Written when
              store-process refused the whole gesture over one short line, it
              told the storekeeper "the store will refuse the whole issue and save
              nothing ... the whole gesture replays". Since round 4 the route
              ISSUES every line the books cover and HOLDS the short one — leaves
              its quantity_issued as it was, so it stays outstanding — and
              answers 200 with `held_lines` (store-process/route.ts, "NOT ONE
              LINE CAN BE HANDED OVER ⇒ STILL REFUSED WHOLE"). The 400 survives
              in exactly one case: not one line of the gesture hands anything
              over (`issuableLines === 0` there, `refusedWhole` here — the same
              test: a line that clears the floor AND posts more than it already
              holds). So the panel says whichever of the two is about to happen.

              THE HOLD IS A ONE-WAY DOOR ON THIS SCREEN, and that is the sentence
              it most needs: the submit moves the requisition out of the two
              statuses `canStoreAct` opens this modal on, so the held quantity
              can only be issued afterwards from /store-requisitions (the
              sidebar's "Issue Requisitions"). Said BEFORE the click, while
              lowering the number to what the store holds is still one edit away.

              IT DOES NOT DISABLE THE BUTTON, and that is a decision, not an
              omission. The submit gate at the bottom of this modal is reserved
              for things this screen can be SURE the server refuses (a Buy line
              with no price or no vendor). An over-issue is not one of them: a
              liquor / store-mapped line is exempt on the server and
              unidentifiable here, so a lock would stop 156 real live lines dead.
              No confirm() either: a hold writes the covered lines and reports
              the held one on the result panel, and a whole refusal writes
              nothing and is replayable — a dialog would be friction on every bar
              hand-over for a message already on screen. */}
          {overCapLines.length > 0 && (() => {
            const n = overCapLines.length;
            const one = n === 1;
            return (
              <div className="text-[11px] px-3 py-2 bg-red-50 border-2 border-red-300 rounded text-red-900">
                <div className="font-semibold">
                  ⛔ {n} line{one ? '' : 's'} ask{one ? 's' : ''} for more than the central store&apos;s books hold
                  {partyWhole ? (
                    <> — a party requisition&apos;s goods leave the store in one transfer, every line at once, so the store
                      will <b>refuse the whole issue</b> and save nothing, the other lines included.</>
                  ) : refusedWhole ? (
                    <> — and no other line hands anything over, so the store will <b>refuse the whole issue</b> and save nothing.</>
                  ) : zeroEntryLines.length === 0 ? (
                    <> — on submit {one ? 'it is' : 'they are'} <b>NOT issued and {one ? 'stays' : 'stay'} outstanding</b>.
                      Every other line is issued.</>
                  ) : (
                    /* A line entered as 0 goes out with nothing either — named
                       before "every other line", so that sentence excludes it.
                       Separate branch: no such line ⇒ the markup above, as before. */
                    <> — on submit {one ? 'it is' : 'they are'} <b>NOT issued and {one ? 'stays' : 'stay'} outstanding</b>.
                      {' '}{zeroEntrySentence(zeroEntryLines.map(ln => ln.material_name))}{' '}Every other line is issued.</>
                  )}
                </div>
                <div className="text-[10px] mt-0.5">
                  {overCapLines.map(ln => {
                    const c = centralCapOf(ln);
                    // The store desk's words for a row its sibling empties.
                    if (c.sharedWith > 0) {
                      return `${ln.material_name} (books: ${fmtCapPU(c.booksPU, c.pf)} ${c.purchaseUnit}, and all of it goes to ${sharedTarget(c.sharedWith)} for the same item)`;
                    }
                    return `${ln.material_name} (books: ${c.empty ? 'none' : `${fmtCapPU(c.availPU, c.pf)} ${c.purchaseUnit}`})`;
                  }).join(', ')}
                  .{' '}
                  {refusedWhole && overCapLines.every(ln => capClosesLine(ln)) ? (
                    /* Round 8b: the cap takes everything left and closes the
                       line — there is no "rest" to receive stock for. */
                    <>Lower {one ? 'that line' : 'those lines'} to what the store can give — it then takes everything the
                      store holds and {one ? 'the line closes' : 'the lines close'} (what is still owed is below one printed
                      step). The whole gesture replays once the number is corrected.</>
                  ) : refusedWhole ? (
                    <>Lower {one ? 'that line' : 'those lines'} to what the store can give — the rest needs stock received
                      or a closing count recorded. The whole gesture replays once the number is corrected.</>
                  ) : (
                    <>Lower {one ? 'that line' : 'those lines'} to what the store can give and {one ? 'it goes' : 'they go'} out
                      with the rest. Left as {one ? 'it is' : 'they are'}, this requisition can no longer be issued from this
                      screen afterwards — the held quantity is issued on{' '}
                      <a href="/store-requisitions" className="underline font-semibold">Issue Requisitions</a>.</>
                  )}
                  {' '}If {one ? 'it is' : 'they are'} liquor-store items, the stock moves on the Liquor
                  Store ledger and the store will accept the hand-over as entered.
                </div>
              </div>
            );
          })()}

          {/* WHAT WILL ACTUALLY HAPPEN, counted off the same accessors the POST
              body uses. The old text asserted a PO unconditionally ("+ new vendor PO
              created in pending status") the moment the box was ticked, even
              with every Buy box empty — and claimed "no stock change", which is
              the opposite of what the issue does (see the note at the top).

              ALL THREE OF THESE ARE PROMISES ABOUT SUBMIT, so each is shown
              only while it will come true:
                · REFUSED WHOLE (the panel above says the store writes NOTHING):
                  all three are silenced — none of them would have happened, and
                  "requisition will move to Fulfilled on submit" directly beneath
                  "the store will refuse the whole issue and save nothing" is the
                  screen contradicting the server on the one screenful where it
                  matters most.
                · A LINE HELD, the rest issued: the PO panel and the "short" panel
                  stay — the issue IS recorded and the PURCHASE half is not held
                  (store-process/route.ts: "THE PURCHASE HALF IS NOT HELD"), so
                  both are still true. Only "Every line fully issued — Fulfilled"
                  is silenced: the held line stays outstanding, so the
                  requisition does not close, and the panel above has said so.
              `overCapLines` — NOT `cappedLines` — is deliberately the test: a
              line the books cannot cover in FULL is fine as long as the
              storekeeper has typed a figure the store can actually give, and
              that partial issue really will be recorded and really will leave
              the requisition short. Only a quantity the server would hold back
              makes any of these false. */}
          {refusedWhole ? null : raisePo ? (() => {
            const buyLines  = lines.filter(ln => buyOf(ln) > 0);
            // Same predicate as submit()'s confirm — vendor named AND rejected
            // by the mapping rule. A line with no vendor yet is a different
            // problem and the footer's blocked-reason owns it.
            const dropLines = buyLines.filter(ln => hasVendor(ln) && !!mappingWarning(ln));
            const keepLines = buyLines.filter(ln => !dropLines.includes(ln));
            const netTotal  = keepLines.reduce((s, ln) => s + buyOf(ln) * priceOf(ln), 0);
            return (
              <div className={`text-[11px] px-3 py-2 rounded border ${
                buyLines.length === 0 ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-blue-50 border-blue-200'}`}>
                {buyLines.length === 0 ? (
                  <>⚠ <b>No line has a Buy qty</b>, so <b>no vendor PO will be raised</b> — only the issue will be recorded.
                    Type a Buy qty on any line to order it (it fills itself from the Shortfall column), or untick the box — either way the hand-over is recorded.</>
                ) : (
                  /* "the issue is recorded", not "central stock is debited": on a
                     liquor-store line or a party requisition it is recorded
                     without that debit (see the note at the top of this modal),
                     and this panel cannot tell which lines those are. */
                  /* EVERY Buy line dropped (round 9): no PO is created at all —
                     the server answers "No purchase order was raised" — so "0 of
                     1 Buy line go onto ONE vendor PO worth ₹0, created pending
                     admin approval" described a document that never exists. */
                  keepLines.length === 0 ? (
                    <>On submit: the issue is recorded against the requisition, and <b>no vendor PO will be raised</b> —{' '}
                      <span className="text-amber-800 font-semibold">
                        {dropLines.length === 1 ? 'the only Buy line' : `all ${dropLines.length} Buy lines`} will be DROPPED for an
                        unmapped vendor ({dropLines.map(ln => ln.material_name).join(', ')}) — you will be asked to confirm.
                      </span>{' '}
                      The Buy quantity stays recorded on the requisition, to be ordered on Purchase Orders once the vendor is mapped.</>
                  ) :
                  <>On submit: the issue is recorded against the requisition and{' '}
                    <b>{keepLines.length}</b> of {buyLines.length} Buy line{buyLines.length === 1 ? '' : 's'}{' '}
                    go onto ONE vendor PO worth <b>₹{netTotal.toFixed(0)}</b>, created <b>pending admin approval</b>.
                    Stock only increases again when that PO is received via GRN.
                    {dropLines.length > 0 && (
                      <> <span className="text-amber-800 font-semibold">
                        {dropLines.length} line{dropLines.length === 1 ? '' : 's'} will be DROPPED for an unmapped vendor
                        ({dropLines.map(ln => ln.material_name).join(', ')}) — you will be asked to confirm.
                      </span></>
                    )}
                  </>
                )}
              </div>
            );
          })() : totalShortfall > 0 ? (
            <div className="text-[11px] px-3 py-2 bg-amber-50 border border-amber-200 rounded">
              ⚠ <b>{shortLineCount}</b> line{shortLineCount === 1 ? ' is' : 's are'} short of the requested qty above. To buy the rest, either tick "Also raise a vendor PO" above, or raise POs separately on the <a href="/purchase-orders" className="underline">Purchase Orders</a> page.
            </div>
          ) : overCapLines.length > 0 ? null : (
            <div className="text-[11px] px-3 py-2 bg-emerald-50 border border-emerald-200 rounded">
              {/* A line THE RULE closes by the shelf is complete, not "fully
                  issued" — it owes less than one printed step the store cannot
                  give. Said so only when there is one; otherwise the original
                  sentence, byte for byte (round 8). */}
              {lines.some(ln => takeOf(ln)?.byShelf)
                ? <>✓ Every line complete — the lines marked &quot;takes everything the store holds&quot; close below one printed step — requisition will move to <b>Fulfilled</b> on submit.</>
                : <>✓ Every line fully issued — requisition will move to <b>Fulfilled</b> on submit.</>}
            </div>
          )}
        </div>
        {/* Submit gate.
            TICKING THE BOX NO LONGER BLOCKS THE HAND-OVER. It used to: with
            every Buy box empty — the state 99.2% of live requisition lines open
            in — `poReady` was false and the button was disabled outright, so a
            storekeeper who ticked the box could not record the goods he had
            just handed over until he unticked it again. "No Buy qty" is a
            legitimate outcome (the store had everything), the server says so in
            its own words, and the blue panel above says it before the click.
            What still disables the button is only what the SERVER would refuse
            with a 400 — a Buy line missing its price or its vendor — because
            that 400 throws away the issue as well. An unmapped vendor is NOT in
            this list: the server accepts that request and reports the drop, so
            it is a confirm() inside submit(), not a lock. */}
        {(() => {
          const buyLines = lines.filter(ln => buyOf(ln) > 0);
          const missingPrice  = raisePo ? buyLines.find(ln => !(priceOf(ln) > 0))  : undefined;
          const missingVendor = raisePo ? buyLines.find(ln => !hasVendor(ln))      : undefined;
          const poReady = !missingPrice && !missingVendor;
          const blockedReason = missingPrice
            ? `"${missingPrice.material_name}" has a Buy qty but no unit price — a PO cannot be raised at ₹0, and the server would refuse the whole issue.`
            : missingVendor
              ? `"${missingVendor.material_name}" has a Buy qty but no vendor — pick one, or clear its Buy box to leave it off the PO.`
              : '';
          return (
            <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2">
              {!poReady && (
                <span className="mr-auto text-[11px] text-amber-800">{blockedReason}</span>
              )}
              <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
              <button onClick={submit} disabled={busy || !poReady}
                      title={!poReady ? blockedReason : ''}
                      className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded-lg disabled:opacity-40 disabled:cursor-not-allowed">
                {/* The label states what this click will actually do — it used to
                    promise "Issue + Raise PO" on a tick with nothing to buy. */}
                {busy ? 'Recording…' : (raisePo && buyLines.length > 0 ? 'Issue + Raise PO' : 'Issue to Department')}
              </button>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
