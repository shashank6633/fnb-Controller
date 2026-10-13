/**
 * OWNER REPLY — CHECK 2 OF 3: THE AUTOMATIC ONE.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR
 * ══════════════════════════════════════════════════════════════════════════
 * The owner asked for "2-3 checks before Submiting to google so can check any
 * mistakes before submitting to google". The three are:
 *
 *   1. PREVIEW  — the exact words, shown beside the review being answered.
 *                 A screen, not code. It lives in the page.
 *   2. VALIDATE — this file. Automatic, and it must be REAL: every failure
 *                 names itself, because "invalid" tells an admin nothing about
 *                 what to fix at the moment he is about to publish.
 *   3. CONFIRM  — an explicit final step naming the business publicly. The
 *                 route enforces it; the page words it.
 *
 * Those three checks are the ONLY undo that exists. A reply is public the
 * instant Google's PUT returns, under the business's own name, on a listing with
 * five figures of real reviews, and Google offers no way to take it back. There
 * is no draft state, no scheduled publish, no 30-second window. Whatever passes
 * here is what future guests read.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PURE ON PURPOSE — and why that matters for honesty, not just tidiness
 * ══════════════════════════════════════════════════════════════════════════
 * No database, no network, no `getDb()`. Two consequences, both deliberate:
 *
 *   • The BROWSER runs exactly this code to draw the findings, and the ROUTE
 *     runs exactly this code to decide whether to send. One implementation, so
 *     the list an admin reads is the list the server enforced. A second copy in
 *     the page would eventually disagree with this one, and the disagreement
 *     would surface as a reply that looked validated and was not.
 *   • It is testable without a fixture and without a credential.
 *
 * The SERVER IS THE AUTHORITY regardless. The page is a convenience; the route
 * re-runs this and refuses on its own verdict, so a hand-rolled POST that skips
 * the page cannot skip the checks.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BLOCKING vs WARNING — where the line is, and why it is drawn there
 * ══════════════════════════════════════════════════════════════════════════
 * BLOCKING is reserved for things that are wrong no matter who typed them and
 * no matter what they meant: nothing to post, over Google's hard limit, a
 * leftover placeholder, the wrong guest's name, or the guest's own phone number
 * or email echoed back onto a public page.
 *
 * Everything that is a JUDGEMENT is a WARNING, and a warning must be
 * acknowledged one by one before the send route will accept it. That split is
 * not timidity. This app belongs to the owner: if he chooses to write "your
 * next visit is on us", a tool that silently refuses to publish his own words
 * is broken. What it may do — and does — is make sure he cannot publish that by
 * ACCIDENT, and cannot publish it because a language model invented it.
 *
 * The distinction matters most for the AI drafts. A model asked to win a guest
 * back will reach for a free dessert, because that is what the internet's
 * replies do. Nothing stops it inventing one except a check that fires on the
 * finished text — a prompt instruction is a wish, and this project has a
 * documented history (project_fnb_inert_guards) of guards that read correctly
 * and never fire. So the compensation check runs over whatever is about to be
 * sent, typed or drafted, and the admin has to say yes to it in words.
 */

import { GBP_REPLY_MAX_BYTES } from './gbp-transport';

export { GBP_REPLY_MAX_BYTES };

/* ── Findings ─────────────────────────────────────────────────────────────── */

/**
 * Every code is a distinct, nameable mistake. Do NOT collapse two of these into
 * one because the messages look similar: the code is what the page renders a
 * specific sentence for, and "invalid" at the moment of publishing is useless.
 */
export type ReplyFindingCode =
  /* ── blocking ── */
  | 'empty'                   // nothing to post
  | 'too_long'                // over Google's 4096 BYTES
  | 'placeholder'             // [name], XXX, TODO, lorem — a draft escaped
  | 'wrong_guest_name'        // greets a name that is not this guest's
  | 'name_for_anonymous'      // greets a name when Google gave us none
  | 'echoes_guest_contact'    // the guest's own phone/email, back on a public page
  /* ── warnings, each acknowledged separately ── */
  | 'compensation_offer'      // a free meal / discount / comp = a PUBLIC PROMISE
  | 'disputes_guest'          // argues with, blames or corrects the guest
  | 'asks_for_rating'         // mentions stars/ratings/reviews as a favour
  | 'language_mismatch'       // guest wrote in another script
  | 'corporate_filler'        // "we value your feedback", "we strive to"
  | 'generic_reply'           // answers nothing the guest actually said
  | 'emoji_added'             // emoji the guest did not use
  | 'exclamation_spray'       // !!!
  | 'signed_by_a_person'      // a name the model invented, signed publicly
  | 'contact_in_public_reply' // our own phone/email, public forever
  | 'near_duplicate'          // near-identical to one sent recently
  | 'repeated_opening';       // same opening words as a recent reply

