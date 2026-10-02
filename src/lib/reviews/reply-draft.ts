/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AI REPLY DRAFT — written to EARN A RETURN VISIT.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE OWNER'S OWN WORDS, WHICH ARE THE WHOLE SPECIFICATION
 * ══════════════════════════════════════════════════════════════════════════
 *   "AI Draft Should prepare the Reply Draft to Convince the Guest to Come
 *    Again to our Place in that manner it should be."
 *
 * So this is NOT a politeness generator and NOT an acknowledgement machine.
 * Every draft has one job: make THAT guest want to come back. That single
 * sentence is why the prompt below is shaped the way it is, and it is the thing
 * to protect if this file is ever edited. A draft that is courteous, correct,
 * grammatical and gives nobody a reason to return has failed at the only task
 * it was given.
 *
 * What that means in practice, and what the prompt enforces:
 *
 *   • ANSWER WHAT THEY ACTUALLY SAID. Name the dish, the failure, the thing
 *     they praised. A reply that could sit under any review convinces nobody
 *     and reads as automated to everyone else scrolling the listing. There are
 *     5,564 unanswered reviews here; the listing is read as a body of work.
 *   • A COMPLAINT gets acknowledgement without argument, what is being done,
 *     and a concrete reason to believe the next visit differs. Never dispute
 *     their account, never blame them, never imply they misremembered.
 *   • A GOOD REVIEW gets thanks for something specific and a reason to return,
 *     BUILT ONLY FROM THEIR OWN REVIEW or from the true-facts list the caller
 *     supplies as venueNotes. Never a word about ratings or stars.
 *
 *     This bullet used to offer "something seasonal, the live music" as the
 *     examples, four lines above a rule forbidding any event or policy not in
 *     the review — so the prompt instructed the model to do the thing it banned,
 *     and the ban is the one that matters, because a reason to return is exactly
 *     where a model reaches for a plausible invention. The examples now come
 *     from what the guest actually wrote; anything else has to arrive through
 *     venueNotes, which already tells the model that nothing outside it exists.
 *     Where the review supports no specific hook, a plain invitation is the
 *     correct answer — an invented reason is worse than no reason.
 *   • NEVER INVENT A REMEDY. No free meals, no discounts, no comped drinks, no
 *     "next visit is on us" unless the owner types it himself. Those are PUBLIC
 *     PROMISES the restaurant then has to honour.
 *   • NEVER FABRICATE anything about the venue — no menu items, staff names,
 *     hours, events or policies that are not in the review or supplied here. A
 *     confident invention in a public reply is a lie under the owner's own
 *     business name, and worse than a bland reply.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * A DRAFT IS A STARTING POINT. IT IS NEVER SENT BY ANYTHING IN THIS FILE.
 * ══════════════════════════════════════════════════════════════════════════
 * This module cannot publish. It does not import the send path, it holds no
 * token and it names no Google host. It returns text into a textarea that an
 * admin then edits, and that text goes through the SAME three checks as anything
 * typed by hand — preview, validation, confirm — with no shortcut for being
 * model-written. The opposite would be the worst version of this feature: a
 * model's guess about a stranger's bad evening, published automatically under a
 * real restaurant's name.
 *
 * Nothing is persisted either. A draft lives in the response and in the
 * admin's textarea, and nowhere else. It is deliberately NOT written to
 * gr_reviews.reply_text: that column is Google's mirror, and a draft sitting in
 * it would make the page say "Answered" about a reply no guest can see.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IF THE MODEL IS OFF OR BROKEN, TYPING MUST STILL WORK
 * ══════════════════════════════════════════════════════════════════════════
 * Every failure here returns a STATUS, never a throw that takes the page with
 * it: 'disabled', 'rate_limited', 'error', 'unusable'. The reply box, the
 * validation and the send path do not depend on this module at all — a drafting
 * feature that breaks sending when it is unavailable is worse than no drafting
 * feature. That is why the composer imports the validator directly and this
 * module is an optional extra on top.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE RAIL, AND THE FLAG
 * ══════════════════════════════════════════════════════════════════════════
 * Uses callCrmLlm() from src/lib/crm-llm.ts — the same rail as ./ai.ts, hiding
 * the Gemini/Claude toggle, key rotation and 429 cooldown. No second provider
 * path, no new dependency, and parseDraft() below trusts the model's output no
 * more than parseAiResult() does.
 *
 * THE FLAG IS A SEPARATE KEY FROM THE THEME FLAG, and that is a deliberate
 * deviation worth stating plainly. ./ai.ts's `reviews_ai_themes` gates a
 * per-review recurring cost across 10,055 stored rows — the reason it is off by
 * default is that a backfill is a bill the owner did not ask for. Drafting is
 * one call when an admin presses a button on one review. Sharing the flag would
 * mean the owner cannot have the feature he actually asked for without also
 * arming the expensive one. So: same convention exactly (absent, empty or
 * anything but '1' reads as OFF, so "never configured" and "switched off" are
 * the same state), different key.
 */
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { callCrmLlm, CrmRateLimitError, getProvider } from '@/lib/crm-llm';
import { scrubCredentials } from '@/lib/ct/recording-fetch';
import { ensureReviewSchema, reviewSetting } from './schema';
import { replyBytes, replyOpening, GBP_REPLY_MAX_BYTES } from './reply-validate';

