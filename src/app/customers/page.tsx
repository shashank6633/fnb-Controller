'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import { fmtISTShort } from '@/lib/format-date';
import { Users, Search, Loader2, X, Phone } from 'lucide-react';

interface Customer {
  mobile: string;
  name: string;
  orders: number;
  visits: number;
  first_seen: string;
  last_seen: string;
  total_spent: number;
  qr_orders: number;
}
interface CustOrder {
  id: string;
  order_number: number;
  status: string;
  origin: string;
  total: number;
  created_at: string;
  guest_name: string | null;
  server_name: string | null;
  table_number: string | null;
  item_count: number;
}

const money = (n: number) => '₹' + (Math.round(Number(n) || 0)).toLocaleString('en-IN');

export default function CustomersPage() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Customer | null>(null);
  const [selOrders, setSelOrders] = useState<CustOrder[] | null>(null);
  const [selRegulars, setSelRegulars] = useState<{ name: string; times: number }[]>([]);
  const loadSeq = useRef(0);   // request tokens so a slow response can't overwrite a newer one
  const drillSeq = useRef(0);

  const load = useCallback(async (query: string) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const r = await api(`/api/customers${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      const j = await r.json();
      if (seq !== loadSeq.current) return;   // a newer search superseded this one
      if (!r.ok) { setRows([]); return; }
      setRows(j.customers || []);
    } catch { if (seq === loadSeq.current) setRows([]); }
    finally { if (seq === loadSeq.current) setLoading(false); }
  }, []);

  useEffect(() => { load(''); }, [load]);
  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => load(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q, load]);

  const openCustomer = async (c: Customer) => {
    const seq = ++drillSeq.current;
    setSel(c); setSelOrders(null); setSelRegulars([]);
    try {
      const [hist, reg] = await Promise.all([
        api(`/api/customers?mobile=${encodeURIComponent(c.mobile)}`).then(r => r.json()),
        api(`/api/dine-in/guest-regulars?mobile=${encodeURIComponent(c.mobile)}`).then(r => r.json()).catch(() => ({})),
      ]);
      if (seq !== drillSeq.current) return;   // opened a different customer meanwhile
      setSelOrders(hist.orders || []);
      setSelRegulars(Array.isArray(reg?.items) ? reg.items : []);
    } catch { if (seq === drillSeq.current) setSelOrders([]); }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-[#af4408]/10 rounded-lg"><Users className="w-6 h-6 text-[#af4408]" /></div>
        <div>
          <h1 className="text-2xl font-bold text-[#af4408]">Customers</h1>
          <p className="text-sm text-[#8B7355]">Guests who shared a mobile number (QR self-orders + billing). Tap a customer to see their order history and usual items.</p>
        </div>
      </div>

      <div className="card p-3 mb-4 flex items-center gap-2 max-w-md">
        <Search size={16} className="text-[#8B7355]" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or mobile…"
          className="flex-1 bg-transparent outline-none text-sm text-[#2D1B0E]" />
        {q && <button onClick={() => setQ('')}><X size={15} className="text-[#8B7355]" /></button>}
      </div>

      {loading ? (
        <div className="text-center py-12 text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline" /> Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card text-center py-12 text-[#8B7355]">{q ? 'No customers match your search.' : 'No customer numbers captured yet.'}</div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[#8B7355] border-b border-[#E8D5C4]">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Mobile</th>
                  <th className="px-4 py-3 font-medium text-center">Visits</th>
                  <th className="px-4 py-3 font-medium text-right">Total spent</th>
                  <th className="px-4 py-3 font-medium">Last seen</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.mobile} onClick={() => openCustomer(c)}
                    className="border-b border-[#F0E4D4] last:border-0 hover:bg-[#FFF8EE] cursor-pointer">
                    <td className="px-4 py-3 font-medium text-[#2D1B0E]">{c.name || <span className="text-[#B8A88F]">(no name)</span>}</td>
                    <td className="px-4 py-3 font-mono text-[#2D1B0E]">+91 {c.mobile}</td>
                    <td className="px-4 py-3 text-center text-[#5B4F3A]">{c.visits}</td>
                    <td className="px-4 py-3 text-right font-mono text-[#2D1B0E]">{money(c.total_spent)}</td>
                    <td className="px-4 py-3 text-[#8B7355]">{fmtISTShort(c.last_seen)}</td>
                    <td className="px-4 py-3">
                      {c.qr_orders > 0
                        ? <span className="text-[10px] uppercase tracking-wide bg-[#E9DFC7] text-[#8a5a12] rounded px-2 py-0.5">QR self-order</span>
                        : <span className="text-[10px] uppercase tracking-wide bg-[#E3EEE6] text-[#2D4A3A] rounded px-2 py-0.5">Captain</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 text-xs text-[#8B7355] border-t border-[#E8D5C4]">{rows.length} customer{rows.length === 1 ? '' : 's'}</div>
        </div>
      )}

      {sel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setSel(null)}>
          <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-lg p-5 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <h2 className="text-lg font-bold text-[#2D1B0E]">{sel.name || '(no name)'}</h2>
                <a href={`tel:+91${sel.mobile}`} className="text-sm text-[#af4408] font-mono inline-flex items-center gap-1"><Phone size={13} /> +91 {sel.mobile}</a>
              </div>
              <button onClick={() => setSel(null)}><X size={18} className="text-[#8B7355]" /></button>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {[['Visits', String(sel.visits)], ['Orders', String(sel.orders)], ['Total spent', money(sel.total_spent)]].map(([k, v]) => (
                <div key={k} className="bg-[#FBF4DF] border border-[#E8D5C4] rounded-lg px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">{k}</div>
                  <div className="text-sm font-semibold text-[#2D1B0E]">{v}</div>
                </div>
              ))}
            </div>
            {selRegulars.length > 0 && (
              <div className="mb-4">
                <div className="text-xs text-[#8B7355] mb-1.5">Usually orders</div>
                <div className="flex flex-wrap gap-1.5">
                  {selRegulars.slice(0, 8).map((it, i) => (
                    <span key={i} className="inline-flex items-center gap-1 bg-[#E3EEE6] border border-[#CFE0D4] text-[#2D4A3A] rounded-full px-2.5 py-1 text-[11px] font-medium">
                      {it.name} <span className="text-[9px] opacity-70">×{it.times}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="text-xs text-[#8B7355] mb-2">Order history</div>
            <div className="overflow-y-auto -mx-1 px-1">
              {selOrders === null ? (
                <div className="text-center py-6 text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin inline" /></div>
              ) : selOrders.length === 0 ? (
                <div className="text-center py-6 text-[#8B7355] text-sm">No orders.</div>
              ) : selOrders.map((o) => (
                <div key={o.id} className="flex items-center justify-between border-b border-[#F0E4D4] last:border-0 py-2 text-sm">
                  <div>
                    <span className="font-medium text-[#2D1B0E]">{o.order_number ? `#${o.order_number}` : 'Order'}</span>
                    <span className="text-[#8B7355]"> · {o.table_number ? `Table ${o.table_number}` : '—'} · {o.item_count} item{o.item_count === 1 ? '' : 's'}</span>
                    <div className="text-xs text-[#8B7355]">{fmtISTShort(o.created_at)} · {o.status}{o.origin === 'customer' ? ' · QR' : ''}</div>
                  </div>
                  <span className="font-mono text-[#2D1B0E]">{money(o.total)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
