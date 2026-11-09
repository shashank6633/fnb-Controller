import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { requireStaff, fail } from '@/lib/valet/core';
import { sessionDetail } from '@/lib/valet/board';
import { valetJson } from '@/lib/valet/http';

/** GET ?outlet=&id= — one car with its timeline and custody trail (attendant
 *  or head; the head's view carries the masked contact). */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return valetJson(async () => {
    const db = getDb();
    const url = new URL(req.url);
    const { actor, ov } = requireStaff(db, await getCurrentUser(), url.searchParams.get('outlet') || '', 'attendant');
    const d = sessionDetail(db, ov, url.searchParams.get('id') || '', actor.head ? 'head' : 'attendant');
    if (!d) fail(404, 'not_found', 'That car was not found at this outlet.');
    return d;
  });
}
