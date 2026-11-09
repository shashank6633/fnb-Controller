import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { requireStaff } from '@/lib/valet/core';
import { attendantView } from '@/lib/valet/board';
import { heartbeat } from '@/lib/valet/ops-admin';
import { valetJson } from '@/lib/valet/http';

/** GET ?outlet= — the attendant screen. Each poll is also the device's
 *  presence ping: a car held by an attendant whose screen stops polling is
 *  flagged "uncertain" on the head's board — never silently re-dispatched. */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return valetJson(async () => {
    const db = getDb();
    const { actor, ov } = requireStaff(db, await getCurrentUser(), new URL(req.url).searchParams.get('outlet') || '', 'attendant');
    heartbeat(db, actor);
    return attendantView(db, ov, actor);
  });
}
