'use client';

import { useEffect, useState, useCallback, useMemo, useContext, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import {
  ArrowLeft, Search, Plus, Minus, Trash2, Loader2, Send, Receipt, X, ShoppingBag,
  ArrowLeftRight, GitMerge, ChefHat, Flame, CheckCircle2, Menu, Filter, ChevronDown,
  AlertTriangle, Printer, Timer, Check, Users, BellRing, BadgePercent, Percent,
  MessageCircle,
} from 'lucide-react';
import { CaptainUI } from '../../CaptainShell';

interface MenuItem { id: string; name: string; category: string; station: string; item_type: string; dietary_tag: string; selling_price: number; is_active: number; recipe_id: string | null; }
interface OrderItem { id: string; name: string; quantity: number; unit_price: number; line_total: number; status: string; notes: string; menu_item_id?: string | null; kot_status?: string | null; prep_minutes?: number | null; fired_at?: string | null; completed_at?: string | null; }
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
interface KotInfo {
  id: string; kot_number: number; station: string; status: string; created_at: string;
  reprint_count?: number;
  print_status: 'printed' | 'failed' | 'queued' | null;   // null = no agent report yet
  print_error?: string | null;
}
interface Order {
  id: string; order_number: number; status: string; order_type: string;
  table_number: string | null; zone: string | null;
  guest_name: string | null; guest_mobile: string | null; covers: number | null;
  service_charge_reason?: string | null;
  subtotal: number; tax_total: number; discount: number; total: number;
  items: OrderItem[];
  kots?: KotInfo[];
}

// Current signed-in user (from /api/auth/me). We only care about the discount
// flags here; captains lack can_request_discount and never see the control.
interface Me {
  id: string; name: string; role: string;
  is_head_chef?: number | boolean;
  can_request_discount?: number | boolean;
  max_discount_pct?: number | null;
}

// Latest remote discount request for this order (GET /api/dine-in/discount-requests?order_id=…).
interface DiscReq {
  id: string; status: 'pending' | 'approved' | 'rejected';
  requested_pct: number; reason: string;
  decided_by?: string | null; decided_note?: string | null;
}

// Parse a SQLite/ISO timestamp (space or 'T' separated) as UTC → ms epoch.
function parseTs(s?: string | null): number {
  if (!s) return NaN;
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z';
  return Date.parse(withZ);
}
// mm:ss from a positive millisecond span (clamped at 0).
function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Common modifiers offered as quick chips (captain can also type free instructions).
const MODIFIERS = ['Less Spicy', 'Medium Spicy', 'Extra Spicy', 'No Onion', 'No Garlic', 'Extra Gravy', 'Extra Cheese', 'Less Oil', 'Jain'];
const PORTIONS = ['Full', 'Half', 'Parcel'];

const vegColor = (tag: string) => /non/i.test(tag) ? 'border-red-500' : /egg/i.test(tag) ? 'border-amber-500' : 'border-green-600';

// "Often ordered with" suggestion returned by /api/dine-in/upsell.
interface UpsellItem { menu_item_id: string; name: string; price: number; times_together: number; }

// Client-side mirror of normalizeMobile() — bare 10 digits for the wa.me link.
function waMobile(raw: string): string {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length === 10 ? d : '';
}

export default function CaptainOrder() {
  const router = useRouter();
  const { openTables } = useContext(CaptainUI);
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [cat, setCat] = useState('All');
  const [catPickerOpen, setCatPickerOpen] = useState(false);
  const [catSearch, setCatSearch] = useState('');
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'menu' | 'cart'>('menu');
  const [pending, setPending] = useState<string | null>(null);
  const [firing, setFiring] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [settleOpen, setSettleOpen] = useState(false);
  const [settling, setSettling] = useState(false);
  const [printingBill, setPrintingBill] = useState(false);

  // Signed-in user — drives the cashier-only discount / service-charge controls.
  const [me, setMe] = useState<Me | null>(null);
  const canDiscount = !!(me && (me.can_request_discount === 1 || me.can_request_discount === true));
  const maxDiscountPct = Number(me?.max_discount_pct ?? 0) || 0;

  // 1-second wall clock — re-renders the per-item count-up timers.
  const [now, setNow] = useState(() => Date.now());

  // ── Guest capture at settle (feeds CRM loyalty) + WhatsApp review request ──
  const [gMobile, setGMobile] = useState('');
  const [gName, setGName] = useState('');
  const [reviewLink, setReviewLink] = useState('');
  // Set after a settle where a guest mobile was captured → shows the success
  // sheet (review request) instead of navigating straight back to the floor.
  const [settledInfo, setSettledInfo] = useState<{ mobile: string; total: number } | null>(null);

  // ── Upsell suggestions ("often ordered with") for the current cart ──
  const [upsell, setUpsell] = useState<UpsellItem[]>([]);
  const [regulars, setRegulars] = useState<{ id: string; name: string; price: number; times: number }[]>([]);

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
    // Who am I? Only cashiers/managers (can_request_discount) get the bill controls.
    fetch('/api/auth/me').then((r) => r.json()).then((j) => { if (j.user) setMe(j.user); }).catch(() => {});
    // Google review URL (crm_review_link) — powers the WhatsApp review button.
    fetch('/api/settings?key=crm_review_link').then((r) => r.json()).then((j) => setReviewLink(String(j?.value || '').trim())).catch(() => {});
  }, [loadOrder]);

  // Prefill the settle sheet's guest fields from the order's opening capture
  // (never overwrites something the captain already typed).
  useEffect(() => {
    if (!settleOpen) return;
    setGMobile((prev) => prev || order?.guest_mobile || '');
    setGName((prev) => prev || order?.guest_name || '');
  }, [settleOpen, order?.guest_mobile, order?.guest_name]);

  // Debounced (800ms) refetch of upsell suggestions whenever the cart changes.
  const cartIdsKey = useMemo(() => Array.from(new Set(
    (order?.items || []).map((i) => i.menu_item_id).filter(Boolean) as string[],
  )).sort().join(','), [order]);
  useEffect(() => {
    if (!cartIdsKey || order?.status !== 'open') { setUpsell([]); return; }
    const t = setTimeout(() => {
      api(`/api/dine-in/upsell?item_ids=${encodeURIComponent(cartIdsKey)}`)
        .then((r) => r.json())
        .then((j) => setUpsell(Array.isArray(j?.items) ? j.items : []))
        .catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [cartIdsKey, order?.status]);

  // Only suggest items we can actually open in the modifier sheet (present in
  // the loaded menu) — a tapped chip then adds EXACTLY like the menu grid.
  const upsellChips = useMemo(() => upsell
    .map((u) => ({ u, m: menu.find((mi) => mi.id === u.menu_item_id) }))
    .filter((x): x is { u: UpsellItem; m: MenuItem } => !!x.m), [upsell, menu]);

  // "Usually orders" — this returning guest's own most-frequent items, so the
  // captain can add the regulars in one tap. Keyed on the order's guest mobile.
  const guestMobile = order?.guest_mobile || '';
  useEffect(() => {
    if (!guestMobile || order?.status !== 'open') { setRegulars([]); return; }
    api(`/api/dine-in/guest-regulars?mobile=${encodeURIComponent(guestMobile)}&exclude=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => setRegulars(Array.isArray(j?.items) ? j.items : []))
      .catch(() => {});
  }, [guestMobile, order?.status, id]);
  const regularChips = useMemo(() => regulars
    .map((g) => ({ g, m: menu.find((mi) => mi.id === g.id) }))
    .filter((x): x is { g: { id: string; name: string; price: number; times: number }; m: MenuItem } => !!x.m)
    .slice(0, 6), [regulars, menu]);

  // 1s ticker so every fired-item count-up timer stays live. Only runs while the
  // order is open (no point ticking on a settled/closed order).
  useEffect(() => {
    if (order?.status !== 'open') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [order?.status]);

  // ── KOT print-status watch: warn the captain if a fired ticket didn't reach
  // the counter printer (failed, or unconfirmed for a while = agent/printer down).
  const [resending, setResending] = useState<string | null>(null);
  const printAlerts = useMemo(() => {
    const now = Date.now();
    return (order?.kots || []).filter((k) => {
      if (k.print_status === 'printed') return false;
      if (k.print_status === 'failed') return true;
      // queued / no report yet → flag only after a grace period (give it time)
      const fired = Date.parse((k.created_at || '').replace(' ', 'T') + 'Z');
      return Number.isFinite(fired) && now - fired > 25000;
    });
  }, [order]);
  const allPrinted = !!order?.kots?.length && (order.kots || []).every((k) => k.print_status === 'printed');

  // Poll while any KOT is still unconfirmed, so the alert surfaces within seconds.
  useEffect(() => {
    if (!order || order.status !== 'open') return;
    if ((order.kots || []).every((k) => k.print_status === 'printed')) return;
    const t = setInterval(loadOrder, 6000);
    return () => clearInterval(t);
  }, [order, loadOrder]);

  // Buzz the tablet when a NEW print problem appears (operations must notice it).
  const prevAlerts = useRef(0);
  useEffect(() => {
    if (printAlerts.length > prevAlerts.current) { try { (navigator as any).vibrate?.([180, 90, 180]); } catch {} }
    prevAlerts.current = printAlerts.length;
  }, [printAlerts.length]);

  async function resendKot(kotId: string) {
    setResending(kotId);
    try {
      const r = await api(`/api/dine-in/kds/${kotId}/resend`, { method: 'POST', body: {} });
      const j = await r.json();
      if (j.error) { alert(j.error); return; }
      flash('Re-sent to counter printer ✓');
      setTimeout(loadOrder, 1500);   // let the agent print + report back
    } finally { setResending(null); }
  }

  const visibleMenu = useMemo(() => menu.filter((m) =>
    (cat === 'All' || m.category === cat) && (!q || m.name.toLowerCase().includes(q.toLowerCase()))), [menu, cat, q]);
  // Item count per category (for the picker).
  const catCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const it of menu) m[it.category] = (m[it.category] || 0) + 1;
    return m;
  }, [menu]);

  const pendingCount = order?.items.filter((i) => i.status === 'pending').length || 0;
  const cartCount = order?.items.reduce((s, i) => s + i.quantity, 0) || 0;

  // Bill gating — a fired item (fired_at set) counts as "in the kitchen"; the bill
  // can only be raised once every such item has been marked completed.
  const firedItems = useMemo(() => (order?.items || []).filter((i) => !!i.fired_at), [order]);
  const firedIncomplete = useMemo(() => firedItems.filter((i) => !i.completed_at), [firedItems]);
  const canBill = firedIncomplete.length === 0;

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
      const mob = gMobile.trim();
      if (mob) {
        // Fire-and-forget AFTER the settle succeeded — a guest-capture failure
        // (bad mobile, offline, …) must never block or undo the settle.
        api('/api/crm/guests/settle-capture', {
          method: 'POST',
          body: { mobile: mob, name: gName.trim() || undefined, order_id: id, bill_amount: j.total ?? order?.total ?? 0 },
        }).then(async (res) => {
          const g = await res.json().catch(() => ({} as any));
          if (res.ok && !g.deduped) flash(`Guest saved · ${Math.round(Number(g.points_earned) || 0)} pts`);
        }).catch(() => {});
        // Stay on the page: show the settle-success sheet (review request).
        setSettleOpen(false);
        setSettledInfo({ mobile: mob, total: Number(j.total ?? order?.total ?? 0) });
        loadOrder();
        return;
      }
      router.push('/captain');
    } finally { setSettling(false); }
  }

  // Mark a fired item done / un-done (stops or restarts its count-up timer + the
  // bill gate). Uses the shared PATCH endpoint; key = item id so its row spins.
  async function toggleComplete(it: OrderItem) {
    const done = !!it.completed_at;
    await patch({ action: done ? 'uncomplete_item' : 'complete_item', item_id: it.id }, it.id);
  }

  // ── KOT escalation — when re-sending a stuck ticket still doesn't reach the
  // counter printer, page the manager + kitchen so someone acts on it. ─────────
  const [escalating, setEscalating] = useState<string | null>(null);
  const [escalated, setEscalated] = useState<Record<string, boolean>>({});
  async function escalateKot(kotId: string) {
    setEscalating(kotId);
    try {
      const r = await api(`/api/dine-in/kds/${kotId}/escalate`, { method: 'POST', body: { reason: 'KOT not printing' } });
      const j = await r.json();
      if (j.error) { alert(j.error); return; }
      setEscalated((p) => ({ ...p, [kotId]: true }));
      flash('Manager & kitchen alerted ✓');
    } finally { setEscalating(null); }
  }

  // ── Cashier-only bill adjustments (discount request + remove service charge) ──
  const [discOpen, setDiscOpen] = useState(false);
  const [discPct, setDiscPct] = useState('');
  const [discEmail, setDiscEmail] = useState('');
  const [discPass, setDiscPass] = useState('');
  const [discBusy, setDiscBusy] = useState(false);
  const [discErr, setDiscErr] = useState<string | null>(null);

  // ── Remote discount approval (parallel to the at-the-till approver login) ──
  // The cashier files a request; a Manager/Admin approves it from the
  // /dine-in/discount-approvals page (bell notification). We poll the latest
  // request for this order every ~20s to drive the pending/rejected chip and
  // refresh the bill the moment it's approved.
  const [discReason, setDiscReason] = useState('');
  const [discReqBusy, setDiscReqBusy] = useState(false);
  const [discReq, setDiscReq] = useState<DiscReq | null>(null);
  const [dismissedReqIds, setDismissedReqIds] = useState<Set<string>>(new Set());
  const lastReqRef = useRef<{ id: string; status: string } | null>(null);

  const pollDiscReq = useCallback(async () => {
    try {
      const r = await api(`/api/dine-in/discount-requests?order_id=${id}`);
      if (!r.ok) return;
      const j = await r.json();
      const req: DiscReq | null = j.request || null;
      const prev = lastReqRef.current;
      // Transition detection: pending → approved refreshes the bill (totals
      // recompute through the existing loadOrder path); pending → rejected flashes.
      if (req && prev && prev.id === req.id && prev.status === 'pending' && req.status !== 'pending') {
        if (req.status === 'approved') { flash(`Discount ${req.requested_pct}% approved ✓`); loadOrder(); }
        else if (req.status === 'rejected') flash('Discount request rejected');
      }
      lastReqRef.current = req ? { id: req.id, status: req.status } : null;
      setDiscReq(req);
    } catch { /* offline — keep last state */ }
  }, [id, loadOrder]);

  useEffect(() => {
    if (!canDiscount || !order || order.status !== 'open') return;
    pollDiscReq();
    const t = setInterval(pollDiscReq, 20000);
    return () => clearInterval(t);
  }, [canDiscount, order?.status, pollDiscReq]);  // eslint-disable-line react-hooks/exhaustive-deps

  async function requestRemoteApproval() {
    const pct = Number(discPct);
    if (!Number.isFinite(pct) || pct <= 0) { setDiscErr('Enter a discount %'); return; }
    if (maxDiscountPct > 0 && pct > maxDiscountPct) { setDiscErr(`Max you can request is ${maxDiscountPct}%`); return; }
    setDiscReqBusy(true); setDiscErr(null);
    try {
      const r = await api('/api/dine-in/discount-requests', {
        method: 'POST', body: { order_id: id, pct, reason: discReason.trim() },
      });
      const j = await r.json();
      if (j.error) { setDiscErr(j.error); return; }
      if (j.request) { lastReqRef.current = { id: j.request.id, status: j.request.status }; setDiscReq(j.request); }
      setDiscOpen(false); setDiscPct(''); setDiscReason(''); setDiscEmail(''); setDiscPass('');
      flash(`Discount ${pct}% requested — awaiting approval`);
    } finally { setDiscReqBusy(false); }
  }

  async function requestDiscount() {
    const pct = Number(discPct);
    if (!Number.isFinite(pct) || pct <= 0) { setDiscErr('Enter a discount %'); return; }
    if (maxDiscountPct > 0 && pct > maxDiscountPct) { setDiscErr(`Max you can request is ${maxDiscountPct}%`); return; }
    if (!discEmail || !discPass) { setDiscErr('Approver email & password required'); return; }
    setDiscBusy(true); setDiscErr(null);
    try {
      const r = await api(`/api/dine-in/orders/${id}/discount`, {
        method: 'POST', body: { pct, approver_email: discEmail, approver_password: discPass },
      });
      const j = await r.json();
      if (r.status === 403 && j.needs_approval) { setDiscErr('A Manager or Admin must approve — check the login.'); return; }
      if (j.error) { setDiscErr(j.error); return; }
      if (j.order) setOrder(j.order);
      setDiscOpen(false); setDiscPct(''); setDiscEmail(''); setDiscPass('');
      flash(`Discount ${pct}% applied ✓`);
    } finally { setDiscBusy(false); }
  }

  const [scOpen, setScOpen] = useState(false);
  const [scReason, setScReason] = useState('');
  const [scBusy, setScBusy] = useState(false);
  const [scErr, setScErr] = useState<string | null>(null);

  async function removeServiceCharge() {
    if (!scReason.trim()) { setScErr('A reason is required'); return; }
    setScBusy(true); setScErr(null);
    try {
      const r = await api(`/api/dine-in/orders/${id}/service-charge`, {
        method: 'POST', body: { remove: true, reason: scReason.trim() },
      });
      const j = await r.json();
      if (j.error) { setScErr(j.error); return; }
      if (j.order) setOrder(j.order);
      setScOpen(false); setScReason('');
      flash('Service charge removed ✓');
    } finally { setScBusy(false); }
  }

  if (!order) return <div className="flex items-center justify-center min-h-screen text-[#8B7355]"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-[#1C0F05] text-white px-3 py-2.5 flex items-center gap-3">
        <button onClick={openTables} className="md:hidden p-2 -ml-1 active:scale-95" aria-label="Open tables"><Menu className="w-5 h-5" /></button>
        <button onClick={() => router.push('/captain')} className="p-2 active:scale-95"><ArrowLeft className="w-5 h-5" /></button>
        <div className="flex-1 min-w-0">
          <p className="font-bold leading-tight truncate">{order.table_number ? `Table ${order.table_number}` : 'Takeaway'} · #{order.order_number}</p>
          <p className="text-[11px] text-white/60 leading-tight truncate flex items-center gap-1.5">
            <span>{order.zone || order.order_type}{order.status !== 'open' ? ` · ${order.status}` : ''}</span>
            {order.guest_name ? <span className="text-white/80">· {order.guest_name}</span> : null}
            {order.covers ? <span className="inline-flex items-center gap-0.5"><Users className="w-3 h-3" />{order.covers}</span> : null}
          </p>
        </div>
        {order.status === 'open' && order.table_number && (
          <button onClick={() => openTableAction('move')} title="Move / merge table"
            className="p-2 text-white/70 hover:text-white active:scale-95"><ArrowLeftRight className="w-5 h-5" /></button>
        )}
        <div className="text-right">
          <p className="text-[10px] text-white/60 leading-none">Amount</p>
          <p className="font-extrabold text-[#FF8A4C]">₹{Math.round(order.total)}</p>
        </div>
      </header>

      {/* Print-failure alert — a fired KOT may not have reached the counter printer */}
      {printAlerts.length > 0 && (
        <div className="bg-red-600 text-white sticky top-[52px] z-20">
          <div className="px-3 py-2 flex items-start gap-2 text-sm font-semibold">
            <AlertTriangle className="w-5 h-5 shrink-0 animate-pulse mt-0.5" />
            <span>{printAlerts.length} KOT{printAlerts.length > 1 ? 's' : ''} may not have printed — tell the counter, then re-send below.</span>
          </div>
          <div className="px-3 pb-2 flex flex-wrap gap-2">
            {printAlerts.map((k) => (
              <div key={k.id} className="flex flex-wrap items-center gap-1.5">
                <button onClick={() => resendKot(k.id)} disabled={resending === k.id}
                  className="bg-white/15 hover:bg-white/25 active:scale-95 rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center gap-1.5 disabled:opacity-60">
                  {resending === k.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
                  Re-send KOT #{k.kot_number}{k.station ? ` · ${String(k.station).toUpperCase()}` : ''}
                </button>
                {/* If re-sends still fail (agent/printer down), page the manager & kitchen. */}
                {escalated[k.id] ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg bg-white/20">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Alerted
                  </span>
                ) : (
                  <button onClick={() => escalateKot(k.id)} disabled={escalating === k.id}
                    className="bg-white text-red-700 hover:bg-white/90 active:scale-95 rounded-lg px-2.5 py-1.5 text-xs font-bold flex items-center gap-1.5 disabled:opacity-60">
                    {escalating === k.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellRing className="w-3.5 h-3.5" />}
                    Alert Manager &amp; Kitchen
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {allPrinted && printAlerts.length === 0 && order.status === 'open' && (
        <div className="bg-green-50 text-green-800 px-3 py-1.5 text-xs font-medium flex items-center gap-1.5 border-b border-green-100">
          <CheckCircle2 className="w-3.5 h-3.5" /> All KOTs printed at the counter
        </div>
      )}

      {/* Remote discount request status chip (cashier view, polled ~20s) */}
      {discReq?.status === 'pending' && (
        <div className="bg-amber-50 text-amber-800 px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 border-b border-amber-200">
          <Timer className="w-3.5 h-3.5" /> Discount {discReq.requested_pct}% — awaiting approval
        </div>
      )}
      {discReq?.status === 'rejected' && !dismissedReqIds.has(discReq.id) && (
        <div className="bg-red-50 text-red-700 px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 border-b border-red-200">
          <X className="w-3.5 h-3.5" /> Discount {discReq.requested_pct}% rejected{discReq.decided_by ? ` by ${discReq.decided_by}` : ''}
          <button onClick={() => setDismissedReqIds((p) => new Set(p).add(discReq.id))}
            className="ml-auto px-2 py-0.5 rounded-md bg-red-100 text-red-700 font-bold active:scale-95" aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      )}

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
            {/* Few categories → quick chips. Many → a searchable picker so the
                bar doesn't turn into an endless horizontal scroll. */}
            {cats.length > 9 ? (
              <button onClick={() => { setCatPickerOpen(true); setCatSearch(''); }}
                className="w-full flex items-center justify-between gap-2 mt-2 bg-[#FFF1E3] border border-[#D4B896] rounded-xl px-3 py-2.5 text-sm active:scale-[0.99]">
                <span className="flex items-center gap-2 text-[#6B5744] truncate"><Filter className="w-4 h-4 shrink-0" /> {cat === 'All' ? 'All categories' : cat}</span>
                <ChevronDown className="w-4 h-4 text-[#8B7355] shrink-0" />
              </button>
            ) : (
              <div className="flex gap-2 overflow-x-auto mt-2 no-scrollbar">
                {cats.map((c) => (
                  <button key={c} onClick={() => setCat(c)}
                    className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium ${cat === c ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744] border border-[#E8D5C4]'}`}>{c}</button>
                ))}
              </div>
            )}
          </div>
          {/* Menu list */}
          <main className={`flex-1 px-3 py-2 ${upsellChips.length > 0 ? 'pb-32' : 'pb-24'}`}>
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
        <main className={`flex-1 px-3 py-2 ${upsellChips.length > 0 ? 'pb-52' : 'pb-44'}`}>
          {order.items.length === 0 ? (
            <div className="text-center py-16 text-[#8B7355]"><ShoppingBag className="w-8 h-8 mx-auto mb-2 opacity-50" />No items yet — add from the Menu.</div>
          ) : order.items.map((it) => {
            const editable = order.status === 'open' && it.status === 'pending';
            // Per-item kitchen timer: count UP from fired_at until completed_at.
            const firedMs = parseTs(it.fired_at);
            const isFired = Number.isFinite(firedMs);
            const isDone = !!it.completed_at;
            const prep = Number(it.prep_minutes) || 15;   // default 15 min when no per-dish prep time is set
            const elapsed = isDone ? (parseTs(it.completed_at) - firedMs) : (now - firedMs);
            const overdue = isFired && !isDone && prep > 0 && elapsed >= prep * 60_000;
            return (
              <div key={it.id} className={`bg-white border rounded-xl px-3 py-2.5 mb-2 ${overdue ? 'border-red-300' : 'border-[#E8D5C4]'}`}>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-[#2D1B0E] flex items-center gap-2 flex-wrap">
                      <span className={isDone ? 'line-through text-[#8B7355]' : ''}>{it.name}</span>
                      {(() => { const s = itemState(it); return s ? <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${s.cls}`}><s.Icon className="w-3 h-3" />{s.label}</span> : null; })()}
                      {/* Live count-up timer for fired, not-yet-completed items. */}
                      {isFired && !isDone && (
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full tabular-nums ${overdue ? 'text-white bg-red-600 animate-pulse' : 'text-[#6B5744] bg-[#FFF1E3] border border-[#E8D5C4]'}`}>
                          <Timer className="w-3 h-3" />{mmss(elapsed)}{prep > 0 ? ` / ${prep}m` : ''}
                        </span>
                      )}
                      {isDone && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full text-green-700 bg-green-100">
                          <Check className="w-3 h-3" /> Done{prep > 0 || isFired ? ` · ${mmss(elapsed)}` : ''}
                        </span>
                      )}
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
                  <div className="flex items-center gap-2">
                    {pending === it.id && <Loader2 className="w-4 h-4 animate-spin text-[#af4408]" />}
                    {/* Complete / un-complete — only for fired items. */}
                    {isFired && order.status === 'open' && (
                      isDone ? (
                        <button onClick={() => toggleComplete(it)} disabled={pending === it.id}
                          className="flex items-center gap-1 text-xs font-semibold text-[#8B7355] border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 active:scale-95 disabled:opacity-50">
                          <ArrowLeftRight className="w-3.5 h-3.5" /> Undo
                        </button>
                      ) : (
                        <button onClick={() => toggleComplete(it)} disabled={pending === it.id}
                          className="flex items-center gap-1 text-xs font-bold text-white bg-green-600 rounded-lg px-2.5 py-1.5 active:scale-95 disabled:opacity-50">
                          <Check className="w-3.5 h-3.5" /> Complete
                        </button>
                      )
                    )}
                  </div>
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
        // Anchored to the main column: full width on phones, offset by the sidebar
        // (w-72 = 18rem) on md+ so it never sits over the sidebar.
        <div className="fixed bottom-0 left-0 right-0 md:left-72 bg-white border-t border-[#E8D5C4] px-3 py-2.5 z-10">
          <div className="max-w-3xl mx-auto">
            {/* "Usually orders" — this returning guest's own regulars (from their
                order history). One tap opens the modifier sheet like the menu. */}
            {regularChips.length > 0 && (
              <div className="flex flex-nowrap overflow-x-auto no-scrollbar items-center gap-1.5 mb-1.5 -mx-1 px-1 [&>*]:shrink-0 [&>*]:whitespace-nowrap">
                <span className="text-[10px] font-semibold text-[#2D4A3A]">{order.guest_name ? `${order.guest_name.split(' ')[0]} usually orders:` : 'Usually orders:'}</span>
                {regularChips.map(({ g, m }) => (
                  <button key={g.id} onClick={() => openSheet(m)}
                    className="flex items-center gap-1 bg-[#E3EEE6] border border-[#CFE0D4] text-[#2D4A3A] rounded-full px-2.5 py-1 text-[11px] font-medium active:scale-95">
                    <Plus className="w-3 h-3 text-[#2D4A3A]" /> {g.name} · ₹{Math.round(g.price)}
                    <span className="text-[9px] opacity-70">×{g.times}</span>
                  </button>
                ))}
              </div>
            )}
            {/* Upsell chips — "often ordered with" the current cart. One-row
                horizontal scroll (TabScroller-style); hidden when no suggestions. */}
            {upsellChips.length > 0 && (
              <div className="flex flex-nowrap overflow-x-auto no-scrollbar items-center gap-1.5 mb-1.5 -mx-1 px-1 [&>*]:shrink-0 [&>*]:whitespace-nowrap">
                <span className="text-[10px] font-semibold text-[#8B7355]">Often ordered with:</span>
                {upsellChips.map(({ u, m }) => (
                  <button key={u.menu_item_id} onClick={() => openSheet(m)}
                    className="flex items-center gap-1 bg-[#FFF1E3] border border-[#E8D5C4] text-[#6B5744] rounded-full px-2.5 py-1 text-[11px] font-medium active:scale-95">
                    <Plus className="w-3 h-3 text-[#af4408]" /> {u.name} · ₹{Math.round(u.price)}
                  </button>
                ))}
              </div>
            )}
            {/* Bill is blocked until every fired item is completed. */}
            {!canBill && (
              <p className="text-[11px] text-[#af4408] font-medium mb-1.5 flex items-center gap-1">
                <Timer className="w-3.5 h-3.5" /> Complete all items to bill ({firedIncomplete.length} left)
              </p>
            )}
            <div className="flex items-center gap-2">
              <button onClick={() => setSettleOpen(true)} disabled={!canBill}
                title={canBill ? undefined : `Complete all items to bill (${firedIncomplete.length} left)`}
                className="flex items-center gap-1.5 border border-[#af4408] text-[#af4408] px-4 py-3 rounded-xl text-sm font-semibold active:scale-95 disabled:opacity-40 disabled:active:scale-100">
                <Receipt className="w-4 h-4" /> Bill
              </button>
              <button onClick={sendKot} disabled={firing || pendingCount === 0}
                className="flex-1 flex items-center justify-center gap-2 bg-[#FF6B35] disabled:opacity-40 text-white py-3 rounded-xl text-sm font-bold active:scale-95">
                {firing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                Send KOT{pendingCount > 0 ? ` (${pendingCount})` : ''}
              </button>
            </div>
          </div>
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
              <button onClick={() => setSheet(null)} className="p-2.5 -m-1"><X className="w-5 h-5 text-[#8B7355]" /></button>
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

      {/* Category picker (for menus with many categories) */}
      {catPickerOpen && (
        <div className="fixed inset-0 z-40 flex items-end" onClick={() => setCatPickerOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-3xl mx-auto bg-white rounded-t-3xl p-4 pb-6 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <p className="font-bold text-lg text-[#2D1B0E]">Choose category</p>
              <button onClick={() => setCatPickerOpen(false)} className="p-2.5 -m-1"><X className="w-5 h-5 text-[#8B7355]" /></button>
            </div>
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
              <input value={catSearch} onChange={(e) => setCatSearch(e.target.value)} placeholder="Filter categories…"
                className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-xl pl-9 pr-3 py-2.5 text-sm" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {cats.filter((c) => c === 'All' || c.toLowerCase().includes(catSearch.toLowerCase())).map((c) => (
                <button key={c} onClick={() => { setCat(c); setCatPickerOpen(false); }}
                  className={`flex items-center justify-between gap-2 px-3 py-3 rounded-xl border text-sm text-left active:scale-95 ${cat === c ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-[#FFF1E3] text-[#2D1B0E] border-[#E8D5C4]'}`}>
                  <span className="truncate">{c === 'All' ? 'All categories' : c}</span>
                  <span className={`text-[10px] shrink-0 ${cat === c ? 'text-white/80' : 'text-[#8B7355]'}`}>{c === 'All' ? menu.length : (catCounts[c] || 0)}</span>
                </button>
              ))}
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
              <button onClick={() => setTableAction(null)} className="p-2.5 -m-1"><X className="w-5 h-5 text-[#8B7355]" /></button>
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
            <p className="text-sm text-[#8B7355] mb-3">Total due <b className="text-[#2D1B0E]">₹{Math.round(order.total)}</b>{order.discount > 0 ? <span className="text-green-700"> · disc −₹{Math.round(order.discount)}</span> : null}</p>

            {/* Cashier-only bill adjustments. Captains lack can_request_discount and
                never see this block; discount is manager-approved server-side. */}
            {canDiscount && (
              <div className="mb-3 space-y-2">
                {discReq?.status === 'pending' ? (
                  <div className="w-full flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-800 py-2.5 px-3 rounded-xl text-sm font-semibold">
                    <Timer className="w-4 h-4 shrink-0" /> Discount {discReq.requested_pct}% — awaiting approval
                  </div>
                ) : !discOpen ? (
                  <button onClick={() => { setDiscOpen(true); setDiscErr(null); }}
                    className="w-full flex items-center justify-center gap-2 border border-[#D4B896] text-[#6B5744] py-2.5 rounded-xl text-sm font-semibold active:scale-95">
                    <BadgePercent className="w-4 h-4" /> Request discount{maxDiscountPct > 0 ? ` (up to ${maxDiscountPct}%)` : ''}
                  </button>
                ) : (
                  <div className="bg-[#FFF9F3] border border-[#E8D5C4] rounded-xl p-3 space-y-2">
                    <p className="text-xs font-semibold text-[#8B7355] flex items-center gap-1"><BadgePercent className="w-3.5 h-3.5" /> Discount (Manager approval)</p>
                    <div className="relative">
                      <input value={discPct} onChange={(e) => setDiscPct(e.target.value)} inputMode="decimal" placeholder={`Discount % ${maxDiscountPct > 0 ? `(max ${maxDiscountPct})` : ''}`}
                        className="w-full border border-[#D4B896] rounded-lg pl-3 pr-8 py-2 text-sm" />
                      <Percent className="w-4 h-4 text-[#8B7355] absolute right-2.5 top-1/2 -translate-y-1/2" />
                    </div>
                    <input value={discEmail} onChange={(e) => setDiscEmail(e.target.value)} placeholder="Approver email"
                      className="w-full border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
                    <input type="password" value={discPass} onChange={(e) => setDiscPass(e.target.value)} placeholder="Approver password"
                      className="w-full border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
                    {discErr && <p className="text-xs text-red-600">{discErr}</p>}
                    <div className="flex gap-2">
                      <button onClick={() => { setDiscOpen(false); setDiscErr(null); }} className="flex-1 border border-[#E8D5C4] text-[#6B5744] py-2 rounded-lg text-sm font-medium active:scale-95">Cancel</button>
                      <button onClick={requestDiscount} disabled={discBusy || discReqBusy}
                        className="flex-1 flex items-center justify-center gap-1.5 bg-[#af4408] text-white py-2 rounded-lg text-sm font-bold active:scale-95 disabled:opacity-50">
                        {discBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Apply
                      </button>
                    </div>
                    {/* No manager at the till? File a remote request instead — a
                        Manager/Admin approves it from Discount Approvals (bell). */}
                    <div className="pt-1 border-t border-[#E8D5C4] space-y-2">
                      <p className="text-[11px] text-[#8B7355]">No manager here? Send it for remote approval:</p>
                      <input value={discReason} onChange={(e) => setDiscReason(e.target.value)} placeholder="Reason (e.g. regular guest, complaint)"
                        className="w-full border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
                      <button onClick={requestRemoteApproval} disabled={discReqBusy || discBusy}
                        className="w-full flex items-center justify-center gap-1.5 border border-[#af4408] text-[#af4408] py-2 rounded-lg text-sm font-bold active:scale-95 disabled:opacity-50">
                        {discReqBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <BellRing className="w-4 h-4" />} Request remote approval
                      </button>
                    </div>
                  </div>
                )}

                {!scOpen ? (
                  order.service_charge_reason ? (
                    <p className="text-xs text-[#8B7355] flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5 text-green-600" /> Service charge removed</p>
                  ) : (
                    <button onClick={() => { setScOpen(true); setScErr(null); }}
                      className="w-full flex items-center justify-center gap-2 border border-[#D4B896] text-[#6B5744] py-2.5 rounded-xl text-sm font-semibold active:scale-95">
                      <X className="w-4 h-4" /> Remove service charge
                    </button>
                  )
                ) : (
                  <div className="bg-[#FFF9F3] border border-[#E8D5C4] rounded-xl p-3 space-y-2">
                    <p className="text-xs font-semibold text-[#8B7355]">Remove service charge — reason</p>
                    <input value={scReason} onChange={(e) => setScReason(e.target.value)} placeholder="e.g. guest complaint, comped"
                      className="w-full border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
                    {scErr && <p className="text-xs text-red-600">{scErr}</p>}
                    <div className="flex gap-2">
                      <button onClick={() => { setScOpen(false); setScErr(null); }} className="flex-1 border border-[#E8D5C4] text-[#6B5744] py-2 rounded-lg text-sm font-medium active:scale-95">Cancel</button>
                      <button onClick={removeServiceCharge} disabled={scBusy}
                        className="flex-1 flex items-center justify-center gap-1.5 bg-[#af4408] text-white py-2 rounded-lg text-sm font-bold active:scale-95 disabled:opacity-50">
                        {scBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Remove
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <button onClick={printBillNow} disabled={printingBill}
              className="w-full flex items-center justify-center gap-2 border border-[#af4408] text-[#af4408] py-3 rounded-xl text-sm font-semibold active:scale-95 disabled:opacity-50 mb-3">
              {printingBill ? <Loader2 className="w-4 h-4 animate-spin" /> : <Receipt className="w-4 h-4" />} Print bill at counter
            </button>
            {/* Optional guest capture — feeds CRM loyalty; settling works
                exactly as before when left blank. */}
            <p className="text-xs font-semibold text-[#8B7355] mb-1.5">Guest (optional — earns loyalty points)</p>
            <div className="flex gap-2 mb-3">
              <input value={gMobile} onChange={(e) => setGMobile(e.target.value)} type="tel" inputMode="tel" placeholder="Guest mobile"
                className="flex-1 min-w-0 border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
              <input value={gName} onChange={(e) => setGName(e.target.value)} placeholder="Name"
                className="w-28 border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
            </div>
            <p className="text-xs font-semibold text-[#8B7355] mb-1.5">Collect &amp; close</p>
            <div className="grid grid-cols-3 gap-2">
              {['cash', 'upi', 'card'].map((mthd) => (
                <button key={mthd} onClick={() => settle(mthd)} disabled={settling || !canBill}
                  className="flex flex-col items-center gap-1 bg-[#FFF1E3] border border-[#D4B896] rounded-xl py-4 active:scale-95 disabled:opacity-50">
                  <span className="text-sm font-semibold text-[#2D1B0E] uppercase">{mthd}</span>
                </button>
              ))}
            </div>
            {!canBill && <p className="text-center text-xs text-[#af4408] mt-2">Complete all items to bill ({firedIncomplete.length} left)</p>}
            {settling && <p className="text-center text-sm text-[#8B7355] mt-3"><Loader2 className="w-4 h-4 animate-spin inline" /> Settling…</p>}
          </div>
        </div>
      )}

      {/* Settle-success sheet — shown only when a guest mobile was captured,
          so the captain can send the WhatsApp review request before leaving. */}
      {settledInfo && (
        <div className="fixed inset-0 z-40 flex items-end">
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative w-full max-w-3xl mx-auto bg-white rounded-t-3xl p-4 pb-6 text-center">
            <CheckCircle2 className="w-10 h-10 text-green-600 mx-auto mb-2" />
            <p className="font-bold text-lg text-[#2D1B0E]">Payment collected</p>
            <p className="text-sm text-[#8B7355] mb-4">₹{Math.round(settledInfo.total)} settled · guest {settledInfo.mobile}</p>
            {reviewLink && waMobile(settledInfo.mobile) && (
              <a href={`https://wa.me/91${waMobile(settledInfo.mobile)}?text=${encodeURIComponent(`Thank you for dining at AKAN! We'd love your feedback: ${reviewLink}`)}`}
                target="_blank" rel="noopener noreferrer"
                className="w-full flex items-center justify-center gap-2 bg-green-600 text-white py-3 rounded-xl text-sm font-bold active:scale-95 mb-2">
                <MessageCircle className="w-4 h-4" /> Send review request on WhatsApp
              </a>
            )}
            <button onClick={() => router.push('/captain')}
              className="w-full border border-[#E8D5C4] text-[#6B5744] py-3 rounded-xl text-sm font-semibold active:scale-95">
              Done
            </button>
          </div>
        </div>
      )}

      {toast && <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-full shadow-lg">{toast}</div>}
    </div>
  );
}
