/**
 * Guest Feedback & Service Recovery — THE shared module.
 *
 * ⚠️ NO RUNTIME DEPENDENCIES, AND THAT IS THE POINT. Page 2 (Take Feedback) and
 * Page 4 (Analytics) are client components; the API routes and the report
 * builders are server-side. The only module that can be the single source for
 * both is one with no dependencies. `page-catalog.ts:701` documents what
 * happens otherwise: a shared module that reaches for `@/lib/db` drags
 * better-sqlite3 into the browser bundle. Never import `@/lib/db`, React, or
 * anything else here.
 *
 * The ONE exception is §3 below, which re-exports the access gate from
 * `./feedback/access` — a sibling that is itself import-free, so the rule is
 * kept in substance. Nothing else may be added to that list.
 *
 * Every vocabulary below is lifted VERBATIM from §3 of FEEDBACK-BUILD-STATE.md
 * (the owner's own words). Store the `v` (wire value); render the `label`.
 *
 * ── THE DUPLICATE-VOCABULARY NOTE IS CLOSED (checked 2026-09-22) ────────────
 * P1 Lane A's header warned that `src/app/feedback/enums.ts` held a second copy
 * of these lists and that P2 had to repoint it. That file does not exist:
 *     $ ls src/app/feedback
 *     analytics/  page.tsx  placeholder.ts  take/  tracker/  ui.tsx
 * Lane B shipped `placeholder.ts` (shell FIXTURES, typed FROM here) and
 * `ui.tsx` (presentational primitives) instead, and all five page files import
 * their vocabulary from '@/lib/feedback'. There is exactly one list. Nothing to
 * close — do not go looking for the file.
 */

/* ════════════════════════════════════════════════════════════════════════════
   1. VOCABULARIES
   ════════════════════════════════════════════════════════════════════════════ */

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
 * another. `not_ready` is deliberately the quietest: it is the only status that
 * is not a call to action.
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

/** The four `gf_visits` columns the four categories write to, in catalog order. */
export const CATEGORY_COLUMN: Record<Category, 'cat_food' | 'cat_drinks' | 'cat_service' | 'cat_ambience'> = {
  food: 'cat_food',
  drinks: 'cat_drinks',
  service: 'cat_service',
  ambience: 'cat_ambience',
};

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

export type RevisitRating = (typeof REVISIT_RATINGS)[number]['v'];

export const HAPPINESS = [
  { v: 'happy', label: 'Yes - Happy' },
  { v: 'partial', label: 'Partially Happy' },
  { v: 'unhappy', label: 'No - Still Unhappy' },
] as const satisfies readonly Choice<string>[];

export type Happiness = (typeof HAPPINESS)[number]['v'];

/* ── Page 3 · tracker filters ────────────────────────────────────────────── */

export const TRACKER_FILTERS = [
  { v: 'all', label: 'All' },
  { v: 'pending', label: 'Pending Feedback' },
  { v: 'completed', label: 'Completed' },
  { v: 'negative', label: 'Negative Feedback' },
  { v: 'follow_up', label: 'Follow-Up Required' },
  { v: 'resolved', label: 'Resolved' },
] as const satisfies readonly Choice<string>[];

export type TrackerFilter = (typeof TRACKER_FILTERS)[number]['v'];

/* ── Page 4 · date ranges and the eight downloads ────────────────────────── */

export const DATE_RANGES = [
  { v: 'today', label: 'Today' },
  { v: 'yesterday', label: 'Yesterday' },
  { v: 'week', label: 'This Week' },
  { v: 'month', label: 'This Month' },
  { v: 'custom', label: 'Custom' },
] as const satisfies readonly Choice<string>[];

export type DateRange = (typeof DATE_RANGES)[number]['v'];

