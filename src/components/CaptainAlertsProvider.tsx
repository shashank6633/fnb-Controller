'use client';

/**
 * CaptainAlertsProvider — the live alert feed, GLOBAL.
 *
 * Polls three dine-in feeds every 8s for new QR orders, table service requests
 * and KOT/kitchen issues and:
 *   - raises a toast (+ two-tone chime) the moment a NEW one arrives, and
 *   - shows a FLOATING bell (bottom-right, above all content) with a live badge
 *     and a tap-through list — on EVERY screen, so a captain who has navigated
 *     away from the board never misses an alert.
 *
 * It also exposes { items, count } via context so the Captain sidebar can badge
 * its "Orders & Requests" tab from the SAME single poll (no duplicate polling).
 *
 * Mounted once in AppShell so it wraps every route (main app + the /captain app).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHO GETS WHICH ALERT IS DECIDED ON THE SERVER (src/lib/alert-audience.ts).
 * This component used to hold the entire targeting model in one line —
 * `!owner || owner === meId` — while the three feeds handed every row in the
 * outlet to any signed-in caller, so a store manager posting a GRN was chimed at
 * for a table asking for water, and the "filter" was cosmetic besides. Now each
 * feed returns only the rows this person is an audience for and says so on the
 * wire, so THERE IS DELIBERATELY NO CLIENT-SIDE OWNER FILTER LEFT: re-filtering
 * here would silently subtract from a supervisor's firehose, which is the exact
 * failure this must not cause. What arrives is what belongs to you.
 *
 * The audience also decides where a tap LANDS (destFor) — a kitchen-only login
 * used to be sent to /captain/requests, a page its role cannot open — and, when
 * a person has no floor duty at all, that the 8s poll simply stops. It restarts
 * on window focus, so a role change mid-shift is picked up without a reload.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, X, CheckCheck } from 'lucide-react';
import { api } from '@/lib/api';
import type { AlertAudience } from '@/lib/alert-audience';
import {
  loadAck, saveAck, ackInboxItem, ackAlertId, ackEverything, refreshInboxAcks, pruneAck,
  isInboxAcked, isAlertAcked, type AckState,
} from '@/lib/notif-ack';

/** `href` is where tapping this alert should go — see destFor(). */
export interface CaptainAlert { id: string; text: string; href?: string }

/** Guest-facing wording for a service-request type; the raw code is the fallback. */
const SERVICE_LABEL: Record<string, string> = {
  waiter: 'Call waiter',
  water: 'Refill water',
  cutlery: 'Extra cutlery',
  bill: 'Bill requested',
};

/** The board an alert belongs to, for whoever is looking at it. */
const REQUESTS_BOARD = '/captain/requests';
const KITCHEN_BOARD = '/dine-in/kitchen';
const CASHIER_BOARD = '/cashier';
/** Action-Inbox bucket (approvals / requisitions / tasks) from /api/notifications/inbox. */
interface InboxItem { key: string; label: string; count: number; href: string }

const Ctx = createContext<{ items: CaptainAlert[]; count: number }>({ items: [], count: 0 });
export const useCaptainAlerts = () => useContext(Ctx);

