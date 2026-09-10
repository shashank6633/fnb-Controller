/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * GOOGLE REVIEWS — OPTIONAL AI PASS. OFF BY DEFAULT.
 *
 * The app already has an LLM rail: callCrmLlm() in src/lib/crm-llm.ts, which
 * hides the Gemini/Claude provider toggle, the multi-key rotation and the 429
 * cooldown behind one function. This file uses it and adds NO dependency and
 * NO second provider path. If the rail moves, this moves with it.
 *
 * WHAT THE AI ADDS THAT KEYWORDS CANNOT
 * ─────────────────────────────────────
 * ./themes.ts counts words. It does not know that "we waited 40 minutes and
 * nobody apologised" is a service failure and "worth the wait" is praise. This
 * file asks a model for a real per-review reading: sentiment, the themes it
 * actually sees, and one line the owner can act on. That IS sentiment analysis
 * and may be labelled as such. The keyword report may not.
 *
 * WHY IT IS OFF BY DEFAULT — and stays off until an admin says otherwise:
 *   • It costs money per review, every review, forever. A backfill of two years
 *     of history is one bill the owner did not ask for.
 *   • The whole feature works without it. Counts, trends, major reviews, reply
 *     rate and keyword themes are all computed from data we hold, for free.
 *   • Nothing on any page may DEPEND on ai_json being present. Every surface
 *     must render correctly with the toggle off, which is why the keyword
 *     report is the default and this is an overlay.
 * The same shape as the shipped call-analysis auto_analyze flag: absent reads
 * as off, because an unknown settings key returns '' and '' is not '1'.
 *
 * FAILURE CONTRACT — copied from src/lib/ct/analyze.ts, deliberately
 *   • a rate limit is RETRYABLE: status goes back to '' so the row is picked up
 *     next time, never to a terminal 'error' that needs a human to clear;
 *   • a hard failure stores a SCRUBBED message on the row and moves on — one
 *     bad review never stops a batch;
 *   • an unparseable model answer is stored as-is rather than thrown away, so a
 *     prompt problem is diagnosable after the fact;
 *   • the claim on a row is atomic, so a double-click cannot pay twice.
 */
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { callCrmLlm, CrmRateLimitError, getProvider } from '@/lib/crm-llm';
import { scrubCredentials } from '@/lib/ct/recording-fetch';
import { ensureReviewSchema, reviewSetting } from './schema';

type DB = Database.Database;

/** settings key. Absent or anything but '1' means OFF. */
export const REVIEWS_AI_FLAG = 'reviews_ai_themes';
/** How many reviews one batch may analyse. Small on purpose: a batch is driven
 *  by a human clicking or by a tick, and a big batch is a big bill. */
export const AI_BATCH_MAX = 25;
/** A 'pending' older than this was a crash, not a run in progress. */
const STALE_PENDING_MS = 5 * 60 * 1000;
/** Reviews shorter than this carry nothing to analyse; a model asked to find
 *  sentiment in "Good" will invent some. Skipped, not sent. */
export const MIN_TEXT_FOR_AI = 25;

/** Absent, empty, or anything but '1' reads as OFF — the same shape as the
 *  shipped call-analysis flags, so "never configured" and "switched off" are
 *  the same state and neither can accidentally mean on. */
export function isReviewAiOn(db: DB = getDb()): boolean {
  return reviewSetting(db, REVIEWS_AI_FLAG, '') === '1';
}

/* ── The contract with the model ──────────────────────────────────────────── */

