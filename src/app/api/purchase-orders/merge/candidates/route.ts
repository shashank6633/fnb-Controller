import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canProcessAsStore } from '@/lib/auth';
import { evaluateRequisitionLines, materialBuyHints } from '@/lib/po-helpers';

/**
 * GET /api/purchase-orders/merge/candidates — the requisition lines a merged
 * PO can buy for (owner rulings #63-#70).
 *
 * Every line of a requisition that is waiting on the store (the store desk's
 * own inbox rule, internal AND party) that the store still OWES — not fully
 * issued by THE RULE (issue-stock.ts lineIssueComplete), not chef- or
 * store-rejected, not already on a live PO, not served by its requisition's
 * own "Also raise a vendor PO" PO.
 *
 * Query (all optional): department_id, purpose ('internal' | 'party').
 *
 * 200 → {
 *   lines: [{                    // orderable, oldest requisition first
 *     req_item_id, requisition_id, req_number, req_date, req_status, purpose,
 *     event_name, event_date, department_id, department_name, department_code,
 *     material_id, material_name, material_sku, material_category,
 *     line_unit, recipe_unit, purchase_unit, pack_size, pack_factor,
 *     qty_approved, qty_issued, owed_line,      // the LINE's own unit
 *     owed_purchase,                            // PURCHASE units (3 dp)
 *     central_stock_purchase,                   // PURCHASE units, "In store"
 *     current_stock,                            // the same balance, RECIPE units
 *     deferred_until, defer_reason,
 *     default_vendor_id, default_vendor_name, default_vendor_source,
 *     last_rate, last_rate_source ('default_vendor' | 'any_vendor' | null),
 *     last_rate_vendor_name (alias last_rate_vendor), last_rate_date
 *                                               // last_rate is ₹ per PURCHASE unit
 *   }],
 *   materials: { [material_id]: { mapped_vendors: [{id, name, is_active,
 *                 last_rate, last_rate_date}], default_vendor, last_purchase } },
 *   not_orderable: [{ ...line, code, reason }]  // owed, but cannot go on a PO
 * }
 *
 * WHO: the store manager or an admin (ruling #65), the same gate as the merge.
 */
export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canProcessAsStore(me)) {
      return Response.json({ error: 'Only the Store Manager or an Admin can merge requisitions into a PO.' }, { status: 403 });
    }
    const db = getDb();
    const url = new URL(request.url);
    const departmentId = (url.searchParams.get('department_id') || '').trim();
    const purpose = (url.searchParams.get('purpose') || '').trim();
    const outletId = await getCurrentOutletId();

    let all = evaluateRequisitionLines(db, { outletId });
    if (departmentId) all = all.filter(l => l.department_id === departmentId);
    if (purpose === 'internal' || purpose === 'party') all = all.filter(l => l.purpose === purpose);

    // A line THE RULE calls complete (or that owes less than one printed step)
    // is not owed at all, and a requisition still waiting on management (with
    // require_mgmt_approval on) is not the store's yet — neither is a candidate
    // nor "not orderable".
    const owed = all.filter(l => !l.blocked || (l.blocked.code !== 'nothing_owed' && l.blocked.code !== 'not_with_store'));
    const orderable = owed.filter(l => !l.blocked);
    const hints = materialBuyHints(db, orderable.map(l => l.material_id));

    const lines = orderable.map(l => {
      const h = hints.get(l.material_id);
      const dv = h?.default_vendor || null;
      const ownRate = h?.default_vendor_last_rate ?? null;
      const anyRate = h?.last_purchase || null;
      const { blocked: _blocked, ...rest } = l;
      void _blocked;
      return {
        ...rest,
        default_vendor_id: dv?.id ?? null,
        default_vendor_name: dv?.name ?? null,
        default_vendor_source: dv?.source ?? null,
        last_rate: ownRate ?? anyRate?.rate ?? null,
        last_rate_source: ownRate != null ? 'default_vendor' : (anyRate ? 'any_vendor' : null),
        last_rate_vendor_name: ownRate != null ? (dv?.name ?? null) : (anyRate?.vendor_name ?? null),
        last_rate_vendor: ownRate != null ? (dv?.name ?? null) : (anyRate?.vendor_name ?? null),
        last_rate_date: ownRate != null
          ? (h?.mapped_vendors.find(v => v.id === dv?.id)?.last_rate_date ?? null)
          : (anyRate?.date ?? null),
      };
    });
    const materials: Record<string, unknown> = {};
    for (const [mid, h] of hints) {
      materials[mid] = { mapped_vendors: h.mapped_vendors, default_vendor: h.default_vendor, last_purchase: h.last_purchase };
    }
    const not_orderable = owed
      .filter(l => l.blocked)
      .map(l => {
        const { blocked, ...rest } = l;
        return { ...rest, code: blocked!.code, reason: blocked!.reason };
      });
    return Response.json({ lines, materials, not_orderable });
  } catch (error: unknown) {
    console.error('[/api/purchase-orders/merge/candidates GET]', error);
    return Response.json({ error: (error instanceof Error && error.message) || 'Could not list requisition lines' }, { status: 500 });
  }
}
