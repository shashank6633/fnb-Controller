'use client';

/**
 * HR Reports (/hr/reports — mgmtOnly in the catalog; the API is the real
 * boundary). Four reports over a date range, structure copied from
 * src/app/reports/sales/page.tsx: report tab selector + date range +
 * column-spec table with tfoot totals + CSV download.
 *
 * Columns come from the API (each src/lib/reports/hr-*.ts file owns its
 * COLUMNS spec — this page renders whatever spec arrives). The CSV is built
 * SERVER-side (?format=csv: UTF-8 BOM + formula-injection guard + row cap)
 * and fetched as a blob here — never an <a href> ending in an asset
 * extension (proxy path rules).
 *
 * Payroll Register is admin-gated at the API (salary data, contract §2.2):
 * a manager opening that tab gets a plain admin-only lock message; the other
 * tabs keep working for them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3, Download, Loader2, AlertTriangle, Lock, CalendarDays, RefreshCw,
} from 'lucide-react';
import TabScroller from '@/components/TabScroller';
import { fmtIST, todayIST } from '@/lib/format-date';

type Col = { k: string; label: string; num?: boolean; money?: boolean; pct?: boolean; date?: boolean; wide?: boolean };

const REPORTS: { key: string; label: string; adminOnly?: boolean }[] = [
  { key: 'attendance-register', label: 'Attendance Register' },
  { key: 'leave-ledger',        label: 'Leave Ledger' },
  { key: 'headcount',           label: 'Headcount' },
  { key: 'payroll-register',    label: 'Payroll Register', adminOnly: true },
];

function istMonthStart(): string {
  return todayIST().slice(0, 8) + '01';
}
const money = (n: number) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const num = (n: number) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export default function HrReportsPage() {
  const [tab, setTab] = useState('attendance-register');
  const [from, setFrom] = useState(istMonthStart);
  const [to, setTo] = useState(todayIST);
  const [rows, setRows] = useState<any[]>([]);
  const [cols, setCols] = useState<Col[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);      // whole module (not management)
  const [adminLocked, setAdminLocked] = useState(false);  // this tab only (payroll for a manager)
  const [exporting, setExporting] = useState(false);

  const def = useMemo(() => REPORTS.find((r) => r.key === tab) || REPORTS[0], [tab]);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setAdminLocked(false);
    try {
      const res = await fetch(`/api/hr/reports?type=${tab}&from=${from}&to=${to}`, { cache: 'no-store' });
      if (res.status === 401 || res.status === 403) {
        const j = await res.json().catch(() => ({}));
        // The API's payroll gate is per-report: a manager keeps the other
        // three tabs, so only this tab locks — the module lock is for
        // callers without management access at all.
        if (res.status === 403 && /admin/i.test(String(j?.error || ''))) {
          setAdminLocked(true); setRows([]); setCols([]);
        } else {
          setForbidden(true);
        }
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error || `HTTP ${res.status}`); setRows([]); return; }
      setRows(Array.isArray(j.rows) ? j.rows : []);
      setCols(Array.isArray(j.columns) ? j.columns : []);
    } catch { setError('Network error — could not load the report'); setRows([]); }
    finally { setLoading(false); }
  }, [tab, from, to]);

  useEffect(() => { load(); }, [load]);

  // Column totals (numeric/money columns only; pct columns aren't summed).
  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const c of cols) {
      if ((c.num || c.money) && !c.pct) t[c.k] = rows.reduce((s, r) => s + (Number(r[c.k]) || 0), 0);
    }
    return t;
  }, [rows, cols]);

  const fmt = (c: Col, v: any) =>
    c.money ? money(v) : c.pct ? `${num(v)}%` : c.num ? num(v) : c.date ? (fmtIST(v) || '—') : (v === '' || v === null || v === undefined ? '—' : v);

  // Server-built CSV (BOM + injection guard + row cap live in the API) —
  // fetched as a blob so the download stays same-origin and cookie-authed.
  const downloadCsv = async () => {
    setExporting(true); setError(null);
    try {
      const res = await fetch(`/api/hr/reports?type=${tab}&from=${from}&to=${to}&format=csv`, { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j?.error || 'Could not export the CSV');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hr-${tab}_${from}_to_${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { setError('Network error — could not export the CSV'); }
    finally { setExporting(false); }
  };

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="max-w-sm text-center text-[#6B5744]">
          <Lock className="w-10 h-10 mx-auto mb-3 text-[#af4408]" />
          <h1 className="text-lg font-bold text-[#2D1B0E]">Management only</h1>
          <p className="text-sm mt-1">HR Reports are restricted to managers, HODs and admins.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <BarChart3 className="w-6 h-6" /> HR Reports
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Attendance, leave, headcount and payroll over a date range.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 bg-white border border-[#E8D5C4] rounded-xl px-2.5 py-1.5 shadow-sm">
              <CalendarDays className="w-4 h-4 text-[#8B7355] shrink-0" />
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
                     className="bg-transparent text-sm focus:outline-none text-[#2D1B0E] w-[8rem]" aria-label="From date" />
              <span className="text-[#C4B09A]">–</span>
              <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)}
                     className="bg-transparent text-sm focus:outline-none text-[#2D1B0E] w-[8rem]" aria-label="To date" />
            </div>
            <button onClick={load}
                    className="p-2.5 bg-white border border-[#E8D5C4] rounded-xl text-[#8B7355] hover:bg-[#FFF1E3] shadow-sm"
                    aria-label="Refresh" title="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={downloadCsv} disabled={!rows.length || exporting}
                    className="flex items-center gap-2 px-3 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-xl text-sm font-semibold shadow-sm">
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} CSV
            </button>
          </div>
        </div>

        {/* Report tabs */}
        <TabScroller className="gap-1.5">
          {REPORTS.map((r) => (
            <button key={r.key} onClick={() => setTab(r.key)}
                    className={`px-3.5 py-2 rounded-full border text-sm font-medium transition-colors ${
                      tab === r.key
                        ? 'bg-[#af4408] text-white border-[#af4408]'
                        : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                    }`}>
              {r.label}
            </button>
          ))}
        </TabScroller>

        {/* Error banner */}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
            <span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4 shrink-0" />{error}</span>
            <button onClick={load}
                    className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
              Retry
            </button>
          </div>
        )}

        {/* Table */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          {loading ? (
            <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          ) : adminLocked ? (
            <div className="p-8 text-center text-[#6B5744]">
              <Lock className="w-8 h-8 mx-auto mb-2 text-[#af4408]" />
              <p className="text-sm">{def.label} is admin-only.</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-center text-[#8B7355] text-sm">
              No rows for this date range.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                  <tr>
                    {cols.map((c) => (
                      <th key={c.k}
                          className={`py-2 px-3 font-medium whitespace-nowrap ${c.num || c.money || c.pct ? 'text-right' : 'text-left'}`}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]">
                      {cols.map((c) => (
                        <td key={c.k}
                            className={`py-2 px-3 ${c.num || c.money || c.pct ? 'text-right tabular-nums' : 'text-left'} ${
                              c.wide ? 'min-w-[240px] max-w-[440px] whitespace-normal break-words text-[13px]' : ''
                            } ${c.k === cols[0]?.k ? 'font-semibold text-[#2D1B0E]' : 'text-[#3D2614]'}`}>
                          {fmt(c, r[c.k])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF8F0] font-bold text-[#2D1B0E]">
                    {cols.map((c, idx) => (
                      <td key={c.k}
                          className={`py-2.5 px-3 ${c.num || c.money || c.pct ? 'text-right tabular-nums' : 'text-left'}`}>
                        {idx === 0 ? `Total (${rows.length})` : c.k in totals ? fmt(c, totals[c.k]) : ''}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        <p className="text-[11px] text-[#8B7355]">
          Dates are IST business days. Attendance figures come from the computed day summaries;
          payroll figures are the frozen run results (draft runs are labelled).
        </p>
      </div>
    </div>
  );
}
