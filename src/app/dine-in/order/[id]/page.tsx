'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { ArrowLeft, Plus, Minus, Trash2, Loader2, Search } from 'lucide-react';

interface MenuItem { id: string; name: string; category: string; station: string; selling_price: number; recipe_id: string | null; is_active: number; }
interface OrderItem { id: string; name: string; quantity: number; unit_price: number; line_total: number; }
interface Order {
  id: string; order_number: number; status: string; order_type: string;
  table_number: string | null; zone: string | null;
  subtotal: number; tax_total: number; discount: number; total: number;
  items: OrderItem[];
}

function rupee(n: number) { return '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN'); }

export default function OrderTerminalPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [cat, setCat] = useState<string>('All');
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [settleOpen, setSettleOpen] = useState(false);
  const [settling, setSettling] = useState(false);

  const loadOrder = useCallback(async () => {
    const r = await api(`/api/dine-in/orders/${id}`);
    const j = await r.json();
    if (j.order) setOrder(j.order);
  }, [id]);

  useEffect(() => {
    loadOrder();
    fetch('/api/menu-items').then((r) => r.json()).then((j) => setMenu((j.items || []).filter((m: MenuItem) => m.is_active)));
  }, [loadOrder]);

  const categories = useMemo(() => ['All', ...Array.from(new Set(menu.map((m) => m.category || 'Other')))], [menu]);
  const visible = useMemo(() => menu.filter((m) =>
    (cat === 'All' || (m.category || 'Other') === cat) &&
    (!q || m.name.toLowerCase().includes(q.toLowerCase()))), [menu, cat, q]);

  async function patch(body: any, key: string) {
    setPending(key);
    try {
      const r = await api(`/api/dine-in/orders/${id}`, { method: 'PATCH', body });
      const j = await r.json();
      if (j.error) alert(j.error);
      else if (j.order) setOrder(j.order);
    } finally { setPending(null); }
  }

  async function settle(method: string) {
    setSettling(true);
    try {
      const r = await api(`/api/dine-in/orders/${id}/settle`, { method: 'POST', body: { payment_method: method } });
      const j = await r.json();
      if (j.error) { alert(j.error); return; }
      router.push('/dine-in/floor');
    } finally { setSettling(false); }
  }

  async function voidOrder() {
    if (!confirm('Void this order? No sale will be recorded.')) return;
    const r = await api(`/api/dine-in/orders/${id}/void`, { method: 'POST', body: {} });
    const j = await r.json();
    if (j.error) alert(j.error); else router.push('/dine-in/floor');
  }

  if (!order) return <div className="text-center py-12 text-[#8B7355]">Loading order…</div>;
  const settled = order.status !== 'open';

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push('/dine-in/floor')} className="p-2 rounded-lg hover:bg-[#FFF1E3]"><ArrowLeft size={18} className="text-[#6B5744]" /></button>
          <div>
            <h1 className="text-xl font-bold text-[#af4408]">
              {order.table_number ? `Table ${order.table_number}` : order.order_type} · #{order.order_number}
            </h1>
            <p className="text-xs text-[#8B7355]">{order.zone || order.order_type}{settled && ` · ${order.status}`}</p>
          </div>
        </div>
        {!settled && <button onClick={voidOrder} className="text-xs text-red-600 hover:underline">Void</button>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Menu browser */}
        <div className="lg:col-span-3">
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search menu…"
              className="w-full bg-white border border-[#E8D5C4] rounded-lg pl-9 pr-3 py-2 text-sm" />
          </div>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {categories.map((c) => (
              <button key={c} onClick={() => setCat(c)}
                className={`text-xs px-2.5 py-1 rounded-full ${cat === c ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>{c}</button>
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[60vh] overflow-y-auto pr-1">
            {visible.map((m) => {
              const noPrice = !(m.selling_price > 0);
              return (
                <button key={m.id} disabled={settled || noPrice || pending === m.id}
                  onClick={() => patch({ action: 'add_item', menu_item_id: m.id }, m.id)}
                  title={noPrice ? 'No price — set it on the Menu Items page first' : ''}
                  className={`text-left rounded-lg border p-2.5 transition-colors ${
                    noPrice ? 'bg-[#F5EDE2] border-[#E8D5C4] opacity-60 cursor-not-allowed'
                            : 'bg-white border-[#E8D5C4] hover:border-[#af4408] hover:bg-[#af4408]/5'}`}>
                  <p className="text-sm font-medium text-[#2D1B0E] leading-tight line-clamp-2">{m.name}</p>
                  <p className={`text-xs mt-1 ${noPrice ? 'text-red-500' : 'text-[#6B5744]'}`}>{noPrice ? 'Set price' : rupee(m.selling_price)}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Order panel */}
        <div className="lg:col-span-2">
          <div className="card p-4 sticky top-4">
            <h2 className="font-semibold text-[#2D1B0E] mb-3">Current order</h2>
            <div className="space-y-2 max-h-[42vh] overflow-y-auto mb-3">
              {order.items.length === 0 ? (
                <p className="text-sm text-[#8B7355] text-center py-6">No items yet — tap the menu to add.</p>
              ) : order.items.map((it) => (
                <div key={it.id} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-[#2D1B0E] truncate">{it.name}</p>
                    <p className="text-[11px] text-[#8B7355]">{rupee(it.unit_price)} each</p>
                  </div>
                  {!settled && (
                    <div className="flex items-center gap-1">
                      <button onClick={() => patch({ action: 'set_qty', item_id: it.id, quantity: it.quantity - 1 }, it.id)}
                        className="p-1 rounded bg-[#FFF1E3] hover:bg-[#E8D5C4]"><Minus size={12} /></button>
                      <span className="w-6 text-center text-sm">{it.quantity}</span>
                      <button onClick={() => patch({ action: 'set_qty', item_id: it.id, quantity: it.quantity + 1 }, it.id)}
                        className="p-1 rounded bg-[#FFF1E3] hover:bg-[#E8D5C4]"><Plus size={12} /></button>
                    </div>
                  )}
                  <span className="w-16 text-right text-sm font-medium text-[#2D1B0E]">{rupee(it.line_total)}</span>
                  {!settled && <button onClick={() => patch({ action: 'remove_item', item_id: it.id }, it.id)} className="text-red-400 hover:text-red-600"><Trash2 size={14} /></button>}
                </div>
              ))}
            </div>

            <div className="border-t border-[#E8D5C4] pt-3 space-y-1 text-sm">
              <div className="flex justify-between text-[#6B5744]"><span>Subtotal</span><span>{rupee(order.subtotal)}</span></div>
              <div className="flex justify-between text-[#6B5744]"><span>Tax</span><span>{rupee(order.tax_total)}</span></div>
              {order.discount > 0 && <div className="flex justify-between text-[#6B5744]"><span>Discount</span><span>−{rupee(order.discount)}</span></div>}
              <div className="flex justify-between font-bold text-[#2D1B0E] text-base pt-1"><span>Total</span><span>{rupee(order.total)}</span></div>
            </div>

            {!settled && (
              <button onClick={() => setSettleOpen(true)} disabled={order.items.length === 0}
                className="w-full mt-4 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white py-2.5 rounded-lg text-sm font-medium">
                Settle {rupee(order.total)}
              </button>
            )}
            {settled && <p className="mt-4 text-center text-sm text-green-700 font-medium">Order {order.status}</p>}
          </div>
        </div>
      </div>

      {settleOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => !settling && setSettleOpen(false)}>
          <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-semibold text-[#2D1B0E] mb-1">Settle order</h2>
            <p className="text-sm text-[#8B7355] mb-4">Total due <strong className="text-[#af4408]">{rupee(order.total)}</strong> — choose payment method.</p>
            <div className="grid grid-cols-3 gap-2">
              {['cash', 'upi', 'card'].map((m) => (
                <button key={m} onClick={() => settle(m)} disabled={settling}
                  className="border border-[#D4B896] hover:border-[#af4408] hover:bg-[#af4408]/5 rounded-lg py-3 text-sm font-medium capitalize disabled:opacity-50">
                  {settling ? <Loader2 size={14} className="animate-spin mx-auto" /> : m}
                </button>
              ))}
            </div>
            <button onClick={() => setSettleOpen(false)} disabled={settling} className="w-full mt-3 text-xs text-[#8B7355]">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
