/**
 * Guest Feedback & Service Recovery — THE ACCESS GATE. One file, one answer.
 *
 * ⚠️ ZERO IMPORTS, AND THAT IS LOAD-BEARING. This module is read by
 * `src/lib/page-catalog.ts` (which is bundled into CLIENT components — Sidebar,
 * /customers, /settings/page-access), by `src/proxy.ts` (Node runtime), and by
 * every future `/api/feedback/*` route handler. A single `import { getDb }`
 * here would drag better-sqlite3 into the browser bundle. Never import
 * `@/lib/db`, `@/lib/auth`, React, or anything else.
 *
 * `src/lib/feedback.ts` — the vocabulary module — now RE-EXPORTS everything
 * below rather than declaring its own copy. Two gates that disagree is a worse
 * bug than two enum lists that disagree, and P1 shipped with the predicates in
 * both places. One direction only: feedback.ts → feedback/access.ts. Do not
 * make access.ts import feedback.ts at runtime or you create a cycle.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
 * The owner created a role named "GRE" in PRODUCTION (base role Staff) on
 * 2026-09-22. Creating it is not the same as it resolving. Measured on the
 * working database the same day:
 *
 *     sqlite> SELECT COUNT(*) FROM users WHERE role_id IS NOT NULL;   → 0
 *     sqlite> SELECT name FROM roles;   → Administrator · Bar Manager · Captain
 *             · Cashier · Floor Manager · Head Chef · Manager · Staff
 *             · Store Manager      (no GRE on this database)
 *
 * `getCurrentUser()` resolves `role_name` by LEFT JOINing `roles` through
 * `users.role_id` (src/lib/auth.ts:89-103). With `role_id` NULL the join
 * produces NULL and `role_name` is null for EVERY user. So a role that exists
 * but has not been ASSIGNED to a login is, to this code, indistinguishable from
 * a role that was never created.
 *
 * That trap is already live elsewhere in this app and has been for two years:
 * `canApproveTableOp` (auth.ts:184) gates on `role_name === 'Cashier'`, and
 * because nobody carries a role_id, no cashier has ever satisfied it.
 *
 * THE RULE THAT FOLLOWS: when the role does not resolve, the answer is NO.
 * Never yes, never "assume they meant GRE". `canAccessPage` fails OPEN four
 * ways (null page_access map, garbled JSON, empty array, prefix grant) plus a
 * fifth in proxy.ts's own `catch { /* fail open *\/ }`. Nothing below inherits
 * any of that: every predicate here starts from false and has to be argued up.
 */

/* ════════════════════════════════════════════════════════════════════════════
   1. THE ONE-LINE SWAP
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔑 THE OWNER'S EXACT SPELLING, IN ONE PLACE. He created it as "GRE".
 *
 * If he renames the role in Settings → Roles, THIS LINE is the entire change —
 * nothing else in the module names the role. Matching is case-insensitive and
 * trimmed (`normalise()` below), so "GRE ", "gre" and "Gre" all land; a rename
 * to something genuinely different ("Guest Relations") does not, and must be
 * mirrored here.
 *
 * ⚠️ It must stay a STRING COMPARISON against `roles.name`, not an id: role ids
 * are per-database (`lower(hex(randomblob(16)))`), so the id of the production
 * GRE row does not exist on any other database and hard-coding one would make
 * the gate dead everywhere else.
 */
export const GRE_ROLE_NAME = 'GRE';

