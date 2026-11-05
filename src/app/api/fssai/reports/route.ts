/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { isManagement } from '@/lib/auth';
import { fssaiToday } from '@/lib/fssai';
import { requireFssaiUser, str } from '@/lib/fssai-server';
import { csvBody, dateWindow, departmentNames, fssaiTablesPresent, slug } from '../_p9/lib';
import { FSSAI_REPORTS, fssaiReport, primeDeptNames, type FssaiReportCtx } from '../_p9/reports';

/**
 * FSSAI REPORTS (/api/fssai/reports) — owner §18.
 *
 *   GET                                 the catalogue: every report, its filters,
 *                                       and whether its register exists yet
 *   GET ?report=<key>&…                 run one, as JSON for the screen
 *   GET ?report=<key>&format=csv&…      the same rows as a download
 *
 * The PDF is a separate route (./pdf) because it returns bytes rather than JSON.
 * Neither path contains the segment `print` — RECON §7.5: proxy.ts:125 treats any
 * pathname containing '/print' as PUBLIC, so a compliance pack served from a
 * /print path would be readable with no session at all.
 *
 * ── MANAGEMENT ONLY ─────────────────────────────────────────────────────────
 * /fssai/reports is mgmtOnly in the page catalog, and the catalog is visibility
 * and never security (canAccessPage fails open four ways, and page_access is NULL
 * on 8 of 9 live users). So the gate that actually holds is this one, in the
 * route, and it matches the catalog rather than second-guessing it. Owner §7 Q10
 * would also allow a staff member their own department's figures; that is a
 * narrower screen than this one and is not built here — the dashboard already
 * gives a staff member their own department, scoped per bucket.
 *
 * ── TWO DEFAULTS WORTH KNOWING ──────────────────────────────────────────────
 * 1. NO DATE RANGE IS APPLIED UNLESS ONE IS ASKED FOR. RECON §7.2 records what a
 *    silent first-of-month default once did: "0 of 2,165 rows and Rs 0 of Rs 69.26
 *    lakh… He read that as his books having been lost." On a compliance report an
 *    empty window reads as checks never having been done.
 * 2. VOIDED ROWS ARE INCLUDED BY DEFAULT, marked as voided. §19 is "void, never
 *    delete"; a report that hides them undoes the whole point. `status=active` is
 *    the deliberate choice that leaves them out.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me as any;
  if (!isManagement(me)) {
    return Response.json(
      { error: 'Food-safety reports are management only. Ask a manager or an administrator to run this.' },
      { status: 403 },
    );
  }

  try {
    const db = getDb();
    const url = new URL(request.url);
    const today = fssaiToday();
    const present = fssaiTablesPresent(db);
    const deptMap = departmentNames(db);
    primeDeptNames(db, deptMap);

    const key = str(url.searchParams.get('report'));

    /* ══ THE CATALOGUE ═════════════════════════════════════════════════════ */
    if (!key) {
      return Response.json({
        reports: FSSAI_REPORTS.map((r) => {
          const missing = r.requires.filter((t) => !present.has(t));
          return {
            key: r.key,
            label: r.label,
            group: r.group,
            blurb: r.blurb,
            date_label: r.dateLabel,
            has_department: r.hasDepartment,
            columns: r.columns,
            available: missing.length === 0,
            /* Named, so the screen can say WHICH register is not there yet
             * instead of showing a report that returns nothing. */
            missing_tables: missing,
          };
        }),
        departments: [...deptMap.entries()].map(([id, name]) => ({ id, name })),
        today,
        generated_at: new Date().toISOString(),
      });
    }

    const def = fssaiReport(key);
    if (!def) return Response.json({ error: 'There is no report by that name.' }, { status: 404 });

    const missing = def.requires.filter((t) => !present.has(t));
    if (missing.length) {
      return Response.json(
        {
          error:
            'That register has not been created in this copy of the database yet, so there is nothing to report on. ' +
            'Restart the application once and it will be there.',
          missing_tables: missing,
        },
        { status: 503 },
      );
    }

    const window = dateWindow(
      str(url.searchParams.get('from')),
      str(url.searchParams.get('to')),
      str(url.searchParams.get('mode')),
    );
    const ctx: FssaiReportCtx = {
      db,
      today,
      window,
      departmentId: def.hasDepartment ? str(url.searchParams.get('department_id')) : '',
      status: str(url.searchParams.get('status')) || 'all',
      q: str(url.searchParams.get('q')),
      limit: Number(url.searchParams.get('limit')) || 1000,
    };

    const result = def.run(ctx);

    /* ══ CSV ═══════════════════════════════════════════════════════════════ */
    if (str(url.searchParams.get('format')) === 'csv') {
      const body = csvBody(def.columns.map((c) => c.label), result.cells);
      return new Response(body, {
        headers: {
          /* BOM + charset: without it Excel renders "4 °C" as "4 Â°C", and
           * temperature readings are the bulk of what this module exports. */
          'Content-Type': 'text/csv;charset=utf-8',
          'Content-Disposition': `attachment; filename="fssai-${slug(def.label)}-${today}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return Response.json({
      report: {
        key: def.key, label: def.label, group: def.group, blurb: def.blurb,
        date_label: def.dateLabel, has_department: def.hasDepartment, columns: def.columns,
      },
      rows: result.cells,
      kpis: result.kpis || [],
      note: result.note || '',
      truncated: !!result.truncated,
      row_count: result.cells.length,
      period: window.label,
      period_is_everything: window.all,
      filters_applied: {
        from: window.from, to: window.to, all_dates: window.all,
        department_id: ctx.departmentId, department_name: ctx.departmentId ? deptMap.get(ctx.departmentId) || '' : '',
        status: ctx.status, q: ctx.q, limit: ctx.limit,
      },
      today,
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('GET /api/fssai/reports failed:', e);
    return Response.json({ error: e?.message || 'Failed to run that report' }, { status: 500 });
  }
}
