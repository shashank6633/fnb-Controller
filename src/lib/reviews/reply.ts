/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * OWNER REPLY — THE SEND PATH. The only code in this app that publishes
 * anything to the public internet under the business's own name.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * READ THIS BEFORE CHANGING ANYTHING BELOW
 * ══════════════════════════════════════════════════════════════════════════
 * A reply is PUBLIC the instant Google's PUT returns. Under the owner's business
 * name, on a listing with five figures of real reviews from real guests, visible
 * to everyone who looks at the restaurant from then on. GOOGLE HAS NO UNDO — no
 * draft, no scheduled publish, no recall window. Deleting a reply afterwards
 * does not un-publish it; it only removes something that was already read and
 * already indexed.
 *
 * So the three checks the owner asked for ARE the undo, and they are the only
 * one there is:
 *
 *   1. PREVIEW  — the page shows the exact words beside the review.
 *   2. VALIDATE — ./reply-validate.ts, re-run HERE so the server decides.
 *   3. CONFIRM  — an explicit final step naming the business publicly, enforced
 *                 in this file by requireConfirmation(), not just drawn on a
 *                 screen. A confirmation that only the page enforces is not a
 *                 check; it is a habit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ONE DOOR TO GOOGLE
 * ══════════════════════════════════════════════════════════════════════════
 * This file does NOT call fetch and does not name a Google host. It calls
 * gbpPutReviewReply() in ./gbp-transport.ts, which is the single permitted write
 * shape out of four permitted shapes total. The token this app holds carries the
 * full business.manage scope — Google publishes no read-only scope for Business
 * Profile — so that allowlist, not a narrow permission, is what stops this
 * module editing the listing's name, hours or photos. Do not add a second path.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHOSE COPY OF THE REPLY IS AUTHORITATIVE
 * ══════════════════════════════════════════════════════════════════════════
 * GOOGLE'S IS. This is the part most likely to be "fixed" into a bug.
 *
 * gr_reviews.reply_text is a mirror of what Google serves, maintained by the
 * hourly pull. After a successful send this file writes the same value into it
 * so the page updates immediately instead of looking unanswered for an hour —
 * but it writes it in the exact shape the next pull will produce, so the pull
 * reports the row as UNCHANGED rather than as an edit:
 *
 *   • reply_text  = the comment GOOGLE echoed back (not necessarily ours).
 *   • replied_at  = Google's own reviewReply.updateTime, run through the SAME
 *                   parseTimestamp() the ingest parser uses. Storing our local
 *                   send time instead would differ from Google's by seconds,
 *                   contentHash() would differ, and every send would show up in
 *                   the next pull as "changed 1" — noise in the one report the
 *                   owner uses to tell a real edit from a quiet hour.
 *   • source_updated_at is NOT TOUCHED. mergeReview() refuses an incoming row
 *                   whose updateTime is older than the stored one (skip_stale),
 *                   so inventing a value here — especially a future one — would
 *                   make Google's own later copy of this review unimportable.
 *                   That failure would be silent and permanent for that row.
 *
 * If Google rejects the reply at moderation, the next pull returns the review
 * with no reviewReply, mergeReview() blanks our mirror, and the page correctly
 * shows it unanswered again. The record of what we sent survives in
 * gr_reply_sends, which no ingest ever writes. That is the whole reason that
 * table exists.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NOTHING HERE HAS BEEN EXERCISED AGAINST GOOGLE
 * ══════════════════════════════════════════════════════════════════════════
 * Every branch below is proven against an INJECTED fetch spy in
 * scripts/reviews-tests.js. Not one byte has been sent to Google's reply
 * endpoint, because the only way to test that is to publish a real reply on a
 * real listing, and a test string under a guest's one-star review is not
 * recoverable. What Google actually returns — and whether it comes back PENDING
 * or REJECTED rather than live — will be seen on the owner's first real send.
 * See UNPROVEN in ./sources-gbp.ts.
 */
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { ensureReviewSchema } from './schema';
import { getConnection } from './connection';
import { gbpConfig, gbpAccessToken, isValidParent } from './sources-gbp';
import { gbpPutReviewReply, GbpTransportRefusal, GBP_REPLY_MAX_BYTES } from './gbp-transport';
import { validateReply, replyBytes, type ReplyValidation, type ReplyFinding } from './reply-validate';
import { contentHash, parseTimestamp } from './parse';
import { toIsoUtc } from './time';

