import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { tillCapable, isManagementTier } from '@/lib/settle-authority';
import {
  checkInGuarded,
  checkOut,
  checkOutUser,
  touchPresence,
  getMyPresence,
  listFloors,
  listPresenceByFloor,
  floorLabel,
  getPresenceTimeoutMinutes,
  normalizeFloor,
  type PresentCashier,
} from '@/lib/cashier-presence';

/**
 * CASHIER FLOOR PRESENCE — the API behind the owner's rule (a):
 *
 *   "When a Cashier Login they should have a dropdown or just after logging in
 *    it should ask for Floor Where the cashier is assigned to floor."
 *
 * GET  → everything the console needs to render: where I am checked in, when
 *        that goes stale, the floors I may pick, and the whole-outlet floor
 *        board (requirement 3 — every floor with its cashier, or nobody).
 * POST → check_in | touch | check_out | force_clear.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY EVERY VERB — INCLUDING GET — IS GATED ON tillCapable()
 *
 * tillCapable() (src/lib/settle-authority.ts) is the ONE predicate for "may
 * this person work a till": management tier always, staff only with an explicit
 * page map granting /cashier. Settle authority applies it and this route
 * applies it, so who can take a floor and who can settle from it can never
 * drift apart — a floor can never be held by someone who could not work it.
 * Measured consequence on the seeded roles: the Captain role's page_access is
 * ["/captain"], so a captain cannot check in at all; the Cashier role (once
 * db.ts's one-shot repair adds "/cashier" to it) can. Staff with NO role
 * assigned (a NULL page map) keep their page NAVIGATION — page-catalog.ts is
 * untouched — but are refused here, with the assign-role sentence as the way
 * out. Under the override model a held floor can no longer brick anyone:
 * management always settles past it (recorded), so the old bricking
 * denial-of-service is gone; this gate now simply keeps the floor register
 * meaningful.
 *
 * EVICTION IS MANAGEMENT-ONLY. check_in on a floor held by a LIVE other
 * cashier answers 409 for staff, naming the holder; manager/admin proceed and
 * the takeover is recorded in audit_events (see checkInGuarded / checkIn).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CSRF. Mutations here are covered by the '/api/dine-in/cashier-presence' prefix
 * added to CSRF_REQUIRED_PREFIXES in src/proxy.ts — without that entry the proxy
 * matches no prefix and waves every POST through unchecked. The browser sends the
 * header automatically because the client calls go through api() from @/lib/api.
 */

/** Shape returned to the console. Timestamps are UTC 'YYYY-MM-DD HH:MM:SS'. */
interface PresenceStatus {
  ok: true;
  me: { id: string; name: string; isManagement: boolean };
  /** Where I am checked in right now, or null → the console must ASK. */
  presence: PresentCashier | null;
  /** When my hold goes stale if I stop touching it. null when not checked in. */
  staleAt: string | null;
  /** Minutes until that, computed server-side so a wrong client clock cannot lie. */
  staleInMinutes: number | null;
  /** The configured inactivity window. */
  timeoutMinutes: number;
  /** Server clock, so the client can render countdowns without clock skew. */
  serverNow: string;
  /** The ONLY floors that may be picked — real zones, never free text. */
  floors: { floor: string; label: string }[];
  /** Requirement 3: every floor, with its cashier or null. */
  board: ReturnType<typeof listPresenceByFloor>;
}

/** 401/403 gate shared by GET and POST. tillCapable is the SAME predicate
 *  settle authority applies; the refusal copy is the assign-role sentence —
 *  this person cannot check in, so "check in first" would be a dead end. */
async function requireCashierAccess() {
  const me = await getCurrentUser();
  if (!me) return { ok: false as const, status: 401, error: 'Sign in required' };
  if (!tillCapable(me)) {
    return {
      ok: false as const,
      status: 403,
      error: 'Your role does not include the Cashier page, so you cannot take a floor. Ask an admin to assign you the Cashier role in Settings → Roles.',
    };
  }
  return { ok: true as const, user: me };
}

