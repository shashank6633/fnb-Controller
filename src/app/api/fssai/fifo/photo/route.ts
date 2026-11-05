/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireFssaiUser, str } from '@/lib/fssai-server';
import { p5CanSee, readP5AttachmentImage } from '../../_p5/records';

/**
 * ONE PHOTOGRAPH FROM THE EXPIRY REGISTER (/api/fssai/fifo/photo?id=…).
 *
 * ── WHY THE IMAGE IS NOT JUST SENT WITH THE LIST ────────────────────────────
 * Photographs are stored in-row as TEXT data URIs, up to 400 KB each and four per
 * record. A register page showing 300 entries would be a 480 MB response. So the
 * list returns the attachment ROW — its id, size, caption and whether the image
 * has aged out — and the browser asks for each image it actually shows, here.
 *
 * ── IT IS AUTHENTICATED AND SCOPED, NOT A PUBLIC IMAGE URL ──────────────────
 * proxy.ts guards pages, not APIs, so this route does its own work: a signed-in
 * user, and then the SAME visibility rule as the register itself, applied to the
 * PARENT record. Otherwise an attachment id in a URL would be a way to read a
 * photograph from another department's record — and these are photographs of a
 * real kitchen.
 *
 * It only ever serves an image mime from FSSAI_PHOTO_MIMES (readP5AttachmentImage
 * re-checks on the way out, so a row written before that check existed cannot be
 * the one that slips through), and it sets nosniff.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const db = getDb();
    const id = str(new URL(request.url).searchParams.get('id'));
    if (!id) return Response.json({ error: 'Which photograph? No id was sent.' }, { status: 400 });

    const found = readP5AttachmentImage(db, 'fssai_expiry_items', id);
    if (!found) return Response.json({ error: 'That photograph no longer exists.' }, { status: 404 });

    const parent = db.prepare(
      `SELECT department_id, recorded_by FROM fssai_expiry_items WHERE id = ?`,
    ).get(found.entity_id) as any;
    if (!parent) return Response.json({ error: 'That entry no longer exists.' }, { status: 404 });
    if (!p5CanSee(me, parent)) {
      return Response.json({ error: 'That entry belongs to another department.' }, { status: 403 });
    }

    if (found.image_dropped_at || !found.data_uri) {
      /* 410 and not 404: the ROW is still there and still part of the record —
       * the image itself has aged out under the 12-month retention rule. A screen
       * that got a 404 would say "missing", which reads as data loss. */
      return Response.json(
        { error: 'The photograph itself has aged out. The record of it is still on the file.' },
        { status: 410 },
      );
    }
    if (!found.mime) {
      return Response.json({ error: 'That attachment is not an image this app will serve.' }, { status: 415 });
    }

    const comma = found.data_uri.indexOf(',');
    const b64 = comma >= 0 ? found.data_uri.slice(comma + 1) : '';
    const bytes = Buffer.from(b64, 'base64');
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': found.mime,
        'Content-Length': String(bytes.length),
        'X-Content-Type-Options': 'nosniff',
        /* PRIVATE. A compliance photograph must not sit in a shared cache, and
         * the record it belongs to is department-scoped. */
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': `inline; filename="${found.filename.replace(/[^A-Za-z0-9._-]/g, '_') || 'photo'}"`,
      },
    });
  } catch (e: any) {
    console.error('GET /api/fssai/fifo/photo failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the photograph' }, { status: 500 });
  }
}
