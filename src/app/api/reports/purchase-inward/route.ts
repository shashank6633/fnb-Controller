import { getCurrentUser } from '@/lib/auth';
import { requireFinanceReport } from '@/lib/finance-reports-access';
import {
  getPurchaseInward, buildPurchaseInwardWorkbook, purchaseInwardFilename, type LiquorInwardSection,
} from '@/lib/purchase-inward';
import { getLiquorInward, liquorInwardFailed } from '@/lib/purchase-inward-liquor';

/* ══════════════════════════════════════════════════════════════════════════
 * PURCHASE INWARD (EXCEL) — GET /api/reports/purchase-inward   (owner ruling 127)
 *
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   → the .xlsx file
 *
 * The owner's Recaho-style 38-column inward list (+ our PINV as column AM), one
 * row per purchase line the Purchase Report adds up for those INWARD dates, so
 * its TOTAL INWARD AMOUNT column = the Purchase Report Grand Total. Built in
 * src/lib/purchase-inward.ts. Liquor (TGBCL) bills go on their own sheet,
 * "Liquor Inward" (src/lib/purchase-inward-liquor.ts), whose total = the bills'
 * Net Indent and is never added to that Grand Total; a store's liquor bills are
 * included only for a login that may view that store on Liquor Store (the
 * Inward Register's own gate). A download of the Purchase Report page, so it is
 * gated EXACTLY like that page's other feeds (/api/reports/purchase-itemwise):
 * 401 signed out, 403 unless management or a role with the finance-reports tick.
 * ══════════════════════════════════════════════════════════════════════════ */

// A purchase report served from cache is a wrong purchase report.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day in YYYY-MM-DD (2026-02-30 is not one). */
function isDay(s: string | null): s is string {
  if (!s || !YMD.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * The app's public origin, for the INVOICE URL links — read off the request the
 * way src/app/api/crm-calls/reviews/connect/route.ts (originOf) does: the
 * forwarded host first (the app runs behind a proxy, where request.url is the
 * internal address), then Host, then the request URL. Never a guessed host.
 */
function originOf(req: Request): string {
  const h = req.headers;
  const proto = (h.get('x-forwarded-proto') || '').split(',')[0].trim();
  const host = (h.get('x-forwarded-host') || h.get('host') || '').split(',')[0].trim();
  if (host) return `${proto || 'https'}://${host}`;
  try { return new URL(req.url).origin; } catch { return ''; }
}

export async function GET(req: Request) {
  try {
    // Same gate, same page path, same wording as /api/reports/purchase-itemwise.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const deniedFin = requireFinanceReport(me, '/reports/purchases');
    if (deniedFin) return deniedFin;

    const sp = new URL(req.url).searchParams;
    const from = sp.get('from');
    const to = sp.get('to');
    if (!isDay(from) || !isDay(to)) {
      return Response.json({ error: 'Choose a From and a To date (YYYY-MM-DD).' }, { status: 400 });
    }
    if (from > to) return Response.json({ error: 'The From date must be on or before the To date.' }, { status: 400 });

    const res = getPurchaseInward({ from, to, origin: originOf(req) });
    // Sheet 3, "Liquor Inward": TGBCL bills from the Liquor Store's own register,
    // for the stores this login may view there. Never part of the total above.
    // A failure there is reported inside the file; the main sheet still ships.
    let liquor: LiquorInwardSection;
    try {
      liquor = getLiquorInward({ from, to }, me);
    } catch (e: unknown) {
      console.error('[/api/reports/purchase-inward] liquor sheet', e);
      liquor = liquorInwardFailed(e instanceof Error && e.message ? e.message : 'unknown error');
    }
    const buf = buildPurchaseInwardWorkbook(res, { generatedAt: new Date(), liquor });
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${purchaseInwardFilename(from, to)}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: unknown) {
    console.error('[/api/reports/purchase-inward]', e);
    const msg = e instanceof Error && e.message ? e.message : 'Failed to build the purchase inward file';
    return Response.json({ error: msg }, { status: 500 });
  }
}
