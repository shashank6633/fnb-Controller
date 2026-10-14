import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import { getStoreById, listStores, materialStoreId } from '@/lib/store-engine';
import { requireWithdrawalsAdmin } from './_lib/guard';
import {
  createWithdrawal, listWithdrawals, withdrawalSummary, storeMaterialOnHand, WithdrawalRefusal,
  type WithdrawalMaterial, type CreateWithdrawalInput,
} from '@/lib/liquor-withdrawals';
import {
  LQ_WITHDRAWAL_CATEGORIES, LQ_RECOVERY_BASIS, type LqWithdrawalCategory,
} from '@/lib/liquor-recon';

/**
 * /api/liquor/withdrawals — liquor stock withdrawals register (phase L4).
 *
 * ADMIN-ONLY, server-side, on BOTH verbs, and CSRF-checked on POST. The gate is
 * ./_lib/guard.ts, shared with /[id]; see it for why the double-submit check
 * lives here and not in proxy.ts. This is the director/management personal-use
 * ledger and it MOVES STOCK, so a manager with a bare '/inventory' grant must
 * still be refused.
 *
 * GET  → { withdrawals, summary, stores, categories, recovery_basis }
 *        query: from, to, category, store_id, outstanding_only=1
 * POST → create one withdrawal (atomic ledger movement + register row).
 */
export const dynamic = 'force-dynamic';

function loadMaterial(db: ReturnType<typeof getDb>, id: string): WithdrawalMaterial | null {
  const m = db.prepare(`
    SELECT id, name, category, unit, purchase_unit, pack_size, case_size, average_price
    FROM raw_materials WHERE id = ?
  `).get(id) as any;
  if (!m) return null;
  return {
    id: m.id, name: m.name, category: m.category, unit: m.unit,
    purchase_unit: m.purchase_unit, pack_size: m.pack_size, case_size: m.case_size,
    average_price: m.average_price,
  };
}

