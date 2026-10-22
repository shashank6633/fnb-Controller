import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { deptTransferableStock } from '@/lib/dept-stock';
import { fmtQtyNum } from '@/lib/pack-units';
import { loadDepartments, canSeeDept, canSendFrom, receiversFor } from '../access';

/**
 * GET /api/department-transfers/holdings?department_id=<id>
 *
 * What ONE department can hand on — the sender's material picker — and WHERE
 * it can send it. NOT /api/department-stock: that rolls a main department up
 * over its children, so "Kitchen" there is Kitchen + Akan Tandoori + …, and
 * Kitchen's OWN holding is visible nowhere. This reads exactly one department
 * (dept-stock.ts deptTransferableStock → dept-ledger deptSendable), the SAME
 * figure the send check enforces, so the screen cannot offer a quantity the
 * server will refuse.
 *
 * Each row: `transferable_purchase` + `purchase_unit` lead (owner rule) —
 * ROUNDED DOWN to 3 decimals, so the offered figure always converts back to no
 * more than the server accepts. `transferable` / `unit` are the RECIPE
 * figures; `basis` is 'counted' or 'uncounted_ledger_sum'.
 *
 * HONEST ABOUT WHAT THE APP CANNOT SEE: a never-counted row is `upper_bound`
 * — "up to", not "holds" — and when `department.usage_booked_here` is false no
 * till station books this department's cooking to it, so anything cooked from
 * this stock never reached its ledger. `basis_label` says it in words a cook
 * can read; the screen must show it and point at a count.
 *
 * `receivers`: every other ACTIVE department, in the owner's order — the
 * sender's own family first, departments where requisitions land first within
 * each group (Kitchen → the AKAN-* sub-kitchens). Any may be chosen.
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
    const usageHere = result.department.usage_booked_here;
    const stationList = result.department.stations.join(', ');
    // Added, never overriding a library field: the basis in words, so no
    // screen prints the raw token 'uncounted_ledger_sum' to a cook. The figures
    // themselves are deptTransferableStock's, untouched.
    //
    // WHAT THE APP CANNOT SEE, SAID PLAINLY. A mapped station books only the
    // dishes fired on THAT station: routed chicken grilled on the tandoor
    // station is booked to top-level Tandoor (the owner's mapping), never to
    // Kitchen, even though Kitchen has the 'kitchen' station. So the label
    // names the stations rather than claiming "cooking here is deducted".
    const rows = result.rows.map((r) => {
      const pu = r.purchase_unit || r.unit;
      const upTo = `${fmtQtyNum(r.transferable_purchase)} ${pu}`;
      let label: string;
      if (r.upper_bound) {
        label = `Up to ${upTo}. ${dept.name} has never counted this, so this is its ledger — everything received ` +
          `minus everything used or sent — not a count. ` +
          (usageHere
            ? `Only dishes fired on the ${stationList} station${result.department.stations.length > 1 ? 's' : ''} are taken off here at the till; ` +
              `anything cooked from this stock on another station, and waste nobody recorded, is not — the shelf may hold less.`
            : `No till station books ${dept.name}'s cooking to it, so whatever was cooked from this stock is NOT taken off here — the shelf may hold less.`) +
          ` Count it to send an exact figure.`;
      } else if (r.since_anchor != null && r.since_anchor < (r.on_hand ?? 0)) {
        label = `${dept.name}'s last count plus every movement since, held to the lower reading because the count is older than the department cutover.`;
      } else if (r.since_anchor != null && r.on_hand != null && r.since_anchor > r.on_hand + 1e-9) {
        // The count is older than the cutover floor and the floor hides what was
        // booked in between (an issue, say) while every transfer since the count
        // stays in (dept-ledger "A TRANSFER PAIR IS NEVER SPLIT"). The books are
        // then NOT "the last count plus every movement since" — say what they are
        // (conservation verifier, targeted.cjs A2: books −2 kg, count + every
        // movement since 3 kg, the shelf 3 kg).
        const pf = r.pack_factor || 1;
        label = `${dept.name} was last counted before the department cutover. Every other movement booked between that ` +
          `count and the cutover (issues, use, waste) is left out of its books, while every transfer since the count is kept — so its books read ` +
          `${fmtQtyNum(r.on_hand / pf)} ${pu}, although the count plus every movement since it comes to ` +
          `${fmtQtyNum(r.since_anchor / pf)} ${pu}. Count it again and its books start from the shelf.`;
      } else {
        label = `${dept.name}'s last count plus every movement since.`;
      }
      if (r.available < -1e-9) label += ' The ledger is below zero — record a count before sending.';
      return { ...r, never_counted: r.upper_bound, basis_label: label };
    });
    return Response.json({
      department: { ...result.department, is_active: !!Number(dept.is_active) },
      can_send: canSendFrom(me, dept),
      rows,
      receivers: receiversFor(db, departmentId, depts),
    });
  } catch (e: any) {
    console.error('[department-transfers/holdings GET]', e);
    return Response.json({ error: e?.message || 'Failed to load holdings' }, { status: 500 });
  }
}
