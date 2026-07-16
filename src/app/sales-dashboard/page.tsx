'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import { BarChart3, Printer, RefreshCw, Loader2, TrendingUp, ListOrdered, Utensils } from 'lucide-react';

// ── formatting ────────────────────────────────────────────────────────────────
const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n: number) => '₹' + inr.format(Number(n) || 0);
const pctS = (n: number) => (Number(n) || 0).toFixed(1) + '%';
function hm(min: number) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} hr ${m % 60} min` : `${m} min`;
}
const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

// ── types (mirror src/lib/sales-dashboard.ts) ────────────────────────────────
interface Totals { gross: number; discount: number; charges: number; netBeforeTax: number; tax: number; net: number; orders: number }
interface Perf { orders: number; avgOrderValue: number; avgOrderTimeMin: number; covers: number; avgPerCover: number }
interface Bucket { label: string; amount: number; count: number; pct: number }
interface ItemType { type: string; amount: number; pct: number }
interface FloorPnl { floor: string; sales: number; cost: number; grossProfit: number; gpPct: number; orders: number }
interface Dash {
  range: { from: string; to: string; monthFrom: string };
  day: Totals; mtd: Totals;
  itemTypesDay: ItemType[]; itemTypesMtd: ItemType[];
  performanceDay: Perf; performanceMtd: Perf;
  collectionByBusiness: Bucket[]; bySession: Bucket[]; byPaymentCategory: Bucket[];
  byPaymentStatus: { sales: number; refund: number; cancelled: { amount: number; count: number } };
  cancelBreakup: { itemCancel: { amount: number; count: number }; orderCancel: { amount: number; count: number } };
  floorPnl: FloorPnl[];
}

// ── small presentational pieces (styled like the reference) ──────────────────
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden break-inside-avoid">
      <div className="px-4 py-2 bg-[#F5EDE2] text-center text-[11px] font-bold tracking-wide text-[#6B5744] uppercase">{title}</div>
      <div className="divide-y divide-[#F0E6D8]">{children}</div>
    </div>
  );
}
function Row({ label, sub, value, count, pct, strong }: { label: string; sub?: string; value: string; count?: number; pct?: number; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-2 px-4 py-2 ${strong ? 'bg-[#FAF4EC]' : ''}`}>
      <div className="min-w-0">
        <span className={`text-[13px] ${strong ? 'font-bold text-[#2D1B0E]' : 'text-[#4A3728]'} uppercase`}>{label}</span>
        {sub && <span className="block text-[10px] text-[#8B7355] italic normal-case">{sub}</span>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {typeof count === 'number' && <span className="text-[11px] font-semibold text-green-700 bg-green-50 px-1.5 py-0.5 rounded">{count}</span>}
        {typeof pct === 'number' && <span className="text-[11px] font-medium text-[#af4408] bg-[#af4408]/10 px-1.5 py-0.5 rounded">{pctS(pct)}</span>}
        <span className={`text-[13px] tabular-nums ${strong ? 'font-bold text-[#2D1B0E]' : 'text-[#2D1B0E]'}`}>{value}</span>
      </div>
    </div>
  );
}

function TotalsCard({ title, t }: { title: string; t: Totals }) {
  return (
    <Card title={title}>
      <Row label="Gross Sales" sub="Before Discount, Charges and Taxes" value={money(t.gross)} />
      <Row label="Discount" value={money(t.discount)} pct={t.gross ? (t.discount / t.gross) * 100 : 0} />
      <Row label="Charges" value={money(t.charges)} />
      <Row label="Net Sales Before Tax" value={money(t.netBeforeTax)} />
      <Row label="Tax" value={money(t.tax)} />
      <Row label="Net Sales After Tax" value={money(t.net)} strong />
    </Card>
  );
}
function ItemTypeCard({ title, rows, total }: { title: string; rows: ItemType[]; total: number }) {
  return (
    <Card title={title}>
      {rows.map((r) => <Row key={r.type} label={r.type} value={money(r.amount)} pct={r.pct} />)}
      <Row label="Total" value={money(total)} strong />
    </Card>
  );
}
function PerfCard({ title, p }: { title: string; p: Perf }) {
  return (
    <Card title={title}>
      <Row label="Average Order Time" value={hm(p.avgOrderTimeMin)} />
      <Row label="Average Order Value" value={money(p.avgOrderValue)} />
      <Row label="Total Covers (No. of Guest)" value={String(p.covers)} />
      <Row label="Average Per Cover Cost" value={money(p.avgPerCover)} />
    </Card>
  );
}
function BucketCard({ title, rows, totalLabel }: { title: string; rows: Bucket[]; totalLabel: string }) {
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const count = rows.reduce((s, r) => s + r.count, 0);
  return (
    <Card title={title}>
      {rows.length === 0 && <Row label="No sales yet" value={money(0)} />}
      {rows.map((r) => <Row key={r.label} label={r.label} value={money(r.amount)} count={r.count} pct={r.pct} />)}
      <Row label={totalLabel} value={money(total)} count={count} strong />
    </Card>
  );
}

