import type Database from 'better-sqlite3';
import { logAuditEvent } from './db';
import {
  cashierOnFloor,
  getMyPresence,
  floorLabel,
  normalizeFloor,
  type PresentCashier,
} from './cashier-presence';

/**
 * WHO MAY CLOSE A BILL — the single authority for settle and hold.
 *
 * ONE FUNCTION, TWO ROUTES, ON PURPOSE. Settling writes the sales rows, deducts
 * stock and takes the money; HOLDING freezes the same totals, writes the same
 * sales rows, and parks the bill so it comes back through settle later. They are
 * the same power, so both routes call settleAuthority() and nothing else — gate
 * one without the other and hold IS the bypass.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OVERRIDE MODEL — the owner's final ruling (2026-08-12)
 *
 * An earlier draft of this file shipped a STRICT model: while any cashier held a
 * floor, EVERYONE else — manager and admin included — was refused. The owner
 * replaced it: managers already approve discounts, so manager-settles-with-audit
 * fits the house pattern, and no combination of dead tablet + forgotten
 * check-out + absent cashier may ever strand a payment. Manager/admin is the
 * permanent escape path. That property is the reason this model was chosen —
 * protect it above everything.
 *
 * THE DECISION TABLE (after the till-capability test below):
 *
 *   bill has no floor (takeaway/delivery/deleted table)
 *       → ALLOWED for anyone till-capable ('no_floor').
 *   the actor IS the cashier checked in on the bill's floor
 *       → ALLOWED ('cashier_on_floor'). The normal path.
 *   another cashier holds the floor
 *       manager/admin → ALLOWED ('manager_override') — and RECORDED: who
 *                       settled, when, which cashier was bypassed. Surfaced
 *                       later, never blocked now. The enforcement routes call
 *                       recordSettleOverride() after the write commits.
 *       staff         → REFUSED ('floor_held_by_other'). Ask the holder, or a
 *                       manager. Staff may not evict a live holder (that is the
 *                       presence route's rule too — see checkInGuarded()).
 *   the floor is unmanned (nobody checked in, or the check-in expired)
 *       manager/admin → ALLOWED ('no_cashier_fallback'). Nobody was bypassed,
 *                       so nothing is recorded.
 *       staff         → REFUSED ('needs_check_in'), with offerCheckIn so the UI
 *                       renders the one-tap floor prompt: checking in makes them
 *                       the floor's cashier and lands them in the normal path.
 *
 * Staleness only ever WIDENS who may settle: an expired check-in reads as
 * "unmanned", which admits management without an override record and lets any
 * till-capable staff check in. Expiry can never lock the till.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CAPABILITY TEST — tillCapable()
 *
 * The owner's condition: "if their role has cashier Page access". Applied
 * before everything else, to everyone, with one deliberate asymmetry:
 *
 *   - ADMIN and MANAGER tier are till-capable ALWAYS. They are the audited
 *     escape path; a page map cannot switch the escape path off.
 *   - STAFF are till-capable only with an EXPLICIT resolved page map that
 *     contains '/cashier'. A NULL map — which page-catalog.ts deliberately
 *     reads as "all pages" for NAVIGATION — does NOT satisfy the till.
 *
 * WHY THE STRICTER READING, HERE ONLY. Measured on the dev database 2026-08-12:
 * every active user has role_id NULL, so every page map resolves NULL, and
 * canAccessPage('/cashier', me) passes all of them — captains included. A
 * capability test that passes everyone is not a capability test (review defect
 * D5). page-catalog.ts is NOT touched — its null-map grant gates the whole
 * app's navigation and changing it would change access app-wide. The strict
 * reading lives only inside settle authority and the presence check-in, and
 * BOTH go through this one exported predicate so they can never drift.
 *
 * CONSEQUENCE, deliberately: an unassigned staff-tier user who today can settle
 * anything (the security hole) becomes till-refused, and the refusal copy tells
 * them the actual way out — an admin assigns them the Cashier role (repaired by
 * db.ts to include /cashier) in Settings → Roles. Never "check in first" to
 * someone who cannot. Managers/admins are unaffected, so no till dies on
 * deploy day.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY PRESENCE, NOT ROLE NAME, DECIDES WHO "THE CASHIER" IS
 *
 *   1. A TIER TEST CANNOT SEPARATE THEM. Captain and Cashier are both
 *      base_role 'staff' in the roles table.
 *   2. IT IS WHAT THE OWNER ASKED FOR. Rule (a) is that a cashier says which
 *      floor they are on when they log in. That statement IS the check-in, and
 *      the check-in is the only fact in this system that distinguishes the
 *      person at the Ground Floor till from the person at the Rooftop till.
 *
 * So: whoever is checked in on a floor IS that floor's cashier. tillCapable()
 * is the part that keeps this from being self-service.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY RESULT CARRIES THE FLOOR FACTS (review defect D2). The floor's current
 * holder is looked up BEFORE any branch returns, so every refusal — capability,
 * sign-in, anything — still tells the UI who (if anyone) is checked in on the
 * bill's floor. Copy is rendered from these facts, never guessed from a reason
 * string.
 *
 * Server-only (better-sqlite3 + db.ts). Never import from a "use client"
 * component.
 */

