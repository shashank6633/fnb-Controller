import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
// The liquor category vocabulary, the party-requisition cost/count query and the
// party name resolution now live in ONE place, because /api/party-consumption has
// to show the very rows this route costs — see src/lib/party-liquor.ts for why.
// partyReqSplit() is the verbatim runSplit() that used to sit in this file, so no
// money moves: same FROM, same WHERE, same pack-factor CASE, same parameters.
import { partyReqSplit, loadPnlParties, pnlCandidateNames } from '@/lib/party-liquor';

/**
 * Per-party P&L.
 *
 *   Revenue    = Party Bookings sheet "Final Total Amount" (matched by party_unique_id)
 *   Food Cost  = Σ (party requisition issued qty × material avg price)  matched by event_name+event_date
 *   Liquor Cost= Σ party_consumption cost_at_time (snapshotted)
 *   Profit     = Revenue − (Food + Liquor)
 *   Margin     = Profit / Revenue
 *
 * GET /api/party-events/pnl?party_unique_id=...
 *   OR /api/party-events/pnl?event_name=...&event_date=YYYY-MM-DD
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

/** A party's share of the orphan consumption rows. Zero unless it won a claim. */
const NO_ORPHAN = { cost: 0, n: 0 };

interface OrphanClaimant {
  names: string[];      // every name this party's liquor might have been recorded under
  date?: string;        // the party's event date
  own?: string;         // the party's own event_name — the strongest ownership signal
}

/**
 * WHO OWNS A party_consumption ROW THAT CARRIES NO party_unique_id.
 *
 * POST /api/party-consumption stores `party_unique_id || null` and validates only
 * event_name + event_date, so the bar can record liquor before the AKAN sheet has
 * issued an id — or the sheet can reissue one afterwards. Such a row still belongs
 * to a party, and matching on the id alone dropped it from the board entirely: the
 * banquet looked cheaper than it was on the screen the owner reads first. So these
 * rows are folded back in.
 *
 * THEY MUST BE FOLDED IN ONCE, AND THAT IS WHY THIS FUNCTION EXISTS. A party's
 * candidate names are its contact_person, guest_name, company, event_name and
 * fp_id, so "RAVI" can be one party's guest_name and another party's
 * contact_person on the very same evening. Letting each party match the row for
 * itself — as an `OR (party_unique_id IS NULL AND event_date = ? AND event_name
 * IN (…))` arm inside the per-party query does — hands the SAME physical bottle to
 * BOTH parties: counted on two P&Ls and twice in the /parties totals row. Being
 * one OR over one table only stops a row being counted twice for ONE party; it
 * says nothing about the next party, which runs its own query.
 *
 * So ownership is decided HERE, once per request, across the whole cached party
 * list, and each party is afterwards told only what it won. The winner is the
 * party whose OWN event_name is the name the row was recorded under; failing that,
 * the first party in cache order. The rule is a pure function of the cached list
 * and the row, so the bulk board, /parties and the single-party GET all reach the
 * same answer. A row no cached party claims is left out rather than guessed at.
 */
function claimOrphanConsumption(db: ReturnType<typeof getDb>, claimants: OrphanClaimant[]): Map<number, { cost: number; n: number }> {
  const out = new Map<number, { cost: number; n: number }>();
  const rows = db.prepare(`
    SELECT TRIM(COALESCE(event_name, '')) AS event_name,
           TRIM(COALESCE(event_date, '')) AS event_date,
           COALESCE(cost_at_time, 0)      AS cost
    FROM party_consumption
    WHERE party_unique_id IS NULL
  `).all() as { event_name: string; event_date: string; cost: number }[];
  if (!rows.length) return out;

  // date -> name -> claimant indexes, in cache order. Nested rather than a
  // concatenated key so no separator can ever collide two different pairs.
  const byDate = new Map<string, Map<string, number[]>>();
  claimants.forEach((c, i) => {
    const d = String(c.date || '').trim();
    if (!d) return;
    let byName = byDate.get(d);
    if (!byName) { byName = new Map<string, number[]>(); byDate.set(d, byName); }
    for (const n of c.names) {
      const list = byName.get(n);
      if (list) list.push(i); else byName.set(n, [i]);
    }
  });

  for (const row of rows) {
    if (!row.event_date || !row.event_name) continue;
    const cands = byDate.get(row.event_date)?.get(row.event_name);
    if (!cands || !cands.length) continue;
    const owner = cands.find(i => String(claimants[i].own || '').trim() === row.event_name) ?? cands[0];
    const cur = out.get(owner) || { cost: 0, n: 0 };
    cur.cost += Number(row.cost) || 0;
    cur.n += 1;
    out.set(owner, cur);
  }
  return out;
}

