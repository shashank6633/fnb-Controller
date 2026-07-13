import { getDb } from '@/lib/db';
import { getCurrentUser, canManageKitchenProduction } from '@/lib/auth';
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
    if (!canManageKitchenProduction(me)) return Response.json({ error: 'Head chef or admin only' }, { status: 403 });

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
      design: printer.design,        // honor the saved Label-design config on the printed label
    });
    const preview = labelPreview(batch, {
      copies,
      qr,
      labelWidthMm: printer.label_width_mm,
      labelHeightMm: printer.label_height_mm,
      design: printer.design,
    });

    // NOTE: we do NOT log a 'printed'/'reprinted' transaction here. This route only
    // BUILDS the label; the physical print happens on the counter PC's bridge. The
    // client logs the transaction via /print-confirm ONLY after the bridge accepts
    // the job, so "Printed" in the history reflects an actual hand-off, not just
    // that a label was generated.
    return Response.json({ tspl, preview, printer, reprint, copies, qr });
  } catch (e: any) {
    console.error('POST /api/kitchen-production/[id]/print failed:', e);
    return Response.json({ error: e?.message || 'Failed to build label' }, { status: 500 });
  }
}
