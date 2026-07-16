'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiJson } from '@/lib/api';

/**
 * Shared "incoming from the QR menu" surface — pending customer orders (Approve /
 * Reject / Modify) + table service requests (Accept / Done). Polls every 5s.
 *
 *   variant="page"  → the full /dine-in/requests board (its own title + padding).
 *   variant="embed" → compact panel for the top of the Captain page; renders
 *                     NOTHING when idle so the captain view stays clean, and pops
 *                     into view the moment a table orders or rings the bell.
 *
 * Styled with the exact QR-menu design tokens (QR Code menu/atoms.jsx `C`) +
 * Instrument Serif / Geist / Geist Mono so it reads as one product with the menu.
 */

interface OrderItem { id: string; name: string; station: string; qty: number; unit_price: number; line_total: number; note?: string; }
interface PendingOrder { id: string; subtotal: number; note: string; created_at: string; table: { number: string; zone: string }; items: OrderItem[]; table_owner_id?: string | null; guest_name?: string; guest_mobile?: string; }
interface ServiceReq { id: string; type: string; status: string; note: string; created_at: string; table_number: string; zone: string; table_owner_id?: string | null; }
interface KotAlert { id: string; kot_number: number; station: string; table_number: string; reason: string; kind: string; server_id?: string | null; created_at: string; }

// Friendly label for each auto-raised KOT issue kind.
const ALERT_KIND: Record<string, string> = {
  fire_failed:  'Order didn’t reach kitchen',
  print_failed: 'KOT didn’t print',
  unprinted:    'KOT not confirmed',
  manual:       'Flagged by staff',
};

const C = {
  paper: '#F1E8D0', card: '#FBF4DF', cardElev: '#FFF8E2',
  ink: '#231C12', inkSoft: '#5B4F3A', inkMute: '#8E8166',
  rule: 'rgba(35,28,18,0.10)', ruleSoft: 'rgba(35,28,18,0.06)',
  terra: '#B4502E', terraDeep: '#8E3A1E', terraTint: '#E9C6AB',
  forest: '#2D4A3A', forestDeep: '#1F362A', forestTint: '#C9D6CB', egg: '#C9911E',
};
const SERIF = '"Instrument Serif", Georgia, serif';
const SANS = '"Geist", system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, monospace';
const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap';

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

