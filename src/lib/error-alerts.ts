/**
 * Crash-proofing — production error capture + admin alerting.
 *
 * Every uncaught client error, unhandled promise rejection, React error-boundary
 * hit, and server-side `onRequestError` funnels into `recordError()`, which:
 *   1. clips + stores the error in `error_reports` (deduping identical errors
 *      into a single OPEN row with a bumped count — a crash loop can never flood
 *      the table or the admin bell), and
 *   2. lets the caller fire a best-effort, rate-limited admin alert.
 *
 * Admin visibility (role-scoped, no phone needed): an "App errors" bucket in the
 * notification bell (see /api/notifications/inbox) + the /settings/errors page.
 * Optional extra: a WhatsApp ping to the number in the `error_alert_phone`
 * setting, if configured AND WhatsApp is set up (never throws, heavily throttled).
 *
 * EVERYTHING here is defensive: this module exists to REPORT crashes, so it must
 * never BE a crash. Every export is wrapped so a failure degrades to a no-op.
 */
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from './db';

export type ErrorSource = 'web' | 'captain' | 'server' | 'client';

const MAX = { message: 2000, stack: 8000, url: 1000, ua: 400, email: 200, role: 40 } as const;

// Bounds so a flood of DISTINCT error messages can never grow the shared DB
// unbounded. Once this many distinct errors are open, further NEW ones collapse
// into a single per-source "flood" row instead of inserting endlessly.
const MAX_OPEN_DIGESTS = 800;
const HARD_ROW_CAP = 5000;      // absolute ceiling; oldest RESOLVED rows pruned past this
const PRUNE_EVERY = 50;         // run housekeeping roughly every N inserts
let insertsSincePrune = 0;

/** Opportunistic housekeeping: drop old resolved rows + enforce the hard cap.
 *  Runs ~1/PRUNE_EVERY inserts so it never adds latency to every report. */
