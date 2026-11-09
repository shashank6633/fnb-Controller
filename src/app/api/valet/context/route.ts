import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { outletsForUser, fail } from '@/lib/valet/core';
import { hasValetCap, hasAnyValetCap } from '@/lib/valet/caps';
import { valetJson } from '@/lib/valet/http';

/** GET — who am I for valet, and which outlets may I operate. Every valet
 *  screen starts here; an empty outlet list is answered with the reason. */
export const dynamic = 'force-dynamic';

export async function GET() {
  return valetJson(async () => {
    const user = await getCurrentUser();
    if (!user) fail(401, 'sign_in', 'Please sign in again.');
    const u = user!;
    if (!hasAnyValetCap(u)) fail(403, 'no_capability', 'Your role does not include any Valet Parking access. Ask the owner (Settings → Roles).');
    const db = getDb();
    const outlets = outletsForUser(db, u);
    const cur = (db.prepare('SELECT current_outlet_id FROM users WHERE id = ?').get(u.id) as { current_outlet_id?: string } | undefined)?.current_outlet_id;
    return {
      user: { id: u.id, name: u.name, is_admin: u.role === 'admin',
        head: hasValetCap(u, 'head'), attendant: hasValetCap(u, 'attendant'), host: hasValetCap(u, 'host') },
      outlets,
      default_outlet_id: outlets.find(o => o.id === cur)?.id ?? outlets[0]?.id ?? null,
      no_outlet_reason: outlets.length ? '' : 'You are not assigned to any outlet for valet yet. Ask the owner (Valet Settings → Staff).',
    };
  });
}
