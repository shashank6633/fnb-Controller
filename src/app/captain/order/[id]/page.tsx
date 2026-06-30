'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import {
  ArrowLeft, Search, Plus, Minus, Trash2, Loader2, Send, Receipt, X, ShoppingBag,
  ArrowLeftRight, GitMerge, ChefHat, Flame, CheckCircle2,
} from 'lucide-react';

interface MenuItem { id: string; name: string; category: string; station: string; item_type: string; dietary_tag: string; selling_price: number; is_active: number; recipe_id: string | null; }
interface OrderItem { id: string; name: string; quantity: number; unit_price: number; line_total: number; status: string; notes: string; kot_status?: string | null; }
interface TableLite { id: string; table_number: string; zone: string; open_order_id: string | null; open_order_number: number | null; open_order_total: number | null; }

// Per-item kitchen state badge from order_items.status + the KOT status.
function itemState(it: OrderItem): { label: string; cls: string; Icon: any } | null {
  if (it.status === 'pending') return { label: 'New', cls: 'text-[#8B7355] bg-[#FFF1E3]', Icon: Plus };
  const k = it.kot_status;
  if (k === 'ready') return { label: 'Ready', cls: 'text-green-700 bg-green-100', Icon: CheckCircle2 };
  if (k === 'preparing') return { label: 'Cooking', cls: 'text-amber-700 bg-amber-100', Icon: Flame };
  if (k === 'served') return { label: 'Served', cls: 'text-[#6B5744] bg-gray-100', Icon: CheckCircle2 };
  return { label: 'Sent', cls: 'text-blue-700 bg-blue-100', Icon: ChefHat };
}
interface Order {
  id: string; order_number: number; status: string; order_type: string;
  table_number: string | null; zone: string | null;
  subtotal: number; tax_total: number; discount: number; total: number;
  items: OrderItem[];
}

// Common modifiers offered as quick chips (captain can also type free instructions).
const MODIFIERS = ['Less Spicy', 'Medium Spicy', 'Extra Spicy', 'No Onion', 'No Garlic', 'Extra Gravy', 'Extra Cheese', 'Less Oil', 'Jain'];
const PORTIONS = ['Full', 'Half', 'Parcel'];

const vegColor = (tag: string) => /non/i.test(tag) ? 'border-red-500' : /egg/i.test(tag) ? 'border-amber-500' : 'border-green-600';

