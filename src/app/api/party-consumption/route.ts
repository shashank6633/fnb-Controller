import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  partyScope, partyLiquorReqItems, loadPnlParties, pnlCandidateNames,
  partyClaimants, claimIdConsumption, idConsumptionOwnerOf,
} from '@/lib/party-liquor';

/**
 * Post-party liquor / beverage consumption.
 *
 * Bar manager records bottle counts after the event. Cost is snapshotted
 * at recording time from raw_materials.average_price so historical P&L
 * doesn't drift when stock prices move.
 *
 * THE OTHER HALF OF THE LIQUOR COST. A party's liquor cost on the P&L is
 * party_consumption PLUS the liquor lines of its bar requisition (see
 * src/lib/party-liquor.ts). This route used to serve only the first, so a party
 * whose liquor all came from a requisition opened an EMPTY modal under a badge
 * that said an item was recorded — and the obvious response to an empty modal is
 * to type the bottle in, which counts it twice on a P&L events are priced from.
 * GET therefore also returns `requisition_items` (READ-ONLY — they are already
 * costed, there is nothing here to edit), and POST refuses a material that is
 * already issued on the party's bar requisition unless the caller confirms.
 *
 * ORPHAN ROWS (no party_unique_id) follow the owner's ruling of 2026-10-14 through
 * the SAME claim the P&L uses (claimOrphanConsumption in src/lib/party-liquor.ts):
 * a row is in this party's `entries` (flagged matched_by_name) only when this is
 * the ONLY party that evening its name matches; when another party matches too it
 * is in `unassigned_entries` instead — shown, never summed — until the owner
 * assigns it with PATCH. So the modal, the badge and the P&L cannot disagree.
 * ROWS THAT CARRY AN ID go through claimIdConsumption, the claim the P&L's id arm
 * uses: when one AKAN id is on two or more F&P rows, an entry is in the `entries`
 * of the row it was recorded from (fp_id), else of the one row on its date, else
 * in every candidate's `unassigned_entries` (reason 'id_on_several_parties').
 *
 * OWNER RULING 34 (2026-10-14). The requisition lines shown, and the ones the
 * POST 409 gate checks, are exactly the requisitions the P&L costs on this party
 * (claimPartyRequisitions: its own id, else the exactly-one name match), never
 * every requisition raised under a name it shares. A party with no AKAN id shows
 * no id-bearing rows at all — only the orphan rows the claim gave it.
 *
 * GET    /api/party-consumption?party_unique_id=...[&fp_id=...]
 * GET    /api/party-consumption?event_name=...&event_date=YYYY-MM-DD[&fp_id=...]
 *        -> { entries, requisition_items, unassigned_entries, unassigned_requisitions }
 *        fp_id names WHICH party is meant when two parties share the display
 *        name that evening, or when one AKAN id sits on two F&P rows
 *        (findPnlPartyIndex); the page sends it for every row.
 * POST   /api/party-consumption
 *        body: { party_unique_id?, fp_id?, event_name, event_date,
 *                items: [{ material_id, qty, notes? }], confirm_duplicates? }
 *        -> 409 { error, duplicates } when an item is already costed from the
 *           party's requisition and confirm_duplicates is not true
 * PATCH  /api/party-consumption   body: { id, party_unique_id, fp_id? }   (admin only)
 *        assigns an orphan row to one of the parties its name + date match, or
 *        an entry whose id is on several F&P rows to one of them; fp_id names
 *        the F&P row (the page always sends it)
 * DELETE /api/party-consumption?id=<uuid>
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);
    const partyUniqueId = url.searchParams.get('party_unique_id');
    const eventName     = url.searchParams.get('event_name');
    const eventDate     = url.searchParams.get('event_date');
    const fpId          = url.searchParams.get('fp_id');

    if (!partyUniqueId && !(eventName && eventDate)) {
      return Response.json({ error: 'party_unique_id or (event_name+event_date) required' }, { status: 400 });
    }

    // Resolve the key ONCE, through the very call /api/party-events/pnl's
    // single-party GET makes (partyScope): the requisitions, the orphan share and
    // the party id below are then exactly the ones counted in liquor_items there.
    // fp_id picks the right party when its display name is shared, or when its
    // AKAN id sits on two F&P rows (findPnlPartyIndex); without it the first
    // party of that name — or with that id — was taken.
    const key = {
      party_unique_id: partyUniqueId || undefined,
      fp_id: fpId || undefined,
      event_name: eventName || undefined,
      event_date: eventDate || undefined,
    };
    const scope = partyScope(db, key);
    const { parties } = scope;

    // THE ID-BEARING ROWS — exactly the ones pnlFor's id arm charges the row the
    // key resolved to (scope.idShare, claimIdConsumption): every entry carrying
    // its id when it alone holds the id; when the id is on two or more F&P rows,
    // only those recorded from THIS row (or dated on its date when nothing else
    // picks one). This used to be `WHERE pc.party_unique_id = ?`, which showed
    // every F&P of one booking the others' bottles — and offered to delete them.
    // A party WITHOUT an id has none (ruling 34b): an id-bearing row recorded
    // under its display name is the id's party's bottle.
    const SELECT_ROWS = `
        SELECT pc.*, rm.name AS material_name, rm.unit AS material_unit,
               rm.average_price AS current_avg_price
        FROM party_consumption pc
        JOIN raw_materials rm ON rm.id = pc.material_id`;
    const byId = db.prepare(`${SELECT_ROWS} WHERE pc.id = ?`);
    const own = (scope.party_unique_id
      ? scope.idShare.rows.map(r => byId.get(r.id) as any).filter(Boolean)
      : []) as any[];

    // THE ORPHAN ROWS (no party id) — through the P&L's own claim, over the P&L's
    // own claimant list (partySlot), never through a name predicate of this
    // route's. A per-party SQL arm cannot see the OTHER parties, which is exactly
    // how the parked build showed party A a bottle only party B was charged for.
    const { matched, awaiting } = scope.orphanShare;
    // A claimant index, described. fp_id is what tells two parties of the same
    // display name apart ("Ravi Kumar" / "Ravi Kumar"). An index past the cached
    // list is the key itself (appended by partySlot).
    const candidateOf = (i: number) => {
      const p = i < parties.length ? parties[i] : undefined;
      return {
        party_unique_id: p ? (p.party_unique_id || null) : (partyUniqueId || null),
        fp_id: p ? (p.fp_id || null) : (fpId || null),
        event_name: p ? (p.event_name || '') : (eventName || ''),
        event_date: p ? (p.event_date || '') : (eventDate || ''),
      };
    };
    const matchedRows = matched
      .map(m => byId.get(m.id) as any)
      .filter(Boolean)
      .map(r => ({ ...r, matched_by_name: true }));
    const rows = [...own.map(r => ({ ...r, matched_by_name: false })), ...matchedRows]
      // Production order: newest first (recorded_at DESC); id breaks ties so the
      // order does not depend on which query a row came from.
      .sort((a, b) => String(b.recorded_at || '').localeCompare(String(a.recorded_at || ''))
                   || String(a.id).localeCompare(String(b.id)));

    // Rows that name this party AND another that evening: charged to NOBODY. They
    // are listed — never summed — so the recorder can see the bottle is waiting
    // for the owner rather than missing, and does not type it in again.
    // Then the entries CARRYING this row's id that the id claim charged to no row:
    // the id is on two or more F&P rows and neither the F&P they were recorded
    // from nor their date picks one. Listed the same way, never summed.
    const unassigned = [
      ...awaiting.map(a => ({ a, reason: 'several_parties' as const })),
      ...scope.idShare.awaiting.map(a => ({ a, reason: 'id_on_several_parties' as const })),
    ]
      .map(({ a, reason }) => {
        const r = byId.get(a.row.id) as any;
        if (!r) return null;
        return {
          ...r,
          reason,
          candidates: a.candidates.map(i => candidateOf(i)),
        };
      })
      .filter(Boolean);

    // READ-ONLY. Already costed into liquor_cost from the party's own Bar
    // requisition(s) — the ones the P&L costs on THIS party (ruling 34a); shown
    // so the modal accounts for the whole liquor figure instead of half of it.
    const requisitionItems = partyLiquorReqItems(db, scope.reqIds);
    // Requisitions costed on NEITHER party (ruling 34a): no id, raised under a
    // name this party shares with another that evening ('several_parties'), or
    // carrying an id this party's row shares with another F&P row when the date
    // does not pick one ('id_on_several_parties'). Listed, never summed, so the
    // modal matches the badge's count and nobody reads the gap as missing liquor.
    const unassignedReqs = scope.reqAwaiting.map(a => ({
      req_id: a.req.id,
      req_number: a.req.req_number,
      event_name: a.req.event_name,
      event_date: a.req.event_date,
      party_unique_id: a.req.party_unique_id || null,
      reason: a.reason,
      candidates: a.candidates.map(i => candidateOf(i)),
    }));
    return Response.json({
      entries: rows, requisition_items: requisitionItems,
      unassigned_entries: unassigned, unassigned_requisitions: unassignedReqs,
    });
  } catch (e: any) {
    console.error('[/api/party-consumption GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await request.json();
    const { party_unique_id, fp_id, event_name, event_date, items } = b;

    if (!event_name || !String(event_name).trim()) {
      return Response.json({ error: 'event_name required' }, { status: 400 });
    }
    if (!event_date || !String(event_date).match(/^\d{4}-\d{2}-\d{2}$/)) {
      return Response.json({ error: 'event_date (YYYY-MM-DD) required' }, { status: 400 });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items required' }, { status: 400 });
    }

    // ── THE DOUBLE-COUNT GATE ────────────────────────────────────────────────
    // The material may ALREADY be costed into this party's liquor_cost from the
    // bar requisition the store issued. Recording it again adds the same bottle a
    // second time, and nothing downstream can tell the two apart: party_consumption
    // carries no req_id, so there is no link and no later reconciliation.
    //
    // It is NOT refused outright, deliberately. A party can genuinely drink more
    // than was issued — a bottle already standing in the bar is real consumption
    // and must still be recordable, or this gate would UNDER-count, which is the
    // same defect pointing the other way. So: refuse ONCE, name the requisition
    // the material is already costed on, and let the caller confirm. The double
    // count becomes a decision somebody made, never a silent accident.
    // fp_id (sent by the page for every party) identifies a party WITHOUT an id
    // whose display name another party shares that evening, and the F&P row
    // meant when one AKAN id sits on two rows — without it the gate checked the
    // FIRST such party, i.e. somebody else's requisitions.
    // The set checked is the modal's requisition_items and the P&L's liquor
    // requisition lines for this party — the same partyScope() requisitions
    // (ruling 34a): another party's requisition raised under a shared name is
    // not "already costed on this party" and no longer trips the gate.
    const scope = partyScope(db, {
      party_unique_id: party_unique_id || undefined,
      fp_id: typeof fp_id === 'string' && fp_id.trim() ? fp_id.trim() : undefined,
      event_name: String(event_name).trim(),
      event_date,
    });
    const alreadyCosted = new Map(
      partyLiquorReqItems(db, scope.reqIds).map(r => [r.material_id, r]));
    if (b.confirm_duplicates !== true && alreadyCosted.size > 0) {
      const duplicates = items
        .filter((it: any) => it?.material_id && Number(it.qty) > 0 && alreadyCosted.has(it.material_id))
        .map((it: any) => {
          const r = alreadyCosted.get(it.material_id)!;
          return {
            material_id: r.material_id,
            material_name: r.material_name,
            req_number: r.req_number,
            req_id: r.req_id,
            qty_issued: r.qty_issued,
            issued_unit: r.issued_unit,
            cost: r.cost,
          };
        });
      if (duplicates.length > 0) {
        return Response.json({
          error: duplicates.length === 1
            ? `${duplicates[0].material_name} is already costed on this party's Bar requisition${duplicates[0].req_number ? ` ${duplicates[0].req_number}` : ''}. Recording it here counts it twice.`
            : `${duplicates.length} of these items are already costed on this party's Bar requisition. Recording them here counts them twice.`,
          duplicates,
          needs_confirmation: true,
        }, { status: 409 });
      }
    }

    const ins = db.prepare(`
      INSERT INTO party_consumption
        (id, party_unique_id, fp_id, event_name, event_date,
         material_id, qty_consumed, cost_at_time, notes, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const getMat = db.prepare(`SELECT average_price FROM raw_materials WHERE id = ?`);

    const txn = db.transaction(() => {
      for (const it of items) {
        const qty = Number(it.qty) || 0;
        if (!it.material_id || qty <= 0) continue;
        const mat = getMat.get(it.material_id) as { average_price?: number } | undefined;
        // BASIS PROOF — both halves are RECIPE, so no pack factor belongs here.
        //  · RATE: raw_materials.average_price is ₹ per RECIPE unit by canon
        //    (₹/ml, ₹/g). It is read straight off the material row above, not
        //    through last_purchase_price, so there is no mixed-basis exposure.
        //  · QTY: `it.qty` is posted ALREADY CONVERTED to recipe units. The only
        //    writer is the recorder in src/app/party-pnl/page.tsx (submit() in
        //    RecordConsumptionModal), which
        //    sends toBaseQty(qty, entryUnit, m.unit, m) — 3 BTL × pack_size 750
        //    leaves the browser as 2250 ml. The same number is stored in
        //    party_consumption.qty_consumed, which the rate-basis canon fixes as
        //    recipe-basis, and is rendered back through prettyQty(..., rm.unit)
        //    (the RECIPE unit) by the GET above. Re-applying the pack rule on
        //    either side here would double-count the pack by 750×.
        // rate-basis: recipe
        const cost = (mat?.average_price || 0) * qty;
        ins.run(
          generateId(),
          party_unique_id || null,
          fp_id || null,
          String(event_name).trim(),
          event_date,
          it.material_id,
          qty,
          cost,
          it.notes || '',
          me.email,
        );
      }
    });
    txn();
    return Response.json({ success: true }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/party-consumption POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/**
 * ASSIGN AN ENTRY TO ONE F&P ROW (owner ruling 2026-10-14; ruling 34). Body
 * { id, party_unique_id, fp_id } — the page sends the fp_id of the row whose
 * "Assign here" was clicked.
 *
 *  · AN ORPHAN (no party_unique_id) whose name matches two or more parties that
 *    evening is charged to NONE of them until the owner says whose it is. This
 *    sets its party_unique_id AND its fp_id to the chosen F&P, after which it is
 *    an ordinary id-bearing row and counts on exactly that row (claimIdConsumption
 *    in src/lib/party-liquor.ts). The chosen row must have an id, the entry's
 *    date, and the entry's name among its candidate names — one of the parties
 *    the claim itself found.
 *  · AN ENTRY THAT CARRIES AN ID on two or more F&P rows, where neither the F&P
 *    it was recorded from nor its date picks one, is charged to none of them
 *    either; this sets its fp_id to one of the listed candidates. An entry the
 *    claim already charges to a row is refused (409 "Already assigned"), as
 *    before.
 *
 * ONE ID ON TWO ROWS. The row is found by id AND fp_id. It used to be the FIRST
 * cached row with the id: Assign for the second F&P of a booking was refused
 * ("does not match this entry") when the first was on another date, and one that
 * succeeded set only the id — and the P&L then charged the bottle on EVERY row
 * with that id. Without an fp_id the row is the one holder of the id, else the
 * one holder whose date and names match the entry; anything else is refused with
 * a request to choose the F&P.
 *
 * NOTHING CAN LAND ON TWO ROWS OR THE WRONG ONE: after the update, inside the
 * same transaction, the very claim the P&L runs is re-run, and unless it charges
 * the entry to exactly the chosen row everything is rolled back (409).
 *
 * Bounded on purpose: admin only; the UPDATE re-checks the entry's state (still
 * an orphan, or still the id and F&P it had), so two clicks cannot reassign it.
 * Nothing else on the row changes: the name it was recorded under, its qty and
 * its snapshotted cost_at_time stay as recorded (re-recording would re-snapshot
 * the price). The F&P it was recorded from is kept in the audit event's
 * `before`.
 *
 * NO LONGER REFUSED because a party without an id shares the row's name. That
 * 409 existed only because such a party's P&L counted every id-bearing row under
 * its display name, so an assigned row landed on two P&Ls. Owner ruling 34(b)
 * removed that counting: a party without an id counts only rows WITHOUT an id
 * (and only those the exactly-one claim gives it), so the row assigned here
 * counts on the chosen party alone. The board names the F&P the row was recorded
 * from (recorded_fp_id), so the owner can see whose bottle it is before choosing.
 */
