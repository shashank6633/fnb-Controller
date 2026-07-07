import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { ProductionBatch } from '@/lib/production-batch';
import { buildTSPL, labelPreview, readLabelPrinter } from '@/lib/tspl-label';

/**
 * POST /api/kitchen-production/[id]/print
 *   body: { reprint?: boolean, copies?: number, qr?: boolean }
 *
 * Builds the TSPL2 label for one batch, logs a print transaction, and returns
 *   { tspl, preview, printer }
 * so the BROWSER can forward `tspl` to the local print bridge (localhost:9920).
 * (The batch_transactions row is 'reprinted' when reprint is true, else 'printed'.)
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const { id } = await params;
    const db = getDb();

    const batch = db.prepare('SELECT * FROM production_batches WHERE id = ?').get(id) as ProductionBatch | undefined;
    if (!batch) return Response.json({ error: 'Batch not found' }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const reprint = !!body?.reprint;

    const printer = readLabelPrinter(db);
    // Per-print `qr` wins; otherwise fall back to the saved printer default.
    const qr = body?.qr !== undefined ? !!body.qr : !!printer.qr;
    const copies = Math.max(1, Math.round(Number(body?.copies) || printer.copies || 1));

    const tspl = buildTSPL(batch, {
      copies,
      qr,
      labelWidthMm: printer.label_width_mm,
      labelHeightMm: printer.label_height_mm,
    });
    const preview = labelPreview(batch, {
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
      reprint ? 'reprinted' : 'printed',
      0,
      remaining,
      me.name || me.email || '',
      me.department_id || '',
      `${copies} label${copies === 1 ? '' : 's'}${qr ? ' +QR' : ''}`,
    );

    return Response.json({ tspl, preview, printer });
  } catch (e: any) {
    console.error('POST /api/kitchen-production/[id]/print failed:', e);
    return Response.json({ error: e?.message || 'Failed to build label' }, { status: 500 });
  }
}
