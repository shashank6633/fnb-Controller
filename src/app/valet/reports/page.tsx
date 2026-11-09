'use client';

/**
 * VALET REPORTS (/valet/reports) — Valet Head (assigned outlets) / owner (all).
 * Every number has its definition beside it; void/test cars are excluded; the
 * CSV export carries the same figures and definitions.
 */
import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { PageHead, Gate, Panel, Btn, Field, inputCls, ErrorNote, InfoNote, useValetContext } from '../ui';

interface Stat { n: number; avg: number | null; p90: number | null; max: number | null }
interface Report {
  definitions: Record<string, string>;
  totals: { arrivals: number; handed_over: number; still_held: number; pickups: number; immediate_requests: number; scheduled_requests: number; no_shows: number; cancelled: number; peak_occupancy: number; peak_hour: { hour: number; arrivals: number } | null };
  times: Record<'claim_time' | 'retrieval_time' | 'request_to_ready' | 'scheduled_lateness' | 'gate_dwell', Stat>;
  by_day: { date: string; arrivals: number }[];
  by_hour: { hour: number; arrivals: number }[];
  incidents: { kind: string; n: number }[];
  attendants: { user_id: string; name: string; parks: number; fetches: number; hours: number }[];
}

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() + 330 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
const TIME_LABEL: Record<string, string> = {
  request_to_ready: 'Request → ready (immediate)', scheduled_lateness: 'Booked time lateness', claim_time: 'Time to claim',
  retrieval_time: 'Fetch time', gate_dwell: 'Wait at the gate',
};

