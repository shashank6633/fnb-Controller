/**
 * THE ONE PLACE THAT DECIDES WHICH BLOB A STORED IMAGE URL POINTS AT.
 *
 * `menu_items.image_url` is a plain TEXT column. An uploaded dish photo puts
 * the string '/api/customer/menu-image/<id>' in it; a pasted external URL puts
 * that URL in it. Nothing validates or rewrites the column, so the SAME blob is
 * reachable through several spellings that all load perfectly in a browser:
 *
 *     /api/customer/menu-image/abc            canonical
 *     http://host:3711/api/customer/menu-image/abc   absolute (copied from the address bar)
 *     ' /api/customer/menu-image/abc '        stray whitespace (HTML trims src)
 *     /api/customer/menu-image/abc?v=2        cache-buster suffix
 *     /api/customer/menu-image/abc#x          fragment (never sent to the server)
 *
 * Two different pieces of code have to agree about that mapping:
 *
 *   · the SERVING route (GET /api/customer/menu-image/[id]) turns a REQUEST into
 *     a row — it is what makes a spelling "work";
 *   · the ORPHAN SWEEP (src/lib/menu-image-store.ts) turns STORED TEXT into the
 *     set of blobs that are still in use — it is what decides what to delete.
 *
 * When those two disagreed, the sweep deleted blobs that live menu items were
 * still showing. It compared the canonical string exactly, so an absolute /
 * space-padded / ?v=-suffixed image_url matched nothing and its photo was
 * destroyed — silently, with no undo, while the page kept working until the
 * next cache miss. Both sides now come through this file, so they cannot drift
 * apart again: the blob ID is the identity, the URL is only one way of spelling
 * it.
 *
 * PURE ON PURPOSE — no imports, no db, no next/*. The client bundle, the route
 * handlers and the plain-node test harness all pull from the same copy.
 */

/** The path the serving route lives at. Also the marker we look for in text. */
export const MENU_IMAGE_PATH = '/api/customer/menu-image/';

/** Mint the canonical URL for a blob id. The upload route's only speller. */
export function menuImageUrl(id: string): string {
  return `${MENU_IMAGE_PATH}${encodeURIComponent(id)}`;
}

/**
 * Normalise a blob id that arrived as a ROUTE PARAM — i.e. the App Router has
 * already percent-decoded it for us. Trim only; do NOT decode again, or a row
 * whose id legitimately contains a '%' would be looked up under a different
 * string than the one that was stored.
 *
 * This is the shared tail. Whatever this returns for a request is exactly what
 * `menuImageIdFromUrl` returns for the text that produced that request.
 */
