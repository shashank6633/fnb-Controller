/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * CRM Call-to-Table — TOPIC ALERTS (standing keyword rules over call text).
 *
 * WHAT THIS IS
 * ────────────
 * CallHippo sells a "custom topic tracker" as a paid add-on. We already hold
 * the call text (ct_calls.analysis_json / analysis_summary / analysis_outcome
 * and the GRE's disposition_note), so ours is a pure rules layer over data we
 * own: no LLM call, no per-call cost, no vendor.
 *
 * A rule is a name + a list of keywords + a severity. A scan walks the calls in
 * a date range, matches each active rule's keywords against that call's text,
 * and records a hit row (ct_topic_hits) carrying a short excerpt for context.
 *
 * OFF BY DEFAULT — the safety property
 * ────────────────────────────────────
 * Everything here is gated by ct_settings key `topic_tracking` (default '0',
 * i.e. OFF — the key is deliberately absent from CT_SETTING_DEFAULTS, and
 * ctSetting() returns '' for an unknown key, so "unset" reads as off).
 *   • flag OFF → a persisting scan writes NOTHING and the post-analysis hook is
 *     a no-op. ct_topic_hits stays empty, so no surface anywhere can show an
 *     alert. Nothing existing changes behaviour.
 *   • The 4 seeded example rules are created INACTIVE, so even with the flag on
 *     nothing fires until a human ticks a rule active.
 *   • `notify` on a rule raises an IN-APP flag only. There is deliberately no
 *     WhatsApp/email/SMS send path in this file — a keyword in a transcript is
 *     never a lawful basis to message a guest unprompted.
 *
 * A DRY RUN (dryRun: true) is read-only: it computes what would be recorded and
 * writes nothing, so it is allowed whatever the flag says and can be used to
 * try a rule out before switching it on.
 *
 * MATCHING RULE (and its limits) — see termPattern() below.
 *
 * POST-ANALYSIS HOOK — see scanCallAfterAnalysis() at the bottom. It is written
 * and safe to call, but deliberately NOT wired into src/lib/ct/analyze.ts here.
 */
import type Database from 'better-sqlite3';
import { getDb, generateId } from '@/lib/db';
import { ctSetting } from './settings';

// ─── Constants ──────────────────────────────────────────────────────────────

export const TOPIC_SEVERITIES = ['info', 'attention', 'urgent'] as const;
export type TopicSeverity = (typeof TOPIC_SEVERITIES)[number];

/** ct_settings master switch. Absent/'0' = OFF (the default). */
export const TOPIC_TRACKING_KEY = 'topic_tracking';

export const MAX_KEYWORDS = 60;
export const MAX_KEYWORD_LEN = 80;
export const MAX_RULE_NAME_LEN = 80;
/** Hard ceiling on calls read in one scan (a 30-day window is ~120 rows here). */
export const SCAN_CALL_LIMIT = 5000;
/** At most N distinct matched terms per (rule, call) — one call tripping ten
 *  synonyms of the same rule is one thing to look at, not ten. */
export const MAX_TERMS_PER_CALL_RULE = 3;

const EXCERPT_PAD = 70;   // chars of context either side of the match
const EXCERPT_MAX = 240;

/** Which text on a call gets scanned, in the order it is searched. The label is
 *  written into the excerpt (`[transcript] …`) because ct_topic_hits has no
 *  source column and the reviewer needs to know whether a hit came from the
 *  guest's words or the agent's own note. */
export const TOPIC_FIELDS = ['transcript', 'summary', 'analysis', 'outcome', 'note'] as const;
export type TopicField = (typeof TOPIC_FIELDS)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TopicRule {
  id: string;
  name: string;
  keywords: string[];
  severity: TopicSeverity;
  is_active: number;   // 0 | 1
  notify: number;      // 0 | 1
  created_by: string;
  created_at: string;
}

export interface TopicHitDraft {
  rule_id: string;
  rule_name: string;
  severity: TopicSeverity;
  notify: number;
  call_id: string;
  guest_id: string | null;
  matched_term: string;   // canonical lowercase — the UNIQUE key component
  excerpt: string;
  field: TopicField;
  /** dry runs only: an identical hit row already exists (a real scan would skip it) */
  already_recorded?: boolean;
}

export interface ScanCoverage {
  calls: number;
  with_transcript: number;
  with_summary: number;
  with_outcome: number;
  with_note: number;
  with_any_text: number;
  transcript_lines: number;
  /** with_any_text / calls, 0..1 — how much of the range the scanner can even see */
  ratio: number;
}

export interface ScanRuleResult {
  rule_id: string;
  name: string;
  severity: TopicSeverity;
  is_active: number;
  notify: number;
  hits: number;            // hit drafts produced
  calls: number;           // distinct calls that tripped this rule
  inserted: number;        // rows actually written (0 on a dry run)
  already_recorded: number;
  sample_call_id: string;
  sample_term: string;
  sample_excerpt: string;
}

export interface ScanResult {
  enabled: boolean;          // master flag state
  dry_run: boolean;
  persisted: boolean;        // did this scan write anything to ct_topic_hits
  blocked_reason: string;    // why not, when persisted === false and dry_run === false
  from: string;
  to: string;
  rules_used: number;
  coverage: ScanCoverage;
  total_hits: number;
  inserted: number;
  already_recorded: number;
  per_rule: ScanRuleResult[];
  hits: TopicHitDraft[];     // capped sample for the UI
  scanned_at: string;
}

interface CallTextRow {
  id: string;
  guest_id: string | null;
  analysis_json: string;
  analysis_summary: string;
  analysis_outcome: string;
  disposition_note: string;
}

// ─── Settings ───────────────────────────────────────────────────────────────

/** Master switch. Unset → OFF. Only '1' turns it on. */
export function isTopicTrackingOn(db: Database.Database = getDb()): boolean {
  try {
    return ctSetting(db, TOPIC_TRACKING_KEY) === '1';
  } catch {
    return false;   // fail closed: a settings read failure must never start alerting
  }
}

// ─── Rules ──────────────────────────────────────────────────────────────────

export function normalizeSeverity(v: unknown): TopicSeverity {
  const s = String(v ?? '').trim().toLowerCase();
  return (TOPIC_SEVERITIES as readonly string[]).includes(s) ? (s as TopicSeverity) : 'info';
}

/**
 * Accepts a JSON array, a real array, or a comma/newline separated string.
 * Trims, collapses inner whitespace, dedupes case-insensitively, caps length
 * and count. Original casing is preserved for display; matching is always
 * case-insensitive.
 */
export function normalizeKeywords(input: unknown): string[] {
  let raw: unknown[] = [];
  if (Array.isArray(input)) {
    raw = input;
  } else if (typeof input === 'string') {
    const t = input.trim();
    let parsed = false;
    if (t.startsWith('[')) {
      try {
        const p = JSON.parse(t);
        if (Array.isArray(p)) { raw = p; parsed = true; }
      } catch { /* not JSON → treat as a plain separated list */ }
    }
    if (!parsed) raw = t.split(/[,\n;]/);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const term = String(r ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_KEYWORD_LEN);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

function rowToRule(row: any): TopicRule {
  let keywords: string[] = [];
  try {
    const p = JSON.parse(row.keywords || '[]');
    if (Array.isArray(p)) keywords = p.map((k: any) => String(k)).filter(Boolean);
  } catch { /* corrupt JSON → rule simply matches nothing, never throws */ }
  return {
    id: String(row.id),
    name: String(row.name || ''),
    keywords,
    severity: normalizeSeverity(row.severity),
    is_active: row.is_active ? 1 : 0,
    notify: row.notify ? 1 : 0,
    created_by: String(row.created_by || ''),
    created_at: String(row.created_at || ''),
  };
}

export function listRules(
  db: Database.Database = getDb(),
  opts: { includeInactive?: boolean } = {},
): TopicRule[] {
  const where = opts.includeInactive === false ? 'WHERE is_active = 1' : '';
  const rows = db.prepare(
    `SELECT * FROM ct_topic_rules ${where} ORDER BY is_active DESC, name COLLATE NOCASE ASC`,
  ).all() as any[];
  return rows.map(rowToRule);
}

export function getRule(db: Database.Database, id: string): TopicRule | null {
  const row = db.prepare(`SELECT * FROM ct_topic_rules WHERE id = ?`).get(id) as any;
  return row ? rowToRule(row) : null;
}

// ─── Matching ───────────────────────────────────────────────────────────────

/**
 * MATCHING RULE
 * ─────────────
 * A keyword matches on WORD BOUNDARIES, case-insensitively:
 *
 *   (?<![\p{L}\p{N}\p{M}_])  <escaped term, inner spaces → \s+>  (?![\p{L}\p{N}\p{M}_])
 *
 * Unicode property escapes (not JS `\b`, which is ASCII-only) so a Telugu or
 * Devanagari term isn't cut mid-word. \p{M} (combining marks) is in the class
 * on purpose: an Indic word often ENDS in a vowel sign, so a letters-only guard
 * would leave "పార్టీ" matching inside "పార్టీలు". The leading/trailing guard is
 * dropped when the term itself starts/ends with a non-word character (so
 * "b'day" and "50+" still work). Inner whitespace becomes \s+, so the phrase
 * "large group" matches across a line break.
 *
 *   "book"   matches  "book a table", "BOOK", "…book."
 *   "book"   does NOT match  "bookkeeping", "rebook", "booking"
 *
 * KNOWN LIMITS — deliberate, because a keyword rule that guesses is worse than
 * one that is predictable:
 *   1. No stemming/plurals. "complaint" will not fire on "complaints" — list
 *      both (the seeded rules do).
 *   2. No typo/fuzzy tolerance and no transliteration. "bday" ≠ "b'day" ≠
 *      "పుట్టినరోజు" unless each is listed as its own keyword.
 *   3. No negation or sentiment awareness. "no complaints at all" fires the
 *      complaint rule. Severity + the excerpt exist so a human can dismiss it
 *      in one glance; that is the intended workflow, not silent automation.
 *   4. No speaker awareness. The agent saying "birthday" counts the same as the
 *      guest saying it. The excerpt carries the `speaker:` prefix from the
 *      transcript so the reviewer can tell.
 *   5. It only sees text we hold. A call with no transcript and no note is
 *      invisible to every rule — see the coverage block on every scan result.
 */
export function termPattern(term: string): RegExp | null {
  const t = term.trim();
  if (!t) return null;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  let head = '';
  let tail = '';
  try {
    if (/^[\p{L}\p{N}\p{M}_]/u.test(t)) head = '(?<![\\p{L}\\p{N}\\p{M}_])';
    if (/[\p{L}\p{N}\p{M}_]$/u.test(t)) tail = '(?![\\p{L}\\p{N}\\p{M}_])';
    return new RegExp(head + esc + tail, 'giu');
  } catch {
    return null;   // pathological term → skip it rather than break the scan
  }
}

export interface CompiledRule {
  rule: TopicRule;
  terms: { term: string; re: RegExp }[];
}

export function compileRules(rules: TopicRule[]): CompiledRule[] {
  return rules.map(rule => ({
    rule,
    terms: rule.keywords
      .map(term => ({ term, re: termPattern(term) }))
      .filter((t): t is { term: string; re: RegExp } => !!t.re),
  })).filter(c => c.terms.length > 0);
}

function buildExcerpt(field: TopicField, text: string, start: number, end: number): string {
  const from = Math.max(0, start - EXCERPT_PAD);
  const to = Math.min(text.length, end + EXCERPT_PAD);
  let snip = text.slice(from, to).replace(/\s+/g, ' ').trim();
  if (from > 0) snip = '…' + snip;
  if (to < text.length) snip = snip + '…';
  return `[${field}] ${snip}`.slice(0, EXCERPT_MAX);
}

/** First match of `re` in `text`, or null. Resets lastIndex (the regexes are
 *  /g/ and reused across calls). */
function firstMatch(text: string, re: RegExp): { start: number; end: number } | null {
  re.lastIndex = 0;
  const m = re.exec(text);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length };
}

// ─── Call text extraction ───────────────────────────────────────────────────

/**
 * The searchable text of one call, by field.
 *
 * Included: the speaker-labelled transcript and the summary/tags/coaching from
 * the Claude/Gemini scorecard (analysis_json), the analysis_summary and
 * analysis_outcome columns, and the GRE's own disposition_note.
 *
 * Deliberately EXCLUDED: ct_calls.disposition. That is a dropdown code
 * ('complaint', 'enquiry', …), not something anyone said — matching it would
 * make a "complaint" rule look clever while really just re-reading a filter the
 * Call Log already has.
 */
export function callSearchTexts(call: CallTextRow): { field: TopicField; text: string }[] {
  const out: { field: TopicField; text: string }[] = [];

  let a: any = null;
  if (call.analysis_json) {
    try { a = JSON.parse(call.analysis_json); } catch { a = null; }
  }

  if (a && Array.isArray(a.transcript)) {
    const lines = a.transcript
      .map((l: any) => {
        const speaker = String(l?.speaker ?? '').trim();
        const text = String(l?.text ?? '').trim();
        if (!text) return '';
        return speaker ? `${speaker}: ${text}` : text;
      })
      .filter(Boolean);
    if (lines.length) out.push({ field: 'transcript', text: lines.join('\n') });
  }

  const summary = String(call.analysis_summary || a?.summary || '').trim();
  if (summary) out.push({ field: 'summary', text: summary });

  if (a) {
    const bits: string[] = [];
    for (const key of ['call_type', 'outcome'] as const) {
      const v = String(a[key] ?? '').trim();
      if (v) bits.push(v);
    }
    for (const key of ['tags', 'flags', 'coaching'] as const) {
      if (Array.isArray(a[key])) bits.push(...a[key].map((x: any) => String(x ?? '').trim()).filter(Boolean));
    }
    if (Array.isArray(a.moments)) {
      bits.push(...a.moments.map((m: any) => String(m?.label ?? '').trim()).filter(Boolean));
    }
    if (bits.length) out.push({ field: 'analysis', text: bits.join(' · ') });
  }

  const outcome = String(call.analysis_outcome || '').trim();
  if (outcome) out.push({ field: 'outcome', text: outcome });

  const note = String(call.disposition_note || '').trim();
  if (note) out.push({ field: 'note', text: note });

  return out;
}

/** Does this call carry any text a rule could possibly match? */
export function hasScannableText(call: CallTextRow): boolean {
  return callSearchTexts(call).length > 0;
}

/**
 * Match ONE call against pre-compiled rules. Pure — no DB, no writes.
 * At most MAX_TERMS_PER_CALL_RULE drafts per rule; the first field in
 * TOPIC_FIELDS order that contains a term wins the excerpt.
 */
export function matchCall(call: CallTextRow, compiled: CompiledRule[]): TopicHitDraft[] {
  const texts = callSearchTexts(call);
  if (!texts.length) return [];
  const drafts: TopicHitDraft[] = [];

  for (const c of compiled) {
    let perRule = 0;
    const seenTerms = new Set<string>();
    for (const { term, re } of c.terms) {
      if (perRule >= MAX_TERMS_PER_CALL_RULE) break;
      const canonical = term.toLowerCase();
      if (seenTerms.has(canonical)) continue;
      for (const { field, text } of texts) {
        const hit = firstMatch(text, re);
        if (!hit) continue;
        seenTerms.add(canonical);
        perRule++;
        drafts.push({
          rule_id: c.rule.id,
          rule_name: c.rule.name,
          severity: c.rule.severity,
          notify: c.rule.notify,
          call_id: call.id,
          guest_id: call.guest_id || null,
          matched_term: canonical,
          excerpt: buildExcerpt(field, text, hit.start, hit.end),
          field,
        });
        break;   // first field wins; don't record the same term twice
      }
    }
  }
  return drafts;
}

// ─── Scanning ───────────────────────────────────────────────────────────────

function todayIstYmd(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (isNaN(d.getTime())) return ymd;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface ScanOptions {
  from?: string;              // YYYY-MM-DD (default: 30 days back)
  to?: string;                // YYYY-MM-DD (default: today IST)
  ruleIds?: string[];         // restrict to these rules
  dryRun?: boolean;           // compute only, write nothing
  includeInactive?: boolean;  // dry runs only — preview a rule before enabling it
  limit?: number;
  hitSample?: number;         // cap on hits[] in the response (default 200)
}

/**
 * Scan a date range. Writes only when `dryRun` is false AND the master flag is
 * on; inserts are `INSERT OR IGNORE` against UNIQUE(rule_id, call_id,
 * matched_term), so re-scanning the same range is a genuine no-op.
 */
export function scanCalls(db: Database.Database = getDb(), opts: ScanOptions = {}): ScanResult {
  const enabled = isTopicTrackingOn(db);
  const dryRun = !!opts.dryRun;
  const to = DATE_RE.test(opts.to || '') ? opts.to! : todayIstYmd();
  const from = DATE_RE.test(opts.from || '') ? opts.from! : shiftYmd(to, -30);
  const limit = Math.min(SCAN_CALL_LIMIT, Math.max(1, Number(opts.limit) || SCAN_CALL_LIMIT));
  const hitSample = Math.min(1000, Math.max(1, Number(opts.hitSample) || 200));
  const scannedAt = new Date().toISOString();

  // A persisting scan uses ACTIVE rules only. A dry run may preview inactive
  // ones (that is the point of a preview) but can never write.
  const all = listRules(db, { includeInactive: true });
  const idFilter = opts.ruleIds && opts.ruleIds.length ? new Set(opts.ruleIds) : null;
  const selected = all.filter(r => {
    if (idFilter && !idFilter.has(r.id)) return false;
    // Persisting scan: active rules only, always. Dry run: an explicit rule
    // list or includeInactive means "show me what this WOULD catch", so an
    // inactive rule is previewable; otherwise a plain preview mirrors the real
    // thing and previews only what is switched on.
    if (dryRun && (opts.includeInactive === true || idFilter)) return true;
    return r.is_active === 1;
  });
  const compiled = compileRules(selected);

  const calls = db.prepare(`
    SELECT id, guest_id, analysis_json, analysis_summary, analysis_outcome, disposition_note
    FROM ct_calls
    WHERE substr(COALESCE(NULLIF(started_at, ''), created_at), 1, 10) BETWEEN ? AND ?
    ORDER BY COALESCE(NULLIF(started_at, ''), created_at) DESC
    LIMIT ?
  `).all(from, to, limit) as CallTextRow[];

  // Coverage — reported on every scan so nobody mistakes "0 hits" for "0 issues"
  // when the truth is "no transcripts to read".
  const coverage: ScanCoverage = {
    calls: calls.length,
    with_transcript: 0, with_summary: 0, with_outcome: 0, with_note: 0,
    with_any_text: 0, transcript_lines: 0, ratio: 0,
  };
  const drafts: TopicHitDraft[] = [];
  for (const call of calls) {
    const texts = callSearchTexts(call);
    if (texts.length) coverage.with_any_text++;
    for (const t of texts) {
      if (t.field === 'transcript') {
        coverage.with_transcript++;
        coverage.transcript_lines += t.text.split('\n').length;
      } else if (t.field === 'summary') coverage.with_summary++;
      else if (t.field === 'outcome') coverage.with_outcome++;
      else if (t.field === 'note') coverage.with_note++;
    }
    if (compiled.length) drafts.push(...matchCall(call, compiled));
  }
  coverage.ratio = calls.length ? Math.round((coverage.with_any_text / calls.length) * 1000) / 1000 : 0;

  const persisted = !dryRun && enabled && compiled.length > 0;
  const blocked_reason = dryRun ? ''
    : !enabled ? 'Topic tracking is off (ct_settings topic_tracking = 0) — nothing was recorded.'
    : compiled.length === 0 ? 'No active rules with usable keywords — nothing was recorded.'
    : '';

  const existsStmt = db.prepare(
    `SELECT 1 FROM ct_topic_hits WHERE rule_id = ? AND call_id = ? AND matched_term = ?`,
  );
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO ct_topic_hits
      (id, rule_id, call_id, guest_id, matched_term, excerpt, acknowledged, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `);

  const perRule = new Map<string, ScanRuleResult>();
  for (const r of selected) {
    perRule.set(r.id, {
      rule_id: r.id, name: r.name, severity: r.severity, is_active: r.is_active, notify: r.notify,
      hits: 0, calls: 0, inserted: 0, already_recorded: 0,
      sample_call_id: '', sample_term: '', sample_excerpt: '',
    });
  }
  const ruleCalls = new Map<string, Set<string>>();

  const apply = () => {
    for (const d of drafts) {
      const agg = perRule.get(d.rule_id);
      if (!agg) continue;
      agg.hits++;
      if (!ruleCalls.has(d.rule_id)) ruleCalls.set(d.rule_id, new Set());
      ruleCalls.get(d.rule_id)!.add(d.call_id);
      if (!agg.sample_excerpt) {
        agg.sample_call_id = d.call_id;
        agg.sample_term = d.matched_term;
        agg.sample_excerpt = d.excerpt;
      }
      if (persisted) {
        const res = insertStmt.run(
          generateId(), d.rule_id, d.call_id, d.guest_id, d.matched_term, d.excerpt, scannedAt,
        );
        if (res.changes > 0) agg.inserted++;
        else { agg.already_recorded++; d.already_recorded = true; }
      } else {
        const seen = !!existsStmt.get(d.rule_id, d.call_id, d.matched_term);
        d.already_recorded = seen;
        if (seen) agg.already_recorded++;
      }
    }
  };

  if (persisted) db.transaction(apply)();
  else apply();

  for (const [ruleId, set] of ruleCalls) {
    const agg = perRule.get(ruleId);
    if (agg) agg.calls = set.size;
  }

  const per_rule = [...perRule.values()].sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name));
  return {
    enabled, dry_run: dryRun, persisted, blocked_reason,
    from, to,
    rules_used: compiled.length,
    coverage,
    total_hits: drafts.length,
    inserted: per_rule.reduce((s, r) => s + r.inserted, 0),
    already_recorded: per_rule.reduce((s, r) => s + r.already_recorded, 0),
    per_rule,
    hits: drafts.slice(0, hitSample),
    scanned_at: scannedAt,
  };
}

// ─── Seed rules (INACTIVE examples) ─────────────────────────────────────────

/**
 * Four rules an actual restaurant wants, seeded INACTIVE so nothing starts
 * alerting unasked. Plural/variant forms are listed explicitly because the
 * matcher does no stemming (see the limits on termPattern()).
 */
export const SEED_RULES: { name: string; severity: TopicSeverity; notify: number; keywords: string[] }[] = [
  {
    name: 'Birthday & Anniversary',
    severity: 'info',
    notify: 0,
    keywords: [
      'birthday', 'birthdays', 'bday', "b'day", 'anniversary', 'anniversaries',
      'celebration', 'celebrating', 'celebrate', 'cake', 'surprise',
      'engagement', 'baby shower',
    ],
  },
  {
    name: 'Complaint / service recovery',
    severity: 'urgent',
    notify: 1,
    keywords: [
      'complaint', 'complaints', 'complain', 'complained', 'complaining',
      'refund', 'refunded', 'rude', 'unhappy', 'disappointed', 'disappointing',
      'poor service', 'bad service', 'bad experience', 'worst', 'terrible',
      'stale', 'spoiled', 'undercooked', 'overcharged', 'wrong bill',
      'never coming back', 'speak to the manager',
    ],
  },
  {
    name: 'Large group / party enquiry',
    severity: 'attention',
    notify: 1,
    keywords: [
      'party', 'parties', 'banquet', 'group booking', 'large group', 'big group',
      'bulk booking', 'corporate', 'get together', 'get-together', 'reunion',
      'private dining', 'function', 'hall', 'pax', 'buffet', 'package',
    ],
  },
  {
    name: 'Dietary request',
    severity: 'attention',
    notify: 0,
    keywords: [
      'jain', 'vegan', 'gluten', 'gluten free', 'gluten-free', 'allergy',
      'allergic', 'allergies', 'nut allergy', 'halal', 'no onion', 'no garlic',
      'diabetic', 'lactose', 'dairy free', 'dairy-free', 'pure veg', 'eggless',
    ],
  },
];

/**
 * Insert the example rules that don't already exist (matched case-insensitively
 * on name). Idempotent; never overwrites a rule the venue has edited.
 */
export function seedExampleRules(
  db: Database.Database = getDb(),
  createdBy = 'system',
): { created: string[]; skipped: string[] } {
  const created: string[] = [];
  const skipped: string[] = [];
  const find = db.prepare(`SELECT id FROM ct_topic_rules WHERE lower(name) = lower(?)`);
  const ins = db.prepare(`
    INSERT INTO ct_topic_rules (id, name, keywords, severity, is_active, notify, created_by, created_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const r of SEED_RULES) {
      if (find.get(r.name)) { skipped.push(r.name); continue; }
      // is_active is hard-coded 0 in the SQL above — a seeded example NEVER
      // arrives switched on.
      ins.run(generateId(), r.name, JSON.stringify(normalizeKeywords(r.keywords)), r.severity, r.notify ? 1 : 0, createdBy, now);
      created.push(r.name);
    }
  })();
  return { created, skipped };
}

// ─── Hits ───────────────────────────────────────────────────────────────────

export interface HitRow {
  id: string;
  rule_id: string;
  call_id: string;
  guest_id: string | null;
  matched_term: string;
  excerpt: string;
  acknowledged: number;
  created_at: string;
  rule_name: string;
  severity: TopicSeverity;
  notify: number;
  guest_name: string | null;
  guest_phone: string | null;
  call_started_at: string | null;
  call_direction: string | null;
  call_status: string | null;
  call_agent: string | null;
  call_duration_sec: number | null;
}

export interface HitQuery {
  ruleId?: string;
  acknowledged?: 0 | 1 | null;   // null/undefined = both
  from?: string;
  to?: string;
  limit?: number;
}

export function listHits(db: Database.Database = getDb(), q: HitQuery = {}): HitRow[] {
  const where: string[] = [];
  const params: any[] = [];
  if (q.ruleId) { where.push('h.rule_id = ?'); params.push(q.ruleId); }
  if (q.acknowledged === 0 || q.acknowledged === 1) { where.push('h.acknowledged = ?'); params.push(q.acknowledged); }
  if (q.from && DATE_RE.test(q.from)) { where.push('substr(h.created_at, 1, 10) >= ?'); params.push(q.from); }
  if (q.to && DATE_RE.test(q.to)) { where.push('substr(h.created_at, 1, 10) <= ?'); params.push(q.to); }
  const limit = Math.min(1000, Math.max(1, Number(q.limit) || 300));
  const rows = db.prepare(`
    SELECT h.*,
           r.name AS rule_name, r.severity AS severity, r.notify AS notify,
           g.name AS guest_name, g.phone_e164 AS guest_phone,
           c.started_at AS call_started_at, c.direction AS call_direction,
           c.status AS call_status, c.agent_user AS call_agent,
           c.duration_sec AS call_duration_sec
    FROM ct_topic_hits h
    JOIN ct_topic_rules r ON r.id = h.rule_id
    LEFT JOIN ct_guests g ON g.id = h.guest_id
    LEFT JOIN ct_calls  c ON c.id = h.call_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY h.acknowledged ASC, h.created_at DESC
    LIMIT ${limit}
  `).all(...params) as any[];
  return rows.map(r => ({ ...r, severity: normalizeSeverity(r.severity), notify: r.notify ? 1 : 0 })) as HitRow[];
}

/** Unacknowledged hits on rules with notify=1 — the in-app "needs a look" count.
 *  There is no send path; this number is only ever rendered in the app. */
export function alertCount(db: Database.Database = getDb()): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM ct_topic_hits h
    JOIN ct_topic_rules r ON r.id = h.rule_id
    WHERE h.acknowledged = 0 AND r.notify = 1 AND r.is_active = 1
  `).get() as any;
  return row?.n ?? 0;
}

// ─── Post-analysis hook (written, deliberately NOT wired) ───────────────────

/**
 * HOOK POINT — how this becomes automatic later, in one line.
 *
 * src/lib/ct/analyze.ts owns the analysis path and is NOT edited by this
 * feature. When someone does wire it, the call goes inside analyzeCtCall(),
 * AFTER the scorecard has been persisted and immediately BEFORE each of its two
 * success returns — src/lib/ct/analyze.ts:162 (structured scorecard) and
 * src/lib/ct/analyze.ts:177 (model returned unstructured output). NOT before
 * the early cache return at analyze.ts:90: that path re-serves an already
 * analyzed call and would re-scan on every view for nothing (the INSERT OR
 * IGNORE makes it harmless, just wasted work).
 *
 *     import { scanCallAfterAnalysis } from './topics';
 *     …
 *     scanCallAfterAnalysis(callId, db);   // no-op unless topic tracking is on
 *
 * Three properties make that safe:
 *   • It is synchronous and cheap — regex over one call's text, no network.
 *   • It never throws; a failure is logged and swallowed, so a topic-rule bug
 *     can never fail an analysis that already succeeded.
 *   • It self-gates on the master flag AND on ephemeral retention: in ephemeral
 *     mode nothing about the call is stored, so recording an excerpt from that
 *     transcript would leak exactly what that mode promises not to keep.
 *
 * Placing it after the persist (not before) means a hit always points at a call
 * whose analysis is actually readable when the reviewer clicks through.
 */
export function scanCallAfterAnalysis(
  callId: string,
  db: Database.Database = getDb(),
): { inserted: number; skipped: string } {
  try {
    if (!isTopicTrackingOn(db)) return { inserted: 0, skipped: 'topic tracking off' };
    // Ephemeral retention keeps NO transcript on the call — don't mirror one
    // into an excerpt. (Read directly so this file never imports analyze.ts.)
    if (ctSetting(db, 'analysis_retention') === 'ephemeral') {
      return { inserted: 0, skipped: 'ephemeral retention' };
    }
    const call = db.prepare(`
      SELECT id, guest_id, analysis_json, analysis_summary, analysis_outcome, disposition_note
      FROM ct_calls WHERE id = ?
    `).get(callId) as CallTextRow | undefined;
    if (!call) return { inserted: 0, skipped: 'call not found' };

    const compiled = compileRules(listRules(db, { includeInactive: false }));
    if (!compiled.length) return { inserted: 0, skipped: 'no active rules' };

    const drafts = matchCall(call, compiled);
    if (!drafts.length) return { inserted: 0, skipped: '' };

    const ins = db.prepare(`
      INSERT OR IGNORE INTO ct_topic_hits
        (id, rule_id, call_id, guest_id, matched_term, excerpt, acknowledged, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `);
    const now = new Date().toISOString();
    let inserted = 0;
    db.transaction(() => {
      for (const d of drafts) {
        inserted += ins.run(generateId(), d.rule_id, d.call_id, d.guest_id, d.matched_term, d.excerpt, now).changes;
      }
    })();
    return { inserted, skipped: '' };
  } catch (e) {
    console.warn('[ct topics] scanCallAfterAnalysis failed', e);
    return { inserted: 0, skipped: 'error' };
  }
}
