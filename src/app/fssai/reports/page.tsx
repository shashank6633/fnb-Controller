'use client';

/**
 * Reports & Downloads (/fssai/reports) — owner §18. Management only.
 *
 * ── THE DEFAULT THIS SCREEN WILL NOT BUDGE ON ───────────────────────────────
 * It opens on ALL RECORDS, with both date boxes empty, and it says so in words
 * under the filters. RECON §7.2 records why, in this codebase's own comments: a
 * first-of-month default once showed "0 of 2,165 rows and Rs 0 of Rs 69.26 lakh…
 * He read that as his books having been lost." On a food-safety report an empty
 * window reads as checks never having been done, which is worse. A date range
 * here is always a visible choice somebody made.
 *
 * Second default, same spirit: VOIDED RECORDS ARE INCLUDED and marked. §19 is
 * "void, never delete" — a report that hides them undoes it. Choosing
 * "Everything except voided" is the deliberate exclusion.
 *
 * ── THREE DOWNLOADS, AND THE ONE LIMIT WORTH KNOWING BEFORE PRINTING ────────
 *   · Excel — SheetJS, imported only when the button is pressed, so the library
 *     is not in the first load of a page most people only read.
 *   · CSV   — straight from the server, BOM-first. Without the BOM Excel renders
 *     "4 °C" as "4 Â°C", and temperature readings are the bulk of this module.
 *   · PDF   — from the server, A4, for handing over. A table cell in it is ONE
 *     LINE, cut with an ellipsis rather than wrapped (deliberately: a wrapped
 *     cell makes pagination depend on content). Every cut entry is reprinted in
 *     full underneath the table, so nothing is lost — RECON §7.4's own
 *     recommended workaround. The screen says this before the button is pressed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, BarChart3, Download, FileSpreadsheet, FileText, Loader2, RefreshCw, Table2,
} from 'lucide-react';
import { apiJson } from '@/lib/api';

interface Col { key: string; label: string; align?: 'left' | 'right' | 'center'; width?: number; secondary?: true }
interface ReportDef {
  key: string; label: string; group: string; blurb: string; date_label: string;
  has_department: boolean; columns: Col[]; available: boolean; missing_tables: string[];
}
interface RunResult {
  report: { key: string; label: string; group: string; blurb: string; date_label: string; has_department: boolean; columns: Col[] };
  rows: Array<Array<string | number>>;
  kpis: Array<{ label: string; value: string; sub?: string }>;
  note: string;
  truncated: boolean;
  row_count: number;
  period: string;
  period_is_everything: boolean;
  filters_applied: any;
  today: string;
}

const FIELD = 'mt-1 w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';
const BTN = 'inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3] disabled:opacity-50';

export default function FssaiReportsPage() {
  const [defs, setDefs] = useState<ReportDef[]>([]);
  const [departments, setDepartments] = useState<Array<{ id: string; name: string }>>([]);
  const [picked, setPicked] = useState('');
  const [result, setResult] = useState<RunResult | null>(null);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');

  const [loadingCatalogue, setLoadingCatalogue] = useState(true);
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [err, setErr] = useState('');

  /* The query every button shares, so the table, the CSV, the Excel and the PDF
   * can never be a different report from one another.
   *
   * `forKey` exists so picking a report can run it in the SAME tick, without an
   * effect that fires on every change to the filters — see `pick` below. */
  const params = useCallback((extra?: Record<string, string>, forKey?: string) => {
    const p = new URLSearchParams();
    const key = forKey || picked;
    if (key) p.set('report', key);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (!from && !to) p.set('mode', 'all');
    if (departmentId) p.set('department_id', departmentId);
    if (status && status !== 'all') p.set('status', status);
    if (q.trim()) p.set('q', q.trim());
    for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
    return p;
  }, [picked, from, to, departmentId, status, q]);

  useEffect(() => {
    (async () => {
      setLoadingCatalogue(true);
      try {
        const j = await apiJson<any>('/api/fssai/reports');
        setDefs(j.reports || []);
        setDepartments(j.departments || []);
      } catch (e: any) {
        const m = String(e?.message || '');
        if (m.includes('management only')) setForbidden(true);
        else setErr(m || 'Could not load the list of reports');
      } finally { setLoadingCatalogue(false); }
    })();
  }, []);

  const run = useCallback(async (forKey?: string) => {
    const key = forKey || picked;
    if (!key) return;
    setRunning(true); setErr('');
    try {
      const j = await apiJson<RunResult>(`/api/fssai/reports?${params(undefined, key)}`);
      setResult(j);
    } catch (e: any) {
      setResult(null);
      setErr(e?.message || 'Could not run that report');
    } finally { setRunning(false); }
  }, [picked, params]);

  /* Picking a report runs it, HERE, rather than in an effect watching `picked`.
   *
   * An effect would have to list `run` among its dependencies, and `run` changes
   * whenever any filter changes — so the screen would re-query the server on
   * every keystroke in the search box. Suppressing that with an exhaustive-deps
   * disable is how a page ends up firing requests nobody asked for, and the
   * linter rightly complained about exactly that. The key is passed through
   * instead, because setPicked has not taken effect yet in this tick. */
  const pick = useCallback((key: string) => {
    setPicked(key);
    setResult(null);
    setErr('');
    void run(key);
  }, [run]);

  const def = useMemo(() => defs.find((d) => d.key === picked) || null, [defs, picked]);
  const groups = useMemo(() => {
    const m = new Map<string, ReportDef[]>();
    for (const d of defs) { if (!m.has(d.group)) m.set(d.group, []); m.get(d.group)!.push(d); }
    return [...m.entries()];
  }, [defs]);

  async function download(kind: 'csv' | 'pdf') {
    if (!picked) return;
    setDownloading(kind); setErr('');
    try {
      const url = kind === 'csv'
        ? `/api/fssai/reports?${params({ format: 'csv' })}`
        : `/api/fssai/reports/pdf?${params()}`;
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch { /* a PDF error is JSON; a truncated one is not */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `fssai-${picked}-${result?.today || 'export'}.${kind}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e: any) { setErr(e?.message || `Could not download the ${kind.toUpperCase()}`); }
    finally { setDownloading(''); }
  }

  async function downloadExcel() {
    if (!result) return;
    setDownloading('xlsx'); setErr('');
    try {
      /* Imported on demand. SheetJS is large and most visits to this screen only
       * read the table. */
      const XLSX = await import('xlsx');
      const header = result.report.columns.map((c) => c.label);
      const ws = XLSX.utils.aoa_to_sheet([header, ...result.rows]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, result.report.label.slice(0, 28) || 'Report');
      XLSX.writeFile(wb, `fssai-${picked}-${result.today}.xlsx`);
    } catch (e: any) { setErr(e?.message || 'Could not build the Excel file'); }
    finally { setDownloading(''); }
  }

  if (forbidden) {
    return (
      <Shell>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 This page is restricted to management. Ask an administrator for access.
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
          <BarChart3 size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Reports &amp; Downloads</h1>
          <p className="text-xs text-[#8B7355]">
            Any date range, any department, read on screen first — then as a table, an Excel file, a CSV or a PDF.
          </p>
        </div>
        {picked && (
          <button onClick={() => run()} disabled={running} className={BTN}>
            {running ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Run again
          </button>
        )}
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}

      {/* ── pick a report ─────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-[#E8D5C4] p-3 sm:p-4">
        {loadingCatalogue ? (
          <p className="text-sm text-[#8B7355] py-6 text-center">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading the reports&hellip;
          </p>
        ) : (
          <div className="space-y-4">
            {groups.map(([group, list]) => (
              <div key={group}>
                <p className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">{group}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2 mt-2">
                  {list.map((d) => (
                    <button
                      key={d.key}
                      onClick={() => { if (d.available) { pick(d.key); } }}
                      disabled={!d.available}
                      className={`text-left border rounded-lg p-3 transition-colors ${
                        picked === d.key
                          ? 'border-[#af4408] bg-[#FFF1E3]'
                          : d.available
                            ? 'border-[#E8D5C4] bg-white hover:border-[#af4408]'
                            : 'border-[#E8D5C4] bg-[#FFF8F0] opacity-70 cursor-not-allowed'
                      }`}
                    >
                      <p className="text-sm font-semibold">{d.label}</p>
                      <p className="text-xs text-[#6B5744] mt-0.5">{d.blurb}</p>
                      {!d.available && (
                        /* Never "0 rows" for a register that is not there — that
                         * would read as checks done and passed. */
                        <p className="text-[11px] text-[#8B7355] mt-1">
                          Not available yet — its register has not been created in this copy of the database. Restart
                          the application once and it will be there.
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── filters ───────────────────────────────────────────────────────── */}
      {def && (
        <div className="bg-white rounded-xl border border-[#E8D5C4] p-3 sm:p-4 space-y-3">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <label className="block">
              <span className="text-xs text-[#6B5744]">From</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={FIELD} />
            </label>
            <label className="block">
              <span className="text-xs text-[#6B5744]">To</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={FIELD} />
            </label>
            {def.has_department && (
              <label className="block">
                <span className="text-xs text-[#6B5744]">Department</span>
                <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={FIELD}>
                  <option value="">Every department</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
            )}
            <label className="block">
              <span className="text-xs text-[#6B5744]">Records</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className={FIELD}>
                <option value="all">Everything, including voided</option>
                <option value="active">Everything except voided</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-[#6B5744]">Search</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="name, item, person" className={FIELD} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => run()} disabled={running}
              className="inline-flex items-center gap-1.5 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-3 py-2 disabled:opacity-50"
            >
              {running ? <Loader2 size={15} className="animate-spin" /> : <Table2 size={15} />} Run the report
            </button>
            {(from || to || departmentId || status !== 'all' || q) && (
              <button
                onClick={() => { setFrom(''); setTo(''); setDepartmentId(''); setStatus('all'); setQ(''); }}
                className={BTN}
              >
                Clear the filters
              </button>
            )}
          </div>
          <p className="text-xs text-[#8B7355]">
            The dates filter on {def.date_label}.{' '}
            {from || to
              ? 'Clear both boxes to see every record again.'
              : 'Both boxes are empty, so this is EVERY record — a date range here is always something you choose. A compliance report that narrows itself is the one thing this screen will not do.'}
          </p>
        </div>
      )}

      {/* ── the result ────────────────────────────────────────────────────── */}
      {result && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold">{result.report.label}</h2>
              <p className="text-xs text-[#8B7355]">
                {result.period} · {result.row_count} row{result.row_count === 1 ? '' : 's'}
                {result.filters_applied?.department_name ? ` · ${result.filters_applied.department_name}` : ''}
              </p>
            </div>
            <button onClick={downloadExcel} disabled={!!downloading || result.row_count === 0} className={BTN}>
              {downloading === 'xlsx' ? <Loader2 size={15} className="animate-spin" /> : <FileSpreadsheet size={15} />} Excel
            </button>
            <button onClick={() => download('csv')} disabled={!!downloading} className={BTN}>
              {downloading === 'csv' ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} CSV
            </button>
            <button onClick={() => download('pdf')} disabled={!!downloading} className={BTN}>
              {downloading === 'pdf' ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />} PDF
            </button>
          </div>

          {result.kpis.length > 0 && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {result.kpis.map((k, i) => (
                <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-3">
                  <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">{k.label}</p>
                  <p className="text-xl font-bold mt-0.5">{k.value}</p>
                  {k.sub && <p className="text-[11px] text-[#8B7355]">{k.sub}</p>}
                </div>
              ))}
            </div>
          )}

          {result.truncated && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
              This is the first {result.row_count} rows in date order — there are more. Narrow the dates or the
              department, or take the Excel or CSV download, which is not limited the same way.
            </div>
          )}

          <div className="bg-white rounded-xl border border-[#E8D5C4] overflow-hidden">
            {result.rows.length === 0 ? (
              <div className="p-10 text-center">
                <p className="text-sm font-semibold">No records match</p>
                <p className="text-xs text-[#8B7355] mt-1">
                  That is a statement about the filters above, not about the restaurant. Clear the dates or the
                  department to widen it.
                </p>
              </div>
            ) : (
              <>
                {/* Phone: one card per row, with the secondary columns folded in. */}
                <div className="md:hidden divide-y divide-[#E8D5C4]">
                  {result.rows.map((row, i) => (
                    <div key={i} className="p-4 space-y-1">
                      {result.report.columns.map((c, j) => {
                        const v = row[j];
                        if (v === '' || v === null || v === undefined) return null;
                        return (
                          <p key={c.key} className="text-xs">
                            <span className="text-[#8B7355]">{c.label}: </span>
                            <span className={j === 0 ? 'font-semibold text-sm' : ''}>{String(v)}</span>
                          </p>
                        );
                      })}
                    </div>
                  ))}
                </div>
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-[#FFF1E3] text-[#6B5744]">
                      <tr>
                        {result.report.columns.map((c) => (
                          <th
                            key={c.key}
                            className={`font-semibold px-3 py-2 whitespace-nowrap ${
                              c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'
                            } ${c.secondary ? 'hidden xl:table-cell' : ''}`}
                          >
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E8D5C4]">
                      {result.rows.map((row, i) => (
                        <tr key={i} className="hover:bg-[#FFF8F0] align-top">
                          {result.report.columns.map((c, j) => (
                            <td
                              key={c.key}
                              className={`px-3 py-2 ${
                                c.align === 'right' ? 'text-right tabular-nums' : c.align === 'center' ? 'text-center' : 'text-left'
                              } ${c.secondary ? 'hidden xl:table-cell' : ''}`}
                            >
                              {/* Blank stays blank. A number that was never recorded
                                  is never filled in with a nought here. */}
                              {row[j] === '' || row[j] === null || row[j] === undefined ? (
                                <span className="text-[#C4B09A]">—</span>
                              ) : String(row[j])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          {result.note && (
            <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 text-xs text-[#3D2614] flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5 text-[#af4408]" />
              <p>{result.note}</p>
            </div>
          )}

          <p className="text-xs text-[#8B7355]">
            The PDF is A4 and meant for handing over. A cell in it is one line, cut short rather than wrapped — so every
            entry it cuts is reprinted in full underneath the table. The Excel and CSV files carry the full text in
            every cell, and the CSV is written so Excel shows °C correctly.
          </p>
        </>
      )}

      {!def && !loadingCatalogue && (
        <p className="text-sm text-[#8B7355]">Pick a report above to begin. Nothing runs until you choose one.</p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">{children}</div>
    </div>
  );
}
