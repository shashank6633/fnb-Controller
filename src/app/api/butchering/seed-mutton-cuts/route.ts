import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Seed the standard AKAN mutton cut SKUs (idempotent — safe to re-run).
 *
 * Creates these raw_materials rows if their SKU doesn't exist:
 *   MEAT-MUT-CARCASS  — whole dressed carcass (source for butchering)
 *   MEAT-MUT-LEG      — leg / raan
 *   MEAT-MUT-SHLD     — shoulder
 *   MEAT-MUT-CHOP     — chops (rib + loin)
 *   MEAT-MUT-RIB      — ribs for shorba
 *   MEAT-MUT-MINCE    — keema / mince
 *   MEAT-MUT-OFFAL    — liver / kidney / heart
 *   MEAT-MUT-BONE     — bones for stock
 *
 * Returns: { created: [...], skipped: [...] }
 *
 * POST only — admin or store-manager only.
 */
export const dynamic = 'force-dynamic';

const MUTTON_CATALOG = [
  { sku: 'MEAT-MUT-CARCASS', name: 'Mutton Carcass (whole dressed)',
    category: 'meat', unit: 'kg', is_source: true,
    note: 'Source material — whole dressed carcass received from vendor' },
  { sku: 'MEAT-MUT-LEG',     name: 'Mutton Leg (raan)',
    category: 'meat', unit: 'kg' },
  { sku: 'MEAT-MUT-SHLD',    name: 'Mutton Shoulder',
    category: 'meat', unit: 'kg' },
  { sku: 'MEAT-MUT-CHOP',    name: 'Mutton Chops (rib + loin)',
    category: 'meat', unit: 'kg' },
  { sku: 'MEAT-MUT-RIB',     name: 'Mutton Ribs',
    category: 'meat', unit: 'kg' },
  { sku: 'MEAT-MUT-MINCE',   name: 'Mutton Mince (keema)',
    category: 'meat', unit: 'kg' },
  { sku: 'MEAT-MUT-OFFAL',   name: 'Mutton Offal (liver, kidney, heart)',
    category: 'meat', unit: 'kg' },
  { sku: 'MEAT-MUT-BONE',    name: 'Mutton Bones (for stock)',
    category: 'meat', unit: 'kg' },
];

export async function POST() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && !me.is_store_manager && !me.is_head_chef) {
      return Response.json({ error: 'Admin / store manager / head chef only' }, { status: 403 });
    }
    const db = getDb();

    const findBySku = db.prepare(`SELECT id, name FROM raw_materials WHERE LOWER(sku) = LOWER(?)`);
    const insert = db.prepare(`
      INSERT INTO raw_materials (id, sku, name, category, unit, current_stock, reorder_level, costing_method, average_price)
      VALUES (?, ?, ?, ?, ?, 0, 0, 'average', 0)
    `);

    const created: { sku: string; name: string; id: string }[] = [];
    const skipped: { sku: string; name: string; existing_id: string; reason: string }[] = [];

    const txn = db.transaction(() => {
      for (const m of MUTTON_CATALOG) {
        const existing = findBySku.get(m.sku) as { id: string; name: string } | undefined;
        if (existing) {
          skipped.push({ sku: m.sku, name: m.name, existing_id: existing.id, reason: 'SKU already exists' });
          continue;
        }
        const id = generateId();
        insert.run(id, m.sku, m.name, m.category, m.unit);
        created.push({ sku: m.sku, name: m.name, id });
      }
    });
    txn();

    return Response.json({
      created,
      skipped,
      summary: `Created ${created.length} new mutton cut SKU${created.length === 1 ? '' : 's'}. Skipped ${skipped.length} that already existed.`,
      next_steps: [
        'Go to Butchering → New Batch',
        'Select "Mutton Carcass (whole dressed)" as the source',
        'Enter the gross weight, then add each cut + waste line',
        'Close & post inventory when reconciliation is within 1.5%',
      ],
    });
  } catch (e: any) {
    console.error('[/api/butchering/seed-mutton-cuts POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
