import PDFDocument from 'pdfkit';
import { computeBill, sumItemTax, round2 } from '@/lib/bill-calc';

/**
 * Digital bill (PDF) — a downloadable copy of the SAME 80mm thermal receipt the
 * counter prints. Totals come from computeBill (the one source of truth used by
 * settle + the thermal print), so the PDF can never disagree with what was
 * charged. Branding/fields come from the `bill_design` + `business_name`/`gstin`
 * settings, exactly like the printed bill.
 */

export interface BillPdfItem { name: string; quantity: number; unit_price: number; line_total: number; tax_value?: number | null }
export interface BillPdfOrder {
  id: string; order_number?: number | string; order_type?: string;
  table_number?: string | null; zone?: string | null; table_id?: string | null;
  covers?: number | null; server_name?: string | null;
  guest_name?: string | null; guest_mobile?: string | null;
  subtotal: number; discount?: number | null; discount_pct?: number | null;
  service_charge?: number | null; tax_total?: number | null; total?: number | null;
  service_charge_reason?: string | null; payment_method?: string | null;
  status?: string; settled_at?: string | null; created_at?: string | null;
}
export interface BillPdfDesign {
  brandName?: string; companyName?: string; address?: string; contact?: string; email?: string; fssai?: string;
  showGstin?: boolean; serviceChargeOn?: boolean; serviceChargePct?: number; cgstPct?: number; sgstPct?: number;
  footerNote?: string;
}
export interface BillPdfMeta { businessName: string; gstin: string; printedBy?: string; duplicate?: boolean; payments?: { method: string; amount: number }[] }

const rs = (n: number) => 'Rs ' + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(round2(n));
function istDateTime(iso?: string | null): string {
  const d = iso ? new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z') : new Date();
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(d).replace(',', '');
}

