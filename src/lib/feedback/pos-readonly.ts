/**
 * Guest Feedback — THE READ-ONLY DENY. The owner's rule as ONE list and ONE test.
 *
 * > 🔒 "The GRE/Manager may view ordered items but has READ-ONLY ACCESS. They
 * >    cannot: place orders · cancel items · change quantity · modify KOT ·
 * >    modify bill · apply discounts. This must be enforced server-side, not
 * >    merely hidden in the UI."
 *
 * ── WHY A PREFIX LIST AND NOT THIRTEEN EDITS ────────────────────────────────
 * The obvious implementation is `if (isReadOnlyFeedbackUser(me)) return 403` at
 * the top of every POS write handler. Measured on this branch that is fourteen
 * separate edits to shipped code a captain depends on every service, and each
 * one is a place the NEXT POS route can forget. Worse, the measured failure of
 * the naive version is that it covers `PATCH /api/dine-in/orders/[id]` and
 * calls the job done — four of the owner's six forbidden actions — while
 * `POST /api/dine-in/orders/replay` and `POST /api/dine-in/customer-orders/[id]`
 * stay open, and those are the other two doors into the same order rows.
 *
 * So the rule lives HERE, as PREFIXES, and is applied at exactly ONE boundary
 * (`src/proxy.ts`, inside the query that already runs for every state-changing
 * API call). A new POS write route under any listed prefix inherits the denial
 * on the day it is created, with no fourteenth edit in a fourteenth handler.
 *
 * ── ZERO IMPORTS EXCEPT `./access` ──────────────────────────────────────────
 * `./access.ts` has no imports at all and is deliberately reachable from client
 * bundles; this file keeps that property so the proxy (Node runtime) and any
 * future route can both read it. Never import `@/lib/db`, `@/lib/auth` or React
 * here.
 *
 * ⚠️ Use the deep path `@/lib/feedback/pos-readonly` (or `./pos-readonly`).
 * `@/lib/feedback` always resolves to the FILE `src/lib/feedback.ts`, never to
 * this directory — see the resolution trap in FEEDBACK-BUILD-STATE.md §6.
 */

import { isReadOnlyFeedbackUser, type FeedbackActor } from './access';

/* ════════════════════════════════════════════════════════════════════════════
   1. THE LIST — the six forbidden actions, mapped onto real route prefixes
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * PREFIXES, not routes. Every entry was checked against the route files that
 * exist on this branch (`find src/app/api/dine-in -name route.ts`), and each
 * line says which of the owner's six powers it closes.
 *
 * ⚠️ DELIBERATELY ABSENT: `/api/dine-in/service-requests`. Answering a table's
 * service bell is guest-relations work — it is the GRE's actual job — and the
 * owner never forbade it. It writes no order line, no KOT and no money. Adding
 * it here would stop a GRE acknowledging the bell they were sent to answer.
 * Leave it out, and leave this paragraph in so the next lane does not "tidy" it
 * into the list.
 */
