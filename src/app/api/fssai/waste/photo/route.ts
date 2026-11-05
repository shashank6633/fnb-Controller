/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireFssaiUser, str } from '@/lib/fssai-server';
import { readWastePhotoImage, canSeeWasteHandover } from '../../_waste/lib';

/**
 * ONE PHOTOGRAPH FROM A WASTE HANDOVER (/api/fssai/waste/photo?id=<attachment>).
 *
 * Images live in-row as TEXT data URIs, so the register returns the attachment
 * ROW and the browser asks for each image it shows, here — signed in and scoped
 * to who may see the handover. The entity table is FIXED to
 * fssai_waste_handovers in the query (a JOIN), never taken from the request.
 *
 * A VOIDED photograph is still served. Q22: a mistaken file is voided, kept and
 * visible as void — the screen labels it; hiding the picture would be deleting
 * it by another name.
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

    const found = readWastePhotoImage(db, id);
    if (!found) return Response.json({ error: 'That photograph is not on any waste handover.' }, { status: 404 });
    if (!canSeeWasteHandover(me, found.parent)) {
      return Response.json({ error: 'That handover belongs to another department.' }, { status: 403 });
    }
    if (found.image_dropped_at || !found.data_uri) {
      return Response.json({ error: 'The picture itself is not stored. The record of it is still on the file.' }, { status: 410 });
    }
    if (!found.mime) return Response.json({ error: 'That attachment is not an image this app will serve.' }, { status: 415 });

    const comma = found.data_uri.indexOf(',');
    const bytes = Buffer.from(comma >= 0 ? found.data_uri.slice(comma + 1) : '', 'base64');
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': found.mime,
        'Content-Length': String(bytes.length),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': `inline; filename="${found.filename.replace(/[^A-Za-z0-9._-]/g, '_') || 'photo'}"`,
        'X-Fssai-Attachment-Status': found.status,
      },
    });
  } catch (e: any) {
    console.error('GET /api/fssai/waste/photo failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the photograph' }, { status: 500 });
  }
}
