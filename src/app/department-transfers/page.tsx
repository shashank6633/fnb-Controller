'use client';

/**
 * Department Transfers — hand stock from one DEPARTMENT to another. ONE STEP.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS PAGE EXISTS. Direct Issue rules (Meat / POULTRY / SEAFOOD → Kitchen)
 * land vendor deliveries on KITCHEN's department ledger and never in central.
 * Every routed-category requisition, though, comes from the AKAN-* sub-kitchens
 * (Akan Indian, Akan Main Kitchen, Akan Tandoori, …), and a child never sees its
 * parent's stock. This screen is the hand-over.
 *
 * ONE STEP (the owner's ruling, final). The moment a transfer is SENT the
 * sender's ledger goes down and the receiver's goes up, in one server
 * transaction. There is no waiting state and nothing to confirm. The receiver
 * sees it under "Transfers in" and, if it is short, wrong or never came, FLAGS A
 * DISPUTE with a reason — which records the claim and alerts the sender's head
 * and managers, and moves NOTHING. The correction is a send-back (a reverse
 * transfer), one tap from the disputed row, prefilled by the server with the
 * disputed quantity.
 *
 * THIS PAGE DECIDES NOTHING. Who may send comes from `departments[].can_send`;
 * what a person may do with a document comes from its `permissions`
 * (can_flag_dispute, can_reverse + reverse_prefill, dismissable_dispute_ids,
 * and reverse_blocked — the server's words for a disputed line that was counted
 * since it moved and so must not be taken back, shown instead of the button);
 * the quantity that may leave is the server's `transferable`; the receivers and
 * their order are the server's (the sender's family first, then where
 * requisitions for these goods land). Every refusal is printed VERBATIM; the
 * client-side quantity check only saves a round trip.
 *
 * A LOST REPLY IS NOT "NOTHING WAS SENT". Every send carries a client_key minted
 * once per tray (./send-safety.ts). If the reply never comes, the tray LOCKS, the
 * page says the transfer may already have gone through, and the only ways on are
 * the same-key retry — which the server answers with the transfer that key
 * already made, or makes it once — or an explicit discard. The unconfirmed send
 * is remembered on this device, so a reload picks it up and looks for it.
 *
 * UNITS (owner rule 2026-07-29). Every quantity READS and is ENTERED in the
 * PURCHASE unit (kg / L / BTL); the recipe figure appears only as the small
 * "= 4,000 g" hint. Typed quantities are POSTed as typed (quantity_purchase /
 * quantity_received with unit 'purchase'); the SERVER converts once with
 * packFactor(). Display uses the server's *_purchase twins, falling back to
 * src/lib/pack-units — never a local conversion.
 *
 * NEVER COUNTED ≠ ZERO. A department that never counted an item has no balance
 * (NULL). The server then offers its ledger figure as an UPPER BOUND; this page
 * says "up to" and shows the server's basis_label in words.
 *
 * TABLET FIRST. Big rows, 16px inputs (no iOS zoom), one Send for the whole
 * tray, the last receiver remembered per sender, and the lists refresh once a
 * minute while the page is on screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SendHorizontal, ArrowRight, Search, Loader2, AlertTriangle, CircleCheck, X, Plus, Boxes,
  Inbox, Info, Trash2, Flag, Undo2, ShieldAlert, RefreshCw, Building2, ChevronDown,
} from 'lucide-react';
import TabScroller from '@/components/TabScroller';
import { api } from '@/lib/api';
import { packFactor, toPurchaseQty, fmtQtyNum, type PackMeta } from '@/lib/pack-units';
import { fmtISTShort } from '@/lib/format-date';
import {
  mintClientKey, classifySend, readPendingSend, writePendingSend, clearPendingSend, findByClientKey,
  type PendingSend, type SendBody,
} from './send-safety';

/* ── Types (the wire shapes of /api/department-transfers) ───────────────── */

