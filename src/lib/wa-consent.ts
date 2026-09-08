/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WhatsApp MARKETING CONSENT — the one place opt-out state is read or written.
 *
 * MODEL (see the schema comment in db.ts):
 *   • Keyed by phone_key = norm10 — the guest-unify join key — because
 *     loyalty/dining-only guests are SYNTHETIC (no row in any table) and
 *     consent must survive across all three phone-keyed guest sources.
 *   • NO ROW = MESSAGEABLE. That is the honest default for existing data:
 *     nobody ever opted out, so nobody is recorded as opted out. Rows exist
 *     only for explicit states ('opted_out' | 'opted_in'); 'opted_in' is a
 *     manual override of an earlier STOP, never the default.
 *   • Every flip appends to wa_consent_log — consent disputes are exactly
 *     where history matters.
 *
 * STOP DETECTION — deliberately conservative:
 *   • WHOLE-MESSAGE match only, after normalising case/whitespace/trailing
 *     punctuation. "please stop by at 8" must never opt a guest out; a
 *     message that IS just "STOP" (or a quick-reply button titled Stop) must.
 *   • Keyword list is a ct_settings knob ('wa_stop_keywords', comma/newline
 *     separated) with English + romanised/Devanagari Hindi + Telugu defaults.
 *   • There is NO inbound START keyword on purpose. The webhook is public and
 *     unsigned — a forged POST opting someone OUT is fail-safe; a forged
 *     re-opt-IN is not. Opting back in is manual-only (management).
 */
import type Database from 'better-sqlite3';
import { ctSetting, setCtSetting } from '@/lib/ct/settings';

type DB = Database.Database;

export const STOP_KEYWORDS_SETTING = 'wa_stop_keywords';

/** Default STOP-class keywords (English, Hindi, Telugu). Whole-message match. */
export const DEFAULT_STOP_KEYWORDS = [
  'stop', 'unsubscribe', 'unsub', 'stop all', 'stopall', 'opt out', 'optout',
  'no more messages', 'dont send', "don't send",
  // POLITE VARIANTS — added because detectStop matches on EXACT equality, not
  // containment, and real guests rarely send the bare word. A verifier proved
  // "stop please" sailed through and kept the guest on the list; a guest who
  // asked twice and got another campaign is precisely what tanks the number's
  // quality rating. Listed explicitly rather than switching to substring
  // matching, which would opt out "don't stop sending me offers" — exact match
  // is the property that makes this safe, so it is kept and the list widened.
  'stop please', 'please stop', 'stop it', 'stop sending', 'stop sending messages',
  'stop messaging', 'stop messaging me', 'stop messages', 'stop msg', 'stop msgs',
  'no more', 'remove me', 'remove my number', 'do not send', 'do not disturb',
  'dnd', 'leave me alone', 'not interested',
  // Hindi (romanised + Devanagari)
  'band karo', 'band kar do', 'mat bhejo', 'message mat bhejo', 'msg mat bhejo',
  'बंद करो', 'बंद कर दो', 'मत भेजो', 'मैसेज मत भेजो',
  // Telugu
  'వద్దు', 'ఆపండి', 'పంపవద్దు', 'మెసేజ్ వద్దు', 'aapandi', 'pampavaddu',
];

export type ConsentStatus = 'opted_out' | 'opted_in';

export interface ConsentRow {
  phone_key: string;
  status: ConsentStatus;
  source: string;
  detail: string;
  changed_by: string;
  changed_at: string;
}

/** Normalise a message/keyword for whole-message comparison. */
export function normalizeStopText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')       // zero-width/format chars
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!।?]+$/g, '')                // trailing sentence punctuation
    .trim()
    .toLowerCase();
}

