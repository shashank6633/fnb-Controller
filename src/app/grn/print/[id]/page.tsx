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
  pack_size?: number; purchase_unit?: string;
  quantity_ordered: number; quantity_received: number;
  quantity_accepted: number; quantity_rejected: number; rejection_reason?: string;
  unit_price: number; notes?: string;
}
interface Grn {
  id: string; grn_number: string; date: string; time?: string;
  po_id?: string; po_number?: string;
  vendor_id?: string; vendor: string;
  invoice_number?: string; invoice_date?: string;
  received_by?: string; qc_by?: string;
  status: string; notes?: string;
  qc_quality?: number; qc_temperature?: number; qc_expiry?: number;
  qc_damage?: number; qc_weight?: number; qc_invoice_match?: number;
  items: GrnItem[];
}

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
  // Render negative totals with a "(back-correction)" tag so the print is
  // unambiguous and accounting can spot the adjustment row immediately.
  const hasNegative = grn.items.some(i => (Number(i.quantity_received) || 0) < 0 || (Number(i.quantity_accepted) || 0) < 0);

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
      `}</style>

      {/* Toolbar (screen only) */}
      <div className="no-print mb-4 flex items-center justify-between">
        <div className="text-xs text-[#8B7355]">Auto-print starts shortly. Use Ctrl/Cmd-P if it doesn't.</div>
        <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] text-white rounded text-xs">
          <Printer size={14} /> Print
        </button>
      </div>

      <div className="page bg-white p-2">
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
              <th className="text-right border border-[#999] py-1 px-2">Value</th>
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
                </td>
                <td className="border border-[#999] py-1 px-2 text-right font-mono">{it.quantity_ordered} {it.material_unit}</td>
                <td className="border border-[#999] py-1 px-2 text-right font-mono">{it.quantity_received} {it.material_unit}</td>
                <td className="border border-[#999] py-1 px-2 text-right font-mono">{it.quantity_accepted} {it.material_unit}</td>
                <td className="border border-[#999] py-1 px-2 text-right font-mono">{it.quantity_rejected || '—'}</td>
                <td className="border border-[#999] py-1 px-2 text-right font-mono">{fmt(it.unit_price)}</td>
                <td className="border border-[#999] py-1 px-2 text-right font-mono">{fmt(it.quantity_accepted * (it.unit_price || 0))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-[#fafafa] font-semibold">
            {/* Row 1 — total quantities, aligned under each qty column. */}
            <tr>
              <td colSpan={3} className="border border-[#999] py-1 px-2 text-right">Totals</td>
              <td className="border border-[#999] py-1 px-2 text-right font-mono">{totalReceived.toLocaleString('en-IN', { maximumFractionDigits: 3 })}</td>
              <td className="border border-[#999] py-1 px-2 text-right font-mono">{totalAcceptedQty.toLocaleString('en-IN', { maximumFractionDigits: 3 })}</td>
              <td className="border border-[#999] py-1 px-2 text-right font-mono">{totalRejectedQty > 0 ? totalRejectedQty.toLocaleString('en-IN', { maximumFractionDigits: 3 }) : '—'}</td>
              <td className="border border-[#999] py-1 px-2"></td>
              <td className="border border-[#999] py-1 px-2 text-right font-mono">{fmt(totalAcceptedValue)}</td>
            </tr>
            {/* Row 2 — grand total value, full-width emphasis row. */}
            <tr className="bg-[#f4ede2]">
              <td colSpan={7} className="border border-[#999] py-1.5 px-2 text-right text-[11px] uppercase tracking-wider">
                Grand Total Accepted Value
                {hasNegative && <span className="ml-2 text-amber-700 normal-case tracking-normal text-[10px]">(includes back-correction)</span>}
              </td>
              <td className="border border-[#999] py-1.5 px-2 text-right font-mono text-[13px]">{fmt(totalAcceptedValue)}</td>
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
