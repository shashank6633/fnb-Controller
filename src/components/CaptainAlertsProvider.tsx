'use client';

/**
 * CaptainAlertsProvider — the captain's live alert feed, GLOBAL.
 *
 * Polls the captain's own tables (+ unclaimed) for new QR orders, table service
 * requests and KOT/kitchen issues every 8s and:
 *   - raises a toast (+ two-tone chime) the moment a NEW one arrives, and
 *   - shows a FLOATING bell (bottom-right, above all content) with a live badge
 *     and a tap-through list — on EVERY screen, so a captain who has navigated
 *     away from the board never misses an alert.
 *
 * It also exposes { items, count } via context so the Captain sidebar can badge
 * its "Orders & Requests" tab from the SAME single poll (no duplicate polling).
 *
 * Mounted once in AppShell so it wraps every route (main app + the /captain app).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, X } from 'lucide-react';
import { api } from '@/lib/api';

export interface CaptainAlert { id: string; text: string }

const Ctx = createContext<{ items: CaptainAlert[]; count: number }>({ items: [], count: 0 });
export const useCaptainAlerts = () => useContext(Ctx);

export default function CaptainAlertsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CaptainAlert[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const first = useRef(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();

  // No alerts UI on the login screen or the full-screen print/agent views — a
  // floating bell / chime there is noise (and could bleed into a printout).
  const suppressed = pathname === '/login' || /\/print(\/|$)/.test(pathname);

  // Who am I? (drives the "mine" filter). Re-fetch only when crossing the
  // login/app boundary (suppressed flips), NOT on every in-app navigation.
  useEffect(() => {
    if (suppressed) { setMeId(null); return; }
    let ok = true;
    api('/api/auth/me').then((r) => r.json()).then((d) => { if (ok) setMeId(d?.user?.id || null); }).catch(() => {});
    return () => { ok = false; };
  }, [suppressed]);

  // Close the dropdown on an outside tap / Escape (no full-screen backdrop, which
  // would sit over — and trap clicks meant for — an open modal beneath it).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Louder, repeating two-tone chime (identical to the captain board's) so it
  // carries across a busy floor even when the captain is on another screen.
  const beep = useCallback(() => {
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const now = ctx.currentTime;
      [0, 0.32, 0.64].forEach((t0, i) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination); o.type = 'sine';
        o.frequency.value = i % 2 === 0 ? 988 : 784;
        const t = now + t0;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
        o.start(t); o.stop(t + 0.3);
      });
      setTimeout(() => { try { ctx.close(); } catch {} }, 1200);
    } catch {}
  }, []);

  // Single poll for the whole app.
  useEffect(() => {
    if (!meId) { setItems([]); return; }
    // New identity (fresh login on the same tab) → seed silently again so we
    // don't replay every pending alert as "new" (a burst of toasts + chimes).
    first.current = true;
    seen.current = new Set();
    let stop = false;
    const poll = async () => {
      try {
        const [o, r, a] = await Promise.all([
          api('/api/dine-in/customer-orders').then((x) => x.json()).catch(() => ({})),
          api('/api/dine-in/service-requests').then((x) => x.json()).catch(() => ({})),
          api('/api/dine-in/kot-alerts?open=1').then((x) => x.json()).catch(() => ({})),
        ]);
        if (stop) return;
        const mine = (owner?: string | null) => !owner || owner === meId;
        const list: CaptainAlert[] = [];
        for (const ord of (o?.orders || [])) if (mine(ord.table_owner_id)) list.push({ id: 'o:' + ord.id, text: `New order · Table ${ord.table?.number ?? '—'}` });
        for (const req of (r?.requests || [])) if (mine(req.table_owner_id)) list.push({ id: 's:' + req.id, text: `Table ${req.table_number} · ${req.type}` });
        for (const al of (a?.alerts || [])) if (mine(al.server_id)) list.push({ id: 'a:' + al.id, text: `⚠ Kitchen issue · Table ${al.table_number || '—'}` });
        setItems(list);
        const fresh = list.filter((it) => !seen.current.has(it.id));
        seen.current = new Set(list.map((it) => it.id)); // seen == present, so a returning id can re-alert
        if (first.current) { first.current = false; return; } // seed silently on first load
        // Alert on new items — but not while already viewing the requests board.
        if (fresh.length && !window.location.pathname.endsWith('/captain/requests')) {
          setToast({ key: Date.now(), text: fresh.length === 1 ? fresh[0].text : `${fresh.length} new orders / requests` });
          beep();
        }
      } catch { /* offline — keep last state */ }
    };
    poll();
    const t = setInterval(poll, 8000);
    return () => { stop = true; clearInterval(t); };
  }, [meId, beep]);

  // Auto-dismiss the toast.
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); }, [toast]);

  const count = items.length;
  const goRequests = () => { setOpen(false); setToast(null); router.push('/captain/requests'); };

  return (
    <Ctx.Provider value={{ items, count }}>
      {children}

      {/* New-alert toast — top-center. z-40 keeps it below the app's modal layer
          (z-50) so it can never cover a dialog's controls; the chime still fires,
          so a captain mid-modal still HEARS the alert and sees the bell after. */}
      {toast && !suppressed && (
        <button
          onClick={goRequests}
          className="fixed top-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 max-w-[92vw] bg-[#af4408] text-white pl-3 pr-2 py-2.5 rounded-full shadow-2xl ring-1 ring-white/20 active:scale-95"
        >
          <Bell className="w-4 h-4 shrink-0" />
          <span className="text-sm font-semibold truncate">{toast.text}</span>
          <span className="shrink-0 text-[11px] font-bold bg-white/20 px-2 py-0.5 rounded-full">View</span>
        </button>
      )}

      {/* Floating bell — bottom-right, above page content but BELOW modals/sheets
          (z-40 < the app's z-50 dialog layer), so an open modal always covers it
          and its controls are never blocked. Shown whenever there are alerts. */}
      {count > 0 && !suppressed && (
        <div ref={rootRef} className="fixed bottom-5 right-5 z-40">
          {open && (
            <div className="absolute bottom-16 right-0 w-72 max-w-[calc(100vw-2.5rem)] bg-white text-[#2D1B0E] rounded-xl shadow-2xl border border-[#E8D5C4] overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 bg-[#FFF7EF] border-b border-[#F0E4D6]">
                <span className="text-[11px] font-bold uppercase tracking-wide text-[#8B7355]">Needs your action</span>
                <button onClick={() => setOpen(false)} className="text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-4 h-4" /></button>
              </div>
              <div className="max-h-80 overflow-y-auto divide-y divide-[#F0E4D6]">
                {items.map((it) => (
                  <button key={it.id} onClick={goRequests} className="w-full text-left px-4 py-2.5 text-sm hover:bg-[#FFF1E3]">{it.text}</button>
                ))}
              </div>
            </div>
          )}
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label={`Notifications: ${count} need your action`}
            className="relative flex items-center justify-center w-14 h-14 rounded-full bg-[#af4408] text-white shadow-2xl ring-2 ring-white/40 active:scale-95 hover:bg-[#8a3506] transition-colors"
          >
            <Bell className="w-6 h-6" />
            <span className="absolute -top-1 -right-1 min-w-[22px] h-[22px] px-1 rounded-full bg-white text-[#af4408] text-[12px] font-extrabold flex items-center justify-center ring-2 ring-[#af4408]">
              {count > 99 ? '99+' : count}
            </span>
          </button>
        </div>
      )}
    </Ctx.Provider>
  );
}