/**
 * Assemble the whole console state in one round trip.
 *
 * staleAt is computed by SQLite from last_seen (not in JS from a parsed date):
 * both values then come from the same clock in the same format, so the countdown
 * cannot drift from the window the reads actually enforce.
 */
function buildStatus(
  db: ReturnType<typeof getDb>,
  me: { id: string; name: string; role?: string; is_head_chef?: boolean },
  outletId: string | null,
): PresenceStatus {
  // Outlet-scoped (D11): the same outlet every other read and write on this
  // route uses, so "where am I checked in" can never name a floor from another
  // outlet's board.
  const presence = getMyPresence(db, me.id, outletId);
  const timeoutMinutes = getPresenceTimeoutMinutes(db);
  const serverNow = String((db.prepare("SELECT datetime('now') AS n").get() as any)?.n || '');

  let staleAt: string | null = null;
  let staleInMinutes: number | null = null;
  if (presence) {
    staleAt = String(
      (db.prepare('SELECT datetime(?, ?) AS t').get(presence.lastSeen, `+${timeoutMinutes} minutes`) as any)?.t || '',
    ) || null;
    if (staleAt) {
      // Both strings are UTC from SQLite; the 'Z' makes Date.parse agree.
      const ms = Date.parse(staleAt + 'Z') - Date.parse(serverNow + 'Z');
      staleInMinutes = Number.isFinite(ms) ? Math.round(ms / 60000) : null;
    }
  }

  return {
    ok: true,
    // isManagement here is the SERVER's tier test (admin|manager, exported by
    // settle-authority) — NOT auth.ts isManagement(), which counts is_head_chef.
    // A staff-tier HOD is not management for the till (D4/D10); the client
    // renders from this wire value, so what it promises is what settle enforces.
    me: { id: me.id, name: me.name || '', isManagement: isManagementTier(me) },
    presence,
    staleAt,
    staleInMinutes,
    timeoutMinutes,
    serverNow,
    floors: listFloors(db, outletId).map(f => ({ floor: f, label: floorLabel(f) })),
    board: listPresenceByFloor(db, outletId),
  };
}

/** GET — console state. No side effects: a poll that only READS must never
 *  extend a hold, or a forgotten open tab would keep its floor forever. Only the
 *  explicit `touch` action below bumps last_seen. */
