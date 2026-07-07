import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { ProductionBatch } from '@/lib/production-batch';
import { buildTSPL, readLabelPrinter } from '@/lib/tspl-label';

/**
 * POST /api/kitchen-production/print-bulk
 *   body: { ids: string[], qr?: boolean }
 *
 * Builds one TSPL2 label per batch, logs a 'printed' transaction for each, and
 * returns { jobs: [{ id, batch_number, tspl }], printer } so the BROWSER can
 * forward each job's `tspl` to the local print bridge.
 */
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body?.ids) ? body.ids.map((x: any) => String(x)).filter(Boolean) : [];
    if (!ids.length) return Response.json({ error: 'ids is required' }, { status: 400 });

    const db = getDb();
    const printer = readLabelPrinter(db);
    // Per-request `qr` wins; otherwise fall back to the saved printer default.
    const qr = body?.qr !== undefined ? !!body.qr : !!printer.qr;
    const copies = Math.max(1, Math.round(Number(printer.copies) || 1));

    const user = me.name || me.email || '';
    const department = me.department_id || '';

    const jobs: Array<{ id: string; batch_number: string; tspl: string }> = [];

    const run = db.transaction(() => {
      for (const id of ids) {
        const batch = db.prepare('SELECT * FROM production_batches WHERE id = ?').get(id) as ProductionBatch | undefined;
        if (!batch) continue;

        const tspl = buildTSPL(batch, {
          copies,
          qr,
          labelWidthMm: printer.label_width_mm,
          labelHeightMm: printer.label_height_mm,
        });

        const remaining = Math.max(0, (batch.quantity_produced || 0) - (batch.quantity_consumed || 0));
        db.prepare(
          `INSERT INTO batch_transactions (
             id, batch_id, outlet_id, type, quantity, balance_quantity, user, department, remarks
           ) VALUES (?,?,?,?,?,?,?,?,?)`
        ).run(
          generateId(),
          batch.id,
          batch.outlet_id,
          'printed',
          0,
          remaining,
          user,
          department,
          `bulk ${copies} label${copies === 1 ? '' : 's'}${qr ? ' +QR' : ''}`,
        );

        jobs.push({ id: batch.id, batch_number: batch.batch_number, tspl });
      }
    });
    run();

    if (!jobs.length) return Response.json({ error: 'No matching batches found' }, { status: 404 });

    return Response.json({ jobs, printer });
  } catch (e: any) {
    console.error('POST /api/kitchen-production/print-bulk failed:', e);
    return Response.json({ error: e?.message || 'Failed to build labels' }, { status: 500 });
  }
}
