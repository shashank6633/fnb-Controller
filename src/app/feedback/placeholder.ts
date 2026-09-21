/**
 * Guest Feedback — P1 SHELL DATA. One file, on purpose.
 *
 * ⚠️ DELETE THIS FILE IN P2..P5. It exists so the four shells render a real
 * layout before any `gf_` table or `/api/feedback/*` route exists. Every row
 * below is invented. Keeping it in ONE module means a later phase can prove the
 * shells are live by deleting the file and watching `tsc --noEmit` point at
 * every remaining consumer — rather than hunting inline fixtures in four pages.
 *
 * The TYPES, by contrast, are meant to survive: they are the shape the P2+
 * endpoints should return, named after the real columns P0 measured
 * (FEEDBACK-BUILD-STATE.md §2) so nothing has to be renamed later:
 *   · `opened_at`          ← orders.created_at
 *   · `covers`             ← orders.covers            (Pax)
 *   · `server_name`        ← orders.server_name       (Captain)
 *   · `item_count`         ← COUNT(order_items)
 *   · `bill_requested_at`  ← orders.bill_requested_at
 *   · `bill_printed_at`    ← orders.bill_printed_at
 *   · `floor`              ← restaurant_tables.zone   (there is NO `floor`
 *     column — P0 Lane B measured `SELECT floor FROM restaurant_tables` as an
 *     error, and sales-reports.ts:87 / sales-dashboard.ts:192 already alias
 *     `rt.zone AS floor`.)
 */

import type { ItemGroup, OverallRating, TableStatus } from '@/lib/feedback';

/* ── Page 1 ──────────────────────────────────────────────────────────────── */

export interface FloorTable {
  order_id: string;
  table_id: string;
  table_number: string;
  floor: string;
  covers: number | null;
  server_name: string | null;
  item_count: number;
  opened_at: string;
  bill_requested_at: string | null;
  bill_printed_at: string | null;
  status: TableStatus;
  /** Who took it, once taken. Null while the table is still due. */
  gre_name: string | null;
}

/** Minutes ago → an ISO stamp, so the shell's elapsed times look plausible
 *  and move with the clock instead of being frozen strings. */
const ago = (mins: number): string => new Date(Date.now() - mins * 60000).toISOString();

export const FLOOR_TABLES: FloorTable[] = [
  {
    order_id: 'demo-ord-1', table_id: 'demo-t-1', table_number: '4', floor: 'Ground Floor',
    covers: 4, server_name: 'Ramesh', item_count: 7, opened_at: ago(52),
    bill_requested_at: null, bill_printed_at: null, status: 'due', gre_name: null,
  },
  {
    order_id: 'demo-ord-2', table_id: 'demo-t-2', table_number: '7', floor: 'Ground Floor',
    covers: 2, server_name: 'Suresh', item_count: 2, opened_at: ago(9),
    bill_requested_at: null, bill_printed_at: null, status: 'not_ready', gre_name: null,
  },
  {
    order_id: 'demo-ord-3', table_id: 'demo-t-3', table_number: '11', floor: 'Rooftop',
    covers: 6, server_name: 'Anil', item_count: 12, opened_at: ago(84),
    bill_requested_at: ago(6), bill_printed_at: null, status: 'taken', gre_name: 'Priya',
  },
  {
    order_id: 'demo-ord-4', table_id: 'demo-t-4', table_number: '12', floor: 'Rooftop',
    covers: 3, server_name: 'Ramesh', item_count: 5, opened_at: ago(38),
    bill_requested_at: null, bill_printed_at: null, status: 'issue', gre_name: 'Priya',
  },
  {
    order_id: 'demo-ord-5', table_id: 'demo-t-5', table_number: '2', floor: 'Ground Floor',
    covers: 5, server_name: 'Anil', item_count: 9, opened_at: ago(66),
    bill_requested_at: ago(11), bill_printed_at: ago(4), status: 'follow_up', gre_name: 'Kiran',
  },
  {
    order_id: 'demo-ord-6', table_id: 'demo-t-6', table_number: '9', floor: 'Ground Floor',
    covers: 2, server_name: 'Suresh', item_count: 6, opened_at: ago(21),
    bill_requested_at: null, bill_printed_at: null, status: 'due', gre_name: null,
  },
];