export default function ValetReportsPage() {
  const { ctx, error: ctxError, outletId, setOutletId } = useValetContext();
  const [scope, setScope] = useState<string>('');
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(istToday());
  const [sf, setSf] = useState('');
  const [st, setSt] = useState('');
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const outlet = scope || outletId;
  const qs = `outlet=${encodeURIComponent(outlet)}&from=${from}&to=${to}${sf && st ? `&shift_from=${sf}&shift_to=${st}` : ''}`;
  const load = useCallback(async () => {
    if (!outlet) return;
    setLoading(true); setErr('');
    try {
      const res = await fetch(`/api/valet/reports?${qs}`, { cache: 'no-store' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j.error || 'Could not load the report.'); setR(null); } else setR(j);
    } finally { setLoading(false); }
  }, [outlet, qs]);
  useEffect(() => { void load(); }, [load]);
  const fmt = (s: Stat) => (s.n ? `${s.avg} / ${s.p90} / ${s.max}` : '—');
  return (
    <div className="pb-24 max-w-5xl">
      <PageHead ctx={ctx} title="Valet Reports" subtitle="Void and test cars are excluded. Business dates: cars after midnight count for the night before." />
      <Gate ctx={ctx} ctxError={ctxError}>
        <div className="mt-3 space-y-3">
          <Panel>
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
              <Field label="Outlet">
                <select className={inputCls} value={scope || outletId} onChange={e => { const v = e.target.value; if (v === 'all') setScope('all'); else { setScope(''); setOutletId(v); } }}>
                  {ctx?.outlets.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  {ctx && ctx.outlets.length > 1 ? <option value="all">All my outlets</option> : null}
                </select>
              </Field>
              <Field label="From"><input type="date" className={inputCls} value={from} onChange={e => setFrom(e.target.value)} /></Field>
              <Field label="To"><input type="date" className={inputCls} value={to} onChange={e => setTo(e.target.value)} /></Field>
              <Field label="Shift from (optional)"><input type="time" className={inputCls} value={sf} onChange={e => setSf(e.target.value)} /></Field>
              <Field label="Shift to"><input type="time" className={inputCls} value={st} onChange={e => setSt(e.target.value)} /></Field>
              <a className="inline-flex min-h-[44px] items-center justify-center gap-1 rounded-xl border border-[#E8D5C4] bg-white px-3 text-sm font-bold" href={`/api/valet/reports?${qs}&format=csv`}>
                <Download size={15} aria-hidden />CSV
              </a>
            </div>
          </Panel>
          <ErrorNote message={err} />
          {loading && !r ? <p className="text-sm text-[#8B7355]">Loading…</p> : null}
          {r ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {([['Arrivals', r.totals.arrivals], ['Handed over', r.totals.handed_over], ['Still held', r.totals.still_held], ['No-shows', r.totals.no_shows],
                  ['Requests (now)', r.totals.immediate_requests], ['Requests (booked)', r.totals.scheduled_requests], ['Peak cars held', r.totals.peak_occupancy],
                  ['Peak hour', r.totals.peak_hour ? `${String(r.totals.peak_hour.hour).padStart(2, '0')}:00 (${r.totals.peak_hour.arrivals})` : '—']] as [string, string | number][]).map(([l, v]) => (
                  <div key={l} className="rounded-xl border border-[#E8D5C4] bg-white px-3 py-2"><div className="text-[11px] font-semibold uppercase text-[#8B7355]">{l}</div><div className="text-xl font-extrabold">{v}</div></div>
                ))}
              </div>
              <Panel title="Times (minutes) — average / p90 / max">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-[#8B7355]"><tr><th className="py-1 pr-2">Measure</th><th className="pr-2">avg / p90 / max</th><th className="pr-2">Counted</th><th>Definition</th></tr></thead>
                  <tbody>
                    {(Object.keys(TIME_LABEL) as (keyof Report['times'])[]).map(k => (
                      <tr key={k} className="border-t border-[#F0E4D6] align-top">
                        <td className="py-1.5 pr-2 font-semibold">{TIME_LABEL[k]}</td><td className="pr-2 font-mono">{fmt(r.times[k])}</td><td className="pr-2">{r.times[k].n}</td>
                        <td className="text-xs text-[#6B5744]">{r.definitions[k]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[11px] text-[#8B7355]">p90 = 9 in 10 were at or under this. Booked lateness below 0 means early.</p>
              </Panel>
              <div className="grid sm:grid-cols-2 gap-3">
                <Panel title="Arrivals by hour (IST)">
                  <div className="flex items-end gap-0.5 h-28" role="img" aria-label="Arrivals by hour of day">
                    {r.by_hour.map(h => {
                      const max = Math.max(1, ...r.by_hour.map(x => x.arrivals));
                      return <div key={h.hour} title={`${h.hour}:00 — ${h.arrivals}`} className="flex-1 bg-[#af4408]/80 rounded-t" style={{ height: `${(h.arrivals / max) * 100}%`, minHeight: h.arrivals ? 2 : 0 }} />;
                    })}
                  </div>
                  <div className="flex justify-between text-[10px] text-[#8B7355] mt-1"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
                </Panel>
                <Panel title="Team — parked / fetched / hours">
                  {!r.attendants.length ? <p className="text-sm text-[#8B7355]">No activity in this range.</p> : (
                    <table className="w-full text-sm"><tbody>
                      {r.attendants.map(a => <tr key={a.user_id} className="border-t border-[#F0E4D6]"><td className="py-1 pr-2">{a.name}</td><td className="pr-2">{a.parks}</td><td className="pr-2">{a.fetches}</td><td>{a.hours}h</td></tr>)}
                    </tbody></table>
                  )}
                </Panel>
              </div>
              <Panel title="Incidents">
                {!r.incidents.length ? <p className="text-sm text-[#8B7355]">None reported.</p> : <p className="text-sm">{r.incidents.map(i => `${i.kind.replace('_', ' ')}: ${i.n}`).join(' · ')}</p>}
              </Panel>
              <Btn kind="ghost" onClick={() => void load()}>Refresh</Btn>
            </>
          ) : !loading && !err ? <InfoNote>Choose a range.</InfoNote> : null}
        </div>
      </Gate>
    </div>
  );
}
