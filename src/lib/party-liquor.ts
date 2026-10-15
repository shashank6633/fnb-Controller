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
 * partyReqSplit() costs each line the way the runSplit() query that used to
 * live in /api/party-events/pnl costed it — same status pair, same category
 * split, same ISSUED qty × average_price; the line→recipe conversion is the
 * rail's own (see below). WHICH REQUISITIONS a party is costed on changed with
 * the owner's ruling 34 (2026-10-14) — see "WHOSE REQUISITION IS IT" below
 * claimPartyRequisitions(). That IS a money change, and a deliberate one: it
 * removes a double count production 6cd5615 has.
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
 * The statuses whose requisitions are COSTED. ACTUALS, not estimates: only
 * FULFILLED (and store_processed) requisitions, and the ISSUED quantity — what
 * the store actually handed over. A part-issued party req now correctly stays
 * 'store_processed' rather than being mis-stamped 'fulfilled'; its goods still
 * left the store, so excluding it would silently drop real cost from the P&L.
 * The claim below reads the same set, so it never decides ownership of a
 * requisition that is not costed.
 */
const COSTED_REQ_STATUSES = `('fulfilled', 'store_processed')`;

/**
 * The FROM + WHERE every party-requisition cost query here shares.
 *
 * WHICH requisitions: exactly the ids the claim gave this party
 * (claimPartyRequisitions → partyReqShareOf), bound as ONE JSON array so the
 * statement never runs into SQLite's host-parameter limit. It used to be
 * `r.event_name IN (<the party's candidate names>) AND r.event_date = ?`, which
 * costed a requisition on EVERY party sharing the name that evening (ruling 34).
 * The purpose / status / category filters are unchanged.
 *
 * Parameter order is (reqIdsJson, …LIQUOR_CATEGORIES) — bind with
 * partyReqParams() so a caller cannot get it wrong.
 */
function partyReqSource(inOrNotIn: 'IN' | 'NOT IN'): string {
  const lph = LIQUOR_CATEGORIES.map(() => '?').join(',');
  return `
      FROM requisitions r
      JOIN requisition_items ri ON ri.req_id = r.id
      JOIN raw_materials rm ON rm.id = ri.material_id
      WHERE r.id IN (SELECT value FROM json_each(?))
        AND r.purpose = 'party'
        AND r.status IN ${COSTED_REQ_STATUSES}
        AND LOWER(TRIM(COALESCE(rm.category, ''))) ${inOrNotIn} (${lph})`;
}

function partyReqParams(reqIds: string[]): (string | number)[] {
  return [JSON.stringify(reqIds), ...LIQUOR_CATEGORIES];
}

/**
 * Party requisition cost + item count, split by category, over the
 * requisitions the claim gave ONE party (partyReqShareOf(...).reqIds).
 *   'NOT IN' → FOOD   (everything that is not a liquor/beverage category)
 *   'IN'     → LIQUOR (bar / beer / wine / spirits / beverages / mixers)
 * item_count counts only lines that were actually issued (quantity_issued > 0),
 * which is exactly the set partyLiquorReqItems() returns — so the badge count and
 * the rows in the modal can never disagree. cost sums EVERY matched line, as the
 * old SUM() did (an unissued line contributes 0).
 */
