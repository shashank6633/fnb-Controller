'use client';

import { useEffect, useState } from 'react';
import {
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  DollarSign,
  Package,
  ChefHat,
  ShoppingCart,
  BarChart3,
  Loader2,
  Database,
  ClipboardList,
  Flame,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import Link from 'next/link';
import type { DashboardData } from '@/types';
import { api } from '@/lib/api';

const COLORS = {
  revenue: '#10B981',
  cost: '#EF4444',
  profit: '#3B82F6',
  nc: '#F59E0B',
};

const PIE_COLORS = [
  '#10B981',
  '#3B82F6',
  '#F59E0B',
  '#EF4444',
  '#8B5CF6',
  '#EC4899',
  '#06B6D4',
  '#84CC16',
  '#F97316',
  '#6366F1',
];

function formatCurrency(value: number): string {
  return '₹' + value.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function LoadingSkeleton() {
  return (
    <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <div className="h-9 w-48 bg-[#FFF1E3] rounded-lg" />
          <div className="h-10 w-40 bg-[#FFF1E3] rounded-lg" />
        </div>
        <div className="stagger grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-6 h-32" />
          ))}
        </div>
        <div className="stagger grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-4 h-24" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-6 h-80" />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Inventory module additions
  const [pendingPOs, setPendingPOs] = useState<any[]>([]);
  const [costSpikes, setCostSpikes] = useState<any[]>([]);

  const fetchExtras = async () => {
    try {
      const [poRes, spikeRes] = await Promise.all([
        fetch('/api/purchase-orders?status=pending').then(r => r.json()).catch(() => ({})),
        fetch('/api/cost-spikes?threshold_pct=10&limit=8').then(r => r.json()).catch(() => ({})),
      ]);
      setPendingPOs(poRes.purchase_orders || []);
      setCostSpikes(spikeRes.spikes || []);
    } catch { /* non-fatal */ }
  };

  const fetchData = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      setError(null);
      const res = await fetch('/api/analytics');
      if (!res.ok) throw new Error('Failed to fetch analytics');
      const json = await res.json();
      setData(json);
      fetchExtras();
    } catch (err: any) {
      setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const seedData = async () => {
    try {
      setSeeding(true);
      const res = await api('/api/seed', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to seed data');
      await fetchData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSeeding(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Auto-refresh every 30s, paused when tab is hidden
    const interval = setInterval(() => {
      if (!document.hidden) fetchData(true);
    }, 30000);
    const onVisible = () => { if (!document.hidden) fetchData(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

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

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Dashboard</h1>
            <p className="text-[#8B7355] text-sm mt-1">{today}</p>
          </div>
          <button
            onClick={seedData}
            disabled={seeding}
            className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:opacity-60 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {seeding ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Database className="w-4 h-4" />
            )}
            {seeding ? 'Seeding...' : 'Seed Sample Data'}
          </button>
        </div>

        {/* Yesterday's anomalies + tie-out */}
        <AnomalyTile />

        {/* Phase 1 §6 — EOD ritual: items configured for daily counting */}
        <DailyTrackedWidget />

        {/* KPI Cards */}
        <div className="stagger grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-4">
          <KPICard
            icon={<DollarSign className="w-5 h-5" />}
            label="Total Revenue"
            value={formatCurrency(data.total_revenue)}
            sub={`${data.total_items_sold} items sold`}
            color="green"
          />
          <KPICard
            icon={<TrendingDown className="w-5 h-5" />}
            label="Total Cost"
            value={formatCurrency(data.total_cost)}
            sub="All categories"
            color="red"
          />
          <KPICard
            icon={<TrendingUp className="w-5 h-5" />}
            label="Gross Profit"
            value={formatCurrency(data.gross_profit)}
            sub={`${data.gross_margin}% margin`}
            color="blue"
          />
          <KPICard
            icon={<AlertTriangle className="w-5 h-5" />}
            label="NC / Operational Leakage"
            value={formatCurrency(data.nc_loss)}
            sub="Purchase Cost Loss (NC + Comp.)"
            color="amber"
          />
        </div>

        {/* Secondary KPIs */}
        <div className="stagger grid grid-cols-2 md:grid-cols-5 lg:grid-cols-5 gap-4">
          <SecondaryKPI
            icon={<BarChart3 className="w-4 h-4 text-[#af4408]" />}
            label="Gross Margin"
            value={`${data.gross_margin}%`}
          />
          <SecondaryKPI
            icon={<ShoppingCart className="w-4 h-4 text-green-400" />}
            label="Items Sold"
            value={data.total_items_sold.toLocaleString('en-IN')}
          />
          <Link href="/inventory" className="group">
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 flex items-center gap-3 group-hover:border-amber-500/50 transition-colors h-full">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <Package className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <p className="text-xs text-[#8B7355]">Low Stock Alerts</p>
                <p className="text-xl font-bold text-amber-400">{data.low_stock_count}</p>
              </div>
            </div>
          </Link>
          <SecondaryKPI
            icon={<ChefHat className="w-4 h-4 text-purple-400" />}
            label="Active Recipes"
            value={data.active_recipes.toString()}
          />
          <Link href="/purchase-orders?status=pending" className="group">
            <div className={`bg-white border rounded-xl p-4 flex items-center gap-3 transition-colors h-full ${pendingPOs.length > 0 ? 'border-amber-400 group-hover:border-amber-500' : 'border-[#E8D5C4] group-hover:border-[#D4B896]'}`}>
              <div className={`p-2 rounded-lg ${pendingPOs.length > 0 ? 'bg-amber-100' : 'bg-gray-100'}`}>
                <ClipboardList className={`w-4 h-4 ${pendingPOs.length > 0 ? 'text-amber-700' : 'text-gray-500'}`} />
              </div>
              <div>
                <p className="text-xs text-[#8B7355]">Pending POs</p>
                <p className={`text-xl font-bold ${pendingPOs.length > 0 ? 'text-amber-700' : 'text-[#2D1B0E]'}`}>
                  {pendingPOs.length}
                </p>
              </div>
            </div>
          </Link>
        </div>

        {/* Purchase vs Sale Comparison */}
        {data.purchase_vs_sale && data.purchase_vs_sale.length > 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 shadow">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-2">
              <div>
                <h3 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-[#af4408]" />
                  Purchase vs Sale — Monthly Comparison
                </h3>
                <p className="text-xs text-[#8B7355]">Total purchase spend vs sales revenue by month</p>
              </div>
              <div className="flex gap-4 text-sm">
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-sm bg-[#af4408]" />
                  <span className="text-[#6B5744]">Purchases</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-sm bg-[#10B981]" />
                  <span className="text-[#6B5744]">Sales Revenue</span>
                </div>
              </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
                <p className="text-[10px] text-[#8B7355] uppercase tracking-wide">Total Purchases</p>
                <p className="text-lg font-bold text-[#af4408]">{formatCurrency(data.total_purchase_spend || 0)}</p>
              </div>
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
                <p className="text-[10px] text-[#8B7355] uppercase tracking-wide">Total Sales</p>
                <p className="text-lg font-bold text-green-600">{formatCurrency(data.total_revenue || 0)}</p>
              </div>
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
                <p className="text-[10px] text-[#8B7355] uppercase tracking-wide">Net Difference</p>
                <p className={`text-lg font-bold ${(data.total_revenue - (data.total_purchase_spend || 0)) >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                  {formatCurrency(data.total_revenue - (data.total_purchase_spend || 0))}
                </p>
              </div>
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
                <p className="text-[10px] text-[#8B7355] uppercase tracking-wide">Purchase Count</p>
                <p className="text-lg font-bold text-[#2D1B0E]">{(data.total_purchase_count || 0).toLocaleString('en-IN')}</p>
              </div>
            </div>

            {/* Chart */}
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={data.purchase_vs_sale} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
                <XAxis
                  dataKey="month"
                  stroke="#8B7355"
                  fontSize={12}
                  tick={{ fill: '#6B5744' }}
                  tickFormatter={(m: string) => {
                    const [y, mo] = m.split('-');
                    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                    return `${months[parseInt(mo) - 1]} ${y.slice(2)}`;
                  }}
                />
                <YAxis
                  stroke="#8B7355"
                  fontSize={11}
                  tick={{ fill: '#6B5744' }}
                  tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid #E8D5C4', borderRadius: '8px' }}
                  labelStyle={{ color: '#6B5744', fontWeight: 600 }}
                  formatter={((value: any, name: any) => [formatCurrency(Number(value)), name]) as any}
                  labelFormatter={((label: any) => {
                    const [y, mo] = String(label).split('-');
                    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
                    return `${months[parseInt(mo) - 1]} ${y}`;
                  }) as any}
                />
                <Bar dataKey="purchase_total" name="Purchase Spend" fill="#af4408" radius={[4, 4, 0, 0]} />
                <Bar dataKey="sale_revenue" name="Sales Revenue" fill="#10B981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>

            {/* Monthly Breakdown Table */}
            <div className="mt-4 overflow-x-auto rounded-lg border border-[#E8D5C4]">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3]">
                  <tr className="text-[#8B7355]">
                    <th className="text-left py-2.5 px-3 font-medium">Month</th>
                    <th className="text-right py-2.5 px-3 font-medium">Purchases</th>
                    <th className="text-right py-2.5 px-3 font-medium">Sales Revenue</th>
                    <th className="text-right py-2.5 px-3 font-medium">COGS</th>
                    <th className="text-right py-2.5 px-3 font-medium">Net (Sales - Purchases)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.purchase_vs_sale.map((row: any, i: number) => {
                    const net = row.sale_revenue - row.purchase_total;
                    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                    const [y, mo] = row.month.split('-');
                    return (
                      <tr key={i} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30">
                        <td className="py-2.5 px-3 text-[#2D1B0E] font-medium">{months[parseInt(mo) - 1]} {y}</td>
                        <td className="py-2.5 px-3 text-right text-[#af4408] font-mono">{formatCurrency(row.purchase_total)}</td>
                        <td className="py-2.5 px-3 text-right text-green-600 font-mono">{formatCurrency(row.sale_revenue)}</td>
                        <td className="py-2.5 px-3 text-right text-[#6B5744] font-mono">{formatCurrency(row.sale_cost)}</td>
                        <td className={`py-2.5 px-3 text-right font-mono font-semibold ${net >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                          {formatCurrency(net)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Revenue vs Cost Trend */}
          <ChartCard title="Revenue vs Cost Trend" subtitle="Last 30 days">
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={data.daily_trend}>
                <defs>
                  <linearGradient id="gradRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COLORS.revenue} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={COLORS.revenue} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COLORS.cost} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={COLORS.cost} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatShortDate}
                  stroke="#8B7355"
                  fontSize={11}
                  tick={{ fill: '#6B5744' }}
                />
                <YAxis
                  stroke="#8B7355"
                  fontSize={11}
                  tick={{ fill: '#6B5744' }}
                  tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid #E8D5C4', borderRadius: '8px' }}
                  labelStyle={{ color: '#6B5744' }}
                  formatter={(value: any) => [formatCurrency(Number(value))]}
                  labelFormatter={(label: any) => formatShortDate(String(label))}
                />
                <Legend wrapperStyle={{ color: '#6B5744', fontSize: 12 }} />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  name="Revenue"
                  stroke={COLORS.revenue}
                  fill="url(#gradRevenue)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="cost"
                  name="Cost"
                  stroke={COLORS.cost}
                  fill="url(#gradCost)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Top 10 Sellers */}
          <ChartCard title="Top 10 Sellers" subtitle="By quantity sold">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.top_sellers} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
                <XAxis type="number" stroke="#8B7355" fontSize={11} tick={{ fill: '#6B5744' }} />
                <YAxis
                  type="category"
                  dataKey="name"
                  stroke="#8B7355"
                  fontSize={11}
                  tick={{ fill: '#6B5744' }}
                  width={100}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid #E8D5C4', borderRadius: '8px' }}
                  labelStyle={{ color: '#6B5744' }}
                />
                <Bar dataKey="quantity" name="Qty Sold" fill={COLORS.revenue} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Category Breakdown */}
          <ChartCard title="Category Breakdown" subtitle="Revenue by category">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={data.category_breakdown}
                  dataKey="revenue"
                  nameKey="category"
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={110}
                  paddingAngle={2}
                  stroke="none"
                >
                  {data.category_breakdown.map((_entry, index) => (
                    <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid #E8D5C4', borderRadius: '8px' }}
                  formatter={(value: any) => [formatCurrency(Number(value))]}
                />
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  formatter={(value) => <span className="text-[#6B5744]">{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* NC Impact Over Time */}
          <ChartCard title="NC Impact Over Time" subtitle="NC cost per day">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.nc_impact}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatShortDate}
                  stroke="#8B7355"
                  fontSize={11}
                  tick={{ fill: '#6B5744' }}
                />
                <YAxis
                  stroke="#8B7355"
                  fontSize={11}
                  tick={{ fill: '#6B5744' }}
                  tickFormatter={(v) => `₹${v}`}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid #E8D5C4', borderRadius: '8px' }}
                  labelStyle={{ color: '#6B5744' }}
                  formatter={(value: any, name: any) => {
                    if (name === 'NC Cost') return [formatCurrency(Number(value)), name];
                    return [value, name];
                  }}
                  labelFormatter={(label: any) => formatShortDate(String(label))}
                />
                <Bar dataKey="nc_cost" name="NC Cost" fill={COLORS.nc} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        {/* Cost Spikes — ingredients where latest purchase exceeded historical avg by 10%+ */}
        {costSpikes.length > 0 && (
          <div className="bg-white border border-amber-200 rounded-xl shadow overflow-hidden">
            <div className="px-4 py-3 border-b border-amber-200 bg-amber-50 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-amber-900 flex items-center gap-2">
                <Flame className="w-4 h-4" /> Cost Spikes — last purchase &gt; 10% above average
              </h3>
              <span className="text-xs text-amber-800">{costSpikes.length} flagged</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-amber-50/50 text-xs text-[#6B5744]">
                  <tr>
                    <th className="text-left  py-1.5 px-3 font-medium">SKU</th>
                    <th className="text-left  py-1.5 px-3 font-medium">Material</th>
                    <th className="text-left  py-1.5 px-3 font-medium">Vendor</th>
                    <th className="text-right py-1.5 px-3 font-medium">Avg ₹</th>
                    <th className="text-right py-1.5 px-3 font-medium">Latest ₹</th>
                    <th className="text-right py-1.5 px-3 font-medium">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {costSpikes.slice(0, 8).map((s: any, i: number) => (
                    <tr key={i} className="border-t border-amber-100/50 hover:bg-amber-50/30">
                      <td className="py-1.5 px-3 text-[10px] font-mono text-[#8B7355]">{s.sku || '·'}</td>
                      <td className="py-1.5 px-3 text-xs text-[#2D1B0E]">{s.name}</td>
                      <td className="py-1.5 px-3 text-xs text-[#6B5744]">{s.latest_vendor || '—'}</td>
                      <td className="py-1.5 px-3 text-xs text-right font-mono">₹{s.avg_price.toFixed(2)}</td>
                      <td className="py-1.5 px-3 text-xs text-right font-mono">₹{s.latest_price.toFixed(2)}</td>
                      <td className="py-1.5 px-3 text-xs text-right font-mono font-semibold text-red-600">+{s.pct_change.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Tables Section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-6">
          {/* Most Profitable Items */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 shadow">
            <h3 className="text-lg font-semibold text-[#2D1B0E] mb-4 flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-green-400" />
              Most Profitable Items
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[#8B7355] border-b border-[#E8D5C4]">
                  <th className="text-left py-2 font-medium">Item</th>
                  <th className="text-right py-2 font-medium">Profit</th>
                  <th className="text-right py-2 font-medium">Margin</th>
                </tr>
              </thead>
              <tbody>
                {data.most_profitable.slice(0, 5).map((item, i) => (
                  <tr
                    key={i}
                    className="border-b border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 transition-colors"
                  >
                    <td className="py-2.5 text-[#3D2614]">{item.name}</td>
                    <td className="py-2.5 text-right text-green-400 font-mono">
                      {formatCurrency(item.profit)}
                    </td>
                    <td className="py-2.5 text-right text-[#6B5744] font-mono">
                      {item.margin}%
                    </td>
                  </tr>
                ))}
                {data.most_profitable.length === 0 && (
                  <tr>
                    <td colSpan={3} className="py-4 text-center text-[#8B7355]">
                      No data available
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Loss-Making Items */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 shadow">
            <h3 className="text-lg font-semibold text-[#2D1B0E] mb-4 flex items-center gap-2">
              <TrendingDown className="w-5 h-5 text-red-400" />
              Loss-Making Items
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[#8B7355] border-b border-[#E8D5C4]">
                  <th className="text-left py-2 font-medium">Item</th>
                  <th className="text-right py-2 font-medium">Profit</th>
                  <th className="text-right py-2 font-medium">Food Cost %</th>
                </tr>
              </thead>
              <tbody>
                {data.loss_makers.map((item, i) => (
                  <tr
                    key={i}
                    className="border-b border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 transition-colors"
                  >
                    <td className="py-2.5 text-[#3D2614]">{item.name}</td>
                    <td className="py-2.5 text-right text-red-400 font-mono">
                      {formatCurrency(item.profit)}
                    </td>
                    <td className="py-2.5 text-right font-mono">
                      <span
                        className={
                          item.food_cost_percent > 65
                            ? 'text-red-400'
                            : 'text-[#6B5744]'
                        }
                      >
                        {item.food_cost_percent}%
                      </span>
                    </td>
                  </tr>
                ))}
                {data.loss_makers.length === 0 && (
                  <tr>
                    <td colSpan={3} className="py-4 text-center text-[#8B7355]">
                      No loss-making items
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Stock Alerts */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 shadow">
            <h3 className="text-lg font-semibold text-[#2D1B0E] mb-4 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
              Stock Alerts
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[#8B7355] border-b border-[#E8D5C4]">
                  <th className="text-left py-2 font-medium">Material</th>
                  <th className="text-right py-2 font-medium">Stock</th>
                  <th className="text-right py-2 font-medium">Reorder</th>
                </tr>
              </thead>
              <tbody>
                {data.stock_alerts.slice(0, 8).map((alert, i) => (
                  <tr
                    key={i}
                    className="border-b border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 transition-colors"
                  >
                    <td className="py-2.5 text-[#3D2614]">{alert.material_name}</td>
                    <td className="py-2.5 text-right text-red-400 font-mono">
                      {alert.current_stock} {alert.unit}
                    </td>
                    <td className="py-2.5 text-right text-[#8B7355] font-mono">
                      {alert.reorder_level} {alert.unit}
                    </td>
                  </tr>
                ))}
                {data.stock_alerts.length === 0 && (
                  <tr>
                    <td colSpan={3} className="py-4 text-center text-[#8B7355]">
                      All stock levels OK
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {data.stock_alerts.length > 8 && (
              <Link
                href="/inventory"
                className="block mt-3 text-center text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                View all {data.stock_alerts.length} alerts
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function KPICard({
  icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  color: 'green' | 'red' | 'blue' | 'amber';
}) {
  const accents: Record<string, { bg: string; text: string; border: string }> = {
    green: { bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/20' },
    red: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/20' },
    blue: { bg: 'bg-[#af4408]/10', text: 'text-[#af4408]', border: 'border-[#af4408]/20' },
    amber: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/20' },
  };
  const a = accents[color];

  return (
    <div className={`card-lift bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-6 shadow`}>
      <div className="flex items-center gap-2 sm:gap-3 mb-2 sm:mb-3">
        <div className={`p-1.5 sm:p-2 rounded-lg ${a.bg}`}>
          <span className={a.text}>{icon}</span>
        </div>
        <span className="text-xs sm:text-sm text-[#8B7355] leading-tight">{label}</span>
      </div>
      <p className={`text-xl sm:text-2xl font-bold ${a.text}`}>{value}</p>
      <p className="text-[11px] sm:text-xs text-[#8B7355] mt-1">{sub}</p>
    </div>
  );
}

function SecondaryKPI({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 flex items-center gap-3">
      <div className="p-2 rounded-lg bg-[#FFF1E3]">{icon}</div>
      <div>
        <p className="text-xs text-[#8B7355]">{label}</p>
        <p className="text-xl font-bold text-[#2D1B0E]">{value}</p>
      </div>
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

/* ============================================================ */
/* Phase 1 §6 — Daily-Tracked Items widget (EOD ritual)          */
/* ============================================================ */
function DailyTrackedWidget() {
  const [cadence, setCadence] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showOnlyPending, setShowOnlyPending] = useState(true);
  // Per-row count entry: material_id → typed value (string while editing).
  const [entries, setEntries] = useState<Record<string, string>>({});
  // Inflight save tracking + last error per row
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errorByRow, setErrorByRow] = useState<Record<string, string>>({});

  const reload = () => {
    setLoading(true);
    fetch(`/api/daily-tracked?cadence=${cadence}`).then(r => r.json()).then(d => { setData(d); setLoading(false); });
  };

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [cadence]);

  const saveCount = async (mat: any) => {
    const raw = entries[mat.id];
    if (raw === undefined || raw === '' || isNaN(Number(raw))) {
      setErrorByRow(p => ({ ...p, [mat.id]: 'Enter a number' }));
      return;
    }
    setSavingId(mat.id);
    setErrorByRow(p => { const n = { ...p }; delete n[mat.id]; return n; });
    try {
      // The /api/closing-stock POST stores in recipe-units. If user typed in
      // purchase units (visible in the widget when pack_size > 1), convert.
      const physical = Number(raw) * (mat.pack_size > 1 ? mat.pack_size : 1);
      const r = await api('/api/closing-stock', {
        method: 'POST',
        body: { date: data.date, items: [{ material_id: mat.id, physical_stock: physical }] },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErrorByRow(p => ({ ...p, [mat.id]: j.error || 'Failed' }));
      } else {
        setEntries(p => { const n = { ...p }; delete n[mat.id]; return n; });
        await reload();
      }
    } finally { setSavingId(null); }
  };
  if (loading) {
    return (
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 text-xs text-[#8B7355]">
        Loading daily-tracked items…
      </div>
    );
  }
  // Cadence window for "satisfied recently" logic
  const windowDays = cadence === 'weekly' ? 7 : cadence === 'monthly' ? 30 : 1;
  const isSatisfied = (it: any) => {
    if (cadence === 'daily') return !!it.counted_today;
    if (!it.last_count_date) return false;
    const ageDays = Math.floor((Date.now() - new Date(it.last_count_date).getTime()) / 86400000);
    return ageDays < windowDays;
  };
  const cadenceLabel = cadence === 'daily' ? 'Daily' : cadence === 'weekly' ? 'Weekly' : 'Monthly';
  const cadenceTabs = (
    <div className="flex gap-1 text-xs">
      {(['daily','weekly','monthly'] as const).map(c => (
        <button key={c} onClick={() => setCadence(c)}
          className={`px-2.5 py-1 rounded ${cadence === c ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>
          {c[0].toUpperCase() + c.slice(1)}
        </button>
      ))}
    </div>
  );

  if (!data || !data.items || data.items.length === 0) {
    return (
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-semibold text-[#2D1B0E] flex items-center gap-2">
            📋 {cadenceLabel} Inventory Tracking
          </h3>
          {cadenceTabs}
        </div>
        <p className="text-xs text-[#6B5744] mt-2">
          No items configured for <strong>{cadence}</strong> counting yet. Set <code>closing_cadence = "{cadence}"</code> on materials
          via <a href="/inventory" className="text-[#af4408] underline">Inventory</a> → Edit → Master Fields.
        </p>
      </div>
    );
  }
  const enrichedItems = data.items.map((i: any) => ({ ...i, _satisfied: isSatisfied(i) }));
  const items = (showOnlyPending ? enrichedItems.filter((i: any) => !i._satisfied) : enrichedItems);
  const satisfiedCount = enrichedItems.filter((i: any) => i._satisfied).length;
  const pendingCount = enrichedItems.length - satisfiedCount;
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex items-center gap-3 flex-wrap">
        <h3 className="font-semibold text-[#2D1B0E] flex items-center gap-2">
          📋 {cadenceLabel} Inventory Tracking — {data.date}
        </h3>
        {cadenceTabs}
        <div className="flex gap-2 text-xs">
          <span className="px-2 py-0.5 rounded bg-[#FFF1E3] text-[#6B5744]">
            <span className="font-semibold text-[#2D1B0E]">{enrichedItems.length}</span> items
          </span>
          <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">
            ✓ <span className="font-semibold">{satisfiedCount}</span> {cadence === 'daily' ? 'counted' : `within ${windowDays}d`}
          </span>
          <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800">
            ⏳ <span className="font-semibold">{pendingCount}</span> pending
          </span>
          {data.summary.low_stock > 0 && (
            <span className="px-2 py-0.5 rounded bg-red-100 text-red-700">
              ⚠ <span className="font-semibold">{data.summary.low_stock}</span> low stock
            </span>
          )}
        </div>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-[#6B5744]">
          <input type="checkbox" checked={showOnlyPending} onChange={e => setShowOnlyPending(e.target.checked)} />
          Only show pending
        </label>
        <a href="/inventory" className="text-xs text-[#af4408] hover:underline">Record counts →</a>
      </div>
      {items.length === 0 ? (
        <div className="p-6 text-center text-sm text-emerald-700">
          ✓ All {cadenceLabel.toLowerCase()}-tracked items are up to date. {cadence === 'daily' ? 'EOD complete.' : `Counted within last ${windowDays} days.`}
        </div>
      ) : (
        <div className="overflow-x-auto max-h-[280px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-[#FFF8F0] text-[#8B7355] sticky top-0">
              <tr>
                <th className="text-left  py-1.5 px-3 font-medium">Material</th>
                <th className="text-left  py-1.5 px-3 font-medium">Where</th>
                <th className="text-right py-1.5 px-3 font-medium">Current</th>
                <th className="text-right py-1.5 px-3 font-medium">Daily rate</th>
                <th className="text-right py-1.5 px-3 font-medium">Days left</th>
                <th className="text-left  py-1.5 px-3 font-medium">{cadence === 'daily' ? 'Counted today' : `Last count (need ≤${windowDays}d)`}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it: any) => {
                const isLow = it.current_stock < (it.reorder_level || 0);
                const isUrgent = it.days_of_stock != null && it.days_of_stock < 2;
                return (
                  <tr key={it.id} className={`border-t border-[#E8D5C4]/50 ${isLow ? 'bg-red-50/30' : ''}`}>
                    <td className="py-1.5 px-3">
                      <div className="font-medium text-[#2D1B0E]">{it.name}</div>
                      <div className="text-[10px] font-mono text-[#8B7355]">{it.sku || '·'}</div>
                    </td>
                    <td className="py-1.5 px-3 text-[10px] text-blue-700">
                      {it.storage_location || <span className="text-[#8B7355]">—</span>}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono">
                      {(it.pack_size > 1
                        ? `${(it.current_stock / it.pack_size).toFixed(2)} ${it.purchase_unit}`
                        : `${it.current_stock} ${it.unit}`)}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]">
                      {it.daily_consumption_rate || '—'}
                    </td>
                    <td className={`py-1.5 px-3 text-right font-mono ${isUrgent ? 'text-red-700 font-bold' : 'text-[#6B5744]'}`}>
                      {it.days_of_stock != null ? `${it.days_of_stock}d` : '—'}
                    </td>
                    <td className="py-1.5 px-3">
                      {it._satisfied && it.counted_today ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700"
                              title={`Counted ${it.today_count} ${it.unit} today`}>
                          ✓ {it.pack_size > 1
                                ? `${(it.today_count / it.pack_size).toFixed(2)} ${it.purchase_unit}`
                                : `${it.today_count} ${it.unit}`}
                        </span>
                      ) : it._satisfied && it.last_count_date ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700"
                              title={`Last counted ${it.last_count_date}`}>
                          ✓ {it.last_count_date}
                        </span>
                      ) : (
                        <div className="flex items-center gap-1">
                          <input type="number" step="any" min={0}
                                 value={entries[it.id] ?? ''}
                                 onChange={e => setEntries(p => ({ ...p, [it.id]: e.target.value }))}
                                 onKeyDown={e => { if (e.key === 'Enter') saveCount(it); }}
                                 disabled={savingId === it.id}
                                 placeholder={it.pack_size > 1 ? `count in ${it.purchase_unit}` : `count in ${it.unit}`}
                                 className="w-24 px-1.5 py-0.5 border border-[#D4B896] rounded text-xs text-right font-mono bg-white focus:outline-none focus:ring-1 focus:ring-[#af4408] disabled:opacity-50" />
                          <button type="button"
                                  onClick={() => saveCount(it)}
                                  disabled={savingId === it.id || !entries[it.id]}
                                  className="text-[10px] px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40">
                            {savingId === it.id ? '…' : 'Save'}
                          </button>
                          {errorByRow[it.id] && (
                            <span className="text-[9px] text-red-700" title={errorByRow[it.id]}>⚠</span>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ============================================================ */
/* Yesterday's Anomalies + Tie-out — actionable morning brief    */
/* ============================================================ */
function AnomalyTile() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    fetch('/api/anomalies').then(r => r.json()).then(d => { setData(d); setLoading(false); });
  }, []);

  if (loading) {
    return (
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 text-xs text-[#8B7355]">
        Scanning yesterday's data for anomalies…
      </div>
    );
  }
  if (!data || data.error) return null;

  const sevTone: Record<string, string> = {
    high:   'bg-red-50 border-red-200 text-red-800',
    medium: 'bg-amber-50 border-amber-200 text-amber-800',
    low:    'bg-blue-50 border-blue-200 text-blue-800',
  };

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex items-center gap-3 flex-wrap">
        <h3 className="font-semibold text-[#2D1B0E] flex items-center gap-2">
          🔍 Morning Brief — {data.date}
        </h3>
        <div className="flex gap-2 text-xs">
          <span className={`px-2 py-0.5 rounded ${data.tie_out.balanced ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
            {data.tie_out.balanced ? '✓ Books balanced' : `⚠ Off by ₹${Math.round(data.tie_out.variance_value_total).toLocaleString('en-IN')}`}
          </span>
          <span className="px-2 py-0.5 rounded bg-[#FFF1E3] text-[#6B5744]">
            <strong className="text-[#2D1B0E]">{data.anomaly_count}</strong> anomal{data.anomaly_count === 1 ? 'y' : 'ies'}
          </span>
        </div>
        <button onClick={() => setExpanded(!expanded)}
                className="ml-auto text-xs text-[#af4408] hover:underline">
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>
      {expanded && (
        <>
          {data.anomalies.length === 0 ? (
            <div className="p-6 text-center text-sm text-emerald-700">
              ✓ Nothing flagged. Yesterday looks clean across price, sales, variance, receiving and stock.
            </div>
          ) : (
            <ul className="divide-y divide-[#E8D5C4]/50">
              {data.anomalies.map((a: any, i: number) => (
                <li key={i} className="px-4 py-2.5 flex items-start gap-3">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded border uppercase tracking-wide ${sevTone[a.severity]}`}>
                    {a.severity}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-[#2D1B0E] flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] uppercase tracking-wide text-[#8B7355]">{a.category}</span>
                      <span>{a.headline}</span>
                    </div>
                    <div className="text-xs text-[#6B5744] mt-0.5">{a.detail}</div>
                  </div>
                  <a href={a.fix_url} className="text-xs text-[#af4408] hover:underline shrink-0">Open →</a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
