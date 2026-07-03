'use client';

import { useEffect, useState, useCallback, useMemo, useContext } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Loader2, Utensils, ChevronRight, Receipt, Menu } from 'lucide-react';
import { CaptainUI } from './CaptainShell';

interface TableTile {
  id: string; table_number: string; zone: string; seats: number;
  open_order_id: string | null; open_order_number: number | null; open_order_total: number | null;
  open_order_server_id?: string | null;   // the captain who opened the table
}

/** Captain landing — an at-a-glance view of running tables. The floors/tables
 *  selector lives in the shell sidebar (or the "Tables" drawer on phones). */
export default function CaptainHome() {
  const router = useRouter();
  const { openTables } = useContext(CaptainUI);
  const [tables, setTables] = useState<TableTile[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try { const r = await api('/api/dine-in/tables'); const j = await r.json(); setTables(j.items || []); }
    catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => {
    load();
    fetch('/api/auth/me').then((r) => r.json()).then((d) => setMeId(d?.user?.id || null)).catch(() => {});
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  // "My" running tables = the open tables THIS captain opened (per their choice
  // to see only their own sales, not the whole floor).
  const open = useMemo(() => tables
    .filter((t) => t.open_order_id && t.open_order_server_id === meId)
    .sort((a, b) => (b.open_order_total || 0) - (a.open_order_total || 0)), [tables, meId]);
  const liveTotal = open.reduce((s, t) => s + (t.open_order_total || 0), 0);

  return (
    <div className="p-4 sm:p-6 pb-24 lg:pb-6 max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button onClick={openTables} className="md:hidden p-2 -ml-2 rounded-lg bg-[#1C0F05] text-white active:scale-95" aria-label="Open tables">
            <Menu className="w-5 h-5" />
          </button>
          <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">My tables</h1>
        </div>
        <div className="text-right">
          <p className="text-[11px] text-[#8B7355] leading-none">My sales</p>
          <p className="font-extrabold text-[#af4408] text-lg leading-tight">{meId ? `₹${Math.round(liveTotal)}` : '…'}</p>
        </div>
      </div>

      {loading ? (
        <div className="py-20 text-center text-[#8B7355]"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
      ) : open.length === 0 ? (
        <div className="text-center py-16 px-6 bg-white border border-[#E8D5C4] rounded-2xl">
          <Utensils className="w-10 h-10 mx-auto text-[#D4B896] mb-3" />
          <p className="font-semibold text-[#2D1B0E]">No open tables of yours right now</p>
          <p className="text-sm text-[#8B7355] mt-1">Pick a table from the sidebar (or the <b>Tables</b> button on phones) to start an order, or begin a Takeaway. Tables show your live sales here once you open them.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {open.map((t) => (
            <button key={t.id} onClick={() => router.push(`/captain/order/${t.open_order_id}`)}
              className="bg-white border border-amber-300 rounded-2xl p-4 text-left active:scale-[0.98] transition">
              <div className="flex items-center justify-between">
                <span className="text-lg font-extrabold text-[#2D1B0E]">{t.zone ? `${t.table_number}` : t.table_number}</span>
                <ChevronRight className="w-4 h-4 text-[#8B7355]" />
              </div>
              <p className="text-[11px] text-[#8B7355]">{t.zone || 'Floor'} · #{t.open_order_number}</p>
              <p className="mt-2 flex items-center gap-1 font-bold text-amber-700"><Receipt className="w-4 h-4" /> ₹{Math.round(t.open_order_total || 0)}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