/** The page whose grant is the staff capability test. Must match page-catalog.ts. */
export const CASHIER_PAGE = '/cashier';

/**
 * Machine-readable outcome. Stable strings — a UI switches on these, so treat
 * them as an API and add rather than rename.
 */
export type SettleReason =
  /** Refused: no session. */
  | 'not_signed_in'
  /** Refused: staff tier without an explicit page map granting /cashier —
   *  see tillCapable(). The way out is a role assignment, NOT a check-in. */
  | 'no_page_access'
  /** Allowed: the order has no floor (takeaway / delivery / table deleted). */
  | 'no_floor'
  /** Allowed: the actor is the cashier checked in on this floor. */
  | 'cashier_on_floor'
  /** Allowed: management settling while ANOTHER cashier holds the floor.
   *  `override` is set and the enforcement route must record it. */
  | 'manager_override'
  /** Allowed: the floor is unmanned and the actor is manager/admin. */
  | 'no_cashier_fallback'
  /** Refused: another cashier holds this floor and the actor is staff. */
  | 'floor_held_by_other'
  /** Refused: floor unmanned, actor is till-capable staff — check in to take it. */
  | 'needs_check_in';

/**
 * The subset of SessionUser this needs. Structural, so `SessionUser` from
 * auth.ts satisfies it directly — pass `me` straight through.
 */
export interface SettleActor {
  id: string;
  name?: string | null;
  /** Used only to attribute audit records (recordSettleOverride). */
  email?: string | null;
  /** Tier: 'admin' | 'manager' | 'staff'. */
  role?: string;
  /** Assigned role display name, or null when no role is assigned. */
  role_name?: string | null;
  /** JSON array of granted paths. null = all pages for NAVIGATION (page-catalog
   *  backward compat) but NOT for the till — see tillCapable(). */
  page_access?: string | null;
  is_head_chef?: boolean;
}

export interface SettleAuthority {
  allowed: boolean;
  reason: SettleReason;
  /** A sentence fit to show at the till, naming the person to ask where relevant. */
  message: string;
  /** HTTP status a route should answer with. 200 when allowed. */
  status: 200 | 401 | 403;
  /** restaurant_tables.zone, or null when the order has no floor. */
  floor: string | null;
  /** Display form of `floor` ('' renders as 'Floor'), or null. */
  floorName: string | null;
  /** Who holds this floor right now — populated on EVERY result, refusals
   *  included (D2), so the UI never has to claim "no cashier" without looking. */
  cashier: PresentCashier | null;
  /** Convenience for copy: cashier?.userName or null. Same fact, pre-extracted. */
  floorCashierName: string | null;
  /** Where the actor is checked in right now, if anywhere. */
  myPresence: PresentCashier | null;
  /** Set ONLY on reason 'manager_override': the live cashier being bypassed.
   *  The route that acts on this result MUST call recordSettleOverride() after
   *  its write commits — that call is what makes the override auditable. */
  override: { bypassed: PresentCashier } | null;
  /** UI: offer "Check in to <floor>" — taking the floor makes this actor allowed. */
  offerCheckIn: boolean;
  /** UI: offer "Take over <floor>" — management only; a recorded eviction. */
  offerTakeOver: boolean;
}

/**
 * The floor an order belongs to, or null when it has none.
 *
 * A floor is restaurant_tables.zone and an order reaches one only through
 * table_id. Two ways to get null, and they are deliberately the same answer:
 *   - NO TABLE. A takeaway or delivery bill has no table, so it has no floor.
 *   - TABLE ROW GONE. A table deleted while its bill was still open. The
 *     alternative — treating an unresolvable table as a floor nobody can be
 *     present on — would make that bill permanently unsettleable. An orphaned
 *     bill must be collectable; see the 'no_floor' branch below.
 */
