/**
 * Guest Feedback & Service Recovery — THE shared module.
 *
 * ⚠️ ZERO IMPORTS, AND THAT IS THE POINT. Page 2 (Take Feedback) and Page 4
 * (Analytics) are client components; the API routes and the report builders are
 * server-side. The only module that can be the single source for both is one
 * with no dependencies. `page-catalog.ts:701` documents what happens otherwise:
 * a shared module that reaches for `@/lib/db` drags better-sqlite3 into the
 * browser bundle. Never import `@/lib/db`, React, or anything else here.
 *
 * Every vocabulary below is lifted VERBATIM from §3 of FEEDBACK-BUILD-STATE.md
 * (the owner's own words). Store the `v` (wire value); render the `label`.
 *
 * ── CONCURRENT-LANE NOTE (P1 Lane A, 2026-09-21) ────────────────────────────
 * `src/app/feedback/enums.ts` was created by P1 Lane B minutes before this file
 * and carries the same lists. Its own header says it is a TEMPORARY home and
 * must become a re-export. I did not edit it because `src/app/feedback/**` is
 * Lane B's lane and a concurrent edit is how work gets clobbered. Every `v`
 * below is byte-identical to Lane B's, so the repoint is a pure no-op:
 *     src/app/feedback/enums.ts  →  export * from '@/lib/feedback';
 * DO NOT leave two lists alive. This file is the one that survives — it is the
 * only one the server side can import.
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
   3. THE GATE — designed as a ONE-LINE SWAP (§7 Q1 is still the owner's)
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔑 THE ONE-LINE SWAP. §7 Q1 is unanswered: there is no "GRE" role in the
 * database today (measured — `roles` holds Administrator · Bar Manager ·
 * Captain · Cashier · Floor Manager · Head Chef · Manager · Staff · Store
 * Manager, and 0 users have `role_id` set at all).
 *
 * The recommendation, which P0 Lane A proved is the ONLY option compatible with
 * the owner's own read-only constraint, is option (a): he creates a role named
 * "GRE" in Settings → Roles at base_role 'staff' — exactly the precedent he
 * chose for Bill Handover's "Accounts". Option (b) — gating on Floor Manager —
 * must be struck: Floor Manager is base_role 'manager', and manager tier is
 * itself the key to void, settle, hold, service-charge waiver and discount
 * approval. Choosing (b) would hand the GRE five of the six powers he forbade.
 *
 * When he names the role, edit THIS LINE and nothing else. Matching is
 * case-insensitive and trimmed so "GRE ", "gre" and "Gre" all land.
 */
export const GRE_ROLE_NAMES: readonly string[] = ['GRE'];

/**
 * The second, zero-config marker P0 Lane B found already in the codebase:
 * `VALID_SECTIONS` in `api/auth/users/route.ts` already offers a "GRE"
 * value and `/users` already renders it as "GRE (Front Office)". Honouring it
 * costs nothing and means the owner can enable a GRE from the existing user
 * form if he prefers that to creating a role.
 *
 * ⚠️ `users.section` is NOT a spare field — `kot-section.ts` uses it to filter
 * the Kitchen Display and route KOT printing. 'GRE' is inert there
 * (`sectionMatchesStation` returns true for any non-Kitchen/Bar section), but
 * say so before recommending it.
 */
export const GRE_SECTION = 'GRE';

/** The shape every gate here reads. Deliberately structural, not `SessionUser`
 *  — importing `@/lib/auth` would pull `@/lib/db` into the client bundle. */
export interface FeedbackActor {
  role?: string | null;            // legacy tier: 'admin' | 'manager' | 'staff'
  role_name?: string | null;       // named role, resolved by getCurrentUser()
  section?: string | null;         // users.section
  is_head_chef?: boolean | null;
}

const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();

const namedGre = (u: FeedbackActor): boolean =>
  (!!u.role_name && GRE_ROLE_NAMES.some((n) => norm(n) === norm(u.role_name))) ||
  norm(u.section) === norm(GRE_SECTION);

