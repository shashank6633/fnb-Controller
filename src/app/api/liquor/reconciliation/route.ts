import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';
import { canAccessPage } from '@/lib/page-catalog';
import { listStores } from '@/lib/store-engine';
import {
  buildLiquorSummary, liquorSummaryCsv, isLqCsvSection, LQ_RECON_PAGE, type LqSummaryResult,
  getReportValueBasis, isLqValueBasis, LQ_VALUE_BASIS_KEY, type LqValueBasis,
} from '@/lib/liquor-summary';
import { csrfGuard } from '../wallet/gate';
import { requireAuditedWrite } from '../brand-map/_lib/guard';

/**
 * GET /api/liquor/reconciliation
 *   ?store_id=<id>            (default: the LIQUOR STORE, else the first store)
 *   &from=YYYY-MM-DD&to=YYYY-MM-DD   (default: 1st of the current IST month → today)
 *   &planned_indent=<Rs>      (optional — §A2 top-up planner)
 *   &value_at=recorded|landed (optional — owner decision 1; default = the setting)
 *   &section=A|A2|B|C|D|E|F|G|H|checks|vendors &format=csv   → downloadable CSV of one section
 *
 * PUT { value_basis: 'recorded' | 'landed' }   → sets the report's DEFAULT basis
 *
 * VALUE AT — OWNER DECISION 1 (2026-08-31): "both bases behind a toggle;
 * reports default to the EXISTING recorded basis; landed is opt-in." The
 * setting lq_report_value_basis is the report's default (absent = recorded);
 * `value_at` overrides it for one view (the page's switch) and an unknown value
 * is refused rather than quietly read as either. Changing the DEFAULT is an
 * ADMIN write, CSRF-checked and audited. Either way it is report-only: no
 * valuation column, recipe cost or pour cost reads it.
 *
 * The Liquor Purchase Reconciliation Summary (workbook §L5) as a live report.
 *
 * THE GATE — the same two halves as the wallet's (wallet/gate.ts walletGate),
 * on this report's own catalog path, and BOTH are required:
 *   · canAccessPage(LQ_RECON_PAGE) — the user's page map, resolved exactly as
 *     the sidebar and the proxy resolve it, so the API cannot hand out a report
 *     the nav does not offer. It used to check isManagement() alone, so a
 *     manager or HOD whose map was only ['/recipes'] — refused by the wallet
 *     API — still read §A, the TGBCL wallet balance, through this route
 *     (measured on the DB copy: wallet 403, reconciliation 200 with
 *     balance ₹2,39,793.91).
 *   · isManagement() — because canAccessPage matches a grant BY PREFIX, so a
 *     bare '/inventory' grant would otherwise carry this mgmtOnly page for a
 *     non-management user. proxy.ts gates pages, not /api, so this is the real
 *     security boundary.
 *
 * §G MASTER RATES ARE ADMIN-ONLY, as on the brand-map routes
 * (brand-map/_lib/guard.ts: admin on every verb, GET included). A non-admin gets
 * §G with the master rate and every figure it can be re-derived from withheld —
 * see LqSummaryOpts.revealMasterRates. The same switch withholds §E's depot
 * rate and excess figures, which re-derive that master (LqSectionE), and §H's
 * frozen landed values with every recoverable that is one (LqSectionH) — for a
 * brand never indented, a withdrawal's landed value IS the master per bottle.
 * The CSV is built from the same result, so it carries the same redaction.
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
    if (!canAccessPage(LQ_RECON_PAGE, me) || !isManagement(me)) {
      return Response.json(
        { error: 'The liquor reconciliation summary is management-only, and your page access does not include it.' },
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

    // Owner decision 1: the view's basis — an explicit value_at, else the
    // report's default setting (absent/unreadable = recorded).
    const valueBasisDefault = getReportValueBasis(db);
    const valueAtRaw = sp.get('value_at');
    if (valueAtRaw != null && valueAtRaw !== '' && !isLqValueBasis(valueAtRaw)) {
      return Response.json(
        { error: `Unknown value_at "${valueAtRaw}". Use recorded (the default basis) or landed (opt-in).` },
        { status: 400 },
      );
    }
    const valueBasis: LqValueBasis = isLqValueBasis(valueAtRaw) ? valueAtRaw : valueBasisDefault;

    const plannedRaw = sp.get('planned_indent');
    const plannedIndent = plannedRaw != null && plannedRaw !== '' && Number.isFinite(Number(plannedRaw))
      ? Number(plannedRaw)
      : null;

    const result: LqSummaryResult = buildLiquorSummary(db, {
      storeId: store.id,
      storeName: store.name,
      from, to,
      plannedIndent,
      // Fail closed: only an admin sees the brand master's rates in §G, and the
      // figures that re-derive them in §E and §H.
      revealMasterRates: me.role === 'admin',
      valueBasis,
      valueBasisDefault,
    });

    // Per-section CSV export.
    const section = sp.get('section');
    if (sp.get('format') === 'csv') {
      if (!isLqCsvSection(section)) {
        return Response.json({ error: `Unknown section "${section}". Use one of A, A2, B, C, D, E, F, G, H, checks, vendors.` }, { status: 400 });
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
          'Content-Disposition': `attachment; filename="liquor-recon_${slug}_${section}_${valueBasis}_${from}_to_${to}.csv"`,
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

/**
 * PUT /api/liquor/reconciliation  { value_basis: 'recorded' | 'landed' }
 *
 * Sets the report's DEFAULT value basis (owner decision 1). ADMIN only, on top
 * of the same page + management gate as GET, and CSRF-checked here because
 * proxy.ts does not list /api/liquor. AUDITED (liquor.report.value_basis,
 * before/after) in the same transaction as the write, so the default cannot
 * change without a record of who changed it. Report-only: the setting is read
 * by buildLiquorSummary and nothing else — no valuation column, recipe cost or
 * pour cost moves.
 */
