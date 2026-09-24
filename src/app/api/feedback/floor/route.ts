/**
 * GET /api/feedback/floor — Page 1's board.  (P2 Lane A)
 *
 * 🔒 THIS FILE EXPORTS `GET` AND NOTHING ELSE, AND THAT IS THE ENFORCEMENT.
 * The Next.js App Router answers **405 Method Not Allowed** for any verb a
 * `route.ts` does not export, so the read-only promise is structural here
 * rather than a check someone could forget: there is no POST/PATCH/DELETE to
 * audit, and this module never opens a write to an order, an order item, a KOT
 * or a bill. Every query it runs lives in `src/lib/feedback-read.ts`, which is
 * `SELECT`-only by construction.
 *
 * ⚠️ THE TWO GUARANTEES ARE NOT THE SAME THING. This route proves guarantee
 * (A): the FEEDBACK MODULE never mutates. Guarantee (B) — that a GRE cannot
 * mutate through the EXISTING POS routes — is a different, larger problem:
 * `PATCH /api/dine-in/orders/[id]` authorises with `if (!me) return 401` and
 * nothing else, and yields add_item · set_qty · remove_item · fire. Closing
 * that needs edits inside shipped production code captains depend on, so it is
 * a diff for the owner to approve, NOT something this lane applies.
 *
 * ⚠️ PATH HYGIENE (hard rule 9): no segment may contain `print` and no path may
 * end `.json` — `proxy.ts:isPublic()` matched both patterns and made such
 * routes publicly reachable AND CSRF-exempt. `/api/feedback/floor` is clean.
 */

import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import { requireFeedbackReader } from '@/lib/feedback/session';
import { listFloorTables } from '@/lib/feedback/read';
import { areaLabel, greAreaOf, AREA_ASSIGNED_NOTE, AREA_UNASSIGNED_NOTE } from '@/lib/feedback/zones';

export async function GET() {
  const gate = await requireFeedbackReader();
  if (!gate.ok) return Response.json(gate.body, { status: gate.status });

  try {
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const { rows, meta } = listFloorTables(db, { outletId });

    // 🔒 THE OWNER'S FLOOR RULING, 2026-09-23: "THE FLOOR IS A DEFAULT, NOT A
    // RESTRICTION." The board below is the WHOLE venue, unfiltered, for every
    // viewer — nobody is ever blocked from helping on another floor, and that
    // is the third line of the ruling. What is shipped here is the DEFAULT the
    // screen opens on, and the floors this person's coverage is measured
    // against; `my_floors` empty means no assignment, which means all floors
    // and a venue-wide denominator, exactly as before. The session already
    // carries `preferred_zones`, so this costs no query.
    const area = greAreaOf(gate.me.preferred_zones, gate.me.preferred_table_ids);

    return Response.json({
      tables: rows,
      meta,
      viewer: {
        name: gate.me.name,
        role_name: gate.me.role_name,
        read_only: gate.readOnly,
        scope: gate.decision.scope,
        my_floors: area.zones,
        area_assigned: area.assigned,
        area_label: areaLabel(area),
        area_note: area.assigned ? AREA_ASSIGNED_NOTE : AREA_UNASSIGNED_NOTE,
      },
    });
  } catch (e: any) {
    console.error('[/api/feedback/floor GET]', e);
    // Deliberately NOT an empty board: a 500 that answered `{ tables: [] }`
    // would render as "nothing to visit today" and quietly cost coverage.
    return Response.json({ error: e?.message || 'Failed to load the feedback board' }, { status: 500 });
  }
}