const gpColor = (p: number) => (p >= 65 ? 'text-emerald-700' : p >= 55 ? 'text-amber-600' : 'text-red-600');
function FloorSalesCard({ rows, showPnl }: { rows: FloorPnl[]; showPnl: boolean }) {
  const tSales = rows.reduce((s, r) => s + r.sales, 0);
  const tCost = rows.reduce((s, r) => s + r.cost, 0);
  const tGp = tSales - tCost;
  const tOrders = rows.reduce((s, r) => s + r.orders, 0);
  const cols = showPnl ? 6 : 3;
  return (
    <div className={`bg-white border border-[#E8D5C4] rounded-xl overflow-hidden break-inside-avoid ${showPnl ? '' : 'max-w-xl'}`}>
      <div className="px-4 py-2 bg-[#F5EDE2] text-center text-[11px] font-bold tracking-wide text-[#6B5744] uppercase">{showPnl ? 'P&L by Floor — Sales, Cost & Gross Profit' : 'Sales by Floor'}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="text-[10px] uppercase text-[#8B7355] border-b border-[#F0E6D8]">
            <tr>
              <th className="text-left px-4 py-2">Floor</th>
              <th className="text-right px-4 py-2">Sales</th>
              {showPnl && <th className="text-right px-4 py-2">Food Cost</th>}
              {showPnl && <th className="text-right px-4 py-2">Gross Profit</th>}
              {showPnl && <th className="text-right px-4 py-2">GP %</th>}
              <th className="text-right px-4 py-2">Orders</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F0E6D8]">
            {rows.length === 0 && <tr><td colSpan={cols} className="text-center text-[#8B7355] py-6">No sales in this range.</td></tr>}
            {rows.map((r) => (
              <tr key={r.floor}>
                <td className="px-4 py-2 font-medium text-[#2D1B0E]">{r.floor}</td>
                <td className="px-4 py-2 text-right tabular-nums font-semibold text-[#af4408]">{money(r.sales)}</td>
                {showPnl && <td className="px-4 py-2 text-right tabular-nums text-[#8B7355]">{money(r.cost)}</td>}
                {showPnl && <td className="px-4 py-2 text-right tabular-nums font-semibold text-[#2D1B0E]">{money(r.grossProfit)}</td>}
                {showPnl && <td className={`px-4 py-2 text-right tabular-nums font-semibold ${gpColor(r.gpPct)}`}>{pctS(r.gpPct)}</td>}
                <td className="px-4 py-2 text-right tabular-nums text-[#8B7355]">{r.orders}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="bg-[#FAF4EC] font-bold text-[#2D1B0E] border-t border-[#E8D5C4]">
                <td className="px-4 py-2">Total</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(tSales)}</td>
                {showPnl && <td className="px-4 py-2 text-right tabular-nums">{money(tCost)}</td>}
                {showPnl && <td className="px-4 py-2 text-right tabular-nums">{money(tGp)}</td>}
                {showPnl && <td className={`px-4 py-2 text-right tabular-nums ${gpColor(tSales ? (tGp / tSales) * 100 : 0)}`}>{pctS(tSales ? (tGp / tSales) * 100 : 0)}</td>}
                <td className="px-4 py-2 text-right tabular-nums">{tOrders}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// Running (open) orders grouped by floor — from the open-orders list, client-side.
// Open orders aren't costed yet, so this is the running amount only (no P&L).
function RunningByFloorCard({ orders }: { orders: any[] }) {
  const map = new Map<string, { floor: string; amount: number; orders: number }>();
  for (const o of orders) {
    const f = String(o.zone || '').trim() || (o.table_number ? 'Unassigned' : 'Parcel/Other');
    const cur = map.get(f) || { floor: f, amount: 0, orders: 0 };
    cur.amount += Number(o.total) || 0; cur.orders += 1; map.set(f, cur);
  }
  const rows = [...map.values()].sort((a, b) => b.amount - a.amount);
  const tAmount = rows.reduce((s, r) => s + r.amount, 0);
  const tOrders = rows.reduce((s, r) => s + r.orders, 0);
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden max-w-xl">
      <div className="px-4 py-2 bg-[#F5EDE2] text-center text-[11px] font-bold tracking-wide text-[#6B5744] uppercase">Running Orders by Floor</div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="text-[10px] uppercase text-[#8B7355] border-b border-[#F0E6D8]">
            <tr>
              <th className="text-left px-4 py-2">Floor</th>
              <th className="text-right px-4 py-2">Running Amount</th>
              <th className="text-right px-4 py-2">Orders</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F0E6D8]">
            {rows.length === 0 && <tr><td colSpan={3} className="text-center text-[#8B7355] py-6">No running orders.</td></tr>}
            {rows.map((r) => (
              <tr key={r.floor}>
                <td className="px-4 py-2 font-medium text-[#2D1B0E]">{r.floor}</td>
                <td className="px-4 py-2 text-right tabular-nums font-semibold text-[#af4408]">{money(r.amount)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-[#8B7355]">{r.orders}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="bg-[#FAF4EC] font-bold text-[#2D1B0E] border-t border-[#E8D5C4]">
                <td className="px-4 py-2">Total</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(tAmount)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{tOrders}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
type Tab = 'daily' | 'running' | 'items';

export default function SalesDashboardPage() {
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [tab, setTab] = useState<Tab>('daily');
  const [pnlOn, setPnlOn] = useState(false);   // admin enables floor P&L detail (cost/GP/GP%) in Settings → Dashboard
  const [data, setData] = useState<Dash | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [running, setRunning] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);

  // Monotonic request id — only the latest load() may paint, so a slow wide-range
  // response can't overwrite a newer fast one (out-of-order race → wrong money).
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const myId = ++reqId.current;
    setLoading(true); setErr('');
    try {
      const r = await api(`/api/dine-in/sales-dashboard?from=${from}&to=${to}`);
      const j = await r.json();
      if (myId !== reqId.current) return;              // superseded → discard
      if (!r.ok) { setErr(j.error || 'Failed to load'); setData(null); }
      else setData(j);
    } catch (e: any) {
      if (myId === reqId.current) { setErr(e.message || 'Failed to load'); setData(null); }
    } finally {
      if (myId === reqId.current) setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  // Admin can enable floor P&L detail (food cost / gross profit / GP%) in Settings → Dashboard.
  useEffect(() => {
    fetch('/api/settings?key=floor_pnl_enabled').then(r => r.json()).then(d => setPnlOn(d?.value === '1')).catch(() => {});
  }, []);

  useEffect(() => {
    let ignore = false;
    if (tab === 'running') api('/api/dine-in/orders?status=open').then(r => r.json()).then(j => { if (!ignore) setRunning(j.items || []); }).catch(() => { if (!ignore) setRunning([]); });
    if (tab === 'items') api(`/api/dine-in/sales-dashboard/items?from=${from}&to=${to}`).then(r => r.json()).then(j => { if (!ignore) setItems(j.items || []); }).catch(() => { if (!ignore) setItems([]); });
    return () => { ignore = true; };
  }, [tab, from, to]);

  return (
    <div className="min-h-screen bg-[#FFF8F0]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap print:hidden">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[#af4408]/10 rounded-lg"><TrendingUp className="w-6 h-6 text-[#af4408]" /></div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Sales Dashboard</h1>
              <p className="text-sm text-[#8B7355]">Daily &amp; month-to-date sales, collections and performance.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
              className="bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm text-[#2D1B0E]" />
            <span className="text-[#8B7355]">→</span>
            <input type="date" value={to} min={from} max={todayISO()} onChange={(e) => setTo(e.target.value)}
              className="bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm text-[#2D1B0E]" />
            <button onClick={load} className="flex items-center gap-1.5 text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 px-3 py-2 rounded-lg text-sm font-medium">
              <RefreshCw className="w-4 h-4" /> Refresh
            </button>
            <button onClick={() => window.print()} className="flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white px-3 py-2 rounded-lg text-sm font-medium">
              <Printer className="w-4 h-4" /> Print
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1.5 print:hidden flex-wrap">
          {([['daily', 'Daily Dashboard', BarChart3], ['running', 'Running Orders', ListOrdered], ['items', 'Item-wise Sales', Utensils]] as const).map(([k, label, Icon]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full ${tab === k ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {err && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">{err}</div>}
        {loading && !data && <div className="flex items-center gap-2 text-[#8B7355] py-12 justify-center"><Loader2 className="w-5 h-5 animate-spin" /> Loading…</div>}
        {loading && data && <div className="flex items-center gap-1.5 text-xs text-[#8B7355] print:hidden"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Updating…</div>}

        {/* DAILY DASHBOARD */}
        {tab === 'daily' && data && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="space-y-4">
              <TotalsCard title="MTD Sales Breakup" t={data.mtd} />
              <TotalsCard title="Sales Break-up" t={data.day} />
              <Card title="Charges Break-up">
                <Row label="Service Charge" value={money(data.day.charges)} />
                <Row label="Total Charges" value={money(data.day.charges)} strong />
              </Card>
              <Card title="Tax Break-up">
                <Row label="GST" value={money(data.day.tax)} />
                <Row label="Total Tax" value={money(data.day.tax)} strong />
              </Card>
              <Card title="Cancel Break-up">
                <Row label="Item Cancel" value={money(data.cancelBreakup.itemCancel.amount)} count={data.cancelBreakup.itemCancel.count} />
                <Row label="Order Cancel" value={money(data.cancelBreakup.orderCancel.amount)} count={data.cancelBreakup.orderCancel.count} />
                <Row label="Total Cancel" value={money(data.cancelBreakup.itemCancel.amount + data.cancelBreakup.orderCancel.amount)} strong />
              </Card>
            </div>
            <div className="space-y-4">
              <BucketCard title="Collection Break-up by Business" rows={data.collectionByBusiness} totalLabel="Total Sales & Orders" />
              <BucketCard title="Break-up by Session" rows={data.bySession} totalLabel="Total Session & Count" />
              <ItemTypeCard title="MTD Sales Break-up by Item Type" rows={data.itemTypesMtd} total={data.itemTypesMtd.reduce((s, r) => s + r.amount, 0)} />
              <ItemTypeCard title="Sales Break-up by Item Type" rows={data.itemTypesDay} total={data.itemTypesDay.reduce((s, r) => s + r.amount, 0)} />
              <PerfCard title="MTD Performance Metrics" p={data.performanceMtd} />
              <PerfCard title="Performance Metrics" p={data.performanceDay} />
            </div>
            <div className="space-y-4">
              <BucketCard title="By Payment Category" rows={data.byPaymentCategory} totalLabel="Total Collection" />
              <Card title="By Payment Status">
                <Row label="Sales" value={money(data.byPaymentStatus.sales)} />
                <Row label="Refund Amount" value={money(data.byPaymentStatus.refund)} />
                <Row label="Cancelled Order (Unserviced)" value={money(data.byPaymentStatus.cancelled.amount)} count={data.byPaymentStatus.cancelled.count} />
              </Card>
            </div>
          </div>
        )}

        {/* Sales by Floor — completed sales, inside the Daily Dashboard */}
        {tab === 'daily' && data && <FloorSalesCard rows={data.floorPnl} showPnl={pnlOn} />}

        {/* RUNNING ORDERS */}
        {tab === 'running' && <RunningByFloorCard orders={running} />}
        {tab === 'running' && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#F5EDE2] text-[#6B5744] text-[11px] uppercase">
                  <tr>
                    <th className="text-left px-4 py-2">Order #</th><th className="text-left px-4 py-2">Table</th>
                    <th className="text-left px-4 py-2">Type</th><th className="text-left px-4 py-2">Captain</th>
                    <th className="text-right px-4 py-2">Items</th><th className="text-right px-4 py-2">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F0E6D8]">
                  {running.length === 0 && <tr><td colSpan={6} className="text-center text-[#8B7355] py-10">No running orders.</td></tr>}
                  {running.map((o) => (
                    <tr key={o.id}>
                      <td className="px-4 py-2 font-medium">#{o.order_number}</td>
                      <td className="px-4 py-2">{o.table_number ? `${o.zone ? o.zone + ' · ' : ''}${o.table_number}` : 'Parcel'}</td>
                      <td className="px-4 py-2 capitalize">{o.order_type}</td>
                      <td className="px-4 py-2">{o.server_name || '—'}</td>
                      <td className="px-4 py-2 text-right">{o.item_count}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{money(o.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ITEM-WISE SALES */}
        {tab === 'items' && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#F5EDE2] text-[#6B5744] text-[11px] uppercase">
                  <tr>
                    <th className="text-left px-4 py-2">Item</th><th className="text-left px-4 py-2">Type</th>
                    <th className="text-right px-4 py-2">Qty</th><th className="text-right px-4 py-2">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F0E6D8]">
                  {items.length === 0 && <tr><td colSpan={4} className="text-center text-[#8B7355] py-10">No item sales in this range.</td></tr>}
                  {items.map((it, i) => (
                    <tr key={i}>
                      <td className="px-4 py-2 font-medium">{it.name}</td>
                      <td className="px-4 py-2">{it.type}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{it.qty}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{money(it.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