export interface ReplyFinding {
  code: ReplyFindingCode;
  /** Blocking findings cannot be acknowledged away. Warnings must be. */
  severity: 'blocking' | 'warning';
  /** Short, for a chip. */
  label: string;
  /** One sentence for the admin, naming what to change. */
  detail: string;
}

export interface ReplyValidationInput {
  /** The exact text that would be sent. Not trimmed for you — leading blank
   *  lines are a real thing a paste produces, and the byte count must be the
   *  count of what actually goes on the wire. */
  comment: string;
  /** The review being answered. Everything here comes off the stored row. */
  review: {
    text: string;
    rating?: number;
    author_name?: string;
    author_is_anonymous?: boolean;
    language?: string;
  };
  /** Replies sent recently, newest first, for the variety checks. Supplied by
   *  the caller because reading them is a database question and this file has
   *  no database. Omit and those two checks simply do not run. */
  recentReplies?: string[];
}

export interface ReplyValidation {
  /** True only when nothing BLOCKING fired. Warnings do not clear this flag —
   *  they are cleared by acknowledgement, which is the route's business. */
  ok: boolean;
  blocking: ReplyFinding[];
  warnings: ReplyFinding[];
  /** What the counter on screen shows. Bytes is the one Google enforces. */
  bytes: number;
  chars: number;
  bytes_remaining: number;
}

/* ── Byte length: the measurement Google actually applies ─────────────────── */

/**
 * Google's limit on a reply's `comment` is 4096 BYTES, not characters.
 *
 * This is not pedantry and it is not theoretical for this venue: a Telugu
 * character is three bytes and an emoji is four, so a reply that a textarea
 * counts as 1,700 characters can be 5,100 bytes and be refused by Google after
 * the admin has already pressed the button. Counting bytes on screen is the
 * difference between a live counter that is right and one that lies at the
 * worst moment.
 *
 * TextEncoder, not Buffer.byteLength: this module is imported by a CLIENT
 * component, and Buffer would drag a Node polyfill into the browser bundle.
 */
export function replyBytes(s: string): number {
  return new TextEncoder().encode(String(s ?? '')).length;
}

/* ── Patterns ─────────────────────────────────────────────────────────────── */

/** A draft that escaped. Each of these has been seen in a real published
 *  owner reply somewhere on the internet, which is why they are checked. */
const PLACEHOLDERS: Array<{ re: RegExp; what: string }> = [
  { re: /\[[^\]\n]{1,40}\]/, what: 'a [square-bracket] placeholder' },
  { re: /\{\{?[^}\n]{1,40}\}?\}/, what: 'a {curly-brace} placeholder' },
  { re: /<[A-Za-z_ ]{2,30}>/, what: 'an <angle-bracket> placeholder' },
  { re: /\bX{3,}\b/i, what: 'XXX' },
  { re: /\bTODO\b/i, what: 'TODO' },
  { re: /\bTBD\b/i, what: 'TBD' },
  { re: /\bFIXME\b/i, what: 'FIXME' },
  { re: /lorem ipsum/i, what: 'lorem ipsum' },
  { re: /\binsert (?:name|dish|detail|item|here)\b/i, what: 'an "insert …" instruction' },
  { re: /\byour name here\b/i, what: '"your name here"' },
  { re: /\b(?:guest|customer)[ _-]?name\b/i, what: 'the words "guest name" instead of a name' },
];

/**
 * A COMPENSATION OFFER IS A PUBLIC PROMISE THE RESTAURANT THEN HAS TO HONOUR.
 *
 * The owner's instruction is explicit: never invent a remedy the restaurant has
 * not agreed to — no free meals, no discounts, no comped drinks, no "your next
 * visit is on us" unless he typed it himself. He can type it; the model may not
 * slip it in. Warned, never silently blocked, and acknowledged in words.
 */
