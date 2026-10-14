/**
 * PARTY LIQUOR — one definition of "liquor that came from a party requisition".
 *
 * WHY THIS FILE EXISTS. A party's liquor cost has TWO sources that are stored in
 * two different tables and share no key:
 *
 *   1. party_consumption      — bottles drawn straight from the bar and logged on
 *                               the Party Liquor Consumption screen (cost snapshotted
 *                               as cost_at_time).
 *   2. party requisition items in a liquor/beverage category — bar/beverage
 *      materials the Bar department requisitioned and the STORE ACTUALLY ISSUED,
 *      costed at issued qty × average_price for fulfilled/store_processed reqs.
 *
 * /api/party-events/pnl adds both into liquor_cost. The modal on /party-pnl used
 * to read source 1 ONLY, so a party whose liquor came entirely from a bar
 * requisition showed "1 item recorded" on the list and "Nothing recorded for this
 * event yet." in the modal. The empty modal then invited someone to type the
 * bottle in by hand — and that bottle was ALREADY costed, so the party's liquor
 * cost doubled on a P&L the owner prices events from.
 *
 * So the requisition rows are now READ-ONLY in that modal, and this file is the
 * single place the rows, the money and the counts are derived from. THE MONEY AND
 * THE ROWS MUST COME FROM THE SAME WHERE CLAUSE AND THE SAME PACK-FACTOR
 * EXPRESSION, or the rows shown will not add up to the cost printed beside them —
 * which is the whole point of showing them. Hence ISSUED_RECIPE_QTY and
 * partyReqSource() below are shared by every query here; do not inline a copy.
 *
 * NOT A MONEY CHANGE: partyReqSplit() is a verbatim lift of the runSplit() query
 * that used to live in /api/party-events/pnl. Same FROM, same WHERE, same CASE,
 * same parameter order — so food_cost, liquor_cost and the item counts are
 * unchanged. Proven by running both against the same fixtures.
 */
import type { getDb } from '@/lib/db';

type DB = ReturnType<typeof getDb>;

// Bar items, liquor, spirits, wine, beer, beverages and mixers are costed as
// LIQUOR COST — never food — regardless of which department requisitioned them.
// Lower-cased, trimmed raw_materials.category values. Keep in sync with the
// material category vocabulary.
export const LIQUOR_CATEGORIES = [
  'bar', 'beer', 'beverages', 'beverage', 'liquor', 'liqueur', 'spirits', 'spirit',
  'blended-scotch', 'bourbon', 'single-malt-whiskey', 'whiskey', 'whisky', 'scotch',
  'rum', 'vodka', 'gin', 'brandy', 'tequila', 'wine', 'red-wine', 'white-wine',
  'champagne', 'sparkling-wine', 'syrups', 'syrup', 'crush', 'puree', 'mixers',
  'mixer', 'mocktail', 'cocktail', 'aerated', 'soft-drink', 'soft-drinks', 'juices', 'juice',
];

/**
 * ISSUED quantity in RECIPE units. quantity_issued is stored in ri.unit; convert
 * with the SAME pack factor the requisition screens use (reqPackFactor):
 * × pack_size only when the line was requested in the material's purchase unit
 * (1 BTL = 750 ml). Legacy rows with a blank ri.unit stay ×1, matching how they
 * display everywhere else. × average_price (₹ per RECIPE unit) gives rupees.
 */
const ISSUED_RECIPE_QTY = `ri.quantity_issued
               * (CASE WHEN COALESCE(TRIM(ri.unit),'') <> '' AND ri.unit = rm.purchase_unit
                            AND ri.unit <> rm.unit AND COALESCE(rm.pack_size,1) > 1
                       THEN rm.pack_size ELSE 1 END)`;

/**
 * The FROM + WHERE every party-requisition query here shares.
 *
 * ACTUALS, not estimates: only FULFILLED (and store_processed) requisitions, and
 * the ISSUED quantity — what the store actually handed over. A part-issued party
 * req now correctly stays 'store_processed' rather than being mis-stamped
 * 'fulfilled'; its goods still left the store, so excluding it would silently
 * drop real cost from the party P&L.
 *
 * Parameter order is (…names, eventDate, …LIQUOR_CATEGORIES) — bind with
 * partyReqParams() so a caller cannot get it wrong.
 */
function partyReqSource(names: string[], inOrNotIn: 'IN' | 'NOT IN'): string {
  const ph  = names.map(() => '?').join(',');
  const lph = LIQUOR_CATEGORIES.map(() => '?').join(',');
  return `
      FROM requisitions r
      JOIN requisition_items ri ON ri.req_id = r.id
      JOIN raw_materials rm ON rm.id = ri.material_id
      WHERE r.purpose = 'party'
        AND r.event_name IN (${ph})
        AND r.event_date = ?
        AND r.status IN ('fulfilled', 'store_processed')
        AND LOWER(TRIM(COALESCE(rm.category, ''))) ${inOrNotIn} (${lph})`;
}

function partyReqParams(names: string[], eventDate: string): (string | number)[] {
  return [...names, eventDate, ...LIQUOR_CATEGORIES];
}

/**
 * Party requisition cost + item count, split by category.
 *   'NOT IN' → FOOD   (everything that is not a liquor/beverage category)
 *   'IN'     → LIQUOR (bar / beer / wine / spirits / beverages / mixers)
 * item_count counts only lines that were actually issued (quantity_issued > 0),
 * which is exactly the set partyLiquorReqItems() returns — so the badge count and
 * the rows in the modal can never disagree.
 */
