/**
 * GOOGLE BUSINESS PROFILE — THE ONE DOOR. Every call to Google's business APIs
 * goes through gbpFetch() in this file, and this file decides what is even
 * expressible.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 * The connector used to be read-only because every call site happened to be a
 * GET. That is a property of the CURRENT CODE, not a rule — one future edit,
 * one copied fetch(), and this module could edit the business's opening hours
 * or delete its photos, with nothing in the way and nobody reviewing for it.
 *
 * The owner has now asked for exactly one write: posting an owner reply to a
 * review. In his words: "only the API can do Reply from us if it allows but
 * other than Reviews it should not do any other action for the Google Account
 * which has the Access."
 *
 * So the read-only-ness stops being an accident and becomes a rule the code
 * enforces on itself. Four (host, method, path) triples are reachable. A fifth
 * shape is not a bug to be found in review — it throws before fetch() is
 * reached, in this process, every time.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE SCOPE DOES NOT PROTECT ANYTHING. THIS FILE DOES.
 * ══════════════════════════════════════════════════════════════════════════
 * READ THIS BEFORE ASSUMING THE TOKEN IS SAFE. Google publishes NO read-only
 * scope for Business Profile. There is one scope —
 *
 *     https://www.googleapis.com/auth/business.manage
 *
 * — and it is the FULL MANAGEMENT scope. The access token this app holds can
 * already, as far as Google is concerned, rewrite the business description,
 * change the phone number and address, upload and delete photos, publish posts,
 * and delete an owner reply. Nothing was narrowed at consent time, because
 * Google offers nothing to narrow. There is no "reviews.readonly".
 *
 * Therefore the ONLY thing standing between that token and a public edit of
 * "Akan Brewing Co" is the code in this file. That is not defence in depth;
 * for everything except the four shapes below, it is the entire defence. Weaken
 * the allowlist and you have not loosened a convenience — you have handed a
 * full-management credential an extra verb against a live public listing.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ONE WRITE, AND WHY IT IS THE ONLY ONE
 * ══════════════════════════════════════════════════════════════════════════
 *     PUT /v4/accounts/{a}/locations/{l}/reviews/{r}/reply
 *
 * A reply is PUBLIC the instant that PUT returns — under the owner's business
 * name, on a listing with five figures of real reviews, and GOOGLE HAS NO UNDO.
 * Same call creates and updates, so editing a reply is this same PUT again;
 * there is no second endpoint to allow for editing.
 *
 * DELETE IS DELIBERATELY NOT ALLOWED, and this is the decision most likely to
 * be revisited by someone who thinks they are adding an undo. They are not.
 *
 *   DELETE /v4/accounts/{a}/locations/{l}/reviews/{r}/reply
 *
 * is ONE PATH CHARACTER away from the permitted PUT — same path, different verb
 * — which is exactly why the allowlist matches the verb and the path AS A PAIR
 * and not the path alone. Removing a reply does not un-publish it: the text was
 * already live, already indexed, already read. It buys nothing that matters and
 * it costs the property that no reachable code path can make anything on that
 * listing disappear. If DELETE is ever added, say so loudly in the commit
 * message and on the page — do not let it arrive as a tidy-up.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES NOT COVER, ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════════
 * The OAuth identity endpoints in ./oauth.ts — token exchange, refresh, revoke,
 * userinfo — are NOT routed through here and must not be. They are legitimately
 * POST, they live on oauth2.googleapis.com and www.googleapis.com, and they
 * touch no business data. A choke point that refused non-GET across all of
 * *.googleapis.com would break token refresh and take the read path down with
 * it. So the host allowlist below names the three mybusiness* hosts
 * specifically rather than matching googleapis.com.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE FLOOR IS ENFORCED, NOT TRUSTED — and it is tested two ways
 * ══════════════════════════════════════════════════════════════════════════
 * This project has a documented pattern (project_fnb_inert_guards) of guards
 * that read correctly and never fire: an empty settings row, a key nothing
 * writes, a function nobody calls. A code read of this file proves nothing. So
 * scripts/reviews-tests.js section O does both halves:
 *
 *   1. It drives gbpFetch() with an injected fetchImpl spy and asserts, for
 *      each refused shape, that the spy was called ZERO times — the refusal
 *      happens before the wire, and the assertion is on the spy, never on the
 *      network. No test in this repo may call Google's real host.
 *   2. It greps src/ and FAILS if the string "mybusiness" appears in any file
 *      other than this one. Without that second half the choke point is a
 *      convention: any future file could fetch() the host directly and bypass
 *      it entirely. The host constants therefore live here and are imported
 *      from here — naming the host anywhere else breaks the build's test gate.
 *
 * NOTHING IN THIS FILE HAS BEEN EXERCISED AGAINST GOOGLE'S REPLY ENDPOINT. The
 * refusals are proven; the permitted PUT is proven only up to the point of
 * calling the injected spy with the right method, URL and body. Whether Google
 * accepts that body, and what it returns, is UNPROVEN — see UNPROVEN in
 * ./sources-gbp.ts. Proving it means publishing a real reply on a real listing,
 * which is the owner's call to make with his own words, not a test.
 */

