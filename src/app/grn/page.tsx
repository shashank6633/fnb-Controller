'use client';

/**
 * Goods Receipt Notes (GRN) — Phase 1 §5 page.
 * Listing + drill-down detail. GRNs are auto-created on PO receive.
 */

import { useEffect, useMemo, useState, Fragment, type ReactNode } from 'react';
import { FileCheck, ChevronDown, ChevronRight, Loader2, Plus, Trash2, X, Save, Download, Percent,
         Eye, Pencil, Printer, AlertTriangle, ChefHat, Wine, Clock, ShieldAlert, Info,
         CheckCircle2, ShieldQuestion } from 'lucide-react';
import { api } from '@/lib/api';
import { todayIST, fmtIST } from '@/lib/format-date';
import MaterialTypeahead from '@/components/MaterialTypeahead';
import Combobox from '@/components/Combobox';
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
  gst_rate: string;
  /** GST compensation cess %, seeded from raw_materials.cess_percent. */
  cess_rate: string;
  discount: string; cgst: string; sgst: string; special_excise_cess: string;
  tcs: string; delivery_charges: string; mrp_round_off: string;
}
const blankLine = (): GrnLine => ({
  material_id: '', quantity_received: '', quantity_accepted: '', rejection_reason: '', unit_price: '', notes: '',
  gst_rate: '', cess_rate: '',
  discount: '', cgst: '', sgst: '', special_excise_cess: '', tcs: '', delivery_charges: '', mrp_round_off: '',
});
const n0 = (s?: string) => { const v = Number(s); return Number.isFinite(v) ? v : 0; };
/** SUBTOTAL = inward qty × rate. */
const lineSubtotal = (l: GrnLine) => n0(l.quantity_received) * n0(l.unit_price);
/** TOTAL INWARD AMOUNT for a line (same formula the server + register use).
 *  `tax` overrides the two hand-typed ₹ boxes with the figures derived from the
 *  line's GST% — pass it wherever a rate is in play, or the screen total lags
 *  the rate the clerk just picked. Every other term is untouched.
 *  `cess` is the GST COMPENSATION CESS ₹ (lineCess().cess). It has no hand-typed
 *  box to fall back on — there is no `l.compensation_cess` — so it is always
 *  passed in or absent, and it is a SEPARATE term: never folded into cgst/sgst
 *  (that sum is a GST-return figure) and never into special_excise_cess (that
 *  column means the TGBCL levy). */
const lineTotal = (l: GrnLine, tax?: { cgst: number; sgst: number }, cess?: number) =>
  lineSubtotal(l) - n0(l.discount) + (tax ? tax.cgst : n0(l.cgst)) + (tax ? tax.sgst : n0(l.sgst))
  + (cess || 0)
  + n0(l.special_excise_cess)
  + n0(l.tcs) + n0(l.delivery_charges) + n0(l.mrp_round_off);