export async function PUT(request: Request) {
  try {
    const csrf = csrfGuard(request);
    if (csrf) return csrf;
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canAccessPage(LQ_RECON_PAGE, me) || !isManagement(me)) {
      return Response.json(
        { error: 'The liquor reconciliation summary is management-only, and your page access does not include it.' },
        { status: 403 },
      );
    }
    if (me.role !== 'admin') {
      return Response.json(
        { error: 'Only an admin can change the report\'s default basis. Use the Value at switch to view the other basis.' },
        { status: 403 },
      );
    }
    const b = await request.json().catch(() => null) as Record<string, unknown> | null;
    const next = b && typeof b === 'object' ? b.value_basis : undefined;
    if (!isLqValueBasis(next)) {
      return Response.json(
        { error: 'Send { value_basis: "recorded" } (the existing basis) or { value_basis: "landed" } (opt-in).' },
        { status: 400 },
      );
    }
    const db = getDb();
    const before = getReportValueBasis(db);
    if (before === next) {
      return Response.json({ ok: true, unchanged: true, value_basis_default: before });
    }
    db.transaction(() => {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(LQ_VALUE_BASIS_KEY, next);
      // requireAuditedWrite, not bare logAuditEvent (which never throws): if
      // the audit row cannot be written, the setting rolls back with it.
      requireAuditedWrite(db, {
        event_type: 'liquor.report.value_basis',
        entity_type: 'settings',
        entity_id: LQ_VALUE_BASIS_KEY,
        actor_email: me.email,
        before: { value_basis: before },
        after: { value_basis: next },
        note: `Liquor Reconciliation default basis: ${before} → ${next}. Report-only — no valuation, recipe or pour cost changes.`,
      }, 'this change of the report\'s default basis');
    })();
    return Response.json({ ok: true, value_basis_default: next, was: before });
  } catch (e: any) {
    console.error('[/api/liquor/reconciliation PUT]', e);
    return Response.json(
      { error: 'Could not change the default basis. The details are in the server log.' },
      { status: 500 },
    );
  }
}