type DB = Database.Database;

/** A 'sending' row older than this lost its process. It is NOT retried
 *  automatically — we cannot know whether Google received the PUT — it is
 *  demoted to 'unknown' so the ambiguity is visible and a human decides. */
const STALE_SENDING_MS = 3 * 60 * 1000;

/** How many recent replies feed the variety checks. Enough to catch "the same
 *  reply again" in one sitting without loading the listing's whole history. */
const RECENT_REPLY_WINDOW = 25;

export const REPLY_ORIGINS = ['typed', 'ai_draft_edited', 'ai_draft_unchanged'] as const;
export type ReplyOrigin = (typeof REPLY_ORIGINS)[number];

/* ── Errors that mean different things ────────────────────────────────────── */

/**
 * This app will not send, and the reason is about OUR data or OUR rules — not
 * about Google. Separate from GbpTransportRefusal (a forbidden request shape)
 * and from a non-ok HTTP result (Google said no), because the three want three
 * different sentences on screen and three different reactions from a developer.
 */
export class ReplyRefusedError extends Error {
  readonly code: string;
  readonly findings: ReplyFinding[];
  constructor(code: string, message: string, findings: ReplyFinding[] = []) {
    super(message);
    this.name = 'ReplyRefusedError';
    this.code = code;
    this.findings = findings;
  }
}

/* ── Which review, on which listing, addressed how ───────────────────────── */

export interface ReplyTarget {
  reviewId: string;
  /** accounts/{a}/locations/{l}/reviews/{r} — what the PUT addresses. */
  reviewName: string;
  /** accounts/{a}/locations/{l} */
  parent: string;
  /** How the name was established. 'raw' is Google's own string, straight out
   *  of the archived review JSON, and is always preferred. */
  basis: 'raw_item_name' | 'parent_plus_external_id';
  /** The public business name, for the confirm step. */
  businessLabel: string;
}

export interface ReviewForReply {
  id: string;
  location_key: string;
  source: string;
  external_id: string;
  identity_basis: string;
  author_name: string;
  author_is_anonymous: boolean;
  rating: number;
  text: string;
  language: string;
  posted_at: string;
  posted_precision: string;
  source_updated_at: string;
  reply_text: string;
  replied_at: string;
  raw_item: string;
}

const REVIEW_NAME_RE = /^accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+$/;

export function loadReviewForReply(db: DB, reviewId: string): ReviewForReply | null {
  const row = db.prepare(
    `SELECT id, location_key, source, external_id, identity_basis, author_name,
            author_is_anonymous, rating, text, language, posted_at, posted_precision,
            source_updated_at, reply_text, replied_at, raw_item
       FROM gr_reviews WHERE id = ?`,
  ).get(String(reviewId || '')) as any;
  if (!row) return null;
  return { ...row, author_is_anonymous: !!row.author_is_anonymous };
}

/**
 * Work out the Google resource name to address, and REFUSE rather than guess.
 *
 * Refusing is the whole job here. Every alternative to refusing ends with a PUT
 * aimed at a resource path we assembled ourselves, against a live public
 * listing — and the failure mode is not a 404. It is a reply published under the
 * WRONG REVIEW, answering a complaint nobody made, or answering it on the wrong
 * outlet's listing.
 *
 * Two ways to establish the name, in this order:
 *
 *   1. raw_item.name — Google's own resource string, archived when the review
 *      was pulled. Authoritative: we are echoing back what Google told us.
 *   2. {connection parent}/reviews/{external_id} — only when the row's identity
 *      basis IS that external id, i.e. Google gave us a reviewId. A row
 *      identified by author+time (a Takeout export with no ids) has NO Google
 *      review id, and anything constructed for it would be an invention.
 *
 * And in both cases the parent must match the listing this app is connected to.
 * 10,055 reviews were imported before the reply path existed; some came from a
 * Takeout export, and Takeout is exactly where a row with no usable id comes
 * from. Those rows are answerable by hand on Google and not from here, which is
 * a far better outcome than a confident PUT at a guessed path.
 */
