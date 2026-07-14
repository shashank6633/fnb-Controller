import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { allowedDeptIds, canSeeAllDeptStock, computeDeptStock } from '@/lib/dept-stock';

/**
 * GET /api/department-stock?department_id=X
 *
 * Computed per-department stock balance (no table behind it — see
 * src/lib/dept-stock.ts for the definition):
 *   on_hand_est = latest closing count for the dept + store issues since.
 *
 * Auth: admin / manager / HOD (is_head_chef) / store manager → any dept;
 * everyone else only their own department + granted visible_department_ids
 * (mirrors closing-stock page canSeeAllDepts). GET-only — no CSRF surface.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const url = new URL(request.url);
    const departmentId = (url.searchParams.get('department_id') || '').trim();
    if (!departmentId) {
      return Response.json({ error: 'department_id is required' }, { status: 400 });
    }

    const db = getDb();
    const dept = db.prepare('SELECT id, name FROM departments WHERE id = ?').get(departmentId) as
      { id: string; name: string } | undefined;
    if (!dept) return Response.json({ error: 'Unknown department' }, { status: 400 });

    if (!canSeeAllDeptStock(me) && !allowedDeptIds(me).has(dept.id)) {
      return Response.json({ error: 'Not allowed for this department' }, { status: 403 });
    }

    const result = computeDeptStock(db, dept.id);
    if (!result) return Response.json({ error: 'Unknown department' }, { status: 400 });

    return Response.json({
      department: { id: dept.id, name: dept.name },
      rows: result.rows,
      summary: result.summary,
    });
  } catch (e: any) {
    console.error('[department-stock]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
