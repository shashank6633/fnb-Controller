/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { startImport } from '@/lib/reservego-import';

/**
 * Open a Reservego import session — POST /api/crm/reservations/import/start.
 *
 *   { file_name, rows_total, source_exported_at? }  →  { import_id, import }
 *
 * WHY A SESSION AND NOT AN UPLOAD. The owner's file is ~106,000 rows / ~30MB.
 * A single request carrying that would be refused long before SQLite saw it
 * (measured: 106k upserts take 1.1s — the wire is the problem, not the write).
 * So the browser parses the CSV with papaparse and posts batches of 2,000 rows
 * against the id returned here. That also gives the upload a progress bar and
 * lets a dropped connection resume instead of starting over.
 *
 * rows_total comes from the browser's parse and is only the denominator of that
 * progress bar; the counters that matter are accumulated by import/batch.
 *
 * ── source_exported_at: THE SECOND RUNG OF THE STAMP LADDER ───────────────
 * Optional, and only ever used when the file NAME carries no Reservego export
 * stamp (it does on 129 of the owner's 129 real exports). The browser already
 * reads the whole file once to count rows before this route is called, so it
 * sends the largest Booking Time it saw — an export is at least as new as the
 * newest booking in it, which is enough to order a set of renamed files.
 *
 * It is a HINT about the caller's own file, not a privilege: startImport reads
 * the file name first and ignores this whenever the name parses, the value is
 * re-parsed there through normalizeExportStamp (anything unreadable becomes
 * "undated" rather than year zero), and the route is admin-only in any case.
 * Its only effect is on which of the admin's own uploads wins a collision.
 *
 * ── WHY ADMIN, NOT MANAGEMENT ─────────────────────────────────────────────
 * Owner's decision, and the shape of the data forces it: one upload of the
 * owner's ~129 Reservego exports rewrites 82,088 bookings across 70,297 guests
 * — the entire customer master, in a single POST. Every route in this family
 * is admin-only, matching the adminOnly catalog entry on /crm-calls/database. requireRole('admin') is the
 * existing gate every other destructive route in this app uses; it answers 401
 * signed-out and 403 'Admin role required' to a manager or an HOD. The same
 * gate is on import/batch, import/finish and the CSV export — a gate on start
 * alone would be theatre, since batch takes an import_id and nothing else.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
  const me = gate.user;

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }

  const fileName = String(body?.file_name ?? '').trim().slice(0, 300);
  if (!fileName) return Response.json({ error: 'file_name is required' }, { status: 400 });

  const rowsTotal = Number(body?.rows_total);
  if (!Number.isFinite(rowsTotal) || rowsTotal < 0) {
    return Response.json({ error: 'rows_total must be a non-negative number' }, { status: 400 });
  }

  // Length-capped only; the shape is validated by normalizeExportStamp inside
  // startImport, which returns '' for anything it cannot read.
  const sourceExportedAt = String(body?.source_exported_at ?? '').trim().slice(0, 40);

  try {
    const row = startImport(getDb(), {
      fileName,
      rowsTotal,
      importedBy: me.email || me.name || '',
      sourceExportedAt,
    });
    return Response.json({ import_id: row.id, import: row });
  } catch (e: any) {
    console.error('POST /api/crm/reservations/import/start failed:', e);
    return Response.json({ error: e?.message || 'Could not start the import' }, { status: 500 });
  }
}