function maybePrune(db: Database.Database): void {
  if (++insertsSincePrune < PRUNE_EVERY) return;
  insertsSincePrune = 0;
  try {
    db.prepare(`DELETE FROM error_reports WHERE resolved_at IS NOT NULL AND last_seen < datetime('now','-30 days')`).run();
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM error_reports`).get() as { n: number })?.n || 0);
    if (total > HARD_ROW_CAP) {
      db.prepare(
        `DELETE FROM error_reports WHERE id IN (
           SELECT id FROM error_reports WHERE resolved_at IS NOT NULL ORDER BY last_seen ASC LIMIT ?
         )`,
      ).run(total - HARD_ROW_CAP);
    }
  } catch { /* housekeeping is best-effort */ }
}

function clip(v: unknown, n: number): string {
  const s = v == null ? '' : String(v);
  return s.length > n ? s.slice(0, n) : s;
}

function normalizeSource(s: unknown): ErrorSource {
  return s === 'captain' || s === 'server' || s === 'client' ? s : 'web';
}

/** Stable dedup key: source + normalized message + a coarse "where" (first stack
 *  frame or URL path). Line/col noise is stripped so the same bug collapses. */
export function digestOf(source: string, message: string, where: string): string {
  const norm = `${source}|${message}|${where}`
    .replace(/\d{2,}/g, '#')          // strip long numbers (ids, timestamps, line:col)
    .replace(/0x[0-9a-f]+/gi, '#')
    .slice(0, 500);
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

/** First meaningful stack frame (for the digest "where"), else the URL path. */
function whereKey(stack: string, url: string): string {
  const line = stack.split('\n').map((l) => l.trim()).find((l) => l.startsWith('at ') && !l.includes('error-alerts'));
  if (line) return line.replace(/:\d+:\d+/g, '').slice(0, 200);
  try { return new URL(url).pathname; } catch { return clip(url, 200); }
}

export interface RecordErrorInput {
  message: string;
  stack?: string;
  source?: string;
  url?: string;
  userEmail?: string;
  userRole?: string;
  userAgent?: string;
}

export interface RecordErrorResult {
  id: string;
  digest: string;
  isNew: boolean;
  count: number;
  message: string;
  source: ErrorSource;
}

/**
 * Store (or dedup-merge) one error. Synchronous (better-sqlite3). Returns null
 * only if the DB write itself fails — callers treat null as "couldn't record".
 */
export function recordError(input: RecordErrorInput): RecordErrorResult | null {
  try {
    const db = getDb();
    const source = normalizeSource(input.source);
    const message = clip(input.message, MAX.message).trim() || 'Unknown error';
    const stack = clip(input.stack, MAX.stack);
    const url = clip(input.url, MAX.url);
    const userEmail = clip(input.userEmail, MAX.email);
    const userRole = clip(input.userRole, MAX.role);
    const userAgent = clip(input.userAgent, MAX.ua);
    const digest = digestOf(source, message, whereKey(stack, url));

    // Collapse onto an existing OPEN row with the same digest.
    const existing = db
      .prepare(`SELECT id, count FROM error_reports WHERE digest = ? AND resolved_at IS NULL ORDER BY last_seen DESC LIMIT 1`)
      .get(digest) as { id: string; count: number } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE error_reports
           SET count = count + 1, last_seen = datetime('now'),
               message = ?, stack = ?, url = ?, user_email = ?, user_role = ?, user_agent = ?
         WHERE id = ?`,
      ).run(message, stack, url, userEmail, userRole, userAgent, existing.id);
      return { id: existing.id, digest, isNew: false, count: existing.count + 1, message, source };
    }

    // Flood guard: if there are already too many distinct OPEN errors, collapse
    // any further NEW ones into a single per-source "flood" row so a stream of
    // unique messages can't insert unbounded rows into the shared DB.
    const openCount = Number((db.prepare(`SELECT COUNT(*) AS n FROM error_reports WHERE resolved_at IS NULL`).get() as { n: number })?.n || 0);
    if (openCount >= MAX_OPEN_DIGESTS) {
      const floodDigest = `flood_${source}`;
      const floodMsg = `(too many distinct errors — flood; latest) ${message}`.slice(0, MAX.message);
      const floodRow = db.prepare(`SELECT id, count FROM error_reports WHERE digest = ? AND resolved_at IS NULL LIMIT 1`).get(floodDigest) as { id: string; count: number } | undefined;
      if (floodRow) {
        db.prepare(`UPDATE error_reports SET count = count + 1, last_seen = datetime('now'), message = ?, stack = ?, url = ? WHERE id = ?`)
          .run(floodMsg, stack, url, floodRow.id);
        return { id: floodRow.id, digest: floodDigest, isNew: false, count: floodRow.count + 1, message, source };
      }
      const fid = 'err_' + crypto.randomBytes(8).toString('hex');
      db.prepare(`INSERT INTO error_reports (id, digest, source, message, stack, url, user_email, user_role, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(fid, floodDigest, source, floodMsg, stack, url, userEmail, userRole, userAgent);
      return { id: fid, digest: floodDigest, isNew: true, count: 1, message, source };
    }

    const id = 'err_' + crypto.randomBytes(8).toString('hex');
    db.prepare(
      `INSERT INTO error_reports (id, digest, source, message, stack, url, user_email, user_role, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, digest, source, message, stack, url, userEmail, userRole, userAgent);
    maybePrune(db);
    return { id, digest, isNew: true, count: 1, message, source };
  } catch (e) {
    // Last-resort: never let the error reporter throw.
    try { console.error('[error-alerts] recordError failed:', e); } catch { /* ignore */ }
    return null;
  }
}

