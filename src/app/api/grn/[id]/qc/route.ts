import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import {
  decideGrnQc, runQcPriceCascade, canSignQcFor, canOverrideQc,
  QcRefused, QC_AWAITING, type QcChecker, type QcLineDecision,
} from '@/lib/grn-qc';

/**
 * SIGN OFF (or OVERRIDE) A HELD RECEIPT — the write that inwards the goods.
 *
 *   POST /api/grn/:id/qc
 *     { mode: 'sign',
 *       ticks: { quality, temperature, damage },
 *       lines: [{ grn_item_id, accepted?, rejection_reason? }] }
 *     { mode: 'override', reason: '...' }
 *
 * SELF-AUTHENTICATES, and CSRF is covered: /api/grn is already in
 * CSRF_REQUIRED_PREFIXES (src/proxy.ts), so this path inherits it — which is
 * why the whole feature lives under /api/grn rather than under a new top-level
 * prefix somebody would have to remember to register.
 *
 * ── THE GATE ───────────────────────────────────────────────────────────────
 * SIGN     — canSignQcFor(me, the GRN's OWN qc_checker). The owner's decision
 *            6, verbatim: "any user with access to the checking department,
 *            name and time stamped. NOT HOD-only — at 6am with a truck waiting
 *            that guarantees workarounds." The checker is read from the ROW,
 *            never from the request: a caller must not be able to name the
 *            department whose competence they are claiming.
 * OVERRIDE — canOverrideQc(me): admin or head chef, and a written reason of at
 *            least 5 characters. The GRN is then marked 'override' PERMANENTLY
 *            (qc_outcome / qc_override_by / qc_override_at /
 *            qc_override_reason are committed columns, not an audit row that
 *            could be pruned) and appears on the override report.
 *
 * BOTH FAIL CLOSED. No session, an unresolvable role or a thrown lookup all
 * leave the predicate false. canAccessPage is NOT consulted anywhere here — it
 * fails open four ways and is not a gate.
 *
 * ── EXACTLY ONCE ───────────────────────────────────────────────────────────
 * Everything that moves is inside decideGrnQc's single transaction, whose FIRST
 * statement is a conditional claim
 *   UPDATE … WHERE id = ? AND status = 'awaiting_qc' AND qc_applied_at IS NULL
 * so a double-click, a retry, two tabs and a voided receipt all match zero rows
 * and roll back before one unit of stock has moved. This route adds no second
 * guard of its own — a second guard is a second thing to get wrong.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();

    const grn = db.prepare(
      `SELECT id, grn_number, status, qc_checker, qc_applied_at, voided_at, voided_by, outlet_id
         FROM goods_receipt_notes WHERE id = ?`,
    ).get(id) as any;
    if (!grn) return Response.json({ error: 'No such receipt.' }, { status: 404 });

    // ── OUTLET SCOPE — THE ID ALONE IS NOT AN AUTHORISATION ─────────────────
    // Every sibling surface enforces this and this one did not: GET /api/grn's
    // detail branch, GET /api/grn/qc?id= (403 with this exact wording), and both
    // PUT and DELETE /api/grn/[id] via outletBlock(). The one endpoint that
    // MOVES STOCK AND WRITES MONEY was the one that read outlet_id and never
    // compared it — so a session in outlet B, holding an id from a notification
    // body or an earlier session's list, could inward outlet A's goods, write
    // outlet A's purchases and inventory_transactions rows, and stamp
    // qc_kitchen_by with somebody who does not work there. POST /api/outlets/
    // switch is open to any session, so no id-guessing was even needed.
    // Same predicate as the list: a NULL outlet_id is a shared document.
    const outletId = await getCurrentOutletId();
    if (outletId && grn.outlet_id != null && String(grn.outlet_id) !== String(outletId)) {
      return Response.json({
        error: `${grn.grn_number} belongs to a different outlet than the one you are working in. Switch to that outlet first — goods are inwarded into the books they were recorded in.`,
      }, { status: 403 });
    }

    // A VOIDED RECEIPT IS ANSWERED HERE, BY NAME, rather than left to the claim
    // to refuse anonymously. The claim WOULD refuse it (status 'void' is not
    // 'awaiting_qc'), and that is the real interlock — this is the sentence a
    // person can act on. QC can never un-void one either: nothing in this
    // feature ever writes 'void' → anything.
    if (String(grn.status) === 'void') {
      return Response.json({
        error: `${grn.grn_number} was voided${grn.voided_by ? ' by ' + grn.voided_by : ''} and can never be signed off. A voided bill records goods that were un-received; signing it would credit stock for a receipt that no longer exists.`,
      }, { status: 409 });
    }
    if (String(grn.status) !== QC_AWAITING) {
      return Response.json({
        error: `${grn.grn_number} is not waiting for a quality check (it is "${grn.status}"${grn.qc_applied_at ? `, inwarded on ${grn.qc_applied_at} UTC` : ''}). Nothing was applied a second time.`,
      }, { status: 409 });
    }

    const body = await request.json().catch(() => ({} as any));
    const mode = String(body?.mode || 'sign').toLowerCase().trim();
    if (mode !== 'sign' && mode !== 'override') {
      return Response.json({ error: `mode must be "sign" or "override" (received "${mode}").` }, { status: 400 });
    }

    const checker = String(grn.qc_checker || '') as QcChecker;
    if (mode === 'sign') {
      if (!canSignQcFor(db, me, checker)) {
        const who = checker === 'both' ? 'Kitchen or Bar' : checker === 'bar' ? 'Bar' : 'Kitchen';
        return Response.json({
          error: `${grn.grn_number} needs a ${who} check and your account is not in that department. Ask ${who.toLowerCase()} staff to sign it, or ask an admin / head chef to release it with a written reason.`,
          qc_checker: checker,
        }, { status: 403 });
      }
    } else if (!canOverrideQc(me)) {
      return Response.json({
        error: 'Only an admin or a head chef can inward goods without a kitchen check. Ask one of them, or have the checking department sign it.',
      }, { status: 403 });
    }

    // Line decisions are read ONLY in sign mode. An override accepts what
    // arrived — decision 2 is "release it without QC", not "release part of
    // it"; a partial release is a QC judgement, which is precisely what the
    // override says nobody made. decideGrnQc enforces that too.
    const lines: QcLineDecision[] = Array.isArray(body?.lines)
      ? body.lines
          .filter((l: any) => l && l.grn_item_id)
          .map((l: any) => ({
            grn_item_id: String(l.grn_item_id),
            accepted: l.accepted === undefined || l.accepted === null || String(l.accepted).trim() === ''
              ? null : Number(l.accepted),
            rejection_reason: String(l.rejection_reason ?? ''),
          }))
      : [];

    const res = decideGrnQc(db, {
      grnId: String(id),
      actorEmail: me.email,
      mode: mode as 'sign' | 'override',
      lines,
      ticks: {
        quality:     !!body?.ticks?.quality,
        temperature: !!body?.ticks?.temperature,
        damage:      !!body?.ticks?.damage,
      },
      overrideReason: String(body?.reason ?? ''),
    });

    // POST-COMMIT, AND ITS FAILURE IS NOT THIS REQUEST'S FAILURE. The stock is
    // already in; updateMaterialPrice does its own writes and cascades through
    // every sub-recipe and recipe, so surfacing a throw here as a 500 would tell
    // the signer the sign-off failed when it did not, and they would click
    // again — which the claim would then correctly refuse, leaving them
    // convinced the stock never moved. Same rule DELETE /api/grn/[id] documents.
    const cascadeFailed = runQcPriceCascade(db, res.materials_touched);

    return Response.json({
      success: true,
      grn_id: res.grn_id,
      grn_number: res.grn_number,
      outcome: res.outcome,
      status: res.status,
      lines_applied: res.lines_applied,
      purchases_written: res.purchases_written,
      materials_touched: res.materials_touched.length,
      po_total_restamped: res.po_total_restamped,
      requisition_cascaded: res.requisition_cascaded,
      // Named rather than swallowed: a material whose weighted average did not
      // recompute has correct STOCK and a stale COST, and somebody has to know
      // which one to re-cost.
      price_cascade_failed: cascadeFailed,
      message: res.outcome === 'override'
        ? `${res.grn_number} released WITHOUT a kitchen check and marked permanently. Stock has been added.`
        : res.outcome === 'rejected'
          ? `${res.grn_number} fully rejected — nothing entered stock. The vendor is answerable for the recorded reasons.`
          : `${res.grn_number} signed off. ${res.lines_applied} line(s) inwarded.`,
    });
  } catch (e: any) {
    if (e instanceof QcRefused) {
      return Response.json({ error: e.message, ...(e.payload || {}) }, { status: e.httpStatus });
    }
    console.error('[/api/grn/[id]/qc]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
