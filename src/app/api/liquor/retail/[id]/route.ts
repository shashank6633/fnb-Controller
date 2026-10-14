import { getDb } from '@/lib/db';
import { LQ_REIMBURSEMENT_STATUS, type LqReimbursementStatus } from '@/lib/liquor-recon';
import {
  backfillDepotLanded, setReimbursementStatus, retailErrorResponse,
} from '@/lib/liquor-retail';
import { requireRetailRecord, gateResponse } from '../_lib/guard';

/**
 * PATCH /api/liquor/retail/[id] — the rest of a wine-shop record's lifecycle.
 *
 * WHY THIS EXISTS. The module shipped with GET + POST and a single state
 * transition (claimed_pending → reimbursed, driven by a petty-cash payout).
 * Two things were therefore unreachable in the running app:
 *
 *   · A buy recorded before its brand was mapped kept excess 0 for ever, while
 *     the POST response promised the excess was excluded "until a rate is
 *     known" — a promise no route could keep.
 *   · A claim keyed in as 'claimed_pending' and then settled in cash outside the
 *     app inflated §E's "unreimbursed staff spend" permanently; a claim recorded
 *     pending by mistake could never be rejected; a rejected claim the owner
 *     later approved could never be paid.
 *
 * body — one or both of:
 *   { "depot_landed_per_bottle": 1200 }   backfill the frozen depot rate and
 *                                         recompute the three excess figures.
 *                                         Only where no rate was frozen: a rate
 *                                         set at entry is never re-priced.
 *   { "reimbursement_status": "rejected" | "claimed_pending" | "not_required",
 *     "note": "…" }                       correct the claim's state.
 *                                         'reimbursed' is NOT writable here — it
 *                                         is reached only by a real payout, so
 *                                         the settled state always has cash
 *                                         behind it.
 *
 * Gated exactly like recording (can_procure on the material's own store) and
 * CSRF-checked in the guard, because '/api/liquor' is not in the proxy's CSRF
 * prefix list. Reimbursing stays on its own route at the petty-cash write level:
 * correcting a record and moving money are not the same authority.
 */
export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!id) return Response.json({ error: 'A wine-shop record id is required.' }, { status: 400 });

    const db = getDb();
    // Resolve the record's own material so the gate asks about the store the
    // bottles were booked into — never a store the caller merely names.
    const flag = db.prepare(`
      SELECT f.id, p.material_id AS material_id
        FROM lq_retail_flags f
        LEFT JOIN purchases p ON p.id = f.purchase_id
       WHERE f.id = ?
    `).get(id) as { id: string; material_id: string | null } | undefined;
    if (!flag) return Response.json({ error: 'That wine-shop record no longer exists.' }, { status: 404 });

    const gate = await requireRetailRecord(request, db, flag.material_id || undefined);
    if (!gate.ok) return gateResponse(gate);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'Send a JSON body.' }, { status: 400 });
    }

    const hasRate = body.depot_landed_per_bottle !== undefined
      && body.depot_landed_per_bottle !== null
      && String(body.depot_landed_per_bottle).trim() !== '';
    const hasStatus = body.reimbursement_status !== undefined
      && body.reimbursement_status !== null
      && String(body.reimbursement_status).trim() !== '';
    if (!hasRate && !hasStatus) {
      return Response.json({
        error: 'Nothing to change. Send depot_landed_per_bottle (to price a buy recorded without a depot rate) '
          + 'and/or reimbursement_status (to correct a claim).',
      }, { status: 400 });
    }

    const out: Record<string, unknown> = { ok: true, flag_id: id };

    if (hasRate) {
      const rate = Number(body.depot_landed_per_bottle);
      if (!Number.isFinite(rate) || rate <= 0) {
        return Response.json({ error: 'depot_landed_per_bottle must be a number greater than 0 (₹ per bottle).' }, { status: 400 });
      }
      const res = backfillDepotLanded(db, { flagId: id, depotLandedPerBottle: rate, actorEmail: gate.user.email });
      out.depot_landed_per_bottle = res.depotLandedPerBottle;
      out.excess = res.excess;
    }

    if (hasStatus) {
      const status = String(body.reimbursement_status) as LqReimbursementStatus;
      if (!(LQ_REIMBURSEMENT_STATUS as readonly string[]).includes(status)) {
        return Response.json({
          error: `reimbursement_status must be one of: ${LQ_REIMBURSEMENT_STATUS.join(', ')}.`,
        }, { status: 400 });
      }
      const res = setReimbursementStatus(db, {
        flagId: id, status, actorEmail: gate.user.email,
        note: body.note ? String(body.note) : undefined,
      });
      out.reimbursement_status = res.to;
      out.reimbursement_status_from = res.from;
    }

    return Response.json(out);
  } catch (e: any) {
    return retailErrorResponse(e, 'Could not update the wine-shop record.');
  }
}
