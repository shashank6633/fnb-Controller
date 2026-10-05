/**
 * THE TAKE-FEEDBACK DRAFT — the pure half of Page 2.  (P3 Lane C)
 *
 * WHY THIS FILE EXISTS RATHER THAN LIVING IN `page.tsx`. The defect this lane
 * fixed was a screen that rendered invented dishes and submitted nothing, and
 * the reason it survived a 526-assertion suite is that NOTHING COULD REACH IT: a
 * client component's internal state and its request body are sealed inside a
 * React closure, so no test could ask "what would this screen actually post?".
 *
 * So the two decisions that have to agree with the server — WHICH item entries
 * are worth storing, and WHAT body goes on the wire — live here, as plain
 * functions over plain data. `page.tsx` owns the taps; this file owns the
 * meaning, and `scripts/feedback-take-page-tests.js` drives these functions into
 * the REAL `POST /api/feedback` and then reads the `gf_` rows back out.
 *
 * It is typed against `SubmitFeedbackInput` from `src/lib/feedback/write.ts`
 * (type-only, so nothing server-side reaches the client bundle). If the writer
 * ever changes its contract, this file stops compiling instead of posting a body
 * the route will refuse.
 *
 * 🔒 NO MONEY, and no POS field of any kind: a draft holds a rating, an issue, a
 * comment, an action and a revisit. Nothing here can describe a quantity change,
 * a cancellation command or a bill.
 */

import { CATEGORIES } from '@/lib/feedback';
import type {
  ActionTaken, Category, Happiness, ItemIssue, ItemRating, OverallRating, RevisitRating,
} from '@/lib/feedback';
import type { SubmitFeedbackInput, SubmitItemInput } from '@/lib/feedback/write';

/** What the GRE has recorded against one ordered line. All fields optional —
 *  that is the point of the screen. */
export interface ItemFeedback {
  rating?: ItemRating;
  issue?: ItemIssue;
  comment?: string;
  action?: ActionTaken;
}

/** The revisit, asked only for items whose action forces a follow-up. */
export interface Revisit {
  after?: RevisitRating;
  happy?: Happiness;
}

/** Everything the screen has collected, in one serialisable object. */
export interface TakeDraft {
  order_id: string;
  overall: OverallRating | null;
  categories: Partial<Record<Category, ItemRating>>;
  itemFb: Record<string, ItemFeedback>;
  revisits: Record<string, Revisit>;
  /** Was the one-tap "Everything Good" path used? */
  oneTap: boolean;
}

export const emptyDraft = (orderId: string): TakeDraft => ({
  order_id: orderId,
  overall: null,
  categories: {},
  itemFb: {},
  revisits: {},
  oneTap: false,
});

/**
 * THE SILENCE RULE. Mirrors `recordable()` in `src/lib/feedback/write.ts`, and
 * `feedback-take-page-tests.js` proves the two agree on every combination rather
 * than trusting this comment.
 *
 * The section heading says "tap an item only if there is a problem", so an item
 * the GRE opened and closed without saying anything must NOT be sent: the server
 * drops it as `items_ignored_empty`, and counting it on the screen would light up
 * Submit and the "N item issues" summary for an opinion nobody gave.
 *
 * `action: 'none'` ("No Action Required") alone does not count, exactly as the
 * writer has it: it is a mis-tap on a sheet that was opened and closed, and
 * storing it would put an unrated plate into Page 4's "Feedbacks" denominator.
 */
export function isRecordable(fb: ItemFeedback | undefined | null): boolean {
  if (!fb) return false;
  return !!fb.rating
    || !!fb.issue
    || !!(fb.comment || '').trim()
    || (!!fb.action && fb.action !== 'none');
}

/**
 * Mirrors the writer's own `saysSomething`: the one-tap path, an overall rating,
 * any category, or at least one recordable item. An abandoned form must never
 * become a row — `gf_visits` is what coverage counts.
 */
export function canSubmit(draft: TakeDraft): boolean {
  return draft.oneTap
    || draft.overall !== null
    || CATEGORIES.some((c) => !!draft.categories[c.v])
    || Object.values(draft.itemFb).some(isRecordable);
}

/**
 * The exact body `POST /api/feedback` receives.
 *
 * Two things it deliberately does NOT do:
 *   · it does not send `gre_user_id` / `gre_name` — the recorder comes from the
 *     session, and the route ignores a body that names one;
 *   · it does not send `item_group` or `station` — Food vs Drinks is resolved
 *     SERVER-SIDE from `order_items.station`, so a client guess could never
 *     disagree with the stored row.
 *
 * Empty strings are omitted rather than sent, because the writer refuses an
 * unknown enum value instead of coercing it — `''` is its "nothing said", and an
 * absent key says that more plainly than a blank one.
 */
export function buildSubmitBody(draft: TakeDraft): SubmitFeedbackInput {
  const items: SubmitItemInput[] = [];
  for (const [orderItemId, fb] of Object.entries(draft.itemFb)) {
    if (!isRecordable(fb)) continue;              // silence is not a rating
    const entry: SubmitItemInput = { order_item_id: orderItemId };
    if (fb.rating) entry.rating = fb.rating;
    if (fb.issue) entry.issue = fb.issue;
    const comment = (fb.comment || '').trim();
    if (comment) entry.comment = comment;
    if (fb.action) entry.action = fb.action;

    const rv = draft.revisits[orderItemId];
    if (rv && (rv.after || rv.happy)) {
      entry.revisit = {};
      if (rv.after) entry.revisit.rating = rv.after;
      if (rv.happy) entry.revisit.happiness = rv.happy;
    }
    items.push(entry);
  }

  const categories: Partial<Record<Category, ItemRating>> = {};
  for (const c of CATEGORIES) {
    const v = draft.categories[c.v];
    if (v) categories[c.v] = v;
  }

  const body: SubmitFeedbackInput = {
    order_id: draft.order_id,
    everything_good: draft.oneTap,
    categories,
    items,
  };
  if (draft.overall) body.overall_rating = draft.overall;
  return body;
}
