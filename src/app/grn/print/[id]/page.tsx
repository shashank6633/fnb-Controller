'use client';

/**
 * Printable GRN view — Phase 1 §5 "Receiver Signature" requirement.
 * Single A4-formatted page with all GRN fields, line items, QC checklist
 * and signature blocks. Suitable for physical filing.
 *
 * Triggered via window.print() automatically on first load (with a 600ms
 * delay so layout settles).
 */

import { use, useEffect, useState } from 'react';
import { Loader2, Printer } from 'lucide-react';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');

interface GrnItem {
  id: string; material_id: string; material_name: string; material_sku?: string; material_unit: string;
  pack_size?: number; purchase_unit?: string; material_category?: string;
  quantity_ordered: number; quantity_received: number;
  quantity_accepted: number; quantity_rejected: number; rejection_reason?: string;
  unit_price: number; notes?: string;
  // GRN Inward per-line charges (₹) + computed subtotal / total.
  discount?: number; cgst?: number; sgst?: number; special_excise_cess?: number;
  tcs?: number; delivery_charges?: number; mrp_round_off?: number;
  // 8th charge — GST compensation cess, seeded from raw_materials.cess_percent.
  // A SEPARATE levy from the two above it, on two counts: it is never halved
  // into cgst/sgst (tax_value === cgst + sgst stays a GST-only invariant), and
  // it is not the TGBCL special_excise_cess this note already prints as "Cess".
  compensation_cess?: number;
  subtotal?: number; total_inward_amount?: number;
}
/** Sum the per-line charges (₹) for a compact print sub-line. */
const chargeParts = (it: GrnItem): string => {
  const parts: string[] = [];
  const add = (label: string, v?: number) => { if (Number(v)) parts.push(`${label} ${Math.round((Number(v) || 0) * 100) / 100}`); };
  // These are RECORDED rupees read straight off the GRN line — this page computes
  // no tax base of its own, and must not, because the two levies do not share one.
  // GST is charged on the POST-discount line value; compensation cess is charged
  // on the GROSS line value BEFORE discount (owner's ruling: 10 kg @ ₹100 less ₹100
  // discount → GST 18% on ₹900 = ₹162, cess 12% on ₹1,000 = ₹120). So CGST+SGST and
  // Comp. Cess here will NOT reconcile to a single base — do not "simplify" them
  // into one, and do not derive either from subtotal.
  add('Disc', it.discount); add('CGST', it.cgst); add('SGST', it.sgst);
  // Comp. Cess sits beside the GST pair it accompanies and ahead of the TGBCL
  // "Cess", whose label is left untouched so existing notes reprint byte-identical.
  add('Comp. Cess', it.compensation_cess);
  add('Cess', it.special_excise_cess); add('TCS', it.tcs);
  add('Deliv', it.delivery_charges); add('Round', it.mrp_round_off);
  return parts.join(' · ');
};
interface Grn {
  id: string; grn_number: string; date: string; time?: string;
  po_id?: string; po_number?: string;
  vendor_id?: string; vendor: string;
  invoice_number?: string; invoice_date?: string;
  received_by?: string; qc_by?: string;
  status: string; notes?: string;
  qc_quality?: number; qc_temperature?: number; qc_expiry?: number;
  qc_damage?: number; qc_weight?: number; qc_invoice_match?: number;
  /* Kitchen QC gate (src/lib/grn-qc.ts). status 'awaiting_qc' means RECORDED BUT
     NOT INWARDED — the goods are on the shelf and not on the book. Shipped by
     /api/grn to every reader, like the void stamps, because it is a fact about
     the document rather than an admin secret. */
  qc_required?: number; qc_checker?: string; qc_outcome?: string;
  qc_kitchen_by?: string; qc_kitchen_at?: string | null;
  qc_store_by?: string; qc_store_at?: string | null;
  qc_override_by?: string; qc_override_at?: string | null; qc_override_reason?: string;
  qc_applied_at?: string | null;
  /* Void stamps. Shipped by /api/grn to EVERY reader (a void is a fact about
     the document, not an admin secret), so this page always has them. */
  voided_at?: string | null; voided_by?: string | null; void_reason?: string | null;
  /* Amendment stamps. ADMIN ONLY on the wire — /api/grn strips them for
     everyone else, so on a non-admin's print they are simply absent and the
     amended-line below does not render. */
  edited_at?: string | null; edited_by?: string | null; edit_count?: number;
  items: GrnItem[];
}