export function orderFloor(db: Database.Database, tableId: unknown): string | null {
  const id = String(tableId ?? '').trim();
  if (!id) return null;
  const row = db.prepare('SELECT zone FROM restaurant_tables WHERE id = ?').get(id) as any;
  if (!row) return null;
  return normalizeFloor(row.zone);
}

/**
 * THE tier predicate for the till — admin or manager tier, NOTHING else.
 *
 * Exported so every surface shows the same answer the server enforces (review
 * defect D10): the presence route's buildStatus() returns THIS, and client code
 * renders from that wire value. It is deliberately NOT auth.ts isManagement():
 * that helper counts is_head_chef as management, but a staff-tier user with the
 * HOD flag is NOT management for the till — they follow the staff rule (D4).
 * (Every SEEDED Head Chef role is manager tier anyway, so this distinction only
 * bites hand-made staff+HOD users — exactly the case D4 flagged.)
 */
export function isManagementTier(me: Pick<SettleActor, 'role'> | null): boolean {
  return !!me && (me.role === 'admin' || me.role === 'manager');
}

/**
 * MAY THIS PERSON WORK A TILL AT ALL — the owner's capability test, made
 * enforceable (review defect D5). Used by settle authority below AND by the
 * presence route's check-in gate; one predicate so the two can never drift.
 *
 *   - admin / manager tier → YES, always. They are the audited override path;
 *     no page map can switch the escape hatch off.
 *   - staff → YES only with an EXPLICIT resolved page map (me.page_access,
 *     already role-resolved by auth.ts) that grants '/cashier'.
 *   - staff with a NULL map → NO. The null map keeps granting page NAVIGATION
 *     (page-catalog.ts's documented backward compat — untouched); the till
 *     demands an explicit grant. Same for '', unparseable JSON and [] — none
 *     of those is an explicit grant of /cashier, whatever forgiving meaning
 *     canAccessPage() assigns them for navigation.
 *
 * The path match mirrors the last line of canAccessPage() (exact, or prefix
 * with a '/' boundary) so a map that opens the /cashier PAGE also opens the
 * till, never one without the other.
 *
 * A refused staff user's way out is a ROLE ASSIGNMENT — the Cashier role,
 * repaired by db.ts's cashier_role_page_grant_v1 to include /cashier — never
 * "check in first", which they cannot do.
 */
export function tillCapable(me: SettleActor | null): boolean {
  if (!me || !me.id) return false;
  if (isManagementTier(me)) return true;
  const raw = me.page_access;
  if (raw == null || String(raw).trim() === '') return false;
  let map: unknown;
  try { map = JSON.parse(String(raw)); } catch { return false; }
  if (!Array.isArray(map) || map.length === 0) return false;
  return map.some(
    (p) => typeof p === 'string' && (CASHIER_PAGE === p || CASHIER_PAGE.startsWith(p + '/')),
  );
}

/** The assign-role sentence — the ONLY correct copy for a till-refused staff
 *  user. Centralised so no surface can drift back to "check in first". */
const ASSIGN_ROLE_MESSAGE =
  'Your role does not include the Cashier page, so you cannot settle bills. ' +
  'Ask an admin to assign you the Cashier role in Settings → Roles.';

/**
 * THE authority. Given an actor and the floor a bill sits on, decide whether
 * they may close it.
 *
 * `floor` null means the bill has no floor — see orderFloor() above.
 *
 * `outletId` semantics (review defect D8): OMITTED (undefined) means "match any
 * outlet" — the forgiving single-outlet behaviour — and is passed through to
 * the presence reads AS omitted. An explicit value (a string, or null/'' for
 * the NULL-default outlet) scopes the reads to that outlet. The old code wrote
 * `outletId ?? null`, which silently turned "omitted" into "outlet ''" — on
 * this database (where every presence row carries a real outlet id) that
 * matched no holder, read every floor as unmanned, and FAILED OPEN.
 */
