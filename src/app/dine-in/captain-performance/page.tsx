'use client';

import { useCallback, useEffect, useState } from 'react';
import { Timer, Loader2, Trophy, AlertTriangle } from 'lucide-react';

const todayIso = () => new Date().toISOString().slice(0, 10);
const isoMinusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

/** Seconds → "45s" / "1m 20s" / "1h 5m". null → "—". */
function dur(s: number | null | undefined): string {
  if (s == null) return '—';
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
// Colour the response time: green ≤1m, amber ≤3m, red beyond.
function speedColor(s: number | null | undefined): string {
  if (s == null) return '#8B7355';
  if (s <= 60) return '#2D7A4A';
  if (s <= 180) return '#B8860B';
  return '#C0392B';
}

interface Captain { name: string; attended: number; avg_response: number | null; best_response: number | null; worst_response: number | null; completed: number; avg_attend: number | null; }

export default function CaptainPerformancePage() {
  const [from, setFrom] = useState(isoMinusDays(7));
  const [to, setTo] = useState(todayIso());
  const [data, setData] = useState<{ captains: Captain[]; summary: any } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const j = await fetch(`/api/dine-in/captain-performance?from=${from}&to=${to}`).then(r => r.json());
      setData(j);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const caps = data?.captains || [];
  const s = data?.summary;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <Timer className="w-6 h-6 text-[#af4408]" /> Captain Response Times
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            How fast each captain attends the table — measured from the guest's request (call waiter / water / cutlery / bill) to Accept and to Done.
          </p>
        </div>
        <div className="flex gap-2 items-end text-xs">
          <label className="flex flex-col text-[#6B5744]">From
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0]" /></label>
          <label className="flex flex-col text-[#6B5744]">To
            <input type="date" value={to} onChange={e => setTo(e.target.value)} className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0]" /></label>
        </div>
      </div>

      {loading && <div className="flex items-center gap-2 text-xs text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}

      {s && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Requests" value={String(s.total)} hint={`${s.completed} completed`} />
          <Stat label="Avg Response" value={dur(s.avg_response)} hint="call → accepted" color={speedColor(s.avg_response)} />
          <Stat label="Accepted" value={String(s.accepted)} hint={`${s.total ? Math.round((s.accepted / s.total) * 100) : 0}% of calls`} />
          <Stat label="Unattended" value={String(s.unattended)} hint="never accepted" color={s.unattended > 0 ? '#C0392B' : '#8B7355'} />
        </div>
      )}

      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-4 py-2 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex items-center gap-2">
          <Trophy className="w-4 h-4 text-[#af4408]" />
          <h3 className="text-sm font-semibold text-[#2D1B0E]">Fastest to attend</h3>
          <span className="text-[10px] text-[#8B7355] ml-auto">Ranked by average response time</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[#8B7355] bg-[#FFF8F0]">
              <tr>
                <th className="text-left  py-2 px-3 font-medium w-8">#</th>
                <th className="text-left  py-2 px-3 font-medium">Captain</th>
                <th className="text-right py-2 px-3 font-medium" title="Requests this captain accepted">Attended</th>
                <th className="text-right py-2 px-3 font-medium" title="Average time from guest call to Accept">Avg response</th>
                <th className="text-right py-2 px-3 font-medium" title="Best (fastest) response">Fastest</th>
                <th className="text-right py-2 px-3 font-medium" title="Worst (slowest) response">Slowest</th>
                <th className="text-right py-2 px-3 font-medium" title="Requests this captain marked Done">Done</th>
                <th className="text-right py-2 px-3 font-medium" title="Average call → Done (start to finish)">Avg attend</th>
              </tr>
            </thead>
            <tbody>
              {caps.map((c, i) => (
                <tr key={c.name} className="border-t border-[#E8D5C4]/50">
                  <td className="py-2 px-3 text-[#8B7355]">{c.avg_response != null ? i + 1 : '—'}</td>
                  <td className="py-2 px-3 font-medium text-[#2D1B0E]">{c.name}</td>
                  <td className="py-2 px-3 text-right font-mono">{c.attended}</td>
                  <td className="py-2 px-3 text-right font-mono font-semibold" style={{ color: speedColor(c.avg_response) }}>{dur(c.avg_response)}</td>
                  <td className="py-2 px-3 text-right font-mono text-[#6B5744]">{dur(c.best_response)}</td>
                  <td className="py-2 px-3 text-right font-mono text-[#6B5744]">{dur(c.worst_response)}</td>
                  <td className="py-2 px-3 text-right font-mono">{c.completed}</td>
                  <td className="py-2 px-3 text-right font-mono text-[#6B5744]">{dur(c.avg_attend)}</td>
                </tr>
              ))}
              {!loading && caps.length === 0 && (
                <tr><td colSpan={8} className="py-8 text-center text-[#8B7355]">
                  <AlertTriangle className="w-5 h-5 mx-auto mb-1 text-[#C0A98F]" />
                  No service requests were attended in this range.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-[11px] text-[#8B7355]">Every guest bell (Call waiter / Refill water / Extra cutlery / Request bill) is timed from tap → captain Accept → Done. Green ≤ 1 min · amber ≤ 3 min · red slower.</p>
    </div>
  );
}

function Stat({ label, value, hint, color }: { label: string; value: string; hint?: string; color?: string }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-lg p-3">
      <div className="text-[10px] text-[#8B7355] uppercase tracking-wide">{label}</div>
      <div className="text-lg font-bold mt-0.5" style={{ color: color || '#2D1B0E' }}>{value}</div>
      {hint && <div className="text-[10px] text-[#8B7355] mt-0.5">{hint}</div>}
    </div>
  );
}