interface Me {
  id: string; email: string; name: string; role: string;
  department_id: string | null;
  is_head_chef?: boolean;
}
/** `departments[]` on GET /api/department-transfers. */
interface DeptOption {
  id: string; name: string;
  parent_id: string | null; parent_name: string;
  is_active: boolean;
  can_send: boolean; can_view: boolean; is_mine: boolean;
}
/** /holdings → receivers[], already in the owner's order. */
interface Receiver {
  id: string; name: string; parent_id: string | null; parent_name: string;
  family: boolean; requisitions_land: boolean; requisition_count: number;
  requisition_basis: 'routed' | 'all'; usage_booked_here: boolean;
}
/** /holdings → rows[]. Plain *_qty fields are RECIPE units. */
interface Holding {
  material_id: string; name: string; category: string;
  unit: string; purchase_unit: string; pack_size: number; pack_factor: number;
  basis: string;
  on_hand: number | null;          // NULL = never counted (never 0)
  available: number;               // may be < 0 — a ledger problem to show
  transferable: number;            // max(0, available)
  transferable_purchase: number;   // server-converted, rounded DOWN to 3 dp
  upper_bound: boolean;            // never counted: "up to", not "holds"
  basis_label: string;
}
interface TLine {
  id: string; material_id: string; material_name: string;
  unit: string; purchase_unit: string; pack_factor: number; pack_size: number;
  qty_sent: number; qty_reversed: number; qty_net: number; qty_open_disputed: number;   // RECIPE
  qty_sent_purchase: number; qty_reversed_purchase: number; qty_net_purchase: number; qty_open_disputed_purchase: number;
  /** Disputed lines only: an end that COUNTED since it moved (a take-back would correct it twice). */
  counted_since?: { receiver: { at: string } | null; sender: { at: string } | null } | null;
}
type DisputeKind = 'short' | 'wrong_item' | 'not_received';
interface TDispute {
  id: string; line_id: string; kind: DisputeKind;
  qty_disputed: number; qty_disputed_purchase: number;
  qty_reversed: number; qty_reversed_purchase: number;
  reason: string; raised_by: string; raised_at: string;
  status: 'open' | 'resolved'; resolution: string; resolution_note: string;
  resolved_by: string; resolved_at: string;
  material_name: string; purchase_unit: string; unit: string;
}
interface PrefillLine {
  line_id: string; material_id: string; material_name: string;
  quantity: number; quantity_purchase: number; unit: string; purchase_unit: string;
}
interface Perms {
  is_sender: boolean;
  can_flag_dispute: boolean;
  can_reverse: boolean;
  reverse_authority: 'receiver' | 'disputed_only' | null;
  reverse_prefill: PrefillLine[];
  /** Why a disputed line cannot be taken back (counted since it moved), in the server's words. */
  reverse_blocked?: string | null;
  dismissable_dispute_ids: string[];
}
interface Transfer {
  id: string; transfer_no: string; client_key?: string;
  from_department_id: string; from_department_name: string;
  to_department_id: string; to_department_name: string;
  status: string; txn_date: string; notes: string;
  created_by: string; created_at: string;
  reverses_transfer_id: string; reverses_transfer_no: string;
  dispute_status: '' | 'open' | 'resolved';
  reversed_by: Array<{ id: string; transfer_no: string; created_at: string; created_by: string }>;
  lines: TLine[]; disputes: TDispute[];
  permissions: Perms;
}
/** A line waiting in the tray. `qty` is the RAW typed PURCHASE-unit string. */
interface TrayLine { material_id: string; qty: string }
interface DisputeDraft {
  kind: DisputeKind | '';
  reason: string;
  /** line id → what DID arrive, typed in the purchase unit ('short'). */
  recv: Record<string, string>;
  /** line id → false when un-ticked ('wrong_item' / 'not_received'). */
  pick: Record<string, boolean>;
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (v == null ? '' : String(v));
const EPS = 1e-6;
const POST_TIMEOUT_MS = 30_000;
/** Collapse the double spaces some department names carry ("Akan  Indian"). */
const clean = (s: string) => str(s).replace(/\s+/g, ' ').trim();

/** Pack meta for the shared helpers. A line carries its SNAPSHOTTED pack
 *  factor (packFactor() at send time) under `pack_size` on the wire. */
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
/** A typed purchase quantity above 0, else null. */
const parseQty = (raw: string): number | null => {
  const s = str(raw).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
};
/** Ledger stamps are UTC ("2026-10-14 08:15:30.123"); format-date reads them as such. */
const when = (s: string) => fmtISTShort(s);
/** Session emails are the stored actor; show the readable half. */
const who = (email: string) => str(email).split('@')[0] || '—';
const KIND_LABEL: Record<DisputeKind, string> = { short: 'Less arrived', wrong_item: 'Wrong item', not_received: 'Not received' };
const KIND_HINT: Record<DisputeKind, string> = {
  short: 'e.g. 4 kg on the slip, 3.2 kg on the scale',
  wrong_item: 'e.g. curry cut came instead of boneless leg',
  not_received: 'e.g. nothing reached the tandoor section',
};

/** Read a JSON body without throwing on an empty / HTML error page. */
async function readJson(r: Response): Promise<any> {
  try { return await r.json(); } catch { return null; }
}
async function getJson(url: string): Promise<{ ok: boolean; status: number; json: any }> {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return { ok: r.ok, status: r.status, json: await readJson(r) };
  } catch (e: any) {
    return { ok: false, status: 0, json: { error: `No connection to the server (${e?.message || 'network error'}). Check the Wi-Fi, then refresh.` } };
  }
}
/** POST through api() (CSRF header) with a hard timeout. status null = no reply. */
async function postJson(url: string, body: unknown): Promise<{ status: number | null; json: any }> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), POST_TIMEOUT_MS) : null;
  try {
    const r = await api(url, { method: 'POST', body, signal: ctl?.signal });
    return { status: r.status, json: await readJson(r) };
  } catch {
    return { status: null, json: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Per-person, per-device memories (a kitchen tablet is shared). Conveniences
 *  only: re-validated against what the server lists, and storage failing just
 *  means no default. */
const viewKey = (userId: string) => `fnb.dept-transfers.view.v2:${userId || 'anon'}`;
const toKey = (userId: string, fromId: string) => `fnb.dept-transfers.to.v2:${userId || 'anon'}:${fromId}`;
const readLS = (k: string): string => { try { return window.localStorage.getItem(k) || ''; } catch { return ''; } };
const writeLS = (k: string, v: string) => { try { window.localStorage.setItem(k, v); } catch { /* private mode */ } };

/* ── Page ───────────────────────────────────────────────────────────────── */

export default function DepartmentTransfersPage() {
  /* who am I */
  const [me, setMe] = useState<Me | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' }).then(r => r.json())
      .then(d => setMe(d?.user || null))
      .catch(() => setMe(null))
      .finally(() => setMeLoaded(true));
  }, []);
  const isMe = useCallback((email: string) =>
    !!me?.email && str(email).trim().toLowerCase() === me.email.trim().toLowerCase(), [me]);
  const whoIs = (email: string) => (isMe(email) ? 'you' : who(email));

  /* departments + every OPEN dispute I can see (GET ?dispute=open) */
  const [depts, setDepts] = useState<DeptOption[]>([]);
  const [deptsLoaded, setDeptsLoaded] = useState(false);
  const [attention, setAttention] = useState<Transfer[]>([]);
  const [topError, setTopError] = useState<string | null>(null);
  const loadAttention = useCallback(async () => {
    const r = await getJson('/api/department-transfers?dispute=open&limit=100');
    if (!r.ok) {
      setTopError(r.json?.error || `Could not load transfers (HTTP ${r.status || 'no reply'})`);
      setDeptsLoaded(true);
      return;
    }
    setTopError(null);
    if (Array.isArray(r.json?.departments)) setDepts(r.json.departments);
    setAttention(Array.isArray(r.json?.transfers) ? r.json.transfers : []);
    setDeptsLoaded(true);
  }, []);
  useEffect(() => { if (me) loadAttention(); }, [me, loadAttention]);

  const byId = useMemo(() => new Map(depts.map(d => [d.id, d])), [depts]);
  /** "Akan Tandoori · Kitchen" — the parent tells the look-alikes apart (top-level
   *  "Tandoor" and "Akan Tandoori" under Kitchen are different ledgers). */
  const label = useCallback((d: { name: string; parent_id: string | null; parent_name: string } | undefined) =>
    !d ? '' : d.parent_id && d.parent_name ? `${clean(d.name)} · ${clean(d.parent_name)}` : clean(d.name), []);

  /* the department in view — mine first, then the ones I may send from */
  const viewable = useMemo(() => {
    const rank = (d: DeptOption) => (d.is_mine ? 0 : d.can_send ? 1 : 2);
    return depts
      .filter(d => d.can_view && (d.is_active || d.is_mine))
      .sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)));
  }, [depts, label]);
  const [viewId, setViewId] = useState('');
  const viewSeeded = useRef(false);
  useEffect(() => {
    if (viewSeeded.current || !me || viewable.length === 0) return;
    viewSeeded.current = true;
    const ok = (id: string) => !!id && viewable.some(d => d.id === id);
    const saved = readLS(viewKey(me.id));
    const own = me.department_id || '';
    if (ok(saved)) { setViewId(saved); return; }
    if (ok(own)) { setViewId(own); return; }
    // Not posted anywhere (an admin / manager) and nothing remembered on this
    // device: open where the latest hand-over came from, not the alphabetical
    // first of thirty departments.
    const fallback = (viewable.find(d => d.can_send) || viewable[0]).id;
    (async () => {
      const r = await getJson('/api/department-transfers?limit=1');
      const t: Transfer | undefined = r.ok && Array.isArray(r.json?.transfers) ? r.json.transfers[0] : undefined;
      setViewId(t && ok(t.from_department_id) ? t.from_department_id : fallback);
    })();
  }, [viewable, me]);
  useEffect(() => { if (viewId && me?.id) writeLS(viewKey(me.id), viewId); }, [viewId, me?.id]);
  const viewDept = viewId ? byId.get(viewId) : undefined;
  const canSendView = !!viewDept?.can_send;
  const sendable = useMemo(() => viewable.filter(d => d.can_send), [viewable]);

  /* Transfers in / out of the department in view */
  const [inList, setInList] = useState<Transfer[]>([]);
  const [outList, setOutList] = useState<Transfer[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const listSeq = useRef(0);
  const loadLists = useCallback(async () => {
    if (!viewId) { setInList([]); setOutList([]); setListLoading(false); return; }
    const seq = ++listSeq.current;
    setListLoading(true);
    const base = `/api/department-transfers?department_id=${encodeURIComponent(viewId)}&limit=40`;
    const [a, b] = await Promise.all([getJson(`${base}&direction=in`), getJson(`${base}&direction=out`)]);
    if (seq !== listSeq.current) return;              // a newer department won
    setListLoading(false);
    if (a.ok) setInList(Array.isArray(a.json?.transfers) ? a.json.transfers : []);
    if (b.ok) setOutList(Array.isArray(b.json?.transfers) ? b.json.transfers : []);
    setListErr(a.ok && b.ok ? null : (a.json?.error || b.json?.error || 'Could not load transfers'));
  }, [viewId]);
  useEffect(() => { loadLists(); }, [loadLists]);
  const [tab, setTab] = useState<'in' | 'out'>('in');
  const tabSeeded = useRef('');
  useEffect(() => {
    if (!viewId || tabSeeded.current === viewId) return;
    tabSeeded.current = viewId;
    setTab(canSendView ? 'out' : 'in');
  }, [viewId, canSendView]);

  /* what the department in view can send, and where to */
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [receivers, setReceivers] = useState<Receiver[]>([]);
  const [holdLoading, setHoldLoading] = useState(false);
  const [holdError, setHoldError] = useState<string | null>(null);
  const holdSeq = useRef(0);
  const loadHoldings = useCallback(async () => {
    const seq = ++holdSeq.current;
    if (!viewId || !canSendView) { setHoldings([]); setReceivers([]); setHoldError(null); setHoldLoading(false); return; }
    setHoldLoading(true);
    const r = await getJson(`/api/department-transfers/holdings?department_id=${encodeURIComponent(viewId)}`);
    if (seq !== holdSeq.current) return;
    setHoldLoading(false);
    if (!r.ok) {
      setHoldings([]); setReceivers([]);
      setHoldError(r.json?.error || `Could not load what this department holds (HTTP ${r.status || 'no reply'})`);
      return;
    }
    setHoldError(null);
    setHoldings(Array.isArray(r.json?.rows) ? r.json.rows : []);
    // (r.json.department's stations / usage_booked_here reach the cook through
    // each row's server-written basis_label, shown when the row is opened.)
    setReceivers(Array.isArray(r.json?.receivers) ? r.json.receivers : []);
  }, [viewId, canSendView]);
  useEffect(() => { loadHoldings(); }, [loadHoldings]);
  const holdingById = useMemo(() => new Map(holdings.map(h => [h.material_id, h])), [holdings]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadAttention(), loadLists(), loadHoldings()]);
  }, [loadAttention, loadLists, loadHoldings]);
  /** The LATEST refreshAll, for code that resumes after an await: a closure
   *  taken before the department in view was chosen (the reload-restore path
   *  runs that early) would otherwise refresh "no department" and blank the
   *  lists. Refreshing is idempotent, so the newest closure is always right. */
  const refreshRef = useRef(refreshAll);
  useEffect(() => { refreshRef.current = refreshAll; }, [refreshAll]);
  const refreshNow = useCallback(() => { void refreshRef.current(); }, []);

  // A kitchen tablet sits open all service: pick up new transfers and disputes
  // on its own, once a minute, only while the page is actually on screen.
  useEffect(() => {
    if (!me) return;
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') refreshAll();
    }, 60_000);
    return () => clearInterval(t);
  }, [me, refreshAll]);

  /* flash */
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 12_000);
    return () => clearTimeout(t);
  }, [flash]);

  /* ── SEND ─────────────────────────────────────────────────────────────── */

  const [toId, setToId] = useState('');
  const [showOthers, setShowOthers] = useState(false);
  const [tray, setTray] = useState<TrayLine[]>([]);
  const [trayKey, setTrayKey] = useState('');
  useEffect(() => { setTrayKey(k => k || mintClientKey('dt')); }, []);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [sendError, setSendError] = useState<{ msg: string; materialId: string | null } | null>(null);
  // A tray belongs to the department it was picked from.
  useEffect(() => {
    setTray([]); setOpenId(null); setDraft(''); setSendError(null); setShowOthers(false);
    setToId(me?.id && viewId ? readLS(toKey(me.id, viewId)) : '');
  }, [viewId, me?.id]);
  useEffect(() => { if (me?.id && viewId && toId) writeLS(toKey(me.id, viewId), toId); }, [toId, viewId, me?.id]);
  // A remembered receiver that the server no longer offers is dropped.
  useEffect(() => {
    if (toId && receivers.length > 0 && !receivers.some(r => r.id === toId)) setToId('');
  }, [receivers, toId]);
  const toRecv = receivers.find(r => r.id === toId);

  /* receivers: the server's order. Family first; the rest behind a toggle (any may be chosen). */
  const { primary, others } = useMemo(() => {
    const fam = receivers.filter(r => r.family);
    if (fam.length > 0) return { primary: fam, others: receivers.filter(r => !r.family) };
    const lands = receivers.filter(r => r.requisitions_land);
    if (lands.length > 0) return { primary: lands, others: receivers.filter(r => !r.requisitions_land) };
    return { primary: receivers, others: [] as Receiver[] };
  }, [receivers]);

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
      .sort((a, b) => (Number(b.transferable > EPS) - Number(a.transferable > EPS)) || str(a.name).localeCompare(str(b.name)));
  }, [holdings, search, category]);

  /* the unconfirmed send (./send-safety.ts) */
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [pendingPhase, setPendingPhase] = useState<'inflight' | 'unknown' | 'checking'>('inflight');
  const [pendingMsg, setPendingMsg] = useState('');
  const [discardAsk, setDiscardAsk] = useState(false);
  const locked = !!pending;

  const openRow = (h: Holding) => {
    if (locked) return;
    if (openId === h.material_id) { setOpenId(null); return; }
    setOpenId(h.material_id);
    setDraft(tray.find(t => t.material_id === h.material_id)?.qty || '');
  };
  /** One typed quantity against what the sender can send. */
  const checkQty = (h: Holding, raw: string): string | null => {
    const q = parseQty(raw);
    if (q == null) return 'Enter a quantity above 0';
    const m = metaOf(h);
    if (q * packFactor(m) > num(h.transferable) + EPS) {
      return `${h.upper_bound ? 'Up to' : 'Only'} ${showPU(m, h.transferable, h.transferable_purchase)} ${puOf(m)} can be sent from ${clean(viewDept?.name || 'this department')}`;
    }
    return null;
  };
  const addToTray = (h: Holding) => {
    if (locked || checkQty(h, draft)) return;
    const qty = draft.trim();
    setTray(t => [...t.filter(x => x.material_id !== h.material_id), { material_id: h.material_id, qty }]);
    setOpenId(null); setDraft(''); setSendError(null);
  };
  const trayProblems = tray.map(t => {
    const h = holdingById.get(t.material_id);
    return h ? checkQty(h, t.qty) : 'No longer held by this department';
  });
  const canSend = canSendView && !!toId && toId !== viewId && tray.length > 0
    && trayProblems.every(p => !p) && !locked && !!trayKey && !!me;

  /** Look for the transfer a pending send's key made. Found → settled as sent
   *  (the reply was lost, the transfer was not). Not found → still UNKNOWN: it
   *  may be arriving yet, or never have left — only the same-key send can tell. */
  const lookupPending = useCallback(async (p: PendingSend, why: string) => {
    if (!me) return;
    setPendingPhase('checking');
    const r = await getJson(`/api/department-transfers?department_id=${encodeURIComponent(p.body.from_department_id)}&direction=out&limit=60`);
    const hit = r.ok && Array.isArray(r.json?.transfers) ? findByClientKey(r.json.transfers as Transfer[], p.body.client_key) : null;
    if (hit) {
      clearPendingSend(me.id);
      setPending(null); setPendingMsg(''); setDiscardAsk(false);
      if (p.body.from_department_id === viewId) { setTray([]); setNote(''); }
      setTrayKey(mintClientKey('dt'));
      setFlash(`${hit.transfer_no} went through (the reply was lost, the transfer was not): ${clean(hit.from_department_name)} → ` +
        `${clean(hit.to_department_name)}. Nothing more to do — do not send it again.`);
      setTab('out');
      refreshNow();
      return;
    }
    setPendingPhase('unknown');
    setPendingMsg(r.ok
      ? `${why} It is not on the server's list yet — it may still be arriving, or it never left this device.`
      : `${why} The server cannot be reached to check, so it may already have gone through.`);
  }, [me, viewId, refreshNow]);

  /** POST one pending send and settle it by what the reply PROVES. */
  const settleSend = useCallback(async (p: PendingSend, restoring: boolean) => {
    if (!me) return;
    setPendingPhase(restoring ? 'checking' : 'inflight');
    const { status, json } = await postJson('/api/department-transfers', p.body);
    const out = classifySend(status, json);
    if (out.kind === 'sent') {
      clearPendingSend(me.id);
      setPending(null); setPendingMsg(''); setDiscardAsk(false);
      if (!restoring || p.body.from_department_id === viewId) { setTray([]); setNote(''); }
      setTrayKey(mintClientKey('dt'));                // only after a CONFIRMED send
      setSendError(null);
      const t = out.transfer as Transfer;
      const items = (t.lines || []).map(l => `${showPU(metaOf(l), l.qty_sent, l.qty_sent_purchase)} ${puOf(metaOf(l))} ${l.material_name}`).join(', ');
      setFlash(`${t.transfer_no} ${out.duplicate ? 'had already gone through — nothing was sent twice' : 'sent'}: ${items} moved from ` +
        `${clean(t.from_department_name)}'s books to ${clean(t.to_department_name)}'s. If it doesn't arrive, ` +
        `${clean(t.to_department_name)} can flag it.`);
      setTab('out');
      refreshNow();
      return;
    }
    if (out.kind === 'refused') {
      // A refusal wrote NOTHING (the server's key gate runs first and every
      // refusal rolls back), so the tray unlocks for the cook to fix.
      clearPendingSend(me.id);
      setPending(null); setPendingMsg(''); setDiscardAsk(false);
      if (restoring && tray.length === 0 && p.body.from_department_id === viewId) {
        setTray(p.body.lines.map(l => ({ material_id: l.material_id, qty: String(l.quantity_purchase) })));
        setToId(p.body.to_department_id);
      }
      if (out.reason === 'idempotency_conflict') {
        setTrayKey(mintClientKey('dt'));
        setSendError({ msg: `${out.error} Look under Transfers out before sending again.`, materialId: null });
        setTab('out');
      } else {
        setSendError({ msg: out.error, materialId: out.materialId });
      }
      if (out.status === 409) loadHoldings();
      return;
    }
    // No proof either way: look for it before saying anything else.
    await lookupPending(p, out.detail === 'no reply from the server' ? 'No answer from the server.' : `No clear answer (${out.detail}).`);
  }, [me, viewId, tray.length, refreshNow, loadHoldings, lookupPending]);

  const send = () => {
    if (!canSend || !me) return;
    const body: SendBody = {
      from_department_id: viewId,
      to_department_id: toId,
      client_key: trayKey,
      notes: note.trim(),
      // PURCHASE units, exactly as typed, under the explicitly purchase-named
      // field. The server converts ONCE with packFactor() — never here.
      lines: tray.map(t => ({ material_id: t.material_id, quantity_purchase: Number(t.qty), unit: 'purchase' as const })),
    };
    const p: PendingSend = {
      v: 1, body,
      from_name: clean(viewDept?.name || ''),
      to_name: clean(toRecv?.name || byId.get(toId)?.name || ''),
      items: tray.map(t => {
        const h = holdingById.get(t.material_id);
        return { material_id: t.material_id, name: h?.name || t.material_id, qty: Number(t.qty), pu: h ? puOf(metaOf(h)) : '' };
      }),
      at: new Date().toISOString(),
    };
    // Remembered BEFORE it leaves: a reload mid-send must know it may be in flight.
    writePendingSend(me.id, p);
    setPending(p); setSendError(null); setDiscardAsk(false); setPendingMsg('');
    settleSend(p, false);
  };

  /* A send this device never heard back about (a reload, a dead tablet): look
   * for the transfer its key made. Found → done. Not found → it may still be
   * arriving or may never have left; the same-key send settles it either way. */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !me || !deptsLoaded) return;
    restored.current = true;
    const p = readPendingSend(me.id);
    if (!p) return;
    setPending(p); setPendingMsg('');
    lookupPending(p, 'This device never heard back about this send.');
  }, [me, deptsLoaded, lookupPending]);

  const discardPending = () => {
    if (!me || !pending) return;
    const from = pending.body.from_department_id;
    clearPendingSend(me.id);
    setPending(null); setPendingMsg(''); setDiscardAsk(false);
    // The key may have made a transfer; it must never be reused for other goods.
    setTrayKey(mintClientKey('dt'));
    if (from === viewId) { setTray([]); setNote(''); }
    setTab('out');
    refreshNow();
  };

  /* ── DISPUTE / SEND BACK / CLOSE — per document ──────────────────────── */

  const [form, setForm] = useState<Record<string, 'dispute' | 'resolve' | 'sendback' | undefined>>({});
  const [drafts, setDrafts] = useState<Record<string, DisputeDraft>>({});
  const [resolveNote, setResolveNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [docErr, setDocErr] = useState<Record<string, string>>({});
  const [revKeys, setRevKeys] = useState<Record<string, string>>({});
  const [revUnknown, setRevUnknown] = useState<Record<string, string>>({});
  const setOne = <T,>(set: React.Dispatch<React.SetStateAction<Record<string, T>>>, id: string, v: NoInfer<T> | undefined) =>
    set(s => { const n = { ...s }; if (v === undefined) delete n[id]; else n[id] = v; return n; });

  const draftOf = (t: Transfer): DisputeDraft => drafts[t.id] || { kind: '', reason: '', recv: {}, pick: {} };
  const patchDraft = (t: Transfer, p: Partial<DisputeDraft>) => setDrafts(s => ({ ...s, [t.id]: { ...draftOf(t), ...p } }));
  /** Lines that can still be disputed: something stands and no open claim yet. */
  const disputable = (t: Transfer) => t.lines.filter(l => l.qty_net > EPS
    && !t.disputes.some(d => d.line_id === l.id && d.status === 'open'));
  const toggleForm = (t: Transfer, f: 'dispute' | 'resolve' | 'sendback') => {
    setOne(setDocErr, t.id, undefined);
    setForm(s => ({ ...s, [t.id]: s[t.id] === f ? undefined : f }));
  };

  const flagDispute = async (t: Transfer) => {
    const d = draftOf(t);
    const fail = (m: string) => setOne(setDocErr, t.id, m);
    if (!d.kind) return fail('Pick what is wrong: less arrived, wrong item, or not received.');
    if (!d.reason.trim()) return fail(`Say what happened — ${clean(t.from_department_name)} needs a reason to act on.`);
    const lines = disputable(t);
    const body: Record<string, unknown> = { kind: d.kind, reason: d.reason.trim() };
    if (d.kind === 'short') {
      const typed = lines.filter(l => str(d.recv[l.id]).trim() !== '');
      if (typed.length === 0) return fail('Type how much DID arrive on the line that came short.');
      for (const l of typed) {
        const q = Number(str(d.recv[l.id]).trim());
        const m = metaOf(l);
        if (!Number.isFinite(q) || q < 0) return fail(`${l.material_name}: what arrived must be 0 or more.`);
        if (q * packFactor(m) >= l.qty_net - EPS) {
          return fail(`${l.material_name}: ${fmtQtyNum(q)} ${puOf(m)} is not less than the ${showPU(m, l.qty_net, l.qty_net_purchase)} ${puOf(m)} sent — nothing is short.`);
        }
      }
      // Purchase unit, as typed. The server converts once and records the difference.
      body.lines = typed.map(l => ({ line_id: l.id, quantity_received: Number(str(d.recv[l.id]).trim()), unit: 'purchase' }));
    } else {
      const picked = lines.filter(l => d.pick[l.id] !== false);
      if (picked.length === 0) return fail('Tick at least one item.');
      if (picked.length < lines.length) body.lines = picked.map(l => ({ line_id: l.id }));
    }
    setOne(setBusy, t.id, true); setOne(setDocErr, t.id, undefined);
    const { status, json } = await postJson(`/api/department-transfers/${encodeURIComponent(t.id)}/dispute`, body);
    setOne(setBusy, t.id, undefined);
    if (status != null && status >= 200 && status < 300 && json?.transfer) {
      // The sending department's own people first (its head / HOD, the person
      // who sent it), then managers and admins — the order a cook cares about.
      const rank: Record<string, number> = { head: 0, hod: 0, sender: 1, manager: 2, admin: 3 };
      type Alerted = { email?: string; name?: string; why?: string };
      const alerted: Alerted[] = Array.isArray(json.alerted) ? json.alerted : [];
      const told: string[] = [...alerted].sort((a, b) => (rank[str(a?.why)] ?? 4) - (rank[str(b?.why)] ?? 4))
        .map(a => str(a?.name || who(str(a?.email)))).filter(Boolean);
      const toldText = told.length > 4 ? `${told.slice(0, 4).join(', ')} and ${told.length - 4} more` : told.join(', ');
      setForm(s => ({ ...s, [t.id]: undefined }));
      setDrafts(s => { const n = { ...s }; delete n[t.id]; return n; });
      setFlash(`${t.transfer_no} flagged. Nothing has moved. ${told.length ? `Told: ${toldText}.` : `${clean(t.from_department_name)}'s head and managers are told.`} ` +
        `If ${clean(t.from_department_name)} agrees, they take it back from here.`);
      refreshNow();
      return;
    }
    if (status != null && status >= 400 && status < 500 && status !== 408 && status !== 499) {
      fail(str(json?.error) || `Refused (${status})`);
      return;
    }
    // No clear answer: look before telling anyone to flag again. (A line holds
    // one open dispute at a time, so a second flag cannot double it.)
    const r = await getJson(`/api/department-transfers/${encodeURIComponent(t.id)}`);
    const now: Transfer | null = r.ok ? r.json?.transfer || null : null;
    if (now && now.disputes.some(x => x.status === 'open' && isMe(x.raised_by) && x.reason === d.reason.trim())) {
      setForm(s => ({ ...s, [t.id]: undefined }));
      setFlash(`${t.transfer_no} flagged (the reply was lost, but the dispute is recorded). Nothing has moved.`);
      refreshNow();
      return;
    }
    fail('No answer from the server. Check this transfer in a minute: if it does not show "Disputed", flag it again — it cannot be recorded twice.');
  };

  /** THE correction: the server's prefill (the disputed quantity, or — sent back
   *  by the receiving side unasked — everything still standing). One tap. */
  const sendBack = async (t: Transfer) => {
    const key = revKeys[t.id] || mintClientKey('rv');
    setOne(setRevKeys, t.id, key);
    setOne(setBusy, t.id, true); setOne(setDocErr, t.id, undefined); setOne(setRevUnknown, t.id, undefined);
    const { status, json } = await postJson(`/api/department-transfers/${encodeURIComponent(t.id)}/reverse`, { client_key: key });
    setOne(setBusy, t.id, undefined);
    const out = classifySend(status, json);
    if (out.kind === 'sent') {
      setOne(setRevKeys, t.id, undefined);
      setForm(s => ({ ...s, [t.id]: undefined }));
      const r = out.transfer as Transfer;
      const items = (r.lines || []).map(l => `${showPU(metaOf(l), l.qty_sent, l.qty_sent_purchase)} ${puOf(metaOf(l))} ${l.material_name}`).join(', ');
      setFlash(`${r.transfer_no}${out.duplicate ? ' (had already gone through)' : ''}: ${items} moved back from ` +
        `${clean(r.from_department_name)}'s books to ${clean(r.to_department_name)}'s. ${t.transfer_no}'s dispute is settled by it.`);
      refreshNow();
      return;
    }
    if (out.kind === 'refused') {
      setOne(setRevKeys, t.id, undefined);           // nothing was written under it
      setOne(setDocErr, t.id, out.error);
      refreshNow();
      return;
    }
    // No proof either way: look for the send-back this key made — it lands IN
    // the original sender and leaves the original receiver; ask the side this
    // person acts for (the one they can certainly see).
    const side = t.permissions?.reverse_authority === 'receiver'
      ? `department_id=${encodeURIComponent(t.to_department_id)}&direction=out`
      : `department_id=${encodeURIComponent(t.from_department_id)}&direction=in`;
    const r = await getJson(`/api/department-transfers?${side}&limit=60`);
    const hit = r.ok && Array.isArray(r.json?.transfers) ? findByClientKey(r.json.transfers as Transfer[], key) : null;
    if (hit) {
      setOne(setRevKeys, t.id, undefined);
      setForm(s => ({ ...s, [t.id]: undefined }));
      setFlash(`${hit.transfer_no} went through (the reply was lost, the send-back was not). ${t.transfer_no}'s dispute is settled by it.`);
      refreshNow();
      return;
    }
    setOne(setRevUnknown, t.id, `${out.detail === 'no reply from the server' ? 'No answer from the server.' : `No clear answer (${out.detail}).`} ` +
      'The send-back may already have gone through. Tap it again — the same tap can never move it twice.');
  };

  const closeDispute = async (t: Transfer) => {
    const why = str(resolveNote[t.id]).trim();
    if (!why) { setOne(setDocErr, t.id, 'Say why it is being closed without moving anything (e.g. "found it in the walk-in").'); return; }
    setOne(setBusy, t.id, true); setOne(setDocErr, t.id, undefined);
    const { status, json } = await postJson(`/api/department-transfers/${encodeURIComponent(t.id)}/resolve`,
      { note: why, dispute_ids: t.permissions.dismissable_dispute_ids });
    setOne(setBusy, t.id, undefined);
    if (status != null && status >= 200 && status < 300) {
      setForm(s => ({ ...s, [t.id]: undefined }));
      setFlash(`${t.transfer_no}: dispute closed. Nothing moved.`);
      refreshNow();
      return;
    }
    setOne(setDocErr, t.id, str(json?.error) || (status == null ? 'No answer from the server — check the row before trying again.' : `Refused (${status})`));
    refreshNow();
  };

  /* what needs this person: open disputes they can settle (send back / close) */
  const needsMe = useMemo(() => attention.filter(t => t.dispute_status === 'open' && (
    t.permissions?.can_reverse
    // Counted since it moved: no take-back, but the person still has to act
    // (count the other side, or close it) — so it stays in front of them.
    || !!t.permissions?.reverse_blocked
    || (t.permissions?.dismissable_dispute_ids || []).some(id => !isMe(t.disputes.find(d => d.id === id)?.raised_by || ''))
  )), [attention, isMe]);
  /** A document settled from the panel above carries its buttons THERE only. */
  const needsMeIds = useMemo(() => new Set(needsMe.map(t => t.id)), [needsMe]);

  /* ── render pieces ───────────────────────────────────────────────────── */

  const chip = (cls: string, text: string, title?: string) =>
    <span title={title} className={`px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase whitespace-nowrap ${cls}`}>{text}</span>;

  const docChips = (t: Transfer) => (
    <div className="flex flex-wrap justify-end gap-1">
      {t.dispute_status === 'open' && chip('bg-amber-100 text-amber-800', 'disputed')}
      {t.dispute_status === 'resolved' && chip('bg-emerald-50 text-emerald-700', 'dispute closed')}
      {t.reverses_transfer_no && chip('bg-[#E8D5C4] text-[#6B5744]', `send-back of ${t.reverses_transfer_no}`)}
      {t.reversed_by?.length > 0 && chip('bg-[#E8D5C4] text-[#6B5744]', `sent back · ${t.reversed_by.map(r => r.transfer_no).join(', ')}`)}
    </div>
  );

  const lineRows = (t: Transfer) => (
    <div className="mt-2 space-y-1.5">
      {t.lines.map(l => {
        const m = metaOf(l);
        return (
          <div key={l.id} className="flex flex-nowrap items-start justify-between gap-2 text-sm">
            <div className="min-w-0">
              <div className="break-words text-[#2D1B0E]">{l.material_name}</div>
              {l.qty_reversed > EPS && (
                <div className="text-[11px] text-[#6B5744]">
                  {showPU(m, l.qty_reversed, l.qty_reversed_purchase)} {puOf(m)} sent back · {showPU(m, l.qty_net, l.qty_net_purchase)} {puOf(m)} stands
                </div>
              )}
              {l.qty_open_disputed > EPS && (
                <div className="text-[11px] text-amber-800 font-medium">
                  {showPU(m, l.qty_open_disputed, l.qty_open_disputed_purchase)} {puOf(m)} under dispute
                </div>
              )}
            </div>
            <div className="shrink-0 text-right font-mono">
              <span className="font-semibold">{showPU(m, l.qty_sent, l.qty_sent_purchase)}</span> <span className="text-xs text-[#8B7355]">{puOf(m)}</span>
              {recipeHint(m, l.qty_sent) && <div className="text-[10px] text-[#B8A590]">{recipeHint(m, l.qty_sent)}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );

  const disputeRows = (t: Transfer) => t.disputes.length > 0 && (
    <div className="mt-2 space-y-1.5">
      {t.disputes.map(d => (
        <div key={d.id} className={`rounded-lg px-2.5 py-2 text-xs border ${d.status === 'open'
          ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-[#FFF8F0] border-[#E8D5C4] text-[#6B5744]'}`}>
          <div className="font-semibold flex flex-wrap items-center gap-x-1.5">
            <Flag className="w-3.5 h-3.5 shrink-0" />
            <span>{KIND_LABEL[d.kind] || d.kind}</span>
            <span className="font-normal">· {d.material_name} · {fmtQtyNum(d.qty_disputed_purchase)} {d.purchase_unit}</span>
          </div>
          <div className="mt-0.5 break-words">“{d.reason}” — {whoIs(d.raised_by)}, {when(d.raised_at)}</div>
          {d.status === 'open' ? (
            <div className="mt-0.5">
              {t.lines.find(l => l.id === d.line_id)?.counted_since
                ? <>Nothing has moved. It has been counted since it was sent, so it cannot be taken back — that would correct the books twice.</>
                : t.permissions?.can_reverse && t.permissions.reverse_authority === 'disputed_only'
                ? <>Nothing has moved. It is with you: take it back if {clean(t.to_department_name)} is right — or a manager closes it with a note.</>
                : <>Nothing has moved. Waiting on {clean(t.from_department_name)}: they take it back, or it is closed with a note.</>}
            </div>
          ) : d.resolution === 'reversed' ? (
            <div className="mt-0.5 text-emerald-800">
              Settled — {fmtQtyNum(d.qty_reversed_purchase)} {d.purchase_unit} sent back by {whoIs(d.resolved_by)}, {when(d.resolved_at)}.
            </div>
          ) : (
            <div className="mt-0.5">
              Closed by {whoIs(d.resolved_by)}, {when(d.resolved_at)}{d.resolution_note ? <> — “{d.resolution_note}”</> : null}. Nothing moved.
            </div>
          )}
        </div>
      ))}
    </div>
  );

  /** What one send-back would move, from the server's prefill. */
  const prefillText = (t: Transfer) => {
    const p = t.permissions?.reverse_prefill || [];
    if (p.length === 1) return `${fmtQtyNum(p[0].quantity_purchase)} ${p[0].purchase_unit}`;
    return `${p.length} items`;
  };
  const prefillList = (t: Transfer) => (t.permissions?.reverse_prefill || []).map(p =>
    <div key={p.line_id} className="flex flex-nowrap justify-between gap-2">
      <span className="min-w-0 break-words">{p.material_name}</span>
      <span className="shrink-0 font-mono">{fmtQtyNum(p.quantity_purchase)} {p.purchase_unit}</span>
    </div>);

  /** The controls the server says this person may use on one document. */
  const actions = (t: Transfer) => {
    const p = t.permissions;
    if (!p) return null;
    const open = t.dispute_status === 'open';
    const mode = form[t.id];
    const isBusy = !!busy[t.id];
    const mineOnly = p.dismissable_dispute_ids.length > 0
      && p.dismissable_dispute_ids.every(id => isMe(t.disputes.find(d => d.id === id)?.raised_by || ''));
    const sb = p.can_reverse && open;            // the one-tap correction of a claim
    const sbUnasked = p.can_reverse && !open && p.reverse_authority === 'receiver';
    const blockedWhy = open ? str(p.reverse_blocked) : '';
    if (!p.can_flag_dispute && !p.can_reverse && !blockedWhy && p.dismissable_dispute_ids.length === 0) return null;
    return (
      <div className="mt-2.5 space-y-2">
        {blockedWhy && (
          <div className="flex flex-nowrap items-start gap-2 text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <span className="break-words">{blockedWhy}</span>
          </div>
        )}
        {sb && (
          <div className="rounded-lg border border-[#af4408]/30 bg-[#FFF1E3] p-2.5 space-y-2">
            <div className="text-[11px] text-[#6B5744]">
              {p.reverse_authority === 'disputed_only'
                ? <>{clean(t.to_department_name)} says this did not all arrive. Taking it back moves the disputed amount off {clean(t.to_department_name)}&apos;s books and back onto {clean(t.from_department_name)}&apos;s, now.</>
                : <>Sends the disputed amount back to {clean(t.from_department_name)} now — off {clean(t.to_department_name)}&apos;s books, onto {clean(t.from_department_name)}&apos;s.</>}
            </div>
            <div className="text-xs text-[#2D1B0E] space-y-0.5">{prefillList(t)}</div>
            <button type="button" disabled={isBusy} onClick={() => sendBack(t)}
                    className="w-full min-h-[52px] px-4 rounded-lg bg-[#af4408] hover:bg-[#8f3806] text-white text-base font-semibold flex flex-nowrap items-center justify-center gap-2 disabled:opacity-40">
              {isBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Undo2 className="w-5 h-5" />}
              {p.reverse_authority === 'disputed_only' ? `Take back ${prefillText(t)}` : `Send back ${prefillText(t)}`}
            </button>
          </div>
        )}
        {revUnknown[t.id] && (
          <div className="flex flex-nowrap items-start gap-2 text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{revUnknown[t.id]}</span>
          </div>
        )}
        {mode === 'sendback' && sbUnasked && (
          <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-2.5 space-y-2">
            <div className="text-[11px] text-[#6B5744]">
              Send these back to {clean(t.from_department_name)} now? They leave {clean(t.to_department_name)}&apos;s books at once.
            </div>
            <div className="text-xs text-[#2D1B0E] space-y-0.5">{prefillList(t)}</div>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={isBusy} onClick={() => sendBack(t)}
                      className="min-h-[48px] px-4 rounded-lg bg-[#af4408] hover:bg-[#8f3806] text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-40">
                {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
                Yes, send back {prefillText(t)}
              </button>
              <button type="button" onClick={() => toggleForm(t, 'sendback')}
                      className="min-h-[48px] px-3 rounded-lg border border-[#D4B896] bg-white text-sm text-[#6B5744]">Back</button>
            </div>
          </div>
        )}
        {mode === 'dispute' && p.can_flag_dispute && disputeForm(t)}
        {mode === 'resolve' && p.dismissable_dispute_ids.length > 0 && (
          <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-2.5 space-y-2">
            <div className="text-[11px] text-[#6B5744]">
              {mineOnly ? 'Withdraw your claim — nothing moves.' : 'Close the dispute without moving anything back.'} A note is kept on it.
            </div>
            <input value={resolveNote[t.id] || ''} onChange={e => setResolveNote(s => ({ ...s, [t.id]: e.target.value }))} maxLength={300}
                   placeholder={mineOnly ? 'e.g. found it in the walk-in' : 'Why? (kept on record)'}
                   className="w-full px-3 py-2.5 border border-[#D4B896] rounded-lg bg-white text-base" />
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={isBusy} onClick={() => closeDispute(t)}
                      className="min-h-[48px] px-4 rounded-lg bg-[#6B5744] hover:bg-[#2D1B0E] text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-40">
                {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CircleCheck className="w-4 h-4" />}
                {mineOnly ? 'Withdraw claim' : 'Close dispute'}
              </button>
              <button type="button" onClick={() => toggleForm(t, 'resolve')}
                      className="min-h-[48px] px-3 rounded-lg border border-[#D4B896] bg-white text-sm text-[#6B5744]">Back</button>
            </div>
          </div>
        )}
        {docErr[t.id] && (
          <div className="flex flex-nowrap items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{docErr[t.id]}</span>
          </div>
        )}
        {!mode && (
          <div className="flex flex-wrap gap-2">
            {p.can_flag_dispute && (
              <button type="button" onClick={() => toggleForm(t, 'dispute')}
                      className="min-h-[48px] px-4 rounded-lg border-2 border-amber-400 bg-white text-sm font-semibold text-amber-800 hover:bg-amber-50 flex items-center gap-1.5">
                <Flag className="w-4 h-4" /> Flag a problem
              </button>
            )}
            {sbUnasked && (
              <button type="button" onClick={() => toggleForm(t, 'sendback')}
                      className="min-h-[48px] px-3 rounded-lg border border-[#D4B896] bg-white text-sm text-[#6B5744] hover:border-[#af4408] flex items-center gap-1.5">
                <Undo2 className="w-4 h-4" /> Send it back…
              </button>
            )}
            {p.dismissable_dispute_ids.length > 0 && (
              <button type="button" onClick={() => toggleForm(t, 'resolve')}
                      className="min-h-[48px] px-3 rounded-lg border border-[#D4B896] bg-white text-sm text-[#6B5744] hover:border-[#6B5744]">
                {mineOnly ? 'Withdraw my claim' : 'Close without moving stock'}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const disputeForm = (t: Transfer) => {
    const d = draftOf(t);
    const lines = disputable(t);
    const isBusy = !!busy[t.id];
    return (
      <div className="rounded-lg border-2 border-amber-300 bg-amber-50/60 p-2.5 space-y-2.5">
        <div className="text-xs font-semibold text-[#2D1B0E]">What is wrong with {t.transfer_no}?</div>
        <div className="grid grid-cols-3 gap-1.5">
          {(['short', 'wrong_item', 'not_received'] as DisputeKind[]).map(k => (
            <button key={k} type="button" onClick={() => patchDraft(t, { kind: k })}
                    className={`min-h-[48px] px-2 rounded-lg border text-sm font-semibold ${d.kind === k
                      ? 'bg-amber-600 border-amber-600 text-white' : 'bg-white border-amber-300 text-amber-900'}`}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        {d.kind === 'short' && (
          <div className="space-y-1.5">
            <div className="text-[11px] text-[#6B5744]">How much DID arrive? Leave a line blank if it came in full.</div>
            {lines.map(l => {
              const m = metaOf(l);
              const typed = str(d.recv[l.id]);
              return (
                <label key={l.id} className="flex flex-nowrap items-center justify-between gap-2">
                  <span className="min-w-0 text-xs text-[#2D1B0E] break-words">
                    {l.material_name}
                    <span className="block text-[10px] text-[#8B7355]">sent {showPU(m, l.qty_net, l.qty_net_purchase)} {puOf(m)}</span>
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    <input type="number" inputMode="decimal" step="any" min="0" value={typed}
                           onChange={e => patchDraft(t, { recv: { ...d.recv, [l.id]: e.target.value.replace(/^-+/, '') } })}
                           aria-label={`${l.material_name} that arrived, in ${puOf(m)}`}
                           className="w-24 px-2 py-2.5 border border-[#D4B896] rounded-lg bg-white text-base font-mono text-right" />
                    <span className="w-10 text-xs text-[#8B7355]">{puOf(m)}</span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {(d.kind === 'wrong_item' || d.kind === 'not_received') && lines.length > 1 && (
          <div className="space-y-1">
            <div className="text-[11px] text-[#6B5744]">Which items?</div>
            {lines.map(l => {
              const m = metaOf(l);
              return (
                <label key={l.id} className="flex flex-nowrap items-center gap-2 min-h-[40px] text-xs text-[#2D1B0E]">
                  <input type="checkbox" checked={d.pick[l.id] !== false}
                         onChange={e => patchDraft(t, { pick: { ...d.pick, [l.id]: e.target.checked } })}
                         className="w-5 h-5 accent-amber-600 shrink-0" />
                  <span className="min-w-0 break-words flex-1">{l.material_name}</span>
                  <span className="shrink-0 font-mono">{showPU(m, l.qty_net, l.qty_net_purchase)} {puOf(m)}</span>
                </label>
              );
            })}
          </div>
        )}
        {d.kind && (
          <textarea value={d.reason} onChange={e => patchDraft(t, { reason: e.target.value })} rows={2} maxLength={1000}
                    placeholder={`What happened? (required) — ${KIND_HINT[d.kind]}`}
                    className="w-full px-3 py-2 border border-[#D4B896] rounded-lg bg-white text-base" />
        )}
        <div className="text-[10px] text-[#6B5744]">
          Flagging moves nothing. {clean(t.from_department_name)}&apos;s head and managers are told; if they agree, they take it back.
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={isBusy || !d.kind} onClick={() => flagDispute(t)}
                  className="min-h-[48px] px-4 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-40">
            {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Flag className="w-4 h-4" />}
            Flag dispute
          </button>
          <button type="button" onClick={() => toggleForm(t, 'dispute')}
                  className="min-h-[48px] px-3 rounded-lg border border-[#D4B896] bg-white text-sm text-[#6B5744]">Cancel</button>
        </div>
      </div>
    );
  };

  /** One transfer document. `side` is relative to the department in view. */
  const docCard = (t: Transfer, side: 'in' | 'out' | 'attention') => (
    <div key={`${side}-${t.id}`} className={`bg-white border rounded-xl p-3 ${t.dispute_status === 'open' ? 'border-amber-300' : 'border-[#E8D5C4]'}`}>
      <div className="flex flex-nowrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1 flex-wrap">
            <span className="break-words">{clean(t.from_department_name)}</span>
            <ArrowRight className="w-4 h-4 text-[#af4408] shrink-0" />
            <span className="break-words">{clean(t.to_department_name)}</span>
          </div>
          <div className="text-[10px] text-[#8B7355]">
            {t.transfer_no} · {when(t.created_at)} · sent by <span title={t.created_by}>{whoIs(t.created_by)}</span>
          </div>
        </div>
        <div className="shrink-0 max-w-[50%]">{docChips(t)}</div>
      </div>
      {lineRows(t)}
      {t.notes && <div className="mt-1.5 text-[11px] text-[#6B5744] italic break-words">“{t.notes}”</div>}
      {disputeRows(t)}
      {side !== 'attention' && needsMeIds.has(t.id) ? (
        <div className="mt-2 text-[11px] font-semibold text-amber-800">Waiting on you — settle it under “Disputes for you to settle” above.</div>
      ) : actions(t)}
    </div>
  );

  /** The unconfirmed send: what it was, what we know, and the only safe ways on. */
  const pendingPanel = (p: PendingSend) => (
    <div className="bg-amber-50 border-2 border-amber-400 rounded-xl p-3 space-y-2">
      <div className="flex flex-nowrap items-start gap-2">
        <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5 text-amber-700" />
        <div className="min-w-0 text-sm text-amber-950">
          <div className="font-semibold">
            {pendingPhase === 'checking' ? 'Checking a send from this device…' : 'Not confirmed — do not type this transfer in again'}
          </div>
          <div className="text-xs mt-0.5 break-words">
            {p.from_name || 'Sender'} → {p.to_name || 'receiver'}:{' '}
            {p.items.map(i => `${fmtQtyNum(i.qty)} ${i.pu} ${i.name}`).join(', ')}
            {p.at ? ` · first sent ${when(p.at)}` : ''}
          </div>
          {pendingMsg && <div className="text-xs mt-1">{pendingMsg}</div>}
          <div className="text-[11px] mt-1 text-amber-900">
            Finishing it is safe: the server recognises this exact send, so if it already went through nothing is sent twice.
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pendingPhase === 'checking'} onClick={() => settleSend(p, true)}
                className="min-h-[52px] px-4 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-base font-semibold flex flex-nowrap items-center gap-2 disabled:opacity-40">
          {pendingPhase === 'checking' ? <Loader2 className="w-5 h-5 animate-spin" /> : <RefreshCw className="w-5 h-5" />}
          Check &amp; finish sending
        </button>
        {!discardAsk ? (
          <button type="button" disabled={pendingPhase === 'checking'} onClick={() => setDiscardAsk(true)}
                  className="min-h-[52px] px-3 rounded-lg border border-amber-400 bg-white text-sm text-amber-900 disabled:opacity-40">
            Discard…
          </button>
        ) : (
          <div className="w-full text-xs text-amber-950 bg-white border border-amber-300 rounded-lg p-2 space-y-2">
            <div>
              Discarding only forgets it on this device. If it already went through it stays sent — look under
              Transfers out first. Typing it in again would be a second transfer.
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={discardPending}
                      className="min-h-[44px] px-3 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-semibold">Discard</button>
              <button type="button" onClick={() => setDiscardAsk(false)}
                      className="min-h-[44px] px-3 rounded-lg border border-[#D4B896] bg-white text-sm text-[#6B5744]">Keep it</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  /* ── render ─────────────────────────────────────────────────────────── */

  if (meLoaded && !me) {
    return <div className="p-6 text-sm text-[#6B5744]">Sign in to use department transfers.</div>;
  }

  const shownList = tab === 'in' ? inList : outList;
  const openIn = inList.filter(t => t.dispute_status === 'open').length;
  const openOut = outList.filter(t => t.dispute_status === 'open').length;
  const trayVisible = canSendView && (tray.length > 0) && !(pending && pending.body.from_department_id !== viewId);

  return (
    <div className={`p-4 sm:p-6 max-w-6xl mx-auto space-y-4 ${trayVisible ? 'pb-80' : ''}`}>
      {/* Header */}
      <div className="flex flex-nowrap items-center gap-3">
        <SendHorizontal className="w-7 h-7 shrink-0 text-[#af4408]" />
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Department Transfers</h1>
          <p className="text-xs text-[#6B5744]">
            Hand stock from one department to another — e.g. Kitchen → Akan Tandoori. It moves the moment you send it:
            off the sender&apos;s books, onto the receiver&apos;s. If it doesn&apos;t arrive, the receiver flags it. The central store is never touched.
          </p>
        </div>
      </div>

      {/* The unconfirmed send — never "nothing was sent". In the tray when the
          tray is on screen, otherwise here (a reload, another department). */}
      {pending && pendingPhase !== 'inflight' && !trayVisible && pendingPanel(pending)}

      {flash && (
        <div className="flex flex-nowrap items-start gap-2 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl px-4 py-3 text-sm">
          <CircleCheck className="w-5 h-5 shrink-0 mt-0.5" />
          <span className="flex-1 min-w-0 break-words">{flash}</span>
          <button type="button" onClick={() => setFlash(null)} className="p-1" aria-label="Dismiss"><X className="w-4 h-4" /></button>
        </div>
      )}
      {topError && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{topError}</div>
      )}

      {/* Department in view */}
      {deptsLoaded && viewable.length === 0 && !topError && (
        <div className="flex flex-nowrap items-start gap-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl px-4 py-3 text-sm text-[#6B5744]">
          <Info className="w-4 h-4 shrink-0 mt-0.5 text-[#8B7355]" />
          <span>You are not posted to a department, so there are no transfers to show. Ask a manager to set your department.</span>
        </div>
      )}
      {viewable.length > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="flex flex-nowrap items-center gap-2 min-w-0 flex-1">
            <Building2 className="w-5 h-5 shrink-0 text-[#8B7355]" />
            {viewable.length > 1 ? (
              <label className="relative flex-1 min-w-0 sm:max-w-md">
                <span className="sr-only">Department</span>
                <select value={viewId} onChange={e => setViewId(e.target.value)}
                        disabled={!!pending && pendingPhase === 'inflight'}
                        className="w-full appearance-none pl-3 pr-9 py-2.5 border border-[#D4B896] rounded-lg bg-white text-base font-semibold text-[#2D1B0E] disabled:opacity-60">
                  {/* Only the departments this person may SEND from are offered as senders. */}
                  {sendable.length > 0 && (
                    <optgroup label="Send from / see">
                      {sendable.map(d => <option key={d.id} value={d.id}>{label(d)}{d.is_mine ? ' — mine' : ''}</option>)}
                    </optgroup>
                  )}
                  {viewable.some(d => !d.can_send) && (
                    <optgroup label="See only">
                      {viewable.filter(d => !d.can_send).map(d => <option key={d.id} value={d.id}>{label(d)}{d.is_mine ? ' — mine' : ''}</option>)}
                    </optgroup>
                  )}
                </select>
                <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-[#8B7355] pointer-events-none" />
              </label>
            ) : (
              <div className="text-base font-semibold text-[#2D1B0E] break-words">{label(viewDept)}</div>
            )}
          </div>
          {viewDept && !canSendView && sendable.length > 0 && (
            <button type="button" onClick={() => setViewId(sendable[0].id)}
                    className="min-h-[44px] text-sm text-[#af4408] underline decoration-dotted text-left">
              To send, switch to {clean(sendable[0].name)}
            </button>
          )}
        </div>
      )}

      {/* ── Needs you: open disputes this person can settle ── */}
      {needsMe.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">
            <ShieldAlert className="w-4 h-4 text-amber-600" />
            Disputes for you to settle
            <span className="px-1.5 py-0.5 rounded-full bg-amber-600 text-white text-[10px]">{needsMe.length}</span>
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {needsMe.map(t => docCard(t, 'attention'))}
          </div>
        </section>
      )}

      {viewDept && (
        <div className={`grid grid-cols-1 ${canSendView ? 'lg:grid-cols-5' : ''} gap-4 items-start`}>
          {/* ── LEFT: send ── */}
          {canSendView && (
            <section className="lg:col-span-3 space-y-3">
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4 space-y-2.5">
                <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">
                  Send from <span className="font-semibold text-[#2D1B0E] normal-case text-xs">{label(viewDept)}</span> to
                </div>
                {holdLoading && receivers.length === 0 ? (
                  <div className="text-xs text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Loading departments…</div>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {primary.map(r => recvChip(r, toId, setToId, locked))}
                    </div>
                    {others.length > 0 && (
                      <div>
                        <button type="button" onClick={() => setShowOthers(v => !v)}
                                className="min-h-[44px] text-sm text-[#af4408] underline decoration-dotted px-1">
                          {showOthers ? 'Hide other departments' : `Other departments (${others.length})`}
                        </button>
                        {(showOthers || (!!toId && others.some(r => r.id === toId))) && (
                          <div className="flex flex-wrap gap-2 mt-1.5">
                            {others.map(r => recvChip(r, toId, setToId, locked))}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
                {toRecv && !toRecv.usage_booked_here && (
                  <div className="flex flex-nowrap items-start gap-2 text-[11px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2">
                    <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#8B7355]" />
                    <span>
                      No till station books cooking to <strong>{clean(toRecv.name)}</strong>, so sales never take this stock off its
                      books — only a count, wastage or another transfer does.
                    </span>
                  </div>
                )}
              </div>

              <div className="flex flex-nowrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                  <Boxes className="w-4 h-4 text-[#af4408]" />
                  {clean(viewDept.name)} can send
                </h2>
                {holdings.length > 0 && (
                  <span className="text-[10px] text-[#8B7355]">{holdings.filter(h => h.transferable > EPS).length} of {holdings.length} items</span>
                )}
              </div>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search items…" inputMode="search"
                       className="w-full pl-9 pr-3 py-2.5 border border-[#E8D5C4] rounded-lg bg-white text-base" />
              </div>
              {categories.length > 1 && (
                <TabScroller className="gap-1.5 text-xs">
                  {['', ...categories].map(c => (
                    <button key={c || '__all__'} type="button" onClick={() => setCategory(c)}
                            className={`min-h-[44px] px-3.5 rounded-lg ${category === c
                              ? 'bg-[#af4408] text-white' : 'bg-white border border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'}`}>
                      {c || 'All'}
                    </button>
                  ))}
                </TabScroller>
              )}
              {holdError && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{holdError}</div>}

              {holdLoading && holdings.length === 0 ? (
                <div className="p-8 text-center text-[#8B7355] text-sm"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
              ) : !holdError && holdings.length === 0 ? (
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
                  <Boxes className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  {clean(viewDept.name)} holds nothing on its own ledger.
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
                        <button type="button" onClick={() => !nothing && openRow(h)} disabled={nothing || locked} aria-expanded={open}
                                className="w-full min-h-[60px] px-3 py-2.5 flex flex-nowrap items-center justify-between gap-3 text-left disabled:cursor-default">
                          <div className="min-w-0">
                            <div className={`text-sm font-semibold break-words ${nothing ? 'text-[#B8A590]' : 'text-[#2D1B0E]'}`}>{h.name}</div>
                            <div className="text-[10px] text-[#8B7355] flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                              <span>{h.category || '—'}</span>
                              {h.upper_bound
                                ? chip('bg-amber-100 text-amber-800', 'not counted · up to', h.basis_label)
                                : chip('bg-emerald-50 text-emerald-700', 'counted', h.basis_label)}
                              {inTray && chip('bg-[#af4408] text-white normal-case', `in tray: ${fmtQtyNum(Number(inTray.qty))} ${puOf(m)}`)}
                            </div>
                            {negative && (
                              <div className="text-[10px] text-red-700 mt-0.5">
                                Ledger shows {showPU(m, h.available)} {puOf(m)} — more has left than arrived. Count it on the Dept Closing Sheet.
                              </div>
                            )}
                          </div>
                          <div className="shrink-0 text-right">
                            {h.upper_bound && !nothing && <div className="text-[9px] text-amber-800 uppercase">up to</div>}
                            <div className={`text-lg font-bold tabular-nums ${nothing ? 'text-[#B8A590]' : h.upper_bound ? 'text-amber-800' : 'text-[#2D1B0E]'}`}>
                              {showPU(m, h.transferable, h.transferable_purchase)} <span className="text-xs font-medium text-[#8B7355]">{puOf(m)}</span>
                            </div>
                            {recipeHint(m, h.transferable) && <div className="text-[9px] text-[#B8A590]">{recipeHint(m, h.transferable)}</div>}
                            {nothing && <div className="text-[9px] text-[#8B7355]">nothing to send</div>}
                          </div>
                        </button>
                        {open && (
                          <div className="px-3 pb-3 space-y-2">
                            {h.basis_label && (
                              <div className={`text-[11px] rounded px-2 py-1.5 border ${h.upper_bound
                                ? 'text-amber-900 bg-amber-50 border-amber-200' : 'text-[#6B5744] bg-white border-[#E8D5C4]'}`}>
                                {h.basis_label}
                              </div>
                            )}
                            <div className="flex flex-nowrap items-stretch gap-2">
                              <div className="relative flex-1 min-w-0">
                                {/* autoFocus inside the tap's own commit, so iOS / Android raise the number pad. */}
                                <input autoFocus type="number" inputMode="decimal" step="any" min="0" value={draft}
                                       onChange={e => setDraft(e.target.value.replace(/^-+/, ''))}
                                       onKeyDown={e => { if (e.key === 'Enter') addToTray(h); }}
                                       placeholder={`Qty in ${puOf(m)}`} aria-label={`Quantity of ${h.name} in ${puOf(m)}`}
                                       className={`w-full pl-3 pr-14 py-3 border rounded-lg bg-white text-lg font-mono ${draftErr ? 'border-red-400' : 'border-[#D4B896]'}`} />
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[#8B7355] pointer-events-none">{puOf(m)}</span>
                              </div>
                              <button type="button" onClick={() => setDraft(String(h.transferable_purchase))}
                                      className="px-3 rounded-lg border border-[#D4B896] bg-white text-sm text-[#6B5744] hover:border-[#af4408]">All</button>
                              <button type="button" onClick={() => addToTray(h)} disabled={draftQ == null || !!draftErr}
                                      className="px-4 min-h-[52px] rounded-lg bg-[#af4408] text-white text-sm font-semibold flex items-center gap-1 disabled:opacity-40">
                                <Plus className="w-4 h-4" /> {inTray ? 'Update' : 'Add'}
                              </button>
                            </div>
                            {draftErr ? (
                              <div className="text-[11px] text-red-700">{draftErr}</div>
                            ) : draftQ != null && packFactor(m) > 1 && (
                              <div className="text-[10px] text-[#B8A590]">= {fmtQtyNum(draftQ * packFactor(m))} {m.unit}</div>
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

          {/* ── RIGHT: transfers in / out of the department in view ── */}
          <section className={`${canSendView ? 'lg:col-span-2' : ''} space-y-2`}>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <TabScroller className="gap-1.5 text-sm">
                {([['in', 'Transfers in', inList.length, openIn], ['out', 'Transfers out', outList.length, openOut]] as const).map(([k, l, n, o]) => (
                  <button key={k} type="button" onClick={() => setTab(k)}
                          className={`min-h-[44px] px-3.5 rounded-lg font-semibold flex items-center gap-1.5 ${tab === k
                            ? 'bg-[#af4408] text-white' : 'bg-white border border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'}`}>
                    {l}
                    <span className={`text-[10px] font-normal ${tab === k ? 'text-white/80' : 'text-[#8B7355]'}`}>{n}</span>
                    {o > 0 && <span className="px-1.5 rounded-full bg-amber-500 text-white text-[10px]">{o} disputed</span>}
                  </button>
                ))}
              </TabScroller>
              <button type="button" onClick={() => refreshAll()} aria-label="Refresh"
                      className="h-11 w-11 rounded-lg border border-[#E8D5C4] bg-white text-[#8B7355] flex items-center justify-center">
                <RefreshCw className={`w-4 h-4 ${listLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {listErr && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{listErr}</div>}
            {shownList.length === 0 ? !listErr && (
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center text-xs text-[#8B7355]">
                <Inbox className="w-6 h-6 mx-auto mb-1.5 opacity-50" />
                {listLoading ? 'Loading…' : tab === 'in'
                  ? `Nothing has been sent to ${clean(viewDept.name)} yet.`
                  : `${clean(viewDept.name)} has not sent anything yet.`}
              </div>
            ) : (
              <div className="space-y-2">{shownList.map(t => docCard(t, tab))}</div>
            )}
          </section>
        </div>
      )}

      <p className="text-[10px] text-[#8B7355] leading-relaxed">
        Quantities are in <strong>purchase units</strong> (kg / L / BTL); the small grey line is the same figure in recipe
        units. A transfer moves the stock in one step — off the sender&apos;s books and onto the receiver&apos;s, never through
        the central store, never counted twice. If it did not arrive as sent, the receiver <strong>flags a dispute</strong>:
        that records it and tells the sender, and moves nothing. The correction is a <strong>send-back</strong>, one tap from
        the disputed transfer. <strong>Not counted · up to</strong> means the sender never counted that item, so the figure is
        its ledger (everything received minus everything used or sent) — a count on the Dept Closing Sheet firms it up.
      </p>

      {/* ── Tray: pinned to the bottom of the screen, one Send for everything ── */}
      {trayVisible && (
        <div className="fixed inset-x-0 bottom-0 z-30 lg:left-auto lg:right-4 lg:bottom-4 lg:w-[440px]">
          <div className="bg-white border-t-2 lg:border-2 border-[#af4408] lg:rounded-xl shadow-2xl p-3 space-y-2 max-h-[70vh] overflow-y-auto">
            <div className="flex flex-nowrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-[#2D1B0E]">
                To send · {tray.length} item{tray.length === 1 ? '' : 's'}
              </div>
              {!locked && (
                <button type="button" onClick={() => { setTray([]); setSendError(null); }} className="text-[11px] text-[#8B7355] underline decoration-dotted p-1">
                  clear
                </button>
              )}
            </div>
            <div className="divide-y divide-[#E8D5C4]/60">
              {tray.map((t, i) => {
                const h = holdingById.get(t.material_id);
                const m = h ? metaOf(h) : null;
                const q = Number(t.qty);
                const flagged = !!sendError?.materialId && sendError.materialId === t.material_id;
                return (
                  <div key={t.material_id} className={`flex flex-nowrap items-center justify-between gap-2 py-1.5 ${flagged ? 'bg-red-50' : ''}`}>
                    <button type="button" onClick={() => h && openRow(h)} disabled={locked} className="min-w-0 text-left">
                      <div className="text-xs font-medium text-[#2D1B0E] break-words">{h?.name || t.material_id}</div>
                      {trayProblems[i] && <div className="text-[10px] text-red-700">{trayProblems[i]}</div>}
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      {m && (
                        <span className="text-right font-mono text-sm">
                          {fmtQtyNum(q)} <span className="text-[#8B7355] text-xs">{puOf(m)}</span>
                          {packFactor(m) > 1 && <span className="block text-[9px] text-[#B8A590]">= {fmtQtyNum(q * packFactor(m))} {m.unit}</span>}
                        </span>
                      )}
                      {!locked && (
                        <button type="button" onClick={() => { setTray(x => x.filter(y => y.material_id !== t.material_id)); setSendError(null); }}
                                className="p-2.5 text-red-600" aria-label={`Remove ${h?.name || 'item'} from the tray`}>
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <input value={note} onChange={e => setNote(e.target.value)} maxLength={200} disabled={locked}
                   placeholder="Note (optional — e.g. for tonight's tandoor prep)"
                   className="w-full px-3 py-2 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-base disabled:opacity-60" />
            {sendError && (
              <div className="flex flex-nowrap items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{sendError.msg}</span>
              </div>
            )}
            {pending && pendingPhase !== 'inflight' ? pendingPanel(pending) : (
            <button type="button" onClick={send} disabled={!canSend}
                    className="w-full min-h-[56px] rounded-lg bg-[#af4408] hover:bg-[#8f3806] text-white text-base font-semibold flex flex-nowrap items-center justify-center gap-2 disabled:opacity-40">
              {pending && pendingPhase === 'inflight' ? <Loader2 className="w-5 h-5 animate-spin" /> : <SendHorizontal className="w-5 h-5" />}
              {pending ? 'Sending…'
                : !toId ? 'Pick a receiving department above'
                : `Send to ${clean(toRecv?.name || byId.get(toId)?.name || '')}`}
            </button>
            )}
            {!pending && toId && (
              <div className="text-[10px] text-[#8B7355] text-center">
                Moves now: off {clean(viewDept?.name || '')}&apos;s books, onto {clean(toRecv?.name || '')}&apos;s.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** One receiver button — big tap target, parent named, requisition weight shown. */
function recvChip(r: Receiver, toId: string, setToId: (v: string) => void, locked: boolean) {
  const on = r.id === toId;
  return (
    <button key={r.id} type="button" disabled={locked} onClick={() => setToId(on ? '' : r.id)}
            className={`min-h-[48px] px-3 py-2 rounded-lg border text-sm text-left disabled:opacity-60 ${on
              ? 'bg-[#af4408] border-[#af4408] text-white font-semibold'
              : 'bg-white border-[#E8D5C4] text-[#2D1B0E] hover:border-[#af4408]'}`}>
      {clean(r.name)}
      <span className={`block text-[10px] ${on ? 'text-white/80' : 'text-[#8B7355]'}`}>
        {r.parent_id && r.parent_name ? `under ${clean(r.parent_name)}` : 'department'}
        {r.requisition_count > 0 ? ` · ${r.requisition_count} req. line${r.requisition_count === 1 ? '' : 's'}` : ''}
      </span>
    </button>
  );
}
