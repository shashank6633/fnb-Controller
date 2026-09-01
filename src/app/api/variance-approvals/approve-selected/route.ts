import { getDb } from '@/lib/db';
import { requireRole, getCurrentUser } from '@/lib/auth';
import { approveVariance } from '@/lib/variance-approval';

/**
 * APPROVE SELECTED — the counts the admin ticked HIMSELF, and nothing else.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *      POST { ids: string[], reason }  →  approve each id, one at a time.
 *
 * WHY THIS IS ITS OWN FILE AND NOT AN `action:'approve'` ON THE BULK ROUTE.
 * bulk/route.ts is reject-only BY STRUCTURE — it never imports approveVariance,
 * so no body can reach an approval from there, and its header says a bulk
 * approve "does not belong in this file". That stays true. What the owner asked
 * for (2026-09) is different in exactly the way that makes it safe: not
 * "approve everything this filter matches" but "approve the rows I picked".
 *
 * EXPLICIT IDS ONLY, NEVER A FILTER. A filter is resolved at execute time, so a
 * count saved between preview and click would be swept into the single most
 * destructive action this module performs — writing to stock — with nobody
 * having looked at it. An id list cannot do that: every id in it is a row the
 * admin ticked on screen. A body carrying `filter` is refused outright rather
 * than ignored, so a client author cannot believe a filter was honoured.
 * There is no expect_count either, for the same reason the bulk ids path has
 * none: the caller named every row.
 *
 * EVERY GUARD STILL RUNS, PER ROW. This loops the SAME approveVariance() the
 * per-row button calls — one call per id, each inside its OWN transaction — so
 * supersede, department-clobber, central cutover, QC hold and already-decided
 * are all judged per row, and each row succeeds or is refused INDEPENDENTLY.
 * Deliberately NO outer transaction across the loop: one refusal must not roll
 * back the approvals beside it. Approving 8 of 10 with 2 named refusals is the
 * correct outcome, and the response says exactly which is which:
 *
 *      { ok, requested, approved: [{id, material}],
 *                       refused:  [{id, material, reason}] }
 *
 * ORDER IS THE CALLER'S ORDER — the admin approves what he selected, in the
 * order he sent it; that IS the priority mechanism. No re-sorting here. Two
 * pending dates of one material both selected cannot double-post whichever
 * comes first: the supersede guard refuses the older row while the newer is
 * pending OR approved, so the latest applies and the stale one comes back
 * refused with the supersede sentence.
 *
 * GATE: identical to [id]/approve — admin only, under the blind-count rule
 * (refusal sentences quote system figures, which only admins may see).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * More ids than the queue page can even render (its read limit is 500). A list
 * longer than this did not come from ticking rows on screen.
 */
const MAX_IDS = 500;

export async function POST(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* empty body */ }

  // A filter-shaped body is a design misunderstanding, not a bad parameter —
  // answer it the way bulk/route.ts answers `action:'approve'`, with the why.
  if (body.filter !== undefined) {
    return Response.json({
      error: 'Approve-selected takes an explicit id list only, never a filter. A filter is resolved '
        + 'after you click, so it could sweep a count nobody looked at into a write to stock. '
        + 'Tick the rows and send their ids.',
    }, { status: 400 });
  }

  // Dedupe, preserving the caller's order — the same id twice is one decision,
  // and reporting it twice ("approved" then "Already approved") would read as a
  // double-post that never happened.
  const rawIds = Array.isArray(body.ids)
    ? (body.ids as unknown[]).map(v => String(v || '').trim()).filter(Boolean)
    : [];
  const ids = Array.from(new Set(rawIds));
  if (ids.length === 0) {
    return Response.json({ error: 'Send ids: the rows you ticked. Nothing was approved.' }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return Response.json({
      error: `At most ${MAX_IDS} ids per call — more than the queue page can even show at once. Nothing was approved.`,
    }, { status: 400 });
  }

  // Same wording as [id]/approve: one reason, recorded verbatim on every row it
  // approves — the admin asked the staff once about the sheet he is clearing.
  const reason = String(body.reason || '').trim();
  if (reason.length < 2) {
    return Response.json({ error: 'A reason is required to approve (what did the staff say caused the variance?)' }, { status: 400 });
  }

  const db = getDb();
  const me = await getCurrentUser();
  const reviewer = me?.email || 'admin';

  // The material NAME per row, so a refusal is reported as "Tomato — a newer
  // count…" and not as an opaque uuid the admin has to go find. LEFT JOIN and
  // COALESCE down to the raw id: an unknown id still gets a named line.
  const nameStmt = db.prepare(`
    SELECT COALESCE(NULLIF(rm.name, ''), va.material_id) AS material
      FROM variance_approvals va
      LEFT JOIN raw_materials rm ON rm.id = va.material_id
     WHERE va.id = ?
  `);

  const approved: { id: string; material: string }[] = [];
  const refused: { id: string; material: string; reason: string }[] = [];
  for (const id of ids) {
    const material = (nameStmt.get(id) as { material?: string } | undefined)?.material || id;
    // approveVariance() never throws to a caller — every refusal (including its
    // own in-transaction throws) comes back as { ok:false, error }, and each
    // call opens and closes its own transaction. So one bad row cannot abort
    // the loop, and one refusal cannot roll a neighbour back.
    const res = approveVariance(db, id, reviewer, reason);
    if (res.ok) approved.push({ id, material });
    else refused.push({ id, material, reason: res.error || 'Refused' });
  }

  return Response.json({ ok: true, requested: ids.length, approved, refused });
}