export function settleAuthorityForFloor(
  db: Database.Database,
  me: SettleActor | null,
  floor: string | null,
  outletId?: string | null,
): SettleAuthority {
  // ── FACTS FIRST (D2). The floor's holder is looked up before ANY branch can
  //    return, so every refusal still carries who is on the floor. undefined
  //    vs null is preserved into both presence reads (D8, D11, D13).
  const holder =
    floor === null
      ? null
      : outletId === undefined
        ? cashierOnFloor(db, floor)
        : cashierOnFloor(db, floor, outletId);
  const mine =
    me && me.id
      ? outletId === undefined
        ? getMyPresence(db, me.id)
        : getMyPresence(db, me.id, outletId)
      : null;

  const base = {
    floor,
    floorName: floor === null ? null : floorLabel(floor),
    cashier: holder,
    floorCashierName: holder ? holder.userName || null : null,
    myPresence: mine,
    override: null as SettleAuthority['override'],
    offerCheckIn: false,
    offerTakeOver: false,
  };

  // ── 0. No session. The routes answer 401 before ever calling this; handled
  //       here too so no caller can turn a missing user into an allow.
  if (!me || !me.id) {
    return {
      ...base, allowed: false, reason: 'not_signed_in', status: 401,
      message: 'Sign in to settle a bill.',
    };
  }

  // ── 1. THE CAPABILITY TEST, applied first and to everyone — including a
  //       holder whose role was tightened after they checked in. Management
  //       always passes, so only staff can be refused here, and the message is
  //       the assign-role sentence: this person CANNOT check in, so offering
  //       them a floor prompt would be a dead end (D1, D12).
  if (!tillCapable(me)) {
    return {
      ...base, allowed: false, reason: 'no_page_access', status: 403,
      message: ASSIGN_ROLE_MESSAGE,
    };
  }

  // ── 2. NO FLOOR → allowed on the capability test alone.
  //
  //       CASE: takeaway / delivery / a bill whose table was deleted. Presence
  //       is a FLOOR concept: a bill with no floor has no floor cashier who
  //       could be present or absent, and no floor to check into. Requiring
  //       presence here would make every takeaway payment permanently
  //       unsettleable — the counter would simply stop taking money.
  if (floor === null) {
    return {
      ...base, allowed: true, reason: 'no_floor', status: 200,
      message: 'This bill is not tied to a floor, so any cashier can settle it.',
    };
  }

  const name = floorLabel(floor);

  // ── 3. A CASHIER HOLDS THIS FLOOR.
  if (holder) {
    // 3a. It is me. The normal path, and the only one that needs no excuse.
    if (holder.userId === me.id) {
      return {
        ...base, allowed: true, reason: 'cashier_on_floor', status: 200,
        message: 'You are the cashier on ' + name + '.',
      };
    }

    // 3b. Somebody else holds it and I am MANAGEMENT → allowed, as an
    //     OVERRIDE. The owner's ruling: managers are already the approval
    //     authority for discounts, so manager-settles-with-audit fits the
    //     house pattern. Surfaced later, never blocked now — the route that
    //     acts on this result records it via recordSettleOverride().
    if (isManagementTier(me)) {
      return {
        ...base,
        allowed: true,
        reason: 'manager_override',
        status: 200,
        override: { bypassed: holder },
        offerTakeOver: true,
        message:
          (holder.userName || 'Another cashier') + ' is the cashier on ' + name +
          '. You can settle this bill — it will be recorded as a manager override.',
      };
    }

    // 3c. Somebody else holds it and I am STAFF → refused. The floor belongs
    //     to its cashier; a second staff user settling past them is exactly
    //     what the check-in exists to prevent. No take-over offer: staff may
    //     not evict a live holder (D6) — that needs management, or the holder
    //     checking out, or the hold expiring on its own.
    return {
      ...base,
      allowed: false,
      reason: 'floor_held_by_other',
      status: 403,
      // 'Someone else', not 'Another cashier', when the denormalised name is
      // blank — "Another cashier is the cashier on Rooftop" stutters.
      message:
        (holder.userName || 'Someone else') + ' is the cashier on ' + name +
        ' — ask them to settle this bill, or ask a manager or admin.',
    };
  }

  // ── 4. THE FLOOR IS UNMANNED — the owner's "absence of Cashier". This is
  //      also what an EXPIRED check-in reads as: staleness only ever widens
  //      who may settle, so a cashier who went home yesterday cannot hold
  //      Floor 2 hostage today.

  // 4a. Management settles an unmanned floor outright. Nobody is bypassed, so
  //     this is a fallback, not an override, and nothing is recorded.
  if (isManagementTier(me)) {
    return {
      ...base, allowed: true, reason: 'no_cashier_fallback', status: 200,
      message: 'No cashier is checked in on ' + name + ', so you can settle this bill.',
    };
  }

  // 4b. Till-capable STAFF on an unmanned floor → check in first, then settle
  //     as its cashier (branch 3a). One tap, and it keeps the register honest:
  //     who took money on which floor is exactly who was checked in there.
  //     offerCheckIn is the flag the UI uses to render the floor prompt
  //     instead of a bare 403 — this actor CAN check in, so the prompt is a
  //     real way out, not a dead end (D1).
  const elsewhere = mine && mine.floor !== floor
    ? ' You are currently checked in on ' + floorLabel(mine.floor) + ' — checking in here will move you.'
    : '';
  return {
    ...base,
    allowed: false,
    reason: 'needs_check_in',
    status: 403,
    offerCheckIn: true,
    message:
      'No cashier is checked in on ' + name +
      '. Check in to this floor to settle bills.' + elsewhere,
  };
}

