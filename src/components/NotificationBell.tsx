'use client';

/**
 * NotificationBell — the global "Action Inbox" bell.
 *
 * Polls GET /api/notifications/inbox (live COUNTs of pending states for the
 * signed-in user — no notifications table) every 45s and on window focus.
 * Tap → dropdown panel listing "NEEDS YOUR ACTION" buckets; tapping a row
 * navigates to the owning page. Items with count 0 never arrive (API omits
 * them); an empty inbox shows "All clear ✓".
 *
 * Mounted in three headers:
 *   - UserBar (desktop floating pill)         → light chrome, panel drops right
 *   - MobileTopBar (dark strip, < lg)         → dark chrome
 *   - Captain sidebar header (dark, tablet)   → dark chrome, panel opens leftward
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell, CheckCheck } from 'lucide-react';
import {
  loadAck, saveAck, ackInboxItem, ackEverything, refreshInboxAcks, isInboxAcked, type AckState,
} from '@/lib/notif-ack';

interface InboxItem { key: string; label: string; count: number; href: string }

export default function NotificationBell({
  dark = false,
  align = 'right',
}: {
  /** Dark chrome (MobileTopBar / Captain sidebar) vs light (UserBar pill). */
  dark?: boolean;
  /** Which bell edge the panel is anchored to; 'left' opens the panel rightward. */
  align?: 'right' | 'left';
}) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState<AckState>({ inbox: {}, alerts: [] });
  const rootRef = useRef<HTMLDivElement>(null);
  const prevCounts = useRef<Record<string, number>>({});
  const firstLoad = useRef(true);

  // Acknowledged notifications (shared with the floating bell, per device).
  useEffect(() => {
    setAck(loadAck());
    const onStorage = (e: StorageEvent) => { if (e.key === 'akan_notif_ack') setAck(loadAck()); };
    const onLocal = () => setAck(loadAck());   // same-tab sync (see saveAck)
    window.addEventListener('storage', onStorage);
    window.addEventListener('akan-notif-ack', onLocal);
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('akan-notif-ack', onLocal); };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/notifications/inbox', { cache: 'no-store' });
      if (!r.ok) return;                      // signed out / error → keep last state
      const d = await r.json();
      const list: InboxItem[] = Array.isArray(d.items) ? d.items : [];
      // Re-surface acked buckets with NEW activity + drop acks for vanished ones
      // (skip the first poll so restored-from-storage acks aren't wiped).
      if (!firstLoad.current) {
        setAck((a) => {
          const next = refreshInboxAcks(a, prevCounts.current, list);
          if (next !== a) saveAck(next);
          return next;
        });
      }
      const counts: Record<string, number> = {};
      for (const it of list) counts[it.key] = Number(it.count) || 0;
      prevCounts.current = counts;
      firstLoad.current = false;
      setItems(list);
      setTotal(Number(d.total) || 0);
    } catch { /* offline — keep last state */ }
  }, []);

  // Poll every 45s + refresh when the tab regains focus.
  useEffect(() => {
    load();
    const t = setInterval(load, 45000);
    window.addEventListener('focus', load);
    return () => { clearInterval(t); window.removeEventListener('focus', load); };
  }, [load]);

  // Close on outside tap / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
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

  // Badge counts only UN-acknowledged work (a cleared item stops counting until
  // its count grows again). `total` (raw) is kept for the empty-state check.
  const badgeTotal = items.filter(it => !isInboxAcked(ack, it.key, it.count))
    .reduce((s, i) => s + (Number(i.count) || 0), 0);
  const badge = badgeTotal > 99 ? '99+' : String(badgeTotal);
  const clearAll = () => {
    const n = ackEverything(ack, items.map(i => ({ key: i.key, count: i.count })), []);
    setAck(n); saveAck(n);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => { setOpen(o => !o); if (!open) load(); }}
        aria-label={badgeTotal > 0 ? `Notifications: ${badgeTotal} items need your action` : 'Notifications'}
        title="Notifications"
        className={`relative flex items-center justify-center w-9 h-9 rounded-full transition-colors active:scale-95 ${
          dark ? 'text-[#E8D5C4] hover:bg-white/10' : 'text-[#6B5744] hover:text-[#2D1B0E] hover:bg-[#FFF1E3]'}`}
      >
        <Bell className="w-[18px] h-[18px]" />
        {badgeTotal > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[#af4408] text-white text-[10px] font-bold flex items-center justify-center leading-none ring-2 ring-white/90">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-11 z-[90] w-72 max-w-[calc(100vw-1rem)]
                      bg-white border border-[#E8D5C4] rounded-xl shadow-xl overflow-hidden`}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-[#E8D5C4] bg-[#FFF8F0]">
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#8B7355]">Needs your action</p>
            {items.length > 0 && (
              <button onClick={clearAll} title="Clear all notifications"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#af4408] hover:underline active:scale-95">
                <CheckCheck className="w-3.5 h-3.5" /> Clear all
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-3 py-6 text-sm text-center text-[#8B7355]">All clear ✓</p>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto divide-y divide-[#F0E4D6]">
              {items.map(it => (
                <li key={it.key}>
                  <Link
                    href={it.href}
                    onClick={() => { const n = ackInboxItem(ack, it.key, it.count); setAck(n); saveAck(n); setOpen(false); }}
                    className="flex items-center gap-2 px-3 py-2.5 hover:bg-[#FFF1E3] transition-colors"
                  >
                    <span className="flex-1 min-w-0 text-sm text-[#2D1B0E] leading-snug">{it.label}</span>
                    <span className="shrink-0 min-w-[22px] h-[22px] px-1.5 rounded-full bg-[#af4408] text-white text-[11px] font-bold flex items-center justify-center">
                      {it.count > 99 ? '99+' : it.count}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
