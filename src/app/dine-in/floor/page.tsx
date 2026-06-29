'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { ShoppingCart, Loader2, Plus } from 'lucide-react';

interface TableTile {
  id: string;
  table_number: string;
  zone: string;
  seats: number;
  open_order_id: string | null;
  open_order_number: number | null;
  open_order_total: number | null;
}

export default function FloorPage() {
  const router = useRouter();
  const [tables, setTables] = useState<TableTile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api('/api/dine-in/tables');
      const j = await r.json();
      setTables(j.items || []);
    } catch (_) {} finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function openTable(t: TableTile) {
    if (t.open_order_id) { router.push(`/dine-in/order/${t.open_order_id}`); return; }
    setBusy(t.id);
    try {
      const r = await api('/api/dine-in/orders', { method: 'POST', body: { table_id: t.id, order_type: 'dine-in' } });
      const j = await r.json();
      if (j.error) { alert(j.error); return; }
      router.push(`/dine-in/order/${j.id}`);
    } finally { setBusy(null); }
  }

  async function newTakeaway() {
    const r = await api('/api/dine-in/orders', { method: 'POST', body: { order_type: 'takeaway' } });
    const j = await r.json();
    if (j.error) { alert(j.error); return; }
    router.push(`/dine-in/order/${j.id}`);
  }

  const zones = Array.from(new Set(tables.map((t) => t.zone || 'Floor')));

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#af4408]/10 rounded-lg"><ShoppingCart className="w-6 h-6 text-[#af4408]" /></div>
          <div>
            <h1 className="text-2xl font-bold text-[#af4408]">Order Floor</h1>
            <p className="text-sm text-[#8B7355]">Tap a table to start or continue an order</p>
          </div>
        </div>
        <button onClick={newTakeaway} className="flex items-center gap-2 border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 px-4 py-2.5 rounded-lg text-sm font-medium">
          <Plus size={16} /> Takeaway order
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-[#8B7355]">Loading…</div>
      ) : tables.length === 0 ? (
        <div className="card text-center py-12 text-[#8B7355]">
          No tables yet. <a href="/dine-in/tables" className="text-[#af4408] hover:underline">Set up tables →</a>
        </div>
      ) : zones.map((zone) => (
        <div key={zone} className="mb-6">
          <h2 className="text-sm font-semibold text-[#6B5744] mb-2">{zone}</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {tables.filter((t) => (t.zone || 'Floor') === zone).map((t) => {
              const occupied = !!t.open_order_id;
              return (
                <button key={t.id} onClick={() => openTable(t)} disabled={busy === t.id}
                  className={`relative rounded-xl p-4 text-left border transition-colors disabled:opacity-60 ${
                    occupied ? 'bg-amber-500/15 border-amber-400 hover:bg-amber-500/25'
                             : 'bg-green-500/10 border-green-300 hover:bg-green-500/20'}`}>
                  <p className="text-lg font-bold text-[#2D1B0E]">{t.table_number}</p>
                  <p className="text-[11px] text-[#8B7355]">{t.seats} seats</p>
                  {occupied ? (
                    <p className="mt-1 text-xs font-medium text-amber-700">₹{Math.round(t.open_order_total || 0)} · #{t.open_order_number}</p>
                  ) : (
                    <p className="mt-1 text-xs font-medium text-green-700">Free</p>
                  )}
                  {busy === t.id && <Loader2 className="absolute top-2 right-2 w-4 h-4 animate-spin text-[#af4408]" />}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
