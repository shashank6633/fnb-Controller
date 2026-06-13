'use client';

/**
 * Mobile-only top bar — visible below `lg:` breakpoint, hidden on desktop.
 *
 * Replaces the floating hamburger + floating UserBar pills that were
 * overlapping page headings on small screens. Sticky full-width strip with:
 *   - ☰ hamburger on the left → dispatches a window event the Sidebar
 *     listens for (no prop drilling, no shared context needed)
 *   - "F&B Controller" brand wordmark in the middle
 *   - User initial chip on the right with logout on tap
 *
 * The Sidebar's old in-component floating hamburger has been removed; this
 * is the single source of truth for "open the menu" on mobile.
 *
 * Hidden entirely on /login and on any /[*]/print routes — those render full-screen.
 */

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Menu, LogOut, UtensilsCrossed } from 'lucide-react';
import { api } from '@/lib/api';

interface SessionUser { email: string; name: string; role: string; }

export default function MobileTopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const bare = pathname === '/login' || pathname.includes('/print');

  useEffect(() => {
    if (bare) return;
    fetch('/api/auth/me').then(r => r.json()).then(d => setUser(d?.user || null)).catch(() => {});
  }, [bare, pathname]);

  if (bare) return null;

  const openSidebar = () => {
    // Sidebar listens for this event and opens its mobile drawer. Avoids
    // shared-state coupling between two top-level components.
    window.dispatchEvent(new CustomEvent('fnb:open-sidebar'));
  };

  const logout = async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
    router.replace('/login');
  };

  const initial = (user?.name || user?.email || '?').slice(0, 1).toUpperCase();

  return (
    <header className="lg:hidden sticky top-0 z-40 h-12 bg-[#1C0F05] border-b border-[#3D2614]
                       flex items-center justify-between px-3 shadow-sm">
      {/* Left: hamburger + brand */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <button
          onClick={openSidebar}
          aria-label="Open menu"
          className="flex items-center justify-center w-9 h-9 rounded-md text-[#E8D5C4] hover:bg-[#2E1A0C] active:bg-[#3D2614] transition-colors">
          <Menu size={20} />
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <UtensilsCrossed size={16} className="text-[#af4408] shrink-0" />
          <span className="text-sm font-semibold text-white truncate">F&B Controller</span>
        </div>
      </div>

      {/* Right: user chip (tap → logout menu) */}
      {user && (
        <div className="relative">
          <button
            onClick={() => setMenuOpen(o => !o)}
            aria-label="User menu"
            className="flex items-center justify-center w-9 h-9 rounded-full bg-[#af4408] text-white text-sm font-semibold">
            {initial}
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-11 z-40 w-56 bg-white border border-[#E8D5C4] rounded-lg shadow-lg overflow-hidden">
                <div className="px-3 py-2 border-b border-[#E8D5C4]">
                  <div className="text-sm font-medium text-[#2D1B0E] truncate">{user.name || '—'}</div>
                  <div className="text-[10px] text-[#8B7355] truncate">{user.email}</div>
                  <div className="text-[10px] text-[#af4408] uppercase tracking-wide mt-0.5">{user.role}</div>
                </div>
                <button onClick={logout}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-700 hover:bg-red-50 transition-colors">
                  <LogOut size={14} /> Log out
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </header>
  );
}
