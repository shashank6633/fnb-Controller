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

export interface PartyEventKey {
  party_unique_id?: string;
  /** The F&P id. Names a party that has no party_unique_id yet — the ONLY key
   *  that tells two such parties apart when they share a display name. */
  fp_id?: string;
  event_name?: string;
  event_date?: string;
}

/**
 * Which cached party an event key names. ONE predicate, used by the P&L's
 * single-party GET, the consumption modal, the POST double-count gate and the
 * orphan claim below, so they can never pick different parties for the same key.
 * -1 = not cached.
 *
 *   1. party_unique_id, when the key carries one (unchanged).
 *   2. else fp_id, when the key carries one. The /party-pnl page sends it for
 *      every party without an id. WHY: the display name (event_name) is NOT
 *      unique. Two parties without an id can share it ("Twin Name" / "Twin Name"
 *      on one evening), and a party without an id can share it with an earlier
 *      party that HAS one (guest "Ravi Kumar" on both). Matching by name returned
 *      the FIRST such party, so the second one's modal showed the first one's
 *      requisition lines and orphan share, printed a liquor figure its own board
 *      row does not carry, and its 409 gate checked the other party's
 *      requisitions. An fp_id that is not in the cache is NOT re-guessed by name
 *      (that guess is the defect): the key is then an uncached party (-1).
 *   3. else (a caller that sends neither) by event_name + event_date, preferring
 *      a party WITHOUT an id: a key without an id can only be describing one, and
 *      a party with an id is always addressed by it. Twins that share the name
 *      and have no id cannot be told apart this way; that is what fp_id is for.
 */
export function findPnlPartyIndex(parties: CachedPnlParty[], key: PartyEventKey): number {
  if (key.party_unique_id) return parties.findIndex(x => x.party_unique_id === key.party_unique_id);
  const fp = String(key.fp_id || '').trim();
  if (fp) return parties.findIndex(x => String(x.fp_id || '').trim() === fp);
  const byName = (x: CachedPnlParty) => x.event_name === key.event_name && x.event_date === key.event_date;
  const noId = parties.findIndex(x => !x.party_unique_id && byName(x));
  return noId >= 0 ? noId : parties.findIndex(byName);
}

/**
 * The cached parties WITHOUT an id whose P&L counts an ID-BEARING
 * party_consumption row recorded under (eventName, eventDate).
 *
 * This mirrors the no-id arm of pnlFor() in /api/party-events/pnl exactly: a party
 * with no party_unique_id, a display name and a date counts
 *   WHERE event_name = <its display name> AND event_date = <its date>
 *     AND party_unique_id IS NOT NULL
 * — a plain SQL `=` (BINARY collation, untrimmed), hence the untrimmed string
 * comparison here. That arm is production behaviour and is left as it is. It is
 * why PATCH /api/party-consumption must not give an orphan a party id while such
 * a party exists: the row would then count on the party it was assigned to AND
 * on this one. The PATCH refuses on this list, and the P&L board shows the same
 * list in place of the Assign buttons, so the screen never offers an assignment
 * the server will refuse.
 */
export function noIdPartiesCountingName(parties: CachedPnlParty[], eventName: unknown, eventDate: unknown): number[] {
  const n = eventName == null ? '' : String(eventName);
  const d = eventDate == null ? '' : String(eventDate);
  const out: number[] = [];
  parties.forEach((x, i) => {
    if (x.party_unique_id || !x.event_name || !x.event_date) return;
    if (String(x.event_name) === n && String(x.event_date) === d) out.push(i);
  });
  return out;
}

/**
 * Resolve an event key (what the modal has) to the name list + date the
 * requisition queries need — the SAME resolution /api/party-events/pnl's GET
 * performs for its single-party branch. Without this the modal would look up
 * requisitions under one name while the badge counted them under five, and the
 * rows would not reconcile with the cost.
 */
export function resolvePartyEventNames(db: DB, key: PartyEventKey):
  { names: string[]; eventDate: string | undefined; party: CachedPnlParty | undefined } {
  const parties = loadPnlParties(db);
  const idx = findPnlPartyIndex(parties, key);
  const p = idx >= 0 ? parties[idx] : undefined;
  const names = p
    ? pnlCandidateNames(p).concat(key.event_name ? [key.event_name] : [])
    : (key.event_name ? [key.event_name] : []);
  return {
    names: [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))],
    eventDate: p?.event_date ?? key.event_date,
    party: p,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * ORPHAN LIQUOR — party_consumption rows that carry NO party_unique_id.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * POST /api/party-consumption stores `party_unique_id || null` and validates only
 * event_name + event_date, so the bar can record liquor before the AKAN sheet has
 * issued the party an id. Such a row still belongs to SOME party, but the only
 * thing tying it to one is the NAME it was recorded under and its date.
 *
 * OWNER RULING (2026-10-14) — and this is the whole rule:
 *   · count an orphan ONLY when EXACTLY ONE party that evening matches its name
 *     (the row's event_name is one of that party's candidate names —
 *     pnlCandidateNames — and the dates are equal). Give it to that party and
 *     mark it "matched by name";
 *   · when TWO OR MORE parties match, count it NOWHERE and list it for the owner
 *     to assign (PATCH /api/party-consumption sets its party_unique_id, after
 *     which it is an ordinary id-bearing row). The PATCH is REFUSED while a
 *     party without an id is listed under the row's name that evening
 *     (noIdPartiesCountingName above): that party's P&L counts every
 *     id-bearing row under its name, so the assignment would charge the bottle
 *     twice. It can be assigned once that party has an id;
 *   · when NO party matches, it is counted nowhere, as before, and is listed too
 *     so a recorded bottle can never vanish without a trace.
 *
 * WHY ONE FUNCTION. The parked build had two different rules for the same rows:
 * the P&L handed each orphan to one party (own name first, else cache order)
 * while the modal's SQL showed it to EVERY party whose names matched — so with
 * two "Ravi Kumar" parties on 2026-10-10 one modal listed a bottle its P&L did
 * not charge, and offered to delete it. Now the board, the single-party P&L, the
 * modal and the badge all call claimOrphanConsumption() over the SAME claimant
 * list (orphanSlot), so they cannot disagree about who owns a row.
 *
 * The claim is a pure function of the cached party list and the rows, decided
 * across EVERY party at once — a per-party query cannot see the other parties,
 * which is how one bottle used to land on two P&Ls.
 */