/**
 * The eight downloads from §3. `v` is the report key the P5 endpoint takes as a
 * QUERY PARAMETER — never as a path segment containing the word "print" and
 * never ending `.json`, both of which `proxy.ts` treats as public AND
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

export type ReportKey = (typeof REPORTS)[number]['v'];

/* ── Food vs Drinks ──────────────────────────────────────────────────────── */
/**
 * P0 Lane B measured the authority: the split is `stationKdsSection()` /
 * `BAR_STATIONS` in `src/lib/kot-section.ts`, NOT `station_departments` (whose
 * Bar department has no row for beer/wine/beverage/beverages, so those four
 * would silently file as Food) and NOT `menu_items.item_type` (which is not on
 * `order_items` at all and needs a nullable join).
 *
 * These are the two bucket LABELS only. Do NOT re-implement a station list
 * here: the server resolves the bucket with `stationKdsSection()` at WRITE time
 * and stores the answer in `gf_item_feedback.item_group`, so a station renamed
 * next year cannot retro-reclassify last month's complaints.
 *
 * `stationKdsSection()` is TOTAL — a blank, NULL, typo'd or off-master station
 * returns 'kitchen', i.e. Food, with no error. `gf_item_feedback.station` keeps
 * the raw value precisely so Page 4 can count how often that happened rather
 * than letting a mis-filed drink disappear into Food.
 */
export const ITEM_GROUPS = [
  { v: 'food', label: 'Food' },
  { v: 'drinks', label: 'Drinks' },
] as const satisfies readonly Choice<string>[];

export type ItemGroup = (typeof ITEM_GROUPS)[number]['v'];

/* ════════════════════════════════════════════════════════════════════════════
   2. THE LIFECYCLE RULES — encoded ONCE, beside the vocabulary they govern
   ════════════════════════════════════════════════════════════════════════════
   The owner's ruling: "Remade/Replaced ⇒ automatically create Follow-Up
   Required, and the complaint stays OPEN until the GRE revisits." Encoding it
   here means Page 1's status, Page 2's submit, Page 3's counts and Page 4's
   Service Recovery Analysis cannot each decide it differently. */

/** A rating that counts as negative for "Negative Feedback %" (Page 4). */
export const isNegative = (r: string): boolean => r === 'poor' || r === 'average';

/** Actions that force a Follow-Up Required and hold the complaint open. */
export const requiresFollowUp = (a: string): boolean =>
  a === 'remade' || a === 'replaced_same' || a === 'replaced_other';

/**
 * Actions that removed the dish from the guest without replacing it. Distinct
 * from `requiresFollowUp`: there is nothing to revisit, but Page 4's
 * Return/Remake Rate must still count them.
 */
export const isServiceRecovery = (a: string): boolean =>
  a !== 'none' && ACTIONS_TAKEN.some((x) => x.v === a);

/**
 * Only an outright "Yes - Happy" closes the issue. The owner: "Happy ⇒ close.
 * Still Unhappy ⇒ stays open for Manager attention." Partially Happy is NOT a
 * close — it is deliberately grouped with unhappy here, because a guest who is
 * only partly satisfied is still a guest the manager should see.
 */
export const closesIssue = (h: string): boolean => h === 'happy';

/**
 * A revisit happened but did not close the issue ⇒ it escalates to the manager.
 * Called only after a revisit is recorded; an untouched follow-up is merely
 * open, not escalated.
 */
export const escalatesToManager = (h: string): boolean =>
  !!h && !closesIssue(h);

/**
 * The single status rule for a table on Page 1, derived from the row counts so
 * Pages 1, 3 and 4 answer identically. Order matters: an open follow-up
 * outranks a raised issue, which outranks a plain "taken".
 *
 * `eligible` is the owner's three-part trigger (item threshold OR bill
 * requested OR bill printed) evaluated by the caller — this function does not
 * re-derive it, it only names the resulting state.
 */
export function tableStatus(x: {
  hasVisit: boolean;
  eligible: boolean;
  openFollowUps: number;
  hasNegative: boolean;
}): TableStatus {
  if (x.openFollowUps > 0) return 'follow_up';
  if (!x.hasVisit) return x.eligible ? 'due' : 'not_ready';
  if (x.hasNegative) return 'issue';
  return 'taken';
}

/**
 * Page 3's "Resolved" filter. A visit is resolved when it RAISED follow-ups and
 * every one of them is now closed. A visit that never raised one was never
 * unresolved, so it is "completed", not "resolved" — keeping those apart is
 * what stops Service Recovery Analysis counting clean tables as recoveries.
 */
export const isResolved = (x: { followUpsTotal: number; openFollowUps: number }): boolean =>
  x.followUpsTotal > 0 && x.openFollowUps === 0;

