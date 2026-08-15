import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  allowedDeptSetExpanded,
  canSeeAllDeptStock,
  getDeptLedgerCutoverAt,
  stockOnHandBulk,
} from '@/lib/dept-stock';
import type { StockOnHand } from '@/lib/dept-stock';

/**
 * GET /api/stock-on-hand[?material_ids=a,b,c]
 *
 * THE LIVE "what is in hand right now" figure, per material, for a whole picker
 * in ONE call: what the STORES hold and what the DEPARTMENTS hold, kept as two
 * separate numbers.
 *
 * WHY ONE CALL. This is a single-threaded better-sqlite3 process that has
 * already produced a 504 under load. A request per material, or a loop over
 * /api/department-stock?department_id=X, is an N+1 that queues billing, KOT and
 * the captain app behind it — and that per-department route's dominant cost is a
 * 16k-row requisition_items join filling `pre_cutover_issued`, which a picker
 * does not use at all. Both pickers call THIS route exactly once at mount and
 * cache the result for the life of the modal.
 *
 * Omitting material_ids returns the whole catalogue, which is the intended
 * usage: it is a fraction of the payload the same screens already pull from
 * /api/inventory?scope=all, and it removes any temptation to fetch per row.
 *
 * BASIS. Every quantity is in RECIPE units — the stored basis, unconverted. The
 * pack meta rides along on each material so the client converts ONCE through
 * toPurchaseQty() (src/lib/pack-units.ts) and leads with the PURCHASE unit, per
 * the owner rule. Never divide by pack_size by hand.
 *
 * ZERO IS NOT "UNKNOWN". A material missing from `materials` is unknown and must
 * render "unavailable". dept_counted_qty comes back as null — never 0 — when no
 * department in scope has an anchored count. A rendered 0 must only ever mean a
 * measured zero.
 *
 * ACCESS.
 *   · Unauthenticated → 401. (This must not be the loose door: the department
 *     rail is 403-gated on /api/department-stock.)
 *   · Stores rail + central_qty → every signed-in user. It is already visible to
 *     them through /api/inventory?scope=all, which both pickers call.
 *   · Departments rail → canSeeAllDeptStock (admin / manager / head chef / store
 *     manager) sees all; a granted user sees only allowedDeptSetExpanded; anyone
 *     else sees none. Hidden departments are omitted from `depts` AND excluded
 *     from dept_counted_qty — a roll-up the viewer cannot decompose is a wrong
 *     number. dept_scope tells the UI which of the three it got, so it can print
 *     "restricted" instead of "not counted" or "0".
 *   · Fail closed: if the department rail throws, the response degrades to
 *     mode "none" with dept_scope.error set. A partial department total is never
 *     presented as a complete one.
 *
 * READ-ONLY. GET only, no writes, no CSRF surface. Nothing here is cached or
 * frozen — the PO-time snapshot is a separate record.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** A GET query string cannot carry the whole catalogue as 36-char ids anyway;
 *  past this the caller should simply omit the filter. */
const MAX_MATERIAL_IDS = 2000;

type DeptScopeMode = 'all' | 'partial' | 'none';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const db = getDb();
    const url = new URL(request.url);

    // ── material scope ──────────────────────────────────────────────────────
    const rawIds = (url.searchParams.get('material_ids') || '').trim();
    let materialIds: string[] | undefined;
    if (rawIds) {
      const ids = [...new Set(rawIds.split(',').map((s) => s.trim()).filter(Boolean))];
      if (ids.length > MAX_MATERIAL_IDS) {
        return Response.json({
          error: `material_ids is capped at ${MAX_MATERIAL_IDS} — omit it to fetch the whole catalogue in one call`,
        }, { status: 400 });
      }
      materialIds = ids;
    }

    // ── department scope ────────────────────────────────────────────────────
    // `total` and `visible` count ACTIVE departments only, matching
    // dept_uncounted_count (a data-quality signal about live departments), so
    // the UI can honestly say "18 of 19 departments never counted".
    const activeDeptIds = new Set(
      (db.prepare('SELECT id FROM departments WHERE is_active = 1').all() as { id: string }[])
        .map((d) => d.id),
    );
    const total = activeDeptIds.size;

    let mode: DeptScopeMode;
    let visible: number;
    /** undefined = every department; [] = none; [ids] = exactly those. */
    let deptIds: string[] | undefined;
    let scopeError = '';

    if (canSeeAllDeptStock(me)) {
      mode = 'all';
      visible = total;
      deptIds = undefined;
    } else {
      // allowedDeptSetExpanded pulls in sub-departments of a granted main dept,
      // and may include deactivated ones — those still produce a leg when they
      // hold counted stock, but never inflate `visible`.
      const allowed = allowedDeptSetExpanded(db, me);
      if (allowed.length === 0) {
        mode = 'none';
        visible = 0;
        deptIds = [];
      } else {
        mode = 'partial';
        visible = allowed.filter((id) => activeDeptIds.has(id)).length;
        deptIds = allowed;
      }
    }

    // ── the one batched pass ────────────────────────────────────────────────
    let materialsMap: Map<string, StockOnHand>;
    try {
      materialsMap = stockOnHandBulk(db, materialIds, deptIds === undefined ? undefined : { deptIds });
    } catch (e: any) {
      // Fail CLOSED on the department half rather than shipping a partial
      // department figure dressed as a complete one. If the retry with no
      // departments throws too, the failure is in the stores rail — let it 500
      // rather than print a wrong store number.
      if (mode === 'none') throw e;
      console.error('[stock-on-hand] department rail failed — degrading to restricted', e);
      mode = 'none';
      visible = 0;
      scopeError = 'Department stock could not be read';
      materialsMap = stockOnHandBulk(db, materialIds, { deptIds: [] });
    }

    const materials: Record<string, Omit<StockOnHand, 'material_id'>> = {};
    for (const [id, s] of materialsMap) {
      materials[id] = {
        unit: s.unit,
        purchase_unit: s.purchase_unit,
        pack_size: s.pack_size,
        case_size: s.case_size,
        central_qty: s.central_qty,
        stores: s.stores,
        store_total_qty: s.store_total_qty,
        store_mapped: s.store_mapped,
        depts: s.depts,
        dept_counted_qty: s.dept_counted_qty,
        dept_counted_count: s.dept_counted_count,
        dept_uncounted_count: s.dept_uncounted_count,
      };
    }

    return Response.json({
      as_of: new Date().toISOString(),
      /** Every quantity below is in RECIPE units. The client converts once. */
      basis: 'recipe',
      /** null = the department-ledger cutover has never been run, so EVERY
       *  department figure is legitimately "not counted". The UI says this once,
       *  as a banner, instead of repeating it on every row. */
      cutover_at: getDeptLedgerCutoverAt(db),
      dept_scope: scopeError
        ? { mode, visible, total, error: scopeError }
        : { mode, visible, total },
      materials,
    });
  } catch (e: any) {
    console.error('[stock-on-hand]', e);
    return Response.json({ error: e?.message || 'Failed to read stock on hand' }, { status: 500 });
  }
}
