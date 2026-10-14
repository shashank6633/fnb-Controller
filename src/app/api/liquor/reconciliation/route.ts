import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';
import { listStores } from '@/lib/store-engine';
import {
  buildLiquorSummary, liquorSummaryCsv, isLqCsvSection, type LqSummaryResult,
} from '@/lib/liquor-summary';

/**
 * GET /api/liquor/reconciliation
 *   ?store_id=<id>            (default: the LIQUOR STORE, else the first store)
 *   &from=YYYY-MM-DD&to=YYYY-MM-DD   (default: 1st of the current IST month → today)
 *   &planned_indent=<Rs>      (optional — §A2 top-up planner)
 *   &section=A|A2|B|C|D|E|F|G|H|checks &format=csv   → downloadable CSV of one section
 *
 * The Liquor Purchase Reconciliation Summary (workbook §L5) as a live report.
 * MANAGEMENT ONLY — Admin, Manager or HOD (isManagement); page-catalog declares
 * this route mgmtOnly and a bare '/inventory' grant reaches it by prefix, so the
 * gate is re-checked HERE, server-side, which is the real security boundary.
 *
 * READ-ONLY. It builds the summary with buildLiquorSummary, which only SELECTs —
 * no lq_ row is written, no stock or money moves, and landed cost never touches
 * a valuation column (L0 rule 1 / plan decision 1a).
 */
export const dynamic = 'force-dynamic';

const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

function firstOfMonthIST(): string {
  const today = todayIST();          // YYYY-MM-DD in IST
  return `${today.slice(0, 7)}-01`;
}

/** Resolve the store to report on. Explicit id wins; else the dedicated LIQUOR
 *  STORE; else the first store. Returns null only when there are no stores.
 *  `unknown` is set when an id WAS asked for and names no store — substituting a
 *  different store's money behind a 200 is how a bookmarked or hand-edited URL
 *  reports the wrong outlet's figures under the right-looking heading. */
function resolveStore(db: ReturnType<typeof getDb>, requested: string | null) {
  const stores = listStores(db);
  if (requested) {
    const hit = stores.find(s => s.id === requested);
    if (hit) return { store: hit, stores, unknown: false };
    return { store: null, stores, unknown: true };
  }
  const liquor = stores.find(s => String(s.name || '').trim().toUpperCase() === 'LIQUOR STORE');
  return { store: liquor || stores[0] || null, stores, unknown: false };
}

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!isManagement(me)) {
      return Response.json(
        { error: 'Only managers, HODs and admins can view the liquor reconciliation summary.' },
        { status: 403 },
      );
    }

    const db = getDb();
    const sp = new URL(request.url).searchParams;

    const today = todayIST();
    let from = sp.get('from') || firstOfMonthIST();
    let to = sp.get('to') || today;
    if (!isDate(from)) from = firstOfMonthIST();
    if (!isDate(to)) to = today;
    if (from > to) { const t = from; from = to; to = t; }

    const { store, stores, unknown } = resolveStore(db, sp.get('store_id'));
    if (unknown) {
      return Response.json(
        { error: 'That store no longer exists — pick one from the Store selector.' },
        { status: 404 },
      );
    }
    if (!store) {
      return Response.json({ error: 'No store is configured — set up the Liquor Store first.' }, { status: 404 });
    }

    const plannedRaw = sp.get('planned_indent');
    const plannedIndent = plannedRaw != null && plannedRaw !== '' && Number.isFinite(Number(plannedRaw))
      ? Number(plannedRaw)
      : null;

    const result: LqSummaryResult = buildLiquorSummary(db, {
      storeId: store.id,
      storeName: store.name,
      from, to,
      plannedIndent,
    });

    // Per-section CSV export.
    const section = sp.get('section');
    if (sp.get('format') === 'csv') {
      if (!isLqCsvSection(section)) {
        return Response.json({ error: `Unknown section "${section}". Use one of A, A2, B, C, D, E, F, G, H, checks.` }, { status: 400 });
      }
      // BOM: every section emits em-dashes, and Excel on Windows ignores the
      // charset header on a double-clicked .csv and decodes the system ANSI
      // codepage — the same reason the purchase-log, HR and CRM exporters
      // prepend one.
      const csv = '﻿' + liquorSummaryCsv(result, section);
      const slug = String(store.name || 'store').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="liquor-recon_${slug}_${section}_${from}_to_${to}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return Response.json(
      {
        ...result,
        stores: stores.map(s => ({ id: s.id, name: s.name })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    // The detail goes to the server log, not to the browser: the driver's own
    // message names internal tables and columns, and the page has no use for it.
    console.error('[/api/liquor/reconciliation GET]', e);
    return Response.json(
      { error: 'Failed to build the reconciliation summary. The details are in the server log.' },
      { status: 500 },
    );
  }
}