export default function CaptainOrder() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [cat, setCat] = useState('All');
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'menu' | 'cart'>('menu');
  const [pending, setPending] = useState<string | null>(null);
  const [firing, setFiring] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [settleOpen, setSettleOpen] = useState(false);
  const [settling, setSettling] = useState(false);
  const [printingBill, setPrintingBill] = useState(false);

  // Modifier sheet
  const [sheet, setSheet] = useState<MenuItem | null>(null);
  const [mQty, setMQty] = useState(1);
  const [mPortion, setMPortion] = useState('Full');
  const [mMods, setMMods] = useState<string[]>([]);
  const [mNote, setMNote] = useState('');

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2500); };

  const loadOrder = useCallback(async () => {
    const r = await api(`/api/dine-in/orders/${id}`);
    const j = await r.json();
    if (j.order) setOrder(j.order);
  }, [id]);

  useEffect(() => {
    loadOrder();
    fetch('/api/menu-items').then((r) => r.json()).then((j) => {
      setMenu((j.items || []).filter((m: MenuItem) => m.is_active && m.selling_price > 0));
      setCats(['All', ...(j.categories || [])]);
    }).catch(() => {});
  }, [loadOrder]);

  const visibleMenu = useMemo(() => menu.filter((m) =>
    (cat === 'All' || m.category === cat) && (!q || m.name.toLowerCase().includes(q.toLowerCase()))), [menu, cat, q]);

  const pendingCount = order?.items.filter((i) => i.status === 'pending').length || 0;
  const cartCount = order?.items.reduce((s, i) => s + i.quantity, 0) || 0;

  function openSheet(m: MenuItem) { setSheet(m); setMQty(1); setMPortion('Full'); setMMods([]); setMNote(''); }
  const toggleMod = (mod: string) => setMMods((p) => p.includes(mod) ? p.filter((x) => x !== mod) : [...p, mod]);

  function buildNotes() {
    const parts: string[] = [];
    if (mPortion && mPortion !== 'Full') parts.push(mPortion);
    if (mMods.length) parts.push(mMods.join(', '));
    if (mNote.trim()) parts.push(`“${mNote.trim()}”`);
    return parts.join(' · ');
  }

  async function addItem() {
    if (!sheet) return;
    setPending('add');
    try {
      const r = await api(`/api/dine-in/orders/${id}`, { method: 'PATCH', body: { action: 'add_item', menu_item_id: sheet.id, quantity: mQty, notes: buildNotes() } });
      const j = await r.json();
      if (j.error) { alert(j.error); return; }
      if (j.order) setOrder(j.order);
      flash(`${mQty} × ${sheet.name} added`);
      setSheet(null);
    } finally { setPending(null); }
  }

  async function patch(body: any, key: string) {
    setPending(key);
    try {
      const r = await api(`/api/dine-in/orders/${id}`, { method: 'PATCH', body });
      const j = await r.json();
      if (j.error) alert(j.error); else if (j.order) setOrder(j.order);
    } finally { setPending(null); }
  }

  async function sendKot() {
    setFiring(true);
    try {
      const r = await api(`/api/dine-in/orders/${id}`, { method: 'PATCH', body: { action: 'fire' } });
      const j = await r.json();
      if (j.error) { alert(j.error); return; }
      if (j.order) setOrder(j.order);
      flash('KOT sent to kitchen ✓');
    } finally { setFiring(false); }
  }

  // ── Table actions (move / merge) with Cashier/Manager approval ──────────────
  const [tableAction, setTableAction] = useState<'move' | 'merge' | null>(null);
  const [tablesList, setTablesList] = useState<TableLite[]>([]);
  const [targetId, setTargetId] = useState<string>('');
  const [appEmail, setAppEmail] = useState('');
  const [appPass, setAppPass] = useState('');
  const [needsApproval, setNeedsApproval] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  async function openTableAction(mode: 'move' | 'merge') {
    setTableAction(mode); setTargetId(''); setAppEmail(''); setAppPass(''); setNeedsApproval(false); setActionErr(null);
    try { const r = await api('/api/dine-in/tables'); const j = await r.json(); setTablesList(j.items || []); } catch {}
  }

  async function doTableAction() {
    if (!tableAction || !targetId) { setActionErr('Pick a table'); return; }
    setActionBusy(true); setActionErr(null);
    try {
      const body: any = tableAction === 'move'
        ? { action: 'transfer', target_table_id: targetId }
        : { action: 'merge', source_order_id: targetId };
      if (needsApproval) { body.approver_email = appEmail; body.approver_password = appPass; }
      const r = await api(`/api/dine-in/orders/${id}`, { method: 'PATCH', body });
      const j = await r.json();
      if (r.status === 403 && j.needs_approval) { setNeedsApproval(true); setActionErr('A Cashier or Manager must approve — enter their login.'); return; }
      if (j.error) { setActionErr(j.error); return; }
      if (j.order) setOrder(j.order);
      setTableAction(null);
      flash(tableAction === 'move' ? 'Table moved ✓' : 'Tables merged ✓');
    } finally { setActionBusy(false); }
  }

  // Ask the counter print-agent to print the bill (tablet can't reach the bridge).
  async function printBillNow() {
    setPrintingBill(true);
    try {
      const r = await api(`/api/dine-in/orders/${id}/print-bill`, { method: 'POST', body: {} });
      const j = await r.json();
      if (j.error) { alert(j.error); return; }
      flash('Bill sent to counter printer ✓');
    } finally { setPrintingBill(false); }
  }

  async function settle(method: string) {
    setSettling(true);
    try {
      const r = await api(`/api/dine-in/orders/${id}/settle`, { method: 'POST', body: { payment_method: method } });
      const j = await r.json();
      if (j.error) { alert(j.error); return; }
      router.push('/captain');
    } finally { setSettling(false); }
  }

  if (!order) return <div className="flex items-center justify-center min-h-screen text-[#8B7355]"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-[#1C0F05] text-white px-3 py-2.5 flex items-center gap-3">
        <button onClick={() => router.push('/captain')} className="p-2 -ml-1 active:scale-95"><ArrowLeft className="w-5 h-5" /></button>
        <div className="flex-1 min-w-0">
          <p className="font-bold leading-tight">{order.table_number ? `Table ${order.table_number}` : 'Takeaway'} · #{order.order_number}</p>
          <p className="text-[11px] text-white/60 leading-tight">{order.zone || order.order_type}{order.status !== 'open' ? ` · ${order.status}` : ''}</p>
        </div>
        {order.status === 'open' && order.table_number && (
          <button onClick={() => openTableAction('move')} title="Move / merge table"
            className="p-2 text-white/70 hover:text-white active:scale-95"><ArrowLeftRight className="w-5 h-5" /></button>
        )}
        <div className="text-right">
          <p className="text-[10px] text-white/60 leading-none">Total</p>
          <p className="font-extrabold text-[#FF8A4C]">₹{Math.round(order.total)}</p>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex bg-white border-b border-[#E8D5C4]">
        {(['menu', 'cart'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-3 text-sm font-semibold relative ${tab === t ? 'text-[#af4408]' : 'text-[#8B7355]'}`}>
            {t === 'menu' ? 'Menu' : `Order (${cartCount})`}
            {tab === t && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#af4408]" />}
          </button>
        ))}
      </div>

      {tab === 'menu' ? (
        <>
          {/* Search + categories */}
          <div className="px-3 py-2 bg-white sticky top-[52px] z-10 border-b border-[#F0E4D6]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dishes…"
                className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-xl pl-9 pr-3 py-2.5 text-sm" />
            </div>
            <div className="flex gap-2 overflow-x-auto mt-2 no-scrollbar">
              {cats.map((c) => (
                <button key={c} onClick={() => setCat(c)}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium ${cat === c ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744] border border-[#E8D5C4]'}`}>{c}</button>
              ))}
            </div>
          </div>
          {/* Menu list */}
          <main className="flex-1 px-3 py-2 pb-24">
            {visibleMenu.length === 0 ? <p className="text-center text-[#8B7355] py-10 text-sm">No items.</p> : (
              <div className="space-y-2">
                {visibleMenu.map((m) => (
                  <button key={m.id} onClick={() => openSheet(m)}
                    className="w-full flex items-center gap-3 bg-white border border-[#E8D5C4] rounded-xl px-3 py-2.5 text-left active:scale-[0.99]">
                    <span className={`shrink-0 w-3.5 h-3.5 border-2 rounded-sm flex items-center justify-center ${vegColor(m.dietary_tag)}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${/non/i.test(m.dietary_tag) ? 'bg-red-500' : /egg/i.test(m.dietary_tag) ? 'bg-amber-500' : 'bg-green-600'}`} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium text-[#2D1B0E] truncate">{m.name}</span>
                      <span className="block text-[11px] text-[#8B7355]">{m.station || m.category}</span>
                    </span>
                    <span className="font-semibold text-[#2D1B0E]">₹{m.selling_price}</span>
                    <Plus className="w-5 h-5 text-[#af4408]" />
                  </button>
                ))}
              </div>
            )}
          </main>
        </>
      ) : (
        /* Cart / running order */
        <main className="flex-1 px-3 py-2 pb-44">
          {order.items.length === 0 ? (
            <div className="text-center py-16 text-[#8B7355]"><ShoppingBag className="w-8 h-8 mx-auto mb-2 opacity-50" />No items yet — add from the Menu.</div>
          ) : order.items.map((it) => {
            const editable = order.status === 'open' && it.status === 'pending';
            return (
              <div key={it.id} className="bg-white border border-[#E8D5C4] rounded-xl px-3 py-2.5 mb-2">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-[#2D1B0E] flex items-center gap-2 flex-wrap">
                      <span>{it.name}</span>
                      {(() => { const s = itemState(it); return s ? <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${s.cls}`}><s.Icon className="w-3 h-3" />{s.label}</span> : null; })()}
                    </p>
                    {it.notes && <p className="text-[11px] text-[#af4408] mt-0.5">{it.notes}</p>}
                  </div>
                  <p className="font-semibold text-[#2D1B0E]">₹{Math.round(it.line_total)}</p>
                </div>
                <div className="flex items-center justify-between mt-2">
                  {editable ? (
                    <div className="flex items-center gap-3">
                      <button onClick={() => it.quantity <= 1 ? patch({ action: 'remove_item', item_id: it.id }, it.id) : patch({ action: 'set_qty', item_id: it.id, quantity: it.quantity - 1 }, it.id)}
                        className="w-9 h-9 rounded-full bg-[#FFF1E3] border border-[#D4B896] flex items-center justify-center active:scale-90">
                        {it.quantity <= 1 ? <Trash2 className="w-4 h-4 text-red-500" /> : <Minus className="w-4 h-4 text-[#6B5744]" />}</button>
                      <span className="w-6 text-center font-bold">{it.quantity}</span>
                      <button onClick={() => patch({ action: 'set_qty', item_id: it.id, quantity: it.quantity + 1 }, it.id)}
                        className="w-9 h-9 rounded-full bg-[#af4408] text-white flex items-center justify-center active:scale-90"><Plus className="w-4 h-4" /></button>
                    </div>
                  ) : <span className="text-sm text-[#8B7355]">Qty {it.quantity}</span>}
                  {pending === it.id && <Loader2 className="w-4 h-4 animate-spin text-[#af4408]" />}
                </div>
              </div>
            );
          })}
          {order.items.length > 0 && (
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 mt-3 text-sm space-y-1">
              <div className="flex justify-between text-[#6B5744]"><span>Subtotal</span><span>₹{Math.round(order.subtotal)}</span></div>
              <div className="flex justify-between text-[#6B5744]"><span>Tax</span><span>₹{Math.round(order.tax_total)}</span></div>
              {order.discount > 0 && <div className="flex justify-between text-[#6B5744]"><span>Discount</span><span>−₹{Math.round(order.discount)}</span></div>}
              <div className="flex justify-between font-bold text-[#2D1B0E] text-base pt-1 border-t border-[#F0E4D6]"><span>Total</span><span>₹{Math.round(order.total)}</span></div>
            </div>
          )}
        </main>
      )}

      {/* Bottom action bar */}
      {order.status === 'open' && (
        <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-3xl bg-white border-t border-[#E8D5C4] px-3 py-2.5 flex items-center gap-2">
          <button onClick={() => setSettleOpen(true)} className="flex items-center gap-1.5 border border-[#af4408] text-[#af4408] px-4 py-3 rounded-xl text-sm font-semibold active:scale-95">
            <Receipt className="w-4 h-4" /> Bill
          </button>
          <button onClick={sendKot} disabled={firing || pendingCount === 0}
            className="flex-1 flex items-center justify-center gap-2 bg-[#FF6B35] disabled:opacity-40 text-white py-3 rounded-xl text-sm font-bold active:scale-95">
            {firing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
            Send KOT{pendingCount > 0 ? ` (${pendingCount})` : ''}
          </button>
        </div>
      )}

      {/* Modifier bottom sheet */}
      {sheet && (
        <div className="fixed inset-0 z-40 flex items-end" onClick={() => setSheet(null)}>
          <div className="absolute inset-0 bg-black/40" />
          <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-3xl mx-auto bg-white rounded-t-3xl p-4 pb-6 max-h-[85vh] overflow-y-auto">
            <div className="flex items-start justify-between mb-3">
              <div>
                <p className="font-bold text-lg text-[#2D1B0E]">{sheet.name}</p>
                <p className="text-sm text-[#8B7355]">₹{sheet.selling_price} · {sheet.station || sheet.category}</p>
              </div>
              <button onClick={() => setSheet(null)} className="p-1"><X className="w-5 h-5 text-[#8B7355]" /></button>
            </div>

            <p className="text-xs font-semibold text-[#8B7355] mb-1.5">Portion</p>
            <div className="flex gap-2 mb-4">
              {PORTIONS.map((p) => (
                <button key={p} onClick={() => setMPortion(p)}
                  className={`px-4 py-2 rounded-full text-sm font-medium ${mPortion === p ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744] border border-[#E8D5C4]'}`}>{p}</button>
              ))}
            </div>

            <p className="text-xs font-semibold text-[#8B7355] mb-1.5">Modifiers</p>
            <div className="flex flex-wrap gap-2 mb-4">
              {MODIFIERS.map((mod) => (
                <button key={mod} onClick={() => toggleMod(mod)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium ${mMods.includes(mod) ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744] border border-[#E8D5C4]'}`}>{mod}</button>
              ))}
            </div>

            <p className="text-xs font-semibold text-[#8B7355] mb-1.5">Cooking instructions</p>
            <textarea value={mNote} onChange={(e) => setMNote(e.target.value)} rows={2} placeholder="e.g. make it crispy, serve with extra napkins…"
              className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-xl px-3 py-2 text-sm mb-4" />

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-3">
                <button onClick={() => setMQty(Math.max(1, mQty - 1))} className="w-11 h-11 rounded-full bg-[#FFF1E3] border border-[#D4B896] flex items-center justify-center active:scale-90"><Minus className="w-5 h-5 text-[#6B5744]" /></button>
                <span className="w-6 text-center text-lg font-bold">{mQty}</span>
                <button onClick={() => setMQty(mQty + 1)} className="w-11 h-11 rounded-full bg-[#FFF1E3] border border-[#D4B896] flex items-center justify-center active:scale-90"><Plus className="w-5 h-5 text-[#6B5744]" /></button>
              </div>
              <button onClick={addItem} disabled={pending === 'add'}
                className="flex-1 flex items-center justify-center gap-2 bg-[#af4408] text-white py-3.5 rounded-xl font-bold active:scale-95 disabled:opacity-50">
                {pending === 'add' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Plus className="w-5 h-5" />} Add · ₹{sheet.selling_price * mQty}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move / Merge table sheet */}
      {tableAction && (
        <div className="fixed inset-0 z-40 flex items-end" onClick={() => setTableAction(null)}>
          <div className="absolute inset-0 bg-black/40" />
          <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-3xl mx-auto bg-white rounded-t-3xl p-4 pb-6 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <p className="font-bold text-lg text-[#2D1B0E]">Table actions</p>
              <button onClick={() => setTableAction(null)} className="p-1"><X className="w-5 h-5 text-[#8B7355]" /></button>
            </div>
            <div className="flex bg-[#FFF1E3] rounded-lg p-0.5 text-sm mb-3">
              {(['move', 'merge'] as const).map((m) => (
                <button key={m} onClick={() => { setTableAction(m); setTargetId(''); setNeedsApproval(false); setActionErr(null); }}
                  className={`flex-1 py-2 rounded-md font-medium ${tableAction === m ? 'bg-[#af4408] text-white' : 'text-[#6B5744]'}`}>
                  {m === 'move' ? 'Move to free table' : 'Merge another table'}
                </button>
              ))}
            </div>
            <p className="text-xs text-[#8B7355] mb-2">
              {tableAction === 'move' ? 'Pick an empty table to move this order to.' : 'Pick another open table to merge into this one (that table then closes).'}
            </p>
            {(() => {
              const opts = tableAction === 'move'
                ? tablesList.filter((t) => !t.open_order_id)
                : tablesList.filter((t) => t.open_order_id && t.open_order_id !== id);
              if (opts.length === 0) return <p className="text-center text-sm text-[#8B7355] py-4">{tableAction === 'move' ? 'No free tables available' : 'No other open tables'}</p>;
              return (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-3">
                  {opts.map((t) => {
                    const val = tableAction === 'move' ? t.id : (t.open_order_id as string);
                    return (
                      <button key={t.id} onClick={() => setTargetId(val)}
                        className={`rounded-xl p-3 border text-center ${targetId === val ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-[#FFF1E3] border-[#E8D5C4] text-[#2D1B0E]'}`}>
                        <p className="font-bold leading-none">{t.table_number}</p>
                        <p className="text-[10px] opacity-80 mt-1 leading-none">{t.zone || 'Floor'}{t.open_order_id ? ` · ₹${Math.round(t.open_order_total || 0)}` : ''}</p>
                      </button>
                    );
                  })}
                </div>
              );
            })()}
            {needsApproval && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3 space-y-2">
                <p className="text-xs font-semibold text-amber-800">Cashier / Manager approval required</p>
                <input value={appEmail} onChange={(e) => setAppEmail(e.target.value)} placeholder="Approver email"
                  className="w-full border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
                <input type="password" value={appPass} onChange={(e) => setAppPass(e.target.value)} placeholder="Approver password"
                  className="w-full border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
              </div>
            )}
            {actionErr && <p className="text-sm text-red-600 mb-2">{actionErr}</p>}
            <button onClick={doTableAction} disabled={actionBusy || !targetId}
              className="w-full flex items-center justify-center gap-2 bg-[#af4408] text-white py-3 rounded-xl font-bold active:scale-95 disabled:opacity-50">
              {actionBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : tableAction === 'move' ? <ArrowLeftRight className="w-5 h-5" /> : <GitMerge className="w-5 h-5" />}
              {tableAction === 'move' ? 'Move order here' : 'Merge into this table'}
            </button>
          </div>
        </div>
      )}

      {/* Settle sheet */}
      {settleOpen && (
        <div className="fixed inset-0 z-40 flex items-end" onClick={() => setSettleOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-3xl mx-auto bg-white rounded-t-3xl p-4 pb-6">
            <div className="flex items-center justify-between mb-1">
              <p className="font-bold text-lg text-[#2D1B0E]">Collect payment</p>
              <button onClick={() => setSettleOpen(false)} className="p-1"><X className="w-5 h-5 text-[#8B7355]" /></button>
            </div>
            <p className="text-sm text-[#8B7355] mb-3">Total due <b className="text-[#2D1B0E]">₹{Math.round(order.total)}</b></p>
            <button onClick={printBillNow} disabled={printingBill}
              className="w-full flex items-center justify-center gap-2 border border-[#af4408] text-[#af4408] py-3 rounded-xl text-sm font-semibold active:scale-95 disabled:opacity-50 mb-3">
              {printingBill ? <Loader2 className="w-4 h-4 animate-spin" /> : <Receipt className="w-4 h-4" />} Print bill at counter
            </button>
            <p className="text-xs font-semibold text-[#8B7355] mb-1.5">Collect &amp; close</p>
            <div className="grid grid-cols-3 gap-2">
              {['cash', 'upi', 'card'].map((mthd) => (
                <button key={mthd} onClick={() => settle(mthd)} disabled={settling}
                  className="flex flex-col items-center gap-1 bg-[#FFF1E3] border border-[#D4B896] rounded-xl py-4 active:scale-95 disabled:opacity-50">
                  <span className="text-sm font-semibold text-[#2D1B0E] uppercase">{mthd}</span>
                </button>
              ))}
            </div>
            {settling && <p className="text-center text-sm text-[#8B7355] mt-3"><Loader2 className="w-4 h-4 animate-spin inline" /> Settling…</p>}
          </div>
        </div>
      )}

      {toast && <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-full shadow-lg">{toast}</div>}
    </div>
  );
}