/** Distinct floors, in first-seen order. P2 reads this from
 *  `restaurant_tables.zone`; note that an empty zone renders as the literal
 *  'Floor' in the Captain app (CaptainShell.tsx:31) and `captain-area.ts:30`
 *  treats `'Floor'` and `''` as the same bucket — the real filter must too. */
export const FLOORS: string[] = Array.from(new Set(FLOOR_TABLES.map((t) => t.floor)));

/* ── Page 2 ──────────────────────────────────────────────────────────────── */

export interface TakeItem {
  id: string;
  name: string;
  quantity: number;
  /** Food vs Drinks. P3 derives this SERVER-side from `order_items.station`
   *  via `stationKdsSection()` in src/lib/kot-section.ts — never re-implement
   *  the station list in the client (P0 Lane B measured why). */
  group: ItemGroup;
  station: string;
}

export interface TakeOrder {
  order_id: string;
  order_number: number;
  table_number: string;
  floor: string;
  covers: number | null;
  server_name: string | null;
  opened_at: string;
  items: TakeItem[];
}

export const TAKE_ORDER: TakeOrder = {
  order_id: 'demo-ord-1',
  order_number: 1042,
  table_number: '4',
  floor: 'Ground Floor',
  covers: 4,
  server_name: 'Ramesh',
  opened_at: ago(52),
  items: [
    { id: 'i1', name: 'Chicken Tikka', quantity: 1, group: 'food', station: 'tandoor' },
    { id: 'i2', name: 'Dal Makhani', quantity: 1, group: 'food', station: 'indian' },
    { id: 'i3', name: 'Butter Naan', quantity: 4, group: 'food', station: 'tandoor' },
    { id: 'i4', name: 'Pad Thai Noodles', quantity: 1, group: 'food', station: 'pan-asian' },
    { id: 'i5', name: 'Old Fashioned', quantity: 2, group: 'drinks', station: 'cocktail' },
    { id: 'i6', name: 'Virgin Mojito', quantity: 1, group: 'drinks', station: 'mocktail' },
    { id: 'i7', name: 'Kingfisher Ultra', quantity: 2, group: 'drinks', station: 'liquor' },
  ],
};

/* ── Page 3 ──────────────────────────────────────────────────────────────── */

export interface TrackerRecord {
  id: string;
  table_number: string;
  floor: string;
  gre_name: string | null;
  captain_name: string | null;
  taken_at: string | null;
  overall: OverallRating | null;
  /** How many item-level complaints were recorded on this visit. */
  issues: number;
  /** Open item complaints still awaiting a revisit. */
  open_follow_ups: number;
  status: TableStatus;
  note: string | null;
}

export const TRACKER_RECORDS: TrackerRecord[] = [
  {
    id: 'r1', table_number: '11', floor: 'Rooftop', gre_name: 'Priya', captain_name: 'Anil',
    taken_at: ago(14), overall: 'excellent', issues: 0, open_follow_ups: 0, status: 'taken',
    note: 'Guest complimented the service.',
  },
  {
    id: 'r2', table_number: '12', floor: 'Rooftop', gre_name: 'Priya', captain_name: 'Ramesh',
    taken_at: ago(26), overall: 'average', issues: 1, open_follow_ups: 0, status: 'issue',
    note: 'Prawn Tempura — cold. Item returned.',
  },
  {
    id: 'r3', table_number: '2', floor: 'Ground Floor', gre_name: 'Kiran', captain_name: 'Anil',
    taken_at: ago(41), overall: 'poor', issues: 2, open_follow_ups: 1, status: 'follow_up',
    note: 'Biryani remade — revisit pending.',
  },
  {
    id: 'r4', table_number: '4', floor: 'Ground Floor', gre_name: null, captain_name: 'Ramesh',
    taken_at: null, overall: null, issues: 0, open_follow_ups: 0, status: 'due',
    note: null,
  },
  {
    id: 'r5', table_number: '9', floor: 'Ground Floor', gre_name: null, captain_name: 'Suresh',
    taken_at: null, overall: null, issues: 0, open_follow_ups: 0, status: 'due',
    note: null,
  },
  {
    id: 'r6', table_number: '7', floor: 'Ground Floor', gre_name: null, captain_name: 'Suresh',
    taken_at: null, overall: null, issues: 0, open_follow_ups: 0, status: 'not_ready',
    note: null,
  },
];

