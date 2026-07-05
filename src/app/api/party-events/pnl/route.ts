import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

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

function loadUpcomingPartiesCache(): { party_unique_id?: string; fp_id?: string; event_name?: string; event_date?: string; guest_name?: string; company?: string; contact_person?: string; pax_expected?: number; min_guarantee?: number; status?: string }[] {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'upcoming_parties_cache'`).get() as { value: string } | undefined;
    if (!row) return [];
    const parsed = JSON.parse(row.value);
    return (parsed.parties || []).map((p: any) => ({
      party_unique_id: p.party_unique_id,
      fp_id: p.fp_id,
      event_name: p.guest_name || p.company || p.contact_person || p.fp_id,
      event_date: p.date_of_event,
      guest_name: p.guest_name,
      company: p.company,
      contact_person: p.contact_person,
      pax_expected: p.pax_expected,
      min_guarantee: p.min_guarantee,
      status: p.status,               // F&P Records status: Draft | Confirmed | Done | Cancelled
    }));
  } catch {
    return [];
  }
}

/**
 * Booking Final-Total counts as party REVENUE only when BOTH hold:
 *   1. the F&P Records status is Confirmed or Done (locked-in), and
 *   2. the event date is over (event_date <= today) — no revenue for future parties.
 * Returns the reason it's withheld (or null when eligible) so the UI can explain.
 */
function revenueGate(status: string | undefined, eventDate: string | undefined, today: string): { allow: boolean; reason: string | null } {
  const s = String(status || '').trim().toLowerCase();
  const confirmed = s === 'confirmed' || s === 'done';
  if (!confirmed) return { allow: false, reason: 'awaiting confirmation' };
  if (!eventDate || eventDate > today) return { allow: false, reason: 'party not over yet' };
  return { allow: true, reason: null };
}

function pnlFor(db: ReturnType<typeof getDb>, bookings: Map<string, number>,
                key: { party_unique_id?: string; event_name?: string; event_date?: string },
                gate: { allow: boolean; reason: string | null }) {
  // Revenue = Party Bookings Final Total (matched by party_unique_id) — but ONLY
  // counted once the party is confirmed/done AND its date has passed (gate). The
  // raw booking total is still returned so the UI can show "₹X — <reason>".
  const bookingTotal = key.party_unique_id ? (bookings.get(key.party_unique_id) || 0) : 0;
  const revenue = gate.allow ? bookingTotal : 0;

  // Food cost from party requisitions
  let foodCost = 0;
  let foodItems = 0;
  if (key.event_name && key.event_date) {
    const food = db.prepare(`
      SELECT COALESCE(SUM(ri.quantity_requested * rm.average_price), 0) AS cost,
             COUNT(ri.id) AS item_count
      FROM requisitions r
      JOIN requisition_items ri ON ri.req_id = r.id
      JOIN raw_materials rm ON rm.id = ri.material_id
      WHERE r.purpose = 'party'
        AND r.event_name = ?
        AND r.event_date = ?
        AND r.status NOT IN ('cancelled', 'chef_rejected')
    `).get(key.event_name, key.event_date) as { cost: number; item_count: number };
    foodCost = food.cost || 0;
    foodItems = food.item_count || 0;
  }

  // Liquor cost from party_consumption
  let liquorCost = 0;
  let liquorItems = 0;
  if (key.party_unique_id) {
    const r = db.prepare(`
      SELECT COALESCE(SUM(cost_at_time), 0) AS cost, COUNT(*) AS n
      FROM party_consumption WHERE party_unique_id = ?
    `).get(key.party_unique_id) as { cost: number; n: number };
    liquorCost = r.cost || 0;
    liquorItems = r.n || 0;
  } else if (key.event_name && key.event_date) {
    const r = db.prepare(`
      SELECT COALESCE(SUM(cost_at_time), 0) AS cost, COUNT(*) AS n
      FROM party_consumption WHERE event_name = ? AND event_date = ?
    `).get(key.event_name, key.event_date) as { cost: number; n: number };
    liquorCost = r.cost || 0;
    liquorItems = r.n || 0;
  }

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
    total_cost: totalCost,
    profit,
    margin,                       // 0..1 (negative possible)
    margin_pct: margin * 100,
    has_revenue: revenue > 0,
    has_liquor_recorded: liquorItems > 0,
  };
}

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);
    const party_unique_id = url.searchParams.get('party_unique_id') || undefined;
    const event_name      = url.searchParams.get('event_name') || undefined;
    const event_date      = url.searchParams.get('event_date') || undefined;
    const bookings = loadBookingsCache();
    const today = new Date().toISOString().slice(0, 10);
    const parties = loadUpcomingPartiesCache();

    if (party_unique_id || (event_name && event_date)) {
      // Resolve the party's status + date from the cache to gate its revenue.
      const p = parties.find(x =>
        (party_unique_id && x.party_unique_id === party_unique_id) ||
        (!party_unique_id && x.event_name === event_name && x.event_date === event_date));
      const gate = revenueGate(p?.status, p?.event_date ?? event_date, today);
      const pnl = pnlFor(db, bookings, { party_unique_id, event_name, event_date }, gate);
      return Response.json({ pnl });
    }

    // Bulk: every cached party. Booking revenue is counted ONLY for Confirmed/Done
    // parties whose date has passed (revenueGate); otherwise revenue shows 0 with a reason.
    const out = parties.map(p => ({
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
      }, revenueGate(p.status, p.event_date, today)),
    }));
    return Response.json({ pnl: out });
  } catch (e: any) {
    console.error('[/api/party-events/pnl GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