/** Count of unresolved errors — feeds the admin-only notification-bell bucket. */
export function unresolvedErrorCount(db: Database.Database): number {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM error_reports WHERE resolved_at IS NULL`).get() as { n: number };
    return Number(r?.n || 0);
  } catch { return 0; }
}

export interface ErrorRow {
  id: string; digest: string; source: string; message: string; stack: string;
  url: string; user_email: string; user_role: string; user_agent: string;
  count: number; first_seen: string; last_seen: string;
  resolved_at: string | null; resolved_by: string; notified_at: string | null;
}

export function listErrors(db: Database.Database, opts?: { limit?: number; includeResolved?: boolean }): ErrorRow[] {
  try {
    const limit = Math.min(Math.max(Number(opts?.limit) || 100, 1), 500);
    const where = opts?.includeResolved ? '1=1' : 'resolved_at IS NULL';
    return db
      .prepare(`SELECT * FROM error_reports WHERE ${where} ORDER BY (resolved_at IS NULL) DESC, last_seen DESC LIMIT ?`)
      .all(limit) as ErrorRow[];
  } catch { return []; }
}

export function resolveError(db: Database.Database, id: string, by: string): boolean {
  try {
    const r = db
      .prepare(`UPDATE error_reports SET resolved_at = datetime('now'), resolved_by = ? WHERE id = ? AND resolved_at IS NULL`)
      .run(clip(by, MAX.email), String(id));
    return r.changes > 0;
  } catch { return false; }
}

/** Resolve every open row sharing a digest (a "resolve all like this"). */
export function resolveAllOpen(db: Database.Database, by: string): number {
  try {
    const r = db
      .prepare(`UPDATE error_reports SET resolved_at = datetime('now'), resolved_by = ? WHERE resolved_at IS NULL`)
      .run(clip(by, MAX.email));
    return r.changes;
  } catch { return 0; }
}

// ── Optional WhatsApp alert to a configured admin number ─────────────────────

export function getAlertPhone(db: Database.Database): string {
  try {
    const r = db.prepare(`SELECT value FROM settings WHERE key = 'error_alert_phone'`).get() as { value?: string } | undefined;
    return (r?.value || '').trim();
  } catch { return ''; }
}

export function setAlertPhone(db: Database.Database, phone: string): void {
  // Sanitize FIRST, then clip — so the 24-char budget applies to real digits,
  // not to formatting characters that get stripped anyway.
  const clean = clip(String(phone ?? '').replace(/[^0-9+]/g, ''), 24);
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('error_alert_phone', ?)`).run(clean);
}

/**
 * Report a CAUGHT server-side error (a handler that try/catches and returns a
 * 500 JSON body — which Next's onRequestError never sees). Opt-in: call this
 * from a catch block to also surface it in the admin App Errors console.
 * Best-effort, never throws.
 */
export function reportServerError(err: unknown, ctx?: { url?: string; source?: ErrorSource }): void {
  try {
    const e = err as { message?: string; stack?: string } | undefined;
    const res = recordError({
      message: e?.message || String(err),
      stack: e?.stack || '',
      source: ctx?.source || 'server',
      url: ctx?.url || '',
    });
    if (res?.isNew) void maybeNotifyAdmins(res);
  } catch { /* never throw from the reporter */ }
}

// In-process throttle: at most ONE WhatsApp per digest per hour, and a global
// cap so a burst of distinct errors can't spam. Resets on server restart (fine —
// the DB is the durable record; WhatsApp is a best-effort nudge).
const notifyAt = new Map<string, number>();
const globalWindow: number[] = [];
const PER_DIGEST_MS = 60 * 60 * 1000;   // 1h per unique error
const GLOBAL_MAX = 8;                    // max alerts…
const GLOBAL_WINDOW_MS = 60 * 60 * 1000; // …per hour

/**
 * Fire-and-forget admin alert for a freshly-recorded error. Best-effort:
 * returns quietly if no alert phone is set, WhatsApp is unconfigured, the
 * throttle is hit, or the send fails. NEVER throws.
 */
export async function maybeNotifyAdmins(res: RecordErrorResult): Promise<void> {
  try {
    const db = getDb();
    const phone = getAlertPhone(db);
    if (!phone) return;                       // in-app bell/page is the guaranteed channel

    const now = Date.now();
    const last = notifyAt.get(res.digest) || 0;
    if (now - last < PER_DIGEST_MS) return;   // already pinged for this bug recently

    // Global hourly cap.
    while (globalWindow.length && now - globalWindow[0] > GLOBAL_WINDOW_MS) globalWindow.shift();
    if (globalWindow.length >= GLOBAL_MAX) return;

    notifyAt.set(res.digest, now);
    globalWindow.push(now);

    const { sendWhatsAppMessage } = await import('./whatsapp');
    const body =
      `🔴 AKAN app error (${res.source})\n` +
      `${res.message}\n` +
      `Seen ${res.count}× · check Settings → App Errors`;
    const sent = await sendWhatsAppMessage(phone, body).catch(() => ({ ok: false } as { ok: boolean }));

    // Only mark "notified" when a message actually went out — WhatsApp returns
    // { ok:false } (not a throw) when unconfigured/failed, and the admin console
    // shows "WhatsApp sent" off notified_at, so a false stamp would mislead.
    if (sent && (sent as { ok?: boolean }).ok) {
      try { db.prepare(`UPDATE error_reports SET notified_at = datetime('now') WHERE id = ?`).run(res.id); } catch { /* ignore */ }
    }
  } catch (e) {
    try { console.error('[error-alerts] maybeNotifyAdmins failed:', e); } catch { /* ignore */ }
  }
}