/* ════════════════════════════════════════════════════════════════════════════
   3. THE GATE — MOVED. It now lives in ./feedback/access.ts
   ════════════════════════════════════════════════════════════════════════════

   §7 Q1 IS ANSWERED. The owner created a role named "GRE" (base role Staff) in
   PRODUCTION on 2026-09-22 — the same precedent he chose for Bill Handover's
   "Accounts". Option (b), gating on Floor Manager, stays struck: Floor Manager
   is `base_role` 'manager', and manager tier is itself the key to void, settle,
   hold, service-charge waiver and discount approval, so gating on it would have
   handed the GRE five of the six powers he forbade.

   WHY THE PREDICATES ARE NO LONGER DECLARED HERE. P1 left the gate in this
   file, which is imported by five CLIENT components. The gate is also needed by
   `page-catalog.ts`, by `proxy.ts` and by every future `/api/feedback/*` route,
   and the moment two of those grow their own copy the module has two answers to
   one question. Two gates that disagree is a worse bug than two enum lists that
   disagree. One authority now:

       src/lib/feedback/access.ts     ← declares it
       src/lib/feedback.ts (here)     ← re-exports it, for import convenience

   The dependency runs ONE WAY. access.ts imports nothing at all, so this
   re-export cannot drag anything into the browser bundle and cannot cycle.

   Renaming the role is still a ONE-LINE SWAP — `GRE_ROLE_NAME` in access.ts.

   ⚠️ ONE BEHAVIOUR CHANGE, DELIBERATE: `users.section === 'GRE'` NO LONGER
   GRANTS ACCESS. It is a hint used to sharpen the refusal message, nothing
   more. `kot-section.ts` reads that field to filter the Kitchen Display and
   route KOT printing, and had it stayed an authorisation key the Part-2 deny
   predicate would have turned a captain's section setting into a silent
   revocation of that captain's ability to fire a KOT. See access.ts §1. */

export {
  GRE_ROLE_NAME,
  GRE_SECTION,
  READ_ONLY_REFUSAL,
  FEEDBACK_FLOOR_PATHS,
  FEEDBACK_ANALYTICS_PATH,
  isFeedbackAdmin,
  isFeedbackManagement,
  isNamedGre,
  claimsGreSection,
  canOpenFeedbackFloor,
  canOpenFeedbackAnalytics,
  isReadOnlyFeedbackUser,
  feedbackAccess,
  isFeedbackPath,
  isFeedbackAnalyticsPath,
} from './feedback/access';

export type {
  FeedbackActor,
  FeedbackDenyReason,
  FeedbackAccessDecision,
} from './feedback/access';

/* ════════════════════════════════════════════════════════════════════════════
   4. TUNABLES — settings keys, with CODE defaults
   ════════════════════════════════════════════════════════════════════════════
   Both read from the existing `settings` table (key/value). They are CODE-
   defaulted on purpose: `captain_area_lock` is the cautionary tale — a gate
   written as `if (lock?.value !== '1')` against a key nothing ever seeded, so
   the restriction was dead from the day it shipped and a 403 below it was
   unreachable for two years. An ABSENT key here means the documented default,
   never "off". */

/** §7 Q2 — the owner wrote "4-5 items". Admin-tunable, default 4. */
export const FEEDBACK_ITEM_THRESHOLD_KEY = 'feedback_item_threshold';
export const FEEDBACK_ITEM_THRESHOLD_DEFAULT = 4;

/**
 * §7 Q4 — a table settled before the GRE arrives is the commonest way coverage
 * is lost. Minutes after `orders.settled_at` during which feedback is still
 * accepted. 0 disables the grace entirely.
 */
export const FEEDBACK_SETTLED_GRACE_KEY = 'feedback_settled_grace_minutes';
export const FEEDBACK_SETTLED_GRACE_DEFAULT = 30;

