'use client';
import { Printer } from 'lucide-react';
import { fmtISTDate } from '@/lib/format-date';
import type { PoVendorGroup, PoVendorIdentity, PoVendorClosure } from '@/lib/po-vendor-view';

/* Formatters — byte-for-byte the print page's own (src/app/purchase-orders/
   [id]/print/page.tsx), so the vendor copy and the internal sheet print the
   same figure the same way: money at 2 dp, quantities trimmed to 3 dp, dates
   in IST. */
const fmt = (v: number) => '₹' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (v: number) => (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const dt = (s?: string | null) => fmtISTDate(s, { fallback: '—' });

/* ════════════════════════════════════════════════════════════════════════════
   THE VENDOR COPY (?vendor=<id>) — ruling #70.
   What a vendor may read: OUR order to THEM. Only their lines, with the rate we
   ordered at (per PURCHASE unit — the unit they sell in), their own identity
   block, the PO number, date and the expected delivery date.
   Never on it: another vendor's line or rate, the department breakdown, the
   PO's internal notes, who drafted or approved it, receipts or GRN numbers.
   The lines are chosen by groupPoLinesByVendor — the receive route's own split —
   and the downloadable PDF (/api/purchase-orders/<id>/vendor-pdf) uses the same
   function, so the paper and the file always carry the same lines.
   ════════════════════════════════════════════════════════════════════════════ */
export default function PoVendorCopy({ po, poId, group, identity, closure, biz }: {
  po: any; poId: string; group: PoVendorGroup<any>;
  identity: PoVendorIdentity | null; closure: PoVendorClosure | null; biz: string;
}) {
  // An unapproved PO is not an order yet — say so on the paper rather than let
  // a draft be supplied against.
  const approved = ['approved', 'received'].includes(String(po.status));
  // "Delivered" = a live receipt booked the line (the API's fold drops voided
  // bills). A closed vendor's remaining lines are not to be supplied.
  const isIn = (it: any) => it.received_line_total != null;
  const showStatus = !!closure || group.lines.some(isIn);
  const lineStatus = (it: any) => isIn(it) ? 'Delivered' : closure ? 'Closed — do not supply' : 'Open';
  const name = identity?.name || group.vendor_name;
  const pdfHref = `/api/purchase-orders/${poId}/vendor-pdf?vendor=${encodeURIComponent(group.param)}`;
  return (
    <div className="min-h-screen bg-gray-100 print:bg-white">
      <div className="print:hidden bg-white border-b border-gray-200 px-6 py-3 flex flex-wrap items-center justify-between gap-2">
        <a href="/purchase-orders" className="text-sm text-[#af4408] hover:underline">← Back to POs</a>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-600">Vendor copy for <b>{name}</b> — only this vendor&apos;s lines</span>
          <a href={pdfHref}
             className="inline-flex items-center gap-2 px-4 py-2 border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] rounded-lg text-sm font-medium">
            Download PDF
          </a>
          <button onClick={() => window.print()}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
            <Printer className="w-4 h-4" /> Print
          </button>
        </div>
      </div>
      <div className="overflow-x-auto print:overflow-visible print:m-0 print:p-0">
      <div data-print-sheet className="w-[210mm] mx-auto bg-white px-[8mm] py-[10mm] my-6 shadow-lg text-black text-sm print:w-auto print:max-w-none print:m-0 print:p-0 print:shadow-none">
        {!approved && (
          <div className="border-2 border-red-700 text-red-800 text-center font-bold uppercase tracking-wide py-1.5 mb-3 text-xs">
            Not approved ({String(po.status).replace(/_/g, ' ')}) — do not supply against this copy
          </div>
        )}
        <header className="border-b-2 border-black pb-3 mb-4 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold">{biz}</h1>
            <p className="text-xs text-gray-600 mt-1">PURCHASE ORDER</p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-[#af4408]">{po.po_number}</div>
            <div className="text-xs text-gray-700 mt-1">PO Date: {dt(po.date)}</div>
            {po.delivery_date && <div className="text-xs text-gray-700 mt-1">Expected delivery: {dt(po.delivery_date)}</div>}
          </div>
        </header>

        <section className="mb-4">
          <p className="text-[10px] uppercase font-semibold text-gray-600 mb-1">To</p>
          <div className="text-base font-semibold">{name}</div>
          {identity && (
            <div className="text-xs text-gray-700 mt-1 space-y-0.5">
              {identity.contact_person && <div>Attn: {identity.contact_person}</div>}
              {identity.phone && <div>{identity.phone}</div>}
              {identity.email && <div>{identity.email}</div>}
              {identity.address && <div className="whitespace-pre-line">{identity.address}</div>}
              {identity.gstin && <div>GSTIN: <span className="font-mono">{identity.gstin}</span></div>}
              {identity.payment_terms && <div className="mt-1">Payment terms: {identity.payment_terms}</div>}
            </div>
          )}
        </section>

        <table className="po-sheet-table w-full table-fixed border border-gray-300 mb-4 leading-tight text-xs">
          <colgroup>
            <col style={{ width: '6%' }} /><col />
            <col style={{ width: '11%' }} /><col style={{ width: '9%' }} />
            <col style={{ width: '14%' }} /><col style={{ width: '15%' }} />
            {showStatus && <col style={{ width: '16%' }} />}
          </colgroup>
          <thead className="bg-gray-100">
            <tr>
              <th className="border border-gray-300 px-1.5 py-1.5 text-left">#</th>
              <th className="border border-gray-300 px-1.5 py-1.5 text-left">Item</th>
              <th className="border border-gray-300 px-1 py-1.5 text-right">Qty</th>
              <th className="border border-gray-300 px-1.5 py-1.5 text-left">
                Unit<span className="block font-normal text-[8px] leading-tight text-gray-600">purchase</span>
              </th>
              <th className="border border-gray-300 px-1 py-1.5 text-right">Rate / unit</th>
              <th className="border border-gray-300 px-1 py-1.5 text-right">Amount</th>
              {showStatus && <th className="border border-gray-300 px-1.5 py-1.5 text-left">Status</th>}
            </tr>
          </thead>
          <tbody>
            {group.lines.map((it: any, i: number) => (
              <tr key={it.id}>
                <td className="border border-gray-300 px-1.5 py-1">{i + 1}</td>
                <td className="border border-gray-300 px-1.5 py-1 break-words">{it.material_name}</td>
                <td className="border border-gray-300 px-1 py-1 text-right font-mono">{qty(it.quantity)}</td>
                <td className="border border-gray-300 px-1.5 py-1 break-words">{it.material_purchase_unit || it.material_unit}</td>
                <td className="border border-gray-300 px-1 py-1 text-right font-mono">{fmt(it.unit_price)}</td>
                <td className="border border-gray-300 px-1 py-1 text-right font-mono">{fmt(it.total_price)}</td>
                {showStatus && <td className="border border-gray-300 px-1.5 py-1 break-words">{lineStatus(it)}</td>}
              </tr>
            ))}
          </tbody>
          <tfoot className="font-bold bg-gray-50">
            <tr>
              <td colSpan={5} className="border border-gray-300 px-1.5 py-1.5 text-right uppercase tracking-wider text-[11px]">Order total</td>
              <td className="border border-gray-300 px-1 py-1.5 text-right font-mono">{fmt(group.ordered_total)}</td>
              {showStatus && <td className="border border-gray-300"></td>}
            </tr>
          </tfoot>
        </table>

        <div className="text-[10px] text-gray-700 space-y-0.5 mb-4">
          <p>Quantities and rates are per purchase unit. Please quote PO number <b>{po.po_number}</b> on your bill.</p>
          {closure && (
            <p className="font-semibold text-red-800">
              Lines not delivered by {dt(closure.closed_at)} were closed on our side and are not to be supplied.
            </p>
          )}
        </div>

        <footer className="po-sheet-signoff grid grid-cols-2 gap-12 pt-8 mt-6 border-t border-gray-300 print:pt-5 print:mt-4">
          <div><div className="border-t border-gray-700 pt-1 text-xs text-center">Authorised Signatory</div></div>
          <div><div className="border-t border-gray-700 pt-1 text-xs text-center">Vendor Acknowledgement</div></div>
        </footer>
      </div>
      </div>
      <style jsx global>{`
        @media print {
          @page { size: A4; margin: 10mm 8mm 12mm; }
          body { background: white !important; }
          .po-sheet-table tr { break-inside: avoid; page-break-inside: avoid; }
          .po-sheet-table thead { display: table-header-group; }
          .po-sheet-table tfoot { display: table-row-group; }
          .po-sheet-signoff { break-inside: avoid; page-break-inside: avoid; }
          .po-sheet-table td { overflow-wrap: anywhere; }
          .po-sheet-table th { overflow-wrap: normal; word-break: normal; }
          .po-sheet-table td.text-right.font-mono { overflow-wrap: normal; word-break: normal; }
        }
      `}</style>
    </div>
  );
}
