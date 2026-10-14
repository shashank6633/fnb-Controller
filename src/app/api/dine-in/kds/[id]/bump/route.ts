import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { emitKds } from '@/lib/kds-bus';
import { sectionMatchesStation } from '@/lib/kot-section';
import {
  applyKotConsumption,
  commitDueKotConsumption,
  getUndoWindowSeconds,
  kotUndoState,
  markKotServed,
  nextKotStatus,
  scheduleDueSweep,
} from '@/lib/kot-completion';

/**
 * POST — advance a KOT exactly ONE step along new → preparing → ready → served.
 *
 * THE TARGET IS DERIVED SERVER-SIDE. This route used to take a `to` status from
 * the request body and set it, which let any signed-in caller drive a ticket
 * BACKWARDS — including out of 'served', which is the completion that moves
 * stock. The body may still carry `to`, but only as an assertion: if it does not
 * match the one step this route was going to take anyway, the request is refused
 * rather than obeyed. Adding a legitimate transition means adding it here, in
 * the server's own table, never in a caller's payload.
 *
 * WHO MAY BUMP. The board's own visibility rule, mirrored exactly: you may bump
 * what you can see. That is the outlet scope plus the Parent Role / Section
 * filter from /api/dine-in/kds (admin, manager and head chef see — and so bump —
 * every section). This is deliberately NOT the settle authority: closing a bill
 * and advancing a kitchen ticket are different powers, and importing the till
 * rules here would refuse the very chefs the board exists for.
 *
 * ON 'served' THE CONSUMPTION IS DEFERRED, NOT POSTED. The ticket is stamped
 * kots.served_at and an undo window opens; only when that window closes does the
 * recipe consume run (src/lib/kot-completion.ts holds the whole argument, the
 * exact-complement predicates and the settle/hold backstop). A window of 0
 * consumes inline, which is exactly the behaviour this route had before.
 *
 * Broadcasts a kot.bumped event either way.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const kot = db.prepare('SELECT * FROM kots WHERE id = ?').get(id) as any;
    if (!kot) return Response.json({ error: 'KOT not found' }, { status: 404 });

    // Outlet + section gate — the same two tests /api/dine-in/kds applies when it
    // decides whether this user may SEE the ticket. A NULL outlet_id is the
    // shared/default outlet and is visible everywhere, so it is bumpable too.
    if (kot.outlet_id && outletId && kot.outlet_id !== outletId) {
      return Response.json({ error: 'This ticket belongs to another outlet' }, { status: 403 });
    }
    const privileged = me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef;
    if (!privileged && me.section && !sectionMatchesStation(me.section, kot.station || '')) {
      return Response.json(
        { error: `${kot.station || 'This'} tickets are not in your section (${me.section})` },
        { status: 403 },
      );
    }

    // Land any consumption whose window has already closed. Cheap (one indexed
    // lookup that normally returns nothing) and it makes a working kitchen the
    // primary heartbeat for the deferral.
    commitDueKotConsumption(db);

    const next = nextKotStatus(kot.status);

    const body = await req.json().catch(() => ({} as any));
    const asserted = body && typeof body.to === 'string' ? String(body.to) : '';
    if (asserted && asserted !== next) {
      return Response.json(
        { error: `This ticket is ${kot.status}; the only move from here is ${next}.`, status: kot.status },
        { status: 409 },
      );
    }
    if (next === kot.status) return Response.json({ status: next, kot });

    const windowSec = getUndoWindowSeconds(db);

    const apply = db.transaction(() => {
      if (next === 'served') {
        // The ticket is COMPLETE. Stamp the serve time on the ticket (the undo
        // window's only anchor) and on its lines (item-journey tracking). A line
        // already scanned 'kitchen_sent' still moves to 'served' here (terminal).
        // NO STOCK MOVES IN THIS BRANCH unless the window is switched off.
        markKotServed(db, id);
        // Window 0 = the undo is switched off, so there is nothing to wait for:
        // consume in this same transaction, exactly as this route always did.
        if (windowSec <= 0) applyKotConsumption(db, id);
      } else {
        db.prepare("UPDATE kots SET status = ?, updated_at = datetime('now') WHERE id = ?").run(next, id);
      }
    });
    apply();

    // Best-effort: fire one sweep just after this window closes, so a chef who
    // walks away from the screen still gets the consume on time. Never the
    // guarantee — see kot-completion.ts.
    if (next === 'served' && windowSec > 0) scheduleDueSweep(db);

    emitKds({ type: 'kot.bumped', outlet_id: kot.outlet_id, station: kot.station, kot: { id, status: next, order_id: kot.order_id } });
    // The undo state rides back on the bump so the board can draw the countdown
    // without a second round trip. It is the server's own reading of served_at,
    // so it stays correct across a refresh.
    const undo = next === 'served' && windowSec > 0 ? kotUndoState(db, id) : null;
    return Response.json({ status: next, undo });
  } catch (e: any) {
    console.error('[/api/dine-in/kds/[id]/bump]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
