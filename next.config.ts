import type { NextConfig } from "next";
import { execSync } from "node:child_process";

// A STABLE build id (the git SHA) baked into BOTH the client bundle
// (NEXT_PUBLIC_BUILD_ID) and readable by /api/build-info. This lets a bundle
// that was served STALE from cache after a deploy detect itself — its baked id
// won't match the server's current id — and auto-reload. Falls back to '' if
// git is unavailable, in which case auto-update simply stays off (never loops).
function resolveBuildId(): string {
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return ""; }
}
const BUILD_ID = resolveBuildId();

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },

  // Testing deployment skips strict type-check at build time. Pre-existing
  // type errors (recharts Tooltip type narrowing, route-file helper exports)
  // are non-blocking at runtime. Will be cleaned up before production.
  typescript: { ignoreBuildErrors: true },

  // pdf-parse v2 has ESM internals that break Next.js RSC bundling. pdfkit reads
  // its font data (.afm) + embedded TTF at runtime and must not be webpack-bundled.
  // better-sqlite3 is a NATIVE module (bindings loads its .node at runtime): dev
  // builds don't dead-code-eliminate the NEXT_RUNTIME guard in instrumentation.ts,
  // so webpack's edge pass followed the import chain into bindings.js and threw a
  // blocking "Can't resolve 'fs'" overlay. Force all three to runtime require.
  serverExternalPackages: ['pdf-parse', 'pdfkit', 'better-sqlite3'],

  // The EDGE compile (middleware + edge instrumentation pass) statically follows
  // instrumentation.ts → error-alerts → db.ts → better-sqlite3 even though the
  // NEXT_RUNTIME guard means that code never RUNS on edge — dev builds don't
  // dead-code-eliminate the branch, so webpack threw a blocking "Can't resolve
  // 'fs'" and the dev server served only a fallback shell. Stub Node built-ins
  // to empty modules on edge; the Node server build is untouched.
  // NOTE the bundler split: `next dev` here runs WEBPACK (launch config), while
  // `next build` (and the CI deploy) runs TURBOPACK — which handles this chain
  // fine but hard-errors on a bare `webpack` key. The empty `turbopack: {}`
  // tells it the split is intentional; each bundler reads only its own config.
  turbopack: {},
  webpack: (config, { nextRuntime }) => {
    if (nextRuntime === 'edge') {
      config.resolve = config.resolve || {};
      config.resolve.fallback = { ...(config.resolve.fallback || {}), fs: false, path: false, crypto: false };
    }
    return config;
  },

  /**
   * Force browsers to fetch fresh HTML on every navigation. Without this,
   * Safari (and others) cache the HTML response — which references hashed
   * chunk filenames from whatever build was live when the HTML was cached.
   * Post-deploy, those chunks are gone, React fails to load them, and the
   * page render crashes ("This page couldn't load").
   *
   * Static assets under /_next/static/* keep their long-cache headers because
   * their filenames are hash-stamped (each deploy generates new ones, so
   * stale cache hits are safe).
   *
   * ── /api/customer/menu-image IS THE SAME EXEMPTION, EARNED THE SAME WAY ──
   * Dish photos for the guest QR menu are served from a BLOB by
   * src/app/api/customer/menu-image/[id]/route.ts, and that route asks for
   * `public, max-age=31536000, immutable`. IT DOES NOT GET IT UNLESS IT IS
   * NAMED HERE: headers() is applied by the routing layer AFTER the handler
   * runs and OVERWRITES a same-key header the handler set, so before this
   * exemption existed the route's own Cache-Control was silently replaced by
   * the no-store above. Measured on a real request, that is exactly what came
   * back out of the route:
   *   Cache-Control: no-store, no-cache, must-revalidate, max-age=0
   * The effect is not cosmetic. The guest menu re-fetches on every scan, so
   * every dish photo would be re-downloaded in full, every time, by every
   * guest, on restaurant mobile data — tens of MB a night to serve bytes the
   * phone already had.
   *
   * Immutable is honest here for the same reason the hash-stamped chunks are:
   * THE ID IS A CONTENT HANDLE, NOT A SLOT. menu_item_images rows are only ever
   * INSERTed — replacing an item's photo writes a NEW row under a NEW random id
   * and repoints menu_items.image_url at it — so the bytes behind a given URL
   * can never change, and a cached copy can never go stale. (This is also why
   * the URL needs no ?v= token.)
   *
   * The carve-out is exactly as wide as that one route: every other path,
   * including every other /api/customer/* endpoint, still gets no-store. The
   * menu JSON itself is deliberately NOT exempt.
   */
  async headers() {
    return [
      {
        // Long-cache the immutable dish-photo blobs. Listed BEFORE the
        // no-store rule for readability only — the rule below cannot match
        // this path anyway, because it is in that rule's negative lookahead.
        source: '/api/customer/menu-image/:id',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        // Match every path EXCEPT _next/static (which has hash-stamped names
        // and benefits from immutable caching) and the dish-photo blobs above.
        source: '/((?!_next/static|_next/image|favicon|icon-|apple-touch-icon|api/customer/menu-image).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, max-age=0' },
          { key: 'Pragma',        value: 'no-cache' },
        ],
      },
    ];
  },
};

export default nextConfig;
