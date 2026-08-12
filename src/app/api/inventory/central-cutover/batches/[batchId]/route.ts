import { getDb } from '@/lib/db';
import {
  getBatch,
  listLines,
  listAlertLines,
  cancelBatch,
  previewBatch,
  CutoverError,
} from '@/lib/central-cutover';
import {
  requireUser, requireStager, denied, actorOf,
  blindBatch, blindLine, blindPreview, cutoverError,
} from '../../_lib/guards';

/**
 * ONE BATCH — reviewing what a cutover actually did, and abandoning a draft.
 *
 *   GET    /api/inventory/central-cutover/batches/<id>[?preview=1]
 *   DELETE /api/inventory/central-cutover/batches/<id>
 *
 * GET is the after-the-fact record: the batch header, every counted line with
 * the book figure it replaced, and the alert lines (the ones that differed).
 * On a DRAFT the recorded before-figure is not written yet — book_qty_recipe is
 * 0 until the commit snapshots it inside its transaction — so ?preview=1 adds
 * the live preview, which is where a draft's book-vs-counted actually lives.
 *
 * DELETE ABANDONS A DRAFT (status 'cancelled'); a committed batch is a
 * permanent record and is refused with 409. Nothing is ever hard-deleted:
 * current_stock has no history of its own, so these rows are the only record of
 * the pre-cutover book and of who typed what.
 *
 * Blind counts apply: the book figure, the difference and the rupee columns are
 * stripped for non-admins on every line here, same as everywhere else.
 *
 * Next.js 16 — `params` is a Promise and must be awaited.
 */
export const dynamic = 'force-dynamic';

/** Bound. A batch cannot exceed the material master (~825 central rows), so
 *  this is a ceiling that should never be reached, not a page size. */
const MAX_LINES = 3000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  try {
    const access = await requireUser();
    if (denied(access)) return access.error;
    const db = getDb();
    const { batchId } = await params;
    const url = new URL(request.url);

    const batch = getBatch(db, batchId);
    if (!batch) throw new CutoverError('UNKNOWN_BATCH', 'No such cutover batch');

    const all = listLines(db, batchId);
    const truncated = all.length > MAX_LINES;
    const lines = truncated ? all.slice(0, MAX_LINES) : all;

    // Alert lines are a committed-batch concept: the engine raises them inside
    // the commit and listAlertLines only reads committed batches, so a draft
    // legitimately returns none.
    const alerts = batch.status === 'committed'
      ? listAlertLines(db, { batchId, limit: MAX_LINES })
      : [];

    const wantPreview = url.searchParams.get('preview') === '1' && batch.status === 'draft';

    return Response.json({
      batch: blindBatch(batch, access.isAdmin),
      lines: lines.map((l) => blindLine(l, access.isAdmin)),
      returned: lines.length,
      truncated,
      alert_lines: access.isAdmin ? alerts : null,
      // ADMIN ONLY, like its sibling above. alert_count IS the variance-line
      // count: a line raises an alert exactly when its counted figure differed
      // from the book (commitBatch sets alert = 1 on |variance| > EPS). Shipping
      // it while blindLine() nulls every variance and blindBatch() nulls
      // variance_lines told a counter "N of your counts were wrong" — the one
      // number the blind count exists to withhold, and enough to send them back
      // to reconcile instead of count.
      alert_count: access.isAdmin ? alerts.length : null,
      preview: wantPreview ? blindPreview(previewBatch(db, batchId), access.isAdmin) : null,
      blind: !access.isAdmin,
      /** Draft lines carry 0 here until the commit snapshots the replaced
       *  figure — say so rather than letting a 0 read as an empty shelf. */
      book_qty_recorded: batch.status === 'committed',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return cutoverError('inventory/central-cutover/batches GET', e);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  try {
    const access = await requireStager();
    if (denied(access)) return access.error;
    const db = getDb();
    const { batchId } = await params;

    const batch = cancelBatch(db, batchId, actorOf(access));
    return Response.json({
      batch: blindBatch(batch, access.isAdmin),
      message: 'Cutover draft cancelled. No stock was changed and the counts stay on record.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return cutoverError('inventory/central-cutover/batches DELETE', e);
  }
}
