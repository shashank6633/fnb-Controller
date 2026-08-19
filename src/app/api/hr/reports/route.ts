/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canManageHr, canAdminHr } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Reports dispatcher (/api/hr/reports) — Phase 7.
 * Contract: docs/HRMS_DECISIONS.md §4 (one file per report under
 * src/lib/reports/hr-*.ts, each owning COLUMNS + run(db, outletId, from, to)).
 * Shape copied from /api/reports/sales: isYmd validation, lazy import per
 * report so the (server-only) better-sqlite3 code never reaches the client.
 *
 * GET ?type=&from=&to=[&format=csv]
 *   type: attendance-register | leave-ledger | headcount | payroll-register
 *   from/to: YYYY-MM-DD (IST)
 *   → { type, from, to, columns, rows }  (JSON, default)
 *   → text/csv attachment                (?format=csv: UTF-8 BOM, RFC-4180
 *     escaping + the CWE-1236 formula-injection guard, hard row cap with an
 *     in-file truncation warning — HRMS_DECISIONS §4 CSV rules)
 *
 * Gates (the proxy does NOT protect API GETs — §2.1, this handler is the
 * boundary): every caller needs canManageHr (/hr/reports is mgmtOnly);
 * payroll-register additionally needs canAdminHr — it carries gross/net
 * salary figures, an adminOnly surface per §2.2. Errors return GENERIC
 * messages only (e.message can leak schema/PII for HR data).
 */
export const dynamic = 'force-dynamic';

interface ReportModule {
  COLUMNS: { k: string; label: string; num?: boolean; money?: boolean; pct?: boolean; date?: boolean; wide?: boolean }[];
  run: (db: any, outletId: string | null, from: string, to: string) => any[];
}

// Lazy import per report; adminOnly marks the salary-bearing surface.
const REPORTS: Record<string, { load: () => Promise<ReportModule>; adminOnly?: boolean }> = {
  'attendance-register': { load: () => import('@/lib/reports/hr-attendance-register') },
  'leave-ledger':        { load: () => import('@/lib/reports/hr-leave-ledger') },
  'headcount':           { load: () => import('@/lib/reports/hr-headcount') },
  'payroll-register':    { load: () => import('@/lib/reports/hr-payroll-register'), adminOnly: true },
};

const isYmd = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * CSV row cap. Every report here is an aggregation (per employee / per
 * department / per payslip line), so this is far above any realistic venue
 * size — but a cap plus an IN-FILE warning beats an open-ended string build
 * on the 1 GB box, and a silent cap would be read as data loss.
 */
const CSV_ROW_CAP = 20_000;

/**
 * RFC-4180 escaping PLUS the spreadsheet formula-injection guard (CWE-1236):
 * a cell starting with = + - @ TAB or CR executes in Excel/Sheets, so it is
 * prefixed with a quote. `numeric` opts a column OUT of the guard — set only
 * for num/money/pct columns the reader will sum (a negative figure in a
 * guarded column would arrive as text). Matched from the house CSV exports
 * (crm-calls/guests, crm/reservations/export).
 */
const csvCell = (v: unknown, numeric = false): string => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageHr(me)) {
      return Response.json({ error: 'Management access required' }, { status: 403 });
    }

    const sp = new URL(request.url).searchParams;
    const type = String(sp.get('type') || '');
    const def = Object.prototype.hasOwnProperty.call(REPORTS, type) ? REPORTS[type] : null;
    if (!def) return Response.json({ error: 'Unknown report type' }, { status: 400 });
    if (def.adminOnly && !canAdminHr(me)) {
      return Response.json({ error: 'Payroll Register is admin-only' }, { status: 403 });
    }

    const from = sp.get('from');
    const to = sp.get('to');
    if (!isYmd(from) || !isYmd(to)) {
      return Response.json({ error: 'from and to (YYYY-MM-DD) are required' }, { status: 400 });
    }
    if (from > to) {
      return Response.json({ error: 'from must be on or before to' }, { status: 400 });
    }

    const db = getDb();
    const outletId = await getCurrentOutletId();

    // Attendance reads sweep stale open days first (owner ruling §8.4b —
    // "yesterday can never render PRESENT"), so Missing Checkouts are current
    // even when nobody has opened /hr/attendance. Idempotent; lazy-imported
    // like the report modules so the engine stays server-only.
    if (type === 'attendance-register') {
      const { sweepStaleOpenDays } = await import('@/lib/hr-attendance');
      sweepStaleOpenDays(db);
    }

    const mod = await def.load();
    const rows = mod.run(db, outletId, from, to);

    if (String(sp.get('format') || '') === 'csv') {
      // The BOM makes Excel read the file as UTF-8 (names like "Priyā" would
      // otherwise open as mojibake).
      const cols = mod.COLUMNS;
      const lines: string[] = [cols.map((c) => csvCell(c.label)).join(',')];
      const capped = rows.slice(0, CSV_ROW_CAP);
      for (const r of capped) {
        lines.push(cols.map((c) => csvCell(r[c.k], !!(c.num || c.money || c.pct))).join(','));
      }
      if (rows.length > CSV_ROW_CAP) {
        // The warning lives INSIDE the file — a truncated export that looks
        // complete would be read as the venue's whole truth.
        lines.push(csvCell(
          `TRUNCATED: showing first ${CSV_ROW_CAP} of ${rows.length} rows - narrow the date range and export again for the rest`,
        ));
      }
      const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="hr-${type}_${from}_to_${to}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return Response.json({ type, from, to, columns: mod.COLUMNS, rows });
  } catch (e) {
    console.error('[/api/hr/reports]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to build report' }, { status: 500 });
  }
}
