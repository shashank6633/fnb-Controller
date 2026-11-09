import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { requireStaff } from '@/lib/valet/core';
import { headBoard } from '@/lib/valet/board';
import { valetJson } from '@/lib/valet/http';

/** GET ?outlet= — the Valet Head Dashboard payload (Valet Head / admin only). */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return valetJson(async () => {
    const db = getDb();
    const { ov } = requireStaff(db, await getCurrentUser(), new URL(req.url).searchParams.get('outlet') || '', 'head');
    return headBoard(db, ov);
  });
}
