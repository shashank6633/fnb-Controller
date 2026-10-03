/**
 * Guest Feedback — THE SERVER-SIDE GATE for `/api/feedback/*`.  (P2 Lane A)
 *
 * This file does ONE thing: turn the current session into an actor that
 * `feedbackAccess()` can judge, and hand the route back either the session or a
 * ready-made refusal. The decision itself is NOT made here — it is made in
 * `./access.ts`, which is the module's single authority and is shared with
 * `page-catalog.ts` and `proxy.ts`. Two gates that disagree is a worse bug than
 * two enum lists that disagree, so there is deliberately no second opinion in
 * this file.
 *
 * WHY IT IS A SEPARATE FILE FROM `access.ts`: `access.ts` has zero imports and
 * is reachable from client components. This one imports `@/lib/auth`, which
 * imports `next/headers` and `@/lib/db` — server-only, and dragging it into the
 * browser bundle would pull better-sqlite3 with it (the failure
 * `page-catalog.ts:701` documents).
 *
 * ── ⚠️ THE ROLE TRAP, AND WHY THIS FAILS CLOSED ─────────────────────────────
 * The owner has CREATED a "GRE" role in production (base role Staff). That is
 * step one of two. `getCurrentUser()` resolves `role_name` by joining `roles`
 * through `users.role_id` (`src/lib/auth.ts:95`), so `role_name` stays NULL
 * until a user is ASSIGNED the role. Measured on the working snapshot
 * 2026-09-22:
 *
 *     SELECT COUNT(*) users, SUM(role_id IS NOT NULL) with_role FROM users;
 *     →  9 | 0
 *
 * All nine users have `role_id` NULL. The same trap is already live elsewhere:
 * `auth.ts:184` gates cashier bill-printing on `role_name === 'Cashier'`, and
 * because no user carries a `role_id`, cashiers have never been able to print.
 * So: an unresolved role is a 403, never an allow — and the refusal carries the
 * remedy text, which Page 1 prints verbatim, so the screen says "assign the
 * role" instead of showing a reassuring empty board.
 *
 * ── WHAT THIS FILE ADDS TO THE ACTOR ────────────────────────────────────────
 * `roles.is_active`. `getCurrentUser()` deliberately resolves tier and page map
 * from a DEACTIVATED role (auth.ts:104-107) to avoid a privilege escalation,
 * and therefore never reports whether the role is switched off. `FeedbackActor`
 * takes that as a TRI-STATE where absent means "not looked up" — so if this
 * file did not look it up, a deactivated GRE role would keep granting access.
 * One indexed lookup by `role_id` closes it, and a failure to read falls back
 * to `undefined` (unknown), never to a silent `true`.
 */

import { getCurrentUser, type SessionUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { feedbackAccess, type FeedbackAccessDecision, type FeedbackActor } from './access';

export interface FeedbackGrant {
  ok: true;
  me: SessionUser;
  decision: FeedbackAccessDecision;
  /** True for a GRE: in the module, not management. A GET does not act on it —
   *  it is carried so a future write lane cannot forget the owner's rule. */
  readOnly: boolean;
}

export interface FeedbackRefusal {
  ok: false;
  status: 401 | 403;
  body: {
    error: string;
    reason: FeedbackAccessDecision['reason'];
    /** Printed verbatim on screen — this is where "assign the role" is said. */
    what_to_do: string;
    your_role: string | null;
  };
}

/** `roles.is_active` for the assigned role, as the tri-state the actor wants:
 *  `undefined` means "could not be looked up", which must NOT read as inactive. */
function roleIsActive(roleId: string | null): boolean | undefined {
  if (!roleId) return undefined;
  try {
    const row = getDb().prepare('SELECT is_active FROM roles WHERE id = ?').get(roleId) as any;
    if (!row) return undefined;
    return !!row.is_active;
  } catch {
    return undefined;
  }
}

/** The session, shaped for `feedbackAccess()`. Exported so a future route can
 *  judge a user it already has in hand without re-reading the cookie. */
export function toFeedbackActor(me: SessionUser): FeedbackActor {
  return {
    role: me.role,
    role_name: me.role_name,
    section: me.section,
    is_head_chef: me.is_head_chef,
    role_is_active: roleIsActive(me.role_id),
  };
}

function refuse(status: 401 | 403, d: FeedbackAccessDecision, roleName: string | null): FeedbackRefusal {
  return {
    ok: false,
    status,
    body: { error: d.headline, reason: d.reason, what_to_do: d.remedy, your_role: roleName },
  };
}

/**
 * The gate for Pages 1-3. Every `/api/feedback/*` read route calls this first
 * — hard rule 9: `proxy.ts` guards PAGES, NOT APIs, and `canAccessPage` fails
 * open four ways, so the route's own check is the only real one.
 *
 * FAILS CLOSED ON A THROW. A corrupt cookie or a locked database returns 401
 * rather than letting an exception reach a catch block that might answer 500
 * with a body the UI renders as "nothing to visit today".
 */
export async function requireFeedbackReader(): Promise<FeedbackGrant | FeedbackRefusal> {
  return gate(false);
}

/**
 * Page 2's SUBMIT — `POST /api/feedback`. THE SAME DECISION as
 * `requireFeedbackReader()`, delegated to the same `gate(false)` rather than
 * re-derived: recording the visit IS the GRE's one write in this module, so the
 * population that may open Page 2 is exactly the population that may submit it,
 * and a second predicate here is how two gates start disagreeing.
 *
 * It exists for one reason — so a write route does not have to call something
 * named `…Reader()` and leave the next reader wondering whether the write lane
 * was ever authorised at all. `readOnly` on the grant still means "a GRE, not
 * management", and it remains true for a GRE submitting feedback: the owner's
 * read-only rule is about the POS (orders, quantities, KOTs, bills, discounts),
 * and `gf_*` is not the POS. `POS_WRITE_PREFIXES` in `./pos-readonly.ts` is what
 * enforces that boundary, and `/api/feedback` is deliberately not on it.
 */
export async function requireFeedbackRecorder(): Promise<FeedbackGrant | FeedbackRefusal> {
  return gate(false);
}

/** Page 4 — Admin Analytics & Reports. Management only, matching the catalog's
 *  `mgmtOnly` flag. Here so P5 inherits the same fail-closed shape. */
export async function requireFeedbackAnalyst(): Promise<FeedbackGrant | FeedbackRefusal> {
  return gate(true);
}

async function gate(analytics: boolean): Promise<FeedbackGrant | FeedbackRefusal> {
  let me: SessionUser | null = null;
  try {
    me = await getCurrentUser();
  } catch {
    me = null;
  }

  if (!me) {
    const d = feedbackAccess(null, { analytics });
    return refuse(401, d, null);
  }

  const actor = toFeedbackActor(me);
  const decision = feedbackAccess(actor, { analytics });
  if (!decision.allowed) return refuse(403, decision, me.role_name ?? null);

  // `scope: 'gre'` IS the read-only population — a login carrying the assigned
  // GRE role that is not management. Read it off the decision rather than
  // re-deriving it, so there is one answer to "is this user read-only".
  return { ok: true, me, decision, readOnly: decision.scope === 'gre' };
}