export const SENTIMENTS = ['positive', 'mixed', 'negative'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export interface ReviewAiResult {
  sentiment: Sentiment;
  /** 0..1 — the model's own confidence. Stored so a page can hide low-confidence
   *  readings rather than presenting a guess as a finding. */
  confidence: number;
  /** Short lowercase theme labels the model actually saw. Free text on purpose:
   *  forcing the model into our keyword taxonomy would throw away the only
   *  thing it is better at. */
  themes: string[];
  /** One sentence, in English, for the owner. */
  summary: string;
  /** Something concrete to do, or '' when there is nothing. */
  action: string;
}

const JSON_INSTRUCTION = `
Return ONLY a JSON object, no prose and no code fence, in exactly this shape:
{"sentiment":"positive|mixed|negative","confidence":0.0,"themes":["..."],"summary":"...","action":"..."}
Rules:
- sentiment is your reading of the WORDS, independent of the star rating you are shown.
- themes: 1 to 4 short lowercase labels for what the guest actually talked about
  (for example "slow service", "food quality", "parking", "loud music").
- summary: ONE sentence, under 25 words, plain English, no marketing language.
- action: one concrete thing the restaurant could do, or "" if there is nothing.
- If the text is too short or too vague to read, use sentiment "mixed" with
  confidence below 0.3 rather than inventing a reading.
`.trim();

const SYSTEM = `
You read Google reviews for a single restaurant in Hyderabad, India, for its owner.
Reviews arrive in English, Hindi, Telugu or a mix, sometimes transliterated.
Be literal and be brief. Do not flatter the restaurant and do not soften a complaint.
`.trim();

/** Parse the model's answer without trusting it. A fenced block, leading prose
 *  or a trailing full stop must not cost the whole call. */
export function parseAiResult(raw: string): ReviewAiResult | null {
  if (!raw) return null;
  let body = raw.trim();
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

  const sentiment = SENTIMENTS.includes(obj.sentiment) ? obj.sentiment as Sentiment : 'mixed';
  const confidence = Number.isFinite(Number(obj.confidence))
    ? Math.min(1, Math.max(0, Number(obj.confidence))) : 0;
  const themes = Array.isArray(obj.themes)
    ? obj.themes.map((t: any) => String(t).trim().toLowerCase().slice(0, 60)).filter(Boolean).slice(0, 6)
    : [];

  return {
    sentiment,
    confidence,
    themes,
    summary: String(obj.summary ?? '').trim().slice(0, 400),
    action: String(obj.action ?? '').trim().slice(0, 400),
  };
}

/* ── One review ───────────────────────────────────────────────────────────── */

export interface AnalyzeOne {
  ok: boolean;
  status: 'done' | 'skipped' | 'error' | 'rate_limited' | 'disabled';
  reviewId: string;
  result?: ReviewAiResult | null;
  error?: string;
}

export async function analyzeReviewWithAi(
  reviewId: string,
  opts: { db?: DB; force?: boolean } = {},
): Promise<AnalyzeOne> {
  const db = ensureReviewSchema(opts.db || getDb());

  if (!isReviewAiOn(db)) {
    return { ok: false, status: 'disabled', reviewId, error: 'AI theme analysis is switched off in settings' };
  }

  const row = db.prepare(
    `SELECT id, rating, text, language, ai_status, ai_json, ai_at FROM gr_reviews WHERE id = ?`,
  ).get(reviewId) as any;
  if (!row) return { ok: false, status: 'error', reviewId, error: 'Review not found' };

  if (!opts.force && row.ai_status === 'done' && row.ai_json) {
    return { ok: true, status: 'done', reviewId, result: safeParse(row.ai_json) };
  }

  const text = String(row.text || '').trim();
  if (text.length < MIN_TEXT_FOR_AI) {
    db.prepare(`UPDATE gr_reviews SET ai_status='skipped', ai_error=?, ai_at=? WHERE id=?`)
      .run('review text is too short to read', new Date().toISOString(), reviewId);
    return { ok: false, status: 'skipped', reviewId, error: 'review text is too short to read' };
  }

  // ATOMIC claim. better-sqlite3 is synchronous, so exactly one caller flips a
  // non-pending row to 'pending'; a racing click sees changes === 0 and stops
  // BEFORE the paid call. A row left 'pending' by a crash is reclaimable once
  // it is older than STALE_PENDING_MS.
  const staleCutoff = new Date(Date.now() - STALE_PENDING_MS).toISOString();
  const claim = db.prepare(
    `UPDATE gr_reviews SET ai_status='pending', ai_error='', ai_at=?
      WHERE id=? AND (ai_status != 'pending' OR ai_at = '' OR ai_at < ?)`,
  ).run(new Date().toISOString(), reviewId, staleCutoff);
  if (claim.changes === 0) {
    return { ok: false, status: 'skipped', reviewId, error: 'Analysis already in progress' };
  }

  const model = getProvider();
  const prompt = [
    `Star rating the guest gave: ${row.rating} out of 5.`,
    row.language ? `Language tag on the review: ${row.language}.` : '',
    'Review text:',
    '"""',
    text.slice(0, 6000),
    '"""',
    '',
    JSON_INSTRUCTION,
  ].filter(Boolean).join('\n');

  try {
    const raw = await callCrmLlm({
      messages: [{ role: 'user', content: prompt }],
      system: SYSTEM,
      maxTokens: 1200,
      temperature: 0.2,
    });
    const parsed = parseAiResult(raw);
    const at = new Date().toISOString();

    if (!parsed) {
      // Store what came back rather than discarding it: an unparseable answer is
      // a PROMPT problem, and it is only diagnosable if the answer survives.
      db.prepare(`UPDATE gr_reviews SET ai_status='unstructured', ai_json=?, ai_error=?, ai_at=?, ai_model=? WHERE id=?`)
        .run(JSON.stringify({ raw: String(raw).slice(0, 4000) }), 'model did not return usable JSON', at, model, reviewId);
      return { ok: false, status: 'error', reviewId, error: 'model did not return usable JSON' };
    }

    db.prepare(`UPDATE gr_reviews SET ai_status='done', ai_json=?, ai_error='', ai_at=?, ai_model=? WHERE id=?`)
      .run(JSON.stringify(parsed), at, model, reviewId);
    return { ok: true, status: 'done', reviewId, result: parsed };
  } catch (e: any) {
    if (e instanceof CrmRateLimitError) {
      // RETRYABLE, not terminal: back to '' so the next pass picks it up. A
      // rate limit is the provider's schedule, not this review's fault.
      db.prepare(`UPDATE gr_reviews SET ai_status='', ai_error='' WHERE id=?`).run(reviewId);
      return { ok: false, status: 'rate_limited', reviewId, error: e.message };
    }
    const msg = scrubCredentials(String(e?.message || e), []).slice(0, 500);
    db.prepare(`UPDATE gr_reviews SET ai_status='error', ai_error=?, ai_at=? WHERE id=?`)
      .run(msg, new Date().toISOString(), reviewId);
    return { ok: false, status: 'error', reviewId, error: msg };
  }
}

function safeParse(s: string): ReviewAiResult | null {
  try { return JSON.parse(s) as ReviewAiResult; } catch { return null; }
}

/* ── Batches ──────────────────────────────────────────────────────────────── */

export interface BatchResult {
  attempted: number;
  done: number;
  skipped: number;
  errors: number;
  rate_limited: boolean;
  remaining: number;
}

/**
 * Analyse up to `limit` un-analysed reviews, newest first — the ones the owner
 * is about to look at. Sequential, not parallel: the rail's rate limiting is
 * per-key with a cooldown, and firing 25 concurrent calls at it converts a
 * queue into a burst of 429s.
 *
 * STOPS DEAD on the first rate limit. Continuing would burn the remaining keys
 * for nothing and turn a 30-second wait into a locked-out minute.
 */
export async function analyzePendingReviews(
  opts: { db?: DB; limit?: number; locationKey?: string } = {},
): Promise<BatchResult> {
  const db = ensureReviewSchema(opts.db || getDb());
  const limit = Math.min(AI_BATCH_MAX, Math.max(1, opts.limit || 5));
  const out: BatchResult = { attempted: 0, done: 0, skipped: 0, errors: 0, rate_limited: false, remaining: 0 };

  if (!isReviewAiOn(db)) return out;

  const where = ['(ai_status IS NULL OR ai_status = \'\')', 'LENGTH(TRIM(text)) >= ?'];
  const args: any[] = [MIN_TEXT_FOR_AI];
  if (opts.locationKey !== undefined) { where.push('location_key = ?'); args.push(opts.locationKey); }

  const pending = db.prepare(
    `SELECT id FROM gr_reviews WHERE ${where.join(' AND ')} ORDER BY posted_at DESC LIMIT ?`,
  ).all(...args, limit) as Array<{ id: string }>;

  for (const p of pending) {
    out.attempted++;
    const r = await analyzeReviewWithAi(p.id, { db });
    if (r.status === 'done') out.done++;
    else if (r.status === 'rate_limited') { out.rate_limited = true; break; }
    else if (r.status === 'skipped' || r.status === 'disabled') out.skipped++;
    else out.errors++;
  }

  const rest = db.prepare(
    `SELECT COUNT(*) AS n FROM gr_reviews WHERE ${where.join(' AND ')}`,
  ).get(...args) as { n: number };
  out.remaining = rest.n;
  return out;
}

/* ── Reading the AI overlay back ──────────────────────────────────────────── */

export interface AiThemeReport {
  method: 'ai';
  /** Rendered next to the figures, so nobody has to guess what produced them. */
  disclaimer: string;
  analyzed: number;
  /** Reviews with enough text but no AI reading yet. The denominator honesty:
   *  an AI theme table over 12 of 400 reviews is not a picture of the venue. */
  pending: number;
  sentiment: Record<Sentiment, number>;
  themes: Array<{ theme: string; count: number; average_rating: number | null }>;
}

export const AI_DISCLAIMER =
  'Sentiment and themes on this view are produced by a language model reading each ' +
  'review, not by counting keywords. They are a reading, not a measurement — the star ' +
  'rating beside each review is the guest’s own.';

export function aiThemeReport(dbIn: DB | null, opts: { locationKey?: string } = {}): AiThemeReport {
  const db = ensureReviewSchema(dbIn || getDb());
  const args: any[] = [];
  let scope = '';
  if (opts.locationKey !== undefined) { scope = ' AND location_key = ?'; args.push(opts.locationKey); }

  const rows = db.prepare(
    `SELECT rating, ai_json FROM gr_reviews WHERE ai_status = 'done' AND ai_json != ''${scope}`,
  ).all(...args) as Array<{ rating: number; ai_json: string }>;

  const pending = (db.prepare(
    `SELECT COUNT(*) AS n FROM gr_reviews
      WHERE (ai_status IS NULL OR ai_status = '') AND LENGTH(TRIM(text)) >= ?${scope}`,
  ).get(MIN_TEXT_FOR_AI, ...args) as { n: number }).n;

  const sentiment: Record<Sentiment, number> = { positive: 0, mixed: 0, negative: 0 };
  const themes = new Map<string, { count: number; sum: number }>();

  for (const r of rows) {
    const parsed = safeParse(r.ai_json);
    if (!parsed) continue;
    if (SENTIMENTS.includes(parsed.sentiment)) sentiment[parsed.sentiment]++;
    for (const t of parsed.themes || []) {
      const acc = themes.get(t) || { count: 0, sum: 0 };
      acc.count++; acc.sum += r.rating;
      themes.set(t, acc);
    }
  }

  return {
    method: 'ai',
    disclaimer: AI_DISCLAIMER,
    analyzed: rows.length,
    pending,
    sentiment,
    themes: [...themes.entries()]
      .map(([theme, a]) => ({
        theme,
        count: a.count,
        average_rating: a.count ? Math.round((a.sum / a.count) * 100) / 100 : null,
      }))
      .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme))
      .slice(0, 40),
  };
}
