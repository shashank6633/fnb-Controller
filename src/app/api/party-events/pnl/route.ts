import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
// The liquor category vocabulary, the party-requisition cost/count query, the
// party name resolution and the orphan-liquor claim now live in ONE place,
// because /api/party-consumption has to show the very rows this route costs —
// see src/lib/party-liquor.ts for why. partyReqSplit() costs the same lines the
// runSplit() that used to sit in this file costed (same FROM, same WHERE, same
// parameters); its line→recipe conversion is now the party rail's own
// lineFactor(), measured identical to the old CASE on every live line.
import {
  partyReqSplit, loadPnlParties, pnlCandidateNames, findPnlPartyIndex,
  orphanClaimants, orphanSlot, claimOrphanConsumption, orphanShareOf,
  noIdPartiesCountingName,
  type OrphanClaims, type OrphanRow, type CachedPnlParty,
} from '@/lib/party-liquor';

/**
 * Per-party P&L.
 *
 *   Revenue    = Party Bookings sheet "Final Total Amount" (matched by party_unique_id)
 *   Food Cost  = Σ (party requisition issued qty × material avg price), non-liquor
 *                categories, matched by event_name+event_date
 *   Liquor Cost= Σ the same for liquor/beverage categories (the Bar requisition)
 *              + Σ party_consumption cost_at_time (snapshotted) for the party's id,
 *              + the orphan rows (no id) that ONLY this party matches by name
 *                (owner ruling 2026-10-14 — see src/lib/party-liquor.ts)
 *   Profit     = Revenue − (Food + Liquor)
 *   Margin     = Profit / Revenue
 *
 * GET /api/party-events/pnl?party_unique_id=...
 *   OR /api/party-events/pnl?event_name=...&event_date=YYYY-MM-DD[&fp_id=...]
 *      (fp_id names which party without an id is meant when the display name is
 *       shared that evening — see findPnlPartyIndex)
 *   OR /api/party-events/pnl                 (returns array for all known past events)
 *
 * Booking revenue is read from the cached 'party_bookings_cache' setting so
 * this endpoint is fast — caller refreshes the cache via POST /api/party-bookings.
 */
export const dynamic = 'force-dynamic';

interface BookingCache {
  bookings: { party_unique_id: string; final_total: number }[];
}

