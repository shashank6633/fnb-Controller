'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { probeBridge, bridgePrint, getBridgeUrl, setBridgeUrl, type BridgeHealth } from '@/lib/offline-print/bridge-client';
import { counts as outboxCounts, retryFailed, drainOutbox, ensureDrainLoop } from '@/lib/offline-print/outbox';
import {
  Printer, Plus, Trash2, Loader2, X, Wifi, WifiOff, RefreshCw, Save,
  CheckCircle2, XCircle, FlaskConical, ChevronDown, ChevronRight,
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
}

interface Job {
  id: string; station_name?: string; doc_type: string; source: string;
  status: string; last_error?: string; created_at: string;
}

const blankForm = { id: '', name: '', role: 'kot' as 'kot' | 'bill', station: '', transport: 'ip' as 'ip' | 'usb', target: '', paper_width: 48, copies: 1 };

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
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 4000); };

  const loadStations = useCallback(async () => {
    const r = await api('/api/dine-in/offline-print/stations');
    if (r.ok) setStations((await r.json()).stations || []);
  }, []);
  const loadJobs = useCallback(async () => {
    const r = await api('/api/dine-in/offline-print/jobs?limit=20');
    if (r.ok) setJobs((await r.json()).jobs || []);
  }, []);
  const checkBridge = useCallback(async () => {
    setProbing(true);
    setHealth(await probeBridge());
    setProbing(false);
  }, []);
  const refreshQueue = useCallback(async () => { try { setQueue(await outboxCounts()); } catch { /* idb unavailable */ } }, []);

  useEffect(() => {
    setBridgeUrlState(getBridgeUrl());
    loadStations(); loadJobs(); checkBridge(); refreshQueue();
    ensureDrainLoop();
    const t = setInterval(refreshQueue, 5000);
    return () => clearInterval(t);
  }, [loadStations, loadJobs, checkBridge, refreshQueue]);

  const retryQueue = async () => {
    await retryFailed();
    const r = await drainOutbox();
    await refreshQueue(); await loadJobs();
    flash(r.printed > 0, r.printed > 0 ? `Retried — ${r.printed} printed.` : 'Nothing printed (printer/bridge still unreachable).');
  };

  const saveBridgeUrl = () => { setBridgeUrl(bridgeUrl); checkBridge(); flash(true, 'Bridge address saved.'); };

  const openNew = () => { setForm(blankForm); setShowForm(true); };
  const openEdit = (s: Station) => {
    setForm({ id: s.id, name: s.name, role: s.role, station: s.station || '', transport: s.transport, target: s.target, paper_width: s.paper_width, copies: s.copies });
    setShowForm(true);
  };

  const saveStation = async () => {
    if (!form.name.trim()) return flash(false, 'Name is required.');
    if (!form.target.trim()) return flash(false, 'Printer target (IP or printer name) is required.');
    setSaving(true);
    try {
      const body = { name: form.name, role: form.role, station: form.station, transport: form.transport, target: form.target, paper_width: form.paper_width, copies: form.copies };
      const r = form.id
        ? await api(`/api/dine-in/offline-print/stations/${form.id}`, { method: 'PATCH', body })
        : await api('/api/dine-in/offline-print/stations', { method: 'POST', body });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || 'Save failed');
      setShowForm(false); setForm(blankForm); await loadStations();
      flash(true, 'Printer saved.');
    } catch (e: any) { flash(false, e.message); }
    finally { setSaving(false); }
  };

  const deleteStation = async (s: Station) => {
    if (!confirm(`Delete printer "${s.name}"?`)) return;
    const r = await api(`/api/dine-in/offline-print/stations/${s.id}`, { method: 'DELETE' });
    if (r.ok) { await loadStations(); flash(true, 'Deleted.'); } else flash(false, 'Delete failed.');
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
      result = await bridgePrint({ jobId, printer: { transport: s.transport, target: s.target, width }, doc: doc as any });
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
                {probing ? 'Checking bridge…' : health ? 'Print bridge connected' : 'Print bridge not found'}
              </p>
              <p className="text-xs text-[#8B7355]">
                {health ? `v${health.version} · ${health.platform} · up ${health.uptimeSec}s` : `Run the bridge on this PC, then click refresh. (${getBridgeUrl()})`}
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

      {/* Setup help */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl">
        <button onClick={() => setShowHelp(!showHelp)} className="w-full flex items-center justify-between p-4 text-left">
          <span className="font-semibold text-[#2D1B0E]">How to start the print bridge (on the counter PC)</span>
          {showHelp ? <ChevronDown className="w-5 h-5 text-[#8B7355]" /> : <ChevronRight className="w-5 h-5 text-[#8B7355]" />}
        </button>
        {showHelp && (
          <div className="px-4 pb-4 text-sm text-[#6B5744] space-y-2">
            <p>The bridge is a tiny program that runs on the billing-counter computer (the one with the bill printer on USB and on the same network as the kitchen printers). It needs <b>Node.js</b> installed.</p>
            <ol className="list-decimal ml-5 space-y-1">
              <li>Copy <code className="bg-[#FFF1E3] px-1 rounded">scripts/print-bridge.mjs</code> to the counter PC.</li>
              <li>Open a terminal there and run: <code className="bg-[#FFF1E3] px-1 rounded">node print-bridge.mjs</code></li>
              <li>Leave that window open. Come back here and click <b>Refresh</b> — the status should turn green.</li>
              <li>Add your printers below. For <b>network (IP)</b> printers enter <code className="bg-[#FFF1E3] px-1 rounded">192.168.1.50:9100</code>. For <b>USB</b> printers enter the OS printer name (macOS/Linux) or shared name like <code className="bg-[#FFF1E3] px-1 rounded">\\localhost\POS80</code> (Windows).</li>
            </ol>
            <p className="text-xs text-[#8B7355]">Because the bridge and printers are all on-site, printing keeps working even if the internet drops.</p>
          </div>
        )}
      </div>

      {/* Stations */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-[#2D1B0E]">Printers</h2>
          <button onClick={openNew} className="flex items-center gap-2 bg-[#af4408] hover:bg-[#8a3506] text-white px-4 py-2 rounded-lg text-sm font-medium"><Plus className="w-4 h-4" /> Add printer</button>
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
                <label className="flex flex-col gap-1 text-xs text-[#8B7355]">Kitchen station (optional)
                  <input value={form.station} onChange={(e) => setForm({ ...form, station: e.target.value })} placeholder="Tandoor / Bar / Chinese" className={inputCls} />
                </label>
              )}
              <label className="flex flex-col gap-1 text-xs text-[#8B7355]">Paper width
                <select value={form.paper_width} onChange={(e) => setForm({ ...form, paper_width: Number(e.target.value) })} className={inputCls}>
                  <option value={48}>80mm</option>
                  <option value={32}>58mm</option>
                </select>
              </label>
            </div>
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
            {stations.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 border border-[#E8D5C4] rounded-lg px-4 py-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${s.role === 'bill' ? 'bg-emerald-100 text-emerald-700' : 'bg-[#af4408]/10 text-[#af4408]'}`}>{s.role.toUpperCase()}</span>
                    <span className="font-medium text-[#2D1B0E]">{s.name}</span>
                    {s.station ? <span className="text-xs text-[#8B7355]">· {s.station}</span> : null}
                  </div>
                  <p className="text-xs text-[#8B7355] mt-0.5">{s.transport === 'ip' ? 'Network' : 'USB'} · {s.target} · {s.paper_width === 32 ? '58mm' : '80mm'}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => testPrint(s)} disabled={testingId === s.id} className="flex items-center gap-1.5 text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 disabled:opacity-50 px-3 py-1.5 rounded-lg text-xs font-medium">
                    {testingId === s.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />} Test {s.role}
                  </button>
                  <button onClick={() => openEdit(s)} className="text-xs text-[#6B5744] hover:bg-[#FFF1E3] px-3 py-1.5 rounded-lg">Edit</button>
                  <button onClick={() => deleteStation(s)} className="text-red-500 hover:bg-red-50 p-1.5 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            ))}
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
