import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, userStoreAccess, LEDGER_TXN_TYPES } from '@/lib/store-engine';

/**
 * GET /api/stores/[id]/ledger — filterable store ledger, newest first.
 * Gate: userStoreAccess(...).can_view.
 *
 * Query params: ?type=purchase|adjustment|… &material_id=… &q=<material name
 * search> &from=YYYY-MM-DD &to=YYYY-MM-DD &limit=N (default 300, max 1000)
 * &counts=1 — also surface saved closing counts (store_closing_counts is a
 * pure REGISTER: saving a count never posts a ledger row, so without this the
 * "Closing" filter can never match). Each count becomes a SYNTHETIC row:
 *   { id: 'count:<id>', txn_type: 'closing', is_count: true,
 *     quantity: physical_qty, system_qty, variance, variance_value,
 *     unit_cost: 0, batch_no/supplier/vendor_id/expiry_date: null,
 *     ref: 'count:<date>', notes: note, created_by: counted_by,
 *     created_at: '<date> 23:59:59', saved_at: <row created_at>,
 *     material_name, unit, purchase_unit, pack_size, case_size }
 * from/to filter synthetic rows by the count DAY (c.date), not save time.
 * ?type=closing always merges counts in (real 'closing' ledger rows, if any
 * ever exist, still union in). counts=1 + no type filter → real + synthetic
 * merged, sorted created_at DESC, limit applied to the merged set. Otherwise
 * behavior is unchanged.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id: storeId } = await params;
    const db = getDb();

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });

    const access = userStoreAccess(db, user, storeId);
    if (!access.can_view) {
      return Response.json({ error: `You are not authorized to view ${store.name}` }, { status: 403 });
    }

    const url = new URL(request.url);
    const type = (url.searchParams.get('type') || '').trim();
    const materialId = (url.searchParams.get('material_id') || '').trim();
    const q = (url.searchParams.get('q') || '').trim();
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 300, 1), 1000);
    const wantCounts = url.searchParams.get('counts') === '1';
    // Counts merge in when explicitly asked (?counts=1, no type filter) or when
    // filtering to 'closing' — closing counts ARE the closing history (the
    // register never posts ledger rows). Any other type filter excludes them.
    const typeIsFilter = type !== '' && (LEDGER_TXN_TYPES as readonly string[]).includes(type);
    const includeCounts = type === 'closing' || (wantCounts && !typeIsFilter);

    const where: string[] = ['l.store_id = ?'];
    const args: any[] = [storeId];
    if (type && (LEDGER_TXN_TYPES as readonly string[]).includes(type)) {
      where.push('l.txn_type = ?'); args.push(type);
    }
    if (materialId) { where.push('l.material_id = ?'); args.push(materialId); }
    if (q) { where.push('rm.name LIKE ?'); args.push(`%${q}%`); }
    if (from) { where.push("date(l.created_at) >= date(?)"); args.push(from); }
    if (to)   { where.push("date(l.created_at) <= date(?)"); args.push(to); }

    const rows = db.prepare(`
      SELECT l.id, l.txn_type, l.quantity, l.unit_cost, l.batch_no, l.supplier,
             l.vendor_id, l.expiry_date, l.ref, l.notes, l.created_by, l.created_at,
             rm.name AS material_name, rm.unit, rm.purchase_unit, rm.pack_size, rm.case_size
      FROM store_stock_ledger l
      JOIN raw_materials rm ON rm.id = l.material_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.created_at DESC, l.rowid DESC
      LIMIT ?
    `).all(...args, limit) as any[];

    let ledger = rows;
    if (includeCounts) {
      // Synthetic 'closing' rows from the count register, same filters as the
      // real query — except from/to hit c.date (the count DAY, not save time).
      const cw: string[] = ['c.store_id = ?'];
      const cargs: any[] = [storeId];
      if (materialId) { cw.push('c.material_id = ?'); cargs.push(materialId); }
      if (q) { cw.push('rm.name LIKE ?'); cargs.push(`%${q}%`); }
      if (from) { cw.push("date(c.date) >= date(?)"); cargs.push(from); }
      if (to)   { cw.push("date(c.date) <= date(?)"); cargs.push(to); }

      const counts = db.prepare(`
        SELECT c.id, c.date, c.system_qty, c.physical_qty, c.variance,
               c.variance_value, c.counted_by, c.note, c.created_at,
               rm.name AS material_name, rm.unit, rm.purchase_unit, rm.pack_size, rm.case_size
        FROM store_closing_counts c
        JOIN raw_materials rm ON rm.id = c.material_id
        WHERE ${cw.join(' AND ')}
        ORDER BY c.date DESC, c.rowid DESC
        LIMIT ?
      `).all(...cargs, limit) as any[];

      // Blind count: only admins may see the system figure + variance on a
      // closing register row (the UI hides it, but the raw JSON must too).
      const isAdmin = user.role === 'admin';
      const synthetic = counts.map(c => ({
        id: `count:${c.id}`,
        txn_type: 'closing',
        is_count: true,
        quantity: c.physical_qty,
        system_qty: isAdmin ? c.system_qty : null,
        variance: isAdmin ? c.variance : null,
        variance_value: isAdmin ? c.variance_value : null,
        unit_cost: 0,
        batch_no: null,
        supplier: null,
        vendor_id: null,
        expiry_date: null,
        ref: `count:${c.date}`,
        notes: c.note,
        created_by: c.counted_by,
        created_at: `${c.date} 23:59:59`,
        saved_at: c.created_at,
        material_name: c.material_name,
        unit: c.unit,
        purchase_unit: c.purchase_unit,
        pack_size: c.pack_size,
        case_size: c.case_size,
      }));

      // Merge, newest first ('YYYY-MM-DD HH:MM:SS' string compare), re-limit.
      ledger = [...rows, ...synthetic]
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
        .slice(0, limit);
    }

    return Response.json({ store: { id: store.id, name: store.name }, ledger });
  } catch (e: any) {
    console.error('[/api/stores/[id]/ledger GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
