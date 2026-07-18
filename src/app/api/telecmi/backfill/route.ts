import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { ctSetting, isTelecmiConfigured } from '@/lib/ct/settings';
import { ingestCdr } from '@/lib/ct/ingest';

/**
 * POST /api/telecmi/backfill — admin-only historical CDR pull.
 *
 * Body: { days?: number } (default 7, clamped 1–90).
 * Without TeleCMI creds → { mocked: true, ingested: 0 } (nothing to pull).
 * With creds → page through the TeleCMI CDR list API and run every row through
 * `ingestCdr` — the SAME idempotent path the CDR webhook uses, so re-running a
 * backfill never duplicates calls, and historical missed calls get recovery
 * rows exactly like live ones (the mapper tolerates TeleCMI field variants).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DEFAULT_BASE = 'https://rest.telecmi.com/v2';
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // hard stop: 5,000 CDRs per run

/** ctSetting('telecmi_base_url') may be a base or a full endpoint URL — reduce
 *  it to the API base either way. */
function apiBase(setting: string): string {
  let b = (setting || '').trim().replace(/\/+$/, '');
  if (!b) return DEFAULT_BASE;
  b = b.replace(/\/click_to_call$/i, '').replace(/\/+$/, '');
  return b || DEFAULT_BASE;
}

/** TeleCMI list responses vary by account/region — find the CDR array
 *  tolerantly instead of hardcoding one envelope shape. */
function extractRows(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const k of ['cdr', 'cdrs', 'records', 'data', 'result', 'results', 'rows', 'list']) {
    if (Array.isArray(data[k])) return data[k];
  }
  // Last resort: first non-empty array-of-objects anywhere in the envelope.
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v as any[];
  }
  return [];
}

export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  let body: any = {};
  try { body = await req.json(); } catch { /* optional body */ }
  const days = Math.min(90, Math.max(1, Number(body?.days) || 7));

  if (!isTelecmiConfigured()) {
    return Response.json({ ok: true, mocked: true, ingested: 0, created: 0, days });
  }

  const db = getDb();
  const base = apiBase(ctSetting(db, 'telecmi_base_url'));
  const appidRaw = process.env.TELECMI_APPID || '';
  const credentials = {
    appid: /^\d+$/.test(appidRaw) ? Number(appidRaw) : appidRaw,
    secret: process.env.TELECMI_SECRET || '',
  };
  const to = Date.now();
  const from = to - days * 86_400_000;

  let ingested = 0;
  let created = 0;
  let pagesFetched = 0;
  let fetchError: string | null = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let rows: any[] = [];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let res: Response;
      try {
        res = await fetch(`${base}/cdr`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...credentials, from, to, page, size: PAGE_SIZE, limit: PAGE_SIZE }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) { fetchError = `TeleCMI CDR API responded ${res.status} (page ${page})`; break; }
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch { fetchError = `TeleCMI CDR API returned non-JSON (page ${page})`; break; }
      rows = extractRows(data);
    } catch (e: any) {
      fetchError = e?.name === 'AbortError'
        ? `TeleCMI CDR API timed out (page ${page})`
        : `TeleCMI CDR fetch failed (page ${page}): ${e?.message || e}`;
      break;
    }

    pagesFetched = page;
    if (rows.length === 0) break;
    for (const row of rows) {
      try {
        const r = ingestCdr(row);
        if (r.callId) ingested++;
        if (r.created) created++;
      } catch (e) {
        console.warn('[ct backfill] ingestCdr failed for a row:', e);
      }
    }
    if (rows.length < PAGE_SIZE) break; // short page = last page
  }

  // Total failure (nothing fetched at all) → 502; partial progress → 200 with
  // counts plus the error so the admin knows the run stopped early.
  if (fetchError && pagesFetched === 0) {
    return Response.json({ ok: false, mocked: false, error: fetchError, ingested, created, days }, { status: 502 });
  }
  return Response.json({
    ok: !fetchError,
    mocked: false,
    ingested,
    created,
    pages: pagesFetched,
    days,
    ...(fetchError ? { error: fetchError } : {}),
  });
}
