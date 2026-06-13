'use client';
import { usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import UserBar from '@/components/UserBar';
import MobileTopBar from '@/components/MobileTopBar';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Login + print pages render full-screen without sidebar/userbar chrome.
  const bare = pathname === '/login' || pathname.includes('/print');

  if (bare) return <>{children}</>;

  return (
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
}