export const POS_WRITE_PREFIXES: readonly string[] = [
  /**
   * PLACE ORDERS · CANCEL ITEMS · CHANGE QUANTITY · MODIFY KOT · MODIFY BILL.
   * The whole order family, and it is one prefix because all five powers live
   * under it:
   *   · POST   /api/dine-in/orders              open a table (gate today: `!me`
   *            plus canWorkTable(), which is INERT — `captain_area_lock` has 0
   *            rows — so a staff login passes)
   *   · PATCH  /api/dine-in/orders/[id]         add_item · set_qty · remove_item
   *            · fire  (gate today: `if (!me) return 401` and nothing else)
   *   · POST   /api/dine-in/orders/replay       rebuilds whole orders + items
   *            from the offline outbox (gate today: `!me`) — door #2 into the
   *            same rows, and the one a per-handler fix forgets
   *   · POST   /api/dine-in/orders/[id]/settle · /void · /hold · /discount ·
   *            /service-charge · /print-bill · /request-bill · /guests
   * Several of those already refuse a staff tier on their own (void and settle
   * do). This prefix does not depend on that and does not care which ones do —
   * it refuses the whole family for one population.
   *
   * 🔑 print-bill and request-bill ARE included, for a non-obvious reason worth
   * keeping: they stamp `orders.bill_printed_at` and `orders.bill_requested_at`,
   * which are TWO OF THIS MODULE'S THREE ELIGIBILITY TRIGGERS. A GRE who may
   * write them can manufacture — or suppress — the very rows that decide
   * whether a table appears on their own coverage board. A coverage metric the
   * measured party can write is not a metric.
   */
  '/api/dine-in/orders',

  /**
   * PLACE ORDERS (second door). POST /api/dine-in/customer-orders/[id] is the
   * captain's approve / reject / modify of a QR-menu order: `approve` fires the
   * items to the KDS and MERGES them into the table's live bill, and `modify`
   * runs `UPDATE order_items SET quantity` / `DELETE FROM order_items`. That is
   * "place orders", "change quantity" and "cancel items" in one handler whose
   * only gate today is `if (!me) return 401`.
   */
  '/api/dine-in/customer-orders',

  /**
   * MODIFY KOT — and, less obviously, an INVENTORY WRITE.
   *
   * POST /api/dine-in/kds/[id]/bump is not a display action. Bumping to the
   * final state runs the deferred recipe consume (src/lib/kot-completion.ts):
   * it stamps `order_items.recipe_deducted_at` and DEDUCTS RAW-MATERIAL STOCK,
   * and because the stamp is the idempotence key it can never be undone — the
   * file's own comment says "never clear recipe_deducted_at", and void/route.ts
   * refuses an order once any line carries it. So a GRE bumping a ticket would
   * permanently deduct stock AND lock the order out of being voided.
   *
   * Its gate today lets a GRE through: the section test is
   * `!privileged && me.section && !sectionMatchesStation(...)`, and
   * `users.section` is `''` for every user on the measured database, so the
   * `me.section &&` short-circuits and no 403 is ever reached.
   *
   * The prefix also covers /escalate, /reprint, /resend, /undo and /scan-out —
   * every one of them a KOT modification. The KDS SSE feed
   * (/api/dine-in/kds/stream) is a GET and is untouched, so a GRE's screen keeps
   * updating live.
   */
  '/api/dine-in/kds',

  /**
   * APPLY DISCOUNTS. POST /api/dine-in/discount-requests raises a bill discount
   * or a service-charge waiver; POST .../[id]/decide approves one. The decide
   * route is manager-gated already and the raise route checks
   * `can_request_discount`, which is 0 on a fresh role — but "the role happens
   * to have the flag off" is a configuration, not an enforcement. One tick of
   * "can request discount" in Settings → Roles would otherwise hand a GRE the
   * one power the owner named twice.
   */
  '/api/dine-in/discount-requests',

  /**
   * The POS table master (create / rename / delete / zone). Not one of the six
   * by name, but a GRE who can delete a table can delete the thing their own
   * board counts. Manager-gated today (`me.role !== 'admin' && !== 'manager'`),
   * so this line changes nothing for anyone — it is here so the module states
   * the rule rather than inheriting it from another file that could change.
   */
  '/api/dine-in/tables',
];

/* ════════════════════════════════════════════════════════════════════════════
   2. THE TEST — anchored, never a substring
   ════════════════════════════════════════════════════════════════════════════ */

/** The methods that can change state. GET/HEAD/OPTIONS are reads: the owner
 *  explicitly allows a GRE to VIEW ordered items, so they must never be denied
 *  here. Mirrors `isStateChanging()` in proxy.ts. */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Is `p` a prefix of `pathname` at a PATH BOUNDARY?
 *
 * `pathname === p || pathname.startsWith(p + '/')` — and NEVER a bare
 * `includes()`. This app already paid for that lesson: `isPublic()`'s
 * `pathname.includes('/print')` made seven API routes publicly routable AND
 * CSRF-exempt, among them the one that stamps `bill_printed_at`. A substring
 * test here would be the same mistake with the sign flipped — it would refuse
 * `/api/reports/dine-in/orders-summary` (a read) while still missing nothing
 * useful.
 *
 * The comparison is CASE-FOLDED. Next's file-system router is case-sensitive,
 * so `/API/dine-in/orders` 404s rather than reaching the handler and there is
 * nothing to deny — but folding can only ever deny MORE for the one population
 * that is already fully denied on the canonical spelling, so it costs nothing
 * and removes the need to be right about Next's matching.
 */
function matchesPrefix(pathname: string, p: string): boolean {
  const a = pathname.toLowerCase();
  const b = p.toLowerCase();
  return a === b || a.startsWith(b + '/');
}

/**
 * Does this request target a POS WRITE?
 *
 * Both the raw pathname and its percent-decoded form are tested, and EITHER
 * matching is a match. `NextRequest.nextUrl.pathname` keeps percent-encoding,
 * so `/api/dine-in/%6Frders/x` is not string-equal to the prefix; whether Next
 * normalises that before routing is not a thing this deny should depend on.
 * Decoding can only widen the test, and a malformed sequence throws, which is
 * caught and ignored.
 */
export function isPosWritePath(pathname: unknown, method: unknown): boolean {
  const m = String(method ?? '').trim().toUpperCase();
  if (!STATE_CHANGING.has(m)) return false;

  const raw = String(pathname ?? '');
  if (!raw) return false;
  if (POS_WRITE_PREFIXES.some(p => matchesPrefix(raw, p))) return true;

  let decoded = '';
  try { decoded = decodeURIComponent(raw); } catch { return false; }
  if (decoded === raw) return false;
  return POS_WRITE_PREFIXES.some(p => matchesPrefix(decoded, p));
}

