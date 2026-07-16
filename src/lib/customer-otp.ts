import type Database from 'better-sqlite3';
import { createHash, randomInt } from 'crypto';
import { isWaConfigured, getWaConfigRaw } from '@/lib/whatsapp';

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
export const VERIFIED_TTL_SECONDS = 6 * 3600; // a verified number stays verified for the session

/** Digits only — the same normalisation on send, verify and order so they match. */
export function normMobile(m: string): string {
  return String(m || '').replace(/\D/g, '').slice(-15);
}

function hashCode(mobile: string, code: string): string {
  return createHash('sha256').update(`${normMobile(mobile)}:${code}`).digest('hex');
}

/** Can we actually SEND an OTP right now? (provider configured + an OTP template set.) */
export function otpChannelReady(): boolean {
  const raw = getWaConfigRaw();
  return isWaConfigured(raw) && !!String(raw.wa_otp_template || '').trim();
}

/** Rate-limit a send: cooldown since the last one + an hourly cap per number+table. */
export function canSendOtp(db: Database.Database, tableId: string, mobile: string): { ok: boolean; retryAfter?: number } {
  const mob = normMobile(mobile);
  const last = db.prepare(
    `SELECT sent_at, CAST(strftime('%s','now') - strftime('%s', sent_at) AS INTEGER) AS ago
     FROM customer_otps WHERE table_id = ? AND mobile = ? ORDER BY sent_at DESC LIMIT 1`
  ).get(tableId, mob) as any;
  if (last && Number(last.ago) < RESEND_COOLDOWN_SECONDS) {
    return { ok: false, retryAfter: RESEND_COOLDOWN_SECONDS - Number(last.ago) };
  }
  const hourCount = db.prepare(
    `SELECT COUNT(*) AS n FROM customer_otps WHERE table_id = ? AND mobile = ? AND sent_at >= datetime('now','-1 hour')`
  ).get(tableId, mob) as any;
  if (Number(hourCount?.n || 0) >= MAX_SENDS_PER_HOUR) return { ok: false, retryAfter: 3600 };
  return { ok: true };
}

/** Generate + store a fresh OTP; returns the plaintext code for the caller to send. */
export function createOtp(db: Database.Database, args: { outletId: string | null; tableId: string; mobile: string }): { code: string } {
  const mob = normMobile(args.mobile);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare(`
    INSERT INTO customer_otps (id, outlet_id, table_id, mobile, code_hash, expires_at)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now', ?))
  `).run(args.outletId || null, args.tableId, mob, hashCode(mob, code), `+${OTP_TTL_SECONDS} seconds`);
  return { code };
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
