import { getDb } from '@/lib/db';
import {
  getOpenDraft,
  getBatch,
  stageLines,
  removeLine,
  listLines,
  CutoverError,
  type StageLineInput,
} from '@/lib/central-cutover';
import { requireStager, requireUser, denied, blindLine, cutoverError } from '../_lib/guards';

/**
 * STAGING COUNTS BY HAND — the form's writer, and the line list behind it.
 *
 *   GET    /api/inventory/central-cutover/lines?batch_id=      what is staged
 *   POST   /api/inventory/central-cutover/lines                stage / re-stage
 *   DELETE /api/inventory/central-cutover/lines?batch_id&material_id
 *
 * batch_id is optional everywhere: with none, the open draft is used. There is
 * at most one open draft by construction (POST on the parent route returns the
 * existing one rather than opening a second).
 *
 * NOTHING HERE TOUCHES STOCK. Staging only records what a human says they
 * counted; the book moves once, in the admin-only commit.
 *
 * PER-LINE REFUSALS ARE REPORTED, NEVER FATAL — a 700-row count is not thrown
 * away because six cells are unreadable. THE CLIENT MUST RENDER `rejected` AND
 * `store_blocked`: a caller that only reads `accepted` will show the operator a
 * success for rows that were never staged.
 *
 * A RE-SEND IS NOT A RE-COUNT. A line that arrives again with exactly the same
 * quantity and unit is left untouched — same figure, same staged_at — and comes
 * back in `unchanged`. staged_at is what the commit's movement fence measures
 * from, so refreshing it on every re-send made "re-count and stage again" a
 * refusal anyone could satisfy by pressing upload twice. Send `recount: true`
 * on a line to assert a genuine fresh count of the same figure; that, and a
 * changed number, are the only two things that move the count instant.
 *
 * THE UNIT IS REQUIRED whenever the material has a real pack factor, and
 * guessing is refused by the engine (reason 'unit_required'). That is not
 * strictness for its own sake: on a 1,000 g/kg pack the wrong guess is a
 * 1,000x error, and 109 materials on this data already sit above 10,000 recipe
 * units where it would not look wrong on screen. Send counted_unit.
 */
export const dynamic = 'force-dynamic';

/** Bound on one request. The realistic whole-store sheet is ~700 lines. */
const MAX_LINES = 5000;

/** Resolve the batch a request means: an explicit id, else the open draft. */
function resolveBatchId(db: ReturnType<typeof getDb>, given: string | null): string {
  const id = String(given || '').trim();
  if (id) {
    if (!getBatch(db, id)) throw new CutoverError('UNKNOWN_BATCH', 'No such cutover batch');
    return id;
  }
  const draft = getOpenDraft(db);
  if (!draft) {
    throw new CutoverError('UNKNOWN_BATCH', 'No cutover draft is open — start one before entering counts.');
  }
  return draft.id;
}

export async function GET(request: Request) {
  try {
    const access = await requireUser();
    if (denied(access)) return access.error;
    const db = getDb();
    const url = new URL(request.url);
    const batchId = resolveBatchId(db, url.searchParams.get('batch_id'));
    const lines = listLines(db, batchId);
    return Response.json({
      batch_id: batchId,
      lines: lines.map((l) => blindLine(l, access.isAdmin)),
      count: lines.length,
      blind: !access.isAdmin,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return cutoverError('inventory/central-cutover/lines GET', e);
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireStager();
    if (denied(access)) return access.error;
    const db = getDb();
    const body = await request.json().catch(() => ({} as any));

    // A single line may be sent unwrapped — the form stages one material at a
    // time and should not have to build an array to do it.
    const raw: unknown[] = Array.isArray(body?.lines)
      ? body.lines
      : (body?.material_id || body?.sku || body?.name) ? [body] : [];
    if (raw.length === 0) {
      return Response.json({ error: 'Send lines: [{ material_id, counted_qty, counted_unit }]' }, { status: 400 });
    }
    if (raw.length > MAX_LINES) {
      return Response.json(
        { error: 'Too many lines in one request (' + raw.length + '). The whole central store is about 825 materials — send at most ' + MAX_LINES + '.' },
        { status: 400 },
      );
    }

    const batchId = resolveBatchId(db, body?.batch_id ?? null);
    const lines: StageLineInput[] = raw.map((r: any) => ({
      material_id: r?.material_id ?? null,
      sku: r?.sku ?? null,
      name: r?.name ?? null,
      // Passed through UNPARSED on purpose: parseCountedQty in the engine is
      // the one place a blank is distinguished from a zero, and coercing here
      // would be a second, quieter answer to that question.
      counted_qty: r?.counted_qty,
      counted_unit: r?.counted_unit ?? null,
      note: r?.note ?? null,
      // STRICTLY === true. A truthy string ('0', 'false') arriving from a form
      // encoder must not be able to assert a re-count nobody performed — this
      // flag is the only thing that moves a line's count instant when the
      // figure has not changed, and it exists to be hard to set by accident.
      recount: r?.recount === true,
    }));

    const result = stageLines(db, batchId, lines);
    return Response.json({
      batch_id: batchId,
      ...result,
      staged_total: listLines(db, batchId).length,
      message: result.accepted + ' new, ' + result.updated + ' updated, '
        + result.unchanged + ' unchanged (same figure — left exactly as they were, count time included), '
        + result.rejected.length + ' not read, ' + result.store_blocked.length + ' liquor (excluded). '
        + 'Nothing is applied to stock until an admin commits this cutover.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return cutoverError('inventory/central-cutover/lines POST', e);
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await requireStager();
    if (denied(access)) return access.error;
    const db = getDb();
    const url = new URL(request.url);
    const materialId = String(url.searchParams.get('material_id') || '').trim();
    if (!materialId) return Response.json({ error: 'material_id is required' }, { status: 400 });
    const batchId = resolveBatchId(db, url.searchParams.get('batch_id'));

    const removed = removeLine(db, batchId, materialId);
    return Response.json({
      batch_id: batchId,
      material_id: materialId,
      removed,
      staged_total: listLines(db, batchId).length,
      message: removed
        ? 'Count removed. That material now has no line, so the cutover will leave its stock untouched.'
        : 'There was no staged count for that material.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return cutoverError('inventory/central-cutover/lines DELETE', e);
  }
}
