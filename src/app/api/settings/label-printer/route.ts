import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  LABEL_PRINTER_KEY,
  readLabelPrinter,
  normalizeLabelPrinter,
} from '@/lib/tspl-label';

/**
 * Label-printer (TSC TE210) configuration.
 *
 * GET  /api/settings/label-printer → { printer: LabelPrinterConfig }   (defaults if unset)
 * POST /api/settings/label-printer → { printer: LabelPrinterConfig }   (admin-only; saves)
 *
 * Stored as a single JSON blob in settings under key 'label_printer'.
 */

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    return Response.json({ printer: readLabelPrinter(db) });
  } catch (e: any) {
    console.error('GET /api/settings/label-printer failed:', e);
    return Response.json({ error: e?.message || 'Failed to load label-printer config' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin') {
      return Response.json({ error: 'Admin required to change the label printer' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const config = normalizeLabelPrinter(body?.printer ?? body);

    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(LABEL_PRINTER_KEY, JSON.stringify(config));

    return Response.json({ printer: config });
  } catch (e: any) {
    console.error('POST /api/settings/label-printer failed:', e);
    return Response.json({ error: e?.message || 'Failed to save label-printer config' }, { status: 500 });
  }
}
