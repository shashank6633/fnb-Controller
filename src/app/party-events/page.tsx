'use client';

/**
 * Party Events — per-event P&L. Each event aggregates one or more party
 * requisitions (cost) against the day's party-tagged sales (revenue).
 * Click an event row to drill into the full breakdown.
 */

import { Fragment, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  PartyPopper, Loader2, ChevronLeft, Users as UsersIcon, Calendar,
  TrendingUp, TrendingDown, Plus, Link2, X, RefreshCw, ExternalLink, CheckCircle2,
  AlertTriangle, ChevronDown, ChevronRight,
} from 'lucide-react';
import { api } from '@/lib/api';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');

interface Event {
  event_name: string; event_date: string;
  guest_count?: number; customer?: string; req_count: number;
  cost: number; revenue: number; profit: number;
  food_cost_percent: number; per_head_cost: number; per_head_revenue: number;
}
interface EventDetail {
  event_name: string; event_date: string; guest_count: number;
  customer: string; notes: string;
  requisitions: { id: string; req_number: string; status: string; department: string }[];
  items: { req_number: string; material: string; sku?: string; unit?: string;
           quantity: number; unit_price: number; line_cost: number }[];
  sales: { id?: string; item_name: string; qty: number; revenue: number; category: string; link_type?: 'auto' | 'manual' }[];
  summary: {
    cost: number; revenue: number; profit: number; food_cost_percent: number;
    per_head_cost: number; per_head_revenue: number; per_head_profit: number;
  };
}

