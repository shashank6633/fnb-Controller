/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Serve a stored task file (GET /api/tasks/files/:id) — MEDIA slice.
 *
 * Streams the BLOB from `task_files` back with the correct Content-Type so a
 * <video>/<audio> element (or a download link) can consume it directly. The row
 * is content-addressed by an immutable id, so it is safe to cache hard.
 *
 * Gate: any signed-in user (task media visibility is app-wide).
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    const { id } = await params;
    const row = getDb()
      .prepare(`SELECT mime, filename, data, size FROM task_files WHERE id = ?`)
      .get(id) as { mime: string; filename: string; data: Buffer; size: number } | undefined;

    if (!row || !row.data) {
      return Response.json({ error: 'File not found' }, { status: 404 });
    }

    // better-sqlite3 returns a Node Buffer for a BLOB column. Copy into a fresh
    // Uint8Array so the Web Response body gets a clean ArrayBuffer view.
    const bytes = Uint8Array.from(row.data);
    const rawMime = (row.mime || 'application/octet-stream').toLowerCase();
    // Never hand back an active/renderable-as-script type on the app origin.
    // SVG (and any html/xml) can execute JS; force it to an inert download type
    // so it can never be interpreted as active content. Belt-and-braces on top
    // of the upload-side SVG reject.
    const isActive =
      rawMime.includes('svg') ||
      rawMime.includes('html') ||
      rawMime === 'application/xml' ||
      rawMime === 'text/xml';
    const mime = isActive ? 'application/octet-stream' : (row.mime || 'application/octet-stream');
    const safeName = (row.filename || 'file').replace(/[\r\n"]/g, '');

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(row.size || bytes.byteLength),
        // Always download rather than render top-level: a stored blob must never
        // execute as a document on the fnb-controller origin (stored-XSS guard).
        // Media (<video>/<audio> src) and <img> subresource loads ignore this
        // header and still render, so previews keep working.
        'Content-Disposition': `attachment; filename="${safeName}"`,
        // Stop MIME sniffing so a mislabelled blob can't be reinterpreted as HTML/JS.
        'X-Content-Type-Options': 'nosniff',
        // Immutable content-addressed blob — cache aggressively (private = per-user cache only).
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  } catch (e: any) {
    console.error('GET /api/tasks/files/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to load file' }, { status: 500 });
  }
}
