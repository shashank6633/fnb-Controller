'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Loader2, RefreshCw, Plus, ChefHat, Download, MoreVertical, LayoutDashboard, LogOut } from 'lucide-react';

interface TableTile {
  id: string;
  table_number: string;
  zone: string;
  seats: number;
  open_order_id: string | null;
  open_order_number: number | null;
  open_order_total: number | null;
}

export default function CaptainHome() {
  const router = useRouter();
  const [tables, setTables] = useState<TableTile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [me, setMe] = useState<{ name?: string; email?: string } | null>(null);
  const [floor, setFloor] = useState<string>('All');
  // PWA install: stash the browser's install event so we can show our own button.
  const [installEvt, setInstallEvt] = useState<any>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  async function signOut() {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
    window.location.href = '/login';
  }

  const load = useCallback(async () => {
    try {
      const r = await api('/api/dine-in/tables');
      const j = await r.json();
      setTables(j.items || []);
    } catch { /* keep last */ } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    fetch('/api/auth/me').then((r) => r.json()).then((d) => setMe(d?.user || null)).catch(() => {});
    const t = setInterval(load, 12000);
    return () => clearInterval(t);
  }, [load]);

  // Capture the install prompt + handle the manifest's "Takeaway" shortcut.
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setInstallEvt(e); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', () => setInstallEvt(null));
    if (new URLSearchParams(window.location.search).get('new') === 'takeaway') {
      window.history.replaceState({}, '', '/captain');
      newTakeaway();
    }
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function installApp() {
    if (!installEvt) return;
    installEvt.prompt();
    try { await installEvt.userChoice; } catch {}
    setInstallEvt(null);
  }

  const zones = useMemo(() => ['All', ...Array.from(new Set(tables.map((t) => t.zone || 'Floor')))], [tables]);
  const visible = useMemo(
    () => (floor === 'All' ? tables : tables.filter((t) => (t.zone || 'Floor') === floor)),
    [tables, floor],
  );
  const occupiedCount = tables.filter((t) => t.open_order_id).length;

  async function openTable(t: TableTile) {
    if (t.open_order_id) { router.push(`/captain/order/${t.open_order_id}`); return; }
    setBusy(t.id);
    try {
      const r = await api('/api/dine-in/orders', { method: 'POST', body: { table_id: t.id, order_type: 'dine-in' } });
      const j = await r.json();
      if (j.error) { alert(j.error); return; }
      router.push(`/captain/order/${j.id}`);
    } finally { setBusy(null); }
  }

  async function newTakeaway() {
    const r = await api('/api/dine-in/orders', { method: 'POST', body: { order_type: 'takeaway' } });
    const j = await r.json();
    if (j.error) { alert(j.error); return; }
    router.push(`/captain/order/${j.id}`);
  }

  // Group the visible tables by zone for display.
  const byZone = useMemo(() => {
    const m = new Map<string, TableTile[]>();
    for (const t of visible) { const z = t.zone || 'Floor'; (m.get(z) || m.set(z, []).get(z)!).push(t); }
    return [...m.entries()];
  }, [visible]);

  return (
    <div className="flex flex-col min-h-screen">
      {/* Top bar */}
      <header className="sticky top-0 z-10 bg-[#1C0F05] text-white px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ChefHat className="w-5 h-5 text-[#FF8A4C]" />
          <div>
            <p className="font-bold leading-tight">Captain</p>
            <p className="text-[11px] text-white/60 leading-tight">{me?.name || me?.email || ''}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {installEvt && (
            <button onClick={installApp} className="flex items-center gap-1.5 bg-[#af4408] px-3 py-1.5 rounded-full font-semibold active:scale-95">
              <Download className="w-4 h-4" /> Install
            </button>
          )}
          <span className="text-white/70">{occupiedCount}/{tables.length} tables</span>
          <button onClick={load} className="p-2 active:scale-95"><RefreshCw className="w-5 h-5" /></button>
          <div className="relative">
            <button onClick={() => setMenuOpen((o) => !o)} className="p-2 -mr-2 active:scale-95"><MoreVertical className="w-5 h-5" /></button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 mt-1 z-30 w-48 bg-white text-[#2D1B0E] rounded-xl shadow-lg border border-[#E8D5C4] overflow-hidden">
                  <button onClick={() => { setMenuOpen(false); router.push('/'); }}
                    className="w-full flex items-center gap-2 px-4 py-3 text-sm hover:bg-[#FFF1E3] text-left">
                    <LayoutDashboard className="w-4 h-4 text-[#8B7355]" /> Back to dashboard
                  </button>
                  <button onClick={signOut}
                    className="w-full flex items-center gap-2 px-4 py-3 text-sm hover:bg-red-50 text-red-600 text-left border-t border-[#F0E4D6]">
                    <LogOut className="w-4 h-4" /> Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Floor chips */}
      <div className="flex gap-2 overflow-x-auto px-4 py-3 no-scrollbar">
        {zones.map((z) => (
          <button key={z} onClick={() => setFloor(z)}
            className={`shrink-0 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
              floor === z ? 'bg-[#af4408] text-white' : 'bg-white text-[#6B5744] border border-[#E8D5C4]'}`}>
            {z}
          </button>
        ))}
      </div>

      <main className="flex-1 px-4 pb-28">
        {loading ? (
          <div className="text-center py-16 text-[#8B7355]"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
        ) : tables.length === 0 ? (
          <div className="text-center py-16 text-[#8B7355]">No tables yet. Set them up in the web app → Dine-In → Tables.</div>
        ) : (
          byZone.map(([zone, list]) => (
            <div key={zone} className="mb-5">
              {floor === 'All' && <h2 className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide mb-2">{zone}</h2>}
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                {list.map((t) => {
                  const occupied = !!t.open_order_id;
                  return (
                    <button key={t.id} onClick={() => openTable(t)} disabled={busy === t.id}
                      className={`relative aspect-square rounded-2xl p-3 flex flex-col items-center justify-center text-center border-2 active:scale-95 transition-transform disabled:opacity-60 ${
                        occupied ? 'bg-amber-100 border-amber-400' : 'bg-emerald-50 border-emerald-300'}`}>
                      <span className={`absolute top-2 right-2 w-2.5 h-2.5 rounded-full ${occupied ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                      <p className="text-xl font-extrabold text-[#2D1B0E]">{t.table_number}</p>
                      <p className="text-[10px] text-[#8B7355]">{t.seats} seats</p>
                      {occupied
                        ? <p className="mt-1 text-xs font-bold text-amber-700">₹{Math.round(t.open_order_total || 0)}</p>
                        : <p className="mt-1 text-[11px] font-semibold text-emerald-600">Free</p>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </main>

      {/* Takeaway FAB */}
      <button onClick={newTakeaway}
        className="fixed bottom-6 left-1/2 -translate-x-1/2 max-w-3xl flex items-center gap-2 bg-[#af4408] text-white px-5 py-3 rounded-full shadow-lg text-sm font-semibold active:scale-95">
        <Plus className="w-5 h-5" /> Takeaway / Parcel
      </button>
    </div>
  );
}
