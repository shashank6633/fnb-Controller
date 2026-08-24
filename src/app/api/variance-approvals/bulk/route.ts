import { getDb } from '@/lib/db';
import { requireRole, getCurrentOutletId, getCurrentUser } from '@/lib/auth';
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ THE IMPORT LIST IS THE SAFETY MECHANISM. READ IT BEFORE ADDING TO IT.    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
// `approveVariance` is NOT imported here, and must never be. This endpoint acts
// on hundreds of rows at once; bulk-approving 793 counts that read "we have
// zero" would write 793 empty shelves into the books in a single request, which
// is the most destructive thing this application can do. Because the function is
// not in this module's scope, there is no `action` string, no typo and no
// crafted body that can reach an approval from here — the protection is
// structural, not a conditional somebody can invert later.
//
// If a bulk approve is ever genuinely wanted, it does not belong in this file.
import {
  rejectVarianceBulk, pendingIdsForFilter, listVarianceApprovals, listCountBatches,
  type VarianceQueryOpts, type VarianceOutletScope,
} from '@/lib/variance-approval';

/**
 * BULK REJECT + THE MONTHLY BATCH VIEW (admin only).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *      REJECT MEANS DISCARD THE COUNT AND LEAVE STOCK EXACTLY AS IT IS.
 *
 * Rejecting writes ONE column — variance_approvals.status — and touches no
 * other table on any rail. raw_materials.current_stock, store_stock_ledger and
 * department_material_transactions are all untouched by every path through this
 * route. The variance stands as an open loss to investigate; nothing about the
 * books moves. That is what makes bulk safe here and unsafe on the other side.
 *
 * WHY IT EXISTS. A weekly sheet arrived with 793 blank cells filled in as 0 and
 * parked 1,472 rows in the queue. Rejecting them one at a time is 1,472 clicks
 * through a modal that demands a typed reason each time, and one mis-click on
 * the neighbouring Approve writes a false empty shelf. The capability is built
 * here; the owner runs it himself against production.
 *
 * ── ROUTES ────────────────────────────────────────────────────────────────
 * GET  ?batches=1                 → the uploads, newest first (the month's list)
 * GET  ?from=&to=&batch_id=&source=&outlet=all
 *                                 → PREVIEW: how many pending rows that filter
 *                                   selects, plus a sample, WITHOUT touching
 *                                   anything. This is what the confirm dialog
 *                                   should be built on.
 * POST { action:'reject', reason,
 *        ids?: string[] | filter?: {from,to,batch_id,source,outlet},
 *        expect_count?: number }  → reject them.
 *
 * ── expect_count IS NOT CEREMONY ──────────────────────────────────────────
 * A filter is resolved at execute time, not at preview time, so a count saved in
 * between would be swept up by a decision nobody made about it. When the caller
 * passes the number it previewed and the set has changed, this refuses and asks
 * for a fresh preview rather than rejecting a different set of rows than the one
 * on screen. Required for filter selections; optional for an explicit id list,
 * where the caller already named every row.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SAMPLE_LIMIT = 20;

/** Read the shared filter shape off a URL or a body, in one place. */
function readFilter(
  src: { get(k: string): string | null },
  outletId: string | null,
): VarianceQueryOpts {
  const scope: VarianceOutletScope = src.get('outlet') === 'all' ? 'all' : 'outlet';
  const batch = src.get('batch_id');
  return {
    status: 'pending',
    from: src.get('from') || null,
    to: src.get('to') || null,
    // `!= null` not truthiness: batch_id='' is a REAL selector (every row that
    // predates batches, which on live data is all 1,472 of them). Reading it as
    // "no filter" would turn "clear the unbatched rows" into "clear everything".
    batchId: batch != null ? batch : null,
    source: src.get('source') || null,
    outletId,
    outletScope: scope,
  };
}

export async function GET(request: Request) {
  // SELF-AUTHENTICATING — src/proxy.ts guards pages, not APIs, and this route
  // reads variance figures, which are admin-only under the blind-count rule.
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const db = getDb();
  const url = new URL(request.url);
  const outletId = await getCurrentOutletId();
  const scope: VarianceOutletScope = url.searchParams.get('outlet') === 'all' ? 'all' : 'outlet';

  // ── The month's uploads, so the review can be "these four sheets". ────────
  if (url.searchParams.get('batches') === '1') {
    return Response.json({
      batches: listCountBatches(db, { outletId, outletScope: scope }),
      outlet_scope: scope,
    });
  }

  // ── PREVIEW. Reads only; the ids come from the SAME function the execute
  //    uses, so "you are about to reject 793" and "793 were rejected" can never
  //    describe different rows.
  const filter = readFilter(url.searchParams, outletId);
  const ids = pendingIdsForFilter(db, filter);
  const sample = listVarianceApprovals(db, { ...filter, limit: SAMPLE_LIMIT });

  return Response.json({
    matched: ids.length,
    // Echoed back so the client can hand the identical filter to POST rather
    // than rebuilding it and selecting something slightly different.
    filter: {
      from: filter.from || null,
      to: filter.to || null,
      batch_id: filter.batchId,
      source: filter.source || null,
      outlet: scope,
    },
    expect_count: ids.length,
    sample: sample.rows,
    outlet_scope: scope,
  });
}

