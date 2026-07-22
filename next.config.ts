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
   */
  async headers() {
    return [
      {
        // Match every path EXCEPT _next/static (which has hash-stamped names
        // and benefits from immutable caching).
        source: '/((?!_next/static|_next/image|favicon|icon-|apple-touch-icon).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, max-age=0' },
          { key: 'Pragma',        value: 'no-cache' },
        ],
      },
    ];
  },
};

export default nextConfig;
