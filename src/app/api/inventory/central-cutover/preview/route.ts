import { getDb } from '@/lib/db';
import {
  getOpenDraft,
  previewBatch,
  listCutoverSheet,
  getCentralStoreCutoverAt,
  getCentralStoreCutoverDate,
  CutoverError,
} from '@/lib/central-cutover';
import { requireUser, denied, blindPreview, cutoverError, cutoverNotices } from '../_lib/guards';

/**
 * PREVIEW — the whole batch as it would land, before anything lands.
 *
 *   GET /api/inventory/central-cutover/preview[?batch_id=]
 *
 * Any signed-in user; the book figure, the difference and the rupees are
 * stripped for non-admins (blind counts — see _lib/guards).
 *
 * WHAT THE SCREEN MUST DO WITH THIS PAYLOAD
 *   · gate the commit button on `can_commit`, and render `blockers` VERBATIM —
 *     they are written as operator instructions, not as diagnostics;
 *   · gate each row on `blocked`. The three signals beside it explain WHY:
 *     `moved_since_stage` (recorded rows since the count) and `stock_changed`
 *     block; `record_edited` does NOT block on its own, because a rename bumps
 *     the same timestamp and refusing a 700-line cutover over a spelling fix
 *     would be both wrong and unactionable;
 *   · show `summary.uncounted_materials` prominently. It is the number that
 *     reassures: those materials have no line and are left completely
 *     untouched — a blank is never read as a zero.
 *
 * Bounded by the batch, which is bounded by the material master (~825 central
 * rows). previewBatch re-reads live stock per line, so two previews minutes
 * apart can legitimately differ — that is what moved_since_stage explains.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requireUser();
    if (denied(access)) return access.error;
    const db = getDb();
    const url = new URL(request.url);

    const given = String(url.searchParams.get('batch_id') || '').trim();
    let batchId = given;
    if (!batchId) {
      const draft = getOpenDraft(db);
      if (!draft) {
        throw new CutoverError('UNKNOWN_BATCH', 'No cutover draft is open — start one and enter counts first.');
      }
      batchId = draft.id;
    }

    const preview = previewBatch(db, batchId);
    const sheet = listCutoverSheet(db, { draftBatchId: batchId });
    const stamp = getCentralStoreCutoverAt(db);

    return Response.json({
      // `can_commit` inside this spread is the BATCH's readiness. Whether the
      // person looking may press the button is `viewer_can_commit` below — the
      // two are separate questions and the screen needs both.
      ...blindPreview(preview, access.isAdmin),
      /** Present stamp, so the screen can say whether this is the FIRST cutover
       *  (which sets the boundary) or a later one (which does not move it). */
      cutover_at: stamp,
      cutover_date: getCentralStoreCutoverDate(db),
      first_cutover: stamp === null,
      store_excluded: sheet.summary.store_excluded,
      store_excluded_reason: sheet.summary.store_excluded_reason,
      notices: cutoverNotices(sheet.summary.store_excluded_reason),
      viewer_can_commit: access.isAdmin,
      blind: !access.isAdmin,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return cutoverError('inventory/central-cutover/preview', e);
  }
}