export async function POST(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* empty body */ }

  /* ── THE ACTION GATE ──────────────────────────────────────────────────────
   * Only 'reject' is a verb here. 'approve' is answered with a refusal that
   * says why rather than a generic 400, because a client author reaching for it
   * needs to understand it is absent BY DESIGN and not merely unimplemented —
   * otherwise the next step is to add it. (This is a second line: the function
   * is not imported into this module at all, so even removing this check would
   * not produce an approval.) */
  const action = String(body.action || '').trim().toLowerCase();
  if (action === 'approve') {
    return Response.json({
      error: 'Bulk approve does not exist here and will not be added. Approving moves stock — '
        + 'approving a mass-zeroed sheet would write "we have zero" into the books for every row at once. '
        + 'Approve counts one at a time at /api/variance-approvals/[id]/approve.',
    }, { status: 400 });
  }
  if (action !== 'reject') {
    return Response.json({ error: "action must be 'reject' — this endpoint only rejects." }, { status: 400 });
  }

  const reason = String(body.reason || '').trim();
  if (reason.length < 2) {
    return Response.json(
      { error: 'A reason is required to reject (why are these counts being discarded?)' },
      { status: 400 },
    );
  }

  const db = getDb();
  const me = await getCurrentUser();
  const outletId = await getCurrentOutletId();

  const rawIds = Array.isArray(body.ids) ? (body.ids as unknown[]).map(v => String(v || '').trim()).filter(Boolean) : [];
  const hasIds = rawIds.length > 0;
  const rawFilter = (body.filter && typeof body.filter === 'object') ? body.filter as Record<string, unknown> : null;

  if (hasIds && rawFilter) {
    return Response.json({
      error: 'Send either ids or filter, not both — "ids plus a filter" has two readings and picking one '
        + 'silently would reject rows nobody looked at.',
    }, { status: 400 });
  }
  if (!hasIds && !rawFilter) {
    return Response.json({ error: 'Send ids (an explicit list) or filter (from/to/batch_id/source).' }, { status: 400 });
  }

  if (hasIds) {
    // An explicit list needs no expect_count — the caller named every row. Only
    // PENDING rows move (the WHERE is inside the UPDATE), so an id that was
    // decided in the meantime is reported as skipped rather than re-decided.
    const res = rejectVarianceBulk(db, { ids: rawIds }, me?.email || 'admin', reason);
    if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
    return Response.json({
      ok: true, applied: false, rejected: res.rejected, skipped: res.skipped, requested: rawIds.length,
      // `applied:false` is the literal, machine-readable statement that stock did
      // not move — the same field the single reject route returns.
    });
  }

  // ── FILTER PATH ──────────────────────────────────────────────────────────
  const get = (k: string): string | null => {
    const v = rawFilter![k];
    return v === undefined ? null : (v === null ? null : String(v));
  };
  const filter = readFilter({ get }, outletId);

  // Resolve first, so the confirmation can be checked against the SAME row set
  // that is about to be rejected.
  const ids = pendingIdsForFilter(db, filter);
  const expect = body.expect_count;
  if (typeof expect !== 'number' || !Number.isFinite(expect)) {
    return Response.json({
      error: 'expect_count is required when rejecting by filter — send the number the preview reported, '
        + 'so a count saved since then cannot be swept into a decision nobody made about it.',
      matched: ids.length,
    }, { status: 400 });
  }
  if (Math.floor(expect) !== ids.length) {
    return Response.json({
      error: `The queue changed: this filter now matches ${ids.length} pending counts, not ${Math.floor(expect)}. `
        + 'Preview again and confirm the new number. Nothing was changed.',
      matched: ids.length,
    }, { status: 409 });
  }

  const res = rejectVarianceBulk(db, { filter }, me?.email || 'admin', reason);
  if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
  return Response.json({
    ok: true, applied: false, rejected: res.rejected, skipped: res.skipped, requested: ids.length,
    filter: {
      from: filter.from || null, to: filter.to || null,
      batch_id: filter.batchId, source: filter.source || null,
      outlet: filter.outletScope,
    },
  });
}
