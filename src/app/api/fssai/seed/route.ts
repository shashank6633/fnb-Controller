/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import { requireFssaiAdmin, fssaiCsrfGuard, str } from '@/lib/fssai-server';
import { FSSAI_CHECKLIST_PACK } from '@/lib/fssai-checklist-pack';
import { readFssaiChecklistSeedState, applyFssaiChecklistPack } from '@/lib/fssai-seed-server';

/**
 * THE READY-MADE CHECKLISTS (/api/fssai/seed) — P8.
 *
 * GET  → { state } : what the pack contains, whether it has already been set
 *        up, which of the twelve codes already exist in this outlet, the
 *        configuration warnings each one would carry, and the seed log. Also
 *        `departments`, read-only, so the screen's optional department pickers
 *        match on ID and never on a name (RECON §5 row 5 — live names carry
 *        double spaces).
 *
 * POST { publish?: boolean, department_by_code?: { CODE: department_id } }
 *      → creates the twelve, ONCE. Default is DRAFT, deliberately: a draft is
 *        invisible to staff, so the owner reads each checklist and publishes it
 *        himself. `publish: true` creates them live for an owner who wants that.
 *
 * ⚠️ THERE IS NO PUT AND NO DELETE, and that is the point of the whole phase.
 * A pack cannot be re-run (`uq_fssai_seed_item` on the marker row refuses it)
 * and it cannot be rolled back from here: once the twelve exist they are the
 * owner's checklists, edited and retired in the builder like any other. A seed
 * that could delete what it made would be able to delete his edits with them.
 *
 * ADMIN ONLY (owner §20: the administrator configures). `requireFssaiAdmin`
 * is the gate that holds — proxy.ts guards PAGES, not APIs, and canAccessPage
 * fails open four ways (HARD RULE 10). `fssaiCsrfGuard` re-checks the
 * cookie/header pair inside the handler as well: the proxy already lists
 * '/api/fssai' in CSRF_REQUIRED_PREFIXES (proxy.ts:104), and this agrees with it
 * rather than replacing it.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';
    const state = readFssaiChecklistSeedState(db, outletId, FSSAI_CHECKLIST_PACK);

    // READ ONLY. FSSAI never creates a department (HARD RULE 4) — this is a
    // projection of the owner's own table so the picker can send an id.
    const departments = db.prepare(
      `SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name ASC`,
    ).all() as any[];

    return Response.json({
      state,
      departments,
      // The pack is offerable when it has never run AND this build's engine can
      // render every question in it.
      can_apply: !state.applied && state.problems.length === 0,
    });
  } catch (e: any) {
    console.error('GET /api/fssai/seed failed:', e);
    return Response.json({ error: e?.message || 'Failed to read the ready-made checklists' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* an empty body is a valid apply */ }

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';

    // Only the twelve codes the pack knows are accepted as keys, so a stray key
    // cannot quietly become a department nobody asked for.
    const rawMap = body?.department_by_code && typeof body.department_by_code === 'object'
      ? body.department_by_code as Record<string, unknown>
      : {};
    const departmentByCode: Record<string, string> = {};
    for (const t of FSSAI_CHECKLIST_PACK.templates) {
      const v = str(rawMap[t.code]);
      if (v) departmentByCode[t.code] = v;
    }
    const unknownKeys = Object.keys(rawMap).filter(
      (k) => !FSSAI_CHECKLIST_PACK.templates.some((t) => t.code === k),
    );
    if (unknownKeys.length) {
      return Response.json(
        { error: `"${unknownKeys[0]}" is not one of the ready-made checklists.` },
        { status: 400 },
      );
    }

    const result = applyFssaiChecklistPack(db, {
      actor: { email: me.email, name: me.name },
      outletId,
      departmentByCode,
      publish: body?.publish === true || body?.publish === 1 || body?.publish === '1',
    });

    if (!result.ok) {
      // 409 for "it already ran" — the state is returned with it so the screen
      // can show what is there instead of just refusing.
      if (result.code === 'already_applied') {
        return Response.json({ error: result.message, code: result.code, state: result.state }, { status: 409 });
      }
      if (result.code === 'pack_invalid') {
        return Response.json({ error: result.message, code: result.code, problems: result.problems }, { status: 500 });
      }
      return Response.json({ error: result.message, code: result.code }, { status: 400 });
    }

    const state = readFssaiChecklistSeedState(db, outletId, FSSAI_CHECKLIST_PACK);
    return Response.json({
      inserted: result.inserted,
      skipped: result.skipped,
      status: result.status,
      items: result.items,
      state,
    });
  } catch (e: any) {
    console.error('POST /api/fssai/seed failed:', e);
    return Response.json(
      { error: e?.message || 'Failed to set up the ready-made checklists. Nothing was created.' },
      { status: 500 },
    );
  }
}
