/* eslint-disable @typescript-eslint/no-explicit-any */
import { requireRole } from '@/lib/auth';
import { reportMenuImageOrphans, sweepMenuImageOrphans } from '@/lib/menu-image-store';

/**
 * DISH-PHOTO STORAGE — report (GET) and reclaim (POST).
 *
 * This is the replacement for the sweep that used to run as a side effect of
 * every photo upload. Deleting a blob cannot be undone, so it is now something
 * an admin does deliberately, after reading exactly what will go:
 *
 *   GET  → a DRY RUN. Counts, bytes, and the individual rows a sweep would
 *          delete. Reads only; there is no code path from here to a DELETE.
 *   POST → the sweep, and only with `confirm: true`. Optionally `ids: [...]`,
 *          the exact rows the admin was shown, so a photo attached to an item
 *          between the preview and the confirm cannot be caught in a wider net.
 *
 * GATE — ADMIN, stricter than the rest of the module. Uploading a photo is
 * open to any signed-in user who can reach the Menu Items page (see the sibling
 * ../route.ts); permanently destroying stored images is not. requireRole is the
 * real boundary; the button on the page only avoids offering a click that would
 * always 403. On top of that, /api/menu-items is in CSRF_REQUIRED_PREFIXES and
 * src/proxy.ts validates the session against the sessions table before any
 * POST reaches this file.
 *
 * The destructive verb is POST, not DELETE, and it refuses without an explicit
 * confirm — so no probe, prefetch or mis-wired client can sweep by accident.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
  try {
    return Response.json(reportMenuImageOrphans());
  } catch (e: any) {
    console.error('GET /api/menu-items/image/orphans failed:', e);
    return Response.json({ error: e?.message || 'Could not read photo storage' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const body = await request.json().catch(() => null) as any;
  if (!body || body.confirm !== true) {
    return Response.json(
      { error: 'Refusing to delete without an explicit confirmation.' },
      { status: 400 },
    );
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x: unknown) => typeof x === 'string' && x.trim()).map((x: string) => x.trim())
    : undefined;
  // An `ids: []` that arrived empty because the client lost its list must NOT
  // fall through to "sweep everything eligible" — that is exactly the silent
  // over-delete this whole change exists to prevent.
  if (Array.isArray(body.ids) && !ids?.length) {
    return Response.json({ deleted: [], bytes: 0, skipped: [], grace_days: 0 });
  }

  try {
    const result = sweepMenuImageOrphans({ ids, actorEmail: gate.user.email || gate.user.name || '' });
    return Response.json(result);
  } catch (e: any) {
    console.error('POST /api/menu-items/image/orphans failed:', e);
    return Response.json({ error: e?.message || 'Sweep failed' }, { status: 500 });
  }
}
