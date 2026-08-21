'use client';

/**
 * PENDING QUALITY CHECKS — the screen a kitchen/bar staffer opens at the bay.
 *
 * A delivery whose lines include a QC-required category is recorded with
 * status 'awaiting_qc' and NO STOCK MOVEMENT AT ALL. This page is where the
 * checking department looks at the goods and decides. Signing it off is what
 * inwards it — while the vendor is still standing there and refusing a crate
 * is real leverage. That is the whole feature; everything below serves it.
 *
 *   GET  /api/grn/qc            → the queue
 *   GET  /api/grn/qc?id=<id>    → one held receipt + its lines
 *   POST /api/grn/[id]/qc       → { mode:'sign' | 'override', … }
 *   POST /api/grn/qc/escalate   → the "waited too long" sweep (idempotent)
 *
 * ── BUILT FOR A PHONE HELD IN ONE HAND, AND THAT IS NOT DECORATION ─────────
 * This is read at 6am at a loading bay, one-handed, next to a truck. So:
 *   · the queue is CARDS, never a table — a table needs two hands and a
 *     sideways scroll to answer "how long has this waited";
 *   · opening a receipt REPLACES the list rather than expanding inside it, so
 *     the lines and the Sign button are never below a scrolled-off queue;
 *   · the accept/reject control is a tap ("Accept all" is the default state,
 *     "Reject some" is the deliberate act), not a number field you must first
 *     select and clear;
 *   · the three checks are full-width rows with a real hit target, and the
 *     Sign bar is sticky at the bottom of the viewport where a thumb reaches.
 *
 * ── QUANTITIES LEAD WITH THE PURCHASE UNIT (owner rule) ────────────────────
 * A GRN line stores quantity_received/accepted in PURCHASE units and unit_price
 * in Rs per purchase unit (the canon). So the figure the checker reads AND the
 * figure they type are both purchase units — crates, bottles, kg-bags — which
 * is the only basis anybody at a bay can count. The recipe equivalent rides
 * underneath via displayQty(), because that is the number the stock ledger and
 * the money will move in. Never swap the two: typing "8" meaning bottles into a
 * millilitre field is exactly the mistake pack-units.ts exists to prevent.
 *
 * ── THE REJECT REASON IS A CODE, NOT PROSE, AND THAT IS DELIBERATE ─────────
 * /receiving-variance groups and filters on the EXACT rejection_reason string
 * (REASON_TONE + its reason dropdown, receiving-variance/page.tsx:144,231).
 * Appending free text — "damage: bruised" — would create a fresh bucket per
 * note and quietly destroy that report's ability to say "damage cost us X this
 * month". So the six codes the GRN form already uses are the whole vocabulary
 * here, and nothing else is sent.
 *
 * ── EVERY REFUSAL IS SHOWN BEFORE THE CLICK, IN THE SERVER'S OWN TERMS ─────
 * decideGrnQc() refuses a sign-off that leaves a check unticked, or a rejected
 * quantity with no reason. This page mirrors both and DISABLES Sign with the
 * reason on screen — the variance-approvals precedent. The mirror is a courtesy,
 * never the gate: POST /api/grn/[id]/qc re-derives who may sign from the session
 * and answers with its own sentence, which is rendered verbatim rather than
 * re-worded, so page and API can never tell different stories.
 *
 * ── WHAT THIS PAGE CANNOT DO, ON PURPOSE ───────────────────────────────────
 * It cannot edit the RECEIVED quantity, the rate, the vendor or the bill. Those
 * are the receiving desk's record of what came off the truck, amended on /grn.
 * The checking department's word is acceptance, and only acceptance.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { displayQty, packFactor, fmtQtyNum, type PackMeta } from '@/lib/pack-units';
import {
  ClipboardCheck, ChefHat, Wine, Loader2, RefreshCw, AlertTriangle, CheckCircle2,
  XCircle, Info, ShieldAlert, ArrowLeft, Clock, FileText, Lock, Truck, Users,
} from 'lucide-react';

/* ── the server's shapes, verbatim ───────────────────────────────────────── */
type Checker = 'none' | 'kitchen' | 'bar' | 'both';

interface QueueRow {
  id: string;
  grn_number: string;
  date: string;
  vendor: string;
  invoice_number: string;
  received_by: string;
  qc_checker: Checker;
  qc_escalated_at: string | null;
  created_at: string;
  po_id: string | null;
  po_number: string | null;
  line_count: number;
  /** SUM(quantity_received × unit_price) — the BILL value of what is waiting. */
  held_value: number | null;
  waiting_hours: number;
  overdue: boolean;
  /** Advisory only. The write re-derives it from the session. */
  can_sign: boolean;
}

interface SignerAudit {
  kitchen: number; bar: number; admins: number; hods: number; users_without_department: number;
  /** Signers who are NOT admins and NOT head chefs — the real departmental bench. */
  kitchen_dept: number; bar_dept: number;
  /** Sub-departments whose staff inherit signing rights through the parent chain. */
  granting_departments: Array<{ main: 'Kitchen' | 'Bar'; name: string; users: number }>;
}

/** Is the gate actually armed? See qcSchemaHealth() in src/lib/grn-qc.ts. */
interface SchemaHealth {
  ok: boolean;
  armed: boolean;
  missing_header_columns: string[];
  missing_line_columns: string[];
  map_table_missing: boolean;
  mapped_categories: number;
  message: string;
}

interface QueuePayload {
  rows: QueueRow[];
  pending_count: number;
  overdue_count: number;
  escalation_hours: number;
  can_override: boolean;
  signer_audit: SignerAudit;
  schema_health?: SchemaHealth;
  error?: string;
}

interface DetailItem {
  id: string;
  material_id: string;
  quantity_ordered: number | null;
  /** PURCHASE units. */
  quantity_received: number;
  quantity_accepted: number;
  quantity_rejected: number;
  rejection_reason: string;
  /** Rs per PURCHASE unit. */
  unit_price: number;
  discount: number | null;
  notes: string;
  qc_applied_at: string | null;
  material_name: string;
  material_sku: string;
  material_category: string;
  /** Recipe unit. */
  material_unit: string;
  purchase_unit: string | null;
  pack_size: number | null;
  line_value: number;
}

