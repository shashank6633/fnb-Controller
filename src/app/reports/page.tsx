'use client';

import { useEffect, useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  FileText,
  Download,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from 'recharts';
import type { ItemPnL, PeriodReport } from '@/types';

const COLORS = {
  revenue: '#10B981',
  cost: '#EF4444',
  profit: '#af4408',
  nc: '#F59E0B',
};

const PIE_COLORS = [COLORS.revenue, COLORS.nc, '#8B5CF6'];

function formatCurrency(value: number): string {
  return '\u20B9' + value.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

function thirtyDaysAgoISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().split('T')[0];
}

type Period = 'daily' | 'weekly' | 'monthly';
type SortKey = keyof ItemPnL;
type SortDir = 'asc' | 'desc';

interface ReportsData {
  item_pnl: ItemPnL[];
  period_data: any[];
  nc_impact: { total_nc_cost: number; total_nc_quantity: number };
  top_sellers: { name: string; quantity: number }[];
  most_profitable: { name: string; profit: number }[];
  loss_makers: { name: string; profit: number }[];
  high_food_cost: { name: string; percent: number }[];
  department_breakdown?: { department: string; items: number; revenue: number }[];
  active_department?: string | null;
  segment_breakdown?: { segment: 'DINE_IN' | 'PARTY'; items: number; qty: number; revenue: number; cost: number }[];
  active_segment?: 'DINE_IN' | 'PARTY' | null;
}

function LoadingSkeleton() {
  return (
    <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="h-9 w-56 bg-[#FFF1E3] rounded-lg" />
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 h-20" />
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-5 h-24" />
          ))}
        </div>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 h-96" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-6 h-80" />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ReportsPage() {
  const [fromDate, setFromDate] = useState(thirtyDaysAgoISO());
  const [toDate, setToDate] = useState(todayISO());
  const [period, setPeriod] = useState<Period>('daily');
  // Department filter — applies to every chart/table on this page in one shot.
  // Empty string = all departments. Derived server-side from sales.category.
  const [department, setDepartment] = useState<string>('');
  // Segment filter — Dine-In vs Party. Empty = both combined.
  // Detection: item_name ends with " P" OR category ∈ {Party Package, Custom}.
  const [segment, setSegment] = useState<'' | 'DINE_IN' | 'PARTY'>('');
  // Item-name search — filters the P&L table only, leaves totals and charts alone
  // so they remain context for the items you're searching against.
  const [itemSearch, setItemSearch] = useState<string>('');
  const [data, setData] = useState<ReportsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('revenue');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  // Department-wise consumption — same date range as the rest of the page
  const [deptData, setDeptData] = useState<any | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ from: fromDate, to: toDate, period });
      if (department) params.set('department', department);
      if (segment)    params.set('segment', segment);
      const res = await fetch(`/api/reports?${params}`);
      if (!res.ok) throw new Error('Failed to fetch reports');
      const json = await res.json();
      setData(json);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, period, department, segment]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Fetch department-wise consumption alongside the main reports payload.
  // Lives in /api/department-consumption (separate endpoint), so we don't bloat
  // the existing reports route.
  useEffect(() => {
    const qs = new URLSearchParams({ from: fromDate, to: toDate });
    fetch(`/api/department-consumption?${qs}`)
      .then(r => r.json())
      .then(setDeptData)
      .catch(() => setDeptData(null));
  }, [fromDate, toDate]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  /**
   * Export the current report view as a multi-sheet Excel workbook.
   * Respects all active filters: date range, period, department, item search.
   * Sheets:
   *   1. Summary          — date range · filter context · KPI totals
   *   2. Item P&L         — full table (post-search) with all columns
   *   3. Period Trend     — daily / weekly / monthly trend rows
   *   4. Top Sellers      — by qty
   *   5. Most Profitable  — by ₹ profit
   *   6. Loss Makers      — items losing money
   *   7. High Food Cost   — items above 30% FC
   *   8. Dept Breakdown   — items + revenue per derived department
   *   9. NC / Comp Items  — every item with non-zero NC cost
   */
  const handleExport = () => {
    if (!data) return;
    const wb = XLSX.utils.book_new();
    const fmtINR = (v: number) => Math.round(v || 0);

    // 1. Summary
    const summaryRows = [
      ['F&B Controller — Reports Export'],
      [],
      ['Date range', `${fromDate} → ${toDate}`],
      ['Period', period],
      ['Department filter', department || 'All departments'],
      ['Segment',           segment === 'PARTY' ? 'Party only' : segment === 'DINE_IN' ? 'Dine-In only' : 'All segments'],
      ['Item search', itemSearch || '(none)'],
      ['Generated at', new Date().toISOString()],
      [],
      ['KPI', 'Value (₹)'],
      ['Total Revenue', fmtINR(totals.revenue)],
      ['Total Cost', fmtINR(totals.cost)],
      ['Gross Profit', fmtINR(totals.profit)],
      ['Gross Margin %', totals.margin],
      ['NC Loss (Purchase Cost)', fmtINR(totals.ncCost)],
      ['Comp. Loss (Purchase Cost)', fmtINR(totals.compCost)],
      ['Leakage % (NC vs Cost)', leakagePercent],
      [],
      ['Items in table', sortedItems.length],
      ['Items in dataset', data.item_pnl.length],
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(summaryRows);
    ws1['!cols'] = [{ wch: 26 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

    // 2. Item P&L (post-filter)
    const pnlRows = sortedItems.map((i) => ({
      'Item Name': i.item_name,
      'Qty Sold': i.quantity_sold,
      'Revenue (₹)': fmtINR(i.revenue),
      'Cost (₹)': fmtINR(i.cost),
      'Profit (₹)': fmtINR(i.profit),
      'Food Cost %': i.food_cost_percent,
      'NC Qty': i.nc_quantity,
      'NC Loss (₹)': fmtINR(i.nc_cost),
    }));
    const ws2 = XLSX.utils.json_to_sheet(pnlRows);
    ws2['!cols'] = [
      { wch: 36 }, { wch: 10 }, { wch: 14 }, { wch: 14 },
      { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 14 },
    ];
    XLSX.utils.book_append_sheet(wb, ws2, 'Item P&L');

    // 3. Period Trend
    const periodRows = (data.period_data || []).map((p: any) => ({
      Period: p.period,
      'Revenue (₹)': fmtINR(p.total_sales),
      'Cost (₹)': fmtINR(p.total_cost),
      'Gross Profit (₹)': fmtINR(p.gross_profit),
      'Margin %': p.gross_margin,
      'NC count': p.nc_count,
      'NC Cost (₹)': fmtINR(p.nc_cost),
      'Comp count': p.complimentary_count,
      'Comp Cost (₹)': fmtINR(p.complimentary_cost),
    }));
    if (periodRows.length > 0) {
      const ws3 = XLSX.utils.json_to_sheet(periodRows);
      ws3['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws3, 'Period Trend');
    }

    // 4. Top Sellers
    if (data.top_sellers?.length) {
      const ws = XLSX.utils.json_to_sheet(
        data.top_sellers.map((t) => ({ Item: t.name, 'Qty Sold': t.quantity }))
      );
      ws['!cols'] = [{ wch: 36 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Top Sellers');
    }

    // 5. Most Profitable
    if (data.most_profitable?.length) {
      const ws = XLSX.utils.json_to_sheet(
        data.most_profitable.map((t) => ({ Item: t.name, 'Profit (₹)': fmtINR(t.profit) }))
      );
      ws['!cols'] = [{ wch: 36 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Most Profitable');
    }

    // 6. Loss Makers
    if (data.loss_makers?.length) {
      const ws = XLSX.utils.json_to_sheet(
        data.loss_makers.map((t) => ({ Item: t.name, 'Profit (₹)': fmtINR(t.profit) }))
      );
      ws['!cols'] = [{ wch: 36 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Loss Makers');
    }

    // 7. High Food Cost
    if (data.high_food_cost?.length) {
      const ws = XLSX.utils.json_to_sheet(
        data.high_food_cost.map((t) => ({ Item: t.name, 'Food Cost %': t.percent }))
      );
      ws['!cols'] = [{ wch: 36 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, 'High Food Cost');
    }

    // 8. Department Breakdown
    if (data.department_breakdown?.length) {
      const ws = XLSX.utils.json_to_sheet(
        data.department_breakdown.map((d: any) => ({
          Department: d.department,
          Items: d.items,
          'Revenue (₹)': fmtINR(d.revenue),
        }))
      );
      ws['!cols'] = [{ wch: 28 }, { wch: 10 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Departments');
    }

    // 9. NC / Comp items
    const ncRows = data.item_pnl
      .filter((i) => i.nc_cost > 0)
      .map((i) => ({
        Item: i.item_name,
        'NC Qty': i.nc_quantity,
        'NC Loss (₹)': fmtINR(i.nc_cost),
      }));
    if (ncRows.length > 0) {
      const ws = XLSX.utils.json_to_sheet(ncRows);
      ws['!cols'] = [{ wch: 36 }, { wch: 10 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, 'NC + Comp');
    }

    // Filename: fnb-report_<dept>_<from>_<to>.xlsx
    const safeDept = (department || 'all').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const safeSeg  = segment === 'PARTY' ? 'party' : segment === 'DINE_IN' ? 'dinein' : 'all';
    const filename = `fnb-report_${safeSeg}_${safeDept}_${fromDate}_to_${toDate}.xlsx`;
    XLSX.writeFile(wb, filename);
  };

  if (loading) return <LoadingSkeleton />;

  if (error) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center">
        <div className="text-center space-y-4">
          <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto" />
          <p className="text-[#6B5744] text-lg">Error: {error}</p>
          <button
            onClick={() => fetchData()}
            className="px-4 py-2 bg-[#FFF1E3] text-[#2D1B0E] rounded-lg hover:bg-[#FFF1E3] transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  // Compute totals
  const totals = {
    revenue: data.item_pnl.reduce((s, i) => s + i.revenue, 0),
    cost: data.item_pnl.reduce((s, i) => s + i.cost, 0),
    profit: data.item_pnl.reduce((s, i) => s + i.profit, 0),
    margin: 0,
    ncCost: data.item_pnl.reduce((s, i) => s + i.nc_cost, 0),
    compCost: data.period_data.reduce((s: number, p: any) => s + (p.complimentary_cost || 0), 0),
  };
  totals.margin = totals.revenue > 0 ? Math.round((totals.profit / totals.revenue) * 10000) / 100 : 0;
  const leakagePercent = totals.cost > 0 ? Math.round((totals.ncCost / totals.cost) * 10000) / 100 : 0;

  // Sorted + searched item P&L
  const searchQuery = itemSearch.trim().toLowerCase();
  const sortedItems = [...data.item_pnl]
    .filter((i) => !searchQuery || i.item_name.toLowerCase().includes(searchQuery))
    .sort((a, b) => {
      const aVal = a[sortKey] as number;
      const bVal = b[sortKey] as number;
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
    });

  // Chart data
  const profitByItem = data.item_pnl
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 10)
    .map((i) => ({ name: i.item_name, profit: i.profit }));

  const foodCostByItem = data.item_pnl
    .filter((i) => i.food_cost_percent > 0)
    .sort((a, b) => b.food_cost_percent - a.food_cost_percent)
    .slice(0, 10)
    .map((i) => ({ name: i.item_name, percent: i.food_cost_percent }));

  const ncPieData = [
    { name: 'Normal Revenue', value: totals.revenue },
    { name: 'NC Cost', value: totals.ncCost },
    { name: 'Complimentary Cost', value: totals.compCost },
  ].filter((d) => d.value > 0);

  // NC breakdown by item
  const ncBreakdown = data.item_pnl
    .filter((i) => i.nc_cost > 0)
    .sort((a, b) => b.nc_cost - a.nc_cost);

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">
              Reports & Analysis
              {department && (
                <span className="ml-3 text-base font-normal text-[#6B5744] align-middle">
                  · <span className="px-2 py-0.5 rounded-full bg-[#FFF1E3] border border-[#D4B896] text-[#2D1B0E] text-sm">{department}</span>
                  <button onClick={() => setDepartment('')} className="ml-2 text-xs text-[#af4408] hover:underline align-middle">clear</button>
                </span>
              )}
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">Profit & Loss, food cost analysis, and operational leakage</p>
          </div>
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-4 py-2.5 bg-[#FFF1E3] hover:bg-[#FFF1E3] text-[#3D2614] rounded-lg text-sm font-medium transition-colors"
          >
            <Download className="w-4 h-4" />
            Export Report
          </button>
        </div>

        {/* Date Range & Period Selector */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs text-[#8B7355] mb-1">From</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
            />
          </div>
          <div>
            <label className="block text-xs text-[#8B7355] mb-1">To</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
            />
          </div>
          <div>
            <label className="block text-xs text-[#8B7355] mb-1">Period</label>
            <div className="flex gap-1 bg-[#FFF1E3] rounded-lg p-1">
              {(['daily', 'weekly', 'monthly'] as Period[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    period === p ? 'bg-[#af4408] text-white' : 'text-[#8B7355] hover:text-[#3D2614]'
                  }`}
                >
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>
          {/* Department filter — applies to every chart + table below in one shot.
              Counts in the dropdown labels reflect the chosen date range and ignore
              the active department selection (so user can see what other depts offer). */}
          <div>
            <label className="block text-xs text-[#8B7355] mb-1">Department</label>
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408] min-w-[200px]"
            >
              <option value="">All departments
                {data?.department_breakdown
                  ? ` (${data.department_breakdown.reduce((s: number, d: any) => s + d.items, 0)})`
                  : ''}
              </option>
              {data?.department_breakdown?.map((d: any) => (
                <option key={d.department} value={d.department}>
                  {d.department} ({d.items} items · ₹{Math.round((d.revenue || 0) / 1000)}k)
                </option>
              ))}
            </select>
          </div>

          {/* Segment toggle — Dine-In vs Party. Item-name " P" suffix or
              category in {Party Package, Custom} → PARTY, else DINE-IN. */}
          <div>
            <label className="block text-xs text-[#8B7355] mb-1">Segment</label>
            {(() => {
              const sb = data?.segment_breakdown || [];
              const dine = sb.find(s => s.segment === 'DINE_IN');
              const party = sb.find(s => s.segment === 'PARTY');
              const total = (dine?.items || 0) + (party?.items || 0);
              const fmtRev = (n: number) => n >= 100000 ? `₹${(n/100000).toFixed(1)}L` : `₹${Math.round(n/1000)}k`;
              const Btn = ({ value, label, items, rev }: any) => (
                <button onClick={() => setSegment(value)}
                        className={`px-3 py-2 text-xs rounded-lg border transition-colors flex flex-col items-start
                          ${segment === value
                            ? 'bg-[#af4408] text-white border-[#af4408]'
                            : 'bg-[#FFF1E3] text-[#2D1B0E] border-[#D4B896] hover:border-[#af4408]'}`}>
                  <span className="font-semibold">{label}</span>
                  {items != null && (
                    <span className={`text-[10px] mt-0.5 ${segment === value ? 'text-white/80' : 'text-[#8B7355]'}`}>
                      {items} items{rev != null ? ` · ${fmtRev(rev)}` : ''}
                    </span>
                  )}
                </button>
              );
              return (
                <div className="flex gap-1.5">
                  <Btn value="" label="All" items={total} rev={(dine?.revenue || 0) + (party?.revenue || 0)} />
                  <Btn value="DINE_IN" label="Dine-In" items={dine?.items} rev={dine?.revenue} />
                  <Btn value="PARTY"   label="Party"   items={party?.items} rev={party?.revenue} />
                </div>
              );
            })()}
          </div>
          <button
            onClick={() => fetchData()}
            className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium transition-colors"
          >
            <BarChart3 className="w-4 h-4" />
            Generate Report
          </button>
        </div>

        {/* P&L Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
          <PnLCard
            icon={<TrendingUp className="w-4 h-4" />}
            label="Total Revenue"
            value={formatCurrency(totals.revenue)}
            color="green"
          />
          <PnLCard
            icon={<TrendingDown className="w-4 h-4" />}
            label="Total Cost"
            value={formatCurrency(totals.cost)}
            color="red"
          />
          <PnLCard
            icon={<BarChart3 className="w-4 h-4" />}
            label="Gross Profit"
            value={formatCurrency(totals.profit)}
            color="blue"
          />
          <PnLCard
            icon={<FileText className="w-4 h-4" />}
            label="Gross Margin %"
            value={`${totals.margin}%`}
            color={totals.margin >= 0 ? 'blue' : 'red'}
          />
          <PnLCard
            icon={<AlertTriangle className="w-4 h-4" />}
            label="NC Loss (Purchase Cost)"
            value={formatCurrency(totals.ncCost)}
            color="amber"
          />
          <PnLCard
            icon={<AlertTriangle className="w-4 h-4" />}
            label="Comp. Loss (Purchase Cost)"
            value={formatCurrency(totals.compCost)}
            color="purple"
          />
        </div>

        {/* Item-Level P&L Table */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 shadow">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
              <FileText className="w-5 h-5 text-[#af4408]" />
              Item-Level P&L
              <span className="text-xs font-normal text-[#8B7355] ml-1">
                {searchQuery ? `${sortedItems.length} of ${data.item_pnl.length} match` : `${data.item_pnl.length} items`}
              </span>
            </h2>
            <div className="relative w-full sm:w-72">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]"
                   fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                      d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
              </svg>
              <input
                type="text"
                value={itemSearch}
                onChange={(e) => setItemSearch(e.target.value)}
                placeholder="Search item name…"
                className="w-full pl-9 pr-8 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] placeholder-[#8B7355] focus:outline-none focus:border-[#af4408]"
              />
              {itemSearch && (
                <button
                  onClick={() => setItemSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8B7355] hover:text-[#af4408] px-1.5 py-0.5 text-xs"
                  title="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
          {sortedItems.length === 0 ? (
            <p className="text-[#8B7355] text-sm text-center py-8">
              {searchQuery ? `No items match "${itemSearch}"` : 'No data for selected period'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-[#E8D5C4]">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3]">
                  <tr className="text-[#8B7355]">
                    {[
                      { key: 'item_name', label: 'Item Name', align: 'left' },
                      { key: 'quantity_sold', label: 'Qty Sold', align: 'right' },
                      { key: 'revenue', label: 'Revenue (\u20B9)', align: 'right' },
                      { key: 'cost', label: 'Cost (\u20B9)', align: 'right' },
                      { key: 'profit', label: 'Profit (\u20B9)', align: 'right' },
                      { key: 'food_cost_percent', label: 'Food Cost %', align: 'right' },
                      { key: 'nc_quantity', label: 'NC Qty', align: 'right' },
                      { key: 'nc_cost', label: 'NC Loss (Purchase \u20B9)', align: 'right' },
                    ].map((col) => (
                      <th
                        key={col.key}
                        onClick={() => handleSort(col.key as SortKey)}
                        className={`py-2.5 px-3 font-medium cursor-pointer hover:text-[#3D2614] transition-colors ${
                          col.align === 'right' ? 'text-right' : 'text-left'
                        } ${sortKey === col.key ? 'text-[#af4408]' : ''}`}
                      >
                        {col.label}
                        {sortKey === col.key && (
                          <span className="ml-1">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedItems.map((item, idx) => (
                    <tr
                      key={idx}
                      className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 transition-colors"
                    >
                      <td className="py-2.5 px-3 text-[#3D2614]">{item.item_name}</td>
                      <td className="py-2.5 px-3 text-right text-[#3D2614] font-mono">{item.quantity_sold}</td>
                      <td className="py-2.5 px-3 text-right text-green-400 font-mono">
                        {formatCurrency(item.revenue)}
                      </td>
                      <td className="py-2.5 px-3 text-right text-red-400 font-mono">
                        {formatCurrency(item.cost)}
                      </td>
                      <td
                        className={`py-2.5 px-3 text-right font-mono ${
                          item.profit >= 0 ? 'text-green-400' : 'text-red-400'
                        }`}
                      >
                        {formatCurrency(item.profit)}
                      </td>
                      <td
                        className={`py-2.5 px-3 text-right font-mono ${
                          item.food_cost_percent > 35
                            ? 'text-red-400'
                            : item.food_cost_percent > 30
                            ? 'text-amber-400'
                            : 'text-green-400'
                        }`}
                      >
                        {item.food_cost_percent}%
                      </td>
                      <td className="py-2.5 px-3 text-right text-amber-400 font-mono">{item.nc_quantity}</td>
                      <td className="py-2.5 px-3 text-right text-amber-400 font-mono">
                        {formatCurrency(item.nc_cost)}
                      </td>
                    </tr>
                  ))}
                  {/* Totals row */}
                  <tr className="border-t-2 border-[#D4B896] bg-[#FFF1E3]/50 font-semibold">
                    <td className="py-2.5 px-3 text-[#3D2614]">Total</td>
                    <td className="py-2.5 px-3 text-right text-[#3D2614] font-mono">
                      {sortedItems.reduce((s, i) => s + i.quantity_sold, 0)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-green-400 font-mono">
                      {formatCurrency(totals.revenue)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-red-400 font-mono">
                      {formatCurrency(totals.cost)}
                    </td>
                    <td
                      className={`py-2.5 px-3 text-right font-mono ${
                        totals.profit >= 0 ? 'text-green-400' : 'text-red-400'
                      }`}
                    >
                      {formatCurrency(totals.profit)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-[#6B5744] font-mono">
                      {totals.revenue > 0
                        ? Math.round((totals.cost / totals.revenue) * 10000) / 100
                        : 0}
                      %
                    </td>
                    <td className="py-2.5 px-3 text-right text-amber-400 font-mono">
                      {sortedItems.reduce((s, i) => s + i.nc_quantity, 0)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-amber-400 font-mono">
                      {formatCurrency(totals.ncCost)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Profit by Item */}
          <ChartCard title="Profit by Item" subtitle="Top 10 items">
            {profitByItem.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={profitByItem} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
                  <XAxis
                    type="number"
                    stroke="#8B7355"
                    fontSize={11}
                    tick={{ fill: '#6B5744' }}
                    tickFormatter={(v) => `\u20B9${(v / 1000).toFixed(0)}k`}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    stroke="#8B7355"
                    fontSize={11}
                    tick={{ fill: '#6B5744' }}
                    width={100}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid #E8D5C4', borderRadius: '8px', color: '#2D1B0E' }}
                    formatter={(value: any) => [formatCurrency(Number(value)), 'Profit']}
                  />
                  <Bar dataKey="profit" fill={COLORS.profit} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart />
            )}
          </ChartCard>

          {/* Food Cost Distribution */}
          <ChartCard title="Food Cost Distribution" subtitle="Food cost % per item (30% target)">
            {foodCostByItem.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={foodCostByItem} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
                  <XAxis
                    type="number"
                    stroke="#8B7355"
                    fontSize={11}
                    tick={{ fill: '#6B5744' }}
                    domain={[0, 'auto']}
                    tickFormatter={(v) => `${v}%`}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    stroke="#8B7355"
                    fontSize={11}
                    tick={{ fill: '#6B5744' }}
                    width={100}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid #E8D5C4', borderRadius: '8px', color: '#2D1B0E' }}
                    formatter={(value: any) => [`${value}%`, 'Food Cost %']}
                  />
                  <ReferenceLine x={30} stroke={COLORS.cost} strokeDasharray="5 5" label={{ value: '30%', fill: '#EF4444', fontSize: 11 }} />
                  <Bar
                    dataKey="percent"
                    radius={[0, 4, 4, 0]}
                    fill={COLORS.nc}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart />
            )}
          </ChartCard>

          {/* NC Impact Pie */}
          <ChartCard title="NC Impact" subtitle="Normal Revenue vs NC vs Complimentary">
            {ncPieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={ncPieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={110}
                    paddingAngle={2}
                    stroke="none"
                  >
                    {ncPieData.map((_entry, index) => (
                      <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid #E8D5C4', borderRadius: '8px', color: '#2D1B0E' }}
                    formatter={(value: any) => [formatCurrency(Number(value))]}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 12 }}
                    formatter={(value) => <span style={{ color: '#2D1B0E' }}>{value}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart />
            )}
          </ChartCard>

          {/* Revenue vs Cost Over Time */}
          <ChartCard title="Revenue vs Cost Over Time" subtitle={`${period} view`}>
            {data.period_data.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={data.period_data}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
                  <XAxis
                    dataKey="period"
                    stroke="#8B7355"
                    fontSize={11}
                    tick={{ fill: '#6B5744' }}
                  />
                  <YAxis
                    stroke="#8B7355"
                    fontSize={11}
                    tick={{ fill: '#6B5744' }}
                    tickFormatter={(v) => `\u20B9${(v / 1000).toFixed(0)}k`}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid #E8D5C4', borderRadius: '8px', color: '#2D1B0E' }}
                    labelStyle={{ color: '#2D1B0E' }}
                    formatter={(value: any, name: any) => [formatCurrency(Number(value)), name]}
                  />
                  <Legend wrapperStyle={{ color: '#6B5744', fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="total_sales"
                    name="Revenue"
                    stroke={COLORS.revenue}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="total_cost"
                    name="Cost"
                    stroke={COLORS.cost}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="gross_profit"
                    name="Profit"
                    stroke={COLORS.profit}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    strokeDasharray="5 5"
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart />
            )}
          </ChartCard>
        </div>

        {/* Operational Leakage Report */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 shadow">
          <h2 className="text-lg font-semibold text-[#2D1B0E] mb-4 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            Operational Leakage Report
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4 mb-6">
            <div className="bg-[#FFF1E3]/50 rounded-lg p-4">
              <p className="text-xs text-[#8B7355] mb-1">Total NC Bills</p>
              <p className="text-2xl font-bold text-amber-400">
                {data.nc_impact?.total_nc_quantity || 0}
              </p>
            </div>
            <div className="bg-[#FFF1E3]/50 rounded-lg p-4">
              <p className="text-xs text-[#8B7355] mb-1">Actual Loss due to NC (Purchase Cost)</p>
              <p className="text-2xl font-bold text-red-400">
                {formatCurrency(totals.ncCost)}
              </p>
            </div>
            <div className="bg-[#FFF1E3]/50 rounded-lg p-4">
              <p className="text-xs text-[#8B7355] mb-1">Leakage % (Purchase Cost / Total Cost)</p>
              <p className={`text-2xl font-bold ${leakagePercent > 5 ? 'text-red-400' : 'text-amber-400'}`}>
                {leakagePercent}%
              </p>
            </div>
          </div>

          {ncBreakdown.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-[#E8D5C4]">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3]">
                  <tr className="text-[#8B7355]">
                    <th className="text-left py-2.5 px-3 font-medium">Item</th>
                    <th className="text-right py-2.5 px-3 font-medium">NC Qty</th>
                    <th className="text-right py-2.5 px-3 font-medium">NC Loss (Purchase {'\u20B9'})</th>
                    <th className="text-right py-2.5 px-3 font-medium">% of Total NC</th>
                  </tr>
                </thead>
                <tbody>
                  {ncBreakdown.map((item, idx) => (
                    <tr
                      key={idx}
                      className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 transition-colors"
                    >
                      <td className="py-2.5 px-3 text-[#3D2614]">{item.item_name}</td>
                      <td className="py-2.5 px-3 text-right text-amber-400 font-mono">{item.nc_quantity}</td>
                      <td className="py-2.5 px-3 text-right text-red-400 font-mono">
                        {formatCurrency(item.nc_cost)}
                      </td>
                      <td className="py-2.5 px-3 text-right text-[#6B5744] font-mono">
                        {totals.ncCost > 0 ? Math.round((item.nc_cost / totals.ncCost) * 10000) / 100 : 0}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[#8B7355] text-sm text-center py-4">No NC records for selected period</p>
          )}
        </div>

        {/* ============================================================ */}
        {/* Department-wise Consumption                                    */}
        {/* Driven by requisition_items.quantity_issued × avg_price.       */}
        {/* Audit-only — kept separate from recipe-cost calculations.      */}
        {/* ============================================================ */}
        <DepartmentConsumptionSection deptData={deptData} from={fromDate} to={toDate} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Department-wise consumption section                                 */
/* ------------------------------------------------------------------ */

function DepartmentConsumptionSection({ deptData, from, to }: { deptData: any | null; from: string; to: string }) {
  const departments = deptData?.by_department || [];
  const topMaterials = deptData?.top_materials || [];
  const summary = deptData?.summary || {};
  const totalValue = summary.total_value || 0;
  const maxValue = departments[0]?.total_value || 1;

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 shadow">
      <div className="flex items-start justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-[#af4408]" /> Department-wise Consumption
          </h2>
          <p className="text-xs text-[#8B7355] mt-0.5">
            What each kitchen drew from main store between {from} and {to}.
            Sourced from issued requisitions (transfers + workflow). Internal transfers — not part of recipe-cost calculations.
          </p>
        </div>
        <a href={`/department-consumption?from=${from}&to=${to}`}
           className="text-xs text-[#af4408] hover:underline flex items-center gap-1">
          Open full view <span>→</span>
        </a>
      </div>

      {!deptData ? (
        <div className="text-xs text-[#8B7355] text-center py-6">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading department data…
        </div>
      ) : departments.length === 0 ? (
        <div className="text-xs text-[#8B7355] text-center py-6">
          No requisition data in this range. Import Recaho Transfer reports from{' '}
          <a href="/requisitions" className="text-[#af4408] underline">Requisitions</a> to populate this section.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-sm">
            <div className="bg-[#FFF1E3] border border-[#D4B896] rounded-lg p-2.5">
              <div className="text-[10px] text-[#8B7355] uppercase">Total Issued ₹</div>
              <div className="text-lg font-bold text-[#af4408]">{formatCurrency(totalValue)}</div>
            </div>
            <div className="bg-[#FFF1E3] border border-[#D4B896] rounded-lg p-2.5">
              <div className="text-[10px] text-[#8B7355] uppercase">Departments</div>
              <div className="text-lg font-bold text-[#2D1B0E]">{summary.departments || 0}</div>
            </div>
            <div className="bg-[#FFF1E3] border border-[#D4B896] rounded-lg p-2.5">
              <div className="text-[10px] text-[#8B7355] uppercase">Materials</div>
              <div className="text-lg font-bold text-[#2D1B0E]">{summary.materials || 0}</div>
            </div>
            <div className="bg-[#FFF1E3] border border-[#D4B896] rounded-lg p-2.5">
              <div className="text-[10px] text-[#8B7355] uppercase">Requisitions</div>
              <div className="text-lg font-bold text-[#2D1B0E]">{summary.requisition_count || 0}</div>
            </div>
          </div>

          {/* Department leaderboard */}
          <h3 className="text-sm font-semibold text-[#2D1B0E] mb-2">By Department</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left  py-1.5 px-3 font-medium">Department</th>
                  <th className="text-right py-1.5 px-3 font-medium">Materials</th>
                  <th className="text-right py-1.5 px-3 font-medium">Requisitions</th>
                  <th className="text-right py-1.5 px-3 font-medium">Total Value ₹</th>
                  <th className="text-right py-1.5 px-3 font-medium">Share %</th>
                  <th className="text-left  py-1.5 px-3 font-medium w-32"></th>
                </tr>
              </thead>
              <tbody>
                {departments.map((d: any) => {
                  const share = totalValue > 0 ? (d.total_value / totalValue) * 100 : 0;
                  const barPct = (d.total_value / maxValue) * 100;
                  return (
                    <tr key={d.department_id} className="border-t border-[#E8D5C4]/50">
                      <td className="py-2 px-3 font-medium text-[#2D1B0E]">
                        {d.department_name}
                        {d.code && <span className="ml-1 text-[10px] font-mono text-[#8B7355]">[{d.code}]</span>}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-[#6B5744]">{d.material_count}</td>
                      <td className="py-2 px-3 text-right font-mono text-[#6B5744]">{d.requisition_count}</td>
                      <td className="py-2 px-3 text-right font-mono font-semibold text-[#af4408]">
                        {formatCurrency(d.total_value)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-[#6B5744]">{share.toFixed(1)}%</td>
                      <td className="py-2 px-3">
                        <div className="h-2 bg-[#FFF1E3] rounded">
                          <div className="h-2 bg-[#af4408] rounded" style={{ width: `${barPct}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Top materials in this period */}
          {topMaterials.length > 0 && (
            <>
              <h3 className="text-sm font-semibold text-[#2D1B0E] mt-6 mb-2">Top Materials Consumed</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-[#FFF1E3] text-[#6B5744]">
                    <tr>
                      <th className="text-left  py-1.5 px-3 font-medium">SKU</th>
                      <th className="text-left  py-1.5 px-3 font-medium">Material</th>
                      <th className="text-left  py-1.5 px-3 font-medium">Category</th>
                      <th className="text-right py-1.5 px-3 font-medium">Qty</th>
                      <th className="text-right py-1.5 px-3 font-medium">Value ₹</th>
                      <th className="text-right py-1.5 px-3 font-medium">Depts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topMaterials.slice(0, 15).map((m: any) => (
                      <tr key={m.material_id} className="border-t border-[#E8D5C4]/50">
                        <td className="py-1.5 px-3 font-mono text-[10px] text-[#8B7355]">{m.material_sku || '·'}</td>
                        <td className="py-1.5 px-3">{m.material_name}</td>
                        <td className="py-1.5 px-3 text-[#6B5744]">{m.category}</td>
                        <td className="py-1.5 px-3 text-right font-mono">
                          {(m.total_qty || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                          <span className="text-[#8B7355] ml-1">{m.material_unit}</span>
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono font-semibold">{formatCurrency(m.total_value)}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]">{m.distinct_depts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {topMaterials.length > 15 && (
                <div className="text-[10px] text-[#8B7355] mt-1 italic">
                  …and {topMaterials.length - 15} more — see full breakdown on{' '}
                  <a href={`/department-consumption?from=${from}&to=${to}`} className="text-[#af4408] underline">Dept Consumption page</a>.
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function PnLCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: 'green' | 'red' | 'blue' | 'amber' | 'purple';
}) {
  const accents: Record<string, { bg: string; text: string }> = {
    green: { bg: 'bg-green-500/10', text: 'text-green-400' },
    red: { bg: 'bg-red-500/10', text: 'text-red-400' },
    blue: { bg: 'bg-[#af4408]/10', text: 'text-[#af4408]' },
    amber: { bg: 'bg-amber-500/10', text: 'text-amber-400' },
    purple: { bg: 'bg-purple-500/10', text: 'text-purple-400' },
  };
  const a = accents[color];
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow">
      <div className="flex items-center gap-2 mb-2">
        <div className={`p-1.5 rounded-lg ${a.bg}`}>
          <span className={a.text}>{icon}</span>
        </div>
        <span className="text-xs text-[#8B7355]">{label}</span>
      </div>
      <p className={`text-xl font-bold ${a.text}`}>{value}</p>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 shadow">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-[#2D1B0E]">{title}</h3>
        <p className="text-xs text-[#8B7355]">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex items-center justify-center h-[300px] text-[#8B7355] text-sm">
      No data available
    </div>
  );
}