/**
 * `users.section` — a HINT ONLY, and deliberately NOT a grant any more.
 *
 * `VALID_SECTIONS` in `api/auth/users/route.ts` already offers a "GRE" value
 * and /users renders it as "GRE (Front Office)". P1 Lane A let that field grant
 * module access as a second marker. It is demoted here, on purpose, for two
 * measured reasons:
 *
 *   1. `users.section` is NOT a spare field. `kot-section.ts` reads it to
 *      filter the Kitchen Display and to route KOT printing. A field with a
 *      live operational job must not also be an authorisation key.
 *   2. It would have made the Part-2 deny predicate a captain-breaking
 *      footgun. `isReadOnlyFeedbackUser()` is what will refuse POS writes. Had
 *      it kept matching on section, setting a captain's section to 'GRE' — a
 *      routing decision — would silently strip that captain's ability to add an
 *      item or fire a KOT. Keying on the assigned ROLE alone means only a
 *      deliberate role assignment can ever put someone in read-only mode.
 *
 * It survives as the input to a SHARPER DIAGNOSTIC: a user whose section says
 * GRE but whose role does not is almost certainly the owner's half-finished
 * setup, and `feedbackAccess()` says so in as many words.
 */
export const GRE_SECTION = 'GRE';

/* ════════════════════════════════════════════════════════════════════════════
   2. THE ACTOR
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * The shape every predicate here reads. Deliberately STRUCTURAL rather than
 * `SessionUser` from `@/lib/auth` — importing that module pulls `@/lib/db` into
 * the client bundle (see the header).
 *
 * Every field is optional and every field is read defensively, because three
 * different producers build this object and none of them is obliged to agree:
 *   · `getCurrentUser()`      — booleans, `role_name` resolved  (auth.ts)
 *   · `proxy.ts` step 2b      — its own narrower SELECT          (proxy.ts)
 *   · `/api/auth/me` → JSON   — whatever survived serialisation  (Sidebar)
 * A raw better-sqlite3 row would hand us `is_head_chef: 1`, JSON hands us
 * `true`. `flag()` accepts both and refuses everything else.
 */
export interface FeedbackActor {
  /** Effective tier: 'admin' | 'manager' | 'staff'. Resolved from the assigned
   *  role's `base_role` when there is one, else the legacy `users.role`. */
  role?: string | null;
  /** `roles.name` for the ASSIGNED role, resolved through `users.role_id`.
   *  **null whenever no role is assigned** — the live failure mode. */
  role_name?: string | null;
  /** `users.section` — a hint for the diagnostic, never a grant. */
  section?: string | null;
  /** HOD. May arrive as `true` or as SQLite's `1`. */
  is_head_chef?: boolean | null | number;
  /**
   * `roles.is_active` for the ASSIGNED role. TRI-STATE, and the distinction is
   * the whole point:
   *   · `false` / `0`  — the role is deactivated ⇒ the GRE match is REFUSED.
   *   · `true` / `1`   — active ⇒ normal match.
   *   · absent / null  — the caller did not look it up ⇒ not a denial, because
   *                      "unknown" must not masquerade as "known bad".
   *
   * ⚠️ This deliberately does NOT mirror the app-wide rule. `getCurrentUser()`
   * resolves TIER and PAGE MAP from a deactivated role on purpose (auth.ts:
   * 104-107): dropping them would fall back to a null page_access = every page,
   * i.e. deactivating a role would ESCALATE its users. Refusing the GRE match
   * here has the opposite sign — it only ever removes this module's three
   * pages — so fail-closed is safe in this one direction and is what the owner
   * would expect from switching the role off.
   */
  role_is_active?: boolean | number | null;
}

/** Trim + lower-case anything, including null/undefined/numbers, to ''. */
const normalise = (s: unknown): string => String(s ?? '').trim().toLowerCase();

/**
 * A boolean that has survived SQLite, JSON and a form post. Accepts only the
 * four spellings of true that this codebase actually produces; everything else
 * — including the string '0', the string 'false', null and undefined — is
 * false. Fail-closed by construction.
 */
const flag = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || normalise(v) === 'true';

/**
 * Was this tri-state field POSITIVELY supplied as false? `undefined` and `null`
 * are "not looked up" and answer no; only a real false/0/'0'/'false' answers
 * yes. Used for `role_is_active`, where treating "unknown" as "inactive" would
 * lock out every caller that does not join `roles`.
 */
const suppliedFalse = (v: unknown): boolean =>
  v === false || v === 0 || v === '0' || normalise(v) === 'false';

