/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Task file store (POST /api/tasks/files) — MEDIA slice (Phase 3).
 *
 * The Task-Management module keeps IMAGES on the inline-base64 path
 * (ImageUpload downscales to a small data: URI stored directly in a text
 * column). Larger media — video / voice recordings / documents — cannot ride
 * that path, so they are streamed into the `task_files` BLOB table (added,
 * idempotently, in db.ts) and referenced by a stable URL:
 *
 *     GET /api/tasks/files/<id>
 *
 * POST accepts EITHER shape:
 *   • JSON  { data: "data:<mime>;base64,<payload>", filename?, kind? }
 *   • multipart/form-data with a `file` (or `data`) field (a real File/Blob)
 *
 * On success it validates the mime + caps the byte size, stores the Buffer,
 * and returns:
 *     { id, url:"/api/tasks/files/<id>", mime, filename, size, kind }
 * where `kind` is one of image|video|voice|file (derived from the mime; audio
 * maps to "voice" so it slots straight into task_attachments.kind).
 *
 * Gate: any signed-in user (task media is app-wide, same as task reads).
 * CSRF on POST is enforced by proxy.ts (/api/tasks prefix).
 */
export const dynamic = 'force-dynamic';

/* ── size caps (bytes) ─────────────────────────────────────────────────── */
const MB = 1024 * 1024;
const CAP_IMAGE = 10 * MB;   // route path is only for large images; small ones stay inline
const CAP_VIDEO = 20 * MB;
const CAP_AUDIO = 5 * MB;    // voice notes
const CAP_FILE = 10 * MB;    // generic documents (pdf/text/office)

/** Allowed generic (non image/video/audio) document mimes for the FILE mode. */
const ALLOWED_DOC_MIMES = new Set<string>([
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

interface Decoded { buf: Buffer; mime: string; filename: string; }

/** Parse a `data:<mime>;base64,<payload>` URI into a Buffer + mime. */
function parseDataUri(uri: string): Decoded | null {
  const m = /^data:([^;,]*)(;[^,]*)?,([\s\S]*)$/.exec(uri);
  if (!m) return null;
  const mime = (m[1] || '').trim().toLowerCase() || 'application/octet-stream';
  const meta = m[2] || '';
  const payload = m[3] || '';
  const buf = /;base64/i.test(meta)
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { buf, mime, filename: '' };
}

/** Validate mime + size; returns an error string or null when acceptable. */
function validate(mime: string, size: number): string | null {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) {
    // SVG can carry inline scripts; reject outright (raster images ride this
    // path only as large uploads — vector/active image types are never stored).
    if (m === 'image/svg+xml' || m.includes('svg')) {
      return 'SVG images are not allowed. Please upload a raster image (PNG/JPG).';
    }
    return size > CAP_IMAGE ? `Image too large (max ${CAP_IMAGE / MB}MB).` : null;
  }
  if (m.startsWith('video/')) {
    return size > CAP_VIDEO ? `Video too large (max ${CAP_VIDEO / MB}MB).` : null;
  }
  if (m.startsWith('audio/')) {
    return size > CAP_AUDIO ? `Audio too large (max ${CAP_AUDIO / MB}MB).` : null;
  }
  if (ALLOWED_DOC_MIMES.has(m)) {
    return size > CAP_FILE ? `File too large (max ${CAP_FILE / MB}MB).` : null;
  }
  return `Unsupported file type${mime ? ` (${mime})` : ''}. Allowed: video, audio, images and common documents.`;
}

/** Map a mime to a task_attachments.kind. audio → "voice". */
function kindForMime(mime: string): 'image' | 'video' | 'voice' | 'file' {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'voice';
  return 'file';
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    let decoded: Decoded | null = null;
    const ctype = (request.headers.get('content-type') || '').toLowerCase();

    if (ctype.includes('multipart/form-data')) {
      const form = await request.formData();
      const entry = (form.get('file') ?? form.get('data')) as unknown;
      if (entry && typeof entry === 'object' && 'arrayBuffer' in (entry as any)) {
        const file = entry as File;
        const ab = await file.arrayBuffer();
        decoded = {
          buf: Buffer.from(ab),
          mime: (file.type || 'application/octet-stream').toLowerCase(),
          filename: file.name || '',
        };
      } else if (typeof entry === 'string') {
        decoded = parseDataUri(entry);
      }
      const fn = form.get('filename');
      if (decoded && typeof fn === 'string' && fn) decoded.filename = fn;
    } else {
      // JSON { data, filename?, kind? }
      const body = await request.json().catch(() => null) as any;
      const raw = body?.data ?? body?.url;
      if (typeof raw === 'string' && raw.startsWith('data:')) {
        decoded = parseDataUri(raw);
        if (decoded && typeof body?.filename === 'string') decoded.filename = body.filename;
      }
    }

    if (!decoded || !decoded.buf || decoded.buf.length === 0) {
      return Response.json({ error: 'No file received. Send a data: URI or a multipart file.' }, { status: 400 });
    }

    const size = decoded.buf.length;
    const err = validate(decoded.mime, size);
    if (err) return Response.json({ error: err }, { status: 413 });

    const id = generateId();
    const filename = (decoded.filename || `upload-${id}`).slice(0, 200);
    getDb()
      .prepare(`INSERT INTO task_files (id, mime, filename, data, size, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run(id, decoded.mime, filename, decoded.buf, size, me.email || me.name || '');

    return Response.json({
      id,
      url: `/api/tasks/files/${id}`,
      mime: decoded.mime,
      filename,
      size,
      kind: kindForMime(decoded.mime),
    });
  } catch (e: any) {
    console.error('POST /api/tasks/files failed:', e);
    return Response.json({ error: e?.message || 'Upload failed' }, { status: 500 });
  }
}
