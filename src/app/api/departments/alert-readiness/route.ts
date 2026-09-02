import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { departmentAlertReadiness } from '@/lib/po-deviation-alert';

/**
 * GET /api/departments/alert-readiness   ADMIN ONLY
 *
 * "If an off-PO deviation happened right now, who would actually be told?"
 * — answered by running the SAME resolver the alert itself runs
 * (departmentAlertReadiness in @/lib/po-deviation-alert, which calls
 * mainDepartments / headChefsByMainDept / headsOf / activeAdmins, the exact
 * functions resolveDeviationAudience calls). Nothing here re-derives the rule,
 * so this endpoint cannot drift into telling the admin a comforting lie.
 *
 * ── THE GATE, AND WHY THIS ONE ─────────────────────────────────────────────
 * `getCurrentUser()` + `role !== 'admin'` -> 403. That is verbatim the gate on
 * POST, PUT and DELETE in the sibling route (src/app/api/departments/route.ts),
 * i.e. every mutating neighbour in this folder, and it matches the /departments
 * PAGE, which already hides its New / Edit / Save controls behind
 * `me?.role === 'admin'` and says so in its read-only banner. The tier is
 * resolved by getCurrentUser(), so an admin who holds the "Administrator" role
 * row passes even when users.role still says 'manager' — the same union the
 * alert's own activeAdmins() applies.
 *
 * Admin-only rather than "any signed-in user" is deliberate, on two grounds:
 * this payload is a roster of named people WITH EMAIL ADDRESSES annotated by
 * exactly how each one is unreachable, which is reconnaissance for anyone who
 * should not have it; and every remedy it prints ("Settings -> Users",
 * "Settings -> Departments") lands on an admin-only screen, so a non-admin
 * could read the problem and do nothing about it.
 *
 * DELIBERATELY A SEPARATE ROUTE, NOT A FIELD ON /api/departments. That GET has
 * no authentication of any kind (it calls getCurrentUser() nowhere) while its
 * own POST/PUT/DELETE do — a pre-existing defect I am reporting, not fixing.
 * Hanging this payload off it would have widened that hole from "department
 * rows" to "who is unreachable and why".
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }
    const db = getDb();
    return Response.json({ readiness: departmentAlertReadiness(db) });
  } catch (e: any) {
    console.error('[/api/departments/alert-readiness GET]', e);
    return Response.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