/**
 * The held receipt. The six legacy qc_* booleans are OPTIONAL here on purpose:
 * the PO receive route does not write them at all (its INSERT omits the column
 * list entirely), so on 20 of the 29 live GRNs they arrive as the schema
 * default and `qc_store_by` is ''. Typing them as required would make the page
 * print a confident "not checked" where the honest answer is "this route never
 * asked". renderStoreChecks() below draws that distinction.
 */
interface DetailGrn {
  id: string;
  grn_number: string;
  date: string;
  vendor: string;
  invoice_number: string;
  invoice_date?: string | null;
  received_by: string;
  status: string;
  notes?: string | null;
  qc_checker: Checker;
  qc_required?: number;
  qc_escalated_at: string | null;
  created_at: string;
  po_id: string | null;
  po_number: string | null;
  qc_quality?: number;
  qc_temperature?: number;
  qc_expiry?: number;
  qc_damage?: number;
  qc_weight?: number;
  qc_invoice_match?: number;
  qc_store_by?: string;
  qc_store_at?: string | null;
  qc_by?: string;
  items: DetailItem[];
}

interface DetailPayload {
  grn: DetailGrn;
  is_awaiting: boolean;
  can_sign: boolean;
  can_override: boolean;
  escalation_hours: number;
  error?: string;
}

/** The POST answer. Every field optional — this is a parsed HTTP body, and the
 *  refusal paths (403/409/400) carry only `error`. */
interface DecisionResponse {
  success?: boolean;
  grn_number?: string;
  outcome?: 'signed' | 'override' | 'rejected';
  status?: string;
  lines_applied?: number;
  purchases_written?: number;
  price_cascade_failed?: string[];
  message?: string;
  error?: string;
  missing_checks?: string[];
}

/* ── formatting ──────────────────────────────────────────────────────────── */
const inr = (v: number) => '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN');
const nf = (n: number) => Number(n || 0).toLocaleString('en-IN');
const EPS = 1e-6;

/** Pack meta for the purchase-unit display layer, built in ONE place. */
const metaOf = (it: DetailItem): PackMeta => ({
  unit: it.material_unit,
  purchase_unit: it.purchase_unit,
  pack_size: it.pack_size,
});

/**
 * A PURCHASE-unit quantity rendered the house way: purchase unit leading, the
 * recipe equivalent underneath when the material actually converts.
 *
 * displayQty() takes a RECIPE quantity, so the stored purchase figure is
 * multiplied UP by packFactor first. Do not "simplify" that away — passing the
 * purchase number straight in would divide it a second time and print 0.008 l
 * for 8 bottles.
 */
function PurchaseQty({ qty, item, strong }: { qty: number; item: DetailItem; strong?: boolean }) {
  const m = metaOf(item);
  const d = displayQty((Number(qty) || 0) * packFactor(m), m);
  return (
    <span>
      <span className={strong ? 'font-semibold text-[#2D1B0E]' : undefined}>{d.primary}</span>
      {d.hint && <span className="block text-[9px] font-normal text-[#B8A590]">{d.hint}</span>}
    </span>
  );
}

/** How long it has waited, in words a person uses at 6am. */
function waitedFor(hours: number): string {
  const h = Number(hours) || 0;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 24) return `${Math.round(h * 10) / 10} hr`;
  const d = Math.floor(h / 24);
  const r = Math.round(h - d * 24);
  return r ? `${d}d ${r}h` : `${d}d`;
}

/**
 * Hours since a SQLite `datetime('now')` stamp, or null when it cannot be read.
 *
 * NULL RATHER THAN ZERO, deliberately. The queue rows carry a server-computed
 * waiting_hours; the detail payload is `SELECT g.*` and has no such column, so
 * the header has to compute it here. An unparseable stamp coerced to 0 would
 * print "1 min" on a delivery that has sat since yesterday — the single number
 * this screen exists to make loud, quietly reversed. '—' is the honest answer.
 */