export function partyReqSplit(db: DB, names: string[], eventDate: string | undefined,
                              inOrNotIn: 'IN' | 'NOT IN'): { cost: number; item_count: number } {
  if (!names.length || !eventDate) return { cost: 0, item_count: 0 };
  const r = db.prepare(`
      SELECT COALESCE(SUM(${ISSUED_RECIPE_QTY}
               * rm.average_price), 0) AS cost,
             COUNT(CASE WHEN ri.quantity_issued > 0 THEN 1 END) AS item_count
      ${partyReqSource(names, inOrNotIn)}
    `).get(...partyReqParams(names, eventDate)) as { cost: number; item_count: number };
  return { cost: r?.cost || 0, item_count: r?.item_count || 0 };
}

export interface PartyLiquorReqItem {
  id: string;
  material_id: string;
  material_name: string;
  material_unit: string;
  material_purchase_unit: string;
  material_pack_size: number;
  issued_unit: string;
  qty_issued: number;          // as stored, in issued_unit
  qty_issued_recipe: number;   // converted to the material's recipe unit
  cost: number;                // qty_issued_recipe × average_price
  req_id: string;
  req_number: string;
  req_status: string;
  req_event_name: string;
  issued_at: string | null;
  issued_by: string | null;
}

/**
 * The individual LIQUOR requisition lines behind a party's liquor cost — the
 * read-only rows the consumption modal shows so nobody re-types an already-costed
 * bottle. Same source clause as partyReqSplit(db, …, 'IN'), plus
 * `quantity_issued > 0` so the row count equals that call's item_count.
 */
export function partyLiquorReqItems(db: DB, names: string[], eventDate: string | undefined): PartyLiquorReqItem[] {
  if (!names.length || !eventDate) return [];
  return db.prepare(`
      SELECT ri.id,
             ri.material_id,
             rm.name  AS material_name,
             rm.unit  AS material_unit,
             COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS material_purchase_unit,
             COALESCE(rm.pack_size, 1) AS material_pack_size,
             -- The unit quantity_issued is ACTUALLY stored in (reqPackFactor
             -- convention); a blank ri.unit means the recipe unit.
             COALESCE(NULLIF(TRIM(ri.unit), ''), rm.unit) AS issued_unit,
             ri.quantity_issued AS qty_issued,
             (${ISSUED_RECIPE_QTY}) AS qty_issued_recipe,
             (${ISSUED_RECIPE_QTY}
               * rm.average_price) AS cost,
             r.id AS req_id,
             COALESCE(r.req_number, '') AS req_number,
             r.status AS req_status,
             r.event_name AS req_event_name,
             ri.issued_at,
             ri.issued_by
      ${partyReqSource(names, 'IN')}
        AND ri.quantity_issued > 0
      ORDER BY rm.name
    `).all(...partyReqParams(names, eventDate)) as PartyLiquorReqItem[];
}

export interface CachedPnlParty {
  party_unique_id?: string; fp_id?: string; event_name?: string; event_date?: string;
  guest_name?: string; company?: string; contact_person?: string;
  pax_expected?: number; min_guarantee?: number; status?: string;
}

/**
 * Parties from settings['upcoming_parties_cache'].
 *
 * MOVED HERE VERBATIM from /api/party-events/pnl so the P&L list and the
 * consumption modal resolve a party to the SAME set of names. It is NOT the same
 * mapping as loadUpcomingParties() in src/lib/party-revenue.ts, which derives
 * event_name contact_person-first; this one is guest_name-first, which is what
 * the P&L board has always displayed. That pre-existing difference is deliberate
 * here only in the sense that it is preserved — reconciling the two would change
 * which name is canonical on the board, which is a money-visible decision and
 * belongs to the owner, not to this fix.
 */
export function loadPnlParties(db: DB): CachedPnlParty[] {
  try {
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

/** All names a party's requisition might have been raised under (Raise Req uses
 *  contact_person first; guest_name is often blank; some are keyed by company/FP). */
export function pnlCandidateNames(p: { contact_person?: string; guest_name?: string; company?: string; event_name?: string; fp_id?: string }): string[] {
  return [...new Set([p.contact_person, p.guest_name, p.company, p.event_name, p.fp_id]
    .map(x => String(x || '').trim()).filter(Boolean))];
}

/**
 * Resolve an event key (what the modal has) to the name list + date the
 * requisition queries need — the SAME resolution /api/party-events/pnl's GET
 * performs for its single-party branch. Without this the modal would look up
 * requisitions under one name while the badge counted them under five, and the
 * rows would not reconcile with the cost.
 */
export function resolvePartyEventNames(db: DB, key: { party_unique_id?: string; event_name?: string; event_date?: string }):
  { names: string[]; eventDate: string | undefined; party: CachedPnlParty | undefined } {
  const parties = loadPnlParties(db);
  const p = parties.find(x =>
    (key.party_unique_id && x.party_unique_id === key.party_unique_id) ||
    (!key.party_unique_id && x.event_name === key.event_name && x.event_date === key.event_date));
  const names = p
    ? pnlCandidateNames(p).concat(key.event_name ? [key.event_name] : [])
    : (key.event_name ? [key.event_name] : []);
  return {
    names: [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))],
    eventDate: p?.event_date ?? key.event_date,
    party: p,
  };
}
