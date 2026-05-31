import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

/**
 * Wastages — Phase 1 §6 consumption channel.
 *
 * GET    /api/wastage?from=&to=&material_id=  → list with material name + recipe context
 * POST   /api/wastage                         → record a wastage entry
 *        body: { date, material_id, quantity (in recipe units), reason, recipe_id?, notes? }
 *        Writes inventory_transactions(type='wastage', −qty) and decrements current_stock.
 * DELETE /api/wastage?id=X                    → admin only — reverses stock + deletes tx + row
 *
 * Reasons: 'spoilage' | 'expiry' | 'damage' | 'overcooked' | 'spillage' | 'other'
 */

const VALID_REASONS = new Set(['spoilage','expiry','damage','overcooked','spillage','other']);

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to   = url.searchParams.get('to');
    const matId = url.searchParams.get('material_id');
    const where: string[] = ['1=1']; const params: any[] = [];
    if (from)  { where.push('w.date >= ?'); params.push(from); }
    if (to)    { where.push('w.date <= ?'); params.push(to); }
    if (matId) { where.push('w.material_id = ?'); params.push(matId); }
    const outletId = await getCurrentOutletId();
    if (outletId) { where.push('(w.outlet_id = ? OR w.outlet_id IS NULL)'); params.push(outletId); }
    const rows = db.prepare(`
      SELECT w.*, rm.name AS material_name, rm.sku AS material_sku, rm.unit AS material_unit,
             rm.average_price, r.name AS recipe_name,
             (w.quantity * rm.average_price) AS value
      FROM wastages w
      JOIN raw_materials rm ON rm.id = w.material_id
      LEFT JOIN recipes r ON r.id = w.recipe_id
      WHERE ${where.join(' AND ')}
      ORDER BY w.date DESC, w.created_at DESC
    `).all(...params);
    return Response.json({ wastages: rows });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await request.json();
    const { date, material_id, quantity, reason, recipe_id, notes } = b;
    if (!date || !material_id || !quantity) {
      return Response.json({ error: 'date, material_id, quantity required' }, { status: 400 });
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return Response.json({ error: 'quantity must be > 0' }, { status: 400 });
    }
    const r = String(reason || 'spoilage').toLowerCase();
    if (!VALID_REASONS.has(r)) {
      return Response.json({ error: `reason must be one of ${[...VALID_REASONS].join(', ')}` }, { status: 400 });
    }
    const id = generateId();
    const outletId = await getCurrentOutletId();
    const txn = db.transaction(() => {
      db.prepare(`
        INSERT INTO wastages (id, date, material_id, quantity, reason, recipe_id, recorded_by, notes, outlet_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, date, material_id, qty, r, recipe_id || null, me.email, notes || '', outletId);

      // Decrement stock + write inventory_transaction so variance / consumption math sees it.
      db.prepare(`UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now') WHERE id = ?`).run(qty, material_id);
      db.prepare(`
        INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at, outlet_id)
        VALUES (?, ?, 'wastage', ?, ?, ?, datetime('now'), ?)
      `).run(generateId(), material_id, -qty, id, `Wastage: ${r}${notes ? ' — ' + notes : ''}`, outletId);
    });
    txn();
    const wastage = db.prepare(`
      SELECT w.*, rm.name AS material_name, rm.unit AS material_unit, rm.average_price,
             (w.quantity * rm.average_price) AS value
      FROM wastages w JOIN raw_materials rm ON rm.id = w.material_id
      WHERE w.id = ?
    `).get(id);
    return Response.json({ wastage }, { status: 201 });
  } catch (e: any) {
    console.error('[wastage POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    const db = getDb();
    const w = db.prepare('SELECT * FROM wastages WHERE id = ?').get(id) as any;
    if (!w) return Response.json({ error: 'Not found' }, { status: 404 });
    const txn = db.transaction(() => {
      // Reverse the stock deduction
      db.prepare(`UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?`).run(w.quantity, w.material_id);
      db.prepare(`DELETE FROM inventory_transactions WHERE type = 'wastage' AND reference_id = ?`).run(id);
      db.prepare(`DELETE FROM wastages WHERE id = ?`).run(id);
    });
    txn();
    return Response.json({ success: true });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