/* ── The three hosts, and the only place they are named ───────────────────── */

/** Reviews (and the reply write) sit on the LEGACY My Business v4 surface. */
export const GBP_REVIEWS_HOST = 'https://mybusiness.googleapis.com/v4';
/** Account discovery — Account Management v1. */
export const GBP_ACCOUNTS_HOST = 'https://mybusinessaccountmanagement.googleapis.com/v1';
/** Location discovery — Business Information v1. */
export const GBP_INFO_HOST = 'https://mybusinessbusinessinformation.googleapis.com/v1';

const REVIEWS_HOSTNAME = 'mybusiness.googleapis.com';
const ACCOUNTS_HOSTNAME = 'mybusinessaccountmanagement.googleapis.com';
const INFO_HOSTNAME = 'mybusinessbusinessinformation.googleapis.com';

/**
 * Google's documented maximum for a reply's `comment`: 4096 BYTES, not
 * characters. The distinction is not pedantry — an emoji is four bytes and a
 * Devanagari or Telugu character is three, so a reply that counts 3,000
 * "characters" in a textarea can be over the limit on the wire. Enforced here
 * as a FLOOR (the last thing before the wire, so no future caller can skip it),
 * NOT as the user-facing validation: a refusal from this file is a developer
 * error with an ugly message, whereas the admin typing a reply deserves a live
 * byte counter and a sentence in English. The send path must check it too.
 */
export const GBP_REPLY_MAX_BYTES = 4096;

/* ── The allowlist ────────────────────────────────────────────────────────── */

/**
 * (host, method, path) TRIPLES. The method and the path are matched as a PAIR,
 * which is the whole point: DELETE and PUT differ only in the verb on the reply
 * path, and PATCH on an INFO_HOST location path is how the business's name and
 * address would be rewritten.
 *
 * Path patterns match URL.pathname, which excludes the query string — so
 * pageSize, pageToken and readMask cannot widen a shape.
 *
 * Id segments are `[^/]+`: slashless, so the NUMBER of segments is pinned and a
 * value cannot smuggle in extra path. Deliberately not a tighter character
 * class — an id charset guess that is too strict refuses a legitimate review
 * (a reply that will not send, which is loud and recoverable), while the danger
 * direction, reaching a DIFFERENT endpoint, is already closed by the pinned
 * segment count. Percent-encoding is refused outright below so `%2F` cannot
 * become a slash after Google decodes it.
 */
interface GbpRoute {
  host: string;
  method: 'GET' | 'PUT';
  path: RegExp;
  /** Plain English, used in the refusal message so a developer sees the menu. */
  what: string;
}

const ALLOWED_ROUTES: readonly GbpRoute[] = [
  {
    host: ACCOUNTS_HOSTNAME,
    method: 'GET',
    path: /^\/v1\/accounts$/,
    what: 'GET the list of Business Profile accounts',
  },
  {
    host: INFO_HOSTNAME,
    method: 'GET',
    path: /^\/v1\/accounts\/[^/]+\/locations$/,
    what: "GET the list of an account's locations",
  },
  {
    host: REVIEWS_HOSTNAME,
    method: 'GET',
    path: /^\/v4\/accounts\/[^/]+\/locations\/[^/]+\/reviews$/,
    what: "GET a page of a location's reviews",
  },
  {
    // ── THE ONE WRITE. Read the header before touching this entry. ──
    host: REVIEWS_HOSTNAME,
    method: 'PUT',
    path: /^\/v4\/accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+\/reply$/,
    what: 'PUT an owner reply on one review (creates or overwrites; PUBLIC immediately)',
  },
];

