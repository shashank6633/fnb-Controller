/**
 * GET /api/feedback/tracker — Page 3's ledger.  (P4 Lane A)
 *
 * 🔒 THIS FILE EXPORTS `GET` AND NOTHING ELSE, AND THAT IS THE ENFORCEMENT.
 * The App Router answers 405 for any verb a route.ts does not export, so the
 * read-only promise is structural rather than a check someone could forget:
 * there is no POST/PATCH/DELETE to audit, and `./query.ts` contains no SQL
 * write verb at all. Same shape as `/api/feedback/floor`.
 *
 * ⚠️ IT GATES ITSELF — hard rule 9. `src/proxy.ts` guards PAGES, NOT APIs, and
 * `canAccessPage` fails open four ways, so `requireFeedbackReader()` on the
 * first line is the only real check on this data. Pages 1-3 share one gate
 * (`src/lib/feedback/access.ts`); the analytics gate is a different function and
 * is NOT used here, because the owner's spec puts the Tracker in front of the
 * GRE as well as the Floor Manager.
 *
 * ⚠️ PATH HYGIENE (hard rule 9): no segment contains `print` and the path does
 * not end `.json` — `isPublic()` treated both as public AND CSRF-exempt, and
 * although a hard `/api/` floor now stands above those patterns, the habit is
 * what keeps the next route safe. `/api/feedback/tracker` is clean, and the
 * `/api/feedback` prefix is in `CSRF_REQUIRED_PREFIXES`, so a state-changing
 * request here is refused before it reaches this file (403) even though there
 * is no handler for one (405).
 *
 * ── WHAT THE FILTERS ARE, AND WHERE THEY ARE APPLIED ────────────────────────
 * Everything is a QUERY PARAMETER and everything is applied SERVER-SIDE:
 *   ?filter=  all | pending | completed | negative | follow_up | resolved
 *   ?floor=   restaurant_tables.zone ('' shown as 'Floor'), or 'all'
 *   ?gre=     the name that recorded the visit carrying the GRE role, or 'all'
 *   ?manager= the name that recorded it as management, or 'all'
 *   ?captain= orders.server_name, or 'all'
 *   ?date=    YYYY-MM-DD business date; default and fallback is today's service
 * An unknown value for any of them falls back to 'all' / today rather than
 * erroring — a coverage screen must not go blank because a stale dropdown sent
 * a floor that no longer exists. The counts, the chips, the list and the
 * coverage table are all derived from the SAME scoped rows (query.ts §3).
 */

import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import { requireFeedbackReader } from '@/lib/feedback/session';
import { readTracker, type TrackerScope } from './query';

/** One query parameter, trimmed and length-capped. Absent / blank / oversized
 *  → 'all'. The cap is not paranoia: these values are echoed back in
 *  `meta.scope` and rendered on screen. */
function param(v: string | null, fallback = 'all'): string {
  const s = String(v ?? '').trim();
  if (!s || s.length > 64) return fallback;
  return s;
}

export async function GET(req: Request) {
  const gate = await requireFeedbackReader();
  if (!gate.ok) return Response.json(gate.body, { status: gate.status });

  try {
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const q = new URL(req.url).searchParams;

    const scope: Partial<TrackerScope> = {
      floor: param(q.get('floor')),
      gre: param(q.get('gre')),
      manager: param(q.get('manager')),
      captain: param(q.get('captain')),
      filter: param(q.get('filter')) as TrackerScope['filter'],
      // Deliberately NOT defaulted to 'all': an unusable date is reported in
      // meta.date_note and today is served, so the screen never shows a day it
      // was not asked for without saying so.
      date: param(q.get('date'), ''),
    };

    const payload = readTracker(db, { outletId, scope });

    return Response.json({
      ...payload,
      viewer: {
        name: gate.me.name,
        role_name: gate.me.role_name,
        read_only: gate.readOnly,
        scope: gate.decision.scope,
      },
    });
  } catch (e: any) {
    console.error('[/api/feedback/tracker GET]', e);
    // Deliberately NOT an empty ledger: a 500 that answered `{ records: [] }`
    // would render as "every table covered, nothing outstanding" — the single
    // most dangerous lie this page could tell.
    return Response.json(
      { error: e?.message || 'Failed to load the feedback tracker' },
      { status: 500 },
    );
  }
}
