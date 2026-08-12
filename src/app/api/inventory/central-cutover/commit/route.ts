import { getDb } from '@/lib/db';
import {
  getBatch,
  getOpenDraft,
  previewBatch,
  commitBatch,
  getCentralStoreCutoverAt,
  CutoverError,
} from '@/lib/central-cutover';
import { requireAdmin, denied, actorOf, cutoverError } from '../_lib/guards';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ COMMIT — the one write that re-bases the book. ADMIN ONLY.               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *   POST /api/inventory/central-cutover/commit
 *     { batch_id?: string, confirm: 'COMMIT' }
 *
 * WHY `confirm` IS REQUIRED AND WHY IT IS A WORD, NOT A FLAG. This sets
 * current_stock on up to ~825 materials from a physical count. current_stock
 * has no history of its own and on this database is NOT reconstructible from
 * inventory_transactions, so the pre-cutover book survives only in the cutover
 * lines this write creates. A bare POST — the shape a stray double-submit, a
 * retry or a prefetch produces — must never be able to do that. `confirm:
 * true` would be reachable by accident from almost any form; a literal word
 * has to be typed by whoever wired the button.
 *
 * TWO WORDS ARE ACCEPTED, 'CUTOVER' and 'COMMIT'. 'CUTOVER' is canonical and
 * is what /inventory/central-cutover sends and what `confirm_with` advertises;
 * 'COMMIT' is kept because it is the obvious word for a script author reading
 * the route name. The safety property is unchanged — neither is a value any
 * accidental resubmit produces — and a one-word rule that disagreed with the
 * only caller would have shipped a commit button that silently never commits.
 *
 * A BARE POST IS THEREFORE A DRY RUN. It answers with the preview totals and
 * the blockers and writes nothing, so a caller can arm a confirmation dialog
 * from the same endpoint it will confirm against — the same shape
 * api/inventory/fix-negative-stock uses for its arm-then-execute handshake,
 * without that route's in-memory arming map (which a redeploy or a second
 * worker forgets). Here the safety lives in the engine instead: the commit
 * re-reads every line inside its transaction and refuses anything that moved.
 *
 * WHAT COMMITTING DOES *NOT* DO (Ruling 1 — verified by the engine's harness):
 * no purchases row, no inventory_transactions row, no closing_stock row, no
 * variance_approvals row, and average_price / last_purchase_price are untouched.
 * The rupee figures are information only. The correction is months of missing
 * paperwork written off in one stroke, not a gain, and booking it as income
 * would overstate this month and understate every prior one.
 *
 * WHAT IT DOES DO: sets stock per counted line, snapshots the replaced figure
 * on the line inside the same transaction, raises one durable alert record per
 * varying line, and — on the FIRST committed cutover only — stamps
 * settings.central_store_cutover_at. A later cutover is applied but does not
 * move the boundary, so `stamp_written` is false on it.
 *
 * PRE-FLIGHT. previewBatch runs first so a blocked batch gets a 409 naming the
 * blockers instead of the engine's first throw. That is a nicer message, not a
 * safety layer: the engine repeats every refusal inside the transaction, which
 * is the only place a check cannot be raced.
 */
export const dynamic = 'force-dynamic';

/** Advertised in the dry-run response and sent by the page. */
const CONFIRM_WORD = 'CUTOVER';
/** Every accepted spelling. See the header note on why there are two. */
const CONFIRM_WORDS = new Set([CONFIRM_WORD, 'COMMIT']);

export async function POST(request: Request) {
  try {
    const access = await requireAdmin();
    if (denied(access)) return access.error;
    const db = getDb();
    const body = await request.json().catch(() => ({} as any));

    const given = String(body?.batch_id || '').trim();
    let batchId = given;
    if (!batchId) {
      const draft = getOpenDraft(db);
      if (!draft) throw new CutoverError('UNKNOWN_BATCH', 'No cutover draft is open.');
      batchId = draft.id;
    } else if (!getBatch(db, batchId)) {
      throw new CutoverError('UNKNOWN_BATCH', 'No such cutover batch');
    }

    const preview = previewBatch(db, batchId);

    if (!preview.can_commit) {
      return Response.json({
        error: preview.blockers[0] || 'This cutover cannot be applied yet.',
        code: 'BLOCKED',
        blockers: preview.blockers,
        blocked_lines: preview.lines.filter((l) => l.blocked).map((l) => ({
          material_id: l.material_id,
          name: l.name,
          moved_since_stage: l.moved_since_stage,
          stock_changed: l.stock_changed,
          record_edited: l.record_edited,
          pack_factor_changed: l.pack_factor_changed,
          now_store_mapped: l.now_store_mapped,
          staged_at: l.staged_at,
        })),
        summary: preview.summary,
      }, { status: 409 });
    }

    const confirm = String(body?.confirm ?? '').trim().toUpperCase();
    if (!CONFIRM_WORDS.has(confirm)) {
      return Response.json({
        armed: true,
        // `committed` is the boolean; `applied` on the committed response is a
        // COUNT of materials, from CommitResult. Two different questions, so
        // they get two different names and never share one field.
        committed: false,
        batch_id: batchId,
        cutover_date: preview.batch.cutover_date,
        summary: preview.summary,
        first_cutover: getCentralStoreCutoverAt(db) === null,
        confirm_with: CONFIRM_WORD,
        message: 'NOTHING HAS CHANGED. This will SET stock on ' + preview.summary.counted_lines
          + ' counted material(s) from the physical count — '
          + preview.summary.variance_lines + ' differ from the book, net Rs '
          + Math.round(preview.summary.net_variance_value).toLocaleString('en-IN') + ' (information only, it enters '
          + 'no report). ' + preview.summary.uncounted_materials + ' uncounted material(s) are left untouched. '
          + 'Re-send with confirm: "' + CONFIRM_WORD + '" to apply. Take a file backup first.',
      }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    }

    const result = commitBatch(db, batchId, actorOf(access));

    return Response.json({
      committed: true,
      ...result,          // result.applied is the COUNT of materials re-based
      message: 'Cutover applied. ' + result.applied + ' material(s) re-based from the count of '
        + result.cutover_date + '; ' + result.variance_lines + ' had a variance (net Rs '
        + Math.round(result.net_variance_value).toLocaleString('en-IN') + ', information only). '
        // QUOTE THE DATE, NEVER THE STORED STAMP. cutover_at is the count date
        // at midnight ('2026-08-12 00:00:00') — the ' 00:00:00' tail is storage
        // detail that reads to an operator as a time the cutover happened, and
        // nothing happened at midnight. CommitResult carries
        // cutover_boundary_date for exactly this sentence.
        + (result.stamp_written
          ? 'The central store cutover date is now set to ' + result.cutover_boundary_date
            + ' — variance from here on is real, not drift.'
          : 'The cutover boundary stays at ' + result.cutover_boundary_date
            + '; only the first cutover sets it.'),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return cutoverError('inventory/central-cutover/commit', e);
  }
}