export default function CaptainAlertsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CaptainAlert[]>([]);
  // Action Inbox folded into this ONE floating bell (the app's single
  // notification hub). Passive pending-state counts — shown in the badge + list
  // but NO chime (only live table alerts chime).
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Acknowledged (=user-cleared) notifications — badge counts only UN-acked work.
  // Loaded on the client; synced across tabs via the 'storage' event.
  const [ack, setAck] = useState<AckState>({ inbox: {}, alerts: [] });
  const prevInboxCounts = useRef<Record<string, number>>({});
  const firstInbox = useRef(true);
  useEffect(() => {
    setAck(loadAck());
    const onStorage = (e: StorageEvent) => { if (e.key === 'akan_notif_ack') setAck(loadAck()); };
    const onLocal = () => setAck(loadAck());   // same-tab sync (see saveAck)
    window.addEventListener('storage', onStorage);
    window.addEventListener('akan-notif-ack', onLocal);
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('akan-notif-ack', onLocal); };
  }, []);
  const [toast, setToast] = useState<{ key: number; text: string; href: string } | null>(null);
  const [flying, setFlying] = useState(false);   // toast animating INTO the bell
  const seen = useRef<Set<string>>(new Set());
  const first = useRef(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  // What the SERVER says this person is an audience for — see
  // src/lib/alert-audience.ts. A REF, not state, for two reasons: nothing
  // renders from it, and if destFor() depended on a state value the poll effect
  // would restart the moment the audience arrived, re-seeding `seen` and
  // swallowing the chime for anything that landed in that window.
  const audRef = useRef<AlertAudience | null>(null);
  /** True once the server has said this person has no floor duty — poll paused. */
  const offFloor = useRef(false);

  /**
   * Where tapping an alert should go.
   *
   * Everyone with table duty keeps today's destination, /captain/requests, so
   * this can only change the landing for people it was already wrong for: a
   * kitchen-section or cashier login whose role cannot open the captain board at
   * all and used to be dropped on a blocked page.
   */
  const destFor = useCallback((kind: 'order' | 'service' | 'kot'): string => {
    const a = audRef.current;
    if (!a || a.captain) return REQUESTS_BOARD;
    if (a.kitchen && (kind === 'kot' || !a.cashier)) return KITCHEN_BOARD;
    if (a.cashier) return CASHIER_BOARD;
    return REQUESTS_BOARD;
  }, []);

  // ── Draggable floating bell ────────────────────────────────────────────────
  // Bell lives at a user-chosen (x,y) — default MIDDLE-RIGHT — draggable
  // anywhere, clamped on-screen, persisted in localStorage. `pos` is null until
  // measured on the client (avoids SSR window access).
  const BELL = 56;
  const MARGIN = 12;
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef({ active: false, moved: false, sx: 0, sy: 0, px: 0, py: 0 });
  const clamp = useCallback((p: { x: number; y: number }) => ({
    x: Math.max(MARGIN, Math.min(window.innerWidth - BELL - MARGIN, p.x)),
    y: Math.max(MARGIN, Math.min(window.innerHeight - BELL - MARGIN, p.y)),
  }), []);
  useEffect(() => {
    let saved: { x: number; y: number } | null = null;
    try { const r = localStorage.getItem('akan_bell_pos'); if (r) { const p = JSON.parse(r); if (typeof p?.x === 'number' && typeof p?.y === 'number') saved = p; } } catch {}
    setPos(clamp(saved ?? { x: window.innerWidth - BELL - MARGIN, y: Math.round(window.innerHeight / 2 - BELL / 2) }));
    const onResize = () => setPos(prev => (prev ? clamp(prev) : prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!pos) return;
    drag.current = { active: true, moved: false, sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current.active) return;
    const dx = e.clientX - drag.current.sx, dy = e.clientY - drag.current.sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.current.moved = true;
    setPos(clamp({ x: drag.current.px + dx, y: drag.current.py + dy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.current.active) return;
    drag.current.active = false;
    setPos(prev => { if (prev) { try { localStorage.setItem('akan_bell_pos', JSON.stringify(prev)); } catch {} } return prev; });
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

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

  // Action Inbox poll (approvals / requisitions / tasks) — 45s + on focus, like
  // the old header bell. Merged into this floating bell so it's the single hub.
  const loadInbox = useCallback(async () => {
    try {
      const r = await fetch('/api/notifications/inbox', { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) return;                       // signed out / error → keep last state
      const d = await r.json();
      const list: InboxItem[] = Array.isArray(d.items) ? d.items : [];
      // Re-surface acked buckets with NEW activity (count rose since last poll, or
      // reappeared after resolving) + drop acks for vanished buckets. Skip the very
      // first poll so we don't wipe the acks just restored from localStorage.
      if (!firstInbox.current) {
        setAck((a) => {
          const next = refreshInboxAcks(a, prevInboxCounts.current, list);
          if (next !== a) saveAck(next);
          return next;
        });
      }
      const counts: Record<string, number> = {};
      for (const it of list) counts[it.key] = Number(it.count) || 0;
      prevInboxCounts.current = counts;
      firstInbox.current = false;
      setInbox(list);
    } catch { /* offline — keep last state */ }
  }, []);
  useEffect(() => {
    if (suppressed) { setInbox([]); return; }
    loadInbox();
    const t = setInterval(loadInbox, 45000);
    window.addEventListener('focus', loadInbox);
    return () => { clearInterval(t); window.removeEventListener('focus', loadInbox); };
  }, [suppressed, loadInbox]);

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

  // Single poll for the whole app. The three feeds are already scoped to this
  // person server-side, so every row that comes back is theirs to act on.
  useEffect(() => {
    if (!meId) { setItems([]); audRef.current = null; return; }
    // New identity (fresh login on the same tab) → seed silently again so we
    // don't replay every pending alert as "new" (a burst of toasts + chimes).
    first.current = true;
    seen.current = new Set();
    offFloor.current = false;
    let stop = false;
    const poll = async () => {
      try {
        const [o, r, a] = await Promise.all([
          api('/api/dine-in/customer-orders').then((x) => x.json()).catch(() => ({})),
          api('/api/dine-in/service-requests').then((x) => x.json()).catch(() => ({})),
          api('/api/dine-in/kot-alerts?open=1').then((x) => x.json()).catch(() => ({})),
        ]);
        if (stop) return;
        // All three report the same audience; take whichever answered. A feed
        // that errored returns {} and simply doesn't vote.
        const next: AlertAudience | undefined = r?.audience || o?.audience || a?.audience;
        if (next) {
          audRef.current = next;
          // No floor duty at all (e.g. the Store Manager role): nothing here will
          // ever be for them. Stop the 8s poll rather than fetching three empty
          // lists forever; the focus handler below revives it after a role change.
          if (!next.live) { offFloor.current = true; setItems([]); return; }
        }
        const list: CaptainAlert[] = [];
        for (const ord of (o?.orders || [])) {
          list.push({ id: 'o:' + ord.id, text: `New order · Table ${ord.table?.number ?? '—'}`, href: destFor('order') });
        }
        for (const req of (r?.requests || [])) {
          const label = SERVICE_LABEL[String(req.type || '').toLowerCase()] || req.type || 'Request';
          // '—' where the other two lines use it: a request whose table row is
          // gone still has to read as a place, not as "Table null".
          list.push({ id: 's:' + req.id, text: `Table ${req.table_number || '—'} · ${label}`, href: destFor('service') });
        }
        for (const al of (a?.alerts || [])) {
          list.push({ id: 'a:' + al.id, text: `⚠ Kitchen issue · Table ${al.table_number || '—'}`, href: destFor('kot') });
        }
        setItems(list);
        const fresh = list.filter((it) => !seen.current.has(it.id));
        seen.current = new Set(list.map((it) => it.id)); // seen == present, so a returning id can re-alert
        if (first.current) { first.current = false; return; } // seed silently on first load
        // Alert on new items — but not while already standing on the board that
        // item would take you to (the captain watching /captain/requests, the
        // kitchen watching the KDS). Anything landing elsewhere still chimes.
        const here = window.location.pathname;
        const elsewhere = fresh.filter((f) => (f.href || REQUESTS_BOARD) !== here);
        if (elsewhere.length) {
          setToast({
            key: Date.now(),
            text: elsewhere.length === 1 ? elsewhere[0].text : `${elsewhere.length} new orders / requests`,
            href: elsewhere[0].href || REQUESTS_BOARD,
          });
          beep();
        }
      } catch { /* offline — keep last state */ }
    };
    const tick = () => { if (!offFloor.current) poll(); };
    // A role change mid-shift shouldn't need a reload: focus re-arms the poll.
    const onFocus = () => { offFloor.current = false; poll(); };
    poll();
    const t = setInterval(tick, 8000);
    window.addEventListener('focus', onFocus);
    return () => { stop = true; clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [meId, beep, destFor]);

  // New alert: pop at top-center, DWELL, then FLY into the bell icon, then clear.
  useEffect(() => {
    if (!toast) { setFlying(false); return; }
    setFlying(false);
    const t1 = setTimeout(() => setFlying(true), 1500);   // dwell top-center
    const t2 = setTimeout(() => setToast(null), 2300);    // after the ~0.8s flight
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [toast]);

  const count = items.length;                                        // live captain/table alerts (raw; feeds the sidebar tab badge)
  // The BELL badge counts only what the user hasn't cleared. Acked buckets stop
  // counting until their count grows again; acked live alerts until a new id.
  const unackedAlerts = items.filter((it) => !isAlertAcked(ack, it.id));
  const unackedInbox = inbox.filter((it) => !isInboxAcked(ack, it.key, it.count));
  const totalCount = unackedAlerts.length + unackedInbox.reduce((s, i) => s + (Number(i.count) || 0), 0);
  // Tapping an alert acknowledges it and lands on ITS board (see destFor) —
  // /captain/requests for anyone with table duty, which is everyone this used to
  // work for. The bare fallback keeps a caller with no href on the old path.
  const goRequests = (id?: string, href?: string) => {
    if (id) { const n = ackAlertId(ack, id); setAck(n); saveAck(n); }
    setOpen(false); setToast(null); router.push(href || REQUESTS_BOARD);
  };
  const goInbox = (item: InboxItem) => {
    const n = ackInboxItem(ack, item.key, item.count); setAck(n); saveAck(n);
    setOpen(false); router.push(item.href);
  };
  // "Clear all" — acknowledge everything currently showing; the badge goes to 0
  // and the floating bell hides until there's genuinely new activity.
  const clearAll = () => {
    const n = ackEverything(ack, inbox.map((i) => ({ key: i.key, count: i.count })), items.map((i) => ({ id: i.id })));
    setAck(n); saveAck(n); setOpen(false);
  };
  // Prune stale ack entries (resolved buckets / old alert ids) when the user
  // opens the bell — low-frequency, so no per-poll churn.
  useEffect(() => {
    if (!open) return;
    setAck((prev) => {
      const pruned = pruneAck(prev, inbox.map((i) => i.key), items.map((i) => i.id));
      const shrunk = Object.keys(pruned.inbox).length < Object.keys(prev.inbox).length || pruned.alerts.length < prev.alerts.length;
      if (shrunk) saveAck(pruned);
      return shrunk ? pruned : prev;
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- snapshot prune on open only

  // Which way the panel opens, based on where the (draggable) bell sits. The
  // `pos ? … : true` guards keep `window` off the SSR path.
  const rightSide = pos ? pos.x + BELL / 2 > window.innerWidth / 2 : true;
  const bottomSide = pos ? pos.y + BELL / 2 > window.innerHeight / 2 : true;
  const dropStyle: React.CSSProperties = {};
  if (rightSide) dropStyle.right = 0; else dropStyle.left = 0;
  if (bottomSide) dropStyle.bottom = BELL + 8; else dropStyle.top = BELL + 8;

  // Stable context value so consumers (e.g. CaptainShell's sidebar badge) don't
  // re-render on every bell drag/toast/open state change — only when items change.
  const ctxValue = useMemo(() => ({ items, count }), [items, count]);

  return (
    <Ctx.Provider value={ctxValue}>
      {children}

      {/* New-alert toast — pops at TOP-CENTER, then FLIES into the bell icon.
          z-40 keeps it below the app's modal layer (z-50); the chime still fires. */}
      {toast && !suppressed && pos && (
        <button
          onClick={() => goRequests(undefined, toast.href)}
          style={{
            transform: flying
              ? `translate(calc(-50% + ${Math.round(pos.x + BELL / 2 - window.innerWidth / 2)}px), ${Math.round(pos.y + BELL / 2 - 28)}px) scale(0.1)`
              : 'translate(-50%, 0)',
            opacity: flying ? 0 : 1,
            transition: 'transform 0.8s cubic-bezier(.5,0,.75,0), opacity 0.8s ease-in',
          }}
          className="fixed top-3 left-1/2 z-40 flex items-center gap-2 max-w-[92vw] bg-[#af4408] text-white pl-3 pr-2 py-2.5 rounded-full shadow-2xl ring-1 ring-white/20"
        >
          <Bell className="w-4 h-4 shrink-0" />
          <span className="text-sm font-semibold truncate">{toast.text}</span>
          <span className="shrink-0 text-[11px] font-bold bg-white/20 px-2 py-0.5 rounded-full">View</span>
        </button>
      )}

      {/* Floating bell — DRAGGABLE, default middle-right, position persisted.
          Above page content but BELOW modals/sheets (z-40 < the app's z-50
          dialog layer). Shown whenever there are alerts. */}
      {totalCount > 0 && !suppressed && pos && (
        <div ref={rootRef} className="fixed z-40" style={{ left: pos.x, top: pos.y }}>
          {open && (
            <div className="absolute w-72 max-w-[calc(100vw-2.5rem)] bg-white text-[#2D1B0E] rounded-xl shadow-2xl border border-[#E8D5C4] overflow-hidden"
                 style={dropStyle}>
              <div className="flex items-center justify-between px-4 py-2 bg-[#FFF7EF] border-b border-[#F0E4D6]">
                <span className="text-[11px] font-bold uppercase tracking-wide text-[#8B7355]">Needs your action</span>
                <div className="flex items-center gap-2.5">
                  {(items.length > 0 || inbox.length > 0) && (
                    <button onClick={clearAll} title="Clear all notifications"
                            className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#af4408] hover:underline active:scale-95">
                      <CheckCheck className="w-3.5 h-3.5" /> Clear all
                    </button>
                  )}
                  <button onClick={() => setOpen(false)} className="text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-4 h-4" /></button>
                </div>
              </div>
              <div className="max-h-80 overflow-y-auto divide-y divide-[#F0E4D6]">
                {/* Live table alerts first (time-sensitive), then Action Inbox. */}
                {items.map((it) => (
                  <button key={it.id} onClick={() => goRequests(it.id, it.href)} className="w-full text-left px-4 py-2.5 text-sm hover:bg-[#FFF1E3]">{it.text}</button>
                ))}
                {inbox.map((it) => (
                  <button key={it.key} onClick={() => goInbox(it)}
                          className="w-full flex items-center gap-2 text-left px-4 py-2.5 text-sm hover:bg-[#FFF1E3]">
                    <span className="flex-1 min-w-0">{it.label}</span>
                    <span className="shrink-0 min-w-[22px] h-[22px] px-1.5 rounded-full bg-[#af4408] text-white text-[11px] font-bold flex items-center justify-center">
                      {it.count > 99 ? '99+' : it.count}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <button
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onClick={() => { if (drag.current.moved) { drag.current.moved = false; return; } setOpen((v) => !v); }}
            aria-label={`Notifications: ${totalCount} need your action. Drag to move.`}
            title="Tap to open · drag to move"
            style={{ touchAction: 'none' }}
            className="relative flex items-center justify-center w-14 h-14 rounded-full bg-[#af4408] text-white shadow-2xl ring-2 ring-white/40 cursor-grab active:cursor-grabbing hover:bg-[#8a3506] transition-colors"
          >
            <Bell className="w-6 h-6 pointer-events-none" />
            <span className="absolute -top-1 -right-1 min-w-[22px] h-[22px] px-1 rounded-full bg-white text-[#af4408] text-[12px] font-extrabold flex items-center justify-center ring-2 ring-[#af4408] pointer-events-none">
              {totalCount > 99 ? '99+' : totalCount}
            </span>
          </button>
        </div>
      )}
    </Ctx.Provider>
  );
}