/** Same TOTAL formula for a saved GRN item row (server fields). */
const itemInwardTotal = (it: any) =>
  (Number(it.quantity_received) || 0) * (Number(it.unit_price) || 0)
  - (Number(it.discount) || 0) + (Number(it.cgst) || 0) + (Number(it.sgst) || 0)
  + (Number(it.compensation_cess) || 0)
  + (Number(it.special_excise_cess) || 0) + (Number(it.tcs) || 0)
  + (Number(it.delivery_charges) || 0) + (Number(it.mrp_round_off) || 0);

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
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
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

  const reload = async () => {
    setLoading(true);
    const qs = new URLSearchParams({ from, to }); if (statusFilter) qs.set('status', statusFilter);
    const d = await fetch(`/api/grn?${qs}`).then(r => r.json()).catch(() => null);
    setList(d?.grns || []);
    // Absent / non-boolean → false. The row actions fail closed on anything but
    // a literal true from a payload that actually arrived.
    setIsAdmin(d ? d.is_admin === true : null);
    setCanAmend(d ? d.can_amend === true : null);
    setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [from, to, statusFilter]);
  /** One post-write refresh path: re-read the list AND invalidate row details. */
  const afterWrite = () => { setDataVersion(v => v + 1); reload(); };

  // Download the flat inward register (one row per LINE) in the sheet's column
  // order + our extras, for the current date range + status filter.
  const [exporting, setExporting] = useState(false);
  const downloadRegister = async () => {
    setExporting(true);
    try {
      const qs = new URLSearchParams({ register: '1', from, to }); if (statusFilter) qs.set('status', statusFilter);
      const d = await fetch(`/api/grn?${qs}`).then(r => r.json());
      const rows: any[] = d.rows || [];
      if (!rows.length) { alert('No inward lines in this date range.'); return; }
      // Formula-injection guard — but only for genuinely non-numeric cells, so
      // signed numbers (negative MRP round-off, back-correction qtys/totals)
      // stay as real numbers Excel can sum (not text). Number('') is 0 → fine.
      const clean = (v: any) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s) && !Number.isFinite(Number(s))) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      // COMPENSATION CESS sits between SGST and SPECIAL EXCISE CESS — the order
      // db.ts's Total Inward term list uses. The two "cess" columns are different
      // levies and must never be read as one: COMPENSATION CESS is the GST-regime
      // cess (raw_materials.cess_percent, charged on the gross line value before
      // discount), SPECIAL EXCISE CESS is the TGBCL liquor levy off the store bill.
      const header = ['GRN No.', 'INVOICE ID', 'INWARD DATE', 'SUPPLIER NAME', 'CATEGORY NAME', 'ITEM NAME',
        'PO QTY', 'INWARD QTY', 'PURCHASE UNIT', 'RATE', 'SUBTOTAL', 'DISCOUNT', 'CGST', 'SGST',
        'COMPENSATION CESS', 'SPECIAL EXCISE CESS', 'TCS', 'DELIVERY CHARGES', 'MRP ROUND OFF', 'TOTAL INWARD AMOUNT',
        'ACCEPTED QTY', 'REJECTED QTY', 'REJECT REASON', 'STATUS', 'RECEIVED BY', 'INVOICE DATE'];
      const lines = [header.join(',')];
      for (const r of rows) lines.push([
        r.grn_number, r.invoice_number, r.inward_date, r.supplier, r.category_name, r.item_name,
        r.po_qty, r.inward_qty, r.purchase_unit, r.rate, r.subtotal, r.discount, r.cgst, r.sgst,
        r.compensation_cess, r.special_excise_cess, r.tcs, r.delivery_charges, r.mrp_round_off, r.total_inward_amount,
        r.quantity_accepted, r.quantity_rejected, r.rejection_reason, r.status, r.received_by, r.invoice_date,
      ].map(clean).join(','));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `GRN-inward-register-${from}_to_${to}.csv`;
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
            Every PO receive creates a GRN. Each line records ordered / received / accepted / rejected with a reason. Use <em>Ad-hoc GRN</em> for receipts without a parent PO (cash buy, sample, donation).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={downloadRegister} disabled={exporting}
                  title="Download the inward register (one row per line, sheet column order) as CSV/Excel. Voided bills are left out — their stock and cost were reversed, so counting them would overstate the period. Pick the 'void' filter to export those on their own."
                  className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm flex items-center gap-2 disabled:opacity-50">
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Inward Register
          </button>
          <button onClick={() => setCreating(true)}
                  className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-2">
            <Plus className="w-4 h-4" /> New Ad-hoc GRN
          </button>
        </div>
      </div>
      {/* afterWrite(), not a bare reload(): a new GRN can have been HELD, which
          changes the Pending Quality Checks context this page now reads (the
          wait clock, the overdue flag, the queue size). Bumping dataVersion is
          what re-reads it — and it also drops any cached row detail, which was
          always the right thing to do after a write. */}
      {creating && <AdHocGrnModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); afterWrite(); }} />}
      {/* Mounted at PAGE level, not inside the row: the row lives in a table with
          `overflow-x-auto` on its wrapper, and a fixed overlay rendered inside a
          scroll container is clipped by it on some browsers. */}
      {editing && canAmend === true && <EditBillModal g={editing} onClose={() => setEditing(null)}
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
                    on screen — the date filter can hide a held delivery, and a
                    store person who cleared their own range should still learn
                    that three more are waiting outside it. */}
                {qcCtx && qcCtx.pending > heldHere.length && (
                  <div className="mt-0.5 opacity-80">
                    {qcCtx.pending} are waiting in total at this outlet — {qcCtx.pending - heldHere.length} of them outside the dates filtered above.
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
        <div className="ml-auto text-[#6B5744] flex gap-3 flex-wrap">
          <span>✓ {counts.received}</span>
          {counts.awaiting_qc > 0 && (
            // Sits FIRST among the exception counters and carries its own ₹,
            // because "waiting" is money at the bay, not a grade of receipt —
            // and Σ accepted beside it deliberately excludes every rupee of it.
            <span className="text-blue-800" title="Recorded, waiting for a kitchen / bar check. No stock has been added for these, so they contribute ₹0 to Σ accepted — the figure here is the BILL value sitting at the bay.">
              ⏱ {counts.awaiting_qc} awaiting QC · <b className="font-mono">{fmt(counts.awaiting_value)}</b>
            </span>
          )}
          <span className="text-amber-700">⚠ {counts.partial}</span>
          <span className="text-red-700">✗ {counts.rejected}</span>
          {counts.void > 0 && <span className="text-[#8B7355]" title="Voided bills — their stock and cost rows were reversed, so they are excluded from the Σ beside this AND from the Inward Register download. Pick the 'void' filter to list them, or use a row's own Download to get one.">⊘ {counts.void} void</span>}
          <span title="Accepted value of the NON-VOID bills in this range.">Σ accepted: <b className="font-mono">{fmt(counts.accepted_value)}</b></span>
        </div>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
        ) : list.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#8B7355]">No GRNs in this range. They're created automatically when you receive a PO.</div>
        ) : (
          <div className="overflow-x-auto">
          {/* min-w grows with the column count — the wrapper scrolls horizontally
              rather than letting a 13th column squeeze the others into wrapping.
              Widened from 980 when the trailing cell went from one "Print" link
              to a five-icon action group; under-size it and the group wraps onto
              two rows and every row grows a second line. */}
          <table className="w-full text-xs min-w-[1150px]">
            <thead className="bg-[#FFF1E3] text-[#6B5744]">
              <tr>
                <th className="w-6"></th>
                <th className="text-left py-1.5 px-3 font-medium">GRN #</th>
                <th className="text-left py-1.5 px-3 font-medium">Date</th>
                <th className="text-left py-1.5 px-3 font-medium">Vendor</th>
                <th className="text-left py-1.5 px-3 font-medium">Bill No.</th>
                <th className="text-left py-1.5 px-3 font-medium">Linked PO</th>
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
  if (!isVoid && canAmend === true) acts.push({
    key: 'edit', label: 'Edit',
    title: 'Amend the bill details (invoice no., invoice date, vendor, QC, notes). Quantities and rates are not amendable — the amendment is recorded.',
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
        <td className="py-2 px-3 font-mono">{g.po_number ? <a href="/purchase-orders" className={`text-[#af4408] hover:underline ${strike}`}>{g.po_number}</a> : <span className="text-[#8B7355]">—</span>}</td>
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
   *   · a rate that is not in GST_RATES (say 7) returns '' rather than a value
   *     matching no <option> — React renders the select blank, the clerk reads
   *     0%, and the calc books 7%.
   * '' here means MANUAL (type the ₹ yourself), not "inherit" — this form has no
   * bill-level rate, so an unseeded line behaves exactly as it does today.
   */
  const seedGstForMaterial = (materialId: string): string => {
    if (!materialId) return '';
    if (storeMappedLine(materialId)) return '';
    const m = materials.find(x => x.id === materialId) as any;
    const t = Number(m?.tax_percent) || 0;
    if (t <= 0) return '';
    const s = String(t);
    return (GST_RATES as readonly string[]).includes(s) ? s : '';
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
  const lineTax = (l: GrnLine) => {
    const derived = l.gst_rate !== '' && !storeMappedLine(l.material_id);
    const qa = l.quantity_accepted !== '' ? n0(l.quantity_accepted) : n0(l.quantity_received);
    const q = qa > 0 ? qa : 0;
    const taxable = r2(q * n0(l.unit_price) - n0(l.discount));
    if (!derived) return { rate: 0, taxable, tax: 0, cgst: n0(l.cgst), sgst: n0(l.sgst), derived };
    const rate = parseFloat(l.gst_rate) || 0;
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
    const keep = !(cur.gst_rate === '' || cur.gst_rate === prevSeed)
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
    if (isAdjustment && !adjustmentRef.trim()) {
      alert('Back-correction mode: enter the prior GRN# / PO# / invoice# you\'re correcting (for audit).');
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
      const r = await api('/api/grn', {
        method: 'POST',
        body: {
          date, vendor_id: vendorId || null, vendor, invoice_number: invoice, invoice_date: invoiceDate,
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
          items: cleaned.map(i => ({
            material_id: i.material_id,
            quantity_received: parseFloat(i.quantity_received),
            quantity_accepted: i.quantity_accepted ? parseFloat(i.quantity_accepted) : parseFloat(i.quantity_received),
            rejection_reason:  i.rejection_reason,
            unit_price:        parseFloat(i.unit_price) || 0,
            notes:             i.notes,
            // The RATE rides along so the server can re-derive the split and be
            // the authority (as /api/purchases and PO Receive already are).
            // undefined on a Manual line → the server keeps the hand-typed ₹.
            gst_rate:            i.gst_rate === '' ? undefined : Number(i.gst_rate),
            // The COMPENSATION CESS % rides along the same way, and ONLY the
            // percent does: no compensation_cess ₹ figure is sent. Unlike
            // cgst/sgst there is no legacy client posting one, so the server is
            // the sole author of that rupee and no payload can write money this
            // line's goods value cannot justify. undefined → no cess on the line.
            cess_rate:           i.cess_rate === '' ? undefined : Number(i.cess_rate),
            // GRN Inward per-line charges (₹). Blank → 0 on the server.
            // cgst/sgst come from lineTax so what was on screen is what is sent —
            // on a rated line these are DERIVED, never the stale box contents.
            discount:            n0(i.discount),
            cgst:                lineTax(i).cgst,
            sgst:                lineTax(i).sgst,
            special_excise_cess: n0(i.special_excise_cess),
            tcs:                 n0(i.tcs),
            delivery_charges:    n0(i.delivery_charges),
            mrp_round_off:       n0(i.mrp_round_off),
          })),
        },
      });
      const j = await r.json();
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
      alert(`✓ Created ${j.grn_number} — ${j.materials_touched} material(s) updated`);
      onCreated();
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      {/* House safe-modal shell: the card is capped to the viewport and the BODY
          scrolls internally, so the header + Save/Cancel footer are always on
          screen (previously the card grew to ~1400px and Save sat far below the
          fold on phones). The MaterialTypeahead dropdown lives inside the
          scrollable body — its absolute panel extends the body's scroll area,
          so it stays reachable. */}
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-4xl shadow-xl flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <h2 className="font-bold text-[#2D1B0E]">
            {held ? `Recorded — ${held.grn_number}`
              : undecided ? `Received — ${undecided.grn_number}`
              : 'New Ad-hoc Goods Receipt Note'}
          </h2>
          {/* Both result panels close through onCreated: the receipt exists and
              the list behind must be refetched either way. */}
          <button onClick={held || undecided ? onCreated : onClose}><X className="w-5 h-5 text-[#8B7355]" /></button>
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
              {Array.isArray(held.store_blocked) && held.store_blocked.length > 0 && (
                <div className="text-[11px] text-amber-900 bg-amber-50 border border-amber-300 rounded p-2">
                  {held.store_blocked.length} line(s) were not receivable here at all (liquor is procured on the store ledger)
                  and were left out of this bill.
                </div>
              )}
            </div>

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
              </div>
            </div>

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
        ) : (
          <>
          <p className="text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
            Use this when goods arrive WITHOUT a PO — cash purchase, sample, donation, vendor return.
            On save: creates a GRN, writes <code>purchases</code> rows, bumps stock + recipe-cost cascade.
            {/* Stated in the same breath as "bumps stock", because on a gated
                delivery that sentence is not true and this is where the reader
                is being told what Save does. */}
            {' '}Perishable categories are the exception: those are recorded and <b>held until the kitchen checks them</b>.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label className="flex flex-col gap-1 text-[#6B5744]">Receipt Date
              <input type="date" value={date} onChange={e => setDate(e.target.value)} min={dateMin} max={dateMax} className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
              {!isAdmin && (
                <span className="text-[10px] text-[#8B7355]">Backdating limited to {backdateLimit} day(s) (admins exempt)</span>
              )}
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
              Vendor Invoice No <span className="text-red-600">*</span>
              <input value={invoice} onChange={e => setInvoice(e.target.value)} required
                     placeholder="the number printed on the vendor's bill"
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
            </label>
            <label className="flex flex-col gap-1 text-[#6B5744]">Invoice Date
              <input type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
            </label>
          </div>

          {/* Back-correction toggle. Default OFF. Lets the store manager book
              negative-qty lines to fix a prior GRN where they forgot to subtract.
              When ON, qty inputs lose the min=0 constraint and a clear amber
              banner shows on the modal. */}
          <div className={`border rounded-lg p-3 ${isAdjustment ? 'border-amber-300 bg-amber-50/60' : 'border-[#E8D5C4] bg-[#FFF8F0]/40'}`}>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={isAdjustment} onChange={e => { setIsAdjustment(e.target.checked); if (!e.target.checked) setAdjustmentRef(''); }}
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
                    // Display-only hint: the raw input string is never touched here
                    // (running it through Number() on every keystroke is what made
                    // "2." untypeable), we only read it to render "= N g".
                    const hint = (raw: string) => {
                      if (lu.pf <= 1) return null;
                      const q = parseFloat(raw);
                      if (!Number.isFinite(q) || q === 0) return null;
                      return `= ${fmtQtyNum(q * lu.pf)} ${lu.ru}`;
                    };
                    return (
                    <Fragment key={i}>
                    <tr className="border-t border-[#E8D5C4]/50 align-top block md:table-row rounded-lg border border-[#E8D5C4] p-3 mb-2 space-y-2 md:p-0 md:mb-0 md:border-0 md:space-y-0">
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Material</span>
                        <MaterialTypeahead
                          materials={filteredMaterials as any} purchaseBasis
                          value={it.material_id}
                          onPick={(id) => pickMaterial(i, id)}
                          excludeIds={items.map(x => x.material_id).filter((id, idx) => id && idx !== i) as string[]}
                        />
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
                            {lu.pu}{hint(it.quantity_received) ? <> · {hint(it.quantity_received)}</> : null}
                          </div>
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
                            {lu.pu}{hint(it.quantity_accepted) ? <> · {hint(it.quantity_accepted)}</> : null}
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
                            division happens server-side; never type ₹/g here. */}
                        {lu.pu && <div className="text-[9px] text-[#B8A590] text-right mt-0.5 md:w-20">₹ / {lu.pu}</div>}</td>
                      <td className="py-1 px-2 text-right block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Charges / Total</span>
                        <div className="flex items-center justify-end gap-1.5">
                          {/* The charges panel is collapsed by default, so a rate
                              seeded from the master would otherwise change the row
                              total with nothing on screen explaining it. */}
                          {it.gst_rate !== '' && !storeMappedLine(it.material_id) && (
                            <span className="px-1.5 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-800 text-[10px] font-semibold"
                                  title="GST% on this line — from the material master, editable in the charges panel">
                              GST {it.gst_rate}%
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
                          <span className="font-mono font-semibold text-[#2D1B0E] min-w-[64px] text-right">
                            {(n0(it.quantity_received) && n0(it.unit_price)) ? `₹${lineTotal(it, lineTax(it), lineCess(it).cess).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
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
                                const tx = lineTax(it);
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
                                              title="Seeded from the material master (raw_materials.tax_percent). Change it for a line the vendor billed at a different rate; Manual lets you type the ₹ yourself."
                                              className="px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs bg-white text-[#2D1B0E] normal-case">
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
                                </label>
                                </Fragment>
                              ); })}
                            </div>
                            <div className="flex flex-wrap justify-end gap-4 mt-2 text-[11px] text-[#6B5744]">
                              <span>Subtotal <b className="text-[#2D1B0E] font-mono">₹{lineSubtotal(it).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</b></span>
                              {lineTax(it).derived && (
                                // Named explicitly because it is NOT the Subtotal beside it:
                                // tax rides on the ACCEPTED qty (what PO Receive books), so on a
                                // partially-rejected line the two figures legitimately differ.
                                <span title="GST is charged on the accepted quantity, after discount — the same base the PO → Receive path uses.">
                                  Taxable (accepted, after discount) <b className="text-[#2D1B0E] font-mono">₹{lineTax(it).taxable.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
                                </span>
                              )}
                              {lineCess(it).derived && (
                                // Printed BESIDE the taxable figure, not instead of it,
                                // because on a discounted line the two are DIFFERENT
                                // numbers and that is deliberate: cess is charged on the
                                // gross, GST after the discount. Shown side by side so a
                                // reader checking the bill sees the rule rather than a bug.
                                <span title="Compensation cess is charged on the accepted quantity BEFORE the discount — a different base from GST, on purpose.">
                                  Cess base (accepted, before discount) <b className="text-[#2D1B0E] font-mono">₹{lineCess(it).base.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
                                </span>
                              )}
                              <span>Total Inward <b className="text-[#af4408] font-mono">₹{lineTotal(it, lineTax(it), lineCess(it).cess).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</b></span>
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
                  const totInward = items.reduce((s, ln) => s + (ln.material_id ? lineTotal(ln, lineTax(ln), lineCess(ln).cess) : 0), 0);
                  const lineCount = filled.length;
                  if (lineCount === 0) return null;
                  // A qty total only exists when every filled line is in the SAME
                  // purchase unit. 12 BTL + 3 kg is not 15 of anything — print an
                  // em-dash and keep the ₹ total, which is always addable.
                  const units = new Set(filled.map(ln => lineUnits(ln.material_id).pu.toLowerCase().trim()).filter(Boolean));
                  const oneUnit = units.size === 1 ? lineUnits(filled[0].material_id).pu : null;
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
          ) : (
            <>
              <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
              <button onClick={submit}
                      disabled={busy || qcPreRejectLines.length > 0
                        || (qcPreview.known && qcPreview.required && qcPreview.backCorrection)}
                      title={qcPreRejectLines.length > 0
                        ? 'A held delivery\'s accepted quantity is the checking department\'s to record — enter what actually arrived as Received instead.'
                        : (qcPreview.known && qcPreview.required && qcPreview.backCorrection)
                          ? 'A back-correction and a held delivery cannot share one receipt — save them separately.'
                          : qcPreview.required
                            ? `This will be recorded and held for a ${CHECKER_LABEL[qcPreview.checker]} check — no stock will be added until they sign.`
                            : 'Create the goods receipt note'}
                      className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                <Save className="w-4 h-4" />
                {/* The button says what it is about to DO. "Create GRN" on a
                    delivery that will move no stock is the promise this whole
                    feature exists to stop making. */}
                {busy ? 'Creating…' : qcPreview.required ? 'Create & send for QC' : 'Create GRN'}
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

function EditBillModal({ g, onClose, onSaved }: { g: GRN; onClose: () => void; onSaved: () => void }) {
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
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [vendors, setVendors] = useState<any[]>([]);

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
      })
      .catch(e => { if (alive) setLoadErr(e?.message || 'Could not load this bill.'); });
    return () => { alive = false; };
  }, [g.id]);

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

  const submit = async () => {
    if (!form || !patch || !dirty) return;
    // Mirrors the server's own refusal rather than replacing it — the point is
    // an instant answer, not a second authority. The bill number is the only way
    // back to the vendor's paperwork months later, and the duplicate-bill guard
    // skips any row whose bill_no is blank, so clearing it does not merely lose
    // a reference: it switches that guard off for this bill's cost rows.
    if ('invoice_number' in patch && !String(patch.invoice_number).trim()) {
      setErr('Vendor invoice / bill number is required — an amendment cannot remove the only link back to the vendor\'s paperwork.');
      return;
    }
    setBusy(true); setErr(''); setWarnings([]);
    try {
      const res = await api(`/api/grn/${encodeURIComponent(g.id)}`, {
        method: 'PUT',
        // The reason is free text and rides into the audit note. It is not a
        // field of the bill, so it is sent alongside the patch, never inside it.
        body: { ...patch, ...(reason.trim() ? { edit_reason: reason.trim() } : {}) },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j?.error || `Amend failed (HTTP ${res.status})`); return; }
      // A warning is not a failure: the amendment COMMITTED. Hold the modal open
      // so the message is read rather than flashed away by a reload — the one
      // that matters says the duplicate-bill guard is still blind for a legacy
      // receipt's cost rows, which the user has to know to act on.
      if (Array.isArray(j?.warnings) && j.warnings.length > 0) {
        setWarnings(j.warnings);
        setLoaded(form);          // saved — this is the new baseline, so Save greys out
        return;
      }
      onSaved();
    } catch (e: any) {
      setErr(e?.message || 'Amend failed');
    } finally { setBusy(false); }
  };

  const fieldCls = 'px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] disabled:bg-[#F3EEE7] disabled:text-[#8B7355]';

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl shadow-xl flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <h2 className="font-bold text-[#2D1B0E] truncate">Edit bill — {g.grn_number}</h2>
            <p className="text-[10px] text-[#8B7355]">The amendment is recorded: who, when and what changed.</p>
          </div>
          <button onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-[#8B7355]" /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4 text-xs">
          {loadErr ? (
            <div className="text-red-700 flex items-start gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" /> {loadErr}</div>
          ) : !form ? (
            <div className="text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading the bill…</div>
          ) : (
            <>
              {/* Said UP FRONT, where the reader looks for the fields that are
                  missing — an amend form that silently lacks Date and Line Items
                  reads as broken rather than as deliberate. */}
              <p className="text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
                Only the bill's <b>paperwork</b> can be amended here — nothing below moves stock or money.
                The <b>receipt date</b> and the <b>line items</b> are not amendable: they are the stock movement itself,
                and they are the valuation date and quantities every cost row and recipe cost was built from.
                To change either, delete this bill (which reverses its stock) and record it again.
              </p>

              {err && (
                <div className="text-red-700 bg-red-50 border border-red-200 rounded p-2 flex items-start gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> <span>{err}</span>
                </div>
              )}
              {warnings.length > 0 && (
                <div className="text-amber-900 bg-amber-50 border border-amber-300 rounded p-2 space-y-1">
                  <div className="font-semibold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> Saved, with a caveat</div>
                  {warnings.map((w, i) => <div key={i}>{w}</div>)}
                  <div className="pt-1">
                    <button onClick={onSaved} className="px-2 py-1 rounded bg-[#af4408] hover:bg-[#8a3506] text-white">Got it</button>
                  </div>
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

              <label className="flex flex-col gap-1 text-[#6B5744]">
                Why is this being amended? <span className="text-[10px] text-[#8B7355]">(optional — goes into the audit trail, not onto the bill)</span>
                <input value={reason} onChange={e => setReason(e.target.value)}
                       placeholder="e.g. bill number was mistyped at the receiving bay"
                       className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
              </label>

              {/* What is about to be recorded, before it is recorded. */}
              <div className="text-[10px] text-[#8B7355]">
                {dirty
                  ? <>Will be recorded as an amendment to <b>{Object.keys(patch || {}).map(k => FIELD_LABEL[k] || k).join(', ')}</b> by you, stamped with the time. Admins see an “edited” marker on this row afterwards.</>
                  : <>Nothing changed yet.</>}
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={busy || !dirty || !!loadErr}
                  title={dirty ? 'Save the amendment' : 'Change something first'}
                  className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {busy ? 'Saving…' : 'Save amendment'}
          </button>
        </div>
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