/** Render the bill as an 80mm-wide PDF and resolve its bytes. */
export function buildBillPdf(
  order: BillPdfOrder, items: BillPdfItem[], design: BillPdfDesign, meta: BillPdfMeta,
): Promise<Buffer> {
  // A SETTLED bill is a reprint: show the FROZEN figures settle stored, so the
  // copy always equals what was actually charged even if bill_design later
  // changes. An OPEN bill is provisional → compute live from the current design.
  const bill = order.status === 'settled'
    ? (() => {
        const tax = round2(order.tax_total || 0);
        const cgst = round2(tax / 2);
        return { subtotal: round2(order.subtotal), serviceCharge: round2(order.service_charge || 0),
          discount: round2(order.discount || 0), cgst, sgst: round2(tax - cgst), total: round2(order.total || 0) };
      })()
    : computeBill(
        {
          subtotal: order.subtotal,
          itemTax: sumItemTax(items),
          serviceRemoved: !!order.service_charge_reason,
          discount_pct: order.discount_pct || 0,
          discount: order.discount || 0,
        },
        { serviceChargeOn: design.serviceChargeOn !== false, serviceChargePct: Number(design.serviceChargePct) || 0,
          cgstPct: design.cgstPct == null ? 2.5 : Number(design.cgstPct), sgstPct: design.sgstPct == null ? 2.5 : Number(design.sgstPct) },
      );
  const amtBeforeTax = round2(bill.subtotal + bill.serviceCharge - bill.discount);
  const grand = Math.round(bill.total);

  const W = 226;                       // 80mm
  const M = 10;                        // margin
  const CW = W - M * 2;                // content width
  const height = 300 + items.length * 26 + (design.footerNote ? 60 : 0);
  const doc = new PDFDocument({ size: [W, height], margins: { top: M, bottom: M, left: M, right: M } });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const center = (t: string, size = 8, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).text(t, M, doc.y, { width: CW, align: 'center' });
  };
  const rule = () => { doc.moveTo(M, doc.y + 2).lineTo(W - M, doc.y + 2).dash(1, { space: 1 }).strokeColor('#000').stroke().undash(); doc.moveDown(0.4); };
  const row = (l: string, r: string, size = 8, bold = false) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
    doc.text(l, M, y, { width: CW * 0.6, align: 'left' });
    doc.text(r, M + CW * 0.4, y, { width: CW * 0.6, align: 'right' });
    doc.y = Math.max(doc.y, y + size + 3);
  };

  if (meta.duplicate) { center('DUPLICATE BILL', 8, true); doc.moveDown(0.3); }
  center(design.brandName || meta.businessName || 'Restaurant', 15, true);
  doc.moveDown(0.2);
  if (design.companyName) center(design.companyName, 8);
  if (design.address) center(design.address, 8);
  if (design.contact) center('Mob:' + design.contact, 8);
  if (design.email) center('Email:' + design.email, 8);
  if (design.fssai) center('FSSAI:' + design.fssai, 8);
  if (design.showGstin !== false && meta.gstin) center('GST:' + meta.gstin, 8);
  doc.moveDown(0.3); rule();

  const isDineIn = !!order.table_id || !!order.table_number;
  center(isDineIn ? 'DINE-IN' : (order.order_type || 'PARCEL').toUpperCase(), 11, true);
  if (isDineIn && order.table_number) center(`${order.zone ? order.zone + ' : ' : ''}${order.table_number}`, 9);
  doc.moveDown(0.3); rule();

  doc.font('Helvetica').fontSize(8);
  doc.text('Order No:' + (order.order_number ?? '—'), M, doc.y); doc.moveDown(0.2);
  doc.text('Date:' + istDateTime(order.settled_at || order.created_at), M, doc.y); doc.moveDown(0.2);
  if (order.server_name) { doc.text('Captain Name:' + order.server_name, M, doc.y); doc.moveDown(0.2); }
  // Guest details (QR self-order details page / captain-entered) — printed for
  // the cashier's reference on unpaid/hold bills.
  if (order.guest_name || order.guest_mobile) {
    doc.text('Guest:' + [order.guest_name, order.guest_mobile].filter(Boolean).join(' · '), M, doc.y);
    doc.moveDown(0.2);
  }
  rule();
  doc.text('No. Of Guest: ' + (order.covers || 0), M, doc.y); doc.moveDown(0.2);
  rule();

  // Items header
  const y0 = doc.y;
  doc.font('Helvetica-Bold').fontSize(8);
  doc.text('Item Name', M, y0, { width: CW * 0.5 });
  doc.text('Qty', M + CW * 0.5, y0, { width: CW * 0.16, align: 'right' });
  doc.text('Rate', M + CW * 0.66, y0, { width: CW * 0.17, align: 'right' });
  doc.text('Amt', M + CW * 0.83, y0, { width: CW * 0.17, align: 'right' });
  doc.y = y0 + 12; rule();

  for (const it of items) {
    const y = doc.y;
    doc.font('Helvetica').fontSize(8);
    // Cap the name so a very long one can't wrap to many lines and blow the
    // fixed page height into a runaway multi-page PDF.
    const nm = it.name && it.name.length > 44 ? it.name.slice(0, 43) + '…' : (it.name || '');
    doc.text(nm, M, y, { width: CW * 0.5 });
    const yName = doc.y;
    doc.text(String(it.quantity), M + CW * 0.5, y, { width: CW * 0.16, align: 'right' });
    doc.text(round2(it.unit_price).toFixed(2), M + CW * 0.66, y, { width: CW * 0.17, align: 'right' });
    doc.text(round2(it.line_total).toFixed(2), M + CW * 0.83, y, { width: CW * 0.17, align: 'right' });
    doc.y = Math.max(yName, y + 11) + 2;
  }
  rule();

  row('SUB TOTAL', rs(bill.subtotal), 8, true);
  if (bill.serviceCharge > 0) row('SERVICE CHARGE', rs(bill.serviceCharge), 8);
  if (bill.discount > 0) row('DISCOUNT', '-' + rs(bill.discount), 8);
  row('AMT BEFORE TAX', rs(amtBeforeTax), 8);
  if (bill.cgst > 0) row(`CGST@${design.cgstPct == null ? 2.5 : design.cgstPct}%`, rs(bill.cgst), 8);
  if (bill.sgst > 0) row(`SGST@${design.sgstPct == null ? 2.5 : design.sgstPct}%`, rs(bill.sgst), 8);
  row('TOTAL', rs(bill.total), 8);
  doc.moveDown(0.2);
  row('GRAND TOTAL', rs(grand), 10, true);
  // One line per tender (split payments itemise cash/upi/…); fall back to the
  // single payment_method for non-split settlements.
  const tenders = meta.payments && meta.payments.length
    ? meta.payments
    : (order.payment_method && order.payment_method !== 'split' ? [{ method: order.payment_method, amount: grand }] : []);
  for (const t of tenders) row('- ' + String(t.method).toUpperCase(), rs(t.amount), 9, true);
  rule();

  if (design.footerNote) { doc.moveDown(0.2); center(design.footerNote, 7.5); doc.moveDown(0.3); }
  doc.font('Helvetica').fontSize(7);
  if (meta.printedBy) { doc.text('Printed By:' + meta.printedBy, M, doc.y); doc.moveDown(0.15); }
  doc.text('Printed on:' + istDateTime(), M, doc.y);

  doc.end();
  return done;
}
