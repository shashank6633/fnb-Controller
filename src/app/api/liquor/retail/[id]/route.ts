import { getDb } from '@/lib/db';
import { LQ_REIMBURSEMENT_STATUS, type LqReimbursementStatus } from '@/lib/liquor-recon';
import {
  backfillDepotLanded, setReimbursementStatus, retailErrorResponse,
} from '@/lib/liquor-retail';
import { requireRetailRecord, requireSignedInWrite, gateResponse, canReadRetailRegister } from '../_lib/guard';

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
 *
 * What it SAYS is narrower than who may call it: a frozen rate is refused
 * without being quoted (backfillDepotLanded), and the recomputed excess is
 * returned only to a viewer the register admits (canReadRetailRegister) —
 * see the hasRate branch.
 */
export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!id) return Response.json({ error: 'A wine-shop record id is required.' }, { status: 400 });

    // GATE BEFORE LOOKUP. Sign-in and CSRF first: the record lookup used to run
    // ahead of every check, so an anonymous caller got 404 "no longer exists"
    // where it should get 401 — the wrong refusal, and an existence oracle.
    const pre = await requireSignedInWrite(request);
    if (!pre.ok) return gateResponse(pre);

    const db = getDb();
    // Resolve the record's own material so the gate asks about the store the
    // bottles were booked into — never a store the caller merely names. The
    // flag carries it; a LEGACY flag's parent purchase is the second source.
    const flag = db.prepare(`
      SELECT f.id, COALESCE(f.material_id, p.material_id) AS material_id
        FROM lq_retail_flags f
        LEFT JOIN purchases p ON p.id = f.purchase_id
       WHERE f.id = ?
    `).get(id) as { id: string; material_id: string | null } | undefined;

    // A missing record is reported only to someone who could have edited one:
    // the store gate runs on the liquor store itself, so a signed-in user with
    // no procure right gets the same 403 whether the id exists or not.
    const gate = await requireRetailRecord(request, db, flag?.material_id || undefined);
    if (!gate.ok) return gateResponse(gate);
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

    const out: Record<string, unknown> = { ok: true, flag_id: id };

    if (hasRate) {
      const rate = Number(body.depot_landed_per_bottle);
      if (!Number.isFinite(rate) || rate <= 0) {
        return Response.json({ error: 'depot_landed_per_bottle must be a number greater than 0 (₹ per bottle).' }, { status: 400 });
      }
      const res = backfillDepotLanded(db, { flagId: id, depotLandedPerBottle: rate, actorEmail: gate.user.email });
      // The rate is the caller's own figure — echoing it tells them nothing.
      out.depot_landed_per_bottle = res.depotLandedPerBottle;
      // The EXCESS is not: it is the rate paid minus that figure, so it hands
      // over SOMEONE ELSE'S retail price (measured: a can_procure bartender
      // outside management priced a colleague's buy at ₹90 and was told excess
      // ₹60/bottle — paid ₹150). Reading the money behind a buy is a management
      // authority, never a can_procure one (requireRetailView), so only a
      // viewer the register itself admits — who sees the rate paid there
      // already — gets it. The POST duplicate refusal uses the same predicate.
      if (canReadRetailRegister(db, gate.user)) out.excess = res.excess;
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
