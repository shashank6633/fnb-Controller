/**
 * Guest Feedback & Service Recovery — the module's vocabulary, in one place.
 *
 * Every list here is lifted VERBATIM from §3 of FEEDBACK-BUILD-STATE.md (the
 * owner's spec). Store the `v` (wire value); render the `label`. A page that
 * hand-types "Too Spicy" instead of importing it is how two lists that mean one
 * thing start to drift — the repo already has that bug once (`VALID_SECTIONS`
 * is declared in api/auth/users/route.ts and hand-copied into users/page.tsx).
 *
 * ⚠️ TEMPORARY HOME — READ BEFORE ADDING A SECOND COPY.
 * P0 Lane B's recommendation is that this file ends up at
 * `src/lib/feedback/enums.ts` with ZERO imports, so the client pages (this
 * module) and the server routes / report builders (P2+) share ONE source. It
 * lives here only because P1 Lane B owns `src/app/feedback/**` and nothing
 * else. When `src/lib/feedback/enums.ts` lands:
 *     1. move these declarations there UNCHANGED,
 *     2. replace this file's body with `export * from '@/lib/feedback/enums';`
 *        or delete it and repoint the four pages' imports,
 *     3. do NOT leave two lists alive.
 * Keep it dependency-free (no `@/lib/db`, no React) for exactly the reason
 * page-catalog.ts:701 documents: a shared module that imports db.ts drags
 * better-sqlite3 into the browser bundle.
 */

export type Choice<T extends string> = { v: T; label: string };

/* ── Page 1 · table status ───────────────────────────────────────────────── */

export const TABLE_STATUSES = [
  { v: 'not_ready', label: 'Not Ready' },
  { v: 'due', label: 'Feedback Due' },
  { v: 'taken', label: 'Feedback Taken' },
  { v: 'issue', label: 'Issue Raised' },
  { v: 'follow_up', label: 'Follow-Up Required' },
] as const satisfies readonly Choice<string>[];

export type TableStatus = (typeof TABLE_STATUSES)[number]['v'];

/**
 * Status → Tailwind classes. Kept beside the enum so a status added later
 * cannot render as an unstyled grey pill on one page and a coloured one on
 * another. `not_ready` is deliberately the quietest: it is the only status
 * that is not a call to action.
 */
export const STATUS_STYLE: Record<TableStatus, string> = {
  not_ready: 'bg-[#F0E4D6] text-[#8B7355] border-[#E8D5C4]',
  due: 'bg-amber-100 text-amber-800 border-amber-300',
  taken: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  issue: 'bg-red-100 text-red-700 border-red-300',
  follow_up: 'bg-violet-100 text-violet-800 border-violet-300',
};

export const statusLabel = (v: string): string =>
  TABLE_STATUSES.find((s) => s.v === v)?.label ?? v;

/* ── Page 2 · the feedback itself ────────────────────────────────────────── */

export const OVERALL_RATINGS = [
  { v: 'excellent', label: 'Excellent' },
  { v: 'good', label: 'Good' },
  { v: 'average', label: 'Average' },
  { v: 'poor', label: 'Poor' },
] as const satisfies readonly Choice<string>[];

export type OverallRating = (typeof OVERALL_RATINGS)[number]['v'];

export const CATEGORIES = [
  { v: 'food', label: 'Food' },
  { v: 'drinks', label: 'Drinks' },
  { v: 'service', label: 'Service' },
  { v: 'ambience', label: 'Ambience' },
] as const satisfies readonly Choice<string>[];

export type Category = (typeof CATEGORIES)[number]['v'];

export const ITEM_RATINGS = [
  { v: 'good', label: 'Good' },
  { v: 'average', label: 'Average' },
  { v: 'poor', label: 'Poor' },
] as const satisfies readonly Choice<string>[];

export type ItemRating = (typeof ITEM_RATINGS)[number]['v'];

export const ITEM_ISSUES = [
  { v: 'taste', label: 'Taste' },
  { v: 'too_spicy', label: 'Too Spicy' },
  { v: 'too_salty', label: 'Too Salty' },
  { v: 'cold', label: 'Cold' },
  { v: 'dry', label: 'Dry' },
  { v: 'overcooked', label: 'Overcooked' },
  { v: 'undercooked', label: 'Undercooked' },
  { v: 'presentation', label: 'Presentation' },
  { v: 'quantity', label: 'Quantity' },
  { v: 'delay', label: 'Delay' },
  { v: 'other', label: 'Other' },
] as const satisfies readonly Choice<string>[];

export type ItemIssue = (typeof ITEM_ISSUES)[number]['v'];