export default function PartyEventsPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<Event | null>(null);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [unlinkedSales, setUnlinkedSales] = useState<{ id: string; item_name: string; qty: number; revenue: number; bill_type: string; date: string; category: string }[] | null>(null);
  const [unlinkedErr, setUnlinkedErr] = useState<string | null>(null);
  const [unlinkedLoading, setUnlinkedLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [linkSubmitting, setLinkSubmitting] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/party-events').then(r => r.json()).then(d => {
      setEvents(d.events || []); setLoading(false);
    });
  }, []);

  const openEvent = async (e: Event) => {
    setActive(e); setDetail(null); setDetailLoading(true);
    const qs = new URLSearchParams({ event: e.event_name, date: e.event_date });
    const d = await fetch(`/api/party-events?${qs}`).then(r => r.json());
    setDetail(d); setDetailLoading(false);
  };

  const reloadDetail = async () => {
    if (!active) return;
    const qs = new URLSearchParams({ event: active.event_name, date: active.event_date });
    const d = await fetch(`/api/party-events?${qs}`).then(r => r.json());
    setDetail(d);
  };

  const openLinkModal = async () => {
    if (!active) return;
    setLinkModalOpen(true);
    setUnlinkedSales(null); setUnlinkedErr(null); setSelectedIds(new Set());
    setUnlinkedLoading(true);
    try {
      const res = await fetch(`/api/party-events/unlinked-sales?date=${encodeURIComponent(active.event_date)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setUnlinkedSales(data.sales || []);
    } catch {
      setUnlinkedErr('This feature is coming online — manual sale linking is not yet available.');
    } finally {
      setUnlinkedLoading(false);
    }
  };

  const closeLinkModal = () => {
    setLinkModalOpen(false); setUnlinkedSales(null); setSelectedIds(new Set()); setUnlinkedErr(null);
  };

  const toggleSel = (id: string) => {
    setSelectedIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const submitLink = async () => {
    if (!active || selectedIds.size === 0) return;
    setLinkSubmitting(true);
    try {
      const res = await api('/api/party-events/link-sales', {
        method: 'POST',
        body: {
          event_name: active.event_name,
          event_date: active.event_date,
          sale_ids: Array.from(selectedIds),
          action: 'link',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      closeLinkModal();
      await reloadDetail();
    } catch {
      setUnlinkedErr('Could not link sales — endpoint not reachable. Try again later.');
    } finally {
      setLinkSubmitting(false);
    }
  };

  const unlinkSale = async (saleId: string) => {
    if (!active) return;
    setRowBusyId(saleId);
    try {
      const res = await api('/api/party-events/link-sales', {
        method: 'POST',
        body: {
          event_name: active.event_name,
          event_date: active.event_date,
          sale_ids: [saleId],
          action: 'unlink',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await reloadDetail();
    } catch {
      // silent — show inline state cleared
    } finally {
      setRowBusyId(null);
    }
  };

  // Detail view
  if (active) {
    return (
      <div className="p-6 space-y-4">
        <button onClick={() => { setActive(null); setDetail(null); }}
                className="text-[#6B5744] hover:text-[#af4408] flex items-center gap-1 text-sm">
          <ChevronLeft size={16} /> Back to events
        </button>

        {detailLoading || !detail ? (
          <div className="text-center text-sm text-[#8B7355] p-10">
            <Loader2 className="animate-spin inline mr-1" size={14} /> Loading event detail…
          </div>
        ) : (
          <>
            {/* Event header */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-5">
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <PartyPopper className="text-[#af4408]" size={22} />
                    <h1 className="text-xl font-bold text-[#2D1B0E]">{detail.event_name}</h1>
                  </div>
                  <div className="text-xs text-[#8B7355] mt-2 flex flex-wrap gap-3">
                    <span><Calendar size={11} className="inline mr-1" /> {detail.event_date}</span>
                    {detail.guest_count > 0 && <span><UsersIcon size={11} className="inline mr-1" /> {detail.guest_count} guests</span>}
                    {detail.customer && <span>· {detail.customer}</span>}
                    <span>· {detail.requisitions.length} requisition{detail.requisitions.length === 1 ? '' : 's'}</span>
                  </div>
                  {detail.notes && <div className="text-xs text-[#6B5744] mt-2 italic">{detail.notes}</div>}
                </div>
              </div>
            </div>

            {/* P&L summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card label="Cost"        value={fmt(detail.summary.cost)}    sub={detail.guest_count > 0 ? `${fmt(detail.summary.per_head_cost)}/head` : undefined} tone="red" />
              <Card label="Revenue"     value={fmt(detail.summary.revenue)} sub={detail.guest_count > 0 ? `${fmt(detail.summary.per_head_revenue)}/head` : undefined} tone="green" />
              <Card label="Profit"      value={fmt(detail.summary.profit)}  sub={detail.guest_count > 0 ? `${fmt(detail.summary.per_head_profit)}/head` : undefined}
                    tone={detail.summary.profit >= 0 ? 'green' : 'red'} />
              <Card label="Food Cost %" value={`${detail.summary.food_cost_percent}%`}
                    sub={detail.summary.food_cost_percent > 35 ? '⚠ above 35% target' : 'within target'}
                    tone={detail.summary.food_cost_percent > 35 ? 'amber' : 'green'} />
            </div>

            {/* Cost breakdown */}
            <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex items-center gap-2">
                <TrendingDown size={14} className="text-red-600" />
                <h2 className="text-sm font-semibold text-[#2D1B0E]">Cost — items issued ({detail.items.length})</h2>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-[#FFF8F0] text-[#8B7355]">
                  <tr>
                    <th className="text-left  py-2 px-3 font-medium">Req #</th>
                    <th className="text-left  py-2 px-3 font-medium">Material</th>
                    <th className="text-right py-2 px-3 font-medium">Qty</th>
                    <th className="text-right py-2 px-3 font-medium">Unit Price</th>
                    <th className="text-right py-2 px-3 font-medium">Line Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((it, i) => (
                    <tr key={i} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                      <td className="py-1.5 px-3 font-mono text-[#af4408] text-[10px]">{it.req_number}</td>
                      <td className="py-1.5 px-3">
                        <div className="font-medium text-[#2D1B0E]">{it.material}</div>
                        {it.sku && <div className="text-[9px] font-mono text-[#8B7355]">{it.sku}</div>}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono">{it.quantity} {it.unit}</td>
                      <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]">{fmt(it.unit_price)}/{it.unit}</td>
                      <td className="py-1.5 px-3 text-right font-mono font-semibold">{fmt(it.line_cost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-[#FFF1E3] font-semibold">
                    <td colSpan={4} className="py-1.5 px-3 text-right text-[#2D1B0E]">Total cost</td>
                    <td className="py-1.5 px-3 text-right font-mono text-[#2D1B0E]">{fmt(detail.summary.cost)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Revenue breakdown */}
            {(() => {
              const autoCount = detail.sales.filter(s => s.link_type !== 'manual').length;
              const manCount = detail.sales.filter(s => s.link_type === 'manual').length;
              return (
            <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex items-center gap-2 flex-wrap">
                <TrendingUp size={14} className="text-green-600" />
                <h2 className="text-sm font-semibold text-[#2D1B0E]">
                  Revenue — party sales on {detail.event_date} ({detail.sales.length})
                </h2>
                <span className="text-[10px] text-[#6B5744] ml-2">
                  {autoCount} auto-linked + {manCount} manually-linked = {detail.sales.length} total
                </span>
                <div className="ml-auto">
                  <button onClick={openLinkModal}
                          className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#af4408] hover:bg-[#933807] text-white rounded text-[11px]">
                    <Link2 size={11} /> Attribute sales from this date
                  </button>
                </div>
              </div>
              {detail.sales.length === 0 ? (
                <div className="p-6 text-sm text-[#8B7355] text-center">
                  No party-tagged sales recorded for {detail.event_date}.
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-[#FFF8F0] text-[#8B7355]">
                    <tr>
                      <th className="text-left  py-2 px-3 font-medium">Item</th>
                      <th className="text-left  py-2 px-3 font-medium">Category</th>
                      <th className="text-right py-2 px-3 font-medium">Qty</th>
                      <th className="text-right py-2 px-3 font-medium">Revenue</th>
                      <th className="text-right py-2 px-3 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.sales.map((s, i) => {
                      const isManual = s.link_type === 'manual';
                      const badge = isManual
                        ? <span className="ml-2 inline-block px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 text-[9px] font-medium">Manually linked</span>
                        : s.link_type === 'auto'
                          ? <span className="ml-2 inline-block px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[9px] font-medium">Auto by date</span>
                          : null;
                      return (
                      <tr key={s.id ?? i} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                        <td className="py-1.5 px-3 font-medium text-[#2D1B0E]">
                          {s.item_name}{badge}
                        </td>
                        <td className="py-1.5 px-3 text-[10px] text-[#8B7355]">{s.category}</td>
                        <td className="py-1.5 px-3 text-right font-mono">{s.qty}</td>
                        <td className="py-1.5 px-3 text-right font-mono font-semibold text-green-700">{fmt(s.revenue)}</td>
                        <td className="py-1.5 px-3 text-right">
                          {isManual && s.id && (
                            <button onClick={() => unlinkSale(s.id!)}
                                    disabled={rowBusyId === s.id}
                                    className="text-[10px] text-[#af4408] hover:underline disabled:opacity-50 inline-flex items-center gap-0.5">
                              {rowBusyId === s.id
                                ? <Loader2 size={10} className="animate-spin" />
                                : <X size={10} />}
                              Unlink
                            </button>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-[#FFF1E3] font-semibold">
                      <td colSpan={3} className="py-1.5 px-3 text-right text-[#2D1B0E]">Total revenue</td>
                      <td className="py-1.5 px-3 text-right font-mono text-[#2D1B0E]">{fmt(detail.summary.revenue)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
              );
            })()}
          </>
        )}

        {/* Link sales modal */}
        {linkModalOpen && active && (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
               onClick={closeLinkModal}>
            <div onClick={(e) => e.stopPropagation()}
                 className="bg-white rounded-xl border border-[#E8D5C4] max-w-2xl w-full max-h-[80vh] flex flex-col">
              <div className="px-5 py-3 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-[#2D1B0E]">Attribute sales to {active.event_name}</h3>
                  <p className="text-[10px] text-[#8B7355] mt-0.5">Party-tagged sales on {active.event_date} not yet linked to any event.</p>
                </div>
                <button onClick={closeLinkModal} className="text-[#6B5744] hover:text-[#af4408]"><X size={16} /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {unlinkedLoading ? (
                  <div className="text-center text-sm text-[#8B7355] py-8">
                    <Loader2 size={14} className="animate-spin inline mr-1" /> Loading available sales…
                  </div>
                ) : unlinkedErr ? (
                  <div className="text-center text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-4">
                    {unlinkedErr}
                  </div>
                ) : !unlinkedSales || unlinkedSales.length === 0 ? (
                  <div className="text-center text-sm text-[#8B7355] py-8">
                    No unattributed party sales on this date — everything is already linked.
                  </div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-[#FFF8F0] text-[#8B7355]">
                      <tr>
                        <th className="py-2 px-2 w-8"></th>
                        <th className="text-left  py-2 px-2 font-medium">Item</th>
                        <th className="text-left  py-2 px-2 font-medium">Bill type</th>
                        <th className="text-right py-2 px-2 font-medium">Qty</th>
                        <th className="text-right py-2 px-2 font-medium">Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unlinkedSales.map(s => (
                        <tr key={s.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0] cursor-pointer"
                            onClick={() => toggleSel(s.id)}>
                          <td className="py-1.5 px-2">
                            <input type="checkbox" checked={selectedIds.has(s.id)}
                                   onChange={() => toggleSel(s.id)} onClick={(e) => e.stopPropagation()} />
                          </td>
                          <td className="py-1.5 px-2 font-medium text-[#2D1B0E]">{s.item_name}
                            <div className="text-[9px] text-[#8B7355]">{s.category}</div>
                          </td>
                          <td className="py-1.5 px-2 text-[10px] text-[#6B5744]">{s.bill_type}</td>
                          <td className="py-1.5 px-2 text-right font-mono">{s.qty}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-green-700">{fmt(s.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] bg-[#FFF8F0] flex items-center justify-end gap-2">
                <span className="text-[10px] text-[#6B5744] mr-auto">{selectedIds.size} selected</span>
                <button onClick={closeLinkModal}
                        className="px-3 py-1.5 text-xs border border-[#E8D5C4] rounded hover:bg-white">
                  Cancel
                </button>
                <button onClick={submitLink}
                        disabled={selectedIds.size === 0 || linkSubmitting || !!unlinkedErr}
                        className="px-3 py-1.5 text-xs bg-[#af4408] hover:bg-[#933807] disabled:opacity-50 text-white rounded inline-flex items-center gap-1">
                  {linkSubmitting && <Loader2 size={12} className="animate-spin" />}
                  Link selected to this event
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // List view
  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <PartyPopper className="text-[#af4408]" size={24} />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Party Events</h1>
          <p className="text-xs text-[#8B7355]">
            One row per banquet/party event. Cost from <a href="/party-requisitions" className="underline text-[#af4408]">party requisitions</a>;
            revenue from sales tagged Party on the event date.
          </p>
        </div>
        {/* Manual "New Party Requisition" button removed — parties come from the
            AKAN Party Manager Google sheet. Use the per-row "Raise Req" button
            below to raise a requisition against a specific upcoming party. */}
      </div>

      {/* Upcoming Parties — pulled live from AKAN Party Manager Google Sheet */}
      <UpcomingPartiesPanel />

      {/* Status change audit — last 7 days of FP status flips */}
      <StatusChangesPanel />

      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14} /> Loading…</div>
        ) : events.length === 0 ? (
          <div className="p-10 text-center text-sm text-[#8B7355]">
            No party events yet. <a href="/party-requisitions" className="text-[#af4408] underline">Raise the first party requisition</a> to start tracking events.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-[#FFF1E3] text-[#6B5744]">
              <tr>
                <th className="text-left  py-2 px-3 font-medium">Date</th>
                <th className="text-left  py-2 px-3 font-medium">Event</th>
                <th className="text-left  py-2 px-3 font-medium">Customer</th>
                <th className="text-right py-2 px-3 font-medium">Guests</th>
                <th className="text-right py-2 px-3 font-medium">Reqs</th>
                <th className="text-right py-2 px-3 font-medium">Cost</th>
                <th className="text-right py-2 px-3 font-medium">Revenue</th>
                <th className="text-right py-2 px-3 font-medium">Profit</th>
                <th className="text-right py-2 px-3 font-medium">FC%</th>
                <th className="text-right py-2 px-3 font-medium">/head</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => {
                const fcTone = e.food_cost_percent > 50 ? 'text-red-700' : e.food_cost_percent > 35 ? 'text-amber-700' : 'text-emerald-700';
                const profitTone = e.profit < 0 ? 'text-red-700' : e.profit < e.cost * 0.5 ? 'text-amber-700' : 'text-emerald-700';
                return (
                  <tr key={i} onClick={() => openEvent(e)}
                      className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0] cursor-pointer">
                    <td className="py-1.5 px-3 text-[#6B5744] whitespace-nowrap">{e.event_date}</td>
                    <td className="py-1.5 px-3 font-medium text-[#2D1B0E]">{e.event_name}</td>
                    <td className="py-1.5 px-3 text-[#6B5744]">{e.customer || '—'}</td>
                    <td className="py-1.5 px-3 text-right font-mono">{e.guest_count || '—'}</td>
                    <td className="py-1.5 px-3 text-right font-mono text-[#8B7355]">{e.req_count}</td>
                    <td className="py-1.5 px-3 text-right font-mono">{fmt(e.cost)}</td>
                    <td className="py-1.5 px-3 text-right font-mono text-green-700">{fmt(e.revenue)}</td>
                    <td className={`py-1.5 px-3 text-right font-mono font-semibold ${profitTone}`}>{fmt(e.profit)}</td>
                    <td className={`py-1.5 px-3 text-right font-mono font-semibold ${fcTone}`}>
                      {e.revenue > 0 ? `${e.food_cost_percent.toFixed(1)}%` : '—'}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]">
                      {(e.guest_count ?? 0) > 0 ? fmt(e.per_head_revenue - e.per_head_cost) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Card({ label, value, sub, tone }: {
  label: string; value: string; sub?: string;
  tone: 'green' | 'red' | 'amber' | 'gray';
}) {
  const toneClass = {
    green: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    red:   'border-red-200 bg-red-50 text-red-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    gray:  'border-[#E8D5C4] bg-white text-[#2D1B0E]',
  }[tone];
  return (
    <div className={`border rounded-xl p-4 ${toneClass}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {sub && <div className="text-[10px] mt-1 opacity-80">{sub}</div>}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   UPCOMING PARTIES PANEL — reads from AKAN Party Manager Google Sheet
   Shows next ~30 days of events with one-click "Raise Req" pre-fill.
   ════════════════════════════════════════════════════════════════════ */

interface UpcomingParty {
  fp_id: string;
  party_unique_id?: string;
  status?: string;
  date_of_event: string;
  day_of_event?: string;
  time_of_event?: string;
  allocated_area?: string;
  guest_name?: string;
  contact_person?: string;
  phone?: string;
  company?: string;
  package_type?: string;
  rate_per_head?: number;
  min_guarantee?: number;
  pax_expected?: number;
  approx_bill?: number;
  veg_starters?: string;
  nonveg_starters?: string;
  veg_mains?: string;
  nonveg_mains?: string;
  rice?: string;
  dal?: string;
  salad?: string;
  desserts?: string;
  accompaniments?: string;
  bar_notes?: string;
  drinks_start_time?: string;
  drinks_end_time?: string;
  linked: boolean;
  linked_req_count: number;
}

function UpcomingPartiesPanel() {
  const router = useRouter();
  const [parties, setParties] = useState<UpcomingParty[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Auth diagnostics from the API — which Google service account the server
  // tried to use. Drives an accurate "share the sheet with THIS email" hint
  // (the account differs between GCP metadata SA and AWS JSON-key SA).
  const [authDiag, setAuthDiag] = useState<{ mode?: string; service_account_email?: string | null; key_file_path?: string | null } | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string>('');
  // Role check — admins bypass the approval gate (covers "just approved but
  // cache hasn't refreshed yet" + vendor emergencies). Also captures the
  // user's page_access map so we can pre-check whether they can even open
  // /party-requisitions before showing the CTA (otherwise the proxy
  // redirects them back here with ?forbidden=, which looks like a reload).
  const [isAdmin, setIsAdmin] = useState(false);
  const [canRaiseReq, setCanRaiseReq] = useState(true);   // assume yes until proven otherwise
  // Global flag — when admin turns this off on /settings/integrations, the
  // approval gate is bypassed for everyone (every party shows + Raise Req).
  const [requireApproval, setRequireApproval] = useState(true);
  // Admin-controlled gate: when true, non-admins can raise requisitions for
  // past-day parties too (intended for next-day emergency top-ups).
  const [allowPastDay, setAllowPastDay] = useState(false);
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => {
      const u = d?.user;
      setIsAdmin(u?.role === 'admin');
      // Page access pre-check. NULL access → full access (default).
      // Admin always has full access. Otherwise the map must include /party-requisitions.
      if (u?.role === 'admin' || u?.page_access == null) {
        setCanRaiseReq(true);
      } else {
        try {
          const arr = JSON.parse(u.page_access);
          setCanRaiseReq(Array.isArray(arr) && arr.includes('/party-requisitions'));
        } catch { setCanRaiseReq(true); }
      }
    }).catch(() => {});
    fetch('/api/admin/party-rules').then(r => r.json()).then(d => {
      setRequireApproval(d?.require_fp_approval_for_req !== false);
      setAllowPastDay(d?.allow_past_day_party_req === true);
    }).catch(() => {});
  }, []);

  // Detect proxy ?forbidden= redirect so user sees a clear actionable banner
  // instead of mysteriously "ending up back here".
  const [forbiddenPath, setForbiddenPath] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const fp = new URLSearchParams(window.location.search).get('forbidden');
    if (fp) {
      setForbiddenPath(fp);
      // Clear from URL so a refresh doesn't re-show stale banner
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);
  const [source, setSource] = useState<'live' | 'cache'>('cache');
  const [showPast, setShowPast] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const load = async (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    setError(null); setWarning(null);
    try {
      const r = await fetch(force ? '/api/upcoming-parties' : '/api/upcoming-parties?stale=1', {
        method: force ? 'GET' : 'GET',
      });
      const j = await r.json();
      if (j.auth) setAuthDiag(j.auth);           // capture even on success (warning path)
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setParties(j.parties || []);
      setFetchedAt(j.fetched_at || '');
      setSource(j.source || 'cache');
      if (j.warning) setWarning(j.warning);
      // If cache was empty, force a live fetch
      if (!force && (!j.parties || j.parties.length === 0) && j.source === 'cache') {
        load(true);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load');
    } finally {
      setLoading(false); setRefreshing(false);
    }
  };
  useEffect(() => { load(false); /* eslint-disable-next-line */ }, []);

  // Auto-poll cached cache every 60s so kitchen / bar see newly-approved
  // events without clicking Refresh. Uses ?stale=1 (no live sheet hit per
  // poll — the in-process scheduler handles live fetches every 15 min).
  useEffect(() => {
    const id = setInterval(() => { load(false); }, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Today (start of day) — for filtering past vs upcoming
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const visible = parties
    .filter(p => {
      if (!p.date_of_event) return false;
      const d = new Date(p.date_of_event);
      return showPast ? true : d >= todayStart;
    })
    .sort((a, b) => a.date_of_event.localeCompare(b.date_of_event));

  return (
    <Fragment>
    {forbiddenPath && (
      <div className="bg-blue-50 border border-blue-200 text-blue-900 rounded-xl p-3 mb-3 flex items-start gap-3">
        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        <div className="flex-1 text-xs">
          <div className="font-semibold">Access blocked: <code className="bg-white px-1 rounded text-[10px]">{forbiddenPath}</code></div>
          <div className="mt-0.5">
            Your user role doesn't have access to that page. Ask an admin to grant it on{' '}
            <a href="/users" className="underline">/users</a> (edit your profile → Page Access section) or{' '}
            <a href="/settings/page-access" className="underline">/settings/page-access</a>.
          </div>
        </div>
        <button onClick={() => setForbiddenPath(null)} className="text-blue-900 hover:text-blue-700"><X size={14} /></button>
      </div>
    )}
    <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[#E8D5C4] bg-blue-50/40 flex items-center gap-3 flex-wrap">
        <ExternalLink size={16} className="text-blue-700" />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-[#2D1B0E]">Upcoming Parties — from AKAN Party Manager</h2>
          <div className="text-[10px] text-[#8B7355] mt-0.5 flex gap-2 flex-wrap items-center">
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" title="Auto-polling every 60s" />
              live
            </span>
            {fetchedAt && <span>· synced {timeAgo(fetchedAt)} · {source}</span>}
            {warning && <span className="text-amber-700">⚠ {warning}</span>}
            {!requireApproval && (
              <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800"
                    title="Admin has disabled the FP-approval requirement on /settings/integrations. Any party can have requisitions raised.">
                ⚠ approval gate OFF
              </span>
            )}
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-[#6B5744]">
          <input type="checkbox" checked={showPast} onChange={e => setShowPast(e.target.checked)} />
          Show past
        </label>
        <button onClick={() => load(true)} disabled={refreshing}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-blue-700 hover:bg-blue-100 rounded disabled:opacity-50">
          {refreshing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="p-6 text-center text-sm text-[#8B7355]">
          <Loader2 className="animate-spin inline mr-1" size={14} /> Loading from sheet…
        </div>
      ) : error ? (
        <div className="p-4 bg-red-50 border-t border-red-200 text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Could not fetch upcoming parties</div>
            <div className="text-xs mt-1">{error}</div>
            {/* Show the ACTUAL service account the server is using (dynamic), so
                the operator shares the sheet with the right email. Falls back to
                env-var guidance when the JSON key isn't configured at all. */}
            {authDiag?.service_account_email ? (
              <div className="text-xs mt-1 text-[#6B5744]">
                Share the AKAN Party Manager sheet (Viewer) with:{' '}
                <code className="bg-white px-1 rounded">{authDiag.service_account_email}</code>
                {authDiag.mode === 'keyfile' && authDiag.key_file_path && (
                  <span className="block mt-0.5 text-[10px] text-[#8B7355]">
                    Using JSON key at <code className="bg-white px-1 rounded">{authDiag.key_file_path}</code>
                  </span>
                )}
              </div>
            ) : (
              <div className="text-xs mt-1 text-[#6B5744]">
                No Google credentials found on the server. On AWS, set{' '}
                <code className="bg-white px-1 rounded">GOOGLE_APPLICATION_CREDENTIALS</code>{' '}
                to a service-account JSON key path and share the sheet with that account&apos;s email.
                <span className="block mt-0.5 text-[10px] text-[#8B7355]">
                  See deploy/aws/RUNBOOK.md §3.
                </span>
              </div>
            )}
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="p-6 text-center text-sm text-[#8B7355]">
          {showPast
            ? 'No party rows in the sheet yet.'
            : 'No upcoming parties in the next 30 days. Tick "Show past" to see history.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-[#FFF1E3] text-[#6B5744]">
              <tr>
                <th className="w-6"></th>
                <th className="text-left  py-2 px-3 font-medium">Date</th>
                <th className="text-left  py-2 px-3 font-medium">FP #</th>
                <th className="text-left  py-2 px-3 font-medium">Event / Customer</th>
                <th className="text-right py-2 px-3 font-medium">Pax</th>
                <th className="text-left  py-2 px-3 font-medium">Package</th>
                <th className="text-left  py-2 px-3 font-medium">Status</th>
                <th className="text-right py-2 px-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p, i) => {
                const eventDate = new Date(p.date_of_event);
                const isPast = eventDate < todayStart;
                // Past-day raise is only allowed within a short emergency window
                // (last 3 days, inclusive). Anything older requires admin override.
                // Today's events are NOT past — they're always raise-able subject
                // to the FP-approval gate.
                const PAST_DAY_GRACE_DAYS = 3;
                const daysAgo = isPast
                  ? Math.floor((todayStart.getTime() - eventDate.getTime()) / 86400000)
                  : 0;
                const withinPastGrace = isPast && daysAgo <= PAST_DAY_GRACE_DAYS;
                const key = p.fp_id + i;
                const isOpen = expanded.has(key);
                const hasMenu = !!(p.veg_starters || p.nonveg_starters || p.veg_mains || p.nonveg_mains
                  || p.rice || p.dal || p.salad || p.desserts || p.accompaniments || p.bar_notes);
                return (
                  <Fragment key={key}>
                  <tr className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0] ${isPast ? 'opacity-60' : ''}`}>
                    <td className="py-1.5 pl-2 pr-0 align-middle">
                      {hasMenu && (
                        <button onClick={() => toggleExpand(key)}
                                title={isOpen ? 'Hide menu' : 'View menu'}
                                className="text-[#8B7355] hover:text-[#af4408]">
                          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      )}
                    </td>
                    <td className="py-1.5 px-3 whitespace-nowrap">
                      <div className="font-mono text-[#2D1B0E]">{p.date_of_event}</div>
                      {p.day_of_event && <div className="text-[9px] text-[#8B7355]">{p.day_of_event} {p.time_of_event || ''}</div>}
                    </td>
                    <td className="py-1.5 px-3 font-mono text-[10px] text-[#af4408]">{p.fp_id}</td>
                    <td className="py-1.5 px-3">
                      {/* Customer Name = Contact Person (Column P) per AKAN sheet
                          convention. Falls back to guest_name (Column AQ) only
                          when contact_person is blank — that field is a free-text
                          on the sheet and often duplicates the company. */}
                      <div className="font-medium text-[#2D1B0E]">{p.contact_person || p.guest_name || '—'}</div>
                      {/* Phone intentionally not shown — host privacy + ops don't need it here. */}
                      <div className="text-[10px] text-[#8B7355]">{p.company || ''}</div>
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono">
                      {/* Kitchen cooks for the CONTRACTED minimum-guarantee count.
                          Pax Expected is sales optimism — shown as a small "+X possible"
                          hint only when it exceeds the guarantee. */}
                      {(() => {
                        const guarantee = p.min_guarantee || 0;
                        const expected = p.pax_expected || 0;
                        const primary = guarantee || expected;
                        if (!primary) return '—';
                        return (
                          <>
                            <span title={`Min guarantee: ${guarantee || '—'} · Pax expected: ${expected || '—'}`}>
                              {primary}
                            </span>
                            {guarantee > 0 && expected > guarantee && (
                              <div className="text-[9px] text-[#8B7355] font-normal">+{expected - guarantee} possible</div>
                            )}
                          </>
                        );
                      })()}
                    </td>
                    <td className="py-1.5 px-3 text-[#6B5744]">{p.package_type || '—'}</td>
                    <td className="py-1.5 px-3">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                        (p.status || '').toLowerCase() === 'confirmed' ? 'bg-emerald-100 text-emerald-700' :
                        (p.status || '').toLowerCase() === 'done' ? 'bg-gray-200 text-gray-700' :
                        (p.status || '').toLowerCase() === 'cancelled' ? 'bg-red-100 text-red-700' :
                        'bg-[#FFF1E3] text-[#6B5744]'
                      }`}>{p.status || 'draft'}</span>
                    </td>
                    <td className="py-1.5 px-3 text-right">
                      {(() => {
                        const statusRaw = String(p.status || '').trim();
                        const isApproved = statusRaw.toLowerCase() === 'approved';
                        // FP-approval gate (existing)
                        const passesApproval = isApproved || !requireApproval || isAdmin;
                        // Past-day gate (new): non-admins can raise on past-day
                        // parties only when (a) admin has explicitly enabled
                        // allowPastDay AND (b) the event is within the last
                        // 3 days. Older parties always require admin override.
                        const passesPastDay = !isPast || isAdmin || (allowPastDay && withinPastGrace);
                        const canRaise = passesApproval && passesPastDay;
                        const overrideReason = canRaise && !isApproved
                          ? (isAdmin ? 'admin override' : 'gate off')
                          : null;
                        return (
                          <div className="inline-flex flex-col items-end gap-0.5">
                            {p.linked && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700"
                                    title={`${p.linked_req_count} requisition${p.linked_req_count === 1 ? '' : 's'} already raised for this party. Different depts can still raise their own.`}>
                                <CheckCircle2 size={11} /> {p.linked_req_count} req{p.linked_req_count === 1 ? '' : 's'} raised
                              </span>
                            )}
                            {canRaise && canRaiseReq && (
                              <button onClick={() => stashAndRaiseReq(p, router)}
                                      className="inline-flex items-center gap-1 text-xs text-[#af4408] hover:underline whitespace-nowrap bg-transparent border-0 p-0 cursor-pointer"
                                      title={!isApproved ? `FP status is '${statusRaw || '—'}'. Raising under override.` : 'Raise a new requisition (each dept files their own).'}>
                                <Plus size={11} /> {p.linked ? 'Raise more' : 'Raise Req'}
                                {isPast && (
                                  <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-red-100 text-red-700 border border-red-200"
                                        title={`Event was ${daysAgo} day${daysAgo === 1 ? '' : 's'} ago — raising under emergency override`}>
                                    EMERGENCY · {daysAgo}d ago
                                  </span>
                                )}
                              </button>
                            )}
                            {canRaise && !canRaiseReq && (
                              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-800 cursor-help whitespace-nowrap"
                                    title="You don't have access to /party-requisitions. Ask an admin to grant it on Settings → Page Access (or directly on /users → edit your profile).">
                                🔒 No access
                              </span>
                            )}
                            {!canRaise && !passesPastDay && passesApproval && (
                              // Blocked specifically by past-day gate (FP approval is fine)
                              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-red-50 border border-red-200 text-red-800 cursor-help whitespace-nowrap"
                                    title={
                                      !withinPastGrace
                                        ? `Event was ${daysAgo} day(s) ago. The emergency window is only the last 3 days. Only admins can raise requisitions on older parties.`
                                        : 'Past-day requisitions are disabled. An admin can enable them on Settings → Integrations for emergency cases.'
                                    }>
                                {!withinPastGrace
                                  ? `🔒 Too old (${daysAgo}d) — admin only`
                                  : '🔒 Past day — admin must enable'}
                              </span>
                            )}
                            {!canRaise && !passesApproval && (
                              <>
                                <span title={`FP status is '${statusRaw || '—'}'. Sales must mark it 'Approved' in the AKAN Party Manager sheet before requisitions can be raised. If you just approved it, click 'refresh status ↻' or Refresh in the panel header above.`}
                                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 cursor-help whitespace-nowrap">
                                  ⏳ Awaiting approval
                                </span>
                                <button onClick={() => load(true)}
                                        disabled={refreshing}
                                        className="text-[9px] text-[#af4408] hover:underline disabled:opacity-50">
                                  {refreshing ? 'refreshing…' : 'refresh status ↻'}
                                </button>
                              </>
                            )}
                            {overrideReason && (
                              <span className="text-[9px] text-amber-700 italic">{overrideReason}</span>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                  {isOpen && hasMenu && (
                    <tr className="bg-amber-50/40 border-t border-[#E8D5C4]/30">
                      <td></td>
                      <td colSpan={7} className="py-3 px-3">
                        <div className="text-[10px] font-semibold text-amber-900 mb-1.5 uppercase tracking-wide">
                          🍽️ Menu / Bar — use this to plan material requisitions
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 text-[11px]">
                          {[
                            ['🥗 Veg Starters',     p.veg_starters],
                            ['🍗 Non-Veg Starters', p.nonveg_starters],
                            ['🥘 Veg Mains',        p.veg_mains],
                            ['🍖 Non-Veg Mains',    p.nonveg_mains],
                            ['🍚 Rice',             p.rice],
                            ['🥣 Dal',              p.dal],
                            ['🥬 Salad',            p.salad],
                            ['🍮 Desserts',         p.desserts],
                            ['🫓 Accompaniments',   p.accompaniments],
                          ].filter(([, v]) => v && String(v).trim()).map(([lbl, v]) => (
                            <div key={lbl as string} className="text-[#2D1B0E]">
                              <span className="font-medium text-amber-900">{lbl}:</span>{' '}
                              <span className="text-[#6B5744]">{v as string}</span>
                            </div>
                          ))}
                          {p.bar_notes && (
                            <div className="md:col-span-2 lg:col-span-3 pt-1.5 border-t border-amber-200 mt-1 bg-amber-100/40 rounded px-2 py-1.5">
                              <div className="font-medium text-amber-900 mb-0.5">
                                🍸 Cocktails / Mocktails / Bar Notes
                                {(p.drinks_start_time || p.drinks_end_time) && (
                                  <span className="text-[#8B7355] text-[10px] font-normal ml-1">
                                    ({p.drinks_start_time || '?'} – {p.drinks_end_time || '?'})
                                  </span>
                                )}
                              </div>
                              <div className="text-[#2D1B0E] whitespace-pre-wrap">{p.bar_notes}</div>
                            </div>
                          )}
                          <div className="md:col-span-2 lg:col-span-3 text-[10px] text-[#8B7355] italic pt-1 border-t border-amber-200 mt-1">
                            🍾 Liquor / bottle details aren't in the sheet — upload the FP PDF on{' '}
                            <a href={`/party-requisitions${p.linked ? '' : '?from=fp-records&fp_id=' + encodeURIComponent(p.fp_id)}`}
                               className="text-[#af4408] underline">Party Requisitions</a>{' '}
                            to extract bar items + estimated quantities.
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </Fragment>
  );
}

function timeAgo(iso: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/**
 * Build a URL to /party-requisitions that pre-fills the New Party Requisition
 * modal with this row's metadata. The party-requisitions page reads these
 * query params on mount and opens the modal pre-populated.
 */
/**
 * The full menu + customer + notes can easily exceed 2 KB which trips
 * URL-length limits in some browsers/proxies ("This page couldn't load"
 * in Safari). So we stash the prefill payload in sessionStorage and
 * navigate with just a short marker. The /party-requisitions page reads
 * it on mount and clears it after first read.
 */
// NOTE: These are NOT exported. Next.js App Router page files only allow
// specific named exports (metadata, dynamic, revalidate, etc.). Adding
// arbitrary exports breaks Next's bundle chunking and causes runtime errors
// like "Cannot access 'ei' before initialization" in the React reconciler.
const PARTY_REQ_PREFILL_KEY = '__party_req_prefill__';

function stashAndRaiseReq(p: UpcomingParty, router: ReturnType<typeof useRouter>): void {
  if (typeof window === 'undefined') return;
  const payload = {
    from: 'fp-records',
    // event_name kept only as a fallback for legacy parsers — the modal now
    // reads explicit `guest_name` / `guest_company` below, which is unambiguous.
    //
    // Per AKAN Party Manager sheet convention:
    //   Column N = company       → Company Name
    //   Column P = contact_person → Customer Name (the actual person we deal with)
    //   Column AQ = guest_name   → free-text, often duplicates company; fallback only
    event_name:  p.contact_person || p.guest_name || p.fp_id,
    event_date:  p.date_of_event,
    // Min guarantee = contracted headcount kitchen cooks for; pax_expected is sales optimism.
    guest_count: String(p.min_guarantee || p.pax_expected || ''),
    // Explicit keys — never positional. Phone intentionally omitted.
    guest_name:    p.contact_person || p.guest_name || '',
    guest_company: p.company || '',
    customer:      p.company || '',                  // legacy alias = Company Name

    notes:       [
      p.package_type && `Package: ${p.package_type}`,
      p.allocated_area && `Area: ${p.allocated_area}`,
      p.time_of_event && `Time: ${p.time_of_event}`,
      p.bar_notes && `Bar: ${p.bar_notes}`,
    ].filter(Boolean).join(' · '),
    fp_id: p.fp_id,
    party_unique_id: p.party_unique_id || '',
    veg_starters:    p.veg_starters || '',
    nonveg_starters: p.nonveg_starters || '',
    veg_mains:       p.veg_mains || '',
    nonveg_mains:    p.nonveg_mains || '',
    rice:            p.rice || '',
    dal:             p.dal || '',
    salad:           p.salad || '',
    desserts:        p.desserts || '',
    accompaniments:  p.accompaniments || '',
    bar_notes:       p.bar_notes || '',
  };
  try { sessionStorage.setItem(PARTY_REQ_PREFILL_KEY, JSON.stringify(payload)); }
  catch { /* sessionStorage full / disabled — page will open with empty modal */ }
  // Use Next router push (keeps React in-memory, no full reload). URL stays
  // ~40 chars regardless of menu size. window.location.href would trigger
  // a full navigation that could serve stale cached HTML referencing dead chunks.
  router.push('/party-requisitions?prefill=1');
}

// Backwards-compat shim: any code still using raiseReqHref gets a clean short URL too.
function raiseReqHref(_p: UpcomingParty): string {
  return '/party-requisitions?prefill=1';
}

/* ════════════════════════════════════════════════════════════════════
   STATUS CHANGES PANEL — recent FP status flips from the audit log.
   Populated by the in-process scheduler every 15 min and on every
   explicit refresh.
   ════════════════════════════════════════════════════════════════════ */

interface StatusChange {
  id: string;
  party_unique_id?: string;
  fp_id?: string;
  event_name?: string;
  event_date?: string;
  old_status?: string;
  new_status?: string;
  detected_at: string;
  source?: string;
}

function StatusChangesPanel() {
  const [changes, setChanges] = useState<StatusChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      const r = await fetch('/api/party-events/status-audit?days=7&limit=20').then(r => r.json());
      setChanges(r.changes || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); const id = setInterval(load, 60_000); return () => clearInterval(id); }, []);

  const approvals = changes.filter(c => (c.new_status || '').toLowerCase() === 'approved').length;

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
              className="w-full px-4 py-3 bg-[#FFF1E3] flex items-center gap-3 text-left hover:bg-[#FFE8D0]">
        {open ? <ChevronDown size={14} className="text-[#6B5744]" /> : <ChevronRight size={14} className="text-[#6B5744]" />}
        <Link2 size={14} className="text-[#af4408]" />
        <span className="text-sm font-semibold text-[#2D1B0E]">Recent Status Changes</span>
        <span className="text-xs text-[#8B7355]">· last 7 days</span>
        {changes.length > 0 && (
          <span className="ml-auto text-xs text-[#6B5744]">
            {changes.length} change{changes.length === 1 ? '' : 's'}
            {approvals > 0 && <span className="ml-2 text-emerald-700 font-medium">· {approvals} approval{approvals === 1 ? '' : 's'}</span>}
          </span>
        )}
      </button>
      {open && (
        <div className="px-4 py-3">
          {loading ? (
            <div className="text-xs text-[#8B7355]"><Loader2 size={11} className="inline animate-spin mr-1" />Loading…</div>
          ) : changes.length === 0 ? (
            <div className="text-xs text-[#8B7355] italic">No FP status changes in the last 7 days.</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[#6B5744]">
                <tr>
                  <th className="text-left  py-1.5 px-2 font-medium">When</th>
                  <th className="text-left  py-1.5 px-2 font-medium">Event</th>
                  <th className="text-left  py-1.5 px-2 font-medium">From</th>
                  <th className="text-left  py-1.5 px-2 font-medium">→ To</th>
                  <th className="text-left  py-1.5 px-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {changes.map(c => {
                  const approved = (c.new_status || '').toLowerCase() === 'approved';
                  return (
                    <tr key={c.id} className="border-t border-[#E8D5C4]/50">
                      <td className="py-1 px-2 text-[10px] font-mono text-[#8B7355]">{timeAgo(c.detected_at)}</td>
                      <td className="py-1 px-2">
                        <div className="text-[#2D1B0E]">{c.event_name || '—'}</div>
                        <div className="text-[10px] text-[#8B7355]">{c.event_date} · {c.fp_id}</div>
                      </td>
                      <td className="py-1 px-2 text-[10px] text-[#8B7355]">{c.old_status || '∅'}</td>
                      <td className={`py-1 px-2 text-[10px] font-medium ${approved ? 'text-emerald-700' : 'text-[#2D1B0E]'}`}>
                        {approved && '✓ '}{c.new_status || '—'}
                      </td>
                      <td className="py-1 px-2 text-[10px] text-[#8B7355]">{c.source || 'cron'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
