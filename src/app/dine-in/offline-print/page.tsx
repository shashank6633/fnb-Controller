'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { probeBridge, bridgePrint, bridgeStatus, getBridgeUrl, setBridgeUrl, type BridgeHealth, type PrinterStatus } from '@/lib/offline-print/bridge-client';
import { counts as outboxCounts, retryFailed, drainOutbox, ensureDrainLoop } from '@/lib/offline-print/outbox';
import {
  Printer, Plus, Trash2, Loader2, X, Wifi, WifiOff, RefreshCw, Save,
  CheckCircle2, XCircle, FlaskConical, ChevronDown, ChevronRight, Download,
} from 'lucide-react';

interface Station {
  id: string;
  name: string;
  role: 'bill' | 'kot';
  station: string;
  transport: 'ip' | 'usb';
  target: string;
  paper_width: number;
  copies: number;
  is_active: number;
  floor?: string;
  backup_target?: string;
  kind?: 'food' | 'bar';
  is_master?: number;
}

interface Job {
  id: string; station_name?: string; doc_type: string; source: string;
  status: string; last_error?: string; created_at: string;
}

const blankForm = { id: '', name: '', role: 'kot' as 'kot' | 'bill', station: '', transport: 'ip' as 'ip' | 'usb', target: '', paper_width: 48, copies: 1, floor: '', backup_target: '', kind: 'food' as 'food' | 'bar', is_master: false, mirror_to_master: true };

