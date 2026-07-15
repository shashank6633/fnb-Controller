import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, materialStoreId, postLedger } from '@/lib/store-engine';
import { todayIST } from '@/lib/format-date';

/**
 * Bar empties / breakage / spillage log — Multi-floor bar Phase 2/3,
 * slice [empties-barcode-zonemap].
 *
 * bar_empties is a pure REGISTER of non-sale floor stock reductions (empty
 * bottles returned, breakage, complimentary pours, spillage). By itself it
 * moves NO stock — it exists so the reconciliation report can subtract these
 * legit non-sale reductions from the physical variance (a broken bottle is a
 * real loss, not a leak). A breakage/spillage MAY additionally post a signed
 * 'adjustment' ledger row that actually reduces the floor store's stock, but
 * only when the caller opts in (adjust_ledger:true) AND is elevated enough to
 * adjust store stock — everything else is register-only.
 *
 * GET  /api/stores/empties?store_id=&from=&to=&kind=
 *   → { empties: [{ …row, material_name, unit, pack_size, store_name }],
 *       kinds: [...] }
 *
 * POST /api/stores/empties
 *   { store_id, material_id, qty (magnitude ≥ 0, recipe units),
 *     kind: 'empty'|'breakage'|'complimentary'|'spillage',
 *     note?, date? (YYYY-MM-DD IST; default today),
 *     adjust_ledger? (breakage/spillage only — post a −qty adjustment ledger row) }
 *   → { ok, id, ledger_id? }
 *
 * Gate (both verbs): admin || manager || is_store_manager || is_head_chef (HOD).
 * The optional ledger adjustment additionally requires admin || is_store_manager.
 *
 * CSRF: '/api/stores' is in proxy.ts CSRF_REQUIRED_PREFIXES, so the POST must
 * carry the double-submit header (callers use api()).
 */
export const dynamic = 'force-dynamic';

const KINDS = ['empty', 'breakage', 'complimentary', 'spillage'] as const;
type EmptyKind = (typeof KINDS)[number];

