import fs from 'fs';
import path from 'path';
import { getCurrentUser } from '@/lib/auth';

/**
 * The bridge version this server SHIPS, read out of the very file that
 * /print-bridge.mjs serves (public/print-bridge.mjs, Cache-Control: no-store).
 * Parsing the file instead of hard-coding a number here is the point: the
 * offline-print page's "your counter PC is behind" nudge previously named a
 * fixed v2.6 and went stale the moment the bridge moved on, so counters sat on
 * 2.7.x while 2.8.0 was needed for the DUPLICATE BILL stamp with the page
 * saying nothing. Whatever is deployed is what the page compares against.
 */
export const dynamic = 'force-dynamic';

// Cache the ANSWER, never the FAILURE. The file can only change on a deploy and
// a deploy starts a new process, so one successful read is good for the life of
// the process. A failure is different in kind: a transient EMFILE under load, or
// a read that lands mid-deploy while the tree is being swapped, would otherwise
// be remembered forever and this endpoint would return null until someone
// restarted pm2 — silently disabling the update nudge on every counter with no
// symptom to notice. Retrying costs one small read.
let shippedVersion: string | undefined;

function readShippedVersion(): string | null {
  if (shippedVersion !== undefined) return shippedVersion;
  try {
    const src = fs.readFileSync(path.join(process.cwd(), 'public', 'print-bridge.mjs'), 'utf8');
    // Matches `const VERSION = '2.8.1';` — the trailing changelog comment on
    // that line is ignored because the capture stops at the closing quote.
    const v = /const VERSION = '([^']+)'/.exec(src)?.[1];
    if (!v) return null;          // parsed but unusable — do not memoise
    shippedVersion = v;
    return v;
  } catch {
    return null;                  // transient — try again on the next request
  }
}

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  // null (not a 500) when public/ isn't on disk next to the server bundle or the
  // constant has been reformatted: an unknown shipped version must make the page
  // stay silent, never call an up-to-date counter out of date.
  return Response.json({ version: readShippedVersion() });
}