function loadBookingsCache(): Map<string, number> {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'party_bookings_cache'`).get() as { value: string } | undefined;
    if (!row) return new Map();
    const parsed = JSON.parse(row.value) as BookingCache;
    const m = new Map<string, number>();
    for (const b of parsed.bookings || []) m.set(b.party_unique_id, Number(b.final_total) || 0);
    return m;
  } catch {
    return new Map();
  }
}

// Cached F&P parties. The body moved to src/lib/party-liquor.ts (loadPnlParties)
// unchanged — the consumption modal must resolve a party to the same names this
// board does, or the rows it shows will not reconcile with the cost printed here.
function loadUpcomingPartiesCache() {
  return loadPnlParties(getDb());
}

/**
 * Booking Final-Total counts as party REVENUE only when BOTH hold:
 *   1. the party is locked-in — F&P Records status 'Approved' (the value the AKAN
 *      Party Manager sheet actually uses; 'Confirmed'/'Done' accepted as synonyms).
 *      Verified against live GCP data 2026-07-05: statuses are Approved | Draft.
 *   2. the event date is over (event_date <= today) — no revenue for future parties.
 * Returns the reason it's withheld (or null when eligible) so the UI can explain.
 */
function revenueGate(status: string | undefined, eventDate: string | undefined, today: string): { allow: boolean; reason: string | null } {
  const s = String(status || '').trim().toLowerCase();
  const confirmed = s === 'approved' || s === 'confirmed' || s === 'done';
  if (!confirmed) return { allow: false, reason: 'awaiting confirmation' };
  if (!eventDate || eventDate > today) return { allow: false, reason: 'party not over yet' };
  return { allow: true, reason: null };
}

/** All names a party's requisition might have been raised under. Body moved to
 *  src/lib/party-liquor.ts (pnlCandidateNames) so /api/party-consumption resolves
 *  the identical name set — see loadUpcomingPartiesCache above. */
const candidateNames = pnlCandidateNames;

/**
 * A party's share of the ORPHAN consumption rows (no party_unique_id), as decided
 * by claimOrphanConsumption() in src/lib/party-liquor.ts — the ONE rule the
 * consumption modal applies too (owner ruling 2026-10-14):
 *   matched  — rows ONLY this party matches by name that evening: charged here,
 *              and reported separately so the screen can say "matched by name";
 *   awaiting — rows this party AND at least one other match: charged to NOBODY
 *              until the owner assigns them; counted here only as a number so the
 *              badge can say a bottle is waiting rather than missing.
 */
interface OrphanShare { matchedCost: number; matchedN: number; awaitingN: number }
const NO_ORPHAN: OrphanShare = { matchedCost: 0, matchedN: 0, awaitingN: 0 };

function shareFor(claims: OrphanClaims, index: number): OrphanShare {
  const { matched, awaiting } = orphanShareOf(claims, index);
  return {
    matchedCost: matched.reduce((a, r) => a + (Number(r.cost) || 0), 0),
    matchedN: matched.length,
    awaitingN: awaiting.length,
  };
}

function pnlFor(db: ReturnType<typeof getDb>, bookings: Map<string, number>,
                key: { party_unique_id?: string; event_name?: string; event_date?: string; eventNames?: string[] },
                gate: { allow: boolean; reason: string | null },
                orphan: OrphanShare = NO_ORPHAN) {
  // Revenue = Party Bookings Final Total (matched by party_unique_id) — but ONLY
  // counted once the party is confirmed/done AND its date has passed (gate). The
  // raw booking total is still returned so the UI can show "₹X — <reason>".
  const bookingTotal = key.party_unique_id ? (bookings.get(key.party_unique_id) || 0) : 0;
  const revenue = gate.allow ? bookingTotal : 0;

  // Food cost from party requisitions. A requisition links to a party ONLY by
  // event_name+date (no party_unique_id), and the name it was raised with may be
  // the contact person, the company, or the FP id — so match on the date + ANY of
  // the party's candidate names, not a single guessed one (else food cost = ₹0).
  let foodCost = 0;
  let foodItems = 0;
  let liquorFromReqs = 0;      // Bar / liquor / beverage requisition items → liquor cost, not food
  let liquorFromReqItems = 0;
  const names = [...new Set(
    (key.eventNames && key.eventNames.length ? key.eventNames : (key.event_name ? [key.event_name] : []))
      .map(n => String(n || '').trim()).filter(Boolean)
  )];
  if (names.length && key.event_date) {
    // ACTUALS, not estimates: cost the ISSUED quantity (what the store actually
    // handed over) × avg price, only for FULFILLED requisitions. AND split by
    // category: liquor / beer / wine / spirits / beverages / mixers are costed as
    // LIQUOR, everything else as FOOD.
    //
    // The query itself is partyReqSplit() in src/lib/party-liquor.ts — the same
    // FROM / WHERE / parameters and the 'fulfilled'/'store_processed' status pair
    // as the runSplit() that used to be inlined here. Its line→recipe conversion
    // is the party rail's own lineFactor() (× pack_size only when the line is in
    // the material's purchase unit, e.g. 1 BTL = 750 ml), which replaced the
    // hand-rolled CASE when the over-issue clamp landed; measured identical on all
    // 16,353 live requisition lines. It costs the HAND-OVER (quantity_issued),
    // not the central debit: since the clamp a Liquor Store (TGBCL) bottle on a
    // party requisition moves no central stock, and it is still the party's cost.
    // It is shared so that /api/party-consumption can list the very liquor rows
    // counted here from the SAME clause — rows that do not add up to this cost
    // would be worse than no rows at all.
    const food = partyReqSplit(db, names, key.event_date, 'NOT IN');
    foodCost = food.cost;
    foodItems = food.item_count;
    const liq = partyReqSplit(db, names, key.event_date, 'IN');
    liquorFromReqs = liq.cost;
    liquorFromReqItems = liq.item_count;
  }

  // Liquor cost has TWO sources that don't overlap:
  //   1. party_consumption  — liquor drawn straight from the bar and logged on the
  //      Liquor Consumption screen (cost snapshotted as cost_at_time).
  //   2. requisition items in a liquor/beverage category (computed above as
  //      liquorFromReqs) — bar/beverage materials the Bar dept requisitioned from
  //      the store for the party. These are the "Bar items, Liquor, Beverages"
  //      the user wants pulled out of food cost and into liquor cost.
  let liquorFromConsumption = 0;
  let liquorConsumptionItems = 0;
  // A ROW WITH NO party_unique_id STILL BELONGS TO A PARTY — but only when
  // exactly one party that evening matches its name (owner ruling 2026-10-14).
  // `orphan` is this party's share, decided for every party at once by
  // claimOrphanConsumption() before any of these queries run. It is ADDED, never
  // OR-ed into the query, because only the caller can see the other parties, and
  // so only the caller can tell "this party alone" from "this party and another".
  if (key.party_unique_id) {
    const r = db.prepare(`
      SELECT COALESCE(SUM(cost_at_time), 0) AS cost, COUNT(*) AS n
      FROM party_consumption WHERE party_unique_id = ?
    `).get(key.party_unique_id) as { cost: number; n: number };
    liquorFromConsumption = (r.cost || 0) + orphan.matchedCost;
    liquorConsumptionItems = (r.n || 0) + orphan.matchedN;
  } else if (key.event_name && key.event_date) {
    // A party the sheet has issued no id for. Its ID-BEARING rows match by its
    // own event_name + date, exactly as production always matched them; its
    // orphan rows arrive only through the exactly-one claim above.
    //
    // NOT SOLVED HERE (pre-existing, unchanged from production 6cd5615): an
    // id-bearing row recorded under the SAME event_name and date as this party is
    // counted here AND on the party that owns that id. The owner's ruling covers
    // orphan rows only; this arm is left exactly as production had it.
    //
    // MIRRORED by noIdPartiesCountingName() in src/lib/party-liquor.ts, which
    // stops PATCH /api/party-consumption from MAKING such a row (assigning an
    // orphan recorded under this party's name to another party). Change this arm
    // and that predicate together, or the guard stops matching what is counted.
    const r = db.prepare(`
      SELECT COALESCE(SUM(cost_at_time), 0) AS cost, COUNT(*) AS n
      FROM party_consumption
      WHERE event_name = ? AND event_date = ? AND party_unique_id IS NOT NULL
    `).get(key.event_name, key.event_date) as { cost: number; n: number };
    liquorFromConsumption = (r.cost || 0) + orphan.matchedCost;
    liquorConsumptionItems = (r.n || 0) + orphan.matchedN;
  }

  const liquorCost = liquorFromConsumption + liquorFromReqs;
  const liquorItems = liquorConsumptionItems + liquorFromReqItems;

  const totalCost = foodCost + liquorCost;
  const profit = revenue - totalCost;
  const margin = revenue > 0 ? profit / revenue : 0;

  return {
    revenue,
    booking_total: bookingTotal,            // raw Final Total from the sheet (before the gate)
    revenue_eligible: gate.allow,
    revenue_withheld_reason: gate.reason,   // null when counted; else why it isn't
    food_cost: foodCost,
    food_items: foodItems,
    liquor_cost: liquorCost,
    liquor_items: liquorItems,
    liquor_from_consumption: liquorFromConsumption,   // logged on the Liquor Consumption screen
    liquor_from_requisitions: liquorFromReqs,         // bar/beverage requisition items pulled out of food
    // PER-SOURCE COUNTS, so the badge can say WHERE to look instead of only HOW
    // MANY. liquor_items is the sum of these two and stays the authoritative total.
    // Without them the list could only print a merged "N items recorded", which
    // sent people to a modal that shows one source and invited them to re-type the
    // other — the double count this split exists to prevent.
    liquor_consumption_items: liquorConsumptionItems,  // rows recorded on the Liquor Consumption screen
    liquor_requisition_items: liquorFromReqItems,      // Bar requisition lines, already costed
    // ORPHAN rows (no party id). matched_by_name is INCLUDED in
    // liquor_consumption_items / liquor_from_consumption above — it is the part of
    // them that rests on the name alone. unassigned is NOT included anywhere: it
    // names this party and another that evening, so it is charged to nobody until
    // the owner assigns it (owner ruling 2026-10-14).
    liquor_matched_by_name_items: orphan.matchedN,
    liquor_matched_by_name_cost: orphan.matchedCost,
    liquor_unassigned_items: orphan.awaitingN,
    total_cost: totalCost,
    profit,
    margin,                       // 0..1 (negative possible)
    margin_pct: margin * 100,
    has_revenue: revenue > 0,
    has_liquor_recorded: liquorItems > 0,
  };
}

/**
 * The orphan rows the claim charged to NO party, described for the owner:
 *   reason 'several_parties' — two or more parties that evening carry the name
 *     (candidates lists them; one with a party_unique_id can be assigned);
 *   reason 'no_party'        — no cached party that evening carries the name.
 * Ordered as the claim read them (recorded_at, id).
 *
 * assign_blocked_by — the parties WITHOUT an id listed under the row's exact name
 * that evening (noIdPartiesCountingName, read on the row's RAW name/date as the
 * no-id arm reads them). While it is non-empty PATCH /api/party-consumption
 * refuses every assignment of the row (it would count on that party too), so the
 * page shows this list instead of Assign buttons the server would refuse.
 */
function describeUnassigned(db: ReturnType<typeof getDb>, claims: OrphanClaims, parties: CachedPnlParty[]) {
  const items: { row: OrphanRow; reason: 'several_parties' | 'no_party'; candidates: number[] }[] = [
    ...claims.ambiguous.map(a => ({ row: a.row, reason: 'several_parties' as const, candidates: a.candidates })),
    ...claims.unmatched.map(row => ({ row, reason: 'no_party' as const, candidates: [] as number[] })),
  ];
  if (!items.length) return [];
  const detail = db.prepare(`
    SELECT pc.id, pc.material_id, pc.qty_consumed, pc.cost_at_time, pc.notes,
           pc.recorded_by, pc.recorded_at, pc.fp_id,
           pc.event_name AS raw_event_name, pc.event_date AS raw_event_date,
           rm.name AS material_name, rm.unit AS material_unit
    FROM party_consumption pc
    LEFT JOIN raw_materials rm ON rm.id = pc.material_id
    WHERE pc.id = ?
  `);
  return items.map(({ row, reason, candidates }) => {
    const d = (detail.get(row.id) || {}) as Record<string, any>;
    const blocked = noIdPartiesCountingName(parties, d.raw_event_name, d.raw_event_date);
    return {
      id: row.id,
      event_name: row.event_name,
      event_date: row.event_date,
      reason,
      material_id: d.material_id ?? null,
      material_name: d.material_name ?? null,
      material_unit: d.material_unit ?? null,
      qty_consumed: d.qty_consumed ?? null,
      cost_at_time: Number(row.cost) || 0,
      notes: d.notes ?? '',
      recorded_by: d.recorded_by ?? null,
      recorded_at: d.recorded_at ?? null,
      candidates: candidates.map(i => ({
        party_unique_id: parties[i]?.party_unique_id || null,
        fp_id: parties[i]?.fp_id || null,
        event_name: parties[i]?.event_name || '',
        event_date: parties[i]?.event_date || '',
      })),
      assign_blocked_by: blocked.map(i => ({
        fp_id: parties[i]?.fp_id || null,
        event_name: parties[i]?.event_name || '',
        event_date: parties[i]?.event_date || '',
      })),
    };
  });
}

/**
 * Strip the FINANCIAL fields (revenue / food cost / profit / margin) from a
 * P&L row, keeping only what the liquor-consumption recorder needs: event
 * identity + the liquor fields. Liquor cost is NOT withheld — the same numbers
 * are already visible to every signed-in user via GET /api/party-consumption
 * (cost_at_time), and the bar recorder needs them to see what's punched.
 */
function stripFinancials(row: any) {
  return {
    party_unique_id: row.party_unique_id,
    fp_id: row.fp_id,
    event_name: row.event_name,
    event_date: row.event_date,
    guest_name: row.guest_name,
    status: row.status,
    pax: row.pax,
    liquor_cost: row.liquor_cost,
    liquor_items: row.liquor_items,
    // The per-source counts travel with liquor_items, NOT with the financials.
    // They are counts, not money, and they are exactly what the bar/service user
    // recording consumption needs in order to see that a bottle is already costed
    // from a requisition. Dropping them here would render the split badge as
    // "0 from requisitions · 0 recorded here" for precisely the staff this
    // stripped payload exists to serve.
    liquor_consumption_items: row.liquor_consumption_items,
    liquor_requisition_items: row.liquor_requisition_items,
    // Same reasoning: the bar recorder must see that a bottle was matched by name
    // or is waiting for the owner, or they will type it in again.
    liquor_matched_by_name_items: row.liquor_matched_by_name_items,
    liquor_matched_by_name_cost: row.liquor_matched_by_name_cost,
    liquor_unassigned_items: row.liquor_unassigned_items,
    has_liquor_recorded: row.has_liquor_recorded,
    financials_hidden: true,
  };
}

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    // Party P&L is financial data (revenue / cost / margin). Restrict FINANCIALS
    // to the same audience that sees party financials elsewhere (party-events
    // page + route): admin or a department head. Plain staff (bar / service) DO
    // need the event LIST to record liquor consumption on /party-pnl — a hard
    // 403 here bricked that page for Bar users granted /party-pnl. So: full
    // payload for admin/HOD, stripped non-financial payload for everyone else.
    const financialsAllowed = me.role === 'admin' || me.is_head_chef;
    const db = getDb();
    const url = new URL(request.url);
    const party_unique_id = url.searchParams.get('party_unique_id') || undefined;
    const event_name      = url.searchParams.get('event_name') || undefined;
    const event_date      = url.searchParams.get('event_date') || undefined;
    // Which party WITHOUT an id is meant when its display name is shared that
    // evening (findPnlPartyIndex). Without it the first party of that name won.
    const fp_id           = url.searchParams.get('fp_id') || undefined;
    const bookings = loadBookingsCache();
    const today = new Date().toISOString().slice(0, 10);
    const parties = loadUpcomingPartiesCache();

    if (party_unique_id || (event_name && event_date)) {
      // Resolve the party's status + date from the cache to gate its revenue.
      const idx = findPnlPartyIndex(parties, { party_unique_id, fp_id, event_name, event_date });
      const p = idx >= 0 ? parties[idx] : undefined;
      const gate = revenueGate(p?.status, p?.event_date ?? event_date, today);
      const eventNames = p ? candidateNames(p).concat(event_name ? [event_name] : []) : (event_name ? [event_name] : []);
      // ORPHAN SHARE, from the SAME claimant list the board uses. A cached party
      // is its own index, so it gets exactly the share the board gave it. A key no
      // cached party matches is appended as one more party that evening (see
      // orphanSlot) — under the exactly-one rule it can then win only a row no
      // cached party also matches, so it can never take a bottle the board
      // already charged.
      const slot = orphanSlot(parties, { party_unique_id, fp_id, event_name, event_date });
      const orphan = shareFor(claimOrphanConsumption(db, slot.claimants), slot.index);
      const pnl = pnlFor(db, bookings, { party_unique_id, event_name, event_date: p?.event_date ?? event_date, eventNames }, gate, orphan);
      return Response.json({ pnl: financialsAllowed ? pnl : stripFinancials(pnl) });
    }

    // Orphan consumption rows are claimed ONCE, over the whole cached list, before
    // any per-party figure is computed — so every row on this board, the
    // single-party branch above and the consumption modal reach the same answer.
    const claims = claimOrphanConsumption(db, orphanClaimants(parties));

    // Bulk: every cached party. Booking revenue is counted ONLY for Confirmed/Done
    // parties whose date has passed (revenueGate); otherwise revenue shows 0 with a reason.
    const out = parties.map((p, i) => ({
      party_unique_id: p.party_unique_id,
      fp_id: p.fp_id,
      event_name: p.event_name || '',
      event_date: p.event_date || '',
      guest_name: p.guest_name,
      status: p.status,
      // Kitchen-canonical headcount: min_guarantee (contracted) first; pax_expected as fallback
      pax: p.min_guarantee || p.pax_expected,
      ...pnlFor(db, bookings, {
        party_unique_id: p.party_unique_id,
        event_name: p.event_name,
        event_date: p.event_date,
        eventNames: candidateNames(p),
      }, revenueGate(p.status, p.event_date, today), shareFor(claims, i)),
    }));
    return Response.json({
      pnl: financialsAllowed ? out : out.map(stripFinancials),
      // The orphan rows charged to NO party — for the owner to assign. Liquor
      // cost is visible to every signed-in user already (see stripFinancials),
      // so the list is not withheld; ASSIGNING is admin-only (can_assign).
      unassigned_liquor: describeUnassigned(db, claims, parties),
      can_assign: me.role === 'admin',
    });
  } catch (e: any) {
    console.error('[/api/party-events/pnl GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
