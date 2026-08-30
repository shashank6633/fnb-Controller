'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Printer } from 'lucide-react';

import { fmtIST, fmtISTDate } from '@/lib/format-date';
// THE ONE SPELLING OF "this receipt is still waiting on the kitchen". Imported,
// never restated: po-receipts.ts owns the status string and has no runtime
// imports, which is the only reason a 'use client' file may pull from it (see
// its header). The PO detail table reads the same predicate, so screen and
// paper cannot drift apart on what a held line is.
import { isReceiptHeldForQc } from '@/lib/po-receipts';
// The same 2-dp rounding the receive route books money with. po-charges.ts has
// no imports at all, so this is client-safe too.
import { r2 } from '@/lib/po-charges';
// Fixed 2 dp, deliberately the same formatter as the /purchase-orders list page,
// so the same PO reads identically on screen and on paper (max-only would print
// ₹354 here and ₹354.00 there).
const fmt = (v: number) => '₹' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/* QTY for paper. Every quantity on this document is in the material's PURCHASE
 * unit (kg, BTL, CASE) — a PO is what we send a VENDOR, so the recipe unit (g,
 * ml) has no place on it and no recipe hint is printed. 3 dp trims binary-float
 * noise (a rejected 0.30000000000000004) without touching any real figure. */
