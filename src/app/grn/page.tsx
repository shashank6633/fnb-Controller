'use client';

/**
 * Goods Receipt Notes (GRN) — Phase 1 §5 page.
 * Listing + drill-down detail. GRNs are auto-created on PO receive.
 */

import { useEffect, useMemo, useRef, useState, Fragment, type ReactNode, type WheelEvent as ReactWheelEvent } from 'react';
import { FileCheck, ChevronDown, ChevronRight, Loader2, Plus, Trash2, X, Save, Download, Percent,
         Eye, Pencil, Printer, AlertTriangle, ChefHat, Wine, Clock, ShieldAlert, Info,
         CheckCircle2, ShieldQuestion, Receipt, Link2, Banknote } from 'lucide-react';
import { api } from '@/lib/api';
// THE duplicate rule — one material = one line — lives in exactly one module.
// src/lib/line-dedupe.ts imports NOTHING, which is the only reason a 'use client'
// page may touch it: po-helpers.ts, where this rule used to live alone, reaches
// @/lib/db → better-sqlite3 and would drag a native Node addon into the browser
// bundle. Never add an import to line-dedupe.ts.
import { duplicateLineGroups, SPLIT_RATE_REMEDY } from '@/lib/line-dedupe';
import { todayIST, fmtIST } from '@/lib/format-date';
import MaterialTypeahead from '@/components/MaterialTypeahead';
import Combobox from '@/components/Combobox';
// The house on/off switch. Used for "Paid in cash from petty cash" rather than a
// bare <input type="checkbox"> so the option reads as the deliberate, stateful
// choice it is — and so it matches every other toggle in the app.
import Toggle from '@/components/Toggle';
import { packFactor, fmtQtyNum } from '@/lib/pack-units';
import StockOnHandNote, { StockOnHandLegend } from '@/components/StockOnHandNote';
import { useStockOnHand } from '@/lib/use-stock-on-hand';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
/** ₹ with 2 decimals — for the inward register (taxes/charges carry paise). */
const m2 = (v: any) => '₹' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Bare 2-dp number for charge cells (0 shown muted). */
const q2 = (v: any) => (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0,10);
const minusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0,10); };
/** Subtract n days from a YYYY-MM-DD string (UTC math avoids DST/local drift). */
const isoMinusDays = (iso: string, n: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
};

/**
 * The GST rates this kitchen's bills actually carry. A fixed list, not a free
 * number box: a typo'd "1.8" on a ₹40,000 bill is a tax figure nobody catches
 * until the return is filed. Transcribed from purchases/page.tsx:60 — the two
 * manual purchase-entry surfaces must offer the SAME rate card.
 */
const GST_RATES = ['0', '5', '12', '18', '28'] as const;

/**
 * Client-side mirror of store-engine's SQL catNorm(): lower-case, then strip
 * spaces / hyphens / underscores, so 'Single-Malt Whiskey', 'single malt
 * whiskey' and 'singlemaltwhiskey' all compare equal. Both sides of every
 * store_category_map ↔ raw_materials.category comparison must use it, or a
 * liquor category spelled with a hyphen goes unrecognised and gets taxed.
 */
const catKey = (s: unknown) => String(s || '').trim().toLowerCase().replace(/[\s\-_]/g, '');

/** Round to paisa. Every derived money figure on this form goes through here. */
const r2 = (v: number) => Math.round((Number(v) || 0) * 100) / 100;

/* GRN Inward line (entry form). The seven hand-typed ₹ charge fields mirror the
   sheet: Discount, CGST, SGST, Special Excise Cess, TCS, Delivery Charges, MRP
   Round Off. GST COMPENSATION CESS is the eighth charge and is DERIVED ONLY —
   it has a rate box and no ₹ box (see cess_rate below).
   SUBTOTAL = received × rate; TOTAL INWARD = subtotal − discount + cgst + sgst
   + comp. cess + special excise cess + tcs + delivery + round-off.
   gst_rate / cess_rate are WIRE/UI fields only — like /api/purchases, the stored
   row carries the derived rupees, never the rate. Kept as raw STRINGs so a
   decimal stays typeable and '' can mean "no rate on this line".
   For gst_rate '' additionally means "Manual (type the ₹ yourself)"; cess_rate
   has no manual counterpart, so '' there simply means no cess.
   THE TWO RATES DO NOT SHARE A TAXABLE BASE — see lineTax / lineCess. */
interface GrnLine {
  material_id: string; quantity_received: string; quantity_accepted: string;
  rejection_reason: string; unit_price: string; notes: string;
  /**
   * Free text, per line — carried over from "Enter Full Bill", which had it and
   * this form did not. Mirrored to purchases.brand by POST /api/grn.
   * ⚠ It survives an UNHELD receipt only: goods_receipt_note_items has no brand
   * column, so a QC-held bill's mirror (written later by grn-qc.ts) and an amend
   * replay (grn-reversal.ts) both write ''. Stated on the field itself.
   */
  brand: string;
  /**
   * 'btl' = the typed quantity is purchase units and the rate is ₹ per purchase
   * unit (the default). 'case' = the quantity is CASES and the rate is ₹ per
   * CASE.
   *
   * ⚠ THE EXPANSION IS THE SERVER'S, NOT THIS FORM'S. `entry_mode` rides to
   * POST /api/grn and normaliseCaseEntry() there multiplies the quantity and
   * divides the rate. THE BUG THAT WAS FIXED TWICE was exactly this arithmetic
   * living in two browsers; it now lives in the one writer. This form may show
   * the toggle and label the boxes from it — it must never do the maths.
   */
  entry_mode: 'btl' | 'case';
  gst_rate: string;
  /** GST compensation cess %, seeded from raw_materials.cess_percent. */
  cess_rate: string;
  discount: string; cgst: string; sgst: string; special_excise_cess: string;
  tcs: string; delivery_charges: string; mrp_round_off: string;
}
/**
 * A line's `gst_rate` when it FOLLOWS THE BILL-LEVEL RATE — the third state, and
 * it has to be a third state because on this form '' already means something
 * else and something opposite.
 *
 *   'bill'  → use the bill-level GST %. The default for a fresh line, and what
 *             "Enter Full Bill" meant by its own ''.
 *   ''      → MANUAL: no rate at all, the clerk types the CGST/SGST rupees.
 *             This is /grn's pre-existing meaning and the manual path is live;
 *             it must stay reachable, so it stays an explicit choice.
 *   '5'…    → this line's own rate, whatever the bill's default is.
 *
 * Never posted as-is: resolveGst() below turns 'bill' into a number (or into
 * "manual") before the payload is built. POST /api/grn reads a missing gst_rate
 * as "store the hand-typed ₹", so sending the sentinel would silently untax the
 * line.
 */
const BILL_GST = 'bill';
const blankLine = (): GrnLine => ({
  material_id: '', quantity_received: '', quantity_accepted: '', rejection_reason: '', unit_price: '', notes: '',
  brand: '', entry_mode: 'btl',
  gst_rate: BILL_GST, cess_rate: '',
  discount: '', cgst: '', sgst: '', special_excise_cess: '', tcs: '', delivery_charges: '', mrp_round_off: '',
});
const n0 = (s?: string) => { const v = Number(s); return Number.isFinite(v) ? v : 0; };
/** SUBTOTAL = inward qty × rate. */
const lineSubtotal = (l: GrnLine) => n0(l.quantity_received) * n0(l.unit_price);
/**
 * ONE LINE'S SHARE OF THE TWO BILL-LEVEL CHARGES, in rupees.
 *
 * "Enter Full Bill" took ONE Discount and ONE Delivery figure for the whole bill
 * (By % or By Amount) and split them across the lines in proportion to each
 * line's goods value; this form had per-line rupees only. Both survive: the
 * per-line box is the line's OWN charge, the share is this line's slice of the
 * bill-level one, and every reader below adds them. The payload sends the SUM,
 * because `purchases.discount` and `goods_receipt_note_items.discount` are one
 * column each and a bill cannot record two kinds of discount separately.
 */
interface LineShare { discount: number; delivery: number }
const NO_SHARE: LineShare = { discount: 0, delivery: 0 };
/** TOTAL INWARD AMOUNT for a line (same formula the server + register use).
 *  `tax` overrides the two hand-typed ₹ boxes with the figures derived from the
 *  line's GST% — pass it wherever a rate is in play, or the screen total lags
 *  the rate the clerk just picked. Every other term is untouched.
 *  `cess` is the GST COMPENSATION CESS ₹ (lineCess().cess). It has no hand-typed
 *  box to fall back on — there is no `l.compensation_cess` — so it is always
 *  passed in or absent, and it is a SEPARATE term: never folded into cgst/sgst
 *  (that sum is a GST-return figure) and never into special_excise_cess (that
 *  column means the TGBCL levy).
 *  `share` is the line's slice of the two BILL-LEVEL charges. Defaulted to zero
 *  so every pre-existing call site (the saved-GRN views, which have no bill-level
 *  entry at all) keeps reading exactly what it read before. */
const lineTotal = (l: GrnLine, tax?: { cgst: number; sgst: number }, cess?: number, share: LineShare = NO_SHARE) =>
  lineSubtotal(l) - n0(l.discount) - share.discount
  + (tax ? tax.cgst : n0(l.cgst)) + (tax ? tax.sgst : n0(l.sgst))
  + (cess || 0)
  + n0(l.special_excise_cess)
  + n0(l.tcs) + n0(l.delivery_charges) + share.delivery + n0(l.mrp_round_off);
/** Same TOTAL formula for a saved GRN item row (server fields). */
const itemInwardTotal = (it: any) =>
  (Number(it.quantity_received) || 0) * (Number(it.unit_price) || 0)
  - (Number(it.discount) || 0) + (Number(it.cgst) || 0) + (Number(it.sgst) || 0)
  + (Number(it.compensation_cess) || 0)
  + (Number(it.special_excise_cess) || 0) + (Number(it.tcs) || 0)
  + (Number(it.delivery_charges) || 0) + (Number(it.mrp_round_off) || 0);

/** By % of the goods subtotal, or a flat ₹ figure. Transcribed from
 *  purchases/page.tsx's billCalc — the two forms resolved a bill-level charge
 *  the same way and the moved one must not start rounding differently. */
const pctOrFlat = (mode: 'percent' | 'amount', raw: string, subtotal: number) => {
  const v = parseFloat(raw) || 0;
  if (v <= 0) return 0;
  return mode === 'percent' ? r2(subtotal * v / 100) : v;
};

/**
 * One bill-level charge row: By % / By Amount + the resolved ₹ figure.
 * Shared by Delivery Charges and Discount so the two always look and behave the
 * same — the only difference is what each does to cost, which `hint` states.
 * Transcribed from src/app/purchases/page.tsx, where "Enter Full Bill" lived.
 */
function ChargeRow({ label, hint, mode, value, onMode, onValue, placeholder, total, tone, negative }: {
  label: string; hint: string;
  mode: 'percent' | 'amount'; value: string;
  onMode: (m: 'percent' | 'amount') => void;
  onValue: (v: string) => void;
  placeholder: string; total: number; tone: string; negative?: boolean;
}) {
  const name = 'grn-' + label.replace(/\s+/g, '-').toLowerCase();
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-xs font-medium text-[#6B5744] min-w-[130px]">
        {label}
        <span className="block text-[10px] font-normal text-[#8B7355]">{hint}</span>
      </span>
      <div className="flex items-center gap-2">
        {(['percent', 'amount'] as const).map(m => (
          <label key={m} className="flex items-center gap-1.5 cursor-pointer">
            {/* name= groups the pair, so the two rows don't share a selection */}
            <input type="radio" name={name} checked={mode === m} onChange={() => onMode(m)} className="accent-[#af4408]" />
            <span className="text-xs text-[#6B5744]">{m === 'percent' ? 'By %' : 'By Amount'}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-1">
        {mode === 'amount' && <span className="text-xs text-[#8B7355]">₹</span>}
        <input
          type="number" step="0.01" min="0" value={value}
          onChange={e => onValue(e.target.value)}
          placeholder={placeholder}
          className="w-28 px-2 py-1.5 bg-white border border-[#E8D5C4] rounded-lg text-xs text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
        />
        <span className="text-xs text-[#8B7355]">{mode === 'percent' ? '%' : ''}</span>
      </div>
      <span className={`text-xs font-medium ml-auto font-mono ${tone}`}>
        {negative && total > 0 ? '- ' : ''}{m2(total)}
      </span>
    </div>
  );
}

/* ============================================================ */
/* THE KITCHEN QC GATE, as this page has to speak about it.     */
/*                                                              */
/* A delivery in a category the admin mapped to a checker is    */
/* saved as `awaiting_qc` and MOVES NO STOCK until the checking */
/* department signs (src/lib/grn-qc.ts). That is not an error   */
/* and it is not something the receiving desk did wrong — it is */
/* the vendor still being at the bay while the goods are        */
/* judged. Everything below exists so this page says that in    */
/* those words rather than showing an unstyled badge and a ₹0   */
/* accepted column the store person has to guess about.         */
/* ============================================================ */

/** Who owes the check. Same vocabulary as grn-qc.ts's QcChecker. 'both' means
 *  EITHER department may sign — NOT that two signatures are required. */
type QcChecker = 'none' | 'kitchen' | 'bar' | 'both';
const CHECKER_LABEL: Record<string, string> = {
  kitchen: 'Kitchen', bar: 'Bar', both: 'Kitchen or Bar', none: 'No check',
};
/** Wording transcribed VERBATIM from the printed GRN sheet
 *  (src/app/grn/print/[id]/page.tsx:82) and from the sign-off queue
 *  (src/app/grn/qc/page.tsx:279) — the paper, the queue and this page must not
 *  describe the same six checks in three different phrasings. `short` is the
 *  chip label for the detail panel, where the long form does not fit. */
type QcKey = 'qc_quality' | 'qc_temperature' | 'qc_expiry' | 'qc_damage' | 'qc_weight' | 'qc_invoice_match';
interface QcFieldDef { k: QcKey; label: string; short: string }
/** THE KITCHEN / BAR HALF of the owner's decision-4 split. On a gated receipt
 *  these are stamped by POST /api/grn/[id]/qc alongside qc_kitchen_by/at, and
 *  PUT /api/grn/[id] REFUSES to let the receiving desk amend them
 *  (src/app/api/grn/[id]/route.ts:356) — the whole point being that the person
 *  who took the delivery in must not also certify its quality. */
const KITCHEN_QC_FIELDS: QcFieldDef[] = [
  { k: 'qc_quality',     label: 'Quality OK (look · smell · feel)',            short: 'Quality' },
  { k: 'qc_temperature', label: 'Temperature within range (cold-chain items)', short: 'Temperature' },
  { k: 'qc_damage',      label: 'No visible damage / leak / pest',             short: 'No damage' },
];
/** THE STORE HALF — the receiving desk's own three, on every receipt. All three
 *  together are what stamps qc_store_by/qc_store_at on POST /api/grn
 *  (src/app/api/grn/route.ts:502); a partial tick is deliberately left unsigned
 *  rather than stamped with a name. */
const STORE_QC_FIELDS: QcFieldDef[] = [
  { k: 'qc_expiry',        label: 'Expiry / use-by date checked',          short: 'Expiry' },
  { k: 'qc_weight',        label: 'Weight / count verified vs invoice',    short: 'Weight' },
  { k: 'qc_invoice_match', label: 'Invoice matches PO (rate, qty, vendor)', short: 'Invoice match' },
];
/** Store first, then kitchen — the order the receiving desk meets them. Used to
 *  name the six ticks in the amendment trail, where "QC · Quality" alone left a
 *  reader unable to tell whose answer had been changed. */
const QC_OWNER_LABEL: Record<string, string> = Object.fromEntries([
  ...STORE_QC_FIELDS.map(f => [f.k, `Store check · ${f.short}`]),
  ...KITCHEN_QC_FIELDS.map(f => [f.k, `Kitchen QC · ${f.short}`]),
]);

/** How long it has waited, in words a person uses at 6am. Same shape as
 *  grn/qc/page.tsx:223 so the two screens never phrase one wait two ways. */
const waitedFor = (hours: number): string => {
  const h = Number(hours) || 0;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 24) return `${Math.round(h * 10) / 10} hr`;
  const d = Math.floor(h / 24);
  const r = Math.round(h - d * 24);
  return r ? `${d}d ${r}h` : `${d}d`;
};
/** Hours since a SQLite `datetime('now')` stamp — NULL, never 0, when it cannot
 *  be read. A stamp coerced to 0 would print "1 min" on a delivery that has sat
 *  since yesterday, quietly reversing the one number this treatment exists to
 *  make loud. Only used as the FALLBACK when /api/grn/qc did not answer; the
 *  server's own waiting_hours is preferred so this page and the queue agree. */
const hoursSince = (stamp: string | null | undefined): number | null => {
  if (!stamp) return null;
  const s = String(stamp);
  const d = new Date(s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / 3600000;
};

interface GRN {
  id: string; grn_number: string; date: string; time?: string;
  po_id?: string; po_number?: string;
  vendor_id?: string; vendor?: string;
  invoice_number?: string; invoice_date?: string;
  received_by?: string; qc_by?: string;
  /** 'void' = the bill was cancelled and the stock it added was reversed. The
   *  DOCUMENT is kept (header + line items) — see DELETE /api/grn/[id].
   *  'awaiting_qc' = RECORDED BUT NOT OURS YET: the document exists, the goods
   *  are on the bay, and NOTHING has been added to stock. It is not a grade of
   *  receipt and not a failure — see the QC block above. */
  status: 'received' | 'awaiting_qc' | 'partial' | 'rejected' | 'void';
  notes?: string;
  /* ── QC stamps. Plain columns on goods_receipt_notes, so `SELECT g.*` ships
        them to every reader of GET /api/grn — no query change was needed. All
        optional: a payload from before the gate existed simply has none, and
        `qc_required` absent reads the same as 0 (never gated). ── */
  created_at?: string;
  qc_required?: number;
  qc_checker?: string;
  /** 'pending' | 'signed' | 'override' | 'rejected' | '' (never gated). */
  qc_outcome?: string;
  qc_kitchen_by?: string | null; qc_kitchen_at?: string | null;
  qc_store_by?: string | null;   qc_store_at?: string | null;
  qc_override_by?: string | null; qc_override_at?: string | null; qc_override_reason?: string | null;
  qc_applied_at?: string | null;
  qc_escalated_at?: string | null;
  qc_quality?: number; qc_temperature?: number; qc_expiry?: number;
  qc_damage?: number; qc_weight?: number; qc_invoice_match?: number;
  line_count: number;
  total_rejected: number;
  /** How many DISTINCT purchase units the rejected lines span (0 = none rejected).
   *  total_rejected is only a printable quantity when this is exactly 1. */
  rejected_unit_count?: number;
  rejected_unit?: string | null;
  rejected_lines?: number;
  accepted_value: number;
  inward_value: number;
  /* ── Void stamps. Shipped to EVERY reader (a void is a fact about the
        document, not an admin secret) — the row is struck through for all. ── */
  voided_at?: string | null;
  voided_by?: string | null;
  void_reason?: string | null;
  /* ── Amendment stamps. ADMIN ONLY, and stripped SERVER-SIDE (api/grn GET's
        stripEditStamps) — a non-admin payload simply has no such fields, so the
        "edited" marker below cannot render for them even with devtools open.
        Optional here for exactly that reason: absent ≠ "never edited", it means
        "not your business", and both render the same (no marker). ── */
  edited_at?: string | null;
  edited_by?: string | null;
  edit_count?: number;
}

const STATUS_TONE: Record<string, string> = {
  received: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  // BLUE, NOT AMBER OR RED, and the choice is load-bearing. Amber here would
  // collide with 'partial', which means goods really were turned away, and red
  // would tell the store person they made a mistake — they did not; they
  // recorded a delivery that is waiting on somebody else. Blue is also the
  // family the receiving checklist already uses on this page, so "awaiting a
  // check" and "the check" read as one thing.
  awaiting_qc: 'bg-blue-100 text-blue-800 border-blue-200',
  partial:  'bg-amber-100 text-amber-800 border-amber-200',
  rejected: 'bg-red-100 text-red-700 border-red-200',
  // Deliberately NOT a status colour — a void is not a grade of receipt. Slate
  // on the page's own muted palette, so it reads as "withdrawn", and the row
  // around it is greyed + struck through.
  void:     'bg-[#EFE7DE] text-[#6B5744] border-[#B8A590] line-through',
};
/** The badge caption. Only the new state is renamed: `awaiting_qc` is a column
 *  value, not English, and the badge is the first place the store person looks
 *  when their stock has not appeared. Everything else keeps the stored word so
 *  the screen and the register CSV still say the same thing. */
const STATUS_LABEL: Record<string, string> = { awaiting_qc: 'awaiting kitchen QC' };
const statusLabel = (s: string) => STATUS_LABEL[s] || s;

/* ══ WHERE THE DOCUMENT CAME FROM ═══════════════════════════════════════════
   Every hand-typed vendor bill is a GRN now, so this register holds two
   genuinely different documents side by side:
     · DIRECT     — a bill with no purchase order behind it (a cash buy, a
                    standing vegetable supplier, a sample, a donation)
     · AGAINST PO — goods received against something that was ordered
   Until now the only thing separating them was an em-dash in the Linked PO
   column, which is an ABSENCE: you had to already know what a blank meant, and
   after the move the blanks became the majority.

   THE FACT IS `po_id` AND NOTHING ELSE — the same column DELETE keys its PO
   reversal off, and the same column the server's ?source filter, the print
   sheet and the register CSV read. TRIMMED rather than truthy, deliberately:
   an empty string is a direct bill, and matching the server's
   `TRIM(g.po_id) <> ''` here is the only way the four surfaces can never
   disagree about one row. Never re-derive this from `po_number` — that comes
   off a LEFT JOIN and is null for a PO row whose order was removed, which
   would relabel a PO receipt as direct. */
const isPoSourced = (g: { po_id?: string | null }) => String(g?.po_id ?? '').trim() !== '';

/** THE TWO WORDS, WRITTEN ONCE. The picker's buttons, the chip, the empty
 *  state, the QC banner and the export filename all read them from here, so a
 *  sentence about the filter can never call it something the button does not
 *  say. (The CSV's own BILL TYPE cell is deliberately NOT one of these — it is
 *  the server's uppercase DIRECT / AGAINST PO, computed by BILL_TYPE_SQL, so
 *  the file keeps one authority and never re-derives its own label.) */
const SOURCE_LABEL: Record<'direct' | 'po', string> = { direct: 'Direct', po: 'Against PO' };

/** The source chip. LABELLED ON EVERY ROW, never a blank to interpret.
 *
 *  DELIBERATELY NOT A STATUS CHIP, and not by colour alone. The status chips
 *  beside it are SOLID TINTS (emerald / blue / amber / red / slate) carrying a
 *  stored status word; the amber Superseded-and-QC pills elsewhere are solid
 *  amber. This one is an OUTLINE on a light ground, in small caps with letter
 *  spacing and its own icon — a different family of thing, readable as "what
 *  kind of document" rather than "what state it is in". The two variants then
 *  differ by WORD and by ICON as well as by colour, so a reader who cannot
 *  separate terracotta from clay still reads DIRECT vs AGAINST PO.
 *
 *  Terracotta for AGAINST PO is not decoration: it is the same #af4408 as the
 *  PO number link printed immediately beside it, which ties the chip and the
 *  number together as one statement. No status uses it.
 *
 *  NEVER STRUCK THROUGH on a voided row. The strike says the RECEIPT no longer
 *  counts; where the bill came from is still true, and a line through 9px small
 *  caps is unreadable anyway.
 *
 *  MUTED — NOT STRUCK, NOT DROPPED — ON A VOIDED ROW. A void row is greyed to
 *  #8B7355 with every other cell struck through; a full-strength terracotta chip
 *  in the middle of that would be the brightest thing in a row whose whole
 *  design says "this no longer counts", and the eye would land on the withdrawn
 *  bills first. `muted` keeps the WORD and the ICON at full legibility (the
 *  label must never become a blank again — that is the entire point of the chip)
 *  and takes the colour out, which is the part that was shouting. The two
 *  variants still differ by word and icon when muted, so the distinction
 *  survives the greying. */
function SourceChip({ poSourced, muted = false, className = '' }:
                    { poSourced: boolean; muted?: boolean; className?: string }) {
  return (
    <span
      title={poSourced
        ? 'Against a purchase order — these goods were ordered first, and this receipt is booked against that order.'
        : 'Direct bill — no purchase order behind it (a cash buy, a standing supplier, a sample, a donation or a return). Recorded straight onto the register.'}
      className={`inline-flex items-center gap-1 shrink-0 whitespace-nowrap rounded-sm border px-1.5 py-px text-[9px] font-sans font-semibold uppercase tracking-[0.08em] ${
        muted
          ? 'border-[#C9B9A5] bg-white/70 text-[#8B7355]'
          : poSourced
            ? 'border-[#af4408] bg-white text-[#af4408]'
            : 'border-[#B8A590] bg-[#FFF8F0] text-[#6B5744]'} ${className}`}>
      {poSourced ? <Link2 className="w-2.5 h-2.5" /> : <Receipt className="w-2.5 h-2.5" />}
      {poSourced ? SOURCE_LABEL.po : SOURCE_LABEL.direct}
    </span>
  );
}

/** Is this receipt still holding its goods at the bay? */
const isHeld = (g: { status: string }) => g.status === 'awaiting_qc';
/** Was this receipt EVER put through the gate — including after it cleared?
 *  Drives the split checklist and the "who signed" stamps on a decided bill. */
const wasGated = (g: { qc_required?: number }) => Number(g?.qc_required) === 1;

/** One held receipt as GET /api/grn/qc reports it. Only the fields this page
 *  renders — the queue payload carries more. */
interface QcQueueRow {
  id: string; grn_number: string; qc_checker: string;
  /** Server-computed, from goods_receipt_notes.created_at. */
  waiting_hours: number;
  /** Past the admin's escalation threshold. A SETTING, not a constant — which
   *  is exactly why this is read from the server rather than derived here. */
  overdue: boolean;
  /** May the CALLER sign this one? Advisory; the write re-derives it. */
  can_sign?: boolean;
  qc_escalated_at?: string | null;
}
interface QcCtx {
  rows: Record<string, QcQueueRow>;
  pending: number; overdue: number; escalationHours: number;
  canOverride: boolean;
}

/** Who voided this bill and when, in one line — used on the row and in the panel. */
const voidedBadgeText = (g: { voided_by?: string | null; voided_at?: string | null }) =>
  `Voided${g.voided_by ? ` by ${g.voided_by}` : ''}${g.voided_at ? ` on ${fmtIST(g.voided_at)}` : ''}`;

export default function GrnPage() {
  const [list, setList] = useState<GRN[]>([]);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(minusDays(30));
  const [to, setTo] = useState(today());
  const [statusFilter, setStatusFilter] = useState('');
  /** '' | 'direct' | 'po' — WHERE the document came from, filtered SERVER-SIDE
   *  (?source=) rather than in the browser, so the list, the counters and the
   *  Inward Register download are all the same slice. It COMPOSES with the date
   *  range and the status buttons — it is its own picker and never touches
   *  them, so "direct bills that are still awaiting QC" is one screen. */
  const [sourceFilter, setSourceFilter] = useState<'' | 'direct' | 'po'>('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  /* ── /grn?new=1 OPENS THE BILL FORM STRAIGHT AWAY ───────────────────────────
   * Purchases' "Enter Vendor Bill" button links here. Landing on the LIST meant
   * the storekeeper pressed a second, identically-labelled button before they
   * could type anything — an extra navigation and an extra click on the job they
   * do every morning, added to the exact screen we want them using instead of
   * the ungated CSV importer sitting beside that link.
   *
   * window.location, not useSearchParams: this is a one-shot read on mount, and
   * the hook would put this whole page under a Suspense boundary for a prerender
   * concern that does not apply to a flag we consume once.
   * The flag is STRIPPED from the URL afterwards so a refresh, or a Back into
   * this page, does not reopen the form on top of whatever is on screen.
   * DEFERRED BY A TICK, and that is not superstition: the App Router re-syncs
   * the address bar to its own route state after this effect commits, so a
   * replaceState called inline is overwritten and the flag stays in the URL
   * (observed in the running app). One tick later it sticks. The timer is
   * cleared on unmount so a fast navigation away cannot rewrite the URL of the
   * page that replaced this one.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search);
    if (p.get('new') !== '1') return;
    setCreating(true);
    const t = setTimeout(() => {
      const q = new URLSearchParams(window.location.search);
      q.delete('new');
      const qs = q.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }, 0);
    return () => clearTimeout(t);
  }, []);
  /**
   * Is the signed-in user an admin? THREE-STATE, and null (= "not answered
   * yet / the answer did not arrive") is NOT the same as false for anything but
   * rendering: only `isAdmin === true` reveals the Delete control, so a failed
   * or half-finished load hides it rather than offering an action the server
   * will refuse. It is advisory UI state either way — DELETE /api/grn/[id]
   * re-checks the role with requireRole('admin'), which fails closed.
   */
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  /**
   * May this user amend a committed bill? Same three-state discipline as
   * isAdmin, and the same reason: PUT /api/grn/[id] is limited to the store
   * manager / a manager / an admin (it rewrites purchases.vendor and
   * purchases.bill_no, the spend ledger and the duplicate-bill guard), so a
   * waiter who can reach this page must not be shown a pencil that 403s.
   * Advisory UI state — the server re-derives the bar and fails closed.
   */
  const [canAmend, setCanAmend] = useState<boolean | null>(null);
  /** Bumped after any amend/void so every expanded row drops its cached detail
   *  and re-fetches. GrnRow caches `detail` for the life of the row and the row
   *  survives a list reload (keyed by id), so without this the panel would keep
   *  showing the bill as it was before the edit. */
  const [dataVersion, setDataVersion] = useState(0);
  const [editing, setEditing] = useState<GRN | null>(null);
  const [voiding, setVoiding] = useState<GRN | null>(null);
  const [overriding, setOverriding] = useState<GRN | null>(null);

  /**
   * THE HOLD CONTEXT — one call to GET /api/grn/qc, the same endpoint the
   * Pending Quality Checks queue reads.
   *
   * WHY NOT COMPUTE IT HERE. The row already carries `created_at`, so this page
   * COULD subtract two dates and print a wait — and would then disagree with
   * the queue the moment the escalation threshold moved, because "overdue" is a
   * setting, not a constant. The server computes `waiting_hours` and `overdue`
   * with the functions the bell counts with, so both screens and the badge can
   * never tell three stories about one delivery. hoursSince() below is only the
   * fallback for when this call did not answer.
   *
   * OPEN TO EVERY SIGNED-IN USER, deliberately (see the route's header): it
   * shows a subset of the rows /api/grn already shows. `can_override` rides on
   * it, which is how this page knows whether to offer the release control
   * WITHOUT a second /api/auth/me round trip — and it is the only way to know,
   * since the GRN list payload carries `is_admin` but not `is_head_chef`, and a
   * head chef may override too.
   *
   * ADVISORY. POST /api/grn/[id]/qc re-derives every gate from the session.
   */
  const [qcCtx, setQcCtx] = useState<QcCtx | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await fetch('/api/grn/qc').then(r => (r.ok ? r.json() : null));
        if (!alive) return;
        if (!d) { setQcCtx(null); return; }
        const rows: Record<string, QcQueueRow> = {};
        for (const r of (Array.isArray(d.rows) ? d.rows : []) as QcQueueRow[]) {
          if (r?.id) rows[String(r.id)] = r;
        }
        setQcCtx({
          rows,
          pending: Number(d.pending_count) || 0,
          overdue: Number(d.overdue_count) || 0,
          escalationHours: Number(d.escalation_hours) || 0,
          // Fails closed on anything but a literal true, exactly like isAdmin.
          canOverride: d.can_override === true,
        });
      } catch { if (alive) setQcCtx(null); }
    })();
    return () => { alive = false; };
  }, [dataVersion]);

  /** ONLY THE NEWEST REQUEST MAY PAINT. There are now three pickers firing this
   *  (dates, status, source) plus every post-write refresh, and two clicks in
   *  quick succession are two fetches racing: without this the SLOWER one can
   *  land last and paint a list that disagrees with the button lit above it —
   *  a filter that lies, and the harder kind to spot because nothing looks
   *  broken. A stale response now returns without touching state, and `loading`
   *  is left ON for the request still in flight to clear. */
  const reqSeq = useRef(0);
  const reload = async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    const qs = new URLSearchParams({ from, to }); if (statusFilter) qs.set('status', statusFilter);
    if (sourceFilter) qs.set('source', sourceFilter);
    const d = await fetch(`/api/grn?${qs}`).then(r => r.json()).catch(() => null);
    if (seq !== reqSeq.current) return;
    setList(d?.grns || []);
    // Absent / non-boolean → false. The row actions fail closed on anything but
    // a literal true from a payload that actually arrived.
    setIsAdmin(d ? d.is_admin === true : null);
    setCanAmend(d ? d.can_amend === true : null);
    setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [from, to, statusFilter, sourceFilter]);
  /** One post-write refresh path: re-read the list AND invalidate row details. */
  const afterWrite = () => { setDataVersion(v => v + 1); reload(); };

  // Download the flat inward register (one row per LINE) in the sheet's column
  // order + our extras, for the current date range + status filter + source.
  const [exporting, setExporting] = useState(false);
  const downloadRegister = async () => {
    setExporting(true);
    try {
      const qs = new URLSearchParams({ register: '1', from, to }); if (statusFilter) qs.set('status', statusFilter);
      // The register follows the SAME source picker as the screen — a register
      // that quietly re-included the PO bills the reader had just filtered out
      // would be a different document from the one they were looking at.
      if (sourceFilter) qs.set('source', sourceFilter);
      const d = await fetch(`/api/grn?${qs}`).then(r => r.json());
      const rows: any[] = d.rows || [];
      if (!rows.length) {
        alert(sourceFilter
          ? `No ${sourceFilter === 'po' ? 'against-PO' : 'direct'} inward lines in this date range.`
          : 'No inward lines in this date range.');
        return;
      }
      // Formula-injection guard — but only for genuinely non-numeric cells, so
      // signed numbers (negative MRP round-off, back-correction qtys/totals)
      // stay as real numbers Excel can sum (not text). Number('') is 0 → fine.
      const clean = (v: any) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s) && !Number.isFinite(Number(s))) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      // COMPENSATION CESS sits between SGST and SPECIAL EXCISE CESS — the order
      // db.ts's Total Inward term list uses. The two "cess" columns are different
      // levies and must never be read as one: COMPENSATION CESS is the GST-regime
      // cess (raw_materials.cess_percent, charged on the gross line value before
      // discount), SPECIAL EXCISE CESS is the TGBCL liquor levy off the store bill.
      // BILL TYPE is APPENDED, never inserted. The 26 columns before it match a
      // sheet the owner already works in, and a filed register whose columns
      // moved is a register nobody trusts — so the distinction arrives as a 27th
      // column at the end. It is its own column and overloads none of the
      // others: STATUS is what happened to the receipt, BILL TYPE is what kind
      // of document it is, and folding the two together would lose one of them.
      const header = ['GRN No.', 'INVOICE ID', 'INWARD DATE', 'SUPPLIER NAME', 'CATEGORY NAME', 'ITEM NAME',
        'PO QTY', 'INWARD QTY', 'PURCHASE UNIT', 'RATE', 'SUBTOTAL', 'DISCOUNT', 'CGST', 'SGST',
        'COMPENSATION CESS', 'SPECIAL EXCISE CESS', 'TCS', 'DELIVERY CHARGES', 'MRP ROUND OFF', 'TOTAL INWARD AMOUNT',
        'ACCEPTED QTY', 'REJECTED QTY', 'REJECT REASON', 'STATUS', 'RECEIVED BY', 'INVOICE DATE', 'BILL TYPE'];
      const lines = [header.join(',')];
      for (const r of rows) lines.push([
        r.grn_number, r.invoice_number, r.inward_date, r.supplier, r.category_name, r.item_name,
        r.po_qty, r.inward_qty, r.purchase_unit, r.rate, r.subtotal, r.discount, r.cgst, r.sgst,
        r.compensation_cess, r.special_excise_cess, r.tcs, r.delivery_charges, r.mrp_round_off, r.total_inward_amount,
        r.quantity_accepted, r.quantity_rejected, r.rejection_reason, r.status, r.received_by, r.invoice_date,
        // Computed by the register SQL (one CASE over g.po_id), never re-derived
        // here — one rule, one place, so the file and the screen cannot drift.
        r.bill_type,
      ].map(clean).join(','));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      // THE FILENAME SAYS WHAT SLICE THIS IS. A register downloaded under Source
      // = Direct is not the register — it is part of it — and two files that
      // differ by twenty rows landing in the same folder as
      // "…register-A_to_B.csv" and "…register-A_to_B (1).csv" is a filing
      // hazard on exactly the file the owner asked to be able to file. The
      // BILL TYPE column tells a reader what each ROW is; only the name can tell
      // them the FILE is a slice. Unfiltered keeps the name it has always had,
      // so nothing that already points at that file moves. Kept in step with the
      // server's own csv branch in src/app/api/grn/route.ts.
      const slice = sourceFilter ? `-${sourceFilter === 'po' ? 'against-PO' : 'direct'}` : '';
      a.href = url; a.download = `GRN-inward-register-${from}_to_${to}${slice}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } finally { setExporting(false); }
  };

  const counts = useMemo(() => {
    // No cross-GRN quantity total here on purpose: rejected qtys are PURCHASE
    // units of different materials (kg + BTL + pcs) and summing them produces a
    // number that means nothing. Only the ₹ roll-up is addable. (An unrendered
    // total_rejected_qty accumulator used to sit here — removed so nobody
    // "helpfully" prints it later.)
    const c = { received: 0, awaiting_qc: 0, partial: 0, rejected: 0, void: 0,
                accepted_value: 0, awaiting_value: 0 };
    for (const g of list) {
      c[g.status] = (c[g.status] || 0) + 1;
      // A VOIDED bill's stock and cost rows have been reversed — its value is no
      // longer money this kitchen received. Counting it here would restate the
      // period's inward total upwards for ever. It keeps its own counter instead,
      // so the bills are still visibly accounted for rather than vanishing.
      if (g.status !== 'void') c.accepted_value += g.accepted_value || 0;
      // A HELD bill contributes ₹0 to Σ accepted ON ITS OWN — every line's
      // quantity_accepted is 0 until the checking department decides, so no
      // exclusion is needed here and none is added. What IS needed is the
      // opposite: the BILL value sitting at the bay, which Σ accepted can never
      // show and which is the figure the store person is actually asking about
      // when they say their stock has not appeared.
      if (isHeld(g)) c.awaiting_value += g.inward_value || 0;
    }
    return c;
  }, [list]);

  /** Every counter above is computed off `list`, which is now narrowed by Source
   *  as well as by the dates and the status. Their tooltips said "in this range"
   *  — true of the dates, silent about the new picker, so a Σ that had just
   *  dropped by the PO bills' worth would read as a range that had changed. One
   *  sentence, appended wherever a tooltip states what it is counting. */
  const sliceNote = sourceFilter
    ? ` Source is set to ${SOURCE_LABEL[sourceFilter]}, so this counts only those bills — switch Source to All for the whole range.`
    : '';

  /** The held rows IN THE CURRENT VIEW, newest wait first. The banner counts
   *  these — not qcCtx.pending — because a banner that says "3 waiting" over a
   *  list showing one is the screen arguing with itself. The outlet-wide figure
   *  is stated separately, in its own words, when the two differ. */
  const heldHere = useMemo(() => list.filter(isHeld), [list]);
  /** Wait hours for one held row: the SERVER's figure when the queue answered,
   *  otherwise derived from created_at. null when neither is readable. */
  const waitHours = (g: GRN): number | null => {
    const r = qcCtx?.rows[g.id];
    if (r && Number.isFinite(Number(r.waiting_hours))) return Number(r.waiting_hours);
    return hoursSince(g.created_at);
  };
  /** Overdue is the SERVER's judgement (it owns the threshold) — never guessed
   *  locally, so a row can never be red here and calm on the queue. */
  const isOverdue = (g: GRN) => qcCtx?.rows[g.id]?.overdue === true;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <FileCheck className="w-6 h-6 text-[#af4408]" /> Goods Receipt Notes
          </h1>
          <p className="text-xs text-[#6B5744] mt-1">
            {/* THE SENTENCE A STOREKEEPER ARRIVING FROM /purchases READS FIRST.
                "Enter Full Bill" was moved here, so this page is no longer just
                the PO's paperwork — it is where every hand-typed vendor bill is
                recorded. If that is not said in the first line, somebody who
                used that button daily reads "Goods Receipt Notes" and keeps
                looking. */}
            <b>Every vendor bill is recorded here</b> — press <em>Enter Vendor Bill</em> for anything typed by hand
            (a full printed invoice, a cash buy, a sample, a donation, a vendor return). Receiving a PO creates a GRN
            automatically. Each line records ordered / received / accepted / rejected with a reason, and perishables are
            held for a kitchen check before any stock appears.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={downloadRegister} disabled={exporting}
                  title="Download the inward register (one row per line, sheet column order) as CSV/Excel. It follows the filters above, including Source — and carries a BILL TYPE column (DIRECT / AGAINST PO) as its last column. A filtered download says so in its filename, so a slice is never filed as the whole register. Voided bills are left out — their stock and cost were reversed, so counting them would overstate the period. Pick the 'void' filter to export those on their own."
                  className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm flex items-center gap-2 disabled:opacity-50">
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Inward Register
          </button>
          <button onClick={() => setCreating(true)}
                  title="Record a vendor bill that has no purchase order behind it — the full printed invoice, a cash buy, a sample, a donation or a return."
                  className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-2">
            <Receipt className="w-4 h-4" /> Enter Vendor Bill
          </button>
        </div>
      </div>
      {/* afterWrite(), not a bare reload(): a new GRN can have been HELD, which
          changes the Pending Quality Checks context this page now reads (the
          wait clock, the overdue flag, the queue size). Bumping dataVersion is
          what re-reads it — and it also drops any cached row detail, which was
          always the right thing to do after a write. */}
      {/* AND THE SOURCE PICKER STANDS DOWN IF IT WOULD HIDE WHAT WAS JUST SAVED.
          A bill typed in this modal is DIRECT by construction — POST /api/grn
          writes po_id as a literal NULL — so under Source = Against PO the row
          the user has this second created can never be in the reloaded list.
          Not "sometimes", the way a status filter can: 100% of the time. Widening
          to All is the only direction that is always safe (it can hide nothing
          that was showing), and it is done ONLY on a successful write, so the
          picker still composes freely while the user is driving it. Direct and
          All are left exactly as the user set them. */}
      {creating && <AdHocGrnModal onClose={() => setCreating(false)}
                                  onCreated={() => { setCreating(false); setSourceFilter(s => (s === 'po' ? '' : s)); afterWrite(); }} />}
      {/* Mounted at PAGE level, not inside the row: the row lives in a table with
          `overflow-x-auto` on its wrapper, and a fixed overlay rendered inside a
          scroll container is clipped by it on some browsers. */}
      {/* MOUNTED ON canAmend (store manager / manager / admin) — the bar for the
          PAPERWORK half, unchanged. `isAdmin` rides in as a separate, narrower
          answer: it gates the LINE editor inside the modal, because PATCH
          /api/grn/[id] is requireRole('admin'). Narrowing the mount instead
          would take the bill-level edit away from the store manager. */}
      {editing && canAmend === true && <EditBillModal g={editing} isAdmin={isAdmin} onClose={() => setEditing(null)}
                                 onSaved={() => { setEditing(null); afterWrite(); }} />}
      {voiding && isAdmin === true && (
        <VoidBillModal g={voiding} onClose={() => setVoiding(null)}
                       onVoided={() => { setVoiding(null); afterWrite(); }} />
      )}
      {/* Mounted at PAGE level for the same reason as the two above: the trigger
          lives inside the row's detail panel, which sits in an `overflow-x-auto`
          wrapper that clips a fixed overlay on some browsers. Gated on
          canOverride === true and nothing looser — null (the queue call did not
          answer) hides it exactly like false, and POST /api/grn/[id]/qc
          re-checks admin-or-head-chef and fails closed. */}
      {overriding && qcCtx?.canOverride === true && (
        <OverrideQcModal g={overriding} onClose={() => setOverriding(null)}
                         onDone={() => { setOverriding(null); afterWrite(); }} />
      )}

      {/* ── THE ANSWER TO "WHY HAS MY STOCK NOT APPEARED" ──────────────────
          Stated at the top of the page, before the table, because that is the
          question this banner exists to answer and the store person should not
          have to find the row to get it. Blue, not red: nothing has gone wrong
          — a delivery was recorded and is waiting on somebody else. It turns
          amber only when the server says one has waited past the threshold,
          which is a fact about the KITCHEN's response time, not the desk's. */}
      {heldHere.length > 0 && (() => {
        const overdueHere = heldHere.filter(isOverdue).length;
        const whos = [...new Set(heldHere.map(g => CHECKER_LABEL[String(g.qc_checker || '')] || 'Kitchen'))];
        const tone = overdueHere > 0
          ? 'border-amber-300 bg-amber-50 text-amber-900'
          : 'border-blue-200 bg-blue-50/60 text-blue-900';
        return (
          <div className={`rounded-xl border p-3 text-xs ${tone}`}>
            <div className="flex items-start gap-2 flex-wrap">
              <ChefHat className="w-4 h-4 shrink-0 mt-px" />
              <div className="flex-1 min-w-[16rem]">
                <div className="font-semibold">
                  {heldHere.length} delivery{heldHere.length === 1 ? '' : 's'} recorded and waiting for a quality check
                  {' — '}{fmt(counts.awaiting_value)} of goods is at the bay and <b>none of it is in stock yet</b>.
                </div>
                <div className="mt-0.5">
                  {whos.join(' / ')} must check quality, temperature and damage and sign off before these goods are ours.
                  Nothing was rejected and nothing is wrong with the paperwork — until they sign, the vendor can still take the goods back.
                  {overdueHere > 0 && (
                    <> <b>{overdueHere} {overdueHere === 1 ? 'has' : 'have'} waited longer than {qcCtx?.escalationHours || 4} hour(s)</b> and {overdueHere === 1 ? 'has' : 'have'} been escalated to the head chef.</>
                  )}
                </div>
                {/* The outlet-wide figure, and ONLY when it differs from what is
                    on screen — a filter can hide a held delivery, and a store
                    person who cleared their own range should still learn that
                    three more are waiting outside it.
                    WHICH FILTER IS HIDING THEM IS NOT GUESSED. This sentence
                    used to name the dates unconditionally, which was true while
                    the date range was the only picker that could BOTH leave this
                    banner up AND take held rows out of it: every status value
                    except '' and 'awaiting_qc' empties heldHere and the banner
                    disappears with it. Source is the first picker that can hide
                    a held bill while the banner stays up, so with Source set the
                    line names Source instead of sending a store person off to
                    widen a date range that was never the problem — the exact
                    hunt this banner exists to end.
                    NO NUMBER IS SPLIT BETWEEN THE TWO CAUSES: qcCtx is the
                    outlet-wide queue and carries no po_id, so the split is not
                    knowable here, and inventing it would be the same false
                    sentence one step further on. */}
                {qcCtx && qcCtx.pending > heldHere.length && (
                  <div className="mt-0.5 opacity-80">
                    {qcCtx.pending} are waiting in total at this outlet — {qcCtx.pending - heldHere.length} of them {sourceFilter
                      ? <>not listed here: Source is set to <b>{SOURCE_LABEL[sourceFilter]}</b>, and the dates above may be hiding some as well. Pending Quality Checks shows every one of them.</>
                      : <>outside the dates filtered above.</>}
                  </div>
                )}
              </div>
              <a href="/grn/qc"
                 className="shrink-0 px-2.5 py-1.5 rounded-lg border border-current bg-white/70 hover:bg-white font-semibold flex items-center gap-1.5">
                <ChefHat className="w-3.5 h-3.5" /> Pending Quality Checks
              </a>
            </div>
          </div>
        );
      })()}

      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex flex-col text-[#6B5744]">From
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        </label>
        <label className="flex flex-col text-[#6B5744]">To
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        </label>
        <div className="flex gap-1 ml-2 flex-wrap">
          {/* 'void' is a filter, not just a badge: a voided bill still sits in the
              register (that is the point of voiding rather than deleting) and an
              auditor has to be able to list them without scanning every row. */}
          {/* 'awaiting_qc' is a filter for the same reason: it is the one status
              somebody comes to this page specifically looking for ("where is my
              delivery?"), and the server accepts it as ?status= like any other. */}
          {(['', 'awaiting_qc', 'received', 'partial', 'rejected', 'void'] as const).map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
                    title={s === 'awaiting_qc' ? 'Recorded, no stock added — waiting for the kitchen / bar to check the goods.' : undefined}
                    className={`px-2 py-0.5 rounded border ${statusFilter === s ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}>
              {s ? statusLabel(s) : 'All'}
            </button>
          ))}
        </div>
        {/* ── SOURCE ────────────────────────────────────────────────────────────
            A SECOND, INDEPENDENT PICKER — the same button shape as the status
            group beside it, and it composes with it rather than resetting it:
            picking Direct leaves the dates and the status exactly where they
            were, so "direct bills still awaiting QC" is one screen. Captioned
            because two unlabelled "All" buttons in a row would be a riddle.
            Server-side (?source=), so the counters and the register download
            below describe the same slice as the table. */}
        <div className="flex gap-1 flex-wrap items-center ml-2 pl-2 border-l border-[#E8D5C4]">
          <span className="text-[#8B7355]" title="Where the document came from: a bill entered with no purchase order behind it, or goods received against one that was ordered.">Source</span>
          {/* Labels come from SOURCE_LABEL so the button, the chip on the row and
              every sentence written about this picker say the same two words. */}
          {([
            ['', 'All', 'Both kinds of document.'],
            ['direct', SOURCE_LABEL.direct, 'Bills with no purchase order behind them — a cash buy, a standing supplier, a sample, a donation or a return.'],
            ['po', SOURCE_LABEL.po, 'Receipts booked against a purchase order.'],
          ] as const).map(([v, label, tip]) => (
            <button key={v || 'all'} onClick={() => setSourceFilter(v)} title={tip}
                    className={`px-2 py-0.5 rounded border ${sourceFilter === v ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto text-[#6B5744] flex gap-3 flex-wrap">
          <span>✓ {counts.received}</span>
          {counts.awaiting_qc > 0 && (
            // Sits FIRST among the exception counters and carries its own ₹,
            // because "waiting" is money at the bay, not a grade of receipt —
            // and Σ accepted beside it deliberately excludes every rupee of it.
            <span className="text-blue-800" title={'Recorded, waiting for a kitchen / bar check. No stock has been added for these, so they contribute ₹0 to Σ accepted — the figure here is the BILL value sitting at the bay.' + sliceNote}>
              ⏱ {counts.awaiting_qc} awaiting QC · <b className="font-mono">{fmt(counts.awaiting_value)}</b>
            </span>
          )}
          <span className="text-amber-700">⚠ {counts.partial}</span>
          <span className="text-red-700">✗ {counts.rejected}</span>
          {counts.void > 0 && <span className="text-[#8B7355]" title={"Voided bills — their stock and cost rows were reversed, so they are excluded from the Σ beside this AND from the Inward Register download. Pick the 'void' filter to list them, or use a row's own Download to get one." + sliceNote}>⊘ {counts.void} void</span>}
          <span title={'Accepted value of the NON-VOID bills in this range.' + sliceNote}>Σ accepted: <b className="font-mono">{fmt(counts.accepted_value)}</b></span>
        </div>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
        ) : list.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#8B7355]">
            {/* The stock message says GRNs "are created when you receive a PO",
                which is exactly the wrong sentence to show somebody who has just
                filtered to DIRECT — the bills that by definition have no PO. */}
            {sourceFilter === 'direct'
              ? <>No direct bills in this range. Press <em>Enter Vendor Bill</em> for one typed by hand, or switch Source to <em>All</em>.</>
              : sourceFilter === 'po'
                ? <>No PO-sourced receipts in this range. Switch Source to <em>All</em> to see the direct bills too.</>
                : <>No GRNs in this range. They&apos;re created automatically when you receive a PO.</>}
          </div>
        ) : (
          <div className="overflow-x-auto">
          {/* min-w grows with the column WIDTH, not just the column count — the
              wrapper scrolls horizontally rather than letting a cell squeeze the
              others into wrapping. Widened from 980 when the trailing cell went
              from one "Print" link to a five-icon action group; under-size it
              and the group wraps onto two rows and every row grows a second
              line. Widened again from 1150 for the same reason on a different
              cell: Source / PO went from a single unbreakable PO token to a chip
              PLUS that token, roughly a hundred pixels more, and left at 1150
              every AGAINST PO row would wrap its number under its chip and grow
              the second line this floor exists to prevent. */}
          <table className="w-full text-xs min-w-[1250px]">
            <thead className="bg-[#FFF1E3] text-[#6B5744]">
              <tr>
                <th className="w-6"></th>
                <th className="text-left py-1.5 px-3 font-medium">GRN #</th>
                <th className="text-left py-1.5 px-3 font-medium">Date</th>
                <th className="text-left py-1.5 px-3 font-medium">Vendor</th>
                <th className="text-left py-1.5 px-3 font-medium">Bill No.</th>
                {/* Renamed from "Linked PO": the cell no longer holds only a PO
                    number, it holds the LABEL for both kinds of document — and
                    a DIRECT chip under a heading that says "Linked PO" reads
                    like a contradiction. The PO number still lives here. */}
                <th className="text-left py-1.5 px-3 font-medium">Source / PO</th>
                <th className="text-right py-1.5 px-3 font-medium">Lines</th>
                <th className="text-right py-1.5 px-3 font-medium">Rejected qty</th>
                <th className="text-right py-1.5 px-3 font-medium">Accepted ₹</th>
                <th className="text-right py-1.5 px-3 font-medium">Inward ₹</th>
                <th className="text-left py-1.5 px-3 font-medium">Status</th>
                <th className="text-left py-1.5 px-3 font-medium">Received by</th>
                {/* STILL THE 13TH COLUMN. The action group replaces the old
                    "Print" link inside this same cell rather than adding a 14th,
                    so the detail panel's colSpan={13} below stays correct. */}
                <th className="text-right py-1.5 px-3 font-medium w-[184px]">Action</th>
              </tr>
            </thead>
            <tbody>
              {list.map(g => (
                <GrnRow key={g.id} g={g} expanded={expanded === g.id}
                        onToggle={() => setExpanded(expanded === g.id ? null : g.id)}
                        isAdmin={isAdmin} canAmend={canAmend} dataVersion={dataVersion}
                        onEdit={() => setEditing(g)} onVoid={() => setVoiding(g)}
                        waitHours={waitHours(g)} overdue={isOverdue(g)}
                        escalationHours={qcCtx?.escalationHours ?? null}
                        canSignQc={qcCtx?.rows[g.id]?.can_sign === true}
                        canOverrideQc={qcCtx?.canOverride === true}
                        onOverride={() => setOverriding(g)} />
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================ */
/* Row action group — View · Edit · Print · Void · Download.    */
/* ONE definition, two skins: icon-only in the row's trailing   */
/* cell (which sits ~1,100px right on a phone, behind the       */
/* horizontal scroll) and icon+label at the top of the expanded */
/* detail panel, whose content starts at the LEFT edge and so   */
/* is reachable on a phone by tapping the chevron alone.        */
/* ============================================================ */
function GrnActions({ g, isAdmin, canAmend, expanded, onToggle, onEdit, onVoid, variant }: {
  g: GRN; isAdmin: boolean | null; canAmend: boolean | null; expanded: boolean;
  onToggle: () => void; onEdit: () => void; onVoid: () => void;
  variant: 'icons' | 'labels';
}) {
  const isVoid = g.status === 'void';
  const labelled = variant === 'labels';
  const sz = labelled ? 'w-3.5 h-3.5' : 'w-4 h-4';
  type ActionDef = {
    key: string; label: string; title: string; icon: ReactNode;
    danger?: boolean; href?: string; newTab?: boolean; onClick?: () => void;
    disabled?: boolean;
  };
  const acts: ActionDef[] = [
    {
      key: 'view', label: expanded ? 'Hide' : 'View',
      title: expanded ? 'Hide the line items' : 'View this bill — line items, charges and QC checklist',
      icon: <Eye className={sz} />, onClick: onToggle,
    },
  ];
  // AMEND. Hidden on a voided bill because PUT /api/grn/[id] refuses one with a
  // 409 — offering a control that cannot succeed is worse than not offering it.
  // Hidden too for anyone the server would 403: amending rewrites the vendor and
  // bill number on the purchase ledger, so it is the store manager, a manager or
  // an admin. `canAmend === true` and nothing looser — null (list not loaded, or
  // the load failed) hides it exactly like false.
  //
  // THE TOOLTIP USED TO STATE THE OLD LIMITATION AS FACT ("quantities and rates
  // are not amendable"). That was true at the first delivery and is not any
  // more: an admin corrects a quantity, a rate or a whole line inside this same
  // modal, with the stock and price effect unwound and reapplied. It still reads
  // the old way for everyone else, because for them it is still true — PATCH is
  // admin-only and the line section is hidden. `isAdmin === true` and nothing
  // looser, so an unanswered load promises the narrower thing.
  if (!isVoid && canAmend === true) acts.push({
    key: 'edit', label: 'Edit',
    title: isAdmin === true
      ? 'Amend the bill details (invoice no., invoice date, vendor, QC, notes) and correct its line items — quantity, rate or remove a line. A correction to a received bill unwinds and reapplies its stock and cost rows; the amendment is recorded.'
      : 'Amend the bill details (invoice no., invoice date, vendor, QC, notes). Quantities and rates are corrected by an admin — the amendment is recorded.',
    icon: <Pencil className={sz} />, onClick: onEdit,
  });
  acts.push({
    key: 'print', label: 'Print',
    // The print sheet prints g.status, so a voided bill prints the word "void"
    // in red. It has no full-page watermark — see the handoff note.
    title: isVoid ? 'Print this bill — the sheet is marked void' : 'Print this goods receipt note',
    icon: <Printer className={sz} />, href: `/grn/print/${g.id}`, newTab: true,
  });
  // DELETE = VOID, and ADMIN ONLY. `isAdmin === true` and nothing looser:
  // null (list not loaded / load failed) and false both hide it. The server
  // gate is requireRole('admin'), which fails closed; this only decides what
  // is worth showing.
  //
  // A PO-SOURCED GRN IS VOIDABLE NOW, AND THIS CONTROL USED TO SAY IT WAS NOT.
  // It carried `disabled: !!g.po_id` and a tooltip stating the old limitation as
  // fact. 20 of the 29 bills in this register are PO-sourced, so for most
  // deliveries the answer to "can an admin undo a receiving mistake" was still
  // no — the whole server-side capability sat behind a dead button. The server
  // now reopens the order, releases the vendor bill row and reverses any
  // requisition cascade (src/lib/po-void.ts); it still REFUSES several shapes,
  // and every one of those refusals comes back with its own sentence which the
  // modal prints verbatim. That is the right place for them: they depend on the
  // state of the ORDER, which this row does not carry.
  if (!isVoid && isAdmin === true) acts.push({
    key: 'void', label: 'Delete',
    title: g.po_id
      ? `Delete this bill — reverses the stock it added, marks it void, and reopens ${g.po_number || 'the purchase order'} so the delivery can be received again (admin only)`
      : 'Delete this bill — reverses the stock it added and marks it void (admin only)',
    icon: <Trash2 className={sz} />, danger: true, onClick: onVoid,
  });
  acts.push({
    key: 'download', label: 'Download',
    title: 'Download this entry as CSV, in the Inward Register column order',
    icon: <Download className={sz} />,
    href: `/api/grn?register=1&grn_id=${encodeURIComponent(g.id)}&format=csv`,
  });

  const cls = (a: ActionDef) => {
    if (a.disabled) {
      return labelled
        ? 'px-2 py-1 rounded border text-[11px] flex items-center gap-1 border-[#E8D5C4] bg-[#F3EEE7] text-[#B8A590] cursor-not-allowed'
        : 'p-1.5 rounded text-[#C9BBA9] cursor-not-allowed';
    }
    return labelled
      ? `px-2 py-1 rounded border text-[11px] flex items-center gap-1 ${a.danger
          ? 'border-red-200 bg-white text-red-600 hover:bg-red-50'
          : 'border-[#E8D5C4] bg-white text-[#6B5744] hover:text-[#af4408] hover:border-[#af4408]'}`
      : `p-1.5 rounded ${a.danger
          ? 'text-red-500 hover:text-red-700 hover:bg-red-50'
          : 'text-[#6B5744] hover:text-[#af4408] hover:bg-[#FFF1E3]'}`;
  };

  return (
    <div className={`flex items-center ${labelled ? 'flex-wrap gap-1.5' : 'justify-end gap-0.5 whitespace-nowrap'}`}>
      {acts.map(a => a.href ? (
        <a key={a.key} href={a.href} title={a.title} aria-label={a.label} className={cls(a)}
           {...(a.newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
           {...(a.key === 'download' ? { download: '' } : {})}>
          {a.icon}{labelled && <span>{a.label}</span>}
        </a>
      ) : (
        // `disabled` on the <button> AND the reason in the tooltip: a title on a
        // disabled button is still read on hover, which is the whole point of
        // disabling rather than hiding it.
        <button key={a.key} type="button" onClick={a.onClick} title={a.title} aria-label={a.label}
                disabled={a.disabled} aria-disabled={a.disabled || undefined}
                {...(a.key === 'view' ? { 'aria-expanded': expanded } : {})}
                className={cls(a)}>
          {a.icon}{labelled && <span>{a.label}</span>}
        </button>
      ))}
    </div>
  );
}

function GrnRow({ g, expanded, onToggle, isAdmin, canAmend, dataVersion, onEdit, onVoid,
                  waitHours, overdue, escalationHours, canSignQc, canOverrideQc, onOverride }: {
  g: GRN; expanded: boolean; onToggle: () => void;
  isAdmin: boolean | null; canAmend: boolean | null; dataVersion: number;
  onEdit: () => void; onVoid: () => void;
  /** Hours this receipt has waited for its check, or null when unknowable. */
  waitHours: number | null;
  overdue: boolean;
  escalationHours: number | null;
  /** May the CALLER sign this one themselves? Advisory — used only to point
   *  them at the queue in the right words, never to authorise anything. */
  canSignQc: boolean;
  canOverrideQc: boolean;
  onOverride: () => void;
}) {
  const [detail, setDetail] = useState<any>(null);
  const [detailErr, setDetailErr] = useState('');
  /** The amendment / void trail behind this bill. Admin-only and stripped
   *  server-side, so a non-admin simply gets [] and nothing renders. */
  const [history, setHistory] = useState<any[]>([]);
  /** True when the server had more events than it would send. Without it the
   *  panel's own count silently disagrees with the row's edit_count. */
  const [historyCapped, setHistoryCapped] = useState(false);
  // Drop the cached detail whenever the page reports a write. The row survives a
  // list reload (keyed by id), so without this an amended bill keeps rendering
  // its pre-amendment lines in an already-open panel.
  useEffect(() => {
    setDetail(null); setDetailErr('');
    setHistory(h => (h.length ? [] : h));
    setHistoryCapped(false);
  }, [dataVersion]);
  useEffect(() => {
    if (expanded && !detail && !detailErr) {
      fetch(`/api/grn?id=${g.id}`).then(r => r.json()).then(d => {
        if (d?.grn) {
          setDetail(d.grn);
          setHistory(Array.isArray(d.edit_history) ? d.edit_history : []);
          setHistoryCapped(d.edit_history_truncated === true);
        }
        else setDetailErr(d?.error || 'Could not load this bill.');
      }).catch(e => setDetailErr(e?.message || 'Could not load this bill.'));
    }
  }, [expanded, g.id, detail, detailErr]);
  // Collapsing clears a FAILED read, so re-expanding retries. The fetch guard
  // above refuses to run while detailErr is set — without this, one transient
  // failure (a dropped connection, a 401 during a session refresh) would leave
  // that row permanently unable to show its detail until the page is reloaded.
  useEffect(() => { if (!expanded && detailErr) setDetailErr(''); }, [expanded, detailErr]);

  const isVoid = g.status === 'void';
  /** Struck through on a voided bill — applied per CELL rather than to the <tr>,
   *  so the action buttons in the trailing cell keep their own decoration. */
  const strike = isVoid ? 'line-through decoration-[#8B7355]' : '';
  const editCount = Number(g.edit_count) || 0;
  const held = isHeld(g);
  /** Who owes the check on THIS receipt, read off the row's own qc_checker —
   *  never guessed. Unset (a receipt from before the gate) falls back to
   *  "Kitchen", which is what the server's own refusal messages say. */
  const checkerName = CHECKER_LABEL[String(g.qc_checker || '')] || 'Kitchen';

  return (
    <>
      {/* A held row gets a LEFT RULE, not a fill: it is still a live receipt in
          the register (unlike a void, which is greyed out of the reckoning), and
          a full-row tint on the newest bills would make the ordinary ones look
          like the exception. Amber only once the server calls it overdue. */}
      <tr className={`border-t border-[#E8D5C4]/50 ${isVoid ? 'bg-[#F3EEE7]/60 text-[#8B7355]' : 'hover:bg-[#FFF8F0]/40'} ${
            held ? (overdue ? 'border-l-2 border-l-amber-400' : 'border-l-2 border-l-blue-400') : ''}`}>
        <td className="px-2 py-2"><button onClick={onToggle} aria-label={expanded ? 'Collapse' : 'Expand'} aria-expanded={expanded} className="text-[#6B5744]">{expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button></td>
        <td className="py-2 px-3 font-mono font-semibold text-[#2D1B0E]">
          <span className={strike}>{g.grn_number}</span>
          {/* THE "EDITED" HINT. Only reaches the browser for an admin (the wire
              strips edited_* for everyone else), and only renders on a bill that
              was actually amended — so it is silent on the ordinary row rather
              than a badge on all of them. Who and when live in the tooltip; the
              full field-level diff is in the expanded panel. */}
          {editCount > 0 && (
            <span title={`Bill amended ${editCount} time${editCount === 1 ? '' : 's'}. Last amended${g.edited_by ? ` by ${g.edited_by}` : ''}${g.edited_at ? ` on ${fmtIST(g.edited_at)}` : ''}. Expand the row for what changed.`}
                  className="ml-1.5 inline-flex items-center gap-0.5 align-middle text-[9px] font-sans font-normal px-1 py-0.5 rounded border border-[#E8D5C4] bg-[#FFF8F0] text-[#8B7355]">
              <Pencil className="w-2 h-2" /> edited
            </span>
          )}
          {isVoid && (
            <span className="block text-[9px] font-sans font-normal text-[#8B7355] mt-0.5" title={g.void_reason || undefined}>
              {voidedBadgeText(g)}
            </span>
          )}
          {/* THE ERROR TO THE STORE PERSON THE OWNER ASKED FOR — stated on the
              row itself, in the same place a void states its own fact, so it is
              read without expanding anything. It names WHO it is waiting on and
              FOR HOW LONG, because "awaiting QC" with neither is an excuse
              rather than information. Not red, and no word implying the desk
              did anything wrong. */}
          {held && (
            <span className={`block text-[9px] font-sans font-normal mt-0.5 ${overdue ? 'text-amber-800' : 'text-blue-800'}`}
                  title={`No stock has been added for ${g.grn_number}. ${checkerName} must check the goods and sign off before they are ours.${
                    escalationHours ? ` Escalates to the head chef after ${escalationHours} hour(s).` : ''}`}>
              <Clock className="w-2.5 h-2.5 inline-block align-[-1px] mr-0.5" />
              Waiting on {checkerName}
              {waitHours != null && <> · {waitedFor(waitHours)}</>}
              {overdue && (
                <span className="ml-1 px-1 py-px rounded border border-amber-300 bg-amber-50 text-amber-900">overdue</span>
              )}
            </span>
          )}
        </td>
        <td className={`py-2 px-3 ${strike}`}>{g.date}</td>
        <td className={`py-2 px-3 text-[#6B5744] ${strike}`}>{g.vendor || '—'}</td>
        {/* The VENDOR's bill/invoice number — what the store clerk matches the
            paper against. Our own GRN # is two columns left; these are different
            numbers and mixing them up is how a bill gets paid twice. */}
        <td className={`py-2 px-3 font-mono text-[#6B5744] ${strike}`}>{g.invoice_number || '—'}</td>
        {/* SOURCE — the chip is on EVERY row, and the PO number sits beside it
            rather than being replaced by it: the chip says what kind of document
            this is, the number says which order it belongs to, and a PO row
            needs both. The old cell said this with an em-dash, which is an
            absence rather than a label.
            The chip is NOT given `strike` on a voided row (see SourceChip) —
            the void withdrew the receipt, not the fact that it came in without
            an order; the PO link keeps its strike, as before. It IS muted there,
            so the one unstruck thing in a greyed-out row is not also the
            brightest thing in it. */}
        <td className="py-2 px-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <SourceChip poSourced={isPoSourced(g)} muted={isVoid} />
            {/* Shown only when the order could be resolved. A PO-sourced row
                whose order row has gone still reads "Against PO" — the chip is
                keyed off po_id, so it never quietly downgrades to "Direct". */}
            {g.po_number && <a href="/purchase-orders" className={`font-mono text-[#af4408] hover:underline ${strike}`}>{g.po_number}</a>}
          </div>
        </td>
        <td className={`py-2 px-3 text-right font-mono ${strike}`}>{g.line_count}</td>
        {/* Rejected qty is a SUM ACROSS MATERIALS and GRN qtys are PURCHASE units,
            so it can only be printed as a quantity when every rejected line shares
            one purchase unit (kg + kg). A mixed GRN (2 kg + 3 BTL) has no honest
            total — show the rejected LINE COUNT and send the reader to the rows.
            Same precedent as the stock-overview tfoot. */}
        <td className={`py-2 px-3 text-right font-mono text-red-700 ${strike}`}>
          {(() => {
            const rej = Number(g.total_rejected) || 0;
            if (rej <= 0) return <span className="text-[#8B7355]">—</span>;
            // undefined (a payload from before these fields existed) ≠ "mixed" —
            // say we don't know the unit rather than invent either answer.
            if (g.rejected_unit_count == null) {
              return <span title="Expand the row for the per-line quantities and their purchase units.">{rej.toLocaleString('en-IN', { maximumFractionDigits: 3 })}</span>;
            }
            const uc = Number(g.rejected_unit_count) || 0;
            if (uc === 1 && g.rejected_unit) {
              return <>{rej.toLocaleString('en-IN', { maximumFractionDigits: 3 })} <span className="text-[9px] text-[#B8A590]">{g.rejected_unit}</span></>;
            }
            const n = Number(g.rejected_lines ?? 0) || 0;
            return (
              <span title="Rejected across materials with different purchase units — a single total would mix units. Expand the row for the per-line quantities.">
                {n > 0 ? `${n} line${n === 1 ? '' : 's'}` : '—'} <span className="text-[9px] text-[#B8A590]">mixed units</span>
              </span>
            );
          })()}
        </td>
        {/* The two ₹ figures stay ON a voided row, struck through, rather than
            blanking: the bill was really booked at this value once, and the
            strike is what says it no longer counts. The header Σ excludes it. */}
        {/* ── ₹0 ACCEPTED ON A HELD BILL IS NOT "NOTHING WAS ACCEPTED" ────────
            Every line's quantity_accepted is 0 while a receipt waits, because
            the store records what ARRIVED and the checking department records
            what is ACCEPTED (api/grn/route.ts's "ZERO ACCEPTED IS THE ABSENCE
            OF A DECISION"). Printing a bare ₹0 next to a full Inward ₹ reads as
            a delivery that was entirely turned away — the opposite of the
            truth. An em-dash with the reason in its tooltip is the honest cell;
            the stored figure is still 0 and Σ accepted still excludes it. */}
        <td className={`py-2 px-3 text-right font-mono font-semibold ${strike}`}>
          {held
            ? <span className="text-[#B8A590] font-sans font-normal"
                    title={`Not decided yet. ${checkerName} records the accepted quantity when they sign off — until then it is stored as 0, which means "no decision", not "all rejected".`}>not decided</span>
            : fmt(g.accepted_value || 0)}
        </td>
        <td className={`py-2 px-3 text-right font-mono font-semibold ${isVoid ? 'text-[#8B7355]' : 'text-[#af4408]'} ${strike}`}>{g.inward_value ? fmt(g.inward_value) : '—'}</td>
        <td className="py-2 px-3">
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_TONE[g.status] || 'bg-[#FFF1E3] text-[#6B5744] border-[#E8D5C4]'}`}
                title={isVoid ? `${voidedBadgeText(g)}. The stock this bill added was reversed; the document is kept.`
                     : held ? `Recorded, and no stock has been added. ${checkerName} must check quality, temperature and damage and sign off first.`
                     : undefined}>
            {statusLabel(g.status)}
          </span>
        </td>
        <td className={`py-2 px-3 text-[10px] text-[#8B7355] ${strike}`}>{g.received_by || '—'}</td>
        <td className="py-2 px-3">
          <GrnActions g={g} isAdmin={isAdmin} canAmend={canAmend} expanded={expanded} onToggle={onToggle}
                      onEdit={onEdit} onVoid={onVoid} variant="icons" />
        </td>
      </tr>
      {/* colSpan tracks the header column count (13 since Bill No. was added) —
          if it under-counts, the detail panel stops short of the table width. */}
      {expanded && (
        <tr><td colSpan={13} className="bg-[#FFF8F0] py-3 px-4">
          {/* PANEL TOOLBAR — the SAME action group as the row's trailing cell,
              with labels. This is what makes the actions usable on a phone: the
              trailing cell sits ~1,100px to the right, behind the table's
              horizontal scroll, whereas this copy starts at the panel's LEFT
              edge and is reached by tapping the chevron alone. It wraps rather
              than overflowing (flex-wrap in GrnActions' labelled skin). */}
          <div className="mb-2 pb-2 border-b border-[#E8D5C4]">
            <GrnActions g={g} isAdmin={isAdmin} canAmend={canAmend} expanded={expanded} onToggle={onToggle}
                        onEdit={onEdit} onVoid={onVoid} variant="labels" />
          </div>
          {/* A voided bill says so ONCE, in full, at the top of its own detail —
              the row's strike-through says "withdrawn", this says what that
              actually did to the stock. */}
          {isVoid && (
            <div className="mb-2 flex items-start gap-1.5 text-[11px] rounded border border-[#B8A590] bg-[#EFE7DE] px-2 py-1.5 text-[#6B5744]">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                <b>{voidedBadgeText(g)}.</b>{' '}
                The stock this bill added was reversed and its cost rows deleted. The document below is kept as the record of what arrived, and it no longer counts towards inward value.
                {g.void_reason ? <> Reason: <i>{g.void_reason}</i></> : null}
              </span>
            </div>
          )}
          {/* ── THE HELD RECEIPT, IN FULL ──────────────────────────────────
              The row says what and how long; this says what it MEANS, what
              nobody has to do about it, and what the one escape hatch costs.
              Deliberately worded so the receiving desk reads it as "your work
              is recorded and correct, somebody else owes an answer". */}
          {held && (
            <div className={`mb-2 rounded border px-2.5 py-2 text-[11px] ${
                  overdue ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-blue-200 bg-blue-50/60 text-blue-900'}`}>
              <div className="font-semibold flex items-center gap-1.5 flex-wrap">
                {String(g.qc_checker) === 'bar' ? <Wine className="w-3.5 h-3.5" /> : <ChefHat className="w-3.5 h-3.5" />}
                Recorded and waiting for a {checkerName} check — no stock has been added.
                {waitHours != null && (
                  <span className="font-normal opacity-90">Waiting {waitedFor(waitHours)}.</span>
                )}
              </div>
              <ul className="list-disc pl-4 mt-1 space-y-0.5 font-normal">
                <li>
                  The bill, its lines and its ₹ figures are all saved. What has <b>not</b> happened is the stock movement:
                  no material&apos;s on-hand went up, no cost row was written, no recipe was re-costed.
                </li>
                <li>
                  <b>{checkerName}</b> checks quality, temperature and damage, records anything they will not take with a reason,
                  and signs. Only the quantity they accept enters stock.
                  {' '}Until then the vendor can still take the goods back — that is the point of the wait.
                </li>
                <li>
                  <b>Accepted and Rejected below read 0 for every line.</b> That is “nobody has decided”, not “everything was refused”.
                </li>
                {overdue && (
                  <li>
                    This one has waited past {escalationHours || 4} hour(s) and has been escalated to the head chef.
                  </li>
                )}
              </ul>
              <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                <a href="/grn/qc" className="px-2 py-1 rounded border border-current bg-white/70 hover:bg-white font-semibold flex items-center gap-1">
                  <ChefHat className="w-3 h-3" /> {canSignQc ? 'Check it now' : 'Open Pending Quality Checks'}
                </a>
                {/* ── THE NIGHT-DELIVERY ESCAPE HATCH (owner's decision 2) ────
                    Shown ONLY to someone the server would actually let through
                    — an admin or a head chef — because a control that always
                    403s teaches the desk that the app is broken and to re-enter
                    the delivery by hand. Everyone else gets the sentence that
                    tells them whom to ask, which is the actionable half. */}
                {canOverrideQc ? (
                  <button type="button" onClick={onOverride}
                          title="Add the stock now, without a kitchen check. Requires a written reason and marks this bill permanently."
                          className="px-2 py-1 rounded border border-amber-400 bg-white text-amber-800 hover:bg-amber-50 font-semibold flex items-center gap-1">
                    <ShieldAlert className="w-3 h-3" /> Release without a check…
                  </button>
                ) : (
                  <span className="opacity-80">
                    Night delivery and nobody to check it? An <b>admin or head chef</b> can release it with a written reason —
                    the bill is then marked, permanently, as inwarded without a kitchen check.
                  </span>
                )}
              </div>
            </div>
          )}
          {/* THE OVERRIDE, AFTER THE FACT. A permanent property of the bill
              (qc_override_* are committed columns, not a prunable audit row) and
              it shows on every reader's screen — the store person included, so
              nobody is later surprised that this receipt is on the override
              report. Shown on a DECIDED bill; while it is still held the banner
              above is the live one. */}
          {!held && String(g.qc_outcome) === 'override' && (
            <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900">
              <div className="font-semibold flex items-center gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5" /> Inwarded WITHOUT a kitchen check
              </div>
              <div className="mt-0.5">
                Released by <b>{g.qc_override_by || 'an admin / head chef'}</b>
                {g.qc_override_at ? <> on {fmtIST(g.qc_override_at)}</> : null}. The stock was added on their authority, not on a
                {' '}{checkerName.toLowerCase()} sign-off — the three quality checks below were never answered and are recorded as unticked.
                {g.qc_override_reason ? <> Reason: <i>{g.qc_override_reason}</i></> : null}
              </div>
            </div>
          )}
          {/* A failed detail read must SAY so. Without this branch `!detail`
              stays true for ever and the panel spins a loader at a request that
              already came back 401/404. */}
          {detailErr ? (
            <div className="text-xs text-red-700 flex items-start gap-1.5">
              <AlertTriangle className="w-4 h-4 shrink-0" /> {detailErr}
            </div>
          ) : !detail ? (
            <div className="text-xs text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading line items…</div>
          ) : (
            <>
              <div className="text-xs text-[#6B5744] mb-2 flex flex-wrap gap-x-3 gap-y-1">
                <span><b>GRN #:</b> {detail.grn_number}</span>
                {detail.invoice_number && <span><b>Vendor Invoice No:</b> {detail.invoice_number}</span>}
                <span><b>Inward date:</b> {detail.date}</span>
                <span><b>Supplier:</b> {detail.vendor || '—'}</span>
                {detail.invoice_date && <span><b>Invoice date:</b> {detail.invoice_date}</span>}
                {detail.qc_by && <span><b>QC by:</b> {detail.qc_by}</span>}
                {detail.notes && <span><b>Notes:</b> {detail.notes}</span>}
              </div>
              {/* ── THE CHECKLIST, SPLIT BY WHO OWNS IT (owner's decision 4) ──
                  One strip of six identical chips could never say whose answer
                  each one was, which is the whole defect this feature exists to
                  fix: across 29 live GRNs the six ticks had never been ticked
                  once, and where they had been, it was by the receiver about
                  their own receipt. Two labelled groups, each with its own
                  signature line, so an unticked box in one group can never be
                  read as the other group's failure. */}
              {(() => {
                const gated = wasGated(detail);
                const stamp = (by: string | null | undefined, at: string | null | undefined) =>
                  by ? <>signed by <b className="text-[#2D1B0E]">{by}</b>{at ? <> · {fmtIST(at)}</> : null}</> : null;
                /* A plain FUNCTION, not a component declared in render: a
                   component type re-created on every render remounts its whole
                   subtree each time, and there is nothing to gain from that
                   here. Called as group({...}) below. */
                const group = ({ title, icon, fields, signed, note }: {
                  title: string; icon: ReactNode; fields: QcFieldDef[]; signed: ReactNode; note: string;
                }) => (
                  <div key={title} className="flex-1 min-w-[15rem] rounded border border-[#E8D5C4] bg-white px-2 py-1.5">
                    <div className="flex items-center gap-1 text-[10px] font-semibold text-[#6B5744]">
                      {icon} {title}
                      <span className="font-normal text-[#8B7355]">
                        {fields.filter(f => detail[f.k]).length}/{fields.length}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {fields.map(f => (
                        <span key={f.k} title={f.label}
                              className={`px-1.5 py-0.5 rounded border text-[10px] ${
                                detail[f.k] ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                            : 'bg-[#FFF1E3] text-[#8B7355] border-[#E8D5C4]'}`}>
                          {detail[f.k] ? '✓' : '○'} {f.short}
                        </span>
                      ))}
                    </div>
                    <div className="text-[9px] text-[#8B7355] mt-1">{signed || note}</div>
                  </div>
                );
                return (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {group({
                      title: 'Store — receiving desk', icon: <FileCheck className="w-3 h-3" />,
                      fields: STORE_QC_FIELDS,
                      signed: stamp(detail.qc_store_by, detail.qc_store_at),
                      // The store stamp is written ONLY when all three were
                      // ticked (api/grn/route.ts:502), and never at all on a PO
                      // receipt, whose form has no store checklist. Blank must
                      // therefore say "not answered" and never "failed".
                      note: detail.po_id
                        ? 'Not asked on a PO receipt — that form has no store checklist.'
                        : 'Unsigned — all three are needed before a name is stamped.',
                    })}
                    {group({
                      title: `${CHECKER_LABEL[String(detail.qc_checker || '')] || 'Kitchen / bar'} — quality check`,
                      icon: String(detail.qc_checker) === 'bar' ? <Wine className="w-3 h-3" /> : <ChefHat className="w-3 h-3" />,
                      fields: KITCHEN_QC_FIELDS,
                      signed: stamp(detail.qc_kitchen_by, detail.qc_kitchen_at),
                      note: gated
                        ? (String(detail.status) === 'awaiting_qc'
                            ? 'Not yet checked — these are the three the delivery is waiting on.'
                            : String(detail.qc_outcome) === 'override'
                              ? 'Never answered — this bill was released without a kitchen check.'
                              : 'Unsigned.')
                        : 'This delivery was not gated, so these were the receiving desk’s own note — not a checking department’s answer.',
                    })}
                    {/* The legacy free-text name. Kept visible because 29 live
                        receipts carry it and nothing else records who they
                        meant, but named as legacy so nobody reads it as one of
                        the two stamped signatures above. */}
                    {detail.qc_by && (
                      <div className="w-full text-[9px] text-[#8B7355]">
                        “QC done by” (free text, typed at the receiving bay): <b className="text-[#6B5744]">{detail.qc_by}</b>
                      </div>
                    )}
                  </div>
                );
              })()}
              {/* Inward register — sheet column order (line-level), then our
                  extra QC columns (Accepted / Rejected / Reason). Header fields
                  (GRN #, Invoice, Date, Supplier) show in the summary line above. */}
              <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[1180px]">
                <thead className="text-[#8B7355] bg-[#FFF1E3]/50">
                  <tr>
                    <th className="text-left  py-1 px-2 font-medium">Category</th>
                    <th className="text-left  py-1 px-2 font-medium">Item</th>
                    <th className="text-right py-1 px-2 font-medium">PO Qty</th>
                    <th className="text-right py-1 px-2 font-medium">Inward Qty</th>
                    <th className="text-left  py-1 px-2 font-medium">Purchase Unit</th>
                    <th className="text-right py-1 px-2 font-medium">Rate</th>
                    <th className="text-right py-1 px-2 font-medium">Subtotal</th>
                    <th className="text-right py-1 px-2 font-medium">Discount</th>
                    <th className="text-right py-1 px-2 font-medium">CGST</th>
                    <th className="text-right py-1 px-2 font-medium">SGST</th>
                    {/* Two DIFFERENT levies, side by side on purpose: Comp. Cess is
                        the GST-regime compensation cess (material master's Cess %),
                        Sp. Excise Cess is the TGBCL liquor levy. Total Inward now
                        carries both, so both have to be printed or the row's own
                        breakdown no longer adds up to the total beside it. */}
                    <th className="text-right py-1 px-2 font-medium" title="GST compensation cess — a separate levy from CGST/SGST, charged on the gross line value before discount.">Comp. Cess</th>
                    <th className="text-right py-1 px-2 font-medium">Sp. Excise Cess</th>
                    <th className="text-right py-1 px-2 font-medium">TCS</th>
                    <th className="text-right py-1 px-2 font-medium">Delivery</th>
                    <th className="text-right py-1 px-2 font-medium">MRP Round Off</th>
                    <th className="text-right py-1 px-2 font-medium text-[#af4408]">Total Inward</th>
                    <th className="text-right py-1 px-2 font-medium border-l border-[#E8D5C4]">Accepted</th>
                    <th className="text-right py-1 px-2 font-medium">Rejected</th>
                    <th className="text-left  py-1 px-2 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((it: any) => {
                    // Read off the DETAIL, not the list row: the row is a
                    // snapshot that can be minutes old, and the one thing that
                    // moves underneath it is exactly this — somebody signing the
                    // receipt off in the queue while the panel is open. The
                    // panel then shows the real accepted quantities instead of
                    // three em-dashes claiming nobody has decided.
                    const heldNow = String(detail.status) === 'awaiting_qc';
                    const muted = 'text-[#B8A590]';
                    const chargeCell = (v: any) => <td className={`py-1 px-2 text-right font-mono ${Number(v) ? 'text-[#2D1B0E]' : muted}`}>{q2(v)}</td>;
                    // Accepted / Rejected sit twelve ₹ columns to the RIGHT of the
                    // Purchase Unit column, far enough that the unit no longer reads
                    // as theirs. They are the same PURCHASE units as Inward Qty —
                    // repeat the label so nobody reads them as recipe grams.
                    const pu = it.purchase_unit || it.material_unit || '';
                    return (
                    <tr key={it.id} className="border-t border-[#E8D5C4]/50">
                      <td className="py-1 px-2 text-[#6B5744]">{it.material_category || '—'}</td>
                      <td className="py-1 px-2 text-[#2D1B0E]">{it.material_name}</td>
                      <td className="py-1 px-2 text-right font-mono">{Number(it.quantity_ordered) || 0}</td>
                      <td className="py-1 px-2 text-right font-mono">{it.quantity_received}</td>
                      <td className="py-1 px-2 text-[#6B5744]">{it.purchase_unit || it.material_unit || '—'}</td>
                      <td className="py-1 px-2 text-right font-mono">{m2(it.unit_price)}</td>
                      <td className="py-1 px-2 text-right font-mono">{m2(it.subtotal)}</td>
                      {chargeCell(it.discount)}
                      {chargeCell(it.cgst)}
                      {chargeCell(it.sgst)}
                      {chargeCell(it.compensation_cess)}
                      {chargeCell(it.special_excise_cess)}
                      {chargeCell(it.tcs)}
                      {chargeCell(it.delivery_charges)}
                      {chargeCell(it.mrp_round_off)}
                      <td className="py-1 px-2 text-right font-mono font-semibold text-[#af4408]">{m2(it.total_inward_amount)}</td>
                      {/* Same rule as the list row's accepted-value cell: while
                          the receipt is held these are stored 0 because no
                          decision exists, and printing "0 kg accepted / 0 kg
                          rejected" next to a full inward qty is the one reading
                          that is certainly wrong. The banner above says it in
                          words; these three cells say it where the eye lands.
                          (No currency glyph in this comment on purpose — the
                          rate-basis gate's money-column rule keys on one, and
                          this table's eight charge cells come from chargeCell()
                          so a literal <td> count can never match its 19 <th>.) */}
                      <td className="py-1 px-2 text-right font-mono text-emerald-700 border-l border-[#E8D5C4]">
                        {heldNow
                          ? <span className="text-[#B8A590] font-sans" title={`${checkerName} records this when they sign off.`}>—</span>
                          : <>{it.quantity_accepted} <span className="text-[9px] text-[#B8A590]">{pu}</span></>}
                      </td>
                      <td className="py-1 px-2 text-right font-mono text-red-700">
                        {heldNow
                          ? <span className="text-[#B8A590] font-sans" title="Nothing has been rejected — nothing has been judged yet.">—</span>
                          : <>{it.quantity_rejected || 0} <span className="text-[9px] text-[#B8A590]">{pu}</span></>}
                      </td>
                      <td className="py-1 px-2 text-[#6B5744]">
                        {heldNow
                          ? <span className="text-[#B8A590]" title="The checking department records a reason against whatever it turns away.">not decided</span>
                          : (it.rejection_reason || '')}
                      </td>
                    </tr>
                  ); })}
                </tbody>
                <tfoot className="bg-[#FFF1E3]/60 font-semibold text-[#2D1B0E] border-t border-[#E8D5C4]">
                  <tr>
                    <td className="py-1.5 px-2" colSpan={6}>{detail.items.length} line(s)</td>
                    <td className="py-1.5 px-2 text-right font-mono">{m2(detail.items.reduce((s: number, it: any) => s + (Number(it.subtotal) || 0), 0))}</td>
                    {/* Spans the CHARGE columns: discount, cgst, sgst, comp. cess,
                        sp. excise cess, tcs, delivery, round-off — eight since
                        Comp. Cess was added. Under-count and the Total Inward
                        figure slides left out of its own column. */}
                    <td className="py-1.5 px-2 text-right font-mono" colSpan={8}></td>
                    <td className="py-1.5 px-2 text-right font-mono text-[#af4408]">{m2(detail.items.reduce((s: number, it: any) => s + (Number(it.total_inward_amount) || 0), 0))}</td>
                    <td colSpan={3}></td>
                  </tr>
                </tfoot>
              </table>
              </div>
              {/* THE AMENDMENT / VOID TRAIL — what the row's small "edited"
                  marker points at. Read from the append-only audit_events log
                  and stripped SERVER-SIDE for non-admins, so a non-admin gets
                  [] and this whole block simply does not render. */}
              {/* Rendered whenever there is a trail OR the row claims one. An
                  "edited" marker that leads to a panel with no History block at
                  all is the marker lying by omission — if the two ever disagree
                  (a legacy amendment from before the audit write was made
                  mandatory, or a trail longer than the server will send), the
                  block says so in words rather than not appearing. */}
              {(history.length > 0 || editCount > 0) &&
                <GrnHistory history={history} editCount={editCount} capped={historyCapped} />}
            </>
          )}
        </td></tr>
      )}
    </>
  );
}

/* ============================================================ */
/* Amendment / void trail for one bill. ADMIN ONLY — it renders */
/* only what the server chose to send, and the server sends []  */
/* to everyone else.                                            */
/* ============================================================ */
/** Field names as the bill form calls them, so the trail reads in the same
 *  words as the form that produced it (`invoice_number` → "Vendor Invoice No"). */
const FIELD_LABEL: Record<string, string> = {
  invoice_number: 'Vendor Invoice No', invoice_date: 'Invoice date',
  vendor: 'Vendor', vendor_id: 'Vendor (linked record)',
  qc_by: 'QC done by (free text)', notes: 'Notes',
  // The six ticks name their OWNER. "QC · Quality" left a reader of the trail
  // unable to tell whose answer had been altered, which on a gated receipt is
  // the only thing about it worth knowing.
  ...QC_OWNER_LABEL,
};
/** A diff value as a human reads it. The six qc_* columns are stored 1/0 and
 *  would otherwise print as bare digits, which reads as a quantity. */
const diffValue = (field: string, v: any) => {
  if (v === null || v === undefined || v === '') return '(blank)';
  if (field.startsWith('qc_') && field !== 'qc_by') return Number(v) ? 'ticked' : 'not ticked';
  return String(v);
};

function GrnHistory({ history, editCount, capped }: { history: any[]; editCount: number; capped: boolean }) {
  const [open, setOpen] = useState(false);
  // Only the amendments are counted in the summary line — a void is not an
  // "edit" and it already announces itself in the banner at the top of the panel.
  const edits = history.filter(h => h.event_type === 'grn.edit').length;
  // The row's marker counts amendments from goods_receipt_notes.edit_count; this
  // panel counts the events it was actually sent. They agree by construction
  // now (the audit write is inside the amend transaction and rolls it back on
  // failure), but not necessarily for a bill amended before that, and not once
  // the trail passes the server's cap. Say which, rather than let the reader
  // find the discrepancy themselves.
  const shortfall = Math.max(0, editCount - edits);
  return (
    <div className="mt-3 pt-2 border-t border-[#E8D5C4]">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
              className="flex items-center gap-1 text-[10px] text-[#8B7355] hover:text-[#af4408]">
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        History — {edits > 0 ? `${edits} amendment${edits === 1 ? '' : 's'}` : 'no amendments'}
        {history.length > edits && `, ${history.length - edits} other event${history.length - edits === 1 ? '' : 's'}`}
        <span className="ml-1 text-[#B8A590]">(admins only)</span>
      </button>
      {shortfall > 0 && (
        <div className="mt-1 text-[10px] text-amber-700 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
          <span>
            The row is marked as amended {editCount} time{editCount === 1 ? '' : 's'} but only {edits} amendment{edits === 1 ? '' : 's'} {edits === 1 ? 'is' : 'are'} listed here
            {capped
              ? ' — this trail is longer than the server sends at once, so the oldest entries are not shown.'
              : '. The missing entries predate this bill\'s audit trail, or were removed from the audit log.'}
          </span>
        </div>
      )}
      {open && (
        <ul className="mt-1.5 space-y-1.5">
          {history.map(h => {
            // A grn.edit carries a flat {field: value} map on both sides — that
            // is the field-level diff. Every other event type (grn.void, whose
            // `before` is a whole snapshot of rows) is shown by its note rather
            // than diffed into an unreadable wall.
            const isEdit = h.event_type === 'grn.edit';
            const fields = isEdit && h.after && typeof h.after === 'object' ? Object.keys(h.after) : [];
            return (
              <li key={h.id} className="text-[10px] text-[#6B5744] bg-white border border-[#E8D5C4] rounded px-2 py-1.5">
                <div className="flex flex-wrap items-center gap-x-2 text-[#8B7355]">
                  <span className={`px-1 py-0.5 rounded border ${isEdit
                    ? 'border-[#E8D5C4] bg-[#FFF8F0]'
                    : 'border-[#B8A590] bg-[#EFE7DE]'}`}>{h.event_type}</span>
                  <span>{h.actor_email || 'unknown'}</span>
                  {h.created_at && <span>{fmtIST(h.created_at)}</span>}
                </div>
                {fields.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {fields.map(f => (
                      <li key={f} className="font-mono">
                        <span className="font-sans text-[#2D1B0E]">{FIELD_LABEL[f] || f}:</span>{' '}
                        <span className="line-through text-[#B8A590]">{diffValue(f, h.before?.[f])}</span>
                        {' → '}
                        <span className="text-[#2D1B0E]">{diffValue(f, h.after?.[f])}</span>
                      </li>
                    ))}
                  </ul>
                ) : h.note ? (
                  <div className="mt-0.5 text-[#6B5744]">{h.note}</div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ============================================================ */
/* Ad-hoc GRN modal — creates a GRN + purchases for a non-PO   */
/* receipt (cash buy, sample, donation, return).                */
/* ============================================================ */
function AdHocGrnModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0,10));
  const [vendor, setVendor] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [invoice, setInvoice] = useState('');
  /** Declared: this delivery came with no vendor bill at all. Restores what
   *  "Enter Full Bill" allowed (4 of its 13 real rows had a blank number)
   *  without letting a blank happen by accident. See the field. */
  const [noBill, setNoBill] = useState(false);
  /* ── PAID OUT OF THE PETTY CASH BOX ────────────────────────────────────────
   * The owner's design: "Keep it in Enter Vendor Bill, add an option of Cash
   * purchase. If they click on it, it will be added on petty cash." Nothing
   * about the inward rail changes — same GRN, same QC gate, same stock, same
   * price cascade. Ticking this adds ONE petty_cash_ledger row for the money.
   *
   * `cashVoucher` is a PREVIEW the server hands over on mount. It is pre-filled
   * into the bill-number field so a market run satisfies the mandatory bill
   * number honestly, and it is EDITABLE — type the vendor's real number over it
   * and that number is what gets stored. The server re-mints an authoritative
   * one at save time whenever what arrives is still PCV-shaped, so two people
   * with the form open cannot take the same number.
   */
  const [cashPurchase, setCashPurchase] = useState(false);
  const [canRecordCash, setCanRecordCash] = useState(false);
  const [cashVoucher, setCashVoucher] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [qcBy, setQcBy] = useState('');
  const [notes, setNotes] = useState('');
  // Phase 1 §4 — receiving QC checklist (each item gets ticked at the receiving bay)
  const [qc, setQc] = useState({
    qc_quality: false, qc_temperature: false, qc_expiry: false,
    qc_damage: false, qc_weight: false, qc_invoice_match: false,
  });
  const toggleQc = (k: keyof typeof qc) => setQc(p => ({ ...p, [k]: !p[k] }));
  const [items, setItems] = useState<GrnLine[]>([blankLine()]);
  /* ── THE BILL-LEVEL CHARGES, CARRIED OVER FROM "ENTER FULL BILL" ──────────
   * One Discount and one Delivery figure for the WHOLE bill, By % or By Amount,
   * split across the lines in proportion to each line's goods value. That is
   * how a printed vendor bill is actually written, and typing the same rupees
   * onto twenty lines by hand is how one line silently ends up wrong.
   *
   * WHAT EACH DOES TO COST, and the two answers are different:
   *   Discount REDUCES the cost basis — POST /api/grn nets it into unit_price
   *   (byte-for-byte the arithmetic grn-qc.ts uses at sign-off), so a discount
   *   genuinely lowers what the goods cost and every recipe built on them.
   *   Delivery is RECORDED ONLY. It never touches unit_price on any path.
   * Do not "align" the two — the divergence is the owner's rule. */
  const [discountMode, setDiscountMode] = useState<'percent' | 'amount'>('percent');
  const [discountValue, setDiscountValue] = useState('');
  const [deliveryMode, setDeliveryMode] = useState<'percent' | 'amount'>('amount');
  const [deliveryValue, setDeliveryValue] = useState('');
  /**
   * Bill-level GST % that every line on BILL_GST inherits. One vendor bill is
   * almost always one rate; retyping it on twenty lines is how one line silently
   * ends up on the wrong rate.
   *
   * DEFAULT '' = "no bill rate — each line manual unless it sets its own", which
   * is exactly what a fresh ad-hoc GRN did before this form absorbed the bill
   * entry. Nothing about an existing receipt's arithmetic changes until somebody
   * picks a rate here.
   */
  const [billGst, setBillGst] = useState('');
  // Per-line collapsible charges panel (Discount / CGST / SGST / Cess / TCS /
  // Delivery / MRP round-off). Default collapsed — most lines carry no charges.
  const [openCharges, setOpenCharges] = useState<Set<number>>(new Set());
  const toggleCharges = (i: number) => setOpenCharges(p => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const [vendors, setVendors] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  /* LIVE in-hand stock — Store and Departments as two separate figures, ONE
     batched call for the whole catalogue at modal mount (CONTRACT §4/§5.3).
     Never a per-material or per-department fetch: looping
     /api/department-stock?department_id=X costs 110 ms across 19 departments
     for a field a receiving bay has no use for. */
  const stock = useStockOnHand(true);

  // Configurable backdate limit + admin exemption. Server is the real guard;
  // these only set the receipt-date input's min/max (UX). Default: 3 days, non-admin.
  const [backdateLimit, setBackdateLimit] = useState(3);
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const [sRes, mRes] = await Promise.all([
          fetch('/api/settings?key=purchase_backdate_limit_days'),
          fetch('/api/auth/me'),
        ]);
        const sJson = await sRes.json().catch(() => null);
        const raw = sJson?.value;
        const n = Math.max(0, Math.floor(Number(raw)));
        setBackdateLimit(Number.isFinite(n) && raw != null && raw !== '' ? n : 3);
        const mJson = await mRes.json().catch(() => null);
        setIsAdmin(mJson?.user?.role === 'admin');
      } catch { /* keep defaults; server still enforces */ }
    })();
  }, []);
  const dateMin = isAdmin ? undefined : isoMinusDays(todayIST(), backdateLimit);
  const dateMax = isAdmin ? undefined : todayIST();

  // Back-correction mode — when ON, negative qtys are allowed for fixing a
  // prior GRN where the store forgot to subtract something. Default OFF so
  // the day-to-day flow can't accidentally book "-5 kg received" as if that
  // were stock IN. The flag is sent to the server in the notes for audit.
  const [isAdjustment, setIsAdjustment] = useState(false);
  const [adjustmentRef, setAdjustmentRef] = useState('');  // free-text: which prior GRN/PO this corrects

  // When showAllMaterials = true, the dropdown bypasses the vendor-contract
  // filter — used for ad-hoc cash buys / new-vendor situations where no
  // contracts exist yet.
  const [showAllMaterials, setShowAllMaterials] = useState(false);

  // Always load the full catalog up-front so the picker has data immediately.
  // The vendor-contract filter is applied client-side once the user picks a
  // vendor (see filteredMaterials below). This avoids any "empty picker" race
  // and lets the user type before / after picking a vendor in any order.
  useEffect(() => {
    fetch('/api/vendors').then(r => r.json()).then(d => setVendors((d.vendors || []).filter((v: any) => v.is_active)));
    fetch('/api/inventory?scope=all').then(r => r.json()).then(d => setMaterials(d.materials || []));
    // Whether this user may move money out of the cash box, and the next free
    // voucher number. ADVISORY: POST /api/grn re-applies both petty-cash gates
    // and fails closed, so hiding the control is a courtesy, never the rule.
    fetch('/api/grn?cash_option=1', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => { setCanRecordCash(!!d?.can_record_cash); setCashVoucher(String(d?.next_cash_voucher || '')); })
      .catch(() => { /* option simply stays hidden */ });
  }, []);

  /**
   * Which categories belong to an ACTIVE store location. Any signed-in user may
   * GET /api/stores, and it already returns each store's mapped categories, so
   * the client can recognise a TGBCL/liquor line without a new endpoint. Same
   * source purchases/page.tsx uses (fetchStoreCategories).
   */
  const [storeCats, setStoreCats] = useState<Set<string>>(new Set());
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/stores');
        if (!res.ok) return;                     // leave the set empty = "unknown"
        const json = await res.json();
        const next = new Set<string>();
        for (const st of json.stores || []) {
          // A deactivated store releases its categories back to Central behaviour —
          // same rule materialStoreId() applies server-side.
          if (!st?.is_active) continue;
          for (const c of st.categories || []) { const k = catKey(c?.category); if (k) next.add(k); }
        }
        setStoreCats(next);
      } catch {
        // Leave empty. Rates then behave normally, and the server still refuses a
        // store-mapped line outright (centralFlowBlock in /api/grn POST).
      }
    })();
  }, []);

  /**
   * ── WILL THIS DELIVERY BE HELD FOR A KITCHEN CHECK? ──────────────────────
   *
   * Answered BEFORE Save, so "why has my stock not appeared" is something the
   * receiving desk is told rather than discovers. The rule is
   * resolveQcRequirement()'s (src/lib/grn-qc.ts:322): a material's category is
   * looked up in the admin's category → checker map, anything that is not
   * 'none' holds the delivery, and THE WHOLE GRN WAITS AS ONE — the gate is not
   * per line.
   *
   * READ FROM GET /api/grn/qc?checkers=1, WHICH IS SESSION-ONLY — and that
   * matters more than it looks. The map used to come from
   * GET /api/grn/qc/categories, which is requireRole('admin'), so the ONE user
   * this form exists for — the store manager (manager tier, is_store_manager,
   * not an admin) — always got a 403 and always fell through to the "I cannot
   * read the map" branch. The exact, per-line, before-the-click warning was
   * therefore visible only to the four admins, who are not the people at the bay
   * at 6am; everyone else learned about the hold AFTER pressing Save, by which
   * time the vendor may already be pulling away. Worse, `qcPreview.required`
   * gates the disabling and the payload-stripping of the three KITCHEN
   * checkboxes below, so for that same store manager the kitchen's boxes stayed
   * live, posted, and captioned "these are the desk's own note about the goods"
   * on a delivery the server was about to hold. The new branch returns the map
   * and nothing else — no recipient mobiles, no counts, no settings.
   *
   * STILL THREE-STATE, because the honest third state still has to exist:
   *   Map   → exact, per-line, before the click. Now the normal case.
   *   false → the call failed (offline, 401 on an expired session). The form
   *           says so plainly and never guesses: a wrong "this will be held"
   *           would send somebody to argue with a vendor over nothing.
   *   null  → not back yet; render neither claim.
   */
  const [qcMap, setQcMap] = useState<Map<string, QcChecker> | null>(null);
  const [qcMapKnown, setQcMapKnown] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/grn/qc?checkers=1');
        if (!alive) return;
        if (!res.ok) { setQcMapKnown(false); return; }
        const d = await res.json();
        const m = new Map<string, QcChecker>();
        type CatRow = { category_key?: string; category?: string; checker?: string };
        for (const r of (Array.isArray(d?.checkers) ? d.checkers : []) as CatRow[]) {
          // Keyed on the SAME normalisation the server keys on. catKey() above
          // is this page's mirror of grn-qc.ts's catKeyOf(); key the map any
          // other way and 'frozen-cheese' silently stops matching 'frozen cheese'.
          const key = catKey(r?.category_key || r?.category);
          if (key) m.set(key, String(r?.checker || 'none') as QcChecker);
        }
        setQcMap(m); setQcMapKnown(true);
      } catch { if (alive) setQcMapKnown(false); }
    })();
    return () => { alive = false; };
  }, []);

  /** Is this line a store-mapped (TGBCL liquor) material — i.e. zero-rated here? */
  const storeMappedLine = (materialId: string) => {
    if (storeCats.size === 0 || !materialId) return false;
    const m = materials.find(x => x.id === materialId) as any;
    return !!m && storeCats.has(catKey(m.category));
  };

  /** The checker for ONE line, or null when the map is unreadable / unknown.
   *  Store-mapped (TGBCL) lines answer 'none' because centralFlowBlock drops
   *  them from `receivable` before the gate ever sees them — a checker on a
   *  liquor category could never fire. Declared AFTER storeMappedLine because
   *  it calls it. */
  const lineChecker = (materialId: string): QcChecker | null => {
    if (!qcMap || !materialId) return null;
    if (storeMappedLine(materialId)) return 'none';
    const m = materials.find(x => x.id === materialId) as any;
    if (!m) return null;
    // Blank category reads as 'other', exactly as the server's
    // COALESCE(NULLIF(TRIM(category),''),'other') does.
    return qcMap.get(catKey(String(m.category || '').trim() || 'other')) || 'none';
  };

  /**
   * The GST% a line should START at when this material is picked — the master's
   * raw_materials.tax_percent, which the ad-hoc GRN never read (the reported bug:
   * the rate is keyed on the master and the clerk still hand-types the rupees).
   *
   * It SEEDS, it does not FORCE: a bill is a fact, and the printed vendor invoice
   * wins over a possibly-stale master. Both refusals are transcribed verbatim from
   * purchases/page.tsx (seedGstForMaterial) — do not "simplify" either away:
   *   · store-mapped (TGBCL liquor) is zero-rated here and returns '' so no rate
   *     can ever be seeded onto it. tax_percent is a free field on the master with
   *     no liquor guard, so a manager CAN type 18 on a TGBCL item.
   *   · a rate that is not in GST_RATES (say 7) returns the fall-back rather than
   *     a value matching no <option> — React renders the select blank, the clerk
   *     reads 0%, and the calc books 7%.
   *
   * ⚠ THE FALL-BACK IS BILL_GST, NOT ''. It used to be '' — MANUAL — because this
   * form had no bill-level rate to inherit. Now it does, and '' means the opposite
   * of what "Enter Full Bill" meant by its own '': there, an unseeded line
   * followed the bill; here it would go manual and be taxed at ₹0 unless somebody
   * typed the rupees. Seeding to BILL_GST keeps the moved form's behaviour, and
   * with billGst defaulting to '' a fresh line still resolves to manual — so an
   * ad-hoc receipt entered the way it always was books exactly what it always did.
   */
  const seedGstForMaterial = (materialId: string): string => {
    if (!materialId) return BILL_GST;
    if (storeMappedLine(materialId)) return BILL_GST;
    const m = materials.find(x => x.id === materialId) as any;
    const t = Number(m?.tax_percent) || 0;
    if (t <= 0) return BILL_GST;
    const s = String(t);
    return (GST_RATES as readonly string[]).includes(s) ? s : BILL_GST;
  };

  /**
   * THE RATE A LINE IS ACTUALLY TAXED AT, as a string.
   *   '' → MANUAL: no rate, the clerk's hand-typed CGST/SGST rupees stand.
   *   otherwise a percent.
   * The ONE place BILL_GST is resolved. Every reader — the badge, lineTax, the
   * payload — goes through here, or the screen and the row disagree about which
   * rate a line carried. Store-mapped (TGBCL) lines are not this form's to tax
   * at all, so they answer manual-and-zero; lineTax's own `!storeMappedLine`
   * guard is the authority and this sits beneath it.
   */
  const resolveGst = (l: GrnLine): string => {
    if (storeMappedLine(l.material_id)) return '';
    return l.gst_rate === BILL_GST ? billGst : l.gst_rate;
  };

  /**
   * Is this quantity/price box on the CASE basis? The LABEL mirror of the guard
   * inside normaliseCaseEntry() on the server: it expands ONLY when the mode is
   * 'case' AND case_size > 1. A mode left on 'case' after switching to a
   * non-case material falls back to purchase-unit behaviour, so a label keyed on
   * entry_mode ALONE would announce a basis the arithmetic is not using — the
   * exact defect that was found and fixed once per form when there were two
   * forms (buyer read "in BTL", typed 60 cases-worth, booked 720 bottles).
   * Every annotation on this form keys on this one helper.
   */
  const caseBasis = (materialId: string, mode?: 'btl' | 'case') => {
    const cs = Number((materials.find(x => x.id === materialId) as any)?.case_size) || 1;
    return { cs, on: mode === 'case' && cs > 1 };
  };

  /**
   * The COMPENSATION CESS % a line should START at — raw_materials.cess_percent,
   * the other half of the same reported bug ("GST % and Cess % are added in the
   * Raw Material Master, but they are not picking automatically"). Seeds exactly
   * like the GST rate above, and the TGBCL refusal is identical: a store-mapped
   * line's duty rides on the store's own bill, so no rate may be seeded onto it.
   *
   * ONE DELIBERATE DIFFERENCE from seedGstForMaterial, transcribed from the
   * shipped bill form (purchases/page.tsx:498-512): there is NO GST_RATES
   * membership test. That test exists only because the GST control is a <select>
   * — a value matching no <option> renders blank and the clerk reads 0%. The cess
   * control here is a free number input (mirroring the master's own free 0-100
   * field), so any in-range value renders honestly and refusing e.g. 12.5 would
   * silently drop real money. Only non-finite / <=0 / >100 are refused.
   */
  const seedCessForMaterial = (materialId: string): string => {
    if (!materialId) return '';
    if (storeMappedLine(materialId)) return '';
    const m = materials.find(x => x.id === materialId) as any;
    const c = Number(m?.cess_percent);
    if (!Number.isFinite(c) || c <= 0 || c > 100) return '';
    return String(c);
  };

  /**
   * Per-line tax, derived. Pure — reads the line, writes nothing, so the display
   * can never drift from what submit() sends.
   *
   * BASE = ACCEPTED qty × rate − discount, not received. This is deliberate and
   * is the one place the panel departs from lineSubtotal (received-based): PO
   * Receive already books its GRN rows' cgst/sgst off the accepted gross
   * (api/purchase-orders/[id]/receive/route.ts:852, `effAcc > 0 ? effAcc : 0`).
   * If ad-hoc taxed the received qty, the same bill would carry different tax
   * depending on which screen booked it and the inward register — which mixes
   * rows from both sources — would stop being homogeneous. Copying the
   * `> 0 ? … : 0` clamp also settles back-corrections for free: a negative line
   * derives 0 tax, which is what the server's chg() (api/grn/route.ts:195, floors
   * negatives to 0) would have stored anyway, so screen and stored row agree.
   *
   * SPLIT canon: api/purchases/route.ts:363-367. Whole-paise arithmetic (the ÷100
   * for percent and the ×100 for paise cancel), SGST takes the floored half and
   * CGST absorbs the odd paisa, so the house invariant tax_value === cgst + sgst
   * holds EXACTLY. Do not re-derive either half with a float divide.
   */
  const lineTax = (l: GrnLine, share: LineShare = NO_SHARE) => {
    const eff = resolveGst(l);
    const derived = eff !== '' && !storeMappedLine(l.material_id);
    const qa = l.quantity_accepted !== '' ? n0(l.quantity_accepted) : n0(l.quantity_received);
    const q = qa > 0 ? qa : 0;
    // The line's OWN discount plus its slice of the bill-level one. Both reduce
    // the taxable base, because both are money the vendor did not charge — and
    // both are summed into the single `discount` rupee the payload sends, so the
    // screen and the stored row are looking at the same number.
    const taxable = r2(q * n0(l.unit_price) - n0(l.discount) - share.discount);
    if (!derived) return { rate: 0, taxable, tax: 0, cgst: n0(l.cgst), sgst: n0(l.sgst), derived };
    const rate = parseFloat(eff) || 0;
    const taxPaise = rate > 0 ? Math.max(0, Math.round(taxable * rate)) : 0;
    const tax = taxPaise / 100;
    const sgst = Math.floor(taxPaise / 2) / 100;
    const cgst = r2(tax - sgst);
    return { rate, taxable, tax, cgst, sgst, derived };
  };

  /**
   * Per-line GST COMPENSATION CESS, derived. Pure, like lineTax.
   *
   * ⚠ ITS TAXABLE BASE IS NOT lineTax's. THIS IS NOT A BUG AND MUST NOT BE
   * "SIMPLIFIED" INTO ONE EXPRESSION:
   *     GST  → accepted × rate − discount   (POST-discount, see lineTax above)
   *     CESS → accepted × rate              (GROSS, BEFORE discount)
   * The owner ruled the two bases apart for this requirement: on 10 kg @ ₹100
   * with a ₹100 discount, GST 18% is charged on ₹900 (= ₹162) while cess 12% is
   * charged on ₹1,000 (= ₹120). The server computes the same two bases from the
   * same two variables (api/grn/route.ts: `grossTax` for cess, `taxable` for
   * GST), so screen and stored row agree by construction. Collapse them and the
   * screen quietly under-charges cess on every discounted line.
   *
   * Everything else is inherited from lineTax verbatim: ACCEPTED qty (not
   * received) with the same `> 0 ? … : 0` clamp, so a fully-rejected line and a
   * negative back-correction both carry ₹0 cess exactly as they carry ₹0 GST;
   * and store-mapped (TGBCL) lines derive nothing at all.
   *
   * Whole paise, byte-identical in shape to api/purchases/route.ts's cess
   * expression — the ÷100 for percent and the ×100 for paise cancel, which is
   * why there is no /100 in sight. NEVER halved and NEVER added into cgst/sgst:
   * compensation cess is a separate levy and the house invariant
   * tax_value === cgst + sgst is not its business.
   *
   * rate-basis: `base` is ₹ (accepted PURCHASE-unit qty × ₹ per PURCHASE unit,
   * the same product lineTax uses); `rate` is a PERCENT, not a ₹ rate — the
   * product is paise, resolved by the /100 below.
   */
  const lineCess = (l: GrnLine) => {
    const derived = l.cess_rate !== '' && !storeMappedLine(l.material_id);
    const qa = l.quantity_accepted !== '' ? n0(l.quantity_accepted) : n0(l.quantity_received);
    const q = qa > 0 ? qa : 0;
    const base = r2(q * n0(l.unit_price));          // GROSS — no discount subtracted
    if (!derived) return { rate: 0, base, cess: 0, derived };
    const rate = parseFloat(l.cess_rate) || 0;
    const cessPaise = rate > 0 ? Math.max(0, Math.round(base * rate)) : 0;
    return { rate, base, cess: cessPaise / 100, derived };
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * THE BILL, AS ONE DOCUMENT — apportionment + the figures printed on the paper
   * ═══════════════════════════════════════════════════════════════════════════
   * Transcribed from "Enter Full Bill"'s billCalc, with two deliberate
   * differences that follow from where it now lives:
   *
   *  1. THE APPORTIONMENT BASE IS THE *RECEIVED* GOODS VALUE, not the accepted.
   *     A bill-level discount is a fact about the paper the vendor handed over,
   *     and the register's own subtotal is `quantity_received × unit_price`
   *     (lineSubtotal, and the server clamps each share to exactly that). Split
   *     on the accepted quantity and a short-accepted line would be given a
   *     smaller slice than the vendor actually gave it.
   *  2. IT DOES NOT NET ANYTHING INTO THE RATE. The old modal divided the
   *     discount into unit_price in the browser and posted the net figure;
   *     POST /api/grn does that server-side now, with grn-qc.ts's arithmetic, so
   *     a bill books identically whether the QC gate held it or not. This is a
   *     display + payload layer only.
   *
   * The discount is CLAMPED to the goods subtotal: a discount larger than the
   * goods would drive a negative cost basis and poison average_price. Flagged
   * on screen rather than silently absorbed.
   */
  const bill = useMemo(() => {
    // rate-basis: purchase — qty and rate are BOTH in the typed basis (purchase
    // units × ₹/purchase-unit, or cases × ₹/case), and the product is the same
    // money either way, which is why the shares can be computed before the
    // server expands a CASE line.
    const goods = items.map(l => r2(lineSubtotal(l)));
    const subtotal = r2(goods.reduce((s, v) => s + v, 0));
    const rawDiscount = pctOrFlat(discountMode, discountValue, subtotal);
    const discountAmount = Math.min(rawDiscount, Math.max(0, subtotal));
    const discountClamped = rawDiscount > subtotal && subtotal > 0;
    const deliveryAmount = pctOrFlat(deliveryMode, deliveryValue, subtotal);
    const shares: LineShare[] = goods.map(g => {
      const p = subtotal > 0 ? g / subtotal : 0;
      return { discount: r2(discountAmount * p), delivery: r2(deliveryAmount * p) };
    });

    // The per-line derived figures, resolved ONCE against those shares so the
    // row, the charges panel, the footer and the payload cannot disagree.
    const lines = items.map((l, i) => {
      const share = shares[i] || NO_SHARE;
      const tax = lineTax(l, share);
      const cess = lineCess(l);
      const total = lineTotal(l, tax, cess.cess, share);
      const discountAll = r2(n0(l.discount) + share.discount);
      const deliveryAll = r2(n0(l.delivery_charges) + share.delivery);
      // What one purchase unit ends up costing after every discount — the figure
      // the server will store as purchases.unit_price, so it is the one number
      // that decides what this material costs the kitchen. Shown per line.
      const acc = l.quantity_accepted !== '' ? n0(l.quantity_accepted) : n0(l.quantity_received);
      const netUnit = acc > 0 ? r2((r2(acc * n0(l.unit_price)) - discountAll) / acc) : 0;
      return { share, tax, cess, total, discountAll, deliveryAll, netUnit, goods: goods[i] };
    });

    const cgstTotal = r2(lines.reduce((s, l) => s + l.tax.cgst, 0));
    const sgstTotal = r2(lines.reduce((s, l) => s + l.tax.sgst, 0));
    // Kept OUT of the GST total on purpose: compensation cess is a separate levy
    // and the figure a GST return is filed on must stay exactly the GST figure.
    const cessTotal = r2(lines.reduce((s, l) => s + l.cess.cess, 0));
    const lineDiscounts = r2(items.reduce((s, l) => s + n0(l.discount), 0));
    const lineDelivery  = r2(items.reduce((s, l) => s + n0(l.delivery_charges), 0));
    const otherCharges  = r2(items.reduce(
      (s, l) => s + n0(l.special_excise_cess) + n0(l.tcs) + n0(l.mrp_round_off), 0));
    const totalInward = r2(lines.reduce((s, l) => s + l.total, 0));

    return {
      goods, subtotal, discountAmount, discountClamped, deliveryAmount, shares, lines,
      cgstTotal, sgstTotal, taxTotal: r2(cgstTotal + sgstTotal), cessTotal,
      lineDiscounts, lineDelivery, otherCharges, totalInward,
      /** Goods less EVERY discount — the taxable figure printed on the paper. */
      taxableTotal: r2(subtotal - discountAmount - lineDiscounts),
    };
    // storeCats/materials feed resolveGst + storeMappedLine; billGst is the rate
    // every un-overridden line resolves to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, discountMode, discountValue, deliveryMode, deliveryValue, billGst, materials, storeCats]);

  /** This line's share of the bill-level charges — the render's shorthand. */
  const shareAt = (i: number): LineShare => bill.shares[i] || NO_SHARE;

  /* ── WHAT WILL ACTUALLY LEAVE THE CASH BOX ────────────────────────────────
   * `bill.totalInward` is the whole typed bill, and the cash panel used to print
   * it under the words "the whole bill". POST /api/grn accumulates the cash from
   * `receivable` — the lines that survive centralFlowBlock — so a mixed basket
   * promised ₹2,200 before the save and recorded ₹200 after it (measured:
   * one liquor line at ₹2,000 plus one grocery line at ₹200). Store-mapped
   * (TGBCL liquor) lines are therefore taken out of the figure HERE, using the
   * same storeMappedLine() the rest of this form zero-rates them with, and the
   * money paid for them at the counter is named rather than folded in — the
   * Liquor Store rail writes no petty-cash row, so it is genuinely recorded
   * nowhere and the storekeeper has to know that before handing the notes over.
   *
   * DEGRADES TO TODAY'S NUMBER: storeMappedLine answers false when /api/stores
   * could not be read, so an unreadable map gives exactly bill.totalInward.
   *
   * `shortAccepted` counts lines the STORE refused at the bay. The cash is
   * recorded on the RECEIVED quantity (see the accumulation in POST /api/grn),
   * which is right for a market run paid at the stall and wrong for goods that
   * went back on the truck — so the panel says which it is rather than leaving
   * it to be discovered on the Purchase Report.
   */
  const cashBill = useMemo(() => {
    let total = 0, blockedTotal = 0, blocked = 0, shortAccepted = 0;
    bill.lines.forEach((l, i) => {
      const it = items[i];
      if (!it?.material_id) return;
      if (storeMappedLine(it.material_id)) { blocked++; blockedTotal = r2(blockedTotal + l.total); return; }
      total = r2(total + l.total);
      const qr = n0(it.quantity_received);
      const qa = it.quantity_accepted !== '' ? n0(it.quantity_accepted) : qr;
      if (qa < qr) shortAccepted++;
    });
    return { total, blocked, blockedTotal, shortAccepted };
    // storeCats/materials feed storeMappedLine, exactly as the bill memo above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bill, items, materials, storeCats]);

  // When a vendor is picked, fetch their MAPPED materials (vendor_materials
  // table — not contracts). User manages mappings on /vendors/materials.
  // Empty mapping → fall back to all materials.
  const [vendorMaterialIds, setVendorMaterialIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!vendorId) { setVendorMaterialIds(null); return; }
    fetch(`/api/vendor-materials?vendor_id=${encodeURIComponent(vendorId)}`)
      .then(r => r.json())
      .then(d => {
        const ids = new Set<string>((d.mappings || []).map((m: any) => m.material_id));
        setVendorMaterialIds(ids.size > 0 ? ids : null);
      })
      .catch(() => setVendorMaterialIds(null));
  }, [vendorId]);

  // Materials shown in the picker: full catalog filtered by vendor contracts
  // (unless the user opted to show all, or the vendor has no contracts).
  const filteredMaterials = (vendorMaterialIds && !showAllMaterials)
    ? materials.filter(m => vendorMaterialIds.has(m.id))
    : materials;

  /* ══ VENDOR ↔ ITEM MAPPING — CONSULTED, NEVER BLOCKING ═══════════════════
   *
   * A PURCHASE ORDER is a document we author, so /purchase-orders refuses an
   * unmapped vendor↔item pair outright. A BILL IS A FACT: it already happened,
   * the goods are at the bay, and refusing it here would only leave the
   * storekeeper holding an invoice with nowhere to enter it. So this WARNS and
   * still saves. That divergence from the strict PO rule is deliberate.
   *
   * AUTO-LEARN EXISTS, AND IT LEARNS ONCE, server-side: POST /api/grn calls
   * learnVendorMaterialPair (src/lib/vendor-learn.ts) on every receivable line
   * and returns `vendor_mapping[]` for the pairs it would not map. That array is
   * surfaced after the save. The button below is therefore NOT the only path —
   * it is for the pairs the learner will not touch: a mapping an admin
   * deliberately deleted, or a vendor typed as free text with no master row.
   *
   * Carried over from "Enter Full Bill" wholesale, and it is ADDITIVE to this
   * form's own filter: the filter narrows the picker, the ★ marks say WHY, and
   * the chips are the shortest path to the items this vendor actually supplies. */

  /** The typed vendor as a MASTER ROW id, or '' when the name is new/custom.
   *  `vendorId` is already maintained by the Vendor combobox; this is only the
   *  name the panels print beside it. */
  const vendorShort = vendor.trim() || 'this vendor';
  /** Is the typed name a real vendors row? Drives the badge under the field. */
  const vendorKnown = !!vendorId;

  /**
   * The picker's list, with this vendor's items MARKED. MaterialTypeahead is a
   * shared component that re-sorts internally, so array order cannot express
   * priority and the mark has to travel on a field it renders: the category
   * line. Marking there — not in the name — keeps the component's name-prefix
   * relevance scoring intact, and as a bonus the mark joins its search haystack,
   * so typing the vendor's name lists their items. NOTHING is filtered out here;
   * the vendor filter above is the only thing that narrows the list.
   */
  const pickerMaterials = useMemo(() => {
    if (!vendorMaterialIds || vendorMaterialIds.size === 0) return filteredMaterials;
    return filteredMaterials.map((m: any) =>
      vendorMaterialIds.has(String(m.id))
        ? { ...m, category: `★ ${vendorShort}${m.category ? ` · ${m.category}` : ''}` }
        : m,
    );
  }, [filteredMaterials, vendorMaterialIds, vendorShort]);

  /** The vendor's mapped items, alphabetical — the "show these first" list. */
  const vendorMappedMaterials = useMemo(() => {
    if (!vendorMaterialIds || vendorMaterialIds.size === 0) return [] as any[];
    return materials
      .filter((m: any) => vendorMaterialIds.has(String(m.id)))
      .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  }, [vendorMaterialIds, materials]);

  const [vendorItemsOpen, setVendorItemsOpen] = useState(false);
  const [vendorMapBusy, setVendorMapBusy] = useState(false);
  const [mapNote, setMapNote] = useState<string | null>(null);

  /**
   * PURCHASE-unit basis for every quantity on this form. /api/grn POST reads
   * quantity_received / quantity_accepted as PURCHASE units and applies the
   * ×pack_size step itself (see its "Unit-basis boundary" comment), and
   * unit_price is ₹ per purchase unit — so this is a LABEL resolver only:
   * nothing here converts, and nothing is converted on the way to the API.
   * Resolved off the FULL catalog, not filteredMaterials, so a line picked
   * before the vendor filter narrowed the list still shows its unit.
   */
  const lineUnits = (materialId: string) => {
    const m = materials.find(x => x.id === materialId) as any;
    if (!m) return { pu: '', ru: '', pf: 1 };
    const ru = String(m.unit || '');
    const pu = String(m.purchase_unit || ru || '');
    return { pu, ru, pf: packFactor({ unit: ru, purchase_unit: m.purchase_unit, pack_size: m.pack_size }) };
  };

  const addLine = () => setItems(p => [...p, blankLine()]);
  const removeLine = (i: number) => setItems(p => p.filter((_, j) => j !== i));
  const updateLine = (i: number, patch: any) => setItems(p => p.map((it, j) => j === i ? { ...it, ...patch } : it));

  /**
   * Picking/swapping the material re-seeds the line's GST% from the new material's
   * master rate — but ONLY when the current rate is still MACHINE-set: either
   * untouched ('') or exactly what the PREVIOUS material would have seeded.
   * Anything else is a rate the clerk deliberately picked off the printed bill,
   * and silently resetting it is a tax error nobody notices until the return is
   * filed. The test must stay "equals the previous seed" — a hardcoded '' would
   * clobber every seeded line on a material swap. (purchases/page.tsx:646-648.)
   *
   * One guard this form needs and the bill form does not: it still has the two
   * hand-typed ₹ boxes. Never seed a rate on top of rupees a human already
   * entered — that would take the boxes read-only and silently overwrite them.
   */
  const pickMaterial = (i: number, id: string) => {
    const cur = items[i];
    const prevSeed = seedGstForMaterial(cur.material_id);
    // "Still machine-set" is now BILL_GST (the fresh-line default) or the previous
    // material's own seed. An explicit '' is MANUAL — a choice the clerk made, and
    // silently un-choosing it would take their two hand-typed ₹ boxes read-only.
    const keep = !(cur.gst_rate === BILL_GST || cur.gst_rate === prevSeed)
      || n0(cur.cgst) !== 0 || n0(cur.sgst) !== 0;
    // Compensation cess re-seeds under the SAME "still machine-set?" test, judged
    // against ITS OWN previous seed. The `|| n0(cgst) !== 0 || n0(sgst) !== 0`
    // clause above has NO cess analogue and must not be given one: it guards the
    // two hand-typed ₹ boxes, and cess has no ₹ box on any surface — its rupees
    // are derived from the rate and nowhere else.
    const prevCessSeed = seedCessForMaterial(cur.material_id);
    const keepCess = !(cur.cess_rate === '' || cur.cess_rate === prevCessSeed);
    updateLine(i, {
      material_id: id,
      gst_rate:  keep     ? cur.gst_rate  : seedGstForMaterial(id),
      cess_rate: keepCess ? cur.cess_rate : seedCessForMaterial(id),
    });
  };

  /** Put a mapped item on the first empty line (else a new one). Refuses to add
   *  an item the bill already carries — this panel must not create the very
   *  duplicate the picker's excludeIds exists to catch. */
  const placeMaterialOnLine = (materialId: string, name: string) => {
    // Read the decision off current state and act OUTSIDE the updater — a
    // setState call inside another setState's updater is not safe.
    const at = items.findIndex(l => String(l.material_id || '').trim() === materialId);
    if (at >= 0) {
      setMapNote(`${name} is already on line ${at + 1} — add the quantity there.`);
      return;
    }
    setMapNote(null);
    // Seed the rates here too: this panel is the SECOND way a material lands on
    // a line, and a line seeded only on the picker path would tax differently
    // depending on which control the storekeeper happened to use.
    const seeded = {
      material_id: materialId,
      gst_rate: seedGstForMaterial(materialId),
      cess_rate: seedCessForMaterial(materialId),
    };
    setItems(prev => {
      const empty = prev.findIndex(l => !String(l.material_id || '').trim());
      if (empty >= 0) return prev.map((l, i) => (i === empty ? { ...l, ...seeded } : l));
      return [...prev, { ...blankLine(), ...seeded }];
    });
  };

  /** The one action that actually keeps the map current, offered where the gap
   *  is noticed. Additive only (the route's INSERT OR IGNORE), one pair. */
  const addToVendorItems = async (materialId: string, name: string) => {
    if (!vendorId || !materialId) return;
    setVendorMapBusy(true);
    setMapNote(null);
    try {
      const res = await api('/api/vendor-materials', {
        method: 'POST',
        body: { vendor_id: vendorId, material_id: materialId },
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) { setMapNote(j?.error || `Could not add ${name} to ${vendorShort}'s items.`); return; }
      setVendorMaterialIds(prev => new Set(prev ? [...prev, materialId] : [materialId]));
      setMapNote(`${name} added to ${vendorShort}'s items.`);
    } catch (err: any) {
      setMapNote(err?.message || `Could not add ${name} to ${vendorShort}'s items.`);
    } finally {
      setVendorMapBusy(false);
    }
  };

  /**
   * LINES THIS RECEIPT CANNOT TAKE — SAID BEFORE SAVE, NOT AFTER.
   *
   * centralFlowBlock() drops a store-mapped (TGBCL liquor) line from the payload
   * and reports it in `store_blocked`; the receipt otherwise SUCCEEDS. The old
   * bill form never reached this state — /api/purchases 400s the whole request
   * on a store-mapped line — so moving the form here introduced a way for a line
   * to fall off a bill that saved cleanly. SaveNotices says so afterwards; this
   * says so while there is still something to do about it.
   *
   * It does NOT block. A bill is a fact and the rest of it is perfectly
   * receivable — refusing the lot would leave a storekeeper holding an invoice
   * with nowhere to enter any of it.
   */
  const storeBlockedLines = useMemo(
    () => items.map((l, i) => ({ l, i }))
      .filter(({ l }) => l.material_id && storeMappedLine(l.material_id))
      .map(({ l, i }) => ({
        no: i + 1,
        name: String((materials.find((m: any) => m.id === l.material_id) as any)?.name || l.material_id),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, materials, storeCats],
  );

  /* ══ ONE MATERIAL = ONE LINE ═════════════════════════════════════════════
   *
   * THE RULE IS IMPORTED, NOT RESTATED — src/lib/line-dedupe.ts, the same
   * lineKey/duplicateLineGroups the PO routes and POST /api/grn's
   * duplicateLineError() enforce. Restating it here is exactly how the bill form
   * and the PO drifted apart when there were two of them.
   *
   * The picker already greys an item that is on another row (excludeIds), so a
   * repeat is hard to create — but a line can be filled by the vendor chips, and
   * `excludeMode='disable'` means the greyed row is still visible and clickable.
   * A repeat writes TWO goods_receipt_note_items rows, TWO purchases rows, TWO
   * stock bumps and two passes through updateMaterialPrice's weighted average
   * for one delivered item, so it is refused rather than warned about. The
   * server refuses the same repeat, so removing this only moves the error later.
   */
  const dupGroups = useMemo(() => {
    const groups = duplicateLineGroups(items.map(l => ({ material_id: l.material_id })));
    return groups.map(g => ({
      materialId: g.key,
      name: String((materials.find((m: any) => String(m.id) === g.key) as any)?.name || g.key),
      lineNos: g.lineNos,
    }));
  }, [items, materials]);

  /**
   * WHAT THE SERVER IS ABOUT TO DECIDE, decided here first — same rule, same
   * inputs, so the form and the route cannot disagree.
   *
   * Mirrors resolveQcRequirement() exactly:
   *   · store-mapped (TGBCL) lines are excluded, because centralFlowBlock drops
   *     them before the gate is consulted;
   *   · ANY line whose category maps to a checker holds the WHOLE delivery —
   *     the gate is per GRN, not per line (grn-qc.ts, "THE GRN IS THE UNIT");
   *   · one department across every gated line ⇒ that department, otherwise
   *     'both', which means EITHER may sign;
   *   · a BACK-CORRECTION is never gated — negative lines reduce stock to undo
   *     an over-booking, and holding a reduction for a quality check would leave
   *     the overstatement on the book for as long as the queue takes.
   * Keyed on the NEGATIVE QUANTITY, not on the back-correction checkbox: the
   * checkbox only decides whether a negative can be typed, and the server has
   * never seen it.
   *
   * ── THE BACK-CORRECTION EXEMPTION IS PER LINE, AND IT HAS TO STAY PER LINE ──
   * This preview used to set one `backCorrection` flag over the whole payload
   * and then answer "not held" for EVERY line on the bill — the same shape as
   * the `opts.hasNegativeLine` bug that was removed from resolveQcRequirement()
   * itself. The server now drops only the negative line and still weighs the
   * rest, so a bill of 40 kg asparagus + 25 kg meat + a −1 kg sugar correction
   * IS held. Leaving the mirror as it was did not add the hole back — the server
   * is the gate — but it made the form promise the opposite of what Save was
   * about to do, on the exact payload shape the fix was written for, and a form
   * that under-promises a hold is how somebody lets a vendor leave. The negative
   * line is skipped here and the flag is now only what it says on the tin: this
   * bill contains a correction, worth a sentence, not a change of verdict.
   */
  const qcPreview = useMemo(() => {
    const unknown = { known: false, required: false, checker: 'none' as QcChecker, categories: [] as string[], byLine: new Map<number, QcChecker>(), backCorrection: false };
    if (qcMapKnown !== true || !qcMap) return unknown;
    const byLine = new Map<number, QcChecker>();
    const hit = new Map<string, QcChecker>();     // display category → checker
    let backCorrection = false;
    items.forEach((l, i) => {
      if (!l.material_id) return;
      const qr = parseFloat(l.quantity_received);
      if (!Number.isFinite(qr)) return;
      const qa = l.quantity_accepted !== '' ? parseFloat(l.quantity_accepted) : qr;
      // The insert loop drops a line that is zero on BOTH figures, and the gate
      // must not arm on a row that will never exist — that is how a GRN was born
      // held with no lines and could then be neither signed nor overridden.
      if (qr === 0 && (!Number.isFinite(qa) || qa === 0)) return;
      if (storeMappedLine(l.material_id)) return;
      // Exempt THIS line, not the bill. Matches the server's `gateable` filter.
      if (qr < 0 || (Number.isFinite(qa) && qa < 0)) { backCorrection = true; return; }
      const c = lineChecker(l.material_id);
      if (!c || c === 'none') return;
      byLine.set(i, c);
      const mat = materials.find(x => x.id === l.material_id) as any;
      hit.set(String(mat?.category || 'other'), c);
    });
    if (hit.size === 0) {
      return { known: true, required: false, checker: 'none' as QcChecker, categories: [], byLine: new Map<number, QcChecker>(), backCorrection };
    }
    const kinds = new Set(hit.values());
    const checker: QcChecker = kinds.size === 1 ? [...kinds][0] : 'both';
    return { known: true, required: true, checker, categories: [...hit.keys()].sort(), byLine, backCorrection };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, qcMap, qcMapKnown, materials, storeCats]);

  /**
   * Lines the receiving desk has pre-rejected on a delivery that will be held.
   * storePreRejectBlock() (grn-qc.ts:379) refuses these with a 400, and it is
   * right to: on a held delivery the store records what ARRIVED and the checking
   * department records what is ACCEPTED — that separation is the whole of
   * decision 4, and it is what makes "accepted = 0 while waiting" mean one
   * unambiguous thing. Surfaced BEFORE Save with the server's own remedy
   * (short-receive it) rather than after a rejected round trip.
   */
  const qcPreRejectLines = useMemo(() => {
    if (!qcPreview.required) return [] as number[];
    const out: number[] = [];
    items.forEach((l, i) => {
      if (!l.material_id || l.quantity_accepted === '') return;
      const qr = parseFloat(l.quantity_received);
      const qa = parseFloat(l.quantity_accepted);
      if (!Number.isFinite(qr) || !Number.isFinite(qa)) return;
      if (storeMappedLine(l.material_id)) return;
      // A back-correction is not `gateable` on the server, so storePreRejectBlock
      // never sees it. Skipping it here too keeps this from disabling Save over a
      // line the route would have accepted without comment.
      if (qr < 0 || qa < 0) return;
      if (qa < qr - 1e-9) out.push(i);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, qcPreview.required, materials, storeCats]);

  /** What the server did to the receipt just saved, when it held it. Shown as a
   *  panel rather than an alert() — it carries who was notified and where to go
   *  next, and it is the sentence that stops the desk re-entering the delivery
   *  because "nothing happened". */
  const [held, setHeld] = useState<any>(null);

  /**
   * THE RECEIPT THAT WENT STRAIGHT THROUGH — AND CARRIED A CATEGORY NOBODY HAS
   * EVER RULED ON.
   *
   * GRN-2026-0018 (SUGUNA FOODS, 90 kg chicken leg boneless + 30 kg whole bird)
   * inwarded instantly and correctly: POULTRY had no row in the map, so the gate
   * answered "not required" exactly as it was built to. The defect was that the
   * screen then said "✓ Created — 2 material(s) updated" and closed, which is
   * indistinguishable from a working quality-check process. The owner's words:
   * "I thought we made a foolproof Quality check process."
   *
   * So an ungated receipt carrying an UNDECIDED category gets a panel of its
   * own instead of that alert. Three things it must not do:
   *   · it must NOT be folded into `held` — that panel says "no stock has been
   *     added", which on this receipt is a lie: the stock went in;
   *   · it must NOT read as a failure or a telling-off. Nothing went wrong, the
   *     receiver did nothing wrong, and the fix is an admin's to make;
   *   · it must NOT fire on a category set to "No check". That is a decision
   *     somebody made, and a warning on every ungated category means a warning
   *     on every bill — grocery alone is on most of them — which trains the desk
   *     to click past the one that matters. The server keys this on the ABSENCE
   *     of a rule, never on "not gated".
   */
  const [undecided, setUndecided] = useState<any>(null);

  /**
   * THE RECEIPT THAT WENT THROUGH AND STILL HAS SOMETHING TO SAY — a liquor line
   * that was left off the bill, or a vendor↔item pair the learner would not map.
   *
   * `store_blocked` was the dangerous one. POST /api/grn filters a store-mapped
   * (TGBCL) line out of an otherwise SUCCESSFUL receipt, and this form used to
   * render that array only inside the QC-hold panel — so on the ordinary path a
   * line vanished off the bill under a green "✓ Created" with no word about it.
   * `vendor_mapping` is the warn-half of the bill rule, carried over from
   * "Enter Full Bill": the save HAS succeeded and it is for the form to say that
   * this vendor is not declared to supply an item. Both are surfaced on EVERY
   * outcome — held, undecided and plain success.
   */
  const [received, setReceived] = useState<any>(null);

  /**
   * TICKING / UNTICKING "Paid in cash from petty cash".
   *
   * Turning it ON pre-fills the mandatory bill-number field with our own voucher
   * number, because a market run has no vendor paper and an empty required field
   * is how a real receipt gets turned away. It also clears "No vendor bill
   * number": a minted voucher IS a bill number, so declaring there is none would
   * be a contradiction — and a declared blank costs the duplicate guard.
   *
   * Turning it OFF removes the voucher again, but ONLY if the field still holds
   * exactly the voucher. A number the storekeeper typed himself is his, and
   * wiping it because a toggle moved would lose the vendor's real bill number.
   */
  const setCashOption = (next: boolean) => {
    setCashPurchase(next);
    if (next) {
      setNoBill(false);
      if (!invoice.trim() && cashVoucher) setInvoice(cashVoucher);
    } else if (invoice.trim() && invoice.trim() === cashVoucher) {
      setInvoice('');
    }
  };

  const submit = async () => {
    // Validate qtys BEFORE filtering so the user sees errors instead of silent drops.
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.material_id) continue;     // skip blank lines
      const qr = parseFloat(it.quantity_received);
      const qa = it.quantity_accepted ? parseFloat(it.quantity_accepted) : qr;
      if (Number.isNaN(qr)) { alert(`Line ${i + 1}: enter a quantity received`); return; }
      // Negatives only allowed in adjustment mode (admin-flagged back-correction).
      if (!isAdjustment && (qr < 0 || qa < 0)) {
        alert(`Line ${i + 1}: negative quantities are not allowed in normal GRN. Tick "This is a back-correction" at the top if you're fixing a prior receipt.`);
        return;
      }
      // Even in adjustment mode, received and accepted must move in the same
      // direction (both negative for a back-out, or both positive). A mixed
      // sign is almost always a typo.
      if (isAdjustment && qr !== 0 && qa !== 0 && Math.sign(qr) !== Math.sign(qa)) {
        alert(`Line ${i + 1}: received and accepted must have the same sign (both positive or both negative).`);
        return;
      }
    }
    // In normal mode keep the "positive qty" filter (drops blank lines).
    // In adjustment mode allow any non-zero qty (positive or negative).
    const cleaned = items.filter(i => {
      if (!i.material_id) return false;
      const qr = parseFloat(i.quantity_received);
      if (Number.isNaN(qr) || qr === 0) return false;
      return isAdjustment ? true : qr > 0;
    });
    if (cleaned.length === 0) { alert('Add at least one line with a material and qty'); return; }
    if (!vendor.trim()) { alert('Vendor name required'); return; }
    // A CASH RUN HAS ITS OWN WAY OUT, AND THIS GATE DID NOT KNOW ABOUT IT.
    // The server mints a PCV for a blank cash bill, so a storekeeper who ticked
    // "Paid in cash" and then cleared the pre-filled voucher was blocked here
    // and told to tick a checkbox that setCashOption deliberately clears — wrong
    // advice at the only moment it is read. The condition mirrors the payload's
    // own `cashPurchase && !isAdjustment` exactly.
    if (!invoice.trim() && !noBill && !(cashPurchase && !isAdjustment)) {
      // Mandatory since 5522138 and re-checked server-side. Said here in the
      // route's own terms so it lands before the round trip — including the way
      // out, which is a declaration, not an empty box.
      alert('The vendor\'s bill / invoice number is required — it is the only link back to the paper once the stock line is all that is left.\n\n'
          + 'If this delivery genuinely came with no bill (a cash market run, a sample, a donation, a return), tick "No vendor bill number" under the field.');
      return;
    }
    if (isAdjustment && !adjustmentRef.trim()) {
      alert('Back-correction mode: enter the prior GRN# / PO# / invoice# you\'re correcting (for audit).');
      return;
    }
    // ONE MATERIAL = ONE LINE. Refused outright, exactly like a PO and exactly
    // like the bill form this absorbed: every repeat writes its own GRN line,
    // its own purchases row and its own stock bump, so the item is delivered
    // once and booked twice. The server refuses the same repeat.
    if (dupGroups.length > 0) {
      const g = dupGroups[0];
      alert(
        `${g.name} is on line ${g.lineNos.join(' and line ')}. `
        + `One item = one line on a bill, so this receipt cannot be saved as it stands.\n\n`
        + SPLIT_RATE_REMEDY,
      );
      return;
    }
    // A discount that swallows the whole goods value zeroes every line's cost
    // basis. Carried over from "Enter Full Bill", which named this rather than
    // letting the lines fall out of the filter as "no items entered".
    if (bill.subtotal > 0 && r2(bill.discountAmount + bill.lineDiscounts) >= bill.subtotal) {
      alert(
        `The discount (${m2(r2(bill.discountAmount + bill.lineDiscounts))}) equals or exceeds the goods value `
        + `(${m2(bill.subtotal)}), so every line would be booked at ₹0 and every recipe built on these items `
        + `would be re-costed to nothing.\n\nReduce the discount, or record a free-of-charge receipt separately.`,
      );
      return;
    }
    // The same trap one line at a time: a line whose net rate rounds to ₹0 used
    // to be dropped in silence and the success message then reported fewer items
    // than were typed. POST /api/grn refuses a ₹0 rate outright now — this names
    // the line first, and names the discount when the discount is the cause.
    const zeroCost = items
      .map((l, idx) => ({ l, idx }))
      .filter(({ l, idx }) => {
        if (!l.material_id) return false;
        const acc = l.quantity_accepted !== '' ? n0(l.quantity_accepted) : n0(l.quantity_received);
        if (!(acc > 0)) return false;
        return bill.lines[idx].netUnit <= 0;
      });
    if (zeroCost.length > 0) {
      const names = zeroCost.map(({ l, idx }) => {
        const mat = materials.find((m: any) => String(m.id) === String(l.material_id)) as any;
        return mat ? `line ${idx + 1} (${mat.name})` : `line ${idx + 1}`;
      }).join(', ');
      const many = zeroCost.length > 1;
      alert(
        `Net rate is ₹0 on ${names} — ${many ? 'those lines' : 'that line'} would be stocked at no cost.\n\n`
        + `Enter a unit price, lower the discount, or remove the line${many ? 's' : ''}.`,
      );
      return;
    }
    // Mirrors storePreRejectBlock()'s refusal so it lands before the round trip,
    // in the server's own remedy. NOT a second authority — the route re-checks
    // it and refuses with the same words if this is ever wrong.
    if (qcPreRejectLines.length > 0) {
      alert(
        `Line ${qcPreRejectLines.map(i => i + 1).join(', ')}: this delivery needs a quality check, so the accepted quantity is the `
        + `checking department's to record, not the receiving desk's.\n\n`
        + `Record what actually arrived — if units went back on the truck, enter the SMALLER figure as the RECEIVED quantity instead. `
        + `The kitchen rejects what it will not take, with a reason, when it signs off.`,
      );
      return;
    }
    // A CORRECTION AND A HELD DELIVERY CANNOT SHARE ONE RECEIPT. Mirrors the
    // route's own refusal so it lands before the round trip, and in its words.
    // The two have opposite timing by design: the delivery must WAIT for the
    // kitchen, the correction must apply NOW or the over-booking it undoes stays
    // on the book until the queue clears.
    if (qcPreview.known && qcPreview.required && qcPreview.backCorrection) {
      alert(
        'This bill mixes a back-correction with goods that need a quality check, and the two cannot share one receipt.\n\n'
        + 'Save them as two receipts: the correction on its own first (it is never held and applies immediately), '
        + 'then this delivery, which will wait for the kitchen.',
      );
      return;
    }
    setBusy(true);
    try {
      /* ── A CLEARED BOX ON A CASH RUN STILL SENDS THE VOUCHER ────────────────
       * The server mints a PCV for a blank cash bill either way, so this changes
       * nothing about what is STORED. What it changes is whether the save can be
       * recognised as a repeat: a blank payload carries no number, which switches
       * off the duplicate-bill guard, its register mirror AND the voucher guard
       * at once. Measured in a browser — tick the option, clear the pre-filled
       * number, press Save twice: 201/201, ₹300 out of the box twice and the
       * stock doubled. Sending the preview the form already holds puts that save
       * back inside the voucher guard, which refuses the second one.
       * Only when there is a preview to send, and only on a cash run: a credit
       * bill's blank is a declaration and is untouched. */
      const invoiceOut = (cashPurchase && !isAdjustment && !invoice.trim() && cashVoucher)
        ? cashVoucher : invoice;
      const payload: Record<string, unknown> = {
          date, vendor_id: vendorId || null, vendor,
          // Blank ONLY as a declaration — the checkbox under the field. The
          // route refuses an undeclared blank exactly as it always did.
          invoice_number: noBill ? '' : invoiceOut,
          no_invoice_number: noBill,
          /* ── THE MONEY LEG, SENT ONLY WHEN IT IS REAL ────────────────────
           * Spread conditionally rather than sent as `false`, so the payload a
           * CREDIT bill puts on the wire is byte-identical to the one this form
           * has always sent — the key is simply absent, exactly as it was before
           * the option existed. POST /api/grn tests `cash_purchase === true`.
           *
           * `&& !isAdjustment` is belt AND braces: the Toggle is disabled on a
           * back-correction and setIsAdjustment unticks this, so both would have
           * to fail for a stale `true` to reach here. A correction moves no
           * money, and the server refuses the combination outright — this just
           * means the refusal is never reached by a screen that showed the
           * option greyed out. */
          ...(cashPurchase && !isAdjustment ? { cash_purchase: true } : {}),
          invoice_date: invoiceDate,
          qc_by: qcBy,
          // Mark back-corrections clearly in the audit trail. Prepend a tag to
          // the free-text notes so /audit and the GRN list both surface it.
          notes: isAdjustment
            ? `[BACK-CORRECTION → corrects ${adjustmentRef}] ${notes}`.trim()
            : notes,
          ...qc,
          // ── THE KITCHEN THREE ARE NOT SENT ON A DELIVERY WE KNOW WILL BE
          // HELD. The card above renders them disabled and unticked, so sending
          // a `true` left in state from before a material was picked would post
          // an answer the screen says nobody gave. The server stores whatever
          // arrives here and decideGrnQc later overwrites all three from the
          // real signer — so this changes nothing about the outcome, only about
          // whether the row briefly claims a check that was never made.
          // Only when the map was actually readable: with qcPreview unknown this
          // spread is absent and the pre-existing behaviour is untouched.
          ...(qcPreview.required
            ? { qc_quality: false, qc_temperature: false, qc_damage: false }
            : {}),
          items: cleaned.map(i => {
            // `cleaned` holds the SAME objects as `items`, so identity gives the
            // row's real index — and therefore its slice of the bill-level
            // charges. Never re-derive the share from the filtered list: a
            // dropped blank line would shift every share by one row.
            const share = shareAt(items.indexOf(i));
            const eff = resolveGst(i);
            const tx = lineTax(i, share);
            const cs = caseBasis(i.material_id, i.entry_mode);
            return {
            material_id: i.material_id,
            /* ⚠ THE RAW TYPED FIGURES, NOT EXPANDED. On the CASE basis this is a
             * count of CASES and the rate is ₹ per CASE; normaliseCaseEntry() in
             * POST /api/grn multiplies and divides them. THE BUG THAT WAS FIXED
             * TWICE was this arithmetic living in the browser, once per form —
             * doing it here would put it back, in the one place it was removed
             * from. `entry_mode` below is how the server knows. */
            quantity_received: parseFloat(i.quantity_received),
            quantity_accepted: i.quantity_accepted ? parseFloat(i.quantity_accepted) : parseFloat(i.quantity_received),
            rejection_reason:  i.rejection_reason,
            unit_price:        parseFloat(i.unit_price) || 0,
            notes:             i.notes,
            /* Per-line brand, carried over from "Enter Full Bill". Stored on the
             * GRN line AND mirrored to purchases.brand, so a QC sign-off and an
             * amend replay can both read it back. */
            brand:             i.brand,
            /* Sent only when the guard actually holds, so a mode left on 'case'
             * after swapping to a material with no case_size does not ask the
             * server for an expansion it would refuse to make. The server has
             * the same fallback either way. */
            entry_mode:        cs.on ? 'case' : 'unit',
            // The RATE rides along so the server can re-derive the split and be
            // the authority (as /api/purchases and PO Receive already are).
            // RESOLVED FIRST: a line on BILL_GST posts the bill's own percent,
            // never the sentinel. POST /api/grn reads a MISSING gst_rate as
            // "keep the hand-typed ₹", which is the opposite of "inherit" — so
            // an unresolved sentinel would silently untax the line.
            gst_rate:            eff === '' ? undefined : Number(eff),
            // The COMPENSATION CESS % rides along the same way, and ONLY the
            // percent does: no compensation_cess ₹ figure is sent. Unlike
            // cgst/sgst there is no legacy client posting one, so the server is
            // the sole author of that rupee and no payload can write money this
            // line's goods value cannot justify. undefined → no cess on the line.
            cess_rate:           i.cess_rate === '' ? undefined : Number(i.cess_rate),
            // GRN Inward per-line charges (₹). Blank → 0 on the server.
            // cgst/sgst come from lineTax so what was on screen is what is sent —
            // on a rated line these are DERIVED, never the stale box contents.
            //
            // DISCOUNT AND DELIVERY ARE THE LINE'S OWN PLUS ITS SLICE OF THE
            // BILL-LEVEL ONE. There is one `discount` column and one
            // `delivery_charges` column per line, on both documents, so the two
            // sources have to arrive as one number — and it must be the number
            // the screen showed, or the taxable base the clerk read and the one
            // the row records are different figures. The server clamps the
            // discount to the line's own goods value.
            discount:            r2(n0(i.discount) + share.discount),
            cgst:                tx.cgst,
            sgst:                tx.sgst,
            special_excise_cess: n0(i.special_excise_cess),
            tcs:                 n0(i.tcs),
            delivery_charges:    r2(n0(i.delivery_charges) + share.delivery),
            mrp_round_off:       n0(i.mrp_round_off),
          }; }),
      };
      let r = await api('/api/grn', { method: 'POST', body: payload });
      let j = await r.json();
      /* ── THE BILL NUMBER THIS VENDOR ALSO USED LAST WEEK ────────────────────
       * His suppliers reuse bill numbers: FAMOUS MUTTON SUPPLIER wrote `1122` on
       * eight different dates, and `00` / `000` show up the same way. A flat
       * refusal on (vendor, bill no) walled off 5.3% of his real bills with no
       * valid remedy — the earlier GRN is a DIFFERENT delivery, so voiding it is
       * wrong, and line-editing cannot add lines and is admin-only anyway.
       * A same-day repeat is still refused outright and never reaches here; this
       * is only the other-date case, where the honest thing is to show which
       * delivery the number was used for and let the person holding both slips
       * decide. Nothing was written before this prompt.
       */
      /* ── AND THE SAME MARKET RUN, ALREADY PAID FOR TODAY ────────────────────
       * A SECOND confirmable refusal, with its OWN flag. The two look alike and
       * are not: a repeated bill number is the vendor's document saying "same
       * paper", while this is four fields agreeing that the box has already paid
       * this amount to this vendor today. Confirming one must never confirm the
       * other, which is exactly what sharing confirm_duplicate_bill would do.
       *
       * A LOOP, NOT TWO `if`s IN A ROW, because a bill can trip BOTH and the
       * server answers them in its own order — the bill guard runs before the
       * transaction, the cash guard inside it. Two sequential blocks would take
       * the second refusal with no prompt left to answer it, and the storekeeper
       * would be stuck re-confirming the first for ever. Each answered question
       * is REMEMBERED in `confirms` and re-sent with the next attempt, so
       * confirming the bill does not un-confirm the cash. Bounded at two, which
       * is the number of questions that exist; nothing is written before a
       * prompt is answered. */
      const confirms: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 2 && !r.ok && r.status === 409; attempt++) {
        const cashDup = j?.duplicate_cash_purchase === true;
        if (!cashDup && !j?.needs_confirmation) break;
        const proceed = window.confirm(
          `${j.error}\n\n${cashDup ? 'Record this as a SECOND cash payment?' : 'Save this as a separate delivery?'}`,
        );
        if (!proceed) return;
        confirms[cashDup ? 'confirm_duplicate_cash' : 'confirm_duplicate_bill'] = true;
        r = await api('/api/grn', { method: 'POST', body: { ...payload, ...confirms } });
        j = await r.json();
      }
      if (!r.ok) { alert(j.error || 'Failed'); return; }
      // ── A HELD RECEIPT IS NOT AN alert() ──────────────────────────────────
      // "✓ Created — 0 material(s) updated" is what the old line would have said
      // about a delivery that entered no stock, which is exactly the sentence
      // that makes a storekeeper re-enter the bill an hour later. The held case
      // gets a panel that stays on screen: what was saved, what was NOT, who
      // owes the check, who has been told, and where to go. The ordinary case
      // keeps the alert it has always had — nothing about it changed.
      if (j.qc_required) { setHeld(j); return; }
      // The receipt went through. If it carried a category nobody has ever ruled
      // on, that fact gets a panel that stays on screen — see `undecided` above.
      // Checked with Array.isArray so a server that has not shipped the field
      // yet simply keeps the alert it always had.
      if (Array.isArray(j.qc_undecided_categories) && j.qc_undecided_categories.length > 0) {
        setUndecided(j);
        return;
      }
      // ── AND THE OTHER TWO THINGS A SUCCESSFUL RECEIPT CAN HAVE TO SAY ──────
      // A liquor line the route left off the bill, or a vendor↔item pair it
      // would not learn. Either one under a bare "✓ Created" is a line or a
      // mapping lost in silence, so they get a panel instead of an alert. When
      // there is nothing to report the alert is untouched — the ordinary receipt
      // still closes in one click, as it always has.
      // ── AND A THIRD: MONEY LEFT THE PETTY CASH BOX ────────────────────────
      // A cash bill never closes on an alert(). The amount, the voucher number
      // and any overdraft have to stay on screen long enough to be checked
      // against the notes that were handed over — an alert is gone the instant
      // it is dismissed, and the voucher number exists nowhere else on this
      // screen. `paid_in_cash` is absent on every credit bill, so the ordinary
      // receipt keeps the one-click alert it has always had.
      if ((Array.isArray(j.store_blocked) && j.store_blocked.length > 0)
          || (Array.isArray(j.vendor_mapping) && j.vendor_mapping.length > 0)
          || j.paid_in_cash === true) {
        setReceived(j);
        return;
      }
      alert(`✓ Created ${j.grn_number} — ${j.materials_touched} material(s) updated`
            + (j.invoice_id ? ` · Invoice ID ${j.invoice_id}` : ''));
      onCreated();
    } finally { setBusy(false); }
  };

  /**
   * THE TWO THINGS A SAVED RECEIPT CAN STILL HAVE TO SAY, rendered identically
   * on every outcome — held, undecided and plain success.
   *
   * ONE renderer, deliberately. `store_blocked` used to be printed only inside
   * the QC-hold panel, so a liquor line filtered off an otherwise-successful
   * bill vanished without a word; writing the block twice is how that comes
   * back. AMBER, never red: the receipt SAVED. Neither of these is a failure and
   * neither needs anything re-typed.
   */
  const SaveNotices = ({ j }: { j: any }) => {
    const blocked: any[] = Array.isArray(j?.store_blocked) ? j.store_blocked : [];
    const mapping: any[] = Array.isArray(j?.vendor_mapping) ? j.vendor_mapping : [];
    const cash = j?.paid_in_cash === true;
    if (blocked.length === 0 && mapping.length === 0 && !cash) return null;
    return (
      <>
        {/* ══ THE MONEY LEFT THE BOX ═══════════════════════════════════════
            GREEN, not amber: this is a thing that SUCCEEDED, and it is printed
            on every outcome — held, undecided and plain success — because the
            cash row is written on all three. The amount is here so it can be
            checked against the notes handed over, and the voucher number
            because it did not exist until this save and it is the string the
            cash box is reconciled against.

            THE HELD CASE IS THE REASON THIS PANEL EXISTS. A storekeeper who is
            not told that the money is out while the goods are not in will look
            for the purchase on the report, fail to find it, and enter the bill
            a second time. `j.qc_required` is the server's own answer, so the
            sentence tracks what actually happened rather than what the form
            predicted before saving. */}
        {cash && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900 space-y-1.5">
            <div className="font-semibold flex items-center gap-1.5">
              <Banknote className="w-4 h-4 shrink-0" />
              Petty cash — {m2(j.cash_amount)} recorded as paid out.
            </div>
            <div className="text-[11px] leading-snug">
              {/* NOT "the whole bill" WHEN A LINE WAS DROPPED. A store-mapped
                  liquor line never reaches this receipt, so the figure beside it
                  is everything that WAS received, charges and the received
                  quantity included — the amber panel below names what was left
                  off and what it was worth. */}
              {blocked.length > 0
                ? <>Everything received on this bill, charges included &mdash; the {blocked.length === 1 ? 'line' : 'lines'} left off below {blocked.length === 1 ? 'is' : 'are'} not in it.</>
                : <>The whole bill, charges included, on the quantity received.</>}
              {' '}It is on the Petty Cash log against{' '}
              <b>{j.grn_number}</b>
              {j.cash_voucher_no
                ? <> under our voucher <b className="font-mono">{j.cash_voucher_no}</b>, because this run came with no vendor bill.</>
                : <>.</>}
              {' '}These lines are marked <b>cash</b> on the Purchase Report.
            </div>
            {j.qc_required && (
              <div className="text-[11px] leading-snug bg-amber-50 border border-amber-300 rounded px-2 py-1.5 text-amber-900">
                <b>The cash is out; the goods are not in yet.</b> This delivery is held for a quality
                check, so it is not in stock and not on the Purchase Report — both arrive when the
                check is signed. <b>Do not enter this bill again.</b>
              </div>
            )}
            {/* THE BOX IS UNDER WATER. Recorded, never refused — so the only
                failure available here is saying nothing about it.

                NO HEADLINE ASSERTING A BALANCE. It used to read "The box is now
                overdrawn." in bold, and that is a claim about TODAY which the
                warning is not: outflowWarning fires on the lowest point from
                this bill's date to the END of the book, so a cash bill dated
                three days back (inside the purchase window) warns while the box
                today holds ₹19,116 — measured. A storekeeper who reads the bold
                line, counts the box and finds it full either stops trusting the
                ledger or posts a float top-up that was never needed, and that
                top-up is itself a real cash movement. The server's sentence
                already names the day, the figure and the remedy; it is left to
                speak for itself under a neutral label. */}
            {j.cash_warning && (
              <div className="text-[11px] leading-snug bg-red-50 border border-red-300 rounded px-2 py-1.5 text-red-800">
                <b>Check the cash box.</b> {j.cash_warning}
              </div>
            )}
          </div>
        )}
        {blocked.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 space-y-1.5">
            <div className="font-semibold flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {blocked.length} line{blocked.length === 1 ? '' : 's'} {blocked.length === 1 ? 'was' : 'were'} left off this bill.
            </div>
            <div className="text-[11px]">
              Liquor is procured on the store ledger, not into Central stock, so {blocked.length === 1 ? 'it' : 'they'} could not be
              received here. Nothing else on the bill was affected. Record {blocked.length === 1 ? 'it' : 'them'} on{' '}
              <b>Inventory → Liquor Store</b>.
            </div>
            {blocked[0]?.error && <div className="text-[11px] opacity-80">{blocked[0].error}</div>}
          </div>
        )}
        {mapping.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 space-y-1.5">
            <div className="font-semibold flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Saved — {mapping.length === 1 ? 'one item' : `${mapping.length} items`} could not be added to this vendor&apos;s list.
            </div>
            {mapping.map((m: any, i: number) => (
              <div key={i} className="text-[11px] leading-snug">
                {m?.material_name ? <b>{m.material_name}</b> : null}{m?.material_name ? ' — ' : ''}{m?.warning}
              </div>
            ))}
            <div className="text-[11px] opacity-80">
              The bill is recorded either way. Vendor Items only decides what this vendor&apos;s picker offers next time.
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      {/* House safe-modal shell: the card is capped to the viewport and the BODY
          scrolls internally, so the header + Save/Cancel footer are always on
          screen (previously the card grew to ~1400px and Save sat far below the
          fold on phones). The MaterialTypeahead dropdown lives inside the
          scrollable body — its absolute panel extends the body's scroll area,
          so it stays reachable. */}
      {/* max-w-6xl (was 4xl): the line table now carries the vendor bill's full
          reading across — goods → discount → taxable → tax → incl-tax — and at
          4xl every bill needed sideways scrolling to see the tax it was entered
          for. Still capped, and the table keeps its own overflow-x. */}
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-6xl shadow-xl flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <div>
            <h2 className="font-bold text-[#2D1B0E]">
              {held ? `Recorded — ${held.grn_number}`
                : undecided ? `Received — ${undecided.grn_number}`
                : received ? `Received — ${received.grn_number}`
                : 'Enter Vendor Bill — Goods Receipt Note'}
            </h2>
            {!held && !undecided && !received && (
              <p className="text-[11px] text-[#8B7355] mt-0.5">
                One vendor bill, many items. Delivery &amp; Discount split across the lines; enter each rate as the plain goods
                rate — GST is worked out per line after discount and recorded on its own.
              </p>
            )}
          </div>
          {/* Every result panel closes through onCreated: the receipt exists and
              the list behind must be refetched either way. */}
          <button onClick={held || undecided || received ? onCreated : onClose}><X className="w-5 h-5 text-[#8B7355]" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4 text-xs">
        {held ? (
          /* ── WHAT HAPPENED, AND WHAT DID NOT ────────────────────────────
             The receipt saved cleanly and no stock moved. Both halves have to
             be said, in that order, or the desk reads a hold as a failure —
             and the correction for that belief is entering the delivery a
             second time. Green-tinted heading, blue explanation: nothing here
             is a warning to the person who typed it. */
          <div className="space-y-3">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
              <div className="font-semibold flex items-center gap-1.5">
                <Save className="w-4 h-4" /> {held.grn_number} is saved — the bill, every line and every ₹ figure.
              </div>
              <div className="mt-0.5 text-[11px]">
                Nothing was lost and nothing needs re-typing. You do not need to enter this delivery again.
              </div>
            </div>

            <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 text-blue-900 space-y-1.5">
              <div className="font-semibold flex items-center gap-1.5">
                {held.qc_checker === 'bar' ? <Wine className="w-4 h-4" /> : <ChefHat className="w-4 h-4" />}
                No stock has been added yet — {CHECKER_LABEL[String(held.qc_checker || '')] || 'Kitchen'} must check the goods first.
              </div>
              {/* The server's own sentence, verbatim: it names the categories
                  that triggered the hold and what has to happen. Re-wording it
                  here is how a screen and its API start telling two stories. */}
              {held.qc_message && <div className="text-[11px]">{held.qc_message}</div>}
              {Array.isArray(held.qc_categories) && held.qc_categories.length > 0 && (
                <div className="text-[11px]">
                  Held because of: {held.qc_categories.map((c: string) => (
                    <span key={c} className="inline-block mx-0.5 px-1.5 py-0.5 rounded border border-blue-200 bg-white text-[10px]">{c}</span>
                  ))}
                </div>
              )}
              <div className="text-[11px]">
                Until they sign, <b>the vendor can still take these goods back</b> — that is what the wait is for.
                Keep the delivery at the bay if you can.
              </div>
              {/* Who was actually told. On this database nobody has a phone
                  number and push is unsubscribed, so "notified" can legitimately
                  be an empty list — say so rather than implying a ping went out
                  that did not. The bell counts the queue live either way. */}
              <div className="text-[11px]">
                {Array.isArray(held.qc_notified) && held.qc_notified.length > 0 ? (
                  <>Told: <b>{held.qc_notified.map((r: { name?: string; email?: string }) => r.name || r.email).filter(Boolean).join(', ')}</b>.</>
                ) : (
                  <>It is on the <b>Pending Quality Checks</b> queue and in the notification bell. No one could be messaged directly — go and tell them.</>
                )}
              </div>
            </div>

            {/* store_blocked used to be printed HERE and only here, which is how
                a liquor line dropped off a successful bill in silence. It is now
                rendered by the one SaveNotices block, on every outcome. */}
            <SaveNotices j={held} />

            {/* ── HELD *AND* CARRYING A CATEGORY NOBODY HAS RULED ON ────────
                One bill can be both: the vegetables hold it, and the poultry on
                the same bill has no rule at all. The hold is the headline and
                stays the headline — but without this the advisory is swallowed
                by the panel above, and the undecided half of the delivery goes
                into stock unchecked the moment the kitchen signs, with nobody
                ever having been told. Screen A already says both; this is the
                same fact, said in the one place the /grn desk will see it. */}
            {Array.isArray(held.qc_undecided_categories) && held.qc_undecided_categories.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 space-y-1.5">
                <div className="font-semibold flex items-center gap-1.5">
                  <ShieldQuestion className="w-4 h-4 shrink-0" />
                  Also on this bill, and separately: no rule has ever been set for{' '}
                  {held.qc_undecided_categories.length === 1 ? 'this category' : 'these categories'}.
                </div>
                <div className="flex flex-wrap gap-1">
                  {held.qc_undecided_categories.map((c: string) => (
                    <span key={c} className="px-1.5 py-0.5 rounded border border-amber-400 bg-white text-[10px] font-semibold">{c}</span>
                  ))}
                </div>
                <div className="text-[11px]">
                  {held.qc_undecided_categories.length === 1 ? 'It is' : 'They are'} not what is holding this delivery — nobody has
                  decided either way, so when the check above is signed{' '}
                  {held.qc_undecided_categories.length === 1 ? 'it goes' : 'they go'} into stock with everything else, unchecked.
                  Ask an admin to set it on <b>Settings → Quality Check Categories</b>.
                </div>
              </div>
            )}

            <div className="text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2 text-[11px]">
              You will see <b>{held.grn_number}</b> in the list below marked <b>awaiting kitchen QC</b>, with how long it has been waiting.
              If it is a night delivery and nobody can check it, an <b>admin or head chef</b> can release it with a written reason —
              the bill is then marked, permanently, as inwarded without a kitchen check.
            </div>
          </div>
        ) : undecided ? (
          /* ── IT WENT IN, AND NOBODY HAS EVER RULED ON WHAT WAS IN IT ──────
             Green first and amber second, in that order and no other: the
             receipt SUCCEEDED. Nothing failed, nothing is waiting, the stock is
             on hand and there is nothing for the receiving desk to undo, re-type
             or apologise for. The amber half is a fact about the SETTINGS, not
             about this delivery or the person who typed it — which is why it
             names the categories, names the screen that fixes it, and names the
             role that can (an admin), instead of leaving a storekeeper holding a
             problem they have no permission to solve. */
          <div className="space-y-3">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
              <div className="font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" /> {undecided.grn_number} is received — stock has been added.
              </div>
              <div className="mt-0.5 text-[11px]">
                {undecided.materials_touched} material{Number(undecided.materials_touched) === 1 ? '' : 's'} updated.
                The delivery is complete and nothing is waiting on anyone. You do not need to do anything with this bill.
                {undecided.invoice_id ? <> Invoice ID <b className="font-mono">{undecided.invoice_id}</b>.</> : null}
              </div>
            </div>

            <SaveNotices j={undecided} />

            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 space-y-1.5">
              <div className="font-semibold flex items-center gap-1.5">
                {/* A QUESTION MARK, NOT A WARNING TRIANGLE. The triangle is this
                    app's "something went wrong" and nothing went wrong here —
                    the receipt is clean and complete. What is missing is a
                    RULING, and the icon has to say that or the desk reads the
                    panel as a rejection of their own work. */}
                <ShieldQuestion className="w-4 h-4 shrink-0" />
                No quality check was made — nobody has ever set a rule for{' '}
                {undecided.qc_undecided_categories.length === 1 ? 'this category' : 'these categories'}.
              </div>
              <div className="flex flex-wrap gap-1">
                {undecided.qc_undecided_categories.map((c: string) => (
                  <span key={c} className="px-1.5 py-0.5 rounded border border-amber-400 bg-white text-[10px] font-semibold">{c}</span>
                ))}
              </div>
              <div className="text-[11px]">
                This is <b>not</b> the same as “no check needed”. Nobody has decided either way, so the goods went straight
                into stock unchecked. If {undecided.qc_undecided_categories.length === 1 ? 'it is' : 'they are'} perishable —
                meat, poultry, seafood, dairy — that decision is worth making before the next delivery.
              </div>
              <div className="text-[11px] border-t border-amber-300/70 pt-1.5">
                <b>What to do:</b> ask an admin to set the checker on{' '}
                <b>Settings → Quality Check Categories</b>. It takes one click per category and applies from the very
                next delivery. Nothing needs re-entering here.
              </div>
            </div>

            <div className="text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2 text-[11px]">
              You are seeing this because the category has <b>no rule at all</b> — a category an admin has deliberately set
              to <b>No check</b> never shows this message. That is what keeps it rare enough to be worth reading.
            </div>
          </div>
        ) : received ? (
          /* ── IT WENT IN, AND SOMETHING ABOUT IT IS STILL WORTH SAYING ──────
             Green first, amber second, and the green half is the headline: the
             receipt SUCCEEDED, the stock is on hand, nothing needs re-typing.
             What follows is a liquor line the route could not take here, or a
             vendor↔item pair it would not learn. Both used to be invisible
             behind "✓ Created". */
          <div className="space-y-3">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
              <div className="font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" /> {received.grn_number} is received — stock has been added.
              </div>
              <div className="mt-0.5 text-[11px]">
                {received.materials_touched} material{Number(received.materials_touched) === 1 ? '' : 's'} updated.
                {received.invoice_id ? <> Invoice ID <b className="font-mono">{received.invoice_id}</b>.</> : null}
              </div>
            </div>
            <SaveNotices j={received} />
          </div>
        ) : (
          <>
          <p className="text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
            <b>This is where a vendor bill is recorded.</b> Every hand-entered bill comes through here — a cash purchase, a
            sample, a donation, a vendor return, or the full printed invoice that used to be typed on the Purchases screen.
            On save: creates a GRN, writes <code>purchases</code> rows, bumps stock + recipe-cost cascade.
            {/* Stated in the same breath as "bumps stock", because on a gated
                delivery that sentence is not true and this is where the reader
                is being told what Save does. */}
            {' '}Perishable categories are the exception: those are recorded and <b>held until the kitchen checks them</b> —
            the bill is saved in full, but no stock appears until the kitchen signs.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {/* ── OF THE TWO DATES ON THIS FORM, THIS IS THE ONE THAT CARRIES
                THE MONEY, AND IT HAS TO SAY SO. The old bill form had a single
                "Date"; this form has Receipt Date AND Invoice date, and only
                this one reaches purchases.date — every spend report, the
                register's own from/to, the monthly totals. A clerk entering the
                18th's bill on the 24th naturally types 18 Aug into the field
                CALLED "Invoice date" (which is also the unrestricted one) and
                leaves this at today, and the spend lands on the 24th. Naming
                the consequence on both fields is the fix; moving the money to
                the bill date would fork the three writers that agree on the
                receipt date. */}
            <label className="flex flex-col gap-1 text-[#6B5744]">Receipt Date
              <input type="date" value={date} onChange={e => setDate(e.target.value)} min={dateMin} max={dateMax}
                     title="The day the goods arrived. This is the date the cost is recorded against, so it drives every spend report and the Purchases register's own date filter."
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
              <span className="text-[10px] text-[#8B7355]">
                The day the goods arrived — <b>the cost is recorded against this date</b>, not the bill&rsquo;s.
                {!isAdmin && <> Backdating limited to {backdateLimit} day(s) (admins exempt).</>}
              </span>
            </label>
            <label className="flex flex-col gap-1 text-[#6B5744]">Vendor
              <Combobox
                options={vendors.map(v => ({ value: v.name, label: v.name }))}
                value={vendor}
                allowCustom
                placeholder="Type or pick"
                onChange={(typed) => {
                  setVendor(typed);
                  const v = vendors.find(x => x.name.toLowerCase().trim() === typed.toLowerCase().trim());
                  setVendorId(v ? v.id : '');
                  setShowAllMaterials(false); // re-enable vendor-filtered picker when vendor changes
                }}
                className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm"
              />
              <datalist id="adhoc-vendors">{vendors.map(v => <option key={v.id} value={v.name} />)}</datalist>
              {/* IN THE MASTER, OR NOT — said plainly, and it is not a refusal.
                  A bill is a fact and a free-typed vendor still saves. But a
                  name that is one character off the master fragments this
                  supplier's spend across two rows in every report, and nothing
                  downstream can tell that from a genuinely new vendor. Carried
                  over from "Enter Full Bill". */}
              {vendor.trim() && (
                <span className={`text-[10px] mt-0.5 ${vendorKnown ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {vendorKnown
                    ? '✓ In the vendor master'
                    : 'New vendor — check the spelling. Their items list and auto-learn need a master row.'}
                </span>
              )}
              {vendorId && (
                <div className="flex items-center gap-1.5 text-[10px] text-[#8B7355] mt-0.5">
                  <input type="checkbox" id="show-all-mats" checked={showAllMaterials}
                         onChange={e => setShowAllMaterials(e.target.checked)} />
                  <label htmlFor="show-all-mats" className="cursor-pointer">
                    Show all materials (ignore vendor contracts)
                  </label>
                </div>
              )}
            </label>
            <label className="flex flex-col gap-1 text-[#6B5744]">QC Done By <span className="text-[10px] text-[#8B7355]">(kitchen / bar staff)</span>
              <input value={qcBy} onChange={e => setQcBy(e.target.value)} placeholder="name or email"
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
            </label>
            {/* MANDATORY, and named for whose number it is. Called "Invoice ID"
                on the detail view it feeds, which on Purchases means OUR
                auto-generated PINV — two screens, one phrase, opposite meanings.
                Required because months later the stock line is still there and
                the bill it came from is not: without this you cannot get back to
                the paper. It is also what the duplicate-bill guard keys on, and
                that guard skips any row with a blank bill number. */}
            <label className="flex flex-col gap-1 text-[#6B5744]">
              Vendor Invoice No {!noBill && <span className="text-red-600">*</span>}
              <input value={noBill ? '' : invoice} onChange={e => setInvoice(e.target.value)}
                     required={!noBill} disabled={noBill}
                     placeholder={noBill ? 'no vendor bill — declared below' : "the number printed on the vendor's bill"}
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] disabled:bg-[#F0E6DA] disabled:text-[#A89680]" />
              {/* ── THE RECEIPT THAT CAME WITH NO PAPER ────────────────────────
                  "Enter Full Bill" never required this field, and 4 of the 13
                  bills it actually produced have a blank number — the cash
                  market run, the sample, the donation, the vendor return this
                  page's own subtitle invites. Requiring it outright removed
                  that, so the capability comes back as a DECLARATION rather
                  than an empty box: blank-by-accident stays refused, blank
                  -because-there-is-no-bill is something the storekeeper says.
                  Consequence stated rather than hidden — see the note below. */}
              {/* ── AND IT IS OFF THE TABLE WHILE THE CASH OPTION IS ON ────────
                  setCashOption already clears this box, because a minted voucher
                  IS a bill number. Ticking it back afterwards was still allowed,
                  and the server's mint silently won: the storekeeper declared
                  "there is no number" and a PCV was stored anyway. Disabling it
                  is the honest half of a rule that was already one-directional —
                  the declaration and the voucher cannot both be true, and the
                  voucher is the better record because it keeps a guard. */}
              <label className={`flex items-start gap-1.5 text-[10px] text-[#8B7355] font-normal mt-0.5 ${cashPurchase ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}>
                <input type="checkbox" checked={noBill} disabled={cashPurchase}
                       onChange={e => setNoBill(e.target.checked)}
                       className="mt-0.5 accent-[#8B5E3C]" />
                <span>
                  No vendor bill number — a cash market run, a sample, a donation or a return.
                  {cashPurchase && (
                    <span className="block text-[#8B7355]">
                      Not available while <b>Paid in cash from petty cash</b> is ticked: the run already has a
                      number of ours (the voucher below), which is a better record than a declared blank
                      because the duplicate check can still see it.
                    </span>
                  )}
                  {noBill && (
                    <span className="block text-amber-800">
                      This receipt cannot be matched against a vendor statement later, and the
                      duplicate-bill check cannot see it — two entries of the same no-paper delivery
                      will both be saved.
                    </span>
                  )}
                </span>
              </label>
            </label>
            <label className="flex flex-col gap-1 text-[#6B5744]">Invoice Date
              <input type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)}
                     title="The date printed on the vendor's bill. Recorded on this receipt for matching against a vendor statement — it does not move the cost, which follows the Receipt Date."
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
              {/* Says what it does NOT do, because that is the confusion: this
                  field has no backdate limit and the money-carrying one does,
                  so it is the field a clerk reaches for when back-entering. */}
              <span className="text-[10px] text-[#8B7355]">
                The date on the vendor&rsquo;s paper. Kept for matching a statement — it does <b>not</b> move the cost.
              </span>
            </label>
          </div>

          {/* ══ BILL-LEVEL CHARGES — one figure for the whole bill ═══════════
              Carried over from "Enter Full Bill". Each is split across the lines
              in proportion to their goods value and shows on every line's
              charges panel; the per-line boxes stay for a charge that really
              does belong to one line. What each does to COST is different and
              is stated on the row, not left to be inferred. */}
          <div className="border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]/60 p-3 space-y-2.5">
            <div className="text-[11px] font-semibold text-[#6B5744] flex items-center gap-1.5">
              <Percent className="w-3.5 h-3.5" /> Bill charges — split across the lines
              <span className="font-normal text-[10px] text-[#8B7355]">leave blank if the bill has none</span>
            </div>
            <ChargeRow
              label="Discount" hint="reduces what the goods cost"
              mode={discountMode} value={discountValue}
              onMode={setDiscountMode} onValue={setDiscountValue}
              placeholder="0" total={bill.discountAmount} tone="text-emerald-700" negative
            />
            {bill.discountClamped && (
              <div className="text-[10px] text-amber-800 bg-amber-50 border border-amber-300 rounded px-2 py-1">
                The discount is larger than the goods value on this bill, so it has been capped at {m2(bill.subtotal)}.
                A discount bigger than the goods would give every line a negative cost.
              </div>
            )}
            <ChargeRow
              label="Delivery Charges" hint="recorded only — never enters unit cost"
              mode={deliveryMode} value={deliveryValue}
              onMode={setDeliveryMode} onValue={setDeliveryValue}
              placeholder="0" total={bill.deliveryAmount} tone="text-[#6B5744]"
            />
            {/* THE BILL-LEVEL GST DEFAULT. One vendor bill is almost always one
                rate; retyping it on twenty lines is how one line silently ends
                up wrong. A line may still set its own, or go Manual. */}
            <div className="flex items-center gap-3 flex-wrap border-t border-[#E8D5C4] pt-2.5">
              <span className="text-xs font-medium text-[#6B5744] min-w-[130px]">
                GST %
                <span className="block text-[10px] font-normal text-[#8B7355]">every line follows this unless it sets its own</span>
              </span>
              <select value={billGst} onChange={e => setBillGst(e.target.value)}
                      title="The bill's GST rate. Lines set to 'Bill rate' use it; a line can override it, or choose Manual and have the ₹ typed in."
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded text-xs bg-white text-[#2D1B0E]">
                <option value="">None — each line manual</option>
                {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
              </select>
              {billGst !== '' && (
                <span className="text-xs text-[#6B5744] font-mono ml-auto">
                  CGST {m2(bill.cgstTotal)} + SGST {m2(bill.sgstTotal)} = {m2(bill.taxTotal)}
                </span>
              )}
            </div>
            {/* There is deliberately NO bill-level CESS. Compensation cess is
                item-specific — the soft-drink cases on a bill carry it and the
                rest of the bill does not — so a bill-level default would seed it
                onto lines that never bore it. Per line only, seeded from the
                material master. */}
          </div>

          {/* ══ THIS VENDOR'S ITEMS — consulted, never blocking ══════════════ */}
          {vendorMappedMaterials.length > 0 && (
            <div className="border border-[#E8D5C4] rounded-lg bg-white">
              <button type="button" onClick={() => setVendorItemsOpen(o => !o)}
                      className="w-full flex items-center justify-between px-3 py-2 text-[11px] text-[#6B5744]">
                <span className="flex items-center gap-1.5">
                  <FileCheck className="w-3.5 h-3.5 text-[#af4408]" />
                  <b>{vendorShort}</b>&apos;s items ({vendorMappedMaterials.length}) — click one to put it on a line
                </span>
                {vendorItemsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
              {vendorItemsOpen && (
                <div className="px-3 pb-3 flex flex-wrap gap-1.5">
                  {vendorMappedMaterials.map((m: any) => {
                    const on = items.some(l => String(l.material_id || '').trim() === String(m.id));
                    return (
                      <button key={m.id} type="button" disabled={on}
                              onClick={() => placeMaterialOnLine(String(m.id), String(m.name))}
                              title={on ? 'Already on this bill' : `Add ${m.name} to this bill`}
                              className={`px-2 py-1 rounded-full border text-[10px] ${on
                                ? 'border-[#E8D5C4] bg-[#F3EEE7] text-[#B8A590] cursor-not-allowed'
                                : 'border-[#D4B896] bg-[#FFF8F0] text-[#6B5744] hover:border-[#af4408] hover:text-[#af4408]'}`}>
                        {m.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {mapNote && (
            <div className="text-[11px] text-[#6B5744] bg-[#FFF1E3] border border-[#E8D5C4] rounded px-2 py-1.5 flex items-start justify-between gap-2">
              <span>{mapNote}</span>
              <button type="button" onClick={() => setMapNote(null)} className="text-[#8B7355] shrink-0"><X className="w-3 h-3" /></button>
            </div>
          )}

          {/* A LINE THIS RECEIPT CANNOT TAKE, said while it can still be moved. */}
          {storeBlockedLines.length > 0 && (
            <div className="border border-amber-400 rounded-lg bg-amber-50 p-2.5 text-[11px] text-amber-900 space-y-1">
              <div className="font-semibold flex items-center gap-1.5">
                <Wine className="w-3.5 h-3.5 shrink-0" />
                Line {storeBlockedLines.map(x => x.no).join(', ')} will be left off this receipt.
              </div>
              <div>
                {storeBlockedLines.map(x => x.name).join(', ')} {storeBlockedLines.length === 1 ? 'is' : 'are'} procured on the
                store ledger, not into Central stock, so {storeBlockedLines.length === 1 ? 'it' : 'they'} cannot be received here.
                Everything else on the bill saves normally. Record {storeBlockedLines.length === 1 ? 'it' : 'them'} on{' '}
                <b>Inventory → Liquor Store</b>.
              </div>
              {(bill.discountAmount > 0 || bill.deliveryAmount > 0) && (
                <div>
                  The bill-level charges are still split across <b>every</b> line, including {storeBlockedLines.length === 1 ? 'this one' : 'these'} —
                  that is deliberate, because it is the share the vendor&apos;s own bill gives the lines that DO stay here. The totals
                  below are the whole paper; what this receipt records will be less by the dropped {storeBlockedLines.length === 1 ? 'line' : 'lines'}.
                </div>
              )}
            </div>
          )}

          {/* ONE MATERIAL = ONE LINE — the same refusal the PO carries and the
              route enforces. Raised as it is typed, not only at Save. */}
          {dupGroups.length > 0 && (
            <div className="border border-amber-400 rounded-lg bg-amber-50 p-2.5 text-[11px] text-amber-900 space-y-1">
              <div className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> The same item is on more than one line.
              </div>
              {dupGroups.map(g => (
                <div key={g.materialId}>
                  <b>{g.name}</b> — line {g.lineNos.join(' and line ')}.
                </div>
              ))}
              <div>
                Every line books its own stock movement and its own cost row, so this item would be delivered once and counted
                twice. Put the full quantity on one line. {SPLIT_RATE_REMEDY}
              </div>
            </div>
          )}

          {/* Back-correction toggle. Default OFF. Lets the store manager book
              negative-qty lines to fix a prior GRN where they forgot to subtract.
              When ON, qty inputs lose the min=0 constraint and a clear amber
              banner shows on the modal. */}
          <div className={`border rounded-lg p-3 ${isAdjustment ? 'border-amber-300 bg-amber-50/60' : 'border-[#E8D5C4] bg-[#FFF8F0]/40'}`}>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              {/* Turning a receipt into a back-correction CLEARS the cash option.
                  A correction undoes an earlier over-booking and moves no money
                  in either direction, so the two cannot share one receipt — the
                  server refuses the combination. Clearing it here means the
                  refusal is never reached from a screen that has already greyed
                  the option out, and no stale `true` survives behind a disabled
                  control. */}
              <input type="checkbox" checked={isAdjustment} onChange={e => { setIsAdjustment(e.target.checked); if (e.target.checked) setCashOption(false); if (!e.target.checked) setAdjustmentRef(''); }}
                     className="mt-0.5 accent-amber-700" />
              <div className="flex-1">
                <div className={`font-semibold ${isAdjustment ? 'text-amber-900' : 'text-[#6B5744]'}`}>
                  This is a back-correction (allow negative quantities)
                </div>
                <div className="text-[10px] text-[#6B5744] mt-0.5">
                  {isAdjustment
                    ? '🔶 Negatives allowed on this GRN. Use ONLY to correct a prior GRN where stock was over-booked. Tag the prior reference below for audit.'
                    : 'Default OFF. Receiving qty must be ≥ 0. Tick this only when fixing a prior receipt the store forgot to deduct.'}
                </div>
                {isAdjustment && (
                  <input value={adjustmentRef} onChange={e => setAdjustmentRef(e.target.value)}
                         placeholder="Prior GRN # / PO # / Invoice # being corrected *"
                         onClick={e => e.stopPropagation()}
                         onMouseDown={e => e.stopPropagation()}
                         className="mt-2 w-full px-2 py-1 border border-amber-300 rounded text-xs bg-white" />
                )}
              </div>
            </label>
          </div>

          {/* ══ PAID IN CASH FROM PETTY CASH ═══════════════════════════════
              The owner's option, on the form he asked for it on. It changes
              NOTHING about the goods: same receipt, same QC gate, same stock,
              same price cascade, same void. It adds one petty-cash row for the
              money and stamps the cost rows as cash so the Purchase Report's
              existing "Spend by Payment Mode" split finally separates them.

              Hidden entirely from anyone who may not move money out of the box
              — the server re-checks and refuses either way, so this only stops
              a control being offered that would be refused. */}
          {canRecordCash && (
            <div className={`border rounded-lg p-3 ${cashPurchase ? 'border-[#af4408] bg-[#FFF1E3]' : 'border-[#E8D5C4] bg-[#FFF8F0]/60'}`}>
              <div className="flex items-start gap-2.5">
                <Toggle
                  checked={cashPurchase}
                  disabled={isAdjustment}
                  onChange={setCashOption}
                  label="Paid in cash from petty cash"
                />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-[#2D1B0E]">
                    Paid in cash from petty cash
                    {isAdjustment && <span className="ml-2 font-normal text-[10px] text-[#8B7355]">— not available on a back-correction (it moves no money)</span>}
                  </div>
                  <div className="text-[10px] text-[#6B5744] mt-0.5">
                    Tick this when the money came out of the store cash box. One payment is recorded on
                    Petty Cash against this receipt, and these lines are marked <b>cash</b> on the Purchase Report.
                  </div>

                  {cashPurchase && (
                    <div className="mt-2 space-y-1.5 text-[11px] text-[#6B5744]">
                      {/* THE AMOUNT, NAMED — the owner's instruction was that
                          nobody should have to guess whether charges are in it,
                          or which quantity it is taken on. Total Inward is:
                          goods − discount + GST + cess + excise + TCS + delivery
                          + round-off, on the RECEIVED quantity. That sentence
                          used to live in this comment, where nobody reads it; it
                          is rendered now. */}
                      <div className="flex justify-between gap-2 bg-white border border-[#E8D5C4] rounded px-2 py-1.5">
                        <span>Cash out of the box — <b>{cashBill.blocked > 0 ? 'everything received here' : 'the whole bill'}</b>, charges included</span>
                        <b className="font-mono text-[#af4408]">{m2(cashBill.total)}</b>
                      </div>
                      <div className="text-[10px] text-[#8B7355]">
                        {/* THE SIX TERMS ARE THE WHOLE BILL — `bill` is every
                            line typed, while the figure above excludes the
                            store-mapped ones. On a mixed bill they therefore do
                            NOT add up to the headline, and reading as an
                            itemisation of it they looked wrong by the value of
                            the liquor. Said plainly instead; the amber panel
                            below names those lines and what they are worth. */}
                        {cashBill.blocked > 0 ? <>Across <b>every line typed</b>: g</> : <>G</>}oods {m2(bill.subtotal)} − discount {m2(r2(bill.discountAmount + bill.lineDiscounts))}
                        {' '}+ GST {m2(bill.taxTotal)} + cess {m2(bill.cessTotal)}
                        {' '}+ delivery {m2(r2(bill.deliveryAmount + bill.lineDelivery))} + other {m2(bill.otherCharges)},
                        {' '}on the quantity <b>received</b>.
                        {cashBill.blocked > 0 && <> The figure above is that <b>less</b> the {cashBill.blocked === 1 ? 'line' : 'lines'} named below.</>}
                        {' '}The Purchase Report shows the <b>goods</b> figure; the cash box shows what you handed over. They are not the same number and neither is wrong.
                      </div>

                      {/* A LINE THE STORE REFUSED AT THE BAY. The cash is taken
                          on RECEIVED, which is right when the notes were handed
                          over at the stall for the whole lot and wrong when the
                          vendor drove away with the refused goods and gave money
                          back. Only the person who paid knows which. */}
                      {cashBill.shortAccepted > 0 && (
                        <div className="text-[10px] text-amber-900 bg-amber-50 border border-amber-300 rounded px-2 py-1.5">
                          {cashBill.shortAccepted} line{cashBill.shortAccepted === 1 ? '' : 's'} accepted less than
                          {' '}arrived. This figure is still the <b>received</b> quantity, because that is what the vendor
                          was paid for. If he took the refused goods back and returned the money, lower the received
                          quantity too — or record a Return on Petty Cash afterwards.
                        </div>
                      )}

                      {/* THE LIQUOR LINE THE SERVER WILL DROP. It is not received
                          here at all (Inventory → Liquor Store owns that rail),
                          so it is not in the cash figure — and that rail writes
                          no petty-cash row, so cash paid for it is recorded
                          nowhere unless somebody enters it by hand. */}
                      {cashBill.blocked > 0 && (
                        <div className="text-[10px] text-amber-900 bg-amber-50 border border-amber-300 rounded px-2 py-1.5">
                          {cashBill.blocked} liquor / store-ledger line{cashBill.blocked === 1 ? '' : 's'} worth
                          {' '}<b className="font-mono">{m2(cashBill.blockedTotal)}</b> {cashBill.blocked === 1 ? 'is' : 'are'} not
                          {' '}received here and {cashBill.blocked === 1 ? 'is' : 'are'} <b>not</b> in the figure above.
                          {' '}Record {cashBill.blocked === 1 ? 'it' : 'them'} on <b>Inventory → Liquor Store</b>; if that money also
                          came out of this box, enter it on <b>Petty Cash</b> separately.
                        </div>
                      )}

                      {/* THE HELD CASE, SAID BEFORE THE SAVE. A gated cash bill
                          means the money is out now and the goods are not in —
                          a storekeeper who is not told will look for the
                          purchase on the report, not find it, and enter the
                          bill a second time. */}
                      {qcPreview.known && qcPreview.required && (
                        <div className="text-[11px] text-amber-900 bg-amber-50 border border-amber-300 rounded px-2 py-1.5">
                          <b>The cash is recorded now; the goods are not.</b> This delivery is held for a
                          {' '}{CHECKER_LABEL[qcPreview.checker]} check, so {m2(cashBill.total)} leaves the petty cash box
                          immediately while the stock and the Purchase Report line arrive only when the check is signed.
                          That is not an error — the money really left the box.
                        </div>
                      )}

                      <div className="text-[10px] text-[#8B7355]">
                        {/* THE EMPTY BOX IS ITS OWN CASE, and it used to read
                            "Recorded against bill no. —" — which was wrong twice
                            over: a cash run always ends up with a number (the
                            server mints one), and saying there is none is what
                            made clearing the field look harmless. It is not
                            harmless: the payload's number is what the repeat
                            guards key on, so the form sends this voucher even
                            when the box is empty (see submit()). */}
                        {!invoice.trim() && cashVoucher
                          ? <>Left blank, so this run will be recorded under our own voucher <b className="font-mono">{cashVoucher}</b> &mdash; the number the cash box is reconciled against. Type the vendor&rsquo;s real number in if there is one.</>
                          : invoice.trim() && invoice.trim() === cashVoucher
                          ? <>Bill no. is pre-filled with <b className="font-mono">{cashVoucher}</b>, our own voucher number for a run that came with no vendor bill. Type the vendor&rsquo;s real number over it if there is one.</>
                          : <>Recorded against bill no. <b className="font-mono">{invoice.trim() || '—'}</b>, which is the number the cash box is reconciled against.</>}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── BEFORE YOU SAVE: WILL THIS BE HELD? ────────────────────────
              The owner's ask, in his words: the store person should be told in
              advance, not left to discover afterwards that their stock never
              appeared. Three states, and the third is stated as ignorance
              rather than dressed up as an answer. */}
          {qcPreview.known && qcPreview.required && (
            <div className="border border-blue-300 rounded-lg p-3 bg-blue-50/70 text-blue-900">
              <div className="text-xs font-semibold flex items-center gap-1.5 flex-wrap">
                {qcPreview.checker === 'bar' ? <Wine className="w-4 h-4" /> : <ChefHat className="w-4 h-4" />}
                This delivery will be held for a {CHECKER_LABEL[qcPreview.checker]} check — saving it adds no stock.
              </div>
              <div className="text-[11px] mt-1 space-y-1">
                <div>
                  {/* The denominator counts the SAME lines qcPreview counted —
                      a material with no quantity typed yet is not a line the
                      server will see, and including it would make the banner
                      read "1 of 3" over a two-line bill. */}
                  {qcPreview.byLine.size} of the {items.filter(l => l.material_id && (parseFloat(l.quantity_received) || 0) !== 0).length} line(s) you have entered
                  {qcPreview.byLine.size === 1 ? ' is' : ' are'} in a category the kitchen has to judge
                  {' '}({qcPreview.categories.join(', ')}), and <b>a delivery waits as a whole</b> — the grocery on this bill waits
                  with the vegetables. If that matters, save them as two separate receipts.
                </div>
                <div>
                  The bill will be saved in full. What waits is the stock movement: nothing goes on hand, no cost row is written,
                  and the vendor can still take the goods back until {CHECKER_LABEL[qcPreview.checker].toLowerCase()} signs.
                </div>
                {/* The pre-reject refusal, before the click rather than after a
                    rejected round trip — with the lever that actually works. */}
                {qcPreRejectLines.length > 0 && (
                  <div className="rounded border border-amber-400 bg-amber-50 text-amber-900 p-2">
                    <b>Line {qcPreRejectLines.map(i => i + 1).join(', ')}: clear the Accepted box.</b> On a held delivery the accepted
                    quantity is the checking department&apos;s to record, not the receiving desk&apos;s. If units went back on the truck,
                    enter the SMALLER figure as <b>Received</b> instead — that is the true statement of what arrived.
                  </div>
                )}
              </div>
            </div>
          )}
          {qcPreview.known && qcPreview.backCorrection && !qcPreview.required && (
            <div className="border border-[#E8D5C4] rounded-lg p-2.5 bg-[#FFF8F0] text-[11px] text-[#6B5744]">
              <b>A back-correction is never held.</b> Negative lines reduce stock to undo an earlier over-booking, and holding a
              reduction for a quality check would leave the overstatement on the book for as long as the queue takes.
            </div>
          )}
          {/* THE ONE SHAPE THAT CANNOT BE SAVED AT ALL, said before the click.
              The delivery must WAIT and the correction must apply NOW; on one
              receipt the correction would be held with everything else, which
              is exactly what its exemption exists to prevent. Two documents. */}
          {qcPreview.known && qcPreview.backCorrection && qcPreview.required && (
            <div className="border border-red-300 rounded-lg p-2.5 bg-red-50 text-[11px] text-red-900">
              <b>Split this into two receipts — it cannot be saved as one.</b> A back-correction and goods that need a quality
              check have opposite timing: the delivery has to wait for the kitchen, the correction has to apply now or the
              over-booking it is undoing stays on the book until the queue clears. Save the correction on its own first, then
              this delivery.
            </div>
          )}
          {qcMapKnown === false && (
            // Honest ignorance, not a guess. The map read failed (offline, or an
            // expired session), so the form says what it does not know and what
            // will happen either way. A wrong "this will be held" would send
            // somebody to argue with a vendor over nothing. This used to be the
            // PERMANENT state for every non-admin, including the store manager —
            // GET /api/grn/qc?checkers=1 is session-only, so it is now the
            // genuine failure case it was always meant to be.
            <div className="border border-[#E8D5C4] rounded-lg p-2.5 bg-[#FFF8F0] text-[11px] text-[#6B5744] flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-px text-[#8B7355]" />
              <span>
                Perishable categories (veg, dairy, non-veg, meat, frozen, fruit) are <b>recorded and held for a kitchen check</b> —
                no stock is added until the kitchen signs. The quality-check settings could not be read just now, so this screen
                cannot tell you line by line in advance. <b>Saving will say plainly</b> whether this delivery was held, and the
                bill will show it in the list until it is signed.
              </span>
            </div>
          )}

          {/* ── THE CHECKLIST, SPLIT BY WHO CAN ACTUALLY JUDGE IT ───────────
              Owner's decision 4. It used to be one card of six boxes with a
              footnote saying who owned which — and the footnote was WRONG
              (it put expiry on the kitchen; the owner put it on the store).
              Two cards, so the split is structural instead of advisory and the
              two signatures are unambiguous. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className="border border-blue-200 rounded-lg p-3 bg-blue-50/40">
              <div className="text-xs font-semibold text-blue-900 mb-1.5 flex items-center gap-1.5 flex-wrap">
                <FileCheck className="w-3.5 h-3.5" /> Yours — the receiving desk
                <span className="text-[10px] font-normal text-blue-700">
                  ({STORE_QC_FIELDS.filter(f => qc[f.k]).length} of {STORE_QC_FIELDS.length})
                </span>
              </div>
              <div className="space-y-1.5 text-xs">
                {STORE_QC_FIELDS.map(f => (
                  <label key={f.k} className="flex items-start gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={qc[f.k]} onChange={() => toggleQc(f.k)} className="accent-blue-600 mt-0.5" />
                    <span>{f.label}</span>
                  </label>
                ))}
              </div>
              {/* The stamping rule, said out loud: a partial tick is left
                  UNSIGNED rather than stamped with a name (api/grn/route.ts:502
                  binds qc_store_by via a CASE on all three). */}
              <div className="text-[10px] text-blue-700 mt-1.5">
                {STORE_QC_FIELDS.every(f => qc[f.k])
                  ? <>All three ticked — this receipt will be stamped with <b>your name</b> as the store signature.</>
                  : <>Tick all three to sign as the store. A partial checklist is stored, but no name is put against it — a signature nobody gave is worse than none.</>}
              </div>
            </div>

            <div className={`border rounded-lg p-3 ${qcPreview.required ? 'border-[#E8D5C4] bg-[#F3EEE7]' : 'border-blue-200 bg-blue-50/40'}`}>
              <div className={`text-xs font-semibold mb-1.5 flex items-center gap-1.5 flex-wrap ${qcPreview.required ? 'text-[#6B5744]' : 'text-blue-900'}`}>
                {qcPreview.checker === 'bar' ? <Wine className="w-3.5 h-3.5" /> : <ChefHat className="w-3.5 h-3.5" />}
                {qcPreview.required ? `${CHECKER_LABEL[qcPreview.checker]}'s — not yours` : 'Kitchen / bar'}
              </div>
              <div className="space-y-1.5 text-xs">
                {KITCHEN_QC_FIELDS.map(f => (
                  <label key={f.k} className={`flex items-start gap-1.5 ${qcPreview.required ? 'cursor-not-allowed text-[#8B7355]' : 'cursor-pointer'}`}>
                    {/* DISABLED, not hidden, when the delivery will be held: the
                        checks still have to be visible so the desk knows what
                        the kitchen is going to be asked. Ticking them here would
                        be answered anyway — decideGrnQc overwrites all three from
                        the real signer, and PUT /api/grn/[id] refuses to let this
                        caller amend them afterwards. Better to say so than to
                        take an answer and silently discard it. */}
                    <input type="checkbox" disabled={qcPreview.required}
                           checked={qcPreview.required ? false : qc[f.k]}
                           onChange={() => toggleQc(f.k)} className="accent-blue-600 mt-0.5" />
                    <span>{f.label}</span>
                  </label>
                ))}
              </div>
              <div className={`text-[10px] mt-1.5 ${qcPreview.required ? 'text-[#6B5744]' : 'text-blue-700'}`}>
                {qcPreview.required
                  ? <>Recorded by whoever signs off on <b>Pending Quality Checks</b>, with their name and the time. The receiving desk cannot tick these — that is the point.</>
                  : <>This delivery is not being held, so these are the desk&apos;s own note about the goods — not a checking department&apos;s answer.</>}
              </div>
            </div>
          </div>

          {/* NOTE: no overflow-hidden on the wrapper — that clips the
              MaterialTypeahead dropdown when it opens below the input.
              Same applies to the inner div; we let absolute children escape. */}
          <div className="border border-[#E8D5C4] rounded-lg">
            {/* Sticky within the modal BODY's scroll region (the body is the
                nearest scrolling ancestor; no ancestor here clips it). By the time
                the clerk is typing materials the Vendor combobox — five fields up —
                has scrolled off screen, so the name is echoed here and follows the
                rows down. z-10 is safe: the MaterialTypeahead dropdown is portaled
                to <body> at z-[100], so it still opens OVER this bar. */}
            <div className="sticky top-0 z-10 bg-[#FFF1E3] px-3 py-1.5 text-[#6B5744] flex items-center gap-2 rounded-t-lg">
              <span className="font-semibold shrink-0">Line Items</span>
              <span className="flex-1 min-w-0 truncate text-right" title={vendor.trim() || 'No vendor selected yet'}>
                <span className="text-[9px] uppercase tracking-wide text-[#8B7355] mr-1">Vendor</span>
                {vendor.trim()
                  ? <b className="text-[#2D1B0E]">{vendor.trim()}</b>
                  : <span className="text-[#B8A590]">no vendor selected</span>}
              </span>
              <button onClick={addLine} className="hidden md:flex shrink-0 text-xs text-[#af4408] hover:underline items-center gap-1"><Plus className="w-3 h-3" /> Add line</button>
            </div>
            {/* The marker legend for the in-hand figures printed under each
                picked material. It sits here rather than inside the picker's
                own dropdown because the dropdown belongs to MaterialTypeahead,
                a component fifteen other screens share — see the handoff note
                on the in-hand block below. */}
            <StockOnHandLegend className="px-1 pb-1" />
            <div className="overflow-x-auto">
              <table className="w-full text-xs block md:table md:min-w-[600px]">
                <thead className="text-[#8B7355] hidden md:table-header-group">
                  <tr>
                    <th className="text-left  py-1 px-2 font-medium">Material</th>
                    <th className="text-right py-1 px-2 font-medium" title="In the material's PURCHASE unit (kg, L, BTL, CASE) — the unit shows under each box">Received <span className="font-normal text-[9px] text-[#B8A590]">(purchase units)</span></th>
                    <th className="text-right py-1 px-2 font-medium" title="In the material's PURCHASE unit — blank means the same as Received">Accepted <span className="font-normal text-[9px] text-[#B8A590]">(purchase units)</span></th>
                    <th className="text-left  py-1 px-2 font-medium">Reject reason</th>
                    <th className="text-right py-1 px-2 font-medium" title="₹ per PURCHASE unit (per kg / per BTL) — never per gram">Unit ₹ <span className="font-normal text-[9px] text-[#B8A590]">/ purchase unit</span></th>
                    <th className="text-right py-1 px-2 font-medium">Charges / Total ₹</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody className="block md:table-row-group">
                  {items.map((it, i) => {
                    const lu = lineUnits(it.material_id);
                    /* THE ONE GUARD EVERY LABEL ON THIS ROW KEYS ON. `on` is true
                       only when the mode is 'case' AND the material really has a
                       case_size — the same test normaliseCaseEntry() applies on
                       the server. A label keyed on entry_mode alone would announce
                       a basis the arithmetic is not using, which is the exact
                       misread that had to be fixed once per form when there were
                       two forms: "in BTL" on screen, 60 cases typed, 720 booked. */
                    const cb = caseBasis(it.material_id, it.entry_mode);
                    // Display-only hint: the raw input string is never touched here
                    // (running it through Number() on every keystroke is what made
                    // "2." untypeable), we only read it to render "= N g".
                    // SUPPRESSED on the CASE basis — the typed figure is a count of
                    // cases there, so "= N g" would be wrong by case_size.
                    const hint = (raw: string) => {
                      if (cb.on || lu.pf <= 1) return null;
                      const q = parseFloat(raw);
                      if (!Number.isFinite(q) || q === 0) return null;
                      return `= ${fmtQtyNum(q * lu.pf)} ${lu.ru}`;
                    };
                    /** The unit BOTH quantity boxes are counting, in words. */
                    const qtyUnit = cb.on ? `case (${cb.cs} ${lu.pu || 'unit'})` : lu.pu;
                    /** How many purchase units a typed CASE figure really is. */
                    const caseHint = (raw: string) => {
                      if (!cb.on) return null;
                      const q = parseFloat(raw);
                      if (!Number.isFinite(q) || q === 0) return null;
                      return `= ${fmtQtyNum(q * cb.cs)} ${lu.pu || 'unit'}`;
                    };
                    const bl = bill.lines[i];
                    const sh = shareAt(i);
                    return (
                    <Fragment key={i}>
                    <tr className="border-t border-[#E8D5C4]/50 align-top block md:table-row rounded-lg border border-[#E8D5C4] p-3 mb-2 space-y-2 md:p-0 md:mb-0 md:border-0 md:space-y-0">
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Material</span>
                        {/* excludeMode='disable', not the default 'hide': an item
                            already on another line stays VISIBLE and greyed with
                            the reason, instead of vanishing from a list the clerk
                            is scanning for it. Carried over from "Enter Full
                            Bill", where a silently-absent material read as a
                            missing master row. */}
                        <MaterialTypeahead
                          materials={pickerMaterials as any} purchaseBasis
                          value={it.material_id}
                          onPick={(id) => { setMapNote(null); pickMaterial(i, id); }}
                          excludeIds={items.map(x => x.material_id).filter((id, idx) => id && idx !== i) as string[]}
                          excludeMode="disable"
                          onExcludedPick={(m) => {
                            const at = items.findIndex(l => String(l.material_id || '').trim() === String(m.id));
                            setMapNote(`${m.name} is already on line ${at + 1} — add the quantity there. One item = one line on a bill.`);
                          }}
                        />
                        {/* BRAND — per line, free text. It was on the bill form
                            and not on this one, so it came across with the move.
                            Stored on the GRN line as well as mirrored to
                            purchases.brand, so it survives a QC hold and an
                            amendment — it used to reach the cost row on an
                            UNHELD receipt only. */}
                        {it.material_id && (
                          <input value={it.brand} onChange={e => updateLine(i, { brand: e.target.value })}
                                 placeholder="Brand (optional)"
                                 title="Free text. Stored on this GRN line and mirrored to the purchase row, so it survives a quality hold and an amendment."
                                 className="mt-1 w-full px-1.5 py-1 border border-[#E8D5C4] rounded text-[11px] bg-white" />
                        )}
                        {/* The gap the map has, offered where it is noticed. The
                            server learns a pair on save anyway; this is for the
                            ones it will not touch — a mapping an admin deleted,
                            or a vendor with no master row. */}
                        {it.material_id && vendorId && vendorMaterialIds && !vendorMaterialIds.has(it.material_id) && (
                          <button type="button" disabled={vendorMapBusy}
                                  onClick={() => addToVendorItems(it.material_id,
                                    String((materials.find((m: any) => m.id === it.material_id) as any)?.name || it.material_id))}
                                  className="mt-1 text-[10px] text-[#af4408] hover:underline disabled:opacity-50">
                            + Add to {vendorShort}&apos;s items
                          </button>
                        )}
                        {/* IN HAND, WHILE THE RECEIPT IS BEING BOOKED (owner's
                            ask #1, GRN half). Store and Departments as two
                            figures, never merged: a receiver checking a cash buy
                            needs to see that the kitchen is already holding
                            stock of the same item.
                            HANDOFF — the picker DROPDOWN still shows only the
                            central "on hand:" figure, because that line lives
                            inside MaterialTypeahead, which fifteen screens share
                            (including /recipes, which must stay in recipe units)
                            and which this task does not own. CONTRACT §5.3 has
                            the opt-in prop for it: `stockByLocation`, default
                            undefined, so every other mount renders unchanged. */}
                        {it.material_id && (
                          <StockOnHandNote data={stock.map.get(it.material_id)} loading={stock.loading}
                                           variant="line" deptScope={stock.scope} visibleDepts={stock.visible}
                                           className="mt-1" />
                        )}
                        {/* WHICH LINE CAUSED THE HOLD — beside the material that
                            caused it, so "why is my whole bill waiting?" is
                            answerable by looking rather than by asking. Only
                            rendered when the map was readable; silence is not a
                            claim that a line is ungated. */}
                        {(() => {
                          const c = qcPreview.byLine.get(i);
                          if (!c) return null;
                          return (
                            <span className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-blue-800 text-[9px] font-semibold"
                                  title={`This category needs a ${CHECKER_LABEL[c]} check. Because of it the WHOLE receipt is held — no stock is added until they sign.`}>
                              {c === 'bar' ? <Wine className="w-2.5 h-2.5" /> : <ChefHat className="w-2.5 h-2.5" />}
                              {CHECKER_LABEL[c]} check
                            </span>
                          );
                        })()}
                      </td>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Received</span>
                        <input type="number" step="any"
                               // Browser-level guard: min=0 unless this is a back-correction GRN.
                               {...(isAdjustment ? {} : { min: 0 })}
                               value={it.quantity_received}
                               onChange={e => updateLine(i, { quantity_received: e.target.value })}
                               className={`w-full md:w-20 px-1.5 py-1 border rounded text-right text-xs ${
                                 parseFloat(it.quantity_received) < 0
                                   ? 'border-amber-400 bg-amber-50 text-amber-900 font-semibold'
                                   : 'border-[#E8D5C4]'
                               }`} />
                        {lu.pu && (
                          <div className="text-[9px] text-[#B8A590] text-right mt-0.5 md:w-20">
                            {qtyUnit}
                            {caseHint(it.quantity_received) ? <> · {caseHint(it.quantity_received)}</> : null}
                            {hint(it.quantity_received) ? <> · {hint(it.quantity_received)}</> : null}
                          </div>
                        )}
                        {/* ── BTL / CASE, only where a case actually exists ──────
                            Offered ONLY when the material has case_size > 1: a
                            toggle on an item with no case is a control that
                            silently does nothing. When it is on, BOTH boxes on
                            this row change meaning — the quantity counts CASES
                            and the rate is ₹ per CASE — and every label above
                            and below says so.
                            ⚠ NOTHING IS CONVERTED HERE. The raw figures are
                            posted with entry_mode and POST /api/grn does the
                            multiply/divide. That arithmetic lived in the browser
                            once per form and had to be fixed twice; it lives in
                            the one writer now. */}
                        {cb.cs > 1 && (
                          <select value={it.entry_mode}
                                  onChange={e => updateLine(i, { entry_mode: e.target.value as 'btl' | 'case' })}
                                  title={`This material comes ${cb.cs} to a case. Pick CASE to type the bill in cases — the quantity and the rate are both read per case, and the server expands them.`}
                                  className="mt-1 w-full md:w-20 px-1 py-0.5 border border-[#E8D5C4] rounded text-[10px] bg-white text-[#2D1B0E]">
                            <option value="btl">BTL / {lu.pu || 'unit'}</option>
                            <option value="case">CASE ({cb.cs})</option>
                          </select>
                        )}
                      </td>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Accepted</span>
                        <input type="number" step="any"
                               {...(isAdjustment ? {} : { min: 0 })}
                               value={it.quantity_accepted}
                               onChange={e => updateLine(i, { quantity_accepted: e.target.value })}
                               placeholder="(=received)"
                               className={`w-full md:w-20 px-1.5 py-1 border rounded text-right text-xs ${
                                 parseFloat(it.quantity_accepted) < 0
                                   ? 'border-amber-400 bg-amber-50 text-amber-900 font-semibold'
                                   : 'border-[#E8D5C4]'
                               }`} />
                        {lu.pu && (
                          <div className="text-[9px] text-[#B8A590] text-right mt-0.5 md:w-20">
                            {qtyUnit}
                            {caseHint(it.quantity_accepted) ? <> · {caseHint(it.quantity_accepted)}</> : null}
                            {hint(it.quantity_accepted) ? <> · {hint(it.quantity_accepted)}</> : null}
                          </div>
                        )}
                        {/* On a held delivery this box is not the desk's to
                            fill: storePreRejectBlock() refuses a smaller
                            accepted figure outright. Left EDITABLE rather than
                            disabled — a value typed before the material was
                            picked has to be clearable — but named, and Save is
                            held until it is cleared. */}
                        {qcPreview.required && !storeMappedLine(it.material_id) && (
                          <div className={`text-[9px] text-right mt-0.5 md:w-20 leading-tight ${
                                qcPreRejectLines.includes(i) ? 'text-amber-800 font-semibold' : 'text-[#B8A590]'}`}>
                            {qcPreRejectLines.includes(i)
                              ? 'clear this — kitchen’s to record'
                              : `${CHECKER_LABEL[qcPreview.checker].toLowerCase()} records this`}
                          </div>
                        )}
                      </td>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Reject reason</span>
                        <select value={it.rejection_reason} onChange={e => updateLine(i, { rejection_reason: e.target.value })}
                                className="w-full px-1.5 py-1 border border-[#E8D5C4] rounded text-xs bg-[#FFF8F0]">
                          <option value="">—</option>
                          <option value="damage">damage</option>
                          <option value="short_weight">short weight</option>
                          <option value="expired">expired</option>
                          <option value="quality">quality</option>
                          <option value="rate_mismatch">rate mismatch</option>
                          <option value="other">other</option>
                        </select>
                      </td>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Unit ₹</span>
                        <input type="number" step="any" value={it.unit_price}
                                                       onChange={e => updateLine(i, { unit_price: e.target.value })}
                                                       className="w-full md:w-20 px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs" />
                        {/* ₹ per PURCHASE unit — the rate the vendor bills. The
                            weighted average is stored per RECIPE unit, but that
                            division happens server-side; never type ₹/g here.
                            On the CASE basis this is ₹ PER CASE, and the label
                            keys on the same guard the quantity boxes use. */}
                        {lu.pu && (
                          <div className="text-[9px] text-[#B8A590] text-right mt-0.5 md:w-20">
                            {cb.on ? `₹ / case (${cb.cs} ${lu.pu})` : `₹ / ${lu.pu}`}
                          </div>
                        )}
                        {/* WHAT ONE UNIT ENDS UP COSTING — after this line's own
                            discount and its slice of the bill's. This is the
                            figure the server stores as purchases.unit_price, so
                            it is the number that decides what the kitchen pays
                            for this material and what every recipe built on it
                            costs. Shown only when a discount actually moved it. */}
                        {it.material_id && bl && (bl.discountAll > 0) && bl.netUnit > 0 && (
                          <div className="text-[9px] text-emerald-700 text-right mt-0.5 md:w-20 leading-tight"
                               title="Net of every discount — this is what is stored as the cost of one purchase unit.">
                            net {m2(cb.on && cb.cs > 1 ? bl.netUnit / cb.cs : bl.netUnit)}
                            <span className="block text-[8px] text-[#8B7355]">/ {lu.pu || 'unit'}</span>
                          </div>
                        )}</td>
                      <td className="py-1 px-2 text-right block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Charges / Total</span>
                        <div className="flex items-center justify-end gap-1.5">
                          {/* The charges panel is collapsed by default, so a rate
                              seeded from the master would otherwise change the row
                              total with nothing on screen explaining it. */}
                          {resolveGst(it) !== '' && !storeMappedLine(it.material_id) && (
                            <span className="px-1.5 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-800 text-[10px] font-semibold"
                                  title={it.gst_rate === BILL_GST
                                    ? 'GST% inherited from the bill-level rate above. Override it in the charges panel for a line the vendor billed differently.'
                                    : 'GST% on this line — from the material master, editable in the charges panel'}>
                              GST {resolveGst(it)}%{it.gst_rate === BILL_GST ? ' (bill)' : ''}
                            </span>
                          )}
                          {/* Same reason as the GST badge: the panel is collapsed by
                              default, so a cess rate seeded from the master would
                              otherwise move the row total with nothing on screen
                              explaining it. Its own badge, never merged into the GST
                              one — they are separate levies on different bases. */}
                          {it.cess_rate !== '' && !storeMappedLine(it.material_id) && (
                            <span className="px-1.5 py-0.5 rounded border border-violet-200 bg-violet-50 text-violet-800 text-[10px] font-semibold"
                                  title="Compensation cess% on this line — from the material master (Cess %), charged on the gross line value before discount. Editable in the charges panel.">
                              Cess {it.cess_rate}%
                            </span>
                          )}
                          <button type="button" onClick={() => toggleCharges(i)}
                                  className={`px-1.5 py-0.5 rounded border text-[10px] flex items-center gap-1 ${
                                    openCharges.has(i) ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}>
                            <Percent className="w-2.5 h-2.5" /> {openCharges.has(i) ? 'hide' : 'charges'}
                          </button>
                          {/* The bill-level shares are in this figure, so the row
                              total is what the vendor actually charged for this
                              line — not the goods value with the bill's discount
                              still sitting somewhere else on the screen. */}
                          <span className="font-mono font-semibold text-[#2D1B0E] min-w-[64px] text-right">
                            {(n0(it.quantity_received) && n0(it.unit_price)) ? `₹${(bl?.total ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                          </span>
                        </div>
                      </td>
                      <td className="py-1 px-2 text-right block md:table-cell"><button onClick={() => removeLine(i)} className="text-red-500"><Trash2 className="w-3 h-3" /></button></td>
                    </tr>
                    {openCharges.has(i) && (
                      <tr className="block md:table-row">
                        <td colSpan={7} className="block md:table-cell px-2 pb-3 md:pb-2">
                          <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-2.5">
                            <div className="text-[10px] font-semibold text-[#6B5744] mb-1.5">Line charges (₹) — leave 0 if not applicable</div>
                            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
                              {([
                                ['discount', 'Discount'], ['cgst', 'CGST'], ['sgst', 'SGST'],
                                ['special_excise_cess', 'Special Excise Cess'], ['tcs', 'TCS'],
                                ['delivery_charges', 'Delivery Charges'], ['mrp_round_off', 'MRP Round Off'],
                              ] as const).map(([k, label]) => {
                                const tx = lineTax(it, sh);
                                const cs = lineCess(it);
                                const isTaxBox = k === 'cgst' || k === 'sgst';
                                return (
                                <Fragment key={k}>
                                {/* GST % sits immediately BEFORE the two boxes it drives. */}
                                {k === 'cgst' && (
                                  <label className="flex flex-col gap-0.5 text-[9px] uppercase tracking-wide text-[#8B7355]">
                                    GST %
                                    {storeMappedLine(it.material_id) ? (
                                      // The rate is not the clerk's to set here: this material
                                      // belongs to a store location, where excise / cess / TCS
                                      // are charged on the store's own bill. A GST% on it would
                                      // be tax that was never paid.
                                      <div className="text-[10px] text-blue-700 leading-tight normal-case px-1.5 py-1">
                                        0%
                                        <span className="block text-[9px] text-[#8B7355]">store item — taxed on the TGBCL bill</span>
                                      </div>
                                    ) : (
                                      <select value={it.gst_rate}
                                              onChange={e => {
                                                const v = e.target.value;
                                                // Dropping back to Manual freezes the last derived
                                                // figures into the boxes ONCE, so they don't blank
                                                // out under the clerk mid-edit.
                                                if (v === '' && tx.derived) updateLine(i, { gst_rate: '', cgst: String(tx.cgst), sgst: String(tx.sgst) });
                                                else updateLine(i, { gst_rate: v });
                                              }}
                                              title="Seeded from the material master (raw_materials.tax_percent). 'Bill rate' follows the GST% set on the bill above. Change it for a line the vendor billed at a different rate; Manual lets you type the ₹ yourself."
                                              className="px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs bg-white text-[#2D1B0E] normal-case">
                                        {/* THREE STATES, and the sentinel is not ''.
                                            '' here has always meant MANUAL on this form —
                                            the opposite of what it meant on the bill form
                                            it absorbed, where '' meant "inherit". Giving
                                            "follow the bill" its own value is what keeps
                                            both meanings, and resolveGst() turns it into a
                                            real percent before anything is posted. */}
                                        <option value={BILL_GST}>
                                          Bill rate{billGst !== '' ? ` (${billGst}%)` : ' — none set'}
                                        </option>
                                        <option value="">Manual (enter ₹)</option>
                                        {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                                      </select>
                                    )}
                                  </label>
                                )}
                                {/* COMPENSATION CESS sits between the GST pair and the
                                    TGBCL Special Excise Cess box, so the reading order
                                    matches the Total Inward term order and the two
                                    "cess" controls are visibly different levies.
                                    A RATE box and a DERIVED ₹ readout — there is no
                                    hand-typed cess ₹ anywhere in this app, which is
                                    why the rate box needs no Manual escape hatch. */}
                                {k === 'special_excise_cess' && (
                                  <>
                                    <label className="flex flex-col gap-0.5 text-[9px] uppercase tracking-wide text-[#8B7355]">
                                      Cess %
                                      {storeMappedLine(it.material_id) ? (
                                        // Same refusal as GST%: this material belongs to a
                                        // store location, where the duty is charged on the
                                        // store's own bill. A cess% here would be money
                                        // that was never levied on this receipt.
                                        <div className="text-[10px] text-blue-700 leading-tight normal-case px-1.5 py-1">
                                          0%
                                          <span className="block text-[9px] text-[#8B7355]">store item — cess rides on the TGBCL bill</span>
                                        </div>
                                      ) : (
                                        // A FREE number box, not a <select>: compensation cess
                                        // has no fixed rate card, the master's own field is a
                                        // free 0-100, and refusing e.g. 12.5 would silently
                                        // drop real money.
                                        <input type="number" step="0.01" min={0} max={100}
                                               value={it.cess_rate}
                                               onChange={e => updateLine(i, { cess_rate: e.target.value })}
                                               placeholder="0"
                                               title="GST compensation cess %, seeded from the material master (Cess %). Editable — the printed vendor bill wins. Charged on the GROSS line value BEFORE discount, which is NOT the base GST uses."
                                               className="px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs bg-white text-[#2D1B0E] normal-case" />
                                      )}
                                    </label>
                                    <label className="flex flex-col gap-0.5 text-[9px] uppercase tracking-wide text-[#8B7355]">
                                      Compensation Cess
                                      <input type="number" step="any" readOnly value={cs.cess.toFixed(2)}
                                             title="Derived from Cess % — the server re-derives the same figure and is the authority. Never added into CGST/SGST."
                                             className="px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs text-[#2D1B0E] normal-case bg-[#F3EEE7] cursor-not-allowed" />
                                      <span className="text-[8px] text-[#8B7355] normal-case">derived from Cess %</span>
                                    </label>
                                  </>
                                )}
                                <label className="flex flex-col gap-0.5 text-[9px] uppercase tracking-wide text-[#8B7355]">
                                  {label}
                                  <input type="number" step="any"
                                         readOnly={isTaxBox && tx.derived}
                                         value={isTaxBox && tx.derived
                                           ? (k === 'cgst' ? tx.cgst : tx.sgst).toFixed(2)
                                           : (it as any)[k]}
                                         onChange={e => updateLine(i, { [k]: e.target.value })}
                                         placeholder="0"
                                         className={`px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs text-[#2D1B0E] normal-case ${
                                           isTaxBox && tx.derived ? 'bg-[#F3EEE7] cursor-not-allowed' : 'bg-white'}`} />
                                  {isTaxBox && tx.derived && (
                                    <span className="text-[8px] text-[#8B7355] normal-case">derived from GST %</span>
                                  )}
                                  {/* THE LINE'S SLICE OF THE BILL-LEVEL CHARGE, printed
                                      under the box it is added to. Without this the row
                                      total would move when the bill discount changes and
                                      nothing on the line would explain why — and a clerk
                                      reconciling against the paper would read the box as
                                      the whole story. */}
                                  {k === 'discount' && sh.discount > 0 && (
                                    <span className="text-[8px] text-emerald-700 normal-case">
                                      + {m2(sh.discount)} share of the bill discount = {m2(bl.discountAll)}
                                    </span>
                                  )}
                                  {k === 'delivery_charges' && sh.delivery > 0 && (
                                    <span className="text-[8px] text-[#8B7355] normal-case">
                                      + {m2(sh.delivery)} share of the bill delivery = {m2(bl.deliveryAll)}
                                    </span>
                                  )}
                                </label>
                                </Fragment>
                              ); })}
                            </div>
                            {/* ── THE READING ACROSS, AS THE PAPER READS ─────────
                                goods → discount → taxable → tax → cess → incl-tax.
                                Carried over from "Enter Full Bill", where it was
                                eleven columns on the row itself; here it is one
                                strip under the boxes it explains, so a clerk can
                                follow the vendor's own arithmetic left to right
                                without holding two of the figures in their head. */}
                            <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 mt-2 text-[11px] text-[#6B5744]">
                              <span>Goods <b className="text-[#2D1B0E] font-mono">{m2(lineSubtotal(it))}</b></span>
                              {bl.discountAll > 0 && (
                                <span title="This line's own discount plus its share of the bill-level one. It lowers the cost basis — the server nets it into the stored unit price.">
                                  Discount <b className="text-emerald-700 font-mono">− {m2(bl.discountAll)}</b>
                                </span>
                              )}
                              {bl.tax.derived && (
                                // Named explicitly because it is NOT the Goods figure beside
                                // it: tax rides on the ACCEPTED qty (what PO Receive books), so
                                // on a partially-rejected line the two legitimately differ.
                                <span title="GST is charged on the accepted quantity, after every discount — the same base the PO → Receive path uses.">
                                  Taxable <b className="text-[#2D1B0E] font-mono">{m2(bl.tax.taxable)}</b>
                                </span>
                              )}
                              {bl.tax.derived && (
                                <span title="CGST + SGST. The house invariant is tax = cgst + sgst exactly; the odd paisa goes to CGST, as it does on the stored row.">
                                  GST {bl.tax.rate}% <b className="text-[#2D1B0E] font-mono">{m2(bl.tax.tax)}</b>
                                  <span className="text-[9px] text-[#8B7355]"> (C {m2(bl.tax.cgst)} + S {m2(bl.tax.sgst)})</span>
                                </span>
                              )}
                              {bl.cess.derived && (
                                // Printed BESIDE the taxable figure, not instead of it,
                                // because on a discounted line the two are DIFFERENT
                                // numbers and that is deliberate: cess is charged on the
                                // gross, GST after the discount. Shown side by side so a
                                // reader checking the bill sees the rule rather than a bug.
                                <span title="Compensation cess is charged on the accepted quantity BEFORE the discount — a different base from GST, on purpose. Never folded into CGST/SGST.">
                                  Cess {bl.cess.rate}% on {m2(bl.cess.base)} <b className="text-[#2D1B0E] font-mono">{m2(bl.cess.cess)}</b>
                                </span>
                              )}
                              <span>Total Inward <b className="text-[#af4408] font-mono">{m2(bl.total)}</b></span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ); })}
                </tbody>
                {/* Live totals footer — recomputes on every line edit/remove
                    so the staff always sees the up-to-date GRN value. Counts
                    negative back-correction lines in the totals the same way
                    the server + print do, so the three numbers match end-to-end. */}
                {(() => {
                  const filled = items.filter(ln => ln.material_id && (parseFloat(ln.quantity_received) || 0) !== 0);
                  const totRec = items.reduce((s, ln) => s + (parseFloat(ln.quantity_received) || 0), 0);
                  const totAcc = items.reduce((s, ln) => s + (parseFloat(ln.quantity_accepted) || parseFloat(ln.quantity_received) || 0), 0);
                  // Straight off the one `bill` memo — never re-summed here, or the
                  // footer and the rows could disagree about the same bill.
                  const totInward = bill.totalInward;
                  const lineCount = filled.length;
                  if (lineCount === 0) return null;
                  // A qty total only exists when every filled line is in the SAME
                  // purchase unit. 12 BTL + 3 kg is not 15 of anything — print an
                  // em-dash and keep the ₹ total, which is always addable. A CASE
                  // line counts CASES, so its basis joins the set too: 5 cases and
                  // 5 bottles are not 10 of anything either.
                  const units = new Set(filled.map(ln => {
                    const c = caseBasis(ln.material_id, ln.entry_mode);
                    return c.on ? `case:${lineUnits(ln.material_id).pu}` : lineUnits(ln.material_id).pu.toLowerCase().trim();
                  }).filter(Boolean));
                  const first = caseBasis(filled[0].material_id, filled[0].entry_mode);
                  const oneUnit = units.size === 1
                    ? (first.on ? `case (${first.cs})` : lineUnits(filled[0].material_id).pu)
                    : null;
                  const qtyCell = (v: number) => oneUnit
                    ? <>{v.toLocaleString('en-IN', { maximumFractionDigits: 3 })} <span className="text-[9px] font-normal text-[#B8A590]">{oneUnit}</span></>
                    : <span className="text-[#B8A590]" title="Lines are in different purchase units (e.g. kg and BTL) — a single quantity total would mix units. The ₹ total is unaffected.">—</span>;
                  return (
                    <tfoot className="bg-[#FFF1E3]/60 font-semibold text-[#2D1B0E] block md:table-footer-group">
                      <tr className="block md:table-row">
                        <td className="py-1.5 px-2 text-right text-[10px] text-[#6B5744] block md:table-cell">{lineCount} line{lineCount === 1 ? '' : 's'}</td>
                        <td className="py-1.5 px-2 text-right font-mono block md:table-cell">{qtyCell(totRec)}</td>
                        <td className="py-1.5 px-2 text-right font-mono block md:table-cell">{qtyCell(totAcc)}</td>
                        <td className="py-1.5 px-2 block md:table-cell"></td>
                        <td className="py-1.5 px-2 text-right text-[10px] text-[#6B5744] block md:table-cell">Total Inward ₹</td>
                        <td className="py-1.5 px-2 text-right font-mono text-emerald-800 block md:table-cell">
                          ₹{totInward.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-1.5 px-2 block md:table-cell"></td>
                      </tr>
                    </tfoot>
                  );
                })()}
              </table>
            </div>
          </div>
          {/* Primary Add-line — full width at the BOTTOM so on mobile the button
              sits right below the material you just added (rather than off-screen
              at the top of the box). Desktop keeps the compact top button. */}
          <button type="button" onClick={addLine} className="mt-2 w-full flex items-center justify-center gap-1.5 py-2.5 border-2 border-dashed border-[#E8D5C4] rounded-lg text-sm font-medium text-[#af4408] hover:border-[#af4408] hover:bg-[#FFF1E3] active:bg-[#FFE8D5]"><Plus className="w-4 h-4" /> Add line</button>

          {/* ══ THE BILL, THE WAY THE PAPER STATES IT ═══════════════════════
              The eight figures a storekeeper checks against the printed invoice
              before saving, in the vendor's own reading order. Carried over from
              "Enter Full Bill". Every one comes from the single `bill` memo the
              rows and the payload use, so this strip cannot drift from what is
              about to be posted. */}
          {bill.subtotal > 0 && (
            <div className="border border-[#E8D5C4] rounded-lg bg-[#FFF1E3]/50 p-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-y-1.5 gap-x-4 text-[11px] text-[#6B5744]">
                <span className="flex justify-between gap-2">Goods value <b className="font-mono text-[#2D1B0E]">{m2(bill.subtotal)}</b></span>
                <span className="flex justify-between gap-2" title="Bill-level discount plus every per-line discount. It lowers the cost basis.">
                  Discount <b className="font-mono text-emerald-700">− {m2(r2(bill.discountAmount + bill.lineDiscounts))}</b>
                </span>
                <span className="flex justify-between gap-2">Taxable <b className="font-mono text-[#2D1B0E]">{m2(bill.taxableTotal)}</b></span>
                <span className="flex justify-between gap-2">CGST <b className="font-mono text-[#2D1B0E]">{m2(bill.cgstTotal)}</b></span>
                <span className="flex justify-between gap-2">SGST <b className="font-mono text-[#2D1B0E]">{m2(bill.sgstTotal)}</b></span>
                <span className="flex justify-between gap-2" title="A separate levy. Deliberately NOT inside the GST total — the figure a GST return is filed on must stay exactly the GST figure.">
                  Comp. cess <b className="font-mono text-[#2D1B0E]">{m2(bill.cessTotal)}</b>
                </span>
                <span className="flex justify-between gap-2" title="Recorded against the bill for vendor and spend reporting. It never enters unit cost on any path.">
                  Delivery <b className="font-mono text-[#2D1B0E]">{m2(r2(bill.deliveryAmount + bill.lineDelivery))}</b>
                </span>
                <span className="flex justify-between gap-2" title="Special Excise Cess + TCS + MRP round-off, summed from the per-line boxes.">
                  Other charges <b className="font-mono text-[#2D1B0E]">{m2(bill.otherCharges)}</b>
                </span>
              </div>
              <div className="flex justify-between items-baseline mt-2 pt-2 border-t border-[#E8D5C4] text-sm">
                <span className="text-[#6B5744] font-semibold">Total Inward — what you pay this vendor</span>
                <b className="font-mono text-[#af4408]">{m2(bill.totalInward)}</b>
              </div>
              <div className="text-[10px] text-[#8B7355] mt-1">
                Rates are the plain GOODS rate. GST and cess ride alongside and are never folded into what the item costs —
                fold them in and every recipe inflates by the tax rate and the input credit is forfeited.
              </div>
            </div>
          )}

          <label className="flex flex-col gap-1 text-[#6B5744]">Notes
            <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
                      placeholder="Optional context — why this is ad-hoc, who approved verbally, etc."
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
          </label>
          </>
        )}
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2 shrink-0">
          {held ? (
            <>
              <a href="/grn/qc" className="px-3 py-1.5 text-sm rounded-lg border border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408] hover:text-[#af4408] flex items-center gap-1.5">
                <ChefHat className="w-4 h-4" /> Pending Quality Checks
              </a>
              <button onClick={onCreated} className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg">Done</button>
            </>
          ) : undecided ? (
            /* The settings link is OFFERED, not required. Most receiving staff
               cannot open that page (it is admin-only) and the delivery is
               already complete, so Done is the primary and the link is the quiet
               one — an admin standing at the bay can act on it there and then. */
            <>
              <a href="/settings/qc-categories" className="px-3 py-1.5 text-sm rounded-lg border border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408] hover:text-[#af4408] flex items-center gap-1.5">
                <ShieldQuestion className="w-4 h-4" /> Quality Check Categories
              </a>
              <button onClick={onCreated} className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg">Done</button>
            </>
          ) : received ? (
            <>
              {Array.isArray(received.store_blocked) && received.store_blocked.length > 0 && (
                <a href="/inventory/liquor-store" className="px-3 py-1.5 text-sm rounded-lg border border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408] hover:text-[#af4408] flex items-center gap-1.5">
                  <Wine className="w-4 h-4" /> Liquor Store
                </a>
              )}
              <button onClick={onCreated} className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg">Done</button>
            </>
          ) : (
            <>
              <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
              <button onClick={submit}
                      disabled={busy || qcPreRejectLines.length > 0 || dupGroups.length > 0
                        || (qcPreview.known && qcPreview.required && qcPreview.backCorrection)}
                      title={dupGroups.length > 0
                        ? 'The same item is on more than one line — it would be delivered once and booked twice. Put the full quantity on one line.'
                        : qcPreRejectLines.length > 0
                        ? 'A held delivery\'s accepted quantity is the checking department\'s to record — enter what actually arrived as Received instead.'
                        : (qcPreview.known && qcPreview.required && qcPreview.backCorrection)
                          ? 'A back-correction and a held delivery cannot share one receipt — save them separately.'
                          : qcPreview.required
                            ? `This will be recorded and held for a ${CHECKER_LABEL[qcPreview.checker]} check — no stock will be added until they sign.`
                            : 'Record this vendor bill as a goods receipt'}
                      className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                <Save className="w-4 h-4" />
                {/* The button says what it is about to DO. "Save Bill" on a
                    delivery that will move no stock is the promise this whole
                    feature exists to stop making. */}
                {busy ? 'Saving…' : qcPreview.required ? 'Save bill & send for QC' : 'Save Bill'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/* EDIT BILL — amend the BILL-LEVEL fields of one GRN.          */
/*                                                              */
/* What is editable here is exactly what PUT /api/grn/[id]      */
/* accepts, and for the same reason: the bill's IDENTITY and    */
/* its paperwork, none of which moves stock or money. The       */
/* receipt date, the line items and the status are NOT here —   */
/* they are the stock movement, and changing one is a void-and- */
/* re-enter. The server refuses each of them by name if a       */
/* caller sends it anyway; this form simply never offers them,  */
/* and says why where the reader would otherwise look for them. */
/* ============================================================ */
/** The bill-level fields, in the shape the form holds them. */
interface BillForm {
  invoice_number: string; invoice_date: string;
  vendor: string; vendor_id: string;
  qc_by: string; notes: string;
  qc_quality: boolean; qc_temperature: boolean; qc_expiry: boolean;
  qc_damage: boolean; qc_weight: boolean; qc_invoice_match: boolean;
}
/* QcKey / QC_FIELDS / STORE_QC_FIELDS / KITCHEN_QC_FIELDS now live at the top of
   this file, beside the QC gate block — four render sites needed them (the
   create modal, this amend modal, the detail-panel chips and the audit trail's
   labels) and three of them sit above this point. They are deliberately NOT
   `keyof BillForm`: that would let `qc_by` (a string) into a checkbox list,
   where it renders as a box permanently ticked for any non-empty name. */
/** Seed the form from a server row. Normalised so the dirty-check below compares
 *  like with like: NULL and '' are the same absent value to a text input, and the
 *  qc_* columns are stored 1/0 but edited as checkboxes. */
const billFormFrom = (row: any): BillForm => ({
  invoice_number: String(row?.invoice_number ?? ''),
  invoice_date:   String(row?.invoice_date ?? ''),
  vendor:         String(row?.vendor ?? ''),
  vendor_id:      String(row?.vendor_id ?? ''),
  qc_by:          String(row?.qc_by ?? ''),
  notes:          String(row?.notes ?? ''),
  qc_quality:       !!Number(row?.qc_quality),
  qc_temperature:   !!Number(row?.qc_temperature),
  qc_expiry:        !!Number(row?.qc_expiry),
  qc_damage:        !!Number(row?.qc_damage),
  qc_weight:        !!Number(row?.qc_weight),
  qc_invoice_match: !!Number(row?.qc_invoice_match),
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* THE LINE EDITOR — the quantities, the rates, and removing a line.          */
/*                                                                            */
/* WHY IT IS A SECTION OF THE BILL FORM AND NOT ITS OWN SCREEN.               */
/* The owner asked for one thing — "Edit bill" — and the first delivery gave  */
/* him a form that amended only the paperwork. "Edit bill doesn't have option */
/* to edit the qty or item or price right? … I have asked to edit those       */
/* options" is the correction. So it lives inside the same modal, under the   */
/* paperwork, with its own consequence stated before the press.               */
/*                                                                            */
/* WHO. PATCH /api/grn/[id] is requireRole('admin') — a strictly higher bar   */
/* than the PUT above it (store manager / manager / admin) and the SAME bar   */
/* as the void, because it reaches as far as a void does: it unwinds stock,   */
/* deletes and rewrites cost rows and drags average_price through every       */
/* sub-recipe and recipe. A store manager legitimately opens this form today  */
/* and must KEEP the paperwork fields — so the gate is nested INSIDE the      */
/* modal rather than on it, and it fails closed on an unknown answer.         */
/*                                                                            */
/* THE THREE STATES, WHICH ARE THE WHOLE RISK OF THIS FEATURE:                */
/*   awaiting_qc (HELD) — no stock has moved. The lines are rewritten in      */
/*     place and applied for the first time at sign-off. The ACCEPTED figure  */
/*     is not offered at all: it stays 0 until the checking department signs, */
/*     and the server refuses any other value (held_accepted).                */
/*   received / partial (INWARDED) — stock and money HAVE moved. A save       */
/*     UNWINDS what this bill applied and REAPPLIES the corrected figures in  */
/*     one transaction.                                                       */
/*   void — no line editing at all; the server returns `voided`.              */
/* ══════════════════════════════════════════════════════════════════════════ */

/** SQLite REALs round-tripped through JSON never compare with `===`. This is
 *  the SAME tolerance grn-reversal.ts's optimistic lock uses (QTY_EPS), so this
 *  form and the server can never disagree about which lines actually moved. */
const LINE_EPS = 1e-6;
const nearQty = (a: number, b: number) => Math.abs(Number(a) - Number(b)) <= LINE_EPS;

/**
 * THE HEADLINE FOR A REFUSAL — a caption, never a replacement.
 *
 * Every refusal this route raises already carries a full sentence naming the
 * material, the figures and the remedy, and VoidBillModal states the house rule
 * about them: print the server's words VERBATIM, because "a branch would be a
 * second, drifting copy of it". That rule holds here and the sentence is always
 * printed below. What a caption adds is the one thing a paragraph cannot: which
 * of some forty refusals this is, readable at a glance, so an admin knows
 * immediately whether they hit a wall that clears (reload, count first, cancel
 * the return) or one that never will (voided, a PO line's removal).
 *
 * An unknown code falls back to a neutral heading — a code this map has not
 * caught up with must never suppress the sentence underneath it.
 */
const REFUSAL_TITLE: Record<string, string> = {
  // route.ts's pre-transaction validators.
  bad_number:              'That is not a number',
  duplicate_line:          'The same line was sent twice',
  empty_line_change:       'That line carries no change',
  expect_required:         'This form lost track of what it was showing',
  line_id_required:        'A line arrived without its identifier',
  material_change:         'A line’s item cannot be swapped',
  no_lines:                'No line changes were sent',
  not_found:               'This bill no longer exists',
  reason_required:         'A reason is required',
  server_error:            'The correction did not run',
  voided:                  'This bill is voided',
  would_go_negative:       'This correction would drive stock below zero',
  wrong_outlet:            'This bill belongs to another outlet',
  // The gate itself.
  unauthenticated:         'You are not signed in',
  forbidden:               'Line corrections are admin-only',
  // amendGrnLines — the refusals an admin meets in ordinary use.
  grn_changed:             'The bill changed while this form was open',
  line_changed:            'A line changed while this form was open',
  line_not_found:          'That line is no longer on this bill',
  po_line_removal:         'A purchase-order line cannot be removed',
  last_line:               'That would leave the bill with no lines at all',
  held_accepted:           'The accepted quantity is not the desk’s to set yet',
  held_negative:           'A held delivery cannot record a negative arrival',
  zero_rate:               'A rate of ₹0 cannot be recorded',
  negative_rate:           'A negative rate cannot be recorded',
  accepted_over_received:  'Accepted is more than what arrived',
  pack_factor_drift:       'The pack size has changed since this receipt',
  returned_settled:        'Part of this line has already gone back to the vendor',
  returned_open:           'An open vendor return is anchored to this line',
  return_anchor:           'A vendor return is anchored to this line',
  cutover_absorbed:        'This bill predates the central-store cutover',
  count_absorbed:          'A physical count has already absorbed this line',
  store_mapped:            'This material is tracked on the store’s own rail',
  cost_row_unexpected:     'The bill and the ledger disagree',
  cost_row_unidentifiable: 'The cost row behind this line cannot be identified',
  movement_unidentifiable: 'The stock movement behind this line cannot be identified',
  material_missing:        'The material behind a line no longer exists',
  returns_unreadable:      'The returns ledger could not be read',
  audit_write_failed:      'The audit trail could not be written',
  audit_unreadable:        'The audit trail could not be read',
  audit_unverifiable:      'The audit trail could not be verified',
  refused:                 'The correction was refused',
  // NOT a server code — this form's OWN pre-checks, which mirror the refusals
  // above so a bad box is answered on the field rather than by a 400 that
  // discards the corrections on every other line in the same request.
  local_precheck:          'Fix the flagged line(s) before saving',
};
/** Reload-and-retry is the honest answer to exactly two refusals: both mean
 *  somebody else moved this bill under the form, and both say "nothing was
 *  changed". Everything else is read, not retried. */
const RELOADABLE = new Set(['grn_changed', 'line_changed', 'line_not_found', 'expect_required']);

/** One line as this form holds it. STRINGS, so a decimal stays typeable and a
 *  CLEARED box can mean "left alone" rather than the number zero — emptying the
 *  received box must never silently record a zero-quantity receipt. */
interface LineDraft { received: string; accepted: string; price: string; remove: boolean }
const draftFromItem = (it: any): LineDraft => ({
  received: String(it?.quantity_received ?? ''),
  accepted: String(it?.quantity_accepted ?? ''),
  price:    String(it?.unit_price ?? ''),
  remove: false,
});
/** '' = untouched (send nothing at all for this field). Anything else must
 *  parse, and a box that does not is caught HERE rather than at the server's
 *  `bad_number` — one bad character would otherwise refuse the whole request,
 *  including the corrections on every other line. */
const parseBox = (s: string): { blank: boolean; ok: boolean; n: number } => {
  const t = String(s ?? '').trim();
  if (t === '') return { blank: true, ok: true, n: NaN };
  const n = Number(t);
  return { blank: false, ok: Number.isFinite(n), n };
};

/**
 * A GRN LINE CARRIES TAX TWO DIFFERENT WAYS AND THEY BEHAVE DIFFERENTLY UNDER A
 * CORRECTION — which is why the screen has to say which one this line is.
 *
 * `gst_rate`/`cess_rate` > 0 → the rupees are RE-DERIVED from the rate against
 * the corrected goods value (grn-reversal.ts deriveLineTax, the same arithmetic
 * both receiving routes use). Recoverable: correct the line back and the tax
 * comes back with it.
 *
 * `gst_rate` 0 with rupees typed in by hand — the ad-hoc form's "Manual" tax
 * option, and per the server's own note "every GRN line in this database today
 * is of the hand-typed kind" — has no rate to recompute from, so the recorded
 * rupees are RESCALED by the ratio the goods value moved by. And that is ONE
 * WAY at the bottom: take the goods value to 0 and the rupees go to ₹0 with
 * nothing left to scale back up. The server says so, but only AFTER the commit.
 * An input credit that quietly went to zero is the kind of error an auditor
 * finds, so it is said BEFORE the press as well.
 */
const lineTaxOf = (it: any) => {
  const gstRate = Number(it?.gst_rate) || 0;
  const cessRate = Number(it?.cess_rate) || 0;
  const recorded = (Number(it?.cgst) || 0) + (Number(it?.sgst) || 0) + (Number(it?.compensation_cess) || 0);
  return {
    recorded,
    byRate: gstRate > 0 || cessRate > 0,
    manual: gstRate <= 0 && cessRate <= 0 && recorded > 0,
  };
};

interface LineWork {
  changed: boolean;
  /** Has the admin ENGAGED this line at all — moved a box, typed something that
   *  will not parse, or marked it for removal?
   *
   *  The pre-checks below run on the line's NEXT values, and an untouched box
   *  falls back to the STORED one — so a line the admin never looked at, whose
   *  stored figures happen to break a rule (a ₹0 rate on accepted goods is
   *  creatable through POST /api/grn, which has no zero-rate guard), would flag
   *  itself and disable Save for the whole bill. That line is never in the
   *  payload and the server would never have objected to it. Errors are
   *  therefore reported only for lines that are actually going somewhere. */
  engaged: boolean;
  /** This form's own pre-checks, in its own words. They MIRROR the server's
   *  refusals rather than replace them — the point is an instant answer on the
   *  field being typed, not a second authority. */
  errors: string[];
  base: { qr: number; qa: number; up: number; rej: number };
  next: { qr: number; qa: number; up: number; rej: number };
  /** Purchase-unit change to the ACCEPTED figure — the only quantity that feeds
   *  current_stock and inventory_transactions. 0 on a held receipt, where
   *  nothing has moved and nothing will until sign-off. */
  acceptedDelta: number;
  /** ₹ THE PURCHASE LEDGER MOVES BY — ACCEPTED × rate.
   *
   *  This is the money figure, and it is not the document's. `purchases` (the
   *  cost row every spend report, the weighted average and the purchase log
   *  read) is written `quantity = nextAccepted, total_price = accepted × rate`
   *  and is DELETED outright when accepted reaches 0 — grn-reversal.ts's apply
   *  block. Computing the screen's ₹ on RECEIVED instead was wrong in both
   *  directions at once: correcting accepted 5 → 3 moved ₹2,400 out of the spend
   *  ledger and printed no money figure at all, while correcting a mistyped
   *  received 5 → 7 printed "bill value rises by ₹2,400" for money that never
   *  moves. */
  ledgerDelta: number;
  /** ₹ the PRINTED DOCUMENT's subtotal moves by — RECEIVED × rate, which is what
   *  /api/grn computes for `subtotal` and what /grn/print shows. Real, and a
   *  different number from the one above whenever received ≠ accepted, so it is
   *  reported as its own line rather than conflated with the ledger. */
  docDelta: number;
  /** How this correction rewrites the VENDOR-FACING rejected quantity and the
   *  sentence beside it, or null when it leaves both alone. grn-reversal.ts
   *  mints `quantity_rejected = received − accepted` and stamps
   *  `rejection_reason = "Recorded by bill amendment: <your reason>"` over the
   *  checker's own words — and /grn/print/[id] and /receiving-variance both read
   *  them. An admin correcting a mistyped received quantity is publishing a
   *  rejection the vendor is answerable to; they have to be told. */
  rejection: null | { qty: number; wasQty: number; wasReason: string; minted: boolean; reasonReplaced: boolean; cleared: boolean };
  /** What happens to this line's recorded CGST/SGST/cess. See lineTaxOf. */
  tax: null | { mode: 'rate' | 'rescaled' | 'zeroed' | 'removed'; recorded: number };
  /** The wire line, or null when this line is untouched. Untouched lines are
   *  NEVER sent: the server refuses a line carrying no change
   *  (`empty_line_change`) and it is right to — a caller that believes it
   *  changed something is worse off than one that got a 400. */
  send: any | null;
}

/**
 * WHAT THIS DRAFT WOULD SEND, WHAT IT WOULD MOVE, AND WHAT IS WRONG WITH IT —
 * one derivation, used by the row that renders it AND by the payload builder, so
 * the effect an admin is shown and the effect that is sent can never drift.
 */
function deriveLine(it: any, d: LineDraft, held: boolean): LineWork {
  const base = {
    qr: Number(it?.quantity_received) || 0,
    qa: Number(it?.quantity_accepted) || 0,
    up: Number(it?.unit_price) || 0,
    rej: Number(it?.quantity_rejected) || 0,
  };
  const wasReason = String(it?.rejection_reason || '').trim();
  const t = lineTaxOf(it);
  // THE OPTIMISTIC LOCK, and it is MANDATORY per line: the three values this
  // form was showing, re-asserted under the server's write lock. Without them a
  // double submit or a replayed request would apply the same correction twice.
  const expect = { quantity_received: base.qr, quantity_accepted: base.qa, unit_price: base.up };
  const errors: string[] = [];

  if (d.remove) {
    return {
      changed: true, engaged: true, errors, base,
      next: { qr: 0, qa: 0, up: base.up, rej: 0 },
      // A removal takes back everything this line had accepted. On a held
      // receipt nothing was ever credited, so it takes back nothing.
      acceptedDelta: held ? 0 : -base.qa,
      // The cost row goes with the line; the document loses its whole subtotal.
      ledgerDelta: held ? 0 : -(base.qa * base.up),
      docDelta: -(base.qr * base.up),
      // A rejected quantity recorded on this line leaves the receiving-variance
      // register with it — the vendor stops being answerable for it, silently.
      rejection: base.rej > LINE_EPS
        ? { qty: 0, wasQty: base.rej, wasReason, minted: false, reasonReplaced: false, cleared: true }
        : null,
      tax: t.recorded > 0 ? { mode: 'removed', recorded: t.recorded } : null,
      send: { id: String(it?.id ?? ''), remove: true, expect },
    };
  }

  const R = parseBox(d.received), A = parseBox(d.accepted), P = parseBox(d.price);
  if (!R.ok) errors.push('the received quantity is not a number');
  if (!held && !A.ok) errors.push('the accepted quantity is not a number');
  if (!P.ok) errors.push('the rate is not a number');

  const nextQr = R.blank || !R.ok ? base.qr : R.n;
  const nextQa = held ? base.qa : (A.blank || !A.ok ? base.qa : A.n);
  const nextUp = P.blank || !P.ok ? base.up : P.n;

  const send: any = { id: String(it?.id ?? ''), expect };
  let changed = false;
  if (R.ok && !R.blank && !nearQty(R.n, base.qr)) { send.quantity_received = R.n; changed = true; }
  // NEVER ON A HELD RECEIPT. The accepted figure is the checking department's to
  // record at sign-off and the server refuses any non-zero value from here
  // (held_accepted). The field is not rendered either — this is the second half
  // of the same rule, so a draft left over from before a sign-off can never leak
  // one into the payload.
  if (!held && A.ok && !A.blank && !nearQty(A.n, base.qa)) { send.quantity_accepted = A.n; changed = true; }
  if (P.ok && !P.blank && !nearQty(P.n, base.up)) { send.unit_price = P.n; changed = true; }

  // ── THE PRE-CHECKS, EACH MIRRORING ONE SERVER REFUSAL ───────────────────
  if (nextUp < 0) errors.push('a negative rate cannot be recorded — it would cascade a nonsense cost into every recipe using this material');
  if (held) {
    if (nextQr < 0) errors.push('a held delivery records what ARRIVED, so its received quantity cannot be negative');
    // ₹0 is refused on a held line too: the sign-off replays this stored row, so
    // the zero rate becomes a ₹0 cost row and a wiped average_price then.
    if (nextQr > LINE_EPS && nextUp <= 0) errors.push('a rate of ₹0 would wipe this material’s weighted average when the delivery is signed off');
  } else {
    // Accepted vs received, in BOTH directions — the same invariant the server
    // states: accepted may never exceed what arrived, and on a back-correction
    // (a negative receipt) the two figures move in lockstep.
    const over = nextQr >= 0
      ? (nextQa > nextQr + LINE_EPS || nextQa < -LINE_EPS)
      : (nextQa > LINE_EPS || nextQa < nextQr - LINE_EPS);
    if (over) {
      errors.push(nextQr >= 0
        ? `accepted (${fmtQtyNum(nextQa)}) must be between 0 and what arrived (${fmtQtyNum(nextQr)})`
        : `this line records a back-correction of ${fmtQtyNum(nextQr)}, so its accepted quantity must be between ${fmtQtyNum(nextQr)} and 0`);
    }
    if (nextQa > LINE_EPS && nextUp <= 0) errors.push('a rate of ₹0 cannot be recorded against accepted goods — it wipes this material’s weighted average and cascades a free ingredient through every recipe');
  }

  // ── WHAT ELSE THIS CORRECTION REWRITES, mirrored from the server's apply
  //    block so it can be said BEFORE the press rather than discovered after.

  // THE VENDOR-FACING REJECTION. grn-reversal.ts:
  //   nextRejected = (received < 0 || accepted < 0) ? 0 : max(0, received − accepted)
  // and on a HELD line it writes quantity_rejected = 0, rejection_reason = ''
  // unconditionally (the checker has not been near it yet).
  const nextRej = held ? 0 : ((nextQr < 0 || nextQa < 0) ? 0 : Math.max(0, nextQr - nextQa));
  // The server keeps the checker's own sentence ONLY when the rejected quantity
  // is unchanged AND a sentence already exists; otherwise the amendment reason
  // is stamped over it, on a document the vendor answers to.
  const rejKept = nextRej > LINE_EPS && !!wasReason && nearQty(nextRej, base.rej);
  // The reason moves on its own account too: stamped over when the quantity no
  // longer matches the sentence, and BLANKED whenever nothing is left rejected
  // — including on a held line, where the server clears both unconditionally.
  const rejReasonMoves = (nextRej > LINE_EPS && !rejKept) || (nextRej <= LINE_EPS && !!wasReason);
  const rejection = (!nearQty(nextRej, base.rej) || rejReasonMoves)
    ? {
        qty: nextRej, wasQty: base.rej, wasReason,
        minted: nextRej > LINE_EPS && base.rej <= LINE_EPS,
        reasonReplaced: nextRej > LINE_EPS && !rejKept,
        cleared: nextRej <= LINE_EPS && (base.rej > LINE_EPS || !!wasReason),
      }
    : null;

  // THE TAX. It follows the goods, and it only moves when the goods value does:
  // deriveLineTax is fed the ACCEPTED figure on an inwarded line and the
  // RECEIVED figure on a held one (the checker has set no accepted figure yet).
  const taxQtyNow = held ? base.qr : base.qa;
  const taxQtyNext = held ? nextQr : nextQa;
  const taxMoves = !nearQty(taxQtyNext, taxQtyNow) || !nearQty(nextUp, base.up);
  let tax: LineWork['tax'] = null;
  if (taxMoves && t.byRate) {
    tax = { mode: 'rate', recorded: t.recorded };
  } else if (taxMoves && t.manual) {
    // The server's own fallback ladder: scale by the accepted base, or by the
    // received base when nothing was ever accepted, and only when THAT is zero
    // too are the typed rupees left verbatim (nothing to scale by, so no claim).
    const oldBase = (taxQtyNow > 0 ? taxQtyNow * base.up : 0) || (base.qr > 0 ? base.qr * base.up : 0);
    const newBase = taxQtyNext > 0 ? taxQtyNext * nextUp : 0;
    if (oldBase > 0) tax = { mode: newBase > 0 ? 'rescaled' : 'zeroed', recorded: t.recorded };
  }

  // A line the admin has not engaged carries no complaint — see LineWork.engaged.
  const engaged = changed
    || (!R.blank && !R.ok)
    || (!held && !A.blank && !A.ok)
    || (!P.blank && !P.ok);

  return {
    changed, engaged, errors: engaged ? errors : [], base,
    next: { qr: nextQr, qa: nextQa, up: nextUp, rej: nextRej },
    acceptedDelta: held ? 0 : nextQa - base.qa,
    // ACCEPTED × rate — the cost row. Zero on a held receipt: nothing is booked
    // until the checking department signs, and these figures are what it books.
    ledgerDelta: held ? 0 : (nextQa * nextUp) - (base.qa * base.up),
    docDelta: (nextQr * nextUp) - (base.qr * base.up),
    rejection: changed ? rejection : null,
    tax: changed ? tax : null,
    send: changed ? send : null,
  };
}

/** The pack rule for one bill line, read off the row the server already sends
 *  (rm.pack_size / rm.unit / rm.purchase_unit ride on every GRN item). */
const lineUnitsOf = (it: any) => {
  const factor = packFactor({ pack_size: it?.pack_size, unit: it?.material_unit, purchase_unit: it?.purchase_unit } as any);
  return {
    factor,
    pu: String(it?.purchase_unit || it?.material_unit || ''),
    ru: String(it?.material_unit || ''),
  };
};

/**
 * ONE LINE OF THE BILL, EDITABLE.
 *
 * PURCHASE UNITS LEAD, as everywhere else on this page: goods_receipt_note_items
 * stores quantities and unit_price in the PURCHASE basis already (that is what
 * the detail table above prints under "Purchase Unit" and "Rate"), so the boxes
 * are the admin's own basis with no conversion — and the recipe figure rides
 * underneath as a declared hint, because that is the number current_stock
 * actually moves by.
 *
 * THE ORIGINAL SITS BESIDE EVERY BOX. This is a CORRECTION, and the previous
 * figure is the thing being corrected: an admin who cannot see what a line said
 * before cannot tell whether they are fixing it or re-typing it.
 */
function LineDraftRow({ it, draft, work, held, removeBlocked, onChange }: {
  it: any; draft: LineDraft; work: LineWork; held: boolean;
  /** Why Remove is not offered on this line, or null when it is. */
  removeBlocked: string | null;
  onChange: (p: Partial<LineDraft>) => void;
}) {
  const { factor, pu, ru } = lineUnitsOf(it);
  const box = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] font-mono text-right disabled:bg-[#F3EEE7] disabled:text-[#B8A590]';
  /** A wheel over a FOCUSED `type="number"` field nudges its value. These three
   *  boxes decide a stock movement and a cost row, and the panel they sit in
   *  scrolls — so a scroll aimed at the page silently re-typed a quantity.
   *  Blurring first turns the gesture back into a scroll. */
  const noWheel = (e: ReactWheelEvent<HTMLInputElement>) => e.currentTarget.blur();
  const hint = (v: number) => (factor > 1
    ? <div className="text-[9px] text-[#B8A590]">= {fmtQtyNum(v * factor)} {ru}</div>
    : null);
  /** "was 4 kg", plus the recipe hint under it. Muted while the box still
   *  agrees with it; amber the moment it does not. */
  const wasNote = (orig: number, moved: boolean) => (
    <div className={`text-[10px] ${moved ? 'text-amber-700' : 'text-[#B8A590]'}`}>
      was {fmtQtyNum(orig)} {pu}
      {factor > 1 && <span className="text-[#B8A590]"> (= {fmtQtyNum(orig * factor)} {ru})</span>}
    </div>
  );
  const removed = draft.remove;

  return (
    <div className={`border rounded-lg p-2.5 ${removed ? 'border-red-200 bg-red-50/50' : work.changed ? 'border-[#af4408] bg-[#FFF1E3]/50' : 'border-[#E8D5C4] bg-white'}`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className={`font-semibold text-[#2D1B0E] text-[11px] ${removed ? 'line-through' : ''}`}>{it.material_name}</div>
          <div className="text-[10px] text-[#8B7355]">
            {it.material_category || 'Uncategorised'} · priced per {pu || 'unit'}
            {it.po_item_id ? ' · on the purchase order' : ''}
          </div>
          {/* WHAT IS ALREADY RECORDED AGAINST THE VENDOR ON THIS LINE. It has
              no box because it is not typed — the server derives it as
              received − accepted — but a correction REWRITES it and stamps the
              amendment reason over the checker's own words, and an admin who
              cannot see it cannot see what they are about to overwrite. */}
          {(Number(it.quantity_rejected) || 0) > LINE_EPS && (
            <div className="text-[10px] text-[#8B7355]">
              Recorded as rejected: <b className="text-[#6B5744]">{fmtQtyNum(Number(it.quantity_rejected) || 0)} {pu}</b>
              {String(it.rejection_reason || '').trim()
                ? <> — “{String(it.rejection_reason).trim()}”</>
                : <> — no reason recorded</>}
              <span className="text-[#B8A590]"> (on the vendor’s receiving-variance report)</span>
            </div>
          )}
        </div>
        {removeBlocked ? (
          <span title={removeBlocked}
                className="shrink-0 px-2 py-1 rounded border border-[#E8D5C4] bg-[#F3EEE7] text-[#B8A590] text-[10px] flex items-center gap-1 cursor-not-allowed">
            <Trash2 className="w-3 h-3" /> Remove
          </span>
        ) : removed ? (
          <button type="button" onClick={() => onChange({ remove: false })}
                  title="Keep this line on the bill after all"
                  className="shrink-0 px-2 py-1 rounded border border-[#E8D5C4] bg-white text-[#6B5744] text-[10px] flex items-center gap-1 hover:text-[#af4408] hover:border-[#af4408]">
            <X className="w-3 h-3" /> Undo removal
          </button>
        ) : (
          <button type="button" onClick={() => onChange({ remove: true })}
                  title="Take this line off the bill entirely"
                  className="shrink-0 px-2 py-1 rounded border border-red-200 bg-white text-red-600 text-[10px] flex items-center gap-1 hover:bg-red-50">
            <Trash2 className="w-3 h-3" /> Remove
          </button>
        )}
      </div>

      {/* Literal class names on BOTH branches — Tailwind scans source text, so
          an interpolated `sm:grid-cols-${n}` compiles to nothing at all. */}
      <div className={`grid grid-cols-1 gap-2 ${held ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
        <label className="flex flex-col gap-1 text-[10px] text-[#6B5744]">
          Received ({pu || 'unit'})
          <input type="number" inputMode="decimal" step="any" value={draft.received} disabled={removed}
                 onChange={e => onChange({ received: e.target.value })} onWheel={noWheel} className={box} />
          {wasNote(work.base.qr, !nearQty(work.next.qr, work.base.qr))}
          {!removed && hint(work.next.qr)}
        </label>

        {/* HELD RECEIPTS HAVE NO ACCEPTED BOX. It is not the receiving desk's
            figure until the checking department signs, and the server refuses
            any non-zero value from here — a field that 400s every time is worse
            than no field. Said in words, not hidden silently. */}
        {/* The quick-set sits BESIDE the field, not inside its <label> — a
            button nested in a label competes with the label for the click. It
            is the server's own named alternative to removing a PO line, so it
            has to be one press, not a typed zero. */}
        {!held && (
          <div className="flex flex-col gap-1 text-[10px] text-[#6B5744]">
            <label className="flex flex-col gap-1">
              Accepted ({pu || 'unit'})
              <input type="number" inputMode="decimal" step="any" value={draft.accepted} disabled={removed}
                     onChange={e => onChange({ accepted: e.target.value })} onWheel={noWheel} className={box} />
            </label>
            {wasNote(work.base.qa, !nearQty(work.next.qa, work.base.qa))}
            {!removed && hint(work.next.qa)}
            {!removed && (
              <button type="button" onClick={() => onChange({ accepted: '0' })}
                      title={"Reject the whole line: reverses its stock and DELETES its cost row, while the line stays on the bill — and, on a PO receipt, keeps the order's line claimed."
                             + " It also records the whole received quantity as rejected against the vendor, and takes this line's tax down with the value"
                             + " — to ₹0 and un-recoverably, if that tax was typed in rupees rather than as a rate."}
                      className="self-start text-[10px] text-[#8B7355] underline hover:text-[#af4408]">
                set to 0
              </button>
            )}
          </div>
        )}

        <label className="flex flex-col gap-1 text-[10px] text-[#6B5744]">
          Rate (₹ per {pu || 'unit'})
          <input type="number" inputMode="decimal" step="any" value={draft.price} disabled={removed}
                 onChange={e => onChange({ price: e.target.value })} onWheel={noWheel} className={box} />
          <div className={`text-[10px] ${!nearQty(work.next.up, work.base.up) ? 'text-amber-700' : 'text-[#B8A590]'}`}>
            was {m2(work.base.up)} per {pu || 'unit'}
          </div>
        </label>
      </div>

      {/* Blank means UNTOUCHED, and that has to be said where it is typed —
          an empty box that quietly means "keep 4" is the shape a correction
          silently fails in. */}
      {!removed && (draft.received.trim() === '' || draft.price.trim() === '' || (!held && draft.accepted.trim() === '')) && (
        <div className="mt-1.5 text-[10px] text-[#8B7355]">
          A blank box is left exactly as it is — clearing one does not record a zero.
        </div>
      )}

      {work.errors.length > 0 && (
        <div className="mt-1.5 text-[10px] text-red-700 space-y-0.5">
          {work.errors.map((e, i) => (
            <div key={i} className="flex items-start gap-1"><AlertTriangle className="w-3 h-3 shrink-0 mt-px" /><span>{it.material_name}: {e}.</span></div>
          ))}
        </div>
      )}

      {/* THE NET EFFECT OF THIS LINE, before the press — and it is FOUR
          effects, not one. A correction moves stock, it moves the cost row, it
          rewrites the vendor-facing rejected quantity, and it re-derives or
          rescales the tax. Naming only the first was how a ₹0 input credit and
          a minted vendor rejection both shipped unannounced. */}
      {work.changed && work.errors.length === 0 && (
        <div className="mt-1.5 text-[10px] text-[#6B5744] border-t border-[#E8D5C4] pt-1.5 space-y-0.5">
          <div>
            {removed
              ? <>This line comes off the bill. </>
              : <>Corrected to {fmtQtyNum(work.next.qr)} {pu} received{!held && <> · {fmtQtyNum(work.next.qa)} {pu} accepted</>} · {m2(work.next.up)} per {pu}. </>}
            {held ? (
              <span className="text-[#8B7355]">Nothing has entered stock yet, so nothing moves — these figures are applied at sign-off.</span>
            ) : Math.abs(work.acceptedDelta) > LINE_EPS ? (
              <span className={work.acceptedDelta < 0 ? 'text-red-700' : 'text-emerald-700'}>
                Central stock {work.acceptedDelta < 0 ? 'falls by' : 'rises by'} {fmtQtyNum(Math.abs(work.acceptedDelta))} {pu}
                {factor > 1 && <span className="text-[#B8A590]"> (= {fmtQtyNum(Math.abs(work.acceptedDelta) * factor)} {ru})</span>}.
              </span>
            ) : (
              <span className="text-[#8B7355]">
                {removed
                  ? 'No stock moves — this line had nothing accepted, so it never added any.'
                  : 'No stock moves — the accepted quantity is unchanged.'}
              </span>
            )}
          </div>

          {/* THE MONEY, ON THE BASIS THE LEDGER IS ACTUALLY ON. The cost row is
              ACCEPTED × rate; the printed document's subtotal is RECEIVED ×
              rate. They are different numbers the moment the two quantities
              differ, so they are two sentences, never one. */}
          <div>
            {held ? (
              <span className="text-[#8B7355]">
                No cost row exists yet — {m2(Math.abs(work.next.qr * work.next.up))} is what this line will book when the check is signed.
              </span>
            ) : Math.abs(work.ledgerDelta) > 0.005 ? (
              <span>
                Purchase cost recorded for this line{' '}
                <b className={work.ledgerDelta < 0 ? 'text-red-700' : 'text-emerald-700'}>
                  {work.ledgerDelta < 0 ? 'falls' : 'rises'} by {m2(Math.abs(work.ledgerDelta))}
                </b>{' '}
                <span className="text-[#8B7355]">(accepted × rate — before the vendor’s discount and the recorded charges)</span>.
              </span>
            ) : (
              <span className="text-[#8B7355]">No purchase cost moves — the accepted quantity and the rate together come to the same figure.</span>
            )}
            {/* The document's own subtotal, and ONLY where it is a different
                answer from the ledger's — including the common case where it is
                a different answer by being unchanged. "Rises by ₹0.00" is not a
                sentence anyone should have to read. */}
            {Math.abs(work.docDelta - (held ? 0 : work.ledgerDelta)) > 0.005 && (
              Math.abs(work.docDelta) > 0.005 ? (
                <span className="text-[#8B7355]">
                  {' '}The printed bill’s subtotal (received × rate) {work.docDelta < 0 ? 'falls' : 'rises'} by {m2(Math.abs(work.docDelta))}
                  {!held && ' — a different figure, because the ledger follows what was ACCEPTED, not what arrived'}.
                </span>
              ) : (
                <span className="text-[#8B7355]">
                  {' '}The printed bill’s subtotal is unchanged — what ARRIVED did not move, only what was accepted.
                </span>
              )
            )}
          </div>

          {/* THE VENDOR-FACING REJECTION, which nothing on this screen used to
              mention even while the correction was minting one. */}
          {work.rejection && (
            <div className="text-amber-800">
              {work.rejection.cleared ? (
                <>The <b>{fmtQtyNum(work.rejection.wasQty)} {pu} recorded as rejected</b>
                  {work.rejection.wasReason ? <> (“{work.rejection.wasReason}”)</> : null}
                  {removed
                    ? <> leaves the receiving-variance register with this line — the vendor is no longer answerable for it.</>
                    : <> is cleared: nothing on this line is rejected any more, and its reason is removed from the vendor’s receiving-variance report.</>}
                </>
              ) : (
                <>
                  This records <b>{fmtQtyNum(work.rejection.qty)} {pu} as rejected</b> against the vendor
                  {work.rejection.minted ? ' (nothing was rejected on this line before)' : <> (was {fmtQtyNum(work.rejection.wasQty)} {pu})</>}
                  {work.rejection.reasonReplaced && (
                    <> — and <b>your reason below becomes the rejection reason</b> printed on this bill and grouped on the receiving-variance report
                      {work.rejection.wasReason ? <>, replacing “{work.rejection.wasReason}”</> : null}.</>
                  )}
                  {!work.rejection.reasonReplaced && '.'}
                </>
              )}
            </div>
          )}

          {/* THE TAX. Named before the press because one of its outcomes cannot
              be undone by correcting the line back. */}
          {work.tax && (
            <div className={work.tax.mode === 'zeroed' ? 'text-red-700' : 'text-[#8B7355]'}>
              {work.tax.mode === 'rate' && <>The line’s tax ({m2(work.tax.recorded)} recorded) is re-derived from its GST/cess rate against the corrected value.</>}
              {work.tax.mode === 'rescaled' && <>The line’s tax was typed in rupees, not as a rate, so the {m2(work.tax.recorded)} recorded is <b>rescaled in proportion</b> to the goods value — check it against the vendor’s bill before claiming the credit.</>}
              {work.tax.mode === 'zeroed' && <><b>The {m2(work.tax.recorded)} of tax typed on this line goes to ₹0</b>, and re-booking the line later cannot bring it back — there is no rate to recompute from. Re-record the receipt if that input credit is still claimable.</>}
              {work.tax.mode === 'removed' && <>The {m2(work.tax.recorded)} of tax recorded on this line leaves the bill with it.</>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * WHAT THE CORRECTION ACTUALLY DID — the phase after the commit.
 *
 * Modelled on the void's result phase, and for the same reason: past the commit
 * the server can only TELL, and two of the things it tells matter enough that an
 * admin must read them rather than have them flashed away by a reload —
 *   · a material with no purchases left keeps this bill's price in its weighted
 *     average, and nothing anywhere stores the pre-receipt figure to restore;
 *   · valuations already taken at the old average are historical and were not
 *     rewritten, so a closing-stock or variance figure from last week still
 *     reflects the pre-correction cost.
 * Nothing here may present as a failure: the correction is recorded.
 */
function LineResultPanel({ result, items, warnings, metaSaved, onDone }: {
  result: any; items: any[]; warnings: string[]; metaSaved: boolean; onDone: () => void;
}) {
  const changes: any[] = Array.isArray(result?.changes) ? result.changes : [];
  const stale: any[] = Array.isArray(result?.average_price_stale) ? result.average_price_stale : [];
  /** THE OTHER PRICE FIELD, AND IT HAD NO SURFACE AT ALL. amendGrnLines fills
   *  `last_purchase_stale` whenever a line is removed or zeroed and no purchase
   *  row survives to re-derive last_purchase_price from — so the column still
   *  carries the rate of the bill just corrected away. It is not the weighted
   *  average: it is the field that seeds the next PO's rate and is read on the
   *  requisition and unit-audit screens. The route's own `notice` names
   *  last_purchase_kept and average_price_stale and never this one, so if this
   *  panel does not say it, nothing does. */
  const lppStale: any[] = Array.isArray(result?.last_purchase_stale) ? result.last_purchase_stale : [];
  const held = String(result?.state) === 'held';
  const unitsFor = (materialId: string) =>
    lineUnitsOf(items.find((x: any) => String(x.material_id) === String(materialId)) || {});

  return (
    <div className="space-y-3">
      <div className={`rounded-lg border p-3 ${held ? 'border-blue-200 bg-blue-50/50 text-blue-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>
        <div className="font-semibold flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4" /> Correction applied to {result?.grn_number || 'this bill'}
        </div>
        <div className="mt-1 text-[11px]">
          {held
            ? 'This receipt is still waiting for its quality check, so it had never moved stock — only the bill lines were corrected. The corrected quantities and rates will be applied when the checking department signs it off.'
            : 'The stock, the cost rows and the stock movements were corrected together in one transaction.'}
        </div>
        {metaSaved && <div className="mt-1 text-[11px]">The bill's paperwork was saved too.</div>}
      </div>

      {changes.length > 0 && (
        <div className="border border-[#E8D5C4] rounded-lg overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead className="bg-[#FFF1E3] text-[#6B5744]">
              <tr>
                <th className="text-left  py-1.5 px-2 font-medium">Material</th>
                <th className="text-left  py-1.5 px-2 font-medium">What happened</th>
                <th className="text-right py-1.5 px-2 font-medium">Received</th>
                <th className="text-right py-1.5 px-2 font-medium">Accepted</th>
                <th className="text-right py-1.5 px-2 font-medium">Rate</th>
                <th className="text-right py-1.5 px-2 font-medium">Stock moved</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c: any, i: number) => {
                const { factor, pu, ru } = unitsFor(c.material_id);
                const deltaRecipe = Number(c.stock_delta_recipe) || 0;
                const deltaPu = factor > 0 ? deltaRecipe / factor : deltaRecipe;
                const pair = (before: any, after: any, money?: boolean) => (
                  <td className="py-1.5 px-2 text-right font-mono text-[#2D1B0E]">
                    {money ? m2(before) : <>{fmtQtyNum(Number(before) || 0)} {pu}</>}
                    <div className="text-[10px] text-[#af4408]">
                      → {c.after ? (money ? m2(after) : <>{fmtQtyNum(Number(after) || 0)} {pu}</>) : '—'}
                    </div>
                  </td>
                );
                return (
                  <tr key={i} className="border-t border-[#E8D5C4]/60">
                    <td className="py-1.5 px-2 text-[#2D1B0E]">{c.material_name}</td>
                    <td className="py-1.5 px-2 text-[#6B5744]">
                      {c.action === 'removed' ? 'Line removed' : 'Line corrected'}
                      {c.cost_row && c.cost_row !== 'none' && <div className="text-[10px] text-[#8B7355]">cost row {c.cost_row}</div>}
                    </td>
                    {pair(c.before?.quantity_received, c.after?.quantity_received)}
                    {pair(c.before?.quantity_accepted, c.after?.quantity_accepted)}
                    {pair(c.before?.unit_price, c.after?.unit_price, true)}
                    <td className={`py-1.5 px-2 text-right font-mono ${Math.abs(deltaRecipe) < 1e-9 ? 'text-[#B8A590]' : deltaRecipe < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                      {Math.abs(deltaRecipe) < 1e-9 ? '—' : <>
                        {deltaRecipe < 0 ? '−' : '+'}{fmtQtyNum(Math.abs(deltaPu))} {pu}
                        {factor > 1 && <div className="text-[9px] font-normal text-[#B8A590]">= {fmtQtyNum(Math.abs(deltaRecipe))} {ru}</div>}
                      </>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {stale.length > 0 && (
        <div className="text-amber-900 bg-amber-50 border border-amber-300 rounded p-2 text-[11px]">
          <div className="font-semibold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> A weighted average still carries this bill's price</div>
          <div className="mt-1">
            <b>{stale.map((s: any) => s.material_name).join(', ')}</b> {stale.length === 1 ? 'has' : 'have'} no purchase rows left after this correction,
            so the average price could not be re-derived and still carries the figure this bill set. Nothing stores the pre-receipt average —
            correct it by hand, or let the next real purchase of the material set it.
          </div>
        </div>
      )}

      {lppStale.length > 0 && (
        <div className="text-amber-900 bg-amber-50 border border-amber-300 rounded p-2 text-[11px]">
          <div className="font-semibold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> A last-purchase rate still points at the corrected-away line</div>
          <div className="mt-1">
            <b>{lppStale.map((s: any) => s.material_name).join(', ')}</b> {lppStale.length === 1 ? 'has' : 'have'} no purchase row left to re-derive
            a last-purchase rate from, so <b>last purchase price</b> still carries the rate this bill recorded. That field seeds the next purchase
            order's rate and is read on the requisition and unit-audit screens — set it from the material master, or let the next real purchase set it.
          </div>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="text-amber-900 bg-amber-50 border border-amber-300 rounded p-2 space-y-1 text-[11px]">
          <div className="font-semibold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> Applied, with a caveat</div>
          {warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}

      {result?.notice && (
        <div className="text-[10px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">{result.notice}</div>
      )}

      <div className="flex justify-end pt-1">
        <button onClick={onDone}
                className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg">
          Done
        </button>
      </div>
    </div>
  );
}

function EditBillModal({ g, isAdmin, onClose, onSaved }: {
  g: GRN;
  /** From the list payload, three-state and advisory. See canEditLines below. */
  isAdmin: boolean | null;
  onClose: () => void; onSaved: () => void;
}) {
  const isPoGrn = !!g.po_id;
  /** The bill AS THE SERVER HAS IT, re-read when this modal opens rather than
   *  taken from the list row. Two reasons: the list row is a snapshot that may
   *  be minutes old, and it does not carry the six qc_* ticks at all. It is also
   *  the baseline the dirty-check below diffs against — see submit(). */
  const [loaded, setLoaded] = useState<BillForm | null>(null);
  const [form, setForm] = useState<BillForm | null>(null);
  /** The raw server row behind `form`, kept for the fields that are NOT
   *  editable but decide what this form may offer: qc_required (was this
   *  receipt gated?), qc_checker, and the two signature stamps. */
  const [row, setRow] = useState<any>(null);
  const [loadErr, setLoadErr] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  /** The refusal's machine-readable code and its payload, held ALONGSIDE the
   *  sentence rather than instead of it. They decide two things only: the
   *  caption above the sentence, and whether an ACTION is offered (reload the
   *  bill; the per-material figures behind would_go_negative). */
  const [errCode, setErrCode] = useState('');
  const [errPayload, setErrPayload] = useState<any>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [vendors, setVendors] = useState<any[]>([]);
  /** Is the CALLER an admin, as the request that produced these lines answered
   *  it? Second half of the line-edit gate — see canEditLines. */
  const [detailIsAdmin, setDetailIsAdmin] = useState<boolean | null>(null);
  /** Per-line drafts, keyed by goods_receipt_note_items.id. A line with no entry
   *  here has not been touched: the row seeds itself from the server figures on
   *  render, so a reload wipes every draft by clearing this one object. */
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({});
  /** Bumped by "Reload the bill" — re-reads the header, the lines and the
   *  baseline the optimistic lock is built from. */
  const [reloadTick, setReloadTick] = useState(0);
  /** The committed result of a line correction. Its own phase, like the void's:
   *  the server comes back saying which materials moved, which weighted averages
   *  it could NOT re-derive and what was not rewritten, and that has to be read
   *  rather than flashed away by a reload. */
  const [lineResult, setLineResult] = useState<any>(null);
  /** True once the PAPERWORK half has committed in this submit. It is what makes
   *  a refusal of the line half honest: "the details were saved, the quantities
   *  were not" is a different sentence from "nothing was saved". */
  const [metaSaved, setMetaSaved] = useState(false);
  /** THE ONE THING THIS FORM CANNOT KNOW. A refusal carries a code and a
   *  sentence, so "nothing was changed" is a fact the server stated. A THROWN
   *  request — a dropped connection, a suspended tab, a proxy timeout on the
   *  slow post-commit recipe cascade — is not: the PATCH may have reached the
   *  server and committed. Asserting non-execution there is the one over-claim
   *  this feature's own doctrine forbids, so the uncertainty is carried and
   *  said out loud instead. */
  const [patchUncertain, setPatchUncertain] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/grn?id=${encodeURIComponent(g.id)}`)
      .then(r => r.json())
      .then(d => {
        if (!alive) return;
        if (!d?.grn) { setLoadErr(d?.error || 'Could not load this bill.'); return; }
        const f = billFormFrom(d.grn);
        setRow(d.grn);
        setLoaded(f); setForm(f);
        // Fails closed on anything but a literal true, exactly like the page's
        // own isAdmin and the Delete control.
        setDetailIsAdmin(d.is_admin === true);
        // Every draft is dropped on a re-read: they are keyed to figures that
        // have just been replaced, and re-offering them would let an admin
        // re-send a correction against a baseline that no longer exists.
        setDrafts({});
      })
      .catch(e => { if (alive) setLoadErr(e?.message || 'Could not load this bill.'); });
    return () => { alive = false; };
  }, [g.id, reloadTick]);

  /** Re-read the bill. The honest answer to the two concurrency refusals, and it
   *  DISCARDS unsaved edits on purpose — those refusals both say "nothing was
   *  changed", so what is on screen is a correction against a baseline that has
   *  moved, and re-sending it is the one thing that must not happen. */
  const reloadBill = () => {
    setErr(''); setErrCode(''); setErrPayload(null); setWarnings([]);
    // `metaSaved` is scoped to ONE submit. Left standing across a reload, a
    // refusal on a later save still read "the paperwork was saved before this
    // refusal" — a true fact in the wrong tense, about a save two attempts ago.
    setMetaSaved(false); setPatchUncertain(false);
    setReloadTick(t => t + 1);
  };

  // Only an ad-hoc GRN's vendor is editable, so only it needs the picker.
  useEffect(() => {
    if (isPoGrn) return;
    fetch('/api/vendors').then(r => r.json())
      .then(d => setVendors((d.vendors || []).filter((v: any) => v.is_active)))
      .catch(() => { /* free-typing still works — the field allows a custom name */ });
  }, [isPoGrn]);

  const set = (patch: Partial<BillForm>) => setForm(f => (f ? { ...f, ...patch } : f));

  /**
   * ONLY THE FIELDS THE USER ACTUALLY MOVED are sent.
   *
   * PUT /api/grn/[id] keys off `hasOwnProperty`, so an omitted field is left
   * exactly as it is in the database. Sending the whole form instead would make
   * this a last-write-wins save: a colleague's correction to a field this user
   * never looked at, landing while the modal was open, would be silently
   * reverted by the stale value seeded when it opened.
   *
   * VENDOR IS THE ONE PAIR THAT MOVES TOGETHER. `vendor` (the printed name) and
   * `vendor_id` (the linked master record) are two halves of one answer, and the
   * server fills whichever half is missing from the row as it stands. Send only
   * the name after switching from a linked vendor to a free-typed one and the
   * old vendor_id survives — the bill would then read as one vendor and point at
   * another. So if either half moved, both are sent.
   */
  const patch = useMemo(() => {
    if (!form || !loaded) return null;
    const p: Record<string, any> = {};
    // BELT AND BRACES on the three kitchen ticks. The boxes above are already
    // disabled on a gated receipt so they cannot move, and the server refuses
    // them anyway with a 400 — but a patch that carried one would turn a
    // legitimate save of the OTHER fields into a whole-request refusal, and the
    // user would have no idea which control did it.
    const kitchenLocked = Number(row?.qc_required) === 1;
    (Object.keys(form) as (keyof BillForm)[]).forEach(k => {
      if (k === 'vendor' || k === 'vendor_id') return;
      if (kitchenLocked && KITCHEN_QC_FIELDS.some(f => f.k === k)) return;
      if (form[k] !== loaded[k]) p[k] = form[k];
    });
    if (!isPoGrn && (form.vendor !== loaded.vendor || form.vendor_id !== loaded.vendor_id)) {
      p.vendor = form.vendor;
      p.vendor_id = form.vendor_id;
    }
    return p;
  }, [form, loaded, isPoGrn, row]);
  const dirty = !!patch && Object.keys(patch).length > 0;

  /* ── THE LINE HALF ──────────────────────────────────────────────────────── */

  const items: any[] = useMemo(() => (Array.isArray(row?.items) ? row.items : []), [row]);
  /** The bill's state AS THIS FORM READ IT — the three-way branch and, below,
   *  the two pins sent with the correction. Read off the DETAIL, never the list
   *  row: the one thing that moves under an open panel is exactly this, a QC
   *  sign-off landing while the modal is open. */
  const statusNow = String(row?.status || '');
  const heldNow = statusNow === 'awaiting_qc';
  const voidNow = statusNow === 'void';
  /**
   * MAY THIS USER CORRECT LINES? BOTH ANSWERS MUST SAY YES, and either being
   * unknown means no.
   *
   * PATCH is requireRole('admin'); PUT is the wider (store manager | manager |
   * admin) that opened this modal. So `canAmend` — the flag that reveals the
   * pencil — is the WRONG flag for this section: a store manager legitimately
   * gets here and must see the paperwork fields and not the line editor.
   * `isAdmin` from the list payload and `is_admin` from the detail read are two
   * independent answers to the same question; requiring both is what makes a
   * half-finished load hide the editor rather than offer an action the server
   * will refuse. Advisory either way — the server re-derives the bar.
   */
  const canEditLines = isAdmin === true && detailIsAdmin === true && !voidNow;
  const setDraft = (id: string, p: Partial<LineDraft>, it: any) =>
    setDrafts(d => ({ ...d, [id]: { ...(d[id] ?? draftFromItem(it)), ...p } }));

  /** Every line, with what it would send and what it would move. Recomputed from
   *  the server rows on every keystroke, so nothing is cached that could outlive
   *  a reload. */
  const lineWork = useMemo(
    () => items.map(it => {
      const d = drafts[String(it.id)] ?? draftFromItem(it);
      return { it, d, w: deriveLine(it, d, heldNow) };
    }),
    [items, drafts, heldNow],
  );
  const changedLines = lineWork.filter(x => x.w.changed);
  const lineDirty = canEditLines && changedLines.length > 0;
  const lineErrors = lineWork.flatMap(x => x.w.errors.map(e => `${x.it.material_name}: ${e}.`));
  const removingCount = lineWork.filter(x => x.d.remove).length;
  /** Pre-empts the server's `last_line`: a bill with nothing on it is not an
   *  amendment, it is a void, and saying so here beats a 400 that arrives after
   *  the reason has been typed. */
  const removingAll = removingCount > 0 && removingCount >= items.length;
  /** Net stock effect of everything pending, per material, in PURCHASE units. */
  const stockEffect = changedLines
    .filter(x => Math.abs(x.w.acceptedDelta) > LINE_EPS)
    .map(x => ({ it: x.it, delta: x.w.acceptedDelta }));
  /** TWO MONEY FIGURES, BECAUSE THEY ARE TWO DIFFERENT THINGS. `ledgerEffect`
   *  is what the `purchases` cost rows move by (accepted × rate) — the spend
   *  ledger, the weighted average, the purchase log. `docEffect` is what the
   *  printed bill's subtotal moves by (received × rate). Reporting only the
   *  second, labelled "Bill value", announced money on a received-only fix that
   *  never moves and stayed silent on an accepted fix that moves thousands. */
  const ledgerEffect = changedLines.reduce((s, x) => s + x.w.ledgerDelta, 0);
  const docEffect = changedLines.reduce((s, x) => s + x.w.docDelta, 0);
  /** Does anything pending rewrite the vendor-facing rejected quantity or the
   *  sentence beside it? Surfaced at bill level too: it is the one consequence
   *  that leaves this system entirely — /grn/print and /receiving-variance both
   *  read it, and the vendor answers for it. */
  const rejectionEffect = changedLines.filter(x => !!x.w.rejection);
  /** Any line whose hand-typed tax rupees go to ₹0 and cannot be re-derived. */
  const taxZeroed = changedLines.filter(x => x.w.tax?.mode === 'zeroed');
  /**
   * WHY REMOVE IS WITHHELD, per line — pre-empting the refusal instead of
   * letting the button 409. A PO-sourced receipt can never have a line removed
   * (removing it un-claims the PO line, and six places derive "already received"
   * from these rows without filtering), and the server's own named alternative
   * is to set the accepted quantity to 0 — which this row offers beside the
   * accepted box.
   */
  const removeBlockedFor = (it: any): string | null => {
    if (isPoGrn) {
      // AND THE ALTERNATIVE IS A DIFFERENT ONE ON A HELD RECEIPT. "Set the
      // accepted quantity to 0" names a box that is deliberately not rendered
      // while the bill waits for its check, and the server refuses any accepted
      // figure from here (held_accepted) — so on a held PO receipt that sentence
      // pointed at a control that does not exist and an action that 400s. What
      // IS available there is the received quantity: nothing has booked yet, so
      // correcting what arrived to 0 is the whole of the reversal.
      if (heldNow) {
        return `${it.material_name} was booked against ${g.po_number || 'a purchase order'}, and a PO line cannot be removed — it would un-claim the order's line and leave the order disagreeing with itself about what was delivered. This receipt has not entered stock yet, so correct what ARRIVED to 0 instead: the line stays on the bill, the order's line stays claimed, and nothing is booked when the check is signed.`;
      }
      return `${it.material_name} was booked against ${g.po_number || 'a purchase order'}, and a PO line cannot be removed — it would un-claim the order's line and leave the order disagreeing with itself about what was delivered. Set the accepted quantity to 0 instead: that reverses the stock and the cost row and keeps the PO line claimed (it is a one-way door — the goods would have to come in on a fresh PO or an ad-hoc GRN).`;
    }
    if (items.length <= 1) {
      return `${it.material_name} is the only line on this bill, and removing it would leave the bill with nothing on it. That is a void, not an amendment — use Delete on the row instead.`;
    }
    return null;
  };

  const submit = async () => {
    if (!form || !patch) return;
    if (!dirty && !lineDirty) return;
    // Mirrors the server's own refusal rather than replacing it — the point is
    // an instant answer, not a second authority. The bill number is the only way
    // back to the vendor's paperwork months later, and the duplicate-bill guard
    // skips any row whose bill_no is blank, so clearing it does not merely lose
    // a reference: it switches that guard off for this bill's cost rows.
    if (dirty && 'invoice_number' in patch && !String(patch.invoice_number).trim()) {
      setErr('Vendor invoice / bill number is required — an amendment cannot remove the only link back to the vendor\'s paperwork.');
      setErrCode(''); setErrPayload(null);
      return;
    }
    // ── THE LINE HALF'S OWN PRE-CHECKS. Each mirrors a server refusal and each
    //    is answered here because the server refuses the WHOLE request: one bad
    //    box would otherwise throw away the corrections on every other line.
    if (lineDirty) {
      if (reason.trim().length < 3) {
        setErr('A reason is required to correct a recorded bill — it is the only thing that will explain this change to whoever reads the ledger months from now.');
        setErrCode('reason_required'); setErrPayload(null);
        return;
      }
      if (lineErrors.length > 0) {
        setErr(lineErrors.join(' '));
        setErrCode('local_precheck'); setErrPayload(null);
        return;
      }
      if (removingAll) {
        setErr(`Removing ${removingCount === 1 ? 'that line' : 'those lines'} would leave ${g.grn_number} with no lines at all. A bill with nothing on it is not an amendment — delete the whole receipt instead, which reverses its stock and marks it void.`);
        setErrCode('last_line'); setErrPayload(null);
        return;
      }
    }
    setBusy(true); setErr(''); setErrCode(''); setErrPayload(null); setWarnings([]); setPatchUncertain(false);
    /* Hoisted OUT of the try so the catch can still reach them: a thrown
       request must be able to say what had already committed (`collected`) and
       whether the line half was in flight when the connection went
       (`patchInFlight`). Both are the difference between an honest report and
       an assertion this form cannot support. */
    const collected: string[] = [];
    let patchInFlight = false;
    try {
      /* ── ORDER MATTERS, AND SO DOES THE PIN BETWEEN THE TWO CALLS ─────────
         The paperwork goes first because PUT ITSELF STAMPS AN AMENDMENT: it
         bumps goods_receipt_notes.edit_count. So the expect_edit_count this
         form read when it opened is stale the instant PUT succeeds, and the
         PATCH behind it would be refused with `grn_changed` — by this very
         form's own write. PUT returns the new count; it is carried across.
         A refusal of the SECOND call after the FIRST committed is a real
         outcome and is reported as one (see metaSaved) — never as "nothing
         was saved", which would send an admin to re-type a change that is
         already recorded. */
      /* AND IT IS SENT UNCONDITIONALLY. Omitted, the server substitutes a −1
         sentinel and the bill-level half of the replay guard is simply OFF —
         a fail-OPEN on a concurrency pin, and one that is invisible from the
         screen. The detail read hands an admin this column (stripEditStamps
         only withholds it from non-admins, and canEditLines requires
         `detailIsAdmin === true`), so the fallback is unreachable in practice;
         it is 0 rather than "omit" so that if it ever IS reached the claim
         mismatches and refuses, instead of quietly dropping the guard. */
      let editCountForPatch: number =
        Number.isFinite(Number(row?.edit_count)) ? Number(row?.edit_count) : 0;

      if (dirty) {
        const res = await api(`/api/grn/${encodeURIComponent(g.id)}`, {
          method: 'PUT',
          // The reason is free text and rides into the audit note. It is not a
          // field of the bill, so it is sent alongside the patch, never inside it.
          body: { ...patch, ...(reason.trim() ? { edit_reason: reason.trim() } : {}) },
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setErr(j?.error || `Amend failed (HTTP ${res.status})`);
          setErrCode(String(j?.code || '')); setErrPayload(j);
          return;
        }
        setMetaSaved(true);
        setLoaded(form);            // saved — this is the new baseline, so Save greys out
        if (Number.isFinite(Number(j?.edit_count))) {
          editCountForPatch = Number(j.edit_count);
          /* AND IT GOES BACK INTO `row`, NOT JUST INTO THIS CLOSURE.
             `row` is the only place the NEXT submit reads the count from, and
             it was written once, by the load effect. So after PUT committed and
             PATCH was refused for a real reason, correcting the figure and
             pressing Save again skipped PUT (the form is no longer dirty) and
             sent the count read at OPEN — one behind. The server answered
             "it has been amended 1 time(s) — you were looking at 0", reporting a
             phantom concurrent editor for this form's own earlier write, and the
             only offered remedy (Reload) discards every line correction just
             re-typed. Fails closed, so nothing corrupts; it just makes the
             feature unusable at the exact moment it is needed twice. */
          setRow((r: any) => (r ? { ...r, edit_count: Number(j.edit_count), edited_at: j?.edited_at ?? r.edited_at, edited_by: j?.edited_by ?? r.edited_by } : r));
        }
        if (Array.isArray(j?.warnings)) collected.push(...j.warnings);
        // A warning is not a failure: the amendment COMMITTED. Hold the modal
        // open so the message is read rather than flashed away by a reload —
        // the one that matters says the duplicate-bill guard is still blind for
        // a legacy receipt's cost rows, which the user has to know to act on.
        if (!lineDirty) {
          if (collected.length > 0) { setWarnings(collected); return; }
          onSaved();
          return;
        }
      }

      if (lineDirty) {
        patchInFlight = true;
        const res = await api(`/api/grn/${encodeURIComponent(g.id)}`, {
          method: 'PATCH',
          body: {
            lines: changedLines.map(x => x.w.send),
            // BOTH PINS, from the read that produced the per-line `expect`
            // triples above — they are one claim about one snapshot and must
            // come from one read. expect_status is the load-bearing half: a QC
            // sign-off landing in between moves this receipt from held (no
            // stock effect) to inwarded (the full four writes), and running the
            // wrong branch would double-apply or double-reverse stock.
            expect_status: statusNow,
            expect_edit_count: editCountForPatch,
            reason: reason.trim(),
          },
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setErr(j?.error || `The line correction could not be applied (HTTP ${res.status})`);
          setErrCode(String(j?.code || 'refused')); setErrPayload(j);
          /* THE PAPERWORK HALF'S WARNINGS SURVIVE THE LINE HALF'S REFUSAL.
             They were collected from a call that COMMITTED, and this branch used
             to return without ever flushing them — `setWarnings([])` at the top
             of submit had already cleared the state. PUT emits exactly two, and
             the one that matters says this bill's cost rows have just stopped
             matching the CSV importer's blank-bill wildcard, so re-uploading an
             inward sheet against the old blank number "will add the stock a
             second time". Fixing a bill number and fixing a quantity in one save
             is precisely what correcting a mis-keyed receipt looks like, and
             that warning is one-shot: it never reappears on reload. */
          if (collected.length > 0) setWarnings(collected);
          return;
        }
        if (Array.isArray(j?.warnings)) collected.push(...j.warnings);
        setWarnings(collected);
        // The correction has COMMITTED. Its result is its own phase — what
        // moved, which weighted averages could not be re-derived, and what was
        // deliberately not rewritten. Read, not dismissed.
        setLineResult(j);
        return;
      }
      onSaved();
    } catch (e: any) {
      setErr(e?.message || 'Amend failed');
      setErrCode(''); setErrPayload(null);
      // The request never came back with an answer. Anything already committed
      // still has to be reported, and the line half's outcome is genuinely
      // unknown — see patchUncertain.
      if (collected.length > 0) setWarnings(collected);
      if (patchInFlight) setPatchUncertain(true);
    } finally { setBusy(false); }
  };

  const fieldCls = 'px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] disabled:bg-[#F3EEE7] disabled:text-[#8B7355]';

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className={`bg-white rounded-xl border border-[#E8D5C4] w-full ${canEditLines ? 'max-w-3xl' : 'max-w-2xl'} shadow-xl flex flex-col overflow-hidden`}>
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <h2 className="font-bold text-[#2D1B0E] truncate">Edit bill — {g.grn_number}</h2>
            <p className="text-[10px] text-[#8B7355]">The amendment is recorded: who, when and what changed.</p>
          </div>
          {/* CLOSING AFTER SOMETHING COMMITTED IS A SAVE, NOT A CANCEL.
              onClose only drops the modal; onSaved also bumps the page's
              dataVersion, which is what makes an already-expanded row throw away
              its cached lines and re-read them. Take the X after a committed
              correction and the panel underneath keeps showing the pre-correction
              quantities — and an admin who thinks a correction did not apply
              applies it again by hand. */}
          <button onClick={() => ((lineResult || metaSaved) ? onSaved() : onClose())} aria-label="Close">
            <X className="w-5 h-5 text-[#8B7355]" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4 text-xs">
          {loadErr ? (
            <div className="text-red-700 flex items-start gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" /> {loadErr}</div>
          ) : !form ? (
            <div className="text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading the bill…</div>
          ) : lineResult ? (
            /* ── PHASE TWO: WHAT THE CORRECTION ACTUALLY DID. ────────────────
               The same discipline as the void's result phase: the server comes
               back saying which materials moved, which weighted averages it
               could NOT re-derive and what was deliberately not rewritten, and
               that is read, not dismissed by an alert(). The editor is gone
               from this phase on purpose — its `expect` triples describe a bill
               that no longer exists. */
            <LineResultPanel result={lineResult} items={items} warnings={warnings} metaSaved={metaSaved} onDone={onSaved} />
          ) : (
            <>
              {/* Said UP FRONT, where the reader looks for what is missing — an
                  amend form that silently lacks a field reads as broken rather
                  than as deliberate. It now says three different things to three
                  different readers, because the answer really is different:
                  the line editor below is admin-only, and the receipt date is
                  nobody's to amend on this form. */}
              <p className="text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
                {canEditLines ? (
                  <>
                    The bill's <b>paperwork</b> is amended here; its <b>line items</b> — quantities, rates and removals —
                    are corrected in the section below, and that section moves stock and money.
                    The <b>receipt date</b> is not amendable either way: it is the valuation date every cost row and
                    recipe cost was built from. To change it, delete this bill (which reverses its stock) and record it again.
                  </>
                ) : (
                  <>
                    Only the bill's <b>paperwork</b> can be amended here — nothing below moves stock or money.
                    The <b>receipt date</b> and the <b>line items</b> are not amendable from this form: the date is the
                    valuation date every cost row was built from, and the quantities and rates are the stock movement itself.
                    An <b>admin</b> can correct quantities, rates and lines on this same screen; the date needs the bill
                    deleted (which reverses its stock) and recorded again.
                  </>
                )}
              </p>

              {/* ── A REFUSAL, RENDERED WHOLE ────────────────────────────────
                  Caption (which of ~40 refusals this is) → the server's own
                  sentence VERBATIM (it names the material, the figures and the
                  remedy; a re-worded copy would drift from it) → and, only
                  where an ACTION beats re-reading, the action itself. */}
              {err && (
                <div className="text-red-700 bg-red-50 border border-red-200 rounded p-2 space-y-1.5">
                  <div className="flex items-start gap-1.5">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>
                      <b>{patchUncertain ? 'The correction did not come back with an answer' : (REFUSAL_TITLE[errCode] || 'This could not be saved')}</b>
                      <span className="block mt-0.5">{err}</span>
                    </span>
                  </div>

                  {/* THE PAPERWORK MAY ALREADY BE IN. Two calls, one button —
                      an admin told "failed" about a change that committed will
                      re-type it, which is exactly what the void learned not to
                      allow. */}
                  {/* AND ONLY WHERE THE SERVER SAID SO. A refusal carries a
                      code and a sentence, so "nothing was changed" is the
                      server's own statement. A THROWN request is not: it may
                      have committed. Asserting non-execution there is the one
                      claim this feature's own doctrine forbids, so the two
                      cases get two different sentences. */}
                  {metaSaved && !patchUncertain && (
                    <div className="text-[10px] text-amber-900 bg-amber-50 border border-amber-300 rounded p-1.5">
                      The bill's <b>paperwork</b> was saved before this refusal — only the line corrections were rejected,
                      and no quantity, rate or line was changed. Do not re-enter the paperwork edit.
                    </div>
                  )}
                  {patchUncertain && (
                    <div className="text-[10px] text-amber-900 bg-amber-50 border border-amber-300 rounded p-1.5 space-y-1">
                      <div>
                        The request never came back, so <b>whether the line correction was applied is not something this form can tell.</b>{' '}
                        It may have reached the server and committed.
                        {metaSaved && <> The bill's <b>paperwork</b> did save — do not re-enter that half.</>}
                      </div>
                      <div>
                        <b>Reload the bill and read the lines</b> before re-sending. If the correction did land, re-sending it is refused
                        by the per-line lock rather than applied twice — but read first, so you are correcting from what is actually recorded.
                      </div>
                      <div className="pt-0.5">
                        <button type="button" onClick={reloadBill}
                                className="px-2 py-1 rounded bg-[#af4408] hover:bg-[#8a3506] text-white text-[11px]">
                          Reload the bill
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ── WHAT IS IN THE WAY, AS FIGURES ───────────────────────
                      The sentence above already carries these numbers, in
                      purchase units, correctly — the guard was rewritten to say
                      them that way precisely because recipe grams matched
                      nothing on this screen. What the paragraph cannot do is let
                      an admin compare four quantities at a glance and reach the
                      remedy in one press, and that is all this block adds: the
                      same figures as columns, and a link to the screen the
                      sentence names.

                      THE FIGURES ARE THE SERVER'S OWN. `materials_detail`
                      carries `*_purchase` alongside every recipe value, derived
                      from the material row the guard actually read — dividing
                      the recipe figure by a pack factor read here instead would
                      print a different number from the bar that refused, on
                      exactly the material whose pack size has drifted. The
                      recipe figure rides underneath as the declared hint. */}
                  {errCode === 'would_go_negative' && Array.isArray(errPayload?.materials_detail) && errPayload.materials_detail.length > 0 && (
                    <div className="border border-red-200 rounded bg-white overflow-x-auto">
                      <table className="w-full text-[10px]">
                        <thead className="bg-red-50 text-red-900">
                          <tr>
                            <th className="text-left  py-1 px-2 font-medium">Material</th>
                            <th className="text-right py-1 px-2 font-medium">On hand</th>
                            <th className="text-right py-1 px-2 font-medium">This bill added</th>
                            <th className="text-right py-1 px-2 font-medium">Comes back out</th>
                            <th className="text-right py-1 px-2 font-medium">Short by</th>
                          </tr>
                        </thead>
                        <tbody>
                          {errPayload.materials_detail.map((m: any, i: number) => {
                            // The refusal's own units, with this bill's line as
                            // the fallback for a legacy payload that has none.
                            //
                            // AND THE TOP-LEVEL FIELDS DESCRIBE ONE MATERIAL,
                            // NOT THE TABLE. The guard throws inside the
                            // per-line loop, so `materials_detail` carries
                            // exactly one row today and the payload's unit is
                            // that row's. Widen the guard to collect several —
                            // the void's copy already blocks multiple — and
                            // every row after the first would print row one's
                            // unit against its own figures. So the payload wins
                            // only where it is unambiguous; past that, each row
                            // is labelled from its own material.
                            const local = lineUnitsOf(items.find((x: any) => String(x.material_id) === String(m.material_id)) || {});
                            const single = errPayload.materials_detail.length === 1;
                            const pu = String(m.purchase_unit || (single ? errPayload.purchase_unit : '') || local.pu || '');
                            const ru = String(m.unit || (single ? errPayload.unit : '') || local.ru || '');
                            const factor = Number(m.pack_factor) || (single ? Number(errPayload.pack_factor) : 0) || local.factor || 1;
                            const cell = (purchaseQty: any, recipeQty: any, tone: string) => (
                              <td className={`py-1 px-2 text-right font-mono ${tone}`}>
                                {fmtQtyNum(Number(purchaseQty ?? (factor > 0 ? Number(recipeQty) / factor : recipeQty)) || 0)} {pu}
                                {factor > 1 && <div className="text-[9px] font-normal text-[#B8A590]">= {fmtQtyNum(Number(recipeQty) || 0)} {ru}</div>}
                              </td>
                            );
                            return (
                              <tr key={i} className="border-t border-red-100">
                                <td className="py-1 px-2 text-[#2D1B0E]">{m.material_name || m.material_id}</td>
                                {cell(m.on_hand_purchase, m.on_hand, 'text-[#2D1B0E]')}
                                {cell(m.recorded_in_purchase, m.recorded_in, 'text-[#2D1B0E]')}
                                {cell(m.delta_purchase, m.delta, 'text-[#2D1B0E]')}
                                {cell(m.short_by_purchase, m.short_by, 'text-red-700')}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <div className="px-2 py-1.5 text-[10px] text-[#6B5744] border-t border-red-100">
                        A receipt cannot honestly move a balance this far — a physical count can.{' '}
                        <a href={String(errPayload.remedy_path || '/closing-stock')} className="text-[#af4408] underline">Record a count</a>,
                        approve it on Variance Approvals, then correct the bill.
                      </div>
                    </div>
                  )}

                  {/* The item on a line is never swappable, so this form does not
                      offer a picker at all — the honest path is the one the
                      server names, and it is one click away. */}
                  {errCode === 'material_change' && (
                    <div className="text-[10px] text-[#6B5744]">
                      A different item is a different delivery. This form never offers to swap one, so the way through is to
                      <b> remove the wrong line</b> here and record the right material on a fresh receipt.
                    </div>
                  )}

                  {/* Removing a PO line is refused; the server names the
                      alternative and the accepted box beside each line offers it. */}
                  {errCode === 'po_line_removal' && (
                    <div className="text-[10px] text-[#6B5744]">
                      Use <b>set to 0</b> beside that line's <b>Accepted</b> box instead — it reverses the stock and the cost row
                      while the purchase order's line stays claimed.
                    </div>
                  )}

                  {/* THE ONLY REFUSALS WHOSE ANSWER IS AN ACTION RATHER THAN A
                      READ: somebody else moved this bill under the form. Both
                      say "nothing was changed", so this is reload-and-retry, not
                      a failure the admin caused. */}
                  {RELOADABLE.has(errCode) && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <button type="button" onClick={reloadBill}
                              className="px-2 py-1 rounded bg-[#af4408] hover:bg-[#8a3506] text-white text-[11px]">
                        Reload the bill
                      </button>
                      <span className="text-[10px] text-[#6B5744]">
                        Re-reads the bill as it stands now. Anything typed here and not yet saved is discarded — it was written against figures that have moved.
                      </span>
                    </div>
                  )}
                </div>
              )}
              {/* WARNINGS BELONG TO WHAT COMMITTED, and something can have
                  committed even when the box above says refused — the paperwork
                  half goes first and stands. The heading says which half they
                  are about, and "Got it" (which CLOSES the modal) is withheld
                  while there is a refusal still to be read and acted on. */}
              {warnings.length > 0 && (
                <div className="text-amber-900 bg-amber-50 border border-amber-300 rounded p-2 space-y-1">
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" />
                    {err ? "The paperwork half saved, and it carries a caveat" : 'Saved, with a caveat'}
                  </div>
                  {warnings.map((w, i) => <div key={i}>{w}</div>)}
                  {!err && (
                    <div className="pt-1">
                      <button onClick={onSaved} className="px-2 py-1 rounded bg-[#af4408] hover:bg-[#8a3506] text-white">Got it</button>
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[#6B5744]">
                  Vendor Invoice No <span className="text-red-600">*</span>
                  <input value={form.invoice_number} onChange={e => set({ invoice_number: e.target.value })}
                         placeholder="the number printed on the vendor's bill" className={fieldCls} />
                </label>
                <label className="flex flex-col gap-1 text-[#6B5744]">Invoice Date
                  <input type="date" value={form.invoice_date} onChange={e => set({ invoice_date: e.target.value })} className={fieldCls} />
                </label>

                {/* VENDOR — ad-hoc only. On a PO-sourced GRN the vendor is not a
                    free-text field: it is the key the PO lines and the vendor
                    bill row were filed under, and the server refuses to move it.
                    Shown read-only with the reason rather than hidden, so the
                    value is still visible where a reader expects it. */}
                <label className="flex flex-col gap-1 text-[#6B5744] sm:col-span-2">Vendor
                  {isPoGrn ? (
                    <>
                      <input value={form.vendor} disabled className={fieldCls} />
                      <span className="text-[10px] text-[#8B7355]">
                        Not amendable on a PO-sourced GRN ({g.po_number || 'linked PO'}) — the vendor is the key its lines and vendor-bill row were filed under.
                      </span>
                    </>
                  ) : (
                    <Combobox
                      options={vendors.map(v => ({ value: v.name, label: v.name }))}
                      value={form.vendor}
                      allowCustom
                      placeholder="Type or pick"
                      onChange={(typed) => {
                        const v = vendors.find(x => String(x.name).toLowerCase().trim() === typed.toLowerCase().trim());
                        // Both halves, always — see the patch memo above.
                        set({ vendor: typed, vendor_id: v ? String(v.id) : '' });
                      }}
                      className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm"
                    />
                  )}
                </label>

                <label className="flex flex-col gap-1 text-[#6B5744]">QC Done By
                  <input value={form.qc_by} onChange={e => set({ qc_by: e.target.value })}
                         placeholder="name or email" className={fieldCls} />
                </label>
                {/* Read-only context, so nobody hunts for an editable version of
                    it. Both are the reason the fields above are worth fixing. */}
                <div className="flex flex-col gap-1 text-[#6B5744]">Receipt date (not amendable)
                  <input value={g.date} disabled className={fieldCls} />
                </div>
              </div>

              {/* ── THE CHECKLIST, SPLIT — AND THE KITCHEN HALF LOCKED ───────
                  On a gated receipt PUT /api/grn/[id] REFUSES quality /
                  temperature / damage from this caller (route.ts:356), and it is
                  right to: this form's bar is the store manager, the very person
                  decision 4 separates from the checker. Before sign-off ticking
                  them would pre-tick a check nobody made; after an override —
                  where they are deliberately 0 — it would make the printed GRN
                  say "Quality OK" on goods no one ever judged.
                  Shown DISABLED with the reason, never hidden: a reader has to
                  be able to see what the kitchen answered, and a control that
                  silently disappears reads as a bug. */}
              {(() => {
                const gated = Number(row?.qc_required) === 1;
                const checker = CHECKER_LABEL[String(row?.qc_checker || '')] || 'Kitchen';
                const stamp = (by: string | null | undefined, at: string | null | undefined) =>
                  by ? <>Signed by <b>{by}</b>{at ? <> · {fmtIST(at)}</> : null}.</> : null;
                return (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="border border-blue-200 rounded-lg p-3 bg-blue-50/40">
                      <div className="text-xs font-semibold text-blue-900 mb-1.5 flex items-center gap-1.5 flex-wrap">
                        <FileCheck className="w-3.5 h-3.5" /> Store — receiving desk
                        <span className="text-[10px] font-normal text-blue-700">
                          ({STORE_QC_FIELDS.filter(f => form[f.k]).length} of {STORE_QC_FIELDS.length})
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        {STORE_QC_FIELDS.map(f => (
                          <label key={f.k} className="flex items-start gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={!!form[f.k]}
                                   onChange={e => set({ [f.k]: e.target.checked } as Partial<BillForm>)}
                                   className="accent-blue-600 mt-0.5" />
                            <span>{f.label}</span>
                          </label>
                        ))}
                      </div>
                      <div className="text-[10px] text-blue-700 mt-1.5">
                        {stamp(row?.qc_store_by, row?.qc_store_at) || 'Yours to amend on any receipt — this is the receiving desk’s half of the split.'}
                      </div>
                    </div>

                    <div className={`border rounded-lg p-3 ${gated ? 'border-[#E8D5C4] bg-[#F3EEE7]' : 'border-blue-200 bg-blue-50/40'}`}>
                      <div className={`text-xs font-semibold mb-1.5 flex items-center gap-1.5 flex-wrap ${gated ? 'text-[#6B5744]' : 'text-blue-900'}`}>
                        {String(row?.qc_checker) === 'bar' ? <Wine className="w-3.5 h-3.5" /> : <ChefHat className="w-3.5 h-3.5" />}
                        {gated ? `${checker} — not amendable here` : 'Kitchen / bar'}
                        <span className={`text-[10px] font-normal ${gated ? 'text-[#8B7355]' : 'text-blue-700'}`}>
                          ({KITCHEN_QC_FIELDS.filter(f => form[f.k]).length} of {KITCHEN_QC_FIELDS.length})
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        {KITCHEN_QC_FIELDS.map(f => (
                          <label key={f.k} className={`flex items-start gap-1.5 ${gated ? 'cursor-not-allowed text-[#8B7355]' : 'cursor-pointer'}`}>
                            <input type="checkbox" checked={!!form[f.k]} disabled={gated}
                                   onChange={e => set({ [f.k]: e.target.checked } as Partial<BillForm>)}
                                   className="accent-blue-600 mt-0.5" />
                            <span>{f.label}</span>
                          </label>
                        ))}
                      </div>
                      <div className={`text-[10px] mt-1.5 ${gated ? 'text-[#6B5744]' : 'text-blue-700'}`}>
                        {gated ? (
                          <>
                            {stamp(row?.qc_kitchen_by, row?.qc_kitchen_at) || (
                              String(row?.status) === 'awaiting_qc'
                                ? <>Not yet checked. Sign it off on <b>Pending Quality Checks</b>, or have an admin / head chef release it with a written reason.</>
                                : String(row?.qc_outcome) === 'override'
                                  ? <>Never answered — this bill was released without a kitchen check.</>
                                  : <>Unsigned.</>
                            )}
                            {' '}The server refuses these three from this form on a held receipt — the receiving desk must not certify its own delivery.
                          </>
                        ) : (
                          <>This receipt was not gated, so these are the desk’s own note about the goods rather than a checking department’s answer.</>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

              <label className="flex flex-col gap-1 text-[#6B5744]">Notes
                <textarea rows={2} value={form.notes} onChange={e => set({ notes: e.target.value })}
                          className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
              </label>

              {/* ══ THE LINE ITEMS ══════════════════════════════════════════ */}
              {voidNow ? (
                <div className="border border-[#B8A590] rounded-lg p-3 bg-[#EFE7DE] text-[#6B5744]">
                  <div className="font-semibold flex items-center gap-1.5 mb-1"><ShieldAlert className="w-4 h-4" /> This bill is voided</div>
                  A voided receipt's lines are kept as the record of what the document said, and are no longer editable —
                  the correction you want is a fresh GRN, not an edit to this one.
                </div>
              ) : canEditLines ? (
                <div className="border border-[#E8D5C4] rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-[#FFF1E3] border-b border-[#E8D5C4]">
                    <div className="font-semibold text-[#2D1B0E] flex items-center gap-1.5 flex-wrap">
                      <FileCheck className="w-4 h-4 text-[#af4408]" /> Line items — quantities, rates and removals
                      <span className="text-[10px] font-normal text-[#8B7355]">({items.length} line{items.length === 1 ? '' : 's'} · admin only)</span>
                    </div>
                    {/* ── THE CONSEQUENCE, STATED BEFORE THE PRESS, AND IT IS A
                        DIFFERENT CONSEQUENCE IN THE TWO STATES. Getting this
                        wrong is the whole risk of the feature: on a held receipt
                        the edit is free, and on an inwarded one it unwinds and
                        reapplies real stock and real money. */}
                    {heldNow ? (
                      <div className="mt-1.5 text-[11px] text-blue-900 bg-blue-50 border border-blue-200 rounded p-2">
                        <b>Nothing has entered stock yet.</b> This delivery is still waiting for its
                        {' '}{CHECKER_LABEL[String(row?.qc_checker || '')] || 'kitchen'} check, so no stock, no cost row and no
                        weighted average exist for it. Correcting a line here just corrects the record — the figures below are
                        applied for the first time when the checking department signs it off.
                        {' '}The <b>accepted</b> quantity is therefore not offered: it stays 0 until they sign.
                        {' '}A line's <b>tax</b> still follows its value even here — a rate-based line is re-derived at sign-off, and one
                        whose rupees were typed by hand is rescaled in proportion to what you record as having arrived.
                      </div>
                    ) : (
                      <div className="mt-1.5 text-[11px] text-amber-900 bg-amber-50 border border-amber-300 rounded p-2 space-y-1">
                        <div>
                          <b>This bill has already moved stock and money.</b> Saving a line correction <b>unwinds</b> what this
                          receipt applied — the stock, the cost row and the stock movement — and <b>reapplies</b> the corrected
                          figures, in one transaction. Weighted averages are re-derived afterwards and cascade into every recipe
                          that uses these materials. Valuations already taken at the old average (closing stock, department
                          variance, party consumption, production batches) are historical and are <b>not</b> rewritten.
                        </div>
                        {/* THREE MORE THINGS A SAVE DOES — none of them stock,
                            all of them named here because the paragraph above
                            reads as a complete list and an admin plans against
                            it. Each pending line then spells out its own version
                            below, with its own figures. */}
                        <div>
                          It rewrites three more things. The line's <b>CGST / SGST / cess</b> follow the goods: a line carrying a GST
                          rate is re-derived from that rate, and a line whose tax was typed in rupees is <b>rescaled</b> in proportion
                          to the value — and to <b>₹0, one way,</b> if that value reaches zero. The <b>rejected quantity the vendor
                          answers for</b> is re-derived as received − accepted, with the reason you give below stamped over the
                          checker's own words on the printed bill and the receiving-variance report. And the bill's own <b>status</b> is
                          recomputed from the corrected lines — one carrying a rejected quantity reads as <i>partial</i>, one with
                          nothing accepted reads as <i>rejected</i>.
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="p-2.5 space-y-2">
                    {items.length === 0 ? (
                      <div className="text-[#8B7355]">This bill has no lines.</div>
                    ) : lineWork.map(({ it, d, w }) => (
                      <LineDraftRow key={it.id} it={it} draft={d} work={w} held={heldNow}
                                    removeBlocked={removeBlockedFor(it)}
                                    onChange={p => setDraft(String(it.id), p, it)} />
                    ))}
                  </div>

                  {/* THE NET EFFECT OF EVERYTHING PENDING, in one place, so the
                      admin is not adding the rows up in their head. */}
                  {(lineDirty || removingAll) && (
                    <div className="px-3 py-2 border-t border-[#E8D5C4] bg-[#FFF8F0] text-[11px] space-y-1">
                      <div className="font-semibold text-[#2D1B0E]">
                        {changedLines.length} line{changedLines.length === 1 ? '' : 's'} pending
                        {removingCount > 0 && <> · {removingCount} to be removed</>}
                      </div>
                      {removingAll && (
                        <div className="text-red-700 flex items-start gap-1">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                          <span>That is every line on the bill. A bill with nothing on it is not an amendment — delete the whole receipt instead (the row's Delete reverses its stock and marks it void).</span>
                        </div>
                      )}
                      {heldNow ? (
                        <div className="text-[#6B5744]">No stock moves — this receipt has not entered stock and will not until it is signed off.</div>
                      ) : stockEffect.length > 0 ? (
                        <div className="text-[#6B5744]">
                          Central stock will change by:{' '}
                          {stockEffect.map(({ it, delta }, i) => {
                            const { factor, pu, ru } = lineUnitsOf(it);
                            return (
                              <span key={String(it.id)}>
                                {i > 0 && '; '}
                                <b>{it.material_name}</b>{' '}
                                <span className={delta < 0 ? 'text-red-700' : 'text-emerald-700'}>
                                  {delta < 0 ? '−' : '+'}{fmtQtyNum(Math.abs(delta))} {pu}
                                  {factor > 1 && <span className="text-[#B8A590]"> (= {fmtQtyNum(Math.abs(delta) * factor)} {ru})</span>}
                                </span>
                              </span>
                            );
                          })}.
                        </div>
                      ) : (
                        <div className="text-[#6B5744]">
                          No stock moves — nothing pending changes an <b>accepted</b> quantity, and only that figure feeds the stock balance.
                          {removingCount > 0 && ' (The line(s) being removed had nothing accepted, so they never added any.)'}
                        </div>
                      )}

                      {/* THE MONEY, ON THE LEDGER'S BASIS FIRST. */}
                      {Math.abs(ledgerEffect) > 0.005 ? (
                        <div className="text-[#6B5744]">
                          Purchase cost recorded against this bill {ledgerEffect < 0 ? 'falls' : 'rises'} by <b>{m2(Math.abs(ledgerEffect))}</b>{' '}
                          <span className="text-[#8B7355]">(accepted × rate — the cost rows every spend report and weighted average read)</span>.
                        </div>
                      ) : heldNow ? null : (
                        <div className="text-[#6B5744]">No purchase cost moves — the accepted quantities and rates come to the same figure.</div>
                      )}
                      {Math.abs(docEffect - (heldNow ? 0 : ledgerEffect)) > 0.005 && (
                        Math.abs(docEffect) > 0.005 ? (
                          <div className="text-[#8B7355]">
                            The printed bill's subtotal (received × rate) {docEffect < 0 ? 'falls' : 'rises'} by <b>{m2(Math.abs(docEffect))}</b>
                            {!heldNow && ' — a different figure from the one above, because the ledger follows what was ACCEPTED, not what arrived'}.
                          </div>
                        ) : (
                          <div className="text-[#8B7355]">
                            The printed bill's subtotal is unchanged — what ARRIVED did not move, only what was accepted.
                          </div>
                        )
                      )}

                      {/* WHAT LEAVES THIS SYSTEM: the vendor-facing rejection. */}
                      {rejectionEffect.length > 0 && (
                        <div className="text-amber-800">
                          <b>The vendor-facing rejected quantity is rewritten</b> on {rejectionEffect.length} line
                          {rejectionEffect.length === 1 ? '' : 's'} ({rejectionEffect.map(x => x.it.material_name).join(', ')}).
                          {rejectionEffect.some(x => x.w.rejection?.reasonReplaced) &&
                            ' Your reason below becomes the rejection reason on this bill and on the receiving-variance report.'}
                        </div>
                      )}

                      {/* THE ONE-WAY DOOR. */}
                      {taxZeroed.length > 0 && (
                        <div className="text-red-700">
                          <b>Tax typed in rupees goes to ₹0</b> on {taxZeroed.map(x => x.it.material_name).join(', ')} and cannot be brought back by
                          re-booking the line — there is no rate to recompute from. Re-record the receipt if that input credit is still claimable.
                        </div>
                      )}
                      {/* We do NOT predict the resulting balance. The page's own
                          stock reader deliberately reports Store + Dept and
                          refuses raw_materials.current_stock, which is the exact
                          column the server's guard tests — printing a
                          confidently different number than the bar that decides
                          is worse than printing none. */}
                      <div className="text-[10px] text-[#8B7355]">
                        If a correction would drive a material's central stock below zero, the server refuses it and names what is in the way — nothing is applied.
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                /* NOT AN ADMIN. Said rather than silently absent: a form that
                   simply has no line section reads as broken, and the reader is
                   entitled to know who can do it. */
                <div className="text-[10px] text-[#8B7355] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2 flex items-start gap-1.5">
                  <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
                  <span>
                    Quantities, rates and line removal are corrected by an <b>admin</b> — that correction unwinds and reapplies
                    this bill's stock and cost rows, so it carries the same bar as deleting the bill. Everything above is yours to amend.
                  </span>
                </div>
              )}

              <label className="flex flex-col gap-1 text-[#6B5744]">
                Why is this being amended?{' '}
                {lineDirty
                  ? <span className="text-[10px] text-red-600">(required — a line correction is a backward change to a recorded financial document, and this is the only thing that will explain it to whoever reads the ledger months from now)</span>
                  : <span className="text-[10px] text-[#8B7355]">(optional — goes into the audit trail, not onto the bill)</span>}
                <input value={reason} onChange={e => setReason(e.target.value)}
                       placeholder={lineDirty ? 'e.g. vendor short-delivered 2 crates; bill corrected against the gate pass' : 'e.g. bill number was mistyped at the receiving bay'}
                       className={`px-2 py-1.5 border rounded bg-[#FFF8F0] ${lineDirty && reason.trim().length < 3 ? 'border-red-300' : 'border-[#E8D5C4]'}`} />
              </label>

              {/* What is about to be recorded, before it is recorded. */}
              <div className="text-[10px] text-[#8B7355] space-y-0.5">
                {dirty && <div>Paperwork: will be recorded as an amendment to <b>{Object.keys(patch || {}).map(k => FIELD_LABEL[k] || k).join(', ')}</b> by you, stamped with the time. Admins see an “edited” marker on this row afterwards.</div>}
                {lineDirty && (
                  <div>
                    Lines: <b>{changedLines.map(x => `${x.it.material_name}${x.d.remove ? ' (removed)' : ''}`).join(', ')}</b> — sent with the figures this form is
                    showing, re-checked under the write lock, so a double submit cannot apply the same correction twice.
                    {heldNow ? ' The bill lines are rewritten; no stock moves.' : ' The stock, cost rows and stock movements are unwound and reapplied in one transaction.'}
                  </div>
                )}
                {!dirty && !lineDirty && <div>Nothing changed yet.</div>}
              </div>
            </>
          )}
        </div>

        {!lineResult && (
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2 shrink-0">
          {/* Same rule as the X above: once the paperwork half has committed,
              leaving this modal has to refresh the row it came from. */}
          <button onClick={() => (metaSaved ? onSaved() : onClose())} className="px-3 py-1.5 text-sm text-[#6B5744]">
            {metaSaved ? 'Close' : 'Cancel'}
          </button>
          <button onClick={submit} disabled={busy || (!dirty && !lineDirty) || !!loadErr || (lineDirty && (lineErrors.length > 0 || removingAll || reason.trim().length < 3))}
                  /* The most SPECIFIC blocker first — a flagged field is a
                     thing to go and fix, where "needs a reason" is a thing to
                     type once at the end. */
                  title={
                    !dirty && !lineDirty ? 'Change something first'
                    : lineDirty && lineErrors.length > 0 ? 'Fix the flagged line(s) first'
                    : lineDirty && removingAll ? 'Removing every line is a void, not an amendment'
                    : lineDirty && reason.trim().length < 3 ? 'A line correction needs a reason'
                    : lineDirty ? 'Correct the lines (and save the paperwork)'
                    : 'Save the amendment'}
                  className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {busy ? 'Saving…' : lineDirty ? 'Save correction' : 'Save amendment'}
          </button>
        </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================ */
/* DELETE BILL = VOID. ADMIN ONLY.                              */
/*                                                              */
/* Two phases in one shell: CONFIRM (what this will actually    */
/* do, in the words of what happens to the stock) and RESULT    */
/* (what it actually did, including the one thing it could not  */
/* put back). The result is NOT an alert(): the server can come */
/* back saying a material's weighted average still carries this */
/* bill's price, and that has to be read, not dismissed.        */
/* ============================================================ */
function VoidBillModal({ g, onClose, onVoided }: { g: GRN; onClose: () => void; onVoided: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<any>(null);

  const submit = async () => {
    if (!reason.trim()) { setErr('Give a reason — it is what makes the audit record worth keeping.'); return; }
    setBusy(true); setErr('');
    try {
      const res = await api(`/api/grn/${encodeURIComponent(g.id)}`, {
        method: 'DELETE',
        body: { reason: reason.trim() },
      });
      const j = await res.json().catch(() => ({}));
      // A refusal is a normal, designed outcome — a bill dated before the store
      // cutover, one with returns against it, one that would drive stock
      // negative, or, on a purchase-order bill, a later receipt still standing /
      // a vendor bill row that cannot be identified / a party deduction that
      // cannot be traced to this order. The server's message names which and why
      // and what to do about it — show it VERBATIM rather than replacing it with
      // "Failed". `j.code` carries the same thing machine-readably and is
      // deliberately not branched on here: the sentence is already the whole
      // instruction, and a branch would be a second, drifting copy of it.
      if (!res.ok) { setErr(j?.error || `Could not delete this bill (HTTP ${res.status})`); return; }
      setResult(j);
    } catch (e: any) {
      setErr(e?.message || 'Could not delete this bill');
    } finally { setBusy(false); }
  };

  const stale: any[] = Array.isArray(result?.average_price_stale) ? result.average_price_stale : [];
  const reversed: any[] = Array.isArray(result?.stock_reversed) ? result.stock_reversed : [];
  /** Materials whose last-purchase rate was left alone because this bill is not
   *  what set it. Informational — nothing needs doing — so it sits below the
   *  amber panel rather than in it. */
  const lppKept: any[] = Array.isArray(result?.last_purchase_kept) ? result.last_purchase_kept : [];
  /** Trouble AFTER the reversal committed. The void succeeded; something in the
   *  price refresh behind it did not. This must never read as "the void failed"
   *  — an admin who believes that corrects it by hand on top of a reversal that
   *  already landed. */
  const postWarnings: string[] = Array.isArray(result?.warnings) ? result.warnings : [];
  /** The PO rails, present ONLY on a PO-sourced void (the server omits every one
   *  of these keys on an ad-hoc bill, so this whole panel disappears there).
   *  Read off `po_number` rather than off `g.po_id`, because what matters here is
   *  what the SERVER reports it did, not what the row said it was. */
  const poDone: boolean = !!result?.po_number;
  const partyBack: any[] = Array.isArray(result?.party_stock_restored) ? result.party_stock_restored : [];
  const partyKept: number = Number(result?.party_stock_left_intact) || 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <h2 className="font-bold text-[#2D1B0E] flex items-center gap-2 min-w-0">
            <Trash2 className="w-4 h-4 text-red-600 shrink-0" />
            <span className="truncate">{result ? `Deleted ${g.grn_number}` : `Delete bill ${g.grn_number}?`}</span>
          </h2>
          <button onClick={result ? onVoided : onClose} aria-label="Close"><X className="w-5 h-5 text-[#8B7355]" /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3 text-xs">
          {!result ? (
            <>
              {/* NOT "Are you sure?". This is the list of things that are about
                  to happen to live inventory and live cost, in the order they
                  happen, because that is the only way the reader can judge it. */}
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-2 text-[#6B5744]">
                <div className="font-semibold text-red-800 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" /> This reverses the stock this GRN added and marks it void.
                </div>
                <ul className="list-disc pl-4 space-y-1">
                  <li><b>Stock goes back down.</b> Every material this bill added is debited by the quantity that was actually recorded when it was received.</li>
                  <li><b>Its cost rows are removed</b> and each affected material's weighted average price is re-derived from the purchases that remain — which flows on into recipe costs.</li>
                  <li><b>The bill is kept, not erased.</b> Its header, line items and ₹ figures stay in the register, struck through and stamped with your name and the time. It stops counting towards inward value.</li>
                  {/* THE THREE PO RAILS. A PO-sourced void does six things, not
                      three, and this panel's whole job is to be the list of what
                      is about to happen to live inventory and live cost. Listing
                      half of them and letting the admin discover the rest from
                      the result screen is exactly the shape of surprise this
                      panel exists to prevent. Additive: absent on an ad-hoc
                      bill, where the panel is exactly as it shipped. */}
                  {g.po_id && <>
                    <li><b>{g.po_number || 'The purchase order'} opens again for receiving</b> — unless another receipt on it still covers these lines. Its received date is cleared and its total goes back to what was ordered, so the delivery can be taken in again properly.</li>
                    <li><b>The vendor bill number is released.</b> The row that stops the same bill being received twice is removed, which is what lets the store re-enter this delivery under the same bill number. It is kept in the audit trail.</li>
                    <li><b>Any requisition this order fulfilled goes back to the store queue</b> — and for a party requisition, the stock it consumed a second time is credited back, but only where this order is provably what deducted it.</li>
                  </>}
                </ul>
                <div className="pt-1 border-t border-red-200">
                  It is refused — with nothing changed — if the bill belongs to another outlet than the one you are working in, is dated on or
                  before the central-store cutover, has a return ticket against it, or if reversing it would push any material's stock below zero.
                  {g.po_id && <> On a purchase-order bill it is also refused if a later receipt on the order is still standing (void that one
                  first), if its vendor bill row cannot be identified, or if a party deduction on its requisition cannot be traced to this order.
                  The reason comes back in full — nothing is changed while you read it.</>}
                </div>
              </div>

              {/* A HELD RECEIPT NEVER ADDED ANY STOCK, so the three bullets
                  above describe an event that cannot happen here — the reversal
                  will legitimately find 0 materials, 0 cost rows, 0 movements.
                  Said BEFORE the click as well as in the server's own result
                  notice, because "Reversed 0 materials" on the way out reads as
                  the void having silently failed, and the correction for that
                  belief is a manual adjustment on top of a receipt that never
                  landed. Additive: on every other bill this block is absent and
                  the panel is exactly as it shipped. */}
              {isHeld(g) && (
                <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-2.5 text-blue-900 text-[11px]">
                  <b>This receipt is still waiting for a quality check, so it never added any stock.</b> There is nothing to reverse —
                  deleting it will report 0 materials and 0 cost rows, and that is the correct outcome, not a failure. It leaves the
                  Pending Quality Checks queue for good and can never be signed off afterwards.
                </div>
              )}

              <div className="text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
                <div><b>Vendor:</b> {g.vendor || '—'} &nbsp; <b>Bill no.:</b> {g.invoice_number || '—'}</div>
                <div>
                  <b>Receipt date:</b> {g.date} &nbsp; <b>Lines:</b> {g.line_count} &nbsp;
                  <b>Accepted:</b>{' '}
                  {isHeld(g)
                    ? <span title="Nothing has been accepted or rejected — the checking department has not judged this delivery yet.">not decided</span>
                    : fmt(g.accepted_value || 0)}
                </div>
              </div>

              {err && (
                <div className="text-red-700 bg-red-50 border border-red-200 rounded p-2 flex items-start gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> <span>{err}</span>
                </div>
              )}

              <label className="flex flex-col gap-1 text-[#6B5744]">
                Reason <span className="text-red-600">*</span>
                <input value={reason} onChange={e => { setReason(e.target.value); if (err) setErr(''); }}
                       autoFocus placeholder="e.g. goods returned to vendor — bill cancelled"
                       className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
                <span className="text-[10px] text-[#8B7355]">Shown on the voided row and stored in the audit trail.</span>
              </label>
            </>
          ) : (
            <>
              <div className="rounded-lg border border-[#B8A590] bg-[#EFE7DE] p-3 text-[#6B5744]">
                <div className="font-semibold text-[#2D1B0E] mb-1">{voidedBadgeText({ voided_by: result.voided_by, voided_at: result.voided_at })}</div>
                <div>
                  Reversed {reversed.length} material{reversed.length === 1 ? '' : 's'};
                  removed {Number(result.purchases_deleted) || 0} cost row(s) and {Number(result.transactions_deleted) || 0} stock movement(s).
                </div>
                {/* Names only, deliberately: the reversal quantities come back in
                    the recipe basis of the stored movement rows, and this payload
                    carries no pack size to lead with the purchase unit as the
                    Purchase/Inventory display rule requires. The exact figures
                    are in the audit event behind /audit. */}
                {reversed.length > 0 && (
                  <div className="mt-1 text-[10px]">
                    <span className="text-[#8B7355]">Materials: </span>
                    {reversed.map((m: any) => m.material_name).filter(Boolean).join(', ')}
                  </div>
                )}
              </div>

              {/* THE PURCHASE ORDER, AFTER. The storekeeper's next question is
                  "can I book this delivery again now?", and the answer is a fact
                  the server just decided, not something to infer from a
                  paragraph. Stated as its own block, above the price warnings,
                  because it is what somebody is standing at the bay waiting for.
                  Additive: absent on an ad-hoc void. */}
              {poDone && (
                <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3 text-[#6B5744]">
                  <div className="font-semibold text-[#2D1B0E] mb-1">{result.po_number}</div>
                  <div>
                    {result.po_reopened
                      ? <><b>Open again for receiving.</b> Its received date is cleared and its total is back to the ordered ₹{Number(result.po_total_cost) || 0}.</>
                      : result.po_status === 'approved'
                        ? <><b>Still open for receiving</b> — this bill never closed it. Its ordered total is unchanged.</>
                        : <><b>Stays {String(result.po_status || 'closed')}</b> — a surviving receipt still covers every line this bill did.{result.po_total_restamped === false
                            ? ' Its received total was left alone because another delivery on the order is still waiting for a quality check; it is re-derived at sign-off.'
                            : ` Received total re-derived to ₹${Number(result.po_total_cost) || 0}.`}</>}
                  </div>
                  <div className="mt-1">
                    {result.bill_released
                      ? (result.bill_released.bill_no
                          ? <>Bill no. <b>{result.bill_released.bill_no}</b> from {result.bill_released.vendor_name || '(no vendor)'} is released — the same bill number can be entered again.</>
                          : <>The blank-bill receipt from {result.bill_released.vendor_name || '(no vendor)'} is released, so that vendor can deliver against this order again.</>)
                      : <>No vendor bill row was recorded for this receipt, so there was none to release.</>}
                  </div>
                  {result.requisition_reversed && (
                    <div className="mt-1">
                      The requisition behind this order is back in the store queue.{' '}
                      {partyBack.length > 0
                        ? <>Its party consumption was reversed and {partyBack.length} material{partyBack.length === 1 ? '' : 's'} credited back: {partyBack.map((m: any) => m.material_name).filter(Boolean).join(', ')}.</>
                        : partyKept > 0
                          // NOT "no party consumption was booked" — some was, by
                          // a store issue. An admin told the wrong one of those
                          // two corrects stock that was never wrong.
                          ? <>Its {partyKept} party-consumption movement{partyKept === 1 ? ' was' : 's were'} booked by a store issue rather than by this order, so {partyKept === 1 ? 'it was' : 'they were'} left exactly as {partyKept === 1 ? 'it is' : 'they are'} and no stock was credited back.</>
                          : <>No party consumption had been booked against it.</>}
                    </div>
                  )}
                </div>
              )}

              {/* THE ONE THING IT COULD NOT PUT BACK. Nothing anywhere stores the
                  pre-receipt weighted average, so when a material has no purchase
                  rows left the voided bill's price stands. Loud, and named. */}
              {stale.length > 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
                  <div className="font-semibold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> Needs your attention</div>
                  <div className="mt-1">
                    {stale.length} material{stale.length === 1 ? ' has' : 's have'} no purchase history left, so
                    {stale.length === 1 ? ' its' : ' their'} weighted average price still carries this bill's rate.
                    Nothing stores the price from before the receipt — correct it by hand, or let the next real purchase reset it.
                  </div>
                  <div className="mt-1 text-[10px]">{stale.map((m: any) => m.material_name).filter(Boolean).join(', ')}</div>
                </div>
              )}

              {postWarnings.length > 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" /> The bill WAS voided — do not repeat it
                  </div>
                  <div className="mt-1">The stock reversal committed. What follows happened afterwards, while refreshing prices:</div>
                  <ul className="mt-1 list-disc pl-4 space-y-0.5 text-[11px]">
                    {postWarnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}

              {lppKept.length > 0 && (
                <div className="text-[10px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
                  <b>Last-purchase rate unchanged</b> for {lppKept.length} material{lppKept.length === 1 ? '' : 's'} — that rate came from a
                  different receipt, not from this bill, so voiding this one does not move it:{' '}
                  {lppKept.map((m: any) => m.material_name).filter(Boolean).join(', ')}
                </div>
              )}

              {result.notice && <div className="text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">{result.notice}</div>}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2 shrink-0">
          {!result ? (
            <>
              <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
              <button onClick={submit} disabled={busy || !reason.trim()}
                      className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                {busy ? 'Reversing…' : 'Reverse stock & void'}
              </button>
            </>
          ) : (
            <button onClick={onVoided} className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg">Done</button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/* RELEASE WITHOUT A KITCHEN CHECK — the owner's decision 2.    */
/*                                                              */
/* "A hard block with no escape gets worked around." At 6am     */
/* with a truck at the bay and nobody from the kitchen in the   */
/* building, a gate that cannot be opened is a gate people      */
/* learn to route around — by not recording the delivery at     */
/* all, which is worse than the problem this feature solves.    */
/*                                                              */
/* So the escape hatch exists, and it is expensive on purpose:  */
/* only an admin or a head chef, only with a written reason,    */
/* and the bill carries the fact FOR EVER (qc_outcome /         */
/* qc_override_by / qc_override_at / qc_override_reason are     */
/* committed columns on goods_receipt_notes, not an audit row   */
/* somebody could prune) and appears on the override report.    */
/* This modal's whole job is to say that BEFORE the click, not  */
/* after — an override taken in ignorance is an override        */
/* nobody can defend later.                                     */
/*                                                              */
/* Two phases in one shell, like VoidBillModal: CONFIRM (what   */
/* this is about to do to live stock) and RESULT (what it did,  */
/* including the one thing that can fail after the stock has    */
/* already moved).                                              */
/* ============================================================ */
function OverrideQcModal({ g, onClose, onDone }: { g: GRN; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<any>(null);
  const checkerName = CHECKER_LABEL[String(g.qc_checker || '')] || 'Kitchen';

  /** Mirrors POST /api/grn/[id]/qc's own bar (a reason of at least 5 characters)
   *  so the refusal is instant — NOT a second authority. The server re-checks
   *  it, and re-checks who is asking, and fails closed. */
  const reasonOk = reason.trim().length >= 5;

  const submit = async () => {
    if (!reasonOk) { setErr('Write the reason — at least a few words. It is stored on the bill permanently and is the only defence of this decision later.'); return; }
    setBusy(true); setErr('');
    try {
      const res = await api(`/api/grn/${encodeURIComponent(g.id)}/qc`, {
        method: 'POST',
        body: { mode: 'override', reason: reason.trim() },
      });
      const j = await res.json().catch(() => ({}));
      // A refusal is a designed outcome here — not an admin/head chef, the
      // receipt already decided by someone else in another tab, a voided bill,
      // a receipt dated on or before the central-store cutover. The server names
      // which and why; show its sentence verbatim rather than "Failed".
      if (!res.ok) { setErr(j?.error || `Could not release this receipt (HTTP ${res.status})`); return; }
      setResult(j);
    } catch (e: any) {
      setErr(e?.message || 'Could not release this receipt');
    } finally { setBusy(false); }
  };

  /** Materials whose weighted average did not recompute AFTER the stock landed.
   *  The release SUCCEEDED; this is the cost cascade behind it. It must never
   *  read as "the release failed" — an admin who believes that re-runs it, and
   *  the second attempt is correctly refused, which teaches them the stock never
   *  moved when it did. (Same rule the void result panel follows.) */
  const cascadeFailed: string[] = Array.isArray(result?.price_cascade_failed) ? result.price_cascade_failed : [];

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <h2 className="font-bold text-[#2D1B0E] flex items-center gap-2 min-w-0">
            <ShieldAlert className="w-4 h-4 text-amber-700 shrink-0" />
            <span className="truncate">
              {result ? `Released ${g.grn_number}` : `Release ${g.grn_number} without a ${checkerName.toLowerCase()} check?`}
            </span>
          </h2>
          <button onClick={result ? onDone : onClose} aria-label="Close"><X className="w-5 h-5 text-[#8B7355]" /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3 text-xs">
          {!result ? (
            <>
              {/* AMBER, NOT RED. This is a sanctioned decision with a cost, not
                  a destructive one — red here would put it in the same visual
                  class as voiding a bill and reversing live stock, which is a
                  different act entirely. The cost is spelled out instead. */}
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2 text-amber-900">
                <div className="font-semibold flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" /> This inwards the goods on your authority, with nobody having checked them.
                </div>
                <ul className="list-disc pl-4 space-y-1">
                  <li><b>The stock goes in now</b>, at the quantities the receiving desk recorded — every line in full. An override is “release it”, not “release part of it”: accepting some and refusing the rest is a quality judgement, which is exactly what this says nobody made.</li>
                  <li><b>The bill is marked permanently.</b> “Inwarded without kitchen QC”, with your name, the time and this reason, stays on the receipt and on the override report. It is not an audit line that ages out.</li>
                  <li><b>The three quality checks stay unticked</b> — quality, temperature, damage. Nobody looked, so nothing may claim they did; the printed GRN will show them blank.</li>
                  <li><b>The vendor stops being answerable.</b> Once this is ours, bad goods are the venue’s loss — that leverage is what the wait was buying.</li>
                </ul>
              </div>

              <div className="text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
                <div><b>Vendor:</b> {g.vendor || '—'} &nbsp; <b>Bill no.:</b> {g.invoice_number || '—'}</div>
                <div><b>Receipt date:</b> {g.date} &nbsp; <b>Lines:</b> {g.line_count} &nbsp; <b>Bill value:</b> {fmt(g.inward_value || 0)}</div>
                <div className="mt-1 text-[10px] text-[#8B7355]">
                  Waiting on <b className="text-[#6B5744]">{checkerName}</b> since it was recorded
                  {g.received_by ? <> by {g.received_by}</> : null}.
                </div>
              </div>

              {err && (
                <div className="text-red-700 bg-red-50 border border-red-200 rounded p-2 flex items-start gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> <span>{err}</span>
                </div>
              )}

              <label className="flex flex-col gap-1 text-[#6B5744]">
                Why is this being released unchecked? <span className="text-red-600">*</span>
                <input value={reason} onChange={e => { setReason(e.target.value); if (err) setErr(''); }}
                       autoFocus placeholder="e.g. 05:40 delivery, no kitchen staff on site, chilled items cannot wait"
                       className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
                <span className="text-[10px] text-[#8B7355]">
                  Stored on the bill for good and shown on the override report. Say what stopped the check from happening — that is what makes the report worth reading.
                </span>
              </label>
            </>
          ) : (
            <>
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
                <div className="font-semibold text-[#2D1B0E] mb-1 flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4" /> {g.grn_number} — inwarded without a kitchen check
                </div>
                {/* The server's own sentence, verbatim. It is the authority on
                    what actually happened, and re-wording it here is how a
                    screen and its API start telling two stories. */}
                <div>{result.message || 'Stock has been added.'}</div>
                <div className="mt-1 text-[11px]">
                  {Number(result.lines_applied) || 0} line(s) inwarded · {Number(result.purchases_written) || 0} cost row(s) written ·
                  {' '}{Number(result.materials_touched) || 0} material(s) re-costed.
                </div>
              </div>

              {cascadeFailed.length > 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" /> The stock WAS added — do not repeat this
                  </div>
                  <div className="mt-1">
                    {cascadeFailed.length} material(s) took the stock but their weighted average price did not recompute, so their
                    cost is stale until the next purchase or a manual re-cost. Recipe costs built on them are stale too.
                  </div>
                  <div className="mt-1 text-[10px]">{cascadeFailed.join(', ')}</div>
                </div>
              )}

              <div className="text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
                The receipt has left the Pending Quality Checks queue and can no longer be signed off. If the goods do turn out to be
                bad, this is now a <b>vendor return</b> or a back-correction GRN — not a rejection, because the delivery was accepted.
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2 shrink-0">
          {!result ? (
            <>
              <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
              <button onClick={submit} disabled={busy || !reasonOk}
                      title={reasonOk ? 'Add the stock now and mark the bill permanently' : 'Write the reason first'}
                      className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-sm rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />}
                {busy ? 'Releasing…' : 'Release & add stock'}
              </button>
            </>
          ) : (
            <button onClick={onDone} className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg">Done</button>
          )}
        </div>
      </div>
    </div>
  );
}
