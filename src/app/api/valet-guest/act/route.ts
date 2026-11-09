import { cookies } from 'next/headers';
import { getDb } from '@/lib/db';
import { DEVICE_COOKIE, clientIp } from '@/lib/valet/credentials';
import { deviceFromCookie, guardGuestWrite, guestAct } from '@/lib/valet/guest';
import { valetJson, readJson, NO_STORE } from '@/lib/valet/http';

/**
 * POST — every guest write (check-in, activate, pickup, cancel, reschedule,
 * outside, help, handover code, language). PUBLIC (exact path in proxy.ts) and
 * therefore outside the proxy's CSRF step: guardGuestWrite() is this route's
 * own CSRF check, and guestAct() authorises every action against the device's
 * own grants.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return valetJson(async () => {
    guardGuestWrite(req);
    const body = await readJson(req, 8_000);
    const db = getDb();
    const jar = await cookies();
    const device = deviceFromCookie(db, jar.get(DEVICE_COOKIE)?.value);
    const secure = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
    const r = guestAct(db, device, body, clientIp(req.headers), secure);
    const headers: Record<string, string> = { ...NO_STORE };
    if (r.setCookie) headers['Set-Cookie'] = r.setCookie;
    return Response.json(r.body, { headers });
  });
}
