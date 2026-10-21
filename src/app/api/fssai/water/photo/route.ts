/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireFssaiUser, str } from '@/lib/fssai-server';
import { p5CanSee, readP5AttachmentImage } from '../../_p5/records';

/**
 * ONE SCAN OR PHOTOGRAPH FROM A WATER RECORD (/api/fssai/water/photo?id=…).
 *
 * The reasoning is written out in /api/fssai/fifo/photo: these live in-row as TEXT
 * data URIs, so the list returns the attachment ROW and the browser asks for each
 * image it actually shows, here, authenticated and scoped to the parent record.
 *
 * In practice the commonest attachment on this screen is a photographed
 * laboratory certificate, which is the single most valuable piece of paper in the
 * water file — which is also why it is NOT served from a public URL.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const db = getDb();
    const id = str(new URL(request.url).searchParams.get('id'));
    if (!id) return Response.json({ error: 'Which file? No id was sent.' }, { status: 400 });

    const found = readP5AttachmentImage(db, 'fssai_water_tests', id);
    if (!found) return Response.json({ error: 'That file no longer exists.' }, { status: 404 });

    const parent = db.prepare(
      `SELECT department_id, recorded_by FROM fssai_water_tests WHERE id = ?`,
    ).get(found.entity_id) as any;
    if (!parent) return Response.json({ error: 'That water record no longer exists.' }, { status: 404 });
    if (!p5CanSee(me, parent)) {
      return Response.json({ error: 'That water record belongs to another department.' }, { status: 403 });
    }

    if (found.image_dropped_at || !found.data_uri) {
      return Response.json(
        { error: 'The image itself has aged out. The record of it is still on the file.' },
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
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': `inline; filename="${found.filename.replace(/[^A-Za-z0-9._-]/g, '_') || 'file'}"`,
      },
    });
  } catch (e: any) {
    console.error('GET /api/fssai/water/photo failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the file' }, { status: 500 });
  }
}
