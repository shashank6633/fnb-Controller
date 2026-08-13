/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { finishImport, ImportError } from '@/lib/reservego-import';

/**
 * Close a Reservego import — POST /api/crm/reservations/import/finish.
 *
 *   { import_id }  →  { import: <the final summary row> }
 *
 * This is where the customer metrics are recomputed: lifetime bookings, arrived
 * visits, arrival rate, spend and visit frequency, for the guests THIS import
 * touched (plus any guest never rolled up, which is what lets a crashed upload
 * be repaired by simply running the file again). They are written onto
 * ct_guests rather than aggregated per page view — a Customers list that summed
 * 106,000 bookings on every keystroke of the search box would be paying for the
 * whole history to show fifty rows.
 *
 * Idempotent: finishing an already-completed session returns it unchanged, so
 * a client that retries after a timeout cannot double-count anything.
 *
 * ADMIN ONLY (owner's decision) — it rewrites the lifetime spend, arrival rate
 * and visit frequency on every guest the import touched, which at the owner's
 * file size is most of the 70,297-row master. See ../start/route.ts.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }

  const importId = String(body?.import_id ?? '').trim();
  if (!importId) return Response.json({ error: 'import_id is required' }, { status: 400 });

  try {
    return Response.json({ import: finishImport(getDb(), importId) });
  } catch (e: any) {
    if (e instanceof ImportError) return Response.json({ error: e.message }, { status: e.status });
    console.error('POST /api/crm/reservations/import/finish failed:', e);
    return Response.json({ error: e?.message || 'Could not finish the import' }, { status: 500 });
  }
}
