import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import { checkPurchaseDate } from '@/lib/purchase-guard';
import { LQ_REIMBURSEMENT_STATUS, type LqReimbursementStatus } from '@/lib/liquor-recon';
import {
  recordWineShopPurchase, retailExcessSummary, retailSummaryForViewer, isRealDate, retailErrorResponse,
  RETAIL_DEPOT_WITHHELD_NOTE,
} from '@/lib/liquor-retail';
import {
  requireRetailRecord, requireRetailView, gateResponse, liquorStore, revealDepotFigures,
} from './_lib/guard';

/**
 * EMERGENCY WINE-SHOP PURCHASES — phase L3 (docs/liquor-reconciliation-plan.md).
 *
 *   POST /api/liquor/retail   record ONE wine-shop buy: the bottles land on the
 *                             material's OWN store ledger (ONE 'inward' row,
 *                             unit_cost 0 — where Liquor Store on-hand,
 *                             withdrawals and closing counts read them), and ONE
 *                             lq_retail_flags side record carries the retail ₹.
 *                             NO central purchases row, NO current_stock move,
 *                             NO price column (owner decision 1 — see
 *                             src/lib/liquor-retail.ts for why).
 *   GET  /api/liquor/retail?from=&to=[&outlet=all]
 *                             the §E numbers + the flag rows, for a register and
 *                             for anything that wants the same figures L5 shows.
 *                             MANAGEMENT + a page that shows it, like the L5
 *                             Summary itself; the depot rate and every excess
 *                             figure are ADMIN ONLY (they re-derive the TGBCL
 *                             master rate — retailSummaryForViewer).
 *   PATCH /api/liquor/retail/[id]           correct one record: backfill the
 *                             depot rate on a buy recorded before its brand was
 *                             mapped, and/or correct the claim's status.
 *   POST /api/liquor/retail/[id]/reimburse  close a pending claim with a real
 *                             petty-cash payout (the ONLY writer of 'reimbursed').
 *
 * L3 has NO page of its own; the entry lives on the EXISTING liquor purchase
 * flow and the report is a card on the L5 Summary. This route is the writer and
 * the read model behind both. Every verb gates itself — see ./_lib/guard.ts.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const db = getDb();
    const gate = await requireRetailView(db);
    if (!gate.ok) return gateResponse(gate);

    const sp = new URL(request.url).searchParams;
    const from = sp.get('from') || '';
    const to = sp.get('to') || '';
    // 'all' (or absent) = every outlet; otherwise scope to the current outlet.
    const outletParam = (sp.get('outlet') || '').trim().toLowerCase();
    const outletId = outletParam === 'all' ? null : await getCurrentOutletId();

    const full = retailExcessSummary(db, {
      from: isRealDate(from) ? from : '0000-01-01',
      to: isRealDate(to) ? to : '9999-12-31',
      outletId: outletParam === 'all' ? null : outletId,
      // Scope the depot-spend denominator to THIS liquor store when one is
      // configured; the summary otherwise derives the stores from the flags'
      // own materials. Either way it never joins every store's category map.
      storeId: liquorStore(db)?.id ?? null,
    });
    // Admin-only depot rate + excess: withheld (null, with the reason) for
    // everyone else this gate admits. Fail closed — see liquor-retail.ts.
    const summary = retailSummaryForViewer(full, { revealDepotFigures: revealDepotFigures(gate.user) });
    return Response.json({ summary });
  } catch (e: any) {
    return retailErrorResponse(e, 'Could not load wine-shop purchases.');
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'Send a JSON body.' }, { status: 400 });
    }
    const materialId = String((body as any).material_id || '').trim();
    if (!materialId) return Response.json({ error: 'material_id is required.' }, { status: 400 });

    // Gate FIRST (and CSRF), resolving the store from the material. The gate
    // returns the MATERIAL's own store, which is the store the stock is booked
    // into — so a caller can never book into a store their item is not mapped to.
    const gate = await requireRetailRecord(request, db, materialId);
    if (!gate.ok) return gateResponse(gate);
    const storeId = gate.storeId || liquorStore(db)?.id;
    if (!storeId) return Response.json({ error: 'No liquor store is configured.' }, { status: 400 });

    const b = body as Record<string, unknown>;
    const date = String(b.date || '').trim();
    if (!isRealDate(date)) {
      return Response.json({ error: 'date must be a real calendar date in YYYY-MM-DD (a dateless flag is invisible to every report).' }, { status: 400 });
    }
    const bottles = Number(b.bottles);
    if (!Number.isFinite(bottles) || bottles <= 0) {
      return Response.json({ error: 'bottles must be a number greater than 0 (bottles bought at the shop).' }, { status: 400 });
    }
    const rate = Number(b.rate_paid_per_bottle);
    if (!Number.isFinite(rate) || rate <= 0) {
      return Response.json({ error: 'rate_paid_per_bottle must be a number greater than 0 (₹ actually paid per bottle).' }, { status: 400 });
    }
    // The SAME backdate/future window the central purchase flow enforces
    // (purchase-guard.ts; /api/purchases/route.ts:318), admins exempt. Two
    // reasons it matters here and not only there: a wine-shop run is a physical
    // event that has already happened, and a future-dated store-ledger row
    // would sit in on-hand and every IST-day reconciliation ahead of the day it
    // could physically have arrived.
    const dateCheck = checkPurchaseDate(db, date, gate.user.role === 'admin');
    if (!dateCheck.ok) return Response.json({ error: dateCheck.error }, { status: 400 });

    const reimbursementStatus = String(b.reimbursement_status || 'not_required') as LqReimbursementStatus;
    if (!(LQ_REIMBURSEMENT_STATUS as readonly string[]).includes(reimbursementStatus)) {
      return Response.json({
        error: `reimbursement_status must be one of: ${LQ_REIMBURSEMENT_STATUS.join(', ')}.`,
      }, { status: 400 });
    }
    // 'reimbursed' is refused in the library too (that is the invariant's home);
    // saying so here gives the screen a sentence instead of a generic 400.
    if (reimbursementStatus === 'reimbursed') {
      return Response.json({
        error: "A wine-shop buy cannot be recorded as already 'reimbursed' — that state is set only by a real petty-cash payout "
          + "(POST /api/liquor/retail/<id>/reimburse). Record it as 'claimed_pending', or 'not_required' if nobody is owed anything.",
      }, { status: 400 });
    }
    const overrideRaw = b.depot_landed_override;
    const depotLandedOverride = overrideRaw === undefined || overrideRaw === null || String(overrideRaw).trim() === ''
      ? null : Number(overrideRaw);
    // > 0, not >= 0. resolveDepotLanded only honours a positive override, so a 0
    // was accepted here and then silently downgraded to depot_source:'unknown' —
    // the caller was told nothing and got a flag it did not ask for. A depot rate
    // of zero is not a rate; leave the field empty to record "unknown" on purpose.
    if (depotLandedOverride != null && (!Number.isFinite(depotLandedOverride) || depotLandedOverride <= 0)) {
      return Response.json({
        error: 'depot_landed_override, when given, must be a number greater than 0 (₹ per bottle). Leave it out to record the buy with the depot rate unknown.',
      }, { status: 400 });
    }

    const outletId = await getCurrentOutletId();

    const result = recordWineShopPurchase(db, {
      materialId,
      bottles,
      ratePaidPerBottle: rate,
      date,
      shopName: String(b.shop_name || '').trim(),
      shopLicenceNo: String(b.shop_licence_no || '').trim(),
      paidBy: String(b.paid_by || '').trim(),
      paymentMode: String(b.payment_mode || '').trim(),
      reason: String(b.reason || '').trim(),
      approvedBy: String(b.approved_by || '').trim(),
      reimbursementStatus,
      billRef: String(b.bill_ref || '').trim(),
      sizeCode: String(b.size_code || '').trim(),
      depotLandedOverride,
      brand: String(b.brand || '').trim(),
      notes: String(b.notes || '').trim(),
      outletId,
      storeId,
    }, gate.user.email);

    // WHAT THE RECORDER IS TOLD ABOUT THE DEPOT RATE. A rate resolved from the
    // Brand Map ('landed') IS the admin-only TGBCL master per bottle whenever the
    // brand has no recorded indent (basis 'master_only'), and the excess is the
    // rate paid minus it (RETAIL_DEPOT_WITHHELD_NOTE).
    // This reply goes to anyone with can_procure (bar staff, any 'Bar Manager'
    // position), so it used to hand the master to the paisa to whoever recorded
    // a buy (measured: 760.28 × 12 = the 9,123.36 master). Only an admin is
    // told those figures. An OVERRIDE is the caller's own typed rate and the
    // rate paid is their own input too, so echoing both tells them nothing new.
    // 'unknown' has no figure to withhold. depot_source / depot_detail are words.
    const showDepot = revealDepotFigures(gate.user) || result.depotSource === 'override';
    const depotWithheld = !showDepot && result.depotSource !== 'unknown';

    return Response.json({
      ok: true,
      // Always null now — no central purchases row is written. Kept so a
      // caller that reads the key gets an explicit "none", not undefined.
      purchase_id: result.purchaseId,
      flag_id: result.flagId,
      // WHERE the bottles went: the store-ledger row, and the store it is in.
      ledger_id: result.ledgerId,
      store_id: result.storeId,
      store_name: result.storeName,
      stock_qty: result.stockQty,
      depot_landed_per_bottle: depotWithheld ? null : result.depotLandedPerBottle,
      depot_source: result.depotSource,
      depot_detail: result.depotDetail,
      excess: depotWithheld ? null : result.excess,
      // true → the buy IS priced and its figures are withheld from this viewer.
      depot_figures_withheld: depotWithheld,
      ...(depotWithheld ? { depot_figures_note: RETAIL_DEPOT_WITHHELD_NOTE } : {}),
      total_paid: result.totalPaid,
      // A buy we could not price is recorded, but the client is told plainly so
      // it can prompt for a depot rate rather than trusting a silent 0 — and it
      // is told WHERE to supply it, because the old wording promised a backfill
      // ("until a rate is known") that no route could then perform.
      ...(result.depotSource === 'unknown'
        ? {
            warning: 'Depot landed cost is unknown for this brand (not mapped in the TGBCL Brand Map, and no depot rate was supplied) — '
              + 'the excess was recorded as 0 and is excluded from the "price of running out" total. '
              + `Supply it later with PATCH /api/liquor/retail/${result.flagId} { "depot_landed_per_bottle": … } and the excess is computed then.`,
          }
        : {}),
      // e.g. cash was taken straight from the box: the box is NOT debited here.
      ...(result.notice ? { notice: result.notice } : {}),
    }, { status: 201 });
  } catch (e: any) {
    // Business refusals (duplicate bill 409, unknown material 404, bad figure
    // 400) carry their own status; only a genuine fault reaches 500.
    return retailErrorResponse(e, 'Could not record the wine-shop purchase.');
  }
}