export function resolveReplyTarget(
  dbIn: DB | null, review: ReviewForReply, locationKey?: string,
): ReplyTarget {
  const db = ensureReviewSchema(dbIn || getDb());
  const key = locationKey === undefined ? review.location_key : locationKey;
  const cfg = gbpConfig(db, key);
  const conn = getConnection(db, key);
  const parent = String(cfg.parent || '').trim();
  const businessLabel = String(conn.location_label || conn.account_label || '').trim();

  if (!parent) {
    throw new ReplyRefusedError('no_listing',
      'No Google listing is connected for these reviews, so there is nothing to reply to. '
      + 'Connect the Google account that manages the listing first.');
  }
  if (!isValidParent(parent)) {
    throw new ReplyRefusedError('bad_listing',
      `The connected listing is stored as ${JSON.stringify(parent.slice(0, 60))}, which is not `
      + 'accounts/{account}/locations/{location}. Reconnect and pick the listing from the list.');
  }

  // 1. Google's own string for this review.
  let rawName = '';
  try {
    const item = JSON.parse(review.raw_item || 'null');
    const n = item && typeof item === 'object' ? String((item as any).name || '') : '';
    if (REVIEW_NAME_RE.test(n)) rawName = n;
  } catch { /* a Takeout row, or no archived item — fall through */ }

  if (rawName) {
    const rawParent = rawName.split('/reviews/')[0];
    if (rawParent !== parent) {
      throw new ReplyRefusedError('listing_mismatch',
        `This review was pulled from ${rawParent}, but the app is connected to ${parent}. `
        + 'Replying would post an answer on a different listing from the one the review is on. '
        + 'Switch to that listing before replying.');
    }
    return { reviewId: review.id, reviewName: rawName, parent, basis: 'raw_item_name', businessLabel };
  }

  // 2. Construct it — but only from an id Google itself supplied.
  const ext = String(review.external_id || '').trim();
  if (!ext || review.identity_basis !== 'external_id') {
    throw new ReplyRefusedError('no_google_id',
      'This review has no Google review id — it was matched by author and date, which is what a '
      + 'Takeout export gives when it carries no ids. There is no address to send a reply to, and '
      + 'guessing one would risk answering a different review in public. Reply to this one on '
      + 'Google directly; the next pull will bring the reply back in.');
  }
  if (/[/\s%]/.test(ext)) {
    throw new ReplyRefusedError('bad_google_id',
      `The stored review id ${JSON.stringify(ext.slice(0, 40))} contains a character that cannot appear `
      + 'in a Google review id. Refusing rather than sending a malformed path.');
  }
  return {
    reviewId: review.id,
    reviewName: `${parent}/reviews/${ext}`,
    parent,
    basis: 'parent_plus_external_id',
    businessLabel,
  };
}

/* ── Recent replies, for the variety checks ───────────────────────────────── */

/**
 * The replies already sitting on this listing, newest first.
 *
 * Read from gr_reviews.reply_text rather than from gr_reply_sends on purpose:
 * that column holds every reply Google is showing, including the hundreds the
 * owner posted BY HAND before this feature existed. Those are exactly the ones a
 * new draft is most likely to echo, and they are what a guest scrolling the
 * listing actually sees next to the new one.
 */
export function recentSentReplies(dbIn: DB | null, locationKey = '', limit = RECENT_REPLY_WINDOW): string[] {
  const db = ensureReviewSchema(dbIn || getDb());
  const rows = db.prepare(
    `SELECT reply_text FROM gr_reviews
      WHERE location_key = ? AND TRIM(reply_text) != ''
      ORDER BY (CASE WHEN replied_at = '' THEN 0 ELSE 1 END) DESC, replied_at DESC, posted_at DESC
      LIMIT ?`,
  ).all(locationKey, Math.max(1, Math.min(200, limit))) as Array<{ reply_text: string }>;
  return rows.map(r => String(r.reply_text || ''));
}

/* ── Check 2, with the data the pure validator cannot see ─────────────────── */

export interface ReplyCheck {
  review: ReviewForReply;
  /** null when the row cannot be addressed at all; `target_error` says why.
   *  Reported rather than thrown so the page can still show the validation. */
  target: ReplyTarget | null;
  target_error: { code: string; message: string } | null;
  validation: ReplyValidation;
  /** True when a reply is already public for this review, so the screen can say
   *  that sending REPLACES text guests have already been reading. */
  is_edit: boolean;
  existing_reply: string;
  existing_replied_at: string;
  /** The words the confirm step must name. */
  business_label: string;
  max_bytes: number;
}

