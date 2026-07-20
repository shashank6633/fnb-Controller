import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement } from '@/lib/auth';
import { runSalesReport, type SalesReportType } from '@/lib/sales-reports';

/**
 * Sales Reports API (management only). GET /api/reports/sales?type=&from=&to=
 *   type: customer | table | item | category | channel | floor
 *   from/to: YYYY-MM-DD (IST settle-day range)
 * → { type, from, to, rows }. Sales figures are settled, outlet-scoped.
 */
export const dynamic = 'force-dynamic';

const TYPES = new Set<SalesReportType>(['orders', 'customer', 'table', 'item', 'category', 'channel', 'floor', 'kots']);
// POS-matching detail reports — each file owns its query + column spec, imported
// on demand so the (server-only) better-sqlite3 code never reaches the client.
const POS_REPORTS: Record<string, () => Promise<{ run: Function; COLUMNS: any[] }>> = {
  'customer-order': () => import('@/lib/reports/customer-order'),
  'category-summary': () => import('@/lib/reports/category-summary'),
  'item-detail': () => import('@/lib/reports/item-detail'),
  'kot-details': () => import('@/lib/reports/kot-details'),
  'order-punched': () => import('@/lib/reports/order-punched'),
};
const isYmd = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

    const url = new URL(req.url);
    const type = String(url.searchParams.get('type') || '');
    const isPos = type in POS_REPORTS;
    if (!isPos && !TYPES.has(type as SalesReportType)) return Response.json({ error: 'Unknown report type' }, { status: 400 });
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!isYmd(from) || !isYmd(to)) return Response.json({ error: 'from and to (YYYY-MM-DD) are required' }, { status: 400 });
    if (from > to) return Response.json({ error: 'from must be on or before to' }, { status: 400 });

    const db = getDb();
    const outletId = await getCurrentOutletId();
    if (isPos) {
      // POS-matching detail report — the file supplies both the columns and rows.
      const mod = await POS_REPORTS[type]();
      return Response.json({ type, from, to, columns: mod.COLUMNS, rows: mod.run(db, outletId, from, to) });
    }
    const { rows } = runSalesReport(db, outletId, type as SalesReportType, from, to);
    return Response.json({ type, from, to, rows });
  } catch (e: any) {
    console.error('[/api/reports/sales]', e);
    return Response.json({ error: e?.message || 'Failed to build report' }, { status: 500 });
  }
}
