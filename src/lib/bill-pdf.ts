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
  //
  // 'on_hold' IS FROZEN TOO, and leaving it out of this condition was a real
  // defect: hold writes subtotal / service_charge / discount / tax_total / total
  // exactly as settle does (hold/route.ts) and then refuses further items, and a
  // bill on hold is a debt somebody is chasing for a specific amount. Recomputed
  // live it drifted with the CURRENT settings — measured on a booted server,
  // ₹940.28 rendered as ₹907.38 after the owner changed the service-charge and
  // GST percentages, while the register still chased ₹940. The customer was
  // handed a document that disagreed with the bill by ₹33.
  const bill = (order.status === 'settled' || order.status === 'on_hold')
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

  const newDoc = (h: number) =>
    new PDFDocument({ size: [W, h], margins: { top: M, bottom: M, left: M, right: M } });
  type Doc = ReturnType<typeof newDoc>;

  // THE TWO DATE STRINGS ARE RENDERED ONCE, not per pass (see the measure pass
  // below). istDateTime() with no argument reads the clock, so computing it
  // inside the drawing would let the measure pass and the render pass disagree
  // if the minute ticked between them.
  const billDate = istDateTime(order.settled_at || order.created_at);
  const printedOn = istDateTime();

  // One line per tender (split payments itemise cash/upi/…); fall back to the
  // single payment_method for non-split settlements. Hoisted out of the drawing
  // so the measure pass and the render pass see the identical list.
  const tenders = meta.payments && meta.payments.length
    ? meta.payments
    : (order.payment_method && order.payment_method !== 'split' ? [{ method: order.payment_method, amount: grand }] : []);

  /**
   * ── ONE PAGE, GUARANTEED — WHY THIS IS RENDERED TWICE ────────────────────
   *
   * The owner's requirement is "BILL PDF IN A single page". A thermal receipt
   * has no natural page count: the page IS the roll, so one page means one
   * page sized to its own contents.
   *
   * This used to be a GUESS: `height = 300 + items.length * 26 + (footer?60:0)`,
   * with a 44-character cap on item names to stop a long name wrapping and
   * "blow[ing] the fixed page height". Neither half held. pdfkit adds a page
   * BY ITSELF the moment text passes `page.height - margins.bottom`
   * (pdfkit.js:375 maxY()), and there is no addPage() here to grep for, so
   * every overflow shipped silently. MEASURED over HTTP against a booted
   * server on the owner's own live bill_design (2026-09-19):
   *
   *   1 item + service charge + discount + 2 tenders  → 2 pages
   *   5 items whose names are 60 / 67 / 100 chars     → 4 pages
   *   and with the branding fields filled in (brand + company + address +
   *   contact + email + FSSAI — ordinary use of Settings → Bill Design):
   *   1 item → 10 pages, the same 5 long names → 12 pages, a 2-item bill on
   *   hold → 4 pages.
   *
   * The 300pt base simply did not cover a branded header plus an eight-row
   * totals block; the per-item slack (26 budgeted vs ~21.4 spent) paid the
   * difference until the header grew or a name wrapped. A bigger magic number
   * would only move the cliff.
   *
   * So the height is MEASURED instead of budgeted: draw() runs once on a page
   * tall enough that nothing can overflow, doc.y afterwards is the true bottom
   * of the content, and the real document is then drawn at exactly that
   * height. Identical inputs, identical code path, so the second pass lays out
   * byte-for-byte the same — and the name cap no longer has to hold the page
   * together (a wrapped name now makes the page taller, never a second page).
   */
  const draw = (doc: Doc) => {

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
  doc.text('Date:' + billDate, M, doc.y); doc.moveDown(0.2);
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
  for (const t of tenders) row('- ' + String(t.method).toUpperCase(), rs(t.amount), 9, true);
  rule();

  if (design.footerNote) { doc.moveDown(0.2); center(design.footerNote, 7.5); doc.moveDown(0.3); }
  doc.font('Helvetica').fontSize(7);
  if (meta.printedBy) { doc.text('Printed By:' + meta.printedBy, M, doc.y); doc.moveDown(0.15); }
  doc.text('Printed on:' + printedOn, M, doc.y);

  };  // ── end draw()

  /* ── PASS 1: MEASURE ───────────────────────────────────────────────────────
   * Draw onto a page tall enough that nothing can overflow, so doc.y at the end
   * is the real content bottom rather than wherever an automatic page break left
   * the cursor. The bound is deliberately loose: a 44-char name wraps to at most
   * ~4 lines (~44pt) in a 103pt-wide column at 8pt, so 90pt per item on top of
   * 1,500pt of chrome (branding, header, totals, tenders, footer) is roughly
   * double what the widest bill in this database spends. It is still CHECKED
   * rather than assumed — pdfkit emits 'pageAdded' when it breaks, and the
   * constructor's own first page happens before the listener is attached, so any
   * event here means the bound was too small and probe.y is not the content
   * bottom. Then measure again, bigger. Measuring documents are discarded; only
   * the final cursor is used. */
  let contentBottom = 0;
  let bound = 0;
  for (const factor of [1, 4, 16]) {
    bound = factor * (1500 + items.length * 90 + tenders.length * 24);
    const probe = newDoc(bound);
    probe.on('data', () => {});        // drain, so nothing buffers for a reader that never comes
    probe.on('error', () => {});       // a measure-pass error must not become an unhandled event
    let overflowed = false;
    probe.on('pageAdded', () => { overflowed = true; });
    draw(probe);
    contentBottom = overflowed ? 0 : probe.y;
    probe.end();
    if (contentBottom > 0) break;
  }

  /* ── PASS 2: RENDER at the measured height ────────────────────────────────
   * +2 of slack under the bottom margin: pdfkit breaks a line when
   * `y + lineHeight > page.height - margins.bottom`, and landing exactly on
   * that boundary should not depend on float equality.
   *
   * NEVER PAGINATE. If even the x16 bound overflowed (contentBottom 0 — no bill
   * in this database comes within 2x of the first bound), fall back to that
   * bound: a page taller than it needs is still ONE page, which is the
   * requirement. Note that 14,400pt is the PDF format's own maximum page side
   * (200in) and a bill of ~1,100+ lines exceeds it; the previous fixed-budget
   * height did too (measured: a 1,200-item bill asked for 31,500pt), so this is
   * not a new limit and no real order is near it — the largest order in this
   * database has 8 items, and a 700-item bill measures 9,389pt. */
  const height = Math.max(60, Math.ceil((contentBottom > 0 ? contentBottom + M + 2 : bound)));

  const doc = newDoc(height);
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  draw(doc);
  doc.end();
  return done;
}
