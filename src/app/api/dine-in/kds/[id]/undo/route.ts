import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { emitKds } from '@/lib/kds-bus';
import { sectionMatchesStation } from '@/lib/kot-section';
import {
  commitDueKotConsumption,
  kotUndoState,
  undoServedKot,
  type UndoRefusal,
} from '@/lib/kot-completion';

/**
 * UNDO A COMPLETED KOT — take back a KDS 'Served' bump inside its window.
 *
 * GET  → the undo state for this ticket (undoable? how many seconds left?),
 *        computed from kots.served_at on the server. The KDS board polls it once
 *        a second while a ticket is inside its window, which is ALSO what lands
 *        the deferred consume within about a second of the window closing — this
 *        endpoint is the deferral's heartbeat as well as its read model. That is
 *        why a GET writes: the sweep it runs is idempotent and only ever posts
 *        work that is already due.
 * POST → perform the undo. Every refusal is a WHERE clause on the single UPDATE
 *        (src/lib/kot-completion.ts), so a late undo changes nothing instead of
 *        racing the sweep.
 *
 * NOTHING IS EVER CREDITED BACK. Inside the window the consumption has not been
 * posted, so an undo has nothing to reverse; outside it, the undo is refused.
 * That is the whole design — see the note in orders/[id]/void about why a
 * compensating-credit path is not allowed to exist.
 *
 * WHO MAY UNDO: whoever may bump. Same outlet + section test as
 * kds/[id]/bump, for the same reason — you may take back only what you can see.
 */

/** Operator-facing copy for a refusal. The UI renders these verbatim. */
const REFUSAL_TEXT: Record<UndoRefusal, string> = {
  kot_not_found:    'That ticket no longer exists.',
  not_served:       'That ticket is not marked served — nothing to undo.',
  window_closed:    'Too late to undo — the ingredients have already come off stock.',
  already_deducted: 'Too late to undo — the bill took the ingredients off stock.',
  order_closed:     'Too late to undo — the order is no longer open.',
};

/** Shared gate: signed in, same outlet, ticket in the caller's section. */
async function gate(id: string) {
  const me = await getCurrentUser();
  if (!me) return { error: 'Sign in required', status: 401 as const };
  const db = getDb();
  const outletId = await getCurrentOutletId();
  const kot = db.prepare('SELECT id, outlet_id, station, order_id FROM kots WHERE id = ?').get(id) as any;
  if (!kot) return { error: 'KOT not found', status: 404 as const };
  if (kot.outlet_id && outletId && kot.outlet_id !== outletId) {
    return { error: 'This ticket belongs to another outlet', status: 403 as const };
  }
  const privileged = me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef;
  if (!privileged && me.section && !sectionMatchesStation(me.section, kot.station || '')) {
    return { error: `${kot.station || 'This'} tickets are not in your section (${me.section})`, status: 403 as const };
  }
  return { db, kot, me };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const g = await gate(id);
    if ('error' in g) return Response.json({ error: g.error }, { status: g.status });

    // Heartbeat: post anything whose window has closed BEFORE reading state, so
    // the answer this returns already reflects the commit the caller is waiting
    // for instead of reporting a window that is open and a stock that is not.
    commitDueKotConsumption(g.db);

    const state = kotUndoState(g.db, id);
    if (!state) return Response.json({ error: 'KOT not found' }, { status: 404 });
    return Response.json(
      { ...state, message: state.reason ? REFUSAL_TEXT[state.reason] : '' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('[GET /api/dine-in/kds/[id]/undo]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const g = await gate(id);
    if ('error' in g) return Response.json({ error: g.error }, { status: g.status });

    const r = undoServedKot(g.db, id);
    if (!r.ok) {
      const state = kotUndoState(g.db, id);
      return Response.json(
        {
          ok: false,
          error: r.reason ? REFUSAL_TEXT[r.reason] : 'Could not undo this ticket.',
          reason: r.reason,
          status: r.status,
          undo: state,
        },
        { status: 409 },
      );
    }

    // Put the ticket back on every board that dropped it when it went served.
    emitKds({
      type: 'kot.bumped',
      outlet_id: g.kot.outlet_id,
      station: g.kot.station,
      kot: { id, status: r.status, order_id: g.kot.order_id },
    });
    return Response.json({ ok: true, status: r.status });
  } catch (e: any) {
    console.error('[POST /api/dine-in/kds/[id]/undo]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
