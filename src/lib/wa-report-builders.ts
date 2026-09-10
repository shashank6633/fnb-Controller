/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import { getSalesDashboard, getItemWiseSales } from '@/lib/sales-dashboard';
import { getCategoryWiseSales, getFloorWiseSales } from '@/lib/sales-reports';
import { buildCountDigest, listVarianceApprovals, type CountDigest } from '@/lib/variance-approval';
import { costSpikes, type CostSpikeRow } from '@/lib/cost-spikes';
import { listDiscountRequests } from '@/lib/discount-requests';
import { dashboardStats } from '@/lib/ct/metrics';
import {
  buildReportPdf, inr, inrText, inrSignedText, count as fmtCount, qty as fmtQty,
  humanDate, type PdfTable,
} from '@/lib/report-pdf';

/**
 * ══════════════════════════════════════════════════════════════════════════
 * WHATSAPP REPORT & ALERT BUILDERS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * One builder per thing the owner named. Every builder is PURE:
 *
 *   · it takes a db handle plus a date / outlet / entity id,
 *   · it READS ONLY — no insert, no update, no settings write, no network,
 *   · it SENDS NOTHING. It returns the message variables and (where a document
 *     earns its place) the PDF bytes. src/lib/wa-report-jobs.ts is the only
 *     thing that decides whether to send them, and src/lib/wa-report-send.ts is
 *     the only thing that can.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ NO BUILDER MAY DERIVE A FIGURE THE APP ALREADY COMPUTES.                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * A WhatsApp report is read beside the screen it summarises. The instant the
 * two disagree by a rupee, BOTH become untrustworthy and the owner has to open
 * the app to check the message that existed to save him opening the app. So
 * every number below comes out of the SAME function the page calls:
 *
 *   day's money, covers, sessions, payments  getSalesDashboard()   ← /sales-dashboard
 *   item / category / floor breakdowns       sales-reports.ts      ← /reports/sales
 *   the stock-count difference sentence      buildCountDigest()    ← the count digest
 *   the difference LINES                     listVarianceApprovals() ← /variance-approvals
 *   price hikes                              costSpikes()          ← the home dashboard card
 *   discount impact                          listDiscountRequests()← the approval queue
 *   calls / answered / missed                dashboardStats()      ← the CRM dashboard
 *
 * Where a figure genuinely has no existing computation it is written here ONCE,
 * commented as new, and named so it cannot be mistaken for one of the above.
 *
 * ── EMPTY IS AN ANSWER, AND IT IS NEVER A BLANK PDF ───────────────────────
 * Every builder returns `empty` + `emptyReason`. When `empty` is true the
 * builder returns NO pdf at all (`pdf` is null) — a nothing-happened day must
 * either say so in one line of text or be skipped by config, and an empty PDF
 * is the one outcome that is always wrong: it costs a template send, it looks
 * like a bug, and it trains the reader to ignore the next one.
 *
 * ── MONEY IN A PDF IS "Rs", MONEY IN A MESSAGE IS "₹" ─────────────────────
 * Not cosmetic. pdfkit's Helvetica has no rupee glyph; see the header of
 * src/lib/report-pdf.ts. inr() is for PDF cells, inrText() for message text.
 */

/* ═══════════════════════ the shared contract ═══════════════════════ */

export interface BuiltReport {
  /** Stable key: the wa_report_files.report_key and the dedupe key. */
  key: string;
  /** What the figures cover — 'YYYY-MM-DD', or an id for an event alert. */
  period: string;
  /** TRUE ⇒ nothing to report. `pdf` is null and the job should skip or send text. */
  empty: boolean;
  /** Why it is empty, in a sentence fit to show a human. '' when not empty. */
  emptyReason: string;
  /** Named variables, for a template and for reading. */
  vars: Record<string, string | number>;
  /** vars → {{1}},{{2}},… . The template contract. */
  paramOrder: string[];
  /** `vars` in `paramOrder`, whitespace-collapsed the way Meta requires. */
  params: string[];
  /** The whole message as one readable block (also the wa_messages bubble text). */
  text: string;
  /** '' when there is no document. */
  filename: string;
  mime: string;
  /** null when there is nothing worth attaching. Bytes, already rendered. */
  pdf: Buffer | null;
}

const S = (v: unknown) => String(v ?? '');
const norm = (v: unknown) => S(v).trim();
const isYmd = (s: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(S(s));

/** Meta rejects positional params carrying newlines/tabs/long space runs. */
function collapse(v: unknown): string { return S(v).replace(/\s+/g, ' ').trim(); }

function paramsFrom(vars: Record<string, string | number>, order: string[]): string[] {
  return order.map(k => collapse(Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : ''));
}

/** Read one settings row. Builders only ever READ settings (branding, threshold). */
function setting(db: Database.Database, key: string, fallback = ''): string {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
    const v = norm(r?.value);
    return v || fallback;
  } catch { return fallback; }
}

export function businessNameOf(db: Database.Database): string {
  return setting(db, 'business_name', 'Restaurant');
}

/** The outlet a scheduled job runs for when nobody is signed in — the same
 *  fallback getCurrentOutletId() uses (auth.ts) so a job and a screen agree. */
export function defaultOutletId(db: Database.Database): string | null {
  try {
    const r = db.prepare('SELECT id FROM outlets WHERE is_default = 1 LIMIT 1').get() as any;
    return r?.id || null;
  } catch { return null; }
}

function outletNameOf(db: Database.Database, outletId: string | null): string {
  if (!outletId) return '';
  try {
    const r = db.prepare('SELECT name FROM outlets WHERE id = ?').get(outletId) as any;
    return norm(r?.name);
  } catch { return ''; }
}

/** '<business> · <outlet>' — the line under a PDF title. */
function headerName(db: Database.Database, outletId: string | null): string {
  const biz = businessNameOf(db);
  const outlet = outletNameOf(db, outletId);
  return outlet && outlet.toLowerCase() !== biz.toLowerCase() ? `${biz} · ${outlet}` : biz;
}

function emptyReport(key: string, period: string, reason: string, vars: Record<string, string | number> = {}, order: string[] = []): BuiltReport {
  return {
    key, period, empty: true, emptyReason: reason,
    vars, paramOrder: order, params: paramsFrom(vars, order),
    text: reason, filename: '', mime: 'application/pdf', pdf: null,
  };
}

