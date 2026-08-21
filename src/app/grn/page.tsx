'use client';

/**
 * Goods Receipt Notes (GRN) — Phase 1 §5 page.
 * Listing + drill-down detail. GRNs are auto-created on PO receive.
 */

import { useEffect, useMemo, useState, Fragment, type ReactNode } from 'react';
import { FileCheck, ChevronDown, ChevronRight, Loader2, Plus, Trash2, X, Save, Download, Percent,
         Eye, Pencil, Printer, AlertTriangle } from 'lucide-react';
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

interface GRN {
  id: string; grn_number: string; date: string; time?: string;
  po_id?: string; po_number?: string;
  vendor_id?: string; vendor?: string;
  invoice_number?: string; invoice_date?: string;
  received_by?: string; qc_by?: string;
  /** 'void' = the bill was cancelled and the stock it added was reversed. The
   *  DOCUMENT is kept (header + line items) — see DELETE /api/grn/[id]. */
  status: 'received' | 'partial' | 'rejected' | 'void';
  notes?: string;
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
  partial:  'bg-amber-100 text-amber-800 border-amber-200',
  rejected: 'bg-red-100 text-red-700 border-red-200',
  // Deliberately NOT a status colour — a void is not a grade of receipt. Slate
  // on the page's own muted palette, so it reads as "withdrawn", and the row
  // around it is greyed + struck through.
  void:     'bg-[#EFE7DE] text-[#6B5744] border-[#B8A590] line-through',
};

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
    const c = { received: 0, partial: 0, rejected: 0, void: 0, accepted_value: 0 };
    for (const g of list) {
      c[g.status] = (c[g.status] || 0) + 1;
      // A VOIDED bill's stock and cost rows have been reversed — its value is no
      // longer money this kitchen received. Counting it here would restate the
      // period's inward total upwards for ever. It keeps its own counter instead,
      // so the bills are still visibly accounted for rather than vanishing.
      if (g.status !== 'void') c.accepted_value += g.accepted_value || 0;
    }
    return c;
  }, [list]);

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
      {creating && <AdHocGrnModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); reload(); }} />}
      {/* Mounted at PAGE level, not inside the row: the row lives in a table with
          `overflow-x-auto` on its wrapper, and a fixed overlay rendered inside a
          scroll container is clipped by it on some browsers. */}
      {editing && canAmend === true && <EditBillModal g={editing} onClose={() => setEditing(null)}
                                 onSaved={() => { setEditing(null); afterWrite(); }} />}
      {voiding && isAdmin === true && (
        <VoidBillModal g={voiding} onClose={() => setVoiding(null)}
                       onVoided={() => { setVoiding(null); afterWrite(); }} />
      )}

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
          {(['', 'received', 'partial', 'rejected', 'void'] as const).map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
                    className={`px-2 py-0.5 rounded border ${statusFilter === s ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}>
              {s || 'All'}
            </button>
          ))}
        </div>
        <div className="ml-auto text-[#6B5744] flex gap-3 flex-wrap">
          <span>✓ {counts.received}</span>
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
                        onEdit={() => setEditing(g)} onVoid={() => setVoiding(g)} />
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
  // A PO-SOURCED GRN CAN NEVER BE VOIDED — the server refuses it outright (a
  // voided GRN whose lines are kept would permanently block re-receiving that
  // PO). On the live data that is most of the register, so the control is shown
  // DISABLED with the reason in its tooltip rather than live: leaving it live
  // made the admin type a mandatory reason and press "Reverse stock & void"
  // before finding out, and hiding it entirely would leave them wondering why
  // this row has no Delete when the next one does. `g.po_id` is already on the
  // row, so this needs no extra read.
  if (!isVoid && isAdmin === true) acts.push({
    key: 'void', label: 'Delete',
    title: g.po_id
      ? `Cannot be deleted: ${g.grn_number} was received against ${g.po_number || 'a purchase order'}. Voiding it would have to reopen the PO and remove its vendor bill row, and its kept lines would block re-receiving. Raise a vendor return, or book a back-correction GRN.`
      : 'Delete this bill — reverses the stock it added and marks it void (admin only)',
    icon: <Trash2 className={sz} />, danger: true, onClick: onVoid,
    disabled: !!g.po_id,
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

function GrnRow({ g, expanded, onToggle, isAdmin, canAmend, dataVersion, onEdit, onVoid }: {
  g: GRN; expanded: boolean; onToggle: () => void;
  isAdmin: boolean | null; canAmend: boolean | null; dataVersion: number;
  onEdit: () => void; onVoid: () => void;
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

  return (
    <>
      <tr className={`border-t border-[#E8D5C4]/50 ${isVoid ? 'bg-[#F3EEE7]/60 text-[#8B7355]' : 'hover:bg-[#FFF8F0]/40'}`}>
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
        <td className={`py-2 px-3 text-right font-mono font-semibold ${strike}`}>{fmt(g.accepted_value || 0)}</td>
        <td className={`py-2 px-3 text-right font-mono font-semibold ${isVoid ? 'text-[#8B7355]' : 'text-[#af4408]'} ${strike}`}>{g.inward_value ? fmt(g.inward_value) : '—'}</td>
        <td className="py-2 px-3">
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_TONE[g.status]}`}
                title={isVoid ? `${voidedBadgeText(g)}. The stock this bill added was reversed; the document is kept.` : undefined}>
            {g.status}
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
              {(() => {
                const checklist = [
                  ['qc_quality',       'Quality'],
                  ['qc_temperature',   'Temperature'],
                  ['qc_expiry',        'Expiry'],
                  ['qc_damage',        'No damage'],
                  ['qc_weight',        'Weight'],
                  ['qc_invoice_match', 'Invoice match'],
                ] as const;
                const tickedCount = checklist.filter(([k]) => detail[k]).length;
                return (
                  <div className="flex flex-wrap items-center gap-1.5 mb-2 text-[10px]">
                    <span className="text-[#8B7355]">QC checklist {tickedCount}/{checklist.length}:</span>
                    {checklist.map(([k, label]) => (
                      <span key={k} className={`px-1.5 py-0.5 rounded border ${
                        detail[k] ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                  : 'bg-[#FFF1E3] text-[#8B7355] border-[#E8D5C4]'
                      }`}>
                        {detail[k] ? '✓' : '○'} {label}
                      </span>
                    ))}
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
                      <td className="py-1 px-2 text-right font-mono text-emerald-700 border-l border-[#E8D5C4]">{it.quantity_accepted} <span className="text-[9px] text-[#B8A590]">{pu}</span></td>
                      <td className="py-1 px-2 text-right font-mono text-red-700">{it.quantity_rejected || 0} <span className="text-[9px] text-[#B8A590]">{pu}</span></td>
                      <td className="py-1 px-2 text-[#6B5744]">{it.rejection_reason || ''}</td>
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
  qc_by: 'QC done by', notes: 'Notes',
  qc_quality: 'QC · Quality', qc_temperature: 'QC · Temperature', qc_expiry: 'QC · Expiry',
  qc_damage: 'QC · No damage', qc_weight: 'QC · Weight', qc_invoice_match: 'QC · Invoice match',
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

  /** Is this line a store-mapped (TGBCL liquor) material — i.e. zero-rated here? */
  const storeMappedLine = (materialId: string) => {
    if (storeCats.size === 0 || !materialId) return false;
    const m = materials.find(x => x.id === materialId) as any;
    return !!m && storeCats.has(catKey(m.category));
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
          <h2 className="font-bold text-[#2D1B0E]">New Ad-hoc Goods Receipt Note</h2>
          <button onClick={onClose}><X className="w-5 h-5 text-[#8B7355]" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4 text-xs">
          <p className="text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
            Use this when goods arrive WITHOUT a PO — cash purchase, sample, donation, vendor return.
            On save: creates a GRN, writes <code>purchases</code> rows, bumps stock + recipe-cost cascade.
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

          {/* Phase 1 §4 — Receiving QC Checklist */}
          <div className="border border-blue-200 rounded-lg p-3 bg-blue-50/40">
            <div className="text-xs font-semibold text-blue-900 mb-2 flex items-center gap-2">
              ✓ Receiving Checklist
              <span className="text-[10px] font-normal text-blue-700">
                ({Object.values(qc).filter(Boolean).length} of 6 ticked)
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={qc.qc_quality} onChange={() => toggleQc('qc_quality')} className="accent-blue-600" />
                <span>Quality / Freshness</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={qc.qc_temperature} onChange={() => toggleQc('qc_temperature')} className="accent-blue-600" />
                <span>Temperature OK</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={qc.qc_expiry} onChange={() => toggleQc('qc_expiry')} className="accent-blue-600" />
                <span>Expiry date checked</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={qc.qc_damage} onChange={() => toggleQc('qc_damage')} className="accent-blue-600" />
                <span>No damage</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={qc.qc_weight} onChange={() => toggleQc('qc_weight')} className="accent-blue-600" />
                <span>Weight verified</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={qc.qc_invoice_match} onChange={() => toggleQc('qc_invoice_match')} className="accent-blue-600" />
                <span>Invoice matches</span>
              </label>
            </div>
            <div className="text-[10px] text-blue-700 mt-1.5">
              Kitchen / bar staff signs off on quality + temperature + expiry. Store manager confirms quantity + invoice match.
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
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={busy}
                  className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg flex items-center gap-1.5 disabled:opacity-50">
            <Save className="w-4 h-4" /> {busy ? 'Creating…' : 'Create GRN'}
          </button>
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
/** Only the six BOOLEAN qc ticks. Deliberately NOT `keyof BillForm`: that would
 *  let `qc_by` (a string) into the checkbox list, where it would render as a box
 *  that is permanently ticked for any non-empty name. */
type QcKey = 'qc_quality' | 'qc_temperature' | 'qc_expiry' | 'qc_damage' | 'qc_weight' | 'qc_invoice_match';
const QC_FIELDS: { k: QcKey; label: string }[] = [
  { k: 'qc_quality',       label: 'Quality / Freshness' },
  { k: 'qc_temperature',   label: 'Temperature OK' },
  { k: 'qc_expiry',        label: 'Expiry date checked' },
  { k: 'qc_damage',        label: 'No damage' },
  { k: 'qc_weight',        label: 'Weight verified' },
  { k: 'qc_invoice_match', label: 'Invoice matches' },
];
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
    (Object.keys(form) as (keyof BillForm)[]).forEach(k => {
      if (k === 'vendor' || k === 'vendor_id') return;
      if (form[k] !== loaded[k]) p[k] = form[k];
    });
    if (!isPoGrn && (form.vendor !== loaded.vendor || form.vendor_id !== loaded.vendor_id)) {
      p.vendor = form.vendor;
      p.vendor_id = form.vendor_id;
    }
    return p;
  }, [form, loaded, isPoGrn]);
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

              <div className="border border-blue-200 rounded-lg p-3 bg-blue-50/40">
                <div className="text-xs font-semibold text-blue-900 mb-2">
                  ✓ Receiving Checklist
                  <span className="ml-2 text-[10px] font-normal text-blue-700">
                    ({QC_FIELDS.filter(f => form[f.k]).length} of {QC_FIELDS.length} ticked)
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {QC_FIELDS.map(f => (
                    <label key={f.k} className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={!!form[f.k]}
                             onChange={e => set({ [f.k]: e.target.checked } as Partial<BillForm>)}
                             className="accent-blue-600" />
                      <span>{f.label}</span>
                    </label>
                  ))}
                </div>
              </div>

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
      // A refusal is the normal, designed outcome for a PO-sourced bill, one
      // dated before the store cutover, one with returns against it, or one that
      // would drive stock negative. The server's message names which and why —
      // show it verbatim rather than replacing it with "Failed".
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
                </ul>
                <div className="pt-1 border-t border-red-200">
                  It is refused — with nothing changed — if the bill came from a purchase order, belongs to another outlet than the one you are
                  working in, is dated on or before the central-store cutover, has a return ticket against it, or if reversing it would push
                  any material's stock below zero.
                </div>
              </div>

              <div className="text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
                <div><b>Vendor:</b> {g.vendor || '—'} &nbsp; <b>Bill no.:</b> {g.invoice_number || '—'}</div>
                <div><b>Receipt date:</b> {g.date} &nbsp; <b>Lines:</b> {g.line_count} &nbsp; <b>Accepted:</b> {fmt(g.accepted_value || 0)}</div>
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