export function checkReply(args: {
  db?: DB; reviewId: string; comment: string; locationKey?: string;
}): ReplyCheck {
  const db = ensureReviewSchema(args.db || getDb());
  const review = loadReviewForReply(db, args.reviewId);
  if (!review) throw new ReplyRefusedError('no_review', 'That review is not in the database.');

  const key = args.locationKey === undefined ? review.location_key : args.locationKey;

  let target: ReplyTarget | null = null;
  let targetError: { code: string; message: string } | null = null;
  try {
    target = resolveReplyTarget(db, review, key);
  } catch (e: any) {
    if (e instanceof ReplyRefusedError) targetError = { code: e.code, message: e.message };
    else throw e;
  }

  const validation = validateReply({
    comment: args.comment,
    review: {
      text: review.text,
      rating: review.rating,
      author_name: review.author_name,
      author_is_anonymous: review.author_is_anonymous,
      language: review.language,
    },
    // The row being answered is excluded: comparing a reply with the reply it is
    // about to replace would flag every edit as a duplicate of itself.
    recentReplies: recentSentReplies(db, key).filter(t => t.trim() !== String(review.reply_text || '').trim()),
  });

  const conn = getConnection(db, key);
  return {
    review,
    target,
    target_error: targetError,
    validation,
    is_edit: !!String(review.reply_text || '').trim(),
    existing_reply: review.reply_text || '',
    existing_replied_at: review.replied_at || '',
    business_label: target?.businessLabel || String(conn.location_label || conn.account_label || '').trim(),
    max_bytes: GBP_REPLY_MAX_BYTES,
  };
}

/* ── Check 3, enforced ────────────────────────────────────────────────────── */

export interface Confirmation {
  /** The admin ticked the final step. */
  public: boolean;
  /** The business name as the confirm step named it. Echoed back so a request
   *  that never went through that step cannot satisfy this. */
  business?: string;
  /** Warning codes the admin accepted, one by one. */
  acknowledged?: string[];
  /** Required when a public reply already exists — an edit overwrites text that
   *  guests have already read. */
  overwrite?: boolean;
}

/** Compare business names the way a person would: case and inner spacing are
 *  noise, everything else is not. */
function sameBusiness(a: string, b: string): boolean {
  const n = (s: string) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return !!n(a) && n(a) === n(b);
}

export function requireConfirmation(check: ReplyCheck, confirm: Confirmation): void {
  if (!check.validation.ok) {
    throw new ReplyRefusedError('validation_failed',
      'This reply did not pass the checks: '
      + check.validation.blocking.map(f => f.label).join('; ') + '.',
      check.validation.blocking);
  }

  const acked = new Set((confirm.acknowledged || []).map(String));
  const unacked = check.validation.warnings.filter(w => !acked.has(w.code));
  if (unacked.length) {
    throw new ReplyRefusedError('unacknowledged_warnings',
      'These need accepting before this can be published: '
      + unacked.map(f => f.label).join('; ') + '.',
      unacked);
  }

  if (confirm.public !== true) {
    throw new ReplyRefusedError('not_confirmed',
      'The final confirmation is missing. Nothing is sent to Google until the reply is confirmed for '
      + 'public posting — that step is the only undo there is.');
  }

  // The business name must be echoed back. This is what makes the confirm step a
  // CHECK rather than a checkbox: a request that did not come from the confirm
  // dialog does not know what name to echo.
  //
  // IT FAILS CLOSED, AND THAT IS THE WHOLE POINT OF THE REWRITE. This read
  //
  //     if (check.business_label && !sameBusiness(...)) throw
  //
  // and so skipped itself entirely whenever business_label was empty — which it
  // can be, because :336 derives it as
  // `target?.businessLabel || conn.location_label || conn.account_label || ''`
  // and every one of those three can be blank. A bare `{ public: true }` that had
  // never been near the confirm dialog then published, with the LAST guard in
  // front of a permanent public write silently absent. A guard that disappears
  // exactly when it has nothing to compare against is the inert-guard shape this
  // codebase has been bitten by before; the condition it needs is not "do we know
  // the name" but "did this come from the dialog".
  //
  // So an unknown label now REFUSES rather than waves through. That is the honest
  // outcome either way: if the app cannot say which business a reply will appear
  // under, it has no business publishing one, and nobody could have confirmed it
  // meaningfully. The remedy is a reconnect, which repopulates the label — not a
  // send that proceeds on a blank.
  if (!check.business_label) {
    throw new ReplyRefusedError('business_unknown',
      'This cannot be published because the connection does not say which business it would appear '
      + 'under. A reply is public and permanent the moment it is sent, so it is never sent on a blank '
      + 'name. Reconnect the Google Business Profile account and pick the listing again, then retry.');
  }

  if (!sameBusiness(confirm.business || '', check.business_label)) {
    throw new ReplyRefusedError('business_not_named',
      `The confirmation must name the business this will be published as — ${check.business_label}. `
      + 'The reply appears publicly under that name, so the confirm step says it out loud.');
  }

  if (check.is_edit && confirm.overwrite !== true) {
    throw new ReplyRefusedError('overwrite_not_confirmed',
      'A reply is already public on this review. Sending replaces it, and the earlier text was '
      + 'readable by guests for as long as it stood — Google keeps no history of it. Confirm the '
      + 'replacement explicitly.');
  }
}