/* "ON US" IS TWO DIFFERENT SENTENCES AND ONLY ONE OF THEM IS AN OFFER.
 *
 *   "the next round is on us"            -> offers something. A public promise.
 *   "how we staff that is on us"         -> accepts blame. The opposite.
 *   "the AC being off is on us"          -> accepts blame.
 *
 * A bare /\bon us\b/ flagged both, so the two best drafts this app produced were
 * warned for taking responsibility well — which is the single behaviour the
 * owner's brief asks for most ("acknowledge it plainly without arguing"). That
 * matters more than a tidy regex: a warning that fires on honest prose teaches
 * the owner to click past warnings, and the next one past is the real one.
 *
 * So an offer now needs something CONSUMABLE OR BILLABLE named near it. Blame
 * attaches to a clause or a demonstrative ("that", "this", "what happened"),
 * never to a dessert. Where the subject is genuinely ambiguous this stays
 * SILENT: the rest of this list still catches "free", "complimentary", "comped",
 * "discount", "refund", "no charge", "we'll pay" and "next visit is on us", so
 * a real offer has to evade every one of them, not just this one. */
/** The sentence containing "on us" / "on the house", or '' if there is none. */
function onUsSentence(s: string): string {
  for (const part of String(s || '').split(/(?<=[.?!\n])/)) {
    if (/\bon (?:us|the house)\b/i.test(part)) return part;
  }
  return '';
}

/** A FORWARD-LOOKING marker. An offer points at a future visit; blame points at
 *  what already happened. "the dry biryani was on us next time" is an offer and
 *  names a dish this list could never enumerate — an Indian menu is not
 *  "dessert, starter, course" — so the tense carries what a noun list cannot. */
