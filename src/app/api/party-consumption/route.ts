import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { resolvePartyEventNames, partyLiquorReqItems } from '@/lib/party-liquor';

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
 * GET    /api/party-consumption?party_unique_id=...
 * GET    /api/party-consumption?event_name=...&event_date=YYYY-MM-DD
 *        -> { entries, requisition_items }
 * POST   /api/party-consumption
 *        body: { party_unique_id?, fp_id?, event_name, event_date,
 *                items: [{ material_id, qty, notes? }], confirm_duplicates? }
 *        -> 409 { error, duplicates } when an item is already costed from the
 *           requisition and confirm_duplicates is not true
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

    if (!partyUniqueId && !(eventName && eventDate)) {
      return Response.json({ error: 'party_unique_id or (event_name+event_date) required' }, { status: 400 });
    }

    // Resolve the party to the SAME name list + date /api/party-events/pnl uses,
    // so the rows below are exactly the rows counted in liquor_items there. A
    // requisition is raised under the contact person / company / FP id, not
    // necessarily the event name, so matching on one guessed name would show
    // fewer rows than the badge counts — the mismatch this fix exists to close.
    const { names, eventDate: resolvedDate } = resolvePartyEventNames(db, {
      party_unique_id: partyUniqueId || undefined,
      event_name: eventName || undefined,
      event_date: eventDate || undefined,
    });

    let rows;
    if (partyUniqueId) {
      // A row with NO party_unique_id still belongs to this party — POST stores
      // `party_unique_id || null`, so the bar can record before the AKAN sheet has
      // issued an id. The P&L COUNTS those orphans (same predicate, in pnlFor's
      // consumption arm); matching the id alone here would leave them counted and
      // invisible, which is the same badge-vs-modal lie one table over.
      const nameArm = names.length && resolvedDate
        ? ` OR (pc.party_unique_id IS NULL AND pc.event_date = ? AND pc.event_name IN (${names.map(() => '?').join(',')}))`
        : '';
      rows = db.prepare(`
        SELECT pc.*, rm.name AS material_name, rm.unit AS material_unit,
               rm.average_price AS current_avg_price
        FROM party_consumption pc
        JOIN raw_materials rm ON rm.id = pc.material_id
        WHERE pc.party_unique_id = ?${nameArm}
        ORDER BY pc.recorded_at DESC
      `).all(partyUniqueId, ...(nameArm ? [resolvedDate!, ...names] : []));
    } else {
      rows = db.prepare(`
        SELECT pc.*, rm.name AS material_name, rm.unit AS material_unit,
               rm.average_price AS current_avg_price
        FROM party_consumption pc
        JOIN raw_materials rm ON rm.id = pc.material_id
        WHERE pc.event_name = ? AND pc.event_date = ?
        ORDER BY pc.recorded_at DESC
      `).all(eventName, eventDate);
    }

    // READ-ONLY. Already costed into liquor_cost from the Bar requisition; shown
    // so the modal accounts for the whole liquor figure instead of half of it.
    const requisitionItems = partyLiquorReqItems(db, names, resolvedDate);
    return Response.json({ entries: rows, requisition_items: requisitionItems });
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
    const { names, eventDate: resolvedDate } = resolvePartyEventNames(db, {
      party_unique_id: party_unique_id || undefined,
      event_name: String(event_name).trim(),
      event_date,
    });
    const alreadyCosted = new Map(
      partyLiquorReqItems(db, names, resolvedDate).map(r => [r.material_id, r]));
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
        //    writer is the recorder in src/app/party-pnl/page.tsx:354, which
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
