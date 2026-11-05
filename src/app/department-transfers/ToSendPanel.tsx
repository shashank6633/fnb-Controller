'use client';

/**
 * "TO SEND" — the requisition lines a department must hand over itself
 * (rulings #45 and #74).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Direct Issue sends Meat / Poultry / Seafood deliveries straight to Kitchen,
 * so the central store never holds them. After the HOD (and management, where
 * Settings require it for party requisitions) approves, any other department's
 * requisition line for those items comes HERE — to the department the rule
 * routes them to — not to the store desk. Send hands it over from that
 * department's own books at once, as one department transfer, and FULFILS the
 * line. Party lines work the same way and stay costed on that party's P&L.
 *
 * THIS PANEL DECIDES NOTHING. The queue, what is owed, what the department can
 * send (`sendable_*`, an UPPER BOUND when it never counted the item), the most
 * one Send may move (`max_send_*`), why a line cannot be sent (`blocked`) and
 * every sentence on it are the server's
 * (GET /api/department-transfers/to-send). Every refusal is printed VERBATIM;
 * the client-side quantity check only saves a round trip.
 *
 * UNITS (owner rule). Every figure READS and is TYPED in the PURCHASE unit; the
 * recipe figure is only the small "= 1,000 g" hint. A typed figure is POSTed as
 * typed (`quantity_purchase`) and the server converts once; the untouched
 * prefill of the whole owed balance is posted as `send_all_owed` so it moves
 * the owed figure exactly, never a 3-dp round trip of it.
 *
 * A LOST REPLY IS NOT "NOTHING WAS SENT" (as the main tray, ./send-safety.ts).
 * Each Send carries a client_key minted for that gesture. With no proof either
 * way the requisition LOCKS, says the send may already have gone through, and
 * offers only the same-key retry — the server answers it with the transfer the
 * key already made, or makes it once — or an explicit discard. The unconfirmed
 * send is remembered on this device so a reload finds it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SendHorizontal, Loader2, AlertTriangle, Info, RefreshCw, ShieldAlert, CircleCheck, ClipboardList,
} from 'lucide-react';
import { api } from '@/lib/api';
import { fmtQtyNum } from '@/lib/pack-units';
import { fmtISTShort, fmtISTDate } from '@/lib/format-date';
import { mintClientKey, classifySend, CLIENT_KEY_RE } from './send-safety';

/* ── Wire shapes (GET / POST /api/department-transfers/to-send) ─────────── */

export interface TsSend {
  transfer_id: string; transfer_no: string; transfer_line_id: string;
  at: string; by: string;
  sent_purchase: number; net_purchase: number;
  dispute_status: string; open_disputed_purchase: number;
}
export interface TsBlocked { code: string; message: string }
export interface TsLine {
  req_item_id: string; material_id: string; material_name: string; material_category: string;
  line_unit: string; purchase_unit: string; recipe_unit: string; pack_factor: number;
  approved_line: number; sent_line: number; owed_line: number;
  approved_purchase: number; sent_purchase: number; owed_purchase: number; owed_recipe: number;
  /** False when the server could not read the line's unit (it sends no
   *  purchase figures then, and blocks the line 'unit_review'): print none. */
  figures_known: boolean;
  sendable_recipe: number; sendable_purchase: number; sendable_upper_bound: boolean; sendable_basis: string;
  max_send_purchase: number; max_send_recipe: number;
  can_send: boolean; blocked: TsBlocked | null;
  sends: TsSend[];
  expect_sent_line: number | null;
}
export interface TsGroup {
  key: string;
  requisition_id: string; req_number: string; req_date: string; req_status: string;
  purpose: string; event_name: string; event_date: string; fp_id: string; party_unique_id: string;
  to_department_id: string; to_department_name: string; to_department_active: boolean;
  lines: TsLine[];
}
export interface TsQueue {
  department: { id: string; name: string; is_active: boolean; can_send: boolean; can_view: boolean };
  rules: Array<{ rule_id: string; via: string; label: string }>;
  explain: string[];
  groups: TsGroup[];
  totals: { groups: number; lines: number; party_groups: number };
}
export interface PostLine { req_item_id: string; quantity_purchase?: number; send_all_owed?: true; expect_sent_line?: number }
export interface PostBody {
  from_department_id: string; requisition_id: string; to_department_id: string;
  client_key: string; note?: string; lines: PostLine[];
}
/** A Send that left this device and whose outcome is not yet known. */
interface PendingToSend {
  v: 1;
  group: string;
  body: PostBody;
  req_number: string;
  to_name: string;
  items: Array<{ name: string; qty: string; pu: string }>;
  at: string;
}

