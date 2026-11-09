import { cookies } from 'next/headers';
import { getDb } from '@/lib/db';
import { DEVICE_COOKIE, rateLimit, clientIp } from '@/lib/valet/credentials';
import { deviceFromCookie, guestState } from '@/lib/valet/guest';
import { valetJson } from '@/lib/valet/http';
import { fail } from '@/lib/valet/core';

/** GET — this browser's own valet passes. PUBLIC (exact path in proxy.ts);
 *  authenticated by the httpOnly device cookie, never by a URL parameter. */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return valetJson(async () => {
    const db = getDb();
    if (!rateLimit(db, `guest-state-ip:${clientIp(req.headers)}`, 240, 600)) fail(429, 'slow_down', 'Too many requests.');
    const jar = await cookies();
    return guestState(db, deviceFromCookie(db, jar.get(DEVICE_COOKIE)?.value));
  });
}