/**
 * The form the routes call: hands it an order row and it resolves the floor.
 * Accepts anything with a table_id, so both settle and hold can pass the `order`
 * they already fetched.
 */
export function settleAuthority(
  db: Database.Database,
  me: SettleActor | null,
  order: { table_id?: unknown } | null,
  outletId?: string | null,
): SettleAuthority {
  const floor = order ? orderFloor(db, order.table_id) : null;
  return settleAuthorityForFloor(db, me, floor, outletId);
}

/** Convenience for a route: true / false only. Prefer the full result — the
 *  message and the offer flags are what stop a refusal becoming a stuck guest. */
export function canSettleOrder(
  db: Database.Database,
  me: SettleActor | null,
  order: { table_id?: unknown } | null,
  outletId?: string | null,
): boolean {
  return settleAuthority(db, me, order, outletId).allowed;
}

/**
 * THE OVERRIDE LEDGER. Called by the settle and hold routes AFTER their write
 * commits, with the SettleAuthority they enforced. A no-op unless the result
 * was 'manager_override', so the routes call it unconditionally and cannot get
 * the condition wrong. Returns true when an override was actually recorded.
 *
 * WHY THE ROUTES AND NOT THIS MODULE'S DECISION FUNCTION: settleAuthority() is
 * also evaluated ADVISORILY — the captain sheet and the request-bill GET ask
 * "could this person settle?" without settling. Recording at decision time
 * would write an override every time a manager merely LOOKED at a bill on a
 * manned floor. Recording after the committed write means the ledger holds
 * settles that actually happened, nothing else.
 *
 * WHERE IT LANDS: audit_events via logAuditEvent() (append-only, admin-visible
 * at /audit), event_type 'cashier.override_settle' / 'cashier.override_hold',
 * entity the ORDER. Who settled = actor_email + after_json.actor_*; when =
 * created_at; who was bypassed = after_json.bypassed_*. logAuditEvent never
 * throws, so recording can never fail a settle that already took the money.
 */
export function recordSettleOverride(
  db: Database.Database,
  auth: SettleAuthority,
  args: {
    actor: SettleActor;
    orderId: string;
    action: 'settle' | 'hold';
    outletId?: string | null;
  },
): boolean {
  if (auth.reason !== 'manager_override' || !auth.override) return false;
  const b = auth.override.bypassed;
  const actorName = String(args.actor.name || args.actor.email || args.actor.id || '').trim();
  logAuditEvent(db, {
    event_type: 'cashier.override_' + args.action,
    entity_type: 'order',
    entity_id: String(args.orderId),
    actor_email: String(args.actor.email || '') || actorName,
    outlet_id: args.outletId ?? null,
    after: {
      action: args.action,
      floor: auth.floor,
      floor_name: auth.floorName,
      actor_id: args.actor.id,
      actor_name: actorName,
      actor_tier: String(args.actor.role || ''),
      bypassed_user_id: b.userId,
      bypassed_user_name: b.userName,
      bypassed_checked_in_at: b.checkedInAt,
      bypassed_last_seen: b.lastSeen,
    },
    note:
      actorName + ' (' + String(args.actor.role || 'management') + ') ' +
      (args.action === 'hold' ? 'put this bill on hold' : 'settled this bill') +
      ' while ' + (b.userName || 'another cashier') +
      ' was checked in as the cashier on ' + (auth.floorName || 'this floor') +
      ' — manager override.',
  });
  return true;
}
