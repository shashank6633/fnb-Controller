/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireFssaiUser, str } from '@/lib/fssai-server';
import { p5CanSee, readP5AttachmentImage } from '../../_p5/records';

/**
 * ONE PICTURE OR SCAN FROM AN OIL RECORD
 * (/api/fssai/oil/photo?id=…[&of=check|collection]).
 *
 * The reasoning is written out in /api/fssai/fifo/photo: images live in-row as
 * TEXT data URIs, so the lists return the attachment ROW and the browser asks for
 * each image it actually shows, here, authenticated and scoped.
 *
 * TWO ENTITIES BECAUSE THERE ARE TWO RECORDS. A photograph of the fryer hangs off
 * fssai_oil_checks and is department-scoped like the check; the collector's
 * receipt hangs off fssai_oil_disposals, which has NO department column (used oil
 * leaves the building as one load from the whole restaurant) and is readable by
 * any signed-in user, exactly as the disposals list is.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const db = getDb();
    const url = new URL(request.url);
    const id = str(url.searchParams.get('id'));
    const of = str(url.searchParams.get('of')) || 'check';
    if (!id) return Response.json({ error: 'Which picture? No id was sent.' }, { status: 400 });
    if (of !== 'check' && of !== 'collection') {
      return Response.json({ error: `"${of}" is not an oil record. Use check or collection.` }, { status: 400 });
    }

    /* The table is chosen from a FIXED pair here, never taken from the query, so
     * nothing a caller sends can reach SQL as a table name. */
    const entityTable = of === 'check' ? 'fssai_oil_checks' : 'fssai_oil_disposals';
    const found = readP5AttachmentImage(db, entityTable, id);
    if (!found) return Response.json({ error: 'That picture no longer exists.' }, { status: 404 });

    if (of === 'check') {
      const parent = db.prepare(
        `SELECT department_id, recorded_by FROM fssai_oil_checks WHERE id = ?`,
      ).get(found.entity_id) as any;
      if (!parent) return Response.json({ error: 'That oil check no longer exists.' }, { status: 404 });
      if (!p5CanSee(me, parent)) {
        return Response.json({ error: 'That oil check belongs to another department.' }, { status: 403 });
      }
    } else {
      const parent = db.prepare(`SELECT id FROM fssai_oil_disposals WHERE id = ?`).get(found.entity_id) as any;
      if (!parent) return Response.json({ error: 'That collection no longer exists.' }, { status: 404 });
    }

    if (found.image_dropped_at || !found.data_uri) {
      return Response.json(
        { error: 'The picture itself has aged out. The record of it is still on the file.' },
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
        'Content-Disposition': `inline; filename="${found.filename.replace(/[^A-Za-z0-9._-]/g, '_') || 'photo'}"`,
      },
    });
  } catch (e: any) {
    console.error('GET /api/fssai/oil/photo failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the picture' }, { status: 500 });
  }
}