/** A filename a recipient can file: 'akan-daily-ops-2026-07-16.pdf'. */
function fileNameFor(db: Database.Database, key: string, period: string): string {
  const biz = businessNameOf(db).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';
  const p = S(period).replace(/[^0-9a-zA-Z-]+/g, '-');
  return `${biz}-${key.replace(/_/g, '-')}-${p}.pdf`;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. DAILY OPS REPORT  (scheduled)
 * ════════════════════════════════════════════════════════════════════════ */

export const DAILY_OPS_PARAMS = [
  'date', 'net', 'orders', 'covers', 'avg_order', 'discount', 'tax', 'top_line', 'mtd_net',
];

/**
 * The day's headline figures + a PDF of the breakdowns behind them.
 *
 * BASIS. getSalesDashboard(db, outletId, date, date) — the EXACT call
 * /api/dine-in/sales-dashboard makes, so every figure in the message is the
 * figure on the Sales Dashboard for that day. Settled orders only, IST day,
 * money read off the order rows (what was actually charged), never the `sales`
 * recipe-cost fact table. The one number taken from elsewhere is the FLOOR P&L
 * block on the PDF, which getSalesDashboard itself sources from the `sales`
 * table — it is labelled as a different basis on the page for that reason.
 *
 * EMPTY = no settled bill. Not "small sales": zero orders. A closed day sends
 * one line, never a PDF of zeroes.
 */
export async function buildDailyOpsReport(
  db: Database.Database,
  args: { date: string; outletId?: string | null; itemLimit?: number; generatedAtMs?: number },
): Promise<BuiltReport> {
  const date = norm(args.date);
  const key = 'daily_ops';
  if (!isYmd(date)) return emptyReport(key, date, 'Daily ops report needs a YYYY-MM-DD date.');
  const outletId = args.outletId === undefined ? defaultOutletId(db) : args.outletId;

  const d = getSalesDashboard(db, outletId ?? null, date, date);

  if (!d.day.orders) {
    return emptyReport(key, date,
      `No settled bills on ${humanDate(date)} — nothing to report.`,
      { date: humanDate(date) }, ['date']);
  }

  const items = getItemWiseSales(db, outletId ?? null, date, date);
  const cats = getCategoryWiseSales(db, outletId ?? null, date, date);
  const floors = getFloorWiseSales(db, outletId ?? null, date, date);

  const top = items[0];
  const topLine = top ? `${top.name} (${fmtQty(top.qty)} × ${inrText(top.amount)})` : 'no items recorded';

  const sessionLine = d.bySession.map(s => `${s.label} ${inrText(s.amount)}`).join(' · ') || '—';
  const payLine = d.byPaymentCategory.map(p => `${p.label} ${inrText(p.amount)}`).join(' · ') || '—';
  const typeLine = d.itemTypesDay.filter(t => t.amount > 0).map(t => `${t.type} ${inrText(t.amount)}`).join(' · ') || '—';

  const vars: Record<string, string | number> = {
    date: humanDate(date),
    net: inrText(d.day.net),
    orders: fmtCount(d.day.orders),
    covers: fmtCount(d.performanceDay.covers),
    avg_order: inrText(d.performanceDay.avgOrderValue),
    discount: inrText(d.day.discount),
    tax: inrText(d.day.tax),
    top_line: topLine,
    mtd_net: inrText(d.mtd.net),
  };

  const cancelLine = d.cancelBreakup.orderCancel.count
    ? `\nCancelled bills: ${fmtCount(d.cancelBreakup.orderCancel.count)} (${inrText(d.cancelBreakup.orderCancel.amount)})`
    : '';

  // Covers are optional at the till on this install — a 0 there means "nobody
  // recorded a head count", not "nobody ate. Printing "Avg per cover ₹0.00"
  // beside it would read as a real average of zero.
  const coverLine = d.performanceDay.covers > 0
    ? `Covers ${fmtCount(d.performanceDay.covers)} · Avg bill ${inrText(d.performanceDay.avgOrderValue)} · Avg per cover ${inrText(d.performanceDay.avgPerCover)}\n`
    : `Avg bill ${inrText(d.performanceDay.avgOrderValue)} · covers not recorded on this day\n`;

  const text =
    `📊 Daily Ops — ${humanDate(date)}\n\n`
    + `Net collected: ${inrText(d.day.net)} across ${fmtCount(d.day.orders)} bill(s)\n`
    + coverLine
    + `Gross ${inrText(d.day.gross)} · Discount ${inrText(d.day.discount)} · Charges ${inrText(d.day.charges)} · Tax ${inrText(d.day.tax)}\n`
    + `Mix: ${typeLine}\n`
    + `Session: ${sessionLine}\n`
    + `Payments: ${payLine}\n`
    + `Top seller: ${topLine}`
    + cancelLine
    + `\n\nMonth to date: ${inrText(d.mtd.net)} across ${fmtCount(d.mtd.orders)} bill(s)`;

  const itemLimit = Math.max(1, Math.floor(Number(args.itemLimit) || 20));
  const tables: PdfTable[] = [
    {
      title: 'The day in money',
      columns: [{ label: 'Line', width: 3 }, { label: 'Day', width: 2, align: 'right' }, { label: 'Month to date', width: 2, align: 'right' }],
      rows: [
        ['Gross (before discount, charges, tax)', inr(d.day.gross), inr(d.mtd.gross)],
        ['Discount', '-' + inr(d.day.discount), '-' + inr(d.mtd.discount)],
        ['Service charge', inr(d.day.charges), inr(d.mtd.charges)],
        ['Amount before tax', inr(d.day.netBeforeTax), inr(d.mtd.netBeforeTax)],
        ['Tax (CGST + SGST)', inr(d.day.tax), inr(d.mtd.tax)],
        ['NET COLLECTED', inr(d.day.net), inr(d.mtd.net)],
        ['Bills settled', fmtCount(d.day.orders), fmtCount(d.mtd.orders)],
        ['Covers', fmtCount(d.performanceDay.covers), fmtCount(d.performanceMtd.covers)],
        ['Average bill', inr(d.performanceDay.avgOrderValue), inr(d.performanceMtd.avgOrderValue)],
        ['Average per cover', inr(d.performanceDay.avgPerCover), inr(d.performanceMtd.avgPerCover)],
        ['Average time at table (min)', fmtCount(d.performanceDay.avgOrderTimeMin), fmtCount(d.performanceMtd.avgOrderTimeMin)],
      ],
      note: 'Settled bills only, by IST calendar day. Net collected is the bill total — the amount actually charged.',
    },
    {
      title: 'Sales mix',
      columns: [{ label: 'Type', width: 3 }, { label: 'Amount', width: 2, align: 'right' }, { label: 'Share', width: 1, align: 'right' }],
      rows: d.itemTypesDay.map(t => [t.type, inr(t.amount), `${t.pct}%`]),
    },
    {
      title: 'Session',
      columns: [{ label: 'Session', width: 3 }, { label: 'Bills', width: 1, align: 'right' }, { label: 'Amount', width: 2, align: 'right' }, { label: 'Share', width: 1, align: 'right' }],
      rows: d.bySession.map(s => [s.label, fmtCount(s.count), inr(s.amount), `${s.pct}%`]),
      note: 'Lunch is settled before 17:00 IST; everything later is Evening.',
    },
    {
      title: 'Payments',
      columns: [{ label: 'Method', width: 3 }, { label: 'Bills', width: 1, align: 'right' }, { label: 'Amount', width: 2, align: 'right' }, { label: 'Share', width: 1, align: 'right' }],
      rows: d.byPaymentCategory.map(p => [p.label, fmtCount(p.count), inr(p.amount), `${p.pct}%`]),
      note: 'Split settlements are counted per tender, so one bill can appear under two methods.',
    },
    {
      title: 'Collection by business line',
      columns: [{ label: 'Line', width: 3 }, { label: 'Bills', width: 1, align: 'right' }, { label: 'Amount', width: 2, align: 'right' }, { label: 'Share', width: 1, align: 'right' }],
      rows: d.collectionByBusiness.map(b => [b.label, fmtCount(b.count), inr(b.amount), `${b.pct}%`]),
    },
    {
      title: 'Floor',
      columns: [{ label: 'Floor', width: 3 }, { label: 'Bills', width: 1, align: 'right' }, { label: 'Covers', width: 1, align: 'right' }, { label: 'Sales', width: 2, align: 'right' }],
      rows: floors.map(f => [f.floor, fmtCount(f.orders), fmtCount(f.covers), inr(f.sales)]),
      emptyNote: 'No floor-tagged bills on this day.',
    },
    {
      title: `Top items (${Math.min(itemLimit, items.length)} of ${items.length})`,
      columns: [{ label: 'Item', width: 5 }, { label: 'Type', width: 2 }, { label: 'Qty', width: 1, align: 'right' }, { label: 'Amount', width: 2, align: 'right' }],
      rows: items.slice(0, itemLimit).map(i => [i.name, i.type, fmtQty(i.qty), inr(i.amount)]),
      emptyNote: 'No items recorded against the day\'s bills.',
    },
    {
      title: 'Category',
      columns: [{ label: 'Category', width: 4 }, { label: 'Qty', width: 1, align: 'right' }, { label: 'Sales', width: 2, align: 'right' }, { label: 'Tax', width: 2, align: 'right' }, { label: 'Share', width: 1, align: 'right' }],
      rows: cats.map(c => [c.category, fmtQty(c.qty), inr(c.sales), inr(c.tax), `${c.contribution}%`]),
    },
  ];

  if (d.floorPnl.length) {
    tables.push({
      title: 'Floor P&L (different basis — read the note)',
      columns: [
        { label: 'Floor', width: 3 }, { label: 'Sales', width: 2, align: 'right' },
        { label: 'Food cost', width: 2, align: 'right' }, { label: 'Gross profit', width: 2, align: 'right' },
        { label: 'GP %', width: 1, align: 'right' },
      ],
      rows: d.floorPnl.map(f => [f.floor, inr(f.sales), inr(f.cost), inr(f.grossProfit), `${f.gpPct}%`]),
      note: 'This block alone is costed from the recipe-cost sales table (normal bills only), NOT from the bill totals above. '
        + 'Its Sales column will not tie to Net collected and is not meant to.',
    });
  }

  if (d.cancelBreakup.orderCancel.count) {
    tables.push({
      title: 'Cancelled bills',
      columns: [{ label: 'Kind', width: 4 }, { label: 'Count', width: 1, align: 'right' }, { label: 'Amount', width: 2, align: 'right' }],
      rows: [['Bills voided by a person', fmtCount(d.cancelBreakup.orderCancel.count), inr(d.cancelBreakup.orderCancel.amount)]],
      note: 'Human voids only. Tables closed automatically by the idle-table sweep are deliberately excluded — nobody cancelled those.',
    });
  }

  const pdf = await buildReportPdf({
    title: 'Daily Ops Report',
    businessName: headerName(db, outletId ?? null),
    period: humanDate(date),
    subtitle: 'Settled sales for the IST day, as shown on the Sales Dashboard.',
    kpis: [
      { label: 'Net collected', value: inr(d.day.net), sub: `${fmtCount(d.day.orders)} bill(s)` },
      {
        label: 'Covers', value: d.performanceDay.covers > 0 ? fmtCount(d.performanceDay.covers) : 'not recorded',
        sub: d.performanceDay.covers > 0 ? `${inr(d.performanceDay.avgPerCover)} per cover` : undefined,
      },
      { label: 'Average bill', value: inr(d.performanceDay.avgOrderValue), sub: `${fmtCount(d.performanceDay.avgOrderTimeMin)} min at table` },
      { label: 'Discount given', value: inr(d.day.discount) },
      { label: 'Tax collected', value: inr(d.day.tax) },
      { label: 'Month to date', value: inr(d.mtd.net), sub: `${fmtCount(d.mtd.orders)} bill(s)` },
    ],
    tables,
    footnotes: [
      'Every figure here is read from the same function the Sales Dashboard renders, for the same IST day, so the two cannot disagree.',
      'Only settled bills count. Open tables and voided bills are not sales.',
      'Confidential — internal trading figures.',
    ],
    generatedAtMs: args.generatedAtMs,
  });

  return {
    key, period: date, empty: false, emptyReason: '',
    vars, paramOrder: DAILY_OPS_PARAMS, params: paramsFrom(vars, DAILY_OPS_PARAMS),
    text, filename: fileNameFor(db, key, date), mime: 'application/pdf', pdf,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. STOCK DIFFERENCES  (scheduled)
 * ════════════════════════════════════════════════════════════════════════ */

export const STOCK_DIFF_PARAMS = [
  'date', 'counted', 'differed', 'total_value', 'held', 'applied', 'largest', 'basis',
];

/**
 * The day's closing-count differences.
 *
 * THE RAIL. The scout's recommendation, and it is the right one: the CENTRAL
 * closing-count digest, buildCountDigest(). It is the only difference rail in
 * the app that is already a per-day, per-outlet, human-readable statement of
 * what a count found, it is written on every count save, and it already
 * enforces the two rules a naive report would break:
 *
 *   · DEPARTMENT LINES GET NO RUPEE FIGURE. A department row's stored variance
 *     is measured against the CENTRAL pool, not that department's balance, so
 *     valuing it prints a confident wrong number. The digest counts those lines
 *     and says why they carry no money; this report repeats that and never
 *     totals them.
 *   · The digest's own valuation basis (last purchase where there is one) is
 *     NOT the approval queue's (average cost), so the two totals can differ.
 *     The sentence says so. Do not "fix" that by re-valuing here.
 *
 * The LIQUOR rail is built too, because a venue counts both and a report that
 * silently covered one would read as "nothing differed" on a night the bar was
 * out by ₹40,000.
 *
 * THE LINES on the PDF come from listVarianceApprovals() — the /variance-approvals
 * queue's own reader, same filters, same outlet scope — so the PDF and the
 * screen list the same rows in the same order.
 *
 * EMPTY = nobody counted anything that day on either rail. A count that found
 * no difference is NOT empty: "42 lines counted, nothing differed" is exactly
 * the message a manager needs to see, and suppressing it would make silence
 * ambiguous between "all good" and "nobody counted".
 */
export async function buildStockDifferenceReport(
  db: Database.Database,
  args: { date: string; outletId?: string | null; lineLimit?: number; generatedAtMs?: number },
): Promise<BuiltReport> {
  const date = norm(args.date);
  const key = 'stock_differences';
  if (!isYmd(date)) return emptyReport(key, date, 'Stock difference report needs a YYYY-MM-DD date.');
  const outletId = args.outletId === undefined ? defaultOutletId(db) : args.outletId;

  const central: CountDigest = buildCountDigest(db, { date, outlet_id: outletId, rail: 'central' });
  const liquor: CountDigest = buildCountDigest(db, { date, outlet_id: outletId, rail: 'liquor' });
  const rails = [{ name: 'Central store', d: central }, { name: 'Liquor store', d: liquor }]
    .filter(r => r.d.counted > 0);

  if (!rails.length) {
    return emptyReport(key, date,
      `No closing count was recorded on ${humanDate(date)} — there is no difference to report.`,
      { date: humanDate(date) }, ['date']);
  }

  const counted = rails.reduce((s, r) => s + r.d.counted, 0);
  const differed = rails.reduce((s, r) => s + r.d.differed, 0);
  const totalValue = rails.reduce((s, r) => s + r.d.total_value, 0);
  const heldCount = rails.reduce((s, r) => s + r.d.held_count, 0);
  const heldValue = rails.reduce((s, r) => s + r.d.held_value, 0);
  const appliedCount = rails.reduce((s, r) => s + r.d.applied_count + r.d.admin_applied_count, 0);
  const appliedValue = rails.reduce((s, r) => s + r.d.applied_value + r.d.admin_applied_value, 0);
  const deptLines = rails.reduce((s, r) => s + r.d.dept_lines, 0);

  // The three biggest across both rails, by absolute rupee impact — the digest
  // already picked each rail's own top three and valued them.
  const largest = rails.flatMap(r => r.d.largest)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 3);
  const largestLine = largest.length
    ? largest.map(l => `${l.material_name} ${fmtQty(l.qty)} ${l.unit} ${inrSignedText(l.value)}`).join('; ')
    : 'none';

  const basis = 'Valued at last purchase where there is one; the approval queue prices the same rows at average cost, so the two totals can differ.';

  const vars: Record<string, string | number> = {
    date: humanDate(date),
    counted: fmtCount(counted),
    differed: fmtCount(differed),
    total_value: inrSignedText(totalValue),
    held: `${fmtCount(heldCount)} (${inrSignedText(heldValue)})`,
    applied: `${fmtCount(appliedCount)} (${inrSignedText(appliedValue)})`,
    largest: largestLine,
    basis,
  };

  const deptSentence = deptLines
    ? `\n${fmtCount(deptLines)} department line(s) counted — deliberately given no rupee figure: a department row's difference is measured against the central pool, not that department's own balance.`
    : '';

  const text =
    `📦 Stock differences — ${humanDate(date)}\n\n`
    + rails.map(r => `*${r.name}*\n${r.d.label}`).join('\n\n')
    + deptSentence
    + (differed ? `\n\nStill waiting on an admin: ${fmtCount(heldCount)} line(s), ${inrSignedText(heldValue)}.` : '');

  /* The LINES — the queue's own reader, same day, same outlet scope. */
  const lineLimit = Math.max(1, Math.floor(Number(args.lineLimit) || 60));
  const listed = listVarianceApprovals(db, {
    status: 'all', from: date, to: date,
    outletId: outletId ?? null, outletScope: 'outlet', limit: lineLimit,
  });

  const tables: PdfTable[] = [
    {
      title: 'What the count found',
      columns: [
        { label: 'Rail', width: 3 }, { label: 'Counted', width: 1, align: 'right' },
        { label: 'Differed', width: 1, align: 'right' }, { label: 'Net value', width: 2, align: 'right' },
        { label: 'Held', width: 1, align: 'right' }, { label: 'Held value', width: 2, align: 'right' },
      ],
      rows: rails.map(r => [
        r.name, fmtCount(r.d.counted), fmtCount(r.d.differed), inr(r.d.total_value),
        fmtCount(r.d.held_count), inr(r.d.held_value),
      ]),
      note: basis,
    },
    {
      title: `Difference lines (${listed.rows.length}${listed.truncated ? ` of ${listed.total}` : ''})`,
      columns: [
        { label: 'Material', width: 5 }, { label: 'Where', width: 3 },
        { label: 'System', width: 1.4, align: 'right' }, { label: 'Counted', width: 1.4, align: 'right' },
        { label: 'Diff', width: 1.4, align: 'right' }, { label: 'Value', width: 2, align: 'right' },
        { label: 'Status', width: 1.6 },
      ],
      rows: listed.rows.map((r: any) => [
        r.material_name,
        norm(r.department_name) || norm(r.store_name) || 'Central',
        fmtQty(r.system_stock), fmtQty(r.physical_stock), fmtQty(r.variance),
        // A department row's ₹ is the central-pool artefact described above.
        // It is refused a rupee figure HERE too, not just in the totals.
        norm(r.department_name) ? '—' : inr(r.variance_value),
        r.auto_applied ? `${r.status} (auto)` : S(r.status),
      ]),
      emptyNote: 'No line from this count reached the approval queue.',
      note: 'Quantities are in the units the count was recorded in. Department rows show "—" for value on purpose: '
        + 'their stored difference is against the central pool, so a rupee figure there would describe the wrong comparison.'
        + (listed.truncated ? ` Only the first ${listed.rows.length} of ${listed.total} lines are listed — open the Variance Approvals page for the rest.` : ''),
    },
  ];

  const unvalued = rails.flatMap(r => r.d.unvalued);
  if (unvalued.length) {
    tables.push({
      title: 'Real differences carrying NO rupee figure',
      columns: [{ label: 'Material', width: 5 }, { label: 'Quantity', width: 2, align: 'right' }, { label: 'Why', width: 4 }],
      rows: unvalued.map(l => [
        l.material_name, `${fmtQty(l.qty)} ${l.unit}`,
        l.unvalued === 'implausible_rate' ? 'Stored rate is above anything ever paid — not believed' : 'No rate on record',
      ]),
      note: 'These are NOT in the totals above. They are listed by quantity, which cannot be compared between materials.',
    });
  }

  const pdf = await buildReportPdf({
    title: 'Stock Differences',
    businessName: headerName(db, outletId ?? null),
    period: humanDate(date),
    subtitle: 'Closing-count differences, as recorded by the count digest and the variance approval queue.',
    kpis: [
      { label: 'Lines counted', value: fmtCount(counted), sub: deptLines ? `${fmtCount(deptLines)} department line(s)` : undefined },
      { label: 'Lines differed', value: fmtCount(differed) },
      { label: 'Net difference', value: inr(totalValue) },
      { label: 'Held for approval', value: fmtCount(heldCount), sub: inr(heldValue) },
      { label: 'Already applied', value: fmtCount(appliedCount), sub: inr(appliedValue) },
      { label: 'Rails counted', value: rails.map(r => r.name.split(' ')[0]).join(' + ') },
    ],
    tables,
    footnotes: [
      basis,
      'Department lines are counted but never valued — their stored difference is measured against the central pool, not the department balance.',
      'Held lines have moved no stock. Applied lines already have.',
      'Confidential — internal stock figures.',
    ],
    generatedAtMs: args.generatedAtMs,
  });

  return {
    key, period: date, empty: false, emptyReason: '',
    vars, paramOrder: STOCK_DIFF_PARAMS, params: paramsFrom(vars, STOCK_DIFF_PARAMS),
    text, filename: fileNameFor(db, key, date), mime: 'application/pdf', pdf,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. PRICE HIKE ALERT  (event)
 * ════════════════════════════════════════════════════════════════════════ */

export const PRICE_HIKE_PARAMS = ['material', 'old_rate', 'new_rate', 'pct', 'vendor', 'date'];

/** The configured trip point, settings key `price_hike_threshold_pct`. Default 10 —
 *  the same default /api/cost-spikes has always used. */
export function priceHikeThreshold(db: Database.Database): number {
  const v = Number(setting(db, 'price_hike_threshold_pct', '10'));
  return Number.isFinite(v) && v > 0 ? v : 10;
}

/**
 * A purchase came in above the material's own history by more than the
 * configured threshold.
 *
 * BASIS. costSpikes() — the query behind the home dashboard's cost-spike card,
 * moved into a lib for exactly this reason. "Old rate" is that card's
 * `avg_price`: the average of EVERY purchase of the material, which is what the
 * screen compares against. It is not "the previous purchase" and the message
 * must not call it that.
 *
 * THE UNIT IS THE PURCHASE UNIT. purchases.unit_price is ₹ per purchase unit,
 * so the rate is per case / per bag / per bottle, not per kg. The message says
 * which. Printing it against the recipe unit would understate a case rate by
 * the pack size — the exact class of error [[project_fnb_unit_convention]]
 * exists to stop.
 *
 * `materialIds` narrows the scan to the materials a just-saved bill touched, so
 * an event caller alerts on THIS purchase rather than on the whole backlog.
 * Omit it for the "what is up this week" digest.
 *
 * EMPTY = nothing over the threshold. Silence is the correct output.
 */
export async function buildPriceHikeAlert(
  db: Database.Database,
  args: {
    materialIds?: string[];
    thresholdPct?: number;
    minPurchases?: number;
    limit?: number;
    outletId?: string | null;
    period?: string;
    generatedAtMs?: number;
  } = {},
): Promise<BuiltReport> {
  const key = 'price_hike';
  const threshold = Number(args.thresholdPct ?? priceHikeThreshold(db));
  const period = norm(args.period) || new Date().toISOString().slice(0, 10);

  const res = costSpikes(db, {
    thresholdPct: threshold,
    minPurchases: args.minPurchases ?? 2,
    limit: args.limit ?? 50,
  });

  const wanted = Array.isArray(args.materialIds) && args.materialIds.length
    ? new Set(args.materialIds.map(String))
    : null;
  const spikes: CostSpikeRow[] = wanted ? res.spikes.filter(s => wanted.has(String(s.id))) : res.spikes;

  if (!spikes.length) {
    return emptyReport(key, period,
      wanted
        ? 'No purchased item came in above its usual rate by the configured threshold.'
        : `No item is currently ${threshold}% or more above its own average purchase rate.`,
      { pct: threshold }, ['pct']);
  }

  const top = spikes[0];
  const rateUnit = (r: CostSpikeRow) => norm(r.purchase_unit) || norm(r.unit) || 'unit';
  const vars: Record<string, string | number> = {
    material: top.name,
    old_rate: `${inrText(top.avg_price)}/${rateUnit(top)}`,
    new_rate: `${inrText(top.latest_price)}/${rateUnit(top)}`,
    pct: `${Number(top.pct_change).toFixed(2)}%`,
    vendor: norm(top.latest_vendor) || 'vendor not recorded',
    date: humanDate(norm(top.latest_date)) || norm(top.latest_date),
  };

  const line = (r: CostSpikeRow) =>
    `• ${r.name} — was ${inrText(r.avg_price)}, now ${inrText(r.latest_price)} per ${rateUnit(r)} `
    + `(+${Number(r.pct_change).toFixed(1)}%) from ${norm(r.latest_vendor) || 'vendor not recorded'} on ${norm(r.latest_date)}`;

  const head = spikes.length === 1
    ? `⚠️ Price hike — ${top.name}`
    : `⚠️ Price hikes — ${fmtCount(spikes.length)} item(s) over ${threshold}%`;

  const text =
    `${head}\n\n`
    + spikes.slice(0, 10).map(line).join('\n')
    + (spikes.length > 10 ? `\n…and ${fmtCount(spikes.length - 10)} more.` : '')
    + `\n\n"Was" is the average of every purchase of that item, not the last one. Rates are per purchase unit.`;

  // ONE spike is a message, not a document. A PDF is only worth a recipient's
  // tap when there is a list to work through.
  let pdf: Buffer | null = null;
  let filename = '';
  if (spikes.length > 1) {
    filename = fileNameFor(db, key, period);
    pdf = await buildReportPdf({
      title: 'Price Hike Alert',
      businessName: headerName(db, args.outletId === undefined ? defaultOutletId(db) : (args.outletId ?? null)),
      period: `${fmtCount(spikes.length)} item(s) at or above +${threshold}%`,
      subtitle: 'Latest purchase rate against the item\'s own average purchase rate, as shown on the dashboard cost-spike card.',
      kpis: [
        { label: 'Items over threshold', value: fmtCount(spikes.length) },
        { label: 'Biggest jump', value: `+${Number(top.pct_change).toFixed(1)}%`, sub: top.name },
        { label: 'Threshold', value: `+${threshold}%` },
      ],
      tables: [{
        columns: [
          { label: 'Item', width: 4 }, { label: 'Category', width: 2 },
          { label: 'Avg rate', width: 1.6, align: 'right' }, { label: 'Latest rate', width: 1.6, align: 'right' },
          { label: 'Per', width: 1.2 }, { label: 'Change', width: 1.2, align: 'right' },
          { label: 'Vendor', width: 2.4 }, { label: 'On', width: 1.6 },
        ],
        rows: spikes.map(r => [
          r.name, norm(r.category) || '—', inr(r.avg_price), inr(r.latest_price), rateUnit(r),
          `+${Number(r.pct_change).toFixed(1)}%`, norm(r.latest_vendor) || '—', norm(r.latest_date),
        ]),
        note: 'Rates are rupees per PURCHASE unit (case / bag / bottle), the basis purchases are entered in — not per recipe unit. '
          + '"Avg rate" is the average across every recorded purchase of that item, not the previous one.',
      }],
      footnotes: [
        `Trip point: latest rate at or above the item's average by ${threshold}% (settings key price_hike_threshold_pct).`,
        'Items with only one recorded purchase are skipped — one purchase has no history to be above.',
        'Confidential — internal purchase rates.',
      ],
      generatedAtMs: args.generatedAtMs,
    });
  }

  return {
    key, period, empty: false, emptyReason: '',
    vars, paramOrder: PRICE_HIKE_PARAMS, params: paramsFrom(vars, PRICE_HIKE_PARAMS),
    text, filename, mime: 'application/pdf', pdf,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. DISCOUNT ALERT  (event)
 * ════════════════════════════════════════════════════════════════════════ */

export const DISCOUNT_ALERT_PARAMS = ['order', 'pct', 'amount', 'table', 'decision', 'decided_by', 'requested_by', 'reason'];

/**
 * A bill discount (or a service-charge waiver) was decided.
 *
 * BASIS. listDiscountRequests() — the approval queue's own reader, which also
 * computes `impact_amount` (subtotal × pct ÷ 100, the same arithmetic the
 * decide route writes onto the order). Nothing is recomputed here.
 *
 * A SERVICE-CHARGE WAIVER HAS NO RUPEE FIGURE YET, and the queue says so:
 * its exact ₹ is only known at settle (subtotal × service-charge %), so
 * impact_amount is 0 and this message calls it a waiver instead of printing
 * "₹0", which would read as "nothing was given away".
 *
 * EMPTY = no such request. Never a PDF: an alert about one bill is a sentence.
 */
export async function buildDiscountAlert(
  db: Database.Database,
  args: { requestId: string },
): Promise<BuiltReport> {
  const key = 'discount_alert';
  const id = norm(args.requestId);
  if (!id) return emptyReport(key, '', 'No discount request id given.');

  const rows = listDiscountRequests(db, 'WHERE dr.id = ?', [id]);
  const r: any = rows[0];
  if (!r) return emptyReport(key, id, 'That discount request no longer exists.');

  const isWaiver = r.kind === 'service_charge';
  const pct = Number(r.requested_pct) || 0;
  const table = norm(r.table_number)
    ? `${norm(r.zone) ? norm(r.zone) + ' ' : ''}Table ${norm(r.table_number)}`
    : (norm(r.order_type) || 'Order');
  const amount = isWaiver
    ? 'service charge waived (exact ₹ set at settle)'
    : inrText(r.impact_amount);
  const decision = norm(r.status) || 'pending';

  const vars: Record<string, string | number> = {
    order: `#${norm(r.order_number) || norm(r.order_id)}`,
    pct: isWaiver ? 'service charge' : `${pct}%`,
    amount,
    table,
    decision,
    decided_by: norm(r.decided_by) || '—',
    requested_by: norm(r.requester_name) || norm(r.requested_by) || '—',
    reason: norm(r.reason) || '—',
  };

  const icon = decision === 'approved' ? '✅' : decision === 'rejected' ? '⛔' : '⏳';
  const text =
    `${icon} Discount ${decision} — bill #${norm(r.order_number) || norm(r.order_id)}\n\n`
    + (isWaiver
      ? `Service charge waiver on ${table}\n`
      : `${pct}% off ${table} — ${inrText(r.impact_amount)} on a ${inrText(r.order_subtotal)} sub-total\n`)
    + `Asked by: ${vars.requested_by}\n`
    + (decision === 'pending' ? 'Waiting for a manager.\n' : `Decided by: ${vars.decided_by}\n`)
    + `Reason: ${vars.reason}`
    + (norm(r.decided_note) ? `\nNote: ${norm(r.decided_note)}` : '');

  return {
    key, period: id, empty: false, emptyReason: '',
    vars, paramOrder: DISCOUNT_ALERT_PARAMS, params: paramsFrom(vars, DISCOUNT_ALERT_PARAMS),
    text, filename: '', mime: 'application/pdf', pdf: null,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. CRM DAILY OVERVIEW  (scheduled)
 * ════════════════════════════════════════════════════════════════════════ */

export const CRM_DAILY_PARAMS = ['date', 'calls', 'answered', 'missed', 'answered_pct', 'bookings', 'threads', 'pending'];

/** IST calendar date of a UTC instant — the same +05:30 convention as ct/metrics. */
function istDateOf(ms: number): string {
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
}

/** Whole IST days between two YYYY-MM-DD dates (b − a). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Calls, missed, bookings and WhatsApp threads for one day.
 *
 * BASIS — AND THE TRICK THAT KEEPS IT HONEST. dashboardStats() is the CRM
 * dashboard's own aggregator, but its window always ENDS at the end of IST
 * today; it has no "give me one past day" mode. Its `byDay` series does carry
 * per-date calls/answered/missed, so those come straight off it.
 *
 * Its BOOKING figures are window totals, not a series. Rather than write a
 * second bookings query that could drift from the dashboard's (live rows only,
 * duplicates excluded, call-linked), this takes the DIFFERENCE OF TWO NESTED
 * WINDOWS: funnel(days = N) − funnel(days = N−1) is exactly the day N−1 days
 * back, because both windows end at the same instant. The arithmetic is on the
 * dashboard's own numbers, so the day figure cannot disagree with the window
 * figure the screen shows.
 *
 * `pending_recoveries` is deliberately NOT window-bound (its type says so): it
 * is the CURRENT open missed-call queue, and it is labelled "open now".
 *
 * THREADS is the one figure with no existing computation — the WhatsApp inbox
 * has no stats function — so it is written here once, and it counts
 * CONVERSATIONS TOUCHED that IST day, inbound and outbound separately, off
 * wa_messages. It is named `threads`/`threads_in`/`threads_out` and nothing
 * else in the app publishes a number by those names.
 *
 * EMPTY = no call, no booking and no WhatsApp thread that day.
 */
export async function buildCrmDailyOverview(
  db: Database.Database,
  args: { date: string; outletId?: string | null; nowMs?: number; generatedAtMs?: number },
): Promise<BuiltReport> {
  const key = 'crm_daily';
  const date = norm(args.date);
  if (!isYmd(date)) return emptyReport(key, date, 'CRM daily overview needs a YYYY-MM-DD date.');

  const nowMs = args.nowMs ?? Date.now();
  const today = istDateOf(nowMs);
  const back = daysBetween(date, today);            // 0 = today, 1 = yesterday, …
  if (back < 0) {
    return emptyReport(key, date, `${humanDate(date)} has not happened yet.`);
  }
  if (back > 89) {
    return emptyReport(key, date, `${humanDate(date)} is outside the 90-day CRM window the dashboard reads.`);
  }

  const wide = dashboardStats(db, { days: back + 1 });
  const day = (wide.byDay || []).find((d: any) => d.date === date);

  // Nested-window difference — see the header note.
  const narrow = back > 0 ? dashboardStats(db, { days: back }) : null;
  const dayBookings = Math.max(0, (wide.funnel?.booked || 0) - (narrow?.funnel?.booked || 0));
  const daySeated = Math.max(0, (wide.funnel?.seated || 0) - (narrow?.funnel?.seated || 0));
  const dayRecovered = Math.max(0, (wide.recoveryFunnel?.recovered || 0) - (narrow?.recoveryFunnel?.recovered || 0));

  /* THREADS — new here; nothing else in the app counts this. */
  let threadsIn = 0, threadsOut = 0, threadsTotal = 0, msgsIn = 0, msgsOut = 0;
  try {
    const t = db.prepare(`
      SELECT COUNT(DISTINCT conversation_id)                                                     AS threads,
             COUNT(DISTINCT CASE WHEN direction = 'in'  THEN conversation_id END)                AS threads_in,
             COUNT(DISTINCT CASE WHEN direction = 'out' THEN conversation_id END)                AS threads_out,
             SUM(CASE WHEN direction = 'in'  THEN 1 ELSE 0 END)                                  AS msgs_in,
             SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END)                                  AS msgs_out
        FROM wa_messages
       WHERE date(created_at, '+330 minutes') = ?
    `).get(date) as any;
    threadsTotal = Number(t?.threads) || 0;
    threadsIn = Number(t?.threads_in) || 0;
    threadsOut = Number(t?.threads_out) || 0;
    msgsIn = Number(t?.msgs_in) || 0;
    msgsOut = Number(t?.msgs_out) || 0;
  } catch { /* an install without the inbox tables reports zero threads, not a crash */ }

  const calls = day?.total || 0;
  const answered = day?.answered || 0;
  const missed = day?.missed || 0;
  const answeredPct = calls > 0 ? Math.round((answered / calls) * 1000) / 10 : 0;

  if (!calls && !dayBookings && !threadsTotal) {
    return emptyReport(key, date,
      `No calls, bookings or WhatsApp threads on ${humanDate(date)} — nothing to report.`,
      { date: humanDate(date) }, ['date']);
  }

  const vars: Record<string, string | number> = {
    date: humanDate(date),
    calls: fmtCount(calls),
    answered: fmtCount(answered),
    missed: fmtCount(missed),
    answered_pct: `${answeredPct}%`,
    bookings: fmtCount(dayBookings),
    threads: fmtCount(threadsTotal),
    pending: fmtCount(wide.today?.pending_recoveries ?? 0),
  };

  const agents = (wide.agents || []).slice().sort((a: any, b: any) => b.handled - a.handled).slice(0, 5);

  const text =
    `📞 CRM daily — ${humanDate(date)}\n\n`
    + `Calls ${fmtCount(calls)} · Answered ${fmtCount(answered)} (${answeredPct}%) · Missed ${fmtCount(missed)}\n`
    + `Bookings from calls: ${fmtCount(dayBookings)} · Seated: ${fmtCount(daySeated)}\n`
    + `WhatsApp threads active: ${fmtCount(threadsTotal)} (${fmtCount(msgsIn)} in / ${fmtCount(msgsOut)} out)\n`
    + `Missed calls still open now: ${fmtCount(wide.today?.pending_recoveries ?? 0)}`
    + (dayRecovered ? `\nRecovered on the day: ${fmtCount(dayRecovered)}` : '');

  const tables: PdfTable[] = [
    {
      title: 'The day',
      columns: [{ label: 'Measure', width: 3 }, { label: 'Value', width: 2, align: 'right' }],
      rows: [
        ['Calls', fmtCount(calls)],
        ['Answered', `${fmtCount(answered)} (${answeredPct}%)`],
        ['Missed', fmtCount(missed)],
        ['Bookings from calls', fmtCount(dayBookings)],
        ['…of which seated', fmtCount(daySeated)],
        ['Missed calls recovered', fmtCount(dayRecovered)],
        ['WhatsApp threads active', fmtCount(threadsTotal)],
        ['WhatsApp messages in / out', `${fmtCount(msgsIn)} / ${fmtCount(msgsOut)}`],
        ['Threads with an inbound / an outbound', `${fmtCount(threadsIn)} / ${fmtCount(threadsOut)}`],
      ],
      note: 'Call counts come from the CRM dashboard\'s own per-day series. Booking counts are that dashboard\'s window '
        + 'totals differenced across two nested windows, so they are the same population the screen shows.',
    },
    {
      title: `Agents (last ${back + 1} day${back ? 's' : ''}, not this day alone)`,
      columns: [
        { label: 'Agent', width: 3 }, { label: 'Handled', width: 1, align: 'right' },
        { label: 'Missed', width: 1, align: 'right' }, { label: 'Bookings', width: 1, align: 'right' },
      ],
      rows: agents.map((a: any) => [S(a.agent) || '—', fmtCount(a.handled), fmtCount(a.missed), fmtCount(a.bookings)]),
      emptyNote: 'No agent activity recorded in the window.',
      note: 'The agent table is a WINDOW figure and is labelled as one — the dashboard does not publish a per-agent per-day series, '
        + 'and inventing one here would put a number on this page that no screen could confirm.',
    },
  ];

  if (wide.unattributed && (wide.unattributed.calls || wide.unattributed.missed)) {
    tables.push({
      title: 'Calls nobody is credited with',
      columns: [{ label: 'Measure', width: 3 }, { label: 'Window total', width: 2, align: 'right' }],
      rows: [
        ['Inbound calls with no agent on the record', fmtCount(wide.unattributed.calls)],
        ['…of those, missed', fmtCount(wide.unattributed.missed)],
      ],
      note: 'These sit in no agent\'s answer-rate denominator. Read the agent table beside this or every answer rate above flatters.',
    });
  }

  const pdf = await buildReportPdf({
    title: 'CRM Daily Overview',
    businessName: headerName(db, args.outletId === undefined ? defaultOutletId(db) : (args.outletId ?? null)),
    period: humanDate(date),
    subtitle: 'Calls, bookings and WhatsApp threads, from the CRM dashboard\'s own aggregates.',
    kpis: [
      { label: 'Calls', value: fmtCount(calls), sub: `${answeredPct}% answered` },
      { label: 'Missed', value: fmtCount(missed), sub: `${fmtCount(wide.today?.pending_recoveries ?? 0)} open now` },
      { label: 'Bookings from calls', value: fmtCount(dayBookings), sub: `${fmtCount(daySeated)} seated` },
      { label: 'WhatsApp threads', value: fmtCount(threadsTotal), sub: `${fmtCount(msgsIn)} in / ${fmtCount(msgsOut)} out` },
    ],
    tables,
    footnotes: [
      'Missed calls still open is a LIVE queue depth, not a figure for this day — it is what is outstanding right now.',
      'Confidential — internal call and guest activity.',
    ],
    generatedAtMs: args.generatedAtMs,
  });

  return {
    key, period: date, empty: false, emptyReason: '',
    vars, paramOrder: CRM_DAILY_PARAMS, params: paramsFrom(vars, CRM_DAILY_PARAMS),
    text, filename: fileNameFor(db, key, date), mime: 'application/pdf', pdf,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. RESERVATION CONFIRMATION  (event, GUEST-FACING)
 * ════════════════════════════════════════════════════════════════════════ */

export const RESERVATION_PARAMS = ['guest_name', 'venue', 'date', 'time', 'party_size', 'reference'];

export interface ReservationConfirmation extends BuiltReport {
  /** The guest's number, so the caller does not have to re-read the booking. */
  guestPhone: string;
  guestName: string;
}

/**
 * Confirming a table to the GUEST. The only guest-facing builder here, and the
 * only one whose template must be a UTILITY template.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS IS THE ONE THAT LEAVES THE BUILDING. Everything else in this file   ║
 * ║ goes to our own staff about our own operation; this goes to a customer.  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * Three consequences, and they are why this builder refuses more than the rest:
 *   · UTILITY, never MARKETING. It confirms a transaction the guest initiated.
 *     A marketing-category template here is both a policy breach and a spam
 *     complaint. The category cannot be checked from a builder, so it is stated
 *     in the registry and belongs on the template at Meta.
 *   · NEVER for a cancelled, deleted or no-show booking. A confirmation for a
 *     table that is not held is worse than no message at all.
 *   · NO PDF. A guest gets a sentence, not an attachment.
 *
 * Nothing here is recomputed: a booking IS its stored row. Time falls back
 * through the three columns the Reservego import and the phone-booking form
 * each write (slot_time / booking_time / reserved_time) rather than picking one
 * and printing a blank for every booking that used another.
 */
export async function buildReservationConfirmation(
  db: Database.Database,
  args: { bookingId: string },
): Promise<ReservationConfirmation> {
  const key = 'reservation_confirmation';
  const id = norm(args.bookingId);
  const blank = (reason: string, period = id): ReservationConfirmation => ({
    ...emptyReport(key, period, reason), guestPhone: '', guestName: '',
  });
  if (!id) return blank('No booking id given.', '');

  let b: any;
  try {
    b = db.prepare(`
      SELECT b.*, g.name AS guest_name, g.phone_e164 AS guest_phone
        FROM ct_bookings b
        LEFT JOIN ct_guests g ON g.id = b.guest_id
       WHERE b.id = ?
    `).get(id);
  } catch { return blank('The reservation tables are not available on this install.'); }
  if (!b) return blank('That reservation no longer exists.');

  // AN ALLOWLIST, NOT A BLOCKLIST. The only statuses that mean a table IS held.
  // A blocklist of cancelled/no-show would have waved through 'pending', which
  // is ct_bookings' DEFAULT — every booking is pending the moment it is typed
  // in — and told a guest "your table is confirmed" about a request nobody had
  // accepted yet. The event to hang this on is the booking being CONFIRMED, not
  // the booking being created; a new status this list has never seen fails
  // closed, which for a message that leaves the building is the right way to
  // fail.
  const status = norm(b.status).toLowerCase();
  if (!['confirmed', 'booked', 'seated', 'completed'].includes(status)) {
    return blank(
      `Reservation ${id} is "${status || 'unset'}", not confirmed — a confirmation must never be sent for a table that is not held. `
      + 'Send it when the booking is confirmed.',
    );
  }
  if (Number(b.is_duplicate) === 1) {
    return blank('That reservation row is a superseded duplicate — the live row carries the confirmation.');
  }

  const phone = norm(b.guest_phone);
  if (!phone) return blank('That reservation has no guest phone number to confirm to.');

  const date = norm(b.booking_date) || norm(b.reserved_date);
  const time = norm(b.slot_time) || norm(b.booking_time) || norm(b.reserved_time);
  const guestName = norm(b.guest_name) || norm(b.reserved_by) || 'Guest';
  const party = Math.max(1, Math.floor(Number(b.party_size) || 0)) || 1;
  const venue = businessNameOf(db);
  const reference = norm(b.bill_number) || id.slice(0, 8).toUpperCase();

  const vars: Record<string, string | number> = {
    guest_name: guestName,
    venue,
    date: isYmd(date) ? humanDate(date) : (date || 'date to be confirmed'),
    time: time || 'time to be confirmed',
    party_size: String(party),
    reference,
  };

  const extras = [
    norm(b.occasion) ? `Occasion: ${norm(b.occasion)}` : '',
    norm(b.section_pref) || norm(b.sections) ? `Seating: ${norm(b.section_pref) || norm(b.sections)}` : '',
    Number(b.advance_amount) > 0 ? `Advance received: ${inrText(b.advance_amount)}` : '',
  ].filter(Boolean).join('\n');

  const text =
    `Hi ${guestName}, your table at ${venue} is confirmed.\n\n`
    + `Date: ${vars.date}\n`
    + `Time: ${vars.time}\n`
    + `Guests: ${party}\n`
    + (extras ? extras + '\n' : '')
    + `Reference: ${reference}\n\n`
    + `See you soon. Reply here if anything changes.`;

  return {
    key, period: id, empty: false, emptyReason: '',
    vars, paramOrder: RESERVATION_PARAMS, params: paramsFrom(vars, RESERVATION_PARAMS),
    text, filename: '', mime: 'application/pdf', pdf: null,
    guestPhone: phone, guestName,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7. TICKET PDF — NOT BUILT. READ THIS BEFORE BUILDING IT.
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THERE IS NO TICKET ENTITY IN THIS APPLICATION.                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * Searched at HEAD for a ticket to render. Every occurrence of "ticket" in the
 * source is one of three OTHER things:
 *
 *   1. a KOT — the kitchen ticket. Already prints on thermal paper; it is an
 *      instruction to a cook, not something a guest is sent.
 *   2. a RETURN ticket — the vendor-return document (settings/returns).
 *   3. the Lucide <Ticket/> ICON, used on a CRM quick-question button about
 *      entry and cover charges.
 *
 * There is no table, no id series, no price, no admit-count, no scan/redeem
 * state and no gate check anywhere in the schema. The nearest thing to an event
 * is ct_entertainment — a CALENDAR row (date, type, name, start/end time, area,
 * description). It has no ticket, no buyer, no seat, no amount and no status,
 * so a "ticket PDF" built on it would be a poster with a made-up number on it.
 *
 * ── WHY IT IS NOT GUESSED ────────────────────────────────────────────────
 * A ticket is admission. Inventing one means inventing what it admits, how many
 * people, whether it is transferable, what happens when it is presented twice,
 * and what the door staff compare it against. Every one of those is a business
 * decision, and getting any of them wrong produces a document that looks
 * official at the door and is not. The wrong ticket is worse than no ticket.
 *
 * ── WHAT THE OWNER MUST DECIDE (the shortest useful list) ────────────────
 *   · What is a ticket for — a paid event, a party cover charge, a table
 *     reservation with a deposit, or something else entirely?
 *   · What does one ticket admit — one person, one couple, one table?
 *   · Who issues it, and against what payment record?
 *   · Is it checked at the door, and against what — a code, a QR, a name list?
 *   · Can it be reused, transferred, refunded, cancelled?
 *
 * ── THE PLUMBING IS ALREADY HERE ─────────────────────────────────────────
 * When those are answered, a ticket builder needs NOTHING new from this rail:
 *   · write buildTicketPdf(db, {ticketId}) returning a BuiltReport, exactly
 *     like the six above (buildReportPdf() already draws A4, and the QR helpers
 *     used by the table-QR standees are in src/app/api/tables/qr/pdf/route.ts);
 *   · flip `unimplemented` to false on the 'ticket' entry in WA_REPORT_DEFS
 *     below and point `build` at it;
 *   · the send, storage, authed download, thread record and delivery ladder
 *     all already work — src/lib/wa-report-send.ts takes any bytes.
 * That is the whole change. Until the questions above are answered, the
 * registry entry refuses with the sentence in `unimplementedReason`, which is
 * what a caller sees instead of a wrong document.
 */
export const TICKET_NOT_DEFINED =
  'There is no ticket in this system yet. "Ticket" currently means a kitchen KOT, a vendor return document, '
  + 'or an icon — none of which is a document to send a guest. Before a ticket PDF can be built the owner must say '
  + 'what a ticket is: what it admits, how many people, who issues it against which payment, whether it is checked '
  + 'at the door and against what, and whether it can be reused or transferred. Building one on a guess would produce '
  + 'a document that looks official at the door and is not.';

/* ══════════════════════════════════════════════════════════════════════════
 * THE REGISTRY
 * ════════════════════════════════════════════════════════════════════════ */

export type ReportKind = 'scheduled' | 'event';

export interface ReportDef {
  key: string;
  label: string;
  kind: ReportKind;
  /** Who this is written for. 'guest' changes the template category required. */
  audience: 'management' | 'guest';
  /** MARKETING is never correct for any of these. */
  templateCategory: 'UTILITY';
  /** The named variables, in template order. */
  paramOrder: string[];
  /** true ⇒ there is no builder and there must not be one until it is defined. */
  unimplemented?: boolean;
  unimplementedReason?: string;
  /** Does a document ride along? 'never' | 'always' | 'sometimes'. */
  attachment: 'never' | 'always' | 'sometimes';
}

/**
 * Every report this rail knows how to build, and the one it deliberately does
 * not. The settings keys a scheduled report reads are derived from `key`:
 *   wa_report_<key>_enabled     '1' to send at all (default OFF)
 *   wa_report_<key>_recipients  comma-separated mobiles
 *   wa_report_<key>_template    an APPROVED template name at Meta
 *   wa_report_<key>_lang        template language, default 'en'
 * These live in their OWN namespace and NOT in `wa_notify_recipients` — that
 * blob is rebuilt from WA_NOTIFY_EVENTS on every save, which is the documented
 * way recipient lists have silently vanished before.
 */
export const WA_REPORT_DEFS: ReportDef[] = [
  { key: 'daily_ops', label: 'Daily ops report', kind: 'scheduled', audience: 'management', templateCategory: 'UTILITY', paramOrder: DAILY_OPS_PARAMS, attachment: 'always' },
  { key: 'stock_differences', label: 'Stock differences', kind: 'scheduled', audience: 'management', templateCategory: 'UTILITY', paramOrder: STOCK_DIFF_PARAMS, attachment: 'always' },
  { key: 'crm_daily', label: 'CRM daily overview', kind: 'scheduled', audience: 'management', templateCategory: 'UTILITY', paramOrder: CRM_DAILY_PARAMS, attachment: 'always' },
  { key: 'price_hike', label: 'Price hike alert', kind: 'event', audience: 'management', templateCategory: 'UTILITY', paramOrder: PRICE_HIKE_PARAMS, attachment: 'sometimes' },
  { key: 'discount_alert', label: 'Discount alert', kind: 'event', audience: 'management', templateCategory: 'UTILITY', paramOrder: DISCOUNT_ALERT_PARAMS, attachment: 'never' },
  { key: 'reservation_confirmation', label: 'Reservation confirmation (guest)', kind: 'event', audience: 'guest', templateCategory: 'UTILITY', paramOrder: RESERVATION_PARAMS, attachment: 'never' },
  {
    key: 'ticket', label: 'Ticket PDF', kind: 'event', audience: 'guest', templateCategory: 'UTILITY',
    paramOrder: [], attachment: 'always',
    unimplemented: true, unimplementedReason: TICKET_NOT_DEFINED,
  },
];

export function reportDef(key: string): ReportDef | undefined {
  return WA_REPORT_DEFS.find(d => d.key === key);
}