export default function CustomerRequestsPanel({ variant = 'page' }: { variant?: 'page' | 'embed' | 'captain' }) {
  const embed = variant === 'embed';        // captain-home mini panel: compact + hide when idle
  const scopeMine = variant !== 'page';     // embed + captain scope to THIS captain's tables (+ unclaimed)
  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [requests, setRequests] = useState<ServiceReq[]>([]);
  const [alerts, setAlerts] = useState<KotAlert[]>([]);
  const [edits, setEdits] = useState<Record<string, Record<string, number>>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [myId, setMyId] = useState<string | null>(null);
  const [, tick] = useState(0);
  const timer = useRef<any>(null);

  // Captain views scope to THIS captain's tables. Fetch who I am.
  useEffect(() => {
    if (!scopeMine) return;
    fetch('/api/auth/me').then(r => r.json()).then(d => setMyId(d?.user?.id || null)).catch(() => {});
  }, [scopeMine]);

  const refresh = useCallback(async () => {
    try {
      const [o, r, a] = await Promise.all([
        apiJson<{ orders: PendingOrder[] }>('/api/dine-in/customer-orders'),
        apiJson<{ requests: ServiceReq[] }>('/api/dine-in/service-requests'),
        apiJson<{ alerts: KotAlert[] }>('/api/dine-in/kot-alerts?open=1').catch(() => ({ alerts: [] })),
      ]);
      setOrders(o.orders || []);
      setRequests(r.requests || []);
      setAlerts(a.alerts || []);
      setErr('');
    } catch (e: any) { setErr(e.message || 'Refresh failed'); }
    finally { setLoaded(true); }
  }, []);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    const t = setInterval(() => tick(x => x + 1), 1000);
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

  const resolveAlert = async (id: string) => {
    setAlerts(a => a.filter(x => x.id !== id));   // optimistic
    setBusy(b => ({ ...b, [id]: true }));
    try { await api('/api/dine-in/kot-alerts', { method: 'POST', body: { id, resolve: true } }); await refresh(); }
    catch (e: any) { setErr(e.message || 'Action failed'); await refresh(); }
    finally { setBusy(b => ({ ...b, [id]: false })); }
  };

  // Embed (Captain page): show only MY tables + not-yet-claimed tables (owner null).
  // Page (manager board): show everything.
  const mine = (ownerId?: string | null) => !scopeMine || !ownerId || ownerId === myId;
  const vOrders = orders.filter(o => mine(o.table_owner_id));
  const vRequests = requests.filter(r => mine(r.table_owner_id));
  const vAlerts = alerts.filter(a => mine(a.server_id));

  const nothing = !vOrders.length && !vRequests.length && !vAlerts.length;
  // Embedded on the Captain page: stay invisible until a table needs something.
  if (embed && (!loaded || nothing)) return null;

  const wrap: React.CSSProperties = embed
    ? { fontFamily: SANS, color: C.ink, margin: '0 0 20px', border: `1px solid ${C.rule}`, borderTop: `3px solid ${C.terra}`, borderRadius: 14, background: C.paper, padding: 14 }
    : { maxWidth: 1200, margin: '0 auto', padding: '20px 16px 80px', fontFamily: SANS, color: C.ink };

  return (
    <div style={wrap}>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link rel="stylesheet" href={FONTS_HREF} />

      {embed ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>🔔</span>
            <span style={{ fontFamily: SERIF, fontSize: 22, color: C.ink }}>Incoming from tables</span>
          </div>
          <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.2, color: C.inkMute, textTransform: 'uppercase' }}>● Live · auto-refresh</span>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase', color: C.terra, fontWeight: 500 }}>Customer QR Menu</div>
            <h1 style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 400, margin: '2px 0 0', color: C.ink }}>Orders &amp; Requests</h1>
          </div>
          <span style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 0.6, color: C.inkMute, textTransform: 'uppercase' }}>● Live · refreshes every {POLL_MS / 1000}s</span>
        </div>
      )}
      {err && <div style={{ background: C.terraTint, color: C.terraDeep, padding: '8px 12px', borderRadius: 8, margin: '10px 0', fontSize: 13, fontFamily: SANS }}>{err}</div>}

      {/* ── Kitchen alerts (KOT issues) — urgent, so they sit above everything ── */}
      {vAlerts.length > 0 && (
        <section style={{ margin: embed ? '4px 0 14px' : '16px 0 8px' }}>
          <h2 style={{ ...hdr(), color: C.terraDeep }}>⚠ Kitchen alerts <Count n={vAlerts.length} color={C.terra} /></h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
            {vAlerts.map(a => (
              <div key={a.id} style={{ background: '#FBEDE7', border: `1px solid ${C.terraTint}`, borderLeft: `4px solid ${C.terra}`, borderRadius: 10, padding: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 20, color: C.ink }}>
                    Table {a.table_number || '—'}
                    <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: 0.6, color: C.terraDeep, textTransform: 'uppercase', marginLeft: 8, border: `1px solid ${C.terra}`, borderRadius: 4, padding: '1px 6px' }}>{ALERT_KIND[a.kind] || a.kind}</span>
                  </div>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.inkMute }}>{ago(a.created_at)}</span>
                </div>
                <div style={{ fontFamily: SANS, fontSize: 13, color: C.terraDeep, margin: '7px 0 11px', lineHeight: 1.45 }}>{a.reason || 'A kitchen ticket needs attention.'}</div>
                <button onClick={() => resolveAlert(a.id)} disabled={busy[a.id]} style={{ ...actBtn(C.terra), width: '100%' }}>{busy[a.id] ? '…' : 'Mark handled'}</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: embed ? 'repeat(auto-fit, minmax(280px, 1fr))' : 'repeat(auto-fit, minmax(320px, 1fr))', gap: embed ? 16 : 24, marginTop: embed ? 4 : 16 }}>
        {/* ── Pending customer orders ── */}
        <section>
          <h2 style={hdr()}>Pending orders <Count n={vOrders.length} color={C.forest} /></h2>
          {!vOrders.length && !embed && <Empty>No orders waiting for approval.</Empty>}
          {vOrders.map(o => {
            const edited = orderEdited(o);
            const unclaimed = !o.table_owner_id;
            return (
              <div key={o.id} style={card(C.forest)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <div style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 24, color: C.ink }}>Table {o.table.number} {o.table.zone && <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 0.8, color: C.inkMute, textTransform: 'uppercase' }}>· {o.table.zone}</span>}{scopeMine && unclaimed && <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 0.6, color: C.terra, textTransform: 'uppercase', marginLeft: 6, border: `1px solid ${C.terraTint}`, borderRadius: 4, padding: '1px 5px' }}>unclaimed</span>}</div>
                  <div style={{ fontFamily: MONO, fontSize: 11, color: C.inkMute }}>{ago(o.created_at)}</div>
                </div>
                {(o.guest_name || o.guest_mobile) && (
                  <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.inkSoft, margin: '4px 0 0' }}>
                    Guest: <b style={{ color: C.ink }}>{o.guest_name || '—'}</b>
                    {o.guest_mobile && <> · <a href={`tel:+91${o.guest_mobile}`} style={{ color: C.terra, textDecoration: 'none', fontFamily: MONO, fontSize: 12 }}>{o.guest_mobile}</a></>}
                  </div>
                )}
                {o.note && <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.terraDeep, background: C.cardElev, borderLeft: `2px solid ${C.egg}`, borderRadius: 6, padding: '5px 9px', margin: '8px 0' }}>“{o.note}”</div>}
                <div style={{ margin: '10px 0' }}>
                  {o.items.map(it => {
                    const q = qtyOf(o, it);
                    return (
                      <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${C.ruleSoft}`, opacity: q === 0 ? 0.4 : 1 }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', border: `1px solid ${C.rule}`, borderRadius: 999, overflow: 'hidden', background: C.cardElev }}>
                          <button onClick={() => setQty(o, it, q - 1)} style={stepBtn()}>−</button>
                          <span style={{ minWidth: 22, textAlign: 'center', fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: C.ink }}>{q}</span>
                          <button onClick={() => setQty(o, it, q + 1)} style={stepBtn()}>+</button>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: SANS, fontSize: 14, color: C.ink, textDecoration: q === 0 ? 'line-through' : 'none' }}>{it.name}{it.note ? <span style={{ color: C.terra, fontWeight: 500 }}> · {it.note}</span> : null}</div>
                          <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.inkMute, textTransform: 'uppercase', letterSpacing: 0.8 }}>{it.station}</div>
                        </div>
                        <div style={{ fontFamily: MONO, fontSize: 13, color: C.inkSoft, fontVariantNumeric: 'tabular-nums' }}>₹{it.unit_price * q}</div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                  <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: edited ? C.terra : C.inkMute }}>{edited ? 'Modified' : 'Subtotal'}</span>
                  <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 15, color: C.ink }}>₹{liveSubtotal(o)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => approve(o)} disabled={busy[o.id]} style={{ ...actBtn(C.forest), flex: 2 }}>
                    {busy[o.id] ? '…' : edited ? 'Approve modified → Kitchen' : 'Approve → Kitchen'}
                  </button>
                  <button onClick={() => reject(o)} disabled={busy[o.id]} style={{ ...actBtn(C.terra), flex: 1 }}>Reject</button>
                </div>
              </div>
            );
          })}
        </section>

        {/* ── Service requests (bell) ── */}
        <section>
          <h2 style={hdr()}>Service requests <Count n={vRequests.length} color={C.terra} /></h2>
          {!vRequests.length && !embed && <Empty>No table service requests right now.</Empty>}
          {vRequests.map(r => {
            const m = SERVICE_META[r.type] || { label: r.type, icon: '🔔' };
            const accepted = r.status === 'accepted';
            return (
              <div key={r.id} style={{ ...card(accepted ? C.egg : C.terra), display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ fontSize: 26 }}>{m.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 19, color: C.ink }}>Table {r.table_number} · {m.label}</div>
                  <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: 0.4, color: accepted ? C.egg : C.inkMute, textTransform: 'uppercase' }}>{ago(r.created_at)}{accepted ? ' · accepted' : ''}</div>
                </div>
                {!accepted && <button onClick={() => serviceAct(r.id, 'accept')} disabled={busy[r.id]} style={actBtn(C.egg)}>Accept</button>}
                <button onClick={() => serviceAct(r.id, 'complete')} disabled={busy[r.id]} style={actBtn(C.forest)}>Done</button>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}

const hdr = (): React.CSSProperties => ({ fontFamily: MONO, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.6, color: C.inkSoft, margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 });
const card = (accent: string): React.CSSProperties => ({ background: C.card, border: `1px solid ${C.rule}`, borderLeft: `4px solid ${accent}`, borderRadius: 10, padding: 14, marginBottom: 12, boxShadow: '0 1px 4px rgba(35,28,18,0.05)' });
const actBtn = (bg: string): React.CSSProperties => ({ background: bg, color: C.paper, border: 'none', borderRadius: 999, padding: '9px 14px', fontSize: 13, fontWeight: 500, fontFamily: SANS, cursor: 'pointer', letterSpacing: 0.2 });
const stepBtn = (): React.CSSProperties => ({ width: 26, height: 26, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15, lineHeight: 1, color: C.ink });
function Count({ n, color }: { n: number; color: string }) { return <span style={{ background: color, color: C.paper, borderRadius: 999, fontFamily: MONO, fontSize: 12, fontWeight: 600, padding: '1px 9px', minWidth: 20, textAlign: 'center' }}>{n}</span>; }
function Empty({ children }: { children: React.ReactNode }) { return <div style={{ color: C.inkMute, fontFamily: SANS, fontSize: 13, padding: '20px 4px', textAlign: 'center', border: `1px dashed ${C.rule}`, borderRadius: 10 }}>{children}</div>; }
