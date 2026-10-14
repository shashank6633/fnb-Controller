import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { deptTransferableStock } from '@/lib/dept-stock';
import { fmtQtyNum, toPurchaseQty } from '@/lib/pack-units';
import { loadDepartments, canSeeDept, canSendFrom } from '../access';

/**
 * GET /api/department-transfers/holdings?department_id=<id>
 *
 * What ONE department can hand on — the sender's material picker. NOT
 * /api/department-stock: that rolls a main department up over its children,
 * so "Kitchen" there is Kitchen + Akan Tandoori + …, and Kitchen's OWN holding
 * is visible nowhere. This reads exactly one department (dept-stock.ts
 * deptTransferableStock → dept-ledger deptReleasable), the SAME figure the send
 * check enforces, minus what is already promised on pending transfers, so the
 * screen cannot offer a quantity the server will refuse.
 *
 * Each row: `transferable_purchase` + `purchase_unit` lead (owner rule);
 * `transferable` / `unit` are the RECIPE figures; `basis` is 'counted' or
 * 'uncounted_ledger_sum' — a never-counted department (Kitchen, in practice)
 * is NOT zero, it is its ledger sum, and the screen must say so (`never_counted`
 * + `basis_label` carry it in words).
 *
 * ⚠ `available` is what the department HOLDS (deptReleasable); `transferable`
 * is that minus what is already promised on PENDING transfers out — the most a
 * NEW send may ask for. A picker must cap at `transferable`, or the send is
 * refused with "… is already on pending transfers".
 *
 * department_id defaults to the caller's own department. Visible to anyone who
 * may see that department (../access.ts canSeeDept); `can_send` says whether
 * the caller may actually send from it. GET-only — no CSRF surface.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const url = new URL(request.url);
    const departmentId = (url.searchParams.get('department_id') || me.department_id || '').trim();
    if (!departmentId) return Response.json({ error: 'department_id is required' }, { status: 400 });

    const db = getDb();
    const depts = loadDepartments(db);
    const dept = depts.get(departmentId);
    if (!dept) return Response.json({ error: 'Unknown department' }, { status: 404 });
    if (!canSeeDept(me, departmentId, depts)) {
      return Response.json({ error: 'Not allowed for this department' }, { status: 403 });
    }

    const result = deptTransferableStock(db, departmentId);
    if (!result) return Response.json({ error: 'Unknown department' }, { status: 404 });
    // Added, never overriding a library field: `never_counted` and the basis in
    // words, so no screen prints the raw token 'uncounted_ledger_sum' to a cook.
    // The figures themselves are deptTransferableStock's, untouched.
    const rows = result.rows.map((r) => {
      const never = r.basis !== 'counted';
      const pu = r.purchase_unit || r.unit;
      const pend = r.pending_out > 1e-9
        ? ` ${fmtQtyNum(toPurchaseQty(r.pending_out, r))} ${pu} is already on pending transfers out.`
        : '';
      return {
        ...r,
        never_counted: never,
        basis_label: (never
          ? `${dept.name} has never counted this, so this is its ledger figure — everything received minus everything used or sent — not a count.`
          : `${dept.name}'s last count plus every movement since.`) + pend,
      };
    });
    return Response.json({
      department: { ...result.department, is_active: !!Number(dept.is_active) },
      can_send: canSendFrom(me, dept, depts),
      rows,
    });
  } catch (e: any) {
    console.error('[department-transfers/holdings GET]', e);
    return Response.json({ error: e?.message || 'Failed to load holdings' }, { status: 500 });
  }
}
