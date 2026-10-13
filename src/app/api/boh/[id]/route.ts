import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { ensureBohSchema } from '@/lib/boh-schema';
import { getBoh, getBohTimeline, updateBohDetails, BohError } from '@/lib/boh';
import { attachTimelineSeq } from '@/lib/boh-timeline-seq';
import { canViewBoh, canActOnBoh, canUseBoh, bohIsManagement } from '@/lib/boh-access';
import { bohWaReadiness, bohWaNumberFor, markBohNotificationsRead } from '@/lib/boh-notify';

/**
 * GET   /api/boh/[id] — one BOH: the record, the ORIGINAL POS BILL, and the
 *                       complete append-only history.
 * PATCH /api/boh/[id] — correct the chaseable details (contact / company /
 *                       remarks). Never money; never the expected date, which
 *                       moves only through a recorded follow-up.
 *
 * ── THE ORIGINAL BILL: VIEWABLE, REPRINTABLE, DOWNLOADABLE ─────────────────
 * This route does NOT render a bill and does NOT create a print path. The
 * reprint already exists: GET /api/dine-in/orders/[id]/bill-pdf → buildBillPdf
 * (pdfkit, 80mm, Content-Disposition: attachment). It is view + download +
 * reprint in one, needs no hardware, and /cashier already links it
 * (cashier/page.tsx:191). This response carries `bill_pdf_url` pointing at it.
 *
 * ⚠️ NO BOH PATH MAY CONTAIN THE SUBSTRING 'print'. proxy.ts:132 is
 * `if (pathname.includes('/print')) return true;` — which makes such a path
 * PUBLICLY UNAUTHENTICATED, and this module handles customer names, phone
 * numbers and money. Nor may one end .png/.jpg/.json, which the extension
 * carve-out would also make public.
 */
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canUseBoh(me)) return Response.json({ error: 'Your role does not include the Cashier page.' }, { status: 403 });
    const db = getDb();
    if (!ensureBohSchema(db)) return Response.json({ error: 'The Bills on Hold tables are unavailable on this database.' }, { status: 503 });
    const { id } = await params;

    const boh = getBoh(db, id);
    if (!boh) return Response.json({ error: 'BOH not found' }, { status: 404 });
    // Own bills only, unless management. A 404 rather than a 403 would be
    // tidier but would also tell a fishing caller which ids exist.
    if (!canViewBoh(me, boh)) {
      return Response.json({ error: 'This bill on hold is not yours. Cross-user records are management only.' }, { status: 403 });
    }

    // THE ORIGINAL BILL, read-only. Never recomputed here — the figures below
    // are the ones hold FROZE, which is what the BOH balance tracks.
    const order = db.prepare(`
      SELECT o.id, o.order_number, o.status, o.order_type, o.bill_type, o.covers, o.server_name,
             o.subtotal, o.tax_total, o.service_charge, o.discount, o.discount_pct, o.total,
             o.payment_method, o.settled_at, o.held_at, o.created_at, o.notes,
             o.guest_name, o.guest_mobile, o.bill_printed_at,
             t.table_number, t.zone
        FROM orders o LEFT JOIN restaurant_tables t ON t.id = o.table_id
       WHERE o.id = ?
    `).get(boh.order_id) as any;
    const items = order
      ? db.prepare(
          'SELECT id, name, quantity, unit_price, line_total, tax_value, station, notes FROM order_items WHERE order_id = ? ORDER BY created_at ASC',
        ).all(boh.order_id) as any[]
      : [];

    // THE HISTORY, IN THE ORDER IT WAS ACTUALLY WRITTEN. getBohTimeline orders
    // by (created_at, id) and `id` is a random UUID, so rows sharing a second
    // come back shuffled — measured: three handovers rendering as a chain in
    // which Priya passes the bill on before receiving it. attachTimelineSeq
    // adds each row's SQLite rowid as `seq` and re-sorts on it. Read-only, and
    // it never throws: see src/lib/boh-timeline-seq.ts for why rowid is a
    // faithful insertion order on these append-only tables.
    const timeline = attachTimelineSeq(db, boh.id, getBohTimeline(db, boh.id));

    // WHY THE WHATSAPP LEG IS DARK — the gate's OWN sentences, so the screen
    // renders them verbatim instead of inventing a second explanation. Two
    // SEPARATE blockers, deliberately not collapsed: "no approved template" and
    // "no number on file for <user>" are different fixes.
    const wa = bohWaReadiness(db);
    const waNumber = bohWaNumberFor(db, boh.responsible_user_id);

    // THE BELL'S READ RECEIPT. The bell asks "has the responsible person seen
    // this reminder"; opening the record is the answer, so the count drops here
    // and nowhere else — the register does not clear every bill at once. The
    // notification row itself is untouched: is_read is a receipt, not history.
    markBohNotificationsRead(db, boh.id, String(me.email || ''));

    return Response.json({
      boh,
      order: order || null,
      items,
      ...timeline,
      // Reuse, never reinvent: this is the existing reprint endpoint.
      bill_pdf_url: `/api/dine-in/orders/${boh.order_id}/bill-pdf`,
      whatsapp: {
        ready: wa.ready && !!waNumber.number,
        configured: wa.configured,
        template_ok: wa.templateOk,
        template_name: wa.templateName,
        template_status: wa.templateStatus,
        blockers: [...wa.blockers, ...(waNumber.blocker ? [waNumber.blocker] : [])],
        number_source: waNumber.source,
      },
    });
  } catch (e: any) {
    console.error('[/api/boh/[id] GET]', e);
    return Response.json({ error: e?.message || 'Failed to load this bill on hold' }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    if (!ensureBohSchema(db)) return Response.json({ error: 'The Bills on Hold tables are unavailable on this database.' }, { status: 503 });
    const { id } = await params;
    const outletId = await getCurrentOutletId();

    const boh = getBoh(db, id);
    if (!boh) return Response.json({ error: 'BOH not found' }, { status: 404 });
    if (!canViewBoh(me, boh)) return Response.json({ error: 'This bill on hold is not yours.' }, { status: 403 });
    const gate = canActOnBoh(db, me, boh, outletId);
    if (!gate.allowed) return Response.json({ error: gate.message, ...(gate.detail || {}) }, { status: gate.status });

    const b = await req.json().catch(() => ({}));
    // A CLOSED RECORD'S CUSTOMER IDENTITY IS MANAGEMENT-ONLY TO CORRECT.
    // customer_name and customer_mobile are two of the three permanent search
    // keys the owner named, and this PATCH overwrites them IN PLACE — the audit
    // row is the only surviving copy of the old value, and logAuditEvent is
    // best-effort. An ordinary cashier could rewrite the customer on a settled
    // bill for ever; a manager may still fix a genuine typo after the fact.
    const updated = updateBohDetails(db, id, {
      customerName: b?.customer_name,
      customerMobile: b?.customer_mobile,
      customerCompany: b?.customer_company,
      remarks: b?.remarks,
      reason: b?.reason,
    }, { id: me.id, email: me.email, name: me.name, role: me.role }, { allowClosed: bohIsManagement(me) });
    return Response.json({ boh: updated });
  } catch (e: any) {
    if (e instanceof BohError) return Response.json({ error: e.message }, { status: e.status });
    console.error('[/api/boh/[id] PATCH]', e);
    return Response.json({ error: e?.message || 'Failed to update' }, { status: 500 });
  }
}
