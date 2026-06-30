'use client';

/**
 * CaptainShell — the persistent frame for the Captain app: a floors/tables
 * sidebar (always visible on tablet/desktop, a slide-in drawer on phones) +
 * the routed page in the main area. The sidebar is the table selector and
 * quick-switcher; it polls live status and highlights the open table.
 */
import { useEffect, useState, useCallback, useMemo, createContext } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { api } from '@/lib/api';
import {
  ChefHat, RefreshCw, Plus, X, MoreVertical, LayoutDashboard, LogOut, Download, Search, Loader2,
} from 'lucide-react';

/** Lets the routed pages open the tables sidebar/drawer (the ☰ in their headers). */
export const CaptainUI = createContext<{ openTables: () => void }>({ openTables: () => {} });

interface TableTile {
  id: string; table_number: string; zone: string; seats: number;
  open_order_id: string | null; open_order_number: number | null; open_order_total: number | null;
}

export default function CaptainShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [tables, setTables] = useState<TableTile[]>([]);
  const [me, setMe] = useState<{ name?: string; email?: string } | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tkBusy, setTkBusy] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [q, setQ] = useState('');
  const [installEvt, setInstallEvt] = useState<any>(null);

  const load = useCallback(async () => {
    try { const r = await api('/api/dine-in/tables'); const j = await r.json(); setTables(j.items || []); } catch {}
  }, []);
  useEffect(() => {
    load();
    fetch('/api/auth/me').then((r) => r.json()).then((d) => setMe(d?.user || null)).catch(() => {});
    const t = setInterval(load, 10000);
    const onPrompt = (e: Event) => { e.preventDefault(); setInstallEvt(e); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', () => setInstallEvt(null));
    return () => { clearInterval(t); window.removeEventListener('beforeinstallprompt', onPrompt); };
  }, [load]);

  // Close the drawer whenever the route changes (a table was opened).
  useEffect(() => { setDrawer(false); }, [pathname]);

  const currentOrderId = useMemo(() => pathname.match(/\/captain\/order\/([^/]+)/)?.[1] || null, [pathname]);
  const occupiedCount = tables.filter((t) => t.open_order_id).length;

  const zones = useMemo(() => {
    const map = new Map<string, TableTile[]>();
    const filtered = tables.filter((t) =>
      (!onlyOpen || t.open_order_id) &&
      (!q || t.table_number.toLowerCase().includes(q.toLowerCase()) || (t.zone || '').toLowerCase().includes(q.toLowerCase())));
    for (const t of filtered) { const z = t.zone || 'Floor'; (map.get(z) || map.set(z, []).get(z)!).push(t); }
    return [...map.entries()];
  }, [tables, onlyOpen, q]);

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
    if (tkBusy) return;                       // guard against double-tap → duplicate orders
    setTkBusy(true);
    try {
      const r = await api('/api/dine-in/orders', { method: 'POST', body: { order_type: 'takeaway' } });
      const j = await r.json();
      if (j.error) { alert(j.error); return; }
      router.push(`/captain/order/${j.id}`);
    } catch { alert('Could not start a takeaway — check the connection and try again.'); }
    finally { setTkBusy(false); }
  }
  async function signOut() { try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {} window.location.href = '/login'; }
  async function installApp() { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch {} setInstallEvt(null); }

  const sidebar = (
    <div className="flex flex-col h-full bg-[#1C0F05] text-white w-72">
      {/* Brand + menu */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2 min-w-0">
          <ChefHat className="w-5 h-5 text-[#FF8A4C] shrink-0" />
          <div className="min-w-0">
            <p className="font-bold leading-tight">Captain</p>
            <p className="text-[11px] text-white/50 leading-tight truncate">{me?.name || me?.email || ''}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={load} className="p-2 text-white/60 hover:text-white active:scale-95"><RefreshCw className="w-4 h-4" /></button>
          <div className="relative">
            <button onClick={() => setMenuOpen((o) => !o)} className="p-2 text-white/60 hover:text-white"><MoreVertical className="w-4 h-4" /></button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 mt-1 z-30 w-48 bg-white text-[#2D1B0E] rounded-xl shadow-lg overflow-hidden">
                  <button onClick={() => { setMenuOpen(false); router.push('/'); }} className="w-full flex items-center gap-2 px-4 py-3 text-sm hover:bg-[#FFF1E3] text-left"><LayoutDashboard className="w-4 h-4 text-[#8B7355]" /> Back to dashboard</button>
                  <button onClick={signOut} className="w-full flex items-center gap-2 px-4 py-3 text-sm hover:bg-red-50 text-red-600 text-left border-t border-[#F0E4D6]"><LogOut className="w-4 h-4" /> Sign out</button>
                </div>
              </>
            )}
          </div>
          <button onClick={() => setDrawer(false)} className="p-2 text-white/60 hover:text-white md:hidden"><X className="w-5 h-5" /></button>
        </div>
      </div>

      {/* Search + filter */}
      <div className="px-3 pt-3 pb-2 space-y-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find table…"
            className="w-full bg-white/10 rounded-lg pl-8 pr-2 py-2 text-sm placeholder:text-white/40" />
        </div>
        <div className="flex bg-white/10 rounded-lg p-0.5 text-xs">
          <button onClick={() => setOnlyOpen(false)} className={`flex-1 py-1.5 rounded-md font-medium ${!onlyOpen ? 'bg-[#af4408] text-white' : 'text-white/60'}`}>All ({tables.length})</button>
          <button onClick={() => setOnlyOpen(true)} className={`flex-1 py-1.5 rounded-md font-medium ${onlyOpen ? 'bg-[#af4408] text-white' : 'text-white/60'}`}>Open ({occupiedCount})</button>
        </div>
      </div>

      {/* Tables by floor */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-3">
        {zones.length === 0 ? (
          <p className="text-center text-white/40 text-sm py-8">{tables.length === 0 ? 'No tables yet. Add them in Dine-In → Tables.' : 'No tables match.'}</p>
        ) : zones.map(([zone, list]) => (
          <div key={zone}>
            <p className="text-[11px] font-semibold text-white/40 uppercase tracking-wide px-1 mb-1.5">{zone}</p>
            <div className="grid grid-cols-3 gap-1.5">
              {list.map((t) => {
                const occupied = !!t.open_order_id;
                const active = currentOrderId && t.open_order_id === currentOrderId;
                return (
                  <button key={t.id} onClick={() => openTable(t)} disabled={busy === t.id}
                    className={`relative rounded-lg p-2 text-center border transition active:scale-95 disabled:opacity-50 ${
                      active ? 'bg-[#FF6B35] border-[#FF8A4C]' : occupied ? 'bg-amber-500/15 border-amber-500/40' : 'bg-emerald-500/10 border-emerald-500/30'}`}>
                    <span className={`absolute top-1 right-1 w-1.5 h-1.5 rounded-full ${occupied ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                    <p className="font-bold text-sm leading-none">{t.table_number}</p>
                    {occupied
                      ? <p className="text-[10px] text-amber-200 mt-1 leading-none">₹{Math.round(t.open_order_total || 0)}</p>
                      : <p className="text-[10px] text-emerald-300 mt-1 leading-none">{t.seats}p</p>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Takeaway */}
      <div className="p-3 border-t border-white/10">
        <button onClick={newTakeaway} disabled={tkBusy} className="w-full flex items-center justify-center gap-2 bg-[#af4408] py-2.5 rounded-lg text-sm font-semibold active:scale-95 disabled:opacity-60">
          {tkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Takeaway / Parcel
        </button>
        {installEvt && (
          <button onClick={installApp} className="w-full flex items-center justify-center gap-2 mt-2 bg-white/10 py-2 rounded-lg text-xs font-medium active:scale-95">
            <Download className="w-4 h-4" /> Install app
          </button>
        )}
      </div>
    </div>
  );

  return (
    <CaptainUI.Provider value={{ openTables: () => setDrawer(true) }}>
    <div className="md:flex min-h-screen">
      {/* Persistent sidebar (tablet/desktop, md+) */}
      <aside className="hidden md:block shrink-0 h-screen sticky top-0">{sidebar}</aside>

      {/* Drawer (phones / portrait, < md) — opened by the ☰ in each page header */}
      {drawer && <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={() => setDrawer(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-50 md:hidden transform transition-transform ${drawer ? 'translate-x-0' : '-translate-x-full'}`}>{sidebar}</aside>

      {/* Main */}
      <main className="flex-1 min-w-0 relative">
        {children}
      </main>
    </div>
    </CaptainUI.Provider>
  );
}