export const ACTIONS_TAKEN = [
  { v: 'none', label: 'No Action Required' },
  { v: 'returned', label: 'Item Returned' },
  { v: 'remade', label: 'Same Item Remade' },
  { v: 'replaced_same', label: 'Fresh Item Replaced' },
  { v: 'replaced_other', label: 'Different Item Replaced' },
  { v: 'cancelled', label: 'Item Cancelled' },
] as const satisfies readonly Choice<string>[];

export type ActionTaken = (typeof ACTIONS_TAKEN)[number]['v'];

/* ── Page 2 · the revisit, after a remake/replacement ────────────────────── */

export const REVISIT_RATINGS = [
  { v: 'excellent', label: 'Excellent' },
  { v: 'good', label: 'Good' },
  { v: 'average', label: 'Average' },
  { v: 'still_poor', label: 'Still Poor' },
] as const satisfies readonly Choice<string>[];

export const HAPPINESS = [
  { v: 'happy', label: 'Yes - Happy' },
  { v: 'partial', label: 'Partially Happy' },
  { v: 'unhappy', label: 'No - Still Unhappy' },
] as const satisfies readonly Choice<string>[];

export type Happiness = (typeof HAPPINESS)[number]['v'];

/* ── The lifecycle rules, kept WITH the enum ─────────────────────────────── */
/* The owner's ruling: "Remade/Replaced ⇒ automatically create Follow-Up
 * Required, and the complaint stays OPEN until the GRE revisits." Encoding it
 * here means Page 1's status, Page 2's submit and Page 3's counts cannot each
 * decide it differently. */

/** A rating that counts as negative for "Negative Feedback %" (Page 4). */
export const isNegative = (r: string): boolean => r === 'poor' || r === 'average';

/** Actions that force a Follow-Up Required and hold the complaint open. */
export const requiresFollowUp = (a: string): boolean =>
  a === 'remade' || a === 'replaced_same' || a === 'replaced_other';

/** Only an outright "Yes - Happy" closes the issue. Partial stays open. */
export const closesIssue = (h: string): boolean => h === 'happy';

/* ── Page 3 · tracker filters ────────────────────────────────────────────── */

export const TRACKER_FILTERS = [
  { v: 'all', label: 'All' },
  { v: 'pending', label: 'Pending Feedback' },
  { v: 'completed', label: 'Completed' },
  { v: 'negative', label: 'Negative Feedback' },
  { v: 'follow_up', label: 'Follow-Up Required' },
  { v: 'resolved', label: 'Resolved' },
] as const satisfies readonly Choice<string>[];

/* ── Page 4 · date ranges and the eight downloads ────────────────────────── */

export const DATE_RANGES = [
  { v: 'today', label: 'Today' },
  { v: 'yesterday', label: 'Yesterday' },
  { v: 'week', label: 'This Week' },
  { v: 'month', label: 'This Month' },
  { v: 'custom', label: 'Custom' },
] as const satisfies readonly Choice<string>[];

/**
 * The eight downloads from §3. `v` is the report key the P5 endpoint will take
 * as a query parameter — NEVER as a path segment containing the word "print"
 * and never ending `.json`, both of which `proxy.ts` treats as public and
 * CSRF-exempt (hard rule 9).
 */
export const REPORTS = [
  { v: 'daily', label: 'Daily' },
  { v: 'weekly', label: 'Weekly' },
  { v: 'monthly', label: 'Monthly' },
  { v: 'menu-item', label: 'Menu Item' },
  { v: 'returned-remade', label: 'Returned / Remade' },
  { v: 'negative', label: 'Negative Feedback' },
  { v: 'gre-performance', label: 'GRE / Manager Performance' },
  { v: 'guest-recovery', label: 'Guest Recovery' },
] as const satisfies readonly Choice<string>[];

/* ── Food vs Drinks ──────────────────────────────────────────────────────── */
/**
 * P0 Lane B measured the authority: the split is `stationKdsSection()` /
 * `BAR_STATIONS` in `src/lib/kot-section.ts`, NOT `station_departments` (whose
 * Bar department has no row for beer/wine/beverage/beverages, so those four
 * would silently file as Food) and NOT `menu_items.item_type` (which is not on
 * `order_items` at all and needs a nullable join).
 *
 * The shells below only need the two bucket labels; P3 imports the real
 * classifier server-side. Do not re-implement a station list here.
 */
export const ITEM_GROUPS = [
  { v: 'food', label: 'Food' },
  { v: 'drinks', label: 'Drinks' },
] as const satisfies readonly Choice<string>[];

export type ItemGroup = (typeof ITEM_GROUPS)[number]['v'];
