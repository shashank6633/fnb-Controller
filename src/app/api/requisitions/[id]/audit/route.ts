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

    // Decorate item events with material name + UNIT META. The logged before/after
    // quantities are in the LINE's own unit (option B), so a reader can only make
    // sense of them alongside the line unit and the material's pack meta — the
    // drawer renders them in purchase units like every other screen.
    const itemRows = db.prepare(`
      SELECT ri.id, ri.unit AS line_unit, rm.name AS material_name, rm.unit AS material_unit,
             COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS material_purchase_unit,
             COALESCE(rm.pack_size, 1) AS material_pack_size
      FROM requisition_items ri
      JOIN raw_materials rm ON rm.id = ri.material_id
      WHERE ri.req_id = ?
    `).all(id) as any[];
    const matByItem = new Map(itemRows.map((r: any) => [r.id, r]));

    const decorated = events.map(e => {
      const m: any = e.entity_type === 'requisition_item' ? matByItem.get(e.entity_id) : null;
      return {
      ...e,
      material_name: m?.material_name || null,
      unit: m?.line_unit ?? null,
      material_unit: m?.material_unit ?? null,
      material_purchase_unit: m?.material_purchase_unit ?? null,
      material_pack_size: m?.material_pack_size ?? null,
      before: safeParse(e.before_json),
      after:  safeParse(e.after_json),
    };
    });

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
