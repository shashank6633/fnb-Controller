import { getDb } from '@/lib/db';
import { ingestHttp } from '@/lib/valet/ops-rfid';
import { valetJson, readJson } from '@/lib/valet/http';

/**
 * POST — an RFID reader delivers reads: {"events": [{event_id, epc, antenna,
 * observed_at}, ...]} (an empty list is a heartbeat), `Authorization: Bearer
 * <reader token>`. PUBLIC exact path in proxy.ts (a machine has no session):
 * the token is this route's authentication, and the outlet must be in RFID
 * 'live' mode (off by default). Reads are observations only — see ops-rfid.ts.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return valetJson(async () => {
    const body = await readJson(req, 64_000);
    return ingestHttp(getDb(), req.headers.get('authorization') || '', body);
  });
}
