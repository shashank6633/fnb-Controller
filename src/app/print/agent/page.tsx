'use client';

/**
 * Print Agent — open this page on the COUNTER PC (the machine running the print
 * bridge). It listens to every fired KOT and requested bill over the KDS SSE
 * stream and prints them through the local bridge/outbox.
 *
 * This is what lets Captain tablets (which can't reach the on-counter bridge)
 * still print: the tablet only fires the order; this page does the printing.
 * Leave it open on the counter all service. Dedup is by stable job id in the
 * outbox, so a reconnect/replay never double-prints.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { printFiredKots, printBill } from '@/lib/offline-print/print';
import { probeBridge, getBridgeUrl, setBridgeUrl, type BridgeHealth } from '@/lib/offline-print/bridge-client';
import { ensureDrainLoop, drainOutbox, counts, retryFailed, prunePrinted } from '@/lib/offline-print/outbox';
import { Printer, Wifi, WifiOff, CheckCircle2, AlertTriangle, RefreshCw, Receipt, ChefHat, Settings, ArrowLeft } from 'lucide-react';

interface LogRow { id: string; at: string; kind: 'KOT' | 'BILL'; label: string; detail: string; }

export default function PrintAgent() {
  const [live, setLive] = useState(false);
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [queue, setQueue] = useState({ pending: 0, failed: 0, printed: 0 });
  const [log, setLog] = useState<LogRow[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [showCfg, setShowCfg] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const seen = useRef<Set<string>>(new Set());

  const pushLog = useCallback((row: Omit<LogRow, 'at'>) => {
    const at = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
    setLog((l) => [{ ...row, at }, ...l].slice(0, 80));
  }, []);

  const refreshQueue = useCallback(async () => { try { setQueue(await counts()); } catch {} }, []);

  // Print a KOT once. Both the live stream and the backup poll call this; the
  // `seen` set (this session) + the outbox (stable id, persisted) dedup, so a
  // KOT never prints twice no matter how many times it's delivered.
  const printKot = useCallback(async (k: any) => {
    if (!k || seen.current.has(`kot:${k.id}`)) return;
    seen.current.add(`kot:${k.id}`);
    await printFiredKots([k]).catch(() => {});
    pushLog({ id: k.id, kind: 'KOT', label: `KOT #${k.kot_number ?? '—'} · ${k.station || 'kitchen'}`,
      detail: `${k.table_number ? `Table ${k.table_number}` : k.order_type || ''} · ${(k.items || []).reduce((s: number, i: any) => s + (i.quantity || 0), 0)} items` });
    refreshQueue();
  }, [pushLog, refreshQueue]);

  // Live stream (instant) + a backup poll (catches anything the stream misses —
  // nginx buffering, pm2 cluster, a dropped connection, or the agent opening
  // mid-service). This makes printing work even when SSE doesn't reach us.
  useEffect(() => {
    ensureDrainLoop();
    setUrlInput(getBridgeUrl());

    const es = new EventSource('/api/dine-in/kds/stream?station=all');
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = async (e) => {
      let evt: any;
      try { evt = JSON.parse(e.data); } catch { return; }
      if (evt?.type === 'kot.new' && evt.kot) {
        printKot(evt.kot);
      } else if (evt?.type === 'bill.print' && evt.bill) {
        const bl = evt.bill;
        const key = `bill:${bl.id}:${bl.total}`;
        if (seen.current.has(key)) return;
        seen.current.add(key);
        const res = await printBill(bl).catch(() => ({ ok: false, reason: 'error' }));
        pushLog({ id: bl.id, kind: 'BILL', label: `Bill #${bl.order_number ?? '—'}${bl.table_number ? ` · Table ${bl.table_number}` : ''}`,
          detail: res.ok ? `₹${Math.round(bl.total || 0)}` : `not printed — ${res.reason || 'no bill printer'}` });
        refreshQueue();
      }
    };
    esRef.current = es;

    // Backup poll every 9s — fetch active KOTs and print any not yet seen.
    const poll = async () => {
      try {
        const r = await fetch('/api/dine-in/kds?station=all', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        for (const k of (j.items || [])) await printKot(k);
      } catch { /* offline — try again next tick */ }
    };
    poll();
    const pollTimer = setInterval(poll, 9000);

    return () => { es.close(); clearInterval(pollTimer); };
  }, [printKot, pushLog, refreshQueue]);

  // Poll bridge health + queue + housekeeping.
  useEffect(() => {
    const tick = async () => { setHealth(await probeBridge()); refreshQueue(); prunePrinted().catch(() => {}); };
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [refreshQueue]);

  async function onRetry() { await retryFailed(); await drainOutbox(); refreshQueue(); }
  function saveUrl() { setBridgeUrl(urlInput); setShowCfg(false); probeBridge().then(setHealth); }

  const bridgeOk = !!health?.ok;

  return (
    <div className="min-h-screen bg-[#0F0A06] text-white">
      <div className="max-w-3xl mx-auto p-4">
        {/* Header */}
        <header className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Printer className="w-6 h-6 text-[#FF8A4C]" />
            <div>
              <h1 className="font-bold text-lg leading-tight">Print Agent</h1>
              <p className="text-[11px] text-white/50 leading-tight">Keep open on the counter PC — prints captain KOTs &amp; bills</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <a href="/" className="flex items-center gap-1.5 px-3 py-2 text-sm text-white/70 hover:text-white hover:bg-white/10 rounded-lg">
              <ArrowLeft className="w-4 h-4" /> Back to app
            </a>
            <button onClick={() => setShowCfg((s) => !s)} className="p-2 text-white/60 hover:text-white"><Settings className="w-5 h-5" /></button>
          </div>
        </header>

        {/* Status cards */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className={`rounded-2xl p-4 border ${bridgeOk ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-red-500/10 border-red-500/40'}`}>
            <div className="flex items-center gap-2">
              {bridgeOk ? <CheckCircle2 className="w-5 h-5 text-emerald-400" /> : <AlertTriangle className="w-5 h-5 text-red-400" />}
              <span className="font-semibold">Bridge</span>
            </div>
            <p className="text-sm mt-1 text-white/70">{bridgeOk ? `Connected · v${health?.version}` : 'Not reachable'}</p>
            <p className="text-[11px] text-white/40 mt-0.5 truncate">{getBridgeUrl()}</p>
          </div>
          <div className={`rounded-2xl p-4 border ${live ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-amber-500/10 border-amber-500/40'}`}>
            <div className="flex items-center gap-2">
              {live ? <Wifi className="w-5 h-5 text-emerald-400" /> : <WifiOff className="w-5 h-5 text-amber-400" />}
              <span className="font-semibold">Live feed</span>
            </div>
            <p className="text-sm mt-1 text-white/70">{live ? 'Listening for orders' : 'Reconnecting…'}</p>
          </div>
        </div>

        {showCfg && (
          <div className="rounded-2xl p-4 border border-white/10 bg-white/5 mb-4">
            <label className="text-xs text-white/60">Bridge URL (this machine)</label>
            <div className="flex gap-2 mt-1">
              <input value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
                className="flex-1 bg-black/40 border border-white/15 rounded-lg px-3 py-2 text-sm" placeholder="http://localhost:9920" />
              <button onClick={saveUrl} className="px-4 py-2 bg-[#FF6B35] rounded-lg text-sm font-semibold">Save</button>
            </div>
          </div>
        )}

        {/* Queue */}
        <div className="flex items-center gap-3 mb-4 text-sm">
          <span className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10">Queued <b className="text-amber-300">{queue.pending}</b></span>
          <span className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10">Printed <b className="text-emerald-300">{queue.printed}</b></span>
          {queue.failed > 0 && (
            <button onClick={onRetry} className="px-3 py-1.5 rounded-full bg-red-500/15 border border-red-500/40 text-red-200 flex items-center gap-1.5">
              <RefreshCw className="w-3.5 h-3.5" /> Retry {queue.failed} failed
            </button>
          )}
        </div>

        {/* Log */}
        <div className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
          <div className="px-4 py-2 text-xs font-semibold text-white/50 border-b border-white/10">RECENT PRINTS</div>
          {log.length === 0 ? (
            <p className="px-4 py-10 text-center text-white/40 text-sm">Waiting for the first order…</p>
          ) : (
            <ul className="divide-y divide-white/5 max-h-[50vh] overflow-y-auto">
              {log.map((r, i) => (
                <li key={`${r.id}-${i}`} className="px-4 py-2.5 flex items-center gap-3">
                  {r.kind === 'KOT' ? <ChefHat className="w-4 h-4 text-[#FF8A4C] shrink-0" /> : <Receipt className="w-4 h-4 text-emerald-400 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{r.label}</p>
                    <p className="text-[11px] text-white/40">{r.detail}</p>
                  </div>
                  <span className="text-[11px] text-white/30 tabular-nums">{r.at}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
