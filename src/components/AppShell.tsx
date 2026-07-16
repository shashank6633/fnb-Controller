'use client';
import { usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import UserBar from '@/components/UserBar';
import MobileTopBar from '@/components/MobileTopBar';
import CaptainAlertsProvider from '@/components/CaptainAlertsProvider';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Login, the dedicated full-screen PRINT views, and the mobile Captain app
  // render chrome-less (no sidebar/userbar). Match a real `/print` path SEGMENT
  // (/print/agent, /grn/print/[id], /purchase-orders/[id]/print) — NOT the bare
  // substring, which wrongly stripped /settings/print-design and
  // /dine-in/offline-print of their sidebar + back nav.
  const isPrintView = /\/print(\/|$)/.test(pathname);
  const bare = pathname === '/login' || isPrintView || pathname.startsWith('/captain');

  // The floating captain-alert bell + toast wraps EVERY route (bare or not) so a
  // captain who has left the board still gets their table alerts on top of any
  // screen. It renders nothing (no bell) until there's an alert.
  const inner = bare ? (
    <>{children}</>
  ) : (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0 relative">
        {/* Mobile-only top bar — sticky, owns the hamburger + brand + user
            chip. Hidden on lg: where the floating UserBar pill takes over. */}
        <MobileTopBar />
        <UserBar />
        {/* Content padding:
              mobile  → tight (px-3) so tables + cards have breathing room
              tablet  → px-5
              desktop → px-8
            Top padding is small on mobile because MobileTopBar is already sticky
            in flow (h-12) and pushes content naturally; was pt-16 before to
            clear the floating hamburger that no longer exists. */}
        <div className="w-full px-3 sm:px-5 lg:px-8 pt-3 sm:pt-5 lg:pt-8 pb-6 lg:pb-8">
          {children}
        </div>
      </main>
    </div>
  );

  return <CaptainAlertsProvider>{inner}</CaptainAlertsProvider>;
}
