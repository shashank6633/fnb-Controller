/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { menuImageUrl } from '@/lib/menu-image-url';

/**
 * Menu-item dish photo upload (POST /api/menu-items/image).
 *
 * Stores an already-compressed square photo in the `menu_item_images` BLOB
 * table (see db.ts, menu region) and hands back the URL to put in
 * menu_items.image_url:
 *
 *     { id, url: "/api/customer/menu-image/<id>", mime, width, height, size }
 *
 * The caller writes that url into image_url through the EXISTING POST/PUT on
 * /api/menu-items — this route never touches the menu_items row itself, so the
 * "paste an external URL" path and the "upload a photo" path stay one field
 * with one writer.
 *
 * GATE — deliberately identical to the sibling menu-item write routes, plus one
 * extra check. Everything under the /api/menu-items prefix is gated by
 * src/proxy.ts and nothing else: (1) a fnb_session cookie must be present,
 * (2) for POST/PUT/PATCH/DELETE the token is validated against the sessions
 * table (active user, unexpired) before the handler runs, and (3) the prefix is
 * in CSRF_REQUIRED_PREFIXES, so the double-submit fnb_csrf cookie/header must
 * match. That is the whole gate on POST/PUT /api/menu-items today — those
 * handlers carry no in-route auth. This route ADDS a getCurrentUser() check on
 * top, because it writes a blob that is then served PUBLICLY and the row records
 * who uploaded it; that makes it strictly stricter than its neighbours, never
 * looser. There is no role/tier check, matching the neighbours: any signed-in
 * user who can reach the Menu Items page can already edit these same fields.
 *
 * COMPRESSION IS THE CLIENT'S JOB (MenuImageUpload.tsx squares + re-encodes to
 * ~80KB before it ever hits the network). The caps here are a backstop against
 * a hand-rolled request, not the feature.
 */
export const dynamic = 'force-dynamic';

/** Hard ceiling. The client targets 80KB; this only stops an abusive caller. */
const MAX_BYTES = 400 * 1024;

/** The only types we will store — and, later, serve back on our own origin. */
const ALLOWED_MIMES = new Set(['image/webp', 'image/jpeg', 'image/png']);

/** data: URI shape — `data:<mime>;base64,<payload>`. */
const DATA_URI_RE = /^data:([^;,]*)(;[^,]*)?,([\s\S]*)$/;

/**
 * Sniff the real type from the leading bytes. The declared mime is attacker-
 * controlled; these magic numbers are not. Anything that isn't genuinely a
 * JPEG/PNG/WebP is refused, so the public GET route can never be talked into
 * serving markup or a script from the app's own origin.
 */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf.length >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Parse a `data:<mime>;base64,<payload>` URI into a Buffer. */
function parseDataUri(uri: string): Buffer | null {
  const m = uri.match(DATA_URI_RE);
  if (!m) return null;
  const meta = m[2] || '';
  const payload = m[3] || '';
  try {
    return /;base64/i.test(meta)
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch { return null; }
}

const clampDim = (v: unknown) => Math.max(0, Math.min(10000, Math.floor(Number(v) || 0)));

/**
 * THIS ROUTE DELETES NOTHING. It used to: every successful upload also ran a
 * sweep that deleted any blob whose canonical URL was not found, verbatim, in
 * menu_items.image_url. Against a copy of the live database that destroyed
 * three of four photos whose menu items were pointing at them through spellings
 * that load perfectly in a browser — an absolute URL, a `?v=2` suffix, stray
 * spaces. The guest photo disappeared days later and there was no undo.
 *
 * Reclaiming space is now an explicit admin action with a dry-run preview
 * (GET/POST ./orphans, backed by src/lib/menu-image-store.ts), and the
 * reference test there resolves every spelling through the same parser the
 * serving route uses. Uploading is a pure insert again: an ordinary upload can
 * no longer cost anybody an image.
 */
export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    let buf: Buffer | null = null;
    let itemId = '';
    let width = 0;
    let height = 0;

    const ctype = (request.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('multipart/form-data')) {
      const form = await request.formData();
      const entry = form.get('file') as unknown;
      if (entry && typeof entry === 'object' && 'arrayBuffer' in (entry as any)) {
        buf = Buffer.from(await (entry as File).arrayBuffer());
      } else if (typeof entry === 'string' && entry.startsWith('data:')) {
        buf = parseDataUri(entry);
      }
      itemId = String(form.get('item_id') || '');
      width = clampDim(form.get('width'));
      height = clampDim(form.get('height'));
    } else {
      const body = await request.json().catch(() => null) as any;
      const raw = body?.data;
      if (typeof raw === 'string' && raw.startsWith('data:')) buf = parseDataUri(raw);
      itemId = String(body?.item_id || '');
      width = clampDim(body?.width);
      height = clampDim(body?.height);
    }

    if (!buf || buf.length === 0) {
      return Response.json({ error: 'No image received.' }, { status: 400 });
    }
    if (buf.length > MAX_BYTES) {
      return Response.json(
        { error: `Image too large (${Math.round(buf.length / 1024)} KB). Max ${MAX_BYTES / 1024} KB.` },
        { status: 413 },
      );
    }

    // The sniffed type wins over anything the caller declared.
    const mime = sniffImageMime(buf);
    if (!mime || !ALLOWED_MIMES.has(mime)) {
      return Response.json(
        { error: 'That file is not a JPG, PNG or WebP image. (SVG is not allowed.)' },
        { status: 415 },
      );
    }

    const db = getDb();
    const id = generateId();
    db.prepare(`
      INSERT INTO menu_item_images (id, item_id, mime, width, height, size, data, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(id, itemId || null, mime, width, height, buf.length, buf, me.email || me.name || '');

    return Response.json({
      id,
      // Minted by the shared parser's own speller, so the string this hands back
      // is by construction one the reference test recognises.
      url: menuImageUrl(id),
      mime,
      width,
      height,
      size: buf.length,
    });
  } catch (e: any) {
    console.error('POST /api/menu-items/image failed:', e);
    return Response.json({ error: e?.message || 'Upload failed' }, { status: 500 });
  }
}
