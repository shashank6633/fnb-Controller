'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Printer } from 'lucide-react';

import { fmtIST, fmtISTDate } from '@/lib/format-date';
const fmt = (v: number) => '₹' + (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
// All timestamps in IST. dt() shows date only (legacy callers); use fmtIST when
// you need a date+time stamp on the PO print.
const dt = (s?: string | null) => fmtISTDate(s, { fallback: '—' });

export default function POPrintPage() {
  const params = useParams<{ id: string }>();
  const [po, setPo] = useState<any>(null);
  const [vendor, setVendor] = useState<any>(null);
  const [biz, setBiz] = useState<{ name: string }>({ name: 'My Restaurant & Pub' });

  useEffect(() => {
    fetch(`/api/purchase-orders?id=${params.id}`).then(r => r.json()).then(async d => {
      setPo(d.purchase_order);
      if (d.purchase_order?.vendor_id) {
        const v = await fetch(`/api/vendors?id=${d.purchase_order.vendor_id}`).then(r => r.json());
        setVendor(v.vendor);
      }
    });
    fetch('/api/settings?key=business_name').then(r => r.json()).then(d => {
      if (d?.value) setBiz({ name: d.value });
    });
  }, [params.id]);

  if (!po) return <div className="p-10 text-center text-gray-500">Loading…</div>;

  // Two distinct totals:
  //   orderedSubtotal — sum of ORIGINAL ordered amounts (po_items as drafted)
  //   receivedSubtotal — sum of ACTUAL received amounts (from the linked GRN);
  //                      mirrors po.total_cost which is rewritten on receive
  // For received POs we display BOTH so the print is honest about any
  // qty/price overrides made during receive.
  const isReceived = po.status === 'received';
  const orderedSubtotal = (po.items || []).reduce((s: number, it: any) => s + (Number(it.total_price) || 0), 0);
  const receivedSubtotal = isReceived
    ? (po.items || []).reduce((s: number, it: any) => s + (Number(it.received_line_total) || 0), 0)
    : 0;
  // Fall back to po.total_cost (server-recomputed on receive) if per-line GRN
  // data isn't joined for some reason — keeps the grand total trustworthy.
  const grandTotal = isReceived
    ? (receivedSubtotal > 0 ? receivedSubtotal : Number(po.total_cost) || orderedSubtotal)
    : orderedSubtotal;

  return (
    <div className="min-h-screen bg-gray-100 print:bg-white">
      {/* Toolbar (hidden on print) */}
      <div className="print:hidden bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <a href="/purchase-orders" className="text-sm text-[#af4408] hover:underline">← Back to POs</a>
        <button onClick={() => window.print()}
                className="inline-flex items-center gap-2 px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
          <Printer className="w-4 h-4" /> Print / Save as PDF
        </button>
      </div>

      {/* Print area — A4 sized */}
      <div className="max-w-[210mm] mx-auto bg-white p-10 my-6 print:my-0 print:shadow-none shadow-lg text-black text-sm">
        <header className="border-b-2 border-black pb-4 mb-6 flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold">{biz.name}</h1>
            <p className="text-xs text-gray-600 mt-1">PURCHASE ORDER</p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-[#af4408]">{po.po_number}</div>
            <div className="text-xs text-gray-700 mt-1">Date: {dt(po.date)}</div>
            <div className="text-xs mt-1">
              Status: <span className="font-semibold uppercase">{po.status}</span>
            </div>
          </div>
        </header>

        <section className="grid grid-cols-2 gap-6 mb-6">
          <div>
            <p className="text-[10px] uppercase font-semibold text-gray-600 mb-1">Vendor</p>
            <div className="text-base font-semibold">{po.vendor || '—'}</div>
            {vendor && (
              <div className="text-xs text-gray-700 mt-1 space-y-0.5">
                {vendor.contact_person && <div>Attn: {vendor.contact_person}</div>}
                {vendor.phone && <div>{vendor.phone}</div>}
                {vendor.email && <div>{vendor.email}</div>}
                {vendor.address && <div className="whitespace-pre-line">{vendor.address}</div>}
                {vendor.gstin && <div>GSTIN: <span className="font-mono">{vendor.gstin}</span></div>}
                {vendor.payment_terms && <div className="mt-1">Payment terms: {vendor.payment_terms}</div>}
              </div>
            )}
          </div>
          <div>
            <p className="text-[10px] uppercase font-semibold text-gray-600 mb-1">Status timeline</p>
            <div className="text-xs space-y-0.5">
              <div>Drafted: {dt(po.created_at)} ({po.drafted_by})</div>
              {po.submitted_at && <div>Submitted: {dt(po.submitted_at)}</div>}
              {po.approved_at && <div>Approved: {dt(po.approved_at)} by {po.approved_by}</div>}
              {po.received_at && <div>Received: {dt(po.received_at)}</div>}
              {po.rejected_reason && <div className="text-red-700">Rejected: {po.rejected_reason}</div>}
            </div>
          </div>
        </section>

        <table className="w-full text-xs border border-gray-300 mb-6">
          <thead className="bg-gray-100">
            <tr>
              <th className="border border-gray-300 px-2 py-1.5 text-left">#</th>
              <th className="border border-gray-300 px-2 py-1.5 text-left">SKU</th>
              <th className="border border-gray-300 px-2 py-1.5 text-left">Material</th>
              <th className="border border-gray-300 px-2 py-1.5 text-right">Ordered Qty</th>
              <th className="border border-gray-300 px-2 py-1.5 text-left">Unit</th>
              <th className="border border-gray-300 px-2 py-1.5 text-right">Rate (Ord)</th>
              <th className="border border-gray-300 px-2 py-1.5 text-right">Ordered ₹</th>
              {isReceived && <>
                <th className="border border-gray-300 px-2 py-1.5 text-right bg-emerald-50">Received Qty</th>
                <th className="border border-gray-300 px-2 py-1.5 text-right bg-emerald-50">Rate (Act)</th>
                <th className="border border-gray-300 px-2 py-1.5 text-right bg-emerald-50">Received ₹</th>
              </>}
            </tr>
          </thead>
          <tbody>
            {(po.items || []).map((it: any, i: number) => {
              const recQty   = it.quantity_accepted ?? it.quantity_received;
              const recPrice = it.received_unit_price ?? it.unit_price;
              const recTotal = it.received_line_total ?? (recQty != null ? recQty * recPrice : null);
              // Highlight cells that actually differ from the order so the
              // accounting eye lands on the variances immediately.
              const qtyDiffers   = isReceived && recQty != null && Number(recQty) !== Number(it.quantity);
              const priceDiffers = isReceived && recPrice != null && Number(recPrice) !== Number(it.unit_price);
              return (
                <tr key={it.id}>
                  <td className="border border-gray-300 px-2 py-1.5">{i + 1}</td>
                  <td className="border border-gray-300 px-2 py-1.5 font-mono text-[10px]">{it.material_sku || '—'}</td>
                  <td className="border border-gray-300 px-2 py-1.5">
                    {it.material_name}
                    {isReceived && (it.quantity_rejected || 0) > 0 && (
                      <div className="text-[10px] text-red-700 mt-0.5">
                        Rejected: {it.quantity_rejected}
                        {it.rejection_reason && <span className="capitalize"> ({it.rejection_reason.replace(/_/g, ' ')})</span>}
                      </div>
                    )}
                  </td>
                  <td className="border border-gray-300 px-2 py-1.5 text-right font-mono">{Number(it.quantity).toLocaleString('en-IN')}</td>
                  <td className="border border-gray-300 px-2 py-1.5">{it.material_unit}</td>
                  <td className="border border-gray-300 px-2 py-1.5 text-right font-mono">{fmt(it.unit_price)}</td>
                  <td className="border border-gray-300 px-2 py-1.5 text-right font-mono">{fmt(it.total_price)}</td>
                  {isReceived && <>
                    <td className={`border border-gray-300 px-2 py-1.5 text-right font-mono ${qtyDiffers ? 'bg-amber-50 font-semibold' : 'bg-emerald-50/30'}`}>
                      {recQty != null ? Number(recQty).toLocaleString('en-IN') : '—'}
                    </td>
                    <td className={`border border-gray-300 px-2 py-1.5 text-right font-mono ${priceDiffers ? 'bg-amber-50 font-semibold' : 'bg-emerald-50/30'}`}>
                      {recPrice != null ? fmt(Number(recPrice)) : '—'}
                    </td>
                    <td className="border border-gray-300 px-2 py-1.5 text-right font-mono bg-emerald-50/30">
                      {recTotal != null ? fmt(Number(recTotal)) : '—'}
                    </td>
                  </>}
                </tr>
              );
            })}
          </tbody>
          <tfoot className="font-bold bg-gray-50">
            <tr>
              <td colSpan={6} className="border border-gray-300 px-2 py-2 text-right">Total Ordered</td>
              <td className="border border-gray-300 px-2 py-2 text-right font-mono">{fmt(orderedSubtotal)}</td>
              {isReceived && <>
                <td colSpan={2} className="border border-gray-300 px-2 py-2 text-right bg-emerald-50">Total Received</td>
                <td className="border border-gray-300 px-2 py-2 text-right font-mono bg-emerald-50">{fmt(receivedSubtotal)}</td>
              </>}
            </tr>
            {isReceived && Math.abs(receivedSubtotal - orderedSubtotal) > 0.01 && (
              <tr className="bg-amber-50">
                <td colSpan={isReceived ? 9 : 6} className="border border-gray-300 px-2 py-1.5 text-right text-amber-900 text-[11px]">
                  Variance (Received − Ordered)
                </td>
                <td className="border border-gray-300 px-2 py-1.5 text-right font-mono text-amber-900">
                  {receivedSubtotal - orderedSubtotal >= 0 ? '+' : ''}{fmt(receivedSubtotal - orderedSubtotal)}
                </td>
              </tr>
            )}
            <tr className="bg-gray-100">
              <td colSpan={isReceived ? 9 : 6} className="border border-gray-300 px-2 py-2 text-right uppercase tracking-wider text-[11px]">
                Grand Total {isReceived ? '(Final, post-receive)' : '(Ordered)'}
              </td>
              <td className="border border-gray-300 px-2 py-2 text-right font-mono text-[13px]">{fmt(grandTotal)}</td>
            </tr>
          </tfoot>
        </table>
        {isReceived && po.grn_id && (
          <div className="text-[10px] text-gray-600 mb-4 -mt-4 italic">
            ✓ Received against GRN — actual qty &amp; price columns reflect what was physically accepted at the receiving bay.
          </div>
        )}

        {po.notes && (
          <section className="mb-6">
            <p className="text-[10px] uppercase font-semibold text-gray-600 mb-1">Notes</p>
            <p className="text-xs whitespace-pre-line">{po.notes}</p>
          </section>
        )}

        <footer className="grid grid-cols-2 gap-12 pt-12 mt-12 border-t border-gray-300">
          <div>
            <div className="border-t border-gray-700 pt-1 text-xs text-center">Authorised Signatory</div>
          </div>
          <div>
            <div className="border-t border-gray-700 pt-1 text-xs text-center">Vendor Acknowledgement</div>
          </div>
        </footer>
      </div>

      <style jsx global>{`
        @media print {
          @page { size: A4; margin: 12mm; }
          body { background: white !important; }
        }
      `}</style>
    </div>
  );
}