/** One party's claim on orphan rows: every name its liquor might have been
 *  recorded under, and its event date. */
export interface OrphanClaimant {
  names: string[];
  date?: string;
}

/** An orphan party_consumption row, as the claim reads it. */
export interface OrphanRow {
  id: string;
  event_name: string;   // trimmed
  event_date: string;   // trimmed
  cost: number;         // cost_at_time (₹, snapshotted at recording)
}

export interface OrphanClaims {
  /** claimant index → the rows it OWNS: it was the ONLY party matching them. */
  owned: Map<number, OrphanRow[]>;
  /** Rows two or more claimants match. Counted on NO party until assigned. */
  ambiguous: { row: OrphanRow; candidates: number[] }[];
  /** Rows no claimant matches. Counted nowhere (unchanged), listed for the owner. */
  unmatched: OrphanRow[];
}

/** Claimants for the cached party list, index-aligned with it. */
export function orphanClaimants(parties: CachedPnlParty[]): OrphanClaimant[] {
  return parties.map(p => ({ names: pnlCandidateNames(p), date: p.event_date }));
}

/**
 * Where an event key sits in the claim. A CACHED party (found by
 * findPnlPartyIndex — id, else fp_id, else name) is its own index in the
 * cached list — so its share is exactly the share the bulk board gives it. A key
 * no cached party matches but which names a date (an ad-hoc single-party GET) is
 * appended LAST as one more party that evening; under the exactly-one rule it can
 * then only win a row that no cached party also matches, so it can never take a
 * bottle the board has already charged. No date → no orphans at all (index -1).
 */
export function orphanSlot(parties: CachedPnlParty[], key: PartyEventKey):
  { claimants: OrphanClaimant[]; index: number } {
  const claimants = orphanClaimants(parties);
  const idx = findPnlPartyIndex(parties, key);
  if (idx >= 0) return { claimants, index: idx };
  const date = String(key.event_date || '').trim();
  if (!date) return { claimants, index: -1 };
  const name = String(key.event_name || '').trim();
  claimants.push({ names: name ? [name] : [], date });
  return { claimants, index: claimants.length - 1 };
}

/** THE RULE. See the block comment above. */
export function claimOrphanConsumption(db: DB, claimants: OrphanClaimant[]): OrphanClaims {
  const out: OrphanClaims = { owned: new Map(), ambiguous: [], unmatched: [] };
  const rows = db.prepare(`
    SELECT id,
           TRIM(COALESCE(event_name, '')) AS event_name,
           TRIM(COALESCE(event_date, '')) AS event_date,
           COALESCE(cost_at_time, 0)      AS cost
    FROM party_consumption
    WHERE party_unique_id IS NULL
    ORDER BY recorded_at, id
  `).all() as OrphanRow[];
  if (!rows.length) return out;

  // date -> name -> DISTINCT claimant indexes. Nested rather than a concatenated
  // key so no separator can ever collide two different pairs; a Set so a party
  // whose guest_name and company are the same string is still ONE party.
  const byDate = new Map<string, Map<string, Set<number>>>();
  claimants.forEach((c, i) => {
    const d = String(c.date || '').trim();
    if (!d) return;
    let byName = byDate.get(d);
    if (!byName) { byName = new Map(); byDate.set(d, byName); }
    for (const raw of c.names) {
      const n = String(raw || '').trim();
      if (!n) continue;
      let set = byName.get(n);
      if (!set) { set = new Set(); byName.set(n, set); }
      set.add(i);
    }
  });

  for (const row of rows) {
    const cands = (row.event_date && row.event_name)
      ? [...(byDate.get(row.event_date)?.get(row.event_name) ?? [])]
      : [];
    if (cands.length === 1) {
      const list = out.owned.get(cands[0]);
      if (list) list.push(row); else out.owned.set(cands[0], [row]);
    } else if (cands.length >= 2) {
      out.ambiguous.push({ row, candidates: cands.sort((a, b) => a - b) });
    } else {
      out.unmatched.push(row);
    }
  }
  return out;
}

/** One party's view of the claim: the rows it is charged for ("matched by
 *  name"), and the rows that name it AND another party that evening — charged to
 *  nobody, shown so nobody re-types them and the owner can assign them. */
export function orphanShareOf(claims: OrphanClaims, index: number):
  { matched: OrphanRow[]; awaiting: { row: OrphanRow; candidates: number[] }[] } {
  if (index < 0) return { matched: [], awaiting: [] };
  return {
    matched: claims.owned.get(index) || [],
    awaiting: claims.ambiguous.filter(a => a.candidates.includes(index)),
  };
}