/** Is this argument shaped like an actor at all? A string, an array or null
 *  passed by a careless caller must answer "no access", never throw. */
const isActor = (u: unknown): u is FeedbackActor =>
  !!u && typeof u === 'object' && !Array.isArray(u);

/* ════════════════════════════════════════════════════════════════════════════
   3. THE PREDICATES — each one starts at false
   ════════════════════════════════════════════════════════════════════════════ */

/** Administrator tier. Kept separate from management because the catalog lets
 *  an admin through before any flag is read, and the diagnostic copy differs. */
export function isFeedbackAdmin(u: FeedbackActor | null | undefined): boolean {
  if (!isActor(u)) return false;
  return normalise(u.role) === 'admin';
}

/**
 * Management: Admin, any Manager tier, or an HOD — the SAME predicate
 * `isMgmtOnlyPath` enforces inside `canAccessPage`, restated here so the
 * module's routes agree with its catalog without importing page-catalog.
 *
 * ⚠️ This is why **Floor Manager reaches pages 1-3 but must never be the gate**.
 * Measured: `roles.base_role` for Floor Manager is 'manager'. Gating the module
 * ON Floor Manager would have meant gating on manager TIER, and manager tier is
 * itself the key to void, settle, hold, service-charge waiver and discount
 * approval — five of the six powers the owner forbade a GRE. Floor Manager is
 * included here because a Floor Manager ALREADY has those powers by tier, not
 * because the module grants them.
 */
export function isFeedbackManagement(u: FeedbackActor | null | undefined): boolean {
  if (!isActor(u)) return false;
  const tier = normalise(u.role);
  return tier === 'admin' || tier === 'manager' || flag(u.is_head_chef);
}

/**
 * Does this login carry the ASSIGNED GRE role?
 *
 * The whole fail-closed contract lives in the blank check: `role_name` is null
 * for every user with `role_id IS NULL`, which is all 9 of them on the measured
 * database, so this returns false for everybody until the owner assigns the
 * role he created. It never consults `section`, never falls back to tier, and
 * never treats "no role" as "some role".
 */
export function isNamedGre(u: FeedbackActor | null | undefined): boolean {
  if (!isActor(u)) return false;
  if (suppliedFalse(u.role_is_active)) return false;   // deactivated role → NO
  const name = normalise(u.role_name);
  if (!name) return false;                       // unassigned / unresolved → NO
  return name === normalise(GRE_ROLE_NAME);
}

/** Does this login's `users.section` claim GRE? Hint only — used to tell a
 *  half-finished setup apart from a wrong-person-at-the-screen. */
export function claimsGreSection(u: FeedbackActor | null | undefined): boolean {
  if (!isActor(u)) return false;
  return normalise(u.section) === normalise(GRE_SECTION);
}

/**
 * Pages 1-3 — Floor Feedback, Take Feedback, Feedback Tracker.
 * GRE ∪ Floor Manager ∪ Manager ∪ Admin (HODs too, being management).
 *
 * Note what is NOT here: a Captain, a Cashier or a legacy `Staff` login gets
 * false, and gets it even though their `page_access` map is NULL — the catalog's
 * backward-compat grant opens every unflagged page to all 8 of the 9 measured
 * users, and this module's pages must not be among them.
 */
export function canOpenFeedbackFloor(u: FeedbackActor | null | undefined): boolean {
  if (!isActor(u)) return false;
  return isFeedbackManagement(u) || isNamedGre(u);
}

/**
 * Page 4 — Admin Analytics & Reports. Management only, matching the catalog's
 * `mgmtOnly` flag on /feedback/analytics.
 *
 * Narrow on purpose, and the owner's own fairness ruling makes it narrower, not
 * looser: "A GRE should never avoid recording negative feedback because it
 * affects their performance." Page 4 ranks named staff and exports guest
 * comments in bulk; a league table left open to the floor is exactly the
 * pressure that stops a GRE recording a complaint.
 */
export function canOpenFeedbackAnalytics(u: FeedbackActor | null | undefined): boolean {
  return isFeedbackManagement(u);
}