type DB = Database.Database;

/** settings key. Absent or anything but '1' means OFF — the same shape as
 *  REVIEWS_AI_FLAG and the shipped call-analysis flags, so neither "never
 *  configured" nor "switched off" can accidentally mean on. */
export const REVIEWS_REPLY_AI_FLAG = 'reviews_ai_reply_draft';

export function isReplyDraftAiOn(db: DB = getDb()): boolean {
  return reviewSetting(db, REVIEWS_REPLY_AI_FLAG, '') === '1';
}

/**
 * A reply that Google would refuse is useless, and a reply nobody reads on a
 * phone is nearly as bad. 700 characters is roughly six short lines — long
 * enough to name the dish and the reason to return, short enough to be read.
 * The model is asked for this; the hard limit is Google's 4096 BYTES, enforced
 * in ./reply-validate.ts and again in the transport.
 */
const TARGET_CHARS = 700;

/* ── The contract with the model ──────────────────────────────────────────── */

export interface ReplyDraft {
  /** The draft itself. Goes straight into the admin's textarea. */
  reply: string;
  /** The specific things from the review this draft answers. THE
   *  ACCOUNTABILITY FIELD: if this is empty for a review with real content, the
   *  model wrote a generic reply and the page says so. It is not decoration —
   *  it is how an admin judges in two seconds whether the model read the
   *  review or pattern-matched the star rating. */
  answers: string[];
  /** The concrete reason to come back that the draft offers. Surfaced on its
   *  own so the admin can see at a glance whether it is something real about
   *  the restaurant or an invented freebie. */
  return_reason: string;
  /** Anything the model thinks needs the owner's judgement — a claim it could
   *  not verify, a complaint that may need a manager. */
  cautions: string[];
}

const JSON_INSTRUCTION = `
Return ONLY a JSON object, no prose and no code fence, in exactly this shape:
{"reply":"...","answers":["..."],"return_reason":"...","cautions":["..."]}
Rules for the fields:
- reply: the draft reply itself, plain text, ready to publish as-is. Under ${TARGET_CHARS} characters.
  Use "\\n\\n" between paragraphs if you need two. No markdown, no bullet points, no headings.
- answers: the specific things from THIS review the draft responds to, 1 to 4 short phrases
  (for example "the mutton biryani was dry", "praised the rooftop seating", "waited 40 minutes").
  If the review contains no specifics at all (a rating with no words), return [].
- return_reason: in a few words, the concrete reason to come back that your reply gives.
  If you could not give one honestly, return "".
- cautions: anything the owner should decide for himself before publishing, or [].
`.trim();

