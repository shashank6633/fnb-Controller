'use client';

/**
 * Store Requisitions — the store team's daily issue desk.
 *
 * Lists every requisition that's been approved by Chef + Mgmt and is waiting
 * for the store to actually hand items over. For each line the store can:
 *   - Issue Now → records qty + timestamp + issuer; supports partial issue
 *                  (e.g. requested 5 kg, issued 3 kg now, issue 2 kg later).
 *   - Defer    → set a "I'll bring it at 7pm" timestamp + reason. The line
 *                  stays open and surfaces under the Deferred filter.
 *   - Undo     → clear actions on a line (mistakes happen).
 *
 * MERGE INTO ONE PO (owner rulings #63-#70, 2026-10-23) — the header button and
 * "Add to a merged PO" on a deferred line open the shared MergePoModal: owed
 * lines from every department onto ONE draft PO, one vendor per item, many
 * vendors per PO, a GRN per vendor bill under the same number. Store manager +
 * admin only. It BUYS; it never issues. Each line then wears one badge from the
 * feed — On PO-… / Arrived — GRN-… / Delivered direct — do not issue / Vendor
 * closed — not delivered — and is issued from here as today once it arrives
 * (#64). A delivered-direct line is the one exception: its goods went straight
 * to a department, so it is never issued from central (#68).
 *
 * UNDO IS OFFERED ON A FULFILLED REQUISITION TOO, and that is deliberate. The
 * requisition auto-advances to 'fulfilled' the instant the last line is
 * satisfied, so the ordinary mistake — the storekeeper issues the final line,
 * the card flips to fulfilled, he immediately sees the quantity was wrong — has
 * to be correctable from here or it is not correctable at all. Do not re-hide
 * the button behind a status test; the reversal itself is gated server-side.
 *
 * REVERSALS CAN BE REFUSED. Under department-based inventory an undo/reject
 * hands goods back from the kitchen to central, and the kitchen may have
 * already cooked them. The server refuses rather than clamping (see
 * BlockedReversal below); this page shows that refusal ON THE LINE, not as a
 * toast that disappears with the numbers still on it.
 *
 * Status auto-advances:
 *   mgmt_approved / chef_approved → store_processed (once any action taken)
 *   store_processed → fulfilled (when every non-rejected, non-deferred line
 *                                is complete by THE RULE — quantity_issued >=
 *                                chef_approved_qty, or a take emptied the
 *                                central shelf and less than one printed step
 *                                is still owed; see lineIssueComplete).
 *
 * 'fulfilled' IS A WORKFLOW STATE, NOT A DELIVERY CLAIM, and this page prints
 * three different words for it — Fulfilled / Closed short / Closed — depending
 * on what was actually handed over. A rejected line counts as "done" in that
 * rule, so a requisition where the store rejected everything reached
 * 'fulfilled' and the card said "Fulfilled" at somebody holding an empty tray.
 * See deliveryState(): display only, no new status, the route's rule untouched.
 *
 * The tabs are ROLL-UPS of the line columns, not a second status field, so one
 * requisition can legitimately sit in more than one: a half-issued req is in
 * "Issued Today" (goods did move) AND "Balance Pending" (goods are still owed).
 * "Deferred" is NOT a synonym for either — it means a line carries a promised
 * date/time (deferred_until), which only a human sets.
 *
 * Each line carries an `issue_history` JSON array of {qty, at, by, note},
 * so split-issues are fully traceable. The /audit page shows the per-line
 * + req-level audit_events written by the store-issue endpoint.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  Package, Loader2, RefreshCw, Search, Clock, CheckCircle2, AlertCircle,
  Send, RotateCcw, ChevronRight, ChevronDown, History, User as UserIcon, XCircle,
  Hourglass, Split, Merge,
} from 'lucide-react';
import { api } from '@/lib/api';
// MERGED PO (owner rulings #63-#70): the shared "Merge into one PO" modal and
// the per-line badges it leaves behind (on a PO / arrived / delivered direct /
// vendor closed). The modal never issues anything — its ticks are its own
// state, never this desk's Issue Selected set.
import MergePoModal, {
  MergeLineBadge, isDeliveredDirect, deliveredDirectDept, onOpenPo, isVendorClosed, hasMergeState,
  type MergeLineFields,
} from '@/components/MergePoModal';
import { fmtIST, fmtISTDate, fmtISTIsoDate, fmtISTShort, todayIST } from '@/lib/format-date';
import TabScroller from '@/components/TabScroller';
import { packFactor, shownPurchaseQty, type PackMeta } from '@/lib/pack-units';
// THE RULE and the shelf take, as both desks run them — ONE transcription of the
// server's (central-debit-clamp.ts / issue-stock.ts), proved against it by
// scripts/desk-rule-tests.ts. Never re-type any of it on this page.
import {
  deskLineComplete, deskLineBasis, planDeskDebit, forecastDeskTake, type DeskTakeForecast,
  forecastDeskPartyTransfer, deskPartyHeadroom, deskCovers, type DeskPartyForecast, type DeskPartyShort,
} from '@/lib/desk-rule';
// ROUTED LINES (rulings #45, #74): a line for an item a Direct Issue rule sends
// straight to another department (Meat / Poultry / Seafood → Kitchen) is that
// department's to send, by department transfer — never issued from here. The
// server stamps it (`routed_department_id`, `routed` on the ?id= feed); this
// desk only reads it, through the ONE reader the three screens share.
import {
  isRoutedLine, routedLineOf, routedDeptWord, routedDeptNames, withDeptLabel,
} from '@/app/department-transfers/routed-view';

interface Department { id: string; name: string; }
/* The merged-PO fields (MergeLineFields) ride on every line of the ?id= feed:
 *   on_po            {po_id, po_number, vendor_name, status} — the PO it is on
 *   arrived          {grn_number, at} — its department share was received
 *   delivered_direct a Direct Issue rule sent the goods straight to a
 *                    department (ruling #68) — never issued again from here
 *   vendor_closed    the vendor was short-closed before delivering (ruling #69)
 * All optional: a line that was never on a merged PO carries none of them and
 * renders exactly as before. */
interface ReqLine extends MergeLineFields {
  id: string;
  material_id: string;
  material_name: string;
  /** Unit on the requisition line — may be blank for legacy reqs. */
  unit: string;
  /** rm.category, shipped so the store can walk one shelf at a time. */
  material_category?: string;
  /** Canonical recipe unit on raw_materials (from rm.unit AS material_unit). Fallback for `unit`. */
  material_unit?: string;
  /** Pack meta (rm.purchase_unit / rm.pack_size) — the store works in purchase units. */
  material_purchase_unit?: string;
  material_pack_size?: number;
  quantity_requested: number;
  chef_approved_qty: number | null;
  is_rejected: number;
  /** Store-side rejection — distinct from is_rejected (which is the chef's). */
  store_rejected?: number;
  store_reject_reason?: string;
  chef_note: string;
  quantity_issued: number;
  issued_at: string | null;
  issued_by: string | null;
  deferred_until: string | null;
  defer_reason: string | null;
  issue_history: string;          // JSON of [{qty, at, by, note}]
  notes?: string;
  department_id?: string;
  /** Identity, for the item-level search. SKU doubles as the item code. */
  material_sku?: string;
  material_sku_code?: string;
  material_brand?: string | null;
  /** Central store on-hand + its reorder point, both RECIPE units. */
  reorder_level?: number;
  /** Last hand-over of THIS MATERIAL on any OTHER requisition — quantity is in
   *  that line's own unit (Option B), which is why the unit travels with it. */
  mat_last_issue_at?: string | null;
  mat_last_issue_qty?: number | null;
  mat_last_issue_unit?: string | null;
  mat_last_issue_dept?: string | null;
  /** rm.current_stock — the central balance, RECIPE units (the "In store" column). */
  current_stock?: number | null;
  /** requisition_items.shelf_emptied_qty — THE RULE's memory (round 8): the
   *  quantity_issued a take that EMPTIED the central shelf closed this line at.
   *  Written by the server at the take, never inferred here; it speaks only for
   *  that exact quantity (deskShelfMarkHolds). Arrives with ri.*. */
  shelf_emptied_qty?: number | null;
  /** 1 for a liquor / store-mapped material (round 8b): the central floor never
   *  applies, so no hold or take is forecast for it (desk-rule.ts). */
  central_flow_blocked?: number | null;
  /** RECIPE units the party transfer already moved for this line's material on
   *  this requisition (api/requisitions ?id=, round 9). A later transfer moves
   *  only what the line holds above it (forecastDeskPartyTransfer). */
  party_moved_recipe?: number | null;
  /** Ruling #45: the department that SENDS this line ('' / null = the store
   *  does), with the server's state of it (RoutedLineState) — read only
   *  through routed-view.ts. On a routed line quantity_issued is what that
   *  department's transfers still leave with the asking department. */
  routed_department_id?: string | null;
  routed?: unknown;
  routed_department_name?: string | null;
}
interface Requisition {
  id: string; req_number: string; purpose: string;
  status: string;
  department_id: string; department_name: string;
  drafted_by: string; submitted_at: string; chef_approved_at: string | null;
  mgmt_approved_at: string | null; store_processed_at: string | null;
  store_processed_by: string | null;
  event_name?: string; event_date?: string;
  fulfilled_at?: string | null;
  items: ReqLine[];
  total_lines: number; lines_issued: number; lines_deferred: number; lines_open: number;
  /** Lines with 0 < issued < effective — handed over, but not in full. */
  lines_partial: number;
  /**
   * Lines that have moved ANY goods (quantity_issued > 0), whatever else is true
   * of them. The three counters above are a PARTITION — each line lands in
   * exactly one of issued / deferred / open — so a line that gave out 2 of 4 and
   * carries a promised time for the balance is filed under `deferred` and the 2
   * that physically left the store disappear from the roll-up. This is the count
   * that still sees them. It is additive: nothing reads it in place of the five
   * fields above, which badges and tab predicates depend on.
   *
   * "WHATEVER ELSE IS TRUE OF THEM" NOW INCLUDES store_rejected. Since the
   * Option-A reject stopped un-issuing what the storekeeper had physically
   * handed over, a store-rejected line can carry 200 of 240 — and this counter
   * used to skip it wholesale, so the one number meant to see every hand-over
   * was the one that lost it.
   */
  lines_issued_any: number;
  /** Store-rejected lines that KEPT a real hand-over (quantity_issued > 0).
   *  Goods went out and the line is closed. Carved out of lines_issued_any so
   *  the "sent, not closed" chip, which promises the goods are still owed, does
   *  not claim them. */
  lines_rejected_kept: number;
  /** The subset of lines_rejected_kept where the reject actually CUT something:
   *  issued > 0 AND a remainder was still outstanding. The other kind — a line
   *  rejected after it had already been issued in full — cancelled nothing (see
   *  the route's "ONE CONSEQUENCE" note) and must not be advertised as if it
   *  had. Only this count earns the "sent, then cancelled" chip. */
  lines_rejected_cut: number;
  /** Σ max(0, effective − issued) over lines that are still OPEN. A rejected
   *  line (chef or store) contributes NOTHING: its balance was cancelled, not
   *  owed. MIXED UNITS by design (each line carries its own unit), so this is
   *  only ever asked `> 0` — "is anything still owed?". Never render it as a
   *  number. */
  qty_outstanding: number;
  /** Σ quantity_issued over EVERY line, rejected ones included — "did anything
   *  physically leave the store on this requisition?". MIXED UNITS, same rule
   *  as qty_outstanding: only ever asked `> 0`, never rendered. */
  qty_issued: number;
  /** Σ of what a REJECTION cancelled: max(0, asked − issued) over lines the
   *  chef or the store rejected, where `asked` is quantity_requested for a
   *  chef-rejected line (its effective qty is 0 by definition) and the
   *  effective qty otherwise. MIXED UNITS, only ever asked `> 0`. This is the
   *  number that separates "Fulfilled" from "Closed short"/"Closed". */
  qty_cancelled: number;
  /** Did any line move goods today (IST)? Independent of `status`. */
  issued_today: boolean;
  /** ROUTED lines (ruling #45) — another department sends them, so they sit
   *  OUTSIDE the partition above (lines_issued / deferred / open / partial and
   *  qty_outstanding are the store's own lines only). Still owed by THE RULE,
   *  and sent in full, counted apart (a rejected one in neither); `routed_depts`
   *  names the departments the feed says send them. */
  lines_routed_owing: number;
  lines_routed_done: number;
  routed_depts: string[];
  /** 1 once the party transfer has moved any of this requisition's goods
   *  (api/requisitions ?id=, round 8b). Since round 9 a later run moves what
   *  the lines hold above that (each line's party_moved_recipe), so it is no
   *  longer a reason to forecast nothing (forecastDeskPartyTransfer). */
  party_transferred?: number | boolean | null;
}

// All timestamps render in IST (Asia/Kolkata) via the shared formatter.
// Storage stays UTC; conversion happens here at display time.
const fmtDateTime = (iso: string | null) => fmtIST(iso);
const fmtNum = (v: number) => (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
/**
 * A central-store CAP in the purchase unit — fmtNum, except for the one figure
 * fmtNum cannot carry: a balance the "In store" column shows as 0 that the store
 * still holds (a sub-display crumb, under half a 0.001 step — 0.4 g on a
 * 1000-pack). The server names that cap at the precision that takes it when
 * typed back (issue-stock.ts puFine: 6 dp of the recipe unit, carried through
 * the pack); fmtNum printed it as "0", so this desk read "Most it can give now:
 * 0 kg" and offered "Issue 0 kg" over a real 0.4 g. Every figure of 0.001 or
 * more prints exactly as fmtNum prints it, so nothing that was legible changes.
 * The SAME expression as fmtCapPU on /requisitions (requisitions/page.tsx), so
 * the two desks print one crumb one way. `pf` = the material's purchase pack
 * factor; pass 1 for a recipe-unit figure (it then prints 6 dp, the grid).
 */
const fmtCapPU = (v: number, pf = 1) => {
  const n = Number(v) || 0;
  if (!(n > 0 && n < 0.001)) return fmtNum(n);
  const dp = Math.min(20, 6 + Math.max(0, Math.ceil(Math.log10(pf > 1 ? pf : 1))));
  return n.toLocaleString('en-IN', { maximumFractionDigits: dp });
};
/**
 * THE ISSUED ITEMS LOG'S LEAD FIGURE (round 9). The log API's `qty_purchase`
 * is rounded to 3 dp, so a hand-over below one printed step led as "0 kg = 0.4
 * g" (the 0.4 g crumb the held panel offers) and a party shelf correction's
 * 0.5 g as "0.001 kg = 0.5 g". Below a step the lead is the EXACT purchase
 * figure — the row's recipe `qty` through its own `pack_factor` — printed
 * through fmtCapPU and signed (a reversal row is negative). Every figure of
 * 0.001 or more is fmtNum(qty_purchase), byte for byte.
 */
type LogQty = { qty?: unknown; qty_purchase?: unknown; pack_factor?: unknown };
const logPf = (e: LogQty) => (Number(e.pack_factor) > 1 ? Number(e.pack_factor) : 1);
const fmtLogLead = (e: LogQty) => {
  const pf = logPf(e);
  const exact = (Number(e.qty) || 0) / pf;
  const a = Math.abs(exact);
  if (a > 0 && a < 0.001) return `${exact < 0 ? '-' : ''}${fmtCapPU(a, pf)}`;
  return fmtNum((e.qty_purchase ?? e.qty) as number);
};
/** On an unpacked material (pack 1, kg / kg) the row has no recipe line to
 *  carry the exact figure, and 3 dp hid it: WHOLE DHANIYA's shelf take
 *  recorded 3.2174 kg and the log read "3.217 kg". The exact 6-dp figure when
 *  the lead does not already print it (the row's own fmtTakeHint rule), else ''.
 *  `qty` IS the purchase basis there (pack_factor 1). */
const fmtLogExact = (e: LogQty) => {
  if (logPf(e) > 1) return '';
  const n = Number(e.qty) || 0;
  if (Math.abs(n) > 0 && Math.abs(n) < 0.001) return '';
  const exact = (Math.round(n * 1e6) / 1e6).toLocaleString('en-IN', { maximumFractionDigits: 6 });
  return exact !== fmtLogLead(e) ? exact : '';
};
// Stable empty set — passed as the default `selectedIds` so ReqCard doesn't get
// a fresh Set identity every render when a requisition has no selection yet.
const EMPTY_SET: Set<string> = new Set();

/**
 * Resolve one requisition line's UNIT BASIS and expose the purchase-unit view.
 *
 * Requisition quantities are stored in the LINE's own `unit` (option B), and the
 * two composers disagree: the internal picker stamps the PURCHASE unit, the
 * party composer stamps the RECIPE unit (and converts qty ×pack). Legacy lines
 * can be blank — read as recipe, matching what this page has always displayed.
 * The store hands over bottles/kg, so everything here READS and is ENTERED in
 * purchase units; `fromPU` converts back to the line's unit at the POST
 * boundary, because /store-issue adds the number to quantity_issued verbatim.
 */
function lineUnits(line: ReqLine) {
  const recipeUnit = line.material_unit || line.unit || '';
  const pf = packFactor({
    unit: recipeUnit,
    purchase_unit: line.material_purchase_unit,
    pack_size: line.material_pack_size,
  });
  const pu = line.material_purchase_unit || recipeUnit;
  const lu = String(line.unit || '').toLowerCase().trim();
  // Already stored in the purchase unit → no conversion in either direction.
  const isPU = pf > 1 && lu !== '' && lu === String(pu).toLowerCase().trim();
  const meta = { unit: recipeUnit, purchase_unit: line.material_purchase_unit, pack_size: line.material_pack_size };
  return {
    pf, pu, recipeUnit, isPU,
    /** stored line qty → purchase-unit display figure (3 dp, display only) */
    toPU: (q: any) => isPU ? (Number(q) || 0) : Math.round(((Number(q) || 0) / pf) * 1000) / 1000,
    /** purchase-unit entry → the line's stored unit (what the API adds verbatim) */
    fromPU: (q: any) => isPU ? (Number(q) || 0) : Math.round((Number(q) || 0) * pf * 1e6) / 1e6,
    /** stored line qty → recipe units (the small "= N g" hint) */
    toRecipe: (q: any) => isPU ? (Number(q) || 0) * pf : (Number(q) || 0),
    /** MATERIAL-level qty → purchase-unit display. current_stock is ALWAYS
     *  recipe units regardless of what basis this LINE is stored in, so it must
     *  never go through toPU — that would leave a purchase-basis line's stock
     *  undivided and print grams as kilos.
     *
     *  SNAPPED TO THE 6-dp GRID BEFORE THE 3-dp ROUNDING (round 8):
     *  pack-units.ts shownPurchaseQty, the very function the server's
     *  shown-figure rule prints and matches against, so "In store" and the
     *  server's "holds only …" can never print one balance two ways. Rounded
     *  raw (round 7), float dust moved the printed figure a whole step: WHITE
     *  DAL 5.0005 kg less 1.85 is stored 3.1504999999999996 and printed 3.15,
     *  and the desk's own Issue All of 3.151 was refused; FRESH CREAM
     *  130,125.5 ml printed 130.125 BTL through the division alone. On every
     *  balance no float effect reaches — every live balance today — the figure
     *  is the one this column always printed. */
    stockPU: (q: any) => shownPurchaseQty(Number(q) || 0, meta),
  };
}

/**
 * A HAND-OVER figure (a line quantity about to be issued) in the purchase
 * unit, never "0" over a real crumb. At 0.001 or more it is
 * fmtNum(U.toPU(q)) — the string this page always printed, byte for byte.
 * Below that, toPU's 3 dp turns a 0.4 g crumb into "0 kg" (and fmtNum does
 * the same to a purchase-unit line's 0.0004), so the figure is printed through
 * fmtCapPU from the unrounded purchase figure — the precision the server names
 * a crumb cap in, and the figure the storekeeper typed.
 */
function fmtHandOverPU(U: ReturnType<typeof lineUnits>, q: number): string {
  const pu = U.isPU ? (Number(q) || 0) : (Number(q) || 0) / U.pf;
  return pu > 0 && pu < 0.001 ? fmtCapPU(pu, U.pf) : fmtNum(U.toPU(q));
}

/**
 * A LINE QUANTITY IN A PLAIN-TEXT PROMPT (round 9) — the row's own two
 * figures in one string: the purchase-unit lead (fmtHandOverPU, never "0" over
 * a crumb) and, on a packed material, the exact recipe figure as the "= …"
 * hint the row prints under it; on an unpacked one (pf 1) the exact 6-dp
 * figure when 3 dp hides it (fmtTakeHint's rule). The Reject and Un-reject
 * prompts printed fmtNum(U.toPU(v)) alone, so after the held panel's own
 * "Issue 0.0004 kg" the row read 0.0004 kg = 0.4 g while Reject said "0 kg of
 * 2 kg has already been handed over … The remaining 2 kg is cancelled" over
 * 1,999.6 g (round-9 verifier, crumb-prompt).
 */
function fmtPromptQty(U: ReturnType<typeof lineUnits>, q: number): string {
  const v = Number(q) || 0;
  const lead = `${fmtHandOverPU(U, v)}${U.pu ? ` ${U.pu}` : ''}`;
  if (U.pf > 1) return `${lead} (= ${fmtCapPU(U.toRecipe(v), 1)} ${U.recipeUnit})`;
  const exact = (Math.round(v * 1e6) / 1e6).toLocaleString('en-IN', { maximumFractionDigits: 6 });
  return exact !== fmtHandOverPU(U, v) ? `${lead} (= ${exact}${U.pu ? ` ${U.pu}` : ''})` : lead;
}

/**
 * A TAKE — RECIPE units leaving the central shelf (desk-rule.ts
 * forecastDeskTake `takeRecipe`) — in the purchase unit, printed exactly as the
 * "In store" column prints a balance (U.stockPU, shownPurchaseQty), so "takes
 * everything the store holds — 14.843 kg" reads the figure the storekeeper saw
 * in the column. A sub-display crumb through fmtCapPU, never "0".
 */
function fmtTakePU(U: ReturnType<typeof lineUnits>, recipe: number): string {
  const v = U.stockPU(recipe);
  return v > 0 ? fmtNum(v) : fmtCapPU((Number(recipe) || 0) / U.pf, U.pf);
}

/**
 * THE PARTY TAKE'S WORDS (round 9). A first transfer moves the line's WHOLE
 * quantity; since round 9 a later one — after a short /store-process submit
 * moved part of the line — moves only what the line holds above that
 * (desk-rule.ts `movedLine`). "moves the line's whole 10 kg" over a 20 kg line
 * of which 10 kg had already left would name a total the line does not have.
 */
function partyTakeLead(tk: { movedLine?: number }): string {
  return (Number(tk.movedLine) || 0) > 0 ? `the line's remaining` : `the line's whole`;
}
function partyMovedNote(U: ReturnType<typeof lineUnits>, tk: { movedLine?: number }): string {
  const m = Number(tk.movedLine) || 0;
  return m > 0 ? ` — ${fmtHandOverPU(U, m)}${U.pu ? ` ${U.pu}` : ''} of the line already left the store earlier` : '';
}

/** The take's "= …" hint: the recipe figure on a packed material (14,842.4 g),
 *  and on an unpacked one (pf 1) the exact figure when 3 dp would hide it
 *  (WHOLE DHANIYA 3.2174 kg prints 3.217 above it). '' when it adds nothing. */
function fmtTakeHint(U: ReturnType<typeof lineUnits>, recipe: number): string {
  const r = Number(recipe) || 0;
  if (U.pf > 1) return `= ${fmtNum(r)} ${U.recipeUnit}`;
  const exact = (Math.round(r * 1e6) / 1e6).toLocaleString('en-IN', { maximumFractionDigits: 6 });
  return exact !== fmtNum(r) ? `= ${exact} ${U.recipeUnit}` : '';
}

/**
 * WHAT A TAKE LEAVES THE LINE AT, in words (round 8) — for a take the shelf
 * rule changed (`changed`) or that empties the shelf. THE RULE's three answers:
 *   · complete in full                 → "the line is issued in full"
 *   · complete by the shelf arm        → "the line closes — the 0.0006 kg (= 0.6 g)
 *                                         still owing is below the 0.001 kg the
 *                                         store can issue"
 *   · not complete                     → "5.158 kg stays outstanding"
 * The remainder below a step is printed at the precision that names it
 * (fmtCapPU), never as the "0.001 kg" a 3-dp rounding would make of 0.6 g.
 */
function takeOutcomeWords(U: ReturnType<typeof lineUnits>, approved: number, tk: DeskTakeForecast): string {
  const u = U.pu ? ` ${U.pu}` : '';
  if (!tk.complete) {
    // With its exact recipe figure (round 8b): after a take that is not the
    // typed figure the balance is not a round number — 20 kg less 14,842.4 g
    // is 5,157.6 g, which "5.158 kg" alone overstates by 0.4 g.
    // fmtHandOverPU (final pass): a balance below one printed step read
    // "0.001 kg (= 0.6 g)"; at 0.001 or more it is fmtNum(U.toPU(…)), byte for byte.
    const hint = fmtTakeHint(U, U.toRecipe(tk.owingLine));
    const owes = `${fmtHandOverPU(U, tk.owingLine)}${u}${hint ? ` (${hint})` : ''} stays outstanding`;
    // A PARTY TOP-UP THE SHELF COULD NOT COVER (round 10, desk-rule.ts
    // `shortTake`) on a line still owed: the transfer records what actually
    // left — the part moved earlier plus what the shelf held — so the line's
    // record is LOWERED from what the storekeeper recorded (party-fulfillment.ts
    // "A TOP-UP THE SHELF CANNOT COVER", the owner decision). Said, not hidden.
    if (tk.shortTake && tk.totalLine != null && tk.totalLine - tk.recordedLine > 1e-9) {
      return `its record drops from ${fmtQtyExact(U, tk.totalLine)} to ${fmtQtyExact(U, tk.recordedLine)} — what has `
        + `actually left the store — and ${owes}`;
    }
    return owes;
  }
  const rem = Math.max(0, (Number(approved) || 0) - tk.recordedLine);
  if (!tk.byShelf || !(rem > 1e-9)) return 'the line is issued in full';
  const remPU = U.isPU ? rem : rem / U.pf;
  const recipe = U.pf > 1 ? ` (= ${fmtNum(U.toRecipe(rem))} ${U.recipeUnit})` : '';
  const stepRecipe = U.pf > 1 ? ` (${fmtNum(0.001 * U.pf)} ${U.recipeUnit})` : '';
  return `the line closes — the ${fmtCapPU(remPU, U.pf)}${u}${recipe} still owing is below the 0.001${u}${stepRecipe} the store can issue`;
}

/**
 * A LINE QUANTITY WITH ITS EXACT FIGURE WHEN THE LEAD HIDES IT (final pass) —
 * the purchase-unit lead (fmtHandOverPU, never "0" over a crumb) and, only
 * where 3 dp does not print the stored figure exactly (or the figure is a
 * crumb below one step), the exact one beside it: the recipe figure on a packed
 * material, the 6-dp figure on an unpacked one. "the 0.0006 kg this line holds
 * above the 14.842 kg that already left" did not add up to the 14.843 kg line
 * (14.8424 kg had left); "· 2 kg cancelled" sat over "Cancelled 2 kg = 1,999.6
 * g" (round-10 store-desk recheck). A figure 3 dp prints exactly reads as the
 * plain lead, so an ordinary line's sentence is unchanged.
 */
function fmtQtyExact(U: ReturnType<typeof lineUnits>, q: number): string {
  const v = Number(q) || 0;
  const leadNum = fmtHandOverPU(U, v);
  const lead = `${leadNum}${U.pu ? ` ${U.pu}` : ''}`;
  const exactPU = U.isPU ? v : v / (U.pf || 1);
  const dp = Math.min(20, 6 + Math.max(0, Math.ceil(Math.log10(U.pf > 1 ? U.pf : 1))));
  const exactStr = (Math.round(exactPU * 10 ** dp) / 10 ** dp).toLocaleString('en-IN', { maximumFractionDigits: dp });
  const crumb = Math.abs(exactPU) > 0 && Math.abs(exactPU) < 0.001;
  if (exactStr === leadNum && !crumb) return lead;
  if (U.pf > 1) return `${lead} (= ${fmtCapPU(U.toRecipe(v), 1)} ${U.recipeUnit})`;
  return exactStr === leadNum ? lead : `${lead} (= ${exactStr}${U.pu ? ` ${U.pu}` : ''})`;
}

/**
 * WHAT THE PARTY TRANSFER DOES ON THIS LINE, as a verb phrase after "the
 * party transfer then …" (final pass). desk-rule.ts `shortTake` (round 10): a
 * top-up the shelf cannot cover takes what the shelf holds — possibly nothing
 * — instead of moving the line's remaining quantity, so "moves the line's
 * remaining 0 kg (= 0 g)" (ta_redo_exact) named a hand-over that never
 * happens. Every other take reads as it always did.
 */
function partyTakeClause(U: ReturnType<typeof lineUnits>, tk: DeskTakeForecast): string {
  const u = U.pu ? ` ${U.pu}` : '';
  const hint = fmtTakeHint(U, tk.takeRecipe);
  if (tk.shortTake) {
    const moved = Number(tk.movedLine) || 0;
    const rest = Math.max(0, (Number(tk.totalLine) || 0) - moved);
    const holds = (Number(tk.takeRecipe) || 0) > 0
      ? `the store's books hold only ${fmtTakePU(U, tk.takeRecipe)}${u}${hint ? ` (${hint})` : ''}, which it moves`
      : `the store's books hold none of it, so nothing more moves`;
    return `needs to move the ${fmtQtyExact(U, rest)} this line holds above the ${fmtQtyExact(U, moved)} that already `
      + `left the store — ${holds}`;
  }
  return `moves ${partyTakeLead(tk)} ${fmtTakePU(U, tk.takeRecipe)}${u}${hint ? ` (${hint})` : ''}${partyMovedNote(U, tk)}`
    + `${tk.plan.takesAll ? ' — everything the central store holds' : ''}`;
}

/**
 * HOW A SENTENCE ABOUT A GESTURE THAT RUNS THE PARTY TRANSFER BEGINS (final
 * pass). "X completes the requisition" is true only when the transfer leaves
 * every line complete (`fulfils`). Since round 10 a top-up the shelf cannot
 * cover on a line the gesture did not issue on takes what the shelf holds and
 * REOPENS that line (desk-rule.ts `shortTake` with `complete` false; the route
 * names it on its 200 as `party_short`), and the requisition stays open — the
 * gesture then only leaves no line open, which is what runs the transfer.
 */
function partyRunLead(gesture: string, party: CentralBatchForecast['party'] | undefined): string {
  // 'closes' (the route's savepoint try) is kept only when every line is then
  // done, so it always completes the requisition; only a 'certain' run can
  // reopen a line.
  // With a routed line still owed (ruling #45) the gesture finishes the
  // STORE's part only — its department still sends the rest.
  if (party?.routedOwed) return `${gesture} leaves none of the store's lines open, so the party transfer runs and`;
  return party && party.runs === 'certain' && !party.fulfils
    ? `${gesture} leaves no line open, so the party transfer runs and`
    : `${gesture} completes the requisition, and the party transfer then`;
}

/** One line the transfer leaves open (desk-rule.ts `shortTake`, `complete`
 *  false) — the forecast of the route's own party_short sentence. */
function partyLeftOpenWords(x: { line: ReqLine; tk: DeskTakeForecast }): string {
  const U = lineUnits(x.line);
  const u = U.pu ? ` ${U.pu}` : '';
  const tk = x.tk;
  const moved = Number(tk.movedLine) || 0;
  const rest = Math.max(0, (Number(tk.totalLine) || 0) - moved);
  const hint = fmtTakeHint(U, tk.takeRecipe);
  const holds = (Number(tk.takeRecipe) || 0) > 0
    ? `the store's books hold only ${fmtTakePU(U, tk.takeRecipe)}${u}${hint ? ` (${hint})` : ''}, which the transfer moves`
    : `the store's books hold none of it`;
  return `${x.line.material_name}: ${fmtQtyExact(U, rest)} of this party line has not left the store yet `
    + `(${fmtQtyExact(U, moved)} had, earlier), and ${holds} — its record drops from ${fmtQtyExact(U, Number(tk.totalLine) || 0)} `
    + `to ${fmtQtyExact(U, tk.recordedLine)} and it stays open for ${fmtQtyExact(U, tk.owingLine)}`;
}

/** The sentence for every line the transfer leaves open, other than `exceptId`;
 *  '' when there is none (every ordinary gesture). */
function partyLeftOpenSentence(party: CentralBatchForecast['party'] | undefined, exceptId?: string): string {
  const xs = (party?.leftOpen || []).filter(x => x.line.id !== exceptId);
  if (xs.length === 0) return '';
  return ` But the store's books cannot cover every line — ${xs.map(partyLeftOpenWords).join('; ')}. `
    + `The requisition stays open; receive the stock, then issue the rest.`;
}

/**
 * WHAT THE PARTY TRANSFER ALREADY MOVED FOR THIS LINE (final pass), LINE
 * units: the material's party_moved_recipe (api/requisitions ?id=) handed to
 * its lines in the requisition's order, each taking at most what it records —
 * the transfer's own allocation (desk-rule.ts forecastDeskPartyTransfer).
 * `excess` is what moved for the material beyond what its lines now record —
 * the state a party undo or store rejection leaves (the route zeroes
 * quantity_issued; the goods stay with the department). null when the payload
 * cannot say; zeros on an internal requisition.
 */
function partyMovedOf(req: Requisition, line: ReqLine): { movedLine: number; excessLine: number; first: boolean } | null {
  if (req.purpose !== 'party') return { movedLine: 0, excessLine: 0, first: false };
  // A routed line (ruling #45) never rides the party transfer: its department
  // sends it, so nothing the transfer moved is its — and it takes no share of
  // the pool from a store line of the same item.
  if (isRoutedLine(line)) return { movedLine: 0, excessLine: 0, first: false };
  if (line.party_moved_recipe == null) return null;
  const mat = String(line.material_id || '');
  let pool = Math.max(0, Number(line.party_moved_recipe) || 0);
  let mine = 0;
  let firstId = '';
  for (const l of req.items || []) {
    if (String(l.material_id || '') !== mat) continue;
    if (isRoutedLine(l)) continue;
    if (!firstId) firstId = String(l.id);
    const b = deskLineBasis(l);
    const f = b ? b.factor || 1 : 1;
    const lineRecipe = Math.max(0, Math.round((Number(l.quantity_issued) || 0) * f * 1e6) / 1e6);
    const take = Math.min(pool, lineRecipe);
    if (l.id === line.id) mine = take;
    pool = Math.max(0, pool - take);
  }
  const b = deskLineBasis(line);
  const f = b ? b.factor || 1 : 1;
  return {
    movedLine: mine / f,
    excessLine: Math.round(pool * 1e6) > 0 ? pool / f : 0,
    first: firstId === String(line.id),
  };
}

/* ── A REFUSED REVERSAL ────────────────────────────────────────────────────
   Undo and store-Reject both pull goods BACK from the department to central.
   Under department-based inventory that can be physically impossible: the
   kitchen may already have cooked the ingredients, so there is nothing left to
   hand back. The server REFUSES such a reversal (code DEPT_REVERSAL_BLOCKED)
   instead of quietly clamping it to whatever is left.

   Why refusing matters to this screen: the route writes quantity_issued BEFORE
   it asks the stock rail to move, so a clamp would commit a line reading
   "0 issued" while the grams never came back to central — the two rails
   disagree and NOTHING on screen says so. The throw rolls that whole
   transaction back, and this panel is the only place the storekeeper ever
   learns why.

   `requested` and `available` arrive in RECIPE units, because the department
   ledger is material-level and stores recipe units. They therefore render
   through U.stockPU — the same converter the In-store column uses — and NEVER
   through U.toPU, which is the LINE's basis and would print grams as kilos on
   a purchase-unit line. */
const BLOCKED_CODE = 'DEPT_REVERSAL_BLOCKED';

interface BlockedReversal {
  material: string;
  /** Which kitchen still owes the goods. Blank if the server didn't name one. */
  department: string;
  /** Both in RECIPE units. 0 = the server refused without giving a figure. */
  requested: number;
  available: number;
  message: string;
}

/**
 * Read the server's refusal into a per-line map.
 *
 * Deliberately forgiving about shape. The one thing this page must never do is
 * swallow a refusal because a field arrived under a different name — a
 * swallowed refusal reads to the storekeeper as "the app ignored me", and he
 * clicks undo again. When the payload names no line but the batch held exactly
 * one, the refusal can only belong to that line, so attach it. When nothing at
 * all is recognisable, return {} and let the caller fall back to the alert it
 * has always shown.
 */
function readBlockedReversals(
  payload: any,
  submitted: { id: string; material_name: string }[],
): Record<string, BlockedReversal> {
  const out: Record<string, BlockedReversal> = {};
  const rows: any[] = Array.isArray(payload?.blocked) ? payload.blocked : [];
  const centralPayload = String(payload?.code || '') === CENTRAL_SHORT_CODE;
  for (const b of rows) {
    // NOT A DEPARTMENT REVERSAL (round 10). The central floor's refusal rides
    // the same `blocked[]` envelope — a party Reject that completes the
    // requisition runs the transfer, and the transfer refuses — but its
    // figures are PURCHASE units, and read here as recipe units they printed
    // "Putting 0.01 kg (= 10 g) back needs it to still be with that kitchen"
    // for 10 kg still to move (round-9 never-stuck recheck, ta_block). Such a
    // row is read by readCentralShort and shown as itself (ReversalShort).
    const code = String(b?.code || '');
    if (code === CENTRAL_SHORT_CODE || (centralPayload && code === '')) continue;
    // NOR ANY OTHER TYPED ROW (final pass). The same envelope now also carries
    // 'line_changed' (the stale cap, round 10) and may carry more; a row typed
    // as anything but a department reversal — or an untyped row on a payload
    // typed as anything else — is not this panel's. The forgiving read stays
    // for an envelope that types nothing at all (the pre-check route).
    const payloadCode = String(payload?.code || '');
    if (code !== '' && code !== BLOCKED_CODE) continue;
    if (code === '' && payloadCode !== '' && payloadCode !== BLOCKED_CODE) continue;
    const id = String(b?.line_id || b?.id || (submitted.length === 1 ? submitted[0].id : ''));
    if (!id) continue;
    out[id] = {
      material: String(b?.material || submitted.find(s => s.id === id)?.material_name || 'this item'),
      department: String(b?.department || ''),
      requested: Number(b?.requested) || 0,
      available: Number(b?.available) || 0,
      message: String(b?.message || b?.error || payload?.error || '').trim(),
    };
  }
  // Typed refusal, no per-line detail, single-line batch → it is that line.
  if (Object.keys(out).length === 0
      && String(payload?.code || '') === BLOCKED_CODE
      && submitted.length === 1) {
    out[submitted[0].id] = {
      material: submitted[0].material_name,
      department: '', requested: 0, available: 0,
      message: String(payload?.error || '').trim(),
    };
  }
  return out;
}

/* ── THE CENTRAL FLOOR'S REFUSAL, WHICH IS A DIFFERENT ANIMAL ────────────────
   The store cannot hand over goods the central books do not hold, and
   /store-issue answers that with code 'central_stock_short' and the same
   `blocked[]` envelope the reversal gate uses.

   IT GETS ITS OWN TYPE AND ITS OWN READER, and that is the whole point rather
   than duplication for its own sake: BlockedReversal's `requested`/`available`
   arrive in RECIPE units (the department ledger is material-level) and render
   through U.stockPU, while these arrive ALREADY IN THE PURCHASE UNIT, as the
   balance's SHOWN figure (issue-stock.ts checkCentralIssue `availablePurchase`:
   shownPurchaseQty, the grid point then 3 dp half-up — the "In store" column's
   own number), which the
   server accepts when typed back and debits as the whole balance; below 0.001 a
   sub-display crumb at the precision that takes it (print it with fmtCapPU).
   Feeding a central row into readBlockedReversals would print kilograms through
   a gram→kilogram converter — the 1000x error this app has had before.

   WHAT WAS WRONG BEFORE THIS. The sentence existed and was correct; it reached
   the storekeeper as `alert(j.error)` and vanished on OK, leaving him in front
   of an empty box with no number. `max_issue_qty` / `available` were on the wire
   and nothing on this page read either. So the refusal now lands as a panel on
   the line, and the figure lands in the quantity box via the chip in it. */
const CENTRAL_SHORT_CODE = 'central_stock_short';

interface CentralShort {
  material: string;
  /** PURCHASE units — the balance's shown figure (or a sub-display crumb's
   *  exact figure; print with fmtCapPU, never fmtNum). The figure THIS page's
   *  quantity box takes, because that box holds a DELTA added to
   *  quantity_issued and `available` is exactly the headroom on top of what is
   *  already issued. Typed back, it is accepted. */
  available: number;
  /** PURCHASE units — the ask's shown figure (3 dp half-up, the same converter
   *  as `available`); unrounded only for a sub-display ask. */
  requested: number;
  /** The unit both figures above are in. Blank only if the server sent none. */
  purchaseUnit: string;
  /** The server's finished sentence. Printed verbatim — never re-worded. */
  message: string;
  /** max_issue_qty — the server's cap on the line's TOTAL quantity_issued, in
   *  the LINE's own unit (checkCentralIssue maxIssueLineQty). On the internal
   *  rail it is before + `available`; on a PARTY line (the transfer moves the
   *  whole line, from 0) it is the cap on the whole line, so the box's delta
   *  is this less what the line already holds (round 8b). NaN when absent. */
  maxIssueLine?: number;
  /** max_add_qty (round 9) — the server's own figure for a box that ADDS to
   *  the line (checkCentralIssue maxAddLineQty), in the LINE's own unit: on the
   *  internal rail the image of `available`, on a party line the largest add
   *  whose TOTAL the transfer accepts. NaN when the server did not send it
   *  (an older server): the panel then derives it as before. */
  maxAddLine?: number;
  /** max_add_purchase — the same add in the PURCHASE unit, exact. NaN when absent. */
  maxAddPU?: number;
  /** line_issued (round 10) — the line's quantity_issued, LINE units, that
   *  every figure on this row was worked out against. A cap pressed from this
   *  panel sends it back as `expect_issued` (store-issue/route.ts, THE STALE
   *  CAP): if the line has moved since, the store refuses it ('line_changed')
   *  and writes nothing. NaN when the server sent none. */
  lineIssued?: number;
  /** TRUE when this row came off a 200's `held[]` and NOT a 400's `blocked[]`.
   *  The figures and the sentence are identical; what differs is the fact about
   *  the GESTURE. A refusal wrote nothing ("Nothing was issued"), a hold means
   *  every other line of the same gesture WAS handed over and only this one
   *  stays outstanding. The panel's footer must say whichever is true. */
  held?: boolean;
}

/**
 * Read a central-stock refusal into a per-line map. Same forgiving shape as
 * readBlockedReversals (a swallowed refusal reads as "the app ignored me"), with
 * one extra condition: the row must actually BE a central refusal, so a reversal
 * block can never be rendered through this panel's purchase-unit basis.
 */
function readCentralShort(
  payload: { code?: unknown; error?: unknown; blocked?: unknown } | null | undefined,
  submitted: { id: string; material_name: string }[],
): Record<string, CentralShort> {
  const out: Record<string, CentralShort> = {};
  const typed = String(payload?.code || '') === CENTRAL_SHORT_CODE;
  const rows: Record<string, unknown>[] = Array.isArray(payload?.blocked)
    ? (payload.blocked as Record<string, unknown>[]) : [];
  for (const b of rows) {
    if (String(b?.code || '') !== CENTRAL_SHORT_CODE && !typed) continue;
    // A row typed as something else is never read as a central refusal, even
    // on a typed payload (final pass — the envelope is shared, see above).
    if (String(b?.code || '') !== '' && String(b?.code || '') !== CENTRAL_SHORT_CODE) continue;
    // `line_id` is what /store-issue sends; `req_item_id` is the same id by
    // another name (this page submits requisition_item ids), accepted so a
    // reshaped envelope cannot silently swallow the refusal.
    // req_item_id FIRST (round 8b): it is the line the floor refused, named by
    // the floor itself. `line_id` on a 400 is the route's "last entry it was
    // working on" — on a PARTY requisition the transfer runs after the loop,
    // so a refusal of THREE MANGO arrived with SALT's id whenever SALT was the
    // last entry, and the panel would have landed on the wrong row.
    const id = String(b?.req_item_id || b?.line_id || b?.id
                      || (submitted.length === 1 ? submitted[0].id : ''));
    if (!id) continue;
    out[id] = {
      material: String(b?.material || submitted.find(s => s.id === id)?.material_name || 'this item'),
      available: Number(b?.available) || 0,
      requested: Number(b?.requested) || 0,
      purchaseUnit: String(b?.purchase_unit || '').trim(),
      message: String(b?.message || b?.error || payload?.error || '').trim(),
      maxIssueLine: b?.max_issue_qty == null ? NaN : Number(b.max_issue_qty),
      maxAddLine: b?.max_add_qty == null ? NaN : Number(b.max_add_qty),
      maxAddPU: b?.max_add_purchase == null ? NaN : Number(b.max_add_purchase),
      lineIssued: b?.line_issued == null || b.line_issued === '' ? NaN : Number(b.line_issued),
    };
  }
  // Typed refusal with no per-line detail and a single-line batch → it is that
  // line. No figures, so the panel prints the sentence alone and offers no chip.
  if (Object.keys(out).length === 0 && typed && submitted.length === 1) {
    out[submitted[0].id] = {
      material: submitted[0].material_name,
      available: 0, requested: 0, purchaseUnit: '',
      message: String(payload?.error || '').trim(),
    };
  }
  return out;
}

/* ── THE SAME REFUSAL, ON A SUCCESS: "ISSUE THE 5, HOLD THE 1" ───────────────
   /store-issue no longer refuses a batch because one line is short. It hands
   over every line the central books cover, leaves the short one's
   quantity_issued as it was (so it stays outstanding), and answers 200 with
   `held[]` + `held_message` (store-issue/route.ts, "WHAT WAS HELD BACK"). A
   400 with `blocked[]` now only happens when not one line could go.

   THE ROWS ARE THE `blocked[]` ROWS, field for field (code, line_id, material,
   requested / available in the PURCHASE unit, purchase_unit, message), so
   they go through readCentralShort above and nowhere else. A second parser for
   the same shape would be the rival-helper trap. The only additions are the
   `held` flag, which changes the panel's footer, and the guard below.

   THE EMPTY-ARRAY GUARD IS LOAD-BEARING. readCentralShort turns a TYPED payload
   with no per-line rows on a single-line batch into a row for that line. That
   is right for a 400 and wrong here: a fully-issued 200 that ever carried
   `held: []` would paint a "does not hold this much" panel on the line that had
   just gone out. Nothing held means nothing is read. */
function readCentralHeld(
  payload: { held?: unknown } | null | undefined,
  submitted: { id: string; material_name: string }[],
): Record<string, CentralShort> {
  const rows = Array.isArray(payload?.held) ? (payload.held as unknown[]) : [];
  if (rows.length === 0) return {};
  // `code` set on the envelope because `held` IS the central-short list by
  // definition, so a row the server sent without its own code is still read.
  // `error` left blank on purpose: readCentralShort falls back to it for a row
  // with no sentence, and the gesture-level held_message printed on ONE line
  // would claim the whole gesture's figures for that line.
  const out = readCentralShort({ code: CENTRAL_SHORT_CODE, blocked: rows, error: '' }, submitted);
  for (const id of Object.keys(out)) out[id] = { ...out[id], held: true };
  return out;
}

/* ── A REVERSAL THE CENTRAL FLOOR REFUSED (round 10) ─────────────────────────
   On a PARTY requisition a store Reject of the last open line completes it,
   and the store → department transfer then runs — and since round 9 it can
   refuse (a line holds more above what already moved than the shelf has). The
   route answers that with the central floor's envelope (code
   'central_stock_short', PURCHASE units, the line the TRANSFER refused —
   usually another line). It is not a department reversal: it is shown as
   itself, on the line whose button was pressed, with the server's sentence
   verbatim and no figure re-rendered (round-9 recheck, ta_block: the reversal
   panel printed purchase figures as recipe ones and was never cleared).

   IT GOES THE MOMENT IT CAN BE STALE: when the storekeeper acts on that line
   again (clearBlocked), on Refresh, and on any reload where the requisition is
   no longer what it was at the refusal (reqSig — a line moved, the status
   changed, a balance the sentence quotes moved). */
interface ReversalShort {
  action: 'undo' | 'reject';
  reqId: string;
  /** reqSig of the requisition as this page held it at the refusal. */
  sig: string;
  /** The refused rows (readCentralShort — PURCHASE units), with the line each names. */
  rows: Array<{ lineId: string; short: CentralShort }>;
  /** Rejecting the pressed line leaves every other line rejected or complete,
   *  so the reject completes the requisition and runs the party transfer —
   *  said only when this is true of the lines the page holds. */
  completes: boolean;
}

/* ── A PARTY LINE ANOTHER GESTURE LOWERED AND REOPENED (round 10 server) ─────
   A store-issue 200 can carry `party_short[]` + `party_short_message`: the
   gesture left no line open, so the party transfer ran, and it met a line —
   usually NOT the one pressed — whose recorded remainder the shelf could no
   longer cover. The transfer took what the shelf held, the line now records
   what actually left and is open again (party-fulfillment.ts "A TOP-UP THE
   SHELF CANNOT COVER"). Measured before this (round-10 recheck, ta_block):
   Reject on SALT, and THREE MANGO went from 20/20 complete to 15/20 open with
   no word anywhere. The server's sentence is printed verbatim — as an alert,
   because the storekeeper's eyes are on the line he pressed, and as a panel on
   the line it names, which stays until that line is acted on, Refresh, or a
   load shows the line no longer at the figure the sentence names. */
interface PartyShortNote {
  reqId: string;
  /** The server's sentence for this line, verbatim. */
  message: string;
  /** recorded_line_qty — what the line records after the transfer, LINE units. */
  recordedLine: number;
}

/** One line's identity for "did it move under this page" (round 9): the four
 *  columns a hand-over, a rejection or a take changes. A line whose sig
 *  changes drops the storekeeper's typed figure, note, Defer panel and split
 *  along with the store's held panel (dropMovedLines).
 *
 *  THE APPROVED QUANTITY IS NOT IN IT (final pass). Round 10 put it here, so a
 *  chef changing an approval on another screen — nothing issued, nothing
 *  refused — wiped the storekeeper's typed figure, note and open Defer panel,
 *  which production keeps through every reload (round-10 recheck,
 *  approval_change_typed). An approval change is its own sig
 *  (lineApprovalSigOf) and drops only the store's held panel, whose figures
 *  and outcome words were worked out against the old approval; the split
 *  capture is settled by the load itself (splitCaptureStale), and the refused
 *  reversal reads both (reqSig). */
function lineSigOf(it: ReqLine): string {
  return [
    Math.round((Number(it.quantity_issued) || 0) * 1e9),
    Number(it.store_rejected || 0) ? 1 : 0,
    Number(it.is_rejected || 0) ? 1 : 0,
    it.shelf_emptied_qty == null ? '' : Math.round(Number(it.shelf_emptied_qty) * 1e9),
  ].join('|');
}
/** The approved quantity's identity (round 10 — a line lowered to what it
 *  already holds is complete without any hand-over). */
function lineApprovalSigOf(it: ReqLine): string {
  return String(Math.round(effectiveQty(it) * 1e9));
}

/** The requisition as a refusal read it: its status, every line's sig, approval,
 *  promise, central balance and party-moved figure. Any change ⇒ the refusal is stale. */
function reqSig(rq: Requisition): string {
  return [String(rq.status || ''), ...(rq.items || []).map(it => [
    String(it.id), lineSigOf(it), lineApprovalSigOf(it), String(it.deferred_until || ''),
    it.current_stock == null ? '' : Math.round((Number(it.current_stock) || 0) * 1e6),
    it.party_moved_recipe == null ? '' : Math.round((Number(it.party_moved_recipe) || 0) * 1e6),
  ].join(':'))].join('|');
}

/**
 * IS A HELD PANEL ON THIS LINE STILL ABOUT ANYTHING? (round 10) A held panel
 * says the central store will not give this line what was asked. Once the line
 * is complete by THE RULE (or rejected) there is nothing left to ask — the
 * panel and its cap are about a line that no longer exists, which is how a
 * stale "Issue 12.842 kg" sat on a 2/2 line (round-9 never-stuck, stale-cap).
 * ONE EXCEPTION, and it is why this is not a bare lineIssueComplete: a PARTY
 * line can be recorded complete while the transfer has not moved it (another
 * line was open), and the transfer's refusal of it is the reason the other
 * line's gesture was refused — that panel stays while something is still to
 * move for the line on a requisition that is not fulfilled.
 */
function heldPanelSettled(rq: Requisition, line: ReqLine): boolean {
  if (line.is_rejected || line.store_rejected) return true;
  if (!lineIssueComplete(line)) return false;
  if (rq.purpose !== 'party') return true;
  if (rq.status === 'fulfilled') return true;
  if (line.party_moved_recipe == null) return false;          // the payload cannot say
  const basis = deskLineBasis(line);
  if (!basis) return false;
  const recorded = Math.round((Number(line.quantity_issued) || 0) * basis.factor * 1e6);
  const moved = Math.round((Number(line.party_moved_recipe) || 0) * 1e6);
  return recorded - moved <= 0;
}

/** A split capture that no longer fits its line (round 10): the line is
 *  rejected, complete, or no longer owes MORE than the captured hand-over —
 *  "Issue & defer balance" would only answer "The outstanding quantity
 *  changed" (round-9 never-stuck, stale). */
function splitCaptureStale(line: ReqLine, qty: number): boolean {
  if (line.is_rejected || line.store_rejected) return true;
  const owed = owedQty(line);
  return !(Number.isFinite(qty) && qty > 0 && qty < owed - 1e-9);
}

/* ── BEFORE THE CLICK: WHICH LINES THE CENTRAL STORE WILL NOT ISSUE ──────────
   Everything above reads the server's answer AFTER a gesture. This is the same
   answer asked BEFORE it, so the storekeeper reads "MIRCHI will NOT be issued"
   on the card and in the Issue All confirmation instead of a list headed "these
   items are being issued" that names a line the server then holds. Measured
   (4-line batch, MIRCHI 3 kg over 1,000 g): the confirmation listed MIRCHI × 3
   kg under "being issued", the card's only signal was a red In-store figure and
   a hover title, and the POST came back 200 with MIRCHI held.

   IT DECIDES NOTHING. The rule is the server's — store-issue/route.ts's
   pre-flight, which asks src/lib/issue-stock.ts checkCentralIssue, which asks
   src/lib/central-debit-clamp.ts planCentralDebit (the one rule every central
   floor shares). That file imports the database, so it cannot be bundled into
   this page; this function asks the SAME questions in the same order on the
   same converters and cites them, exactly as requisitions/page.tsx centralCapOf
   does for the management desk:
     · the three carve-outs: a PARTY requisition (the internal rail moves no
       central stock for it), a line whose unit cannot be resolved (lineFactor's
       needsReview: a blank or unrecognised unit on a packed material), and a
       zero / negative delta — none of them is floored, so none is "held";
     · the ask: (before + typed) − before, × lineFactor, snapped to 6 dp;
     · FITS ⇔ qtyGrid(ask) ≤ qtyGrid(max(0, balance − claimed))  OR  the ask's
       shown figure IS the balance's and that is above 0 (round 6, "THE SHOWN
       FIGURE IS THE BALANCE" — 14.843 kg typed over 14,842.5 g fits);
     · the running claim: per MATERIAL, in the batch's own order, a line that
       fits claims what it will debit (the balance itself when it takes all),
       and a HELD line claims nothing — so two lines of one material are scored
       the way the floor will see them.
   The cap it reports for a held line is the figure the server's row will
   carry (checkCentralIssue's `availablePurchase` as rescoreHeldIssue /
   scoreHeldAtTurn compute it, round 7): what is left once the lines that run
   have taken theirs, shared with earlier held lines of the same item in row
   order — the balance's shown figure, or a sub-display crumb's exact figure,
   0 only when holdsAny() is false. With no other line of the item in the
   gesture that is simply the balance, as on the management desk.

   IT IS A COURTESY, NOT A GUARD, and it says so in its words. One carve-out is
   invisible from here: a liquor / store-mapped material (store-engine.ts
   centralFlowBlock) is never floored, and the queue payload does not say which
   materials those are — the management desk has the same blind spot and names
   it in the same sentence ("If it is liquor-store items ..."). The balance is
   the one this page loaded, not the one the server will read. So the forecast
   only ever adds WORDS; nothing is disabled, nothing is clamped, and the POST
   is byte-identical to what it was. A batch it calls fully coverable renders
   exactly as before. */

/** The house quantity grid — central-debit-clamp.ts qtyGrid(): a RECIPE
 *  quantity as a whole count of 6-dp steps. */
const grid6 = (n: number) => { const v = Math.round((Number(n) || 0) * 1e6); return v === 0 ? 0 : v; };

interface CentralHoldForecast {
  /** The floor will not let this entry run: held on a 200, or (when no other
   *  entry of the gesture hands anything over) the whole gesture refused. */
  held: boolean;
  /** PURCHASE units the store can still give THIS line — checkCentralIssue's
   *  `availablePurchase`. For a held line it is the figure the server's row
   *  will carry: what is left once the lines that DO run have taken theirs,
   *  shared with earlier held lines of the same item in row order
   *  (rescoreHeldIssue / scoreHeldAtTurn, round 7), so the figures across
   *  sibling rows add up to what is on the shelf. With no other line of the
   *  same item in the gesture it is simply the balance. Print with
   *  fmtCapPU(availPU, pf). */
  availPU: number;
  /** holdsAny() is false for that figure — nothing is left for this line. */
  empty: boolean;
  /** The material's purchase pack factor (for fmtCapPU). */
  pf: number;
  purchaseUnit: string;
  /** Held lines only. The balance as the gesture finds it (the In store
   *  column's figure), and how much of it OTHER lines of the same item in
   *  this gesture take — the lines that run, and earlier held lines' shares.
   *  `others` = 0 when no other line takes any, and then availPU IS poolPU. */
  poolPU: number;
  sharePU: number;
  others: number;
  /** Typed down to `availPU`, the take empties what is left and THE RULE
   *  closes the line (less than one printed step owed) — round 8b. */
  closesAtCap?: boolean;
  /** Row hint only (ReqCard rowHold): how many OTHER open lines of this
   *  requisition draw on the same item — its "Issuable now" is their balance
   *  too. Absent when none do. */
  sharedWith?: number;
  /** THE PARTY RAIL (round 8b). The party transfer moves the line's WHOLE
   *  quantity, so its hold is about the line's TOTAL, and `availPU` above is
   *  then the DELTA this row's box can still add (desk-rule.ts
   *  deskPartyHeadroom) — 0 when nothing fits. */
  party?: {
    /** The shown figure of what the store holds for this line (purchase units). */
    holdsPU: number;
    /** The line's whole quantity the transfer would ask (purchase units). */
    totalPU: number;
    /** What an earlier transfer already moved for the line (round 9 — a short
     *  /store-process submit), purchase units; the transfer asks totalPU − it. */
    movedPU?: number;
    /** The same two exactly (round 10), purchase units, unrounded — what the
     *  transfer still has to move, and what already moved. Print with fmtCapPU. */
    restPU?: number;
    movedExactPU?: number;
    /** The DELTA to add, LINE units (0 = nothing fits). */
    headroomLine: number;
    /** Lowered to that, the transfer takes everything left and THE RULE closes
     *  the line (what is still owed is below one printed step). */
    closesAtCap: boolean;
    /** This row's gesture is refused for ANOTHER line the transfer cannot move
     *  (completing this line runs the transfer). Their material names. */
    blockedBy?: string[];
    /** Round 10: lowered to its headroom, this line completes the requisition
     *  and the transfer then refuses these OTHER lines — the headroom is no way
     *  out. Their material names. */
    capBlockedBy?: string[];
  };
}

interface CentralBatchForecast {
  /** One entry per FLOORED line of the batch, fitting or not. */
  byLine: Record<string, CentralHoldForecast>;
  /** The held lines, in batch order. */
  held: ReqLine[];
  /** Entries the gesture sends at 0 (a box typed to 0): the route skips them
   *  (`addQty <= 0 → continue`), so they are neither held nor issued — they
   *  stay outstanding exactly as they are. In batch order. Counted apart so
   *  "N of M ready" and "every other line is issued" never count them as going
   *  out (round 7 verifier: MIRCHI held + SALT typed 0 + EGGS read "2 of 3
   *  ready … Every other open line is issued" and SALT was not issued). */
  idle: ReqLine[];
  /** Not one entry of the gesture hands anything over, so the server answers
   *  400 and writes nothing (store-issue: `issuableEntries === 0`). */
  refusedWhole: boolean;
  /** WHAT EACH ENTRY THAT RUNS WILL TAKE AND RECORD (round 8), by line id —
   *  desk-rule.ts forecastDeskTake on the same running claim as the holds.
   *  Absent for a held line and for every carve-out. A screen prints from it
   *  ONLY where `changed` (the shelf rule takes a balance that is not the typed
   *  figure) — everywhere else the take IS the typed figure, and the markup
   *  stays byte-identical to production. (Also where `byShelf`: THE RULE
   *  closes the line by the shelf arm, which an ordinary batch never does.) */
  takes: Record<string, DeskTakeForecast>;
  /** A PARTY requisition's transfer on this gesture (round 8b): whether it runs
   *  ('certain' — every line complete, so it must; 'closes' — it is tried and
   *  closes every line; 'none'), and the lines it cannot move — any one of which
   *  refuses the WHOLE gesture, every other line included. */
  party?: {
    runs: DeskPartyForecast['runs'];
    refused: boolean;
    short: Array<{ line: ReqLine; s: DeskPartyShort; headroomLine: number; closesAtCap: boolean }>;
    /** The transfer runs and leaves EVERY line complete, so the requisition is
     *  fulfilled — the only case "… completes the requisition" may be said
     *  (final pass; see partyRunLead). */
    fulfils: boolean;
    /** Lines the transfer runs over but cannot cover, which it leaves OPEN with
     *  their record lowered to what actually left (desk-rule.ts `shortTake`,
     *  `complete` false — the route's `party_short`), in the requisition's order. */
    leftOpen: Array<{ line: ReqLine; tk: DeskTakeForecast }>;
    /** Ruling #45: a ROUTED line is still owed — its department sends it, so
     *  the transfer (which runs once the store's own lines are done) can never
     *  complete the requisition on this gesture. */
    routedOwed?: boolean;
  };
}

/** Will this gesture leave anything behind — a held line, or (party) the
 *  whole gesture refused by the transfer? The one test every banner, bar and
 *  modal branch asks, so a party refusal over a line OUTSIDE the batch (the
 *  completing line's transfer meeting an earlier line the shelf cannot cover)
 *  is never shown as "these items are being issued". */
function forecastBlocks(f: CentralBatchForecast): boolean {
  return f.held.length > 0 || !!f.party?.refused;
}

/** The party transfer forecast for a gesture on this requisition — desk-rule.ts
 *  forecastDeskPartyTransfer over every line in the requisition's order, with
 *  each entry's quantity added to its line (a delta, as /store-issue adds it). */
function partyForecastFor(
  req: Requisition, batch: Array<{ line: ReqLine; qty: number }>, deferIds?: Set<string>,
): DeskPartyForecast {
  const after = new Map<string, number>();
  for (const { line, qty } of batch) {
    const q = Number(qty);
    if (Number.isFinite(q) && q > 0) after.set(line.id, (after.get(line.id) ?? (Number(line.quantity_issued) || 0)) + q);
  }
  return forecastDeskPartyTransfer({
    lines: storeLinesOf(req),
    approvedOf: l => effectiveQty(l as ReqLine),
    rejectedOf: l => !!((l as ReqLine).is_rejected || (l as ReqLine).store_rejected),
    after, deferIds, transferred: !!Number(req.party_transferred || 0),
  });
}

/** The lines the STORE serves — every line but the routed ones (ruling #45).
 *  The party transfer moves these only, and runs once these are done
 *  (store-issue's storePartDone), so every party forecast on this page walks
 *  exactly them. With no routed line it is req.items, unchanged. */
function storeLinesOf(req: Requisition): ReqLine[] {
  return (req.items || []).filter(l => !isRoutedLine(l));
}

/**
 * THE MOST THIS LINE'S BOX CAN ADD NOW (round 9) — the held panel's cap, by
 * THE RULE on the balance this page last loaded (it reloads after every
 * gesture), not only the figure the server named when it refused.
 *
 * The server's figure is a fact about the moment of ITS answer. The panel
 * stays on the line until the storekeeper acts on that same line, so any
 * hand-over of the same item since then (another line, another requisition,
 * a receipt) left it false: X 20 kg refused over 14,842.4 g read "Most it can
 * give now: 14.842 kg", then Y 5 kg went out, and the panel still offered
 * "Issue 14.842 kg — the rest stays outstanding", which the server refused
 * "holds only 9.842 kg" (round-9, sd_stale_cap).
 *
 *   · internal rail: the balance's shown figure (planDeskDebit's
 *     `shownAvailable` — the "In store" column's own number), or a
 *     sub-display crumb's exact figure — exactly the cap the server's row
 *     carries for a lone line (checkCentralIssue `availablePurchase`);
 *   · PARTY rail: the transfer moves the line's WHOLE quantity, so the cap is
 *     on the line's total: forecastDeskPartyTransfer run as if the transfer
 *     runs now (`always`) with this line asking more than any shelf holds,
 *     which reports what is left for it after earlier lines of the same item
 *     (capTotalLine / exactLeftLine), and deskPartyHeadroom turns that into
 *     the delta the box can add.
 * null wherever the page cannot say (a liquor / store-mapped line, a balance
 * or unit the payload does not carry, a party requisition whose transfer has
 * already run); the panel then prints the server's figure as before.
 */
function liveCentralCap(req: Requisition, line: ReqLine): {
  /** The DELTA the box can add, in the LINE's own unit (0 = nothing fits). */
  capLine: number;
  /** The same delta in the purchase unit, exact (print with fmtCapPU). */
  capPU: number;
  /** What the store holds for this line now, purchase units — on the party
   *  rail the shown figure of what is left for the line's total. */
  holdsPU: number;
  /** Party only: what is left for this line exactly, LINE units — the total
   *  the transfer would take and record were the line lowered to it. */
  exactLeftLine: number;
  /** Party only (round 10): what an earlier transfer already moved for this
   *  line, LINE units (desk-rule.ts `movedLine`); 0 on a first transfer. */
  movedLine: number;
} | null {
  if (Number(line.central_flow_blocked || 0)) return null;
  const raw = line.current_stock;
  if (raw == null || !Number.isFinite(Number(raw))) return null;
  const basis = deskLineBasis(line);
  if (!basis) return null;
  const U = lineUnits(line);
  if (req.purpose !== 'party') {
    const plan = planDeskDebit(Number(raw) || 0, 0, basis.meta);
    const g = grid6(plan.available);
    const availPU = plan.shownAvailable > 0 ? plan.shownAvailable : g > 0 ? (g / 1e6) / basis.pf : 0;
    return { capLine: availPU > 0 ? U.fromPU(availPU) : 0, capPU: availPU, holdsPU: availPU, exactLeftLine: 0, movedLine: 0 };
  }
  // A transfer that already ran is no longer the end of it (round 9): the
  // next one moves what the line holds above what moved, and the forecast
  // reads that off party_moved_recipe. Only a payload without the figure
  // leaves the page unable to say.
  if (Number(req.party_transferred || 0) && line.party_moved_recipe == null) return null;
  const issued = Number(line.quantity_issued) || 0;
  const pfc = forecastDeskPartyTransfer({
    lines: storeLinesOf(req),
    approvedOf: l => effectiveQty(l as ReqLine),
    rejectedOf: l => !!((l as ReqLine).is_rejected || (l as ReqLine).store_rejected),
    after: new Map([[line.id, issued + 1e9]]), always: true,
    transferred: !!Number(req.party_transferred || 0),
  });
  const s = pfc.short.find(x => x.id === line.id);
  if (!s) return null;
  const headroom = deskPartyHeadroom(issued, s.capTotalLine, s.exactLeftLine);
  return {
    capLine: headroom, capPU: U.isPU ? headroom : headroom / (U.pf || 1),
    holdsPU: s.availPU, exactLeftLine: s.exactLeftLine, movedLine: Number(s.movedLine) || 0,
  };
}

/**
 * Score a gesture the way /store-issue's pre-flight will. `batch` is in POST
 * order, each entry's `qty` the figure that will be POSTed (in the LINE's own
 * stored unit — resolveIssueQty's `qty`), so the forecast is about exactly the
 * numbers the button sends. Pure; reads only the queue payload.
 */
function forecastCentralHolds(
  req: Requisition,
  batch: Array<{ line: ReqLine; qty: number }>,
  /** Lines the gesture also DEFERS (the split's "defer the balance"): on a party
   *  requisition a deferred line keeps the transfer from closing it. */
  deferIds?: Set<string>,
): CentralBatchForecast {
  const byLine: Record<string, CentralHoldForecast> = {};
  const held: ReqLine[] = [];
  const idle: ReqLine[] = [];
  let issuable = 0;
  const claimed = new Map<string, number>();
  /** How many running entries take something, per material — for the words. */
  const takers = new Map<string, number>();
  const heldMeta: Array<{ line: ReqLine; matId: string; raw: number; meta: PackMeta; pf: number }> = [];
  const takes: Record<string, DeskTakeForecast> = {};
  for (const { line, qty } of batch) {
    const q = Number(qty);
    // The route skips a non-positive or non-finite quantity before it scores
    // anything (`addQty <= 0 → continue`), so such an entry is neither held
    // nor counted as handing anything over — it is `idle`: still open, untouched.
    if (!Number.isFinite(q) || q <= 0) { idle.push(line); continue; }
    const verdict = (() => {
      // Carve-out 1 — the internal rail moves no central stock for a party line.
      if (req.purpose === 'party') return null;
      // Carve-out 2a — a liquor / store-mapped material: its stock moves on its
      // store's ledger and the central floor never applies (round 8b: the
      // payload now says which lines those are).
      if (Number(line.central_flow_blocked || 0)) return null;
      // A balance this page was not given is not guessed at (the In store
      // column prints "—" for it): say nothing rather than cry wolf.
      const raw = line.current_stock;
      if (raw == null) return null;
      const ru = String(line.material_unit || '').trim();
      if (!ru) return null;
      // Carve-out 2 — lineFactor (issue-stock.ts), resolved by the desks' one
      // transcription of it (src/lib/desk-rule.ts deskLineBasis).
      const basis = deskLineBasis(line);
      if (!basis) return null;
      const { meta, pf, factor } = basis;
      // Carve-out 3 — a zero (or credit) delta is not a debit.
      const before = Number(line.quantity_issued) || 0;
      const deltaLine = (before + q) - before;
      const ask = Math.round(deltaLine * factor * 1e6) / 1e6;
      if (ask <= 1e-9) return null;
      const matId = String(line.material_id || '');
      const already = claimed.get(matId) || 0;
      // THE SHOWN-FIGURE RULE — planCentralDebit with checkCentralIssue's own
      // converter (round 8: the grid point's shownPurchaseQty, its toPurchaseQty
      // renderings still matched), through desk-rule.ts planDeskDebit, so the
      // forecast and the server's pre-flight cannot score one ask two ways.
      const plan = planDeskDebit((Number(raw) || 0) - already, ask, meta);
      const { available, fits } = plan;
      if (fits) {
        claimed.set(matId, already + plan.debit);
        if (grid6(plan.debit) > 0) takers.set(matId, (takers.get(matId) || 0) + 1);
        // WHAT THE TAKE WILL RECORD, AND WHETHER IT CLOSES THE LINE — the same
        // pass, the same running claim (forecastDeskTake: checkCentralIssue's
        // recordAfterLineQty, the shelf mark applyIssueDelta stamps, THE RULE).
        const tk = forecastDeskTake({
          line, purpose: req.purpose, approved: effectiveQty(line), deltaLine: q, claimedRecipe: already,
        });
        if (tk) takes[line.id] = tk;
      } else {
        heldMeta.push({ line, matId, raw: Number(raw) || 0, meta, pf });
      }
      const holds = grid6(available) > 0;
      const shownAvail = plan.shownAvailable;
      const f: CentralHoldForecast = {
        held: !fits,
        availPU: shownAvail > 0 ? shownAvail : holds ? (grid6(available) / 1e6) / pf : 0,
        empty: !holds,
        pf,
        purchaseUnit: String(line.material_purchase_unit || ru).trim(),
        poolPU: 0, sharePU: 0, others: 0,
      };
      return f;
    })();
    if (verdict) byLine[line.id] = verdict;
    if (verdict?.held) held.push(line);
    else issuable++;
  }
  /* A HELD LINE'S FIGURE IS WHAT THE SERVER'S ROW WILL SAY — never a pool that
     other lines of the same item are also being offered. The decision above is
     the pre-flight's and is final (a held line claims nothing). The figures
     are the server's round-7 re-score: after the gesture every running line
     has taken its share (rescoreHeldIssue reads the balance with nothing
     claimed, after the writes; on a whole refusal nothing ran), and held lines
     of one material share what is left in row order — the first is given what
     it can take, which is all of it (it was short at its turn and the balance
     only fell since), the next what remains (scoreHeldAtTurn's siblingRecipe).
     Measured without this: MANGO 1 kg typed on two lines over a 1 kg shelf
     read "(books: none)" for the second while the In store column said 1 kg,
     and two short lines over 1 kg each read "(books: 1 kg)" — 2 kg offered
     from one. */
  const heldShare = new Map<string, number>();
  const heldTakers = new Map<string, number>();
  const capOf = (x: number, meta: PackMeta, pf: number) => {
    // The server's cap figure (checkCentralIssue `availablePurchase`):
    // shownPurchaseQty — the grid point, then integer half-up (round 8).
    const shown = shownPurchaseQty(x, meta);
    return shown > 0 ? shown : grid6(x) > 0 ? (grid6(x) / 1e6) / pf : 0;
  };
  for (const h of heldMeta) {
    const f = byLine[h.line.id];
    const pool = h.raw > 0 ? h.raw : 0;
    const run = claimed.get(h.matId) || 0;
    const earlier = heldShare.get(h.matId) || 0;
    const left = Math.max(0, pool - run - earlier);
    heldShare.set(h.matId, earlier + left);
    const others = (takers.get(h.matId) || 0) + (heldTakers.get(h.matId) || 0);
    if (grid6(left) > 0) heldTakers.set(h.matId, (heldTakers.get(h.matId) || 0) + 1);
    f.availPU = capOf(left, h.meta, h.pf);
    f.empty = !(grid6(left) > 0);
    f.poolPU = capOf(pool, h.meta, h.pf);
    f.sharePU = capOf(Math.max(0, pool - left), h.meta, h.pf);
    f.others = grid6(pool - left) > 0 ? others : 0;
    // Lowered to that cap, does the take close the line (round 8b)? The cap
    // is the shown figure of what is left, so it takes everything left; when
    // less than one printed step is then owed THE RULE closes the line, and
    // "the rest needs stock received" would be false — there is no rest.
    if (!f.empty) {
      const tk = forecastDeskTake({
        line: h.line, purpose: req.purpose, approved: effectiveQty(h.line),
        deltaLine: lineUnits(h.line).fromPU(f.availPU), claimedRecipe: Math.max(0, pool - left),
      });
      f.closesAtCap = !!tk?.complete;
    }
  }
  /* THE PARTY TAKE (round 8b). On a PARTY requisition the internal rail moves
     no central stock (carve-out 1 above); the take is the store → department
     TRANSFER, which moves each line's WHOLE quantity_issued once, line by line,
     by the same shelf rule — and refuses the WHOLE gesture over one line the
     shelf cannot cover. desk-rule.ts forecastDeskPartyTransfer says whether this
     gesture runs it (store-issue: every line complete → it must; or it is tried
     and closes every line) and what each line's take records. Measured without
     it: Issue All listed "THREE MANGO × 14.843 kg = 14,843 g" and "SALT × 2 kg"
     under "being issued" over a 14,842.4 g shelf, and the server refused the
     lot; a line issued 14.842 earlier read "× 0.001 kg = 1 g" while the
     transfer moved 14,842.5 g (round-8 verifier). */
  let party: CentralBatchForecast['party'];
  if (req.purpose === 'party') {
    const pfc = partyForecastFor(req, batch, deferIds);
    party = { runs: pfc.runs, refused: false, short: [], fulfils: false, leftOpen: [] };
    if (pfc.runs !== 'none') for (const [id, tk] of Object.entries(pfc.takes)) takes[id] = tk;
    if (pfc.runs !== 'none') {
      for (const l of req.items || []) {
        const tk = pfc.takes[l.id];
        if (tk && tk.shortTake && !tk.complete) party.leftOpen.push({ line: l, tk });
      }
    }
    if (pfc.runs === 'certain' && pfc.short.length > 0) {
      party.refused = true;
      const inBatch = new Set(batch.map(b => b.line.id));
      for (const s of pfc.short) {
        const line = (req.items || []).find(l => l.id === s.id);
        const basis = line ? deskLineBasis(line) : null;
        if (!line || !basis) continue;
        const before = Number(line.quantity_issued) || 0;
        const headroomLine = deskPartyHeadroom(before, s.capTotalLine, s.exactLeftLine);
        // Lowered to the headroom the line's total is the shown cap (or the
        // shelf's own grid point), which takes everything left: it records
        // that, and THE RULE closes it if less than one printed step is owed.
        const closesAtCap = headroomLine > 0 && deskCovers(s.exactLeftLine, effectiveQty(line), basis.step, true);
        const U = lineUnits(line);
        const toPUexact = (q: number) => U.isPU ? q : q / (U.pf || 1);
        byLine[line.id] = {
          held: true,
          availPU: toPUexact(headroomLine),
          empty: !(headroomLine > 0),
          pf: U.pf,
          purchaseUnit: String(line.material_purchase_unit || line.material_unit || '').trim(),
          poolPU: s.availPU, sharePU: 0, others: 0,
          party: {
            holdsPU: s.availPU, totalPU: U.toPU(s.totalLine), movedPU: U.toPU(s.movedLine || 0), headroomLine, closesAtCap,
            // Exact (round 10): 14.843 − 14.8424 is 0.0006 kg, which the two
            // 3-dp figures above subtract to "0.001 kg".
            restPU: toPUexact(Math.max(0, s.totalLine - (s.movedLine || 0))),
            movedExactPU: toPUexact(s.movedLine || 0),
          },
        };
        if (inBatch.has(line.id)) held.push(line);
        party.short.push({ line, s, headroomLine, closesAtCap });
      }
    }
    // Routed lines still owed (ruling #45) keep the requisition open whatever
    // the transfer does: it moves the store's lines only.
    party.routedOwed = (req.items || []).some(l => isRoutedLine(l)
      && !l.is_rejected && !l.store_rejected && !lineIssueComplete(l));
    party.fulfils = pfc.runs !== 'none' && !party.refused && !pfc.unknown && !party.routedOwed
      && Object.values(pfc.takes).every(t => t.complete);
  }
  return {
    byLine, held, idle, takes, party,
    // A party line the transfer cannot move refuses the WHOLE gesture.
    refusedWhole: (held.length > 0 && issuable === 0) || !!party?.refused,
  };
}

/**
 * The sentence for the lines a gesture sends at 0 — the same words the
 * management desk's ⛔ banner uses (requisitions/page.tsx zeroEntrySentence):
 * "SALT is entered as 0, so it is not issued either."
 */
function zeroEntrySentence(names: string[]): string {
  const list = names.length <= 1 ? (names[0] || '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const one = names.length <= 1;
  return `${list} ${one ? 'is' : 'are'} entered as 0, so ${one ? 'it is' : 'they are'} not issued either.`;
}

/**
 * The advance warning for a gesture that will leave lines behind — the
 * management desk's round-6 banner (requisitions/page.tsx, "⛔ … ask for more
 * than the central store's books hold"), word for word except where this desk
 * is different: the gesture is named ("on Issue All", not "on submit"), "every
 * other line" is scoped to the lines the gesture actually sends, and the
 * pointer to Issue Requisitions is dropped because this IS Issue Requisitions —
 * a held line simply stays open here. Rendered only when something is held,
 * so a fully-coverable batch renders exactly as it always has.
 */
function CentralHoldBanner({ forecast, gesture, scope }: {
  forecast: CentralBatchForecast;
  /** The button, as the storekeeper reads it: "Issue All", "Issue Selected", "Confirm". */
  gesture: string;
  /** What "every other …" means for this gesture: "open line", "selected line". */
  scope: string;
}) {
  if (forecast.party?.refused) return <PartyRefusalBanner forecast={forecast} gesture={gesture} />;
  const n = forecast.held.length;
  if (n === 0) return null;
  const one = n === 1;
  return (
    <div className="text-[11px] px-3 py-2 bg-red-50 border-2 border-red-300 rounded text-red-900">
      <div className="font-semibold">
        ⛔ {n} line{one ? '' : 's'} ask{one ? 's' : ''} for more than the central store&apos;s books hold
        {forecast.refusedWhole ? (
          <> — and no other line hands anything over, so the store will <b>refuse the whole issue</b> and save nothing.</>
        ) : forecast.idle.length === 0 ? (
          <> — on {gesture} {one ? 'it is' : 'they are'} <b>NOT issued and {one ? 'stays' : 'stay'} outstanding</b>.
            Every other {scope} is issued.</>
        ) : (
          /* A line the gesture sends at 0 is skipped, not issued — "every other
             line is issued" must not count it (round 7 verifier). Named before
             that sentence, so "every other" is read as excluding it. A separate
             branch, so a gesture with no such line renders exactly as before. */
          <> — on {gesture} {one ? 'it is' : 'they are'} <b>NOT issued and {one ? 'stays' : 'stay'} outstanding</b>.
            {' '}{zeroEntrySentence(forecast.idle.map(l => l.material_name))}{' '}Every other {scope} is issued.</>
        )}
      </div>
      <div className="text-[10px] mt-0.5">
        {forecast.held.map(l => {
          const c = forecast.byLine[l.id];
          const fig = (v: number) => `${fmtCapPU(v, c.pf)} ${c.purchaseUnit}`;
          // Another line of the same item in this gesture takes some of the
          // balance: name the balance and the split, in the server's own words
          // ("… and all of it goes to the line above for the same item"), so the
          // figure is never "none" over a stocked shelf and two rows are never
          // both offered the whole of it. Without one, the management desk's
          // fragment, unchanged.
          if (c.others > 0) {
            const them = c.others === 1 ? 'the other line' : `the ${c.others} other lines`;
            return c.empty
              ? `${l.material_name} (books: ${fig(c.poolPU)}, and all of it goes to ${them} for the same item)`
              : `${l.material_name} (books: ${fig(c.poolPU)}, and ${fig(c.sharePU)} of it goes to ${them} for the same item — ${fig(c.availPU)} for this one)`;
          }
          return `${l.material_name} (books: ${c.empty ? 'none' : fig(c.availPU)})`;
        }).join(', ')}
        .{' '}
        {forecast.refusedWhole && forecast.held.every(l => forecast.byLine[l.id]?.closesAtCap) ? (
          /* Round 8b: the cap takes everything left and closes the line — say
             that, not "the rest needs stock" over a rest below one step. */
          <>Lower {one ? 'that line' : 'those lines'} to what the store can give — it then takes everything the store
            holds and {one ? 'the line closes' : 'the lines close'} (what is still owed is below one printed step).</>
        ) : forecast.refusedWhole ? (
          <>Lower {one ? 'that line' : 'those lines'} to what the store can give — the rest needs stock received
            or a closing count recorded.</>
        ) : (
          <>Lower {one ? 'that line' : 'those lines'} to what the store can give and {one ? 'it goes' : 'they go'} out
            with the rest.</>
        )}
        {' '}If {one ? 'it is' : 'they are'} liquor-store items, the stock moves on the Liquor
        Store ledger and the store will accept the hand-over as entered.
      </div>
    </div>
  );
}

/**
 * THE PARTY TRANSFER WILL REFUSE THIS GESTURE (round 8b) — said before the
 * click. On a party requisition completing the last line runs the store →
 * department transfer, which moves EVERY line at once and refuses the whole
 * POST over one line the shelf cannot cover: SALT is not issued either. So the
 * internal banner's "Every other line is issued" / "no other line hands
 * anything over" would both be false here. The way out it names is the one the
 * server accepts: the line lowered to its headroom (desk-rule.ts
 * deskPartyHeadroom), which the transfer then takes as everything the store
 * holds — closing the line by THE RULE when less than one printed step is left
 * owing, and otherwise recording it while nothing moves until the rest arrives.
 */
function PartyRefusalBanner({ forecast, gesture }: { forecast: CentralBatchForecast; gesture: string }) {
  const sh = forecast.party?.short || [];
  if (sh.length === 0) return null;
  const n = sh.length;
  const one = n === 1;
  const fig = (v: number, pf: number, pu: string) => `${fmtCapPU(v, pf)}${pu ? ` ${pu}` : ''}`;
  const withRoom = sh.filter(x => x.headroomLine > 0);
  const allClose = withRoom.length === n && sh.every(x => x.closesAtCap);
  return (
    <div className="text-[11px] px-3 py-2 bg-red-50 border-2 border-red-300 rounded text-red-900">
      <div className="font-semibold">
        ⛔ {n} line{one ? '' : 's'} ask{one ? 's' : ''} for more than the central store&apos;s books hold — a party
        requisition&apos;s goods leave the store in one transfer, every line at once, so on {gesture} the store
        will <b>refuse the whole issue</b> and save nothing, the other lines included.
      </div>
      <div className="text-[10px] mt-0.5">
        {sh.map(x => {
          const c = forecast.byLine[x.line.id];
          const pu = c?.purchaseUnit || '';
          const pf = c?.pf || 1;
          // A top-up (round 9) asks only what the line holds above what already moved.
          const moved = c?.party?.movedPU || 0;
          return moved > 0
            ? `${x.line.material_name} (books: ${x.s.empty ? 'none' : fig(x.s.availPU, pf, pu)} of the ${fig(c?.party?.restPU ?? Math.max(0, (c?.party?.totalPU || 0) - moved), pf, pu)} still to move)`
            : `${x.line.material_name} (books: ${x.s.empty ? 'none' : fig(x.s.availPU, pf, pu)} of the ${fig(c?.party?.totalPU || 0, pf, pu)} the line asks in all)`;
        }).join(', ')}
        .{' '}
        {sh.every(x => x.s.empty) ? (
          <>The store&apos;s books hold none of {one ? 'it' : 'them'} — get stock received or a closing count recorded
            first.</>
        ) : withRoom.length === 0 ? (
          /* The line already holds at least what the shelf has (it was
             recorded while other lines were open, or the shelf fell since):
             the only figures that fit are lower than what it holds, and the
             only way to lower it is an undo. */
          sh.some(x => (x.s.movedLine || 0) > 0) ? (
            /* A top-up (round 9): undoing cannot put back what already moved,
               so the undo advice would send nothing. */
            <>Nothing more fits on {one ? 'that line' : 'those lines'} until stock arrives. Defer the rest, or get stock
              received or a closing count recorded first.</>
          ) : (
          <>Nothing more fits on {one ? 'that line' : 'those lines'} — {one ? 'it already holds' : 'they already hold'} at
            least what the store has. Undo {one ? 'it' : 'them'} and issue what the store holds again, or get stock
            received or a closing count recorded first.</>
          )
        ) : allClose ? (
          <>Enter {withRoom.map(x => {
            const c = forecast.byLine[x.line.id];
            return `${fmtCapPU(c?.availPU || 0, c?.pf || 1)}${c?.purchaseUnit ? ` ${c.purchaseUnit}` : ''} for ${x.line.material_name}`;
          }).join(', ')} instead — the transfer then takes everything the store holds, {one ? 'the line closes' : 'those lines close'} (what
            is still owed is below one printed step), and the whole requisition goes out together.</>
        ) : (
          <>Enter what the store can give and every line is recorded — but nothing leaves the store until every line
            of this party requisition is complete, so the rest needs stock received or a closing count recorded first.</>
        )}
        {' '}If {one ? 'it is' : 'they are'} liquor-store items, the stock moves on the Liquor Store ledger and the store
        will accept the hand-over as entered.
      </div>
    </div>
  );
}

/**
 * THE GESTURE REOPENS A PARTY LINE IT DOES NOT ISSUE ON (final pass) — said
 * before the click, from the transfer's own forecast (CentralBatchForecast
 * `party.leftOpen`): the gesture leaves no line open, the transfer runs, and a
 * top-up the shelf cannot cover takes what the shelf holds, lowers that line's
 * record to what actually left and reopens it — the route's party_short.
 * Nothing renders on a gesture where that does not happen, or that the
 * transfer refuses whole (PartyRefusalBanner says that).
 */
function PartyLeftOpenNote({ party, gesture }: { party: CentralBatchForecast['party'] | undefined; gesture: string }) {
  if (!party || party.refused || party.runs === 'none') return null;
  const s = partyLeftOpenSentence(party);
  if (!s) return null;
  return (
    <div className="text-[11px] px-3 py-2 bg-amber-50 border border-amber-300 rounded text-amber-900">
      {gesture} leaves {party.routedOwed ? "none of the store's lines" : 'no line'} open, so the party transfer runs.{s}
    </div>
  );
}

/** The Issue All confirmation is worked out from the books this page last
 *  loaded (final pass): another screen can move the shelf in between, and the
 *  store then decides by its books at the click — the round-10 fuzz saw a line
 *  listed "being issued" refused, and one listed NOT issued go out. */
function ForecastBasisNote() {
  return (
    <div className="text-[10px] text-[#8B7355]">
      Worked out from the central store&apos;s books as this page last loaded them. If stock has moved since, Confirm
      goes by the store&apos;s books at that moment, and anything it does not issue is named after the click.
    </div>
  );
}

export default function StoreRequisitionsPage() {
  const [list, setList] = useState<Requisition[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StoreTab>('open');
  // Issued-log state (date range, fetched separately from the queue).
  // IST, not UTC: before 05:30 IST a UTC "today" is still yesterday's date, and
  // the store opens its log expecting the day it is standing in.
  const todayStr = todayIST();
  const [logFrom, setLogFrom] = useState(todayStr);
  const [logTo, setLogTo] = useState(todayStr);
  const [log, setLog] = useState<{ events: any[]; totals: any } | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  // MERGE INTO ONE PO — who may (ruling #65: store manager + admin, the same
  // canProcessAsStore rule the merge route enforces), and the open modal with
  // the lines it starts ticked ("Add to a merged PO" on a deferred line). Until
  // the session answers, nobody may: the button stays hidden rather than
  // flashing at someone the route would refuse.
  const [canMerge, setCanMerge] = useState(false);
  const [mergeOpen, setMergeOpen] = useState<{ preselect: string[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        const u = j?.user;
        if (!cancelled) setCanMerge(!!u && (u.role === 'admin' || !!u.is_store_manager));
      })
      .catch(() => { if (!cancelled) setCanMerge(false); });
    return () => { cancelled = true; };
  }, []);

  // fetch wrapper that gives a useful error if the server returned HTML (login
  // redirect, 404, etc.) instead of JSON. Avoids the cryptic
  // "Unexpected token '<', '<!DOCTYPE'..." that breaks the page.
  const fetchJson = async (url: string) => {
    const r = await fetch(url, { credentials: 'same-origin' });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      const text = (await r.text()).slice(0, 120);
      throw new Error(`${url} returned non-JSON (status ${r.status}): ${text}`);
    }
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `${url} → HTTP ${r.status}`);
    return j;
  };
  const [deptId, setDeptId] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [editQty, setEditQty] = useState<Record<string, string>>({});
  // Why more than approved was handed over — recorded on the issue-history entry.
  const [issueNotes, setIssueNotes] = useState<Record<string, string>>({});
  const [editDefer, setEditDefer] = useState<Record<string, { until: string; reason: string }>>({});
  // "Issue N, defer the rest" — the gesture, captured the moment the store asks
  // for the split:
  //   qty   the hand-over quantity in the LINE's own stored unit. Held apart
  //         from editQty (a purchase-unit STRING the user keeps typing in) so
  //         the number cannot drift while the promised time is being picked.
  //   token the per-gesture idempotency token /store-issue accepts as
  //         body.client_token (route.ts:121-127). Minted HERE, not at POST time,
  //         so a re-submit of the SAME gesture carries the SAME token and the
  //         ledger's (client_token, req_item_id) index can recognise the replay.
  //         Optional by contract, and inert while requisition_deduct_at_issue is
  //         '0' — no ledger row exists to collide with, so today it changes
  //         nothing whatsoever.
  // A key here is also what turns the defer panel into the combined action.
  const [splitIssueQty, setSplitIssueQty] = useState<Record<string, { qty: number; token: string }>>({});
  const [showHistoryFor, setShowHistoryFor] = useState<string | null>(null);
  // Refused reversals, keyed by requisition_item id — see BlockedReversal above.
  // Held OUTSIDE the requisition list on purpose: a reload must not wipe the
  // reason off the screen, and the entry is cleared only when the storekeeper
  // acts on that same line again.
  const [blockedReversals, setBlockedReversals] = useState<Record<string, BlockedReversal>>({});
  // Flipped false the first time the pre-check route answers 404/405 — see
  // precheckReversal. A ref, not state: nothing renders from it, and a re-render
  // per undo to record "that endpoint isn't there" would be noise. Resets on
  // page load, so deploying the route later needs no code change here.
  const precheckAvailable = useRef(true);
  // Central-stock refusals, keyed by requisition_item id — see CentralShort
  // above. Same lifetime rule as blockedReversals: it must survive a reload, and
  // it is cleared only when the storekeeper acts on that same line again.
  const [centralShort, setCentralShort] = useState<Record<string, CentralShort>>({});
  // A Reject / Undo the central floor refused (round 10), keyed by the line
  // whose button was pressed — see ReversalShort.
  const [reversalShort, setReversalShort] = useState<Record<string, ReversalShort>>({});
  // Party lines another gesture's transfer lowered and reopened, by line id —
  // see PartyShortNote.
  const [partyShort, setPartyShort] = useState<Record<string, PartyShortNote>>({});
  const clearBlocked = (...lineIds: string[]) => {
    setReversalShort(s => {
      const hit = lineIds.filter(id => id in s);
      if (hit.length === 0) return s;
      const n = { ...s }; for (const id of hit) delete n[id]; return n;
    });
    setPartyShort(s => {
      const hit = lineIds.filter(id => id in s);
      if (hit.length === 0) return s;
      const n = { ...s }; for (const id of hit) delete n[id]; return n;
    });
    setBlockedReversals(s => {
      const hit = lineIds.filter(id => id in s);
      if (hit.length === 0) return s;                 // no-op keeps the ref stable
      const n = { ...s }; for (const id of hit) delete n[id]; return n;
    });
    // Cleared on the SAME gesture, for the same reason: a stale "only 14.842 kg"
    // sitting beside a line that has just gone out reads as a fresh failure, and
    // the figure itself is a lie the moment any stock moves.
    setCentralShort(s => {
      const hit = lineIds.filter(id => id in s);
      if (hit.length === 0) return s;
      const n = { ...s }; for (const id of hit) delete n[id]; return n;
    });
  };
  /* Shared tail for the four ISSUE actions, mirroring showReversalError: a typed
     central-stock refusal goes inline against the named line(s); anything else
     (wrong status, signed out, CSRF, a dropped LAN packet) is requisition-level
     and stays an alert, because burying that under one row is how it gets
     missed. Returns true when it was handled as a per-line refusal.

     THE REQUISITION IS EXPANDED when a refusal lands, and that is not a flourish
     — "Issue All" and "Issue Selected" are pressed from the CARD HEADER and the
     refused line can be anywhere below it, or behind a collapsed card, in which
     case a panel nobody can see is no better than the alert it replaced.
     A MULTI-LINE GESTURE ALSO KEEPS THE ALERT, because the route refuses the
     batch WHOLE ("nothing was issued and the requisition is unchanged") and that
     is a fact about the gesture, not about any one row; the panels then hold the
     per-line numbers for as long as the storekeeper needs them. */
  /* ROUTED, refused by the route (ruling #45): this screen was opened before
     the line was routed (the HOD approved it since, or the deploy routed it),
     so it still offered a store action. The whole gesture was refused — nothing
     was written. The server's sentence verbatim, then re-read the list so the
     row reads "routed" and loses its issue controls. True when handled. */
  const routedRefused = (j: { code?: unknown; error?: unknown } | null | undefined, fallback: string): boolean => {
    if (String(j?.code || '') !== 'routed') return false;
    alert(String(j?.error || '').trim() || fallback);
    setRefreshKey(k => k + 1);
    return true;
  };
  const showIssueError = (
    j: { code?: unknown; error?: unknown; blocked?: unknown } | null | undefined,
    batch: { id: string; material_name: string }[], fallback: string,
    reqId?: string,
  ): boolean => {
    // DELIVERED DIRECT (ruling #68), refused by the route: this screen was
    // opened before the merged PO's Direct Issue receipt, so it still offered
    // the line. The server's sentence verbatim, then re-read the list so the
    // row reads "Delivered direct" and loses its issue controls.
    if (String(j?.code || '') === 'delivered_direct') {
      alert(String(j?.error || '').trim() || fallback);
      setRefreshKey(k => k + 1);
      return true;
    }
    if (routedRefused(j, fallback)) return true;
    const short = readCentralShort(j, batch);
    if (Object.keys(short).length > 0) {
      setCentralShort(s => ({ ...s, ...short }));
      if (reqId) setExpanded(p => (p.has(reqId) ? p : new Set(p).add(reqId)));
      // The alert also when no panel lands on the line that was pressed (final
      // pass): a party refusal names the lines the TRANSFER could not move —
      // one or several (round 10), each on its own row — and the pressed line
      // is usually not among them, so its row would otherwise say nothing.
      if (j?.error && (batch.length > 1 || !batch.some(b => b.id in short))) alert(String(j.error));
      return true;
    }
    alert(j?.error || fallback);
    return false;
  };
  /* The SUCCESS-side twin of showIssueError, called on the 200 of all four
     ISSUE actions. Before this, every success path did setRefreshKey and
     nothing else. A gesture that handed over five lines and HELD the sixth
     looked exactly like one that handed over all six, and the storekeeper
     learnt about the sixth only if he noticed it was still in the queue.

     It does the same three things the multi-line refusal does, for the same
     reasons:
       - the per-line panels, so the figure ("holds only 14.842 kg") and the
         one-click partial issue sit on the line that was held, and stay there
         until he acts on that line again (clearBlocked)
       - the card is EXPANDED, because Issue All / Issue Selected are pressed
         from the card header and the held line can be anywhere below it
       - ONE alert with the server's own `held_message`, printed VERBATIM.
         That is the sentence the management desk prints for the same event
         (store-process's `stock_held_note`, folded into the po_note it shows as
         "Server summary:"), word for word except "in this gesture" for "on this
         requisition", so both desks say it the same way. The alert is the
         interruption: a held line is a fact about goods, not paperwork. A
         panel on a reloaded card he is not looking at is exactly how it got
         missed.

     Returns the ids of the lines that were held (empty when nothing was), so a
     single-line caller keeps the typed figure on a line that did not go out
     instead of clearing it as if it had. A fully-issued response carries no
     `held` and no `held_message`, so this does nothing at all and every path
     behaves exactly as before. */
  const announceHeld = (
    j: { held?: unknown; held_message?: unknown } | null | undefined,
    batch: { id: string; material_name: string }[],
    reqId?: string,
  ): Set<string> => {
    const held = readCentralHeld(j, batch);
    const ids = Object.keys(held);
    let msg = String(j?.held_message || '').trim();
    const rows = Array.isArray(j?.held) ? (j!.held as Record<string, unknown>[]) : [];
    // Only when the server sent rows but not the sentence, which is not a shape
    // it produces today. Built from the route's own words (store-issue/route.ts
    // held_message) so the fallback cannot read differently from the real thing.
    if (!msg && rows.length > 0) {
      const n = rows.length;
      msg = `${n} line${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} NOT issued and `
        + `${n === 1 ? 'stays' : 'stay'} outstanding — the central store does not hold the quantity asked. `
        + rows.map(b => String(b?.message || '').trim()).filter(Boolean).join(' ')
        + ` Everything else in this gesture was issued.`;
    }
    if (ids.length === 0 && !msg) return new Set();
    if (ids.length > 0) setCentralShort(s => ({ ...s, ...held }));
    if (reqId) setExpanded(p => (p.has(reqId) ? p : new Set(p).add(reqId)));
    if (msg) alert(msg);
    return new Set(ids);
  };
  /* THE DEFER THE SERVER DID NOT WRITE (round 8). /store-issue drops a 'defer'
     on a line that is complete — issued in full, or a take in the same POST
     emptied the central shelf and less than one printed step is owed — and
     names it on the 200 (`defer_dropped[]`, `defer_dropped_message`). Printed
     VERBATIM, like held_message. A 200 without it (every other gesture) does
     nothing at all. */
  const announceDeferDropped = (j: { defer_dropped_message?: unknown } | null | undefined) => {
    const msg = String(j?.defer_dropped_message || '').trim();
    if (msg) alert(msg);
  };
  /* A PARTY LINE THE TRANSFER LOWERED AND REOPENED, on ANY store-issue 200
     (final pass) — see PartyShortNote. Every gesture that can leave no line
     open can run the transfer (an issue, a reject, a defer the route drops, an
     unreject), so every 200 handler calls this. A 200 without `party_short`
     does nothing at all. */
  const announcePartyShort = (
    j: { party_short?: unknown; party_short_message?: unknown } | null | undefined,
    reqId: string,
  ) => {
    const rows = Array.isArray(j?.party_short) ? (j!.party_short as Record<string, unknown>[]) : [];
    const add: Record<string, PartyShortNote> = {};
    for (const b of rows) {
      const id = String(b?.line_id || b?.req_item_id || '');
      if (!id) continue;
      add[id] = {
        reqId, message: String(b?.message || '').trim(),
        recordedLine: b?.recorded_line_qty == null ? NaN : Number(b.recorded_line_qty),
      };
    }
    const msg = String(j?.party_short_message || '').trim()
      || Object.values(add).map(x => x.message).filter(Boolean).join(' ');
    if (Object.keys(add).length === 0 && !msg) return;
    if (Object.keys(add).length > 0) setPartyShort(s => ({ ...s, ...add }));
    setExpanded(p => (p.has(reqId) ? p : new Set(p).add(reqId)));
    if (msg) alert(msg);
  };
  /* WHAT A HAND-OVER USES UP ON THE LINES IT ISSUED (round 9) — the multi-line
     twin of issueLine's success tail. Issue All and Issue Selected post each
     line's TYPED figure (resolveIssueQty), and left it in the box afterwards,
     together with any "Issue part, defer rest" capture built on it: a split
     opened on a 20 kg line with 15 typed, then Issue All, read "Handing over 15
     kg now, the balance 0 kg is promised for" over a line that now held 15 —
     the panel the held cap already closes in issueLine (round 8b), stale by
     another button (sd_issueall_after_split). The box, its over-issue reason
     and a split capture go; a plain Defer panel the storekeeper opened stays,
     because it is about the balance, which is still owed. Only lines that
     WENT OUT — a held line keeps its figure for the correction, and a line
     sent at 0 was skipped by the route. */
  const consumeIssued = (ids: string[]) => {
    if (ids.length === 0) return;
    function drop<T>(s: Record<string, T>): Record<string, T> {
      const hit = ids.filter(id => id in s);
      if (hit.length === 0) return s;
      const n = { ...s }; for (const id of hit) delete n[id]; return n;
    }
    setEditQty(drop);
    setIssueNotes(drop);
    const split = ids.filter(id => splitIssueQty[id]);
    if (split.length > 0) {
      setSplitIssueQty(s => { const n = { ...s }; for (const id of split) delete n[id]; return n; });
      setEditDefer(s => { const n = { ...s }; for (const id of split) delete n[id]; return n; });
    }
  };
  /* A LINE THAT MOVED UNDER THIS PAGE (round 9). The held panel, the split
     editor, the typed box and its over-issue reason are this desk's own
     intent for a line AS IT STOOD when the storekeeper formed it — they
     survive a reload on purpose ("cleared only when the storekeeper acts on
     that same line again"), because a refusal must not vanish off the screen.
     But a line can be acted on ELSEWHERE: the management desk issued it in
     full, a colleague's tab rejected it. Every figure those panels carry is
     then relative to a line that no longer exists, and two of them became
     live buttons: SALT 2 kg, refused 20 kg here (reason "full bag"), then
     issued 2/2 on the management desk — after Refresh the held panel offered
     "Issue 12.842 kg … the line is issued in full", posted 12.842 with the
     stale reason, and the server took it (line 14.842 of 2 kg, shelf 0,
     no over-issue warning ever shown; round-9 verifier stale-cap); a split
     refused here read "Handing over 0.001 kg now, the balance 0 kg is promised
     for [Issue & defer balance]" on a Fulfilled line and answered an alert
     (verifier stale). So each reload compares what it loaded with what the
     previous one did, line by line — the four columns a hand-over, a
     rejection or a take changes — and a line that moved drops all five. Its
     own row then reads the line as it now is. This desk's own gestures
     already clear these on success (clearBlocked / consumeIssued), and a
     line the server HELD did not move, so its panel stays exactly as before;
     the first load compares with nothing and drops nothing. A refused
     reversal's panel (blockedReversals) is about the reversal, not the
     hand-over, and is left alone. */
  const lineSigs = useRef<Map<string, string>>(new Map());
  const approvalSigs = useRef<Map<string, string>>(new Map());
  // Module-level since round 10 (lineSigOf), so reqSig reads the same identity.
  const lineSig = lineSigOf;
  const dropMovedLines = (reqs: Requisition[]) => {
    const moved: string[] = [];
    // An approval changed and nothing else (final pass, see lineSigOf): only
    // the store's held panel goes — the storekeeper's own input stays, as in
    // production.
    const reapproved: string[] = [];
    for (const rq of reqs) {
      for (const it of rq.items || []) {
        const id = String(it.id);
        const sig = lineSig(it);
        const was = lineSigs.current.get(id);
        if (was !== undefined && was !== sig) moved.push(id);
        lineSigs.current.set(id, sig);
        const asig = lineApprovalSigOf(it);
        const awas = approvalSigs.current.get(id);
        if (awas !== undefined && awas !== asig) reapproved.push(id);
        approvalSigs.current.set(id, asig);
      }
    }
    if (moved.length === 0 && reapproved.length === 0) return;
    function dropOf(ids: string[]) {
      return function drop<T>(s: Record<string, T>): Record<string, T> {
        const hit = ids.filter(id => id in s);
        if (hit.length === 0) return s;
        const n = { ...s }; for (const id of hit) delete n[id]; return n;
      };
    }
    if (moved.length > 0) {
      const drop = dropOf(moved);
      setEditQty(drop);
      setIssueNotes(drop);
      setEditDefer(drop);
      setSplitIssueQty(drop);
    }
    setCentralShort(dropOf([...moved, ...reapproved]));
  };
  /* EVERY LOAD SETTLES WHAT IT MADE STALE (round 10) — the comparison above
     catches a line that MOVED; this catches a panel whose line is now simply
     done, whatever moved it: a held panel on a line complete by THE RULE or
     rejected (heldPanelSettled — a party line the transfer still has to move
     keeps its panel), a split capture its line no longer owes more than
     (splitCaptureStale), and a refused Reject / Undo whose requisition is no
     longer what the refusal read (reqSig). Runs on the loaded list, so it
     never fires on the post-gesture state a refusal itself leaves (a refusal
     does not reload). */
  useEffect(() => {
    const byLine = new Map<string, { rq: Requisition; line: ReqLine }>();
    const byReq = new Map<string, Requisition>();
    for (const rq of list) {
      byReq.set(rq.id, rq);
      for (const it of rq.items || []) byLine.set(String(it.id), { rq, line: it });
    }
    setCentralShort(s => {
      const hit = Object.keys(s).filter(id => { const x = byLine.get(id); return !!x && heldPanelSettled(x.rq, x.line); });
      if (hit.length === 0) return s;
      const n = { ...s }; for (const id of hit) delete n[id]; return n;
    });
    const staleSplit = Object.keys(splitIssueQty).filter(id => {
      const x = byLine.get(id);
      return !!x && splitCaptureStale(x.line, Number(splitIssueQty[id]?.qty));
    });
    if (staleSplit.length > 0) {
      setSplitIssueQty(s => { const n = { ...s }; for (const id of staleSplit) delete n[id]; return n; });
      setEditDefer(s => { const n = { ...s }; for (const id of staleSplit) delete n[id]; return n; });
    }
    setReversalShort(s => {
      const hit = Object.keys(s).filter(id => { const rq = byReq.get(s[id].reqId); return !rq || reqSig(rq) !== s[id].sig; });
      if (hit.length === 0) return s;
      const n = { ...s }; for (const id of hit) delete n[id]; return n;
    });
    // A lowered-and-reopened note is about the line AT the figure its sentence
    // names: once the line records anything else, is complete or rejected, the
    // sentence is history (the row says what holds now).
    setPartyShort(s => {
      const hit = Object.keys(s).filter(id => {
        const x = byLine.get(id);
        if (!x) return false;
        const { line } = x;
        if (line.is_rejected || line.store_rejected || lineIssueComplete(line)) return true;
        const rec = s[id].recordedLine;
        return Number.isFinite(rec) && Math.abs((Number(line.quantity_issued) || 0) - rec) > 1e-9;
      });
      if (hit.length === 0) return s;
      const n = { ...s }; for (const id of hit) delete n[id]; return n;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);
  /* REFRESH STARTS THE CENTRAL STORE'S PANELS OVER (round 10). A held panel,
     a refused reversal's panel and a lowered-line note (PartyShortNote) are
     about the answer the store gave AT THE
     TIME; the storekeeper who presses Refresh is asking for the books as they
     are now, and the row's own forecast (rowHold) says that from the reloaded
     balance. The stale "Issue 12.842 kg" on a 2/2 line survived exactly a
     Refresh (round-9 never-stuck, stale-cap). Typed figures, a Defer panel and
     a split the store has not refused are the storekeeper's own input and are
     left alone (their stale cases are settled by the load itself, above). The
     automatic reload after a gesture is NOT a Refresh — a hold announced on a
     200 must survive it — so only the button calls this. */
  const refreshNow = () => {
    setCentralShort({});
    setReversalShort({});
    setPartyShort({});
    setRefreshKey(k => k + 1);
  };
  // "Issue All Items" confirmation — holds the requisition whose bulk-issue is
  // awaiting confirmation (null = no modal). We compute the lines to issue at
  // confirm time from the same req object.
  const [confirmIssueAll, setConfirmIssueAll] = useState<Requisition | null>(null);
  const [issuingAll, setIssuingAll] = useState(false);
  // Feature 3 — line-level selection for "Issue Selected". Selection is scoped
  // per requisition: a map of reqId → Set of selected line ids. We clear a
  // requisition's set after a successful "Issue Selected" for that req.
  const [selectedLines, setSelectedLines] = useState<Record<string, Set<string>>>({});
  const [issuingSelected, setIssuingSelected] = useState<string | null>(null);

  // Toggle a single line's checkbox within a requisition's selection set.
  const toggleLineSelect = (reqId: string, lineId: string) => {
    setSelectedLines(prev => {
      const next = new Set(prev[reqId] || []);
      next.has(lineId) ? next.delete(lineId) : next.add(lineId);
      return { ...prev, [reqId]: next };
    });
  };

  // "Select all open" — set the requisition's selection to exactly its open
  // issuable line ids, or clear it if all are already selected.
  const toggleSelectAll = (req: Requisition) => {
    const openIds = openIssuableLines(req).map(l => l.id);
    setSelectedLines(prev => {
      const cur = prev[req.id] || new Set<string>();
      const allSelected = openIds.length > 0 && openIds.every(id => cur.has(id));
      return { ...prev, [req.id]: allSelected ? new Set<string>() : new Set(openIds) };
    });
  };

  // Issue ONLY the checked lines of a requisition in one /store-issue POST.
  // Each selected line is issued at its remaining (effective − issued) qty, the
  // same amount "Issue All" uses. Skips lines that are no longer issuable (e.g.
  // remaining fell to 0 since selection). Clears this req's selection on success.
  const issueSelected = async (req: Requisition) => {
    const sel = selectedLines[req.id] || new Set<string>();
    const lines = openIssuableLines(req).filter(l => sel.has(l.id));
    if (lines.length === 0) { alert('No selected items to issue.'); return; }
    setIssuingSelected(req.id);
    // Same reason as the single issue: handing over MORE changes what the
    // kitchen holds, so a "it only has 1.2 kg left" panel from an earlier undo
    // is now a lie. Stale figures on a refusal panel are worse than no panel.
    clearBlocked(...lines.map(l => l.id));
    try {
      const resolvedLines = lines.map(l => ({ l, r: resolveIssueQty(l, l.remaining) }));
      const needReason = resolvedLines.filter(x => x.r.over && x.r.note.length < 3);
      if (needReason.length > 0) {
        alert('These lines are being issued OVER what was approved — say why first:\n'
          + needReason.map(x => `• ${x.l.material_name}`).join('\n'));
        return;
      }
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: resolvedLines.map(x => ({ id: x.l.id, action: 'issue', quantity: x.r.qty, note: x.r.note })) },
      });
      const j = await r.json();
      if (!r.ok) {
        showIssueError(j, lines.map(l => ({ id: l.id, material_name: l.material_name })),
                       'Issue selected failed', req.id);
        return;
      }
      // A 200 is not "all of it" any more — see announceHeld.
      const heldIds = announceHeld(j, lines.map(l => ({ id: l.id, material_name: l.material_name })), req.id);
      announcePartyShort(j, req.id);
      consumeIssued(resolvedLines.filter(x => x.r.qty > 0 && !heldIds.has(x.l.id)).map(x => x.l.id));
      setSelectedLines(prev => { const n = { ...prev }; delete n[req.id]; return n; });
      setRefreshKey(k => k + 1);
    } finally { setIssuingSelected(null); }
  };

  const reload = async () => {
    setLoading(true); setError(null);
    try {
      // Use the existing inbox=store filter to grab mgmt-approved + chef-approved + in-progress
      const params = new URLSearchParams({ inbox: 'store' });
      if (deptId) params.set('department_id', deptId);
      const j = await fetchJson(`/api/requisitions?${params}`);
      const reqs: any[] = (j.requisitions || j.list || j.items || j) as any;
      // The list endpoint returns lightweight rows — fetch full detail (with
      // items) in parallel via the ?id= form (the only single-req GET shape).
      const detailed = await Promise.all(
        reqs.map(async (rq: any) => {
          const d = await fetchJson(`/api/requisitions?id=${encodeURIComponent(rq.id)}`);
          return mergeStats(d.requisition || d);
        }),
      );
      // Also pull anything fulfilled today (so the store can review what they
      // did earlier in the day without losing it). We don't pass from/to here
      // because those filter on r.date (when the req was raised), not on
      // fulfilled_at (when items were issued). Filter client-side instead.
      // Limit to recent fulfilled reqs so the list doesn't balloon.
      const todayPrefix = todayIST();
      // Pull every fulfilled req (both purposes). Party reqs live on
      // /party-approvals for the approval workflow, but once Mgmt-approved
      // they're issued from the store here too, so they belong in this log.
      const fulfilled = await fetchJson(`/api/requisitions?status=fulfilled${deptId ? `&department_id=${deptId}` : ''}`);
      const fulfilledRaw: any[] = (fulfilled.requisitions || fulfilled.list || fulfilled.items || fulfilled) as any[];
      const fulfilledToday = (fulfilledRaw || []).filter((rq: any) => {
        // fulfilled_at may be ISO ("2026-05-26T13:45:00") or SQLite ("2026-05-26 13:45:00");
        // both are UTC, so compare on the IST CALENDAR DAY rather than the raw
        // prefix — a 23:10 IST hand-over is stamped 17:40 UTC of the same date,
        // but a 01:00 IST one is stamped on the previous UTC date and a raw
        // prefix match would drop it off the store's own day.
        return fmtISTIsoDate(rq.fulfilled_at || rq.store_processed_at) === todayPrefix;
      });
      const fulfilledDetailed = await Promise.all(
        fulfilledToday.map(async (rq: any) => {
          const d = await fetchJson(`/api/requisitions?id=${encodeURIComponent(rq.id)}`);
          return mergeStats(d.requisition || d);
        }),
      );
      // Dedup
      const seen = new Set<string>();
      const all = [...detailed, ...fulfilledDetailed].filter(r => {
        if (seen.has(r.id)) return false;
        seen.add(r.id); return true;
      });
      dropMovedLines(all);
      setList(all);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [deptId, refreshKey]);

  // Load the issued-log only when its tab is active (or its filters change).
  // Reload when the queue refreshes too, so a fresh issue shows up immediately.
  useEffect(() => {
    if (filter !== 'issued_log') return;
    let cancelled = false;
    setLogLoading(true);
    const qs = new URLSearchParams({ from: logFrom, to: logTo });
    if (deptId) qs.set('department_id', deptId);
    fetchJson(`/api/store-issued-log?${qs}`)
      .then(j => { if (!cancelled) setLog(j); })
      .catch(e => { if (!cancelled) { setLog(null); setError(e.message); } })
      .finally(() => { if (!cancelled) setLogLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [filter, logFrom, logTo, deptId, refreshKey]);

  // One-shot: load department list for the filter dropdown.
  useEffect(() => {
    fetch('/api/departments').then(r => r.json()).then(j => {
      setDepartments(Array.isArray(j) ? j : (j.departments || []));
    }).catch(() => {});
  }, []);

  // The search narrows the whole list first; matchesTab then slices it. Both the
  // body below and the tab badges read this same searched set through the same
  // predicate, so a badge can never promise rows the tab won't render.
  const searched = useMemo(() => {
    if (!search) return list;
    const q = search.toLowerCase();
    return list.filter(r => r.req_number?.toLowerCase().includes(q)
      || r.department_name?.toLowerCase().includes(q)
      || r.event_name?.toLowerCase().includes(q)
      // ...and by what is actually IN the requisition. The store person is
      // asked "who wanted the paneer?", and until now the only way to answer
      // was to expand every open card in turn. Item code = SKU (MAT-00885);
      // brand is matched too, though it is unpopulated on all 928 materials
      // today, so it contributes nothing until someone fills it in.
      || (r.items || []).some(it =>
           it.material_name?.toLowerCase().includes(q)
        || it.material_sku?.toLowerCase().includes(q)
        || (it as any).material_sku_code?.toLowerCase?.().includes(q)
        || (it as any).material_brand?.toLowerCase?.().includes(q)));
  }, [list, search]);

  const filtered = useMemo(
    () => searched.filter(r => matchesTab(r, filter)),
    [searched, filter],
  );
  /** "With Kitchen" — the departments the loaded routed lines name (ruling #45). */
  const routedTabLabel = useMemo(() => {
    const names: string[] = [];
    for (const r of list) for (const n of r.routed_depts || []) if (!names.includes(n)) names.push(n);
    return withDeptLabel(names);
  }, [list]);

  const toggleRow = (id: string) => {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  /* THE one place an issue quantity is decided — used by "Issue Now" AND by
     "Issue All Items" / "Issue Selected". The bulk buttons used to post the
     approved remainder and ignore whatever the store had typed, so a store that
     handed over 10 against an approved 3 still recorded 3 whenever it used the
     big green button. Anything typed for a line now wins on every path.
     Returns the qty in the LINE's stored unit, plus whether it is an over-issue. */
  const resolveIssueQty = (line: ReqLine, outstanding: number) => {
    const U = lineUnits(line);
    const typed = editQty[line.id];
    const typedPU = Number(typed);
    const hasTyped = typed !== undefined && String(typed).trim() !== '' && Number.isFinite(typedPU);
    // Typing exactly what the row displays means "all of it" — post the exact
    // outstanding rather than a 3-dp round trip that leaves a residue.
    const saysOutstanding = hasTyped && Math.abs(typedPU - U.toPU(outstanding)) < 1e-9;
    const qty = !hasTyped || saysOutstanding ? outstanding : U.fromPU(typedPU);
    const over = qty - outstanding > 1e-9;
    // The reason belongs to an OVER-issue. Left unguarded, a reason typed for an
    // abandoned over-issue attached itself to the next within-approval issue.
    return { qty, over, note: over ? (issueNotes[line.id] || '').trim() : '' };
  };

  /* expectIssued (round 10, THE STALE CAP): sent only by a held panel's cap —
     the quantity_issued the store's row was worked out against (its
     `line_issued`). The route refuses the cap with code 'line_changed', and
     writes nothing, when the line has moved since (store-issue/route.ts). An
     ordinary Issue Now sends no such field and is exactly what it was. */
  const issueLine = async (req: Requisition, line: ReqLine, qtyOverride?: number, expectIssued?: number) => {
    // Ruling #68 — a delivered-direct line is never issued from central. Its
    // row offers no issue button; this stops any other path (a stale held
    // panel's cap button) from posting one.
    if (isDeliveredDirect(line)) {
      alert(`${line.material_name} was delivered direct`
        + `${deliveredDirectDept(line) ? ` to ${deliveredDirectDept(line)}` : ' to a department'} on its purchase order, `
        + `so the central store does not issue it. Nothing was issued.`);
      return;
    }
    // Ruling #45 — a routed line is its department's to send; no path here
    // (a stale held panel's cap button) may post an issue for it.
    if (isRoutedLine(line)) {
      const rv = routedLineOf(line);
      alert(`${rv?.sentence || `${line.material_name} is sent by ${routedDeptWord(rv)} by department transfer, not issued from the central store.`} Nothing was issued.`);
      return;
    }
    const outstanding = owedQty(line);
    // The box is in PURCHASE units; /store-issue adds the number to
    // quantity_issued verbatim, which lives in the LINE's own unit → convert
    // once, here. qtyOverride (programmatic) is already in the line's unit.
    //
    // TWO EXACT PATHS, because the displayed purchase figure is rounded to 3 dp
    // and fromPU(toPU(q)) !== q in general (1000 ml of a 750 ml/BTL material
    // shows as 1.333 BTL and converts back to 999.75 ml). Left uncorrected, the
    // 0.25 ml residue keeps quantity_issued under the approved qty forever: the
    // line never reaches "fully issued", the requisition never advances to
    // fulfilled, and for a party req the store→department transfer never fires.
    //   - untouched box            → issue the EXACT outstanding
    //   - typed what the row shows → issue the EXACT outstanding
    // Anything else is a deliberate different number and converts normally (and
    // is NOT clamped — issuing more than outstanding is a real thing a store
    // does, and silently truncating it would hide stock that physically left).
    const resolved = resolveIssueQty(line, outstanding);
    // Enforced HERE rather than by grey-ing the button: a disabled button with
    // no message reads as "the app ignored me", which is exactly how an
    // over-issue looked before this.
    if (qtyOverride == null && resolved.over && resolved.note.length < 3) {
      alert(`You are issuing more than was approved for ${line.material_name}.\n\n`
        + `Type a short reason in the amber box next to the quantity (at least 3 characters) — `
        + `it is recorded on the issue history so the extra stock is accounted for.`);
      return;
    }
    const qty = qtyOverride != null ? qtyOverride : resolved.qty;
    if (!qty || qty <= 0) { alert('Enter a quantity > 0'); return; }
    setBusyLine(line.id);
    // Issuing MORE changes what the kitchen holds, so any earlier "you can only
    // get 1.2 kg back" figure on this line is now wrong. Stale numbers on a
    // refusal panel are worse than no panel.
    clearBlocked(line.id);
    try {
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: [{
          id: line.id, action: 'issue', quantity: qty,
          // Over-issue reason rides on the issue-history entry, so "why did 10
          // leave against an approved 3" is answerable from the log alone.
          note: (issueNotes[line.id] || '').trim(),
          ...(qtyOverride != null && expectIssued != null && Number.isFinite(expectIssued)
            ? { expect_issued: expectIssued } : {}),
        }] },
      });
      const j = await r.json();
      if (!r.ok) {
        // THE STALE CAP, REFUSED (round 10): the line moved after the store
        // answered, so the cap was a figure about a line that no longer exists.
        // The server's sentence verbatim (it names what the line holds now),
        // and the list is re-read so the row reads the line as it now is.
        if (String(j?.code || '') === 'line_changed') {
          alert(String(j?.error || '').trim()
            || `${line.material_name}: this line changed after the store answered, so nothing was issued and the requisition is unchanged.`);
          setRefreshKey(k => k + 1);
          return;
        }
        showIssueError(j, [{ id: line.id, material_name: line.material_name }],
                       'Issue failed', req.id);
        return;
      }
      // One 'issue' entry that the floor holds leaves nothing issuable, and the
      // route answers that 400, so today this line cannot come back held on a
      // 200. Read anyway: the day it does, the typed figure must survive on a
      // line that did not go out, and the storekeeper must be told.
      const heldIds = announceHeld(j, [{ id: line.id, material_name: line.material_name }], req.id);
      if (!heldIds.has(line.id)) {
        setEditQty(s => ({ ...s, [line.id]: '' }));
        setIssueNotes(s => { const n = { ...s }; delete n[line.id]; return n; });
        // A SPLIT CAPTURED BEFORE THIS ISSUE IS STALE NOW (round 8b). "Issue
        // part, defer rest" parks its hand-over figure; when that gesture is
        // refused and the held panel's cap goes out instead, the split panel
        // stayed open still reading "Handing over 15 kg now, the balance 0 kg
        // is promised for" over a line that now held 14.8424 kg (round-8
        // verifier, sd_cap_title_split). The figure it was built on is gone, so
        // the split closes with it; the row's own Defer is there for the rest.
        if (splitIssueQty[line.id]) {
          setSplitIssueQty(s => { const n = { ...s }; delete n[line.id]; return n; });
          setEditDefer(s => { const n = { ...s }; delete n[line.id]; return n; });
        }
      }
      // A defer the server dropped because this issue completed the line.
      announceDeferDropped(j);
      announcePartyShort(j, req.id);
      setRefreshKey(k => k + 1);
    } finally { setBusyLine(null); }
  };

  const deferLine = async (req: Requisition, line: ReqLine) => {
    const cfg = editDefer[line.id];
    if (!cfg?.until) { alert('Pick a date/time you can issue this'); return; }
    setBusyLine(line.id);
    clearBlocked(line.id);
    try {
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: [{ id: line.id, action: 'defer', defer_until: cfg.until, reason: cfg.reason || '' }] },
      });
      const j = await r.json();
      if (!r.ok) { if (!routedRefused(j, 'Defer failed')) alert(j.error || 'Defer failed'); return; }
      // A defer on a line that is already complete is dropped, not written
      // (round 8) — say so rather than let the panel close as if it were kept.
      announceDeferDropped(j);
      announcePartyShort(j, req.id);
      setEditDefer(s => { const n = { ...s }; delete n[line.id]; return n; });
      setRefreshKey(k => k + 1);
    } finally { setBusyLine(null); }
  };

  /* ── "Issue N, defer the rest" ───────────────────────────────────────────
     Step 1 of 2 (this function): capture WHAT is going out now and open the
     defer editor pre-filled. The store types the quantity in the same box it
     always has, in PURCHASE units; it is converted once, here, to the line's
     stored unit and parked in splitIssueQty. Nothing is POSTed yet — a defer is
     a promise about a TIME, and only a human may set it.

     It refuses the whole outstanding on purpose: with nothing left over there is
     no "rest" to defer, and silently degrading to a plain issue would leave a
     promised time hanging on a finished line. */
  const beginIssueAndDeferRest = (line: ReqLine) => {
    const U = lineUnits(line);
    const s = lineSplit(line);
    const typed = editQty[line.id];
    const typedPU = Number(typed);
    const hasTyped = typed !== undefined && String(typed).trim() !== '' && Number.isFinite(typedPU) && typedPU > 0;
    if (!hasTyped) {
      alert(`Type how much ${line.material_name} is going out NOW in the quantity box`
        + `${U.pu ? ` (in ${U.pu})` : ''}, then press this again.\n\n`
        + `The balance is what gets the promised time — so it has to be less than the `
        + `${fmtHandOverPU(U, s.outstanding)}${U.pu ? ` ${U.pu}` : ''} still outstanding.`);
      return;
    }
    const qty = U.fromPU(typedPU);
    if (qty >= s.outstanding - 1e-9) {
      alert(`${fmtNum(typedPU)}${U.pu ? ` ${U.pu}` : ''} is the whole outstanding quantity — `
        + `there is no balance left to defer.\n\nUse "Issue Now" for that.`);
      return;
    }
    setSplitIssueQty(p => ({ ...p, [line.id]: { qty, token: gestureToken() } }));
    setEditDefer(p => ({ ...p, [line.id]: { until: defaultDefer(), reason: '' } }));
  };

  /* Step 2 of 2: ONE POST, ONE transaction — hand part of the line over and put
     the promised time on the balance. Before this the store had to issue, watch
     the row drop out of the open list, hunt it down and defer it separately.

     ORDER IS LOAD-BEARING. /store-issue walks `lines` in array order, and its
     'issue' branch clears the deferred fields — historically always (its
     `updIssue` statement), and now only when the line ends up fully satisfied
     (`updIssuePartial`, see "THE DEFER RULE (half-transfer)" in that route's
     header). A defer written FIRST would be wiped by the issue that follows it.
     Issue-then-defer lands in the same final state under BOTH readings, which is
     why this ordering is not conditional on that change. Nothing here duplicates
     it: the client never decides whether a defer survives, it just orders the
     two actions so it never has to ask. The route re-reads each line inside its
     own transaction, so the second entry for this same line id sees the first. */
  const issueAndDeferRest = async (req: Requisition, line: ReqLine) => {
    const gesture = splitIssueQty[line.id];
    const qty = gesture?.qty as number;
    const cfg = editDefer[line.id];
    const U = lineUnits(line);
    const s = lineSplit(line);
    if (!Number.isFinite(qty) || !(qty > 0)) { alert('Nothing captured to issue — start again.'); return; }
    if (qty >= s.outstanding - 1e-9) {
      alert('The outstanding quantity changed — there is no balance left to defer. Refresh and try again.');
      return;
    }
    if (!cfg?.until) { alert('Pick the date/time you can issue the balance'); return; }
    // The balance the promise is FOR is what the take leaves owing (round 8):
    // when the shelf rule takes a balance that is not the typed figure, the
    // line records what left the shelf and the rest is approved − that. On
    // every other gesture the take IS the typed figure and this is the
    // subtraction it always was.
    const take = forecastDeskTake({ line, purpose: req.purpose, approved: effectiveQty(line), deltaLine: qty });
    // fmtHandOverPU (final pass): a 0.6 g balance was saved as "Balance 0.001 kg
    // to follow". At 0.001 or more it is fmtNum(U.toPU(…)), byte for byte.
    const restPU = fmtHandOverPU(U, take && take.changed ? take.owingLine : s.outstanding - qty);
    setBusyLine(line.id);
    clearBlocked(line.id);
    try {
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { client_token: gesture.token, lines: [
          { id: line.id, action: 'issue', quantity: qty, note: (issueNotes[line.id] || '').trim() },
          { id: line.id, action: 'defer', defer_until: cfg.until,
            // A defer with no words on it reads as "forgotten" three hours later.
            // Say what the promise is FOR when the store didn't.
            reason: (cfg.reason || '').trim()
              || `Balance ${restPU}${U.pu ? ` ${U.pu}` : ''} to follow` },
        ] },
      });
      const j = await r.json();
      if (!r.ok) {
        const refused = showIssueError(j, [{ id: line.id, material_name: line.material_name }],
                                       'Issue + defer failed', req.id);
        /* THE REFUSED SPLIT CLOSES (round 10). The central floor refused this
           exact gesture, and the editor has no quantity box — its "Issue &
           defer balance" could only post the same figures again and be refused
           the same way, while it went on reading "Handing over 15 kg now, the
           balance 5 kg is promised for" under the server's "Nothing was
           issued" (round-9 store-desk verifier, c19_split_after_400). The typed
           figure stays in the box, the server's panel carries the cap, and the
           row's own warning speaks for anything typed next. Any other failure
           (a dropped packet, a status change) keeps the capture and its token,
           so the same gesture can be replayed. */
        if (refused) {
          setSplitIssueQty(sm => { const n = { ...sm }; delete n[line.id]; return n; });
          setEditDefer(sm => { const n = { ...sm }; delete n[line.id]; return n; });
        }
        return;
      }
      // Same as issueLine: a held issue entry beside a defer leaves nothing
      // issuable, which the route refuses 400, so this is defensive today. If
      // it ever is held on a 200, the captured gesture (quantity, promised
      // time, token) is kept so the storekeeper can correct one figure and replay.
      const heldIds = announceHeld(j, [{ id: line.id, material_name: line.material_name }], req.id);
      // The issue may have COMPLETED the line — it took everything the central
      // store held and less than one printed step is still owed — and then the
      // server drops the defer instead of writing it onto a finished line
      // (round 8; round 7 wrote it and the requisition sat with nothing to
      // press). Its own sentence, verbatim, so the storekeeper who asked for a
      // promise reads why none was made.
      announceDeferDropped(j);
      announcePartyShort(j, req.id);
      if (!heldIds.has(line.id)) {
        setEditQty(sm => ({ ...sm, [line.id]: '' }));
        setIssueNotes(sm => { const n = { ...sm }; delete n[line.id]; return n; });
        setEditDefer(sm => { const n = { ...sm }; delete n[line.id]; return n; });
        setSplitIssueQty(sm => { const n = { ...sm }; delete n[line.id]; return n; });
      }
      setRefreshKey(k => k + 1);
    } finally { setBusyLine(null); }
  };

  /* ── Reversal pre-check ────────────────────────────────────────────────────
     A courtesy, and IT FAILS OPEN ON PURPOSE. It exists so the storekeeper sees
     "the kitchen only has 1.2 kg left" on the line before a round-trip, not so
     the client gets to decide. The endpoint may legitimately not answer — an
     older server, a route not deployed yet, an HTML login redirect, a dropped
     LAN packet — and none of those may stop someone undoing a line.

     NEVER promote this to the gate. Between this call and the POST a KOT can
     complete and eat the balance, so the SERVER THROW is the correctness gate
     and the POST's own error is parsed by the very same reader below. If you
     find yourself adding a "precheck said it was fine" short-circuit around
     that error handling, stop. */
  const precheckReversal = async (
    reqId: string,
    batch: { id: string; material_name: string }[],
    action: 'undo' | 'reject',
  ): Promise<Record<string, BlockedReversal>> => {
    if (!precheckAvailable.current) return {};
    try {
      const r = await api(`/api/requisitions/${reqId}/reversal-precheck`, {
        method: 'POST',
        body: { lines: batch.map(l => ({ id: l.id, action })) },
      });
      // 404/405 = the route is not on this server. Stop asking: at the time of
      // writing it genuinely does not exist (the reversal gate lives in the
      // store-issue POST), and probing it on every single undo buys the
      // storekeeper nothing but a wasted round-trip on a slow venue LAN. Any
      // OTHER failure — 500, a login redirect, a dropped packet — is treated as
      // transient and retried next time, because those do come back.
      if (r.status === 404 || r.status === 405) { precheckAvailable.current = false; return {}; }
      if (!r.ok) return {};
      if (!(r.headers.get('content-type') || '').includes('application/json')) return {};
      return readBlockedReversals(await r.json(), batch);
    } catch { return {}; }
  };

  /* Shared tail for both reversal actions: turn a non-ok response into either an
     inline per-line refusal or the alert this page has always shown. ONLY the
     typed refusal goes inline — a requisition-level failure (wrong status,
     signed out, CSRF) has nothing to do with any one line, and burying it in a
     red box under a single row is how it gets missed. Returns true when it was
     handled as a refusal. */
  const showReversalError = (
    j: any, batch: { id: string; material_name: string }[], fallback: string,
    ctx?: { req: Requisition; line: ReqLine; action: 'undo' | 'reject' },
  ): boolean => {
    /* THE CENTRAL FLOOR'S REFUSAL FIRST, AS ITSELF (round 10) — never through
       the department-reversal reader (which now skips its rows): its figures
       are purchase units. Kept on the pressed line, keyed by it, with the
       requisition's sig so a later load that changes it drops the panel. */
    if (routedRefused(j, fallback)) return true;
    const central = ctx ? readCentralShort(j, batch) : {};
    if (ctx && Object.keys(central).length > 0) {
      const { req, line, action } = ctx;
      // The store's other lines (ruling #45: a routed line never holds the
      // party transfer back — it runs once the store's own lines are done).
      const others = (req.items || []).filter(o => o.id !== line.id && !isRoutedLine(o));
      const completes = action === 'reject' && req.purpose === 'party'
        && others.every(o => !!(o.is_rejected || o.store_rejected) || lineIssueComplete(o));
      const entry: ReversalShort = {
        action, reqId: req.id, sig: reqSig(req), completes,
        rows: Object.entries(central).map(([lineId, short]) => ({ lineId, short })),
      };
      setReversalShort(s => ({ ...s, [line.id]: entry }));
      setExpanded(p => (p.has(req.id) ? p : new Set(p).add(req.id)));
      return true;
    }
    const blocked = readBlockedReversals(j, batch);
    if (Object.keys(blocked).length > 0) {
      setBlockedReversals(s => ({ ...s, ...blocked }));
      return true;
    }
    alert(j?.error || fallback);
    return false;
  };

  const undoLine = async (req: Requisition, line: ReqLine) => {
    /* A PARTY UNDO MOVES NO STOCK (final pass, words only). On a party
       requisition the route zeroes quantity_issued and applyIssueDelta leaves
       the party rail's stock alone, so nothing comes back to the store, and
       whatever the party transfer already moved stays with the department (a
       later transfer moves only what the line records above it). The internal
       prompt is unchanged. */
    const ask = req.purpose === 'party'
      ? (() => {
          const U = lineUnits(line);
          const q = (v: number) => fmtPromptQty(U, v);
          const issuedNow = Number(line.quantity_issued) || 0;
          const pm = partyMovedOf(req, line);
          const moved = pm ? pm.movedLine + (pm.first ? pm.excessLine : 0) : null;
          return `Undo all actions on "${line.material_name}"?\n\n`
            + `• On a party requisition an undo moves no stock. It clears this line's record`
            + (issuedNow > 0 ? ` of ${q(issuedNow)} — it will read 0 issued` : '')
            + (line.deferred_until ? `${issuedNow > 0 ? ',' : ''} and its promised time` : '')
            + `.\n`
            + (moved == null
              ? `• Whatever the party transfer already moved for it stays with the department.\n`
              : moved > 1e-9
                ? `• ${q(moved)} of it already left the store in the party transfer. Those goods stay with the `
                  + `department, and a later transfer moves only what this line records above ${q(moved)}.\n`
                : issuedNow > 0 ? `• Nothing has left the store for it yet, so nothing comes back either.\n` : '');
        })()
      : `Undo all actions on ${line.material_name}?`;
    if (!confirm(ask)) return;
    const batch = [{ id: line.id, material_name: line.material_name }];
    setBusyLine(line.id);
    // Drop last attempt's refusal FIRST — a stale red panel sitting next to a
    // line that has just been undone successfully reads as "it failed again".
    clearBlocked(line.id);
    try {
      const pre = await precheckReversal(req.id, batch, 'undo');
      if (Object.keys(pre).length > 0) { setBlockedReversals(s => ({ ...s, ...pre })); return; }
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: [{ id: line.id, action: 'undo' }] },
      });
      const j = await r.json();
      if (!r.ok) { showReversalError(j, batch, 'Undo failed', { req, line, action: 'undo' }); return; }
      announcePartyShort(j, req.id);
      setRefreshKey(k => k + 1);
    } finally { setBusyLine(null); }
  };

  // Store-side rejection — the store cannot fulfil this line at all (discontinued,
  // wrong item, etc.). Distinct from the chef's rejection. Prompts for a reason,
  // then marks the line store_rejected via the store-issue endpoint.
  const rejectLine = async (req: Requisition, line: ReqLine) => {
    /* SAY WHAT THE REJECT IS ABOUT TO DO, because it now does two different
       things depending on the line. It cancels the OUTSTANDING balance; it does
       NOT un-hand-over what the storekeeper has already physically carried to
       the kitchen (Option A). On a line that issued nothing that is the same
       sentence it always was, so that prompt is left word-for-word. On a
       part-issued line the old prompt said nothing about the 200 eggs that are
       staying issued, which is exactly the half the storekeeper needs to agree
       to. Quantities in the PURCHASE unit, like every other figure on the row. */
    const U = lineUnits(line);
    const s = lineSplit(line);
    const q = (v: number) => fmtPromptQty(U, v);
    /* What the party transfer this reject runs will meet (desk-rule.ts, the
       route's allDone branch: the rejected line carries nothing by then) —
       '' when nothing is to be said. Asked by the party prompt and by the
       routed one (ruling #45: the transfer runs once the store's own lines
       are done, whichever line the gesture is on). */
    const partyTransferNote = (): string => {
      const rf = forecastDeskPartyTransfer({
        lines: storeLinesOf(req),
        approvedOf: l => effectiveQty(l as ReqLine),
        rejectedOf: l => !!((l as ReqLine).is_rejected || (l as ReqLine).store_rejected) || l.id === line.id,
        after: new Map([[line.id, 0]]),
        transferred: !!Number(req.party_transferred || 0),
      });
      const leftOpen = rf.runs === 'certain'
        ? (req.items || []).flatMap(l => {
            const tk = rf.takes[l.id];
            return tk && tk.shortTake && !tk.complete ? [{ line: l, tk }] : [];
          })
        : [];
      const shortNames = rf.runs === 'certain'
        ? rf.short.map(x => (req.items || []).find(l => l.id === x.id)?.material_name).filter(Boolean) : [];
      // With a routed line still owed (ruling #45) the transfer runs once the
      // STORE's lines are done, so "no other line" would be untrue.
      const noOther = (req.items || []).some(l => l.id !== line.id && isRoutedLine(l)
        && !l.is_rejected && !l.store_rejected && !lineIssueComplete(l))
        ? "none of the store's other lines" : 'no other line';
      return shortNames.length > 0
        ? `• Rejecting it leaves ${noOther} open, so the party transfer runs — and the store's books cannot cover `
          + `${shortNames.join(', ')}, so the store will refuse this reject and change nothing.\n`
        : leftOpen.length > 0
          ? `• Rejecting it leaves ${noOther} open, so the party transfer runs — and the store's books cannot cover every `
            + `line: ${leftOpen.map(partyLeftOpenWords).join('; ')}.\n`
          : '';
    };
    /* A PARTY REJECT ZEROES THE LINE (final pass, words only — the route's
       party carve-out, a pre-existing owner decision): quantity_issued goes to
       0 and the whole approved quantity reads cancelled, while whatever the
       party transfer already moved stays with the department. "… has already
       been handed over — that STAYS issued" was printed over exactly that
       (ta_block_exit: MANGO 0/20 rejected with 15 kg moved; da_reject: 0/14.843
       with nothing moved). And a reject that leaves no other line open runs the
       transfer (store-issue/route.ts), so what that transfer will meet is said
       too, when it is not simply the requisition going out. The internal
       prompt is unchanged. */
    const partyAsk = (() => {
      if (req.purpose !== 'party') return null;
      // A routed line (ruling #45) keeps what was sent — its own prompt below.
      if (isRoutedLine(line)) return null;
      const pm = partyMovedOf(req, line);
      const moved = pm ? pm.movedLine + (pm.first ? pm.excessLine : 0) : null;
      const goods = moved == null
        ? `• Whatever the party transfer already moved for it stays with the department — the rejection does not take it back.\n`
        : moved > 1e-9
          ? `• ${q(moved)} of it already left the store in the party transfer. Those goods stay with the department — `
            + `the rejection does not take them back.\n`
            + (s.issued - moved > 1e-9 ? `• The other ${q(s.issued - moved)} recorded has not left the store, and now will not.\n` : '')
          : s.issued > 0
            ? `• Nothing has left the store for it yet (a party requisition's goods leave in one transfer), so the `
              + `department gets none of the ${q(s.issued)} recorded.\n`
            : '';
      const transfer = partyTransferNote();
      return `Reject "${line.material_name}"?\n\n`
        + `• On a party requisition a store rejection clears the line's record: the line then reads 0 issued, and the `
        + `whole ${q(s.effective)} approved reads cancelled — the store will not issue any more of it.\n`
        + goods + transfer
        + `\nGive a reason:`;
    })();
    /* A DELIVERED-DIRECT LINE (ruling #68) is closed here, not issued: the
       vendor already delivered it straight to a department on its merged PO.
       "The department will not get it" would be false there, so it gets its own
       words (internal lines; a party line keeps the party prompt above, which
       also says what the transfer will do). */
    const directAsk = partyAsk == null && isDeliveredDirect(line)
      ? `Close "${line.material_name}" without issuing?\n\n`
        + `• It was delivered direct${deliveredDirectDept(line) ? ` to ${deliveredDirectDept(line)}` : ' to a department'}`
        + `${line.on_po?.po_number ? ` on ${line.on_po.po_number}` : ''}, so the central store does not issue it.\n`
        + (s.issued > 0 ? `• ${q(s.issued)} handed over earlier from the store STAYS issued.\n` : '')
        + `• The remaining ${q(s.outstanding)} on this line is cancelled here — nothing moves from the store.\n\n`
        + `Give a reason:`
      : null;
    /* A ROUTED LINE (ruling #45) — its department sends it by department
       transfer, so a rejection only closes what is still to send. What was
       sent STAYS (the route keeps it, party lines too, and a party line stays
       costed on the party's P&L by it), and nothing moves for this line. */
    const routedAsk = (() => {
      if (!isRoutedLine(line)) return null;
      const rv = routedLineOf(line);
      const D = routedDeptWord(rv);
      const to = req.department_name || 'the department';
      return `Reject the rest of "${line.material_name}"?\n\n`
        + `• ${D} sends this line by department transfer — a Direct Issue rule routes the item to ${D}, so the central store never holds it.\n`
        + (s.issued > 0 ? `• ${q(s.issued)} ${D} already sent STAYS with ${to}`
          + (req.purpose === 'party' ? `, and stays costed on this party's P&L.\n` : `.\n`) : '')
        + `• The remaining ${q(s.outstanding)} is cancelled — ${D} will not be asked to send it, and nothing moves for this line.\n`
        + (req.purpose === 'party' ? partyTransferNote() : '')
        + `\nGive a reason:`;
    })();
    const ask = routedAsk != null ? routedAsk : partyAsk != null ? partyAsk : directAsk != null ? directAsk : s.issued > 0
      ? `Reject the balance of "${line.material_name}"?\n\n`
        + `• ${q(s.issued)} of ${q(s.effective)} has already been handed over — that STAYS issued, `
        + `and the goods stay with the department.\n`
        + `• The remaining ${q(s.outstanding)} is cancelled — the department will not get it.\n\n`
        + `Give a reason:`
      : `Reject "${line.material_name}"? Give a reason (the store cannot fulfil this line):`;
    // A delivered-direct close is pre-worded with what actually happened —
    // where the goods went, on which PO and bill — so the record every reader
    // prints (this row, the issue log) says it, not a bare "Delivered direct".
    // Editable like any reason; only a delivered-direct line is pre-filled.
    const directFacts = isDeliveredDirect(line)
      ? `Delivered direct${deliveredDirectDept(line) ? ` to ${deliveredDirectDept(line)}` : ''}`
        + `${line.on_po?.po_number ? ` on ${line.on_po.po_number}` : ''}`
        + `${line.delivered_direct_grn ? ` (${line.delivered_direct_grn})` : ''} — not issued from central`
      : '';
    const reason = prompt(ask, directFacts);
    if (reason === null) return;                       // cancelled
    const batch = [{ id: line.id, material_name: line.material_name }];
    setBusyLine(line.id);
    clearBlocked(line.id);
    try {
      // THE PRE-CHECK STAYS, and it stays on the 'reject' action. A reject no
      // longer zeroes quantity_issued, so on a part-issued line it moves no
      // stock and the server has nothing to refuse — the pre-check simply comes
      // back empty and costs one round-trip. It is still asked because the
      // server, not this page, owns which rejects are reversals: a PARTY line
      // is still zeroed by the route's carve-out, and that IS a reversal the
      // department can refuse. Deciding here would mean re-implementing that
      // carve-out client-side, which is how the two drift apart.
      const pre = await precheckReversal(req.id, batch, 'reject');
      if (Object.keys(pre).length > 0) { setBlockedReversals(s => ({ ...s, ...pre })); return; }
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: [{ id: line.id, action: 'reject', reason: reason.trim() }] },
      });
      const j = await r.json();
      if (!r.ok) { showReversalError(j, batch, 'Reject failed', { req, line, action: 'reject' }); return; }
      announcePartyShort(j, req.id);
      setRefreshKey(k => k + 1);
    } finally { setBusyLine(null); }
  };

  const unrejectLine = async (req: Requisition, line: ReqLine) => {
    /* ASK FIRST, because this click stopped being cosmetic. Since 'unreject' was
       admitted on a finished requisition (store-issue/route.ts, 2026-08-26) it
       can put an item back below its approved quantity, which sends the whole
       requisition from 'Fulfilled' back to the store queue and CLEARS
       fulfilled_at / fulfilled_by — the stamp is not recoverable, a later
       re-fulfilment writes a new one. Its two neighbours already ask (undoLine
       confirms, rejectLine prompts for a reason); this was the only reversal on
       the row that fired straight at the API. Named quantities, so the
       storekeeper is agreeing to something concrete. */
    const U = lineUnits(line);
    const s = lineSplit(line);
    const q = (v: number) => fmtPromptQty(U, v);
    // THE RULE, not a bare `issued < effective`: a line a take closed by
    // emptying the shelf stays complete when its rejection is cleared, and the
    // server's re-score will not reopen the requisition over it.
    const reopens = req.status === 'fulfilled' && !lineIssueComplete(line);
    // The cancelled clause is dropped when the reject cancelled nothing (the
    // line had already been issued in full), where "0 BTL goes back to
    // outstanding" is noise rather than information.
    // A routed line (ruling #45) goes back to its department's To send list —
    // it never becomes the store's to issue.
    const rD = isRoutedLine(line) ? routedDeptWord(routedLineOf(line)) : '';
    const ask = `Clear the store rejection on "${line.material_name}"?\n\n`
      + (rD ? `• The line goes back on ${rD}'s To send list — ${rD} sends it, not the store`
            : `• The line becomes issuable again`)
      + (s.issued > 0
          ? ` — ${q(s.issued)} already handed over stays issued`
            + (s.cancelled > 0 ? `, ${q(s.cancelled)} goes back to outstanding.\n` : `.\n`)
          : `.\n`)
      + (reopens
          ? (rD ? `• This requisition re-opens and loses its "fulfilled" timestamp.\n`
                : `• This requisition will go back to the store queue and lose its "fulfilled" timestamp.\n`)
          : '');
    if (!confirm(ask)) return;
    setBusyLine(line.id);
    try {
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: [{ id: line.id, action: 'unreject' }] },
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Un-reject failed'); return; }
      announcePartyShort(j, req.id);
      setRefreshKey(k => k + 1);
    } finally { setBusyLine(null); }
  };

  // Issue EVERY still-open line of a requisition in ONE POST. "Open" here means:
  // not rejected, not deferred, and with remaining > 0 (remaining = effective
  // qty − already-issued). Deferred lines are intentionally skipped — the store
  // committed to a later time for those. Reuses the same /store-issue endpoint
  // as issueLine, which already supports multiple lines per call.
  const issueAllOpen = async (req: Requisition) => {
    const lines = openIssuableLines(req);
    if (lines.length === 0) { alert('No open items to issue.'); return; }
    setIssuingAll(true);
    clearBlocked(...lines.map(l => l.id));           // see issueSelected
    try {
      const resolvedLines = lines.map(l => ({ l, r: resolveIssueQty(l, l.remaining) }));
      const needReason = resolvedLines.filter(x => x.r.over && x.r.note.length < 3);
      if (needReason.length > 0) {
        alert('These lines are being issued OVER what was approved — say why first:\n'
          + needReason.map(x => `• ${x.l.material_name}`).join('\n'));
        return;
      }
      const r = await api(`/api/requisitions/${req.id}/store-issue`, {
        method: 'POST',
        body: { lines: resolvedLines.map(x => ({ id: x.l.id, action: 'issue', quantity: x.r.qty, note: x.r.note })) },
      });
      const j = await r.json();
      if (!r.ok) {
        showIssueError(j, lines.map(l => ({ id: l.id, material_name: l.material_name })),
                       'Issue all failed', req.id);
        // Close the confirmation so the panels underneath are reachable — the
        // modal sits over the very lines the refusal is about.
        setConfirmIssueAll(null);
        return;
      }
      setConfirmIssueAll(null);
      // "Issue All" is the gesture most likely to carry a short line: it posts
      // every open line at once. See announceHeld.
      const heldIds = announceHeld(j, lines.map(l => ({ id: l.id, material_name: l.material_name })), req.id);
      announcePartyShort(j, req.id);
      consumeIssued(resolvedLines.filter(x => x.r.qty > 0 && !heldIds.has(x.l.id)).map(x => x.l.id));
      setRefreshKey(k => k + 1);
    } finally { setIssuingAll(false); }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <Package className="w-6 h-6 text-[#af4408]" /> Store Requisitions
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Every requisition currently waiting on the store team to hand over goods —
            <b> internal kitchen</b> reqs (after Chef approval) and <b>party</b> reqs (after Chef + Mgmt approval).
            Issue full or partial, or defer with a promised time. Every action is time-stamped and traceable per item.
            {list.some(r => (r.lines_routed_owing || 0) + (r.lines_routed_done || 0) > 0) && (
              <> A line marked <b>ROUTED</b> is for an item a Direct Issue rule sends straight to another department (it
                never reaches the central store): that department sends it by department transfer, so it is not issued here.</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* MERGE INTO ONE PO (rulings #63-#70) — every department's owed lines
              into ONE draft PO, many vendors, a GRN per vendor bill under the
              same number. Store manager + admin only (#65). It buys; it never
              issues — the issue flow below is untouched (#64). */}
          {canMerge && (
            <button onClick={() => setMergeOpen({ preselect: [] })}
                    title="Put owed requisition lines from every department on ONE draft purchase order — one vendor per item, many vendors on one PO"
                    className="px-3 py-2 bg-[#af4408] hover:bg-[#8f3706] text-white rounded-lg text-sm flex items-center gap-2">
              <Merge className="w-4 h-4" /> Merge into one PO
            </button>
          )}
          <button onClick={refreshNow}
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {/* Status tabs */}
      <TabScroller className="gap-2 text-xs">
        {([
          { k: 'open',             label: 'Pending Issue',    icon: AlertCircle, tone: 'amber' },
          { k: 'deferred',         label: 'Deferred',         icon: Clock,       tone: 'blue' },
          // Balance Pending covers BOTH shapes of "we still owe them something":
          // a single line handed over in pieces (asked 4, gave 2), and whole
          // lines issued complete while others were never touched.
          //
          // There used to be a separate Part-Issued tab for the first shape.
          // It was removed on the owner's call: it was a strict SUBSET of this
          // one — a split line always leaves an outstanding quantity — so the
          // two counts moved together and nobody could tell them apart. The
          // split itself is not lost; it is named on the row by partialSummary
          // ("1 of 2 kg issued — 1 kg deferred"), which is where a storekeeper
          // actually reads it.
          { k: 'balance_pending',  label: 'Balance Pending',  icon: Hourglass,   tone: 'rose' },
          // "With Kitchen" (ruling #45): lines a Direct Issue rule routes to
          // another department, which sends them by department transfer. Shown
          // only while there are any (or it is the tab in view), named after
          // the departments the feed names.
          { k: 'routed',           label: routedTabLabel,     icon: Send,        tone: 'indigo' },
          { k: 'issued_today',     label: 'Issued Today',     icon: CheckCircle2,tone: 'emerald' },
          { k: 'issued_log',       label: 'Issued Items Log', icon: History,     tone: 'amber' },
        ] as const).filter(t => t.k !== 'routed' || filter === 'routed'
          || searched.some(r => matchesTab(r, 'routed'))).map(t => {
          // ONE source for the badge — the same predicate the body filters with.
          // These used to be re-written inline here, so changing a tab's meaning
          // in one place left the badge promising rows the tab wouldn't render.
          // (The Issued Items Log isn't a requisition view; it counts its own events.)
          const n = t.k === 'issued_log'
            ? (log?.totals?.events || 0)
            : searched.filter(r => matchesTab(r, t.k)).length;
          const active = filter === t.k;
          const Icon = t.icon;
          const onStyle: Record<string, string> = {
            amber: active ? 'bg-amber-600 text-white border-amber-600' : 'bg-amber-50 text-amber-800 border-amber-200',
            blue:  active ? 'bg-blue-600  text-white border-blue-600'  : 'bg-blue-50  text-blue-800  border-blue-200',
            emerald: active ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-emerald-50 text-emerald-800 border-emerald-200',
            rose: active ? 'bg-rose-600 text-white border-rose-600' : 'bg-rose-50 text-rose-800 border-rose-200',
            violet: active ? 'bg-violet-600 text-white border-violet-600' : 'bg-violet-50 text-violet-800 border-violet-200',
            indigo: active ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-indigo-50 text-indigo-800 border-indigo-200',
          };
          return (
            <button key={t.k} onClick={() => setFilter(t.k)}
                    className={`px-3 py-1.5 rounded border flex items-center gap-1.5 ${onStyle[t.tone]}`}>
              <Icon className="w-3.5 h-3.5" /> {t.label} <span className="font-mono">{n}</span>
            </button>
          );
        })}
      </TabScroller>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 bg-white border border-[#E8D5C4] rounded-xl p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-2 top-2 text-[#8B7355]" />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Search req# / department / event / item name / SKU…"
                 className="w-full pl-8 pr-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </div>
        <select value={deptId} onChange={e => setDeptId(e.target.value)}
                className="px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] min-w-[160px]">
          <option value="">All departments</option>
          {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}

      {/* Tab body — Issued Log gets its own panel, the other four share the requisition list. */}
      {filter === 'issued_log' ? (
        <IssuedLogPanel
          loading={logLoading} log={log}
          from={logFrom} to={logTo}
          onFromChange={setLogFrom} onToChange={setLogTo}
        />
      ) : loading ? (
        <div className="p-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-10 bg-white border border-[#E8D5C4] rounded-xl text-center text-sm text-[#8B7355]">
          <CheckCircle2 className="w-7 h-7 mx-auto mb-2 text-emerald-500" />
          Nothing here. {filter === 'open' && 'Caught up — no pending requisitions.'}
          {filter === 'deferred' && 'No items promised for a later time.'}
          {filter === 'balance_pending' && 'No balances owed — every issued requisition went out in full.'}
          {filter === 'issued_today' && 'Nothing has been handed over today yet.'}
          {filter === 'routed' && 'No requisition line is waiting on another department to send it.'}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(req => (
            <ReqCard key={req.id}
                     req={req}
                     expanded={expanded.has(req.id)}
                     onToggle={() => toggleRow(req.id)}
                     showIssueAll={filter === 'open'}
                     onIssueAll={() => setConfirmIssueAll(req)}
                     selectable={filter === 'open'}
                     selectedIds={selectedLines[req.id] || EMPTY_SET}
                     onToggleLineSelect={(lineId) => toggleLineSelect(req.id, lineId)}
                     onToggleSelectAll={() => toggleSelectAll(req)}
                     onIssueSelected={() => issueSelected(req)}
                     issuingSelected={issuingSelected === req.id}
                     busyLine={busyLine}
                     resolveQty={(line, remaining) => resolveIssueQty(line, remaining)}
                     editQty={editQty}
                     issueNotes={issueNotes} setIssueNotes={setIssueNotes}
                     setEditQty={setEditQty}
                     editDefer={editDefer}
                     setEditDefer={setEditDefer}
                     splitIssueQty={splitIssueQty}
                     setSplitIssueQty={setSplitIssueQty}
                     onBeginIssueDeferRest={(line) => beginIssueAndDeferRest(line)}
                     onIssueDeferRest={(line) => issueAndDeferRest(req, line)}
                     onIssue={(line, qty, expect) => issueLine(req, line, qty, expect)}
                     onDefer={(line) => deferLine(req, line)}
                     blockedReversals={blockedReversals}
                     centralShort={centralShort}
                     reversalShort={reversalShort}
                     partyShort={partyShort}
                     onUndo={(line) => undoLine(req, line)}
                     onReject={(line) => rejectLine(req, line)}
                     onUnreject={(line) => unrejectLine(req, line)}
                     onShowHistory={(line) => setShowHistoryFor(line.id)}
                     canMerge={canMerge}
                     onAddToMergedPo={(line) => setMergeOpen({ preselect: [line.id] })} />
          ))}
        </div>
      )}

      {/* History drawer */}
      {showHistoryFor && (() => {
        const found = list.flatMap(r => r.items).find(i => i.id === showHistoryFor);
        if (!found) return null;
        return <HistoryDrawer line={found} onClose={() => setShowHistoryFor(null)} />;
      })()}

      {/* Issue-All confirmation modal */}
      {confirmIssueAll && (
        <IssueAllModal
          req={confirmIssueAll}
          resolveQty={(line, remaining) => resolveIssueQty(line, remaining)}
          busy={issuingAll}
          onCancel={() => { if (!issuingAll) setConfirmIssueAll(null); }}
          onConfirm={() => issueAllOpen(confirmIssueAll)}
        />
      )}

      {/* Merge into one PO — the shared modal. A created draft refreshes the
          queue so each line picks up its "On PO-…" badge. */}
      {mergeOpen && (
        <MergePoModal
          preselectReqItemIds={mergeOpen.preselect}
          onClose={() => setMergeOpen(null)}
          onCreated={() => setRefreshKey(k => k + 1)}
        />
      )}
    </div>
  );
}

/**
 * Confirmation modal for "Issue All Items". Lists every open line that will be
 * issued (material × remaining qty) to the requisition's department, with
 * Confirm / Cancel. Nothing is POSTed until the user confirms.
 */
function IssueAllModal({ req, resolveQty, busy, onCancel, onConfirm }: {
  req: Requisition;
  /** The SAME resolver the POST uses — the list must show what will be issued,
      not the approved remainder, or the confirmation lies about an over-issue. */
  resolveQty: (line: ReqLine, remaining: number) => { qty: number; over: boolean; note: string };
  busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const lines = openIssuableLines(req);
  /* WHAT THE SERVER WILL HOLD, forecast on the very batch Confirm posts (same
     lines, same order, same resolver — see forecastCentralHolds). The list
     below used to put every open line under "these items are being issued",
     including one the server then held: the confirmation said the opposite of
     what happened. A held line now leaves that list and is named under its own
     heading, in the words the server's alert will use after the click. Nothing
     held ⇒ the original markup, untouched. */
  const forecast = forecastCentralHolds(req, lines.map(l => ({ line: l, qty: resolveQty(l, l.remaining).qty })));
  const heldIds = new Set(forecast.held.map(l => l.id));
  const item = (l: ReqLine & { remaining: number }) => {
    const U = lineUnits(l);
    const u = U.pu;
    const rq = resolveQty(l, l.remaining);
    /* THE TAKE, WHEN IT IS NOT THE FIGURE POSTED (round 8). The shelf rule takes
       the whole balance when the figure IS its shown figure (THREE MANGO 14.843
       kg over 14,842.5 g; WHITE DAL 3.151 kg over 3.1505), so the line records
       what left the shelf and THE RULE closes it when less than one printed step
       is owed. "× 14.843 kg = 14,843 g" was a claim about 0.5 g that never
       left. The figure printed is the take (as In store prints it) and the line
       says what it leaves. Only where the take differs — every ordinary line
       is the markup below, byte for byte. */
    const tk = forecast.takes[l.id];
    /* A PARTY LINE ISSUED BEFORE (round 8b): this gesture adds the typed figure,
       and the transfer it completes then moves the line's WHOLE quantity — THREE
       MANGO 14.842 kg issued earlier, 0.001 typed, 14,842.5 g left the shelf and
       the line closed, while this list read "× 0.001 kg = 1 g". Both figures
       are printed: what this gesture adds, and what the transfer moves. */
    if (tk && tk.rail === 'party' && (Number(l.quantity_issued) || 0) > 0) {
      return (
        <li key={l.id} className="flex items-center justify-between text-sm border-b border-[#E8D5C4]/50 py-1.5">
          <span className="text-[#2D1B0E]">{l.material_name}</span>
          <span className="font-mono font-semibold text-emerald-700 text-right">
            × {fmtHandOverPU(U, rq.qty)}{u && <span className="text-[10px] text-[#8B7355] ml-0.5">{u}</span>}
            {U.pf > 1 && <span className="text-[9px] text-[#B8A590] ml-1">= {fmtNum(U.toRecipe(rq.qty))} {U.recipeUnit}</span>}
            {rq.over && (
              <span className="ml-1 text-[9px] px-1 rounded bg-amber-100 text-amber-800 border border-amber-300">
                over approved ({fmtNum(U.toPU(l.remaining))} {u})
              </span>
            )}
            <span className="block text-[9px] font-sans font-normal text-[#8B7355]">
              {/* partyTakeClause (final pass): the same words for an ordinary
                  take; for a top-up the shelf cannot cover (`shortTake`), what
                  the store's books actually hold instead of "moves 0 kg". */}
              then the party transfer {partyTakeClause(U, tk)} — {takeOutcomeWords(U, effectiveQty(l), tk)}
            </span>
          </span>
        </li>
      );
    }
    if (tk && (tk.changed || tk.byShelf)) {
      return (
        <li key={l.id} className="flex items-center justify-between text-sm border-b border-[#E8D5C4]/50 py-1.5">
          <span className="text-[#2D1B0E]">{l.material_name}</span>
          <span className="font-mono font-semibold text-emerald-700 text-right">
            × {fmtTakePU(U, tk.takeRecipe)}{u && <span className="text-[10px] text-[#8B7355] ml-0.5">{u}</span>}
            {fmtTakeHint(U, tk.takeRecipe) && <span className="text-[9px] text-[#B8A590] ml-1">{fmtTakeHint(U, tk.takeRecipe)}</span>}
            {rq.over && (
              <span className="ml-1 text-[9px] px-1 rounded bg-amber-100 text-amber-800 border border-amber-300">
                over approved ({fmtNum(U.toPU(l.remaining))} {u})
              </span>
            )}
            <span className="block text-[9px] font-sans font-normal text-[#8B7355]">
              everything the central store holds — {takeOutcomeWords(U, effectiveQty(l), tk)}
            </span>
          </span>
        </li>
      );
    }
    return (
      <li key={l.id} className="flex items-center justify-between text-sm border-b border-[#E8D5C4]/50 py-1.5">
        <span className="text-[#2D1B0E]">{l.material_name}</span>
        <span className="font-mono font-semibold text-emerald-700">
          × {fmtHandOverPU(U, rq.qty)}{u && <span className="text-[10px] text-[#8B7355] ml-0.5">{u}</span>}
          {U.pf > 1 && <span className="text-[9px] text-[#B8A590] ml-1">= {fmtNum(U.toRecipe(rq.qty))} {U.recipeUnit}</span>}
          {rq.over && (
            <span className="ml-1 text-[9px] px-1 rounded bg-amber-100 text-amber-800 border border-amber-300">
              over approved ({fmtNum(U.toPU(l.remaining))} {u})
            </span>
          )}
        </span>
      </li>
    );
  };
  if (forecastBlocks(forecast)) {
    // "Being issued" lists only what will move: not held, and a quantity the
    // route acts on (it skips a line whose figure is 0 — a box typed to 0 —
    // without issuing it, so listing it here would contradict the banner's
    // "refuse the whole issue").
    // A PARTY refusal is whole (PartyRefusalBanner): nothing goes, and the
    // lines the transfer could move are named as not issued either.
    const partyWhole = !!forecast.party?.refused;
    const going = partyWhole ? []
      : lines.filter(l => !heldIds.has(l.id) && resolveQty(l, l.remaining).qty > 0);
    const kept = partyWhole ? lines : lines.filter(l => heldIds.has(l.id));
    return (
      <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
        <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
          <div className="px-5 py-3 border-b border-[#E8D5C4]">
            <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">
              <Send className="w-4 h-4 text-emerald-600" /> Issue all items
            </div>
            <div className="text-[11px] text-[#8B7355] mt-0.5">
              {going.length > 0
                ? <>{req.req_number} — these items are being issued to <b className="text-[#6B5744]">{req.department_name}</b>:</>
                : <>{req.req_number} — nothing will be issued to <b className="text-[#6B5744]">{req.department_name}</b>:</>}
            </div>
          </div>
          <div className="p-4 max-h-[50vh] overflow-y-auto space-y-3">
            {going.length > 0 && (
              <ul className="space-y-1">
                {going.map(item)}
              </ul>
            )}
            <div>
              <div className="text-[11px] font-semibold text-red-800 mb-1">
                {partyWhole
                  ? <>NOT issued — the party transfer cannot move every line, so none of them goes:</>
                  : <>NOT issued — the central store does not hold the quantity asked:</>}
              </div>
              <ul className="space-y-1">
                {kept.map(l => {
                  const U = lineUnits(l);
                  const u = U.pu;
                  const rq = resolveQty(l, l.remaining);
                  return (
                    <li key={l.id} className="flex items-center justify-between text-sm border-b border-red-200/60 py-1.5">
                      <span className="text-red-900">{l.material_name}</span>
                      <span className="font-mono font-semibold text-red-700">
                        × {fmtHandOverPU(U, rq.qty)}{u && <span className="text-[10px] text-[#8B7355] ml-0.5">{u}</span>}
                        {U.pf > 1 && <span className="text-[9px] text-[#B8A590] ml-1">= {fmtNum(U.toRecipe(rq.qty))} {U.recipeUnit}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
            <CentralHoldBanner forecast={forecast} gesture="Confirm & Issue" scope="open line" />
            <PartyLeftOpenNote party={forecast.party} gesture="Confirm & Issue" />
            <ForecastBasisNote />
          </div>
          <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2">
            <button onClick={onCancel} disabled={busy}
                    className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">
              Cancel
            </button>
            {/* NOT disabled — the forecast is advisory (a liquor / store-mapped
                line is never floored and this page cannot tell which those
                are). A hold writes the covered lines and reports the rest; a
                whole refusal writes nothing. Both are safe to let through. */}
            <button onClick={onConfirm} disabled={busy}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Confirm & Issue
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#E8D5C4]">
          <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">
            <Send className="w-4 h-4 text-emerald-600" /> Issue all items
          </div>
          <div className="text-[11px] text-[#8B7355] mt-0.5">
            {req.req_number} — these items are being issued to <b className="text-[#6B5744]">{req.department_name}</b>:
          </div>
        </div>
        <div className="p-4 max-h-[50vh] overflow-y-auto">
          {lines.length === 0 ? (
            <div className="text-sm text-[#8B7355] text-center py-4">No open items to issue.</div>
          ) : (
            <ul className="space-y-1">
              {lines.map(item)}
            </ul>
          )}
          {lines.length > 0 && (
            <div className="mt-3 space-y-2">
              <PartyLeftOpenNote party={forecast.party} gesture="Confirm & Issue" />
              <ForecastBasisNote />
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2">
          <button onClick={onCancel} disabled={busy}
                  className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy || lines.length === 0}
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Confirm & Issue
          </button>
        </div>
      </div>
    </div>
  );
}

function effectiveQty(line: ReqLine): number {
  if (line.is_rejected) return 0;
  if (line.chef_approved_qty != null) return Number(line.chef_approved_qty);
  return Number(line.quantity_requested) || 0;
}

/**
 * IS THIS LINE COMPLETE? — THE RULE (round 8), the server's own predicate, so
 * this desk, the management desk and the routes can never disagree about which
 * lines are done. issue-stock.ts lineIssueComplete → central-debit-clamp.ts
 * issuedCoversAsk, run through the desks' ONE transcription of it
 * (src/lib/desk-rule.ts deskLineComplete, proved against the server by
 * scripts/desk-rule-tests.ts):
 *
 *     complete ⇔ issued + 1e-9 ≥ approved
 *              ∨ ( the line's shelf mark speaks for its quantity_issued
 *                  ∧ step > 0 ∧ grid(issued) > 0
 *                  ∧ grid(approved − issued) < grid(step) )
 *
 * The shelf mark (shelf_emptied_qty) is the server's record that a take EMPTIED
 * the central shelf and closed the line there: THREE MANGO approved 14.843 kg
 * over a 14,842.4 g shelf, the 14.842 typed took the whole shelf and recorded
 * 14.8424 — complete, 0.6 g owed that nobody can issue. Round 7's second arm
 * (the two figures SHOW as one number) and third arm (anything owing less than
 * one printed step) closed lines whether or not the shelf was emptied: MALA
 * MANGO CRUSH 5 LTR, 1,000 of 1,004 ml issued with 49 L on the shelf, read
 * Fulfilled here while the store could serve the 4 ml, and with a defer in the
 * same POST the requisition sat with nothing to press. A remainder below one
 * step over a shelf that still holds stock is now an ordinary open line.
 * `effectiveQty` stays this page's (a chef-rejected line reads 0 — done).
 */
function lineIssueComplete(line: ReqLine): boolean {
  return deskLineComplete(Number(line.quantity_issued) || 0, effectiveQty(line), line);
}

/** What is still owed on the line in its own unit: effective − issued, or 0
 *  once lineIssueComplete says the line is done. Every "outstanding" on this
 *  page reads this, never a bare subtraction. */
function owedQty(line: ReqLine): number {
  if (lineIssueComplete(line)) return 0;
  return Math.max(0, effectiveQty(line) - (Number(line.quantity_issued) || 0));
}

/**
 * ONE line's quantity, split three ways. THE unit basis is the LINE's own stored
 * `unit` (option B) for every figure here — nothing is converted. Push each part
 * through lineUnits() at the point it is displayed, exactly as the row's other
 * quantities already are.
 *
 *   issued    — what physically left the store (quantity_issued). NOT capped at
 *               `effective`: an over-issue is a real event the store records as
 *               what actually went, and clamping it here would quietly hide it.
 *   deferred  — the part of the remainder a human has promised a time for.
 *   open      — the part of the remainder nobody has promised anything about.
 *
 * WHY THIS IS THE WHOLE FIX: the store's real answer to "issue 4 kg?" is often
 * "2 now, 2 at 7pm", and the line has only ever been able to land WHOLLY in one
 * bucket — deferring it filed it as 1 deferred / 0 issued and the 2 kg that left
 * the counter became invisible. Split into three parts they are all sayable.
 *
 * `deferred` and `open` are mutually exclusive TODAY, because deferred_until is
 * a flag on the whole line: set, and the entire remainder is the promise; unset,
 * and the entire remainder is open. That is a property of the schema, not an
 * assumption baked in here — the shape stays correct if a per-quantity defer
 * ever lands, and every caller renders whichever parts are non-zero.
 */
/**
 * Red / Amber / Green on the CENTRAL STORE's quantity — see the "In store"
 * header for why that word matters.
 *
 * The bands are about THIS hand-over, not a generic reorder alert — the
 * question at the counter is "can I give what is being asked for", so the
 * outstanding quantity is the yardstick:
 *
 *   RED    nothing on the shelf, or less than this line still needs
 *   AMBER  enough for this line, but the shelf drops to or below the reorder
 *          point once it goes out
 *   GREEN  enough, and still above the reorder point afterwards
 *
 * A material with no reorder_level set can never be amber — there is no
 * threshold to cross — so it reads green whenever it covers the line. Saying
 * amber there would be inventing a judgement nobody configured.
 *
 * TWO BASES MEET HERE, so the need is lifted onto the shelf's basis BEFORE any
 * comparison. current_stock and reorder_level are material-level columns on
 * raw_materials — RECIPE units (g / ml), same as every other reader of them
 * (page.tsx low-stock, eod). The outstanding qty is in the LINE's own unit
 * (option B), which is the PURCHASE unit on 16,346 of the 16,353 live
 * requisition_items rows. Compared raw, a 1 kg need read as the number 1
 * against a 1,000 g shelf, so `qty < need` was false for a store holding a
 * FIFTH of the ask and the dot went GREEN — measured on the live db, 24 lines
 * flip GREEN→RED once both sides agree (JAVITRI 50 GMS: 1,000 g on the shelf
 * against a 2 kg line; STAR ANISE: 954 g against 1 kg).
 *
 * U.toRecipe is the page's own line-basis resolver, so the three legacy lines
 * with a blank unit (read as recipe) and every packFactor-1 material (kg/kg
 * PICKLED GINGER included) pass through unchanged — no special case here.
 *
 * `qty` is RETURNED in recipe units on purpose: the caller prints it through
 * U.stockPU for the purchase figure the column tooltip promises, and prints it
 * raw as the small "= N g" hint. Converting it here would divide it twice.
 */
function stockLevel(line: ReqLine): {
  qty: number | null; dot: string; text: string; title: string;
} {
  const raw = (line as any).current_stock;
  if (raw == null) return { qty: null, dot: '', text: '', title: '' };
  const qty = Number(raw) || 0;                       // recipe units (rm.current_stock)
  const U = lineUnits(line);
  // lineSplit, not a raw (effective − issued): on a store-rejected line the
  // remainder was CANCELLED, so this line needs nothing more off the shelf and
  // must not paint the material red for a demand that no longer exists.
  const need = U.toRecipe(lineSplit(line).outstanding);  // line basis → recipe basis
  const reorder = Number(line.reorder_level) || 0;    // recipe units (rm.reorder_level)

  if (qty <= 0 || qty < need) {
    return {
      qty, dot: 'bg-red-500', text: 'text-red-700 font-semibold',
      // A NEGATIVE book balance is a real state once every issue debits central,
      // and it is not the same statement as "out of stock" — it says the book
      // has been over-issued against and needs a count, which is a different
      // instruction to the storekeeper. Never floor this to 0 to make it read
      // nicer: a floor invents stock the shelf does not have.
      title: qty < 0
        ? 'Book balance is NEGATIVE — more has been issued than the book ever received. Needs a physical count.'
        : qty === 0 ? 'Out of stock in the store'
        : 'Short — less on the shelf than this line still needs',
    };
  }
  if (reorder > 0 && qty - need <= reorder) {
    return {
      qty, dot: 'bg-amber-500', text: 'text-amber-700',
      title: 'Enough for this line, but the store drops to its reorder point once it goes out',
    };
  }
  return { qty, dot: 'bg-emerald-500', text: 'text-[#6B5744]', title: 'In stock' };
}

function lineSplit(line: ReqLine): {
  effective: number; issued: number; outstanding: number;
  deferred: number; open: number; cancelled: number; isSplit: boolean;
} {
  const effective = effectiveQty(line);
  const issued = Math.max(0, Number(line.quantity_issued) || 0);
  // 0 once the line is complete by the server's own rule (see
  // lineIssueComplete) — a line a take closed by emptying the shelf owes nothing.
  const remainder = lineIssueComplete(line) ? 0 : Math.max(0, effective - issued);
  // A STORE-REJECTED LINE OWES NOTHING. The reject cancelled the outstanding
  // balance — that is the whole meaning of the gesture — so the remainder moves
  // out of `outstanding` and into `cancelled`. It stopped being academic with
  // the Option-A reject: a line rejected after a part hand-over sits at 200 of
  // 240, and reading the leftover 40 as "still owed" puts the store back on the
  // hook for goods the storekeeper has already declared it cannot supply.
  // (A chef-rejected line already lands here with effective = 0 — see
  // effectiveQty — so its remainder is 0 and nothing changes for it.)
  const cancelledByStore = !!line.store_rejected;
  const outstanding = cancelledByStore ? 0 : remainder;
  const promised = !!line.deferred_until;
  return {
    effective, issued, outstanding,
    deferred: promised ? outstanding : 0,
    open:     promised ? 0 : outstanding,
    /** What the rejection wrote off. 0 on every line nobody rejected. */
    cancelled: cancelledByStore ? remainder : 0,
    // The owner's case in one boolean: goods went out AND goods are still owed,
    // on the SAME line. A rejected line is never "split" — nothing is owed.
    isSplit: issued > 0 && outstanding > 0,
  };
}

/**
 * Lines that "Issue All Items" will issue: not rejected, not deferred, and with
 * a positive remaining qty. Returns each with its `remaining` (effective − issued)
 * so both the confirmation list and the POST body use the same numbers.
 */
function openIssuableLines(req: Requisition): Array<ReqLine & { remaining: number }> {
  const out: Array<ReqLine & { remaining: number }> = [];
  for (const line of req.items || []) {
    if (line.is_rejected) continue;
    // Store rejected — never in the Issue-All batch, and this `continue` is
    // CORRECT under Option A rather than in spite of it. A rejected line may now
    // carry a real hand-over, but its balance was cancelled: it owes nothing, so
    // it is not "open". Un-reject it first if it should be issuable again.
    if (line.store_rejected) continue;
    if (line.deferred_until) continue;
    // Delivered direct on a merged PO (ruling #68): the goods went straight to
    // a department, the central store never held them — never in a batch
    // issue. Every line no merged PO has touched passes exactly as before.
    if (isDeliveredDirect(line)) continue;
    // Routed (ruling #45): its department sends it by department transfer —
    // never in a store batch. The server refuses it anyway (code 'routed').
    if (isRoutedLine(line)) continue;
    const remaining = owedQty(line);
    if (remaining > 0) out.push({ ...line, remaining });
  }
  return out;
}

/**
 * Did this line hand goods over on `dayIST`?
 *
 * issue_history is the per-hand-over log written by /store-issue. The one-shot
 * /store-process path writes quantity_issued with NO history entry and no
 * issued_at, so the requisition's own store_processed_at stamp is the only date
 * that hand-over has — used last, and only for a line that did move something.
 */
function issuedOnDay(line: ReqLine, reqStamp: unknown, dayIST: string): boolean {
  if ((Number(line.quantity_issued) || 0) <= 0) return false;
  let history: unknown[] = [];
  try { const p: unknown = JSON.parse(line.issue_history || '[]'); if (Array.isArray(p)) history = p; } catch { /* corrupt JSON reads as no history */ }
  if (history.length > 0) return history.some(h => fmtISTIsoDate((h as { at?: unknown } | null)?.at) === dayIST);
  if (line.issued_at) return fmtISTIsoDate(line.issued_at) === dayIST;
  return fmtISTIsoDate(reqStamp) === dayIST;
}

function mergeStats(req: any): Requisition {
  const items: ReqLine[] = req.items || [];
  const today = todayIST();
  const reqStamp = req.fulfilled_at || req.store_processed_at || null;
  let issued = 0, deferred = 0, open = 0, partial = 0, outstanding = 0;
  // Counted ALONGSIDE the partition above, never instead of it — the five
  // existing fields are what the header badges and every tab predicate read.
  let issuedAny = 0;
  let rejectedKept = 0, rejectedCut = 0;
  let qtyIssued = 0, qtyCancelled = 0;
  let issuedToday = false;
  let routedOwing = 0, routedDone = 0;
  for (const it of items) {
    const got = Number(it.quantity_issued) || 0;
    // ── A ROUTED LINE (ruling #45) IS NOT THE STORE'S. Another department
    // sends it by department transfer; nothing of it ever leaves this store.
    // So it is counted apart and kept OUT of every store roll-up below — the
    // partition, "sent, not closed", "sent, then cancelled", Issued Today and
    // the part-issued chip — or the card would say the store handed over
    // chicken it never held. It does count toward the two figures that only
    // pick the closed requisition's WORD (deliveryState): what reached the
    // department and what a rejection cancelled are facts about the
    // requisition, whoever sent it. With no routed line, nothing here runs.
    if (isRoutedLine(it)) {
      qtyIssued += got;
      if (it.store_rejected) qtyCancelled += owedQty(it);
      if (it.is_rejected || it.store_rejected) { /* closed — the row says so */ }
      else if (lineIssueComplete(it)) routedDone++;
      else routedOwing++;
      continue;
    }
    // WHAT LEFT THE STORE IS COUNTED FIRST, BEFORE ANY SKIP. Under the Option-A
    // reject a store-rejected line can carry a REAL hand-over (200 of 240
    // eggs), and the old `continue` pair below dropped it from every roll-up on
    // this page — the requisition read "nothing went out" while 200 eggs were
    // in the kitchen. These three lines see every hand-over regardless of what
    // else is true of the line; the partition below still does not.
    qtyIssued += got;
    if (got > 0) issuedAny++;
    if (!issuedToday && issuedOnDay(it, reqStamp, today)) issuedToday = true;
    // WHAT THE *STORE* WROTE OFF. `asked` is effectiveQty — the HOD-approved
    // quantity when there is one — because that is the number this desk was
    // asked to hand over.
    //
    // A CHEF REJECTION IS NOT COUNTED HERE, and that is the deliberate answer
    // to a question this function got wrong first time round. It used to reach
    // past effectiveQty back to quantity_requested for an is_rejected line, so
    // a requisition the store served 100% read amber "Closed short" on the
    // store's own screen because the CHEF had struck a line out. Two things are
    // wrong with that, and the second is the decisive one:
    //   1. It is the only place on this page that looks past effectiveQty. The
    //      chef-rejected line is 0 to qty_outstanding, 0 to lines_open, absent
    //      from openIssuableLines, unselectable, and struck through in the row —
    //      by the whole file's definition it was never the store's business.
    //   2. It made the SAME event read two opposite ways. A chef who presses
    //      Reject and a chef who types the quantity down to 0 have done the
    //      identical thing to the department; keyed on is_rejected the first
    //      printed "Closed short" and the second printed "Fulfilled". A word
    //      that flips on which button the chef pressed is not an honest word,
    //      which is the entire point of this change.
    // So the badge answers "did the STORE deliver what it was asked for?".
    // A chef cut is a real thing the department needs to see, and the place it
    // belongs is the department's own screen (/requisitions) — not this one,
    // and not by reading a store rejection's field.
    if (it.store_rejected) {
      const cut = owedQty(it);
      qtyCancelled += cut;
      if (got > 0) {
        rejectedKept++;
        if (cut > 0) rejectedCut++;
      }
    } else if (it.is_rejected && got > 0) {
      // A chef-rejected line that nevertheless handed goods over (the chef
      // struck it out after the store had already carried part of it). It is
      // counted in lines_issued_any above — goods really did leave — but it
      // owes NOTHING (effectiveQty is 0 for it), so it has to be subtracted
      // back out of the violet "sent, not closed" chip exactly as a
      // store-rejected line is. Without this it claimed a balance was still
      // owed on a row whose own action cell reads "no action — rejected by
      // chef". It is NOT counted in rejectedCut: that chip is the store's
      // "sent, then cancelled", and the store cancelled nothing here.
      rejectedKept++;
    }
    // ── THE PARTITION. Still non-rejected lines ONLY, and still exactly three
    // buckets. A rejected line is CLOSED, not open: it owes nothing, so it adds
    // nothing to lines_open / lines_deferred / qty_outstanding, and it is not
    // "issued" in the completed sense either. Do not fold it in here — every
    // tab predicate below reads these five fields, and a rejected line joining
    // lines_issued would pull requisitions into Balance Pending that owe
    // nothing.
    if (it.is_rejected) continue;
    if (it.store_rejected) continue;
    // "Issued in full" is lineIssueComplete — THE RULE, the server's predicate
    // (`got + 1e-9 >= eff`, or the shelf arm on the line's shelf mark) — so a
    // line the route closed is counted closed here too, and owedQty is 0 for
    // exactly those lines.
    const done = lineIssueComplete(it);
    if (done && !it.deferred_until) issued++;
    else if (it.deferred_until) deferred++;
    else open++;
    // A part-issued line is NOT the same as an untouched one — it used to be
    // filed as `open` above, which is why "some of it went out" was invisible.
    if (got > 0 && !done) partial++;
    // ("Did goods leave the store on this line?" — issuedAny — and "did that
    // happen today?" both moved ABOVE the partition, where they can see a
    // rejected line's kept hand-over. They are not re-counted here.)
    outstanding += owedQty(it);
  }
  return {
    ...req,
    items,
    total_lines: items.length,
    lines_issued: issued,
    lines_deferred: deferred,
    lines_open: open,
    lines_partial: partial,
    lines_issued_any: issuedAny,
    lines_rejected_kept: rejectedKept,
    lines_rejected_cut: rejectedCut,
    qty_outstanding: outstanding,
    qty_issued: qtyIssued,
    qty_cancelled: qtyCancelled,
    issued_today: issuedToday,
    lines_routed_owing: routedOwing,
    lines_routed_done: routedDone,
    routed_depts: routedDeptNames(items),
  } as Requisition;
}

/**
 * THE HONEST WORD FOR A CLOSED REQUISITION.
 *
 * requisitions.status has ONE terminal value, 'fulfilled', and the store-issue
 * route reaches it whenever nothing is still waiting on the store:
 *
 *     allDone = every(line => is_rejected || store_rejected || lineIssueComplete(line))
 *
 * (lineIssueComplete — THE RULE: issued ≥ effective, or a take emptied the
 * central shelf and less than one printed step is owed; this page runs the
 * same predicate through src/lib/desk-rule.ts, see lineIssueComplete above.)
 *
 * As a WORKFLOW state that is right, and this function does not argue with it —
 * it does not read a new column, it does not ask the server for one, and the
 * route's rule is untouched. What it fixes is the WORD. REQ-2026-0620 had a
 * single line, STORE REJECTED, zero eggs handed over, and the card said
 * "Fulfilled" to the person holding the empty tray.
 *
 * Three states, derived from quantities the page already has:
 *   'full'  nothing was cancelled → everything asked for was handed over
 *   'short' something WAS cancelled, but goods went out too
 *   'none'  something was cancelled and nothing went out at all
 *
 * THE TEST IS A CANCELLATION, NOT A SHORTFALL, and that distinction is the
 * whole safety of this change. 737 of the 1,620 fulfilled requisitions in this
 * database carry a plain arithmetic shortfall with no rejection anywhere on
 * them — imported rows whose issued quantities were never fully recorded.
 * Keying on shortfall would re-label 737 historic requisitions on the strength
 * of import noise; keying on qty_cancelled leaves every one of them reading
 * 'Fulfilled', exactly as it does today, and this function stays silent until
 * somebody actually rejects something. Measured on the live db 2026-08-26:
 * 1,620 fulfilled → 1,620 'full', 0 'short', 0 'none'. It is a provable no-op
 * on everything that exists.
 *
 * 'none' is the eggs case and reads "Closed": nothing was delivered, so there
 * is nothing to be short OF. 'short' is only reachable at all because the
 * Option-A reject stopped un-issuing what was physically handed over — before
 * it, a rejected line always read zero and this state could not exist on one.
 *
 * Returns null for a requisition that is not finished; those keep the ordinary
 * in-flight labels, which are already honest.
 */
function deliveryState(req: Requisition): 'full' | 'short' | 'none' | null {
  if (req.status !== 'fulfilled') return null;
  if ((req.qty_cancelled || 0) <= 0) return 'full';
  return (req.qty_issued || 0) > 0 ? 'short' : 'none';
}

/** The queue tabs. 'issued_log' is a separate panel, not a slice of the list.
 *  'routed' (ruling #45) = lines another department still has to send. */
type StoreTab = 'open' | 'deferred' | 'balance_pending' | 'routed' | 'issued_today' | 'issued_log';

/**
 * THE definition of every tab — called by the tab body AND by the tab badges.
 *
 * These are roll-ups of the LINE columns, not readings of requisitions.status
 * (which is a single scalar and cannot say "issued some, owes the rest"), so a
 * requisition can match more than one tab. That is the point: a half-issued req
 * belongs in Issued Today *and* Balance Pending.
 *
 * 'deferred' stays strictly "a human promised a time on this line"
 * (deferred_until) — it is NOT the generic "something is still owed" bucket,
 * because a deferred line also suppresses Issue All and the selection checkbox.
 */
function matchesTab(r: Requisition, tab: StoreTab): boolean {
  switch (tab) {
    case 'open':            return r.status !== 'fulfilled' && r.lines_open > 0;
    case 'deferred':        return r.lines_deferred > 0;
    // NOTE: there is no 'part_issued' case any more. A split line
    // (0 < issued < effective) always leaves an outstanding quantity, so it
    // already matches 'balance_pending' below — the two tabs were never
    // independent, and their counts moved together. lines_partial is still
    // computed and still drives the row chip; it just no longer earns a tab.
    // Goods went out, goods are still owed, and the req is not closed — the
    // half-transfer bucket. The "something was actually handed over" clause is
    // what makes this tab DISTINCT: without it every untouched requisition
    // (nothing issued, therefore everything outstanding) matches too and the
    // tab becomes a copy of Pending Issue.
    // lines_rejected_kept is the THIRD way goods can have left the store, and
    // it has to be here or this tab cannot see the case it exists for. The
    // other two terms are counted inside the partition in mergeStats, AFTER a
    // store-rejected line has been skipped — so on the owner's shape (240 eggs
    // asked, 200 handed over, balance rejected, a second line still open) both
    // read 0 and the requisition fell out of the one bucket whose own comment
    // describes it exactly. Newly reachable only because the Option-A reject
    // stopped un-issuing what was physically handed over; before it a rejected
    // line always read 0 issued and this could not arise. Purely additive — it
    // can only put a requisition INTO the tab, never take one out.
    case 'balance_pending':
      return r.status !== 'fulfilled'
        && r.qty_outstanding > 0
        && (r.lines_issued > 0 || r.lines_partial > 0 || r.lines_rejected_kept > 0);
    // "Goods moved today", NOT "requisition closed" — the two are different
    // events and this tab used to conflate them under the name "Fulfilled Today".
    case 'issued_today':    return r.status === 'fulfilled' || r.issued_today;
    // "With Kitchen" (ruling #45): a line of it still waits on the department
    // a Direct Issue rule routes it to. Not the store's to issue — listed so
    // the store can see where the rest of a requisition is, and reject a line.
    case 'routed':          return r.status !== 'fulfilled' && (r.lines_routed_owing || 0) > 0;
    default:                return false;
  }
}

/**
 * Requisition status in the department's words. Mostly the same vocabulary as
 * the sister page /requisitions (its STATUS_LABEL) — kept as a local map rather
 * than an import so this page doesn't pull a 2,000-line page module into its
 * bundle for a handful of strings.
 *
 * TWO deliberate differences from that page, and this list is the whole of it.
 * It used to say "keep the wording in step" and "ONE deliberate difference",
 * which stopped being true the moment deliveryState landed above:
 *   1. chef_approved reads 'With Store' here, not 'With Mgmt'. Anything
 *      chef_approved that reaches THIS page reached it through the inbox=store
 *      query — it is, by definition, sitting on the store's counter.
 *   2. 'fulfilled' is NOT always printed from this map. deliveryState()
 *      overrides it with 'Closed short' / 'Closed' when something on the
 *      requisition was rejected; the map's 'Fulfilled' is the fall-through for
 *      the case where nothing was. /requisitions has no such override and still
 *      prints a flat 'Fulfilled' — so the two screens can now show different
 *      words for the same requisition. That is a KNOWN GAP, not an oversight
 *      here: the department-facing page is a different file and a different
 *      decision. If it is ever given the same treatment, this note goes.
 */
const STATUS_LABEL: Record<string, string> = {
  draft:           'Draft',
  submitted:       'With HOD',
  chef_approved:   'With Store',
  mgmt_approved:   'With Store',
  chef_rejected:   'Rejected',
  store_processed: 'Issued (partial)',
  fulfilled:       'Fulfilled',
  cancelled:       'Cancelled',
};

/**
 * Header summary for a part-issued requisition, in PURCHASE units (the store
 * hands over bottles and packets, not millilitres).
 *
 * One part-issued line reads as real numbers — "4 of 6 BTL issued". Two or more
 * can't be added up: each line carries its own unit, so a sum would be a
 * meaningless number presented as a fact. Those report the count and leave the
 * quantities to the expanded rows.
 *
 * BOTH shapes now name WHERE THE BALANCE SAT when the store walked away, because
 * "4 of 6 BTL issued" is only half the sentence: it never said whether someone
 * promised the other 2 for 7pm or whether they are simply unhandled. The
 * single-line form says the balance in the same purchase unit as the lead; the
 * many-line form counts them, since the units still cannot be added.
 */
function partialSummary(req: Requisition): string | null {
  const partials = (req.items || []).filter(l => {
    if (l.is_rejected || l.store_rejected) return false;
    // A routed line's figure is what its department SENT, not an issue.
    if (isRoutedLine(l)) return false;
    const got = Number(l.quantity_issued) || 0;
    return got > 0 && !lineIssueComplete(l);
  });
  if (partials.length === 0) return null;
  if (partials.length > 1) {
    const promised = partials.filter(l => !!l.deferred_until).length;
    const tail = promised === 0            ? 'balances still open'
               : promised === partials.length ? 'balances deferred'
               : `${promised} deferred, ${partials.length - promised} still open`;
    return `${partials.length} items part-issued — ${tail}`;
  }
  const l = partials[0];
  const U = lineUnits(l);
  const s = lineSplit(l);
  // s.deferred / s.open are mutually exclusive per line (deferred_until is a
  // line flag), so exactly one of these two sentences is the true one.
  // EXACT BELOW ONE PRINTED STEP (round 10), as the rows under it are:
  // fmtHandOverPU is fmtNum(U.toPU(q)) at 0.001 or more, byte for byte, and
  // the figure at the precision that names it below — the chip read "0 of 1
  // kg issued" over a 0.4 g hand-over and "0.001 kg still open" over 0.6 g
  // while the row said 0.0004 kg / 0.0006 kg (round-9 store-desk verifier,
  // c25_crumb_card, c14_chip_subgram).
  const q = (v: number) => fmtHandOverPU(U, v);
  const balance = s.deferred > 0
    ? `${q(s.deferred)}${U.pu ? ` ${U.pu}` : ''} deferred`
    : `${q(s.open)}${U.pu ? ` ${U.pu}` : ''} still open`;
  return `${q(s.issued)} of ${q(s.effective)}${U.pu ? ` ${U.pu}` : ''} issued — ${balance}`;
}

function ReqCard(props: {
  req: Requisition; expanded: boolean; onToggle: () => void;
  showIssueAll?: boolean; onIssueAll?: () => void;
  // Feature 3 — per-requisition line selection.
  selectable?: boolean;
  selectedIds: Set<string>;
  onToggleLineSelect: (lineId: string) => void;
  onToggleSelectAll: () => void;
  onIssueSelected: () => void;
  issuingSelected: boolean;
  busyLine: string | null;
  /** The SAME resolver every issue POST uses (resolveIssueQty) — so the advance
   *  warnings are about exactly the figures the buttons will send. */
  resolveQty: (line: ReqLine, remaining: number) => { qty: number; over: boolean; note: string };
  editQty: Record<string, string>; setEditQty: (f: any) => void;
  issueNotes: Record<string, string>; setIssueNotes: (f: any) => void;
  editDefer: Record<string, { until: string; reason: string }>;
  setEditDefer: (f: any) => void;
  // "Issue N, defer the rest" — the captured gesture per line + its two steps.
  splitIssueQty: Record<string, { qty: number; token: string }>;
  setSplitIssueQty: (f: any) => void;
  onBeginIssueDeferRest: (line: ReqLine) => void;
  onIssueDeferRest: (line: ReqLine) => void;
  /** `expect`: a held panel's cap only — the row's line_issued (THE STALE CAP). */
  onIssue: (line: ReqLine, qty?: number, expect?: number) => void;
  onDefer: (line: ReqLine) => void;
  /** Refused reversals by line id — rendered on the line, not as a toast. */
  blockedReversals: Record<string, BlockedReversal>;
  /** Central-stock refusals by line id — PURCHASE units, see CentralShort. */
  centralShort: Record<string, CentralShort>;
  /** Reject / Undo refusals by the central floor, by the PRESSED line's id (round 10). */
  reversalShort: Record<string, ReversalShort>;
  /** Party lines another gesture's transfer lowered and reopened (final pass). */
  partyShort: Record<string, PartyShortNote>;
  onUndo: (line: ReqLine) => void;
  onReject: (line: ReqLine) => void;
  onUnreject: (line: ReqLine) => void;
  onShowHistory: (line: ReqLine) => void;
  /** Store manager / admin — may put lines on a merged PO (ruling #65). */
  canMerge?: boolean;
  /** "Add to a merged PO" on a deferred line: opens the modal with it ticked. */
  onAddToMergedPo?: (line: ReqLine) => void;
}) {
  const { req, expanded, onToggle } = props;
  // Feature 3 — selection derived state. Open issuable lines are the only
  // selectable ones; the header checkbox reflects/controls all of them.
  const openLines = openIssuableLines(req);
  const openIds = openLines.map(l => l.id);
  const selectedCount = openIds.filter(id => props.selectedIds.has(id)).length;
  const allOpenSelected = openIds.length > 0 && selectedCount === openIds.length;
  const someOpenSelected = selectedCount > 0 && !allOpenSelected;
  /* THE CENTRAL FLOOR, FORECAST PER GESTURE (see forecastCentralHolds). Each
     batch is built exactly as its button builds the POST: same lines, same
     order (openIssuableLines), same resolver — so a line typed down to what the
     store holds stops being flagged the moment it is typed. */
  const allForecast = forecastCentralHolds(
    req, openLines.map(l => ({ line: l, qty: props.resolveQty(l, l.remaining).qty })));
  const selForecast = forecastCentralHolds(
    req, openLines.filter(l => props.selectedIds.has(l.id))
      .map(l => ({ line: l, qty: props.resolveQty(l, l.remaining).qty })));
  /* AND PER ROW, ALONE — the row's own Issue Now (or "Issue & defer balance")
     sends that one line, and the floor refuses a lone short entry whole. Scored
     alone on purpose: an issue only ever REMOVES headroom from a later line of
     the same material, so a line held alone is held in every batch too, and
     the row's sentence is true whichever button is pressed. (A line that fits
     alone but is held only behind an earlier line of the same item in a batch
     is named by that batch's own banner, not by the row.) */
  const rowHold = (line: ReqLine): CentralHoldForecast | undefined => {
    if (line.is_rejected || line.store_rejected) return undefined;
    // Routed (ruling #45): never issued from central, so nothing to forecast.
    if (isRoutedLine(line)) return undefined;
    const outstanding = lineSplit(line).outstanding;
    if (!(outstanding > 0)) return undefined;
    const sq = props.splitIssueQty[line.id]?.qty;
    const split = !!props.editDefer[line.id] && Number.isFinite(sq) && sq > 0;
    const qty = split ? sq : props.resolveQty(line, outstanding).qty;
    const fc = forecastCentralHolds(req, [{ line, qty }], split ? new Set([line.id]) : undefined);
    const f = fc.byLine[line.id];
    if (!f?.held) {
      // PARTY (round 8b): this line fits, but issuing it completes the
      // requisition, and the transfer that then runs refuses the WHOLE POST
      // over another line the store's books cannot cover — so this row's own
      // button is refused too, and its row says so before the click.
      const others = fc.party?.refused ? fc.party.short.filter(x => x.line.id !== line.id) : [];
      if (others.length === 0) return undefined;
      const U = lineUnits(line);
      return {
        held: true, availPU: 0, empty: true, pf: U.pf,
        purchaseUnit: String(line.material_purchase_unit || line.material_unit || '').trim(),
        poolPU: 0, sharePU: 0, others: 0,
        party: { holdsPU: 0, totalPU: 0, headroomLine: 0, closesAtCap: false, blockedBy: others.map(x => x.line.material_name) },
      };
    }
    // Scored alone, so its "Issuable now" is the whole balance — true for this
    // row's own button, and the SAME balance every other open line of the item
    // is offered. Said on the row, so two figures are never read as two
    // allowances (round 7: two MANGO rows each offering the whole 1 kg, both
    // typed back into one Issue All, one held). The batch banner splits the
    // balance between them exactly as the server's rows will.
    const sharedWith = openLines.filter(o => o.id !== line.id && o.material_id === line.material_id).length;
    // PARTY (round 10): typed down to its "Issuable now", does the transfer
    // that figure completes then refuse ANOTHER line? Then the figure is not a
    // way out, and the row says so (two-short: MANGO's 5.158 kg over WHOLE
    // DHANIYA recorded on an empty shelf).
    let g = f;
    if (f.party && f.party.headroomLine > 0) {
      const at = forecastCentralHolds(req, [{ line, qty: f.party.headroomLine }]);
      const others = at.party?.refused ? at.party.short.filter(x => x.line.id !== line.id) : [];
      if (others.length > 0) g = { ...f, party: { ...f.party, capBlockedBy: others.map(x => x.line.material_name) } };
    }
    return sharedWith > 0 ? { ...g, sharedWith } : g;
  };
  /* WHAT THE ROW'S OWN BUTTON WILL TAKE (round 8) — the same lone-row score as
     rowHold, read for the take instead of the hold: desk-rule.ts
     forecastDeskTake via forecastCentralHolds. Only a take the shelf rule
     CHANGES is ever printed (the line records what left the shelf, and may
     close by THE RULE's shelf arm); an ordinary take is the typed figure and
     the row renders exactly as before. */
  /* …and the party transfer that same gesture runs (final pass): whether it
     leaves every line complete, and the lines it lowers and reopens
     (CentralBatchForecast `party`), so the row never says "completes the
     requisition" over a transfer that reopens another line. */
  const rowTakeFc = (line: ReqLine): CentralBatchForecast | undefined => {
    if (line.is_rejected || line.store_rejected) return undefined;
    if (isRoutedLine(line)) return undefined;
    const outstanding = lineSplit(line).outstanding;
    if (!(outstanding > 0)) return undefined;
    const sq = props.splitIssueQty[line.id]?.qty;
    const split = !!props.editDefer[line.id] && Number.isFinite(sq) && sq > 0;
    const qty = split ? sq : props.resolveQty(line, outstanding).qty;
    return forecastCentralHolds(req, [{ line, qty }], split ? new Set([line.id]) : undefined);
  };
  const partialText = partialSummary(req);
  const statusTone: Record<string, string> = {
    mgmt_approved:   'bg-amber-100 text-amber-800 border-amber-200',
    chef_approved:   'bg-amber-100 text-amber-800 border-amber-200',
    store_processed: 'bg-blue-100 text-blue-800 border-blue-200',
    fulfilled:       'bg-emerald-100 text-emerald-800 border-emerald-200',
  };
  /* THE STATUS CHIP, in delivery words rather than workflow words. DISPLAY
     ONLY: no new status is written, requisitions.status is still the single
     scalar the route sets, and deliveryState() returns null for everything that
     is not 'fulfilled' — those fall straight through to the map above and read
     exactly as they always have. Only a finished requisition that actually had
     something REJECTED gets a different word, and today there are none in the
     database (see deliveryState). The emerald tone is kept for 'full' and
     dropped for the other two, because emerald is the colour this page uses for
     "the goods are there". */
  const delivered = deliveryState(req);
  const doneLabel = delivered === 'short' ? 'Closed short'
                  : delivered === 'none'  ? 'Closed'
                  : null;
  /* THE PARTY CAVEAT. On a party requisition the store-issue route deliberately
     keeps the OLD reject behaviour and zeroes quantity_issued (its party rail
     moves stock through applyPartyFulfillment, which this screen does not
     unwind) — so a party line that handed 200 of 240 over and was then rejected
     is RECORDED as 0 issued. deliveryState reads that record faithfully and
     says 'none'. The record is what it is and this page does not argue with it,
     but the sentence must not turn a gap in the record into the flat assertion
     "nothing was handed over": on a party requisition that may be false, and it
     is the storekeeper's own hand-over it would be denying. So the party card
     says what is actually knowable and points at the screen that knows. The
     route's zeroing is a separate, documented owner decision and is untouched
     here. */
  const isPartyReq = req.purpose === 'party';
  const doneTitle = delivered === 'short'
    ? 'Nothing is still waiting on the store, but part of this requisition was '
      + 'rejected: some goods went out and the rest was cancelled.'
    : delivered === 'none'
      ? (isPartyReq
          ? 'Closed — every line was rejected, and nothing is recorded as issued. '
            + 'On a PARTY requisition a rejection also clears the issued quantity, so '
            + 'anything physically handed over before it will not show here — check the '
            + 'department reconcile screen.'
          : 'Closed with nothing handed over — every line was rejected.')
      : undefined;
  /* KITCHEN SENT FIRST (ruling #45). A routed line's Send moves the
     requisition to store_processed WITHOUT the store's stamp, so "Issued
     (partial)" would tell the storekeeper the store had issued part of it. Until
     the store hands anything over (it stamps store_processed_at), the chip says
     whose turn it is: the store's, while a line of its own is still owed;
     otherwise the department still sending. Every other requisition reads as
     before. */
  const kitchenFirst = req.status === 'store_processed' && !req.store_processed_at
    && (req.lines_routed_owing || 0) + (req.lines_routed_done || 0) > 0
    && (req.lines_issued_any || 0) === 0 && (req.lines_rejected_kept || 0) === 0;
  const kitchenFirstLabel = !kitchenFirst ? null
    : (req.lines_open || 0) + (req.lines_deferred || 0) > 0 ? 'With Store'
    : (req.lines_routed_owing || 0) > 0 ? withDeptLabel(req.routed_depts) : null;
  const kitchenFirstTitle = kitchenFirstLabel
    ? `${req.routed_depts.join(', ') || 'Another department'} has sent part of this requisition by department transfer; the store has not handed anything over on it yet.`
    : undefined;
  const doneTone = delivered === 'short' ? 'bg-amber-100 text-amber-900 border-amber-300'
                 : delivered === 'none'  ? 'bg-red-100 text-red-800 border-red-300'
                 : null;
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
      <button onClick={onToggle}
              className="w-full px-4 py-3 flex items-center gap-3 hover:bg-[#FFF1E3]/40 text-left">
        {expanded ? <ChevronDown className="w-4 h-4 text-[#8B7355]" /> : <ChevronRight className="w-4 h-4 text-[#8B7355]" />}
        <div className="flex-1 min-w-0">
          <div className="font-mono text-sm font-semibold text-[#2D1B0E] flex items-center gap-2">
            {/* Purpose badge — tells the store user immediately whether this is
                a kitchen restock or a party-specific issue. Party events have
                hard deadlines, so this visual distinction matters. */}
            {req.purpose === 'party' ? (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-pink-100 text-pink-800 border border-pink-200 font-semibold">PARTY</span>
            ) : (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#FFF1E3] text-[#6B5744] border border-[#D4B896] font-semibold">INTERNAL</span>
            )}
            {req.req_number}
          </div>
          <div className="text-[11px] text-[#8B7355] flex flex-wrap gap-x-3">
            <span>Dept: <b className="text-[#6B5744]">{req.department_name}</b></span>
            {req.event_name && <span>Event: <b className="text-[#6B5744]">{req.event_name}</b></span>}
            {req.purpose === 'party' && req.event_date && (
              <span className="text-pink-700">Date: <b>{req.event_date}</b></span>
            )}
            <span>By: {req.drafted_by}</span>
            <span>Approved: {fmtDateTime(req.mgmt_approved_at || req.chef_approved_at)}</span>
          </div>
        </div>
        {/* flex-wrap because this row now carries up to six chips — the store's
            tablet was squeezing the requisition number to make them all fit on
            one line. */}
        <div className="flex flex-wrap justify-end items-center gap-2 text-[11px]">
          {req.lines_issued > 0 && <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">{req.lines_issued} issued</span>}
          {req.lines_deferred > 0 && <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">{req.lines_deferred} deferred</span>}
          {req.lines_open > 0 && <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">{req.lines_open} open</span>}
          {/* ROUTED (ruling #45) — lines another department sends by department
              transfer, kept out of the store's counts above. */}
          {req.lines_routed_owing > 0 && (
            <span title={`Direct Issue sends these items straight to ${req.routed_depts.join(', ') || 'another department'}, so the central store never holds them: that department sends them from its own stock (its To send list on Department Transfers). Not issued from here.`}
                  className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-800 border border-indigo-200">
              {req.lines_routed_owing} {withDeptLabel(req.routed_depts).replace(/^With/, 'with')}
            </span>
          )}
          {req.lines_routed_done > 0 && (
            <span title="Sent in full by department transfer — not issued from the store"
                  className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
              {req.lines_routed_done} sent by {req.routed_depts.length === 1 ? req.routed_depts[0] : 'department transfer'}
            </span>
          )}
          {/* Lines that DID hand goods over but are not counted in "N issued" —
              part-issued, or fully issued with a promise still parked on them.
              The three counters above partition each line into one bucket, so
              without this the 2 kg that left the counter on a deferred line is
              nowhere on the card. Purely additive: it reads lines_issued_any and
              changes none of them. */}
          {/* MINUS lines_rejected_kept. lines_issued_any now sees a rejected
              line's kept hand-over (it has to — that is the whole Option-A
              fix), but this chip promises the goods are STILL OWED and a
              rejected line owes nothing. It gets its own chip below instead of
              silently inflating this one. */}
          {req.lines_issued_any - req.lines_rejected_kept > req.lines_issued && (
            <span title="Goods went out on these lines, but they are still owed (part-issued, or deferred with a promised time)"
                  className="px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200">
              {req.lines_issued_any - req.lines_rejected_kept - req.lines_issued} sent, not closed
            </span>
          )}
          {/* Lines the store rejected AFTER handing part of them over. Goods
              left the counter, the balance was cancelled, the line is closed —
              a state that did not exist before the Option-A reject and that
              every other chip on this card would otherwise be silent about. */}
          {/* lines_rejected_cut, NOT lines_rejected_kept: a line the store
              rejected AFTER issuing it in full cancelled nothing, and saying
              "sent, then cancelled" at it would invent a shortfall. It is still
              subtracted from the violet chip above (it owes nothing either), so
              it simply shows no chip — the row's own STORE REJECTED line says
              what happened. */}
          {req.lines_rejected_cut > 0 && (
            <span title="Part of these lines was handed over before the store rejected the balance — the goods that went out stand, the remainder is cancelled"
                  className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-900 border border-amber-300">
              {req.lines_rejected_cut} sent, then cancelled
            </span>
          )}
          {/* What actually went out, in the store's own units. The card used to
              print the raw column value ("store_processed") at the person
              holding the goods and say nothing about the shortfall. */}
          {partialText && (
            <span className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">{partialText}</span>
          )}
          <span title={doneTitle || kitchenFirstTitle}
                className={`px-2 py-0.5 rounded border ${doneTone || (kitchenFirstLabel ? statusTone.mgmt_approved : statusTone[req.status]) || 'bg-gray-50 text-gray-700 border-gray-200'}`}>
            {doneLabel || kitchenFirstLabel || STATUS_LABEL[req.status] || req.status}
          </span>
        </div>
      </button>

      {/* Issue All Items — one-click bulk issue of every open (non-rejected,
          non-deferred, remaining>0) line. Only on the Pending Issue tab, and
          only when at least one such line exists. Clicking opens a confirmation
          modal (handled by the page) before anything is POSTed. */}
      {props.showIssueAll && openIssuableLines(req).length > 0 && !forecastBlocks(allForecast) && (
        <div className="px-4 py-2 border-t border-[#E8D5C4] bg-[#FFF8F0] flex items-center justify-between gap-2">
          <span className="text-[11px] text-[#8B7355]">
            {openIssuableLines(req).length} open item{openIssuableLines(req).length > 1 ? 's' : ''} ready to hand over.
          </span>
          <button onClick={props.onIssueAll}
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium flex items-center gap-1.5">
            <Send className="w-3.5 h-3.5" /> Issue All Items
          </button>
        </div>
      )}
      {/* THE SAME BAR WHEN THE CENTRAL STORE CANNOT COVER EVERY LINE. A separate
          branch, not a conditional inside the one above, so a fully-coverable
          card renders byte-for-byte as it always has. "N open items ready to
          hand over" stops counting a line the server will hold — it is open, it
          is not ready — and the banner says before the click what the alert
          says after it. Shown on the bar, not inside the rows, because the bar
          is visible on a COLLAPSED card, which is where Issue All is pressed. */}
      {props.showIssueAll && openIssuableLines(req).length > 0 && forecastBlocks(allForecast) && (() => {
        const n = openLines.length;
        // Neither a held line nor one typed to 0 is going out: the route holds
        // the first and skips the second (forecastCentralHolds `idle`). On a
        // party refusal nothing goes out at all.
        const ready = allForecast.party?.refused ? 0
          : n - allForecast.held.length - allForecast.idle.length;
        return (
          <div className="px-4 py-2 border-t border-[#E8D5C4] bg-[#FFF8F0] space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-[#8B7355]">
                {ready} of {n} open item{n > 1 ? 's' : ''} ready to hand over.
              </span>
              <button onClick={props.onIssueAll}
                      className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium flex items-center gap-1.5">
                <Send className="w-3.5 h-3.5" /> Issue All Items
              </button>
            </div>
            <CentralHoldBanner forecast={allForecast} gesture="Issue All" scope="open line" />
          </div>
        );
      })()}

      {/* Issue Selected — appears when the card is expanded, selection is
          enabled (Pending Issue tab) and at least one open line is checked.
          Issues ONLY the checked lines (each at its remaining qty) in one POST. */}
      {props.selectable && expanded && selectedCount > 0 && (
        <div className="px-4 py-2 border-t border-[#E8D5C4] bg-emerald-50/60 flex items-center justify-between gap-2">
          <span className="text-[11px] text-emerald-800">
            {selectedCount} item{selectedCount > 1 ? 's' : ''} selected.
          </span>
          <div className="flex items-center gap-2">
            <button onClick={props.onToggleSelectAll}
                    className="text-[11px] text-[#8B7355] hover:underline">
              {allOpenSelected ? 'Clear selection' : 'Select all open'}
            </button>
            <button onClick={props.onIssueSelected} disabled={props.issuingSelected}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 disabled:opacity-50">
              {props.issuingSelected ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Issue Selected
            </button>
          </div>
        </div>
      )}
      {/* Issue Selected is the other multi-line gesture, so it gets the same
          advance warning, scored on the checked lines only. Its own row below
          the bar (nothing renders when every checked line is covered), so the
          bar above is unchanged markup. */}
      {props.selectable && expanded && selectedCount > 0 && forecastBlocks(selForecast) && (
        <div className="px-4 pb-2 bg-emerald-50/60">
          <CentralHoldBanner forecast={selForecast} gesture="Issue Selected" scope="selected line" />
        </div>
      )}
      {/* The transfer Issue Selected runs reopens another party line (final pass). */}
      {props.selectable && expanded && selectedCount > 0 && !forecastBlocks(selForecast)
        && partyLeftOpenSentence(selForecast.party) !== '' && (
        <div className="px-4 pb-2 bg-emerald-50/60">
          <PartyLeftOpenNote party={selForecast.party} gesture="Issue Selected" />
        </div>
      )}

      {expanded && (
        <div className="border-t border-[#E8D5C4] overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-[#FFF1E3] text-[#6B5744]">
              <tr>
                {props.selectable && (
                  <th className="py-1.5 px-2 w-8 text-center">
                    <input type="checkbox"
                           aria-label="Select all open lines"
                           title="Select all open lines"
                           checked={allOpenSelected}
                           ref={el => { if (el) el.indeterminate = someOpenSelected; }}
                           disabled={openIds.length === 0}
                           onChange={props.onToggleSelectAll}
                           className="align-middle accent-emerald-600" />
                  </th>
                )}
                <th className="text-left  py-1.5 px-2 font-medium">Material</th>
                {/* All four quantity columns read in the PURCHASE unit (BTL / kg /
                    PKT), with the recipe equivalent as the small grey hint under
                    packed materials. This tooltip used to say "recipe unit", which
                    is exactly how the store was reading the numbers. */}
                <th className="text-right py-1.5 px-2 font-medium" title="Quantity requested, in the PURCHASE unit (BTL / kg / PKT / pcs). The small grey line is the recipe equivalent.">Requested</th>
                {/* "In store", NOT "In hand". Under department-based inventory a
                    gram leaves central the moment it is issued, so this number is
                    the CENTRAL STORE's shelf and nothing else — goods already
                    handed to a kitchen are gone from it even though they are
                    still in the building. "In hand" read as "what the company
                    has", which is now a different and larger number. Kept to two
                    short words so the row still fits a tablet without the table
                    going into horizontal scroll. */}
                <th className="text-right py-1.5 px-2 font-medium whitespace-nowrap" title="What the central store holds. Goods already issued to a kitchen are not counted here. Shown in the PURCHASE unit. Red = nothing, or less than this line still needs. Amber = enough, but the store hits its reorder point once it goes out. Green = enough to spare.">In store</th>
                <th className="text-right py-1.5 px-2 font-medium" title="HOD-approved quantity, in the PURCHASE unit (overrides requested if set)">HOD OK</th>
                <th className="text-right py-1.5 px-2 font-medium" title="Handed over so far, in the PURCHASE unit">Issued so far</th>
                <th className="text-right py-1.5 px-2 font-medium" title="Still owed, in the PURCHASE unit">Outstanding</th>
                <th className="text-left  py-1.5 px-2 font-medium">Last issue</th>
                <th className="text-left  py-1.5 px-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {/* CATEGORY-WISE, so a store person walks one shelf at a time instead
                  of criss-crossing the room down a flat alphabetical list.
                  Categories A-Z, items A-Z inside each. Deliberately NOT
                  collapsible: everything on a hand-over sheet must be visible at
                  a glance, and a collapsed group is a line quietly not issued.
                  Items with no category fall into "Uncategorised", pinned LAST so
                  a blank never sorts above a real shelf. Grouping is presentation
                  only — the selection, bulk-issue and totals all still read
                  req.items, so nothing downstream sees a different set. */}
              {(() => {
                const groups = new Map<string, typeof req.items>();
                for (const line of req.items) {
                  const key = String((line as any).material_category || '').trim() || 'Uncategorised';
                  if (!groups.has(key)) groups.set(key, [] as typeof req.items);
                  groups.get(key)!.push(line);
                }
                const names = [...groups.keys()].sort((a, b) => {
                  if (a === 'Uncategorised') return 1;
                  if (b === 'Uncategorised') return -1;
                  return a.localeCompare(b, undefined, { sensitivity: 'base' });
                });
                return names.map(name => (
                  <Fragment key={`cat-${name}`}>
                    <tr className="bg-[#FFF1E3] border-t border-[#E8D5C4]">
                      <td colSpan={9} className="py-1 px-2 text-[10px] font-semibold uppercase tracking-wide text-[#8B7355]">
                        {name}
                        <span className="ml-1.5 font-normal normal-case">
                          ({groups.get(name)!.length} item{groups.get(name)!.length === 1 ? '' : 's'})
                        </span>
                      </td>
                    </tr>
                    {groups.get(name)!
                      .slice()
                      .sort((x, y) => String(x.material_name || '').localeCompare(String(y.material_name || ''), undefined, { sensitivity: 'base' }))
                      .map(line => { const takeFc = rowTakeFc(line); return (
                <LineRow key={line.id} line={line} req={req}
                         selectable={props.selectable}
                         selected={props.selectedIds.has(line.id)}
                         onToggleSelect={() => props.onToggleLineSelect(line.id)}
                         busy={props.busyLine === line.id}
                         editQty={props.editQty} setEditQty={props.setEditQty}
                         issueNotes={props.issueNotes} setIssueNotes={props.setIssueNotes}
                         editDefer={props.editDefer} setEditDefer={props.setEditDefer}
                         splitIssueQty={props.splitIssueQty} setSplitIssueQty={props.setSplitIssueQty}
                         onBeginIssueDeferRest={props.onBeginIssueDeferRest}
                         onIssueDeferRest={props.onIssueDeferRest}
                         onIssue={props.onIssue} onDefer={props.onDefer}
                         blocked={props.blockedReversals[line.id]}
                         /* Not on a line that is done (round 10, heldPanelSettled) —
                            the load also drops it; this keeps the render true in between. */
                         short={props.centralShort[line.id] && !heldPanelSettled(req, line) ? props.centralShort[line.id] : undefined}
                         refusedReversal={props.reversalShort[line.id]?.reqId === req.id ? props.reversalShort[line.id] : undefined}
                         partyShort={props.partyShort[line.id]?.reqId === req.id ? props.partyShort[line.id] : undefined}
                         centralHold={rowHold(line)}
                         centralTake={takeFc?.takes[line.id]}
                         centralParty={takeFc?.party}
                         onUndo={props.onUndo} onReject={props.onReject} onUnreject={props.onUnreject}
                         onShowHistory={props.onShowHistory}
                         canMerge={props.canMerge} onAddToMergedPo={props.onAddToMergedPo} />
                    ); })}
                  </Fragment>
                ));
              })()}
            </tbody>
          </table>
          {req.store_processed_by && (
            <div className="px-4 py-2 text-[11px] text-[#8B7355] bg-[#FFF8F0] border-t border-[#E8D5C4]">
              First touched by <b className="text-[#6B5744]">{req.store_processed_by}</b> at {fmtDateTime(req.store_processed_at)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LineRow(props: {
  line: ReqLine; req: Requisition; busy: boolean;
  // Feature 3 — per-line selection checkbox (only meaningful on open lines).
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  editQty: Record<string, string>; setEditQty: (f: any) => void;
  issueNotes: Record<string, string>; setIssueNotes: (f: any) => void;
  editDefer: Record<string, { until: string; reason: string }>;
  setEditDefer: (f: any) => void;
  // "Issue N, defer the rest". A key in splitIssueQty for this line means the
  // defer panel below is showing the COMBINED action, not a plain defer.
  splitIssueQty: Record<string, { qty: number; token: string }>;
  setSplitIssueQty: (f: any) => void;
  onBeginIssueDeferRest: (line: ReqLine) => void;
  onIssueDeferRest: (line: ReqLine) => void;
  onIssue: (line: ReqLine, qty?: number, expect?: number) => void;
  onDefer: (line: ReqLine) => void;
  /** Set when the server refused a reversal on THIS line. */
  blocked?: BlockedReversal;
  /** Set when the central floor refused an ISSUE on THIS line. */
  short?: CentralShort;
  /** Set when the central floor refused THIS line's Reject / Undo (round 10). */
  refusedReversal?: ReversalShort;
  /** Set when another gesture's party transfer lowered and reopened THIS line. */
  partyShort?: PartyShortNote;
  /** The party transfer this row's own button runs (ReqCard rowTakeFc): whether
   *  it fulfils the requisition and the lines it leaves open. */
  centralParty?: CentralBatchForecast['party'];
  /** Set when the central floor WILL refuse the quantity this row's own Issue
   *  button is about to send — the forecast, before the click. */
  centralHold?: CentralHoldForecast;
  /** What this row's own button will TAKE off the central shelf and record —
   *  set by ReqCard (rowTake) for the quantity the button sends (the captured
   *  hand-over in split mode). Read only where `changed` / `emptied`. */
  centralTake?: DeskTakeForecast;
  onUndo: (line: ReqLine) => void;
  onReject: (line: ReqLine) => void;
  onUnreject: (line: ReqLine) => void;
  onShowHistory: (line: ReqLine) => void;
  canMerge?: boolean;
  onAddToMergedPo?: (line: ReqLine) => void;
}) {
  const { line, busy } = props;
  const eff = effectiveQty(line);
  const issued = Number(line.quantity_issued) || 0;
  // The same three numbers as above, named — split.effective / .issued are
  // identical to eff / issued by construction; what it adds is WHICH BUCKET the
  // remainder sits in, including the bucket a rejection puts it in.
  const split = lineSplit(line);
  // split.outstanding, NOT (eff − issued). On a store-rejected line the reject
  // cancelled the balance, so this row owes 0 — printing the leftover 40 under
  // a column headed "Still owed" is the same lie the parent badge was telling.
  // Every other reader of `outstanding` below sits inside the not-rejected
  // branch (the issue box, the over-issue maths, the action buttons) or already
  // excludes rejected lines by name (isCheckable, rowTone), so this changes the
  // rejected row and nothing else.
  const outstanding = split.outstanding;
  // Everything reads in PURCHASE units (owner rule) — the store hands over
  // bottles/kg, not ml/g — regardless of which unit the composer stored the
  // line in. `hint` carries the recipe equivalent for packed materials.
  const U = lineUnits(line);
  const u = U.pu;
  const unitTag = u ? <span className="text-[9px] text-[#8B7355] ml-0.5">{u}</span> : null;
  // Suppressed at q = 0: "= 0 ml" under a "0 BTL" says nothing, and it used to
  // appear on every fully-issued row's Outstanding cell. Gate on the STORED qty,
  // not the 3-dp purchase figure — a 0.25 ml residue shows "<0.001 BTL" up top
  // and its hint is the only place the real remainder is legible.
  // On an UNPACKED material (pack 1, kg / kg) there is no recipe figure to
  // add — except when 3 dp hides the stored one (round 8b): the shelf rule
  // records WHOLE DHANIYA 3.2174 kg and WHITE DAL 5.0005 kg, which this row
  // printed as "Issued so far 3.217 kg" and "5.001 kg" while the forecasts
  // said the exact figure (round-8 verifier). fmtTakeHint prints it only then.
  const hint = (q: number) => {
    const h = (Number(q) || 0) > 0 ? fmtTakeHint(U, U.toRecipe(q)) : '';
    return h ? <div className="text-[9px] text-[#B8A590] font-normal">{h}</div> : null;
  };
  const outstandingPU = U.toPU(outstanding);
  // A remainder smaller than the 3-dp display (e.g. 0.25 ml of a 750 ml bottle)
  // would print a flat "0" on a line the card still counts as OPEN. Say "<0.001"
  // instead, so the row never claims to be finished when it isn't.
  // A PURCHASE-basis line's figure is not rounded by toPU, so a sub-step crumb
  // reached fmtNum raw and printed "0" — "Issued so far 0 kg = 0.4 g" after the
  // held panel's "Issue 0.0004 kg", and "0.001 kg" for 0.6 g still owed
  // (round 9, sd_internal_crumb). Printed at the precision that names it, the
  // held panel's own fmtCapPU; every figure of 0.001 or more is unchanged.
  const puNum = (v: number, raw: number) =>
    v === 0 && raw > 0 ? '<0.001' : v > 0 && v < 0.001 ? fmtCapPU(v, U.pf) : fmtNum(v);
  const fmtFinePU = (q: number) => fmtHandOverPU(U, q);
  // What the party transfer already moved for this line (partyMovedOf) — read
  // by the rejected-line and moved-over-recorded notes below.
  const isPartyLine = props.req.purpose === 'party';
  const partyMoved = isPartyLine ? partyMovedOf(props.req, line) : null;
  const partyMovedHere = partyMoved ? partyMoved.movedLine + (partyMoved.first ? partyMoved.excessLine : 0) : 0;
  /* OVER-ISSUE — the store handed over more than the HOD approved. It is a real
     thing (a bag is a bag), so it is recorded as what actually left, not capped
     to the approval; it just has to be deliberate and explained. Compared in the
     PURCHASE basis the box is typed in. */
  const typedPU = Number(props.editQty[line.id]);
  // Only meaningful while the line is still open — on a completed line
  // outstanding is 0, so any leftover text in the box read as an "over-issue".
  const overIssue = outstanding > 0 && Number.isFinite(typedPU) && typedPU - outstandingPU > 1e-9;
  const overBy = overIssue ? Math.round((typedPU - outstandingPU) * 1000) / 1000 : 0;
  const rowTone = line.is_rejected ? 'bg-red-50/40 text-[#999] line-through'
                : line.store_rejected ? 'bg-red-50/40 text-[#999]'
                : outstanding === 0 && !line.deferred_until ? 'bg-emerald-50/30'
                : line.deferred_until ? 'bg-blue-50/30' : '';
  // A split capture its line no longer owes more than (round 10,
  // splitCaptureStale) is not an open editor: the load drops it, and until
  // then the row reads as the line now is rather than "Handing over 0.001 kg
  // now, the balance 0 kg is promised for" over a finished line.
  const capturedSplit = props.splitIssueQty[line.id];
  const deferOpen = !!props.editDefer[line.id] && !(capturedSplit && splitCaptureStale(line, Number(capturedSplit.qty)));
  /* "Issue N, defer the rest" — two derived states.
     `splitQty` is the hand-over quantity already captured (in the LINE's stored
     unit), which is what turns the defer panel below into the combined action.
     `typedIsPartial` drives the button's live label BEFORE that: it is true only
     while the box holds a genuine PART of what is still owed, so the button can
     say the actual numbers instead of a generic promise. */
  const splitQty = props.splitIssueQty[line.id]?.qty;
  const splitMode = deferOpen && Number.isFinite(splitQty) && splitQty > 0;
  const splitRest = splitMode ? Math.max(0, outstanding - splitQty) : 0;
  const typedIsPartial = Number.isFinite(typedPU) && typedPU > 0 && outstandingPU - typedPU > 1e-9;
  /* WHAT THE TAKE WILL DO (round 8). The split panel and the split button used
     to forecast the hand-over with their own subtraction — "Handing over 14.842
     kg now, the balance 0.001 kg is promised for" — over a 14,842.4 g shelf,
     where the server's shelf rule takes all 14,842.4 g, records 14.8424 and the
     0.6 g left is below one printed step: THE RULE closes the line and the
     defer is dropped. Both figures were false. Now both ask the server's own
     arithmetic (desk-rule.ts forecastDeskTake) and print from it ONLY when the
     take is not the typed figure or empties the shelf; every other gesture
     renders exactly as before. `splitTake` is the captured hand-over (ReqCard
     scores the row with it), `typedTake` the figure in the box before the
     split is opened (beginIssueAndDeferRest posts U.fromPU of it). */
  // Printed only when the take is NOT the typed figure (`changed`) or THE RULE
  // closes the line by the shelf (`byShelf` — the defer will be dropped). A
  // hand-over that is exactly the typed figure — even one that happens to empty
  // the shelf — keeps the original words, byte for byte.
  // A PARTY take is the transfer (round 8b): it moves the line's whole
  // quantity, so on a line issued before it is never "the typed figure" and is
  // always said.
  const saysTake = (tk: DeskTakeForecast | null | undefined): tk is DeskTakeForecast =>
    !!tk && (tk.changed || tk.byShelf || (tk.rail === 'party' && issued > 0));
  const splitTake = splitMode && saysTake(props.centralTake) ? props.centralTake! : null;
  const typedTake = (() => {
    if (!typedIsPartial || deferOpen) return null;
    const tk = props.req.purpose === 'party'
      ? forecastCentralHolds(props.req, [{ line, qty: U.fromPU(typedPU) }], new Set([line.id])).takes[line.id]
      : forecastDeskTake({ line, purpose: props.req.purpose, approved: eff, deltaLine: U.fromPU(typedPU) });
    return saysTake(tk) ? tk : null;
  })();
  // A line is selectable only when it's an open issuable line: not rejected by
  // chef or store, not deferred, and with a positive outstanding qty. Matches
  // openIssuableLines() so header select-all and per-line boxes stay in sync.
  // DELIVERED DIRECT (ruling #68): the line's merged PO was received through a
  // Direct Issue rule, so the goods went straight to the rule's department and
  // the central store never held them. Not checkable, not in Issue All
  // (openIssuableLines), and its issue controls are replaced by the reason.
  const direct = isDeliveredDirect(line);
  // ROUTED (ruling #45): another department sends this line by department
  // transfer, so it has no issue / defer / undo here and no checkbox — the
  // server's sentence stands where the buttons were. Reject (and Un-reject)
  // stay: a rejection closes the rest of the line, keeping what was sent.
  const routed = routedLineOf(line);
  const routedDept = routedDeptWord(routed);
  const isCheckable = !line.is_rejected && !line.store_rejected && !line.deferred_until && outstanding > 0 && !direct && !routed;
  // "Add to a merged PO" — offered on a deferred line that is still owed and
  // is not already held by an open PO (the merge would refuse it). A vendor
  // closed without delivering frees the line, so it is offered again.
  const canAddToMerge = !!props.canMerge && !!props.onAddToMergedPo && !line.is_rejected && !line.store_rejected
    && outstanding > 0 && !direct && !routed && (!onOpenPo(line) || isVendorClosed(line));
  const hasMergeBadge = hasMergeState(line);
  return (
    <tr className={`border-t border-[#E8D5C4]/50 ${rowTone}`}>
      {props.selectable && (
        <td className="py-1.5 px-2 align-top text-center">
          {isCheckable ? (
            <input type="checkbox"
                   aria-label={`Select ${line.material_name}`}
                   checked={!!props.selected}
                   onChange={props.onToggleSelect}
                   className="align-middle accent-emerald-600" />
          ) : null}
        </td>
      )}
      <td className="py-1.5 px-2 align-top">
        <div className="font-medium text-[#2D1B0E] flex items-center gap-1.5">
          {line.material_name}
          {/* A delivered-direct line the store closed was not refused — the
              vendor delivered it, to the Direct Issue rule's department — so it
              is never labelled a rejection (ruling #68). */}
          {routed && (
            <span title={`Direct Issue routes this item to ${routedDept}; it is sent by department transfer, never issued from the central store`}
                  className="text-[8px] px-1 py-0.5 rounded bg-indigo-100 text-indigo-800 border border-indigo-300 font-semibold no-underline">
              ROUTED · {routedDept.toUpperCase()}
            </span>
          )}
          {line.store_rejected ? (direct ? (
            <span className="text-[8px] px-1 py-0.5 rounded bg-violet-100 text-violet-800 border border-violet-300 font-semibold no-underline">
              CLOSED — DELIVERED DIRECT
            </span>
          ) : (
            <span className="text-[8px] px-1 py-0.5 rounded bg-red-100 text-red-700 border border-red-300 font-semibold no-underline">
              STORE REJECTED
            </span>
          )) : null}
        </div>
        {/* MERGED PO — where this line stands on its PO, one badge, the most
            decisive first: delivered direct > vendor closed > arrived > on PO.
            Absent on every line no PO has touched. */}
        {hasMergeBadge && (
          <div className="mt-0.5">
            <MergeLineBadge line={line} pu={u} at={(iso) => fmtISTDate(iso)} />
          </div>
        )}
        {line.store_rejected ? (
          <div className={`text-[10px] ${direct ? 'text-violet-800' : 'text-red-700'} mt-0.5 flex flex-wrap items-center gap-1 no-underline`}>
            <XCircle className="w-3 h-3" /> {direct
              ? <>{(line as any).delivered_direct_closed_by === 'system' ? 'Closed automatically' : 'Closed by store'} — delivered direct{deliveredDirectDept(line) ? <> to {deliveredDirectDept(line)}</> : null}, not issued from central</>
              : 'Rejected by store'}
            {line.store_reject_reason && <span className="text-[#6B5744]">— {line.store_reject_reason}</span>}
            {/* WHAT THE REJECT ACTUALLY DID, when it did two things. Under the
                Option-A reject a rejection cancels the OUTSTANDING balance and
                leaves what was physically handed over standing, so "Rejected by
                store" on its own reads as "you got nothing" on a line where 200
                of 240 eggs are in the kitchen. Both halves are named, in the
                purchase unit the rest of the row uses. Silent on a line that
                issued nothing — there the old sentence was already complete. */}
            {split.issued > 0 && (
              <span className="text-[#6B5744]">
                {/* fmtFinePU (round 10): a crumb hand-over read "0 kg already
                    handed over stands" — the prompt that confirmed it said 0.0004 kg.
                    fmtQtyExact (final pass): beside a crumb, "· 2 kg cancelled"
                    sat over "Cancelled 2 kg = 1,999.6 g" — each figure now carries
                    its exact one wherever 3 dp hides it. */}
                · <b className="text-emerald-700">{fmtQtyExact(U, split.issued)}</b> already handed over stands
                {split.cancelled > 0 && <> · <b>{fmtQtyExact(U, split.cancelled)}</b> cancelled</>}
              </span>
            )}
            {/* A PARTY REJECTION KEEPS THE GOODS, NOT THE RECORD (final pass).
                The route's party carve-out zeroes quantity_issued, so this row
                reads "Cancelled" for the whole line, while what the party
                transfer had already moved stays with the department. Said, so
                the row is not read as "nothing went". */}
            {isPartyLine && partyMoved && partyMovedHere > 1e-9 && (
              <span className="text-[#6B5744]">
                · <b className="text-emerald-700">{fmtQtyExact(U, partyMovedHere)}</b> of it had already left the store in the
                party transfer and stays with the department — a store rejection on a party requisition clears the line&apos;s
                record, not the goods
              </span>
            )}
          </div>
        ) : null}
        {/* MOVED MORE THAN THE LINE RECORDS (final pass) — a party undo zeroes
            quantity_issued and moves no stock, so after one the row reads 0
            issued while the goods the transfer moved are with the department.
            The next transfer moves only what the line records above that. */}
        {isPartyLine && !line.store_rejected && !line.is_rejected && partyMoved && partyMoved.first
          && partyMoved.excessLine > 1e-9 && (
          <div className="text-[10px] text-amber-800 mt-0.5">
            <b>{fmtQtyExact(U, partyMoved.movedLine + partyMoved.excessLine)}</b> of this item already left the store for
            this requisition in the party transfer — {partyMoved.movedLine > 1e-9
              ? <>{fmtQtyExact(U, partyMoved.excessLine)} more than this line now records</>
              : <>while this line now records none of it</>}.
            Those goods stay with the department, and a later transfer moves only what this line records above{' '}
            {fmtQtyExact(U, partyMoved.movedLine + partyMoved.excessLine)}.
          </div>
        )}
        {line.chef_note && <div className="text-[9px] text-amber-700">Chef: {line.chef_note}</div>}
        {line.notes && <div className="text-[9px] text-[#8B7355]">Note: {line.notes}</div>}
        {line.deferred_until && (() => {
          const due = deferDueStatus(line.deferred_until);
          return (
            <div className="mt-0.5 space-y-0.5">
              <div className="text-[10px] text-blue-700 flex items-center gap-1 flex-wrap">
                <Clock className="w-3 h-3" /> Deferred until {fmtDateTime(line.deferred_until)}
                {line.defer_reason && <span className="text-[#6B5744]">— {line.defer_reason}</span>}
                {/* Feature 4 — due-soon / overdue chip. Amber when the promised
                    time is within 4h, red once it's past. Draws the store
                    manager's eye to lines that need action now. */}
                {due.soon && !due.overdue && (
                  <span className="px-1 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 font-semibold">
                    due in {due.hours}h
                  </span>
                )}
                {due.overdue && (
                  <span className="px-1 py-0.5 rounded bg-red-100 text-red-700 border border-red-300 font-semibold">
                    overdue
                  </span>
                )}
              </div>
              {/* ADD TO A MERGED PO (replaces the bare "Raise Vendor PO" link,
                  which carried no item, quantity or requisition and only
                  appeared inside the 4-hour window). Opens the shared merge
                  modal with THIS line ticked — the storekeeper can add the other
                  departments' lines for the same buy there. Store manager +
                  admin only (ruling #65); hidden while the line is already on an
                  open PO, where its badge above says which. */}
              {canAddToMerge && (
                <button type="button" onClick={() => props.onAddToMergedPo!(line)}
                        title="Open Merge into one PO with this line ticked — one draft PO for every department's owed lines, one vendor per item"
                        className="inline-flex items-center gap-1 text-[10px] text-[#af4408] hover:underline font-medium">
                  <Merge className="w-3 h-3" /> Add to a merged PO
                </button>
              )}
            </div>
          );
        })()}
      </td>
      <td className="py-1.5 px-2 text-right font-mono">
        {fmtNum(U.toPU(line.quantity_requested))}{unitTag}
        {hint(line.quantity_requested)}
      </td>
      {/* IN STORE — what the CENTRAL STORE can actually give, read at the moment
          of deciding. Without it the storekeeper approved a hand-over blind and
          found out at the shelf. current_stock is RECIPE units (material-level),
          so it converts with stockPU, never the line-basis toPU.
          This is not "what the company has": issuing moves the gram out of
          central and into the receiving department, so a kitchen's shelf is
          invisible here by design. Do not "helpfully" add department stock into
          this figure — the storekeeper cannot hand over what is already in
          somebody else's fridge. */}
      <td className="py-1.5 px-2 text-right font-mono">
        {(() => {
          // A routed line (ruling #45) is never served from this shelf, so its
          // red / amber / green would answer a question nobody is asking here.
          if (routed) return <span className="text-[#C0A98F]" title={`Not issued from the central store — ${routedDept} sends it`}>—</span>;
          const st = stockLevel(line);
          if (st.qty == null) return <span className="text-[#C0A98F]">—</span>;
          return (
            <span title={st.title}>
              <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle ${st.dot}`} />
              <span className={st.text}>{fmtNum(U.stockPU(st.qty))}{unitTag}</span>
              {U.pf > 1 && (
                <div className="text-[9px] text-[#B8A590] font-normal">= {fmtNum(st.qty)} {U.recipeUnit}</div>
              )}
            </span>
          );
        })()}
      </td>
      <td className="py-1.5 px-2 text-right font-mono">
        {line.is_rejected
          ? <span className="text-red-600">rejected</span>
          : line.chef_approved_qty != null
            ? <>
                <span className="text-amber-700">{fmtNum(U.toPU(line.chef_approved_qty))}{unitTag}</span>
                {hint(line.chef_approved_qty)}
              </>
            : '—'}
      </td>
      {/* Issued so far carries the recipe hint too — without it this cell was the
          odd one out on a row whose other three quantities all showed one. */}
      <td className="py-1.5 px-2 text-right font-mono">
        {puNum(U.toPU(issued), issued)}{unitTag}
        {hint(issued)}
        {/* On a routed line this is what its department SENT (transfers net of
            any send-back), not a store hand-over. */}
        {routed && issued > 0 && <div className="text-[9px] text-indigo-700 font-normal">sent by {routedDept}</div>}
      </td>
      {/* OUTSTANDING, split by who owes what.
          The total stays the lead — the column header and its tooltip promise
          "still owed", and that number is still the answer. Under it, when the
          line has actually been divided, the remainder is named: DEFERRED (a
          human put a time on it) or OPEN (nobody has). Before this the two were
          the same figure, so "2 kg issued, 2 kg promised for 7pm" and "2 kg
          issued, 2 kg nobody has touched" printed identically.
          A line that has moved nothing and carries no promise renders exactly as
          it always did — no extra markup, no second figure. Both parts lead with
          the PURCHASE unit (unitTag = U.pu) and carry the recipe hint. */}
      <td className="py-1.5 px-2 text-right font-mono font-semibold">
        {/* A CANCELLED BALANCE IS NOT A DELIVERED ONE. Zero is the honest figure
            for "still owed" on a rejected line, but printing it in the emerald
            this column uses for "all handed over" would swap one wrong claim
            for another — so a rejected line reads a grey 0 with the written-off
            quantity named under it. */}
        <span className={split.cancelled > 0 ? 'text-[#8B7355]'
                       : outstanding === 0 ? 'text-emerald-700' : 'text-[#af4408]'}>
          {puNum(outstandingPU, outstanding)}{unitTag}
        </span>
        {hint(outstanding)}
        {split.cancelled > 0 && (
          <div className="mt-0.5 font-normal text-[10px] text-red-700"
               title="The store rejected this line — the balance was cancelled, not delivered and not owed">
            Cancelled {puNum(U.toPU(split.cancelled), split.cancelled)}{unitTag}
            {hint(split.cancelled)}
          </div>
        )}
        {(split.isSplit || split.deferred > 0) && (
          <>
            {split.deferred > 0 && (
              <div className="mt-0.5 font-normal text-[10px] text-blue-700">
                Deferred {puNum(U.toPU(split.deferred), split.deferred)}{unitTag}
                {hint(split.deferred)}
              </div>
            )}
            {split.open > 0 && (
              <div className="mt-0.5 font-normal text-[10px] text-[#af4408]">
                Open {puNum(U.toPU(split.open), split.open)}{unitTag}
                {hint(split.open)}
              </div>
            )}
          </>
        )}
      </td>
      <td className="py-1.5 px-2 align-top text-[10px] text-[#6B5744]">
        {line.issued_at ? (
          <>
            <div>{fmtDateTime(line.issued_at)}</div>
            <div className="text-[#8B7355]">by {line.issued_by}</div>
          </>
        ) : '—'}
        {/* PREVIOUS hand-over of this MATERIAL, on some other requisition.
            The line above answers "what happened on this line"; this answers
            "when did this item last leave the store, and how much" — which is
            what tells the storekeeper a department is asking again three days
            early. Quantity is in that PREVIOUS line's own unit (Option B), so
            it is printed with the unit that came with it rather than being
            converted through this row's resolver, which would be a different
            basis. Absent for a material that has never gone out. */}
        {line.mat_last_issue_at && (
          <div className="mt-1 pt-1 border-t border-[#E8D5C4]/60 text-[9px] text-[#8B7355]"
               title="The last time this item was issued on another requisition">
            prev: {fmtDateTime(line.mat_last_issue_at)}
            {Number(line.mat_last_issue_qty) > 0 && (
              <> · {fmtNum(Number(line.mat_last_issue_qty))} {String(line.mat_last_issue_unit || U.recipeUnit)}</>
            )}
            {line.mat_last_issue_dept && <> → {line.mat_last_issue_dept}</>}
          </div>
        )}
        <button onClick={() => props.onShowHistory(line)}
                className="mt-0.5 text-[10px] text-[#af4408] hover:underline inline-flex items-center gap-0.5">
          <History className="w-3 h-3" /> history
        </button>
      </td>
      <td className="py-1.5 px-2 align-top">
        {/* REFUSED REVERSAL — on the line, above whichever action set it applies.
            Rendered OUTSIDE the three action branches on purpose: an undo and a
            store-reject leave the line in different states, and the reason must
            survive whichever one it lands in. It is a panel and not a toast
            because the whole point is the number in it — "the kitchen only has
            1.2 kg left" is unusable three seconds after it fades.
            Everything here reads in the PURCHASE unit via stockPU (material
            basis), never toPU (line basis) — see BlockedReversal. */}
        {props.blocked && (() => {
          const b = props.blocked!;
          const qty = (q: number) => (
            <>
              <b>{fmtNum(U.stockPU(q))}</b>{u ? ` ${u}` : ''}
              {U.pf > 1 ? <span className="text-[9px] opacity-70"> (= {fmtNum(q)} {U.recipeUnit})</span> : null}
            </>
          );
          // Kitchen, not "the kitchen", when the server named one — the
          // storekeeper is often holding a docket for two departments at once.
          const where = b.department || 'that kitchen';
          return (
            // Width is capped in ch-ish terms and stepped UP at md, not down:
            // the store counter runs on a 768-wide tablet, and a 24rem block in
            // the action column is what pushes this table into a sideways
            // scroll on it. The card's own wrapper is overflow-x-auto, so a
            // wider panel would scroll the TABLE, hiding the In-store column
            // the storekeeper is reading at the same moment.
            <div className="mb-1 rounded border border-rose-300 bg-rose-50 px-1.5 py-1 text-[10px] leading-snug text-rose-900 max-w-[15rem] md:max-w-[22rem]">
              <div className="font-semibold flex items-start gap-1">
                <AlertCircle className="w-3 h-3 mt-[1px] shrink-0" />
                <span>Cannot take this back{b.department ? <> from {b.department}</> : null}</span>
              </div>
              {/* The available figure is POOLED per department + material — the
                  kitchen's goods are fungible without lot tracking, so ANOTHER
                  requisition's cooking can legitimately be what leaves nothing
                  here. Never word this as "you consumed this line", and never
                  say "cooked" either: the gap can equally be wastage, a staff
                  meal or an approved count adjustment. State the holding, name
                  no cause. */}
              {b.requested > 0 ? (
                <div className="mt-0.5">
                  Putting {qty(b.requested)} back needs it to still be with {where}.
                  {b.available > 0
                    ? <> It holds {qty(b.available)} — the rest has already left that stock.</>
                    : <> It holds none of it now.</>}
                </div>
              ) : b.available > 0 ? (
                <div className="mt-0.5">{where} holds only {qty(b.available)}.</div>
              ) : null}
              {b.message ? <div className="mt-0.5 opacity-90">{b.message}</div> : null}
              <div className="mt-0.5 opacity-90">
                Nothing was changed on this line. Every other line is untouched.
              </div>
            </div>
          );
        })()}
        {/* A REJECT / UNDO THE CENTRAL FLOOR REFUSED (round 10) — see
            ReversalShort. The server's sentence verbatim and no figure of our
            own: its figures are purchase units and it already names them, so
            nothing here can print them on the wrong basis. The line it names
            is usually ANOTHER line (the transfer's), so that is said, but only
            when it is true of the lines this page holds. */}
        {props.refusedReversal && (() => {
          const rv = props.refusedReversal!;
          const verb = rv.action === 'reject' ? 'Reject' : 'Undo';
          const named = rv.rows.filter(x => x.lineId !== line.id).map(x => x.short.material).filter(Boolean);
          return (
            <div className="mb-1 rounded border border-rose-300 bg-rose-50 px-1.5 py-1 text-[10px] leading-snug text-rose-900 max-w-[15rem] md:max-w-[22rem]">
              <div className="font-semibold flex items-start gap-1">
                <AlertCircle className="w-3 h-3 mt-[1px] shrink-0" />
                <span>{verb} refused — the central store does not hold enough</span>
              </div>
              {rv.completes && named.length > 0 && (
                <div className="mt-0.5">
                  {/* "would leave", not "completes the requisition" (final pass):
                      the store refused, so nothing was completed. */}
                  Rejecting this line would leave {(props.req.items || []).some(o => o.id !== line.id && isRoutedLine(o)
                    && !o.is_rejected && !o.store_rejected && !lineIssueComplete(o)) ? "none of the store's other lines" : 'no other line'} open,
                  which runs the party transfer — it has to move{' '}
                  {named.join(', ')}, and that is what the store refused:
                </div>
              )}
              {rv.rows.map(x => x.short.message
                ? <div key={x.lineId} className="mt-0.5 opacity-90">{x.short.message}</div> : null)}
              <div className="mt-0.5 opacity-90">
                Nothing was changed on this line. Every other line is untouched.
              </div>
            </div>
          );
        })()}
        {/* ANOTHER GESTURE'S PARTY TRANSFER LOWERED AND REOPENED THIS LINE
            (final pass) — see PartyShortNote. The server's sentence verbatim:
            it names what had and had not left the store, what the line now
            records and what it stays open for. */}
        {props.partyShort && (
          <div className="mb-1 rounded border border-amber-300 bg-amber-50 px-1.5 py-1 text-[10px] leading-snug text-amber-900 max-w-[15rem] md:max-w-[22rem]">
            <div className="font-semibold flex items-start gap-1">
              <AlertCircle className="w-3 h-3 mt-[1px] shrink-0" />
              <span>The party transfer could not cover this line — its record was lowered and it is open again</span>
            </div>
            {props.partyShort.message ? <div className="mt-0.5 opacity-90">{props.partyShort.message}</div> : null}
          </div>
        )}
        {/* ── THE CENTRAL STORE WILL NOT GIVE THE GOODS ───────────────────────
            Its own panel beside the reversal one, never through it: these
            figures are PURCHASE units already (the reversal panel's are recipe
            units and go through stockPU), and crossing the two is the 1000x
            error. See CentralShort.

            A panel and not the alert() it was, for exactly the reason the
            reversal panel is one: the only useful thing in it is the NUMBER, and
            a number that fades three seconds later leaves the storekeeper in
            front of the same box with nothing to type. */}
        {props.short && (() => {
          const s = props.short!;
          // The server's unit must be the unit THIS box is entered in before a
          // one-click issue is offered. They are read from the same
          // raw_materials row and always agree — but if the queue payload ever
          // arrives without material_purchase_unit, lineUnits() falls back to
          // the RECIPE unit with pf = 1 and fromPU() becomes a no-op, which
          // would turn one click into a 1000x under-issue. On a mismatch the
          // sentence and the figure still show; only the button is withheld.
          const sameBasis = !!s.purchaseUnit
            && s.purchaseUnit.toLowerCase() === String(u || '').toLowerCase();
          const isParty = props.req.purpose === 'party';
          /* THE DELTA THIS BOX TAKES, in the LINE's stored unit — the basis
             /store-issue adds verbatim. Passed as onIssue's qtyOverride, which
             skips resolveIssueQty: its "typed exactly what the row shows means
             all of it" shortcut would substitute the full outstanding whenever
             the cap and the outstanding round into the same 3rd decimal, and
             that substitution is refused.
               · internal: `available` IS the headroom on top of what is issued
                 (checkCentralIssue's availablePurchase), so it converts as is;
               · PARTY (round 8b): the transfer moves the line's WHOLE quantity,
                 so the server's cap is on the TOTAL (max_issue_qty) and the box
                 can add only that less what the line holds — or, where the line
                 already holds the shown cap, the shelf's own grid point less it
                 (deskPartyHeadroom). Offering `available` itself on THREE MANGO
                 14.842 of 14.843 kg posted +14.842 and was refused again "so
                 29.684 kg cannot be issued" (round-8 verifier, sd_party_tail). */
          const partyHeadroom = (() => {
            if (!isParty) return 0;
            const f = forecastCentralHolds(props.req, [{ line, qty: outstanding }]);
            const mine = f.party?.short.find(x => x.line.id === line.id);
            if (mine) return mine.headroomLine;
            const cap = Number(s.maxIssueLine);
            return Number.isFinite(cap) ? deskPartyHeadroom(issued, cap, 0) : 0;
          })();
          /* NOW, NOT AT THE REFUSAL (round 9). The panel outlives the answer it
             came from — it stays until this line is acted on — so its cap is
             re-read by THE RULE on the balance the page has now (liveCentralCap)
             whenever the server gave figures and the units agree. On a panel
             nothing has moved under, that is the server's own figure. */
          const live = sameBasis && (s.available > 0 || s.requested > 0) ? liveCentralCap(props.req, line) : null;
          // The store now holds at least the figure it refused (`requested` is
          // the ask's shown figure, the same basis as `holdsPU`: the delta on
          // the internal rail, the line's total on the party rail) — stock came
          // in since. The refusal no longer applies, and NO cap is offered: a
          // cap above the ask would be a one-click over-issue (the button
          // bypasses the over-issue reason check), and the row's own Issue Now
          // sends the figure in its box.
          const coversNow = !!live && s.requested > 0 && live.holdsPU + 1e-9 >= s.requested;
          // What the store holds for this line now (the server's `available`
          // is the same quantity as it stood at the answer) — said only when the
          // two differ, so a panel nothing moved under reads as it always did.
          const holdsNowPU = live ? live.holdsPU : s.available;
          const holdsMoved = !!live && Math.abs(live.holdsPU - s.available) > 1e-9;
          // THE SERVER'S CAP WHILE IT IS STILL TRUE, THE RULE'S ONCE IT IS NOT.
          // On a balance nothing has moved under, the server's own figure for
          // the box (max_add_qty) is the one it proved it accepts; the page's
          // forecast takes over only once the balance has moved since (or the
          // server sent no such figure).
          const serverAdd = Number(s.maxAddLine);
          const hasServerAdd = Number.isFinite(serverAdd) && serverAdd >= 0;
          const useLive = !!live && (holdsMoved || !hasServerAdd);
          const serverLineQty = hasServerAdd ? serverAdd : isParty ? partyHeadroom : U.fromPU(s.available);
          const serverCapPU = hasServerAdd
            ? (Number.isFinite(Number(s.maxAddPU)) ? Number(s.maxAddPU) : U.isPU ? serverAdd : serverAdd / (U.pf || 1))
            : isParty ? (U.isPU ? serverLineQty : serverLineQty / (U.pf || 1)) : s.available;
          const exactLineQty = coversNow ? 0 : useLive ? live!.capLine : serverLineQty;
          // The figure the panel and the button print, in the box's own unit.
          const capPU = coversNow ? 0 : useLive ? live!.capPU : serverCapPU;
          // Other open lines of this requisition draw on the same item, so the
          // cap is their balance too (the row forecast's own note, rowHold).
          const sharedWith = (props.req.items || []).filter(o => o.id !== line.id
            && o.material_id === line.material_id && !o.is_rejected && !o.store_rejected
            && lineSplit(o).outstanding > 0).length;
          const canOffer = capPU > 0 && sameBasis;
          // THE CAP AS A FIGURE, NEVER "0" OVER A REAL CRUMB. fmtNum's 3 dp
          // printed a 0.4 g balance as "Most it can give now: 0 kg" and the
          // button as "Issue 0 kg" while the server's sentence one line up said
          // "holds only 0.4 g ... Issue 0.0004 kg or less" — and the printed 0,
          // typed back, was refused here as "Enter a quantity > 0". fmtCapPU
          // prints the crumb at the precision the server named it in (puFine:
          // 6 dp of the recipe unit through the pack), so the figure, the
          // sentence and the button agree, and typing the figure back is
          // accepted. At 0.001 or more it is fmtNum, byte for byte.
          const capPf = sameBasis ? U.pf : 1;
          const capFig = fmtCapPU(capPU, capPf);
          const capUnit = s.purchaseUnit ? ` ${s.purchaseUnit}` : '';
          /* WHAT PRESSING IT WILL DO (round 8b) — the server's take, asked
             before the click (desk-rule.ts): the shelf rule takes the whole
             balance when the figure IS its shown figure, so THREE MANGO's
             "Issue 14.842 kg" over 14,842.4 g takes 14,842.4 g, records 14.8424
             and closes the line. This panel printed "(= 14,842 g)" and "The rest
             stays outstanding" over that take (round-8 verifier, sd_cap_title).
             Only a take that is not the figure, or that closes the line, changes
             the words; every ordinary cap reads as it always did. */
          const capPartyFc = canOffer && isParty ? forecastCentralHolds(props.req, [{ line, qty: exactLineQty }]) : null;
          /* THE TRANSFER REFUSES A SECOND LINE TOO (round 10). The server names
             only the FIRST line the transfer cannot move, so this cap is about
             that line alone; pressed, it completed the requisition and the
             transfer then refused WHOLE DHANIYA, already recorded over an empty
             shelf — a 400 with nothing changed in between, under a panel that
             promised "the line is issued in full" (round-9 never-stuck recheck,
             two-short). The same forecast that scores the cap names those other
             lines; while there are any, the figure is said and no button is. */
          const capBlockers = capPartyFc?.party?.refused
            ? capPartyFc.party.short.filter(x => x.line.id !== line.id).map(x => x.line.material_name) : [];
          const capTake: DeskTakeForecast | null = !canOffer || capBlockers.length > 0 ? null
            : isParty
              ? (capPartyFc!.takes[line.id] || null)
              : forecastDeskTake({ line, purpose: props.req.purpose, approved: eff, deltaLine: exactLineQty });
          const partyIdle = isParty && canOffer && !capTake && capBlockers.length === 0;
          const capSays = !!capTake && (capTake.changed || capTake.complete || capTake.rail === 'party');
          // The "= …" beside the cap: on the internal rail, what leaves the
          // shelf when the take is not the figure (14,842.4 g, not 14,842 g);
          // otherwise the figure's own recipe image, as it always was. On the
          // PARTY rail, none when the transfer's take is not the line's total
          // (round 9): the sentence under it names what leaves the shelf, and
          // "14.842 kg (= 14,842 g)" beside "moves … (= 14,842.4 g)" printed a
          // gram figure the line is not left at (sd_party_from_nothing_cap).
          const capHint = capSays && capTake!.rail !== 'party' ? fmtTakeHint(U, capTake!.takeRecipe)
            : capSays && capTake!.changed ? ''
            : U.pf > 1 && sameBasis ? `= ${fmtCapPU(U.toRecipe(exactLineQty), 1)} ${U.recipeUnit}` : '';
          // The party sentence asks the transfer's own forecast (final pass):
          // "completes the requisition" only when it leaves every line complete,
          // and what it meets on a shelf that cannot cover a top-up (`shortTake`)
          // instead of "moves the line's remaining 0 kg".
          const capWhat = capSays
            ? (capTake!.rail === 'party'
                ? `${partyRunLead('Issuing it', capPartyFc?.party)} ${partyTakeClause(U, capTake!)}`
                : capTake!.plan.takesAll ? 'It takes everything the central store holds' : 'It goes out as entered')
              + ` — and ${takeOutcomeWords(U, eff, capTake!)}.`
              + (capTake!.rail === 'party' ? partyLeftOpenSentence(capPartyFc?.party, line.id) : '')
            : capBlockers.length > 0
              ? `Issuing it would leave no line open, which runs the party transfer — it moves every line at once, and the store's `
                + `books cannot cover ${capBlockers.join(', ')}, so the central store would NOT issue this either. `
                + `Receive stock or record a closing count for ${capBlockers.length === 1 ? 'it' : 'them'} first.`
            : partyIdle
              ? 'It is recorded on the line. A party requisition\'s goods leave the store in one transfer once every line is complete, so nothing moves yet.'
              : 'The rest stays outstanding and can be deferred or ordered.';
          return (
            <div className="mb-1 rounded border border-rose-300 bg-rose-50 px-1.5 py-1 text-[10px] leading-snug text-rose-900 max-w-[15rem] md:max-w-[22rem]">
              <div className="font-semibold flex items-start gap-1">
                <AlertCircle className="w-3 h-3 mt-[1px] shrink-0" />
                <span>The central store does not hold this much</span>
              </div>
              {/* Verbatim. It is written for a storekeeper, it names both
                  figures in the purchase unit, and its cap is the balance's
                  shown figure (or a crumb's exact figure), which the server
                  accepts on the retry and debits as the whole balance. */}
              {s.message ? <div className="mt-0.5 opacity-90">{s.message}</div> : null}
              {/* THE BALANCE AS IT IS NOW, when it is not the one the server's
                  sentence read (round 9): another hand-over of the same item, or
                  a receipt, since the answer. The sentence above stays verbatim —
                  it is what the store said — and this one says what holds now,
                  so the cap below is never read against a stale figure. */}
              {holdsMoved && (
                <div className="mt-0.5">
                  {coversNow
                    ? <>The central store&apos;s books now hold <b className="font-mono">{fmtCapPU(holdsNowPU, capPf)}{capUnit}</b>
                        {isParty ? ' for this line' : ''} — enough for the <b className="font-mono">{fmtCapPU(s.requested, capPf)}{capUnit}</b> it
                        refused, so this line is no longer short.</>
                    : holdsNowPU > 0
                    ? <>The central store&apos;s books now hold <b className="font-mono">{fmtCapPU(holdsNowPU, capPf)}{capUnit}</b>
                        {isParty ? ' for this line' : ''} — the figures above were read when the store answered.</>
                    : <>The central store&apos;s books now hold none of it — the figures above were read when the store answered.</>}
                </div>
              )}
              {/* A party line already holding everything the store can cover:
                  the transfer moves the WHOLE line at once, so nothing more
                  fits — said instead of a figure that would be refused.
                  THE WAY OUT IS NAMED ONLY WHEN IT WORKS (round 9). "Undo the
                  line and issue 14.842 kg again" was printed for a 20 kg line
                  over 14,842.4 g; followed, it recorded 14.842 and the transfer
                  never ran, because THE RULE leaves 5.158 kg owing and a party
                  requisition's goods move only once every line is complete
                  (sd_party_undo_hint). Lowered to the shelf, the line closes
                  only when what is left owing is below one printed step. */}
              {isParty && !coversNow && !(capPU > 0) && (() => {
                const holds = <b className="font-mono">{fmtCapPU(holdsNowPU, capPf)}{capUnit}</b>;
                /* A TOP-UP (round 10). Part of this line already left the store
                   when the transfer first ran (a short /store-process submit), and
                   a later transfer moves only what the line holds above that — so
                   "the transfer moves the whole line at once" is false here, and so
                   is the undo advice: an undo cannot put back what already moved,
                   and re-issuing the shelf figure would move nothing (round-9
                   never-stuck recheck, ta_redo_full_out / ta_redo_exact). */
                const movedL = live ? live.movedLine : (() => {
                  // The payload's own figure when no live forecast was made (no
                  // figures on the refusal): RECIPE units → the line's unit.
                  const b = deskLineBasis(line);
                  const m = Number(line.party_moved_recipe) || 0;
                  return b && m > 0 ? m / (b.factor || 1) : 0;
                })();
                if (movedL > 0) {
                  const restL = Math.max(0, issued - movedL);
                  return (
                    <div className="mt-1">
                      {/* fmtQtyExact (final pass): "14.842 kg … — 0.0006 kg now" sat
                          under the server's "14.8424 kg (= 14,842.4 g) of it already left". */}
                      <b className="font-mono">{fmtQtyExact(U, movedL)}</b> of this party line already left the store
                      when the party transfer first ran, and a later transfer moves only what the line holds above that
                      {restL > 1e-9
                        ? <> — <b className="font-mono">{fmtQtyExact(U, restL)}</b> now</>
                        : null}
                      {!(holdsNowPU > 0)
                        ? <>. The store&apos;s books hold none of it, so nothing more can move for this line. Receive stock or
                            record a closing count first.</>
                        : <>. The store&apos;s books hold {holds}, so nothing more fits on it. Receive stock or record a
                            closing count first.</>}
                    </div>
                  );
                }
                const step = deskLineBasis(line)?.step ?? 0;
                const left = live ? live.exactLeftLine : 0;
                const closesIfRedone = !!live && left > 0 && deskCovers(left, eff, step, true);
                const shortBy = live && left > 0 ? Math.max(0, eff - left) : 0;
                const shortHint = shortBy > 0 ? fmtTakeHint(U, U.toRecipe(shortBy)) : '';
                return (
                  <div className="mt-1">
                    This party line already holds <b className="font-mono">{puNum(U.toPU(issued), issued)}{u ? ` ${u}` : ''}</b>, and
                    the transfer moves the whole line at once
                    {!(holdsNowPU > 0)
                      ? <> — the store&apos;s books hold none of it. Receive stock or record a closing count first.</>
                      : closesIfRedone
                        ? <> — the store&apos;s books hold {holds}, so nothing more fits on it. Undo the line and issue {holds}{' '}
                            again: when the transfer runs it takes everything the store holds and the line closes (what is
                            still owed is below one printed step).</>
                        : live
                          ? <> — the store&apos;s books hold {holds}, so nothing more fits on it, and that is{' '}
                              <b className="font-mono">{fmtNum(U.toPU(shortBy))}{u ? ` ${u}` : ''}</b>{shortHint ? ` (${shortHint})` : ''} short
                              of the line. Nothing leaves the store for this requisition until every line is complete, so
                              receive stock or record a closing count first.</>
                          : <> — the store&apos;s books hold {holds}, so nothing more fits on it. Undo the line to issue a
                              different figure, or receive stock or record a closing count first.</>}
                  </div>
                );
              })()}
              {capPU > 0 && (
                <div className="mt-1 flex items-center justify-between gap-1">
                  <span>
                    Most it can give now:{' '}
                    <b className="font-mono">{capFig}{capUnit}</b>
                    {capHint
                      ? <span className="text-[9px] opacity-70"> ({capHint})</span>
                      : null}
                    {sharedWith > 0
                      ? <> — shared with {sharedWith === 1 ? 'the other open line' : `the ${sharedWith} other open lines`} for the same item</>
                      : null}
                    {(capSays || partyIdle || capBlockers.length > 0) && <span className="block text-[9px] opacity-90">{capWhat}</span>}
                  </span>
                  {canOffer && capBlockers.length === 0 && (
                    /* THE STALE CAP, WIRED (final pass): the cap posts the
                       quantity_issued the store's row was worked out against
                       (`line_issued`; the line as the page holds it when the
                       row carried none). A line that moved since — the
                       management desk issued it, another tab — is refused
                       'line_changed' and nothing is written; until a page sent
                       this, the route's guard never fired (round-10 recheck). */
                    <button onClick={() => props.onIssue(line, exactLineQty,
                              Number.isFinite(s.lineIssued) ? Number(s.lineIssued) : issued)} disabled={busy}
                            title={`Hand over ${capFig}${capUnit} — the most the central books cover on this line. ${capWhat}`}
                            className="shrink-0 px-1.5 py-0.5 rounded border border-rose-400 bg-white hover:bg-rose-100 font-semibold disabled:opacity-50">
                      Issue {capFig}{capUnit}{capTake?.complete && capTake.byShelf ? ' — closes the line' : ''}
                    </button>
                  )}
                </div>
              )}
              {/* THE ONE SENTENCE THAT DIFFERS between a refusal and a hold, and
                  it is the opposite fact. A 400 wrote nothing anywhere. A held
                  line is the only line of a 200 that did NOT go out, so
                  "Every other line is untouched" here would tell him the lines
                  he just handed over are still on the shelf. Worded after the
                  route's own held_message. */}
              <div className="mt-0.5 opacity-90">
                {s.held
                  ? <><b>This line was NOT issued and stays outstanding.</b> Everything else in that gesture was issued.</>
                  : <>Nothing was issued. Every other line is untouched.</>}
              </div>
            </div>
          );
        })()}
        {line.is_rejected ? (
          <span className="text-[10px] text-[#8B7355]">no action — rejected by chef</span>
        ) : routed && !line.store_rejected ? (
          /* ROUTED (ruling #45) — no Issue Now, no part-issue, no defer, no
             undo: the central store never holds this item, and its department
             sends it from its own stock (To send, on Department Transfers),
             which is what fills "Issued so far". The server's own sentence
             says who, why and how far it has got; the store's one action is
             Reject — it closes what is still to send and keeps what was sent. */
          <div className="flex flex-col gap-1 max-w-[15rem] md:max-w-[22rem]">
            <div className="rounded border border-indigo-300 bg-indigo-50 px-1.5 py-1 text-[10px] leading-snug text-indigo-900">
              <div className="font-semibold flex items-start gap-1">
                <Send className="w-3 h-3 mt-[1px] shrink-0" />
                <span>{issued > 0 || outstanding === 0 ? 'Sent by' : 'To be sent by'} {routedDept} — routed item</span>
              </div>
              <div className="mt-0.5">
                {routed.sentence
                  || <>{routedDept} sends this line by department transfer — a Direct Issue rule routes the item there, so the
                      central store does not issue it.{issued > 0 ? <> Sent so far: <b>{puNum(U.toPU(issued), issued)}{u ? ` ${u}` : ''}</b>.</> : null}</>}
              </div>
            </div>
            {outstanding > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <button onClick={() => props.onReject(line)} disabled={busy}
                        title={`Close the rest of this line — ${routedDept} will not be asked to send it. What ${routedDept} already sent stays with the department, and nothing moves from the store.`}
                        className="px-2 py-0.5 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded text-[10px] flex items-center gap-1 disabled:opacity-50">
                  <XCircle className="w-3 h-3" /> Reject
                </button>
              </div>
            )}
          </div>
        ) : direct && outstanding > 0 ? (
          /* DELIVERED DIRECT (ruling #68) — no Issue Now, no part-issue, no
             defer: the goods never came through central, so issuing them from
             here would hand the department the same item twice. The reason is
             said where the buttons were. Reject stays — on an internal line it
             cancels the balance and moves no stock; on a party line its own
             prompt says what the party rejection and transfer will do — and so
             does Undo for anything this desk did earlier. */
          <div className="flex flex-col gap-1 max-w-[15rem] md:max-w-[22rem]">
            <div className="rounded border border-violet-300 bg-violet-50 px-1.5 py-1 text-[10px] leading-snug text-violet-900">
              <div className="font-semibold flex items-start gap-1">
                <AlertCircle className="w-3 h-3 mt-[1px] shrink-0" />
                <span>Delivered direct{deliveredDirectDept(line) ? <> to {deliveredDirectDept(line)}</> : null} — do not issue</span>
              </div>
              <div className="mt-0.5">
                The vendor delivered this item straight to{' '}
                {deliveredDirectDept(line) ? <b>{deliveredDirectDept(line)}</b> : 'a department'} under a Direct Issue
                rule{line.on_po?.po_number ? <> on {line.on_po.po_number}</> : null}, so the central store never received
                it and does not issue it. If {props.req.department_name || 'this department'} still needs it, the
                department that received it passes it on by department transfer.
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <button onClick={() => props.onReject(line)} disabled={busy}
                      title={isPartyLine
                        ? 'Close this line without issuing it — the prompt says what a rejection does on a party requisition'
                        : 'Close this line here without issuing anything — the balance is cancelled, no stock moves'}
                      className="px-2 py-0.5 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded text-[10px] flex items-center gap-1 disabled:opacity-50">
                <XCircle className="w-3 h-3" /> Reject
              </button>
              {(issued > 0 || line.deferred_until) && (
                <button onClick={() => props.onUndo(line)} disabled={busy}
                        title={isPartyLine
                          ? 'Clear all issue/defer actions on this line. On a party requisition this clears the record only — no stock moves, and anything the party transfer already moved stays with the department'
                          : 'Clear all issue/defer actions on this line — the goods come back from the kitchen to the store'}
                        className="px-1.5 py-0.5 bg-white border border-[#E8D5C4] text-[#8B7355] hover:bg-[#FFF1E3] rounded text-[10px] flex items-center gap-1">
                  <RotateCcw className="w-3 h-3" /> undo
                </button>
              )}
            </div>
          </div>
        ) : line.store_rejected ? (
          // Store-rejected: only an un-reject action to put the line back in play.
          <button onClick={() => props.onUnreject(line)} disabled={busy}
                  title={routed
                    ? `Re-open the line — it goes back on ${routedDept}'s To send list; it is still never issued from the store`
                    : direct
                    ? 'Re-open the line — it stays delivered direct, so it is still not issued from central'
                    : 'Clear the store rejection — the line becomes issuable again'}
                  className="px-2 py-0.5 bg-white border border-red-200 text-red-700 hover:bg-red-50 rounded text-[10px] flex items-center gap-1 disabled:opacity-50">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
            Un-reject
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {outstanding > 0 && !deferOpen && (
              <>
                {/* NO max — the store can physically hand over more than was
                    approved, and the number here must be what actually left the
                    store. A max= capped the spinner at the approved qty and made
                    a genuine over-issue look impossible, so 10 given against 3
                    approved got recorded as 3. Over-issues are allowed, flagged
                    and reasoned (below) rather than quietly trimmed. */}
                <input type="number" step="any" min={0}
                       value={props.editQty[line.id] ?? ''}
                       onChange={e => props.setEditQty((s: any) => ({ ...s, [line.id]: e.target.value }))}
                       placeholder={String(puNum(outstandingPU, outstanding))}
                       title={`Issue in ${u || 'units'} (purchase unit) — outstanding ${puNum(outstandingPU, outstanding)}${u ? ' ' + u : ''}`
                              + (U.pf > 1 ? ` (= ${fmtNum(U.toRecipe(outstanding))} ${U.recipeUnit})` : '')
                              + '. You may issue more than approved — say why when you do.'}
                       className={`w-16 px-1 py-0.5 border rounded text-right text-xs ${
                         overIssue ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4] bg-[#FFF8F0]'}`} />
                {u && <span className="text-[10px] text-[#6B5744] font-medium">{u}</span>}
                <button onClick={() => props.onIssue(line)}
                        disabled={busy || (overIssue && !String(props.issueNotes[line.id] || '').trim())}
                        title={overIssue
                          ? (String(props.issueNotes[line.id] || '').trim()
                              ? 'Issuing more than approved — the reason will be recorded against this line'
                              : 'Type why you are issuing more than approved before handing over')
                          : undefined}
                        className="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[10px] flex items-center gap-1 disabled:opacity-50">
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  Issue Now
                </button>
                <button onClick={() => props.setEditDefer((s: any) => ({ ...s, [line.id]: { until: defaultDefer(), reason: '' } }))}
                        className="px-2 py-0.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded text-[10px] flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Defer
                </button>
                {/* THE SPLIT. Issue what is physically on the shelf and promise
                    the balance in the same gesture — one POST, one transaction,
                    one row in the history. Doing it as Issue-then-Defer left the
                    line out of the open list between the two clicks, and the
                    store had to go and find it again. The label carries the real
                    numbers as soon as the box holds a partial quantity, so the
                    button says exactly what it is about to do. */}
                <button onClick={() => props.onBeginIssueDeferRest(line)} disabled={busy}
                        title="Hand over part of this line now and put a promised time on the balance — one action, recorded as both"
                        className="px-2 py-0.5 bg-violet-50 hover:bg-violet-100 text-violet-700 border border-violet-200 rounded text-[10px] flex items-center gap-1 disabled:opacity-50">
                  <Split className="w-3 h-3" />
                  {/* The typed figure through fmtCapPU, not fmtNum: a crumb cap
                      typed from the panel (0.0004 kg) read "Issue 0 kg". At
                      0.001 or more the two print the same string. */}
                  {typedIsPartial
                    ? (typedTake?.complete
                        /* The take empties the shelf and THE RULE closes the
                           line — there is no balance to defer (round 8). */
                        ? <>Issue {fmtCapPU(typedPU, U.pf)} {u} — closes the line</>
                        /* The balance below one printed step at the precision that
                           names it (final pass): 14.843 − 14.8424 kg read "defer
                           0.001 kg" over 0.6 g. Beside such a balance the typed
                           figure is printed as typed (14.8424, not 14.842), so the
                           two add up to the line. At 0.001 or more, the old label. */
                        : (() => {
                            const restLine = typedTake ? typedTake.owingLine : Math.max(0, outstanding - U.fromPU(typedPU));
                            const restPU = U.isPU ? restLine : restLine / (U.pf || 1);
                            const crumb = restPU > 0 && restPU < 0.001;
                            const dp = Math.min(20, 6 + Math.max(0, Math.ceil(Math.log10(U.pf > 1 ? U.pf : 1))));
                            const typedFig = crumb
                              ? typedPU.toLocaleString('en-IN', { maximumFractionDigits: dp })
                              : fmtCapPU(typedPU, U.pf);
                            const restFig = typedTake
                              ? fmtHandOverPU(U, typedTake.owingLine)
                              : crumb ? fmtCapPU(restPU, U.pf) : fmtNum(Math.round((outstandingPU - typedPU) * 1000) / 1000);
                            return <>Issue {typedFig} {u}, defer {restFig} {u}</>;
                          })())
                    : <>Issue part, defer rest</>}
                </button>
                {/* Store rejection — distinct from the chef's. Prompts for a reason. */}
                <button onClick={() => props.onReject(line)} disabled={busy}
                        title="Store cannot fulfil this line (discontinued / wrong item)"
                        className="px-2 py-0.5 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded text-[10px] flex items-center gap-1 disabled:opacity-50">
                  <XCircle className="w-3 h-3" /> Reject
                </button>
              </>
            )}
            {overIssue && !deferOpen && (
              <div className="w-full flex flex-col gap-1 bg-amber-50 border border-amber-300 rounded px-1.5 py-1">
                <span className="text-[10px] text-amber-900 shrink-0">
                  <AlertCircle className="w-3 h-3 inline mr-0.5 -mt-0.5" />
                  {/* Say ALL the numbers. The first version called `outstanding`
                      "approved", so a line approved for 4 kg with 3 kg already
                      issued read "2 kg more than approved (1 kg)" — which looks
                      like the approval was 1 kg. It never was. */}
                  {/* fmtHandOverPU (final pass): "Only 0.001 kg is still open" over 0.6 g. */}
                  Only {fmtHandOverPU(U, outstanding)} {u} is still open — {fmtNum(U.toPU(issued))} of {fmtNum(U.toPU(eff))} {u} already issued.
                  {' '}Handing over {fmtNum(typedPU)} {u} takes the total to <b>{fmtNum(U.toPU(issued) + typedPU)} {u}</b>,
                  {' '}which is {fmtNum(overBy)} {u} over the {fmtNum(U.toPU(eff))} {u} approved.
                </span>
                {/* Own full-width row, not sharing one with the warning. As a
                    flex-1 input beside that long sentence it collapsed to a
                    slit barely wider than the caret, so nobody could read back
                    what they had written. Two rows are visible at rest — a
                    whole sentence — and it grows as the person keeps typing.
                    MANDATORY: the button above is disabled until it has text.
                    The tooltip has always said a reason was required; it was
                    never actually enforced, so an unexplained over-issue could
                    be handed over and only surface in a variance months later. */}
                <textarea value={props.issueNotes[line.id] || ''}
                          onChange={e => {
                            props.setIssueNotes((s: any) => ({ ...s, [line.id]: e.target.value }));
                            const el = e.currentTarget;
                            el.style.height = 'auto';
                            el.style.height = `${el.scrollHeight}px`;
                          }}
                          rows={2}
                          required
                          aria-label="Reason for issuing more than approved"
                          placeholder="Why more than approved? e.g. full 10 kg bag, cannot split"
                          className="w-full resize-y overflow-hidden px-1.5 py-1 border border-amber-400 rounded text-[10px] leading-snug bg-white" />
              </div>
            )}
            {deferOpen && (
              // The SAME editor serves both actions. In split mode it is tinted
              // violet, states the two quantities it is about to record, and its
              // save button performs the combined issue+defer; otherwise it is
              // the plain defer it has always been, unchanged.
              <div className={`flex flex-wrap items-center gap-1 border rounded px-1.5 py-1 ${
                splitMode ? 'bg-violet-50 border-violet-200' : 'bg-blue-50 border-blue-200'}`}>
                {splitMode && !splitTake && (
                  <span className="w-full sm:w-auto text-[10px] text-[#6B5744] shrink-0">
                    Handing over <b className="text-emerald-700">{fmtFinePU(splitQty)} {u}</b> now
                    {U.pf > 1 && <span className="text-[9px] text-[#B8A590] ml-0.5">= {fmtNum(U.toRecipe(splitQty))} {U.recipeUnit}</span>}
                    , the balance <b className="text-violet-700">{fmtHandOverPU(U, splitRest)} {u}</b>
                    {U.pf > 1 && <span className="text-[9px] text-[#B8A590] ml-0.5">= {fmtNum(U.toRecipe(splitRest))} {U.recipeUnit}</span>}
                    {' '}is promised for
                  </span>
                )}
                {/* THE SAME PANEL WHEN THE TAKE IS NOT THE TYPED FIGURE (round 8):
                    the shelf rule takes everything the central store holds, the
                    line records what left the shelf, and THE RULE either closes
                    it (nothing to defer — the server drops the defer and says
                    so, announceDeferDropped) or leaves a real balance, which is
                    the one the promise is for. A separate branch, so an
                    ordinary split renders exactly as before. */}
                {splitMode && splitTake && splitTake.rail === 'party' && (
                  /* The PARTY split (round 8b): the hand-over is recorded and the
                     transfer it triggers moves the line's whole quantity — so the
                     two figures are said apart. */
                  <span className="w-full sm:w-auto text-[10px] text-[#6B5744] shrink-0">
                    Handing over <b className="text-emerald-700">{fmtFinePU(splitQty)} {u}</b> now
                    {U.pf > 1 && <span className="text-[9px] text-[#B8A590] ml-0.5">= {fmtNum(U.toRecipe(splitQty))} {U.recipeUnit}</span>}
                    {/* The lead and the take from the transfer's own forecast
                        (final pass) — see partyRunLead / partyTakeClause. */}
                    {' '}{partyRunLead('', props.centralParty).trim()}{' '}
                    {splitTake.shortTake ? <>{partyTakeClause(U, splitTake)}</> : (
                      <>
                        moves {partyTakeLead(splitTake)}{' '}
                        <b className="text-emerald-700">{fmtTakePU(U, splitTake.takeRecipe)} {u}</b>
                        {fmtTakeHint(U, splitTake.takeRecipe) && <span className="text-[9px] text-[#B8A590] ml-0.5">{fmtTakeHint(U, splitTake.takeRecipe)}</span>}
                        {partyMovedNote(U, splitTake)}
                        {splitTake.plan.takesAll ? ' — everything the central store holds' : ''}
                      </>
                    )}
                    . <b className="text-emerald-700">{takeOutcomeWords(U, eff, splitTake).replace(/^the line/, 'The line').replace(/^its record/, 'Its record')}</b>
                    {splitTake.complete ? ', so nothing is deferred.' : '.'}
                    {partyLeftOpenSentence(props.centralParty, line.id)}
                  </span>
                )}
                {splitMode && splitTake && splitTake.rail !== 'party' && (
                  <span className="w-full sm:w-auto text-[10px] text-[#6B5744] shrink-0">
                    Handing over <b className="text-emerald-700">{fmtTakePU(U, splitTake.takeRecipe)} {u}</b> now
                    {fmtTakeHint(U, splitTake.takeRecipe) && <span className="text-[9px] text-[#B8A590] ml-0.5">{fmtTakeHint(U, splitTake.takeRecipe)}</span>}
                    {' '}— everything the central store holds
                    {splitTake.complete ? (
                      <>. <b className="text-emerald-700">{takeOutcomeWords(U, eff, splitTake).replace(/^the line/, 'The line')}</b>, so nothing is deferred.</>
                    ) : (
                      <>
                        , the balance <b className="text-violet-700">{fmtHandOverPU(U, splitTake.owingLine)} {u}</b>
                        {U.pf > 1 && <span className="text-[9px] text-[#B8A590] ml-0.5">= {fmtNum(U.toRecipe(splitTake.owingLine))} {U.recipeUnit}</span>}
                        {' '}is promised for
                      </>
                    )}
                  </span>
                )}
                {/* A PLAIN DEFER ON A PARTY LINE (final pass) — what the server
                    does on Save defer, said before the click. Round 10 made only
                    a gesture that ISSUES try the party transfer
                    (store-issue/route.ts, "ONLY A GESTURE THAT ISSUED TRIES IT"),
                    and a deferred open line keeps every line from reading done, so
                    a defer writes the promised time and nothing else (round 9 ran
                    the transfer from here — c16_party_defer_closes). On a line that
                    already reads complete the route writes no defer at all. */}
                {!splitMode && props.req.purpose === 'party' && (
                  <span className="w-full text-[10px] text-[#6B5744]">
                    {outstanding > 0
                      ? <>Save defer only records the promised time — nothing is issued, nothing leaves the store, and the
                          party transfer does not run on a defer; the line stays open.</>
                      : <>This line now reads complete, so Save defer writes no promised time — the store drops it and says
                          why.</>}
                  </span>
                )}
                {/* No time to pick when the take closes the line — there is no
                    balance to promise (the captured time still rides the POST,
                    and the server drops it and says so). */}
                {!splitTake?.complete && (
                  <>
                    <input type="datetime-local" value={props.editDefer[line.id]?.until || ''}
                           onChange={e => props.setEditDefer((s: any) => ({ ...s, [line.id]: { ...s[line.id], until: e.target.value } }))}
                           className={`px-1 py-0.5 border rounded text-[10px] bg-white ${splitMode ? 'border-violet-200' : 'border-blue-200'}`} />
                    <input type="text" placeholder="reason (optional)"
                           value={props.editDefer[line.id]?.reason || ''}
                           onChange={e => props.setEditDefer((s: any) => ({ ...s, [line.id]: { ...s[line.id], reason: e.target.value } }))}
                           className={`w-32 px-1 py-0.5 border rounded text-[10px] bg-white ${splitMode ? 'border-violet-200' : 'border-blue-200'}`} />
                  </>
                )}
                {splitMode ? (
                  <button onClick={() => props.onIssueDeferRest(line)} disabled={busy}
                          title={splitTake?.complete
                            ? 'Records the hand-over. It takes everything the central store holds and completes the line, so the store drops the promised time and tells you why.'
                            : 'Records the hand-over AND the promised time in one transaction'}
                          className="px-2 py-0.5 bg-violet-600 hover:bg-violet-700 text-white rounded text-[10px] disabled:opacity-50 flex items-center gap-1">
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Split className="w-3 h-3" />}
                    {splitTake?.complete ? <>Issue — closes the line</> : <>Issue &amp; defer balance</>}
                  </button>
                ) : (
                  <button onClick={() => props.onDefer(line)} disabled={busy}
                          className="px-2 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-[10px] disabled:opacity-50">
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save defer'}
                  </button>
                )}
                {/* Cancel drops the captured quantity too — leaving it behind
                    would re-arm the split the next time the plain Defer button
                    opened this panel. */}
                <button onClick={() => {
                          props.setEditDefer((s: any) => { const n = { ...s }; delete n[line.id]; return n; });
                          props.setSplitIssueQty((s: any) => { const n = { ...s }; delete n[line.id]; return n; });
                        }}
                        className={`text-[10px] px-1 ${splitMode ? 'text-violet-700' : 'text-blue-700'}`}>cancel</button>
              </div>
            )}
            {/* THE CENTRAL STORE WILL NOT GIVE THIS — SAID BEFORE THE CLICK, in
                words, under the box it is about. The management desk's round-6
                row sentence and "Issuable now" figure, verbatim; the figure is
                the delta this box takes (the box adds to what is issued), which
                is checkCentralIssue's `availablePurchase` — typed back, it is
                accepted. Live: it follows the typed figure (and, in the split
                panel, the captured hand-over), and disappears the moment the
                quantity is one the store can give.
                Stood down while the server's own panel is on this line: that is
                the fresher reading of the same fact, in the server's words.
                Hidden on a plain Defer — nothing is being handed over. */}
            {/* WHAT ISSUE NOW WILL TAKE, WHEN IT IS NOT THE FIGURE IN THE BOX
                (round 8). The shelf rule takes everything the central store
                holds when the figure sent IS the balance's shown figure (14.843
                kg over 14,842.5 g, 14.842 over 14,842.4): the line records what
                left the shelf, and THE RULE closes it when less than one printed
                step is still owed. Said under the box so the storekeeper reads
                the gram figure before the click. Silent on every ordinary row. */}
            {saysTake(props.centralTake) && !props.centralHold && !props.short && outstanding > 0 && !deferOpen && (() => {
              const tk = props.centralTake!;
              if (tk.rail === 'party') {
                // The lead, the take and what the transfer leaves open, from the
                // transfer's own forecast (final pass): never "completes the
                // requisition" over a transfer that reopens a line, never "moves
                // the line's remaining 0 kg" over a shelf that holds none of it.
                return (
                  <div className="w-full text-[9px] text-emerald-800"
                       title="A party requisition's goods leave the store in one transfer, when no line is left open — each line's quantity above what already moved, under the same shelf rule: a figure that IS the balance's shown figure takes the whole balance and the line records what left the shelf.">
                    {partyRunLead('Issue Now', props.centralParty)}{' '}
                    {tk.shortTake ? <>{partyTakeClause(U, tk)}</> : (
                      <>
                        moves {partyTakeLead(tk)}{' '}
                        <b className="font-mono">{fmtTakePU(U, tk.takeRecipe)} {u}</b>
                        {fmtTakeHint(U, tk.takeRecipe) && <> ({fmtTakeHint(U, tk.takeRecipe)})</>}{partyMovedNote(U, tk)}
                        {tk.plan.takesAll ? ' — everything the central store holds' : ''}
                      </>
                    )} — and {takeOutcomeWords(U, eff, tk)}.
                    {partyLeftOpenSentence(props.centralParty, line.id)}
                  </div>
                );
              }
              return (
                <div className="w-full text-[9px] text-emerald-800"
                     title="The central store's shelf rule: a figure that IS the balance's shown figure takes the whole balance and lands the shelf on exactly 0. The line records what left the shelf.">
                  Issue Now takes everything the central store holds — <b className="font-mono">{fmtTakePU(U, tk.takeRecipe)} {u}</b>
                  {fmtTakeHint(U, tk.takeRecipe) && <> ({fmtTakeHint(U, tk.takeRecipe)})</>} — and {takeOutcomeWords(U, eff, tk)}.
                </div>
              );
            })()}
            {/* ISSUE NOW REOPENS ANOTHER PARTY LINE (final pass). This row's own
                take is ordinary, so nothing above is said — but the transfer the
                click runs meets a top-up the shelf cannot cover on a line it does
                not issue on, lowers that line's record to what actually left and
                reopens it (desk-rule.ts `shortTake`; the route's party_short).
                Said before the click: SALT's Issue Now took THREE MANGO from
                20/20 to 15/20 open with nothing on SALT's row (tb_issue_block). */}
            {!saysTake(props.centralTake) && !props.centralHold && !props.short && outstanding > 0 && !deferOpen
              && props.centralParty && props.centralParty.runs !== 'none'
              && partyLeftOpenSentence(props.centralParty, line.id) !== '' && (
              <div className="w-full text-[9px] text-amber-800">
                Issue Now leaves no line open, so the party transfer runs.{partyLeftOpenSentence(props.centralParty, line.id)}
              </div>
            )}
            {/* …and IN A SPLIT EDITOR EVEN UNDER THE SERVER'S PANEL (round 10):
                that panel is about the gesture it refused, and a split the
                storekeeper opens again afterwards would otherwise sit silent
                over a figure the store will refuse the same way (c19). */}
            {props.centralHold && outstanding > 0
              && ((!props.short && (!deferOpen || splitMode)) || (!!props.short && splitMode)) && (() => {
              const h = props.centralHold!;
              const cap = `${fmtCapPU(h.availPU, h.pf)} ${h.purchaseUnit}`;
              /* THE PARTY TRANSFER WILL REFUSE THIS (round 8b): it moves every
                 line's WHOLE quantity at once, so the hold is about the line's
                 total, and "Issuable now" is the delta this box can still add
                 (0 when the line already holds all the store can cover). */
              if (h.party) {
                const pu = h.purchaseUnit ? ` ${h.purchaseUnit}` : '';
                return (
                  <div className="w-full text-[9px] text-red-800 font-semibold"
                       title="A party requisition's goods leave the store in one transfer, every line's whole quantity at once, when the last line is complete — and the transfer is refused whole if the store's books cannot cover one line. (Liquor-store items are the exception: their stock moves on the Liquor Store ledger.)">
                    {h.party.blockedBy && h.party.blockedBy.length > 0 ? (
                      /* "would leave", not "completes the requisition" (final pass):
                         the store refuses it, so nothing is completed. */
                      <>Issuing this would leave no line open, which runs the party transfer — it moves every line at
                        once, and the store&apos;s books cannot cover {h.party.blockedBy.join(', ')}, so the central store
                        will NOT issue this either.</>
                    ) : (
                      <>
                        {(h.party.movedPU || 0) > 0 ? (
                          /* A TOP-UP (round 9): part of the line already left the
                             store when it was processed; the transfer asks only
                             for the rest. */
                          /* Exact below one printed step (round 10): "the 0.001 kg this
                             line holds above the 14.842 kg" was 0.6 g above 14,842.4 g.
                             And the figure beside it exact too (final pass, fmtQtyExact):
                             "above the 14.842 kg" when 14.8424 kg had left did not add up. */
                          <>The party transfer moves the <b>{fmtQtyExact(U, (() => {
                              const r = h.party.restPU ?? Math.max(0, h.party.totalPU - (h.party.movedPU || 0));
                              return U.isPU ? r : r * (U.pf || 1);
                            })())}</b> this line holds above the {fmtQtyExact(U, (() => {
                              const m = h.party.movedExactPU ?? (h.party.movedPU || 0);
                              return U.isPU ? m : m * (U.pf || 1);
                            })())} that already left the store, and the</>
                        ) : (
                          <>The party transfer moves this line&apos;s whole <b>{fmtNum(h.party.totalPU)}{pu}</b> at once, and the</>
                        )}{' '}
                        store&apos;s books hold <b>{fmtCapPU(h.party.holdsPU, h.pf)}{pu}</b> — the central store will NOT issue it.
                        <div className="text-red-900 font-normal">
                          {h.party.headroomLine > 0
                            ? <>Issuable now: <b className="font-mono">{cap}</b>
                                {h.party.closesAtCap ? ' — it takes everything the store holds and the line closes' : ''}
                                {h.party.capBlockedBy && h.party.capBlockedBy.length > 0
                                  ? <> — but that would leave no line open, which runs the party transfer, and the store&apos;s
                                      books cannot cover{' '}
                                      {h.party.capBlockedBy.join(', ')} either, so it would NOT be issued. Receive stock or record a
                                      closing count for {h.party.capBlockedBy.length === 1 ? 'it' : 'them'} first.</>
                                  : null}</>
                            : <>Nothing more fits on this line until stock is received or a closing count recorded.</>}
                        </div>
                      </>
                    )}
                  </div>
                );
              }
              return (
                <div className="w-full text-[9px] text-red-800 font-semibold"
                     title={h.empty
                       ? `The central store's books hold NONE of this material, so the store will NOT issue this line — get stock received or a closing count recorded first. (Liquor-store items are the exception: their stock moves on the Liquor Store ledger.)`
                       : `The central store's books hold ${cap} — more than that is NOT issued. (Liquor-store items are the exception: their stock moves on the Liquor Store ledger.)`}>
                  {h.empty
                    ? <>The store&apos;s books hold <b>none</b> of this — the central store will NOT issue this line.</>
                    : <>Over the store&apos;s balance of <b>{cap}</b> — the central store will NOT issue this line.</>}
                  {!h.empty && (
                    <div className="text-red-900 font-normal">
                      Issuable now: <b className="font-mono">{cap}</b>
                      {h.sharedWith
                        ? <> — shared with {h.sharedWith === 1 ? 'the other open line' : `the ${h.sharedWith} other open lines`} for the same item</>
                        : null}
                    </div>
                  )}
                </div>
              );
            })()}
            {/* UNDO STAYS VISIBLE ON A FULFILLED REQUISITION. The condition is
                the LINE's own state (something was issued, or a time was
                promised) and never the requisition's status — the card flips to
                'fulfilled' the moment the last line is satisfied, which is
                exactly when the storekeeper notices the quantity was wrong.
                Hiding it there would leave the most common mistake in the
                building with no in-app correction at all. The reversal is gated
                server-side, two ways, and both are correct here:
                  · the department has nothing left to hand back → typed refusal,
                    rendered in the rose panel above;
                  · the requisition is a fulfilled PARTY req → the route keeps
                    those outside the widened window (their stock moved on the
                    party rail, which an undo cannot re-fire), so it answers with
                    an ordinary status error and this page alerts. That alert is
                    the intended outcome; do not add a status test here to
                    pre-hide the button, because the party carve-out is the
                    route's call to make and it may change. */}
            {(issued > 0 || line.deferred_until) && (
              <button onClick={() => props.onUndo(line)} disabled={busy}
                      title={isPartyLine
                        /* A party undo moves no stock (the route's party rail; final pass). */
                        ? 'Clear all issue/defer actions on this line. On a party requisition this clears the record only — no stock moves, and anything the party transfer already moved stays with the department'
                        : 'Clear all issue/defer actions on this line — the goods come back from the kitchen to the store'}
                      className="px-1.5 py-0.5 bg-white border border-[#E8D5C4] text-[#8B7355] hover:bg-[#FFF1E3] rounded text-[10px] flex items-center gap-1">
                <RotateCcw className="w-3 h-3" /> undo
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

/**
 * Feature 4 — classify a deferred line's promised time relative to now:
 *   - soon:    due within the next 4 hours (inclusive of overdue)
 *   - overdue: the promised time is already in the past
 *   - hours:   whole-ish hours until due (for the "due in Xh" chip)
 *
 * deferred_until is a bare local datetime string (as written by
 * <input type="datetime-local">). new Date(str) parses it in the browser's
 * local timezone — the same wall-clock the store manager entered — so the
 * comparison against Date.now() is consistent.
 */
function deferDueStatus(deferredUntil: string | null): { soon: boolean; overdue: boolean; hours: number } {
  if (!deferredUntil) return { soon: false, overdue: false, hours: 0 };
  const dueMs = new Date(deferredUntil).getTime();
  if (!Number.isFinite(dueMs)) return { soon: false, overdue: false, hours: 0 };
  const delta = dueMs - Date.now();
  const overdue = delta < 0;
  const soon = delta <= 4 * 3600 * 1000;   // within 4h (or already past)
  const hours = Math.max(0, Math.round(delta / 3600000));
  return { soon, overdue, hours };
}

/**
 * One id per GESTURE, for /store-issue's optional body.client_token. randomUUID
 * needs a secure context; the fallback is only ever used where it isn't (plain
 * http on a LAN IP), and uniqueness per gesture is all the token has to promise.
 */
function gestureToken(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `split-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Default defer to +2h from now, formatted for <input type="datetime-local">. */
function defaultDefer(): string {
  const d = new Date(Date.now() + 2 * 3600 * 1000);
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function HistoryDrawer({ line, onClose }: { line: ReqLine; onClose: () => void }) {
  let history: Array<{ qty: number; at: string; by: string; note?: string }> = [];
  try { history = JSON.parse(line.issue_history || '[]'); } catch {}
  // h.qty is stored in the LINE's own unit (store-issue adds it verbatim), so it
  // reads through the same resolver as the row it came from. Hoisted out of the
  // map — it was rebuilt twice per history row.
  const U = lineUnits(line);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#E8D5C4] flex items-center justify-between">
          <div>
            <div className="font-semibold text-[#2D1B0E]">{line.material_name}</div>
            <div className="text-[10px] text-[#8B7355]">Per-issue history</div>
          </div>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-4 space-y-2 max-h-[60vh] overflow-y-auto">
          {history.length === 0 ? (
            <div className="text-sm text-[#8B7355] text-center py-6">No issue events yet for this item.</div>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left  py-1.5 px-2">When</th>
                  <th className="text-right py-1.5 px-2" title="Handed over, in the PURCHASE unit">Qty</th>
                  <th className="text-left  py-1.5 px-2">By</th>
                  <th className="text-left  py-1.5 px-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {history.slice().reverse().map((h, i) => (
                  <tr key={i} className="border-t border-[#E8D5C4]/50">
                    <td className="py-1.5 px-2">{fmtDateTime(h.at)}</td>
                    <td className="py-1.5 px-2 text-right font-mono font-semibold text-emerald-700">
                      {/* Exact below one printed step (round 10): the held panel's
                          own "Issue 0.0004 kg" read "0 kg" here. Signed — an
                          undo row is negative. Every other figure is unchanged. */}
                      {(() => {
                        const v = Number(h.qty) || 0;
                        const pu = U.isPU ? v : v / (U.pf || 1);
                        return Math.abs(pu) > 0 && Math.abs(pu) < 0.001
                          ? `${pu < 0 ? '-' : ''}${fmtCapPU(Math.abs(pu), U.pf)}` : fmtNum(U.toPU(h.qty));
                      })()}
                      <span className="text-[9px] text-[#8B7355] ml-0.5">{U.pu}</span>
                      {U.pf > 1 && (Number(h.qty) || 0) > 0 && (
                        <div className="text-[9px] font-normal text-[#B8A590]">= {fmtNum(U.toRecipe(h.qty))} {U.recipeUnit}</div>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-[#6B5744] flex items-center gap-1"><UserIcon className="w-3 h-3" /> {h.by}</td>
                    <td className="py-1.5 px-2 text-[#8B7355]">{h.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Issued Items Log — flat list of every hand-over event in the chosen date range.
 *
 * Rows are unrolled from issue_history JSON across all requisition_items, so a
 * 30+20 kg split-issue appears as two distinct rows with their own timestamps.
 * Lets a store manager / admin audit "what went out today, to whom, and by who."
 *
 * DIRECT-ISSUE vendor receipts ride inline too (tagged "Direct"): goods the
 * vendor delivered straight to a department under Settings → Direct Issue.
 * They carry the GRN/bill number where a requisition row carries its Req #,
 * and '—' in the approval columns — no requisition ever existed for them.
 * The All / Requisitions / Direct filter slices the two rails apart.
 */
function IssuedLogPanel({ loading, log, from, to, onFromChange, onToChange }: {
  loading: boolean;
  log: { events: any[]; totals: any } | null;
  from: string; to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
}) {
  const events = log?.events || [];

  // ── SOURCE FILTER — All / Requisitions / Direct ──────────────────────────
  // The log now carries TWO rails: hand-overs against a requisition
  // (source 'requisition') and vendor deliveries routed straight to a
  // department under Settings → Direct Issue (source 'direct', tagged on the
  // row). `?? 'requisition'` keeps an older payload — rows minted before the
  // source field existed — filing under Requisitions instead of vanishing.
  const [srcFilter, setSrcFilter] = useState<'all' | 'requisition' | 'direct'>('all');
  const srcOf = (e: any) => (e?.source === 'direct' ? 'direct' : 'requisition');
  const shown = useMemo(
    () => (srcFilter === 'all' ? events : events.filter(e => srcOf(e) === srcFilter)),
    [events, srcFilter],
  );
  const counts = useMemo(() => {
    let req = 0, dir = 0;
    for (const e of events) srcOf(e) === 'direct' ? dir++ : req++;
    return { all: events.length, requisition: req, direct: dir };
  }, [events]);

  // Summary cards describe WHAT IS LISTED. Computed from the filtered rows —
  // the same sums/sets the server totals run over, so with the filter on All
  // the numbers match the server's — because cards frozen on the unfiltered
  // totals would contradict the table the moment a filter is applied.
  const totals = useMemo(() => {
    const mats = new Set<string>(); const depts = new Set<string>(); let val = 0;
    for (const e of shown) {
      val += Number(e.value) || 0;
      if (e.material_id) mats.add(e.material_id);
      if (e.department_name) depts.add(e.department_name);
    }
    return {
      events: shown.length,
      total_value: Math.round(val * 100) / 100,
      distinct_materials: mats.size,
      distinct_departments: depts.size,
    };
  }, [shown]);

  const downloadCsv = () => {
    if (shown.length === 0) return;
    // Both bases: the purchase figure is what was handed over, the recipe
    // figure is what Value and the stock deduction were computed from.
    // Column names say WHICH basis each figure is in — an unqualified "Qty"/"Unit"
    // next to a "Qty (recipe)" invites the reader to assume the first pair is the
    // recipe one too. Header text only; the values are unchanged.
    //
    // The two "incl. GST" columns are ADDITIVE — they sit next to their ex-tax
    // counterparts, which are unchanged. Value / Unit Cost stay the ex-tax goods
    // price the recipe costing depends on; the new pair is a DERIVED estimate.
    // Headers say so, and say exactly which levy:
    //   · "incl. GST", not "incl. tax" — compensation cess is NOT folded in.
    //     "Incl. Tax" already means taxable + GST on the PO screen, cess on its
    //     own line; and on an issue there is no pre-discount gross for the cess
    //     base to exist on. See api/store-issued-log/route.ts for the full note.
    //   · "(est.)" — the money comes off the closing-valuation ladder
    //     (last purchase price, else average cost), not off a specific bill.
    //   · "(master)" — the rate is the material master's default, not the rate
    //     on the bill this stock actually arrived on.
    // The rate cell is BLANK when no rate was ever entered: tax_percent is
    // NOT NULL DEFAULT 0, so a printed "0" would assert "GST does not apply"
    // when the data only ever said "nobody typed a rate". Same call as
    // api/inventory/export/route.ts (BLANK_WHEN_ZERO). The money columns still
    // print — equal to their ex-tax twin — because that IS the right figure when
    // no rate is stated.
    //
    // ── THE THREE LINE-LEVEL COLUMNS, SITTING WITH THE QUANTITY BLOCK ────────
    // Requested / Approved-Effective / Issued describe the requisition LINE, not
    // this hand-over, so they REPEAT identically across every event row of the
    // same line. That is the intent: read across a row and it says "asked 240,
    // approved 200, issued 200 so far" beside "this hand-over was 50". They sit
    // next to Qty (purchase) rather than at the end because that comparison is
    // the reason they exist.
    //   · All three are PURCHASE units (owner rule 2026-07-29), the same basis
    //     as "Issued Qty" two columns to their left, so nothing on the row needs
    //     converting in the reader's head.
    //   · NO "(purchase)" suffix on any of them — OWNER RULING 2026-08-27, after
    //     he read a download and asked why the issued column said "purchase":
    //     "Qty (purchase)" names the UNIT but reads as "quantity purchased",
    //     which is a different thing entirely and not what the column holds.
    //     The suffix was also redundant — "Purchase Unit" is the very next
    //     column and already states the unit. The old ambiguity note argued an
    //     unqualified "Issued Qty" beside "Qty (recipe)" would mislead; that is
    //     answered by naming the PAIR consistently ("Issued Qty" / "Issued Qty
    //     (recipe)") rather than by suffixing every column. The recipe twin
    //     keeps its qualifier only because two columns cannot share a header.
    //   · "to Date" on the Issued column, matching the label the sibling report
    //     already ships (src/lib/issue-log.ts: 'Issued To Date'). Without it,
    //     "Issued Qty to Date" beside the per-event "Issued Qty" would read as
    //     this hand-over's quantity — it is the LINE's cumulative
    //     quantity_issued, repeated on every event row of that line.
    //   · "Approved/Effective" because the figure is chef_approved_qty when the
    //     chef set one and quantity_requested when he did not — the effective
    //     quantity the fulfilment status itself is judged on. The rule lives in
    //     api/store-issued-log/route.ts, copied from store-issue/route.ts.
    // Blank, not 0, if a field is absent from the response: 0 would assert
    // "nothing was requested", the same call the GST rate cell makes below.
    // ── 'Source' IS APPENDED, NEVER INSERTED ─────────────────────────────────
    // The owner has saved spreadsheets built on this header order; every
    // existing column keeps its position and its text byte-for-byte, and the
    // one new column rides at the END. Values are 'Requisition' / 'Direct'.
    //
    // On a DIRECT row the three approval columns and 'Req #' print '—': a
    // vendor-direct delivery has no requested quantity, no chef approval and
    // no requisition number, and echoing anything else into them would
    // fabricate an approval that never happened. 'Issued Qty to Date' in
    // particular REMAINS a requisition-line aggregate (the line's cumulative
    // quantity_issued) and deliberately does NOT absorb direct transfers —
    // it sits between Requested and Approved on the same row and is read
    // against them; mixing vendor deliveries into it would break that
    // reconciliation. The '—' on every Direct row is what keeps the column
    // unmistakably requisition-only without moving a header byte.
    const headers = ['When', 'Material', 'Category', 'Issued Qty', 'Purchase Unit', 'Issued Qty (recipe)', 'Recipe Unit',
                     'Requested Qty', 'Approved/Effective Qty', 'Issued Qty to Date',
                     'Department', 'Req #', 'Issuer', 'Unit Cost', 'Unit Cost incl. GST (est.)',
                     'Value', 'Value incl. GST (est.)', 'GST % (master)', 'Purpose', 'Event', 'Note',
                     'Source'];
    const escape = (v: any) => {
      let s = v == null ? '' : String(v);
      // Formula-injection guard (CWE-1236), the house form used elsewhere in
      // this app: genuinely-numeric cells are skipped so signed numbers stay
      // summable in Excel instead of being coerced to text. Category, material
      // name and note are free text off the master and can start with '='.
      if (/^[=+\-@\t\r]/.test(s) && !Number.isFinite(Number(s))) s = "'" + s;
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.join(',')];
    for (const e of shown) {
      const isDirect = srcOf(e) === 'direct';
      lines.push([e.at, e.material_name, e.category ?? '', e.qty_purchase ?? e.qty, e.purchase_unit || e.unit,
                  e.qty, e.unit,
                  isDirect ? '—' : (e.requested_qty_purchase ?? ''),
                  isDirect ? '—' : (e.effective_qty_purchase ?? ''),
                  isDirect ? '—' : (e.issued_qty_purchase ?? ''),
                  e.department_name, isDirect ? '—' : e.req_number,
                  e.issuer, e.unit_cost?.toFixed?.(2), (e.unit_cost_incl_gst ?? e.unit_cost)?.toFixed?.(2),
                  e.value?.toFixed?.(2), (e.value_incl_gst ?? e.value)?.toFixed?.(2),
                  e.tax_known ? e.tax_percent : '',
                  e.purpose, e.event_name, e.note,
                  isDirect ? 'Direct' : 'Requisition'].map(escape).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    // The filename says when the export is a FILTERED slice of the log.
    const slice = srcFilter === 'all' ? '' : (srcFilter === 'direct' ? '-direct' : '-requisitions');
    a.download = `store-issued-log-${from}_to_${to}${slice}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-3">
      {/* Date range + CSV */}
      <div className="flex flex-wrap items-end gap-3 bg-white border border-[#E8D5C4] rounded-xl p-3">
        <label className="text-[11px] text-[#6B5744]">
          From
          <input type="date" value={from} onChange={e => onFromChange(e.target.value)}
                 className="ml-2 px-2 py-1 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </label>
        <label className="text-[11px] text-[#6B5744]">
          To
          <input type="date" value={to} onChange={e => onToChange(e.target.value)}
                 className="ml-2 px-2 py-1 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </label>
        {/* Source filter — Direct rows are vendor deliveries routed straight to a
            department (Settings → Direct Issue); they never crossed the store shelf
            but they ARE goods issued to a department, so they belong on this log. */}
        <div className="flex items-center gap-1 rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-0.5"
             role="group" aria-label="Filter by source">
          {([['all', 'All', counts.all], ['requisition', 'Requisitions', counts.requisition], ['direct', 'Direct', counts.direct]] as const).map(([key, label, n]) => (
            <button key={key} onClick={() => setSrcFilter(key)}
                    className={`px-2.5 py-1 rounded-md text-xs transition-colors ${srcFilter === key
                      ? 'bg-[#6B5744] text-white'
                      : 'text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
              {label}{n > 0 && <span className="ml-1 opacity-70">({n})</span>}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button onClick={downloadCsv} disabled={shown.length === 0}
                className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded text-sm disabled:opacity-50">
          ⬇ Download CSV
        </button>
        {/* Aggregation contract, spelled out where the download lives: the CSV's
            'Issued Qty to Date' is the requisition LINE's cumulative issued
            quantity and counts requisition hand-overs ONLY — Direct rows print
            '—' there (and in Requested / Approved: no approval ever happened). */}
        <div className="w-full text-[10px] text-[#8B7355]">
          CSV: <span className="font-medium">Issued Qty to Date</span> counts requisition hand-overs only — Direct vendor
          transfers are excluded and show &ldquo;—&rdquo; in the approval columns.
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard label="Issue events" value={totals.events.toLocaleString('en-IN')} tone="bg-amber-50 border-amber-200 text-amber-900" />
        <SummaryCard label="Approx. value" value={'₹' + Math.round(totals.total_value || 0).toLocaleString('en-IN')} tone="bg-emerald-50 border-emerald-200 text-emerald-900" />
        <SummaryCard label="Distinct items" value={String(totals.distinct_materials)} tone="bg-[#FFF1E3] border-[#D4B896] text-[#6B5744]" />
        <SummaryCard label="Departments served" value={String(totals.distinct_departments)} tone="bg-blue-50 border-blue-200 text-blue-900" />
      </div>

      {/* Table */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
          </div>
        ) : shown.length === 0 ? (
          <div className="p-10 text-center text-sm text-[#8B7355]">
            <CheckCircle2 className="w-7 h-7 mx-auto mb-2 text-emerald-500" />
            {srcFilter === 'all' ? 'No issue events in this date range.'
              : srcFilter === 'direct' ? 'No direct vendor transfers in this date range.'
              : 'No requisition hand-overs in this date range.'}
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF1E3] text-[#6B5744] sticky top-0">
                <tr>
                  <th className="text-left  py-2 px-2 font-medium">When</th>
                  <th className="text-left  py-2 px-2 font-medium">Material</th>
                  <th className="text-right py-2 px-2 font-medium" title="Handed over, in the PURCHASE unit. The small grey line is the recipe equivalent that Value was computed from.">Qty</th>
                  <th className="text-left  py-2 px-2 font-medium">To Dept</th>
                  <th className="text-left  py-2 px-2 font-medium"
                      title="Requisition number — or, on a row tagged Direct, the GRN/bill the vendor-direct delivery arrived on.">Req # / Source</th>
                  <th className="text-left  py-2 px-2 font-medium">Issued By</th>
                  <th className="text-right py-2 px-2 font-medium">Value</th>
                  <th className="text-left  py-2 px-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e, i) => {
                  const isDirect = srcOf(e) === 'direct';
                  return (
                  <tr key={i} className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 ${isDirect ? 'bg-amber-50/40' : ''}`}>
                    {/* A BACKDATED direct receipt files under its BILL date (day
                        precision — the server sends the day alone rather than
                        inventing a time); the grey line says when it was entered. */}
                    <td className="py-1.5 px-2 whitespace-nowrap">
                      {typeof e.at === 'string' && e.at.length === 10 ? fmtISTDate(e.at) : fmtDateTime(e.at)}
                      {isDirect && e.backdated && e.posted_at && (
                        <div className="text-[9px] text-[#B8A590]">entered {fmtISTShort(e.posted_at, { withTz: false })}</div>
                      )}
                    </td>
                    <td className="py-1.5 px-2 font-medium text-[#2D1B0E]">
                      {e.material_name}
                      {e.purpose === 'party' && e.event_name && (
                        <div className="text-[9px] text-[#8B7355]">party: {e.event_name}</div>
                      )}
                    </td>
                    {/* Lead with the PURCHASE figure — that is what the store
                        physically handed over. `qty` is RECIPE units (g, ml), which
                        reads as nonsense on a hand-over row ("issued 4 g of butter"),
                        so it is shown underneath only when the two differ, because it
                        is the number the Value column and the stock deduction use.
                        ?? / || fallbacks keep an older payload rendering.
                        A direct-receipt REVERSAL (void / downward amendment) is a
                        signed negative row — rose, so it cannot read as an issue. */}
                    <td className={`py-1.5 px-2 text-right font-mono font-semibold ${Number(e.qty) < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                      {fmtLogLead(e)}{' '}
                      <span className="text-[9px] text-[#8B7355]">{e.purchase_unit || e.unit}</span>
                      {Number(e.pack_factor) > 1 ? (
                        <div className="text-[9px] font-normal text-[#B8A590]">= {fmtNum(e.qty)} {e.unit}</div>
                      ) : fmtLogExact(e) ? (
                        <div className="text-[9px] font-normal text-[#B8A590]">= {fmtLogExact(e)} {e.purchase_unit || e.unit}</div>
                      ) : null}
                    </td>
                    <td className="py-1.5 px-2 text-[#6B5744]">{e.department_name || '—'}</td>
                    {/* Requisition number — or, tagged Direct, the GRN/bill the
                        vendor-direct delivery arrived on. */}
                    <td className="py-1.5 px-2 font-mono text-[10px] text-[#8B7355]">
                      {isDirect ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200 font-sans text-[9px] font-semibold uppercase tracking-wide">
                            Direct
                          </span>
                          {e.source_ref || '—'}
                        </span>
                      ) : e.req_number}
                    </td>
                    <td className="py-1.5 px-2 text-[#6B5744]">{e.issuer || '—'}</td>
                    <td className="py-1.5 px-2 text-right font-mono">
                      {Number(e.value) ? '₹' + Math.round(e.value).toLocaleString('en-IN') : '—'}
                    </td>
                    <td className="py-1.5 px-2 text-[#8B7355]">{e.note || '—'}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className={`border rounded-xl p-3 ${tone}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-xl font-bold font-mono mt-0.5">{value}</div>
    </div>
  );
}