/**
 * 🔒 THE DENY PREDICATE for the owner's READ-ONLY constraint.
 *
 * True for exactly one population: a login carrying the assigned GRE role that
 * is not also management. Those users may VIEW ordered items and must not be
 * able to place orders · cancel items · change quantity · modify a KOT ·
 * modify a bill · apply discounts.
 *
 * ⚠️ WHERE IT IS CALLED — ONE PLACE, NOT THIRTEEN. P0 measured that
 * `PATCH /api/dine-in/orders/[id]` carries `if (!me) return 401` and nothing
 * else while serving add_item · set_qty · remove_item · fire, and that 11 of 22
 * order/KOT/bill routes are open to a staff-tier session. Closing them one
 * handler at a time would mean fourteen edits to shipped POS code that captains
 * depend on every service — and the measured failure of that approach is that
 * it stops at `PATCH /api/dine-in/orders/[id]` (four of the owner's six powers)
 * while `orders/replay` and `customer-orders/[id]` stay open.
 *
 * So `./pos-readonly.ts` turns the owner's rule into ONE prefix list, and
 * `src/proxy.ts` asks it ONE question inside the query it already runs for
 * every state-changing API call. **No POS route handler was edited.**
 *
 * It is a DENY-LIST keyed on the GRE marker rather than an allow-list for a
 * reason that is the whole safety argument: it is inert until a role is
 * actually assigned, so on the day it ships it refuses NOBODY — it cannot
 * regress a live captain, cashier or KDS.
 */
export function isReadOnlyFeedbackUser(u: FeedbackActor | null | undefined): boolean {
  if (!isActor(u)) return false;
  if (isFeedbackManagement(u)) return false;
  return isNamedGre(u);
}

/** The six powers the owner forbade, verbatim from §3 of the build state — for
 *  a 403 body, so the refusal quotes the rule it is enforcing. */
export const READ_ONLY_REFUSAL =
  'Guest Relations has read-only access to orders. Placing orders, cancelling items, '
  + 'changing quantity, modifying a KOT, modifying a bill and applying discounts are not permitted.';

/* ════════════════════════════════════════════════════════════════════════════
   4. THE DIAGNOSTIC — because a silent redirect teaches nobody anything
   ════════════════════════════════════════════════════════════════════════════
   The live failure mode is not "wrong person"; it is "right person, role never
   assigned". A bare 403 leaves the owner staring at a role he can see in
   Settings → Roles wondering why it does nothing. Every refusal below names the
   role, names the screen, and says that ASSIGNING it is a separate step from
   CREATING it. */

export type FeedbackDenyReason =
  | 'ok'
  | 'signed_out'
  | 'no_role_assigned'
  | 'role_inactive'
  | 'role_not_gre'
  | 'management_only';

export interface FeedbackAccessDecision {
  allowed: boolean;
  /** Which door they came through — for logging and for the analytics split. */
  scope: 'admin' | 'management' | 'gre' | 'none';
  reason: FeedbackDenyReason;
  /** One sentence, safe to show a guest-facing employee. */
  headline: string;
  /** What to actually DO about it. Empty when allowed. */
  remedy: string;
}

const ALLOWED = (scope: FeedbackAccessDecision['scope']): FeedbackAccessDecision => ({
  allowed: true, scope, reason: 'ok', headline: '', remedy: '',
});

/**
 * The single decision function. `analytics: true` asks about Page 4.
 *
 * Callers that only need a boolean should use `canOpenFeedbackFloor()` /
 * `canOpenFeedbackAnalytics()`; this exists so a 403 body, a blocked-page
 * screen and a future audit line all read from one place and cannot drift into
 * three different explanations of the same refusal.
 */
