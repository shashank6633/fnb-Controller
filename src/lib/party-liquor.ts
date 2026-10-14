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
 * THE ROWS MUST COME FROM THE SAME WHERE CLAUSE AND THE SAME CONVERSION, or the
 * rows shown will not add up to the cost printed beside them — which is the whole
 * point of showing them. Hence partyReqSource() and issuedRecipeQty() below are
 * shared by every figure here; do not inline a copy of either.
 *
 * NOT A MONEY CHANGE: partyReqSplit() costs exactly the lines the runSplit()
 * query that used to live in /api/party-events/pnl costed — same FROM, same
 * WHERE, same parameter order, same ISSUED qty × average_price. The ONE thing
 * that is no longer verbatim is the line→recipe conversion; see below.
 *
 * ── THE OVER-ISSUE CLAMP, AND WHAT THIS FILE DOES (AND DOES NOT) ASSUME ──────
 * The clamp (src/lib/issue-stock.ts "THE CENTRAL FLOOR", party-fulfillment.ts,
 * po-requisition-fulfil.ts) changed WHERE a party requisition's goods are
 * debited, so every assumption here was re-checked against it:
 *
 *  1. THE CONVERSION IS THE RAIL'S OWN. runSplit() converted quantity_issued
 *     with a hand-rolled pack-factor CASE that was byte-equivalent to the one in
 *     party-fulfillment.ts. The clamp DELETED that CASE from both party rails and
 *     converts with lineFactor() (→ packFactor(), src/lib/pack-units.ts). Keeping
 *     a private copy here would be the 750× trap the clamp exists to retire: the
 *     P&L would price a line with one factor while the rail moved it with
 *     another. So the cost is now issued × lineFactor(...).factor × average_price,
 *     computed in JS because packFactor() cannot run inside SQL. MEASURED a
 *     no-op on money: across all 16,353 live requisition lines the old CASE and
 *     lineFactor() return the identical factor on every one (the 3 blank-unit
 *     packed lines get 1 from both, and none of them is on a party requisition).
 *
 *  2. THE COST IS THE HAND-OVER, NOT THE CENTRAL DEBIT — DELIBERATELY. Since the
 *     clamp the party rail moves NOTHING for two kinds of line, on either side
 *     (central or department), and records the refusal in audit_events
 *     ('requisition.party_transfer.declined' at the store desk,
 *     'requisition.party_consumption.short' on the PO/QC cascade):
 *       · store_mapped — a Liquor Store (TGBCL) material; its balance lives on
 *         store_stock_ledger, not in central current_stock. That is every bottle
 *         of spirits, wine and beer, and the category 'bar' itself;
 *       · unit_review  — a blank or unrecognised ri.unit on a PACKED material.
 *     A P&L keyed on the central movement rows would therefore cost the party's
 *     spirits at ₹0 — and with them gone from the "already costed" set, the
 *     double-count gate in /api/party-consumption would stop firing on exactly
 *     the bottles it exists to protect. quantity_issued is what the store handed
 *     over on the requisition, whichever ledger carries the stock, and it is what
 *     both this P&L and production 6cd5615 cost. A unit_review line is still
 *     costed at factor 1 (as production did), and is FLAGGED (needs_unit_review)
 *     so the modal can say its cost rests on an unclear unit.
 *
 *  3. WHAT IS NOT RECONCILED HERE. On a line the cascade CLAMPED (central held
 *     less than the line), the movement row carries less than quantity_issued ×
 *     factor; the shortfall is in the '.short' audit event. This P&L still costs
 *     the hand-over, as before the clamp.
 */
import type { getDb } from '@/lib/db';
// The ONE line→recipe conversion: the same call the party rail's floor makes
// (assertCentralIssue → checkCentralIssue → lineFactor → packFactor). Imported,
// never re-derived — see point 1 in the header.
import { lineFactor } from '@/lib/issue-stock';
import { toPurchaseQty } from '@/lib/pack-units';

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
 * The columns every figure in this file is computed from — read RAW, exactly as
 * the party rail's floor reads them (checkCentralIssue selects ri.unit and the
 * material's unit / purchase_unit / pack_size unmodified), so the factor below is
 * the factor the rail moved the line with.
 */
const LINE_INPUTS = `ri.quantity_issued, ri.unit AS line_unit,
             rm.unit, rm.purchase_unit, rm.pack_size, rm.average_price`;

interface PartyReqLineInputs {
  quantity_issued: number | null;
  line_unit: string | null;
  unit: string | null;
  purchase_unit: string | null;
  pack_size: number | null;
  average_price: number | null;
}

/**
 * ISSUED quantity in RECIPE units, and whether its unit is unclear.
 *
 * quantity_issued is stored in ri.unit — the LINE's own unit (Option B). The
 * factor is lineFactor(), the party rail's own conversion since the clamp (see
 * point 1 in the header): × packFactor when the line is in the material's
 * purchase unit (1 BTL = 750 ml), × 1 when it is already in recipe units, and
 * × 1 with needsReview when the unit is blank or unrecognised on a PACKED
 * material — the rail moves nothing for such a line; this P&L keeps costing it
 * at × 1, exactly as production did, and says so through needsReview.
 *
 * Rupees are qty × average_price (₹ per RECIPE unit), multiplied in the order the
 * old SQL multiplied them — (issued × factor) × price — and a NULL price costs 0,
 * as SUM() skipped the NULL product.
 */