/**
 * THE SYSTEM PROMPT. Every line is load-bearing; read the file header before
 * cutting any of it. The hard prohibitions are repeated in the validator, which
 * runs on the finished text — because a prompt rule is a wish and a check that
 * fires is a rule.
 *
 * EXPORTED so scripts/reviews-tests.js can pin the instructions that matter to
 * the owner. That is not ceremony: the difference between this drafter and a
 * generic one is entirely in these lines, and a prompt is the easiest thing in a
 * codebase to quietly shorten. A test that only checked JSON parsing would stay
 * green after someone deleted "NEVER OFFER COMPENSATION".
 */
export const REPLY_DRAFT_SYSTEM = `
You write the owner's public reply to a Google review of a restaurant and brewery in Hyderabad, India.

YOUR ONE GOAL: make this particular guest want to come back. Not to sound polite, not to
close a ticket, not to defend the restaurant. Every draft is judged on whether the person
who wrote that review would read it and think about returning.

Write as the restaurant's owner would: a real person who runs the place, remembers that a
guest's evening went wrong, and wants them back. Not a support agent, not a brand account.

ANSWER WHAT THEY ACTUALLY SAID.
Name the specific thing — the dish, the failure, the thing they liked. A reply that could be
pasted under any review convinces nobody, and everyone else scrolling the listing can tell.
If they named a dish, name it back. If they described a delay, refer to that delay.

IF THEY COMPLAINED:
- Accept what they experienced, in plain words, without arguing any part of it.
- Never dispute their account, never blame them, never suggest they misremembered or
  misunderstood, never explain why it was reasonable.
- Say what is actually being done about it only if the review itself tells you enough to say
  something true. Otherwise say it is being looked into by the people responsible — do not
  invent a fix, a process, a meeting or a staff change.
- Give them a reason to believe the next visit would be different, then invite them back.

IF THEY WERE HAPPY:
- Thank them for the specific thing, not for "the feedback".
- Give them a reason to return, and build it ONLY from what is in front of you: what they
  praised, what they said they would try next, what they mentioned missing or running out of,
  the occasion they came for. "You came for the biryani and left talking about the kebabs —
  come back hungry for both" follows from their review. Naming an event, a season, a menu
  change or anything else they did not mention does NOT, however inviting it sounds, unless it
  appears in the true-facts list below. If nothing in their review supports a specific hook,
  a plain warm invitation is correct and complete — an invented reason is worse than none.
- Do not mention ratings, stars or reviews, and never ask them to change or leave one.

NEVER OFFER COMPENSATION. No free food or drink, no discount, no voucher, no refund, no
"on the house", no "your next visit is on us". You are not authorised to promise anything the
restaurant has to honour. The owner adds that himself if he wants to.

NEVER INVENT FACTS. No dish, staff name, opening time, event, offer, chef, award or policy
that is not in the review or given to you. If you do not know the name of something, describe
it without naming it. An invented detail in a public reply is a lie under the owner's own
business name.

NEVER repeat anything personal about the guest beyond the display name you are given. No
phone number, no email, no table number, no detail about who they came with.

VOICE:
- Short enough to read on a phone. Two short paragraphs at most.
- Warm, direct, plain English. Contractions are fine.
- NO corporate filler. Never "we value your feedback", "we strive to", "rest assured",
  "we apologise for any inconvenience", "valued guest".
- No emoji unless the guest used emoji. At most one exclamation mark in the whole reply.
- Sign off as the restaurant if you sign off at all. Never invent a person's name to sign as.
- Use the guest's display name only if you are given one, and spell it exactly as given.

Reviews arrive in English, Hindi, Telugu, or a mix, sometimes transliterated into Latin
letters. Reply in the language the guest used; if they wrote Telugu or Hindi in Latin letters,
reply in simple English.
`.trim();