/**
 * Parse a settings value to a non-negative integer, falling back to the coded
 * default for absent / blank / non-numeric / negative values alike.
 *
 * ⚠️ FIXED IN P2 (measured, not theorised). The first version was
 *
 *     const n = Number(String(raw ?? '').trim());
 *     return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
 *
 * and `Number('')` is `0` — finite and >= 0 — so an ABSENT key returned **0**,
 * never the fallback. That is precisely the `captain_area_lock` failure this
 * section's own comment was written to prevent, and it was live: with no
 * `feedback_item_threshold` row (there is none on the measured database), the
 * threshold resolved to 0, so `item_count >= 0` made EVERY table instantly
 * "Feedback Due" — including tables with zero items — and `Not Ready` became
 * unreachable. The grace window collapsed the same way: `feedback_settled_grace
 * _minutes` resolved to 0, which the board reads as "grace disabled", so a
 * table settled one minute ago vanished off the GRE's board.
 *
 * Measured on the running server (GET /api/feedback/floor) BEFORE the fix:
 *     meta.item_threshold = 0 · meta.grace_minutes = 0
 *     counts = { all: 11, due: 8, issue: 1, taken: 1, follow_up: 1, not_ready: 0 }
 *                                                     ↑ 0-item tables called "due"
 * and AFTER, on the same fixtures:
 *     meta.item_threshold = 4 · meta.grace_minutes = 30
 *     counts = { all: 12, due: 5, issue: 1, taken: 1, follow_up: 1, not_ready: 4 }
 * `all` RISES from 11 to 12 because the grace window came back: a table settled
 * five minutes ago is visitable again instead of having silently disappeared.
 *
 * The blank check must come FIRST and must be its own statement: "no value" and
 * "the value zero" are different answers, and only the second may mean zero.
 */
export function tunable(raw: unknown, fallback: number): number {
  const s = String(raw ?? '').trim();
  if (s === '') return fallback;          // absent / null / blank ⇒ the default
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/* ════════════════════════════════════════════════════════════════════════════
   5. ROW TYPES — the `gf_` tables, mirrored (src/lib/db.ts, end of
      initializeSchema). Keep in step with the DDL; there is no migration
      framework and `initializeSchema` SWALLOWS schema errors silently.
   ════════════════════════════════════════════════════════════════════════════ */

/** `gf_visits` — ONE row per order that a GRE has given feedback on. A revisit
 *  does NOT create a second row; it writes to `gf_follow_ups`. */
export interface GfVisit {
  id: string;
  outlet_id: string;
  order_id: string;
  table_id: string;
  table_number: string;
  floor: string;              // snapshot of restaurant_tables.zone (there is no `floor` column)
  covers: number;             // Pax at visit time
  captain_name: string;       // orders.server_name at visit time
  items_ordered: number;      // COUNT(order_items) at visit time
  gre_user_id: string;
  gre_email: string;
  gre_name: string;
  gre_role: string;
  everything_good: number;    // 0/1 — the 10-second happy path
  overall_rating: OverallRating | '';
  cat_food: OverallRating | '';
  cat_drinks: OverallRating | '';
  cat_service: OverallRating | '';
  cat_ambience: OverallRating | '';
  comment: string;
  status: Extract<TableStatus, 'taken' | 'issue' | 'follow_up'>;
  has_negative: number;
  follow_ups_total: number;
  open_follow_ups: number;
  created_at: string;
  updated_at: string;
}

/** `gf_item_feedback` — per ORDERED ITEM. */
export interface GfItemFeedback {
  id: string;
  visit_id: string;
  order_id: string;
  order_item_id: string;
  menu_item_id: string;
  item_name: string;
  station: string;            // raw, as ordered — the Food/Drinks classifier input
  item_group: ItemGroup;      // resolved by stationKdsSection() at WRITE time
  quantity: number;
  rating: ItemRating | '';
  issue: ItemIssue | '';
  comment: string;
  action_taken: ActionTaken;
  replacement_menu_item_id: string;  // §7 Q3 — which item was given instead
  replacement_item_name: string;
  is_negative: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** `gf_follow_ups` — the open complaint. Created by a Remade/Replaced action,
 *  closed only by a revisit that records "Yes - Happy". */
export interface GfFollowUp {
  id: string;
  visit_id: string;
  item_feedback_id: string;
  order_id: string;
  table_id: string;
  item_name: string;
  action_taken: ActionTaken;
  status: 'open' | 'closed';
  revisit_rating: RevisitRating | '';
  happiness: Happiness | '';
  revisit_comment: string;
  revisited_at: string;
  revisited_by: string;
  closed_at: string;
  closed_by: string;
  escalated_at: string;       // a revisit happened and did NOT close it
  created_at: string;
  updated_at: string;
}

/** The `gf_` surface, named once so the boot assertion and any carve check can
 *  both read it from here instead of hand-listing three strings twice. */
export const GF_TABLES = ['gf_visits', 'gf_item_feedback', 'gf_follow_ups'] as const;