export function menuImageIdFromParam(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Resolve a STORED image_url string to the blob id it actually serves, or null
 * if it is not one of ours (empty, a pasted external URL, a data: URI…).
 *
 * It reproduces, step for step, what happens between the column and the row:
 *   1. HTML trims leading/trailing whitespace in a `src` attribute;
 *   2. the fragment is never sent to a server;
 *   3. the query string is not part of the path the router matches;
 *   4. an absolute URL to any host resolves to the same path on ours (the app
 *      is reached by several names — localhost, a LAN IP, the Lightsail host —
 *      so the host is NOT evidence about which blob is meant, and refusing an
 *      unfamiliar host would only put a live photo back on the deletion list);
 *   5. the router percent-decodes the segment;
 *   6. then `menuImageIdFromParam` runs, exactly as in the serving route.
 *
 * A prefix before the marker is tolerated (a reverse proxy or basePath could
 * add one) and anything after the id's own segment disqualifies the match —
 * '/api/customer/menu-image/abc/extra' is not a request the serving route can
 * answer, so it must not be read as a reference to 'abc'.
 *
 * DELIBERATELY LENIENT. Every judgement call here is made in the direction of
 * "yes, that counts as a reference", because the cost of a false positive is
 * one 80 KB row kept alive and the cost of a false negative is a guest photo
 * deleted forever.
 */
export function menuImageIdFromUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (!s) return null;

  // 2 + 3 — strip fragment, then query. (Fragment first: '#a?b' has no query.)
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);

  // 3½ — collapse runs of '/' the way the router does. A double-slashed
  // spelling ('/api/customer//menu-image/abc', or '…menu-image//abc') LOADS in
  // a browser: Next.js answers it with a 308 to the single-slash path and the
  // image then serves — proven by execution against the dev server. So it is a
  // live reference and must resolve to the same id the redirect target serves.
  // ('http://host/…' becomes 'http:/host/…', which is harmless — the marker
  // search below never cared what sits before the path.)
  s = s.replace(/\/\/+/g, '/');

  const at = s.indexOf(MENU_IMAGE_PATH);
  if (at < 0) return null;

  // 4 — whatever sits before the marker (scheme + host, a proxy prefix, or
  // nothing at all) has already been shown not to change which row is served.
  const segment = s.slice(at + MENU_IMAGE_PATH.length);
  if (!segment || segment.includes('/')) return null;

  // 5 — the router decodes the segment. Malformed escapes are kept verbatim
  // rather than thrown away: an id we cannot decode is still an id we must not
  // delete.
  let decoded = segment;
  try { decoded = decodeURIComponent(segment); } catch { /* keep raw */ }

  // 6 — same tail the serving route uses.
  const id = menuImageIdFromParam(decoded);
  return id || null;
}

/**
 * Every blob id mentioned anywhere in a blob of arbitrary text.
 *
 * `menuImageIdFromUrl` answers "what does THIS column value serve", which is
 * the right question for a column that holds one URL. This answers the wider
 * question — "does this text mention one of our images at all" — and is what
 * lets the sweep scan a JSON payload, a rich-text note or a CSV cell without
 * knowing its shape. Both are needed: the first understands an absolute URL
 * with no marker-adjacent context, the second finds ids the first would miss
 * because the value is not a bare URL.
 *
 * Terminates the id at the first character that cannot appear in a path
 * segment, so '"…/menu-image/abc","next"' yields 'abc'.
 */
export function menuImageIdsInText(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  const out: string[] = [];
  scanTextForIds(text, out);
  // Scan a slash-collapsed copy AS WELL — never instead. A double-slashed
  // spelling ('/api/customer//menu-image/abc') loads in a browser (the router
  // 308s it to the single-slash path, which serves), so it is a live reference,
  // but the raw pass cannot see its marker. The collapsed pass can. It must not
  // REPLACE the raw pass, because collapsing can fuse two adjacent URLs into a
  // shape the scanner walks differently; running both and unioning means every
  // id either pass finds is kept, and an extra id only ever KEEPS a row.
  const collapsed = text.replace(/\/\/+/g, '/');
  if (collapsed !== text) scanTextForIds(collapsed, out);
  return out.filter(Boolean);
}

/** The single-pass scanner behind menuImageIdsInText — see there. */
function scanTextForIds(text: string, out: string[]): void {
  if (!text.includes(MENU_IMAGE_PATH)) return;
  let from = 0;
  for (;;) {
    const at = text.indexOf(MENU_IMAGE_PATH, from);
    if (at < 0) break;
    const start = at + MENU_IMAGE_PATH.length;
    let end = start;
    while (end < text.length && !'/?#"\'<>\\ \t\r\n,;)]}'.includes(text[end])) end++;
    const raw = text.slice(start, end);
    if (raw) {
      let decoded = raw;
      try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }
      // Both spellings count. If the text was itself escaped once more than we
      // expect, the raw form is the one that matches the stored id.
      out.push(menuImageIdFromParam(decoded));
      if (decoded !== raw) out.push(menuImageIdFromParam(raw));
    }
    from = end > at ? end : at + MENU_IMAGE_PATH.length;
  }
}