/* ── Parse without trusting ───────────────────────────────────────────────── */

/**
 * Recover a draft from whatever the model returned. Same contract as
 * parseAiResult() in ./ai.ts: a fenced block, leading prose or a trailing
 * sentence must not cost the whole call. Returns null when there is no usable
 * reply text, because a draft with no words is not a draft.
 */
export function parseDraft(raw: string): ReplyDraft | null {
  if (!raw) return null;
  let body = String(raw).trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  else {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) body = body.slice(start, end + 1);
  }

  let obj: any;
  try { obj = JSON.parse(body); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;

  const reply = String(obj.reply ?? '').trim();
  if (!reply) return null;

  const list = (v: any, cap: number) => (Array.isArray(v)
    ? v.map((x: any) => String(x).trim().slice(0, 160)).filter(Boolean).slice(0, cap)
    : []);

  return {
    // Trimmed to Google's hard byte limit as a last resort. The validator says
    // this in English to the admin; this slice only stops an absurd answer
    // becoming an unsendable one.
    reply: reply.length > 4000 ? reply.slice(0, 4000) : reply,
    answers: list(obj.answers, 4),
    return_reason: String(obj.return_reason ?? '').trim().slice(0, 200),
    cautions: list(obj.cautions, 4),
  };
}

/* ── Drafting one reply ───────────────────────────────────────────────────── */

export interface DraftReviewInput {
  rating: number;
  text: string;
  author_name?: string;
  author_is_anonymous?: boolean;
  language?: string;
  posted_at?: string;
}

export interface DraftResult {
  ok: boolean;
  status: 'drafted' | 'disabled' | 'rate_limited' | 'error' | 'unusable';
  draft: ReplyDraft | null;
  /** Which provider produced it, recorded so a bad batch is attributable. */
  model: string;
  /** For the admin, in English. Always populated when ok is false. */
  message: string;
  bytes: number;
  /** The exact prompt is NOT returned — it is long, it is not the admin's
   *  problem, and echoing it invites editing it in the browser. */
}

/**
 * Build the user half of the prompt. Separated from the call so the suite can
 * assert on the prompt WITHOUT a provider: the prompt is the feature here, and a
 * test that only checks JSON parsing would pass on a prompt that had quietly
 * lost the "never offer compensation" line.
 */
export function buildDraftPrompt(
  review: DraftReviewInput,
  opts: { avoidOpenings?: string[]; venueNotes?: string } = {},
): string {
  const anon = !!review.author_is_anonymous || !String(review.author_name || '').trim();
  const text = String(review.text || '').trim();
  const rating = Number(review.rating);

  const lines: string[] = [];
  lines.push(`Star rating this guest gave: ${rating} out of 5.`);
  lines.push(anon
    ? 'Display name: NONE — Google shows this guest as "A Google user". Do not greet them by any '
      + 'name and do not guess one.'
    : `Display name, spelled exactly as it appears on the review: ${String(review.author_name).trim()}`);
  if (review.language) lines.push(`Language tag Google put on the review: ${review.language}`);
  if (review.posted_at) lines.push(`Posted: ${review.posted_at}`);

  if (text) {
    lines.push('', 'The review, in full:', '"""', text.slice(0, 6000), '"""');
  } else {
    lines.push('',
      'THE GUEST LEFT NO WORDS — this is a rating with no text. You know nothing about what '
      + 'happened, so do not guess at it and do not imply you know. '
      + (rating >= 4
        ? 'Thank them briefly for the rating and give them one honest reason to come back. Two '
          + 'sentences is plenty.'
        : 'Do not apologise for a specific thing you have invented. Acknowledge that the rating '
          + 'says the visit fell short, ask them to tell you what went wrong, and invite them '
          + 'back. Keep it to two or three sentences.'));
  }

  /* VARIETY. With thousands of unanswered reviews the owner may send many in one
   * sitting, and a listing where every reply opens the same way reads as
   * bot-written — which costs more trust than the replies earn. The openings
   * already used are handed over so the model can avoid them. */
  const avoid = (opts.avoidOpenings || []).map(s => s.trim()).filter(Boolean).slice(0, 12);
  if (avoid.length) {
    lines.push('',
      'Replies already published on this listing open with the following. DO NOT open with any of '
      + 'these, or with a paraphrase of one — a listing of replies that all start the same way '
      + 'reads as automated to every guest who scrolls it:');
    for (const a of avoid) lines.push(`- "${a}"`);
  }

  if (opts.venueNotes && opts.venueNotes.trim()) {
    lines.push('',
      'True facts about the restaurant you MAY use (and nothing beyond these — anything not '
      + 'listed here or in the review does not exist as far as you are concerned):',
      opts.venueNotes.trim().slice(0, 1200));
  }

  lines.push('', `Keep the reply under ${TARGET_CHARS} characters.`, '', JSON_INSTRUCTION);
  return lines.join('\n');
}

