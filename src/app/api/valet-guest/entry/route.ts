import { getDb } from '@/lib/db';
import { rateLimit, clientIp } from '@/lib/valet/credentials';
import { guestEntry } from '@/lib/valet/guest';
import { valetJson } from '@/lib/valet/http';
import { fail } from '@/lib/valet/core';

/** GET ?e=<public venue token> — the venue name for the check-in page. PUBLIC.
 *  Returns no car, no guest, nothing but the venue and which fields it asks for. */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return valetJson(() => {
    const db = getDb();
    if (!rateLimit(db, `guest-entry-ip:${clientIp(req.headers)}`, 60, 600)) fail(429, 'slow_down', 'Too many requests.');
    return guestEntry(db, new URL(req.url).searchParams.get('e') || '');
  });
}