/** Admin, any Manager tier, or an HOD — the same predicate `isMgmtOnlyPath`
 *  enforces in `canAccessPage`, restated here so the module's routes agree with
 *  its catalog without importing page-catalog. */
export function isFeedbackManagement(u: FeedbackActor | null | undefined): boolean {
  if (!u) return false;
  return u.role === 'admin' || u.role === 'manager' || !!u.is_head_chef;
}

/**
 * May this user use the module's floor pages (1-3)?
 *
 * FAILS CLOSED on a null user. Today this resolves to management-only, because
 * no GRE exists yet — which is the correct inert default: the module is usable
 * by the people who already have every one of these powers, and nobody gains
 * anything on deploy day. The moment the owner creates the role, the line above
 * turns it on.
 *
 * ⚠️ This is a convenience, NOT the security boundary. `proxy.ts` guards PAGES,
 * NOT APIs, and `canAccessPage` fails open four ways (null map, garbled JSON,
 * empty array, prefix grant) plus a fifth in proxy.ts's own catch. EVERY
 * `/api/feedback/*` route must call this itself and 403 (hard rule 9).
 */
export function canUseFeedback(u: FeedbackActor | null | undefined): boolean {
  if (!u) return false;
  return isFeedbackManagement(u) || namedGre(u);
}

/** Page 4 — Admin Analytics & Reports. Management only, matching the catalog's
 *  `mgmtOnly` flag on `/feedback/analytics`. */
export function canUseFeedbackAnalytics(u: FeedbackActor | null | undefined): boolean {
  return isFeedbackManagement(u);
}

/**
 * 🔒 THE DENY PREDICATE for the owner's READ-ONLY constraint — P2 consumes it.
 *
 * True for a user who is in this module and is NOT management: i.e. exactly the
 * GRE. P0 Lane A measured that a staff-tier session can still reach ~13 POS
 * write handlers that gate on nothing but `if (!me) 401` — add_item, set_qty,
 * remove_item, fire, the KDS bump family, customer-orders modify, replay,
 * print-bill and request-bill. Tier alone does not close them; an explicit
 * server-side deny does.
 *
 * Deliberately a DENY-LIST keyed on the GRE marker, not an allow-list: it is
 * INERT until the owner actually creates and assigns the role (no user carries
 * `role_name` or `section` today), so it cannot regress a live captain, cashier
 * or KDS on deploy day.
 *
 * ⚠️ Read `role_name`, which `getCurrentUser()` resolves but `proxy.ts` does
 * NOT — so this belongs in route handlers, which is where hard rule 9 says
 * every gate must live anyway.
 *
 * ⚠️ print-bill and request-bill are on the deny list for a reason that is not
 * obvious: they write `bill_printed_at` and `bill_requested_at`, TWO OF THIS
 * MODULE'S OWN THREE ELIGIBILITY TRIGGERS. A GRE who can call them can
 * manufacture or suppress their own coverage, and a coverage metric the
 * measured party can write is not a metric.
 */
export function isReadOnlyFeedbackUser(u: FeedbackActor | null | undefined): boolean {
  if (!u) return false;
  if (isFeedbackManagement(u)) return false;
  return namedGre(u);
}

/** The six powers the owner forbade, verbatim from §3 — for the 403 body, so
 *  the refusal quotes the rule it is enforcing. */
export const READ_ONLY_REFUSAL =
  'Guest Relations has read-only access to orders. Placing orders, cancelling items, '
  + 'changing quantity, modifying a KOT, modifying a bill and applying discounts are not permitted.';

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

/** Parse a settings value to a non-negative integer, falling back to the coded
 *  default for absent / blank / non-numeric / negative values alike. */
export function tunable(raw: unknown, fallback: number): number {
  const n = Number(String(raw ?? '').trim());
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
