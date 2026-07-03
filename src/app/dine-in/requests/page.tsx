'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiJson } from '@/lib/api';

interface OrderItem { id: string; name: string; station: string; qty: number; unit_price: number; line_total: number; }
interface PendingOrder { id: string; subtotal: number; note: string; created_at: string; table: { number: string; zone: string }; items: OrderItem[]; }
interface ServiceReq { id: string; type: string; status: string; note: string; created_at: string; table_number: string; zone: string; }

const SERVICE_META: Record<string, { label: string; icon: string }> = {
  waiter:  { label: 'Call waiter',    icon: '🙋' },
  water:   { label: 'Refill water',   icon: '💧' },
  cutlery: { label: 'Extra cutlery',  icon: '🍴' },
  bill:    { label: 'Request bill',   icon: '🧾' },
};

const POLL_MS = 5000;

function ago(ts: string): string {
  const then = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z').getTime();
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

export default function RequestsBoardPage() {
  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [requests, setRequests] = useState<ServiceReq[]>([]);
  const [edits, setEdits] = useState<Record<string, Record<string, number>>>({}); // orderId -> itemId -> qty
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState('');
  const [, tick] = useState(0);
  const timer = useRef<any>(null);

  const refresh = useCallback(async () => {
    try {
      const [o, r] = await Promise.all([
        apiJson<{ orders: PendingOrder[] }>('/api/dine-in/customer-orders'),
        apiJson<{ requests: ServiceReq[] }>('/api/dine-in/service-requests'),
      ]);
      setOrders(o.orders || []);
      setRequests(r.requests || []);
      setErr('');
    } catch (e: any) { setErr(e.message || 'Refresh failed'); }
  }, []);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    const t = setInterval(() => tick(x => x + 1), 1000); // re-render for "Xs ago"
    return () => { clearInterval(timer.current); clearInterval(t); };
  }, [refresh]);

  const qtyOf = (o: PendingOrder, it: OrderItem) => edits[o.id]?.[it.id] ?? it.qty;
  const setQty = (o: PendingOrder, it: OrderItem, q: number) =>
    setEdits(e => ({ ...e, [o.id]: { ...(e[o.id] || {}), [it.id]: Math.max(0, q) } }));
  const orderEdited = (o: PendingOrder) => o.items.some(it => qtyOf(o, it) !== it.qty);
  const liveSubtotal = (o: PendingOrder) => o.items.reduce((s, it) => s + it.unit_price * qtyOf(o, it), 0);

  const act = async (id: string, body: any, key: string) => {
    setBusy(b => ({ ...b, [key]: true }));
    try { await api(`/api/dine-in/customer-orders/${id}`, { method: 'POST', body }); await refresh(); setEdits(e => { const n = { ...e }; delete n[id]; return n; }); }
    catch (e: any) { setErr(e.message || 'Action failed'); }
    finally { setBusy(b => ({ ...b, [key]: false })); }
  };
  const approve = (o: PendingOrder) => {
    const items = orderEdited(o) ? o.items.map(it => ({ id: it.id, qty: qtyOf(o, it) })) : undefined;
    if (items && items.every(i => i.qty === 0)) { setErr('All lines removed — use Reject instead.'); return; }
    act(o.id, { action: 'approve', items }, o.id);
  };
  const reject = (o: PendingOrder) => { if (confirm(`Reject Table ${o.table.number}'s order? It will not go to the kitchen.`)) act(o.id, { action: 'reject' }, o.id); };

  const serviceAct = async (id: string, action: 'accept' | 'complete') => {
    setBusy(b => ({ ...b, [id]: true }));
    try { await api(`/api/dine-in/service-requests/${id}`, { method: 'POST', body: { action } }); await refresh(); }
    catch (e: any) { setErr(e.message || 'Action failed'); }
    finally { setBusy(b => ({ ...b, [id]: false })); }
  };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '20px 16px 80px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Customer Orders &amp; Requests</h1>
        <span style={{ fontSize: 12, color: '#888' }}>Live · refreshes every {POLL_MS / 1000}s</span>
      </div>
      {err && <div style={{ background: '#fee', color: '#a00', padding: '8px 12px', borderRadius: 8, margin: '12px 0', fontSize: 13 }}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24, marginTop: 16 }}>
        {/* ── Pending customer orders ── */}
        <section>
          <h2 style={hdr()}>Pending orders <Count n={orders.length} color="#2d4a3a" /></h2>
          {!orders.length && <Empty>No orders waiting for approval.</Empty>}
          {orders.map(o => {
            const edited = orderEdited(o);
            return (
              <div key={o.id} style={card('#2d4a3a')}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <div style={{ fontWeight: 700, fontSize: 17 }}>Table {o.table.number} {o.table.zone && <span style={{ fontSize: 12, color: '#999', fontWeight: 400 }}>· {o.table.zone}</span>}</div>
                  <div style={{ fontSize: 12, color: '#999' }}>{ago(o.created_at)}</div>
                </div>
                {o.note && <div style={{ fontSize: 12.5, color: '#8a6d3b', background: '#fcf6e6', borderRadius: 6, padding: '4px 8px', margin: '8px 0' }}>“{o.note}”</div>}
                <div style={{ margin: '10px 0' }}>
                  {o.items.map(it => {
                    const q = qtyOf(o, it);
                    return (
                      <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid #f0efe9', opacity: q === 0 ? 0.4 : 1 }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid #ddd', borderRadius: 999, overflow: 'hidden' }}>
                          <button onClick={() => setQty(o, it, q - 1)} style={stepBtn()}>−</button>
                          <span style={{ minWidth: 22, textAlign: 'center', fontVariantNumeric: 'tabular-nums', fontSize: 13, fontWeight: 600 }}>{q}</span>
                          <button onClick={() => setQty(o, it, q + 1)} style={stepBtn()}>+</button>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, textDecoration: q === 0 ? 'line-through' : 'none' }}>{it.name}</div>
                          <div style={{ fontSize: 10.5, color: '#aaa', textTransform: 'uppercase', letterSpacing: 0.5 }}>{it.station}</div>
                        </div>
                        <div style={{ fontSize: 13, color: '#666', fontVariantNumeric: 'tabular-nums' }}>₹{it.unit_price * q}</div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: 12, color: '#999' }}>{edited ? 'Modified' : 'Subtotal'}</span>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>₹{liveSubtotal(o)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => approve(o)} disabled={busy[o.id]} style={{ ...actBtn('#2d4a3a'), flex: 2 }}>
                    {busy[o.id] ? '…' : edited ? 'Approve modified → Kitchen' : 'Approve → Kitchen'}
                  </button>
                  <button onClick={() => reject(o)} disabled={busy[o.id]} style={{ ...actBtn('#b4502e'), flex: 1 }}>Reject</button>
                </div>
              </div>
            );
          })}
        </section>

        {/* ── Service requests (bell) ── */}
        <section>
          <h2 style={hdr()}>Service requests <Count n={requests.length} color="#b4502e" /></h2>
          {!requests.length && <Empty>No table service requests right now.</Empty>}
          {requests.map(r => {
            const m = SERVICE_META[r.type] || { label: r.type, icon: '🔔' };
            const accepted = r.status === 'accepted';
            return (
              <div key={r.id} style={{ ...card(accepted ? '#c99a3a' : '#b4502e'), display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ fontSize: 26 }}>{m.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>Table {r.table_number} · {m.label}</div>
                  <div style={{ fontSize: 12, color: '#999' }}>{ago(r.created_at)}{accepted ? ' · accepted' : ''}</div>
                </div>
                {!accepted && <button onClick={() => serviceAct(r.id, 'accept')} disabled={busy[r.id]} style={actBtn('#c99a3a')}>Accept</button>}
                <button onClick={() => serviceAct(r.id, 'complete')} disabled={busy[r.id]} style={actBtn('#2d4a3a')}>Done</button>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}

const hdr = (): React.CSSProperties => ({ fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, color: '#666', margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 8 });
const card = (accent: string): React.CSSProperties => ({ background: '#fff', border: '1px solid #eee', borderLeft: `4px solid ${accent}`, borderRadius: 10, padding: 14, marginBottom: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.04)' });
const actBtn = (bg: string): React.CSSProperties => ({ background: bg, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const stepBtn = (): React.CSSProperties => ({ width: 26, height: 26, border: 'none', background: '#f4f3ee', cursor: 'pointer', fontSize: 15, lineHeight: 1 });
function Count({ n, color }: { n: number; color: string }) { return <span style={{ background: color, color: '#fff', borderRadius: 999, fontSize: 12, fontWeight: 700, padding: '1px 9px', minWidth: 20, textAlign: 'center' }}>{n}</span>; }
function Empty({ children }: { children: React.ReactNode }) { return <div style={{ color: '#aaa', fontSize: 13, padding: '20px 4px', textAlign: 'center', border: '1px dashed #e5e5e5', borderRadius: 10 }}>{children}</div>; }
