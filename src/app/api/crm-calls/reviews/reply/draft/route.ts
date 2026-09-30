/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { ensureReviewSchema } from '@/lib/reviews';
import { loadReviewForReply, recentSentReplies } from '@/lib/reviews/reply';
import { draftReply, isReplyDraftAiOn, openingsToAvoid, REVIEWS_REPLY_AI_FLAG } from '@/lib/reviews/reply-draft';
import { validateReply } from '@/lib/reviews/reply-validate';

/**
 * CRM — AI REPLY DRAFT (POST /api/crm-calls/reviews/reply/draft). ADMIN ONLY.
 *
 * Returns a draft written to earn a return visit, for the admin to edit. The
 * owner's words: "AI Draft Should prepare the Reply Draft to Convince the Guest
 * to Come Again to our Place in that manner it should be."
 *
 * THIS ROUTE CANNOT PUBLISH ANYTHING. It does not import the send path and holds
 * no Google token. The draft comes back as text and is subject to the same three
 * checks as anything typed by hand — which is why the validation is run HERE and
 * returned with it, pre-marked but never pre-approved: if the model reached for a
 * free dessert, the admin sees "Offers compensation" in the same breath as the
 * draft rather than discovering it after publishing.
 *
 * ADMIN ONLY even though a draft is harmless on its own. A manager cannot send,
 * so a manager drafting would only ever produce text he cannot use, at the
 * owner's cost per call. Same gate as every other mutating route in this module.
 *
 * NOTHING IS STORED. The draft is not written to gr_reviews.reply_text — that
 * column mirrors what Google is showing, and a draft in it would make the page
 * claim a review was answered when no guest can see a thing.
 */

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  let payload: any = {};
  try { payload = await req.json(); } catch { /* fall through to the 400 below */ }

  const reviewId = String(payload?.review_id || '').trim();
  if (!reviewId) return Response.json({ error: 'review_id required' }, { status: 400 });

  const db = ensureReviewSchema(getDb());
  const review = loadReviewForReply(db, reviewId);
  if (!review) return Response.json({ error: 'That review is not in the database.' }, { status: 404 });

  const locationKey = payload?.location_key === undefined ? review.location_key : String(payload.location_key);

  // Answered fast, before paying for a call: a 200 with a clear status is more
  // useful to the page than a 4xx, because "AI is off" is a normal state and the
  // composer has to carry on working in it.
  if (!isReplyDraftAiOn(db)) {
    return Response.json({
      ok: false,
      status: 'disabled',
      setting: REVIEWS_REPLY_AI_FLAG,
      message: 'AI draft is switched off. An admin turns on ' + REVIEWS_REPLY_AI_FLAG
        + ' in Settings to use it. Replies can still be typed and sent exactly as before.',
    });
  }

  /* The openings already on this listing, so the drafter does not produce a
   * fifth reply that starts the same way as the last four. With thousands of
   * unanswered reviews this is the difference between a listing that reads as
   * written and one that reads as generated. */
  const recent = recentSentReplies(db, locationKey);

  const result = await draftReply({
    db,
    review: {
      rating: review.rating,
      text: review.text,
      author_name: review.author_name,
      author_is_anonymous: review.author_is_anonymous,
      language: review.language,
      posted_at: review.posted_at,
    },
    avoidOpenings: openingsToAvoid(recent),
  });

  if (!result.ok || !result.draft) {
    return Response.json({
      ok: false,
      status: result.status,
      model: result.model,
      message: result.message,
    });
  }

  /* The draft's OWN findings, computed here so the admin never sees a draft
   * without seeing what is wrong with it. Pre-marked, never pre-approved: the
   * send route re-runs all of this and still requires each warning to be
   * acknowledged. A model-written reply gets no shortcut for being
   * model-written. */
  const validation = validateReply({
    comment: result.draft.reply,
    review: {
      text: review.text,
      rating: review.rating,
      author_name: review.author_name,
      author_is_anonymous: review.author_is_anonymous,
      language: review.language,
    },
    recentReplies: recent.filter(t => t.trim() !== String(review.reply_text || '').trim()),
  });

  return Response.json({
    ok: true,
    status: 'drafted',
    model: result.model,
    draft: result.draft,
    validation,
    /** Said on the page next to the draft, every time. */
    disclaimer: 'A language model wrote this from the review text alone. Read every line before '
      + 'sending: it is published publicly under the business name and Google cannot undo it. '
      + 'Check especially that nothing here promises the guest something the restaurant has not '
      + 'agreed to, and that no detail about the venue has been invented.',
  });
}
