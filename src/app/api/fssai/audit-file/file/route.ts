/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { isManagement } from '@/lib/auth';
import { FSSAI_PHOTO_MIMES } from '@/lib/fssai';
import { requireFssaiUser, str } from '@/lib/fssai-server';
import { fssaiTableExists } from '../../_p9/lib';
import { AUDIT_FILE_SCAN_TABLES, decodeImageDataUri } from '../scans';

/**
 * ONE SCAN FROM THE AUDIT FILE (/api/fssai/audit-file/file?id=<attachment id>).
 *
 * The audit file's "link to the real record" for a paper: the licence, the
 * certificate, the report itself — the image, not the row describing it.
 * Inspection Mode never shows scans; this is how the audit-file page opens one
 * in a new tab.
 *
 * MANAGEMENT ONLY, the same gate as the page. It serves an attachment only
 * when it belongs to one of the registers the audit file lists
 * (AUDIT_FILE_SCAN_TABLES), is still stored, and is one of the image types the
 * FSSAI upload path accepts — the Content-Type comes from that allowlist, never
 * from the stored string as-is, and nosniff stops a browser second-guessing it.
 * Read-only.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  if (!isManagement(g.me as any)) {
    return Response.json({ error: 'The audit file is management only.' }, { status: 403 });
  }
  const id = str(new URL(request.url).searchParams.get('id'));
  if (!id) return Response.json({ error: 'Say which file.' }, { status: 400 });

  try {
    const db = getDb();
    if (!fssaiTableExists(db, 'fssai_attachments')) {
      return Response.json({ error: 'There are no files in this copy of the database yet.' }, { status: 404 });
    }
    const row = db.prepare(
      `SELECT id, entity_table, mime, filename, data_uri, image_dropped_at FROM fssai_attachments WHERE id = ?`,
    ).get(id) as any;
    if (!row || !AUDIT_FILE_SCAN_TABLES.includes(String(row.entity_table))) {
      return Response.json({ error: 'That file is not part of the audit file.' }, { status: 404 });
    }
    if (!str(row.data_uri)) {
      return Response.json(
        { error: `This file's image was removed${str(row.image_dropped_at) ? ` on ${str(row.image_dropped_at).slice(0, 10)}` : ''}. The record of it remains; attach a new copy.` },
        { status: 410 },
      );
    }
    const img = decodeImageDataUri(str(row.data_uri));
    const mime = FSSAI_PHOTO_MIMES.includes(String(row.mime)) ? String(row.mime) : img?.mime || '';
    if (!img || !FSSAI_PHOTO_MIMES.includes(mime)) {
      return Response.json({ error: 'That file is not an image this screen can show.' }, { status: 415 });
    }
    const bytes = new Uint8Array(img.bytes);
    const safeName = (str(row.filename) || `scan-${String(row.id).slice(0, 8)}`).replace(/[^\w.\- ]+/g, '_').slice(0, 80);
    return new Response(bytes, {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `inline; filename="${safeName}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e: any) {
    console.error('GET /api/fssai/audit-file/file failed:', e);
    return Response.json({ error: e?.message || 'Could not read that file' }, { status: 500 });
  }
}
