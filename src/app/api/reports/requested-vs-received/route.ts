import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  getReqRecon, getReqReconDetail, buildReqReconWorkbook, reqReconFilename,
  defaultDepartmentId, findDepartment, canReadReqRecon,
} from '@/lib/req-recon';

/* ══════════════════════════════════════════════════════════════════════════
 * REQUESTED → ORDERED → RECEIVED — GET /api/reports/requested-vs-received
 *
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   [&dept=<department id> | all]     default: the main department named Kitchen
 *   [&material_id=<id>]               the documents behind one item (drill-down)
 *   [&format=json|xlsx]
 *
 * READ ONLY. Every figure is built in src/lib/req-recon.ts; this route only
 * checks who is asking and what they asked for.
 *
 * WHO MAY READ IT (owner, 2026-11-09): management — Admin and Manager tier —
 * and the store manager. Checked HERE, on every request, whatever the page
 * catalog says, because the catalog is not the security boundary: signed out
 * is 401, anyone else is 403, and anything that throws before the check
 * answers 500 with no data — it never falls through to the report.
 * ══════════════════════════════════════════════════════════════════════════ */

// A reconciliation served from a cache is a wrong reconciliation.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canReadReqRecon(me)) {
      return Response.json({ error: 'This report is for management and the store manager only.' }, { status: 403 });
    }

    const sp = new URL(req.url).searchParams;
    const from = sp.get('from');
    const to = sp.get('to');
    if (!from || !to || !YMD.test(from) || !YMD.test(to)) {
      return Response.json({ error: 'from and to (YYYY-MM-DD) are required' }, { status: 400 });
    }
    if (from > to) return Response.json({ error: 'from must be on or before to' }, { status: 400 });

    const format = sp.get('format');
    if (format !== null && format !== 'json' && format !== 'xlsx') {
      return Response.json({ error: `Invalid 'format' "${format}" — expected json or xlsx.` }, { status: 400 });
    }

    const db = getDb();
    const deptParam = (sp.get('dept') || '').trim();
    let departmentId: string;
    if (deptParam === '') departmentId = defaultDepartmentId(db);
    else if (deptParam.toLowerCase() === 'all') departmentId = '';
    else {
      if (!findDepartment(db, deptParam)) return Response.json({ error: 'Department not found' }, { status: 400 });
      departmentId = deptParam;
    }
    const f = { from, to, departmentId };

    const materialId = (sp.get('material_id') || '').trim();
    if (materialId) {
      if (format === 'xlsx') {
        return Response.json({ error: 'The Excel file covers the whole report — leave out material_id.' }, { status: 400 });
      }
      return Response.json(getReqReconDetail(f, materialId, db), { headers: { 'Cache-Control': 'no-store' } });
    }

    if (format === 'xlsx') {
      const { buffer, department } = buildReqReconWorkbook(f, new Date(), db);
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${reqReconFilename(f, department)}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return Response.json(getReqRecon(f, db), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: unknown) {
    console.error('[/api/reports/requested-vs-received]', e);
    const msg = e instanceof Error && e.message ? e.message : 'Failed to build the report';
    return Response.json({ error: msg }, { status: 500 });
  }
}