export function partyReqSplit(db: DB, reqIds: string[],
                              inOrNotIn: 'IN' | 'NOT IN'): { cost: number; item_count: number } {
  if (!reqIds.length) return { cost: 0, item_count: 0 };
  const rows = db.prepare(`
      SELECT ${LINE_INPUTS}
      ${partyReqSource(inOrNotIn)}
    `).all(...partyReqParams(reqIds)) as PartyReqLineInputs[];
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
 * bottle, and the set the POST double-count gate (409) checks. Same requisition
 * ids, source clause and conversion as partyReqSplit(db, reqIds, 'IN'), plus
 * `quantity_issued > 0` so the row count equals that call's item_count and the
 * rows' cost adds up to its cost.
 */
export function partyLiquorReqItems(db: DB, reqIds: string[]): PartyLiquorReqItem[] {
  if (!reqIds.length) return [];
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
      ${partyReqSource('IN')}
        AND ri.quantity_issued > 0
      ORDER BY rm.name
    `).all(...partyReqParams(reqIds)) as (PartyReqLineInputs & {
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
 *   1. party_unique_id, when the key carries one — and, when the key ALSO carries
 *      an fp_id, the row holding BOTH. WHY: one AKAN id can sit on two F&P rows
 *      (Party Manager creates an F&P without checking whether the party already
 *      has one, and pm_fp_records is unique on fp_id only), and the claim below
 *      gives each of those rows its OWN requisitions. Taking the first row with
 *      the id showed the second row's modal the first row's requisition lines and
 *      orphan share, and ran its 409 gate on them. The page sends fp_id for every
 *      row. If no row holds both (the F&P was re-keyed since the page loaded), the
 *      first row with the id is taken, as before.
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
  const fp = String(key.fp_id || '').trim();
  const fpOf = (x: CachedPnlParty) => String(x.fp_id || '').trim();
  if (key.party_unique_id) {
    if (fp) {
      const both = parties.findIndex(x => x.party_unique_id === key.party_unique_id && fpOf(x) === fp);
      if (both >= 0) return both;
    }
    return parties.findIndex(x => x.party_unique_id === key.party_unique_id);
  }
  if (fp) return parties.findIndex(x => fpOf(x) === fp);
  const byName = (x: CachedPnlParty) => x.event_name === key.event_name && x.event_date === key.event_date;
  const noId = parties.findIndex(x => !x.party_unique_id && byName(x));
  return noId >= 0 ? noId : parties.findIndex(byName);
}

/* ────────────────────────────────────────────────────────────────────────────
 * OWNER RULING 34 (2026-10-14) — NO NAME MATCH ACROSS A PARTY ID.
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   (a) A requisition is costed ONLY on the party whose id it carries
 *       (requisitions.party_unique_id, filled by Raise Req). Name + date
 *       matching is a FALLBACK for a requisition with no id, and then only when
 *       EXACTLY ONE party that evening matches — the orphan-liquor rule below.
 *       When the cache lists the id on two or more F&P rows, the requisition's
 *       date picks the row, under the same exactly-one rule (see "WHOSE
 *       REQUISITION IS IT").
 *   (b) A party with no AKAN id matches by name ONLY rows with no party id. Its
 *       P&L used to count every ID-BEARING party_consumption row recorded under
 *       its display name — i.e. another party's bottles — and the release batch
 *       had to refuse orphan assignments to stop that arm counting them twice
 *       (noIdPartiesCountingName, now gone with the arm it mirrored).
 *
 * Production 6cd5615 costed a requisition raised under "Ravi Kumar" on EVERY
 * party that evening carrying that name, and a no-id "Ravi Kumar" party's P&L
 * carried the other Ravi Kumar's recorded bottles. Both are removed here.
 *
 * ONE RESOLUTION for every consumer — the P&L board, its single-party GET, the
 * consumption modal, its badge and the POST 409 gate: an event key resolves to a
 * SLOT in the claimant list (partySlot), and the requisitions, orphan rows and
 * party id are all read from that slot. A slot is one party; nothing is matched
 * by a name list of the caller's own any more.
 */

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
 *     which it is an ordinary id-bearing row and counts on that party alone —
 *     since ruling 34(b) no party without an id counts an id-bearing row, so an
 *     assignment can no longer land a bottle on a second P&L);
 *   · when NO party matches, it is counted nowhere, as before, and is listed too
 *     so a recorded bottle can never vanish without a trace.
 *
 * WHY ONE FUNCTION. The parked build had two different rules for the same rows:
 * the P&L handed each orphan to one party (own name first, else cache order)
 * while the modal's SQL showed it to EVERY party whose names matched — so with
 * two "Ravi Kumar" parties on 2026-10-10 one modal listed a bottle its P&L did
 * not charge, and offered to delete it. Now the board, the single-party P&L, the
 * modal and the badge all call claimOrphanConsumption() over the SAME claimant
 * list (partySlot), so they cannot disagree about who owns a row.
 *
 * The claim is a pure function of the cached party list and the rows, decided
 * across EVERY party at once — a per-party query cannot see the other parties,
 * which is how one bottle used to land on two P&Ls. claimPartyRequisitions()
 * below applies the same exactly-one rule to requisitions without an id.
 */

/** One party's claim: every name its liquor / requisitions might have been
 *  recorded under, its event date, and its AKAN id (ruling 34: a requisition
 *  that carries an id belongs to the claimant with that id and to no other). */
export interface OrphanClaimant {
  names: string[];
  date?: string;
  party_unique_id?: string;
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
export function partyClaimants(parties: CachedPnlParty[]): OrphanClaimant[] {
  return parties.map(p => ({
    names: pnlCandidateNames(p),
    date: p.event_date,
    party_unique_id: String(p.party_unique_id || '').trim() || undefined,
  }));
}

/**
 * Where an event key sits in the claim. A CACHED party (found by
 * findPnlPartyIndex — id, else fp_id, else name) is its own index in the
 * cached list — so its share is exactly the share the bulk board gives it, and
 * `party_unique_id` is THAT party's id (a party that gained an id after the page
 * loaded is still addressed by it). A key no cached party matches (an ad-hoc
 * single-party GET) is appended LAST as one more claimant:
 *   · orphans / id-less requisitions — under the exactly-one rule it can then
 *     only win a row no cached party also matches, so it can never take
 *     something the board has already charged; with no date it wins nothing;
 *   · id-bearing requisitions — it owns those carrying the key's id (a party
 *     that has dropped off the cached list is still costed by its own id).
 * A key with neither a date nor an id is no party at all (index -1).
 */
export function partySlot(parties: CachedPnlParty[], key: PartyEventKey):
  { claimants: OrphanClaimant[]; index: number; party: CachedPnlParty | undefined; party_unique_id: string | undefined } {
  const claimants = partyClaimants(parties);
  const idx = findPnlPartyIndex(parties, key);
  // The id as the cache holds it — the board passes p.party_unique_id to the
  // party_consumption id arm exactly so, and the two must bind the same string.
  if (idx >= 0) return { claimants, index: idx, party: parties[idx], party_unique_id: parties[idx].party_unique_id || undefined };
  const date = String(key.event_date || '').trim();
  const id = String(key.party_unique_id || '').trim() || undefined;
  if (!date && !id) return { claimants, index: -1, party: undefined, party_unique_id: undefined };
  const name = String(key.event_name || '').trim();
  claimants.push({ names: name ? [name] : [], date: date || undefined, party_unique_id: id });
  // The key's id as sent, as the id arm has always bound it.
  return { claimants, index: claimants.length - 1, party: undefined, party_unique_id: key.party_unique_id || undefined };
}

/**
 * date -> name -> DISTINCT claimant indexes, for the exactly-one rule (orphan
 * liquor AND id-less requisitions read the SAME index). Nested rather than a
 * concatenated key so no separator can ever collide two different pairs; a Set
 * so a party whose guest_name and company are the same string is still ONE
 * party. A claimant without a date claims nothing by name.
 */
function claimantNameIndex(claimants: OrphanClaimant[]): Map<string, Map<string, Set<number>>> {
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
  return byDate;
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

  const byDate = claimantNameIndex(claimants);

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

/* ────────────────────────────────────────────────────────────────────────────
 * WHOSE REQUISITION IS IT — owner ruling 34(a), 2026-10-14.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * A COSTED party requisition (purpose 'party', status fulfilled/store_processed):
 *   · CARRIES AN ID (TRIM(party_unique_id) <> '', filled by Raise Req) — it is
 *     costed on the claimant with that id and on NO other party, whatever name
 *     it was raised under. Production costed it on every party whose candidate
 *     names included that name that evening, so two "Ravi Kumar" parties both
 *     carried it. When no cached party carries the id, no board row costs it
 *     (the single-party GET for that id still does); if a party on the list
 *     matched it by name, it is listed as 'id_not_listed' so the money is not
 *     silently gone from the board.
 *       ONE ID ON TWO OR MORE CACHED ROWS (Party Manager can create a second F&P
 *     for a party that already has one — two functions of one booking on two
 *     dates, or a re-created F&P beside the cancelled one): the id alone does
 *     not say which row the requisition is for, and giving it to every holder
 *     costed each rupee on two rows — production, matching by name + date, had
 *     put each requisition on its own date's row only. So among the holders of
 *     the id, the one whose date equals the requisition's event_date owns it;
 *     if no holder, or two or more, are on that date, it is costed on NONE of
 *     them and listed ('id_on_several_parties', candidates = the holders on its
 *     date, else every holder) — the same exactly-one rule as below.
 *   · CARRIES NO ID — the orphan-liquor rule: EXACTLY ONE claimant that evening
 *     whose candidate names include the requisition's event_name owns it; two or
 *     more → costed on NONE of them and listed ('several_parties'); none →
 *     costed nowhere, exactly as production (not listed: production never costed
 *     it anywhere either).
 * The name and date are compared as the old SQL compared them: the
 * requisition's event_name / event_date as stored, against the party's trimmed
 * candidate names and its date — so no requisition starts matching a party it
 * did not match before; some simply stop matching the parties that are not
 * theirs.
 *
 * Decided across EVERY claimant at once, like the orphan claim, because "only
 * this party" cannot be seen from a per-party query.
 */

/** A costed party requisition, as the claim reads it. */
export interface PartyReqRef {
  id: string;
  req_number: string;
  event_name: string;       // as stored
  event_date: string;       // as stored
  party_unique_id: string;  // trimmed; '' = no id
  fp_id: string;            // trimmed; display only (the ruling keys on the AKAN id)
}

export interface ReqClaims {
  /** claimant index → ids of the requisitions it is COSTED on. */
  owned: Map<number, string[]>;
  /** No id, and two or more claimants match its name that evening: costed on none. */
  ambiguous: { req: PartyReqRef; candidates: number[] }[];
  /** Carries an id two or more claimants hold, and the date does not pick exactly
   *  one of them: costed on none. candidates = the holders on its date when there
   *  are two or more, else every holder of the id. */
  idShared: { req: PartyReqRef; candidates: number[] }[];
  /** Carries an id no claimant has, while at least one claimant matches its name
   *  that evening (production costed it there): costed on no listed party. */
  idNotListed: { req: PartyReqRef; nameMatches: number[] }[];
}

/** THE RULE for requisitions. See the block comment above. */
export function claimPartyRequisitions(db: DB, claimants: OrphanClaimant[]): ReqClaims {
  const out: ReqClaims = { owned: new Map(), ambiguous: [], idShared: [], idNotListed: [] };
  const rows = db.prepare(`
    SELECT r.id,
           COALESCE(r.req_number, '')                 AS req_number,
           COALESCE(r.event_name, '')                 AS event_name,
           COALESCE(r.event_date, '')                 AS event_date,
           TRIM(COALESCE(r.party_unique_id, ''))      AS party_unique_id,
           TRIM(COALESCE(r.fp_id, ''))                AS fp_id
    FROM requisitions r
    WHERE r.purpose = 'party'
      AND r.status IN ${COSTED_REQ_STATUSES}
    ORDER BY r.event_date, r.req_number, r.id
  `).all() as PartyReqRef[];
  if (!rows.length) return out;

  const byId = new Map<string, number[]>();
  claimants.forEach((c, i) => {
    const id = String(c.party_unique_id || '').trim();
    if (!id) return;
    const list = byId.get(id);
    if (list) list.push(i); else byId.set(id, [i]);
  });
  const byDate = claimantNameIndex(claimants);
  const give = (i: number, reqId: string) => {
    const list = out.owned.get(i);
    if (list) list.push(reqId); else out.owned.set(i, [reqId]);
  };

  for (const req of rows) {
    const nameMatches = (req.event_date && req.event_name)
      ? [...(byDate.get(req.event_date)?.get(req.event_name) ?? [])].sort((a, b) => a - b)
      : [];
    if (req.party_unique_id) {
      const owners = byId.get(req.party_unique_id) || [];
      if (owners.length === 1) give(owners[0], req.id);
      else if (owners.length >= 2) {
        // One id on several rows: the requisition's date picks the row (dates
        // compared as the name index compares them — the claimant's trimmed date
        // against the requisition's date as stored).
        const onDate = owners.filter(i => String(claimants[i].date || '').trim() === req.event_date);
        if (onDate.length === 1) give(onDate[0], req.id);
        else out.idShared.push({ req, candidates: onDate.length ? onDate : [...owners] });
      }
      else if (nameMatches.length) out.idNotListed.push({ req, nameMatches });
      continue;
    }
    if (nameMatches.length === 1) give(nameMatches[0], req.id);
    else if (nameMatches.length >= 2) out.ambiguous.push({ req, candidates: nameMatches });
  }
  return out;
}

/** Why a requisition that names a party is costed on nobody. */
export type ReqAwaitingReason = 'several_parties' | 'id_on_several_parties';

/** One party's view of the requisition claim: the requisitions it is costed on,
 *  and the ones costed on nobody that list it as a candidate — id-less ones that
 *  name it AND another party that evening ('several_parties'), and ones carrying
 *  an id it shares with another cached row when the date does not pick one
 *  ('id_on_several_parties'). Counted only so the badge and the modal can say so. */
export function partyReqShareOf(claims: ReqClaims, index: number):
  { reqIds: string[]; awaiting: { req: PartyReqRef; candidates: number[]; reason: ReqAwaitingReason }[] } {
  if (index < 0) return { reqIds: [], awaiting: [] };
  return {
    reqIds: claims.owned.get(index) || [],
    awaiting: [
      ...claims.ambiguous.filter(a => a.candidates.includes(index))
        .map(a => ({ ...a, reason: 'several_parties' as const })),
      ...claims.idShared.filter(a => a.candidates.includes(index))
        .map(a => ({ ...a, reason: 'id_on_several_parties' as const })),
    ],
  };
}

/**
 * Everything one event key is charged with, resolved ONCE — what the single-party
 * P&L GET, the consumption modal and the POST 409 gate all read, so they cannot
 * resolve the same key to different requisitions, rows or id. The bulk board
 * computes the same claims over partyClaimants(parties) and reads each party's
 * own index, which is the index partySlot() returns for that party's key.
 */
export function partyScope(db: DB, key: PartyEventKey) {
  const parties = loadPnlParties(db);
  const slot = partySlot(parties, key);
  const reqShare = partyReqShareOf(claimPartyRequisitions(db, slot.claimants), slot.index);
  const orphanShare = orphanShareOf(claimOrphanConsumption(db, slot.claimants), slot.index);
  return { parties, ...slot, reqIds: reqShare.reqIds, reqAwaiting: reqShare.awaiting, orphanShare };
}
