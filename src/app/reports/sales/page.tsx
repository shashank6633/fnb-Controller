'use client';

/**
 * Sales Reports (management only). Six settled-sales reports over a date range:
 * Customer-wise, Table-wise, Item-wise, Category-wise, Dine-in & Party, Floor-wise.
 * Each: totals row + CSV / Excel export. Data from GET /api/reports/sales
 * (?type=&from=&to=). The API gates on isManagement; the page is mgmtOnly.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  BarChart3, Download, FileSpreadsheet, Loader2, AlertTriangle, Lock, CalendarDays, RefreshCw,
} from 'lucide-react';

type Col = { k: string; label: string; num?: boolean; money?: boolean; pct?: boolean; date?: boolean; wide?: boolean };
// `cols` omitted → the report is a POS-matching detail report whose columns come
// from the API (the server-side report file owns the column spec).
type ReportDef = { key: string; label: string; cols?: Col[] };

const REPORTS: ReportDef[] = [
  // POS-matching detail reports (columns supplied by the API).
  { key: 'customer-order',   label: 'Customer Order' },
  { key: 'item-detail',      label: 'Item Wise' },
  { key: 'category-summary', label: 'Category Summary' },
  { key: 'kot-details',      label: 'KOT Details' },
  { key: 'order-punched',    label: 'Order Punched' },
  // Quick aggregate views.
  { key: 'customer', label: 'Customer-wise', cols: [
    { k: 'name', label: 'Customer' }, { k: 'mobile', label: 'Mobile' },
    { k: 'orders', label: 'Orders', num: true }, { k: 'covers', label: 'Covers', num: true },
    { k: 'sales', label: 'Sales', money: true }, { k: 'tax', label: 'Tax', money: true } ] },
  { key: 'table', label: 'Table-wise', cols: [
    { k: 'table_number', label: 'Table' }, { k: 'floor', label: 'Floor' }, { k: 'section', label: 'Section' },
    { k: 'orders', label: 'Orders', num: true }, { k: 'covers', label: 'Covers', num: true }, { k: 'sales', label: 'Sales', money: true } ] },
  { key: 'channel', label: 'Dine-in & Party', cols: [
    { k: 'channel', label: 'Channel' }, { k: 'orders', label: 'Orders / Events', num: true }, { k: 'sales', label: 'Sales', money: true } ] },
  { key: 'floor', label: 'Floor-wise', cols: [
    { k: 'floor', label: 'Floor' }, { k: 'orders', label: 'Orders', num: true },
    { k: 'covers', label: 'Covers', num: true }, { k: 'sales', label: 'Sales', money: true } ] },
];

function istToday(): string {
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
}
function istMonthStart(): string {
  return istToday().slice(0, 8) + '01';
}
const money = (n: number) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const num = (n: number) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
/** SQLite UTC datetime ("YYYY-MM-DD HH:MM:SS") → IST "18 Jul, 09:07 pm". */
function istDateTime(s: string): string {
  if (!s) return '—';
  const d = new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}

