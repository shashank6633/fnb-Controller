import { getDb } from '@/lib/db';
import { LQ_REIMBURSEMENT_STATUS, type LqReimbursementStatus } from '@/lib/liquor-recon';
import { correctRetailFlag, retailErrorResponse } from '@/lib/liquor-retail';
import { requireRetailCorrect, gateResponse } from '../_lib/guard';

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
 * ALL OR NOTHING. Both parts are validated before either is written, and both
 * are written in ONE transaction (correctRetailFlag): a request refused on
 * either part — a bad figure, a status that is unchanged or payout-backed, a
 * rate already frozen — writes nothing. It used to save the rate and only then
 * refuse the status, answering 409 over a record it had just changed.
 *
 * MANAGEMENT ONLY (owner decision (a), 2026-11-05): Admin, Manager or HOD with
 * a page that shows the register — requireRetailCorrect, the register's own
 * read gate. It used to be gated like RECORDING (can_procure on the material's
 * store), which let the storekeeper who fronted the money re-status their own
 * claim or set the rate their excess is measured against. Recording a new buy
 * keeps the can_procure gate (POST /api/liquor/retail). CSRF is checked in the
 * guard, because '/api/liquor' is not in the proxy's CSRF prefix list.
 * Reimbursing stays on its own route at the petty-cash write level: correcting
 * a record and moving money are not the same authority.
 *
 * A frozen rate is still refused without being quoted (backfillDepotLanded).
 */
export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!id) return Response.json({ error: 'A wine-shop record id is required.' }, { status: 400 });

    // GATE BEFORE LOOKUP. Sign-in, CSRF and the management gate all run before
    // the record is read: an anonymous caller gets 401 and a storekeeper 403
    // whether the id exists or not — never a 404 that confirms it does.
    const db = getDb();
    const gate = await requireRetailCorrect(request, db);
    if (!gate.ok) return gateResponse(gate);

    const flag = db.prepare('SELECT id FROM lq_retail_flags WHERE id = ?').get(id) as { id: string } | undefined;
    if (!flag) return Response.json({ error: 'That wine-shop record no longer exists.' }, { status: 404 });

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

    // The shape checks, BOTH of them, before anything is written.
    const rate = hasRate ? Number(body.depot_landed_per_bottle) : null;
    if (rate !== null && (!Number.isFinite(rate) || rate <= 0)) {
      return Response.json({ error: 'depot_landed_per_bottle must be a number greater than 0 (₹ per bottle).' }, { status: 400 });
    }
    const status = hasStatus ? String(body.reimbursement_status) as LqReimbursementStatus : null;
    if (status !== null && !(LQ_REIMBURSEMENT_STATUS as readonly string[]).includes(status)) {
      return Response.json({
        error: `reimbursement_status must be one of: ${LQ_REIMBURSEMENT_STATUS.join(', ')}.`,
      }, { status: 400 });
    }

    // The state checks of both parts, then both writes, in ONE transaction.
    const res = correctRetailFlag(db, {
      flagId: id, actorEmail: gate.user.email,
      depotLandedPerBottle: rate, status,
      note: body.note ? String(body.note) : undefined,
    });

    const out: Record<string, unknown> = { ok: true, flag_id: id };
    if (res.rate) {
      // The rate is the caller's own figure — echoing it tells them nothing.
      out.depot_landed_per_bottle = res.rate.depotLandedPerBottle;
      // The EXCESS is the rate paid minus that figure. It goes back because the
      // gate above IS the register's read gate: this caller already sees every
      // rate paid on the register. (Under the old can_procure gate a bartender
      // outside management was quoted a colleague's retail price this way.)
      out.excess = res.rate.excess;
    }
    if (res.status) {
      out.reimbursement_status = res.status.to;
      out.reimbursement_status_from = res.status.from;
    }
    return Response.json(out);
  } catch (e: any) {
    return retailErrorResponse(e, 'Could not update the wine-shop record.');
  }
}