/* ── The send ─────────────────────────────────────────────────────────────── */

export interface SendReplyResult {
  ok: boolean;
  send_id: string;
  review_id: string;
  review_name: string;
  /** What is now public, as Google echoed it. */
  comment: string;
  /** '' | PENDING | REJECTED | APPROVED | REVIEW_REPLY_STATE_UNSPECIFIED */
  reply_state: string;
  policy_violation: string;
  http_status: number;
  /** TRUE only when Google returned 2xx AND did not say REJECTED. Even then,
   *  PENDING means a human at Google has not looked at it yet. */
  live: boolean;
  replied_at: string;
  is_edit: boolean;
  previous_comment: string;
  /** Our own words about what just happened, for the page to render as-is. */
  note: string;
}

function newSendId(): string {
  return 'grs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

/**
 * Claim the right to send, atomically, or refuse.
 *
 * The partial unique index uq_gr_reply_sends_inflight does the real work: at
 * most one 'sending' row can exist per review, enforced by SQLite rather than by
 * a check in this function. A double-clicked button, two admins on the same
 * review, or two app processes all collide on the index and exactly one wins.
 *
 * A stale claim is demoted to 'unknown' and NOT reused. That is the honest
 * outcome: when a process dies between the insert and the response, we do not
 * know whether the PUT reached Google, and a retry might publish a second reply
 * over a first that already exists. 'unknown' makes that visible.
 */
function claimSend(db: DB, row: {
  id: string; review_id: string; location_key: string; review_name: string;
  comment: string; actor: string; origin: string; acknowledged: string;
  is_edit: number; previous_comment: string; started_at: string;
}): void {
  const cutoff = toIsoUtc(Date.now() - STALE_SENDING_MS);
  db.prepare(
    `UPDATE gr_reply_sends
        SET status = 'unknown',
            error = 'the process was lost mid-send; whether Google received this reply is unknown',
            finished_at = ?
      WHERE review_id = ? AND status = 'sending' AND started_at < ?`,
  ).run(row.started_at, row.review_id, cutoff);

  try {
    db.prepare(
      `INSERT INTO gr_reply_sends
        (id, review_id, location_key, review_name, comment, comment_bytes, actor, origin,
         acknowledged, is_edit, previous_comment, status, started_at)
       VALUES (@id, @review_id, @location_key, @review_name, @comment, @comment_bytes, @actor,
               @origin, @acknowledged, @is_edit, @previous_comment, 'sending', @started_at)`,
    ).run({ ...row, comment_bytes: replyBytes(row.comment) });
  } catch (e: any) {
    if (String(e?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      throw new ReplyRefusedError('send_in_flight',
        'A reply to this review is already being sent. Nothing further has been sent — wait for the '
        + 'first one to finish rather than publishing two replies over each other.');
    }
    throw e;
  }
}

/**
 * Post an owner reply to Google. IRREVERSIBLE ON SUCCESS.
 *
 * Order of operations, and none of it is arbitrary:
 *   1. load the review and re-run the checks HERE (the client's verdict is not
 *      evidence);
 *   2. require the confirmation, including the business name;
 *   3. resolve the resource name, refusing rather than constructing a guess;
 *   4. record the intent to send, with the actor, BEFORE the wire;
 *   5. PUT through the one permitted write shape;
 *   6. record what came back, and mirror Google's own copy onto the review row.
 *
 * `fetchImpl` exists so the suite can prove every branch with a spy. Production
 * passes nothing and the transport uses the real fetch.
 */
export async function sendReviewReply(args: {
  db?: DB;
  reviewId: string;
  comment: string;
  actor: string;
  locationKey?: string;
  origin?: ReplyOrigin;
  confirm: Confirmation;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<SendReplyResult> {
  const db = ensureReviewSchema(args.db || getDb());
  const comment = String(args.comment ?? '');

  const check = checkReply({ db, reviewId: args.reviewId, comment, locationKey: args.locationKey });
  requireConfirmation(check, args.confirm || { public: false });

  if (!check.target) {
    throw new ReplyRefusedError(check.target_error?.code || 'no_target',
      check.target_error?.message || 'There is no Google review to address.');
  }
  const target = check.target;
  const key = args.locationKey === undefined ? check.review.location_key : args.locationKey;
  const startedAt = toIsoUtc(args.now ?? Date.now());
  const sendId = newSendId();

  claimSend(db, {
    id: sendId,
    review_id: check.review.id,
    location_key: key,
    review_name: target.reviewName,
    comment,
    actor: String(args.actor || ''),
    origin: (REPLY_ORIGINS as readonly string[]).includes(String(args.origin)) ? String(args.origin) : 'typed',
    acknowledged: (args.confirm.acknowledged || []).join(','),
    is_edit: check.is_edit ? 1 : 0,
    previous_comment: check.existing_reply,
    started_at: startedAt,
  });

  const finish = (patch: Record<string, any>) => {
    db.prepare(
      `UPDATE gr_reply_sends
          SET status = @status, http_status = @http_status, reply_state = @reply_state,
              policy_violation = @policy_violation, google_update_at = @google_update_at,
              error = @error, finished_at = @finished_at
        WHERE id = @id`,
    ).run({
      id: sendId, status: 'failed', http_status: 0, reply_state: '', policy_violation: '',
      google_update_at: '', error: '', finished_at: toIsoUtc(Date.now()), ...patch,
    });
  };

  /* ── The wire. The token is fetched as late as possible so a refusal to send
   *    never costs a token refresh, and never touches a credential when the
   *    checks were going to stop us anyway. ─────────────────────────────── */
  let res: { ok: boolean; status: number; body: string };
  try {
    const token = await gbpAccessToken(gbpConfig(db, key), { db, locationKey: key, signal: args.signal });
    res = await gbpPutReviewReply({
      reviewName: target.reviewName,
      comment,
      token,
      signal: args.signal,
      fetchImpl: args.fetchImpl,
    });
  } catch (e: any) {
    // A GbpTransportRefusal here means THIS APP refused the request shape — a
    // bug in this file, not a Google problem, and it is recorded as such rather
    // than shown to the owner as "Google said no".
    const own = e instanceof GbpTransportRefusal;
    finish({ status: 'failed', error: String(e?.message || e).slice(0, 900) });
    if (own) {
      throw new ReplyRefusedError('transport_refused',
        'This app refused to send the reply because the request did not match the one write it '
        + 'permits. Nothing was sent to Google. This is a bug in the send path, not a Google error.');
    }
    throw e;
  }

  /* ── What came back. A 2xx IS NOT PROOF THE REPLY IS LIVE. ───────────────
   * Google returns a ReviewReply whose reviewReplyState can be PENDING (waiting
   * on moderation) or REJECTED (with a policyViolation) inside a perfectly
   * successful response. Treating 200 as "published" would tell the owner his
   * reply is on the listing when it may never appear. */
  let parsed: any = null;
  try { parsed = JSON.parse(res.body || 'null'); } catch { /* keep the raw body */ }
  const state = String(parsed?.reviewReplyState || '').trim();
  const violation = String(parsed?.policyViolation || '').trim();
  const echoed = typeof parsed?.comment === 'string' && parsed.comment ? String(parsed.comment) : comment;
  const googleUpdate = String(parsed?.updateTime || '').trim();

  if (!res.ok) {
    let detail = String(res.body || '').slice(0, 400);
    try { detail = parsed?.error?.message || detail; } catch { /* keep the text */ }
    finish({
      status: 'failed', http_status: res.status, reply_state: state, policy_violation: violation,
      error: `HTTP ${res.status}: ${detail}`.slice(0, 900),
    });
    throw new ReplyRefusedError('google_refused',
      `Google refused the reply (HTTP ${res.status}): ${detail}. Nothing is public. `
      + (res.status === 401 || res.status === 403
        ? 'Check that the connected account still manages this listing, and that the listing is verified — '
          + 'Google documents the reply write as valid only for a verified location.'
        : 'The reply was not posted; the text is still here to try again.'));
  }

  const rejected = state === 'REJECTED';

  /* ── Mirror Google's copy onto the review row. ────────────────────────────
   * Only when it is not rejected: writing reply_text for a rejected reply would
   * mark the review "Answered" on the page while the listing shows nothing. */
  let repliedAt = '';
  if (!rejected) {
    // Through the SAME parser the ingest uses, so the value is byte-identical
    // with what the next pull will store and the pull reports "unchanged"
    // instead of counting every send as an edit.
    if (googleUpdate) {
      const ts = parseTimestamp(googleUpdate);
      if (!('error' in ts)) repliedAt = ts.iso;
    }
    if (!repliedAt) repliedAt = toIsoUtc(args.now ?? Date.now());

    const merged = {
      rating: check.review.rating,
      text: check.review.text,
      reply_text: echoed,
      replied_at: repliedAt,
      author_name: check.review.author_name,
      language: check.review.language,
      posted_at: check.review.posted_at,
    };
    // source_updated_at is deliberately absent from this UPDATE. See the header:
    // writing one would let the stale guard refuse Google's own later copy.
    db.prepare(
      `UPDATE gr_reviews SET reply_text = ?, replied_at = ?, content_hash = ? WHERE id = ?`,
    ).run(echoed, repliedAt, contentHash(merged as any), check.review.id);
  }

  finish({
    status: 'sent', http_status: res.status, reply_state: state, policy_violation: violation,
    google_update_at: googleUpdate,
    error: rejected ? `Google rejected the reply at moderation: ${violation || 'no reason given'}` : '',
  });

  const note = rejected
    ? `Google accepted the request but REJECTED the reply at moderation${violation ? ` (${violation})` : ''}. `
      + 'It is not on the listing and the review still shows as unanswered. The text is saved here; '
      + 'rewording and sending again is the only route.'
    : state === 'PENDING'
      ? 'Sent. Google has it but is holding it for moderation, so it may not appear on the listing yet — '
        + 'the next hourly pull will show whether it went live.'
      : 'Sent. It is public on the listing now, under '
        + (target.businessLabel || 'the connected business')
        + ', and Google offers no way to withdraw it.';

  return {
    ok: !rejected,
    send_id: sendId,
    review_id: check.review.id,
    review_name: target.reviewName,
    comment: echoed,
    reply_state: state,
    policy_violation: violation,
    http_status: res.status,
    live: !rejected && state !== 'PENDING',
    replied_at: repliedAt,
    is_edit: check.is_edit,
    previous_comment: check.existing_reply,
    note,
  };
}

/* ── Reading the log back ─────────────────────────────────────────────────── */

export interface ReplySendRow {
  id: string; review_id: string; comment: string; actor: string; origin: string;
  status: string; reply_state: string; policy_violation: string; is_edit: number;
  previous_comment: string; error: string; started_at: string; finished_at: string;
}

/**
 * Every attempt on one review, newest first. The page shows this under a review
 * that has been answered from here, because "who sent that, and was it an edit"
 * is not answerable from the listing.
 *
 * THE `rowid DESC` TIEBREAKER IS LOAD-BEARING, and it is here because the suite
 * caught its absence. started_at comes from toIsoUtc(), which is SECOND
 * precision — "the one storage format. Always seconds, always Z". Two sends
 * inside the same second therefore carry an IDENTICAL started_at, which is not a
 * contrived case at all: it is exactly what happens when an admin posts a reply
 * and immediately fixes a typo in it. Ordering on the timestamp alone made
 * SQLite free to return those two in either order, and the page would then show
 * the superseded text as the most recent one — the wrong answer to "what is on
 * the listing right now" about a write nobody can take back. rowid is insertion
 * order and strictly increasing, so it breaks the tie the way the clock cannot.
 */
export function replySendHistory(dbIn: DB | null, reviewId: string, limit = 10): ReplySendRow[] {
  const db = ensureReviewSchema(dbIn || getDb());
  return db.prepare(
    `SELECT id, review_id, comment, actor, origin, status, reply_state, policy_violation,
            is_edit, previous_comment, error, started_at, finished_at
       FROM gr_reply_sends WHERE review_id = ?
      ORDER BY started_at DESC, rowid DESC LIMIT ?`,
  ).all(String(reviewId || ''), Math.max(1, Math.min(50, limit))) as ReplySendRow[];
}