/** empties log is management-only (audit surface, not a staff action). */
function canManageEmpties(u: { role: string; is_store_manager: boolean; is_head_chef: boolean }): boolean {
  return u.role === 'admin' || u.role === 'manager' || u.is_store_manager || u.is_head_chef;
}
/** Posting a real stock-reducing ledger adjustment is a tighter gate. */
function canAdjustLedger(u: { role: string; is_store_manager: boolean }): boolean {
  return u.role === 'admin' || u.is_store_manager;
}

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageEmpties(me)) {
      return Response.json({ error: 'Only admins, managers, store managers or HODs can view the empties log' }, { status: 403 });
    }
    const db = getDb();
    const url = new URL(request.url);
    const storeId = String(url.searchParams.get('store_id') || '').trim();
    const from = String(url.searchParams.get('from') || '').trim();
    const to = String(url.searchParams.get('to') || '').trim();
    const kind = String(url.searchParams.get('kind') || '').trim();

    const where: string[] = [];
    const args: any[] = [];
    if (storeId) { where.push('e.store_id = ?'); args.push(storeId); }
    if (from) { where.push('e.date >= ?'); args.push(from); }
    if (to) { where.push('e.date <= ?'); args.push(to); }
    if (kind && (KINDS as readonly string[]).includes(kind)) { where.push('e.kind = ?'); args.push(kind); }

    const empties = db.prepare(`
      SELECT e.id, e.store_id, e.material_id, e.qty, e.kind, e.note,
             e.recorded_by, e.date, e.created_at,
             COALESCE(rm.name, '(deleted material)') AS material_name,
             COALESCE(rm.unit, '')                   AS unit,
             COALESCE(rm.pack_size, 1)               AS pack_size,
             COALESCE(rm.category, '')               AS category,
             COALESCE(sl.name, '(deleted store)')    AS store_name
      FROM bar_empties e
      LEFT JOIN raw_materials  rm ON rm.id = e.material_id
      LEFT JOIN store_locations sl ON sl.id = e.store_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.date DESC, e.created_at DESC
      LIMIT 1000
    `).all(...args);

    return Response.json({ empties, kinds: KINDS });
  } catch (e: any) {
    console.error('[/api/stores/empties GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageEmpties(me)) {
      return Response.json({ error: 'Only admins, managers, store managers or HODs can log empties' }, { status: 403 });
    }
    const db = getDb();
    const b = await request.json();

    const storeId = String(b.store_id || '').trim();
    const materialId = String(b.material_id || '').trim();
    const qty = Number(b.qty);
    const kind = String(b.kind || 'empty').trim() as EmptyKind;
    const note = String(b.note || '').trim();
    const date = String(b.date || '').trim() || todayIST();
    const wantLedger = b.adjust_ledger === true || b.adjust_ledger === 1 || b.adjust_ledger === '1';

    if (!storeId) return Response.json({ error: 'store_id is required' }, { status: 400 });
    if (!materialId) return Response.json({ error: 'material_id is required' }, { status: 400 });
    if (!Number.isFinite(qty) || qty <= 0) {
      return Response.json({ error: 'qty must be a positive number (recipe units)' }, { status: 400 });
    }
    if (!(KINDS as readonly string[]).includes(kind)) {
      return Response.json({ error: `kind must be one of: ${KINDS.join(', ')}` }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    }

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });
    const mat = db.prepare('SELECT id, name, category, unit FROM raw_materials WHERE id = ?').get(materialId) as any;
    if (!mat) return Response.json({ error: 'Material not found' }, { status: 404 });

    // Optional stock-reducing ledger adjustment — breakage/spillage only, and
    // only for callers allowed to adjust store stock. The register row is still
    // written even if the ledger post is declined/ineligible.
    let ledgerId: string | null = null;
    if (wantLedger) {
      if (kind !== 'breakage' && kind !== 'spillage') {
        return Response.json({ error: 'Only breakage or spillage may post a stock adjustment' }, { status: 400 });
      }
      if (!canAdjustLedger(me)) {
        return Response.json({ error: 'Only admins or store managers can post a stock adjustment' }, { status: 403 });
      }
      // The material must actually be held by this store (owned via category OR
      // carried in its ledger) — mirrors /api/stores/[id]/adjust.
      const owned = materialStoreId(db, mat) === storeId;
      const held = owned || !!db.prepare('SELECT 1 FROM store_stock_ledger WHERE store_id = ? AND material_id = ? LIMIT 1').get(storeId, materialId);
      if (!held) {
        return Response.json({ error: `"${mat.name}" is not held in ${store.name} — cannot post a stock adjustment there` }, { status: 400 });
      }
      ledgerId = postLedger(db, {
        store_id: storeId,
        material_id: materialId,
        txn_type: 'adjustment',
        quantity: -Math.abs(qty),
        notes: `${kind}${note ? ' — ' + note : ''}`,
        created_by: me.email,
      });
    }

    const id = generateId();
    db.prepare(`
      INSERT INTO bar_empties (id, store_id, material_id, qty, kind, note, recorded_by, date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, storeId, materialId, Math.abs(qty), kind, note, me.email, date);

    logAuditEvent(db, {
      event_type: 'store.empties',
      entity_type: 'bar_empties',
      entity_id: id,
      actor_email: me.email,
      after: {
        store_id: storeId, store: store.name,
        material_id: materialId, material: mat.name,
        qty: Math.abs(qty), unit: mat.unit, kind, date, note,
        ledger_id: ledgerId,
      },
      note: `${store.name}: ${kind} ${Math.abs(qty)} ${mat.unit} ${mat.name}${ledgerId ? ' (stock adjusted −' + Math.abs(qty) + ')' : ''}`,
    });

    return Response.json({ ok: true, id, ledger_id: ledgerId }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/stores/empties POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
