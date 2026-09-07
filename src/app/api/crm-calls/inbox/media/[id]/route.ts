/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * GET /api/crm-calls/inbox/media/[id] — serve stored inbound WhatsApp media.
 *
 * AUTHED (task_files serving pattern) — inbound guest media must never be
 * public, so this lives under the protected /api/crm-calls prefix AND
 * self-gates on getCurrentUser. Contrast /api/customer/menu-image, which is
 * deliberately public.
 *
 * Rows are immutable (id is the cache key, media is fetched once at ingest
 * and never rewritten) → cache hard, private.
 *
 * Renderable media (image/video/audio) serves inline so <img>/<video> in the
 * thread work; everything else downloads. Active types (svg/html/xml) are
 * neutralised to an inert octet-stream — stored-XSS guard, same as task_files.
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    const { id } = await params;
    const mediaId = Number(id);
    if (!Number.isFinite(mediaId) || mediaId <= 0) return Response.json({ error: 'Bad media id' }, { status: 400 });

    const row = getDb()
      .prepare('SELECT mime, size, data FROM wa_media WHERE id = ?')
      .get(mediaId) as { mime: string; size: number; data: Buffer } | undefined;
    if (!row || !row.data) return Response.json({ error: 'Media not found' }, { status: 404 });

    // better-sqlite3 returns a Node Buffer for a BLOB column. Copy into a fresh
    // Uint8Array so the Web Response body gets a clean ArrayBuffer view.
    const bytes = Uint8Array.from(row.data);
    const rawMime = (row.mime || 'application/octet-stream').toLowerCase();
    // Never hand back an active/renderable-as-script type on the app origin.
    const isActive =
      rawMime.includes('svg') ||
      rawMime.includes('html') ||
      rawMime === 'application/xml' ||
      rawMime === 'text/xml';
    const mime = isActive ? 'application/octet-stream' : (row.mime || 'application/octet-stream');
    // Images/video/audio render inline in the thread; documents download.
    const inline = !isActive && /^(image|video|audio)\//.test(mime);

    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Content-Length': String(row.size || bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    };
    if (!inline) headers['Content-Disposition'] = `attachment; filename="wa-media-${mediaId}"`;

    return new Response(bytes, { status: 200, headers });
  } catch (e: any) {
    console.error('GET /api/crm-calls/inbox/media/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to load media' }, { status: 500 });
  }
}