/**
 * Draft one reply. Never throws for an expected failure — the composer must keep
 * working when this does not.
 */
export async function draftReply(args: {
  db?: DB;
  review: DraftReviewInput;
  avoidOpenings?: string[];
  venueNotes?: string;
  force?: boolean;
}): Promise<DraftResult> {
  const db = ensureReviewSchema(args.db || getDb());
  const base = { draft: null, model: '', bytes: 0 };

  if (!args.force && !isReplyDraftAiOn(db)) {
    return {
      ...base, ok: false, status: 'disabled',
      message: 'AI draft is switched off. An admin turns on the ' + REVIEWS_REPLY_AI_FLAG
        + ' setting to use it. Replies can still be typed and sent without it.',
    };
  }

  const model = getProvider();
  const prompt = buildDraftPrompt(args.review, {
    avoidOpenings: args.avoidOpenings,
    venueNotes: args.venueNotes,
  });

  try {
    const raw = await callCrmLlm({
      messages: [{ role: 'user', content: prompt }],
      system: REPLY_DRAFT_SYSTEM,
      maxTokens: 1400,
      // Warmer than ./ai.ts's 0.2, on purpose. That file is doing analysis,
      // where a stable answer is the point. This one is writing prose, and the
      // owner may publish dozens in a sitting: at a low temperature every draft
      // converges on the same three sentences, which is the exact failure that
      // makes a listing read as bot-written.
      temperature: 0.8,
    });

    const draft = parseDraft(raw);
    if (!draft) {
      return {
        ...base, ok: false, status: 'unusable', model,
        message: 'The model did not return a usable draft. Nothing has been changed — type the '
          + 'reply, or try the draft again.',
      };
    }
    return {
      ok: true, status: 'drafted', draft, model, bytes: replyBytes(draft.reply),
      message: '',
    };
  } catch (e: any) {
    if (e instanceof CrmRateLimitError) {
      return {
        ...base, ok: false, status: 'rate_limited', model,
        message: 'The AI provider is rate-limiting right now. Wait a moment and try again, or type '
          + 'the reply — sending does not need the draft.',
      };
    }
    return {
      ...base, ok: false, status: 'error', model,
      message: scrubCredentials(String(e?.message || e), []).slice(0, 400),
    };
  }
}

/* ── Helper the route uses to feed the variety instruction ────────────────── */

/** Turn recent reply texts into the distinct openings to avoid. */
export function openingsToAvoid(recentReplies: string[], max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of recentReplies) {
    const words = String(r || '').trim().split(/\s+/).slice(0, 6).join(' ');
    const key = replyOpening(r);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(words);
    if (out.length >= max) break;
  }
  return out;
}

export { GBP_REPLY_MAX_BYTES };
