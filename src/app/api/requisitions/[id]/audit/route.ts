import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Audit timeline for a requisition. Aggregates events on the requisition
 * itself + all its items.
 *
 * GET /api/requisitions/[id]/audit
 */
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();

    // Pull events on the req itself + every item belonging to it
    const events = db.prepare(`
      SELECT id, event_type, entity_type, entity_id, actor_email,
             before_json, after_json, note, created_at
      FROM audit_events
      WHERE (entity_type = 'requisition' AND entity_id = ?)
         OR (entity_type = 'requisition_item' AND entity_id IN (
              SELECT id FROM requisition_items WHERE req_id = ?
            ))
      ORDER BY created_at DESC
      LIMIT 200
    `).all(id, id) as any[];

    // Decorate item events with material name for readability
    const itemRows = db.prepare(`
      SELECT ri.id, rm.name AS material_name
      FROM requisition_items ri
      JOIN raw_materials rm ON rm.id = ri.material_id
      WHERE ri.req_id = ?
    `).all(id) as any[];
    const matByItem = new Map(itemRows.map((r: any) => [r.id, r.material_name]));

    const decorated = events.map(e => ({
      ...e,
      material_name: e.entity_type === 'requisition_item' ? matByItem.get(e.entity_id) || null : null,
      before: safeParse(e.before_json),
      after:  safeParse(e.after_json),
    }));

    return Response.json({ events: decorated });
  } catch (e: any) {
    console.error('[/api/requisitions/[id]/audit GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

function safeParse(s: string | null): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}
