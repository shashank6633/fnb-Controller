/**
 * GET /api/feedback/analytics — Page 4's dashboard.  (P5 Lane B)
 *
 * THIS FILE EXPORTS `GET` AND NOTHING ELSE, AND THAT IS THE ENFORCEMENT.
 * The App Router answers 405 for any verb a `route.ts` does not export, so the
 * read-only promise is structural: there is no POST/PATCH/DELETE to audit, and
 * every query behind it lives in `src/lib/feedback/reporting.ts`, which is
 * SELECT-only by construction.
 *
 * MANAGEMENT ONLY, AND THE GATE IS HERE, NOT ONLY ON THE PAGE. Hard rule 9:
 * `proxy.ts` guards PAGES, NOT APIs, and `canAccessPage` fails open four ways.
 * `page-catalog.ts` carries `mgmtOnly` for `/feedback/analytics`, which stops a
 * GRE opening the SCREEN — it does nothing whatever about a GRE fetching this
 * URL directly. `requireFeedbackAnalyst()` is the only thing that does, and it
 * is the first statement in the handler. Measured in the P5 evidence: an
 * assigned GRE gets 403 `not_management` here, not a payload.
 *
 * That refusal is also the fairness ruling holding: the league table is not
 * something the people in it can read.
 *
 * PATH HYGIENE (hard rule 9): no segment contains `print` and the path does not
 * end `.json` — `isPublic()` matched both patterns and made such routes
 * publicly reachable AND CSRF-exempt. `/api/feedback/analytics` is clean, and
 * the `/api/` floor added in 9224f6d is a second belt.
 */

import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import { requireFeedbackAnalyst } from '@/lib/feedback/session';
import { analytics, filtersFromQuery, itemComments } from '@/lib/feedback/reporting';

export async function GET(req: Request) {
  const gate = await requireFeedbackAnalyst();
  if (!gate.ok) return Response.json(gate.body, { status: gate.status });

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) ?? '';
    const sp = new URL(req.url).searchParams;
    const filters = filtersFromQuery(sp);

    // `?item_key=` switches this route to the click-through view the owner
    // asked for by name — the actual comments behind one menu item. Same
    // filters, same computation, so the header figures in the sheet are the
    // ones on the row that was clicked.
    const itemKey = (sp.get('item_key') ?? '').trim();
    if (itemKey) {
      const { item, rows, range } = itemComments(db, { outletId, filters, itemKey });
      return Response.json({
        mode: 'item_comments',
        item,
        comments: rows,
        range,
        viewer: { name: gate.me.name, role_name: gate.me.role_name, scope: gate.decision.scope },
      });
    }

    const payload = analytics(db, { outletId, filters });
    return Response.json({
      ...payload,
      viewer: { name: gate.me.name, role_name: gate.me.role_name, scope: gate.decision.scope },
    });
  } catch (e: any) {
    console.error('[/api/feedback/analytics GET]', e);
    // Deliberately NOT an empty dashboard. A 500 answered as `{summary:{...0}}`
    // would render as "nobody complained today", which is the single most
    // dangerous thing this page could say.
    return Response.json(
      { error: e?.message || 'Failed to compute the feedback analytics' },
      { status: 500 },
    );
  }
}