const ALLOWED_HOSTNAMES: readonly string[] = [REVIEWS_HOSTNAME, ACCOUNTS_HOSTNAME, INFO_HOSTNAME];

/** The menu, for refusal messages. Built once; never interpolates caller input. */
const ROUTE_MENU = ALLOWED_ROUTES.map(r => `  ${r.method} ${r.host}${r.path.source} — ${r.what}`).join('\n');

/**
 * A REFUSAL BY THIS APP, not by Google. Its own class so it can never be
 * mistaken for a network failure and quietly retried: retrying it will refuse
 * again, because the request shape itself is not permitted. If you are reading
 * one of these in a log, some code tried to reach an endpoint that this app has
 * decided it does not have.
 */
export class GbpTransportRefusal extends Error {
  readonly attempted: string;
  constructor(reason: string, attempted: string) {
    super(
      `Refused by this app before contacting Google: ${reason}\n`
      + `Attempted: ${attempted}\n`
      + `The only permitted calls are:\n${ROUTE_MENU}\n`
      + 'This is enforced in src/lib/reviews/gbp-transport.ts. The Google token holds the FULL '
      + 'business.manage scope (Google publishes no read-only scope), so this allowlist is what '
      + 'stops an edit to the public listing — widening it is a decision about a real business, '
      + 'not a code cleanup.',
    );
    this.name = 'GbpTransportRefusal';
    this.attempted = attempted;
  }
}

/* ── The door ─────────────────────────────────────────────────────────────── */

export interface GbpFetchArgs {
  method: 'GET' | 'PUT';
  url: string;
  token: string;
  /** JSON body. Required for the PUT, refused on a GET. */
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Test seam. The suite injects a spy and asserts it was NEVER CALLED for a
   * refused shape — which is the only honest way to prove the guard fires
   * without a request leaving the machine. Production passes nothing.
   */
  fetchImpl?: typeof fetch;
}

/**
 * What every call site gets back, whether Google said yes or no.
 *
 * gbpFetch does NOT throw on an HTTP error, deliberately. Both existing callers
 * need the raw status and body to do their own thing with it — googleGet runs
 * classifyGoogleRefusal() over the body to tell four different 403s apart, and
 * gbpCollect uses a 401 to trigger its once-only refresh-and-retry of the same
 * page. The reply path will need it too: a 2xx does NOT mean a reply is live,
 * because Google returns reviewReplyState PENDING or REJECTED inside the body
 * of a successful response. Throwing here would have forced all three to
 * reconstruct the status from an error string.
 *
 * So: a thrown error from gbpFetch means THIS APP refused the shape. A non-ok
 * result means GOOGLE refused the request. They are different events and the
 * types keep them apart.
 */
export interface GbpResponse {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * The single door to Google's business APIs. Throws GbpTransportRefusal, before
 * any network call, for anything outside the allowlist above.
 */
export async function gbpFetch(args: GbpFetchArgs): Promise<GbpResponse> {
  const rawMethod = String(args.method ?? '');
  // Compare the UPPERCASED method and then SEND that same uppercased string.
  // Validating one value and transmitting another is how an allowlist gets
  // bypassed by casing ('delete' is normalised to DELETE by fetch itself).
  const method = rawMethod.trim().toUpperCase();
  const rawUrl = String(args.url ?? '');
  const attempted = `${method || '(no method)'} ${rawUrl || '(no url)'}`;

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new GbpTransportRefusal('the URL could not be parsed.', attempted);
  }

