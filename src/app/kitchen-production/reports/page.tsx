'use client';

/**
 * Kitchen Production — reports.
 *
 * Pick a report type + optional from/to range, run it, and view the results in
 * a table. Export the exact rows to Excel (xlsx, client-side) or to PDF via a
 * print-friendly popup window + window.print() (browser "Save as PDF").
 *
 * Data: GET /api/kitchen-production/reports?type=&from=&to=
 *   → { type, columns: string[], rows: object[] }
 * `columns` is the ordered header-key list; each row is keyed by those columns.
 */

import { useState } from 'react';
import Link from 'next/link';
import {
  BarChart3, Loader2, LayoutGrid, ChefHat, FileDown, Printer, Play, Table2,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { fmtIST } from '@/lib/format-date';

// ─── Report catalog ─────────────────────────────────────────────────────
const REPORTS: { value: string; label: string; hint: string }[] = [
  { value: 'production',         label: 'Production Log',      hint: 'Batches produced in the range' },
  { value: 'fifo-consumption',   label: 'FIFO Consumption',    hint: 'Every consumed transaction, oldest-first' },
  { value: 'batch-history',      label: 'Batch History',       hint: 'All batch transactions' },
  { value: 'scan-history',       label: 'Scan History',        hint: 'Barcode scan transactions' },
  { value: 'expiry',             label: 'Expiry Report',       hint: 'Expired / past-expiry batches' },
  { value: 'waste',              label: 'Waste & Disposal',    hint: 'Wasted + disposed, costed when linked' },
  { value: 'daily-production',   label: 'Daily Production',    hint: 'Per-day production rollup' },
  { value: 'monthly-production', label: 'Monthly Production',  hint: 'Per-month production rollup' },
  { value: 'cost-analysis',      label: 'Cost Analysis',       hint: 'Batch value at material price' },
  { value: 'inventory-ageing',   label: 'Inventory Ageing',    hint: 'Active batches by age bucket (current)' },
  { value: 'near-expiry',        label: 'Near Expiry',         hint: 'Active batches expiring ≤7d (current)' },
];

// Reports whose result is a snapshot of current state — the date range is ignored.
const CURRENT_STATE = new Set(['inventory-ageing', 'near-expiry']);

/** snake_case / kebab → "Title Case" header label. */
const prettify = (k: string) =>
  k.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** Format one cell for display. The 'date' column carries a UTC tx timestamp. */
function cell(col: string, v: any): string {
  if (v == null || v === '') return '';
  if (col === 'date') return fmtIST(v);
  return String(v);
}

// ─── Page ───────────────────────────────────────────────────────────────
export default function KitchenProductionReportsPage() {
  const [type, setType] = useState('production');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [ranAs, setRanAs] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeMeta = REPORTS.find(r => r.value === type);
  const isCurrent = CURRENT_STATE.has(type);

  const run = async () => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ type });
      if (!isCurrent && from) qs.set('from', from);
      if (!isCurrent && to) qs.set('to', to);
      const r = await fetch(`/api/kitchen-production/reports?${qs}`, { credentials: 'same-origin' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setColumns(Array.isArray(j.columns) ? j.columns : []);
      setRows(Array.isArray(j.rows) ? j.rows : []);
      setRanAs(type);
    } catch (e: any) {
      setError(e.message || 'Failed to run report');
      setColumns([]); setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const rangeSuffix = () => {
    const parts = [ranAs || type];
    if (from) parts.push(`from-${from}`);
    if (to) parts.push(`to-${to}`);
    return parts.join('_');
  };

  // ─── Excel export ───
  const exportExcel = () => {
    if (!rows.length) return;
    // Order + prettify headers, format the date column for readability.
    const shaped = rows.map(r => {
      const o: Record<string, any> = {};
      for (const c of columns) o[prettify(c)] = cell(c, r[c]);
      return o;
    });
    const ws = XLSX.utils.json_to_sheet(shaped, { header: columns.map(prettify) });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Report');
    XLSX.writeFile(wb, `kitchen-${rangeSuffix()}.xlsx`);
  };

  // ─── PDF export (print-friendly popup) ───
  const exportPdf = () => {
    if (!rows.length) return;
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const title = activeMeta?.label || type;
    const rangeLine = isCurrent
      ? 'Current-state snapshot'
      : (from || to) ? `Range: ${from || '…'} → ${to || '…'}` : 'All dates';
    const thead = columns.map(c => `<th>${esc(prettify(c))}</th>`).join('');
    const tbody = rows.map(r =>
      `<tr>${columns.map(c => `<td>${esc(cell(c, r[c]))}</td>`).join('')}</tr>`
    ).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color:#2D1B0E; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; color:#af4408; }
  .meta { font-size:11px; color:#8B7355; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th, td { border:1px solid #E8D5C4; padding:5px 7px; text-align:left; vertical-align:top; }
  thead th { background:#FFF1E3; text-transform:uppercase; font-size:9px; letter-spacing:.04em; color:#6B5744; }
  tbody tr:nth-child(even) { background:#FFF8F0; }
  @media print { body { padding:0; } }
</style></head><body>
  <h1>Kitchen Production — ${esc(title)}</h1>
  <div class="meta">${esc(rangeLine)} · ${rows.length} row${rows.length === 1 ? '' : 's'} · generated ${esc(fmtIST(new Date().toISOString()))}</div>
  <table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
  <script>window.onload = function(){ window.focus(); window.print(); };</script>
</body></html>`;
    const w = window.open('', '_blank');
    if (!w) { alert('Pop-up blocked — allow pop-ups to export PDF.'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-[#af4408]" /> Production Reports
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5 max-w-2xl">
            Run production, consumption, waste, cost and expiry reports. Export the
            results straight to <b>Excel</b> or <b>PDF</b>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/kitchen-production/dashboard"
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <LayoutGrid className="w-4 h-4" /> <span className="hidden sm:inline">Dashboard</span>
          </Link>
          <Link href="/kitchen-production"
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <ChefHat className="w-4 h-4" /> <span className="hidden sm:inline">Batches</span>
          </Link>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="block sm:col-span-2 lg:col-span-1">
            <span className="text-[11px] font-medium text-[#6B5744] mb-1 block">Report</span>
            <select value={type} onChange={e => setType(e.target.value)} className={inputCls}>
              {REPORTS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] font-medium text-[#6B5744] mb-1 block">From</span>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                   disabled={isCurrent} className={inputCls} />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium text-[#6B5744] mb-1 block">To</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
                   disabled={isCurrent} className={inputCls} />
          </label>
          <div className="flex items-end">
            <button onClick={run} disabled={loading}
                    className="w-full px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Run report
            </button>
          </div>
        </div>
        {activeMeta && (
          <div className="text-[11px] text-[#8B7355]">
            {activeMeta.hint}{isCurrent && ' — date range does not apply.'}
          </div>
        )}
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}

      {/* Results */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-center justify-between flex-wrap gap-2">
          <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-2">
            <Table2 className="w-4 h-4 text-[#af4408]" />
            {ranAs ? (REPORTS.find(r => r.value === ranAs)?.label || ranAs) : 'Results'}
            {ranAs && <span className="text-[11px] font-normal text-[#8B7355]">· {rows.length} row{rows.length === 1 ? '' : 's'}</span>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportExcel} disabled={!rows.length}
                    className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2 disabled:opacity-40">
              <FileDown className="w-4 h-4" /> Excel
            </button>
            <button onClick={exportPdf} disabled={!rows.length}
                    className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2 disabled:opacity-40">
              <Printer className="w-4 h-4" /> PDF
            </button>
          </div>
        </div>

        {loading ? (
          <div className="p-10 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Running…
          </div>
        ) : !ranAs ? (
          <div className="p-10 text-center text-sm text-[#8B7355]">
            <BarChart3 className="w-8 h-8 mx-auto mb-2 text-[#D4B896]" />
            Pick a report and click “Run report”.
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-[#8B7355]">
            No rows for this report / range.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="bg-[#FFF8F0] text-left text-[11px] uppercase tracking-wide text-[#8B7355]">
                  {columns.map(c => <th key={c} className="px-3 py-2 font-medium">{prettify(c)}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E8D5C4]/60">
                {rows.map((r, i) => (
                  <tr key={i} className="hover:bg-[#FFF1E3]/40">
                    {columns.map(c => (
                      <td key={c} className="px-3 py-2 text-[#2D1B0E]">{cell(c, r[c])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const inputCls = 'w-full px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]/30 disabled:opacity-50 disabled:bg-[#F5EBE0]';
