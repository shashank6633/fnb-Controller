/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { ensureReviewSchema, connectionHealth, getConnection, hasOauthApp, autoDriverTickAt } from '@/lib/reviews';
import { ReconnectRequiredError } from '@/lib/reviews/oauth';
import { SourceNotConfiguredError } from '@/lib/reviews/types';
import { REPLY_ORIGINS, ReplyRefusedError, replySendHistory, sendReviewReply } from '@/lib/reviews/reply';

/**
 * CRM — POST AN OWNER REPLY TO GOOGLE. ADMIN ONLY.
 * POST /api/crm-calls/reviews/reply
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS IS THE ONLY ROUTE IN THIS APPLICATION THAT PUBLISHES TO THE PUBLIC
 * INTERNET. A 200 from here means words are live on Google, under the owner's
 * business name, on a listing with five figures of real guest reviews, and
 * GOOGLE PROVIDES NO UNDO.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ADMIN ONLY, matching every other mutating route in this module
 * (requireRole('admin'), as /settings and /import already use). A manager keeps
 * the whole reviews page — the report, the attention list, the themes, the
 * connection health — and cannot send. That is deliberate: reading the reviews
 * is management work, and answering in public under the business name is the
 * owner's.
 *
 * ── THE THREE CHECKS, AND WHERE EACH ONE ACTUALLY LIVES ─────────────────────
 * The owner asked for "2-3 checks before Submiting to google so can check any
 * mistakes before submitting to google". They are the only undo that exists, so
 * none of them may be a property of the screen alone:
 *
 *   1. PREVIEW  — the page shows the exact words beside the review. A screen.
 *   2. VALIDATE — re-run inside sendReviewReply() via checkReply(). The client's
 *                 verdict is not evidence; a hand-rolled POST gets the same
 *                 verdict from the same code.
 *   3. CONFIRM  — requireConfirmation() in src/lib/reviews/reply.ts demands
 *                 confirm.public === true, every warning acknowledged BY CODE,
 *                 the business name echoed back, and — when a reply is already
 *                 public — an explicit overwrite. A request that skipped the
 *                 confirm dialog does not know the business name to echo, which
 *                 is what turns that step from a checkbox into a check.
 *
 * This route deliberately does NOT re-implement any of those. Two copies of a
 * safety check drift, and the copy that lags is the one that lets something
 * through. It parses, it calls, it translates the refusal into an HTTP status.
 *
 * ── WHY EVERY REFUSAL IS A 4xx WITH THE REASON IN IT ────────────────────────
 * An admin who is refused at the moment of publishing needs to know which of
 * the three checks stopped him and what to change. `code` is the machine-
 * readable reason; `findings` names each failure individually, never as
 * "invalid".
 */

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const me = auth.user;

  let payload: any = {};
  try { payload = await req.json(); } catch {
    return Response.json({ error: 'A JSON body is required.' }, { status: 400 });
  }

  const reviewId = String(payload?.review_id || '').trim();
  if (!reviewId) return Response.json({ error: 'review_id required' }, { status: 400 });
  if (typeof payload?.comment !== 'string') {
    return Response.json({ error: 'comment required' }, { status: 400 });
  }
  const comment = payload.comment;
  const locationKey = payload?.location_key === undefined ? undefined : String(payload.location_key);
  const origin = (REPLY_ORIGINS as readonly string[]).includes(String(payload?.origin))
    ? String(payload.origin) as (typeof REPLY_ORIGINS)[number]
    : 'typed';

  /* The confirmation, taken as data and validated by requireConfirmation(). It
   * is NOT defaulted into something permissive: an absent `confirm` block means
   * confirm.public is undefined, which fails, which is the correct outcome for a
   * request that never went through the confirm step. */
  const c = payload?.confirm && typeof payload.confirm === 'object' ? payload.confirm : {};
  const confirm = {
    public: c.public === true,
    business: typeof c.business === 'string' ? c.business : '',
    acknowledged: Array.isArray(c.acknowledged) ? c.acknowledged.map((x: any) => String(x)) : [],
    overwrite: c.overwrite === true,
  };

  const db = ensureReviewSchema(getDb());

  try {
    const result = await sendReviewReply({
      db,
      reviewId,
      comment,
      actor: me.email || me.name || me.id,
      locationKey,
      origin,
      confirm,
    });

    return Response.json({
      ...result,
      history: replySendHistory(db, reviewId),
    });
  } catch (e: any) {
    /* A refusal by THIS APP. 409 rather than 400 for the states that are about
     * the world rather than the request — the reply is fine, the situation is
     * not, and the text the admin typed must survive on screen so he can fix
     * the situation and press send again. */
    if (e instanceof ReplyRefusedError) {
      const conflict = new Set([
        'send_in_flight', 'no_listing', 'bad_listing', 'listing_mismatch',
        'no_google_id', 'bad_google_id', 'google_refused',
      ]);
      return Response.json({
        error: e.message,
        code: e.code,
        findings: e.findings,
        /**
         * 'no' is a CLAIM, and it is only made where it is true. Every
         * ReplyRefusedError is raised either before the PUT (a failed check, a
         * missing confirmation, an unaddressable review, a send already in
         * flight) or on a non-ok response from Google, and in all of those cases
         * nothing reached the listing. See the 'unknown' case below — the one
         * thing an admin must never be told is that nothing was published when
         * we do not actually know.
         */
        published: 'no',
      }, { status: conflict.has(e.code) ? 409 : 400 });
    }

    const conn = getConnection(db, locationKey || '');
    const health = connectionHealth(conn, { hasApp: hasOauthApp(db), driverTickAt: autoDriverTickAt(db) });

    // A refused refresh token is terminal until a human reconnects: nothing is
    // broken in this app and the fix is a button, not a retry. Same contract as
    // the refresh route, so the page's existing reconnect banner handles it.
    // Both of these come out of gbpAccessToken(), which runs BEFORE the PUT, so
    // 'no' is a true claim for each.
    if (e instanceof ReconnectRequiredError) {
      return Response.json({
        error: e.message, code: 'needs_reconnect', needs_reconnect: true,
        published: 'no', health,
      }, { status: 409 });
    }
    if (e instanceof SourceNotConfiguredError) {
      return Response.json({
        error: e.message, code: 'not_configured', prerequisites: e.prerequisites,
        published: 'no', health,
      }, { status: 409 });
    }

    /* ── THE HONEST 'UNKNOWN'. ───────────────────────────────────────────────
     * Anything reaching here is unplanned, and the send path is not atomic
     * across the network: the PUT can have succeeded and a write AFTER it can
     * have failed. Claiming "nothing was published" here would be a guess
     * presented as a fact, about the one thing in this app that cannot be taken
     * back — so it says it does not know, and says where to look. The send row
     * survives as 'sending' and is demoted to 'unknown' rather than retried,
     * which is why a second attempt will not blindly publish over a reply that
     * may already be live. */
    return Response.json({
      error: String(e?.message || e),
      code: 'unexpected',
      published: 'unknown',
      published_note: 'This failed in a way the app did not plan for, AFTER the point where a reply '
        + 'can already have reached Google. Do not simply send again — open the review on Google and '
        + 'look at whether a reply is there. The send log on this review records the attempt.',
      health,
    }, { status: 502 });
  }
}
