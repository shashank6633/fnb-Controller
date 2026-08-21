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

const QC_ROWS: { key: keyof Grn; label: string }[] = [
  { key: 'qc_quality',       label: 'Quality OK (look · smell · feel)' },
  { key: 'qc_temperature',   label: 'Temperature within range (cold-chain items)' },
  { key: 'qc_expiry',        label: 'Expiry / use-by date checked' },
  { key: 'qc_damage',        label: 'No visible damage / leak / pest' },
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
        {/* Header */}
        <div className="border-b-2 border-[#1a1a1a] pb-3 mb-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[#666]">Goods Receipt Note</div>
              <div className="text-2xl font-bold mt-1">{grn.grn_number}</div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-widest text-[#666]">Status</div>
              <div className={`text-base font-semibold capitalize mt-1 ${
                grn.status === 'received' ? 'text-emerald-700' :
                grn.status === 'partial'  ? 'text-amber-700'   : 'text-red-700'
              }`}>{grn.status}</div>
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
          <div><span className="text-[#666]">PO Number:</span> <span className="font-mono">{grn.po_number || '— (Ad-hoc receipt)'}</span></div>
          <div><span className="text-[#666]">Vendor:</span> <span className="font-medium">{grn.vendor || '—'}</span></div>
          <div><span className="text-[#666]">Invoice:</span> <span className="font-mono">{grn.invoice_number || '—'}{grn.invoice_date ? ' · ' + grn.invoice_date : ''}</span></div>
          <div><span className="text-[#666]">Received by:</span> <span className="font-medium">{grn.received_by || '—'}</span></div>
          <div><span className="text-[#666]">QC by:</span> <span className="font-medium">{grn.qc_by || '—'}</span></div>
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
                <td className="border border-[#999] py-1 px-2 text-right font-mono">{it.quantity_accepted} {it.purchase_unit || it.material_unit}</td>
                <td className="border border-[#999] py-1 px-2 text-right font-mono">{it.quantity_rejected ? <>{it.quantity_rejected} {it.purchase_unit || it.material_unit}</> : '—'}</td>
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
              <td className="border border-[#999] py-1 px-2 text-right font-mono">{qtyTotal(totalAcceptedQty)}</td>
              <td className="border border-[#999] py-1 px-2 text-right font-mono">{qtyTotal(totalRejectedQty, true)}</td>
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

        {/* QC checklist */}
        <div className="mb-4">
          <div className="text-[11px] uppercase tracking-wide text-[#555] font-semibold mb-2">QC Checklist</div>
          <table className="w-full border-collapse">
            <tbody>
              {QC_ROWS.map((q, i) => (
                <tr key={q.key as string} className={i % 2 ? 'bg-[#fafafa]' : ''}>
                  <td className="border border-[#ccc] py-1 px-2 w-[28px] text-center">
                    <span className="inline-block w-3.5 h-3.5 border border-[#666] text-[10px] leading-[14px] text-center">
                      {(grn as any)[q.key] ? '✓' : ''}
                    </span>
                  </td>
                  <td className="border border-[#ccc] py-1 px-2">{q.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {grn.notes && (
          <div className="mb-4">
            <div className="text-[11px] uppercase tracking-wide text-[#555] font-semibold mb-1">Notes</div>
            <div className="border border-[#ccc] p-2 text-[11px] whitespace-pre-wrap">{grn.notes}</div>
          </div>
        )}

        {/* Signatures */}
        <div className="grid grid-cols-3 gap-4 mt-10">
          {[
            { label: 'Received by', name: grn.received_by },
            { label: 'QC verified by', name: grn.qc_by },
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
