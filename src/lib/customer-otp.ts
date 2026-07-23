import type Database from 'better-sqlite3';
import { createHash, randomInt, randomBytes } from 'crypto';
import { isWaConfigured, getWaConfigRaw } from '@/lib/whatsapp';
import { parseStoredPhone } from '@/lib/mobile-input';

/**
 * WhatsApp OTP for QR self-orders. A verified mobile is captured before a
 * captain-less ("direct") order fires, so an abandoned/unpaid bill always has a
 * real number to call. All state lives in `customer_otps`; codes are hashed, so
 * a plaintext code is never stored.
 */

export const OTP_TTL_SECONDS = 300;          // a code is valid for 5 minutes
export const OTP_MAX_ATTEMPTS = 5;           // wrong-code tries before a code is dead
export const RESEND_COOLDOWN_SECONDS = 45;   // min gap between sends to one number+table
export const MAX_SENDS_PER_HOUR = 6;         // spam / cost guard per number+table
export const MAX_TABLE_SENDS_PER_HOUR = 25;  // OTP-bombing guard: total sends per TABLE (any number)
export const VERIFIED_TTL_SECONDS = 6 * 3600; // a verified number stays verified for the session

/** Canonical mobile for OTP + order storage. India (+91) → bare 10-digit,
 *  EXACTLY as before (so OTP hash + guest_mobile are unchanged for the common
 *  case); a foreign number carrying its own country code → E.164 ('+<cc><nsn>').
 *  The SAME normalisation runs on send, verify and order so they always match. */
export function normMobile(m: string): string {
  const { dialCode, national } = parseStoredPhone(m);
  if (!national) return '';
  return dialCode === '91' ? national : `+${dialCode}${national}`;
}

function hashCode(mobile: string, code: string): string {
  return createHash('sha256').update(`${normMobile(mobile)}:${code}`).digest('hex');
}

/** Can we actually SEND an OTP right now? (provider configured + an OTP template set.) */
export function otpChannelReady(): boolean {
  const raw = getWaConfigRaw();
  return isWaConfigured(raw) && !!String(raw.wa_otp_template || '').trim();
}

/**
 * Rate-limit a send. Three independent guards:
 *  - 'cooldown'   : 45s since the last send to this number+table (guest retries too fast).
 *  - 'hourly_cap' : 6 sends/hour to one number+table.
 *  - 'table_cap'  : 25 sends/hour across the WHOLE table (any numbers) — stops a
 *                   scripted attacker rotating victim numbers through one QR token
 *                   from running up the venue's WhatsApp bill / getting it spam-flagged.
 * retryAfter is the REAL number of seconds until the guard clears (not a flat 3600).
 */
export function canSendOtp(db: Database.Database, tableId: string, mobile: string): { ok: boolean; retryAfter?: number; reason?: 'cooldown' | 'hourly_cap' | 'table_cap' } {
  const mob = normMobile(mobile);
  const last = db.prepare(
    `SELECT sent_at, CAST(strftime('%s','now') - strftime('%s', sent_at) AS INTEGER) AS ago
     FROM customer_otps WHERE table_id = ? AND mobile = ? ORDER BY sent_at DESC LIMIT 1`
  ).get(tableId, mob) as any;
  if (last && Number(last.ago) < RESEND_COOLDOWN_SECONDS) {
    return { ok: false, retryAfter: RESEND_COOLDOWN_SECONDS - Number(last.ago), reason: 'cooldown' };
  }
  // Seconds until the OLDEST send inside the window ages out — the honest wait.
  const windowRetry = (rows: any): number =>
    Math.max(60, 3600 - Number(rows?.oldest_ago || 0));
  const hour = db.prepare(
    `SELECT COUNT(*) AS n, MAX(CAST(strftime('%s','now') - strftime('%s', sent_at) AS INTEGER)) AS oldest_ago
     FROM customer_otps WHERE table_id = ? AND mobile = ? AND sent_at >= datetime('now','-1 hour')`
  ).get(tableId, mob) as any;
  if (Number(hour?.n || 0) >= MAX_SENDS_PER_HOUR) {
    return { ok: false, retryAfter: windowRetry(hour), reason: 'hourly_cap' };
  }
  const tbl = db.prepare(
    `SELECT COUNT(*) AS n, MAX(CAST(strftime('%s','now') - strftime('%s', sent_at) AS INTEGER)) AS oldest_ago
     FROM customer_otps WHERE table_id = ? AND sent_at >= datetime('now','-1 hour')`
  ).get(tableId) as any;
  if (Number(tbl?.n || 0) >= MAX_TABLE_SENDS_PER_HOUR) {
    return { ok: false, retryAfter: windowRetry(tbl), reason: 'table_cap' };
  }
  return { ok: true };
}