function issuedRecipeQty(row: PartyReqLineInputs): { qty: number; needsReview: boolean } {
  const { factor, needsReview } = lineFactor(row.line_unit, {
    unit: row.unit, purchase_unit: row.purchase_unit, pack_size: row.pack_size,
  });
  return { qty: (Number(row.quantity_issued) || 0) * factor, needsReview };
}

function lineCost(recipeQty: number, row: PartyReqLineInputs): number {
  return recipeQty * (Number(row.average_price) || 0);
}

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
 * the rows in the modal can never disagree. cost sums EVERY matched line, as the
 * old SUM() did (an unissued line contributes 0).
 */
export function partyReqSplit(db: DB, names: string[], eventDate: string | undefined,
                              inOrNotIn: 'IN' | 'NOT IN'): { cost: number; item_count: number } {
  if (!names.length || !eventDate) return { cost: 0, item_count: 0 };
  const rows = db.prepare(`
      SELECT ${LINE_INPUTS}
      ${partyReqSource(names, inOrNotIn)}
    `).all(...partyReqParams(names, eventDate)) as PartyReqLineInputs[];
  let cost = 0;
  let itemCount = 0;
  for (const row of rows) {
    cost += lineCost(issuedRecipeQty(row).qty, row);
    if ((Number(row.quantity_issued) || 0) > 0) itemCount++;
  }
  return { cost, item_count: itemCount };
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
  qty_issued_recipe: number;   // converted to the material's recipe unit (lineFactor)
  /** qty_issued_recipe in the material's PURCHASE unit (toPurchaseQty, 3 dp) —
   *  the figure store screens lead with. DISPLAY ONLY: money is never computed
   *  from it (value = recipe qty × ₹/recipe-unit, always). */
  qty_issued_purchase: number;
  cost: number;                // qty_issued_recipe × average_price
  /** ri.unit is blank or unrecognised on a PACKED material: the party rail moved
   *  no stock for this line (skip 'unit_review') and its cost rests on factor 1. */
  needs_unit_review: boolean;
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
 * bottle. Same source clause and same conversion as partyReqSplit(db, …, 'IN'),
 * plus `quantity_issued > 0` so the row count equals that call's item_count and
 * the rows' cost adds up to its cost.
 */
export function partyLiquorReqItems(db: DB, names: string[], eventDate: string | undefined): PartyLiquorReqItem[] {
  if (!names.length || !eventDate) return [];
  const rows = db.prepare(`
      SELECT ri.id,
             ri.material_id,
             rm.name  AS material_name,
             rm.unit  AS material_unit,
             COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS material_purchase_unit,
             COALESCE(rm.pack_size, 1) AS material_pack_size,
             -- The unit quantity_issued is ACTUALLY stored in (Option B); a blank
             -- ri.unit is shown as the recipe unit (and flagged — see
             -- needs_unit_review).
             COALESCE(NULLIF(TRIM(ri.unit), ''), rm.unit) AS issued_unit,
             ri.quantity_issued AS qty_issued,
             r.id AS req_id,
             COALESCE(r.req_number, '') AS req_number,
             r.status AS req_status,
             r.event_name AS req_event_name,
             ri.issued_at,
             ri.issued_by,
             ${LINE_INPUTS}
      ${partyReqSource(names, 'IN')}
        AND ri.quantity_issued > 0
      ORDER BY rm.name
    `).all(...partyReqParams(names, eventDate)) as (PartyReqLineInputs & {
      id: string; material_id: string; material_name: string; material_unit: string;
      material_purchase_unit: string; material_pack_size: number; issued_unit: string;
      qty_issued: number; req_id: string; req_number: string; req_status: string;
      req_event_name: string; issued_at: string | null; issued_by: string | null;
    })[];
  return rows.map(row => {
    const { qty, needsReview } = issuedRecipeQty(row);
    return {
      id: row.id,
      material_id: row.material_id,
      material_name: row.material_name,
      material_unit: row.material_unit,
      material_purchase_unit: row.material_purchase_unit,
      material_pack_size: row.material_pack_size,
      issued_unit: row.issued_unit,
      qty_issued: row.qty_issued,
      qty_issued_recipe: qty,
      qty_issued_purchase: toPurchaseQty(qty, {
        unit: row.unit, purchase_unit: row.purchase_unit, pack_size: row.pack_size,
      }),
      cost: lineCost(qty, row),
      needs_unit_review: needsReview,
      req_id: row.req_id,
      req_number: row.req_number,
      req_status: row.req_status,
      req_event_name: row.req_event_name,
      issued_at: row.issued_at,
      issued_by: row.issued_by,
    };
  });
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
