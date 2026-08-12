import { getDb } from '@/lib/db';
import {
  listAlertLines,
  unreviewedAlertBatches,
  unreviewedCutoverAlertCount,
  reviewAlertLines,
  getBatch,
  CutoverError,
} from '@/lib/central-cutover';
import { requireAdmin, denied, actorOf, cutoverError } from '../_lib/guards';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ "AN ALERT FOR EVERY SINGLE VARIANCE" — this is that surface.             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *   GET  /api/inventory/central-cutover/alerts[?batch_id=][&unreviewed=1][&limit=]
 *   POST /api/inventory/central-cutover/alerts   { batch_id, material_ids[], note? }
 *
 * ADMIN ONLY, both. A cutover alert IS a book-vs-counted variance with its
 * rupee value, which is exactly what the blind-count rule keeps away from
 * everyone but an admin on every other surface in this app.
 *
 * THE TWO LAYERS, AND WHY. The owner asked for an alert on every single
 * variance. Taken literally on a ~825-material cutover that is ~600
 * notifications, which destroys the bell as a tool and buries the ten lines
 * that matter. So:
 *   · EVERY varying line has its OWN durable record — one row, never
 *     aggregated, listed here with book, counted, difference and rupee value.
 *     That is the requirement, and GET is the screen it is read on.
 *   · The BELL gets ONE item per cutover batch. `batches` below is that item,
 *     already labelled ("Stock cutover <date> — N counted, M with a variance,
 *     net Rs X"). Whoever wires src/app/api/notifications/inbox/route.ts should
 *     consume unreviewedAlertBatches() and link here.
 *
 * THE RECORDS LIVE IN THE CUTOVER'S OWN TABLE, NOT variance_approvals. A
 * variance_approvals row is an actionable queue item that the bell counts, and
 * approveVariance would post a count-time delta straight back onto the
 * freshly-corrected book — ~600 of them would both destroy that queue and
 * quietly undo the cutover one click at a time.
 *
 * MARKING REVIEWED IS AN ACKNOWLEDGEMENT, NOT AN APPROVAL. It writes
 * reviewed_by / reviewed_at / review_note on the line and moves no stock. The
 * stock was set by the commit; there is nothing left to approve.
 */
export const dynamic = 'force-dynamic';

const MAX_LINES = 2000;
const MAX_REVIEW_IDS = 5000;

export async function GET(request: Request) {
  try {
    const access = await requireAdmin();
    if (denied(access)) return access.error;
    const db = getDb();
    const url = new URL(request.url);

    const batchId = String(url.searchParams.get('batch_id') || '').trim() || null;
    if (batchId && !getBatch(db, batchId)) {
      throw new CutoverError('UNKNOWN_BATCH', 'No such cutover batch');
    }
    const unreviewedOnly = url.searchParams.get('unreviewed') === '1';
    const limit = Math.max(1, Math.min(MAX_LINES, Number(url.searchParams.get('limit')) || MAX_LINES));

    const lines = listAlertLines(db, { batchId, unreviewedOnly, limit });

    return Response.json({
      /** One row per varying material. Nothing aggregated away. */
      lines,
      returned: lines.length,
      truncated: lines.length >= limit,
      /** One entry per batch — the BELL's unit, with a ready-made label. */
      batches: unreviewedAlertBatches(db),
      unreviewed_lines: unreviewedCutoverAlertCount(db),
      filter: { batch_id: batchId, unreviewed_only: unreviewedOnly, limit },
      note: 'These rupee figures are information only. A cutover variance is months of missing paperwork, not a '
        + 'loss — it enters no consumption, P&L or variance report.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return cutoverError('inventory/central-cutover/alerts GET', e);
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireAdmin();
    if (denied(access)) return access.error;
    const db = getDb();
    const body = await request.json().catch(() => ({} as any));

    const batchId = String(body?.batch_id || '').trim();
    if (!batchId) return Response.json({ error: 'batch_id is required' }, { status: 400 });
    if (!getBatch(db, batchId)) throw new CutoverError('UNKNOWN_BATCH', 'No such cutover batch');

    const ids: string[] = Array.isArray(body?.material_ids)
      ? body.material_ids.map((v: unknown) => String(v || '').trim()).filter(Boolean)
      : [];
    if (ids.length === 0) {
      return Response.json({ error: 'material_ids: [] is required — nothing was marked reviewed.' }, { status: 400 });
    }
    if (ids.length > MAX_REVIEW_IDS) {
      return Response.json({ error: 'Too many material_ids in one request (' + ids.length + ').' }, { status: 400 });
    }

    const reviewed = reviewAlertLines(db, batchId, ids, actorOf(access), body?.note ?? null);

    return Response.json({
      batch_id: batchId,
      requested: ids.length,
      reviewed,
      /** Already-reviewed lines are skipped by the engine, so the two numbers
       *  differ on a re-submit. Say it rather than letting it look like a
       *  partial failure. */
      already_reviewed_or_not_alerts: ids.length - reviewed,
      unreviewed_lines: unreviewedCutoverAlertCount(db),
      message: reviewed + ' variance line(s) marked reviewed. No stock moved — the cutover already set it.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return cutoverError('inventory/central-cutover/alerts POST', e);
  }
}
