'use client';

/**
 * Party P&L — admin-only per-event profit & loss view.
 *
 *   Revenue     = Party Bookings sheet (col U) matched by party_unique_id
 *   Food Cost   = Σ party requisition items × material avg price (by event)
 *   Liquor Cost = Σ party_consumption × material avg price (snapshotted)
 *   Profit      = Revenue − (Food + Liquor)
 *
 * Liquor consumption is RECORDED on /party-pnl ("Party Liquor Consumption").
 * This page is read-only review for management.
 *
 * Access: admin only. Non-admin lands on a "no access" message.
 *
 * (This route previously hosted the "Party Items" / CSV upload screen.
 * That code now lives in git history if it needs to be restored.)
 */

import { useEffect, useState } from 'react';
import { TrendingUp, Loader2, RefreshCw, AlertTriangle, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');

interface PnLRow {
  party_unique_id?: string;
  fp_id?: string;
  event_name: string;
  event_date: string;
  guest_name?: string;
  pax?: number;
  revenue: number;
  food_cost: number;
  food_items: number;
  liquor_cost: number;
  liquor_items: number;
  total_cost: number;
  profit: number;
  margin_pct: number;
  has_revenue: boolean;
  has_liquor_recorded: boolean;
}

export default function PartyPnLAdminPage() {
  const [me, setMe] = useState<any>(null);
  const [rows, setRows] = useState<PnLRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'past' | 'all'>('past');

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null));
  }, []);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/party-events/pnl');
      const j = await r.json();
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setRows(j.pnl || []);
    } catch (e: any) {
      setError(e?.message || 'Failed');
    } finally {
      setLoading(false);
    }
  };
  const refresh = async () => {
    setRefreshing(true); setError(null);
    try {
      await api('/api/party-bookings', { method: 'POST' });
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { if (me?.role === 'admin') load(); /* eslint-disable-next-line */ }, [me?.role]);

  // Admin gate — non-admins see a notice instead of P&L numbers
  if (me && me.role !== 'admin') {
    return (
      <div className="p-6">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900 flex items-start gap-3">
          <ShieldAlert size={18} className="shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Party P&amp;L is admin-only</div>
            <div className="text-xs mt-1">
              Per-party profit & loss numbers (revenue, costs, margin) are restricted to admin users.
              Bar managers can record liquor consumption on{' '}
              <a href="/party-pnl" className="underline">Party Liquor Consumption</a>.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const visible = rows
    .filter(r => r.event_date && (filter === 'all' || new Date(r.event_date) < todayStart))
    .sort((a, b) => b.event_date.localeCompare(a.event_date));

  const totals = visible.reduce((acc, r) => ({
    rev:  acc.rev  + r.revenue,
    food: acc.food + r.food_cost,
    liq:  acc.liq  + r.liquor_cost,
    prof: acc.prof + r.profit,
  }), { rev: 0, food: 0, liq: 0, prof: 0 });

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <TrendingUp className="text-emerald-700" size={24} />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Party P&amp;L</h1>
          <p className="text-xs text-[#8B7355]">
            Per-party profit & loss · admin view. Revenue from Party Bookings sheet · Food cost from requisitions ·
            Liquor cost from <a href="/party-pnl" className="text-[#af4408] underline">Party Liquor Consumption</a>.
          </p>
        </div>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#E8D5C4] bg-emerald-50/40 flex items-center gap-3 flex-wrap">
          <TrendingUp size={16} className="text-emerald-700" />
          <div className="flex-1 min-w-0 text-[10px] text-[#8B7355]">
            Refresh after the Party Bookings sheet is updated.
          </div>
          <select value={filter} onChange={e => setFilter(e.target.value as any)}
                  className="text-xs px-2 py-1 border border-[#D4B896] rounded bg-white">
            <option value="past">Past events</option>
            <option value="all">All events</option>
          </select>
          <button onClick={refresh} disabled={refreshing}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-emerald-700 hover:bg-emerald-100 rounded disabled:opacity-50">
            {refreshing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="p-6 text-center text-sm text-[#8B7355]">
            <Loader2 className="animate-spin inline mr-1" size={14} /> Computing P&amp;L…
          </div>
        ) : error ? (
          <div className="p-4 bg-red-50 text-sm text-red-700"><AlertTriangle size={14} className="inline mr-1" />{error}</div>
        ) : visible.length === 0 ? (
          <div className="p-6 text-center text-sm text-[#8B7355]">No events to show P&amp;L for. Past events appear here automatically.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left  py-2 px-3 font-medium">Date</th>
                  <th className="text-left  py-2 px-3 font-medium">Event</th>
                  <th className="text-right py-2 px-3 font-medium">Pax</th>
                  <th className="text-right py-2 px-3 font-medium">Revenue</th>
                  <th className="text-right py-2 px-3 font-medium">Food Cost</th>
                  <th className="text-right py-2 px-3 font-medium">Liquor Cost</th>
                  <th className="text-right py-2 px-3 font-medium">Profit</th>
                  <th className="text-right py-2 px-3 font-medium">Margin</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => {
                  const marginTone =
                    !r.has_revenue ? 'text-[#8B7355]' :
                    r.margin_pct >= 30 ? 'text-emerald-700 font-semibold' :
                    r.margin_pct >= 10 ? 'text-amber-700' :
                    'text-red-700 font-semibold';
                  return (
                    <tr key={(r.party_unique_id || r.fp_id || r.event_name) + i}
                        className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                      <td className="py-1.5 px-3 font-mono whitespace-nowrap">{r.event_date}</td>
                      <td className="py-1.5 px-3">
                        <div className="font-medium text-[#2D1B0E]">{r.event_name}</div>
                        {r.fp_id && <div className="text-[9px] font-mono text-[#af4408]">{r.fp_id}</div>}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono">{r.pax || '—'}</td>
                      <td className="py-1.5 px-3 text-right font-mono">
                        {r.has_revenue ? fmt(r.revenue) : <span className="text-amber-700 text-[10px]">no booking row</span>}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono">
                        {r.food_cost > 0 ? fmt(r.food_cost) : <span className="text-[#8B7355]">—</span>}
                        {r.food_items > 0 && <span className="text-[9px] text-[#8B7355] ml-1">({r.food_items})</span>}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono">
                        {r.liquor_cost > 0
                          ? <>{fmt(r.liquor_cost)} <span className="text-[9px] text-[#8B7355]">({r.liquor_items})</span></>
                          : <span className="text-amber-700 text-[10px]">not recorded</span>}
                      </td>
                      <td className={`py-1.5 px-3 text-right font-mono ${r.profit >= 0 ? 'text-emerald-700' : 'text-red-700'} font-semibold`}>
                        {r.has_revenue ? fmt(r.profit) : '—'}
                      </td>
                      <td className={`py-1.5 px-3 text-right font-mono ${marginTone}`}>
                        {r.has_revenue ? `${r.margin_pct.toFixed(1)}%` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-[#FFF1E3] border-t border-[#E8D5C4]">
                <tr className="font-semibold">
                  <td className="py-2 px-3 text-[#2D1B0E]" colSpan={3}>Totals ({visible.length} events)</td>
                  <td className="py-2 px-3 text-right font-mono text-[#2D1B0E]">{fmt(totals.rev)}</td>
                  <td className="py-2 px-3 text-right font-mono text-[#2D1B0E]">{fmt(totals.food)}</td>
                  <td className="py-2 px-3 text-right font-mono text-[#2D1B0E]">{fmt(totals.liq)}</td>
                  <td className={`py-2 px-3 text-right font-mono ${totals.prof >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>{fmt(totals.prof)}</td>
                  <td className="py-2 px-3 text-right font-mono">
                    {totals.rev > 0 ? `${((totals.prof / totals.rev) * 100).toFixed(1)}%` : '—'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
