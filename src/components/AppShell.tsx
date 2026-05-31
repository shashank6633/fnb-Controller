'use client';
import { usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import UserBar from '@/components/UserBar';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Login + print pages render full-screen without sidebar/userbar chrome.
  const bare = pathname === '/login' || pathname.includes('/print');

  if (bare) return <>{children}</>;

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0 relative">
        <UserBar />
        <div className="w-full px-4 sm:px-6 lg:px-8 pt-16 sm:pt-6 lg:pt-8 pb-6 lg:pb-8">
          {children}
        </div>
      </main>
    </div>
  );
}
