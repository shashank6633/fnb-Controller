'use client';

/**
 * Department Transfers — hand stock from one DEPARTMENT to another.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS PAGE EXISTS. Direct Issue rules (Meat / POULTRY / SEAFOOD → Kitchen)
 * land vendor deliveries on KITCHEN's department ledger and never in central.
 * Every routed-category requisition, though, comes from Kitchen's CHILDREN —
 * Akan Main Kitchen, Akan Tandoori, Akan Continental, Akan Indian, Akan Pan
 * Asian — and a child never sees its parent's stock (the department roll-up
 * runs downward only). This screen is the hand-over.
 *
 * TWO STEPS, same as the API (src/app/api/department-transfers):
 *   1. SEND    — a head of the sending department picks what to hand over.
 *                Creates a PENDING document. NO STOCK MOVES: the kilo stays on
 *                the sender's ledger, and is only promised (the holdings list
 *                subtracts it so it cannot be promised twice).
 *   2. CONFIRM — someone in the RECEIVING department confirms what arrived
 *                (in full, short, or not at all). That one call debits the
 *                sender and credits the receiver in a single transaction.
 *   The kilo is therefore in exactly one ledger at every instant; central stock
 *   is never touched. A pending transfer can be cancelled by either side.
 *
 * THIS PAGE DECIDES NOTHING. Who may send / confirm / cancel comes from the
 * server (`departments[].can_send` on the list, `permissions` on every
 * document); the quantity that may leave is the server's `transferable`; every
 * refusal is printed VERBATIM. The client-side over-quantity check only saves
 * a round trip — the server's refusal is the guard.
 *
 * UNITS (owner rule 2026-07-29). Every quantity READS and is ENTERED in the
 * PURCHASE unit (kg / L / BTL); the recipe figure appears only as the small
 * "= 4,000 g" hint. Typed quantities are POSTed as typed — `quantity_purchase`
 * on send, `quantity` + unit:'purchase' on a short receipt — and the SERVER
 * converts once with packFactor(); this page never posts a converted number. Display uses the server's *_purchase twins, falling back
 * to src/lib/pack-units (the one shared helper) — never a local conversion.
 *
 * NEVER COUNTED ≠ ZERO. A department with no closing count for an item has no
 * counted balance (NULL). The server then releases the item's ledger figure
 * (everything in minus everything out — basis 'uncounted_ledger_sum') rather
 * than refusing, because Kitchen is in practice never counted and a refusal
 * would block every hand-over. This page LABELS that basis on every such row
 * ("not counted · by ledger") instead of presenting it as a count.
 *
 * TABLET FIRST. A sub-kitchen does this daily, standing up: incoming hand-overs
 * sit at the top with one big Confirm button; the From → To route is
 * remembered on the device; item rows are full-width tap targets; inputs are
 * 16px+ (no iOS zoom); one Send posts the whole tray as one document. The
 * waiting list refreshes itself every minute while the page is in view.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SendHorizontal, ArrowRight, ArrowDownUp, Search, Loader2, AlertTriangle, CircleCheck,
  X, Plus, Boxes, History, Inbox, Info, Trash2, PackageCheck, Ban, Clock,
} from 'lucide-react';
import TabScroller from '@/components/TabScroller';
import { api } from '@/lib/api';
import { packFactor, toPurchaseQty, fmtQtyNum, type PackMeta } from '@/lib/pack-units';
import { fmtISTShort, fmtISTDate, todayIST } from '@/lib/format-date';

/* ── Types (the wire shapes of /api/department-transfers) ───────────────── */

interface Me {
  id: string; email: string; name: string; role: string;
  department_id: string | null;
  is_head_chef?: boolean; is_store_manager?: boolean;
}
/** `departments[]` on GET /api/department-transfers — with what I may do there. */
interface DeptOption {
  id: string; name: string;
  parent_id: string | null; parent_name: string;
  is_active: boolean;
  can_send: boolean; can_receive: boolean;
}
/** GET /api/department-transfers/holdings → rows[]. *_qty are RECIPE units. */
interface Holding {
  material_id: string; name: string; category: string;
  unit: string; purchase_unit: string; pack_size: number;
  basis: string;                 // 'counted' | 'uncounted_ledger_sum'
  on_hand: number | null;        // NULL = never counted (never 0)
  available: number;             // releasable; may be ≤ 0 (a ledger problem)
  pending_out: number;           // already promised on pending transfers
  transferable: number;          // max(0, available − pending_out)
  transferable_purchase: number; // the same, in the purchase unit (server-converted)
}
interface TransferLine {
  id: string; material_id: string; material_name: string;
  unit: string; purchase_unit: string; pack_factor: number;
  qty_sent: number; qty_received: number | null;                 // RECIPE units
  qty_sent_purchase: number | null; qty_received_purchase: number | null; // server twins
}
interface Transfer {
  id: string; transfer_no: string;
  from_department_id: string; from_department_name: string;
  to_department_id: string; to_department_name: string;
  status: 'pending' | 'received' | 'cancelled' | string;
  notes: string;
  created_by: string; created_at: string;
  received_by: string; received_at: string; receive_txn_date: string; receive_override_reason: string;
  cancelled_by: string; cancelled_at: string; cancel_reason: string;
  lines: TransferLine[];
  permissions: { is_sender: boolean; can_receive: boolean; needs_override_reason: boolean; can_cancel: boolean };
}
/** A line waiting in the tray. `qty` is the RAW typed PURCHASE-unit string. */
interface TrayLine { material_id: string; qty: string; }

/* ── Helpers ────────────────────────────────────────────────────────────── */

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (v == null ? '' : String(v));
const EPS = 1e-6;
/** Collapse the double spaces some department names carry ("Akan  Indian"). */
const clean = (s: string) => str(s).replace(/\s+/g, ' ').trim();

/** Pack meta of a holding / a line, for the shared pack-units helpers. A line
 *  carries its SNAPSHOTTED pack factor (packFactor() at send time). */
const metaOf = (x: { unit: string; purchase_unit: string; pack_size?: number; pack_factor?: number }): PackMeta =>
  ({ unit: x.unit, purchase_unit: x.purchase_unit, pack_size: x.pack_factor ?? x.pack_size ?? 1 });
/** The unit a quantity READS in — purchase unit, recipe unit only as fallback. */
const puOf = (m: PackMeta) => String(m?.purchase_unit || m?.unit || '').trim();
/** A purchase-unit figure, preferring the server's own twin. */
const showPU = (m: PackMeta, recipeQty: number, serverPU?: number | null) =>
  fmtQtyNum(serverPU != null && Number.isFinite(Number(serverPU)) ? Number(serverPU) : toPurchaseQty(recipeQty, m));
/** "= 4,000 g" — only when the material really converts (pack-units rule). */
const recipeHint = (m: PackMeta, recipeQty: number) =>
  packFactor(m) > 1 && Math.abs(num(recipeQty)) > EPS ? `= ${fmtQtyNum(recipeQty)} ${m.unit}` : null;
