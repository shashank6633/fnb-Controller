import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canApproveAsChef } from '@/lib/auth';
import { enrichBatch, ProductionBatch } from '@/lib/production-batch';

/**
 * Kitchen Production — prepared-item batches.
 *
 * GET  /api/kitchen-production?status=active|all&category=&search=
 *        → { batches: [ {…columns}, remaining_quantity, expiry_status, batch_age_hours, fifo_priority ] }
 * POST /api/kitchen-production
 *        body: { item_name, category, material_id?, recipe_id?, production_date, production_time,
 *                expiry_date, expiry_time, shelf_life?, quantity_produced, unit, prepared_by,
 *                kitchen_section, storage_location, remarks? }
 *        → { batch }
 */

// Next unique 'PROD' + 6-digit barcode (max existing suffix + 1, start PROD000001).
function nextBarcode(db: ReturnType<typeof getDb>): string {
  const row = db.prepare(
    `SELECT MAX(CAST(SUBSTR(barcode, 5) AS INTEGER)) AS m
       FROM production_batches
      WHERE barcode LIKE 'PROD______'`
  ).get() as any;
  const next = (row?.m || 0) + 1;
  return 'PROD' + String(next).padStart(6, '0');
}

// Batch number: initials (up to 2 words) + YYMMDD(production_date) + 3-digit per-(item,day) seq.
// Falls back to the barcode when the item name has no letters.
function buildBatchNumber(
  db: ReturnType<typeof getDb>,
  itemName: string,
  productionDate: string,
  barcode: string,
): string {
  const words = (itemName || '')
    .replace(/[^a-zA-Z ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => /[a-zA-Z]/.test(w));
  const initials = words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  if (!initials) return barcode; // no letters → fall back to barcode suffix

  const d = (productionDate || '').replace(/-/g, '');
  const yymmdd = d.length >= 8 ? d.slice(2, 8) : d; // YYYYMMDD → YYMMDD

  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM production_batches WHERE item_name = ? AND production_date = ?`
  ).get(itemName, productionDate) as any;
  const seq = String((row?.c || 0) + 1).padStart(3, '0');
  return `${initials}${yymmdd}${seq}`;
}

// ---------- GET ----------
export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canApproveAsChef(me)) return Response.json({ error: 'Head chef or admin only' }, { status: 403 });

    const db = getDb();
    const url = new URL(request.url);
    const status = (url.searchParams.get('status') || 'active').toLowerCase();
    const category = url.searchParams.get('category') || '';
    const search = (url.searchParams.get('search') || '').trim();

    const where: string[] = [];
    const params: any[] = [];

    const outletId = await getCurrentOutletId();
    if (outletId) { where.push('(outlet_id = ? OR outlet_id IS NULL)'); params.push(outletId); }

    if (status !== 'all') { where.push('status = ?'); params.push(status); }
    if (category) { where.push('category = ?'); params.push(category); }
    if (search) {
      where.push('(item_name LIKE ? OR barcode LIKE ? OR batch_number LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT * FROM production_batches ${whereSql}
       ORDER BY production_date ASC, production_time ASC, created_at ASC`
    ).all(...params) as ProductionBatch[];

    const now = new Date();

    // fifo_priority: rank ACTIVE batches of the same item oldest-first (1,2,3…).
    const fifoCounter: Record<string, number> = {};
    const batches = rows.map((b) => {
      const enriched = enrichBatch(b, now);
      let fifo_priority: number | null = null;
      if (b.status === 'active') {
        const key = b.item_name;
        fifoCounter[key] = (fifoCounter[key] || 0) + 1;
        fifo_priority = fifoCounter[key];
      }
      return { ...enriched, fifo_priority };
    });

    return Response.json({ batches });
  } catch (e: any) {
    console.error('GET /api/kitchen-production failed:', e);
    return Response.json({ error: e?.message || 'Failed to list batches' }, { status: 500 });
  }
}

// ---------- POST ----------
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canApproveAsChef(me)) return Response.json({ error: 'Head chef or admin only' }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    const item_name = String(body?.item_name || '').trim();
    if (!item_name) return Response.json({ error: 'item_name is required' }, { status: 400 });

    const quantity_produced = Number(body?.quantity_produced) || 0;
    if (quantity_produced <= 0) {
      return Response.json({ error: 'quantity_produced must be greater than 0' }, { status: 400 });
    }

    const outletId = await getCurrentOutletId();
    const db = getDb();

    const production_date = String(body?.production_date || '').trim();
    const department = me.department_id || '';
    const userLabel = me.name || me.email || '';

    const insert = db.transaction(() => {
      const id = generateId();
      const barcode = nextBarcode(db);
      const batch_number = buildBatchNumber(db, item_name, production_date, barcode);

      db.prepare(
        `INSERT INTO production_batches (
           id, outlet_id, batch_number, barcode, item_name, category,
           material_id, recipe_id, production_date, production_time,
           expiry_date, expiry_time, shelf_life, quantity_produced, quantity_consumed,
           unit, prepared_by, kitchen_section, storage_location, remarks, status
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        outletId,
        batch_number,
        barcode,
        item_name,
        String(body?.category || ''),
        body?.material_id || null,
        body?.recipe_id || null,
        production_date,
        String(body?.production_time || ''),
        String(body?.expiry_date || ''),
        String(body?.expiry_time || ''),
        String(body?.shelf_life || ''),
        quantity_produced,
        0,
        String(body?.unit || ''),
        String(body?.prepared_by || ''),
        String(body?.kitchen_section || ''),
        String(body?.storage_location || ''),
        String(body?.remarks || ''),
        'active',
      );

      db.prepare(
        `INSERT INTO batch_transactions (
           id, batch_id, outlet_id, type, quantity, balance_quantity, user, department, remarks
         ) VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(
        generateId(),
        id,
        outletId,
        'created',
        quantity_produced,
        quantity_produced,
        userLabel,
        department,
        '',
      );

      return id;
    });

    const id = insert();
    const row = db.prepare('SELECT * FROM production_batches WHERE id = ?').get(id) as ProductionBatch;
    const now = new Date();
    const batch = { ...enrichBatch(row, now), fifo_priority: null };

    return Response.json({ batch });
  } catch (e: any) {
    console.error('POST /api/kitchen-production failed:', e);
    return Response.json({ error: e?.message || 'Failed to create batch' }, { status: 500 });
  }
}
