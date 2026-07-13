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
import { Bell } from 'lucide-react';

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
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/notifications/inbox', { cache: 'no-store' });
      if (!r.ok) return;                      // signed out / error → keep last state
      const d = await r.json();
      setItems(Array.isArray(d.items) ? d.items : []);
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

  const badge = total > 99 ? '99+' : String(total);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => { setOpen(o => !o); if (!open) load(); }}
        aria-label={total > 0 ? `Notifications: ${total} items need your action` : 'Notifications'}
        title="Notifications"
        className={`relative flex items-center justify-center w-9 h-9 rounded-full transition-colors active:scale-95 ${
          dark ? 'text-[#E8D5C4] hover:bg-white/10' : 'text-[#6B5744] hover:text-[#2D1B0E] hover:bg-[#FFF1E3]'}`}
      >
        <Bell className="w-[18px] h-[18px]" />
        {total > 0 && (
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
          <div className="px-3 py-2 border-b border-[#E8D5C4] bg-[#FFF8F0]">
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#8B7355]">Needs your action</p>
          </div>
          {items.length === 0 ? (
            <p className="px-3 py-6 text-sm text-center text-[#8B7355]">All clear ✓</p>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto divide-y divide-[#F0E4D6]">
              {items.map(it => (
                <li key={it.key}>
                  <Link
                    href={it.href}
                    onClick={() => setOpen(false)}
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
