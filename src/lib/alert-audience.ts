import type { SessionUser } from './auth';

/**
 * WHO HEARS A LIVE TABLE ALERT — the audience behind the floating bell.
 *
 * THE PROBLEM. CaptainAlertsProvider polls three dine-in feeds every 8s and
 * toasts + chimes on anything new. Its whole targeting model was one line —
 * `!owner || owner === meId` — so an alert on a table nobody has claimed reached
 * EVERY signed-in user: a store manager posting a GRN heard a table asking for
 * water. Worse, the three feeds each returned the whole outlet's rows to any
 * signed-in caller, so a client-side filter was cosmetic — the data was on the
 * wire either way. This module is the server-side answer, and the client renders
 * the audience it is told about rather than guessing.
 *
 * NO MIGRATION, BY DESIGN. Every audience below is computed from columns that
 * already exist on the session user: the privilege tier (users.role / the
 * assigned role's base_role, already resolved by auth.ts), the resolved page map
 * (users.page_access, else the role's), the HOD flag and users.section. Captain
 * and Cashier are BOTH base_role 'staff' — the tier cannot tell them apart — so
 * the page map is what says which job a person actually does.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AUDIENCES ARE NESTED, NEVER EXCLUSIVE. `all` implies the other three, and
 * a person can hold several: the Cashier role's map carries /captain too, so a
 * cashier gets their own tables AND every table asking for the bill. Nothing in
 * here can subtract from what a supervisor sees; it only decides who ELSE hears
 * a given row.
 *
 *   all      — the firehose: every row in the outlet. Admins always; management
 *              with no explicit page map (we cannot tell a floor manager from a
 *              store manager without one, and blinding a supervisor is the worse
 *              mistake); management whose map carries a floor-wide page; and
 *              ANYONE granted /dine-in/requests, because granting the
 *              all-requests board IS an admin saying "show this person
 *              everything".
 *   captain  — their own tables, PLUS every unclaimed table. See the fallback
 *              note below; this is the one that must never go empty-handed.
 *   cashier  — tables asking for the bill, from any captain's section. Granted
 *              by the /cashier page, the same grant src/lib/settle-authority.ts
 *              uses as its till-capability test.
 *   kitchen  — every KOT trouble alert, not just their own tables'. Granted by
 *              users.section 'Kitchen' or the /dine-in/kitchen page.
 *
 * THE UNCLAIMED FALLBACK IS THE SAFETY NET AND IT IS LOAD-BEARING. A QR order or
 * a service request on a table with no OPEN order has owner NULL, and today that
 * broadcasts to everyone — which is why an unclaimed table's order is never
 * missed. Narrow that to "the owning captain" and, with nobody owning the table,
 * a live order reaches NOBODY. So an owner-NULL row goes to every captain AND
 * (through `all`) to management. seesTableRow() is the only place that rule
 * lives, so no feed can implement it differently.
 *
 * WHY A GARBLED OR EMPTY MAP READS AS "NO EXPLICIT MAP". explicitPages() returns
 * null for null / '' / non-JSON / a non-array / an empty array — the same
 * forgiving reading canAccessPage() gives those values — and a null map lands a
 * staff user in the captain audience, i.e. exactly today's behaviour. This
 * direction is deliberate: the cost of failing open here is that someone hears
 * an alert meant for a colleague, and the cost of failing closed is a guest
 * sitting unanswered. (settle-authority.ts takes the OPPOSITE reading for the
 * till, where the cost of failing open is money.)
 *
 * Pure and dependency-free — `import type` only, no better-sqlite3, no db.ts —
 * so a route can use it without pulling the database into a client bundle.
 */

/** The cashier console. Mirrors CASHIER_PAGE in src/lib/settle-authority.ts. */
const CASHIER_PAGE = '/cashier';
/** The Kitchen Display. */
const KITCHEN_PAGE = '/dine-in/kitchen';
/** The all-requests board. Holding it is an explicit grant of the firehose. */
const REQUESTS_BOARD = '/dine-in/requests';
/** Pages that mean "this person works tables". */
const CAPTAIN_PAGES = ['/captain', '/dine-in/order', '/dine-in/tables', '/dine-in/floor'];
/**
 * Pages that mean "this person runs the whole floor". Only widens MANAGEMENT to
 * the firehose — a staff captain granted /dine-in/tables is still a captain.
 */
const FLOOR_WIDE_PAGES = ['/dine-in', '/dine-in/floor', '/dine-in/tables', REQUESTS_BOARD];

/** How an audience was decided. On the wire for debugging; never used as a gate. */
export type AudienceBasis =
  | 'signed_out'          // no session
  | 'admin'               // admin tier — always the firehose
  | 'requests_board'      // explicitly granted /dine-in/requests
  | 'floor_management'    // management tier whose map carries a floor-wide page
  | 'legacy_management'   // management tier with no explicit page map
  | 'legacy_staff'        // staff with no explicit page map → captain (today's behaviour)
  | 'role_pages'          // duties read off an explicit page map
  | 'off_floor';          // an explicit map with no floor page — no live alerts

export interface AlertAudience {
  /** users.id — whose "my tables" this is. '' when signed out. */
  userId: string;
  /** Every row in the outlet. Implies captain + cashier + kitchen. */
  all: boolean;
  /** Own tables + every unclaimed table. */
  captain: boolean;
  /** Tables asking for the bill, whoever owns them. */
  cashier: boolean;
  /** Every KOT trouble alert. */
  kitchen: boolean;
  /** Any duty at all. false → this person gets NO live table alerts. */
  live: boolean;
  basis: AudienceBasis;
}