/**
 * 🔒 THE ONE QUESTION THE BOUNDARY ASKS. True ⇒ answer 403.
 *
 * `isReadOnlyFeedbackUser()` (./access.ts) is false for everyone who is not an
 * ASSIGNED, ACTIVE GRE that is not also management. Captains, cashiers, Floor
 * Managers, Managers, HODs and Administrators all answer false, and so does
 * every one of the users on the measured database, because `users.role_id` is
 * NULL for all of them and an unresolved role is never a match.
 *
 * ⚠️ THAT IS WHY THIS IS INERT UNTIL THE OWNER ASSIGNS THE ROLE, and it is the
 * property that makes it safe to ship mid-service: on the day it deploys it
 * refuses NOBODY. It starts refusing exactly one person the moment an
 * administrator assigns the "GRE" role to that person's login — which is also
 * the moment that person is supposed to become read-only.
 *
 * It errs toward ALLOWING, never toward refusing: an unresolved session, a
 * missing role, a deactivated role, a DB read that failed — every one of those
 * produces `false` here and the POS write proceeds to the handler's own gate.
 * The opposite bias would refuse a live captain on a bad database read.
 */
export function refusePosWrite(
  user: FeedbackActor | null | undefined,
  pathname: unknown,
  method: unknown,
): boolean {
  if (!isPosReadOnlyActor(user)) return false;
  return isPosWritePath(pathname, method);
}

/**
 * ⚠️ THE ONE DELIBERATE DIVERGENCE FROM `isReadOnlyFeedbackUser()`, AND THE
 * REASON IS A MEASURED ESCALATION.
 *
 * `isNamedGre()` refuses to match a DEACTIVATED role — correctly, because for
 * ACCESS a refusal only ever REMOVES this module's three pages. A deny has the
 * opposite sign, and inheriting that rule produced a real hole. Measured on
 * this branch, port 3951, before this function existed:
 *
 *     UPDATE roles SET is_active=0 WHERE id='gfqa-role-gre';
 *     PATCH /api/dine-in/orders/zz-nope  (assigned GRE) → 404 "Order not found"
 *     POST  /api/dine-in/kds/zz-nope/bump (assigned GRE) → 404 "KOT not found"
 *
 * A 404 from the handler means the request went THROUGH: switching the GRE role
 * off in Settings → Roles took the feedback pages away AND handed that login
 * the POS back. That is the exact failure `auth.ts:104-107` documents for the
 * page map — "a deactivated role keeps governing its users ... otherwise a
 * role-based user would fall back to ... ALL pages (privilege escalation)" —
 * and it must not be re-introduced through a side door.
 *
 * So the deny asks its authority the same question with the tri-state set to
 * "not looked up": is this login ASSIGNED the GRE role, leaving aside whether
 * the role is switched on? `./access.ts` still owns the role-name spelling and
 * the management carve-out; this file adds no second copy of either. A login
 * that is management, or carries any other role, or carries none, still answers
 * false on both calls — so this widens the denied population by nobody except
 * the assigned GRE whose role was switched off.
 *
 * Switching the role off is therefore NOT the way to give a GRE the POS back;
 * REASSIGNING them to another role is, and that is the one action an
 * administrator can see the effect of.
 */
export function isPosReadOnlyActor(user: FeedbackActor | null | undefined): boolean {
  if (isReadOnlyFeedbackUser(user)) return true;
  if (!user || typeof user !== 'object' || Array.isArray(user)) return false;
  return isReadOnlyFeedbackUser({ ...user, role_is_active: null });
}

/* ════════════════════════════════════════════════════════════════════════════
   3. THE REFUSAL — plain words, naming the module
   ════════════════════════════════════════════════════════════════════════════ */

/** Machine-readable reason, so a client can tell this 403 from a CSRF 403. */
export const POS_READONLY_REASON = 'feedback_read_only';

/**
 * The 403 body. Same shape the module's other refusals use
 * (`error` · `reason` · `what_to_do`), so one client handler renders all of
 * them.
 *
 * It says "you are on a feedback visit", not "the app is broken". A GRE reading
 * this is holding a tablet in front of a guest; the sentence has to explain the
 * rule and point at the person who can act, in one breath.
 */
export function posWriteRefusalBody(pathname?: unknown): {
  error: string;
  reason: string;
  what_to_do: string;
  path: string;
} {
  return {
    error:
      'Guest Feedback: this login is a Guest Relations (GRE) login, which has READ-ONLY access to '
      + 'orders. You can open a table and see everything that was ordered, but you cannot place or '
      + 'change an order, cancel an item, change a quantity, bump or reprint a KOT, print or change '
      + 'a bill, or apply a discount.',
    reason: POS_READONLY_REASON,
    what_to_do:
      'Ask the table\'s captain or the floor manager to make the change — they have the POS login '
      + 'for it. If this login is meant to run the POS as well as take feedback, an administrator '
      + 'can change its assigned role in Settings → Roles; a login carrying the "GRE" role is '
      + 'read-only on orders by design.',
    path: String(pathname ?? ''),
  };
}