  if (u.protocol !== 'https:') {
    throw new GbpTransportRefusal(
      `the protocol is ${u.protocol} and only https: is permitted — a downgrade would put the `
      + 'access token on the wire in plaintext.',
      attempted,
    );
  }
  if (u.username || u.password) {
    throw new GbpTransportRefusal('the URL carries embedded credentials.', attempted);
  }
  if (!ALLOWED_HOSTNAMES.includes(u.hostname)) {
    throw new GbpTransportRefusal(
      `${u.hostname} is not one of Google's three Business Profile hosts. (The OAuth identity `
      + 'endpoints are legitimately POST and are deliberately NOT routed through here — see '
      + './oauth.ts.)',
      attempted,
    );
  }
  // %2F survives URL.pathname un-decoded, so without this an id segment could
  // become extra path once Google decodes it. None of the four permitted shapes
  // needs percent-encoding: account, location and review ids are unreserved.
  if (u.pathname.includes('%')) {
    throw new GbpTransportRefusal('the path contains percent-encoding, which no permitted call needs.', attempted);
  }

  const route = ALLOWED_ROUTES.find(r => r.host === u.hostname && r.method === method && r.path.test(u.pathname));
  if (!route) {
    // Name the near-miss, because the two dangerous mistakes both look like
    // typos: right path + wrong verb (DELETE a reply), and right verb + wrong
    // path (PATCH a location).
    const sameShape = ALLOWED_ROUTES.filter(r => r.host === u.hostname && r.path.test(u.pathname));
    const hint = sameShape.length
      ? ` The path is permitted, but only with ${sameShape.map(r => r.method).join('/')} — not ${method || '(no method)'}.`
      : '';
    throw new GbpTransportRefusal(
      `no permitted call matches this host, method and path together.${hint}`,
      attempted,
    );
  }

  const hasBody = args.body !== undefined && args.body !== null;
  if (method === 'GET' && hasBody) {
    throw new GbpTransportRefusal('a GET was given a request body.', attempted);
  }
  let payload: string | undefined;
  if (method === 'PUT') {
    if (!hasBody) {
      // A bodiless PUT to /reply is not a no-op to guess at; refuse rather than
      // send an empty comment to a public listing.
      throw new GbpTransportRefusal('the reply PUT was given no body.', attempted);
    }
    payload = JSON.stringify(args.body);
    // TextEncoder, not Buffer.byteLength: this file imports NOTHING and uses no
    // Node-only global, so webpack's edge pass has nothing to follow and nothing
    // to resolve. That matters here specifically — `next dev` runs webpack on
    // this repo while `next build` runs turbopack, and that split has already
    // produced one blocking "Can't resolve" overlay on a green build.
    const bytes = new TextEncoder().encode(payload).length;
    if (bytes > GBP_REPLY_MAX_BYTES) {
      throw new GbpTransportRefusal(
        `the reply body is ${bytes} bytes and Google's limit is ${GBP_REPLY_MAX_BYTES} BYTES `
        + '(not characters). The send path should have caught this and said so in English.',
        attempted,
      );
    }
  }

  const doFetch = args.fetchImpl ?? fetch;
  const res = await doFetch(u.toString(), {
    method,
    headers: payload === undefined
      ? { Authorization: `Bearer ${args.token}` }
      : { Authorization: `Bearer ${args.token}`, 'Content-Type': 'application/json' },
    ...(payload === undefined ? {} : { body: payload }),
    signal: args.signal,
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

/**
 * The permitted write, as a named function so no caller has to hand-build the
 * URL — and so `grep gbpPutReviewReply` finds every place a public reply can be
 * posted from. Nothing calls this yet; the send path (admin-only, three checks
 * before submit) is a separate commit.
 *
 * `reviewName` is Google's own review resource name:
 *     accounts/{account}/locations/{location}/reviews/{review}
 *
 * Returns Google's raw response. A 2xx is NOT proof the reply is live — read
 * reviewReplyState in the body, which can come back PENDING or REJECTED (with
 * policyViolation) inside a perfectly successful response.
 *
 * UNPROVEN against Google. See the file header.
 */
export async function gbpPutReviewReply(args: {
  reviewName: string;
  comment: string;
  token: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<GbpResponse> {
  const name = String(args.reviewName ?? '').replace(/^\/+|\/+$/g, '');
  return gbpFetch({
    method: 'PUT',
    url: `${GBP_REVIEWS_HOST}/${name}/reply`,
    token: args.token,
    body: { comment: args.comment },
    signal: args.signal,
    fetchImpl: args.fetchImpl,
  });
}
