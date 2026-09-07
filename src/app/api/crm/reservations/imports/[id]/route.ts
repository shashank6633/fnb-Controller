/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole, getCurrentUser } from '@/lib/auth';
import { previewImportUndo, undoImport, UndoError } from '@/lib/reservego-undo';

/**
 * Reservation CRM — UNDO ONE IMPORT (/crm-calls/database → Import History).
 *
 *   GET    /api/crm/reservations/imports/[id]            → what a delete WOULD do
 *   GET    /api/crm/reservations/imports/[id]?preview=1  → the same thing
 *   DELETE /api/crm/reservations/imports/[id]            → does it, in one txn
 *   DELETE /api/crm/reservations/imports/[id]?force=1    → …even if still 'running'
 *
 * WHY THIS EXISTS. The owner is trialling the Reservego importer on production
 * and needs the loop to be reversible: upload a file, look at what landed, and
 * if it is wrong, take THAT upload back, fix the file and go again. Without this
 * the only way back from a bad file is a database restore.
 *
 * ── THE GET IS NOT DECORATION ────────────────────────────────────────────────
 * It writes nothing and it is the whole safety mechanism. An import re-stamps
 * its `import_id` onto every row it INSERTED or AMENDED (the upsert at
 * reservego-import.ts:862 carries the column), so a booking an EARLIER file
 * created and this one amended now carries this import's id and is deleted with
 * it. A row this file merely re-confirmed WITHOUT changing anything takes the
 * bumpStamp path instead (reservego-import.ts:1328-1342 → :864, which writes
 * only source_exported_at) and keeps the earlier file's id, so it survives. The
 * preview counts exactly that reach (`bookings_from_earlier_imports`) and
 * returns `notice`, a list of plain sentences the page is expected to print
 * verbatim rather than summarise. Show the numbers without the notice and this
 * stops being an honest button.
 *
 * The engine and every rule it enforces — which guests may be removed, which
 * rows can never be matched, why the session row is deleted rather than flagged
 * — live in src/lib/reservego-undo.ts. This file is auth, parsing and status
 * codes.
 *
 * ── THE WIRE SHAPE IS THE ENGINE'S, VERBATIM ─────────────────────────────────
 * Both handlers are a PASS-THROUGH: whatever previewImportUndo / undoImport
 * return is serialised as-is. There is no `preview:` wrapper, no `deleted:`
 * wrapper, and none is to be added. Every number lives under `counts`, every
 * sentence under `notice`.
 *
 * That is not a style preference — guessing a wrapper here is the exact bug the
 * page shipped with. It read `json.preview ?? json.deleted ?? json`, found
 * neither key, coerced every miss to a confident 0, and rendered "Delete 0
 * bookings" over a delete that removed 371. If a future edit needs to add a
 * field, add it to UndoPreview / UndoResult in the engine so the one type
 * describes the one payload; do not reshape it on the way out. Anything this
 * route invents is a field the engine cannot keep true.
 *
 * Fields the page depends on and this route must never drop:
 *   GET    → import, counts, notice, deletable, blocked_reason, provenance
 *   DELETE → found, already_deleted, counts, guests_refreshed, import_deleted,
 *            notice, provenance
 * The one thing this route adds itself is `code` on the 409 (see below).
 *
 * ── WHO MAY DO THIS ──────────────────────────────────────────────────────────
 * ADMIN ONLY, enforced HERE, in the handler, on both methods —
 * requireRole('admin') resolves the session token against the sessions table and
 * the effective tier from the assigned named role, so a forged or expired cookie
 * and a signed-in manager both bounce. 401 unsigned, 403 signed and not admin.
 *
 * This handler-level gate is the ONLY admin check on the wire, and it has to be:
 *
 *   • src/proxy.ts (Next 16's renamed middleware) role-gates PAGE requests only
 *     — its canAccessPage branch is inside `if (!isApi)`. No /api path is
 *     role-checked there, so the adminOnly catalog entry on /crm-calls/database
 *     (page-catalog.ts:303) hides the BUTTON and nothing more.
 *   • The proxy validates the session token for state-changing /api calls and
 *     only checks cookie PRESENCE on GETs — so the preview, which enumerates
 *     guest counts, would be reachable with a junk cookie if this handler did
 *     not authenticate for itself.
 *   • Next's own docs say the proxy is meant to run separately from render code
 *     and may be deployed to a CDN (node_modules/next/dist/docs/01-app/
 *     03-api-reference/03-file-conventions/proxy.md). An authorisation boundary
 *     does not belong somewhere that is allowed to run somewhere else.
 *
 * Two spellings of this same gate exist in the family and both enforce
 * `role === 'admin'` server-side: requireRole('admin') here and in export,
 * import/start, import/batch, import/finish; the inline getCurrentUser() +
 * `role !== 'admin'` form in customers, bookings, imports, query, sql,
 * relink-bands. requireRole is the one the other destructive import routes use,
 * which is why it is the one here. This route destroys rows, so it could not be
 * looser than the routes that merely read them.
 *
 * CSRF is layered on top for the DELETE: /api/crm is in the proxy's
 * CSRF_REQUIRED_PREFIXES, so a state-changing call without a matching
 * X-CSRF-Token is refused 403 before it reaches this file. The page must
 * therefore call through src/lib/api.ts, which injects the header; a bare
 * fetch() DELETE will never arrive.
 *
 * ── STATUS CODES, AND WHY DELETE DOES NOT 404 ────────────────────────────────
 * GET answers 404 for an id with no session row AND no bookings still carrying
 * it, matching `GET /api/crm/reservations/imports?id=` for a missing import.
 *
 * DELETE answers 200 in that case, with already_deleted: true and zeroed counts.
 * A DELETE promises a post-state, not a row, and the second click of a
 * double-click must not paint an error over a successful undo. 409 is reserved
 * for the one case that is genuinely not safe: a session still 'running' inside
 * the ten-minute window (see ACTIVE_WINDOW_MS), where deleting it would leave
 * the browser's remaining batches writing bookings under an id Import History no
 * longer lists. ?force=1 is the documented way past it for an upload that is
 * dead rather than live.
 *
 * ── THE 409 CARRIES A CODE, AND THAT IS LOAD-BEARING ─────────────────────────
 * The refusal body is `{ error, code: 'import_running' }`. The page arms its
 * Force affordance off `code`, never off the message text — an error string is
 * copy, it gets reworded, and a UI that pattern-matches on copy breaks silently
 * the day someone improves the wording. `code` is the contract; the message is
 * for the human.
 *
 * The code is read off the thrown UndoError defensively rather than through the
 * class type, so this route serialises it whether or not the engine has declared
 * the field yet. Only the 409 sets one today. Every other 4xx/5xx stays exactly
 * `{ error }`.
 *
 * NEVER auto-retry a 409 with force. The 409 offers the override; a person ticks
 * the box. Retrying here would make the guard decorative.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** No 4xx/5xx here is cacheable either: a stale 403, or a stale "still running"
 *  refusal replayed after the upload finished, is worse than another round trip. */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status, headers: NO_STORE });

  // Next 16: params is a Promise and must be awaited before it is read.
  const { id } = await params;
  const importId = String(id ?? '').trim();
  if (!importId) return Response.json({ error: 'An import id is required' }, { status: 400, headers: NO_STORE });

  try {
    // ?preview=1 is accepted and ignored: a GET here is a preview by
    // definition, and the parameter only exists so a caller that spells its
    // intention out gets the same answer rather than a surprise. There is
    // deliberately no ?force on a GET — force changes what a DELETE is allowed
    // to do, and a preview is not allowed to do anything.
    const preview = previewImportUndo(getDb(), importId);
    if (!preview) return Response.json({ error: 'Import not found' }, { status: 404, headers: NO_STORE });
    // Verbatim. counts / notice / deletable / blocked_reason / provenance all
    // reach the page exactly as the engine computed them — see the wire note above.
    return Response.json(preview, { headers: NO_STORE });
  } catch (e: any) {
    console.error('[GET /api/crm/reservations/imports/[id]]', e);
    return Response.json({ error: e?.message || 'Failed to inspect the import' }, { status: 500, headers: NO_STORE });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status, headers: NO_STORE });

  // Next 16: params is a Promise and must be awaited before it is read.
  const { id } = await params;
  const importId = String(id ?? '').trim();
  if (!importId) return Response.json({ error: 'An import id is required' }, { status: 400, headers: NO_STORE });

  // The override is the query string and the literal string '1' — no body, no
  // header, no other spelling. Strict on purpose and it fails the SAFE way:
  // ?force=true or ?force=yes is not force, so a caller that guesses the
  // spelling gets the 409 back rather than a silent unguarded delete of an
  // upload that is still posting batches.
  const force = new URL(request.url).searchParams.get('force') === '1';

  // Named in the server log the deleted session row can no longer be. requireRole
  // already proved the session, so this is only for the name.
  const me = await getCurrentUser();
  const actor = me?.email || me?.name || me?.id || '';

  try {
    const result = undoImport(getDb(), importId, { force, actor });
    // Verbatim, same as the GET: found / already_deleted / counts /
    // guests_refreshed / import_deleted / notice / provenance, unwrapped.
    return Response.json(result, { headers: NO_STORE });
  } catch (e: any) {
    // Read before the instanceof narrows `e` to the class: `code` is a handoff
    // field the engine sets on the 409, and this route must forward it whether
    // or not the class has declared it. Absent on every other error.
    const code = typeof e?.code === 'string' && e.code ? e.code : '';
    if (e instanceof UndoError) {
      // A bad status would make Response.json throw from inside the catch and
      // answer an opaque, unlogged 500 — on the one route where "did my delete
      // run?" must never be ambiguous. Clamp, don't gamble.
      const status = Number.isInteger(e.status) && e.status >= 400 && e.status <= 599 ? e.status : 400;
      const body: { error: string; code?: string } = { error: e.message };
      if (code) body.code = code;
      return Response.json(body, { status, headers: NO_STORE });
    }
    console.error('[DELETE /api/crm/reservations/imports/[id]]', e);
    return Response.json({ error: e?.message || 'Failed to delete the import' }, { status: 500, headers: NO_STORE });
  }
}
