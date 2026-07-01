'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import { ChefHat, Clock, Wifi, WifiOff, AlertTriangle } from 'lucide-react';

interface KotItem { name: string; quantity: number; notes: string; status: string; }
interface Kot {
  id: string; kot_number: number; station: string; status: string; created_at: string;
  order_number: number; order_type: string; table_number: string | null; zone: string | null;
  items: KotItem[];
}
interface KotAlert {
  id: string; kot_number: number | null; station: string; table_number: string | null;
  reason: string; created_by: string; created_at: string;
}

const FLOW: Record<string, { label: string; next: string }> = {
  new:       { label: 'Start',  next: 'preparing' },
  preparing: { label: 'Ready',  next: 'ready' },
  ready:     { label: 'Served', next: 'served' },
};
const STATUS_STYLE: Record<string, string> = {
  new:       'border-amber-400 bg-amber-500/10',
  preparing: 'border-blue-400 bg-blue-500/10',
  ready:     'border-green-400 bg-green-500/10',
};

function ageString(createdUtc: string): { txt: string; mins: number } {
  const t = new Date(createdUtc.replace(' ', 'T') + 'Z').getTime();
  const mins = Math.max(0, (Date.now() - t) / 60000);
  const m = Math.floor(mins), s = Math.floor((mins - m) * 60);
  return { txt: `${m}:${String(s).padStart(2, '0')}`, mins };
}

export default function KitchenPage() {
  const [kots, setKots] = useState<Kot[]>([]);
  const [stations, setStations] = useState<string[]>([]);
  const [station, setStation] = useState('all');
  const [live, setLive] = useState(false);
  const [, setTick] = useState(0);
  const [alerts, setAlerts] = useState<KotAlert[]>([]);
  const esRef = useRef<EventSource | null>(null);

  const load = useCallback(async (st: string) => {
    try {
      const r = await api(`/api/dine-in/kds?station=${st}`);
      const j = await r.json();
      setKots(j.items || []);
      setStations(j.stations || []);
    } catch (_) {}
  }, []);

  const loadAlerts = useCallback(async () => {
    try {
      const r = await api('/api/dine-in/kot-alerts?open=1');
      const j = await r.json();
      setAlerts(j.alerts || []);
    } catch (_) {}
  }, []);

  async function resolveAlert(id: string) {
    setAlerts((a) => a.filter((x) => x.id !== id)); // optimistic
    try { await api('/api/dine-in/kot-alerts', { method: 'POST', body: { id, resolve: true } }); }
    catch (_) {}
    loadAlerts();
  }

  // Initial + on station change: load, (re)connect SSE, with a poll safety net.
  useEffect(() => {
    load(station);
    esRef.current?.close();
    const es = new EventSource(`/api/dine-in/kds/stream?station=${station}`);
    es.onopen = () => setLive(true);
    es.onmessage = () => load(station);          // any kot.new / kot.bumped → refetch
    es.onerror = () => setLive(false);            // browser auto-reconnects; poll covers the gap
    esRef.current = es;
    const poll = setInterval(() => load(station), 10000);
    return () => { es.close(); clearInterval(poll); };
  }, [station, load]);

  // Poll unresolved KOT escalations (~10s) — shown as a red banner above the grid.
  useEffect(() => {
    loadAlerts();
    const t = setInterval(loadAlerts, 10000);
    return () => clearInterval(t);
  }, [loadAlerts]);

  // Tick every second so the age timers move.
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  async function bump(k: Kot) {
    await api(`/api/dine-in/kds/${k.id}/bump`, { method: 'POST', body: {} });
    load(station);
  }

  const stationOptions = ['all', ...stations];

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#af4408]/10 rounded-lg"><ChefHat className="w-6 h-6 text-[#af4408]" /></div>
          <div>
            <h1 className="text-2xl font-bold text-[#af4408]">Kitchen Display</h1>
            <p className="text-sm text-[#8B7355]">Live order tickets · tap to advance</p>
          </div>
        </div>
        <span className={`flex items-center gap-1.5 text-xs font-medium ${live ? 'text-green-600' : 'text-amber-600'}`}>
          {live ? <Wifi size={14} /> : <WifiOff size={14} />} {live ? 'Live' : 'Reconnecting…'}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {stationOptions.map((s) => (
          <button key={s} onClick={() => setStation(s)}
            className={`text-xs px-3 py-1.5 rounded-full capitalize ${station === s ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>
            {s === 'all' ? 'All stations' : s}
          </button>
        ))}
      </div>

      {alerts.length > 0 && (
        <div className="mb-4 rounded-xl border-2 border-red-500 bg-red-600 text-white shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2 bg-red-700 font-bold text-sm">
            <AlertTriangle size={16} className="animate-pulse" />
            KOT NOT PRINTED — action needed ({alerts.length})
          </div>
          <div className="divide-y divide-red-400/40">
            {alerts.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="text-sm font-medium">
                  KOT #{a.kot_number ?? '—'}
                  {' — '}
                  {a.table_number ? `TABLE ${a.table_number}` : (a.station || 'kitchen').toUpperCase()}
                  {' — not printed'}
                  {a.reason ? `: ${a.reason}` : ''}
                  <span className="block text-[11px] font-normal text-red-100/90">
                    flagged by {a.created_by || 'captain'}
                  </span>
                </div>
                <button onClick={() => resolveAlert(a.id)}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-red-700 hover:bg-red-50">
                  Resolve
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {kots.length === 0 ? (
        <div className="card text-center py-16 text-[#8B7355]">No active tickets. Fired orders appear here instantly.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {kots.map((k) => {
            const age = ageString(k.created_at);
            const stale = age.mins >= 10 && k.status !== 'ready';
            const flow = FLOW[k.status];
            return (
              <div key={k.id} className={`rounded-xl border-2 p-3 ${STATUS_STYLE[k.status] || 'border-[#E8D5C4] bg-white'} ${stale ? 'ring-2 ring-red-400' : ''}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-[#2D1B0E]">{k.table_number ? `Table ${k.table_number}` : k.order_type}</span>
                  <span className={`flex items-center gap-1 text-xs font-medium ${stale ? 'text-red-600' : 'text-[#8B7355]'}`}>
                    <Clock size={12} /> {age.txt}
                  </span>
                </div>
                <p className="text-[11px] text-[#8B7355] mb-2 capitalize">{k.station} · KOT #{k.kot_number} · order #{k.order_number}</p>
                <div className="space-y-1 mb-3">
                  {k.items.map((it, i) => (
                    <div key={i} className="text-sm text-[#2D1B0E]">
                      <span className="font-semibold">{it.quantity}×</span> {it.name}
                      {it.notes && <span className="block text-[11px] text-[#8B7355] ml-4">— {it.notes}</span>}
                    </div>
                  ))}
                </div>
                <button onClick={() => bump(k)}
                  className="w-full py-2 rounded-lg text-sm font-medium bg-[#af4408] hover:bg-[#8a3506] text-white capitalize">
                  {flow ? flow.label : 'Done'}{!flow ? '' : ''}
                </button>
                <p className="text-[10px] text-center text-[#8B7355] mt-1 capitalize">status: {k.status}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
