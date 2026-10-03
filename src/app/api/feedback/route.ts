/**
 * POST /api/feedback — RECORD ONE GRE VISIT.  (P3 Lane A)
 *
 * THE MODULE'S ONLY WRITE. Everything else under `/api/feedback/*` is a GET.
 * Before this file existed the module had no write side at all — the Take
 * Feedback screen's Submit button flashed "Shell only — P3 wires POST
 * /api/feedback" and the three `gf_` tables, the tracker and 3,147 lines of
 * reporting had nothing to read but hand-seeded test rows.
 *
 * 🔒 WHO. `requireFeedbackRecorder()`, which is `requireFeedbackReader()`'s own
 * decision under a name that says "write" — ONE gate, in
 * `src/lib/feedback/session.ts` → `src/lib/feedback/access.ts`, shared with
 * `page-catalog.ts` and `proxy.ts`. Nothing is re-derived here. An unresolved
 * role is a 403 carrying the remedy text ("assign the role"), which the screen
 * prints verbatim — hard rule 9: `proxy.ts` guards PAGES, NOT APIs, and
 * `canAccessPage` fails open four ways, so this check is the only real one.
 *
 * 🔒 CSRF. `/api/feedback` is already in `CSRF_REQUIRED_PREFIXES`
 * (`src/proxy.ts:158`), which was added in P2 for exactly this route, so a POST
 * without the `fnb_csrf` cookie + `x-csrf-token` header pair never reaches this
 * file. The client must therefore post through `src/lib/api.ts`, which injects
 * the header on state-changing methods; a bare `fetch()` will 403 at the proxy.
 *
 * 🔒 WHAT IT MAY WRITE. `gf_*` and nothing else. The owner's list — the GRE
 * "cannot place orders · cancel items · change quantity · modify KOT · modify
 * bill · apply discounts" — is why `submitFeedback()` is the only thing this
 * handler calls, and why that function reads `orders` / `order_items` and writes
 * neither. "Item Cancelled" is a RECORD of what the kitchen did, not a command.
 *
 * 🔒 NO MONEY. Nothing in the request, the response or the stored rows carries a
 * unit price, a line total or a bill value.
 *
 * 🔒 POST IS THE ONLY EXPORT. Every other verb is 405 by construction — in
 * particular there is no PATCH and no DELETE, so a recorded complaint cannot be
 * edited away through this route.
 *
 * ── THE TWO STATUS CODES A SECOND SUBMIT GETS, AND WHY ──────────────────────
 * `uq_gf_visits_order` allows ONE visit per order, which is what keeps coverage
 * (Feedback Taken ÷ Eligible Tables) a straight COUNT. So:
 *   · the SAME GRE submitting again (a tablet double-tap, a retry) gets 200 with
 *     `duplicate: true` — her feedback is recorded, and an error for a submit
 *     that succeeded would send her back to re-enter it;
 *   · a DIFFERENT person gets 409 naming who took it and when, because the
 *     honest next step is a revisit on the open follow-up, not a second visit
 *     row that would count the table twice.
 * A first, accepted submit answers 201 with the new `visit_id`.
 */

import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import { requireFeedbackRecorder } from '@/lib/feedback/session';
import { submitFeedback, type SubmitFeedbackInput } from '@/lib/feedback/write';

export async function POST(req: Request) {
  const gate = await requireFeedbackRecorder();
  if (!gate.ok) return Response.json(gate.body, { status: gate.status });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: 'A JSON body is required.', reason: 'bad_json' },
      { status: 400 },
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json(
      { error: 'A JSON object is required.', reason: 'bad_json' },
      { status: 400 },
    );
  }

  try {
    const db = getDb();
    const outletId = await getCurrentOutletId();

    // FROM THE SESSION, NEVER THE BODY. The DDL says so in as many words, and
    // Page 4 ranks named staff: a body-supplied recorder would let one tablet
    // post coverage under somebody else's name. `role_name` is the named role at
    // visit time, falling back to the resolved tier for a login that has none —
    // never blank, so a row can always be attributed.
    const me = gate.me;
    const result = submitFeedback(
      db,
      body as SubmitFeedbackInput,
      {
        user_id: String(me.id),
        email: String(me.email ?? ''),
        name: String(me.name ?? ''),
        role: String(me.role_name || me.role || ''),
      },
      outletId,
    );

    if (!result.ok) {
      const { status, ...rest } = result;
      return Response.json(rest, { status });
    }

    // 200 for a double-tap that wrote nothing, 201 for the row this request
    // created — so a client can tell "recorded" from "already recorded".
    return Response.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (e: any) {
    console.error('[/api/feedback POST]', e);
    return Response.json(
      { error: e?.message || 'Failed to record the feedback.', reason: 'write_failed' },
      { status: 500 },
    );
  }
}
