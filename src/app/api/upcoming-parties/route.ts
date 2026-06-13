import { readSheet, getAuthDiagnostics } from '@/lib/sheets-client';
import { mapRowToUpcomingParty, UpcomingParty } from '@/lib/fp-records-mapper';
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { startSchedulerOnce } from '@/lib/scheduler';

// Boot the in-process scheduler on first import. Idempotent — guarded with globalThis flag.
startSchedulerOnce();

/**
 * Upcoming Parties — read from the AKAN Party Manager Google Sheet
 * ("F&P Records" tab) and return events the kitchen/bar/ops teams should
 * know about today + the next 30 days. Auto-tags rows that already have a
 * matching party requisition in our DB (so the UI shows "✓ Linked").
 *
 * GET  /api/upcoming-parties              → fetches live from Sheets,
 *                                            returns parsed + linked status
 * GET  /api/upcoming-parties?stale=1      → returns last cached snapshot
 *                                            (fast, no Sheets call)
 * POST /api/upcoming-parties              → force-refresh cache + return live
 *
 * Auth source: Application Default Credentials. Works on VM via the
 * metadata server (cloud-platform scope on the attached SA). Local Mac
 * dev may fail if org policy blocks the gcloud OAuth client — in that
 * case, deploy + test on the VM.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SHEET_ID = '1VYpxSOjcHHRPkBb7f7s1bfBFcl-M25PnxkjpEdXFbJI';
const TAB_NAME = 'F&P Records';
const RANGE    = `${TAB_NAME}!A2:BO`;   // skip header, fetch through column BO (67th col)

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const url = new URL(request.url);
    const useStale = url.searchParams.get('stale') === '1';

    if (useStale) return Response.json(readCache());

    return Response.json(await fetchLiveAndCache());
  } catch (e: any) {
    console.error('[upcoming-parties GET]', e);
    // Diagnose WHICH identity the app tried to authenticate as — the operator
    // must share the sheet with exactly this email. On AWS this is the JSON-key
    // SA; on GCP it's the metadata SA. Surfacing it makes the fix unambiguous.
    const diag = await getAuthDiagnostics().catch(() => null);
    // On auth failure, fall back to last cached snapshot if we have one
    const cached = readCache();
    if (cached.parties.length > 0) {
      return Response.json({
        ...cached,
        warning: `Live fetch failed (${e.message || 'unknown'}). Showing cached snapshot.`,
        auth: diag,
      });
    }
    return Response.json({
      error: e.message || 'Failed to fetch sheet',
      auth: diag,
    }, { status: 500 });
  }
}

export async function POST() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    return Response.json(await fetchLiveAndCache());
  } catch (e: any) {
    console.error('[upcoming-parties POST]', e);
    return Response.json({ error: e.message || 'Sheet refresh failed' }, { status: 500 });
  }
}

// ──────────────────────────── Helpers ────────────────────────────

async function fetchLiveAndCache(): Promise<{
  parties: (UpcomingParty & { linked: boolean; linked_req_count: number })[];
  fetched_at: string;
  source: 'live' | 'cache';
}> {
  const rows = await readSheet(SHEET_ID, RANGE);
  const parties = rows
    .map(mapRowToUpcomingParty)
    .filter((p): p is UpcomingParty => p !== null);

  // Annotate each row with whether a party requisition already exists for it
  const db = getDb();
  const reqLookup = db.prepare(`
    SELECT event_name, event_date, COUNT(*) AS n
    FROM requisitions
    WHERE purpose = 'party'
    GROUP BY event_name, event_date
  `).all() as { event_name: string; event_date: string; n: number }[];
  const linkedKey = new Set(reqLookup.map(r => keyFor(r.event_name, r.event_date)));
  const linkedCount = new Map<string, number>();
  for (const r of reqLookup) linkedCount.set(keyFor(r.event_name, r.event_date), r.n);

  const annotated = parties.map(p => {
    const candidateNames = [p.guest_name, p.company, p.contact_person, p.fp_id].filter(Boolean) as string[];
    let linked = false;
    let linked_req_count = 0;
    for (const name of candidateNames) {
      const k = keyFor(name, p.date_of_event);
      if (linkedKey.has(k)) { linked = true; linked_req_count = linkedCount.get(k) || 0; break; }
    }
    return { ...p, linked, linked_req_count };
  });

  const payload = {
    parties: annotated,
    fetched_at: new Date().toISOString(),
    source: 'live' as const,
  };
  writeCache(payload);
  return payload;
}

function keyFor(name: string | undefined, date: string | undefined): string {
  return `${(name || '').trim().toLowerCase()}|${date || ''}`;
}

// ──────────────────────── Tiny disk cache ────────────────────────
// Stored in the `settings` table so the cache survives restarts. Single
// row keyed by 'upcoming_parties_cache'. Falls back to empty on error.

function readCache(): {
  parties: (UpcomingParty & { linked: boolean; linked_req_count: number })[];
  fetched_at: string;
  source: 'live' | 'cache';
} {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'upcoming_parties_cache'`).get() as { value: string } | undefined;
    if (!row) return { parties: [], fetched_at: '', source: 'cache' };
    const parsed = JSON.parse(row.value);
    return { ...parsed, source: 'cache' };
  } catch {
    return { parties: [], fetched_at: '', source: 'cache' };
  }
}

function writeCache(payload: unknown): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO settings (key, value)
      VALUES ('upcoming_parties_cache', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(payload));
  } catch (e: any) {
    console.warn('[upcoming-parties] cache write failed:', e?.message);
  }
}
