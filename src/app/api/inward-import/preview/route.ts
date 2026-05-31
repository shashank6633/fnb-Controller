import * as XLSX from 'xlsx';
import { parseInwardWorkbook } from '@/lib/recaho-inward';
import { requireRole } from '@/lib/auth';

/**
 * Step 1 of the inward upload — preview only. Returns parsed counts + a sample so
 * the user can confirm before committing. Body is multipart/form-data with `file`.
 */
export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  try {
    const fd = await req.formData();
    const file = fd.get('file');
    if (!file || !(file instanceof Blob)) {
      return Response.json({ error: 'file field missing' }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer' });
    const rows = parseInwardWorkbook(XLSX, wb);

    if (rows.length === 0) {
      return Response.json({
        sheets: wb.SheetNames,
        rows: 0,
        error: 'No detail rows found. Check that the file has columns ITEM NAME, INWARD QTY, RATE, INWARD DATE.',
      }, { status: 200 });
    }

    const dates = rows.map(r => r.inwardDate).filter(Boolean) as string[];
    dates.sort();
    const items = new Set(rows.map(r => r.itemName));
    const suppliers = new Set(rows.map(r => r.supplier).filter(Boolean));
    const total = rows.reduce((s, r) => s + r.totalAmount, 0);

    return Response.json({
      sheets: wb.SheetNames,
      rows: rows.length,
      summary: {
        unique_items:     items.size,
        unique_suppliers: suppliers.size,
        date_from:        dates[0] ?? null,
        date_to:          dates[dates.length - 1] ?? null,
        total_amount:     Math.round(total * 100) / 100,
      },
      sample: rows.slice(0, 6),
    });
  } catch (e: any) {
    console.error('[inward-import/preview]', e);
    return Response.json({ error: e.message || 'Failed to parse file' }, { status: 500 });
  }
}
