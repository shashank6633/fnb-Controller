import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { poReceiptLines } from '@/lib/po-receipts';
import { buildReportPdf, inr, qty, humanDate } from '@/lib/report-pdf';
import { groupPoLinesByVendor, vendorParamMatches, closureForGroup } from '@/lib/po-vendor-view';

export const runtime = 'nodejs';

/** A stored stamp → its IST calendar day, for a human. SQLite's datetime('now')
 *  is UTC with no zone marker; slicing its first 10 characters would name the
 *  UTC day, which is yesterday for anything closed before 05:30 IST. */
function istDay(stamp: unknown): string {
  const s = String(stamp ?? '').trim();
  if (!s) return '';
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return humanDate(s.slice(0, 10));
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return humanDate(ymd);
}

/**
 * GET /api/purchase-orders/<id>/vendor-pdf?vendor=<vendor_id | vendor name>
 *
 * THE VENDOR COPY AS A FILE (ruling #70: "per-vendor sheet WITH rates … print /
 * download; WhatsApp later"). The same document /purchase-orders/<id>/print?
 * vendor=<id> renders in the browser, built server-side so it downloads as a
 * real PDF — and so a later WhatsApp send can attach exactly this file.
 *
 * WHAT IS ON IT, AND WHAT IS NEVER ON IT. Only that vendor's lines, with OUR
 * ordered rate per PURCHASE unit (the vendor sells in kg/BTL/CASE). Never another
 * vendor's line or rate, never the department breakdown (internal — ruling #70),
 * never the PO's internal notes, approver or drafter. The lines and the vendor
 * split come from @/lib/po-vendor-view — the same grouping the print page, the
 * PO detail and the receive route use — so the file and the screen cannot list
 * different lines for the same vendor.
 *
 * HONEST ABOUT STATE. A PO that is not approved prints "NOT APPROVED" in its
 * title (it must not be supplied against). A vendor that was closed prints which
 * lines are closed and not to be supplied. A line already received says so.
 *
 * Read-only. Auth: any signed-in user — the same set that can read the PO itself
 * through GET /api/purchase-orders?id= (proxy.ts guards pages, not APIs).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await getCurrentUser();
    if (!viewer) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const vendorParam = (new URL(req.url).searchParams.get('vendor') || '').trim();
    if (!vendorParam) return Response.json({ error: 'vendor is required — this is a per-vendor copy' }, { status: 400 });

    const db = getDb();
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });

    const items = db.prepare(`
      SELECT poi.id, poi.material_id, poi.quantity, poi.unit_price, poi.total_price, poi.vendor, poi.vendor_id,
             rm.name AS material_name, rm.sku AS material_sku,
             COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS material_purchase_unit
      FROM purchase_order_items poi
      JOIN raw_materials rm ON rm.id = poi.material_id
      WHERE poi.po_id = ?
      ORDER BY poi.rowid
    `).all(id) as any[];

    const group = groupPoLinesByVendor(items, po).find(g => vendorParamMatches(g, vendorParam));
    if (!group) return Response.json({ error: 'That vendor has no lines on this PO' }, { status: 404 });

    const vendor = group.vendor_id
      ? db.prepare(`SELECT name, contact_person, phone, email, address, gstin, payment_terms FROM vendors WHERE id = ?`)
          .get(group.vendor_id) as any
      : null;

    // Which of this vendor's lines a LIVE receipt has booked (voids excluded by
    // the ledger's own claim join), and whether this vendor was closed.
    const received = new Set(poReceiptLines(db, id).map(r => String(r.po_item_id)));
    let closure: { vendor_id: string | null; vendor_name: string; reason: string; closed_at: string } | null = null;
    try {
      const hasClosures = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='po_vendor_closures'`).get();
      if (hasClosures) {
        const rows = db.prepare(`
          SELECT c.vendor_id, COALESCE(NULLIF(TRIM(c.vendor_name), ''), v.name, '') AS vendor_name,
                 COALESCE(c.reason, '') AS reason, COALESCE(c.closed_at, '') AS closed_at
          FROM po_vendor_closures c LEFT JOIN vendors v ON v.id = c.vendor_id
          WHERE c.po_id = ? ORDER BY c.closed_at DESC
        `).all(id) as any[];
        closure = closureForGroup(rows, group);
      }
    } catch { /* un-migrated DB — no closures exist */ }

    const anyStatus = closure || group.lines.some(l => received.has(String(l.id)));
    // ONE WORD per status. report-pdf truncates every cell to one line, and a
    // longer label printed as "Closed - do not..." — a sentence cut off before
    // the word that carries its meaning. The footnote spells CLOSED out in full.
    const lineStatus = (l: any) => received.has(String(l.id)) ? 'Delivered'
      : closure ? 'CLOSED' : 'Open';

    const biz = (db.prepare(`SELECT value FROM settings WHERE key = 'business_name'`).get() as any)?.value || 'My Restaurant & Pub';
    const approved = ['approved', 'received'].includes(String(po.status));
    const vendorName = vendor?.name || group.vendor_name;

    const vendorBlock = [
      `To: ${vendorName}`,
      vendor?.contact_person ? `Attn: ${vendor.contact_person}` : '',
      vendor?.phone || '', vendor?.email || '',
      vendor?.address ? String(vendor.address).replace(/\s*\n\s*/g, ', ') : '',
      vendor?.gstin ? `GSTIN: ${vendor.gstin}` : '',
    ].filter(Boolean).join(' · ');

    const pdf = await buildReportPdf({
      title: `Purchase Order ${po.po_number}${approved ? '' : ` - NOT APPROVED (${String(po.status).toUpperCase()})`}`,
      businessName: biz,
      period: `PO date ${humanDate(String(po.date || '').slice(0, 10))}`
        + (po.delivery_date ? ` · Expected delivery ${humanDate(String(po.delivery_date).slice(0, 10))}` : ''),
      subtitle: vendorBlock,
      kpis: [
        { label: 'Vendor', value: vendorName, sub: vendor?.gstin ? `GSTIN ${vendor.gstin}` : undefined },
        { label: 'Lines', value: String(group.lines.length) },
        { label: 'Order value', value: inr(group.ordered_total), sub: 'at the rates below' },
      ],
      tables: [{
        title: 'Items ordered',
        columns: [
          // Widths give the ITEM NAME the room: every cell is cut to one line,
          // and the name is the cell a supplier most needs whole.
          { label: '#', width: 0.05, align: 'right' },
          { label: 'Item', width: anyStatus ? 0.42 : 0.52 },
          { label: 'Qty', width: 0.08, align: 'right' },
          { label: 'Unit', width: 0.07 },
          { label: 'Rate / unit', width: 0.13, align: 'right' },
          { label: 'Amount', width: 0.15, align: 'right' },
          ...(anyStatus ? [{ label: 'Status', width: 0.10 }] : []),
        ],
        rows: group.lines.map((l: any, i: number) => [
          String(i + 1),
          String(l.material_name || ''),
          qty(l.quantity),
          String(l.material_purchase_unit || ''),
          inr(l.unit_price),
          inr(l.total_price),
          ...(anyStatus ? [lineStatus(l)] : []),
        ]),
        note: `Total ${inr(group.ordered_total)}. Quantities and rates are per purchase unit.`,
      }],
      footnotes: [
        ...(approved ? [] : ['This order is NOT APPROVED yet. Do not supply against this copy until you receive the approved one.']),
        ...(closure ? [`Lines marked CLOSED were not delivered by ${istDay(closure.closed_at)}; they were closed on our side and are not to be supplied.`] : []),
        ...(vendor?.payment_terms ? [`Payment terms: ${vendor.payment_terms}`] : []),
        'Please quote this PO number on your bill.',
      ],
    });

    const safe = (s: string) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${safe(po.po_number)}-${safe(vendorName) || 'vendor'}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    console.error('[/api/purchase-orders/[id]/vendor-pdf]', e);
    return Response.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