/** The configured STOP keyword list (normalised, deduped). Never throws. */
export function stopKeywords(db: DB): string[] {
  let raw = '';
  try { raw = ctSetting(db, STOP_KEYWORDS_SETTING); } catch { raw = ''; }
  const src = raw.trim() ? raw.split(/[,\n]/) : DEFAULT_STOP_KEYWORDS;
  const out: string[] = [];
  for (const k of src) {
    const n = normalizeStopText(k);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

export function setStopKeywords(db: DB, keywords: string[]): void {
  setCtSetting(db, STOP_KEYWORDS_SETTING, keywords.map(k => String(k).trim()).filter(Boolean).join(', '));
}

/**
 * Does this inbound message mean "stop messaging me"?
 * Only text bodies and quick-reply button/list titles are eligible — a STOP
 * can arrive as type 'text', or as type 'button'/'interactive' whose title is
 * the keyword (extractContent puts the title in body). Returns the matched
 * keyword, or null.
 */
export function detectStop(db: DB, msgType: string, body: string): string | null {
  if (msgType !== 'text' && msgType !== 'button' && msgType !== 'interactive') return null;
  const msg = normalizeStopText(body);
  if (!msg || msg.length > 60) return null;   // a paragraph is never a STOP
  for (const kw of stopKeywords(db)) {
    if (msg === kw) return kw;
  }
  return null;
}

/** Current consent row for one phone_key, or null (= default, messageable). */
export function consentFor(db: DB, phoneKey: string): ConsentRow | null {
  if (!phoneKey) return null;
  try {
    const row = db.prepare(`SELECT * FROM wa_marketing_consent WHERE phone_key = ?`).get(phoneKey) as any;
    return row ? (row as ConsentRow) : null;
  } catch { return null; }
}

/** THE send-time gate. True only for an explicit, standing opt-out. */
export function isOptedOut(db: DB, phoneKey: string): boolean {
  return consentFor(db, phoneKey)?.status === 'opted_out';
}

/** Bulk consent lookup for previews/reports. Missing keys = default (in). */
export function consentMap(db: DB, keys: string[]): Map<string, ConsentRow> {
  const out = new Map<string, ConsentRow>();
  const want = new Set(keys.filter(Boolean));
  if (!want.size) return out;
  try {
    const rows = db.prepare(`SELECT * FROM wa_marketing_consent`).all() as any[];
    for (const r of rows) {
      if (want.has(String(r.phone_key))) out.set(String(r.phone_key), r as ConsentRow);
    }
  } catch { /* table missing on stripped DBs → default-in */ }
  return out;
}

export interface SetConsentInput {
  phoneKey: string;
  status: ConsentStatus;
  /** 'stop_keyword' | 'meta_131050' | 'manual' */
  source: string;
  detail?: string;
  changedBy?: string;
}

/**
 * Record a consent flip (upsert + append-only log). Idempotent for repeats of
 * the same status: the standing row is refreshed, the log still records the
 * event (a second STOP is still an event). Never throws.
 */
export function setConsent(db: DB, input: SetConsentInput): boolean {
  const key = String(input.phoneKey || '').trim();
  if (!key) return false;
  const status: ConsentStatus = input.status === 'opted_in' ? 'opted_in' : 'opted_out';
  const source = String(input.source || '').slice(0, 60);
  const detail = String(input.detail || '').slice(0, 300);
  const by = String(input.changedBy || '').slice(0, 200);
  try {
    db.prepare(`
      INSERT INTO wa_marketing_consent (phone_key, status, source, detail, changed_by, changed_at)
      VALUES (@key, @status, @source, @detail, @by, datetime('now'))
      ON CONFLICT(phone_key) DO UPDATE SET
        status = excluded.status, source = excluded.source, detail = excluded.detail,
        changed_by = excluded.changed_by, changed_at = excluded.changed_at
    `).run({ key, status, source, detail, by });
    db.prepare(`
      INSERT INTO wa_consent_log (phone_key, status, source, detail, changed_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(key, status, source, detail, by);
    return true;
  } catch (e: any) {
    console.error('[wa-consent] setConsent failed:', e?.message);
    return false;
  }
}

/** Every standing explicit consent row (for the management consent screen). */
export function listConsent(db: DB, opts: { status?: ConsentStatus; limit?: number } = {}): ConsentRow[] {
  const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 5000);
  try {
    if (opts.status) {
      return db.prepare(`SELECT * FROM wa_marketing_consent WHERE status = ? ORDER BY changed_at DESC LIMIT ?`)
        .all(opts.status, limit) as any[];
    }
    return db.prepare(`SELECT * FROM wa_marketing_consent ORDER BY changed_at DESC LIMIT ?`).all(limit) as any[];
  } catch { return []; }
}

/** Recent flips for one phone (audit trail on the guest/thread views). */
export function consentHistory(db: DB, phoneKey: string, limit = 20): any[] {
  if (!phoneKey) return [];
  try {
    return db.prepare(`SELECT * FROM wa_consent_log WHERE phone_key = ? ORDER BY id DESC LIMIT ?`)
      .all(phoneKey, Math.min(Math.max(limit, 1), 200)) as any[];
  } catch { return []; }
}