export default function OfflinePrintPage() {
  const [stations, setStations] = useState<Station[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [probing, setProbing] = useState(true);
  const [bridgeUrl, setBridgeUrlState] = useState('');
  const [form, setForm] = useState<typeof blankForm>(blankForm);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [queue, setQueue] = useState({ pending: 0, failed: 0, printed: 0 });
  const [pstatus, setPstatus] = useState<Record<string, PrinterStatus | null>>({});
  const [checkingPrinters, setCheckingPrinters] = useState(false);
  const [menuStations, setMenuStations] = useState<{ station: string; item_count: number; has_printer: boolean; printer_id: string | null; printer_name: string | null; kind: string; mirror: boolean }[]>([]);
  const [tableZones, setTableZones] = useState<string[]>([]);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  // Counter PC offline address — captains open this on their tablet during an
  // internet outage so KOTs still print. Stored in settings under 'counter_offline_url'.
  const [counterOfflineUrl, setCounterOfflineUrl] = useState('');
  const [savingOfflineUrl, setSavingOfflineUrl] = useState(false);

  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 4000); };

  const loadStations = useCallback(async () => {
    const r = await api('/api/dine-in/offline-print/stations');
    if (r.ok) setStations((await r.json()).stations || []);
  }, []);
  const loadJobs = useCallback(async () => {
    const r = await api('/api/dine-in/offline-print/jobs?limit=20');
    if (r.ok) setJobs((await r.json()).jobs || []);
  }, []);
  const loadMenuStations = useCallback(async () => {
    const r = await api('/api/dine-in/offline-print/menu-stations');
    if (r.ok) { const j = await r.json(); setMenuStations(j.stations || []); setTableZones(j.zones || []); }
  }, []);
  const toggleMirror = async (printerId: string, next: boolean) => {
    await api(`/api/dine-in/offline-print/stations/${printerId}`, { method: 'PATCH', body: { mirror_to_master: next } });
    await loadMenuStations(); await loadStations();
  };
  const checkBridge = useCallback(async () => {
    setProbing(true);
    setHealth(await probeBridge());
    setProbing(false);
  }, []);
  const refreshQueue = useCallback(async () => { try { setQueue(await outboxCounts()); } catch { /* idb unavailable */ } }, []);

  useEffect(() => {
    setBridgeUrlState(getBridgeUrl());
    // Load the saved counter offline address (settings key 'counter_offline_url').
    fetch('/api/settings?key=counter_offline_url')
      .then((r) => r.json())
      .then((d) => setCounterOfflineUrl(d?.value || ''))
      .catch(() => {});
    loadStations(); loadJobs(); loadMenuStations(); checkBridge(); refreshQueue();
    ensureDrainLoop();
    // Auto-reconnect: silently re-probe the bridge every 4s (no "Checking…"
    // flicker), so when the bridge starts/restarts the page connects itself —
    // the operator never has to click Refresh.
    const t = setInterval(() => { refreshQueue(); probeBridge().then(setHealth); }, 4000);
    return () => clearInterval(t);
  }, [loadStations, loadJobs, loadMenuStations, checkBridge, refreshQueue]);

  const retryQueue = async () => {
    await retryFailed();
    const r = await drainOutbox();
    await refreshQueue(); await loadJobs();
    flash(r.printed > 0, r.printed > 0 ? `Retried — ${r.printed} printed.` : 'Nothing printed (printer/bridge still unreachable).');
  };

  // Auto-check printer status once the bridge is connected and stations are loaded.
  useEffect(() => { if (health && stations.length) checkPrinters(stations); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [health, stations.length]);

  // Live status of every IP printer (paper/cover/reachable) via the local bridge.
  const checkPrinters = useCallback(async (rows?: Station[]) => {
    const list = (rows || stations).filter((s) => s.transport === 'ip' && s.is_active);
    if (list.length === 0) return;
    setCheckingPrinters(true);
    const entries = await Promise.all(list.map(async (s) => [s.id, await bridgeStatus(s.target)] as const));
    setPstatus((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    setCheckingPrinters(false);
  }, [stations]);

  const saveBridgeUrl = () => { setBridgeUrl(bridgeUrl); checkBridge(); flash(true, 'Bridge address saved.'); };

  // Persist the counter offline address via the shared settings API (same
  // pattern as every other setting on the app).
  const saveCounterOfflineUrl = async () => {
    setSavingOfflineUrl(true);
    try {
      const r = await api('/api/settings', { method: 'PUT', body: { key: 'counter_offline_url', value: counterOfflineUrl.trim() } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
      flash(true, 'Counter offline address saved.');
    } catch (e: any) { flash(false, e.message || 'Save failed.'); }
    finally { setSavingOfflineUrl(false); }
  };

  const openNew = () => { setForm(blankForm); setShowForm(true); };
  const openNewForStation = (station: string) => {
    setForm({ ...blankForm, role: 'kot', station, name: `${station.charAt(0).toUpperCase() + station.slice(1)} printer` });
    setShowForm(true);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const openEdit = (s: Station) => {
    setForm({ id: s.id, name: s.name, role: s.role, station: s.station || '', transport: s.transport, target: s.target, paper_width: s.paper_width, copies: s.copies, floor: (s as any).floor || '', backup_target: (s as any).backup_target || '', kind: ((s as any).kind === 'bar' ? 'bar' : 'food'), is_master: !!(s as any).is_master, mirror_to_master: (s as any).mirror_to_master === undefined ? true : !!(s as any).mirror_to_master });
    setShowForm(true);
  };

  const saveStation = async () => {
    if (!form.name.trim()) return flash(false, 'Name is required.');
    if (!form.target.trim()) return flash(false, 'Printer target (IP or printer name) is required.');
    setSaving(true);
    try {
      const body = { name: form.name, role: form.role, station: form.station, transport: form.transport, target: form.target, paper_width: form.paper_width, copies: form.copies, floor: form.floor, backup_target: form.backup_target, kind: form.kind, is_master: form.is_master, mirror_to_master: form.mirror_to_master };
      const r = form.id
        ? await api(`/api/dine-in/offline-print/stations/${form.id}`, { method: 'PATCH', body })
        : await api('/api/dine-in/offline-print/stations', { method: 'POST', body });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || 'Save failed');
      setShowForm(false); setForm(blankForm); await loadStations(); await loadMenuStations();
      flash(true, 'Printer saved.');
    } catch (e: any) { flash(false, e.message); }
    finally { setSaving(false); }
  };

  const deleteStation = async (s: Station) => {
    if (!confirm(`Delete printer "${s.name}"?`)) return;
    const r = await api(`/api/dine-in/offline-print/stations/${s.id}`, { method: 'DELETE' });
    if (r.ok) { await loadStations(); await loadMenuStations(); flash(true, 'Deleted.'); } else flash(false, 'Delete failed.');
  };

  const sampleDoc = (s: Station) => {
    const width = s.paper_width === 32 ? 32 : 48;
    if (s.role === 'bill') {
      return {
        type: 'bill' as const, width,
        doc: {
          type: 'bill', shopName: 'AKAN', gstin: '36ABCDE1234F1Z5', billNo: 'TEST',
          table: '12', server: 'Test',
          items: [
            { name: 'Paneer Tikka', qty: 2, price: 320 },
            { name: 'Butter Naan', qty: 4, price: 60 },
          ],
          subtotal: 880, tax: [{ label: 'CGST 2.5%', amount: 22 }, { label: 'SGST 2.5%', amount: 22 }],
          total: 924, footer: 'TEST BILL — thank you!',
        },
      };
    }
    return {
      type: 'kot' as const, width,
      doc: {
        type: 'kot', station: s.station || s.name, table: '12', orderRef: 'TEST', server: 'Test',
        items: [
          { qty: 2, name: 'Paneer Tikka', notes: 'extra spicy' },
          { qty: 1, name: 'Angara Kebab' },
        ],
        note: 'TEST PRINT',
      },
    };
  };

  const testPrint = async (s: Station) => {
    setTestingId(s.id);
    const { width, doc } = sampleDoc(s);
    const jobId = `test_${Date.now()}`;
    let result: { ok: boolean; error?: string } = { ok: false, error: 'bridge unreachable' };
    try {
      result = await bridgePrint({ jobId, printer: { transport: s.transport, target: s.target, width: (width === 32 ? 32 : 48) }, doc: doc as any });
    } catch (e: any) { result = { ok: false, error: e.message }; }
    // Log the attempt (best-effort; ignore if server unreachable).
    api('/api/dine-in/offline-print/jobs', {
      method: 'POST',
      body: { id: jobId, station_id: s.id, doc_type: s.role, source: 'test', status: result.ok ? 'printed' : 'failed', attempts: 1, last_error: result.error || '' },
    }).then(() => loadJobs()).catch(() => {});
    flash(result.ok, result.ok ? `Test ${s.role.toUpperCase()} sent to "${s.name}".` : `Failed: ${result.error}`);
    setTestingId(null);
  };

  const inputCls = 'bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm text-[#2D1B0E]';

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-[#af4408]/10 rounded-lg"><Printer className="w-6 h-6 text-[#af4408]" /></div>
        <div>
          <h1 className="text-2xl font-bold text-[#af4408]">KOT &amp; Bill Printers</h1>
          <p className="text-sm text-[#8B7355]">Offline thermal printing via the local bridge — USB &amp; network printers, KOTs &amp; bills.</p>
        </div>
      </div>

      {/* Bridge status */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            {probing ? <Loader2 className="w-5 h-5 animate-spin text-[#8B7355]" />
              : health ? <Wifi className="w-5 h-5 text-green-600" /> : <WifiOff className="w-5 h-5 text-red-500" />}
            <div>
              <p className="font-semibold text-[#2D1B0E]">
                {probing ? 'Checking bridge…' : health ? 'Print bridge connected' : 'Print bridge not connected'}
              </p>
              <p className="text-xs text-[#8B7355]">
                {health ? `v${health.version} · ${health.platform} · up ${health.uptimeSec}s` : `Trying ${getBridgeUrl()} every few seconds — start the bridge on this counter PC and it will connect automatically. See the steps below.`}
              </p>
            </div>
          </div>
          <button onClick={checkBridge} className="flex items-center gap-2 text-[#af4408] hover:bg-[#af4408]/10 px-3 py-2 rounded-lg text-sm font-medium">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <input value={bridgeUrl} onChange={(e) => setBridgeUrlState(e.target.value)} placeholder="http://localhost:9920" className={`${inputCls} flex-1`} />
          <button onClick={saveBridgeUrl} className="flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white px-3 py-2 rounded-lg text-sm font-medium"><Save className="w-4 h-4" /> Set</button>
        </div>
      </div>

      {/* Counter PC offline address — the LAN URL captains navigate to when the
          internet is down, so KOTs still print through this counter's bridge. */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-5">
        <label className="block">
          <span className="font-semibold text-[#2D1B0E]">Counter PC offline address</span>
          <p className="text-xs text-[#8B7355] mt-0.5 mb-2">Captains open this on their tablet when the internet is down, so KOTs still print.</p>
          <div className="flex items-center gap-2">
            <input
              value={counterOfflineUrl}
              onChange={(e) => setCounterOfflineUrl(e.target.value)}
              placeholder="http://192.168.1.10:9920/offline"
              className={`${inputCls} flex-1`}
            />
            <button onClick={saveCounterOfflineUrl} disabled={savingOfflineUrl}
              className="flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white px-3 py-2 rounded-lg text-sm font-medium">
              {savingOfflineUrl ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
            </button>
          </div>
        </label>
      </div>

      {/* Print queue (offline outbox) */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="font-semibold text-[#2D1B0E]">Print queue</p>
          <p className="text-xs text-[#8B7355]">
            {queue.pending === 0 && queue.failed === 0
              ? 'Nothing waiting — all prints went through.'
              : <>
                  {queue.pending > 0 && <span className="text-amber-600 font-medium">{queue.pending} waiting</span>}
                  {queue.pending > 0 && queue.failed > 0 && ' · '}
                  {queue.failed > 0 && <span className="text-red-600 font-medium">{queue.failed} failed</span>}
                  {' '}— queued prints retry automatically.
                </>}
          </p>
        </div>
        <button onClick={retryQueue} disabled={queue.pending === 0 && queue.failed === 0}
          className="flex items-center gap-2 text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 disabled:opacity-40 px-3 py-2 rounded-lg text-sm font-medium">
          <RefreshCw className="w-4 h-4" /> Retry now
        </button>
      </div>

      {/* Setup / troubleshooter — auto-opens when the bridge isn't connected */}
      <div className={`bg-white border rounded-xl ${!probing && !health ? 'border-red-300' : 'border-[#E8D5C4]'}`}>
        <button onClick={() => setShowHelp(!showHelp)} className="w-full flex items-center justify-between p-4 text-left">
          <span className="font-semibold text-[#2D1B0E]">{!probing && !health ? 'Bridge not connected — how to fix it' : 'Start / troubleshoot the print bridge'}</span>
          {(showHelp || (!probing && !health)) ? <ChevronDown className="w-5 h-5 text-[#8B7355]" /> : <ChevronRight className="w-5 h-5 text-[#8B7355]" />}
        </button>
        {(showHelp || (!probing && !health)) && (
          <div className="px-4 pb-4 text-sm text-[#6B5744] space-y-3">
            {/* Troubleshooter — the two checks that fix 90% of "not connected" */}
            <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 space-y-2">
              <p className="text-xs text-[#8B7355]">This page reconnects on its own — the moment the bridge runs on this PC, the status above turns green. No need to click Refresh.</p>
              <p className="font-medium text-[#2D1B0E]">1. Are you on the counter PC?</p>
              <p>The bridge is <b>localhost</b> — it only answers on the exact PC wired to the printers. On a tablet or any other computer this will always say “not connected”, and that’s fine: only the counter PC needs it (the captain tablet prints <i>through</i> it).</p>
              <p className="font-medium text-[#2D1B0E]">2. Is the bridge program running?</p>
              <p>On <i>this</i> PC, open the health check. If you see version text, it’s running (this page will connect within seconds). If it won’t open, the bridge isn’t running — start it below.</p>
              <a href={`${getBridgeUrl()}/health`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 px-3 py-1.5 rounded-lg text-xs font-medium no-underline"><Wifi className="w-3.5 h-3.5" /> Open bridge health check ({getBridgeUrl()}/health)</a>
            </div>

            {/* How the offline KOT system works — plain-English overview + one-time setup */}
            <div className="bg-[#EFF6F1] border border-[#CFE6D6] rounded-lg p-3 space-y-2">
              <p className="font-semibold text-[#1F5136] flex items-center gap-1.5"><WifiOff className="w-4 h-4" /> How KOTs keep printing when the internet is down</p>
              <p><b>Normally</b> a KOT travels: captain tablet → the cloud → <b>this counter PC</b> → printer. The first two steps use the internet.</p>
              <p><b>If the internet drops</b> (but your WiFi router is still on): captains tap <b>“Open Offline Kitchen Mode”</b> on their tablet — this counter PC then serves them a small ordering page <i>over WiFi</i>, and KOTs print straight to the kitchen. Offline tickets are numbered <code className="bg-white px-1 rounded">L001</code>, <code className="bg-white px-1 rounded">L002</code>…</p>
              <p><b>When the internet returns</b>, this counter PC <b>automatically syncs</b> those tickets into the system as normal orders (nothing prints twice). Bills are made online as usual — offline mode is for KOTs only.</p>
              <div className="bg-white/70 rounded-md p-2.5 mt-1">
                <p className="font-medium text-[#1F5136] mb-1">One-time setup</p>
                <ol className="list-decimal ml-4 space-y-0.5">
                  <li>Keep the bridge running as the always-on service (see below).</li>
                  <li>Find this PC’s address: open <b>Command Prompt</b>, run <code className="bg-[#FFF1E3] px-1 rounded">ipconfig</code>, note the <b>IPv4 Address</b> (e.g. <code className="bg-[#FFF1E3] px-1 rounded">192.168.1.10</code>).</li>
                  <li>Put it in <b>“Counter PC offline address”</b> at the top of this page as <code className="bg-[#FFF1E3] px-1 rounded break-all">http://192.168.1.10:9920/offline</code> and <b>Save</b>.</li>
                  <li><b>Bookmark</b> that same link on each captain tablet’s home screen.</li>
                </ol>
              </div>
              <p className="text-xs text-[#5C7A67]"><b>Good to know:</b> offline mode rides out an <i>internet/ISP</i> outage — it still needs the local <b>WiFi router</b> to be on. Keep the router, this PC and the printer on a small <b>UPS</b> so a short power/internet blip never stops the kitchen.</p>
            </div>

            <p className="font-medium text-[#2D1B0E]">Start it now (quick)</p>
            <p>On the counter PC, double-click <code className="bg-[#FFF1E3] px-1 rounded">print-bridge.bat</code> → a black window says “listening on … 9920” → keep it open. This page turns green within a few seconds.</p>
            <div className="flex flex-wrap gap-2 my-1">
              <a href="/print-bridge.bat" download className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white px-3 py-2 rounded-lg text-xs font-medium no-underline"><Download className="w-4 h-4" /> Download launcher (.bat)</a>
              <a href="/print-bridge.mjs" download className="inline-flex items-center gap-1.5 text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 px-3 py-2 rounded-lg text-xs font-medium no-underline"><Download className="w-4 h-4" /> Download bridge (.mjs)</a>
              <a href="/offline-pos.html" download className="inline-flex items-center gap-1.5 text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 px-3 py-2 rounded-lg text-xs font-medium no-underline"><Download className="w-4 h-4" /> Download offline page (.html)</a>
            </div>
            <p className="text-xs text-[#8B7355]">First time? Install <b>Node.js LTS</b> from <code className="bg-[#FFF1E3] px-1 rounded">nodejs.org</code>, put <b>all three</b> files above in one folder (e.g. <code className="bg-[#FFF1E3] px-1 rounded">C:\fnb-bridge\</code>), then double-click the .bat. <i>The .html is the offline kitchen page — it must sit in the same folder as the bridge.</i> (The PowerShell installer below fetches all of them automatically.)</p>

            <p className="font-medium text-[#2D1B0E] mt-2">Make it permanent — auto-start on every boot (recommended)</p>
            <p>Run this <b>once</b> in PowerShell <b>(as Administrator)</b>. It installs Node if missing, runs the bridge as an always-on Windows service, and auto-updates daily — the counter never has to launch anything again:</p>
            <pre className="bg-[#2D1B0E] text-[#F5E9DC] text-[11px] rounded-lg p-2 overflow-x-auto whitespace-pre-wrap">{`powershell -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; irm ${typeof window !== 'undefined' ? window.location.origin : ''}/install-bridge-service.ps1 -OutFile $env:TEMP\\i.ps1; & $env:TEMP\\i.ps1"`}</pre>
            <p className="text-xs text-[#8B7355]"><b>If it says “Unable to connect to the remote server”:</b> let the browser download it instead — open <code className="bg-[#FFF1E3] px-1 rounded break-all">{typeof window !== 'undefined' ? window.location.origin : ''}/install-bridge-service.ps1</code> in this browser (choose <b>Keep</b> if warned), then in an <b>admin</b> PowerShell run <code className="bg-[#FFF1E3] px-1 rounded break-all">{'powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\\Downloads\\install-bridge-service.ps1"'}</code>. Wait for <b>HEALTHY — v2.2.0</b>.</p>

            <p className="text-xs text-[#8B7355] mt-1">Add printers below. <b>USB</b>: share it in Windows, enter <code className="bg-[#FFF1E3] px-1 rounded">\\localhost\POS80</code>. <b>Network</b>: enter <code className="bg-[#FFF1E3] px-1 rounded">192.168.1.50:9100</code>. Everything is on-site, so printing keeps working even if the internet drops.</p>
          </div>
        )}
      </div>

      {/* Kitchen/bar stations from the menu → printer mapping */}
      {menuStations.length > 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-semibold text-[#2D1B0E]">Kitchen &amp; bar stations</h2>
            {menuStations.some((s) => !s.has_printer)
              ? <span className="text-xs text-amber-600 font-medium">{menuStations.filter((s) => !s.has_printer).length} need a printer</span>
              : <span className="text-xs text-green-600 font-medium">all mapped ✓</span>}
          </div>
          <p className="text-xs text-[#8B7355] mb-3">Every station on your menu must point to a KOT printer so a punched item prints there. Green = mapped to a printer.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {menuStations.map((s) => (
              <div key={s.station} className="flex items-center justify-between gap-2 border border-[#E8D5C4] rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block w-2 h-2 rounded-full ${s.has_printer ? 'bg-green-500' : 'bg-amber-400'}`}></span>
                    <span className="font-medium text-[#2D1B0E] capitalize">{s.station}</span>
                    <span className="text-xs text-[#8B7355]">· {s.item_count} item{s.item_count === 1 ? '' : 's'}</span>
                  </div>
                  <p className="text-[11px] text-[#8B7355] mt-0.5 truncate">{s.has_printer ? `→ ${s.printer_name}` : 'no printer — items fall back to your default KOT printer'}</p>
                </div>
                {s.has_printer ? (
                  <button
                    onClick={() => s.printer_id && toggleMirror(s.printer_id, !s.mirror)}
                    title={s.mirror ? 'Also prints to Main Kitchen — click to stop' : 'Not sent to Main Kitchen — click to enable'}
                    className={`shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border ${s.mirror ? 'bg-purple-100 text-purple-700 border-purple-200' : 'text-[#8B7355] border-[#E8D5C4] hover:bg-[#FFF1E3]'}`}>
                    {s.mirror ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />} Main
                  </button>
                ) : (
                  <button onClick={() => openNewForStation(s.station)} className="shrink-0 flex items-center gap-1 text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 px-2.5 py-1 rounded-lg text-xs font-medium"><Plus className="w-3.5 h-3.5" /> Printer</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stations */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-[#2D1B0E]">Printers</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => checkPrinters()} disabled={checkingPrinters} className="flex items-center gap-2 text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 disabled:opacity-50 px-3 py-2 rounded-lg text-sm font-medium">
              {checkingPrinters ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Check status
            </button>
            <button onClick={openNew} className="flex items-center gap-2 bg-[#af4408] hover:bg-[#8a3506] text-white px-4 py-2 rounded-lg text-sm font-medium"><Plus className="w-4 h-4" /> Add printer</button>
          </div>
        </div>

        {showForm && (
          <div className="border border-[#D4B896] rounded-lg p-4 mb-4 bg-[#FFF8F1] space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-medium text-[#2D1B0E]">{form.id ? 'Edit printer' : 'New printer'}</p>
              <button onClick={() => { setShowForm(false); setForm(blankForm); }}><X className="w-4 h-4 text-[#8B7355]" /></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-xs text-[#8B7355]">Name
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Counter bill / Tandoor KOT" className={inputCls} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[#8B7355]">Prints
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as any })} className={inputCls}>
                  <option value="kot">KOT (kitchen ticket)</option>
                  <option value="bill">Bill (customer receipt)</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-[#8B7355]">Connection
                <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as any })} className={inputCls}>
                  <option value="ip">Network (IP)</option>
                  <option value="usb">USB</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-[#8B7355]">{form.transport === 'ip' ? 'Printer IP (and :port)' : 'OS printer / share name'}
                <input value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder={form.transport === 'ip' ? '192.168.1.50:9100' : 'POS-80  or  \\localhost\\POS80'} className={inputCls} />
              </label>
              {form.role === 'kot' && (
                <label className="flex flex-col gap-1 text-xs text-[#8B7355]">Kitchen station (must match the menu)
                  <input value={form.station} list="menu-stations" onChange={(e) => setForm({ ...form, station: e.target.value })} placeholder="tandoor / bar / pan-asian" className={inputCls} />
                  <datalist id="menu-stations">{menuStations.map((s) => <option key={s.station} value={s.station} />)}</datalist>
                </label>
              )}
              <label className="flex flex-col gap-1 text-xs text-[#8B7355]">Paper width
                <select value={form.paper_width} onChange={(e) => setForm({ ...form, paper_width: Number(e.target.value) })} className={inputCls}>
                  <option value={48}>80mm</option>
                  <option value={32}>58mm</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-[#8B7355]">Floor (from your table zones)
                <select value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} className={inputCls}>
                  <option value="">All floors / none</option>
                  {tableZones.map((z) => <option key={z} value={z}>{z}</option>)}
                  {form.floor && !tableZones.includes(form.floor) && <option value={form.floor}>{form.floor} (not a table zone)</option>}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-[#8B7355]">Backup printer (optional, IP)
                <input value={form.backup_target} onChange={(e) => setForm({ ...form, backup_target: e.target.value })} placeholder="192.168.1.51:9100 — used if primary is down" className={inputCls} />
              </label>
              {form.role === 'kot' && (
                <label className="flex flex-col gap-1 text-xs text-[#8B7355]">Group
                  <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'food' | 'bar' })} className={inputCls}>
                    <option value="food">Food (kitchen)</option>
                    <option value="bar">Bar (drinks)</option>
                  </select>
                </label>
              )}
            </div>
            {form.role === 'kot' && (
              <label className="flex items-start gap-2 text-xs text-[#6B5744] bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2">
                <input type="checkbox" checked={form.is_master} onChange={(e) => setForm({ ...form, is_master: e.target.checked })} className="mt-0.5" />
                <span><b>Main / expediter printer</b> (kitchen counter) — also prints <b>one consolidated ticket of every {form.kind === 'bar' ? 'drink' : 'food'} item</b> here for cross-checking, in addition to each sub-station printer. Leave the <i>Kitchen station</i> blank for this one.</span>
              </label>
            )}
            {form.role === 'kot' && !form.is_master && (
              <label className="flex items-start gap-2 text-xs text-[#6B5744] bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2">
                <input type="checkbox" checked={form.mirror_to_master} onChange={(e) => setForm({ ...form, mirror_to_master: e.target.checked })} className="mt-0.5" />
                <span><b>Send duplicate KOT to Main Kitchen</b> — this station&apos;s tickets are also mirrored to the Main/expediter printer. <b>Turn this OFF</b> for stations on other floors or separate kitchens (e.g. a rooftop Pizza or Tandoor) that shouldn&apos;t show at the main counter.</span>
              </label>
            )}
            <div className="flex gap-2">
              <button onClick={saveStation} disabled={saving} className="flex items-center gap-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
              </button>
              <button onClick={() => { setShowForm(false); setForm(blankForm); }} className="px-4 py-2 rounded-lg text-sm text-[#6B5744] hover:bg-[#FFF1E3]">Cancel</button>
            </div>
          </div>
        )}

        {stations.length === 0 ? (
          <p className="text-sm text-[#8B7355] py-6 text-center">No printers yet. Add your bill printer and kitchen KOT printers above.</p>
        ) : (
          <div className="space-y-2">
            {stations.map((s) => {
              const ps = pstatus[s.id];
              const st = s.transport !== 'ip'
                ? { color: 'bg-gray-300', label: 'USB' }
                : !ps ? { color: 'bg-gray-300', label: '—' }
                : !ps.reachable ? { color: 'bg-red-500', label: 'offline' }
                : ps.paperOut ? { color: 'bg-red-500', label: 'paper out' }
                : ps.coverOpen ? { color: 'bg-red-500', label: 'cover open' }
                : ps.error ? { color: 'bg-red-500', label: 'error' }
                : ps.paperLow ? { color: 'bg-amber-400', label: 'paper low' }
                : { color: 'bg-green-500', label: 'ready' };
              return (
              <div key={s.id} className="flex items-center justify-between gap-3 border border-[#E8D5C4] rounded-lg px-4 py-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span title={st.label} className={`inline-block w-2.5 h-2.5 rounded-full ${st.color}`}></span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${s.role === 'bill' ? 'bg-emerald-100 text-emerald-700' : 'bg-[#af4408]/10 text-[#af4408]'}`}>{s.role.toUpperCase()}</span>
                    {s.is_master ? <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-purple-100 text-purple-700">MAIN · {s.kind === 'bar' ? 'BAR' : 'KITCHEN'}</span> : null}
                    <span className="font-medium text-[#2D1B0E]">{s.name}</span>
                    {s.station ? <span className="text-xs text-[#8B7355]">· {s.station}</span> : null}
                    {s.floor ? <span className="text-xs text-[#8B7355]">· floor {s.floor}</span> : null}
                    <span className="text-[10px] text-[#8B7355]">{st.label}</span>
                  </div>
                  <p className="text-xs text-[#8B7355] mt-0.5">{s.transport === 'ip' ? 'Network' : 'USB'} · {s.target} · {s.paper_width === 32 ? '58mm' : '80mm'}{s.backup_target ? ` · backup ${s.backup_target}` : ''}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => testPrint(s)} disabled={testingId === s.id} className="flex items-center gap-1.5 text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 disabled:opacity-50 px-3 py-1.5 rounded-lg text-xs font-medium">
                    {testingId === s.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />} Test {s.role}
                  </button>
                  <button onClick={() => openEdit(s)} className="text-xs text-[#6B5744] hover:bg-[#FFF1E3] px-3 py-1.5 rounded-lg">Edit</button>
                  <button onClick={() => deleteStation(s)} className="text-red-500 hover:bg-red-50 p-1.5 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            ); })}
          </div>
        )}
      </div>

      {/* Recent jobs */}
      {jobs.length > 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-5">
          <h2 className="font-semibold text-[#2D1B0E] mb-3">Recent print attempts</h2>
          <div className="space-y-1.5">
            {jobs.map((j) => (
              <div key={j.id} className="flex items-center gap-2 text-sm">
                {j.status === 'printed' ? <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" /> : <XCircle className="w-4 h-4 text-red-500 shrink-0" />}
                <span className="text-[#2D1B0E]">{j.doc_type?.toUpperCase()}</span>
                <span className="text-[#8B7355]">{j.station_name || ''} · {j.source}</span>
                {j.status !== 'printed' && j.last_error ? <span className="text-red-500 text-xs truncate">— {j.last_error}</span> : null}
                <span className="ml-auto text-xs text-[#8B7355]">{new Date(j.created_at + 'Z').toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-lg text-sm text-white ${toast.ok ? 'bg-green-600' : 'bg-red-600'}`}>{toast.msg}</div>
      )}
    </div>
  );
}