/** Largest 3-dp purchase figure that never exceeds `recipeQty` — what "All"
 *  fills in. Rounding UP would ask for a few grams more than is there and earn
 *  a refusal for pressing the button that means "everything". */
const floorPU = (m: PackMeta, recipeQty: number) =>
  Math.max(0, Math.floor((num(recipeQty) / packFactor(m)) * 1000 + 1e-6) / 1000);
/** A typed purchase quantity. Blank / junk / ≤ 0 → null. */
const parseQty = (raw: string): number | null => {
  const s = str(raw).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
};
/** Ledger timestamps are UTC with milliseconds and no zone ("2026-10-14
 *  07:00:00.123"). format-date's parser only recognises the no-millisecond
 *  shape and otherwise hands the string to Date(), which reads it as LOCAL time
 *  (5½ h early in IST, Invalid Date on Safari). Make it unambiguous first. */
const utc = (s: string) => {
  const v = str(s).trim();
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v) ? v.replace(' ', 'T') + 'Z' : v;
};
const when = (s: string) => fmtISTShort(utc(s));
/** Session emails are the stored actor; show the readable half. */
const who = (email: string) => str(email).split('@')[0] || '—';

/** The last From → To, per person on this device (a kitchen tablet is shared).
 *  A convenience only: it is re-validated against what the server says this
 *  person may send from, and storage failing (private mode) just means no
 *  default. */
