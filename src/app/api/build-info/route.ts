/**
 * Returns the current build's unique ID. Used by <BuildVersionWatcher> on
 * the client to detect when a deploy has happened — once detected, the
 * client triggers window.location.reload() so the user's stale JS bundle
 * gets replaced.
 *
 * The "Server Action 'x' not found" error happens precisely because a tab
 * loaded with the old bundle tries to hit Server Action IDs that no longer
 * exist in the new bundle. This endpoint lets us pre-empt that error
 * within one poll cycle of every deploy.
 */
export const dynamic = 'force-dynamic';

// Module-scope constant so every request returns the SAME value for this
// running process. Restart of the service (which happens on every deploy)
// generates a new one.
const PROCESS_BOOT_ID = Math.random().toString(36).slice(2, 10) + '-' + Date.now();

export async function GET() {
  return Response.json({
    // Prefer the STABLE git-SHA build id (the same value the client bundle baked
    // in via NEXT_PUBLIC_BUILD_ID) so an ALREADY-stale client can compare its own
    // baked id against this and know it must reload. PROCESS_BOOT_ID is only a
    // fallback when git wasn't available at build time.
    build_id: process.env.NEXT_PUBLIC_BUILD_ID || process.env.NEXT_BUILD_ID || PROCESS_BOOT_ID,
    started_at: PROCESS_BOOT_ID.split('-')[1],
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
