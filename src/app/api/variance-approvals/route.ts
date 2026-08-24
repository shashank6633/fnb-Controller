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
 *     ?from= &to=      → count date range (YYYY-MM-DD, inclusive) — the monthly view
 *     ?batch_id=       → one upload. SENDING IT EMPTY selects the UNBATCHED rows,
 *                        which is a real and useful selection (every row saved
 *                        before batches existed). Omitting it means "any upload".
 *     ?source=central|liquor → one rail
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

  /* ── THE MONTHLY FILTER, on the server where it can reach every row ────────
   * Counts are uploaded weekly and reviewed once a month, so the queue is read
   * as "last month's uploads", not as "everything pending". Without these the
   * page could only narrow the newest `limit` rows it had already received —
   * fine for reading, useless for a monthly review, because the rows a month-old
   * period selects are exactly the ones that fell past the limit.
   *
   * `batch_id` is bound only when the parameter is PRESENT, because '' is a real
   * selector here (rows saved before batches existed) and applyScopeWhere reads
   * `!= null`. `url.searchParams.get` returns null when absent and '' when the
   * caller sent `?batch_id=`, which is precisely the distinction needed — do not
   * "tidy" this into `|| undefined`, that would turn "the unbatched rows" into
   * "every row".
   *
   * Same four names as GET /api/variance-approvals/bulk takes, so a preview
   * there and the list here describe the same selection. */
  const from = (url.searchParams.get('from') || '').trim();
  const to = (url.searchParams.get('to') || '').trim();
  const batchParam = url.searchParams.get('batch_id');
  const source = (url.searchParams.get('source') || '').trim();
  const filters = {
    from: from || null,
    to: to || null,
    ...(batchParam == null ? {} : { batchId: batchParam.trim() }),
    source: source || null,
  };

  const list = listVarianceApprovals(db, { ...filters, status, outletId, limit, outletScope: scope });

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
  //
  // DELIBERATELY NOT narrowed by from/to/batch_id. "This item holds more than
  // one pending count" is a fact about the item's whole history, and the danger
  // it warns about — approving two frozen baselines for one item — does not go
  // away because the admin is looking at one month. Narrowing it would report
  // "1 pending count" for an item that has four, which is the reassuring
  // version of the exact mistake this banner exists to prevent.
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
    // ── Additive (2026-08). What the server ACTUALLY filtered on, echoed so a
    // page cannot label a filtered list as the whole queue (or the reverse).
    // `pending_count*` above are deliberately UNFILTERED — they are the badge
    // numbers and have always meant "everything pending here / everywhere";
    // `total` is the filtered figure.
    filters: {
      from: filters.from || '',
      to: filters.to || '',
      batch_id: batchParam == null ? null : batchParam.trim(),
      source: filters.source || '',
    },
    // ── Additive (2026-08). [{ material_id, material_name, pending_count,
    // latest_date }], newest date first. Only the newest count per item is
    // approvable; the rest are refused and must be rejected deliberately.
    stacked,
  });
}
