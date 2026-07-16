import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';
import { getTableWiseSales } from '@/lib/sales-dashboard';

/**
 * GET /api/dine-in/sales-dashboard/table-wise?from=&to=&format=csv
 *
 * Table-wise settled sales for the IST day range. MANAGEMENT ONLY — Admin,
 * Manager or HOD (isManagement); anyone else gets 403. `format=csv` streams a
 * downloadable CSV; otherwise JSON.
 */
export const dynamic = 'force-dynamic';

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!isManagement(me)) {
      return Response.json({ error: 'Only managers, HODs and admins can download sales data.' }, { status: 403 });
    }
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const sp = new URL(request.url).searchParams;
    const today = todayIST();
    let from = sp.get('from') || today;
    let to = sp.get('to') || today;
    if (!isDate(from)) from = today;
    if (!isDate(to)) to = today;
    if (from > to) { const t = from; from = to; to = t; }

    const rows = getTableWiseSales(db, outletId, from, to);

    if (sp.get('format') === 'csv') {
      const header = ['Floor', 'Section', 'Table', 'Bills', 'Covers', 'Sales (₹)'];
      const lines = [header.join(',')];
      for (const r of rows) {
        lines.push([r.floor, r.section, r.table_number, r.orders, r.covers, r.sales].map(csvCell).join(','));
      }
      const totals = rows.reduce((a, r) => ({ orders: a.orders + r.orders, covers: a.covers + r.covers, sales: a.sales + r.sales }), { orders: 0, covers: 0, sales: 0 });
      lines.push(['', '', 'TOTAL', totals.orders, totals.covers, Math.round(totals.sales * 100) / 100].map(csvCell).join(','));
      const csv = lines.join('\n');
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="table-wise-sales_${from}_to_${to}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return Response.json({ from, to, rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[/api/dine-in/sales-dashboard/table-wise GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
