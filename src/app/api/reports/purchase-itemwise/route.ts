import { getCurrentUser } from '@/lib/auth';
import { requireFinanceReport } from '@/lib/finance-reports-access';
import {
  getPurchaseItemwise, buildItemwiseWorkbook, itemwiseFilename, toScreenRow, ITEMWISE_SCREEN_ROW_CAP,
} from '@/lib/purchase-itemwise';
import type { ItemwiseResponse } from '@/lib/purchase-itemwise-columns';

/* ══════════════════════════════════════════════════════════════════════════
 * ITEM-WISE PURCHASES — GET /api/reports/purchase-itemwise   (owner ruling 115)
 *
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD [&vendor=] [&category=] [&material_id=]
 *   [&format=json|xlsx]
 *
 * One line per item bought — one row of `purchases` — read through the Summary
 * tab's own FROM / WHERE, so every money column adds up to the Summary card of
 * the same name. json feeds the Purchase log tab's default view; xlsx is its
 * download: four sheets (Item-wise, Date-wise, Bill-wise, Totals) built here,
 * on the server, from the same query. See src/lib/purchase-itemwise.ts.
 *
 * vendor / category are EXACT matches, TRIM'd and case-folded — the Summary's
 * filters, not the audit log's "contains" — because the point is that the two
 * agree. material_id is the one filter the Summary does not have.
 * ══════════════════════════════════════════════════════════════════════════ */

// A purchase report served from cache is a wrong purchase report.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  try {
    // Same gate, same page path, same wording as /api/reports/purchases and
    // /api/reports/purchase-log: this is that page's data feed.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const deniedFin = requireFinanceReport(me, '/reports/purchases');
    if (deniedFin) return deniedFin;

    const sp = new URL(req.url).searchParams;
    const from = sp.get('from');
    const to = sp.get('to');
    if (!from || !to || !YMD.test(from) || !YMD.test(to)) {
      return Response.json({ error: 'from and to (YYYY-MM-DD) are required' }, { status: 400 });
    }
    if (from > to) return Response.json({ error: 'from must be on or before to' }, { status: 400 });

    const format = sp.get('format');
    if (format !== null && format !== 'json' && format !== 'xlsx') {
      return Response.json({ error: `Invalid 'format' "${format}" — expected json or xlsx.` }, { status: 400 });
    }

    const res = getPurchaseItemwise({
      from, to,
      vendor: (sp.get('vendor') || '').trim(),
      category: (sp.get('category') || '').trim(),
      materialId: (sp.get('material_id') || '').trim(),
    });

    if (format === 'xlsx') {
      const buf = buildItemwiseWorkbook(res, new Date());
      return new Response(new Uint8Array(buf), {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${itemwiseFilename(from, to)}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const body: ItemwiseResponse = {
      from: res.from, to: res.to, vendor: res.vendor, category: res.category,
      material_id: res.material_id, material_name: res.material_name,
      rows: res.lines.slice(0, ITEMWISE_SCREEN_ROW_CAP).map(toScreenRow),
      truncated: res.lines.length > ITEMWISE_SCREEN_ROW_CAP,
      row_cap: ITEMWISE_SCREEN_ROW_CAP,
      lines: res.lines.length, bills: res.bills, days: res.days,
      totals: res.totals,
      proof: res.proof,
      bill_check: res.bill_check,
      part_rejected_lines: res.part_rejected_lines,
      understated_lines: res.understated_lines,
    };
    return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: unknown) {
    console.error('[/api/reports/purchase-itemwise]', e);
    const msg = e instanceof Error && e.message ? e.message : 'Failed to build the item-wise purchases';
    return Response.json({ error: msg }, { status: 500 });
  }
}