export function feedbackAccess(
  u: FeedbackActor | null | undefined,
  opts?: { analytics?: boolean },
): FeedbackAccessDecision {
  const analytics = !!opts?.analytics;

  if (!isActor(u)) {
    return {
      allowed: false, scope: 'none', reason: 'signed_out',
      headline: 'Please sign in to open Guest Feedback.',
      remedy: 'Your session has expired or you are not signed in. Sign in again and reopen this page.',
    };
  }

  if (isFeedbackAdmin(u)) return ALLOWED('admin');
  if (isFeedbackManagement(u)) return ALLOWED('management');

  if (analytics) {
    return {
      allowed: false, scope: 'none', reason: 'management_only',
      headline: 'Feedback Analytics & Reports is open to management only.',
      remedy:
        'This screen ranks named staff and exports guest comments in bulk, so it is limited to '
        + 'Administrators, Managers (including Floor Manager) and HODs. Floor Feedback, Take '
        + 'Feedback and the Feedback Tracker are the screens for Guest Relations.',
    };
  }

  if (isNamedGre(u)) return ALLOWED('gre');

  // ── The live failure modes. Separated, because the fix differs for each.
  const assigned = normalise(u.role_name);

  if (assigned === normalise(GRE_ROLE_NAME) && suppliedFalse(u.role_is_active)) {
    return {
      allowed: false, scope: 'none', reason: 'role_inactive',
      headline: `The "${GRE_ROLE_NAME}" role is switched off.`,
      remedy:
        `This login is assigned the "${GRE_ROLE_NAME}" role, but that role is marked inactive in `
        + `Settings → Roles. Re-activate it there and this user gets Guest Feedback back — no `
        + `re-assignment needed.`,
    };
  }

  if (!assigned) {
    return {
      allowed: false, scope: 'none', reason: 'no_role_assigned',
      headline: `Guest Feedback is open to the "${GRE_ROLE_NAME}" role and to management.`,
      remedy:
        `This login has NO named role assigned, so the "${GRE_ROLE_NAME}" role cannot be matched `
        + `to it. Creating the role is only half the job: an administrator must open `
        + `Settings → Roles and confirm a role named "${GRE_ROLE_NAME}" exists, then open the `
        + `Users screen and ASSIGN that role to this login. Until a role is assigned, this user `
        + `is treated as legacy staff.`
        + (claimsGreSection(u)
          ? ` (This login's section is already set to "${GRE_SECTION}" — that field routes the `
            + `Kitchen Display and KOT printing and grants nothing here, so the role assignment `
            + `is still required.)`
          : ''),
    };
  }

  return {
    allowed: false, scope: 'none', reason: 'role_not_gre',
    headline: `Guest Feedback is open to the "${GRE_ROLE_NAME}" role and to management.`,
    remedy:
      `This login is assigned the "${u.role_name}" role. To use Guest Feedback it needs the `
      + `"${GRE_ROLE_NAME}" role, or a Manager / Floor Manager / HOD / Administrator login. An `
      + `administrator can change the assignment on the Users screen.`,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   5. PATHS — so the proxy can recognise this module without a bare substring
   ════════════════════════════════════════════════════════════════════════════ */

/** Pages 1-3: the floor surfaces, reachable by a GRE. */
export const FEEDBACK_FLOOR_PATHS = ['/feedback', '/feedback/take', '/feedback/tracker'] as const;

/** Page 4: management only. */
export const FEEDBACK_ANALYTICS_PATH = '/feedback/analytics';

/**
 * Is `pathname` inside this module's PAGE surface?
 *
 * Anchored, never a substring test. `proxy.ts:148` is the cautionary tale in
 * this very file's neighbourhood: `pathname.includes('/print')` made seven API
 * routes public AND CSRF-exempt. A boundary check here means `/feedback-notes`
 * or `/dine-in/feedback` can never be mistaken for one of ours.
 */
export function isFeedbackPath(pathname: string): boolean {
  return pathname === '/feedback' || pathname.startsWith('/feedback/');
}

/** Is `pathname` the analytics page (or a child of it)? */
export function isFeedbackAnalyticsPath(pathname: string): boolean {
  return pathname === FEEDBACK_ANALYTICS_PATH
    || pathname.startsWith(FEEDBACK_ANALYTICS_PATH + '/');
}