/** A stored UTC stamp as the venue reads it — the same Asia/Kolkata rendering
 *  the /grn list uses, so the paper and the screen agree on when. */
const fmtIST = (v: any): string => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const d = new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
};

/* SPLIT BY WHO CAN ACTUALLY JUDGE IT — the owner's decision 4, and the same two
   groups (in the same wording) that /grn and /grn/qc render, so the paper, the
   receiving form and the sign-off screen cannot describe the checklist
   differently. One flat list of six read as one person's job, which is exactly
   the "receiver self-certifying their own receipt" this gate exists to end. */
const KITCHEN_QC_ROWS: { key: keyof Grn; label: string }[] = [
  { key: 'qc_quality',       label: 'Quality OK (look · smell · feel)' },
  { key: 'qc_temperature',   label: 'Temperature within range (cold-chain items)' },
  { key: 'qc_damage',        label: 'No visible damage / leak / pest' },
];
const STORE_QC_ROWS: { key: keyof Grn; label: string }[] = [
  { key: 'qc_expiry',        label: 'Expiry / use-by date checked' },
  { key: 'qc_weight',        label: 'Weight / count verified vs invoice' },
  { key: 'qc_invoice_match', label: 'Invoice matches PO (rate, qty, vendor)' },
];

export default function GrnPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [grn, setGrn] = useState<Grn | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/grn?id=${id}`).then(r => r.json()).then(d => {
      if (d.error) { setError(d.error); setLoading(false); return; }
      setGrn(d.grn); setLoading(false);
      setTimeout(() => window.print(), 600);
    });
  }, [id]);

  if (loading) return <div className="p-10 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14} /> Loading GRN…</div>;
  if (error)   return <div className="p-10 text-center text-sm text-red-700">{error}</div>;
  if (!grn)    return null;

  // Totals computed live from the items array (single source of truth — so
  // line edits / removals always reflect in the footer immediately).
  const totalReceived = grn.items.reduce((s, i) => s + (Number(i.quantity_received) || 0), 0);
  const totalAcceptedQty = grn.items.reduce((s, i) => s + (Number(i.quantity_accepted) || 0), 0);
  const totalRejectedQty = grn.items.reduce((s, i) => s + (Number(i.quantity_rejected) || 0), 0);
  const totalAcceptedValue = grn.items.reduce((s, i) => s + ((Number(i.quantity_accepted) || 0) * (Number(i.unit_price) || 0)), 0);
  // Total INWARD value — received × rate + charges (matches the register + list).
  const totalInward = grn.items.reduce((s, i) => s + (Number(i.total_inward_amount)
    || (Number(i.quantity_received) || 0) * (Number(i.unit_price) || 0)), 0);
  // Render negative totals with a "(back-correction)" tag so the print is
  // unambiguous and accounting can spot the adjustment row immediately.
  const hasNegative = grn.items.some(i => (Number(i.quantity_received) || 0) < 0 || (Number(i.quantity_accepted) || 0) < 0);
  // The three qty totals above add ACROSS MATERIALS, and every GRN qty is a
  // PURCHASE unit — so "15" on a GRN of 12 BTL + 3 kg is 15 of nothing. Print a
  // qty total only when the whole note is in one purchase unit; otherwise the
  // cell is an em-dash. The ₹ totals are unaffected (rupees always add).
  const noteUnits = new Set(
    grn.items.map(i => String(i.purchase_unit || i.material_unit || '').toLowerCase().trim()).filter(Boolean)
  );
  const noteUnit = noteUnits.size === 1
    ? String(grn.items[0]?.purchase_unit || grn.items[0]?.material_unit || '')
    : null;
  const qtyTotal = (v: number, dashWhenZero = false) => {
    if (dashWhenZero && !(v > 0)) return '—';
    if (!noteUnit) return '—';
    return `${v.toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${noteUnit}`;
  };

  // A VOIDED BILL MUST NOT PRINT AS A LIVE RECEIPT. Its stock was reversed and
  // its cost rows deleted, but this sheet still shows every rupee at full value
  // and carries three signature blocks — filed on paper it is indistinguishable
  // from a delivery that stands. Until now the only marker was the word "void"
  // in the small status box, in the same red as "rejected".
  const isVoid = String(grn.status).toLowerCase() === 'void';
  const editCount = Number(grn.edit_count) || 0;

  /* ── A HELD BILL MUST NOT PRINT AS A COMPLETED RECEIPT EITHER ──────────────
     Exactly the argument the VOID watermark above was built for, on the state
     that is now far more common than a void. A receipt awaiting a kitchen check
     printed: "Accepted 0" on every line, "0 kg" as the accepted total beside the
     full Grand Total Inward Value, the status "Awaiting_qc" in the SAME RED as
     "rejected" (the ternary had no branch for it), all six checkboxes blank,
     "QC verified by —", and three signature blocks. Nothing said no stock had
     been added and no kitchen had judged it — and this is the sheet that gets
     filed at the bay while the vendor is still standing there.

     AMBER, NOT RED, AND NOT THE SAME WATERMARK. A void is a cancelled document;
     a hold is a document mid-process, doing exactly what it should. Printing it
     in the red reserved for cancellation is how a storekeeper concludes they did
     something wrong and re-enters the delivery by hand. */
  const isHeld = String(grn.status).toLowerCase() === 'awaiting_qc';
  const checkerLabel = String(grn.qc_checker || '') === 'bar' ? 'Bar'
    : String(grn.qc_checker || '') === 'both' ? 'Kitchen or Bar' : 'Kitchen';
  /* The permanent "inwarded without kitchen QC" stamp (owner's decision 2). It
     must be on the paper too: this sheet is the copy an auditor reads, and
     without it a released bill is indistinguishable from a checked one. */
  const isOverride = String(grn.qc_outcome || '') === 'override';

  /* ── WHAT KIND OF DOCUMENT THIS IS ─────────────────────────────────────────
     DIRECT (no purchase order behind it) or AGAINST PO. This is the sheet that
     gets filed, and on paper the only thing that ever said which was an em-dash
     beside "PO Number" — an absence, readable only by somebody who already knew
     the convention. Now that every hand-typed vendor bill is a GRN, most filed
     sheets are direct ones, so the label has to travel with the paper.

     KEYED OFF po_id, TRIMMED — the same rule as the /grn list's isPoSourced and
     the register's BILL_TYPE_SQL, so screen, file and paper cannot disagree.
     Never off po_number: that comes from a LEFT JOIN and is blank when the order
     row is gone, which would print a PO receipt as a direct bill. */
  const poSourced = String(grn.po_id ?? '').trim() !== '';

  return (
    <div className="bg-white text-[#1a1a1a] mx-auto max-w-[820px] p-8 print:p-6 text-[12px] leading-relaxed">
      {/* Print-only stylesheet */}
      <style>{`
        @media print {
          @page { size: A4; margin: 14mm; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .no-print { display: none !important; }
          aside, nav { display: none !important; }
        }
        @media screen {
          .page { box-shadow: 0 0 0 1px #E8D5C4, 0 4px 24px rgba(0,0,0,.05); }
        }
        /* VOID WATERMARK. Positioned against .page (position:relative below) and
           pointer-events:none so it never blocks the screen copy. It has to
           survive the printer, hence print-color-adjust:exact above — without it
           browsers drop light background/colour and the sheet would print clean
           again, which is the exact failure this exists to stop. */
        .void-watermark {
          position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
          pointer-events: none; z-index: 5;
        }
        .void-watermark span {
          transform: rotate(-24deg);
          font-size: 96px; font-weight: 800; letter-spacing: .18em;
          color: rgba(190, 30, 30, .16);
          border: 8px solid rgba(190, 30, 30, .16);
          padding: .08em .18em; border-radius: 12px;
          -webkit-print-color-adjust: exact; print-color-adjust: exact;
        }
        /* HELD WATERMARK — same mechanics, deliberately different colour and
           smaller type. A hold is a document mid-process, not a cancellation:
           amber says "not finished", red would say "not valid". */
        .hold-watermark span {
          transform: rotate(-24deg);
          font-size: 62px; font-weight: 800; letter-spacing: .14em;
          color: rgba(180, 110, 10, .17);
          border: 7px solid rgba(180, 110, 10, .17);
          padding: .08em .18em; border-radius: 12px; text-align: center;
          -webkit-print-color-adjust: exact; print-color-adjust: exact;
        }
      `}</style>

      {/* Toolbar (screen only) */}
      <div className="no-print mb-4 flex items-center justify-between">
        <div className="text-xs text-[#8B7355]">Auto-print starts shortly. Use Ctrl/Cmd-P if it doesn't.</div>
        <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] text-white rounded text-xs">
          <Printer size={14} /> Print
        </button>
      </div>

      <div className="page bg-white p-2 relative">
        {isVoid && <div className="void-watermark" aria-hidden="true"><span>VOID</span></div>}
        {/* A held bill can never also be void — the sign-off's claim matches only
            status 'awaiting_qc' and the void writes 'void', so the two states are
            mutually exclusive by construction. Rendered separately anyway rather
            than as an else, so neither ever depends on the other. */}
        {isHeld && <div className="void-watermark hold-watermark" aria-hidden="true"><span>AWAITING<br />QUALITY CHECK</span></div>}
        {/* Header */}
        <div className="border-b-2 border-[#1a1a1a] pb-3 mb-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[#666]">Goods Receipt Note</div>
              <div className="text-2xl font-bold mt-1">{grn.grn_number}</div>
              {/* THE BILL TYPE, ON THE PAPER, BESIDE THE NUMBER IT DESCRIBES.
                  Drawn in ink rather than colour — solid rule for AGAINST PO,
                  dashed for DIRECT, and the word spelled out in both — so it
                  survives a mono laser printer and a photocopy, where every
                  coloured treatment on this sheet degrades to grey. It is a
                  bordered caption, not one of the banners: a direct bill is
                  perfectly normal, and a banner would read as a warning. */}
              <div className="mt-1.5">
                <span className={`inline-block px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.14em] ${
                  poSourced ? 'border border-[#1a1a1a] text-[#1a1a1a]' : 'border border-dashed border-[#555] text-[#333]'}`}>
                  {poSourced
                    ? `Against PO${grn.po_number ? ` · ${grn.po_number}` : ''}`
                    : 'Direct bill · no purchase order'}
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-widest text-[#666]">Status</div>
              {/* 'awaiting_qc' fell through this ternary into the red 'rejected'
                  branch and printed as "Awaiting_qc". Named, spaced and ambered. */}
              <div className={`text-base font-semibold capitalize mt-1 ${
                grn.status === 'received' ? 'text-emerald-700' :
                grn.status === 'partial'  ? 'text-amber-700'   :
                isHeld                    ? 'text-amber-800'   : 'text-red-700'
              }`}>{isHeld ? 'Awaiting quality check' : grn.status}</div>
            </div>
          </div>
        </div>

        {/* CANCELLED-BILL BANNER. Stated in words as well as watermarked,
            because a watermark can be missed on a photocopy and because who
            voided it, when, and why are the facts an auditor needs off the
            paper. Placed above the money so it is read before the totals. */}
        {isVoid && (
          <div className="border-2 border-red-700 bg-[#fdf2f2] px-3 py-2 mb-4 relative z-10">
            <div className="text-[13px] font-bold uppercase tracking-wide text-red-800">
              Cancelled bill — void. Not payable, not receivable.
            </div>
            <div className="text-[11px] text-[#7a1f1f] mt-0.5">
              Voided{grn.voided_by ? ` by ${grn.voided_by}` : ''}{grn.voided_at ? ` on ${fmtIST(grn.voided_at)}` : ''}
              {grn.void_reason ? ` — ${grn.void_reason}` : ''}.
            </div>
            <div className="text-[10px] text-[#7a1f1f] mt-1">
              The stock this note added has been reversed and its cost rows removed. The quantities and amounts printed below are what
              the vendor originally billed and are kept as the record of what arrived — they no longer count towards inward value, spend
              or payment. Do not sign, pay or file this as a live receipt.
            </div>
          </div>
        )}

        {/* HELD-BILL BANNER, on the same principle as the void one above: in
            words, above the money, because the watermark can be lost on a
            photocopy and because "no stock was added" is the fact somebody has
            to act on WHILE THE VENDOR IS STILL AT THE BAY. It also explains the
            zeroes in the Accepted column, which are otherwise the one reading
            that is certainly wrong. */}
        {isHeld && (
          <div className="border-2 border-amber-700 bg-[#fffaf0] px-3 py-2 mb-4 relative z-10">
            <div className="text-[13px] font-bold uppercase tracking-wide text-amber-900">
              Recorded — awaiting {checkerLabel.toLowerCase()} quality check. No stock has been added.
            </div>
            <div className="text-[11px] text-[#7a5410] mt-0.5">
              {checkerLabel} must check quality, temperature and damage and sign off before these goods enter stock.
              Keep the vendor at the bay until they do — once the check is signed the goods are ours and cannot be sent back.
            </div>
            <div className="text-[10px] text-[#7a5410] mt-1">
              <b>Accepted reads 0 on every line because nothing has been decided yet</b> — it is the absence of a decision, not a
              rejection. The quantities and amounts below are what the vendor delivered and billed. Do not file this as a completed
              receipt and do not sign the QC block: clear it at Purchasing → Pending Quality Checks first.
            </div>
          </div>
        )}

        {/* RELEASED WITHOUT A CHECK — the owner's decision 2, stamped permanently
            and therefore stamped on the paper too. Without it a bill released by
            an admin is indistinguishable on the printed sheet from one the
            kitchen actually judged. */}
        {!isVoid && isOverride && (
          <div className="border-2 border-amber-700 bg-[#fffaf0] px-3 py-2 mb-4 relative z-10">
            <div className="text-[12px] font-bold uppercase tracking-wide text-amber-900">
              Inwarded WITHOUT a kitchen quality check.
            </div>
            <div className="text-[11px] text-[#7a5410] mt-0.5">
              Released{grn.qc_override_by ? ` by ${grn.qc_override_by}` : ''}{grn.qc_override_at ? ` on ${fmtIST(grn.qc_override_at)}` : ''}
              {grn.qc_override_reason ? ` — ${grn.qc_override_reason}` : ''}.
              Nobody judged the quality, temperature or damage of these goods; the checklist below is blank because it was never filled in.
            </div>
          </div>
        )}

        {/* AMENDED-BILL LINE. edited_* only reaches an admin (the API strips the
            stamps for everyone else), which matches the owner's rule for the
            "edited" hint — but a printed copy of an amended bill must not hide
            that it was amended from the one reader who is allowed to know. */}
        {!isVoid && editCount > 0 && (
          <div className="border border-[#c9a227] bg-[#fffbe9] px-3 py-1.5 mb-4 text-[11px] text-[#6b5010] relative z-10">
            <b>Amended {editCount} time{editCount === 1 ? '' : 's'}.</b>{' '}
            Last amended{grn.edited_by ? ` by ${grn.edited_by}` : ''}{grn.edited_at ? ` on ${fmtIST(grn.edited_at)}` : ''}.
            Bill details only — quantities and rates are not amendable. The field-level trail is on the GRN row in F&amp;B Controller.
          </div>
        )}

        {/* Meta grid */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 mb-4">
          <div><span className="text-[#666]">Date:</span> <span className="font-medium">{grn.date}{grn.time ? ' ' + grn.time : ''}</span></div>
          {/* Says which of the three cases it is instead of leaving one dash to
              cover all of them: a direct bill (no order exists), a PO receipt
              (here is the order), or a PO receipt whose order record has gone —
              which is a fact worth printing, not a blank. */}
          <div><span className="text-[#666]">PO Number:</span> <span className="font-mono">
            {grn.po_number || (poSourced ? '— (order record not found)' : '— none · direct bill')}
          </span></div>
          <div><span className="text-[#666]">Vendor:</span> <span className="font-medium">{grn.vendor || '—'}</span></div>
          <div><span className="text-[#666]">Invoice:</span> <span className="font-mono">{grn.invoice_number || '—'}{grn.invoice_date ? ' · ' + grn.invoice_date : ''}</span></div>
          <div><span className="text-[#666]">Received by:</span> <span className="font-medium">{grn.received_by || '—'}</span></div>
          {/* On a held bill qc_by is blank BECAUSE NOBODY HAS CHECKED IT — a bare
              em-dash there reads as a missing entry rather than a pending one. */}
          <div><span className="text-[#666]">QC by:</span> <span className="font-medium">
            {isHeld ? <span className="text-amber-800">not checked yet — awaiting {checkerLabel.toLowerCase()}</span>
              : isOverride ? <span className="text-amber-800">nobody — released without a check</span>
              : (grn.qc_by || '—')}
          </span></div>
        </div>

        {/* Line items */}
        <table className="w-full border-collapse mb-4">
          <thead>
            <tr className="bg-[#f4ede2] text-[10px] uppercase tracking-wide text-[#555]">
              <th className="text-left  border border-[#999] py-1 px-2 w-[36px]">#</th>
              <th className="text-left  border border-[#999] py-1 px-2">Material · SKU</th>
              <th className="text-right border border-[#999] py-1 px-2">Ordered</th>
              <th className="text-right border border-[#999] py-1 px-2">Recvd</th>
              <th className="text-right border border-[#999] py-1 px-2">Accepted</th>
              <th className="text-right border border-[#999] py-1 px-2">Rejected</th>
              <th className="text-right border border-[#999] py-1 px-2">Rate</th>
              <th className="text-right border border-[#999] py-1 px-2">Total Inward</th>
            </tr>
          </thead>
          <tbody>
            {grn.items.map((it, i) => (
              <tr key={it.id} className="align-top">
                <td className="border border-[#999] py-1 px-2 text-center">{i + 1}</td>
                <td className="border border-[#999] py-1 px-2">
                  <div className="font-medium">{it.material_name}</div>
                  <div className="text-[10px] font-mono text-[#666]">{it.material_sku || '·'}</div>
                  {it.rejection_reason && (
                    <div className="text-[10px] text-red-700 mt-0.5">Reject reason: <span className="capitalize">{it.rejection_reason.replace(/_/g, ' ')}</span></div>
                  )}
                  {it.notes && <div className="text-[10px] italic text-[#666] mt-0.5">{it.notes}</div>}
                  {chargeParts(it) && <div className="text-[10px] text-[#666] mt-0.5">Charges: {chargeParts(it)}</div>}
                </td>
                {/* GRN qty columns hold the PO's numbers = PURCHASE units (kg, BTL,
                    CASE). Labelling them with the recipe unit (g, ml) read every
                    packed line pack_size× smaller than what physically arrived. */}
                <td className="border border-[#999] py-1 px-2 text-right font-mono">{it.quantity_ordered} {it.purchase_unit || it.material_unit}</td>
                <td className="border border-[#999] py-1 px-2 text-right font-mono">{it.quantity_received} {it.purchase_unit || it.material_unit}</td>
                {/* A held line stores quantity_accepted = 0 and quantity_rejected
                    = 0 deliberately — the ABSENCE of a decision. Printing "0"
                    beside a full received quantity is the one reading that is
                    certainly wrong: it says the kitchen turned everything away. */}
                <td className="border border-[#999] py-1 px-2 text-right font-mono">
                  {isHeld ? <span className="text-amber-800 text-[10px] font-sans">not decided</span>
                    : <>{it.quantity_accepted} {it.purchase_unit || it.material_unit}</>}
                </td>
                <td className="border border-[#999] py-1 px-2 text-right font-mono">
                  {isHeld ? <span className="text-amber-800 text-[10px] font-sans">not decided</span>
                    : it.quantity_rejected ? <>{it.quantity_rejected} {it.purchase_unit || it.material_unit}</> : '—'}
                </td>
                <td className="border border-[#999] py-1 px-2 text-right font-mono">{fmt(it.unit_price)}</td>
                <td className="border border-[#999] py-1 px-2 text-right font-mono">{fmt(Number(it.total_inward_amount) || (it.quantity_received * (it.unit_price || 0)))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-[#fafafa] font-semibold">
            {/* Row 1 — total quantities, aligned under each qty column. */}
            <tr>
              <td colSpan={3} className="border border-[#999] py-1 px-2 text-right">
                Totals
                {!noteUnit && <div className="text-[9px] font-normal text-[#666] normal-case">mixed purchase units — see each line</div>}
              </td>
              <td className="border border-[#999] py-1 px-2 text-right font-mono">{qtyTotal(totalReceived)}</td>
              {/* "0 kg accepted" beside the full Grand Total Inward Value below
                  was the sheet's most misleading pair of numbers on a held bill. */}
              <td className="border border-[#999] py-1 px-2 text-right font-mono">
                {isHeld ? <span className="text-amber-800 text-[10px] font-sans font-normal">not decided</span> : qtyTotal(totalAcceptedQty)}
              </td>
              <td className="border border-[#999] py-1 px-2 text-right font-mono">
                {isHeld ? <span className="text-amber-800 text-[10px] font-sans font-normal">not decided</span> : qtyTotal(totalRejectedQty, true)}
              </td>
              <td className="border border-[#999] py-1 px-2"></td>
              <td className="border border-[#999] py-1 px-2 text-right font-mono">{fmt(totalInward)}</td>
            </tr>
            {/* Row 2 — grand total inward value, full-width emphasis row. */}
            <tr className="bg-[#f4ede2]">
              <td colSpan={7} className="border border-[#999] py-1.5 px-2 text-right text-[11px] uppercase tracking-wider">
                Grand Total Inward Value
                {hasNegative && <span className="ml-2 text-amber-700 normal-case tracking-normal text-[10px]">(includes back-correction)</span>}
              </td>
              <td className="border border-[#999] py-1.5 px-2 text-right font-mono text-[13px]">{fmt(totalInward)}</td>
            </tr>
          </tfoot>
        </table>

        {/* QC CHECKLIST — TWO OWNERS, NOT ONE LIST (owner's decision 4).
            Whose signature each half is, printed as the heading, plus who
            actually signed it and when. One undifferentiated list of six is how
            "a receiver self-certifying their own receipt" reads on paper. */}
        <div className="mb-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          {([
            { title: `${checkerLabel} — quality of the goods`, rows: KITCHEN_QC_ROWS,
              by: grn.qc_kitchen_by || (isOverride ? '' : grn.qc_by), at: grn.qc_kitchen_at,
              pending: isHeld,
              blankNote: isHeld
                ? 'Not checked yet — these three are the checking department\'s to tick at sign-off.'
                : isOverride
                  ? 'Left blank on purpose: this bill was released without a check.'
                  : '' },
            { title: 'Receiving desk — the paperwork', rows: STORE_QC_ROWS,
              by: grn.qc_store_by, at: grn.qc_store_at,
              pending: false,
              // The PO receive route presents no store checklist at all, so a
              // blank here is "not asked", never "failed". Saying which is the
              // difference between a document and an accusation.
              blankNote: 'Blank means these were not recorded at the bay, not that they failed.' },
          ]).map((grp, gi) => (
            <div key={gi}>
              <div className="text-[11px] uppercase tracking-wide text-[#555] font-semibold mb-1">{grp.title}</div>
              <table className="w-full border-collapse">
                <tbody>
                  {grp.rows.map((q, i) => (
                    <tr key={q.key as string} className={i % 2 ? 'bg-[#fafafa]' : ''}>
                      <td className="border border-[#ccc] py-1 px-2 w-[28px] text-center">
                        <span className="inline-block w-3.5 h-3.5 border border-[#666] text-[10px] leading-[14px] text-center">
                          {(grn as any)[q.key] ? '✓' : ''}
                        </span>
                      </td>
                      <td className="border border-[#ccc] py-1 px-2 text-[11px]">{q.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className={`text-[10px] mt-1 ${grp.pending ? 'text-amber-800' : 'text-[#888]'}`}>
                {grp.by
                  ? <>Signed by <b>{grp.by}</b>{grp.at ? ` · ${fmtIST(grp.at)}` : ''}</>
                  : (grp.blankNote || 'Not signed.')}
              </div>
            </div>
          ))}
        </div>

        {grn.notes && (
          <div className="mb-4">
            <div className="text-[11px] uppercase tracking-wide text-[#555] font-semibold mb-1">Notes</div>
            <div className="border border-[#ccc] p-2 text-[11px] whitespace-pre-wrap">{grn.notes}</div>
          </div>
        )}

        {/* Signatures. The QC block is the one that must not invite a signature
            it has no right to collect: on a held bill nobody has judged the
            goods, so the line says so instead of standing empty and inviting
            whoever is holding the pen at the bay to fill it in. */}
        <div className="grid grid-cols-3 gap-4 mt-10">
          {[
            { label: 'Received by', name: grn.received_by },
            {
              label: isHeld ? 'QC verified by — NOT YET' : 'QC verified by',
              name: isHeld ? `awaiting ${checkerLabel.toLowerCase()} — do not sign`
                : isOverride ? 'released without a check'
                : (grn.qc_kitchen_by || grn.qc_by),
            },
            { label: 'Store Manager', name: '' },
          ].map((s, i) => (
            <div key={i}>
              <div className="border-b border-[#1a1a1a] h-12"></div>
              <div className="text-[10px] uppercase tracking-wide text-[#666] mt-1">{s.label}</div>
              <div className="text-[11px] mt-0.5">{s.name || ' '}</div>
              <div className="text-[10px] text-[#888]">Date: ____________</div>
            </div>
          ))}
        </div>

        <div className="text-[9px] text-center text-[#999] mt-6 pt-3 border-t border-[#eee]">
          Generated by F&B Controller · {grn.grn_number} · This document is part of the kitchen receiving audit trail.
        </div>
      </div>
    </div>
  );
}
