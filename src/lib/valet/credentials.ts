/**
 * VALET — credentials and rate limits. Server-only (node:crypto, database).
 *
 * The rule the whole module rests on: a VISIBLE identifier (tag number, plate,
 * pairing code, ticket number) is never a credential. Credentials are random,
 * stored only as SHA-256 hashes, expire, and are single-use where the spec says
 * so. docs/valet/DESIGN.md §5 is the table of them.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import type Database from 'better-sqlite3';

export const DEVICE_COOKIE = 'fnb_vp';

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
/** URL-safe random token (base64url, no padding). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Crockford base32 code (no I/L/O/U), uniformly random. */
export function crockfordCode(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += CROCKFORD[randomInt(32)];
  return s;
}
/** Normalise a typed Crockford code: upper-case, strip separators, O→0, I/L→1. */
export function normCode(s: string | null | undefined): string {
  return String(s || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}
export function digits(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String(randomInt(10));
  return s;
}
/** Constant-time compare of two hex hashes. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); } catch { return false; }
}
/** Public venue entry token (QR / NFC card). Public by design, so plain text. */
export function newEntryToken(): string {
  return crockfordCode(16).toLowerCase();
}
/** Opaque NFC reference for a key tag's staff-lookup URL. */
export function newNfcRef(): string {
  return crockfordCode(14).toLowerCase();
}

/**
 * Fixed-window rate limit, counted IN THE DATABASE so it holds across pm2
 * workers. Returns true when the call is ALLOWED (and counts it). The bucket
 * key is hashed so a phone number or IP never sits in the table in clear.
 */
export function rateLimit(
  db: Database.Database, bucket: string, max: number, windowSec: number, now: Date = new Date(),
): boolean {
  const key = sha256(bucket).slice(0, 40);
  const t = Math.floor(now.getTime() / 1000);
  const win = t - (t % windowSec);
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT window_start, count FROM valet_rate_limits WHERE bucket = ?').get(key) as
      { window_start: number; count: number } | undefined;
    if (!row || row.window_start !== win) {
      db.prepare(`INSERT INTO valet_rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
                  ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = 1`).run(key, win);
      return true;
    }
    if (row.count >= max) return false;
    db.prepare('UPDATE valet_rate_limits SET count = count + 1 WHERE bucket = ?').run(key);
    return true;
  });
  // Opportunistic prune so the table never grows without bound (~1 in 200 calls).
  if (randomInt(200) === 0) {
    try { db.prepare('DELETE FROM valet_rate_limits WHERE window_start < ?').run(t - 86_400); } catch { /* best effort */ }
  }
  return tx.immediate();
}

/** Client IP for rate-limit buckets: the LAST X-Forwarded-For hop (the first is
 *  client-supplied and spoofable) — same rule as /api/error-report. */
export function clientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for') || '';
  const hops = xff.split(',').map(s => s.trim()).filter(Boolean);
  return hops[hops.length - 1] || headers.get('x-real-ip') || 'local';
}
