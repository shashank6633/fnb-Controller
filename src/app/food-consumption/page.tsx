'use client';

/**
 * Food Consumption — per-party FOOD cost from approved party requisitions.
 *
 * Read-only counterpart to the Party Liquor Consumption page. Food items are
 * NOT recorded here — they come from the Party Approvals workflow (chef-approved
 * party requisitions). This page surfaces, per event: how many food items are
 * recorded and their total cost (avg purchase price × requested qty), with a
 * "View items" action that lists the requested items.
 */

import { useEffect, useState } from 'react';
import { Utensils, Loader2, RefreshCw, AlertTriangle, Eye, X } from 'lucide-react';
import { api } from '@/lib/api';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');

interface PnLRow {
  party_unique_id?: string;
  fp_id?: string;
  event_name: string;
  event_date: string;
  pax?: number;
  food_cost: number;
  food_items: number;
}

export default function FoodConsumptionPage() {
  const [rows, setRows] = useState<PnLRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'past' | 'all'>('past');
  const [viewFor, setViewFor] = useState<PnLRow | null>(null);

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

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const visible = rows
    .filter(r => r.event_date && (filter === 'all' || new Date(r.event_date) < todayStart))
    .sort((a, b) => b.event_date.localeCompare(a.event_date));

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <Utensils className="text-[#af4408]" size={24} />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Food Consumption</h1>
          <p className="text-xs text-[#8B7355]">
            Food cost per party from HOD-approved party requisitions (Party Approvals).
            Cost auto-pulls from each material&apos;s average purchase price.
          </p>
        </div>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#E8D5C4] bg-amber-50/40 flex items-center gap-3 flex-wrap">
          <Utensils size={16} className="text-amber-700" />
          <div className="flex-1 min-w-0 text-[10px] text-[#8B7355]">
            Showing {filter === 'past' ? 'past' : 'all'} events from the AKAN Party Manager sheet.
            Food items come from HOD-approved party requisitions.
          </div>
          <select value={filter} onChange={e => setFilter(e.target.value as any)}
                  className="text-xs px-2 py-1 border border-[#D4B896] rounded bg-white">
            <option value="past">Past events</option>
            <option value="all">All events</option>
          </select>
          <button onClick={refresh} disabled={refreshing}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100 rounded disabled:opacity-50">
            {refreshing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="p-6 text-center text-sm text-[#8B7355]">
            <Loader2 className="animate-spin inline mr-1" size={14} /> Loading events…
          </div>
        ) : error ? (
          <div className="p-4 bg-red-50 text-sm text-red-700"><AlertTriangle size={14} className="inline mr-1" />{error}</div>
        ) : visible.length === 0 ? (
          <div className="p-6 text-center text-sm text-[#8B7355]">No events to show. Past events appear here automatically.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left  py-2 px-3 font-medium">Date</th>
                  <th className="text-left  py-2 px-3 font-medium">Event</th>
                  <th className="text-right py-2 px-3 font-medium">Pax</th>
                  <th className="text-left  py-2 px-3 font-medium">Food recorded</th>
                  <th className="text-right py-2 px-3 font-medium">Food cost</th>
                  <th className="text-right py-2 px-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => {
                  const hasFood = (r.food_items || 0) > 0;
                  return (
                    <tr key={(r.party_unique_id || r.fp_id || r.event_name) + i}
                        className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                      <td className="py-1.5 px-3 font-mono whitespace-nowrap">{r.event_date}</td>
                      <td className="py-1.5 px-3">
                        <div className="font-medium text-[#2D1B0E]">{r.event_name}</div>
                        {r.fp_id && <div className="text-[9px] font-mono text-[#af4408]">{r.fp_id}</div>}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono">{r.pax || '—'}</td>
                      <td className="py-1.5 px-3">
                        {hasFood
                          ? <button onClick={() => setViewFor(r)} title="View requested items"
                                    className="inline-flex items-center gap-1 text-emerald-700 hover:underline">
                              ✓ {r.food_items} item{r.food_items === 1 ? '' : 's'} recorded
                            </button>
                          : <span className="text-amber-700 text-[10px]">not recorded yet</span>}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">
                        {hasFood
                          ? <span className="font-semibold text-[#2D1B0E]">{fmt(r.food_cost)}</span>
                          : <span className="text-[#8B7355]">—</span>}
                      </td>
                      <td className="py-1.5 px-3 text-right">
                        <button onClick={() => setViewFor(r)} disabled={!hasFood}
                                className="inline-flex items-center gap-1 text-xs text-white bg-[#af4408] hover:bg-[#933807] px-2.5 py-1 rounded whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed">
                          <Eye size={11} /> View items
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF1E3] font-semibold text-[#2D1B0E]">
                  <td className="py-2 px-3" colSpan={4}>
                    Overall food cost — {visible.filter(r => (r.food_items || 0) > 0).length} of {visible.length} parties recorded
                  </td>
                  <td className="py-2 px-3 text-right font-mono whitespace-nowrap">
                    {fmt(visible.reduce((a, r) => a + (r.food_cost || 0), 0))}
                  </td>
                  <td className="py-2 px-3"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {viewFor && <FoodItemsModal target={viewFor} onClose={() => setViewFor(null)} />}
    </div>
  );
}

interface FoodItem {
  id: string;
  material_name: string;
  material_unit: string;
  qty: number;
  qty_issued: number;
  avg_price: number;
  cost: number;
  req_status: string;
}

function FoodItemsModal({ target, onClose }: { target: PnLRow; onClose: () => void }) {
  const [items, setItems] = useState<FoodItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const qs = `event_name=${encodeURIComponent(target.event_name)}&event_date=${encodeURIComponent(target.event_date)}`;
    fetch(`/api/party-events/food-items?${qs}`)
      .then(r => r.json())
      .then(d => { if (d.error) setError(d.error); else setItems(d.items || []); })
      .catch(e => setError(e?.message || 'Failed'))
      .finally(() => setLoading(false));
  }, [target]);

  const total = items.reduce((a, it) => a + (it.cost || 0), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto"
         onClick={onClose}>
      <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-3xl my-4 flex flex-col max-h-[calc(100vh-2rem)]"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-[#2D1B0E]">Food Items Requested</h2>
            <div className="text-xs text-[#8B7355] mt-0.5">
              {target.event_name} · {target.event_date} {target.fp_id && <span className="font-mono text-[#af4408]">· {target.fp_id}</span>}
            </div>
          </div>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={20} /></button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1">
          {loading ? (
            <div className="text-sm text-[#8B7355] py-4 text-center"><Loader2 size={14} className="inline animate-spin mr-1" /> Loading items…</div>
          ) : error ? (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs">{error}</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-[#8B7355] py-4 text-center">No food items found for this event.</div>
          ) : (
            <div className="border border-[#E8D5C4] rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-[#FFF1E3] text-[#6B5744]">
                  <tr>
                    <th className="text-left py-1.5 px-2 font-medium">Item</th>
                    <th className="text-right py-1.5 px-2 font-medium">Requested</th>
                    <th className="text-right py-1.5 px-2 font-medium">Issued</th>
                    <th className="text-right py-1.5 px-2 font-medium">Cost</th>
                    <th className="text-left py-1.5 px-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(it => (
                    <tr key={it.id} className="border-t border-[#E8D5C4]/50">
                      <td className="py-1.5 px-2 text-[#2D1B0E]">{it.material_name}</td>
                      <td className="py-1.5 px-2 text-right font-mono whitespace-nowrap">{it.qty} {it.material_unit}</td>
                      <td className="py-1.5 px-2 text-right font-mono whitespace-nowrap">{it.qty_issued || 0} {it.material_unit}</td>
                      <td className="py-1.5 px-2 text-right font-mono">{fmt(it.cost)}</td>
                      <td className="py-1.5 px-2 text-[10px] text-[#8B7355] whitespace-nowrap">{(it.req_status || '').replace(/_/g, ' ')}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-[#D4B896] bg-[#FFF1E3]/60">
                    <td className="py-2 px-2 font-semibold text-[#2D1B0E]" colSpan={3}>Total food cost</td>
                    <td className="py-2 px-2 text-right font-bold text-[#2D1B0E]">{fmt(total)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        <div className="flex justify-end px-6 py-3 border-t border-[#E8D5C4] shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B5744] hover:bg-[#FFF1E3] rounded">Close</button>
        </div>
      </div>
    </div>
  );
}
