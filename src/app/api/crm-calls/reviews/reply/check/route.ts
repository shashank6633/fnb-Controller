/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { ensureReviewSchema } from '@/lib/reviews';
import { checkReply, replySendHistory, ReplyRefusedError } from '@/lib/reviews/reply';

/**
 * CRM — CHECK 2 OF 3, ON THE SERVER (POST /api/crm-calls/reviews/reply/check).
 * ADMIN ONLY.
 *
 * The composer calls this as the admin types so the findings on screen are the
 * SERVER's findings, not a second opinion computed in the browser. Both sides
 * run the same validateReply(); this route adds the two things the browser
 * cannot know — whether the review can be addressed on Google at all, and what
 * the recently published replies look like for the variety checks.
 *
 * IT CANNOT SEND. It does not import sendReviewReply and it never contacts
 * Google: resolveReplyTarget() reads the stored connection and the archived
 * review JSON, nothing more. Checking a reply must be free of consequences, or
 * an admin will stop checking.
 *
 * WHY POST AND NOT GET: the body carries the draft reply, which quotes a named
 * guest's complaint. That does not belong in a URL, a proxy log or a browser
 * history entry. Nothing here is state-changing despite the verb; the CSRF
 * header that comes with a POST through src/lib/api.ts is a bonus, not the
 * reason.
 */

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  let payload: any = {};
  try { payload = await req.json(); } catch { /* an empty body validates as empty */ }

  const reviewId = String(payload?.review_id || '').trim();
  if (!reviewId) return Response.json({ error: 'review_id required' }, { status: 400 });
  const comment = typeof payload?.comment === 'string' ? payload.comment : '';
  const locationKey = payload?.location_key === undefined ? undefined : String(payload.location_key);

  const db = ensureReviewSchema(getDb());

  try {
    const check = checkReply({ db, reviewId, comment, locationKey });
    return Response.json({
      ok: true,
      /** Can this be sent AT ALL — the row is addressable and nothing blocking
       *  fired. Warnings still have to be acknowledged; that is the send
       *  route's gate, and it is reported separately so the page can show the
       *  difference between "fix this" and "accept this". */
      can_send: check.validation.ok && !!check.target,
      validation: check.validation,
      /** Present only so the page can say WHY a review cannot be answered from
       *  here. It carries no account or review id the page did not already
       *  have. */
      target: check.target
        ? { review_name: check.target.reviewName, basis: check.target.basis }
        : null,
      target_error: check.target_error,
      is_edit: check.is_edit,
      existing_reply: check.existing_reply,
      existing_replied_at: check.existing_replied_at,
      /** The words the confirm step must say out loud, and must echo back. */
      business_label: check.business_label,
      max_bytes: check.max_bytes,
      /** Everything this app has ever sent for this review. Google's listing
       *  cannot answer "who sent that, and did it replace something". */
      history: replySendHistory(db, reviewId),
      review: {
        id: check.review.id,
        rating: check.review.rating,
        author_name: check.review.author_name,
        author_is_anonymous: check.review.author_is_anonymous,
        text: check.review.text,
        posted_at: check.review.posted_at,
        language: check.review.language,
      },
    });
  } catch (e: any) {
    if (e instanceof ReplyRefusedError) {
      return Response.json({ error: e.message, code: e.code }, { status: 400 });
    }
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
