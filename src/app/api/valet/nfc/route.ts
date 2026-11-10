import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { resolveNfc } from '@/lib/valet/ops-nfc';
import { rateLimit } from '@/lib/valet/credentials';
import { fail } from '@/lib/valet/core';
import { valetJson } from '@/lib/valet/http';

/**
 * GET ?ref=<key-tag NFC reference>[&serial=<chip serial, Web NFC only>] — a
 * staff phone opened a key-tag sticker. Answers the tag (and the car on it)
 * for valet staff of that tag's outlet only; anyone else gets the same "not
 * available" as a dead link. Rate-limited per user (a reference is not a
 * secret, but it is not something to sweep either).
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return valetJson(async () => {
    const db = getDb();
    const user = await getCurrentUser();
    if (user && !rateLimit(db, `nfc:${user.id}`, 60, 60)) fail(429, 'slow_down', 'Too many look-ups. Wait a minute.');
    const q = new URL(req.url).searchParams;
    return resolveNfc(db, user, q.get('ref') || '', q.get('serial') || '');
  });
}