const ON_US_FUTURE = /\b(?:next time|next visit|next round|next meal|next one|your next|come back|comes back|coming back|return visit|on your return|when you(?:'re| are)? (?:back|next)|tonight|future visit)\b/i;

/** Named consumables, as a second route in for an offer with no tense marker
 *  ("dinner on the house"). Deliberately short — ON_US_FUTURE does the work. */
const ON_US_CONSUMABLE = /\b(?:meal|meals|dinner|lunch|brunch|breakfast|drink|drinks|round|rounds|bill|tab|dessert|sweet|starter|course|coffee|chai|tea|beer|wine|cocktail|bottle|food|dish|dishes|plate|platter)\b/i;

/** Blame, not an offer: the thing that is "on us" is a fault, not a dish. */
const ON_US_BLAME = /\b(?:that|this|it|these|those|which|everything|all of (?:that|this|it)|the (?:delay|wait|mistake|mix[- ]?up|error|failing|lapse))\b[^.?!\n]{0,40}?\bis on us\b|\bon us\b[^.?!\n]{0,20}?\b(?:to (?:fix|put right|sort|own)|not on you)\b/i;

function offersOnUs(comment: string): boolean {
  const sentence = onUsSentence(comment);
  if (!sentence) return false;
  // Blame wins when nothing forward-looking is present. "how we staff that is
  // on us" and "the AC being off is on us" accept responsibility; flagging them
  // as a compensation offer warned the owner for doing the one thing his brief
  // asks for most, and a warning that fires on honest prose is how the real one
  // gets clicked past.
  if (ON_US_BLAME.test(sentence) && !ON_US_FUTURE.test(sentence)) return false;
  return ON_US_FUTURE.test(sentence) || ON_US_CONSUMABLE.test(sentence);
}

/* An entry is either a pattern or a predicate. "on us" needed a predicate:
 * whether it is an offer or an admission of fault depends on the rest of the
 * sentence, which a single regex cannot read without flagging honest prose. */
const COMPENSATION: Array<{ re?: RegExp; fn?: (s: string) => boolean; what: string }> = [
  { fn: offersOnUs, what: '"on us" / "on the house"' },
  { re: /\bfree\s+(?:meal|dish|drink|dessert|starter|round|appetiser|appetizer|coffee|beer|food|plate)/i, what: 'a free item' },
  /* "your next dessert is free" — the SAME offer with the words the other way
   * round. Missed by the pattern above until a test caught it, and it is the
   * likeliest phrasing a model reaches for, so it is matched in both directions
   * now. An offer is an offer whichever end of the sentence it sits at. */
  /* "on us" / "on the house" are NOT listed here any more — they moved to
   * offersOnUs() above, which reads the whole sentence. Left in this pattern
   * they re-flagged "the AC being off is on us" through a second door, so fixing
   * only the first one would have changed nothing the owner could see. */
  { re: /\b(?:is|are|will be|it'?s)\s+(?:completely\s+|totally\s+|absolutely\s+)?(?:free|complimentary)\b/i, what: 'something offered free' },
  { re: /\bfree of (?:charge|cost)\b/i, what: '"free of charge"' },
  { re: /\bcomplimentary\b/i, what: '"complimentary"' },
  { re: /\bcomped?\b/i, what: '"comp" / "comped"' },
  { re: /\b(?:discount|voucher|coupon|refund|reimburse\w*|cashback)\b/i, what: 'a discount, voucher or refund' },
  { re: /\d{1,3}\s*%\s*(?:off|discount)/i, what: 'a percentage off' },
  { re: /\bno charge\b/i, what: '"no charge"' },
  { re: /\bwa?ive\w*\s+(?:the\s+)?(?:bill|charge|cost|fee)/i, what: 'waiving a charge' },
  { re: /\bwon'?t\s+(?:be\s+)?charge\w*\b/i, what: '"we won\'t charge you"' },
  { re: /\bwe(?:'| wi)ll (?:pay|cover|make it up)\b/i, what: 'an offer to pay or make it up' },
  { re: /\bnext (?:visit|meal|time|round|one) (?:is |will be )?(?:on|free)\b/i, what: '"next visit is on us"' },
];

/** Arguing with a guest in public loses the argument in front of everyone who
 *  reads it later. The owner's rule: never dispute, never blame, never imply
 *  they misremembered. */
const DISPUTES: Array<{ re: RegExp; what: string }> = [
  { re: /\b(?:that|this) (?:is|isn't|is not) (?:not )?(?:true|correct|accurate)\b/i, what: 'calling the account untrue' },
  { re: /\byou(?:'re| are) (?:mistaken|wrong|confused)\b/i, what: 'telling the guest they are wrong' },
  { re: /\bnever happened\b/i, what: '"never happened"' },
  { re: /\bdid not happen\b/i, what: '"did not happen"' },
  { re: /\bwe disagree\b/i, what: '"we disagree"' },
  { re: /\byou (?:must have|may have|might have) (?:mis\w+|forgotten|confused)/i, what: 'suggesting the guest misremembered' },
  { re: /\byour (?:own )?fault\b/i, what: 'blaming the guest' },
  { re: /\bas (?:you were|we) (?:told|informed)\b/i, what: '"as you were told"' },
  { re: /\bfake (?:review|rating)\b/i, what: 'calling the review fake' },
  { re: /\bwe have no record\b/i, what: '"we have no record"' },
];

/** Never ask for a better rating, and never mention stars or reviews as a
 *  favour. Google's own reply policy forbids soliciting, and it reads as
 *  begging to every other guest scrolling the listing. */
const RATING_BEGS: Array<{ re: RegExp; what: string }> = [
  { re: /\b(?:update|change|revise|reconsider|raise|increase)\s+(?:your\s+)?(?:review|rating|star)/i, what: 'asking to change the rating' },
  { re: /\b(?:five|5)[\s-]*stars?\b/i, what: 'mentioning five stars' },
  /* MUST NAME A REVIEW OR A RATING. This pattern used to be a bare
   * "give/leave us a", which fired on "give us another chance" and "give us
   * another try" — the return-visit invitation this entire feature exists to
   * produce. A check that warns on the thing it is meant to encourage gets
   * ignored, and then so do the checks next to it. */
  { re: /\b(?:give|leave|write|post|drop)\b[^.!?\n]{0,30}\b(?:review|rating)\b/i, what: 'asking for a review' },
  { re: /\bremove\s+(?:your\s+)?(?:review|rating)\b/i, what: 'asking to remove the review' },
  { re: /\bif you (?:could|can) (?:update|change)\b[^.!?\n]{0,30}\b(?:review|rating|star)/i, what: 'asking to change the rating' },
];

/** Corporate filler. The owner named two of these himself. They say nothing,
 *  they are what every automated reply says, and a listing full of them reads
 *  as bot-written — which costs more trust than the replies earn. */
const FILLER: Array<{ re: RegExp; what: string }> = [
  { re: /\bwe value your (?:feedback|input|opinion)\b/i, what: '"we value your feedback"' },
  { re: /\bwe strive to\b/i, what: '"we strive to"' },
  { re: /\bthank you for your (?:valuable )?feedback\b/i, what: '"thank you for your feedback"' },
  { re: /\byour feedback is (?:important|valuable)\b/i, what: '"your feedback is important"' },
  { re: /\bwe (?:are |)committed to (?:providing|delivering)\b/i, what: '"we are committed to providing"' },
  { re: /\bat our establishment\b/i, what: '"at our establishment"' },
  { re: /\bwe apologi[sz]e for any inconvenience\b/i, what: '"we apologise for any inconvenience"' },
  { re: /\brest assured\b/i, what: '"rest assured"' },
  { re: /\bvalued (?:guest|customer|patron)\b/i, what: '"valued guest"' },
  { re: /\bdear valued\b/i, what: '"dear valued"' },
];

/** Words after a greeting that are not a name, so "Hi there" is not read as a
 *  guest called There. */
const NOT_A_NAME = new Set([
  'there', 'all', 'everyone', 'team', 'guest', 'guests', 'friend', 'friends',
  'sir', 'madam', "ma'am", 'maam', 'folks', 'again', 'and', 'thank', 'thanks',
  'you', 'so', 'much', 'to', 'for', 'we', 'i', 'it', 'that', 'this', 'from',
  // Sentence openers that share the bare-vocative shape "<Word>, ...". Without
  // these VOCATIVE_RE would read the first word of "Honestly, the AC being off
  // is on us" as a guest's name and block an honest reply. Keep this list ahead
  // of the regex: a false block trains the owner to distrust every check.
  'yes', 'no', 'sorry', 'apologies', 'honestly', 'frankly', 'truthfully',
  'first', 'firstly', 'second', 'secondly', 'finally', 'look', 'right', 'ok',
  'okay', 'well', 'but', 'however', 'still', 'actually', 'unfortunately',
  'sadly', 'genuinely', 'truly', 'absolutely', 'completely', 'understood',
  'noted', 'agreed', 'fair', 'true', 'dear', 'hi', 'hello', 'hey', 'namaste',
]);

/** Words too common to count as "answering what they actually said". */
const STOPWORDS = new Set([
  'the', 'and', 'was', 'were', 'have', 'has', 'had', 'that', 'this', 'with',
  'for', 'you', 'your', 'our', 'their', 'they', 'them', 'there', 'here', 'but',
  'not', 'are', 'from', 'very', 'just', 'also', 'been', 'into', 'over', 'when',
  'what', 'which', 'would', 'could', 'should', 'about', 'after', 'before',
  'than', 'then', 'some', 'more', 'most', 'much', 'many', 'will', 'can', 'did',
  'get', 'got', 'one', 'all', 'out', 'who', 'how', 'why', 'good', 'nice',
  'place', 'time', 'like', 'went', 'came', 'made', 'make', 'really', 'again',
  'thank', 'thanks', 'please', 'sorry', 'visit', 'back', 'hope', 'see', 'soon',
]);

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F900}-\u{1F9FF}]/u;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g;
/** Ten or more digits in one run of digits and separators. Deliberately NOT a
 *  strict phone format — a guest's number can be written a dozen ways — and
 *  deliberately long enough that "40 minutes" and "2 hours" are not swept up. */
const PHONEISH_RE = /\+?\d[\d\s().-]{7,}\d/g;
/** A sign-off line: "— Rahul" or "- Rahul, Manager". */
const SIGNOFF_RE = /(?:^|\n)[ \t]*[-–—]{1,2}[ \t]*([\p{Lu}][\p{L}]+)(?:[ \t]*[,|][ \t]*(?:manager|owner|gm|general manager|team lead|host))?[ \t]*$/u;
const GREETING_RE = /^\s*(?:hi|hello|hey|hii+|dear|dearest|namaste|namaskaram)\b[\s,]*([\p{L}][\p{L}.'-]*)/iu;

/* A BARE VOCATIVE IS A GREETING TOO — "Varun, I'm not going to dress this up."
 *
 * GREETING_RE above only fires after an explicit greeting word, so for a while
 * both blocking name checks were asleep on the single most likely opening this
 * app produces. The draft prompt tells the model to vary its openings and never
 * to sound like a template, which steers it straight at the bare vocative; the
 * owner's own 2,177 published replies all open "Dear <Name>," which is exactly
 * what it is told to avoid. So the guard covered the shape we do not write and
 * missed the shape we do: a reply addressing the WRONG guest by name, or naming
 * an anonymous reviewer, sailed through.
 *
 * Deliberately narrow, because a false block is worse than no block here — it
 * would refuse honest prose and train the owner to distrust the checks. It fires
 * only on a leading capitalised word immediately followed by a comma or dash,
 * which is a vocative and almost nothing else. NOT_A_NAME carries the sentence
 * openers that share that shape ("Honestly, ...", "Yes, ...", "Sorry, ..."). A
 * reply opening with a lowercase word, or with no comma, is not matched at all. */
const VOCATIVE_RE = /^\s*(\p{Lu}[\p{L}.'-]*)\s*[,—–-]/u;

/* ── Small helpers ────────────────────────────────────────────────────────── */

function words(s: string): string[] {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
}

function phoneLikes(s: string): string[] {
  const out: string[] = [];
  for (const m of String(s || '').matchAll(PHONEISH_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 10) out.push(digits);
  }
  return out;
}

function emails(s: string): string[] {
  return (String(s || '').match(EMAIL_RE) || []).map(e => e.toLowerCase());
}

/** Which script the text is mostly in. Latin covers transliterated Telugu and
 *  Hindi, which is why a mismatch here is only ever a WARNING. */
export function dominantScript(s: string): 'latin' | 'telugu' | 'devanagari' | 'other' | 'none' {
  const t = String(s || '');
  let latin = 0, telugu = 0, deva = 0, other = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
    else if (c >= 0x0c00 && c <= 0x0c7f) telugu++;
    else if (c >= 0x0900 && c <= 0x097f) deva++;
    else if (c > 0x024f && !/\s|\p{N}|\p{P}|\p{S}/u.test(ch)) other++;
  }
  const total = latin + telugu + deva + other;
  if (total < 8) return 'none';
  const max = Math.max(latin, telugu, deva, other);
  if (max / total < 0.5) return 'other';
  if (max === telugu) return 'telugu';
  if (max === deva) return 'devanagari';
  if (max === latin) return 'latin';
  return 'other';
}

const SCRIPT_LABEL: Record<string, string> = {
  telugu: 'Telugu', devanagari: 'Hindi / Devanagari', latin: 'English (Latin script)', other: 'another script',
};

/** Word-set overlap, 0..1. Good enough to spot "the same reply again" without
 *  pulling in a similarity library for one check. */
export function replySimilarity(a: string, b: string): number {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

/** The first few words, normalised. "Thank you for your feedback" under five
 *  thousand reviews is the thing that makes a listing read as bot-written. */
export function replyOpening(s: string, n = 5): string {
  return words(s).slice(0, n).join(' ');
}

/** The name a greeting claims, or '' when the reply does not greet anybody. */
export function greetedName(comment: string): string {
  const s = String(comment || '');
  // An explicit greeting first, then the bare vocative. Order matters only for
  // readability — "Dear Varun," matches the first and would match neither test
  // of the second, since "Dear" is in NOT_A_NAME.
  const m = s.match(GREETING_RE) || s.match(VOCATIVE_RE);
  if (!m) return '';
  const cand = m[1];
  if (NOT_A_NAME.has(cand.toLowerCase().replace(/[.'-]+$/, ''))) return '';
  return cand;
}

/* ── The validator ────────────────────────────────────────────────────────── */

export function validateReply(input: ReplyValidationInput): ReplyValidation {
  const comment = String(input.comment ?? '');
  const review = input.review || { text: '' };
  const blocking: ReplyFinding[] = [];
  const warnings: ReplyFinding[] = [];
  const block = (code: ReplyFindingCode, label: string, detail: string) =>
    blocking.push({ code, severity: 'blocking', label, detail });
  const warn = (code: ReplyFindingCode, label: string, detail: string) =>
    warnings.push({ code, severity: 'warning', label, detail });

  const bytes = replyBytes(comment);
  const chars = [...comment].length;
  const trimmed = comment.trim();

  /* ── BLOCKING ─────────────────────────────────────────────────────────── */

  if (!trimmed) {
    block('empty', 'Nothing to post',
      'The reply is empty or only whitespace. Google would publish a blank owner reply under the business name.');
  }

  if (bytes > GBP_REPLY_MAX_BYTES) {
    block('too_long', 'Over Google’s limit',
      `${bytes} bytes; Google’s maximum is ${GBP_REPLY_MAX_BYTES} BYTES, not characters `
      + `(this reply is ${chars} characters — Telugu and Hindi letters are three bytes each and emoji are four). `
      + `Remove about ${bytes - GBP_REPLY_MAX_BYTES} bytes.`);
  }

  for (const p of PLACEHOLDERS) {
    if (p.re.test(comment)) {
      block('placeholder', 'Placeholder left in',
        `The reply still contains ${p.what}. A draft escaped — this would be published exactly as written.`);
      break;
    }
  }

  const greeted = greetedName(comment);
  if (greeted) {
    const anon = !!review.author_is_anonymous || !String(review.author_name || '').trim();
    if (anon) {
      block('name_for_anonymous', 'Greets a name we do not have',
        `The reply opens "…${greeted}", but Google gave no display name for this review — it shows as `
        + 'a Google user. Publishing a name here means publishing a guess about who wrote it.');
    } else {
      const tokens = words(review.author_name || '').filter(Boolean);
      const want = greeted.toLowerCase().replace(/[.'-]+$/, '');
      if (!tokens.includes(want)) {
        block('wrong_guest_name', 'Wrong guest name',
          `The reply greets "${greeted}", but this review is signed ${JSON.stringify(String(review.author_name).trim())}. `
          + 'Use the name exactly as it appears on the review, or drop the greeting.');
      }
    }
  }

  const reviewPhones = new Set(phoneLikes(review.text));
  const reviewEmails = new Set(emails(review.text));
  const replyPhones = phoneLikes(comment);
  const replyEmails = emails(comment);
  const echoedPhone = replyPhones.find(p => reviewPhones.has(p));
  const echoedEmail = replyEmails.find(e => reviewEmails.has(e));
  if (echoedPhone || echoedEmail) {
    block('echoes_guest_contact', 'Repeats the guest’s own contact details',
      'The reply repeats a '
      + (echoedPhone ? 'phone number' : 'email address')
      + ' that the guest put in their review. Publishing it on the listing puts their personal '
      + 'details in front of everyone, permanently. Nothing about a guest beyond their display name '
      + 'belongs in a public reply.');
  } else if (replyPhones.length || replyEmails.length) {
    warn('contact_in_public_reply', 'Contact details will be public',
      'The reply contains a '
      + (replyPhones.length ? 'phone number' : 'email address')
      + ' that will sit on the public listing for as long as the reply does. Fine if it is the '
      + 'restaurant’s own; check that it is.');
  }

  /* ── WARNINGS — judgement calls the admin acknowledges one by one ──────── */

  for (const c of COMPENSATION) {
    if (c.fn ? c.fn(comment) : !!c.re && c.re.test(comment)) {
      warn('compensation_offer', 'Offers compensation',
        `This promises something — ${c.what} — in public, under the business name, and the restaurant `
        + 'then has to honour it for this guest. Send it only if that offer is real and you meant to make it. '
        + 'If an AI draft added it, take it out.');
      break;
    }
  }

  for (const d of DISPUTES) {
    if (d.re.test(comment)) {
      warn('disputes_guest', 'Argues with the guest',
        `This reads as ${d.what}. Every future guest sees the argument, not the facts. `
        + 'Acknowledge what they experienced and say what changes instead.');
      break;
    }
  }

  for (const r of RATING_BEGS) {
    if (r.re.test(comment)) {
      warn('asks_for_rating', 'Mentions the rating',
        `This is ${r.what}. Asking for a better rating is against Google’s own reply policy and reads as `
        + 'begging to everyone else scrolling the listing. Invite them back for the food, not for the stars.');
      break;
    }
  }

  const fillerHits = FILLER.filter(f => f.re.test(comment)).map(f => f.what);
  if (fillerHits.length) {
    warn('corporate_filler', 'Corporate filler',
      `Contains ${fillerHits.slice(0, 3).join(', ')}. It is what every automated reply says, so it tells a `
      + 'reader this one was automated. Say the specific thing instead.');
  }

  /* Does it answer what they actually said? The owner's first rule for the
   * drafter, checked on the finished text rather than hoped for in a prompt. A
   * reply that shares no content word with a review of any length could be
   * pasted under any review on the listing — which is what convinces nobody. */
  const reviewWords = words(review.text).filter(w => w.length > 4 && !STOPWORDS.has(w));
  if (reviewWords.length >= 6 && trimmed) {
    const replySet = new Set(words(comment));
    const echoed = [...new Set(reviewWords)].filter(w => replySet.has(w));
    if (echoed.length === 0) {
      warn('generic_reply', 'Answers nothing they said',
        'This reply picks up none of the specific things the guest wrote about, so it would read the same '
        + 'under any review. Name the dish, the visit or the problem they actually mentioned.');
    }
  }

  const reviewScript = dominantScript(review.text);
  const replyScript = dominantScript(comment);
  if (reviewScript !== 'none' && replyScript !== 'none' && reviewScript !== replyScript
      && (reviewScript === 'telugu' || reviewScript === 'devanagari')) {
    warn('language_mismatch', 'Different language from the review',
      `The guest wrote mainly in ${SCRIPT_LABEL[reviewScript]} and this reply is in `
      + `${SCRIPT_LABEL[replyScript] || 'another script'}. That may be fine — plenty of guests read English, and `
      + 'many write Telugu in Latin letters — but answering in the language they chose lands better.');
  }

  if (EMOJI_RE.test(comment) && !EMOJI_RE.test(review.text || '')) {
    warn('emoji_added', 'Emoji the guest did not use',
      'The reply uses emoji and the review does not. On a public listing it reads as a template.');
  }

  const bangs = (comment.match(/!/g) || []).length;
  if (bangs >= 3) {
    warn('exclamation_spray', 'Too many exclamation marks',
      `${bangs} exclamation marks. Warm is good; shouting reads as insincere.`);
  }

  /* A model asked to sign off will invent a manager. "— Rahul, Manager" under
   * the owner's business name names a person who may not exist, to a guest who
   * may then ask for them. Sign off as the restaurant. */
  const signoff = comment.match(SIGNOFF_RE);
  if (signoff && !/team|akan|brewing|management/i.test(signoff[1])) {
    warn('signed_by_a_person', 'Signed by a person',
      `This is signed "${signoff[1]}". If that person does not exist, or does not work here any more, the `
      + 'reply names them publicly anyway. Sign off as the restaurant.');
  }

  /* ── VARIETY. With thousands of unanswered reviews the owner may send many in
   * one sitting, and a listing of near-identical replies reads as bot-written —
   * which costs more trust than the replies earn. Cheap to check, so checked. */
  const recent = (input.recentReplies || []).filter(r => r && r.trim());
  if (trimmed && recent.length) {
    let worst = 0, worstText = '';
    for (const r of recent) {
      const s = replySimilarity(comment, r);
      if (s > worst) { worst = s; worstText = r; }
    }
    if (worst >= 0.75) {
      warn('near_duplicate', 'Almost the same as a recent reply',
        `${Math.round(worst * 100)}% of the words match a reply sent recently ("`
        + `${worstText.trim().slice(0, 60)}…"). Both sit on the same public listing where anyone scrolling `
        + 'sees them one after the other.');
    } else {
      const open = replyOpening(comment);
      if (open && recent.some(r => replyOpening(r) === open)) {
        warn('repeated_opening', 'Same opening as a recent reply',
          `This opens "${open}…", the same as a reply already sent. Varying the first line is most of what `
          + 'stops a listing reading as automated.');
      }
    }
  }

  return {
    ok: blocking.length === 0,
    blocking,
    warnings,
    bytes,
    chars,
    bytes_remaining: GBP_REPLY_MAX_BYTES - bytes,
  };
}
