import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { requireStaff } from '@/lib/valet/core';
import { simulationReason } from '@/lib/valet/notify';
import { valetJson } from '@/lib/valet/http';

/** GET ?outlet= — the guest-message log for the Valet Head / admin: what was
 *  queued, simulated, sent, delivered or failed, and why. Never a phone number:
 *  the guest is shown by tag only. */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return valetJson(async () => {
    const db = getDb();
    const { ov } = requireStaff(db, await getCurrentUser(), new URL(req.url).searchParams.get('outlet') || '', 'head', { allowDisabled: true });
    const rows = db.prepare(`SELECT n.id, n.kind, n.status, n.attempts, n.last_error, n.created_at, n.sent_at, n.delivered_at, n.read_at, n.failed_at,
                               n.template_name, s.tag_code
                             FROM valet_notifications n LEFT JOIN valet_vehicle_sessions s ON s.id = n.session_id
                             WHERE n.outlet_id = ? ORDER BY n.created_at DESC LIMIT 60`).all(ov.outlet_id);
    const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM valet_notifications WHERE outlet_id = ? GROUP BY status`).all(ov.outlet_id);
    return { mode: simulationReason(ov, 'ready') ? 'simulator' : 'live', reason: simulationReason(ov, 'ready'), rows, counts };
  });
}
