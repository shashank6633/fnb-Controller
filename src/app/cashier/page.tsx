'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { computeBill, sumItemTax, round2 } from '@/lib/bill-calc';
import { getPrintCounter, setPrintCounter } from '@/lib/offline-print/bridge-client';
import CashierFloorPresence from '@/components/CashierFloorPresence';
import {
  Wallet, Printer, Download, Percent, BadgePercent, PanelRightClose, PanelRightOpen,
  Loader2, CheckCircle2, XCircle, Clock, RefreshCw, Users, Receipt, X, ArrowLeft, AlertTriangle, MapPin,
  BellRing,
} from 'lucide-react';

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n: number) => '₹' + inr.format(Number(n) || 0);
const METHODS = ['cash', 'upi', 'card', 'zomato', 'swiggy', 'dineout', 'cheque', 'other'];

interface TableRow {
  id: string; table_number: string; zone: string;
  open_order_id: string | null; open_order_number: number | null; open_order_total: number | null;
  open_order_captain: string | null; open_order_bill_printed_at: string | null;
  // Captain → cashier bill request (src/lib/bill-request.ts). requested-but-unseen
  // is the loud state; once acknowledged the table stays marked but stops shouting.
  open_order_bill_requested_at: string | null; open_order_bill_seen_at: string | null;
}

/**
 * The owner asked for the waiting table to show in a "Different color". A colour
 * alone fails a busy counter and a colour-blind cashier, so every state below
 * pairs its colour with a WORD, and the same three words are used on the tile,
 * in the sidebar and on the open bill.
 *
 * 'requested' outranks the existing blue "Bill printed" highlight wherever both
 * are true: a printed bill is a machine having done something, a request is a
 * guest waiting for a person.
 */
type BillReqState = 'requested' | 'seen' | null;
const billReqState = (t: TableRow): BillReqState =>
  !t.open_order_bill_requested_at ? null : (t.open_order_bill_seen_at ? 'seen' : 'requested');
interface OrderItem { id: string; name: string; quantity: number; unit_price: number; line_total: number; tax_value: number | null; status: string; kot_status?: string | null }
interface Order {
  id: string; order_number: number; order_type: string; table_number: string | null; zone: string | null;
  covers: number; server_name: string | null; created_at: string;
  guest_name?: string | null; guest_mobile?: string | null;
  status: string; total: number; payment_method: string | null;
  subtotal: number; discount: number; discount_pct: number; service_charge_reason: string | null;
  items: OrderItem[];
}
interface BillDesign { serviceChargeOn?: boolean; serviceChargePct?: number; cgstPct?: number; sgstPct?: number }
interface Req { id: string; kind: string; requested_pct: number; reason: string; status: string; decided_by?: string; decided_note?: string }

