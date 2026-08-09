import { getDb } from '@/lib/db';
import { requireRole, getCurrentOutletId } from '@/lib/auth';
import {
  listVarianceApprovals, pendingVarianceCount, stackedPendingCounts,
  type VarianceOutletScope,
} from '@/lib/variance-approval';

/**
 * Variance approvals queue (admin only). Closing counts with a non-zero variance
 * land here as PENDING; an admin approves (stock → physical) or rejects.
 *
 * GET ?status=pending|approved|rejected|all   (default pending)
 *     ?outlet=all      → read every outlet, not just the reviewer's current one
 *     ?limit=<1..1000> → how many rows to return (default 500)
 *
 *  → {
 *      approvals, pending_count,          // unchanged meaning — see below
 *      outlet_scope, outlet_id,           // what was actually read
 *      total, returned, truncated, limit, // is `approvals` the whole story?
 *      pending_count_all_outlets,
 *      pending_count_other_outlets,       // > 0 ⇒ rows exist that this read cannot see
 *      stacked,                           // items with >1 pending count — READ THIS
 *    }
 *
 * `stacked` IS THE ONE THAT PREVENTS A SILENT LOSS. Each row's frozen baseline
 * is only safe to apply once, so an item holding two pending counts double-
 * corrects if the admin simply works down the queue — and it overstates, i.e.
 * it hides a shortage. Every such row also carries `approve_blocked` plus
 * `superseded_by_date` / `superseded_by_status`, so the refusal is visible per
 * row; `stacked` is the queue-level headline of the same fact, for the banner.
 *
 * `pending_count` DOES NOT MOVE WITH `?outlet`. It is always the current
 * outlet's pending count, exactly as it was before the scope parameter existed,
 * so a client that ignores the new fields keeps reading the number it already
 * understood. A client showing an all-outlets view should badge
 * `pending_count_all_outlets` instead — adding the two together would
 * double-count, since "all" already contains "here".
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const db = getDb();
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  const outletId = await getCurrentOutletId();

  // OUTLET SCOPE — opt-in, never inferred. A pending row is stamped with the
  // outlet of whoever COUNTED, and read back under the outlet of whoever
  // REVIEWS. Those differ — and the row goes invisible — whenever a user is
  // parked on another outlet: getCurrentOutletId() (lib/auth.ts) returns
  // users.current_outlet_id with NO is_active check, so a user left on an
  // outlet that was later deactivated keeps stamping rows with it. Today only
  // "Main" is active and every user points at it, so this is reachable rather
  // than live; reactivating Branch 2 or adding a third outlet reopens it, and
  // /api/outlets/switch has no role gate. `all` is how the admin reaches those
  // rows. Default stays the current outlet so a single-outlet day is unchanged.
  const scope: VarianceOutletScope = url.searchParams.get('outlet') === 'all' ? 'all' : 'outlet';

  // Only a positive finite number overrides the default; the lib clamps to
  // 1..1000, and there is deliberately no offset — see `truncated` instead.
  // Math.floor here too (the lib floors as well): a fractional LIMIT is a
  // SQLite "datatype mismatch" throw, i.e. a 500 and an empty queue for the
  // admin, from nothing worse than a hand-edited `?limit=1.5`.
  const asked = Math.floor(Number(url.searchParams.get('limit')));
  const limit = Number.isFinite(asked) && asked > 0 ? asked : 500;

  const list = listVarianceApprovals(db, { status, outletId, limit, outletScope: scope });

  // Counted twice on purpose: "here" is the badge every existing client reads,
  // and "everywhere" is what makes an empty queue honest. Without the pair, a
  // count parked under the other outlet renders as "All counts reconcile with
  // the system" — an empty list and a clean bill of health are not the same
  // statement, and only the difference between these two can tell them apart.
  const pendingHere = pendingVarianceCount(db, outletId);
  const pendingEverywhere = pendingVarianceCount(db, outletId, 'all');
  // Rows stamped with a DIFFERENT outlet. Never negative: "everywhere" is a
  // superset of "here" (which also includes the outlet-less '' rows).
  const pendingElsewhere = Math.max(0, pendingEverywhere - pendingHere);

  // Same status and outlet scope as the list above, so the banner can never
  // describe rows the queue below it is not showing. It resolves to an empty
  // array on the approved/rejected tabs — nothing is pending there to stack.
  const stacked = stackedPendingCounts(db, { status, outletId, outletScope: scope });

  return Response.json({
    approvals: list.rows,
    pending_count: pendingHere,
    // ── Additive (2026-08). Everything below is new; nothing above changed.
    outlet_scope: list.outletScope,
    outlet_id: outletId || '',
    total: list.total,
    returned: list.rows.length,
    truncated: list.truncated,
    limit: list.limit,
    pending_count_all_outlets: pendingEverywhere,
    pending_count_other_outlets: pendingElsewhere,
    // ── Additive (2026-08). [{ material_id, material_name, pending_count,
    // latest_date }], newest date first. Only the newest count per item is
    // approvable; the rest are refused and must be rejected deliberately.
    stacked,
  });
}
