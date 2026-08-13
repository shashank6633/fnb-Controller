/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { importBatch, ImportError } from '@/lib/reservego-import';

/**
 * One slice of a Reservego upload — POST /api/crm/reservations/import/batch.
 *
 *   { import_id, rows: ReservegoRow[], row_offset? }
 *     → { import_id, import: <running counters>, batch: <what this slice did> }
 *
 * `rows` are the raw CSV objects exactly as papaparse produced them, headers as
 * keys. Nothing is interpreted here: the engine maps them with reservego.ts and
 * writes ct_guests + ct_bookings inside one transaction, so a slice either
 * lands whole or not at all and can simply be re-posted after a dropped
 * connection — the reservego_key upsert makes the retry a no-op on whatever
 * already landed.
 *
 * `row_offset` (optional) is the index of rows[0] within the file, so a
 * rejected row can be quoted back with its real line number. Left out, the
 * engine uses the count already processed, which is right for a sequential
 * upload.
 *
 * A row that cannot be mapped is REPORTED, never fatal: one bad row in 106,000
 * must not cost the other 105,999.
 *
 * ADMIN ONLY (owner's decision) — this is the route that actually writes. It
 * takes an import_id and a slab of rows, so gating only import/start would
 * leave the write door open to anyone who could read an id off the wire. See
 * the full reasoning in ../start/route.ts.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The UI posts 2,000 at a time. The ceiling is a guard against a client that
 * tries to stream the whole 106k file back into one body — the exact shape of
 * request this batching exists to avoid.
 */
const MAX_ROWS_PER_BATCH = 20_000;

export async function POST(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }

  const importId = String(body?.import_id ?? '').trim();
  if (!importId) return Response.json({ error: 'import_id is required' }, { status: 400 });

  const rows = body?.rows;
  if (!Array.isArray(rows)) return Response.json({ error: 'rows must be an array' }, { status: 400 });
  if (rows.length > MAX_ROWS_PER_BATCH) {
    return Response.json(
      { error: `Too many rows in one batch (${rows.length}); post at most ${MAX_ROWS_PER_BATCH}` },
      { status: 413 },
    );
  }

  const rawOffset = Number(body?.row_offset);
  const rowOffset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : undefined;

  try {
    const { summary, batch } = importBatch(getDb(), importId, rows, rowOffset);
    return Response.json({ import_id: summary.id, import: summary, batch });
  } catch (e: any) {
    if (e instanceof ImportError) return Response.json({ error: e.message }, { status: e.status });
    console.error('POST /api/crm/reservations/import/batch failed:', e);
    return Response.json({ error: e?.message || 'Batch import failed' }, { status: 500 });
  }
}
