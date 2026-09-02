/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { menuImageIdFromParam } from '@/lib/menu-image-url';

/**
 * Serve a dish photo (GET /api/customer/menu-image/:id).
 *
 * PUBLIC — and it has to be. The guest who scans the QR standee has no staff
 * session, so an <img> on the customer menu must load without one. It sits
 * under /api/customer/ precisely so it inherits the existing public bypass in
 * src/proxy.ts (`pathname.startsWith('/api/customer/')`) alongside the other
 * guest-facing routes; no proxy edit was needed to make it reachable, and
 * nothing outside that guest prefix was opened up.
 *
 * What is exposed is a dish photograph that the restaurant is already showing
 * to anyone who walks in and scans a table — there is nothing here to keep
 * private, and the id is a random generateId() rather than a guessable counter.
 *
 * Immutability is the caching story. menu_item_images rows are never rewritten:
 * replacing an item's photo inserts a NEW row and repoints image_url at the new
 * id, so a URL's bytes can never change and this can be cached hard with no
 * version token. `public` (not `private`) so shared/CDN caches can hold one copy
 * for every guest in the room.
 */
export const dynamic = 'force-dynamic';

/** Only ever hand back these three. Anything else in the row is a bug upstream. */
const SERVEABLE = new Set(['image/webp', 'image/jpeg', 'image/png']);

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // menuImageIdFromParam is the shared tail of src/lib/menu-image-url.ts: the
    // orphan sweep resolves a STORED image_url down to the very same function,
    // so "this URL still serves a photo" and "this blob is still referenced"
    // are one question with one answer. They disagreed once, and three live
    // photos were deleted for it.
    const id = menuImageIdFromParam((await params).id);
    const row = getDb()
      .prepare(`SELECT mime, data, size FROM menu_item_images WHERE id = ?`)
      .get(id) as { mime: string; data: Buffer; size: number } | undefined;

    if (!row || !row.data) {
      return Response.json({ error: 'Image not found' }, { status: 404 });
    }

    // better-sqlite3 hands back a Node Buffer for a BLOB column; copy into a
    // fresh Uint8Array so the Web Response body gets a clean ArrayBuffer view.
    const bytes = Uint8Array.from(row.data);

    // Allow-list the Content-Type rather than echoing the stored string. The
    // upload route already sniffs the magic bytes, so this is the second lock:
    // an active type (svg/html/xml) could never have been stored, and if one
    // somehow were, it still could not be served as itself on this origin.
    const stored = (row.mime || '').toLowerCase();
    const mime = SERVEABLE.has(stored) ? stored : 'application/octet-stream';

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(row.size || bytes.byteLength),
        // Deliberately NO Content-Disposition. The task_files sibling sets
        // `attachment` because those blobs are downloads; these are <img>
        // subresources on the guest menu and must render inline.
        'X-Content-Type-Options': 'nosniff',
        // Immutable per id — see the header comment. `public` so a shared cache
        // can serve the whole room from one fetch.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (e: any) {
    console.error('GET /api/customer/menu-image/[id] failed:', e);
    return Response.json({ error: 'Failed to load image' }, { status: 500 });
  }
}