const qty = (v: number) => (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
// All timestamps in IST. dt() shows date only (legacy callers); use fmtIST when
// you need a date+time stamp on the PO print.
const dt = (s?: string | null) => fmtISTDate(s, { fallback: '—' });

/** One vendor receipt on this PO: their bill, their GRN, their money.
 *  A VOIDED receipt is still in this list, flagged — the API returns the order's
 *  receipt HISTORY, and a printed sheet that silently dropped a bill the GRN
 *  register still shows struck through would stop reconciling with it. It is
 *  struck through here and it is in NO total: `received_net` from the server
 *  already excludes it, and every fallback below filters on is_void. */
interface Receipt {
  grn_id: string; grn_number: string; date: string;
  vendor: string; bill_no: string; bill_date: string; received_by: string;
  line_count: number; gross: number; discount: number; delivery: number; net: number;
  status?: string; is_void?: boolean;
}

export default function POPrintPage() {
  const params = useParams<{ id: string }>();
  const [po, setPo] = useState<any>(null);
  const [vendor, setVendor] = useState<any>(null);
  /* EVERY vendor receipt booked against this PO, oldest first. A PO here is an
     internal approval document that legitimately spans several vendors, and each
     of them delivers on their own day against their own invoice — so "what came
     in" is a LIST, never one GRN. This is what /api/purchase-orders?id= now
     returns; the old print read the single purchase_orders.grn_id, which holds
     only the LATEST receipt, and printed one vendor's bill as the whole order. */
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  /* Σ (accepted × gross rate) − discount over ALL those receipts — computed
     server-side with the same expression the receive route accumulates into
     purchase_orders.total_cost, so the printed total and the stored one agree. */
  const [receivedNet, setReceivedNet] = useState<number | null>(null);
  const [biz, setBiz] = useState<{ name: string }>({ name: 'My Restaurant & Pub' });

  useEffect(() => {
    fetch(`/api/purchase-orders?id=${params.id}`).then(r => r.json()).then(async d => {
      setPo(d.purchase_order);
      setReceipts(Array.isArray(d.receipts) ? d.receipts : []);
      setReceivedNet(Number.isFinite(Number(d.received_net)) ? Number(d.received_net) : null);
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
  //   receivedSubtotal — sum of ACTUAL received amounts, across EVERY vendor
  //                      receipt on the PO; mirrors po.total_cost, which the
  //                      receive route accumulates across receipts
  // For received POs we display BOTH so the print is honest about any
  // qty/price overrides made during receive.
  //
  // isReceived = the PO is CLOSED (every receivable line is in).
  // anyReceived = at least one vendor has delivered. On a mixed-vendor PO the
  // second is true long before the first — the PO deliberately stays 'approved'
  // while other vendors still owe goods — and a sheet that showed nothing
  // received for a delivery already booked into stock would be its own lie.
  const isReceived = po.status === 'received';
  // `isReceived ||` keeps the legacy path intact: a closed PO whose GRN rows
  // cannot be joined at all still shows the received block and falls back to the
  // stored total, exactly as before.
  // VOIDED receipts do not count as a delivery. `receipts` is the order's full
  // history and keeps them (struck through, below); every question of the form
  // "has anything actually arrived / what is it worth" asks liveReceipts.
  // Without this a wholly-voided PO would still read as received and print its
  // grand total as the ₹0 that the voided-out net correctly sums to.
  const liveReceipts = receipts.filter(r => !r.is_void);
  const voidedReceipts = receipts.length - liveReceipts.length;
  const anyReceived = isReceived || liveReceipts.length > 0
    || (po.items || []).some((it: any) => it.received_line_total != null);
  // A PO may legitimately span several vendors (it is an internal approval and
  // costing document here, not a sheet sent to one vendor). When it does, the
  // header shows "Mixed (N vendors)" and the single-vendor identity block below
  // is suppressed because vendor_id is NULL — so the per-line vendor is the only
  // way to tell whose line is whose. Show that column only in that case; a
  // single-vendor PO already names its vendor in the header.
  const isMixedVendor = new Set(
    (po.items || []).map((it: any) => String(it.vendor || '').trim()).filter(Boolean)
  ).size > 1;
  const orderedSubtotal = (po.items || []).reduce((s: number, it: any) => s + (Number(it.total_price) || 0), 0);
  // GROSS received value, summed over the lines of EVERY receipt (the API folds
  // in each PO-linked GRN, not just the last one).
  const receivedSubtotal = anyReceived
    ? (po.items || []).reduce((s: number, it: any) => s + (Number(it.received_line_total) || 0), 0)
    : 0;
  // GRN data is authoritative whenever the receive actually joined GRN lines —
  // including a legitimate ₹0 receive (every line rejected). Detect "joined" by
  // the presence of received_line_total (the API sets it only for po_items
  // matched to a GRN row), NOT by receivedSubtotal > 0, since a truthful zero
  // sums to 0. Fall back to po.total_cost (server-recomputed on receive) only
  // when no GRN line joined at all.
  const hasGrnLines = (po.items || []).some((it: any) => it.received_line_total != null);
  // Bill charges recorded at receive — summed over every vendor's bill, since
  // each allocates its own discount/delivery across its own lines. The GRN
  // carries the GROSS rate + these figures, while purchase_orders.total_cost is
  // NET of the discount; without showing them the printed subtotal and the
  // stored total silently disagree.
  const billDiscount = anyReceived
    ? (po.items || []).reduce((s: number, it: any) => s + (Number(it.received_discount) || 0), 0) : 0;
  const billDelivery = anyReceived
    ? (po.items || []).reduce((s: number, it: any) => s + (Number(it.received_delivery) || 0), 0) : 0;
  // purchase_orders.total_cost is REAL NOT NULL DEFAULT 0 (db.ts:794) and the GET
  // returns SELECT po.*, so a real row always lands a finite number here. The
  // `?? NaN` + isFinite pair only guards a malformed payload (explicit null or a
  // non-numeric), which `|| 0` would silently print as a bogus ₹0.
  const storedTotal = Number(po.total_cost ?? NaN);
  // THE POST-RECEIVE TOTAL = the sum of every vendor bill on this PO.
  // Prefer the server's `received_net` (Σ per-receipt net, the same expression
  // that produced purchase_orders.total_cost, so the paper and the ledger cannot
  // disagree); fall back to the line-derived figure, then to the stored total.
  const receiptsNet = liveReceipts.length > 0 && receivedNet != null ? receivedNet : null;
  const grandTotal = anyReceived
    ? (receiptsNet != null ? receiptsNet
        : hasGrnLines ? Math.round((receivedSubtotal - billDiscount) * 100) / 100
        : (Number.isFinite(storedTotal) ? storedTotal : orderedSubtotal))
    : orderedSubtotal;
  // Lines still owed — a mixed PO prints while vendor B is still to come.
  const outstandingLines = (po.items || []).filter((it: any) => it.received_line_total == null).length;

  /* ── LINES WHOSE RECEIPT IS STILL HELD FOR A QUALITY CHECK ────────────────
     Same derivation as the PO detail table (purchase-orders/page.tsx), because
     paper and screen must say the same thing about the same delivery. A held
     GRN has its rows — the goods are in the building and the bill exists — but
     grn-qc.ts pins quantity_accepted to 0 until the checking department signs,
     as the ABSENCE of a decision. This sheet used to read that 0 straight into
     the Received Qty column, so a delivery sitting in the cold room printed
     "Received 0" on the paper the storekeeper signs.
       AND NOTHING ARRIVED MEANS NOTHING IS BEING HELD. A line can be ticked
     into a receipt at quantity 0 — the receive route allows it deliberately
     and says what it means ("a 0-qty receive books the line as received-and-
     short forever") — and grn-qc refuses accepted > received, so the checking
     department can only ever sign 0 on such a line. Its shortfall is SETTLED,
     not pending; it must keep printing a plain 0. 1e-6 is the receive route's
     own QTY_EPS, so "did anything arrive" is answered with the ledger's slack. */
  const HELD_QTY_EPS = 1e-6;
  const isHeldLine = (it: any) =>
    it.received_line_total != null
    && isReceiptHeldForQc(it.received_grn_status)
    && Number(it.quantity_received || 0) > HELD_QTY_EPS;
  const heldLines = (po.items || []).filter(isHeldLine);
  /* What the vendor's bill says the held goods are worth: RECEIVED × the bill's
     own rate. NOT booked money — nothing is in stock, purchases or average
     price until sign-off — so it is never added into any total on this sheet,
     only stated beside them. Rounded per line and then summed, the same way the
     rows print, so adding the column up gives the footer. */
  const heldBillValue = r2(heldLines.reduce((s: number, it: any) =>
    s + r2(Number(it.quantity_received || 0) * Number(it.received_unit_price ?? it.unit_price)), 0));
  const heldGrns = [...new Set(heldLines.map((it: any) => String(it.received_grn_number || '')).filter(Boolean))];

  /* ── THE PRINTED COLUMN MODEL ─────────────────────────────────────────────
     The item table is `table-fixed`, and these ARE its columns on paper. It was
     `auto` before, which lets a table grow past its own container to fit its
     content: on the owner's 11-line, 2-vendor PO it measured 204mm inside a
     165mm box, and the whole right-hand "Received ₹" column printed off the
     edge of the sheet — a signed purchase order with the received value missing.
     Fixed layout cannot do that: the columns below sum to 100% of the sheet, so
     the table is exactly as wide as the paper and no column can be pushed off.
       Percentages, not millimetres, so the same sheet also renders correctly
     when a browser prints at Letter or with a wider margin.
       Material carries no width: under `table-fixed` the unsized column takes
     whatever the sized ones leave, so the longest thing on the sheet — the
     material name — is the thing that gets the slack, and it wraps rather than
     shoving a money column off the paper.
       Each width below is the widest REAL value that column has to hold, at the
     size it prints, plus its padding: a money column is sized for ₹1,18,731.50
     (12 characters of a monospaced figure), a rate for ₹5,100.00, a quantity
     for 1,234.5.
       A received sheet carries 10 or 11 columns in the width a 7-column ordered
     sheet has to itself, so it prints a size smaller. Below ~9px a rate stops
     being readable across a desk, which is why the width came from the page
     margins and the fixed layout first and from the type size only last. */
  const denseTable = anyReceived;
  const showVendorCol = isMixedVendor;
  /* TWO WIDTH SETS, BECAUSE THERE ARE TWO TYPE SIZES. Sharing one set meant the
     10px figures fitted and the 12px ones did not: on an ordered-only PO,
     ₹28,800.00 printed as "₹28,800.0" over "0" while the Material column sat on
     100mm of the sheet doing nothing with it. Same shape, sized for its own
     type. */
  const colWidths: (string | undefined)[] = denseTable ? [
    // Wide enough for a THREE-digit line number. At 3.2% a 40-line PO printed
    // its line 22 as "2" over "2" and its line 40 as "4" over "0".
    '4.2%',                                   // #
    '7.2%',                                   // SKU
    undefined,                                // Material — takes the remainder
    ...(showVendorCol ? ['12.6%'] : []),      // Vendor (mixed-vendor POs only)
    '7.2%',                                   // Ordered Qty
    '6.2%',                                   // Unit
    '9.2%',                                   // Rate (Ord)
    '11.4%',                                  // Ordered ₹
    '7.4%',                                   // Received Qty
    '9.2%',                                   // Rate (Act)
    '11.4%',                                  // Received ₹
  ] : [
    '5%',                                     // #
    '9%',                                     // SKU
    undefined,                                // Material — takes the remainder
    ...(showVendorCol ? ['15%'] : []),        // Vendor (mixed-vendor POs only)
    '9.5%',                                   // Ordered Qty
    '8%',                                     // Unit
    '12%',                                    // Rate (Ord)
    '13.5%',                                  // Ordered ₹
  ];

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

      {/* ── THE SHEET ────────────────────────────────────────────────────────
          ON SCREEN this is an A4 page: 210mm wide with 8mm/10mm of white
          standing in for the printer's own margin, so the preview is the same
          194mm of usable width the paper gives and what fits here fits there.
          ON PAPER the @page rule owns the margin, so the sheet drops its own
          padding entirely — carrying both cost 21mm of the 186mm the printer
          offered, and that missing width is why the received money column used
          to fall off the edge.

          THE SHEET IS NEVER SQUEEZED NARROWER THAN THE PAPER. It used to carry
          `max-w-full`, which on a phone shrank the 210mm sheet to the viewport
          and took every table-fixed percentage column down with it — a money
          column that needs 85px got 41px, and because a FIGURE is deliberately
          exempt from wrapping (see the numeric rule in the print block below) it
          overflowed leftwards across its neighbour instead of breaking. Measured
          on the 11-line fixture at 390px: 88 cells overprinting, worst 44.2px,
          rendering "₹640.5₹640.50 9". A fixed-geometry document cannot be
          reflowed to a phone, so it is SCROLLED to one instead: the wrapper below
          takes the horizontal scroll, which also keeps it off the page body (at
          794px that used to be 171px of whole-page scroll). Print is untouched —
          the wrapper goes overflow-visible and the sheet still drops to
          `w-auto`, so a scroll container can never clip the paper. */}
      {/* NB: these classNames stay on ONE line each. Turbopack emits a JSX string
          attribute verbatim into the SSR chunk, so a line break inside it ships
          a raw newline in a JS string literal and the whole route 500s with
          "Invalid or unexpected token" — measured, not guessed. */}
      <div className="overflow-x-auto print:overflow-visible print:m-0 print:p-0">
      <div data-print-sheet className="w-[210mm] mx-auto bg-white px-[8mm] py-[10mm] my-6 shadow-lg text-black text-sm print:w-auto print:max-w-none print:m-0 print:p-0 print:shadow-none">
        <header className="border-b-2 border-black pb-3 mb-4 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold">{biz.name}</h1>
            <p className="text-xs text-gray-600 mt-1">PURCHASE ORDER</p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-[#af4408]">{po.po_number}</div>
            <div className="text-xs text-gray-700 mt-1">PO Date: {dt(po.date)}</div>
            {/* The date we PROMISED, not a date anything happened on — so it sits
                beside the PO date in the header the vendor reads first, never in
                the status timeline below (that block is a log of past events).
                Rendered only when a date was actually agreed: an "Expected
                delivery: —" on a document going out to a vendor is noise, and a
                fallback to the PO date would print a deadline nobody committed to.
                "Expected delivery" in full — bare "Delivery" already means the
                vendor's delivery CHARGE further down this sheet. */}
            {po.delivery_date && (
              <div className="text-xs text-gray-700 mt-1">Expected delivery: {dt(po.delivery_date)}</div>
            )}
            <div className="text-xs mt-1">
              Status: <span className="font-semibold uppercase">{po.status}</span>
            </div>
          </div>
        </header>

        <section className="grid grid-cols-2 gap-6 mb-4">
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

        <table className={`po-sheet-table w-full table-fixed border border-gray-300 mb-4 leading-tight ${denseTable ? 'text-[10px]' : 'text-xs'}`}>
          <colgroup>
            {colWidths.map((w, i) => <col key={i} style={w ? { width: w } : undefined} />)}
          </colgroup>
          <thead className="bg-gray-100">
            <tr>
              <th className="border border-gray-300 px-1.5 py-1.5 text-left">#</th>
              <th className="border border-gray-300 px-1.5 py-1.5 text-left">SKU</th>
              <th className="border border-gray-300 px-1.5 py-1.5 text-left">Material</th>
              {isMixedVendor && <th className="border border-gray-300 px-1.5 py-1.5 text-left">Vendor</th>}
              <th className="border border-gray-300 px-1 py-1.5 text-right">Ordered Qty</th>
              {/* Named outright: every qty + rate on this sheet is in the
                  PURCHASE unit, so nobody reads a "10" as ten grams. The
                  qualifier sits on its own line at a smaller size because the
                  column is only as wide as a unit name needs to be — spelling
                  "Unit (purchase)" across one line was holding 10mm of the
                  sheet hostage for a word that is not data. */}
              <th className="border border-gray-300 px-1.5 py-1.5 text-left">
                Unit<span className="block font-normal text-[8px] leading-tight text-gray-600">purchase</span>
              </th>
              <th className="border border-gray-300 px-1 py-1.5 text-right">Rate (Ord)</th>
              <th className="border border-gray-300 px-1 py-1.5 text-right">Ordered ₹</th>
              {anyReceived && <>
                <th className="border border-gray-300 px-1 py-1.5 text-right bg-emerald-50">Received Qty</th>
                <th className="border border-gray-300 px-1 py-1.5 text-right bg-emerald-50">Rate (Act)</th>
                <th className="border border-gray-300 px-1 py-1.5 text-right bg-emerald-50">Received ₹</th>
              </>}
            </tr>
          </thead>
          <tbody>
            {(po.items || []).map((it: any, i: number) => {
              // A line nobody has delivered yet has NO received figures at all —
              // `received_line_total` is the API's marker for "matched to a GRN
              // row" — so it must not fall back to the ordered rate and print as
              // though it had arrived at the quoted price.
              const lineIn = it.received_line_total != null;
              const heldForQc = isHeldLine(it);
              /* ── THREE STATES IN THE RECEIVED COLUMN, NOT TWO ──────────────
                   · no GRN row at all   → "—"  (nothing was delivered)
                   · receipt held for QC → what ARRIVED, marked held
                   · receipt signed off  → the ACCEPTED quantity, INCLUDING a
                                           truthful 0 when the kitchen turned
                                           the whole line away.
                 This read `quantity_accepted ?? quantity_received` — accepted
                 FIRST — and 0 is a real value, so `??` never fell through: a
                 held delivery printed "Received 0" and "₹0.00" against its full
                 ordered value. The detail screen was fixed in ea817cf and this
                 sheet then contradicted it on paper. */
              const recQty   = heldForQc ? it.quantity_received
                                         : (it.quantity_accepted ?? it.quantity_received);
              const recPrice = it.received_unit_price ?? it.unit_price;
              /* On a held line the money shown is the VENDOR'S BILL for what
                 arrived, not booked money — received_line_total is accepted ×
                 rate, which is a pinned 0 until the check is signed. It is
                 labelled as such in the cell and kept out of every total below,
                 exactly as the detail screen does. */
              const recTotal = heldForQc
                ? (recQty != null && recPrice != null ? r2(Number(recQty) * Number(recPrice)) : null)
                : (it.received_line_total ?? (recQty != null ? recQty * recPrice : null));
              // Highlight cells that actually differ from the order so the
              // accounting eye lands on the variances immediately. A held line
              // is NOT graded on that scale — the number in the cell is a
              // received quantity, and shading it against the accepted-vs-ordered
              // legend would mark a decision nobody has made.
              const qtyDiffers   = !heldForQc && lineIn && recQty != null && Number(recQty) !== Number(it.quantity);
              const priceDiffers = lineIn && recPrice != null && Number(recPrice) !== Number(it.unit_price);
              return (
                <tr key={it.id}>
                  <td className="border border-gray-300 px-1.5 py-1">{i + 1}</td>
                  {/* break-WORDS, not break-all. The column is 38.7px of
                      content and a 9-character SKU needs about 53, so it always
                      wraps; the question is only where. `break-all` breaks at
                      any character and gave MAT-006 / 36 and MEAT-MU / T-OFFAL,
                      which a storekeeper cannot reassemble by eye.
                      `overflow-wrap: break-word` takes the hyphen it is already
                      offered first — MAT- / 00636 — and only splits mid-token
                      when a segment genuinely cannot fit. */}
                  <td className="border border-gray-300 px-1.5 py-1 font-mono text-[9px] break-words">{it.material_sku || '—'}</td>
                  <td className="border border-gray-300 px-1.5 py-1 break-words">
                    {it.material_name}
                    {anyReceived && (it.quantity_rejected || 0) > 0 && (
                      <div className="text-[9px] text-red-700 mt-0.5">
                        Rejected: {qty(it.quantity_rejected)} {it.material_purchase_unit || it.material_unit}
                        {it.rejection_reason && <span className="capitalize"> ({it.rejection_reason.replace(/_/g, ' ')})</span>}
                      </div>
                    )}
                  </td>
                  {/* A size down: this column repeats the SAME long trading
                      name on every line, and at the table's own size it wrapped
                      to five lines and made a 10mm row 21mm tall — which is what
                      pushed an 11-line PO onto a second sheet, and a 40-line one
                      onto a third whose only other content was the signature
                      block. Two lines is the target, and it is what decides how
                      many sheets a long PO takes. The name is printed IN FULL
                      and unabbreviated; only the type is smaller, and the vendor
                      bills table below carries it at full size against the
                      invoice number.
                      MEASURED: the size DOES decide the sheet count, so do not
                      put it back up without re-measuring on a long PO. The
                      absolute figures depend on the fixture and the earlier
                      "8px prints on TWO sheets" note does not reproduce — on a
                      40-line, 2-vendor, 2-receipt PO the shipped 8px prints on
                      THREE sheets (HEAD's layout printed the same PO on four).
                      Re-run the fixture; do not trust a remembered number. */}
                  {isMixedVendor && <td className="border border-gray-300 px-1.5 py-1 break-words text-[8px] leading-tight">{it.vendor || '—'}</td>}
                  <td className="border border-gray-300 px-1 py-1 text-right font-mono">{qty(it.quantity)}</td>
                  {/* PO qty/rate are in the PURCHASE unit (kg, BTL, CASE), not
                      the recipe unit (g, ml) — the vendor orders in the former. */}
                  <td className="border border-gray-300 px-1.5 py-1 break-words">{it.material_purchase_unit || it.material_unit}</td>
                  <td className="border border-gray-300 px-1 py-1 text-right font-mono">{fmt(it.unit_price)}</td>
                  <td className="border border-gray-300 px-1 py-1 text-right font-mono">{fmt(it.total_price)}</td>
                  {anyReceived && <>
                    <td className={`border border-gray-300 px-1 py-1 text-right font-mono ${qtyDiffers ? 'bg-amber-50 font-semibold' : heldForQc ? 'bg-blue-50' : 'bg-emerald-50/30'}`}>
                      {lineIn && recQty != null ? qty(recQty) : '—'}
                      {/* SAID IN WORDS, not in colour: this sheet is signed off
                          a mono laser as often as not, and a blue cell that
                          prints grey says nothing. */}
                      {heldForQc && (
                        <span className="block font-sans font-normal text-[8px] leading-tight text-blue-900">held for QC</span>
                      )}
                    </td>
                    <td className={`border border-gray-300 px-1 py-1 text-right font-mono ${priceDiffers ? 'bg-amber-50 font-semibold' : heldForQc ? 'bg-blue-50' : 'bg-emerald-50/30'}`}>
                      {lineIn && recPrice != null ? fmt(Number(recPrice)) : '—'}
                    </td>
                    <td className={`border border-gray-300 px-1 py-1 text-right font-mono ${heldForQc ? 'bg-blue-50' : 'bg-emerald-50/30'}`}>
                      {lineIn && recTotal != null ? fmt(Number(recTotal)) : '—'}
                      {heldForQc && (
                        <span className="block font-sans font-normal text-[8px] leading-tight text-blue-900">bill value · not booked</span>
                      )}
                    </td>
                  </>}
                </tr>
              );
            })}
          </tbody>
          <tfoot className="font-bold bg-gray-50">
            <tr>
              {/* +1 for the Vendor column that only a mixed-vendor PO renders. */}
              <td colSpan={isMixedVendor ? 7 : 6} className="border border-gray-300 px-1.5 py-1.5 text-right">Total Ordered</td>
              <td className="border border-gray-300 px-1 py-1.5 text-right font-mono">{fmt(orderedSubtotal)}</td>
              {anyReceived && <>
                <td colSpan={2} className="border border-gray-300 px-1.5 py-1.5 text-right bg-emerald-50">Total Received</td>
                <td className="border border-gray-300 px-1 py-1.5 text-right font-mono bg-emerald-50">
                  {/* BOOKED money only: this is what has actually entered stock
                      and cost. A held line's bill value is stated under it
                      rather than added into it — otherwise the footer would
                      disagree with the column it totals, since the held rows
                      above print a bill value the books have not taken up. */}
                  {fmt(receivedSubtotal)}
                  {heldLines.length > 0 && (
                    <span className="block font-sans font-normal text-[8px] leading-tight text-blue-900">
                      + {fmt(heldBillValue)} held for QC
                    </span>
                  )}
                </td>
              </>}
            </tr>
            {/* Variance only once the PO is CLOSED. On a part-received PO
                "Received − Ordered" is just the value of what has not turned up
                yet, and printing that as a variance reads as a short delivery. */}
            {isReceived && Math.abs(receivedSubtotal - orderedSubtotal) > 0.01 && (
              <tr className="bg-amber-50">
                <td colSpan={(anyReceived ? 9 : 6) + (isMixedVendor ? 1 : 0)} className="border border-gray-300 px-1.5 py-1.5 text-right text-amber-900">
                  Variance (Received − Ordered)
                </td>
                <td className="border border-gray-300 px-1 py-1.5 text-right font-mono text-amber-900">
                  {receivedSubtotal - orderedSubtotal >= 0 ? '+' : ''}{fmt(receivedSubtotal - orderedSubtotal)}
                </td>
              </tr>
            )}
            {/* Bill charges recorded at receive. The discount REDUCES the cost the
                goods were booked at (it is netted into the rate on the purchases
                row); delivery is recorded against the bill and never enters item
                cost — so it is shown, but not added into the Grand Total. */}
            {anyReceived && billDiscount > 0.005 && (
              <tr>
                <td colSpan={(anyReceived ? 9 : 6) + (isMixedVendor ? 1 : 0)} className="border border-gray-300 px-1.5 py-1 text-right">
                  Less: bill discount
                </td>
                <td className="border border-gray-300 px-1 py-1 text-right font-mono">− {fmt(billDiscount)}</td>
              </tr>
            )}
            {anyReceived && billDelivery > 0.005 && (
              <tr>
                <td colSpan={(anyReceived ? 9 : 6) + (isMixedVendor ? 1 : 0)} className="border border-gray-300 px-1.5 py-1 text-right text-gray-600">
                  Delivery charges (recorded — not in item cost)
                </td>
                <td className="border border-gray-300 px-1 py-1 text-right font-mono text-gray-600">{fmt(billDelivery)}</td>
              </tr>
            )}
            <tr className="bg-gray-100">
              <td colSpan={(anyReceived ? 9 : 6) + (isMixedVendor ? 1 : 0)} className={`border border-gray-300 px-1.5 py-1.5 text-right uppercase tracking-wider ${denseTable ? '' : 'text-[11px]'}`}>
                {/* The label has to match what the number IS. A part-received PO
                    is not "Final" — that word on a figure covering one of three
                    vendors is exactly how the wrong total got reconciled before. */}
                Grand Total {isReceived
                  ? (billDiscount > 0.005 ? '(Final, net of discount)' : '(Final, post-receive)')
                  : anyReceived
                    ? `(Received so far${outstandingLines ? ` — ${outstandingLines} line${outstandingLines > 1 ? 's' : ''} still to come` : ''})`
                    : '(Ordered)'}
              </td>
              {/* The grand total sits in a money column sized for 12 mono
                  characters at the table's own size. Printing it a size LARGER,
                  as it was, is exactly how ₹1,18,731.50 would push itself out of
                  its cell and off the sheet; the bold weight and the shaded row
                  are what make it the figure the eye lands on. */}
              <td className={`border border-gray-300 px-1 py-1.5 text-right font-mono ${denseTable ? '' : 'text-[13px]'}`}>{fmt(grandTotal)}</td>
            </tr>
          </tfoot>
        </table>

        {/* ── WHAT THAT TOTAL IS MADE OF ────────────────────────────────────
            One row per vendor receipt, because a PO here can span several
            vendors and each delivers against their OWN invoice. Without this
            the post-receive total is a single figure that reconciles to no
            document anyone holds; with it, every rupee traces to a bill number.
            Net = accepted value − that bill's discount, the same expression the
            receive route accumulates into purchase_orders.total_cost, so the
            column sums to the Grand Total above. */}
        {receipts.length > 0 && (
          <section className="mb-4 -mt-2">
            <p className="text-[10px] uppercase font-semibold text-gray-600 mb-1">
              Vendor bills received ({liveReceipts.length})
              {voidedReceipts > 0 && (
                <span className="normal-case font-normal text-gray-500">
                  {' '}· {voidedReceipts} voided, shown struck through and in no total
                </span>
              )}
            </p>
            {/* Fixed columns here too, for the same reason as the item table:
                "Discount ₹" was wrapping onto two lines while the vendor name
                took whatever it liked, and an auto table's idea of a good
                column split changes with every PO printed. */}
            <table className="po-sheet-table w-full table-fixed text-[10px] border border-gray-300">
              <colgroup>
                <col /><col style={{ width: '14.5%' }} /><col style={{ width: '10.5%' }} />
                <col style={{ width: '13.5%' }} /><col style={{ width: '10.5%' }} />
                <col style={{ width: '12.5%' }} /><col style={{ width: '10.5%' }} /><col style={{ width: '12.5%' }} />
              </colgroup>
              <thead className="bg-gray-100">
                <tr>
                  <th className="border border-gray-300 px-1.5 py-1 text-left">Vendor</th>
                  <th className="border border-gray-300 px-1.5 py-1 text-left">Bill no.</th>
                  <th className="border border-gray-300 px-1.5 py-1 text-left">Bill date</th>
                  <th className="border border-gray-300 px-1.5 py-1 text-left">GRN</th>
                  <th className="border border-gray-300 px-1.5 py-1 text-left">Received</th>
                  <th className="border border-gray-300 px-1.5 py-1 text-right">Gross ₹</th>
                  <th className="border border-gray-300 px-1.5 py-1 text-right">Discount ₹</th>
                  <th className="border border-gray-300 px-1.5 py-1 text-right">Net ₹</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map(r => {
                  /* A HELD BILL IS WORTH ₹0 IN THIS TABLE AND IT IS NOT WORTH
                     ₹0. Gross and Net are accepted × rate, and a receipt waiting
                     on the kitchen has its accepted quantity pinned to 0, so the
                     bill prints as a row of zeroes with no explanation — beside
                     item lines that now (correctly) show what arrived. Named
                     here so the two halves of the sheet agree. */
                  const held = !r.is_void && isReceiptHeldForQc(r.status);
                  return (
                  <tr key={r.grn_id} className={r.is_void ? 'line-through text-gray-400' : undefined}>
                    <td className="border border-gray-300 px-1.5 py-1 break-words">
                      {r.vendor || '—'}
                      {r.is_void && <span className="no-underline ml-1 font-semibold">(VOID)</span>}
                    </td>
                    <td className="border border-gray-300 px-1.5 py-1 font-mono break-all">{r.bill_no || '—'}</td>
                    <td className="border border-gray-300 px-1.5 py-1">{r.bill_date ? dt(r.bill_date) : '—'}</td>
                    <td className="border border-gray-300 px-1.5 py-1 font-mono break-all">{r.grn_number}</td>
                    <td className="border border-gray-300 px-1.5 py-1">{dt(r.date)}</td>
                    <td className="border border-gray-300 px-1.5 py-1 text-right font-mono">{fmt(r.gross)}</td>
                    <td className="border border-gray-300 px-1.5 py-1 text-right font-mono">
                      {Number(r.discount) > 0.005 ? `− ${fmt(r.discount)}` : '—'}
                    </td>
                    <td className="border border-gray-300 px-1.5 py-1 text-right font-mono">
                      {fmt(r.net)}
                      {held && (
                        <span className="block font-sans font-normal text-[8px] leading-tight text-blue-900">held for QC</span>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
              <tfoot className="font-bold bg-gray-50">
                <tr>
                  <td colSpan={7} className="border border-gray-300 px-1.5 py-1 text-right">
                    Total received {isReceived ? '(all vendors)' : 'so far'}
                  </td>
                  <td className="border border-gray-300 px-1.5 py-1 text-right font-mono">
                    {fmt(receivedNet ?? liveReceipts.reduce((s, r) => s + Number(r.net || 0), 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
            {heldLines.length > 0 && (
              <p className="text-[9px] text-blue-900 mt-1">
                {heldGrns.join(', ') || 'One receipt'} {heldLines.length === 1 ? 'has 1 line' : `has ${heldLines.length} lines`} held
                for a quality check: the goods are in and the bill is recorded, but no stock has been added and the accepted
                quantity is not decided yet. {fmt(heldBillValue)} of vendor bill value sits outside every total on this sheet
                until the check is signed off.
              </p>
            )}
            {billDelivery > 0.005 && (
              <p className="text-[10px] text-gray-600 mt-1">
                Delivery charges of {fmt(billDelivery)} were recorded against these bills and are NOT included above —
                they never enter item cost.
              </p>
            )}
            <p className="text-[10px] text-gray-600 mt-1 italic">
              ✓ Actual qty &amp; price columns reflect what was physically accepted at the receiving bay
              {!isReceived && outstandingLines > 0
                && ` — ${outstandingLines} line${outstandingLines > 1 ? 's have' : ' has'} not been delivered yet`}.
            </p>
          </section>
        )}

        {po.notes && (
          <section className="po-sheet-notes mb-4">
            <p className="text-[10px] uppercase font-semibold text-gray-600 mb-1">Notes</p>
            <p className="text-xs whitespace-pre-line">{po.notes}</p>
          </section>
        )}

        {/* THE SIGNATURE BLOCK MUST NOT BREAK, AND MUST NOT GO IT ALONE.
            `break-inside: avoid` (in the print rules below) keeps the two rules
            and their captions on one page; the standing room above them is cut
            from 48px+48px to 24px+20px on paper, which is what stops a sheet
            that ends near the foot of a page from pushing the whole block onto
            a second one with nothing else on it. */}
        <footer className="po-sheet-signoff grid grid-cols-2 gap-12 pt-8 mt-6 border-t border-gray-300 print:pt-5 print:mt-4">
          <div>
            <div className="border-t border-gray-700 pt-1 text-xs text-center">Authorised Signatory</div>
          </div>
          <div>
            <div className="border-t border-gray-700 pt-1 text-xs text-center">Vendor Acknowledgement</div>
          </div>
        </footer>
      </div>
      </div>

      <style jsx global>{`
        @media print {
          /* A4, with a narrow SIDE margin and a deeper foot.
             12mm all round left 186mm of paper, of which the sheet's own p-10
             padding took another 21mm — 165mm for eleven columns, which is how
             the received money column ended up printed off the edge. 8mm sides
             give the table 194mm and still clear the non-printable border of an
             office laser (typically 4–5mm). The foot stays deeper so the
             signature rules never sit on the very edge of the sheet. */
          @page { size: A4; margin: 10mm 8mm 12mm; }
          body { background: white !important; }

          /* A tbody row that splits across a page break puts a material name on
             one sheet and its money on the next. */
          .po-sheet-table tr { break-inside: avoid; page-break-inside: avoid; }
          /* The column headings repeat at the top of every page of a long PO —
             this is the browser default for thead, restated because the same
             default makes tfoot repeat at the FOOT of every page, and a "Grand
             Total" printed under page 1 of a 3-page order, above forty more
             lines that are also in it, is a figure someone will key into a
             ledger. table-row-group prints the totals once, where they belong. */
          .po-sheet-table thead { display: table-header-group; }
          .po-sheet-table tfoot { display: table-row-group; }
          /* Keep the totals block together with itself. */
          .po-sheet-table tfoot tr { break-inside: avoid; page-break-inside: avoid; }
          .po-sheet-signoff { break-inside: avoid; page-break-inside: avoid; }
          /* And the notes with them: a page carrying only the word NOTES and
             two signature rules is a wasted sheet in the file. */
          .po-sheet-notes { break-inside: avoid; page-break-inside: avoid; }

          /* Nothing on this sheet may be wider than the sheet. A long material
             name, a 20-character SKU or a ₹1,18,731.50 has to wrap inside its
             own column — under a fixed table layout an unbreakable string would
             otherwise hang out over the edge of the paper.
             DATA CELLS ONLY. Applied to the headings as well, this splits
             "Ordered Qty" into "Ordere / d Qty" and "purchase" into "purchas /
             e" — Chrome takes the licence the moment a word is close to the
             column width, not only when it genuinely cannot fit. Headings break
             between words like ordinary prose. */
          .po-sheet-table td { overflow-wrap: anywhere; }
          .po-sheet-table th { overflow-wrap: normal; word-break: normal; }

          /* ...BUT A NUMBER IS NOT A WORD, AND MUST NOT BE BROKEN INSIDE.
             The rule above is what stops a long material name hanging off the
             paper. Applied to a FIGURE it does something worse than overflow —
             it splits the figure itself, because "anywhere" needs no break
             opportunity and a digit group offers none. Measured on a
             seven-figure PO: the money column holds 73.4px of content,
             ₹10,47,420.59 needs 77.8px, and the sheet printed
                 GRAND TOTAL (FINAL, NET OF DISCOUNT)   ₹72,47,862.8
                                                        1
             — the most important number on a signed purchase order, carried
             onto a second line. Also seen: ₹60,00,000.0 / 0 and 12,345. / 75.
             Thresholds are real, not theoretical: money >= ₹10,00,000, rate >=
             ₹10,000, discount >= ₹1,00,000, quantity >= 10,000.
             The cure is to put these cells back to NORMAL wrapping, NOT to
             nowrap them. Normal still breaks where the text genuinely offers a
             break — which is why "− ₹1,25,000.00" keeps splitting after its
             minus sign, harmlessly, as it always did — and never inside a digit
             group. Forbidding the break outright was tried and is worse: it
             drove the vendor-bills Discount figure 20px into the Net column and
             printed the two totals on top of each other.
             A figure with nowhere to break now overflows instead of splitting,
             and since every one of these cells is text-right it overflows
             LEFTWARDS — into its own padding, away from the paper edge — so the
             alignment fix this file exists for cannot be undone by it.
             THE SELECTOR IS THE CONTRACT: text-right AND font-mono together is
             exactly the set of numeric cells. The SKU and the bill-number cells
             are font-mono but LEFT-aligned and MUST keep breaking anywhere,
             which is why the mono class alone is not enough.
             (No backticks in this block: it lives inside a styled-jsx template
             literal and one would end the string.) */
          .po-sheet-table td.text-right.font-mono { overflow-wrap: normal; word-break: normal; }
        }
      `}</style>
    </div>
  );
}
