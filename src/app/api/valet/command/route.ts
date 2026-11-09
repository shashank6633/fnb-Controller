import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { runCommand } from '@/lib/valet/commands';
import { valetJson, readJson } from '@/lib/valet/http';

/**
 * POST — every valet STAFF write, dispatched through the command table in
 * src/lib/valet/commands.ts (the permission matrix). CSRF: the '/api/valet/'
 * prefix in proxy.ts; clients post through src/lib/api.ts.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return valetJson(async () => {
    const body = await readJson(req);
    const user = await getCurrentUser();
    return { ok: true, ...runCommand(getDb(), user, body) };
  });
}
