/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import { requireFssaiAdmin, fssaiCsrfGuard } from '@/lib/fssai-server';
import { FSSAI_CHECKLIST_PACK } from '@/lib/fssai-checklist-pack';
import { publishFssaiReadyMadeDrafts, readFssaiChecklistSeedState } from '@/lib/fssai-seed-server';

/**
 * PUBLISH THE READY-MADE CHECKLISTS (/api/fssai/seed/publish) — one click.
 *
 * POST { codes?: string[] } → publishes every ready-made DRAFT nobody has
 *      published, archived or taken back (readFssaiReadyMadeDrafts), in one
 *      transaction, each with its own fssai_audit_log row. `codes` narrows it.
 *      → { published[], held[], lost_race[], state }
 *      409 { code: 'nothing_to_publish' } when there is nothing left to publish.
 *
 * The pack seeds all fifteen as drafts on purpose (a draft is invisible to
 * staff, so the owner can read them first), and a draft cannot be run
 * (runs route: 409 "has not been published yet"). Without this an administrator
 * publishes them one page at a time.
 *
 * WHAT IT NEVER DOES: publish an archived checklist (that would bring a retired
 * one back to staff), publish a draft whose status a person already changed, or
 * touch anything but the status. The state's `drafts.held` says why each one
 * was left alone.
 *
 * ADMIN ONLY, like the seed itself: requireFssaiAdmin is the gate that holds
 * (proxy.ts guards pages, not APIs), and fssaiCsrfGuard re-checks the
 * cookie/header pair inside the handler.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* an empty body publishes them all */ }
  const codes = Array.isArray(body?.codes) ? body.codes.map((c: unknown) => String(c || '').trim()).filter(Boolean) : undefined;
  if (body?.codes !== undefined && !Array.isArray(body.codes)) {
    return Response.json({ error: '"codes" must be a list of ready-made checklist codes.' }, { status: 400 });
  }

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';
    const result = publishFssaiReadyMadeDrafts(db, {
      actor: { email: me.email, name: me.name },
      outletId,
      codes,
    });
    if (!result.ok) {
      if (result.code === 'nothing_to_publish') {
        return Response.json(
          { error: result.message, code: result.code, state: readFssaiChecklistSeedState(db, outletId, FSSAI_CHECKLIST_PACK) },
          { status: 409 },
        );
      }
      return Response.json({ error: result.message, code: result.code }, { status: 400 });
    }
    return Response.json({
      published: result.published,
      held: result.held,
      lost_race: result.lost_race,
      state: readFssaiChecklistSeedState(db, outletId, FSSAI_CHECKLIST_PACK),
    });
  } catch (e: any) {
    console.error('POST /api/fssai/seed/publish failed:', e);
    return Response.json(
      { error: e?.message || 'Failed to publish the ready-made checklists. Nothing was published.' },
      { status: 500 },
    );
  }
}