/** What the page shows on its tab: whether the tab belongs here, and how much is owed. */
export interface ToSendSummary {
  /** The department these figures are about (the page ignores another's). */
  deptId: string;
  loaded: boolean;
  /** The department has a Direct Issue rule, or something is queued for it. */
  relevant: boolean;
  groups: number;
  lines: number;
  /** The queue could not be read (an older server, a network error). */
  error: string | null;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown) => v === true || v === 1 || v === '1';
const clean = (s: unknown) => str(s).replace(/\s+/g, ' ').trim();
const EPS = 1e-9;
const POST_TIMEOUT_MS = 30_000;
const who = (email: string) => str(email).split('@')[0] || '—';
/** A purchase figure as an input value: plain digits, no grouping, ≤ 6 dp. */
const plain = (v: number) => {
  const r = Math.round((Number(v) || 0) * 1e6) / 1e6;
  return r > 0 ? String(r) : '';
};
const parseQty = (raw: string): number | null => {
  const s = str(raw).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const puOf = (l: TsLine) => l.purchase_unit || l.recipe_unit || l.line_unit;
/** "= 1,000 g" — only when the item really converts. */
const recipeHint = (l: TsLine, purchaseQty: number) =>
  l.pack_factor > 1 && purchaseQty > EPS && l.recipe_unit
    ? `= ${fmtQtyNum(purchaseQty * l.pack_factor)} ${l.recipe_unit}` : null;

function normLine(x: any): TsLine {
  const b = x?.blocked && typeof x.blocked === 'object'
    ? { code: str(x.blocked.code), message: str(x.blocked.message) } : null;
  return {
    req_item_id: str(x?.req_item_id), material_id: str(x?.material_id),
    material_name: clean(x?.material_name), material_category: clean(x?.material_category),
    line_unit: str(x?.line_unit), purchase_unit: str(x?.purchase_unit), recipe_unit: str(x?.recipe_unit),
    pack_factor: num(x?.pack_factor) > 0 ? num(x?.pack_factor) : 1,
    approved_line: num(x?.approved_line), sent_line: num(x?.sent_line), owed_line: num(x?.owed_line),
    approved_purchase: num(x?.approved_purchase), sent_purchase: num(x?.sent_purchase),
    owed_purchase: num(x?.owed_purchase), owed_recipe: num(x?.owed_recipe),
    figures_known: x?.owed_purchase != null && x?.approved_purchase != null,
    sendable_recipe: num(x?.sendable_recipe), sendable_purchase: num(x?.sendable_purchase),
    sendable_upper_bound: bool(x?.sendable_upper_bound), sendable_basis: str(x?.sendable_basis),
    max_send_purchase: num(x?.max_send_purchase), max_send_recipe: num(x?.max_send_recipe),
    can_send: bool(x?.can_send), blocked: b && (b.code || b.message) ? b : null,
    sends: (Array.isArray(x?.sends) ? x.sends : []).map((s: any) => ({
      transfer_id: str(s?.transfer_id), transfer_no: str(s?.transfer_no), transfer_line_id: str(s?.transfer_line_id),
      at: str(s?.at), by: str(s?.by),
      sent_purchase: num(s?.sent_purchase), net_purchase: num(s?.net_purchase ?? s?.sent_purchase),
      dispute_status: str(s?.dispute_status), open_disputed_purchase: num(s?.open_disputed_purchase),
    })),
    expect_sent_line: numOrNull(x?.expect_sent_line),
  };
}
/** The GET payload, read defensively (an older or partial reply never throws). */
export function normQueue(j: any): TsQueue {
  const d = j?.department || {};
  return {
    department: {
      id: str(d.id), name: clean(d.name), is_active: d.is_active == null ? true : bool(d.is_active),
      can_send: bool(d.can_send), can_view: d.can_view == null ? true : bool(d.can_view),
    },
    rules: (Array.isArray(j?.rules) ? j.rules : []).map((r: any) => ({ rule_id: str(r?.rule_id), via: str(r?.via), label: clean(r?.label) }))
      .filter((r: { label: string }) => !!r.label),
    explain: (Array.isArray(j?.explain) ? j.explain : []).map((s: unknown) => str(s).trim()).filter(Boolean),
    groups: (Array.isArray(j?.groups) ? j.groups : []).map((g: any) => ({
      key: str(g?.key) || `${str(g?.requisition_id)}:${str(g?.to_department_id)}`,
      requisition_id: str(g?.requisition_id), req_number: str(g?.req_number), req_date: str(g?.req_date),
      req_status: str(g?.req_status), purpose: str(g?.purpose), event_name: clean(g?.event_name),
      event_date: str(g?.event_date), fp_id: str(g?.fp_id), party_unique_id: str(g?.party_unique_id),
      to_department_id: str(g?.to_department_id), to_department_name: clean(g?.to_department_name),
      to_department_active: g?.to_department_active == null ? true : bool(g?.to_department_active),
      lines: (Array.isArray(g?.lines) ? g.lines : []).map(normLine).filter((l: TsLine) => !!l.req_item_id),
    })).filter((g: TsGroup) => !!g.requisition_id && g.lines.length > 0),
    totals: { groups: num(j?.totals?.groups), lines: num(j?.totals?.lines), party_groups: num(j?.totals?.party_groups) },
  };
}

async function readJson(r: Response): Promise<any> { try { return await r.json(); } catch { return null; } }
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

/* Per-person, per-device memory of an unconfirmed Send (a kitchen tablet is
 * shared). A convenience: the server's key check is the guard, and storage
 * failing just means no memory. */
const pendingKey = (userId: string) => `fnb.dept-transfers.to-send.pending.v1:${userId || 'anon'}`;
function readPendings(userId: string): PendingToSend[] {
  try {
    const raw = window.localStorage.getItem(pendingKey(userId));
    if (!raw) return [];
    const v = JSON.parse(raw);
    return (Array.isArray(v) ? v : []).filter((p: any) => p && p.v === 1 && p.body
      && CLIENT_KEY_RE.test(str(p.body.client_key)) && Array.isArray(p.body.lines) && p.body.lines.length > 0);
  } catch { return []; }
}
function writePendings(userId: string, list: PendingToSend[]) {
  try {
    if (list.length === 0) window.localStorage.removeItem(pendingKey(userId));
    else window.localStorage.setItem(pendingKey(userId), JSON.stringify(list));
  } catch { /* private mode */ }
}

const STATUS_WORD: Record<string, string> = {
  chef_approved: 'HOD approved', mgmt_approved: 'Mgmt approved', store_processed: 'In progress', fulfilled: 'Fulfilled',
};

/** What the box should start at: the most one Send may move now (the
 *  server's min(owed, held)), as plain digits. */
export function toSendPrefill(l: TsLine): string { return plain(l.max_send_purchase); }

/** One line's figure (PURCHASE units, as shown in its box) against what is
 *  owed and what the sender holds — null when it may go. Saves a round trip
 *  only; the server decides. */
export function checkToSendLine(l: TsLine, reqNumber: string, senderName: string, shown: string): string | null {
  const q = parseQty(shown);
  if (q == null) return 'Enter a quantity above 0';
  const pu = puOf(l);
  if (q > l.owed_purchase + EPS) return `Only ${fmtQtyNum(l.owed_purchase)} ${pu} is still owed on ${reqNumber}`;
  if (q > l.sendable_purchase + EPS) {
    return `${l.sendable_upper_bound ? 'Up to' : 'Only'} ${fmtQtyNum(l.sendable_purchase)} ${pu} can be sent from ${senderName}`;
  }
  return null;
}

/** The POST line for what the box says. The whole owed balance, untouched or
 *  typed as shown, goes as send_all_owed — the server moves the exact owed
 *  figure, never a 3-dp round trip of it — but only when what the sender
 *  holds covers it; anything else goes as typed, in the purchase unit. */
export function toSendPostLine(l: TsLine, shown: string): PostLine {
  const q = parseQty(shown) as number;
  const all = Math.abs(q - l.owed_purchase) < EPS && l.max_send_purchase + EPS >= l.owed_purchase;
  const base: PostLine = all ? { req_item_id: l.req_item_id, send_all_owed: true } : { req_item_id: l.req_item_id, quantity_purchase: q };
  if (l.expect_sent_line != null) base.expect_sent_line = l.expect_sent_line;
  return base;
}

/* ── Panel ───────────────────────────────────────────────────────────────── */

export default function ToSendPanel(props: {
  /** The department in view — the one that SENDS. */
  deptId: string;
  deptName: string;
  me: { id: string; email: string } | null;
  /** Rendered (the tab is open). The queue loads either way, for the tab's count. */
  visible: boolean;
  /** Bumped by the page after anything that can change the queue (a send-back). */
  reloadKey: number;
  onSummary: (s: ToSendSummary) => void;
  /** A Send went through — the page flashes it and refreshes its own lists. */
  onSent: (message: string) => void;
  /** A GET payload already in hand for `deptId` — the first paint without a
   *  round trip (it is re-read at once all the same). */
  initial?: unknown;
}) {
  const { deptId, deptName, me, visible, reloadKey, onSummary, onSent } = props;
  // The queue, the error and the department they are ABOUT travel together, so
  // nothing read for one department is ever shown or counted under another.
  const [got, setGot] = useState<{ deptId: string; queue: TsQueue | null; error: string | null }>(() =>
    (props.initial ? { deptId, queue: normQueue(props.initial), error: null } : { deptId: '', queue: null, error: null }));
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const mine = got.deptId === deptId;
  const queue = mine ? got.queue : null;
  const error = mine ? got.error : null;

  const load = useCallback(async () => {
    const my = ++seq.current;
    if (!deptId) { setGot({ deptId: '', queue: null, error: null }); setLoading(false); return; }
    setLoading(true);
    let status = 0; let json: any = null;
    try {
      const r = await fetch(`/api/department-transfers/to-send?department_id=${encodeURIComponent(deptId)}`, { cache: 'no-store' });
      status = r.status; json = await readJson(r);
    } catch (e: any) {
      json = { error: `No connection to the server (${e?.message || 'network error'}). Check the Wi-Fi, then refresh.` };
    }
    if (my !== seq.current) return;                 // a newer department won
    setLoading(false);
    if (status >= 200 && status < 300 && json) {
      setGot({ deptId, queue: normQueue(json), error: null });
    } else {
      // A refresh that fails keeps the list it had — the figures on it were
      // true when read — and says why it could not refresh.
      setGot(p => ({
        deptId,
        queue: p.deptId === deptId ? p.queue : null,
        error: str(json?.error) || `Could not load the To send list (HTTP ${status || 'no reply'})`,
      }));
    }
  }, [deptId]);
  useEffect(() => { load(); }, [load, reloadKey]);
  // A kitchen tablet sits open all service: once a minute, only while on screen.
  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') load();
    }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const owedLines = useMemo(() => (queue?.groups || []).reduce((s, g) => s + g.lines.length, 0), [queue]);
  useEffect(() => {
    onSummary({
      deptId,
      loaded: mine && (!!queue || !!error),
      relevant: !!queue && (queue.rules.length > 0 || queue.groups.length > 0),
      groups: queue?.groups.length || 0,
      lines: owedLines,
      error,
    });
  }, [deptId, mine, queue, error, owedLines, onSummary]);

  /* typed figures — only what the person TYPED; the box otherwise shows the prefill */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errs, setErrs] = useState<Record<string, { msg: string; lineId: string | null }>>({});
  const [pendings, setPendings] = useState<PendingToSend[]>([]);
  const [discardAsk, setDiscardAsk] = useState<string | null>(null);
  useEffect(() => { setTyped({}); setNotes({}); setErrs({}); setDiscardAsk(null); }, [deptId]);
  useEffect(() => { if (me?.id) setPendings(readPendings(me.id)); }, [me?.id]);
  /** Every change to the unconfirmed sends goes through here, functionally, so
   *  two settles finishing in either order never resurrect or drop the other's. */
  const meId = me?.id || '';
  const updatePendings = useCallback((fn: (prev: PendingToSend[]) => PendingToSend[]) => {
    setPendings(prev => {
      const next = fn(prev);
      if (meId) writePendings(meId, next);
      return next;
    });
  }, [meId]);
  const setOne = <T,>(set: React.Dispatch<React.SetStateAction<Record<string, T>>>, k: string, v: NoInfer<T> | undefined) =>
    set(s => { const n = { ...s }; if (v === undefined) delete n[k]; else n[k] = v; return n; });

  const canSendDept = !!queue?.department.can_send;
  const D = clean(queue?.department.name || deptName) || 'this department';

  const shownQty = (l: TsLine) => (typed[l.req_item_id] ?? toSendPrefill(l));
  const checkLine = (l: TsLine, g: TsGroup) => checkToSendLine(l, g.req_number, D, shownQty(l));
  const sendableLine = (l: TsLine) => canSendDept && l.can_send && !l.blocked && l.figures_known && l.max_send_purchase > EPS;
  const postLine = (l: TsLine) => toSendPostLine(l, shownQty(l));

  const pendingFor = (gk: string) => pendings.find(p => p.group === gk && p.body.from_department_id === deptId) || null;

  /** POST one Send and settle it by what the reply PROVES. */
  const settle = async (g: { key: string }, p: PendingToSend) => {
    setOne(setBusy, g.key, true); setOne(setErrs, g.key, undefined);
    const { status, json } = await postJson('/api/department-transfers/to-send', p.body);
    setOne(setBusy, g.key, undefined);
    const out = classifySend(status, json);
    const dropMine = () => updatePendings(prev => prev.filter(x => x.body.client_key !== p.body.client_key));
    if (out.kind === 'sent') {
      dropMine();
      setDiscardAsk(null);
      setTyped(s => { const n = { ...s }; for (const l of p.body.lines) delete n[l.req_item_id]; return n; });
      setOne(setNotes, g.key, undefined);
      const t = out.transfer as any;
      // The server's own sentence names what moved, against which requisition,
      // what is still to send, and (party) what the store's part is waiting
      // on. Only a reply without it gets the page's own words, from the
      // transfer document it returned.
      const serverMsg = str(json?.message).trim();
      const pend = json?.party_store_part_pending;
      const pendMsg = pend && typeof pend === 'object' ? str(pend.message).trim() : '';
      const items = (Array.isArray(t?.lines) ? t.lines : []).map((l: any) =>
        `${fmtQtyNum(num(l.qty_sent_purchase ?? l.quantity_purchase))} ${str(l.purchase_unit || l.unit)} ${clean(l.material_name)}`).join(', ');
      const head = `${str(t?.transfer_no)} ${out.duplicate ? 'had already gone through — nothing was sent twice' : 'sent'}`;
      onSent(serverMsg
        || `${head}: ${items} moved from ${clean(t?.from_department_name) || D}'s books to ${clean(t?.to_department_name) || p.to_name}'s, against ${p.req_number}.${pendMsg ? ` ${pendMsg}` : ''}`);
      load();
      return;
    }
    if (out.kind === 'refused') {
      // A refusal wrote NOTHING (the server's key gate runs first and every
      // refusal rolls back), so the requisition unlocks for the cook to fix.
      dropMine();
      setDiscardAsk(null);
      const code = str(json?.code || json?.reason);
      const lineId = str(json?.req_item_id) || null;
      setOne(setErrs, g.key, {
        msg: code === 'idempotency_conflict' ? `${out.error} Look under Transfers out before sending again.` : out.error,
        lineId,
      });
      if (out.status === 409 || out.status === 404) load();
      return;
    }
    // No proof either way. Keep it, locked, until the same key settles it.
    updatePendings(prev => (prev.some(x => x.body.client_key === p.body.client_key) ? prev : [...prev, p]));
    setOne(setErrs, g.key, {
      msg: `${out.detail === 'no reply from the server' ? 'No answer from the server.' : `No clear answer (${out.detail}).`} `
        + 'It may already have gone through. Tap "Check & finish sending" — the same tap can never send it twice.',
      lineId: null,
    });
  };

  const send = (g: TsGroup, lines: TsLine[]) => {
    if (!me || !canSendDept || lines.length === 0 || busy[g.key] || pendingFor(g.key)) return;
    const bad = lines.map(l => ({ l, why: checkLine(l, g) })).find(x => x.why);
    if (bad) { setOne(setErrs, g.key, { msg: `${bad.l.material_name}: ${bad.why}`, lineId: bad.l.req_item_id }); return; }
    const note = str(notes[g.key]).trim();
    const body: PostBody = {
      from_department_id: deptId,
      requisition_id: g.requisition_id,
      to_department_id: g.to_department_id,
      client_key: mintClientKey('ts'),
      ...(note ? { note } : {}),
      lines: lines.map(postLine),
    };
    const p: PendingToSend = {
      v: 1, group: g.key, body, req_number: g.req_number, to_name: g.to_department_name,
      items: lines.map(l => ({ name: l.material_name, qty: shownQty(l), pu: puOf(l) })),
      at: new Date().toISOString(),
    };
    // Remembered BEFORE it leaves: a reload mid-send must know it may be in flight.
    updatePendings(prev => [...prev.filter(x => x.group !== g.key || x.body.from_department_id !== deptId), p]);
    settle(g, p);
  };

  const discard = (gk: string) => {
    updatePendings(prev => prev.filter(x => !(x.group === gk && x.body.from_department_id === deptId)));
    setDiscardAsk(null);
    setOne(setErrs, gk, undefined);
    load();
  };

  if (!visible) return null;

  /* ── render ─────────────────────────────────────────────────────────── */

  const groups = queue?.groups || [];
  // An unconfirmed send whose requisition is no longer listed (it completed,
  // or the list could not load): shown on its own so it is never lost.
  const orphanPendings = pendings.filter(p => p.body.from_department_id === deptId && !groups.some(g => g.key === p.group));

  const pendingPanel = (gk: string, p: PendingToSend) => (
    <div className="bg-amber-50 border-2 border-amber-400 rounded-xl p-3 space-y-2">
      <div className="flex flex-nowrap items-start gap-2">
        <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5 text-amber-700" />
        <div className="min-w-0 text-sm text-amber-950">
          <div className="font-semibold">{busy[gk] ? 'Checking this send…' : 'Not confirmed — do not send this again'}</div>
          <div className="text-xs mt-0.5 break-words">
            {p.req_number} · {D} → {p.to_name || 'receiver'}: {p.items.map(i => `${i.qty} ${i.pu} ${i.name}`).join(', ')}
            {p.at ? ` · first sent ${fmtISTShort(p.at)}` : ''}
          </div>
          <div className="text-[11px] mt-1 text-amber-900">
            Finishing it is safe: the server recognises this exact send, so if it already went through nothing is sent twice.
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!!busy[gk]} onClick={() => settle({ key: gk }, p)}
                className="min-h-[52px] px-4 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-base font-semibold flex flex-nowrap items-center gap-2 disabled:opacity-40">
          {busy[gk] ? <Loader2 className="w-5 h-5 animate-spin" /> : <RefreshCw className="w-5 h-5" />}
          Check &amp; finish sending
        </button>
        {discardAsk !== gk ? (
          <button type="button" disabled={!!busy[gk]} onClick={() => setDiscardAsk(gk)}
                  className="min-h-[52px] px-3 rounded-lg border border-amber-400 bg-white text-sm text-amber-900 disabled:opacity-40">
            Discard…
          </button>
        ) : (
          <div className="w-full text-xs text-amber-950 bg-white border border-amber-300 rounded-lg p-2 space-y-2">
            <div>
              Discarding only forgets it on this device. If it already went through it stays sent — look under Transfers
              out first. Sending it again would be a second transfer.
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => discard(gk)}
                      className="min-h-[44px] px-3 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-semibold">Discard</button>
              <button type="button" onClick={() => setDiscardAsk(null)}
                      className="min-h-[44px] px-3 rounded-lg border border-[#D4B896] bg-white text-sm text-[#6B5744]">Keep it</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const explainBox = queue && (queue.explain.length > 0 || queue.rules.length > 0) && (
    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl px-3 py-2.5 text-[11px] text-[#6B5744] space-y-1.5">
      {queue.rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold text-[#2D1B0E]">Direct Issue routes to {D}:</span>
          {queue.rules.map(r => (
            <span key={r.rule_id || r.label} className="px-1.5 py-0.5 rounded bg-white border border-[#E8D5C4] text-[#2D1B0E]">
              {r.label}{r.via ? <span className="text-[#8B7355]"> · {r.via === 'material' ? 'item' : r.via}</span> : null}
            </span>
          ))}
        </div>
      )}
      {queue.explain.length > 0 && (
        <ul className="list-disc pl-4 space-y-0.5">
          {queue.explain.map((s, i) => <li key={i} className="break-words">{s}</li>)}
        </ul>
      )}
    </div>
  );

  return (
    <section className="space-y-3" aria-label={`Requisition lines for ${D} to send`}>
      <div className="flex flex-nowrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5 min-w-0">
          <ClipboardList className="w-4 h-4 shrink-0 text-[#af4408]" />
          <span className="break-words">Requisition lines for {D} to send</span>
          {owedLines > 0 && <span className="px-1.5 py-0.5 rounded-full bg-[#af4408] text-white text-[10px] shrink-0">{owedLines}</span>}
        </h2>
        <button type="button" onClick={() => load()} aria-label="Refresh the To send list"
                className="h-11 w-11 shrink-0 rounded-lg border border-[#E8D5C4] bg-white text-[#8B7355] flex items-center justify-center">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 break-words">{error}</div>}

      {queue && !canSendDept && groups.length > 0 && (
        <div className="flex flex-nowrap items-start gap-2 text-xs text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2">
          <Info className="w-4 h-4 shrink-0 mt-0.5 text-[#8B7355]" />
          <span>You can see what {D} still has to send, but you cannot send from {D}.</span>
        </div>
      )}

      {orphanPendings.map(p => <div key={p.body.client_key}>{pendingPanel(p.group, p)}</div>)}

      {loading && !queue && !error ? (
        <div className="p-8 text-center text-[#8B7355] text-sm"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
      ) : queue && groups.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center text-sm text-[#8B7355]">
          <CircleCheck className="w-7 h-7 mx-auto mb-1.5 opacity-60" />
          {queue.rules.length > 0
            ? <>Nothing for {D} to send right now — no approved requisition is waiting on it.</>
            : <>No Direct Issue rule routes anything to {D}, so no requisition lines come here.</>}
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
          {groups.map(g => {
            const pend = pendingFor(g.key);
            const isBusy = !!busy[g.key];
            const err = errs[g.key];
            const ready = g.lines.filter(sendableLine);
            const allProblems = ready.map(l => checkLine(l, g)).filter(Boolean);
            const isParty = g.purpose === 'party';
            return (
              <div key={g.key} className={`bg-white border rounded-xl p-3 space-y-2.5 ${pend ? 'border-amber-400' : 'border-[#E8D5C4]'}`}>
                <div className="flex flex-nowrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#2D1B0E] flex flex-wrap items-center gap-1.5">
                      <span className="font-mono">{g.req_number}</span>
                      {isParty
                        ? <span className="text-[9px] px-1.5 py-0.5 rounded bg-pink-100 text-pink-800 border border-pink-200 font-semibold">PARTY</span>
                        : <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#FFF1E3] text-[#6B5744] border border-[#D4B896] font-semibold">INTERNAL</span>}
                    </div>
                    <div className="text-xs text-[#6B5744] break-words">
                      for <b className="text-[#2D1B0E]">{g.to_department_name || 'the asking department'}</b>
                      {g.req_date ? <> · raised {fmtISTDate(g.req_date)}</> : null}
                    </div>
                    {isParty && (g.event_name || g.event_date) && (
                      <div className="text-[11px] text-pink-800 break-words">
                        Party{g.event_name ? <>: <b>{g.event_name}</b></> : null}{g.event_date ? <> · {g.event_date}</> : null}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-[#E8D5C4] bg-[#FFF8F0] text-[#6B5744]">
                    {STATUS_WORD[g.req_status] || g.req_status}
                  </span>
                </div>
                {!g.to_department_active && (
                  <div className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                    {g.to_department_name || 'The asking department'} is switched off in Settings, so nothing can be sent to it.
                  </div>
                )}

                {pend && pendingPanel(g.key, pend)}

                <div className="divide-y divide-[#E8D5C4]/60">
                  {g.lines.map(l => {
                    const pu = puOf(l);
                    const canThis = sendableLine(l);
                    const problem = canThis ? checkLine(l, g) : null;
                    const q = parseQty(shownQty(l));
                    const flagged = err?.lineId === l.req_item_id;
                    return (
                      <div key={l.req_item_id} className={`py-2.5 space-y-1.5 ${flagged ? 'bg-red-50 -mx-1 px-1 rounded' : ''}`}>
                        <div className="flex flex-nowrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-[#2D1B0E] break-words">{l.material_name}</div>
                            <div className="text-[10px] text-[#8B7355] break-words">
                              {l.material_category ? `${l.material_category}` : ''}
                              {l.figures_known && <>{l.material_category ? ' · ' : ''}approved {fmtQtyNum(l.approved_purchase)} {pu}</>}
                              {l.figures_known && l.sent_purchase > EPS ? <> · sent {fmtQtyNum(l.sent_purchase)} {pu}</> : null}
                            </div>
                          </div>
                          {l.figures_known && (
                            <div className="shrink-0 text-right">
                              <div className="text-[9px] uppercase text-[#8B7355]">owed</div>
                              <div className="text-lg font-bold tabular-nums text-[#af4408]">
                                {fmtQtyNum(l.owed_purchase)} <span className="text-xs font-medium text-[#8B7355]">{pu}</span>
                              </div>
                              {recipeHint(l, l.owed_purchase) && <div className="text-[9px] text-[#B8A590]">{recipeHint(l, l.owed_purchase)}</div>}
                            </div>
                          )}
                        </div>
                        <div className={`text-[11px] ${l.sendable_upper_bound ? 'text-amber-900' : 'text-[#6B5744]'}`} title={l.sendable_basis || undefined}>
                          {D} {l.sendable_upper_bound ? 'holds up to' : 'holds'}{' '}
                          <b className="font-mono">{fmtQtyNum(l.sendable_purchase)} {pu}</b>
                          {l.sendable_upper_bound ? ' (never counted — its ledger figure)' : ''}
                        </div>
                        {l.blocked ? (
                          <div className="flex flex-nowrap items-start gap-2 text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-lg px-2.5 py-2">
                            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                            <span className="break-words">{l.blocked.message || 'This line cannot be sent right now.'}</span>
                          </div>
                        ) : canThis && !pend ? (
                          <div className="space-y-1">
                            <div className="flex flex-nowrap items-stretch gap-2">
                              <div className="relative flex-1 min-w-0">
                                <input type="number" inputMode="decimal" step="any" min="0" value={shownQty(l)}
                                       disabled={isBusy}
                                       onChange={e => { setTyped(s => ({ ...s, [l.req_item_id]: e.target.value.replace(/^-+/, '') })); setOne(setErrs, g.key, undefined); }}
                                       aria-label={`Quantity of ${l.material_name} to send, in ${pu}`}
                                       className={`w-full pl-3 pr-14 py-2.5 border rounded-lg bg-white text-base font-mono ${problem ? 'border-red-400' : 'border-[#D4B896]'}`} />
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[#8B7355] pointer-events-none">{pu}</span>
                              </div>
                              <button type="button" disabled={isBusy || !!problem || q == null}
                                      onClick={() => send(g, [l])}
                                      className="px-4 min-h-[48px] rounded-lg bg-[#af4408] hover:bg-[#8f3806] text-white text-sm font-semibold flex flex-nowrap items-center gap-1.5 disabled:opacity-40">
                                {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <SendHorizontal className="w-4 h-4" />}
                                Send{q != null && !problem ? ` ${fmtQtyNum(q)} ${pu}` : ''}
                              </button>
                            </div>
                            {problem ? (
                              <div className="text-[11px] text-red-700">{problem}</div>
                            ) : q != null && l.pack_factor > 1 && l.recipe_unit ? (
                              <div className="text-[10px] text-[#B8A590]">= {fmtQtyNum(q * l.pack_factor)} {l.recipe_unit}</div>
                            ) : null}
                            {q != null && !problem && q + EPS < l.owed_purchase && (
                              <div className="text-[10px] text-[#6B5744]">
                                The other {fmtQtyNum(Math.max(0, l.owed_purchase - q))} {pu} stays on this list.
                              </div>
                            )}
                          </div>
                        ) : !canThis && canSendDept && !pend ? (
                          <div className="text-[11px] text-[#8B7355]">
                            {l.sendable_purchase <= EPS ? `${D} holds none of it, so nothing can be sent yet.` : 'Not sendable right now.'}
                          </div>
                        ) : null}
                        {l.sends.length > 0 && (
                          <div className="text-[10px] text-[#6B5744] space-y-0.5">
                            {l.sends.map(s => (
                              <div key={s.transfer_line_id || s.transfer_id} className="flex flex-wrap items-center gap-x-1.5">
                                <span className="font-mono">{s.transfer_no}</span>
                                <span>· {fmtQtyNum(s.sent_purchase)} {pu} sent</span>
                                {Math.abs(s.net_purchase - s.sent_purchase) > EPS && <span>· {fmtQtyNum(s.net_purchase)} {pu} stands</span>}
                                {s.at && <span>· {fmtISTShort(s.at)}</span>}
                                {s.by && <span>· by {who(s.by)}</span>}
                                {s.dispute_status === 'open' && (
                                  <span className="px-1 rounded bg-amber-100 text-amber-800 font-semibold">
                                    disputed{s.open_disputed_purchase > EPS ? ` · ${fmtQtyNum(s.open_disputed_purchase)} ${pu}` : ''}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {err && (
                  <div className="flex flex-nowrap items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <span className="break-words">{err.msg}</span>
                  </div>
                )}

                {canSendDept && !pend && ready.length > 0 && (
                  <div className="space-y-2 pt-1 border-t border-[#E8D5C4]/60">
                    <input value={notes[g.key] || ''} onChange={e => setOne(setNotes, g.key, e.target.value)} maxLength={200}
                           disabled={isBusy} placeholder="Note (optional)"
                           className="w-full px-3 py-2 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-base disabled:opacity-60" />
                    {ready.length > 1 && (
                      <button type="button" disabled={isBusy || allProblems.length > 0} onClick={() => send(g, ready)}
                              className="w-full min-h-[52px] rounded-lg bg-[#af4408] hover:bg-[#8f3806] text-white text-base font-semibold flex flex-nowrap items-center justify-center gap-2 disabled:opacity-40">
                        {isBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : <SendHorizontal className="w-5 h-5" />}
                        Send all {ready.length} items to {g.to_department_name || 'the asking department'}
                      </button>
                    )}
                    <div className="text-[10px] text-[#8B7355] text-center">
                      Moves now: off {D}&apos;s books, onto {g.to_department_name || 'the asking department'}&apos;s, against {g.req_number}.
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {explainBox}
    </section>
  );
}
