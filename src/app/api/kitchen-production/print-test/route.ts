import { getDb } from '@/lib/db';
import { getCurrentUser, canManageKitchenProduction } from '@/lib/auth';
import { buildTSPL, readLabelPrinter, type LabelBatch } from '@/lib/tspl-label';

/**
 * POST /api/kitchen-production/print-test
 *   Builds a SAMPLE label (using the saved Label-design + printer config) so the
 *   client can send it to the bridge as a physical test print. Logs nothing — it
 *   is a connectivity/design test, not a real batch print.
 *   → { tspl, printer }
 */
const SAMPLE: LabelBatch = {
  item_name: 'TEST LABEL',
  batch_number: 'TEST000001',
  barcode: 'PRODTEST01',
  production_date: '07 Jul 26',
  production_time: '14:30',
  expiry_date: '09 Jul 26',
  expiry_time: '14:30',
  quantity_produced: 1,
  unit: 'kg',
  prepared_by: 'Test',
  storage_location: 'Test',
};

export async function POST() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageKitchenProduction(me)) return Response.json({ error: 'Head chef or admin only' }, { status: 403 });

    const db = getDb();
    const printer = readLabelPrinter(db);
    const tspl = buildTSPL(SAMPLE, {
      copies: 1,
      qr: printer.qr,
      labelWidthMm: printer.label_width_mm,
      labelHeightMm: printer.label_height_mm,
      design: printer.design,
    });
    return Response.json({ tspl, printer });
  } catch (e: any) {
    console.error('POST /api/kitchen-production/print-test failed:', e);
    return Response.json({ error: e?.message || 'Failed to build test label' }, { status: 500 });
  }
}