class AssignRefused extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function PATCH(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin') {
      return Response.json({ error: 'Only an admin can assign recorded liquor to a party' }, { status: 403 });
    }
    const db = getDb();
    const b = await request.json().catch(() => ({}));
    const id = typeof b?.id === 'string' ? b.id : '';
    const target = typeof b?.party_unique_id === 'string' ? b.party_unique_id.trim() : '';
    const fpWanted = typeof b?.fp_id === 'string' ? b.fp_id.trim() : '';
    if (!id || !target) return Response.json({ error: 'id and party_unique_id required' }, { status: 400 });

    const row = db.prepare('SELECT * FROM party_consumption WHERE id = ?').get(id) as any;
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
    const name = String(row.event_name || '').trim();
    const date = String(row.event_date || '').trim();
    const parties = loadPnlParties(db);
    const claimants = partyClaimants(parties);
    const fpOf = (i: number) => String(parties[i]?.fp_id || '').trim();
    const labelOf = (i: number) => `${parties[i]?.event_name || target}${fpOf(i) ? ` (${fpOf(i)})` : ''}`;
    const orphan = row.party_unique_id === null;

    let chosen: number;
    if (!orphan) {
      // Re-pointable ONLY while the P&L charges it to nobody (its id is on two or
      // more rows and nothing picks one) — and only to one of its candidates.
      const listed = claimIdConsumption(db, claimants).shared.find(s => s.row.id === id);
      if (!listed) {
        return Response.json({ error: `Already assigned to party ${row.party_unique_id}` }, { status: 409 });
      }
      if (row.party_unique_id !== target) {
        return Response.json({ error: `This entry carries party id ${row.party_unique_id}; choose one of its F&P rows.` }, { status: 400 });
      }
      const pick = fpWanted ? listed.candidates.find(i => fpOf(i) === fpWanted) : undefined;
      if (pick === undefined) {
        return Response.json({
          error: `Party id ${target} is on more than one F&P — choose the one this entry belongs to: ${listed.candidates.map(labelOf).join(', ')}.`,
        }, { status: 400 });
      }
      chosen = pick;
    } else {
      // The cached rows holding the id, compared exactly as before.
      const holders = parties.map((_, i) => i).filter(i => parties[i].party_unique_id === target);
      if (!holders.length) return Response.json({ error: 'That party is not in the party list' }, { status: 400 });
      const fits = (i: number) => String(parties[i].event_date || '').trim() === date
                                  && pnlCandidateNames(parties[i]).includes(name);
      let pick: number | undefined;
      if (fpWanted) {
        pick = holders.find(i => fpOf(i) === fpWanted);
        if (pick === undefined) {
          return Response.json({ error: `${fpWanted} is not on the party list with party id ${target}.` }, { status: 400 });
        }
      } else if (holders.length === 1) {
        pick = holders[0];
      } else {
        const fitting = holders.filter(fits);
        if (fitting.length !== 1) {
          return Response.json({
            error: `Party id ${target} is on ${holders.length} F&P rows (${holders.map(labelOf).join(', ')}) — choose the F&P to assign this entry to.`,
          }, { status: 400 });
        }
        pick = fitting[0];
      }
      if (!fits(pick)) {
        return Response.json({
          error: `That party does not match this entry: it was recorded under "${name}" on ${date}.`,
        }, { status: 400 });
      }
      chosen = pick;
    }

    // The F&P the entry now belongs to. A cached row without an fp_id clears it,
    // so the entry cannot keep pointing at ANOTHER row with the id; its date then
    // decides, and the claim below refuses the assignment if that does not pick
    // the chosen row.
    const newFp: string | null = fpOf(chosen) || null;
    db.transaction(() => {
      const changed = orphan
        ? db.prepare(
            'UPDATE party_consumption SET party_unique_id = ?, fp_id = ? WHERE id = ? AND party_unique_id IS NULL',
          ).run(target, newFp, id).changes
        : db.prepare(
            `UPDATE party_consumption SET fp_id = ?
             WHERE id = ? AND party_unique_id = ? AND COALESCE(fp_id, '') = ?`,
          ).run(newFp, id, row.party_unique_id, row.fp_id ?? '').changes;
      if (changed !== 1) throw new AssignRefused(409, 'This entry was assigned by someone else just now — reload');
      // The entry must now be charged to EXACTLY the row chosen, by the P&L's own
      // claim — never to a second row, never to another one.
      const owner = idConsumptionOwnerOf(claimIdConsumption(db, claimants), id);
      if (owner !== chosen) {
        throw new AssignRefused(409, `This entry cannot be pinned to ${labelOf(chosen)}: the party list cannot tell that F&P apart from another row with id ${target}. Nothing was changed.`);
      }
    })();
    logAuditEvent(db, {
      event_type: 'party_consumption.assign',
      entity_type: 'party_consumption',
      entity_id: id,
      actor_email: me.email,
      before: { party_unique_id: row.party_unique_id ?? null, fp_id: row.fp_id ?? null, event_name: name, event_date: date },
      after: { party_unique_id: target, fp_id: newFp },
      note: `Recorded liquor under "${name}" (${date}) assigned to party ${labelOf(chosen)}`,
    });
    return Response.json({ success: true });
  } catch (e: any) {
    if (e instanceof AssignRefused) return Response.json({ error: e.message }, { status: e.status });
    console.error('[/api/party-consumption PATCH]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    const row = db.prepare('SELECT * FROM party_consumption WHERE id = ?').get(id) as any;
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
    if (row.recorded_by !== me.email && me.role !== 'admin') {
      return Response.json({ error: 'Only the recorder or admin can delete' }, { status: 403 });
    }
    db.prepare('DELETE FROM party_consumption WHERE id = ?').run(id);
    return Response.json({ success: true });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
