import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import {
  STALE_TABLE_HOURS_KEY, getStaleTableWindowHours, setStaleTableWindowHours, normalizeWindowHours,
} from '@/lib/stale-tables';

/**
 * THE AUTO-CLOSE WINDOW — read by anyone signed in, written by an admin only.
 *
 * The value is a number of hours. 0 means OFF, and OFF is the seeded default
 * (db.ts writes it with INSERT OR IGNORE, so the owner's chosen value survives
 * every deploy). Turning it on starts a timer closing EMPTY tables — orders
 * with zero order_items, where there is no bill and nothing was consumed. It
 * has no effect whatsoever on a table that has items: the sweep's UPDATE
 * carries NOT EXISTS (SELECT 1 FROM order_items …) in the statement itself
 * (src/lib/stale-tables.ts), so no value written here can make a timer close
 * one of those.
 *
 * The value itself is owned by src/lib/stale-tables.ts — this route validates
 * the input, delegates the read and the write to that module's getter/setter,
 * and ledgers the change. It does not touch the settings table directly, so
 * there is one definition of "what a window is" and one clamp.
 *
 * WHY THIS ROUTE EXISTS RATHER THAN THE GENERIC /api/settings PUT.
 * The manager screen must show and change the window without sending anyone
 * hunting through Settings, and this switch decides whether a background job
 * closes orders — an admin decision, while the generic settings writer admits
 * managers too. Note the honest gap: the key is not registered in that
 * endpoint's KEY_POLICY table (src/app/api/settings/route.ts is owned by
 * neither track in this build), so a manager can still write
 * stale_table_auto_close_hours through the generic door. Closing that is a
 * one-line KEY_POLICY entry:
 *     ['stale_table_auto_close_hours', { write: 'admin',
 *       writeError: 'Admin role required to change the idle-table window' }]
 * Until that lands, treat the admin gate here as the UI's gate, not a hard one.
 * The blast radius if a manager did flip it is bounded to empty tables by the
 * statement above — it cannot reach money.
 */

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const hours = getStaleTableWindowHours(getDb());
    return Response.json({ hours, enabled: hours > 0, can_change: me.role === 'admin' });
  } catch (e: any) {
    console.error('[/api/dine-in/stale-tables/window GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin') {
      return Response.json({ error: 'Admin role required to change the idle-table window' }, { status: 403 });
    }
    const b = await request.json().catch(() => ({}));
    // REFUSE JUNK RATHER THAN NORMALISING IT. normalizeWindowHours() reads
    // anything unparseable as 0 = OFF, which is the right reading for a garbled
    // stored setting (fail safe) but the wrong one for a form post: an admin who
    // fat-fingers the field would be told "saved" and silently get OFF. A
    // negative number is the same mistake. Only a real number reaches the setter.
    const raw = Number(b?.hours);
    if (b?.hours === '' || b?.hours == null || !Number.isFinite(raw)) {
      return Response.json({ error: 'hours must be a number (0 = off)' }, { status: 400 });
    }
    if (raw < 0) return Response.json({ error: 'hours cannot be negative (0 = off)' }, { status: 400 });

    const db = getDb();
    const before = getStaleTableWindowHours(db);
    // The lib owns the clamp (and the upsert). It rounds to 2 decimals and caps
    // at its own ceiling, so compare what was asked for with what it stored and
    // tell the admin when those differ instead of letting the field lie.
    // normalizeWindowHours is the same function the setter runs, called here
    // only to name the comparison; the setter's return is the stored truth.
    const hours = setStaleTableWindowHours(raw, db);
    const clamped = Math.abs(normalizeWindowHours(raw) - raw) > 0.001;

    // Ledger it. This switch turns a background job that closes orders on and
    // off; "who turned it on, and when" is exactly the question a later report
    // will ask about a run of automatic voids. logAuditEvent never throws.
    logAuditEvent(db, {
      event_type: 'settings.stale_table_window',
      entity_type: 'setting',
      entity_id: STALE_TABLE_HOURS_KEY,
      actor_email: me.email || '',
      outlet_id: await getCurrentOutletId(),
      before: { hours: before },
      after: { hours },
      note: hours === 0
        ? 'Idle-table auto-close switched OFF'
        : `Idle EMPTY tables auto-close after ${hours}h (tables with items are never auto-closed)`,
    });

    return Response.json({
      success: true,
      hours,
      enabled: hours > 0,
      // Non-null only when the stored value is not the number that was sent.
      adjusted_from: clamped ? raw : null,
    });
  } catch (e: any) {
    console.error('[/api/dine-in/stale-tables/window POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
