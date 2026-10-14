import { canApproveTableOp, type SessionUser } from './auth';
import { tillCapable, type SettleActor } from './settle-authority';

/**
 * WHO MAY DOWNLOAD A COPY OF A BILL (GET /api/dine-in/orders/[id]/bill-pdf).
 * ============================================================================
 *
 * THE OWNER'S RULE (approved 2026-10-14): the Cashier, plus managers and
 * admins, may download a settled or held bill. Plain staff are REFUSED, as they
 * were before this file existed.
 *
 * ── HOW "THE CASHIER" IS NAMED IN THIS APP ──────────────────────────────────
 * Nothing new is invented here. The app already has exactly two tests for "is
 * this person the cashier", and this predicate is their union:
 *
 *  1. canApproveTableOp() (auth.ts) — production's gate on this route, kept
 *     byte-for-byte: admin tier, manager tier, or the assigned role NAMED
 *     'Cashier' (roles.name, seeded by db.ts). Nobody production admitted is
 *     refused by this change.
 *
 *  2. tillCapable() (settle-authority.ts) — the till's own capability test, the
 *     one settle, hold and Bills-on-Hold already use: admin/manager tier, plus
 *     staff whose EXPLICIT resolved page map grants '/cashier'. The seeded
 *     Cashier role carries '/cashier' (db.ts cashier_role_page_grant_v1), so a
 *     login with that role passes both arms. This arm exists so the copy is
 *     never refused to someone who may CLOSE the bill, and so the Bills-on-Hold
 *     page — whose API (GET /api/boh/[id]) admits exactly tillCapable() users
 *     and hands them `bill_pdf_url` for its "Download / reprint" link — never
 *     shows a button that answers 403.
 *
 * ── WHO IS REFUSED, AND WHY THE NULL PAGE MAP MATTERS ───────────────────────
 * A staff login with NO page map (users.page_access NULL and no role) is the
 * "plain staff" the owner named. page-catalog.ts reads a NULL map as "every
 * page" for NAVIGATION, so a canAccessPage('/cashier') test would admit that
 * login — which is precisely the defect an earlier draft of this file shipped
 * (btl-staff@test: production 403, draft 200). Neither arm above reads a NULL
 * map as a grant: canApproveTableOp never looks at pages, and tillCapable
 * demands an explicit map containing '/cashier'. So, refused:
 *   · no session (the route answers 401 before asking);
 *   · staff with a NULL / empty / unparseable page map and no Cashier role;
 *   · staff whose explicit page map omits '/cashier' (e.g. ["/requisitions"]).
 *
 * The owner's lever is unchanged and lives in Settings → Roles: assign the
 * Cashier role and the copy opens; take it away and it closes. This file
 * assigns nothing and creates no role.
 *
 * ── WHAT THIS DOES NOT DECIDE ───────────────────────────────────────────────
 * "May this person take a copy of a bill" — never "which bills". The route's
 * own outlet predicate (the same one the order list uses) answers that, for
 * admins too. Any other caller of this predicate owes the same scope.
 *
 * WHY canApproveTableOp() ITSELF IS NOT WIDENED: its other callers (service-
 * charge waiver, discount approval, table transfer/merge, discount requests)
 * are money and authority decisions. A read-only copy gets its own question.
 *
 * NOTE ON NAMING: no URL path in this app may contain the substring "print" —
 * proxy.ts makes such a path publicly unauthenticated. This is a lib module,
 * never a route, and the endpoint's path is unchanged.
 */

const actorOf = (me: SessionUser): SettleActor => ({
  id: me.id, name: me.name, email: me.email, role: me.role,
  role_name: me.role_name, page_access: me.page_access, is_head_chef: me.is_head_chef,
});

/**
 * May this user download a copy of a bill?
 *
 * canApproveTableOp(me) || tillCapable(me) — see the header. Returns false for
 * a null session so a caller can answer 401/403 from the same single test.
 */
export function canDownloadBillCopy(me: SessionUser | null): boolean {
  if (!me || !me.id) return false;
  if (canApproveTableOp(me)) return true;
  return tillCapable(actorOf(me));
}

/** The 403 sentence: production's wording, plus the owner's actual remedy. */
export const BILL_COPY_REFUSED_MESSAGE =
  'Cashier, manager or admin required. ' +
  'Ask an admin to assign you the Cashier role in Settings → Roles.';
