import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement } from '@/lib/auth';
import { routingHints } from '@/lib/ct/routing';

/**
 * GET /api/crm-calls/live/routing[?phones=+91…,+91…]
 *
 * "Who should take this call" hints for the Live Calls board — a sticky-agent
 * line ("last handled by Priya") and a VIP badge that carries its own evidence
 * (visits / spend vs the configured thresholds).
 *
 * NOT a routing API. This app does not control the PBX; nothing here rings a
 * different extension or reorders a queue. It only tells the human at the
 * counter what they would otherwise have to look up mid-ring.
 *
 * Both hints are independently flagged in ct_settings and DEFAULT OFF:
 *   sticky_agent = '1'  → sticky line
 *   vip_routing  = '1'  → VIP badge
 * With both off the response is `{ sticky_agent: false, vip_routing: false,
 * hints: {} }` and no guest/call/order tables are read at all — which is what
 * lets the board render byte-identically to how it does today.
 *
 * `phones` is a comma-separated list (max 20 — the board shows at most 12
 * ringing cards). Omit it to read the flags alone. The board does not need
 * that probe: /api/crm-calls/live already reports the flags on the poll it
 * makes anyway, so it only calls THIS route once a flag is actually on.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_PHONES = 20;

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Not signed in' }, { status: 401 });

  const raw = new URL(req.url).searchParams.get('phones') || '';
  const phones = raw
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .slice(0, MAX_PHONES);

  const db = getDb();
  const outletId = await getCurrentOutletId();

  try {
    // Loyalty points/tier/spend are MANAGEMENT-ONLY on every sibling endpoint
    // (guests/route.ts:153, guests/[id]/route.ts:100) and in proxy.ts. Signing
    // in is not sufficient. Without this, the VIP hint quietly became a way for
    // any logged-in user to read a guest's lifetime spend — a real regression,
    // just through a new door.
    //
    // Non-management still get the VIP badge; it is computed from the same
    // thresholds but returned without the underlying loyalty figures, so a GRE
    // knows to prioritise the caller without seeing what they are worth.
    return Response.json(routingHints(db, phones, { outletId, includeLoyalty: isManagement(user) }));
  } catch (e) {
    // A hint is a nicety — never let it break the wallboard. Degrade to "off".
    console.error('[crm-calls] routing hints failed', e);
    return Response.json({
      sticky_agent: false, vip_routing: false, window_days: 0,
      thresholds: { minVisits: 0, minSpend: 0 }, hints: {},
    });
  }
}