export default function SalesReportsPage() {
  const [tab, setTab] = useState('customer-order');
  const [from, setFrom] = useState(istMonthStart);
  const [to, setTo] = useState(istToday);
  const [rows, setRows] = useState<any[]>([]);
  const [apiCols, setApiCols] = useState<Col[] | null>(null);   // columns from the API (POS detail reports)
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const def = useMemo(() => REPORTS.find((r) => r.key === tab) || REPORTS[0], [tab]);
  // Resolved columns: hardcoded (aggregate tabs) or API-supplied (POS detail tabs).
  const cols: Col[] = def.cols ?? apiCols ?? [];

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/reports/sales?type=${tab}&from=${from}&to=${to}`, { cache: 'no-store' });
      if (res.status === 401 || res.status === 403) { setForbidden(true); return; }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error || `HTTP ${res.status}`); setRows([]); return; }
      setRows(Array.isArray(j.rows) ? j.rows : []);
      setApiCols(Array.isArray(j.columns) ? j.columns : null);
    } catch { setError('Network error — could not load the report'); setRows([]); }
    finally { setLoading(false); }
  }, [tab, from, to]);

  useEffect(() => { load(); }, [load]);

  // Column totals (numeric/money columns only; contribution/pct aren't summed).
  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const c of cols) {
      if ((c.num || c.money) && !c.pct) t[c.k] = rows.reduce((s, r) => s + (Number(r[c.k]) || 0), 0);
    }
    return t;
  }, [rows, cols]);

  const fmt = (c: Col, v: any) => c.money ? money(v) : c.pct ? `${num(v)}%` : c.num ? num(v) : c.date ? istDateTime(v) : (v ?? '—');

  const exportRows = () => rows.map((r) => {
    const o: Record<string, any> = {};
    for (const c of cols) o[c.label] = c.money || c.num || c.pct ? (Number(r[c.k]) || 0) : c.date ? istDateTime(r[c.k]) : (r[c.k] ?? '');
    return o;
  });

  const downloadExcel = () => {
    const ws = XLSX.utils.json_to_sheet(exportRows());
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, def.label.slice(0, 28));
    XLSX.writeFile(wb, `${def.key}-report_${from}_to_${to}.xlsx`);
  };
  const downloadCsv = () => {
    const data = exportRows();
    const labels = cols.map((c) => c.label);
    const esc = (v: any) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [labels.join(','), ...data.map((r) => labels.map((c) => esc(r[c])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `${def.key}-report_${from}_to_${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="max-w-sm text-center text-[#6B5744]">
          <Lock className="w-10 h-10 mx-auto mb-3 text-[#af4408]" />
          <h1 className="text-lg font-bold text-[#2D1B0E]">Management only</h1>
          <p className="text-sm mt-1">Sales Reports are restricted to managers, HODs and admins.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-[100rem] mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4">
        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Reports</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2.5"><BarChart3 className="w-7 h-7 text-[#af4408]" />Sales Reports</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 bg-white border border-[#E0D0BE] rounded-xl px-2.5 py-1.5 shadow-sm">
              <CalendarDays className="w-4 h-4 text-[#8B7355] shrink-0" />
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="bg-transparent text-sm focus:outline-none text-[#2D1B0E] w-[8rem]" aria-label="From date" />
              <span className="text-[#C4B09A]">–</span>
              <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="bg-transparent text-sm focus:outline-none text-[#2D1B0E] w-[8rem]" aria-label="To date" />
            </div>
            <button onClick={load} className="p-2.5 bg-white border border-[#E0D0BE] rounded-xl text-[#8B7355] hover:bg-[#FFF1E3] shadow-sm" aria-label="Refresh" title="Refresh"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /></button>
            <button onClick={downloadCsv} disabled={!rows.length} className="flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] disabled:opacity-50 text-[#6B5744] rounded-xl text-sm font-medium shadow-sm"><Download className="w-4 h-4" />CSV</button>
            <button onClick={downloadExcel} disabled={!rows.length} className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-xl text-sm font-semibold shadow-sm"><FileSpreadsheet className="w-4 h-4" />Excel</button>
          </div>
        </div>

        {/* Report tabs */}
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 -mx-1 px-1">
          {REPORTS.map((r) => (
            <button key={r.key} onClick={() => setTab(r.key)}
                    className={`px-3.5 py-2 rounded-full border text-sm font-medium whitespace-nowrap transition-colors ${tab === r.key ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'}`}>
              {r.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="flex items-center gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 shrink-0" />{error}
          </div>
        )}

        {/* Table */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
          {loading ? (
            <div className="h-64 animate-pulse" />
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-[#8B7355]">
              <BarChart3 className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p>No settled sales in this range</p>
              <p className="text-xs mt-1">Pick a wider date range.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4] bg-[#FFF8F0]">
                    {cols.map((c) => (
                      <th key={c.k} className={`py-3 px-4 font-semibold ${c.num || c.money || c.pct ? 'text-right' : 'text-left'}`}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-b border-[#F0E4D6] last:border-0 hover:bg-[#FFF8F0]">
                      {cols.map((c) => (
                        <td key={c.k} className={`py-2.5 px-4 ${c.num || c.money || c.pct ? 'text-right tabular-nums' : 'text-left'} ${c.wide ? 'min-w-[240px] max-w-[440px] whitespace-normal break-words text-[13px] text-[#3D2614]' : ''} ${c.k === cols[0]?.k ? 'font-semibold text-[#2D1B0E]' : 'text-[#3D2614]'}`}>
                          {fmt(c, r[c.k])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF8F0] font-bold text-[#2D1B0E]">
                    {cols.map((c, idx) => (
                      <td key={c.k} className={`py-3 px-4 ${c.num || c.money || c.pct ? 'text-right tabular-nums' : 'text-left'}`}>
                        {idx === 0 ? `Total (${rows.length})` : c.k in totals ? fmt(c, totals[c.k]) : ''}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
        <p className="text-[11px] text-[#8B7355]">Figures are settled sales in IST for the selected range. Sales exclude party/banquet bills except in the Dine-in &amp; Party report.</p>
      </div>
    </div>
  );
}
