import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';

/**
 * Manually link/unlink sales rows to a specific party event.
 *
 * POST /api/party-events/link-sales
 *   body: { event_name, event_date (YYYY-MM-DD), sale_ids: string[], action: 'link'|'unlink' }
 *
 * A manual link overrides the date-based default attribution in /api/party-events.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json() as {
      event_name?: string;
      event_date?: string;
      sale_ids?: string[];
      action?: 'link' | 'unlink';
    };

    const { event_name, event_date, sale_ids, action } = body;

    if (!event_name || !event_date || !Array.isArray(sale_ids) || sale_ids.length === 0 || (action !== 'link' && action !== 'unlink')) {
      return Response.json({ error: 'Invalid body. Need event_name, event_date, sale_ids[], action.' }, { status: 400 });
    }

    // Validate event exists in requisitions table
    const ev = db.prepare(`
      SELECT 1 FROM requisitions
      WHERE purpose = 'party' AND event_name = ? AND event_date = ?
      LIMIT 1
    `).get(event_name, event_date);
    if (!ev) {
      return Response.json({ error: 'Event not found' }, { status: 404 });
    }

    const placeholders = sale_ids.map(() => '?').join(',');
    let updated = 0;

    const tx = db.transaction(() => {
      if (action === 'link') {
        const stmt = db.prepare(
          `UPDATE sales SET linked_event_name = ?, linked_event_date = ? WHERE id IN (${placeholders})`
        );
        const res = stmt.run(event_name, event_date, ...sale_ids);
        updated = res.changes;
      } else {
        const stmt = db.prepare(
          `UPDATE sales SET linked_event_name = NULL, linked_event_date = NULL WHERE id IN (${placeholders})`
        );
        const res = stmt.run(...sale_ids);
        updated = res.changes;
      }
    });
    tx();

    const outletId = await getCurrentOutletId();
    logAuditEvent(db, {
      event_type: 'party.sales_link',
      entity_type: 'event',
      entity_id: `${event_name}:${event_date}`,
      outlet_id: outletId,
      after: { action, sale_ids: sale_ids.length },
    });

    return Response.json({ success: true, updated });
  } catch (e: any) {
    console.error('[party-events/link-sales]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
