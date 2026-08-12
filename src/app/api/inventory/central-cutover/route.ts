import { getDb } from '@/lib/db';
import {
  getCentralStoreCutoverAt,
  getCentralStoreCutoverDate,
  getCentralStoreCutoverCommittedAt,
  istToday,
  getOpenDraft,
  createBatch,
  listBatches,
  listLines,
  listCutoverSheet,
  unreviewedCutoverAlertCount,
  unreviewedAlertBatches,
} from '@/lib/central-cutover';
import { requireUser, requireStager, denied, actorOf, blindBatch, cutoverError, cutoverNotices } from './_lib/guards';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ CENTRAL STORE CUTOVER — the state of play, and opening a draft.          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The whole module in one sentence: count every central material physically on
 * one date, SET the book to what was counted, stamp the date, and from then on
 * a variance means something. See src/lib/central-cutover.ts for why the book
 * drifts and what the owner ruled about the correction.
 *
 * ROUTES IN THIS FAMILY
 *   GET    /api/inventory/central-cutover            this file — state of play
 *   POST   /api/inventory/central-cutover            open (or fetch) the draft
 *   GET    .../sheet[?format=csv]                    the blind count sheet
 *   POST   .../lines                                 stage counts by hand
 *   DELETE .../lines?batch_id&material_id            drop one staged count
 *   POST   .../upload                                stage a filled CSV
 *   GET    .../preview?batch_id                      book vs counted vs rupees
 *   POST   .../commit                                ADMIN — apply it
 *   GET    .../batches/[batchId]                     review a batch afterwards
 *   DELETE .../batches/[batchId]                     abandon a draft
 *   GET    .../alerts                                ADMIN — every variance line
 *   POST   .../alerts                                ADMIN — mark them reviewed
 *
 * GET here is the page's first fetch: the stamp, the open draft and how far it
 * has got, the sheet's shape, recent batches, and the copy the screen must
 * show. Bounded — the sheet summary is computed from two queries over a
 * ~950-row master, and the batch list is clamped.
 *
 * POST is deliberately IDEMPOTENT-ish: if a draft is already open it is
 * RETURNED rather than a second one created. Two open drafts would be worse
 * than an error, because getOpenDraft() takes the newest and the older draft's
 * counts would simply stop being visible while still sitting in the table.
 */
export const dynamic = 'force-dynamic';

const MAX_BATCHES = 50;

export async function GET(request: Request) {
  try {
    const access = await requireUser();
    if (denied(access)) return access.error;
    const db = getDb();
    const url = new URL(request.url);

    const limit = Math.max(1, Math.min(MAX_BATCHES, Number(url.searchParams.get('limit')) || 20));
    const draft = getOpenDraft(db);
    const sheet = listCutoverSheet(db, { draftBatchId: draft?.id ?? null });

    // Staged-count progress. listLines is bounded by the material master
    // (~825 central rows), which is why a COUNT query would not be meaningfully
    // cheaper and this keeps the cutover tables behind the engine.
    const stagedCount = draft ? listLines(db, draft.id).length : 0;

    const summary = access.isAdmin
      ? sheet.summary
      : { ...sheet.summary, book_value: null };   // cost data — admin only

    return Response.json({
      /**
       * THE BOUNDARY, as stored: the COUNT DATE at midnight
       * ('YYYY-MM-DD 00:00:00'), or null when the store has never been cut over.
       * A BUSINESS DATE, NOT A CLOCK READING — nothing happened at 00:00:00, so
       * never render this through a time formatter and never call it "recorded
       * at". Quote `cutover_date` on screen and use `cutover_committed_at` for
       * the moment the write actually happened.
       */
      cutover_at: getCentralStoreCutoverAt(db),
      /** Date-only form. Use THIS against any business-date column, and it is
       *  the form the screen should quote. */
      cutover_date: getCentralStoreCutoverDate(db),
      /**
       * The real UTC instant current_stock was re-based, or null. This is the
       * only field here that is a clock reading; it exists because
       * `cutover_at` stopped being one when the stamp became the count date.
       * Null on a hand-stamped install (the settings row written without a
       * commit behind it), which is why the screen must handle its absence
       * rather than printing a formatted empty string.
       */
      cutover_committed_at: getCentralStoreCutoverCommittedAt(db),
      today: istToday(db),
      draft: draft ? blindBatch(draft, access.isAdmin) : null,
      draft_staged_lines: draft ? stagedCount : 0,
      /** Central materials with no count staged yet. Counted down, not up. */
      draft_remaining: draft ? Math.max(0, sheet.summary.central_materials - stagedCount) : null,
      sheet_summary: summary,
      recent_batches: listBatches(db, limit).map((b) => blindBatch(b, access.isAdmin)),
      /** Alert review is a variance surface, so it is admin-only. */
      unreviewed_alert_lines: access.isAdmin ? unreviewedCutoverAlertCount(db) : null,
      unreviewed_alert_batches: access.isAdmin ? unreviewedAlertBatches(db) : null,
      notices: cutoverNotices(sheet.summary.store_excluded_reason),
      can_stage: access.canStage,
      can_commit: access.isAdmin,
      /** True when the book figure has been stripped from this payload. */
      blind: !access.isAdmin,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return cutoverError('inventory/central-cutover GET', e);
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireStager();
    if (denied(access)) return access.error;
    const db = getDb();
    const body = await request.json().catch(() => ({} as any));

    const open = getOpenDraft(db);
    if (open) {
      const wanted = String(body?.cutover_date || '').slice(0, 10);
      return Response.json({
        batch: blindBatch(open, access.isAdmin),
        created: false,
        message: wanted && wanted !== open.cutover_date
          ? 'A cutover draft dated ' + open.cutover_date + ' is already open. Finish or cancel it before starting one '
            + 'dated ' + wanted + ' — with two open drafts the older one stops being visible while its counts '
            + 'are still recorded.'
          : 'The cutover draft dated ' + open.cutover_date + ' is already open; continuing with it.',
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const batch = createBatch(db, {
      cutover_date: body?.cutover_date ?? null,
      note: body?.note ?? null,
      actor: actorOf(access),
    });
    return Response.json({
      batch: blindBatch(batch, access.isAdmin),
      created: true,
      message: 'Cutover draft opened for ' + batch.cutover_date
        + '. Nothing is applied until an admin commits it.',
    }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return cutoverError('inventory/central-cutover POST', e);
  }
}