function hoursSince(stamp: string | null | undefined): number | null {
  if (!stamp) return null;
  const s = String(stamp);
  const d = new Date(s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / 3600000;
}

function istWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/** Who owes the check. 'both' means EITHER department may sign — not that two
 *  signatures are required (grn-qc.ts states this explicitly). */
const CHECKER_LABEL: Record<Checker, string> = {
  kitchen: 'Kitchen', bar: 'Bar', both: 'Kitchen or Bar', none: 'No check',
};

function CheckerChip({ checker }: { checker: Checker }) {
  const Icon = checker === 'bar' ? Wine : ChefHat;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold
                     bg-[#FFF1E3] border border-[#E8D5C4] text-[#6B5744]">
      <Icon className="w-3 h-3" />{CHECKER_LABEL[checker] || 'Check'}
    </span>
  );
}

/* ── the three checks that belong to each side ───────────────────────────── */
/** The kitchen/bar half of the owner's decision-4 split. Wording is verbatim
 *  from the printed GRN sheet (grn/print/[id]/page.tsx:82) so the paper and the
 *  screen say the same thing. */
const KITCHEN_CHECKS = [
  { key: 'quality'     as const, label: 'Quality OK (look · smell · feel)' },
  { key: 'temperature' as const, label: 'Temperature within range (cold-chain items)' },
  { key: 'damage'      as const, label: 'No visible damage / leak / pest' },
];
/** The store half — CONTEXT on this screen, never editable here. */
const STORE_CHECKS = [
  { key: 'qc_expiry'        as const, label: 'Expiry / use-by date checked' },
  { key: 'qc_weight'        as const, label: 'Weight / count verified vs invoice' },
  { key: 'qc_invoice_match' as const, label: 'Invoice matches PO (rate, qty, vendor)' },
];

/** The whole reject vocabulary. Same six values the GRN form writes, because
 *  /receiving-variance groups on the exact string. */
const REJECT_REASONS: Array<{ value: string; label: string }> = [
  { value: 'damage',        label: 'Damage' },
  { value: 'quality',       label: 'Quality' },
  { value: 'expired',       label: 'Expired' },
  { value: 'short_weight',  label: 'Short weight' },
  { value: 'rate_mismatch', label: 'Rate mismatch' },
  { value: 'other',         label: 'Other' },
];

/** Per-line decision held in page state. Strings, because these are input
 *  values — coercing to a number on every keystroke makes "0." unshootable. */
interface LineState { rejectedRaw: string; reason: string }

export default function PendingQualityChecksPage() {
  /* queue */
  const [queue, setQueue] = useState<QueuePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  /* one open receipt */
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  /* the decision being composed */
  const [lines, setLines] = useState<Record<string, LineState>>({});
  const [ticks, setTicks] = useState({ quality: false, temperature: false, damage: false });
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string; warn?: string } | null>(null);

  /* ONE toast timer, cleared before each new message. A second decision must
   * never cancel the first one's error while it is still being read — the same
   * reason settings/station-departments keeps a ref instead of a bare timeout. */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((ok: boolean, msg: string, warn?: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setResult({ ok, msg, warn });
    toastTimer.current = setTimeout(() => setResult(null), ok ? 6000 : 12000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const loadQueue = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/grn/qc', { cache: 'no-store' });
      if (res.status === 401) { setForbidden(true); return; }
      const j = (await res.json().catch(() => ({}))) as QueuePayload;
      if (!res.ok) { setLoadError(j?.error || `HTTP ${res.status}`); return; }
      // Fail closed on a body that parsed but carries no queue: an empty page
      // would read as "nothing is waiting", which is the opposite of "the queue
      // did not load" and would send a checker home.
      if (!Array.isArray(j?.rows)) { setLoadError('The queue came back empty — reload, or check the server log.'); return; }
      setQueue(j);
    } catch {
      setLoadError('Network error — could not load the pending quality checks.');
    } finally { setLoading(false); setRefreshing(false); }
  }, []);

  /**
   * Poke the escalation sweep, once, on first load.
   *
   * THERE IS NO SCHEDULER in this app, so the "this has waited too long" ping
   * only fires when something calls it — and the route is idempotent by
   * construction (it claims each GRN with `qc_escalated_at IS NULL` in the same
   * UPDATE that stamps it), which is what makes calling it from a page safe.
   * Fire-and-forget: an escalation that fails must never stop the queue from
   * rendering. Ideally scheduler.ts calls this too; until it does, this is the
   * only trigger there is.
   */
  useEffect(() => {
    // No cleanup and no state written from here on purpose: there is nothing to
    // cancel and nothing to render. The sweep's only effect is server-side, and
    // the queue load right below already reflects whatever it stamped.
    api('/api/grn/qc/escalate', { method: 'POST' }).catch(() => { /* silent by design */ });
  }, []);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  /* Keep the queue fresh without hammering it: 60s while the list is open and
   * the tab is visible, plus a refresh when the operator comes back to it. A
   * held delivery is minutes-old news, and two people at one bay must not both
   * think a receipt is still waiting. */
  useEffect(() => {
    if (openId) return;
    const tick = () => { if (document.visibilityState === 'visible') loadQueue(true); };
    const t = setInterval(tick, 60000);
    window.addEventListener('focus', tick);
    return () => { clearInterval(t); window.removeEventListener('focus', tick); };
  }, [openId, loadQueue]);

  const openReceipt = useCallback(async (id: string) => {
    setOpenId(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    setLines({});
    setTicks({ quality: false, temperature: false, damage: false });
    setOverrideOpen(false);
    setOverrideReason('');
    window.scrollTo({ top: 0 });
    try {
      const res = await fetch(`/api/grn/qc?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      const j = (await res.json().catch(() => ({}))) as DetailPayload;
      if (!res.ok) { setDetailError(j?.error || `HTTP ${res.status}`); return; }
      if (!j?.grn || !Array.isArray(j.grn.items)) { setDetailError('That receipt came back without its lines — reload.'); return; }
      setDetail(j);
    } catch {
      setDetailError('Network error — could not open that receipt.');
    } finally { setDetailLoading(false); }
  }, []);

  const closeReceipt = useCallback(() => {
    setOpenId(null); setDetail(null); setDetailError(null);
    loadQueue(true);
  }, [loadQueue]);

  /** The back button, with the one guard it needs. Opening a receipt resets
   *  `lines` and `ticks`, so backing out throws away everything typed — four
   *  rejection quantities and their reasons on a 14-line delivery, gone on one
   *  mis-tap of a button that sits at the top of a phone screen. Only asks when
   *  there is something to lose; a plain "I opened the wrong one" still closes
   *  in one tap. `closeReceipt` itself stays unguarded because the successful
   *  sign-off path calls it too, and that must never prompt. */
  const backToQueue = useCallback(() => {
    const typed = Object.values(lines).some(l => (l?.rejectedRaw || '').trim() !== '' || (l?.reason || '').trim() !== '');
    if (typed && !window.confirm('Discard the rejections you have entered on this delivery?')) return;
    closeReceipt();
  }, [lines, closeReceipt]);

  /* ── the decision, resolved ────────────────────────────────────────────── */
  /** Memoised so the totals/validation hooks below do not re-run on every
   *  keystroke: `detail?.grn.items ?? []` is a fresh array identity each render. */
  const items = useMemo(() => detail?.grn.items ?? [], [detail]);

  /** Rejected quantity for a line, clamped to what actually arrived. Clamping
   *  here (not only on the server) keeps the running accept/reject totals from
   *  showing a negative accepted while somebody is mid-type. */
  const rejectedOf = useCallback((it: DetailItem): number => {
    const raw = lines[it.id]?.rejectedRaw ?? '';
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, Number(it.quantity_received) || 0);
  }, [lines]);

  const acceptedOf = useCallback((it: DetailItem): number => {
    const rec = Number(it.quantity_received) || 0;
    return Math.max(0, Math.round((rec - rejectedOf(it)) * 1000) / 1000);
  }, [rejectedOf]);

  const totals = useMemo(() => {
    let accValue = 0, rejValue = 0, rejLines = 0, accLines = 0;
    for (const it of items) {
      const rej = rejectedOf(it);
      const acc = acceptedOf(it);
      accValue += acc * (Number(it.unit_price) || 0);
      rejValue += rej * (Number(it.unit_price) || 0);
      if (rej > EPS) rejLines++;
      if (acc > EPS) accLines++;
    }
    return { accValue, rejValue, rejLines, accLines, anyAccepted: accValue > 0 || accLines > 0 };
  }, [items, rejectedOf, acceptedOf]);

  /**
   * The server's own refusals, mirrored so Sign is disabled with the reason
   * visible BEFORE the click. Returns the sentence, or null when the sign-off
   * would be accepted. Order matches decideGrnQc(): line arithmetic, then the
   * missing reason, then the ticks.
   */
  const signBlock = useMemo((): string | null => {
    if (!detail) return 'Loading…';
    if (!detail.is_awaiting) return 'This receipt is no longer waiting for a check.';
    if (!detail.can_sign) {
      const who = CHECKER_LABEL[detail.grn.qc_checker] || 'the checking department';
      return `This delivery needs a ${who} check and your account is not in that department. Ask ${who.toLowerCase()} staff to sign it, or ask an admin / head chef to release it with a written reason.`;
    }
    if (items.length === 0) return 'This receipt has no line items to sign off.';
    for (const it of items) {
      const raw = lines[it.id]?.rejectedRaw ?? '';
      const n = Number(raw);
      if (raw.trim() && (!Number.isFinite(n) || n < 0)) {
        return `The rejected quantity on "${it.material_name}" is not a number.`;
      }
      if (raw.trim() && n > (Number(it.quantity_received) || 0) + EPS) {
        // Purchase units, named — this sentence is read next to a crate, and a
        // bare number would be the one figure on this screen whose basis the
        // reader has to guess (check-purchase-units.js enforces exactly that).
        const pUnit = (it.purchase_unit || it.material_unit || 'units').trim();
        return `You cannot reject more of "${it.material_name}" than the ${fmtQtyNum(Number(it.quantity_received) || 0)} ${pUnit} that arrived.`;
      }
      if (rejectedOf(it) > EPS && !(lines[it.id]?.reason || '').trim()) {
        return `Say why "${it.material_name}" is being turned away — the reason goes on the receiving-variance report and is what the vendor answers for.`;
      }
    }
    // A FULL rejection needs no ticks: you cannot affirm the quality of goods
    // you refused. Same carve-out decideGrnQc() makes, for the same reason.
    if (totals.anyAccepted) {
      const missing = [
        !ticks.quality && 'quality (look / smell / feel)',
        !ticks.temperature && 'temperature within range',
        !ticks.damage && 'no visible damage / leak / pest',
      ].filter(Boolean) as string[];
      if (missing.length) {
        return `Confirm every check before these goods enter stock — still unconfirmed: ${missing.join('; ')}. If one of them failed, reject the affected quantity with a reason instead of signing.`;
      }
    }
    return null;
  }, [detail, items, lines, ticks, totals.anyAccepted, rejectedOf]);

  const submitDecision = useCallback(async (mode: 'sign' | 'override') => {
    if (!detail || submitting) return;
    if (mode === 'sign' && signBlock) { flash(false, signBlock); return; }
    if (mode === 'override' && overrideReason.trim().length < 5) {
      flash(false, 'A written reason is required to inward goods without a kitchen check — it is stamped on this bill permanently and appears on the override report.');
      return;
    }
    setSubmitting(true);
    try {
      const body = mode === 'sign'
        ? {
            mode: 'sign',
            ticks,
            lines: items.map(it => ({
              grn_item_id: it.id,
              accepted: acceptedOf(it),
              rejection_reason: rejectedOf(it) > EPS ? (lines[it.id]?.reason || '') : '',
            })),
          }
        : { mode: 'override', reason: overrideReason.trim() };

      const res = await api(`/api/grn/${encodeURIComponent(detail.grn.id)}/qc`, { method: 'POST', body });
      const j = (await res.json().catch(() => ({}))) as DecisionResponse;
      if (!res.ok) {
        // The SERVER'S sentence, rendered as-is. Re-wording it here is how the
        // page and the API start telling different stories about the same
        // refusal — and these refusals (a cutover, a store-mapped material, a
        // void) are ones the operator has to act on, not dismiss.
        flash(false, j?.error || `Could not record the decision (HTTP ${res.status}).`);
        return;
      }
      const warn = (j.price_cascade_failed && j.price_cascade_failed.length)
        ? `${j.price_cascade_failed.length} material(s) entered stock but their weighted-average cost did not recompute — re-cost them from Raw Materials.`
        : undefined;
      flash(true, j?.message || 'Recorded.', warn);
      closeReceipt();
    } catch {
      flash(false, 'Network error — nothing was recorded. The goods are still waiting.');
    } finally { setSubmitting(false); }
  }, [detail, submitting, signBlock, overrideReason, ticks, items, acceptedOf, rejectedOf, lines, flash, closeReceipt]);

  /* ── forbidden ─────────────────────────────────────────────────────────── */
  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="max-w-sm text-center text-[#6B5744]">
          <Lock className="w-10 h-10 mx-auto mb-3 text-[#af4408]" />
          <h1 className="text-lg font-bold text-[#2D1B0E]">Sign in required</h1>
          <p className="text-sm mt-1">Pending quality checks are only visible to a signed-in account.</p>
        </div>
      </div>
    );
  }

  /* ══ DETAIL — one held receipt ═══════════════════════════════════════════ */
  if (openId) {
    const g = detail?.grn;
    const storeTicked = g ? STORE_CHECKS.filter(c => !!(g as unknown as Record<string, number>)[c.key]).length : 0;
    /**
     * Is this receipt still open for a decision?
     *
     * It can be false for an ordinary reason: somebody else at the same bay
     * signed it thirty seconds ago, or an admin released it. When that happens
     * the decision controls are REMOVED rather than left live-but-inert —
     * offering a Reject box that can only ever produce a 409 is how an operator
     * concludes the app is broken and starts re-entering the delivery by hand.
     */
    const decidable = !!detail?.is_awaiting;

    return (
      <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E] pb-40">
        <div className="max-w-3xl mx-auto px-3 sm:px-6 py-4 space-y-3">

          <button
            onClick={backToQueue}
            className="flex items-center gap-1.5 text-sm font-medium text-[#af4408] hover:text-[#8a3506] py-1"
          >
            <ArrowLeft className="w-4 h-4" />All pending checks
          </button>

          {detailLoading && (
            <div className="bg-white border border-[#E8D5C4] rounded-2xl py-16 text-center text-[#8B7355]">
              <Loader2 className="w-7 h-7 mx-auto animate-spin text-[#af4408]" />
              <p className="text-sm mt-3">Opening the receipt…</p>
            </div>
          )}

          {detailError && (
            <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /><span>{detailError}</span>
            </div>
          )}

          {g && (
            <>
              {/* Header — who, when, how long */}
              <div className="bg-white border border-[#E8D5C4] rounded-2xl p-3.5 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h1 className="text-lg font-bold truncate">{g.grn_number}</h1>
                      <CheckerChip checker={g.qc_checker} />
                    </div>
                    <p className="text-sm text-[#6B5744] mt-1 flex items-center gap-1.5">
                      <Truck className="w-3.5 h-3.5 text-[#8B7355] shrink-0" />
                      <span className="truncate">{g.vendor || 'Vendor not named'}</span>
                    </p>
                    <p className="text-[11px] text-[#8B7355] mt-0.5">
                      {g.date}
                      {g.invoice_number ? ` · Bill ${g.invoice_number}` : ''}
                      {g.po_number ? ` · PO ${g.po_number}` : ''}
                      {g.received_by ? ` · received by ${g.received_by}` : ''}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[10px] uppercase tracking-wide text-[#8B7355]">Waiting</p>
                    <p className="text-base font-bold text-[#af4408]">
                      {hoursSince(g.created_at) === null ? '—' : waitedFor(hoursSince(g.created_at) as number)}
                    </p>
                  </div>
                </div>
              </div>

              {/* THE STANDING FACT, at the top where it cannot be missed. */}
              {decidable ? (
                <div className="flex items-start gap-2 p-3 bg-blue-50/60 border border-blue-200 rounded-xl text-xs text-blue-900">
                  <Info className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    <b>Nothing has entered stock yet.</b> These goods are recorded but not ours. Signing off is
                    what inwards them — so refuse anything you would not cook with <b>while the vendor is still here</b>.
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2 p-3 bg-[#F3EEE7] border border-[#E8D5C4] rounded-xl text-xs text-[#6B5744]">
                  <Info className="w-4 h-4 shrink-0 mt-0.5 text-[#8B7355]" />
                  <span>
                    This receipt is <b>no longer waiting for a check</b> — it now reads <b>{g.status}</b>
                    {g.qc_by ? <>, signed by <b>{g.qc_by}</b></> : ''}. Somebody may have decided it while this was
                    open. Nothing here can be applied a second time; the lines below are shown as a record.
                  </span>
                </div>
              )}

              {/* STORE CONTEXT — visibly not theirs to tick. Rendered as flat,
                  disabled chips rather than checkboxes, because a checkbox that
                  cannot be clicked reads as broken. */}
              <div className="bg-[#F3EEE7] border border-[#E8D5C4] rounded-2xl p-3">
                <p className="text-[10px] uppercase tracking-wider text-[#8B7355] font-semibold flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5" />Receiving desk checks — for your information
                </p>
                <div className="mt-2 space-y-1.5">
                  {STORE_CHECKS.map(c => {
                    const on = !!(g as unknown as Record<string, number>)[c.key];
                    return (
                      <div key={c.key} className="flex items-start gap-2 text-xs">
                        <span className={`mt-[1px] shrink-0 ${on ? 'text-emerald-600' : 'text-[#C0A98F]'}`}>
                          {on ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                        </span>
                        <span className={on ? 'text-[#6B5744]' : 'text-[#8B7355]'}>{c.label}</span>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10px] text-[#8B7355] mt-2 leading-snug">
                  {g.qc_store_by
                    ? <>Confirmed by <b>{g.qc_store_by}</b>{g.qc_store_at ? ` · ${istWhen(g.qc_store_at)}` : ''}.</>
                    : g.po_id
                      ? <>Not recorded — a PO receipt does not present this checklist, so the blanks mean <b>not asked</b>, not <b>failed</b>.</>
                      : storeTicked === 0
                        ? <>Not recorded by the receiving desk on this bill.</>
                        : <>Partly recorded; no name was captured.</>}
                  {' '}These three belong to the store, not to you. Yours are the three at the bottom.
                </p>
              </div>

              {/* LINES */}
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="text-sm font-bold">
                    {items.length} item{items.length === 1 ? '' : 's'} {decidable ? 'to check' : 'on this receipt'}
                  </h2>
                  <span className="text-[11px] text-[#8B7355]">Quantities are in purchase units</span>
                </div>

                {items.map(it => {
                  const st = lines[it.id];
                  const rejecting = !!st && (st.rejectedRaw.trim() !== '' || !!st.reason);
                  const rej = rejectedOf(it);
                  const acc = acceptedOf(it);
                  const rec = Number(it.quantity_received) || 0;
                  const pUnit = (it.purchase_unit || it.material_unit || '').trim();
                  const needsReason = rej > EPS && !(st?.reason || '').trim();

                  return (
                    <div
                      key={it.id}
                      className={`bg-white border rounded-2xl p-3 shadow-sm ${
                        rej > EPS ? 'border-amber-300' : 'border-[#E8D5C4]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold leading-tight">{it.material_name}</p>
                          <p className="text-[10px] text-[#8B7355] mt-0.5">
                            {it.material_sku ? `${it.material_sku} · ` : ''}{it.material_category}
                          </p>
                        </div>
                        <div className="text-right shrink-0 text-xs">
                          <p className="text-[10px] uppercase tracking-wide text-[#8B7355]">Arrived</p>
                          <PurchaseQty qty={rec} item={it} strong />
                          <p className="text-[10px] text-[#8B7355] mt-0.5">
                            {inr(Number(it.unit_price) || 0)}/{pUnit || 'unit'}
                          </p>
                        </div>
                      </div>

                      {/* WHAT THE RECEIVER SAW. gi.notes is typed at the bay by
                          the person who took the crate off the truck — "crate 3
                          is wet, look at it" — and it was selected by the API and
                          then rendered nowhere, on the one screen built for
                          looking at the goods. It is a hand-off, not decoration:
                          the checker is standing in front of the crate that note
                          is about. */}
                      {String(it.notes || '').trim() && (
                        <p className="mt-2 text-xs text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl px-2.5 py-1.5">
                          <span className="text-[10px] uppercase tracking-wide text-[#8B7355]">From the receiving desk:</span>{' '}
                          {String(it.notes).trim()}
                        </p>
                      )}

                      {/* A BACK-CORRECTION LINE OFFERS NO DECISION. Nothing
                          arrived, so there is nothing to accept or reject: the
                          server passes a negative line through unjudged and
                          IGNORES any line decision sent for it. Rendering the
                          reject control here would collect a number that is
                          then silently discarded. POST /api/grn now refuses to
                          put a correction on a held bill at all, so this can
                          only be a row from before that guard — which is
                          exactly why it must still read honestly. */}
                      {rec < -EPS ? (
                        <div className="mt-2.5 text-xs text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl px-2.5 py-2">
                          <b>Back-correction — nothing to check.</b> This line reduces stock by{' '}
                          {fmtQtyNum(Math.abs(rec))} {pUnit} to undo an earlier over-booking. It applies as recorded when you
                          sign; there is no quantity to accept or reject.
                        </div>
                      ) : !decidable ? null : !rejecting ? (
                        <div className="mt-2.5 flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                            <CheckCircle2 className="w-4 h-4" />Accepting all {fmtQtyNum(rec)} {pUnit}
                          </span>
                          <button
                            type="button"
                            onClick={() => setLines(p => ({ ...p, [it.id]: { rejectedRaw: '', reason: '' } }))}
                            className="px-3 py-2 rounded-xl border border-[#E8D5C4] bg-[#FFF8F0] hover:bg-[#FFF1E3]
                                       text-xs font-medium text-[#6B5744]"
                          >
                            Reject some…
                          </button>
                        </div>
                      ) : (
                        <div className="mt-2.5 border-t border-[#E8D5C4]/60 pt-2.5 space-y-2">
                          <div className="flex items-end gap-2 flex-wrap">
                            <label className="flex-1 min-w-[130px]">
                              <span className="block text-[10px] uppercase tracking-wide text-[#8B7355] mb-1">
                                Reject how much ({pUnit || 'units'})
                              </span>
                              <input
                                type="number"
                                inputMode="decimal"
                                step="any"
                                min={0}
                                max={rec}
                                value={st?.rejectedRaw ?? ''}
                                onChange={e => setLines(p => ({ ...p, [it.id]: { rejectedRaw: e.target.value, reason: p[it.id]?.reason || '' } }))}
                                placeholder="0"
                                className="w-full px-3 py-2.5 border border-[#E8D5C4] rounded-xl bg-[#FFF8F0]
                                           text-base font-semibold text-[#2D1B0E]"
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() => setLines(p => ({ ...p, [it.id]: { rejectedRaw: String(rec), reason: p[it.id]?.reason || '' } }))}
                              className="px-3 py-2.5 rounded-xl border border-[#E8D5C4] bg-[#FFF8F0] hover:bg-[#FFF1E3] text-xs font-medium text-[#6B5744]"
                            >
                              Reject all
                            </button>
                            <button
                              type="button"
                              onClick={() => setLines(p => { const n = { ...p }; delete n[it.id]; return n; })}
                              className="px-3 py-2.5 rounded-xl border border-[#E8D5C4] bg-[#FFF8F0] hover:bg-[#FFF1E3] text-xs font-medium text-[#6B5744]"
                            >
                              Accept all
                            </button>
                          </div>

                          <div>
                            <span className="block text-[10px] uppercase tracking-wide text-[#8B7355] mb-1">
                              Why {needsReason && <span className="text-amber-700 font-semibold">— required</span>}
                            </span>
                            <div className="flex flex-wrap gap-1.5">
                              {REJECT_REASONS.map(r => {
                                const on = (st?.reason || '') === r.value;
                                return (
                                  <button
                                    key={r.value}
                                    type="button"
                                    onClick={() => setLines(p => ({
                                      ...p,
                                      [it.id]: { rejectedRaw: p[it.id]?.rejectedRaw ?? '', reason: on ? '' : r.value },
                                    }))}
                                    className={`px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${
                                      on
                                        ? 'bg-[#af4408] border-[#8a3506] text-white'
                                        : 'bg-[#FFF8F0] border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'
                                    }`}
                                  >
                                    {r.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div className="flex items-center justify-between gap-2 text-[11px] pt-0.5">
                            <span className="text-emerald-700 font-medium">
                              Accepting <PurchaseQty qty={acc} item={it} />
                            </span>
                            <span className="text-amber-700 font-medium">
                              Turning away <PurchaseQty qty={rej} item={it} /> · {inr(rej * (Number(it.unit_price) || 0))}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* THE THREE CHECKS THAT ARE THEIRS */}
              {decidable && (
              <div className="bg-white border border-[#E8D5C4] rounded-2xl p-3.5 shadow-sm">
                <p className="text-[10px] uppercase tracking-wider text-[#8B7355] font-semibold flex items-center gap-1.5">
                  <ChefHat className="w-3.5 h-3.5" />
                  Your checks — {CHECKER_LABEL[g.qc_checker] || 'checking department'}
                </p>
                <div className="mt-2 space-y-1.5">
                  {KITCHEN_CHECKS.map(c => {
                    const on = ticks[c.key];
                    return (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => setTicks(p => ({ ...p, [c.key]: !p[c.key] }))}
                        className={`w-full flex items-start gap-2.5 text-left px-3 py-3 rounded-xl border transition-colors ${
                          on ? 'bg-emerald-50 border-emerald-200' : 'bg-[#FFF8F0] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                        }`}
                      >
                        <span className={`mt-[1px] shrink-0 ${on ? 'text-emerald-600' : 'text-[#C0A98F]'}`}>
                          {on ? <CheckCircle2 className="w-5 h-5" /> : <span className="block w-5 h-5 rounded-md border-2 border-[#D4B896]" />}
                        </span>
                        <span className={`text-sm ${on ? 'text-emerald-900 font-medium' : 'text-[#6B5744]'}`}>{c.label}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-[#8B7355] mt-2 leading-snug">
                  Ticking these puts your name and the time on this bill. If one of them failed, reject the
                  affected quantity above with a reason instead of ticking it.
                </p>
              </div>
              )}

              {/* OVERRIDE — only for those who may, and never the easy path. */}
              {decidable && detail?.can_override && (
                <div className="bg-white border border-[#E8D5C4] rounded-2xl p-3.5 shadow-sm">
                  {!overrideOpen ? (
                    <button
                      type="button"
                      onClick={() => setOverrideOpen(true)}
                      className="text-xs font-medium text-[#8B7355] hover:text-[#af4408] underline underline-offset-2"
                    >
                      Release without a kitchen check (admin / head chef)
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-amber-900 flex items-start gap-1.5">
                        <ShieldAlert className="w-4 h-4 shrink-0" />
                        This inwards <b>everything that arrived</b> with no quality judgement.
                      </p>
                      <p className="text-[11px] text-[#6B5744]">
                        The bill is marked <b>inwarded without kitchen QC</b> permanently, with your name and this
                        reason, and appears on the override report. Use it when the goods must move and no checker
                        is reachable — not to clear the queue.
                      </p>
                      <textarea
                        value={overrideReason}
                        onChange={e => setOverrideReason(e.target.value)}
                        rows={2}
                        placeholder="Why is this being released without a check?"
                        className="w-full px-3 py-2.5 border border-[#E8D5C4] rounded-xl bg-[#FFF8F0] text-sm"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={submitting || overrideReason.trim().length < 5}
                          onClick={() => submitDecision('override')}
                          title={overrideReason.trim().length < 5 ? 'A written reason of at least 5 characters is required.' : undefined}
                          className="px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold
                                     disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                        >
                          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />}
                          Release without check
                        </button>
                        <button
                          type="button"
                          onClick={() => { setOverrideOpen(false); setOverrideReason(''); }}
                          className="px-3 py-2.5 rounded-xl border border-[#E8D5C4] bg-[#FFF8F0] text-sm text-[#6B5744]"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* STICKY SIGN BAR — thumb height, always the last thing on screen.
            Absent entirely on a receipt that has already been decided: a Sign
            button that can only 409 is worse than no button. */}
        {g && decidable && (
          <div className="fixed bottom-0 inset-x-0 bg-white/95 backdrop-blur border-t border-[#E8D5C4] shadow-[0_-2px_10px_rgba(45,27,14,0.08)]">
            <div className="max-w-3xl mx-auto px-3 sm:px-6 py-2.5 space-y-2">
              {signBlock && (
                <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 leading-snug">
                  {signBlock}
                </p>
              )}
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1 text-[11px] leading-tight">
                  <p className="text-[#6B5744]">
                    <b className="text-emerald-700">{totals.accLines}</b> accepting
                    {totals.rejLines > 0 && <> · <b className="text-amber-700">{totals.rejLines}</b> rejecting</>}
                  </p>
                  <p className="text-[#8B7355]">
                    Entering stock: <b className="text-[#2D1B0E]">{inr(totals.accValue)}</b>
                    {totals.rejValue > 0 && <> · turned away {inr(totals.rejValue)}</>}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!!signBlock || submitting}
                  onClick={() => submitDecision('sign')}
                  title={signBlock || undefined}
                  className="shrink-0 px-5 py-3 rounded-xl bg-[#af4408] hover:bg-[#8a3506] text-white text-sm font-semibold
                             disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
                  {totals.anyAccepted ? 'Sign off' : 'Reject delivery'}
                </button>
              </div>
            </div>
          </div>
        )}

        <Toast result={result} onClose={() => setResult(null)} />
      </div>
    );
  }

  /* ══ QUEUE ═══════════════════════════════════════════════════════════════ */
  const rows = queue?.rows ?? [];
  const audit = queue?.signer_audit;
  const health = queue?.schema_health;
  const heldTotal = rows.reduce((s, r) => s + (Number(r.held_value) || 0), 0);

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-3xl mx-auto px-3 sm:px-6 py-5 space-y-3.5">

        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Purchasing</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2.5">
              <ClipboardCheck className="w-7 h-7 text-[#af4408] shrink-0" />
              <span className="min-w-0">Pending Quality Checks</span>
            </h1>
            <p className="text-sm text-[#8B7355] mt-1">
              These deliveries are recorded but <b>have not entered stock</b>. Kitchen or bar signs one off and
              that is what inwards it — check the goods while the vendor is still at the bay.
            </p>
          </div>
          <button
            onClick={() => loadQueue(true)}
            className="shrink-0 flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3]
                       text-[#6B5744] rounded-xl text-sm font-medium shadow-sm"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>

        {loadError && (
          <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /><span>{loadError}</span>
          </div>
        )}

        {/* Counts */}
        {queue && (
          <div className="grid grid-cols-3 gap-2.5">
            {[
              { label: 'Waiting', value: nf(queue.pending_count), cls: queue.pending_count > 0 ? 'text-[#af4408]' : 'text-[#2D1B0E]' },
              { label: `Overdue (> ${queue.escalation_hours}h)`, value: nf(queue.overdue_count), cls: queue.overdue_count > 0 ? 'text-red-700' : 'text-[#2D1B0E]' },
              { label: 'Value held', value: inr(heldTotal), cls: 'text-[#2D1B0E]' },
            ].map(c => (
              <div key={c.label} className="bg-white border border-[#E8D5C4] rounded-2xl px-3 py-2.5 shadow-sm">
                <p className="text-[10px] text-[#8B7355] leading-tight">{c.label}</p>
                <p className={`text-lg sm:text-xl font-bold mt-0.5 ${c.cls}`}>{c.value}</p>
              </div>
            ))}
          </div>
        )}

        {/*
          WHO CAN ACTUALLY SIGN, on this database, today — surfaced rather than
          assumed. Every department has an empty head_user_id and users.section
          is blank across the board, so on day one a Kitchen check is signable
          only by admins and head chefs. A queue nobody in the building can clear
          is this feature failing silently; this is the sentence that stops that
          being discovered at the bay. AMBER, not red: it is a configuration gap
          with a working path around it (the override), not a fault.
        */}
        {/* ── IS THE GATE EVEN ARMED? ──────────────────────────────────────
            The gate fails OPEN by design — a missing column or a missing
            qc_category_checkers table makes resolveQcRequirement answer "no
            check" for everything, so every delivery inwards instantly while
            THIS PAGE READS ZERO AND THE BELL READS ZERO. That is
            indistinguishable from a quiet morning, and db.ts only console.errors
            its schema failures, so nothing else would ever say so. An empty
            queue is the state this banner has to be able to speak over — hence
            it sits above the `rows.length` guard below and is RED, not amber:
            unlike the signer gap there is no working path around it. */}
        {health && !health.armed && (
          <div className="flex items-start gap-2 p-3.5 bg-red-50 border border-red-300 rounded-xl text-xs text-red-900">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <b>{health.ok ? 'No category is set to be checked.' : 'The quality-check gate is NOT ARMED.'}</b>
              <p className="mt-1">{health.message}</p>
              {!health.ok && (health.missing_header_columns.length > 0 || health.missing_line_columns.length > 0) && (
                <p className="mt-1 font-mono text-[11px] break-words">
                  {[...health.missing_header_columns, ...health.missing_line_columns].join(', ')}
                </p>
              )}
              <p className="mt-1">
                An admin can set the perishable categories on{' '}
                <Link href="/settings/qc-categories" className="underline font-medium">Quality-check categories</Link>.
              </p>
            </div>
          </div>
        )}

        {/* THE DEPARTMENTAL BENCH, NOT THE HEADCOUNT. The predicate here was
            `kitchen <= max(admins, hods)`, and it could not fire in any normal
            configuration: every admin and every head chef ALREADY counts inside
            `kitchen`, so kitchen >= max(admins, hods) always, and strictly
            greater the moment one head chef is not also an admin — which is the
            ordinary setup. Measured on this database it never fired on the full
            user list or the production-shaped one, so the single sentence in the
            app that says "set Section/Department on /users" was unreachable.
            kitchen_dept counts the people who can sign BECAUSE THEY ARE IN THE
            KITCHEN, and ZERO is the condition worth warning about. */}
        {audit && (audit.kitchen_dept === 0 || audit.bar_dept === 0) && (
          <div className="flex items-start gap-2 p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900">
            <Users className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <b>
                {audit.kitchen_dept === 0 && audit.bar_dept === 0
                  ? 'Nobody on the floor can sign a check yet.'
                  : audit.kitchen_dept === 0
                    ? 'Nobody in the Kitchen can sign a Kitchen check yet.'
                    : 'Nobody in the Bar can sign a Bar check yet.'}
              </b>{' '}
              Only the {audit.admins} admin{audit.admins === 1 ? '' : 's'} and {audit.hods} head chef
              {audit.hods === 1 ? '' : 's'} can clear these — {audit.kitchen_dept} kitchen and {audit.bar_dept} bar
              account{audit.bar_dept === 1 ? '' : 's'} qualify on their own department.
              <p className="mt-1 text-amber-800">
                {audit.users_without_department} active user{audit.users_without_department === 1 ? ' has' : 's have'} no
                department or section set, so the gate cannot tell whether they work in the kitchen. Set them on{' '}
                <Link href="/users" className="underline font-medium">Users</Link> and the people at the bay can sign for
                themselves. Until then an admin or head chef must release each delivery.
              </p>
              {audit.granting_departments.length > 0 && (
                <p className="mt-1 text-amber-800">
                  Signing is inherited through the department tree, so anyone in{' '}
                  {audit.granting_departments.map(d => `${d.name} (→ ${d.main}${d.users ? `, ${d.users}` : ''})`).join(', ')}{' '}
                  counts too — re-parent any of those that are not really kitchen or bar.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Queue */}
        {loading ? (
          <div className="space-y-2.5">
            {[0, 1, 2].map(i => <div key={i} className="bg-white border border-[#E8D5C4] rounded-2xl h-28 animate-pulse" />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl py-14 text-center text-[#8B7355]">
            <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-emerald-500" />
            <p className="font-medium text-[#2D1B0E]">Nothing is waiting for a quality check</p>
            <p className="text-xs mt-1 max-w-sm mx-auto">
              Deliveries in a checked category will appear here the moment the store records them, and their stock
              stays out of inventory until someone here signs.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {rows.map(r => (
              <button
                key={r.id}
                onClick={() => openReceipt(r.id)}
                className={`w-full text-left bg-white border rounded-2xl p-3.5 shadow-sm hover:bg-[#FFFCF8] transition-colors ${
                  r.overdue ? 'border-red-300' : 'border-[#E8D5C4]'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-[#2D1B0E]">{r.grn_number}</span>
                      <CheckerChip checker={r.qc_checker} />
                      {r.overdue && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold
                                         bg-red-100 text-red-700 border border-red-200">
                          <Clock className="w-3 h-3" />Overdue
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-[#6B5744] mt-1 truncate flex items-center gap-1.5">
                      <Truck className="w-3.5 h-3.5 text-[#8B7355] shrink-0" />
                      {r.vendor || 'Vendor not named'}
                    </p>
                    <p className="text-[11px] text-[#8B7355] mt-0.5 truncate">
                      {r.date}
                      {r.invoice_number ? ` · Bill ${r.invoice_number}` : ''}
                      {r.po_number ? ` · PO ${r.po_number}` : ''}
                      {r.received_by ? ` · ${r.received_by}` : ''}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-sm font-bold ${r.overdue ? 'text-red-700' : 'text-[#af4408]'}`}>
                      {waitedFor(r.waiting_hours)}
                    </p>
                    <p className="text-[10px] text-[#8B7355]">waiting</p>
                  </div>
                </div>
                <div className="mt-2 pt-2 border-t border-[#E8D5C4]/60 flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-[#6B5744]">
                    {nf(r.line_count)} item{r.line_count === 1 ? '' : 's'} · {inr(Number(r.held_value) || 0)} on the bill
                  </span>
                  <span className={`font-medium ${r.can_sign ? 'text-[#af4408]' : 'text-[#8B7355]'}`}>
                    {r.can_sign ? 'Check now →' : 'View →'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Footnote — the two things somebody will ask next. */}
        {rows.length > 0 && (
          <p className="text-[11px] text-[#8B7355] leading-snug">
            A held receipt still shows on <Link href="/grn" className="underline">Goods Receipt</Link> with its bill
            value; what it does not have is stock. Which categories need a check is set on{' '}
            <Link href="/settings/qc-categories" className="underline">Quality Check Categories</Link> (admin).
          </p>
        )}
      </div>

      <Toast result={result} onClose={() => setResult(null)} />
    </div>
  );
}

/** One toast, bottom-centre, above the sign bar. Errors hold long enough to be
 *  read — a refusal here is a sentence the operator has to act on. */
function Toast({ result, onClose }: { result: { ok: boolean; msg: string; warn?: string } | null; onClose: () => void }) {
  if (!result) return null;
  return (
    <div className="fixed inset-x-0 bottom-24 sm:bottom-6 z-50 flex justify-center px-3 pointer-events-none">
      <div
        className={`pointer-events-auto max-w-lg w-full rounded-xl border px-3.5 py-3 shadow-lg text-sm flex items-start gap-2 ${
          result.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-red-50 border-red-200 text-red-700'
        }`}
      >
        {result.ok ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
        <div className="min-w-0 flex-1">
          <p>{result.msg}</p>
          {result.warn && <p className="mt-1 text-xs text-amber-800">{result.warn}</p>}
        </div>
        <button onClick={onClose} className="shrink-0 opacity-60 hover:opacity-100"><XCircle className="w-4 h-4" /></button>
      </div>
    </div>
  );
}