/**
 * GRE / Manager progress (§3 Page 3). Deliberately these four columns and no
 * "score": the fairness ruling forbids any metric that makes recording a
 * complaint look bad for the recorder, so coverage is `taken ÷ eligible` —
 * an activity measure that is blind to whether the feedback was good or bad.
 */
export interface CoverageRow {
  person: string;
  role: string;
  eligible: number;
  taken: number;
  follow_ups_done: number;
  follow_ups_open: number;
}

export const COVERAGE_ROWS: CoverageRow[] = [
  { person: 'Priya', role: 'GRE', eligible: 14, taken: 12, follow_ups_done: 3, follow_ups_open: 0 },
  { person: 'Kiran', role: 'GRE', eligible: 11, taken: 7, follow_ups_done: 1, follow_ups_open: 1 },
  { person: 'Meera', role: 'Floor Manager', eligible: 9, taken: 9, follow_ups_done: 2, follow_ups_open: 0 },
];

export const GRE_NAMES: string[] = COVERAGE_ROWS.map((r) => r.person);
export const CAPTAIN_NAMES: string[] = ['Ramesh', 'Suresh', 'Anil'];

/* ── Page 4 ──────────────────────────────────────────────────────────────── */

export interface MenuItemRow {
  menu_item: string;
  group: ItemGroup;
  sold: number;
  feedbacks: number;
  negative: number;
  returned: number;
  remade: number;
  happy_after: number;
}

export const MENU_ITEM_ROWS: MenuItemRow[] = [
  { menu_item: 'Prawn Tempura', group: 'food', sold: 64, feedbacks: 21, negative: 9, returned: 4, remade: 3, happy_after: 5 },
  { menu_item: 'Chicken Biryani', group: 'food', sold: 212, feedbacks: 58, negative: 7, returned: 1, remade: 4, happy_after: 4 },
  { menu_item: 'Old Fashioned', group: 'drinks', sold: 88, feedbacks: 19, negative: 5, returned: 2, remade: 2, happy_after: 3 },
  { menu_item: 'Butter Naan', group: 'food', sold: 340, feedbacks: 71, negative: 3, returned: 0, remade: 2, happy_after: 2 },
  { menu_item: 'Virgin Mojito', group: 'drinks', sold: 126, feedbacks: 33, negative: 2, returned: 0, remade: 1, happy_after: 1 },
  { menu_item: 'Dal Makhani', group: 'food', sold: 154, feedbacks: 44, negative: 1, returned: 0, remade: 0, happy_after: 0 },
];

export interface CountRow {
  label: string;
  count: number;
}

export const COMMON_PROBLEMS: CountRow[] = [
  { label: 'Delay', count: 14 },
  { label: 'Cold', count: 9 },
  { label: 'Too Spicy', count: 6 },
  { label: 'Quantity', count: 4 },
  { label: 'Presentation', count: 3 },
];

export const MOST_APPRECIATED: CountRow[] = [
  { label: 'Butter Naan', count: 68 },
  { label: 'Chicken Biryani', count: 51 },
  { label: 'Dal Makhani', count: 43 },
  { label: 'Virgin Mojito', count: 31 },
  { label: 'Old Fashioned', count: 14 },
];

/** Service Recovery — what happened AFTER a negative feedback (§3 Page 4). */
export const RECOVERY_ROWS: CountRow[] = [
  { label: 'Item Returned', count: 7 },
  { label: 'Same Item Remade', count: 10 },
  { label: 'Fresh Item Replaced', count: 6 },
  { label: 'Different Item Replaced', count: 3 },
  { label: 'Item Cancelled', count: 2 },
  { label: 'No Action Required', count: 5 },
];

/** Headline numbers for Page 4's tile row. */
export const ANALYTICS_SUMMARY = {
  eligible_tables: 34,
  feedback_taken: 28,
  excellent: 11,
  good: 9,
  average: 5,
  poor: 3,
  negative_item_feedbacks: 27,
  returned: 7,
  remade: 10,
  replaced: 9,
  happy_after_replacement: 15,
  still_unhappy: 2,
  pending_follow_ups: 1,
};
