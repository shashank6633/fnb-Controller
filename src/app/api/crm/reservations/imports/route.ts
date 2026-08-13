/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Reservation CRM — IMPORT HISTORY (/crm-calls/database → Import History).
 *
 * GET /api/crm/reservations/imports?limit=&offset=      → { rows, total, limit, offset }
 * GET /api/crm/reservations/imports?id=<import_id>      → { row }
 *
 * One row per upload session, newest first: what was uploaded, how far it got,
 * and the counters that have to add up —
 *   rows_total = rows_processed + failed_rows (once finished), and
 *   rows_processed = new_bookings + updated_bookings + duplicate_rows + collapsed_rows.
 * Collapsed same-day duplicates are REPORTED here rather than silently dropped,
 * which is the whole reason this table exists: nobody should have to wonder
 * where 300 rows of a 106,000-row file went.
 *
 * Also the progress feed for a running import — a 106,000-row upload arrives as
 * ~53 batches of 2,000, and `status = 'running'` with a rising rows_processed
 * is what the page's progress bar reads. Hence force-dynamic and no-store: a
 * cached response here would freeze the bar.
 *
 * ── WHY errors_json IS NOT RETURNED WHOLE IN THE LIST ─────────────────────
 * A bad file can fail thousands of rows, and errors_json holds one entry each.
 * Returning twenty-five of those blobs in one list response would ship several
 * megabytes to render a table of dates and counts. The list therefore carries a
 * capped `errors` preview plus the honest `errors_total`; `?id=` returns the
 * full list for the one import the user actually opened.
 *
 * ── WHO MAY READ THIS ─────────────────────────────────────────────────────
 * ADMIN ONLY, matching the adminOnly catalog entry on /crm-calls/database, as
 * is every other route in this family (owner's instruction, 2026-08-13). errors_json quotes rejected CSV rows verbatim, so
 * this list carries guest names and numbers too — it is not a neutral log.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
/** Enough to see the shape of a failure without shipping the whole log. */
const ERROR_PREVIEW = 20;
/** A non-JSON errors_json is still shown, but never unbounded. */
const RAW_ERROR_CAP = 2000;

function shapeImport(row: any, full: boolean) {
  const { errors_json, ...rest } = row;
  const raw = String(errors_json ?? '').trim();
  if (!raw) return { ...rest, errors: [], errors_total: 0 };

  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { /* handled below */ }
  if (!Array.isArray(parsed)) {
    // Not the array shape this route expects. Surfaced verbatim (truncated)
    // rather than swallowed — an import whose errors vanish from the UI is how
    // a broken file gets re-uploaded three times.
    return { ...rest, errors: [], errors_total: 0, errors_raw: raw.slice(0, RAW_ERROR_CAP) };
  }
  return {
    ...rest,
    errors: full ? parsed : parsed.slice(0, ERROR_PREVIEW),
    errors_total: parsed.length,
  };
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  // ADMIN ONLY, the whole Reservations Database — owner's decision 2026-08-13,
  // tightened from management. The page holds every guest's phone, email and
  // lifetime spend for ~70,000 people; reading it is the same exposure as
  // exporting it, so the read gate matches the export gate rather than sitting
  // one tier below it.
  if (me.role !== 'admin') return Response.json({ error: 'Admin access required' }, { status: 403 });

  try {
    const db = getDb();
    const sp = new URL(request.url).searchParams;

    const id = (sp.get('id') || '').trim();
    if (id) {
      const row = db.prepare(`SELECT * FROM reservation_imports WHERE id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'Import not found' }, { status: 404 });
      return Response.json({ row: shapeImport(row, true) }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(sp.get('limit') || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
    const offset = Math.max(0, parseInt(sp.get('offset') || '0', 10) || 0);

    const total = (db.prepare(`SELECT COUNT(*) AS n FROM reservation_imports`).get() as any)?.n ?? 0;
    // started_at first because that is the order the user thinks in; created_at
    // and id break the tie so two imports started in the same second (a retry
    // straight after a failure) keep a stable order across pages.
    const rows = (db.prepare(`
      SELECT * FROM reservation_imports
      ORDER BY started_at DESC, created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as any[]).map((r) => shapeImport(r, false));

    return Response.json(
      { rows, total, limit, offset },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('[GET /api/crm/reservations/imports]', e);
    return Response.json({ error: e?.message || 'Failed to load import history' }, { status: 500 });
  }
}