export async function GET() {
  try {
    const gate = await requireCashierAccess();
    if (!gate.ok) return Response.json({ error: gate.error }, { status: gate.status });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    return Response.json(buildStatus(db, gate.user, outletId));
  } catch (e: any) {
    console.error('cashier-presence GET failed:', e);
    return Response.json({ error: 'Could not load floor presence' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const gate = await requireCashierAccess();
    if (!gate.ok) return Response.json({ error: gate.error }, { status: gate.status });
    const me = gate.user;
    const db = getDb();
    const outletId = await getCurrentOutletId();

    const body = await request.json().catch(() => ({} as any));
    const action = String(body?.action || '').trim();

    switch (action) {
      /* ── TAKE A FLOOR ─────────────────────────────────────────────────────
       * The floor must be one the server itself offers. The owner's rule is
       * "offer only floors that exist" — enforced here and not merely in the
       * dropdown, because a typo'd or stale floor string would create a floor
       * that no table belongs to: the cashier would look present, captains'
       * bill requests would route to a floor with no tables, and the real floor
       * they are standing on would still read as unmanned.
       *
       * listFloors() is the SAME list the dropdown is built from, so what the UI
       * offers and what the server accepts can never disagree. Note '' is a
       * legitimate member (the unzoned "Floor"), so this is a membership test,
       * never a truthiness test. */
      case 'check_in': {
        const floor = normalizeFloor(body?.floor);
        const floors = listFloors(db, outletId);
        if (!floors.includes(floor)) {
          return Response.json(
            {
              error: floors.length
                ? 'That floor does not exist. Pick one of: ' + floors.map(floorLabel).join(', ') + '.'
                : 'No floors are set up yet. Add tables with a floor on the Tables page first.',
            },
            { status: 400 },
          );
        }
        // EVICTION POLICY (D6): a floor held by a LIVE other cashier may only
        // be taken by management — staff get a 409 naming the holder. A free
        // floor, an expired hold, or the caller's own floor needs no privilege.
        // checkInGuarded() releases every other floor this user holds, then
        // upserts — moving floors mid-shift is one write and never leaves them
        // "present" on the floor they walked away from. A management takeover
        // is recorded in audit_events by checkIn itself, same transaction.
        const attempt = checkInGuarded(db, {
          userId: me.id, userName: me.name || '', floor, outletId,
          mayEvict: isManagementTier(me),
        });
        if (!attempt.ok) {
          return Response.json({
            error:
              (attempt.heldBy.userName || 'Another cashier') + ' is checked in on ' +
              floorLabel(floor) + '. Ask them to check out, or ask a manager or admin to take over the floor.',
            heldBy: { userId: attempt.heldBy.userId, userName: attempt.heldBy.userName },
          }, { status: 409 });
        }
        return Response.json({
          ...buildStatus(db, me, outletId),
          message: attempt.evicted
            ? 'You are the cashier on ' + floorLabel(attempt.presence.floor) +
              '. Took over from ' + (attempt.evicted.userName || 'the previous cashier') +
              ' — this takeover is recorded.'
            : 'You are the cashier on ' + floorLabel(attempt.presence.floor) + '.',
        });
      }

      /* ── STAY ALIVE ───────────────────────────────────────────────────────
       * Called by the console only while someone is actually using it (see the
       * activity gate in CashierFloorPresence.tsx). touchPresence() refuses to
       * revive a hold that already expired, so an idle tab that wakes up hours
       * later reports presence: null and the console re-asks — it cannot silently
       * reclaim a floor another cashier has since taken. */
      case 'touch': {
        touchPresence(db, me.id);
        return Response.json(buildStatus(db, me, outletId));
      }

      /* ── END OF SHIFT ─────────────────────────────────────────────────────
       * Releases whatever floor this user holds, by user and not by floor, so a
       * stale floor string in the client can never make a check-out silently
       * do nothing. */
      case 'check_out': {
        const released = checkOutUser(db, me.id);
        return Response.json({
          ...buildStatus(db, me, outletId),
          message: released ? 'Checked out. You are no longer on a floor.' : 'You were not checked in.',
        });
      }

      /* ── FORCE-CLEAR SOMEONE ELSE'S FLOOR ─────────────────────────────────
       * The walked-off escape hatch: a cashier who went home without checking
       * out holds their floor until the inactivity window expires, and while
       * they hold it no OTHER STAFF may settle there (management always can,
       * recorded as an override — settle-authority's model).
       *
       * Management TIER only (admin|manager — the same predicate settle
       * enforces; a staff-tier HOD follows the staff rule, D4). checkOut()
       * without a userId clears the floor whoever holds it; cashier-presence.ts
       * leaves that authorization to this route, and records the clear in
       * audit_events, attributed via clearedBy. A cashier releasing their OWN
       * floor uses 'check_out' above, which is keyed to themselves and needs
       * no privilege. */
      case 'force_clear': {
        if (!isManagementTier(me)) {
          return Response.json(
            { error: 'Only a manager or admin can clear another cashier from a floor.' },
            { status: 403 },
          );
        }
        const floor = normalizeFloor(body?.floor);
        const cleared = checkOut(db, {
          floor, outletId,
          clearedBy: { userId: me.id, userName: me.name || '' },
        });
        return Response.json({
          ...buildStatus(db, me, outletId),
          message: cleared
            ? floorLabel(floor) + ' is now free — no cashier is checked in there.'
            : 'Nobody was checked in on ' + floorLabel(floor) + '.',
        });
      }

      default:
        return Response.json(
          { error: 'Unknown action. Expected check_in, touch, check_out or force_clear.' },
          { status: 400 },
        );
    }
  } catch (e: any) {
    console.error('cashier-presence POST failed:', e);
    return Response.json({ error: 'Could not update floor presence' }, { status: 500 });
  }
}
