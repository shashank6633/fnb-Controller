import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { requireStaff, fail } from '@/lib/valet/core';
import { deskLookup } from '@/lib/valet/board';
import { rateLimit } from '@/lib/valet/credentials';
import { valetJson } from '@/lib/valet/http';

/** GET ?outlet=&q= — find a guest's car by tag, ticket or plate tail (host /
 *  cashier / floor desk). Never lists without a query; rate-limited per user. */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return valetJson(async () => {
    const db = getDb();
    const url = new URL(req.url);
    const { actor, ov } = requireStaff(db, await getCurrentUser(), url.searchParams.get('outlet') || '', 'host');
    if (!rateLimit(db, `desk-lookup:${actor.id}`, 60, 60)) fail(429, 'slow_down', 'Too many searches. Wait a minute.');
    return { results: deskLookup(db, ov, url.searchParams.get('q') || '') };
  });
}