/**
 * Is this guest's OTP path exhausted (their hourly cap, or the table's) right
 * now? Used by the orders route to fall back to captain approval instead of
 * 428-ing a guest who is rate-limited out of ever verifying.
 */
export function otpSendExhausted(db: Database.Database, tableId: string, mobile: string): boolean {
  const rl = canSendOtp(db, tableId, mobile);
  return !rl.ok && (rl.reason === 'hourly_cap' || rl.reason === 'table_cap');
}

/** Generate + store a fresh OTP; returns the plaintext code + the row id. */
export function createOtp(db: Database.Database, args: { outletId: string | null; tableId: string; mobile: string }): { code: string; id: string } {
  // Opportunistic purge: OTP rows are single-use with a 6h verified window —
  // nothing needs them after a week. Keeps the table (and stored guest
  // numbers) bounded without a cron.
  try { db.prepare("DELETE FROM customer_otps WHERE sent_at < datetime('now','-7 day')").run(); } catch {}
  const mob = normMobile(args.mobile);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const id = randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO customer_otps (id, outlet_id, table_id, mobile, code_hash, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', ?))
  `).run(id, args.outletId || null, args.tableId, mob, hashCode(mob, code), `+${OTP_TTL_SECONDS} seconds`);
  return { code, id };
}

/** Check a code against the latest live OTP for this number+table. */
export function verifyOtp(db: Database.Database, args: { tableId: string; mobile: string; code: string }): { ok: boolean; reason?: string } {
  const mob = normMobile(args.mobile);
  const code = String(args.code || '').replace(/\D/g, '');
  if (code.length < 4) return { ok: false, reason: 'bad_code' };

  const row = db.prepare(`
    SELECT id, code_hash, attempts,
           CASE WHEN expires_at <= datetime('now') THEN 1 ELSE 0 END AS expired
    FROM customer_otps
    WHERE table_id = ? AND mobile = ? AND verified_at IS NULL
    ORDER BY sent_at DESC LIMIT 1
  `).get(args.tableId, mob) as any;
  if (!row) return { ok: false, reason: 'no_code' };
  if (row.expired) return { ok: false, reason: 'expired' };
  if (Number(row.attempts) >= OTP_MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  if (hashCode(mob, code) !== row.code_hash) {
    db.prepare('UPDATE customer_otps SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { ok: false, reason: 'wrong_code' };
  }
  db.prepare("UPDATE customer_otps SET verified_at = datetime('now') WHERE id = ?").run(row.id);
  return { ok: true };
}

/**
 * Record that the provider could not deliver a specific code. Keyed by the OTP
 * row id (returned from createOtp) so a slow failure can never mislabel a NEWER,
 * successfully-delivered code as failed.
 */
export function markSendFailed(db: Database.Database, otpId: string): void {
  db.prepare('UPDATE customer_otps SET send_failed = 1 WHERE id = ?').run(otpId);
}

/**
 * Did the LATEST send for this number+table fail at the provider recently?
 * The channel can look "ready" (config + template present) while every real
 * send bounces (expired token, paused template). Without this check the guest
 * would loop forever: order → 428 → resend → provider fails → order → 428…
 * A fresh failed send lets the order fall back to captain approval instead.
 */
export function recentSendFailed(db: Database.Database, tableId: string, mobile: string): boolean {
  const mob = normMobile(mobile);
  if (!mob) return false;
  const row = db.prepare(`
    SELECT send_failed FROM customer_otps
    WHERE table_id = ? AND mobile = ? AND sent_at >= datetime('now','-10 minutes')
    ORDER BY sent_at DESC LIMIT 1
  `).get(tableId, mob) as any;
  return Number(row?.send_failed || 0) === 1;
}

/** Was this number verified for this table within the session window? */
export function hasVerifiedMobile(db: Database.Database, tableId: string, mobile: string): boolean {
  const mob = normMobile(mobile);
  if (!mob) return false;
  const row = db.prepare(`
    SELECT 1 FROM customer_otps
    WHERE table_id = ? AND mobile = ? AND verified_at IS NOT NULL
      AND verified_at >= datetime('now', ?)
    LIMIT 1
  `).get(tableId, mob, `-${VERIFIED_TTL_SECONDS} seconds`) as any;
  return !!row;
}