export async function GET(request: Request) {
  try {
    const gate = await requireWithdrawalsAdmin(request);
    if (!gate.ok) return gate.response;
    const db = getDb();

    const url = new URL(request.url);
    const filter = {
      from: url.searchParams.get('from') || undefined,
      to: url.searchParams.get('to') || undefined,
      category: (url.searchParams.get('category') || '') as LqWithdrawalCategory | '',
      store_id: url.searchParams.get('store_id') || undefined,
      outstanding_only: url.searchParams.get('outstanding_only') === '1',
    };

    const withdrawals = listWithdrawals(db, filter);
    const summary = withdrawalSummary(db, filter);
    const stores = listStores(db).filter(s => !!s.is_active).map(s => ({ id: s.id, name: s.name }));

    return Response.json({
      withdrawals, summary, stores,
      categories: LQ_WITHDRAWAL_CATEGORIES,
      recovery_basis: LQ_RECOVERY_BASIS,
    });
  } catch (e: any) {
    console.error('[/api/liquor/withdrawals GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    // Auth + admin + CSRF, BEFORE the body is read or anything is looked up.
    const gate = await requireWithdrawalsAdmin(request);
    if (!gate.ok) return gate.response;
    const user = gate.user;
    const db = getDb();

    const b = await request.json();
    const storeId = String(b.store_id || '').trim();
    const materialId = String(b.material_id || '').trim();
    if (!storeId) return Response.json({ error: 'store_id is required' }, { status: 400 });
    if (!materialId) return Response.json({ error: 'material_id is required' }, { status: 400 });

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });

    const mat = loadMaterial(db, materialId);
    if (!mat) return Response.json({ error: 'Material not found' }, { status: 404 });

    // The material must belong to this store (category-mapped) OR be actually held
    // via its ledger — the same ownership test the adjust route uses, so a floor
    // bar can withdraw what was transferred into it even though it owns no
    // categories. This keeps a Central-only material out of the liquor ledger.
    if (materialStoreId(db, mat) !== storeId) {
      const held = storeMaterialOnHand(db, storeId, materialId) !== 0
        || !!db.prepare('SELECT 1 FROM store_stock_ledger WHERE store_id = ? AND material_id = ? LIMIT 1').get(storeId, materialId);
      if (!held) {
        return Response.json({
          error: `"${mat.name}" is not a ${store.name} material — its category "${mat.category}" is not mapped to this store`,
        }, { status: 400 });
      }
    }

    const input: CreateWithdrawalInput = {
      store_id: storeId,
      material_id: materialId,
      date: String(b.date || '').trim(),
      category: String(b.category || '') as LqWithdrawalCategory,
      cases: Number(b.cases) || 0,
      bottles: Number(b.bottles) || 0,
      landed_unit_cost: b.landed_unit_cost === undefined || b.landed_unit_cost === null || b.landed_unit_cost === ''
        ? null : Number(b.landed_unit_cost),
      mrp_unit_value: b.mrp_unit_value === undefined || b.mrp_unit_value === null || b.mrp_unit_value === ''
        ? null : Number(b.mrp_unit_value),
      taken_by: String(b.taken_by || '').trim(),
      authorised_by: String(b.authorised_by || '').trim(),
      recovery_basis: b.recovery_basis || 'none',
      recoverable_custom: b.recoverable_custom === undefined || b.recoverable_custom === null || b.recoverable_custom === ''
        ? null : Number(b.recoverable_custom),
      recovered: b.recovered === undefined || b.recovered === null || b.recovered === '' ? 0 : Number(b.recovered),
      excise_register: !!b.excise_register,
      co_write_wastage: !!b.co_write_wastage,
      remarks: String(b.remarks || '').trim(),
      recorded_by: user.email,
      allow_negative: !!b.allow_negative,
      // Stamped from the SESSION, never trusted off the body. An unstamped
      // co-written wastage row lists under every outlet
      // (GET /api/wastage passes `outlet_id IS NULL` rows through for all of
      // them) and the audit event loses its licence scope. lq_withdrawals
      // itself is store-scoped by design (db.ts) — this only travels to the
      // co-write and the audit row.
      outlet_id: (await getCurrentOutletId()) || null,
      confirm_duplicate: !!b.confirm_duplicate,
    };

    const row = createWithdrawal(db, input, mat);
    return Response.json({ ok: true, withdrawal: row }, { status: 201 });
  } catch (e: any) {
    // A refusal someone must act on elsewhere first (run Migrate; decide the
    // count that already covers this date) — 409 with its code, nothing written.
    // Not logged as an error: it is the guard working.
    if (e instanceof WithdrawalRefusal) {
      return Response.json({ error: e.message, code: e.code }, { status: e.status });
    }
    console.error('[/api/liquor/withdrawals POST]', e);
    // createWithdrawal throws user-presentable messages for validation; surface
    // those as 400, unexpected failures as 500.
    const msg = String(e?.message || 'Failed to record withdrawal');
    // A contended save is the caller's cue to retry, not a server fault. 216 of
    // these were measured in a 6-process race and every one left the data
    // perfectly consistent — reporting them as 500 sent an admin hunting a bug.
    if (/database is locked|SQLITE_BUSY/i.test(msg)) {
      return Response.json({ error: 'The register is busy with another save — try again in a moment.' }, { status: 409 });
    }
    // The duplicate guard is recoverable by a human decision, so it gets its own
    // status: the page offers "Record anyway" (confirm_duplicate) on a 409.
    if (/looks like a duplicate/i.test(msg)) return Response.json({ error: msg, duplicate: true }, { status: 409 });
    const client = /required|must be|cannot be negative|Enter a quantity|Enter the recoverable|Not enough stock|cannot exceed|not a |only valid|Unknown|not found|YYYY-MM-DD|in the future|recovery basis|Recovery is set|recovers at|recovers nothing/i.test(msg);
    return Response.json({ error: msg }, { status: client ? 400 : 500 });
  }
}
