import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Seed AKAN's standard kitchen sub-departments (idempotent — safe to re-run).
 *
 * Creates these `departments` rows if their NAME doesn't exist:
 *   Continental, Asian, Bakery, Indian, Tandoor, Chinese, Bar, Housekeeping
 *
 * POST only — admin / head chef.
 */
export const dynamic = 'force-dynamic';

const SEED = [
  { code: 'CONTI',   name: 'Continental',  description: 'Continental cuisine kitchen' },
  { code: 'ASIAN',   name: 'Asian',        description: 'Pan-Asian (Thai, Vietnamese, etc.)' },
  { code: 'BAKERY',  name: 'Bakery',       description: 'Breads, pastries, desserts' },
  { code: 'INDIAN',  name: 'Indian',       description: 'North + South Indian curries, breads, rice' },
  { code: 'TANDOOR', name: 'Tandoor',      description: 'Tandoor / grill section (kebabs, naan, tikka)' },
  { code: 'CHINESE', name: 'Chinese',      description: 'Indo-Chinese' },
  { code: 'BAR',     name: 'Bar',          description: 'Bar / beverages' },
  { code: 'HK',      name: 'Housekeeping', description: 'Linen, setup, decor consumables' },
];

export async function POST() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && !me.is_head_chef) {
      return Response.json({ error: 'Admin / head chef only' }, { status: 403 });
    }
    const db = getDb();

    const findByName = db.prepare(`SELECT id, name FROM departments WHERE LOWER(name) = LOWER(?)`);
    const insert = db.prepare(`
      INSERT INTO departments (id, name, code, description) VALUES (?, ?, ?, ?)
    `);
    const created: any[] = [];
    const skipped: any[] = [];
    const txn = db.transaction(() => {
      for (const d of SEED) {
        const existing = findByName.get(d.name) as { id: string } | undefined;
        if (existing) { skipped.push({ name: d.name, existing_id: existing.id }); continue; }
        const id = generateId();
        insert.run(id, d.name, d.code, d.description);
        created.push({ id, ...d });
      }
    });
    txn();

    return Response.json({
      created, skipped,
      summary: `Created ${created.length} new kitchen sub-departments. Skipped ${skipped.length} that already existed.`,
    });
  } catch (e: any) {
    console.error('[/api/departments/seed-kitchen-subs POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