export default function CashierPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(null);
  const [ready, setReady] = useState(false);
  const [tables, setTables] = useState<TableRow[]>([]);
  const [design, setDesign] = useState<BillDesign>({});
  const [selId, setSelId] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [barOpen, setBarOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [discForm, setDiscForm] = useState<{ pct: string; reason: string } | null>(null);
  const [scForm, setScForm] = useState<{ reason: string } | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [billStations, setBillStations] = useState<{ floor: string }[] | null>(null); // active BILL printers
  const [printCounter, setPrintCounterState] = useState('');                          // where Print Bill sends
  const [tab, setTab] = useState<'open' | 'online' | 'closed' | 'outstanding'>('open');
  const [listOrders, setListOrders] = useState<any[]>([]);                             // online/closed/outstanding lists
  const [floorPrompt, setFloorPrompt] = useState(0);   // bump → open the floor picker

  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 3500); };
  // Contextual back: from a bill → the table list; from the list → leave the page.
  const goBack = () => {
    if (order) { setSelId(null); setOrder(null); setReqs([]); setDiscForm(null); setScForm(null); }
    else router.back();
  };

  useEffect(() => {
    api('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null)).catch(() => {}).finally(() => setReady(true));
    fetch('/api/settings?key=bill_design').then(r => r.json()).then(d => { try { setDesign(JSON.parse(d?.value || '{}') || {}); } catch { setDesign({}); } }).catch(() => {});
    setPrintCounterState(getPrintCounter());
    api('/api/dine-in/offline-print/stations').then(r => r.json())
      .then(j => setBillStations((j.stations || []).filter((s: any) => s.role === 'bill' && Number(s.is_active) !== 0)))
      .catch(() => setBillStations([]));
  }, []);

  const loadTables = useCallback(async () => {
    try { const r = await api('/api/dine-in/tables'); const j = await r.json(); setTables(j.items || []); } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadTables(); const t = setInterval(loadTables, 8000); return () => clearInterval(t); }, [loadTables]);

  const loadOrder = useCallback(async (orderId: string) => {
    try {
      const r = await api(`/api/dine-in/orders/${orderId}`);
      const j = await r.json();
      setOrder(r.ok ? j.order : null);
      const rr = await api(`/api/dine-in/discount-requests?order_id=${orderId}`);
      const jr = await rr.json();
      // `requests` = recent list → both a pending discount AND a pending SC
      // waiver are visible (falls back to the single latest for safety).
      setReqs(jr.requests || (jr.request ? [jr.request] : []));
    } catch { setOrder(null); setReqs([]); }
  }, []);

  /**
   * "A cashier has this" — silences the bell for everyone, leaves the table
   * marked until the bill is actually closed.
   *
   * Fire-and-forget on purpose: acknowledging is a courtesy signal, and a failed
   * ack must never stop the bill from opening. The SERVER decides who may do it
   * (same settleAuthority as settle), so a passer-by clicking a tile cannot
   * silence a request they could not answer — the call just 403s and nothing
   * changes. Refresh the board after, so the tile repaints from server truth
   * rather than an optimistic guess.
   */
  const ackBillRequest = useCallback((orderId: string) => {
    api(`/api/dine-in/orders/${orderId}/request-bill`, { method: 'POST', body: { action: 'seen' } })
      .then(() => loadTables())
      .catch(() => { /* the bell stays lit — correct, nobody confirmed */ });
  }, [loadTables]);

  const selectTable = (t: TableRow) => {
    if (!t.open_order_id) { setSelId(null); setOrder(null); setReqs([]); flash(false, `Table ${t.table_number} is free — no open bill.`); return; }
    setSelId(t.open_order_id); setDiscForm(null); setScForm(null); setPayOpen(false);
    setBarOpen(false);   // collapse the floating Table View so the bill fills the screen
    loadOrder(t.open_order_id);
    if (billReqState(t) === 'requested') ackBillRequest(t.open_order_id);
  };
  const selectOrder = (o: any) => { setSelId(o.id); setDiscForm(null); setScForm(null); setPayOpen(false); loadOrder(o.id); };

  // Online Open (takeaway/delivery), Closed (settled) + Outstanding (on_hold) tabs.
  const loadList = useCallback(async () => {
    if (tab === 'open') { setListOrders([]); return; }
    const status = tab === 'closed' ? 'settled' : tab === 'outstanding' ? 'on_hold' : 'open';
    try {
      const r = await api(`/api/dine-in/orders?status=${status}`);
      const j = await r.json();
      let its = j.items || [];
      if (tab === 'online') its = its.filter((o: any) => !o.table_id || (o.order_type && o.order_type !== 'dine-in'));
      setListOrders(its);
    } catch { setListOrders([]); }
  }, [tab]);
  useEffect(() => { loadList(); const t = setInterval(loadList, 10000); return () => clearInterval(t); }, [loadList]);

  // Live breakdown via the SAME computeBill the printer/settle/PDF use.
  const items = order?.items || [];
  const subtotal = round2(items.reduce((s, it) => s + (Number(it.line_total) || 0), 0));
  const bill = order ? computeBill(
    { subtotal, itemTax: sumItemTax(items), serviceRemoved: !!order.service_charge_reason, discount_pct: order.discount_pct, discount: order.discount },
    { serviceChargeOn: design.serviceChargeOn !== false, serviceChargePct: Number(design.serviceChargePct) || 0, cgstPct: design.cgstPct == null ? 2.5 : Number(design.cgstPct), sgstPct: design.sgstPct == null ? 2.5 : Number(design.sgstPct) },
  ) : null;
  // A held bill's total was frozen at hold — collect exactly that, not a recompute.
  const grand = order?.status === 'on_hold' ? Math.round(Number(order.total) || 0) : (bill ? Math.round(bill.total) : 0);
  const counters = Array.from(new Set((billStations || []).map(s => (s.floor || '').trim()).filter(Boolean)));
  const noBillPrinter = billStations !== null && billStations.length === 0;
  const pendingDisc = reqs.find(r => r.kind !== 'service_charge' && r.status === 'pending');
  const pendingSc = reqs.find(r => r.kind === 'service_charge' && r.status === 'pending');

  const act = async (label: string, fn: () => Promise<Response>, after?: (j: any) => void) => {
    setBusy(label);
    try {
      const r = await fn(); const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        flash(false, j.error || 'Failed');
        // A settle/hold refused only because this person holds no floor is not a
        // dead end. settle-authority.ts sets offerCheckIn on reason
        // 'needs_check_in'; open the floor picker so one tap clears the refusal
        // instead of leaving a guest standing at the counter reading a 403.
        if (j.offerCheckIn) setFloorPrompt(t => t + 1);
      }
      // `after` gets the parsed response so success toasts can render SERVER
      // facts — e.g. settle/hold's `override` payload naming the bypassed
      // floor cashier — never a locally-derived guess.
      else { flash(true, 'Done'); after?.(j); if (selId) loadOrder(selId); loadTables(); loadList(); }
    } catch (e: any) { flash(false, e.message || 'Failed'); }
    setBusy('');
  };

  const printBill = () => selId && act('print', () => api(`/api/dine-in/orders/${selId}/print-bill`, { method: 'POST', body: { counter: printCounter } }));
  const holdBill = () => selId && act('hold', () => api(`/api/dine-in/orders/${selId}/hold`, { method: 'POST', body: {} }), (j) => {
    setSelId(null); setOrder(null);
    // A management hold past a live floor cashier says so — same facts the
    // override ledger just recorded, from the server's `override` payload.
    flash(true, j?.override
      ? `Held by ${j.override.by} — ${j.override.bypassed} holds this floor. Moved to Outstanding Payment.`
      : 'Bill held — moved to Outstanding Payment');
  });
  const downloadBill = () => { if (selId) window.open(`/api/dine-in/orders/${selId}/bill-pdf`, '_blank'); };
  const submitDiscount = () => {
    if (!selId || !discForm) return;
    const pct = Number(discForm.pct);
    if (!(pct > 0)) { flash(false, 'Enter a discount %'); return; }
    act('disc', () => api('/api/dine-in/discount-requests', { method: 'POST', body: { order_id: selId, pct, reason: discForm.reason } }), () => setDiscForm(null));
  };
  const submitSc = () => {
    if (!selId || !scForm) return;
    if (!scForm.reason.trim()) { flash(false, 'A reason is required'); return; }
    act('sc', () => api('/api/dine-in/discount-requests', { method: 'POST', body: { order_id: selId, kind: 'service_charge', reason: scForm.reason } }), () => setScForm(null));
  };

  /**
   * WHO SEES THIS CONSOLE — the tillCapable() MIRROR.
   *
   * The server has exactly one till-capability predicate, tillCapable() in
   * src/lib/settle-authority.ts: admin/manager TIER always; staff only with an
   * EXPLICIT resolved page map granting /cashier. Settle, hold and the
   * presence route all enforce that one function. This is a "use client" file
   * and settle-authority.ts talks to better-sqlite3, so it cannot be imported
   * here — the block below MIRRORS it clause for clause (same null/''/garbled/
   * empty-map refusals, same '/' path-boundary match). If tillCapable() ever
   * changes, change this with it.
   *
   * Deliberately NOT canAccessPage('/cashier'): its null-map backward compat
   * reads "no map" as "every page", which for the till passed everyone —
   * captains included — on a database where all active users have no role
   * (review defect D5). Navigation keeps that forgiving rule; the till does
   * not. So a staff user with no role sees the assign-role refusal below — the
   * SAME answer settle and check-in would give them — instead of a console
   * whose every button 403s (D1, D12). role_name is not consulted, because the
   * server does not consult it: a role named "Cashier" whose page map somehow
   * lost /cashier would be refused server-side, so promising it here would be
   * the exact client/server drift D10 bans.
   */
  const canOperate = (() => {
    if (!me?.id) return false;
    if (me.role === 'admin' || me.role === 'manager') return true;
    const raw = me.page_access;
    if (raw == null || String(raw).trim() === '') return false;
    try {
      const map = JSON.parse(String(raw));
      return Array.isArray(map) && map.some(
        (p: unknown) => typeof p === 'string' && ('/cashier' === p || '/cashier'.startsWith(p + '/')),
      );
    } catch { return false; }
  })();
  const occupied = tables.filter(t => t.open_order_id);
  const zones = Array.from(new Set(tables.map(t => t.zone || 'Floor')));
  /**
   * Tables whose captain has asked and nobody has picked up yet.
   *
   * THIS CAN EXCEED THE BELL'S BADGE, deliberately. The bell counts through
   * settleAuthorityForFloor() — only requests THIS person could settle — while
   * this board has always shown every floor in the outlet (same list, same
   * totals, same tiles as before this change). So on a two-cashier night the
   * Ground Floor cashier sees Rooftop's waiting table on the board but is not
   * badged for it, which is the right split: the badge is "your work", the board
   * is "the room". /api/dine-in/tables applies captainAreaFilter when an area
   * lock is configured, so a genuinely area-restricted operator still only sees
   * their own tables here.
   */
  const waitingForBill = occupied.filter(t => billReqState(t) === 'requested').length;
  // Request state of the bill currently open, for the header chip. Read off the
  // board list rather than a second fetch — /api/dine-in/orders/[id] is the bill,
  // and this is the same 8s-refreshed row the tile was painted from.
  const openTableRow = selId ? tables.find(t => t.open_order_id === selId) : undefined;
  const openBillReq: BillReqState = openTableRow ? billReqState(openTableRow) : null;

  if (ready && !canOperate) {
    // The assign-role sentence — the same copy settle-authority answers with
    // (reason 'no_page_access'). This person cannot check in either, so naming
    // a floor prompt or "check in first" here would be a dead end (D1, D12);
    // the only real way out is a role assignment, and the copy says exactly that.
    return <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-8">
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center max-w-md">
        <Wallet className="w-8 h-8 text-[#af4408] mx-auto mb-2" />
        <p className="font-semibold text-[#2D1B0E]">Cashier console</p>
        <p className="text-sm text-[#8B7355] mt-1">Your role does not include the Cashier page, so you cannot settle bills. Ask an admin to assign you the Cashier role in Settings → Roles.</p>
      </div>
    </div>;
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0]">
      {/* MAIN */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <button onClick={goBack} aria-label="Back" className="p-2 rounded-lg border border-[#af4408]/30 text-[#af4408] hover:bg-[#af4408]/10"><ArrowLeft className="w-5 h-5" /></button>
            <div className="p-2 bg-[#af4408]/10 rounded-lg"><Wallet className="w-6 h-6 text-[#af4408]" /></div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Cashier</h1>
              <p className="text-sm text-[#8B7355]">Select a table, take payment and print the bill.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {counters.length > 0 && (
              <label className="flex items-center gap-1.5 text-sm bg-white border border-[#D4B896] rounded-lg px-3 py-2">
                <MapPin className="w-4 h-4 text-[#af4408]" />
                <span className="text-[#8B7355]">Counter:</span>
                <select value={printCounter} onChange={(e) => { setPrintCounterState(e.target.value); setPrintCounter(e.target.value); }}
                  title="Which floor cash-counter you're operating — bills print here by default"
                  className="bg-transparent text-[#2D1B0E] font-medium outline-none">
                  <option value="">Auto (bill&apos;s floor)</option>
                  {counters.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            )}
            <button onClick={() => { loadTables(); loadList(); }} className="flex items-center gap-1.5 text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 px-3 py-2 rounded-lg text-sm font-medium"><RefreshCw className="w-4 h-4" /> Refresh</button>
          </div>
        </div>

        {/* FLOOR CHECK-IN + FLOOR BOARD — the owner's rules (a) and (3).
            Mounted above the tabs and OUTSIDE the `!order` guard on purpose: the
            floor you hold decides what every button below it is allowed to do,
            so it must stay visible while a bill is open, not just on the list. */}
        <CashierFloorPresence
          me={me}
          requestOpen={floorPrompt}
          onChanged={() => { loadTables(); loadList(); }}
        />

        {/* Tabs */}
        {!order && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {([['open', 'Open Orders'], ['online', 'Online Open'], ['closed', 'Closed'], ['outstanding', 'Outstanding Payment']] as const).map(([k, label]) => (
              <button key={k} onClick={() => { setTab(k); setBarOpen(false); }}
                className={`text-sm px-3 py-1.5 rounded-full ${tab === k ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>{label}</button>
            ))}
          </div>
        )}

        {/* OPEN ORDERS → occupied dine-in tables */}
        {!order && tab === 'open' && (
          <div>
            <p className="text-sm text-[#8B7355] mb-2">
              {occupied.length} table{occupied.length === 1 ? '' : 's'} with an open bill. Pick one here or from the Table View.
              {/* The count, in words, beside the colour — a cashier scanning 20
                  tiles should not have to find the coloured one to know there is one. */}
              {waitingForBill > 0 && <b className="text-rose-700"> {waitingForBill} waiting for the bill.</b>}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {occupied.length === 0 && <div className="col-span-full text-center text-[#8B7355] py-12 bg-white border border-[#E8D5C4] rounded-xl">No open bills right now.</div>}
              {occupied.map(t => {
                const billed = !!t.open_order_bill_printed_at;
                const req = billReqState(t);
                return (
                <button key={t.id} onClick={() => selectTable(t)}
                  className={`text-left rounded-xl p-3 border ${
                    req === 'requested' ? 'border-rose-500 ring-2 ring-rose-200 bg-rose-50'
                    : req === 'seen' ? 'border-rose-300 ring-1 ring-rose-100 bg-white'
                    : billed ? 'border-blue-400 ring-1 ring-blue-200 bg-blue-50'
                    : 'bg-white border-[#E8D5C4] hover:border-[#af4408]'}`}>
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-bold text-[#2D1B0E]">{t.table_number}</span>
                    {req === 'requested'
                      ? <span className="text-[10px] uppercase text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded inline-flex items-center gap-0.5 shrink-0"><BellRing className="w-3 h-3" /> Wants bill</span>
                      : req === 'seen'
                      ? <span className="text-[10px] uppercase text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded inline-flex items-center gap-0.5 shrink-0"><BellRing className="w-3 h-3" /> Bill asked</span>
                      : billed
                      ? <span className="text-[10px] uppercase text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded inline-flex items-center gap-0.5 shrink-0"><Receipt className="w-3 h-3" /> Bill printed</span>
                      : <span className="text-[10px] uppercase text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded shrink-0">Open</span>}
                  </div>
                  <div className="text-xs text-[#8B7355] mt-0.5">{t.zone || 'Floor'} · #{t.open_order_number}</div>
                  <div className={`text-lg font-bold mt-1 ${req ? 'text-rose-700' : billed ? 'text-blue-700' : 'text-[#af4408]'}`}>{money(t.open_order_total || 0)}</div>
                  {t.open_order_captain && <div className="text-[11px] text-[#8B7355] truncate">{t.open_order_captain}</div>}
                </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ONLINE OPEN / CLOSED / OUTSTANDING → order lists */}
        {!order && tab !== 'open' && (
          <div>
            <p className="text-sm text-[#8B7355] mb-2">{listOrders.length} {tab === 'online' ? 'online / takeaway order' : tab === 'closed' ? 'closed bill' : 'outstanding bill'}{listOrders.length === 1 ? '' : 's'}.</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {listOrders.length === 0 && <div className="col-span-full text-center text-[#8B7355] py-12 bg-white border border-[#E8D5C4] rounded-xl">Nothing here.</div>}
              {listOrders.map(o => (
                <button key={o.id} onClick={() => selectOrder(o)}
                  className={`text-left rounded-xl p-3 border bg-white hover:border-[#af4408] ${tab === 'outstanding' ? 'border-amber-300 ring-1 ring-amber-100' : 'border-[#E8D5C4]'}`}>
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-bold text-[#2D1B0E] truncate">{o.table_number || `#${o.order_number}`}</span>
                    <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded shrink-0 ${tab === 'closed' ? 'text-emerald-700 bg-emerald-50' : tab === 'outstanding' ? 'text-amber-700 bg-amber-100' : 'text-sky-700 bg-sky-50'}`}>{tab === 'closed' ? 'Paid' : tab === 'outstanding' ? 'On hold' : (o.order_type || 'online')}</span>
                  </div>
                  <div className="text-xs text-[#8B7355] mt-0.5 truncate">#{o.order_number}{o.server_name ? ` · ${o.server_name}` : ''}</div>
                  <div className={`text-lg font-bold mt-1 ${tab === 'outstanding' ? 'text-amber-700' : 'text-[#af4408]'}`}>{money(o.total || 0)}</div>
                  {tab === 'closed' && o.payment_method && <div className="text-[11px] text-[#8B7355] uppercase">{o.payment_method}</div>}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Bill panel */}
        {order && bill && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 bg-[#F5EDE2] flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold bg-[#2D1B0E] text-white px-2 py-1 rounded">{order.table_number ? `${order.zone ? order.zone + ' · ' : ''}${order.table_number}` : 'PARCEL'}</span>
                <span className="text-xs uppercase font-semibold text-emerald-700">{order.order_type}</span>
                <span className="text-xs text-[#8B7355]">#{order.order_number} · {order.server_name || '—'} · <Users className="inline w-3 h-3" /> {order.covers || 0}{order.guest_name ? <> · {order.guest_name}</> : null}{order.guest_mobile ? <> · {order.guest_mobile}</> : null}</span>
                {/* Why this bill is on screen: the captain asked for it. Opening
                    the bill acknowledges the request (selectTable → ackBillRequest),
                    so by the time this renders the state is normally 'seen' — the
                    chip is the reminder that a guest is waiting, not a to-do. */}
                {openBillReq && (
                  <span className="text-[10px] uppercase font-semibold text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded inline-flex items-center gap-0.5">
                    <BellRing className="w-3 h-3" /> Guest asked for the bill
                  </span>
                )}
              </div>
              <button onClick={goBack} className="flex items-center gap-1 text-sm text-[#8B7355] hover:text-[#af4408]"><ArrowLeft className="w-4 h-4" /> Back to tables</button>
            </div>

            {/* items */}
            <div className="divide-y divide-[#F0E6D8] max-h-[42vh] overflow-y-auto">
              {items.map(it => (
                <div key={it.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                  <div className="min-w-0"><span className="text-[#2D1B0E]">{it.name}</span>
                    <span className="text-[11px] text-[#8B7355] ml-1">× {it.quantity}</span>
                    {it.kot_status && <span className="text-[10px] uppercase text-[#af4408] ml-1">{it.kot_status}</span>}
                  </div>
                  <span className="tabular-nums text-[#2D1B0E]">{money(it.line_total)}</span>
                </div>
              ))}
            </div>

            {/* totals */}
            <div className="px-4 py-3 bg-[#FAF4EC] border-t border-[#E8D5C4] space-y-1 text-sm">
              <Line l="Sub Total" v={money(bill.subtotal)} />
              {bill.serviceCharge > 0 && <Line l="Service Charge" v={money(bill.serviceCharge)} />}
              {order.service_charge_reason && <div className="text-[11px] text-emerald-700">Service charge waived: {order.service_charge_reason}</div>}
              {bill.discount > 0 && <Line l={`Discount${order.discount_pct ? ` (${order.discount_pct}%)` : ''}`} v={'- ' + money(bill.discount)} />}
              <Line l="Tax (CGST+SGST)" v={money(bill.cgst + bill.sgst)} />
              <div className="flex items-center justify-between pt-1 mt-1 border-t border-[#E8D5C4]">
                <span className="font-bold text-[#2D1B0E]">Final Amount</span>
                <span className="font-bold text-lg text-[#af4408] tabular-nums">{money(grand)}</span>
              </div>
            </div>

            {/* request status chips */}
            {(pendingDisc || pendingSc || reqs.some(r => r.status === 'rejected')) && (
              <div className="px-4 py-2 flex flex-wrap gap-2 text-[11px]">
                {pendingDisc && <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-700 px-2 py-1 rounded"><Clock className="w-3 h-3" /> Discount {pendingDisc.requested_pct}% awaiting manager approval</span>}
                {pendingSc && <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-700 px-2 py-1 rounded"><Clock className="w-3 h-3" /> Service-charge waiver awaiting approval</span>}
                {reqs.filter(r => r.status === 'rejected').map(r => <span key={r.id} className="inline-flex items-center gap-1 bg-red-50 text-red-700 px-2 py-1 rounded"><XCircle className="w-3 h-3" /> {r.kind === 'service_charge' ? 'Waiver' : 'Discount'} rejected</span>)}
              </div>
            )}

            {/* no BILL printer configured → Print Bill won't produce a printout */}
            {noBillPrinter && (
              <div className="mx-4 mt-3 flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2 text-xs">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>No <b>BILL printer</b> is set up, so <b>Print Bill</b> won&apos;t produce a printout. Add one on the <a href="/dine-in/offline-print" className="underline font-medium">Printers page</a> (role = Bill). You can still <b>Download Bill</b> as a PDF.</span>
              </div>
            )}

            {/* actions — status-aware */}
            <div className="px-4 py-3 border-t border-[#E8D5C4] flex flex-wrap items-center gap-2">
              <button onClick={printBill} disabled={!!busy} className="flex items-center gap-1.5 border border-[#af4408]/40 text-[#af4408] hover:bg-[#af4408]/10 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50"><Printer className="w-4 h-4" /> Print Bill{printCounter ? ` · ${printCounter}` : ''}</button>
              <button onClick={downloadBill} className="flex items-center gap-1.5 border border-[#af4408]/40 text-[#af4408] hover:bg-[#af4408]/10 px-3 py-2 rounded-lg text-sm font-medium"><Download className="w-4 h-4" /> Download Bill</button>
              {order.status === 'open' && (
                <>
                  <button onClick={() => { setDiscForm(discForm ? null : { pct: '', reason: '' }); setScForm(null); }} disabled={!!pendingDisc || bill.discount > 0} className="flex items-center gap-1.5 border border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3] px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-40"><Percent className="w-4 h-4" /> Request Discount</button>
                  <button onClick={() => { setScForm(scForm ? null : { reason: '' }); setDiscForm(null); }} disabled={!!pendingSc || !!order.service_charge_reason || bill.serviceCharge === 0} className="flex items-center gap-1.5 border border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3] px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-40"><BadgePercent className="w-4 h-4" /> Waive Service Charge</button>
                  <button onClick={holdBill} disabled={!!busy || items.length === 0} className="flex items-center gap-1.5 border border-amber-400 text-amber-700 hover:bg-amber-50 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50"><Clock className="w-4 h-4" /> Hold Bill</button>
                </>
              )}
              {(order.status === 'open' || order.status === 'on_hold') && (
                <button onClick={() => setPayOpen(true)} disabled={!!busy || items.length === 0} className="flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white px-4 py-2 rounded-lg text-sm font-semibold ml-auto disabled:opacity-50"><Wallet className="w-4 h-4" /> {order.status === 'on_hold' ? 'Collect' : 'Pay'} {money(grand)}</button>
              )}
              {order.status === 'settled' && <span className="ml-auto text-sm font-semibold text-emerald-700 inline-flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Paid · {(order.payment_method || '').toUpperCase()}</span>}
            </div>

            {/* discount request form */}
            {discForm && (
              <div className="px-4 py-3 border-t border-[#E8D5C4] bg-[#FFF8F0] flex flex-wrap items-end gap-2">
                <label className="text-xs text-[#6B5744]">Discount %<input value={discForm.pct} onChange={e => setDiscForm({ ...discForm, pct: e.target.value.replace(/[^\d.]/g, '') })} className="block bg-white border border-[#D4B896] rounded px-2 py-1.5 text-sm w-24" placeholder="10" /></label>
                <label className="text-xs text-[#6B5744] flex-1 min-w-[160px]">Reason<input value={discForm.reason} onChange={e => setDiscForm({ ...discForm, reason: e.target.value })} className="block bg-white border border-[#D4B896] rounded px-2 py-1.5 text-sm w-full" placeholder="Regular guest / manager comp" /></label>
                <button onClick={submitDiscount} disabled={busy === 'disc'} className="bg-[#af4408] text-white px-3 py-1.5 rounded text-sm font-medium">Request approval</button>
              </div>
            )}
            {scForm && (
              <div className="px-4 py-3 border-t border-[#E8D5C4] bg-[#FFF8F0] flex flex-wrap items-end gap-2">
                <label className="text-xs text-[#6B5744] flex-1 min-w-[200px]">Reason to waive service charge<input value={scForm.reason} onChange={e => setScForm({ reason: e.target.value })} className="block bg-white border border-[#D4B896] rounded px-2 py-1.5 text-sm w-full" placeholder="Guest complaint / manager decision" /></label>
                <button onClick={submitSc} disabled={busy === 'sc'} className="bg-[#af4408] text-white px-3 py-1.5 rounded text-sm font-medium">Request approval</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* FLOATING TABLE VIEW — a tab stuck to the right edge; click to expand */}
      {!barOpen && (
        <button onClick={() => setBarOpen(true)} aria-label="Open Table View"
          className="fixed right-0 top-1/2 -translate-y-1/2 z-40 bg-[#af4408] hover:bg-[#8a3506] active:scale-95 text-white rounded-l-xl shadow-lg py-4 pl-2.5 pr-1.5 flex flex-col items-center gap-2 transition">
          <PanelRightOpen className="w-4 h-4" />
          <span className="[writing-mode:vertical-rl] rotate-180 text-xs font-semibold tracking-wide py-1">Table View</span>
          {occupied.length > 0 && <span className="text-[10px] font-bold bg-white/25 rounded-full w-5 h-5 flex items-center justify-center">{occupied.length}</span>}
        </button>
      )}
      {barOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setBarOpen(false)} />
          <aside className="fixed right-0 top-0 z-50 w-64 h-screen bg-[#1C0F05] text-white overflow-y-auto shadow-2xl">
            <div className="px-4 py-3 flex items-center justify-between border-b border-white/10 sticky top-0 bg-[#1C0F05] z-10">
              <span className="font-semibold flex items-center gap-1.5"><Receipt className="w-4 h-4" /> Table View</span>
              <button onClick={() => setBarOpen(false)} className="text-white/60 hover:text-white" aria-label="Close Table View"><PanelRightClose className="w-4 h-4" /></button>
            </div>
            <div className="px-4 py-2 flex items-center gap-x-3 gap-y-1 flex-wrap text-[10px] text-white/50 border-b border-white/10">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-rose-600" /> Wants bill</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-[#af4408]" /> Open</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-600" /> Bill printed</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-white/10" /> Free</span>
            </div>
            {tables.length === 0 && <p className="text-white/40 text-sm px-4 py-6">No tables configured.</p>}
            {zones.map(z => (
              <div key={z} className="px-2 py-2">
                <div className="text-[10px] uppercase tracking-wide text-white/40 px-2 mb-1">{z}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {tables.filter(t => (t.zone || 'Floor') === z).map(t => {
                    const occ = !!t.open_order_id; const active = t.open_order_id === selId;
                    const billed = occ && !!t.open_order_bill_printed_at;
                    // A request outranks the printed highlight — see billReqState().
                    // 'seen' keeps the rose tile (the table still wants to pay) but
                    // drops to an outline so the unanswered ones stay the loud ones.
                    const req = occ ? billReqState(t) : null;
                    return (
                      <button key={t.id} onClick={() => selectTable(t)}
                        className={`rounded-lg px-2 py-2 text-left ${active ? 'ring-2 ring-white' : ''} ${
                          req === 'requested' ? 'bg-rose-600'
                          : req === 'seen' ? 'bg-rose-600/25 ring-1 ring-rose-400'
                          : billed ? 'bg-blue-600' : occ ? 'bg-[#af4408]' : 'bg-white/5 hover:bg-white/10'}`}>
                        <div className="font-bold text-sm flex items-center gap-1">{t.table_number}{req ? <BellRing className="w-3 h-3" /> : billed ? <Receipt className="w-3 h-3" /> : null}</div>
                        <div className={`text-[10px] ${req ? 'text-rose-50' : billed ? 'text-blue-50' : occ ? 'text-white/90' : 'text-white/40'}`}>
                          {req === 'requested' ? `Wants bill · ${money(t.open_order_total || 0)}`
                            : req === 'seen' ? `Bill asked · ${money(t.open_order_total || 0)}`
                            : billed ? `Bill · ${money(t.open_order_total || 0)}`
                            : occ ? money(t.open_order_total || 0) : 'Free'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </aside>
        </>
      )}

      {/* PAY modal */}
      {payOpen && order && bill && <PayModal grand={grand} onClose={() => setPayOpen(false)} busy={busy === 'pay'}
        onSettle={(payments) => act('pay', () => api(`/api/dine-in/orders/${selId}/settle`, { method: 'POST', body: payments.length === 1 ? { payment_method: payments[0].method } : { payments } }), (j) => {
          setPayOpen(false); setSelId(null); setOrder(null);
          // A manager-override settle names who was bypassed — rendered from
          // the server's `override` payload (the facts the ledger recorded),
          // so this toast can never claim an override that did not happen.
          flash(true, j?.override
            ? `Settled by ${j.override.by} — ${j.override.bypassed} holds this floor`
            : 'Bill settled');
        })} />}

      {toast && <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm text-white ${toast.ok ? 'bg-emerald-600' : 'bg-red-600'}`}>{toast.msg}</div>}
    </div>
  );
}

function Line({ l, v }: { l: string; v: string }) {
  return <div className="flex items-center justify-between"><span className="text-[#6B5744]">{l}</span><span className="tabular-nums text-[#2D1B0E]">{v}</span></div>;
}

function PayModal({ grand, onSettle, onClose, busy }: { grand: number; onSettle: (p: { method: string; amount: number }[]) => void; onClose: () => void; busy: boolean }) {
  const [split, setSplit] = useState(false);
  const [rows, setRows] = useState<{ method: string; amount: string }[]>([{ method: 'cash', amount: String(grand) }]);
  const sum = round2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0));
  const remaining = round2(grand - sum);

  const single = (method: string) => onSettle([{ method, amount: grand }]);
  const settleSplit = () => {
    const clean = rows.map(r => ({ method: r.method, amount: round2(Number(r.amount) || 0) })).filter(r => r.amount > 0);
    if (Math.abs(sum - grand) > 1) return;
    onSettle(clean);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-[#2D1B0E]">Take payment · {money(grand)}</h3>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#af4408]"><X className="w-5 h-5" /></button>
        </div>
        {!split ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              {METHODS.map(m => (
                <button key={m} onClick={() => single(m)} disabled={busy}
                  className="capitalize border border-[#D4B896] hover:border-[#af4408] hover:bg-[#FFF1E3] rounded-lg py-3 text-sm font-medium text-[#2D1B0E] disabled:opacity-50">{m}</button>
              ))}
            </div>
            <button onClick={() => setSplit(true)} className="mt-3 text-sm text-[#af4408] font-medium">Split payment →</button>
          </>
        ) : (
          <>
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2 mb-2">
                <select value={r.method} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, method: e.target.value } : x))} className="capitalize bg-white border border-[#D4B896] rounded px-2 py-2 text-sm">
                  {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <input value={r.amount} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, amount: e.target.value.replace(/[^\d.]/g, '') } : x))} className="flex-1 bg-white border border-[#D4B896] rounded px-2 py-2 text-sm" placeholder="0" />
                {rows.length > 1 && <button onClick={() => setRows(rows.filter((_, j) => j !== i))} className="text-red-500"><X className="w-4 h-4" /></button>}
              </div>
            ))}
            <div className="flex items-center justify-between text-xs mb-3">
              <button onClick={() => setRows([...rows, { method: 'cash', amount: String(remaining > 0 ? remaining : 0) }])} className="text-[#af4408] font-medium">+ Add tender</button>
              <span className={remaining === 0 ? 'text-emerald-700' : 'text-amber-700'}>{remaining === 0 ? 'Balanced' : `Remaining ${money(remaining)}`}</span>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setSplit(false)} className="flex-1 border border-[#D4B896] rounded-lg py-2 text-sm">Back</button>
              <button onClick={settleSplit} disabled={busy || Math.abs(sum - grand) > 1} className="flex-1 bg-[#af4408] text-white rounded-lg py-2 text-sm font-semibold disabled:opacity-50">{busy ? 'Settling…' : `Settle ${money(grand)}`}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
