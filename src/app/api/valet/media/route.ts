import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { requireStaff, fail } from '@/lib/valet/core';
import { storePhoto, readPhoto, listPhotos, PHOTO_MAX_BYTES } from '@/lib/valet/media';
import { valetJson, NO_STORE } from '@/lib/valet/http';

/**
 * Condition photos.
 *   POST (multipart: outlet_id, session_id, position, annotation, file) — attendant/head.
 *   GET ?outlet=&id=      — the image bytes, private + no-store (attendant/head).
 *   GET ?outlet=&session= — the list for one car (no bytes).
 * Every call re-authenticates and is scoped to an outlet the caller works at:
 * there is no public or long-lived URL for a photo. CSRF: '/api/valet/' prefix.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return valetJson(async () => {
    const len = Number(req.headers.get('content-length') || 0);
    if (len > PHOTO_MAX_BYTES + 64_000) fail(413, 'too_large', 'That photo is too large (max 2 MB).');
    const form = await req.formData();
    const db = getDb();
    const { actor, ov } = requireStaff(db, await getCurrentUser(), String(form.get('outlet_id') || ''), 'attendant');
    const file = form.get('file');
    if (!(file instanceof Blob)) fail(400, 'no_file', 'Choose a photo first.');
    const data = Buffer.from(await (file as Blob).arrayBuffer());
    return storePhoto(db, ov, actor, {
      session_id: String(form.get('session_id') || ''), position: String(form.get('position') || ''),
      annotation: String(form.get('annotation') || ''), data,
    });
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return valetJson(async () => {
      const db = getDb();
      const { ov } = requireStaff(db, await getCurrentUser(), url.searchParams.get('outlet') || '', 'attendant');
      return { photos: listPhotos(db, ov.outlet_id, url.searchParams.get('session') || '') };
    });
  }
  try {
    const db = getDb();
    const { ov } = requireStaff(db, await getCurrentUser(), url.searchParams.get('outlet') || '', 'attendant');
    const p = readPhoto(db, ov.outlet_id, id);
    if (!p) return new Response('Not found', { status: 404, headers: NO_STORE });
    return new Response(new Uint8Array(p.data), {
      headers: { ...NO_STORE, 'Content-Type': p.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' },
    });
  } catch (e) {
    const status = (e as { status?: number }).status || 500;
    return new Response(status === 401 ? 'Sign in required' : 'Not allowed', { status, headers: NO_STORE });
  }
}
