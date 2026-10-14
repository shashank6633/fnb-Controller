import { canAccessPage } from './page-catalog';
import { tillCapable, CASHIER_PAGE, type SettleActor } from './settle-authority';
import type { SessionUser } from './auth';

/**
 * WHO MAY DOWNLOAD A COPY OF A BILL (GET /api/dine-in/orders/[id]/bill-pdf).
 * ============================================================================
 *
 * ── THE DEFECT THIS FIXES ───────────────────────────────────────────────────
 * The route used to call auth.ts canApproveTableOp(), whose own 403 copy says
 * "Cashier, manager or admin required":
 *
 *   user.role === 'admin' || user.role === 'manager' || user.role_name === 'Cashier'
 *
 * Admin and manager pass on TIER. A cashier could only pass on `role_name`, an
 * EXACT match on an ASSIGNED named role — and role_name is resolved in
 * getCurrentUser() from users.role_id. MEASURED on the owner's database
 * (2026-09-19): role_id is NULL on ALL NINE users, so role_name resolves to null
 * for every one of them and that third arm is DEAD CODE. A cashier has never
 * been able to reprint a bill, which is the owner's own report: "cashier can
 * print at any time".
 *
 * ── WHY canApproveTableOp() ITSELF IS NOT WIDENED ───────────────────────────
 * It has five other callers, and every one of them is a money or authority
 * decision, not a read:
 *   · orders/[id]/service-charge  — waives the service charge (bill goes down)
 *   · orders/[id]/discount        — tests the APPROVER's login, not the caller
 *   · orders/[id] (PATCH)         — table transfer / merge
 *   · dine-in/discount-requests   — who may raise a waiver request
 *   · orders/[id]/settle          — comment only; settleAuthority() is the gate
 * Widening the shared predicate to fix a read-only download would silently
 * widen all of those. So the predicate stays byte-for-byte as it is and THIS
 * route gets its own, narrower question: may this person have a COPY of a bill
 * they can already see?
 *
 * ── THE BOUNDARY, AND WHY IT IS DRAWN HERE ──────────────────────────────────
 * Two arms, in this order:
 *
 *  1. tillCapable(me) — settle-authority.ts's own predicate: admin/manager tier
 *     always, plus staff with an EXPLICIT page map granting '/cashier'. This arm
 *     exists so the copy can never be refused to someone who may CLOSE the bill,
 *     and so it can never be refused to a user who can already open a Bills-on-
 *     Hold record: GET /api/boh/[id] gates on canUseBoh() === tillCapable(), and
 *     that page renders its "Download / reprint" link from the `bill_pdf_url`
 *     the route hands back. Before this change a staff user with an explicit
 *     '/cashier' grant saw that button and got a 403 from it — a visible button
 *     that errors. tillCapable ⊆ this predicate makes that impossible by
 *     construction.
 *
 *  2. canAccessPage('/cashier', me) — may this person open the till screen at
 *     all. /cashier carries no mgmtOnly/hodOnly/adminOnly flag, so this is true
 *     for an admin, and true for anyone whose page map is NULL/empty/garbled
 *     (page-catalog.ts's documented backward-compat grant), and FALSE for anyone
 *     whose explicit map omits '/cashier'.
 *
 * Arm 2 is what makes the owner's requirement work WITHOUT him assigning a role
 * first, which tillCapable alone cannot do: with role_id NULL on every user, a
 * staff cashier's page map resolves NULL, so tillCapable refuses them and only
 * a role assignment in Settings → Roles would let them through. Production
 * config is the owner's (standing rule) — this lane may not assign anything —
 * so the gate has to accept the user as the database actually describes them.
 *
 * WHY THAT IS SAFE FOR A DOCUMENT CARRYING A GUEST NAME, A MOBILE NUMBER AND
 * MONEY — the copy adds no new exposure to anyone arm 2 admits:
 *   · The same test decides whether they may open /cashier itself (proxy.ts
 *     calls canAccessPage), where the bill is listed and openable on screen.
 *   · GET /api/dine-in/orders — the data source that screen reads — gates on a
 *     SESSION ONLY beyond the page map (orders/route.ts:9-10: `if (!me) 401`)
 *     and selects `o.*`: guest_name, guest_mobile, total, the lot. So every
 *     field the PDF prints is already readable over HTTP by anyone arm 2
 *     admits — BUT ONLY FOR THEIR OWN OUTLET. That route scopes its list with
 *     `(o.outlet_id = ? OR o.outlet_id IS NULL)` off getCurrentOutletId()
 *     (orders/route.ts:15-16), and MEASURED on a booted server a staff session
 *     pinned to Branch 2 gets 2 rows, neither of them a Main order.
 *     ⚠️ THIS SENTENCE IS ONLY TRUE BECAUSE THE BILL-PDF ROUTE NOW CARRIES THE
 *     SAME PREDICATE. It first shipped with a bare `WHERE o.id = ?`, which made
 *     this paragraph false in the one direction that matters: a till user of one
 *     outlet could pull another outlet's bill given its id (measured 200 before
 *     the predicate, 404 after). If that predicate is ever dropped, this whole
 *     safety argument goes with it — the claim is "a copy of a bill they can
 *     already see", not "a copy of any bill".
 *   · The route is READ-ONLY: no write, no stock movement, no money. The bill is
 *     stamped DUPLICATE BILL whenever it is a reprint, so a copy cannot be
 *     passed off as an original.
 *
 * WHO IS STILL REFUSED, and it is a real boundary, not a formality:
 *   · anyone without a session (401, unchanged);
 *   · any user whose EXPLICIT page map omits '/cashier' — measured today that is
 *     zzdept@local, page_access ["/requisitions"], refused before and after.
 * So the owner keeps a working lever: give a role (or a user) an explicit page
 * map without the Cashier page and its bills are out of reach.
 *
 * AND ONE REFUSAL THIS PREDICATE DOES NOT MAKE, which the route does: a bill
 * belonging to ANOTHER OUTLET. This function answers "may this person take a
 * copy of a bill", never "which bills" — the route's own outlet predicate is
 * what answers that, and it applies to admins too (their order list is outlet-
 * scoped as well). Any other caller of this predicate owes the same scope.
 *
 * NOTE ON NAMING: nothing in this lane may put the substring "print" in a URL
 * path — proxy.ts makes such a path PUBLICLY UNAUTHENTICATED. This is a lib
 * module, never a route, and the endpoint's path is unchanged.
 */

const actorOf = (me: SessionUser): SettleActor => ({
  id: me.id, name: me.name, email: me.email, role: me.role,
  role_name: me.role_name, page_access: me.page_access, is_head_chef: me.is_head_chef,
});

/**
 * May this user download a copy of a bill?
 *
 * A deliberate SUPERSET of tillCapable() — see the header. Returns false for a
 * null session so a caller can answer 401/403 from the same single test.
 */
export function canDownloadBillCopy(me: SessionUser | null): boolean {
  if (!me || !me.id) return false;
  if (tillCapable(actorOf(me))) return true;
  return canAccessPage(CASHIER_PAGE, me);
}

/** The 403 sentence. Names the fix (the page grant), never "ask for a role". */
export const BILL_COPY_REFUSED_MESSAGE =
  'Your access does not include the Cashier page, so you cannot download a copy of a bill. ' +
  'Ask an admin to grant the Cashier page in Settings → Page Access.';
