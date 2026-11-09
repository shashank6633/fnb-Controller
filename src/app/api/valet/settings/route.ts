import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { requireStaff } from '@/lib/valet/core';
import { valetJson } from '@/lib/valet/http';

/**
 * GET ?outlet= — Valet Settings data. Valet Head (zones, tags) or admin. The
 * staff list (who has a valet capability, and their outlet assignments) is the
 * admin's alone and is omitted for a head.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return valetJson(async () => {
    const db = getDb();
    const user = await getCurrentUser();
    const { actor, ov } = requireStaff(db, user, new URL(req.url).searchParams.get('outlet') || '', 'head', { allowDisabled: true });
    const zones = db.prepare(`SELECT id, name, kind, capacity, retrieval_minutes, sort_order, is_active FROM valet_zones
                              WHERE outlet_id = ? ORDER BY is_active DESC, kind, sort_order, name`).all(ov.outlet_id);
    const tags = db.prepare(`SELECT t.id, t.code, t.kind, t.status, t.notes, t.updated_at,
                               (SELECT s.state FROM valet_vehicle_sessions s WHERE s.tag_id = t.id AND s.state NOT IN ('HANDED_OVER','VOIDED')) AS on_car
                             FROM valet_tags t WHERE t.outlet_id = ? ORDER BY length(t.code_norm), t.code_norm`).all(ov.outlet_id);
    let staff = null;
    if (actor.isAdmin) {
      staff = db.prepare(`
        SELECT u.id, u.name, u.email, r.name AS role_name,
               COALESCE(r.valet_head, 0) AS valet_head, COALESCE(r.valet_attendant, 0) AS valet_attendant, COALESCE(r.valet_host, 0) AS valet_host,
               EXISTS (SELECT 1 FROM valet_staff_outlets s WHERE s.user_id = u.id AND s.outlet_id = ?) AS assigned
        FROM users u LEFT JOIN roles r ON r.id = u.role_id AND r.is_active = 1
        WHERE u.is_active = 1 AND (COALESCE(r.valet_head,0) + COALESCE(r.valet_attendant,0) + COALESCE(r.valet_host,0) > 0
               OR EXISTS (SELECT 1 FROM valet_staff_outlets s WHERE s.user_id = u.id AND s.outlet_id = ?))
        ORDER BY u.name`).all(ov.outlet_id, ov.outlet_id);
    }
    const books = db.prepare(`SELECT id, prefix, first_no, last_no, status, issued_at, note FROM valet_ticket_books WHERE outlet_id = ? ORDER BY status, issued_at DESC`).all(ov.outlet_id);
    return {
      outlet: { id: ov.outlet_id, name: ov.outlet_name }, enabled: ov.enabled, config: ov.cfg, books,
      entry_token: ov.entry_token, entry_path: ov.entry_token ? `/valet-pass?e=${ov.entry_token}` : '',
      zones, tags, staff, can_admin: actor.isAdmin,
    };
  });
}
