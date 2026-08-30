import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { deviationAlertsInRange, deviationAlertsForGrns } from '@/lib/po-deviation-alerts';
import { rollUpDeviationCounts } from '@/lib/po-deviation-format';

/**
 * OFF-PO DEVIATION ALERTS FOR THE GRN REGISTER.
 *
 *   GET /api/grn/deviations?from=&to=  → every alert on the receipts in that
 *                                        date range, keyed by GRN id
 *   GET /api/grn/deviations?ids=a,b,c  → the same, for named receipts
 *
 * ONE CALL BESIDE THE LIST, never one per row: /grn fetches this exactly like
 * it already fetches GET /api/grn/qc for the hold context, so a page of 200
 * receipts costs one request and the badge cannot flicker in row by row.
 *
 * ── WHAT IT IS FOR ────────────────────────────────────────────────────────
 * The receiving desk ALREADY detects and records every off-PO line (see
 * src/lib/po-deviation-alerts.ts's header for the whole story). This route is
 * the missing reader: the alerts exist in `notifications` and `audit_events`
 * and no screen has ever looked at either. It WRITES NOTHING and re-derives
 * nothing — the receive route stays the only authority on what a deviation is.
 *
 * ── WHO MAY READ IT ───────────────────────────────────────────────────────
 * Any signed-in user, which is EXACTLY the bar GET /api/grn and GET
 * /api/grn/qc already set for the same documents. Nothing new is disclosed:
 * every quantity and rate here is already on the GRN detail panel this
 * decorates, and the PO figures beside them are on /purchase-orders. A narrower
 * gate would hide the badge from the storekeeper who took the delivery — the
 * one person who can still ring the vendor while the truck is outside.
 *
 * ACTING on an alert is a different question and is not opened here: this route
 * has no POST, and nothing about it authorises anything.
 *
 * ── OUTLET-SCOPED, like GET /api/grn — ON BOTH BRANCHES ───────────────────
 * Both branches scope with the same lenient rule as the list they decorate, so
 * the badges and the rows describe the same slice.
 *
 * The ?ids branch used to skip the check, on the reasoning that "an id the
 * caller could not see is an id they could not have sent". That is an
 * assumption about the client, not a server-side gate, and it was demonstrably
 * false: a session in one outlet that obtains a GRN id from another (a shared
 * link, a screenshot, an export, GET /api/notifications' own party_unique_id)
 * got the whole record back — vendor, PO number, receiver, bill discount, and
 * on a line deviation every material, both rates, the value impact and the
 * free-text reason typed at the bay — while the ?from/?to branch correctly
 * returned nothing for the same session. The siblings this route claims parity
 * with refuse exactly that (api/grn/route.ts:326-329, api/grn/qc/route.ts:97-99,
 * whose comment says "what stops working is pasting a GRN id from another
 * outlet"). /grn only ever sends ?from/?to, so the check costs nothing
 * legitimate. Foreign ids are DROPPED rather than 403'd: this is a batch of up
 * to 500 decorating a list, and refusing the whole page's badges over one
 * stray id would break the feature to punish a request nobody makes.
 *
 * ── THE NET-VARIANCE TRAP ─────────────────────────────────────────────────
 * `summary` carries the per-AXIS counts across the range and NO rupee roll-up,
 * deliberately: a cross-document rupee total is the same cancellation the
 * owner complained about, one level up — one GRN over and another short would
 * roll to a tidy ₹0 across the register. Per-alert money stays per alert, where
 * it always travels with its gross pair. See src/lib/po-deviation-format.ts.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);

    const idsParam = String(url.searchParams.get('ids') || '').trim();
    // Read once, for BOTH branches — see the outlet note in the header.
    const outletId = await getCurrentOutletId();
    let byGrn;
    if (idsParam) {
      // Capped so a hand-typed URL cannot ask for the whole table in one bind.
      const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 500);
      byGrn = deviationAlertsForGrns(db, ids, { outletId });
    } else {
      const from = String(url.searchParams.get('from') || '').trim();
      const to   = String(url.searchParams.get('to') || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return Response.json({ error: 'from and to are required (YYYY-MM-DD)' }, { status: 400 });
      }
      byGrn = deviationAlertsInRange(db, { from, to, outletId });
    }

    const flat = Object.values(byGrn).flat();
    return Response.json({
      /** { [grn_id]: GrnDeviationAlert[] } — newest alert first per receipt. */
      alerts: byGrn,
      /** Receipts carrying at least one alert, in this slice. */
      grn_count: Object.keys(byGrn).length,
      /** Per-AXIS roll-up ONLY. No net, no rupee total — see the header. */
      summary: rollUpDeviationCounts(flat),
    });
  } catch (e: any) {
    console.error('[/api/grn/deviations]', e);
    return Response.json({ error: e?.message || 'Could not read deviation alerts' }, { status: 500 });
  }
}
