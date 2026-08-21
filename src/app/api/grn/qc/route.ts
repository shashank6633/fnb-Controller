import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import {
  listPendingQc, pendingQcCount, overdueQcCount, qcEscalationHours,
  canSignQcFor, canOverrideQc, qcSignerAudit, qcSchemaHealth,
  getCategoryCheckerMap, QC_AWAITING, type QcChecker,
} from '@/lib/grn-qc';

/**
 * PENDING QUALITY CHECKS — the queue behind /grn/qc.
 *
 *   GET /api/grn/qc            → the queue + the counts the bell shows
 *   GET /api/grn/qc?id=<grnId> → ONE held receipt with its lines, for the
 *                                sign-off panel
 *   GET /api/grn/qc?checkers=1 → JUST the category → checker map, so the
 *                                receiving form can warn BEFORE Save
 *
 * SELF-AUTHENTICATES. src/proxy.ts guards PAGES, not APIs. Writes live in
 * POST /api/grn/[id]/qc; this file never writes.
 *
 * ── WHO MAY READ IT ────────────────────────────────────────────────────────
 * Any signed-in user, which is EXACTLY the bar GET /api/grn already sets for
 * the same documents — the queue shows a subset of the rows, and the same
 * money, that /grn already shows to every session. A narrower gate here would
 * hide from the kitchen staff the one screen this whole feature exists to put
 * in front of them, and on today's data (all nine users have section = '' and
 * only three carry a department_id) a department-scoped read would show the
 * queue to almost nobody.
 *
 * WHAT IS NOT OPEN is ACTING on it: `can_sign` / `can_override` ride on every
 * row, advisory for the page, and POST /api/grn/[id]/qc re-derives both from
 * the session and fails closed.
 *
 * OUTLET-SCOPED, like GET /api/grn — a receipt taken at another outlet is not
 * this outlet's to sign.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const url = new URL(request.url);
    const id = String(url.searchParams.get('id') || '').trim();

    /* ── THE MAP, FOR THE FORM THAT HAS TO WARN BEFORE SAVE ──────────────────
       WHY THIS BRANCH EXISTS RATHER THAN WIDENING THE ADMIN ENDPOINT.
       /grn's create form tells the receiver, per line and before the click,
       that a delivery will be held. It needs the same category → checker map
       resolveQcRequirement() reads. Its only source was
       GET /api/grn/qc/categories, which is requireRole('admin') — so the ONE
       user this form is built for, the store manager (manager tier,
       is_store_manager, NOT an admin), always got a 403 and fell back to
       "perishables are held, which ones exactly is an admin setting I cannot
       read". The exact, per-line, before-the-click warning existed only for the
       four admins, who are not the people standing at the bay at 6am. The store
       person learned about the hold AFTER clicking Save, by which time the
       vendor may be pulling away — and the vendor still being there is the
       whole leverage this feature buys.

       This returns the MAP AND NOTHING ELSE. The admin endpoint also carries the
       WhatsApp recipient mobiles, the escalation setting, per-category material
       counts, sample material names and updated_by — configuration that belongs
       to a screen only an admin can open. Widening that GET would have handed
       all of it to every session to fix a warning banner. Which categories the
       kitchen checks is not a secret from the people who receive the goods; a
       recipient's mobile number is.

       Keyed on category_key — catKeyOf()'s normalisation — because that is what
       the gate matches on. Keys not present read 'none', exactly as
       resolveQcRequirement treats a missing key.
       `armed` rides along so the form can distinguish "nothing is gated" from
       "the gate is not switched on", which look identical from a map alone. */
    if (url.searchParams.get('checkers') === '1') {
      const map = getCategoryCheckerMap(db);
      const health = qcSchemaHealth(db);
      return Response.json({
        checkers: [...map.entries()]
          .filter(([, c]) => c !== 'none')
          .map(([category_key, checker]) => ({ category_key, checker })),
        armed: health.armed,
        schema_ok: health.ok,
      });
    }

    if (id) {
      const grn = db.prepare(`
        SELECT g.*, po.po_number AS po_number
          FROM goods_receipt_notes g
          LEFT JOIN purchase_orders po ON po.id = g.po_id
         WHERE g.id = ?
      `).get(id) as any;
      if (!grn) return Response.json({ error: 'Not found' }, { status: 404 });
      if (outletId && grn.outlet_id != null && String(grn.outlet_id) !== String(outletId)) {
        return Response.json({
          error: 'This receipt belongs to a different outlet than the one you are working in. Switch outlets to open it.',
        }, { status: 403 });
      }
      // pack_size / purchase_unit ride along because the OWNER RULE is that
      // every purchase quantity LEADS with the purchase unit and shows the
      // recipe equivalent underneath (src/lib/pack-units.ts, components/Qty).
      // The sign-off panel types an ACCEPTED quantity, so it must not be the
      // one screen in the app that asks for a number in an ambiguous unit.
      const items = db.prepare(`
        SELECT gi.id, gi.material_id, gi.quantity_ordered, gi.quantity_received,
               gi.quantity_accepted, gi.quantity_rejected, gi.rejection_reason,
               gi.unit_price, gi.discount, gi.notes, gi.qc_applied_at,
               rm.name AS material_name, rm.sku AS material_sku,
               rm.category AS material_category,
               rm.unit AS material_unit, rm.purchase_unit, rm.pack_size,
               ROUND(gi.quantity_received * gi.unit_price, 2) AS line_value
          FROM goods_receipt_note_items gi
          JOIN raw_materials rm ON rm.id = gi.material_id
         WHERE gi.grn_id = ?
         ORDER BY rm.name
      `).all(id) as any[];
      const checker = String(grn.qc_checker || '') as QcChecker;
      return Response.json({
        grn: { ...grn, items },
        is_awaiting: String(grn.status) === QC_AWAITING,
        can_sign: String(grn.status) === QC_AWAITING && canSignQcFor(db, me, checker),
        can_override: String(grn.status) === QC_AWAITING && canOverrideQc(me),
        escalation_hours: qcEscalationHours(db),
      });
    }

    const rows = listPendingQc(db, { outletId, user: me, limit: 200 });
    return Response.json({
      rows,
      // Both counts are computed by the SAME functions the bell uses, so the
      // badge and this page can never disagree — the rule pendingVarianceCount
      // documents and this copies.
      pending_count: pendingQcCount(db, outletId),
      overdue_count: overdueQcCount(db, outletId),
      escalation_hours: qcEscalationHours(db),
      can_override: canOverrideQc(me),
      // WHO CAN ACTUALLY SIGN, on this database, today. Surfaced rather than
      // assumed: all 19 departments have an empty head_user_id and every user
      // has section = '', so on day one a KITCHEN check is signable only by the
      // admins and head chefs. A queue that silently could not be cleared would
      // be the feature failing quietly — this is the number that says so.
      signer_audit: qcSignerAudit(db),
      // IS THE GATE ACTUALLY ARMED? The gate fails OPEN on a schema fault or an
      // empty map (grn-qc.ts, "THE GATE FAILS OPEN, ON PURPOSE"), and the house
      // rule is that db.ts swallows its schema errors to console.error — so a
      // half-applied boot migration turns the whole feature off while the queue
      // reads 0 and the bell reads 0, which is indistinguishable from a quiet
      // morning. Failing open is still right; being silent about it is not.
      // Rendered as a banner on this page.
      schema_health: qcSchemaHealth(db),
    });
  } catch (e: any) {
    console.error('[/api/grn/qc]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
