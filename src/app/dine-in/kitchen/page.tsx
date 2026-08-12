'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import { ChefHat, Clock, Wifi, WifiOff, AlertTriangle, Check, Undo2 } from 'lucide-react';
import TabScroller from '@/components/TabScroller';

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
/** Server's reading of a just-served ticket's undo window (src/lib/kot-completion.ts). */
interface UndoState {
  kot_id: string; undoable: boolean; remaining_sec: number; window_sec: number;
  reason: string; message?: string; status: string;
  kot_number: number | null; station: string; table_number: string | null;
  order_type: string; order_number: number | null;
}

/**
 * Which tickets this screen is still offering an undo for.
 *
 * PERSISTED, because the countdown has to survive an F5 — a chef who mis-taps
 * Served and reflexively reloads must still find the Undo. Only the IDS live
 * here: every time it renders, the remaining seconds come back from
 * GET /api/dine-in/kds/<id>/undo, which derives them from kots.served_at. This
 * browser cannot extend its own window by editing the value, and a stale id
 * simply drops out on the next poll when the server says it is no longer
 * undoable. localStorage is per-screen by design: undo is for the person who
 * just tapped, not a queue for the whole restaurant.
 */
const UNDO_KEY = 'kds_undo_pending_v1';
function readPending(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(UNDO_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, 12) : [];
  } catch { return []; }
}
function writePending(ids: string[]) {
  try { window.localStorage.setItem(UNDO_KEY, JSON.stringify(ids.slice(0, 12))); } catch { /* private mode */ }
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
  const [mySection, setMySection] = useState('');   // Parent Role / Section of the logged-in user
  const [live, setLive] = useState(false);
  const [, setTick] = useState(0);
  const [alerts, setAlerts] = useState<KotAlert[]>([]);
  const [agent, setAgent] = useState<{ online: boolean; watchdog: boolean; secondsAgo: number | null } | null>(null);
  const [undos, setUndos] = useState<UndoState[]>([]);
  const [undoNote, setUndoNote] = useState('');          // refusal copy, straight from the server
  const [canTune, setCanTune] = useState(false);         // manager/admin may change the window
  const [windowDraft, setWindowDraft] = useState('');    // the seconds box, while being edited
  const [windowSaved, setWindowSaved] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const load = useCallback(async (st: string) => {
    try {
      const r = await api(`/api/dine-in/kds?station=${st}&section=${encodeURIComponent(mySection)}`);
      const j = await r.json();
      setKots(j.items || []);
      setStations(j.stations || []);
    } catch (_) {}
  }, [mySection]);

  const loadAlerts = useCallback(async () => {
    try {
      const r = await api('/api/dine-in/kot-alerts?open=1');
      const j = await r.json();
      setAlerts(j.alerts || []);
      setAgent(j.agent || null);
    } catch (_) {}
  }, []);

  async function resolveAlert(id: string) {
    setAlerts((a) => a.filter((x) => x.id !== id)); // optimistic
    try { await api('/api/dine-in/kot-alerts', { method: 'POST', body: { id, resolve: true } }); }
    catch (_) {}
    loadAlerts();
  }

  /**
   * Re-ask the server about every ticket this screen is still offering an undo
   * for. The seconds shown are ALWAYS the ones that just came back — nothing on
   * this page counts down on its own, so a refresh, a backgrounded tab or a
   * fiddled clock all show the same number the server would enforce. A ticket
   * the server no longer calls undoable drops out of the list (and out of
   * localStorage) on this pass. This poll is also what asks the server to post
   * the deferred consume the moment the window closes.
   */
  const refreshUndos = useCallback(async () => {
    const ids = readPending();
    // Nothing pending: clear only if there IS something to clear, so the
    // once-a-second poll doesn't hand React a new empty array every tick.
    if (!ids.length) { setUndos((u) => (u.length ? [] : u)); return; }
    const rows = await Promise.all(ids.map(async (id) => {
      try {
        const r = await api(`/api/dine-in/kds/${id}/undo`);
        if (!r.ok) return null;
        const j = (await r.json()) as UndoState;
        return j && j.undoable ? j : null;
      } catch (_) { return null; }
    }));
    const live = rows.filter((x): x is UndoState => !!x);
    writePending(live.map((x) => x.kot_id));
    setUndos(live);
  }, []);

  async function undoServed(kotId: string) {
    setUndoNote('');
    try {
      const r = await api(`/api/dine-in/kds/${kotId}/undo`, { method: 'POST', body: {} });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setUndoNote(j?.error || 'Could not undo this ticket.');
    } catch (_) {
      setUndoNote('Could not reach the server — the ticket is still served.');
    }
    writePending(readPending().filter((x) => x !== kotId));
    refreshUndos();
    load(station);
  }

  // Initial + on station change: load, (re)connect SSE, with a poll safety net.
  useEffect(() => {
    load(station);
    esRef.current?.close();
    const es = new EventSource(`/api/dine-in/kds/stream?station=${station}&section=${encodeURIComponent(mySection)}`);
    es.onopen = () => setLive(true);
    es.onmessage = () => load(station);          // any kot.new / kot.bumped → refetch
    es.onerror = () => setLive(false);            // browser auto-reconnects; poll covers the gap
    esRef.current = es;
    const poll = setInterval(() => load(station), 10000);
    return () => { es.close(); clearInterval(poll); };
  }, [station, mySection, load]);

  // Seed the section filter from the logged-in user (Kitchen/Bar auto-scopes the
  // board; Service/Maintenance/Store/admin without a section see everything).
  // The same call decides who may retune the undo window: /api/settings PUT is
  // manager/admin only, so anyone else is never shown a control that would 403.
  useEffect(() => {
    api('/api/auth/me').then(r => r.json()).then(d => {
      setMySection(d?.user?.section || '');
      setCanTune(d?.user?.role === 'admin' || d?.user?.role === 'manager');
    }).catch(() => {});
  }, []);

  // The configured window, read once for the label + the manager's edit box.
  useEffect(() => {
    api('/api/settings?key=kot_undo_window_seconds').then(r => r.json()).then(d => {
      const n = Number(d?.value);
      const w = Number.isFinite(n) && n >= 0 ? Math.min(120, Math.round(n)) : 10;
      setWindowSaved(w);
      setWindowDraft(String(w));
    }).catch(() => {});
  }, []);

  // Poll the undo window(s) once a second — see refreshUndos for why the seconds
  // are never counted down locally.
  useEffect(() => {
    refreshUndos();
    const t = setInterval(refreshUndos, 1000);
    return () => clearInterval(t);
  }, [refreshUndos]);

  // Poll unresolved KOT escalations (~10s) — shown as a red banner above the grid.
  useEffect(() => {
    loadAlerts();
    const t = setInterval(loadAlerts, 10000);
    return () => clearInterval(t);
  }, [loadAlerts]);

  // Tick every second so the age timers move.
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  async function bump(k: Kot) {
    setUndoNote('');
    let j: any = null;
    try {
      const r = await api(`/api/dine-in/kds/${k.id}/bump`, { method: 'POST', body: {} });
      j = await r.json().catch(() => null);
      if (!r.ok) setUndoNote(j?.error || 'Could not advance this ticket.');
    } catch (_) {
      setUndoNote('Could not reach the server — the ticket has not moved.');
    }
    // A served bump comes back with the server's own undo state. Remember the
    // ticket so the strip survives a refresh; the seconds always come from the
    // server, never from here.
    if (j?.undo?.undoable) {
      writePending([j.undo.kot_id, ...readPending().filter((x: string) => x !== j.undo.kot_id)]);
      setUndos((u) => [j.undo, ...u.filter((x) => x.kot_id !== j.undo.kot_id)]);
    }
    load(station);
  }

  /** Save a new undo window (manager/admin). Server clamps to 0…120 seconds. */
  async function saveWindow() {
    const n = Math.max(0, Math.min(120, Math.round(Number(windowDraft) || 0)));
    setWindowDraft(String(n));
    try {
      const r = await api('/api/settings', { method: 'PUT', body: { key: 'kot_undo_window_seconds', value: String(n) } });
      if (r.ok) { setWindowSaved(n); setUndoNote(n === 0 ? 'Undo switched off — Served now takes stock off immediately.' : `Undo window saved: ${n} seconds.`); }
      else { const j = await r.json().catch(() => ({})); setUndoNote(j?.error || 'Could not save the undo window.'); }
    } catch (_) {
      setUndoNote('Could not save the undo window.');
    }
  }

  const stationOptions = ['all', ...stations];

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#af4408]/10 rounded-lg"><ChefHat className="w-6 h-6 text-[#af4408]" /></div>
          <div>
            <h1 className="text-2xl font-bold text-[#af4408]">Kitchen Display</h1>
            <p className="text-sm text-[#8B7355]">
              Live order tickets · tap to advance
              {windowSaved !== null && windowSaved > 0 ? ` · Served can be undone for ${windowSaved}s` : ''}
            </p>
          </div>
        </div>
        <span className={`flex items-center gap-1.5 text-xs font-medium ${live ? 'text-green-600' : 'text-amber-600'}`}>
          {live ? <Wifi size={14} /> : <WifiOff size={14} />} {live ? 'Live' : 'Reconnecting…'}
        </span>
      </div>

      <TabScroller className="gap-1.5 mb-4">
        {stationOptions.map((s) => (
          <button key={s} onClick={() => setStation(s)}
            className={`text-xs px-3 py-1.5 rounded-full capitalize ${station === s ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>
            {s === 'all' ? 'All stations' : s}
          </button>
        ))}
      </TabScroller>

      {agent?.watchdog && (
        <div className="mb-4 rounded-xl border-2 border-red-600 bg-red-700 text-white shadow-lg p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={22} className="animate-pulse shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-bold tracking-wide">PRINT AGENT NOT RUNNING — orders are not reaching the printers.</p>
              <p className="text-[13px] text-red-100/90 mt-1">
                Open the Print Agent on the counter PC and leave it running:{' '}
                <span className="font-mono bg-red-900/50 px-1.5 py-0.5 rounded">/print/agent</span>.
                {typeof agent.secondsAgo === 'number'
                  ? ` No dispatcher has checked in for ${agent.secondsAgo >= 120 ? `${Math.round(agent.secondsAgo / 60)} min` : `${agent.secondsAgo}s`}.`
                  : ' No dispatcher has checked in yet.'}
              </p>
            </div>
          </div>
        </div>
      )}

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

      {/* JUST SERVED — the undo window. A served ticket leaves the grid, so this
          strip is the only place it can be taken back from. Every number here
          came from the server on the last poll. */}
      {undos.length > 0 && (
        <div className="mb-4 rounded-xl border-2 border-emerald-500 bg-emerald-50 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white font-bold text-sm">
            <Check size={16} strokeWidth={3} />
            JUST SERVED — undo before stock comes off ({undos.length})
          </div>
          <div className="divide-y divide-emerald-200">
            {undos.map((u) => (
              <div key={u.kot_id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="text-sm font-medium text-[#2D1B0E]">
                  KOT #{u.kot_number ?? '—'}
                  {' — '}
                  {u.table_number ? `TABLE ${u.table_number}` : (u.order_type || 'order').toUpperCase()}
                  {' — served'}
                  <span className="block text-[11px] font-normal text-[#6B5744]">
                    {u.station || 'kitchen'} · order #{u.order_number ?? '—'} · nothing has left stock yet
                  </span>
                </div>
                <button onClick={() => undoServed(u.kot_id)}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-700 text-white hover:bg-emerald-800">
                  <Undo2 size={13} /> Undo ({u.remaining_sec}s)
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {undoNote && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 flex items-start justify-between gap-3">
          <p className="text-sm text-[#7a4a05]">{undoNote}</p>
          <button onClick={() => setUndoNote('')} className="shrink-0 text-xs font-semibold text-[#7a4a05] hover:underline">
            Dismiss
          </button>
        </div>
      )}

      {canTune && (
        <div className="mb-4 rounded-xl border border-[#E8D5C4] bg-white px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-sm font-medium text-[#2D1B0E]">Undo window after Served</span>
          <input
            type="number" min={0} max={120} inputMode="numeric"
            value={windowDraft} onChange={(e) => setWindowDraft(e.target.value)}
            className="w-20 px-2 py-1 rounded-lg border border-[#E8D5C4] text-sm text-[#2D1B0E]"
          />
          <span className="text-sm text-[#6B5744]">seconds</span>
          <button onClick={saveWindow}
            disabled={windowSaved !== null && String(windowSaved) === String(Math.round(Number(windowDraft) || 0))}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#af4408] text-white hover:bg-[#8a3506] disabled:opacity-40 disabled:cursor-not-allowed">
            Save
          </button>
          <span className="text-[11px] text-[#8B7355] basis-full sm:basis-auto">
            {windowSaved === 0
              ? 'Currently OFF — Served takes ingredients off stock immediately.'
              : `Currently ${windowSaved ?? 10}s — ingredients come off stock only after this. Max 120. Set 0 to switch undo off.`}
          </span>
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
                  {k.items.map((it, i) => {
                    // Scanned out at the pass (or already served) → visibly done on
                    // the ticket: struck through + an emerald "out" chip. Without
                    // this a kitchen_sent item looked identical to a fired one.
                    const out = it.status === 'kitchen_sent' || it.status === 'served';
                    return (
                      <div key={i} className={`text-sm ${out ? 'text-[#8B7355]' : 'text-[#2D1B0E]'}`}>
                        <span className={out ? 'line-through decoration-emerald-600/50' : ''}>
                          <span className="font-semibold">{it.quantity}×</span> {it.name}
                        </span>
                        {out && (
                          <span className="ml-1.5 inline-flex items-center gap-0.5 align-middle text-[10px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-1.5 py-px">
                            <Check size={9} strokeWidth={3} /> out
                          </span>
                        )}
                        {it.notes && <span className="block text-[11px] text-[#8B7355] ml-4">— {it.notes}</span>}
                      </div>
                    );
                  })}
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
