'use client';

/**
 * KOT Data Points — operational analytics from fired KOTs.
 *
 * Four sections (chosen with the user): Kitchen load (by station + by hour),
 * Captain activity, Prep speed, Reprints & voids. Live "Today" by default
 * (auto-refreshes), with a date range for looking back.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, Loader2, ChefHat, Users, Timer, Printer, Ban, Flame, Clock,
} from 'lucide-react';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const hourLabel = (h: number) => {
  const am = h < 12; const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${am ? 'AM' : 'PM'}`;
};

interface Row { [k: string]: any }
interface Data {
  range: { from: string; to: string; isToday: boolean };
  totals: { kots: number; items: number; sales: number; reprints: number; voids: number };
  byStation: Row[]; byHour: Row[]; byCaptain: Row[]; prep: Row[];
  reprints: { totalReprints: number; kotsReprinted: number; topReprinted: Row[] };
  voids: { count: number; value: number };
}

export default function KotAnalyticsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    try {
      const qs = from && to ? `?from=${from}&to=${to}` : '';
      const r = await fetch(`/api/dine-in/kot-analytics${qs}`, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      setData(j);
      if (!from || !to) { setFrom(j.range.from); setTo(j.range.to); } // sync inputs to IST today
    } catch { /* keep last */ } finally { setLoading(false); }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);
  // Auto-refresh while viewing "today" so the floor sees live numbers.
  useEffect(() => {
    if (!data?.range.isToday) return;
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [data?.range.isToday, load]);

  const setQuick = (days: number) => {
    const d = new Date(); const iso = (x: Date) => x.toISOString().slice(0, 10);
    if (days === 0) { setFrom(data?.range.from || iso(d)); setTo(data?.range.from || iso(d)); return; }
    const start = new Date(); start.setDate(start.getDate() - days);
    setFrom(iso(start)); setTo(iso(d));
  };

  const maxHour = useMemo(() => Math.max(1, ...(data?.byHour || []).map((h) => h.kots)), [data]);
  const maxStation = useMemo(() => Math.max(1, ...(data?.byStation || []).map((s) => s.kots)), [data]);

  const t = data?.totals;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      {/* Header + range controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2">
          <Flame className="w-6 h-6 text-[#af4408]" />
          <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">KOT Data Points</h1>
          {data?.range.isToday && (
            <span className="ml-1 inline-flex items-center gap-1 text-[11px] font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> Live · Today
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setQuick(0)} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-[#1C0F05] text-white">Today</button>
          <button onClick={() => setQuick(7)} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-white border border-[#E8DFD3] text-[#2D1B0E]">7 days</button>
          <button onClick={() => setQuick(30)} className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-white border border-[#E8DFD3] text-[#2D1B0E]">30 days</button>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-1.5 text-xs rounded-lg border border-[#E8DFD3] bg-white" />
          <span className="text-[#8B7355] text-xs">→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-1.5 text-xs rounded-lg border border-[#E8DFD3] bg-white" />
          <button onClick={load} className="p-2 rounded-lg bg-white border border-[#E8DFD3]" aria-label="Refresh">
            {loading ? <Loader2 className="w-4 h-4 animate-spin text-[#af4408]" /> : <RefreshCw className="w-4 h-4 text-[#af4408]" />}
          </button>
        </div>
      </div>

      {!data && loading && (
        <div className="flex items-center gap-2 text-[#8B7355] py-12 justify-center"><Loader2 className="w-5 h-5 animate-spin" /> Loading…</div>
      )}

      {data && (
        <div className="space-y-5">
          {/* KPI row */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Kpi label="KOTs fired" value={String(t!.kots)} accent />
            <Kpi label="Items" value={String(Math.round(t!.items))} />
            <Kpi label="Sales (fired)" value={fmt(t!.sales)} />
            <Kpi label="Reprints" value={String(t!.reprints)} muted={t!.reprints === 0} />
            <Kpi label="Voids" value={String(t!.voids)} muted={t!.voids === 0} />
          </div>

          {/* Kitchen load */}
          <Section icon={<ChefHat className="w-4 h-4" />} title="Kitchen load">
            <div className="grid md:grid-cols-2 gap-5">
              <div>
                <p className="text-xs font-semibold text-[#8B7355] mb-2">By station</p>
                {data.byStation.length === 0 ? <Empty /> : (
                  <div className="space-y-2">
                    {data.byStation.map((s) => (
                      <div key={s.station}>
                        <div className="flex justify-between text-sm mb-0.5">
                          <span className="font-medium text-[#2D1B0E] capitalize">{s.station}</span>
                          <span className="text-[#8B7355]">{s.kots} KOT · {Math.round(s.items)} items · {fmt(s.sales)}</span>
                        </div>
                        <div className="h-2 rounded-full bg-[#F0E9DF] overflow-hidden">
                          <div className="h-full bg-[#af4408] rounded-full" style={{ width: `${(s.kots / maxStation) * 100}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <p className="text-xs font-semibold text-[#8B7355] mb-2">By hour (peak times)</p>
                {data.byHour.length === 0 ? <Empty /> : (
                  <div className="flex items-end gap-1 h-32">
                    {data.byHour.map((h) => (
                      <div key={h.hour} className="flex-1 flex flex-col items-center justify-end group" title={`${hourLabel(h.hour)} · ${h.kots} KOTs · ${Math.round(h.items)} items`}>
                        <div className="w-full bg-[#af4408] rounded-t group-hover:bg-[#7a2f06] transition-colors" style={{ height: `${(h.kots / maxHour) * 100}%`, minHeight: 3 }} />
                        <span className="text-[9px] text-[#8B7355] mt-1 rotate-0">{hourLabel(h.hour).replace(' ', '')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Section>

          {/* Captain activity */}
          <Section icon={<Users className="w-4 h-4" />} title="Captain activity">
            {data.byCaptain.length === 0 ? <Empty /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-[#8B7355] border-b border-[#E8DFD3]">
                    <th className="py-1.5 pr-3">Captain</th><th className="py-1.5 px-3 text-right">KOTs</th>
                    <th className="py-1.5 px-3 text-right">Items</th><th className="py-1.5 pl-3 text-right">Sales punched</th>
                  </tr></thead>
                  <tbody>
                    {data.byCaptain.map((c, i) => (
                      <tr key={i} className="border-b border-[#F0E9DF] last:border-0">
                        <td className="py-2 pr-3 font-medium text-[#2D1B0E]">{c.captain}</td>
                        <td className="py-2 px-3 text-right">{c.kots}</td>
                        <td className="py-2 px-3 text-right">{Math.round(c.items)}</td>
                        <td className="py-2 pl-3 text-right font-semibold text-[#af4408]">{fmt(c.sales)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* Prep speed */}
          <Section icon={<Timer className="w-4 h-4" />} title="Prep speed (fire → ready)">
            {data.prep.length === 0 ? (
              <p className="text-sm text-[#8B7355]">No prep times yet. The kitchen needs to mark tickets <b>Ready</b> on the Kitchen Display for this to populate. (Reprinted tickets are excluded.)</p>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.prep.map((s) => (
                  <div key={s.station} className="rounded-xl border border-[#E8DFD3] bg-white p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-[#2D1B0E] capitalize">{s.station}</span>
                      <Clock className="w-4 h-4 text-[#8B7355]" />
                    </div>
                    <p className="text-2xl font-extrabold text-[#2D1B0E] mt-1">{s.avgMin}<span className="text-sm font-semibold text-[#8B7355]"> min</span></p>
                    <p className="text-[11px] text-[#8B7355]">avg over {s.n} ticket{s.n === 1 ? '' : 's'}</p>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Reprints & voids */}
          <Section icon={<Printer className="w-4 h-4" />} title="Reprints & voids">
            <div className="grid md:grid-cols-2 gap-5">
              <div>
                <div className="flex gap-6 mb-3">
                  <div><p className="text-2xl font-extrabold text-[#2D1B0E]">{data.reprints.totalReprints}</p><p className="text-[11px] text-[#8B7355]">total reprints</p></div>
                  <div><p className="text-2xl font-extrabold text-[#2D1B0E]">{data.reprints.kotsReprinted}</p><p className="text-[11px] text-[#8B7355]">tickets reprinted</p></div>
                </div>
                {data.reprints.topReprinted.length === 0 ? (
                  <p className="text-sm text-[#8B7355]">No reprints in this period — clean printing. 👍</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {data.reprints.topReprinted.map((k, i) => (
                      <li key={i} className="flex justify-between border-b border-[#F0E9DF] last:border-0 py-1">
                        <span className="text-[#2D1B0E]">KOT #{k.kotNumber} <span className="text-[#8B7355] capitalize">· {k.station}</span>{k.orderRef ? <span className="text-[#8B7355]"> · #{k.orderRef}</span> : null}</span>
                        <span className="font-semibold text-[#af4408]">×{k.reprints}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="rounded-xl border border-[#E8DFD3] bg-white p-4 self-start">
                <div className="flex items-center gap-2 text-[#8B7355] text-xs font-semibold mb-1"><Ban className="w-4 h-4" /> VOIDED ORDERS</div>
                <p className="text-3xl font-extrabold text-[#2D1B0E]">{data.voids.count}</p>
                <p className="text-sm text-[#8B7355]">worth {fmt(data.voids.value)}</p>
              </div>
            </div>
          </Section>

          <p className="text-[11px] text-[#8B7355] text-center pt-2">
            Range: {data.range.from}{data.range.to !== data.range.from ? ` → ${data.range.to}` : ''} · times in IST · "Sales punched" sums fired item values per captain.
          </p>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, accent, muted }: { label: string; value: string; accent?: boolean; muted?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${accent ? 'border-[#af4408] bg-[#FFF3EC]' : 'border-[#E8DFD3] bg-white'}`}>
      <p className="text-[11px] text-[#8B7355] leading-none">{label}</p>
      <p className={`text-2xl font-extrabold mt-1 leading-none ${muted ? 'text-[#B8A88F]' : accent ? 'text-[#af4408]' : 'text-[#2D1B0E]'}`}>{value}</p>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[#E8DFD3] bg-white/60 p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-sm font-bold text-[#2D1B0E] mb-3">
        <span className="text-[#af4408]">{icon}</span>{title}
      </h2>
      {children}
    </section>
  );
}

function Empty() { return <p className="text-sm text-[#8B7355]">No data in this period.</p>; }
