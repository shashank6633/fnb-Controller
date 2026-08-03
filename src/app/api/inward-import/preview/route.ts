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

    // The bill total alone hid WHERE the money goes: reclaimable GST rides beside the
    // goods rate, TGBCL excise/cess/TCS is genuine landed cost, and the two are settled
    // differently. Split it here so the clerk sees it BEFORE committing rather than
    // discovering it in the inward register.
    //
    // Charge columns are read defensively: the sheet carries VAT / CESS / EXCISE columns
    // that have no home on `purchases`, and the parser gained the landed-cost fields
    // separately from this route. A missing field reads 0 and its money therefore
    // surfaces in `unreconciled_amount` instead of silently vanishing from the preview.
    type InwardCharges = Partial<Record<
      'discount' | 'tcsPlusSpecialCess' | 'excise' | 'deliveryCharges' | 'mrpRoundOff',
      number
    >>;
    const chg = (row: unknown, key: keyof InwardCharges): number => {
      const v = (row as InwardCharges)[key];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    const r2 = (n: number) => Math.round(n * 100) / 100;

    // subtotal is the sheet's own goods figure; fall back to qty x rate on the legacy
    // export, which has no SUBTOTAL column.
    const goodsAmount = r2(rows.reduce((s, r) => s + (r.subtotal || r.inwardQty * r.rate), 0));
    const gstAmount   = r2(rows.reduce((s, r) => s + r.cgst + r.sgst, 0));
    const otherChargesAmount = r2(rows.reduce((s, r) => s
      + chg(r, 'tcsPlusSpecialCess')
      + chg(r, 'excise')
      + chg(r, 'deliveryCharges')
      + chg(r, 'mrpRoundOff')
      - chg(r, 'discount'), 0));
    // Rounded parts, so the four numbers on screen genuinely add up to the bill total.
    const totalAmount = r2(total);
    const unreconciledAmount = r2(totalAmount - goodsAmount - gstAmount - otherChargesAmount);

    return Response.json({
      sheets: wb.SheetNames,
      rows: rows.length,
      summary: {
        unique_items:     items.size,
        unique_suppliers: suppliers.size,
        date_from:        dates[0] ?? null,
        date_to:          dates[dates.length - 1] ?? null,
        total_amount:     totalAmount,
        goods_amount:         goodsAmount,
        gst_amount:           gstAmount,
        other_charges_amount: otherChargesAmount,
        unreconciled_amount:  unreconciledAmount,
      },
      sample: rows.slice(0, 6),
    });
  } catch (e: any) {
    console.error('[inward-import/preview]', e);
    return Response.json({ error: e.message || 'Failed to parse file' }, { status: 500 });
  }
}