const routeKey = (userId: string) => `fnb.dept-transfers.route.v1:${userId || 'anon'}`;
const readRoute = (userId: string): { from?: string; to?: string } => {
  try {
    const raw = window.localStorage.getItem(routeKey(userId));
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
};
const writeRoute = (userId: string, from: string, to: string) => {
  try { window.localStorage.setItem(routeKey(userId), JSON.stringify({ from, to })); } catch { /* private mode */ }
};

/** Read a JSON body without throwing on an empty / HTML error page. */
async function readJson(r: Response): Promise<any> {
  try { return await r.json(); } catch { return {}; }
}

/* ── Page ───────────────────────────────────────────────────────────────── */

export default function DepartmentTransfersPage() {
  /* who am I */
  const [me, setMe] = useState<Me | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json())
      .then(d => setMe(d?.user || null))
      .catch(() => setMe(null))
      .finally(() => setMeLoaded(true));
  }, []);
  const isMgmt = !!me && (me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef);
  /** "you" for my own actions — the stored actor is the session email. */
  const whoIs = (email: string) =>
    !!me?.email && str(email).trim().toLowerCase() === me.email.trim().toLowerCase() ? 'you' : who(email);

  /* departments + everything waiting (GET ?status=pending — server-scoped) */
  const [depts, setDepts] = useState<DeptOption[]>([]);
  const [pending, setPending] = useState<Transfer[]>([]);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const loadPending = useCallback(async () => {
    try {
      const r = await fetch('/api/department-transfers?status=pending&limit=500', { cache: 'no-store' });
      const j = await readJson(r);
      if (!r.ok) { setPendingError(j?.error || `HTTP ${r.status}`); return; }
      setPendingError(null);
      setPending(Array.isArray(j?.transfers) ? j.transfers : []);
      if (Array.isArray(j?.departments)) setDepts(j.departments);
    } catch (e: any) {
      setPendingError(e?.message || 'Could not load waiting transfers');
    }
  }, []);
  useEffect(() => { if (me) loadPending(); }, [me, loadPending]);

  const byId = useMemo(() => new Map(depts.map(d => [d.id, d])), [depts]);
  const active = useMemo(() => depts.filter(d => d.is_active), [depts]);
  const mainOf = useCallback((id: string): string => {
    let cur = byId.get(id);
    const seen = new Set<string>();
    while (cur?.parent_id && byId.has(cur.parent_id) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parent_id);
    }
    return cur?.id || id;
  }, [byId]);
  /** "Akan Tandoori · Kitchen" — the parent is what tells the look-alikes apart
   *  (top-level "Tandoor" vs "Akan Tandoori" under Kitchen are different ledgers). */
  const label = useCallback((d: DeptOption | undefined) =>
    !d ? '' : d.parent_id && d.parent_name ? `${clean(d.name)} · ${clean(d.parent_name)}` : clean(d.name), []);

  /* station mapping — management only, informational (the mapping is the owner's) */
  const [stations, setStations] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (!isMgmt) return;
    fetch('/api/departments').then(r => r.json()).then(d => {
      const m = new Map<string, number>();
      for (const x of d?.departments || []) {
        if (Array.isArray(x?.mapped_stations)) m.set(String(x.id), x.mapped_stations.length);
      }
      setStations(m);
    }).catch(() => {});
  }, [isMgmt]);

  /* route: From → To (remembered on this device) */
  const senders = useMemo(() => active.filter(d => d.can_send), [active]);
  const canSendAnywhere = senders.length > 0;
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const routeSeeded = useRef(false);
  useEffect(() => {
    if (routeSeeded.current || senders.length === 0) return;
    routeSeeded.current = true;
    const saved = readRoute(me?.id || '');
    const own = me?.department_id || '';
    const ok = (id?: string) => !!id && senders.some(d => d.id === id);
    const f = ok(saved.from) ? saved.from!
      : ok(own) ? own
      : ok(mainOf(own)) ? mainOf(own)
      : senders[0].id;
    setFromId(f);
    if (saved.to && saved.to !== f && active.some(d => d.id === saved.to)) setToId(saved.to);
  }, [senders, active, me, mainOf]);
  useEffect(() => { if (fromId && me?.id) writeRoute(me.id, fromId, toId); }, [fromId, toId, me?.id]);
  const fromDept = fromId ? byId.get(fromId) : undefined;
  const toDept = toId ? byId.get(toId) : undefined;
  const swap = () => {
    if (!toId || !senders.some(d => d.id === toId)) return;
    const f = fromId; setFromId(toId); setToId(f);
  };

  /* receivers: the sender's own family first (parent, siblings, children — the
   * same main department), everything else behind a toggle */
  const [showOthers, setShowOthers] = useState(false);
  const { family, others } = useMemo(() => {
    const fam: DeptOption[] = []; const rest: DeptOption[] = [];
    if (!fromId) return { family: fam, others: rest };
    const m = mainOf(fromId);
    for (const d of active) {
      if (d.id === fromId) continue;
      (mainOf(d.id) === m ? fam : rest).push(d);
    }
    const byName = (a: DeptOption, b: DeptOption) => label(a).localeCompare(label(b));
    return { family: fam.sort(byName), others: rest.sort(byName) };
  }, [active, fromId, mainOf, label]);

  /* holdings of the sender — exactly ONE department, no roll-up */
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [holdLoading, setHoldLoading] = useState(false);
  const [holdError, setHoldError] = useState<string | null>(null);
  const holdSeq = useRef(0);
  const loadHoldings = useCallback(async () => {
    if (!fromId) { setHoldings([]); return; }
    const seq = ++holdSeq.current;
    setHoldLoading(true); setHoldError(null);
    try {
      const r = await fetch(`/api/department-transfers/holdings?department_id=${encodeURIComponent(fromId)}`, { cache: 'no-store' });
      const j = await readJson(r);
      if (seq !== holdSeq.current) return;          // a newer department won
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setHoldings(Array.isArray(j?.rows) ? j.rows : []);
    } catch (e: any) {
      if (seq !== holdSeq.current) return;
      setHoldings([]); setHoldError(e?.message || 'Could not load what this department holds');
    } finally {
      if (seq === holdSeq.current) setHoldLoading(false);
    }
  }, [fromId]);
  useEffect(() => { loadHoldings(); }, [loadHoldings]);
  const holdingById = useMemo(() => new Map(holdings.map(h => [h.material_id, h])), [holdings]);

  /* history — for the department I send from, else my own */
  const viewId = fromId || me?.department_id || '';
  const viewDept = viewId ? byId.get(viewId) : undefined;
  const [history, setHistory] = useState<Transfer[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histError, setHistError] = useState<string | null>(null);
  const histSeq = useRef(0);
  const loadHistory = useCallback(async () => {
    if (!me) return;
    const seq = ++histSeq.current;
    setHistLoading(true); setHistError(null);
    try {
      const qs = new URLSearchParams({ limit: '60' });
      if (viewId) qs.set('department_id', viewId);
      const r = await fetch(`/api/department-transfers?${qs}`, { cache: 'no-store' });
      const j = await readJson(r);
      if (seq !== histSeq.current) return;
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setHistory(Array.isArray(j?.transfers) ? j.transfers : []);
    } catch (e: any) {
      if (seq !== histSeq.current) return;
      setHistory([]); setHistError(e?.message || 'Could not load recent transfers');
    } finally {
      if (seq === histSeq.current) setHistLoading(false);
    }
  }, [me, viewId]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadPending(), loadHoldings(), loadHistory()]);
  }, [loadPending, loadHoldings, loadHistory]);

  // A kitchen tablet sits open all service: pick up new hand-overs on its own,
  // once a minute, only while the page is actually on screen.
  useEffect(() => {
    if (!me) return;
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        // Holdings too: a confirm elsewhere changes what the sender can still
        // promise. A stale figure only costs a refusal (the server re-checks),
        // but it should not be the screen that is wrong for a whole service.
        loadPending(); loadHistory(); loadHoldings();
      }
    }, 60_000);
    return () => clearInterval(t);
  }, [me, loadPending, loadHistory, loadHoldings]);

  /* tray — what one Send posts. Cleared when the sender changes: a line belongs
   * to the stock of the department it was picked from. */
  const [tray, setTray] = useState<TrayLine[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => { setTray([]); setOpenId(null); setDraft(''); }, [fromId]);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const categories = useMemo(() => {
    const s = new Set<string>();
    for (const h of holdings) if (h.category) s.add(h.category);
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [holdings]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return holdings
      .filter(h => (!category || h.category === category) && (!q || str(h.name).toLowerCase().includes(q)))
      // Something to send first, then by name.
      .sort((a, b) => (Number(b.transferable > EPS) - Number(a.transferable > EPS)) || str(a.name).localeCompare(str(b.name)));
  }, [holdings, search, category]);

  const openRow = (h: Holding) => {
    if (openId === h.material_id) { setOpenId(null); return; }
    setOpenId(h.material_id);
    setDraft(tray.find(t => t.material_id === h.material_id)?.qty || '');
  };
  /** One typed quantity against what the sender can still promise. */
  const checkQty = (h: Holding, raw: string): string | null => {
    const q = parseQty(raw);
    if (q == null) return 'Enter a quantity above 0';
    const m = metaOf(h);
    if (q * packFactor(m) > num(h.transferable) + EPS) {
      return `Only ${showPU(m, h.transferable, h.transferable_purchase)} ${puOf(m)} can be sent from ${clean(fromDept?.name || 'this department')}`;
    }
    return null;
  };
  const addToTray = (h: Holding) => {
    if (checkQty(h, draft)) return;
    const qty = draft.trim();
    setTray(t => [...t.filter(x => x.material_id !== h.material_id), { material_id: h.material_id, qty }]);
    setOpenId(null); setDraft(''); setSendError(null);
  };

  /* send */
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<{ msg: string; materialId: string | null } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 10_000);
    return () => clearTimeout(t);
  }, [flash]);
  const trayProblems = tray.map(t => {
    const h = holdingById.get(t.material_id);
    return h ? checkQty(h, t.qty) : 'No longer held by this department';
  });
  const canSend = !!fromId && !!toId && toId !== fromId && tray.length > 0
    && trayProblems.every(p => !p) && !sending;
  const send = async () => {
    if (!canSend) return;
    setSending(true); setSendError(null);
    try {
      const r = await api('/api/department-transfers', {
        method: 'POST',
        body: {
          from_department_id: fromId,
          to_department_id: toId,
          notes: note.trim(),
          // PURCHASE units, exactly as typed, under the route's explicitly
          // purchase-named field (it refuses a contradicting `unit`, so the
          // basis cannot be misread). The server converts ONCE with
          // packFactor() (dept-ledger transferQtyToRecipe) — never here.
          lines: tray.map(t => ({ material_id: t.material_id, quantity_purchase: Number(t.qty), unit: 'purchase' })),
        },
      });
      const j = await readJson(r);
      if (!r.ok) {
        setSendError({ msg: j?.error || `HTTP ${r.status}`, materialId: j?.material_id || null });
        // A refusal about quantity means the holdings moved under us — refresh them.
        if (r.status === 409) loadHoldings();
        return;
      }
      const t: Transfer | undefined = j?.transfer;
      const receiver = clean(t?.to_department_name || toDept?.name || 'the receiver');
      setFlash(`${t?.transfer_no || 'Transfer'} sent to ${receiver} — ${tray.length} item${tray.length === 1 ? '' : 's'}. ` +
        `The stock moves when ${receiver} confirms it arrived; until then it stays with ${clean(t?.from_department_name || fromDept?.name || 'the sender')}.`);
      setTray([]); setNote('');
      await refreshAll();
    } catch (e: any) {
      setSendError({ msg: e?.message || 'Network error — nothing was sent. Try again.', materialId: null });
    } finally {
      setSending(false);
    }
  };

  /* confirm / cancel a pending document */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actError, setActError] = useState<Record<string, string>>({});
  const [detailOpen, setDetailOpen] = useState<Record<string, 'receive' | 'cancel' | undefined>>({});
  const [recvQty, setRecvQty] = useState<Record<string, string>>({});     // lineId → typed PU
  const [recvDate, setRecvDate] = useState<Record<string, string>>({});   // transferId → YYYY-MM-DD
  const [reason, setReason] = useState<Record<string, string>>({});       // transferId → override / cancel reason
  const prefill = (l: TransferLine) =>
    String(l.qty_sent_purchase != null ? l.qty_sent_purchase : toPurchaseQty(l.qty_sent, metaOf(l)));
  const openDetail = (t: Transfer, mode: 'receive' | 'cancel') => {
    setDetailOpen(s => ({ ...s, [t.id]: s[t.id] === mode ? undefined : mode }));
    if (mode === 'receive') {
      setRecvQty(s => {
        const next = { ...s };
        for (const l of t.lines) if (next[l.id] == null) next[l.id] = prefill(l);
        return next;
      });
    }
  };
  const confirmReceive = async (t: Transfer, adjusted: boolean) => {
    const body: Record<string, unknown> = {};
    if (adjusted) {
      // Only lines the receiver CHANGED are sent; an untouched line is accepted
      // in full by the server at its exact stored quantity. Re-sending the
      // rounded purchase figure could exceed a 4-dp sent quantity by a hair
      // and be refused as "more than was sent".
      const lines = t.lines
        .filter(l => str(recvQty[l.id]).trim() !== prefill(l))
        .map(l => ({ line_id: l.id, quantity: Number(str(recvQty[l.id]).trim() || 'NaN'), unit: 'purchase' }));
      if (lines.some(x => !Number.isFinite(x.quantity) || x.quantity < 0)) {
        setActError(s => ({ ...s, [t.id]: 'Each received quantity must be 0 or more' }));
        return;
      }
      if (lines.length) body.lines = lines;
      const d = str(recvDate[t.id]).trim();
      if (d) body.txn_date = d;
    }
    if (t.permissions?.needs_override_reason) {
      const why = str(reason[t.id]).trim();
      if (!why) {
        setDetailOpen(s => ({ ...s, [t.id]: 'receive' }));
        setActError(s => ({ ...s, [t.id]: 'You sent this one. Write why you are confirming it yourself — it is kept on the transfer.' }));
        return;
      }
      body.override_reason = why;
    }
    setBusyId(t.id); setActError(s => ({ ...s, [t.id]: '' }));
    try {
      const r = await api(`/api/department-transfers/${encodeURIComponent(t.id)}/receive`, { method: 'POST', body });
      const j = await readJson(r);
      if (!r.ok) { setActError(s => ({ ...s, [t.id]: j?.error || `HTTP ${r.status}` })); return; }
      setDetailOpen(s => ({ ...s, [t.id]: undefined }));
      setFlash(`${t.transfer_no} received into ${clean(t.to_department_name)}. The stock has moved from ${clean(t.from_department_name)}.`);
      await refreshAll();
    } catch (e: any) {
      setActError(s => ({ ...s, [t.id]: e?.message || 'Network error — nothing was posted. Try again.' }));
    } finally {
      setBusyId(null);
    }
  };
  const cancelTransfer = async (t: Transfer) => {
    const why = str(reason[t.id]).trim();
    if (!why) { setActError(s => ({ ...s, [t.id]: 'Say why it is being cancelled' })); return; }
    setBusyId(t.id); setActError(s => ({ ...s, [t.id]: '' }));
    try {
      const r = await api(`/api/department-transfers/${encodeURIComponent(t.id)}/cancel`, { method: 'POST', body: { reason: why } });
      const j = await readJson(r);
      if (!r.ok) { setActError(s => ({ ...s, [t.id]: j?.error || `HTTP ${r.status}` })); return; }
      setDetailOpen(s => ({ ...s, [t.id]: undefined }));
      setFlash(`${t.transfer_no} cancelled. Nothing moved — the stock is still with ${clean(t.from_department_name)}.`);
      await refreshAll();
    } catch (e: any) {
      setActError(s => ({ ...s, [t.id]: e?.message || 'Network error — try again.' }));
    } finally {
      setBusyId(null);
    }
  };

  // What lands in the green panel: documents this person may confirm and did
  // NOT send. A sender who is admin/HOD may also confirm their own (with a
  // written reason), but that is the exception — their own sends wait for the
  // receiver, and the override lives on the row in the Recent list instead.
  const isMine = (t: Transfer) => !!t.permissions?.can_receive && !t.permissions?.is_sender;
  const toConfirm = useMemo(() => pending.filter(isMine), [pending]);

  /* history tabs, relative to the department being viewed */
  const [dir, setDir] = useState<'all' | 'out' | 'in' | 'waiting'>('all');
  const shown = useMemo(() => history.filter(t =>
    dir === 'all' ? true
      : dir === 'waiting' ? t.status === 'pending'
      : dir === 'out' ? t.from_department_id === viewId
      : t.to_department_id === viewId),
  [history, dir, viewId]);

  /* ── render pieces ── */

  const basisChip = (h: Holding) => h.basis === 'counted'
    ? <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[9px] font-semibold uppercase">counted</span>
    : <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[9px] font-semibold uppercase" title="Never counted: the figure is the department's ledger — everything received minus everything used or sent">not counted · by ledger</span>;

  const statusChip = (t: Transfer) =>
    t.status === 'pending'
      ? <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[9px] font-semibold uppercase whitespace-nowrap">waiting for {clean(t.to_department_name)}</span>
      : t.status === 'received'
        ? <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[9px] font-semibold uppercase">received</span>
        : <span className="px-1.5 py-0.5 rounded bg-[#E8D5C4] text-[#6B5744] text-[9px] font-semibold uppercase">{t.status}</span>;

  /** One document's lines: sent (and, once received, what was accepted). */
  const lineList = (t: Transfer) => (
    <div className="mt-1.5 space-y-1">
      {t.lines.map(l => {
        const m = metaOf(l);
        const short = t.status === 'received' && l.qty_received != null && l.qty_received < l.qty_sent - EPS;
        return (
          <div key={l.id || l.material_id} className="flex flex-nowrap items-start justify-between gap-2 text-xs">
            <span className={`min-w-0 break-words ${t.status === 'cancelled' ? 'line-through text-[#B8A590]' : 'text-[#2D1B0E]'}`}>
              {l.material_name}
            </span>
            <span className="shrink-0 text-right font-mono">
              {short ? (
                <>
                  {showPU(m, l.qty_received || 0, l.qty_received_purchase)} <span className="text-[#8B7355]">{puOf(m)}</span>
                  <span className="block text-[9px] text-amber-700">of {showPU(m, l.qty_sent, l.qty_sent_purchase)} {puOf(m)} sent</span>
                  {recipeHint(m, l.qty_received || 0) && <span className="block text-[9px] text-[#B8A590]">{recipeHint(m, l.qty_received || 0)}</span>}
                </>
              ) : (
                <>
                  {showPU(m, l.qty_sent, l.qty_sent_purchase)} <span className="text-[#8B7355]">{puOf(m)}</span>
                  {recipeHint(m, l.qty_sent) && <span className="block text-[9px] text-[#B8A590]">{recipeHint(m, l.qty_sent)}</span>}
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );

  /** Confirm / short-receive / cancel controls for a pending document. */
  const actions = (t: Transfer, big: boolean) => {
    const p = t.permissions || ({} as Transfer['permissions']);
    if (t.status !== 'pending' || (!p.can_receive && !p.can_cancel)) {
      if (t.status === 'pending' && p.is_sender) {
        return <div className="mt-2 text-[11px] text-[#8B7355]">Waiting for someone in {clean(t.to_department_name)} to confirm.</div>;
      }
      return null;
    }
    const mode = detailOpen[t.id];
    const busy = busyId === t.id;
    const override = !!p.needs_override_reason;
    return (
      <div className="mt-2 space-y-2">
        {p.is_sender && mode !== 'receive' && (
          <div className="text-[11px] text-[#8B7355]">Waiting for someone in {clean(t.to_department_name)} to confirm.</div>
        )}
        {mode === 'receive' && (
          <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-2 space-y-2">
            <div className="text-[11px] text-[#6B5744]">What actually arrived? Change a line only if it is short (0 = none of it).</div>
            {t.lines.map(l => {
              const m = metaOf(l);
              const typed = str(recvQty[l.id]);
              const q = Number(typed);
              return (
                <label key={l.id} className="flex flex-nowrap items-center justify-between gap-2">
                  <span className="text-xs text-[#2D1B0E] min-w-0 break-words">{l.material_name}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    <input type="number" inputMode="decimal" step="any" min="0"
                           value={typed}
                           onChange={e => setRecvQty(s => ({ ...s, [l.id]: e.target.value.replace(/^-+/, '') }))}
                           className="w-24 px-2 py-2 border border-[#D4B896] rounded-lg bg-white text-base font-mono text-right" />
                    <span className="w-10 text-xs text-[#8B7355]">{puOf(m)}</span>
                    {packFactor(m) > 1 && typed.trim() !== '' && Number.isFinite(q) && (
                      <span className="hidden sm:inline text-[9px] text-[#B8A590] w-20">= {fmtQtyNum(q * packFactor(m))} {m.unit}</span>
                    )}
                  </span>
                </label>
              );
            })}
            <label className="flex flex-nowrap items-center justify-between gap-2 text-xs text-[#6B5744]">
              <span>Received on</span>
              <input type="date" value={recvDate[t.id] || todayIST()} max={todayIST()}
                     onChange={e => setRecvDate(s => ({ ...s, [t.id]: e.target.value }))}
                     className="px-2 py-1.5 border border-[#D4B896] rounded-lg bg-white text-base sm:text-sm" />
            </label>
          </div>
        )}
        {(mode === 'cancel' || (p.needs_override_reason && mode === 'receive')) && (
          <input value={reason[t.id] || ''} onChange={e => setReason(s => ({ ...s, [t.id]: e.target.value }))} maxLength={200}
                 placeholder={mode === 'cancel'
                   ? (p.can_receive && !p.is_sender ? 'Why are you refusing it? (e.g. never arrived)' : 'Why cancel? (required)')
                   : 'You sent this — why are you confirming it yourself? (kept on record)'}
                 className="w-full px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-base sm:text-sm" />
        )}
        {actError[t.id] && (
          <div className="flex flex-nowrap items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{actError[t.id]}</span>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {/* The ordinary path: the receiver confirms everything that was sent. */}
          {p.can_receive && !override && !mode && (
            <button type="button" disabled={busy} onClick={() => confirmReceive(t, false)}
                    className={`${big ? 'w-full sm:w-auto sm:flex-1 min-h-[52px] text-base' : 'min-h-[44px] text-sm'} px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold flex flex-nowrap items-center justify-center gap-2 disabled:opacity-40`}>
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <PackageCheck className="w-5 h-5" />}
              Confirm received
            </button>
          )}
          {p.can_receive && mode === 'receive' && (
            <button type="button" disabled={busy} onClick={() => confirmReceive(t, true)}
                    className={`${big ? 'w-full sm:w-auto sm:flex-1 min-h-[52px] text-base' : 'min-h-[44px] text-sm'} px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold flex flex-nowrap items-center justify-center gap-2 disabled:opacity-40`}>
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <PackageCheck className="w-5 h-5" />}
              Confirm these quantities
            </button>
          )}
          {/* Short receipt — or, for an admin/HOD who SENT it, the override
              door (the QC "receiver may not be the checker" escape hatch). */}
          {p.can_receive && mode !== 'cancel' && (
            <button type="button" onClick={() => openDetail(t, 'receive')}
                    className="min-h-[44px] px-3 rounded-lg border border-[#D4B896] bg-white text-sm text-[#6B5744] hover:border-[#af4408]">
              {mode === 'receive' ? 'Back' : override ? 'Confirm it myself…' : 'Received less?'}
            </button>
          )}
          {p.can_cancel && mode !== 'receive' && (
            mode === 'cancel' ? (
              <>
                <button type="button" disabled={busy} onClick={() => cancelTransfer(t)}
                        className="min-h-[44px] px-4 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-40">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />}
                  {p.can_receive && !p.is_sender ? 'Refuse transfer' : 'Cancel transfer'}
                </button>
                <button type="button" onClick={() => openDetail(t, 'cancel')}
                        className="min-h-[44px] px-3 rounded-lg border border-[#D4B896] bg-white text-sm text-[#6B5744]">
                  Back
                </button>
              </>
            ) : (
              <button type="button" onClick={() => openDetail(t, 'cancel')}
                      className="min-h-[44px] px-3 rounded-lg border border-[#E8D5C4] bg-white text-sm text-red-700 hover:border-red-400">
                {p.can_receive && !p.is_sender ? 'Not received' : 'Cancel'}
              </button>
            )
          )}
        </div>
      </div>
    );
  };

  /* ── render ── */

  if (meLoaded && !me) {
    return <div className="p-6 text-sm text-[#6B5744]">Sign in to use department transfers.</div>;
  }

  return (
    <div className={`p-4 sm:p-6 max-w-6xl mx-auto space-y-4 ${tray.length > 0 ? 'pb-72' : ''}`}>
      {/* Header */}
      <div className="flex flex-nowrap items-center gap-3">
        <SendHorizontal className="w-7 h-7 shrink-0 text-[#af4408]" />
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Department Transfers</h1>
          <p className="text-xs text-[#6B5744]">
            Hand stock from one department to another — e.g. Kitchen → Akan Tandoori. The receiving department
            confirms what arrived, and only then does the stock move. The central store is never touched.
          </p>
        </div>
      </div>

      {/* Banners */}
      {flash && (
        <div className="flex flex-nowrap items-start gap-2 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl px-4 py-3 text-sm">
          <CircleCheck className="w-5 h-5 shrink-0 mt-0.5" />
          <span className="flex-1">{flash}</span>
          <button type="button" onClick={() => setFlash(null)} className="p-1" aria-label="Dismiss"><X className="w-4 h-4" /></button>
        </div>
      )}
      {pendingError && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{pendingError}</div>
      )}

      {/* ── Waiting for you: incoming hand-overs this person may confirm ── */}
      {toConfirm.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">
            <Inbox className="w-4 h-4 text-emerald-600" />
            Waiting for you to confirm
            <span className="px-1.5 py-0.5 rounded-full bg-emerald-600 text-white text-[10px]">{toConfirm.length}</span>
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {toConfirm.map(t => (
              <div key={t.id} className="bg-white border-2 border-emerald-300 rounded-xl p-3">
                <div className="flex flex-nowrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1 flex-wrap">
                      <span className="break-words">{clean(t.from_department_name)}</span>
                      <ArrowRight className="w-4 h-4 text-[#af4408] shrink-0" />
                      <span className="break-words">{clean(t.to_department_name)}</span>
                    </div>
                    <div className="text-[10px] text-[#8B7355]">
                      {t.transfer_no} · sent {when(t.created_at)} by <span title={t.created_by}>{whoIs(t.created_by)}</span>
                    </div>
                  </div>
                  <Clock className="w-4 h-4 text-amber-600 shrink-0" />
                </div>
                {lineList(t)}
                {t.notes && <div className="mt-1 text-[11px] text-[#6B5744] italic break-words">“{t.notes}”</div>}
                {actions(t, true)}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Send ── */}
      {meLoaded && depts.length > 0 && !canSendAnywhere && (
        <div className="flex flex-nowrap items-start gap-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl px-4 py-3 text-xs text-[#6B5744]">
          <Info className="w-4 h-4 shrink-0 mt-0.5 text-[#8B7355]" />
          <span>
            Sending stock is for a head of department or a manager of the sending department. Hand-overs sent to
            your department appear above for you to confirm{toConfirm.length === 0 ? ' — there are none waiting right now' : ''}.
          </span>
        </div>
      )}

      {canSendAnywhere && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-end gap-2 sm:gap-3">
            <label className="flex-1 min-w-0 flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-[#8B7355]">Send from</span>
              {senders.length > 1 ? (
                <select value={fromId} onChange={e => { const v = e.target.value; setFromId(v); if (v === toId) setToId(''); }}
                        className="w-full px-3 py-2.5 border border-[#D4B896] rounded-lg text-base bg-white">
                  {senders.map(d => <option key={d.id} value={d.id}>{label(d)}</option>)}
                </select>
              ) : (
                <div className="px-3 py-2.5 border border-[#E8D5C4] rounded-lg text-base bg-[#FFF8F0] text-[#2D1B0E] font-semibold">
                  {label(fromDept)}
                </div>
              )}
            </label>
            <button type="button" onClick={swap}
                    disabled={!toId || !senders.some(d => d.id === toId)}
                    title="Swap sender and receiver" aria-label="Swap sender and receiver"
                    className="self-center sm:self-auto h-11 w-11 shrink-0 rounded-full border border-[#D4B896] bg-white text-[#af4408] flex items-center justify-center disabled:opacity-30">
              <ArrowDownUp className="w-5 h-5 sm:rotate-90" />
            </button>
            <div className="flex-1 min-w-0 flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-[#8B7355]">To</span>
              <div className={`px-3 py-2.5 border rounded-lg text-base font-semibold ${toDept
                ? 'border-[#af4408] bg-[#FFF1E3] text-[#2D1B0E]'
                : 'border-dashed border-[#D4B896] bg-white text-[#B8A590]'}`}>
                {toDept ? label(toDept) : 'Pick a receiving department below'}
              </div>
            </div>
          </div>

          {/* Receiver chips — big tap targets; family first, the rest behind a toggle */}
          {fromId && (
            <div className="space-y-2">
              {family.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {family.map(d => (
                    <button key={d.id} type="button" onClick={() => setToId(d.id === toId ? '' : d.id)}
                            className={`min-h-[44px] px-3 py-2 rounded-lg border text-sm text-left ${d.id === toId
                              ? 'bg-[#af4408] border-[#af4408] text-white font-semibold'
                              : 'bg-white border-[#E8D5C4] text-[#2D1B0E] hover:border-[#af4408]'}`}>
                      {clean(d.name)}
                      {d.parent_id && d.parent_name && (
                        <span className={`block text-[10px] ${d.id === toId ? 'text-white/80' : 'text-[#8B7355]'}`}>under {clean(d.parent_name)}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {others.length > 0 && (
                <div>
                  <button type="button" onClick={() => setShowOthers(v => !v)}
                          className="text-xs text-[#af4408] underline decoration-dotted py-1">
                    {showOthers ? 'Hide other departments' : `Other departments (${others.length})`}
                  </button>
                  {(showOthers || (!!toDept && !family.some(d => d.id === toId))) && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {others.map(d => (
                        <button key={d.id} type="button" onClick={() => setToId(d.id === toId ? '' : d.id)}
                                className={`min-h-[44px] px-3 py-2 rounded-lg border text-sm text-left ${d.id === toId
                                  ? 'bg-[#af4408] border-[#af4408] text-white font-semibold'
                                  : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'}`}>
                          {clean(d.name)}
                          {d.parent_id && d.parent_name && (
                            <span className={`block text-[10px] ${d.id === toId ? 'text-white/80' : 'text-[#8B7355]'}`}>under {clean(d.parent_name)}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {/* The station-mapping gap, for the people who can act on it: a
                  receiver no till station maps to is never debited by sales, so
                  what it receives leaves only by a count, wastage or a further
                  transfer. Informational only — the mapping is the owner's. */}
              {isMgmt && toDept && stations.has(toDept.id) && stations.get(toDept.id) === 0 && (
                <div className="flex flex-nowrap items-start gap-2 text-[11px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2">
                  <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#8B7355]" />
                  <span>
                    No till station maps to <strong>{clean(toDept.name)}</strong>, so sales never deduct from it — stock sent
                    here leaves it only by a closing count, wastage or another transfer. Station mapping is in Settings → Departments.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className={`grid grid-cols-1 ${canSendAnywhere ? 'lg:grid-cols-5' : ''} gap-4 items-start`}>
        {/* ── LEFT: what the sender holds ── */}
        {canSendAnywhere && (
          <section className="lg:col-span-3 space-y-2">
            <div className="flex flex-nowrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                <Boxes className="w-4 h-4 text-[#af4408]" />
                {fromDept ? `${clean(fromDept.name)} can send` : 'Stock to send'}
              </h2>
              {holdings.length > 0 && (
                <span className="text-[10px] text-[#8B7355]">{holdings.filter(h => h.transferable > EPS).length} of {holdings.length} items</span>
              )}
            </div>

            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                     placeholder="Search items…" inputMode="search"
                     className="w-full pl-9 pr-3 py-2.5 border border-[#E8D5C4] rounded-lg bg-white text-base" />
            </div>
            {categories.length > 1 && (
              <TabScroller className="gap-1.5 text-xs">
                {['', ...categories].map(c => (
                  <button key={c || '__all__'} type="button" onClick={() => setCategory(c)}
                          className={`px-3 py-1.5 rounded-lg ${category === c
                            ? 'bg-[#af4408] text-white'
                            : 'bg-white border border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'}`}>
                    {c || 'All'}
                  </button>
                ))}
              </TabScroller>
            )}

            {holdError && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{holdError}</div>
            )}

            {holdLoading && holdings.length === 0 ? (
              <div className="p-8 text-center text-[#8B7355] text-sm">
                <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
              </div>
            ) : !holdError && holdings.length === 0 ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
                <Boxes className="w-8 h-8 mx-auto mb-2 opacity-50" />
                {fromDept ? `${clean(fromDept.name)} holds nothing on its own ledger.` : 'Pick a department to send from.'}
                <span className="block text-[11px] mt-1">
                  Stock reaches a department through store issues, Direct Issue deliveries and transfers from other departments.
                </span>
              </div>
            ) : holdings.length > 0 && (
              <div className="bg-white border border-[#E8D5C4] rounded-xl divide-y divide-[#E8D5C4]/60 overflow-hidden">
                {visible.map(h => {
                  const m = metaOf(h);
                  const inTray = tray.find(t => t.material_id === h.material_id);
                  const open = openId === h.material_id;
                  const nothing = h.transferable <= EPS;
                  const negative = h.available < -EPS;
                  const draftQ = parseQty(draft);
                  const draftErr = open && draft.trim() ? checkQty(h, draft) : null;
                  return (
                    <div key={h.material_id} className={open ? 'bg-[#FFF8F0]' : ''}>
                      <button type="button" onClick={() => !nothing && openRow(h)} disabled={nothing}
                              aria-expanded={open}
                              className="w-full min-h-[56px] px-3 py-2.5 flex flex-nowrap items-center justify-between gap-3 text-left disabled:cursor-default">
                        <div className="min-w-0">
                          <div className={`text-sm font-semibold break-words ${nothing ? 'text-[#B8A590]' : 'text-[#2D1B0E]'}`}>{h.name}</div>
                          <div className="text-[10px] text-[#8B7355] flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                            <span>{h.category || '—'}</span>
                            {basisChip(h)}
                            {inTray && (
                              <span className="px-1.5 py-0.5 rounded bg-[#af4408] text-white text-[9px] font-semibold">
                                in tray: {fmtQtyNum(Number(inTray.qty))} {puOf(m)}
                              </span>
                            )}
                          </div>
                          {h.pending_out > EPS && (
                            <div className="text-[10px] text-amber-700 mt-0.5">
                              {showPU(m, h.pending_out)} {puOf(m)} already promised on waiting transfers
                            </div>
                          )}
                          {negative && (
                            <div className="text-[10px] text-red-700 mt-0.5">
                              Ledger shows {showPU(m, h.available)} {puOf(m)} — more has left than arrived. Count it on the Dept Closing Sheet.
                            </div>
                          )}
                        </div>
                        <div className="shrink-0 text-right">
                          <div className={`text-base font-bold tabular-nums ${nothing ? 'text-[#B8A590]' : h.basis === 'counted' ? 'text-[#2D1B0E]' : 'text-amber-800'}`}>
                            {showPU(m, h.transferable, h.transferable_purchase)} <span className="text-xs font-medium text-[#8B7355]">{puOf(m)}</span>
                          </div>
                          {recipeHint(m, h.transferable) && (
                            <div className="text-[9px] text-[#B8A590]">{recipeHint(m, h.transferable)}</div>
                          )}
                          <div className="text-[9px] text-[#8B7355]">{nothing ? 'nothing to send' : 'can send'}</div>
                        </div>
                      </button>

                      {open && (
                        <div className="px-3 pb-3 space-y-2">
                          {h.basis !== 'counted' && (
                            <div className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                              {clean(fromDept?.name || 'This department')} has never counted this item, so the figure is its ledger —
                              everything received minus everything used or sent — not a count.
                            </div>
                          )}
                          <div className="flex flex-nowrap items-stretch gap-2">
                            <div className="relative flex-1 min-w-0">
                              {/* autoFocus, not a setTimeout focus(): React commits a tap's state
                                  change inside the same user gesture, which is what lets iOS / Android
                                  raise the number pad. A deferred focus() is outside the gesture and
                                  leaves the cook tapping the box a second time. */}
                              <input autoFocus
                                     type="number" inputMode="decimal" step="any" min="0"
                                     value={draft}
                                     onChange={e => setDraft(e.target.value.replace(/^-+/, ''))}
                                     onKeyDown={e => { if (e.key === 'Enter') addToTray(h); }}
                                     placeholder={`Qty in ${puOf(m)}`}
                                     aria-label={`Quantity of ${h.name} in ${puOf(m)}`}
                                     className={`w-full pl-3 pr-14 py-3 border rounded-lg bg-white text-lg font-mono ${draftErr ? 'border-red-400' : 'border-[#D4B896]'}`} />
                              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[#8B7355] pointer-events-none">{puOf(m)}</span>
                            </div>
                            <button type="button" onClick={() => setDraft(String(floorPU(m, h.transferable)))}
                                    className="px-3 rounded-lg border border-[#D4B896] bg-white text-sm text-[#6B5744] hover:border-[#af4408]">
                              All
                            </button>
                            <button type="button" onClick={() => addToTray(h)} disabled={draftQ == null || !!draftErr}
                                    className="px-4 rounded-lg bg-[#af4408] text-white text-sm font-semibold flex items-center gap-1 disabled:opacity-40">
                              <Plus className="w-4 h-4" /> {inTray ? 'Update' : 'Add'}
                            </button>
                          </div>
                          {draftErr ? (
                            <div className="text-[11px] text-red-700">{draftErr}</div>
                          ) : draftQ != null && (
                            <div className="text-[11px] text-[#6B5744]">
                              {packFactor(m) > 1 && (
                                <span className="text-[9px] text-[#B8A590] mr-2">= {fmtQtyNum(draftQ * packFactor(m))} {m.unit}</span>
                              )}
                              leaves {showPU(m, Math.max(0, h.transferable - draftQ * packFactor(m)))} {puOf(m)} free in {clean(fromDept?.name || 'this department')}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {visible.length === 0 && (
                  <div className="text-center text-xs text-[#8B7355] py-6">
                    No items match{search ? ` “${search}”` : ''}{category ? ` in ${category}` : ''}.
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* ── RIGHT: recent transfers for the department in view ── */}
        <section className={`${canSendAnywhere ? 'lg:col-span-2' : ''} space-y-2`}>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">
              <History className="w-4 h-4 text-[#af4408]" />
              Recent{viewDept ? ` — ${clean(viewDept.name)}` : ''}
            </h2>
            <TabScroller className="gap-1 text-xs">
              {([['all', 'All'], ['waiting', 'Waiting'], ['out', 'Sent'], ['in', 'Received']] as const).map(([k, l]) => (
                <button key={k} type="button" onClick={() => setDir(k)}
                        className={`px-2.5 py-1.5 rounded-lg ${dir === k
                          ? 'bg-[#af4408] text-white'
                          : 'bg-white border border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'}`}>
                  {l}
                </button>
              ))}
            </TabScroller>
          </div>
          {histError && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{histError}</div>
          )}
          {shown.length === 0 ? (
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center text-xs text-[#8B7355]">
              <Inbox className="w-6 h-6 mx-auto mb-1.5 opacity-50" />
              {histLoading ? 'Loading…' : 'No transfers here yet.'}
            </div>
          ) : (
            <div className="space-y-2">
              {shown.map(t => {
                const out = !!viewId && t.from_department_id === viewId;
                const inn = !!viewId && t.to_department_id === viewId;
                return (
                  <div key={t.id} className={`bg-white border rounded-lg p-3 ${t.status === 'pending' ? 'border-amber-200' : 'border-[#E8D5C4]'}`}>
                    <div className="flex flex-nowrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-[#2D1B0E] flex items-center gap-1 flex-wrap">
                          <span className="break-words">{clean(t.from_department_name)}</span>
                          <ArrowRight className="w-3.5 h-3.5 text-[#af4408] shrink-0" />
                          <span className="break-words">{clean(t.to_department_name)}</span>
                        </div>
                        <div className="text-[10px] text-[#8B7355]">
                          {t.transfer_no} · {when(t.created_at)} · <span title={t.created_by}>{whoIs(t.created_by)}</span>
                          {(out || inn) && <span className={out ? 'text-[#af4408]' : 'text-emerald-700'}> · {out ? 'out' : 'in'}</span>}
                        </div>
                      </div>
                      <div className="shrink-0">{statusChip(t)}</div>
                    </div>
                    {lineList(t)}
                    {t.notes && <div className="mt-1 text-[10px] text-[#6B5744] italic break-words">“{t.notes}”</div>}
                    {t.status === 'received' && (
                      <div className="mt-1 text-[10px] text-[#8B7355]">
                        Confirmed by <span title={t.received_by}>{whoIs(t.received_by)}</span> · {when(t.received_at)}
                        {t.receive_txn_date && ` · business date ${fmtISTDate(t.receive_txn_date)}`}
                        {t.receive_override_reason && (
                          <span className="block text-amber-800">Confirmed by the sender — reason: “{t.receive_override_reason}”</span>
                        )}
                      </div>
                    )}
                    {t.status === 'cancelled' && (
                      <div className="mt-1 text-[10px] text-[#8B7355]">
                        Cancelled by <span title={t.cancelled_by}>{whoIs(t.cancelled_by)}</span> · {when(t.cancelled_at)}
                        {t.cancel_reason && <> — “{t.cancel_reason}”</>}. Nothing moved.
                      </div>
                    )}
                    {/* A pending document this person may confirm is already in
                        the green panel above; every other pending row carries its
                        own controls here (the sender's cancel / override). */}
                    {t.status === 'pending' && !isMine(t) && actions(t, false)}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <p className="text-[10px] text-[#8B7355] leading-relaxed">
        Quantities are in <strong>purchase units</strong> (kg / L / BTL); the small grey line is the same figure in
        recipe units. Sending only promises the stock — it stays with the sender until the receiving department
        confirms, and that confirmation takes it off the sender and puts it on the receiver in one step. Nothing passes
        through the central store and nothing is counted twice. <strong>Not counted · by ledger</strong> means the
        sending department has never recorded a closing count for that item, so what it can send is its ledger figure
        (everything received minus everything used or sent); a count on the Dept Closing Sheet firms it up.
      </p>

      {/* ── Tray: pinned to the bottom of the screen, one Send for everything ── */}
      {canSendAnywhere && tray.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 lg:left-auto lg:right-4 lg:bottom-4 lg:w-[420px]">
          <div className="bg-white border-t-2 lg:border-2 border-[#af4408] lg:rounded-xl shadow-2xl p-3 space-y-2 max-h-[70vh] overflow-y-auto">
            <div className="flex flex-nowrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-[#2D1B0E]">
                To send · {tray.length} item{tray.length === 1 ? '' : 's'}
              </div>
              <button type="button" onClick={() => { setTray([]); setSendError(null); }} className="text-[11px] text-[#8B7355] underline decoration-dotted p-1">
                clear
              </button>
            </div>
            <div className="divide-y divide-[#E8D5C4]/60">
              {tray.map((t, i) => {
                const h = holdingById.get(t.material_id);
                const m = h ? metaOf(h) : null;
                const q = Number(t.qty);
                const flagged = !!sendError?.materialId && sendError.materialId === t.material_id;
                return (
                  <div key={t.material_id} className={`flex flex-nowrap items-center justify-between gap-2 py-1.5 ${flagged ? 'bg-red-50' : ''}`}>
                    <button type="button" onClick={() => h && openRow(h)} className="min-w-0 text-left">
                      <div className="text-xs font-medium text-[#2D1B0E] break-words">{h?.name || t.material_id}</div>
                      {trayProblems[i] && <div className="text-[10px] text-red-700">{trayProblems[i]}</div>}
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      {m && (
                        <span className="text-right font-mono text-sm">
                          {fmtQtyNum(q)} <span className="text-[#8B7355] text-xs">{puOf(m)}</span>
                          {packFactor(m) > 1 && (
                            <span className="block text-[9px] text-[#B8A590]">= {fmtQtyNum(q * packFactor(m))} {m.unit}</span>
                          )}
                        </span>
                      )}
                      <button type="button" onClick={() => { setTray(x => x.filter(y => y.material_id !== t.material_id)); setSendError(null); }}
                              className="p-2 text-red-600" aria-label={`Remove ${h?.name || 'item'} from the tray`}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <input value={note} onChange={e => setNote(e.target.value)} maxLength={200}
                   placeholder="Note (optional — e.g. for tonight's tandoor prep)"
                   className="w-full px-3 py-2 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-base sm:text-sm" />
            {sendError && (
              <div className="flex flex-nowrap items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{sendError.msg}</span>
              </div>
            )}
            <button type="button" onClick={send} disabled={!canSend}
                    className="w-full min-h-[52px] rounded-lg bg-[#af4408] hover:bg-[#8f3806] text-white text-base font-semibold flex flex-nowrap items-center justify-center gap-2 disabled:opacity-40">
              {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : <SendHorizontal className="w-5 h-5" />}
              {sending ? 'Sending…'
                : !toId ? 'Pick a receiving department'
                : `Send to ${clean(toDept?.name || '')}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
