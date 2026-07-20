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
import { useCaptainAlerts } from '@/components/CaptainAlertsProvider';
import {
  ChefHat, RefreshCw, Plus, X, MoreVertical, LayoutDashboard, LogOut, Download, Search, Loader2,
  MapPin, ChevronDown, Users, WifiOff, Bell,
} from 'lucide-react';

/** Lets the routed pages open the tables sidebar/drawer (the ☰ in their headers). */
export const CaptainUI = createContext<{ openTables: () => void }>({ openTables: () => {} });

interface TableTile {
  id: string; table_number: string; zone: string; seats: number;
  open_order_id: string | null; open_order_number: number | null; open_order_total: number | null;
}

/** localStorage key for the captain's last-chosen serving area/zone. */
const AREA_KEY = 'captain_active_zone';
/** Normalize a table's zone to a stable label (matches the sidebar grouping). */
const zoneOf = (t: TableTile) => t.zone || 'Floor';

export default function CaptainShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [tables, setTables] = useState<TableTile[]>([]);
  const [me, setMe] = useState<{ name?: string; email?: string; id?: string } | null>(null);
  // The captain's live alert count comes from the GLOBAL CaptainAlertsProvider
  // (AppShell) — one poll for the whole app. The floating bell + toast it renders
  // work on every screen; here we only badge the sidebar's "Orders & Requests" tab.
  const { count: reqCount } = useCaptainAlerts();
  const [drawer, setDrawer] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tkBusy, setTkBusy] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [q, setQ] = useState('');
  const [installEvt, setInstallEvt] = useState<any>(null);
  const [loaded, setLoaded] = useState(false);          // first tables fetch has resolved
  const [activeZone, setActiveZone] = useState<string | null>(null); // null = not yet picked
  const [picking, setPicking] = useState(false);        // "switch area" re-opened the picker
  // Connectivity heartbeat: when the internet drops, captains can't reach the
  // cloud — but the kitchen can still get KOTs via the counter PC's offline page.
  const [offline, setOffline] = useState(false);                    // ~2 consecutive heartbeat misses
  const [counterOfflineUrl, setCounterOfflineUrl] = useState<string | null>(null); // setting, cached once
  // Guest-capture modal state (dine-in open flow).
  const [guestTable, setGuestTable] = useState<TableTile | null>(null);
  const [gName, setGName] = useState('');
  const [gMobile, setGMobile] = useState('');
  const [gCovers, setGCovers] = useState('2');
  const [gBusy, setGBusy] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api('/api/dine-in/tables'); const j = await r.json(); setTables(j.items || []); }
    catch {} finally { setLoaded(true); }
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

  // Restore the previously-chosen area (if the captain still has access to it).
  useEffect(() => {
    try { const saved = localStorage.getItem(AREA_KEY); if (saved) setActiveZone(saved); } catch {}
  }, []);

  // Cache the counter PC's offline address ONCE while we're still online, so the
  // offline banner's button has a target even after the internet drops.
  useEffect(() => {
    fetch('/api/settings?key=counter_offline_url')
      .then((r) => r.json())
      .then((d) => { const v = (d?.value || '').trim(); if (v) setCounterOfflineUrl(v); })
      .catch(() => {});
  }, []);

  // Connectivity heartbeat — poll a cheap, same-origin, no-auth endpoint every
  // ~15s with a short timeout. Two consecutive failures ⇒ "offline"; the next
  // success clears it. During a real internet outage the cloud is unreachable,
  // so these fetches fail and the offline banner appears.
  useEffect(() => {
    let misses = 0;
    let stopped = false;
    const ping = async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      try {
        const r = await fetch('/api/build-info', { cache: 'no-store', signal: ctl.signal });
        if (!r.ok) throw new Error('bad status');
        misses = 0;
        if (!stopped) setOffline(false);
      } catch {
        misses += 1;
        if (!stopped && misses >= 2) setOffline(true);
      } finally { clearTimeout(timer); }
    };
    ping();
    const t = setInterval(ping, 15000);
    return () => { stopped = true; clearInterval(t); };
  }, []);

  // Close the drawer whenever the route changes (a table was opened).
  useEffect(() => { setDrawer(false); }, [pathname]);

  const currentOrderId = useMemo(() => pathname.match(/\/captain\/order\/([^/]+)/)?.[1] || null, [pathname]);
  const occupiedCount = tables.filter((t) => t.open_order_id).length;

  /** Distinct zones available to this captain (server already area-filters the list). */
  const availableZones = useMemo(() => {
    const set = new Set<string>();
    for (const t of tables) set.add(zoneOf(t));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [tables]);

  /** Free/Occupied counts for a given zone (occ = has an open order). */
  const zoneCounts = useCallback((zone: string) => {
    const list = tables.filter((t) => zoneOf(t) === zone);
    const occ = list.filter((t) => t.open_order_id).length;
    return { free: list.length - occ, occ, total: list.length };
  }, [tables]);

  // Persist the picked area; auto-clear a stale pick the captain no longer has access to.
  const chooseZone = useCallback((zone: string) => {
    setActiveZone(zone); setPicking(false);
    try { localStorage.setItem(AREA_KEY, zone); } catch {}
  }, []);
  useEffect(() => {
    if (loaded && activeZone && availableZones.length && !availableZones.includes(activeZone)) {
      setActiveZone(null);
      try { localStorage.removeItem(AREA_KEY); } catch {}
    }
  }, [loaded, activeZone, availableZones]);

  // Whether the full-screen area picker should show: captain has >1 zone and hasn't
  // settled on one yet (or explicitly asked to switch). One-zone captains skip it.
  const needsPicker = loaded && availableZones.length > 1 &&
    (picking || !activeZone || !availableZones.includes(activeZone));

  const zones = useMemo(() => {
    const map = new Map<string, TableTile[]>();
    const filtered = tables.filter((t) =>
      // When an area is active, scope the sidebar to it (search can still probe others via q).
      (!activeZone || zoneOf(t) === activeZone || (q && zoneOf(t).toLowerCase().includes(q.toLowerCase()))) &&
      (!onlyOpen || t.open_order_id) &&
      (!q || t.table_number.toLowerCase().includes(q.toLowerCase()) || (t.zone || '').toLowerCase().includes(q.toLowerCase())));
    for (const t of filtered) { const z = zoneOf(t); (map.get(z) || map.set(z, []).get(z)!).push(t); }
    return [...map.entries()];
  }, [tables, onlyOpen, q, activeZone]);

  function openTable(t: TableTile) {
    // Tapping an already-open table jumps straight to its order — no form.
    if (t.open_order_id) { router.push(`/captain/order/${t.open_order_id}`); return; }
    // A free dine-in table first captures the guest (name + party size) via a modal.
    setGName(''); setGMobile(''); setGCovers('2');
    setGuestTable(t);
  }

  // Party size / name are valid; enables the Start button in the guest modal.
  const guestValid = gName.trim().length > 0 && (Number(gCovers) || 0) >= 1;

  async function startDineIn() {
    if (!guestTable || !guestValid || gBusy) return;
    const t = guestTable;
    setGBusy(true); setBusy(t.id);
    try {
      const r = await api('/api/dine-in/orders', {
        method: 'POST',
        body: {
          table_id: t.id, order_type: 'dine-in',
          guest_name: gName.trim(), guest_mobile: gMobile.trim(), covers: Number(gCovers) || 1,
        },
      });
      const j = await r.json();
      if (j.error) { alert(j.error); return; }
      setGuestTable(null);
      router.push(`/captain/order/${j.id}`);
    } catch { alert('Could not open the table — check the connection and try again.'); }
    finally { setGBusy(false); setBusy(null); }
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

  // OFFLINE BANNER — a fixed, prominent strip shown only when the heartbeat says
  // the internet is down. It reassures captains the kitchen can still get KOTs and
  // links them (top-level navigation, NOT fetch) to the counter PC's offline page.
  // The plain <a> is deliberate: a top-level navigate escapes the TWA https
  // mixed-content block that would kill a fetch() to an http:// counter address.
  const offlineBanner = offline ? (
    // In normal flow (not fixed) so it reserves its own space and pushes the page
    // down instead of covering each route's sticky header (back button, table bar).
    <div className="relative z-[70] bg-red-700 text-white shadow-lg">
      <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center gap-3 flex-wrap">
        <WifiOff className="w-5 h-5 shrink-0" />
        <p className="text-sm font-semibold leading-tight min-w-0 flex-1">
          Internet is down — the kitchen can still get your KOTs.
        </p>
        {counterOfflineUrl ? (
          <a
            href={counterOfflineUrl}
            className="shrink-0 inline-flex items-center gap-2 bg-white text-red-700 font-bold px-4 py-2 rounded-lg text-sm active:scale-95"
          >
            Open Offline Kitchen Mode
          </a>
        ) : (
          <span className="shrink-0 text-xs text-white/80 max-w-[220px]">
            Ask an admin to set the Counter PC address on the KOT &amp; Bill Printers page.
          </span>
        )}
      </div>
    </div>
  ) : null;

  const sidebar = (
    <div className="flex flex-col h-full bg-white text-[#2D1B0E] w-72 border-r border-[#E8D5C4]">
      {/* Brand + menu */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#E8D5C4]">
        <div className="flex items-center gap-2 min-w-0">
          <ChefHat className="w-5 h-5 text-[#af4408] shrink-0" />
          <div className="min-w-0">
            <p className="font-bold leading-tight">Captain</p>
            {activeZone && availableZones.length > 1 ? (
              <button
                onClick={() => setPicking(true)}
                className="flex items-center gap-1 text-[11px] text-[#af4408] leading-tight -ml-0.5 active:scale-95"
                title="Switch area"
              >
                <MapPin className="w-3 h-3 shrink-0" />
                <span className="truncate max-w-[120px]">{activeZone}</span>
                <ChevronDown className="w-3 h-3 shrink-0" />
              </button>
            ) : (
              <p className="text-[11px] text-[#6B5744] leading-tight truncate">{me?.name || me?.email || ''}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/* Captain alerts (new orders / service requests / KOT issues) are now
              shown by the GLOBAL floating bell + toast (CaptainAlertsProvider),
              which follows the captain onto every screen — no header bell here. */}
          <button onClick={load} className="p-2 text-[#6B5744] hover:text-[#2D1B0E] active:scale-95"><RefreshCw className="w-4 h-4" /></button>
          <div className="relative">
            <button onClick={() => setMenuOpen((o) => !o)} className="p-2 text-[#6B5744] hover:text-[#2D1B0E]"><MoreVertical className="w-4 h-4" /></button>
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
          <button onClick={() => setDrawer(false)} className="p-2 text-[#6B5744] hover:text-[#2D1B0E] md:hidden"><X className="w-5 h-5" /></button>
        </div>
      </div>

      {/* Search + filter */}
      <div className="px-3 pt-3 pb-2 space-y-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find table…"
            className="w-full bg-white border border-[#D4B896] rounded-lg pl-8 pr-2 py-2 text-sm placeholder:text-[#8B7355]" />
        </div>
        <div className="flex bg-[#FFF1E3] rounded-lg p-0.5 text-xs">
          <button onClick={() => setOnlyOpen(false)} className={`flex-1 py-1.5 rounded-md font-medium ${!onlyOpen ? 'bg-[#af4408] text-white' : 'text-[#6B5744]'}`}>All ({tables.length})</button>
          <button onClick={() => setOnlyOpen(true)} className={`flex-1 py-1.5 rounded-md font-medium ${onlyOpen ? 'bg-[#af4408] text-white' : 'text-[#6B5744]'}`}>Open ({occupiedCount})</button>
        </div>
      </div>

      {/* Customer QR-menu tab — orders to approve + table service requests (my tables) */}
      <div className="px-3 pb-2">
        <button
          onClick={() => { router.push('/captain/requests'); setDrawer(false); }}
          className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold transition active:scale-95 ${
            pathname === '/captain/requests'
              ? 'bg-[#af4408] text-white'
              : reqCount > 0
                ? 'bg-[#FFF1E3] text-[#af4408] ring-1 ring-[#af4408]/40'
                : 'bg-[#FFF1E3] text-[#6B5744] hover:text-[#2D1B0E]'}`}
        >
          <Bell className={`w-4 h-4 shrink-0 ${reqCount > 0 && pathname !== '/captain/requests' ? 'animate-pulse' : ''}`} />
          <span className="flex-1 text-left truncate">Orders &amp; Requests</span>
          {reqCount > 0 && (
            <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-[#af4408] text-white text-[11px] font-bold flex items-center justify-center">{reqCount}</span>
          )}
        </button>
      </div>

      {/* Tables by floor */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-3">
        {zones.length === 0 ? (
          <p className="text-center text-[#8B7355] text-sm py-8">{tables.length === 0 ? 'No tables yet. Add them in Dine-In → Tables.' : 'No tables match.'}</p>
        ) : zones.map(([zone, list]) => {
          const c = zoneCounts(zone);
          return (
          <div key={zone}>
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide px-1 mb-1.5 flex items-center justify-between gap-1">
              <span className="truncate">{zone}</span>
              <span className="normal-case tracking-normal shrink-0 text-[#8B7355]">(Free {c.free} / Occ {c.occ})</span>
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {list.map((t) => {
                const occupied = !!t.open_order_id;
                const active = currentOrderId && t.open_order_id === currentOrderId;
                return (
                  <button key={t.id} onClick={() => openTable(t)} disabled={busy === t.id}
                    className={`relative rounded-lg p-2 text-center border transition active:scale-95 disabled:opacity-50 ${
                      active ? 'bg-[#af4408] border-[#af4408] text-white' : occupied ? 'bg-amber-50 border-amber-300' : 'bg-emerald-50 border-emerald-200'}`}>
                    <span className={`absolute top-1 right-1 w-1.5 h-1.5 rounded-full ${occupied ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                    <p className="font-bold text-sm leading-none">{t.table_number}</p>
                    {occupied
                      ? <p className={`text-[10px] mt-1 leading-none ${active ? 'text-white/90' : 'text-amber-700'}`}>₹{Math.round(t.open_order_total || 0)}</p>
                      : <p className="text-[10px] text-emerald-700 mt-1 leading-none">{t.seats}p</p>}
                  </button>
                );
              })}
            </div>
          </div>
          );
        })}
      </div>

      {/* Takeaway */}
      <div className="p-3 border-t border-[#E8D5C4]">
        <button onClick={newTakeaway} disabled={tkBusy} className="w-full flex items-center justify-center gap-2 bg-[#af4408] text-white py-2.5 rounded-lg text-sm font-semibold active:scale-95 disabled:opacity-60">
          {tkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Takeaway / Parcel
        </button>
        {installEvt && (
          <button onClick={installApp} className="w-full flex items-center justify-center gap-2 mt-2 bg-[#FFF1E3] py-2 rounded-lg text-xs font-medium active:scale-95">
            <Download className="w-4 h-4" /> Install app
          </button>
        )}
      </div>
    </div>
  );

  // AREA PICKER — a multi-zone captain chooses their serving area before the shell.
  // Shown after login (no saved pick) or when they tap "switch area" in the sidebar.
  if (needsPicker) {
    return (
      <>
      {offlineBanner}
      <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E] flex flex-col">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-[#E8D5C4]">
          <ChefHat className="w-6 h-6 text-[#af4408] shrink-0" />
          <div className="min-w-0">
            <p className="font-bold leading-tight">Captain</p>
            <p className="text-[11px] text-[#6B5744] leading-tight truncate">{me?.name || me?.email || ''}</p>
          </div>
          {picking && activeZone && availableZones.includes(activeZone) && (
            <button onClick={() => setPicking(false)} className="ml-auto p-2 text-[#6B5744] hover:text-[#2D1B0E] active:scale-95">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-6">
          <div className="max-w-2xl mx-auto">
            <h1 className="text-xl font-bold flex items-center gap-2"><MapPin className="w-5 h-5 text-[#af4408]" /> Choose your area</h1>
            <p className="text-sm text-[#6B5744] mt-1">Pick the section you are serving. You can switch anytime from the sidebar.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6">
              {availableZones.map((zone) => {
                const c = zoneCounts(zone);
                const isActive = zone === activeZone;
                return (
                  <button
                    key={zone}
                    onClick={() => chooseZone(zone)}
                    className={`text-left rounded-2xl border p-5 transition active:scale-[0.98] ${
                      isActive ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] hover:border-[#af4408]'}`}
                  >
                    <div className="flex items-center gap-2">
                      <MapPin className="w-5 h-5 text-[#af4408] shrink-0" />
                      <span className="font-bold text-lg truncate">{zone}</span>
                    </div>
                    <p className={`text-sm mt-2 ${isActive ? 'text-white/90' : 'text-[#6B5744]'}`}>
                      (Free {c.free} / Occ {c.occ})
                    </p>
                    <p className={`text-[11px] mt-0.5 ${isActive ? 'text-white/70' : 'text-[#8B7355]'}`}>{c.total} table{c.total === 1 ? '' : 's'}</p>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      </>
    );
  }

  return (
    <CaptainUI.Provider value={{ openTables: () => setDrawer(true) }}>
    {offlineBanner}
    {/* The new-order / new-request toast is rendered globally by
        CaptainAlertsProvider (AppShell), so it appears on every screen. */}
    <div className="md:flex min-h-screen">
      {/* Persistent sidebar (tablet/desktop, md+). z-40: sticky creates a stacking
          context, so without a z-index the bell's dropdown (inside the sidebar)
          would paint UNDER the main column's content where it overhangs it. Kept
          below the drawer (z-50) and the modals/toasts (z-[60]+). */}
      <aside className="hidden md:block shrink-0 h-screen sticky top-0 z-40">{sidebar}</aside>

      {/* Drawer (phones / portrait, < md) — opened by the ☰ in each page header */}
      {drawer && <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={() => setDrawer(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-50 md:hidden transform transition-transform ${drawer ? 'translate-x-0' : '-translate-x-full'}`}>{sidebar}</aside>

      {/* Main */}
      <main className="flex-1 min-w-0 relative">
        {children}
      </main>

      {/* GUEST FORM — captures the party before opening a free dine-in table. */}
      {guestTable && (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4"
             onClick={() => { if (!gBusy) setGuestTable(null); }}>
          <div className="w-full sm:max-w-sm bg-white text-[#2D1B0E] rounded-t-3xl sm:rounded-3xl border border-[#E8D5C4] p-5"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-[#8B7355]">Open table</p>
                <p className="font-bold text-lg leading-tight">Table {guestTable.table_number}
                  <span className="text-[#8B7355] font-normal text-sm"> · {zoneOf(guestTable)}</span></p>
              </div>
              <button onClick={() => { if (!gBusy) setGuestTable(null); }} className="p-2 text-[#6B5744] hover:text-[#2D1B0E] active:scale-95">
                <X className="w-5 h-5" />
              </button>
            </div>

            <label className="block mb-3">
              <span className="text-xs text-[#6B5744]">Full name <span className="text-[#af4408]">*</span></span>
              <input autoFocus value={gName} onChange={(e) => setGName(e.target.value)} placeholder="Guest name"
                className="mt-1 w-full bg-white border border-[#D4B896] rounded-xl px-3 py-3 text-base placeholder:text-[#8B7355] focus:outline-none focus:ring-2 focus:ring-[#af4408]" />
            </label>

            <label className="block mb-3">
              <span className="text-xs text-[#6B5744]">Mobile <span className="text-[#8B7355]">(optional)</span></span>
              <input value={gMobile} onChange={(e) => setGMobile(e.target.value)} inputMode="tel" placeholder="Phone number"
                className="mt-1 w-full bg-white border border-[#D4B896] rounded-xl px-3 py-3 text-base placeholder:text-[#8B7355] focus:outline-none focus:ring-2 focus:ring-[#af4408]" />
            </label>

            <label className="block mb-5">
              <span className="text-xs text-[#6B5744] flex items-center gap-1"><Users className="w-3.5 h-3.5" /> No. of guests <span className="text-[#af4408]">*</span></span>
              <div className="mt-1 flex items-center gap-2">
                <button type="button" onClick={() => setGCovers(String(Math.max(1, (Number(gCovers) || 1) - 1)))}
                  className="w-11 h-11 rounded-xl bg-[#FFF1E3] text-xl font-bold active:scale-95 shrink-0">−</button>
                <input value={gCovers} onChange={(e) => setGCovers(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric"
                  className="flex-1 min-w-0 bg-white border border-[#D4B896] rounded-xl px-3 py-3 text-base text-center focus:outline-none focus:ring-2 focus:ring-[#af4408]" />
                <button type="button" onClick={() => setGCovers(String((Number(gCovers) || 0) + 1))}
                  className="w-11 h-11 rounded-xl bg-[#FFF1E3] text-xl font-bold active:scale-95 shrink-0">+</button>
              </div>
            </label>

            <button onClick={startDineIn} disabled={!guestValid || gBusy}
              className="w-full flex items-center justify-center gap-2 bg-[#af4408] text-white py-3.5 rounded-xl text-base font-semibold active:scale-95 disabled:opacity-40 disabled:active:scale-100">
              {gBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : null} Start
            </button>
          </div>
        </div>
      )}
    </div>
    </CaptainUI.Provider>
  );
}