const NO_AUDIENCE: AlertAudience = {
  userId: '', all: false, captain: false, cashier: false, kitchen: false,
  live: false, basis: 'signed_out',
};

/**
 * The user's EXPLICIT page grants, or null when they have none.
 *
 * null covers every value canAccessPage() treats as full access: missing, blank,
 * unparseable, not an array, or empty. Non-path entries are dropped, and a list
 * left with nothing usable is null too — a map of junk is not a statement about
 * anyone's job.
 */
function explicitPages(raw: string | null | undefined): string[] | null {
  if (raw == null || String(raw).trim() === '') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(String(raw)); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const list = parsed.filter((p): p is string => typeof p === 'string' && p.startsWith('/'));
  return list.length ? list : null;
}

/** The fields this needs. Structural, so SessionUser satisfies it directly. */
export type AudienceActor = Pick<SessionUser, 'id' | 'role' | 'is_head_chef' | 'page_access' | 'section'>;

/**
 * Resolve one person's audiences. Total: every signed-in user gets an answer,
 * and `live: false` (nobody with an explicit off-floor map, e.g. the Store
 * Manager role) is a real answer, not a failure — their Action Inbox buckets are
 * untouched, they simply stop being toasted about other people's tables.
 */
export function resolveAlertAudience(me: AudienceActor | null | undefined): AlertAudience {
  if (!me || !me.id) return NO_AUDIENCE;

  const pages = explicitPages(me.page_access);
  // Grant g covers page p when p is g or sits under it — the same exact-or-
  // '/'-boundary prefix rule as the last line of canAccessPage().
  const has = (p: string) => pages !== null && pages.some((g) => p === g || p.startsWith(g + '/'));
  // Management for NOTIFICATION purposes includes a staff-tier HOD: this decides
  // who KEEPS seeing things, so the generous reading is the safe one. (The till
  // uses the stricter isManagementTier() — there, generosity costs money.)
  const management = me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef;
  const kitchenSection = (me.section || '').trim().toLowerCase() === 'kitchen';

  let all = false;
  let basis: AudienceBasis;
  if (me.role === 'admin') {
    all = true; basis = 'admin';
  } else if (has(REQUESTS_BOARD)) {
    all = true; basis = 'requests_board';
  } else if (pages === null) {
    all = management;
    basis = management ? 'legacy_management' : 'legacy_staff';
  } else if (management && FLOOR_WIDE_PAGES.some((p) => has(p))) {
    all = true; basis = 'floor_management';
  } else {
    basis = 'role_pages';
  }

  // A null map means the person can open every page, so it grants the captain
  // duty (a legacy staffer's bell keeps working exactly as it does today) and —
  // see the KDS note in the kot-alerts route — the kitchen duty, because the
  // Kitchen Display is a STATION screen with no per-user notion of "my alert":
  // narrowing it would leave the kitchen blind to print failures.
  const captain = all || pages === null || CAPTAIN_PAGES.some((p) => has(p));
  const cashier = all || has(CASHIER_PAGE);
  const kitchen = all || kitchenSection || pages === null || has(KITCHEN_PAGE);
  const live = all || captain || cashier || kitchen;

  return {
    userId: String(me.id),
    all, captain, cashier, kitchen, live,
    basis: live ? basis : 'off_floor',
  };
}

/**
 * May this person see a row hanging off a table? `ownerId` is the captain who
 * holds the table's OPEN order (orders.server_id), or null/'' when nobody does.
 * The owner-NULL broadcast to captains is the safety net described up top.
 */
export function seesTableRow(aud: AlertAudience, ownerId: unknown): boolean {
  if (aud.all) return true;
  if (!aud.captain) return false;
  const owner = String(ownerId ?? '').trim();
  return owner === '' || owner === aud.userId;
}

/**
 * Service requests: a BILL request is the cashier's job wherever it comes from
 * (it is the same event the /cashier board and the bell's bill-request bucket
 * act on), so it reaches every till as well as the table's captain. Every other
 * type — water, cutlery, call waiter — is table work.
 */
export function seesServiceRequest(
  aud: AlertAudience,
  row: { type?: unknown; table_owner_id?: unknown },
): boolean {
  if (aud.cashier && String(row.type ?? '').trim().toLowerCase() === 'bill') return true;
  return seesTableRow(aud, row.table_owner_id);
}

/**
 * KOT trouble alerts: the kitchen sees all of them (that is what the KDS banner
 * is), and the captain named on the alert — kot_alerts.server_id — sees theirs.
 */
export function seesKotAlert(aud: AlertAudience, row: { server_id?: unknown }): boolean {
  if (aud.kitchen) return true;
  return seesTableRow(aud, row.server_id);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE EXPLICIT ALL-MODE
 *
 * Scoping a shared feed without one blanks the screens that legitimately want
 * everything. `?scope=all` is that opt-out, and it is a REQUEST, not a grant:
 * effectiveScope() downgrades it to 'audience' for anyone whose audience is not
 * already the firehose, so the parameter can never widen what a caller may see.
 * It is answered with the caller's own rows rather than a 403 — an error would
 * blank the very board this exists to protect.
 * ───────────────────────────────────────────────────────────────────────────*/

export type FeedScope = 'all' | 'audience';

/** Read ?scope= off a request URL. Anything but 'all' means the audience scope. */
export function requestedScope(url: string): FeedScope {
  try {
    return new URL(url).searchParams.get('scope') === 'all' ? 'all' : 'audience';
  } catch {
    return 'audience';
  }
}

/** What the caller actually gets: 'all' only when they were entitled to it. */
export function effectiveScope(requested: FeedScope, aud: AlertAudience): FeedScope {
  return requested === 'all' && aud.all ? 'all' : 'audience';
}