function pnlFor(db: ReturnType<typeof getDb>, bookings: Map<string, number>,
                key: { party_unique_id?: string; event_name?: string; event_date?: string; eventNames?: string[] },
                gate: { allow: boolean; reason: string | null },
                orphan: { cost: number; n: number } = NO_ORPHAN) {
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
    // The query itself is partyReqSplit() in src/lib/party-liquor.ts — a verbatim
    // move of the runSplit() that used to be inlined here, including the
    // reqPackFactor CASE (× pack_size only when the line was requested in the
    // material's purchase unit, e.g. 1 BTL = 750 ml; blank ri.unit stays ×1) and
    // the 'fulfilled'/'store_processed' status pair. It is shared so that
    // /api/party-consumption can list the very liquor rows counted here from the
    // SAME clause — rows that do not add up to this cost would be worse than no
    // rows at all. Same FROM/WHERE/CASE/params in, same numbers out.
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
  // A ROW WITH NO party_unique_id STILL BELONGS TO A PARTY, and `orphan` is this
  // party's EXCLUSIVE share of those rows — decided for every party at once by
  // claimOrphanConsumption() before any of these queries run. It is added, never
  // OR-ed into the query, because the caller is the only place that can see the
  // other parties and so the only place that can stop one bottle landing on two.
  if (key.party_unique_id) {
    const r = db.prepare(`
      SELECT COALESCE(SUM(cost_at_time), 0) AS cost, COUNT(*) AS n
      FROM party_consumption WHERE party_unique_id = ?
    `).get(key.party_unique_id) as { cost: number; n: number };
    liquorFromConsumption = (r.cost || 0) + orphan.cost;
    liquorConsumptionItems = (r.n || 0) + orphan.n;
  } else if (key.event_name && key.event_date) {
    // A party the sheet has issued no id for. Its ID-BEARING rows still match by
    // name + date exactly as they always have; its orphan rows arrive through the
    // same exclusive claim the branch above uses, so a row cannot be counted here
    // AND on an id-bearing party that happens to share this date and name.
    const r = db.prepare(`
      SELECT COALESCE(SUM(cost_at_time), 0) AS cost, COUNT(*) AS n
      FROM party_consumption
      WHERE event_name = ? AND event_date = ? AND party_unique_id IS NOT NULL
    `).get(key.event_name, key.event_date) as { cost: number; n: number };
    liquorFromConsumption = (r.cost || 0) + orphan.cost;
    liquorConsumptionItems = (r.n || 0) + orphan.n;
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
    total_cost: totalCost,
    profit,
    margin,                       // 0..1 (negative possible)
    margin_pct: margin * 100,
    has_revenue: revenue > 0,
    has_liquor_recorded: liquorItems > 0,
  };
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
    const bookings = loadBookingsCache();
    const today = new Date().toISOString().slice(0, 10);
    const parties = loadUpcomingPartiesCache();
    // Orphan consumption rows are assigned to their owning party ONCE, over the
    // whole cached list, before any per-party figure is computed — so the bulk
    // board below and the single-party branch agree, and no row is counted twice.
    const claimants: OrphanClaimant[] = parties.map(p => ({ names: candidateNames(p), date: p.event_date, own: p.event_name }));
    const claims = claimOrphanConsumption(db, claimants);

    if (party_unique_id || (event_name && event_date)) {
      // Resolve the party's status + date from the cache to gate its revenue.
      const p = parties.find(x =>
        (party_unique_id && x.party_unique_id === party_unique_id) ||
        (!party_unique_id && x.event_name === event_name && x.event_date === event_date));
      const gate = revenueGate(p?.status, p?.event_date ?? event_date, today);
      const eventNames = p ? candidateNames(p).concat(event_name ? [event_name] : []) : (event_name ? [event_name] : []);
      // A cached party gets exactly the share the board gave it. A party that is
      // NOT cached cannot appear on the board at all, so it cannot double-count
      // with it: claim for it against the same list with its key appended LAST, so
      // any cached party keeps priority for a row they would both name.
      let orphan = NO_ORPHAN;
      const idx = p ? parties.indexOf(p) : -1;
      if (idx >= 0) {
        orphan = claims.get(idx) || NO_ORPHAN;
      } else if (event_date) {
        const adhoc: OrphanClaimant[] = [...claimants, { names: eventNames, date: event_date, own: event_name }];
        orphan = claimOrphanConsumption(db, adhoc).get(adhoc.length - 1) || NO_ORPHAN;
      }
      const pnl = pnlFor(db, bookings, { party_unique_id, event_name, event_date: p?.event_date ?? event_date, eventNames }, gate, orphan);
      return Response.json({ pnl: financialsAllowed ? pnl : stripFinancials(pnl) });
    }

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
      }, revenueGate(p.status, p.event_date, today), claims.get(i) || NO_ORPHAN),
    }));
    return Response.json({ pnl: financialsAllowed ? out : out.map(stripFinancials) });
  } catch (e: any) {
    console.error('[/api/party-events/pnl GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
