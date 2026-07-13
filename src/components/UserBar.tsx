'use client';
import { useEffect, useState } from 'react';
import { LogOut, ShieldCheck, User as UserIcon, Store } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import NotificationBell from '@/components/NotificationBell';

interface SessionUser { id: string; email: string; name: string; role: 'admin' | 'manager'; }
interface Outlet { id: string; name: string; is_default: number; }

export default function UserBar() {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [currentOutletId, setCurrentOutletId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (pathname === '/login') { setLoading(false); return; }
    fetch('/api/auth/me').then(r => r.json()).then(d => {
      setUser(d.user);
      if (!d.user && !pathname.includes('/print')) {
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      }
    }).finally(() => setLoading(false));
    fetch('/api/outlets').then(r => r.json()).then(d => {
      setOutlets(d.outlets || []);
      setCurrentOutletId(d.current_outlet_id || null);
    });
  }, [pathname, router]);

  const switchOutlet = async (id: string) => {
    const r = await api('/api/outlets/switch', { method: 'POST', body: { outlet_id: id } });
    if (!r.ok) { alert('Failed to switch outlet'); return; }
    setCurrentOutletId(id);
    router.refresh();
    setTimeout(() => window.location.reload(), 150);   // hard reload so all data refetches under new outlet
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    setUser(null);
    router.push('/login');
  };

  if (pathname === '/login' || pathname.includes('/print')) return null;
  if (loading || !user) return null;

  const currentOutlet = outlets.find(o => o.id === currentOutletId);

  return (
    // Desktop-only chrome (hidden on mobile — folded into <MobileTopBar />).
    // On small screens the floating pill collided with page headings.
    <div className="hidden lg:flex fixed top-3 right-4 z-30 items-center gap-2 bg-white border border-[#E8D5C4] rounded-full pl-3 pr-1 py-1 shadow-sm">
      {/* Outlet picker — only show if more than one outlet */}
      {outlets.length > 1 ? (
        <label className="inline-flex items-center gap-1 text-[#6B5744]" title="Current outlet">
          <Store className="w-3.5 h-3.5" />
          <select value={currentOutletId || ''} onChange={e => switchOutlet(e.target.value)}
                  className="text-xs bg-transparent font-medium text-[#2D1B0E] focus:outline-none cursor-pointer">
            {outlets.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      ) : currentOutlet ? (
        <span className="inline-flex items-center gap-1 text-xs text-[#6B5744]" title="Outlet">
          <Store className="w-3.5 h-3.5" /> {currentOutlet.name}
        </span>
      ) : null}

      <span className="text-[#E8D5C4]">·</span>

      {/* Action-inbox bell — left of the user identity chip */}
      <NotificationBell />

      {user.role === 'admin' ? <ShieldCheck className="w-3.5 h-3.5 text-[#af4408]" /> : <UserIcon className="w-3.5 h-3.5 text-[#6B5744]" />}
      <span className="text-xs font-medium text-[#2D1B0E]">{user.name || user.email}</span>
      <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${user.role === 'admin' ? 'bg-[#af4408] text-white' : 'bg-gray-200 text-[#6B5744]'}`}>
        {user.role}
      </span>
      <button onClick={logout} title="Sign out"
              className="p-1.5 rounded-full text-[#6B5744] hover:text-red-600 hover:bg-red-50">
        <LogOut className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
